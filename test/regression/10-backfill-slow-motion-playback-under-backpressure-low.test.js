/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 10. Backfill Slow-Motion Playback Under Backpressure & Low-Battery Poll Drain
 * (docs/regression/10-backfill-slow-motion-playback-under-backpressure-low.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');

describe('Regression 10. Backfill Slow-Motion Playback Under Backpressure & Low-Battery Poll Drain', () => {
  it(
    'Regression 10: drains pending decoder input on pipe drain while stdout is paused, blocks premature ' +
      'download completion, and rebuilds the card on deferred Wi-Fi tier arrival',
    () => {
      // Regression: drainPendingDecoderInput bailed out while decoderStdoutPaused was true, isDownloadComplete ignored
      // pendingVideoPackets/decoderStdoutPaused, and wifiRssi arriving after battery failed to rebuild the card.
      const cam = new Camera({serial: 'T8214T0000100001', name: 'bp_cam', mode: 'backfill'});
      const frame = Buffer.alloc(FRAME, 0x51);
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/bp.zxvideo',
          cipherId: 0,
          clipMs: 10000,
          event: 'person detected',
          personName: '',
          reason: 'person',
        },
        false,
        20000
      );
      cam.recordDecodedFrame(frame, frame, 20500, '12:10');

      const written = [];
      const stdin = {
        writable: true,
        destroyed: false,
        writableNeedDrain: true,
        write(buf) {
          written.push(buf);
          return true;
        },
        once() {},
      };
      cam.attachDecoder({
        stdin,
        stdout: {
          pause() {},
          resume() {},
        },
      });
      cam.enqueueOrWriteVideoPacket(Buffer.from([0, 0, 0, 1, 0x65]));
      cam.enqueueOrWriteVideoPacket(Buffer.from([0, 0, 0, 1, 0x41]));
      assert.equal(cam.hasPendingVideoPackets(), true);

      cam.pauseDecoderStdout();
      cam.markDownloadFinished(25000);
      assert.equal(cam.isDownloadComplete(30000), false);

      stdin.writableNeedDrain = false;
      cam.drainPendingDecoderInput(true, true);
      assert.equal(cam.hasPendingVideoPackets(), false);
      assert.equal(written.length, 2);
      assert.equal(cam.isDownloadComplete(30000), false);

      cam.resumeDecoderStdout();
      assert.equal(cam.isDownloadComplete(30000), true);

      const onlineCam = new Camera({serial: 'T8161T0000100002', name: 'wifi_tier_cam', mode: 'rtsp'});
      onlineCam.applyTelemetryProperties({battery: 80, state: 1}, false, 1000);
      const deferredWifi = onlineCam.applyTelemetryProperties({wifiRssi: -55}, false, 2000);
      assert.equal(deferredWifi.shouldRebuildCard, true);
    }
  );
});
