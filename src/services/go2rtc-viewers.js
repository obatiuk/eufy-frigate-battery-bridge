// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * go2rtc viewer detection: one bulk stream-table poll per tick, viewer wake classification, and go2rtc API
 * connectivity tracking.
 */
'use strict';

const {cfg} = require('../config');
const {log, formatErrorMessage} = require('../logger');
const {WAKE_KINDS} = require('../domain/camera');
const {OFFLINE_SNAPSHOT_SEED_MS, pushFrameToEncoder, seedOfflineCameraSnapshots} = require('../media/encoder');
const {syncServiceHealthFlags, readHttpErrorSnippet, FRIGATE_FAST_QUERY_TIMEOUT_MS} = require('./upstream-health');

/** @typedef {import("../domain/camera").Camera} Camera */

const INTERNAL_RECORDER_USER_AGENT_REGEX = /FFmpeg Frigate|^go2rtc/i;
const VIEWER_ACTION_JOINED_WHILE_LIVE = 'joined while live, does not extend it';
const VIEWER_ACTION_IN_COOLDOWN = 'ignored, camera just went to sleep (cooldown)';
const DIRECT_RTSP_VIEWER_ACTIONS = Object.freeze({
  ACTIVE: 'streaming direct RTSP',
  IDLE: 'connecting direct RTSP stream',
});
const NO_GO2RTC_POLL = Object.freeze({reachable: false, streams: null, error: ''});
const NO_STREAM_INFO = Object.freeze({consumers: Object.freeze([])});

let go2rtcApiDown = false;
let go2rtcUnusableReplyLogged = false;
let isPollingViewers = false;

const isGo2rtcConnected = () => !go2rtcApiDown;

/**
 * Classifies how the bridge should handle a newly connected go2rtc viewer and returns
 * both the boolean wake decision ('asked') and human-readable log description ('actionDesc').
 *
 * @param {Record<string, *>} params - Viewer connection context.
 * @returns {{ asked: boolean, actionDesc: string }}
 */
function classifyViewerAction(params) {
  const {
    rtspDirect,
    camActive,
    alreadyViewing,
    isDashboardGrid,
    blockedByOffline,
    offlineReason,
    blockedByBackfill,
    blockedByP2pMotion,
    activeMotionCamName,
    blockedByEco,
    batteryPct,
    inCooldown,
  } = params;

  if (rtspDirect) {
    return Object.freeze({
      asked: !camActive,
      actionDesc: camActive ? DIRECT_RTSP_VIEWER_ACTIONS.ACTIVE : DIRECT_RTSP_VIEWER_ACTIONS.IDLE,
    });
  }

  const asked =
    !isDashboardGrid &&
    !blockedByOffline &&
    !blockedByBackfill &&
    (!camActive || alreadyViewing) &&
    !blockedByP2pMotion &&
    !blockedByEco &&
    (alreadyViewing || !inCooldown);

  if (asked) {
    return Object.freeze({
      asked: true,
      actionDesc: camActive ? 'extending active live view' : 'waking the camera',
    });
  }
  if (isDashboardGrid) {
    return Object.freeze({asked: false, actionDesc: 'ignored, multi-camera dashboard grid view'});
  }
  if (blockedByOffline) {
    return Object.freeze({
      asked: false,
      actionDesc: 'ignored, camera is offline (' + (offlineReason || 'offline') + ')',
    });
  }
  if (camActive) {
    return Object.freeze({asked: false, actionDesc: VIEWER_ACTION_JOINED_WHILE_LIVE});
  }
  if (blockedByBackfill) {
    return Object.freeze({asked: false, actionDesc: 'ignored, waiting for HomeBase clip backfill'});
  }
  if (blockedByP2pMotion) {
    return Object.freeze({
      asked: false,
      actionDesc: 'ignored, ' + activeMotionCamName + ' is active with P2P motion/event',
    });
  }
  if (blockedByEco) {
    return Object.freeze({
      asked: false,
      actionDesc: 'ignored, camera is in low-battery economy mode (' + batteryPct + '%)',
    });
  }
  return Object.freeze({asked: false, actionDesc: VIEWER_ACTION_IN_COOLDOWN});
}

/**
 * Fetches the go2rtc stream table (stream name -> info with `consumers`) for all streams in one request. Never
 * throws: HTTP failures and network errors are reported through `error` with `reachable: false`, and an unreadable
 * body through `error` with `reachable: true`.
 *
 * @returns {Promise<{ reachable: boolean, streams: Record<string, *>|null, error: string }>}
 */
async function fetchGo2rtcStreams() {
  let response;
  try {
    response = await fetch(cfg.go2rtc_url + '/api/streams', {
      signal: AbortSignal.timeout(FRIGATE_FAST_QUERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      const snippet = await readHttpErrorSnippet(response);
      return {reachable: false, streams: null, error: 'HTTP ' + response.status + (snippet ? ': ' + snippet : '')};
    }
  } catch (err) {
    return {reachable: false, streams: null, error: formatErrorMessage(err)};
  }
  try {
    const streams = await response.json();
    const isStreamTable = Boolean(streams) && typeof streams === 'object' && !Array.isArray(streams);
    return {
      reachable: true,
      streams: isStreamTable ? streams : null,
      error: isStreamTable ? '' : 'unexpected response',
    };
  } catch (err) {
    return {reachable: true, streams: null, error: formatErrorMessage(err)};
  }
}

/**
 * Applies one camera's go2rtc consumers: refreshes encoder consumer observation, registers new viewers (appending
 * them to `newConnections`), and prunes viewers that disconnected.
 *
 * @param {Camera} cam - Camera whose stream was polled.
 * @param {Record<string, *>} streamInfo - go2rtc stream info containing `consumers`.
 * @param {Array<{ cam: Camera, id: string, clientInfo: string, now: number }>} newConnections - New viewer sink.
 */
function applyStreamConsumers(cam, streamInfo, newConnections) {
  const consumers = streamInfo.consumers || [];
  const pollTimestamp = Date.now();
  if (cam.notifyEncoderConsumersObserved(consumers.length, OFFLINE_SNAPSHOT_SEED_MS, pollTimestamp)) {
    pushFrameToEncoder(cam, pollTimestamp);
  }
  const activeViewers = consumers.filter((c) => !INTERNAL_RECORDER_USER_AGENT_REGEX.test(c.user_agent || ''));
  const activeConsumerIds = new Set();

  for (let i = 0; i < activeViewers.length; i++) {
    const consumer = activeViewers[i];
    activeConsumerIds.add(consumer.id);
    if (cam.hasRegisteredViewer(consumer.id)) {
      continue;
    }

    const clientInfo = (consumer.format_name || consumer.protocol || '') + ' ' + (consumer.remote_addr || '');
    cam.registerNewViewer(consumer.id, pollTimestamp);
    newConnections.push({cam, id: consumer.id, clientInfo: clientInfo.trim(), now: pollTimestamp});
  }

  for (const {id, wasActiveViewer} of cam.pruneDisconnectedViewers(activeConsumerIds, activeViewers.length)) {
    log.debug(
      cam,
      'viewer disconnected (id=' +
        id +
        ', wasWakingViewer=' +
        wasActiveViewer +
        ', remainingViewers=' +
        activeViewers.length +
        ')'
    );
  }
}

/**
 * Updates go2rtc service health flags and edge-triggered outage/recovery logs after one bulk stream poll.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {{ reachable: boolean, streams: Record<string, *>|null, error: string }} poll - Poll result.
 * @param {string} lastPollError - Latest HTTP or stream-processing error string.
 */
function updateGo2rtcHealthFromPoll(cams, poll, lastPollError) {
  // A reachable go2rtc with an unusable reply must not look like "nobody is watching": warn once per episode.
  const unusableReply = poll.reachable ? lastPollError : '';
  if (unusableReply && !go2rtcUnusableReplyLogged) {
    log.warn('bridge', 'go2rtc API returned an unusable stream list (' + cfg.go2rtc_url + ', ' + unusableReply + ')');
  }
  go2rtcUnusableReplyLogged = Boolean(unusableReply);

  if (cams.length > 0 && !poll.reachable) {
    const wasGo2rtcApiDown = go2rtcApiDown;
    go2rtcApiDown = true;
    syncServiceHealthFlags(cams, {go2rtcConnected: false});
    const reasonSuffix = lastPollError ? ', ' + lastPollError : '';
    if (!wasGo2rtcApiDown) {
      log.warn(
        'bridge',
        'go2rtc API unreachable (' + cfg.go2rtc_url + reasonSuffix + '), keeping encoders running and retrying'
      );
    } else {
      log.debug('bridge', 'go2rtc API still unreachable (' + cfg.go2rtc_url + reasonSuffix + ')');
    }
    return;
  }

  if (poll.reachable) {
    const wasGo2rtcApiDown = go2rtcApiDown;
    go2rtcApiDown = false;
    syncServiceHealthFlags(cams, {go2rtcConnected: true});
    if (wasGo2rtcApiDown) {
      log.info('bridge', 'go2rtc API recovered after restart/outage');
      seedOfflineCameraSnapshots(cams);
    }
  }
}

/**
 * Classifies newly observed go2rtc viewer connections, sets their waking status, logs the decision,
 * and returns the newest waking P2P camera (if any) for same-station viewer switching.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {Array<{ cam: Camera, id: string, clientInfo: string, now: number }>} newConnections - Newly joined viewers.
 * @param {boolean} isDashboardGrid - True when viewers opened across multiple cameras simultaneously.
 * @returns {Camera|null}
 */
function evaluateNewViewerConnections(cams, newConnections, isDashboardGrid) {
  const findStationMotionCam = (/** @type {Camera} */ cam) =>
    cams.find((c) => c.isHoldingStationP2pForMotion(cam.getStationKey()));
  /** @type {Camera|null} */
  let newestViewerCam = null;

  for (const conn of newConnections) {
    const {cam, id, clientInfo, now} = conn;
    const blockedByOffline = cam.isDeviceOffline();
    const blockedByBackfill = cam.isViewerBlockedByBackfill();
    const blockedByEco = !cam.canWakeOnViewerInLowBattery();
    const activeP2pMotionCam = findStationMotionCam(cam);
    const blockedByP2pMotion = !cam.isRtspCapable() && Boolean(activeP2pMotionCam);
    const alreadyViewing = cam.isActivelyViewing(now);
    const inCooldown = cam.isInViewerCooldown(now);

    const {asked, actionDesc} = classifyViewerAction({
      rtspDirect: cam.isRtspDirect(),
      camActive: cam.isActivelyStreamingForViewer(),
      alreadyViewing,
      isDashboardGrid,
      blockedByOffline,
      offlineReason: cam.getOfflineReason(),
      blockedByBackfill,
      blockedByP2pMotion,
      activeMotionCamName: activeP2pMotionCam ? activeP2pMotionCam.getName() : '',
      blockedByEco,
      batteryPct: cam.getBatteryPct(),
      inCooldown,
    });

    cam.setViewerWakingStatus(id, asked);
    if (asked) {
      cam.cancelStartupProbe();
      if (!cam.isRtspCapable()) {
        newestViewerCam = cam;
      }
    }

    const isMinorViewerNotice =
      !asked && (actionDesc === VIEWER_ACTION_JOINED_WHILE_LIVE || actionDesc === VIEWER_ACTION_IN_COOLDOWN);
    (isMinorViewerNotice ? log.debug : log.info)(cam, 'viewer connected (' + clientInfo + ') - ' + actionDesc);
  }

  return newestViewerCam;
}

/**
 * Pushes one immediate frame for single-camera viewer attaches while letting multi-camera
 * dashboard grid attaches drain smoothly via the paced media ticker.
 *
 * @param {Set<Camera>} distinctNewCams - Cameras that gained new viewer consumers on this poll.
 * @param {boolean} isDashboardGrid - True when viewers opened across multiple cameras simultaneously.
 */
function flushNewViewerKeyframes(distinctNewCams, isDashboardGrid) {
  if (distinctNewCams.size === 0 || isDashboardGrid) {
    return;
  }
  const now = Date.now();
  for (const cam of distinctNewCams) {
    pushFrameToEncoder(cam, now);
  }
}

/**
 * Polls go2rtc once every 750ms (bulk `/api/streams`) for the active stream consumers of every camera.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {Record<string, Function>} hooks - Orchestrator/telemetry callbacks.
 */
async function pollViewers(cams, hooks) {
  const {isShuttingDown, fetchAllCameraTelemetry, stopCam, triggerCam} = hooks;
  if (isPollingViewers || isShuttingDown()) {
    return;
  }
  isPollingViewers = true;
  try {
    const newConnections = [];

    // One bulk request per tick; a stream go2rtc does not list yet simply has no consumers.
    const poll = cams.length > 0 ? await fetchGo2rtcStreams() : NO_GO2RTC_POLL;
    let lastPollError = poll.error;
    if (poll.streams) {
      for (const cam of cams) {
        try {
          const hasStream = Object.hasOwn(poll.streams, cam.getName());
          applyStreamConsumers(cam, hasStream ? poll.streams[cam.getName()] : NO_STREAM_INFO, newConnections);
        } catch (err) {
          lastPollError = formatErrorMessage(err);
        }
      }
    }
    updateGo2rtcHealthFromPoll(cams, poll, lastPollError);

    const activeViewerCams = cams.filter((c) => c.hasConnectedViewers());
    const distinctNewCams = new Set(newConnections.map((x) => x.cam));
    const isDashboardGrid = distinctNewCams.size > 1 && activeViewerCams.length > 1;
    flushNewViewerKeyframes(distinctNewCams, isDashboardGrid);

    if (newConnections.length > 0 && !isDashboardGrid) {
      const pollNow = Date.now();
      const shouldRefreshOfflineViewer = (/** @type {Camera} */ cam) =>
        !cam.isRtspDirect() ? cam.shouldRefreshOfflineOnView(pollNow) : false;
      const offlineRefreshCams = [...distinctNewCams].filter(shouldRefreshOfflineViewer);
      if (offlineRefreshCams.length > 0) {
        for (const offlineCam of offlineRefreshCams) {
          log.info(
            offlineCam,
            'viewer activity detected while camera is offline (' +
              (offlineCam.getOfflineReason() || 'offline') +
              '), polling HomeBase for battery swap/recovery'
          );
        }
        void fetchAllCameraTelemetry(true);
      }
    }

    const newestViewerCam = evaluateNewViewerConnections(cams, newConnections, isDashboardGrid);
    if (newestViewerCam) {
      const switchNow = Date.now();
      const targetCamName = newestViewerCam.getName();
      for (const other of cams) {
        if (other.shouldYieldToNewStationViewer(newestViewerCam, switchNow)) {
          other.clearViewerQueue('viewer switched to ' + targetCamName);
          if (other.isSessionActive()) {
            stopCam(other, 'preempted by live view opened on ' + targetCamName, {
              preemptedByViewer: true,
              initiator: 'viewer-preempt',
            });
          }
        }
      }
    }
    for (const cam of cams) {
      if (!cam.promoteStartupProbeToViewerWake()) {
        continue;
      }
      if (cam.promotePassiveRtspDirectProbeToViewer(Date.now())) {
        continue;
      }
      if (!cam.isRtspDirect() || !cam.isSessionActive()) {
        triggerCam(cam, {
          reason: 'live view opened',
          ms: cam.getViewLingerMs(),
          kind: WAKE_KINDS.VIEW,
          initiator: 'viewer',
        });
      }
    }
  } finally {
    isPollingViewers = false;
  }
}

module.exports = {isGo2rtcConnected, classifyViewerAction, pollViewers};
