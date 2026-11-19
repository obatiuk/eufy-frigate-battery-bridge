// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Public facade for the stream lifecycle orchestrator modules under src/services/orchestrator/.
 */
'use strict';

const {stations} = require('../domain/station');
const {setRtspDropHandler} = require('../media/decoder');
const {configureOrchestratorContext, getActiveStationTransitionCount} = require('./orchestrator/context');
const {wakeCameraExternal, trigger, stop} = require('./orchestrator/wake');
const {arbitrate} = require('./orchestrator/arbitration');
const {processBackfillQueue} = require('./orchestrator/backfill-queue');
const {onEvent, handleRtspStreamDropped} = require('./orchestrator/event-router');
const {runHousekeepingTick, startHousekeepingLoop, stopHousekeepingLoop} = require('./orchestrator/housekeeping');

/** @typedef {import("../domain/camera").Camera} Camera */

/**
 * Initializes the orchestrator with the active camera collection and shutdown state accessor.
 *
 * @param {Camera[]} cameraList - Configured Camera instances.
 * @param {Map<string, Camera>} serialMap - Map of serial -> Camera instance.
 * @param {() => boolean} shuttingDownGetter - Function returning true when shutting down.
 */
function initOrchestrator(cameraList, serialMap, shuttingDownGetter) {
  configureOrchestratorContext(cameraList, serialMap, shuttingDownGetter);
  stations.resetOrchestration();
  setRtspDropHandler(handleRtspStreamDropped);
}

module.exports = {
  initOrchestrator,
  getActiveStationTransitionCount,
  wakeCameraExternal,
  trigger,
  stop,
  arbitrate,
  onEvent,
  handleRtspStreamDropped,
  processBackfillQueue,
  runHousekeepingTick,
  startHousekeepingLoop,
  stopHousekeepingLoop,
};
