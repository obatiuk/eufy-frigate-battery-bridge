/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 37. Backfill Decoded Frame-0 Completion Gate & Stalled Probe Timeout
 * (docs/regression/37-backfill-decoded-frame-0-completion-gate.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');

describe('Regression 37. Backfill Decoded Frame-0 Completion Gate & Stalled Probe Timeout', () => {
  it(
    'Regression 37: requires decoded Frame 0 before treating backfill ' +
      'downloads as complete or suppressing timeout',
    () => {
      // Regression: markP2pVideoPacketReceived set gotVideo=true on the first raw compressed packet before FFmpeg's
      // 32 KB probe decoded Frame 0, causing truncated/stalled transfers to bypass hasDownloadTimedOut and finish
      // via isDownloadComplete after 3s without retrying.
      const cam = new Camera({serial: 'T8214T0000000098', name: 'doorbell_probe', mode: 'backfill'});
      const t0 = 500000;
      cam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
      cam.recordMotionCleared(t0 + 4000, 4000, 10000, 'person detected');
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000098',
          storagePath: '/zx/truncated.zxvideo',
          cipherId: 9,
          clipMs: t0 + 500,
        }),
        true
      );

      cam.beginBackfillDownload(cam.getBackfillClip(), false, t0 + 10000);
      cam.markP2pVideoPacketReceived(t0 + 10250);
      assert.equal(cam.hasGotVideo(), true);
      assert.equal(cam.hasDecodedFrame(), false);
      assert.equal(
        cam.isDownloadComplete(t0 + 14000, 3000, 2500, 0),
        false,
        'Must not treat raw-packet-only download as complete after 3s idleCompleteMs without Frame 0'
      );
      assert.equal(cam.hasDownloadTimedOut(t0 + 25250, 15000), false);
      assert.equal(
        cam.hasDownloadTimedOut(t0 + 25251, 15000),
        true,
        'Stalled download that never decoded Frame 0 must time out past timeoutMs after last packet'
      );

      // Even if downloadFinished arrives on a corrupt 0-frame clip, completion stays false and termination re-queues it
      cam.markDownloadFinished(t0 + 25251);
      assert.equal(cam.isDownloadComplete(t0 + 30000, 3000, 2500, 0), false);
      const term = cam.terminateSession(
        t0 + 30000,
        'post-event clip download timed out',
        false,
        'eufy/download-finished'
      );
      assert.equal(term.shouldPersistSnapshot, false, 'Must not persist snapshot on a 0-decoded-frame download');
      assert.ok(term.sleepMsg.includes('gotVideo=false'), 'SLEEP log must report gotVideo=false when 0 frames decoded');
      assert.equal(cam.hasGotVideo(), false, 'Failed 0-frame download must clear gotVideo on session end');
      assert.equal(cam.hasDownloadedClipPath('/zx/truncated.zxvideo'), false);
      assert.equal(cam.getBackfillClip()?.storagePath, '/zx/truncated.zxvideo');
      assert.equal(cam.isReadyForBackfillDownload(t0 + 32000), false);
      assert.equal(cam.isReadyForBackfillDownload(t0 + 34001), true);

      // Retry succeeds once Frame 0 decodes via recordDecodedFrame
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t0 + 34500);
      const frame0 = Buffer.alloc(FRAME, 0x66);
      cam.recordDecodedFrame(frame0, frame0, t0 + 34700, '12:05');
      assert.equal(cam.hasDecodedFrame(), true);
      assert.equal(cam.hasGotVideo(), true);
      cam.setFrameNew(false);
      cam.markDownloadFinished(t0 + 35000);
      assert.equal(cam.isDownloadComplete(t0 + 38000, 3000, 2500, 0), true);
      const okTerm = cam.terminateSession(
        t0 + 38000,
        'post-event clip download stream completed',
        false,
        'eufy/download-finished'
      );
      assert.ok(okTerm.sleepMsg.includes('gotVideo=true'));
      assert.equal(cam.hasDownloadedClipPath('/zx/truncated.zxvideo'), true);
      assert.equal(cam.getBackfillClip(), null);
    }
  );
});
