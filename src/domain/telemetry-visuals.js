// @ts-check
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Pure telemetry visual resolvers: Eufy charging state parsing, Wi-Fi signal tiers, and the status, battery, Wi-Fi,
 * and temperature colors (6-color semantic evaluation) of the camera status card. No camera state is read or written.
 */
'use strict';

const {
  clampNum,
  CARD_STATUS_TITLES,
  LOW_BAT_THRESHOLD,
  CRITICAL_BAT_THRESHOLD,
  COLOR_WHITE,
  COLOR_RED,
  COLOR_GREY,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_PURPLE,
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
const TEMP_COLD_MAX_C = 5;
const TEMP_NORMAL_MAX_C = 35;
const TEMP_WARM_MAX_C = 45;

const BACKFILL_TITLE_REGEX = /^Backfill\b/i;
const LIVE_TITLE_REGEX = /^Live\b/i;
const WAKING_TITLE_REGEX = /Waking/i;
const WAITING_TITLE_REGEX = /Waiting/i;
const DISCONNECTED_TITLE_REGEX = /Disconnected/i;
const LOW_BATTERY_TITLE_REGEX = /Low Battery/i;

/**
 * Parses Eufy chargingStatus (1=CHARGING, 2=UNPLUGGED, 3=PLUGGED, 4=SOLAR_CHARGING),
 * batteryIsCharging boolean, and powerSource into { charging, powerLabel }.
 *
 * @param {{ chgStatus?: unknown, chgBool?: unknown, pwrSrc?: unknown }} raw - Unwrapped charging properties
 *   (chgStatus: chargingStatus; chgBool: batteryIsCharging; pwrSrc: powerSource).
 * @param {{ charging?: boolean, powerLabel?: string }} [prev={}] - Previous charging state and powerLabel on camera.
 * @returns {{ charging: boolean, powerLabel: string }}
 */
function parseChargingState(raw, prev = {}) {
  const {chgStatus, chgBool, pwrSrc} = raw || {};
  let charging = Boolean(prev.charging);
  let powerLabel = prev.powerLabel || '';

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
 * Derives a 1..4 Wi-Fi signal bar count from a raw dBm RSSI reading (used whenever wifiRssi is present). The reading
 * is rounded to whole dBm first, so the stored tier and the card visual always agree on the boundaries.
 *
 * @param {number} dbm - Wi-Fi RSSI in dBm.
 * @returns {number}
 */
function rssiToWifiSignalLevel(dbm) {
  const wholeDbm = Math.round(dbm);
  if (wholeDbm >= RSSI_STRONG_DBM) return WIFI_SIGNAL_LEVELS.FULL;
  if (wholeDbm >= RSSI_GOOD_DBM) return WIFI_SIGNAL_LEVELS.GOOD;
  if (wholeDbm >= RSSI_FAIR_DBM) return WIFI_SIGNAL_LEVELS.FAIR;
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

module.exports = {
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
};
