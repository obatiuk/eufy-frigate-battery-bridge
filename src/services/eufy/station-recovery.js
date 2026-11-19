// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * HomeBase station P2P connectivity checks, wedged-session recycling,
 * reconnect timers, and RTSP wake URL recovery.
 */
'use strict';

const {STREAM_MODES} = require('../../config');
const {log} = require('../../logger');
const {stations} = require('../../domain/station');
const {renderCameraCards} = require('../../overlay/card-renderer');
const {pushFrameToEncoder} = require('../../media/encoder');
const {registerEufySubsystems, isWsReady, getCams, isShuttingDown, call} = require('./ws-transport');
const {applyDeviceProperties} = require('./telemetry-sync');

/** @typedef {import("../../domain/camera").Camera} Camera */

const STATION_RECOVERY_COOLDOWN_MS = 60000;
const STATION_DISCONNECT_RETRY_MS = 10000;
const ZOMBIE_STATION_TIMEOUT_THRESHOLD = 1;

/**
 * Returns true while recoverUnresponsiveStation is actively recycling stationSn via
 * station.disconnect -> station.connect.
 *
 * @param {string} stationSn - Station serial number.
 * @returns {boolean}
 */
function isStationRecycling(stationSn) {
  return Boolean(stationSn && stations.get(stationSn).isRecycling());
}

/**
 * Updates stationConnected health on all cameras belonging to stationSn and refreshes sleeping cards if changed.
 *
 * @param {string} stationSn - Station serial number.
 * @param {boolean} connected - Whether the station P2P link is connected.
 */
function updateStationHealth(stationSn, connected) {
  if (!stationSn) {
    return;
  }
  stations.get(stationSn).markDisconnected(!connected);
  for (const cam of getCams()) {
    if (cam.isOnStation(stationSn) && cam.updateServiceHealth({stationConnected: connected})) {
      renderCameraCards(cam);
      if (!cam.isBackfillPlayback()) {
        pushFrameToEncoder(cam);
      }
    }
  }
}

/**
 * Records live device/station activity on stationSn, clearing unresponsive wake counters and reconnect timers.
 *
 * @param {string} stationSn - Station serial number.
 */
function noteStationActivity(stationSn) {
  if (!stationSn) {
    return;
  }
  stations.get(stationSn).noteActivity();
  updateStationHealth(stationSn, true);
}

/**
 * Returns true when a camera on stationSn is actively streaming and has already decoded video.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} stationSn - HomeBase station serial number.
 * @returns {boolean}
 */
function hasActiveVideoOnStation(cam, stationSn) {
  return cam.isOnStation(stationSn) && cam.isSessionActive() && cam.hasGotVideo();
}

/**
 * Recovers a disconnected or zombie HomeBase station P2P session in eufy-security-ws.
 *
 * @param {string} stationSn - Target station serial number.
 * @param {string} reason - Diagnostic reason for recovery.
 * @param {boolean} [forceRecycle=false] - Whether to recycle via station.disconnect -> station.connect
 *   even when station.is_connected reports true.
 * @returns {Promise<boolean>} True if a station reconnect or recycle command was dispatched.
 */
async function recoverUnresponsiveStation(stationSn, reason, forceRecycle = false) {
  if (!isWsReady() || !stationSn) {
    return false;
  }
  const station = stations.get(stationSn);
  station.markKnown();
  const stRes = await call({command: 'station.is_connected', serialNumber: stationSn});
  if (stRes.success && stRes.result && stRes.result.connected === false) {
    updateStationHealth(stationSn, false);
    log.warn(
      'bridge',
      'HomeBase station (' + stationSn + ') P2P is disconnected (' + reason + '), sending station.connect'
    );
    const connRes = await call({command: 'station.connect', serialNumber: stationSn});
    if (connRes.success) {
      noteStationActivity(stationSn);
    } else {
      scheduleStationReconnect(stationSn);
    }
    return true;
  }
  if (!forceRecycle) {
    return false;
  }

  const now = Date.now();
  const cams = getCams();
  const hasActiveVideo = cams.some((c) => hasActiveVideoOnStation(c, stationSn));
  if (!station.canRecycle(now, hasActiveVideo, STATION_RECOVERY_COOLDOWN_MS)) {
    return false;
  }

  station.markRecycleStarted(now);
  for (const c of cams) {
    if (c.isOnStation(stationSn)) {
      c.resetStationSyncFlags();
    }
  }
  log.warn(
    'bridge',
    'HomeBase station (' +
      stationSn +
      ') P2P session appears wedged (' +
      reason +
      '), recycling via station.disconnect -> station.connect'
  );
  try {
    await call({command: 'station.disconnect', serialNumber: stationSn});
    const connRes = await call({command: 'station.connect', serialNumber: stationSn});
    if (connRes.success) {
      noteStationActivity(stationSn);
    }
  } finally {
    station.markRecycleFinished();
  }
  return true;
}

/**
 * Checks whether stationSn is connected in eufy-security-ws and sends station.connect when disconnected.
 *
 * @param {string} stationSn - Station serial number.
 * @returns {Promise<boolean>} True if a reconnect action was triggered.
 */
async function ensureStationConnected(stationSn) {
  if (!isWsReady() || !stationSn) {
    return false;
  }
  stations.registerKnown(stationSn);
  const res = await call({command: 'station.is_connected', serialNumber: stationSn});
  if (res.success && res.result && res.result.connected === false) {
    updateStationHealth(stationSn, false);
    log.warn(
      'bridge',
      'HomeBase station (' + stationSn + ') P2P link is disconnected, reconnecting via station.connect'
    );
    const connRes = await call({command: 'station.connect', serialNumber: stationSn});
    if (connRes.success) {
      noteStationActivity(stationSn);
    } else {
      scheduleStationReconnect(stationSn);
    }
    return true;
  }
  if (!res.success && res.errorCode === 'no_reply') {
    return recoverUnresponsiveStation(stationSn, 'station.is_connected no_reply', true);
  }
  if (res.success && res.result && res.result.connected === true) {
    updateStationHealth(stationSn, true);
  }
  return false;
}

/**
 * Ensures station P2P connectivity before a P2P livestream retry, recycling wedged stations on retry >= 2.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {string} stationSn - Resolved HomeBase station serial number.
 */
async function ensureStationReadyForP2pRetry(cam, stationSn) {
  if (cam.isFirstWakeAttempt() || cam.hasGotVideo()) {
    return;
  }
  if (cam.getRestartCount() >= 2 && !cam.hasHeardFromDeviceInSession()) {
    await recoverUnresponsiveStation(stationSn, 'p2p wake stalled (retry=' + cam.getRestartCount() + ')', true);
    return;
  }
  await ensureStationConnected(stationSn);
}

/**
 * Ensures rtspStream is enabled on initial wake and recovers disconnected stations or missing
 * rtspStreamUrl values on subsequent RTSP wake retries.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} mySession - Active RTSP session identifier.
 * @param {string} stationSn - Resolved HomeBase station serial number.
 */
async function prepareRtspWakeAttempt(cam, mySession, stationSn) {
  const serial = cam.getSerial();
  if (cam.isFirstWakeAttempt()) {
    if (!cam.hasRtspPropertyChecked() || !cam.getRtspUrl()) {
      await call({
        command: 'device.set_property',
        serialNumber: serial,
        name: 'rtspStream',
        value: true,
      });
    }
    return;
  }
  if (cam.hasGotVideo()) {
    return;
  }
  await ensureStationConnected(stationSn);
  if (cam.getRestartCount() === 1 && !cam.getRtspUrl() && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    log.debug(
      cam,
      'RTSP URL still empty on retry, toggling rtspStream (false -> true) to refresh HomeBase URL (session=' +
        mySession +
        ')'
    );
    await call({command: 'device.set_property', serialNumber: serial, name: 'rtspStream', value: false});
    await call({command: 'device.set_property', serialNumber: serial, name: 'rtspStream', value: true});
  }
}

/**
 * Queries device.get_properties when rtspStreamUrl is still empty after start_rtsp_livestream,
 * and recycles a wedged HomeBase station if a retry toggle still yielded no URL and no device activity.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} mySession - Active RTSP session identifier.
 * @param {string} stationSn - Resolved HomeBase station serial number.
 */
async function ensureRtspUrlAfterWakeStart(cam, mySession, stationSn) {
  const serial = cam.getSerial();
  if (!cam.getRtspUrl() && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    const propsRes = await call({command: 'device.get_properties', serialNumber: serial});
    if (propsRes.success && propsRes.result && propsRes.result.properties) {
      applyDeviceProperties(cam, propsRes.result.properties, false);
    }
  }
  if (
    cam.getRestartCount() < 1 ||
    cam.getRtspUrl() ||
    cam.hasHeardFromDeviceInSession() ||
    !cam.isCurrentSession(mySession, STREAM_MODES.RTSP)
  ) {
    return;
  }
  const recycled = await recoverUnresponsiveStation(stationSn, 'rtspStreamUrl empty after retry toggle', true);
  if (recycled && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    await call({command: 'device.set_property', serialNumber: serial, name: 'rtspStream', value: true});
    await call({command: 'device.start_rtsp_livestream', serialNumber: serial});
    const retryProps = await call({command: 'device.get_properties', serialNumber: serial});
    if (retryProps.success && retryProps.result && retryProps.result.properties) {
      applyDeviceProperties(cam, retryProps.result.properties, false);
    }
  }
}

/**
 * Refreshes device properties when 'rtsp livestream started' arrives before rtspStreamUrl is populated,
 * toggling rtspStream (false -> true) immediately if the HomeBase URL is still empty.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {number} mySession - Active RTSP session identifier.
 */
async function refreshMissingRtspUrlOnStart(cam, mySession) {
  const serial = cam.getSerial();
  const propsRes = await call({command: 'device.get_properties', serialNumber: serial});
  if (propsRes.success && propsRes.result && propsRes.result.properties) {
    applyDeviceProperties(cam, propsRes.result.properties, false);
  }
  if (cam.getRtspUrl() || !cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    return;
  }
  log.debug(
    cam,
    'RTSP URL still empty after RTSP livestream started, ' +
      'toggling rtspStream (false -> true) to refresh HomeBase URL (session=' +
      mySession +
      ')'
  );
  await call({command: 'device.set_property', serialNumber: serial, name: 'rtspStream', value: false});
  await call({command: 'device.set_property', serialNumber: serial, name: 'rtspStream', value: true});
  if (!cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    return;
  }
  const retryProps = await call({command: 'device.get_properties', serialNumber: serial});
  if (retryProps.success && retryProps.result && retryProps.result.properties) {
    applyDeviceProperties(cam, retryProps.result.properties, false);
  }
}

/**
 * Records an unresponsive camera wake timeout on stationSn and recycles zombie P2P sessions once threshold is reached.
 *
 * @param {string} stationSn - Station serial number.
 * @param {string} initiator - Timeout stop initiator string.
 */
async function recordStationWakeTimeout(stationSn, initiator) {
  if (!isWsReady() || !stationSn) {
    return;
  }
  const count = stations.get(stationSn).recordWakeTimeout();
  await recoverUnresponsiveStation(stationSn, initiator + ' x' + count, count >= ZOMBIE_STATION_TIMEOUT_THRESHOLD);
}

/**
 * Schedules a non-blocking periodic station.connect check after a HomeBase station emits 'close' or 'connection error'.
 *
 * @param {string} stationSn - Disconnected station serial number.
 */
function scheduleStationReconnect(stationSn) {
  if (!stationSn) {
    return;
  }
  stations.get(stationSn).scheduleReconnect(STATION_DISCONNECT_RETRY_MS, async () => {
    if (!isWsReady() || isShuttingDown()) {
      return;
    }
    await ensureStationConnected(stationSn);
    const checkRes = await call({command: 'station.is_connected', serialNumber: stationSn});
    if (isWsReady() && (!checkRes.success || (checkRes.result && checkRes.result.connected === false))) {
      scheduleStationReconnect(stationSn);
    }
  });
}

/**
 * Reconnects the eufy-security-ws cloud driver and recycles all known HomeBase stations after an RPC refresh timeout.
 *
 * @param {string} reason - Failure reason from driver.poll_refresh.
 */
async function recoverDriverAndStations(reason) {
  if (!isWsReady()) {
    return;
  }
  await call({command: 'driver.connect'});
  for (const stationSn of stations.collectKnownSerials(getCams())) {
    if (!isWsReady()) {
      return;
    }
    await recoverUnresponsiveStation(stationSn, reason, true);
  }
}

/**
 * Verifies driver and station connectivity from the start_listening snapshot on initial WebSocket handshake.
 *
 * @param {Record<string, *>} stateObj - State dictionary from start_listening.result.state.
 */
async function ensureInitialDriverAndStationsConnected(stateObj) {
  if (!isWsReady()) {
    return;
  }
  if (stateObj && stateObj.driver && stateObj.driver.connected === false) {
    log.warn('bridge', 'eufy-security-ws driver is disconnected on startup, sending driver.connect');
    await call({command: 'driver.connect'});
  } else {
    const drvRes = await call({command: 'driver.is_connected'});
    if (drvRes.success && drvRes.result && drvRes.result.connected === false) {
      log.warn('bridge', 'eufy-security-ws driver reported connected=false, sending driver.connect');
      await call({command: 'driver.connect'});
    }
  }

  /** @type {Set<string>} */
  const handledStations = new Set();
  const rawStations = (stateObj && Array.isArray(stateObj.stations) && stateObj.stations) || [];
  for (const entry of rawStations) {
    const sn = typeof entry === 'string' ? entry : entry && entry.serialNumber;
    if (!sn || typeof sn !== 'string') {
      continue;
    }
    stations.registerKnown(sn);
    if (typeof entry === 'object' && entry !== null && entry.connected === false) {
      handledStations.add(sn);
      updateStationHealth(sn, false);
      log.warn('bridge', 'HomeBase station (' + sn + ') is disconnected on startup, sending station.connect');
      const connRes = await call({command: 'station.connect', serialNumber: sn});
      if (connRes.success) {
        noteStationActivity(sn);
      } else {
        scheduleStationReconnect(sn);
      }
    }
  }

  for (const sn of stations.collectKnownSerials(getCams())) {
    if (!handledStations.has(sn)) {
      await ensureStationConnected(sn);
    }
  }
}

registerEufySubsystems({
  onEnsureInitialConnected: ensureInitialDriverAndStationsConnected,
  onRecoverDriverAndStations: recoverDriverAndStations,
});

module.exports = {
  isStationRecycling,
  updateStationHealth,
  noteStationActivity,
  recoverUnresponsiveStation,
  ensureStationReadyForP2pRetry,
  prepareRtspWakeAttempt,
  ensureRtspUrlAfterWakeStart,
  refreshMissingRtspUrlOnStart,
  recordStationWakeTimeout,
  scheduleStationReconnect,
};
