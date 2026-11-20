// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Configuration schema sets, frozen domain enums, trigger aliases, priority tiers,
 * semantic RGB colors, audio constants, numeric bounds, and clampNum.
 */
'use strict';

const DEFAULT_FALLBACK_VERSION = '0.0.2';
const DEFAULT_FALLBACK_COMMIT = 'dev';
const DEFAULT_CACHE_DIR = '/config/cache';
const DEFAULT_HWACCEL_DEVICE = '/dev/dri/renderD128';
const DEFAULT_CONTAINER_CONFIG_PATH = '/config/config.yaml';
const DEFAULT_LOCAL_CONFIG_PATH = 'config.yaml';
const READY_MARKER_FILENAME = 'eufy-bridge-ready.pid';
const MS_PER_SECOND = 1000;
const MIN_STREAMING_QUALITY = 0;
const MAX_STREAMING_QUALITY = 10;

const DEFAULT_EUFY_WS_HOST = 'eufy-security-ws';
const DEFAULT_EUFY_WS_PORT = 3000;
const DEFAULT_FRIGATE_HOST = 'frigate';
const DEFAULT_FRIGATE_HTTP_PORT = 5000;
const DEFAULT_GO2RTC_HTTP_PORT = 1984;
const DEFAULT_GO2RTC_RTSP_PORT = 8554;
const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_LOG_LEVEL = 'info';
const MIN_TCP_PORT = 1;
const MIN_HTTP_LISTEN_PORT = 0;
const MAX_TCP_PORT = 65535;
const DEFAULT_HTTP_PROTOCOL = 'http:';
const DEFAULT_WS_PROTOCOL = 'ws:';
const RTSP_NAME_TEMPLATE_TOKEN = '{name}';

/** @type {Set<string>} */
const ALLOWED_TOP_KEYS = new Set([
  'cameras',
  'hold_secs',
  'view_linger_secs',
  'view_max_secs',
  'trigger_events',
  'width',
  'height',
  'live_fps',
  'idle_fps',
  'audio',
  'stream_max_secs',
  'frigate_event_secs',
  'snapshot_capture_delay_secs',
  'view_cooldown_secs',
  'idle_timeout_secs',
  'view_has_priority',
  'card_theme',
  'card_position',
  'sleep_screen',
  'card_show_on_live',
  'auto_frigate_mask',
  'preserve_aspect_ratio',
  'startup_snapshot',
  'instant_event_snapshot',
  'end_early',
  'use_rtsp',
  'backfill_enabled',
  'backfill_delay_secs',
  'power_mode',
  'track_stuck_spotlight',
  'streaming_quality',
  'low_battery_threshold',
  'critical_battery_threshold',
  'low_battery_hold_secs',
  'low_battery_wake_on_view',
  'telemetry_poll_secs',
  'telemetry',
  'forward_face_names',
  'ring_label',
  'event_priorities',
]);

/** @type {Set<string>} */
const ALLOWED_CAMERA_KEYS = new Set([
  'name',
  'serial',
  'title',
  'mode',
  'station_serial',
  'rtsp_url',
  'priority',
  'use_rtsp',
  'backfill_only',
  'backfill_enabled',
  'hold_secs',
  'stream_max_secs',
  'frigate_event_secs',
  'end_early',
  'idle_timeout_secs',
  'view_linger_secs',
  'view_max_secs',
  'low_battery_threshold',
  'critical_battery_threshold',
  'low_battery_hold_secs',
  'low_battery_wake_on_view',
  'power_mode',
  'track_stuck_spotlight',
  'recording_clip_length',
  'recording_end_early',
  'recording_retrigger_interval',
  'streaming_quality',
  'trigger_events',
  'card_theme',
  'card_position',
  'sleep_screen',
  'card_show_on_live',
  'auto_frigate_mask',
  'preserve_aspect_ratio',
  'startup_snapshot',
  'telemetry',
]);

/**
 * POSIX process signals used for FFmpeg process termination and bridge runtime hooks.
 *
 * @readonly
 * @enum {string}
 */
const PROCESS_SIGNALS = Object.freeze({
  SIGTERM: 'SIGTERM',
  SIGINT: 'SIGINT',
  SIGKILL: 'SIGKILL',
  SIGUSR1: 'SIGUSR1',
  SIGUSR2: 'SIGUSR2',
});

/**
 * Supported status card visual themes.
 *
 * @readonly
 * @enum {string}
 */
const CARD_THEMES = Object.freeze({
  GLANCE: 'glance',
  MINIMAL: 'minimal',
  PEBBLES: 'pebbles',
  HUD: 'hud',
  NONE: 'none',
});

/**
 * Supported status card screen placements.
 *
 * @readonly
 * @enum {string}
 */
const CARD_POSITIONS = Object.freeze({
  CENTER: 'center',
  TOP_LEFT: 'top-left',
  TOP_CENTER: 'top-center',
  TOP_RIGHT: 'top-right',
  BOTTOM_LEFT: 'bottom-left',
  BOTTOM_CENTER: 'bottom-center',
  BOTTOM_RIGHT: 'bottom-right',
});

const CARD_POS_ALIAS_CENTER_TOP = 'center-top';
const CARD_POS_ALIAS_CENTER_BOTTOM = 'center-bottom';

/**
 * Supported sleeping screen background modes.
 *
 * @readonly
 * @enum {string}
 */
const SLEEP_SCREENS = Object.freeze({
  SNAPSHOT: 'snapshot',
  SLATE: 'slate',
  BLACK: 'black',
});

/**
 * User-facing status card display titles (distinct from internal STATUS_KINDS and STREAM_MODES).
 *
 * @readonly
 * @enum {string}
 */
const CARD_STATUS_TITLES = Object.freeze({
  ASLEEP: 'Asleep',
  ASLEEP_LOW_BATTERY: 'Asleep (Low Battery)',
  DISCONNECTED: 'Disconnected',
  WAKING_UP: 'Waking Up...',
  WAITING: 'Waiting',
  LIVE: 'Live',
  BACKFILL: 'Backfill',
});

/**
 * Configured camera operating modes in config.yaml (distinct from runtime STREAM_MODES).
 *
 * @readonly
 * @enum {string}
 */
const CAMERA_MODES = Object.freeze({
  AUTO: 'auto',
  RTSP: 'rtsp',
  P2P: 'p2p',
  BACKFILL: 'backfill',
  CUSTOM: 'custom',
});

/**
 * Runtime active session stream modes (distinct from configured CAMERA_MODES).
 *
 * @readonly
 * @enum {string}
 */
const STREAM_MODES = Object.freeze({
  RTSP: 'rtsp',
  P2P: 'p2p',
  DOWNLOAD: 'download',
});

/**
 * Supported FFmpeg hardware acceleration modes.
 *
 * @readonly
 * @enum {string}
 */
const HWACCEL_MODES = Object.freeze({
  NONE: '',
  VAAPI: 'vaapi',
  QSV: 'qsv',
  NVENC: 'nvenc',
  V4L2M2M: 'v4l2m2m',
});

/**
 * Frame stage markers rendered in the left status square of the Debug HUD and tracked per frame.
 *
 * @readonly
 * @enum {string}
 */
const FRAME_STAGE_MARKERS = Object.freeze({
  SNAPSHOT: 'S',
  FIRST_BACKFILL: 'FB',
  BACKFILL: 'B',
  LIVE: 'L',
});

/**
 * Eufy hardware Power Manager working modes (powerWorkingMode property).
 *
 * @readonly
 * @enum {number}
 */
const POWER_WORKING_MODES = Object.freeze({
  BATTERY_SAVER: 0,
  SURVEILLANCE: 1,
  CUSTOMIZE_RECORDING: 2,
});

/**
 * Grouped opt-in Eufy Power Manager profiles in config.yaml (`power_mode`).
 *
 * @readonly
 * @enum {string}
 */
const POWER_MODES = Object.freeze({
  KEEP: 'keep',
  BATTERY: 'battery',
  SURVEILLANCE: 'surveillance',
  CUSTOM: 'custom',
});

/**
 * Grouped opt-in Eufy live P2P streaming quality profiles in config.yaml (`streaming_quality`).
 *
 * @readonly
 * @enum {string}
 */
const STREAMING_QUALITIES = Object.freeze({
  KEEP: 'keep',
  AUTO: 'auto',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  ULTRA: 'ultra',
});

/** @type {Set<string>} */
const SUPPORTED_HWACCEL_MODES = new Set([
  HWACCEL_MODES.VAAPI,
  HWACCEL_MODES.QSV,
  HWACCEL_MODES.NVENC,
  HWACCEL_MODES.V4L2M2M,
]);

const DISABLED_HWACCEL_TOKENS = new Set(['false', 'none', 'off', '0', 'software']);
const SUPPORTED_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'warning', 'error']);
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const WS_PROTOCOLS = new Set(['ws:', 'wss:']);
const RTSP_PROTOCOLS = new Set(['rtsp:', 'rtsps:']);

const BOOLEAN_CONFIG_KEYS = new Set([
  'audio',
  'card_show_on_live',
  'auto_frigate_mask',
  'preserve_aspect_ratio',
  'instant_event_snapshot',
  'end_early',
  'use_rtsp',
  'backfill_enabled',
  'backfill_only',
  'track_stuck_spotlight',
  'low_battery_wake_on_view',
  'forward_face_names',
  'recording_end_early',
]);

const INTEGER_CONFIG_KEYS = new Set([
  'width',
  'height',
  'live_fps',
  'idle_fps',
  'low_battery_threshold',
  'critical_battery_threshold',
  'telemetry_poll_secs',
  'priority',
  'recording_clip_length',
  'recording_retrigger_interval',
]);

const FLOAT_CONFIG_KEYS = new Set([
  'snapshot_capture_delay_secs',
  'hold_secs',
  'stream_max_secs',
  'frigate_event_secs',
  'idle_timeout_secs',
  'view_linger_secs',
  'view_max_secs',
  'view_cooldown_secs',
  'backfill_delay_secs',
  'low_battery_hold_secs',
]);

const ALLOWED_TELEMETRY_KEYS = new Set([
  'enabled',
  'battery',
  'power_source',
  'wifi',
  'rssi',
  'temperature',
  'last_seen',
]);

const TRIGGER_EVENT_ALIASES = Object.freeze({
  motion: ['motion detected', 'radar motion detected'],
  radar: ['radar motion detected'],
  person: ['person detected', 'identity person detected', 'stranger person detected', 'someone loitering'],
  loitering: ['someone loitering'],
  package: ['package delivered', 'package stranded', 'package taken'],
  pet: ['pet detected'],
  vehicle: ['vehicle detected'],
  dog: ['dog detected', 'dog lick detected', 'dog poop detected'],
  stranger: ['stranger person detected'],
  'identity person': ['identity person detected'],
  sound: ['sound detected', 'crying detected'],
  crying: ['crying detected'],
  ring: ['rings'],
  rings: ['rings'],
  ringing: ['rings'],
});

const DEFAULT_TRIGGER_EVENTS = Object.freeze([
  'motion detected',
  'radar motion detected',
  'person detected',
  'someone loitering',
  'package delivered',
  'package stranded',
  'package taken',
  'pet detected',
  'vehicle detected',
  'dog detected',
  'dog lick detected',
  'dog poop detected',
  'stranger person detected',
  'identity person detected',
  'sound detected',
  'crying detected',
  'rings',
]);

const MIN_CAMERA_PRIORITY = -10000;
const MAX_CAMERA_PRIORITY = 10000;
const DEFAULT_CAMERA_PRIORITY = 0;
const KEYFRAME_BURST_MS = 1500;
const SHORT_KEYFRAME_BURST_MS = 1200;
const STDERR_TAIL_MAX_CHARS = 4096;
const MAX_FFMPEG_BUFFER_MULTIPLIER = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_EVENT_PRIORITY = 10;
const PRIO_RING = 1000;
const PRIO_IDENTITY_PERSON = 300;
const PRIO_PERSON_GROUP = 200;
const PRIO_PACKAGE = 150;
const PRIO_VEHICLE_PET = 100;
const PRIO_SOUND = 50;

/** @type {ReadonlyArray<[string, number]>} */
const EVENT_PRIORITIES = Object.freeze([
  ['ring', PRIO_RING],
  ['identity person', PRIO_IDENTITY_PERSON],
  ['stranger', PRIO_PERSON_GROUP],
  ['loitering', PRIO_PERSON_GROUP],
  ['person', PRIO_PERSON_GROUP],
  ['package', PRIO_PACKAGE],
  ['vehicle', PRIO_VEHICLE_PET],
  ['pet', PRIO_VEHICLE_PET],
  ['dog', PRIO_VEHICLE_PET],
  ['crying', PRIO_SOUND],
  ['sound', PRIO_SOUND],
  ['radar', DEFAULT_EVENT_PRIORITY],
  ['motion', DEFAULT_EVENT_PRIORITY],
]);

// Semantic RGB palette used across 'glance', 'minimal', 'pebbles', and 'hud' themes.
const WHITE_CHANNEL = 255;
const RED_R = 239;
const RED_GB = 68;
const GREY_RG = 180;
const GREY_B = 190;
const GREEN_R = 74;
const GREEN_G = 222;
const GREEN_B = 128;
const BLUE_R = 56;
const BLUE_G = 189;
const BLUE_B = 248;
const YELLOW_R = 250;
const YELLOW_G = 204;
const YELLOW_B = 21;
const PURPLE_R = 232;
const PURPLE_G = 121;
const PURPLE_B = 249;

const COLOR_WHITE = Object.freeze([WHITE_CHANNEL, WHITE_CHANNEL, WHITE_CHANNEL]);
const COLOR_RED = Object.freeze([RED_R, RED_GB, RED_GB]);
const COLOR_GREY = Object.freeze([GREY_RG, GREY_RG, GREY_B]);
const COLOR_GREEN = Object.freeze([GREEN_R, GREEN_G, GREEN_B]);
const COLOR_BLUE = Object.freeze([BLUE_R, BLUE_G, BLUE_B]);
const COLOR_YELLOW = Object.freeze([YELLOW_R, YELLOW_G, YELLOW_B]);
const COLOR_PURPLE = Object.freeze([PURPLE_R, PURPLE_G, PURPLE_B]);

// Audio configuration: 16 kHz, 16-bit signed little-endian mono PCM sent in 100 ms chunks.
const RATE = 16000;
const AUDIO_TICK = 100;
const AUDIO_CHUNK = (RATE * 2 * AUDIO_TICK) / MS_PER_SECOND;
const SILENCE = Buffer.alloc(AUDIO_CHUNK, 0);

// Video dimension & frame rate bounds.
const MIN_VIDEO_WIDTH = 320;
const MAX_VIDEO_WIDTH = 3840;
const DEFAULT_VIDEO_WIDTH = 1280;
const MIN_VIDEO_HEIGHT = 240;
const MAX_VIDEO_HEIGHT = 2160;
const DEFAULT_VIDEO_HEIGHT = 720;
const MIN_LIVE_FPS = 5;
const MAX_LIVE_FPS = 60;
const DEFAULT_LIVE_FPS = 15;
const MIN_IDLE_FPS = 1;
const MAX_IDLE_FPS = 30;
const DEFAULT_IDLE_FPS = 5;
const YUV420_LUMA_CHROMA_NUMERATOR = 3;

// Per-camera timer, battery, and Eufy hardware Power Manager property bounds.
const DEFAULT_BACKFILL_DELAY_SECS = 2;
const DEFAULT_TRACK_STUCK_SPOTLIGHT = false;
const DEFAULT_VIEW_COOLDOWN_SECS = 5;
const DEFAULT_SNAP_CAPTURE_DELAY_SECS = 3;
const MIN_CRITICAL_BAT_THRESHOLD_PCT = 1;
const MAX_CRITICAL_BAT_THRESHOLD_PCT = 98;
const DEFAULT_CRITICAL_BAT_THRESHOLD_PCT = 5;
const MIN_LOW_BAT_THRESHOLD_PCT = 2;
const MAX_LOW_BAT_THRESHOLD_PCT = 99;
const DEFAULT_LOW_BAT_THRESHOLD_PCT = 30;
const MIN_HOLD_SECS = 5;
const MAX_HOLD_SECS = 86400;
const DEFAULT_HOLD_SECS = 30;
const DEFAULT_BACKFILL_HOLD_SECS = 20;
const SURVEILLANCE_HOLD_SECS = 60;
const DEFAULT_END_EARLY = true;
const MIN_SESSION_MAX_SECS = 10;
const MAX_SESSION_MAX_SECS = 86400;
const DEFAULT_MAX_SECS = 900;
const DEFAULT_VIEW_MAX_SECS = 300;
const DEFAULT_LINGER_SECS = 20;
const MIN_EVENT_SECS = 1;
const MAX_EVENT_SECS = 3600;
const MIN_EARLY_SLEEP_SECS = 0;
const MAX_EARLY_SLEEP_SECS = 3600;
const DEFAULT_EARLY_SLEEP_SECS = 0;
const MIN_LOW_BAT_HOLD_SECS = 5;
const MAX_LOW_BAT_HOLD_SECS = 3600;
const DEFAULT_LOW_BAT_HOLD_SECS = 20;
const OPTIMAL_BATTERY_MAX_CLIP_SECS = 20;
const MIN_RECORDING_CLIP_SECS = 5;
const MAX_RECORDING_CLIP_SECS = 120;
const MIN_RETRIGGER_INTERVAL_SECS = 0;
const MAX_RETRIGGER_INTERVAL_SECS = 60;
const DEFAULT_RETRIGGER_INTERVAL_SECS = 5;

/**
 * Clamps a numeric configuration value to [min, max], returning fallback if undefined or NaN.
 *
 * @param {*} val - Raw configuration value.
 * @param {number} min - Minimum allowed value.
 * @param {...number} bounds - `[max, fallback]` upper bound and default value.
 * @returns {number}
 */
function clampNum(val, min, ...bounds) {
  const [max, fallback] = bounds;
  if (val === undefined || val === null || typeof val === 'boolean' || typeof val === 'object') {
    return fallback;
  }
  if (typeof val === 'string' && !val.trim()) {
    return fallback;
  }
  const numeric = Number(val);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

module.exports = {
  DEFAULT_FALLBACK_VERSION,
  DEFAULT_FALLBACK_COMMIT,
  DEFAULT_CACHE_DIR,
  DEFAULT_HWACCEL_DEVICE,
  DEFAULT_CONTAINER_CONFIG_PATH,
  DEFAULT_LOCAL_CONFIG_PATH,
  READY_MARKER_FILENAME,
  MS_PER_SECOND,
  MIN_STREAMING_QUALITY,
  MAX_STREAMING_QUALITY,
  DEFAULT_EUFY_WS_HOST,
  DEFAULT_EUFY_WS_PORT,
  DEFAULT_FRIGATE_HOST,
  DEFAULT_FRIGATE_HTTP_PORT,
  DEFAULT_GO2RTC_HTTP_PORT,
  DEFAULT_GO2RTC_RTSP_PORT,
  DEFAULT_HTTP_PORT,
  DEFAULT_LOG_LEVEL,
  MIN_TCP_PORT,
  MIN_HTTP_LISTEN_PORT,
  MAX_TCP_PORT,
  DEFAULT_HTTP_PROTOCOL,
  DEFAULT_WS_PROTOCOL,
  RTSP_NAME_TEMPLATE_TOKEN,
  ALLOWED_TOP_KEYS,
  ALLOWED_CAMERA_KEYS,
  PROCESS_SIGNALS,
  CARD_THEMES,
  CARD_POSITIONS,
  CARD_POS_ALIAS_CENTER_TOP,
  CARD_POS_ALIAS_CENTER_BOTTOM,
  SLEEP_SCREENS,
  CARD_STATUS_TITLES,
  CAMERA_MODES,
  STREAM_MODES,
  HWACCEL_MODES,
  FRAME_STAGE_MARKERS,
  POWER_WORKING_MODES,
  POWER_MODES,
  STREAMING_QUALITIES,
  SUPPORTED_HWACCEL_MODES,
  DISABLED_HWACCEL_TOKENS,
  SUPPORTED_LOG_LEVELS,
  HTTP_PROTOCOLS,
  WS_PROTOCOLS,
  RTSP_PROTOCOLS,
  BOOLEAN_CONFIG_KEYS,
  INTEGER_CONFIG_KEYS,
  FLOAT_CONFIG_KEYS,
  ALLOWED_TELEMETRY_KEYS,
  TRIGGER_EVENT_ALIASES,
  DEFAULT_TRIGGER_EVENTS,
  MIN_CAMERA_PRIORITY,
  MAX_CAMERA_PRIORITY,
  DEFAULT_CAMERA_PRIORITY,
  KEYFRAME_BURST_MS,
  SHORT_KEYFRAME_BURST_MS,
  STDERR_TAIL_MAX_CHARS,
  MAX_FFMPEG_BUFFER_MULTIPLIER,
  sleep,
  DEFAULT_EVENT_PRIORITY,
  EVENT_PRIORITIES,
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
  MIN_VIDEO_WIDTH,
  MAX_VIDEO_WIDTH,
  DEFAULT_VIDEO_WIDTH,
  MIN_VIDEO_HEIGHT,
  MAX_VIDEO_HEIGHT,
  DEFAULT_VIDEO_HEIGHT,
  MIN_LIVE_FPS,
  MAX_LIVE_FPS,
  DEFAULT_LIVE_FPS,
  MIN_IDLE_FPS,
  MAX_IDLE_FPS,
  DEFAULT_IDLE_FPS,
  YUV420_LUMA_CHROMA_NUMERATOR,
  DEFAULT_BACKFILL_DELAY_SECS,
  DEFAULT_TRACK_STUCK_SPOTLIGHT,
  DEFAULT_VIEW_COOLDOWN_SECS,
  DEFAULT_SNAP_CAPTURE_DELAY_SECS,
  MIN_CRITICAL_BAT_THRESHOLD_PCT,
  MAX_CRITICAL_BAT_THRESHOLD_PCT,
  DEFAULT_CRITICAL_BAT_THRESHOLD_PCT,
  MIN_LOW_BAT_THRESHOLD_PCT,
  MAX_LOW_BAT_THRESHOLD_PCT,
  DEFAULT_LOW_BAT_THRESHOLD_PCT,
  MIN_HOLD_SECS,
  MAX_HOLD_SECS,
  DEFAULT_HOLD_SECS,
  DEFAULT_BACKFILL_HOLD_SECS,
  SURVEILLANCE_HOLD_SECS,
  DEFAULT_END_EARLY,
  MIN_SESSION_MAX_SECS,
  MAX_SESSION_MAX_SECS,
  DEFAULT_MAX_SECS,
  DEFAULT_VIEW_MAX_SECS,
  DEFAULT_LINGER_SECS,
  MIN_EVENT_SECS,
  MAX_EVENT_SECS,
  MIN_EARLY_SLEEP_SECS,
  MAX_EARLY_SLEEP_SECS,
  DEFAULT_EARLY_SLEEP_SECS,
  MIN_LOW_BAT_HOLD_SECS,
  MAX_LOW_BAT_HOLD_SECS,
  DEFAULT_LOW_BAT_HOLD_SECS,
  OPTIMAL_BATTERY_MAX_CLIP_SECS,
  MIN_RECORDING_CLIP_SECS,
  MAX_RECORDING_CLIP_SECS,
  MIN_RETRIGGER_INTERVAL_SECS,
  MAX_RETRIGGER_INTERVAL_SECS,
  DEFAULT_RETRIGGER_INTERVAL_SECS,
  clampNum,
};
