/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for Telemetry property normalization, change detection, RSSI tiers, and 6-color semantic visuals.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {
  FRAME,
  PROCESS_SIGNALS,
  CARD_THEMES,
  CARD_POSITIONS,
  CARD_STATUS_TITLES,
  STREAM_MODES,
  COLOR_WHITE,
  COLOR_RED,
  COLOR_GREY,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_PURPLE,
} = require('../../src/config');
const {WAKE_KINDS, WakeRequest, Camera} = require('../../src/domain/camera');
const {
  STATUS_KINDS,
  POWER_LABELS,
  EUFY_CHARGING_STATUS,
  EUFY_POWER_SOURCES,
  WIFI_SIGNAL_LEVELS,
  Telemetry,
  unwrapProperty,
  parseTelemetryProperties,
  detectTelemetryChanges,
  evaluateTelemetryState,
} = require('../../src/domain/telemetry');
const {renderCameraCards} = require('../../src/overlay/card-renderer');

const SERIAL = 'T8161T0000000000';

/**
 * Builds a telemetry model that already holds healthy online readings.
 *
 * @returns {Telemetry}
 */
function createOnlineTelemetry() {
  const tel = new Telemetry({serial: SERIAL});
  tel.applyProperties({state: 1, battery: 80, wifiRssi: -60, wifiSignalLevel: 3});
  return tel;
}

describe('Telemetry Wi-Fi tier from RSSI', () => {
  it('uses the same integer-rounded dBm for the stored tier as the card visual does', () => {
    // Verify: -65.4 dBm rounds to -65 dBm (strong, 4 bars) on the card, so the stored tier must be 4 as well.
    // Otherwise the card shows 4 bars while the change detection believes 3 bars.
    const tel = new Telemetry({serial: SERIAL});
    tel.applyProperties({battery: 80, wifiRssi: -65.4});
    const visual = evaluateTelemetryState('Asleep', {telCfg: {enabled: true}, wifi: null, rssi: tel.rssi});
    assert.equal(visual.wifiBars, 4);
    assert.equal(tel.wifi, 4);
  });

  it('maps integer dBm boundaries to 4, 3, 2, and 1 bars', () => {
    // Verify: maps integer dBm boundaries to 4, 3, 2, and 1 bars.
    const expectations = [
      [-65, 4],
      [-66, 3],
      [-72, 3],
      [-73, 2],
      [-80, 2],
      [-81, 1],
    ];
    for (const [dbm, bars] of expectations) {
      const tel = new Telemetry({serial: SERIAL});
      tel.applyProperties({battery: 80, wifiRssi: dbm});
      assert.equal(tel.wifi, bars, 'rssi ' + dbm + ' must give ' + bars + ' bars');
    }
  });
});

describe('Telemetry RSSI reset on state-reported offline', () => {
  it('clears the stale RSSI and Wi-Fi tier when the camera reports low-battery offline (state=3)', () => {
    // Verify: a shut-off camera has no live radio link, so the last RSSI must not keep driving the Wi-Fi bars.
    const tel = createOnlineTelemetry();
    assert.equal(tel.rssi, -60);
    assert.equal(tel.wifi, 4);

    tel.applyProperties({state: 3, battery: 2, chargingStatus: 2});

    assert.equal(tel.isDeviceOffline(), true);
    assert.equal(tel.rssi, null);
    assert.equal(tel.wifi, null);
    assert.equal(tel.toStatusSummary().rssi_dbm, null);
  });

  it('clears an RSSI delivered in the same update as the offline state', () => {
    // Verify: clears an RSSI delivered in the same update as the offline state.
    const tel = createOnlineTelemetry();
    tel.applyProperties({state: 3, battery: 2, chargingStatus: 2, wifiRssi: -100});
    assert.equal(tel.isDeviceOffline(), true);
    assert.equal(tel.rssi, null);
  });

  it('keeps the dead-link RSSI that defines a state=0 offline classification', () => {
    // Verify: state=0 is offline only because the RSSI is at or below -95 dBm, so resetting it would flip the
    // classification back to online on the next poll and flap.
    const tel = createOnlineTelemetry();
    tel.applyProperties({state: 0, battery: 45, wifiRssi: -100});
    assert.equal(tel.isDeviceOffline(), true);
    assert.equal(tel.rssi, -100);
    tel.applyProperties({state: 0, battery: 45, wifiRssi: -100});
    assert.equal(tel.isDeviceOffline(), true);
    assert.equal(tel.rssi, -100);
  });

  it('keeps the RSSI of a camera that is online', () => {
    // Verify: keeps the RSSI of a camera that is online.
    const tel = createOnlineTelemetry();
    tel.applyProperties({state: 1, battery: 79, wifiRssi: -70});
    assert.equal(tel.isDeviceOffline(), false);
    assert.equal(tel.rssi, -70);
    assert.equal(tel.wifi, 3);
  });

  it('restores RSSI and tier from the first reading after the camera comes back online', () => {
    // Verify: restores RSSI and tier from the first reading after the camera comes back online.
    const tel = createOnlineTelemetry();
    tel.applyProperties({state: 3, battery: 2, chargingStatus: 2});
    assert.equal(tel.rssi, null);

    tel.applyProperties({state: 1, battery: 100, chargingStatus: 2, wifiRssi: -72});
    assert.equal(tel.isDeviceOffline(), false);
    assert.equal(tel.rssi, -72);
    assert.equal(tel.wifi, 3);
  });
});

describe('parseTelemetryProperties', () => {
  it('unwraps legacy { value } wrappers, fallback aliases, and trims device strings', () => {
    // Verify: raw Eufy property bags (direct or { value }-wrapped) normalize into one frozen structure.
    const parsed = parseTelemetryProperties({
      name: {value: '  Front Porch  '},
      model: {value: '  T8161  '},
      softwareVersion: {value: ' 3.4.3.0 '},
      state: {value: '1'},
      batteryLevel: {value: '84'},
      cellularSignalLevel: {value: 2},
      cellularRSSI: {value: -76},
      temperature: {value: 22},
      light: {value: true},
      powerWorkingMode: {value: '2'},
      recordingClipLength: {value: '60'},
      recordingEndClipMotionStops: {value: false},
      streamingQuality: {value: '7'},
    });

    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(parsed.deviceName, 'Front Porch');
    assert.equal(parsed.modelName, 'T8161');
    assert.equal(parsed.firmware, '3.4.3.0');
    assert.equal(parsed.model, '  T8161  ');
    assert.equal(parsed.swVer, ' 3.4.3.0 ');
    assert.equal(parsed.hasStateProp, true);
    assert.equal(parsed.deviceState, 1);
    assert.equal(parsed.hasBatteryProp, true);
    assert.equal(parsed.battery, 84);
    assert.equal(parsed.wifi, 2);
    assert.equal(parsed.rssi, -76);
    assert.equal(parsed.temp, 22);
    assert.equal(parsed.light, true);
    assert.equal(parsed.hwPowerMode, 2);
    assert.equal(parsed.hwClipLength, 60);
    assert.equal(parsed.hwEndEarly, false);
    assert.equal(parsed.hwQuality, 7);
  });

  it('ignores non-negative RSSI, NaN hardware numbers, and missing optional fields', () => {
    // Verify: positive/zero RSSI placeholders and NaN numeric properties map to null without corrupting cached state.
    const parsed = parseTelemetryProperties({
      wifiRssi: 0,
      state: 'invalid',
      powerWorkingMode: 'invalid',
      light: 'yes',
    });

    assert.equal(parsed.hasStateProp, true);
    assert.equal(parsed.deviceState, null);
    assert.equal(parsed.hasBatteryProp, false);
    assert.equal(parsed.battery, null);
    assert.equal(parsed.rssi, null);
    assert.equal(parsed.light, null);
    assert.equal(parsed.hwPowerMode, null);
  });
});

describe('detectTelemetryChanges', () => {
  it('flags major state transitions, Wi-Fi/temperature visual shifts, and minor sensor updates distinctly', () => {
    // Verify: change detection separates card-rebuilding state shifts from Wi-Fi/temperature tier updates and minor
    // debug-only readings.
    const basePrev = {
      hadInitialTelemetry: true,
      prevBattery: 70,
      prevCharging: false,
      prevWifi: 3,
      prevRssi: -70,
      prevTemp: 24,
      prevLight: false,
      wasLowBat: false,
      wasCritBat: false,
      wasOffline: false,
    };

    const minorShift = detectTelemetryChanges(
      basePrev,
      {
        battery: 69,
        charging: false,
        wifi: 3,
        rssi: -71,
        temp: 24,
        lightOn: false,
        nowLowBat: false,
        nowCritBat: false,
        nowOffline: false,
      },
      {model: 'T8161', swVer: '3.4.3.0'}
    );
    assert.equal(Object.isFrozen(minorShift), true);
    assert.equal(minorShift.stateChanged, false);
    assert.equal(minorShift.wifiTierChanged, false);
    assert.equal(minorShift.minorTelemetryChanged, true);

    const tempTierShift = detectTelemetryChanges(
      basePrev,
      {
        battery: 70,
        charging: false,
        wifi: 3,
        rssi: -70,
        temp: 40,
        lightOn: false,
        nowLowBat: false,
        nowCritBat: false,
        nowOffline: false,
      },
      {model: 'T8161', swVer: '3.4.3.0'}
    );
    assert.equal(tempTierShift.stateChanged, false);
    assert.equal(tempTierShift.wifiTierChanged, true);
    assert.equal(tempTierShift.minorTelemetryChanged, true);

    const swapShift = detectTelemetryChanges(
      basePrev,
      {
        battery: 85,
        charging: false,
        wifi: 3,
        rssi: -70,
        temp: 24,
        lightOn: false,
        nowLowBat: false,
        nowCritBat: false,
        nowOffline: false,
      },
      {model: 'T8161', swVer: '3.4.3.0'}
    );
    assert.equal(swapShift.stateChanged, true);
    assert.equal(swapShift.minorTelemetryChanged, false);
  });
});

describe('Telemetry Semantic Colors, Segments & Property Parsing', () => {
  it('evaluates 6-color semantic state across status, battery, charging, Wi-Fi RSSI, and temperature', () => {
    // Verify: evaluates 6-color semantic state across status, battery, charging, Wi-Fi RSSI, and temperature.
    assert.equal(unwrapProperty({value: 85}), 85);
    assert.equal(unwrapProperty(42), 42);
    assert.equal(unwrapProperty(null), null);

    const lowBatState = evaluateTelemetryState('Asleep (Low Battery)', {
      telCfg: {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      },
      battery: 25,
      charging: false,
      economyMode: true,
      wifi: 1,
      rssi: -82,
      temp: 52,
      lastSeen: '19:45',
    });
    assert.equal(lowBatState.statusKind, 'low');
    assert.deepEqual(lowBatState.statusRgb, COLOR_WHITE);
    assert.deepEqual(lowBatState.batRgb, [250, 204, 21]);
    assert.equal(lowBatState.wifiBars, 1);
    assert.deepEqual(lowBatState.tempRgb, [232, 121, 249]);

    const chargingState = evaluateTelemetryState('Waking Up...', {
      telCfg: {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      },
      battery: 55,
      charging: true,
      powerLabel: 'Charging',
      economyMode: false,
      lowBatThreshold: 20,
      wifi: 4,
      rssi: -55,
      temp: 24,
      lastSeen: '19:45',
    });
    assert.equal(chargingState.statusKind, 'waking');
    assert.deepEqual(chargingState.batRgb, [56, 189, 248]);
    assert.equal(chargingState.wifiBars, 4);
    assert.deepEqual(chargingState.tempRgb, COLOR_WHITE);

    const liveState = evaluateTelemetryState('Live', {
      telCfg: {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      },
      battery: 90,
      charging: false,
      powerLabel: 'Plugged',
      economyMode: false,
      lowBatThreshold: 20,
      wifi: 2,
      rssi: -72,
      temp: 0,
      lastSeen: '19:45',
    });
    assert.equal(liveState.statusKind, 'live');
    assert.deepEqual(liveState.batRgb, COLOR_WHITE);
    assert.equal(liveState.wifiBars, 3);
    assert.deepEqual(liveState.tempRgb, [56, 189, 248]);
    assert.equal(liveState.powerLabel, 'Plugged');
    assert.equal(liveState.seenVal, '19:45');
  });

  it(
    'matches the calm-white-when-healthy and sky-blue charging palette across Status, Battery, ' +
      'Wi-Fi, and Temperature',
    () => {
      // Verify: matches the calm-white-when-healthy and sky-blue charging palette across Status, Battery, Wi-Fi, and
      // Temperature.
      const allEnabled = {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      };

      // 1. Status colors: Red (Live / Backfill), Calm White (Asleep & Asleep Low Battery
      // sleep-ready), Grey (Disconnected), Blue (Waking Up...), Yellow (Waiting)
      assert.deepEqual(evaluateTelemetryState('Live', {telCfg: allEnabled}).statusRgb, COLOR_RED);
      assert.equal(evaluateTelemetryState('Live', {telCfg: allEnabled}).statusKind, 'live');
      assert.deepEqual(evaluateTelemetryState('Backfill', {telCfg: allEnabled}).statusRgb, COLOR_RED);
      assert.equal(evaluateTelemetryState('Backfill', {telCfg: allEnabled}).statusKind, 'backfill');
      assert.deepEqual(evaluateTelemetryState('Asleep', {telCfg: allEnabled}).statusRgb, COLOR_WHITE);
      assert.equal(evaluateTelemetryState('Asleep', {telCfg: allEnabled}).statusKind, 'asleep');
      assert.deepEqual(evaluateTelemetryState('Disconnected', {telCfg: allEnabled}).statusRgb, COLOR_GREY);
      assert.equal(evaluateTelemetryState('Disconnected', {telCfg: allEnabled}).statusKind, 'disconnected');
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, serviceDisrupted: true}).statusRgb,
        COLOR_GREY
      );
      assert.equal(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, serviceDisrupted: true}).statusKind,
        'disconnected'
      );
      assert.deepEqual(evaluateTelemetryState('Waking Up...', {telCfg: allEnabled}).statusRgb, COLOR_BLUE);
      assert.equal(evaluateTelemetryState('Waking Up...', {telCfg: allEnabled}).statusKind, 'waking');
      assert.deepEqual(evaluateTelemetryState('Waiting', {telCfg: allEnabled}).statusRgb, COLOR_YELLOW);
      assert.equal(evaluateTelemetryState('Waiting', {telCfg: allEnabled}).statusKind, 'waiting');
      assert.deepEqual(
        evaluateTelemetryState('Asleep (Low Battery)', {telCfg: allEnabled, economyMode: true}).statusRgb,
        COLOR_WHITE
      );
      assert.equal(
        evaluateTelemetryState('Asleep (Low Battery)', {telCfg: allEnabled, economyMode: true}).statusKind,
        'low'
      );

      // 2. Battery colors: Calm White (> lowBatThreshold unplugged, default 30%), Sky-Blue
      // (Charging / Solar / Plugged), Yellow (criticalBatThreshold < bat <= lowBatThreshold unplugged),
      // Purple (<= criticalBatThreshold unplugged, default 5%), Grey (N/A)
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 50, charging: false}).batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 100, charging: false}).batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {
          telCfg: allEnabled,
          battery: 40,
          charging: true,
          powerLabel: 'Solar',
        }).batRgb,
        COLOR_BLUE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 31, charging: false}).batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 30, charging: false}).batRgb,
        COLOR_YELLOW
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 6, charging: false}).batRgb,
        COLOR_YELLOW
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 5, charging: false}).batRgb,
        COLOR_PURPLE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 21, charging: false, lowBatThreshold: 20})
          .batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 20, charging: false, lowBatThreshold: 20})
          .batRgb,
        COLOR_YELLOW
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {
          telCfg: allEnabled,
          battery: 8,
          charging: false,
          lowBatThreshold: 20,
          criticalBatThreshold: 8,
        }).batRgb,
        COLOR_PURPLE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: null, charging: false}).batRgb,
        COLOR_GREY
      );

      // Verify critical battery (<= 5%) renders Purple in minimal, glance, and pebbles themes (differing from
      // Yellow low battery), while hud theme keeps its non-purple stage/text rendering
      const critTestSnap = Buffer.alloc(FRAME, 0x30);
      critTestSnap.fill(0x80, 1280 * 720);
      for (const theme of ['minimal', 'glance', 'pebbles']) {
        const lowThemeCam = new Camera(
          {serial: 'T8161T0000000080', card_theme: theme, card_position: 'top-left'},
          {frame: critTestSnap, lastSeen: '12:00'}
        );
        lowThemeCam.applyTelemetryProperties({battery: 20, chargingStatus: 2, wifiRssi: -60});
        renderCameraCards(lowThemeCam);

        const critThemeCam = new Camera(
          {serial: 'T8161T0000000081', card_theme: theme, card_position: 'top-left'},
          {frame: critTestSnap, lastSeen: '12:00'}
        );
        critThemeCam.applyTelemetryProperties({battery: 5, chargingStatus: 2, wifiRssi: -60});
        renderCameraCards(critThemeCam);

        assert.equal(
          Buffer.from(lowThemeCam.getAsleepCardBuffer()).equals(Buffer.from(critThemeCam.getAsleepCardBuffer())),
          false,
          theme + ' theme must render critical battery (5% purple) differently from low battery (20% yellow)'
        );
      }

      // 3. Wi-Fi colors & bars: Calm White (2-4 bars >= -80 dBm), Yellow (Weak 1 bar <= -81 dBm), Grey (Not available)
      const wifiStrong = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -65});
      assert.equal(wifiStrong.wifiBars, 4);
      assert.deepEqual(wifiStrong.wifiRgb, COLOR_WHITE);

      const wifiGood = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -70});
      assert.equal(wifiGood.wifiBars, 3);
      assert.deepEqual(wifiGood.wifiRgb, COLOR_WHITE);

      const wifiFair = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -78});
      assert.equal(wifiFair.wifiBars, 2);
      assert.deepEqual(wifiFair.wifiRgb, COLOR_WHITE);

      const wifiWeak = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -81});
      assert.equal(wifiWeak.wifiBars, 1);
      assert.deepEqual(wifiWeak.wifiRgb, COLOR_YELLOW);

      const wifiMissing = evaluateTelemetryState('Asleep', {telCfg: allEnabled, wifi: null, rssi: null});
      assert.equal(wifiMissing.wifiBars, 0);
      assert.deepEqual(wifiMissing.wifiRgb, COLOR_GREY);

      // 4. Temperature colors: Calm White (Normal 6-35°C), Blue (Cold <=5°C), Yellow (Warm 36-44°C),
      // Purple (Hot >=45°C), Grey (Not available)
      const tempNormal = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 22});
      assert.deepEqual(tempNormal.tempRgb, COLOR_WHITE);

      const tempCold = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 5});
      assert.deepEqual(tempCold.tempRgb, COLOR_BLUE);

      const tempWarm = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 36});
      assert.deepEqual(tempWarm.tempRgb, COLOR_YELLOW);

      const tempHot = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 45});
      assert.deepEqual(tempHot.tempRgb, COLOR_PURPLE);

      const tempMissing = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: null});
      assert.deepEqual(tempMissing.tempRgb, COLOR_GREY);
    }
  );

  it(
    'distinguishes major battery/charging state changes from minor telemetry updates and ' +
      'evaluates quality/refresh rules',
    () => {
      // Verify: distinguishes major battery/charging state changes from minor telemetry updates and evaluates
      // quality/refresh rules.
      const tel = new Telemetry({
        mode: 'custom',
        low_battery_threshold: 20,
        enforce_streaming_quality: 3,
        sync_power: true,
        power_working_mode: 2,
        recording_clip_length: 60,
        recording_end_early: false,
        recording_retrigger_interval: 5,
      });

      const initial = tel.applyProperties({
        name: {value: 'FrontCam'},
        model: {value: 'T8161'},
        softwareVersion: {value: '3.1.4'},
        battery: {value: 50},
        chargingStatus: {value: 2},
        wifiSignalLevel: {value: 3},
        wifiRssi: {value: -68},
        batteryTemperature: {value: 25},
      });
      assert.equal(initial.hadInitialTelemetry, false);
      assert.equal(initial.nowLowBat, false);
      assert.ok(tel.formatLoadedLog(initial.model, initial.swVer, initial.nowLowBat).includes('T8161'));

      // Minor 2% drop does not trigger stateChanged (card rebuild), only minorTelemetryChanged
      const minor = tel.applyProperties({battery: 48, wifiRssi: -69});
      assert.equal(minor.hadInitialTelemetry, true);
      assert.equal(minor.stateChanged, false);
      assert.equal(minor.minorTelemetryChanged, true);
      assert.ok(tel.formatUpdateLog().includes('battery=48%'));

      // >= 10% jump (e.g. battery swap from 48% to 95%) triggers stateChanged
      const swapped = tel.applyProperties({battery: 95});
      assert.equal(swapped.stateChanged, true);
      assert.ok(tel.formatStateChangeLog(swapped.prevBattery, swapped.nowLowBat).includes('48% -> 95%'));

      assert.deepEqual(tel.evaluateQualityChange({videoStreamingQuality: {value: 1}}, 'T8161T0000000000'), {
        shouldUpdate: true,
        currentQuality: 1,
        targetQuality: 3,
      });
      assert.deepEqual(
        tel.evaluateQualityChange({videoStreamingQuality: {value: 3}}, 'T8161T0000000000'),
        {shouldUpdate: false, currentQuality: 0, targetQuality: 7},
        'Only checks streaming quality once per session'
      );

      // Offline viewer refresh cooldown (300s / 5m)
      tel.applyProperties({battery: 15, chargingStatus: 2});
      assert.equal(tel.isLowBattery(), true);
      assert.equal(tel.shouldRefreshLowBatteryOnView(400000), true);
      assert.equal(tel.shouldRefreshLowBatteryOnView(500000), false, 'Respects 300s poll cooldown');
      assert.equal(tel.shouldRefreshLowBatteryOnView(705000), true);
    }
  );

  it(
    'uses semantically distinct domain constants for telemetry visual status kinds, segment ' +
      'types, power labels, wake kinds, and process signals',
    () => {
      // Verify: uses semantically distinct domain constants for telemetry visual status kinds, segment types, power
      // labels, wake kinds, and process signals.
      assert.equal(Object.isFrozen(STATUS_KINDS), true);
      assert.deepEqual(STATUS_KINDS, {
        LIVE: 'live',
        BACKFILL: 'backfill',
        WAKING: 'waking',
        WAITING: 'waiting',
        LOW_BATTERY: 'low',
        DISCONNECTED: 'disconnected',
        ASLEEP: 'asleep',
      });

      assert.equal(Object.isFrozen(POWER_LABELS), true);
      assert.deepEqual(POWER_LABELS, {
        CHARGING: 'Charging',
        PLUGGED: 'Plugged',
        SOLAR: 'Solar',
      });

      assert.equal(Object.isFrozen(WAKE_KINDS), true);
      assert.deepEqual(WAKE_KINDS, {
        MOTION: 'motion',
        VIEW: 'view',
      });

      assert.equal(Object.isFrozen(EUFY_CHARGING_STATUS), true);
      assert.deepEqual(EUFY_CHARGING_STATUS, {
        CHARGING: 1,
        UNPLUGGED: 2,
        PLUGGED: 3,
        SOLAR: 4,
      });

      assert.equal(Object.isFrozen(EUFY_POWER_SOURCES), true);
      assert.deepEqual(EUFY_POWER_SOURCES, {
        BATTERY: 0,
        SOLAR: 1,
      });

      assert.equal(Object.isFrozen(WIFI_SIGNAL_LEVELS), true);
      assert.deepEqual(WIFI_SIGNAL_LEVELS, {
        NONE: 0,
        WEAK: 1,
        FAIR: 2,
        GOOD: 3,
        FULL: 4,
      });

      // Verify Telemetry visual states use CARD_STATUS_TITLES input and produce STATUS_KINDS
      // output without mixing meanings
      const cam = new Camera({
        serial: 'T8161T0000000000',
        name: 'driveway',
        card_theme: CARD_THEMES.GLANCE,
        card_position: CARD_POSITIONS.BOTTOM_LEFT,
        telemetry: {temperature: true, last_seen: true},
      });
      cam.applyTelemetryProperties({battery: 90, chargingStatus: 1, wifiRssi: -58, batteryTemperature: 22}, false);
      const liveVisual = cam.evaluateVisualState(CARD_STATUS_TITLES.LIVE);
      const backfillVisual = cam.evaluateVisualState(CARD_STATUS_TITLES.BACKFILL);
      const asleepVisual = cam.evaluateVisualState(CARD_STATUS_TITLES.ASLEEP);
      assert.equal(liveVisual.statusKind, STATUS_KINDS.LIVE);
      assert.equal(backfillVisual.statusKind, STATUS_KINDS.BACKFILL);
      assert.equal(asleepVisual.statusKind, STATUS_KINDS.ASLEEP);
      assert.equal(asleepVisual.powerLabel, POWER_LABELS.CHARGING);
      const snapshot = cam.toTelemetryStatusSnapshot();
      assert.equal(snapshot.powerLabel, POWER_LABELS.CHARGING);
      assert.equal(snapshot.battery, 90);

      // Verify WakeRequest uses WAKE_KINDS and Camera encoder process control uses PROCESS_SIGNALS
      const motionReq = WakeRequest.motion('person detected', 60000).build();
      const viewReq = WakeRequest.view('live view', 20000).build();
      assert.equal(motionReq.kind, WAKE_KINDS.MOTION);
      assert.equal(viewReq.kind, WAKE_KINDS.VIEW);

      const signalsSent = [];
      cam.attachEncoder({
        kill(sig) {
          signalsSent.push(sig);
        },
      });
      cam.stopEncoderProcess();
      cam.killWedgedEncoder();
      assert.deepEqual(signalsSent, [PROCESS_SIGNALS.SIGTERM, PROCESS_SIGNALS.SIGKILL]);

      // Verify STREAM_MODES vs CARD_STATUS_TITLES vs STATUS_KINDS are never conflated
      assert.notEqual(STREAM_MODES.DOWNLOAD, CARD_STATUS_TITLES.BACKFILL);
      assert.notEqual(STREAM_MODES.DOWNLOAD, STATUS_KINDS.BACKFILL);
      assert.notEqual(CARD_STATUS_TITLES.BACKFILL, STATUS_KINDS.BACKFILL);
    }
  );

  it(
    'rebuilds the status card when Wi-Fi signal bar tier changes after initial battery load, ' +
      'while ignoring minor RSSI jitter within the same bar tier',
    () => {
      // Verify: rebuilds the status card when Wi-Fi signal bar tier changes after initial battery load, while
      // ignoring minor RSSI jitter within the same bar tier.
      const doorbell = new Camera({
        serial: 'T8214T2222222222',
        title: 'Front Doorbell',
        mode: 'backfill',
        card_theme: CARD_THEMES.MINIMAL,
      });

      // 1. Initial battery property arrives before wifiRssi
      const firstOutcome = doorbell.applyTelemetryProperties({battery: 9}, false);
      assert.equal(firstOutcome.shouldRebuildCard, true);
      assert.equal(doorbell.getWifiSignal(), null);

      // 2. Subsequent wifiRssi property arrives (-26 dBm -> wifi=4 bars): must rebuild card so 3rd dot turns Green
      const wifiLoadedOutcome = doorbell.applyTelemetryProperties({wifiRssi: -26}, false);
      assert.equal(doorbell.getWifiSignal(), 4);
      assert.equal(
        wifiLoadedOutcome.shouldRebuildCard,
        true,
        'Must rebuild card when Wi-Fi bars transition from null to 4'
      );

      // 3. Minor 1 dBm RSSI fluctuation within the same 4-bar tier (-26 -> -27 dBm) must not rebuild card
      const jitterOutcome = doorbell.applyTelemetryProperties({wifiRssi: -27}, false);
      assert.equal(doorbell.getWifiSignal(), 4);
      assert.equal(jitterOutcome.shouldRebuildCard, false);

      // 4. Signal drop across bar tiers (-27 -> -76 dBm, 4 -> 2 bars) must rebuild card
      const tierChangeOutcome = doorbell.applyTelemetryProperties({wifiRssi: -76}, false);
      assert.equal(doorbell.getWifiSignal(), 2);
      assert.equal(tierChangeOutcome.shouldRebuildCard, true);

      // 5. Subsequent batteryTemperature property arriving (null -> 21°C) must rebuild card so
      // Grey thermometer turns Green
      const tempLoadedOutcome = doorbell.applyTelemetryProperties({batteryTemperature: 21}, false);
      assert.equal(doorbell.getTemperature(), 21);
      assert.equal(tempLoadedOutcome.shouldRebuildCard, true);
    }
  );

  it('requires all 4 Power Manager recording keys before evaluating or latching recordingModeChecked', () => {
    // Verify partial 1..3-key recording bags do not latch recordingModeChecked or emit n/a writes.
    const cam = new Camera({serial: 'T8161T0000000054', name: 'yard', mode: 'backfill'});

    assert.deepEqual(cam.evaluateRecordingModeChanges({powerWorkingMode: {value: 2}}), []);
    assert.equal(cam.hasRecordingModeChecked(), false);

    assert.deepEqual(
      cam.evaluateRecordingModeChanges({
        powerWorkingMode: {value: 2},
        recordingClipLength: {value: 60},
        recordingEndClipMotionStops: {value: false},
      }),
      []
    );
    assert.equal(cam.hasRecordingModeChecked(), false);

    const fullUpdates = cam.evaluateRecordingModeChanges({
      powerWorkingMode: {value: 2},
      recordingClipLength: {value: 60},
      recordingEndClipMotionStops: {value: false},
      recordingRetriggerInterval: {value: 5},
    });
    assert.deepEqual(fullUpdates, [
      {name: 'recordingClipLength', currentValue: 60, targetValue: 30},
      {name: 'recordingEndClipMotionStops', currentValue: false, targetValue: true},
    ]);
    assert.equal(cam.hasRecordingModeChecked(), true);
  });
});
