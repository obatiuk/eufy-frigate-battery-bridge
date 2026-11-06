// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Configuration loading, validation, numeric clamping, and normalized option resolvers.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {log, initLogger} = require('./logger');

const DEFAULT_FALLBACK_VERSION = '1.0.0';
const DEFAULT_FALLBACK_COMMIT = 'dev';
const MS_PER_SECOND = 1000;

const DEFAULT_PACKAGE_VERSION = (() => {
  const candidatePaths = [
    path.resolve(__dirname, '../package.json'),
    path.resolve(__dirname, 'package.json'),
  ];
  for (const pkgPath of candidatePaths) {
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
          return pkg.version.trim();
        }
      }
    } catch (err) {
      // Try next candidate path when package.json cannot be read.
    }
  }
  return DEFAULT_FALLBACK_VERSION;
})();

/**
 * Resolves the build version and Git commit identifier from environment variables or package.json.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {Readonly<{ version: string, commit: string }>}
 */
function resolveBuildInfo(env = process.env) {
  const rawVer = env && env.BRIDGE_VERSION ? String(env.BRIDGE_VERSION).trim() : '';
  const rawCommit = env && env.BRIDGE_COMMIT ? String(env.BRIDGE_COMMIT).trim() : '';
  return Object.freeze({
    version: rawVer || DEFAULT_PACKAGE_VERSION,
    commit: rawCommit || DEFAULT_FALLBACK_COMMIT,
  });
}

const {version: BRIDGE_VERSION, commit: BRIDGE_COMMIT} = resolveBuildInfo(process.env);

const REQUIRED_CONFIG_KEYS = ['eufy_security_ws_url', 'frigate_url'];
const LEGACY_REQUIRED_KEYS = ['eufy_ws', 'rtsp_publish', 'go2rtc_api'];
const DEFAULT_FRIGATE_HTTP_PORT = 5000;
const DEFAULT_GO2RTC_HTTP_PORT = 1984;
const DEFAULT_GO2RTC_RTSP_PORT = 8554;
const DEFAULT_FALLBACK_HOST = 'frigate';
const DEFAULT_HTTP_PROTOCOL = 'http:';
const RTSP_NAME_TEMPLATE_TOKEN = '{name}';
const TRAILING_SLASHES_REGEX = /\/+$/;
const TRAILING_API_PATH_REGEX = /\/api$/i;

/** @type {Set<string>} */
const LEGACY_ONLY_TOP_KEYS = new Set([
  'eufy_ws',
  'go2rtc_api',
  'rtsp_publish',
  'frigate_api',
  'ha_webhook',
  'max_secs',
  'min_dwell_secs',
  'viewer_cooldown_secs',
  'event_secs',
  'snapshot_delay_secs',
]);

/** @type {Set<string>} */
const SHARED_TOP_KEYS = new Set([
  '$schema',
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
]);

/** @type {Set<string>} */
const NEW_ONLY_TOP_KEYS = new Set([
  'eufy_security_ws_url',
  'frigate_url',
  'go2rtc_url',
  'rtsp_output_url',
  'ha_webhook_url',
  'stream_max_secs',
  'frigate_event_secs',
  'snapshot_capture_delay_secs',
  'view_cooldown_secs',
  'idle_timeout_secs',
  'view_has_priority',
  'http_port',
  'log_level',
  'hwaccel',
  'hwaccel_device',
  'cache_dir',
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
  'backfill_only',
  'backfill_delay_secs',
  'sync_power',
  'track_stuck_spotlight',
  'enforce_streaming_quality',
  'low_battery_threshold',
  'low_battery_hold_secs',
  'low_battery_wake_on_view',
  'telemetry_poll_secs',
  'telemetry',
  'forward_face_names',
  'ring_label',
  'event_priorities',
]);

/** @type {Set<string>} */
const SHARED_CAMERA_KEYS = new Set(['name', 'serial', 'title']);

/** @type {Set<string>} */
const NEW_ONLY_CAMERA_KEYS = new Set([
  'mode',
  'station_serial',
  'homebase_rtsp_url',
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
  'low_battery_hold_secs',
  'low_battery_wake_on_view',
  'sync_power',
  'track_stuck_spotlight',
  'power_working_mode',
  'recording_clip_length',
  'recording_end_early',
  'recording_retrigger_interval',
  'enforce_streaming_quality',
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

const LEGACY_TO_NEW_KEY_MAP = Object.freeze({
  eufy_ws: 'eufy_security_ws_url',
  go2rtc_api: 'go2rtc_url',
  rtsp_publish: 'rtsp_output_url',
  frigate_api: 'frigate_url',
  ha_webhook: 'ha_webhook_url',
  max_secs: 'stream_max_secs',
  viewer_cooldown_secs: 'view_cooldown_secs',
  event_secs: 'frigate_event_secs',
  snapshot_delay_secs: 'snapshot_capture_delay_secs',
});

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
  ICONS: 'icons',
  MINIMAL: 'minimal',
  DETAILED: 'detailed',
  DEBUG: 'debug',
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
  TOP_RIGHT: 'top-right',
  BOTTOM_LEFT: 'bottom-left',
  BOTTOM_RIGHT: 'bottom-right',
});

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
 * Configured camera operating modes in config.json (distinct from runtime STREAM_MODES).
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

/** @type {Set<string>} */
const SUPPORTED_HWACCEL_MODES = new Set([
  HWACCEL_MODES.VAAPI,
  HWACCEL_MODES.QSV,
  HWACCEL_MODES.NVENC,
  HWACCEL_MODES.V4L2M2M,
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

// Shared priority bounds, keyframe burst durations, buffer limits, and async sleep helper.
const MIN_CAMERA_PRIORITY = -10000;
const MAX_CAMERA_PRIORITY = 10000;
const DEFAULT_CAMERA_PRIORITY = 0;
const KEYFRAME_BURST_MS = 1500;
const SHORT_KEYFRAME_BURST_MS = 1200;
const STDERR_TAIL_MAX_CHARS = 500;
const MAX_FFMPEG_BUFFER_MULTIPLIER = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Built-in priority boosts by Eufy event type (combined with per-camera config priority).
const DEFAULT_EVENT_PRIORITY = 10;
/** @type {ReadonlyArray<[string, number]>} */
const EVENT_PRIORITIES = Object.freeze([
  ['ring', 1000],
  ['identity person', 300],
  ['stranger', 200],
  ['loitering', 200],
  ['person', 200],
  ['package', 150],
  ['vehicle', 100],
  ['pet', 100],
  ['dog', 100],
  ['crying', 50],
  ['sound', 50],
  ['radar', DEFAULT_EVENT_PRIORITY],
  ['motion', DEFAULT_EVENT_PRIORITY],
]);

// Semantic palette used across 'detailed', 'icons', 'minimal', and 'debug' themes:
// Red = Live/Backfill, Grey = Disconnected, Green = Asleep (sleep-ready) / Healthy,
// Blue = Waking/Charging/Good/Cold, Yellow = Waiting/Medium/Fair/Warm,
// Purple = Critical/Low-Battery/Poor/Hot.
const COLOR_RED = Object.freeze([239, 68, 68]);
const COLOR_GREY = Object.freeze([180, 180, 190]);
const COLOR_GREEN = Object.freeze([74, 222, 128]);
const COLOR_BLUE = Object.freeze([56, 189, 248]);
const COLOR_YELLOW = Object.freeze([250, 204, 21]);
const COLOR_PURPLE = Object.freeze([232, 121, 249]);

/**
 * Clamps a numeric configuration value to [min, max], returning fallback if undefined or NaN.
 *
 * @param {*} val - Raw configuration value.
 * @param {number} min - Minimum allowed value.
 * @param {number} max - Maximum allowed value.
 * @param {number} fallback - Default value when val is undefined or NaN.
 * @returns {number}
 */
function clampNum(val, min, max, fallback) {
  const numeric = Number(val ?? fallback);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Immutable per-camera configuration domain value object encapsulating camera identity
 * normalization, scope resolution, snapshot cache filename formatting, and resolved sub-configs.
 */
class CameraConfig {
  /**
   * @param {Record<string, *>} props - Resolved camera configuration properties.
   */
  constructor(props = {}) {
    Object.assign(this, props);
    /** @type {string} */
    this.serial = String(props.serial || '');
    /** @type {string} */
    this.name = String(props.name || this.serial);
  }

  /**
   * Returns the normalized internal camera stream name.
   *
   * @returns {string}
   */
  getName() {
    return this.name;
  }

  /**
   * Returns the normalized hardware serial number.
   *
   * @returns {string}
   */
  getSerial() {
    return this.serial;
  }

  /**
   * Returns the structured logger scope name for this camera.
   *
   * @param {string} [fallback='bridge'] - Fallback scope when name and serial are empty.
   * @returns {string}
   */
  getScopeName(fallback = 'bridge') {
    return this.name || this.serial || fallback;
  }

  /**
   * Returns the unique snapshot cache filename ('last_<name>_<serial>.jpg') for this camera.
   *
   * @returns {string}
   */
  getCacheFileName() {
    return 'last_' + this.name + '_' + this.serial + '.jpg';
  }

  /**
   * Returns true if this camera configuration has a valid non-empty serial and name.
   *
   * @returns {boolean}
   */
  hasValidIdentity() {
    return Boolean(this.serial && this.name);
  }

  /**
   * Returns true if camConfig is an already-built and frozen CameraConfig instance.
   *
   * @param {*} camConfig - Candidate camera configuration object.
   * @returns {boolean}
   */
  static isResolved(camConfig) {
    return Boolean(camConfig instanceof CameraConfig && Object.isFrozen(camConfig));
  }

  /**
   * Normalizes a raw camera configuration object's serial and name (defaulting name to serial
   * when omitted) and returns an immutable `{ serial, name }` pair.
   *
   * @param {Record<string, *>|null|undefined} rawCam - Raw camera configuration entry.
   * @returns {Readonly<{ serial: string, name: string }>}
   */
  static normalizeIdentity(rawCam) {
    if (!rawCam || typeof rawCam !== 'object') {
      return Object.freeze({serial: '', name: ''});
    }
    const serial = String(rawCam.serial || '').trim();
    const name = String(rawCam.name || serial).trim();
    if (serial && !Object.isFrozen(rawCam)) {
      rawCam.serial = serial;
      if (!rawCam.name) {
        rawCam.name = name;
      }
    }
    return Object.freeze({serial, name});
  }

  /**
   * Normalizes a raw camera entry's default name from serial and returns true when both
   * serial and name are present.
   *
   * @param {*} rawCam - Raw or resolved camera configuration entry.
   * @returns {boolean}
   */
  static hasValidIdentity(rawCam) {
    if (rawCam && typeof rawCam.hasValidIdentity === 'function') {
      return rawCam.hasValidIdentity();
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return Boolean(serial && name);
  }

  /**
   * Resolves the logger scope name for any raw, resolved, or domain camera object.
   *
   * @param {*} rawCam - Camera configuration or domain instance.
   * @param {string} [fallback='bridge'] - Fallback scope name.
   * @returns {string}
   */
  static resolveScopeName(rawCam, fallback = 'bridge') {
    if (rawCam && typeof rawCam.getScopeName === 'function') {
      return rawCam.getScopeName(fallback);
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return name || serial || fallback;
  }

  /**
   * Resolves the deterministic JPEG cache filename ('last_<name>_<serial>.jpg') for any
   * camera configuration or domain instance.
   *
   * @param {*} rawCam - Camera configuration or domain instance.
   * @returns {string}
   */
  static resolveCacheFileName(rawCam) {
    if (rawCam && typeof rawCam.getCacheFileName === 'function') {
      return rawCam.getCacheFileName();
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return 'last_' + name + '_' + serial + '.jpg';
  }
}

/**
 * Normalizes a base HTTP service URL (frigate_url or go2rtc_url) by trimming whitespace
 * and stripping any accidental trailing '/' or '/api' path suffix.
 *
 * @param {*} rawUrl - Raw URL string from config.json.
 * @returns {string}
 */
function normalizeBaseHttpUrl(rawUrl) {
  return String(rawUrl || '')
      .trim()
      .replace(TRAILING_SLASHES_REGEX, '')
      .replace(TRAILING_API_PATH_REGEX, '')
      .replace(TRAILING_SLASHES_REGEX, '');
}

/**
 * Extracts the URL protocol and host/hostname from a base service URL, falling back to
 * 'http:' and 'frigate' when parsing fails.
 *
 * @param {*} rawUrl - Candidate service URL.
 * @returns {Readonly<{ protocol: string, host: string }>}
 */
function extractUrlProtocolAndHost(rawUrl) {
  const cleaned = normalizeBaseHttpUrl(rawUrl);
  if (cleaned) {
    try {
      const parsed = new URL(cleaned);
      const protocol =
          parsed.protocol === 'https:' ? 'https:' : DEFAULT_HTTP_PROTOCOL;
      const host = parsed.hostname.includes(':')
          ? '[' + parsed.hostname + ']'
          : parsed.hostname || DEFAULT_FALLBACK_HOST;
      return Object.freeze({protocol, host});
    } catch (err) {
      // Fall back to default host when URL cannot be parsed.
    }
  }
  return Object.freeze({protocol: DEFAULT_HTTP_PROTOCOL, host: DEFAULT_FALLBACK_HOST});
}

/**
 * Derives the bundled go2rtc HTTP base URL ('http://<frigate-host>:1984') from frigate_url
 * when go2rtc_url is omitted in config.json.
 *
 * @param {*} frigateUrl - Configured Frigate base URL.
 * @returns {string}
 */
function deriveGo2rtcUrl(frigateUrl) {
  const {protocol, host} = extractUrlProtocolAndHost(frigateUrl);
  return protocol + '//' + host + ':' + DEFAULT_GO2RTC_HTTP_PORT;
}

/**
 * Normalizes or derives the go2rtc RTSP publish URL template ('rtsp://<host>:8554/{name}'),
 * automatically appending '/{name}' when a base RTSP URL is provided without '{name}'.
 *
 * @param {*} rawRtspUrl - Optional rtsp_output_url override from config.json.
 * @param {*} go2rtcUrl - Resolved or raw go2rtc_url.
 * @param {*} frigateUrl - Resolved or raw frigate_url.
 * @returns {string}
 */
function normalizeRtspOutputUrl(rawRtspUrl, go2rtcUrl, frigateUrl) {
  const trimmed = String(rawRtspUrl || '').trim();
  if (trimmed) {
    return trimmed.includes(RTSP_NAME_TEMPLATE_TOKEN)
        ? trimmed
        : trimmed.replace(TRAILING_SLASHES_REGEX, '') + '/' + RTSP_NAME_TEMPLATE_TOKEN;
  }
  const {host} = extractUrlProtocolAndHost(go2rtcUrl || frigateUrl);
  return 'rtsp://' + host + ':' + DEFAULT_GO2RTC_RTSP_PORT + '/' + RTSP_NAME_TEMPLATE_TOKEN;
}

/**
 * Derives the Frigate HTTP base URL ('http://<host>:5000') from go2rtc_url when frigate_api
 * was omitted in a legacy configuration.
 *
 * @param {*} go2rtcUrl - Configured go2rtc base URL.
 * @returns {string}
 */
function deriveFrigateUrl(go2rtcUrl) {
  const {protocol, host} = extractUrlProtocolAndHost(go2rtcUrl);
  return protocol + '//' + host + ':' + DEFAULT_FRIGATE_HTTP_PORT;
}

/**
 * Classifies top-level and per-camera configuration keys into legacy-only, new-only, and unknown sets.
 *
 * @param {Record<string, *>} rawCfg - Candidate configuration object.
 * @returns {{
 *   legacyKeys: string[],
 *   newKeys: string[],
 *   unknownTopKeys: string[],
 *   unknownCameraKeys: string[]
 * }}
 */
function inspectConfigSchemaKeys(rawCfg) {
  const legacyKeys = [];
  const newKeys = [];
  const unknownTopKeys = [];
  const unknownCameraKeys = [];

  for (const key of Object.keys(rawCfg)) {
    if (LEGACY_ONLY_TOP_KEYS.has(key)) {
      legacyKeys.push(key);
    } else if (NEW_ONLY_TOP_KEYS.has(key)) {
      newKeys.push(key);
    } else if (!SHARED_TOP_KEYS.has(key)) {
      unknownTopKeys.push(key);
    }
  }

  if (Array.isArray(rawCfg.cameras)) {
    rawCfg.cameras.forEach((cam, idx) => {
      if (!cam || typeof cam !== 'object') {
        return;
      }
      for (const camKey of Object.keys(cam)) {
        if (NEW_ONLY_CAMERA_KEYS.has(camKey)) {
          newKeys.push('cameras[' + idx + '].' + camKey);
        } else if (!SHARED_CAMERA_KEYS.has(camKey)) {
          unknownCameraKeys.push('cameras[' + idx + '].' + camKey);
        }
      }
    });
  }

  return {legacyKeys, newKeys, unknownTopKeys, unknownCameraKeys};
}

/**
 * Validates a pure legacy upstream configuration, logs a deprecation warning, and maps all legacy
 * keys to the current schema in place with default mode="auto".
 *
 * @param {Record<string, *>} rawCfg - Legacy configuration object.
 * @param {string[]} legacyKeys - Detected legacy top-level keys.
 * @param {string[]} unknownTopKeys - Unknown top-level keys.
 * @param {string[]} unknownCameraKeys - Unknown camera keys.
 */
function validateAndMigrateLegacyConfig(rawCfg, legacyKeys, unknownTopKeys, unknownCameraKeys) {
  const errors = [];
  for (const reqKey of LEGACY_REQUIRED_KEYS) {
    if (!rawCfg[reqKey]) {
      errors.push('"' + reqKey + '" is required');
    }
  }
  if (rawCfg.rtsp_publish && !String(rawCfg.rtsp_publish).includes(RTSP_NAME_TEMPLATE_TOKEN)) {
    errors.push('"rtsp_publish" must contain ' + RTSP_NAME_TEMPLATE_TOKEN);
  }
  const hasValidLegacyCameras =
      Array.isArray(rawCfg.cameras) &&
      rawCfg.cameras.length > 0 &&
      rawCfg.cameras.every(
          (cam) =>
            Boolean(cam) &&
            typeof cam === 'object' &&
            Boolean(String(cam.name || '').trim()) &&
            Boolean(String(cam.serial || '').trim())
      );
  if (!hasValidLegacyCameras) {
    errors.push('"cameras" must list at least one {"name", "serial"}');
  }
  for (const k of unknownTopKeys) {
    errors.push('unknown key "' + k + '"');
  }
  for (const ck of unknownCameraKeys) {
    errors.push('unknown camera key "' + ck + '"');
  }
  if (errors.length > 0) {
    throw new Error('config.json: ' + errors.join('; '));
  }

  log.warn(
      'bridge',
      'legacy config.json format detected (' +
      legacyKeys.join(', ') +
      '); mapping to current schema with default mode="auto" - please migrate to the new config.json keys (eufy_security_ws_url, frigate_url)'
  );

  if (Object.isFrozen(rawCfg)) {
    return;
  }

  for (const [oldKey, newKey] of Object.entries(LEGACY_TO_NEW_KEY_MAP)) {
    if (rawCfg[oldKey] !== undefined) {
      rawCfg[newKey] = rawCfg[oldKey];
      delete rawCfg[oldKey];
    }
  }
  delete rawCfg.min_dwell_secs;

  const normalizedGo2rtcUrl = normalizeBaseHttpUrl(rawCfg.go2rtc_url);
  const normalizedFrigateUrl = rawCfg.frigate_url
      ? normalizeBaseHttpUrl(rawCfg.frigate_url)
      : deriveFrigateUrl(normalizedGo2rtcUrl);
  const normalizedRtspOutputUrl = normalizeRtspOutputUrl(
      rawCfg.rtsp_output_url,
      normalizedGo2rtcUrl,
      normalizedFrigateUrl
  );
  rawCfg.frigate_url = normalizedFrigateUrl;
  rawCfg.go2rtc_url = normalizedGo2rtcUrl;
  rawCfg.rtsp_output_url = normalizedRtspOutputUrl;
}

/**
 * Validates a parsed configuration object (supporting pure legacy upstream configs while rejecting
 * mixed legacy/new or unknown keys), normalizes/derives service URLs, and throws descriptive errors
 * listing all validation issues at once.
 *
 * @param {Record<string, *>} rawCfg - Parsed JSON configuration object.
 */
function validateConfig(rawCfg) {
  if (!rawCfg || typeof rawCfg !== 'object') {
    throw new Error('config.json: configuration must be a JSON object');
  }

  const {legacyKeys, newKeys, unknownTopKeys, unknownCameraKeys} = inspectConfigSchemaKeys(rawCfg);

  if (legacyKeys.length > 0 && newKeys.length > 0) {
    const errors = [
      'cannot mix legacy config keys (' +
      legacyKeys.join(', ') +
      ') with current config keys (' +
      newKeys.join(', ') +
      ')',
    ];
    for (const k of unknownTopKeys) {
      errors.push('unknown key "' + k + '"');
    }
    for (const ck of unknownCameraKeys) {
      errors.push('unknown camera key "' + ck + '"');
    }
    throw new Error('config.json: ' + errors.join('; '));
  }

  if (legacyKeys.length > 0) {
    validateAndMigrateLegacyConfig(rawCfg, legacyKeys, unknownTopKeys, unknownCameraKeys);
    return;
  }

  const errors = [];
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!rawCfg[key]) {
      errors.push('"' + key + '" is required');
    }
  }

  const hasValidCameras =
      Array.isArray(rawCfg.cameras) &&
      rawCfg.cameras.length > 0 &&
      rawCfg.cameras.every((cam) => CameraConfig.hasValidIdentity(cam));

  if (!hasValidCameras) {
    errors.push('"cameras" must list at least one {"serial"}');
  }

  for (const k of unknownTopKeys) {
    errors.push('unknown key "' + k + '"');
  }
  for (const ck of unknownCameraKeys) {
    errors.push('unknown camera key "' + ck + '"');
  }

  if (errors.length > 0) {
    throw new Error('config.json: ' + errors.join('; '));
  }

  const normalizedFrigateUrl = normalizeBaseHttpUrl(rawCfg.frigate_url);
  const normalizedGo2rtcUrl = rawCfg.go2rtc_url
      ? normalizeBaseHttpUrl(rawCfg.go2rtc_url)
      : deriveGo2rtcUrl(normalizedFrigateUrl);
  const normalizedRtspOutputUrl = normalizeRtspOutputUrl(
      rawCfg.rtsp_output_url,
      normalizedGo2rtcUrl,
      normalizedFrigateUrl
  );

  if (!Object.isFrozen(rawCfg)) {
    rawCfg.frigate_url = normalizedFrigateUrl;
    rawCfg.go2rtc_url = normalizedGo2rtcUrl;
    rawCfg.rtsp_output_url = normalizedRtspOutputUrl;
  }
}

const ASCII_WORD_CHAR_REGEX = /[a-z0-9]/;

/**
 * Sorts `[keyword, score]` entries by descending keyword length so more specific phrases match first.
 *
 * @param {[string, *]} a - First entry.
 * @param {[string, *]} b - Second entry.
 * @returns {number}
 */
function compareCustomPriorityEntriesByKeywordLength(a, b) {
  return b[0].length - a[0].length;
}

/**
 * Returns true if the entry value is a numeric priority score.
 *
 * @param {[string, *]} entry - Candidate `[keyword, score]` entry.
 * @returns {entry is [string, number]}
 */
function hasNumericPriorityScore(entry) {
  return typeof entry[1] === 'number' ? !Number.isNaN(entry[1]) : false;
}

/**
 * Finds the first offset where keyword starts on a non-alphanumeric boundary inside lowercase text.
 *
 * @param {string} text - Lowercased Eufy event description.
 * @param {string} keyword - Lowercased priority keyword.
 * @returns {number} Matching character offset, or -1 when absent.
 */
function findKeywordAtWordStart(text, keyword) {
  let idx = text.indexOf(keyword);
  while (idx !== -1) {
    if (idx === 0 || !ASCII_WORD_CHAR_REGEX.test(text[idx - 1])) {
      return idx;
    }
    idx = text.indexOf(keyword, idx + 1);
  }
  return -1;
}

/**
 * Returns true when keyword matches at a word-start boundary inside normalizedEvent (so `'ring'`
 * matches `'rings'` and `'doorbell ring'` without false-matching `'someone loitering'`).
 *
 * @param {string} normalizedEvent - Lowercased Eufy event description.
 * @param {string} keyword - Lowercased priority keyword.
 * @returns {boolean}
 */
function matchesEventKeyword(normalizedEvent, keyword) {
  return keyword ? findKeywordAtWordStart(normalizedEvent, keyword) !== -1 : false;
}

/**
 * Returns the priority boost for a Eufy trigger event name, honoring optional
 * event_priorities overrides from config.json before falling back to built-in tiers.
 *
 * @param {string} evName - Eufy event string.
 * @param {Record<string, *>|null} [customPriorities=null] - Optional custom {event: score} map.
 * @returns {number} Priority boost score.
 */
function getEventPriority(evName, customPriorities = null) {
  const normalized = String(evName || '').toLowerCase();
  const overrides =
      customPriorities !== null
          ? customPriorities
          : cfg && typeof cfg.event_priorities === 'object'
              ? cfg.event_priorities
              : null;
  if (overrides && typeof overrides === 'object') {
    const customEntries = Object.entries(overrides)
        .filter(hasNumericPriorityScore)
        .sort(compareCustomPriorityEntriesByKeywordLength);
    for (const [keyword, score] of customEntries) {
      const token = String(keyword || '').toLowerCase().trim();
      if (matchesEventKeyword(normalized, token)) {
        return score;
      }
    }
  }
  for (const [keyword, score] of EVENT_PRIORITIES) {
    if (matchesEventKeyword(normalized, keyword)) {
      return score;
    }
  }
  return DEFAULT_EVENT_PRIORITY;
}

/**
 * Builds the normalized Set of Eufy event names that wake a camera.
 *
 * @param {string[]|undefined} rawEvents - Optional array of trigger event strings from config.json.
 * @returns {Set<string>} Normalized set of Eufy event names.
 */
function buildTriggerSet(rawEvents) {
  const sourceEvents =
      Array.isArray(rawEvents) && rawEvents.length > 0 ? rawEvents : DEFAULT_TRIGGER_EVENTS;
  const triggers = new Set();

  for (const item of sourceEvents) {
    const key = String(item).toLowerCase().trim();
    triggers.add(key);
    const expandedList = TRIGGER_EVENT_ALIASES[key];
    if (expandedList) {
      for (const expanded of expandedList) {
        triggers.add(expanded);
      }
    }
  }
  return triggers;
}

/**
 * Normalizes a card placement string into one of the 5 supported positions.
 *
 * @param {*} rawPos - Raw card_position value from config.
 * @param {string} [scope='bridge'] - Log scope for warnings.
 * @returns {'center'|'top-left'|'top-right'|'bottom-left'|'bottom-right'}
 */
function normalizeCardPosition(rawPos, scope = 'bridge') {
  const token = String(rawPos || '')
      .toLowerCase()
      .trim();

  switch (token) {
    case '':
    case CARD_POSITIONS.BOTTOM_LEFT:
      return CARD_POSITIONS.BOTTOM_LEFT;
    case CARD_POSITIONS.TOP_LEFT:
      return CARD_POSITIONS.TOP_LEFT;
    case CARD_POSITIONS.TOP_RIGHT:
      return CARD_POSITIONS.TOP_RIGHT;
    case CARD_POSITIONS.BOTTOM_RIGHT:
      return CARD_POSITIONS.BOTTOM_RIGHT;
    case CARD_POSITIONS.CENTER:
      return CARD_POSITIONS.CENTER;
    default:
      log.warn(scope, 'unknown card_position "' + rawPos + '", defaulting to "bottom-left"');
      return CARD_POSITIONS.BOTTOM_LEFT;
  }
}

/**
 * Normalizes a card_theme string into one of the supported themes.
 *
 * @param {*} rawTheme - Raw card_theme value from config.
 * @param {string} [scope='bridge'] - Log scope for warnings.
 * @returns {'icons'|'minimal'|'detailed'|'debug'|'none'}
 */
function normalizeCardTheme(rawTheme, scope = 'bridge') {
  if (rawTheme === false) {
    return CARD_THEMES.NONE;
  }

  const token = String(rawTheme ?? CARD_THEMES.ICONS)
      .toLowerCase()
      .trim();

  switch (token) {
    case '':
    case CARD_THEMES.ICONS:
      return CARD_THEMES.ICONS;
    case CARD_THEMES.MINIMAL:
      return CARD_THEMES.MINIMAL;
    case CARD_THEMES.DETAILED:
      return CARD_THEMES.DETAILED;
    case CARD_THEMES.DEBUG:
      return CARD_THEMES.DEBUG;
    case CARD_THEMES.NONE:
      return CARD_THEMES.NONE;
    default:
      log.warn(scope, 'unknown card_theme "' + rawTheme + '", defaulting to "icons"');
      return CARD_THEMES.ICONS;
  }
}

/**
 * Normalizes the sleep_screen backdrop setting ('snapshot', 'slate', or 'black').
 *
 * @param {*} rawScreen - Raw sleep_screen value from config.
 * @param {string} [scope='bridge'] - Log scope for warnings.
 * @returns {'snapshot'|'slate'|'black'}
 */
function normalizeSleepScreen(rawScreen, scope = 'bridge') {
  if (rawScreen === undefined || rawScreen === null || rawScreen === '') {
    return SLEEP_SCREENS.SNAPSHOT;
  }
  if (rawScreen === false) {
    return SLEEP_SCREENS.BLACK;
  }

  const token = String(rawScreen).toLowerCase().trim();
  switch (token) {
    case SLEEP_SCREENS.SNAPSHOT:
      return SLEEP_SCREENS.SNAPSHOT;
    case SLEEP_SCREENS.SLATE:
      return SLEEP_SCREENS.SLATE;
    case SLEEP_SCREENS.BLACK:
      return SLEEP_SCREENS.BLACK;
    default:
      log.warn(scope, 'unknown sleep_screen "' + rawScreen + '", defaulting to "snapshot"');
      return SLEEP_SCREENS.SNAPSHOT;
  }
}

/**
 * Loads and validates the configuration object from BRIDGE_CONFIG, CONFIG_PATH,
 * /config/config.json, or falls back to an in-memory default test configuration.
 * On startup validation or parse errors, logs a clean structured [ERROR] line and exits(1).
 *
 * @returns {Record<string, *>}
 */
function loadConfig() {
  initLogger(process.env.LOG_LEVEL || 'info');
  const explicitPath = process.env.BRIDGE_CONFIG || process.env.CONFIG_PATH;
  const defaultPath = '/config/config.json';
  const targetPath = explicitPath || (fs.existsSync(defaultPath) ? defaultPath : '');
  try {
    const parsed = targetPath
        ? JSON.parse(fs.readFileSync(targetPath, 'utf8'))
        : {
            eufy_security_ws_url: 'ws://eufy-security-ws:3000',
            frigate_url: 'http://frigate:5000',
            cameras: [{serial: 'T8161T0000000000', mode: 'rtsp'}],
          };
    validateConfig(parsed);
    return parsed;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log.error('bridge', 'startup configuration error: ' + msg);
    process.exit(1);
  }
}

const rawLoadedCfg = loadConfig();

const ACTIVE_LOG_LEVEL_NAME = initLogger(process.env.LOG_LEVEL || rawLoadedCfg.log_level || 'info');

// Stream timing and arbitration limits (in milliseconds).
const MAX_MS = clampNum(rawLoadedCfg.stream_max_secs, 10, 86400, 900) * MS_PER_SECOND;
const VIEW_MAX_MS = clampNum(rawLoadedCfg.view_max_secs, 10, 86400, 300) * MS_PER_SECOND;
const LINGER_MS = Math.min(VIEW_MAX_MS, clampNum(rawLoadedCfg.view_linger_secs, 5, 86400, 20) * MS_PER_SECOND);
const COOLDOWN_MS = clampNum(rawLoadedCfg.view_cooldown_secs, 0, 3600, 5) * MS_PER_SECOND;
const SNAP_DELAY_MS = clampNum(rawLoadedCfg.snapshot_capture_delay_secs, 0, 60, 3) * MS_PER_SECOND;

// Doorbell, HomeBase 3 face recognition, RTSP, backfill, mask sync, and aspect ratio options.
const RING_LABEL = rawLoadedCfg.ring_label || 'person';
const FORWARD_FACE_NAMES = rawLoadedCfg.forward_face_names !== false;
const GLOBAL_PRESERVE_ASPECT = rawLoadedCfg.preserve_aspect_ratio !== false;
const PREEMPT_EVENT_STREAMS = rawLoadedCfg.view_has_priority !== false;
const GLOBAL_USE_RTSP = rawLoadedCfg.use_rtsp !== false;
const BACKFILL_DOWNLOADS = rawLoadedCfg.backfill_enabled !== false;
const DEFAULT_BACKFILL_DELAY_SECS = 2;
const BACKFILL_DELAY_MS = clampNum(rawLoadedCfg.backfill_delay_secs, 2, 120, DEFAULT_BACKFILL_DELAY_SECS) * MS_PER_SECOND;
const GLOBAL_AUTO_FRIGATE_MASK = rawLoadedCfg.auto_frigate_mask !== false;
const GLOBAL_CARD_SHOW_ON_LIVE = rawLoadedCfg.card_show_on_live !== false;
const INSTANT_EVENT_SNAPSHOT = rawLoadedCfg.instant_event_snapshot !== false;

// Smart battery conservation, periodic telemetry refresh, and startup snapshot probe options.
const EARLY_SLEEP_MS = clampNum(rawLoadedCfg.idle_timeout_secs, 0, 3600, 0) * MS_PER_SECOND;
const LOW_BAT_THRESHOLD = clampNum(rawLoadedCfg.low_battery_threshold, 0, 100, 20);
const LOW_BAT_HOLD_MS = clampNum(rawLoadedCfg.low_battery_hold_secs, 5, 3600, 20) * MS_PER_SECOND;
const LOW_BAT_WAKE_ON_VIEW = Boolean(rawLoadedCfg.low_battery_wake_on_view ?? false);
const DEFAULT_TRACK_STUCK_SPOTLIGHT = false;
const TRACK_STUCK_SPOTLIGHT = Boolean(rawLoadedCfg.track_stuck_spotlight ?? DEFAULT_TRACK_STUCK_SPOTLIGHT);
const ENFORCE_QUALITY = rawLoadedCfg.enforce_streaming_quality ?? true;
const TELEMETRY_POLL_MS = clampNum(rawLoadedCfg.telemetry_poll_secs, 0, 86400, 300) * MS_PER_SECOND;
const HTTP_PORT = clampNum(rawLoadedCfg.http_port ?? process.env.HTTP_PORT, 0, 65535, 8080);
const GLOBAL_STARTUP_SNAPSHOT = rawLoadedCfg.startup_snapshot !== undefined ? rawLoadedCfg.startup_snapshot : true;

/**
 * Normalizes the requested hardware acceleration mode from config.json.
 *
 * @param {*} rawHwaccel - Raw hwaccel value from config.json.
 * @returns {string}
 */
function parseHwaccelMode(rawHwaccel) {
  if (rawHwaccel === true) {
    return HWACCEL_MODES.VAAPI;
  }
  if (typeof rawHwaccel !== 'string') {
    return HWACCEL_MODES.NONE;
  }
  const normalized = rawHwaccel.toLowerCase().trim();
  return SUPPORTED_HWACCEL_MODES.has(normalized) ? normalized : HWACCEL_MODES.NONE;
}

const HWACCEL_MODE = parseHwaccelMode(rawLoadedCfg.hwaccel);
const HWACCEL_DEVICE = rawLoadedCfg.hwaccel_device || '/dev/dri/renderD128';

/**
 * Resolves live_fps and idle_fps with defensive non-contradiction clamping (idleFps <= liveFps).
 *
 * @param {Record<string, *>} [rawCfg=rawLoadedCfg] - Raw configuration object.
 * @returns {{ liveFps: number, idleFps: number }}
 */
function resolveFrameRates(rawCfg = rawLoadedCfg) {
  const liveFps = clampNum(rawCfg.live_fps, 5, 60, 15);
  const rawIdleFps = clampNum(rawCfg.idle_fps, 1, 30, 5);
  if (rawIdleFps > liveFps) {
    log.warn(
        'bridge',
        'idle_fps (' + rawIdleFps + ') exceeds live_fps (' + liveFps + '), clamping idle_fps to ' + liveFps
    );
  }
  return Object.freeze({liveFps, idleFps: Math.min(liveFps, rawIdleFps)});
}

// Video dimensions (enforced even for YUV420p) and raw frame size in bytes (1.5 bytes per pixel).
const W = clampNum(rawLoadedCfg.width, 320, 3840, 1280) & ~1;
const H = clampNum(rawLoadedCfg.height, 240, 2160, 720) & ~1;
const FRAME = (W * H * 3) / 2;
const {liveFps: LIVE_FPS, idleFps: IDLE_FPS} = resolveFrameRates(rawLoadedCfg);

// Audio configuration: 16 kHz, 16-bit signed little-endian mono PCM sent in 100 ms chunks.
const AUDIO = rawLoadedCfg.audio !== false;
const RATE = 16000;
const AUDIO_TICK = 100;
const AUDIO_CHUNK = (RATE * 2 * AUDIO_TICK) / MS_PER_SECOND;
const SILENCE = Buffer.alloc(AUDIO_CHUNK);

// Mapping of Eufy event keywords to Frigate event labels.
/** @type {Array<[string, string]>} */
const LABELS = [
  ['person', 'person'],
  ['loitering', 'person'],
  ['ring', RING_LABEL],
  ['package', 'package'],
  ['vehicle', 'car'],
  ['dog', 'dog'],
  ['pet', 'dog'],
];

const TRIGGERS = buildTriggerSet(rawLoadedCfg.trigger_events);

/**
 * Resolves a writable directory for storing cached camera snapshots across restarts.
 *
 * @param {string} [preferredDir] - Preferred cache directory path.
 * @returns {string} Writable directory path for snapshot cache files.
 */
function resolveCacheDir(preferredDir = rawLoadedCfg.cache_dir) {
  const preferred = preferredDir || '/config/cache';
  try {
    fs.mkdirSync(preferred, {recursive: true});
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch (err) {
    log.warn('bridge', 'cache directory "' + preferred + '" is not writable, falling back to /tmp');
    return '/tmp';
  }
}

const CACHE_DIR = resolveCacheDir();

/**
 * Verifies whether the configured hardware acceleration mode and device node are usable.
 *
 * @param {string} [hwMode=HWACCEL_MODE] - Parsed hwaccel mode.
 * @param {string} [hwDevice=HWACCEL_DEVICE] - Device node path.
 * @returns {string} Validated hwaccel mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m') or '' for software.
 */
function resolveHwaccel(hwMode = HWACCEL_MODE, hwDevice = HWACCEL_DEVICE) {
  if (!hwMode) {
    return HWACCEL_MODES.NONE;
  }
  const requiresRenderDevice = hwMode === HWACCEL_MODES.VAAPI || hwMode === HWACCEL_MODES.QSV;
  if (requiresRenderDevice && !fs.existsSync(hwDevice)) {
    log.warn(
        'bridge',
        'hwaccel "' +
        hwMode +
        '" requested, but ' +
        hwDevice +
        ' is not accessible; falling back to software libx264'
    );
    return HWACCEL_MODES.NONE;
  }
  return hwMode;
}

const ACTIVE_HWACCEL = resolveHwaccel();

/**
 * Resolves a boolean flag from a telemetry config block (boolean or object).
 *
 * @param {boolean|Record<string, *>|undefined} block - Telemetry config block.
 * @param {boolean} fallback - Default value when undefined.
 * @returns {boolean}
 */
function isTelemetryBlockEnabled(block, fallback) {
  return block === undefined
      ? fallback
      : typeof block === 'boolean'
          ? block
          : block.enabled !== false;
}

/**
 * Resolves the effective telemetry configuration for a camera by merging global cfg.telemetry
 * settings with any per-camera camConfig.telemetry overrides.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {Record<string, *>} [baseCfg=rawLoadedCfg] - Global configuration object.
 * @returns {Record<string, boolean>} Normalized telemetry options object.
 */
function resolveTelemetryConfig(camConfig = {}, baseCfg = rawLoadedCfg) {
  if (camConfig && camConfig.telemetryConfig && Object.isFrozen(camConfig.telemetryConfig)) {
    return camConfig.telemetryConfig;
  }
  const globalCfg = baseCfg.telemetry;
  const camCfg = camConfig.telemetry;

  const globalEnabled = isTelemetryBlockEnabled(globalCfg, true);
  const camEnabled = isTelemetryBlockEnabled(camCfg, globalEnabled);

  const pickOption = (key) =>
    camCfg && typeof camCfg === 'object' && key in camCfg
        ? Boolean(camCfg[key])
        : globalCfg && typeof globalCfg === 'object' && key in globalCfg
            ? Boolean(globalCfg[key])
            : true;

  return Object.freeze({
    enabled: camEnabled,
    battery: camEnabled && pickOption('battery'),
    powerSource: camEnabled && pickOption('power_source'),
    wifi: camEnabled && pickOption('wifi'),
    rssi: camEnabled && pickOption('rssi'),
    temperature: camEnabled && pickOption('temperature'),
    lastSeen: camEnabled && pickOption('last_seen'),
  });
}

/**
 * Resolves the effective status card theme, position, and sleeping screen backdrop for a camera.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {Record<string, *>} [baseCfg=rawLoadedCfg] - Global configuration object.
 * @returns {{ theme: 'icons'|'minimal'|'detailed'|'debug'|'none', position: 'center'|'top-left'|'top-right'|'bottom-left'|'bottom-right', sleepScreen: 'snapshot'|'slate'|'black' }}
 */
function resolveCardConfig(camConfig = {}, baseCfg = rawLoadedCfg) {
  if (camConfig && camConfig.cardConfig && Object.isFrozen(camConfig.cardConfig)) {
    return camConfig.cardConfig;
  }
  const scope = CameraConfig.resolveScopeName(camConfig);
  const rawTheme = camConfig.card_theme ?? baseCfg.card_theme ?? CARD_THEMES.ICONS;
  const rawPos = camConfig.card_position ?? baseCfg.card_position ?? CARD_POSITIONS.BOTTOM_LEFT;
  const rawScreen = camConfig.sleep_screen ?? baseCfg.sleep_screen ?? SLEEP_SCREENS.SNAPSHOT;

  const position = normalizeCardPosition(rawPos, scope);
  const theme = normalizeCardTheme(rawTheme, scope);
  const sleepScreen = normalizeSleepScreen(rawScreen, scope);

  return Object.freeze({theme, position, sleepScreen});
}

// Per-camera timer and Eufy hardware Power Manager property bounds.
const MIN_HOLD_SECS = 5;
const MAX_HOLD_SECS = 86400;
const DEFAULT_HOLD_SECS = 60;
const DEFAULT_BACKFILL_HOLD_SECS = 30;
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
const MIN_LOW_BAT_THRESHOLD_PCT = 0;
const MAX_LOW_BAT_THRESHOLD_PCT = 100;
const DEFAULT_LOW_BAT_THRESHOLD_PCT = 20;
const MIN_LOW_BAT_HOLD_SECS = 5;
const MAX_LOW_BAT_HOLD_SECS = 3600;
const DEFAULT_LOW_BAT_HOLD_SECS = 20;
const MIN_POWER_WORKING_MODE = POWER_WORKING_MODES.BATTERY_SAVER;
const MAX_POWER_WORKING_MODE = POWER_WORKING_MODES.CUSTOMIZE_RECORDING;
const OPTIMAL_BATTERY_MAX_CLIP_SECS = 20;
const MIN_RECORDING_CLIP_SECS = 5;
const MAX_RECORDING_CLIP_SECS = 120;
const MIN_RETRIGGER_INTERVAL_SECS = 0;
const MAX_RETRIGGER_INTERVAL_SECS = 60;
const DEFAULT_RETRIGGER_INTERVAL_SECS = 5;

/**
 * Resolves the normalized Set of Eufy trigger events that wake a specific camera,
 * falling back to the global TRIGGERS set when per-camera trigger_events is omitted.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {Set<string>} [globalTriggers=TRIGGERS] - Fallback global trigger set.
 * @returns {Set<string>}
 */
function resolveCameraTriggers(camConfig = {}, globalTriggers = TRIGGERS) {
  if (camConfig && camConfig.triggers instanceof Set) {
    return camConfig.triggers;
  }
  if (Array.isArray(camConfig.trigger_events) && camConfig.trigger_events.length > 0) {
    return buildTriggerSet(camConfig.trigger_events);
  }
  return globalTriggers;
}

/**
 * Resolves the normalized streaming mode ('auto', 'rtsp', 'p2p', 'backfill', or 'custom') for a camera.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @returns {'auto'|'rtsp'|'p2p'|'backfill'|'custom'}
 */
function resolveCameraMode(camConfig = {}) {
  const scope = CameraConfig.resolveScopeName(camConfig);
  if (camConfig.mode === undefined || camConfig.mode === null || camConfig.mode === '') {
    return CAMERA_MODES.AUTO;
  }
  const token = String(camConfig.mode).toLowerCase().trim();
  switch (token) {
    case CAMERA_MODES.AUTO:
      return CAMERA_MODES.AUTO;
    case CAMERA_MODES.RTSP:
      return CAMERA_MODES.RTSP;
    case CAMERA_MODES.P2P:
      return CAMERA_MODES.P2P;
    case CAMERA_MODES.BACKFILL:
      return CAMERA_MODES.BACKFILL;
    case CAMERA_MODES.CUSTOM:
      return CAMERA_MODES.CUSTOM;
    default:
      log.warn(scope, 'unknown camera mode "' + camConfig.mode + '", defaulting to "auto"');
      return CAMERA_MODES.AUTO;
  }
}

/**
 * Resolves per-camera stream timing and mode settings with mode-aware defaults and
 * defensive non-contradiction clamping.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {Record<string, *>} [baseCfg=rawLoadedCfg] - Global configuration object.
 * @returns {{
 *   mode: 'auto'|'rtsp'|'p2p'|'backfill'|'custom',
 *   useRtsp: boolean,
 *   alwaysBackfill: boolean,
 *   backfillDownloads: boolean,
 *   maxMs: number,
 *   viewMaxMs: number,
 *   holdMs: number,
 *   lingerMs: number,
 *   eventSecs: number,
 *   earlySleepMs: number,
 *   lowBatThreshold: number,
 *   lowBatHoldMs: number,
 *   lowBatWakeOnView: boolean,
 *   letEufyDecideEnd: boolean
 * }}
 */
function resolveCameraTimers(camConfig = {}, baseCfg = rawLoadedCfg) {
  if (camConfig && camConfig.timers && Object.isFrozen(camConfig.timers)) {
    return camConfig.timers;
  }
  const scope = CameraConfig.resolveScopeName(camConfig);
  const mode = resolveCameraMode(camConfig);
  const alwaysBackfill =
      mode === CAMERA_MODES.BACKFILL ||
      (mode === CAMERA_MODES.CUSTOM && Boolean(camConfig.backfill_only ?? baseCfg.backfill_only));

  const globalUseRtsp = baseCfg.use_rtsp !== undefined ? baseCfg.use_rtsp !== false : GLOBAL_USE_RTSP;
  const useRtsp =
      mode === CAMERA_MODES.RTSP ||
      Boolean(camConfig.homebase_rtsp_url) ||
      ((mode === CAMERA_MODES.AUTO ||
        mode === CAMERA_MODES.BACKFILL ||
        mode === CAMERA_MODES.CUSTOM) &&
        (camConfig.use_rtsp !== undefined ? Boolean(camConfig.use_rtsp) : globalUseRtsp));

  const globalBackfillDownloads =
      baseCfg.backfill_enabled !== undefined ? baseCfg.backfill_enabled !== false : BACKFILL_DOWNLOADS;
  const rawBackfillDownloads =
      camConfig.backfill_enabled !== undefined
          ? Boolean(camConfig.backfill_enabled)
          : globalBackfillDownloads;
  if (alwaysBackfill && !rawBackfillDownloads) {
    log.warn(
        scope,
        'cannot disable backfill_enabled in backfill-only mode; keeping backfill_enabled=true'
    );
  }
  const backfillDownloads = alwaysBackfill ? true : rawBackfillDownloads;

  const defaultHoldSecs = alwaysBackfill ? DEFAULT_BACKFILL_HOLD_SECS : DEFAULT_HOLD_SECS;
  const rawHoldSecs = camConfig.hold_secs ?? baseCfg.hold_secs;
  const holdSecs =
      rawHoldSecs !== undefined
          ? clampNum(rawHoldSecs, MIN_HOLD_SECS, MAX_HOLD_SECS, defaultHoldSecs)
          : defaultHoldSecs;
  const holdMs = holdSecs * MS_PER_SECOND;

  const rawMaxMs =
      camConfig.stream_max_secs !== undefined
          ? clampNum(camConfig.stream_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_MAX_SECS) * MS_PER_SECOND
          : MAX_MS;
  if (rawMaxMs < holdMs) {
    log.warn(
        scope,
        'stream_max_secs (' +
        Math.round(rawMaxMs / MS_PER_SECOND) +
        's) is shorter than hold_secs (' +
        holdSecs +
        's), raising stream_max_secs to ' +
        holdSecs +
        's'
    );
  }
  const maxMs = Math.max(holdMs, rawMaxMs);

  const rawLingerMs =
      camConfig.view_linger_secs !== undefined
          ? clampNum(camConfig.view_linger_secs, MIN_HOLD_SECS, MAX_HOLD_SECS, DEFAULT_LINGER_SECS) * MS_PER_SECOND
          : LINGER_MS;
  const rawViewMaxMs =
      camConfig.view_max_secs !== undefined
          ? clampNum(camConfig.view_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_VIEW_MAX_SECS) * MS_PER_SECOND
          : VIEW_MAX_MS;
  if (rawViewMaxMs < rawLingerMs) {
    log.warn(
        scope,
        'view_max_secs (' +
        Math.round(rawViewMaxMs / MS_PER_SECOND) +
        's) is shorter than view_linger_secs (' +
        Math.round(rawLingerMs / MS_PER_SECOND) +
        's), raising view_max_secs to ' +
        Math.round(rawLingerMs / MS_PER_SECOND) +
        's'
    );
  }
  const viewMaxMs = Math.max(rawLingerMs, rawViewMaxMs);
  const lingerMs = Math.min(viewMaxMs, rawLingerMs);

  const rawEventSecs = camConfig.frigate_event_secs ?? baseCfg.frigate_event_secs;
  const eventSecs =
      rawEventSecs !== undefined
          ? clampNum(rawEventSecs, MIN_EVENT_SECS, MAX_EVENT_SECS, holdSecs)
          : clampNum(holdSecs, MIN_EVENT_SECS, MAX_EVENT_SECS, defaultHoldSecs);

  const earlySleepMs =
      camConfig.idle_timeout_secs !== undefined
          ? clampNum(camConfig.idle_timeout_secs, MIN_EARLY_SLEEP_SECS, MAX_EARLY_SLEEP_SECS, DEFAULT_EARLY_SLEEP_SECS) * MS_PER_SECOND
          : EARLY_SLEEP_MS;
  const lowBatThreshold =
      camConfig.low_battery_threshold !== undefined
          ? clampNum(
              camConfig.low_battery_threshold,
              MIN_LOW_BAT_THRESHOLD_PCT,
              MAX_LOW_BAT_THRESHOLD_PCT,
              DEFAULT_LOW_BAT_THRESHOLD_PCT
          )
          : LOW_BAT_THRESHOLD;
  const rawLowBatHoldMs =
      camConfig.low_battery_hold_secs !== undefined
          ? clampNum(camConfig.low_battery_hold_secs, MIN_LOW_BAT_HOLD_SECS, MAX_LOW_BAT_HOLD_SECS, DEFAULT_LOW_BAT_HOLD_SECS) * MS_PER_SECOND
          : LOW_BAT_HOLD_MS;
  if (camConfig.low_battery_hold_secs !== undefined && rawLowBatHoldMs > holdMs) {
    log.warn(
        scope,
        'low_battery_hold_secs (' +
        Math.round(rawLowBatHoldMs / MS_PER_SECOND) +
        's) exceeds hold_secs (' +
        holdSecs +
        's), clamping low_battery_hold_secs to ' +
        holdSecs +
        's'
    );
  }
  const lowBatHoldMs = Math.min(holdMs, rawLowBatHoldMs);
  const lowBatWakeOnView =
      camConfig.low_battery_wake_on_view !== undefined
          ? Boolean(camConfig.low_battery_wake_on_view)
          : LOW_BAT_WAKE_ON_VIEW;

  const rawEndEarly =
      camConfig.end_early ??
      (mode === CAMERA_MODES.CUSTOM ? camConfig.recording_end_early : undefined) ??
      baseCfg.end_early;
  const letEufyDecideEnd =
      rawEndEarly !== undefined ? Boolean(rawEndEarly) : alwaysBackfill;

  return Object.freeze({
    mode,
    useRtsp,
    alwaysBackfill,
    backfillDownloads,
    maxMs,
    viewMaxMs,
    holdMs,
    lingerMs,
    eventSecs,
    earlySleepMs,
    lowBatThreshold,
    lowBatHoldMs,
    lowBatWakeOnView,
    letEufyDecideEnd,
  });
}

/**
 * Resolves per-camera Eufy hardware Power Manager settings, automatically deriving
 * clip length and early-end behavior from the camera's resolved hold_secs and end_early
 * with defensive validation against contradictory overrides.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {ReturnType<typeof resolveCameraTimers>|null} [resolvedTimers=null] - Pre-resolved camera timers, if available.
 * @param {Record<string, *>} [baseCfg=rawLoadedCfg] - Global configuration object.
 * @returns {{
 *   enforceQuality: boolean|number,
 *   powerWorkingMode: number|null,
 *   recordingClipLength: number|null,
 *   recordingEndClipMotionStops: boolean|null,
 *   recordingRetriggerInterval: number|null
 * }}
 */
function resolveHardwareRecordingConfig(camConfig = {}, resolvedTimers = null, baseCfg = rawLoadedCfg) {
  if (camConfig && camConfig.hwRecordingConfig && Object.isFrozen(camConfig.hwRecordingConfig)) {
    return camConfig.hwRecordingConfig;
  }
  const scope = CameraConfig.resolveScopeName(camConfig);
  const enforceQuality =
      camConfig.enforce_streaming_quality !== undefined
          ? camConfig.enforce_streaming_quality
          : ENFORCE_QUALITY;

  const syncPower = camConfig.sync_power ?? baseCfg.sync_power ?? true;
  if (syncPower === false) {
    return Object.freeze({
      enforceQuality,
      powerWorkingMode: null,
      recordingClipLength: null,
      recordingEndClipMotionStops: null,
      recordingRetriggerInterval: null,
    });
  }

  const timers = resolvedTimers || resolveCameraTimers(camConfig, baseCfg);
  const defaultClipSecs = clampNum(
      Math.round(timers.holdMs / MS_PER_SECOND),
      MIN_RECORDING_CLIP_SECS,
      MAX_RECORDING_CLIP_SECS,
      DEFAULT_HOLD_SECS
  );

  const explicitClipLen = camConfig.recording_clip_length ?? baseCfg.recording_clip_length;
  const explicitEndEarly = camConfig.recording_end_early ?? baseCfg.recording_end_early;
  const explicitRetrigger = camConfig.recording_retrigger_interval ?? baseCfg.recording_retrigger_interval;
  const hasExplicitClipCfg =
      explicitClipLen !== undefined ||
      explicitEndEarly !== undefined ||
      explicitRetrigger !== undefined;

  const rawPowerMode = camConfig.power_working_mode ?? baseCfg.power_working_mode;
  let powerWorkingMode =
      rawPowerMode !== undefined && rawPowerMode !== null && !Number.isNaN(Number(rawPowerMode))
          ? clampNum(
              Math.round(Number(rawPowerMode)),
              MIN_POWER_WORKING_MODE,
              MAX_POWER_WORKING_MODE,
              MAX_POWER_WORKING_MODE
          )
          : MAX_POWER_WORKING_MODE;

  if (powerWorkingMode < MAX_POWER_WORKING_MODE) {
    if (hasExplicitClipCfg) {
      log.warn(
          scope,
          'power_working_mode=' +
          powerWorkingMode +
          ' ignores custom clip settings on Eufy firmware; promoting power_working_mode to 2 (Customize Recording)'
      );
      powerWorkingMode = MAX_POWER_WORKING_MODE;
    } else if (
        powerWorkingMode === MIN_POWER_WORKING_MODE &&
        (defaultClipSecs > OPTIMAL_BATTERY_MAX_CLIP_SECS || !timers.letEufyDecideEnd)
    ) {
      log.warn(
          scope,
          'power_working_mode=0 (Optimal Battery Life) hardcodes 20s early-ending clips on Eufy firmware, which conflicts with hold_secs=' +
          defaultClipSecs +
          's / end_early=' +
          timers.letEufyDecideEnd +
          '; promoting power_working_mode to 2 (Customize Recording)'
      );
      powerWorkingMode = MAX_POWER_WORKING_MODE;
    } else {
      return Object.freeze({
        enforceQuality,
        powerWorkingMode,
        recordingClipLength: null,
        recordingEndClipMotionStops: null,
        recordingRetriggerInterval: null,
      });
    }
  }

  const recordingEndClipMotionStops =
      explicitEndEarly !== undefined && explicitEndEarly !== null
          ? Boolean(explicitEndEarly)
          : timers.letEufyDecideEnd;

  let recordingClipLength = clampNum(
      Math.round(Number(explicitClipLen ?? defaultClipSecs)),
      MIN_RECORDING_CLIP_SECS,
      MAX_RECORDING_CLIP_SECS,
      defaultClipSecs
  );
  if (!recordingEndClipMotionStops && explicitClipLen !== undefined && recordingClipLength < defaultClipSecs) {
    log.warn(
        scope,
        'recording_clip_length (' +
        recordingClipLength +
        's) is shorter than hold_secs (' +
        defaultClipSecs +
        's) with end_early=false; raising recording_clip_length to ' +
        defaultClipSecs +
        's to prevent mid-hold stream drops'
    );
    recordingClipLength = defaultClipSecs;
  }

  const recordingRetriggerInterval = clampNum(
      Math.round(Number(explicitRetrigger ?? DEFAULT_RETRIGGER_INTERVAL_SECS)),
      MIN_RETRIGGER_INTERVAL_SECS,
      MAX_RETRIGGER_INTERVAL_SECS,
      DEFAULT_RETRIGGER_INTERVAL_SECS
  );

  return Object.freeze({
    enforceQuality,
    powerWorkingMode,
    recordingClipLength,
    recordingEndClipMotionStops,
    recordingRetriggerInterval,
  });
}

/**
 * Builds and freezes a normalized per-camera CameraConfig value object once, composing
 * frozen timers, triggers, cardConfig, telemetryConfig, and hwRecordingConfig sub-objects.
 * If camConfig was already built and frozen, returns it directly without re-running resolvers.
 *
 * @param {Record<string, *>} [camConfig={}] - Raw or pre-built camera configuration object.
 * @param {Record<string, *>} [baseCfg=rawLoadedCfg] - Global configuration object.
 * @returns {Readonly<CameraConfig & Record<string, *>>}
 */
function resolveCameraConfig(camConfig = {}, baseCfg = rawLoadedCfg) {
  if (CameraConfig.isResolved(camConfig)) {
    return /** @type {Readonly<CameraConfig & Record<string, *>>} */ (camConfig);
  }
  const {serial, name} = CameraConfig.normalizeIdentity(camConfig);
  const title = camConfig.title ? String(camConfig.title) : '';
  const stationSerial = camConfig.station_serial ? String(camConfig.station_serial) : '';
  const rtspUrl = camConfig.homebase_rtsp_url ? String(camConfig.homebase_rtsp_url) : '';
  /** @type {Record<string, *>} */
  const normalizedCam = {...camConfig, serial, name, title, station_serial: stationSerial, homebase_rtsp_url: rtspUrl};

  const timers = resolveCameraTimers(normalizedCam, baseCfg);
  const triggers = resolveCameraTriggers(
      normalizedCam,
      baseCfg.triggers instanceof Set ? baseCfg.triggers : TRIGGERS
  );
  const cardConfig = resolveCardConfig(normalizedCam, baseCfg);
  const telemetryConfig = resolveTelemetryConfig(normalizedCam, baseCfg);
  const hwRecordingConfig = resolveHardwareRecordingConfig(normalizedCam, timers, baseCfg);

  return Object.freeze(
      new CameraConfig({
        ...normalizedCam,
        priority: clampNum(
            normalizedCam.priority,
            MIN_CAMERA_PRIORITY,
            MAX_CAMERA_PRIORITY,
            DEFAULT_CAMERA_PRIORITY
        ),
        preserveAspect: Boolean(
            normalizedCam.preserve_aspect_ratio ?? baseCfg.preserve_aspect_ratio ?? GLOBAL_PRESERVE_ASPECT
        ),
        autoFrigateMask: Boolean(
            normalizedCam.auto_frigate_mask ?? baseCfg.auto_frigate_mask ?? GLOBAL_AUTO_FRIGATE_MASK
        ),
        cardShowOnLive: Boolean(
            normalizedCam.card_show_on_live ?? baseCfg.card_show_on_live ?? GLOBAL_CARD_SHOW_ON_LIVE
        ),
        trackStuckSpotlight: Boolean(
            normalizedCam.track_stuck_spotlight ?? baseCfg.track_stuck_spotlight ?? TRACK_STUCK_SPOTLIGHT
        ),
        startupSnapshot:
            normalizedCam.startup_snapshot ?? baseCfg.startup_snapshot ?? GLOBAL_STARTUP_SNAPSHOT,
        timers,
        triggers,
        cardConfig,
        telemetryConfig,
        hwRecordingConfig,
      })
  );
}

/**
 * Fluent builder that constructs a deeply frozen immutable bridge configuration instance once
 * so all domain, media, overlay, and service modules reuse the same immutable configuration.
 */
class BridgeConfigBuilder {
  /**
   * @param {Record<string, *>} rawCfg - Raw parsed configuration object.
   */
  constructor(rawCfg) {
    const cloned = {
      ...rawCfg,
      cameras: Array.isArray(rawCfg.cameras) ? rawCfg.cameras.map((c) => ({...c})) : [],
    };
    validateConfig(cloned);
    /** @type {Record<string, *>} */
    this._raw = cloned;
    /** @type {Record<string, *>} */
    this._built = {...cloned};
    this._hasEndpoints = false;
    this._hasVideoAndAudio = false;
    this._hasTimers = false;
    this._hasEventsAndOverlays = false;
    this._hasCameras = false;
  }

  /**
   * Resolves and normalizes network endpoints and HTTP server settings.
   *
   * @returns {this}
   */
  withEndpoints() {
    const frigateUrl = normalizeBaseHttpUrl(this._raw.frigate_url);
    const go2rtcUrl = this._raw.go2rtc_url
        ? normalizeBaseHttpUrl(this._raw.go2rtc_url)
        : deriveGo2rtcUrl(frigateUrl);
    const rtspOutputUrl = normalizeRtspOutputUrl(
        this._raw.rtsp_output_url,
        go2rtcUrl,
        frigateUrl
    );
    this._built.eufy_security_ws_url = String(this._raw.eufy_security_ws_url).trim();
    this._built.frigate_url = frigateUrl;
    this._built.go2rtc_url = go2rtcUrl;
    this._built.rtsp_output_url = rtspOutputUrl;
    this._built.ha_webhook_url = this._raw.ha_webhook_url ? String(this._raw.ha_webhook_url).trim() : '';
    this._built.http_port = clampNum(
        this._raw.http_port ?? process.env.HTTP_PORT,
        0,
        65535,
        8080
    );
    this._hasEndpoints = true;
    return this;
  }

  /**
   * Resolves video dimensions, frame rates, audio parameters, and hardware acceleration.
   *
   * @returns {this}
   */
  withVideoAndAudio() {
    const width = clampNum(this._raw.width, 320, 3840, 1280) & ~1;
    const height = clampNum(this._raw.height, 240, 2160, 720) & ~1;
    const {liveFps, idleFps} = resolveFrameRates(this._raw);
    const hwMode = parseHwaccelMode(this._raw.hwaccel);
    const hwDevice = this._raw.hwaccel_device || '/dev/dri/renderD128';
    const activeHwaccel = resolveHwaccel(hwMode, hwDevice);

    this._built.width = width;
    this._built.height = height;
    this._built.frameBytes = (width * height * 3) / 2;
    this._built.live_fps = liveFps;
    this._built.idle_fps = idleFps;
    this._built.audio = this._raw.audio !== false;
    this._built.preserve_aspect_ratio = this._raw.preserve_aspect_ratio !== false;
    this._built.hwaccel_device = hwDevice;
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
    const maxMs = clampNum(this._raw.stream_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_MAX_SECS) * MS_PER_SECOND;
    const viewMaxMs = clampNum(this._raw.view_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_VIEW_MAX_SECS) * MS_PER_SECOND;
    const lingerMs = Math.min(viewMaxMs, clampNum(this._raw.view_linger_secs, MIN_HOLD_SECS, MAX_HOLD_SECS, DEFAULT_LINGER_SECS) * MS_PER_SECOND);
    const cooldownMs = clampNum(this._raw.view_cooldown_secs, 0, MAX_EVENT_SECS, 5) * MS_PER_SECOND;
    const snapDelayMs = clampNum(this._raw.snapshot_capture_delay_secs, 0, MAX_RETRIGGER_INTERVAL_SECS, 3) * MS_PER_SECOND;

    this._built.maxMs = maxMs;
    this._built.viewMaxMs = viewMaxMs;
    this._built.lingerMs = lingerMs;
    this._built.cooldownMs = cooldownMs;
    this._built.snapDelayMs = snapDelayMs;
    this._built.view_has_priority = this._raw.view_has_priority !== false;
    this._built.use_rtsp = this._raw.use_rtsp !== false;
    this._built.backfill_enabled = this._raw.backfill_enabled !== false;
    this._built.backfillDelayMs = clampNum(this._raw.backfill_delay_secs, 2, MAX_RECORDING_CLIP_SECS, DEFAULT_BACKFILL_DELAY_SECS) * MS_PER_SECOND;
    this._built.instant_event_snapshot = this._raw.instant_event_snapshot !== false;
    this._built.earlySleepMs = clampNum(this._raw.idle_timeout_secs, MIN_EARLY_SLEEP_SECS, MAX_EARLY_SLEEP_SECS, DEFAULT_EARLY_SLEEP_SECS) * MS_PER_SECOND;
    this._built.low_battery_threshold = clampNum(this._raw.low_battery_threshold, MIN_LOW_BAT_THRESHOLD_PCT, MAX_LOW_BAT_THRESHOLD_PCT, DEFAULT_LOW_BAT_THRESHOLD_PCT);
    this._built.lowBatHoldMs = clampNum(this._raw.low_battery_hold_secs, MIN_LOW_BAT_HOLD_SECS, MAX_LOW_BAT_HOLD_SECS, DEFAULT_LOW_BAT_HOLD_SECS) * MS_PER_SECOND;
    this._built.low_battery_wake_on_view = Boolean(this._raw.low_battery_wake_on_view ?? false);
    this._built.track_stuck_spotlight = Boolean(this._raw.track_stuck_spotlight ?? DEFAULT_TRACK_STUCK_SPOTLIGHT);
    this._built.enforce_streaming_quality = this._raw.enforce_streaming_quality ?? true;
    this._built.telemetryPollMs = clampNum(this._raw.telemetry_poll_secs, 0, MAX_HOLD_SECS, DEFAULT_VIEW_MAX_SECS) * MS_PER_SECOND;
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
    this._built.ring_label = this._raw.ring_label || 'person';
    this._built.forward_face_names = this._raw.forward_face_names !== false;
    this._built.auto_frigate_mask = this._raw.auto_frigate_mask !== false;
    this._built.card_show_on_live = this._raw.card_show_on_live !== false;
    this._built.triggers = buildTriggerSet(this._raw.trigger_events);
    this._built.event_priorities =
        this._raw.event_priorities && typeof this._raw.event_priorities === 'object'
            ? Object.freeze({...this._raw.event_priorities})
            : null;
    this._built.cache_dir = resolveCacheDir(this._raw.cache_dir);
    this._hasEventsAndOverlays = true;
    return this;
  }

  /**
   * Builds and freezes each configured camera's normalized configuration slice once.
   *
   * @returns {this}
   */
  withCameras() {
    if (!this._hasEventsAndOverlays) {
      this.withEventsAndOverlays();
    }
    this._built.cameras = Object.freeze(
        this._raw.cameras.map((cam) => resolveCameraConfig(cam, this._built))
    );
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
    return Object.freeze({...this._built});
  }
}

const cfg = new BridgeConfigBuilder(rawLoadedCfg)
    .withEndpoints()
    .withVideoAndAudio()
    .withTimersAndArbitration()
    .withEventsAndOverlays()
    .withCameras()
    .build();

module.exports = {
  cfg,
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  resolveBuildInfo,
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
