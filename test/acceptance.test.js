/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 Acceptance Test Suite mapping directly to ACCEPTANCE.md (AT-01 through AT-19).
 * Never weaken or delete these tests without an explicit user update to ACCEPTANCE.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testTmpDir = path.resolve(__dirname, '..', '.tmp');
const testCacheDir = path.join(testTmpDir, 'cache');
fs.mkdirSync(testCacheDir, {recursive: true});
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.BRIDGE_LOG_LEVEL = 'error';
process.env.TMPDIR = testTmpDir;
process.env.BRIDGE_CACHE_DIR = testCacheDir;

global.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return {event_id: 'mock-ev', consumers: []};
  },
  async text() {
    return '';
  },
});

const {
  BridgeConfigBuilder,
  validateConfig,
  resolveServiceEndpoints,
  loadConfigFile,
  resolveFrameRates,
  resolveCameraTimers,
  resolveHardwareRecordingConfig,
  resolveCardConfig,
  resolveCameraMode,
} = require('../src/config');
const {log} = require('../src/logger');
const {WakeRequest, Camera} = require('../src/domain/camera');
const {evaluateTelemetryState} = require('../src/domain/telemetry');
const {BackfillJob} = require('../src/domain/backfill-job');
const {renderCameraCards, renderLiveFrameWithCard} = require('../src/overlay/card-renderer');
const {selectEncoderFrame, shouldWriteEncoderFrame, pushFrameToEncoder} = require('../src/media/encoder');
const {handleDecodedP2pFrame, flushDecoderInput} = require('../src/media/decoder');
const {
  configureEufyClientHooks,
  connectWs,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
} = require('../src/services/eufy-client');
const {classifyViewerAction, syncFrigateMotionMasks, pollViewers} = require('../src/services/frigate-client');
const {notifyHA} = require('../src/services/ha-notifier');
const {
  resolveTargetCameras,
  buildHealthPayload,
  buildConfigPayload,
  createHttpRequestHandler,
} = require('../src/services/http-server');
const {
  initOrchestrator,
  onEvent,
  trigger,
  stop,
  arbitrate,
  runHousekeepingTick,
  wakeCameraExternal,
} = require('../src/services/stream-orchestrator');

/**
 * Installs a mock eufy-security-ws WebSocket harness that records all outbound RPC commands
 * and device.set_property calls for acceptance verification.
 *
 * @param {Camera[]} cams - Camera domain instances under test.
 * @returns {Promise<{ sentCommands: string[], setPropCalls: string[] }>}
 */
async function setupAcceptanceHarness(cams) {
  const sentCommands = [];
  const setPropCalls = [];
  const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
  let wsInstance = null;

  class AcceptanceWs {
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
      if (msg.command === 'device.set_property') {
        setPropCalls.push(msg.name + '=' + msg.value);
      }
      if (cb) cb();
      const msgHandler = this.handlers.get('message');
      if (msgHandler) {
        queueMicrotask(() => {
          msgHandler(
            JSON.stringify({
              type: 'result',
              messageId: msg.messageId,
              success: true,
              result: msg.command === 'start_listening' ? {state: {devices: []}} : {},
            })
          );
        });
      }
    }
  }

  initOrchestrator(cams, bySerial, () => false);
  configureEufyClientHooks({
    cams,
    bySerial,
    isShuttingDown: () => false,
    onWsClosedStop: (cam) => stop(cam, 'bridge lost eufy-security-ws connection', false, 'error/ws-disconnect'),
    onDeviceOnlineResume: () => {},
    WebSocket: function MockAcceptanceWs() {
      wsInstance = new AcceptanceWs();
      return wsInstance;
    },
  });
  connectWs();
  await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
  configureEufyClientHooks({isShuttingDown: () => true, wsReadyAt: Date.now() - 10000});
  sentCommands.length = 0;
  setPropCalls.length = 0;
  return {sentCommands, setPropCalls, wsInstance};
}

describe('Core System Acceptance Criteria (ACCEPTANCE.md AT-01 .. AT-19)', () => {
  it(
    'AT-01: "backfill" mode on RTSP-capable camera (T8161) never wakes live on Eufy motion or idle ' +
      '"rtsp livestream started" (showing Yellow Waiting), and piggybacks on standalone Eufy app ' +
      '"livestream started"',
    async () => {
      const garageRtspBf = new Camera(
        {
          serial: 'T8161T0000000001',
          name: 'garage',
          mode: 'backfill',
          station_serial: 'T8030P0000000001',
        },
        {frame: Buffer.alloc(1382400, 0x22), lastSeen: '12:00'},
        renderCameraCards
      );
      const {sentCommands, setPropCalls} = await setupAcceptanceHarness([garageRtspBf]);

      applyDeviceProperties(
        garageRtspBf,
        {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: true},
          battery: {value: 90},
          state: {value: 1},
        },
        false
      );
      await new Promise((r) => setTimeout(r, 20));
      sentCommands.length = 0;
      setPropCalls.length = 0;

      // 1. Eufy motion/person trigger events queue BackfillJob, keep camera IDLE, and select Yellow Waiting (card.busy)
      onEvent({
        source: 'device',
        event: 'motion detected',
        serialNumber: garageRtspBf.getSerial(),
        state: true,
      });
      onEvent({
        source: 'device',
        event: 'person detected',
        serialNumber: garageRtspBf.getSerial(),
        state: true,
      });

      assert.equal(garageRtspBf.sessionState, 'idle');
      assert.equal(garageRtspBf.isSessionActive(), false);
      assert.equal(garageRtspBf.hasPendingBackfill(), true);
      assert.equal(
        selectEncoderFrame(garageRtspBf, Date.now()).frame,
        garageRtspBf.card.busy,
        'AT-01: IDLE camera with pending BackfillJob must select Yellow Waiting (card.busy) frame'
      );
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), false);
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      // 2. Hardware "rtsp livestream started" while IDLE never adopts a live stream,
      //    never stops RTSP or disables rtspStream, and queues/extends the BackfillJob window
      garageRtspBf.clearPendingBackfill();
      garageRtspBf.activeTriggerEvents.clear();
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(garageRtspBf.sessionState, 'idle');
      assert.equal(garageRtspBf.isSessionActive(), false);
      assert.equal(garageRtspBf.isRtspCapable(), true);
      assert.equal(
        garageRtspBf.hasPendingBackfill(),
        true,
        'AT-01: "rtsp livestream started" while IDLE in backfill mode must queue/extend BackfillJob'
      );
      assert.equal(sentCommands.includes('device.stop_rtsp_livestream'), false);
      assert.equal(setPropCalls.includes('rtspStream=false'), false);

      onEvent({
        source: 'device',
        event: 'rtsp livestream stopped',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(
        garageRtspBf.isBackfillRecordingCleared(),
        true,
        'AT-01: "rtsp livestream stopped" must mark the backfill trigger cleared so settling begins'
      );

      // 3. Standalone "livestream started" with no active trigger/backfill (Eufy mobile app) piggybacks on P2P
      //    without sending start_livestream and stops immediately on "livestream stopped"
      garageRtspBf.clearPendingBackfill();
      garageRtspBf.activeTriggerEvents.clear();
      sentCommands.length = 0;
      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(garageRtspBf.sessionState, 'waking_p2p');
      assert.equal(garageRtspBf.activeMode, 'p2p');
      assert.equal(garageRtspBf.p2pReady, true);
      assert.equal(sentCommands.includes('device.start_livestream'), false);
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), false);

      onEvent({
        source: 'device',
        event: 'livestream stopped',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(
        garageRtspBf.isSessionActive(),
        false,
        'AT-01: Piggybacked Eufy app stream in backfill mode must stop immediately on "livestream stopped"'
      );

      // 4. Stale hardware trigger without state=false expires after 130s or station/WS disconnect
      const tStale = 500000;
      garageRtspBf.lastMotionAt = tStale;
      garageRtspBf.motionClearedAt = 0;
      garageRtspBf.queueEventBackfill(tStale, 'motion detected', '', 'motion detected', 10, true);
      garageRtspBf.pendingBackfill = null;
      assert.equal(
        garageRtspBf.shouldBackfillOnlyOnApiWake(tStale + 130000),
        true,
        'AT-01: Unexpired hardware trigger (<= 130s) keeps /api/wake in backfill-only mode'
      );
      assert.equal(
        garageRtspBf.shouldBackfillOnlyOnApiWake(tStale + 130001),
        false,
        'AT-01: Stale hardware trigger (> 130s without state=false) expires so /api/wake is not stuck in backfill'
      );
      garageRtspBf.lastMotionAt = tStale + 200000;
      garageRtspBf.queueEventBackfill(tStale + 200000, 'person detected', '', 'person detected', 200, true);
      garageRtspBf.pendingBackfill = null;
      garageRtspBf.handleStationDisconnected('ws_closed');
      assert.equal(
        garageRtspBf.shouldBackfillOnlyOnApiWake(tStale + 201000),
        false,
        'AT-01: Station/WebSocket disconnect clears active hardware triggers'
      );
    }
  );

  it(
    'AT-02: "backfill" mode on P2P camera/doorbell (T8214) never wakes live on motion/ring or trigger-paired ' +
      '"livestream started" (showing Yellow Waiting), and piggybacks on standalone Eufy app "livestream started"',
    async () => {
      const doorbellBf = new Camera(
        {
          serial: 'T8214T0000000002',
          name: 'doorbell',
          mode: 'backfill',
          station_serial: 'T8030P0000000001',
        },
        {frame: Buffer.alloc(1382400, 0x22), lastSeen: '12:00'},
        renderCameraCards
      );
      const {sentCommands} = await setupAcceptanceHarness([doorbellBf]);

      // 1. Trigger event + paired "livestream started" queues/extends BackfillJob, stays IDLE,
      //    and selects Yellow Waiting (card.busy)
      onEvent({
        source: 'device',
        event: 'rings',
        serialNumber: doorbellBf.getSerial(),
        state: true,
      });
      assert.equal(doorbellBf.sessionState, 'idle');
      assert.equal(doorbellBf.isSessionActive(), false);
      assert.equal(doorbellBf.hasPendingBackfill(), true);
      assert.equal(
        selectEncoderFrame(doorbellBf, Date.now()).frame,
        doorbellBf.card.busy,
        'AT-02: IDLE doorbell with pending BackfillJob must select Yellow Waiting (card.busy) frame'
      );
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(doorbellBf.sessionState, 'idle');
      assert.equal(doorbellBf.isSessionActive(), false);
      assert.equal(
        doorbellBf.hasPendingBackfill(),
        true,
        'AT-02: Trigger-paired "livestream started" while IDLE in backfill mode must queue/extend BackfillJob'
      );

      onEvent({
        source: 'device',
        event: 'rings',
        serialNumber: doorbellBf.getSerial(),
        state: false,
      });
      onEvent({
        source: 'device',
        event: 'livestream stopped',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(
        doorbellBf.isBackfillRecordingCleared(),
        true,
        'AT-02: "livestream stopped" must mark the backfill trigger cleared so settling begins'
      );

      // 2. Standalone "livestream started" with no active trigger/backfill (Eufy mobile app) piggybacks on P2P
      //    and stops immediately on "livestream stopped"
      doorbellBf.clearPendingBackfill();
      doorbellBf.activeTriggerEvents.clear();
      sentCommands.length = 0;
      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(doorbellBf.sessionState, 'waking_p2p');
      assert.equal(doorbellBf.activeMode, 'p2p');
      assert.equal(doorbellBf.p2pReady, true);
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      onEvent({
        source: 'device',
        event: 'livestream stopped',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(
        doorbellBf.isSessionActive(),
        false,
        'AT-02: Piggybacked Eufy app stream on doorbell in backfill mode must stop immediately on "livestream stopped"'
      );

      // 3. Stale hardware trigger without state=false expires after 130s or device offline transition
      const tStale = 600000;
      doorbellBf.lastMotionAt = tStale;
      doorbellBf.motionClearedAt = 0;
      doorbellBf.queueEventBackfill(tStale, 'rings', '', 'rings', 1000, true);
      doorbellBf.pendingBackfill = null;
      assert.equal(doorbellBf.shouldBackfillOnlyOnApiWake(tStale + 130000), true);
      assert.equal(doorbellBf.shouldBackfillOnlyOnApiWake(tStale + 130001), false);
      doorbellBf.lastMotionAt = tStale + 200000;
      doorbellBf.queueEventBackfill(tStale + 200000, 'rings', '', 'rings', 1000, true);
      doorbellBf.pendingBackfill = null;
      doorbellBf.applyTelemetryProperties({state: 3, battery: 2, chargingStatus: 2, wifiRssi: -100}, false);
      assert.equal(
        doorbellBf.shouldBackfillOnlyOnApiWake(tStale + 201000),
        false,
        'AT-02: Device offline transition clears active hardware triggers'
      );
    }
  );

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
      garageIdleWakeBf.rtspSupported = true;
      garageIdleWakeBf.rtspUrl = 'rtsp://127.0.0.1:8554/T8161T0000000031';
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
          return {consumers: [{id: 'viewer-blocked-1', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}]};
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
      garageRtspBf.activeTriggerEvents.clear();
      garageRtspBf.viewerIds.clear();

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
      assert.equal(garageIdleWakeBf.sessionState, 'waking_rtsp');
      assert.equal(garageIdleWakeBf.activeMode, 'rtsp');
      assert.equal(garageIdleWakeBf.eventActive, true);
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), true);
      garageIdleWakeBf.endSession(Date.now());

      // 3. Human Frigate Live View when no BackfillJob is pending wakes via RTSP, and /api/wake while already
      //    live extends the hold
      sentCommands.length = 0;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {consumers: [{id: 'viewer-1', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}]};
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

      assert.equal(garageRtspBf.sessionState, 'waking_rtsp');
      assert.equal(garageRtspBf.activeMode, 'rtsp');
      assert.equal(garageRtspBf.eventActive, false);
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
      assert.equal(doorbellBf.sessionState, 'idle');
      assert.equal(doorbellBf.isSessionActive(), false);
      assert.equal(doorbellBf.hasPendingBackfill(), true);
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      const origFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {consumers: [{id: 'viewer-db-blocked', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}]};
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
      doorbellBf.activeTriggerEvents.clear();
      doorbellBf.viewerIds.clear();

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
      assert.equal(doorbellIdleWakeBf.sessionState, 'waking_p2p');
      assert.equal(doorbellIdleWakeBf.activeMode, 'p2p');
      assert.equal(doorbellIdleWakeBf.eventActive, true);
      assert.equal(sentCommands.includes('device.start_livestream'), true);
      doorbellIdleWakeBf.endSession(Date.now());

      // 3. Human Frigate Live View when no BackfillJob is pending wakes live P2P
      sentCommands.length = 0;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {consumers: [{id: 'viewer-db-1', user_agent: 'Mozilla/5.0', format_name: 'webrtc'}]};
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
      assert.equal(doorbellBf.sessionState, 'waking_p2p');
      assert.equal(doorbellBf.activeMode, 'p2p');
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
      storageRtsp.rtspSupported = true;
      const autoRtsp = new Camera({
        serial: 'T8161T0000000055',
        name: 'driveway_auto',
        mode: 'auto',
        station_serial: 'T8030P0000000001',
      });
      autoRtsp.rtspSupported = true;
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
        storageRtsp.sessionState,
        'waking_rtsp',
        'AT-05: mode="rtsp" camera must adopt external "rtsp livestream started" while IDLE'
      );
      assert.equal(storageRtsp.activeMode, 'rtsp');
      assert.equal(storageRtsp.wakeInitiator, 'eufy-ws');
      assert.equal(storageRtsp.eventActive, true);
      stop(storageRtsp, 'test stop', false, 'bridge-test');
      storageRtsp.sleptAt = 0;
      storageRtsp.lastStoppedAt = 0;

      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: autoRtsp.getSerial(),
      });
      assert.equal(
        autoRtsp.sessionState,
        'waking_rtsp',
        'AT-05: RTSP-capable mode="auto" camera must adopt external "rtsp livestream started" as RTSP while IDLE'
      );
      assert.equal(autoRtsp.activeMode, 'rtsp');
      stop(autoRtsp, 'test stop', false, 'bridge-test');
      autoRtsp.sleptAt = 0;
      autoRtsp.lastStoppedAt = 0;

      // 2. While IDLE (outside 3s guard), external "livestream started" (P2P from Eufy app / HA start_p2p_stream)
      //    is adopted as a live P2P session on both "p2p" and "rtsp" cameras
      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: porchP2p.getSerial(),
      });
      assert.equal(
        porchP2p.sessionState,
        'waking_p2p',
        'AT-05: mode="p2p" camera must adopt external "livestream started" as P2P while IDLE'
      );
      assert.equal(porchP2p.activeMode, 'p2p');
      assert.equal(porchP2p.wakeInitiator, 'eufy-ws');
      stop(porchP2p, 'test stop', false, 'bridge-test');
      porchP2p.sleptAt = 0;
      porchP2p.lastStoppedAt = 0;
      porchP2p.clearP2pStopInFlight();

      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: storageRtsp.getSerial(),
      });
      assert.equal(
        storageRtsp.sessionState,
        'waking_p2p',
        'AT-05: mode="rtsp" camera must adopt external P2P "livestream started" as P2P matching event protocol'
      );
      assert.equal(storageRtsp.activeMode, 'p2p');
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
      storageRtsp.sleptAt = 0;
      storageRtsp.lastStoppedAt = 0;
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
      assert.equal(storageRtsp.sessionState, 'waking_rtsp');
      assert.equal(storageRtsp.activeMode, 'rtsp');
      assert.equal(storageRtsp.eventActive, true);
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
      assert.equal(directCam.mode, 'rtsp');
      assert.equal(directCam.isRtspDirect(), true);
      assert.equal(directCam.updateServiceHealth({wsConnected: false}), true);
      assert.equal(directCam.hasServiceDisruption(), false);
      assert.equal(directCam.shouldStartRtspDirectSession(10000), true);
      directCam.beginRtspDirectProbeSession(10000);
      assert.equal(directCam.isPassiveRtspDirectProbe(), true);
      assert.equal(
        selectEncoderFrame(directCam, 10500).frame,
        directCam.card.asleep,
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

  it('AT-06: RTSP sessions run in parallel without blocking P2P backfill downloads on the same HomeBase', () => {
    const rtspCam1 = new Camera({
      serial: 'T8161T0000000006',
      name: 'storage',
      mode: 'rtsp',
      station_serial: 'T8030P0000000001',
    });
    rtspCam1.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');
    const rtspCam2 = new Camera({
      serial: 'T8161T0000000007',
      name: 'garage',
      mode: 'backfill',
      station_serial: 'T8030P0000000001',
    });
    rtspCam2.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live1');
    const doorbellBf = new Camera({
      serial: 'T8214T0000000008',
      name: 'doorbell',
      mode: 'backfill',
      station_serial: 'T8030P0000000001',
    });

    const now = 100000;
    rtspCam1.beginSession('rtsp', now, true);
    rtspCam2.beginSession('rtsp', now, false);
    assert.equal(rtspCam1.usesP2pSlot(), false);
    assert.equal(rtspCam2.usesP2pSlot(), false);

    assert.equal(
      doorbellBf.isStationIdleForBackfill([rtspCam1, rtspCam2, doorbellBf], now + 10000, 5000),
      true,
      'Active RTSP sessions must never block P2P backfill downloads on the same HomeBase'
    );
  });

  it(
    'AT-07: Deep-standby battery cameras (state=0) are never marked offline when healthy, genuinely offline ' +
      'cameras pause their encoder,Low-Battery Economy Mode skips poll_refresh, and battery swaps auto-recover',
    async () => {
      const cam = new Camera({
        serial: 'T8214T0000000009',
        name: 'doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });

      // 1. Healthy deep standby (state=0, battery=85%, rssi=-70 dBm) is online
      cam.applyTelemetryProperties({state: 0, battery: 85, wifiRssi: -70, wifiSignalLevel: 3}, false);
      assert.equal(cam.isDeviceOffline(), false);

      // 2. Low-battery economy mode (30% unplugged, default threshold 30%, state=1 online) shortens hold
      //    to 20s and skips driver.poll_refresh
      cam.applyTelemetryProperties({state: 1, battery: 30, chargingStatus: 2, wifiRssi: -68}, false);
      assert.equal(cam.isLowBattery(), true);
      assert.equal(cam.isCriticalBattery(), false);
      assert.equal(cam.getEffectiveHoldMs(), 20000);
      cam.applyTelemetryProperties({state: 1, battery: 5, chargingStatus: 2, wifiRssi: -68}, false);
      assert.equal(cam.isCriticalBattery(), true);
      const {sentCommands} = await setupAcceptanceHarness([cam]);
      await fetchAllCameraTelemetry(false);
      assert.equal(
        sentCommands.includes('driver.poll_refresh'),
        false,
        'AT-07: Online camera in Low-Battery Economy Mode must not invoke driver.poll_refresh on background poll'
      );

      // 3. Explicit OFFLINE_LOWBAT (state=3) marks camera offline and pauses encoder
      let encoderKilled = false;
      cam.attachEncoder({
        kill() {
          encoderKilled = true;
        },
      });
      cam.applyTelemetryProperties({state: 3, battery: 2, chargingStatus: 2, wifiRssi: -100}, false);
      assert.equal(cam.isDeviceOffline(), true);
      assert.equal(cam.pauseEncoderForOffline(), true);
      assert.equal(encoderKilled, true);

      // 4. Battery swap to 100% clears offline state even if stale state=3 is still reported
      const swapped = cam.applyTelemetryProperties({state: 3, battery: 100, chargingStatus: 2, wifiRssi: -72}, false);
      assert.equal(cam.isDeviceOffline(), false);
      assert.equal(swapped.offlineChanged, true);
      assert.equal(cam.shouldResumeOfflineEncoder(), true);
    }
  );

  it(
    'AT-08: Enforces 3s post-sleep guard, sends only device.stop_livestream for wedged idle radios, ' +
      'and handles service disruptions cleanly',
    async () => {
      const cam = new Camera({
        serial: 'T8214T0000000010',
        name: 'doorbell',
        mode: 'p2p',
        station_serial: 'T8030P0000000010',
      });
      const {sentCommands, wsInstance} = await setupAcceptanceHarness([cam]);

      const t0 = Date.now();
      cam.beginSession('p2p', t0 - 20000, true);
      cam.gotVideo = true;
      cam.terminateSession(t0 - 500, 'hold expired', false, 'bridge-timer');
      cam.clearP2pStopInFlight();
      sentCommands.length = 0;

      // 1. Within 3s post-sleep window: trailing video data or livestream started is ignored
      assert.equal(cam.canAdoptExternalWake(t0, 3000), false);
      onEvent({
        event: 'livestream video data',
        serialNumber: cam.getSerial(),
        buffer: {data: [0, 0, 0, 1, 0x65]},
      });
      assert.equal(cam.isSessionActive(), false);
      assert.equal(sentCommands.includes('device.stop_livestream'), false);

      // 2. Past 3s post-sleep window: unsolicited video data sends device.stop_livestream without adopting a wake
      cam.sleptAt = t0 - 5000;
      cam.lastStoppedAt = t0 - 5000;
      cam.unsolicitedStopAt = 0;
      onEvent({
        event: 'livestream video data',
        serialNumber: cam.getSerial(),
        buffer: {data: [0, 0, 0, 1, 0x65]},
      });
      assert.equal(cam.isSessionActive(), false);
      assert.equal(sentCommands.includes('device.stop_livestream'), true);

      // 3. 4 idle wifiRssi changes > 15s after sleep sends only device.stop_livestream (never station.disconnect)
      sentCommands.length = 0;
      cam.sleptAt = t0 - 30000;
      cam.lastStoppedAt = t0 - 30000;
      cam.lastWedgedRadioStopAt = 0;
      for (const rssi of [-65, -66, -65, -66]) {
        onEvent({
          event: 'property changed',
          serialNumber: cam.getSerial(),
          name: 'wifiRssi',
          value: rssi,
        });
      }
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sentCommands.includes('device.stop_livestream'), true);
      assert.equal(sentCommands.includes('station.disconnect'), false);
      assert.equal(sentCommands.includes('device.cancel_download'), false);

      // 4. Service disruption resilience: ws_closed terminates active sessions, keeps /healthz strictly {ok: true}
      //    (omitting ws_connected and all external service fields) during external outages, returns {ok: false} only
      //    on shutdown, and marks camera serviceDisrupted until reconnected
      cam.beginSession('p2p', t0, true);
      assert.equal(cam.isSessionActive(), true);
      wsInstance.handlers.get('close')();
      assert.equal(cam.isSessionActive(), false);
      const degradedHealth = buildHealthPayload(false);
      assert.deepEqual(degradedHealth, {ok: true});
      assert.equal('ws_connected' in degradedHealth, false);
      assert.deepEqual(buildHealthPayload(true), {ok: false});
      assert.equal(cam.hasServiceDisruption(), true);
      cam.updateServiceHealth({wsConnected: true});
      assert.equal(cam.hasServiceDisruption(), false);
    }
  );

  it('AT-09: Post-viewer linger terminates cleanly on stream drop without re-waking in a loop', () => {
    const rtspCam = new Camera({
      serial: 'T8161T0000000011',
      name: 'storage',
      mode: 'rtsp',
    });
    rtspCam.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');
    const p2pCam = new Camera({
      serial: 'T8214T0000000012',
      name: 'doorbell',
      mode: 'backfill',
    });

    const t0 = 500000;
    rtspCam.beginSession('rtsp', t0, false);
    rtspCam.viewUntil = t0 + 20000;
    rtspCam.viewerIds.set('v1', true);
    assert.equal(rtspCam.shouldRewakeRtspOnDrop(t0 + 5000), true);

    rtspCam.pruneDisconnectedViewers(new Set(), 0);
    assert.equal(rtspCam.hasWakingViewer(), false);
    assert.equal(
      rtspCam.shouldRewakeRtspOnDrop(t0 + 10000),
      false,
      'RTSP camera must not re-wake on drop after viewer disconnected'
    );

    p2pCam.beginSession('p2p', t0, false);
    p2pCam.viewUntil = t0 + 20000;
    p2pCam.markP2pVideoPacketReceived(t0 + 2000);
    assert.equal(p2pCam.hasWakingViewer(), false);
    assert.equal(
      p2pCam.evaluateExternalLivestreamStop(t0 + 10000, 3000).action,
      'expired',
      'P2P camera must expire cleanly on stop after viewer disconnected'
    );
    assert.equal(
      p2pCam.evaluateP2pHealth(t0 + 12000, t0 + 2000).action,
      'expired',
      'P2P watchdog must expire cleanly on video stop after viewer disconnected'
    );

    // Verify post-viewer cooldown blocks pure viewer re-wakes, and never blocks wakes when Eufy hardware
    // triggers are active
    p2pCam.endSession(t0 + 12000, true, false, 'p2p');
    assert.equal(p2pCam.isInViewerCooldown(t0 + 13000), true);
    assert.equal(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByOffline: false,
        blockedByBackfill: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: p2pCam.isInViewerCooldown(t0 + 13000),
      }).asked,
      false,
      'AT-09: Post-viewer cooldown must guard pure viewer re-wakes when no hardware trigger is active'
    );
    p2pCam.activeTriggerEvents.add('person');
    p2pCam.lastMotionAt = t0 + 13500;
    p2pCam.motionUntil = t0 + 33500;
    p2pCam.motionClearedAt = 0;
    assert.equal(
      p2pCam.isInViewerCooldown(t0 + 13500),
      false,
      'AT-09: Post-viewer cooldown must be bypassed while an Eufy hardware trigger is active'
    );
    assert.equal(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByOffline: false,
        blockedByBackfill: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: p2pCam.isInViewerCooldown(t0 + 13500),
      }).asked,
      true,
      'AT-09: Viewer wake must proceed immediately during cooldown when an Eufy hardware trigger is active'
    );

    const tStale = t0 + 50000;
    p2pCam.activeTriggerEvents.clear();
    p2pCam.lastMotionAt = tStale;
    p2pCam.motionClearedAt = 0;
    p2pCam.queueEventBackfill(tStale, 'person detected', '', 'person detected', 200, true);
    p2pCam.sleptAt = tStale + 128000;
    assert.equal(
      p2pCam.isInViewerCooldown(tStale + 130000),
      false,
      'AT-09: Unexpired hardware trigger (<= 130s) bypasses post-viewer cooldown'
    );
    assert.equal(
      p2pCam.isInViewerCooldown(tStale + 130001),
      true,
      'AT-09: Stale hardware trigger (> 130s) expires so post-viewer cooldown guards pure viewer wakes again'
    );
    const tDisc = tStale + 200000;
    p2pCam.lastMotionAt = tDisc;
    p2pCam.motionClearedAt = 0;
    p2pCam.queueEventBackfill(tDisc, 'person detected', '', 'person detected', 200, true);
    p2pCam.sleptAt = tDisc - 2000;
    assert.equal(p2pCam.isInViewerCooldown(tDisc), false);
    p2pCam.handleStationDisconnected('ws_closed');
    assert.equal(
      p2pCam.isInViewerCooldown(tDisc),
      true,
      'AT-09: Station/WebSocket disconnect clears hardware triggers and restores post-viewer cooldown'
    );
  });

  it(
    'AT-10: Serializes device.set_property calls on startup, defaults experimental track_stuck_spotlight ' +
      'to false, and detects a stuck spotlight (light=true) via the 1s idle watchdog (>130s after the light ' +
      'turned on or the last session/motion ended, never during a trigger or BackfillJob) when ' +
      'track_stuck_spotlight=true',
    async () => {
      // Verify startup property serialization, default track_stuck_spotlight=false opt-out, and >130s idle
      // spotlight recovery when track_stuck_spotlight=true
      const cam = new Camera({
        serial: 'T8161T0000000013',
        name: 'garage',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });

      let inFlight = 0;
      let maxConcurrent = 0;
      const setOrder = [];
      const bySerial = new Map([[cam.getSerial(), cam]]);
      let wsInstance = null;

      class SerializedWs {
        constructor() {
          this.readyState = 1;
          this.handlers = new Map();
        }
        on(ev, fn) {
          this.handlers.set(ev, fn);
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          if (msg.command === 'device.set_property') {
            inFlight++;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            setOrder.push(msg.name + '=' + msg.value);
            if (cb) cb();
            setTimeout(() => {
              inFlight--;
              this.handlers.get('message')(
                JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
              );
            }, 5);
            return;
          }
          if (cb) cb();
          queueMicrotask(() => {
            this.handlers.get('message')(
              JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
            );
          });
        }
      }

      initOrchestrator([cam], bySerial, () => false);
      configureEufyClientHooks({
        cams: [cam],
        bySerial,
        isShuttingDown: () => false,
        onDeviceOnlineResume: () => {},
        WebSocket: function MockSerializedWs() {
          wsInstance = new SerializedWs();
          return wsInstance;
        },
      });
      connectWs();
      configureEufyClientHooks({isShuttingDown: () => true});
      await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));

      // 1. Startup property sync serializes all set_property calls and never touches light=true
      //    (it may be a live recording light)
      applyDeviceProperties(
        cam,
        {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: false},
          light: {value: true},
          powerWorkingMode: {value: 2},
          recordingClipLength: {value: 60},
          recordingEndClipMotionStops: {value: false},
          recordingRetriggerInterval: {value: 5},
          battery: {value: 85},
        },
        false
      );
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(maxConcurrent, 1, 'device.set_property calls must never run concurrently');
      assert.deepEqual(setOrder, ['recordingClipLength=30', 'recordingEndClipMotionStops=true', 'rtspStream=true']);

      // 2. Experimental stuck-spotlight tracking defaults to false: omitted track_stuck_spotlight never
      //    turns off light=true
      const tEvent = 200000;
      cam.applyTelemetryProperties({light: false}, false, tEvent - 1000);
      cam.applyTelemetryProperties({light: true}, false, tEvent);
      cam.sleptAt = tEvent + 5000;
      cam.motionClearedAt = tEvent + 5000;
      assert.equal(
        cam.shouldTurnOffStuckIdleLight(tEvent + 136000),
        false,
        'AT-10: Default track_stuck_spotlight=false must never send light=false even past 130s idle'
      );

      // 3. When track_stuck_spotlight=true is configured, post-startup stuck spotlight detection runs without
      //    requiring wifiRssi changes:
      //    Before the 130s grace -> false; after >130s while IDLE with no active triggers -> returns true!
      const trackedCam = new Camera({
        serial: 'T8161T0000000093',
        name: 'garage_spotlight',
        mode: 'backfill',
        track_stuck_spotlight: true,
        station_serial: 'T8030P0000000001',
      });
      trackedCam.applyTelemetryProperties({light: false}, false, tEvent - 1000);
      trackedCam.applyTelemetryProperties({light: true}, false, tEvent);
      trackedCam.sleptAt = tEvent + 5000;
      trackedCam.motionClearedAt = tEvent + 5000;
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tEvent + 60000),
        false,
        'AT-10: Must wait the 130s grace (longer than a hardware clip) before turning off spotlight'
      );
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tEvent + 136000),
        true,
        'AT-10: Must detect stuck spotlight after >130s idle without requiring wifiRssi changes when ' +
          'track_stuck_spotlight=true'
      );
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tEvent + 137000),
        false,
        'AT-10: Must not repeatedly fire once stuck spotlight has been turned off'
      );

      // 4. A light that motion has just switched on after a long idle period is never judged
      // stuck (dark clip regression)
      const tLater = tEvent + 500000;
      trackedCam.applyTelemetryProperties({light: true}, false, tLater);
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tLater + 1000),
        false,
        'AT-10: A freshly lit spotlight must not be switched off just because earlier activity was long ago'
      );
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 120000), false);
      trackedCam.queueEventBackfill(tLater, 'motion detected', '', 'motion detected', 10, false);
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tLater + 200000),
        false,
        'AT-10: Must never switch the spotlight off while a BackfillJob is pending'
      );
      trackedCam.clearPendingBackfill();
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 131000), true);
    }
  );

  it(
    'AT-11: Extends active live streams across all modes (including "backfill" cameras streaming Live View ' +
      'or /api/wake) on new triggers, /api/wake, mid-stream stream-started events, and active Frigate/Eufy ' +
      'detections up to configured stream_max_secs',
    async () => {
      const garageBf = new Camera({
        serial: 'T8161T0000000014',
        name: 'garage_bf',
        mode: 'backfill',
        hold_secs: 30,
        stream_max_secs: 90,
        station_serial: 'T8030P0000000001',
      });
      garageBf.rtspSupported = true;
      await setupAcceptanceHarness([garageBf]);

      // Start an active live RTSP stream on the "backfill" camera (e.g. via /api/wake or Live View)
      const t0 = Date.now() - 20000;
      garageBf.beginSession('rtsp', t0, true);
      garageBf.gotVideo = true;
      garageBf.firstFrameAt = t0 + 1000;
      garageBf.firstVideoAt = t0 + 1000;
      garageBf.lastStartAt = t0;
      garageBf.motionUntil = t0 + 30000;

      // 1. Eufy motion/person trigger arriving while the "backfill" camera is ALREADY streaming live
      //    must extend the live hold!
      const holdBeforeTrigger = garageBf.motionUntil;
      onEvent({
        source: 'device',
        event: 'person detected',
        serialNumber: garageBf.getSerial(),
        state: true,
      });
      assert.ok(
        garageBf.motionUntil > holdBeforeTrigger,
        'AT-11: Motion/person trigger arriving while a "backfill" camera is already streaming live must ' +
          'extend the active stream'
      );
      assert.equal(garageBf.eventActive, true);

      // 2. Mid-stream "rtsp livestream started" re-trigger (>5s after lastStartAt) extends the active RTSP stream
      const nowRetrigger = Date.now();
      garageBf.motionUntil = nowRetrigger + 15000;
      garageBf.lastStartAt = nowRetrigger - 10000;
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: garageBf.getSerial(),
      });
      assert.ok(
        garageBf.motionUntil >= nowRetrigger + 30000,
        'AT-11: Mid-stream "rtsp livestream started" must extend the active RTSP hold'
      );

      // 3. POST /api/wake on an already-active stream extends hold, clamped to configured max_secs (90s from startedAt)
      const wakeExt = wakeCameraExternal(garageBf, {
        durationMs: 500000,
        reason: 'extend-api',
        createEvent: true,
      });
      assert.equal(wakeExt.status, 'extended');
      assert.equal(
        garageBf.motionUntil,
        garageBf.startedAt + 90000,
        'AT-11: Hold extensions must clamp to the camera configured max_secs (90s)'
      );
      stop(garageBf, 'test stop', false, 'bridge-test');
      if (garageBf.evTimer) {
        clearTimeout(garageBf.evTimer);
        garageBf.evTimer = null;
      }
    }
  );

  it(
    'AT-12: Re-wakes mid-session hardware stream cutoffs when end_early=false, sleeps cleanly when ' +
      'end_early=true or after hold_secs, and enforces stream_max_secs, view_max_secs, and idle_timeout_secs',
    () => {
      const fullHoldCam = new Camera({
        serial: 'T8161T0000000015',
        name: 'driveway',
        mode: 'rtsp',
        hold_secs: 60,
        stream_max_secs: 120,
        end_early: false,
      });
      fullHoldCam.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');
      const earlyEndCam = new Camera({
        serial: 'T8161T0000000016',
        name: 'porch',
        mode: 'custom',
        hold_secs: 60,
        idle_timeout_secs: 15,
        end_early: true,
      });

      const t0 = 1000000;
      fullHoldCam.beginSession('rtsp', t0, true);
      fullHoldCam.gotVideo = true;
      fullHoldCam.firstVideoAt = t0 + 1000;
      fullHoldCam.lastMotionAt = t0;
      fullHoldCam.motionUntil = t0 + 60000;
      fullHoldCam.recordMotionCleared(t0 + 10000, 5000, 10000, 'motion detected');

      // Hardware cuts off RTSP at 35s (before 60s hold_secs) -> must re-wake!
      assert.equal(fullHoldCam.shouldRewakeRtspOnDrop(t0 + 35000), true);
      // Once 60s hold_secs has elapsed since lastMotionAt and no triggers/objects are active -> sleeps cleanly!
      fullHoldCam.motionUntil = t0 + 90000;
      assert.equal(fullHoldCam.shouldRewakeRtspOnDrop(t0 + 65000), false);
      assert.equal(fullHoldCam.hasReachedMaxDuration(t0 + 119999), false);
      assert.equal(
        fullHoldCam.hasReachedMaxDuration(t0 + 120000),
        true,
        'AT-12: Live session reaches stream_max_secs (120s) hard cap at 120000ms'
      );

      // STREAM_MODES.DOWNLOAD backfill playback must never be cut off by stream_max_secs or view_max_secs
      const backfillCapCam = new Camera({
        serial: 'T8214T0000000097',
        name: 'backfill_cap_check',
        mode: 'backfill',
        hold_secs: 30,
        stream_max_secs: 60,
        view_max_secs: 45,
      });
      backfillCapCam.beginBackfillDownload(
        {
          storagePath: '/zx/long_120s.zxvideo',
          cipherId: 1,
          clipMs: t0 - 120000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0
      );
      assert.equal(
        backfillCapCam.hasReachedMaxDuration(t0 + 115000),
        false,
        'AT-12: stream_max_secs (60s) must never truncate active STREAM_MODES.DOWNLOAD playback at 115s'
      );
      assert.equal(backfillCapCam.expireMaxDurationHold(t0 + 115000), '');
      assert.equal(backfillCapCam.hasReachedViewMaxDuration(t0 + 115000), false);
      backfillCapCam.endSession(t0 + 120000, true, false, 'download');

      // When end_early=true: motion clearing after >=10s video shortens motionUntil to now + 5s
      // and marks clean Eufy end
      earlyEndCam.beginSession('p2p', t0, true);
      earlyEndCam.gotVideo = true;
      earlyEndCam.eventActive = true;
      earlyEndCam.firstVideoAt = t0 + 1000;
      earlyEndCam.lastMotionAt = t0;
      earlyEndCam.motionUntil = t0 + 60000;
      assert.equal(earlyEndCam.recordMotionCleared(t0 + 15000, 5000, 10000), 5);
      assert.equal(earlyEndCam.motionUntil, t0 + 20000);
      assert.equal(earlyEndCam.didEufyEndEventCleanly(t0 + 16000, 8000), true);

      // Idle scene early-sleep (idle_timeout_secs = 15s) triggers once >=15s of video has streamed and scene is quiet
      assert.equal(earlyEndCam.canSleepEarlyOnIdle(t0 + 8000, 10000), false);
      assert.deepEqual(earlyEndCam.checkEarlySleepDue(t0 + 10000, 3000, 4000), {
        due: false,
        clearedByEufy: false,
      });
      assert.equal(earlyEndCam.canSleepEarlyOnIdle(t0 + 17000, 10000), true);
      assert.deepEqual(earlyEndCam.checkEarlySleepDue(t0 + 19500, 3000, 4000), {
        due: true,
        clearedByEufy: true,
      });

      // 5. Direct rtsp_url camera bypasses all session hold, max duration, viewer linger, viewer cooldown,
      //    Frigate hold poll, and idle_timeout_secs timeouts so active streams flow continuously
      const directCam = new Camera({
        name: 'baby_cam_timeout_check',
        mode: 'rtsp',
        rtsp_url: 'rtsp://127.0.0.1:8554/baby_cam',
        hold_secs: 10,
        stream_max_secs: 20,
        view_linger_secs: 5,
        view_max_secs: 15,
        idle_timeout_secs: 10,
      });
      directCam.beginSession('rtsp', t0, false);
      directCam.gotVideo = true;
      directCam.firstVideoAt = t0 + 500;
      directCam.lastVideoAt = t0 + 100000;
      directCam.motionUntil = t0 + 10000;
      directCam.viewUntil = t0 + 5000;
      directCam.sleptAt = t0 - 1000;
      assert.equal(directCam.hasExpiredLiveHold(t0 + 100000), false);
      assert.equal(directCam.hasReachedMaxDuration(t0 + 100000), false);
      assert.equal(directCam.hasReachedViewMaxDuration(t0 + 100000), false);
      assert.equal(directCam.canSleepEarlyOnIdle(t0 + 100000, 10000), false);
      assert.deepEqual(directCam.checkEarlySleepDue(t0 + 100000, 3000, 4000), {
        due: false,
        clearedByEufy: false,
      });
      assert.equal(directCam.shouldPollFrigateForHoldOrBackfill(t0 + 9000, 12000).shouldPoll, false);
      assert.equal(directCam.isInViewerCooldown(t0), false);
    }
  );

  it(
    'AT-13: Enforces per-station P2P priority preemption, backfills preempted event streams even if >= 20% ' +
      'of hold was streamed live, and switches back-to-back same-station P2P sessions without pacing delay',
    async () => {
      const lowCam = new Camera({
        serial: 'T8214T0000000017',
        name: 'side_gate',
        mode: 'p2p',
        priority: 50,
        hold_secs: 60,
        station_serial: 'T8030P0000000001',
      });
      const equalCam = new Camera({
        serial: 'T8214T0000000018',
        name: 'back_gate',
        mode: 'p2p',
        priority: 50,
        hold_secs: 60,
        station_serial: 'T8030P0000000001',
      });
      const highDoorbell = new Camera({
        serial: 'T8214T0000000019',
        name: 'front_doorbell',
        mode: 'p2p',
        priority: 100,
        hold_secs: 60,
        station_serial: 'T8030P0000000001',
      });

      const t0 = 500000;
      // 1. lowCam triggers on person (50 + 200 = 250) and streams live for 20s (>= 20% of 60s = 12s),
      //    which cancels its safety-net pendingBackfill during normal streaming
      lowCam.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
      lowCam.applyMotionTrigger(t0, 'person detected', 60000, 'eufy-event', 200);
      lowCam.beginSession('p2p', t0, true);
      lowCam.markP2pVideoPacketReceived(t0 + 1000);
      const frameBuf = Buffer.alloc(1382400, 0x40);
      lowCam.recordDecodedFrame(frameBuf, frameBuf, t0 + 1000, '12:00');
      lowCam.recordDecodedFrame(frameBuf, frameBuf, t0 + 20000, '12:00');
      assert.equal(
        lowCam.pendingBackfill,
        null,
        'Safety-net BackfillJob is cleared once >= 20% (12s) of live video is decoded'
      );

      // 2. Equal-priority newer event (50 + 200 = 250) preempts when preempt_event_streams=true
      equalCam.applyMotionTrigger(t0 + 21000, 'person detected', 60000, 'eufy-event', 200);
      assert.equal(equalCam.canPreempt(lowCam, t0 + 21000, 8000, true), true);
      assert.equal(equalCam.canPreempt(lowCam, t0 + 21000, 8000, false), false);

      // 3. Higher-priority doorbell ring (100 + 1000 = 1100) preempts lowCam at t0 + 22s while lowCam's event
      //    is still active:
      //    lowCam MUST re-queue its BackfillJob on preemption even though it already streamed 20s (>= 20%)!
      highDoorbell.applyMotionTrigger(t0 + 22000, 'rings', 60000, 'eufy-event', 1000);
      assert.equal(highDoorbell.canPreempt(lowCam, t0 + 22000, 8000, false), true);
      const preemptInitiator = highDoorbell.resolvePreemptInitiator(lowCam, t0 + 22000);
      assert.equal(preemptInitiator, 'bridge-arbitrator/higher-priority-event');

      lowCam.terminateSession(t0 + 22000, 'preempted by higher-priority camera front_doorbell', true, preemptInitiator);
      assert.equal(
        lowCam.hasPendingBackfill(),
        true,
        'AT-13: Preempted event-driven P2P stream must retain/re-queue BackfillJob even after streaming >= 20% live'
      );
      assert.equal(lowCam.pendingBackfill.event, 'person detected');

      // 4. Active Backfill download ('download') is protected from viewer-only preemption,
      //    and once downloadFinished=true (draining from RAM), releases the HomeBase P2P slot (usesP2pSlot() === false)
      lowCam.beginBackfillDownload(
        {
          storagePath: '/zx/lowcam_clip.zxvideo',
          cipherId: 1,
          clipMs: t0,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0 + 30000
      );
      assert.equal(
        lowCam.isOccupyingStationP2pChannel(),
        true,
        'AT-13: In-transfer backfill download occupies station P2P channel'
      );
      const viewerCandidate = new Camera({
        serial: 'T8214T0000000099',
        name: 'viewer_only_cam',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });
      viewerCandidate.viewUntil = t0 + 50000;
      assert.equal(
        lowCam.isUrgentBackfillProtectedFrom(viewerCandidate, t0 + 31000),
        true,
        'AT-13: Active backfill download must be protected from viewer-only preemption'
      );
      assert.equal(
        lowCam.isUrgentBackfillProtectedFrom(highDoorbell, t0 + 31000),
        false,
        'AT-13: Motion/event wake can still preempt an in-transfer backfill download'
      );
      const siblingBfCam = new Camera({
        serial: 'T8214T0000000098',
        name: 'sibling_backfill_cam',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      siblingBfCam.queueEventBackfill(t0 + 10000, 'person detected', '', 'person detected', 200, true);
      siblingBfCam.recordMotionCleared(t0 + 15000, 4000, 10000, 'person detected');
      assert.equal(
        siblingBfCam.canQueryBackfillNow([lowCam, siblingBfCam], t0 + 31000, 4000, 12000, 2000),
        false,
        'AT-13: Sibling HomeBase backfill query must wait while lowCam is actively transferring over P2P'
      );
      lowCam.markP2pVideoPacketReceived(t0 + 31500);
      lowCam.recordDecodedFrame(frameBuf, frameBuf, t0 + 31500, '12:01');
      lowCam.bufferDownloadFrame(frameBuf, 1800);
      lowCam.markDownloadFinished(t0 + 32000);
      assert.equal(lowCam.sessionState, 'draining_backfill_tail');
      assert.equal(
        lowCam.isOccupyingStationP2pChannel(),
        false,
        'AT-13: Once HomeBase clip transfer finishes (downloadFinished=true, draining from RAM), station P2P ' +
          'channel is released'
      );
      assert.equal(
        siblingBfCam.canQueryBackfillNow([lowCam, siblingBfCam], t0 + 32500, 4000, 12000, 2000),
        true,
        'AT-13: Sibling camera on same HomeBase can query backfill while lowCam drains buffered frames in RAM'
      );
      assert.equal(
        siblingBfCam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000098',
          storagePath: '/zx/sibling_clip.zxvideo',
          cipherId: 2,
          clipMs: t0 + 11000,
        }),
        true
      );
      assert.equal(
        siblingBfCam.canStartBackfillDownloadNow([lowCam, siblingBfCam], t0 + 32600, 2000),
        true,
        'AT-13: Sibling camera on same HomeBase can start backfill download while lowCam drains tail frames in RAM'
      );
      lowCam.endSession(t0 + 33000, true, false, 'download');

      // 5. Verify back-to-back same-station P2P switching starts immediately after a session ends,
      //    while consecutive START commands without an intervening stop remain paced by 2500ms
      const switchCamA = new Camera({
        serial: 'T8214T0000000117',
        name: 'switch_gate',
        mode: 'p2p',
        priority: 10,
        station_serial: 'T8030P0000000099',
      });
      const switchCamB = new Camera({
        serial: 'T8214T0000000118',
        name: 'switch_drive',
        mode: 'p2p',
        priority: 100,
        station_serial: 'T8030P0000000099',
      });
      const switchCamC = new Camera({
        serial: 'T8214T0000000119',
        name: 'switch_yard',
        mode: 'p2p',
        priority: 5,
        station_serial: 'T8030P0000000099',
      });
      await setupAcceptanceHarness([switchCamA, switchCamB, switchCamC]);
      try {
        const wakeReqA = WakeRequest.motion('gate motion', 30000)
          .withInitiator('api-wake')
          .withCreateEvent(true)
          .build();
        const wakeReqB = WakeRequest.motion('drive motion', 30000)
          .withInitiator('api-wake')
          .withCreateEvent(true)
          .build();
        const wakeReqC = WakeRequest.motion('yard motion', 30000)
          .withInitiator('api-wake')
          .withCreateEvent(true)
          .build();

        const firstWake = wakeCameraExternal(switchCamA, wakeReqA);
        assert.equal(firstWake.status, 'waking');
        assert.equal(firstWake.delay_ms, 0);

        const consecutiveWake = wakeCameraExternal(switchCamB, wakeReqB);
        assert.equal(
          consecutiveWake.status,
          'scheduled',
          'AT-13: Consecutive /api/wake without an intervening session end must be paced by 2500ms'
        );
        assert.ok(consecutiveWake.delay_ms > 0);
        switchCamB.clearApiWakeTimer();

        stop(switchCamA, 'session ended', false, 'bridge-timer');
        switchCamA.clearP2pStopInFlight();

        const backToBackWake = wakeCameraExternal(switchCamB, wakeReqB);
        assert.equal(
          backToBackWake.status,
          'waking',
          'AT-13: Waiting/next camera after same-station P2P session end must switch immediately'
        );
        assert.equal(backToBackWake.delay_ms, 0);

        // Preempting start command (after initial pacing window expired) must still pace a subsequent /api/wake
        stop(switchCamB, 'reset', false, 'bridge-timer');
        switchCamB.clearP2pStopInFlight();
        await setupAcceptanceHarness([switchCamA, switchCamB, switchCamC]);
        switchCamA.beginSession('p2p', Date.now() - 10000, true);
        switchCamA.motionUntil = Date.now() + 20000;
        trigger(switchCamB, 'driveway person', 30000, 'motion', 'eufy-event', 200);
        assert.equal(switchCamB.isSessionActive(), true);
        const wakeAfterPreempt = wakeCameraExternal(switchCamC, wakeReqC);
        assert.equal(
          wakeAfterPreempt.status,
          'scheduled',
          'AT-13: Fresh preemption START command must still pace subsequent external /api/wake'
        );
        assert.ok(wakeAfterPreempt.delay_ms > 0);

        // Verify same-camera Eufy triggers during STREAM_MODES.DOWNLOAD never self-preempt Event 1
        switchCamC.clearApiWakeTimer();
        stop(switchCamB, 'reset before same-cam download check', false, 'bridge-timer');
        switchCamB.clearP2pStopInFlight();
        const tDl = Date.now();
        switchCamA.reason = 'clip1 motion';
        switchCamA.beginBackfillDownload(
          {
            storagePath: '/zx/camA_ev1.zxvideo',
            cipherId: 11,
            clipMs: tDl - 20000,
            event: 'motion detected',
            personName: '',
            reason: 'clip1 motion',
          },
          false,
          tDl
        );
        onEvent({
          source: 'device',
          event: 'person detected',
          serialNumber: switchCamA.getSerial(),
          state: true,
        });
        assert.equal(
          switchCamA.activeMode,
          'download',
          'AT-13: Same-camera motion must never self-preempt an active backfill download'
        );
        assert.equal(
          switchCamA.getReason(),
          'backfill: clip1 motion',
          'AT-13: Same-camera motion during backfill download must keep Event 1 reason intact'
        );
        assert.equal(
          switchCamA.hasPendingBackfill(),
          true,
          'AT-13: Same-camera motion during backfill download queues Event 2 BackfillJob behind Event 1'
        );
        switchCamA.clearPendingBackfill();
      } finally {
        switchCamB.clearApiWakeTimer();
        switchCamC.clearApiWakeTimer();
        stop(switchCamA, 'cleanup', false, 'bridge-test');
        stop(switchCamB, 'cleanup', false, 'bridge-test');
        stop(switchCamC, 'cleanup', false, 'bridge-test');
        configureEufyClientHooks({isShuttingDown: () => true});
      }
    }
  );

  it(
    'AT-14: Ignores multi-camera dashboard grids on battery/HomeBase cameras while keeping direct rtsp_url ' +
      'streams active, only stops another Live View camera on the same HomeBase when BOTH use the P2P slot, ' +
      'and enforces all 5 viewer blocks',
    async () => {
      const rtspCam1 = new Camera({
        serial: 'T8161T0000000020',
        name: 'storage',
        mode: 'rtsp',
        station_serial: 'T8030P0000000001',
      });
      rtspCam1.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');
      const rtspCam2 = new Camera({
        serial: 'T8161T0000000021',
        name: 'garage',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      rtspCam2.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live1');
      const p2pCam1 = new Camera({
        serial: 'T8214T0000000022',
        name: 'doorbell_1',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      const p2pCam2 = new Camera({
        serial: 'T8214T0000000023',
        name: 'doorbell_2',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });

      const t0 = 800000;
      rtspCam1.beginSession('rtsp', t0, false);
      rtspCam1.viewUntil = t0 + 20000;
      p2pCam1.beginSession('p2p', t0, false);
      p2pCam1.viewUntil = t0 + 20000;

      // 1. RTSP Live View never yields to another RTSP or P2P Live View (even during 0-viewer linger),
      //    and P2P Live View never yields to an RTSP Live View! Only P2P <-> P2P yields!
      assert.equal(
        rtspCam1.shouldYieldToNewStationViewer(rtspCam2, t0 + 5000),
        false,
        'AT-14: RTSP Live View must stay open in parallel when another RTSP camera opens Live View'
      );
      assert.equal(
        rtspCam1.shouldYieldToNewStationViewer(p2pCam1, t0 + 5000),
        false,
        'AT-14: RTSP Live View must stay open in parallel when a P2P camera opens Live View'
      );
      assert.equal(
        p2pCam1.shouldYieldToNewStationViewer(rtspCam2, t0 + 5000),
        false,
        'AT-14: P2P Live View must not stop when an RTSP camera opens Live View'
      );
      assert.equal(
        p2pCam1.shouldYieldToNewStationViewer(p2pCam2, t0 + 5000),
        true,
        'AT-14: P2P Live View must yield when a second P2P camera on the same HomeBase opens Live View'
      );
      p2pCam1.beginSession('download', t0 + 6000, true);
      assert.equal(
        p2pCam1.shouldYieldToNewStationViewer(p2pCam2, t0 + 7000),
        false,
        'AT-14: Active backfill download/playback must never yield to a viewer on another camera'
      );

      // 2. Dashboard grid ignore + 4 viewer blocks (offline, eco, cooldown, P2P motion)
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: false,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByOffline: true,
          offlineReason: 'device offline',
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 0,
          inCooldown: false,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: true,
          batteryPct: 15,
          inCooldown: false,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: true,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByP2pMotion: true,
          activeMotionCamName: 'doorbell_1',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: false,
        }).asked,
        false
      );
      assert.deepEqual(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByBackfill: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: false,
        }),
        {asked: false, actionDesc: 'ignored, waiting for HomeBase clip backfill'}
      );

      // 3. Direct rtsp_url cameras are never ignored or logged as dashboard grid: they connect immediately when IDLE
      //    (keeping sleeping card until Frame 0 decodes) while sleeping battery cameras in the same grid stay asleep,
      //    and report 'streaming direct RTSP' when already active.
      assert.deepEqual(
        classifyViewerAction({
          rtspDirect: true,
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: null,
          inCooldown: false,
        }),
        {asked: true, actionDesc: 'connecting direct RTSP stream'}
      );
      assert.deepEqual(
        classifyViewerAction({
          rtspDirect: true,
          camActive: true,
          alreadyViewing: false,
          isDashboardGrid: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: null,
          inCooldown: false,
        }),
        {asked: false, actionDesc: 'streaming direct RTSP'}
      );

      const directGridCam = new Camera(
        {
          name: 'nursery_direct',
          rtsp_url: 'rtsp://127.0.0.1:8554/nursery_direct',
        },
        {frame: Buffer.alloc(1382400, 0x34), lastSeen: '12:15'},
        renderCameraCards
      );
      const gridBatteryCam = new Camera({
        serial: 'T8214T0000000094',
        name: 'porch_grid_cam',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });
      const origFetch = global.fetch;
      initOrchestrator(
        [gridBatteryCam, directGridCam],
        new Map([[gridBatteryCam.getSerial(), gridBatteryCam]]),
        () => false
      );
      try {
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes('src=porch_grid_cam')) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {consumers: [{id: 'grid-v1', user_agent: 'Mozilla/5.0', format_name: 'mse'}]};
              },
            };
          }
          if (u.includes('src=nursery_direct')) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {consumers: [{id: 'grid-v2', user_agent: 'Mozilla/5.0', format_name: 'mse'}]};
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {consumers: []};
            },
          };
        };
        await pollViewers([gridBatteryCam, directGridCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: async () => {},
          stopCam: stop,
          triggerCam: trigger,
        });
        assert.equal(
          gridBatteryCam.sessionState,
          'idle',
          'AT-14: Sleeping battery camera in a mixed multi-camera grid must remain idle'
        );
        assert.equal(
          directGridCam.sessionState,
          'waking_rtsp',
          'AT-14: Idle direct rtsp_url camera in a multi-camera grid must immediately start pulling RTSP'
        );
        assert.equal(directGridCam.wakeInitiator, 'viewer');
        assert.equal(
          selectEncoderFrame(directGridCam, Date.now()).frame,
          directGridCam.card.asleep,
          'AT-14: Direct rtsp_url camera woken by viewer must keep sleeping card until Frame 0 decodes'
        );
      } finally {
        global.fetch = origFetch;
        stop(directGridCam, 'cleanup', false, 'rtsp-direct-probe');
        stop(gridBatteryCam, 'cleanup', false, 'bridge-test');
      }
    }
  );

  it(
    'AT-15: Derives safety-net Backfill cancellation cutoff as 20% of configured clip/hold duration ' +
      '(clamped to 3s..15s) and caps Backfill recording wait at Eufy 120s max hardware clip limit (+4s) ' +
      'from initial trigger',
    () => {
      const cam20s = new Camera({serial: 'T8161T0000000024', mode: 'custom', hold_secs: 20, end_early: true});
      const cam30s = new Camera({serial: 'T8161T0000000025', mode: 'custom', hold_secs: 30, end_early: true});
      const cam60s = new Camera({serial: 'T8161T0000000026', mode: 'rtsp', hold_secs: 60});
      const cam120s = new Camera({serial: 'T8161T0000000027', mode: 'rtsp', hold_secs: 120});

      // 1. Proportional 20% cutoff clamped to [3s..15s]
      assert.equal(cam20s.getSustainedLiveVideoCutoffMs(), 4000, '20% of 20s clip = 4s (< 5s)');
      assert.equal(cam30s.getSustainedLiveVideoCutoffMs(), 6000, '20% of 30s clip = 6s');
      assert.equal(cam60s.getSustainedLiveVideoCutoffMs(), 12000, '20% of 60s clip = 12s');
      assert.equal(cam120s.getSustainedLiveVideoCutoffMs(), 15000, '20% of 120s clip clamped to 15s max');

      const t0 = 1000000;
      const frameBuf = Buffer.alloc(1382400, 0x33);
      cam60s.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
      cam60s.beginSession('rtsp', t0, true);
      cam60s.recordDecodedFrame(frameBuf, frameBuf, t0 + 1000, '12:00');
      // At 6s of video (< 12s cutoff for a 60s camera), safety-net pendingBackfill MUST remain intact!
      cam60s.recordDecodedFrame(frameBuf, frameBuf, t0 + 7000, '12:00');
      assert.equal(
        cam60s.hasPendingBackfill(),
        true,
        'AT-15: 60s camera must NOT cancel safety-net Backfill after only 6s of video (< 12s 20% cutoff)'
      );
      // At 12s of video (>= 12s 20% cutoff), safety-net pendingBackfill is canceled
      cam60s.recordDecodedFrame(frameBuf, frameBuf, t0 + 13000, '12:00');
      assert.equal(
        cam60s.hasPendingBackfill(),
        false,
        'AT-15: 60s camera cancels safety-net Backfill once 12s (20%) of live video is decoded'
      );

      // 2. BackfillJob waits for state=false + 4s settle, or hold_secs + 4s after last trigger,
      //    hard-capped at 120s + 4s (124s) from initial trigger (this.at) when continuous triggers fire
      const job = new BackfillJob({
        at: t0,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
        priority: 10,
      });
      // Simulate continuous re-triggers every 20s up to t0 + 115s without state=false
      for (let offset = 20000; offset <= 115000; offset += 20000) {
        job.upgradeEvent({
          at: t0 + offset,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
          priority: 200,
        });
      }
      assert.equal(
        job.isReadyToQuery(t0 + 120000, 34000),
        false,
        'Still waiting while active triggers fired within 34s and total elapsed < 124s'
      );
      assert.equal(
        job.isReadyToQuery(t0 + 124000, 34000),
        true,
        'AT-15: Hard 120s + 4s Eufy max hardware clip cap from initial trigger (this.at) forces query so ' +
          'continuous motion never delays Clip 1 indefinitely'
      );
      assert.equal(job.isExpired(t0 + 100000 + 300000), false);
      assert.equal(job.isExpired(t0 + 100000 + 300001), true);

      const clearJob = new BackfillJob({
        at: t0,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
        priority: 10,
      });
      clearJob.markRecordingCleared(t0 + 5000);
      assert.equal(clearJob.isReadyToQuery(t0 + 8999, 34000), false);
      assert.equal(clearJob.isReadyToQuery(t0 + 9000, 34000), true);

      // 3. Default 2s (2000ms) station P2P slot idle delay, 35s minimum fallback, and back-to-back job isolation
      const builtCfg = new BridgeConfigBuilder({
        cameras: [{serial: 'T8214T0000000099', name: 'doorbell'}],
      }).build();
      assert.equal(builtCfg.backfillDelayMs, 2000, 'AT-15: Default backfill_delay_secs is 2s (2000ms)');

      const bfCam = new Camera({
        serial: 'T8214T0000000091',
        name: 'bf_cam',
        mode: 'backfill',
        hold_secs: 20,
        station_serial: 'T8030P0000000015',
      });
      const p2pSibling = new Camera({
        serial: 'T8214T0000000092',
        name: 'p2p_sib',
        mode: 'p2p',
        station_serial: 'T8030P0000000015',
      });
      bfCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(
        bfCam.canQueryBackfill(t0 + 34999, 4000, 12000),
        false,
        'AT-15: Missing state=false fallback honors 35s minimum wait when hold_secs + 4s < 35s'
      );
      assert.equal(bfCam.canQueryBackfill(t0 + 35000, 4000, 12000), true);

      p2pSibling.sleptAt = t0 + 34000;
      assert.equal(
        bfCam.canQueryBackfillNow([bfCam, p2pSibling], t0 + 35999, 4000, 12000, 2000),
        false,
        'AT-15: Waits 2s (2000ms) after sibling P2P stream sleeps before querying HomeBase'
      );
      assert.equal(bfCam.canQueryBackfillNow([bfCam, p2pSibling], t0 + 36000, 4000, 12000, 2000), true);

      // Settled Job 1 stays queryable when a back-to-back state=true trigger arrives for Job 2
      const b2bCam = new Camera({
        serial: 'T8214T0000000093',
        name: 'b2b_cam',
        mode: 'backfill',
        station_serial: 'T8030P0000000015',
      });
      b2bCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      b2bCam.recordMotionCleared(t0 + 3000, 4000, 10000);
      assert.equal(b2bCam.canQueryBackfill(t0 + 7000, 4000, 12000), true);
      b2bCam.queueEventBackfill(t0 + 8000, 'person detected', '', 'person detected', 200, true);
      assert.equal(
        b2bCam.canQueryBackfill(t0 + 8000, 4000, 12000),
        true,
        'AT-15: Settled BackfillJob must remain queryable when a back-to-back state=true trigger arrives'
      );
      assert.equal(b2bCam.pendingBackfill?.at, t0);
      assert.equal(b2bCam.queuedBackfillJob?.at, t0 + 8000);
    }
  );

  it(
    'AT-16: Streams Backfill clips chronologically from Frame 0 at 15 fps with audio lockstep, 30/10 frame ' +
      'backpressure watermarks, EOF flush, and 2.5s final hold (0s across back-to-back clips)',
    () => {
      const cam = new Camera(
        {serial: 'T8214T0000000028', name: 'doorbell', mode: 'backfill'},
        {frame: Buffer.alloc(1382400, 0x10), lastSeen: '12:00'},
        renderCameraCards
      );
      const encodedFirstBytes = [];
      cam.attachEncoder(
        {
          stdin: {
            writable: true,
            writableNeedDrain: false,
            write(buf) {
              encodedFirstBytes.push(buf[0]);
            },
          },
        },
        1000
      );

      const t0 = 50000;
      cam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      cam.queueEventBackfill(
        t0 + 2000,
        'identity person detected',
        'Alice',
        'identity person detected (Alice)',
        300,
        true
      );
      assert.equal(cam.pendingBackfill.personName, 'Alice');
      assert.equal(
        cam.canMatchDatabaseQueryResult(t0 + 2500, 4000),
        false,
        'AT-16: Camera actively recording must ignore station-wide database query rows before settle/timeout'
      );
      cam.recordMotionCleared(t0 + 5000, 4000, 10000);
      assert.equal(cam.canQueryBackfill(t0 + 10000, 8000, 12000), true);
      assert.equal(cam.canMatchDatabaseQueryResult(t0 + 10000, 4000), true);
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/missing-ts.zxvideo',
          cipherId: 99,
          clipMs: 0,
        }),
        false,
        'AT-16: Normal BackfillJob must reject timestamp-less database candidates (clipMs <= 0)'
      );

      // Match two clips out of order -> sorted chronologically (oldest -> newest)
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 2,
        clipMs: t0 + 20000,
      });
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip1.zxvideo',
        cipherId: 1,
        clipMs: t0 + 1000,
      });
      assert.equal(cam.backfillClip.storagePath, '/zx/clip1.zxvideo');

      cam.beginBackfillDownload(cam.backfillClip, false, t0 + 30000);
      let paused = 0;
      let resumed = 0;
      let stdinEnded = false;
      cam.attachDecoder({
        stdin: {
          writable: true,
          writableNeedDrain: false,
          write() {},
          end() {
            stdinEnded = true;
          },
        },
        stdout: {
          pause() {
            paused++;
          },
          resume() {
            resumed++;
          },
        },
        stdio: [null, null, null, {writable: true, writableNeedDrain: false, write() {}, end() {}}],
      });

      // Decode Frame 0 (0x90) + 30 frames (0x91..) to hit the 30-frame high watermark
      const scratch = Buffer.alloc(1382400, 0x90);
      cam.markP2pVideoPacketReceived(t0 + 30100);
      handleDecodedP2pFrame(cam, scratch, t0 + 30100);
      assert.equal(cam.getFrameMarker(), 'FB');
      for (let i = 1; i <= 30; i++) {
        scratch.fill(0x90 + (i % 50));
        handleDecodedP2pFrame(cam, scratch, t0 + 30100 + i);
      }
      assert.equal(paused, 1, 'Pauses decoder stdout at 30 buffered frames');

      // Drain down to the 10-frame low watermark at 15 fps
      let tTick = t0 + 30100;
      while (cam.downloadFrames.length > 10) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      assert.equal(resumed, 1, 'Resumes decoder stdout at 10 buffered frames');
      assert.equal(cam.getFrameMarker(), 'B');

      // Drain remaining frames and flush EOF; because clip2 is queued in backfillClipQueue, skips 2.5s
      // post-playback hold!
      while (cam.downloadFrames.length > 0) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      flushDecoderInput(cam);
      assert.equal(stdinEnded, true);
      cam.markDownloadFinished(tTick);
      // Live P2P events ('livestream stopped', etc.), /api/wake, and hardware 'rtsp livestream started' during
      // 'download' must never stop backfill playback
      const stopEval = cam.evaluateExternalLivestreamStop(tTick + 50, 3000);
      assert.equal(
        stopEval.action,
        'inactive',
        'AT-16: External livestream stopped must be ignored during backfill playback'
      );
      assert.equal(
        cam.p2pReady,
        true,
        'AT-16: External livestream stopped must not clear p2pReady during backfill playback'
      );
      assert.equal(
        cam.shouldBackfillOnlyOnApiWake(),
        true,
        'AT-16: /api/wake during active backfill playback stays in backfill mode'
      );
      assert.equal(
        cam.evaluateUnexpectedRtspStart().shouldStopRtsp,
        false,
        'AT-16: Hardware RTSP start during active backfill playback must not stop RTSP'
      );
      cam.detachDecoder();
      assert.equal(
        cam.isDownloadComplete(tTick + 100, 3000, 2500, 0),
        true,
        'AT-16: Skips 2.5s post-playback hold when Clip 2 is queued next'
      );
      cam.endSession(tTick + 100, true, false, 'download');

      // Clip 2 download failure/0-frame timeout re-queues the clip up to 3 attempts with a 4s retry cooldown
      assert.equal(cam.backfillClip.storagePath, '/zx/clip2.zxvideo');
      cam.beginBackfillDownload(cam.backfillClip, false, tTick + 200);
      // Attempt 1 fails with hadVideo=false -> re-queued at front of backfillClipQueue with 4s cooldown
      cam.endSession(tTick + 300, false, false, 'download');
      assert.equal(cam.downloadedPaths.has('/zx/clip2.zxvideo'), false);
      assert.equal(cam.backfillClip?.storagePath, '/zx/clip2.zxvideo');
      assert.equal(cam.hasPendingBackfill(), true);
      assert.equal(
        cam.isReadyForBackfillDownload(tTick + 2000),
        false,
        'AT-16: Waits for 4s cooldown before retrying failed download'
      );
      assert.equal(
        cam.isReadyForBackfillDownload(tTick + 4300),
        true,
        'AT-16: Ready to retry failed download after 4s cooldown'
      );

      // Attempt 2 fails with hadVideo=false -> re-queued again
      cam.beginBackfillDownload(cam.backfillClip, false, tTick + 4300);
      cam.endSession(tTick + 4400, false, false, 'download');
      assert.equal(cam.backfillClip?.storagePath, '/zx/clip2.zxvideo');

      // Attempt 3 fails with hadVideo=false -> gives up after 3 attempts
      cam.beginBackfillDownload(cam.backfillClip, false, tTick + 8500);
      cam.endSession(tTick + 8600, false, false, 'download');
      assert.equal(cam.backfillClip, null, 'AT-16: Gives up on backfill clip after 3 failed download attempts');

      // A transfer cut after Frame 0 (station disconnect, preemption, cancel) is interrupted, not complete: the clip is
      // re-queued and replayed from Frame 0 within the same 3 attempt budget and 4s cooldown
      const t3 = tTick + 20000;
      cam.queueEventBackfill(t3, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t3 + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip3.zxvideo',
        cipherId: 3,
        clipMs: t3 + 1000,
      });
      assert.equal(cam.backfillClip?.storagePath, '/zx/clip3.zxvideo');

      cam.beginBackfillDownload(cam.backfillClip, false, t3 + 10000);
      cam.markP2pVideoPacketReceived(t3 + 10100);
      handleDecodedP2pFrame(cam, scratch, t3 + 10100);
      cam.terminateSession(t3 + 10200, 'Station P2P disconnected/restarting', false, 'error/station-disconnect');
      assert.equal(
        cam.downloadedPaths.has('/zx/clip3.zxvideo'),
        false,
        'AT-16: Interrupted transfer after Frame 0 is not marked downloaded'
      );
      assert.equal(
        cam.backfillClip?.storagePath,
        '/zx/clip3.zxvideo',
        'AT-16: Interrupted transfer after Frame 0 re-queues the clip'
      );
      assert.equal(cam.hasPendingBackfill(), true);
      assert.equal(
        cam.isReadyForBackfillDownload(t3 + 12000),
        false,
        'AT-16: Waits for 4s cooldown before retrying an interrupted transfer'
      );
      assert.equal(cam.isReadyForBackfillDownload(t3 + 14300), true);

      // An interruption on every attempt gives up after 3 attempts like a failed start
      cam.beginBackfillDownload(cam.backfillClip, false, t3 + 14300);
      cam.markP2pVideoPacketReceived(t3 + 14400);
      handleDecodedP2pFrame(cam, scratch, t3 + 14400);
      cam.terminateSession(t3 + 14500, 'Station P2P disconnected/restarting', false, 'error/station-disconnect');
      assert.equal(cam.backfillClip?.storagePath, '/zx/clip3.zxvideo');
      cam.beginBackfillDownload(cam.backfillClip, false, t3 + 19000);
      cam.markP2pVideoPacketReceived(t3 + 19100);
      handleDecodedP2pFrame(cam, scratch, t3 + 19100);
      cam.terminateSession(t3 + 19200, 'Station P2P disconnected/restarting', false, 'error/station-disconnect');
      assert.equal(cam.backfillClip, null, 'AT-16: Gives up on an interrupted clip after 3 attempts');

      // A raw-packet-only transfer that never decodes Frame 0 (firstFrameAt === 0) must NOT complete after 3s idle or
      // 'download finished', must time out after 15s, and must re-queue the clip for retry
      const tRaw = t3 + 22000;
      cam.queueEventBackfill(tRaw, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(tRaw + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip0frame.zxvideo',
        cipherId: 39,
        clipMs: tRaw + 1000,
      });
      cam.beginBackfillDownload(cam.backfillClip, false, tRaw + 10000);
      cam.markP2pVideoPacketReceived(tRaw + 10200);
      assert.equal(
        cam.isDownloadComplete(tRaw + 14000, 3000, 2500, 0),
        false,
        'AT-16: Raw compressed packets without decoded Frame 0 must not complete via 3s idle fallback'
      );
      assert.equal(
        cam.hasDownloadTimedOut(tRaw + 25200, 15000),
        false,
        'AT-16: Download timeout waits full 15s from last packet while waiting for Frame 0'
      );
      assert.equal(
        cam.hasDownloadTimedOut(tRaw + 25201, 15000),
        true,
        'AT-16: Stalled download without decoded Frame 0 times out after 15s even if raw packets arrived'
      );
      cam.markDownloadFinished(tRaw + 25201);
      assert.equal(
        cam.isDownloadComplete(tRaw + 29000, 3000, 2500, 0),
        false,
        'AT-16: downloadFinished without decoded Frame 0 must not mark playback complete'
      );
      cam.terminateSession(tRaw + 29000, 'post-event clip download timed out', false, 'eufy/download-finished');
      assert.equal(
        cam.downloadedPaths.has('/zx/clip0frame.zxvideo'),
        false,
        'AT-16: 0-decoded-frame transfer removes storagePath from downloadedPaths'
      );
      assert.equal(
        cam.backfillClip?.storagePath,
        '/zx/clip0frame.zxvideo',
        'AT-16: 0-decoded-frame transfer re-queues the clip at the front of backfillClipQueue'
      );
      cam.clearPendingBackfill();

      // Once Frame 0 has decoded, a finished transfer or 3s idle-fallback playback is complete and stays downloaded
      const t4 = t3 + 60000;
      cam.queueEventBackfill(t4, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t4 + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip4.zxvideo',
        cipherId: 4,
        clipMs: t4 + 1000,
      });
      cam.beginBackfillDownload(cam.backfillClip, false, t4 + 10000);
      cam.markP2pVideoPacketReceived(t4 + 10100);
      handleDecodedP2pFrame(cam, scratch, t4 + 10100);
      pushFrameToEncoder(cam, t4 + 10150);
      cam.markDownloadFinished(t4 + 10200);
      cam.terminateSession(t4 + 12000, 'post-event clip download stream completed', false, 'eufy/download-finished');
      assert.equal(cam.downloadedPaths.has('/zx/clip4.zxvideo'), true, 'AT-16: Finished transfer stays downloaded');
      assert.equal(cam.backfillClip, null, 'AT-16: Finished transfer is not re-queued');

      const t5 = t4 + 30000;
      cam.queueEventBackfill(t5, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t5 + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip5.zxvideo',
        cipherId: 5,
        clipMs: t5 + 1000,
      });
      cam.beginBackfillDownload(cam.backfillClip, false, t5 + 10000);
      cam.markP2pVideoPacketReceived(t5 + 10100);
      handleDecodedP2pFrame(cam, scratch, t5 + 10100);
      pushFrameToEncoder(cam, t5 + 10150);
      cam.terminateSession(t5 + 14000, 'post-event clip download stream completed', false, 'eufy/download-finished');
      assert.equal(
        cam.downloadedPaths.has('/zx/clip5.zxvideo'),
        true,
        'AT-16: Idle-fallback completion stays downloaded'
      );
      assert.equal(cam.backfillClip, null, 'AT-16: Idle-fallback completion is not re-queued');

      // Split-clip follow-up queries reset the 10-attempt budget across 3+ clips without a redundant 4s settle wait
      const tSplit = t5 + 30000;
      cam.queueEventBackfill(tSplit, 'motion detected', '', 'motion detected', 10, true);
      cam.queueEventBackfill(tSplit + 40000, 'person detected', '', 'person detected', 200, true);
      cam.recordMotionCleared(tSplit + 42000, 4000, 10000);
      for (let attempt = 1; attempt <= 9; attempt++) {
        assert.equal(cam.beginBackfillDatabaseQuery(tSplit + 46000 + attempt * 12000, 10).allowed, true);
      }
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/split1.zxvideo',
          cipherId: 6,
          clipMs: tSplit + 1000,
        }),
        true
      );
      const tSplitPlay1 = tSplit + 170000;
      cam.beginBackfillDownload(cam.backfillClip, false, tSplitPlay1);
      cam.markP2pVideoPacketReceived(tSplitPlay1 + 100);
      handleDecodedP2pFrame(cam, scratch, tSplitPlay1 + 100);
      pushFrameToEncoder(cam, tSplitPlay1 + 200);
      cam.markDownloadFinished(tSplitPlay1 + 300);
      cam.endSession(tSplitPlay1 + 400, true, false, 'download');
      assert.equal(
        cam.canQueryBackfill(tSplitPlay1 + 400, 4000, 12000),
        true,
        'AT-16: Follow-up split-clip query is ready immediately without a redundant 4s settle stall'
      );
      assert.equal(
        cam.pendingBackfill?.attempts,
        0,
        'AT-16: Follow-up split-clip query resets the 10-attempt query budget'
      );
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/split2.zxvideo',
          cipherId: 7,
          clipMs: tSplit + 20000,
        }),
        true
      );
      const tSplitPlay2 = tSplitPlay1 + 5000;
      cam.beginBackfillDownload(cam.backfillClip, false, tSplitPlay2);
      cam.markP2pVideoPacketReceived(tSplitPlay2 + 100);
      handleDecodedP2pFrame(cam, scratch, tSplitPlay2 + 100);
      pushFrameToEncoder(cam, tSplitPlay2 + 200);
      cam.markDownloadFinished(tSplitPlay2 + 300);
      cam.endSession(tSplitPlay2 + 400, true, false, 'download');
      assert.equal(
        cam.canQueryBackfill(tSplitPlay2 + 400, 4000, 12000),
        true,
        'AT-16: Matching Clip 2 resets followUpQueried so a 3rd split clip is also queried'
      );
      cam.clearPendingBackfill();

      // Inter-job continuation holds Clip 1's final frame with 0s post-playback hold while Job 2 settles
      const tCont = tSplitPlay2 + 30000;
      const contFrame = Buffer.alloc(1382400, 0xa5);
      cam.queueEventBackfill(tCont, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(tCont + 3000, 4000, 10000);
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/cont1.zxvideo',
          cipherId: 8,
          clipMs: tCont + 1000,
        }),
        true
      );
      cam.beginBackfillDownload(cam.backfillClip, false, tCont + 8000);
      cam.markP2pVideoPacketReceived(tCont + 8100);
      handleDecodedP2pFrame(cam, contFrame, tCont + 8100);
      pushFrameToEncoder(cam, tCont + 8200);
      // Back-to-back Event 2 triggers while Clip 1 is playing -> queued in pendingBackfill/queuedBackfillJob
      cam.queueEventBackfill(tCont + 8300, 'person detected', '', 'person detected', 200, true);
      cam.markDownloadFinished(tCont + 8400);
      assert.equal(
        cam.isDownloadComplete(tCont + 8500, 3000, 2500, 0),
        true,
        'AT-16: Skips 2.5s post-playback hold when a back-to-back BackfillJob is pending'
      );
      cam.endSession(tCont + 8500, true, false, 'download');
      const heldBetweenJobs = selectEncoderFrame(cam, tCont + 9000);
      assert.notEqual(
        heldBetweenJobs.frame,
        cam.card.sleep,
        'AT-16: Holds final video frame instead of flashing Asleep card while Job 2 settles'
      );
      assert.notEqual(
        heldBetweenJobs.frame,
        cam.card.busy,
        'AT-16: Holds final video frame instead of flashing Waiting card while Job 2 settles'
      );

      // Verify auto/rtsp camera in STREAM_MODES.DOWNLOAD queues BackfillJob on hardware 'rtsp livestream started'
      const autoDlCam = new Camera({
        serial: 'T8161T0000000094',
        name: 'auto_dl_cam',
        mode: 'auto',
        station_serial: 'T8030P0000000028',
      });
      autoDlCam.updateDiscoveredRtspConfig('T8030P0000000028', 'rtsp://192.0.2.10/live0');
      initOrchestrator([autoDlCam], new Map([[autoDlCam.getSerial(), autoDlCam]]), () => false);
      const tAutoDl = Date.now();
      autoDlCam.beginBackfillDownload(
        {
          storagePath: '/zx/auto_ev1.zxvideo',
          cipherId: 9,
          clipMs: tAutoDl - 15000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        tAutoDl
      );
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: autoDlCam.getSerial(),
      });
      assert.equal(
        autoDlCam.activeMode,
        'download',
        'AT-16: Hardware RTSP start on auto/rtsp camera must not interrupt active backfill download'
      );
      assert.equal(
        autoDlCam.hasPendingBackfill(),
        true,
        'AT-16: Hardware RTSP start on auto/rtsp camera during backfill download queues Event 2 BackfillJob'
      );
      autoDlCam.clearPendingBackfill();
      autoDlCam.endSession(tAutoDl + 1000, true, false, 'download');

      // A 90s-120s HomeBase clip draining from RAM at 15 fps must play to completion without being terminated by
      // runHousekeepingTick when stream_max_secs < 120 (e.g., stream_max_secs: 60)
      const maxClipCam = new Camera({
        serial: 'T8214T0000000096',
        name: 'doorbell_long_clip',
        mode: 'backfill',
        hold_secs: 30,
        stream_max_secs: 60,
        station_serial: 'T8030P0000000028',
      });
      initOrchestrator([maxClipCam], new Map([[maxClipCam.getSerial(), maxClipCam]]), () => false);
      const tLong = 2000000;
      maxClipCam.beginBackfillDownload(
        {
          storagePath: '/zx/clip_120s.zxvideo',
          cipherId: 12,
          clipMs: tLong - 120000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        tLong
      );
      maxClipCam.markP2pVideoPacketReceived(tLong + 200);
      handleDecodedP2pFrame(maxClipCam, scratch, tLong + 200);
      handleDecodedP2pFrame(maxClipCam, scratch, tLong + 250);
      maxClipCam.markDownloadFinished(tLong + 4000);
      runHousekeepingTick(tLong + 95000);
      assert.equal(
        maxClipCam.activeMode,
        'download',
        'AT-16: 95s into a 120s backfill clip, runHousekeepingTick must not cut off playback at stream_max_secs (60s)'
      );
      assert.equal(maxClipCam.downloadedPaths.has('/zx/clip_120s.zxvideo'), true);
      assert.equal(maxClipCam.backfillClip, null);
      maxClipCam.endSession(tLong + 122500, true, false, 'download');
    }
  );

  it(
    'AT-17: Resolves /api/wake targets (RTSP before P2P), waits for real video or clean snapshot before ' +
      'filing Frigate events, upgrades/extends events, auto-syncs Frigate masks, and posts ha_webhook',
    async () => {
      const p2pCam = new Camera({
        serial: 'T8214T0000000029',
        name: 'doorbell',
        title: 'Front Doorbell',
        mode: 'p2p',
        card_theme: 'glance',
        card_position: 'bottom-left',
        auto_frigate_mask: true,
      });
      const rtspCam = new Camera({
        serial: 'T8161T0000000030',
        name: 'driveway',
        title: 'Front Driveway',
        mode: 'rtsp',
        card_theme: 'none',
        auto_frigate_mask: true,
      });
      rtspCam.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');

      // 1. resolveTargetCameras + RTSP-first sorting
      const targets = resolveTargetCameras('all', [p2pCam, rtspCam]).sort((a, b) => Camera.compareRtspFirst(a, b));
      assert.deepEqual(
        targets.map((c) => c.getName()),
        ['driveway', 'doorbell']
      );

      // 2. Clean event snapshot fallback + Frigate event upgrade/extension
      const t0 = 400000;
      const cleanSnap = Buffer.alloc(1382400, 0x55);
      const snapCam = new Camera(
        {serial: 'T8161T0000000031', name: 'porch', mode: 'rtsp', hold_secs: 60},
        {frame: cleanSnap, lastSeen: '12:00'},
        renderCameraCards
      );
      snapCam.beginSession('rtsp', t0, true);
      snapCam.card.suppressLiveCard = true;
      assert.equal(selectEncoderFrame(snapCam, t0 + 100).frame, cleanSnap);
      snapCam.card.suppressLiveCard = false;

      snapCam.gotVideo = true;
      snapCam.firstVideoAt = t0 + 1000;
      snapCam.firstFrameAt = t0 + 1000;
      snapCam.motionUntil = t0 + 60000;
      assert.equal(snapCam.tryUpgradeOrQueueFrigateEvent('motion', '', t0 + 1000).status, 'queued');
      snapCam.beginFrigateSnapshotWait();
      snapCam.completeFrigateEventFiling(t0 + 2000, 15);
      snapCam.motionUntil = t0 + 95000;
      assert.equal(
        snapCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', t0 + 25000).status,
        'queued',
        'AT-17: Re-queues Frigate event when label/person upgrades and hold extends past evUntil'
      );

      // 3. Auto-sync Frigate masks + ha_webhook
      const putPayloads = [];
      const webhookBodies = [];
      const origFetch = global.fetch;
      global.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.endsWith('/api/config')) {
          return {
            ok: true,
            async json() {
              return {
                cameras: {
                  doorbell: {motion: {mask: {}}, objects: {mask: {}}},
                  driveway: {
                    motion: {
                      mask: {
                        eufy_bridge_card: {enabled: true, coordinates: '0,0,1,1'},
                        user_trees: {enabled: true, coordinates: '0.5,0.5,1,1'},
                      },
                    },
                    objects: {
                      mask: {
                        eufy_bridge_card: {enabled: false, coordinates: '0,0,1,1'},
                        user_street: {enabled: true, coordinates: '0.2,0.2,0.4,0.4'},
                      },
                    },
                  },
                },
              };
            },
          };
        }
        if (u.includes('/api/config/set')) {
          putPayloads.push(JSON.parse(opts.body));
          return {
            ok: true,
            async text() {
              return '';
            },
          };
        }
        if (u.includes('webhook')) {
          webhookBodies.push(JSON.parse(opts.body));
          return {ok: true, status: 200};
        }
        throw new Error('Unexpected URL: ' + u);
      };
      try {
        await syncFrigateMotionMasks([p2pCam, rtspCam], true, false, 'http://frigate:5000');
        p2pCam.evLabel = 'person';
        p2pCam.evPerson = 'Alice';
        notifyHA(p2pCam, {event_id: 'evt-1', review_id: 'rev-1'}, 'http://ha:8123/api/webhook/test');
      } finally {
        global.fetch = origFetch;
      }
      assert.equal(putPayloads.length, 4);
      assert.equal(putPayloads[2].update_topic, 'config/cameras/driveway/motion');
      assert.equal(putPayloads[2].config_data.cameras.driveway.motion.mask.eufy_bridge_card, '');
      assert.equal(putPayloads[2].config_data.cameras.driveway.motion.mask.user_trees, undefined);
      assert.equal(putPayloads[3].update_topic, 'config/cameras/driveway/objects');
      assert.equal(putPayloads[3].config_data.cameras.driveway.objects.mask.eufy_bridge_card, '');
      assert.equal(putPayloads[3].config_data.cameras.driveway.objects.mask.user_street, undefined);
      assert.equal(webhookBodies.length, 1);
      assert.equal(webhookBodies[0].event_id, 'evt-1');

      // 4. Hybrid direct rtsp_url handling, atomic unknown targets, and HTTP error responses on /api/wake
      const {PassThrough} = require('node:stream');
      const directCam = new Camera({
        name: 'nursery',
        title: 'Nursery Monitor',
        mode: 'rtsp',
        rtsp_url: 'rtsp://127.0.0.1:8554/nursery',
      });
      const {wsInstance} = await setupAcceptanceHarness([rtspCam, p2pCam, directCam]);
      try {
        const directWakeResp = wakeCameraExternal(directCam, {
          durationMs: 30000,
          reason: 'direct wake check',
          createEvent: true,
        });
        assert.equal(directWakeResp.status, 'unsupported');
        assert.equal(directWakeResp.hold_secs, 0);
        assert.equal(directCam.isSessionActive(), false);
        assert.equal(directCam.evTimer, null);

        const wakeHandler = createHttpRequestHandler([rtspCam, p2pCam, directCam], {
          wakeCameraExternal,
          isShuttingDown: () => false,
        });
        const callWakeEndpoint = async (method, url, body = null) => {
          const req = Object.assign(new PassThrough(), {method, url});
          const headers = {};
          let status = 0;
          let payload = '';
          const done = new Promise((resolve) => {
            const res = {
              setHeader(k, v) {
                headers[String(k).toLowerCase()] = v;
              },
              writeHead(code, hdrs = {}) {
                status = code;
                for (const [k, v] of Object.entries(hdrs)) {
                  headers[String(k).toLowerCase()] = v;
                }
              },
              end(chunk = '') {
                payload += String(chunk || '');
                resolve();
              },
            };
            void wakeHandler(req, res);
          });
          req.end(body !== null ? body : undefined);
          await done;
          return {status, headers, json: JSON.parse(payload)};
        };

        const directOnlyHttp = await callWakeEndpoint('POST', '/api/wake/nursery', '{"duration": 30}');
        assert.equal(directOnlyHttp.status, 422);
        assert.equal(directOnlyHttp.json.ok, false);
        assert.equal(directOnlyHttp.json.error_code, 'UNSUPPORTED_OPERATION');
        assert.equal(directOnlyHttp.json.results[0].status, 'unsupported');

        const partialMissHttp = await callWakeEndpoint('POST', '/api/wake/driveway,missing_cam', '{"duration": 30}');
        assert.equal(partialMissHttp.status, 404);
        assert.equal(partialMissHttp.json.error_code, 'CAMERA_NOT_FOUND');
        assert.deepEqual(partialMissHttp.json.unknown, ['missing_cam']);
        assert.equal(rtspCam.isSessionActive(), false);

        const badPercentHttp = await callWakeEndpoint('POST', '/api/wake/%');
        assert.equal(badPercentHttp.status, 400);
        assert.equal(badPercentHttp.json.error_code, 'INVALID_TARGET_ENCODING');

        const badJsonHttp = await callWakeEndpoint('POST', '/api/wake/driveway', '{invalid');
        assert.equal(badJsonHttp.status, 400);
        assert.equal(badJsonHttp.json.error_code, 'INVALID_REQUEST');

        const tooBigHttp = await callWakeEndpoint('POST', '/api/wake/driveway', 'a'.repeat(16385));
        assert.equal(tooBigHttp.status, 413);
        assert.equal(tooBigHttp.json.error_code, 'PAYLOAD_TOO_LARGE');

        const badMethodHttp = await callWakeEndpoint('DELETE', '/api/wake/driveway');
        assert.equal(badMethodHttp.status, 405);
        assert.equal(badMethodHttp.headers.allow, 'POST, GET');

        const allWakeHttp = await callWakeEndpoint('POST', '/api/wake/all', '{"duration": 30, "create_event": false}');
        assert.equal(allWakeHttp.status, 200);
        assert.equal(allWakeHttp.json.ok, true);
        assert.equal(allWakeHttp.json.results.find((r) => r.camera === 'nursery').status, 'unsupported');
        assert.equal(directCam.isSessionActive(), false);

        // Verify /api/wake during STREAM_MODES.DOWNLOAD on rtsp/p2p cameras preserves chronological order
        stop(rtspCam, 'reset before download wake test', false, 'bridge-test');
        stop(p2pCam, 'reset before download wake test', false, 'bridge-test');
        rtspCam.clearApiWakeTimer();
        p2pCam.clearApiWakeTimer();
        const tDlWake = Date.now();
        rtspCam.beginSession('download', tDlWake - 100, true);
        stop(rtspCam, 'clear station pacing before download wake test', false, 'eufy/download-finished');
        rtspCam.beginBackfillDownload(
          {
            storagePath: '/zx/rtsp_ev1.zxvideo',
            cipherId: 21,
            clipMs: tDlWake - 20000,
            event: 'motion detected',
            personName: '',
            reason: 'ev1 clip',
          },
          false,
          tDlWake
        );
        const deferredHttp = await callWakeEndpoint(
          'POST',
          '/api/wake/driveway',
          '{"duration": 20, "reason": "driveway beam", "create_event": true}'
        );
        assert.equal(deferredHttp.status, 200);
        assert.equal(
          deferredHttp.json.results[0].status,
          'scheduled',
          'AT-17: /api/wake on rtsp/p2p camera in backfill download without hardware trigger returns scheduled'
        );
        assert.equal(
          rtspCam.activeMode,
          'download',
          'AT-17: /api/wake must let Event 1 backfill download finish first'
        );
        assert.equal(rtspCam.getReason(), 'backfill: ev1 clip');
        // Finish Event 1 30s later (> 20s requested duration) -> Event 2 wakes live RTSP for full 20s!
        const dlFrame = Buffer.alloc(1382400, 0x33);
        rtspCam.markP2pVideoPacketReceived(tDlWake + 500);
        rtspCam.recordDecodedFrame(dlFrame, dlFrame, tDlWake + 500, '12:00');
        rtspCam.markDownloadFinished(tDlWake + 1000);
        stop(rtspCam, 'post-event clip download stream completed', false, 'eufy/download-finished');
        arbitrate(Date.now());
        assert.equal(
          rtspCam.activeMode,
          'rtsp',
          'AT-17: Deferred /api/wake wakes live RTSP immediately after Event 1 backfill finishes'
        );
        assert.equal(rtspCam.getReason(), 'driveway beam');
        stop(rtspCam, 'cleanup deferred rtsp wake', false, 'bridge-test');

        // When an unexpired Eufy hardware trigger IS recording Event 2 during DOWNLOAD, /api/wake upgrades BackfillJob
        const tDlTrig = Date.now();
        p2pCam.beginBackfillDownload(
          {
            storagePath: '/zx/p2p_ev1.zxvideo',
            cipherId: 22,
            clipMs: tDlTrig - 20000,
            event: 'motion detected',
            personName: '',
            reason: 'ev1 doorbell',
          },
          false,
          tDlTrig
        );
        onEvent({
          source: 'device',
          event: 'person detected',
          serialNumber: p2pCam.getSerial(),
          state: true,
        });
        const bfUpgradeHttp = await callWakeEndpoint(
          'POST',
          '/api/wake/doorbell',
          '{"duration": 30, "reason": "porch beam", "create_event": true}'
        );
        assert.equal(bfUpgradeHttp.status, 200);
        assert.equal(
          bfUpgradeHttp.json.results[0].status,
          'backfill',
          'AT-17: /api/wake during backfill download with active Eufy hardware trigger stays in backfill mode'
        );
        assert.equal(p2pCam.pendingBackfill?.reason, 'porch beam');
        p2pCam.clearPendingBackfill();
      } finally {
        p2pCam.clearApiWakeTimer();
        stop(rtspCam, 'cleanup', false, 'bridge-test');
        stop(p2pCam, 'cleanup', false, 'bridge-test');
        if (wsInstance) {
          wsInstance.readyState = 3;
          if (wsInstance.handlers.has('close')) {
            wsInstance.handlers.get('close')();
          }
        }
      }
    }
  );

  it(
    'AT-18: Enforces 6-color status palette (White Asleep vs Grey Disconnected), Debug HUD service statuses ' +
      '(WS/HB/FRG/RTC), 5 fps / 15 fps pacing, and startup snapshot probe eligibility',
    () => {
      const rawFrame = Buffer.alloc(1382400, 0x42);
      for (const theme of ['glance', 'minimal', 'pebbles', 'hud', 'none']) {
        const cardCfg = resolveCardConfig({
          card_theme: theme,
          card_position: 'bottom-left',
          sleep_screen: 'snapshot',
        });
        assert.equal(cardCfg.theme, theme);
      }

      // 1. 6-color semantic status palette: White (Asleep / Asleep Low Battery sleep-ready, battery > 30%),
      //    Grey (Disconnected), Yellow (Waiting & Low Battery 6..30%), Blue (Waking), Red (Live/Backfill),
      //    Purple (Critical Battery <= 5% & Hot temp)
      const healthyAsleep = evaluateTelemetryState('Asleep', {});
      assert.equal(healthyAsleep.statusKind, 'asleep');
      assert.deepEqual(healthyAsleep.statusRgb, [255, 255, 255]);

      const disruptedAsleep = evaluateTelemetryState('Asleep', {serviceDisrupted: true});
      assert.equal(disruptedAsleep.statusKind, 'disconnected');
      assert.deepEqual(disruptedAsleep.statusRgb, [180, 180, 190]);

      const explicitDisconnected = evaluateTelemetryState('Disconnected', {});
      assert.equal(explicitDisconnected.statusKind, 'disconnected');
      assert.deepEqual(explicitDisconnected.statusRgb, [180, 180, 190]);

      const lowBatAsleep = evaluateTelemetryState('Asleep (Low Battery)', {
        battery: 30,
        charging: false,
        economyMode: true,
      });
      assert.deepEqual(lowBatAsleep.statusRgb, [255, 255, 255]);
      assert.deepEqual(lowBatAsleep.batRgb, [250, 204, 21]);
      assert.deepEqual(evaluateTelemetryState('Asleep', {battery: 6, charging: false}).batRgb, [250, 204, 21]);
      assert.deepEqual(evaluateTelemetryState('Asleep', {battery: 5, charging: false}).batRgb, [232, 121, 249]);
      assert.deepEqual(evaluateTelemetryState('Asleep', {battery: 31, charging: false}).batRgb, [255, 255, 255]);
      assert.deepEqual(evaluateTelemetryState('Waiting', {}).statusRgb, [250, 204, 21]);
      assert.deepEqual(evaluateTelemetryState('Waking Up...', {}).statusRgb, [56, 189, 248]);
      assert.deepEqual(evaluateTelemetryState('Live', {}).statusRgb, [239, 68, 68]);
      assert.deepEqual(evaluateTelemetryState('Backfill', {}).statusRgb, [239, 68, 68]);
      const unknownBadgeCam = new Camera(
        {
          serial: 'T8214T0000000038',
          name: 'unknown_bat_with_badge',
          card_theme: 'glance',
          card_position: 'top-left',
          telemetry: {battery: true, power_source: false, wifi: true},
        },
        {frame: rawFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      const knownZeroBatCam = new Camera(
        {
          serial: 'T8214T0000000039',
          name: 'known_zero_bat_no_badge',
          card_theme: 'glance',
          card_position: 'top-left',
          telemetry: {battery: true, power_source: false, wifi: true},
        },
        {frame: rawFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      knownZeroBatCam.applyTelemetryProperties({battery: 0, chargingStatus: 2});
      renderCameraCards(knownZeroBatCam);
      let badgeDiffPixels = 0;
      for (let py = 33; py < 48; py++) {
        for (let px = 92; px < 107; px++) {
          if (unknownBadgeCam.card.asleep[py * 1280 + px] !== knownZeroBatCam.card.asleep[py * 1280 + px]) {
            badgeDiffPixels++;
          }
        }
      }
      assert.ok(
        badgeDiffPixels > 10,
        'AT-18: Unavailable battery (!hasBat) must render the top-right 15x15 question mark (?) ' +
          'badge on the battery icon'
      );

      const cam = new Camera(
        {
          serial: 'T8214T0000000032',
          name: 'doorbell',
          mode: 'backfill',
          card_theme: 'glance',
          card_position: 'bottom-left',
          card_show_on_live: true,
          sleep_screen: 'snapshot',
        },
        {frame: rawFrame, lastSeen: '12:00'},
        renderCameraCards
      );

      // 2. Debug HUD Row 1 Col 6 displays WS:OK HB:OK FRG:OK RTC:OK and Row 3 Col 6 displays TRIG:...  Q:00/00
      const hudLinesOk = cam.buildDebugHudLines(1000);
      assert.ok(hudLinesOk[0].includes('WS:OK HB:OK FRG:OK RTC:OK'));
      assert.ok(hudLinesOk[2].includes('  Q:00/00'));
      cam.updateServiceHealth({wsConnected: false, frigateConnected: false});
      const hudLinesDn = cam.buildDebugHudLines(1000);
      assert.ok(hudLinesDn[0].includes('WS:DN HB:OK FRG:DN RTC:OK'));
      cam.updateServiceHealth({wsConnected: true, frigateConnected: true});

      // Verify "hud" supports all 7 card_position placements identically to other themes
      const hudTopLeftCam = new Camera({serial: 'T8214T0000000040', card_theme: 'hud', card_position: 'top-left'});
      const hudBottomRightCam = new Camera({
        serial: 'T8214T0000000041',
        card_theme: 'hud',
        card_position: 'bottom-right',
      });
      const hudCenterCam = new Camera({serial: 'T8214T0000000042', card_theme: 'hud', card_position: 'center'});
      assert.deepEqual(hudTopLeftCam.getCardBounds(), {boxX: 24, boxY: 24, boxW: 832, boxH: 76});
      assert.deepEqual(hudBottomRightCam.getCardBounds(), {boxX: 424, boxY: 620, boxW: 832, boxH: 76});
      assert.equal(hudCenterCam.getCardBounds(), null);

      // 3. Live vs Backfill vs Waiting (Yellow) vs Asleep (Green) overlay distinction without mutating rawFrame
      cam.active = true;
      cam.activeMode = 'p2p';
      const liveOut = Buffer.from(renderLiveFrameWithCard(cam, rawFrame));
      cam.activeMode = 'download';
      const bfOut = Buffer.from(renderLiveFrameWithCard(cam, rawFrame));
      assert.equal(liveOut.equals(bfOut), false);
      assert.equal(rawFrame[0], 0x42);

      cam.active = false;
      cam.activeMode = '';
      assert.equal(selectEncoderFrame(cam, 1000).frame, cam.card.asleep);
      cam.queueEventBackfill(1000, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(
        selectEncoderFrame(cam, 1500).frame,
        cam.card.busy,
        'AT-18: IDLE camera with pending BackfillJob must select Yellow Waiting (card.busy) frame'
      );
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/bf_handshake.zxvideo',
          cipherId: 0,
          clipMs: 1000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        2000
      );
      assert.equal(
        selectEncoderFrame(cam, 2100).frame,
        cam.card.busy,
        'AT-18: HANDSHAKING_BACKFILL before Frame 0 decodes must select Yellow Waiting (card.busy) frame'
      );
      cam.endSession(3000);
      cam.clearPendingBackfill();

      // 4. 5 fps (200ms) idle throttling vs 15 fps (66ms) live frame pacing
      const t0 = 100000;
      cam.lastWrite = t0;
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + 66), false);
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + 200), true);
      cam.frameNew = true;
      assert.equal(shouldWriteEncoderFrame(cam, true, false, false, t0 + 66), true);

      // 5. Per-camera snapshot cache filename isolation (deduplicated when serial === name) and startup probe
      assert.equal(cam.getCacheFileName(), 'last_doorbell_T8214T0000000032.jpg');
      const probeCam = new Camera(
        {serial: 'T8161T0000000033', sleep_screen: 'snapshot', startup_snapshot: true},
        {frame: null, lastSeen: ''}
      );
      assert.equal(probeCam.getCacheFileName(), 'last_T8161T0000000033.jpg');
      assert.equal(probeCam.needsStartupSnapshot, true);
      const directSnapCam = new Camera({name: 'nursery', rtsp_url: 'rtsp://192.0.2.10/live0'});
      assert.equal(directSnapCam.getCacheFileName(), 'last_nursery.jpg');
    }
  );

  it(
    'AT-19: Enforces YAML config validation, env endpoints, direct rtsp_url resolution, defensive clamping, ' +
      'ignored-option warnings, and null-filtered /api/config',
    () => {
      // Verify 1: YAML config validation (no legacy/env-only keys), single-pass error reporting, and env endpoints
      const minimalCfg = {
        cameras: [{serial: 'T8161T0000000034'}],
      };
      assert.doesNotThrow(() => validateConfig(minimalCfg));
      assert.equal(minimalCfg.cameras[0].name, 'T8161T0000000034');

      assert.throws(
        () =>
          validateConfig({
            frigate_url: 'http://frigate:5000',
            eufy_ws: 'ws://eufy:3000',
            hwaccel: 'vaapi',
            bogus_top: true,
            cameras: [{serial: 'T8161T0000000035', rtsp_url: 'http://bad-scheme/live', bogus_cam: 1}],
          }),
        (err) =>
          err instanceof Error &&
          err.message.includes('unknown key "frigate_url"') &&
          err.message.includes('unknown key "eufy_ws"') &&
          err.message.includes('unknown key "hwaccel"') &&
          err.message.includes('unknown key "bogus_top"') &&
          err.message.includes('cameras[0] "rtsp_url" must start with rtsp:// or rtsps://') &&
          err.message.includes('unknown camera key "cameras[0].bogus_cam"')
      );

      // Verify 1b: YAML file loading + ${ENV_VAR} expansion + hybrid env endpoint resolution
      const yamlDir = fs.mkdtempSync(path.join(testTmpDir, 'at19-yaml-'));
      const yamlPath = path.join(yamlDir, 'config.yaml');
      try {
        fs.writeFileSync(
          yamlPath,
          [
            '# yaml-language-server: $schema=https://example.invalid/config.schema.json',
            '# Comment line',
            'width: 1280',
            'cameras:',
            '  - name: nursery_cam',
            '    mode: rtsp',
            '    rtsp_url: rtsp://${CAM_USER}:${CAM_PASS:-fallback}@127.0.0.1:8554/nursery',
          ].join('\n'),
          'utf8'
        );
        const loadedYaml = loadConfigFile(yamlPath, {CAM_USER: 'viewer'});
        assert.equal(loadedYaml.width, 1280);
        assert.equal(loadedYaml.cameras[0].rtsp_url, 'rtsp://viewer:fallback@127.0.0.1:8554/nursery');
      } finally {
        fs.rmSync(yamlDir, {recursive: true, force: true});
      }

      const defaultEndpoints = resolveServiceEndpoints({});
      assert.equal(defaultEndpoints.eufy_security_ws_url, 'ws://eufy-security-ws:3000');
      assert.equal(defaultEndpoints.frigate_url, 'http://frigate:5000');
      assert.equal(defaultEndpoints.go2rtc_url, 'http://frigate:1984');
      assert.equal(defaultEndpoints.rtsp_publish_url, 'rtsp://frigate:8554/{name}');
      assert.equal(defaultEndpoints.ha_webhook_url, '');

      const customEndpoints = resolveServiceEndpoints({
        EUFY_WS_HOST: 'eufy.internal',
        EUFY_WS_PORT: '3100',
        FRIGATE_URL: 'https://nvr.example.com:8971/api/',
        GO2RTC_HOST: 'rtc.internal',
        GO2RTC_API_PORT: '1985',
        GO2RTC_RTSP_PORT: '8555',
        GO2RTC_RTSP_USER: 'pub',
        GO2RTC_RTSP_PASSWORD: 's@cret',
        HA_WEBHOOK_URL: 'http://ha:8123/api/webhook/hook1',
      });
      assert.equal(customEndpoints.eufy_security_ws_url, 'ws://eufy.internal:3100');
      assert.equal(customEndpoints.frigate_url, 'https://nvr.example.com:8971');
      assert.equal(customEndpoints.go2rtc_url, 'http://rtc.internal:1985');
      assert.equal(customEndpoints.rtsp_publish_url, 'rtsp://pub:s%40cret@rtc.internal:8555/{name}');
      assert.equal(customEndpoints.ha_webhook_url, 'http://ha:8123/api/webhook/hook1');

      // Verify 2: 5 camera modes, identity/title defaults, and direct rtsp_url isolation
      for (const mode of ['auto', 'rtsp', 'p2p', 'backfill', 'custom']) {
        assert.equal(resolveCameraMode({mode}), mode);
      }
      assert.equal(resolveCameraMode({mode: 'rtsp_direct'}), 'auto');
      assert.equal(resolveCameraMode({rtsp_url: 'rtsp://127.0.0.1:8554/nursery'}), 'rtsp');
      assert.equal(resolveCameraMode({mode: 'auto', rtsp_url: 'rtsps://127.0.0.1:8555/nursery'}), 'rtsp');
      const directOnlyCfg = {
        cameras: [{name: 'nursery_cam', rtsp_url: 'rtsp://admin:secret@127.0.0.1:8554/nursery'}],
      };
      assert.doesNotThrow(() => validateConfig(directOnlyCfg));
      for (const incompatibleMode of ['p2p', 'backfill', 'custom']) {
        assert.throws(
          () =>
            validateConfig({
              cameras: [
                {serial: 'T8161T0000000035', mode: incompatibleMode, rtsp_url: 'rtsp://127.0.0.1:8554/nursery'},
              ],
            }),
          new RegExp('cannot combine "rtsp_url" with mode "' + incompatibleMode + '"')
        );
      }

      const serialOnlyEufyCam = new Camera({serial: 'T8161T0000000036'});
      assert.equal(serialOnlyEufyCam.getName(), 'T8161T0000000036');
      assert.equal(serialOnlyEufyCam.toConfigSummary().title, 'T8161T0000000036');
      applyDeviceProperties(serialOnlyEufyCam, {name: 'Back Patio'});
      assert.equal(serialOnlyEufyCam.toConfigSummary().title, 'Back Patio');

      const directMinimalCam = new Camera({
        name: 'nursery_cam',
        rtsp_url: 'rtsp://admin:secret@127.0.0.1:8554/nursery',
        card_theme: 'minimal',
      });
      assert.equal(directMinimalCam.mode, 'rtsp');
      assert.equal(directMinimalCam.getSerial(), 'nursery_cam');
      assert.equal(directMinimalCam.backfillDownloads, false);
      assert.equal(directMinimalCam.needsStartupSnapshot, false);
      assert.equal(directMinimalCam.telemetry.hasPowerConservationEnabled(), false);
      assert.equal(directMinimalCam.telemetry.config.enabled, false);
      assert.equal(directMinimalCam.telemetry.config.battery, false);
      assert.equal(directMinimalCam.telemetry.config.powerSource, false);
      assert.equal(directMinimalCam.telemetry.config.wifi, false);
      assert.equal(directMinimalCam.telemetry.config.rssi, false);
      assert.deepEqual(directMinimalCam.getCardBounds(), {boxX: 24, boxY: 684, boxW: 26, boxH: 12});

      // Verify 3: Defensive clamping (FPS, timers, backfill_enabled in "backfill" mode, and Power Manager promotion)
      const rates = resolveFrameRates({live_fps: 10, idle_fps: 20});
      assert.equal(rates.idleFps, 10);
      const clampedTimers = resolveCameraTimers({
        serial: 'T8161T0000000034',
        mode: 'custom',
        hold_secs: 60,
        stream_max_secs: 20,
        view_linger_secs: 30,
        view_max_secs: 10,
        low_battery_hold_secs: 90,
        low_battery_threshold: 20,
        critical_battery_threshold: 25,
      });
      assert.equal(clampedTimers.maxMs, 60000);
      assert.equal(clampedTimers.viewMaxMs, 30000);
      assert.equal(clampedTimers.lowBatHoldMs, 60000);
      assert.equal(clampedTimers.lowBatThreshold, 20);
      assert.equal(clampedTimers.criticalBatThreshold, 19);
      const clampedHw = resolveHardwareRecordingConfig(
        {
          serial: 'T8161T0000000034',
          mode: 'custom',
          hold_secs: 60,
          end_early: false,
          power_working_mode: 0,
          recording_clip_length: 20,
        },
        clampedTimers
      );
      assert.equal(clampedHw.powerWorkingMode, 2);
      assert.equal(clampedHw.recordingClipLength, 60);
      const forcedBackfillCam = new Camera({
        serial: 'T8214T0000000037',
        mode: 'backfill',
        backfill_enabled: false,
        sync_power: false,
        card_theme: 'none',
        sleep_screen: 'slate',
      });
      assert.equal(forcedBackfillCam.backfillDownloads, true);

      // Verify 4: Ignored-option startup warnings and null-filtered GET /api/config with credential masking
      const directCfgPayload = buildConfigPayload([directMinimalCam]);
      assert.equal(directCfgPayload.use_rtsp, null);
      assert.equal(directCfgPayload.telemetry_poll_secs, null);
      assert.equal(directCfgPayload.cameras[0].serial, null);
      assert.equal(directCfgPayload.cameras[0].mode, 'rtsp');
      assert.equal(directCfgPayload.cameras[0].rtsp_url, 'rtsp://***@127.0.0.1:8554/nursery');
      assert.equal(directCfgPayload.cameras[0].hold_secs, null);
      assert.equal(directCfgPayload.cameras[0].sync_power, null);
      assert.equal(directCfgPayload.cameras[0].telemetry, null);

      const mixedCfgPayload = buildConfigPayload([forcedBackfillCam]);
      assert.equal(mixedCfgPayload.use_rtsp, true);
      assert.equal(mixedCfgPayload.card_show_on_live, null);
      assert.equal(mixedCfgPayload.cameras[0].idle_timeout_secs, null);
      assert.equal(mixedCfgPayload.cameras[0].power_working_mode, null);
      assert.equal(mixedCfgPayload.cameras[0].recording_clip_length, null);
      assert.equal(mixedCfgPayload.cameras[0].card_position, null);
      assert.equal(mixedCfgPayload.cameras[0].card_show_on_live, null);
      assert.equal(mixedCfgPayload.cameras[0].startup_snapshot, null);
      assert.equal(mixedCfgPayload.cameras[0].telemetry, null);

      const capturedWarnings = [];
      const origWarn = log.warn;
      log.warn = (scope, ...args) => {
        capturedWarnings.push({scope: String(scope), msg: args.join(' ')});
      };
      try {
        new BridgeConfigBuilder(
          {
            hold_secs: 45,
            cameras: [
              {
                name: 'nursery_cam',
                mode: 'rtsp',
                rtsp_url: 'rtsp://127.0.0.1:8554/nursery',
                hold_secs: 60,
                stream_max_secs: 300,
                sync_power: true,
                telemetry: {battery: true},
              },
            ],
          },
          {BRIDGE_HWACCEL: 'nvenc', BRIDGE_HWACCEL_DEVICE: '/dev/dri/renderD128'}
        ).build();
      } finally {
        log.warn = origWarn;
      }
      assert.equal(
        capturedWarnings.some((w) => w.scope === 'bridge' && w.msg.includes('BRIDGE_HWACCEL_DEVICE')),
        true,
        'AT-19: Must warn when BRIDGE_HWACCEL_DEVICE is specified with non-device hwaccel'
      );
      assert.equal(
        capturedWarnings.some((w) => w.scope === 'bridge' && w.msg.includes('hold_secs') && w.msg.includes('rtsp_url')),
        true,
        'AT-19: Must warn when top-level Eufy/timeout options are specified while all cameras specify rtsp_url'
      );
      assert.equal(
        capturedWarnings.some(
          (w) =>
            w.scope === 'nursery_cam' &&
            w.msg.includes('hold_secs') &&
            w.msg.includes('stream_max_secs') &&
            w.msg.includes('sync_power') &&
            w.msg.includes('telemetry')
        ),
        true,
        'AT-19: Must warn when per-camera timeout/Eufy/telemetry options are ignored on a direct rtsp_url camera'
      );
    }
  );
});
