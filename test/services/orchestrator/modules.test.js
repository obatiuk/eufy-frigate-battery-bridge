/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for split stream orchestrator modules under src/services/orchestrator/:
 * context, wake, arbitration, backfill-queue, event-router (frozen handler table), housekeeping,
 * and src/services/stream-orchestrator.js facade re-exports.
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../../helpers/test-env');
const {flushAsync} = require('../../helpers/async');

const {
  configureOrchestratorContext,
  getCams,
  findCameraBySerial,
  getActiveStationTransitionCount,
} = require('../../../src/services/orchestrator/context');
const {wakeCameraExternal, trigger, stop} = require('../../../src/services/orchestrator/wake');
const {arbitrate} = require('../../../src/services/orchestrator/arbitration');
const {processBackfillQueue} = require('../../../src/services/orchestrator/backfill-queue');
const {
  onEvent,
  handleRtspStreamDropped,
  DEVICE_EVENT_HANDLERS,
} = require('../../../src/services/orchestrator/event-router');
const {
  runHousekeepingTick,
  startHousekeepingLoop,
  resetHousekeepingErrorState,
} = require('../../../src/services/orchestrator/housekeeping');
const orchestrator = require('../../../src/services/stream-orchestrator');
const {
  registerEufySubsystems,
  configureEufyClientHooks,
  connectWs,
  stopWsClient,
} = require('../../../src/services/eufy/ws-transport');
const {Camera} = require('../../../src/domain/camera');
const {stations} = require('../../../src/domain/station');
const {log} = require('../../../src/logger');

describe('src/services/orchestrator split modules', () => {
  afterEach(() => {
    orchestrator.initOrchestrator([], new Map(), () => false);
    stations.resetRecovery();
    stations.resetOrchestration();
  });

  it('tracks configured cameras, serial lookup, and station transitions in context.js', () => {
    // Verify context.js stores camera collections, serial lookup, and active station transition counts.
    const cam = new Camera({serial: 'SN0000000301', name: 'ctx_cam', mode: 'p2p'});
    const map = new Map([[cam.getSerial(), cam]]);
    configureOrchestratorContext([cam], map, () => false);
    assert.deepEqual(getCams(), [cam]);
    assert.equal(findCameraBySerial('SN0000000301'), cam);
    assert.equal(findCameraBySerial('MISSING'), undefined);
    assert.equal(getActiveStationTransitionCount(), 0);
  });

  it('rejects unsupported direct rtsp_url cameras in wake.js wakeCameraExternal', () => {
    // Verify wake.js returns unsupported for direct rtsp_url cameras without requiring eufy-security-ws.
    const directCam = new Camera({
      serial: 'SN0000000302',
      name: 'direct_wake_cam',
      rtsp_url: 'rtsp://127.0.0.1:8554/direct_wake_cam',
    });
    orchestrator.initOrchestrator([directCam], new Map([[directCam.getSerial(), directCam]]), () => false);
    const res = wakeCameraExternal(directCam, {
      durationMs: 30_000,
      reason: 'unit test',
      createEvent: false,
    });
    assert.equal(res.status, 'unsupported');
    assert.equal(res.camera, 'direct_wake_cam');
  });

  it('exposes a frozen device event handler table in event-router.js', () => {
    // Verify event-router.js dispatches device events through a frozen lookup table and ignores unknown serials.
    assert.equal(Object.isFrozen(DEVICE_EVENT_HANDLERS), true);
    for (const key of [
      'livestream video data',
      'livestream audio data',
      'download video data',
      'download audio data',
      'download started',
      'download finished',
      'rtsp livestream started',
      'rtsp livestream stopped',
      'livestream started',
      'livestream stopped',
      'property changed',
    ]) {
      assert.equal(typeof DEVICE_EVENT_HANDLERS[key], 'function', 'missing handler for ' + key);
    }
    onEvent({source: 'device', event: 'motion detected', serialNumber: 'SN0000000999', state: true});
  });

  it('runs idle arbitration, backfill queue, and housekeeping ticks safely when empty', async () => {
    // Verify arbitration, backfill-queue, and housekeeping execute cleanly with an empty camera set.
    orchestrator.initOrchestrator([], new Map(), () => false);
    arbitrate(1_000_000);
    await processBackfillQueue(1_000_000);
    runHousekeepingTick(1_000_000);
    assert.equal(typeof startHousekeepingLoop, 'function');
    assert.equal(typeof orchestrator.stopHousekeepingLoop, 'function');
    startHousekeepingLoop();
    orchestrator.stopHousekeepingLoop();
  });

  it('re-exports the full orchestrator API from src/services/stream-orchestrator.js with <=3 param wake.js', () => {
    // Verify wake.js takes <=3 params while stream-orchestrator.js exposes the full facade contract.
    assert.equal(trigger.length, 2);
    assert.equal(stop.length, 2);
    assert.equal(orchestrator.getActiveStationTransitionCount, getActiveStationTransitionCount);
    assert.equal(orchestrator.wakeCameraExternal, wakeCameraExternal);
    assert.equal(orchestrator.trigger, trigger);
    assert.equal(orchestrator.stop, stop);
    assert.equal(orchestrator.arbitrate, arbitrate);
    assert.equal(orchestrator.onEvent, onEvent);
    assert.equal(orchestrator.handleRtspStreamDropped, handleRtspStreamDropped);
    assert.equal(orchestrator.processBackfillQueue, processBackfillQueue);
    assert.equal(orchestrator.runHousekeepingTick, runHousekeepingTick);
    assert.equal(orchestrator.startHousekeepingLoop, startHousekeepingLoop);
    assert.equal(typeof orchestrator.waitForStationTransitions, 'function');
    assert.equal(typeof resetHousekeepingErrorState, 'function');
  });

  it('catches floating background RPC rejections in wake.js offline refresh and post-stop get_properties', async () => {
    // Verify offline api-wake refresh and post-stop device.get_properties never leak unhandled rejections.
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    const warnings = [];
    const debugs = [];
    const origWarn = log.warn;
    const origDebug = log.debug;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));
    log.debug = (_scope, ...args) => debugs.push(args.join(' '));

    let throwOnResume = false;
    class GuardWs extends EventEmitter {
      constructor() {
        super();
        this.readyState = 1;
        GuardWs.last = this;
      }
      send(raw, cb) {
        const msg = JSON.parse(raw);
        if (cb) cb(null);
        setImmediate(() => {
          if (msg.command === 'set_api_schema') {
            this.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
          } else if (msg.command === 'start_listening') {
            this.emit(
              'message',
              JSON.stringify({
                type: 'result',
                messageId: msg.messageId,
                success: true,
                result: {state: {driver: {connected: true}, stations: [], devices: []}},
              })
            );
          } else if (msg.command === 'driver.poll_refresh') {
            this.emit(
              'message',
              JSON.stringify({type: 'result', messageId: msg.messageId, success: false, errorCode: 'poll_failed'})
            );
          } else if (msg.command === 'device.get_properties') {
            this.emit(
              'message',
              JSON.stringify({
                type: 'result',
                messageId: msg.messageId,
                success: true,
                result: {properties: {state: {value: 1}, battery: {value: 92}}},
              })
            );
          } else {
            this.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
          }
        });
      }
      close() {
        this.readyState = 3;
      }
    }
    /** @type {GuardWs|null} */
    GuardWs.last = null;

    const offlineCam = new Camera({serial: 'SN0000000310', name: 'offline_cam', mode: 'p2p'});
    const liveCam = new Camera({serial: 'SN0000000311', name: 'live_cam', mode: 'p2p'});
    const cams = [offlineCam, liveCam];
    const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));

    try {
      orchestrator.initOrchestrator(cams, bySerial, () => false);
      configureEufyClientHooks({
        cams,
        bySerial,
        WebSocket: /** @type {*} */ (GuardWs),
        isShuttingDown: () => false,
        onDeviceOnlineResume: () => {
          if (throwOnResume) {
            throw new Error('simulated post-stop resume failure');
          }
        },
      });
      connectWs();
      assert.ok(GuardWs.last);
      GuardWs.last.emit('message', JSON.stringify({type: 'version', serverVersion: '1.9.9', maxSchemaVersion: 21}));
      await flushAsync(6);

      offlineCam.applyTelemetryProperties({state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100}, false);
      registerEufySubsystems({
        onRecoverDriverAndStations: async () => {
          throw new Error('simulated offline recovery failure');
        },
      });

      const wakeRes = wakeCameraExternal(offlineCam, {
        durationMs: 30_000,
        reason: 'unit-offline-wake',
        createEvent: false,
      });
      assert.equal(wakeRes.status, 'offline');
      await flushAsync(6);

      liveCam.applyTelemetryProperties({state: 1, battery: 92, chargingStatus: 2, wifiRssi: -60}, false);
      liveCam.beginSession('p2p', Date.now(), false);
      liveCam.setGotVideo(true);
      throwOnResume = true;
      stop(liveCam, 'idle timeout', {initiator: 'bridge'});
      await flushAsync(6);

      assert.deepEqual(unhandled, []);
      assert.equal(
        warnings.some((line) => line.includes('simulated offline recovery failure')),
        true
      );
      assert.equal(
        debugs.some((line) => line.includes('simulated post-stop resume failure')),
        true
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
      log.warn = origWarn;
      log.debug = origDebug;
      registerEufySubsystems({onRecoverDriverAndStations: async () => {}});
      stopWsClient();
    }
  });
});
