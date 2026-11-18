// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Telemetry domain model encapsulating camera sensor readings (battery, charging,
 * power source, Wi-Fi bars, RSSI, temperature, lastSeen), Eufy property parsing,
 * low-battery economy rules, and 6-color semantic visual evaluation.
 */
'use strict';

const {
  clampNum,
  CARD_THEMES,
  CARD_STATUS_TITLES,
  LOW_BAT_THRESHOLD,
  CRITICAL_BAT_THRESHOLD,
  COLOR_WHITE,
  COLOR_RED,
  COLOR_GREY,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_PURPLE,
  resolveCameraTimers,
  resolveTelemetryConfig,
  resolveHardwareRecordingConfig,
} = require('../config');

/**
 * Internal semantic visual status kinds (distinct from user-facing CARD_STATUS_TITLES and STREAM_MODES).
 *
 * @readonly
 * @enum {string}
 */
const STATUS_KINDS = Object.freeze({
  LIVE: 'live',
  BACKFILL: 'backfill',
  WAKING: 'waking',
  WAITING: 'waiting',
  LOW_BATTERY: 'low',
  DISCONNECTED: 'disconnected',
  ASLEEP: 'asleep',
});

/**
 * Human-readable power source labels derived from Eufy chargingStatus and powerSource properties.
 *
 * @readonly
 * @enum {string}
 */
const POWER_LABELS = Object.freeze({
  CHARGING: 'Charging',
  PLUGGED: 'Plugged',
  SOLAR: 'Solar',
});
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

/**
 * Eufy hardware chargingStatus property values reported by eufy-security-ws.
 *
 * @readonly
 * @enum {number}
 */
const EUFY_CHARGING_STATUS = Object.freeze({
  CHARGING: 1,
  UNPLUGGED: 2,
  PLUGGED: 3,
  SOLAR: 4,
});

/**
 * Eufy hardware powerSource property values reported by eufy-security-ws.
 *
 * @readonly
 * @enum {number}
 */
const EUFY_POWER_SOURCES = Object.freeze({
  BATTERY: 0,
  SOLAR: 1,
});

/**
 * Discrete Wi-Fi signal bar tiers (0..4) displayed on status cards and telemetry logs.
 *
 * @readonly
 * @enum {number}
 */
const WIFI_SIGNAL_LEVELS = Object.freeze({
  NONE: 0,
  WEAK: 1,
  FAIR: 2,
  GOOD: 3,
  FULL: 4,
});

const MIN_BATTERY_PCT = 0;
const MAX_BATTERY_PCT = 100;
const RSSI_STRONG_DBM = -65;
const RSSI_GOOD_DBM = -72;
const RSSI_FAIR_DBM = -80;
const DEFAULT_LOW_BAT_CUTOFF_PCT = 30;
const DEFAULT_CRITICAL_BAT_CUTOFF_PCT = 5;
const BATTERY_SWAP_DELTA_PCT = 10;
const TEMP_COLD_MAX_C = 5;
const TEMP_NORMAL_MAX_C = 35;
const TEMP_WARM_MAX_C = 45;
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

const BACKFILL_TITLE_REGEX = /^Backfill\b/i;
const LIVE_TITLE_REGEX = /^Live\b/i;
const WAKING_TITLE_REGEX = /Waking/i;
const WAITING_TITLE_REGEX = /Waiting/i;
const DISCONNECTED_TITLE_REGEX = /Disconnected/i;
const LOW_BATTERY_TITLE_REGEX = /Low Battery/i;
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
 * Parses Eufy chargingStatus (1=CHARGING, 2=UNPLUGGED, 3=PLUGGED, 4=SOLAR_CHARGING),
 * batteryIsCharging boolean, and powerSource into { charging, powerLabel }.
 *
 * @param {*} chgStatus - Unwrapped chargingStatus property.
 * @param {*} chgBool - Unwrapped batteryIsCharging property.
 * @param {*} pwrSrc - Unwrapped powerSource property.
 * @param {boolean} [prevCharging=false] - Previous charging state on the camera.
 * @param {string} [prevLabel=''] - Previous powerLabel on the camera.
 * @returns {{ charging: boolean, powerLabel: string }}
 */
function parseChargingState(chgStatus, chgBool, pwrSrc, prevCharging = false, prevLabel = '') {
  let charging = prevCharging;
  let powerLabel = prevLabel;

  if (chgStatus !== undefined && chgStatus !== null) {
    if (chgStatus === true) {
      charging = true;
      powerLabel = POWER_LABELS.CHARGING;
    } else {
      switch (Number(chgStatus)) {
        case EUFY_CHARGING_STATUS.CHARGING:
          charging = true;
          powerLabel = POWER_LABELS.CHARGING;
          break;
        case EUFY_CHARGING_STATUS.PLUGGED:
          charging = true;
          powerLabel = POWER_LABELS.PLUGGED;
          break;
        case EUFY_CHARGING_STATUS.SOLAR:
          charging = true;
          powerLabel = POWER_LABELS.SOLAR;
          break;
        case EUFY_CHARGING_STATUS.UNPLUGGED:
        default:
          charging = false;
          powerLabel = '';
          break;
      }
    }
  } else if (chgBool !== undefined && chgBool !== null) {
    charging = Boolean(chgBool);
    if (charging && !powerLabel) {
      powerLabel = POWER_LABELS.CHARGING;
    } else if (!charging) {
      powerLabel = '';
    }
  }

  if (pwrSrc !== undefined && pwrSrc !== null && Number(pwrSrc) === EUFY_POWER_SOURCES.SOLAR && !powerLabel) {
    powerLabel = POWER_LABELS.SOLAR;
  }

  return Object.freeze({charging, powerLabel});
}

/**
 * Derives a 1..4 Wi-Fi signal bar count from a raw dBm RSSI reading (used whenever wifiRssi is present).
 *
 * @param {number} dbm - Wi-Fi RSSI in dBm.
 * @returns {number}
 */
function rssiToWifiSignalLevel(dbm) {
  if (dbm >= RSSI_STRONG_DBM) return WIFI_SIGNAL_LEVELS.FULL;
  if (dbm >= RSSI_GOOD_DBM) return WIFI_SIGNAL_LEVELS.GOOD;
  if (dbm >= RSSI_FAIR_DBM) return WIFI_SIGNAL_LEVELS.FAIR;
  return WIFI_SIGNAL_LEVELS.WEAK;
}

/**
 * Resolves the status kind and RGB color for a card title
 * ('Live', 'Backfill', 'Waking Up...', 'Waiting', 'Disconnected', 'Asleep').
 *
 * @param {string} titleText - Card heading string.
 * @param {boolean} economyMode - Whether the camera is in low-battery economy mode.
 * @param {boolean} [serviceDisrupted=false] - Whether WS, HomeBase/camera, Frigate, or go2rtc is down.
 * @returns {Readonly<{
 *   statusKind: 'live'|'backfill'|'waking'|'waiting'|'low'|'disconnected'|'asleep',
 *   statusRgb: readonly number[]
 * }>}
 */
function resolveStatusVisual(titleText, economyMode, serviceDisrupted = false) {
  if (titleText === CARD_STATUS_TITLES.BACKFILL || BACKFILL_TITLE_REGEX.test(titleText)) {
    return Object.freeze({statusKind: STATUS_KINDS.BACKFILL, statusRgb: COLOR_RED});
  }
  if (titleText === CARD_STATUS_TITLES.LIVE || LIVE_TITLE_REGEX.test(titleText)) {
    return Object.freeze({statusKind: STATUS_KINDS.LIVE, statusRgb: COLOR_RED});
  }
  if (titleText === CARD_STATUS_TITLES.WAKING_UP || WAKING_TITLE_REGEX.test(titleText)) {
    return Object.freeze({statusKind: STATUS_KINDS.WAKING, statusRgb: COLOR_BLUE});
  }
  if (titleText === CARD_STATUS_TITLES.WAITING || WAITING_TITLE_REGEX.test(titleText)) {
    return Object.freeze({statusKind: STATUS_KINDS.WAITING, statusRgb: COLOR_YELLOW});
  }
  if (serviceDisrupted || titleText === CARD_STATUS_TITLES.DISCONNECTED || DISCONNECTED_TITLE_REGEX.test(titleText)) {
    return Object.freeze({statusKind: STATUS_KINDS.DISCONNECTED, statusRgb: COLOR_GREY});
  }
  if (economyMode || titleText === CARD_STATUS_TITLES.ASLEEP_LOW_BATTERY || LOW_BATTERY_TITLE_REGEX.test(titleText)) {
    return Object.freeze({statusKind: STATUS_KINDS.LOW_BATTERY, statusRgb: COLOR_WHITE});
  }
  return Object.freeze({statusKind: STATUS_KINDS.ASLEEP, statusRgb: COLOR_WHITE});
}

/**
 * Resolves the battery percentage and RGB color (sky-blue when charging,
 * calm white when unplugged and healthy, yellow at/below lowBatThreshold,
 * purple at/below criticalBatThreshold, grey when unavailable).
 *
 * @param {*} batRaw - Raw battery value.
 * @param {boolean} charging - Whether the camera is actively charging.
 * @param {{ lowBatThreshold?: number, criticalBatThreshold?: number }} [thresholds={}] - Battery thresholds.
 * @returns {Readonly<{ hasBat: boolean, batPct: number, batRgb: readonly number[] }>}
 */
function resolveBatteryVisual(batRaw, charging, thresholds = {}) {
  const lowBatThreshold = thresholds.lowBatThreshold !== undefined ? thresholds.lowBatThreshold : LOW_BAT_THRESHOLD;
  const criticalBatThreshold =
    thresholds.criticalBatThreshold !== undefined ? thresholds.criticalBatThreshold : CRITICAL_BAT_THRESHOLD;
  const lowBatCutoff = lowBatThreshold > MIN_BATTERY_PCT ? lowBatThreshold : DEFAULT_LOW_BAT_CUTOFF_PCT;
  const critBatCutoff =
    criticalBatThreshold > MIN_BATTERY_PCT
      ? Math.min(criticalBatThreshold, lowBatCutoff - 1)
      : Math.min(DEFAULT_CRITICAL_BAT_CUTOFF_PCT, lowBatCutoff - 1);
  const hasBat = batRaw != null && !Number.isNaN(Number(batRaw));
  const batPct = hasBat
    ? clampNum(Math.round(Number(batRaw)), MIN_BATTERY_PCT, MAX_BATTERY_PCT, MIN_BATTERY_PCT)
    : MIN_BATTERY_PCT;

  if (charging) {
    return Object.freeze({hasBat, batPct, batRgb: COLOR_BLUE});
  }
  if (!hasBat) {
    return Object.freeze({hasBat, batPct, batRgb: COLOR_GREY});
  }
  if (batPct <= critBatCutoff) {
    return Object.freeze({hasBat, batPct, batRgb: COLOR_PURPLE});
  }
  if (batPct <= lowBatCutoff) {
    return Object.freeze({hasBat, batPct, batRgb: COLOR_YELLOW});
  }
  return Object.freeze({hasBat, batPct, batRgb: COLOR_WHITE});
}

/**
 * Resolves the Wi-Fi bar count, RSSI integer, and semantic signal RGB color
 * (calm white for 2..4 bars, amber yellow for weak <= 1 bar, grey when unavailable).
 *
 * @param {*} wifiRaw - Raw wifiSignalLevel (0..4).
 * @param {*} rssiRaw - Raw wifiRssi in dBm.
 * @returns {Readonly<{
 *   hasWifi: boolean,
 *   wifiBars: number,
 *   hasRssi: boolean,
 *   rssiNum: number|null,
 *   wifiRgb: readonly number[]
 * }>}
 */
function resolveWifiVisual(wifiRaw, rssiRaw) {
  const hasWifi = wifiRaw != null && !Number.isNaN(Number(wifiRaw));
  const hasRssi = rssiRaw != null && !Number.isNaN(Number(rssiRaw));
  const rssiNum = hasRssi ? Math.round(Number(rssiRaw)) : null;

  if (!hasWifi && !hasRssi) {
    return Object.freeze({
      hasWifi: false,
      wifiBars: WIFI_SIGNAL_LEVELS.NONE,
      hasRssi: false,
      rssiNum: null,
      wifiRgb: COLOR_GREY,
    });
  }

  const rawBars = hasWifi
    ? clampNum(Math.round(Number(wifiRaw)), WIFI_SIGNAL_LEVELS.NONE, WIFI_SIGNAL_LEVELS.FULL, WIFI_SIGNAL_LEVELS.NONE)
    : WIFI_SIGNAL_LEVELS.NONE;
  const effectiveLevel = hasRssi ? rssiToWifiSignalLevel(rssiNum) : rawBars;
  const wifiBars = effectiveLevel;
  const wifiRgb = effectiveLevel <= WIFI_SIGNAL_LEVELS.WEAK ? COLOR_YELLOW : COLOR_WHITE;

  return Object.freeze({hasWifi, wifiBars, hasRssi, rssiNum, wifiRgb});
}

/**
 * Resolves the battery temperature integer and RGB color
 * (calm white for normal 6..35C, sky-blue <= 5C, amber 36..44C, purple >= 45C, grey when unavailable).
 *
 * @param {*} tempRaw - Raw temperature in Celsius.
 * @returns {Readonly<{ hasTemp: boolean, tempNum: number|null, tempRgb: readonly number[] }>}
 */
function resolveTempVisual(tempRaw) {
  const hasTemp = tempRaw != null && !Number.isNaN(Number(tempRaw));
  const tempNum = hasTemp ? Math.round(Number(tempRaw)) : null;

  if (!hasTemp) {
    return Object.freeze({hasTemp: false, tempNum: null, tempRgb: COLOR_GREY});
  }
  if (tempNum <= TEMP_COLD_MAX_C) {
    return Object.freeze({hasTemp, tempNum, tempRgb: COLOR_BLUE});
  }
  if (tempNum <= TEMP_NORMAL_MAX_C) {
    return Object.freeze({hasTemp, tempNum, tempRgb: COLOR_WHITE});
  }
  if (tempNum < TEMP_WARM_MAX_C) {
    return Object.freeze({hasTemp, tempNum, tempRgb: COLOR_YELLOW});
  }
  return Object.freeze({hasTemp, tempNum, tempRgb: COLOR_PURPLE});
}

/**
 * Evaluates the 6-color semantic state (White, Red, Grey, Blue, Yellow, Purple) for camera status,
 * battery, Wi-Fi/RSSI, and temperature.
 *
 * @param {string} titleText - Card heading ('Asleep', 'Waking Up...', 'Waiting', 'Live', etc.).
 * @param {Record<string, *>|null} status - Camera telemetry state object.
 * @returns {Readonly<Record<string, *>>} Evaluated values and RGB colors for status, battery, wifi, temp, and lastSeen.
 */
function evaluateTelemetryState(titleText, status) {
  const telCfg = status && status.telCfg ? status.telCfg : {enabled: false};
  const charging = Boolean(status && status.charging);
  const economyMode = Boolean(status && status.economyMode);
  const serviceDisrupted = Boolean(status && status.serviceDisrupted);
  const seenVal = status && status.lastSeen ? status.lastSeen : '';
  const powerLabel = (status && status.powerLabel) || '';

  const statusVis = resolveStatusVisual(titleText, economyMode, serviceDisrupted);
  const lowBatThreshold = status && status.lowBatThreshold !== undefined ? status.lowBatThreshold : LOW_BAT_THRESHOLD;
  const criticalBatThreshold =
    status && status.criticalBatThreshold !== undefined ? status.criticalBatThreshold : CRITICAL_BAT_THRESHOLD;
  const batVis = resolveBatteryVisual(status ? status.battery : null, charging, {
    lowBatThreshold,
    criticalBatThreshold,
  });
  const wifiVis = resolveWifiVisual(status ? status.wifi : null, status ? status.rssi : null);
  const tempVis = resolveTempVisual(status ? status.temp : null);

  return Object.freeze({
    telCfg,
    charging,
    economyMode,
    serviceDisrupted,
    powerLabel,
    seenVal,
    ...statusVis,
    ...batVis,
    ...wifiVis,
    ...tempVis,
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
   * Applies raw Eufy device properties to this Telemetry model and returns change flags.
   *
   * @param {Record<string, *>} props - Properties object from eufy-security-ws.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {{
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
   * }}
   */
  applyProperties(props, now = Date.now()) {
    const hadInitialTelemetry = this.battery !== null;
    const prevBattery = this.battery;
    const prevCharging = this.charging;
    const prevWifi = this.wifi;
    const prevRssi = this.rssi;
    const prevTemp = this.temp;
    const prevLight = this.lightOn;
    const wasLowBat = this.isLowBattery();
    const wasCritBat = this.isCriticalBattery();
    const wasOffline = this.isDeviceOffline();

    const devName = unwrapProperty(props.name);
    const devState = unwrapProperty(props.state);
    const bat = unwrapProperty(props.battery ?? props.batteryLevel);
    const chgStatus = unwrapProperty(props.chargingStatus);
    const chgBool = unwrapProperty(props.batteryIsCharging);
    const pwrSrc = unwrapProperty(props.powerSource);
    const wifi = unwrapProperty(props.wifiSignalLevel ?? props.cellularSignalLevel);
    const rssi = unwrapProperty(props.wifiRssi ?? props.cellularRSSI);
    const temp = unwrapProperty(props.batteryTemperature ?? props.temperature);
    const light = unwrapProperty(props.light);
    const hwPwrMode = unwrapProperty(props.powerWorkingMode);
    const hwClipLen = unwrapProperty(props.recordingClipLength);
    const hwEndEarly = unwrapProperty(props.recordingEndClipMotionStops);
    const hwQual = unwrapProperty(props.videoStreamingQuality ?? props.streamingQuality);
    const model = unwrapProperty(props.model);
    const swVer = unwrapProperty(props.softwareVersion);

    if (typeof light === 'boolean') {
      if (light && !this.lightOn) {
        this.lightOnAt = now;
      } else if (!light) {
        this.lightOnAt = 0;
      }
      this.lightOn = light;
    }
    if (hwPwrMode !== undefined && hwPwrMode !== null && !Number.isNaN(Number(hwPwrMode))) {
      this.hwPowerMode = Number(hwPwrMode);
    }
    if (hwClipLen !== undefined && hwClipLen !== null && !Number.isNaN(Number(hwClipLen))) {
      this.hwClipLength = Number(hwClipLen);
    }
    if (typeof hwEndEarly === 'boolean') {
      this.hwEndEarly = hwEndEarly;
    }
    if (hwQual !== undefined && hwQual !== null && !Number.isNaN(Number(hwQual))) {
      this.hwQuality = Number(hwQual);
    }

    if (devName && typeof devName === 'string') {
      this.deviceName = devName.trim();
    }
    if (model && typeof model === 'string') {
      this.model = model.trim();
    }
    if (swVer && typeof swVer === 'string') {
      this.firmware = swVer.trim();
    }

    if (devState !== undefined && devState !== null && !Number.isNaN(Number(devState))) {
      this.deviceState = Number(devState);
      if (this.deviceState === EUFY_DEVICE_STATES.ONLINE) {
        this.wakeTimedOutOffline = false;
      }
    }

    if (bat !== undefined && bat !== null) {
      this.battery = Number(bat);
    }

    const parsedCharge = parseChargingState(chgStatus, chgBool, pwrSrc, this.charging, this.powerLabel);
    this.charging = parsedCharge.charging;
    this.powerLabel = parsedCharge.powerLabel;

    if (rssi !== undefined && rssi !== null && Number(rssi) < 0) {
      this.rssi = Number(rssi);
    }

    if (this.rssi !== null) {
      this.wifi = rssiToWifiSignalLevel(this.rssi);
    } else if (wifi !== undefined && wifi !== null) {
      this.wifi = Number(wifi);
    }

    if (temp !== undefined && temp !== null) {
      this.temp = Number(temp);
    }

    const hasBatteryProp = bat !== undefined && bat !== null;
    const batteryIncreased =
      prevBattery !== null && this.battery !== null && this.battery > prevBattery && this.battery > 0;
    const batteryRiseSwapped = batteryIncreased && this.battery - prevBattery >= BATTERY_SWAP_DELTA_PCT;
    const canClearLowBatteryOffline = batteryRiseSwapped || !this.isLowBattery();
    const freshSensorChange =
      hadInitialTelemetry &&
      !('state' in props) &&
      ((prevBattery !== null && this.battery !== prevBattery && this.battery > 0) ||
        prevCharging !== this.charging ||
        prevRssi !== this.rssi ||
        prevTemp !== this.temp);
    if (
      this.charging ||
      batteryIncreased ||
      freshSensorChange ||
      (hasBatteryProp && !this.isLowBattery()) ||
      (!this.isReportedOfflineByState() && !this.isBatteryDepleted())
    ) {
      this.wakeTimedOutOffline = false;
      if (
        this.deviceState === EUFY_DEVICE_STATES.OFFLINE_LOWBAT &&
        (this.charging || (hasBatteryProp && canClearLowBatteryOffline))
      ) {
        this.deviceState = EUFY_DEVICE_STATES.ONLINE;
      } else if (this.deviceState === EUFY_DEVICE_STATES.OFFLINE && batteryIncreased && canClearLowBatteryOffline) {
        this.deviceState = EUFY_DEVICE_STATES.ONLINE;
      }
    }

    const nowLowBat = this.isLowBattery();
    const nowCritBat = this.isCriticalBattery();
    const nowOffline = this.isDeviceOffline();
    const offlineChanged = wasOffline !== nowOffline;
    const batterySwapped =
      prevBattery !== null && this.battery !== null && Math.abs(this.battery - prevBattery) >= BATTERY_SWAP_DELTA_PCT;
    const stateChanged =
      offlineChanged ||
      (hadInitialTelemetry &&
        (wasLowBat !== nowLowBat || wasCritBat !== nowCritBat || prevCharging !== this.charging || batterySwapped));
    const prevTempRgb = resolveTempVisual(prevTemp).tempRgb;
    const nextTempRgb = resolveTempVisual(this.temp).tempRgb;
    const wifiTierChanged = hadInitialTelemetry && (prevWifi !== this.wifi || prevTempRgb !== nextTempRgb);
    const minorTelemetryChanged =
      hadInitialTelemetry &&
      !stateChanged &&
      (prevBattery !== this.battery ||
        prevWifi !== this.wifi ||
        prevRssi !== this.rssi ||
        prevTemp !== this.temp ||
        prevLight !== this.lightOn);

    return Object.freeze({
      hadInitialTelemetry,
      prevBattery,
      nowLowBat,
      nowOffline,
      offlineChanged,
      stateChanged,
      wifiTierChanged,
      minorTelemetryChanged,
      model,
      swVer,
    });
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
  evaluateTelemetryState,
};
