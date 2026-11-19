// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Periodic 500ms orchestrator housekeeping tick: early-sleep checks, Frigate hold extensions,
 * startup snapshot probes, stuck-spotlight conservation, and RTSP/P2P/download watchdogs.
 */
'use strict';

const {LIVE_FPS, STREAM_MODES} = require('../../config');
const {log} = require('../../logger');
const {WAKE_KINDS, DOWNLOAD_COMPLETED_INITIATOR} = require('../../domain/camera');
const {stopDecoder} = require('../../media/decoder');
const {FRIGATE_CAMERA_STATES, frigateEvent, isFrigateCameraIdle, checkPeriodicMaskSync} = require('../frigate-client');
const {setCameraProperty, isWsReady, canRunStartupProbeNow} = require('../eufy-client');
const {MIN_EVENT_VIDEO_DURATION_MS, MS_PER_SECOND, STOP_INITIATORS, getCams, isShuttingDown} = require('./context');
const {trigger, startRtspStream, startLivestream, stop} = require('./wake');
const {arbitrate} = require('./arbitration');
const {processBackfillQueue} = require('./backfill-queue');
const {handleRtspStreamDropped} = require('./event-router');

/** @typedef {import("../../domain/camera").Camera} Camera */

const DOWNLOAD_NO_VIDEO_TIMEOUT_MS = 10000;
const HOUSEKEEPING_INTERVAL_MS = 500;
const STARTUP_PROBE_READY_DELAY_MS = 6000;
const STARTUP_PROBE_HOLD_MS = 25000;

/**
 * Evaluates whether an active motion-woken camera can go to sleep early to conserve battery.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function evaluateEarlySleep(cam, now) {
  const {due, clearedByEufy} = cam.checkEarlySleepDue(now);
  if (!due) {
    return;
  }

  const frigateState = await isFrigateCameraIdle(cam);
  const checkNow = Date.now();
  if (frigateState === FRIGATE_CAMERA_STATES.IDLE && cam.canSleepEarlyOnIdle(checkNow, MIN_EVENT_VIDEO_DURATION_MS)) {
    const quietSecs = cam.markEarlySleep(checkNow);
    const initiator = clearedByEufy ? 'bridge-early-sleep/eufy-cleared' : 'bridge-early-sleep/quiet-timeout';
    stop(cam, 'motion cleared early (battery saver, quietFor=' + quietSecs + 's, frigateIdle=true)', {
      preemptedByViewer: false,
      initiator,
    });
    arbitrate();
  }
}

/**
 * Checks whether an active camera stream that is near or at hold/event expiry still has an
 * in-progress object detection in Frigate, extending the hold by HOLD_MS / 2 up to MAX_MS.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} [clockNow] - Optional synthetic timestamp in milliseconds; uses Date.now() when omitted.
 */
async function evaluateActiveHoldExtension(cam, clockNow) {
  const pollNow = clockNow === undefined ? Date.now() : clockNow;
  const {shouldPoll, needsTimeoutExtendCheck} = cam.shouldPollFrigateForHoldOrBackfill(pollNow);
  if (!shouldPoll) {
    return;
  }

  cam.setExtendCheckInFlight(true);
  try {
    const frigateState = await isFrigateCameraIdle(cam, clockNow);
    if (!cam.isSessionActive()) {
      return;
    }
    const extNow = clockNow === undefined ? Date.now() : clockNow;
    const hwActive = cam.hasActiveHardwareTriggers(extNow);
    const frigateActive = frigateState === FRIGATE_CAMERA_STATES.ACTIVE;
    if (frigateActive) {
      cam.confirmFrigateObjectDetected(extNow);
    }
    if ((!frigateActive && !hwActive) || !needsTimeoutExtendCheck) {
      return;
    }

    const {extended, extendMs, holdSecs} = cam.extendActiveHold(extNow);
    if (cam.shouldExtendFrigateEvent(extNow, LIVE_FPS)) {
      frigateEvent(cam, cam.getReason(), cam.getEventPerson());
    }
    if (!extended) {
      return;
    }
    const liveSecs = cam.getLiveDurationSecs(extNow);
    const reasonLabel = frigateActive
      ? 'active object still in progress in Frigate'
      : 'eufy hardware trigger still active';
    log.info(
      cam,
      reasonLabel +
        ', extended stream hold by +' +
        Math.round(extendMs / MS_PER_SECOND) +
        's (holdExtendedTo=' +
        holdSecs +
        's, live=' +
        liveSecs +
        's)'
    );
  } finally {
    cam.setExtendCheckInFlight(false);
    const finishNow = clockNow === undefined ? Date.now() : clockNow;
    if (cam.hasExpiredLiveHold(finishNow)) {
      arbitrate(finishNow);
    }
  }
}

/**
 * Checks health, non-destructive wake retries, and timeout conditions for an active RTSP camera session.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function checkRtspSessionHealth(cam, now) {
  const {action, killStalledDec, logMsg} = cam.evaluateRtspHealth(now);
  switch (action) {
    case 'retry':
      log.debug(cam, logMsg);
      if (killStalledDec) {
        stopDecoder(cam);
      }
      void startRtspStream(cam);
      break;
    case 'timeout':
      stop(cam, logMsg, {preemptedByViewer: false, initiator: 'error/rtsp-wake-timeout'});
      arbitrate();
      break;
    case 'dropped':
      handleRtspStreamDropped(cam, null, logMsg);
      break;
    default:
      break;
  }
}

/**
 * Checks completion and timeout conditions for an active backfill download session.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function checkDownloadSessionHealth(cam, now) {
  if (cam.isDownloadComplete(now)) {
    stop(cam, 'post-event clip download stream completed', {
      preemptedByViewer: false,
      initiator: DOWNLOAD_COMPLETED_INITIATOR,
    });
    arbitrate(now);
    void processBackfillQueue(now);
    return;
  }
  if (cam.hasDownloadTimedOut(now, DOWNLOAD_NO_VIDEO_TIMEOUT_MS)) {
    log.warn(
      cam,
      'post-event clip download timed out with no video after ' +
        Math.round(DOWNLOAD_NO_VIDEO_TIMEOUT_MS / MS_PER_SECOND) +
        's'
    );
    stop(cam, 'post-event clip download timed out', {
      preemptedByViewer: false,
      initiator: 'error/download-timeout',
    });
    arbitrate(now);
  }
}

/**
 * Checks watchdog stall and retry conditions for an active P2P livestream session.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function checkP2pSessionHealth(cam, now) {
  const {action, logMsg} = cam.evaluateP2pHealth(now);
  switch (action) {
    case 'expired':
      stop(cam, logMsg, {preemptedByViewer: false, initiator: 'eufy/camera'});
      break;
    case 'timeout':
      stop(cam, logMsg, {preemptedByViewer: false, initiator: 'error/watchdog-timeout'});
      break;
    case 'retry':
      log.warn(cam, logMsg);
      stopDecoder(cam);
      void startLivestream(cam);
      break;
    default:
      break;
  }
}

/**
 * Evaluates max-duration caps and launches a final Frigate hold-extension check before
 * arbitrate() stops cameras whose live hold window just reached expiry on this tick.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} [clockNow] - Optional synthetic timestamp in milliseconds.
 */
function prepareExpiredCameraHolds(now, clockNow) {
  for (const cam of getCams()) {
    if (!cam.hasExpiredLiveHold(now)) {
      continue;
    }
    const maxDurReason = cam.expireMaxDurationHold(now);
    if (maxDurReason) {
      stop(cam, maxDurReason, {preemptedByViewer: false, initiator: STOP_INITIATORS.MAX_LIMIT});
      continue;
    }
    const viewMaxReason = cam.getViewMaxDurationReason(now);
    if (viewMaxReason) {
      stop(cam, viewMaxReason, {preemptedByViewer: false, initiator: STOP_INITIATORS.VIEW_LIMIT});
      continue;
    }
    void evaluateActiveHoldExtension(cam, clockNow);
  }
}

/**
 * Executes one per-camera idle or active session health step inside runHousekeepingTick.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} [clockNow] - Optional synthetic timestamp in milliseconds.
 */
function inspectCameraOnTick(cam, now, clockNow) {
  if (!cam.isSessionActive()) {
    if (cam.shouldStartRtspDirectSession(now)) {
      void startRtspStream(cam, now);
      return;
    }
    if (isWsReady() && cam.shouldTurnOffStuckIdleLight(now)) {
      log.warn(cam, 'turning off stuck spotlight while idle (light=false) to restore deep sleep');
      setCameraProperty(cam, 'light', false);
    }
    return;
  }
  if (cam.hasExpiredLiveHold(now) && cam.isExtendCheckInFlight()) {
    return;
  }
  const maxDurReason = cam.expireMaxDurationHold(now);
  if (maxDurReason) {
    stop(cam, maxDurReason, {preemptedByViewer: false, initiator: STOP_INITIATORS.MAX_LIMIT});
    return;
  }
  const viewMaxReason = cam.getViewMaxDurationReason(now);
  if (viewMaxReason) {
    stop(cam, viewMaxReason, {preemptedByViewer: false, initiator: STOP_INITIATORS.VIEW_LIMIT});
    return;
  }

  void evaluateEarlySleep(cam, now);
  void evaluateActiveHoldExtension(cam, clockNow);

  switch (cam.getActiveMode()) {
    case STREAM_MODES.RTSP:
      checkRtspSessionHealth(cam, now);
      break;
    case STREAM_MODES.DOWNLOAD:
      checkDownloadSessionHealth(cam, now);
      break;
    default:
      checkP2pSessionHealth(cam, now);
      break;
  }
}

/**
 * Executes one housekeeping, arbitration, backfill, mask-sync, and session-health tick.
 *
 * @param {number} [clockNow] - Optional synthetic timestamp in milliseconds; uses Date.now() when omitted.
 */
function runHousekeepingTick(clockNow) {
  const now = clockNow === undefined ? Date.now() : clockNow;
  const cams = getCams();
  prepareExpiredCameraHolds(now, clockNow);
  arbitrate(now);
  void processBackfillQueue(now);
  if (isWsReady() || cams.some((c) => c.isRtspDirect())) {
    checkPeriodicMaskSync(cams, now, isShuttingDown());
  }

  if (canRunStartupProbeNow(now, STARTUP_PROBE_READY_DELAY_MS)) {
    const nextProbeCam = cams.find((c) => c.canStartStartupProbe(cams, now));
    if (nextProbeCam) {
      nextProbeCam.startStartupProbe();
      trigger(nextProbeCam, {
        reason: 'startup snapshot probe',
        ms: STARTUP_PROBE_HOLD_MS,
        kind: WAKE_KINDS.VIEW,
        initiator: 'bridge-probe',
      });
    }
  }

  for (const cam of cams) {
    inspectCameraOnTick(cam, now, clockNow);
  }
}

/** @type {ReturnType<typeof setInterval>|null} */
let housekeepingTimer = null;

/**
 * Stops the periodic 500ms housekeeping & watchdog loop.
 */
function stopHousekeepingLoop() {
  if (housekeepingTimer) {
    clearInterval(housekeepingTimer);
    housekeepingTimer = null;
  }
}

/**
 * Starts the 500ms housekeeping & watchdog loop.
 */
function startHousekeepingLoop() {
  stopHousekeepingLoop();
  housekeepingTimer = setInterval(() => runHousekeepingTick(), HOUSEKEEPING_INTERVAL_MS);
  if (housekeepingTimer && typeof housekeepingTimer.unref === 'function') {
    housekeepingTimer.unref();
  }
}

module.exports = {
  runHousekeepingTick,
  startHousekeepingLoop,
  stopHousekeepingLoop,
};
