// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Configuration entry point: constructs the frozen startup `cfg` singleton once
 * and re-exports constants, CameraConfig, BridgeConfigBuilder, validation, and resolvers.
 */
'use strict';

const {log, formatErrorMessage, initLogger} = require('../logger');
const {
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
  POWER_MODES,
  STREAMING_QUALITIES,
  OPTIMAL_BATTERY_MAX_CLIP_SECS,
  SURVEILLANCE_HOLD_SECS,
  MIN_RECORDING_CLIP_SECS,
  MAX_RECORDING_CLIP_SECS,
  MAX_STREAMING_QUALITY,
  DEFAULT_EVENT_PRIORITY,
  KEYFRAME_BURST_MS,
  SHORT_KEYFRAME_BURST_MS,
  STDERR_TAIL_MAX_CHARS,
  MAX_FFMPEG_BUFFER_MULTIPLIER,
  sleep,
  COLOR_WHITE,
  COLOR_RED,
  COLOR_GREY,
  COLOR_GREEN,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_PURPLE,
  RATE,
  AUDIO_TICK,
  AUDIO_CHUNK,
  SILENCE,
  YUV420_LUMA_CHROMA_NUMERATOR,
  clampNum,
} = require('./constants');
const {stripRtspUrlFragment, CameraConfig} = require('./camera-config');
const {
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  resolveBuildInfo,
  resolveServiceEndpoints,
  resolveRuntimeEnv,
  expandConfigEnvVars,
  resolveConfigFilePath,
  resolveReadyMarkerPath,
} = require('./env');
const {validateConfig, loadConfigFile, loadConfig} = require('./validation');
const {
  bindActiveConfigDefaults,
  getEventPriority,
  normalizeCardPosition,
  normalizeCardTheme,
  normalizeSleepScreen,
  resolveFrameRates,
  resolveCameraTriggers,
  resolveCameraMode,
  resolveTelemetryConfig,
  resolveCardConfig,
  resolveCameraTimers,
  resolveHardwareRecordingConfig,
  resolveCameraConfig,
} = require('./resolvers');
const {BridgeConfigBuilder} = require('./builder');

const READY_MARKER_FILE = resolveReadyMarkerPath(process.env);
const rawLoadedCfg = loadConfig(process.env);
const processRuntimeEnv = resolveRuntimeEnv(process.env);
const ACTIVE_LOG_LEVEL_NAME = initLogger(processRuntimeEnv.logLevel);

bindActiveConfigDefaults({
  rawCfg: rawLoadedCfg,
  builtCfg: rawLoadedCfg,
  triggers: new Set(),
});

const cfg = (() => {
  try {
    return new BridgeConfigBuilder(rawLoadedCfg, process.env)
      .withEndpoints()
      .withVideoAndAudio()
      .withTimersAndArbitration()
      .withEventsAndOverlays()
      .withCameras()
      .build();
  } catch (err) {
    log.error('bridge', 'startup configuration error: ' + formatErrorMessage(err));
    process.exit(1);
  }
})();

bindActiveConfigDefaults({
  rawCfg: rawLoadedCfg,
  builtCfg: cfg,
  triggers: cfg.triggers,
});

const COOLDOWN_MS = cfg.cooldownMs;
const SNAP_DELAY_MS = cfg.snapDelayMs;
const FORWARD_FACE_NAMES = cfg.forward_face_names;
const PREEMPT_EVENT_STREAMS = cfg.view_has_priority;
const BACKFILL_DELAY_MS = cfg.backfillDelayMs;
const GLOBAL_AUTO_FRIGATE_MASK = cfg.auto_frigate_mask;
const GLOBAL_CARD_SHOW_ON_LIVE = cfg.card_show_on_live;
const INSTANT_EVENT_SNAPSHOT = cfg.instant_event_snapshot;
const LOW_BAT_THRESHOLD = cfg.low_battery_threshold;
const CRITICAL_BAT_THRESHOLD = cfg.critical_battery_threshold;
const TELEMETRY_POLL_MS = cfg.telemetryPollMs;
const HTTP_PORT = cfg.http_port;
const HWACCEL_DEVICE = cfg.hwaccel_device;
const ACTIVE_HWACCEL = cfg.activeHwaccel;
const W = cfg.width;
const H = cfg.height;
const FRAME = (W * H * YUV420_LUMA_CHROMA_NUMERATOR) / 2;
const LIVE_FPS = cfg.live_fps;
const IDLE_FPS = cfg.idle_fps;
const AUDIO = cfg.audio;

/** @type {Array<[string, string]>} */
const LABELS = [
  ['person', 'person'],
  ['loitering', 'person'],
  ['ring', cfg.ring_label],
  ['package', 'package'],
  ['vehicle', 'car'],
  ['dog', 'dog'],
  ['pet', 'dog'],
];
const TRIGGERS = cfg.triggers;
const CACHE_DIR = cfg.cache_dir;

module.exports = {
  cfg,
  READY_MARKER_FILE,
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  resolveBuildInfo,
  resolveServiceEndpoints,
  resolveConfigFilePath,
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
  POWER_MODES,
  STREAMING_QUALITIES,
  OPTIMAL_BATTERY_MAX_CLIP_SECS,
  SURVEILLANCE_HOLD_SECS,
  MIN_RECORDING_CLIP_SECS,
  MAX_RECORDING_CLIP_SECS,
  MAX_STREAMING_QUALITY,
  CameraConfig,
  BridgeConfigBuilder,
  resolveCameraConfig,
  clampNum,
  ACTIVE_LOG_LEVEL_NAME,
  COOLDOWN_MS,
  SNAP_DELAY_MS,
  FORWARD_FACE_NAMES,
  PREEMPT_EVENT_STREAMS,
  BACKFILL_DELAY_MS,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
  INSTANT_EVENT_SNAPSHOT,
  LOW_BAT_THRESHOLD,
  CRITICAL_BAT_THRESHOLD,
  TELEMETRY_POLL_MS,
  HTTP_PORT,
  HWACCEL_DEVICE,
  ACTIVE_HWACCEL,
  W,
  H,
  FRAME,
  LIVE_FPS,
  IDLE_FPS,
  AUDIO,
  RATE,
  AUDIO_TICK,
  AUDIO_CHUNK,
  SILENCE,
  COLOR_WHITE,
  COLOR_RED,
  COLOR_GREY,
  COLOR_GREEN,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_PURPLE,
  DEFAULT_EVENT_PRIORITY,
  KEYFRAME_BURST_MS,
  SHORT_KEYFRAME_BURST_MS,
  STDERR_TAIL_MAX_CHARS,
  MAX_FFMPEG_BUFFER_MULTIPLIER,
  sleep,
  LABELS,
  TRIGGERS,
  CACHE_DIR,
  getEventPriority,
  validateConfig,
  stripRtspUrlFragment,
  expandConfigEnvVars,
  loadConfigFile,
  normalizeCardPosition,
  normalizeCardTheme,
  normalizeSleepScreen,
  resolveFrameRates,
  resolveCameraTriggers,
  resolveCameraMode,
  resolveTelemetryConfig,
  resolveCardConfig,
  resolveCameraTimers,
  resolveHardwareRecordingConfig,
};
