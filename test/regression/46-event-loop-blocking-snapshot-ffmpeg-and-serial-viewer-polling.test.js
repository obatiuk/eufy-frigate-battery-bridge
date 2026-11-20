/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 46. Event-Loop-Blocking Snapshot FFmpeg Calls & Serial go2rtc Viewer Polling
 * (docs/regression/46-event-loop-blocking-snapshot-ffmpeg-and-serial-viewer-polling.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

require('../helpers/test-env');
const {waitUntil} = require('../helpers/async');
const {createFakeFfmpegProcess, finishFakeFfmpegProcess} = require('../helpers/media-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {getCacheFilePath, saveCachedFrame} = require('../../src/overlay/snapshot-cache');

describe('Regression 46. Event-Loop-Blocking Snapshot FFmpeg Calls & Serial go2rtc Viewer Polling', () => {
  it('Regression 46: keeps the previous snapshot and removes the temp file when an async save fails', async (t) => {
    // Regression: a failed or killed JPEG encode must never leave a truncated snapshot or a stray temp file.
    const childProcess = require('node:child_process');
    const cam = new Camera({serial: 'T8161T0000009994', name: 'snap_fail_cam'});
    const prevFile = getCacheFilePath(cam, new Date(2026, 10, 19, 9, 55, 0));
    fs.writeFileSync(prevFile, 'previous-good-snapshot');
    cam.recordDecodedFrame(
      Buffer.alloc(FRAME, 0x33),
      Buffer.alloc(FRAME, 0x33),
      new Date(2026, 10, 19, 10, 0, 0).getTime(),
      '10:00'
    );
    const finalFile = getCacheFilePath(cam);
    const spawned = [];
    t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
      const proc = createFakeFfmpegProcess();
      spawned.push({cmd, args, opts, proc});
      return proc;
    });
    try {
      const saving = saveCachedFrame(cam);
      await waitUntil(() => spawned.length > 0);
      const tempFile = spawned[0].args[spawned[0].args.length - 1];
      fs.writeFileSync(tempFile, 'partial');
      finishFakeFfmpegProcess(spawned[0].proc, {status: 1, stderr: Buffer.from('Error muxing a packet\n')});
      await saving;
      assert.equal(fs.readFileSync(prevFile, 'utf8'), 'previous-good-snapshot');
      assert.equal(fs.existsSync(finalFile), false);
      assert.equal(fs.existsSync(tempFile), false);
    } finally {
      fs.rmSync(prevFile, {force: true});
      fs.rmSync(finalFile, {force: true});
    }
  });
});
