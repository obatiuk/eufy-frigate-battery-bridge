/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 24. Service Restart Marked Cameras Unavailable Without Frigate Restart
 * (docs/regression/24-service-restart-camera-unavailable-without-frigate-restart.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');
const {EUFY_DEVICE_STATES} = require('../../src/domain/telemetry');

describe('Regression 24. Service Restart Marked Cameras Unavailable Without Frigate Restart', () => {
  it('Regression 24: preserves deep-standby state=0 cameras as online before initial battery telemetry arrives', () => {
    // Regression: deep-standby state=0 reported before battery telemetry is populated
    // (battery=null) must NOT falsely mark camera offline
    const bootingStandbyCam = new Camera({serial: 'T8161T0000000099', name: 'boot_standby'});
    bootingStandbyCam.applyTelemetryProperties({state: EUFY_DEVICE_STATES.OFFLINE, wifiRssi: -70}, false);
    assert.equal(
      bootingStandbyCam.isDeviceOffline(),
      false,
      'Deep-standby state=0 before battery property is populated (battery=null) must not mark camera offline'
    );
    assert.equal(bootingStandbyCam.getOfflineReason(), '');
  });
});
