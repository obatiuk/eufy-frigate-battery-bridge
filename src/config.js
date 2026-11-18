// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Configuration loading, validation, numeric clamping, and normalized option resolvers.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jsYaml = require('js-yaml');
const {log, formatErrorMessage, initLogger} = require('./logger');

const DEFAULT_FALLBACK_VERSION = '0.0.2';
const DEFAULT_FALLBACK_COMMIT = 'dev';
const DEFAULT_CACHE_DIR = '/config/cache';
const DEFAULT_HWACCEL_DEVICE = '/dev/dri/renderD128';
const DEFAULT_CONTAINER_CONFIG_PATH = '/config/config.yaml';
const DEFAULT_LOCAL_CONFIG_PATH = 'config.yaml';
const READY_MARKER_FILENAME = 'eufy-bridge-ready.pid';
const MS_PER_SECOND = 1000;
const MIN_STREAMING_QUALITY = 1;
const MAX_STREAMING_QUALITY = 10;

const DEFAULT_PACKAGE_VERSION = (() => {
  const candidatePaths = [path.resolve(__dirname, '../package.json'), path.resolve(__dirname, 'package.json')];
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
const INTEGER_PORT_REGEX = /^\d+$/;
const DEFAULT_HTTP_PROTOCOL = 'http:';
const DEFAULT_WS_PROTOCOL = 'ws:';
const RTSP_NAME_TEMPLATE_TOKEN = '{name}';
const RTSP_URL_PROTOCOL_REGEX = /^rtsps?:\/\/.+/i;
const TRAILING_SLASHES_REGEX = /\/+$/;
const TRAILING_API_PATH_REGEX = /\/api$/i;
const ENV_VAR_EXPR_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?$/;
const ENV_ESCAPED_OPEN_TOKEN = '$${';
const ENV_DOLLAR_CHAR = '$';
const ENV_DEFAULT_SEPARATOR = ':-';
const ENV_OPEN_TOKEN = '${';
const ENV_CLOSE_TOKEN = '}';
const MAX_MALFORMED_PLACEHOLDER_CHARS = 24;

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
  'sync_power',
  'track_stuck_spotlight',
  'enforce_streaming_quality',
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
const SAFE_IDENTITY_TOKEN_REGEX = /^[A-Za-z0-9._-]+$/;
const FULL_ENV_PLACEHOLDER_REGEX = /^\$\{[^}]+\}$/;
const INLINE_ENV_PLACEHOLDER_REGEX = /\$\{[^}]+\}/g;

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
  'sync_power',
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
  'power_working_mode',
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

// Shared priority bounds, keyframe burst durations, buffer limits, and async sleep helper.
const MIN_CAMERA_PRIORITY = -10000;
const MAX_CAMERA_PRIORITY = 10000;
const DEFAULT_CAMERA_PRIORITY = 0;
const KEYFRAME_BURST_MS = 1500;
const SHORT_KEYFRAME_BURST_MS = 1200;
const STDERR_TAIL_MAX_CHARS = 4096;
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

// Semantic palette used across 'glance', 'minimal', 'pebbles', and 'hud' themes:
// White = Asleep / Asleep (Low Battery) (sleep-ready) / Healthy sensor, Red = Live/Backfill, Grey = Disconnected / N/A,
// Blue = Waking / Charging (sky-blue battery fill) / Cold, Yellow = Waiting / Low-Battery / Weak Wi-Fi / Warm,
// Purple = Critical Battery / Hot, Green = HUD [S] snapshot stage badge.
const WHITE_CHANNEL = 255;
const COLOR_WHITE = Object.freeze([WHITE_CHANNEL, WHITE_CHANNEL, WHITE_CHANNEL]);
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

const EXPLICIT_SERIAL_SYM = Symbol('explicitSerial');

const URL_SCHEME_DELIM = '://';

/**
 * Strips any RFC 3986 URI `#fragment` suffix (such as go2rtc's `#backchannel=0`) after the
 * RTSP authority (`rtsp://[user:pass@]host[:port]`) without altering `#` inside credentials.
 *
 * @param {*} rawUrl - Candidate RTSP URL string.
 * @returns {string}
 */
function stripRtspUrlFragment(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  const schemeEnd = trimmed.indexOf(URL_SCHEME_DELIM);
  if (schemeEnd === -1) return trimmed;
  const authStart = schemeEnd + URL_SCHEME_DELIM.length;
  const slashIdx = trimmed.indexOf('/', authStart);
  const searchFrom = slashIdx !== -1 ? slashIdx : Math.max(authStart, trimmed.lastIndexOf('@') + 1);
  const hashIdx = trimmed.indexOf('#', searchFrom);
  return hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
}

/**
 * Returns true when a camera configuration entry explicitly specifies a non-empty direct rtsp_url.
 *
 * @param {*} camConfig - Candidate camera configuration object.
 * @returns {boolean}
 */
function hasDirectRtspUrl(camConfig) {
  return Boolean(camConfig && typeof camConfig === 'object' && String(camConfig.rtsp_url || '').trim());
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
    this.explicitSerial = String(props.explicitSerial || '');
    /** @type {string} */
    this.name = String(props.name || this.serial);
    /** @type {string} */
    this.rtsp_url = stripRtspUrlFragment(props.rtsp_url);
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
   * Returns the unique snapshot cache filename (`last_<name>.jpg` when `serial === name`,
   * or `last_<name>_<serial>.jpg` when they differ) for this camera.
   *
   * @returns {string}
   */
  getCacheFileName() {
    return CameraConfig.formatCacheFileName(this.name, this.serial);
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
   * when omitted, or deriving an internal scope serial from name when direct rtsp_url is set)
   * and returns an immutable `{ serial, name, explicitSerial }` tuple.
   *
   * @param {Record<string, *>|null|undefined} rawCam - Raw camera configuration entry.
   * @returns {Readonly<{ serial: string, name: string, explicitSerial: string }>}
   */
  static normalizeIdentity(rawCam) {
    if (!rawCam || typeof rawCam !== 'object') {
      return Object.freeze({serial: '', name: '', explicitSerial: ''});
    }
    const rawSerial = String(rawCam.serial || '').trim();
    const rawName = String(rawCam.name || '').trim();
    const explicitSerial = EXPLICIT_SERIAL_SYM in rawCam ? String(rawCam[EXPLICIT_SERIAL_SYM] || '') : rawSerial;
    const serial = rawSerial || (hasDirectRtspUrl(rawCam) ? rawName : '');
    const name = rawName || serial;
    if (serial && !Object.isFrozen(rawCam)) {
      if (!(EXPLICIT_SERIAL_SYM in rawCam)) {
        Object.defineProperty(rawCam, EXPLICIT_SERIAL_SYM, {
          value: explicitSerial,
          enumerable: false,
          configurable: true,
        });
      }
      rawCam.serial = serial;
      if (!rawCam.name) {
        rawCam.name = name;
      }
    }
    return Object.freeze({serial, name, explicitSerial});
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
   * Formats the deterministic JPEG cache filename (`last_<name>.jpg` when `serial === name`,
   * or `last_<name>_<serial>.jpg` when both differ).
   *
   * @param {string} name - Camera stream name.
   * @param {string} serial - Camera serial number.
   * @returns {string}
   */
  static formatCacheFileName(name, serial) {
    const suffix = serial && serial !== name ? name + '_' + serial : name || serial;
    return 'last_' + suffix + '.jpg';
  }

  /**
   * Resolves the deterministic JPEG cache filename (`last_<name>.jpg` when `serial === name`,
   * or `last_<name>_<serial>.jpg` when they differ) for any camera configuration or domain instance.
   *
   * @param {*} rawCam - Camera configuration or domain instance.
   * @returns {string}
   */
  static resolveCacheFileName(rawCam) {
    if (rawCam && typeof rawCam.getCacheFileName === 'function') {
      return rawCam.getCacheFileName();
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return CameraConfig.formatCacheFileName(name, serial);
  }

  /**
   * Returns the legacy duplicated cache filename (`last_<name>_<name>.jpg`) when a camera's
   * normalized serial equals its name, or an empty string when no legacy duplicate existed.
   *
   * @param {*} rawCam - Camera configuration or domain instance.
   * @returns {string}
   */
  static resolveLegacyDuplicateCacheFileName(rawCam) {
    const name =
      rawCam && typeof rawCam.getName === 'function' ? rawCam.getName() : CameraConfig.normalizeIdentity(rawCam).name;
    const serial =
      rawCam && typeof rawCam.getSerial === 'function'
        ? rawCam.getSerial()
        : CameraConfig.normalizeIdentity(rawCam).serial;
    return name && serial && serial === name ? 'last_' + name + '_' + serial + '.jpg' : '';
  }
}

/**
 * Reads a trimmed string value from an environment dictionary without accessing Object.prototype keys.
 *
 * @param {Record<string, string|undefined>} env - Environment dictionary.
 * @param {string} key - Environment variable name.
 * @returns {string}
 */
function readEnvString(env, key) {
  if (!env || !Object.hasOwn(env, key) || env[key] === undefined) {
    return '';
  }
  return String(env[key]).trim();
}

/**
 * Formats a hostname or IP literal for embedding in a URL (wrapping bare IPv6 literals in []).
 *
 * @param {string} rawHost - Candidate hostname or IP address.
 * @returns {string}
 */
function formatHostForUrl(rawHost) {
  const host = String(rawHost || '').trim();
  if (!host) {
    return DEFAULT_FRIGATE_HOST;
  }
  if (host.includes(':') && !host.startsWith('[')) {
    return '[' + host + ']';
  }
  return host;
}

/**
 * Normalizes a base HTTP service URL by trimming whitespace and stripping any accidental trailing
 * '/' or '/api' path suffix.
 *
 * @param {*} rawUrl - Raw URL string.
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
      const protocol = parsed.protocol === 'https:' ? 'https:' : DEFAULT_HTTP_PROTOCOL;
      const host = formatHostForUrl(parsed.hostname || DEFAULT_FRIGATE_HOST);
      return Object.freeze({protocol, host});
    } catch (err) {
      // Fall back to default host when URL cannot be parsed.
    }
  }
  return Object.freeze({protocol: DEFAULT_HTTP_PROTOCOL, host: DEFAULT_FRIGATE_HOST});
}

/**
 * Normalizes a direct go2rtc RTSP publish override URL, automatically appending '/{name}' when omitted.
 *
 * @param {string} rawRtspUrl - Explicit GO2RTC_RTSP_URL override.
 * @returns {string}
 */
function normalizeRtspPublishOverride(rawRtspUrl) {
  return rawRtspUrl.includes(RTSP_NAME_TEMPLATE_TOKEN)
    ? rawRtspUrl
    : rawRtspUrl.replace(TRAILING_SLASHES_REGEX, '') + '/' + RTSP_NAME_TEMPLATE_TOKEN;
}

/**
 * Parses and strictly validates an integer TCP/HTTP port environment variable.
 *
 * @param {Record<string, string|undefined>} env - Environment dictionary.
 * @param {string} envKey - Environment variable name.
 * @param {{minPort: number, fallbackPort: number}} opts - Bounds and fallback default port.
 * @returns {number}
 */
function parseEnvPort(env, envKey, {minPort, fallbackPort}) {
  const rawPort = readEnvString(env, envKey);
  if (rawPort === '') {
    return fallbackPort;
  }
  const parsedPort = Number(rawPort);
  if (
    !INTEGER_PORT_REGEX.test(rawPort) ||
    !Number.isSafeInteger(parsedPort) ||
    parsedPort < minPort ||
    parsedPort > MAX_TCP_PORT
  ) {
    throw new Error(
      envKey + ' must be an integer between ' + minPort + ' and ' + MAX_TCP_PORT + ', got "' + rawPort + '"'
    );
  }
  return parsedPort;
}

/**
 * Validates that an explicit endpoint environment variable parses as a URL with one of the allowed schemes.
 *
 * @param {string} envKey - Environment variable name.
 * @param {string} candidateUrl - Candidate URL string to parse.
 * @param {Set<string>} allowedProtocols - Allowed URL protocols (e.g. 'http:', 'ws:', 'rtsp:').
 */
function validateEndpointUrlScheme(envKey, candidateUrl, allowedProtocols) {
  if (!candidateUrl) {
    return;
  }
  let parsed;
  try {
    parsed = new URL(candidateUrl);
  } catch (err) {
    throw new Error(envKey + ' must be a valid URL, got "' + candidateUrl + '"', {cause: err});
  }
  if (!allowedProtocols.has(parsed.protocol) || !parsed.hostname) {
    const schemes = [...allowedProtocols].map((p) => p.replace(':', '://')).join(' or ');
    throw new Error(envKey + ' must start with ' + schemes + ' and include a host, got "' + candidateUrl + '"');
  }
}

/**
 * Resolves external service endpoints from hybrid-prefixed environment variables
 * (EUFY_WS_*, FRIGATE_*, GO2RTC_*, and HA_WEBHOOK_URL).
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {Readonly<{
 *   eufy_security_ws_url: string,
 *   frigate_url: string,
 *   go2rtc_url: string,
 *   rtsp_publish_url: string,
 *   ha_webhook_url: string
 * }>}
 */
function resolveServiceEndpoints(env = process.env) {
  const eufyOverride = readEnvString(env, 'EUFY_WS_URL').replace(TRAILING_SLASHES_REGEX, '');
  validateEndpointUrlScheme('EUFY_WS_URL', eufyOverride, WS_PROTOCOLS);
  const eufyHost = formatHostForUrl(readEnvString(env, 'EUFY_WS_HOST') || DEFAULT_EUFY_WS_HOST);
  const eufyPort = parseEnvPort(env, 'EUFY_WS_PORT', {
    minPort: MIN_TCP_PORT,
    fallbackPort: DEFAULT_EUFY_WS_PORT,
  });
  const eufySecurityWsUrl = eufyOverride || DEFAULT_WS_PROTOCOL + '//' + eufyHost + ':' + eufyPort;

  const frigateOverride = normalizeBaseHttpUrl(readEnvString(env, 'FRIGATE_URL'));
  validateEndpointUrlScheme('FRIGATE_URL', frigateOverride, HTTP_PROTOCOLS);
  const frigateHost = formatHostForUrl(readEnvString(env, 'FRIGATE_HOST') || DEFAULT_FRIGATE_HOST);
  const frigatePort = parseEnvPort(env, 'FRIGATE_PORT', {
    minPort: MIN_TCP_PORT,
    fallbackPort: DEFAULT_FRIGATE_HTTP_PORT,
  });
  const frigateUrl = frigateOverride || DEFAULT_HTTP_PROTOCOL + '//' + frigateHost + ':' + frigatePort;

  const derivedFromFrigate = extractUrlProtocolAndHost(frigateUrl);
  const go2rtcOverride = normalizeBaseHttpUrl(readEnvString(env, 'GO2RTC_URL'));
  validateEndpointUrlScheme('GO2RTC_URL', go2rtcOverride, HTTP_PROTOCOLS);
  const explicitGo2rtcHost = readEnvString(env, 'GO2RTC_HOST');
  const go2rtcHost = explicitGo2rtcHost ? formatHostForUrl(explicitGo2rtcHost) : derivedFromFrigate.host;
  const go2rtcProto = explicitGo2rtcHost ? DEFAULT_HTTP_PROTOCOL : derivedFromFrigate.protocol;
  const go2rtcApiPort = parseEnvPort(env, 'GO2RTC_API_PORT', {
    minPort: MIN_TCP_PORT,
    fallbackPort: DEFAULT_GO2RTC_HTTP_PORT,
  });
  const go2rtcUrl = go2rtcOverride || go2rtcProto + '//' + go2rtcHost + ':' + go2rtcApiPort;

  const rtspOverride = readEnvString(env, 'GO2RTC_RTSP_URL');
  let rtspPublishUrl;
  if (rtspOverride) {
    rtspPublishUrl = normalizeRtspPublishOverride(rtspOverride);
    validateEndpointUrlScheme(
      'GO2RTC_RTSP_URL',
      rtspPublishUrl.replace(RTSP_NAME_TEMPLATE_TOKEN, 'camera'),
      RTSP_PROTOCOLS
    );
  } else {
    const rtspHost = explicitGo2rtcHost
      ? formatHostForUrl(explicitGo2rtcHost)
      : extractUrlProtocolAndHost(go2rtcUrl || frigateUrl).host;
    const go2rtcRtspPort = parseEnvPort(env, 'GO2RTC_RTSP_PORT', {
      minPort: MIN_TCP_PORT,
      fallbackPort: DEFAULT_GO2RTC_RTSP_PORT,
    });
    const rtspUser = readEnvString(env, 'GO2RTC_RTSP_USER');
    const rtspPass = readEnvString(env, 'GO2RTC_RTSP_PASSWORD');
    const authPrefix = rtspUser
      ? encodeURIComponent(rtspUser) + (rtspPass ? ':' + encodeURIComponent(rtspPass) : '') + '@'
      : '';
    rtspPublishUrl = 'rtsp://' + authPrefix + rtspHost + ':' + go2rtcRtspPort + '/' + RTSP_NAME_TEMPLATE_TOKEN;
  }

  const haWebhookUrl = readEnvString(env, 'HA_WEBHOOK_URL');
  validateEndpointUrlScheme('HA_WEBHOOK_URL', haWebhookUrl, HTTP_PROTOCOLS);

  return Object.freeze({
    eufy_security_ws_url: eufySecurityWsUrl,
    frigate_url: frigateUrl,
    go2rtc_url: go2rtcUrl,
    rtsp_publish_url: rtspPublishUrl,
    ha_webhook_url: haWebhookUrl,
  });
}

/**
 * Normalizes and validates the requested hardware acceleration mode from BRIDGE_HWACCEL.
 *
 * @param {*} rawHwaccel - Raw BRIDGE_HWACCEL string value.
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
  if (!normalized || DISABLED_HWACCEL_TOKENS.has(normalized)) {
    return HWACCEL_MODES.NONE;
  }
  if (SUPPORTED_HWACCEL_MODES.has(normalized)) {
    return normalized;
  }
  throw new Error('BRIDGE_HWACCEL must be one of vaapi, qsv, nvenc, v4l2m2m, or false/none, got "' + rawHwaccel + '"');
}

/**
 * Validates and normalizes BRIDGE_LOG_LEVEL when explicitly specified.
 *
 * @param {string} rawLevel - Trimmed BRIDGE_LOG_LEVEL string.
 * @returns {string}
 */
function parseEnvLogLevel(rawLevel) {
  if (!rawLevel) {
    return DEFAULT_LOG_LEVEL;
  }
  const normalized = rawLevel.toLowerCase();
  if (!SUPPORTED_LOG_LEVELS.has(normalized)) {
    throw new Error('BRIDGE_LOG_LEVEL must be one of debug, info, warn, warning, or error, got "' + rawLevel + '"');
  }
  return normalized;
}

/**
 * Resolves bridge container runtime settings from BRIDGE_* environment variables.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {Readonly<{
 *   logLevel: string,
 *   httpPort: number,
 *   cacheDir: string,
 *   hwaccelMode: string,
 *   hwaccelDevice: string
 * }>}
 */
function resolveRuntimeEnv(env = process.env) {
  const explicitHwDevice = readEnvString(env, 'BRIDGE_HWACCEL_DEVICE');
  return Object.freeze({
    logLevel: parseEnvLogLevel(readEnvString(env, 'BRIDGE_LOG_LEVEL')),
    httpPort: parseEnvPort(env, 'BRIDGE_HTTP_PORT', {
      minPort: MIN_HTTP_LISTEN_PORT,
      fallbackPort: DEFAULT_HTTP_PORT,
    }),
    cacheDir: readEnvString(env, 'BRIDGE_CACHE_DIR') || DEFAULT_CACHE_DIR,
    hwaccelMode: parseHwaccelMode(readEnvString(env, 'BRIDGE_HWACCEL')),
    hwaccelDevice: explicitHwDevice || DEFAULT_HWACCEL_DEVICE,
  });
}

/**
 * Finds unknown top-level and per-camera configuration keys in a single schema pass.
 *
 * @param {Record<string, *>} rawCfg - Candidate configuration object.
 * @returns {{ unknownTopKeys: string[], unknownCameraKeys: string[] }}
 */
function inspectConfigSchemaKeys(rawCfg) {
  const unknownTopKeys = [];
  const unknownCameraKeys = [];

  for (const key of Object.keys(rawCfg)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      unknownTopKeys.push(key);
    }
  }

  if (Array.isArray(rawCfg.cameras)) {
    rawCfg.cameras.forEach((cam, idx) => {
      if (!cam || typeof cam !== 'object') {
        return;
      }
      for (const camKey of Object.keys(cam)) {
        if (!ALLOWED_CAMERA_KEYS.has(camKey)) {
          unknownCameraKeys.push('cameras[' + idx + '].' + camKey);
        }
      }
    });
  }

  return {unknownTopKeys, unknownCameraKeys};
}

/**
 * Returns true if token is a safe camera/station identifier without path separators or traversal segments.
 *
 * @param {string} token - Trimmed identifier string.
 * @returns {boolean}
 */
function isSafeIdentityToken(token) {
  return token !== '.' && token !== '..' ? SAFE_IDENTITY_TOKEN_REGEX.test(token) : false;
}

/**
 * Extracts the hostname from a candidate direct rtsp_url string, or '' when invalid.
 *
 * @param {string} directUrl - Trimmed rtsp_url string.
 * @returns {string}
 */
function parseDirectRtspUrlHost(directUrl) {
  if (!RTSP_URL_PROTOCOL_REGEX.test(directUrl)) {
    return '';
  }
  const probeUrl = stripRtspUrlFragment(directUrl).replace(INLINE_ENV_PLACEHOLDER_REGEX, 'placeholder');
  try {
    const parsed = new URL(probeUrl);
    return RTSP_PROTOCOLS.has(parsed.protocol) ? parsed.hostname : '';
  } catch (err) {
    return '';
  }
}

/**
 * Returns true if a direct rtsp_url string is a valid rtsp:// or rtsps:// URL with a host
 * (allowing unexpanded ${ENV_VAR} placeholders when validateConfig is called directly).
 *
 * @param {string} directUrl - Trimmed rtsp_url string.
 * @returns {boolean}
 */
function isValidDirectRtspUrl(directUrl) {
  return FULL_ENV_PLACEHOLDER_REGEX.test(directUrl) ? true : Boolean(parseDirectRtspUrlHost(directUrl));
}

/**
 * Validates per-camera rtsp_url protocol/host syntax and rejects incompatible camera modes.
 *
 * @param {*} cameras - Candidate rawCfg.cameras array.
 * @param {string[]} errors - Mutable validation error collector.
 */
function validateCameraRtspUrls(cameras, errors) {
  if (!Array.isArray(cameras)) {
    return;
  }
  cameras.forEach((cam, idx) => {
    if (!cam || typeof cam !== 'object' || cam.rtsp_url === undefined) {
      return;
    }
    const directUrl = typeof cam.rtsp_url === 'string' ? cam.rtsp_url.trim() : '';
    if (!isValidDirectRtspUrl(directUrl)) {
      errors.push('cameras[' + idx + '] "rtsp_url" must start with rtsp:// or rtsps:// and include a host');
    }
    const rawMode = String(cam.mode || '')
      .trim()
      .toLowerCase();
    if (rawMode && rawMode !== CAMERA_MODES.RTSP && rawMode !== CAMERA_MODES.AUTO) {
      errors.push(
        'cameras[' +
          idx +
          '] cannot combine "rtsp_url" with mode "' +
          cam.mode +
          '" ("rtsp_url" is only supported with mode "rtsp" or "auto")'
      );
    }
  });
}

/**
 * Validates telemetry block shape (boolean or plain mapping of known boolean toggles).
 *
 * @param {*} rawTel - Candidate telemetry value.
 * @param {string} prefix - Scope prefix for error messages.
 * @param {string[]} errors - Mutable validation error collector.
 */
function validateTelemetryOption(rawTel, prefix, errors) {
  if (rawTel === undefined || typeof rawTel === 'boolean') {
    return;
  }
  if (!rawTel || typeof rawTel !== 'object' || Array.isArray(rawTel)) {
    errors.push(prefix + '"telemetry" must be a boolean or mapping');
    return;
  }
  for (const [k, v] of Object.entries(rawTel)) {
    if (!ALLOWED_TELEMETRY_KEYS.has(k)) {
      errors.push('unknown telemetry key "' + prefix + 'telemetry.' + k + '"');
    } else if (typeof v !== 'boolean') {
      errors.push(prefix + '"telemetry.' + k + '" must be a boolean');
    }
  }
}

/**
 * Validates shared boolean, numeric, startup_snapshot, streaming quality, trigger_events, and telemetry types.
 *
 * @param {Record<string, *>} node - Top-level or per-camera configuration mapping.
 * @param {string} prefix - Scope prefix ('' or 'cameras[i] ').
 * @param {string[]} errors - Mutable validation error collector.
 */
function validateCommonOptionTypes(node, prefix, errors) {
  for (const [key, val] of Object.entries(node)) {
    if (val === undefined) {
      continue;
    }
    if (BOOLEAN_CONFIG_KEYS.has(key) && typeof val !== 'boolean') {
      errors.push(prefix + '"' + key + '" must be a boolean');
    } else if (INTEGER_CONFIG_KEYS.has(key) && !Number.isInteger(val)) {
      errors.push(prefix + '"' + key + '" must be an integer');
    } else if (FLOAT_CONFIG_KEYS.has(key) && (typeof val !== 'number' || !Number.isFinite(val))) {
      errors.push(prefix + '"' + key + '" must be a finite number');
    }
  }
  if (
    node.startup_snapshot !== undefined &&
    typeof node.startup_snapshot !== 'boolean' &&
    node.startup_snapshot !== 'always'
  ) {
    errors.push(prefix + '"startup_snapshot" must be a boolean or "always"');
  }
  if (node.enforce_streaming_quality !== undefined) {
    const q = node.enforce_streaming_quality;
    const validQuality =
      typeof q === 'boolean' || (Number.isInteger(q) && q >= MIN_STREAMING_QUALITY && q <= MAX_STREAMING_QUALITY);
    if (!validQuality) {
      errors.push(prefix + '"enforce_streaming_quality" must be a boolean or integer 1..10');
    }
  }
  if (node.trigger_events !== undefined) {
    const validTriggers =
      Array.isArray(node.trigger_events) &&
      node.trigger_events.length > 0 &&
      node.trigger_events.every((item) => typeof item === 'string' && Boolean(item.trim()));
    if (!validTriggers) {
      errors.push(prefix + '"trigger_events" must be a non-empty array of strings');
    }
  }
  validateTelemetryOption(node.telemetry, prefix, errors);
}

/**
 * Validates per-camera safe identifier syntax and uniqueness across names and hardware serials.
 *
 * @param {*} cameras - Candidate rawCfg.cameras array.
 * @param {string[]} errors - Mutable validation error collector.
 */
function validateCameraIdentities(cameras, errors) {
  if (!Array.isArray(cameras)) {
    return;
  }
  const seenNames = new Set();
  const seenSerials = new Set();
  cameras.forEach((cam, idx) => {
    if (!cam || typeof cam !== 'object' || Array.isArray(cam)) {
      return;
    }
    const {serial, name, explicitSerial} = CameraConfig.normalizeIdentity(cam);
    if (name && !isSafeIdentityToken(name)) {
      errors.push('cameras[' + idx + '] "name" contains unsafe characters: "' + name + '"');
    }
    if (explicitSerial && !isSafeIdentityToken(explicitSerial)) {
      errors.push('cameras[' + idx + '] "serial" contains unsafe characters: "' + explicitSerial + '"');
    }
    if (cam.station_serial !== undefined) {
      const st = typeof cam.station_serial === 'string' ? cam.station_serial.trim() : '';
      if (!st || !isSafeIdentityToken(st)) {
        errors.push('cameras[' + idx + '] "station_serial" must be a safe non-empty string');
      }
    }
    if (name) {
      const lowerName = name.toLowerCase();
      if (seenNames.has(lowerName)) {
        errors.push('duplicate camera name "' + name + '" at cameras[' + idx + ']');
      }
      seenNames.add(lowerName);
    }
    const serialKey = (explicitSerial || (!hasDirectRtspUrl(cam) ? serial : '')).toLowerCase();
    if (serialKey) {
      if (seenSerials.has(serialKey)) {
        errors.push('duplicate camera serial "' + (explicitSerial || serial) + '" at cameras[' + idx + ']');
      }
      seenSerials.add(serialKey);
    }
    validateCommonOptionTypes(cam, 'cameras[' + idx + '] ', errors);
  });
}

/**
 * Validates a parsed YAML camera configuration object in one pass and throws a combined error
 * listing all missing, invalid, duplicate, or unknown keys at once.
 *
 * @param {Record<string, *>} rawCfg - Parsed YAML configuration object.
 */
function validateConfig(rawCfg) {
  if (!rawCfg || typeof rawCfg !== 'object' || Array.isArray(rawCfg)) {
    throw new Error('config.yaml: configuration must be a YAML mapping');
  }

  const {unknownTopKeys, unknownCameraKeys} = inspectConfigSchemaKeys(rawCfg);
  const errors = [];

  const hasValidCameras =
    Array.isArray(rawCfg.cameras) &&
    rawCfg.cameras.length > 0 &&
    rawCfg.cameras.every((cam) => CameraConfig.hasValidIdentity(cam));

  if (!hasValidCameras) {
    errors.push('"cameras" must list at least one {"serial"}');
  }

  validateCommonOptionTypes(rawCfg, '', errors);
  if (rawCfg.ring_label !== undefined && (typeof rawCfg.ring_label !== 'string' || !rawCfg.ring_label.trim())) {
    errors.push('"ring_label" must be a non-empty string');
  }
  if (rawCfg.event_priorities !== undefined) {
    const ep = rawCfg.event_priorities;
    const validEp =
      Boolean(ep) &&
      typeof ep === 'object' &&
      !Array.isArray(ep) &&
      Object.values(ep).every((v) => typeof v === 'number' && Number.isFinite(v));
    if (!validEp) {
      errors.push('"event_priorities" must map event names to finite numbers');
    }
  }
  validateCameraIdentities(rawCfg.cameras, errors);
  validateCameraRtspUrls(rawCfg.cameras, errors);

  for (const k of unknownTopKeys) {
    errors.push('unknown key "' + k + '"');
  }
  for (const ck of unknownCameraKeys) {
    errors.push('unknown camera key "' + ck + '"');
  }

  if (errors.length > 0) {
    throw new Error('config.yaml: ' + errors.join('; '));
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
 * event_priorities overrides from config.yaml before falling back to built-in tiers.
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
      const token = String(keyword || '')
        .toLowerCase()
        .trim();
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
 * @param {string[]|undefined} rawEvents - Optional array of trigger event strings from config.yaml.
 * @returns {Set<string>} Normalized set of Eufy event names.
 */
function buildTriggerSet(rawEvents) {
  const sourceEvents = Array.isArray(rawEvents) && rawEvents.length > 0 ? rawEvents : DEFAULT_TRIGGER_EVENTS;
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
 * Normalizes a card placement string into one of the 7 canonical `<vertical>-<horizontal>` positions.
 *
 * @param {*} rawPos - Raw card_position value from config.
 * @param {string} [scope='bridge'] - Log scope for warnings.
 * @returns {'center'|'top-left'|'top-center'|'top-right'|'bottom-left'|'bottom-center'|'bottom-right'}
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
    case CARD_POSITIONS.TOP_CENTER:
    case CARD_POS_ALIAS_CENTER_TOP:
      return CARD_POSITIONS.TOP_CENTER;
    case CARD_POSITIONS.TOP_RIGHT:
      return CARD_POSITIONS.TOP_RIGHT;
    case CARD_POSITIONS.BOTTOM_CENTER:
    case CARD_POS_ALIAS_CENTER_BOTTOM:
      return CARD_POSITIONS.BOTTOM_CENTER;
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
 * @returns {'glance'|'minimal'|'pebbles'|'hud'|'none'}
 */
function normalizeCardTheme(rawTheme, scope = 'bridge') {
  if (rawTheme === false) {
    return CARD_THEMES.NONE;
  }

  const token = String(rawTheme ?? CARD_THEMES.MINIMAL)
    .toLowerCase()
    .trim();

  switch (token) {
    case '':
    case CARD_THEMES.MINIMAL:
      return CARD_THEMES.MINIMAL;
    case CARD_THEMES.GLANCE:
      return CARD_THEMES.GLANCE;
    case CARD_THEMES.PEBBLES:
      return CARD_THEMES.PEBBLES;
    case CARD_THEMES.HUD:
      return CARD_THEMES.HUD;
    case CARD_THEMES.NONE:
      return CARD_THEMES.NONE;
    default:
      log.warn(scope, 'unknown card_theme "' + rawTheme + '", defaulting to "minimal"');
      return CARD_THEMES.MINIMAL;
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
 * Resolves a validated environment placeholder expression ('VAR' or 'VAR:-default') against ctx.env.
 *
 * @param {string} expr - Inner expression inside ${...}.
 * @param {string} keyPath - Dotted/indexed configuration path for error reporting.
 * @param {{ env: Record<string, string|undefined>, errors: string[] }} ctx - Expansion context.
 * @returns {string}
 */
function resolveEnvPlaceholder(expr, keyPath, ctx) {
  const sepIdx = expr.indexOf(ENV_DEFAULT_SEPARATOR);
  const varName = sepIdx === -1 ? expr : expr.slice(0, sepIdx);
  const fallback = sepIdx === -1 ? undefined : expr.slice(sepIdx + ENV_DEFAULT_SEPARATOR.length);
  const rawVal =
    ctx.env && Object.hasOwn(ctx.env, varName) && ctx.env[varName] !== undefined ? String(ctx.env[varName]) : '';
  if (rawVal !== '') return rawVal;
  if (fallback !== undefined) return fallback;
  const suffix = keyPath ? ' (' + keyPath + ')' : '';
  ctx.errors.push('environment variable "' + varName + '" is not set' + suffix);
  return '';
}

/**
 * Expands ${ENV_VAR} and ${ENV_VAR:-default} placeholders in a single configuration string,
 * unescaping $${...} literals and recording missing variables or malformed/unclosed placeholders
 * in ctx.errors in a single pass.
 *
 * @param {string} rawStr - Candidate string value from config.yaml.
 * @param {string} keyPath - Dotted/indexed configuration path for error reporting.
 * @param {{ env: Record<string, string|undefined>, errors: string[] }} ctx - Expansion context.
 * @returns {string}
 */
function expandEnvString(rawStr, keyPath, ctx) {
  if (!rawStr.includes(ENV_OPEN_TOKEN)) return rawStr;
  const suffix = keyPath ? ' (' + keyPath + ')' : '';
  let out = '';
  let cursor = 0;
  while (cursor < rawStr.length) {
    const dollarIdx = rawStr.indexOf(ENV_DOLLAR_CHAR, cursor);
    if (dollarIdx === -1) {
      out += rawStr.slice(cursor);
      break;
    }
    out += rawStr.slice(cursor, dollarIdx);
    if (rawStr.startsWith(ENV_ESCAPED_OPEN_TOKEN, dollarIdx)) {
      out += ENV_OPEN_TOKEN;
      cursor = dollarIdx + ENV_ESCAPED_OPEN_TOKEN.length;
      continue;
    }
    if (!rawStr.startsWith(ENV_OPEN_TOKEN, dollarIdx)) {
      out += ENV_DOLLAR_CHAR;
      cursor = dollarIdx + 1;
      continue;
    }
    const closeIdx = rawStr.indexOf(ENV_CLOSE_TOKEN, dollarIdx + ENV_OPEN_TOKEN.length);
    if (closeIdx === -1) {
      const preview = rawStr.slice(dollarIdx, dollarIdx + MAX_MALFORMED_PLACEHOLDER_CHARS);
      ctx.errors.push('malformed environment variable placeholder "' + preview + '"' + suffix);
      break;
    }
    const expr = rawStr.slice(dollarIdx + ENV_OPEN_TOKEN.length, closeIdx);
    if (!ENV_VAR_EXPR_REGEX.test(expr)) {
      ctx.errors.push('malformed environment variable placeholder "${' + expr + '}"' + suffix);
    } else {
      out += resolveEnvPlaceholder(expr, keyPath, ctx);
    }
    cursor = closeIdx + 1;
  }
  return out;
}

/**
 * Recursively walks a parsed YAML configuration value and expands ${ENV_VAR} placeholders
 * across all string values without mutating the input structure.
 *
 * @param {*} value - Parsed YAML configuration value.
 * @param {string} keyPath - Current configuration key path for error reporting.
 * @param {{ env: Record<string, string|undefined>, errors: string[] }} ctx - Expansion context.
 * @returns {*}
 */
function expandEnvNode(value, keyPath, ctx) {
  if (typeof value === 'string') return expandEnvString(value, keyPath, ctx);
  if (Array.isArray(value)) return value.map((item, idx) => expandEnvNode(item, keyPath + '[' + idx + ']', ctx));
  if (value && typeof value === 'object') {
    /** @type {Record<string, *>} */
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = expandEnvNode(child, keyPath ? keyPath + '.' + key : key, ctx);
    }
    return out;
  }
  return value;
}

/**
 * Expands ${ENV_VAR} and ${ENV_VAR:-default} placeholders across all string values in a parsed
 * config.yaml structure, throwing a single combined error when any required environment variable
 * is unset or empty.
 *
 * @template T
 * @param {T} rawCfg - Parsed YAML configuration object or value.
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {T}
 */
function expandConfigEnvVars(rawCfg, env = process.env) {
  /** @type {string[]} */
  const errors = [];
  const expanded = expandEnvNode(rawCfg, '', {env, errors});
  if (errors.length > 0) {
    throw new Error('config.yaml: ' + [...new Set(errors)].join('; '));
  }
  return expanded;
}

/**
 * Resolves the configuration file path from BRIDGE_CONFIG, /config/config.yaml, or ./config.yaml.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {string}
 */
function resolveConfigFilePath(env = process.env) {
  const explicitPath = readEnvString(env, 'BRIDGE_CONFIG');
  if (explicitPath) {
    return explicitPath;
  }
  if (fs.existsSync(DEFAULT_CONTAINER_CONFIG_PATH)) {
    return DEFAULT_CONTAINER_CONFIG_PATH;
  }
  if (fs.existsSync(DEFAULT_LOCAL_CONFIG_PATH)) {
    return DEFAULT_LOCAL_CONFIG_PATH;
  }
  return DEFAULT_CONTAINER_CONFIG_PATH;
}

/**
 * Reads, parses YAML, expands ${ENV_VAR} placeholders, and validates a config.yaml file from disk.
 *
 * @param {string} filePath - Path to config.yaml.
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {Record<string, *>}
 */
function loadConfigFile(filePath, env = process.env) {
  const parsedYaml = jsYaml.load(fs.readFileSync(filePath, 'utf8'));
  const expanded = expandConfigEnvVars(parsedYaml, env);
  const validated = /** @type {Record<string, *>} */ (expanded);
  validateConfig(validated);
  return validated;
}

/**
 * Resolves the temporary PID marker file path used by container HEALTHCHECK when BRIDGE_HTTP_PORT=0.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {string}
 */
function resolveReadyMarkerPath(env = process.env) {
  return path.join(readEnvString(env, 'TMPDIR') || os.tmpdir(), READY_MARKER_FILENAME);
}

/**
 * Deletes any pre-existing readiness marker file before startup configuration validation runs.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 */
function clearReadyMarkerFile(env = process.env) {
  try {
    fs.rmSync(resolveReadyMarkerPath(env), {force: true});
  } catch (err) {
    // Ignore transient filesystem errors when clearing stale startup markers.
  }
}

/**
 * Loads and validates the configuration object from BRIDGE_CONFIG, /config/config.yaml, or
 * ./config.yaml. Falls back to an in-memory default test configuration only in Node test runs;
 * in production, logs a structured [ERROR] line and exits(1) when the config file is missing or invalid.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 * @returns {Record<string, *>}
 */
function loadConfig(env = process.env) {
  clearReadyMarkerFile(env);
  initLogger(DEFAULT_LOG_LEVEL);
  const targetPath = resolveConfigFilePath(env);
  const hasConfigFile = Boolean(readEnvString(env, 'BRIDGE_CONFIG')) || fs.existsSync(targetPath);
  try {
    const runtimeEnv = resolveRuntimeEnv(env);
    initLogger(runtimeEnv.logLevel);
    resolveServiceEndpoints(env);
    if (hasConfigFile) {
      return loadConfigFile(targetPath, env);
    }
    const isTestEnv = Boolean(readEnvString(env, 'NODE_TEST_CONTEXT') || readEnvString(env, 'NODE_ENV') === 'test');
    if (isTestEnv) {
      const fallback = {
        cameras: [{serial: 'T8161T0000000000', mode: 'rtsp'}],
      };
      validateConfig(fallback);
      return fallback;
    }
    throw new Error('config.yaml: configuration file not found at ' + targetPath);
  } catch (err) {
    const msg = formatErrorMessage(err);
    log.error('bridge', 'startup configuration error: ' + msg);
    process.exit(1);
  }
}

const READY_MARKER_FILE = resolveReadyMarkerPath(process.env);
const rawLoadedCfg = loadConfig(process.env);
const processRuntimeEnv = resolveRuntimeEnv(process.env);

const ACTIVE_LOG_LEVEL_NAME = initLogger(processRuntimeEnv.logLevel);

const DEFAULT_BACKFILL_DELAY_SECS = 2;
const DEFAULT_TRACK_STUCK_SPOTLIGHT = false;

// Smart battery conservation, periodic telemetry refresh, and startup snapshot probe options.
const MIN_CRITICAL_BAT_THRESHOLD_PCT = 1;
const MAX_CRITICAL_BAT_THRESHOLD_PCT = 98;
const DEFAULT_CRITICAL_BAT_THRESHOLD_PCT = 5;
const MIN_LOW_BAT_THRESHOLD_PCT = 2;
const MAX_LOW_BAT_THRESHOLD_PCT = 99;
const DEFAULT_LOW_BAT_THRESHOLD_PCT = 30;

/**
 * Resolves low_battery_threshold and critical_battery_threshold with defensive non-contradiction
 * clamping (0 < criticalBatThreshold < lowBatThreshold <= 99).
 *
 * @param {Record<string, *>} [rawCfg=rawLoadedCfg] - Raw configuration object (global or camera).
 * @param {{ lowFallback?: number, critFallback?: number }} [fallbacks={}] - Default fallback percentages.
 * @param {string} [scope='bridge'] - Logger scope name.
 * @returns {Readonly<{ lowBatThreshold: number, criticalBatThreshold: number }>}
 */
function resolveBatteryThresholds(rawCfg = rawLoadedCfg, fallbacks = {}, scope = 'bridge') {
  const lowFallback = fallbacks.lowFallback ?? DEFAULT_LOW_BAT_THRESHOLD_PCT;
  const critFallback = fallbacks.critFallback ?? DEFAULT_CRITICAL_BAT_THRESHOLD_PCT;
  const lowBatThreshold = clampNum(
    rawCfg.low_battery_threshold,
    MIN_LOW_BAT_THRESHOLD_PCT,
    MAX_LOW_BAT_THRESHOLD_PCT,
    lowFallback
  );
  const rawCritical = clampNum(
    rawCfg.critical_battery_threshold,
    MIN_CRITICAL_BAT_THRESHOLD_PCT,
    MAX_CRITICAL_BAT_THRESHOLD_PCT,
    critFallback
  );
  if (rawCritical >= lowBatThreshold) {
    const clampedCritical = lowBatThreshold - 1;
    if (rawCfg.critical_battery_threshold !== undefined || rawCfg.low_battery_threshold !== undefined) {
      log.warn(
        scope,
        'critical_battery_threshold (' +
          rawCritical +
          '%) must be lower than low_battery_threshold (' +
          lowBatThreshold +
          '%), clamping critical_battery_threshold to ' +
          clampedCritical +
          '%'
      );
    }
  }
  return Object.freeze({
    lowBatThreshold,
    criticalBatThreshold: Math.min(rawCritical, lowBatThreshold - 1),
  });
}

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

// Audio configuration: 16 kHz, 16-bit signed little-endian mono PCM sent in 100 ms chunks.
const RATE = 16000;
const AUDIO_TICK = 100;
const AUDIO_CHUNK = (RATE * 2 * AUDIO_TICK) / MS_PER_SECOND;
const SILENCE = Buffer.alloc(AUDIO_CHUNK, 0);

/**
 * Resolves a writable directory for storing cached camera snapshots across restarts.
 *
 * @param {string} [preferredDir=processRuntimeEnv.cacheDir] - Preferred cache directory path.
 * @returns {string} Writable directory path for snapshot cache files.
 */
function resolveCacheDir(preferredDir = processRuntimeEnv.cacheDir) {
  const preferred = preferredDir || DEFAULT_CACHE_DIR;
  try {
    fs.mkdirSync(preferred, {recursive: true});
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch (err) {
    const fallbackDir = os.tmpdir();
    log.warn(
      'bridge',
      'cache directory "' +
        preferred +
        '" is not writable (' +
        formatErrorMessage(err) +
        '), falling back to ' +
        fallbackDir
    );
    return fallbackDir;
  }
}

/**
 * Verifies whether the configured hardware acceleration mode and device node are usable.
 *
 * @param {string} [hwMode=processRuntimeEnv.hwaccelMode] - Parsed hwaccel mode.
 * @param {string} [hwDevice=processRuntimeEnv.hwaccelDevice] - Device node path.
 * @returns {string} Validated hwaccel mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m') or '' for software.
 */
function resolveHwaccel(hwMode = processRuntimeEnv.hwaccelMode, hwDevice = processRuntimeEnv.hwaccelDevice) {
  if (!hwMode) {
    return HWACCEL_MODES.NONE;
  }
  const requiresRenderDevice = hwMode === HWACCEL_MODES.VAAPI || hwMode === HWACCEL_MODES.QSV;
  if (requiresRenderDevice && !fs.existsSync(hwDevice)) {
    log.warn(
      'bridge',
      'hwaccel "' + hwMode + '" requested, but ' + hwDevice + ' is not accessible; falling back to software libx264'
    );
    return HWACCEL_MODES.NONE;
  }
  return hwMode;
}

/**
 * Resolves a boolean flag from a telemetry config block (boolean or object).
 *
 * @param {boolean|Record<string, *>|undefined} block - Telemetry config block.
 * @param {boolean} fallback - Default value when undefined.
 * @returns {boolean}
 */
function isTelemetryBlockEnabled(block, fallback) {
  return block === undefined ? fallback : typeof block === 'boolean' ? block : block.enabled !== false;
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
  if (hasDirectRtspUrl(camConfig)) {
    return Object.freeze({
      enabled: false,
      battery: false,
      powerSource: false,
      wifi: false,
      rssi: false,
      temperature: false,
      lastSeen: false,
    });
  }
  const globalCfg = baseCfg.telemetry;
  const camCfg = camConfig.telemetry;

  const globalEnabled = isTelemetryBlockEnabled(globalCfg, true);
  const camEnabled = isTelemetryBlockEnabled(camCfg, globalEnabled);

  const pickOption = (key, defaultVal = true) =>
    camCfg && typeof camCfg === 'object' && key in camCfg
      ? Boolean(camCfg[key])
      : globalCfg && typeof globalCfg === 'object' && key in globalCfg
        ? Boolean(globalCfg[key])
        : defaultVal;

  return Object.freeze({
    enabled: camEnabled,
    battery: camEnabled && pickOption('battery', true),
    powerSource: camEnabled && pickOption('power_source', true),
    wifi: camEnabled && pickOption('wifi', true),
    rssi: camEnabled && pickOption('rssi', true),
    temperature: camEnabled && pickOption('temperature', false),
    lastSeen: camEnabled && pickOption('last_seen', false),
  });
}

/**
 * Resolves the effective status card theme, position, and sleeping screen backdrop for a camera.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {Record<string, *>} [baseCfg=rawLoadedCfg] - Global configuration object.
 * @returns {{
 *   theme: 'glance'|'minimal'|'pebbles'|'hud'|'none',
 *   position: 'center'|'top-left'|'top-center'|'top-right'|'bottom-left'|'bottom-center'|'bottom-right',
 *   sleepScreen: 'snapshot'|'slate'|'black'
 * }}
 */
function resolveCardConfig(camConfig = {}, baseCfg = rawLoadedCfg) {
  if (camConfig && camConfig.cardConfig && Object.isFrozen(camConfig.cardConfig)) {
    return camConfig.cardConfig;
  }
  const scope = CameraConfig.resolveScopeName(camConfig);
  const rawTheme = camConfig.card_theme ?? baseCfg.card_theme ?? CARD_THEMES.MINIMAL;
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
 * Resolves the normalized streaming mode ('auto', 'rtsp', 'p2p', 'backfill', or 'custom') for a camera,
 * resolving omitted or 'auto' mode to 'rtsp' when direct rtsp_url is configured.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @returns {'auto'|'rtsp'|'p2p'|'backfill'|'custom'}
 */
function resolveCameraMode(camConfig = {}) {
  const scope = CameraConfig.resolveScopeName(camConfig);
  const isDirect = hasDirectRtspUrl(camConfig);
  if (camConfig.mode === undefined || camConfig.mode === null || camConfig.mode === '') {
    return isDirect ? CAMERA_MODES.RTSP : CAMERA_MODES.AUTO;
  }
  const token = String(camConfig.mode).toLowerCase().trim();
  switch (token) {
    case CAMERA_MODES.AUTO:
      return isDirect ? CAMERA_MODES.RTSP : CAMERA_MODES.AUTO;
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
      return isDirect ? CAMERA_MODES.RTSP : CAMERA_MODES.AUTO;
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
 *   rtspDirect: boolean,
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
 *   criticalBatThreshold: number,
 *   lowBatHoldMs: number,
 *   lowBatWakeOnView: boolean,
 *   letEufyDecideEnd: boolean
 * }}
 */
function resolveCameraTimers(camConfig = {}, baseCfg = cfg) {
  if (camConfig && camConfig.timers && Object.isFrozen(camConfig.timers)) {
    return camConfig.timers;
  }
  const scope = CameraConfig.resolveScopeName(camConfig);
  const mode = resolveCameraMode(camConfig);
  const isRtspDirect = hasDirectRtspUrl(camConfig);
  const alwaysBackfill = isRtspDirect
    ? false
    : mode === CAMERA_MODES.BACKFILL ||
      (mode === CAMERA_MODES.CUSTOM && Boolean(camConfig.backfill_only ?? baseCfg.backfill_only));

  const globalUseRtsp = baseCfg.use_rtsp !== false;
  const useRtsp =
    mode === CAMERA_MODES.RTSP ||
    isRtspDirect ||
    ((mode === CAMERA_MODES.AUTO || mode === CAMERA_MODES.BACKFILL || mode === CAMERA_MODES.CUSTOM) &&
      (camConfig.use_rtsp !== undefined ? Boolean(camConfig.use_rtsp) : globalUseRtsp));

  const globalBackfillDownloads = baseCfg.backfill_enabled !== false;
  const rawBackfillDownloads =
    camConfig.backfill_enabled !== undefined ? Boolean(camConfig.backfill_enabled) : globalBackfillDownloads;
  if (alwaysBackfill && !rawBackfillDownloads) {
    log.warn(scope, 'cannot disable backfill_enabled in backfill-only mode; keeping backfill_enabled=true');
  }
  const backfillDownloads = isRtspDirect ? false : alwaysBackfill ? true : rawBackfillDownloads;

  const defaultHoldSecs = alwaysBackfill ? DEFAULT_BACKFILL_HOLD_SECS : DEFAULT_HOLD_SECS;
  const rawHoldSecs = camConfig.hold_secs ?? baseCfg.hold_secs;
  const holdSecs =
    rawHoldSecs !== undefined ? clampNum(rawHoldSecs, MIN_HOLD_SECS, MAX_HOLD_SECS, defaultHoldSecs) : defaultHoldSecs;
  const holdMs = holdSecs * MS_PER_SECOND;

  const baseMaxMs =
    baseCfg.maxMs ??
    clampNum(baseCfg.stream_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_MAX_SECS) * MS_PER_SECOND;
  const rawMaxMs =
    camConfig.stream_max_secs !== undefined
      ? clampNum(camConfig.stream_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_MAX_SECS) *
        MS_PER_SECOND
      : baseMaxMs;
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

  const baseViewMaxMs =
    baseCfg.viewMaxMs ??
    clampNum(baseCfg.view_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_VIEW_MAX_SECS) * MS_PER_SECOND;
  const baseLingerMs =
    baseCfg.lingerMs ??
    Math.min(
      baseViewMaxMs,
      clampNum(baseCfg.view_linger_secs, MIN_HOLD_SECS, MAX_HOLD_SECS, DEFAULT_LINGER_SECS) * MS_PER_SECOND
    );
  const rawLingerMs =
    camConfig.view_linger_secs !== undefined
      ? clampNum(camConfig.view_linger_secs, MIN_HOLD_SECS, MAX_HOLD_SECS, DEFAULT_LINGER_SECS) * MS_PER_SECOND
      : baseLingerMs;
  const rawViewMaxMs =
    camConfig.view_max_secs !== undefined
      ? clampNum(camConfig.view_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_VIEW_MAX_SECS) *
        MS_PER_SECOND
      : baseViewMaxMs;
  if (rawViewMaxMs < rawLingerMs) {
    const lingerSecs = Math.round(rawLingerMs / MS_PER_SECOND);
    log.warn(
      scope,
      'view_max_secs (' +
        Math.round(rawViewMaxMs / MS_PER_SECOND) +
        's) is shorter than view_linger_secs (' +
        lingerSecs +
        's), raising view_max_secs to ' +
        lingerSecs +
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

  const baseEarlySleepMs =
    baseCfg.earlySleepMs ??
    clampNum(baseCfg.idle_timeout_secs, MIN_EARLY_SLEEP_SECS, MAX_EARLY_SLEEP_SECS, DEFAULT_EARLY_SLEEP_SECS) *
      MS_PER_SECOND;
  const earlySleepMs =
    camConfig.idle_timeout_secs !== undefined
      ? clampNum(camConfig.idle_timeout_secs, MIN_EARLY_SLEEP_SECS, MAX_EARLY_SLEEP_SECS, DEFAULT_EARLY_SLEEP_SECS) *
        MS_PER_SECOND
      : baseEarlySleepMs;
  const baseBatThresholds = resolveBatteryThresholds(
    baseCfg,
    {lowFallback: DEFAULT_LOW_BAT_THRESHOLD_PCT, critFallback: DEFAULT_CRITICAL_BAT_THRESHOLD_PCT},
    scope
  );
  const {lowBatThreshold, criticalBatThreshold} = resolveBatteryThresholds(
    camConfig,
    {lowFallback: baseBatThresholds.lowBatThreshold, critFallback: baseBatThresholds.criticalBatThreshold},
    scope
  );
  const baseLowBatHoldMs =
    baseCfg.lowBatHoldMs ??
    clampNum(baseCfg.low_battery_hold_secs, MIN_LOW_BAT_HOLD_SECS, MAX_LOW_BAT_HOLD_SECS, DEFAULT_LOW_BAT_HOLD_SECS) *
      MS_PER_SECOND;
  const rawLowBatHoldMs =
    camConfig.low_battery_hold_secs !== undefined
      ? clampNum(
          camConfig.low_battery_hold_secs,
          MIN_LOW_BAT_HOLD_SECS,
          MAX_LOW_BAT_HOLD_SECS,
          DEFAULT_LOW_BAT_HOLD_SECS
        ) * MS_PER_SECOND
      : baseLowBatHoldMs;
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
      : Boolean(baseCfg.low_battery_wake_on_view ?? false);

  const rawEndEarly =
    camConfig.end_early ??
    (mode === CAMERA_MODES.CUSTOM ? camConfig.recording_end_early : undefined) ??
    baseCfg.end_early;
  const letEufyDecideEnd = rawEndEarly !== undefined ? Boolean(rawEndEarly) : alwaysBackfill;

  return Object.freeze({
    mode,
    rtspDirect: isRtspDirect,
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
    criticalBatThreshold,
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
 * @param {ReturnType<typeof resolveCameraTimers>|null} [resolvedTimers=null] - Pre-resolved camera timers.
 * @param {Record<string, *>} [baseCfg=cfg] - Global configuration object.
 * @returns {{
 *   enforceQuality: boolean|number,
 *   powerWorkingMode: number|null,
 *   recordingClipLength: number|null,
 *   recordingEndClipMotionStops: boolean|null,
 *   recordingRetriggerInterval: number|null
 * }}
 */
function resolveHardwareRecordingConfig(camConfig = {}, resolvedTimers = null, baseCfg = cfg) {
  if (camConfig && camConfig.hwRecordingConfig && Object.isFrozen(camConfig.hwRecordingConfig)) {
    return camConfig.hwRecordingConfig;
  }
  const timers = resolvedTimers || resolveCameraTimers(camConfig, baseCfg);
  if (timers.rtspDirect || hasDirectRtspUrl(camConfig)) {
    return Object.freeze({
      enforceQuality: null,
      powerWorkingMode: null,
      recordingClipLength: null,
      recordingEndClipMotionStops: null,
      recordingRetriggerInterval: null,
    });
  }
  const scope = CameraConfig.resolveScopeName(camConfig);
  const enforceQuality =
    camConfig.enforce_streaming_quality !== undefined
      ? camConfig.enforce_streaming_quality
      : (baseCfg.enforce_streaming_quality ?? true);

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
    explicitClipLen !== undefined || explicitEndEarly !== undefined || explicitRetrigger !== undefined;

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
        'power_working_mode=0 (Optimal Battery Life) hardcodes 20s early-ending clips on Eufy firmware, ' +
          'which conflicts with hold_secs=' +
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
    explicitEndEarly !== undefined && explicitEndEarly !== null ? Boolean(explicitEndEarly) : timers.letEufyDecideEnd;

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

const RTSP_DIRECT_IGNORED_CAMERA_KEYS = Object.freeze([
  'station_serial',
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
  'sync_power',
  'track_stuck_spotlight',
  'power_working_mode',
  'recording_clip_length',
  'recording_end_early',
  'recording_retrigger_interval',
  'enforce_streaming_quality',
  'trigger_events',
  'startup_snapshot',
  'telemetry',
]);

const RTSP_DIRECT_IGNORED_TOP_LEVEL_KEYS = Object.freeze([
  'hold_secs',
  'stream_max_secs',
  'frigate_event_secs',
  'end_early',
  'idle_timeout_secs',
  'view_linger_secs',
  'view_max_secs',
  'view_cooldown_secs',
  'view_has_priority',
  'use_rtsp',
  'backfill_enabled',
  'backfill_delay_secs',
  'sync_power',
  'track_stuck_spotlight',
  'enforce_streaming_quality',
  'low_battery_threshold',
  'critical_battery_threshold',
  'low_battery_hold_secs',
  'low_battery_wake_on_view',
  'telemetry_poll_secs',
  'telemetry',
  'forward_face_names',
  'ring_label',
  'trigger_events',
  'event_priorities',
  'startup_snapshot',
  'instant_event_snapshot',
  'snapshot_capture_delay_secs',
]);

const SYNC_POWER_IGNORED_CAMERA_KEYS = Object.freeze([
  'power_working_mode',
  'recording_clip_length',
  'recording_end_early',
  'recording_retrigger_interval',
]);

const CARD_NONE_IGNORED_KEYS = Object.freeze(['card_position', 'card_show_on_live', 'telemetry']);
const TELEMETRY_SUB_KEYS = Object.freeze(['battery', 'power_source', 'wifi', 'rssi', 'temperature', 'last_seen']);
const MINIMAL_IGNORED_TELEMETRY_KEYS = Object.freeze(['temperature', 'last_seen']);

/**
 * Logs startup warnings when explicitly specified per-camera mode, transport, timer, or Power Manager
 * options are ignored due to direct rtsp_url, the resolved camera mode, or sync_power=false.
 *
 * @param {Record<string, *>} rawCam - Original un-normalized camera configuration object.
 * @param {{ timers: ReturnType<typeof resolveCameraTimers>, scope: string }} ctx - Resolved timers and scope.
 * @param {Record<string, *>} [baseCfg=rawLoadedCfg] - Global configuration object.
 */
function warnIgnoredCameraModeOptions(rawCam, {timers, scope}, baseCfg = rawLoadedCfg) {
  if (!rawCam || typeof rawCam !== 'object') return;
  if (timers.rtspDirect) {
    const ignored = RTSP_DIRECT_IGNORED_CAMERA_KEYS.filter((key) => rawCam[key] !== undefined);
    if (ignored.length > 0) {
      log.warn(
        scope,
        'ignoring ' +
          ignored.join(', ') +
          ' when rtsp_url is set (direct RTSP streams continuously without Eufy WS or session timeouts)'
      );
    }
    return;
  }
  if (rawCam.backfill_only !== undefined && timers.mode !== CAMERA_MODES.CUSTOM) {
    log.warn(
      scope,
      'ignoring backfill_only=' +
        rawCam.backfill_only +
        ' in mode="' +
        timers.mode +
        '" (backfill_only only applies in mode="custom")'
    );
  }
  if (
    rawCam.use_rtsp !== undefined &&
    (timers.mode === CAMERA_MODES.RTSP || timers.mode === CAMERA_MODES.P2P) &&
    Boolean(rawCam.use_rtsp) !== timers.useRtsp
  ) {
    log.warn(scope, 'ignoring use_rtsp=' + rawCam.use_rtsp + ' in mode="' + timers.mode + '"');
  }
  if (rawCam.idle_timeout_secs !== undefined && Number(rawCam.idle_timeout_secs) > 0 && timers.alwaysBackfill) {
    log.warn(
      scope,
      'ignoring idle_timeout_secs=' +
        rawCam.idle_timeout_secs +
        ' in backfill-only mode (motion events replay clips instead of starting live streams)'
    );
  }
  if ((rawCam.sync_power ?? baseCfg.sync_power ?? true) === false) {
    const ignoredPower = SYNC_POWER_IGNORED_CAMERA_KEYS.filter(
      (key) =>
        rawCam[key] !== undefined &&
        !(key === 'recording_end_early' && timers.mode === CAMERA_MODES.CUSTOM && rawCam.end_early === undefined)
    );
    if (ignoredPower.length > 0) {
      log.warn(scope, 'ignoring ' + ignoredPower.join(', ') + ' because sync_power=false');
    }
  }
}

/**
 * Logs startup warnings when explicitly specified per-camera status card, telemetry, or
 * startup_snapshot options are ignored due to card_theme, card_position, or sleep_screen.
 *
 * @param {Record<string, *>} rawCam - Original un-normalized camera configuration object.
 * @param {{
 *   timers: ReturnType<typeof resolveCameraTimers>,
 *   cardConfig: ReturnType<typeof resolveCardConfig>,
 *   scope: string
 * }} ctx - Resolved camera timers, cardConfig, and scope.
 */
function warnIgnoredCameraCardOptions(rawCam, {timers, cardConfig, scope}) {
  if (!rawCam || typeof rawCam !== 'object') return;
  if (cardConfig.theme === CARD_THEMES.NONE) {
    const ignoredCard = CARD_NONE_IGNORED_KEYS.filter(
      (key) => rawCam[key] !== undefined && !(timers.rtspDirect && key === 'telemetry')
    );
    if (ignoredCard.length > 0) {
      log.warn(scope, 'ignoring ' + ignoredCard.join(', ') + ' when card_theme="none"');
    }
  } else {
    if (
      cardConfig.position === CARD_POSITIONS.CENTER &&
      cardConfig.theme !== CARD_THEMES.HUD &&
      rawCam.card_show_on_live === true
    ) {
      log.warn(
        scope,
        'ignoring card_show_on_live=true when card_position="center" (centered status cards only render while sleeping)'
      );
    }
    const rawTel = !timers.rtspDirect ? rawCam.telemetry : null;
    if (rawTel && typeof rawTel === 'object') {
      if (rawTel.enabled === false) {
        const ignoredTel = TELEMETRY_SUB_KEYS.filter((key) => rawTel[key] === true).map((key) => 'telemetry.' + key);
        if (ignoredTel.length > 0) {
          log.warn(scope, 'ignoring ' + ignoredTel.join(', ') + ' because telemetry.enabled=false');
        }
      } else if (cardConfig.theme === CARD_THEMES.MINIMAL) {
        const ignoredMinTel = MINIMAL_IGNORED_TELEMETRY_KEYS.filter((key) => rawTel[key] === true).map(
          (key) => 'telemetry.' + key
        );
        if (ignoredMinTel.length > 0) {
          log.warn(scope, 'ignoring ' + ignoredMinTel.join(', ') + ' when card_theme="minimal"');
        }
      }
    }
  }
  if (!timers.rtspDirect && cardConfig.sleepScreen !== SLEEP_SCREENS.SNAPSHOT && Boolean(rawCam.startup_snapshot)) {
    log.warn(
      scope,
      'ignoring startup_snapshot=' + rawCam.startup_snapshot + ' when sleep_screen="' + cardConfig.sleepScreen + '"'
    );
  }
}

/**
 * Logs startup warnings when explicitly specified top-level bridge configuration or environment
 * options are ignored due to BRIDGE_HWACCEL mode, global card/sleep settings, or all cameras
 * specifying direct rtsp_url.
 *
 * @param {Record<string, *>} rawCfg - Raw top-level configuration object.
 * @param {string} hwMode - Normalized hardware acceleration mode.
 * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
 */
function warnIgnoredTopLevelOptions(rawCfg, hwMode, env = process.env) {
  if (!rawCfg || typeof rawCfg !== 'object') return;
  const cams = Array.isArray(rawCfg.cameras) ? rawCfg.cameras : [];
  const explicitHwDevice = readEnvString(env, 'BRIDGE_HWACCEL_DEVICE');
  if (explicitHwDevice && hwMode !== HWACCEL_MODES.VAAPI && hwMode !== HWACCEL_MODES.QSV) {
    log.warn(
      'bridge',
      'ignoring BRIDGE_HWACCEL_DEVICE="' +
        explicitHwDevice +
        '" because BRIDGE_HWACCEL is ' +
        (hwMode ? '"' + hwMode + '"' : 'disabled')
    );
  }
  const allDirect = cams.length > 0 && cams.every((cam) => hasDirectRtspUrl(cam));
  if (allDirect) {
    const ignoredDirect = RTSP_DIRECT_IGNORED_TOP_LEVEL_KEYS.filter(
      (key) => rawCfg[key] !== undefined && rawCfg[key] !== ''
    );
    if (ignoredDirect.length > 0) {
      log.warn('bridge', 'ignoring ' + ignoredDirect.join(', ') + ' because all cameras specify rtsp_url');
    }
  }
  if (rawCfg.card_theme !== undefined && normalizeCardTheme(rawCfg.card_theme) === CARD_THEMES.NONE) {
    const anyVisibleCamCard = cams.some(
      (cam) => cam && cam.card_theme !== undefined && normalizeCardTheme(cam.card_theme) !== CARD_THEMES.NONE
    );
    if (!anyVisibleCamCard) {
      const ignoredTopCard = CARD_NONE_IGNORED_KEYS.filter(
        (key) => rawCfg[key] !== undefined && !(allDirect && key === 'telemetry')
      );
      if (ignoredTopCard.length > 0) {
        log.warn('bridge', 'ignoring ' + ignoredTopCard.join(', ') + ' when card_theme="none"');
      }
    }
  }
  if (
    !allDirect &&
    rawCfg.sleep_screen !== undefined &&
    normalizeSleepScreen(rawCfg.sleep_screen) !== SLEEP_SCREENS.SNAPSHOT &&
    Boolean(rawCfg.startup_snapshot)
  ) {
    const anySnapshotCam = cams.some(
      (cam) =>
        cam && cam.sleep_screen !== undefined && normalizeSleepScreen(cam.sleep_screen) === SLEEP_SCREENS.SNAPSHOT
    );
    if (!anySnapshotCam) {
      log.warn(
        'bridge',
        'ignoring startup_snapshot=' +
          rawCfg.startup_snapshot +
          ' when sleep_screen="' +
          normalizeSleepScreen(rawCfg.sleep_screen) +
          '"'
      );
    }
  }
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
  const {serial, name, explicitSerial} = CameraConfig.normalizeIdentity(camConfig);
  const title = camConfig.title ? String(camConfig.title) : '';
  const stationSerial = camConfig.station_serial ? String(camConfig.station_serial) : '';
  const rtspUrl = stripRtspUrlFragment(camConfig.rtsp_url);
  /** @type {Record<string, *>} */
  const normalizedCam = {
    ...camConfig,
    serial,
    explicitSerial,
    name,
    title,
    station_serial: stationSerial,
    rtsp_url: rtspUrl,
  };

  const timers = resolveCameraTimers(normalizedCam, baseCfg);
  const triggers = resolveCameraTriggers(normalizedCam, baseCfg.triggers instanceof Set ? baseCfg.triggers : TRIGGERS);
  const cardConfig = resolveCardConfig(normalizedCam, baseCfg);
  const telemetryConfig = resolveTelemetryConfig(normalizedCam, baseCfg);
  const hwRecordingConfig = resolveHardwareRecordingConfig(normalizedCam, timers, baseCfg);
  const scope = CameraConfig.resolveScopeName(normalizedCam);
  warnIgnoredCameraModeOptions(camConfig, {timers, scope}, baseCfg);
  warnIgnoredCameraCardOptions(camConfig, {timers, cardConfig, scope});

  return Object.freeze(
    new CameraConfig({
      ...normalizedCam,
      priority: clampNum(normalizedCam.priority, MIN_CAMERA_PRIORITY, MAX_CAMERA_PRIORITY, DEFAULT_CAMERA_PRIORITY),
      preserveAspect: Boolean(normalizedCam.preserve_aspect_ratio ?? baseCfg.preserve_aspect_ratio ?? true),
      autoFrigateMask: Boolean(normalizedCam.auto_frigate_mask ?? baseCfg.auto_frigate_mask ?? true),
      cardShowOnLive: Boolean(normalizedCam.card_show_on_live ?? baseCfg.card_show_on_live ?? true),
      trackStuckSpotlight: Boolean(
        normalizedCam.track_stuck_spotlight ?? baseCfg.track_stuck_spotlight ?? DEFAULT_TRACK_STUCK_SPOTLIGHT
      ),
      startupSnapshot: timers.rtspDirect ? false : (normalizedCam.startup_snapshot ?? baseCfg.startup_snapshot ?? true),
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
   * @param {Record<string, *>} rawCfg - Raw parsed YAML configuration object.
   * @param {Record<string, string|undefined>} [env=process.env] - Environment dictionary.
   */
  constructor(rawCfg, env = process.env) {
    const cloned = {
      ...rawCfg,
      cameras: Array.isArray(rawCfg.cameras)
        ? rawCfg.cameras.map((c) => {
            const copy = {...c};
            if (c && typeof c === 'object' && EXPLICIT_SERIAL_SYM in c) {
              Object.defineProperty(copy, EXPLICIT_SERIAL_SYM, {
                value: c[EXPLICIT_SERIAL_SYM],
                enumerable: false,
                configurable: true,
              });
            }
            return copy;
          })
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
    const width = clampNum(this._raw.width, 320, 3840, 1280) & ~1;
    const height = clampNum(this._raw.height, 240, 2160, 720) & ~1;
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
    const cooldownMs = clampNum(this._raw.view_cooldown_secs, 0, MAX_EVENT_SECS, 5) * MS_PER_SECOND;
    const snapDelayMs =
      clampNum(this._raw.snapshot_capture_delay_secs, 0, MAX_RETRIGGER_INTERVAL_SECS, 3) * MS_PER_SECOND;

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
    this._built.enforce_streaming_quality = this._raw.enforce_streaming_quality ?? true;
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
const FRAME = (W * H * 3) / 2;
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
