// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Stream lifecycle orchestrator: per-station P2P arbitration, HomeBase native RTSP
 * wake, post-event clip download backfill, early-sleep checks, and stream watchdog.
 */
'use strict';

const {
  FRAME,
  MAX_MS,
  VIEW_MAX_MS,
  HOLD_MS,
  LOW_BAT_HOLD_MS,
  EARLY_SLEEP_MS,
  PREEMPT_EVENT_STREAMS,
  LET_EUFY_DECIDE_END,
  BACKFILL_DOWNLOADS,
  BACKFILL_DELAY_MS,
  LIVE_FPS,
  TRIGGERS,
  DEFAULT_EVENT_PRIORITY,
  KEYFRAME_BURST_MS,
  sleep,
  getEventPriority,
} = require('../config');
const {log} = require('../logger');
const {
  want,
  inMotion,
  getEffectivePriority,
  usesP2pSlot,
  isRtspCapable,
  getStationKey,
  isLowBattery,
  clearViewerQueue,
} = require('../domain/camera');
const {
  DEFAULT_BACKFILL_MAX_AGE_MS,
  BackfillJob,
  parseClipTimestampMs,
  extractDatabaseRecordCandidate,
} = require('../domain/backfill-job');
const {renderCameraCards} = require('../overlay/card-renderer');
const {saveCachedFrame} = require('../overlay/snapshot-cache');
const {pushFrameToEncoder} = require('../media/encoder');
const {setRtspDropHandler, startRtspDecoder, stopDecoder, onVideo, onAudio} = require('../media/decoder');
const {frigateEvent, isFrigateCameraIdle, checkPeriodicMaskSync} = require('./frigate-client');
const {
  call,
  isWsReady,
  getWsReadyAt,
  isInitialTelemetryLoaded,
  isTrackedPropertyEvent,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  extractRecognizedPerson,
} = require('./eufy-client');

// Priority boost constant for synthetic /api/wake events.
const API_WAKE_EVENT_PRIORITY = 250;

// Per-station wake pacing, burst deduplication, and log debounce intervals.
const STATION_WAKE_PACING_MS = 2500;
const API_WAKE_STALLED_RTSP_MS = 10000;
const COMPANION_MOTION_LOG_DEBOUNCE_MS = 2000;
const API_TRIGGER_LOG_DEBOUNCE_MS = 5000;

// Active stream hold extension thresholds (extends active stream by HOLD_MS / 2 when activity continues).
const HOLD_EXTEND_CHECK_WINDOW_MS = 4000;
const HOLD_EXTEND_POLL_COOLDOWN_MS = 4000;
const MAX_HOLD_SAFETY_MARGIN_MS = 5000;
const MIN_HOLD_EXTENSION_MS = 10000;
const MIN_TRIGGER_EXTENSION_MS = 5000;
const MID_STREAM_EVENT_GRACE_MS = 3000;
const MID_STREAM_RETRIGGER_GRACE_MS = 5000;

// Early-sleep and Eufy-controlled event end thresholds.
const EARLY_SLEEP_POLL_INTERVAL_MS = 5000;
const EUFY_CLEARED_SETTLE_MS = 5000;
const MIN_EVENT_VIDEO_DURATION_MS = 10000;
const MIN_CLEAN_EVENT_VIDEO_MS = 3000;

// P2P arbitration, RTSP wake coordination, and station handover timings.
const P2P_WAKE_STALL_PREEMPT_MS = 8000;
const RTSP_HANDSHAKE_MAX_POLLS = 22;
const RTSP_HANDSHAKE_POLL_MS = 250;
const RTSP_HANDSHAKE_WINDOW_MS = 5500;
const ALREADY_RUNNING_RESTART_DELAY_MS = 1000;
const FAILED_START_BACKOFF_MS = 5000;
const RTSP_STOP_SETTLE_MS = 50;
const P2P_STOP_SETTLE_MS = 150;

// External wake adoption and WebSocket startup/reconnect guards.
const EXTERNAL_WAKE_GUARD_MS = 3000;
const UNSOLICITED_VIDEO_STOP_DELAY_MS = 5000;
const WS_READY_EVENT_SETTLE_MS = 5000;
const STATION_RECONNECT_TELEMETRY_DELAY_MS = 3000;

// RTSP session health, fast retry, mid-session re-wake, and P2P fallback thresholds.
const RTSP_REWAKE_MIN_HOLD_MS = 20000;
const RTSP_WAKE_RETRY_MS = 3500;
const RTSP_MID_SESSION_STALL_MS = 3500;
const RTSP_MAX_WAKE_RETRIES = 4;
const RTSP_MAX_BUSY_P2P_RETRIES = 6;
const RTSP_BUSY_RETRY_BACKOFF_MS = 8000;
const RTSP_FALLBACK_TIMEOUT_MS = 22000;
const RTSP_P2P_FALLBACK_DURATION_MS = HOLD_MS;

// P2P watchdog retry thresholds.
const P2P_INITIAL_RETRY_MS = 5500;
const P2P_SUBSEQUENT_RETRY_MS = 8000;
const P2P_MAX_WATCHDOG_RETRIES = 3;

// HomeBase clip backfill queue and download health thresholds.
const BACKFILL_MIN_EVENT_AGE_MS = 8000;
const BACKFILL_QUERY_COOLDOWN_MS = 12000;
const BACKFILL_MAX_QUERY_ATTEMPTS = 4;
const BACKFILL_DATE_WINDOW_MS = 86400000;
const DOWNLOAD_MIN_PLAYBACK_MS = 4500;
const DOWNLOAD_IDLE_COMPLETE_MS = 3000;
const DOWNLOAD_NO_VIDEO_TIMEOUT_MS = 10000;

// Housekeeping loop and startup snapshot probe intervals.
const HOUSEKEEPING_INTERVAL_MS = 500;
const STARTUP_PROBE_READY_DELAY_MS = 6000;
const STARTUP_PROBE_HOLD_MS = 25000;

let cams = [];
let bySerial = new Map();
let isShuttingDownFn = () => false;

const stationTransitions = new Map();
const stationNextWakeAt = new Map();
const getStationTransition = (cam) => stationTransitions.get(getStationKey(cam)) || Promise.resolve();
const setStationTransition = (cam, p) => stationTransitions.set(getStationKey(cam), p);

/**
 * Initializes the orchestrator with the active camera collection and shutdown state accessor.
 *
 * @param {Array<Record<string, *>>} cameraList - Configured Camera instances.
 * @param {Map<string, Record<string, *>>} serialMap - Map of serial -> Camera instance.
 * @param {() => boolean} shuttingDownGetter - Function returning true when shutting down.
 */
function initOrchestrator(cameraList, serialMap, shuttingDownGetter) {
  cams = cameraList;
  bySerial = serialMap;
  isShuttingDownFn = shuttingDownGetter;
  setRtspDropHandler(handleRtspStreamDropped);
}

/**
 * Comparator that orders wanting cameras so motion events beat viewer requests, higher
 * effective priority beats lower priority, and newer requests beat older ones.
 *
 * @param {Record<string, *>} a - First candidate camera.
 * @param {Record<string, *>} b - Second candidate camera.
 * @returns {number}
 */
function compareWantingCameras(a, b) {
  const aMotion = Number(inMotion(a));
  const bMotion = Number(inMotion(b));
  if (bMotion !== aMotion) {
    return bMotion - aMotion;
  }
  if (aMotion) {
    const prioDiff = getEffectivePriority(b) - getEffectivePriority(a);
    if (prioDiff !== 0) {
      return prioDiff;
    }
    return b.lastMotionAt - a.lastMotionAt;
  }
  return b.viewSince - a.viewSince;
}

/**
 * Determines whether candidate camera 'pick' is allowed to preempt currently active camera 'cur'
 * on the same station P2P slot.
 *
 * @param {Record<string, *>} pick - Highest-priority waiting camera.
 * @param {Record<string, *>} cur - Currently active camera on the station P2P slot.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {boolean} [preemptEqual=PREEMPT_EVENT_STREAMS] - Whether equal-priority newer motion preempts.
 * @returns {boolean}
 */
function canPreemptActiveStream(pick, cur, now, preemptEqual = PREEMPT_EVENT_STREAMS) {
  if (!inMotion(pick)) {
    return !inMotion(cur) && pick.viewSince > cur.viewSince;
  }
  if (!inMotion(cur)) {
    return true;
  }

  const pickScore = getEffectivePriority(pick);
  const curScore = getEffectivePriority(cur);
  const curFinishedOrStalled =
      cur.motionClearedAt > cur.lastMotionAt || (!cur.gotVideo && now - cur.startedAt >= P2P_WAKE_STALL_PREEMPT_MS);

  if (pickScore > curScore) {
    return true;
  }
  if (pickScore === curScore && pick.lastMotionAt > cur.lastMotionAt) {
    return Boolean(preemptEqual || curFinishedOrStalled);
  }
  return Boolean(curFinishedOrStalled);
}

/**
 * Resolves the structured initiator tag when 'pick' preempts 'cur' on a station P2P slot.
 *
 * @param {Record<string, *>} pick - Preempting camera.
 * @param {Record<string, *>} cur - Preempted camera.
 * @returns {string}
 */
function resolvePreemptInitiator(pick, cur) {
  if (!inMotion(pick)) {
    return 'bridge-arbitrator/newer-viewer';
  }
  if (!inMotion(cur)) {
    return 'bridge-arbitrator/motion-over-viewer';
  }
  if (getEffectivePriority(pick) > getEffectivePriority(cur)) {
    return 'bridge-arbitrator/higher-priority-event';
  }
  return 'bridge-arbitrator/newer-motion';
}

/**
 * Evaluates whether an active motion-woken camera can go to sleep early to conserve battery.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function evaluateEarlySleep(cam, now) {
  if (EARLY_SLEEP_MS <= 0 || !cam.active || !inMotion(cam) || now < cam.viewUntil) {
    return;
  }
  if (!cam.gotVideo || now - cam.firstVideoAt < EARLY_SLEEP_MS) {
    return;
  }
  if (now - cam.lastEarlySleepCheckAt < EARLY_SLEEP_POLL_INTERVAL_MS) {
    return;
  }

  const clearedByEufy = cam.motionClearedAt > cam.lastMotionAt && now - cam.motionClearedAt >= EUFY_CLEARED_SETTLE_MS;
  const elapsedQuiet = now - cam.lastMotionAt >= EARLY_SLEEP_MS;
  if (!clearedByEufy && !elapsedQuiet) {
    return;
  }

  cam.lastEarlySleepCheckAt = now;
  const frigateIdle = await isFrigateCameraIdle(cam);
  if (!cam.active || !inMotion(cam) || now < cam.viewUntil) {
    return;
  }

  if (frigateIdle && Date.now() - cam.lastMotionAt >= Math.min(EARLY_SLEEP_MS, MIN_EVENT_VIDEO_DURATION_MS)) {
    const quietSecs = Math.round((Date.now() - cam.lastMotionAt) / 1000);
    const initiator = clearedByEufy
        ? 'bridge-early-sleep/eufy-cleared'
        : 'bridge-early-sleep/quiet-timeout';
    cam.motionUntil = Date.now();
    stop(
        cam,
        'motion cleared early (battery saver, quietFor=' + quietSecs + 's, frigateIdle=true)',
        false,
        initiator
    );
    arbitrate();
  }
}

/**
 * Checks whether an active camera stream that is within 4s of timing out still has an
 * in-progress object detection in Frigate, extending the hold by HOLD_MS / 2 (+30s) up to MAX_MS.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function evaluateActiveHoldExtension(cam, now) {
  if (!cam.active || !cam.gotVideo || cam.activeMode === 'download' || cam.isStartupProbe) {
    return;
  }
  const remainingMs = want(cam) - now;
  const nearMaxLimit = now - cam.startedAt >= MAX_MS - MAX_HOLD_SAFETY_MARGIN_MS;
  if (remainingMs > HOLD_EXTEND_CHECK_WINDOW_MS || nearMaxLimit) {
    return;
  }
  if (now - (cam.lastExtendCheckAt || 0) < HOLD_EXTEND_POLL_COOLDOWN_MS) {
    return;
  }

  cam.lastExtendCheckAt = now;
  const frigateIdle = await isFrigateCameraIdle(cam);
  if (!cam.active || frigateIdle) {
    return;
  }

  const {extendMs, holdSecs} = extendActiveCameraHold(cam, Date.now(), false);
  const liveSecs = Math.round((Date.now() - cam.startedAt) / 1000);
  log.info(
      cam,
      'active object still in progress in Frigate, extended stream hold by +' +
      Math.round(extendMs / 1000) +
      's (holdExtendedTo=' +
      holdSecs +
      's, live=' +
      liveSecs +
      's)'
  );
}

/**
 * Extends an active camera hold timer by half of its base hold duration (HOLD_MS / 2)
 * up to MAX_MS (and optionally capped at now + HOLD_MS for early re-triggers).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {boolean} [capAtFullHold=true] - Whether to cap the new hold at now + HOLD_MS.
 * @returns {{ extendMs: number, holdSecs: number }}
 */
function extendActiveCameraHold(cam, now, capAtFullHold = true) {
  const baseHoldMs = isLowBattery(cam) ? Math.min(HOLD_MS, LOW_BAT_HOLD_MS) : HOLD_MS;
  const extendMs = Math.max(MIN_HOLD_EXTENSION_MS, Math.round(baseHoldMs / 2));
  const maxAllowedUntil = cam.startedAt + MAX_MS;
  const uncappedNext = Math.min(maxAllowedUntil, Math.max(want(cam), now) + extendMs);
  const nextUntil = capAtFullHold ? Math.min(now + baseHoldMs, uncappedNext) : uncappedNext;
  if (inMotion(cam)) {
    cam.motionUntil = Math.max(cam.motionUntil, nextUntil);
  } else {
    cam.viewUntil = Math.max(cam.viewUntil, nextUntil);
  }
  return {extendMs, holdSecs: Math.round((want(cam) - now) / 1000)};
}

/**
 * Computes the target expiration timestamp for a motion or view trigger, applying
 * a half-hold extension (ms / 2) when extending an already-active stream.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} ms - Requested hold duration in milliseconds.
 * @param {boolean} isMidStream - Whether this trigger is extending an active mid-stream session.
 * @returns {number}
 */
function computeTriggerHoldUntil(cam, now, ms, isMidStream) {
  if (!isMidStream) {
    return now + ms;
  }
  const halfMs = Math.max(MIN_TRIGGER_EXTENSION_MS, Math.round(ms / 2));
  const maxAllowedUntil = cam.active && cam.startedAt ? cam.startedAt + MAX_MS : now + MAX_MS;
  return Math.min(maxAllowedUntil, now + ms, Math.max(want(cam), now) + halfMs);
}

/**
 * Wakes or extends a camera stream in response to an external /api/wake HTTP request.
 * Uses the 'view' hold path by default (matching UI viewer clicks).
 *
 * @param {Record<string, *>} cam - Target Camera instance.
 * @param {{ durationMs: number, reason: string, createEvent: boolean, delayMs?: number }} opts - Wake options.
 * @returns {{ camera: string, title: string, status: string, mode: string, hold_secs: number, delay_ms: number }}
 */
function wakeCameraExternal(cam, opts) {
  const {durationMs, reason, createEvent, delayMs} = opts;
  const now = Date.now();
  cam.isStartupProbe = false;
  cam.needsStartupSnapshot = false;
  if (cam.useRtsp && cam.rtspUrl && !cam.active) {
    cam.rtspFallbackUntil = 0;
  }

  const applyWakeTrigger = (wakeReason, wakeDurationMs, wakeCreateEvent) => {
    if (isShuttingDownFn()) {
      return;
    }
    cam.lastApiWakeAt = Date.now();
    if (wakeCreateEvent) {
      cam.motionClearedAt = 0;
      trigger(cam, wakeReason, wakeDurationMs, 'motion', 'api-wake', API_WAKE_EVENT_PRIORITY);
      if (cam.active && cam.activeMode !== 'download') {
        frigateEvent(cam, 'motion detected', '');
      }
    } else {
      trigger(cam, wakeReason, wakeDurationMs, 'view', 'api-wake');
    }
  };

  if (cam.active) {
    if (cam.apiWakeTimer) {
      clearTimeout(cam.apiWakeTimer);
      cam.apiWakeTimer = null;
      cam.apiWakePendingOpts = null;
    }
    applyWakeTrigger(reason, durationMs, createEvent);
    if (cam.activeMode === 'rtsp' && !cam.gotVideo && now - cam.startedAt > API_WAKE_STALLED_RTSP_MS) {
      log.info(
          cam,
          'refreshing stalled RTSP wake on new api-wake "' + reason + '" (session=' + cam.sessionId + ')'
      );
      cam.startedAt = now;
      cam.lastStartAt = now;
      cam.restarts = 0;
      stopDecoder(cam);
      void startRtspStream(cam);
    }
    return {
      camera: cam.name,
      title: cam.title || cam.name,
      status: 'extended',
      mode: cam.activeMode || (isRtspCapable(cam) ? 'rtsp' : 'p2p'),
      hold_secs: Math.round(durationMs / 1000),
      delay_ms: 0,
    };
  }

  if (cam.apiWakeTimer) {
    cam.apiWakePendingOpts = {
      durationMs: Math.max(cam.apiWakePendingOpts ? cam.apiWakePendingOpts.durationMs : 0, durationMs),
      reason,
      createEvent: Boolean(
          (cam.apiWakePendingOpts && cam.apiWakePendingOpts.createEvent) || createEvent
      ),
    };
    const remainingDelayMs = Math.max(0, (cam.apiWakeScheduledAt || now) - now);
    log.debug(
        cam,
        'coalesced duplicate api-wake "' +
        reason +
        '" into pending wake timer (in ' +
        remainingDelayMs +
        'ms)'
    );
    return {
      camera: cam.name,
      title: cam.title || cam.name,
      status: 'scheduled',
      mode: isRtspCapable(cam) ? 'rtsp' : 'p2p',
      hold_secs: Math.round(cam.apiWakePendingOpts.durationMs / 1000),
      delay_ms: remainingDelayMs,
    };
  }

  const stationKey = getStationKey(cam);
  const nextSlotAt = Math.max(now, stationNextWakeAt.get(stationKey) || 0);
  const effectiveDelayMs =
      delayMs !== undefined ? delayMs : Math.max(0, nextSlotAt - now);
  stationNextWakeAt.set(stationKey, now + effectiveDelayMs + STATION_WAKE_PACING_MS);

  if (effectiveDelayMs > 0) {
    cam.apiWakePendingOpts = {durationMs, reason, createEvent};
    cam.apiWakeScheduledAt = now + effectiveDelayMs;
    cam.apiWakeTimer = setTimeout(() => {
      const pending = cam.apiWakePendingOpts || {durationMs, reason, createEvent};
      cam.apiWakeTimer = null;
      cam.apiWakePendingOpts = null;
      cam.apiWakeScheduledAt = 0;
      applyWakeTrigger(pending.reason, pending.durationMs, pending.createEvent);
    }, effectiveDelayMs);
  } else {
    applyWakeTrigger(reason, durationMs, createEvent);
  }

  return {
    camera: cam.name,
    title: cam.title || cam.name,
    status: effectiveDelayMs > 0 ? 'scheduled' : 'waking',
    mode: isRtspCapable(cam) ? 'rtsp' : 'p2p',
    hold_secs: Math.round(durationMs / 1000),
    delay_ms: effectiveDelayMs,
  };
}

/**
 * Extends a camera's wake timer for either a motion event or an active live viewer and runs
 * stream arbitration across all cameras.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} reason - Description of what triggered the wake request.
 * @param {number} ms - Duration in milliseconds to hold the camera awake.
 * @param {'motion'|'view'} kind - Type of wake trigger.
 * @param {string} [initiator=''] - Who initiated the wake trigger ('eufy-event', 'viewer', 'bridge-probe', 'api-wake', 'eufy-ws').
 * @param {number} [evPriority=DEFAULT_EVENT_PRIORITY] - Event priority boost score.
 */
function trigger(cam, reason, ms, kind, initiator = '', evPriority = DEFAULT_EVENT_PRIORITY) {
  const now = Date.now();
  if (!isWsReady()) {
    return;
  }
  const resolvedInitiator = initiator || (kind === 'motion' ? 'eufy-event' : 'viewer');
  if (now >= want(cam)) {
    cam.reason = reason;
    cam.wakeInitiator = resolvedInitiator;
  }

  if (kind === 'motion') {
    if (!inMotion(cam) && !cam.active) {
      cam.reason = reason;
      cam.wakeInitiator = resolvedInitiator;
      cam.eventPriority = evPriority;
    } else if (evPriority >= (cam.eventPriority || 0)) {
      cam.eventPriority = evPriority;
      cam.reason = reason;
    }
    const prevMotionAt = cam.lastMotionAt || 0;
    const prevPriority = cam.eventPriority || 0;
    const isMidStreamEvent = cam.active && now - cam.startedAt > MID_STREAM_EVENT_GRACE_MS;
    const targetUntil = computeTriggerHoldUntil(cam, now, ms, isMidStreamEvent);
    cam.eventActive = true;
    cam.motionUntil = Math.max(cam.motionUntil, targetUntil);
    cam.lastMotionAt = now;
    if (cam.active) {
      const holdSecs = Math.round((want(cam) - now) / 1000);
      const ecoNote = isLowBattery(cam) ? ', low-battery eco hold ' + Math.round(ms / 1000) + 's' : '';
      const logFn =
          now - prevMotionAt < COMPANION_MOTION_LOG_DEBOUNCE_MS && evPriority <= prevPriority
              ? log.debug
              : log.info;
      logFn(
          cam,
          'activity trigger "' +
          reason +
          '" (initiator=' +
          resolvedInitiator +
          ', already live, holdExtendedTo=' +
          holdSecs +
          's, priority=' +
          getEffectivePriority(cam) +
          ecoNote +
          ')'
      );
    }
  } else {
    if (!isRtspCapable(cam) && now >= cam.viewUntil) {
      for (const other of cams) {
        if (
            other !== cam &&
            !isRtspCapable(other) &&
            getStationKey(other) === getStationKey(cam) &&
            (other.viewUntil > 0 || other.hasWakingViewer())
        ) {
          clearViewerQueue(other, 'superseded by P2P viewer on ' + cam.name);
        }
      }
    }
    if (now >= cam.viewUntil) {
      cam.viewSince = now;
    }
    const isMidStreamView =
        cam.active &&
        now - cam.startedAt > MID_STREAM_EVENT_GRACE_MS &&
        (resolvedInitiator === 'eufy-ws' || resolvedInitiator === 'api-wake');
    const targetViewUntil = computeTriggerHoldUntil(cam, now, ms, isMidStreamView);
    cam.viewUntil = Math.max(cam.viewUntil, targetViewUntil);
    if (cam.active && resolvedInitiator === 'api-wake') {
      const holdSecs = Math.round((want(cam) - now) / 1000);
      const prevApiLogAt = cam.lastApiTriggerLogAt || 0;
      const logFn = now - prevApiLogAt < API_TRIGGER_LOG_DEBOUNCE_MS ? log.debug : log.info;
      cam.lastApiTriggerLogAt = now;
      logFn(
          cam,
          'activity trigger "' +
          reason +
          '" (initiator=api-wake, already live, holdExtendedTo=' +
          holdSecs +
          's)'
      );
    }
  }
  arbitrate();
}

/**
 * Wakes a single RTSP-capable camera in parallel without consuming a station P2P slot.
 *
 * @param {Record<string, *>} rCam - RTSP-capable Camera instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function activateRtspCamera(rCam, now) {
  const stationKey = getStationKey(rCam);
  stationNextWakeAt.set(stationKey, Math.max(stationNextWakeAt.get(stationKey) || 0, now + STATION_WAKE_PACING_MS));
  rCam.eventActive = inMotion(rCam);
  rCam.pendingBackfill = null;
  rCam.beginSession('rtsp', now, true);
  pushFrameToEncoder(rCam, now);
  log.info(
      rCam,
      'WAKE [RTSP] (initiator=' +
      (rCam.wakeInitiator || 'bridge') +
      ', reason="' +
      rCam.reason +
      '", priority=' +
      getEffectivePriority(rCam) +
      ', session=' +
      rCam.sessionId +
      ')'
  );
  void startRtspStream(rCam);
}

/**
 * Arbitrates the P2P livestream slot for a single stationSerial group.
 *
 * @param {string} stationKey - Station serial identifier.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function arbitrateStationP2pSlot(stationKey, now) {
  const stationCams = cams.filter((c) => !isRtspCapable(c) && getStationKey(c) === stationKey);
  let cur = stationCams.find((c) => usesP2pSlot(c));

  if (cur && cur.activeMode !== 'download' && now >= want(cur)) {
    stop(cur, 'hold/view timer expired, no more activity or viewers', false, 'bridge-timer');
    cur = null;
  }

  const wanting = stationCams.filter((c) => !c.active && now < want(c));
  if (!wanting.length || !isWsReady()) {
    return;
  }

  const pick = wanting.sort(compareWantingCameras)[0];

  if (cur && cur.activeMode === 'download') {
    if (cur.isTestBackfill && !inMotion(pick)) {
      return;
    }
    stop(
        cur,
        'backfill download preempted by live request on ' + pick.name + ' (' + pick.reason + ')',
        !inMotion(pick),
        'bridge-arbitrator/live-over-download'
    );
    cur = null;
  }

  if (cur) {
    if (!canPreemptActiveStream(pick, cur, now)) {
      for (const c of wanting) {
        if (!inMotion(c)) {
          clearViewerQueue(c, 'blocked by active stream on ' + cur.name);
        } else if (!PREEMPT_EVENT_STREAMS && c.lastMotionAt > cur.lastMotionAt) {
          c.motionUntil = 0;
          c.eventPriority = 0;
        }
        pushFrameToEncoder(c, now);
      }
      return;
    }

    const pickScore = getEffectivePriority(pick);
    const curScore = getEffectivePriority(cur);
    const preemptInitiator = resolvePreemptInitiator(pick, cur);
    stop(
        cur,
        'preempted by ' + pick.name + ' (' + pick.reason + ', priority=' + pickScore + ' vs ' + curScore + ')',
        !inMotion(pick),
        preemptInitiator
    );
  }

  for (const c of wanting) {
    if (c !== pick && !inMotion(c)) {
      clearViewerQueue(c, 'not selected by arbitrator, ' + pick.name + ' won station slot');
    }
  }

  stationNextWakeAt.set(stationKey, Math.max(stationNextWakeAt.get(stationKey) || 0, now + STATION_WAKE_PACING_MS));
  pick.eventActive = inMotion(pick);
  pick.beginSession('p2p', now, false);
  pushFrameToEncoder(pick, now);
  const ecoTag = isLowBattery(pick) ? ' [low-battery economy mode]' : '';
  log.info(
      pick,
      'WAKE (initiator=' +
      (pick.wakeInitiator || 'bridge') +
      ', reason="' +
      pick.reason +
      '", station=' +
      stationKey +
      ', priority=' +
      getEffectivePriority(pick) +
      ', session=' +
      pick.sessionId +
      ')' +
      ecoTag
  );
  if (pick.eventActive) {
    frigateEvent(pick, pick.reason, pick.pendingBackfill ? pick.pendingBackfill.personName : '');
  }
  void startLivestream(pick);
}

/**
 * Arbitrates RTSP and per-station P2P camera streams across all configured cameras.
 */
function arbitrate() {
  const now = Date.now();

  for (const rCam of cams.filter((c) => c.active && c.activeMode === 'rtsp')) {
    if (now >= want(rCam)) {
      stop(rCam, 'RTSP hold/view timer expired', false, 'bridge-timer');
    }
  }

  for (const rCam of cams.filter((c) => !c.active && now < want(c) && isRtspCapable(c))) {
    activateRtspCamera(rCam, now);
  }

  const stationKeys = new Set(cams.filter((c) => !isRtspCapable(c)).map((c) => getStationKey(c)));
  for (const stationKey of stationKeys) {
    arbitrateStationP2pSlot(stationKey, now);
  }
}

/**
 * Starts a HomeBase RTSP pull stream for a camera and requests device.start_rtsp_livestream.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
async function startRtspStream(cam) {
  if (!cam.active || cam.activeMode !== 'rtsp' || !cam.rtspUrl) {
    return;
  }
  const mySession = cam.sessionId;
  cam.lastStartAt = Date.now();
  if (cam.eventActive && !cam.rtspRewaking && cam.restarts === 0) {
    frigateEvent(cam, cam.reason, '');
  }
  await call({
    command: 'device.set_property',
    serialNumber: cam.serial,
    name: 'rtspStream',
    value: true,
  });
  if (!cam.active || cam.sessionId !== mySession || cam.activeMode !== 'rtsp') {
    return;
  }
  const r = await call({command: 'device.start_rtsp_livestream', serialNumber: cam.serial});
  if (!r.success && r.errorCode && !/already_running/i.test(r.errorCode)) {
    log.debug(
        cam,
        'device.start_rtsp_livestream returned ' +
        r.errorCode +
        ' (relying on rtspStream property wake)'
    );
  }
  if (cam.active && cam.sessionId === mySession && cam.activeMode === 'rtsp' && cam.rtspUrl && !cam.dec) {
    startRtspDecoder(cam, cam.rtspUrl);
  }
}

/**
 * Handles station database query results ("database query local" / "database query latest")
 * to locate and download missed event clips from the HomeBase internal storage.
 *
 * @param {Record<string, *>} e - Station event payload from eufy-security-ws.
 */
function handleDatabaseQueryResult(e) {
  const rows = Array.isArray(e.data) ? e.data : [];
  log.info(
      'bridge',
      'received HomeBase (' +
      (e.serialNumber || 'station') +
      ') event "' +
      e.event +
      '" (returnCode=' +
      (e.returnCode ?? 'n/a') +
      ', records=' +
      rows.length +
      ')'
  );
  if (!rows.length) {
    return;
  }

  const candidates = rows.map(extractDatabaseRecordCandidate).filter(Boolean);
  candidates.sort((a, b) => b.clipMs - a.clipMs);

  let matchedAny = false;
  for (const cand of candidates) {
    const cam = bySerial.get(cand.devSn);
    if (!cam || !cam.pendingBackfill || cam.backfillClip) {
      continue;
    }
    const job =
        cam.pendingBackfill instanceof BackfillJob
            ? cam.pendingBackfill
            : new BackfillJob(cam.pendingBackfill);
    if (!job.matchesCandidate(cand, cam.downloadedPaths)) {
      continue;
    }

    cam.backfillClip = job.toMatchedClip(cand);
    matchedAny = true;
    log.info(
        cam,
        'matched recorded HomeBase clip for backfill (path="' +
        cand.storagePath +
        '", cipherId=' +
        cand.cipherId +
        ', reason="' +
        cam.pendingBackfill.reason +
        '")'
    );
  }

  if (matchedAny) {
    void processBackfillQueue(Date.now());
  }
}

/**
 * Queries the HomeBase local database and starts downloading a missed event clip when the P2P slot is idle.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function processBackfillQueue(now) {
  if (!BACKFILL_DOWNLOADS || !isWsReady() || isShuttingDownFn()) {
    return;
  }
  if (cams.some((c) => usesP2pSlot(c) || (!c.active && !isRtspCapable(c) && now < want(c)))) {
    return;
  }
  const hasUrgentTest = cams.some((c) => c.pendingBackfill && c.pendingBackfill.ignoreTimeWindow);
  const lastP2pActivity = Math.max(0, ...cams.map((c) => c.sleptAt || 0));
  if (!hasUrgentTest && now - lastP2pActivity < BACKFILL_DELAY_MS) {
    return;
  }

  for (const c of cams) {
    const job = c.pendingBackfill;
    const expired =
        job &&
        (typeof job.isExpired === 'function'
            ? job.isExpired(now)
            : now - job.at > DEFAULT_BACKFILL_MAX_AGE_MS);
    if (expired) {
      log.debug(c, 'expired unfulfilled backfill request (' + job.reason + ')');
      c.pendingBackfill = null;
      c.backfillClip = null;
    }
  }

  const readyCam = cams
      .filter((c) => c.backfillClip && !c.active)
      .sort((a, b) => (b.pendingBackfill?.priority || 0) - (a.pendingBackfill?.priority || 0))[0];

  if (readyCam) {
    const clip = readyCam.backfillClip;
    const isTest = Boolean(readyCam.pendingBackfill && readyCam.pendingBackfill.ignoreTimeWindow);
    readyCam.backfillClip = null;
    readyCam.pendingBackfill = null;
    readyCam.downloadedPaths.add(clip.storagePath);

    readyCam.isTestBackfill = isTest;
    readyCam.downloadFinished = false;
    readyCam.downloadFrames = [];
    readyCam.eventActive = false;
    readyCam.reason = 'backfill: ' + clip.reason;
    readyCam.wakeInitiator = 'bridge-backfill';
    readyCam.beginSession('download', now, true);
    pushFrameToEncoder(readyCam, now);

    log.info(
        readyCam,
        'WAKE [BACKFILL DOWNLOAD] (initiator=bridge-backfill, reason="' +
        clip.reason +
        '", path="' +
        clip.storagePath +
        '", session=' +
        readyCam.sessionId +
        ')'
    );
    frigateEvent(readyCam, clip.event || 'motion detected', clip.personName || '');

    const res = await call({
      command: 'device.start_download',
      serialNumber: readyCam.serial,
      path: clip.storagePath,
      cipherId: clip.cipherId,
    });
    if (!res.success) {
      log.warn(
          readyCam,
          'device.start_download failed (errorCode=' + (res.errorCode || 'unknown') + ')'
      );
      stop(readyCam, 'start_download RPC failed', false, 'error/download-failed');
    }
    return;
  }

  const queryCam = cams
      .filter(
          (c) =>
              c.pendingBackfill &&
              !c.backfillClip &&
              now - c.pendingBackfill.at >= BACKFILL_MIN_EVENT_AGE_MS &&
              now - c.lastBackfillQueryAt >= BACKFILL_QUERY_COOLDOWN_MS
      )
      .sort((a, b) => b.pendingBackfill.priority - a.pendingBackfill.priority)[0];

  if (!queryCam) {
    return;
  }
  queryCam.lastBackfillQueryAt = now;
  if (++queryCam.pendingBackfill.attempts > BACKFILL_MAX_QUERY_ATTEMPTS) {
    log.debug(
        queryCam,
        'giving up on backfill query after ' + BACKFILL_MAX_QUERY_ATTEMPTS + ' attempts (' + queryCam.pendingBackfill.reason + ')'
    );
    queryCam.pendingBackfill = null;
    return;
  }

  const stationSn =
      queryCam.stationSerial ||
      cams.find((c) => c.stationSerial && c.stationSerial.startsWith('T8030'))?.stationSerial ||
      cams.find((c) => c.stationSerial)?.stationSerial ||
      '';
  if (!stationSn) {
    log.warn(queryCam, 'cannot query backfill clip: stationSerial not yet known');
    return;
  }

  const dStart = new Date(now - BACKFILL_DATE_WINDOW_MS);
  const dEnd = new Date(now + BACKFILL_DATE_WINDOW_MS);
  const fmtYmd = (d) =>
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');

  log.info(
      queryCam,
      'querying HomeBase (' +
      stationSn +
      ') local database for missed event clip (attempt=' +
      queryCam.pendingBackfill.attempts +
      '/' +
      BACKFILL_MAX_QUERY_ATTEMPTS +
      ', reason="' +
      queryCam.pendingBackfill.reason +
      '")'
  );
  await call({command: 'station.connect', serialNumber: stationSn});
  await call({
    command: 'station.database_query_latest_info',
    serialNumber: stationSn,
  });
  await call({
    command: 'station.database_query_by_date',
    serialNumber: stationSn,
    serialNumbers: [queryCam.serial],
    startDate: fmtYmd(dStart),
    endDate: fmtYmd(dEnd),
  });
}

/**
 * Sends device.start_livestream to eufy-security-ws for the specified camera.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
async function startLivestream(cam) {
  if (cam.starting || !cam.active) {
    return;
  }
  cam.starting = true;
  const mySession = cam.sessionId;

  const runStart = async () => {
    try {
      await getStationTransition(cam);
      if (!cam.active || cam.sessionId !== mySession) {
        log.debug(
            cam,
            'aborted start_livestream before RPC call (initiator=bridge, reason=session_canceled_or_preempted, session=' +
            mySession +
            ')'
        );
        return;
      }

      for (let i = 0; i < RTSP_HANDSHAKE_MAX_POLLS; i++) {
        const rtspWaking = cams.some(
            (c) =>
                c !== cam &&
                c.active &&
                c.activeMode === 'rtsp' &&
                !c.gotVideo &&
                Date.now() - c.startedAt < RTSP_HANDSHAKE_WINDOW_MS &&
                getStationKey(c) === getStationKey(cam)
        );
        if (!rtspWaking || !cam.active || cam.sessionId !== mySession) {
          break;
        }
        await sleep(RTSP_HANDSHAKE_POLL_MS);
      }
      if (!cam.active || cam.sessionId !== mySession) {
        return;
      }

      cam.p2pReady = true;
      cam.lastStartAt = Date.now();
      let r = await call({command: 'device.start_livestream', serialNumber: cam.serial});

      if (!cam.active || cam.sessionId !== mySession) {
        if (r.success) {
          log.info(
              cam,
              'stopping newly woken stream because session ' +
              mySession +
              ' was preempted/closed during wake (initiator=bridge)'
          );
          await call({command: 'device.stop_livestream', serialNumber: cam.serial});
        }
        return;
      }

      if (!r.success && /already_running/.test(r.errorCode || '')) {
        log.warn(
            cam,
            'eufy-security-ws reports stale livestream (errorCode=' +
            r.errorCode +
            '), forcing stop and restart (initiator=bridge/eufy-ws, session=' +
            mySession +
            ')'
        );
        cam.p2pReady = false;
        await call({command: 'device.stop_livestream', serialNumber: cam.serial});
        await sleep(ALREADY_RUNNING_RESTART_DELAY_MS);
        if (!cam.active || cam.sessionId !== mySession) {
          return;
        }
        cam.p2pReady = true;
        cam.lastStartAt = Date.now();
        r = await call({command: 'device.start_livestream', serialNumber: cam.serial});
        if (!cam.active || cam.sessionId !== mySession) {
          if (r.success) {
            log.info(
                cam,
                'stopping restarted stream because session ' +
                mySession +
                ' was preempted/closed during retry (initiator=bridge)'
            );
            await call({command: 'device.stop_livestream', serialNumber: cam.serial});
          }
          return;
        }
      }

      if (!r.success) {
        log.error(
            cam,
            'start_livestream failed (initiator=eufy-ws, errorCode=' +
            (r.errorCode || 'unknown') +
            ', session=' +
            mySession +
            ')'
        );
        if (cam.active && cam.sessionId === mySession) {
          cam.lastStartAt = Date.now() - FAILED_START_BACKOFF_MS;
        }
      }
    } finally {
      if (cam.sessionId === mySession) {
        cam.starting = false;
      }
    }
  };

  cam.startPromise = runStart();
  return cam.startPromise;
}

/**
 * Stops an active camera's P2P/RTSP/download session, waits for any in-flight startPromise,
 * tears down the decoder, and refreshes the sleeping card with the camera's own last frame.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} why - Reason the camera is going to sleep.
 * @param {boolean} [preemptedByViewer=false] - True if stopped because the user opened another camera.
 * @param {string} [initiator='bridge'] - Decision maker identifier.
 */
function stop(cam, why, preemptedByViewer = false, initiator = 'bridge') {
  if (!cam.active) {
    return;
  }
  const now = Date.now();
  const inFlightStart = cam.startPromise;
  const hadVideo = cam.gotVideo;
  const liveSecs = Math.round((now - cam.startedAt) / 1000);
  const lastVideoAgo = cam.lastVideoAt ? ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
  const restartsCount = cam.restarts;
  const closedSession = cam.sessionId;
  const closedMode = cam.activeMode || 'p2p';

  if (cam.apiWakeTimer) {
    clearTimeout(cam.apiWakeTimer);
    cam.apiWakeTimer = null;
    cam.apiWakePendingOpts = null;
    cam.apiWakeScheduledAt = 0;
  }
  if (Buffer.isBuffer(cam.frame) && cam.frame.length === FRAME) {
    cam.lastFrame = Buffer.from(cam.frame);
  }
  cam.endSession(now, hadVideo, preemptedByViewer, closedMode);

  const sleepMsg =
      'SLEEP (initiator=' +
      initiator +
      ', reason="' +
      why +
      '", live=' +
      liveSecs +
      's, gotVideo=' +
      hadVideo +
      ', lastVideoAgo=' +
      lastVideoAgo +
      ', restarts=' +
      restartsCount +
      ', session=' +
      closedSession +
      ')';

  if (initiator.startsWith('error/')) {
    log.error(cam, sleepMsg);
  } else if (initiator === 'bridge-max-limit') {
    log.warn(cam, sleepMsg);
  } else {
    log.info(cam, sleepMsg);
  }

  stopDecoder(cam);

  setStationTransition(
      cam,
      getStationTransition(cam)
          .then(async () => {
            if (inFlightStart) {
              try {
                await inFlightStart;
              } catch (err) {
                // Ignore errors from canceled start promise.
              }
            }
            switch (closedMode) {
              case 'rtsp':
                await sleep(RTSP_STOP_SETTLE_MS);
                break;
              case 'download':
                await call({command: 'device.cancel_download', serialNumber: cam.serial});
                await sleep(P2P_STOP_SETTLE_MS);
                break;
              default: {
                const res = await call({command: 'device.stop_livestream', serialNumber: cam.serial});
                if (!res.success && res.errorCode && !/ws_closed|not_running/i.test(res.errorCode)) {
                  log.debug(cam, 'device.stop_livestream returned errorCode=' + res.errorCode);
                }
                await sleep(P2P_STOP_SETTLE_MS);
                break;
              }
            }
          })
          .catch(() => {})
  );

  if (cam.lastFrame) {
    saveCachedFrame(cam);
  }
  renderCameraCards(cam);
  pushFrameToEncoder(cam);

  call({command: 'device.get_properties', serialNumber: cam.serial}).then((res) => {
    if (res.success && res.result && res.result.properties) {
      applyDeviceProperties(cam, res.result.properties, false);
    }
  });
}

/**
 * Handles station-level events ('close', 'connection error', 'connect', and database query results).
 *
 * @param {Record<string, *>} e - Station event object from eufy-security-ws.
 */
function handleStationEvent(e) {
  const stationId = e.serialNumber || 'homebase';
  switch (e.event) {
    case 'close':
    case 'connection error':
      log.warn('bridge', 'HomeBase station (' + stationId + ') P2P disconnected or restarting (' + e.event + ')');
      for (const c of cams) {
        if (c.stationSerial && e.serialNumber && c.stationSerial !== e.serialNumber) {
          continue;
        }
        c.motionUntil = 0;
        clearViewerQueue(c, 'station_disconnected');
        if (c.active) {
          stop(c, 'Station (' + stationId + ') P2P disconnected/restarting', false, 'error/station-disconnect');
        }
      }
      break;
    case 'connect':
      log.info('bridge', 'HomeBase station (' + stationId + ') P2P connected');
      setTimeout(() => {
        if (isWsReady() && !isShuttingDownFn()) {
          void fetchAllCameraTelemetry();
        }
      }, STATION_RECONNECT_TELEMETRY_DELAY_MS);
      break;
    default:
      if (e.event && e.event.includes('database query')) {
        handleDatabaseQueryResult(e);
      }
      break;
  }
}

/**
 * Handles 'download finished' events from eufy-security-ws for post-event clip backfill.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function handleDownloadFinishedEvent(cam) {
  if (!cam.active || cam.activeMode !== 'download') {
    return;
  }
  cam.downloadFinished = true;
  if (cam.downloadFrames.length > 0) {
    log.info(
        cam,
        'eufy clip transfer complete, playing remaining ' +
        cam.downloadFrames.length +
        ' buffered frames at ' +
        LIVE_FPS +
        ' fps (session=' +
        cam.sessionId +
        ')'
    );
    return;
  }

  const elapsed = Date.now() - cam.startedAt;
  const waitMs = cam.gotVideo && elapsed < DOWNLOAD_MIN_PLAYBACK_MS ? DOWNLOAD_MIN_PLAYBACK_MS - elapsed : 0;
  if (waitMs > 0) {
    const finSession = cam.sessionId;
    setTimeout(() => {
      if (cam.active && cam.activeMode === 'download' && cam.sessionId === finSession) {
        stop(cam, 'post-event clip download finished', false, 'eufy/download-finished');
        arbitrate();
      }
    }, waitMs);
  } else {
    stop(cam, 'post-event clip download finished', false, 'eufy/download-finished');
    arbitrate();
  }
}

/**
 * Handles 'livestream stopped' events from eufy-security-ws.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function handleLivestreamStoppedEvent(cam) {
  const now = Date.now();
  const liveSecs = cam.startedAt ? Math.round((now - cam.startedAt) / 1000) : 0;
  const lastVideoAgo = cam.lastVideoAt ? ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
  cam.p2pReady = false;
  stopDecoder(cam);

  const eufyEndedEventCleanly =
      cam.active &&
      cam.eventActive &&
      LET_EUFY_DECIDE_END &&
      cam.gotVideo &&
      now >= cam.viewUntil &&
      (cam.motionClearedAt > cam.lastMotionAt || now - cam.firstVideoAt >= MIN_CLEAN_EVENT_VIDEO_MS);

  if (eufyEndedEventCleanly) {
    cam.motionUntil = 0;
    stop(cam, 'eufy/camera ended event livestream', false, 'eufy/camera-event-end');
    arbitrate();
    return;
  }

  if (cam.active && now < want(cam)) {
    const remainingSecs = Math.round((want(cam) - now) / 1000);
    log.warn(
        cam,
        'stream interrupted by eufy/camera (initiator=eufy/camera, reason="livestream stopped event while session active", live=' +
        liveSecs +
        's, gotVideo=' +
        cam.gotVideo +
        ', lastVideoAgo=' +
        lastVideoAgo +
        ', remainingHold=' +
        remainingSecs +
        's) - re-requesting livestream'
    );
    void startLivestream(cam);
  } else if (cam.active) {
    stop(cam, 'eufy livestream stopped as hold/view timer expired', false, 'eufy/camera');
  } else {
    log.debug(cam, 'eufy confirmed livestream stopped (initiator=bridge/eufy)');
  }
}

/**
 * Handles Eufy motion/person/pet/ring trigger events (both state=true start and state=false end).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} e - Trigger event payload from eufy-security-ws.
 */
function handleTriggerEvent(cam, e) {
  if (e.state === false) {
    const now = Date.now();
    cam.motionClearedAt = now;
    if (LET_EUFY_DECIDE_END && cam.active && inMotion(cam) && cam.gotVideo) {
      const minEnd = Math.max(now + EUFY_CLEARED_SETTLE_MS, (cam.firstVideoAt || now) + MIN_EVENT_VIDEO_DURATION_MS);
      if (cam.motionUntil > minEnd) {
        cam.motionUntil = minEnd;
        log.info(
            cam,
            'eufy reported activity cleared (event="' +
            e.event +
            '"), ending stream in ' +
            Math.round((minEnd - now) / 1000) +
            's'
        );
        return;
      }
    }
    log.debug(cam, 'eufy reported activity cleared (event="' + e.event + '")');
    return;
  }

  if (e.state === true && Date.now() - getWsReadyAt() > WS_READY_EVENT_SETTLE_MS) {
    cam.motionClearedAt = 0;
    cam.isStartupProbe = false;
    cam.needsStartupSnapshot = false;
    const holdDuration = isLowBattery(cam) ? Math.min(HOLD_MS, LOW_BAT_HOLD_MS) : HOLD_MS;
    const personName = extractRecognizedPerson(e);
    const triggerDesc = personName ? e.event + ' (' + personName + ')' : e.event;
    const evPrio = getEventPriority(e.event);
    if (BACKFILL_DOWNLOADS && !isRtspCapable(cam)) {
      cam.pendingBackfill = new BackfillJob({
        at: Date.now(),
        event: e.event,
        personName,
        reason: triggerDesc,
        priority: cam.priority + evPrio,
        attempts: 0,
      });
    }
    trigger(cam, triggerDesc, holdDuration, 'motion', 'eufy-event', evPrio);
    if (cam.active && cam.activeMode !== 'download') {
      frigateEvent(cam, e.event, personName);
    }
  }
}

/**
 * Attempts to adopt a P2P livestream started externally via eufy-security-ws when the camera
 * is currently idle and outside the post-sleep guard window.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean} True if the external P2P stream was adopted.
 */
function tryAdoptExternalP2pWake(cam, now) {
  const stoppedRef = Math.max(cam.sleptAt || 0, cam.lastStoppedAt || 0);
  if (now - stoppedRef <= EXTERNAL_WAKE_GUARD_MS || isRtspCapable(cam)) {
    return false;
  }
  cam.reason = 'external P2P wake - eufy-security-ws';
  cam.wakeInitiator = 'eufy-ws';
  cam.viewSince = now;
  cam.viewUntil = Math.max(cam.viewUntil, now + HOLD_MS);
  cam.beginSession('p2p', now, true);
  pushFrameToEncoder(cam, now);
  log.info(
      cam,
      'WAKE (initiator=eufy-ws, reason="external P2P wake - eufy-security-ws", station=' +
      getStationKey(cam) +
      ', priority=' +
      getEffectivePriority(cam) +
      ', session=' +
      cam.sessionId +
      ')'
  );
  return true;
}

/**
 * Logs a livestream started event or extends the hold timer by HOLD_MS / 2 if the stream
 * re-triggered mid-session after MID_STREAM_RETRIGGER_GRACE_MS.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} label - Stream label ("eufy RTSP livestream" or "eufy livestream").
 */
function handleStreamStartedOrRetriggered(cam, label) {
  const now = Date.now();
  if (now - (cam.lastStartAt || 0) > MID_STREAM_RETRIGGER_GRACE_MS) {
    const {extendMs, holdSecs} = extendActiveCameraHold(cam, now, true);
    log.info(
        cam,
        label +
        ' re-triggered while active, extended hold by +' +
        Math.round(extendMs / 1000) +
        's (holdExtendedTo=' +
        holdSecs +
        's, session=' +
        cam.sessionId +
        ')'
    );
  } else {
    log.info(cam, label + ' started (session=' + cam.sessionId + ')');
  }
}

/**
 * Handles incoming event notifications from eufy-security-ws.
 *
 * @param {Record<string, *>} e - Event object from eufy-security-ws.
 */
function onEvent(e) {
  if (e.event === 'device added' && e.device && e.device.serialNumber) {
    const cam = bySerial.get(e.device.serialNumber);
    if (cam) {
      applyDeviceProperties(cam, e.device, cam.battery === null);
    }
    return;
  }
  if (e.source === 'station') {
    handleStationEvent(e);
    return;
  }

  const cam = bySerial.get(e.serialNumber);
  if (!cam) {
    return;
  }

  switch (e.event) {
    case 'livestream video data':
      if (!cam.active) {
        const now = Date.now();
        if (tryAdoptExternalP2pWake(cam, now)) {
          onVideo(cam, e);
          return;
        }
        const stoppedRef = Math.max(cam.sleptAt || 0, cam.lastStoppedAt || 0);
        if (now - stoppedRef > UNSOLICITED_VIDEO_STOP_DELAY_MS && now - cam.lastUnsolicitedStopAt > UNSOLICITED_VIDEO_STOP_DELAY_MS) {
          cam.lastUnsolicitedStopAt = now;
          const sleptAgo = stoppedRef ? Math.round((now - stoppedRef) / 1000) + 's' : 'never';
          log.warn(
              cam,
              'received video while inactive, forcing stop of late stream (initiator=bridge, cause=eufy_unsolicited_video, sleptAgo=' +
              sleptAgo +
              ')'
          );
          void call({command: 'device.stop_livestream', serialNumber: cam.serial});
        }
        return;
      }
      onVideo(cam, e);
      return;

    case 'livestream audio data':
      onAudio(cam, e);
      return;

    case 'download video data':
      if (cam.active && cam.activeMode === 'download') {
        onVideo(cam, e);
      }
      return;

    case 'download audio data':
      if (cam.active && cam.activeMode === 'download') {
        onAudio(cam, e);
      }
      return;

    case 'download started':
      if (!cam.active || cam.activeMode !== 'download') {
        void call({command: 'device.cancel_download', serialNumber: cam.serial});
        return;
      }
      cam.p2pReady = true;
      log.info(cam, 'eufy clip download started (session=' + cam.sessionId + ')');
      return;

    case 'download finished':
      handleDownloadFinishedEvent(cam);
      return;

    case 'rtsp livestream started':
      if (!cam.active && isRtspCapable(cam)) {
        const now = Date.now();
        const stoppedRef = Math.max(cam.sleptAt || 0, cam.lastStoppedAt || 0);
        if (now - stoppedRef > EXTERNAL_WAKE_GUARD_MS) {
          trigger(cam, 'external RTSP wake - eufy-security-ws', HOLD_MS, 'view', 'eufy-ws');
          return;
        }
      }
      if (cam.active && cam.activeMode === 'rtsp') {
        if (cam.rtspUrl && !cam.dec) {
          startRtspDecoder(cam, cam.rtspUrl);
        }
        handleStreamStartedOrRetriggered(cam, 'eufy RTSP livestream');
      } else {
        log.debug(cam, 'ignoring RTSP livestream started event while in P2P/idle mode');
      }
      return;

    case 'rtsp livestream stopped':
      if (cam.active && cam.activeMode === 'rtsp') {
        handleRtspStreamDropped(cam, 0, 'rtsp livestream stopped event');
      }
      return;

    case 'livestream started':
      if (!cam.active) {
        if (tryAdoptExternalP2pWake(cam, Date.now())) {
          log.info(cam, 'eufy livestream started (session=' + cam.sessionId + ')');
          return;
        }
        log.warn(
            cam,
            'eufy livestream started after session was already closed/canceled, forcing immediate stop (initiator=bridge, cause=eufy_late_start)'
        );
        void call({command: 'device.stop_livestream', serialNumber: cam.serial});
        return;
      }
      cam.p2pReady = true;
      handleStreamStartedOrRetriggered(cam, 'eufy livestream');
      return;

    case 'livestream stopped':
      handleLivestreamStoppedEvent(cam);
      return;

    case 'property changed':
      if (isTrackedPropertyEvent(e.name)) {
        applyDeviceProperties(cam, {[e.name]: e.value}, false);
      }
      return;

    default:
      if (TRIGGERS.has(String(e.event || '').toLowerCase())) {
        handleTriggerEvent(cam, e);
      }
      return;
  }
}

/**
 * Immediately re-wakes an active RTSP camera when its FFmpeg pull decoder exits or Eufy stops
 * the RTSP feed mid-session while the hold/view timer is still active.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number|null} code - FFmpeg exit code or 0 for WS event.
 * @param {string} reasonText - Exit reason or stderr summary.
 */
function handleRtspStreamDropped(cam, code, reasonText) {
  if (!cam.active || cam.activeMode !== 'rtsp') {
    return;
  }
  const now = Date.now();
  if (LET_EUFY_DECIDE_END || now >= want(cam)) {
    stop(cam, 'eufy ended RTSP livestream', false, 'eufy/rtsp-end');
    arbitrate();
    return;
  }
  stopDecoder(cam);
  cam.rtspRewaking = true;
  cam.rtspRewakeStartedAt = now;
  cam.restarts = 0;
  cam.lastStartAt = now;
  if (cam.viewUntil > now && cam.viewUntil - now < RTSP_REWAKE_MIN_HOLD_MS) {
    cam.viewUntil = now + RTSP_REWAKE_MIN_HOLD_MS;
  }
  if (cam.motionUntil > now && cam.motionUntil - now < RTSP_REWAKE_MIN_HOLD_MS) {
    cam.motionUntil = now + RTSP_REWAKE_MIN_HOLD_MS;
  }
  const remainingSecs = Math.round((want(cam) - now) / 1000);
  log.info(
      cam,
      'RTSP stream ended mid-session (code=' +
      code +
      ', info="' +
      reasonText +
      '", remainingHold=' +
      remainingSecs +
      's), immediately re-waking RTSP stream (session=' +
      cam.sessionId +
      ')'
  );
  void startRtspStream(cam);
}

/**
 * Checks health and retry/fallback conditions for an active RTSP camera session.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} quietSince - Timestamp of last video packet or start attempt.
 */
function checkRtspSessionHealth(cam, now, quietSince) {
  const waitingForWake = !cam.gotVideo || cam.rtspRewaking;
  const wakeQuietSince = cam.rtspRewaking ? cam.lastStartAt : quietSince;
  const wakeStartedAt = cam.rtspRewaking ? cam.rtspRewakeStartedAt || cam.lastStartAt : cam.startedAt;

  if (waitingForWake && now - wakeQuietSince > RTSP_WAKE_RETRY_MS && cam.restarts < RTSP_MAX_WAKE_RETRIES) {
    cam.restarts++;
    cam.lastStartAt = now;
    const retryWaitSecs = (RTSP_WAKE_RETRY_MS / 1000).toFixed(1);
    log.info(
        cam,
        'RTSP ' +
        (cam.rtspRewaking ? 're-wake' : 'wake') +
        ' still waiting for video after ' +
        retryWaitSecs +
        's (retry=' +
        cam.restarts +
        '/' +
        RTSP_MAX_WAKE_RETRIES +
        '), re-sending start_rtsp_livestream (session=' +
        cam.sessionId +
        ')'
    );
    stopDecoder(cam);
    void startRtspStream(cam);
  } else if (waitingForWake && now - wakeStartedAt > RTSP_FALLBACK_TIMEOUT_MS) {
    const p2pSlotBusy = cams.some(
        (c) =>
            c !== cam &&
            getStationKey(c) === getStationKey(cam) &&
            (usesP2pSlot(c) || (!isRtspCapable(c) && now < want(c)))
    );
    if (p2pSlotBusy && cam.restarts < RTSP_MAX_BUSY_P2P_RETRIES) {
      cam.restarts++;
      cam.lastStartAt = now;
      if (cam.rtspRewaking) {
        cam.rtspRewakeStartedAt = now - RTSP_BUSY_RETRY_BACKOFF_MS;
      } else {
        cam.startedAt = now - RTSP_BUSY_RETRY_BACKOFF_MS;
      }
      log.info(
          cam,
          'RTSP wake still waiting while station P2P slot is busy (retry=' +
          cam.restarts +
          '/' +
          RTSP_MAX_BUSY_P2P_RETRIES +
          '), retrying RTSP wake without P2P fallback (session=' +
          cam.sessionId +
          ')'
      );
      stopDecoder(cam);
      void startRtspStream(cam);
      return;
    }
    const fallbackTimeoutSecs = Math.round(RTSP_FALLBACK_TIMEOUT_MS / 1000);
    const fallbackDurationSecs = Math.round(RTSP_P2P_FALLBACK_DURATION_MS / 1000);
    log.warn(
        cam,
        'HomeBase RTSP stream yielded no video after ' +
        fallbackTimeoutSecs +
        's, queueing P2P fallback for ' +
        fallbackDurationSecs +
        's (session=' +
        cam.sessionId +
        ')'
    );
    stopDecoder(cam);
    cam.rtspRewaking = false;
    cam.rtspFallbackUntil = now + RTSP_P2P_FALLBACK_DURATION_MS;
    cam.active = false;
    cam.activeMode = '';
    arbitrate();
  } else if (cam.gotVideo && !cam.rtspRewaking && now - cam.lastVideoAt > RTSP_MID_SESSION_STALL_MS) {
    handleRtspStreamDropped(
        cam,
        null,
        'no frames for ' + ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's'
    );
  }
}

/**
 * Checks completion and timeout conditions for an active backfill download session.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} quietSince - Timestamp of last video packet or start attempt.
 */
function checkDownloadSessionHealth(cam, now, quietSince) {
  if (cam.downloadFrames.length > 0) {
    return;
  }
  if (cam.gotVideo && (cam.downloadFinished || now - cam.lastVideoAt > DOWNLOAD_IDLE_COMPLETE_MS)) {
    stop(cam, 'post-event clip download stream completed', false, 'eufy/download-finished');
    arbitrate();
  } else if (!cam.gotVideo && now - quietSince > DOWNLOAD_NO_VIDEO_TIMEOUT_MS) {
    log.warn(cam, 'post-event clip download timed out with no video after ' + Math.round(DOWNLOAD_NO_VIDEO_TIMEOUT_MS / 1000) + 's');
    stop(cam, 'post-event clip download timed out', false, 'error/download-timeout');
    arbitrate();
  }
}

/**
 * Checks watchdog stall and retry conditions for an active P2P livestream session.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} quietSince - Timestamp of last video packet or start attempt.
 */
function checkP2pSessionHealth(cam, now, quietSince) {
  const retryAfterMs = cam.restarts === 0 ? P2P_INITIAL_RETRY_MS : P2P_SUBSEQUENT_RETRY_MS;
  if (now - quietSince <= retryAfterMs || cam.starting) {
    return;
  }

  const quietSecs = ((now - quietSince) / 1000).toFixed(1);
  const stallCause = cam.gotVideo ? 'stream_stalled_mid_session' : 'no_initial_video_after_wake';
  if (++cam.restarts > P2P_MAX_WATCHDOG_RETRIES) {
    cam.motionUntil = 0;
    stop(
        cam,
        'camera stopped sending video after ' + P2P_MAX_WATCHDOG_RETRIES + ' retries (cause=' +
        stallCause +
        ', quietFor=' +
        quietSecs +
        's)',
        false,
        'error/watchdog-timeout'
    );
    return;
  }

  log.warn(
      cam,
      'stream stalled (initiator=bridge-watchdog, cause=' +
      stallCause +
      ', quietFor=' +
      quietSecs +
      's, gotVideo=' +
      cam.gotVideo +
      ', retry=' +
      cam.restarts +
      '/' +
      P2P_MAX_WATCHDOG_RETRIES +
      ') - resetting decoder and re-requesting livestream from eufy'
  );
  stopDecoder(cam);
  void startLivestream(cam);
}

/**
 * Starts the 500ms housekeeping & watchdog loop.
 */
function startHousekeepingLoop() {
  setInterval(() => {
    const now = Date.now();
    arbitrate();
    void processBackfillQueue(now);
    if (isWsReady()) {
      checkPeriodicMaskSync(cams, now, isShuttingDownFn());
    }

    if (isWsReady() && isInitialTelemetryLoaded() && now - getWsReadyAt() > STARTUP_PROBE_READY_DELAY_MS) {
      const nextProbeCam = cams.find(
          (c) =>
              c.needsStartupSnapshot &&
              !isLowBattery(c) &&
              !cams.some((o) => getStationKey(o) === getStationKey(c) && (o.active || now < want(o)))
      );
      if (nextProbeCam) {
        nextProbeCam.needsStartupSnapshot = false;
        nextProbeCam.isStartupProbe = true;
        trigger(nextProbeCam, 'startup snapshot probe', STARTUP_PROBE_HOLD_MS, 'view', 'bridge-probe');
      }
    }

    for (const cam of cams) {
      if (!cam.active) {
        continue;
      }
      if (now - cam.startedAt >= MAX_MS) {
        cam.motionUntil = 0;
        stop(
            cam,
            'reached max_secs limit (' + Math.round(MAX_MS / 60000) + 'm)',
            false,
            'bridge-max-limit'
        );
        continue;
      }
      if (!inMotion(cam) && now - Math.max(cam.startedAt, cam.motionUntil) >= VIEW_MAX_MS) {
        stop(
            cam,
            'reached view_max_secs limit (' + Math.round(VIEW_MAX_MS / 60000) + 'm)',
            false,
            'bridge-view-limit'
        );
        continue;
      }

      void evaluateEarlySleep(cam, now);
      void evaluateActiveHoldExtension(cam, now);
      const quietSince = Math.max(cam.lastVideoAt, cam.lastStartAt);

      switch (cam.activeMode) {
        case 'rtsp':
          checkRtspSessionHealth(cam, now, quietSince);
          break;
        case 'download':
          checkDownloadSessionHealth(cam, now, quietSince);
          break;
        default:
          checkP2pSessionHealth(cam, now, quietSince);
          break;
      }
    }
  }, HOUSEKEEPING_INTERVAL_MS);
}

module.exports = {
  initOrchestrator,
  compareWantingCameras,
  canPreemptActiveStream,
  resolvePreemptInitiator,
  evaluateEarlySleep,
  evaluateActiveHoldExtension,
  wakeCameraExternal,
  trigger,
  activateRtspCamera,
  arbitrateStationP2pSlot,
  arbitrate,
  startRtspStream,
  parseClipTimestampMs,
  extractDatabaseRecordCandidate,
  handleDatabaseQueryResult,
  processBackfillQueue,
  startLivestream,
  stop,
  handleStationEvent,
  handleDownloadFinishedEvent,
  handleLivestreamStoppedEvent,
  handleTriggerEvent,
  onEvent,
  handleRtspStreamDropped,
  checkRtspSessionHealth,
  checkDownloadSessionHealth,
  checkP2pSessionHealth,
  startHousekeepingLoop,
};
