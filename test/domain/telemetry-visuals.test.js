/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the pure telemetry visual resolvers (src/domain/telemetry-visuals.js): charging state parsing, Wi-Fi
 * tiers, and the status, battery, Wi-Fi, and temperature colors of the status card.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');

const {COLOR_WHITE, COLOR_RED, COLOR_GREY, COLOR_BLUE, COLOR_YELLOW, COLOR_PURPLE} = require('../../src/config');
const visuals = require('../../src/domain/telemetry-visuals');
const telemetry = require('../../src/domain/telemetry');

const THRESHOLDS = {lowBatThreshold: 20, criticalBatThreshold: 5};

/**
 * Picks the listed keys of the evaluated state so each resolver is checked through evaluateTelemetryState.
 *
 * @param {string} title - Card title.
 * @param {Record<string, *>} status - Telemetry status input.
 * @param {string[]} keys - Output keys to keep.
 * @returns {Record<string, *>}
 */
function evaluate(title, status, keys) {
  const state = visuals.evaluateTelemetryState(title, {telCfg: {enabled: true}, ...status});
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

const STATUS_KEYS = ['statusKind', 'statusRgb'];
const BATTERY_KEYS = ['hasBat', 'batPct', 'batRgb'];
const WIFI_KEYS = ['hasWifi', 'wifiBars', 'hasRssi', 'rssiNum', 'wifiRgb'];

const resolveStatusVisual = (title, economyMode, serviceDisrupted = false) =>
  evaluate(title, {economyMode, serviceDisrupted}, STATUS_KEYS);
const resolveBatteryVisual = (battery, charging, thresholds) =>
  evaluate('Asleep', {battery, charging, ...thresholds}, BATTERY_KEYS);
const resolveWifiVisual = (wifi, rssi) => evaluate('Asleep', {wifi, rssi}, WIFI_KEYS);

describe('parseChargingState', () => {
  it('maps Eufy chargingStatus values to a charging flag and a power label', () => {
    // Verify: Eufy chargingStatus codes 1/2/3/4 and boolean true map to canonical charging flags and labels.
    assert.deepEqual(visuals.parseChargingState({chgStatus: 1}), {charging: true, powerLabel: 'Charging'});
    assert.deepEqual(visuals.parseChargingState({chgStatus: 3}), {charging: true, powerLabel: 'Plugged'});
    assert.deepEqual(visuals.parseChargingState({chgStatus: 4}), {charging: true, powerLabel: 'Solar'});
    assert.deepEqual(visuals.parseChargingState({chgStatus: 2}), {charging: false, powerLabel: ''});
    assert.deepEqual(visuals.parseChargingState({chgStatus: true}), {charging: true, powerLabel: 'Charging'});
  });

  it('falls back to batteryIsCharging, then to the solar power source, then to the previous values', () => {
    // Verify: absent chargingStatus falls back to batteryIsCharging, powerSource, and prior charging state.
    assert.deepEqual(visuals.parseChargingState({chgStatus: null, chgBool: true}), {
      charging: true,
      powerLabel: 'Charging',
    });
    assert.deepEqual(
      visuals.parseChargingState({chgStatus: null, chgBool: false}, {charging: true, powerLabel: 'Plugged'}),
      {
        charging: false,
        powerLabel: '',
      }
    );
    assert.deepEqual(visuals.parseChargingState({pwrSrc: 1}), {charging: false, powerLabel: 'Solar'});
    assert.deepEqual(visuals.parseChargingState({pwrSrc: 0}, {charging: true, powerLabel: 'Plugged'}), {
      charging: true,
      powerLabel: 'Plugged',
    });
  });
});

describe('rssiToWifiSignalLevel', () => {
  it('maps whole dBm boundaries to 4, 3, 2, and 1 bars after rounding', () => {
    // Verify: maps whole dBm boundaries to 4, 3, 2, and 1 bars after rounding.
    assert.equal(visuals.rssiToWifiSignalLevel(-65), 4);
    assert.equal(visuals.rssiToWifiSignalLevel(-65.4), 4);
    assert.equal(visuals.rssiToWifiSignalLevel(-66), 3);
    assert.equal(visuals.rssiToWifiSignalLevel(-72), 3);
    assert.equal(visuals.rssiToWifiSignalLevel(-73), 2);
    assert.equal(visuals.rssiToWifiSignalLevel(-80), 2);
    assert.equal(visuals.rssiToWifiSignalLevel(-81), 1);
  });
});

describe('resolveStatusVisual', () => {
  it('resolves the kind and color of each card title', () => {
    // Verify: resolves the kind and color of each card title.
    assert.deepEqual(resolveStatusVisual('Live', false), {statusKind: 'live', statusRgb: COLOR_RED});
    assert.deepEqual(resolveStatusVisual('Backfill', false), {statusKind: 'backfill', statusRgb: COLOR_RED});
    assert.deepEqual(resolveStatusVisual('Waking Up...', false), {statusKind: 'waking', statusRgb: COLOR_BLUE});
    assert.deepEqual(resolveStatusVisual('Waiting', false), {statusKind: 'waiting', statusRgb: COLOR_YELLOW});
    assert.deepEqual(resolveStatusVisual('Asleep', false), {statusKind: 'asleep', statusRgb: COLOR_WHITE});
  });

  it('prefers disconnected over low battery and low battery over asleep', () => {
    // Verify: prefers disconnected over low battery and low battery over asleep.
    assert.deepEqual(resolveStatusVisual('Asleep', true, true), {
      statusKind: 'disconnected',
      statusRgb: COLOR_GREY,
    });
    assert.deepEqual(resolveStatusVisual('Asleep', true, false), {statusKind: 'low', statusRgb: COLOR_WHITE});
    assert.deepEqual(resolveStatusVisual('Live', true, true), {statusKind: 'live', statusRgb: COLOR_RED});
  });
});

describe('resolveBatteryVisual', () => {
  it('colors charging blue, unavailable grey, critical purple, low yellow, and healthy white', () => {
    // Verify: colors charging blue, unavailable grey, critical purple, low yellow, and healthy white.
    assert.deepEqual(resolveBatteryVisual(50, true, THRESHOLDS), {
      hasBat: true,
      batPct: 50,
      batRgb: COLOR_BLUE,
    });
    assert.deepEqual(resolveBatteryVisual(null, false, THRESHOLDS), {
      hasBat: false,
      batPct: 0,
      batRgb: COLOR_GREY,
    });
    assert.equal(resolveBatteryVisual(5, false, THRESHOLDS).batRgb, COLOR_PURPLE);
    assert.equal(resolveBatteryVisual(20, false, THRESHOLDS).batRgb, COLOR_YELLOW);
    assert.equal(resolveBatteryVisual(21, false, THRESHOLDS).batRgb, COLOR_WHITE);
  });

  it('clamps the percentage to 0..100', () => {
    // Verify: clamps the percentage to 0..100.
    assert.equal(resolveBatteryVisual(150, false, THRESHOLDS).batPct, 100);
    assert.equal(resolveBatteryVisual(-4, false, THRESHOLDS).batPct, 0);
  });
});

describe('resolveWifiVisual', () => {
  it('reports grey and zero bars when neither bars nor RSSI are known', () => {
    // Verify: reports grey and zero bars when neither bars nor RSSI are known.
    assert.deepEqual(resolveWifiVisual(null, null), {
      hasWifi: false,
      wifiBars: 0,
      hasRssi: false,
      rssiNum: null,
      wifiRgb: COLOR_GREY,
    });
  });

  it('uses the reported bars without RSSI and lets a present RSSI win', () => {
    // Verify: uses the reported bars without RSSI and lets a present RSSI win.
    assert.equal(resolveWifiVisual(3, null).wifiBars, 3);
    assert.equal(resolveWifiVisual(3, null).wifiRgb, COLOR_WHITE);
    assert.equal(resolveWifiVisual(1, null).wifiRgb, COLOR_YELLOW);
    const strongBarsWeakRssi = resolveWifiVisual(4, -90);
    assert.equal(strongBarsWeakRssi.wifiBars, 1);
    assert.equal(strongBarsWeakRssi.wifiRgb, COLOR_YELLOW);
    assert.equal(strongBarsWeakRssi.rssiNum, -90);
    assert.equal(resolveWifiVisual(null, -70.4).rssiNum, -70);
  });
});

describe('resolveTempVisual', () => {
  it('colors cold blue, normal white, warm yellow, hot purple, and unavailable grey', () => {
    // Verify: colors cold blue, normal white, warm yellow, hot purple, and unavailable grey.
    assert.equal(visuals.resolveTempVisual(5).tempRgb, COLOR_BLUE);
    assert.equal(visuals.resolveTempVisual(6).tempRgb, COLOR_WHITE);
    assert.equal(visuals.resolveTempVisual(35).tempRgb, COLOR_WHITE);
    assert.equal(visuals.resolveTempVisual(36).tempRgb, COLOR_YELLOW);
    assert.equal(visuals.resolveTempVisual(44).tempRgb, COLOR_YELLOW);
    assert.equal(visuals.resolveTempVisual(45).tempRgb, COLOR_PURPLE);
    assert.deepEqual(visuals.resolveTempVisual(null), {hasTemp: false, tempNum: null, tempRgb: COLOR_GREY});
  });
});

describe('evaluateTelemetryState and the telemetry module exports', () => {
  it('combines the status, battery, Wi-Fi, and temperature visuals', () => {
    // Verify: combines the status, battery, Wi-Fi, and temperature visuals.
    const state = visuals.evaluateTelemetryState('Asleep', {
      telCfg: {enabled: true},
      battery: 15,
      lowBatThreshold: 20,
      criticalBatThreshold: 5,
      economyMode: true,
      rssi: -70,
      temp: 40,
    });
    assert.equal(state.statusKind, 'low');
    assert.equal(state.batRgb, COLOR_YELLOW);
    assert.equal(state.wifiBars, 3);
    assert.equal(state.tempRgb, COLOR_YELLOW);
  });

  it('keeps exporting the resolvers and enums that other modules import from the telemetry module', () => {
    // Verify: keeps exporting the resolvers and enums that other modules import from the telemetry module.
    assert.equal(telemetry.evaluateTelemetryState, visuals.evaluateTelemetryState);
    assert.equal(telemetry.STATUS_KINDS, visuals.STATUS_KINDS);
    assert.equal(telemetry.POWER_LABELS, visuals.POWER_LABELS);
    assert.equal(telemetry.EUFY_CHARGING_STATUS, visuals.EUFY_CHARGING_STATUS);
    assert.equal(telemetry.EUFY_POWER_SOURCES, visuals.EUFY_POWER_SOURCES);
    assert.equal(telemetry.WIFI_SIGNAL_LEVELS, visuals.WIFI_SIGNAL_LEVELS);
  });
});
