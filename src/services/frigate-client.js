// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Frigate HTTP client: external event creation, instant clean snapshot fallback, and active
 * object checks. Mask sync and go2rtc viewer polling live in `frigate-masks.js` and `go2rtc-viewers.js` and are
 * re-exported here for the existing callers.
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
const {pushFrameToEncoder} = require('../media/encoder');
const {notifyHA} = require('./ha-notifier');
const {readHttpErrorSnippet, FRIGATE_API_TIMEOUT_MS, FRIGATE_FAST_QUERY_TIMEOUT_MS} = require('./upstream-health');
const {
  isFrigateConnected,
  buildFrigateMaskPayload,
  buildFrigateMaskDeletePayload,
  isFrigateMaskIntact,
  syncSingleFrigateMaskSection,
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  checkPeriodicMaskSync,
} = require('./frigate-masks');
const {isGo2rtcConnected, classifyViewerAction, pollViewers} = require('./go2rtc-viewers');

/** @typedef {import("../domain/camera").Camera} Camera */

const FAST_LIVE_SNAP_DELAY_MS = 1000;
const BACKFILL_SNAP_DELAY_MS = 800;
const EVENT_DISPATCH_DELAY_MS = 600;
const FRESH_LIVE_FRAME_MS = 1500;
const RECENT_VIDEO_FALLBACK_MS = 5000;
const SNAPSHOT_POLL_INTERVAL_MS = 200;
const SNAPSHOT_EXTRA_WAIT_MS = 15000;
const MIN_SNAPSHOT_WAIT_LOOPS = 125;
const CLEAN_SNAPSHOT_INJECT_DELAY_MS = 450;
const REVIEW_LOOKUP_DELAY_MS = 1500;
const REVIEW_QUERY_LIMIT = 5;
const ACTIVE_EVENTS_QUERY_LIMIT = 10;
const FRIGATE_CAMERA_STATES = Object.freeze({
  IDLE: 'idle',
  ACTIVE: 'active',
  UNKNOWN: 'unknown',
});

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
 * Queries Frigate's /api/review endpoint to find the review item ID containing a given detection eventId.
 *
 * @param {string} cameraName - Camera name.
 * @param {string} eventId - Frigate detection event ID.
 * @returns {Promise<string>} Review ID or empty string if not found.
 */
/**
 * Returns true when a Frigate review item lists eventId among its detection IDs.
 *
 * @param {Record<string, *>|null|undefined} item - Frigate /api/review entry.
 * @param {string} eventId - Target Frigate event ID.
 * @returns {boolean}
 */
function hasMatchingDetectionId(item, eventId) {
  return Boolean(item && item.data && Array.isArray(item.data.detections) && item.data.detections.includes(eventId));
}

async function lookupFrigateReviewId(cameraName, eventId) {
  try {
    const reviewUrl = cfg.frigate_url + '/api/review?cameras=' + cameraName + '&limit=' + REVIEW_QUERY_LIMIT;
    const rvRes = await fetch(reviewUrl, {signal: AbortSignal.timeout(FRIGATE_API_TIMEOUT_MS)});
    const rv = rvRes.ok ? await rvRes.json() : null;
    if (!Array.isArray(rv)) {
      return '';
    }
    const found = rv.find((item) => hasMatchingDetectionId(item, eventId));
    return found && found.id ? found.id : '';
  } catch (err) {
    // Review ID lookup is optional enrichment for HA notifications; omit link on timeout/error.
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
 * Injects a clean cached snapshot when no video decoded, posts the external event to Frigate,
 * rolls back event cooldown if the POST fails, and restores live card rendering immediately after POST.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} waitId - Frigate event wait token captured when queued.
 * @param {boolean} noVideo - True when no sustained video frame was decoded before filing.
 * @returns {Promise<{ eventId: string, finalLabel: string, finalPerson: string }|null>}
 */
async function postFrigateCreateEvent(cam, waitId, noVideo) {
  let injectedCleanSnapshot = false;
  let committed = false;
  try {
    if (cam.canInjectCleanEventSnapshot(noVideo)) {
      cam.enableCleanSnapshotCardSuppression(Date.now(), KEYFRAME_BURST_MS);
      injectedCleanSnapshot = true;
      pushFrameToEncoder(cam, Date.now());
      await sleep(CLEAN_SNAPSHOT_INJECT_DELAY_MS);
      if (!cam.isFrigateSnapshotWaitActive(waitId)) {
        return null;
      }
    }
    const {finalLabel, finalPerson, subLabel, durationSecs} = cam.completeFrigateEventFiling(Date.now(), LIVE_FPS);
    committed = true;
    const createUrl = cfg.frigate_url + '/api/events/' + cam.getName() + '/' + finalLabel + '/create';
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
      cam.rollbackFrigateEventFiling(waitId);
      const errBody = await readHttpErrorSnippet(r);
      log.error(
        cam,
        'Frigate event "' + finalLabel + '" failed (HTTP ' + r.status + (errBody ? ' ' + errBody : '') + ')'
      );
      return null;
    }
    const resJson = await r.json();
    const eventId = resJson && resJson.event_id ? String(resJson.event_id) : '';
    if (!eventId) {
      cam.rollbackFrigateEventFiling(waitId);
      log.error(cam, 'Frigate event "' + finalLabel + '" failed (missing event_id in response)');
      return null;
    }
    cam.recordCreatedFrigateEvent(eventId);
    return {eventId, finalLabel, finalPerson};
  } catch (err) {
    if (committed) {
      cam.rollbackFrigateEventFiling(waitId);
    }
    log.error(cam, 'Frigate event failed: ' + formatErrorMessage(err));
    return null;
  } finally {
    if (injectedCleanSnapshot) {
      cam.disableCleanSnapshotCardSuppression();
      pushFrameToEncoder(cam, Date.now());
    }
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
    const created = await postFrigateCreateEvent(cam, waitId, noVideo);
    if (!created) {
      return;
    }

    const {eventId, finalLabel, finalPerson} = created;
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

    try {
      await sleep(REVIEW_LOOKUP_DELAY_MS);
      const reviewId = await lookupFrigateReviewId(cam.getName(), eventId);
      notifyHA(cam, {event_id: eventId, review_id: reviewId, no_video: noVideo});
    } catch (err) {
      log.error(cam, 'Frigate event review follow-up failed: ' + formatErrorMessage(err));
    }
  }, EVENT_DISPATCH_DELAY_MS);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  cam.setFrigateEventTimer(timer);
}

/**
 * Checks whether Frigate currently has any active or recently-active non-synthetic object
 * detections for a camera, returning 'idle', 'active', or 'unknown' when Frigate cannot be reached
 * or returns a non-2xx / malformed response so outages are never treated as active detections.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} [clockNow] - Optional synthetic timestamp in milliseconds; uses Date.now() when omitted.
 * @returns {Promise<'idle'|'active'|'unknown'>}
 */
async function isFrigateCameraIdle(cam, clockNow) {
  if (!cfg.frigate_url) {
    return FRIGATE_CAMERA_STATES.IDLE;
  }
  try {
    const url = cfg.frigate_url + '/api/events?cameras=' + cam.getName() + '&limit=' + ACTIVE_EVENTS_QUERY_LIMIT;
    const r = await fetch(url, {signal: AbortSignal.timeout(FRIGATE_FAST_QUERY_TIMEOUT_MS)});
    if (!r.ok) {
      return FRIGATE_CAMERA_STATES.UNKNOWN;
    }
    const events = await r.json();
    if (!Array.isArray(events)) {
      return FRIGATE_CAMERA_STATES.UNKNOWN;
    }
    const evalNow = clockNow === undefined ? Date.now() : clockNow;
    return cam.evaluateFrigateEventsActivity(events, evalNow)
      ? FRIGATE_CAMERA_STATES.ACTIVE
      : FRIGATE_CAMERA_STATES.IDLE;
  } catch (err) {
    // Report unknown on timeout, network error, or malformed JSON so hold extensions do not treat outages as active.
    return FRIGATE_CAMERA_STATES.UNKNOWN;
  }
}

module.exports = {
  BACKFILL_SNAP_DELAY_MS,
  FRIGATE_CAMERA_STATES,
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
