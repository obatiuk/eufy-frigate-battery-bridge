/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-03`: `"backfill"` Mode on `RTSP`-Capable Cameras - Human Frigate Live View vs.
 * `/api/wake` (docs/acceptance/AT-03.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-03.md.
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

describe('Locked Acceptance Criterion AT-03 (docs/acceptance/AT-03.md)', () => {
  it(
    'AT-03: "backfill" mode on RTSP-capable camera (T8161) enables rtspStream=true, blocks Frigate Live View ' +
      'while BackfillJob is pending, wakes live RTSP on Live View or /api/wake when no Eufy trigger/backfill ' +
      'is active, and keeps backfill-only on /api/wake when a Eufy trigger/backfill is active',
    async () => {
      const garageRtspBf = new Camera({
        serial: 'T8161T0000000003',
        name: 'garage',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      const garageIdleWakeBf = new Camera({
        serial: 'T8161T0000000031',
        name: 'garage_idle_wake',
        mode: 'backfill',
        station_serial: 'T8030P0000000031',
      });
      garageIdleWakeBf.setRtspSupported(true);
      garageIdleWakeBf.setRtspUrl('rtsp://127.0.0.1:8554/T8161T0000000031');
      const {sentCommands, setPropCalls} = await setupAcceptanceHarness([garageRtspBf, garageIdleWakeBf]);

      applyDeviceProperties(
        garageRtspBf,
        {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: false},
          battery: {value: 85},
          state: {value: 1},
        },
        false
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(setPropCalls.includes('rtspStream=true'), true);
      assert.equal(garageRtspBf.isRtspCapable(), true);

      // 1. While a Eufy hardware trigger / BackfillJob is active, both Frigate Live View and POST /api/wake
      //    are blocked from waking live
      sentCommands.length = 0;
      onEvent({
        source: 'device',
        event: 'motion detected',
        serialNumber: garageRtspBf.getSerial(),
        state: true,
      });
      assert.equal(garageRtspBf.hasPendingBackfill(), true);

      const activeBackfillWakeRes = wakeCameraExternal(garageRtspBf, {
        durationMs: 30000,
        reason: 'garage door opening while Eufy recording',
        createEvent: true,
        delayMs: 0,
      });
      assert.equal(activeBackfillWakeRes.status, 'backfill');
      assert.equal(garageRtspBf.isSessionActive(), false);
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), false);

      const origFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {
            [garageRtspBf.getName()]: {
              consumers: [{id: 'viewer-blocked-1', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}],
            },
          };
        },
      });
      try {
        await pollViewers([garageRtspBf], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: (c, r, p, i) => stop(c, r, p, i),
          triggerCam: (...args) => trigger(...args),
        });
      } finally {
        global.fetch = origFetch;
      }
      assert.equal(
        garageRtspBf.isSessionActive(),
        false,
        'AT-03: Frigate Live View must be blocked while a BackfillJob is pending'
      );
      assert.equal(
        garageRtspBf.hasPendingBackfill(),
        true,
        'AT-03: Pending BackfillJob must not be canceled by blocked Live View connection'
      );
      garageRtspBf.clearPendingBackfill();
      garageRtspBf.clearActiveTriggerEvents();
      garageRtspBf.clearViewerIds();

      // 2. POST /api/wake while IDLE with no active Eufy trigger/BackfillJob wakes live RTSP and creates Frigate event
      sentCommands.length = 0;
      const idleWakeRes = wakeCameraExternal(garageIdleWakeBf, {
        durationMs: 30000,
        reason: 'garage door opening',
        createEvent: true,
        delayMs: 0,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(idleWakeRes.status, 'waking');
      assert.equal(garageIdleWakeBf.getStoredSessionState(), 'waking_rtsp');
      assert.equal(garageIdleWakeBf.getActiveMode(), 'rtsp');
      assert.equal(garageIdleWakeBf.isEventActive(), true);
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), true);
      garageIdleWakeBf.endSession(Date.now());

      // 3. Human Frigate Live View when no BackfillJob is pending wakes via RTSP, and /api/wake while already
      //    live extends the hold
      sentCommands.length = 0;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {
            [garageRtspBf.getName()]: {
              consumers: [{id: 'viewer-1', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}],
            },
          };
        },
      });
      try {
        await pollViewers([garageRtspBf], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: (c, r, p, i) => stop(c, r, p, i),
          triggerCam: (...args) => trigger(...args),
        });
      } finally {
        global.fetch = origFetch;
      }
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(garageRtspBf.getStoredSessionState(), 'waking_rtsp');
      assert.equal(garageRtspBf.getActiveMode(), 'rtsp');
      assert.equal(garageRtspBf.isEventActive(), false);
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), true);
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      const liveWakeRes = wakeCameraExternal(garageRtspBf, {
        durationMs: 45000,
        reason: 'garage door open while viewing',
        createEvent: true,
        delayMs: 0,
      });
      assert.equal(liveWakeRes.status, 'extended');
      assert.equal(garageRtspBf.isActiveLiveSession(), true);
      stop(garageRtspBf, 'test stop', false, 'bridge-test');
    }
  );
});
