/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-07`: Offline Detection, Deep-Standby Protection & Battery-Swap Recovery
 * (docs/acceptance/AT-07.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-07.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {fetchAllCameraTelemetry} = require('../../src/services/eufy-client');

describe('Locked Acceptance Criterion AT-07 (docs/acceptance/AT-07.md)', () => {
  it(
    'AT-07: Deep-standby battery cameras (state=0) are never marked offline when healthy, genuinely offline ' +
      'cameras pause their encoder, Low-Battery Economy Mode and manually disabled cameras (state=2/4/5) skip ' +
      'poll_refresh, unforced offline polls enforce a 60m cooldown, and battery swaps auto-recover',
    async (t) => {
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
      const cam = new Camera({
        serial: 'T8214T0000000009',
        name: 'doorbell',
        mode: 'backfill',
        hold_secs: 30,
        station_serial: 'T8030P0000000001',
      });

      // 1. Healthy deep standby (state=0, battery=85%, rssi=-70 dBm) is online
      cam.applyTelemetryProperties({state: 0, battery: 85, wifiRssi: -70, wifiSignalLevel: 3}, false);
      assert.equal(cam.isDeviceOffline(), false);

      // 2. Low-battery economy mode (30% unplugged, default threshold 30%, state=1 online) shortens hold
      //    to 20s and skips driver.poll_refresh
      cam.applyTelemetryProperties({state: 1, battery: 30, chargingStatus: 2, wifiRssi: -68}, false);
      assert.equal(cam.isLowBattery(), true);
      assert.equal(cam.isCriticalBattery(), false);
      assert.equal(cam.getEffectiveHoldMs(), 20000);
      cam.applyTelemetryProperties({state: 1, battery: 5, chargingStatus: 2, wifiRssi: -68}, false);
      assert.equal(cam.isCriticalBattery(), true);
      const {sentCommands} = await setupAcceptanceHarness([cam]);
      await fetchAllCameraTelemetry(false);
      assert.equal(
        sentCommands.includes('driver.poll_refresh'),
        false,
        'AT-07: Online camera in Low-Battery Economy Mode must not invoke driver.poll_refresh on background poll'
      );

      // 2b. Manually disabled / unpaired states (state=2/4/5) mark camera offline but never trigger driver.poll_refresh
      for (const disabledState of [2, 4, 5]) {
        sentCommands.length = 0;
        cam.applyTelemetryProperties({state: disabledState, battery: 80, chargingStatus: 2, wifiRssi: -68}, false);
        assert.equal(cam.isDeviceOffline(), true);
        await fetchAllCameraTelemetry(false);
        assert.equal(
          sentCommands.includes('driver.poll_refresh'),
          false,
          'AT-07: Camera in state=' + disabledState + ' must never trigger background driver.poll_refresh'
        );
      }

      // 3. Explicit OFFLINE_LOWBAT (state=3) marks camera offline, pauses encoder, and enforces 60m poll cooldown
      let encoderKilled = false;
      cam.attachEncoder({
        kill() {
          encoderKilled = true;
        },
      });
      cam.applyTelemetryProperties({state: 3, battery: 2, chargingStatus: 2, wifiRssi: -100}, false);
      assert.equal(cam.isDeviceOffline(), true);
      assert.equal(cam.pauseEncoderForOffline(), true);
      assert.equal(encoderKilled, true);

      sentCommands.length = 0;
      const firstOfflinePoll = fetchAllCameraTelemetry(false);
      await flushAsync(3);
      t.mock.timers.tick(2000);
      await flushAsync(4);
      await firstOfflinePoll;
      assert.equal(sentCommands.filter((c) => c === 'driver.poll_refresh').length, 1);

      sentCommands.length = 0;
      t.mock.timers.tick(1_800_000); // 30 minutes (< 60m cooldown)
      await fetchAllCameraTelemetry(false);
      assert.equal(
        sentCommands.includes('driver.poll_refresh'),
        false,
        'AT-07: Unforced offline background poll must skip driver.poll_refresh inside the 60-minute cooldown'
      );

      t.mock.timers.tick(1_800_000); // 60 minutes total (>= 3600s cooldown)
      const secondOfflinePoll = fetchAllCameraTelemetry(false);
      await flushAsync(3);
      t.mock.timers.tick(2000);
      await flushAsync(4);
      await secondOfflinePoll;
      assert.equal(sentCommands.filter((c) => c === 'driver.poll_refresh').length, 1);

      // 4. Battery swap to 100% clears offline state even if stale state=3 is still reported
      const swapped = cam.applyTelemetryProperties({state: 3, battery: 100, chargingStatus: 2, wifiRssi: -72}, false);
      assert.equal(cam.isDeviceOffline(), false);
      assert.equal(swapped.offlineChanged, true);
      assert.equal(cam.shouldResumeOfflineEncoder(), true);
    }
  );
});
