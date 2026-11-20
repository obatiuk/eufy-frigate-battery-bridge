/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for split configuration modules under src/config/:
 * constants, camera-config, env, validation, resolvers, builder, and index.js re-exports.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');

const {CAMERA_MODES, CARD_THEMES, clampNum} = require('../../src/config/constants');
const {CameraConfig, stripRtspUrlFragment, hasDirectRtspUrl} = require('../../src/config/camera-config');
const {resolveBuildInfo, resolveServiceEndpoints, expandConfigEnvVars} = require('../../src/config/env');
const {validateConfig} = require('../../src/config/validation');
const {getEventPriority, resolveCameraMode, resolveCameraConfig} = require('../../src/config/resolvers');
const {BridgeConfigBuilder} = require('../../src/config/builder');
const configIndex = require('../../src/config/index');
const configRoot = require('../../src/config');

describe('src/config split modules', () => {
  it('provides frozen enums and clampNum in constants.js', () => {
    // Verify constants.js freezes mode/theme enums and clamps numeric inputs with fallbacks.
    assert.equal(Object.isFrozen(CAMERA_MODES), true);
    assert.equal(Object.isFrozen(CARD_THEMES), true);
    assert.equal(clampNum(200, 5, 60, 15), 60);
    assert.equal(clampNum('', 5, 60, 15), 15);
  });

  it('normalizes camera identities without mutating input objects and constructs fixed CameraConfig shapes', () => {
    // Verify camera-config.js strips RTSP fragments, keeps normalizeIdentity pure, and avoids Object.assign(this).
    assert.equal(
      stripRtspUrlFragment('rtsp://user:pa#ss@127.0.0.1:8554/cam#backchannel=0'),
      'rtsp://user:pa#ss@127.0.0.1:8554/cam'
    );
    assert.equal(hasDirectRtspUrl({rtsp_url: 'rtsp://127.0.0.1:8554/cam'}), true);
    assert.equal(hasDirectRtspUrl({serial: 'SN0000000401'}), false);

    const rawEufy = {serial: 'SN0000000401'};
    const id = CameraConfig.normalizeIdentity(rawEufy);
    assert.deepEqual(id, {serial: 'SN0000000401', name: 'SN0000000401', explicitSerial: 'SN0000000401'});
    assert.equal(rawEufy.name, undefined, 'normalizeIdentity must not mutate rawCam.name in place');

    const rawDirect = {name: 'nursery', rtsp_url: 'rtsp://127.0.0.1:8554/nursery'};
    const directId = CameraConfig.normalizeIdentity(rawDirect);
    assert.deepEqual(directId, {serial: 'nursery', name: 'nursery', explicitSerial: ''});
    assert.equal(rawDirect.serial, undefined, 'normalizeIdentity must not mutate rawCam.serial in place');
    assert.equal(Object.getOwnPropertySymbols(rawDirect).length, 0, 'normalizeIdentity must not attach symbols');

    const cfgObj = new CameraConfig({serial: 'SN0000000401', unexpectedDynamicProp: 42});
    assert.equal('unexpectedDynamicProp' in cfgObj, false, 'CameraConfig constructor must assign fixed fields only');
    const snapAt = new Date(2026, 10, 19, 18, 16, 4);
    assert.equal(CameraConfig.formatCacheFilePrefix('porch', 'SN0000000401'), 'porch_SN0000000401_snapshot_');
    assert.equal(
      CameraConfig.formatCacheFileName('porch', 'SN0000000401', snapAt),
      'porch_SN0000000401_snapshot_2026-11-19_18-16-04.jpg'
    );
  });

  it('resolves build metadata, service endpoints, and env placeholders in env.js', () => {
    // Verify env.js derives go2rtc host from FRIGATE_HOST and expands ${VAR:-default} placeholders.
    const build = resolveBuildInfo({BRIDGE_VERSION: '1.2.3', BRIDGE_COMMIT: 'abc1234'});
    assert.deepEqual(build, {version: '1.2.3', commit: 'abc1234'});
    const endpoints = resolveServiceEndpoints({FRIGATE_HOST: 'nvr.local'});
    assert.equal(endpoints.frigate_url, 'http://nvr.local:5000');
    assert.equal(endpoints.go2rtc_url, 'http://nvr.local:1984');
    assert.equal(endpoints.rtsp_publish_url, 'rtsp://nvr.local:8554/{name}');
    assert.deepEqual(expandConfigEnvVars({a: '${CAM_NAME:-front}', b: '$${LITERAL}'}, {}), {
      a: 'front',
      b: '${LITERAL}',
    });
  });

  it('validates single-pass config schemas in validation.js and builds frozen configs in resolvers/builder', () => {
    // Verify validation.js collects multiple errors in one pass and BridgeConfigBuilder freezes the result.
    assert.throws(() => validateConfig({cameras: [], bad_top: 1}), /cameras.*bad_top/);
    assert.equal(getEventPriority('someone loitering'), 200);
    assert.equal(getEventPriority('doorbell rings'), 1000);
    assert.equal(resolveCameraMode({rtsp_url: 'rtsp://127.0.0.1:8554/baby'}), 'rtsp');

    const built = new BridgeConfigBuilder({cameras: [{serial: 'SN0000000402', mode: 'backfill'}]}, {}).build();
    assert.equal(Object.isFrozen(built), true);
    assert.equal(Object.isFrozen(built.cameras[0]), true);
    assert.equal(built.cameras[0].timers.alwaysBackfill, true);
  });

  it('exposes the frozen cfg singleton and re-exports all modules from src/config/index.js', () => {
    // Verify require('../src/config') resolves src/config/index.js and preserves every exported reference.
    assert.equal(configRoot, configIndex);
    assert.equal(Object.isFrozen(configRoot.cfg), true);
    assert.equal(configRoot.CameraConfig, CameraConfig);
    assert.equal(configRoot.BridgeConfigBuilder, BridgeConfigBuilder);
    assert.equal(configRoot.validateConfig, validateConfig);
    assert.equal(configRoot.resolveCameraConfig, resolveCameraConfig);
    assert.equal(configRoot.resolveServiceEndpoints, resolveServiceEndpoints);
    assert.equal(configRoot.clampNum, clampNum);
  });
});
