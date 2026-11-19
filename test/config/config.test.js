/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for source/tmp integrity, deploy/config.schema.json & example YAML parity,
 * single-pass validateConfig(), and hybrid service endpoint derivation.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jsYaml = require('js-yaml');
const {REPO_ROOT, TEST_TMP_DIR} = require('../helpers/test-env');

const {
  CACHE_DIR,
  BACKFILL_DELAY_MS,
  CARD_THEMES,
  CARD_POSITIONS,
  SLEEP_SCREENS,
  CAMERA_MODES,
  POWER_WORKING_MODES,
  BridgeConfigBuilder,
  validateConfig,
  resolveConfigFilePath,
  resolveServiceEndpoints,
} = require('../../src/config');

describe('Source & Example File Integrity', () => {
  it('compiles all JavaScript modules in src/ without syntax errors', () => {
    // Verify: compiles all JavaScript modules in src/ without syntax errors.
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
    const collectTestFiles = (dir) =>
      fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return collectTestFiles(full);
        return entry.name.endsWith('.test.js') ? [full] : [];
      });
    for (const fullPath of collectTestFiles(testDir)) {
      const relName = path.relative(REPO_ROOT, fullPath).split(path.sep).join('/');
      const src = fs.readFileSync(fullPath, 'utf8');
      assert.equal(
        outsideTmpLiteralRe.test(src),
        false,
        relName + ' must not use external ' + outsideTmpPrefix + ' paths'
      );
      assert.equal(osTmpCallRe.test(src), false, relName + ' must not call OS tmpdir helper; use project-local .tmp/');
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
      const {isTrackedPropertyEvent, extractRecognizedPerson} = require('../../src/services/eufy-client');
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
