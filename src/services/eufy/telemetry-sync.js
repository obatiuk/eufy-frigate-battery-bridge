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
const {log, formatErrorMessage} = require('../../logger');
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
const OFFLINE_POLL_REFRESH_COOLDOWN_MS = 3600000;
const UNKNOWN_PERSON_PLACEHOLDER_REGEX = /^(?:unknown|stranger)$/i;
const PERMANENT_SET_PROPERTY_ERROR_CODES = new Set([
  'device_invalid_property',
  'device_invalid_property_value',
  'device_not_supported',
  'device_property_not_supported',
  'read_only_property',
]);

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
  'motionDetection',
  'motionDetectionType',
  'motionDetectionTypeHuman',
  'motionDetectionTypeHumanRecognition',
  'motionDetectionTypeVehicle',
  'motionDetectionTypePet',
  'motionDetectionTypeDog',
  'petDetection',
  'motionDetectionTypeAllOtherMotions',
  'motionDetectionTypeOtherMotions',
  'loiteringDetection',
  'soundDetection',
  'cryingDetection',
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

/** @type {Map<string, Promise<Readonly<{ok: boolean, permanentRejection: boolean}>>>} */
const propertySyncChains = new Map();
/** @type {Map<string, object>} */
const qualitySyncInFlight = new Map();
/** @type {Map<string, object>} */
const recordingSyncInFlight = new Map();
/** @type {Map<string, object>} */
const rtspSyncInFlight = new Map();
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
  qualitySyncInFlight.clear();
  recordingSyncInFlight.clear();
  rtspSyncInFlight.clear();
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
 * Returns true if a serialized `device.set_property` outcome either succeeded or was permanently rejected
 * as unsupported by the camera hardware (so the one-shot check flag should latch instead of retrying).
 *
 * @param {{ok: boolean, permanentRejection: boolean}} res - Property write result.
 * @returns {boolean}
 */
function isSettledPropertyWrite(res) {
  return Boolean(res.ok || res.permanentRejection);
}

/**
 * Sends a serialized `device.set_property` RPC command for `cam`, distinguishing confirmed writes
 * (`ok: true`) from permanent device rejections (`permanentRejection: true`) vs transient RPC failures.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} name - Eufy property name.
 * @param {*} value - Target property value.
 * @returns {Promise<Readonly<{ok: boolean, permanentRejection: boolean}>>}
 */
function setCameraPropertyDetailed(cam, name, value) {
  const targetWs = getOpenWsSocket();
  if (!targetWs) {
    return Promise.resolve(Object.freeze({ok: false, permanentRejection: false}));
  }
  const serial = cam.getSerial();
  const prev = propertySyncChains.get(serial) || Promise.resolve(Object.freeze({ok: false, permanentRejection: false}));
  const next = prev
    .catch(() => {
      // Keep the per-camera property serialization chain alive after any prior failure.
      return Object.freeze({ok: false, permanentRejection: false});
    })
    .then(async () => {
      if (getOpenWsSocket() !== targetWs) {
        return Object.freeze({ok: false, permanentRejection: false});
      }
      const res = await call({
        command: 'device.set_property',
        serialNumber: serial,
        name,
        value,
      });
      if (!res.success) {
        const permanentRejection = PERMANENT_SET_PROPERTY_ERROR_CODES.has(String(res.errorCode || ''));
        const suffix = permanentRejection ? ' (unsupported by device, skipping retries): ' : ': ';
        log.warn(cam, 'could not set ' + name + suffix + formatRpcError(res));
        return Object.freeze({ok: false, permanentRejection});
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
      return Object.freeze({ok: true, permanentRejection: false});
    })
    .catch((err) => {
      log.warn(cam, 'could not set ' + name + ': ' + formatErrorMessage(err));
      return Object.freeze({ok: false, permanentRejection: false});
    });
  propertySyncChains.set(serial, next);
  return next;
}

/**
 * Sends a device.set_property RPC command for a camera serialized per device serial so
 * HomeBase does not drop concurrent P2P CMD_SET_PAYLOAD writes on initial mode sync.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} name - Eufy property name.
 * @param {*} value - Target property value.
 * @returns {Promise<boolean>} True only when device.set_property resolves with success === true.
 */
function setCameraProperty(cam, name, value) {
  return setCameraPropertyDetailed(cam, name, value).then((res) => res.ok);
}

/**
 * Emits a clear `WARN` log printing the camera's existing Eufy streaming quality before overriding it.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} currentQuality - Reported numeric `videoStreamingQuality` on the camera.
 * @param {number} targetQuality - Target numeric `videoStreamingQuality` to apply.
 */
function logStreamingQualityOverride(cam, currentQuality, targetQuality) {
  const override = cam.describeQualityOverride(currentQuality, targetQuality);
  log.warn(
    cam,
    'overriding existing Eufy streaming quality with configured streaming_quality=' +
      override.configuredQuality +
      ' (existing: ' +
      override.existingSummary +
      ' -> applying: ' +
      override.targetSummary +
      ')'
  );
}

/**
 * Emits a deduplicated `WARN` log when read-only Eufy Motion Detection properties indicate that
 * active `trigger_events` on `cam` are disabled in the Eufy app.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function logTriggerDetectionWarningIfNeeded(cam) {
  const warn = cam.consumeTriggerDetectionWarning();
  if (!warn) {
    return;
  }
  if (warn.kind === 'master_off') {
    log.warn(
      cam,
      'Eufy camera has motionDetection=false in the Eufy app; motion and AI trigger_events will not fire ' +
        'until Motion Detection is enabled'
    );
    return;
  }
  const triggerSource = warn.explicitTriggers ? 'configured trigger_events' : 'default trigger_events';
  const remedy = warn.explicitTriggers
    ? 'enable them in the Eufy app or update trigger_events'
    : 'enable them in the Eufy app or set trigger_events to match';
  log.warn(
    cam,
    triggerSource +
      ' includes detection types disabled in the Eufy app: ' +
      warn.disabledSummary +
      '; enabled on camera: ' +
      warn.enabledSummary +
      ' (' +
      remedy +
      ')'
  );
}

/**
 * Enqueues a `videoStreamingQuality` update for `cam` after metadata/target resolution and latches
 * `qualityChecked` once confirmed or permanently rejected in the same sync epoch.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties.
 * @param {{token: object, epoch: number}} syncCtx - Active in-flight token and sync epoch.
 * @returns {Promise<void>}
 */
async function applyResolvedStreamingQuality(cam, props, syncCtx) {
  const serial = cam.getSerial();
  const {token, epoch} = syncCtx;
  const {shouldUpdate, currentQuality, targetQuality} = cam.evaluateQualityChange(props, {commit: false});
  if (!shouldUpdate || targetQuality === null) {
    if (
      targetQuality !== null &&
      'videoStreamingQuality' in props &&
      !Number.isNaN(Number(unwrapProperty(props.videoStreamingQuality))) &&
      cam.getPropertySyncEpoch() === epoch
    ) {
      cam.markQualityChecked();
    }
    return;
  }
  logStreamingQualityOverride(cam, currentQuality, targetQuality);
  const res = await setCameraPropertyDetailed(cam, 'videoStreamingQuality', targetQuality);
  if (qualitySyncInFlight.get(serial) === token && cam.getPropertySyncEpoch() === epoch) {
    if (res.ok) {
      cam.applyConfirmedStreamingQuality(targetQuality);
    }
    if (isSettledPropertyWrite(res)) {
      cam.markQualityChecked();
    }
  }
}

/**
 * Checks the camera's `videoStreamingQuality` property when an opt-in `streaming_quality` profile or
 * custom integer is configured (`"keep"` never writes), resolving named tiers against the camera's
 * `device.get_properties_metadata` `states` map once before syncing via `device.set_property`.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties.
 */
function checkStreamingQuality(cam, props) {
  const serial = cam.getSerial();
  if (qualitySyncInFlight.has(serial) || !props || !('videoStreamingQuality' in props)) {
    return;
  }
  if (!cam.needsQualityMetadataLookup()) {
    const {shouldUpdate, currentQuality, targetQuality} = cam.evaluateQualityChange(props, {commit: false});
    if (!shouldUpdate || targetQuality === null) {
      if (targetQuality !== null && !Number.isNaN(Number(unwrapProperty(props.videoStreamingQuality)))) {
        cam.markQualityChecked();
      }
      return;
    }
    const token = {};
    const epoch = cam.getPropertySyncEpoch();
    qualitySyncInFlight.set(serial, token);
    logStreamingQualityOverride(cam, currentQuality, targetQuality);
    void setCameraPropertyDetailed(cam, 'videoStreamingQuality', targetQuality).then((res) => {
      if (qualitySyncInFlight.get(serial) === token) {
        qualitySyncInFlight.delete(serial);
        if (cam.getPropertySyncEpoch() === epoch) {
          if (res.ok) {
            cam.applyConfirmedStreamingQuality(targetQuality);
          }
          if (isSettledPropertyWrite(res)) {
            cam.markQualityChecked();
          }
        }
      }
    });
    return;
  }
  if (!getOpenWsSocket()) {
    return;
  }
  const token = {};
  const epoch = cam.getPropertySyncEpoch();
  qualitySyncInFlight.set(serial, token);
  void (async () => {
    try {
      const metaRes = await call({command: 'device.get_properties_metadata', serialNumber: serial});
      if (qualitySyncInFlight.get(serial) !== token || cam.getPropertySyncEpoch() !== epoch) {
        return;
      }
      if (metaRes.success) {
        const states = metaRes.result?.properties?.videoStreamingQuality?.states ?? null;
        cam.setQualityMetadataStates(states);
      } else if (PERMANENT_SET_PROPERTY_ERROR_CODES.has(String(metaRes.errorCode || ''))) {
        cam.setQualityMetadataStates(null);
      } else {
        return;
      }
      await applyResolvedStreamingQuality(cam, props, {token, epoch});
    } finally {
      if (qualitySyncInFlight.get(serial) === token) {
        qualitySyncInFlight.delete(serial);
      }
    }
  })();
}

/**
 * Checks the camera's Eufy Power Manager recording properties and applies any opted-in
 * `power_mode` overrides (`powerWorkingMode` for `"battery"`/`"surveillance"`, or all 4 recording
 * properties for `"custom"`) via `eufy-security-ws` on full property sync.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties.
 */
function checkHardwareRecordingSettings(cam, props) {
  const serial = cam.getSerial();
  if (recordingSyncInFlight.has(serial)) {
    return;
  }
  const updates = cam.evaluateRecordingModeChanges(props, {commit: false});
  if (updates.length === 0) {
    return;
  }
  const token = {};
  const epoch = cam.getPropertySyncEpoch();
  recordingSyncInFlight.set(serial, token);
  const override = cam.describeRecordingOverride(props, updates);
  log.warn(
    cam,
    'overriding existing Eufy power settings with configured power_mode="' +
      override.powerMode +
      '" (existing: ' +
      override.existingSummary +
      ' -> applying: ' +
      override.targetSummary +
      ')'
  );
  const writes = updates.map((upd) => {
    log.debug(
      cam,
      'syncing Eufy hardware property ' + upd.name + ' (' + (upd.currentValue ?? 'n/a') + ' -> ' + upd.targetValue + ')'
    );
    return setCameraPropertyDetailed(cam, upd.name, upd.targetValue);
  });
  void Promise.all(writes).then((results) => {
    if (recordingSyncInFlight.get(serial) === token) {
      recordingSyncInFlight.delete(serial);
      if (cam.getPropertySyncEpoch() === epoch) {
        for (let i = 0; i < updates.length; i++) {
          if (results[i] && results[i].ok) {
            cam.applyConfirmedRecordingProperty(updates[i].name, updates[i].targetValue);
          }
        }
        if (results.every(isSettledPropertyWrite)) {
          cam.markRecordingModeChecked();
        }
      }
    }
  });
}

/**
 * Enqueues a serialized rtspStream property write and marks rtspEnabledChecked on confirmation or permanent rejection.
 *
 * @param {Camera} cam - Camera state object.
 * @param {boolean} targetEnabled - Target rtspStream boolean value.
 */
function enqueueRtspStreamPropertySync(cam, targetEnabled) {
  const serial = cam.getSerial();
  const token = {};
  const epoch = cam.getPropertySyncEpoch();
  rtspSyncInFlight.set(serial, token);
  const verb = targetEnabled
    ? 'enabling HomeBase RTSP stream (rtspStream=true)'
    : 'disabling HomeBase RTSP stream (rtspStream=false)';
  log.info(cam, verb + ' via eufy-security-ws');
  void setCameraPropertyDetailed(cam, 'rtspStream', targetEnabled).then((res) => {
    if (rtspSyncInFlight.get(serial) === token) {
      rtspSyncInFlight.delete(serial);
      if (isSettledPropertyWrite(res) && cam.getPropertySyncEpoch() === epoch) {
        cam.setRtspPropertyChecked(true);
      }
    }
  });
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
  if (rtspSyncInFlight.has(cam.getSerial())) {
    return;
  }
  if (cam.shouldEnableRtspProperty(rtspStreamProp, {commit: false})) {
    enqueueRtspStreamPropertySync(cam, true);
  } else if (cam.shouldDisableRtspProperty(rtspStreamProp, {commit: false})) {
    enqueueRtspStreamPropertySync(cam, false);
  }
}

/**
 * Resolves card-rebuild and full-sync flags for applyDeviceProperties while preserving 2-arg and 3-arg callers.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {boolean|{allowCardRebuild?: boolean, fullSync?: boolean}} [options] - Card-rebuild flag or sync options.
 * @returns {{allowCardRebuild: boolean, fullSync: boolean}}
 */
function resolveApplyDeviceOptions(cam, options) {
  if (typeof options === 'boolean') {
    return {allowCardRebuild: options, fullSync: true};
  }
  const isObj = options !== null && typeof options === 'object';
  const fullSync = !isObj || options.fullSync !== false;
  const allowCardRebuild =
    isObj && typeof options.allowCardRebuild === 'boolean'
      ? options.allowCardRebuild
      : fullSync
        ? !cam.hasBatteryReading()
        : false;
  return {allowCardRebuild, fullSync};
}

/**
 * Applies device telemetry properties from eufy-security-ws to a camera's Telemetry domain model.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties, start_listening, or event.
 * @param {boolean|{allowCardRebuild?: boolean, fullSync?: boolean}} [options] - Card-rebuild flag or sync options.
 */
function applyDeviceProperties(cam, props, options) {
  if (!props || typeof props !== 'object') {
    return;
  }
  const {allowCardRebuild, fullSync} = resolveApplyDeviceOptions(cam, options);

  if (fullSync) {
    checkHardwareRecordingSettings(cam, props);
  }
  if (fullSync || 'stationSerialNumber' in props || 'rtspStreamUrl' in props || 'rtspStream' in props) {
    syncCameraRtspProperties(cam, {
      stationSn: unwrapProperty(props.stationSerialNumber),
      rtspUrlProp: unwrapProperty(props.rtspStreamUrl),
      rtspStreamProp: unwrapProperty(props.rtspStream),
    });
  }
  if (fullSync) {
    checkStreamingQuality(cam, props);
  }
  const outcome = cam.applyTelemetryProperties(props, allowCardRebuild);
  logTriggerDetectionWarningIfNeeded(cam);
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
 * Returns true if the 60-minute unforced offline HomeBase poll_refresh cooldown has elapsed.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean}
 */
function isOfflinePollRefreshDue(now) {
  return lastPollRefreshAt === null ? true : now - lastPollRefreshAt >= OFFLINE_POLL_REFRESH_COOLDOWN_MS;
}

/**
 * Returns true when `cam` is offline due to a recoverable power, link, or timeout condition.
 *
 * @param {Camera} cam - Configured Eufy camera.
 * @returns {boolean}
 */
function needsOfflinePollRefresh(cam) {
  return cam.shouldPollRefreshWhileOffline();
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
  return forceRefresh ? true : eufyCams.some(needsOfflinePollRefresh) && isOfflinePollRefreshDue(now);
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
