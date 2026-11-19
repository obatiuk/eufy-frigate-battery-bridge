// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Per-station P2P livestream slot arbitration, priority preemption, and parallel RTSP wake activation.
 */
'use strict';

const {log} = require('../../logger');
const {Camera} = require('../../domain/camera');
const {stations} = require('../../domain/station');
const {pushFrameToEncoder} = require('../../media/encoder');
const {frigateEvent} = require('../frigate-client');
const {isWsReady} = require('../eufy-client');
const {STATION_WAKE_PACING_MS, STOP_INITIATORS, registerArbitrator, getCams} = require('./context');
const {startRtspStream, startLivestream, stop} = require('./wake');

const P2P_WAKE_STALL_PREEMPT_MS = 8000;

/**
 * Wakes a single RTSP-capable camera in parallel without consuming a station P2P slot.
 *
 * @param {Camera} rCam - RTSP-capable Camera instance.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function activateRtspCamera(rCam, now) {
  stations.get(rCam.getStationKey()).paceDirectWake(now, STATION_WAKE_PACING_MS);
  const wakeLog = rCam.beginRtspWakeSession(now);
  pushFrameToEncoder(rCam, now);
  log.info(rCam, wakeLog);
  void startRtspStream(rCam);
}

/**
 * Arbitrates the P2P livestream slot for a single stationSerial group.
 *
 * @param {string} stationKey - Station serial identifier.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function arbitrateStationP2pSlot(stationKey, now) {
  const stationCams = getCams().filter((c) => c.belongsToStationP2pSlot(stationKey));
  let cur = stationCams.find((c) => c.isOccupyingStationP2pChannel());

  if (cur && cur.hasExpiredLiveHold(now)) {
    if (cur.isExtendCheckInFlight()) {
      return;
    }
    stop(cur, 'hold/view timer expired, no more activity or viewers', {
      preemptedByViewer: false,
      initiator: STOP_INITIATORS.TIMER,
    });
    cur = null;
  }

  const wanting = stationCams.filter((c) => c.wantsWake(now));
  if (!wanting.length || !isWsReady()) {
    return;
  }

  const pick = wanting.sort(Camera.compareWanting)[0];

  if (cur && cur.isBackfillPlayback()) {
    if (cur.isUrgentBackfillProtectedFrom(pick, now)) {
      return;
    }
    stop(cur, 'backfill download preempted by live request on ' + pick.getName() + ' (' + pick.getReason() + ')', {
      preemptedByViewer: !pick.isInMotion(now),
      initiator: 'bridge-arbitrator/live-over-download',
    });
    cur = null;
  }

  if (cur) {
    if (!pick.canPreempt(cur, now, P2P_WAKE_STALL_PREEMPT_MS)) {
      const curName = cur.getName();
      for (const c of wanting) {
        if (!c.isInMotion(now)) {
          c.clearViewerQueue('blocked by active stream on ' + curName);
        } else {
          c.expireBlockedMotionHold(cur);
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
      'preempted by ' + pick.getName() + ' (' + pick.getReason() + ', priority=' + pickScore + ' vs ' + curScore + ')',
      {preemptedByViewer: !pick.isInMotion(now), initiator: preemptInitiator}
    );
  }

  const pickName = pick.getName();
  for (const c of wanting) {
    if (c !== pick && !c.isInMotion(now)) {
      c.clearViewerQueue('not selected by arbitrator, ' + pickName + ' won station slot');
    }
  }

  stations.get(stationKey).paceDirectWake(now, STATION_WAKE_PACING_MS);
  const wakeSummary = pick.beginP2pWakeSession(now);
  pushFrameToEncoder(pick, now);
  log.info(pick, wakeSummary.wakeLog);
  if (wakeSummary.shouldFileEvent) {
    frigateEvent(pick, wakeSummary.eventReason, wakeSummary.personName);
  }
  void startLivestream(pick);
}

/**
 * Arbitrates RTSP and per-station P2P camera streams across all configured cameras.
 *
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
function arbitrate(now = Date.now()) {
  const cams = getCams();
  for (const rCam of cams.filter((c) => c.isActiveRtspSession())) {
    if (rCam.hasExpiredLiveHold(now) && !rCam.isExtendCheckInFlight()) {
      stop(rCam, 'RTSP hold/view timer expired', {preemptedByViewer: false, initiator: STOP_INITIATORS.TIMER});
    }
  }

  for (const rCam of cams.filter((c) => c.wantsRtspWake(now))) {
    activateRtspCamera(rCam, now);
  }

  const stationKeys = new Set(cams.filter((c) => !c.isRtspCapable()).map((c) => c.getStationKey()));
  for (const stationKey of stationKeys) {
    arbitrateStationP2pSlot(stationKey, now);
  }
}

registerArbitrator(arbitrate);

module.exports = {
  arbitrate,
};
