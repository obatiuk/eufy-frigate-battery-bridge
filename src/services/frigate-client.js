// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Frigate & go2rtc HTTP client: external event creation, instant clean
 * snapshot fallback, auto-synced motion/object masks, active object checks,
 * and go2rtc consumer polling.
 */
'use strict';

const {
  cfg,
  LABELS,
  SNAP_DELAY_MS,
  INSTANT_EVENT_SNAPSHOT,
  KEYFRAME_BURST_MS,
  LIVE_FPS,
  STREAM_MODES,
  sleep,
} = require('../config');
const {log} = require('../logger');
const {WAKE_KINDS} = require('../domain/camera');
const {renderCameraCards} = require('../overlay/card-renderer');
const {
  OFFLINE_SNAPSHOT_SEED_MS,
  pushFrameToEncoder,
  seedOfflineCameraSnapshots,
} = require('../media/encoder');
const {notifyHA} = require('./ha-notifier');

const FAST_LIVE_SNAP_DELAY_MS = 1000;
const BACKFILL_SNAP_DELAY_MS = 800;
const FRIGATE_CONFIG_PUT_TIMEOUT_MS = 8000;
const FRIGATE_API_TIMEOUT_MS = 5000;
const FRIGATE_FAST_QUERY_TIMEOUT_MS = 2500;
const ENCODER_RECONNECT_MASK_SYNC_DELAY_MS = 6000;
const FRIGATE_RECOVERY_MASK_SYNC_DELAY_MS = 3000;
const MASK_SYNC_INTERVAL_MS = 60000;
const EVENT_DISPATCH_DELAY_MS = 600;
const FRESH_LIVE_FRAME_MS = 1500;
const RECENT_VIDEO_FALLBACK_MS = 5000;
const SNAPSHOT_POLL_INTERVAL_MS = 200;
const SNAPSHOT_EXTRA_WAIT_MS = 15000;
const MIN_SNAPSHOT_WAIT_LOOPS = 125;
/** @typedef {import("../domain/camera").Camera} Camera */

const CLEAN_SNAPSHOT_INJECT_DELAY_MS = 450;
const REVIEW_LOOKUP_DELAY_MS = 1500;
const ERROR_SNIPPET_MAX_CHARS = 200;
const REVIEW_QUERY_LIMIT = 5;
const ACTIVE_EVENTS_QUERY_LIMIT = 10;
const INTERNAL_RECORDER_USER_AGENT_REGEX = /FFmpeg Frigate|^go2rtc/i;

let isSyncingMasks = false;
let frigateApiDown = false;
let lastMaskCheckAt = Date.now();
let isPollingViewers = false;

/**
 * Updates upstream service connectivity flags on all cameras and re-renders sleeping cards when changed.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {{ wsConnected?: boolean, frigateConnected?: boolean, go2rtcConnected?: boolean }} flags - Service health flags.
 */
function syncServiceHealthFlags(cams, flags) {
  for (const cam of cams) {
    if (cam.updateServiceHealth(flags)) {
      renderCameraCards(cam);
      pushFrameToEncoder(cam);
    }
  }
}

/**
 * Builds the Frigate PUT /api/config/set JSON body for updating a camera's eufy_bridge_card mask.
 *
 * @param {string} cameraName - Camera name in Frigate config.
 * @param {'motion'|'objects'} section - Frigate config section ('motion' or 'objects').
 * @param {boolean} enabled - Whether the mask is enabled.
 * @param {string} coordinates - Normalized polygon string.
 * @returns {Record<string, *>}
 */
function buildFrigateMaskPayload(cameraName, section, enabled, coordinates) {
  return Object.freeze({
    requires_restart: 0,
    update_topic: 'config/cameras/' + cameraName + '/' + section,
    config_data: {
      cameras: {
        [cameraName]: {
          [section]: {
            mask: {
              eufy_bridge_card: {
                friendly_name: 'Eufy Bridge Status Card',
                enabled,
                coordinates,
              },
            },
          },
        },
      },
    },
  });
}

/**
 * Checks whether an existing Frigate named mask entry matches the expected polygon and is enabled.
 *
 * @param {Record<string, *>|null|undefined} maskEntry - Frigate eufy_bridge_card object.
 * @param {string} expectedPoly - Expected normalized polygon string.
 * @returns {boolean}
 */
function isFrigateMaskIntact(maskEntry, expectedPoly) {
  return Boolean(maskEntry && typeof maskEntry === 'object' && maskEntry.enabled !== false)
      ? maskEntry.coordinates === expectedPoly ||
          (Array.isArray(maskEntry.coordinates) &&
            maskEntry.coordinates.length === 1 &&
            maskEntry.coordinates[0] === expectedPoly)
      : false;
}

/**
 * Resolves the Frigate event label ('person', 'car', 'dog', 'test', or 'motion') from a Eufy event string.
 *
 * @param {string} ev - Eufy event description.
 * @param {Array<[string, string]>} [labelMap=LABELS] - Keyword to label mapping pairs.
 * @returns {string}
 */
function resolveFrigateEventLabel(ev, labelMap = LABELS) {
  const text = String(ev || '');
  const matched = labelMap.find(([keyword]) => text.includes(keyword));
  if (matched) {
    return matched[1];
  }
  if (text.startsWith('test')) {
    return 'test';
  }
  return 'motion';
}

/**
 * Computes the required continuous video duration (in ms) before filing a Frigate event.
 *
 * @param {string} activeMode - Camera activeMode ('rtsp', 'download', 'p2p', '').
 * @param {boolean} [instantSnapshot=INSTANT_EVENT_SNAPSHOT] - Whether fast RTSP snapshot mode is enabled.
 * @param {number} [snapDelayMs=SNAP_DELAY_MS] - Configured snapshot delay in ms.
 * @returns {number}
 */
function computeRequiredSnapshotDelay(
    activeMode,
    instantSnapshot = INSTANT_EVENT_SNAPSHOT,
    snapDelayMs = SNAP_DELAY_MS
) {
  if (activeMode === STREAM_MODES.DOWNLOAD) {
    return BACKFILL_SNAP_DELAY_MS;
  }
  return instantSnapshot ? Math.min(snapDelayMs, FAST_LIVE_SNAP_DELAY_MS) : snapDelayMs;
}

/**
 * Synchronizes a single mask section ('motion' or 'objects') for a camera in Frigate via
 * PUT /api/config/set (requires_restart: 0).
 *
 * @param {Camera} cam - Camera state object.
 * @param {Camera} camCfg - Camera configuration object from Frigate /api/config.
 * @param {'motion'|'objects'} section - Frigate mask section ('motion' or 'objects').
 * @param {string} poly - Normalized polygon string, or '' to disable.
 * @param {string} [frigateUrl=cfg.frigate_url] - Frigate base URL.
 * @returns {Promise<'verified'|'applied'|'disabled'|'none'|'failed'>}
 */
async function syncSingleFrigateMaskSection(cam, camCfg, section, poly, frigateUrl = cfg.frigate_url) {
  const camName = cam.getName();
  const sectionObj = camCfg && camCfg[section] ? camCfg[section] : null;
  const existingMasks = sectionObj ? sectionObj.mask : undefined;
  const isNamedDict =
      existingMasks !== null && typeof existingMasks === 'object' && !Array.isArray(existingMasks);

  if (!poly) {
    if (isNamedDict && existingMasks.eufy_bridge_card && existingMasks.eufy_bridge_card.enabled) {
      try {
        const disablePayload = buildFrigateMaskPayload(
            camName,
            section,
            false,
            existingMasks.eufy_bridge_card.coordinates
        );
        const res = await fetch(frigateUrl + '/api/config/set', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
          body: JSON.stringify(disablePayload),
        });
        return res.ok ? 'disabled' : 'failed';
      } catch (err) {
        log.warn(cam, 'failed to disable Frigate ' + section + '.mask: ' + err.message);
        return 'failed';
      }
    }
    return 'none';
  }

  if (isNamedDict && isFrigateMaskIntact(existingMasks.eufy_bridge_card, poly)) {
    return 'verified';
  }
  if (cam.isMaskSectionAlreadySynced(section, poly)) {
    return 'verified';
  }

  try {
    const enablePayload = buildFrigateMaskPayload(camName, section, true, poly);
    const putRes = await fetch(frigateUrl + '/api/config/set', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
      body: JSON.stringify(enablePayload),
    });

    if (putRes.ok) {
      return 'applied';
    }

    const legacyUrl =
        frigateUrl +
        '/api/config/set?cameras.' +
        encodeURIComponent(camName) +
        '.' +
        section +
        '.mask=' +
        encodeURIComponent(poly);
    const legRes = await fetch(legacyUrl, {
      method: 'PUT',
      signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
    });
    if (legRes.ok) {
      return 'applied';
    }

    const errText = (await putRes.text()).slice(0, ERROR_SNIPPET_MAX_CHARS);
    log.warn(
        cam,
        'could not auto-apply Frigate ' +
        section +
        '.mask (HTTP ' +
        putRes.status +
        '): ' +
        errText +
        ' (calculated mask=' +
        poly +
        ')'
    );
    return 'failed';
  } catch (err) {
    log.warn(cam, 'error syncing Frigate ' + section + '.mask (' + poly + '): ' + err.message);
    return 'failed';
  }
}

/**
 * Automatically synchronizes each camera's calculated corner status card motion.mask and
 * objects.mask into Frigate via Frigate's HTTP API (GET /api/config + PUT /api/config/set).
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {boolean} [forceResync=false] - Whether to clear cached polygons and re-verify all cameras.
 * @param {boolean} [shuttingDown=false] - Whether the bridge is shutting down.
 * @param {string} [frigateUrl=cfg.frigate_url] - Frigate base URL.
 */
async function syncFrigateMotionMasks(
    cams,
    forceResync = false,
    shuttingDown = false,
    frigateUrl = cfg.frigate_url
) {
  if (isSyncingMasks || shuttingDown || !frigateUrl || !cams.some((c) => c.hasAutoFrigateMask())) {
    return;
  }
  isSyncingMasks = true;
  lastMaskCheckAt = Date.now();
  try {
    const wasFrigateApiDown = frigateApiDown;
    const hadPriorMaskSync = cams.some((c) => Boolean(c.card.lastSyncedMaskPoly));
    let anyMaskReapplied = false;
    if (forceResync) {
      for (const c of cams) {
        c.resetMaskSync();
      }
    }
    let frigateCfg = null;
    try {
      const r = await fetch(frigateUrl + '/api/config', {signal: AbortSignal.timeout(FRIGATE_API_TIMEOUT_MS)});
      if (!r.ok) {
        frigateApiDown = true;
        syncServiceHealthFlags(cams, {frigateConnected: false});
        return;
      }
      frigateCfg = await r.json();
    } catch (err) {
      frigateApiDown = true;
      syncServiceHealthFlags(cams, {frigateConnected: false});
      log.debug('bridge', 'could not fetch Frigate /api/config for auto_frigate_mask: ' + err.message);
      return;
    }

    frigateApiDown = false;
    syncServiceHealthFlags(cams, {frigateConnected: true});
    lastMaskCheckAt = Date.now();
    for (const cam of cams) {
      if (!cam.hasAutoFrigateMask()) {
        continue;
      }
      const poly = cam.computeMaskPolygon();
      const camCfg = frigateCfg && frigateCfg.cameras ? frigateCfg.cameras[cam.getName()] : null;
      if (!camCfg) {
        continue;
      }

      const motMask = camCfg.motion && camCfg.motion.mask ? camCfg.motion.mask.eufy_bridge_card : null;
      const objMask = camCfg.objects && camCfg.objects.mask ? camCfg.objects.mask.eufy_bridge_card : null;
      const masksIntact =
          isFrigateMaskIntact(motMask, poly) &&
          (isFrigateMaskIntact(objMask, poly) || cam.isMaskSectionAlreadySynced('objects', poly));

      if (cam.isMaskSynced(poly, masksIntact)) {
        continue;
      }

      const motionStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'motion', poly, frigateUrl);
      const objectStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'objects', poly, frigateUrl);

      if (!poly) {
        if (motionStatus === 'disabled' || objectStatus === 'disabled') {
          log.info(
              cam,
              'disabled Frigate motion & object masks eufy_bridge_card (card is ' +
              cam.formatCardPlacementSummary('/') +
              ')'
          );
        }
        continue;
      }

      if (motionStatus !== 'failed' && objectStatus !== 'failed') {
        cam.markMaskSynced(poly);
        const wasApplied = motionStatus === 'applied' || objectStatus === 'applied';
        if (wasApplied) {
          anyMaskReapplied = true;
        }
        const actionVerb = wasApplied ? 'auto-applied' : 'verified';
        log.info(
            cam,
            actionVerb +
            ' Frigate motion & object masks eufy_bridge_card (' +
            cam.formatCardPlacementSummary('@') +
            ' -> ' +
            poly +
            ')'
        );
      }
    }
    if (wasFrigateApiDown || (hadPriorMaskSync && anyMaskReapplied)) {
      seedOfflineCameraSnapshots(cams);
    }
  } finally {
    isSyncingMasks = false;
  }
}

/**
 * Marks Frigate's API as down and schedules a mask re-verification after recovery.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {() => boolean} isShuttingDownFn - Callback returning shutdown state.
 */
function handleEncoderReconnectMaskSync(cams, isShuttingDownFn) {
  frigateApiDown = true;
  syncServiceHealthFlags(cams, {frigateConnected: false});
  const timer = setTimeout(() => {
    if (!isShuttingDownFn()) {
      void syncFrigateMotionMasks(cams, true, isShuttingDownFn());
    }
  }, ENCODER_RECONNECT_MASK_SYNC_DELAY_MS);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

/**
 * Runs the periodic 60s mask drift check if due.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {number} now - Current epoch timestamp.
 * @param {boolean} shuttingDown - Whether the bridge is shutting down.
 */
function checkPeriodicMaskSync(cams, now, shuttingDown) {
  if (now - lastMaskCheckAt >= MASK_SYNC_INTERVAL_MS) {
    lastMaskCheckAt = now;
    void syncFrigateMotionMasks(cams, false, shuttingDown);
  }
}

/**
 * Queries Frigate's /api/review endpoint to find the review item ID containing a given detection eventId.
 *
 * @param {string} cameraName - Camera name.
 * @param {string} eventId - Frigate detection event ID.
 * @returns {Promise<string>} Review ID or empty string if not found.
 */
async function lookupFrigateReviewId(cameraName, eventId) {
  try {
    const reviewUrl = cfg.frigate_url + '/api/review?cameras=' + cameraName + '&limit=' + REVIEW_QUERY_LIMIT;
    const rvRes = await fetch(reviewUrl, {signal: AbortSignal.timeout(FRIGATE_API_TIMEOUT_MS)});
    const rv = rvRes.ok ? await rvRes.json() : null;
    if (!Array.isArray(rv)) {
      return '';
    }
    const found = rv.find(
        (item) => item.data && Array.isArray(item.data.detections) && item.data.detections.includes(eventId)
    );
    return found && found.id ? found.id : '';
  } catch (err) {
    return '';
  }
}

/**
 * Files an external detection event in Frigate via its HTTP API and notifies Home Assistant.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} ev - Eufy event name that triggered the detection.
 * @param {string} [personName=''] - Optional recognized face name from HomeBase 3.
 */
function frigateEvent(cam, ev, personName = '') {
  if (!cfg.frigate_url) {
    return;
  }
  const label = resolveFrigateEventLabel(ev);

  const evState = cam.tryUpgradeOrQueueFrigateEvent(label, personName, Date.now());
  const evScope = cam.getEventLogScope();
  switch (evState.status) {
    case 'upgraded':
      if (evState.upgradedLabel) {
        log.debug(evScope, 'upgraded pending Frigate event label ("motion" -> "' + label + '")');
      }
      if (evState.attachedPerson) {
        log.debug(evScope, 'attached recognized person "' + personName + '" to pending Frigate event');
      }
      return;
    case 'cooldown':
      return;
    default:
      break;
  }
  const timer = setTimeout(async () => {
    cam.beginFrigateSnapshotWait();
    notifyHA(cam, {});

    const requiredDelayMs = computeRequiredSnapshotDelay(cam.getActiveMode());
    const needsWait = () =>
        cam.shouldWaitForEventSnapshot(
            Date.now(),
            requiredDelayMs,
            FRESH_LIVE_FRAME_MS,
            RECENT_VIDEO_FALLBACK_MS
        );

    const maxWaitLoops = Math.max(
        MIN_SNAPSHOT_WAIT_LOOPS,
        Math.ceil((SNAP_DELAY_MS + SNAPSHOT_EXTRA_WAIT_MS) / SNAPSHOT_POLL_INTERVAL_MS)
    );
    for (let i = 0; i < maxWaitLoops && cam.isSessionActive() && needsWait(); i++) {
      await sleep(SNAPSHOT_POLL_INTERVAL_MS);
    }

    const noVideo = needsWait();
    let injectedCleanSnapshot = false;
    if (cam.canInjectCleanEventSnapshot(noVideo)) {
      cam.enableCleanSnapshotCardSuppression(Date.now(), KEYFRAME_BURST_MS);
      injectedCleanSnapshot = true;
      pushFrameToEncoder(cam, Date.now());
      await sleep(CLEAN_SNAPSHOT_INJECT_DELAY_MS);
    }
    const {finalLabel, finalPerson, subLabel, durationSecs} = cam.completeFrigateEventFiling(
        Date.now(),
        LIVE_FPS
    );
    const camName = cam.getName();

    try {
      const createUrl = cfg.frigate_url + '/api/events/' + camName + '/' + finalLabel + '/create';
      const createBody = {
        source_type: 'api',
        duration: durationSecs,
        include_recording: true,
        ...(subLabel ? {sub_label: subLabel} : {}),
      };
      const r = await fetch(createUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(FRIGATE_API_TIMEOUT_MS),
        body: JSON.stringify(createBody),
      });
      if (!r.ok) {
        const errBody = (await r.text()).slice(0, ERROR_SNIPPET_MAX_CHARS);
        log.error(cam, 'Frigate event "' + finalLabel + '" failed (HTTP ' + r.status + ' ' + errBody + ')');
        return;
      }
      const resJson = await r.json();
      const eventId = resJson.event_id;
      cam.recordCreatedFrigateEvent(eventId, Date.now());
      const personSuffix = finalPerson ? ' [person: ' + finalPerson + ']' : '';
      if (noVideo) {
        log.warn(
            cam,
            'Frigate event "' +
            finalLabel +
            '" created' +
            personSuffix +
            ' (camera sent no live video, snapshot is a placeholder)'
        );
      } else {
        log.info(cam, 'Frigate event "' + finalLabel + '" created' + personSuffix + ' (eventId=' + eventId + ')');
      }

      await sleep(REVIEW_LOOKUP_DELAY_MS);
      const reviewId = await lookupFrigateReviewId(camName, eventId);
      notifyHA(cam, {event_id: eventId, review_id: reviewId, no_video: noVideo});
    } catch (err) {
      log.error(cam, 'Frigate event failed: ' + err.message);
    } finally {
      if (injectedCleanSnapshot) {
        cam.disableCleanSnapshotCardSuppression();
        pushFrameToEncoder(cam, Date.now());
      }
    }
  }, EVENT_DISPATCH_DELAY_MS);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  cam.setFrigateEventTimer(timer);
}

/**
 * Checks whether Frigate currently has any active or recently-active non-synthetic object
 * detections for a camera, used to decide whether to extend the hold window or allow early sleep.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} [clockNow] - Optional synthetic timestamp in milliseconds; uses Date.now() when omitted.
 * @returns {Promise<boolean>} True if Frigate has no active or recent tracked object detections on this camera.
 */
async function isFrigateCameraIdle(cam, clockNow) {
  if (!cfg.frigate_url) {
    return true;
  }
  try {
    const url =
        cfg.frigate_url +
        '/api/events?cameras=' +
        cam.getName() +
        '&limit=' +
        ACTIVE_EVENTS_QUERY_LIMIT;
    const r = await fetch(url, {signal: AbortSignal.timeout(FRIGATE_FAST_QUERY_TIMEOUT_MS)});
    if (!r.ok) {
      return false;
    }
    const events = await r.json();
    if (!Array.isArray(events)) {
      return false;
    }
    const evalNow = clockNow === undefined ? Date.now() : clockNow;
    return !cam.evaluateFrigateEventsActivity(events, evalNow);
  } catch (err) {
    return false;
  }
}

/**
 * Classifies how the bridge should handle a newly connected go2rtc viewer and returns
 * both the boolean wake decision ('asked') and human-readable log description ('actionDesc').
 *
 * @param {Record<string, *>} params - Viewer connection context.
 * @returns {{ asked: boolean, actionDesc: string }}
 */
function classifyViewerAction(params) {
  const {
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
    return Object.freeze({asked: false, actionDesc: 'joined while live, does not extend it'});
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
  return Object.freeze({asked: false, actionDesc: 'ignored, camera just went to sleep (cooldown)'});
}

/**
 * Polls go2rtc for active stream consumers on each camera every 750ms.
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
    const findStationMotionCam = (cam) =>
        cams.find((c) => c.isHoldingStationP2pForMotion(cam.getStationKey()));
    const newConnections = [];

    let anyPollOk = false;
    let allPollsFailed = true;
    for (const cam of cams) {
      try {
        const r = await fetch(cfg.go2rtc_url + '/api/streams?src=' + cam.getName(), {
          signal: AbortSignal.timeout(FRIGATE_FAST_QUERY_TIMEOUT_MS),
        });
        if (!r.ok) {
          continue;
        }
        allPollsFailed = false;
        anyPollOk = true;
        const d = await r.json();
        const consumers = d.consumers || [];
        const now = Date.now();
        if (cam.notifyEncoderConsumersObserved(consumers.length, OFFLINE_SNAPSHOT_SEED_MS, now)) {
          pushFrameToEncoder(cam, now);
        }
        const viewers = consumers.filter(
            (c) => !INTERNAL_RECORDER_USER_AGENT_REGEX.test(c.user_agent || '')
        );
        const seen = new Set();

        for (const v of viewers) {
          seen.add(v.id);
          if (cam.hasRegisteredViewer(v.id)) {
            continue;
          }

          const clientInfo = (v.format_name || v.protocol || '') + ' ' + (v.remote_addr || '');
          cam.registerNewViewer(v.id, now);
          pushFrameToEncoder(cam, now);
          newConnections.push({cam, id: v.id, clientInfo: clientInfo.trim(), now});
        }

        for (const {id, wasActiveViewer} of cam.pruneDisconnectedViewers(seen, viewers.length)) {
          log.debug(
              cam,
              'viewer disconnected (id=' +
              id +
              ', wasWakingViewer=' +
              wasActiveViewer +
              ', remainingViewers=' +
              viewers.length +
              ')'
          );
        }
      } catch (err) {
        // Ignore transient errors while go2rtc/Frigate is restarting.
      }
    }
    if (allPollsFailed) {
      frigateApiDown = true;
      syncServiceHealthFlags(cams, {go2rtcConnected: false});
    } else if (anyPollOk) {
      syncServiceHealthFlags(cams, {go2rtcConnected: true});
      if (frigateApiDown) {
        frigateApiDown = false;
        syncServiceHealthFlags(cams, {frigateConnected: true});
        log.info('bridge', 'Frigate API recovered after restart/outage, re-verifying motion & object masks');
        seedOfflineCameraSnapshots(cams);
        setTimeout(() => {
          if (!isShuttingDown()) {
            void syncFrigateMotionMasks(cams, true, isShuttingDown());
          }
        }, FRIGATE_RECOVERY_MASK_SYNC_DELAY_MS);
      }
    }

    const activeViewerCams = cams.filter((c) => c.hasConnectedViewers());
    const distinctNewCams = new Set(newConnections.map((x) => x.cam));
    const isDashboardGrid = distinctNewCams.size > 1 && activeViewerCams.length > 1;
    let newestViewerCam = null;

    if (newConnections.length > 0) {
      const pollNow = Date.now();
      const offlineRefreshCams = cams.filter((c) => c.shouldRefreshOfflineOnView(pollNow));
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
        camActive: cam.isSessionActive(),
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
        newestViewerCam = cam;
      }

      log.info(cam, 'viewer connected (' + clientInfo + ') - ' + actionDesc);
    }

    if (newestViewerCam) {
      newestViewerCam.cancelStartupProbe();
      const switchNow = Date.now();
      const targetCamName = newestViewerCam.getName();
      for (const other of cams) {
        if (other.shouldYieldToNewStationViewer(newestViewerCam, switchNow)) {
          other.clearViewerQueue('viewer switched to ' + targetCamName);
          if (other.isSessionActive()) {
            stopCam(
                other,
                'preempted by live view opened on ' + targetCamName,
                true,
                'viewer-preempt'
            );
          }
        }
      }
    }
    for (const cam of cams) {
      if (cam.promoteStartupProbeToViewerWake()) {
        triggerCam(cam, 'live view opened', cam.getViewLingerMs(), WAKE_KINDS.VIEW, 'viewer');
      }
    }
  } finally {
    isPollingViewers = false;
  }
}

module.exports = {
  BACKFILL_SNAP_DELAY_MS,
  buildFrigateMaskPayload,
  isFrigateMaskIntact,
  resolveFrigateEventLabel,
  computeRequiredSnapshotDelay,
  classifyViewerAction,
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  checkPeriodicMaskSync,
  frigateEvent,
  isFrigateCameraIdle,
  pollViewers,
};
