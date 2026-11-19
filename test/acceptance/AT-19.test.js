/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-19`: YAML Config Validation, Env Endpoints, Direct `rtsp_url` Resolution,
 * Clamping, Warnings & `/api/config` (docs/acceptance/AT-19.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-19.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {TEST_TMP_DIR: testTmpDir} = require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {
  validateConfig,
  loadConfigFile,
  resolveServiceEndpoints,
  resolveCameraMode,
  resolveFrameRates,
  resolveCameraTimers,
  resolveHardwareRecordingConfig,
  BridgeConfigBuilder,
} = require('../../src/config');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {applyDeviceProperties} = require('../../src/services/eufy-client');
const {buildConfigPayload} = require('../../src/services/http-server');

installDefaultFetchStub();

describe('Locked Acceptance Criterion AT-19 (docs/acceptance/AT-19.md)', () => {
  it(
    'AT-19: Enforces YAML config validation, env endpoints, direct rtsp_url resolution, defensive clamping, ' +
      'ignored-option warnings, and null-filtered /api/config',
    () => {
      // Verify 1: YAML config validation (no legacy/env-only keys), single-pass error reporting, and env endpoints
      const minimalCfg = {
        cameras: [{serial: 'T8161T0000000034'}],
      };
      assert.doesNotThrow(() => validateConfig(minimalCfg));
      assert.equal(minimalCfg.cameras[0].name, 'T8161T0000000034');

      assert.throws(
        () =>
          validateConfig({
            frigate_url: 'http://frigate:5000',
            eufy_ws: 'ws://eufy:3000',
            hwaccel: 'vaapi',
            bogus_top: true,
            cameras: [{serial: 'T8161T0000000035', rtsp_url: 'http://bad-scheme/live', bogus_cam: 1}],
          }),
        (err) =>
          err instanceof Error &&
          err.message.includes('unknown key "frigate_url"') &&
          err.message.includes('unknown key "eufy_ws"') &&
          err.message.includes('unknown key "hwaccel"') &&
          err.message.includes('unknown key "bogus_top"') &&
          err.message.includes('cameras[0] "rtsp_url" must start with rtsp:// or rtsps://') &&
          err.message.includes('unknown camera key "cameras[0].bogus_cam"')
      );

      // Verify 1b: YAML file loading + ${ENV_VAR} expansion + hybrid env endpoint resolution
      const yamlDir = fs.mkdtempSync(path.join(testTmpDir, 'at19-yaml-'));
      const yamlPath = path.join(yamlDir, 'config.yaml');
      try {
        fs.writeFileSync(
          yamlPath,
          [
            '# yaml-language-server: $schema=https://example.invalid/config.schema.json',
            '# Comment line',
            'width: 1280',
            'cameras:',
            '  - name: nursery_cam',
            '    mode: rtsp',
            '    rtsp_url: rtsp://${CAM_USER}:${CAM_PASS:-fallback}@127.0.0.1:8554/nursery',
          ].join('\n'),
          'utf8'
        );
        const loadedYaml = loadConfigFile(yamlPath, {CAM_USER: 'viewer'});
        assert.equal(loadedYaml.width, 1280);
        assert.equal(loadedYaml.cameras[0].rtsp_url, 'rtsp://viewer:fallback@127.0.0.1:8554/nursery');
      } finally {
        fs.rmSync(yamlDir, {recursive: true, force: true});
      }

      const defaultEndpoints = resolveServiceEndpoints({});
      assert.equal(defaultEndpoints.eufy_security_ws_url, 'ws://eufy-security-ws:3000');
      assert.equal(defaultEndpoints.frigate_url, 'http://frigate:5000');
      assert.equal(defaultEndpoints.go2rtc_url, 'http://frigate:1984');
      assert.equal(defaultEndpoints.rtsp_publish_url, 'rtsp://frigate:8554/{name}');
      assert.equal(defaultEndpoints.ha_webhook_url, '');

      const customEndpoints = resolveServiceEndpoints({
        EUFY_WS_HOST: 'eufy.internal',
        EUFY_WS_PORT: '3100',
        FRIGATE_URL: 'https://nvr.example.com:8971/api/',
        GO2RTC_HOST: 'rtc.internal',
        GO2RTC_API_PORT: '1985',
        GO2RTC_RTSP_PORT: '8555',
        GO2RTC_RTSP_USER: 'pub',
        GO2RTC_RTSP_PASSWORD: 's@cret',
        HA_WEBHOOK_URL: 'http://ha:8123/api/webhook/hook1',
      });
      assert.equal(customEndpoints.eufy_security_ws_url, 'ws://eufy.internal:3100');
      assert.equal(customEndpoints.frigate_url, 'https://nvr.example.com:8971');
      assert.equal(customEndpoints.go2rtc_url, 'http://rtc.internal:1985');
      assert.equal(customEndpoints.rtsp_publish_url, 'rtsp://pub:s%40cret@rtc.internal:8555/{name}');
      assert.equal(customEndpoints.ha_webhook_url, 'http://ha:8123/api/webhook/hook1');

      // Verify 2: 5 camera modes, identity/title defaults, and direct rtsp_url isolation
      for (const mode of ['auto', 'rtsp', 'p2p', 'backfill', 'custom']) {
        assert.equal(resolveCameraMode({mode}), mode);
      }
      assert.equal(resolveCameraMode({mode: 'rtsp_direct'}), 'auto');
      assert.equal(resolveCameraMode({rtsp_url: 'rtsp://127.0.0.1:8554/nursery'}), 'rtsp');
      assert.equal(resolveCameraMode({mode: 'auto', rtsp_url: 'rtsps://127.0.0.1:8555/nursery'}), 'rtsp');
      const directOnlyCfg = {
        cameras: [{name: 'nursery_cam', rtsp_url: 'rtsp://admin:secret@127.0.0.1:8554/nursery'}],
      };
      assert.doesNotThrow(() => validateConfig(directOnlyCfg));
      for (const incompatibleMode of ['p2p', 'backfill', 'custom']) {
        assert.throws(
          () =>
            validateConfig({
              cameras: [
                {serial: 'T8161T0000000035', mode: incompatibleMode, rtsp_url: 'rtsp://127.0.0.1:8554/nursery'},
              ],
            }),
          new RegExp('cannot combine "rtsp_url" with mode "' + incompatibleMode + '"')
        );
      }

      const serialOnlyEufyCam = new Camera({serial: 'T8161T0000000036'});
      assert.equal(serialOnlyEufyCam.getName(), 'T8161T0000000036');
      assert.equal(serialOnlyEufyCam.toConfigSummary().title, 'T8161T0000000036');
      applyDeviceProperties(serialOnlyEufyCam, {name: 'Back Patio'});
      assert.equal(serialOnlyEufyCam.toConfigSummary().title, 'Back Patio');

      const directMinimalCam = new Camera({
        name: 'nursery_cam',
        rtsp_url: 'rtsp://admin:secret@127.0.0.1:8554/nursery',
        card_theme: 'minimal',
      });
      assert.equal(directMinimalCam.getConfiguredMode(), 'rtsp');
      assert.equal(directMinimalCam.getSerial(), 'nursery_cam');
      assert.equal(directMinimalCam.hasBackfillDownloadsEnabled(), false);
      assert.equal(directMinimalCam.requiresStartupSnapshot(), false);
      assert.equal(directMinimalCam.hasPowerConservationEnabled(), false);
      assert.equal(directMinimalCam.getTelemetryConfig().enabled, false);
      assert.equal(directMinimalCam.getTelemetryConfig().battery, false);
      assert.equal(directMinimalCam.getTelemetryConfig().powerSource, false);
      assert.equal(directMinimalCam.getTelemetryConfig().wifi, false);
      assert.equal(directMinimalCam.getTelemetryConfig().rssi, false);
      assert.deepEqual(directMinimalCam.getCardBounds(), {boxX: 24, boxY: 684, boxW: 26, boxH: 12});

      // Verify 3: Defensive clamping (FPS, timers, backfill_enabled in "backfill" mode, and Power Manager promotion)
      const rates = resolveFrameRates({live_fps: 10, idle_fps: 20});
      assert.equal(rates.idleFps, 10);
      const clampedTimers = resolveCameraTimers({
        serial: 'T8161T0000000034',
        mode: 'custom',
        hold_secs: 60,
        stream_max_secs: 20,
        view_linger_secs: 30,
        view_max_secs: 10,
        low_battery_hold_secs: 90,
        low_battery_threshold: 20,
        critical_battery_threshold: 25,
      });
      assert.equal(clampedTimers.maxMs, 60000);
      assert.equal(clampedTimers.viewMaxMs, 30000);
      assert.equal(clampedTimers.lowBatHoldMs, 60000);
      assert.equal(clampedTimers.lowBatThreshold, 20);
      assert.equal(clampedTimers.criticalBatThreshold, 19);
      const clampedHw = resolveHardwareRecordingConfig(
        {
          serial: 'T8161T0000000034',
          mode: 'custom',
          hold_secs: 60,
          end_early: false,
          power_working_mode: 0,
          recording_clip_length: 20,
        },
        clampedTimers
      );
      assert.equal(clampedHw.powerWorkingMode, 2);
      assert.equal(clampedHw.recordingClipLength, 60);
      const forcedBackfillCam = new Camera({
        serial: 'T8214T0000000037',
        mode: 'backfill',
        backfill_enabled: false,
        sync_power: false,
        card_theme: 'none',
        sleep_screen: 'slate',
      });
      assert.equal(forcedBackfillCam.hasBackfillDownloadsEnabled(), true);

      // Verify 4: Ignored-option startup warnings and null-filtered GET /api/config with credential masking
      const directCfgPayload = buildConfigPayload([directMinimalCam]);
      assert.equal(directCfgPayload.use_rtsp, null);
      assert.equal(directCfgPayload.telemetry_poll_secs, null);
      assert.equal(directCfgPayload.cameras[0].serial, null);
      assert.equal(directCfgPayload.cameras[0].mode, 'rtsp');
      assert.equal(directCfgPayload.cameras[0].rtsp_url, 'rtsp://***@127.0.0.1:8554/nursery');
      assert.equal(directCfgPayload.cameras[0].hold_secs, null);
      assert.equal(directCfgPayload.cameras[0].sync_power, null);
      assert.equal(directCfgPayload.cameras[0].telemetry, null);

      const mixedCfgPayload = buildConfigPayload([forcedBackfillCam]);
      assert.equal(mixedCfgPayload.use_rtsp, true);
      assert.equal(mixedCfgPayload.card_show_on_live, null);
      assert.equal(mixedCfgPayload.cameras[0].idle_timeout_secs, null);
      assert.equal(mixedCfgPayload.cameras[0].power_working_mode, null);
      assert.equal(mixedCfgPayload.cameras[0].recording_clip_length, null);
      assert.equal(mixedCfgPayload.cameras[0].card_position, null);
      assert.equal(mixedCfgPayload.cameras[0].card_show_on_live, null);
      assert.equal(mixedCfgPayload.cameras[0].startup_snapshot, null);
      assert.equal(mixedCfgPayload.cameras[0].telemetry, null);

      const capturedWarnings = [];
      const origWarn = log.warn;
      log.warn = (scope, ...args) => {
        capturedWarnings.push({scope: String(scope), msg: args.join(' ')});
      };
      try {
        new BridgeConfigBuilder(
          {
            hold_secs: 45,
            cameras: [
              {
                name: 'nursery_cam',
                mode: 'rtsp',
                rtsp_url: 'rtsp://127.0.0.1:8554/nursery',
                hold_secs: 60,
                stream_max_secs: 300,
                sync_power: true,
                telemetry: {battery: true},
              },
            ],
          },
          {BRIDGE_HWACCEL: 'nvenc', BRIDGE_HWACCEL_DEVICE: '/dev/dri/renderD128'}
        ).build();
      } finally {
        log.warn = origWarn;
      }
      assert.equal(
        capturedWarnings.some((w) => w.scope === 'bridge' && w.msg.includes('BRIDGE_HWACCEL_DEVICE')),
        true,
        'AT-19: Must warn when BRIDGE_HWACCEL_DEVICE is specified with non-device hwaccel'
      );
      assert.equal(
        capturedWarnings.some((w) => w.scope === 'bridge' && w.msg.includes('hold_secs') && w.msg.includes('rtsp_url')),
        true,
        'AT-19: Must warn when top-level Eufy/timeout options are specified while all cameras specify rtsp_url'
      );
      assert.equal(
        capturedWarnings.some(
          (w) =>
            w.scope === 'nursery_cam' &&
            w.msg.includes('hold_secs') &&
            w.msg.includes('stream_max_secs') &&
            w.msg.includes('sync_power') &&
            w.msg.includes('telemetry')
        ),
        true,
        'AT-19: Must warn when per-camera timeout/Eufy/telemetry options are ignored on a direct rtsp_url camera'
      );
    }
  );
});
