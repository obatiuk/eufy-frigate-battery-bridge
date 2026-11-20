// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Fluent BridgeConfigBuilder constructing a deeply frozen immutable bridge configuration instance.
 */
'use strict';

const {
  MS_PER_SECOND,
  MIN_VIDEO_WIDTH,
  MAX_VIDEO_WIDTH,
  DEFAULT_VIDEO_WIDTH,
  MIN_VIDEO_HEIGHT,
  MAX_VIDEO_HEIGHT,
  DEFAULT_VIDEO_HEIGHT,
  DEFAULT_BACKFILL_DELAY_SECS,
  DEFAULT_TRACK_STUCK_SPOTLIGHT,
  DEFAULT_VIEW_COOLDOWN_SECS,
  DEFAULT_SNAP_CAPTURE_DELAY_SECS,
  MIN_HOLD_SECS,
  MAX_HOLD_SECS,
  MIN_SESSION_MAX_SECS,
  MAX_SESSION_MAX_SECS,
  DEFAULT_MAX_SECS,
  DEFAULT_VIEW_MAX_SECS,
  DEFAULT_LINGER_SECS,
  MAX_EVENT_SECS,
  MIN_EARLY_SLEEP_SECS,
  MAX_EARLY_SLEEP_SECS,
  DEFAULT_EARLY_SLEEP_SECS,
  MIN_LOW_BAT_HOLD_SECS,
  MAX_LOW_BAT_HOLD_SECS,
  DEFAULT_LOW_BAT_HOLD_SECS,
  MAX_RECORDING_CLIP_SECS,
  MAX_RETRIGGER_INTERVAL_SECS,
  POWER_MODES,
  STREAMING_QUALITIES,
  clampNum,
} = require('./constants');
const {hasDirectRtspUrl} = require('./camera-config');
const {resolveServiceEndpoints, resolveRuntimeEnv, resolveCacheDir, resolveHwaccel} = require('./env');
const {validateConfig} = require('./validation');
const {
  buildTriggerSet,
  resolveBatteryThresholds,
  resolveFrameRates,
  warnIgnoredTopLevelOptions,
  resolveCameraConfig,
} = require('./resolvers');

/**
 * Fluent builder that constructs a deeply frozen immutable bridge configuration instance once
 * so all domain, media, overlay, and service modules reuse the same immutable configuration.
 */
class BridgeConfigBuilder {
  /**
   * @param {Record<string, *>} rawCfg - Raw parsed YAML configuration object.
   * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
   */
  constructor(rawCfg, env = process.env) {
    const cloned = {
      ...rawCfg,
      cameras: Array.isArray(rawCfg.cameras)
        ? rawCfg.cameras.map((c) => (c && typeof c === 'object' ? {...c} : c))
        : [],
    };
    validateConfig(cloned);
    /** @type {Record<string, *>} */
    this._raw = cloned;
    /** @type {Record<string, string|undefined>} */
    this._env = env;
    /** @type {Record<string, *>} */
    this._built = {...cloned};
    this._hasEndpoints = false;
    this._hasVideoAndAudio = false;
    this._hasTimers = false;
    this._hasEventsAndOverlays = false;
    this._hasCameras = false;
  }

  /**
   * Resolves and normalizes external service endpoints and HTTP server settings from env.
   *
   * @returns {this}
   */
  withEndpoints() {
    const endpoints = resolveServiceEndpoints(this._env);
    const runtimeEnv = resolveRuntimeEnv(this._env);
    const allDirect =
      Array.isArray(this._raw.cameras) &&
      this._raw.cameras.length > 0 &&
      this._raw.cameras.every((cam) => hasDirectRtspUrl(cam));

    this._built.eufy_security_ws_url = allDirect ? '' : endpoints.eufy_security_ws_url;
    this._built.frigate_url = endpoints.frigate_url;
    this._built.go2rtc_url = endpoints.go2rtc_url;
    this._built.rtsp_publish_url = endpoints.rtsp_publish_url;
    this._built.ha_webhook_url = endpoints.ha_webhook_url;
    this._built.http_port = runtimeEnv.httpPort;
    this._hasEndpoints = true;
    return this;
  }

  /**
   * Resolves video dimensions, frame rates, audio parameters, and hardware acceleration from env.
   *
   * @returns {this}
   */
  withVideoAndAudio() {
    const width = clampNum(this._raw.width, MIN_VIDEO_WIDTH, MAX_VIDEO_WIDTH, DEFAULT_VIDEO_WIDTH) & ~1;
    const height = clampNum(this._raw.height, MIN_VIDEO_HEIGHT, MAX_VIDEO_HEIGHT, DEFAULT_VIDEO_HEIGHT) & ~1;
    const {liveFps, idleFps} = resolveFrameRates(this._raw);
    const runtimeEnv = resolveRuntimeEnv(this._env);
    const activeHwaccel = resolveHwaccel(runtimeEnv.hwaccelMode, runtimeEnv.hwaccelDevice);

    this._built.width = width;
    this._built.height = height;
    this._built.live_fps = liveFps;
    this._built.idle_fps = idleFps;
    this._built.audio = this._raw.audio !== false;
    this._built.preserve_aspect_ratio = this._raw.preserve_aspect_ratio !== false;
    this._built.hwaccel_device = runtimeEnv.hwaccelDevice;
    this._built.activeHwaccel = activeHwaccel;
    this._hasVideoAndAudio = true;
    return this;
  }

  /**
   * Resolves global stream timing, arbitration, backfill, and battery economy settings.
   *
   * @returns {this}
   */
  withTimersAndArbitration() {
    const maxMs =
      clampNum(this._raw.stream_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_MAX_SECS) * MS_PER_SECOND;
    const viewMaxMs =
      clampNum(this._raw.view_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_VIEW_MAX_SECS) *
      MS_PER_SECOND;
    const lingerMs = Math.min(
      viewMaxMs,
      clampNum(this._raw.view_linger_secs, MIN_HOLD_SECS, MAX_HOLD_SECS, DEFAULT_LINGER_SECS) * MS_PER_SECOND
    );
    const cooldownMs =
      clampNum(this._raw.view_cooldown_secs, 0, MAX_EVENT_SECS, DEFAULT_VIEW_COOLDOWN_SECS) * MS_PER_SECOND;
    const snapDelayMs =
      clampNum(this._raw.snapshot_capture_delay_secs, 0, MAX_RETRIGGER_INTERVAL_SECS, DEFAULT_SNAP_CAPTURE_DELAY_SECS) *
      MS_PER_SECOND;

    this._built.maxMs = maxMs;
    this._built.viewMaxMs = viewMaxMs;
    this._built.lingerMs = lingerMs;
    this._built.cooldownMs = cooldownMs;
    this._built.snapDelayMs = snapDelayMs;
    this._built.view_has_priority = this._raw.view_has_priority !== false;
    this._built.use_rtsp = this._raw.use_rtsp !== false;
    this._built.backfill_enabled = this._raw.backfill_enabled !== false;
    this._built.backfillDelayMs =
      clampNum(this._raw.backfill_delay_secs, 2, MAX_RECORDING_CLIP_SECS, DEFAULT_BACKFILL_DELAY_SECS) * MS_PER_SECOND;
    this._built.instant_event_snapshot = this._raw.instant_event_snapshot !== false;
    this._built.earlySleepMs =
      clampNum(this._raw.idle_timeout_secs, MIN_EARLY_SLEEP_SECS, MAX_EARLY_SLEEP_SECS, DEFAULT_EARLY_SLEEP_SECS) *
      MS_PER_SECOND;
    const {lowBatThreshold, criticalBatThreshold} = resolveBatteryThresholds(this._raw);
    this._built.low_battery_threshold = lowBatThreshold;
    this._built.critical_battery_threshold = criticalBatThreshold;
    this._built.lowBatHoldMs =
      clampNum(
        this._raw.low_battery_hold_secs,
        MIN_LOW_BAT_HOLD_SECS,
        MAX_LOW_BAT_HOLD_SECS,
        DEFAULT_LOW_BAT_HOLD_SECS
      ) * MS_PER_SECOND;
    this._built.low_battery_wake_on_view = Boolean(this._raw.low_battery_wake_on_view ?? false);
    this._built.track_stuck_spotlight = Boolean(this._raw.track_stuck_spotlight ?? DEFAULT_TRACK_STUCK_SPOTLIGHT);
    this._built.power_mode = this._raw.power_mode ?? POWER_MODES.KEEP;
    this._built.streaming_quality = this._raw.streaming_quality ?? STREAMING_QUALITIES.KEEP;
    this._built.telemetryPollMs =
      clampNum(this._raw.telemetry_poll_secs, 0, MAX_HOLD_SECS, DEFAULT_VIEW_MAX_SECS) * MS_PER_SECOND;
    this._built.startup_snapshot = this._raw.startup_snapshot !== undefined ? this._raw.startup_snapshot : true;
    this._hasTimers = true;
    return this;
  }

  /**
   * Resolves trigger event sets, event priorities, overlay defaults, and cache directory.
   *
   * @returns {this}
   */
  withEventsAndOverlays() {
    const runtimeEnv = resolveRuntimeEnv(this._env);
    this._built.ring_label = this._raw.ring_label || 'person';
    this._built.forward_face_names = this._raw.forward_face_names !== false;
    this._built.auto_frigate_mask = this._raw.auto_frigate_mask !== false;
    this._built.card_show_on_live = this._raw.card_show_on_live !== false;
    this._built.triggers = buildTriggerSet(this._raw.trigger_events);
    this._built.event_priorities =
      this._raw.event_priorities && typeof this._raw.event_priorities === 'object'
        ? Object.freeze({...this._raw.event_priorities})
        : null;
    this._built.cache_dir = resolveCacheDir(runtimeEnv.cacheDir);
    this._hasEventsAndOverlays = true;
    return this;
  }

  /**
   * Builds and freezes each configured camera's normalized configuration slice once.
   *
   * @returns {this}
   */
  withCameras() {
    if (!this._hasTimers) {
      this.withTimersAndArbitration();
    }
    if (!this._hasEventsAndOverlays) {
      this.withEventsAndOverlays();
    }
    this._built.cameras = Object.freeze(this._raw.cameras.map((cam) => resolveCameraConfig(cam, this._built)));
    this._hasCameras = true;
    return this;
  }

  /**
   * Finalizes all builder stages and returns a deeply frozen immutable configuration instance.
   *
   * @returns {Readonly<Record<string, *>>}
   */
  build() {
    if (!this._hasEndpoints) this.withEndpoints();
    if (!this._hasVideoAndAudio) this.withVideoAndAudio();
    if (!this._hasTimers) this.withTimersAndArbitration();
    if (!this._hasEventsAndOverlays) this.withEventsAndOverlays();
    if (!this._hasCameras) this.withCameras();
    const runtimeEnv = resolveRuntimeEnv(this._env);
    warnIgnoredTopLevelOptions(this._raw, runtimeEnv.hwaccelMode, this._env);
    return Object.freeze({...this._built});
  }
}

module.exports = {
  BridgeConfigBuilder,
};
