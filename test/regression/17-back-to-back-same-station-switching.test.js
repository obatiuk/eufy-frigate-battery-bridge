/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 17. Back-to-Back Same-Station P2P Switching Lost ~2.5s Recording Window
 * (docs/regression/17-back-to-back-same-station-switching.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub, createOfflineRecoveryHarness} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks} = require('../../src/services/eufy-client');
const {initOrchestrator, wakeCameraExternal, stop, trigger} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 17. Back-to-Back Same-Station P2P Switching Lost ~2.5s Recording Window', () => {
  it(
    'Regression 17: Back-to-back same-station P2P switching: after camera A stops, waiting camera B starts ' +
      'immediately without 2500ms pacing delay',
    async () => {
      // Regression: back-to-back switching skips pacing only right after a P2P/download slot
      // stops, never leaking across RTSP wakes or preemptions
      await createOfflineRecoveryHarness();
      const {WakeRequest} = require('../../src/domain/camera');
      const camA = new Camera({
        serial: 'T8161T7000000001',
        name: 'gate_camera',
        mode: 'p2p',
        priority: 10,
        station_serial: 'T8030P3333333333',
      });
      const camB = new Camera({
        serial: 'T8161T7000000002',
        name: 'driveway_camera',
        mode: 'p2p',
        priority: 100,
        station_serial: 'T8030P3333333333',
      });
      const camC = new Camera({
        serial: 'T8161T7000000003',
        name: 'yard_camera',
        mode: 'p2p',
        priority: 5,
        station_serial: 'T8030P3333333333',
      });
      const rtspCam = new Camera({
        serial: 'T8161T7000000004',
        name: 'porch_rtsp',
        mode: 'rtsp',
        station_serial: 'T8030P3333333333',
      });
      rtspCam.updateDiscoveredRtspConfig('T8030P3333333333', 'rtsp://127.0.0.1:1/live0');
      initOrchestrator(
        [camA, camB, camC, rtspCam],
        new Map([
          [camA.getSerial(), camA],
          [camB.getSerial(), camB],
          [camC.getSerial(), camC],
          [rtspCam.getSerial(), rtspCam],
        ]),
        () => false
      );
      const reqA = WakeRequest.motion('gate motion', 30000).withInitiator('api-wake').withCreateEvent(true).build();
      const reqB = WakeRequest.motion('driveway motion', 30000).withInitiator('api-wake').withCreateEvent(true).build();
      const reqC = WakeRequest.motion('yard motion', 30000).withInitiator('api-wake').withCreateEvent(true).build();
      try {
        // 1. Start camera A's session (this sets stationNextWakeAt with pacing)
        const resA = wakeCameraExternal(camA, reqA);
        assert.equal(resA.status, 'waking', 'First camera on station should start immediately');
        assert.equal(resA.delay_ms, 0);
        assert.equal(camA.isSessionActive(), true);

        // 2. Stop camera A (releases the station P2P slot)
        stop(camA, 'test stop', false, 'bridge-test');
        camA.clearP2pStopInFlight();

        // 3. Trigger camera B immediately after camera A stops
        // With the fix, camera B should start immediately (delay_ms = 0) because the slot was just released
        const resB = wakeCameraExternal(camB, reqB);
        assert.equal(
          resB.status,
          'waking',
          'Camera B should start immediately after camera A stops (back-to-back same-station switching)'
        );
        assert.equal(resB.delay_ms, 0, 'Back-to-back same-station wake after slot release must have zero pacing delay');
        assert.equal(camB.isSessionActive(), true, 'Camera B session should be active');

        // 4. Stale release check: stop camera B while idle (no waiting camera), then wake RTSP camera on same station;
        //    a subsequent /api/wake on camera C must still be paced behind the fresh RTSP start command.
        stop(camB, 'idle stop', false, 'bridge-test');
        camB.clearP2pStopInFlight();
        trigger(rtspCam, 'porch motion', 30000, 'motion', 'eufy-event', 100);
        assert.equal(rtspCam.isActiveRtspSession(), true);
        const resAfterRtsp = wakeCameraExternal(camC, reqC);
        assert.equal(
          resAfterRtsp.status,
          'scheduled',
          'Previous P2P stop must not leak past a newer RTSP wake on the same station'
        );
        assert.ok(resAfterRtsp.delay_ms > 0);
        camC.clearApiWakeTimer();
        stop(rtspCam, 'rtsp stop', false, 'bridge-test');

        // 5. Preemption check: camera A has been streaming past its initial pacing window, then
        //    higher-priority camera B preempts A; an immediate /api/wake on camera C must be paced
        //    behind B's fresh start command.
        initOrchestrator(
          [camA, camB, camC, rtspCam],
          new Map([
            [camA.getSerial(), camA],
            [camB.getSerial(), camB],
            [camC.getSerial(), camC],
            [rtspCam.getSerial(), rtspCam],
          ]),
          () => false
        );
        camA.beginSession('p2p', Date.now() - 10000, true);
        camA.setMotionUntil(Date.now() + 20000);
        trigger(camB, 'driveway person', 30000, 'motion', 'eufy-event', 200);
        assert.equal(camB.isSessionActive(), true, 'Higher-priority camera B should preempt camera A');
        const resAfterPreempt = wakeCameraExternal(camC, reqC);
        assert.equal(
          resAfterPreempt.status,
          'scheduled',
          'Preempting P2P start must still pace a subsequent /api/wake on the same station'
        );
        assert.ok(resAfterPreempt.delay_ms > 0);
      } finally {
        camC.clearApiWakeTimer();
        for (const c of [camA, camB, camC, rtspCam]) {
          if (c.getFrigateEventTimer()) {
            clearTimeout(c.getFrigateEventTimer());
            c.setFrigateEventTimer(null);
          }
        }
        stop(camA, 'cleanup', false, 'bridge-test');
        stop(camB, 'cleanup', false, 'bridge-test');
        stop(camC, 'cleanup', false, 'bridge-test');
        stop(rtspCam, 'cleanup', false, 'bridge-test');
      }
      configureEufyClientHooks({onDeviceOnlineResume: () => {}});
    }
  );
});
