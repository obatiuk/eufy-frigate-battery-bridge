// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * eufy-security-ws WebSocket RPC client, schema negotiation, device telemetry
 * synchronization, streaming quality enforcement, and battery swap polling.
 */
'use strict';

const {
  cfg,
  FORWARD_FACE_NAMES,
  STREAM_MODES,
  TELEMETRY_POLL_MS,
  sleep,
} = require('../config');
const {log} = require('../logger');
const {unwrapProperty} = require('../domain/telemetry');
const {renderCameraCards} = require('../overlay/card-renderer');
const {pushFrameToEncoder, stopEncoder, seedOfflineCameraSnapshot} = require('../media/encoder');
const {startRtspDecoder} = require('../media/decoder');

const WS_OPEN = 1;
const WS_RPC_TIMEOUT_MS = 20000;
const WS_RECONNECT_DELAY_MS = 10000;
const INITIAL_TELEMETRY_RETRY_MS = 10000;
const POLL_REFRESH_SETTLE_MS = 2000;
const STATION_RECOVERY_COOLDOWN_MS = 60000;
const STATION_DISCONNECT_RETRY_MS = 10000;
const ZOMBIE_STATION_TIMEOUT_THRESHOLD = 1;
/** @typedef {import("../domain/camera").Camera} Camera */

const MAX_SUPPORTED_API_SCHEMA = 21;
const UNKNOWN_PERSON_PLACEHOLDER_REGEX = /^(?:unknown|stranger)$/i;
let WebSocketCtor = null;

/**
 * Lazily loads the 'ws' WebSocket constructor (or returns an injected constructor).
 *
 * @returns {any}
 */
function getWebSocketConstructor() {
  if (!WebSocketCtor) {
    WebSocketCtor = require('ws');
  }
  return WebSocketCtor;
}

const TRACKED_PROPERTY_NAMES = new Set([
  'state',
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
  'powerWorkingMode',
  'recordingClipLength',
  'recordingEndClipMotionStops',
  'recordingRetriggerInterval',
  'rtspStream',
  'rtspStreamUrl',
  'light',
]);

/**
 * Maps Eufy boolean detection property names emitted via 'property changed' events
 * to their canonical Eufy trigger event names.
 *
 * @type {Readonly<Record<string, string>>}
 */
const DETECTION_PROPERTY_EVENT_MAP = Object.freeze({
  motionDetected: 'motion detected',
  radarMotionDetected: 'radar motion detected',
  personDetected: 'person detected',
  loiteringDetected: 'someone loitering',
  someoneLoitering: 'someone loitering',
  packageDelivered: 'package delivered',
  packageStranded: 'package stranded',
  packageTaken: 'package taken',
  petDetected: 'pet detected',
  vehicleDetected: 'vehicle detected',
  dogDetected: 'dog detected',
  dogLickDetected: 'dog lick detected',
  dogPoopDetected: 'dog poop detected',
  strangerPersonDetected: 'stranger person detected',
  identityPersonDetected: 'identity person detected',
  soundDetected: 'sound detected',
  cryingDetected: 'crying detected',
  ringing: 'rings',
});

let ws = null;
let wsReady = false;
let wsReadyAt = 0;
let initialTelemetryLoaded = false;
let seq = 0;
const waiting = new Map();
/** @type {Set<string>} */
const knownStationSerials = new Set();
/** @type {Set<string>} */
const recyclingStations = new Set();
/** @type {Map<string, number>} */
const stationUnresponsiveTimeouts = new Map();
/** @type {Map<string, number>} */
const stationLastRecoveryAt = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const stationReconnectTimers = new Map();

/** @type {Camera[]} */
let camsRef = [];
/** @type {Map<string, Camera>} */
let bySerialRef = new Map();
let isShuttingDownFn = () => false;
let onEventCallback = null;
let onWsClosedStopCallback = null;
let onDeviceOfflineStopCallback = null;
let onDeviceOnlineResumeCallback = null;
let onInitialTelemetryCallback = null;

/**
 * Configures runtime references and lifecycle callbacks for the Eufy WebSocket client.
 *
 * @param {Record<string, *>} hooks - Client wiring options.
 */
function configureEufyClientHooks(hooks = {}) {
  if (Array.isArray(hooks.cams)) camsRef = hooks.cams;
  if (hooks.bySerial instanceof Map) bySerialRef = hooks.bySerial;
  if (typeof hooks.wsReadyAt === 'number') wsReadyAt = hooks.wsReadyAt;
  if (typeof hooks.isShuttingDown === 'function') isShuttingDownFn = hooks.isShuttingDown;
  if (typeof hooks.onEvent === 'function') onEventCallback = hooks.onEvent;
  if (typeof hooks.onWsClosedStop === 'function') onWsClosedStopCallback = hooks.onWsClosedStop;
  if (typeof hooks.onDeviceOfflineStop === 'function') {
    onDeviceOfflineStopCallback = hooks.onDeviceOfflineStop;
  }
  if (typeof hooks.onDeviceOnlineResume === 'function') {
    onDeviceOnlineResumeCallback = hooks.onDeviceOnlineResume;
  }
  if (typeof hooks.onInitialTelemetryLoaded === 'function') {
    onInitialTelemetryCallback = hooks.onInitialTelemetryLoaded;
  }
  if (typeof hooks.WebSocket === 'function') {
    WebSocketCtor = hooks.WebSocket;
  }
}

const isWsReady = () => wsReady;

/**
 * Returns true when the WebSocket connection has been open and settled for at least settleMs.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} settleMs - Required post-connect settle window in milliseconds.
 * @returns {boolean}
 */
function isWsSettledForEvents(now, settleMs) {
  return wsReady && now - wsReadyAt > settleMs;
}

/**
 * Returns true when the WebSocket connection is ready, initial telemetry has loaded,
 * and the post-connect startup probe delay has elapsed.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} readyDelayMs - Required post-connect delay before startup probes.
 * @returns {boolean}
 */
function canRunStartupProbeNow(now, readyDelayMs) {
  return wsReady && initialTelemetryLoaded && now - wsReadyAt > readyDelayMs;
}

/**
 * Returns true if a Eufy 'property changed' event name is tracked by the bridge.
 *
 * @param {string} propName - Property name from Eufy event.
 * @returns {boolean}
 */
function isTrackedPropertyEvent(propName) {
  return TRACKED_PROPERTY_NAMES.has(propName);
}

/**
 * Resolves a Eufy boolean detection property name (from a 'property changed' event)
 * to its canonical Eufy trigger event string, or returns an empty string if not a detection property.
 *
 * @param {string} propName - Property name from Eufy 'property changed' event.
 * @returns {string}
 */
function resolvePropertyTriggerEvent(propName) {
  return DETECTION_PROPERTY_EVENT_MAP[String(propName || '')] || '';
}

/**
 * Sends a command object to eufy-security-ws over WebSocket and resolves with the response message.
 *
 * @param {Record<string, *>} commandPayload - Command fields to send alongside the generated messageId.
 * @returns {Promise<Record<string, *>>} Response object from eufy-security-ws.
 */
function call(commandPayload) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WS_OPEN) {
      return resolve({success: false, errorCode: 'ws_closed'});
    }
    const id = 'b' + ++seq;
    const timer = setTimeout(() => {
      if (waiting.delete(id)) {
        resolve({success: false, errorCode: 'no_reply'});
      }
    }, WS_RPC_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    waiting.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    ws.send(JSON.stringify({messageId: id, ...commandPayload}), (err) => {
      if (err && waiting.delete(id)) {
        clearTimeout(timer);
        resolve({success: false, errorCode: err.message});
      }
    });
  });
}

/** @type {Map<string, Promise<void>>} */
const propertySyncChains = new Map();

/**
 * Sends a device.set_property RPC command for a camera serialized per device serial so
 * HomeBase does not drop concurrent P2P CMD_SET_PAYLOAD writes on initial mode sync.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} name - Eufy property name.
 * @param {*} value - Target property value.
 */
function setCameraProperty(cam, name, value) {
  const targetWs = ws;
  if (!targetWs || targetWs.readyState !== WS_OPEN) {
    return;
  }
  const serial = cam.getSerial();
  const prev = propertySyncChains.get(serial) || Promise.resolve();
  const next = prev
      .catch(() => {})
      .then(async () => {
        if (ws !== targetWs || !ws || ws.readyState !== WS_OPEN) {
          return;
        }
        const res = await call({
          command: 'device.set_property',
          serialNumber: serial,
          name,
          value,
        });
        if (!res.success) {
          const logFn =
              res.errorCode === 'device_invalid_property_value' ||
              res.errorCode === 'device_invalid_property'
                  ? log.debug
                  : log.warn;
          logFn(cam, 'could not set ' + name + ': ' + (res.errorCode || 'unknown'));
          return;
        }
        if (name === 'rtspStream' && value === true && !cam.getRtspUrl()) {
          const propsRes = await call({command: 'device.get_properties', serialNumber: serial});
          if (propsRes.success && propsRes.result && propsRes.result.properties) {
            const p = propsRes.result.properties;
            syncCameraRtspProperties(
                cam,
                unwrapProperty(p.stationSerialNumber),
                unwrapProperty(p.rtspStreamUrl),
                unwrapProperty(p.rtspStream)
            );
          }
        }
      });
  propertySyncChains.set(serial, next);
}

/**
 * Checks the camera's videoStreamingQuality property and, if enforce_streaming_quality is enabled,
 * automatically switches cameras configured as "Auto" (0) to Medium (7, 1280x720) so P2P streams
 * do not negotiate 4K and stall.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties.
 */
function checkStreamingQuality(cam, props) {
  const {shouldUpdate, currentQuality, targetQuality} = cam.evaluateQualityChange(props);
  if (shouldUpdate) {
    log.info(
        cam,
        'videoStreamingQuality is ' +
        currentQuality +
        ' (' +
        (currentQuality === 0 ? 'Auto' : 'High/4K') +
        '), setting to ' +
        targetQuality +
        ' (Medium 720p) to prevent P2P stalls'
    );
    setCameraProperty(cam, 'videoStreamingQuality', targetQuality);
  }
}

/**
 * Checks the camera's Eufy Power Manager recording properties and applies any configured
 * per-camera overrides (powerWorkingMode, recordingClipLength, recordingEndClipMotionStops,
 * recordingRetriggerInterval) via eufy-security-ws on initial property sync.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties.
 */
function checkHardwareRecordingSettings(cam, props) {
  const updates = cam.evaluateRecordingModeChanges(props);
  for (const upd of updates) {
    log.info(
        cam,
        'syncing Eufy hardware property ' +
        upd.name +
        ' (' +
        (upd.currentValue ?? 'n/a') +
        ' -> ' +
        upd.targetValue +
        ')'
    );
    setCameraProperty(cam, upd.name, upd.targetValue);
  }
}

/**
 * Clears cached per-station recovery counters and pending reconnect timers when the WebSocket resets.
 */
function clearStationRecoveryState() {
  knownStationSerials.clear();
  recyclingStations.clear();
  stationUnresponsiveTimeouts.clear();
  stationLastRecoveryAt.clear();
  for (const timer of stationReconnectTimers.values()) {
    clearTimeout(timer);
  }
  stationReconnectTimers.clear();
}

/**
 * Returns true while recoverUnresponsiveStation is actively recycling stationSn via station.disconnect -> station.connect.
 *
 * @param {string} stationSn - Station serial number.
 * @returns {boolean}
 */
function isStationRecycling(stationSn) {
  return Boolean(stationSn && recyclingStations.has(stationSn));
}

/**
 * Registers a discovered HomeBase or standalone station serial for P2P health tracking.
 *
 * @param {*} stationSn - Candidate station serial number.
 */
function registerStationSerial(stationSn) {
  if (stationSn && typeof stationSn === 'string') {
    knownStationSerials.add(stationSn);
  }
}

/**
 * Collects all known station serial numbers across start_listening state and configured cameras.
 *
 * @returns {string[]}
 */
function collectKnownStationSerials() {
  for (const cam of camsRef) {
    if (cam.stationSerial) {
      knownStationSerials.add(cam.stationSerial);
    }
  }
  return Array.from(knownStationSerials);
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
  for (const cam of camsRef) {
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
  registerStationSerial(stationSn);
  stationUnresponsiveTimeouts.delete(stationSn);
  const timer = stationReconnectTimers.get(stationSn);
  if (timer) {
    clearTimeout(timer);
    stationReconnectTimers.delete(stationSn);
  }
  updateStationHealth(stationSn, true);
}

/**
 * Recovers a disconnected or zombie HomeBase station P2P session in eufy-security-ws.
 *
 * @param {string} stationSn - Target station serial number.
 * @param {string} reason - Diagnostic reason for recovery.
 * @param {boolean} [forceRecycle=false] - Whether to recycle via station.disconnect -> station.connect even when station.is_connected reports true.
 * @returns {Promise<boolean>} True if a station reconnect or recycle command was dispatched.
 */
async function recoverUnresponsiveStation(stationSn, reason, forceRecycle = false) {
  if (!wsReady || !stationSn) {
    return false;
  }
  registerStationSerial(stationSn);
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
    }
    return true;
  }
  if (!forceRecycle) {
    return false;
  }

  const now = Date.now();
  const lastRecAt = stationLastRecoveryAt.get(stationSn) || 0;
  const hasActiveVideo = camsRef.some(
      (c) => c.isOnStation(stationSn) && c.isSessionActive() && c.gotVideo
  );
  if (hasActiveVideo || (lastRecAt > 0 && now - lastRecAt < STATION_RECOVERY_COOLDOWN_MS)) {
    return false;
  }

  stationLastRecoveryAt.set(stationSn, now);
  stationUnresponsiveTimeouts.delete(stationSn);
  for (const c of camsRef) {
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
  recyclingStations.add(stationSn);
  try {
    await call({command: 'station.disconnect', serialNumber: stationSn});
    const connRes = await call({command: 'station.connect', serialNumber: stationSn});
    if (connRes.success) {
      noteStationActivity(stationSn);
    }
  } finally {
    recyclingStations.delete(stationSn);
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
  if (!wsReady || !stationSn) {
    return false;
  }
  registerStationSerial(stationSn);
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
  if (cam.isFirstWakeAttempt() || cam.gotVideo) {
    return;
  }
  if (cam.restarts >= 2 && !cam.heardFromDeviceInSession) {
    await recoverUnresponsiveStation(
        stationSn,
        'p2p wake stalled (retry=' + cam.restarts + ')',
        true
    );
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
    if (!cam.rtspEnabledChecked || !cam.getRtspUrl()) {
      await call({
        command: 'device.set_property',
        serialNumber: serial,
        name: 'rtspStream',
        value: true,
      });
    }
    return;
  }
  if (cam.gotVideo) {
    return;
  }
  await ensureStationConnected(stationSn);
  if (cam.restarts === 1 && !cam.getRtspUrl() && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
    log.info(
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
      cam.restarts < 1 ||
      cam.getRtspUrl() ||
      cam.heardFromDeviceInSession ||
      !cam.isCurrentSession(mySession, STREAM_MODES.RTSP)
  ) {
    return;
  }
  const recycled = await recoverUnresponsiveStation(
      stationSn,
      'rtspStreamUrl empty after retry toggle',
      true
  );
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
  log.info(
      cam,
      'RTSP URL still empty after RTSP livestream started, toggling rtspStream (false -> true) to refresh HomeBase URL (session=' +
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
  if (!wsReady || !stationSn) {
    return;
  }
  const count = (stationUnresponsiveTimeouts.get(stationSn) || 0) + 1;
  stationUnresponsiveTimeouts.set(stationSn, count);
  await recoverUnresponsiveStation(
      stationSn,
      initiator + ' x' + count,
      count >= ZOMBIE_STATION_TIMEOUT_THRESHOLD
  );
}

/**
 * Schedules a non-blocking periodic station.connect check after a HomeBase station emits 'close' or 'connection error'.
 *
 * @param {string} stationSn - Disconnected station serial number.
 */
function scheduleStationReconnect(stationSn) {
  if (!stationSn || stationReconnectTimers.has(stationSn)) {
    return;
  }
  const timer = setTimeout(async () => {
    stationReconnectTimers.delete(stationSn);
    if (!wsReady || isShuttingDownFn()) {
      return;
    }
    await ensureStationConnected(stationSn);
    const checkRes = await call({command: 'station.is_connected', serialNumber: stationSn});
    if (wsReady && checkRes.success && checkRes.result && checkRes.result.connected === false) {
      scheduleStationReconnect(stationSn);
    }
  }, STATION_DISCONNECT_RETRY_MS);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  stationReconnectTimers.set(stationSn, timer);
}

/**
 * Reconnects the eufy-security-ws cloud driver and recycles all known HomeBase stations after an RPC refresh timeout.
 *
 * @param {string} reason - Failure reason from driver.poll_refresh.
 */
async function recoverDriverAndStations(reason) {
  if (!wsReady) {
    return;
  }
  await call({command: 'driver.connect'});
  for (const stationSn of collectKnownStationSerials()) {
    if (!wsReady) {
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
  if (!wsReady) {
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
    registerStationSerial(sn);
    if (typeof entry === 'object' && entry !== null && entry.connected === false) {
      handledStations.add(sn);
      log.warn('bridge', 'HomeBase station (' + sn + ') is disconnected on startup, sending station.connect');
      const connRes = await call({command: 'station.connect', serialNumber: sn});
      if (connRes.success) {
        noteStationActivity(sn);
      }
    }
  }

  for (const sn of collectKnownStationSerials()) {
    if (!handledStations.has(sn)) {
      await ensureStationConnected(sn);
    }
  }
}

/**
 * Applies RTSP URL discovery and automatic rtspStream property enabling/disabling from device properties.
 *
 * @param {Camera} cam - Camera state object.
 * @param {*} stationSn - Unwrapped stationSerialNumber.
 * @param {*} rtspUrlProp - Unwrapped rtspStreamUrl.
 * @param {*} rtspStreamProp - Unwrapped rtspStream boolean.
 */
function syncCameraRtspProperties(cam, stationSn, rtspUrlProp, rtspStreamProp) {
  registerStationSerial(stationSn);
  if (cam.updateDiscoveredRtspConfig(stationSn, rtspUrlProp)) {
    log.info(cam, 'discovered HomeBase RTSP URL (' + cam.getMaskedRtspUrl() + ')');
    if (cam.canSpawnRtspDecoder()) {
      startRtspDecoder(cam);
    }
  }
  if (cam.shouldEnableRtspProperty(rtspStreamProp)) {
    log.info(cam, 'enabling HomeBase RTSP stream (rtspStream=true) via eufy-security-ws');
    setCameraProperty(cam, 'rtspStream', true);
  } else if (cam.shouldDisableRtspProperty(rtspStreamProp)) {
    log.info(cam, 'disabling HomeBase RTSP stream (rtspStream=false) via eufy-security-ws');
    setCameraProperty(cam, 'rtspStream', false);
  }
}

/**
 * Applies device telemetry properties from eufy-security-ws to a camera's Telemetry domain model.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties or start_listening.
 * @param {boolean} [allowCardRebuild=!cam.hasBatteryReading()] - Whether to re-render the sleeping card immediately.
 */
function applyDeviceProperties(cam, props, allowCardRebuild = !cam.hasBatteryReading()) {
  if (!props || typeof props !== 'object') {
    return;
  }

  checkStreamingQuality(cam, props);
  checkHardwareRecordingSettings(cam, props);
  syncCameraRtspProperties(
      cam,
      unwrapProperty(props.stationSerialNumber),
      unwrapProperty(props.rtspStreamUrl),
      unwrapProperty(props.rtspStream)
  );
  const outcome = cam.applyTelemetryProperties(props, allowCardRebuild);
  switch (outcome.logLevel) {
    case 'warn':
      log.warn(cam, outcome.logMsg);
      break;
    case 'info':
      log.info(cam, outcome.logMsg);
      break;
    case 'debug':
      log.debug(cam, outcome.logMsg);
      break;
    default:
      break;
  }

  if (cam.isDeviceOffline()) {
    if (cam.isSessionActive() && onDeviceOfflineStopCallback) {
      onDeviceOfflineStopCallback(cam);
      return;
    }
    if (!outcome.hadInitialTelemetry) {
      if (outcome.shouldRebuildCard && cam.hasOfflineSnapshotToSeed()) {
        renderCameraCards(cam);
      }
      seedOfflineCameraSnapshot(cam);
      return;
    }
    if (!cam.isSeedingOfflineSnapshot()) {
      stopEncoder(cam);
    }
    return;
  }

  if (outcome.shouldRebuildCard) {
    renderCameraCards(cam);
    if (!cam.isBackfillPlayback()) {
      pushFrameToEncoder(cam);
    }
  }
  if ((cam.shouldResumeOfflineEncoder() || !cam.hasEncoderProcess()) && onDeviceOnlineResumeCallback) {
    onDeviceOnlineResumeCallback(cam);
  }
}

/**
 * Queries device.get_properties for all configured cameras so battery, charging/power mode,
 * Wi-Fi signal/RSSI, temperature, and streaming quality are populated on API schema 13+.
 *
 * @param {boolean} [forceRefresh=false] - Whether to force a driver.poll_refresh before reading properties.
 */
async function fetchAllCameraTelemetry(forceRefresh = false) {
  if (!wsReady) {
    return;
  }
  const shouldRefreshHomeBase = forceRefresh || camsRef.some((c) => c.isDeviceOffline());
  if (shouldRefreshHomeBase) {
    log.debug('bridge', 'polling HomeBase via driver.poll_refresh for fresh battery telemetry');
    const pollRes = await call({command: 'driver.poll_refresh'});
    if (!pollRes.success) {
      log.warn(
          'bridge',
          'driver.poll_refresh failed (errorCode=' +
          (pollRes.errorCode || 'unknown') +
          '), reconnecting eufy-security-ws driver and stations'
      );
      await recoverDriverAndStations('driver.poll_refresh ' + (pollRes.errorCode || 'failed'));
      return;
    }
    await sleep(POLL_REFRESH_SETTLE_MS);
  }
  for (const cam of camsRef) {
    if (!wsReady) {
      return;
    }
    const res = await call({command: 'device.get_properties', serialNumber: cam.getSerial()});
    if (res.success && res.result && res.result.properties) {
      applyDeviceProperties(cam, res.result.properties);
    } else if (!res.success) {
      log.warn(cam, 'device.get_properties failed: ' + (res.errorCode || 'unknown'));
      if (!cam.isDeviceOffline() && !cam.hasEncoderProcess() && onDeviceOnlineResumeCallback) {
        onDeviceOnlineResumeCallback(cam);
      }
    }
  }
  if (!initialTelemetryLoaded) {
    initialTelemetryLoaded = true;
    if (onInitialTelemetryCallback) {
      onInitialTelemetryCallback();
    }
  }
}

/**
 * Handles the initial 'version' message from eufy-security-ws by negotiating schema version
 * and starting event listening.
 *
 * @param {Record<string, *>} m - Parsed 'version' message from eufy-security-ws.
 */
async function handleVersionMessage(m) {
  const targetSchema = Math.min(m.maxSchemaVersion, MAX_SUPPORTED_API_SCHEMA);
  await call({command: 'set_api_schema', schemaVersion: targetSchema});
  const st = await call({command: 'start_listening'});
  wsReady = Boolean(st.success);
  wsReadyAt = Date.now();
  for (const c of camsRef) {
    if (c.updateServiceHealth({wsConnected: wsReady})) {
      renderCameraCards(c);
      pushFrameToEncoder(c);
    }
  }

  if (!wsReady) {
    log.error('bridge', 'start_listening failed: ' + (st.errorCode || 'unknown'));
    return;
  }

  log.info('bridge', 'listening for eufy events (apiSchema=' + targetSchema + ')');
  const stateSnapshot = (st.result && st.result.state) || {};
  await ensureInitialDriverAndStationsConnected(stateSnapshot);
  await fetchAllCameraTelemetry();
  const devices = stateSnapshot.devices || [];
  for (const dev of devices) {
    if (dev && typeof dev === 'object' && dev.serialNumber) {
      const cam = bySerialRef.get(dev.serialNumber);
      if (cam && !cam.hasBatteryReading() && !cam.isDeviceOffline()) {
        applyDeviceProperties(cam, dev, true);
      }
    }
  }
  setTimeout(() => {
    if (wsReady && camsRef.some((c) => !c.hasBatteryReading())) {
      void fetchAllCameraTelemetry();
    }
  }, INITIAL_TELEMETRY_RETRY_MS).unref();
}

/**
 * Establishes and maintains the WebSocket connection to eufy-security-ws.
 */
function connectWs() {
  if (isShuttingDownFn()) {
    return;
  }
  clearStationRecoveryState();
  propertySyncChains.clear();
  for (const [id, resolve] of waiting) {
    waiting.delete(id);
    resolve({success: false, errorCode: 'ws_closed'});
  }
  const WebSocket = getWebSocketConstructor();
  ws = new WebSocket(cfg.eufy_security_ws_url);

  ws.on('open', () => log.info('bridge', 'eufy-security-ws connected (' + cfg.eufy_security_ws_url + ')'));

  ws.on('close', () => {
    wsReady = false;
    initialTelemetryLoaded = false;
    clearStationRecoveryState();
    propertySyncChains.clear();
    for (const [id, resolve] of waiting) {
      waiting.delete(id);
      resolve({success: false, errorCode: 'ws_closed'});
    }
    log.warn('bridge', 'eufy-security-ws connection closed, retrying in 10 s');
    for (const c of camsRef) {
      const healthChanged = c.updateServiceHealth({wsConnected: false});
      if (c.handleStationDisconnected('ws_closed') && onWsClosedStopCallback) {
        onWsClosedStopCallback(c);
      } else if (healthChanged) {
        renderCameraCards(c);
        pushFrameToEncoder(c);
      }
    }
    if (!isShuttingDownFn()) {
      setTimeout(connectWs, WS_RECONNECT_DELAY_MS);
    }
  });

  ws.on('error', (e) => log.error('bridge', 'eufy-security-ws error: ' + e.message));

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch (err) {
      return;
    }

    switch (m.type) {
      case 'version':
        await handleVersionMessage(m);
        break;
      case 'result':
        if (m.messageId) {
          const r = waiting.get(m.messageId);
          if (r) {
            waiting.delete(m.messageId);
            r(m);
          }
        }
        break;
      case 'event':
        if (onEventCallback) {
          try {
            onEventCallback(m.event || {});
          } catch (err) {
            log.error('bridge', 'unhandled error in onEvent: ' + err.message);
          }
        }
        break;
      default:
        break;
    }
  });
}

/**
 * Starts the periodic background telemetry refresh timer if telemetry_poll_secs > 0.
 */
function startTelemetryPoller() {
  if (TELEMETRY_POLL_MS > 0) {
    setInterval(() => {
      if (wsReady && !isShuttingDownFn()) {
        void fetchAllCameraTelemetry(false);
      }
    }, TELEMETRY_POLL_MS);
  }
}

/**
 * Extracts a recognized person's name from an Eufy event payload (such as 'identity person detected'
 * on HomeBase 3) when forward_face_names is enabled.
 *
 * @param {Record<string, *>} e - Event object from eufy-security-ws.
 * @param {boolean} [forwardEnabled=FORWARD_FACE_NAMES] - Whether face name forwarding is enabled.
 * @returns {string} Recognized person name, or empty string if unknown/disabled.
 */
function extractRecognizedPerson(e, forwardEnabled = FORWARD_FACE_NAMES) {
  if (!forwardEnabled || !e) {
    return '';
  }
  const rawName = e.person || e.personName || '';
  if (typeof rawName !== 'string') {
    return '';
  }
  const cleaned = rawName.trim();
  if (!cleaned || UNKNOWN_PERSON_PLACEHOLDER_REGEX.test(cleaned)) {
    return '';
  }
  return cleaned;
}

module.exports = {
  configureEufyClientHooks,
  isWsReady,
  isWsSettledForEvents,
  canRunStartupProbeNow,
  isTrackedPropertyEvent,
  resolvePropertyTriggerEvent,
  call,
  setCameraProperty,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  ensureStationReadyForP2pRetry,
  prepareRtspWakeAttempt,
  ensureRtspUrlAfterWakeStart,
  refreshMissingRtspUrlOnStart,
  isStationRecycling,
  recoverUnresponsiveStation,
  recordStationWakeTimeout,
  noteStationActivity,
  scheduleStationReconnect,
  updateStationHealth,
  connectWs,
  startTelemetryPoller,
  extractRecognizedPerson,
};
