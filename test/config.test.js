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

process.env.LOG_LEVEL = 'error';
process.env.CACHE_DIR = '/tmp';

const {
  cfg,
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
} = require('../src/config');
const {Camera} = require('../src/domain/camera');

const REPO_ROOT = path.resolve(__dirname, '..');

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

  it('validates deploy/config.schema.json, deploy/config.example.minimal.json, deploy/config.example.full.json, and package.json', () => {
    const schemaPath = path.join(REPO_ROOT, 'deploy/config.schema.json');
    const minPath = path.join(REPO_ROOT, 'deploy/config.example.minimal.json');
    const fullPath = path.join(REPO_ROOT, 'deploy/config.example.full.json');
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const schemaUrl =
      'https://raw.githubusercontent.com/obatiuk/eufy-frigate-battery-bridge/main/deploy/config.schema.json';
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.equal(schema.$id, schemaUrl);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['eufy_security_ws_url', 'frigate_url', 'cameras']);
    assert.ok(schema.properties && schema.properties.$schema);
    assert.ok(schema.definitions && schema.definitions.camera);
    assert.deepEqual(schema.definitions.camera.required, ['serial']);
    assert.equal(schema.definitions.camera.additionalProperties, false);

    const minimal = JSON.parse(fs.readFileSync(minPath, 'utf8'));
    assert.equal(minimal.$schema, schemaUrl);
    for (const k of Object.keys(minimal)) {
      assert.ok(k in schema.properties, 'Schema missing top-level property: ' + k);
    }
    assert.doesNotThrow(() => validateConfig(minimal));

    const full = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    assert.equal(full.$schema, schemaUrl);
    for (const k of Object.keys(full)) {
      assert.ok(k in schema.properties, 'Schema missing top-level property: ' + k);
    }
    for (const cam of full.cameras) {
      for (const ck of Object.keys(cam)) {
        assert.ok(ck in schema.definitions.camera.properties, 'Schema missing camera property: ' + ck);
      }
    }
    assert.doesNotThrow(() => validateConfig(full));
    // Verify backfill_delay_secs defaults to 2s across config singleton, builder, schema, and full example
    assert.equal(BACKFILL_DELAY_MS, 2000, 'Default BACKFILL_DELAY_MS must be 2000ms (2s)');
    assert.equal(schema.properties.backfill_delay_secs.default, 2, 'Schema default for backfill_delay_secs must be 2');
    assert.equal(full.backfill_delay_secs, 2, 'Full example config backfill_delay_secs must be 2');

    // Verify bridge starts cleanly offline even when $schema points to an unreachable URL
    const offlineSchemaCfg = {
      $schema: 'https://unreachable.invalid/nonexistent/config.schema.json',
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000',
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
    const WS = require('ws');
    assert.equal(typeof WS, 'function');
    const {isTrackedPropertyEvent, extractRecognizedPerson} = require('../src/services/eufy-client');
    assert.equal(isTrackedPropertyEvent('battery'), true);
    assert.equal(isTrackedPropertyEvent('rtspStreamUrl'), true);
    assert.equal(isTrackedPropertyEvent('unknownProp'), false);
    assert.equal(extractRecognizedPerson({event: 'identity person detected', person: 'Alice'}), 'Alice');
    assert.equal(extractRecognizedPerson({event: 'person detected', person: 'Stranger'}), '');
  });

  it('keeps every deploy/config.schema.json top-level and camera default equal to the builder default', () => {
    // Regression: backfill_delay_secs drifted between config.js, the schema, the examples, and the README
    const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy/config.schema.json'), 'utf8'));
    const built = new BridgeConfigBuilder({
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000',
      cameras: [{serial: 'T8161T0000000000'}],
    }).build();
    const cam = built.cameras[0];
    const MS = 1000;
    const syncPowerEnabled = cam.hwRecordingConfig.powerWorkingMode !== null;
    // Schema key -> value resolved when the key is omitted from config.json.
    const topDefaults = {
      http_port: built.http_port,
      width: built.width,
      height: built.height,
      live_fps: built.live_fps,
      idle_fps: built.idle_fps,
      audio: built.audio,
      hwaccel: Boolean(built.activeHwaccel),
      hwaccel_device: built.hwaccel_device,
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
      backfill_only: cam.timers.alwaysBackfill,
      backfill_delay_secs: built.backfillDelayMs / MS,
      sync_power: syncPowerEnabled,
      track_stuck_spotlight: built.track_stuck_spotlight,
      enforce_streaming_quality: built.enforce_streaming_quality,
      low_battery_threshold: built.low_battery_threshold,
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
      'go2rtc_url', // placeholder host in the schema, derived from frigate_url at runtime
      'rtsp_output_url', // placeholder host in the schema, derived from frigate_url at runtime
      'cache_dir', // container path in the schema, resolved from CACHE_DIR at runtime
      'log_level', // resolved by initLogger from LOG_LEVEL before the builder runs
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

  it('keeps deploy/config.schema.json bounds, enums, even-pixel rules, and key sets in sync with src/config.js and deploy/config.example.full.json', () => {
    // Verify deploy/config.schema.json bounds, enums, even-pixel rules, and key sets match src/config.js and full example
    const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy/config.schema.json'), 'utf8'));
    const full = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy/config.example.full.json'), 'utf8'));
    const MS = 1000;
    const deref = (prop) => (prop.$ref ? schema.definitions[prop.$ref.split('/').pop()] : prop);
    const buildTop = (overrides) =>
      new BridgeConfigBuilder({
        eufy_security_ws_url: 'ws://eufy-security-ws:3000',
        frigate_url: 'http://frigate:5000',
        cameras: [{serial: 'T8161T0000000000'}],
        ...overrides,
      }).build();
    const buildCam = (camOverrides) =>
      new BridgeConfigBuilder({
        eufy_security_ws_url: 'ws://eufy-security-ws:3000',
        frigate_url: 'http://frigate:5000',
        cameras: [{serial: 'T8161T0000000000', ...camOverrides}],
      }).build().cameras[0];

    const topResolvers = {
      http_port: (v) => buildTop({http_port: v}).http_port,
      width: (v) => buildTop({width: v}).width,
      height: (v) => buildTop({height: v}).height,
      live_fps: (v) => buildTop({live_fps: v, idle_fps: 1}).live_fps,
      idle_fps: (v) => buildTop({live_fps: 60, idle_fps: v}).idle_fps,
      snapshot_capture_delay_secs: (v) => buildTop({snapshot_capture_delay_secs: v}).snapDelayMs / MS,
      hold_secs: (v) => buildTop({hold_secs: v, stream_max_secs: 86400, low_battery_hold_secs: 5}).cameras[0].timers.holdMs / MS,
      stream_max_secs: (v) => buildTop({hold_secs: 5, stream_max_secs: v}).maxMs / MS,
      frigate_event_secs: (v) => buildTop({frigate_event_secs: v}).cameras[0].timers.eventSecs,
      idle_timeout_secs: (v) => buildTop({idle_timeout_secs: v}).earlySleepMs / MS,
      view_linger_secs: (v) => buildTop({view_linger_secs: v, view_max_secs: 86400}).lingerMs / MS,
      view_max_secs: (v) => buildTop({view_linger_secs: 5, view_max_secs: v}).viewMaxMs / MS,
      view_cooldown_secs: (v) => buildTop({view_cooldown_secs: v}).cooldownMs / MS,
      backfill_delay_secs: (v) => buildTop({backfill_delay_secs: v}).backfillDelayMs / MS,
      low_battery_threshold: (v) => buildTop({low_battery_threshold: v}).low_battery_threshold,
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
      low_battery_threshold: (v) => buildCam({low_battery_threshold: v}).timers.lowBatThreshold,
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

    // Enum and union parity with src/config.js and src/logger.js
    assert.deepEqual(schema.properties.log_level.enum, ['info', 'debug', 'warn', 'warning', 'error']);
    const hwBoolBranch = schema.properties.hwaccel.oneOf.find((entry) => entry.type === 'boolean');
    assert.ok(hwBoolBranch && hwBoolBranch.enum === undefined, 'hwaccel boolean branch must allow both true and false');
    assert.deepEqual(deref(schema.properties.card_theme).enum, Object.values(CARD_THEMES));
    assert.deepEqual(
      new Set(deref(schema.properties.card_position).enum),
      new Set(Object.values(CARD_POSITIONS))
    );
    assert.deepEqual(deref(schema.properties.sleep_screen).enum, Object.values(SLEEP_SCREENS));
    assert.deepEqual(
      new Set(schema.definitions.camera.properties.mode.enum),
      new Set(Object.values(CAMERA_MODES))
    );
    assert.deepEqual(schema.definitions.camera.properties.power_working_mode.enum, Object.values(POWER_WORKING_MODES));
    assert.equal(schema.definitions.camera.properties.station_serial.minLength, 1);
    assert.equal(new RegExp(schema.properties.ha_webhook_url.pattern).test(''), true);
    assert.equal(new RegExp(schema.properties.ha_webhook_url.pattern).test('http://homeassistant:8123/api/webhook/x'), true);

    // Every top-level schema key is accepted by validateConfig and illustrated in deploy/config.example.full.json
    for (const key of Object.keys(schema.properties)) {
      assert.ok(key in full, 'deploy/config.example.full.json missing top-level schema key: ' + key);
    }
    const frontDoorbell = full.cameras.find((c) => c.name === 'front_doorbell');
    assert.ok(frontDoorbell && frontDoorbell.frigate_event_secs === 30);
  });
});

describe('Quick Start Step 1 & Configuration Validation (validateConfig)', () => {
  it('validates the README Quick Start config.json, auto-derives go2rtc_url and rtsp_output_url from frigate_url, strips trailing /api, and auto-appends /{name} on base rtsp_output_url', () => {
    const quickStartConfig = {
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000/api/',
      hwaccel: 'vaapi',
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
        {
          serial: 'T8214T2222222222',
          title: 'Front Doorbell',
          mode: 'backfill',
          priority: 100,
        },
      ],
    };
    validateConfig(quickStartConfig);
    assert.equal(quickStartConfig.frigate_url, 'http://frigate:5000');
    assert.equal(quickStartConfig.go2rtc_url, 'http://frigate:1984');
    assert.equal(quickStartConfig.rtsp_output_url, 'rtsp://frigate:8554/{name}');
    assert.equal(quickStartConfig.cameras[0].name, 'T8161T0000000000');
    assert.equal(quickStartConfig.cameras[1].name, 'garage');
    assert.equal(quickStartConfig.cameras[2].name, 'T8214T2222222222');

    // Verify base rtsp_output_url without {name} auto-appends /{name}, and explicit go2rtc_url strips /api
    const customRtspConfig = {
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000',
      go2rtc_url: 'http://go2rtc-custom:1984/api',
      rtsp_output_url: 'rtsp://user:pass@go2rtc-custom:8554/',
      cameras: [{serial: 'T8161T0000000000'}],
    };
    validateConfig(customRtspConfig);
    assert.equal(customRtspConfig.go2rtc_url, 'http://go2rtc-custom:1984');
    assert.equal(customRtspConfig.rtsp_output_url, 'rtsp://user:pass@go2rtc-custom:8554/{name}');
  });

  it('rejects configurations missing required main settings, reports all missing/unknown keys at once, supports pure legacy upstream config, and rejects mixed legacy + new config', () => {
    assert.throws(
      () => validateConfig({frigate_url: 'http://frigate:5000', cameras: [{serial: 'T8161T0000000000'}]}),
      /"eufy_security_ws_url" is required/
    );
    assert.throws(
      () => validateConfig({eufy_security_ws_url: 'ws://e:3000', cameras: [{serial: 'T8161T0000000000'}]}),
      /"frigate_url" is required/
    );
    // Reports ALL missing required keys and unknown keys in one error message (no whack-a-mole)
    assert.throws(
      () => validateConfig({unknown_top: 123, cameras: [{serial: 'T8161T0000000000', unknown_cam: true}]}),
      (err) => {
        assert.match(err.message, /"eufy_security_ws_url" is required/);
        assert.match(err.message, /"frigate_url" is required/);
        assert.match(err.message, /unknown key "unknown_top"/);
        assert.match(err.message, /unknown camera key "cameras\[0\]\.unknown_cam"/);
        return true;
      }
    );
    assert.throws(
      () => validateConfig({eufy_security_ws_url: 'ws://e:3000', frigate_url: 'http://frigate:5000', cameras: []}),
      /"cameras" must list at least one/
    );
    assert.throws(
      () => validateConfig({eufy_security_ws_url: 'ws://e:3000', frigate_url: 'http://frigate:5000', cameras: [{}]}),
      /"cameras" must list at least one/
    );

    // Pure legacy upstream config (ljlongwing 6dba69e) is mapped to current schema with mode="auto"
    const legacyConfig = {
      eufy_ws: 'ws://eufy-security-ws:3000',
      go2rtc_api: 'http://frigate:1984/api/',
      rtsp_publish: 'rtsp://user:pass@frigate:8554/{name}',
      frigate_api: 'http://frigate:5000/api',
      ha_webhook: 'http://homeassistant:8123/api/webhook/eufy',
      hold_secs: 60,
      max_secs: 900,
      min_dwell_secs: 15,
      viewer_cooldown_secs: 45,
      event_secs: 30,
      snapshot_delay_secs: 3,
      audio: true,
      cameras: [
        {name: 'shed', title: 'Shed', serial: 'T8162T0000000000'},
        {name: 'backyard', title: 'Backyard', serial: 'T8162T1111111111'},
      ],
    };
    assert.doesNotThrow(() => validateConfig(legacyConfig));
    assert.equal(legacyConfig.eufy_security_ws_url, 'ws://eufy-security-ws:3000');
    assert.equal(legacyConfig.go2rtc_url, 'http://frigate:1984');
    assert.equal(legacyConfig.rtsp_output_url, 'rtsp://user:pass@frigate:8554/{name}');
    assert.equal(legacyConfig.frigate_url, 'http://frigate:5000');
    assert.equal(legacyConfig.ha_webhook_url, 'http://homeassistant:8123/api/webhook/eufy');
    assert.equal(legacyConfig.stream_max_secs, 900);
    assert.equal(legacyConfig.view_cooldown_secs, 45);
    assert.equal(legacyConfig.frigate_event_secs, 30);
    assert.equal(legacyConfig.snapshot_capture_delay_secs, 3);
    assert.equal('eufy_ws' in legacyConfig, false);
    assert.equal('min_dwell_secs' in legacyConfig, false);
    const builtLegacy = new BridgeConfigBuilder(legacyConfig).build();
    assert.equal(builtLegacy.cameras[0].timers.mode, 'auto');
    assert.equal(builtLegacy.cameras[0].cardConfig.theme, 'icons');

    // Pure legacy config without optional frigate_api (and with optional $schema) derives frigate_url from go2rtc_api host
    const minimalLegacy = {
      $schema: './config.schema.json',
      eufy_ws: 'ws://eufy-security-ws:3000',
      go2rtc_api: 'http://192.168.1.20:1984',
      rtsp_publish: 'rtsp://192.168.1.20:8554/{name}',
      cameras: [{name: 'shed', serial: 'T8162T0000000000'}],
    };
    validateConfig(minimalLegacy);
    assert.equal(minimalLegacy.frigate_url, 'http://192.168.1.20:5000');

    // Mixing legacy and current config keys is strictly rejected
    assert.throws(
      () =>
        validateConfig({
          eufy_ws: 'ws://eufy-security-ws:3000',
          frigate_url: 'http://frigate:5000',
          cameras: [{name: 'shed', serial: 'T8162T0000000000', mode: 'rtsp'}],
        }),
      /cannot mix legacy config keys \(eufy_ws\) with current config keys \(frigate_url, cameras\[0\]\.mode\)/
    );
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

  it('resolves "backfill" mode with 30s hold, end_early=true, useRtsp=true (so RTSP cameras keep RTSP Live View while backfilling events), and Power Manager 30s early-end sync', () => {
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
  });

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

  it('automatically syncs per-camera hold_secs and end_early across bridge timers, Frigate event duration, and Eufy Power Manager while allowing independent frigate_event_secs in "custom" mode', () => {
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
  });
});

describe('Defensive Non-Contradiction Validation ("custom" mode & frame rates)', () => {
  it('clamps idle_fps down to live_fps when idle_fps exceeds live_fps', () => {
    const rates = resolveFrameRates({live_fps: 12, idle_fps: 25});
    assert.equal(rates.liveFps, 12);
    assert.equal(rates.idleFps, 12);
  });

  it('allows useRtsp and alwaysBackfill to coexist so RTSP-capable cameras in backfill/custom mode can stream Live View over RTSP while backfilling motion clips', () => {
    const timers = resolveCameraTimers({
      serial: 'T8161CUSTOM0001',
      mode: 'custom',
      use_rtsp: true,
      backfill_only: true,
    });
    assert.equal(timers.mode, 'custom');
    assert.equal(timers.alwaysBackfill, true);
    assert.equal(timers.useRtsp, true);
  });

  it('clamps stream_max_secs >= hold_secs, view_max_secs >= view_linger_secs, and low_battery_hold_secs <= hold_secs', () => {
    const timers = resolveCameraTimers({
      serial: 'T8161CUSTOM0001',
      mode: 'custom',
      hold_secs: 60,
      stream_max_secs: 25,
      view_linger_secs: 45,
      view_max_secs: 20,
      low_battery_hold_secs: 90,
      recording_end_early: true,
    });
    assert.equal(timers.holdMs, 60000);
    assert.equal(timers.maxMs, 60000);
    assert.equal(timers.lingerMs, 45000);
    assert.equal(timers.viewMaxMs, 45000);
    assert.equal(timers.lowBatHoldMs, 60000);
    assert.equal(timers.letEufyDecideEnd, true);
  });

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

  it('promotes power_working_mode < 2 to 2 when custom clip settings are specified, and raises recording_clip_length >= hold_secs when end_early=false', () => {
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
  });

  it('promotes power_working_mode=0 to 2 when hold_secs > 20 or end_early=false, and preserves compatible presets (mode 1 or mode 0 with 20s + end_early=true)', () => {
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
    const compatibleMode0Hw = resolveHardwareRecordingConfig(
      compatibleMode0,
      resolveCameraTimers(compatibleMode0)
    );
    assert.equal(compatibleMode0Hw.powerWorkingMode, 0);
    assert.equal(compatibleMode0Hw.recordingClipLength, null);
    assert.equal(compatibleMode0Hw.recordingEndClipMotionStops, null);
    assert.equal(compatibleMode0Hw.recordingRetriggerInterval, null);

    const surveillanceMode1 = {
      serial: 'T8161CUSTOM0004',
      mode: 'custom',
      power_working_mode: 1,
    };
    const surveillanceHw = resolveHardwareRecordingConfig(
      surveillanceMode1,
      resolveCameraTimers(surveillanceMode1)
    );
    assert.equal(surveillanceHw.powerWorkingMode, 1);
    assert.equal(surveillanceHw.recordingClipLength, null);
    assert.equal(surveillanceHw.recordingEndClipMotionStops, null);
  });

  it('supports per-camera backfill_enabled, trigger_events, low_battery_threshold, and low_battery_wake_on_view while protecting backfill mode', () => {
    const standaloneP2p = resolveCameraTimers({
      serial: 'T8134STANDALONE1',
      mode: 'p2p',
      backfill_enabled: false,
      low_battery_threshold: 0,
      low_battery_wake_on_view: true,
    });
    assert.equal(standaloneP2p.backfillDownloads, false);
    assert.equal(standaloneP2p.lowBatThreshold, 0);
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
  });
});

describe('Status Card Theme, Position, Sleep Screen, Telemetry & Event Priority Rules', () => {
  it('defaults to "icons" theme at "bottom-left" position with "snapshot" sleep_screen', () => {
    const cardCfg = resolveCardConfig({});
    assert.equal(cardCfg.theme, 'icons');
    assert.equal(cardCfg.position, 'bottom-left');
    assert.equal(cardCfg.sleepScreen, 'snapshot');
  });

  it('supports all documented card_theme ("icons", "minimal", "detailed", "debug", "none"), card_position, and sleep_screen values', () => {
    assert.equal(normalizeCardTheme('icons'), 'icons');
    assert.equal(normalizeCardTheme('minimal'), 'minimal');
    assert.equal(normalizeCardTheme('detailed'), 'detailed');
    assert.equal(normalizeCardTheme('debug'), 'debug');
    assert.equal(normalizeCardTheme('none'), 'none');
    assert.equal(normalizeCardTheme(false), 'none');

    assert.equal(normalizeCardPosition('bottom-left'), 'bottom-left');
    assert.equal(normalizeCardPosition('top-left'), 'top-left');
    assert.equal(normalizeCardPosition('top-right'), 'top-right');
    assert.equal(normalizeCardPosition('bottom-right'), 'bottom-right');
    assert.equal(normalizeCardPosition('center'), 'center');

    assert.equal(normalizeSleepScreen('snapshot'), 'snapshot');
    assert.equal(normalizeSleepScreen('slate'), 'slate');
    assert.equal(normalizeSleepScreen('black'), 'black');
  });

  it('honors per-camera card_theme, card_position, and sleep_screen overrides', () => {
    const customCard = resolveCardConfig({
      serial: 'T8161T0000000000',
      card_theme: 'detailed',
      card_position: 'top-right',
      sleep_screen: 'slate',
    });
    assert.equal(customCard.theme, 'detailed');
    assert.equal(customCard.position, 'top-right');
    assert.equal(customCard.sleepScreen, 'slate');
  });

  it('expands all 13 documented trigger_events types and resolves built-in and custom event_priorities tiers', () => {
    // Regression: verify all 13 documented trigger_events expand cleanly and 'someone loitering' never substring-matches 'ring'.
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

  it('resolves telemetry boolean and granular item flags (battery, power_source, wifi, rssi, temperature, last_seen)', () => {
    const telOff = resolveTelemetryConfig({telemetry: false});
    assert.equal(telOff.enabled, false);
    assert.equal(telOff.battery, false);
    assert.equal(telOff.powerSource, false);
    assert.equal(telOff.wifi, false);
    assert.equal(telOff.rssi, false);
    assert.equal(telOff.temperature, false);
    assert.equal(telOff.lastSeen, false);

    const telPartial = resolveTelemetryConfig({
      telemetry: {
        power_source: false,
        rssi: false,
        temperature: false,
        last_seen: false,
      },
    });
    assert.equal(telPartial.enabled, true);
    assert.equal(telPartial.battery, true);
    assert.equal(telPartial.powerSource, false);
    assert.equal(telPartial.wifi, true);
    assert.equal(telPartial.rssi, false);
    assert.equal(telPartial.temperature, false);
    assert.equal(telPartial.lastSeen, false);
  });

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

  it('builds a single deeply frozen immutable configuration instance via BridgeConfigBuilder and reuses pre-built camera sub-configs across domain models', () => {
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

    const builtCfg = new BridgeConfigBuilder({
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000/api/',
      live_fps: 15,
      idle_fps: 5,
      cameras: [
        {serial: 'T8161T0000000000', name: 'driveway', mode: 'rtsp', hold_secs: 45},
      ],
    })
      .withEndpoints()
      .withVideoAndAudio()
      .withTimersAndArbitration()
      .withEventsAndOverlays()
      .withCameras()
      .build();

    assert.equal(Object.isFrozen(builtCfg), true);
    assert.equal(builtCfg.frigate_url, 'http://frigate:5000');
    assert.equal(builtCfg.go2rtc_url, 'http://frigate:1984');
    assert.equal(builtCfg.rtsp_output_url, 'rtsp://frigate:8554/{name}');
    assert.equal(Object.isFrozen(builtCfg.cameras), true);
    const camSlice = builtCfg.cameras[0];
    assert.equal(Object.isFrozen(camSlice), true);
    assert.equal(camSlice.timers.holdMs, 45000);

    // Constructing a Camera from the pre-built immutable camera config reuses exact frozen sub-objects without re-building
    const cam = new Camera(camSlice);
    assert.equal(cam.timers, camSlice.timers);
    assert.equal(cam.triggers, camSlice.triggers);
    assert.equal(cam.telemetry.config, camSlice.telemetryConfig);
    assert.equal(cam.telemetry.hwRecordingCfg, camSlice.hwRecordingConfig);

    // CameraConfig and Camera share unified identity domain methods (no duplicated cam && !cam.name && cam.serial checks)
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
  });

  it('exports deeply frozen, semantically separated cross-layer constant groups for signals, themes, positions, sleep screens, titles, modes, and hwaccel', () => {
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
      ICONS: 'icons',
      MINIMAL: 'minimal',
      DETAILED: 'detailed',
      DEBUG: 'debug',
      NONE: 'none',
    });

    assert.equal(Object.isFrozen(CARD_POSITIONS), true);
    assert.deepEqual(CARD_POSITIONS, {
      CENTER: 'center',
      TOP_LEFT: 'top-left',
      TOP_RIGHT: 'top-right',
      BOTTOM_LEFT: 'bottom-left',
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

    assert.equal(normalizeCardTheme(CARD_THEMES.ICONS), CARD_THEMES.ICONS);
    assert.equal(normalizeCardTheme(CARD_THEMES.DEBUG), CARD_THEMES.DEBUG);
    assert.equal(normalizeCardTheme('test'), CARD_THEMES.ICONS);
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
    assert.equal(fallbackBuild.version, '0.0.1');
    assert.equal(fallbackBuild.commit, 'dev');
    const trimmedBuild = resolveBuildInfo({BRIDGE_VERSION: '  v1.5.0  ', BRIDGE_COMMIT: '  abc1234  '});
    assert.deepEqual(trimmedBuild, {version: 'v1.5.0', commit: 'abc1234'});
  });

  it('defaults experimental track_stuck_spotlight to false and resolves global and per-camera overrides', () => {
    // Verify track_stuck_spotlight defaults to false and supports independent global and per-camera boolean overrides
    const defaultBuilt = new BridgeConfigBuilder({
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000',
      cameras: [{serial: 'T8161T0000000001'}],
    }).build();
    assert.equal(defaultBuilt.track_stuck_spotlight, false);
    assert.equal(defaultBuilt.cameras[0].trackStuckSpotlight, false);

    const globalEnabledBuilt = new BridgeConfigBuilder({
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000',
      track_stuck_spotlight: true,
      cameras: [
        {serial: 'T8161T0000000001'},
        {serial: 'T8161T0000000002', track_stuck_spotlight: false},
      ],
    }).build();
    assert.equal(globalEnabledBuilt.track_stuck_spotlight, true);
    assert.equal(globalEnabledBuilt.cameras[0].trackStuckSpotlight, true);
    assert.equal(globalEnabledBuilt.cameras[1].trackStuckSpotlight, false);

    const camOverrideBuilt = new BridgeConfigBuilder({
      eufy_security_ws_url: 'ws://eufy-security-ws:3000',
      frigate_url: 'http://frigate:5000',
      sync_power: false,
      cameras: [{serial: 'T8161T0000000003', track_stuck_spotlight: true}],
    }).build();
    assert.equal(camOverrideBuilt.track_stuck_spotlight, false);
    assert.equal(camOverrideBuilt.cameras[0].trackStuckSpotlight, true);
  });
});
