/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 9. Truncated `"backfill"` Clips on Battery Doorbells & Multi-Clip Visits
 * (docs/regression/09-truncated-backfill-clips-on-battery-doorbells-multi.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {BackfillJob, BACKFILL_STATES} = require('../../src/domain/backfill-job');
const {Camera} = require('../../src/domain/camera');

describe('Regression 9. Truncated `"backfill"` Clips on Battery Doorbells & Multi-Clip Visits', () => {
  it(
    'Regression 9: waits for all concurrent trigger properties to clear before settling, preserves chronological ' +
      'multi-clip visits, and holds final backfill tail frames for 2500ms',
    () => {
      // Regression: clearing one companion property while motion stayed active started a premature 2s query that
      // downloaded a truncated clip, latest_info dropped earlier split clips, and immediate EOF cut off the tail.
      const job = new BackfillJob({
        name: 'doorbell',
        at: 10000,
        event: 'motion detected',
        reason: 'motion detected',
        priority: 10,
        recordingActive: true,
      });
      job.upgradeEvent({
        event: 'person detected',
        reason: 'person detected',
        priority: 200,
        now: 11000,
        recordingActive: true,
      });
      job.markRecordingCleared(14000, 'person detected');
      assert.equal(job.state, BACKFILL_STATES.RECORDING);

      job.markRecordingCleared(18000, 'motion detected');
      assert.equal(job.state, BACKFILL_STATES.SETTLING);
      assert.equal(job.isReadyToQuery(21999), false);
      assert.equal(job.isReadyToQuery(22000), true);
      job.markReadyToQueryIfSettled(22000);

      const used = new Set();
      assert.equal(
        job.enqueueMatchedCandidate({storagePath: '/zx/second.zxvideo', cipherId: 0, clipMs: 21000}, used),
        true
      );
      assert.equal(
        job.enqueueMatchedCandidate({storagePath: '/zx/first.zxvideo', cipherId: 0, clipMs: 10000}, used),
        true
      );
      assert.equal(job.shiftNextClipForDownload()?.storagePath, '/zx/first.zxvideo');
      assert.equal(job.shiftNextClipForDownload()?.storagePath, '/zx/second.zxvideo');

      const cam = new Camera({serial: 'T8214T0000090001', name: 'tail_hold_cam', mode: 'backfill'});
      const frame = Buffer.alloc(FRAME, 0x44);
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/tail.zxvideo',
          cipherId: 0,
          clipMs: 10000,
          event: 'person detected',
          personName: '',
          reason: 'person',
        },
        false,
        30000
      );
      cam.recordDecodedFrame(frame, frame, 35000, '12:05');
      cam.markDownloadFinished(35000);
      assert.equal(cam.isDownloadComplete(36000), false);
      assert.equal(cam.isDownloadComplete(38000), true);
    }
  );
});
