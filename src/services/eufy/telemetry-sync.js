// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Eufy device property serialization, Power Manager & streaming quality enforcement,
 * periodic battery/offline telemetry sync, and recognized person name extraction.
 */
'use strict';

const {FORWARD_FACE_NAMES, TELEMETRY_POLL_MS, sleep} = require('../../config');
const {log} = require('../../logger');
const {unwrapProperty} = require('../../domain/telemetry');
const {stations} = require('../../domain/station');
const {renderCameraCards} = require('../../overlay/card-renderer');
const {pushFrameToEncoder, stopEncoder, seedOfflineCameraSnapshot} = require('../../media/encoder');
const {startRtspDecoder} = require('../../media/decoder');
const {
  registerEufySubsystems,
  isWsReady,
  getCams,
  isShuttingDown,
  getOfflineStopCallback,
  getOnlineResumeCallback,
  getOpenWsSocket,
  markInitialTelemetryLoaded,
  invokeRecoverDriverAndStations,
  formatRpcError,
  call,
  ensureCameraEncodersStarted,
} = require('./ws-transport');

/** @typedef {import("../../domain/camera").Camera} Camera */

const POLL_REFRESH_SETTLE_MS = 2000;
const OFFLINE_POLL_REFRESH_COOLDOWN_MS = 300000;
const UNKNOWN_PERSON_PLACEHOLDER_REGEX = /^(?:unknown|stranger)$/i;

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

/** @type {Map<string, Promise<void>>} */
const propertySyncChains = new Map();
/** @type {Promise<void>|null} */
let telemetryFetchInFlight = null;
let activeFetchForced = false;
let pendingForcedFetch = false;
/** @type {number|null} */
let lastPollRefreshAt = null;

/**
 * Clears per-device property serialization chains and poll-refresh cooldown state when the WebSocket resets.
 */
function resetPropertySyncChains() {
  propertySyncChains.clear();
  lastPollRefreshAt = null;
  pendingForcedFetch = false;
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
 * Sends a device.set_property RPC command for a camera serialized per device serial so
 * HomeBase does not drop concurrent P2P CMD_SET_PAYLOAD writes on initial mode sync.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} name - Eufy property name.
 * @param {*} value - Target property value.
 */
function setCameraProperty(cam, name, value) {
  const targetWs = getOpenWsSocket();
  if (!targetWs) {
    return;
  }
  const serial = cam.getSerial();
  const prev = propertySyncChains.get(serial) || Promise.resolve();
  const next = prev
    .catch(() => {
      // Keep the per-camera property serialization chain alive after any prior failure.
    })
    .then(async () => {
      if (getOpenWsSocket() !== targetWs) {
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
          res.errorCode === 'device_invalid_property_value' || res.errorCode === 'device_invalid_property'
            ? log.debug
            : log.warn;
        logFn(cam, 'could not set ' + name + ': ' + formatRpcError(res));
        return;
      }
      if (name === 'rtspStream' && value === true && !cam.getRtspUrl()) {
        const propsRes = await call({command: 'device.get_properties', serialNumber: serial});
        if (propsRes.success && propsRes.result && propsRes.result.properties) {
          const p = propsRes.result.properties;
          syncCameraRtspProperties(cam, {
            stationSn: unwrapProperty(p.stationSerialNumber),
            rtspUrlProp: unwrapProperty(p.rtspStreamUrl),
            rtspStreamProp: unwrapProperty(p.rtspStream),
          });
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
      'syncing Eufy hardware property ' + upd.name + ' (' + (upd.currentValue ?? 'n/a') + ' -> ' + upd.targetValue + ')'
    );
    setCameraProperty(cam, upd.name, upd.targetValue);
  }
}

/**
 * Applies RTSP URL discovery and automatic rtspStream property enabling/disabling from device properties.
 *
 * @param {Camera} cam - Camera state object.
 * @param {{stationSn: *, rtspUrlProp: *, rtspStreamProp: *}} rtspProps - Unwrapped RTSP property values.
 */
function syncCameraRtspProperties(cam, rtspProps) {
  const {stationSn, rtspUrlProp, rtspStreamProp} = rtspProps;
  stations.registerKnown(stationSn);
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
  syncCameraRtspProperties(cam, {
    stationSn: unwrapProperty(props.stationSerialNumber),
    rtspUrlProp: unwrapProperty(props.rtspStreamUrl),
    rtspStreamProp: unwrapProperty(props.rtspStream),
  });
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

  const onOfflineStop = getOfflineStopCallback();
  const onOnlineResume = getOnlineResumeCallback();
  if (cam.isDeviceOffline()) {
    if (cam.isSessionActive() && onOfflineStop) {
      onOfflineStop(cam);
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
  if ((cam.shouldResumeOfflineEncoder() || !cam.hasEncoderProcess()) && onOnlineResume) {
    onOnlineResume(cam);
  }
}

/**
 * Returns true if the 5-minute unforced offline HomeBase poll_refresh cooldown has elapsed.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean}
 */
function isOfflinePollRefreshDue(now) {
  return lastPollRefreshAt === null ? true : now - lastPollRefreshAt >= OFFLINE_POLL_REFRESH_COOLDOWN_MS;
}

/**
 * Returns true if HomeBase should run driver.poll_refresh before querying device.get_properties.
 *
 * @param {Camera[]} eufyCams - Configured non-direct Eufy cameras.
 * @param {boolean} forceRefresh - Explicit forced refresh flag.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean}
 */
function shouldPollRefreshHomeBase(eufyCams, forceRefresh, now) {
  if (eufyCams.length === 0) {
    return false;
  }
  return forceRefresh ? true : eufyCams.some((c) => c.isDeviceOffline()) && isOfflinePollRefreshDue(now);
}

/**
 * Executes one serialized HomeBase poll_refresh (when due) and per-camera device.get_properties pass.
 *
 * @param {boolean} forceRefresh - Whether to force driver.poll_refresh regardless of cooldown.
 */
async function runTelemetryFetchPass(forceRefresh) {
  ensureCameraEncodersStarted({rtspDirectOnly: true});
  if (!isWsReady()) {
    return;
  }
  const eufyCams = getCams().filter((c) => !c.isRtspDirect());
  const refreshNow = Date.now();
  const shouldRefreshHomeBase = shouldPollRefreshHomeBase(eufyCams, forceRefresh, refreshNow);
  const onOnlineResume = getOnlineResumeCallback();
  if (shouldRefreshHomeBase) {
    lastPollRefreshAt = refreshNow;
    log.debug('bridge', 'polling HomeBase via driver.poll_refresh for fresh battery telemetry');
    const pollRes = await call({command: 'driver.poll_refresh'});
    if (!pollRes.success) {
      const pollErr = formatRpcError(pollRes);
      log.warn(
        'bridge',
        'driver.poll_refresh failed (errorCode=' + pollErr + '), reconnecting eufy-security-ws driver and stations'
      );
      await invokeRecoverDriverAndStations('driver.poll_refresh ' + pollErr);
      for (const cam of eufyCams) {
        if (!cam.isDeviceOffline() && !cam.hasEncoderProcess() && onOnlineResume) {
          onOnlineResume(cam);
        }
      }
      return;
    }
    await sleep(POLL_REFRESH_SETTLE_MS);
  }
  for (const cam of eufyCams) {
    if (!isWsReady()) {
      return;
    }
    const res = await call({command: 'device.get_properties', serialNumber: cam.getSerial()});
    if (res.success && res.result && res.result.properties) {
      applyDeviceProperties(cam, res.result.properties);
    } else if (!res.success) {
      log.warn(cam, 'device.get_properties failed: ' + formatRpcError(res));
      if (!cam.isDeviceOffline() && !cam.hasEncoderProcess() && onOnlineResume) {
        onOnlineResume(cam);
      }
    }
  }
  markInitialTelemetryLoaded();
}

/**
 * Queries device.get_properties for all configured cameras so battery, charging/power mode,
 * Wi-Fi signal/RSSI, temperature, and streaming quality are populated on API schema 13+.
 * Concurrent callers coalesce onto the active pass; a forced request arriving during an
 * unforced pass schedules one forced follow-up pass before resolving.
 *
 * @param {boolean} [forceRefresh=false] - Whether to force a driver.poll_refresh before reading properties.
 * @returns {Promise<void>}
 */
function fetchAllCameraTelemetry(forceRefresh = false) {
  const wantForce = Boolean(forceRefresh);
  if (telemetryFetchInFlight) {
    if (wantForce && !activeFetchForced) {
      pendingForcedFetch = true;
    }
    return telemetryFetchInFlight;
  }
  telemetryFetchInFlight = (async () => {
    try {
      let runForced = wantForce;
      for (;;) {
        activeFetchForced = runForced;
        pendingForcedFetch = false;
        await runTelemetryFetchPass(runForced);
        if (!pendingForcedFetch || !isWsReady() || isShuttingDown()) {
          break;
        }
        runForced = true;
      }
    } finally {
      telemetryFetchInFlight = null;
      activeFetchForced = false;
      pendingForcedFetch = false;
    }
  })();
  return telemetryFetchInFlight;
}

/** @type {ReturnType<typeof setInterval>|null} */
let telemetryPollTimer = null;

/**
 * Stops the periodic background telemetry refresh timer when shutting down or resetting tests.
 */
function stopTelemetryPoller() {
  if (telemetryPollTimer) {
    clearInterval(telemetryPollTimer);
    telemetryPollTimer = null;
  }
}

/**
 * Starts the periodic background telemetry refresh timer if telemetry_poll_secs > 0.
 */
function startTelemetryPoller() {
  stopTelemetryPoller();
  if (TELEMETRY_POLL_MS > 0) {
    const runTelemetryRefresh = () => {
      if (isWsReady() && !isShuttingDown()) {
        void fetchAllCameraTelemetry(false);
      }
    };
    telemetryPollTimer = setInterval(runTelemetryRefresh, TELEMETRY_POLL_MS);
    if (telemetryPollTimer && typeof telemetryPollTimer.unref === 'function') {
      telemetryPollTimer.unref();
    }
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

registerEufySubsystems({
  onFetchAllTelemetry: fetchAllCameraTelemetry,
  onApplyDeviceProperties: applyDeviceProperties,
  onResetPropertyChains: resetPropertySyncChains,
});

module.exports = {
  isTrackedPropertyEvent,
  resolvePropertyTriggerEvent,
  setCameraProperty,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  startTelemetryPoller,
  stopTelemetryPoller,
  extractRecognizedPerson,
};
