/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 11. Depleted Battery Camera Still Appearing Asleep & Deep-Standby False Positives
 * (docs/regression/11-depleted-battery-offline-camera-still-appearing-asleep.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME, STREAM_MODES, PROCESS_SIGNALS} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {EUFY_DEVICE_STATES} = require('../../src/domain/telemetry');

describe('Regression 11. Depleted Battery Camera Still Appearing Asleep & Deep-Standby False Positives', () => {
  it(
    'Regression 11: detects offline camera states, preserves healthy deep-standby state=0, ' +
      'and pauses/resumes encoder',
    () => {
      // Regression 11: detects offline camera states, preserves healthy deep-standby state=0, and pauses/resumes
      // encoder.
      assert.equal(Object.isFrozen(EUFY_DEVICE_STATES), true);
      assert.deepEqual(EUFY_DEVICE_STATES, {
        OFFLINE: 0,
        ONLINE: 1,
        MANUALLY_DISABLED: 2,
        OFFLINE_LOWBAT: 3,
        REMOVE_AND_READD: 4,
        RESET_AND_READD: 5,
      });

      const doorbell = new Camera(
        {
          serial: 'T8214T2222222222',
          name: 'doorbell',
          title: 'Front Doorbell',
          mode: 'backfill',
          sleep_screen: 'snapshot',
        },
        {frame: Buffer.alloc(FRAME, 0x30), lastSeen: '10:00'}
      );
      const noSnapCam = new Camera({serial: 'T8161T0000000000', sleep_screen: 'snapshot'}, {frame: null, lastSeen: ''});
      const blackScreenCam = new Camera(
        {serial: 'T8161T1111111111', sleep_screen: 'black'},
        {frame: Buffer.alloc(FRAME, 0x30), lastSeen: '10:00'}
      );

      assert.equal(doorbell.hasOfflineSnapshotToSeed(), true);
      assert.equal(noSnapCam.hasOfflineSnapshotToSeed(), false, 'Must not seed when no cached snapshot is available');
      assert.equal(
        blackScreenCam.hasOfflineSnapshotToSeed(),
        false,
        'Must not seed when sleep_screen is not "snapshot"'
      );

      assert.equal(doorbell.isDeviceOffline(), false);
      assert.equal(doorbell.getOfflineReason(), '');

      // 1. Depleted battery (0% while unplugged) marks camera offline and blocks wakes/startup probes
      const depletedOutcome = doorbell.applyTelemetryProperties({battery: 0, chargingStatus: 2}, false);
      assert.equal(depletedOutcome.hadInitialTelemetry, false);
      assert.equal(depletedOutcome.isOffline, true);
      assert.equal(depletedOutcome.offlineChanged, true);
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'battery depleted (0%)');

      const now = 50000;
      doorbell.setViewUntil(now + 20000);
      doorbell.setRequiresStartupSnapshot(true);
      assert.equal(doorbell.wantsWake(now), false, 'Offline camera must not request wake');
      assert.equal(
        doorbell.canStartStartupProbe([doorbell], now),
        false,
        'Offline camera must not start startup snapshot probe'
      );

      // 2. Plugging camera in to charge clears 0% depleted battery offline state
      const chargingOutcome = doorbell.applyTelemetryProperties({chargingStatus: 1}, false);
      assert.equal(chargingOutcome.hadInitialTelemetry, true);
      assert.equal(chargingOutcome.isOffline, false);
      assert.equal(chargingOutcome.offlineChanged, true);
      assert.equal(doorbell.isDeviceOffline(), false);
      assert.equal(doorbell.getOfflineReason(), '');

      // 3. Explicit Eufy DeviceState OFFLINE_LOWBAT (3) vs deep-sleep standby OFFLINE (0)
      doorbell.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT, chargingStatus: 2, battery: 5},
        false
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'offline (low battery)');

      // Healthy battery camera (e.g. T8161 at 100% battery and -72 dBm RSSI) reporting state=0
      // in deep standby must NOT be marked offline
      doorbell.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 100, wifiRssi: -72, wifiSignalLevel: 3},
        false
      );
      assert.equal(
        doorbell.isDeviceOffline(),
        false,
        'Battery camera in deep standby (state=0 with healthy battery and Wi-Fi RSSI) must not be marked offline'
      );
      assert.equal(doorbell.getOfflineReason(), '');

      // state=0 with dead link (rssi <= -95 dBm) or critical battery (<= 5%) is genuinely offline
      doorbell.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 45, wifiRssi: -100, wifiSignalLevel: 0},
        false
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'device offline');

      doorbell.applyTelemetryProperties({state: EUFY_DEVICE_STATES.ONLINE, wifiRssi: -68}, false);
      assert.equal(doorbell.isDeviceOffline(), false);
      assert.equal(doorbell.getOfflineReason(), '');

      // 4. Non-event wake timeout without video marks camera unreachable/offline, whereas event wake timeout does not
      doorbell.setEventActive(false);
      doorbell.beginSession(STREAM_MODES.P2P, now, false);
      doorbell.terminateSession(
        now + 15000,
        'no initial video for 15s after 3 start attempts',
        false,
        'error/watchdog-timeout'
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'unreachable (wake timed out)');

      doorbell.markDeviceOnline();
      assert.equal(doorbell.isDeviceOffline(), false);

      doorbell.setEventActive(true);
      doorbell.beginSession(STREAM_MODES.P2P, now + 20000, false);
      doorbell.terminateSession(
        now + 35000,
        'no initial video for 15s after 3 start attempts',
        false,
        'error/watchdog-timeout'
      );
      assert.equal(
        doorbell.isDeviceOffline(),
        false,
        'Motion-triggered wake timeout must not mark camera offline because hardware is awake recording for backfill'
      );

      // 5. Encoder pause/resume lifecycle for Frigate "device offline" display
      const signals = [];
      doorbell.attachEncoder({
        kill(sig) {
          signals.push(sig);
        },
      });
      doorbell.applyTelemetryProperties({state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT}, false);
      assert.equal(doorbell.pauseEncoderForOffline(), true);
      assert.deepEqual(signals, [PROCESS_SIGNALS.SIGKILL]);
      assert.equal(doorbell.hasEncoderProcess(), false);
      assert.equal(doorbell.shouldResumeOfflineEncoder(), false);

      doorbell.applyTelemetryProperties({state: EUFY_DEVICE_STATES.ONLINE, battery: 60}, false);
      assert.equal(doorbell.shouldResumeOfflineEncoder(), true);
      doorbell.clearEncoderOfflinePause();
      assert.equal(doorbell.shouldResumeOfflineEncoder(), false);
    }
  );
});
