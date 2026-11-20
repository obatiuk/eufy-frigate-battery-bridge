// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Telemetry domain model encapsulating camera sensor readings (battery, charging,
 * power source, Wi-Fi bars, RSSI, temperature, lastSeen), Eufy property parsing, and
 * low-battery economy rules. The pure visual resolvers live in telemetry-visuals.js.
 */
'use strict';

const {
  CARD_THEMES,
  POWER_WORKING_MODES,
  POWER_MODES,
  STREAMING_QUALITIES,
  OPTIMAL_BATTERY_MAX_CLIP_SECS,
  SURVEILLANCE_HOLD_SECS,
  MIN_RECORDING_CLIP_SECS,
  MAX_RECORDING_CLIP_SECS,
  clampNum,
  resolveCameraTimers,
  resolveCameraTriggers,
  resolveTelemetryConfig,
  resolveHardwareRecordingConfig,
} = require('../config');
const {
  STATUS_KINDS,
  POWER_LABELS,
  EUFY_CHARGING_STATUS,
  EUFY_POWER_SOURCES,
  WIFI_SIGNAL_LEVELS,
  MIN_BATTERY_PCT,
  parseChargingState,
  rssiToWifiSignalLevel,
  resolveTempVisual,
  evaluateTelemetryState,
} = require('./telemetry-visuals');

const DEFAULT_BATTERY_POWER_SOURCE = 'battery';

/**
 * Eufy hardware device connection states reported via the `state` property in eufy-security-ws.
 *
 * @readonly
 * @enum {number}
 */
const EUFY_DEVICE_STATES = Object.freeze({
  OFFLINE: 0,
  ONLINE: 1,
  MANUALLY_DISABLED: 2,
  OFFLINE_LOWBAT: 3,
  REMOVE_AND_READD: 4,
  RESET_AND_READD: 5,
});

const BATTERY_SWAP_DELTA_PCT = 10;
const FALLBACK_QUALITY_AUTO = 0;
const FALLBACK_QUALITY_LOW = 5;
const FALLBACK_QUALITY_MEDIUM = 7;
const FALLBACK_QUALITY_HIGH = 9;
const FALLBACK_QUALITY_ULTRA = 10;
const LOW_BAT_VIEWER_REFRESH_COOLDOWN_MS = 300000;
const OFFLINE_STANDBY_MIN_BATTERY_PCT = 5;
const OFFLINE_DEAD_LINK_RSSI_DBM = -95;
const SCHEDULED_POWER_WORKING_MODE = 3;
const POWER_WORKING_MODE_PROP = 'powerWorkingMode';
const RECORDING_CLIP_LENGTH_PROP = 'recordingClipLength';
const RECORDING_END_EARLY_PROP = 'recordingEndClipMotionStops';
const VIDEO_STREAMING_QUALITY_PROP = 'videoStreamingQuality';
const PROP_KV_SEPARATOR = '=';
const SUMMARY_ITEM_SEPARATOR = ', ';
const LABEL_PREFIX = ' ("';
const LABEL_SUFFIX = '")';
const PAREN_FALSE_PREFIX = ' (';
const PAREN_FALSE_SUFFIX = '=false)';
const QUOTE_CHAR = '"';
const WARN_SIG_SEP = '|';

const MOTION_DETECTION_PROPS = Object.freeze({
  ENABLED: 'motionDetection',
  HUMAN: 'motionDetectionTypeHuman',
  FACE: 'motionDetectionTypeHumanRecognition',
  VEHICLE: 'motionDetectionTypeVehicle',
  PET: 'motionDetectionTypePet',
  DOG: 'motionDetectionTypeDog',
  PET_STANDALONE: 'petDetection',
  ALL_OTHER: 'motionDetectionTypeAllOtherMotions',
  OTHER_LEGACY: 'motionDetectionTypeOtherMotions',
  LOITERING: 'loiteringDetection',
  SOUND: 'soundDetection',
  CRYING: 'cryingDetection',
});

const DETECTION_CATEGORIES = Object.freeze({
  MOTION: 'motion',
  PERSON: 'person',
  HUMAN: 'human',
  FACE: 'face',
  IDENTITY_PERSON: 'identity person',
  LOITERING: 'loitering',
  VEHICLE: 'vehicle',
  PET: 'pet',
  DOG: 'dog',
  SOUND: 'sound',
  CRYING: 'crying',
  NONE: 'none',
});

const DETECTION_WARN_KINDS = Object.freeze({
  MASTER_OFF: 'master_off',
  DISABLED_TYPES: 'disabled_types',
});

const TRIGGER_NAMES = Object.freeze({
  MOTION: 'motion detected',
  RADAR: 'radar motion detected',
  PERSON: 'person detected',
  STRANGER: 'stranger person detected',
  IDENTITY_PERSON: 'identity person detected',
  IDENTITY_SHORT: 'identity person',
  LOITERING: 'someone loitering',
  LOITERING_SHORT: 'loitering',
  VEHICLE: 'vehicle detected',
  PET: 'pet detected',
  DOG: 'dog detected',
  DOG_LICK: 'dog lick detected',
  DOG_POOP: 'dog poop detected',
  SOUND: 'sound detected',
  CRYING: 'crying detected',
});

const NON_MOTION_ONLY_TRIGGERS = new Set([
  'ring',
  'rings',
  'ringing',
  TRIGGER_NAMES.SOUND,
  DETECTION_CATEGORIES.SOUND,
  TRIGGER_NAMES.CRYING,
  DETECTION_CATEGORIES.CRYING,
]);

const WARN_SIG_PREFIXES = Object.freeze({
  MASTER: 'master:',
  EXPLICIT: 'explicit:',
  DEFAULT: 'default:',
});

/** @type {Readonly<Record<number, string>>} */
const POWER_WORKING_MODE_LABELS = Object.freeze({
  [POWER_WORKING_MODES.BATTERY_SAVER]: 'Optimal Battery Life',
  [POWER_WORKING_MODES.SURVEILLANCE]: 'Optimal Surveillance',
  [POWER_WORKING_MODES.CUSTOMIZE_RECORDING]: 'Customize Recording',
  [SCHEDULED_POWER_WORKING_MODE]: 'Schedule',
});

/** @type {Readonly<Record<string, number>>} */
const DEFAULT_QUALITY_TIER_CODES = Object.freeze({
  [STREAMING_QUALITIES.AUTO]: FALLBACK_QUALITY_AUTO,
  [STREAMING_QUALITIES.LOW]: FALLBACK_QUALITY_LOW,
  [STREAMING_QUALITIES.MEDIUM]: FALLBACK_QUALITY_MEDIUM,
  [STREAMING_QUALITIES.HIGH]: FALLBACK_QUALITY_HIGH,
  [STREAMING_QUALITIES.ULTRA]: FALLBACK_QUALITY_ULTRA,
});

/** @type {Readonly<Record<string, RegExp>>} */
const QUALITY_TIER_PATTERNS = Object.freeze({
  [STREAMING_QUALITIES.AUTO]: /\bauto\b/i,
  [STREAMING_QUALITIES.LOW]: /\b(?:low|sd|standard|basic)\b/i,
  [STREAMING_QUALITIES.MEDIUM]: /\b(?:medium|med|720p?)\b/i,
  [STREAMING_QUALITIES.HIGH]: /\b(?:high|1080p?|2k|full\s*hd|fhd)\b/i,
  [STREAMING_QUALITIES.ULTRA]: /\b(?:ultra|4k|max|uhd)\b/i,
});

/** @type {ReadonlyArray<{ name: string, coerce: (v: *) => number|boolean }>} */
const RECORDING_MODE_PROPERTIES = Object.freeze([
  {name: 'powerWorkingMode', coerce: Number},
  {name: 'recordingClipLength', coerce: Number},
  {name: 'recordingEndClipMotionStops', coerce: Boolean},
  {name: 'recordingRetriggerInterval', coerce: Number},
]);

/**
 * Returns true when `name` is present on `props` with a defined unwrapped value.
 *
 * @param {Record<string, *>} props - Raw properties object from eufy-security-ws.
 * @param {string} name - Property name.
 * @returns {boolean}
 */
function hasPresentProperty(props, name) {
  return name in props ? unwrapProperty(props[name]) !== undefined : false;
}

/**
 * Formats a Eufy Power Manager `name=value` pair, appending the human mode label on `powerWorkingMode`.
 *
 * @param {string} name - Eufy property name.
 * @param {*} value - Unwrapped property value.
 * @returns {string}
 */
function formatRecordingPropertyPair(name, value) {
  const base = name + PROP_KV_SEPARATOR + value;
  if (name !== POWER_WORKING_MODE_PROP) {
    return base;
  }
  const label = POWER_WORKING_MODE_LABELS[Number(value)];
  return label ? base + LABEL_PREFIX + label + LABEL_SUFFIX : base;
}

/**
 * Formats a `videoStreamingQuality=<code>` pair, appending the device metadata state label when known.
 *
 * @param {number|null} code - Numeric Eufy streaming quality code.
 * @param {Readonly<Record<string, *>>|null} states - Loaded metadata `states` dictionary, if any.
 * @returns {string}
 */
function formatStreamingQualityPair(code, states) {
  const base = VIDEO_STREAMING_QUALITY_PROP + PROP_KV_SEPARATOR + code;
  const rawLabel = states && typeof states === 'object' ? states[String(code)] : null;
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  return label ? base + LABEL_PREFIX + label + LABEL_SUFFIX : base;
}

/**
 * Resolves a named `streaming_quality` tier against Eufy's `videoStreamingQuality.states` map,
 * falling back to the highest numeric state when `"ultra"` or `"high"` has no exact label match on
 * lower-resolution hardware, or `DEFAULT_QUALITY_TIER_CODES` when no states map is loaded.
 *
 * @param {string} tier - Named streaming_quality tier ('auto', 'low', 'medium', 'high', 'ultra').
 * @param {Readonly<Record<string, *>>|null} states - Metadata states map from eufy-security-ws, if loaded.
 * @returns {number|null}
 */
function resolveQualityCodeFromStates(tier, states) {
  const fallback = tier in DEFAULT_QUALITY_TIER_CODES ? DEFAULT_QUALITY_TIER_CODES[tier] : null;
  if (!states || typeof states !== 'object') {
    return fallback;
  }
  const entries = [];
  for (const [rawCode, rawLabel] of Object.entries(states)) {
    const code = Number(rawCode);
    if (Number.isInteger(code) && typeof rawLabel === 'string') {
      entries.push({code, label: rawLabel.trim()});
    }
  }
  if (entries.length === 0) {
    return fallback;
  }
  const pattern = QUALITY_TIER_PATTERNS[tier];
  if (pattern) {
    const matched = entries.find((entry) => pattern.test(entry.label));
    if (matched) {
      return matched.code;
    }
  }
  if (tier === STREAMING_QUALITIES.ULTRA || tier === STREAMING_QUALITIES.HIGH) {
    let maxCode = entries[0].code;
    for (const entry of entries) {
      if (entry.code > maxCode) {
        maxCode = entry.code;
      }
    }
    return maxCode;
  }
  return fallback;
}

/**
 * Unwraps a property value returned by eufy-security-ws, handling both direct values
 * (API schema 10+) and metadata-wrapped { value } objects (older schemas).
 *
 * @param {*} prop - Raw property entry from eufy-security-ws.
 * @returns {*} Unwrapped primitive or object value.
 */
function unwrapProperty(prop) {
  if (prop !== null && typeof prop === 'object' && 'value' in prop) {
    return prop.value;
  }
  return prop;
}

/**
 * Coerces a raw value to a finite-or-signed number, returning null when absent or NaN.
 *
 * @param {*} raw - Unwrapped property value.
 * @returns {number|null}
 */
function parseValidNumber(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  const num = Number(raw);
  return Number.isNaN(num) ? null : num;
}

/**
 * Coerces a present property value via Number(), returning null only when undefined or null.
 *
 * @param {*} raw - Unwrapped property value.
 * @returns {number|null}
 */
function parsePresentNumber(raw) {
  return raw !== undefined && raw !== null ? Number(raw) : null;
}

/**
 * Coerces a negative RSSI reading in dBm, ignoring non-negative placeholders and missing values.
 *
 * @param {*} raw - Unwrapped RSSI property value.
 * @returns {number|null}
 */
function parseNegativeRssi(raw) {
  const num = parseValidNumber(raw);
  return num !== null && num < 0 ? num : null;
}

/**
 * Trims a non-empty string property, returning null when absent or non-string.
 *
 * @param {*} raw - Unwrapped string property value.
 * @returns {string|null}
 */
function parseTrimmedString(raw) {
  return raw && typeof raw === 'string' ? raw.trim() : null;
}

/**
 * Returns a boolean when `raw` is strictly boolean, or `null` when absent/non-boolean.
 *
 * @param {*} raw - Unwrapped Eufy property value.
 * @returns {boolean|null}
 */
function parseOptionalBoolean(raw) {
  return typeof raw === 'boolean' ? raw : null;
}

/**
 * Formats `<category> (<propName>=false)` for Eufy Motion Detection mismatch warnings.
 *
 * @param {string} category - Bridge trigger category label.
 * @param {string} propName - Eufy property name that reported `false`.
 * @returns {string}
 */
function formatDisabledDetectionEntry(category, propName) {
  return category + PAREN_FALSE_PREFIX + propName + PAREN_FALSE_SUFFIX;
}

/**
 * Parses read-only Eufy Motion Detection configuration booleans from a raw property dictionary.
 *
 * @param {Record<string, *>} props - Raw properties object from eufy-security-ws.
 * @returns {Readonly<{
 *   enabled: boolean|null,
 *   human: boolean|null,
 *   face: boolean|null,
 *   vehicle: boolean|null,
 *   pet: boolean|null,
 *   dog: boolean|null,
 *   petStandalone: boolean|null,
 *   allOther: boolean|null,
 *   loitering: boolean|null,
 *   sound: boolean|null,
 *   crying: boolean|null
 * }>}
 */
function parseMotionDetectionConfig(props) {
  const allOther = unwrapProperty(
    props[MOTION_DETECTION_PROPS.ALL_OTHER] ?? props[MOTION_DETECTION_PROPS.OTHER_LEGACY]
  );
  return Object.freeze({
    enabled: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.ENABLED])),
    human: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.HUMAN])),
    face: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.FACE])),
    vehicle: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.VEHICLE])),
    pet: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.PET])),
    dog: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.DOG])),
    petStandalone: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.PET_STANDALONE])),
    allOther: parseOptionalBoolean(allOther),
    loitering: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.LOITERING])),
    sound: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.SOUND])),
    crying: parseOptionalBoolean(unwrapProperty(props[MOTION_DETECTION_PROPS.CRYING])),
  });
}

/**
 * Normalizes a raw Eufy device property bag into a frozen structure of unwrapped sensor,
 * hardware-setting, and identity values.
 *
 * @param {Record<string, *>} [props={}] - Raw properties object from eufy-security-ws.
 * @returns {Readonly<{
 *   deviceName: string|null,
 *   modelName: string|null,
 *   firmware: string|null,
 *   model: *,
 *   swVer: *,
 *   hasStateProp: boolean,
 *   deviceState: number|null,
 *   hasBatteryProp: boolean,
 *   battery: number|null,
 *   chargingStatus: *,
 *   batteryIsCharging: *,
 *   powerSource: *,
 *   wifi: number|null,
 *   rssi: number|null,
 *   temp: number|null,
 *   light: boolean|null,
 *   hwPowerMode: number|null,
 *   hwClipLength: number|null,
 *   hwEndEarly: boolean|null,
 *   hwQuality: number|null,
 *   hwDetection: ReturnType<typeof parseMotionDetectionConfig>
 * }>}
 */
function parseTelemetryProperties(props = {}) {
  const devName = unwrapProperty(props.name);
  const devState = unwrapProperty(props.state);
  const bat = unwrapProperty(props.battery ?? props.batteryLevel);
  const wifi = unwrapProperty(props.wifiSignalLevel ?? props.cellularSignalLevel);
  const rssi = unwrapProperty(props.wifiRssi ?? props.cellularRSSI);
  const temp = unwrapProperty(props.batteryTemperature ?? props.temperature);
  const light = unwrapProperty(props.light);
  const hwEndEarly = unwrapProperty(props.recordingEndClipMotionStops);
  const hwQual = unwrapProperty(props.videoStreamingQuality ?? props.streamingQuality);
  const model = unwrapProperty(props.model);
  const swVer = unwrapProperty(props.softwareVersion);

  return Object.freeze({
    deviceName: parseTrimmedString(devName),
    modelName: parseTrimmedString(model),
    firmware: parseTrimmedString(swVer),
    model,
    swVer,
    hasStateProp: 'state' in props,
    deviceState: parseValidNumber(devState),
    hasBatteryProp: bat !== undefined && bat !== null,
    battery: parsePresentNumber(bat),
    chargingStatus: unwrapProperty(props.chargingStatus),
    batteryIsCharging: unwrapProperty(props.batteryIsCharging),
    powerSource: unwrapProperty(props.powerSource),
    wifi: parsePresentNumber(wifi),
    rssi: parseNegativeRssi(rssi),
    temp: parsePresentNumber(temp),
    light: typeof light === 'boolean' ? light : null,
    hwPowerMode: parseValidNumber(unwrapProperty(props.powerWorkingMode)),
    hwClipLength: parseValidNumber(unwrapProperty(props.recordingClipLength)),
    hwEndEarly: typeof hwEndEarly === 'boolean' ? hwEndEarly : null,
    hwQuality: parseValidNumber(hwQual),
    hwDetection: parseMotionDetectionConfig(props),
  });
}

/**
 * Evaluates major card-rebuilding state changes, Wi-Fi/temperature visual tier shifts, and
 * minor sensor deltas between a pre-update snapshot and the updated Telemetry readings.
 *
 * @param {{
 *   hadInitialTelemetry: boolean,
 *   prevBattery: number|null,
 *   prevCharging: boolean,
 *   prevWifi: number|null,
 *   prevRssi: number|null,
 *   prevTemp: number|null,
 *   prevLight: boolean,
 *   wasLowBat: boolean,
 *   wasCritBat: boolean,
 *   wasOffline: boolean
 * }} prev - Snapshot captured before applying properties.
 * @param {{
 *   battery: number|null,
 *   charging: boolean,
 *   wifi: number|null,
 *   rssi: number|null,
 *   temp: number|null,
 *   lightOn: boolean,
 *   nowLowBat: boolean,
 *   nowCritBat: boolean,
 *   nowOffline: boolean
 * }} next - Updated readings after applying properties and offline reconciliation.
 * @param {{ model?: *, swVer?: * }} [rawMeta={}] - Unwrapped model and firmware values for logging.
 * @returns {Readonly<{
 *   hadInitialTelemetry: boolean,
 *   prevBattery: number|null,
 *   nowLowBat: boolean,
 *   nowOffline: boolean,
 *   offlineChanged: boolean,
 *   stateChanged: boolean,
 *   wifiTierChanged: boolean,
 *   minorTelemetryChanged: boolean,
 *   model: *,
 *   swVer: *
 * }>}
 */
function detectTelemetryChanges(prev, next, rawMeta = {}) {
  const offlineChanged = prev.wasOffline !== next.nowOffline;
  const batterySwapped =
    prev.prevBattery !== null &&
    next.battery !== null &&
    Math.abs(next.battery - prev.prevBattery) >= BATTERY_SWAP_DELTA_PCT;
  const majorSensorShift =
    prev.wasLowBat !== next.nowLowBat ||
    prev.wasCritBat !== next.nowCritBat ||
    prev.prevCharging !== next.charging ||
    batterySwapped;
  const stateChanged = offlineChanged || (prev.hadInitialTelemetry && majorSensorShift);
  const prevTempRgb = resolveTempVisual(prev.prevTemp).tempRgb;
  const nextTempRgb = resolveTempVisual(next.temp).tempRgb;
  const wifiTierChanged = prev.hadInitialTelemetry && (prev.prevWifi !== next.wifi || prevTempRgb !== nextTempRgb);
  const anyReadingChanged =
    prev.prevBattery !== next.battery ||
    prev.prevWifi !== next.wifi ||
    prev.prevRssi !== next.rssi ||
    prev.prevTemp !== next.temp ||
    prev.prevLight !== next.lightOn;
  const minorTelemetryChanged = prev.hadInitialTelemetry && !stateChanged && anyReadingChanged;

  return Object.freeze({
    hadInitialTelemetry: prev.hadInitialTelemetry,
    prevBattery: prev.prevBattery,
    nowLowBat: next.nowLowBat,
    nowOffline: next.nowOffline,
    offlineChanged,
    stateChanged,
    wifiTierChanged,
    minorTelemetryChanged,
    model: rawMeta.model,
    swVer: rawMeta.swVer,
  });
}

/**
 * Domain model representing a camera's live telemetry readings and display preferences.
 */
class Telemetry {
  /**
   * @param {Record<string, *>} rawCamCfg - Camera entry from config.yaml.
   * @param {string} [initialLastSeen=''] - Initial lastSeen 'HH:MM' string from snapshot cache.
   * @param {ReturnType<typeof import("../config").resolveCameraTimers>|null} [resolvedTimers=null] - Camera timers.
   */
  constructor(rawCamCfg = {}, initialLastSeen = '', resolvedTimers = null) {
    const timers = resolvedTimers || resolveCameraTimers(rawCamCfg);
    this.serial = String(rawCamCfg.serial || '');
    this.config = resolveTelemetryConfig(rawCamCfg);
    this.hwRecordingCfg = resolveHardwareRecordingConfig(rawCamCfg, timers);
    this.lowBatThreshold = timers.lowBatThreshold;
    this.criticalBatThreshold = timers.criticalBatThreshold;
    this.lowBatWakeOnView = Boolean(timers.lowBatWakeOnView);
    this.isRtspDirect = Boolean(timers.rtspDirect || (rawCamCfg && rawCamCfg.rtsp_url));
    this.deviceName = '';
    this.model = '';
    this.firmware = '';
    /** @type {number|null} */
    this.deviceState = null;
    this.wakeTimedOutOffline = false;
    this.wsConnected = true;
    this.stationConnected = true;
    this.frigateConnected = true;
    this.go2rtcConnected = true;
    this.battery = null;
    this.charging = false;
    this.powerLabel = '';
    this.wifi = null;
    this.rssi = null;
    this.temp = null;
    this.lastSeen = initialLastSeen;
    this.lastLowBatRefreshAt = 0;
    this.qualityChecked = false;
    /** @type {Readonly<Record<string, *>>|null} */
    this.qualityStates = null;
    this.qualityStatesLoaded = false;
    this.recordingModeChecked = false;
    this.lightOn = false;
    this.lightOnAt = 0;
    this.pendingLightRestore = false;
    this.lastClearedLightOnAt = 0;
    /** @type {number|null} */
    this.hwPowerMode = this.hwRecordingCfg.powerWorkingMode;
    /** @type {number|null} */
    this.hwClipLength = this.hwRecordingCfg.recordingClipLength;
    /** @type {boolean|null} */
    this.hwEndEarly = this.hwRecordingCfg.recordingEndClipMotionStops;
    /** @type {number|null} */
    this.hwQuality = null;
    /** @type {Set<string>} */
    this.triggers =
      rawCamCfg && rawCamCfg.triggers instanceof Set ? rawCamCfg.triggers : resolveCameraTriggers(rawCamCfg);
    this.hasExplicitTriggers = Boolean(
      (rawCamCfg && rawCamCfg.hasExplicitTriggers) ||
      (rawCamCfg && Array.isArray(rawCamCfg.trigger_events) && rawCamCfg.trigger_events.length > 0)
    );
    /** @type {ReadonlySet<string>} */
    this.rawTriggers =
      rawCamCfg && rawCamCfg.rawTriggers instanceof Set
        ? rawCamCfg.rawTriggers
        : Array.isArray(rawCamCfg.trigger_events)
          ? new Set(rawCamCfg.trigger_events.map((t) => String(t).toLowerCase().trim()))
          : new Set();
    /** @type {boolean|null} */
    this.hwMotionEnabled = null;
    /** @type {boolean|null} */
    this.hwMotionHuman = null;
    /** @type {boolean|null} */
    this.hwMotionFace = null;
    /** @type {boolean|null} */
    this.hwMotionVehicle = null;
    /** @type {boolean|null} */
    this.hwMotionPet = null;
    /** @type {boolean|null} */
    this.hwMotionDog = null;
    /** @type {boolean|null} */
    this.hwPetStandalone = null;
    /** @type {boolean|null} */
    this.hwMotionAllOther = null;
    /** @type {boolean|null} */
    this.hwLoitering = null;
    /** @type {boolean|null} */
    this.hwSound = null;
    /** @type {boolean|null} */
    this.hwCrying = null;
    this.lastDetectionWarnSignature = '';
  }

  /**
   * Returns true if the camera's built-in spotlight (light property) is currently reported on.
   *
   * @returns {boolean}
   */
  isLightOn() {
    return this.lightOn;
  }

  /**
   * Clears the cached spotlight state once a light=false reset command has been queued,
   * remembering the prior activation timestamp in case the RPC fails and must retry.
   */
  clearLightOn() {
    this.pendingLightRestore = this.lightOn;
    this.lastClearedLightOnAt = this.lightOnAt;
    this.lightOn = false;
    this.lightOnAt = 0;
  }

  /**
   * Restores the cached spotlight state when a queued light=false RPC fails before any
   * newer hardware spotlight reading arrives.
   */
  restoreLightOn() {
    if (this.pendingLightRestore && !this.lightOn) {
      this.lightOn = true;
      this.lightOnAt = this.lastClearedLightOnAt;
    }
    this.pendingLightRestore = false;
    this.lastClearedLightOnAt = 0;
  }

  /**
   * Marks the streaming quality check as completed after RPC confirmation.
   */
  markQualityChecked() {
    this.qualityChecked = true;
  }

  /**
   * Marks the Power Manager recording mode sync check as completed after RPC confirmation.
   */
  markRecordingModeChecked() {
    this.recordingModeChecked = true;
  }

  /**
   * Updates the cached `hwQuality` reading immediately after a `videoStreamingQuality` `set_property` succeeds.
   *
   * @param {number} quality - Confirmed numeric streaming quality code.
   */
  applyConfirmedStreamingQuality(quality) {
    this.hwQuality = Number(quality);
  }

  /**
   * Updates the cached Power Manager reading immediately after a `device.set_property` write succeeds.
   *
   * @param {string} name - Confirmed Eufy property name.
   * @param {*} value - Confirmed target value.
   */
  applyConfirmedRecordingProperty(name, value) {
    if (name === POWER_WORKING_MODE_PROP) {
      this.hwPowerMode = Number(value);
    } else if (name === RECORDING_CLIP_LENGTH_PROP) {
      this.hwClipLength = Number(value);
    } else if (name === RECORDING_END_EARLY_PROP) {
      this.hwEndEarly = Boolean(value);
    }
  }

  /**
   * Returns true when Eufy Power Manager battery conservation / recording sync is enabled for this camera.
   *
   * @returns {boolean}
   */
  hasPowerConservationEnabled() {
    return this.hwRecordingCfg.powerWorkingMode !== null;
  }

  /**
   * Returns the sanitized telemetry configuration summary for GET /api/config, returning null
   * when telemetry is unavailable (direct rtsp_url or card_theme="none") and effective boolean
   * flags for all sub-options under the resolved card theme and parent toggles.
   *
   * @param {string} cardTheme - Resolved StatusCard theme name.
   * @returns {Readonly<Record<string, boolean>>|null}
   */
  toConfigSummary(cardTheme) {
    if (this.isRtspDirect || cardTheme === CARD_THEMES.NONE) {
      return null;
    }
    const enabled = Boolean(this.config.enabled);
    const isMinimal = cardTheme === CARD_THEMES.MINIMAL;
    const battery = enabled && Boolean(this.config.battery);
    const wifi = enabled && Boolean(this.config.wifi);
    return Object.freeze({
      enabled,
      battery,
      power_source: battery && Boolean(this.config.powerSource),
      wifi,
      rssi: wifi && Boolean(this.config.rssi),
      temperature: enabled && !isMinimal && Boolean(this.config.temperature),
      last_seen: enabled && !isMinimal && Boolean(this.config.lastSeen),
    });
  }

  /**
   * Returns true if eufy-security-ws connectivity is marked healthy on this Telemetry model.
   *
   * @returns {boolean}
   */
  isWsConnected() {
    return Boolean(this.wsConnected);
  }

  /**
   * Returns true if the HomeBase station (or direct RTSP endpoint) is marked connected/reachable.
   *
   * @returns {boolean}
   */
  isStationConnected() {
    return Boolean(this.stationConnected);
  }

  /**
   * Returns true if Frigate HTTP API connectivity is marked healthy on this Telemetry model.
   *
   * @returns {boolean}
   */
  isFrigateConnected() {
    return Boolean(this.frigateConnected);
  }

  /**
   * Returns true if go2rtc HTTP API connectivity is marked healthy on this Telemetry model.
   *
   * @returns {boolean}
   */
  isGo2rtcConnected() {
    return Boolean(this.go2rtcConnected);
  }

  /**
   * Returns the formatted HH:MM timestamp of the last decoded frame (or empty string if none).
   *
   * @returns {string}
   */
  getLastSeen() {
    return this.lastSeen || '';
  }

  /**
   * Resolves the normalized power source string ('battery', 'charging', 'plugged', 'solar', or null).
   *
   * @returns {string|null}
   */
  resolvePowerSource() {
    if (this.powerLabel) {
      return this.powerLabel.toLowerCase();
    }
    return this.battery !== null || this.charging ? DEFAULT_BATTERY_POWER_SOURCE : null;
  }

  /**
   * Resolves the effective hardware clip length in seconds for `GET /api/status` so preset modes
   * (`0 -> 20s`, `1 -> 60s`, `>= 3 -> null`) do not report leftover `Customize Recording` (`2`) values.
   *
   * @returns {number|null}
   */
  _resolveEffectiveStatusClipLength() {
    if (this.hwPowerMode === POWER_WORKING_MODES.BATTERY_SAVER) {
      return OPTIMAL_BATTERY_MAX_CLIP_SECS;
    }
    if (this.hwPowerMode === POWER_WORKING_MODES.SURVEILLANCE) {
      return SURVEILLANCE_HOLD_SECS;
    }
    if (this.hwPowerMode !== null && this.hwPowerMode > POWER_WORKING_MODES.CUSTOMIZE_RECORDING) {
      return null;
    }
    return this.hwClipLength;
  }

  /**
   * Resolves the effective hardware early-end flag for `GET /api/status` so preset modes
   * (`0 -> true`, `1 -> true`, `>= 3 -> null`) do not report leftover `Customize Recording` (`2`) values.
   *
   * @returns {boolean|null}
   */
  _resolveEffectiveStatusEndEarly() {
    if (
      this.hwPowerMode === POWER_WORKING_MODES.BATTERY_SAVER ||
      this.hwPowerMode === POWER_WORKING_MODES.SURVEILLANCE
    ) {
      return true;
    }
    if (this.hwPowerMode !== null && this.hwPowerMode > POWER_WORKING_MODES.CUSTOMIZE_RECORDING) {
      return null;
    }
    return this.hwEndEarly;
  }

  /**
   * Returns an immutable live sensor and hardware-settings summary for GET /api/status,
   * or null on direct rtsp_url cameras where Eufy hardware telemetry does not apply.
   *
   * @returns {Readonly<Record<string, *>>|null}
   */
  toStatusSummary() {
    if (this.isRtspDirect) {
      return null;
    }
    return Object.freeze({
      model: this.model || null,
      firmware: this.firmware || null,
      device_state: this.deviceState,
      battery_pct: this.battery,
      charging: Boolean(this.charging),
      power_source: this.resolvePowerSource(),
      low_battery: this.isLowBattery(),
      critical_battery: this.isCriticalBattery(),
      wifi_signal: this.wifi,
      rssi_dbm: this.rssi,
      temperature_c: this.temp,
      light_on: Boolean(this.lightOn),
      last_seen: this.lastSeen || null,
      hardware_settings: Object.freeze({
        power_working_mode: this.hwPowerMode,
        recording_clip_length: this._resolveEffectiveStatusClipLength(),
        recording_end_early: this._resolveEffectiveStatusEndEarly(),
        streaming_quality: this.hwQuality,
      }),
      motion_detection: this._buildMotionDetectionStatusSummary(),
    });
  }

  /**
   * Returns true if battery level is at or below this camera's lowBatThreshold and not charging.
   *
   * @returns {boolean}
   */
  isLowBattery() {
    const level = Number(this.battery);
    return this.lowBatThreshold > 0 && !this.charging && this.battery !== null
      ? !Number.isNaN(level) && level <= this.lowBatThreshold
      : false;
  }

  /**
   * Returns true if battery level is at or below this camera's criticalBatThreshold and not charging.
   *
   * @returns {boolean}
   */
  isCriticalBattery() {
    const level = Number(this.battery);
    return this.criticalBatThreshold > 0 && !this.charging && this.battery !== null
      ? !Number.isNaN(level) && level <= this.criticalBatThreshold
      : false;
  }

  /**
   * Returns true if the camera's Eufy deviceState explicitly reports an offline or disabled condition,
   * distinguishing Eufy battery-camera deep standby (state=0 with healthy battery > criticalBatThreshold
   * and RSSI > -95 dBm) from genuine offline/low-battery shutoff states (state=3 OFFLINE_LOWBAT, state=2/4/5,
   * or dead link/battery).
   *
   * @returns {boolean}
   */
  isReportedOfflineByState() {
    const st = this.deviceState !== null ? Number(this.deviceState) : Number.NaN;
    const critCutoff =
      this.criticalBatThreshold > MIN_BATTERY_PCT ? this.criticalBatThreshold : OFFLINE_STANDBY_MIN_BATTERY_PCT;
    const hasHealthyStandbyLink =
      (this.charging || this.battery === null || Number(this.battery) > critCutoff) &&
      (this.rssi === null || Number(this.rssi) > OFFLINE_DEAD_LINK_RSSI_DBM);
    return !Number.isNaN(st) && st !== EUFY_DEVICE_STATES.ONLINE
      ? st !== EUFY_DEVICE_STATES.OFFLINE || !hasHealthyStandbyLink
      : false;
  }

  /**
   * Returns true if battery percentage is 0% and the camera is not actively charging or plugged in.
   *
   * @returns {boolean}
   */
  isBatteryDepleted() {
    const level = Number(this.battery);
    return !this.charging && this.battery !== null ? !Number.isNaN(level) && level <= 0 : false;
  }

  /**
   * Returns true if `deviceState` reports an intentional user-disabled or unpaired state
   * (`2` MANUALLY_DISABLED, `4` REMOVE_AND_READD, or `5` RESET_AND_READD) where background
   * `driver.poll_refresh` cannot recover the camera and would only wake sibling battery cameras.
   *
   * @returns {boolean}
   */
  isManuallyDisabledOrRemovedState() {
    return (
      this.deviceState === EUFY_DEVICE_STATES.MANUALLY_DISABLED ||
      this.deviceState === EUFY_DEVICE_STATES.REMOVE_AND_READD ||
      this.deviceState === EUFY_DEVICE_STATES.RESET_AND_READD
    );
  }

  /**
   * Returns true if the camera is currently offline/dead (reported offline by Eufy state,
   * depleted to 0% battery while unplugged, or unreachable after a wake timeout).
   *
   * @returns {boolean}
   */
  isDeviceOffline() {
    return Boolean(this.isReportedOfflineByState() || this.isBatteryDepleted() || this.wakeTimedOutOffline);
  }

  /**
   * Returns true if this camera is offline due to a recoverable power, link, or timeout condition
   * (excluding `MANUALLY_DISABLED` / `REMOVE_AND_READD` / `RESET_AND_READD`) and warrants a
   * rate-limited background `driver.poll_refresh`.
   *
   * @returns {boolean}
   */
  shouldPollRefreshWhileOffline() {
    return this.isDeviceOffline() ? !this.isManuallyDisabledOrRemovedState() : false;
  }

  /**
   * Returns true when any upstream dependency or camera link (eufy-security-ws, HomeBase/camera,
   * Frigate API, or go2rtc API) is currently disconnected or offline.
   *
   * @returns {boolean}
   */
  hasServiceDisruption() {
    return Boolean(
      (!this.isRtspDirect && !this.wsConnected) ||
      !this.stationConnected ||
      !this.frigateConnected ||
      !this.go2rtcConnected ||
      this.isDeviceOffline()
    );
  }

  /**
   * Updates service connectivity flags (wsConnected, stationConnected, frigateConnected, go2rtcConnected)
   * and returns true if any flag or overall service disruption state changed.
   *
   * @param {{
   *   wsConnected?: boolean,
   *   stationConnected?: boolean,
   *   frigateConnected?: boolean,
   *   go2rtcConnected?: boolean
   * }} [flags={}] - Service health flags.
   * @returns {boolean}
   */
  updateServiceHealth(flags = {}) {
    const prevDisrupted = this.hasServiceDisruption();
    let changed = false;
    if (typeof flags.wsConnected === 'boolean' && this.wsConnected !== flags.wsConnected) {
      this.wsConnected = flags.wsConnected;
      changed = true;
    }
    if (typeof flags.stationConnected === 'boolean' && this.stationConnected !== flags.stationConnected) {
      this.stationConnected = flags.stationConnected;
      changed = true;
    }
    if (typeof flags.frigateConnected === 'boolean' && this.frigateConnected !== flags.frigateConnected) {
      this.frigateConnected = flags.frigateConnected;
      changed = true;
    }
    if (typeof flags.go2rtcConnected === 'boolean' && this.go2rtcConnected !== flags.go2rtcConnected) {
      this.go2rtcConnected = flags.go2rtcConnected;
      changed = true;
    }
    return Boolean(changed || prevDisrupted !== this.hasServiceDisruption());
  }

  /**
   * Returns a concise human-readable reason when the camera is offline, or an empty string when online.
   *
   * @returns {string}
   */
  getOfflineReason() {
    if (!this.isDeviceOffline()) {
      return '';
    }
    if (this.deviceState === EUFY_DEVICE_STATES.OFFLINE_LOWBAT) {
      return 'offline (low battery)';
    }
    if (this.isBatteryDepleted()) {
      return 'battery depleted (0%)';
    }
    if (this.deviceState === EUFY_DEVICE_STATES.OFFLINE) {
      return 'device offline';
    }
    if (this.deviceState === EUFY_DEVICE_STATES.MANUALLY_DISABLED) {
      return 'device manually disabled';
    }
    if (this.isReportedOfflineByState()) {
      return 'device state=' + this.deviceState;
    }
    return 'unreachable (wake timed out)';
  }

  /**
   * Forgets the last RSSI and Wi-Fi tier of a camera that reports itself shut off, because it has no live radio link.
   * Not used for state=0, where the dead-link RSSI is what classifies the camera as offline.
   */
  clearLinkQuality() {
    this.rssi = null;
    this.wifi = null;
  }

  /**
   * Marks the camera as unreachable/offline after a live wake attempt times out without receiving video.
   */
  markWakeTimedOut() {
    this.wakeTimedOutOffline = true;
  }

  /**
   * Clears any transient wake-timeout or stale offline state once the camera emits a live event or video packet.
   */
  markDeviceOnline() {
    this.wakeTimedOutOffline = false;
    if (this.deviceState !== null && this.deviceState !== EUFY_DEVICE_STATES.ONLINE) {
      this.deviceState = EUFY_DEVICE_STATES.ONLINE;
    }
  }

  /**
   * Returns true once an initial battery percentage has been populated from eufy-security-ws.
   *
   * @returns {boolean}
   */
  hasBatteryReading() {
    return this.battery !== null;
  }

  /**
   * Updates the formatted HH:MM timestamp of the last decoded live video frame.
   *
   * @param {string} hmString - Formatted local HH:MM string.
   */
  updateLastSeen(hmString) {
    this.lastSeen = hmString;
  }

  /**
   * Returns true when a named `streaming_quality` profile (other than `"keep"`) is configured
   * and `videoStreamingQuality.states` metadata has not yet been queried for this camera.
   *
   * @returns {boolean}
   */
  needsQualityMetadataLookup() {
    const q = this.hwRecordingCfg.streamingQuality;
    return !this.qualityChecked && !this.qualityStatesLoaded && typeof q === 'string'
      ? q !== STREAMING_QUALITIES.KEEP
      : false;
  }

  /**
   * Stores the camera's `videoStreamingQuality.states` metadata dictionary from `eufy-security-ws`
   * so named quality tiers resolve against the hardware's native enum scale.
   *
   * @param {Record<string, *>|null|undefined} states - `states` object from `device.get_properties_metadata`.
   */
  setQualityMetadataStates(states) {
    this.qualityStates = states && typeof states === 'object' ? Object.freeze({...states}) : null;
    this.qualityStatesLoaded = true;
  }

  /**
   * Resolves the target numeric `videoStreamingQuality` code for the configured `streaming_quality`,
   * or returns `null` when `streaming_quality` is `"keep"` or inapplicable.
   *
   * @returns {number|null}
   */
  resolveTargetStreamingQuality() {
    const q = this.hwRecordingCfg.streamingQuality;
    if (q === null || q === undefined || q === STREAMING_QUALITIES.KEEP) {
      return null;
    }
    if (typeof q === 'number') {
      return q;
    }
    return resolveQualityCodeFromStates(q, this.qualityStates);
  }

  /**
   * Resolves the hardware-mirrored hold duration in seconds when `power_mode === "keep"`,
   * mapping `powerWorkingMode` `0 -> 20s`, `1 -> 60s`, and `2 -> recordingClipLength` (`5..120s`),
   * or returning `null` before telemetry arrives, on schedule/geofence modes (`>= 3`), or when `power_mode !== "keep"`.
   *
   * @returns {number|null}
   */
  resolveMirroredHoldSecs() {
    if (this.hwRecordingCfg.powerMode !== POWER_MODES.KEEP || this.hwPowerMode === null) {
      return null;
    }
    if (this.hwPowerMode === POWER_WORKING_MODES.BATTERY_SAVER) {
      return OPTIMAL_BATTERY_MAX_CLIP_SECS;
    }
    if (this.hwPowerMode === POWER_WORKING_MODES.SURVEILLANCE) {
      return SURVEILLANCE_HOLD_SECS;
    }
    if (this.hwPowerMode === POWER_WORKING_MODES.CUSTOMIZE_RECORDING && this.hwClipLength !== null) {
      return clampNum(
        this.hwClipLength,
        MIN_RECORDING_CLIP_SECS,
        MAX_RECORDING_CLIP_SECS,
        OPTIMAL_BATTERY_MAX_CLIP_SECS
      );
    }
    return null;
  }

  /**
   * Resolves the hardware-mirrored `end_early` boolean when `power_mode === "keep"`,
   * mapping `powerWorkingMode` `0 -> true`, `1 -> true`, and `2 -> hwEndEarly` (if boolean),
   * or returning `null` otherwise.
   *
   * @returns {boolean|null}
   */
  resolveMirroredEndEarly() {
    if (this.hwRecordingCfg.powerMode !== POWER_MODES.KEEP || this.hwPowerMode === null) {
      return null;
    }
    if (
      this.hwPowerMode === POWER_WORKING_MODES.BATTERY_SAVER ||
      this.hwPowerMode === POWER_WORKING_MODES.SURVEILLANCE
    ) {
      return true;
    }
    if (this.hwPowerMode === POWER_WORKING_MODES.CUSTOMIZE_RECORDING && typeof this.hwEndEarly === 'boolean') {
      return this.hwEndEarly;
    }
    return null;
  }

  /**
   * Returns true when `hwRecordingCfg` specifies a non-null target value for `name`.
   *
   * @param {string} name - Recording property key.
   * @returns {boolean}
   */
  _hasConfiguredRecordingTarget(name) {
    const val = this.hwRecordingCfg[name];
    return val !== null ? val !== undefined : false;
  }

  /**
   * Evaluates whether the camera's `videoStreamingQuality` property needs to be updated when an
   * explicit `streaming_quality` profile or integer is configured (`"keep"` never writes), committing
   * `qualityChecked` immediately when no write is needed (or when `commit !== false`).
   *
   * @param {Record<string, *>} props - Raw properties object from eufy-security-ws.
   * @param {string|{serial?: string, commit?: boolean}} [serialOrOpts={}] - Serial or evaluation options.
   * @returns {Readonly<{ shouldUpdate: boolean, currentQuality: number, targetQuality: number|null }>}
   */
  evaluateQualityChange(props, serialOrOpts = {}) {
    const isOpts = serialOrOpts !== null && typeof serialOrOpts === 'object';
    const commit = !isOpts || serialOrOpts.commit !== false;
    const targetQuality = this.resolveTargetStreamingQuality();
    if (targetQuality === null || this.qualityChecked || !props || !('videoStreamingQuality' in props)) {
      return Object.freeze({shouldUpdate: false, currentQuality: 0, targetQuality});
    }
    const currentQuality = Number(unwrapProperty(props.videoStreamingQuality));
    if (Number.isNaN(currentQuality)) {
      return Object.freeze({shouldUpdate: false, currentQuality: 0, targetQuality});
    }
    const shouldUpdate = currentQuality !== targetQuality;
    if (!shouldUpdate || commit) {
      this.qualityChecked = true;
    }
    return Object.freeze({shouldUpdate, currentQuality, targetQuality});
  }

  /**
   * Evaluates whether any opted-in Eufy hardware Power Manager properties (`powerWorkingMode` for
   * `"battery"`/`"surveillance"`, or all 4 recording keys for `"custom"`) need to be synced to the camera
   * via `device.set_property` once every required target key is present in `props`.
   *
   * @param {Record<string, *>} props - Raw properties object from eufy-security-ws.
   * @param {{commit?: boolean}} [opts={}] - Evaluation options.
   * @returns {ReadonlyArray<Readonly<{ name: string, currentValue: *, targetValue: * }>>}
   */
  evaluateRecordingModeChanges(props, opts = {}) {
    if (this.recordingModeChecked || !props || typeof props !== 'object') {
      return Object.freeze([]);
    }
    const activeSpecs = RECORDING_MODE_PROPERTIES.filter((spec) => this._hasConfiguredRecordingTarget(spec.name));
    if (activeSpecs.length === 0) {
      return Object.freeze([]);
    }
    const hasRequiredKeys = activeSpecs.every((spec) => hasPresentProperty(props, spec.name));
    if (!hasRequiredKeys) {
      return Object.freeze([]);
    }
    const commit = !opts || opts.commit !== false;
    const updates = [];
    for (const {name, coerce} of activeSpecs) {
      const targetValue = this.hwRecordingCfg[name];
      const cur = unwrapProperty(props[name]);
      if (coerce(cur) !== targetValue) {
        updates.push(Object.freeze({name, currentValue: cur, targetValue}));
      }
    }
    if (updates.length === 0 || commit) {
      this.recordingModeChecked = true;
    }
    return Object.freeze(updates);
  }

  /**
   * Builds a structured summary of existing Eufy Power Manager settings vs target overrides for `WARN` logging.
   *
   * @param {Record<string, *>} props - Raw properties object from eufy-security-ws.
   * @param {ReadonlyArray<{ name: string, currentValue: *, targetValue: * }>} updates - Pending property updates.
   * @returns {Readonly<{ powerMode: string, existingSummary: string, targetSummary: string }>}
   */
  describeRecordingOverride(props, updates) {
    const existingItems = [];
    if (props && typeof props === 'object') {
      for (const {name} of RECORDING_MODE_PROPERTIES) {
        if (hasPresentProperty(props, name)) {
          existingItems.push(formatRecordingPropertyPair(name, unwrapProperty(props[name])));
        }
      }
    }
    if (existingItems.length === 0) {
      for (const upd of updates) {
        existingItems.push(formatRecordingPropertyPair(upd.name, upd.currentValue));
      }
    }
    const targetItems = updates.map((upd) => formatRecordingPropertyPair(upd.name, upd.targetValue));
    return Object.freeze({
      powerMode: String(this.hwRecordingCfg.powerMode || ''),
      existingSummary: existingItems.join(SUMMARY_ITEM_SEPARATOR),
      targetSummary: targetItems.join(SUMMARY_ITEM_SEPARATOR),
    });
  }

  /**
   * Builds a structured summary of existing Eufy `videoStreamingQuality` vs target override for `WARN` logging.
   *
   * @param {number} currentQuality - Reported numeric `videoStreamingQuality` value on the camera.
   * @param {number} targetQuality - Target numeric `videoStreamingQuality` value to apply.
   * @returns {Readonly<{ configuredQuality: string, existingSummary: string, targetSummary: string }>}
   */
  describeQualityOverride(currentQuality, targetQuality) {
    const rawCfgQuality = this.hwRecordingCfg.streamingQuality;
    const configuredQuality =
      typeof rawCfgQuality === 'string' ? QUOTE_CHAR + rawCfgQuality + QUOTE_CHAR : String(rawCfgQuality);
    return Object.freeze({
      configuredQuality,
      existingSummary: formatStreamingQualityPair(currentQuality, this.qualityStates),
      targetSummary: formatStreamingQualityPair(targetQuality, this.qualityStates),
    });
  }

  /**
   * Captures the pre-update sensor and battery-threshold snapshot before mutating Telemetry fields.
   *
   * @returns {{
   *   hadInitialTelemetry: boolean,
   *   prevBattery: number|null,
   *   prevCharging: boolean,
   *   prevWifi: number|null,
   *   prevRssi: number|null,
   *   prevTemp: number|null,
   *   prevLight: boolean,
   *   wasLowBat: boolean,
   *   wasCritBat: boolean,
   *   wasOffline: boolean
   * }}
   */
  _captureSnapshot() {
    return {
      hadInitialTelemetry: this.battery !== null,
      prevBattery: this.battery,
      prevCharging: this.charging,
      prevWifi: this.wifi,
      prevRssi: this.rssi,
      prevTemp: this.temp,
      prevLight: this.lightOn,
      wasLowBat: this.isLowBattery(),
      wasCritBat: this.isCriticalBattery(),
      wasOffline: this.isDeviceOffline(),
    };
  }

  /**
   * Updates the cached spotlight state and activation timestamp when a boolean light reading arrives.
   *
   * @param {boolean|null} light - Normalized spotlight boolean or null.
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  _applySpotlight(light, now) {
    if (light === null) {
      return;
    }
    this.pendingLightRestore = false;
    this.lastClearedLightOnAt = 0;
    if (light && !this.lightOn) {
      this.lightOnAt = now;
    } else if (!light) {
      this.lightOnAt = 0;
    }
    this.lightOn = light;
  }

  /**
   * Applies normalized hardware Power Manager settings and trimmed device identity fields.
   *
   * @param {ReturnType<typeof parseTelemetryProperties>} parsed - Normalized property values.
   */
  _applyHardwareAndIdentity(parsed) {
    if (parsed.hwPowerMode !== null) {
      this.hwPowerMode = parsed.hwPowerMode;
    }
    if (parsed.hwClipLength !== null) {
      this.hwClipLength = parsed.hwClipLength;
    }
    if (parsed.hwEndEarly !== null) {
      this.hwEndEarly = parsed.hwEndEarly;
    }
    if (parsed.hwQuality !== null) {
      this.hwQuality = parsed.hwQuality;
    }
    if (parsed.deviceName !== null) {
      this.deviceName = parsed.deviceName;
    }
    if (parsed.modelName !== null) {
      this.model = parsed.modelName;
    }
    if (parsed.firmware !== null) {
      this.firmware = parsed.firmware;
    }
    this._applyMotionDetectionReadings(parsed.hwDetection);
  }

  /**
   * Merges reported read-only Eufy Motion Detection configuration booleans into cached Telemetry fields.
   *
   * @param {ReturnType<typeof parseMotionDetectionConfig>} det - Parsed detection flags.
   */
  _applyMotionDetectionReadings(det) {
    if (!det) {
      return;
    }
    if (det.enabled !== null) this.hwMotionEnabled = det.enabled;
    if (det.human !== null) this.hwMotionHuman = det.human;
    if (det.face !== null) this.hwMotionFace = det.face;
    if (det.vehicle !== null) this.hwMotionVehicle = det.vehicle;
    if (det.pet !== null) this.hwMotionPet = det.pet;
    if (det.dog !== null) this.hwMotionDog = det.dog;
    if (det.petStandalone !== null) this.hwPetStandalone = det.petStandalone;
    if (det.allOther !== null) this.hwMotionAllOther = det.allOther;
    if (det.loitering !== null) this.hwLoitering = det.loitering;
    if (det.sound !== null) this.hwSound = det.sound;
    if (det.crying !== null) this.hwCrying = det.crying;
  }

  /**
   * Resolves the effective pet/dog detection boolean across Eufy camera schemas (`null` when unreported).
   *
   * @returns {boolean|null}
   */
  _resolveEffectivePetDetection() {
    if (this.hwMotionPet === true || this.hwPetStandalone === true || this.hwMotionDog === true) {
      return true;
    }
    if (this.hwMotionPet === false || this.hwPetStandalone === false || this.hwMotionDog === false) {
      return false;
    }
    return null;
  }

  /**
   * Returns true if at least one Eufy Motion Detection configuration flag has been reported for this camera.
   *
   * @returns {boolean}
   */
  _hasAnyMotionDetectionProperty() {
    return (
      this.hwMotionEnabled !== null ||
      this.hwMotionHuman !== null ||
      this.hwMotionFace !== null ||
      this.hwMotionVehicle !== null ||
      this._resolveEffectivePetDetection() !== null ||
      this.hwMotionAllOther !== null ||
      this.hwLoitering !== null ||
      this.hwSound !== null ||
      this.hwCrying !== null
    );
  }

  /**
   * Builds the read-only Eufy Motion Detection summary for `GET /api/status` (`null` until reported).
   *
   * @returns {Readonly<Record<string, boolean|null>>|null}
   */
  _buildMotionDetectionStatusSummary() {
    if (!this._hasAnyMotionDetectionProperty()) {
      return null;
    }
    return Object.freeze({
      enabled: this.hwMotionEnabled,
      human: this.hwMotionHuman,
      face: this.hwMotionFace,
      vehicle: this.hwMotionVehicle,
      pet: this._resolveEffectivePetDetection(),
      all_other_motions: this.hwMotionAllOther,
      loitering: this.hwLoitering,
      sound: this.hwSound ?? this.hwCrying,
    });
  }

  /**
   * Collects human-readable names of Eufy detection categories currently enabled on the camera.
   *
   * @returns {string}
   */
  _formatEnabledDetectionCategories() {
    const enabled = [];
    if (this.hwMotionHuman === true) enabled.push(DETECTION_CATEGORIES.HUMAN);
    if (this.hwMotionFace === true) enabled.push(DETECTION_CATEGORIES.FACE);
    if (this.hwLoitering === true) enabled.push(DETECTION_CATEGORIES.LOITERING);
    if (this.hwMotionVehicle === true) enabled.push(DETECTION_CATEGORIES.VEHICLE);
    if (this._resolveEffectivePetDetection() === true) enabled.push(DETECTION_CATEGORIES.PET);
    if (this.hwMotionAllOther === true) enabled.push(DETECTION_CATEGORIES.MOTION);
    if (this.hwSound === true) enabled.push(DETECTION_CATEGORIES.SOUND);
    if (this.hwCrying === true && this.hwSound !== true) enabled.push(DETECTION_CATEGORIES.CRYING);
    return enabled.length > 0 ? enabled.join(SUMMARY_ITEM_SEPARATOR) : DETECTION_CATEGORIES.NONE;
  }

  /**
   * Collects disabled Eufy Motion Detection entries that conflict with this camera's active `triggers` set.
   *
   * @returns {string[]}
   */
  _collectDisabledTriggerEntries() {
    const disabled = [];
    if (
      (this.triggers.has(TRIGGER_NAMES.MOTION) || this.triggers.has(TRIGGER_NAMES.RADAR)) &&
      this.hwMotionAllOther === false
    ) {
      disabled.push(formatDisabledDetectionEntry(DETECTION_CATEGORIES.MOTION, MOTION_DETECTION_PROPS.ALL_OTHER));
    }
    if (
      (this.triggers.has(TRIGGER_NAMES.PERSON) || this.triggers.has(TRIGGER_NAMES.STRANGER)) &&
      this.hwMotionHuman === false
    ) {
      disabled.push(formatDisabledDetectionEntry(DETECTION_CATEGORIES.PERSON, MOTION_DETECTION_PROPS.HUMAN));
    }
    const wantsExplicitIdentity =
      this.hasExplicitTriggers &&
      (this.rawTriggers.has(TRIGGER_NAMES.IDENTITY_SHORT) || this.rawTriggers.has(TRIGGER_NAMES.IDENTITY_PERSON));
    if (wantsExplicitIdentity && this.hwMotionFace === false) {
      disabled.push(formatDisabledDetectionEntry(DETECTION_CATEGORIES.IDENTITY_PERSON, MOTION_DETECTION_PROPS.FACE));
    }
    const wantsExplicitLoitering =
      this.hasExplicitTriggers &&
      (this.rawTriggers.has(TRIGGER_NAMES.LOITERING_SHORT) || this.rawTriggers.has(TRIGGER_NAMES.LOITERING));
    if (wantsExplicitLoitering && this.hwLoitering === false) {
      disabled.push(formatDisabledDetectionEntry(DETECTION_CATEGORIES.LOITERING, MOTION_DETECTION_PROPS.LOITERING));
    }
    if (this.triggers.has(TRIGGER_NAMES.VEHICLE) && this.hwMotionVehicle === false) {
      disabled.push(formatDisabledDetectionEntry(DETECTION_CATEGORIES.VEHICLE, MOTION_DETECTION_PROPS.VEHICLE));
    }
    this._appendPetAndSoundDisabledEntries(disabled);
    return disabled;
  }

  /**
   * Appends disabled pet/dog and sound/crying entries to `disabled` when active in `this.triggers`.
   *
   * @param {string[]} disabled - Mutable collector of formatted disabled entries.
   */
  _appendPetAndSoundDisabledEntries(disabled) {
    const wantsPet =
      this.triggers.has(TRIGGER_NAMES.PET) ||
      this.triggers.has(TRIGGER_NAMES.DOG) ||
      this.triggers.has(TRIGGER_NAMES.DOG_LICK) ||
      this.triggers.has(TRIGGER_NAMES.DOG_POOP);
    if (wantsPet && this._resolveEffectivePetDetection() === false) {
      const prop =
        this.hwMotionPet === false
          ? MOTION_DETECTION_PROPS.PET
          : this.hwPetStandalone === false
            ? MOTION_DETECTION_PROPS.PET_STANDALONE
            : MOTION_DETECTION_PROPS.DOG;
      const cat =
        this.hwMotionPet === false || this.hwPetStandalone === false
          ? DETECTION_CATEGORIES.PET
          : DETECTION_CATEGORIES.DOG;
      disabled.push(formatDisabledDetectionEntry(cat, prop));
    }
    if (this.triggers.has(TRIGGER_NAMES.SOUND) && this.hwSound === false) {
      disabled.push(formatDisabledDetectionEntry(DETECTION_CATEGORIES.SOUND, MOTION_DETECTION_PROPS.SOUND));
    } else if (
      this.triggers.has(TRIGGER_NAMES.CRYING) &&
      (this.hwCrying === false || (this.hwCrying === null && this.hwSound === false))
    ) {
      const soundProp = this.hwCrying === false ? MOTION_DETECTION_PROPS.CRYING : MOTION_DETECTION_PROPS.SOUND;
      disabled.push(formatDisabledDetectionEntry(DETECTION_CATEGORIES.CRYING, soundProp));
    }
  }

  /**
   * Evaluates whether reported Eufy Motion Detection settings disable categories active in `trigger_events`,
   * deduplicating repeated polls until the mismatch signature changes or clears.
   *
   * @returns {Readonly<{
   *   kind: 'master_off'|'disabled_types',
   *   explicitTriggers: boolean,
   *   disabledSummary: string,
   *   enabledSummary: string
   * }>|null}
   */
  consumeTriggerDetectionWarning() {
    if (this.isRtspDirect || !this._hasAnyMotionDetectionProperty()) {
      return null;
    }
    if (this.hwMotionEnabled === false) {
      const needsMotion = Array.from(this.triggers).some((t) => !NON_MOTION_ONLY_TRIGGERS.has(t));
      if (!needsMotion) {
        this.lastDetectionWarnSignature = '';
        return null;
      }
      const disabledSummary = MOTION_DETECTION_PROPS.ENABLED + PROP_KV_SEPARATOR + false;
      const sig = WARN_SIG_PREFIXES.MASTER + disabledSummary;
      if (sig === this.lastDetectionWarnSignature) {
        return null;
      }
      this.lastDetectionWarnSignature = sig;
      return Object.freeze({
        kind: DETECTION_WARN_KINDS.MASTER_OFF,
        explicitTriggers: this.hasExplicitTriggers,
        disabledSummary,
        enabledSummary: DETECTION_CATEGORIES.NONE,
      });
    }
    const disabled = this._collectDisabledTriggerEntries();
    if (disabled.length === 0) {
      this.lastDetectionWarnSignature = '';
      return null;
    }
    const disabledSummary = disabled.join(SUMMARY_ITEM_SEPARATOR);
    const enabledSummary = this._formatEnabledDetectionCategories();
    const prefix = this.hasExplicitTriggers ? WARN_SIG_PREFIXES.EXPLICIT : WARN_SIG_PREFIXES.DEFAULT;
    const sig = prefix + disabledSummary + WARN_SIG_SEP + enabledSummary;
    if (sig === this.lastDetectionWarnSignature) {
      return null;
    }
    this.lastDetectionWarnSignature = sig;
    return Object.freeze({
      kind: DETECTION_WARN_KINDS.DISABLED_TYPES,
      explicitTriggers: this.hasExplicitTriggers,
      disabledSummary,
      enabledSummary,
    });
  }

  /**
   * Applies normalized connection state, battery, charging, RSSI, Wi-Fi tier, and temperature readings.
   *
   * @param {ReturnType<typeof parseTelemetryProperties>} parsed - Normalized property values.
   */
  _applySensorReadings(parsed) {
    if (parsed.deviceState !== null) {
      this.deviceState = parsed.deviceState;
      if (this.deviceState === EUFY_DEVICE_STATES.ONLINE) {
        this.wakeTimedOutOffline = false;
      }
    }
    if (parsed.hasBatteryProp) {
      this.battery = parsed.battery;
    }
    const parsedCharge = parseChargingState(
      {
        chgStatus: parsed.chargingStatus,
        chgBool: parsed.batteryIsCharging,
        pwrSrc: parsed.powerSource,
      },
      {charging: this.charging, powerLabel: this.powerLabel}
    );
    this.charging = parsedCharge.charging;
    this.powerLabel = parsedCharge.powerLabel;

    if (parsed.rssi !== null) {
      this.rssi = parsed.rssi;
    }
    if (this.rssi !== null) {
      this.wifi = rssiToWifiSignalLevel(this.rssi);
    } else if (parsed.wifi !== null) {
      this.wifi = parsed.wifi;
    }
    if (parsed.temp !== null) {
      this.temp = parsed.temp;
    }
  }

  /**
   * Returns true when a live sensor reading changed without an explicit `state` property after initial load.
   *
   * @param {ReturnType<Telemetry['_captureSnapshot']>} prev - Pre-update snapshot.
   * @param {boolean} hasStateProp - Whether raw props contained `state`.
   * @returns {boolean}
   */
  _hasFreshSensorActivity(prev, hasStateProp) {
    if (!prev.hadInitialTelemetry || hasStateProp) {
      return false;
    }
    const positiveBatChanged =
      prev.prevBattery !== null && this.battery !== null && this.battery !== prev.prevBattery && this.battery > 0;
    return (
      positiveBatChanged ||
      prev.prevCharging !== this.charging ||
      prev.prevRssi !== this.rssi ||
      prev.prevTemp !== this.temp
    );
  }

  /**
   * Clears stale offline flags after a battery swap, recharge, or fresh sensor reading, and resets
   * cached RSSI/Wi-Fi bars when a camera reports a non-standby shutoff state.
   *
   * @param {ReturnType<Telemetry['_captureSnapshot']>} prev - Pre-update snapshot.
   * @param {ReturnType<typeof parseTelemetryProperties>} parsed - Normalized property values.
   */
  _reconcileOfflineRecovery(prev, parsed) {
    const batteryIncreased =
      prev.prevBattery !== null && this.battery !== null && this.battery > prev.prevBattery && this.battery > 0;
    const batteryRiseSwapped =
      batteryIncreased &&
      this.battery !== null &&
      prev.prevBattery !== null &&
      this.battery - prev.prevBattery >= BATTERY_SWAP_DELTA_PCT;
    const canClearLowBatteryOffline = batteryRiseSwapped || !this.isLowBattery();
    const healthyOnline = !this.isReportedOfflineByState() && !this.isBatteryDepleted();
    const shouldClearTimeout =
      this.charging ||
      batteryIncreased ||
      this._hasFreshSensorActivity(prev, parsed.hasStateProp) ||
      (parsed.hasBatteryProp && !this.isLowBattery()) ||
      healthyOnline;

    if (shouldClearTimeout) {
      this.wakeTimedOutOffline = false;
      if (
        this.deviceState === EUFY_DEVICE_STATES.OFFLINE_LOWBAT &&
        (this.charging || (parsed.hasBatteryProp && canClearLowBatteryOffline))
      ) {
        this.deviceState = EUFY_DEVICE_STATES.ONLINE;
      } else if (this.deviceState === EUFY_DEVICE_STATES.OFFLINE && batteryIncreased && canClearLowBatteryOffline) {
        this.deviceState = EUFY_DEVICE_STATES.ONLINE;
      }
    }
    if (this.isReportedOfflineByState() && this.deviceState !== EUFY_DEVICE_STATES.OFFLINE) {
      this.clearLinkQuality();
    }
  }

  /**
   * Applies raw Eufy device properties to this Telemetry model and returns change flags.
   *
   * @param {Record<string, *>} props - Properties object from eufy-security-ws.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {ReturnType<typeof detectTelemetryChanges>}
   */
  applyProperties(props, now = Date.now()) {
    const prev = this._captureSnapshot();
    const parsed = parseTelemetryProperties(props);
    this._applySpotlight(parsed.light, now);
    this._applyHardwareAndIdentity(parsed);
    this._applySensorReadings(parsed);
    this._reconcileOfflineRecovery(prev, parsed);
    return detectTelemetryChanges(
      prev,
      {
        battery: this.battery,
        charging: this.charging,
        wifi: this.wifi,
        rssi: this.rssi,
        temp: this.temp,
        lightOn: this.lightOn,
        nowLowBat: this.isLowBattery(),
        nowCritBat: this.isCriticalBattery(),
        nowOffline: this.isDeviceOffline(),
      },
      {model: parsed.model, swVer: parsed.swVer}
    );
  }

  /**
   * Builds a plain status snapshot object used by the card renderer.
   *
   * @param {Record<string, *>} cardCfg - Resolved card configuration.
   * @returns {Record<string, *>}
   */
  toStatusSnapshot(cardCfg) {
    return {
      cardCfg,
      telCfg: this.config,
      lowBatThreshold: this.lowBatThreshold,
      criticalBatThreshold: this.criticalBatThreshold,
      battery: this.battery,
      charging: this.charging,
      powerLabel: this.powerLabel,
      economyMode: this.isLowBattery(),
      serviceDisrupted: this.hasServiceDisruption(),
      wifi: this.wifi,
      rssi: this.rssi,
      temp: this.temp,
      lastSeen: this.lastSeen,
    };
  }

  /**
   * Evaluates the 6-color visual state for the given status heading ('Live', 'Asleep', etc.).
   *
   * @param {string} titleText - Card heading string.
   * @returns {Record<string, *>}
   */
  evaluateVisualState(titleText) {
    return evaluateTelemetryState(titleText, {
      telCfg: this.config,
      lowBatThreshold: this.lowBatThreshold,
      criticalBatThreshold: this.criticalBatThreshold,
      battery: this.battery,
      charging: this.charging,
      powerLabel: this.powerLabel,
      economyMode: this.isLowBattery(),
      serviceDisrupted: this.hasServiceDisruption(),
      wifi: this.wifi,
      rssi: this.rssi,
      temp: this.temp,
      lastSeen: this.lastSeen,
    });
  }

  /**
   * Returns true if a viewer connecting while in low-battery economy mode should trigger
   * an immediate HomeBase poll_refresh to check for a physical battery swap.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [cooldownMs=LOW_BAT_VIEWER_REFRESH_COOLDOWN_MS] - Minimum interval between refreshes.
   * @returns {boolean}
   */
  shouldRefreshLowBatteryOnView(now = Date.now(), cooldownMs = LOW_BAT_VIEWER_REFRESH_COOLDOWN_MS) {
    if (now - this.lastLowBatRefreshAt <= cooldownMs) {
      return false;
    }
    this.lastLowBatRefreshAt = now;
    return true;
  }

  /**
   * Formats the initial telemetry summary log line when device properties are first loaded.
   *
   * @param {*} model - Unwrapped camera model name.
   * @param {*} swVer - Unwrapped camera firmware version.
   * @param {boolean} [nowLowBat=this.isLowBattery()] - Whether low-battery economy mode is active.
   * @returns {string}
   */
  formatLoadedLog(model, swVer, nowLowBat = this.isLowBattery()) {
    const hwInfo = model || swVer ? 'model=' + (model || 'n/a') + ', fw=' + (swVer || 'n/a') + ', ' : '';
    const offlineTag = this.isDeviceOffline() ? ' [OFFLINE: ' + this.getOfflineReason() + ']' : '';
    const pwrMode = (this.powerLabel || (nowLowBat ? 'battery [ECO]' : 'battery')) + offlineTag;
    return (
      'telemetry loaded (' +
      hwInfo +
      'battery=' +
      this.battery +
      '%, power=' +
      pwrMode +
      ', wifi=' +
      (this.wifi ?? 'n/a') +
      '/4, rssi=' +
      (this.rssi ?? 'n/a') +
      'dBm, temp=' +
      (this.temp ?? 'n/a') +
      '°C)'
    );
  }

  /**
   * Formats the battery/charging state transition log line.
   *
   * @param {number|null} prevBattery - Previous battery percentage.
   * @param {boolean} [nowLowBat=this.isLowBattery()] - Whether low-battery economy mode is active.
   * @returns {string}
   */
  formatStateChangeLog(prevBattery, nowLowBat = this.isLowBattery()) {
    let ecoStatus = 'normal mode restored';
    if (this.isDeviceOffline()) {
      ecoStatus = 'camera is offline: ' + this.getOfflineReason();
    } else if (nowLowBat) {
      ecoStatus = 'entered low-battery economy mode';
    }
    return (
      'battery state updated (' +
      (prevBattery ?? 'n/a') +
      '% -> ' +
      this.battery +
      '%, power=' +
      (this.powerLabel || 'battery') +
      ', ' +
      ecoStatus +
      ')'
    );
  }

  /**
   * Formats a routine debug telemetry update log line.
   *
   * @returns {string}
   */
  formatUpdateLog() {
    return (
      'telemetry updated (battery=' +
      (this.battery ?? 'n/a') +
      '%, power=' +
      (this.powerLabel || 'battery') +
      ', wifi=' +
      (this.wifi ?? 'n/a') +
      '/4, rssi=' +
      (this.rssi ?? 'n/a') +
      'dBm, temp=' +
      (this.temp ?? 'n/a') +
      '°C)'
    );
  }
}

module.exports = {
  STATUS_KINDS,
  POWER_LABELS,
  EUFY_DEVICE_STATES,
  EUFY_CHARGING_STATUS,
  EUFY_POWER_SOURCES,
  WIFI_SIGNAL_LEVELS,
  Telemetry,
  unwrapProperty,
  parseTelemetryProperties,
  detectTelemetryChanges,
  evaluateTelemetryState,
};
