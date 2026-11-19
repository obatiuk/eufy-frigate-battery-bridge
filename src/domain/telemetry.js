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

const {CARD_THEMES, resolveCameraTimers, resolveTelemetryConfig, resolveHardwareRecordingConfig} = require('../config');
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
const AUTO_STREAMING_QUALITY = 0;
const MEDIUM_STREAMING_QUALITY = 7;
const LOW_BAT_VIEWER_REFRESH_COOLDOWN_MS = 300000;
const OFFLINE_STANDBY_MIN_BATTERY_PCT = 5;
const OFFLINE_DEAD_LINK_RSSI_DBM = -95;

/** @type {ReadonlyArray<{ name: string, coerce: (v: *) => number|boolean }>} */
const RECORDING_MODE_PROPERTIES = Object.freeze([
  {name: 'powerWorkingMode', coerce: Number},
  {name: 'recordingClipLength', coerce: Number},
  {name: 'recordingEndClipMotionStops', coerce: Boolean},
  {name: 'recordingRetriggerInterval', coerce: Number},
]);

const DOORBELL_T8214_SERIAL_REGEX = /^T8214/i;

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
 *   hwQuality: number|null
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
    this.recordingModeChecked = false;
    this.lightOn = false;
    this.lightOnAt = 0;
    /** @type {number|null} */
    this.hwPowerMode = this.hwRecordingCfg.powerWorkingMode;
    /** @type {number|null} */
    this.hwClipLength = this.hwRecordingCfg.recordingClipLength;
    /** @type {boolean|null} */
    this.hwEndEarly = this.hwRecordingCfg.recordingEndClipMotionStops;
    /** @type {number|null} */
    this.hwQuality = null;
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
   * Clears the cached spotlight state once a light=false reset command has been queued.
   */
  clearLightOn() {
    this.lightOn = false;
    this.lightOnAt = 0;
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
        recording_clip_length: this.hwClipLength,
        recording_end_early: this.hwEndEarly,
        streaming_quality: this.hwQuality,
      }),
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
   * Returns true if the camera is currently offline/dead (reported offline by Eufy state,
   * depleted to 0% battery while unplugged, or unreachable after a wake timeout).
   *
   * @returns {boolean}
   */
  isDeviceOffline() {
    return Boolean(this.isReportedOfflineByState() || this.isBatteryDepleted() || this.wakeTimedOutOffline);
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
   * Evaluates whether the camera's videoStreamingQuality property needs to be updated
   * to prevent 4K P2P stream stalls, marking qualityChecked on first inspection.
   *
   * @param {Record<string, *>} props - Raw properties object from eufy-security-ws.
   * @param {string} [serial=this.serial] - Camera hardware serial number.
   * @returns {{ shouldUpdate: boolean, currentQuality: number, targetQuality: number }}
   */
  evaluateQualityChange(props, serial = this.serial) {
    const enforceQuality = this.hwRecordingCfg.enforceQuality;
    if (!enforceQuality || this.qualityChecked || !props || !('videoStreamingQuality' in props)) {
      return Object.freeze({shouldUpdate: false, currentQuality: 0, targetQuality: MEDIUM_STREAMING_QUALITY});
    }
    const currentQuality = Number(unwrapProperty(props.videoStreamingQuality));
    if (Number.isNaN(currentQuality)) {
      return Object.freeze({shouldUpdate: false, currentQuality: 0, targetQuality: MEDIUM_STREAMING_QUALITY});
    }
    this.qualityChecked = true;
    const isDoorbellT8214 = DOORBELL_T8214_SERIAL_REGEX.test(serial || '');
    if (enforceQuality === true && isDoorbellT8214) {
      return Object.freeze({shouldUpdate: false, currentQuality, targetQuality: MEDIUM_STREAMING_QUALITY});
    }
    const targetQuality = typeof enforceQuality === 'number' ? enforceQuality : MEDIUM_STREAMING_QUALITY;
    const shouldUpdate =
      typeof enforceQuality === 'number'
        ? currentQuality !== targetQuality
        : currentQuality === AUTO_STREAMING_QUALITY || currentQuality > MEDIUM_STREAMING_QUALITY;
    return Object.freeze({shouldUpdate, currentQuality, targetQuality});
  }

  /**
   * Evaluates whether any configured Eufy hardware Power Manager properties (powerWorkingMode,
   * recordingClipLength, recordingEndClipMotionStops, recordingRetriggerInterval) need to be
   * synced to the camera via device.set_property on first full property inspection.
   *
   * @param {Record<string, *>} props - Raw properties object from eufy-security-ws.
   * @returns {ReadonlyArray<Readonly<{ name: string, currentValue: *, targetValue: * }>>}
   */
  evaluateRecordingModeChanges(props) {
    if (this.recordingModeChecked || !props || typeof props !== 'object') {
      return Object.freeze([]);
    }
    if (!RECORDING_MODE_PROPERTIES.some((spec) => spec.name in props)) {
      return Object.freeze([]);
    }
    this.recordingModeChecked = true;

    const updates = [];
    for (const {name, coerce} of RECORDING_MODE_PROPERTIES) {
      const targetValue = this.hwRecordingCfg[name];
      if (targetValue !== null && targetValue !== undefined) {
        const cur = unwrapProperty(props[name]);
        if (cur === undefined || coerce(cur) !== targetValue) {
          updates.push(Object.freeze({name, currentValue: cur, targetValue}));
        }
      }
    }
    return Object.freeze(updates);
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
