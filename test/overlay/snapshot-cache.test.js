/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for persistent timestamped JPEG <-> YUV420p snapshot cache paths, legacy migration, startup log
 * formatting, and non-blocking async FFmpeg load/save operations (src/overlay/snapshot-cache.js, src/app.js).
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
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {
  getCacheFilePath,
  migrateLegacyCacheFile,
  formatLoadedSnapshotLog,
  buildDecodeJpegArgs,
  buildEncodeJpegArgs,
  loadCachedFrame,
  saveCachedFrame,
  waitForPendingSnapshotSaves,
} = require('../../src/overlay/snapshot-cache');
const {logStartupSnapshots} = require('../../src/app');

afterEach(() => {
  mock.timers.reset();
});

describe('Snapshot Cache Event-Loop Safety & Timestamped Naming (src/overlay/snapshot-cache.js)', () => {
  it('builds timestamped snapshot paths, migrates legacy files, and builds FFmpeg CLI args', async () => {
    // Verify cache paths format <name>[_<serial>]_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg and migrate legacy last_*.jpg
    // files using their filesystem modification timestamp.
    const snapAt = new Date(2026, 10, 19, 18, 16, 4);
    const cam = new Camera({serial: 'T8161T0000000000', name: 'front_yard'});
    const cachePath = getCacheFilePath(cam, snapAt);
    assert.equal(cachePath, path.join(CACHE_DIR, 'front_yard_T8161T0000000000_snapshot_2026-11-19_18-16-04.jpg'));

    const serialOnlyCam = new Camera({serial: 'T8161T0000000000'});
    assert.equal(
      getCacheFilePath(serialOnlyCam, snapAt),
      path.join(CACHE_DIR, 'T8161T0000000000_snapshot_2026-11-19_18-16-04.jpg')
    );

    const directCam = new Camera({name: 'nursery_cam', rtsp_url: 'rtsp://192.0.2.10/live0'});
    assert.equal(
      getCacheFilePath(directCam, snapAt),
      path.join(CACHE_DIR, 'nursery_cam_snapshot_2026-11-19_18-16-04.jpg')
    );

    const migDir = fs.mkdtempSync(path.join(CACHE_DIR, 'mig-'));
    try {
      const legacyNamed = path.join(migDir, 'last_front_yard_T8161T0000000000.jpg');
      fs.writeFileSync(legacyNamed, 'jpeg-named');
      fs.utimesSync(legacyNamed, snapAt, snapAt);
      await migrateLegacyCacheFile(cam, migDir);
      const migratedNamed = path.join(migDir, 'front_yard_T8161T0000000000_snapshot_2026-11-19_18-16-04.jpg');
      assert.equal(fs.existsSync(legacyNamed), false);
      assert.equal(fs.readFileSync(migratedNamed, 'utf8'), 'jpeg-named');

      const legacyDup = path.join(migDir, 'last_nursery_cam_nursery_cam.jpg');
      fs.writeFileSync(legacyDup, 'jpeg-bytes-1');
      fs.utimesSync(legacyDup, snapAt, snapAt);
      await migrateLegacyCacheFile(directCam, migDir);
      const migratedDirect = path.join(migDir, 'nursery_cam_snapshot_2026-11-19_18-16-04.jpg');
      assert.equal(fs.existsSync(legacyDup), false);
      assert.equal(fs.readFileSync(migratedDirect, 'utf8'), 'jpeg-bytes-1');

      // When a timestamped snapshot already exists, any leftover legacy last_*.jpg files are removed cleanly.
      const legacySingle = path.join(migDir, 'last_nursery_cam.jpg');
      fs.writeFileSync(migratedDirect, 'jpeg-bytes-fresh');
      fs.writeFileSync(legacySingle, 'jpeg-bytes-stale');
      fs.writeFileSync(legacyDup, 'jpeg-bytes-stale-dup');
      await migrateLegacyCacheFile(directCam, migDir);
      assert.equal(fs.existsSync(legacySingle), false);
      assert.equal(fs.existsSync(legacyDup), false);
      assert.equal(fs.readFileSync(migratedDirect, 'utf8'), 'jpeg-bytes-fresh');
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

  it('decodes the newest snapshot asynchronously, removes older ones, and logs INFO on boot', async (t) => {
    // Verify: loadCachedFrame discovers timestamped files without knowing the timestamp ahead of time, picks the
    // newest valid snapshot, removes superseded older snapshots, never calls spawnSync, and formats user-friendly
    // startup INFO logs with capture time and relative age.
    const childProcess = require('node:child_process');
    const olderAt = new Date(2026, 10, 19, 16, 10, 0);
    const newerAt = new Date(2026, 10, 19, 18, 16, 4);
    const bootNow = new Date(2026, 10, 19, 20, 51, 9).getTime();
    const camCfg = {serial: 'T8161T0000009992', name: 'snap_async_cam'};
    const olderFile = getCacheFilePath(camCfg, olderAt);
    const newerFile = getCacheFilePath(camCfg, newerAt);
    fs.writeFileSync(olderFile, Buffer.from('older-jpeg'));
    fs.writeFileSync(newerFile, Buffer.from('newer-jpeg'));

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
      const pending = loadCachedFrame(camCfg);
      assert.ok(pending instanceof Promise, 'loadCachedFrame must be asynchronous');
      await waitUntil(() => spawned.length > 0);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].cmd, 'ffmpeg');
      assert.ok(spawned[0].args.includes(newerFile), 'newest timestamped snapshot must be decoded first');
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
      assert.equal(loaded.lastSeen, '18:16');
      assert.equal(loaded.fileName, 'snap_async_cam_T8161T0000009992_snapshot_2026-11-19_18-16-04.jpg');
      assert.equal(loaded.takenAtMs, newerAt.getTime());
      assert.equal(fs.existsSync(olderFile), false, 'superseded older snapshot must be removed once newest decodes');
      assert.equal(fs.existsSync(newerFile), true);
      assert.equal(spawnSyncCalls, 0);

      assert.equal(
        formatLoadedSnapshotLog(loaded, bootNow),
        'loaded snapshot snap_async_cam_T8161T0000009992_snapshot_2026-11-19_18-16-04.jpg ' +
          '(taken 2026-11-19 18:16:04, 2h 35m ago)'
      );
      assert.equal(formatLoadedSnapshotLog({frame: null, lastSeen: ''}, bootNow), '');

      const constructedCam = new Camera(camCfg, loaded);
      const missingCam = new Camera({serial: 'T8161T0000009999', name: 'empty_cam'}, {frame: null, lastSeen: ''});
      const infoLines = [];
      const origInfo = log.info;
      log.info = (scope, ...args) => {
        const resolved = scope && typeof scope.getLogScope === 'function' ? scope.getLogScope() : {name: String(scope)};
        infoLines.push('[' + resolved.name + '] [' + (resolved.state || '').toUpperCase() + '] ' + args.join(' '));
      };
      try {
        logStartupSnapshots([constructedCam, missingCam], [loaded, {frame: null, lastSeen: ''}], bootNow);
      } finally {
        log.info = origInfo;
      }
      assert.deepEqual(infoLines, [
        '[snap_async_cam] [IDLE] loaded snapshot snap_async_cam_T8161T0000009992_snapshot_2026-11-19_18-16-04.jpg ' +
          '(taken 2026-11-19 18:16:04, 2h 35m ago)',
      ]);
    } finally {
      fs.rmSync(olderFile, {force: true});
      fs.rmSync(newerFile, {force: true});
    }
  });

  it('saves cached snapshots atomically to a timestamped file and removes the previous snapshot', async (t) => {
    // Verify: stop() must not block on a synchronous JPEG encode; the previous snapshot must stay intact until the new
    // timestamped JPEG is renamed into place, and once renamed the previous snapshot file is removed cleanly.
    const childProcess = require('node:child_process');
    const prevAt = new Date(2026, 10, 19, 9, 55, 0);
    const nextAt = new Date(2026, 10, 19, 10, 0, 0);
    const cam = new Camera({serial: 'T8161T0000009993', name: 'snap_save_cam'});
    const prevFile = getCacheFilePath(cam, prevAt);
    fs.writeFileSync(prevFile, 'previous-good-snapshot');
    cam.recordDecodedFrame(Buffer.alloc(FRAME, 0x33), Buffer.alloc(FRAME, 0x33), nextAt.getTime(), '10:00');
    const finalFile = getCacheFilePath(cam);
    assert.notEqual(finalFile, prevFile);

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
      assert.equal(fs.readFileSync(prevFile, 'utf8'), 'previous-good-snapshot');

      fs.writeFileSync(tempFile, 'new-jpeg');
      finishFakeFfmpegProcess(spawned[0].proc, {status: 0});
      await saving;
      assert.equal(fs.readFileSync(finalFile, 'utf8'), 'new-jpeg');
      assert.equal(fs.existsSync(prevFile), false, 'previous timestamped snapshot must be deleted after rename');
      assert.equal(fs.existsSync(tempFile), false);
    } finally {
      fs.rmSync(prevFile, {force: true});
      fs.rmSync(finalFile, {force: true});
    }
  });

  it('skips a new save for a camera while its previous save is still running even if frameAt changed', async (t) => {
    // Verify: repeated session stops must not pile up concurrent FFmpeg encodes for the same camera even when the
    // timestamped target filename advances between saves.
    const childProcess = require('node:child_process');
    const t1 = new Date(2026, 10, 19, 10, 0, 0).getTime();
    const t2 = new Date(2026, 10, 19, 10, 0, 5).getTime();
    const cam = new Camera({serial: 'T8161T0000009995', name: 'snap_dedupe_cam'});
    cam.recordDecodedFrame(Buffer.alloc(FRAME, 0x33), Buffer.alloc(FRAME, 0x33), t1, '10:00');
    const file1 = getCacheFilePath(cam, t1);
    const file2 = getCacheFilePath(cam, t2);
    const spawned = [];
    t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
      const proc = createFakeFfmpegProcess();
      spawned.push({cmd, args, opts, proc});
      return proc;
    });
    try {
      const first = saveCachedFrame(cam);
      cam.recordDecodedFrame(Buffer.alloc(FRAME, 0x44), Buffer.alloc(FRAME, 0x44), t2, '10:00');
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
      fs.rmSync(file1, {force: true});
      fs.rmSync(file2, {force: true});
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
