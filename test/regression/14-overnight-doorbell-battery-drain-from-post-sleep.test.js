/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 14. Overnight Doorbell Battery Drain from Post-Sleep `P2P` Re-Wake Loops
 * (docs/regression/14-overnight-doorbell-battery-drain-from-post-sleep.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {pollViewers} = require('../../src/services/frigate-client');
const {initOrchestrator, onEvent, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 14. Overnight Doorbell Battery Drain from Post-Sleep `P2P` Re-Wake Loops', () => {
  it(
    'Regression 14: skips poll_refresh when a viewer connects to an online camera in ' + 'low-battery economy mode',
    async () => {
      // Verify: online low-battery cameras never trigger driver.poll_refresh when a live viewer connects (AT-07.4).
      const lowBatDoorbell = new Camera({
        serial: 'T8214T2222222222',
        name: 'doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000000000',
      });
      lowBatDoorbell.applyTelemetryProperties({state: 1, battery: 3, wifiRssi: -24, temperature: 30}, false);
      let lowBatViewerForceRefreshes = 0;
      const origFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {doorbell: {consumers: [{id: 'mse-probe-1', user_agent: 'Mozilla/5.0', format_name: 'mse'}]}};
        },
      });
      try {
        await pollViewers([lowBatDoorbell], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: (force) => {
            if (force) lowBatViewerForceRefreshes++;
          },
          stopCam: () => {},
          triggerCam: () => {},
        });
      } finally {
        global.fetch = origFetch;
      }
      assert.equal(
        lowBatViewerForceRefreshes,
        0,
        'MSE viewer connecting to an online camera in low-battery economy mode (3%) must not call driver.poll_refresh'
      );
    }
  );

  it(
    'Regression 14: ignores trailing rtsp and p2p livestream started ' + 'within 3s post-sleep in backfill mode',
    async () => {
      // Regression: AT-08.1 trailing hardware stream-start events within 3s post-sleep (or while stoppingP2p)
      // must not fall through to shouldBackfillOnlyOnEvent() and queue a spurious BackfillJob
      const bfRtspCam = new Camera({
        serial: 'T8161T9900000001',
        name: 'bf_guard_rtsp',
        mode: 'backfill',
        station_serial: 'T8030P9900000000',
      });
      bfRtspCam.updateDiscoveredRtspConfig('T8030P9900000000', 'rtsp://127.0.0.1:8554/bf_guard_rtsp');
      const bfP2pCam = new Camera({
        serial: 'T8214T9900000002',
        name: 'bf_guard_p2p',
        mode: 'backfill',
        station_serial: 'T8030P9900000000',
      });
      const sentCommands = [];
      const testCams = [bfRtspCam, bfP2pCam];
      const testBySerial = new Map(testCams.map((c) => [c.getSerial(), c]));

      class GuardWs {
        constructor() {
          this.readyState = 1;
          this.handlers = new Map();
        }
        on(ev, fn) {
          this.handlers.set(ev, fn);
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          sentCommands.push(msg.command);
          if (cb) cb();
          const msgHandler = this.handlers.get('message');
          if (msgHandler) {
            queueMicrotask(() =>
              msgHandler(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}))
            );
          }
        }
      }
      let wsInst = null;
      initOrchestrator(testCams, testBySerial, () => false);
      configureEufyClientHooks({
        cams: testCams,
        bySerial: testBySerial,
        isShuttingDown: () => false,
        WebSocket: function MockGuardWs() {
          wsInst = new GuardWs();
          return wsInst;
        },
      });
      connectWs();
      configureEufyClientHooks({isShuttingDown: () => true});
      await wsInst.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));

      const origDateNow = Date.now;
      let fakeNow = 5000000;
      Date.now = () => fakeNow;
      try {
        bfRtspCam.beginSession('rtsp', fakeNow - 20000, true);
        bfRtspCam.setGotVideo(true);
        bfRtspCam.terminateSession(fakeNow - 500, 'viewer closed', false, 'bridge-timer');
        bfP2pCam.beginSession('p2p', fakeNow - 20000, true);
        bfP2pCam.setGotVideo(true);
        bfP2pCam.terminateSession(fakeNow - 500, 'viewer closed', false, 'bridge-timer');
        bfP2pCam.clearP2pStopInFlight();
        sentCommands.length = 0;

        // Within 3s post-sleep guard: both trailing events must be ignored without queuing BackfillJob
        onEvent({event: 'rtsp livestream started', serialNumber: bfRtspCam.getSerial()});
        onEvent({event: 'livestream started', serialNumber: bfP2pCam.getSerial()});
        assert.equal(bfRtspCam.hasPendingBackfill(), false, '0..3s trailing rtsp start must not queue BackfillJob');
        assert.equal(bfP2pCam.hasPendingBackfill(), false, '250..3000ms trailing P2P start must not queue BackfillJob');
        assert.equal(sentCommands.includes('device.stop_rtsp_livestream'), false);
        assert.equal(sentCommands.includes('device.stop_livestream'), false);

        // Past 3s post-sleep guard: 'rtsp livestream started' queues BackfillJob as expected
        fakeNow += 4000;
        onEvent({event: 'rtsp livestream started', serialNumber: bfRtspCam.getSerial()});
        assert.equal(bfRtspCam.hasPendingBackfill(), true, 'Past 3s guard, rtsp livestream started queues BackfillJob');
        bfRtspCam.clearPendingBackfill();

        // While actively playing backfill (DOWNLOAD), a new 'rtsp livestream started' still queues background
        // BackfillJob
        fakeNow = bfRtspCam.getLastStoppedAt() + 500;
        bfRtspCam.beginBackfillDownload(
          {
            storagePath: '/zx/playing.zxvideo',
            cipherId: 0,
            clipMs: fakeNow - 10000,
            event: 'motion detected',
            personName: '',
            reason: 'motion detected',
          },
          false,
          fakeNow
        );
        onEvent({event: 'rtsp livestream started', serialNumber: bfRtspCam.getSerial()});
        assert.equal(
          bfRtspCam.hasPendingBackfill(),
          true,
          'Active backfill download must still accept new background trigger backfill'
        );
      } finally {
        Date.now = origDateNow;
        bfRtspCam.clearPendingBackfill();
        bfP2pCam.clearPendingBackfill();
        stop(bfRtspCam, 'cleanup', false, 'bridge-test');
        stop(bfP2pCam, 'cleanup', false, 'bridge-test');
      }
    }
  );
});
