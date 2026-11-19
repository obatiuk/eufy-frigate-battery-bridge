// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Camera wake triggers, /api/wake handling, HomeBase RTSP & P2P stream start sequences,
 * and serialized session stop teardown.
 */
'use strict';

const {DEFAULT_EVENT_PRIORITY, STREAM_MODES, sleep} = require('../../config');
const {log, formatErrorMessage} = require('../../logger');
const {WakeRequest, WAKE_KINDS, API_WAKE_STATUSES} = require('../../domain/camera');
const {stations} = require('../../domain/station');
const {renderCameraCards} = require('../../overlay/card-renderer');
const {saveCachedFrame} = require('../../overlay/snapshot-cache');
const {pushFrameToEncoder, stopEncoder} = require('../../media/encoder');
const {startRtspDecoder, stopDecoder} = require('../../media/decoder');
const {frigateEvent} = require('../frigate-client');
const {
  formatRpcError,
  call,
  isWsReady,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  ensureStationReadyForP2pRetry,
  prepareRtspWakeAttempt,
  ensureRtspUrlAfterWakeStart,
  recoverUnresponsiveStation,
  recordStationWakeTimeout,
} = require('../eufy-client');
const {
  STATION_WAKE_PACING_MS,
  P2P_STOP_SETTLE_MS,
  DEFAULT_EXTERNAL_WAKE_EVENT,
  invokeArbitrate,
  getCams,
  isShuttingDown,
  getStationTransition,
  setStationTransition,
} = require('./context');

/** @typedef {import("../../domain/camera").Camera} Camera */

const API_WAKE_EVENT_PRIORITY = 250;
const API_WAKE_STALLED_RTSP_MS = 10000;
const RTSP_HANDSHAKE_MAX_POLLS = 22;
const RTSP_HANDSHAKE_POLL_MS = 250;
const RTSP_HANDSHAKE_WINDOW_MS = 5500;
const ALREADY_RUNNING_RESTART_DELAY_MS = 1000;
const FAILED_START_BACKOFF_MS = 5000;
const RTSP_STOP_SETTLE_MS = 250;

const ALREADY_RUNNING_ERROR_REGEX = /already_running/i;
const EXPECTED_STOP_ERROR_REGEX = /ws_closed|not_running|not_downloading/i;
const UNRESPONSIVE_WAKE_RPC_REGEX = /^(?:no_reply|station_not_connected)$/i;

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
  const queuedOrUpgraded = cam.queueOrUpgradeApiWakeBackfill(now, reason || 'external api wake', {
    evPriority: API_WAKE_EVENT_PRIORITY,
    defaultEvent: DEFAULT_EXTERNAL_WAKE_EVENT,
  });
  if (queuedOrUpgraded) {
    pushFrameToEncoder(cam, now);
  }
  return queuedOrUpgraded;
}

/**
 * Applies an external /api/wake trigger to cam when not shutting down and eufy-security-ws is reachable.
 *
 * @param {Camera} cam - Target Camera instance.
 * @param {{reason: string, durationMs: number, createEvent: boolean}} spec - Trigger specification.
 */
function applyExternalWakeTrigger(cam, spec) {
  const {reason, durationMs, createEvent} = spec;
  if (isShuttingDown()) {
    return;
  }
  if (!isWsReady() && !cam.isRtspDirect()) {
    log.warn(cam, 'api-wake "' + reason + '" aborted (eufy-security-ws disconnected)');
    return;
  }
  cam.recordApiWakeTriggered(createEvent);
  if (createEvent) {
    trigger(cam, {
      reason,
      ms: durationMs,
      kind: WAKE_KINDS.MOTION,
      initiator: 'api-wake',
      evPriority: API_WAKE_EVENT_PRIORITY,
    });
    if (cam.isActiveLiveSession()) {
      frigateEvent(cam, 'motion detected', '');
    }
  } else {
    trigger(cam, {reason, ms: durationMs, kind: WAKE_KINDS.VIEW, initiator: 'api-wake'});
  }
}

/**
 * Polls HomeBase telemetry when /api/wake arrives for an offline camera and wakes/backfills if recovered.
 *
 * @param {Camera} cam - Offline Camera instance.
 * @param {{reason: string, durationMs: number, createEvent: boolean, now: number}} spec - Wake context.
 */
function refreshOfflineCameraOnApiWake(cam, spec) {
  const {reason, durationMs, createEvent, now} = spec;
  if (!cam.shouldRefreshOfflineOnView(now)) {
    return;
  }
  log.info(
    cam,
    'api-wake "' +
      reason +
      '" received while camera is offline (' +
      (cam.getOfflineReason() || 'offline') +
      '), polling HomeBase for battery swap/recovery'
  );
  void Promise.resolve(fetchAllCameraTelemetry(true)).then(() => {
    if (!cam.isDeviceOffline() && !isShuttingDown()) {
      const refreshedNow = Date.now();
      if (cam.shouldBackfillOnlyOnApiWake(refreshedNow)) {
        queueApiWakeBackfill(cam, reason, refreshedNow);
      } else {
        applyExternalWakeTrigger(cam, {reason, durationMs, createEvent});
      }
    }
  });
}

/**
 * Wakes or extends a camera stream in response to an external /api/wake HTTP request.
 *
 * @param {Camera} cam - Target Camera instance.
 * @param {{
 *   durationMs: number,
 *   reason: string,
 *   createEvent: boolean,
 *   delayMs?: number
 * }} opts - Wake options or built WakeRequest.
 * @returns {{
 *   camera: string,
 *   title: string,
 *   status: string,
 *   mode: string,
 *   hold_secs: number,
 *   delay_ms: number,
 *   error?: string,
 * }}
 */
function wakeCameraExternal(cam, opts) {
  if (!cam.supportsApiWake()) {
    return cam.toApiWakeErrorResponse(API_WAKE_STATUSES.UNSUPPORTED);
  }
  const {durationMs, reason, createEvent, delayMs} = opts;
  const now = Date.now();
  cam.cancelStartupProbe();

  if (cam.isActiveLiveSession()) {
    cam.clearApiWakeTimer();
    applyExternalWakeTrigger(cam, {reason, durationMs, createEvent});
    if (cam.resetStalledRtspWakeIfNeeded(now, API_WAKE_STALLED_RTSP_MS)) {
      log.info(
        cam,
        'refreshing stalled RTSP wake on new api-wake "' + reason + '" (session=' + cam.getSessionId() + ')'
      );
      stopDecoder(cam);
      void startRtspStream(cam);
    }
    return cam.toApiWakeResponse(API_WAKE_STATUSES.EXTENDED, durationMs, 0);
  }

  if (cam.isDeviceOffline()) {
    refreshOfflineCameraOnApiWake(cam, {reason, durationMs, createEvent, now});
    return cam.toApiWakeErrorResponse(
      API_WAKE_STATUSES.OFFLINE,
      'Camera is offline (' + (cam.getOfflineReason() || 'offline') + '); telemetry refresh requested'
    );
  }

  if (cam.shouldBackfillOnlyOnApiWake(now)) {
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
    return cam.toApiWakeResponse(API_WAKE_STATUSES.BACKFILL, durationMs, 0);
  }

  if (cam.isBackfillPlayback()) {
    log.info(cam, 'api-wake "' + reason + '" scheduled after active backfill playback completes');
    return cam.deferApiWakeDuringBackfill({reason, durationMs, createEvent, evPriority: API_WAKE_EVENT_PRIORITY}, now);
  }

  if (cam.hasPendingApiWakeTimer()) {
    const remainingDelayMs = cam.coalesceApiWake({durationMs, reason, createEvent}, now);
    log.debug(
      cam,
      'coalesced duplicate api-wake "' + reason + '" into pending wake timer (in ' + remainingDelayMs + 'ms)'
    );
    return cam.toApiWakeResponse(API_WAKE_STATUSES.SCHEDULED, cam.getScheduledApiWakeDurationMs(), remainingDelayMs);
  }

  if (cam.shouldBackfillOnlyOnEvent()) {
    log.info(
      cam,
      'api-wake "' +
        reason +
        '" starting a live stream on a backfill-mode camera (no Eufy trigger, BackfillJob, or live session ' +
        'is active, so there is no clip to wait for' +
        (createEvent ? ')' : '; view-only wake, create_event=false)')
    );
  }

  const station = stations.get(cam.getStationKey());
  const {delayMs: rawDelayMs, scheduledSlotAt} = station.reserveWakeSlot(now, delayMs, STATION_WAKE_PACING_MS);
  const pacedReq = (createEvent ? WakeRequest.motion(reason, durationMs) : WakeRequest.view(reason, durationMs))
    .withInitiator('api-wake')
    .withCreateEvent(Boolean(createEvent))
    .withDelay(rawDelayMs)
    .build();
  const effectiveDelayMs = pacedReq.delayMs;

  if (effectiveDelayMs > 0) {
    cam.scheduleApiWake(
      {
        durationMs: pacedReq.durationMs,
        reason: pacedReq.reason,
        createEvent: pacedReq.createEvent,
        delayMs: effectiveDelayMs,
        now,
      },
      (pending) => {
        if (isShuttingDown()) {
          return;
        }
        if (!isWsReady() && !cam.isRtspDirect()) {
          station.releaseWakeSlotIfMatches(scheduledSlotAt);
          log.warn(cam, 'scheduled api-wake "' + pending.reason + '" skipped (eufy-security-ws disconnected)');
          return;
        }
        applyExternalWakeTrigger(cam, {
          reason: pending.reason,
          durationMs: pending.durationMs,
          createEvent: pending.createEvent,
        });
      }
    );
    return cam.toApiWakeResponse(API_WAKE_STATUSES.SCHEDULED, pacedReq.durationMs, effectiveDelayMs);
  }

  applyExternalWakeTrigger(cam, {
    reason: pacedReq.reason,
    durationMs: pacedReq.durationMs,
    createEvent: pacedReq.createEvent,
  });
  return cam.toApiWakeResponse(API_WAKE_STATUSES.WAKING, pacedReq.durationMs, 0);
}

/**
 * Extends a camera's wake timer for either a motion event or an active live viewer and runs
 * stream arbitration across all cameras.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {{
 *   reason: string,
 *   ms: number,
 *   kind: 'motion'|'view',
 *   initiator?: string,
 *   evPriority?: number,
 * }|string} opts - Trigger options object (or legacy reason string from locked acceptance tests).
 */
function trigger(cam, opts) {
  if (!isWsReady() && !cam.isRtspDirect()) {
    return;
  }
  const isLegacyString = typeof opts === 'string';
  const reason = isLegacyString ? opts : opts.reason;
  const ms = isLegacyString ? Number(arguments[2]) : opts.ms;
  const kind = isLegacyString ? String(arguments[3] || WAKE_KINDS.VIEW) : opts.kind;
  const initiator = (isLegacyString ? String(arguments[4] || '') : opts.initiator) || '';
  const evPriority =
    (isLegacyString ? (typeof arguments[5] === 'number' ? arguments[5] : undefined) : opts.evPriority) ??
    DEFAULT_EVENT_PRIORITY;

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

  const logOutcome = cam.applyWakeRequest(req, now, getCams());
  if (logOutcome.shouldLog) {
    const logFn = logOutcome.isDebug ? log.debug : log.info;
    logFn(cam, logOutcome.message);
  }
  invokeArbitrate();
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
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
async function startRtspStream(cam, now = Date.now()) {
  if (cam.isRtspDirect() && !cam.isSessionActive()) {
    const wakeLog = cam.prepareRtspDirectStart(now);
    if (wakeLog) {
      pushFrameToEncoder(cam, now);
      log.info(cam, wakeLog);
    }
  }
  if (!cam.canStartRtspStream()) {
    return;
  }
  const mySession = cam.markRtspAttemptStart(now);
  if (cam.shouldFileInitialRtspEvent()) {
    frigateEvent(cam, cam.getReason(), '');
  }
  if (cam.isRtspDirect()) {
    if (cam.canSpawnRtspDecoder(mySession)) {
      startRtspDecoder(cam);
    }
    return;
  }
  await getStationTransition(cam);
  if (!cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    return;
  }
  const serial = cam.getSerial();
  const stationSn = cam.resolveHomeBaseStationSerial(getCams());
  await prepareRtspWakeAttempt(cam, mySession, stationSn);
  if (!cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    return;
  }
  const r = await call({command: 'device.start_rtsp_livestream', serialNumber: serial});
  if (!r.success && r.errorCode && !ALREADY_RUNNING_ERROR_REGEX.test(r.errorCode)) {
    maybeRecoverStationOnWakeRpcFailure(stationSn, 'start_rtsp_livestream', r.errorCode);
    log.debug(
      cam,
      'device.start_rtsp_livestream returned ' + formatRpcError(r) + ' (relying on rtspStream property wake)'
    );
  }
  await ensureRtspUrlAfterWakeStart(cam, mySession, stationSn);
  if (cam.canSpawnRtspDecoder(mySession)) {
    startRtspDecoder(cam);
  } else if (!cam.getRtspUrl() && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    const logFn = cam.isFirstWakeAttempt() ? log.debug : log.warn;
    logFn(
      cam,
      'HomeBase did not provide rtspStreamUrl after start_rtsp_livestream - verify HomeBase P2P connection ' +
        'and NAS/RTSP setting (session=' +
        mySession +
        ')'
    );
  }
}

/**
 * Sends device.start_livestream to eufy-security-ws for the specified camera.
 *
 * @param {Camera} targetCam - Camera domain instance.
 */
async function startLivestream(targetCam) {
  const cam = targetCam;
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

      const cams = getCams();
      for (let i = 0; i < RTSP_HANDSHAKE_MAX_POLLS; i++) {
        const rtspWaking = cams.some((c) => c.isWakingRtspOnStation(cam, Date.now(), RTSP_HANDSHAKE_WINDOW_MS));
        if (!rtspWaking || !cam.isCurrentSession(mySession)) {
          break;
        }
        await sleep(RTSP_HANDSHAKE_POLL_MS);
      }
      if (!cam.isCurrentSession(mySession)) {
        return;
      }
      const stationSn = cam.resolveHomeBaseStationSerial(getCams());
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
            formatRpcError(r) +
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
          'start_livestream failed (initiator=eufy-ws, errorCode=' + formatRpcError(r) + ', session=' + mySession + ')'
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
 * Enqueues serialized HomeBase RPC teardown for a stopped non-direct camera session.
 *
 * @param {Camera} cam - Stopped Camera instance.
 * @param {{
 *   inFlightStart: Promise<*>|null,
 *   closedMode: string,
 *   hadDownloadFinished: boolean,
 *   hadUnexpectedRtsp: boolean,
 * }} teardown - Terminated session snapshot.
 */
function enqueueStopStationTeardown(cam, teardown) {
  const {inFlightStart, closedMode, hadDownloadFinished, hadUnexpectedRtsp} = teardown;
  const serial = cam.getSerial();
  setStationTransition(
    cam,
    getStationTransition(cam)
      .then(async () => {
        if (inFlightStart) {
          await inFlightStart.catch(() => {
            // Start errors were already logged inside startLivestream; only wait for settlement.
          });
        }
        switch (closedMode) {
          case STREAM_MODES.RTSP:
            await sleep(RTSP_STOP_SETTLE_MS);
            break;
          case STREAM_MODES.DOWNLOAD:
            if (!hadDownloadFinished) {
              const cancelRes = await call({command: 'device.cancel_download', serialNumber: serial});
              if (!cancelRes.success && cancelRes.errorCode && !EXPECTED_STOP_ERROR_REGEX.test(cancelRes.errorCode)) {
                log.debug(cam, 'device.cancel_download returned errorCode=' + formatRpcError(cancelRes));
              }
              await sleep(P2P_STOP_SETTLE_MS);
            }
            break;
          default: {
            try {
              const res = await call({command: 'device.stop_livestream', serialNumber: serial});
              if (!res.success && res.errorCode && !EXPECTED_STOP_ERROR_REGEX.test(res.errorCode)) {
                log.debug(cam, 'device.stop_livestream returned errorCode=' + formatRpcError(res));
              }
              if (hadUnexpectedRtsp) await call({command: 'device.stop_rtsp_livestream', serialNumber: serial});
              await sleep(P2P_STOP_SETTLE_MS);
            } finally {
              cam.clearP2pStopInFlight();
            }
            break;
          }
        }
      })
      .catch((err) => log.debug(cam, 'station teardown error: ' + formatErrorMessage(err)))
  );
}

/**
 * Normalizes stop() options across options-object callers and locked legacy positional callers.
 *
 * @param {{ preemptedByViewer?: boolean, initiator?: string }|boolean} opts - Stop options or legacy boolean.
 * @param {unknown} legacyInitiator - Optional 4th positional argument from locked acceptance tests.
 * @returns {{ preemptedByViewer: boolean, initiator: string }}
 */
function normalizeStopOptions(opts, legacyInitiator) {
  if (typeof opts === 'boolean') {
    return {
      preemptedByViewer: opts,
      initiator: (typeof legacyInitiator === 'string' ? legacyInitiator : '') || 'bridge',
    };
  }
  const safeOpts = opts || {};
  return {
    preemptedByViewer: Boolean(safeOpts.preemptedByViewer),
    initiator: safeOpts.initiator || 'bridge',
  };
}

/**
 * Selects the structured logger level function for a SLEEP log line from its initiator tag.
 *
 * @param {string} initiator - Stop initiator tag.
 * @returns {(scope: *, ...args: *[]) => void}
 */
function resolveStopLogFn(initiator) {
  if (initiator.startsWith('error/')) {
    return log.error;
  }
  if (initiator === 'bridge-max-limit' || initiator === 'bridge-view-limit') {
    return log.warn;
  }
  return initiator === 'rtsp-direct-probe' ? log.debug : log.info;
}

/**
 * Stops an active camera's P2P/RTSP/download session, waits for any in-flight startPromise,
 * tears down the decoder, and refreshes the sleeping card with the camera's own last frame.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} why - Reason the camera is going to sleep.
 * @param {{ preemptedByViewer?: boolean, initiator?: string }|boolean} [opts={}] - Stop options.
 */
function stop(cam, why, opts = {}) {
  if (!cam.isSessionActive()) return;
  const {preemptedByViewer, initiator} = normalizeStopOptions(opts, arguments[3]);

  const cams = getCams();
  const {
    inFlightStart,
    closedMode,
    hadDownloadFinished,
    hadUnexpectedRtsp,
    wokeWithoutDeviceReply,
    shouldPersistSnapshot,
    sleepMsg,
  } = cam.terminateSession(Date.now(), why, preemptedByViewer, initiator);
  const serial = cam.getSerial();
  if (wokeWithoutDeviceReply) void recordStationWakeTimeout(cam.resolveHomeBaseStationSerial(cams), initiator);

  // Clear station wake pacing when a P2P/download session ends so back-to-back switching starts immediately.
  if (closedMode !== STREAM_MODES.RTSP) stations.get(cam.getStationKey()).releaseWakeSlot();
  if (cam.shouldClearStationQueryCooldownAfterStop(closedMode)) {
    stations.get(cam.resolveStationBackfillKey(cams)).clearBackfillQueryCooldown();
  }

  resolveStopLogFn(initiator)(cam, sleepMsg);

  stopDecoder(cam);

  if (!cam.isRtspDirect()) {
    enqueueStopStationTeardown(cam, {inFlightStart, closedMode, hadDownloadFinished, hadUnexpectedRtsp});
  }

  if (shouldPersistSnapshot) void saveCachedFrame(cam);
  renderCameraCards(cam);
  if (cam.isDeviceOffline()) {
    stopEncoder(cam);
  } else if (!(
    closedMode === STREAM_MODES.DOWNLOAD &&
    (cam.isReadyForBackfillDownload() || cam.hasBackfillContinuation())
  )) {
    pushFrameToEncoder(cam);
  }

  if (closedMode !== STREAM_MODES.DOWNLOAD && !cam.isDeviceOffline() && !cam.isRtspDirect()) {
    call({command: 'device.get_properties', serialNumber: serial}).then((res) => {
      if (res.success && res.result && res.result.properties) {
        applyDeviceProperties(cam, res.result.properties, false);
      }
    });
  } else if (closedMode === STREAM_MODES.DOWNLOAD && cam.wantsWake()) {
    invokeArbitrate();
  }
}

module.exports = {
  wakeCameraExternal,
  trigger,
  startRtspStream,
  startLivestream,
  stop,
};
