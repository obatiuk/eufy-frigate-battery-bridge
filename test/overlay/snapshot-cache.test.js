/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for persistent JPEG <-> YUV420p snapshot cache paths, legacy deduplication, and non-blocking async
 * FFmpeg load/save operations (src/overlay/snapshot-cache.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../helpers/test-env');
const {waitUntil} = require('../helpers/async');
const {createFakeFfmpegProcess, finishFakeFfmpegProcess} = require('../helpers/media-mocks');
const {CACHE_DIR, FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {
  getCacheFilePath,
  migrateLegacyDuplicateCacheFile,
  buildDecodeJpegArgs,
  buildEncodeJpegArgs,
  loadCachedFrame,
  saveCachedFrame,
  waitForPendingSnapshotSaves,
} = require('../../src/overlay/snapshot-cache');

afterEach(() => {
  mock.timers.reset();
});

describe('Snapshot Cache Event-Loop Safety (src/overlay/snapshot-cache.js)', () => {
  it('builds deterministic JPEG snapshot cache paths and FFmpeg decode/encode CLI arguments', () => {
    // Verify cache paths keep last_<name>_<serial>.jpg when name !== serial, collapse to last_<name>.jpg when
    // serial === name, and migrate legacy last_<name>_<name>.jpg files in place
    const cam = new Camera({serial: 'T8161T0000000000', name: 'front_yard'});
    const cachePath = getCacheFilePath(cam);
    assert.equal(cachePath, path.join(CACHE_DIR, 'last_front_yard_T8161T0000000000.jpg'));

    const serialOnlyCam = new Camera({serial: 'T8161T0000000000'});
    assert.equal(getCacheFilePath(serialOnlyCam), path.join(CACHE_DIR, 'last_T8161T0000000000.jpg'));

    const directCam = new Camera({name: 'nursery_cam', rtsp_url: 'rtsp://192.0.2.10/live0'});
    assert.equal(getCacheFilePath(directCam), path.join(CACHE_DIR, 'last_nursery_cam.jpg'));

    const migDir = fs.mkdtempSync(path.join(CACHE_DIR, 'mig-'));
    try {
      const legacyDup = path.join(migDir, 'last_nursery_cam_nursery_cam.jpg');
      const dedupTarget = path.join(migDir, 'last_nursery_cam.jpg');
      fs.writeFileSync(legacyDup, 'jpeg-bytes-1');
      migrateLegacyDuplicateCacheFile(directCam, migDir);
      assert.equal(fs.existsSync(legacyDup), false);
      assert.equal(fs.readFileSync(dedupTarget, 'utf8'), 'jpeg-bytes-1');

      // When the deduplicated file already exists, any leftover duplicate file is removed cleanly
      fs.writeFileSync(dedupTarget, 'jpeg-bytes-fresh');
      fs.writeFileSync(legacyDup, 'jpeg-bytes-stale');
      migrateLegacyDuplicateCacheFile(directCam, migDir);
      assert.equal(fs.existsSync(legacyDup), false);
      assert.equal(fs.readFileSync(dedupTarget, 'utf8'), 'jpeg-bytes-fresh');
    } finally {
      fs.rmSync(migDir, {recursive: true, force: true});
    }

    const decArgs = buildDecodeJpegArgs(cachePath);
    assert.ok(decArgs.includes(cachePath));
    assert.ok(decArgs.includes('rawvideo'));

    const encArgs = buildEncodeJpegArgs(cachePath);
    assert.ok(encArgs.includes('-q:v'));
    assert.ok(encArgs.includes(cachePath));
  });

  it('decodes cached snapshots with an async timeboxed FFmpeg spawn that never blocks the event loop', async (t) => {
    // Verify: startup snapshot decoding must not use spawnSync (it stalls /healthz and every other camera), must be
    // killed when FFmpeg hangs, and must leave the event loop free while FFmpeg runs.
    const childProcess = require('node:child_process');
    const cam = new Camera({serial: 'T8161T0000009992', name: 'snap_async_cam'});
    const snapFile = getCacheFilePath(cam);
    fs.writeFileSync(snapFile, Buffer.from('jpeg-bytes'));
    const spawned = [];
    let spawnSyncCalls = 0;
    t.mock.method(childProcess, 'spawnSync', () => {
      spawnSyncCalls += 1;
      throw new Error('spawnSync must not be used for snapshot cache FFmpeg calls');
    });
    t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
      const proc = createFakeFfmpegProcess();
      spawned.push({cmd, args, opts, proc});
      return proc;
    });
    try {
      const pending = loadCachedFrame(cam);
      assert.ok(pending instanceof Promise, 'loadCachedFrame must be asynchronous');
      await waitUntil(() => spawned.length > 0);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].cmd, 'ffmpeg');
      assert.equal(spawned[0].opts.killSignal, 'SIGKILL');
      assert.ok(spawned[0].opts.timeout > 0, 'a hung FFmpeg decode must be killed after a timeout');

      let loopTicked = false;
      setImmediate(() => {
        loopTicked = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(loopTicked, true, 'event loop must keep running while FFmpeg decodes');

      spawned[0].proc.stdout.emit('data', Buffer.alloc(FRAME - 10, 0x44));
      finishFakeFfmpegProcess(spawned[0].proc, {status: 0, stdout: Buffer.alloc(10, 0x44)});
      const loaded = await pending;
      assert.equal(loaded.frame.length, FRAME);
      assert.match(loaded.lastSeen, /^\d\d:\d\d$/);
      assert.equal(spawnSyncCalls, 0);
    } finally {
      fs.rmSync(snapFile, {force: true});
    }
  });

  it('saves cached snapshots atomically from a stable copy of the last frame without spawnSync', async (t) => {
    // Verify: stop() must not block on a synchronous JPEG encode; the previous snapshot must stay intact until the new
    // JPEG is complete, the encoded bytes must not change if the live buffers are recycled meanwhile, and a hung
    // FFmpeg must be killed after a timeout.
    const childProcess = require('node:child_process');
    const cam = new Camera({serial: 'T8161T0000009993', name: 'snap_save_cam'});
    cam.recordDecodedFrame(Buffer.alloc(FRAME, 0x33), Buffer.alloc(FRAME, 0x33), 20000, '10:00');
    const finalFile = getCacheFilePath(cam);
    fs.writeFileSync(finalFile, 'previous-good-snapshot');
    const spawned = [];
    t.mock.method(childProcess, 'spawnSync', () => {
      throw new Error('spawnSync must not be used for snapshot cache FFmpeg calls');
    });
    t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
      const proc = createFakeFfmpegProcess();
      spawned.push({cmd, args, opts, proc});
      return proc;
    });
    try {
      const saving = saveCachedFrame(cam);
      assert.ok(saving instanceof Promise, 'saveCachedFrame must be asynchronous');
      cam.getLastFrameBuffer().fill(0x77);
      await waitUntil(() => spawned.length > 0);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].opts.killSignal, 'SIGKILL');
      assert.ok(spawned[0].opts.timeout > 0, 'a hung FFmpeg encode must be killed after a timeout');

      const tempFile = spawned[0].args[spawned[0].args.length - 1];
      assert.notEqual(tempFile, finalFile, 'FFmpeg must write to a temp file, never straight to the snapshot');
      assert.equal(path.dirname(tempFile), path.dirname(finalFile));
      assert.ok(tempFile.endsWith('.jpg'), 'temp file keeps the .jpg extension so FFmpeg picks the JPEG muxer');
      const written = spawned[0].proc.stdinChunks[0];
      assert.equal(written.length, FRAME);
      assert.equal(written[0], 0x33, 'encoded bytes must come from a copy taken when the save started');
      assert.equal(written[FRAME - 1], 0x33);
      assert.equal(fs.readFileSync(finalFile, 'utf8'), 'previous-good-snapshot');

      fs.writeFileSync(tempFile, 'new-jpeg');
      finishFakeFfmpegProcess(spawned[0].proc, {status: 0});
      await saving;
      assert.equal(fs.readFileSync(finalFile, 'utf8'), 'new-jpeg');
      assert.equal(fs.existsSync(tempFile), false);
    } finally {
      fs.rmSync(finalFile, {force: true});
    }
  });

  it('skips a new save for a camera while its previous save is still running', async (t) => {
    // Verify: repeated session stops must not pile up concurrent FFmpeg encodes writing the same snapshot.
    const childProcess = require('node:child_process');
    const cam = new Camera({serial: 'T8161T0000009995', name: 'snap_dedupe_cam'});
    cam.recordDecodedFrame(Buffer.alloc(FRAME, 0x33), Buffer.alloc(FRAME, 0x33), 20000, '10:00');
    const finalFile = getCacheFilePath(cam);
    const spawned = [];
    t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
      const proc = createFakeFfmpegProcess();
      spawned.push({cmd, args, opts, proc});
      return proc;
    });
    try {
      const first = saveCachedFrame(cam);
      const second = saveCachedFrame(cam);
      await waitUntil(() => spawned.length > 0);
      assert.equal(spawned.length, 1, 'a second save while one is running must not spawn another FFmpeg');
      finishFakeFfmpegProcess(spawned[0].proc, {status: 1});
      await Promise.all([first, second]);

      const third = saveCachedFrame(cam);
      await waitUntil(() => spawned.length > 1);
      assert.equal(spawned.length, 2, 'a save after the previous one finished must run again');
      finishFakeFfmpegProcess(spawned[1].proc, {status: 1});
      await third;
    } finally {
      fs.rmSync(finalFile, {force: true});
    }
  });

  it('waits for all in-flight snapshot saves via waitForPendingSnapshotSaves', async (t) => {
    // Verify: shutdown can await waitForPendingSnapshotSaves so un-awaited stop() snapshot encodes finish writing.
    const childProcess = require('node:child_process');
    const cam = new Camera({serial: 'T8161T0000009996', name: 'snap_drain_cam'});
    cam.recordDecodedFrame(Buffer.alloc(FRAME, 0x55), Buffer.alloc(FRAME, 0x55), 25000, '10:05');
    const finalFile = getCacheFilePath(cam);
    const spawned = [];
    t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
      const proc = createFakeFfmpegProcess();
      spawned.push({cmd, args, opts, proc});
      return proc;
    });
    try {
      void saveCachedFrame(cam);
      await waitUntil(() => spawned.length > 0);
      let drained = false;
      const draining = waitForPendingSnapshotSaves().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(drained, false, 'waitForPendingSnapshotSaves must stay pending while FFmpeg encode runs');

      const tempFile = spawned[0].args[spawned[0].args.length - 1];
      fs.writeFileSync(tempFile, 'shutdown-final-jpeg');
      finishFakeFfmpegProcess(spawned[0].proc, {status: 0});
      await draining;
      assert.equal(drained, true);
      assert.equal(fs.readFileSync(finalFile, 'utf8'), 'shutdown-final-jpeg');
    } finally {
      fs.rmSync(finalFile, {force: true});
    }
  });
});
