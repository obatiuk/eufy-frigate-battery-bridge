// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Frigate & go2rtc integration service: external event creation, instant clean
 * snapshot fallback, auto-synced motion/object masks, active object checks,
 * and go2rtc consumer polling.
 */
'use strict';

const {
  cfg,
  LABELS,
  EVENT_SECS,
  SNAP_DELAY_MS,
  INSTANT_EVENT_SNAPSHOT,
  LOW_BAT_WAKE_ON_VIEW,
  COOLDOWN_MS,
  LINGER_MS,
} = require('../config');
const {log} = require('../logger');
const {
  inMotion,
  isRtspCapable,
  getStationKey,
  isLowBattery,
  clearViewerQueue,
} = require('../domain/camera');
const {computeFrigateMaskPolygon} = require('../domain/status-card');
const {pushFrameToEncoder} = require('../media/encoder');
const {notifyHA} = require('./ha-notifier');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncingMasks = false;
let frigateApiDown = false;
let lastMaskCheckAt = 0;
let isPollingViewers = false;

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
  return {
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
  };
}

/**
 * Checks whether an existing Frigate named mask entry matches the expected polygon and is enabled.
 *
 * @param {Record<string, *>|null|undefined} maskEntry - Frigate eufy_bridge_card object.
 * @param {string} expectedPoly - Expected normalized polygon string.
 * @returns {boolean}
 */
function isFrigateMaskIntact(maskEntry, expectedPoly) {
  if (!maskEntry || typeof maskEntry !== 'object') {
    return false;
  }
  return maskEntry.enabled !== false && maskEntry.coordinates === expectedPoly;
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
  switch (activeMode) {
    case 'download':
      return 0;
    case 'rtsp':
      return instantSnapshot ? Math.min(snapDelayMs, 1200) : snapDelayMs;
    default:
      return snapDelayMs;
  }
}

/**
 * Synchronizes a single mask section ('motion' or 'objects') for a camera in Frigate via
 * PUT /api/config/set (requires_restart: 0).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} camCfg - Camera configuration object from Frigate /api/config.
 * @param {'motion'|'objects'} section - Frigate mask section ('motion' or 'objects').
 * @param {string} poly - Normalized polygon string, or '' to disable.
 * @returns {Promise<'verified'|'applied'|'disabled'|'none'|'failed'>}
 */
async function syncSingleFrigateMaskSection(cam, camCfg, section, poly) {
  const sectionObj = camCfg && camCfg[section] ? camCfg[section] : null;
  const existingMasks = sectionObj ? sectionObj.mask : undefined;
  const isNamedDict =
      existingMasks !== null && typeof existingMasks === 'object' && !Array.isArray(existingMasks);

  if (!poly) {
    if (isNamedDict && existingMasks.eufy_bridge_card && existingMasks.eufy_bridge_card.enabled) {
      try {
        const disablePayload = buildFrigateMaskPayload(
            cam.name,
            section,
            false,
            existingMasks.eufy_bridge_card.coordinates
        );
        const res = await fetch(cfg.frigate_api + '/api/config/set', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          signal: AbortSignal.timeout(8000),
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

  try {
    const enablePayload = buildFrigateMaskPayload(cam.name, section, true, poly);
    const putRes = await fetch(cfg.frigate_api + '/api/config/set', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify(enablePayload),
    });

    if (putRes.ok) {
      return 'applied';
    }

    const legacyUrl =
        cfg.frigate_api +
        '/api/config/set?cameras.' +
        encodeURIComponent(cam.name) +
        '.' +
        section +
        '.mask=' +
        encodeURIComponent(poly);
    const legRes = await fetch(legacyUrl, {
      method: 'PUT',
      signal: AbortSignal.timeout(8000),
    });
    if (legRes.ok) {
      return 'applied';
    }

    const errText = (await putRes.text()).slice(0, 160);
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
 * @param {Array<Record<string, *>>} cams - Array of Camera instances.
 * @param {boolean} [forceResync=false] - Whether to clear cached polygons and re-verify all cameras.
 * @param {boolean} [shuttingDown=false] - Whether the bridge is shutting down.
 */
async function syncFrigateMotionMasks(cams, forceResync = false, shuttingDown = false) {
  if (isSyncingMasks || shuttingDown || !cfg.frigate_api || !cams.some((c) => c.autoFrigateMask)) {
    return;
  }
  isSyncingMasks = true;
  try {
    if (forceResync) {
      for (const c of cams) {
        c.lastSyncedMaskPoly = '';
      }
    }
    let frigateCfg = null;
    try {
      const r = await fetch(cfg.frigate_api + '/api/config', {signal: AbortSignal.timeout(5000)});
      if (!r.ok) {
        frigateApiDown = true;
        return;
      }
      frigateCfg = await r.json();
    } catch (err) {
      frigateApiDown = true;
      log.debug('bridge', 'could not fetch Frigate /api/config for auto_frigate_mask: ' + err.message);
      return;
    }

    lastMaskCheckAt = Date.now();
    for (const cam of cams) {
      if (!cam.autoFrigateMask) {
        continue;
      }
      const poly = computeFrigateMaskPolygon(cam);
      const camCfg = frigateCfg && frigateCfg.cameras ? frigateCfg.cameras[cam.name] : null;
      if (!camCfg) {
        continue;
      }

      const motMask = camCfg.motion && camCfg.motion.mask ? camCfg.motion.mask.eufy_bridge_card : null;
      const objMask = camCfg.objects && camCfg.objects.mask ? camCfg.objects.mask.eufy_bridge_card : null;
      const masksIntact = isFrigateMaskIntact(motMask, poly) && isFrigateMaskIntact(objMask, poly);

      if (poly && cam.lastSyncedMaskPoly === poly && masksIntact) {
        continue;
      }

      const motionStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'motion', poly);
      const objectStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'objects', poly);

      if (!poly) {
        if (motionStatus === 'disabled' || objectStatus === 'disabled') {
          log.info(
              cam,
              'disabled Frigate motion & object masks eufy_bridge_card (card is ' +
              cam.cardCfg.theme +
              '/' +
              cam.cardCfg.position +
              ')'
          );
        }
        continue;
      }

      if (motionStatus !== 'failed' && objectStatus !== 'failed') {
        cam.lastSyncedMaskPoly = poly;
        const actionVerb =
            motionStatus === 'applied' || objectStatus === 'applied' ? 'auto-applied' : 'verified';
        log.info(
            cam,
            actionVerb +
            ' Frigate motion & object masks eufy_bridge_card (' +
            cam.cardCfg.theme +
            '@' +
            cam.cardCfg.position +
            ' -> ' +
            poly +
            ')'
        );
      }
    }
  } finally {
    isSyncingMasks = false;
  }
}

/**
 * Marks Frigate's API as down and schedules a mask re-verification after recovery.
 *
 * @param {Array<Record<string, *>>} cams - Array of Camera instances.
 * @param {() => boolean} isShuttingDownFn - Callback returning shutdown state.
 */
function handleEncoderReconnectMaskSync(cams, isShuttingDownFn) {
  frigateApiDown = true;
  setTimeout(() => {
    if (!isShuttingDownFn()) {
      void syncFrigateMotionMasks(cams, true, isShuttingDownFn());
    }
  }, 6000);
}

/**
 * Runs the periodic 60s mask drift check if due.
 *
 * @param {Array<Record<string, *>>} cams - Array of Camera instances.
 * @param {number} now - Current epoch timestamp.
 * @param {boolean} shuttingDown - Whether the bridge is shutting down.
 */
function checkPeriodicMaskSync(cams, now, shuttingDown) {
  if (now - lastMaskCheckAt >= 60000) {
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
    const reviewUrl = cfg.frigate_api + '/api/review?cameras=' + cameraName + '&limit=5';
    const rvRes = await fetch(reviewUrl, {signal: AbortSignal.timeout(5000)});
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
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} ev - Eufy event name that triggered the detection.
 * @param {string} [personName=''] - Optional recognized face name from HomeBase 3.
 */
function frigateEvent(cam, ev, personName = '') {
  if (!cfg.frigate_api) {
    return;
  }
  const label = resolveFrigateEventLabel(ev);

  if (cam.evTimer || cam.evPending) {
    if (cam.evLabel === 'motion' && label !== 'motion') {
      log.debug(cam, 'upgraded pending Frigate event label ("motion" -> "' + label + '")');
      cam.evLabel = label;
    }
    if (personName && !cam.evPerson) {
      log.debug(cam, 'attached recognized person "' + personName + '" to pending Frigate event');
      cam.evPerson = personName;
    }
    return;
  }
  if (Date.now() < (cam.evUntil || 0)) {
    return;
  }

  cam.evLabel = label;
  cam.evPerson = personName || '';
  cam.evPending = true;
  cam.evTimer = setTimeout(async () => {
    cam.evTimer = null;
    notifyHA(cam, {});

    const requiredDelayMs = computeRequiredSnapshotDelay(cam.activeMode);
    const showing = () =>
        (cam.active &&
            cam.frame &&
            Date.now() - cam.frameAt < 1500 &&
            Date.now() - cam.firstFrameAt >= requiredDelayMs) ||
        (INSTANT_EVENT_SNAPSHOT && !cam.active && cam.gotVideo && Date.now() - cam.lastVideoAt < 5000);

    const maxWaitLoops = Math.max(125, Math.ceil((SNAP_DELAY_MS + 15000) / 200));
    for (let i = 0; i < maxWaitLoops && cam.evLabel !== 'test' && !showing(); i++) {
      await sleep(200);
    }

    const noVideo = cam.evLabel !== 'test' && !showing();
    if (noVideo && INSTANT_EVENT_SNAPSHOT && Buffer.isBuffer(cam.lastFrame)) {
      cam.suppressLiveCard = true;
      cam.burstUntil = Date.now() + 1500;
      pushFrameToEncoder(cam, Date.now());
      await sleep(450);
    }
    const finalLabel = cam.evLabel;
    const finalPerson = cam.evPerson;
    const subLabel = finalPerson || 'eufy';
    cam.evPending = false;
    cam.evUntil = Date.now() + EVENT_SECS * 1000;

    try {
      const createUrl = cfg.frigate_api + '/api/events/' + cam.name + '/' + finalLabel + '/create';
      const r = await fetch(createUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          source_type: 'api',
          sub_label: subLabel,
          duration: EVENT_SECS,
          include_recording: true,
        }),
      });
      if (!r.ok) {
        const errBody = (await r.text()).slice(0, 200);
        log.error(cam, 'Frigate event "' + finalLabel + '" failed (HTTP ' + r.status + ' ' + errBody + ')');
        return;
      }
      const resJson = await r.json();
      const eventId = resJson.event_id;
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

      await sleep(1500);
      const reviewId = await lookupFrigateReviewId(cam.name, eventId);
      notifyHA(cam, {event_id: eventId, review_id: reviewId, no_video: noVideo});
    } catch (err) {
      log.error(cam, 'Frigate event failed: ' + err.message);
    } finally {
      if (cam.suppressLiveCard) {
        cam.suppressLiveCard = false;
        pushFrameToEncoder(cam, Date.now());
      }
    }
  }, 600);
}

/**
 * Checks whether Frigate currently has any active non-synthetic object detections in progress
 * for a camera, used to decide whether early sleep can safely put a motion-woken camera to sleep.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {Promise<boolean>} True if Frigate has no active tracked object detections on this camera.
 */
async function isFrigateCameraIdle(cam) {
  if (!cfg.frigate_api) {
    return true;
  }
  try {
    const url = cfg.frigate_api + '/api/events?cameras=' + cam.name + '&in_progress=1&limit=10';
    const r = await fetch(url, {signal: AbortSignal.timeout(2500)});
    if (!r.ok) {
      return false;
    }
    const events = await r.json();
    if (!Array.isArray(events)) {
      return false;
    }
    const activeTracked = events.some(
        (ev) => ev.sub_label !== 'eufy' && (!cam.evPerson || ev.sub_label !== cam.evPerson)
    );
    return !activeTracked;
  } catch (err) {
    return false;
  }
}

/**
 * Classifies how the bridge should handle a newly connected go2rtc viewer and returns
 * both the boolean wake decision (`asked`) and human-readable log description (`actionDesc`).
 *
 * @param {Record<string, *>} params - Viewer connection context.
 * @returns {{ asked: boolean, actionDesc: string }}
 */
function classifyViewerAction(params) {
  const {
    camActive,
    alreadyViewing,
    isDashboardGrid,
    blockedByP2pMotion,
    activeMotionCamName,
    blockedByEco,
    batteryPct,
    inCooldown,
  } = params;

  const asked =
      !isDashboardGrid &&
      (!camActive || alreadyViewing) &&
      !blockedByP2pMotion &&
      !blockedByEco &&
      (alreadyViewing || !inCooldown);

  if (asked) {
    return {
      asked: true,
      actionDesc: camActive ? 'extending active live view' : 'waking the camera',
    };
  }
  if (camActive) {
    return {asked: false, actionDesc: 'joined while live, does not extend it'};
  }
  if (isDashboardGrid) {
    return {asked: false, actionDesc: 'ignored, multi-camera dashboard grid view'};
  }
  if (blockedByP2pMotion) {
    return {
      asked: false,
      actionDesc: 'ignored, ' + activeMotionCamName + ' is active with P2P motion/event',
    };
  }
  if (blockedByEco) {
    return {
      asked: false,
      actionDesc: 'ignored, camera is in low-battery economy mode (' + batteryPct + '%)',
    };
  }
  return {asked: false, actionDesc: 'ignored, camera just went to sleep (cooldown)'};
}

/**
 * Polls go2rtc for active stream consumers on each camera every 750ms.
 *
 * @param {Array<Record<string, *>>} cams - Array of Camera instances.
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
        cams.find((c) => inMotion(c) && !isRtspCapable(c) && getStationKey(c) === getStationKey(cam));
    const newConnections = [];

    let anyPollOk = false;
    let allPollsFailed = true;
    for (const cam of cams) {
      try {
        const r = await fetch(cfg.go2rtc_api + '/api/streams?src=' + cam.name, {
          signal: AbortSignal.timeout(2500),
        });
        if (!r.ok) {
          continue;
        }
        allPollsFailed = false;
        anyPollOk = true;
        const d = await r.json();
        const viewers = (d.consumers || []).filter(
            (c) => !/FFmpeg Frigate|^go2rtc/i.test(c.user_agent || '')
        );
        const now = Date.now();
        const seen = new Set();

        for (const v of viewers) {
          seen.add(v.id);
          if (cam.viewerIds.has(v.id)) {
            continue;
          }

          const clientInfo = (v.format_name || v.protocol || '') + ' ' + (v.remote_addr || '');
          cam.viewerIds.set(v.id, false);
          cam.burstUntil = Math.max(cam.burstUntil || 0, now + 1200);
          pushFrameToEncoder(cam, now);
          newConnections.push({cam, id: v.id, clientInfo: clientInfo.trim(), now});
        }

        for (const [id, wasActiveViewer] of [...cam.viewerIds.entries()]) {
          if (!seen.has(id)) {
            cam.viewerIds.delete(id);
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
        }
        cam.viewers = viewers.length;
      } catch (err) {
        // Ignore transient errors while go2rtc/Frigate is restarting.
      }
    }
    if (allPollsFailed) {
      frigateApiDown = true;
    } else if (anyPollOk && frigateApiDown) {
      frigateApiDown = false;
      log.info('bridge', 'Frigate API recovered after restart/outage, re-verifying motion & object masks');
      setTimeout(() => {
        if (!isShuttingDown()) {
          void syncFrigateMotionMasks(cams, true, isShuttingDown());
        }
      }, 3000);
    }

    const activeViewerCams = cams.filter((c) => c.viewers > 0);
    const distinctSleepingNewCams = new Set(
        newConnections.filter((x) => !x.cam.active).map((x) => x.cam)
    );
    const isDashboardGrid = distinctSleepingNewCams.size > 1 && activeViewerCams.length > 1;
    let newestViewerCam = null;

    for (const conn of newConnections) {
      const {cam, id, clientInfo, now} = conn;
      const blockedByEco = isLowBattery(cam) && !LOW_BAT_WAKE_ON_VIEW;
      const activeP2pMotionCam = findStationMotionCam(cam);
      const blockedByP2pMotion = !isRtspCapable(cam) && Boolean(activeP2pMotionCam);
      const alreadyViewing = cam.active && (now < cam.viewUntil || cam.activeMode === 'download');
      const inCooldown = now - cam.sleptAt < COOLDOWN_MS;

      const {asked, actionDesc} = classifyViewerAction({
        camActive: cam.active,
        alreadyViewing,
        isDashboardGrid,
        blockedByP2pMotion,
        activeMotionCamName: activeP2pMotionCam ? activeP2pMotionCam.name : '',
        blockedByEco,
        batteryPct: cam.battery,
        inCooldown,
      });

      cam.viewerIds.set(id, asked);
      if (asked) {
        newestViewerCam = cam;
      }
      if (!isDashboardGrid && blockedByEco && now - cam.lastLowBatRefreshAt > 30000) {
        cam.lastLowBatRefreshAt = now;
        log.info(cam, 'viewer connected while in low-battery mode, polling HomeBase for battery swap');
        void fetchAllCameraTelemetry(true);
      }

      log.info(cam, 'viewer connected (' + clientInfo + ') - ' + actionDesc);
    }

    if (newestViewerCam) {
      newestViewerCam.isStartupProbe = false;
      newestViewerCam.needsStartupSnapshot = false;
      if (!isRtspCapable(newestViewerCam)) {
        for (const other of cams) {
          if (
              other !== newestViewerCam &&
              !isRtspCapable(other) &&
              getStationKey(other) === getStationKey(newestViewerCam)
          ) {
            clearViewerQueue(other, 'viewer switched to ' + newestViewerCam.name);
            if (other.active && !inMotion(other)) {
              stopCam(
                  other,
                  'preempted by live view opened on ' + newestViewerCam.name,
                  true,
                  'viewer-preempt'
              );
            }
          }
        }
      }
    }
    for (const cam of cams) {
      if (cam.hasWakingViewer()) {
        cam.isStartupProbe = false;
        triggerCam(cam, 'live view opened', LINGER_MS, 'view', 'viewer');
      }
    }
  } finally {
    isPollingViewers = false;
  }
}

module.exports = {
  buildFrigateMaskPayload,
  isFrigateMaskIntact,
  resolveFrigateEventLabel,
  computeRequiredSnapshotDelay,
  syncSingleFrigateMaskSection,
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  checkPeriodicMaskSync,
  lookupFrigateReviewId,
  frigateEvent,
  isFrigateCameraIdle,
  classifyViewerAction,
  pollViewers,
};
