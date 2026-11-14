/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Enterprise unit test suite for configuration loading, camera mode presets,
 * defensive non-contradiction validation, and status card theme normalization.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const jsYaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_DIR = path.join(REPO_ROOT, '.tmp');
const TEST_CACHE_DIR = path.join(TEST_TMP_DIR, 'cache');
fs.mkdirSync(TEST_CACHE_DIR, {recursive: true});

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.BRIDGE_LOG_LEVEL = 'error';
process.env.TMPDIR = TEST_TMP_DIR;
process.env.BRIDGE_CACHE_DIR = TEST_CACHE_DIR;

const {
  cfg,
  CACHE_DIR,
  BACKFILL_DELAY_MS,
  PROCESS_SIGNALS,
  CARD_THEMES,
  CARD_POSITIONS,
  SLEEP_SCREENS,
  CARD_STATUS_TITLES,
  CAMERA_MODES,
  STREAM_MODES,
  HWACCEL_MODES,
  FRAME_STAGE_MARKERS,
  POWER_WORKING_MODES,
  CameraConfig,
  BridgeConfigBuilder,
  resolveCameraConfig,
  TRIGGERS,
  getEventPriority,
  validateConfig,
  normalizeCardTheme,
  normalizeCardPosition,
  normalizeSleepScreen,
  resolveFrameRates,
  resolveCameraTriggers,
  resolveCameraMode,
  resolveTelemetryConfig,
  resolveCameraTimers,
  resolveHardwareRecordingConfig,
  resolveCardConfig,
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  resolveBuildInfo,
  stripRtspUrlFragment,
  expandConfigEnvVars,
  loadConfigFile,
  resolveConfigFilePath,
  resolveServiceEndpoints,
} = require('../src/config');
const {Camera} = require('../src/domain/camera');
const {buildConfigPayload} = require('../src/services/http-server');
const {log} = require('../src/logger');

describe('Source & Example File Integrity', () => {
  it('compiles all JavaScript modules in src/ without syntax errors', () => {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.js')) {
          assert.doesNotThrow(
            () => new vm.Script(fs.readFileSync(full, 'utf8'), {filename: full}),
            'Syntax check failed for ' + full
          );
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
  });

  it('confines test temporary and cache directories to project-local .tmp/ instead of external OS temp folders', () => {
    // Verify test execution uses <repo>/.tmp, never references external OS temp paths, and cleans .tmp/ in make clean
    const projectTmpRoot = path.join(REPO_ROOT, '.tmp');
    assert.ok(
      CACHE_DIR === projectTmpRoot || CACHE_DIR.startsWith(projectTmpRoot + path.sep),
      'Test CACHE_DIR must resolve inside project-local .tmp/ (got ' + CACHE_DIR + ')'
    );

    const outsideTmpPrefix = path.sep + 'tmp';
    const outsideTmpLiteralRe = new RegExp('[\'"]' + outsideTmpPrefix + '(?:[\'"/])');
    const osTmpCallRe = new RegExp('\\btmp' + 'dir\\s*\\(');
    const testDir = path.join(REPO_ROOT, 'test');
    for (const entry of fs.readdirSync(testDir, {withFileTypes: true})) {
      if (!entry.isFile() || !entry.name.endsWith('.test.js')) {
        continue;
      }
      const src = fs.readFileSync(path.join(testDir, entry.name), 'utf8');
      assert.equal(
        outsideTmpLiteralRe.test(src),
        false,
        'test/' + entry.name + ' must not use external ' + outsideTmpPrefix + ' paths'
      );
      assert.equal(
        osTmpCallRe.test(src),
        false,
        'test/' + entry.name + ' must not call OS tmpdir helper; use project-local .tmp/'
      );
    }

    const gitignorePath = path.join(REPO_ROOT, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignoreLines = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
      assert.ok(gitignoreLines.includes('.tmp/'), '.gitignore must ignore .tmp/');
    }

    const dockerignorePath = path.join(REPO_ROOT, '.dockerignore');
    if (fs.existsSync(dockerignorePath)) {
      const dockerignoreLines = fs.readFileSync(dockerignorePath, 'utf8').split(/\r?\n/);
      assert.ok(dockerignoreLines.includes('.tmp/'), '.dockerignore must ignore .tmp/');
    }

    const makefilePath = path.join(REPO_ROOT, 'Makefile');
    if (fs.existsSync(makefilePath)) {
      const makefileText = fs.readFileSync(makefilePath, 'utf8');
      assert.match(makefileText, /^TMP_DIR\s*:=\s*\$\(PROJECT_ROOT\)\/\.tmp$/m);
      assert.match(makefileText, /clean:[\s\S]*rm -rf [^\n]*"\$\(TMP_DIR\)"/);
    }
  });

  it(
    'validates deploy/config.schema.json, deploy/config.example.minimal.yaml, ' +
      'deploy/config.example.full.yaml, and package.json',
    () => {
      // Verify schema, YAML examples, and package.json dependencies match the YAML/env-first config design
      const schemaPath = path.join(REPO_ROOT, 'deploy/config.schema.json');
      const minPath = path.join(REPO_ROOT, 'deploy/config.example.minimal.yaml');
      const fullPath = path.join(REPO_ROOT, 'deploy/config.example.full.yaml');
      const pkgPath = path.join(REPO_ROOT, 'package.json');
      const schemaUrl =
        'https://raw.githubusercontent.com/obatiuk/eufy-frigate-battery-bridge/main/deploy/config.schema.json';
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      assert.equal(schema.$id, schemaUrl);
      assert.equal(schema.type, 'object');
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, ['cameras']);
      for (const envOnlyKey of [
        '$schema',
        'eufy_security_ws_url',
        'frigate_url',
        'go2rtc_url',
        'rtsp_output_url',
        'ha_webhook_url',
        'http_port',
        'log_level',
        'cache_dir',
        'hwaccel',
        'hwaccel_device',
        'backfill_only',
      ]) {
        assert.equal(
          envOnlyKey in schema.properties,
          false,
          'Removed/env-only key must not be in schema: ' + envOnlyKey
        );
      }
      assert.ok(schema.definitions && schema.definitions.camera);
      const camDef = schema.definitions.camera;
      assert.equal(camDef.required, undefined);
      assert.deepEqual(camDef.else && camDef.else.required, ['serial']);
      assert.ok(
        camDef.if &&
          Array.isArray(camDef.if.required) &&
          camDef.if.required.includes('rtsp_url') &&
          camDef.then &&
          Array.isArray(camDef.then.allOf),
        'Camera schema definition must conditionally allow name + rtsp_url instead of serial and restrict ' +
          'mode to auto/rtsp'
      );
      assert.equal('homebase_rtsp_url' in camDef.properties, false, 'homebase_rtsp_url must not exist in schema');
      assert.equal(camDef.additionalProperties, false);
      assert.ok(
        new RegExp(camDef.properties.rtsp_url.pattern).test('${NURSERY_CAMERA_RTSP_URL}') &&
          new RegExp(camDef.properties.rtsp_url.pattern).test(
            'rtsp://${RTSP_USER}:${RTSP_PASSWORD}@192.0.2.10:554/live0'
          ),
        'Schema camera rtsp_url pattern must allow full and embedded ${ENV_VAR} placeholders'
      );

      const minText = fs.readFileSync(minPath, 'utf8');
      assert.ok(minText.includes('# yaml-language-server: $schema=' + schemaUrl));
      const minimal = /** @type {Record<string, *>} */ (jsYaml.load(minText));
      for (const k of Object.keys(minimal)) {
        assert.ok(k in schema.properties, 'Schema missing top-level property: ' + k);
      }
      assert.doesNotThrow(() => validateConfig(minimal));

      const fullText = fs.readFileSync(fullPath, 'utf8');
      assert.ok(fullText.includes('# yaml-language-server: $schema=' + schemaUrl));
      const full = /** @type {Record<string, *>} */ (jsYaml.load(fullText));
      for (const k of Object.keys(full)) {
        assert.ok(k in schema.properties, 'Schema missing top-level property: ' + k);
      }
      for (const cam of full.cameras) {
        for (const ck of Object.keys(cam)) {
          assert.ok(ck in schema.definitions.camera.properties, 'Schema missing camera property: ' + ck);
        }
        if (cam.rtsp_url) {
          assert.ok(
            Boolean(cam.serial || cam.name),
            'Direct rtsp_url camera in full example must define serial or name'
          );
        } else {
          assert.ok(Boolean(cam.serial), 'Eufy WS camera in full example must define serial');
        }
      }
      assert.doesNotThrow(() => validateConfig(full));
      // Verify backfill_delay_secs defaults to 2s across config singleton, builder, schema, and full example
      assert.equal(BACKFILL_DELAY_MS, 2000, 'Default BACKFILL_DELAY_MS must be 2000ms (2s)');
      assert.equal(
        schema.properties.backfill_delay_secs.default,
        2,
        'Schema default for backfill_delay_secs must be 2'
      );
      assert.equal(full.backfill_delay_secs, 2, 'Full example config backfill_delay_secs must be 2');

      // Verify bridge starts cleanly offline regardless of yaml-language-server schema comment
      const offlineSchemaCfg = {
        cameras: [{serial: 'T8161T0000000000'}],
      };
      assert.doesNotThrow(() => validateConfig(offlineSchemaCfg));
      const builtDefaultCfg = new BridgeConfigBuilder(offlineSchemaCfg).build();
      assert.equal(
        builtDefaultCfg.backfillDelayMs,
        2000,
        'BridgeConfigBuilder.withTimersAndArbitration() must default backfillDelayMs to 2000ms (2s)'
      );

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      assert.equal(pkg.name, 'eufy-frigate-battery-bridge');
      assert.equal(pkg.private, true);
      assert.ok(pkg.dependencies && pkg.dependencies.ws);
      assert.ok(pkg.dependencies && pkg.dependencies['js-yaml']);
      const WS = require('ws');
      assert.equal(typeof WS, 'function');
      const {isTrackedPropertyEvent, extractRecognizedPerson} = require('../src/services/eufy-client');
      assert.equal(isTrackedPropertyEvent('battery'), true);
      assert.equal(isTrackedPropertyEvent('rtspStreamUrl'), true);
      assert.equal(isTrackedPropertyEvent('unknownProp'), false);
      assert.equal(extractRecognizedPerson({event: 'identity person detected', person: 'Alice'}), 'Alice');
      assert.equal(extractRecognizedPerson({event: 'person detected', person: 'Stranger'}), '');
    }
  );

  it('keeps every deploy/config.schema.json top-level and camera default equal to the builder default', () => {
    // Regression: backfill_delay_secs drifted between config.js, the schema, the examples, and the README
    const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy/config.schema.json'), 'utf8'));
    const built = new BridgeConfigBuilder({
      cameras: [{serial: 'T8161T0000000000'}],
    }).build();
    const cam = built.cameras[0];
    const MS = 1000;
    const syncPowerEnabled = cam.hwRecordingConfig.powerWorkingMode !== null;
    // Schema key -> value resolved when the key is omitted from config.yaml.
    const topDefaults = {
      width: built.width,
      height: built.height,
      live_fps: built.live_fps,
      idle_fps: built.idle_fps,
      audio: built.audio,
      card_theme: cam.cardConfig.theme,
      card_position: cam.cardConfig.position,
      sleep_screen: cam.cardConfig.sleepScreen,
      card_show_on_live: built.card_show_on_live,
      auto_frigate_mask: built.auto_frigate_mask,
      preserve_aspect_ratio: built.preserve_aspect_ratio,
      startup_snapshot: built.startup_snapshot,
      instant_event_snapshot: built.instant_event_snapshot,
      snapshot_capture_delay_secs: built.snapDelayMs / MS,
      hold_secs: cam.timers.holdMs / MS,
      stream_max_secs: built.maxMs / MS,
      frigate_event_secs: cam.timers.eventSecs,
      end_early: cam.timers.letEufyDecideEnd,
      idle_timeout_secs: built.earlySleepMs / MS,
      view_linger_secs: built.lingerMs / MS,
      view_max_secs: built.viewMaxMs / MS,
      view_cooldown_secs: built.cooldownMs / MS,
      view_has_priority: built.view_has_priority,
      use_rtsp: built.use_rtsp,
      backfill_enabled: built.backfill_enabled,
      backfill_delay_secs: built.backfillDelayMs / MS,
      sync_power: syncPowerEnabled,
      track_stuck_spotlight: built.track_stuck_spotlight,
      enforce_streaming_quality: built.enforce_streaming_quality,
      low_battery_threshold: built.low_battery_threshold,
      critical_battery_threshold: built.critical_battery_threshold,
      low_battery_hold_secs: built.lowBatHoldMs / MS,
      low_battery_wake_on_view: built.low_battery_wake_on_view,
      telemetry_poll_secs: built.telemetryPollMs / MS,
      telemetry: cam.telemetryConfig.enabled,
      forward_face_names: built.forward_face_names,
      ring_label: built.ring_label,
    };
    const cameraDefaults = {
      mode: cam.timers.mode,
      priority: cam.priority,
      use_rtsp: cam.timers.useRtsp,
      backfill_only: cam.timers.alwaysBackfill,
      backfill_enabled: cam.timers.backfillDownloads,
      hold_secs: cam.timers.holdMs / MS,
      stream_max_secs: cam.timers.maxMs / MS,
      frigate_event_secs: cam.timers.eventSecs,
      end_early: cam.timers.letEufyDecideEnd,
      idle_timeout_secs: cam.timers.earlySleepMs / MS,
      view_linger_secs: cam.timers.lingerMs / MS,
      view_max_secs: cam.timers.viewMaxMs / MS,
      low_battery_threshold: cam.timers.lowBatThreshold,
      critical_battery_threshold: cam.timers.criticalBatThreshold,
      low_battery_hold_secs: cam.timers.lowBatHoldMs / MS,
      low_battery_wake_on_view: cam.timers.lowBatWakeOnView,
      sync_power: syncPowerEnabled,
      track_stuck_spotlight: cam.trackStuckSpotlight,
      power_working_mode: cam.hwRecordingConfig.powerWorkingMode,
      recording_retrigger_interval: cam.hwRecordingConfig.recordingRetriggerInterval,
      enforce_streaming_quality: cam.hwRecordingConfig.enforceQuality,
      card_theme: cam.cardConfig.theme,
      card_position: cam.cardConfig.position,
      sleep_screen: cam.cardConfig.sleepScreen,
      card_show_on_live: cam.cardShowOnLive,
      auto_frigate_mask: cam.autoFrigateMask,
      preserve_aspect_ratio: cam.preserveAspect,
      startup_snapshot: cam.startupSnapshot,
      telemetry: cam.telemetryConfig.enabled,
    };
    // Keys whose schema default is documentation only, with the reason the builder value cannot be compared.
    const exemptKeys = new Set([
      'trigger_events', // array in the schema, resolved to a Set of triggers
    ]);
    const effectiveDefault = (prop) =>
      prop.default !== undefined
        ? prop.default
        : prop.$ref
          ? schema.definitions[prop.$ref.split('/').pop()].default
          : undefined;
    const assertDefaultParity = (scopeLabel, properties, resolvedMap) => {
      for (const [key, prop] of Object.entries(properties)) {
        const schemaDefault = effectiveDefault(prop);
        if (schemaDefault === undefined || exemptKeys.has(key)) {
          continue;
        }
        assert.ok(
          key in resolvedMap,
          scopeLabel + ' schema default for "' + key + '" has no resolved-default mapping or exemption'
        );
        assert.deepEqual(
          resolvedMap[key],
          schemaDefault,
          scopeLabel + ' schema default for "' + key + '" must match the config builder default'
        );
      }
    };

    assertDefaultParity('top-level', schema.properties, topDefaults);
    assertDefaultParity('camera', schema.definitions.camera.properties, cameraDefaults);
  });

  it(
    'keeps deploy/config.schema.json bounds, enums, even-pixel rules, and key sets in sync with ' +
      'src/config.js and deploy/config.example.full.yaml',
    () => {
      // Verify deploy/config.schema.json bounds, enums, even-pixel rules, and key sets match src/config.js
      // and full YAML example
      const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy/config.schema.json'), 'utf8'));
      const full = /** @type {Record<string, *>} */ (
        jsYaml.load(fs.readFileSync(path.join(REPO_ROOT, 'deploy/config.example.full.yaml'), 'utf8'))
      );
      const MS = 1000;
      const deref = (prop) => (prop.$ref ? schema.definitions[prop.$ref.split('/').pop()] : prop);
      const buildTop = (overrides) =>
        new BridgeConfigBuilder({
          cameras: [{serial: 'T8161T0000000000'}],
          ...overrides,
        }).build();
      const buildCam = (camOverrides) =>
        new BridgeConfigBuilder({
          cameras: [{serial: 'T8161T0000000000', ...camOverrides}],
        }).build().cameras[0];

      const topResolvers = {
        width: (v) => buildTop({width: v}).width,
        height: (v) => buildTop({height: v}).height,
        live_fps: (v) => buildTop({live_fps: v, idle_fps: 1}).live_fps,
        idle_fps: (v) => buildTop({live_fps: 60, idle_fps: v}).idle_fps,
        snapshot_capture_delay_secs: (v) => buildTop({snapshot_capture_delay_secs: v}).snapDelayMs / MS,
        hold_secs: (v) =>
          buildTop({hold_secs: v, stream_max_secs: 86400, low_battery_hold_secs: 5}).cameras[0].timers.holdMs / MS,
        stream_max_secs: (v) => buildTop({hold_secs: 5, stream_max_secs: v}).maxMs / MS,
        frigate_event_secs: (v) => buildTop({frigate_event_secs: v}).cameras[0].timers.eventSecs,
        idle_timeout_secs: (v) => buildTop({idle_timeout_secs: v}).earlySleepMs / MS,
        view_linger_secs: (v) => buildTop({view_linger_secs: v, view_max_secs: 86400}).lingerMs / MS,
        view_max_secs: (v) => buildTop({view_linger_secs: 5, view_max_secs: v}).viewMaxMs / MS,
        view_cooldown_secs: (v) => buildTop({view_cooldown_secs: v}).cooldownMs / MS,
        backfill_delay_secs: (v) => buildTop({backfill_delay_secs: v}).backfillDelayMs / MS,
        low_battery_threshold: (v) =>
          buildTop({critical_battery_threshold: 1, low_battery_threshold: v}).low_battery_threshold,
        critical_battery_threshold: (v) =>
          buildTop({low_battery_threshold: 99, critical_battery_threshold: v}).critical_battery_threshold,
        low_battery_hold_secs: (v) => buildTop({hold_secs: 3600, low_battery_hold_secs: v}).lowBatHoldMs / MS,
        telemetry_poll_secs: (v) => buildTop({telemetry_poll_secs: v}).telemetryPollMs / MS,
      };
      const camResolvers = {
        priority: (v) => buildCam({priority: v}).priority,
        hold_secs: (v) => buildCam({hold_secs: v, stream_max_secs: 86400, low_battery_hold_secs: 5}).timers.holdMs / MS,
        stream_max_secs: (v) => buildCam({hold_secs: 5, stream_max_secs: v}).timers.maxMs / MS,
        frigate_event_secs: (v) => buildCam({frigate_event_secs: v}).timers.eventSecs,
        idle_timeout_secs: (v) => buildCam({idle_timeout_secs: v}).timers.earlySleepMs / MS,
        view_linger_secs: (v) => buildCam({view_linger_secs: v, view_max_secs: 86400}).timers.lingerMs / MS,
        view_max_secs: (v) => buildCam({view_linger_secs: 5, view_max_secs: v}).timers.viewMaxMs / MS,
        low_battery_threshold: (v) =>
          buildCam({critical_battery_threshold: 1, low_battery_threshold: v}).timers.lowBatThreshold,
        critical_battery_threshold: (v) =>
          buildCam({low_battery_threshold: 99, critical_battery_threshold: v}).timers.criticalBatThreshold,
        low_battery_hold_secs: (v) => buildCam({hold_secs: 3600, low_battery_hold_secs: v}).timers.lowBatHoldMs / MS,
        recording_clip_length: (v) =>
          buildCam({mode: 'custom', end_early: true, recording_clip_length: v}).hwRecordingConfig.recordingClipLength,
        recording_retrigger_interval: (v) =>
          buildCam({mode: 'custom', recording_retrigger_interval: v}).hwRecordingConfig.recordingRetriggerInterval,
      };

      const assertBoundParity = (scopeLabel, properties, resolvers) => {
        for (const [key, rawProp] of Object.entries(properties)) {
          const prop = deref(rawProp);
          if (prop.minimum === undefined && prop.maximum === undefined) {
            continue;
          }
          assert.ok(key in resolvers, scopeLabel + ' numeric property "' + key + '" missing bound parity resolver');
          const resolve = resolvers[key];
          assert.equal(
            resolve(prop.minimum - 2),
            prop.minimum,
            scopeLabel + ' "' + key + '" minimum (' + prop.minimum + ') must match src/config.js clamp floor'
          );
          assert.equal(
            resolve(prop.maximum + 2),
            prop.maximum,
            scopeLabel + ' "' + key + '" maximum (' + prop.maximum + ') must match src/config.js clamp ceiling'
          );
        }
      };
      assertBoundParity('top-level', schema.properties, topResolvers);
      assertBoundParity('camera', schema.definitions.camera.properties, camResolvers);

      // Even-integer requirement for YUV420p dimensions
      assert.equal(schema.properties.width.multipleOf, 2);
      assert.equal(schema.properties.height.multipleOf, 2);
      assert.equal(buildTop({width: 1281}).width, 1280);
      assert.equal(buildTop({height: 721}).height, 720);

      // Enum parity with src/config.js
      assert.deepEqual(deref(schema.properties.card_theme).enum, Object.values(CARD_THEMES));
      assert.deepEqual(new Set(deref(schema.properties.card_position).enum), new Set(Object.values(CARD_POSITIONS)));
      assert.deepEqual(deref(schema.properties.sleep_screen).enum, Object.values(SLEEP_SCREENS));
      assert.deepEqual(new Set(schema.definitions.camera.properties.mode.enum), new Set(Object.values(CAMERA_MODES)));
      assert.deepEqual(
        schema.definitions.camera.properties.power_working_mode.enum,
        Object.values(POWER_WORKING_MODES)
      );
      assert.equal(schema.definitions.camera.properties.station_serial.minLength, 1);

      // Every top-level schema key is accepted by validateConfig and illustrated in deploy/config.example.full.yaml
      for (const key of Object.keys(schema.properties)) {
        assert.ok(key in full, 'deploy/config.example.full.yaml missing top-level schema key: ' + key);
      }
      const frontDoorbell = full.cameras.find((c) => c.name === 'front_doorbell');
      assert.ok(frontDoorbell && frontDoorbell.frigate_event_secs === 30);
    }
  );
});

describe('Quick Start Step 1 & Configuration Validation (validateConfig & resolveServiceEndpoints)', () => {
  it(
    'resolves hybrid environment service endpoints ' + '(default derivation, host/port, RTSP auth, and URL overrides)',
    () => {
      // Verify default host/port derivation, go2rtc host inheritance, RTSP credential encoding, and URL overrides
      const defaults = resolveServiceEndpoints({});
      assert.equal(defaults.eufy_security_ws_url, 'ws://eufy-security-ws:3000');
      assert.equal(defaults.frigate_url, 'http://frigate:5000');
      assert.equal(defaults.go2rtc_url, 'http://frigate:1984');
      assert.equal(defaults.rtsp_publish_url, 'rtsp://frigate:8554/{name}');
      assert.equal(defaults.ha_webhook_url, '');

      const splitHostPort = resolveServiceEndpoints({
        EUFY_WS_HOST: 'eufy-ws.internal',
        EUFY_WS_PORT: '3100',
        FRIGATE_HOST: 'nvr.internal',
        FRIGATE_PORT: '5001',
        GO2RTC_RTSP_USER: 'bridge',
        GO2RTC_RTSP_PASSWORD: 'p@ss:word/1',
        HA_WEBHOOK_URL: 'http://ha:8123/api/webhook/test',
      });
      assert.equal(splitHostPort.eufy_security_ws_url, 'ws://eufy-ws.internal:3100');
      assert.equal(splitHostPort.frigate_url, 'http://nvr.internal:5001');
      assert.equal(splitHostPort.go2rtc_url, 'http://nvr.internal:1984');
      assert.equal(splitHostPort.rtsp_publish_url, 'rtsp://bridge:p%40ss%3Aword%2F1@nvr.internal:8554/{name}');
      assert.equal(splitHostPort.ha_webhook_url, 'http://ha:8123/api/webhook/test');

      const overrides = resolveServiceEndpoints({
        EUFY_WS_URL: 'wss://eufy.example.com/ws',
        FRIGATE_URL: 'https://frigate.example.com:8971/api/',
        GO2RTC_URL: 'http://go2rtc-custom:1985/api/',
        GO2RTC_RTSP_URL: 'rtsps://go2rtc-custom:8555/',
      });
      assert.equal(overrides.eufy_security_ws_url, 'wss://eufy.example.com/ws');
      assert.equal(overrides.frigate_url, 'https://frigate.example.com:8971');
      assert.equal(overrides.go2rtc_url, 'http://go2rtc-custom:1985');
      assert.equal(overrides.rtsp_publish_url, 'rtsps://go2rtc-custom:8555/{name}');

      const customYamlPath = path.join(TEST_TMP_DIR, 'custom.yaml');
      assert.equal(resolveConfigFilePath({BRIDGE_CONFIG: customYamlPath}), customYamlPath);
      assert.equal(resolveConfigFilePath({}), '/config/config.yaml');
    }
  );

  it('validates minimal YAML camera configuration and rejects unknown, legacy, or env-only keys in one pass', () => {
    // Verify minimal cameras[] validation, identity normalization, and strict single-pass rejection of removed keys
    const quickStartConfig = {
      cameras: [
        {
          serial: 'T8161T0000000000',
          title: 'Storage Room Camera',
          mode: 'rtsp',
          priority: 50,
        },
        {
          serial: 'T8161T1111111111',
          name: 'garage',
          title: 'Garage Camera',
          mode: 'rtsp',
          priority: 50,
        },
      ],
    };
    validateConfig(quickStartConfig);
    assert.equal(quickStartConfig.cameras[0].name, 'T8161T0000000000');
    assert.equal(quickStartConfig.cameras[1].name, 'garage');

    assert.throws(
      () =>
        validateConfig({
          $schema: './config.schema.json',
          eufy_ws: 'ws://e:3000',
          frigate_url: 'http://frigate:5000',
          rtsp_output_url: 'rtsp://frigate:8554/{name}',
          hwaccel: 'vaapi',
          log_level: 'debug',
          backfill_only: true,
          unknown_top: 123,
          cameras: [{serial: 'T8161T0000000000', unknown_cam: true}],
        }),
      (err) => {
        assert.match(err.message, /unknown key "\$schema"/);
        assert.match(err.message, /unknown key "eufy_ws"/);
        assert.match(err.message, /unknown key "frigate_url"/);
        assert.match(err.message, /unknown key "rtsp_output_url"/);
        assert.match(err.message, /unknown key "hwaccel"/);
        assert.match(err.message, /unknown key "log_level"/);
        assert.match(err.message, /unknown key "backfill_only"/);
        assert.match(err.message, /unknown key "unknown_top"/);
        assert.match(err.message, /unknown camera key "cameras\[0\]\.unknown_cam"/);
        return true;
      }
    );
    assert.throws(() => validateConfig({cameras: []}), /"cameras" must list at least one/);
    assert.throws(() => validateConfig({cameras: [{}]}), /"cameras" must list at least one/);
  });
});

describe('Camera Mode Presets & Unified hold_secs / end_early Auto-Sync', () => {
  it('resolves "auto" mode when mode is omitted (60s hold, end_early=false, RTSP enabled when supported)', () => {
    const rawCam = {serial: 'T8161T0000000000'};
    const mode = resolveCameraMode(rawCam);
    const timers = resolveCameraTimers(rawCam);
    const hw = resolveHardwareRecordingConfig(rawCam, timers);
    assert.equal(mode, 'auto');
    assert.equal(timers.mode, 'auto');
    assert.equal(timers.useRtsp, true);
    assert.equal(timers.alwaysBackfill, false);
    assert.equal(timers.holdMs, 60000);
    assert.equal(timers.eventSecs, 60);
    assert.equal(timers.letEufyDecideEnd, false);
    assert.equal(hw.powerWorkingMode, 2);
    assert.equal(hw.recordingClipLength, 60);
    assert.equal(hw.recordingEndClipMotionStops, false);
    assert.equal(hw.recordingRetriggerInterval, 5);
  });

  it('resolves "rtsp" mode with 60s hold, end_early=false, and Power Manager 60s full-clip sync', () => {
    const rawCam = {serial: 'T8161T0000000000', mode: 'rtsp'};
    const timers = resolveCameraTimers(rawCam);
    const hw = resolveHardwareRecordingConfig(rawCam, timers);
    assert.equal(timers.mode, 'rtsp');
    assert.equal(timers.useRtsp, true);
    assert.equal(timers.alwaysBackfill, false);
    assert.equal(timers.holdMs, 60000);
    assert.equal(timers.eventSecs, 60);
    assert.equal(timers.letEufyDecideEnd, false);
    assert.equal(hw.powerWorkingMode, 2);
    assert.equal(hw.recordingClipLength, 60);
    assert.equal(hw.recordingEndClipMotionStops, false);
  });

  it(
    'resolves "backfill" mode with 30s hold, end_early=true, useRtsp=true (so RTSP cameras keep RTSP ' +
      'Live View while backfilling events), and Power Manager 30s early-end sync',
    () => {
      const rawCam = {serial: 'T8214T2222222222', mode: 'backfill'};
      const timers = resolveCameraTimers(rawCam);
      const hw = resolveHardwareRecordingConfig(rawCam, timers);
      assert.equal(timers.mode, 'backfill');
      assert.equal(timers.useRtsp, true);
      assert.equal(timers.alwaysBackfill, true);
      assert.equal(timers.holdMs, 30000);
      assert.equal(timers.eventSecs, 30);
      assert.equal(timers.letEufyDecideEnd, true);
      assert.equal(hw.powerWorkingMode, 2);
      assert.equal(hw.recordingClipLength, 30);
      assert.equal(hw.recordingEndClipMotionStops, true);
    }
  );

  it('resolves "p2p" mode with 60s hold, end_early=false, useRtsp=false, and alwaysBackfill=false', () => {
    const rawCam = {serial: 'T8140T0000000000', mode: 'p2p'};
    const timers = resolveCameraTimers(rawCam);
    const hw = resolveHardwareRecordingConfig(rawCam, timers);
    assert.equal(timers.mode, 'p2p');
    assert.equal(timers.useRtsp, false);
    assert.equal(timers.alwaysBackfill, false);
    assert.equal(timers.holdMs, 60000);
    assert.equal(timers.eventSecs, 60);
    assert.equal(timers.letEufyDecideEnd, false);
    assert.equal(hw.recordingClipLength, 60);
    assert.equal(hw.recordingEndClipMotionStops, false);
  });

  it(
    'automatically syncs per-camera hold_secs and end_early across bridge timers, Frigate event duration, ' +
      'and Eufy Power Manager while allowing independent frigate_event_secs in "custom" mode',
    () => {
      const tunedRtsp = {
        serial: 'T8161T0000000000',
        mode: 'rtsp',
        hold_secs: 45,
        end_early: true,
      };
      const tunedTimers = resolveCameraTimers(tunedRtsp);
      const tunedHw = resolveHardwareRecordingConfig(tunedRtsp, tunedTimers);
      assert.equal(tunedTimers.holdMs, 45000);
      assert.equal(tunedTimers.eventSecs, 45);
      assert.equal(tunedTimers.letEufyDecideEnd, true);
      assert.equal(tunedHw.recordingClipLength, 45);
      assert.equal(tunedHw.recordingEndClipMotionStops, true);

      const customCam = {
        serial: 'T8161T1111111111',
        mode: 'custom',
        hold_secs: 60,
        frigate_event_secs: 45,
        end_early: false,
        recording_retrigger_interval: 10,
        enforce_streaming_quality: 7,
      };
      const customTimers = resolveCameraTimers(customCam);
      const customHw = resolveHardwareRecordingConfig(customCam, customTimers);
      assert.equal(customTimers.holdMs, 60000);
      assert.equal(customTimers.eventSecs, 45);
      assert.equal(customHw.recordingClipLength, 60);
      assert.equal(customHw.recordingRetriggerInterval, 10);
      assert.equal(customHw.enforceQuality, 7);
    }
  );

  it(
    'resolves direct rtsp_url cameras to mode "rtsp" with optional serial/eufy_security_ws_url, disabled ' +
      'backfill/power/telemetry, and rejects incompatible modes or homebase_rtsp_url',
    () => {
      // Verify explicit rtsp_url resolves mode="rtsp" (even when mode is omitted or "auto"), disables
      // backfill/power/telemetry, and rejects p2p/backfill/custom or homebase_rtsp_url
      assert.equal('RTSP_DIRECT' in CAMERA_MODES, false);
      const rawCam = {
        name: 'baby_crib',
        title: 'Baby Crib Camera',
        rtsp_url: 'rtsp://admin:secret@192.168.1.50:554/live0',
      };
      const mode = resolveCameraMode(rawCam);
      const timers = resolveCameraTimers(rawCam);
      const hw = resolveHardwareRecordingConfig(rawCam, timers);
      const tel = resolveTelemetryConfig(rawCam);
      assert.equal(mode, 'rtsp');
      assert.equal(resolveCameraMode({...rawCam, mode: 'auto'}), 'rtsp');
      assert.equal(timers.mode, 'rtsp');
      assert.equal(timers.useRtsp, true);
      assert.equal(timers.alwaysBackfill, false);
      assert.equal(timers.backfillDownloads, false);
      assert.equal(timers.letEufyDecideEnd, false);
      assert.equal(hw.powerWorkingMode, null);
      assert.equal(hw.recordingClipLength, null);
      assert.equal(hw.recordingEndClipMotionStops, null);
      assert.equal(hw.recordingRetriggerInterval, null);
      assert.equal(hw.enforceQuality, null);
      assert.deepEqual(tel, {
        enabled: false,
        battery: false,
        powerSource: false,
        wifi: false,
        rssi: false,
        temperature: false,
        lastSeen: false,
      });

      // Pure direct rtsp_url config can omit camera serial (deriving internal serial from name while tracking
      // explicitSerial='')
      const directOnlyCfg = {
        cameras: [
          {
            name: 'baby_crib',
            mode: 'rtsp',
            rtsp_url: 'rtsp://192.168.1.50:554/live0',
          },
        ],
      };
      assert.doesNotThrow(() => validateConfig(directOnlyCfg));
      assert.equal(directOnlyCfg.cameras[0].serial, 'baby_crib');
      assert.equal(directOnlyCfg.cameras[0].name, 'baby_crib');
      const builtDirect = new BridgeConfigBuilder(directOnlyCfg).build();
      assert.equal(builtDirect.eufy_security_ws_url, '');
      assert.equal(builtDirect.cameras[0].mode, 'rtsp');
      assert.equal(builtDirect.cameras[0].rtsp_url, 'rtsp://192.168.1.50:554/live0');
      assert.equal(builtDirect.cameras[0].explicitSerial, '');
      assert.equal('homebase_rtsp_url' in builtDirect.cameras[0], false);
      assert.equal(builtDirect.cameras[0].startupSnapshot, false);

      // Strips go2rtc-style URI #fragment options (e.g. #backchannel=0) from rtsp_url while preserving # in passwords
      assert.equal(
        stripRtspUrlFragment('rtsp://user:123@192.0.2.10/live0#backchannel=0'),
        'rtsp://user:123@192.0.2.10/live0'
      );
      assert.equal(
        stripRtspUrlFragment('rtsp://user:pa#ss@192.0.2.10/live0#backchannel=0'),
        'rtsp://user:pa#ss@192.0.2.10/live0'
      );
      assert.equal(stripRtspUrlFragment('rtsp://user:pa#ss@192.0.2.10#backchannel=0'), 'rtsp://user:pa#ss@192.0.2.10');
      const resolvedWithFragment = resolveCameraConfig({
        name: 'play_mat_camera',
        mode: 'rtsp',
        rtsp_url: 'rtsp://user:pa#ss@192.0.2.10/live0#backchannel=0',
      });
      assert.equal(resolvedWithFragment.rtsp_url, 'rtsp://user:pa#ss@192.0.2.10/live0');

      // Rejects invalid rtsp_url, incompatible modes with rtsp_url, and removed homebase_rtsp_url key
      assert.throws(
        () =>
          validateConfig({
            cameras: [{serial: 'T8352P0000000001', name: 'baby_crib', rtsp_url: 'http://192.168.1.50/live0'}],
          }),
        /cameras\[0\] "rtsp_url" must start with rtsp:\/\/ or rtsps:\/\//
      );
      for (const badMode of ['p2p', 'backfill', 'custom', 'rtsp_direct']) {
        assert.throws(
          () =>
            validateConfig({
              cameras: [{name: 'baby_crib', mode: badMode, rtsp_url: 'rtsp://192.168.1.50:554/live0'}],
            }),
          /cannot combine "rtsp_url" with mode/
        );
      }
      assert.throws(
        () =>
          validateConfig({
            cameras: [{serial: 'T8161T0000000001', homebase_rtsp_url: 'rtsp://192.168.1.50/live0'}],
          }),
        /unknown camera key "cameras\[0\]\.homebase_rtsp_url"/
      );
    }
  );
});

describe('Defensive Non-Contradiction Validation ("custom" mode & frame rates)', () => {
  it('clamps idle_fps down to live_fps when idle_fps exceeds live_fps', () => {
    const rates = resolveFrameRates({live_fps: 12, idle_fps: 25});
    assert.equal(rates.liveFps, 12);
    assert.equal(rates.idleFps, 12);
  });

  it(
    'allows useRtsp and alwaysBackfill to coexist so RTSP-capable cameras in backfill/custom mode can ' +
      'stream Live View over RTSP while backfilling motion clips',
    () => {
      const timers = resolveCameraTimers({
        serial: 'T8161CUSTOM0001',
        mode: 'custom',
        use_rtsp: true,
        backfill_only: true,
      });
      assert.equal(timers.mode, 'custom');
      assert.equal(timers.alwaysBackfill, true);
      assert.equal(timers.useRtsp, true);
    }
  );

  it(
    'clamps stream_max_secs >= hold_secs, view_max_secs >= view_linger_secs, ' +
      'low_battery_hold_secs <= hold_secs, and 0 < critical_battery_threshold < low_battery_threshold <= 99',
    () => {
      // Verify timer and battery threshold non-contradiction clamping (1 <= critical < low <= 99)
      const timers = resolveCameraTimers({
        serial: 'T8161CUSTOM0001',
        mode: 'custom',
        hold_secs: 60,
        stream_max_secs: 25,
        view_linger_secs: 45,
        view_max_secs: 20,
        low_battery_hold_secs: 90,
        low_battery_threshold: 100,
        critical_battery_threshold: 0,
        recording_end_early: true,
      });
      assert.equal(timers.holdMs, 60000);
      assert.equal(timers.maxMs, 60000);
      assert.equal(timers.lingerMs, 45000);
      assert.equal(timers.viewMaxMs, 45000);
      assert.equal(timers.lowBatHoldMs, 60000);
      assert.equal(timers.lowBatThreshold, 99);
      assert.equal(timers.criticalBatThreshold, 1);
      assert.equal(timers.letEufyDecideEnd, true);

      const invertedBatTimers = resolveCameraTimers({
        serial: 'T8161CUSTOM0002',
        low_battery_threshold: 15,
        critical_battery_threshold: 20,
      });
      assert.equal(invertedBatTimers.lowBatThreshold, 15);
      assert.equal(invertedBatTimers.criticalBatThreshold, 14);
    }
  );

  it('disables hardware Power Manager sync when sync_power=false', () => {
    const hw = resolveHardwareRecordingConfig({
      serial: 'T8161CUSTOM0003',
      mode: 'rtsp',
      sync_power: false,
    });
    assert.equal(hw.powerWorkingMode, null);
    assert.equal(hw.recordingClipLength, null);
    assert.equal(hw.recordingEndClipMotionStops, null);
    assert.equal(hw.recordingRetriggerInterval, null);
  });

  it(
    'promotes power_working_mode < 2 to 2 when custom clip settings are specified, and raises ' +
      'recording_clip_length >= hold_secs when end_early=false',
    () => {
      const rawCam = {
        serial: 'T8161CUSTOM0001',
        mode: 'custom',
        hold_secs: 60,
        end_early: false,
        power_working_mode: 0,
        recording_clip_length: 20,
      };
      const timers = resolveCameraTimers(rawCam);
      const hw = resolveHardwareRecordingConfig(rawCam, timers);
      assert.equal(hw.powerWorkingMode, 2);
      assert.equal(hw.recordingClipLength, 60);
      assert.equal(hw.recordingEndClipMotionStops, false);
      assert.equal(hw.recordingRetriggerInterval, 5);
    }
  );

  it(
    'promotes power_working_mode=0 to 2 when hold_secs > 20 or end_early=false, and preserves compatible ' +
      'presets (mode 1 or mode 0 with 20s + end_early=true)',
    () => {
      const conflictingMode0 = {
        serial: 'T8161CUSTOM0002',
        mode: 'custom',
        hold_secs: 60,
        end_early: false,
        power_working_mode: 0,
      };
      const conflictingTimers = resolveCameraTimers(conflictingMode0);
      const conflictingHw = resolveHardwareRecordingConfig(conflictingMode0, conflictingTimers);
      assert.equal(conflictingHw.powerWorkingMode, 2);
      assert.equal(conflictingHw.recordingClipLength, 60);
      assert.equal(conflictingHw.recordingEndClipMotionStops, false);

      const compatibleMode0 = {
        serial: 'T8161CUSTOM0003',
        mode: 'custom',
        hold_secs: 20,
        end_early: true,
        power_working_mode: 0,
      };
      const compatibleMode0Hw = resolveHardwareRecordingConfig(compatibleMode0, resolveCameraTimers(compatibleMode0));
      assert.equal(compatibleMode0Hw.powerWorkingMode, 0);
      assert.equal(compatibleMode0Hw.recordingClipLength, null);
      assert.equal(compatibleMode0Hw.recordingEndClipMotionStops, null);
      assert.equal(compatibleMode0Hw.recordingRetriggerInterval, null);

      const surveillanceMode1 = {
        serial: 'T8161CUSTOM0004',
        mode: 'custom',
        power_working_mode: 1,
      };
      const surveillanceHw = resolveHardwareRecordingConfig(surveillanceMode1, resolveCameraTimers(surveillanceMode1));
      assert.equal(surveillanceHw.powerWorkingMode, 1);
      assert.equal(surveillanceHw.recordingClipLength, null);
      assert.equal(surveillanceHw.recordingEndClipMotionStops, null);
    }
  );

  it(
    'supports per-camera backfill_enabled, trigger_events, low_battery_threshold, ' +
      'critical_battery_threshold, and low_battery_wake_on_view while protecting backfill mode',
    () => {
      const standaloneP2p = resolveCameraTimers({
        serial: 'T8134STANDALONE1',
        mode: 'p2p',
        backfill_enabled: false,
        low_battery_threshold: 15,
        critical_battery_threshold: 3,
        low_battery_wake_on_view: true,
      });
      assert.equal(standaloneP2p.backfillDownloads, false);
      assert.equal(standaloneP2p.lowBatThreshold, 15);
      assert.equal(standaloneP2p.criticalBatThreshold, 3);
      assert.equal(standaloneP2p.lowBatWakeOnView, true);

      const protectedBackfill = resolveCameraTimers({
        serial: 'T8214T2222222222',
        mode: 'backfill',
        backfill_enabled: false,
      });
      assert.equal(
        protectedBackfill.backfillDownloads,
        true,
        'backfill mode must keep backfillDownloads=true even if backfill_enabled=false is passed'
      );

      const customTriggers = resolveCameraTriggers({
        serial: 'T8214T2222222222',
        trigger_events: ['person', 'ring'],
      });
      assert.equal(customTriggers.has('person detected'), true);
      assert.equal(customTriggers.has('identity person detected'), true);
      assert.equal(customTriggers.has('rings'), true);
      assert.equal(customTriggers.has('motion detected'), false);

      const fallbackTriggers = resolveCameraTriggers({serial: 'T8161T0000000000'});
      assert.equal(fallbackTriggers, TRIGGERS);
    }
  );
});

describe('Status Card Theme, Position, Sleep Screen, Telemetry & Event Priority Rules', () => {
  it('defaults to "minimal" theme at "bottom-left" position with "snapshot" sleep_screen', () => {
    const cardCfg = resolveCardConfig({});
    assert.equal(cardCfg.theme, 'minimal');
    assert.equal(cardCfg.position, 'bottom-left');
    assert.equal(cardCfg.sleepScreen, 'snapshot');
  });

  it(
    'supports all documented card_theme ("glance", "minimal", "pebbles", "hud", "none"), card_position, ' +
      'and sleep_screen values',
    () => {
      assert.equal(normalizeCardTheme('glance'), 'glance');
      assert.equal(normalizeCardTheme('minimal'), 'minimal');
      assert.equal(normalizeCardTheme('pebbles'), 'pebbles');
      assert.equal(normalizeCardTheme('hud'), 'hud');
      assert.equal(normalizeCardTheme('none'), 'none');
      assert.equal(normalizeCardTheme(false), 'none');
      // Verify clean cutover: removed theme names fall back to default "minimal"
      assert.equal(normalizeCardTheme('detailed'), 'minimal');
      assert.equal(normalizeCardTheme('icons'), 'minimal');
      assert.equal(normalizeCardTheme('debug'), 'minimal');

      assert.equal(normalizeCardPosition('bottom-left'), 'bottom-left');
      assert.equal(normalizeCardPosition('bottom-center'), 'bottom-center');
      assert.equal(normalizeCardPosition('center-bottom'), 'bottom-center');
      assert.equal(normalizeCardPosition('bottom-right'), 'bottom-right');
      assert.equal(normalizeCardPosition('top-left'), 'top-left');
      assert.equal(normalizeCardPosition('top-center'), 'top-center');
      assert.equal(normalizeCardPosition('center-top'), 'top-center');
      assert.equal(normalizeCardPosition('top-right'), 'top-right');
      assert.equal(normalizeCardPosition('center'), 'center');

      assert.equal(normalizeSleepScreen('snapshot'), 'snapshot');
      assert.equal(normalizeSleepScreen('slate'), 'slate');
      assert.equal(normalizeSleepScreen('black'), 'black');
    }
  );

  it('honors per-camera card_theme, card_position, and sleep_screen overrides', () => {
    const customCard = resolveCardConfig({
      serial: 'T8161T0000000000',
      card_theme: 'pebbles',
      card_position: 'top-right',
      sleep_screen: 'slate',
    });
    assert.equal(customCard.theme, 'pebbles');
    assert.equal(customCard.position, 'top-right');
    assert.equal(customCard.sleepScreen, 'slate');
  });

  it('expands all 13 documented trigger_events types and resolves built-in and custom event_priorities tiers', () => {
    // Regression: verify all 13 documented trigger_events expand cleanly and 'someone loitering' never
    // substring-matches 'ring'.
    const allTriggerTypes = resolveCameraTriggers({
      serial: 'T8214T2222222222',
      trigger_events: [
        'motion',
        'radar',
        'person',
        'identity person',
        'stranger',
        'loitering',
        'package',
        'pet',
        'dog',
        'vehicle',
        'sound',
        'crying',
        'ring',
      ],
    });
    assert.equal(allTriggerTypes.has('motion detected'), true);
    assert.equal(allTriggerTypes.has('radar motion detected'), true);
    assert.equal(allTriggerTypes.has('person detected'), true);
    assert.equal(allTriggerTypes.has('identity person detected'), true);
    assert.equal(allTriggerTypes.has('stranger person detected'), true);
    assert.equal(allTriggerTypes.has('someone loitering'), true);
    assert.equal(allTriggerTypes.has('package delivered'), true);
    assert.equal(allTriggerTypes.has('pet detected'), true);
    assert.equal(allTriggerTypes.has('dog detected'), true);
    assert.equal(allTriggerTypes.has('vehicle detected'), true);
    assert.equal(allTriggerTypes.has('sound detected'), true);
    assert.equal(allTriggerTypes.has('crying detected'), true);
    assert.equal(allTriggerTypes.has('rings'), true);

    const cryingOnly = resolveCameraTriggers({
      serial: 'T8161T0000000000',
      trigger_events: ['crying'],
    });
    assert.equal(cryingOnly.has('crying detected'), true);
    assert.equal(cryingOnly.has('motion detected'), false);

    // Built-in priority tiers documented in README.md
    assert.equal(getEventPriority('rings'), 1000);
    assert.equal(getEventPriority('identity person detected'), 300);
    assert.equal(getEventPriority('person detected'), 200);
    assert.equal(getEventPriority('stranger person detected'), 200);
    assert.equal(getEventPriority('someone loitering'), 200);
    assert.equal(getEventPriority('package delivered'), 150);
    assert.equal(getEventPriority('vehicle detected'), 100);
    assert.equal(getEventPriority('pet detected'), 100);
    assert.equal(getEventPriority('dog detected'), 100);
    assert.equal(getEventPriority('crying detected'), 50);
    assert.equal(getEventPriority('sound detected'), 50);
    assert.equal(getEventPriority('radar motion detected'), 10);
    assert.equal(getEventPriority('motion detected'), 10);

    // Custom event_priorities override object
    const customTiers = {
      ring: 2000,
      'identity person': 500,
      person: 250,
      motion: 25,
    };
    assert.equal(getEventPriority('rings', customTiers), 2000);
    assert.equal(getEventPriority('someone loitering', customTiers), 200);
    assert.equal(getEventPriority('identity person detected', customTiers), 500);
    assert.equal(getEventPriority('person detected', customTiers), 250);
    assert.equal(getEventPriority('motion detected', customTiers), 25);
  });

  it(
    'resolves telemetry boolean and granular item flags (battery, power_source, wifi, rssi default true; ' +
      'temperature, last_seen default false)',
    () => {
      const telDefault = resolveTelemetryConfig({});
      assert.equal(telDefault.enabled, true);
      assert.equal(telDefault.battery, true);
      assert.equal(telDefault.powerSource, true);
      assert.equal(telDefault.wifi, true);
      assert.equal(telDefault.rssi, true);
      assert.equal(telDefault.temperature, false);
      assert.equal(telDefault.lastSeen, false);

      const telOff = resolveTelemetryConfig({telemetry: false});
      assert.equal(telOff.enabled, false);
      assert.equal(telOff.battery, false);
      assert.equal(telOff.powerSource, false);
      assert.equal(telOff.wifi, false);
      assert.equal(telOff.rssi, false);
      assert.equal(telOff.temperature, false);
      assert.equal(telOff.lastSeen, false);

      const telCustom = resolveTelemetryConfig({
        telemetry: {
          power_source: false,
          rssi: false,
          temperature: true,
          last_seen: true,
        },
      });
      assert.equal(telCustom.enabled, true);
      assert.equal(telCustom.battery, true);
      assert.equal(telCustom.powerSource, false);
      assert.equal(telCustom.wifi, true);
      assert.equal(telCustom.rssi, false);
      assert.equal(telCustom.temperature, true);
      assert.equal(telCustom.lastSeen, true);
    }
  );

  it('returns deeply frozen immutable configuration value objects across all resolvers', () => {
    const timers = resolveCameraTimers({serial: 'T8161T0000000000', mode: 'rtsp'});
    const hwCfg = resolveHardwareRecordingConfig({serial: 'T8161T0000000000', mode: 'rtsp'}, timers);
    const telCfg = resolveTelemetryConfig({serial: 'T8161T0000000000'});
    const cardCfg = resolveCardConfig({serial: 'T8161T0000000000'});
    const rates = resolveFrameRates({live_fps: 15, idle_fps: 5});

    assert.equal(Object.isFrozen(timers), true);
    assert.equal(Object.isFrozen(hwCfg), true);
    assert.equal(Object.isFrozen(telCfg), true);
    assert.equal(Object.isFrozen(cardCfg), true);
    assert.equal(Object.isFrozen(rates), true);
  });

  it(
    'builds a single deeply frozen immutable configuration instance via BridgeConfigBuilder and reuses ' +
      'pre-built camera sub-configs across domain models',
    () => {
      assert.equal(typeof BridgeConfigBuilder, 'function');
      assert.equal(typeof resolveCameraConfig, 'function');
      assert.equal(Object.isFrozen(cfg), true, 'Global cfg instance must be frozen');
      assert.equal(Object.isFrozen(cfg.cameras), true, 'cfg.cameras array must be frozen');
      assert.ok(cfg.cameras.length > 0);
      for (const camCfg of cfg.cameras) {
        assert.equal(Object.isFrozen(camCfg), true);
        assert.equal(Object.isFrozen(camCfg.timers), true);
        assert.equal(Object.isFrozen(camCfg.cardConfig), true);
        assert.equal(Object.isFrozen(camCfg.telemetryConfig), true);
        assert.equal(Object.isFrozen(camCfg.hwRecordingConfig), true);
      }

      const builtCfg = new BridgeConfigBuilder(
        {
          live_fps: 15,
          idle_fps: 5,
          cameras: [{serial: 'T8161T0000000000', name: 'driveway', mode: 'rtsp', hold_secs: 45}],
        },
        {
          FRIGATE_HOST: 'frigate',
          FRIGATE_PORT: '5000',
          BRIDGE_HTTP_PORT: '9090',
          BRIDGE_HWACCEL: 'vaapi',
          BRIDGE_HWACCEL_DEVICE: '/dev/dri/nonexistent',
        }
      )
        .withEndpoints()
        .withVideoAndAudio()
        .withTimersAndArbitration()
        .withEventsAndOverlays()
        .withCameras()
        .build();

      assert.equal(Object.isFrozen(builtCfg), true);
      assert.equal(builtCfg.frigate_url, 'http://frigate:5000');
      assert.equal(builtCfg.go2rtc_url, 'http://frigate:1984');
      assert.equal(builtCfg.rtsp_publish_url, 'rtsp://frigate:8554/{name}');
      assert.equal(builtCfg.http_port, 9090);
      assert.equal(builtCfg.activeHwaccel, '');
      assert.equal(Object.isFrozen(builtCfg.cameras), true);
      const camSlice = builtCfg.cameras[0];
      assert.equal(Object.isFrozen(camSlice), true);
      assert.equal(camSlice.timers.holdMs, 45000);

      // Constructing a Camera from the pre-built immutable camera config reuses exact frozen sub-objects
      // without re-building
      const cam = new Camera(camSlice);
      assert.equal(cam.timers, camSlice.timers);
      assert.equal(cam.triggers, camSlice.triggers);
      assert.equal(cam.telemetry.config, camSlice.telemetryConfig);
      assert.equal(cam.telemetry.hwRecordingCfg, camSlice.hwRecordingConfig);

      // CameraConfig and Camera share unified identity domain methods
      // (no duplicated cam && !cam.name && cam.serial checks)
      assert.equal(typeof CameraConfig, 'function');
      assert.equal(camSlice instanceof CameraConfig, true);
      assert.equal(camSlice.getName(), 'driveway');
      assert.equal(camSlice.getSerial(), 'T8161T0000000000');
      assert.equal(camSlice.getScopeName(), 'driveway');
      assert.equal(camSlice.getCacheFileName(), 'last_driveway_T8161T0000000000.jpg');
      assert.equal(camSlice.hasValidIdentity(), true);

      assert.equal(cam.getName(), 'driveway');
      assert.equal(cam.getSerial(), 'T8161T0000000000');
      assert.equal(cam.getScopeName(), 'driveway');
      assert.equal(cam.getCacheFileName(), 'last_driveway_T8161T0000000000.jpg');
      assert.equal(cam.hasValidIdentity(), true);
      assert.equal(cam.hasPendingViewerWake(), false);

      const unnamedRaw = {serial: '  T8214T2222222222  '};
      assert.equal(CameraConfig.hasValidIdentity(unnamedRaw), true);
      assert.equal(unnamedRaw.name, 'T8214T2222222222');
      assert.equal(CameraConfig.resolveScopeName(unnamedRaw), 'T8214T2222222222');
      assert.equal(CameraConfig.resolveScopeName({}), 'bridge');
      assert.equal(CameraConfig.resolveCacheFileName(camSlice), 'last_driveway_T8161T0000000000.jpg');
      assert.equal(CameraConfig.resolveCacheFileName(cam), 'last_driveway_T8161T0000000000.jpg');
      assert.equal(CameraConfig.hasValidIdentity({}), false);
      assert.equal(CameraConfig.hasValidIdentity(null), false);
    }
  );

  it(
    'exports deeply frozen, semantically separated cross-layer constant groups for signals, themes, ' +
      'positions, sleep screens, titles, modes, and hwaccel',
    () => {
      assert.equal(Object.isFrozen(PROCESS_SIGNALS), true);
      assert.deepEqual(PROCESS_SIGNALS, {
        SIGTERM: 'SIGTERM',
        SIGINT: 'SIGINT',
        SIGKILL: 'SIGKILL',
        SIGUSR1: 'SIGUSR1',
        SIGUSR2: 'SIGUSR2',
      });

      assert.equal(Object.isFrozen(CARD_THEMES), true);
      assert.deepEqual(CARD_THEMES, {
        GLANCE: 'glance',
        MINIMAL: 'minimal',
        PEBBLES: 'pebbles',
        HUD: 'hud',
        NONE: 'none',
      });

      assert.equal(Object.isFrozen(CARD_POSITIONS), true);
      assert.deepEqual(CARD_POSITIONS, {
        CENTER: 'center',
        TOP_LEFT: 'top-left',
        TOP_CENTER: 'top-center',
        TOP_RIGHT: 'top-right',
        BOTTOM_LEFT: 'bottom-left',
        BOTTOM_CENTER: 'bottom-center',
        BOTTOM_RIGHT: 'bottom-right',
      });

      assert.equal(Object.isFrozen(SLEEP_SCREENS), true);
      assert.deepEqual(SLEEP_SCREENS, {
        SNAPSHOT: 'snapshot',
        SLATE: 'slate',
        BLACK: 'black',
      });

      assert.equal(Object.isFrozen(CARD_STATUS_TITLES), true);
      assert.deepEqual(CARD_STATUS_TITLES, {
        ASLEEP: 'Asleep',
        ASLEEP_LOW_BATTERY: 'Asleep (Low Battery)',
        DISCONNECTED: 'Disconnected',
        WAKING_UP: 'Waking Up...',
        WAITING: 'Waiting',
        LIVE: 'Live',
        BACKFILL: 'Backfill',
      });

      assert.equal(Object.isFrozen(CAMERA_MODES), true);
      assert.deepEqual(CAMERA_MODES, {
        AUTO: 'auto',
        RTSP: 'rtsp',
        P2P: 'p2p',
        BACKFILL: 'backfill',
        CUSTOM: 'custom',
      });

      assert.equal(Object.isFrozen(STREAM_MODES), true);
      assert.deepEqual(STREAM_MODES, {
        RTSP: 'rtsp',
        P2P: 'p2p',
        DOWNLOAD: 'download',
      });

      assert.equal(Object.isFrozen(HWACCEL_MODES), true);
      assert.deepEqual(HWACCEL_MODES, {
        NONE: '',
        VAAPI: 'vaapi',
        QSV: 'qsv',
        NVENC: 'nvenc',
        V4L2M2M: 'v4l2m2m',
      });

      assert.equal(Object.isFrozen(FRAME_STAGE_MARKERS), true);
      assert.deepEqual(FRAME_STAGE_MARKERS, {
        SNAPSHOT: 'S',
        FIRST_BACKFILL: 'FB',
        BACKFILL: 'B',
        LIVE: 'L',
      });

      assert.equal(Object.isFrozen(POWER_WORKING_MODES), true);
      assert.deepEqual(POWER_WORKING_MODES, {
        BATTERY_SAVER: 0,
        SURVEILLANCE: 1,
        CUSTOMIZE_RECORDING: 2,
      });

      assert.equal(normalizeCardTheme(CARD_THEMES.GLANCE), CARD_THEMES.GLANCE);
      assert.equal(normalizeCardTheme(CARD_THEMES.PEBBLES), CARD_THEMES.PEBBLES);
      assert.equal(normalizeCardTheme(CARD_THEMES.HUD), CARD_THEMES.HUD);
      assert.equal(normalizeCardTheme('test'), CARD_THEMES.MINIMAL);
      assert.equal(normalizeCardTheme(CARD_THEMES.NONE), CARD_THEMES.NONE);
      assert.equal(normalizeCardPosition(CARD_POSITIONS.CENTER), CARD_POSITIONS.CENTER);
      assert.equal(normalizeSleepScreen(SLEEP_SCREENS.SLATE), SLEEP_SCREENS.SLATE);
      assert.equal(resolveCameraMode({mode: CAMERA_MODES.BACKFILL}), CAMERA_MODES.BACKFILL);

      assert.equal(typeof BRIDGE_VERSION, 'string');
      assert.ok(BRIDGE_VERSION.length > 0);
      assert.equal(typeof BRIDGE_COMMIT, 'string');
      assert.ok(BRIDGE_COMMIT.length > 0);
      const customBuild = resolveBuildInfo({BRIDGE_VERSION: 'v0.0.1', BRIDGE_COMMIT: 'a1b2c3d-dirty'});
      assert.equal(Object.isFrozen(customBuild), true);
      assert.deepEqual(customBuild, {version: 'v0.0.1', commit: 'a1b2c3d-dirty'});
      const fallbackBuild = resolveBuildInfo({});
      assert.equal(fallbackBuild.version, '0.0.2');
      assert.equal(fallbackBuild.commit, 'dev');
      const trimmedBuild = resolveBuildInfo({BRIDGE_VERSION: '  v1.5.0  ', BRIDGE_COMMIT: '  abc1234  '});
      assert.deepEqual(trimmedBuild, {version: 'v1.5.0', commit: 'abc1234'});
    }
  );

  it('defaults experimental track_stuck_spotlight to false and resolves global and per-camera overrides', () => {
    // Verify track_stuck_spotlight defaults to false and supports independent global and per-camera boolean overrides
    const defaultBuilt = new BridgeConfigBuilder({
      cameras: [{serial: 'T8161T0000000001'}],
    }).build();
    assert.equal(defaultBuilt.track_stuck_spotlight, false);
    assert.equal(defaultBuilt.cameras[0].trackStuckSpotlight, false);

    const globalEnabledBuilt = new BridgeConfigBuilder({
      track_stuck_spotlight: true,
      cameras: [{serial: 'T8161T0000000001'}, {serial: 'T8161T0000000002', track_stuck_spotlight: false}],
    }).build();
    assert.equal(globalEnabledBuilt.track_stuck_spotlight, true);
    assert.equal(globalEnabledBuilt.cameras[0].trackStuckSpotlight, true);
    assert.equal(globalEnabledBuilt.cameras[1].trackStuckSpotlight, false);

    const camOverrideBuilt = new BridgeConfigBuilder({
      sync_power: false,
      cameras: [{serial: 'T8161T0000000003', track_stuck_spotlight: true}],
    }).build();
    assert.equal(camOverrideBuilt.track_stuck_spotlight, false);
    assert.equal(camOverrideBuilt.cameras[0].trackStuckSpotlight, true);
  });

  it(
    'logs startup warnings when explicitly specified top-level or per-camera configuration ' + 'options are ignored',
    () => {
      const captureWarnings = (fn) => {
        const warnings = [];
        const origWarn = log.warn;
        log.warn = (scope, ...args) => {
          warnings.push({scope: String(scope), msg: args.join(' ')});
        };
        try {
          fn();
        } finally {
          log.warn = origWarn;
        }
        return warnings;
      };

      // 1. Clean full example config emits zero ignored-option warnings
      const fullExample = /** @type {Record<string, *>} */ (
        jsYaml.load(fs.readFileSync(path.join(REPO_ROOT, 'deploy/config.example.full.yaml'), 'utf8'))
      );
      const fullWarnings = captureWarnings(() => {
        new BridgeConfigBuilder(fullExample, {
          BRIDGE_HWACCEL: 'vaapi',
          BRIDGE_HWACCEL_DEVICE: '/dev/dri/renderD128',
        }).build();
      }).filter((w) => w.msg.includes('ignoring '));
      assert.deepEqual(fullWarnings, []);

      // 2. Per-camera options ignored when direct rtsp_url is configured
      const directWarnings = captureWarnings(() => {
        resolveCameraConfig({
          name: 'crib_cam',
          mode: 'rtsp',
          rtsp_url: 'rtsp://192.168.1.50:554/live0',
          hold_secs: 60,
          stream_max_secs: 900,
          view_linger_secs: 20,
          view_max_secs: 300,
          idle_timeout_secs: 15,
          end_early: true,
          frigate_event_secs: 30,
          station_serial: 'T8030P0000000001',
          priority: 100,
          use_rtsp: true,
          backfill_only: false,
          backfill_enabled: false,
          low_battery_threshold: 25,
          low_battery_hold_secs: 20,
          low_battery_wake_on_view: false,
          sync_power: false,
          track_stuck_spotlight: true,
          power_working_mode: 2,
          recording_clip_length: 60,
          recording_end_early: false,
          recording_retrigger_interval: 5,
          enforce_streaming_quality: true,
          trigger_events: ['motion'],
          startup_snapshot: true,
          telemetry: {battery: true},
        });
      });
      assert.equal(directWarnings.length, 1);
      assert.equal(directWarnings[0].scope, 'crib_cam');
      assert.match(
        directWarnings[0].msg,
        /ignoring .*hold_secs.*stream_max_secs.*startup_snapshot.*telemetry.* when rtsp_url is set/
      );

      // 3. Per-camera mode-specific ignored options (backfill_only outside custom, use_rtsp overridden,
      //    idle_timeout_secs in backfill)
      const modeSpecificWarnings = captureWarnings(() => {
        resolveCameraConfig({
          serial: 'T8161T0000000010',
          name: 'driveway',
          mode: 'rtsp',
          backfill_only: true,
          use_rtsp: false,
        });
        resolveCameraConfig({
          serial: 'T8214T0000000011',
          name: 'doorbell',
          mode: 'backfill',
          idle_timeout_secs: 20,
        });
      });
      assert.equal(
        modeSpecificWarnings.some(
          (w) => w.scope === 'driveway' && w.msg.includes('ignoring backfill_only=true in mode="rtsp"')
        ),
        true
      );
      assert.equal(
        modeSpecificWarnings.some(
          (w) => w.scope === 'driveway' && w.msg.includes('ignoring use_rtsp=false in mode="rtsp"')
        ),
        true
      );
      assert.equal(
        modeSpecificWarnings.some(
          (w) => w.scope === 'doorbell' && w.msg.includes('ignoring idle_timeout_secs=20 in backfill-only mode')
        ),
        true
      );

      // 4. Power Manager options ignored when sync_power=false
      const powerWarnings = captureWarnings(() => {
        resolveCameraConfig({
          serial: 'T8161T0000000013',
          name: 'shed',
          mode: 'rtsp',
          sync_power: false,
          power_working_mode: 2,
          recording_clip_length: 60,
          recording_end_early: false,
          recording_retrigger_interval: 5,
        });
      });
      assert.equal(
        powerWarnings.some(
          (w) =>
            w.scope === 'shed' &&
            w.msg.includes(
              'ignoring power_working_mode, recording_clip_length, recording_end_early, ' +
                'recording_retrigger_interval because sync_power=false'
            )
        ),
        true
      );

      // 5. Status card, telemetry, and sleep_screen ignored options
      const cardWarnings = captureWarnings(() => {
        resolveCameraConfig({
          serial: 'T8161T0000000014',
          name: 'no_card_cam',
          card_theme: 'none',
          card_position: 'top-right',
          card_show_on_live: true,
          telemetry: {battery: true},
          sleep_screen: 'slate',
          startup_snapshot: true,
        });
        resolveCameraConfig({
          serial: 'T8161T0000000015',
          name: 'center_glance_cam',
          card_theme: 'glance',
          card_position: 'center',
          card_show_on_live: true,
          telemetry: {enabled: false, battery: true, wifi: true},
        });
        resolveCameraConfig({
          serial: 'T8161T0000000016',
          name: 'minimal_cam',
          card_theme: 'minimal',
          telemetry: {temperature: true, last_seen: true},
        });
      });
      assert.equal(
        cardWarnings.some(
          (w) =>
            w.scope === 'no_card_cam' &&
            w.msg.includes('ignoring card_position, card_show_on_live, telemetry when card_theme="none"')
        ),
        true
      );
      assert.equal(
        cardWarnings.some(
          (w) => w.scope === 'no_card_cam' && w.msg.includes('ignoring startup_snapshot=true when sleep_screen="slate"')
        ),
        true
      );
      assert.equal(
        cardWarnings.some(
          (w) =>
            w.scope === 'center_glance_cam' &&
            w.msg.includes('ignoring card_show_on_live=true when card_position="center"')
        ),
        true
      );
      assert.equal(
        cardWarnings.some(
          (w) =>
            w.scope === 'center_glance_cam' &&
            w.msg.includes('ignoring telemetry.battery, telemetry.wifi because telemetry.enabled=false')
        ),
        true
      );
      assert.equal(
        cardWarnings.some(
          (w) =>
            w.scope === 'minimal_cam' &&
            w.msg.includes('ignoring telemetry.temperature, telemetry.last_seen when card_theme="minimal"')
        ),
        true
      );

      // 6. Top-level bridge and env ignored options
      const topWarnings = captureWarnings(() => {
        new BridgeConfigBuilder(
          {
            card_theme: 'none',
            card_position: 'top-left',
            sleep_screen: 'slate',
            startup_snapshot: true,
            cameras: [{serial: 'T8161T0000000017', name: 'front', mode: 'rtsp'}],
          },
          {BRIDGE_HWACCEL: 'false', BRIDGE_HWACCEL_DEVICE: '/dev/dri/renderD128'}
        ).build();
      });
      assert.equal(
        topWarnings.some(
          (w) => w.scope === 'bridge' && w.msg.includes('ignoring BRIDGE_HWACCEL_DEVICE="/dev/dri/renderD128"')
        ),
        true
      );
      assert.equal(
        topWarnings.some(
          (w) => w.scope === 'bridge' && w.msg.includes('ignoring card_position when card_theme="none"')
        ),
        true
      );
      assert.equal(
        topWarnings.some(
          (w) => w.scope === 'bridge' && w.msg.includes('ignoring startup_snapshot=true when sleep_screen="slate"')
        ),
        true
      );
    }
  );
});

describe('Environment Variable Expansion (${ENV_VAR} in config.yaml)', () => {
  it(
    'expands ${ENV_VAR} and ${ENV_VAR:-default} placeholders across strings, arrays, and nested objects ' +
      'without mutating input or double-expanding special characters',
    () => {
      // Verify ${ENV_VAR}, ${ENV_VAR:-default}, $${VAR} escaping, and special $ characters in secrets
      // expand cleanly in one pass
      const rawInput = {
        trigger_events: ['${PRIMARY_TRIGGER:-person}', 'ring'],
        cameras: [
          {
            name: 'play_mat_camera',
            title: 'Play Mat $${LITERAL_TAG}',
            mode: 'rtsp',
            rtsp_url: 'rtsp://${RTSP_USER}:${RTSP_PASSWORD}@192.0.2.10:554/live0',
          },
          {
            name: 'crib_camera',
            rtsp_url: '${CRIB_CAMERA_RTSP_URL}',
          },
        ],
      };
      const env = {
        RTSP_USER: 'cam_user',
        RTSP_PASSWORD: 'p$ss$$w0rd$&$\'"\\${UNEXPANDED_INNER}',
        CRIB_CAMERA_RTSP_URL: 'rtsp://crib_user:crib$pass@192.0.2.11:554/live0',
      };

      const expanded = expandConfigEnvVars(rawInput, env);
      assert.equal(rawInput.cameras[0].rtsp_url, 'rtsp://${RTSP_USER}:${RTSP_PASSWORD}@192.0.2.10:554/live0');
      assert.deepEqual(expanded.trigger_events, ['person', 'ring']);
      assert.equal(expanded.cameras[0].title, 'Play Mat ${LITERAL_TAG}');
      assert.equal(
        expanded.cameras[0].rtsp_url,
        'rtsp://cam_user:p$ss$$w0rd$&$\'"\\${UNEXPANDED_INNER}@192.0.2.10:554/live0'
      );
      assert.equal(expanded.cameras[1].rtsp_url, 'rtsp://crib_user:crib$pass@192.0.2.11:554/live0');
    }
  );

  it(
    'loads config.yaml from disk via loadConfigFile, resolves direct rtsp_url cameras, and masks expanded ' +
      'RTSP credentials in /api/config',
    () => {
      // Verify loadConfigFile parses YAML with comments, expands secrets before validateConfig, and masks
      // credentials in /api/config
      const tmpDir = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'bridge-env-cfg-'));
      const cfgPath = path.join(tmpDir, 'custom-bridge.yaml');
      try {
        fs.writeFileSync(
          cfgPath,
          [
            '# yaml-language-server: $schema=https://example.invalid/config.schema.json',
            '# Camera topology configuration',
            'cameras:',
            '  - name: play_mat_camera',
            '    title: Play Mat Camera',
            '    mode: rtsp',
            '    rtsp_url: rtsp://${RTSP_USER}:${RTSP_PASSWORD}@192.0.2.10:554/live0',
            '  - name: nursery_camera',
            '    title: Nursery Camera',
            '    rtsp_url: ${NURSERY_CAMERA_RTSP_URL}',
          ].join('\n'),
          'utf8'
        );

        const loaded = loadConfigFile(cfgPath, {
          RTSP_USER: 'admin',
          RTSP_PASSWORD: 's3cr3t_value',
          NURSERY_CAMERA_RTSP_URL: 'rtsps://viewer:other_s3cr3t@192.0.2.11:8555/live0',
        });
        const built = new BridgeConfigBuilder(loaded, {FRIGATE_HOST: 'frigate'}).build();
        assert.equal(built.frigate_url, 'http://frigate:5000');
        assert.equal(built.eufy_security_ws_url, '');
        assert.equal(built.cameras[0].rtsp_url, 'rtsp://admin:s3cr3t_value@192.0.2.10:554/live0');
        assert.equal(built.cameras[1].rtsp_url, 'rtsps://viewer:other_s3cr3t@192.0.2.11:8555/live0');
        assert.equal(built.cameras[1].timers.mode, 'rtsp');

        const cams = built.cameras.map((camCfg) => new Camera(camCfg));
        assert.equal(cams[0].getRtspUrl(), 'rtsp://admin:s3cr3t_value@192.0.2.10:554/live0');
        const apiPayload = buildConfigPayload(cams);
        const serialized = JSON.stringify(apiPayload);
        assert.equal(apiPayload.cameras[0].rtsp_url, 'rtsp://***@192.0.2.10:554/live0');
        assert.equal(apiPayload.cameras[1].rtsp_url, 'rtsps://***@192.0.2.11:8555/live0');
        assert.equal(serialized.includes('s3cr3t_value'), false);
        assert.equal(serialized.includes('other_s3cr3t'), false);
      } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    }
  );

  it(
    'fails in a single pass when any referenced ${ENV_VAR} is unset, empty, or an Object.prototype key ' +
      'without leaking resolved secrets',
    () => {
      // Verify unset, empty, and prototype-named environment placeholders all report in one error without
      // leaking other secrets
      const tmpDir = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'bridge-env-missing-'));
      const cfgPath = path.join(tmpDir, 'config.yaml');
      try {
        fs.writeFileSync(
          cfgPath,
          [
            'cameras:',
            '  - name: play_mat_camera',
            '    mode: rtsp',
            '    rtsp_url: rtsp://${MISSING_RTSP_USER}:${EMPTY_RTSP_PASSWORD}@192.0.2.10:554/${toString}',
            '  - name: secret_cam',
            '    mode: rtsp',
            '    rtsp_url: rtsp://user:${VALID_SECRET}@192.0.2.12:554/live0',
          ].join('\n'),
          'utf8'
        );

        assert.throws(
          () =>
            loadConfigFile(cfgPath, {
              VALID_SECRET: 'DO_NOT_LEAK_ME_999',
              EMPTY_RTSP_PASSWORD: '',
            }),
          (err) => {
            assert.match(err.message, /config\.yaml:/);
            assert.match(err.message, /environment variable "MISSING_RTSP_USER" is not set \(cameras\[0\]\.rtsp_url\)/);
            assert.match(
              err.message,
              /environment variable "EMPTY_RTSP_PASSWORD" is not set \(cameras\[0\]\.rtsp_url\)/
            );
            assert.match(err.message, /environment variable "toString" is not set \(cameras\[0\]\.rtsp_url\)/);
            assert.equal(err.message.includes('DO_NOT_LEAK_ME_999'), false);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    }
  );

  it('rejects malformed or unclosed ${...} placeholders in expandConfigEnvVars() without leaking secrets', () => {
    // Regression: typos like ${RTSP_PASS, ${123}, ${}, or ${VAR:default} must fail in one pass
    const malformedCases = [
      'rtsp://user:${RTSP_PASS@192.0.2.10:554/live0',
      'rtsp://${123}:pass@192.0.2.10:554/live0',
      'rtsp://${}:pass@192.0.2.10:554/live0',
      'rtsp://${RTSP_USER:default}@192.0.2.10:554/live0',
      'rtsp://${FOO ${BAR}@192.0.2.10:554/live0',
    ];
    for (const badUrl of malformedCases) {
      assert.throws(
        () =>
          expandConfigEnvVars(
            {
              cameras: [
                {name: 'secret_cam', mode: 'rtsp', rtsp_url: 'rtsp://${OK_SECRET}@192.0.2.11:554/live0'},
                {name: 'bad_cam', mode: 'rtsp', rtsp_url: badUrl},
              ],
            },
            {OK_SECRET: 'DO_NOT_LEAK_SECRET', BAR: 'bar'}
          ),
        (err) => {
          assert.match(
            err.message,
            /config\.yaml:.*malformed environment variable placeholder.*cameras\[1\]\.rtsp_url/
          );
          assert.equal(err.message.includes('DO_NOT_LEAK_SECRET'), false);
          return true;
        }
      );
    }

    // Escaped $${...} sequences remain literal without failing malformed checks
    const escaped = expandConfigEnvVars({
      cameras: [{name: 'esc_cam', title: 'Tag $${123} $${LITERAL_ONLY}', serial: 'T8161T0000000099'}],
    });
    assert.equal(escaped.cameras[0].title, 'Tag ${123} ${LITERAL_ONLY}');
  });

  it('enforces CHANGELOG.md release heading parity on exact vX.Y.Z Git tags in scripts/check-docs.js', () => {
    // Verify release tags require a matching ## vX.Y.Z top section with entries and forbid ## dev
    const checkDocsPath = path.join(REPO_ROOT, 'scripts/check-docs.js');
    if (!fs.existsSync(checkDocsPath)) {
      return;
    }
    const {checkChangelogReleaseTag} = require(checkDocsPath);
    assert.equal(typeof checkChangelogReleaseTag, 'function');

    const validChangelog = '# Changelog\n\n## v0.0.2\n\n- Ship clean release\n\n## v0.0.1\n\n- Initial release\n';
    const okErrors = [];
    checkChangelogReleaseTag('v0.0.2', validChangelog, okErrors);
    assert.deepEqual(okErrors, []);

    const devErrors = [];
    checkChangelogReleaseTag('v0.0.2', '# Changelog\n\n## dev\n\n- Unreleased item\n', devErrors);
    assert.ok(devErrors.some((e) => e.includes('## dev')));

    const mismatchErrors = [];
    checkChangelogReleaseTag('v0.0.3', validChangelog, mismatchErrors);
    assert.ok(mismatchErrors.some((e) => e.includes('v0.0.3')));

    const emptyErrors = [];
    checkChangelogReleaseTag('v0.0.2', '# Changelog\n\n## v0.0.2\n\n## v0.0.1\n\n- Initial release\n', emptyErrors);
    assert.ok(emptyErrors.length > 0);
  });

  it(
    'formats null-prototype IPC errors and suite-level worker crashes in test/reporter.js without throwing ' +
      'or hiding failures',
    async () => {
      // Regression: node:test IPC error payloads with Object.create(null) prototypes or file-level suite crashes
      // must never throw TypeError on String(err) or produce zero output on exit status 1
      const conciseReporter = require('./reporter');
      async function collectReporterOutput(events) {
        let out = '';
        for await (const chunk of conciseReporter(
          (async function* () {
            for (const ev of events) {
              yield ev;
            }
          })()
        )) {
          out += chunk;
        }
        return out;
      }

      // 1. Null-prototype error object without .stack or .message
      const nullProtoErr = Object.assign(Object.create(null), {
        code: 'ERR_TEST_FAILURE',
        failureType: 'testTimeoutFailure',
      });
      const nullProtoOut = await collectReporterOutput([
        {
          type: 'test:fail',
          data: {name: 'timed out test', details: {type: 'test', error: nullProtoErr}},
        },
        {type: 'test:summary', data: {duration_ms: 42, success: false}},
      ]);
      assert.match(nullProtoOut, /FAIL: timed out test/);
      assert.match(nullProtoOut, /ERR_TEST_FAILURE/);
      assert.match(nullProtoOut, /Tests failed: 1 failed, 0 passed \(42ms\)/);

      // 2. File/suite-level crash (details.type === 'suite' with failureType !== 'subtestsFailed') and zero leaf tests
      const suiteCrashErr = Object.assign(Object.create(null), {
        code: 'ERR_TEST_FAILURE',
        failureType: 'testCodeFailure',
        message: 'test/services.test.js exited with code 1',
      });
      const suiteCrashOut = await collectReporterOutput([
        {
          type: 'test:fail',
          data: {name: 'test/services.test.js', details: {type: 'suite', error: suiteCrashErr}},
        },
        {type: 'test:summary', data: {duration_ms: 8100, success: false}},
      ]);
      assert.match(suiteCrashOut, /FAIL: test\/services\.test\.js/);
      assert.match(suiteCrashOut, /exited with code 1/);
      assert.match(suiteCrashOut, /Tests failed: 1 failed, 0 passed \(8100ms\)/);

      // 3. Leaf failure + parent suite 'subtestsFailed' rollup counts as 1 failure (not 2)
      const rollupOut = await collectReporterOutput([
        {type: 'test:pass', data: {name: 'ok leaf', details: {type: 'test'}}},
        {
          type: 'test:fail',
          data: {name: 'bad leaf', details: {type: 'test', error: new Error('boom')}},
        },
        {
          type: 'test:fail',
          data: {
            name: 'parent describe',
            details: {
              type: 'suite',
              error: Object.assign(new Error('1 subtest failed'), {failureType: 'subtestsFailed'}),
            },
          },
        },
        {type: 'test:summary', data: {duration_ms: 15, success: false}},
      ]);
      assert.match(rollupOut, /FAIL: bad leaf/);
      assert.equal(rollupOut.includes('FAIL: parent describe'), false);
      assert.match(rollupOut, /Tests failed: 1 failed, 1 passed \(15ms\)/);
    }
  );

  it(
    'propagates top-level BridgeConfigBuilder timer and quality defaults into per-camera timers ' +
      'and hwRecordingConfig without module-global bleed',
    () => {
      const built = new BridgeConfigBuilder(
        {
          stream_max_secs: 180,
          view_linger_secs: 15,
          view_max_secs: 120,
          idle_timeout_secs: 25,
          low_battery_hold_secs: 15,
          low_battery_wake_on_view: true,
          enforce_streaming_quality: 2,
          cameras: [{serial: 'T8161T0000000099', mode: 'rtsp'}],
        },
        {}
      ).build();

      const camCfg = built.cameras[0];
      assert.equal(camCfg.timers.maxMs, 180000);
      assert.equal(camCfg.timers.lingerMs, 15000);
      assert.equal(camCfg.timers.viewMaxMs, 120000);
      assert.equal(camCfg.timers.earlySleepMs, 25000);
      assert.equal(camCfg.timers.lowBatHoldMs, 15000);
      assert.equal(camCfg.timers.lowBatWakeOnView, true);
      assert.equal(camCfg.hwRecordingConfig.enforceQuality, 2);
    }
  );

  it(
    'rejects non-integer or out-of-range port environment variables and exits 0 in Dockerfile ' +
      'HEALTHCHECK when BRIDGE_HTTP_PORT=0',
    () => {
      const invalidServiceCases = [
        {EUFY_WS_PORT: '3000abc'},
        {FRIGATE_PORT: '5000.5'},
        {GO2RTC_API_PORT: '0'},
        {GO2RTC_RTSP_PORT: '65536'},
        {EUFY_WS_PORT: '-1'},
      ];
      for (const envCase of invalidServiceCases) {
        assert.throws(() => resolveServiceEndpoints(envCase), /must be an integer/);
      }

      const baseRaw = {cameras: [{serial: 'T8161T0000000000', mode: 'rtsp'}]};
      assert.equal(new BridgeConfigBuilder(baseRaw, {BRIDGE_HTTP_PORT: '0'}).withEndpoints().build().http_port, 0);
      for (const badHttpPort of ['8080abc', '80.5', '-1', '65536', '1e3']) {
        assert.throws(
          () => new BridgeConfigBuilder(baseRaw, {BRIDGE_HTTP_PORT: badHttpPort}).withEndpoints(),
          /BRIDGE_HTTP_PORT must be an integer/
        );
      }

      // Regression: .dockerignore must not exclude deploy/Dockerfile so Stage 1 builder tests can read it
      const dockerignorePath = path.join(REPO_ROOT, '.dockerignore');
      if (fs.existsSync(dockerignorePath)) {
        const dockerignoreLines = fs.readFileSync(dockerignorePath, 'utf8').split(/\r?\n/);
        assert.equal(
          dockerignoreLines.includes('deploy/Dockerfile') || dockerignoreLines.includes('deploy/'),
          false,
          '.dockerignore must not exclude deploy/Dockerfile or deploy/ (needed by builder-stage tests)'
        );
      }

      const dockerfile = fs.readFileSync(path.resolve(__dirname, '..', 'deploy', 'Dockerfile'), 'utf8');
      assert.equal(
        dockerfile.includes('mesa-dri-gallium'),
        false,
        'deploy/Dockerfile must not install unneeded OpenGL 3D mesa-dri-gallium drivers'
      );
      assert.ok(
        dockerfile.includes('FROM docker.io/library/alpine:3.23'),
        'deploy/Dockerfile runtime stage must use minimal alpine:3.23 without npm/yarn/corepack'
      );
      assert.ok(
        dockerfile.includes('COPY --from=builder /usr/local/bin/node /usr/local/bin/node'),
        'deploy/Dockerfile must copy only the stripped node binary from builder'
      );
      assert.ok(
        dockerfile.includes('find /app/node_modules') && dockerfile.includes('-empty -delete'),
        'deploy/Dockerfile builder must prune empty @scope dirs and docs from /app/node_modules'
      );
      const healthMatch = dockerfile.match(/HEALTHCHECK[^\n]*\\\r?\n\s*CMD\s+(.+)/);
      assert.ok(healthMatch, 'deploy/Dockerfile must declare a HEALTHCHECK CMD');
      const {execFileSync} = require('node:child_process');
      execFileSync('/bin/sh', ['-c', healthMatch[1].trim()], {
        env: {BRIDGE_HTTP_PORT: '0'},
        stdio: 'pipe',
      });
      assert.throws(() => {
        execFileSync('/bin/sh', ['-c', healthMatch[1].trim()], {
          env: {BRIDGE_HTTP_PORT: '1'},
          stdio: 'pipe',
        });
      });
    }
  );
});
