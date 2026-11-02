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
  FRAME,
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
  getEventPriority,
} = require('../config');
const {log} = require('../logger');
const {
  want,
  inMotion,
  getEffectivePriority,
  usesP2pSlot,
  isRtspCapable,
  getStationKey,
  isLowBattery,
  clearViewerQueue,
} = require('../domain/camera');
const {renderCameraCards} = require('../overlay/card-renderer');
const {saveCachedFrame} = require('../overlay/snapshot-cache');
const {pushFrameToEncoder} = require('../media/encoder');
const {startRtspDecoder, stopDecoder, onVideo, onAudio} = require('../media/decoder');
const {frigateEvent, isFrigateCameraIdle, checkPeriodicMaskSync} = require('./frigate-service');
const {
  call,
  isWsReady,
  getWsReadyAt,
  isInitialTelemetryLoaded,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  extractRecognizedPerson,
} = require('./eufy-client');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cams = [];
let bySerial = new Map();
let isShuttingDownFn = () => false;

const stationTransitions = new Map();
const getStationTransition = (cam) => stationTransitions.get(getStationKey(cam)) || Promise.resolve();
const setStationTransition = (cam, p) => stationTransitions.set(getStationKey(cam), p);

/**
 * Initializes the orchestrator with the active camera collection and shutdown state accessor.
 *
 * @param {Array<Record<string, *>>} cameraList - Configured Camera instances.
 * @param {Map<string, Record<string, *>>} serialMap - Map of serial -> Camera instance.
 * @param {() => boolean} shuttingDownGetter - Function returning true when shutting down.
 */
function initOrchestrator(cameraList, serialMap, shuttingDownGetter) {
  cams = cameraList;
  bySerial = serialMap;
  isShuttingDownFn = shuttingDownGetter;
}

/**
 * Evaluates whether an active motion-woken camera can go to sleep early to conserve battery.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function evaluateEarlySleep(cam, now) {
  if (EARLY_SLEEP_MS <= 0 || !cam.active || !inMotion(cam) || now < cam.viewUntil) return;
  if (!cam.gotVideo || now - cam.firstVideoAt < EARLY_SLEEP_MS) return;
  if (now - cam.lastEarlySleepCheckAt < 5000) return;

  const clearedByEufy = cam.motionClearedAt > cam.lastMotionAt && now - cam.motionClearedAt >= 5000;
  const elapsedQuiet = now - cam.lastMotionAt >= EARLY_SLEEP_MS;
  if (!clearedByEufy && !elapsedQuiet) return;

  cam.lastEarlySleepCheckAt = now;
  const frigateIdle = await isFrigateCameraIdle(cam);
  if (!cam.active || !inMotion(cam) || now < cam.viewUntil) return;

  if (frigateIdle && Date.now() - cam.lastMotionAt >= Math.min(EARLY_SLEEP_MS, 10000)) {
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
 * Extends a camera's wake timer for either a motion event or an active live viewer and runs
 * stream arbitration across all cameras.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} reason - Description of what triggered the wake request.
 * @param {number} ms - Duration in milliseconds to hold the camera awake.
 * @param {'motion'|'view'} kind - Type of wake trigger.
 * @param {string} [initiator=''] - Who initiated the wake trigger ('eufy-event', 'viewer', 'bridge-probe').
 * @param {number} [evPriority=10] - Event priority boost score.
 */
function trigger(cam, reason, ms, kind, initiator = '', evPriority = 10) {
  const now = Date.now();
  if (!isWsReady()) return;
  const resolvedInitiator = initiator || (kind === 'motion' ? 'eufy-event' : 'viewer');
  if (now >= want(cam)) {
    cam.reason = reason;
    cam.wakeInitiator = resolvedInitiator;
  }
  if (kind === 'motion') {
    if (!inMotion(cam) && !cam.active) {
      cam.reason = reason;
      cam.wakeInitiator = resolvedInitiator;
      cam.eventPriority = evPriority;
    } else if (evPriority >= (cam.eventPriority || 0)) {
      cam.eventPriority = evPriority;
      cam.reason = reason;
    }
    const prevMotionAt = cam.lastMotionAt || 0;
    const prevPriority = cam.eventPriority || 0;
    cam.eventActive = true;
    cam.motionUntil = Math.max(cam.motionUntil, now + ms);
    cam.lastMotionAt = now;
    if (cam.active) {
      const holdSecs = Math.round((cam.motionUntil - now) / 1000);
      const ecoNote = isLowBattery(cam) ? ', low-battery eco hold ' + Math.round(ms / 1000) + 's' : '';
      const logFn = now - prevMotionAt < 2000 && evPriority <= prevPriority ? log.debug : log.info;
      logFn(
          cam,
          'activity trigger "' +
          reason +
          '" (initiator=' +
          resolvedInitiator +
          ', already live, holdExtendedTo=' +
          holdSecs +
          's, priority=' +
          getEffectivePriority(cam) +
          ecoNote +
          ')'
      );
    }
  } else {
    if (!isRtspCapable(cam) && now >= cam.viewUntil) {
      for (const other of cams) {
        if (
            other !== cam &&
            !isRtspCapable(other) &&
            getStationKey(other) === getStationKey(cam) &&
            (other.viewUntil > 0 || [...other.viewerIds.values()].some(Boolean))
        ) {
          clearViewerQueue(other, 'superseded by P2P viewer on ' + cam.name);
        }
      }
    }
    if (now >= cam.viewUntil) cam.viewSince = now;
    cam.viewUntil = Math.max(cam.viewUntil, now + ms);
  }
  arbitrate();
}

/**
 * Arbitrates which camera gets each station's P2P livestream slot and wakes RTSP cameras in parallel.
 */
function arbitrate() {
  const now = Date.now();

  // 1. Check active RTSP cameras independently of the P2P slot.
  for (const rCam of cams.filter((c) => c.active && c.activeMode === 'rtsp')) {
    if (now >= want(rCam)) {
      stop(rCam, 'RTSP hold/view timer expired', false, 'bridge-timer');
    }
  }

  // 2. Wake any wanting cameras that have HomeBase RTSP enabled immediately (no P2P slot needed).
  for (const rCam of cams.filter((c) => !c.active && now < want(c) && isRtspCapable(c))) {
    rCam.active = true;
    rCam.activeMode = 'rtsp';
    rCam.eventActive = inMotion(rCam);
    rCam.pendingBackfill = null;
    rCam.sessionId++;
    rCam.p2pReady = true;
    rCam.startedAt = now;
    rCam.lastStartAt = now;
    rCam.gotVideo = false;
    rCam.restarts = 0;
    rCam.lastVideoAt = 0;
    rCam.burstUntil = now + 1500;
    pushFrameToEncoder(rCam, now);
    log.info(
        rCam,
        'WAKE [RTSP] (initiator=' +
        (rCam.wakeInitiator || 'bridge') +
        ', reason="' +
        rCam.reason +
        '", priority=' +
        getEffectivePriority(rCam) +
        ', session=' +
        rCam.sessionId +
        ')'
    );
    void startRtspStream(rCam);
  }

  // 3. Arbitrate P2P slots independently per stationSerial (HomeBase vs standalone cameras).
  const stationKeys = new Set(cams.filter((c) => !isRtspCapable(c)).map((c) => getStationKey(c)));
  for (const stationKey of stationKeys) {
    const stationCams = cams.filter((c) => !isRtspCapable(c) && getStationKey(c) === stationKey);
    let cur = stationCams.find((c) => usesP2pSlot(c));

    if (cur && cur.activeMode !== 'download' && now >= want(cur)) {
      stop(cur, 'hold/view timer expired, no more activity or viewers', false, 'bridge-timer');
      cur = null;
    }

    const wanting = stationCams.filter((c) => !c.active && now < want(c));
    if (!wanting.length || !isWsReady()) continue;

    const pick = wanting.sort(
        (a, b) =>
            Number(inMotion(b)) - Number(inMotion(a)) ||
            (inMotion(a)
                ? getEffectivePriority(b) - getEffectivePriority(a) || b.lastMotionAt - a.lastMotionAt
                : b.viewSince - a.viewSince)
    )[0];

    if (cur && cur.activeMode === 'download') {
      if (cur.isTestBackfill && !inMotion(pick)) {
        continue;
      }
      stop(
          cur,
          'backfill download preempted by live request on ' + pick.name + ' (' + pick.reason + ')',
          !inMotion(pick),
          'bridge-arbitrator/live-over-download'
      );
      cur = null;
    }

    if (cur) {
      const pickScore = getEffectivePriority(pick);
      const curScore = getEffectivePriority(cur);
      const curFinishedOrStalled =
          cur.motionClearedAt > cur.lastMotionAt || (!cur.gotVideo && now - cur.startedAt >= 8000);

      let ok = false;
      if (inMotion(pick)) {
        if (!inMotion(cur)) {
          ok = true;
        } else if (pickScore > curScore) {
          ok = true;
        } else if (pickScore === curScore && pick.lastMotionAt > cur.lastMotionAt) {
          ok = PREEMPT_EVENT_STREAMS || curFinishedOrStalled;
        } else if (pickScore < curScore && curFinishedOrStalled) {
          ok = true;
        }
      } else {
        ok = !inMotion(cur) && pick.viewSince > cur.viewSince;
      }

      if (!ok) {
        for (const c of wanting) {
          if (!inMotion(c)) {
            clearViewerQueue(c, 'blocked by active stream on ' + cur.name);
          } else if (!PREEMPT_EVENT_STREAMS && c.lastMotionAt > cur.lastMotionAt) {
            c.motionUntil = 0;
            c.eventPriority = 0;
          }
          pushFrameToEncoder(c, now);
        }
        continue;
      }
      const preemptInitiator = inMotion(pick)
          ? !inMotion(cur)
              ? 'bridge-arbitrator/motion-over-viewer'
              : pickScore > curScore
                  ? 'bridge-arbitrator/higher-priority-event'
                  : 'bridge-arbitrator/newer-motion'
          : 'bridge-arbitrator/newer-viewer';
      stop(
          cur,
          'preempted by ' + pick.name + ' (' + pick.reason + ', priority=' + pickScore + ' vs ' + curScore + ')',
          !inMotion(pick),
          preemptInitiator
      );
    }

    for (const c of wanting) {
      if (c !== pick && !inMotion(c)) {
        clearViewerQueue(c, 'not selected by arbitrator, ' + pick.name + ' won station slot');
      }
    }

    pick.active = true;
    pick.activeMode = 'p2p';
    pick.eventActive = inMotion(pick);
    pick.sessionId++;
    pick.p2pReady = false;
    pick.startedAt = now;
    pick.gotVideo = false;
    pick.restarts = 0;
    pick.lastVideoAt = 0;
    pick.burstUntil = now + 1500;
    pushFrameToEncoder(pick, now);
    const ecoTag = isLowBattery(pick) ? ' [low-battery economy mode]' : '';
    log.info(
        pick,
        'WAKE (initiator=' +
        (pick.wakeInitiator || 'bridge') +
        ', reason="' +
        pick.reason +
        '", station=' +
        stationKey +
        ', priority=' +
        getEffectivePriority(pick) +
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
}

/**
 * Starts a HomeBase RTSP pull stream for a camera and requests device.start_rtsp_livestream.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
async function startRtspStream(cam) {
  if (!cam.active || cam.activeMode !== 'rtsp' || !cam.rtspUrl) return;
  const mySession = cam.sessionId;
  cam.lastStartAt = Date.now();
  if (cam.rtspUrl && !cam.dec) {
    startRtspDecoder(cam, cam.rtspUrl);
  }
  if (cam.eventActive) {
    frigateEvent(cam, cam.reason, '');
  }
  await call({
    command: 'device.set_property',
    serialNumber: cam.serial,
    name: 'rtspStream',
    value: true,
  });
  if (!cam.active || cam.sessionId !== mySession || cam.activeMode !== 'rtsp') return;
  const r = await call({command: 'device.start_rtsp_livestream', serialNumber: cam.serial});
  if (!r.success && r.errorCode && !/already_running/i.test(r.errorCode)) {
    log.debug(
        cam,
        'device.start_rtsp_livestream returned ' +
        r.errorCode +
        ' (relying on rtspStream property wake)'
    );
  }
  if (cam.active && cam.sessionId === mySession && cam.activeMode === 'rtsp' && cam.rtspUrl && !cam.dec) {
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
  if (!rows.length) return;

  const candidates = [];
  for (const item of rows) {
    const rec =
        item && typeof item === 'object'
            ? item.record && typeof item.record === 'object'
                ? item.record
                : item
            : null;
    if (!rec) continue;

    const devSn = rec.device_sn || rec.deviceSN || rec.deviceSerial || rec.serialNumber || '';
    if (!devSn) continue;

    let storagePath = rec.storage_path || rec.storagePath || rec.local_path || rec.localPath || '';
    const cropPath = rec.crop_local_path || rec.cropLocalPath || rec.thumb_path || '';
    if (!storagePath && cropPath) {
      const m = /^(.*\/(\d{14}))\/[^/]+$/.exec(String(cropPath));
      if (m) {
        storagePath = m[1] + '/' + m[2] + '.zxvideo';
      }
    }
    if (!storagePath) continue;

    const cipherId = Number(rec.cipher_id ?? rec.cipherId ?? 0);
    const startStr = rec.start_time || rec.startTime || rec.create_time || rec.createTime || '';
    let clipMs = startStr ? new Date(startStr).getTime() : 0;
    if (!clipMs || Number.isNaN(clipMs)) {
      const tm = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(storagePath);
      if (tm) {
        clipMs = new Date(
            Number(tm[1]),
            Number(tm[2]) - 1,
            Number(tm[3]),
            Number(tm[4]),
            Number(tm[5]),
            Number(tm[6])
        ).getTime();
      } else {
        clipMs = 0;
      }
    }
    candidates.push({devSn, storagePath, cipherId, clipMs});
  }

  candidates.sort((a, b) => b.clipMs - a.clipMs);

  let matchedAny = false;
  for (const cand of candidates) {
    const cam = bySerial.get(cand.devSn);
    if (!cam || !cam.pendingBackfill || cam.backfillClip) continue;
    if (cam.downloadedPaths.has(cand.storagePath)) continue;

    if (
        !cam.pendingBackfill.ignoreTimeWindow &&
        cand.clipMs &&
        (cand.clipMs < cam.pendingBackfill.at - 45000 || cand.clipMs > cam.pendingBackfill.at + 180000)
    ) {
      continue;
    }

    cam.backfillClip = {
      storagePath: cand.storagePath,
      cipherId: cand.cipherId,
      event: cam.pendingBackfill.event,
      personName: cam.pendingBackfill.personName,
      reason: cam.pendingBackfill.reason,
    };
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
  if (!BACKFILL_DOWNLOADS || !isWsReady() || isShuttingDownFn()) return;
  if (cams.some((c) => usesP2pSlot(c) || (!c.active && !isRtspCapable(c) && now < want(c)))) {
    return;
  }
  const hasUrgentTest = cams.some((c) => c.pendingBackfill && c.pendingBackfill.ignoreTimeWindow);
  const lastP2pActivity = Math.max(0, ...cams.map((c) => c.sleptAt || 0));
  if (!hasUrgentTest && now - lastP2pActivity < BACKFILL_DELAY_MS) return;

  for (const c of cams) {
    if (c.pendingBackfill && now - c.pendingBackfill.at > 300000) {
      log.debug(c, 'expired unfulfilled backfill request (' + c.pendingBackfill.reason + ')');
      c.pendingBackfill = null;
      c.backfillClip = null;
    }
  }

  const readyCam = cams
      .filter((c) => c.backfillClip && !c.active)
      .sort((a, b) => (b.pendingBackfill?.priority || 0) - (a.pendingBackfill?.priority || 0))[0];

  if (readyCam) {
    const clip = readyCam.backfillClip;
    const isTest = Boolean(readyCam.pendingBackfill && readyCam.pendingBackfill.ignoreTimeWindow);
    readyCam.backfillClip = null;
    readyCam.pendingBackfill = null;
    readyCam.downloadedPaths.add(clip.storagePath);

    readyCam.active = true;
    readyCam.activeMode = 'download';
    readyCam.isTestBackfill = isTest;
    readyCam.downloadFinished = false;
    readyCam.downloadFrames = [];
    readyCam.eventActive = false;
    readyCam.reason = 'backfill: ' + clip.reason;
    readyCam.wakeInitiator = 'bridge-backfill';
    readyCam.sessionId++;
    readyCam.p2pReady = true;
    readyCam.startedAt = now;
    readyCam.lastStartAt = now;
    readyCam.gotVideo = false;
    readyCam.restarts = 0;
    readyCam.lastVideoAt = 0;
    readyCam.burstUntil = now + 1500;
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
      .filter(
          (c) =>
              c.pendingBackfill &&
              !c.backfillClip &&
              now - c.pendingBackfill.at >= 8000 &&
              now - c.lastBackfillQueryAt >= 12000
      )
      .sort((a, b) => b.pendingBackfill.priority - a.pendingBackfill.priority)[0];

  if (!queryCam) return;
  queryCam.lastBackfillQueryAt = now;
  if (++queryCam.pendingBackfill.attempts > 4) {
    log.debug(
        queryCam,
        'giving up on backfill query after 4 attempts (' + queryCam.pendingBackfill.reason + ')'
    );
    queryCam.pendingBackfill = null;
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

  const dStart = new Date(now - 86400000);
  const dEnd = new Date(now + 86400000);
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
      '/4, reason="' +
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
 * @param {Record<string, *>} cam - Camera state object.
 */
async function startLivestream(cam) {
  if (cam.starting || !cam.active) return;
  cam.starting = true;
  const mySession = cam.sessionId;

  const runStart = async () => {
    try {
      await getStationTransition(cam);
      if (!cam.active || cam.sessionId !== mySession) {
        log.debug(
            cam,
            'aborted start_livestream before RPC call (initiator=bridge, reason=session_canceled_or_preempted, session=' +
            mySession +
            ')'
        );
        return;
      }

      cam.p2pReady = true;
      cam.lastStartAt = Date.now();
      let r = await call({command: 'device.start_livestream', serialNumber: cam.serial});

      if (!cam.active || cam.sessionId !== mySession) {
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
        await sleep(1000);
        if (!cam.active || cam.sessionId !== mySession) return;
        cam.p2pReady = true;
        cam.lastStartAt = Date.now();
        r = await call({command: 'device.start_livestream', serialNumber: cam.serial});
        if (!cam.active || cam.sessionId !== mySession) {
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
        if (cam.active && cam.sessionId === mySession) {
          cam.lastStartAt = Date.now() - 5000;
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
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} why - Reason the camera is going to sleep.
 * @param {boolean} [preemptedByViewer=false] - True if stopped because the user opened another camera.
 * @param {string} [initiator='bridge'] - Decision maker identifier.
 */
function stop(cam, why, preemptedByViewer = false, initiator = 'bridge') {
  if (!cam.active) return;
  const now = Date.now();
  const inFlightStart = cam.startPromise;
  const hadVideo = cam.gotVideo;
  const liveSecs = Math.round((now - cam.startedAt) / 1000);
  const lastVideoAgo = cam.lastVideoAt ? ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
  const restartsCount = cam.restarts;
  const closedSession = cam.sessionId;
  const closedMode = cam.activeMode || 'p2p';

  if (Buffer.isBuffer(cam.frame) && cam.frame.length === FRAME) {
    cam.lastFrame = Buffer.from(cam.frame);
  }
  cam.active = false;
  cam.activeMode = '';
  cam.isTestBackfill = false;
  cam.downloadFinished = false;
  cam.downloadFrames = [];
  cam.starting = false;
  cam.startPromise = null;
  cam.eventActive = false;
  cam.motionUntil = 0;
  cam.eventPriority = 0;
  cam.p2pReady = false;
  cam.isStartupProbe = false;
  cam.motionClearedAt = 0;
  cam.sessionId++;
  cam.lastStoppedAt = now;
  cam.rtspFallbackUntil = 0;
  if (hadVideo && !preemptedByViewer && closedMode !== 'download') {
    cam.sleptAt = now;
  }
  cam.burstUntil = now + 1500;
  clearViewerQueue(cam);

  const sleepMsg =
      'SLEEP (initiator=' +
      initiator +
      ', reason="' +
      why +
      '", live=' +
      liveSecs +
      's, gotVideo=' +
      hadVideo +
      ', lastVideoAgo=' +
      lastVideoAgo +
      ', restarts=' +
      restartsCount +
      ', session=' +
      closedSession +
      ')';

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
            if (closedMode === 'rtsp') {
              await sleep(50);
            } else if (closedMode === 'download') {
              await call({command: 'device.cancel_download', serialNumber: cam.serial});
              await sleep(150);
            } else {
              const res = await call({command: 'device.stop_livestream', serialNumber: cam.serial});
              if (!res.success && res.errorCode && !/ws_closed|not_running/i.test(res.errorCode)) {
                log.debug(cam, 'device.stop_livestream returned errorCode=' + res.errorCode);
              }
              await sleep(150);
            }
          })
          .catch(() => {
          })
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
 * Handles incoming event notifications from eufy-security-ws, including livestream media packets,
 * stream start/stop notifications, device telemetry updates, and motion/person/pet/ring triggers.
 *
 * @param {Record<string, *>} e - Event object from eufy-security-ws.
 */
function onEvent(e) {
  if (e.event === 'device added' && e.device && e.device.serialNumber) {
    const cam = bySerial.get(e.device.serialNumber);
    if (cam) applyDeviceProperties(cam, e.device, cam.battery === null);
    return;
  }
  if (e.source === 'station') {
    const stationId = e.serialNumber || 'homebase';
    if (e.event === 'close' || e.event === 'connection error') {
      log.warn('bridge', 'HomeBase station (' + stationId + ') P2P disconnected or restarting (' + e.event + ')');
      for (const c of cams) {
        if (c.stationSerial && e.serialNumber && c.stationSerial !== e.serialNumber) continue;
        c.motionUntil = 0;
        clearViewerQueue(c, 'station_disconnected');
        if (c.active) {
          stop(c, 'Station (' + stationId + ') P2P disconnected/restarting', false, 'error/station-disconnect');
        }
      }
    } else if (e.event === 'connect') {
      log.info('bridge', 'HomeBase station (' + stationId + ') P2P connected');
      setTimeout(() => {
        if (isWsReady() && !isShuttingDownFn()) void fetchAllCameraTelemetry();
      }, 3000);
    } else if (e.event && e.event.includes('database query')) {
      handleDatabaseQueryResult(e);
    }
    return;
  }

  const cam = bySerial.get(e.serialNumber);
  if (!cam) return;

  switch (e.event) {
    case 'livestream video data':
      if (!cam.active) {
        const now = Date.now();
        const stoppedRef = Math.max(cam.sleptAt || 0, cam.lastStoppedAt || 0);
        if (now - stoppedRef > 5000 && now - cam.lastUnsolicitedStopAt > 5000) {
          cam.lastUnsolicitedStopAt = now;
          const sleptAgo = stoppedRef ? Math.round((now - stoppedRef) / 1000) + 's' : 'never';
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
      return onVideo(cam, e);

    case 'livestream audio data':
      return onAudio(cam, e);

    case 'download video data':
      if (!cam.active || cam.activeMode !== 'download') return;
      return onVideo(cam, e);

    case 'download audio data':
      if (!cam.active || cam.activeMode !== 'download') return;
      return onAudio(cam, e);

    case 'download started':
      if (!cam.active || cam.activeMode !== 'download') {
        void call({command: 'device.cancel_download', serialNumber: cam.serial});
        return;
      }
      cam.p2pReady = true;
      return log.info(cam, 'eufy clip download started (session=' + cam.sessionId + ')');

    case 'download finished':
      if (cam.active && cam.activeMode === 'download') {
        cam.downloadFinished = true;
        if (cam.downloadFrames.length > 0) {
          log.info(
              cam,
              'eufy clip transfer complete, playing remaining ' +
              cam.downloadFrames.length +
              ' buffered frames at ' +
              LIVE_FPS +
              ' fps (session=' +
              cam.sessionId +
              ')'
          );
          return;
        }
      }
      if (cam.active && cam.activeMode === 'download') {
        const elapsed = Date.now() - cam.startedAt;
        const waitMs = cam.gotVideo && elapsed < 4500 ? 4500 - elapsed : 0;
        if (waitMs > 0) {
          const finSession = cam.sessionId;
          setTimeout(() => {
            if (cam.active && cam.activeMode === 'download' && cam.sessionId === finSession) {
              stop(cam, 'post-event clip download finished', false, 'eufy/download-finished');
              arbitrate();
            }
          }, waitMs);
        } else {
          stop(cam, 'post-event clip download finished', false, 'eufy/download-finished');
          arbitrate();
        }
      }
      return;

    case 'rtsp livestream started':
      if (cam.active && cam.activeMode === 'rtsp') {
        if (cam.rtspUrl && !cam.dec) {
          startRtspDecoder(cam, cam.rtspUrl);
        }
        return log.info(cam, 'eufy RTSP livestream started (session=' + cam.sessionId + ')');
      }
      return log.debug(cam, 'ignoring RTSP livestream started event while in P2P/idle mode');

    case 'rtsp livestream stopped':
      if (cam.active && cam.activeMode === 'rtsp') {
        stop(cam, 'eufy ended RTSP livestream', false, 'eufy/rtsp-end');
        arbitrate();
      }
      return;

    case 'livestream started':
      if (!cam.active) {
        log.warn(
            cam,
            'eufy livestream started after session was already closed/canceled, forcing immediate stop (initiator=bridge, cause=eufy_late_start)'
        );
        void call({command: 'device.stop_livestream', serialNumber: cam.serial});
        return;
      }
      cam.p2pReady = true;
      return log.info(cam, 'eufy livestream started (session=' + cam.sessionId + ')');

    case 'livestream stopped': {
      const now = Date.now();
      const liveSecs = cam.startedAt ? Math.round((now - cam.startedAt) / 1000) : 0;
      const lastVideoAgo = cam.lastVideoAt ? ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
      cam.p2pReady = false;
      stopDecoder(cam);

      const eufyEndedEventCleanly =
          cam.active &&
          cam.eventActive &&
          LET_EUFY_DECIDE_END &&
          cam.gotVideo &&
          now >= cam.viewUntil &&
          (cam.motionClearedAt > cam.lastMotionAt || now - cam.firstVideoAt >= 3000);

      if (eufyEndedEventCleanly) {
        cam.motionUntil = 0;
        stop(cam, 'eufy/camera ended event livestream', false, 'eufy/camera-event-end');
        arbitrate();
        return;
      }

      if (cam.active && now < want(cam)) {
        const remainingSecs = Math.round((want(cam) - now) / 1000);
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
      return;
    }

    case 'property changed':
      if (
          [
            'battery',
            'batteryLevel',
            'chargingStatus',
            'batteryIsCharging',
            'powerSource',
            'wifiSignalLevel',
            'wifiRssi',
            'cellularSignalLevel',
            'cellularRSSI',
            'batteryTemperature',
            'temperature',
            'videoStreamingQuality',
            'rtspStream',
            'rtspStreamUrl',
          ].includes(e.name)
      ) {
        applyDeviceProperties(cam, {[e.name]: e.value}, false);
      }
      return;

    default:
      if (TRIGGERS.has(String(e.event || '').toLowerCase())) {
        if (e.state === false) {
          const now = Date.now();
          cam.motionClearedAt = now;
          if (LET_EUFY_DECIDE_END && cam.active && inMotion(cam) && cam.gotVideo) {
            const minEnd = Math.max(now + 5000, (cam.firstVideoAt || now) + 10000);
            if (cam.motionUntil > minEnd) {
              cam.motionUntil = minEnd;
              log.info(
                  cam,
                  'eufy reported activity cleared (event="' +
                  e.event +
                  '"), ending stream in ' +
                  Math.round((minEnd - now) / 1000) +
                  's'
              );
              return;
            }
          }
          log.debug(cam, 'eufy reported activity cleared (event="' + e.event + '")');
          return;
        }
        if (e.state === true && Date.now() - getWsReadyAt() > 5000) {
          cam.motionClearedAt = 0;
          cam.isStartupProbe = false;
          cam.needsStartupSnapshot = false;
          const holdDuration = isLowBattery(cam) ? Math.min(HOLD_MS, LOW_BAT_HOLD_MS) : HOLD_MS;
          const personName = extractRecognizedPerson(e);
          const triggerDesc = personName ? e.event + ' (' + personName + ')' : e.event;
          const evPrio = getEventPriority(e.event);
          if (BACKFILL_DOWNLOADS && !isRtspCapable(cam)) {
            cam.pendingBackfill = {
              at: Date.now(),
              event: e.event,
              personName,
              reason: triggerDesc,
              priority: cam.priority + evPrio,
              attempts: 0,
            };
          }
          trigger(cam, triggerDesc, holdDuration, 'motion', 'eufy-event', evPrio);
          if (cam.active && cam.activeMode !== 'download') {
            frigateEvent(cam, e.event, personName);
          }
        }
      }
  }
}

/**
 * Starts the 500ms housekeeping & watchdog loop: runs stream arbitration, processes backfill
 * queues, checks periodic mask drift, schedules startup snapshot probes, enforces max stream
 * duration limits, evaluates early sleep, and retries stalled RTSP/download/P2P streams.
 */
function startHousekeepingLoop() {
  setInterval(() => {
    const now = Date.now();
    arbitrate();
    void processBackfillQueue(now);
    if (isWsReady()) {
      checkPeriodicMaskSync(cams, now, isShuttingDownFn());
    }

    if (isWsReady() && isInitialTelemetryLoaded() && now - getWsReadyAt() > 6000) {
      const nextProbeCam = cams.find(
          (c) =>
              c.needsStartupSnapshot &&
              !isLowBattery(c) &&
              !cams.some((o) => getStationKey(o) === getStationKey(c) && (o.active || now < want(o)))
      );
      if (nextProbeCam) {
        nextProbeCam.needsStartupSnapshot = false;
        nextProbeCam.isStartupProbe = true;
        trigger(nextProbeCam, 'startup snapshot probe', 25000, 'view', 'bridge-probe');
      }
    }

    for (const cam of cams) {
      if (!cam.active) continue;
      if (now - cam.startedAt >= MAX_MS) {
        cam.motionUntil = 0;
        stop(
            cam,
            'reached max_secs limit (' + Math.round(MAX_MS / 60000) + 'm)',
            false,
            'bridge-max-limit'
        );
        continue;
      }
      if (!inMotion(cam) && now - Math.max(cam.startedAt, cam.motionUntil) >= VIEW_MAX_MS) {
        stop(
            cam,
            'reached view_max_secs limit (' + Math.round(VIEW_MAX_MS / 60000) + 'm)',
            false,
            'bridge-view-limit'
        );
        continue;
      }
      void evaluateEarlySleep(cam, now);
      const quietSince = Math.max(cam.lastVideoAt, cam.lastStartAt);
      if (cam.activeMode === 'rtsp') {
        if (!cam.gotVideo && now - quietSince > 6500 && cam.restarts === 0) {
          cam.restarts = 1;
          cam.lastStartAt = now;
          log.info(
              cam,
              'RTSP wake still waiting for video after 6.5s, re-sending start_rtsp_livestream (session=' +
              cam.sessionId +
              ')'
          );
          stopDecoder(cam);
          void startRtspStream(cam);
        } else if (!cam.gotVideo && now - cam.startedAt > 14000) {
          log.warn(
              cam,
              'HomeBase RTSP stream yielded no video after 14s, queueing P2P fallback for 60s (session=' +
              cam.sessionId +
              ')'
          );
          stopDecoder(cam);
          cam.rtspFallbackUntil = now + 60000;
          cam.active = false;
          cam.activeMode = '';
          arbitrate();
        } else if (cam.gotVideo && now - cam.lastVideoAt > 8000) {
          log.warn(
              cam,
              'RTSP stream stalled mid-session (quietFor=' +
              ((now - cam.lastVideoAt) / 1000).toFixed(1) +
              's), restarting RTSP decoder (session=' +
              cam.sessionId +
              ')'
          );
          cam.lastVideoAt = now;
          stopDecoder(cam);
          void startRtspStream(cam);
        }
        continue;
      }
      if (cam.activeMode === 'download') {
        if (cam.downloadFrames.length > 0) {
          continue;
        }
        if (cam.gotVideo && (cam.downloadFinished || now - cam.lastVideoAt > 3000)) {
          stop(cam, 'post-event clip download stream completed', false, 'eufy/download-finished');
          arbitrate();
        } else if (!cam.gotVideo && now - quietSince > 10000) {
          log.warn(cam, 'post-event clip download timed out with no video after 10s');
          stop(cam, 'post-event clip download timed out', false, 'error/download-timeout');
          arbitrate();
        }
        continue;
      }
      const retryAfterMs = cam.restarts === 0 ? 5500 : 8000;
      if (now - quietSince > retryAfterMs && !cam.starting) {
        const quietSecs = ((now - quietSince) / 1000).toFixed(1);
        const stallCause = cam.gotVideo ? 'stream_stalled_mid_session' : 'no_initial_video_after_wake';
        if (++cam.restarts > 3) {
          cam.motionUntil = 0;
          stop(
              cam,
              'camera stopped sending video after 3 retries (cause=' +
              stallCause +
              ', quietFor=' +
              quietSecs +
              's)',
              false,
              'error/watchdog-timeout'
          );
          continue;
        }
        log.warn(
            cam,
            'stream stalled (initiator=bridge-watchdog, cause=' +
            stallCause +
            ', quietFor=' +
            quietSecs +
            's, gotVideo=' +
            cam.gotVideo +
            ', retry=' +
            cam.restarts +
            '/3) - resetting decoder and re-requesting livestream from eufy'
        );
        stopDecoder(cam);
        if (cam.activeMode === 'rtsp') {
          void startRtspStream(cam);
        } else {
          void startLivestream(cam);
        }
      }
    }
  }, 500);
}

module.exports = {
  initOrchestrator,
  evaluateEarlySleep,
  trigger,
  arbitrate,
  startRtspStream,
  handleDatabaseQueryResult,
  processBackfillQueue,
  startLivestream,
  stop,
  onEvent,
  startHousekeepingLoop,
};
