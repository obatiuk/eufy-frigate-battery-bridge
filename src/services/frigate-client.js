// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
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
const {log, formatErrorMessage} = require('../logger');
const {WAKE_KINDS} = require('../domain/camera');
const {renderCameraCards} = require('../overlay/card-renderer');
const {OFFLINE_SNAPSHOT_SEED_MS, pushFrameToEncoder, seedOfflineCameraSnapshots} = require('../media/encoder');
const {notifyHA} = require('./ha-notifier');

const FAST_LIVE_SNAP_DELAY_MS = 1000;
const BACKFILL_SNAP_DELAY_MS = 800;
const FRIGATE_CONFIG_PUT_TIMEOUT_MS = 8000;
const FRIGATE_API_TIMEOUT_MS = 5000;
const FRIGATE_FAST_QUERY_TIMEOUT_MS = 2500;
const ENCODER_RECONNECT_MASK_SYNC_DELAY_MS = 6000;
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
const ERROR_SNIPPET_MAX_CHARS = 1024;
const REVIEW_QUERY_LIMIT = 5;
const ACTIVE_EVENTS_QUERY_LIMIT = 10;
const INTERNAL_RECORDER_USER_AGENT_REGEX = /FFmpeg Frigate|^go2rtc/i;
const FRIGATE_BRIDGE_MASK_KEY = 'eufy_bridge_card';
const FRIGATE_BRIDGE_MASK_FRIENDLY_NAME = 'Eufy Bridge Status Card';
const VIEWER_ACTION_JOINED_WHILE_LIVE = 'joined while live, does not extend it';
const VIEWER_ACTION_IN_COOLDOWN = 'ignored, camera just went to sleep (cooldown)';
const DIRECT_RTSP_VIEWER_ACTIONS = Object.freeze({
  ACTIVE: 'streaming direct RTSP',
  IDLE: 'connecting direct RTSP stream',
});

let isSyncingMasks = false;
let frigateApiDown = false;
let go2rtcApiDown = false;
let go2rtcUnusableReplyLogged = false;
const NO_GO2RTC_POLL = Object.freeze({reachable: false, streams: null, error: ''});
const NO_STREAM_INFO = Object.freeze({consumers: Object.freeze([])});
let lastMaskCheckAt = Date.now();
let isPollingViewers = false;

const isFrigateConnected = () => !frigateApiDown;
const isGo2rtcConnected = () => !go2rtcApiDown;

/**
 * Updates upstream service connectivity flags on all cameras and re-renders sleeping cards when changed.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {{
 *   wsConnected?: boolean,
 *   frigateConnected?: boolean,
 *   go2rtcConnected?: boolean
 * }} flags - Service health flags.
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
 * Builds the Frigate PUT /api/config/set JSON envelope for updating or deleting eufy_bridge_card.
 *
 * @param {string} cameraName - Camera name in Frigate config.
 * @param {'motion'|'objects'} section - Frigate config section ('motion' or 'objects').
 * @param {Record<string, *>|string} maskEntry - Named mask object or '' to delete the key.
 * @returns {Record<string, *>}
 */
function buildFrigateMaskEnvelope(cameraName, section, maskEntry) {
  return Object.freeze({
    requires_restart: 0,
    update_topic: 'config/cameras/' + cameraName + '/' + section,
    config_data: {
      cameras: {
        [cameraName]: {
          [section]: {
            mask: {
              [FRIGATE_BRIDGE_MASK_KEY]: maskEntry,
            },
          },
        },
      },
    },
  });
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
  return buildFrigateMaskEnvelope(cameraName, section, {
    friendly_name: FRIGATE_BRIDGE_MASK_FRIENDLY_NAME,
    enabled,
    coordinates,
  });
}

/**
 * Builds the Frigate PUT /api/config/set JSON body for deleting only the bridge-created
 * eufy_bridge_card mask entry (leaving all user-defined masks intact).
 *
 * @param {string} cameraName - Camera name in Frigate config.
 * @param {'motion'|'objects'} section - Frigate config section ('motion' or 'objects').
 * @returns {Record<string, *>}
 */
function buildFrigateMaskDeletePayload(cameraName, section) {
  return buildFrigateMaskEnvelope(cameraName, section, '');
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
  for (const [keyword, mappedLabel] of labelMap) {
    if (text === mappedLabel || text.includes(keyword)) {
      return mappedLabel;
    }
  }
  return text.startsWith('test') ? 'test' : 'motion';
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
 * Reads a bounded diagnostic body snippet from a failed HTTP Response when available.
 *
 * @param {{ status: number, text?: () => Promise<string> }} res - Fetch response object.
 * @returns {Promise<string>}
 */
async function readHttpErrorSnippet(res) {
  if (!res || typeof res.text !== 'function') {
    return '';
  }
  const raw = await res.text().catch(() => '');
  return String(raw || '')
    .trim()
    .slice(0, ERROR_SNIPPET_MAX_CHARS);
}

/**
 * Deletes the bridge-created eufy_bridge_card mask entry from a single Frigate camera section.
 *
 * @param {Camera} cam - Camera state object.
 * @param {'motion'|'objects'} section - Frigate mask section ('motion' or 'objects').
 * @param {string} [frigateUrl=cfg.frigate_url] - Frigate base URL.
 * @returns {Promise<'deleted'|'failed'>}
 */
async function deleteFrigateMaskSection(cam, section, frigateUrl = cfg.frigate_url) {
  try {
    const deletePayload = buildFrigateMaskDeletePayload(cam.getName(), section);
    const res = await fetch(frigateUrl + '/api/config/set', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
      body: JSON.stringify(deletePayload),
    });
    if (!res.ok) {
      const errText = await readHttpErrorSnippet(res);
      log.warn(cam, 'could not delete Frigate ' + section + '.mask (HTTP ' + res.status + '): ' + errText);
      return 'failed';
    }
    return 'deleted';
  } catch (err) {
    log.warn(cam, 'failed to delete Frigate ' + section + '.mask: ' + formatErrorMessage(err));
    return 'failed';
  }
}

/**
 * Synchronizes a single mask section ('motion' or 'objects') for a camera in Frigate via
 * PUT /api/config/set (requires_restart: 0).
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} camCfg - Camera configuration object from Frigate /api/config.
 * @param {'motion'|'objects'} section - Frigate mask section ('motion' or 'objects').
 * @param {string} poly - Normalized polygon string, or '' to delete the bridge-created mask.
 * @param {string} [frigateUrl=cfg.frigate_url] - Frigate base URL.
 * @returns {Promise<'verified'|'applied'|'deleted'|'none'|'failed'>}
 */
async function syncSingleFrigateMaskSection(cam, camCfg, section, poly, frigateUrl = cfg.frigate_url) {
  const camName = cam.getName();
  const sectionObj = camCfg && camCfg[section] ? camCfg[section] : null;
  const existingMasks = sectionObj ? sectionObj.mask : undefined;
  const isNamedDict = existingMasks !== null && typeof existingMasks === 'object' && !Array.isArray(existingMasks);
  const hasBridgeMask =
    isNamedDict &&
    Object.prototype.hasOwnProperty.call(existingMasks, FRIGATE_BRIDGE_MASK_KEY) &&
    Boolean(existingMasks[FRIGATE_BRIDGE_MASK_KEY]);

  if (!poly) {
    return hasBridgeMask ? deleteFrigateMaskSection(cam, section, frigateUrl) : 'none';
  }

  if (isNamedDict && isFrigateMaskIntact(existingMasks[FRIGATE_BRIDGE_MASK_KEY], poly)) {
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
    const errText = await readHttpErrorSnippet(putRes);

    const legacyUrl =
      frigateUrl +
      '/api/config/set?cameras.' +
      encodeURIComponent(camName) +
      '.' +
      section +
      '.mask=' +
      encodeURIComponent(poly);
    let legacyFailureSuffix = '';
    try {
      const legRes = await fetch(legacyUrl, {
        method: 'PUT',
        signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
      });
      if (legRes.ok) {
        return 'applied';
      }
      if (legRes.status !== putRes.status) {
        legacyFailureSuffix = '; legacy fallback HTTP ' + legRes.status;
      }
    } catch (legErr) {
      legacyFailureSuffix = '; legacy fallback failed: ' + formatErrorMessage(legErr);
    }

    log.warn(
      cam,
      'could not auto-apply Frigate ' +
        section +
        '.mask (HTTP ' +
        putRes.status +
        '): ' +
        errText +
        legacyFailureSuffix +
        ' (calculated mask=' +
        poly +
        ')'
    );
    return 'failed';
  } catch (err) {
    log.warn(cam, 'error syncing Frigate ' + section + '.mask (' + poly + '): ' + formatErrorMessage(err));
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
async function syncFrigateMotionMasks(cams, forceResync = false, shuttingDown = false, frigateUrl = cfg.frigate_url) {
  if (isSyncingMasks || shuttingDown || !frigateUrl) {
    return;
  }
  if (!cams.some((c) => c.hasAutoFrigateMask())) {
    if (frigateApiDown) {
      frigateApiDown = false;
      syncServiceHealthFlags(cams, {frigateConnected: true});
    }
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
    const markFrigateApiDown = (reason) => {
      frigateApiDown = true;
      syncServiceHealthFlags(cams, {frigateConnected: false});
      if (!wasFrigateApiDown) {
        log.warn('bridge', 'Frigate API unreachable (' + frigateUrl + ', ' + reason + '), retrying periodically');
      } else {
        log.debug('bridge', 'could not fetch Frigate /api/config for auto_frigate_mask: ' + reason);
      }
    };
    try {
      const r = await fetch(frigateUrl + '/api/config', {signal: AbortSignal.timeout(FRIGATE_API_TIMEOUT_MS)});
      if (!r.ok) {
        const snippet = await readHttpErrorSnippet(r);
        markFrigateApiDown('HTTP ' + r.status + (snippet ? ': ' + snippet : ''));
        return;
      }
      frigateCfg = await r.json();
    } catch (err) {
      markFrigateApiDown(formatErrorMessage(err));
      return;
    }

    frigateApiDown = false;
    syncServiceHealthFlags(cams, {frigateConnected: true});
    if (wasFrigateApiDown) {
      log.info('bridge', 'Frigate API recovered after restart/outage, re-verifying motion & object masks');
    }
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

      const motMask = camCfg.motion && camCfg.motion.mask ? camCfg.motion.mask[FRIGATE_BRIDGE_MASK_KEY] : null;
      const objMask = camCfg.objects && camCfg.objects.mask ? camCfg.objects.mask[FRIGATE_BRIDGE_MASK_KEY] : null;
      const masksIntact =
        isFrigateMaskIntact(motMask, poly) &&
        (isFrigateMaskIntact(objMask, poly) || cam.isMaskSectionAlreadySynced('objects', poly));

      if (cam.isMaskSynced(poly, masksIntact)) {
        continue;
      }

      const motionStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'motion', poly, frigateUrl);
      const objectStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'objects', poly, frigateUrl);

      if (!poly) {
        if (motionStatus !== 'failed' && objectStatus !== 'failed') {
          cam.resetMaskSync();
        }
        if (motionStatus === 'deleted' || objectStatus === 'deleted') {
          log.info(
            cam,
            'deleted Frigate motion & object masks ' +
              FRIGATE_BRIDGE_MASK_KEY +
              ' (card is ' +
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
        const logMaskFn = wasApplied ? log.info : log.debug;
        logMaskFn(
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
 * Polls until the camera has decoded sustained video (or the wait loop elapses while still active),
 * returning `{ aborted: true, noVideo: true }` if the pending event was aborted when the session ended without video.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} waitId - Frigate event wait token captured when queued.
 * @returns {Promise<{ aborted: boolean, noVideo: boolean }>}
 */
async function waitForFrigateEventSnapshot(cam, waitId) {
  const requiredDelayMs = computeRequiredSnapshotDelay(cam.getActiveMode());
  const needsWait = () =>
    cam.shouldWaitForEventSnapshot(Date.now(), requiredDelayMs, FRESH_LIVE_FRAME_MS, RECENT_VIDEO_FALLBACK_MS);
  const maxWaitLoops = Math.max(
    MIN_SNAPSHOT_WAIT_LOOPS,
    Math.ceil((SNAP_DELAY_MS + SNAPSHOT_EXTRA_WAIT_MS) / SNAPSHOT_POLL_INTERVAL_MS)
  );
  for (
    let i = 0;
    i < maxWaitLoops && cam.isFrigateSnapshotWaitActive(waitId) && cam.isSessionActive() && needsWait();
    i++
  ) {
    await sleep(SNAPSHOT_POLL_INTERVAL_MS);
  }
  if (!cam.isFrigateSnapshotWaitActive(waitId)) {
    return {aborted: true, noVideo: true};
  }
  return {aborted: false, noVideo: needsWait()};
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
  const waitId = cam.getFrigateEventWaitId();
  const timer = setTimeout(async () => {
    if (!cam.beginFrigateSnapshotWait(waitId)) {
      return;
    }
    void notifyHA(cam);

    const {aborted, noVideo} = await waitForFrigateEventSnapshot(cam, waitId);
    if (aborted) {
      return;
    }
    let injectedCleanSnapshot = false;

    try {
      if (cam.canInjectCleanEventSnapshot(noVideo)) {
        cam.enableCleanSnapshotCardSuppression(Date.now(), KEYFRAME_BURST_MS);
        injectedCleanSnapshot = true;
        pushFrameToEncoder(cam, Date.now());
        await sleep(CLEAN_SNAPSHOT_INJECT_DELAY_MS);
        if (!cam.isFrigateSnapshotWaitActive(waitId)) {
          return;
        }
      }
      const {finalLabel, finalPerson, subLabel, durationSecs} = cam.completeFrigateEventFiling(Date.now(), LIVE_FPS);
      const camName = cam.getName();
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
        const errBody = await readHttpErrorSnippet(r);
        log.error(
          cam,
          'Frigate event "' + finalLabel + '" failed (HTTP ' + r.status + (errBody ? ' ' + errBody : '') + ')'
        );
        return;
      }
      const resJson = await r.json();
      const eventId = resJson.event_id;
      cam.recordCreatedFrigateEvent(eventId);
      const personSuffix = finalPerson ? ' [person: ' + finalPerson + ']' : '';
      if (noVideo) {
        log.warn(
          cam,
          'Frigate event "' +
            finalLabel +
            '" created' +
            personSuffix +
            ' (eventId=' +
            eventId +
            ', using cached snapshot fallback)'
        );
      } else {
        log.info(cam, 'Frigate event "' + finalLabel + '" created' + personSuffix + ' (eventId=' + eventId + ')');
      }

      await sleep(REVIEW_LOOKUP_DELAY_MS);
      const reviewId = await lookupFrigateReviewId(camName, eventId);
      notifyHA(cam, {event_id: eventId, review_id: reviewId, no_video: noVideo});
    } catch (err) {
      log.error(cam, 'Frigate event failed: ' + formatErrorMessage(err));
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
    const url = cfg.frigate_url + '/api/events?cameras=' + cam.getName() + '&limit=' + ACTIVE_EVENTS_QUERY_LIMIT;
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
    pushFrameToEncoder(cam, pollTimestamp);
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
    const findStationMotionCam = (cam) => cams.find((c) => c.isHoldingStationP2pForMotion(cam.getStationKey()));
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
    } else if (poll.reachable) {
      const wasGo2rtcApiDown = go2rtcApiDown;
      go2rtcApiDown = false;
      syncServiceHealthFlags(cams, {go2rtcConnected: true});
      if (wasGo2rtcApiDown) {
        log.info('bridge', 'go2rtc API recovered after restart/outage');
        seedOfflineCameraSnapshots(cams);
      }
    }

    const activeViewerCams = cams.filter((c) => c.hasConnectedViewers());
    const distinctNewCams = new Set(newConnections.map((x) => x.cam));
    const isDashboardGrid = distinctNewCams.size > 1 && activeViewerCams.length > 1;
    let newestViewerCam = null;

    if (newConnections.length > 0 && !isDashboardGrid) {
      const pollNow = Date.now();
      const offlineRefreshCams = [...distinctNewCams].filter(
        (c) => !c.isRtspDirect() && c.shouldRefreshOfflineOnView(pollNow)
      );
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
        rtspDirect: cam.isRtspDirect(),
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
        cam.cancelStartupProbe();
        if (!cam.isRtspCapable()) {
          newestViewerCam = cam;
        }
      }

      const isMinorViewerNotice =
        !asked && (actionDesc === VIEWER_ACTION_JOINED_WHILE_LIVE || actionDesc === VIEWER_ACTION_IN_COOLDOWN);
      (isMinorViewerNotice ? log.debug : log.info)(cam, 'viewer connected (' + clientInfo + ') - ' + actionDesc);
    }

    if (newestViewerCam) {
      const switchNow = Date.now();
      const targetCamName = newestViewerCam.getName();
      for (const other of cams) {
        if (other.shouldYieldToNewStationViewer(newestViewerCam, switchNow)) {
          other.clearViewerQueue('viewer switched to ' + targetCamName);
          if (other.isSessionActive()) {
            stopCam(other, 'preempted by live view opened on ' + targetCamName, true, 'viewer-preempt');
          }
        }
      }
    }
    for (const cam of cams) {
      if (cam.promoteStartupProbeToViewerWake() && (!cam.isRtspDirect() || !cam.isSessionActive())) {
        triggerCam(cam, 'live view opened', cam.getViewLingerMs(), WAKE_KINDS.VIEW, 'viewer');
      }
    }
  } finally {
    isPollingViewers = false;
  }
}

module.exports = {
  BACKFILL_SNAP_DELAY_MS,
  isFrigateConnected,
  isGo2rtcConnected,
  buildFrigateMaskPayload,
  buildFrigateMaskDeletePayload,
  isFrigateMaskIntact,
  resolveFrigateEventLabel,
  computeRequiredSnapshotDelay,
  classifyViewerAction,
  syncSingleFrigateMaskSection,
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  checkPeriodicMaskSync,
  frigateEvent,
  isFrigateCameraIdle,
  pollViewers,
};
