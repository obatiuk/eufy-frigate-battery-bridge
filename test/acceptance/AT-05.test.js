/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-05`: `"rtsp"`, `"p2p"`, and `"auto"` Modes - Motion Wakes, Direct `rtsp_url`
 * Probes & Stream Adoption (docs/acceptance/AT-05.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-05.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {selectEncoderFrame} = require('../../src/media/encoder');
const {onEvent, stop, initOrchestrator} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-05 (docs/acceptance/AT-05.md)', () => {
  it(
    'AT-05: "rtsp", "p2p", and "auto" modes wake on configured trigger events and adopt external ' +
      '"rtsp livestream started" (as RTSP) and "livestream started" (as P2P) while IDLE outside the 3s ' +
      'post-sleep guard',
    async () => {
      const storageRtsp = new Camera({
        serial: 'T8161T0000000005',
        name: 'storage',
        mode: 'rtsp',
        station_serial: 'T8030P0000000001',
      });
      storageRtsp.setRtspSupported(true);
      const autoRtsp = new Camera({
        serial: 'T8161T0000000055',
        name: 'driveway_auto',
        mode: 'auto',
        station_serial: 'T8030P0000000001',
      });
      autoRtsp.setRtspSupported(true);
      const porchP2p = new Camera({
        serial: 'T8214T0000000056',
        name: 'porch_p2p',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });
      const {sentCommands} = await setupAcceptanceHarness([storageRtsp, autoRtsp, porchP2p]);

      // 1. While IDLE (outside 3s post-sleep guard), external "rtsp livestream started" on "rtsp" and
      //    RTSP-capable "auto" cameras is adopted as an active RTSP stream
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: storageRtsp.getSerial(),
      });
      assert.equal(
        storageRtsp.getStoredSessionState(),
        'waking_rtsp',
        'AT-05: mode="rtsp" camera must adopt external "rtsp livestream started" while IDLE'
      );
      assert.equal(storageRtsp.getActiveMode(), 'rtsp');
      assert.equal(storageRtsp.getWakeInitiator(), 'eufy-ws');
      assert.equal(storageRtsp.isEventActive(), true);
      stop(storageRtsp, 'test stop', false, 'bridge-test');
      storageRtsp.setSleptAt(0);
      storageRtsp.setLastStoppedAt(0);

      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: autoRtsp.getSerial(),
      });
      assert.equal(
        autoRtsp.getStoredSessionState(),
        'waking_rtsp',
        'AT-05: RTSP-capable mode="auto" camera must adopt external "rtsp livestream started" as RTSP while IDLE'
      );
      assert.equal(autoRtsp.getActiveMode(), 'rtsp');
      stop(autoRtsp, 'test stop', false, 'bridge-test');
      autoRtsp.setSleptAt(0);
      autoRtsp.setLastStoppedAt(0);

      // 2. While IDLE (outside 3s guard), external "livestream started" (P2P from Eufy app / HA start_p2p_stream)
      //    is adopted as a live P2P session on both "p2p" and "rtsp" cameras
      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: porchP2p.getSerial(),
      });
      assert.equal(
        porchP2p.getStoredSessionState(),
        'waking_p2p',
        'AT-05: mode="p2p" camera must adopt external "livestream started" as P2P while IDLE'
      );
      assert.equal(porchP2p.getActiveMode(), 'p2p');
      assert.equal(porchP2p.getWakeInitiator(), 'eufy-ws');
      stop(porchP2p, 'test stop', false, 'bridge-test');
      porchP2p.setSleptAt(0);
      porchP2p.setLastStoppedAt(0);
      porchP2p.clearP2pStopInFlight();

      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: storageRtsp.getSerial(),
      });
      assert.equal(
        storageRtsp.getStoredSessionState(),
        'waking_p2p',
        'AT-05: mode="rtsp" camera must adopt external P2P "livestream started" as P2P matching event protocol'
      );
      assert.equal(storageRtsp.getActiveMode(), 'p2p');
      stop(storageRtsp, 'test stop', false, 'bridge-test');
      initOrchestrator(
        [storageRtsp, autoRtsp, porchP2p],
        new Map([
          [storageRtsp.getSerial(), storageRtsp],
          [autoRtsp.getSerial(), autoRtsp],
          [porchP2p.getSerial(), porchP2p],
        ]),
        () => false
      );
      storageRtsp.setSleptAt(0);
      storageRtsp.setLastStoppedAt(0);
      storageRtsp.clearP2pStopInFlight();
      sentCommands.length = 0;

      // 3. Configured trigger event wakes live RTSP with eventActive=true
      onEvent({
        source: 'device',
        event: 'person detected',
        serialNumber: storageRtsp.getSerial(),
        state: true,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(storageRtsp.getStoredSessionState(), 'waking_rtsp');
      assert.equal(storageRtsp.getActiveMode(), 'rtsp');
      assert.equal(storageRtsp.isEventActive(), true);
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), true);
      stop(storageRtsp, 'test stop', false, 'bridge-test');

      // 4. Direct rtsp_url camera pulls RTSP without querying eufy-security-ws, keeps sleeping card during
      //    passive 5s probes until Frame 0 decodes, and distinguishes 404 standby (Asleep) from connection
      //    error (Disconnected)
      const directCam = new Camera(
        {
          name: 'baby_cam',
          rtsp_url: 'rtsp://127.0.0.1:8554/baby_cam',
        },
        {frame: Buffer.alloc(1382400, 0x30), lastSeen: '12:00'},
        renderCameraCards
      );
      assert.equal(directCam.getConfiguredMode(), 'rtsp');
      assert.equal(directCam.isRtspDirect(), true);
      assert.equal(directCam.updateServiceHealth({wsConnected: false}), true);
      assert.equal(directCam.hasServiceDisruption(), false);
      assert.equal(directCam.shouldStartRtspDirectSession(10000), true);
      directCam.beginRtspDirectProbeSession(10000);
      assert.equal(directCam.isPassiveRtspDirectProbe(), true);
      assert.equal(
        selectEncoderFrame(directCam, 10500).frame,
        directCam.getAsleepCardBuffer(),
        'AT-05: Background direct rtsp_url probe must keep sleeping card displayed before Frame 0 decodes'
      );
      const dropRefused = directCam.recordRtspDirectProbeFailure('Connection refused');
      assert.deepEqual(dropRefused, {disruptionChanged: true, isReachableStandby: false});
      assert.equal(directCam.hasServiceDisruption(), true);
      assert.equal(directCam.isDeviceOffline(), false);
      const drop404 = directCam.recordRtspDirectProbeFailure('Server returned 404 Not Found');
      assert.deepEqual(drop404, {disruptionChanged: true, isReachableStandby: true});
      assert.equal(directCam.hasServiceDisruption(), false);
      directCam.endSession(12000, false, false, 'rtsp');
    }
  );
});
