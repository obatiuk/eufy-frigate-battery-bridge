/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-04`: `"backfill"` Mode on `P2P`-Only Cameras & Doorbells - Human Frigate Live
 * View, `/api/wake` & Stray `RTSP` Recovery (docs/acceptance/AT-04.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-04.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {applyDeviceProperties} = require('../../src/services/eufy-client');
const {pollViewers} = require('../../src/services/frigate-client');
const {onEvent, wakeCameraExternal, stop, trigger} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-04 (docs/acceptance/AT-04.md)', () => {
  it(
    'AT-04: "backfill" mode on P2P doorbell (T8214) blocks Live View and keeps backfill-only on /api/wake ' +
      'while BackfillJob is active, wakes live P2P on /api/wake or Live View when no BackfillJob is active, ' +
      'and recovers once from stray HomeBase RTSP start',
    async () => {
      const doorbellBf = new Camera({
        serial: 'T8214T0000000004',
        name: 'doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      const doorbellIdleWakeBf = new Camera({
        serial: 'T8214T0000000041',
        name: 'doorbell_idle_wake',
        mode: 'backfill',
        station_serial: 'T8030P0000000041',
      });
      const {sentCommands, setPropCalls} = await setupAcceptanceHarness([doorbellBf, doorbellIdleWakeBf]);

      applyDeviceProperties(
        doorbellBf,
        {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: true},
          battery: {value: 80},
          state: {value: 1},
        },
        false
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(setPropCalls.includes('rtspStream=false'), true);
      assert.equal(doorbellBf.isRtspCapable(), false);

      sentCommands.length = 0;
      setPropCalls.length = 0;

      // 1. While a Eufy hardware trigger / BackfillJob is active, both POST /api/wake and Frigate Live View stay IDLE
      onEvent({
        source: 'device',
        event: 'rings',
        serialNumber: doorbellBf.getSerial(),
        state: true,
      });
      const activeBackfillWakeRes = wakeCameraExternal(doorbellBf, {
        durationMs: 25000,
        reason: 'api-doorbell-while-ringing',
        createEvent: true,
      });
      assert.equal(activeBackfillWakeRes.status, 'backfill');
      assert.equal(doorbellBf.getStoredSessionState(), 'idle');
      assert.equal(doorbellBf.isSessionActive(), false);
      assert.equal(doorbellBf.hasPendingBackfill(), true);
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      const origFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {
            [doorbellBf.getName()]: {
              consumers: [{id: 'viewer-db-blocked', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}],
            },
          };
        },
      });
      try {
        await pollViewers([doorbellBf], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: (c, r, p, i) => stop(c, r, p, i),
          triggerCam: (...args) => trigger(...args),
        });
      } finally {
        global.fetch = origFetch;
      }
      assert.equal(
        doorbellBf.isSessionActive(),
        false,
        'AT-04: Frigate Live View on doorbell must be blocked while BackfillJob is pending'
      );
      doorbellBf.clearPendingBackfill();
      doorbellBf.clearActiveTriggerEvents();
      doorbellBf.clearViewerIds();

      // 2. POST /api/wake while IDLE with no active Eufy trigger/BackfillJob wakes live P2P
      sentCommands.length = 0;
      const idleWakeRes = wakeCameraExternal(doorbellIdleWakeBf, {
        durationMs: 25000,
        reason: 'api-doorbell-test',
        createEvent: true,
        delayMs: 0,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(idleWakeRes.status, 'waking');
      assert.equal(doorbellIdleWakeBf.getStoredSessionState(), 'waking_p2p');
      assert.equal(doorbellIdleWakeBf.getActiveMode(), 'p2p');
      assert.equal(doorbellIdleWakeBf.isEventActive(), true);
      assert.equal(sentCommands.includes('device.start_livestream'), true);
      doorbellIdleWakeBf.endSession(Date.now());

      // 3. Human Frigate Live View when no BackfillJob is pending wakes live P2P
      sentCommands.length = 0;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {
            [doorbellBf.getName()]: {
              consumers: [{id: 'viewer-db-1', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}],
            },
          };
        },
      });
      try {
        await pollViewers([doorbellBf], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: (c, r, p, i) => stop(c, r, p, i),
          triggerCam: (...args) => trigger(...args),
        });
      } finally {
        global.fetch = origFetch;
      }
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(doorbellBf.getStoredSessionState(), 'waking_p2p');
      assert.equal(doorbellBf.getActiveMode(), 'p2p');
      assert.equal(sentCommands.includes('device.start_livestream'), true);

      // 4. Stray "rtsp livestream started" during WAKING_P2P stops RTSP, disables rtspStream, and restarts P2P
      //    at most once per session
      sentCommands.length = 0;
      setPropCalls.length = 0;
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: doorbellBf.getSerial(),
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(setPropCalls.includes('rtspStream=false'), true);
      assert.equal(sentCommands.includes('device.stop_rtsp_livestream'), true);
      assert.equal(sentCommands.includes('device.start_livestream'), true);

      sentCommands.length = 0;
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: doorbellBf.getSerial(),
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sentCommands.includes('device.stop_rtsp_livestream'), false);
      assert.equal(sentCommands.includes('device.start_livestream'), false);
      stop(doorbellBf, 'test stop', false, 'bridge-test');
    }
  );
});
