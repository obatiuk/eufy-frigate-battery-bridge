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
} = require('../src/config');

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

  it('validates examples/config.example.minimal.json, examples/config.example.full.json, and package.json when present', () => {
    const minPath = path.join(REPO_ROOT, 'examples/config.example.minimal.json');
    const fullPath = path.join(REPO_ROOT, 'examples/config.example.full.json');
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    if (fs.existsSync(minPath)) {
      const minimal = JSON.parse(fs.readFileSync(minPath, 'utf8'));
      assert.doesNotThrow(() => validateConfig(minimal));
    }
    if (fs.existsSync(fullPath)) {
      const full = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      assert.doesNotThrow(() => validateConfig(full));
    }
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      assert.equal(pkg.name, 'eufy-frigate-battery-bridge');
      assert.equal(pkg.private, true);
      assert.ok(pkg.dependencies && pkg.dependencies.ws);
    }
    const WS = require('ws');
    assert.equal(typeof WS, 'function');
    const {isTrackedPropertyEvent, extractRecognizedPerson} = require('../src/services/eufy-client');
    assert.equal(isTrackedPropertyEvent('battery'), true);
    assert.equal(isTrackedPropertyEvent('rtspStreamUrl'), true);
    assert.equal(isTrackedPropertyEvent('unknownProp'), false);
    assert.equal(extractRecognizedPerson({event: 'identity person detected', person: 'Alice'}), 'Alice');
    assert.equal(extractRecognizedPerson({event: 'person detected', person: 'Stranger'}), '');
  });
});

describe('Configuration Validation & Serial-to-Name Fallback', () => {
  it('defaults camera.name to camera.serial when name is omitted', () => {
    const sample = {
      eufy_ws: 'ws://eufy-security-ws:3000',
      go2rtc_api: 'http://frigate:1984',
      rtsp_publish: 'rtsp://frigate:8554/{name}',
      cameras: [{serial: 'T8161T0000000000', title: 'Storage Room Camera'}],
    };
    validateConfig(sample);
    assert.equal(sample.cameras[0].name, 'T8161T0000000000');
  });
});

describe('Camera Mode Presets (resolveCameraMode & resolveCameraTimers)', () => {
  it('resolves "auto" when mode is omitted', () => {
    const mode = resolveCameraMode({serial: 'T8161T0000000000'});
    const timers = resolveCameraTimers({serial: 'T8161T0000000000'});
    assert.equal(mode, 'auto');
    assert.equal(timers.mode, 'auto');
    assert.equal(timers.useRtsp, true);
    assert.equal(timers.alwaysBackfill, false);
    assert.equal(timers.holdMs, 60000);
    assert.equal(timers.eventSecs, 60);
    assert.equal(timers.letEufyDecideEnd, false);
  });

  it('resolves "rtsp" mode with 60s hold and end_early=false', () => {
    const timers = resolveCameraTimers({serial: 'T8161T0000000000', mode: 'rtsp'});
    assert.equal(timers.mode, 'rtsp');
    assert.equal(timers.useRtsp, true);
    assert.equal(timers.alwaysBackfill, false);
    assert.equal(timers.holdMs, 60000);
    assert.equal(timers.eventSecs, 60);
    assert.equal(timers.letEufyDecideEnd, false);
  });

  it('resolves "backfill" mode with 30s hold, end_early=true, and useRtsp=false', () => {
    const timers = resolveCameraTimers({serial: 'T8214T2222222222', mode: 'backfill'});
    assert.equal(timers.mode, 'backfill');
    assert.equal(timers.useRtsp, false);
    assert.equal(timers.alwaysBackfill, true);
    assert.equal(timers.holdMs, 30000);
    assert.equal(timers.eventSecs, 30);
    assert.equal(timers.letEufyDecideEnd, true);
  });

  it('resolves "p2p" mode with useRtsp=false and alwaysBackfill=false', () => {
    const timers = resolveCameraTimers({serial: 'T8140T0000000000', mode: 'p2p'});
    assert.equal(timers.mode, 'p2p');
    assert.equal(timers.useRtsp, false);
    assert.equal(timers.alwaysBackfill, false);
    assert.equal(timers.holdMs, 60000);
    assert.equal(timers.letEufyDecideEnd, false);
  });
});

describe('Defensive Non-Contradiction Validation ("custom" mode & frame rates)', () => {
  it('clamps idle_fps down to live_fps when idle_fps exceeds live_fps', () => {
    const rates = resolveFrameRates({live_fps: 12, idle_fps: 25});
    assert.equal(rates.liveFps, 12);
    assert.equal(rates.idleFps, 12);
  });

  it('disables useRtsp when both use_rtsp and always_backfill are requested in custom mode', () => {
    const timers = resolveCameraTimers({
      serial: 'T8161CUSTOM0001',
      mode: 'custom',
      use_rtsp: true,
      always_backfill: true,
    });
    assert.equal(timers.mode, 'custom');
    assert.equal(timers.alwaysBackfill, true);
    assert.equal(timers.useRtsp, false);
  });

  it('clamps max_secs >= hold_secs, view_max_secs >= view_linger_secs, and low_battery_hold_secs <= hold_secs', () => {
    const timers = resolveCameraTimers({
      serial: 'T8161CUSTOM0001',
      mode: 'custom',
      hold_secs: 60,
      max_secs: 25,
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

  it('supports per-camera backfill_downloads, trigger_events, low_battery_threshold, and low_battery_wake_on_view while protecting backfill mode', () => {
    const standaloneP2p = resolveCameraTimers({
      serial: 'T8134STANDALONE1',
      mode: 'p2p',
      backfill_downloads: false,
      low_battery_threshold: 0,
      low_battery_wake_on_view: true,
    });
    assert.equal(standaloneP2p.backfillDownloads, false);
    assert.equal(standaloneP2p.lowBatThreshold, 0);
    assert.equal(standaloneP2p.lowBatWakeOnView, true);

    const protectedBackfill = resolveCameraTimers({
      serial: 'T8214T2222222222',
      mode: 'backfill',
      backfill_downloads: false,
    });
    assert.equal(
      protectedBackfill.backfillDownloads,
      true,
      'backfill mode must keep backfillDownloads=true even if backfill_downloads=false is passed'
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

describe('Status Card Theme, Position & Sleep Screen Normalization', () => {
  it('defaults to "icons" theme at "bottom-left" position with "snapshot" sleep_screen', () => {
    const cardCfg = resolveCardConfig({});
    assert.equal(cardCfg.theme, 'icons');
    assert.equal(cardCfg.position, 'bottom-left');
    assert.equal(cardCfg.sleepScreen, 'snapshot');
  });

  it('supports canonical "detailed", "minimal", "icons", and "none" themes and rejects removed "default" theme', () => {
    assert.equal(normalizeCardTheme('detailed'), 'detailed');
    assert.equal(normalizeCardTheme('minimal'), 'minimal');
    assert.equal(normalizeCardTheme('icons'), 'icons');
    assert.equal(normalizeCardTheme('none'), 'none');
    assert.equal(normalizeCardTheme('default'), 'icons');
    assert.equal(normalizeCardPosition('bottom-right'), 'bottom-right');
  });

  it('supports canonical "snapshot", "slate", and "black" sleep_screen values', () => {
    assert.equal(normalizeSleepScreen('snapshot'), 'snapshot');
    assert.equal(normalizeSleepScreen('slate'), 'slate');
    assert.equal(normalizeSleepScreen('black'), 'black');
    assert.equal(normalizeSleepScreen(false), 'black');
    assert.equal(normalizeSleepScreen('unknown'), 'snapshot');
  });

  it('ignores removed legacy aliases (card_background, card_corner, let_eufy_decide_event_end, clip_length, power_mode)', () => {
    const cardCfg = resolveCardConfig({
      serial: 'T8161T0000000000',
      card_theme: 'black',
      card_corner: 'bottom-right',
      card_background: 'black',
    });
    assert.equal(cardCfg.theme, 'icons');
    assert.equal(cardCfg.position, 'bottom-left');
    assert.equal(cardCfg.sleepScreen, 'snapshot');

    const timers = resolveCameraTimers({
      serial: 'T8161T0000000000',
      mode: 'live',
      let_eufy_decide_event_end: true,
    });
    assert.equal(timers.mode, 'auto');
    assert.equal(timers.letEufyDecideEnd, false);

    const hw = resolveHardwareRecordingConfig(
      {
        serial: 'T8161T0000000000',
        mode: 'custom',
        power_mode: 0,
        clip_length: 25,
      },
      timers
    );
    assert.equal(hw.powerWorkingMode, 2);
    assert.equal(hw.recordingClipLength, 60);
  });

  it('resolves telemetry flags and event priorities', () => {
    const telOff = resolveTelemetryConfig({telemetry: false});
    assert.equal(telOff.enabled, false);
    assert.equal(telOff.battery, false);

    const telPartial = resolveTelemetryConfig({telemetry: {temperature: false, last_seen: false}});
    assert.equal(telPartial.enabled, true);
    assert.equal(telPartial.battery, true);
    assert.equal(telPartial.temperature, false);
    assert.equal(telPartial.lastSeen, false);

    assert.ok(getEventPriority('rings') > getEventPriority('identity person detected'));
    assert.ok(getEventPriority('identity person detected') > getEventPriority('person detected'));
    assert.ok(getEventPriority('person detected') > getEventPriority('motion detected'));
    assert.equal(TRIGGERS.has('motion detected'), true);
    assert.equal(TRIGGERS.has('rings'), true);
  });
});
