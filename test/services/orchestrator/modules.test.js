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

require('../../helpers/test-env');

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
const {Camera} = require('../../../src/domain/camera');
const {stations} = require('../../../src/domain/station');

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
    assert.equal(typeof resetHousekeepingErrorState, 'function');
  });
});
