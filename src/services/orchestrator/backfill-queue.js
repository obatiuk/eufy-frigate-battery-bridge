// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * HomeBase local database clip queries, serialized per-station backfill queue draining,
 * and download-finished session transitions.
 */
'use strict';

const {BACKFILL_DELAY_MS, LIVE_FPS, STREAM_MODES} = require('../../config');
const {log, formatErrorMessage} = require('../../logger');
const {Camera} = require('../../domain/camera');
const {stations} = require('../../domain/station');
const {
  BACKFILL_MAX_QUERY_ATTEMPTS,
  formatBackfillQueryDateRange,
  parseDatabaseQueryEvent,
} = require('../../domain/backfill-job');
const {pushFrameToEncoder} = require('../../media/encoder');
const {flushDecoderInput} = require('../../media/decoder');
const {frigateEvent} = require('../frigate-client');
const {formatRpcError, call, isWsReady} = require('../eufy-client');
const {getCams, findCameraBySerial, isShuttingDown, getStationTransition} = require('./context');
const {stop} = require('./wake');
const {arbitrate} = require('./arbitration');

const BACKFILL_MIN_EVENT_AGE_MS = 4000;
const BACKFILL_QUERY_COOLDOWN_MS = 4000;
const EXPECTED_STATION_CONNECT_ERROR_REGEX = /already_connected|ws_closed/i;

/**
 * Handles station database query results ("database query local" / "database query latest")
 * to locate and download missed event clips from the HomeBase internal storage.
 *
 * @param {Record<string, *>} e - Station event payload from eufy-security-ws.
 */
function handleDatabaseQueryResult(e) {
  const {eventLog, candidates} = parseDatabaseQueryEvent(e);
  log.debug('bridge', eventLog);
  if (!candidates.length) return;

  const now = Date.now();
  let matchedAny = false;
  for (const cand of candidates) {
    const cam = findCameraBySerial(cand.devSn);
    if (cam && cam.canMatchDatabaseQueryResult(now) && cam.tryMatchBackfillCandidate(cand)) {
      matchedAny = true;
      log.debug(cam, cam.formatBackfillClipMatchLog(cand));
    }
  }
  if (matchedAny) void processBackfillQueue(now);
}

/**
 * Connects to the HomeBase station and dispatches date-range and latest-info clip queries,
 * logging any unexpected RPC failures.
 *
 * @param {Camera} queryCam - Camera querying HomeBase for backfill clips.
 * @param {string} stationSn - HomeBase station serial number.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function dispatchBackfillDatabaseQueries(queryCam, stationSn, now) {
  const {startDate, endDate} = formatBackfillQueryDateRange(now);
  const connRes = await call({command: 'station.connect', serialNumber: stationSn});
  if (!connRes.success && connRes.errorCode && !EXPECTED_STATION_CONNECT_ERROR_REGEX.test(connRes.errorCode)) {
    log.warn(queryCam, 'station.connect failed before backfill query (errorCode=' + formatRpcError(connRes) + ')');
  }
  const byDateRes = await call({
    command: 'station.database_query_by_date',
    serialNumber: stationSn,
    serialNumbers: [queryCam.getSerial()],
    startDate,
    endDate,
  });
  if (!byDateRes.success) {
    log.warn(queryCam, 'station.database_query_by_date failed (errorCode=' + formatRpcError(byDateRes) + ')');
  }
  if (queryCam.needsLatestInfoBackfillQuery()) {
    const latestRes = await call({command: 'station.database_query_latest_info', serialNumber: stationSn});
    if (!latestRes.success) {
      log.warn(queryCam, 'station.database_query_latest_info failed (errorCode=' + formatRpcError(latestRes) + ')');
    }
  }
}

/**
 * Executes one serialized backfill expiry, download start, or HomeBase database query step
 * for all cameras attached to stationKey.
 *
 * @param {string} stationKey - Canonical HomeBase backfill station key.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function runStationBackfillStep(stationKey, now) {
  if (!isWsReady() || isShuttingDown()) return;
  const cams = getCams();
  const stationCams = cams.filter((c) => c.isStationBackfillMember(stationKey, cams));
  if (!stationCams.length) return;

  for (const c of stationCams) {
    const expiredReason = c.expirePendingBackfillIfNeeded(now, BACKFILL_MIN_EVENT_AGE_MS);
    if (expiredReason) {
      pushFrameToEncoder(c, now);
      log.debug(c, 'expired unfulfilled backfill request (' + expiredReason + ')');
      if (c.wantsWake(now)) arbitrate(now);
    }
  }

  const readyCam = Camera.selectReadyBackfillCam(stationCams, cams, {now, delayMs: BACKFILL_DELAY_MS});
  if (readyCam) {
    const {clip, sessionId: mySession, wakeLog} = readyCam.startNextBackfillDownload(now);
    log.info(readyCam, wakeLog);
    frigateEvent(readyCam, clip.event || 'motion detected', clip.personName || '');

    await getStationTransition(readyCam);
    if (!readyCam.isCurrentSession(mySession, STREAM_MODES.DOWNLOAD)) return;

    const res = await call({
      command: 'device.start_download',
      serialNumber: readyCam.getSerial(),
      path: clip.storagePath,
      cipherId: clip.cipherId,
    });
    if (!res.success && readyCam.isCurrentSession(mySession, STREAM_MODES.DOWNLOAD)) {
      const rpcErr = formatRpcError(res);
      log.warn(readyCam, 'device.start_download failed (errorCode=' + rpcErr + ')');
      stop(readyCam, 'start_download RPC failed (' + rpcErr + ')', {
        preemptedByViewer: false,
        initiator: 'error/download-failed',
      });
      arbitrate(now);
    }
    return;
  }

  const station = stations.get(stationKey);
  const queryCam = Camera.selectQueryableBackfillCam(stationCams, cams, {
    now,
    minEventAgeMs: BACKFILL_MIN_EVENT_AGE_MS,
    queryCooldownMs: BACKFILL_QUERY_COOLDOWN_MS,
    delayMs: BACKFILL_DELAY_MS,
    stationLastQueryAt: station.getLastBackfillQueryAt(),
  });
  if (!queryCam) return;

  const queryState = queryCam.beginBackfillDatabaseQuery(now, BACKFILL_MAX_QUERY_ATTEMPTS);
  if (!queryState.allowed) {
    pushFrameToEncoder(queryCam, now);
    log.warn(
      queryCam,
      'giving up on backfill query after ' + BACKFILL_MAX_QUERY_ATTEMPTS + ' attempts (' + queryState.reason + ')'
    );
    if (queryCam.wantsWake(now)) arbitrate(now);
    return;
  }

  const stationSn = queryCam.resolveHomeBaseStationSerial(cams);
  if (!stationSn) {
    log.warn(queryCam, 'cannot query backfill clip: stationSerial not yet known');
    return;
  }

  station.markBackfillQueried(now);
  log.debug(queryCam, queryCam.formatBackfillQueryAttemptLog(stationSn, queryState));
  await dispatchBackfillDatabaseQueries(queryCam, stationSn, now);
}

/**
 * Serializes backfill processing for a single HomeBase station key, coalescing any re-entrant
 * requests that arrive while an RPC step is already in flight so they run sequentially afterward.
 *
 * @param {string} stationKey - Canonical HomeBase backfill station key.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {Promise<void>}
 */
function scheduleStationBackfill(stationKey, now) {
  return stations.get(stationKey).scheduleBackfill(
    now,
    (stepNow) => runStationBackfillStep(stationKey, stepNow),
    (err) => log.error('bridge', 'backfill queue processing failed: ' + formatErrorMessage(err, true))
  );
}

/**
 * Queries HomeBase local databases and starts downloading missed event clips when station P2P slots are idle.
 *
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
async function processBackfillQueue(now = Date.now()) {
  if (!isWsReady() || isShuttingDown()) {
    return;
  }
  try {
    const stationKeys = Camera.collectStationBackfillKeys(getCams());
    await Promise.all(stationKeys.map((stationKey) => scheduleStationBackfill(stationKey, now)));
  } catch (err) {
    log.error('bridge', 'backfill queue processing failed: ' + formatErrorMessage(err, true));
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
  stations.get(cam.getStationKey()).releaseWakeSlot();
  arbitrate(now);
  void processBackfillQueue(now);
  if (cam.shouldExtendFrigateEvent(now, LIVE_FPS)) {
    frigateEvent(cam, cam.getBackfillEventLabel(), cam.getBackfillEventPerson());
  }
  if (bufferedCount > 0) {
    log.debug(cam, cam.formatBackfillTransferCompleteLog(bufferedCount, LIVE_FPS));
    return;
  }
  log.debug(
    cam,
    'eufy clip transfer complete, flushing decoder and holding final frame before sleep (session=' + mySession + ')'
  );
}

module.exports = {
  handleDatabaseQueryResult,
  processBackfillQueue,
  handleDownloadFinishedEvent,
};
