/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 6. HomeBase 3 RTSP Wake Sequence, P2P Extension Loops & Burst Download Pacing
 * (docs/regression/06-homebase-3-rtsp-wake-sequence-p2p-extension.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub, createOfflineRecoveryHarness} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks} = require('../../src/services/eufy-client');
const {stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 6. HomeBase 3 RTSP Wake Sequence, P2P Extension Loops & Burst Download Pacing', () => {
  it(
    'Regression 6: skips stop_rtsp_livestream on RTSP sleep, ends early-sleep P2P streams 5s after clear, ' +
      'and paces burst download frames at 15 fps',
    async () => {
      // Regression: calling device.stop_rtsp_livestream disabled the HomeBase NAS toggle, P2P event streams stayed
      // open until hard limits, and HomeBase 3 burst .zxvideo frames at ~10x real-time speed.
      const {onlineCam1, sentCommands} = await createOfflineRecoveryHarness();
      onlineCam1.beginSession('rtsp', 10000, true);
      sentCommands.length = 0;
      stop(onlineCam1, 'hold expired', false, 'bridge-timer');
      await flushAsync();
      assert.equal(sentCommands.includes('device.stop_rtsp_livestream'), false);
      configureEufyClientHooks({onDeviceOnlineResume: () => {}});

      const p2pCam = new Camera({
        serial: 'T8214T0000060001',
        name: 'early_p2p',
        mode: 'custom',
        use_rtsp: false,
        end_early: true,
        idle_timeout_secs: 10,
        hold_secs: 60,
      });
      const frame = Buffer.alloc(FRAME, 0x33);
      p2pCam.applyMotionTrigger(10000, 'motion detected', 60000, 'eufy/motion', 10);
      p2pCam.beginSession('p2p', 10000, false);
      p2pCam.markP2pVideoPacketReceived(10500);
      p2pCam.recordDecodedFrame(frame, frame, 11000, '12:00');
      p2pCam.applyMotionTrigger(15000, 'motion detected', 60000, 'eufy/motion', 10);
      assert.equal(p2pCam.wantUntil(), 75000);
      assert.equal(p2pCam.recordMotionCleared(16000, 5000, 10000, 'motion detected'), 5);
      assert.equal(p2pCam.wantUntil(), 21000);

      const bfCam = new Camera({serial: 'T8214T0000060002', name: 'pace_dl', mode: 'backfill'});
      bfCam.beginBackfillDownload(
        {
          storagePath: '/zx/pace.zxvideo',
          cipherId: 0,
          clipMs: 5000,
          event: 'person detected',
          personName: '',
          reason: 'person',
        },
        false,
        20000
      );
      bfCam.recordDecodedFrame(frame, frame, 20000, '12:00');
      bfCam.bufferDownloadFrame(frame, 1800);
      bfCam.markFrameEncoded(frame, 20000);
      assert.equal(bfCam.canAdvanceDownloadFrame(20020, 66), false);
      assert.equal(bfCam.canAdvanceDownloadFrame(20070, 66), true);
    }
  );
});
