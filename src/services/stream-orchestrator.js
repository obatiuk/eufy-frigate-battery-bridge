// @ts-check
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
  BACKFILL_DELAY_MS,
  LIVE_FPS,
  DEFAULT_EVENT_PRIORITY,
  STREAM_MODES,
  sleep,
  getEventPriority,
} = require('../config');
const {log} = require('../logger');
const {Camera, WakeRequest, WAKE_KINDS, DOWNLOAD_COMPLETED_INITIATOR} = require('../domain/camera');
const {
  BACKFILL_MAX_QUERY_ATTEMPTS,
  extractDatabaseRecordCandidate,
} = require('../domain/backfill-job');
const {renderCameraCards} = require('../overlay/card-renderer');
const {saveCachedFrame} = require('../overlay/snapshot-cache');
const {pushFrameToEncoder, startEncoder, stopEncoder} = require('../media/encoder');
const {
  setRtspDropHandler,
  startRtspDecoder,
  flushDecoderInput,
  stopDecoder,
  onVideo,
  onAudio,
} = require('../media/decoder');
const {frigateEvent, isFrigateCameraIdle, checkPeriodicMaskSync} = require('./frigate-client');
const {
  call,
  setCameraProperty,
  isWsReady,
  isWsSettledForEvents,
  canRunStartupProbeNow,
  isTrackedPropertyEvent,
  resolvePropertyTriggerEvent,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  ensureStationReadyForP2pRetry,
  prepareRtspWakeAttempt,
  ensureRtspUrlAfterWakeStart,
  refreshMissingRtspUrlOnStart,
  isStationRecycling,
  recoverUnresponsiveStation,
  recordStationWakeTimeout,
  noteStationActivity,
  scheduleStationReconnect,
  updateStationHealth,
  extractRecognizedPerson,
} = require('./eufy-client');

// Priority boost constant for synthetic /api/wake events.
const API_WAKE_EVENT_PRIORITY = 250;

// Per-station wake pacing, burst deduplication, and log debounce intervals.
const STATION_WAKE_PACING_MS = 2500;
const API_WAKE_STALLED_RTSP_MS = 10000;

// Active stream hold extension and mid-stream re-trigger grace thresholds.
const MID_STREAM_RETRIGGER_GRACE_MS = 5000;

// Early-sleep and Eufy-controlled event end thresholds.
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
const RTSP_STOP_SETTLE_MS = 250;
const P2P_STOP_SETTLE_MS = 250;

// External wake adoption and WebSocket startup/reconnect guards.
const EXTERNAL_WAKE_GUARD_MS = 3000;
const DEFAULT_EXTERNAL_WAKE_EVENT = 'motion detected';
const UNSOLICITED_VIDEO_STOP_DELAY_MS = 3000;
const WS_READY_EVENT_SETTLE_MS = 5000;
const STATION_RECONNECT_TELEMETRY_DELAY_MS = 3000;

// RTSP mid-session re-wake minimum hold threshold.
const RTSP_REWAKE_MIN_HOLD_MS = 20000;
const RTSP_RECENT_START_RETRY_DELAY_MS = 750;

// HomeBase clip backfill queue and download health thresholds.
const BACKFILL_MIN_EVENT_AGE_MS = 4000;
const BACKFILL_QUERY_COOLDOWN_MS = 4000;
const BACKFILL_DATE_WINDOW_MS = 86400000;
const DOWNLOAD_NO_VIDEO_TIMEOUT_MS = 10000;

// Housekeeping loop and startup snapshot probe intervals.
const HOUSEKEEPING_INTERVAL_MS = 500;
const STARTUP_PROBE_READY_DELAY_MS = 6000;
const STARTUP_PROBE_HOLD_MS = 25000;
const MS_PER_SECOND = 1000;
const STOP_INITIATORS = Object.freeze({
  TIMER: 'bridge-timer',
  MAX_LIMIT: 'bridge-max-limit',
  VIEW_LIMIT: 'bridge-view-limit',
});
const ALREADY_RUNNING_ERROR_REGEX = /already_running/i;
const EXPECTED_STOP_ERROR_REGEX = /ws_closed|not_running/i;
const UNRESPONSIVE_WAKE_RPC_REGEX = /^(?:no_reply|station_not_connected)$/i;

/** @type {Camera[]} */
let cams = [];
/** @type {Map<string, Camera>} */
let bySerial = new Map();
let isShuttingDownFn = () => false;

const stationTransitions = new Map();
const stationNextWakeAt = new Map();
const getStationTransition = (cam) => stationTransitions.get(cam.getStationKey()) || Promise.resolve();
const setStationTransition = (cam, p) => stationTransitions.set(cam.getStationKey(), p);

/**
 * Initializes the orchestrator with the active camera collection and shutdown state accessor.
 *
 * @param {Camera[]} cameraList - Configured Camera instances.
 * @param {Map<string, Camera>} serialMap - Map of serial -> Camera instance.
 * @param {() => boolean} shuttingDownGetter - Function returning true when shutting down.
 */
function initOrchestrator(cameraList, serialMap, shuttingDownGetter) {
  cams = cameraList;
  bySerial = serialMap;
  isShuttingDownFn = shuttingDownGetter;
  stationTransitions.clear();
  stationNextWakeAt.clear();
  setRtspDropHandler(handleRtspStreamDropped);
}

/**
 * Clears any offline/wake-timeout state on a camera when a live hardware event or video packet
 * arrives and restarts its persistent FFmpeg encoder if it was paused while offline.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} reason - Event or packet source that proved the camera is online.
 */
function resumeOfflineCameraIfNeeded(cam, reason) {
  noteStationActivity(cam.stationSerial);
  const wasOffline = cam.isDeviceOffline();
  cam.markDeviceOnline();
  if (wasOffline || cam.shouldResumeOfflineEncoder()) {
    log.info(cam, 'camera is back online (' + reason + '), resuming RTSP encoder');
    renderCameraCards(cam);
    startEncoder(cam);
    pushFrameToEncoder(cam);
  }
}

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

  const frigateIdle = await isFrigateCameraIdle(cam);
  const checkNow = Date.now();
  if (frigateIdle && cam.canSleepEarlyOnIdle(checkNow, MIN_EVENT_VIDEO_DURATION_MS)) {
    const quietSecs = cam.markEarlySleep(checkNow);
    const initiator = clearedByEufy
        ? 'bridge-early-sleep/eufy-cleared'
        : 'bridge-early-sleep/quiet-timeout';
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
    const frigateIdle = await isFrigateCameraIdle(cam, clockNow);
    if (!cam.isSessionActive()) {
      return;
    }
    const extNow = clockNow === undefined ? Date.now() : clockNow;
    const hwActive = cam.hasActiveHardwareTriggers();
    if (!frigateIdle) {
      cam.confirmFrigateObjectDetected(extNow);
    }
    if ((frigateIdle && !hwActive) || !needsTimeoutExtendCheck) {
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
    const reasonLabel = !frigateIdle
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
 * Handles an /api/wake request for a backfill-mode camera while a Eufy trigger, BackfillJob, or backfill playback is
 * already active: queues a HomeBase clip lookup for the wake, unless a BackfillJob or hardware trigger is already
 * being processed (the Frigate event then comes from that job when its clip plays).
 *
 * @param {Camera} cam - Backfill-mode camera.
 * @param {string} reason - Wake reason supplied by the caller.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean} True if a new BackfillJob was queued.
 */
function queueApiWakeBackfill(cam, reason, now) {
  cam.prepareForMotionTrigger();
  if (cam.hasPendingBackfill() || cam.hasActiveHardwareTriggers()) {
    return false;
  }
  cam.queueEventBackfill(
      now,
      DEFAULT_EXTERNAL_WAKE_EVENT,
      '',
      reason || 'external api wake',
      API_WAKE_EVENT_PRIORITY,
      false
  );
  pushFrameToEncoder(cam, now);
  return true;
}

/**
 * Wakes or extends a camera stream in response to an external /api/wake HTTP request.
 *
 * @param {Camera} cam - Target Camera instance.
 * @param {{ durationMs: number, reason: string, createEvent: boolean, delayMs?: number }} opts - Wake options or built WakeRequest.
 * @returns {{ camera: string, title: string, status: string, mode: string, hold_secs: number, delay_ms: number }}
 */
function wakeCameraExternal(cam, opts) {
  const {durationMs, reason, createEvent, delayMs} = opts;
  const now = Date.now();
  cam.cancelStartupProbe();

  const applyWakeTrigger = (wakeReason, wakeDurationMs, wakeCreateEvent) => {
    if (isShuttingDownFn()) {
      return;
    }
    cam.recordApiWakeTriggered(Date.now(), wakeCreateEvent);
    if (wakeCreateEvent) {
      trigger(cam, wakeReason, wakeDurationMs, WAKE_KINDS.MOTION, 'api-wake', API_WAKE_EVENT_PRIORITY);
      if (cam.isActiveLiveSession()) {
        frigateEvent(cam, 'motion detected', '');
      }
    } else {
      trigger(cam, wakeReason, wakeDurationMs, WAKE_KINDS.VIEW, 'api-wake');
    }
  };

  if (cam.isActiveLiveSession()) {
    cam.clearApiWakeTimer();
    applyWakeTrigger(reason, durationMs, createEvent);
    if (cam.resetStalledRtspWakeIfNeeded(now, API_WAKE_STALLED_RTSP_MS)) {
      log.info(
          cam,
          'refreshing stalled RTSP wake on new api-wake "' + reason + '" (session=' + cam.getSessionId() + ')'
      );
      stopDecoder(cam);
      void startRtspStream(cam);
    }
    return cam.toApiWakeResponse('extended', durationMs, 0);
  }

  if (cam.isDeviceOffline()) {
    if (cam.shouldRefreshOfflineOnView(now)) {
      log.info(
          cam,
          'api-wake "' +
          reason +
          '" received while camera is offline (' +
          (cam.getOfflineReason() || 'offline') +
          '), polling HomeBase for battery swap/recovery'
      );
      void Promise.resolve(fetchAllCameraTelemetry(true)).then(() => {
        if (!cam.isDeviceOffline() && !isShuttingDownFn()) {
          if (cam.shouldBackfillOnlyOnApiWake()) {
            queueApiWakeBackfill(cam, reason, Date.now());
          } else {
            applyWakeTrigger(reason, durationMs, createEvent);
          }
        }
      });
    }
    return cam.toApiWakeResponse('offline', 0, 0);
  }

  if (cam.shouldBackfillOnlyOnApiWake()) {
    cam.clearApiWakeTimer();
    if (queueApiWakeBackfill(cam, reason, now)) {
      log.info(
          cam,
          'api-wake "' + reason + '" queued for HomeBase clip backfill (active Eufy trigger/backfill, skipping live wake)'
      );
    } else {
      log.debug(
          cam,
          'api-wake "' + reason + '" skipped (pending backfill or active trigger is already being processed)'
      );
    }
    return cam.toApiWakeResponse('backfill', durationMs, 0);
  }

  if (cam.hasPendingApiWakeTimer()) {
    const remainingDelayMs = cam.coalesceApiWake(durationMs, reason, createEvent, now);
    log.debug(
        cam,
        'coalesced duplicate api-wake "' +
        reason +
        '" into pending wake timer (in ' +
        remainingDelayMs +
        'ms)'
    );
    return cam.toApiWakeResponse('scheduled', cam.getScheduledApiWakeDurationMs(), remainingDelayMs);
  }

  if (cam.shouldBackfillOnlyOnEvent()) {
    log.info(
        cam,
        'api-wake "' +
        reason +
        '" starting a live stream on a backfill-mode camera (no Eufy trigger, BackfillJob, or live session is active, ' +
        'so there is no clip to wait for' +
        (createEvent ? ')' : '; view-only wake, create_event=false)')
    );
  }

  const stationKey = cam.getStationKey();
  const nextSlotAt = Math.max(now, stationNextWakeAt.get(stationKey) || 0);
  const rawDelayMs = delayMs !== undefined && delayMs > 0 ? delayMs : Math.max(0, nextSlotAt - now);
  const pacedReq = (createEvent
      ? WakeRequest.motion(reason, durationMs)
      : WakeRequest.view(reason, durationMs))
      .withInitiator('api-wake')
      .withCreateEvent(Boolean(createEvent))
      .withDelay(rawDelayMs)
      .build();
  const effectiveDelayMs = pacedReq.delayMs;
  stationNextWakeAt.set(stationKey, now + effectiveDelayMs + STATION_WAKE_PACING_MS);

  if (effectiveDelayMs > 0) {
    cam.scheduleApiWake(
        pacedReq.durationMs,
        pacedReq.reason,
        pacedReq.createEvent,
        effectiveDelayMs,
        now,
        (pending) => {
          applyWakeTrigger(pending.reason, pending.durationMs, pending.createEvent);
        }
    );
    return cam.toApiWakeResponse('scheduled', pacedReq.durationMs, effectiveDelayMs);
  }

  applyWakeTrigger(pacedReq.reason, pacedReq.durationMs, pacedReq.createEvent);
  return cam.toApiWakeResponse('waking', pacedReq.durationMs, 0);
}

/**
 * Extends a camera's wake timer for either a motion event or an active live viewer and runs
 * stream arbitration across all cameras.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} reason - Description of what triggered the wake request.
 * @param {number} ms - Duration in milliseconds to hold the camera awake.
 * @param {'motion'|'view'} kind - Type of wake trigger.
 * @param {string} [initiator=''] - Who initiated the wake trigger.
 * @param {number} [evPriority=DEFAULT_EVENT_PRIORITY] - Event priority boost score.
 */
function trigger(cam, reason, ms, kind, initiator = '', evPriority = DEFAULT_EVENT_PRIORITY) {
  if (!isWsReady()) {
    return;
  }
  const now = Date.now();
  const req =
      kind === WAKE_KINDS.MOTION
          ? WakeRequest.motion(reason, ms)
              .withInitiator(initiator || 'eufy-event')
              .withPriority(evPriority)
              .build()
          : WakeRequest.view(reason, ms)
              .withInitiator(initiator || 'viewer')
              .build();

  const logOutcome = cam.applyWakeRequest(req, now, cams);
  if (logOutcome.shouldLog) {
    const logFn = logOutcome.isDebug ? log.debug : log.info;
    logFn(cam, logOutcome.message);
  }
  arbitrate();
}

/**
 * Wakes a single RTSP-capable camera in parallel without consuming a station P2P slot.
 *
 * @param {Camera} rCam - RTSP-capable Camera instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function activateRtspCamera(rCam, now) {
  const stationKey = rCam.getStationKey();
  stationNextWakeAt.set(stationKey, Math.max(stationNextWakeAt.get(stationKey) || 0, now + STATION_WAKE_PACING_MS));
  const wakeLog = rCam.beginRtspWakeSession(now);
  pushFrameToEncoder(rCam, now);
  log.info(rCam, wakeLog);
  void startRtspStream(rCam);
}

/**
 * Arbitrates the P2P livestream slot for a single stationSerial group.
 *
 * @param {string} stationKey - Station serial identifier.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function arbitrateStationP2pSlot(stationKey, now) {
  const stationCams = cams.filter((c) => c.belongsToStationP2pSlot(stationKey));
  let cur = stationCams.find((c) => c.isOccupyingStationP2pChannel());

  if (cur && cur.hasExpiredLiveHold(now)) {
    if (cur.isExtendCheckInFlight()) {
      return;
    }
    stop(cur, 'hold/view timer expired, no more activity or viewers', false, STOP_INITIATORS.TIMER);
    cur = null;
  }

  const wanting = stationCams.filter((c) => c.wantsWake(now));
  if (!wanting.length || !isWsReady()) {
    return;
  }

  const pick = wanting.sort(Camera.compareWanting)[0];

  if (cur && cur.isBackfillPlayback()) {
    if (cur.isUrgentBackfillProtectedFrom(pick, now)) {
      return;
    }
    stop(
        cur,
        'backfill download preempted by live request on ' + pick.getName() + ' (' + pick.getReason() + ')',
        !pick.isInMotion(now),
        'bridge-arbitrator/live-over-download'
    );
    cur = null;
  }

  if (cur) {
    if (!pick.canPreempt(cur, now, P2P_WAKE_STALL_PREEMPT_MS)) {
      const curName = cur.getName();
      for (const c of wanting) {
        if (!c.isInMotion(now)) {
          c.clearViewerQueue('blocked by active stream on ' + curName);
        } else {
          c.expireBlockedMotionHold(cur);
        }
        pushFrameToEncoder(c, now);
      }
      return;
    }

    const pickScore = pick.getEffectivePriority(now);
    const curScore = cur.getEffectivePriority(now);
    const preemptInitiator = pick.resolvePreemptInitiator(cur, now);
    stop(
        cur,
        'preempted by ' + pick.getName() + ' (' + pick.getReason() + ', priority=' + pickScore + ' vs ' + curScore + ')',
        !pick.isInMotion(now),
        preemptInitiator
    );
  }

  const pickName = pick.getName();
  for (const c of wanting) {
    if (c !== pick && !c.isInMotion(now)) {
      c.clearViewerQueue('not selected by arbitrator, ' + pickName + ' won station slot');
    }
  }

  stationNextWakeAt.set(stationKey, Math.max(stationNextWakeAt.get(stationKey) || 0, now + STATION_WAKE_PACING_MS));
  const wakeSummary = pick.beginP2pWakeSession(now);
  pushFrameToEncoder(pick, now);
  log.info(pick, wakeSummary.wakeLog);
  if (wakeSummary.shouldFileEvent) {
    frigateEvent(pick, wakeSummary.eventReason, wakeSummary.personName);
  }
  void startLivestream(pick);
}

/**
 * Arbitrates RTSP and per-station P2P camera streams across all configured cameras.
 *
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
function arbitrate(now = Date.now()) {
  for (const rCam of cams.filter((c) => c.isActiveRtspSession())) {
    if (rCam.hasExpiredLiveHold(now) && !rCam.isExtendCheckInFlight()) {
      stop(rCam, 'RTSP hold/view timer expired', false, STOP_INITIATORS.TIMER);
    }
  }

  for (const rCam of cams.filter((c) => c.wantsRtspWake(now))) {
    activateRtspCamera(rCam, now);
  }

  const stationKeys = new Set(cams.filter((c) => !c.isRtspCapable()).map((c) => c.getStationKey()));
  for (const stationKey of stationKeys) {
    arbitrateStationP2pSlot(stationKey, now);
  }
}

/**
 * Triggers HomeBase station recovery when a livestream wake RPC fails with no_reply or station_not_connected.
 *
 * @param {string} stationSn - Station serial number.
 * @param {string} cmdLabel - RPC command name for diagnostics.
 * @param {string} [errorCode=''] - Error code returned by eufy-security-ws.
 */
function maybeRecoverStationOnWakeRpcFailure(stationSn, cmdLabel, errorCode = '') {
  if (errorCode && UNRESPONSIVE_WAKE_RPC_REGEX.test(errorCode)) {
    void recoverUnresponsiveStation(stationSn, cmdLabel + ' ' + errorCode, true);
  }
}

/**
 * Starts a HomeBase RTSP pull stream for a camera and requests device.start_rtsp_livestream.
 *
 * @param {Camera} cam - Camera domain instance.
 */
async function startRtspStream(cam) {
  if (!cam.canStartRtspStream()) {
    return;
  }
  const mySession = cam.markRtspAttemptStart(Date.now());
  if (cam.shouldFileInitialRtspEvent()) {
    frigateEvent(cam, cam.getReason(), '');
  }
  await getStationTransition(cam);
  if (!cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    return;
  }
  const serial = cam.getSerial();
  const stationSn = cam.resolveHomeBaseStationSerial(cams);
  await prepareRtspWakeAttempt(cam, mySession, stationSn);
  if (!cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    return;
  }
  const r = await call({command: 'device.start_rtsp_livestream', serialNumber: serial});
  if (!r.success && r.errorCode && !ALREADY_RUNNING_ERROR_REGEX.test(r.errorCode)) {
    maybeRecoverStationOnWakeRpcFailure(stationSn, 'start_rtsp_livestream', r.errorCode);
    log.debug(
        cam,
        'device.start_rtsp_livestream returned ' +
        r.errorCode +
        ' (relying on rtspStream property wake)'
    );
  }
  await ensureRtspUrlAfterWakeStart(cam, mySession, stationSn);
  if (cam.canSpawnRtspDecoder(mySession)) {
    startRtspDecoder(cam);
  } else if (!cam.getRtspUrl() && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    const logFn = cam.isFirstWakeAttempt() ? log.debug : log.warn;
    logFn(
        cam,
        'HomeBase did not provide rtspStreamUrl after start_rtsp_livestream - verify HomeBase P2P connection and NAS/RTSP setting (session=' +
        mySession +
        ')'
    );
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
    if (cam && cam.tryMatchBackfillCandidate(cand)) {
      matchedAny = true;
      log.info(cam, cam.formatBackfillClipMatchLog(cand));
    }
  }

  if (matchedAny) {
    void processBackfillQueue(Date.now());
  }
}

/**
 * Queries the HomeBase local database and starts downloading a missed event clip when the P2P slot is idle.
 *
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
async function processBackfillQueue(now = Date.now()) {
  if (!isWsReady() || isShuttingDownFn()) {
    return;
  }

  for (const c of cams) {
    const expiredReason = c.expirePendingBackfillIfNeeded(now);
    if (expiredReason) {
      pushFrameToEncoder(c, now);
      log.debug(c, 'expired unfulfilled backfill request (' + expiredReason + ')');
    }
  }

  const readyCam = cams
      .filter((c) => c.canStartBackfillDownloadNow(cams, now, BACKFILL_DELAY_MS))
      .sort(Camera.compareBackfillPriority)[0];

  if (readyCam) {
    const {clip, sessionId: mySession} = readyCam.startNextBackfillDownload(now);

    log.info(
        readyCam,
        'WAKE [BACKFILL DOWNLOAD] (initiator=bridge-backfill, reason="' +
        clip.reason +
        '", path="' +
        clip.storagePath +
        '", session=' +
        mySession +
        ')'
    );
    frigateEvent(readyCam, clip.event || 'motion detected', clip.personName || '');

    await getStationTransition(readyCam);
    if (!readyCam.isCurrentSession(mySession, STREAM_MODES.DOWNLOAD)) {
      return;
    }

    const res = await call({
      command: 'device.start_download',
      serialNumber: readyCam.getSerial(),
      path: clip.storagePath,
      cipherId: clip.cipherId,
    });
    if (!res.success && readyCam.isCurrentSession(mySession, STREAM_MODES.DOWNLOAD)) {
      log.warn(
          readyCam,
          'device.start_download failed (errorCode=' + (res.errorCode || 'unknown') + ')'
      );
      stop(readyCam, 'start_download RPC failed', false, 'error/download-failed');
    }
    return;
  }

  const queryCam = cams
      .filter((c) =>
        c.canQueryBackfillNow(
            cams,
            now,
            BACKFILL_MIN_EVENT_AGE_MS,
            BACKFILL_QUERY_COOLDOWN_MS,
            BACKFILL_DELAY_MS
        )
      )
      .sort(Camera.compareBackfillPriority)[0];

  if (!queryCam) {
    return;
  }
  const queryState = queryCam.beginBackfillDatabaseQuery(now, BACKFILL_MAX_QUERY_ATTEMPTS);
  if (!queryState.allowed) {
    pushFrameToEncoder(queryCam, now);
    log.debug(
        queryCam,
        'giving up on backfill query after ' + BACKFILL_MAX_QUERY_ATTEMPTS + ' attempts (' + queryState.reason + ')'
    );
    return;
  }

  const stationSn = queryCam.resolveHomeBaseStationSerial(cams);
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
      queryState.attempts +
      '/' +
      queryState.maxAttempts +
      ', reason="' +
      queryState.reason +
      '")'
  );
  await call({command: 'station.connect', serialNumber: stationSn});
  await call({
    command: 'station.database_query_by_date',
    serialNumber: stationSn,
    serialNumbers: [queryCam.getSerial()],
    startDate: fmtYmd(dStart),
    endDate: fmtYmd(dEnd),
  });
  if (queryCam.needsLatestInfoBackfillQuery()) {
    await call({
      command: 'station.database_query_latest_info',
      serialNumber: stationSn,
    });
  }
}

/**
 * Sends device.start_livestream to eufy-security-ws for the specified camera.
 *
 * @param {Camera} cam - Camera domain instance.
 */
async function startLivestream(cam) {
  if (!cam.canBeginP2pStart()) {
    return;
  }
  const mySession = cam.beginP2pStartAttempt();
  const serial = cam.getSerial();

  const runStart = async () => {
    try {
      await getStationTransition(cam);
      if (!cam.isCurrentSession(mySession)) {
        log.debug(
            cam,
            'aborted start_livestream before RPC call (initiator=bridge, reason=session_canceled_or_preempted, session=' +
            mySession +
            ')'
        );
        return;
      }

      for (let i = 0; i < RTSP_HANDSHAKE_MAX_POLLS; i++) {
        const rtspWaking = cams.some((c) =>
          c.isWakingRtspOnStation(cam, Date.now(), RTSP_HANDSHAKE_WINDOW_MS)
        );
        if (!rtspWaking || !cam.isCurrentSession(mySession)) {
          break;
        }
        await sleep(RTSP_HANDSHAKE_POLL_MS);
      }
      if (!cam.isCurrentSession(mySession)) {
        return;
      }
      const stationSn = cam.resolveHomeBaseStationSerial(cams);
      await ensureStationReadyForP2pRetry(cam, stationSn);
      if (!cam.isCurrentSession(mySession)) {
        return;
      }

      cam.markP2pStreamReady(Date.now());
      let r = await call({command: 'device.start_livestream', serialNumber: serial});

      if (!cam.isCurrentSession(mySession)) {
        if (r.success) {
          log.info(
              cam,
              'stopping newly woken stream because session ' +
              mySession +
              ' was preempted/closed during wake (initiator=bridge)'
          );
          await call({command: 'device.stop_livestream', serialNumber: serial});
        }
        return;
      }

      if (!r.success && ALREADY_RUNNING_ERROR_REGEX.test(r.errorCode || '')) {
        log.warn(
            cam,
            'eufy-security-ws reports stale livestream (errorCode=' +
            r.errorCode +
            '), forcing stop and restart (initiator=bridge/eufy-ws, session=' +
            mySession +
            ')'
        );
        cam.markP2pStreamNotReady();
        await call({command: 'device.stop_livestream', serialNumber: serial});
        await sleep(ALREADY_RUNNING_RESTART_DELAY_MS);
        if (!cam.isCurrentSession(mySession)) {
          return;
        }
        cam.markP2pStreamReady(Date.now());
        r = await call({command: 'device.start_livestream', serialNumber: serial});
        if (!cam.isCurrentSession(mySession)) {
          if (r.success) {
            log.info(
                cam,
                'stopping restarted stream because session ' +
                mySession +
                ' was preempted/closed during retry (initiator=bridge)'
            );
            await call({command: 'device.stop_livestream', serialNumber: serial});
          }
          return;
        }
      }

      if (!r.success) {
        maybeRecoverStationOnWakeRpcFailure(stationSn, 'start_livestream', r.errorCode);
        log.error(
            cam,
            'start_livestream failed (initiator=eufy-ws, errorCode=' +
            (r.errorCode || 'unknown') +
            ', session=' +
            mySession +
            ')'
        );
        cam.applyFailedStartBackoff(mySession, Date.now(), FAILED_START_BACKOFF_MS);
      }
    } finally {
      cam.finishP2pStartAttempt(mySession);
    }
  };

  return cam.setStartPromise(runStart());
}

/**
 * Stops an active camera's P2P/RTSP/download session, waits for any in-flight startPromise,
 * tears down the decoder, and refreshes the sleeping card with the camera's own last frame.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} why - Reason the camera is going to sleep.
 * @param {boolean} [preemptedByViewer=false] - True if stopped because the user opened another camera.
 * @param {string} [initiator='bridge'] - Decision maker identifier.
 */
function stop(cam, why, preemptedByViewer = false, initiator = 'bridge') {
  if (!cam.isSessionActive()) {
    return;
  }
  const {
    inFlightStart,
    closedMode,
    hadDownloadFinished,
    hadUnexpectedRtsp,
    wokeWithoutDeviceReply,
    sleepMsg,
  } = cam.terminateSession(Date.now(), why, preemptedByViewer, initiator);
  const serial = cam.getSerial();
  if (wokeWithoutDeviceReply) {
    void recordStationWakeTimeout(cam.resolveHomeBaseStationSerial(cams), initiator);
  }

  // Clear station wake pacing when a P2P/download session ends so back-to-back switching starts immediately.
  if (closedMode !== STREAM_MODES.RTSP) {
    stationNextWakeAt.delete(cam.getStationKey());
  }

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
              case STREAM_MODES.RTSP:
                await sleep(RTSP_STOP_SETTLE_MS);
                break;
              case STREAM_MODES.DOWNLOAD:
                if (!hadDownloadFinished) {
                  await call({command: 'device.cancel_download', serialNumber: serial});
                  await sleep(P2P_STOP_SETTLE_MS);
                }
                break;
              default: {
                try {
                  const res = await call({command: 'device.stop_livestream', serialNumber: serial});
                  if (
                      !res.success &&
                      res.errorCode &&
                      !EXPECTED_STOP_ERROR_REGEX.test(res.errorCode)
                  ) {
                    log.debug(cam, 'device.stop_livestream returned errorCode=' + res.errorCode);
                  }
                  if (hadUnexpectedRtsp) {
                    await call({command: 'device.stop_rtsp_livestream', serialNumber: serial});
                  }
                  await sleep(P2P_STOP_SETTLE_MS);
                } finally {
                  cam.clearP2pStopInFlight();
                }
                break;
              }
            }
          })
          .catch(() => {})
  );

  saveCachedFrame(cam);
  renderCameraCards(cam);
  if (cam.isDeviceOffline()) {
    stopEncoder(cam);
  } else if (!(closedMode === STREAM_MODES.DOWNLOAD && cam.isReadyForBackfillDownload())) {
    pushFrameToEncoder(cam);
  }

  if (closedMode !== STREAM_MODES.DOWNLOAD && !cam.isDeviceOffline()) {
    call({command: 'device.get_properties', serialNumber: serial}).then((res) => {
      if (res.success && res.result && res.result.properties) {
        applyDeviceProperties(cam, res.result.properties, false);
      }
    });
  }
}

/**
 * Handles station-level events ('close', 'connection error', 'connect', and database query results).
 *
 * @param {Record<string, *>} e - Station event object from eufy-security-ws.
 */
function handleStationEvent(e) {
  const stationId = e.serialNumber || 'homebase';
  const stationCams = cams.filter((cam) => cam.isOnStation(e.serialNumber));
  switch (e.event) {
    case 'close':
    case 'connection error': {
      if (stationCams.length === 0) {
        return;
      }
      if (isStationRecycling(e.serialNumber || '')) {
        log.debug(
            'bridge',
            'ignoring HomeBase station (' + stationId + ') ' + e.event + ' during active station recycle'
        );
        return;
      }
      updateStationHealth(stationId, false);
      scheduleStationReconnect(e.serialNumber || '');
      log.warn('bridge', 'HomeBase station (' + stationId + ') P2P disconnected or restarting (' + e.event + ')');
      for (const c of stationCams) {
        if (c.handleStationDisconnected('station_disconnected')) {
          stop(c, 'Station (' + stationId + ') P2P disconnected/restarting', false, 'error/station-disconnect');
        }
      }
      break;
    }
    case 'connect': {
      if (stationCams.length === 0) {
        return;
      }
      noteStationActivity(stationId);
      for (const c of stationCams) {
        c.resetStationSyncFlags();
        if (c.isCurrentSession(c.getSessionId(), STREAM_MODES.RTSP) && !c.gotVideo) {
          void startRtspStream(c);
        }
      }
      log.info('bridge', 'HomeBase station (' + stationId + ') P2P connected');
      const timer = setTimeout(() => {
        if (isWsReady() && !isShuttingDownFn()) {
          void fetchAllCameraTelemetry();
        }
      }, STATION_RECONNECT_TELEMETRY_DELAY_MS);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      break;
    }
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
 * @param {Camera} cam - Camera domain instance.
 */
function handleDownloadFinishedEvent(cam) {
  const mySession = cam.getSessionId();
  if (!cam.isCurrentSession(mySession, STREAM_MODES.DOWNLOAD)) {
    return;
  }
  flushDecoderInput(cam);
  const now = Date.now();
  const bufferedCount = cam.markDownloadFinished(now);
  stationNextWakeAt.delete(cam.getStationKey());
  arbitrate();
  if (cam.shouldExtendFrigateEvent(now, LIVE_FPS)) {
    frigateEvent(cam, cam.getReason(), cam.getEventPerson());
  }
  if (bufferedCount > 0) {
    log.info(cam, cam.formatBackfillTransferCompleteLog(bufferedCount, LIVE_FPS));
    return;
  }
  log.debug(
      cam,
      'eufy clip transfer complete, flushing decoder and holding final frame before sleep (session=' +
      mySession +
      ')'
  );
}

/**
 * Handles 'livestream stopped' events from eufy-security-ws.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function handleLivestreamStoppedEvent(cam) {
  const now = Date.now();
  const outcome = cam.evaluateExternalLivestreamStop(now, MIN_CLEAN_EVENT_VIDEO_MS);
  if (outcome.action === 'inactive') {
    if (cam.hasPendingBackfill()) {
      cam.recordMotionCleared(now, EUFY_CLEARED_SETTLE_MS, MIN_EVENT_VIDEO_DURATION_MS, 'livestream started');
    }
    log.debug(cam, 'eufy confirmed livestream stopped (initiator=bridge/eufy)');
    return;
  }
  stopDecoder(cam);

  switch (outcome.action) {
    case 'clean_end':
      stop(cam, 'eufy/camera ended event livestream', false, 'eufy/camera-event-end');
      arbitrate();
      break;
    case 'interrupted':
      log.warn(cam, outcome.warnMsg);
      void startLivestream(cam);
      break;
    case 'expired':
      stop(cam, 'eufy livestream stopped as hold/view timer expired', false, 'eufy/camera');
      break;
    default:
      log.debug(cam, 'eufy confirmed livestream stopped (initiator=bridge/eufy)');
      break;
  }
}

/**
 * Handles Eufy motion/person/pet/ring trigger events (both state=true start and state=false end).
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} e - Trigger event payload from eufy-security-ws.
 */
function handleTriggerEvent(cam, e) {
  const now = Date.now();
  const personName = extractRecognizedPerson(e);
  if (cam.isDuplicateTriggerEvent(e.event, e.state !== false, personName, now)) {
    return;
  }
  if (e.state === false) {
    const shortenedSecs = cam.recordMotionCleared(
        now,
        EUFY_CLEARED_SETTLE_MS,
        MIN_EVENT_VIDEO_DURATION_MS,
        e.event
    );
    if (shortenedSecs !== null) {
      log.info(
          cam,
          'eufy reported activity cleared (event="' +
          e.event +
          '"), ending stream in ' +
          shortenedSecs +
          's'
      );
      return;
    }
    const {isInfo, logMsg} = cam.evaluateBackfillAfterMotionCleared(e.event);
    if (isInfo) {
      log.info(cam, logMsg);
    } else {
      log.debug(cam, logMsg);
    }
    return;
  }

  if (e.state === true && isWsSettledForEvents(now, WS_READY_EVENT_SETTLE_MS)) {
    resumeOfflineCameraIfNeeded(cam, 'event "' + e.event + '"');
    cam.prepareForMotionTrigger();
    const triggerDesc = personName ? e.event + ' (' + personName + ')' : e.event;
    const evPrio = getEventPriority(e.event);
    cam.queueEventBackfill(now, e.event, personName, triggerDesc, evPrio, true);
    if (cam.shouldBackfillOnlyOnEvent()) {
      pushFrameToEncoder(cam, now);
      log.info(
          cam,
          'event trigger "' +
          triggerDesc +
          '" queued for HomeBase clip backfill (always_backfill=true, skipping live wake to conserve battery)'
      );
      return;
    }
    const holdDuration = cam.getEventHoldMs();
    trigger(cam, triggerDesc, holdDuration, WAKE_KINDS.MOTION, 'eufy-event', evPrio);
    if (cam.isActiveLiveSession()) {
      frigateEvent(cam, e.event, personName);
    }
  }
}

/**
 * Attempts to adopt a P2P livestream started externally via eufy-security-ws when the camera
 * is currently idle and outside the post-sleep guard window.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean} True if the external P2P stream was adopted.
 */
function tryAdoptExternalP2pWake(cam, now) {
  if (!cam.adoptExternalP2pWake(now, EXTERNAL_WAKE_GUARD_MS)) {
    return false;
  }
  pushFrameToEncoder(cam, now);
  log.info(
      cam,
      'WAKE (initiator=eufy-ws, reason="external P2P wake - eufy-security-ws", station=' +
      cam.getStationKey() +
      ', priority=' +
      cam.getEffectivePriority(now) +
      ', session=' +
      cam.getSessionId() +
      ')'
  );
  frigateEvent(cam, DEFAULT_EXTERNAL_WAKE_EVENT, '');
  return true;
}

/**
 * Attempts to adopt an RTSP livestream started externally via eufy-security-ws when the camera
 * is currently idle, RTSP-capable, and outside the post-sleep guard window.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean} True if the external RTSP stream was adopted.
 */
function tryAdoptExternalRtspWake(cam, now) {
  if (!cam.adoptExternalRtspWake(now, EXTERNAL_WAKE_GUARD_MS)) {
    return false;
  }
  pushFrameToEncoder(cam, now);
  log.info(
      cam,
      'WAKE [RTSP] (initiator=eufy-ws, reason="external RTSP wake - eufy-security-ws", priority=' +
      cam.getEffectivePriority(now) +
      ', session=' +
      cam.getSessionId() +
      ')'
  );
  if (cam.canSpawnRtspDecoder()) {
    startRtspDecoder(cam);
  }
  frigateEvent(cam, DEFAULT_EXTERNAL_WAKE_EVENT, '');
  return true;
}

/**
 * Logs a livestream started event or extends the hold timer by HOLD_MS / 2 if the stream
 * re-triggered mid-session after MID_STREAM_RETRIGGER_GRACE_MS.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} label - Stream label ("eufy RTSP livestream" or "eufy livestream").
 */
function handleStreamStartedOrRetriggered(cam, label) {
  const now = Date.now();
  const sessionId = cam.getSessionId();
  if (cam.isMidStreamRetrigger(now, MID_STREAM_RETRIGGER_GRACE_MS)) {
    const {extended, extendMs, holdSecs} = cam.extendActiveHold(now, undefined, true);
    if (cam.shouldExtendFrigateEvent(now, LIVE_FPS)) {
      frigateEvent(cam, cam.getReason(), cam.getEventPerson());
    }
    if (extended) {
      log.info(
          cam,
          label +
          ' re-triggered while active, extended hold by +' +
          Math.round(extendMs / MS_PER_SECOND) +
          's (holdExtendedTo=' +
          holdSecs +
          's, session=' +
          sessionId +
          ')'
      );
    } else {
      log.debug(
          cam,
          label +
          ' re-triggered while active (holdRemaining=' +
          holdSecs +
          's, session=' +
          sessionId +
          ')'
      );
    }
  } else {
    log.info(cam, label + ' started (session=' + sessionId + ')');
  }
}

/**
 * Sends a single non-waking device.stop_livestream pulse when rapid wifiRssi updates arrive
 * while the camera session is idle after a completed session. Never calls station.disconnect
 * or device.cancel_download because disconnecting HomeBase forces an automatic HomeBase
 * reconnect 15-18s later that re-wakes all attached battery cameras in a loop.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function forceStopWedgedP2pRadio(cam) {
  const serial = cam.getSerial();
  log.warn(
      cam,
      'detected wedged-awake P2P radio while idle (rapid wifiRssi updates while asleep) - forcing P2P stop to restore deep sleep'
  );
  if (cam.shouldTurnOffStuckIdleLight(Date.now())) {
    log.warn(
        cam,
        'turning off stuck spotlight during idle wifiRssi drain (light=false) to restore deep sleep'
    );
    setCameraProperty(cam, 'light', false);
  }
  cam.markP2pStopInFlight();
  setStationTransition(
      cam,
      getStationTransition(cam)
          .then(async () => {
            try {
              await call({command: 'device.stop_livestream', serialNumber: serial});
              await sleep(P2P_STOP_SETTLE_MS);
            } finally {
              cam.clearP2pStopInFlight();
            }
          })
          .catch(() => {
            cam.clearP2pStopInFlight();
          })
  );
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
      applyDeviceProperties(cam, e.device);
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

  const sessionId = cam.getSessionId();
  const serial = cam.getSerial();

  switch (e.event) {
    case 'livestream video data':
      resumeOfflineCameraIfNeeded(cam, 'livestream video data');
      if (cam.isBackfillPlayback()) {
        return;
      }
      if (!cam.isSessionActive()) {
        if (cam.isStoppingP2p()) {
          return;
        }
        const now = Date.now();
        const {shouldStop, sleptAgo} = cam.shouldStopUnsolicitedVideo(
            now,
            UNSOLICITED_VIDEO_STOP_DELAY_MS
        );
        if (shouldStop) {
          log.warn(
              cam,
              'received video while inactive, forcing stop of late stream (initiator=bridge, cause=eufy_unsolicited_video, sleptAgo=' +
              sleptAgo +
              ')'
          );
          void call({command: 'device.stop_livestream', serialNumber: serial});
        }
        return;
      }
      onVideo(cam, e);
      return;

    case 'livestream audio data':
      if (!cam.isBackfillPlayback()) {
        onAudio(cam, e);
      }
      return;

    case 'download video data':
      if (cam.isCurrentSession(sessionId, STREAM_MODES.DOWNLOAD)) {
        onVideo(cam, e);
      }
      return;

    case 'download audio data':
      if (cam.isCurrentSession(sessionId, STREAM_MODES.DOWNLOAD)) {
        onAudio(cam, e);
      }
      return;

    case 'download started':
      if (!cam.isCurrentSession(sessionId, STREAM_MODES.DOWNLOAD)) {
        void call({command: 'device.cancel_download', serialNumber: serial});
        return;
      }
      cam.markP2pStreamReady(Date.now(), false);
      log.info(cam, 'eufy clip download started (session=' + sessionId + ')');
      return;

    case 'download finished':
      handleDownloadFinishedEvent(cam);
      return;

    case 'rtsp livestream started':
      resumeOfflineCameraIfNeeded(cam, 'rtsp livestream started');
      cam.markDeviceHeardInSession();
      if (cam.isCurrentSession(sessionId, STREAM_MODES.RTSP)) {
        if (!cam.getRtspUrl()) {
          void refreshMissingRtspUrlOnStart(cam, sessionId);
        }
        if (cam.canSpawnRtspDecoder()) {
          startRtspDecoder(cam);
        }
        if (
            !cam.isEstablishedRtspStream() ||
            cam.isMidStreamRetrigger(Date.now(), MID_STREAM_RETRIGGER_GRACE_MS)
        ) {
          handleStreamStartedOrRetriggered(cam, 'eufy RTSP livestream');
        }
      } else {
        if (!cam.isActiveLiveSession()) {
          const now = Date.now();
          if (cam.shouldBackfillOnlyOnEvent()) {
            cam.queueEventBackfill(
                now,
                'rtsp livestream started',
                '',
                'rtsp livestream started',
                getEventPriority(DEFAULT_EXTERNAL_WAKE_EVENT),
                true
            );
            if (!cam.isSessionActive()) {
              pushFrameToEncoder(cam, now);
            }
            log.debug(
                cam,
                'rtsp livestream started while idle in backfill mode, queued/extended BackfillJob'
            );
            return;
          }
          if (!cam.isSessionActive() && tryAdoptExternalRtspWake(cam, now)) {
            log.info(cam, 'eufy RTSP livestream started (session=' + cam.getSessionId() + ')');
            return;
          }
        }
        const {shouldStopRtsp, shouldDisableRtspProp, shouldRestartP2p} =
            cam.evaluateUnexpectedRtspStart();
        if (shouldDisableRtspProp) {
          log.warn(
              cam,
              'received RTSP livestream started while in P2P/idle mode, forcing RTSP stop and disabling rtspStream'
          );
          setCameraProperty(cam, 'rtspStream', false);
        } else {
          log.debug(cam, 'ignoring RTSP livestream started event while in P2P/idle mode');
        }
        if (shouldStopRtsp) {
          void call({command: 'device.stop_rtsp_livestream', serialNumber: serial}).then(() => {
            if (
                shouldRestartP2p &&
                cam.isCurrentSession(sessionId, STREAM_MODES.P2P) &&
                !cam.gotVideo
            ) {
              stopDecoder(cam);
              void startLivestream(cam);
            }
          });
        }
      }
      return;

    case 'rtsp livestream stopped':
      if (cam.isCurrentSession(sessionId, STREAM_MODES.RTSP)) {
        handleRtspStreamDropped(cam, 0, 'rtsp livestream stopped event');
      } else if (!cam.isActiveLiveSession() && cam.hasPendingBackfill()) {
        cam.recordMotionCleared(
            Date.now(),
            EUFY_CLEARED_SETTLE_MS,
            MIN_EVENT_VIDEO_DURATION_MS,
            'rtsp livestream started'
        );
      }
      return;

    case 'livestream started':
      resumeOfflineCameraIfNeeded(cam, 'livestream started');
      cam.markDeviceHeardInSession();
      if (cam.isBackfillPlayback()) {
        return;
      }
      if (!cam.isSessionActive()) {
        if (cam.isStoppingP2p()) {
          return;
        }
        const now = Date.now();
        if (tryAdoptExternalP2pWake(cam, now)) {
          log.info(cam, 'eufy livestream started (session=' + cam.getSessionId() + ')');
          return;
        }
        if (cam.shouldBackfillOnlyOnEvent()) {
          cam.queueEventBackfill(
              now,
              'livestream started',
              '',
              'livestream started',
              getEventPriority(DEFAULT_EXTERNAL_WAKE_EVENT),
              true
          );
          pushFrameToEncoder(cam, now);
          log.debug(
              cam,
              'livestream started while idle in backfill mode, queued/extended BackfillJob'
          );
          return;
        }
        log.warn(
            cam,
            'eufy livestream started after session was already closed/canceled, forcing immediate stop (initiator=bridge, cause=eufy_late_start)'
        );
        void call({command: 'device.stop_livestream', serialNumber: serial});
        return;
      }
      cam.markP2pStreamReady(Date.now(), false);
      handleStreamStartedOrRetriggered(cam, 'eufy livestream');
      return;

    case 'livestream stopped':
      handleLivestreamStoppedEvent(cam);
      return;

    case 'property changed': {
      noteStationActivity(cam.stationSerial);
      cam.markDeviceHeardInSession();
      const prevRssi = cam.getRssi();
      if (isTrackedPropertyEvent(e.name)) {
        applyDeviceProperties(cam, {[e.name]: e.value}, false);
      }
      if (
          e.name === 'wifiRssi' &&
          cam.getRssi() !== prevRssi &&
          cam.recordIdleRssiChange(Date.now())
      ) {
        forceStopWedgedP2pRadio(cam);
      }
      const mappedTriggerEvent = resolvePropertyTriggerEvent(e.name);
      if (
          mappedTriggerEvent &&
          typeof e.value === 'boolean' &&
          cam.shouldTriggerOnEvent(mappedTriggerEvent)
      ) {
        handleTriggerEvent(cam, {
          event: mappedTriggerEvent,
          state: e.value,
          serialNumber: serial,
        });
      }
      return;
    }

    default:
      if (cam.shouldTriggerOnEvent(e.event)) {
        handleTriggerEvent(cam, e);
      }
      return;
  }
}

/**
 * Immediately re-wakes an active RTSP camera when its FFmpeg pull decoder exits or Eufy stops
 * the RTSP feed mid-session while the hold/view timer is still active.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number|null} code - FFmpeg exit code or 0 for WS event.
 * @param {string} reasonText - Exit reason or stderr summary.
 */
function handleRtspStreamDropped(cam, code, reasonText) {
  const sessionId = cam.getSessionId();
  if (!cam.isCurrentSession(sessionId, STREAM_MODES.RTSP)) {
    return;
  }
  const now = Date.now();
  if (!cam.shouldRewakeRtspOnDrop(now)) {
    stop(cam, 'eufy ended RTSP livestream', false, 'eufy/rtsp-end');
    arbitrate();
    return;
  }
  const hadRecentStart = cam.hasRecentRtspStartAttempt(now);
  stopDecoder(cam);
  const remainingSecs = cam.beginRtspRewake(now, RTSP_REWAKE_MIN_HOLD_MS);
  if (cam.shouldExtendFrigateEvent(now, LIVE_FPS)) {
    frigateEvent(cam, cam.getReason(), cam.getEventPerson());
  }
  renderCameraCards(cam);
  pushFrameToEncoder(cam, now);
  log.info(
      cam,
      'RTSP stream ended mid-session (code=' +
      code +
      ', info="' +
      reasonText +
      '", remainingHold=' +
      remainingSecs +
      's), immediately re-waking RTSP stream (session=' +
      sessionId +
      ')'
  );
  if (hadRecentStart) {
    cam.scheduleRtspDecoderRetry(RTSP_RECENT_START_RETRY_DELAY_MS, () => {
      if (cam.canSpawnRtspDecoder(sessionId)) {
        startRtspDecoder(cam);
      }
    });
    return;
  }
  void startRtspStream(cam);
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
      log.info(cam, logMsg);
      if (killStalledDec) {
        stopDecoder(cam);
      }
      void startRtspStream(cam);
      break;
    case 'timeout':
      stop(cam, logMsg, false, 'error/rtsp-wake-timeout');
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
    stop(cam, 'post-event clip download stream completed', false, DOWNLOAD_COMPLETED_INITIATOR);
    arbitrate();
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
    stop(cam, 'post-event clip download timed out', false, 'error/download-timeout');
    arbitrate();
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
      stop(cam, logMsg, false, 'eufy/camera');
      break;
    case 'timeout':
      stop(cam, logMsg, false, 'error/watchdog-timeout');
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
  for (const cam of cams) {
    if (!cam.hasExpiredLiveHold(now)) {
      continue;
    }
    const maxDurReason = cam.expireMaxDurationHold(now);
    if (maxDurReason) {
      stop(cam, maxDurReason, false, STOP_INITIATORS.MAX_LIMIT);
      continue;
    }
    const viewMaxReason = cam.getViewMaxDurationReason(now);
    if (viewMaxReason) {
      stop(cam, viewMaxReason, false, STOP_INITIATORS.VIEW_LIMIT);
      continue;
    }
    void evaluateActiveHoldExtension(cam, clockNow);
  }
}

/**
 * Executes one housekeeping, arbitration, backfill, mask-sync, and session-health tick.
 *
 * @param {number} [clockNow] - Optional synthetic timestamp in milliseconds; uses Date.now() when omitted.
 */
function runHousekeepingTick(clockNow) {
  const now = clockNow === undefined ? Date.now() : clockNow;
  prepareExpiredCameraHolds(now, clockNow);
  arbitrate(now);
  void processBackfillQueue(now);
  if (isWsReady()) {
    checkPeriodicMaskSync(cams, now, isShuttingDownFn());
  }

  if (canRunStartupProbeNow(now, STARTUP_PROBE_READY_DELAY_MS)) {
    const nextProbeCam = cams.find((c) => c.canStartStartupProbe(cams, now));
    if (nextProbeCam) {
      nextProbeCam.startStartupProbe();
      trigger(nextProbeCam, 'startup snapshot probe', STARTUP_PROBE_HOLD_MS, WAKE_KINDS.VIEW, 'bridge-probe');
    }
  }

  for (const cam of cams) {
    if (!cam.isSessionActive()) {
      if (isWsReady() && cam.shouldTurnOffStuckIdleLight(now)) {
        log.warn(
            cam,
            'turning off stuck spotlight while idle (light=false) to restore deep sleep'
        );
        setCameraProperty(cam, 'light', false);
      }
      continue;
    }
    if (cam.hasExpiredLiveHold(now) && cam.isExtendCheckInFlight()) {
      continue;
    }
    const maxDurReason = cam.expireMaxDurationHold(now);
    if (maxDurReason) {
      stop(cam, maxDurReason, false, STOP_INITIATORS.MAX_LIMIT);
      continue;
    }
    const viewMaxReason = cam.getViewMaxDurationReason(now);
    if (viewMaxReason) {
      stop(cam, viewMaxReason, false, STOP_INITIATORS.VIEW_LIMIT);
      continue;
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
}

/**
 * Starts the 500ms housekeeping & watchdog loop.
 */
function startHousekeepingLoop() {
  setInterval(() => {
    runHousekeepingTick();
  }, HOUSEKEEPING_INTERVAL_MS);
}

module.exports = {
  initOrchestrator,
  wakeCameraExternal,
  trigger,
  stop,
  onEvent,
  processBackfillQueue,
  runHousekeepingTick,
  startHousekeepingLoop,
};
