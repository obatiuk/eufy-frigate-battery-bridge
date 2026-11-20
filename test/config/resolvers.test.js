/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for camera mode, timer, status card, telemetry, and Power Manager configuration resolvers
 * (src/config/resolvers.js).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jsYaml = require('js-yaml');

const {REPO_ROOT} = require('../helpers/test-env');
const {
  resolveCameraMode,
  resolveCameraTimers,
  resolveHardwareRecordingConfig,
  CAMERA_MODES,
  resolveTelemetryConfig,
  validateConfig,
  BridgeConfigBuilder,
  stripRtspUrlFragment,
  resolveCameraConfig,
  resolveFrameRates,
  resolveCameraTriggers,
  TRIGGERS,
  resolveCardConfig,
  normalizeCardTheme,
  normalizeCardPosition,
  normalizeSleepScreen,
  cfg,
  CameraConfig,
  PROCESS_SIGNALS,
  CARD_THEMES,
  CARD_POSITIONS,
  SLEEP_SCREENS,
  CARD_STATUS_TITLES,
  STREAM_MODES,
  HWACCEL_MODES,
  FRAME_STAGE_MARKERS,
  POWER_WORKING_MODES,
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  resolveBuildInfo,
} = require('../../src/config');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');

describe('Camera Mode Presets & Unified hold_secs / end_early Auto-Sync', () => {
  it('resolves "auto" mode when mode is omitted (60s hold, end_early=false, RTSP enabled when supported)', () => {
    // Verify: resolves "auto" mode when mode is omitted (60s hold, end_early=false, RTSP enabled when supported).
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
    // Verify: resolves "rtsp" mode with 60s hold, end_early=false, and Power Manager 60s full-clip sync.
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
      // Verify: resolves "backfill" mode with 30s hold, end_early=true, useRtsp=true (so RTSP cameras keep RTSP Live
      // View while backfilling events), and Power Manager 30s early-end sync.
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
    // Verify: resolves "p2p" mode with 60s hold, end_early=false, useRtsp=false, and alwaysBackfill=false.
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
      // Verify: automatically syncs per-camera hold_secs and end_early across bridge timers, Frigate event duration,
      // and Eufy Power Manager while allowing independent frigate_event_secs in "custom" mode.
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
      assert.equal(directOnlyCfg.cameras[0].serial, undefined);
      assert.equal(directOnlyCfg.cameras[0].name, 'baby_crib');
      const builtDirect = new BridgeConfigBuilder(directOnlyCfg).build();
      assert.equal(builtDirect.eufy_security_ws_url, '');
      assert.equal(builtDirect.cameras[0].serial, 'baby_crib');
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
    // Verify: clamps idle_fps down to live_fps when idle_fps exceeds live_fps.
    const rates = resolveFrameRates({live_fps: 12, idle_fps: 25});
    assert.equal(rates.liveFps, 12);
    assert.equal(rates.idleFps, 12);
  });

  it(
    'allows useRtsp and alwaysBackfill to coexist so RTSP-capable cameras in backfill/custom mode can ' +
      'stream Live View over RTSP while backfilling motion clips',
    () => {
      // Verify: allows useRtsp and alwaysBackfill to coexist so RTSP-capable cameras in backfill/custom mode can
      // stream Live View over RTSP while backfilling motion clips.
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
    // Verify: disables hardware Power Manager sync when sync_power=false.
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
      // Verify: promotes power_working_mode < 2 to 2 when custom clip settings are specified, and raises
      // recording_clip_length >= hold_secs when end_early=false.
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
      // Verify: promotes power_working_mode=0 to 2 when hold_secs > 20 or end_early=false, and preserves compatible
      // presets (mode 1 or mode 0 with 20s + end_early=true).
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
      // Verify: supports per-camera backfill_enabled, trigger_events, low_battery_threshold,
      // critical_battery_threshold, and low_battery_wake_on_view while protecting backfill mode.
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
    // Verify: defaults to "minimal" theme at "bottom-left" position with "snapshot" sleep_screen.
    const cardCfg = resolveCardConfig({});
    assert.equal(cardCfg.theme, 'minimal');
    assert.equal(cardCfg.position, 'bottom-left');
    assert.equal(cardCfg.sleepScreen, 'snapshot');
  });

  it(
    'supports all documented card_theme ("glance", "minimal", "pebbles", "hud", "none"), card_position, ' +
      'and sleep_screen values',
    () => {
      // Verify: supports all documented card_theme ("glance", "minimal", "pebbles", "hud", "none"), card_position,
      // and sleep_screen values.
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
    // Verify: honors per-camera card_theme, card_position, and sleep_screen overrides.
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

  it(
    'resolves telemetry boolean and granular item flags (battery, power_source, wifi, rssi default true; ' +
      'temperature, last_seen default false)',
    () => {
      // Verify: resolves telemetry boolean and granular item flags (battery, power_source, wifi, rssi default true;
      // temperature, last_seen default false).
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
    // Verify: returns deeply frozen immutable configuration value objects across all resolvers.
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
      // Verify: builds a single deeply frozen immutable configuration instance via BridgeConfigBuilder and reuses
      // pre-built camera sub-configs across domain models.
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
      assert.equal(cam.getTimersConfig(), camSlice.timers);
      assert.equal(cam.getTriggersSet(), camSlice.triggers);
      assert.equal(cam.getTelemetryConfig(), camSlice.telemetryConfig);
      assert.equal(cam.getHardwareRecordingConfig(), camSlice.hwRecordingConfig);

      // CameraConfig and Camera share unified identity domain methods
      // (no duplicated cam && !cam.name && cam.serial checks)
      assert.equal(typeof CameraConfig, 'function');
      assert.equal(camSlice instanceof CameraConfig, true);
      const snapAt = new Date(2026, 10, 19, 18, 16, 4);
      assert.equal(camSlice.getName(), 'driveway');
      assert.equal(camSlice.getSerial(), 'T8161T0000000000');
      assert.equal(camSlice.getScopeName(), 'driveway');
      assert.equal(camSlice.getCacheFileName(snapAt), 'driveway_T8161T0000000000_snapshot_2026-11-19_18-16-04.jpg');
      assert.equal(camSlice.hasValidIdentity(), true);

      assert.equal(cam.getName(), 'driveway');
      assert.equal(cam.getSerial(), 'T8161T0000000000');
      assert.equal(cam.getScopeName(), 'driveway');
      assert.equal(cam.getCacheFileName(snapAt), 'driveway_T8161T0000000000_snapshot_2026-11-19_18-16-04.jpg');
      assert.equal(cam.hasValidIdentity(), true);
      assert.equal(cam.hasPendingViewerWake(), false);

      const unnamedRaw = {serial: '  T8214T2222222222  '};
      assert.equal(CameraConfig.hasValidIdentity(unnamedRaw), true);
      assert.equal(unnamedRaw.name, undefined);
      assert.equal(CameraConfig.resolveScopeName(unnamedRaw), 'T8214T2222222222');
      assert.equal(CameraConfig.resolveScopeName({}), 'bridge');
      assert.equal(
        CameraConfig.resolveCacheFileName(camSlice, snapAt),
        'driveway_T8161T0000000000_snapshot_2026-11-19_18-16-04.jpg'
      );
      assert.equal(
        CameraConfig.resolveCacheFileName(cam, snapAt),
        'driveway_T8161T0000000000_snapshot_2026-11-19_18-16-04.jpg'
      );
      assert.equal(
        CameraConfig.resolveCacheFileName(unnamedRaw, snapAt),
        'T8214T2222222222_snapshot_2026-11-19_18-16-04.jpg'
      );
      const directUnnamedSerialCfg = new BridgeConfigBuilder({
        cameras: [{name: 'nursery_cam', mode: 'rtsp', rtsp_url: 'rtsp://192.0.2.10/live0'}],
      }).build();
      assert.equal(
        directUnnamedSerialCfg.cameras[0].getCacheFileName(snapAt),
        'nursery_cam_snapshot_2026-11-19_18-16-04.jpg'
      );
      assert.equal(
        CameraConfig.resolveCacheFileName(directUnnamedSerialCfg.cameras[0], snapAt),
        'nursery_cam_snapshot_2026-11-19_18-16-04.jpg'
      );
      assert.equal(CameraConfig.hasValidIdentity({}), false);
      assert.equal(CameraConfig.hasValidIdentity(null), false);
    }
  );

  it(
    'exports deeply frozen, semantically separated cross-layer constant groups for signals, themes, ' +
      'positions, sleep screens, titles, modes, and hwaccel',
    () => {
      // Verify: exports deeply frozen, semantically separated cross-layer constant groups for signals, themes,
      // positions, sleep screens, titles, modes, and hwaccel.
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
      // Verify: logs startup warnings when explicitly specified top-level or per-camera configuration options are
      // ignored.
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
