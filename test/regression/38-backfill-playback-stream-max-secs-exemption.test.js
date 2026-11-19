/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 38. Backfill Clip Playback Exempt from `stream_max_secs` Live Duration Cap
 * (docs/regression/38-backfill-playback-stream-max-secs-exemption.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');

describe('Regression 38. Backfill Clip Playback Exempt from `stream_max_secs` Live Duration Cap', () => {
  it('Regression 38: exempts STREAM_MODES.DOWNLOAD clip playback from stream_max_secs duration caps', () => {
    // Regression: hasReachedMaxDuration checked this.active instead of this.isActiveLiveSession(), causing
    // stream_max_secs < 120 to cut off 90s-120s HomeBase clips mid-playback with bridge-max-limit.
    const cam = new Camera({
      serial: 'T8214T0000000099',
      name: 'doorbell_max_secs',
      mode: 'backfill',
      hold_secs: 30,
      stream_max_secs: 60,
    });
    const t0 = 800000;
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/long_clip_120s.zxvideo',
        cipherId: 10,
        clipMs: t0 - 120000,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      },
      false,
      t0
    );
    const frame0 = Buffer.alloc(FRAME, 0x77);
    cam.recordDecodedFrame(frame0, frame0, t0 + 300, '12:10');
    assert.equal(cam.hasReachedMaxDuration(t0 + 60000), false);
    assert.equal(cam.hasReachedMaxDuration(t0 + 119000), false);
    assert.equal(cam.expireMaxDurationHold(t0 + 119000), '');
    cam.endSession(t0 + 122000, true, false, 'download');

    // Live P2P/RTSP sessions on the same camera remain hard-capped at stream_max_secs (60s)
    cam.beginSession('p2p', t0 + 130000, true);
    assert.equal(cam.hasReachedMaxDuration(t0 + 189999), false);
    assert.equal(cam.hasReachedMaxDuration(t0 + 190000), true);
    assert.equal(cam.expireMaxDurationHold(t0 + 190000), 'reached max_secs limit (1m)');
  });
});
