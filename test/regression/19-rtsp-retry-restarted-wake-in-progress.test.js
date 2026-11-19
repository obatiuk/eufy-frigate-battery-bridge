/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 19. RTSP Wake Retry Restarted a Camera Wake That Was Still in Progress
 * (docs/regression/19-rtsp-retry-restarted-wake-in-progress.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');

describe('Regression 19. RTSP Wake Retry Restarted a Camera Wake That Was Still in Progress', () => {
  it(
    'Regression 19: evaluates RTSP and P2P watchdog health, unsolicited ' +
      'video filtering, and HTTP/HA payload formatting',
    () => {
      // Regression 19: evaluates RTSP and P2P watchdog health, unsolicited video filtering, and HTTP/HA payload
      // formatting.
      const rtspCam = new Camera({
        serial: 'T8161T0000000000',
        title: 'Driveway',
        mode: 'rtsp',
      });
      rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://10.0.0.1/live0');
      const t0 = 200000;
      rtspCam.beginSession('rtsp', t0, false);
      rtspCam.setMotionUntil(t0 + 60000);

      assert.equal(rtspCam.evaluateRtspHealth(t0 + 2000, t0, 1200, 6000, 3500, 3, 15000, 6000).action, 'none');
      assert.equal(
        rtspCam.evaluateRtspHealth(t0 + 4000, t0, 1200, 6000, 3500, 3, 15000, 6000).action,
        'retry',
        'Retries start_rtsp_livestream after retryMs when no video has arrived'
      );

      rtspCam.markRtspFrameReceived(t0 + 4500);
      assert.equal(rtspCam.evaluateRtspHealth(t0 + 6000, t0 + 4500, 1200, 6000, 3500, 3, 15000, 6000).action, 'none');
      assert.equal(
        rtspCam.evaluateRtspHealth(t0 + 8200, t0 + 4500).action,
        'none',
        'Default midStallMs (5000ms) must tolerate a 3.7s Wi-Fi retransmission pause without tearing down RTSP'
      );
      assert.equal(
        rtspCam.evaluateRtspHealth(t0 + 9800, t0 + 4500).action,
        'dropped',
        'Default midStallMs (5000ms) must report dropped once RTSP frames stop for > 5s'
      );
      assert.equal(
        rtspCam.evaluateRtspHealth(t0 + 12000, t0 + 4500, 1200, 6000, 3500, 3, 15000, 6000).action,
        'dropped',
        'Reports dropped if RTSP frames stop for > midStallMs'
      );

      const slowWakeCam = new Camera({
        serial: 'T8161T0000000001',
        title: 'Slow Wake',
        mode: 'rtsp',
      });
      slowWakeCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://10.0.0.1/live1');
      slowWakeCam.beginSession('rtsp', t0, false);
      slowWakeCam.setMotionUntil(t0 + 60000);
      assert.equal(
        slowWakeCam.evaluateRtspHealth(t0 + 8500, t0).action,
        'none',
        'Default RTSP retry interval must outlast an observed 7-8.5s HomeBase RTSP cold wake so ' +
          'a retry does not restart a wake in progress'
      );
      assert.equal(slowWakeCam.evaluateRtspHealth(t0 + 10500, t0).action, 'retry');

      // Unsolicited P2P video filtering when camera recently slept vs past delayMs
      rtspCam.endSession(t0 + 19000);
      assert.equal(
        rtspCam.shouldStopUnsolicitedVideo(t0 + 20000, 3000).shouldStop,
        false,
        'Within 3s post-stop window, ignores trailing packets without sending redundant stop_livestream'
      );
      assert.equal(
        rtspCam.shouldStopUnsolicitedVideo(t0 + 25000, 3000).shouldStop,
        true,
        'Past 3s post-stop window, triggers stop_livestream for unsolicited video'
      );

      // Adopt external P2P wake and verify P2P watchdog health states
      const p2pCam = new Camera({serial: 'T8161T1111111111', title: 'Backyard', mode: 'p2p'});
      assert.equal(p2pCam.adoptExternalP2pWake(t0, 5000), true);
      assert.equal(p2pCam.isSessionActive(), true);
      assert.equal(p2pCam.getActiveMode(), 'p2p');
      assert.equal(p2pCam.getWakeInitiator(), 'eufy-ws');
      assert.equal(p2pCam.evaluateP2pHealth(t0 + 7000, t0, 6000, 8000, 3).action, 'retry');

      // Coalesce HTTP /api/wake bursts and verify API + HA webhook payloads
      p2pCam.scheduleApiWake(
        {durationMs: 20000, reason: 'initial', createEvent: false, delayMs: 2500, now: t0},
        () => {}
      );
      assert.equal(
        p2pCam.coalesceApiWake({durationMs: 30000, reason: 'ha-automation', createEvent: true}, t0 + 1000),
        1500
      );
      p2pCam.clearApiWakeTimer();
      const apiResp = p2pCam.toApiWakeResponse('scheduled', 30000, 1500);
      assert.equal(apiResp.camera, 'T8161T1111111111');
      assert.equal(apiResp.status, 'scheduled');
      assert.equal(apiResp.hold_secs, 30);

      p2pCam.setFrigateEventLabel('person');
      p2pCam.setFrigateEventPerson('Alice');
      const haPayload = p2pCam.toHaWebhookPayload({event_id: 'evt-123'});
      assert.equal(haPayload.camera, 'T8161T1111111111');
      assert.equal(haPayload.person, 'Alice');
      assert.equal(haPayload.event_id, 'evt-123');
    }
  );
});
