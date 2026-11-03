// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
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
  LOW_BAT_THRESHOLD,
  COLOR_RED,
  COLOR_GREY,
  COLOR_GREEN,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_PURPLE,
  resolveTelemetryConfig,
} = require('../config');

const RSSI_STRONG_DBM = -65;
const RSSI_GOOD_DBM = -72;
const RSSI_FAIR_DBM = -80;
const DEFAULT_LOW_BAT_CUTOFF_PCT = 20;
const HEALTHY_BAT_THRESHOLD_PCT = 50;
const BATTERY_SWAP_DELTA_PCT = 10;
const TEMP_COLD_MAX_C = 5;
const TEMP_NORMAL_MAX_C = 35;
const TEMP_WARM_MAX_C = 45;
const TEL_BAT_LABEL_OFFSET_X = 45;
const TEL_WIFI_LABEL_OFFSET_X = 38;
const TEL_TEXT_CHAR_WIDTH = 11;
const TEL_TEMP_CHAR_WIDTH = 12;

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
      powerLabel = 'Charging';
    } else {
      switch (Number(chgStatus)) {
        case 1:
          charging = true;
          powerLabel = 'Charging';
          break;
        case 3:
          charging = true;
          powerLabel = 'Plugged';
          break;
        case 4:
          charging = true;
          powerLabel = 'Solar';
          break;
        case 2:
        default:
          charging = false;
          powerLabel = '';
          break;
      }
    }
  } else if (chgBool !== undefined && chgBool !== null) {
    charging = Boolean(chgBool);
    if (charging && !powerLabel) {
      powerLabel = 'Charging';
    } else if (!charging) {
      powerLabel = '';
    }
  }

  if (pwrSrc !== undefined && pwrSrc !== null && Number(pwrSrc) === 1 && !powerLabel) {
    powerLabel = 'Solar';
  }

  return {charging, powerLabel};
}

/**
 * Derives a 1..4 Wi-Fi signal bar count from a raw dBm RSSI reading when wifiSignalLevel is absent.
 *
 * @param {number} dbm - Wi-Fi RSSI in dBm.
 * @returns {number}
 */
function rssiToWifiSignalLevel(dbm) {
  if (dbm >= RSSI_STRONG_DBM) return 4;
  if (dbm >= RSSI_GOOD_DBM) return 3;
  if (dbm >= RSSI_FAIR_DBM) return 2;
  return 1;
}

const rssiToBars = rssiToWifiSignalLevel;

/**
 * Resolves the status kind and RGB color for a card title ('Live', 'Waking Up...', 'Waiting', 'Asleep').
 *
 * @param {string} titleText - Card heading string.
 * @param {boolean} economyMode - Whether the camera is in low-battery economy mode.
 * @returns {{ statusKind: 'live'|'waking'|'waiting'|'low'|'asleep', statusRgb: number[] }}
 */
function resolveStatusVisual(titleText, economyMode) {
  if (/^Live\b/i.test(titleText)) {
    return {statusKind: 'live', statusRgb: COLOR_RED};
  }
  if (/Waking/i.test(titleText)) {
    return {statusKind: 'waking', statusRgb: COLOR_BLUE};
  }
  if (/Waiting/i.test(titleText)) {
    return {statusKind: 'waiting', statusRgb: COLOR_YELLOW};
  }
  if (economyMode || /Low Battery/i.test(titleText)) {
    return {statusKind: 'low', statusRgb: COLOR_PURPLE};
  }
  return {statusKind: 'asleep', statusRgb: COLOR_GREY};
}

/**
 * Resolves the battery percentage, RGB color, and FFmpeg drawtext hex color.
 *
 * @param {*} batRaw - Raw battery value.
 * @param {boolean} charging - Whether the camera is actively charging.
 * @returns {{ hasBat: boolean, batPct: number, batRgb: number[], batHex: string }}
 */
function resolveBatteryVisual(batRaw, charging) {
  const redBatCutoff = LOW_BAT_THRESHOLD > 0 ? LOW_BAT_THRESHOLD : DEFAULT_LOW_BAT_CUTOFF_PCT;
  const hasBat = batRaw != null && !Number.isNaN(Number(batRaw));
  const batPct = hasBat ? clampNum(Math.round(Number(batRaw)), 0, 100, 0) : 0;

  if (charging) {
    return {hasBat, batPct, batRgb: COLOR_BLUE, batHex: '0x38bdf8'};
  }
  if (!hasBat || batPct <= redBatCutoff) {
    return {hasBat, batPct, batRgb: COLOR_PURPLE, batHex: '0xe879f9'};
  }
  if (batPct >= HEALTHY_BAT_THRESHOLD_PCT) {
    return {hasBat, batPct, batRgb: COLOR_GREEN, batHex: '0x4ade80'};
  }
  return {hasBat, batPct, batRgb: COLOR_YELLOW, batHex: '0xfacc15'};
}

/**
 * Resolves the Wi-Fi bar count, RSSI integer, and semantic signal RGB color.
 *
 * @param {*} wifiRaw - Raw wifiSignalLevel (0..4).
 * @param {*} rssiRaw - Raw wifiRssi in dBm.
 * @returns {{ hasWifi: boolean, wifiBars: number, hasRssi: boolean, rssiNum: number|null, wifiRgb: number[] }}
 */
function resolveWifiVisual(wifiRaw, rssiRaw) {
  const hasWifi = wifiRaw != null && !Number.isNaN(Number(wifiRaw));
  const hasRssi = rssiRaw != null && !Number.isNaN(Number(rssiRaw));
  const rssiNum = hasRssi ? Math.round(Number(rssiRaw)) : null;

  const rawBars = hasWifi ? clampNum(Math.round(Number(wifiRaw)), 0, 4, 0) : 0;
  const effectiveLevel = hasRssi ? rssiToBars(rssiNum) : rawBars;
  const wifiBars = effectiveLevel;
  let wifiRgb = COLOR_PURPLE;
  switch (effectiveLevel) {
    case 4:
      wifiRgb = COLOR_GREEN;
      break;
    case 3:
      wifiRgb = COLOR_BLUE;
      break;
    case 2:
      wifiRgb = COLOR_YELLOW;
      break;
    default:
      wifiRgb = COLOR_PURPLE;
      break;
  }

  return {hasWifi, wifiBars, hasRssi, rssiNum, wifiRgb};
}

/**
 * Resolves the battery temperature integer, RGB color, and FFmpeg drawtext hex color.
 *
 * @param {*} tempRaw - Raw temperature in Celsius.
 * @returns {{ hasTemp: boolean, tempNum: number|null, tempRgb: number[], tempHex: string }}
 */
function resolveTempVisual(tempRaw) {
  const hasTemp = tempRaw != null && !Number.isNaN(Number(tempRaw));
  const tempNum = hasTemp ? Math.round(Number(tempRaw)) : null;

  if (!hasTemp) {
    return {hasTemp: false, tempNum: null, tempRgb: COLOR_GREEN, tempHex: '0xd4d4d8'};
  }
  if (tempNum <= TEMP_COLD_MAX_C) {
    return {hasTemp, tempNum, tempRgb: COLOR_BLUE, tempHex: '0x38bdf8'};
  }
  if (tempNum <= TEMP_NORMAL_MAX_C) {
    return {hasTemp, tempNum, tempRgb: COLOR_GREEN, tempHex: '0xd4d4d8'};
  }
  if (tempNum < TEMP_WARM_MAX_C) {
    return {hasTemp, tempNum, tempRgb: COLOR_YELLOW, tempHex: '0xfacc15'};
  }
  return {hasTemp, tempNum, tempRgb: COLOR_PURPLE, tempHex: '0xe879f9'};
}

/**
 * Evaluates the 6-color semantic state (Red, Grey, Green, Blue, Yellow, Purple) for camera status,
 * battery, Wi-Fi/RSSI, and temperature.
 *
 * @param {string} titleText - Card heading ('Asleep', 'Waking Up...', 'Waiting', 'Live', etc.).
 * @param {Record<string, *>|null} status - Camera telemetry state object.
 * @returns {Record<string, *>} Evaluated values and RGB colors for status, battery, wifi, temp, and lastSeen.
 */
function evaluateTelemetryState(titleText, status) {
  const telCfg = status && status.telCfg ? status.telCfg : {enabled: false};
  const charging = Boolean(status && status.charging);
  const economyMode = Boolean(status && status.economyMode);
  const seenVal = status && status.lastSeen ? status.lastSeen : '';
  const powerLabel = (status && status.powerLabel) || '';

  const statusVis = resolveStatusVisual(titleText, economyMode);
  const batVis = resolveBatteryVisual(status ? status.battery : null, charging);
  const wifiVis = resolveWifiVisual(status ? status.wifi : null, status ? status.rssi : null);
  const tempVis = resolveTempVisual(status ? status.temp : null);

  return {
    telCfg,
    charging,
    economyMode,
    powerLabel,
    seenVal,
    ...statusVis,
    ...batVis,
    ...wifiVis,
    ...tempVis,
  };
}

/**
 * Formats the suffix text appended to the battery percentage in the 'default' theme.
 *
 * @param {Record<string, *>} st - Evaluated telemetry state.
 * @returns {string}
 */
function formatBatteryPowerSuffix(st) {
  if (st.telCfg.powerSource && st.powerLabel) {
    return ' ' + st.powerLabel;
  }
  if (st.charging) {
    return ' Charging';
  }
  if (st.economyMode) {
    return ' Eco';
  }
  return '';
}

/**
 * Builds the list of enabled telemetry segments for rendering in the 'default' theme.
 *
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @returns {Array<Record<string, *>>} Array of telemetry segment descriptors.
 */
function buildTelemetrySegments(st) {
  const {telCfg} = st;
  if (!telCfg.enabled) {
    return [];
  }

  const segments = [];
  if (telCfg.battery && st.hasBat) {
    const label = st.batPct + '%' + formatBatteryPowerSuffix(st);
    segments.push({
      type: 'bat',
      batPct: st.batPct,
      charging: st.charging,
      showBolt: Boolean(telCfg.powerSource && (st.charging || st.powerLabel)),
      batHex: st.batHex,
      batRgb: st.batRgb,
      label,
      width: TEL_BAT_LABEL_OFFSET_X + label.length * TEL_TEXT_CHAR_WIDTH,
    });
  }

  if (telCfg.wifi && (st.hasWifi || st.hasRssi)) {
    const showRssi = telCfg.rssi && st.hasRssi;
    const label = showRssi ? st.rssiNum + ' dBm' : 'Wi-Fi';
    segments.push({
      type: 'wifi',
      wifiBars: st.wifiBars,
      wifiRgb: st.wifiRgb,
      label,
      width: TEL_WIFI_LABEL_OFFSET_X + label.length * TEL_TEXT_CHAR_WIDTH,
    });
  }

  if (telCfg.temperature && st.hasTemp) {
    const label = st.tempNum + '°C';
    segments.push({
      type: 'temp',
      tempHex: st.tempHex,
      tempRgb: st.tempRgb,
      tempNum: st.tempNum,
      label,
      width: label.length * TEL_TEMP_CHAR_WIDTH,
    });
  }

  if (telCfg.lastSeen && st.seenVal) {
    const label = 'Last live ' + st.seenVal;
    segments.push({
      type: 'seen',
      seenVal: st.seenVal,
      label,
      width: label.length * TEL_TEXT_CHAR_WIDTH,
    });
  }

  return segments;
}

/**
 * Domain model representing a camera's live telemetry readings and display preferences.
 */
class Telemetry {
  /**
   * @param {Record<string, *>} rawCamCfg - Camera entry from config.json.
   * @param {string} [initialLastSeen=''] - Initial lastSeen 'HH:MM' string from snapshot cache.
   */
  constructor(rawCamCfg = {}, initialLastSeen = '') {
    this.config = resolveTelemetryConfig(rawCamCfg);
    this.battery = null;
    this.charging = false;
    this.powerLabel = '';
    this.wifi = null;
    this.rssi = null;
    this.temp = null;
    this.lastSeen = initialLastSeen;
    this.lastLowBatRefreshAt = 0;
    this.qualityChecked = false;
  }

  /**
   * Returns true if battery level is at or below LOW_BAT_THRESHOLD and not charging.
   *
   * @returns {boolean}
   */
  isLowBattery() {
    if (LOW_BAT_THRESHOLD <= 0 || this.charging || this.battery === null) {
      return false;
    }
    const level = Number(this.battery);
    return !Number.isNaN(level) && level <= LOW_BAT_THRESHOLD;
  }

  /**
   * Applies raw Eufy device properties to this Telemetry model and returns change flags.
   *
   * @param {Record<string, *>} props - Properties object from eufy-security-ws.
   * @returns {{ hadInitialTelemetry: boolean, prevBattery: number|null, nowLowBat: boolean, stateChanged: boolean, minorTelemetryChanged: boolean, model: *, swVer: * }}
   */
  applyProperties(props) {
    const hadInitialTelemetry = this.battery !== null;
    const prevBattery = this.battery;
    const prevCharging = this.charging;
    const prevWifi = this.wifi;
    const prevRssi = this.rssi;
    const prevTemp = this.temp;
    const wasLowBat = this.isLowBattery();

    const bat = unwrapProperty(props.battery ?? props.batteryLevel);
    const chgStatus = unwrapProperty(props.chargingStatus);
    const chgBool = unwrapProperty(props.batteryIsCharging);
    const pwrSrc = unwrapProperty(props.powerSource);
    const wifi = unwrapProperty(props.wifiSignalLevel ?? props.cellularSignalLevel);
    const rssi = unwrapProperty(props.wifiRssi ?? props.cellularRSSI);
    const temp = unwrapProperty(props.batteryTemperature ?? props.temperature);
    const model = unwrapProperty(props.model);
    const swVer = unwrapProperty(props.softwareVersion);

    if (bat !== undefined && bat !== null) {
      this.battery = Number(bat);
    }

    const parsedCharge = parseChargingState(
        chgStatus,
        chgBool,
        pwrSrc,
        this.charging,
        this.powerLabel
    );
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

    const nowLowBat = this.isLowBattery();
    const batterySwapped =
        prevBattery !== null && this.battery !== null && Math.abs(this.battery - prevBattery) >= BATTERY_SWAP_DELTA_PCT;
    const stateChanged =
        hadInitialTelemetry &&
        (wasLowBat !== nowLowBat || prevCharging !== this.charging || batterySwapped);
    const minorTelemetryChanged =
        hadInitialTelemetry &&
        !stateChanged &&
        (prevBattery !== this.battery ||
            prevWifi !== this.wifi ||
            prevRssi !== this.rssi ||
            prevTemp !== this.temp);

    return {
      hadInitialTelemetry,
      prevBattery,
      nowLowBat,
      stateChanged,
      minorTelemetryChanged,
      model,
      swVer,
    };
  }

  /**
   * Builds a plain status snapshot object used by the card renderer.
   *
   * @param {string} camName - Camera internal name.
   * @param {string} camTitle - Camera display title.
   * @param {Record<string, *>} cardCfg - Resolved card configuration.
   * @returns {Record<string, *>}
   */
  toStatusSnapshot(camName, camTitle, cardCfg) {
    return {
      camName,
      camTitle,
      cardCfg,
      telCfg: this.config,
      battery: this.battery,
      charging: this.charging,
      powerLabel: this.powerLabel,
      economyMode: this.isLowBattery(),
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
      battery: this.battery,
      charging: this.charging,
      powerLabel: this.powerLabel,
      economyMode: this.isLowBattery(),
      wifi: this.wifi,
      rssi: this.rssi,
      temp: this.temp,
      lastSeen: this.lastSeen,
    });
  }
}

module.exports = {
  TEL_BAT_LABEL_OFFSET_X,
  TEL_WIFI_LABEL_OFFSET_X,
  TEL_TEXT_CHAR_WIDTH,
  Telemetry,
  unwrapProperty,
  parseChargingState,
  rssiToWifiSignalLevel,
  rssiToBars,
  resolveStatusVisual,
  resolveBatteryVisual,
  resolveWifiVisual,
  resolveTempVisual,
  evaluateTelemetryState,
  formatBatteryPowerSuffix,
  buildTelemetrySegments,
};
