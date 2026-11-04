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
  sleep,
  getEventPriority,
} = require('../config');
const {log} = require('../logger');
const {Camera} = require('../domain/camera');
const {
  BACKFILL_MAX_QUERY_ATTEMPTS,
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

// RTSP session health, handshake protection, fast retry, and wake timeout thresholds.
const RTSP_REWAKE_MIN_HOLD_MS = 20000;
const RTSP_WAKE_RETRY_MS = 3500;
const RTSP_MID_SESSION_STALL_MS = 3500;
const RTSP_MAX_WAKE_RETRIES = 5;
const RTSP_WAKE_TIMEOUT_MS = 25000;
const RTSP_HANDSHAKE_ACTIVE_MS = 400;
const RTSP_DEC_STALL_MS = 6000;

// P2P watchdog retry thresholds.
const P2P_INITIAL_RETRY_MS = 5500;
const P2P_SUBSEQUENT_RETRY_MS = 8000;
const P2P_MAX_WATCHDOG_RETRIES = 3;

// HomeBase clip backfill queue and download health thresholds.
const BACKFILL_MIN_EVENT_AGE_MS = 8000;
const BACKFILL_QUERY_COOLDOWN_MS = 12000;
const BACKFILL_DATE_WINDOW_MS = 86400000;
const DOWNLOAD_MIN_PLAYBACK_MS = 4500;
const DOWNLOAD_IDLE_COMPLETE_MS = 3000;
const DOWNLOAD_NO_VIDEO_TIMEOUT_MS = 10000;

// Housekeeping loop and startup snapshot probe intervals.
const HOUSEKEEPING_INTERVAL_MS = 500;
const STARTUP_PROBE_READY_DELAY_MS = 6000;
const STARTUP_PROBE_HOLD_MS = 25000;

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
  setRtspDropHandler(handleRtspStreamDropped);
}

/**
 * Evaluates whether an active motion-woken camera can go to sleep early to conserve battery.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function evaluateEarlySleep(cam, now) {
  const {due, clearedByEufy} = cam.checkEarlySleepDue(
      now,
      EARLY_SLEEP_POLL_INTERVAL_MS,
      EUFY_CLEARED_SETTLE_MS
  );
  if (!due) {
    return;
  }

  const frigateIdle = await isFrigateCameraIdle(cam);
  if (!cam.active || !cam.isInMotion(now) || now < cam.viewUntil) {
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
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function evaluateActiveHoldExtension(cam, now) {
  const {shouldPoll, needsTimeoutExtendCheck} = cam.shouldPollFrigateForHoldOrBackfill(
      now,
      HOLD_EXTEND_CHECK_WINDOW_MS,
      MAX_HOLD_SAFETY_MARGIN_MS,
      HOLD_EXTEND_POLL_COOLDOWN_MS
  );
  if (!shouldPoll) {
    return;
  }

  const frigateIdle = await isFrigateCameraIdle(cam);
  if (!cam.active || frigateIdle) {
    return;
  }

  cam.frigateSawObject = true;
  cam.cancelBackfillIfLiveConfirmed(Date.now(), MIN_TRIGGER_EXTENSION_MS);
  if (!needsTimeoutExtendCheck) {
    return;
  }

  const {extendMs, holdSecs} = cam.extendActiveHold(Date.now(), MIN_HOLD_EXTENSION_MS, false);
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
 * Wakes or extends a camera stream in response to an external /api/wake HTTP request.
 *
 * @param {Camera} cam - Target Camera instance.
 * @param {{ durationMs: number, reason: string, createEvent: boolean, delayMs?: number }} opts - Wake options.
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
    cam.clearApiWakeTimer();
    applyWakeTrigger(reason, durationMs, createEvent);
    if (cam.resetStalledRtspWakeIfNeeded(now, API_WAKE_STALLED_RTSP_MS)) {
      log.info(
          cam,
          'refreshing stalled RTSP wake on new api-wake "' + reason + '" (session=' + cam.sessionId + ')'
      );
      stopDecoder(cam);
      void startRtspStream(cam);
    }
    return cam.toApiWakeResponse('extended', durationMs, 0);
  }

  if (cam.apiWakeTimer) {
    const remainingDelayMs = cam.coalesceApiWake(durationMs, reason, createEvent, now);
    log.debug(
        cam,
        'coalesced duplicate api-wake "' +
        reason +
        '" into pending wake timer (in ' +
        remainingDelayMs +
        'ms)'
    );
    return cam.toApiWakeResponse('scheduled', cam.apiWakePendingOpts.durationMs, remainingDelayMs);
  }

  const stationKey = cam.getStationKey();
  const nextSlotAt = Math.max(now, stationNextWakeAt.get(stationKey) || 0);
  const effectiveDelayMs = delayMs !== undefined ? delayMs : Math.max(0, nextSlotAt - now);
  stationNextWakeAt.set(stationKey, now + effectiveDelayMs + STATION_WAKE_PACING_MS);

  if (effectiveDelayMs > 0) {
    cam.scheduleApiWake(durationMs, reason, createEvent, effectiveDelayMs, now, (pending) => {
      applyWakeTrigger(pending.reason, pending.durationMs, pending.createEvent);
    });
    return cam.toApiWakeResponse('scheduled', durationMs, effectiveDelayMs);
  }

  applyWakeTrigger(reason, durationMs, createEvent);
  return cam.toApiWakeResponse('waking', durationMs, 0);
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
  const resolvedInitiator = initiator || (kind === 'motion' ? 'eufy-event' : 'viewer');

  const logOutcome =
      kind === 'motion'
          ? cam.applyMotionTrigger(
              now,
              reason,
              ms,
              resolvedInitiator,
              evPriority,
              MID_STREAM_EVENT_GRACE_MS,
              MIN_TRIGGER_EXTENSION_MS,
              COMPANION_MOTION_LOG_DEBOUNCE_MS
          )
          : cam.applyViewTrigger(
              now,
              reason,
              ms,
              resolvedInitiator,
              cams,
              MID_STREAM_EVENT_GRACE_MS,
              MIN_TRIGGER_EXTENSION_MS,
              API_TRIGGER_LOG_DEBOUNCE_MS
          );

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
  rCam.eventActive = rCam.isInMotion(now);
  if (!rCam.eventActive) {
    rCam.clearPendingBackfill();
  }
  rCam.beginSession('rtsp', now, true);
  pushFrameToEncoder(rCam, now);
  log.info(
      rCam,
      'WAKE [RTSP] (initiator=' +
      (rCam.wakeInitiator || 'bridge') +
      ', reason="' +
      rCam.reason +
      '", priority=' +
      rCam.getEffectivePriority(now) +
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
  const stationCams = cams.filter((c) => !c.isRtspCapable() && c.getStationKey() === stationKey);
  let cur = stationCams.find((c) => c.usesP2pSlot());

  if (cur && cur.activeMode !== 'download' && now >= cur.wantUntil()) {
    stop(cur, 'hold/view timer expired, no more activity or viewers', false, 'bridge-timer');
    cur = null;
  }

  const wanting = stationCams.filter((c) => !c.active && now < c.wantUntil());
  if (!wanting.length || !isWsReady()) {
    return;
  }

  const pick = wanting.sort((a, b) => Camera.compareWanting(a, b))[0];

  if (cur && cur.activeMode === 'download') {
    if (cur.isTestBackfill && !pick.isInMotion(now)) {
      return;
    }
    stop(
        cur,
        'backfill download preempted by live request on ' + pick.name + ' (' + pick.reason + ')',
        !pick.isInMotion(now),
        'bridge-arbitrator/live-over-download'
    );
    cur = null;
  }

  if (cur) {
    if (!pick.canPreempt(cur, now, P2P_WAKE_STALL_PREEMPT_MS)) {
      for (const c of wanting) {
        if (!c.isInMotion(now)) {
          c.clearViewerQueue('blocked by active stream on ' + cur.name);
        } else if (!PREEMPT_EVENT_STREAMS && c.lastMotionAt > cur.lastMotionAt) {
          c.motionUntil = 0;
          c.eventPriority = 0;
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
        'preempted by ' + pick.name + ' (' + pick.reason + ', priority=' + pickScore + ' vs ' + curScore + ')',
        !pick.isInMotion(now),
        preemptInitiator
    );
  }

  for (const c of wanting) {
    if (c !== pick && !c.isInMotion(now)) {
      c.clearViewerQueue('not selected by arbitrator, ' + pick.name + ' won station slot');
    }
  }

  stationNextWakeAt.set(stationKey, Math.max(stationNextWakeAt.get(stationKey) || 0, now + STATION_WAKE_PACING_MS));
  pick.eventActive = pick.isInMotion(now);
  pick.beginSession('p2p', now, false);
  pushFrameToEncoder(pick, now);
  const ecoTag = pick.isLowBattery() ? ' [low-battery economy mode]' : '';
  log.info(
      pick,
      'WAKE (initiator=' +
      (pick.wakeInitiator || 'bridge') +
      ', reason="' +
      pick.reason +
      '", station=' +
      stationKey +
      ', priority=' +
      pick.getEffectivePriority(now) +
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
    if (now >= rCam.wantUntil()) {
      stop(rCam, 'RTSP hold/view timer expired', false, 'bridge-timer');
    }
  }

  for (const rCam of cams.filter((c) => !c.active && now < c.wantUntil() && c.isRtspCapable())) {
    activateRtspCamera(rCam, now);
  }

  const stationKeys = new Set(cams.filter((c) => !c.isRtspCapable()).map((c) => c.getStationKey()));
  for (const stationKey of stationKeys) {
    arbitrateStationP2pSlot(stationKey, now);
  }
}

/**
 * Starts a HomeBase RTSP pull stream for a camera and requests device.start_rtsp_livestream.
 *
 * @param {Camera} cam - Camera domain instance.
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
  if (!cam.isCurrentSession(mySession, 'rtsp')) {
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
  if (cam.isCurrentSession(mySession, 'rtsp') && cam.rtspUrl && !cam.dec) {
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
    if (cam && cam.tryMatchBackfillCandidate(cand)) {
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
  if (cams.some((c) => c.usesP2pSlot() || (!c.active && !c.isRtspCapable() && now < c.wantUntil()))) {
    return;
  }
  const hasUrgentTest = cams.some((c) => c.hasUrgentTestBackfill());
  const lastP2pActivity = Math.max(0, ...cams.map((c) => c.sleptAt || 0));
  if (!hasUrgentTest && now - lastP2pActivity < BACKFILL_DELAY_MS) {
    return;
  }

  for (const c of cams) {
    if (c.isBackfillExpired(now)) {
      log.debug(c, 'expired unfulfilled backfill request (' + c.pendingBackfill.reason + ')');
      c.clearPendingBackfill();
    }
  }

  const readyCam = cams
      .filter((c) => c.isReadyForBackfillDownload())
      .sort((a, b) => (b.pendingBackfill?.priority || 0) - (a.pendingBackfill?.priority || 0))[0];

  if (readyCam) {
    const clip = readyCam.backfillClip;
    const isTest = readyCam.hasUrgentTestBackfill();
    readyCam.beginBackfillDownload(clip, isTest, now);
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
      .filter((c) => c.canQueryBackfill(now, BACKFILL_MIN_EVENT_AGE_MS, BACKFILL_QUERY_COOLDOWN_MS))
      .sort((a, b) => b.pendingBackfill.priority - a.pendingBackfill.priority)[0];

  if (!queryCam) {
    return;
  }
  queryCam.lastBackfillQueryAt = now;
  if (!queryCam.pendingBackfill.consumeQueryAttempt(BACKFILL_MAX_QUERY_ATTEMPTS)) {
    log.debug(
        queryCam,
        'giving up on backfill query after ' + BACKFILL_MAX_QUERY_ATTEMPTS + ' attempts (' + queryCam.pendingBackfill.reason + ')'
    );
    queryCam.clearPendingBackfill();
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
 * @param {Camera} cam - Camera domain instance.
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

      cam.p2pReady = true;
      cam.lastStartAt = Date.now();
      let r = await call({command: 'device.start_livestream', serialNumber: cam.serial});

      if (!cam.isCurrentSession(mySession)) {
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
        if (!cam.isCurrentSession(mySession)) {
          return;
        }
        cam.p2pReady = true;
        cam.lastStartAt = Date.now();
        r = await call({command: 'device.start_livestream', serialNumber: cam.serial});
        if (!cam.isCurrentSession(mySession)) {
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
        if (cam.isCurrentSession(mySession)) {
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
 * @param {Camera} cam - Camera domain instance.
 * @param {string} why - Reason the camera is going to sleep.
 * @param {boolean} [preemptedByViewer=false] - True if stopped because the user opened another camera.
 * @param {string} [initiator='bridge'] - Decision maker identifier.
 */
function stop(cam, why, preemptedByViewer = false, initiator = 'bridge') {
  if (!cam.active) {
    return;
  }
  const {inFlightStart, closedMode, sleepMsg} = cam.terminateSession(
      Date.now(),
      why,
      preemptedByViewer,
      initiator
  );

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
        c.clearViewerQueue('station_disconnected');
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
 * @param {Camera} cam - Camera domain instance.
 */
function handleDownloadFinishedEvent(cam) {
  if (!cam.isCurrentSession(cam.sessionId, 'download')) {
    return;
  }
  const {bufferedCount, waitMs} = cam.markDownloadFinished(Date.now(), DOWNLOAD_MIN_PLAYBACK_MS);
  if (bufferedCount > 0) {
    log.info(
        cam,
        'eufy clip transfer complete, playing remaining ' +
        bufferedCount +
        ' buffered frames at ' +
        LIVE_FPS +
        ' fps (session=' +
        cam.sessionId +
        ')'
    );
    return;
  }

  if (waitMs > 0) {
    const finSession = cam.sessionId;
    setTimeout(() => {
      if (cam.isCurrentSession(finSession, 'download')) {
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
 * @param {Camera} cam - Camera domain instance.
 */
function handleLivestreamStoppedEvent(cam) {
  const now = Date.now();
  const liveSecs = cam.startedAt ? Math.round((now - cam.startedAt) / 1000) : 0;
  const lastVideoAgo = cam.lastVideoAt ? ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
  cam.p2pReady = false;
  stopDecoder(cam);

  if (cam.didEufyEndEventCleanly(now, MIN_CLEAN_EVENT_VIDEO_MS)) {
    cam.motionUntil = 0;
    stop(cam, 'eufy/camera ended event livestream', false, 'eufy/camera-event-end');
    arbitrate();
    return;
  }

  if (cam.active && now < cam.wantUntil()) {
    const remainingSecs = Math.round((cam.wantUntil() - now) / 1000);
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
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} e - Trigger event payload from eufy-security-ws.
 */
function handleTriggerEvent(cam, e) {
  if (e.state === false) {
    const shortenedSecs = cam.recordMotionCleared(
        Date.now(),
        EUFY_CLEARED_SETTLE_MS,
        MIN_EVENT_VIDEO_DURATION_MS
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
    log.debug(cam, 'eufy reported activity cleared (event="' + e.event + '")');
    return;
  }

  if (e.state === true && Date.now() - getWsReadyAt() > WS_READY_EVENT_SETTLE_MS) {
    cam.motionClearedAt = 0;
    cam.cancelStartupProbe();
    const holdDuration = cam.isLowBattery() ? Math.min(HOLD_MS, LOW_BAT_HOLD_MS) : HOLD_MS;
    const personName = extractRecognizedPerson(e);
    const triggerDesc = personName ? e.event + ' (' + personName + ')' : e.event;
    const evPrio = getEventPriority(e.event);
    cam.queueEventBackfill(Date.now(), e.event, personName, triggerDesc, evPrio);
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
      cam.sessionId +
      ')'
  );
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
  if (cam.gotVideo && now - (cam.lastStartAt || 0) > MID_STREAM_RETRIGGER_GRACE_MS) {
    const {extendMs, holdSecs} = cam.extendActiveHold(now, MIN_HOLD_EXTENSION_MS, true);
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
      applyDeviceProperties(cam, e.device, !cam.telemetry.hasBatteryReading());
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
      if (cam.isCurrentSession(cam.sessionId, 'download')) {
        onVideo(cam, e);
      }
      return;

    case 'download audio data':
      if (cam.isCurrentSession(cam.sessionId, 'download')) {
        onAudio(cam, e);
      }
      return;

    case 'download started':
      if (!cam.isCurrentSession(cam.sessionId, 'download')) {
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
      if (cam.canAdoptExternalWake(Date.now(), EXTERNAL_WAKE_GUARD_MS, false)) {
        trigger(cam, 'external RTSP wake - eufy-security-ws', HOLD_MS, 'view', 'eufy-ws');
        return;
      }
      if (cam.isCurrentSession(cam.sessionId, 'rtsp')) {
        if (cam.rtspUrl && !cam.dec) {
          startRtspDecoder(cam, cam.rtspUrl);
        }
        handleStreamStartedOrRetriggered(cam, 'eufy RTSP livestream');
      } else {
        log.debug(cam, 'ignoring RTSP livestream started event while in P2P/idle mode');
      }
      return;

    case 'rtsp livestream stopped':
      if (cam.isCurrentSession(cam.sessionId, 'rtsp')) {
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
 * @param {Camera} cam - Camera domain instance.
 * @param {number|null} code - FFmpeg exit code or 0 for WS event.
 * @param {string} reasonText - Exit reason or stderr summary.
 */
function handleRtspStreamDropped(cam, code, reasonText) {
  if (!cam.isCurrentSession(cam.sessionId, 'rtsp')) {
    return;
  }
  const now = Date.now();
  if (LET_EUFY_DECIDE_END || now >= cam.wantUntil()) {
    stop(cam, 'eufy ended RTSP livestream', false, 'eufy/rtsp-end');
    arbitrate();
    return;
  }
  stopDecoder(cam);
  const remainingSecs = cam.beginRtspRewake(now, RTSP_REWAKE_MIN_HOLD_MS);
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
 * Checks health, non-destructive wake retries, and timeout conditions for an active RTSP camera session.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} quietSince - Timestamp of last video packet or start attempt.
 */
function checkRtspSessionHealth(cam, now, quietSince) {
  const {action, killStalledDec, logMsg} = cam.evaluateRtspHealth(
      now,
      quietSince,
      RTSP_HANDSHAKE_ACTIVE_MS,
      RTSP_DEC_STALL_MS,
      RTSP_WAKE_RETRY_MS,
      RTSP_MAX_WAKE_RETRIES,
      RTSP_WAKE_TIMEOUT_MS,
      RTSP_MID_SESSION_STALL_MS
  );
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
 * @param {number} quietSince - Timestamp of last video packet or start attempt.
 */
function checkDownloadSessionHealth(cam, now, quietSince) {
  if (cam.isDownloadComplete(now, DOWNLOAD_IDLE_COMPLETE_MS)) {
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
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} quietSince - Timestamp of last video packet or start attempt.
 */
function checkP2pSessionHealth(cam, now, quietSince) {
  const {action, logMsg} = cam.evaluateP2pHealth(
      now,
      quietSince,
      P2P_INITIAL_RETRY_MS,
      P2P_SUBSEQUENT_RETRY_MS,
      P2P_MAX_WATCHDOG_RETRIES
  );
  if (action === 'timeout') {
    stop(cam, logMsg, false, 'error/watchdog-timeout');
  } else if (action === 'retry') {
    log.warn(cam, logMsg);
    stopDecoder(cam);
    void startLivestream(cam);
  }
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
      const nextProbeCam = cams.find((c) => c.canStartStartupProbe(cams, now));
      if (nextProbeCam) {
        nextProbeCam.startStartupProbe();
        trigger(nextProbeCam, 'startup snapshot probe', STARTUP_PROBE_HOLD_MS, 'view', 'bridge-probe');
      }
    }

    for (const cam of cams) {
      if (!cam.active) {
        continue;
      }
      if (cam.hasReachedMaxDuration(now)) {
        cam.motionUntil = 0;
        stop(
            cam,
            'reached max_secs limit (' + Math.round(MAX_MS / 60000) + 'm)',
            false,
            'bridge-max-limit'
        );
        continue;
      }
      if (cam.hasReachedViewMaxDuration(now)) {
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
  wakeCameraExternal,
  trigger,
  stop,
  onEvent,
  processBackfillQueue,
  startHousekeepingLoop,
};
