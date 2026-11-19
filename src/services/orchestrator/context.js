// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Shared stream orchestrator runtime context: configured camera list, serial map,
 * shutdown predicate, per-station transition promises, offline encoder resumption,
 * and shared timing/initiator constants.
 */
'use strict';

const {log} = require('../../logger');
const {stations} = require('../../domain/station');
const {renderCameraCards} = require('../../overlay/card-renderer');
const {pushFrameToEncoder, startEncoder} = require('../../media/encoder');
const {noteStationActivity} = require('../eufy-client');

/** @typedef {import("../../domain/camera").Camera} Camera */

const STATION_WAKE_PACING_MS = 2500;
const P2P_STOP_SETTLE_MS = 250;
const DEFAULT_EXTERNAL_WAKE_EVENT = 'motion detected';
const MIN_EVENT_VIDEO_DURATION_MS = 10000;
const MS_PER_SECOND = 1000;

const STOP_INITIATORS = Object.freeze({
  TIMER: 'bridge-timer',
  MAX_LIMIT: 'bridge-max-limit',
  VIEW_LIMIT: 'bridge-view-limit',
});

/** @type {Camera[]} */
let cams = [];
/** @type {Map<string, Camera>} */
let bySerial = new Map();
/** @type {() => boolean} */
let isShuttingDownFn = () => false;
/** @type {(now?: number) => void} */
let arbitrateFn = () => {};

/**
 * Configures the active camera collection, serial index, and shutdown state getter.
 *
 * @param {Camera[]} cameraList - Configured Camera instances.
 * @param {Map<string, Camera>} serialMap - Map of serial -> Camera instance.
 * @param {() => boolean} shuttingDownGetter - Function returning true when shutting down.
 */
function configureOrchestratorContext(cameraList, serialMap, shuttingDownGetter) {
  cams = cameraList;
  bySerial = serialMap;
  isShuttingDownFn = typeof shuttingDownGetter === 'function' ? shuttingDownGetter : () => false;
}

/**
 * Registers the arbitration entry point so lower-level wake/teardown helpers can trigger arbitration
 * without circular module imports.
 *
 * @param {(now?: number) => void} fn - Arbitrator callback.
 */
function registerArbitrator(fn) {
  arbitrateFn = fn;
}

/**
 * Runs the registered stream arbitrator when wired.
 *
 * @param {number} [now] - Optional current epoch timestamp in milliseconds.
 */
function invokeArbitrate(now) {
  arbitrateFn(now);
}

const getCams = () => cams;
const findCameraBySerial = (serial) => bySerial.get(serial);
const isShuttingDown = () => isShuttingDownFn();
const getActiveStationTransitionCount = () => stations.activeTransitionCount();
const waitForStationTransitions = () => stations.waitForTransitions();
const getStationTransition = (cam) => stations.get(cam.getStationKey()).getTransition();
const setStationTransition = (cam, p) => {
  stations.get(cam.getStationKey()).trackTransition(p);
};

/**
 * Clears any offline/wake-timeout state on a camera when a live hardware event or video packet
 * arrives and restarts its persistent FFmpeg encoder if it was paused while offline.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} reason - Event or packet source that proved the camera is online.
 */
function resumeOfflineCameraIfNeeded(cam, reason) {
  noteStationActivity(cam.getStationSerial());
  const wasOffline = cam.isDeviceOffline();
  cam.markDeviceOnline();
  if (wasOffline || cam.shouldResumeOfflineEncoder()) {
    log.info(cam, 'camera is back online (' + reason + '), resuming RTSP encoder');
    renderCameraCards(cam);
    startEncoder(cam);
    pushFrameToEncoder(cam);
  }
}

module.exports = {
  STATION_WAKE_PACING_MS,
  P2P_STOP_SETTLE_MS,
  DEFAULT_EXTERNAL_WAKE_EVENT,
  MIN_EVENT_VIDEO_DURATION_MS,
  MS_PER_SECOND,
  STOP_INITIATORS,
  configureOrchestratorContext,
  registerArbitrator,
  invokeArbitrate,
  getCams,
  findCameraBySerial,
  isShuttingDown,
  getActiveStationTransitionCount,
  waitForStationTransitions,
  getStationTransition,
  setStationTransition,
  resumeOfflineCameraIfNeeded,
};
