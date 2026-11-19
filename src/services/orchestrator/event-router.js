// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Eufy WebSocket event router: frozen device event dispatch table, station/driver event
 * handling, external RTSP/P2P stream adoption, mid-session RTSP re-wakes, and wedged-radio stops.
 */
'use strict';

const {LIVE_FPS, STREAM_MODES, sleep, getEventPriority} = require('../../config');
const {log} = require('../../logger');
const {WAKE_KINDS} = require('../../domain/camera');
const {renderCameraCards} = require('../../overlay/card-renderer');
const {pushFrameToEncoder} = require('../../media/encoder');
const {startRtspDecoder, stopDecoder, onVideo, onAudio} = require('../../media/decoder');
const {frigateEvent} = require('../frigate-client');
const {
  call,
  setCameraProperty,
  isWsReady,
  isWsSettledForEvents,
  isTrackedPropertyEvent,
  resolvePropertyTriggerEvent,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  refreshMissingRtspUrlOnStart,
  isStationRecycling,
  noteStationActivity,
  scheduleStationReconnect,
  updateStationHealth,
  extractRecognizedPerson,
} = require('../eufy-client');
const {
  P2P_STOP_SETTLE_MS,
  DEFAULT_EXTERNAL_WAKE_EVENT,
  MIN_EVENT_VIDEO_DURATION_MS,
  MS_PER_SECOND,
  getCams,
  findCameraBySerial,
  isShuttingDown,
  getStationTransition,
  setStationTransition,
  resumeOfflineCameraIfNeeded,
} = require('./context');
const {trigger, startRtspStream, startLivestream, stop} = require('./wake');
const {arbitrate} = require('./arbitration');
const {handleDatabaseQueryResult, handleDownloadFinishedEvent} = require('./backfill-queue');

/** @typedef {import("../../domain/camera").Camera} Camera */

const MID_STREAM_RETRIGGER_GRACE_MS = 5000;
const EUFY_CLEARED_SETTLE_MS = 5000;
const MIN_CLEAN_EVENT_VIDEO_MS = 3000;
const EXTERNAL_WAKE_GUARD_MS = 3000;
const UNSOLICITED_VIDEO_STOP_DELAY_MS = 3000;
const WS_READY_EVENT_SETTLE_MS = 5000;
const STATION_RECONNECT_TELEMETRY_DELAY_MS = 3000;
const RTSP_REWAKE_MIN_HOLD_MS = 20000;
const RTSP_RECENT_START_RETRY_DELAY_MS = 750;

/**
 * Handles station-level events ('close', 'connection error', 'connect', and database query results).
 *
 * @param {Record<string, *>} e - Station event object from eufy-security-ws.
 */
function handleStationEvent(e) {
  const stationId = e.serialNumber || 'homebase';
  const stationCams = getCams().filter((cam) => cam.isOnStation(e.serialNumber));
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
          stop(c, 'Station (' + stationId + ') P2P disconnected/restarting', {
            preemptedByViewer: false,
            initiator: 'error/station-disconnect',
          });
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
        if (c.isCurrentSession(c.getSessionId(), STREAM_MODES.RTSP) && !c.hasGotVideo()) {
          void startRtspStream(c);
        }
      }
      log.info('bridge', 'HomeBase station (' + stationId + ') P2P connected');
      const timer = setTimeout(() => {
        if (isWsReady() && !isShuttingDown()) {
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
      stop(cam, 'eufy/camera ended event livestream', {
        preemptedByViewer: false,
        initiator: 'eufy/camera-event-end',
      });
      arbitrate();
      break;
    case 'interrupted':
      log.warn(cam, outcome.warnMsg);
      void startLivestream(cam);
      break;
    case 'expired':
      stop(cam, 'eufy livestream stopped as hold/view timer expired', {
        preemptedByViewer: false,
        initiator: 'eufy/camera',
      });
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
    const shortenedSecs = cam.recordMotionCleared(now, EUFY_CLEARED_SETTLE_MS, MIN_EVENT_VIDEO_DURATION_MS, e.event);
    if (shortenedSecs !== null) {
      log.info(
        cam,
        'eufy reported activity cleared (event="' + e.event + '"), ending stream in ' + shortenedSecs + 's'
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
          '" queued for HomeBase clip backfill (backfill_only=true, skipping live wake to conserve battery)'
      );
      return;
    }
    if (cam.isBackfillPlayback()) {
      const route = cam.routeHardwareTriggerDuringBackfill(triggerDesc, evPrio, now);
      log.info(cam, 'event trigger "' + triggerDesc + '" ' + route + ' while active backfill playback finishes');
      return;
    }
    const holdDuration = cam.getEventHoldMs();
    trigger(cam, {
      reason: triggerDesc,
      ms: holdDuration,
      kind: WAKE_KINDS.MOTION,
      initiator: 'eufy-event',
      evPriority: evPrio,
    });
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
      log.debug(cam, label + ' re-triggered while active (holdRemaining=' + holdSecs + 's, session=' + sessionId + ')');
    }
  } else {
    log.debug(cam, label + ' started (session=' + sessionId + ')');
  }
}

/**
 * Sends a single non-waking device.stop_livestream pulse when rapid wifiRssi updates arrive
 * while the camera session is idle after a completed session.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function forceStopWedgedP2pRadio(cam) {
  const serial = cam.getSerial();
  log.warn(
    cam,
    'detected wedged-awake P2P radio while idle (rapid wifiRssi updates while asleep) - ' +
      'forcing P2P stop to restore deep sleep'
  );
  if (cam.shouldTurnOffStuckIdleLight(Date.now())) {
    log.warn(cam, 'turning off stuck spotlight during idle wifiRssi drain (light=false) to restore deep sleep');
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
 * Handles an 'rtsp livestream started' event while the camera is not in an active live session,
 * queuing a BackfillJob or deferring a live wake during backfill playback and adopting idle wakes.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean} True if the event was handled without falling through to unexpected-RTSP stop.
 */
function handleNonLiveRtspStreamStarted(cam, now) {
  if (cam.isWithinPostSleepGuard(now, EXTERNAL_WAKE_GUARD_MS)) {
    return true;
  }
  const extPrio = getEventPriority(DEFAULT_EXTERNAL_WAKE_EVENT);
  if (cam.shouldBackfillOnlyOnEvent() || cam.isBackfillPlayback()) {
    cam.queueEventBackfill(now, 'rtsp livestream started', '', 'rtsp livestream started', extPrio, true);
    if (!cam.isSessionActive()) {
      pushFrameToEncoder(cam, now);
    } else {
      cam.routeHardwareTriggerDuringBackfill('rtsp livestream started', extPrio, now);
    }
    log.debug(cam, 'rtsp livestream started while idle/backfilling, queued/deferred follow-on event');
    return true;
  }
  if (!cam.isSessionActive() && tryAdoptExternalRtspWake(cam, now)) {
    log.debug(cam, 'eufy RTSP livestream started (session=' + cam.getSessionId() + ')');
    return true;
  }
  return false;
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
  if (cam.isRtspDirect()) {
    const out = cam.evaluateRtspDirectDrop(code, reasonText);
    stop(cam, out.stopWhy, {preemptedByViewer: false, initiator: out.stopInitiator});
    if (out.disruptionChanged) {
      (out.isReachableStandby ? log.info : log.warn)(cam, out.statusLog);
      renderCameraCards(cam);
      pushFrameToEncoder(cam);
    }
    return;
  }
  if (!cam.shouldRewakeRtspOnDrop(now)) {
    const endWhy =
      reasonText && reasonText !== 'rtsp livestream stopped event'
        ? 'eufy ended RTSP livestream (code=' + code + ', info="' + reasonText + '")'
        : 'eufy ended RTSP livestream';
    stop(cam, endWhy, {preemptedByViewer: false, initiator: 'eufy/rtsp-end'});
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
  const rewakeLogFn = code === 0 ? log.debug : log.info;
  rewakeLogFn(
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
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} e - Event payload.
 */
function handleLivestreamVideoData(cam, e) {
  resumeOfflineCameraIfNeeded(cam, 'livestream video data');
  if (cam.isBackfillPlayback()) {
    return;
  }
  if (!cam.isSessionActive()) {
    if (cam.isStoppingP2p()) {
      return;
    }
    const {shouldStop, sleptAgo} = cam.shouldStopUnsolicitedVideo(Date.now(), UNSOLICITED_VIDEO_STOP_DELAY_MS);
    if (shouldStop) {
      log.warn(
        cam,
        'received video while inactive, forcing stop of late stream ' +
          '(initiator=bridge, cause=eufy_unsolicited_video, sleptAgo=' +
          sleptAgo +
          ')'
      );
      void call({command: 'device.stop_livestream', serialNumber: cam.getSerial()});
    }
    return;
  }
  onVideo(cam, e);
}

/**
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} e - Event payload.
 */
function handleLivestreamAudioData(cam, e) {
  if (!cam.isBackfillPlayback()) {
    onAudio(cam, e);
  }
}

/**
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} e - Event payload.
 */
function handleDownloadVideoData(cam, e) {
  if (cam.isCurrentSession(cam.getSessionId(), STREAM_MODES.DOWNLOAD)) {
    onVideo(cam, e);
  }
}

/**
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} e - Event payload.
 */
function handleDownloadAudioData(cam, e) {
  if (cam.isCurrentSession(cam.getSessionId(), STREAM_MODES.DOWNLOAD)) {
    onAudio(cam, e);
  }
}

/**
 * @param {Camera} cam - Camera domain instance.
 */
function handleDownloadStarted(cam) {
  const sessionId = cam.getSessionId();
  if (!cam.isCurrentSession(sessionId, STREAM_MODES.DOWNLOAD)) {
    void call({command: 'device.cancel_download', serialNumber: cam.getSerial()});
    return;
  }
  cam.markP2pStreamReady(Date.now(), false);
  log.debug(cam, 'eufy clip download started (session=' + sessionId + ')');
}

/**
 * @param {Camera} cam - Camera domain instance.
 */
function handleRtspLivestreamStarted(cam) {
  const sessionId = cam.getSessionId();
  const serial = cam.getSerial();
  resumeOfflineCameraIfNeeded(cam, 'rtsp livestream started');
  cam.markDeviceHeardInSession();
  if (cam.isCurrentSession(sessionId, STREAM_MODES.RTSP)) {
    if (!cam.getRtspUrl()) {
      void refreshMissingRtspUrlOnStart(cam, sessionId);
    }
    if (cam.canSpawnRtspDecoder()) {
      startRtspDecoder(cam);
    }
    if (!cam.isEstablishedRtspStream() || cam.isMidStreamRetrigger(Date.now(), MID_STREAM_RETRIGGER_GRACE_MS)) {
      handleStreamStartedOrRetriggered(cam, 'eufy RTSP livestream');
    }
    return;
  }
  if (!cam.isActiveLiveSession() && handleNonLiveRtspStreamStarted(cam, Date.now())) {
    return;
  }
  const {shouldStopRtsp, shouldDisableRtspProp, shouldRestartP2p} = cam.evaluateUnexpectedRtspStart();
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
      if (shouldRestartP2p && cam.isCurrentSession(sessionId, STREAM_MODES.P2P) && !cam.hasGotVideo()) {
        stopDecoder(cam);
        void startLivestream(cam);
      }
    });
  }
}

/**
 * @param {Camera} cam - Camera domain instance.
 */
function handleRtspLivestreamStopped(cam) {
  const sessionId = cam.getSessionId();
  if (cam.isCurrentSession(sessionId, STREAM_MODES.RTSP)) {
    handleRtspStreamDropped(cam, 0, 'rtsp livestream stopped event');
  } else if (!cam.isActiveLiveSession() && cam.hasPendingBackfill()) {
    cam.recordMotionCleared(Date.now(), EUFY_CLEARED_SETTLE_MS, MIN_EVENT_VIDEO_DURATION_MS, 'rtsp livestream started');
  }
}

/**
 * @param {Camera} cam - Camera domain instance.
 */
function handleLivestreamStarted(cam) {
  resumeOfflineCameraIfNeeded(cam, 'livestream started');
  cam.markDeviceHeardInSession();
  if (cam.isBackfillPlayback()) {
    return;
  }
  if (!cam.isSessionActive()) {
    const now = Date.now();
    if (cam.isWithinPostSleepGuard(now, EXTERNAL_WAKE_GUARD_MS)) {
      return;
    }
    if (tryAdoptExternalP2pWake(cam, now)) {
      log.debug(cam, 'eufy livestream started (session=' + cam.getSessionId() + ')');
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
      log.debug(cam, 'livestream started while idle in backfill mode, queued/extended BackfillJob');
      return;
    }
    log.warn(
      cam,
      'eufy livestream started after session was already closed/canceled, forcing immediate stop ' +
        '(initiator=bridge, cause=eufy_late_start)'
    );
    void call({command: 'device.stop_livestream', serialNumber: cam.getSerial()});
    return;
  }
  cam.markP2pStreamReady(Date.now(), false);
  handleStreamStartedOrRetriggered(cam, 'eufy livestream');
}

/**
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} e - Event payload.
 */
function handlePropertyChanged(cam, e) {
  noteStationActivity(cam.getStationSerial());
  cam.markDeviceHeardInSession();
  const prevRssi = cam.getRssi();
  if (isTrackedPropertyEvent(e.name)) {
    applyDeviceProperties(cam, {[e.name]: e.value}, false);
  }
  if (e.name === 'wifiRssi' && cam.getRssi() !== prevRssi && cam.recordIdleRssiChange(Date.now())) {
    forceStopWedgedP2pRadio(cam);
  }
  const mappedTriggerEvent = resolvePropertyTriggerEvent(e.name);
  if (mappedTriggerEvent && typeof e.value === 'boolean' && cam.shouldTriggerOnEvent(mappedTriggerEvent)) {
    handleTriggerEvent(cam, {
      event: mappedTriggerEvent,
      state: e.value,
      serialNumber: cam.getSerial(),
    });
  }
}

/**
 * Frozen dispatch table mapping canonical Eufy device event names to their per-camera handlers.
 *
 * @type {Readonly<Record<string, (cam: Camera, e: Record<string, *>) => void>>}
 */
const DEVICE_EVENT_HANDLERS = Object.freeze({
  'livestream video data': handleLivestreamVideoData,
  'livestream audio data': handleLivestreamAudioData,
  'download video data': handleDownloadVideoData,
  'download audio data': handleDownloadAudioData,
  'download started': (cam) => handleDownloadStarted(cam),
  'download finished': (cam) => handleDownloadFinishedEvent(cam),
  'rtsp livestream started': (cam) => handleRtspLivestreamStarted(cam),
  'rtsp livestream stopped': (cam) => handleRtspLivestreamStopped(cam),
  'livestream started': (cam) => handleLivestreamStarted(cam),
  'livestream stopped': (cam) => handleLivestreamStoppedEvent(cam),
  'property changed': handlePropertyChanged,
});

/**
 * Handles incoming event notifications from eufy-security-ws.
 *
 * @param {Record<string, *>} eventPayload - Event object from eufy-security-ws.
 */
function onEvent(eventPayload) {
  if (isShuttingDown()) {
    return;
  }
  const e = eventPayload;
  if (e.event === 'device added' && e.device && e.device.serialNumber) {
    const cam = findCameraBySerial(e.device.serialNumber);
    if (cam && !cam.isRtspDirect()) {
      applyDeviceProperties(cam, e.device);
    }
    return;
  }
  if (e.source === 'station') {
    handleStationEvent(e);
    return;
  }
  if (e.source === 'driver') {
    if (e.event === 'connect' && isWsReady() && !isShuttingDown()) {
      log.info('bridge', 'eufy-security-ws cloud driver connected, refreshing camera telemetry');
      void fetchAllCameraTelemetry(false);
    }
    return;
  }

  const cam = findCameraBySerial(String(e.serialNumber || ''));
  if (!cam || cam.isRtspDirect()) {
    return;
  }

  const handler = Object.prototype.hasOwnProperty.call(DEVICE_EVENT_HANDLERS, e.event)
    ? DEVICE_EVENT_HANDLERS[e.event]
    : null;
  if (handler) {
    handler(cam, e);
    return;
  }
  if (cam.shouldTriggerOnEvent(e.event)) {
    handleTriggerEvent(cam, e);
  }
}

module.exports = {
  DEVICE_EVENT_HANDLERS,
  onEvent,
  handleRtspStreamDropped,
};
