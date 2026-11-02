// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Configuration loading, validation, numeric clamping, and normalized option resolvers.
 */
'use strict';

const fs = require('fs');
const {log, initLogger} = require('./logger');

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
  const n = Number(val ?? fallback);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

// Load and validate configuration from BRIDGE_CONFIG, CONFIG_PATH, or the default container path.
const cfgPath = process.env.BRIDGE_CONFIG || process.env.CONFIG_PATH || '/config/config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
for (const k of ['eufy_ws', 'rtsp_publish', 'go2rtc_api']) {
  if (!cfg[k]) {
    throw new Error('config.json: "' + k + '" is required');
  }
}
if (!Array.isArray(cfg.cameras) || !cfg.cameras.length || cfg.cameras.some((c) => !c.name || !c.serial)) {
  throw new Error('config.json: "cameras" must list at least one {"name", "serial"}');
}
if (!cfg.rtsp_publish.includes('{name}')) {
  throw new Error('config.json: "rtsp_publish" must contain {name}');
}

const ACTIVE_LOG_LEVEL_NAME = initLogger(process.env.LOG_LEVEL || cfg.log_level || 'info');

// Stream timing and arbitration limits (in milliseconds).
const MAX_MS = clampNum(cfg.max_secs, 10, 86400, 900) * 1000;
const VIEW_MAX_MS = clampNum(cfg.view_max_secs, 10, 86400, 300) * 1000;
const HOLD_MS = Math.min(MAX_MS, clampNum(cfg.hold_secs, 5, 86400, 60) * 1000);
const LINGER_MS = Math.min(VIEW_MAX_MS, clampNum(cfg.view_linger_secs, 5, 86400, 20) * 1000);
const COOLDOWN_MS = clampNum(cfg.viewer_cooldown_secs, 0, 3600, 5) * 1000;
const EVENT_SECS = clampNum(cfg.event_secs, 1, 3600, 30);
const SNAP_DELAY_MS = clampNum(cfg.snapshot_delay_secs, 0, 60, 3) * 1000;

// Doorbell, HomeBase 3 face recognition, RTSP, backfill, mask sync, and aspect ratio options.
const RING_LABEL = cfg.ring_label || 'person';
const FORWARD_FACE_NAMES = cfg.forward_face_names !== false;
const GLOBAL_PRESERVE_ASPECT = cfg.preserve_aspect_ratio !== false;
const GLOBAL_DIM_BACKGROUND = Boolean(cfg.card_dim_background ?? false);
const PREEMPT_EVENT_STREAMS = cfg.preempt_event_streams !== false;
const LET_EUFY_DECIDE_END = cfg.let_eufy_decide_event_end !== false;
const GLOBAL_USE_RTSP = cfg.use_rtsp !== false;
const BACKFILL_DOWNLOADS = cfg.backfill_downloads !== false;
const BACKFILL_DELAY_MS = clampNum(cfg.backfill_delay_secs, 2, 120, 5) * 1000;
const GLOBAL_AUTO_FRIGATE_MASK = cfg.auto_frigate_mask !== false;
const GLOBAL_CARD_SHOW_ON_LIVE = cfg.card_show_on_live !== false;
const INSTANT_EVENT_SNAPSHOT = cfg.instant_event_snapshot !== false;

// Smart battery conservation, periodic telemetry refresh, and startup snapshot probe options.
const EARLY_SLEEP_MS = clampNum(cfg.early_sleep_secs, 0, 3600, 0) * 1000;
const LOW_BAT_THRESHOLD = clampNum(cfg.low_battery_threshold, 0, 100, 20);
const LOW_BAT_HOLD_MS = clampNum(cfg.low_battery_hold_secs, 5, 3600, 20) * 1000;
const LOW_BAT_WAKE_ON_VIEW = Boolean(cfg.low_battery_wake_on_view ?? false);
const ENFORCE_QUALITY = cfg.enforce_streaming_quality ?? true;
const TELEMETRY_POLL_MS = clampNum(cfg.telemetry_poll_secs, 0, 86400, 300) * 1000;
const GLOBAL_STARTUP_SNAPSHOT = cfg.startup_snapshot !== undefined ? cfg.startup_snapshot : true;

// Optional hardware-accelerated encoding ('vaapi', 'qsv', 'nvenc', 'v4l2m2m').
const RAW_HWACCEL =
    cfg.hwaccel === true ? 'vaapi' : typeof cfg.hwaccel === 'string' ? cfg.hwaccel.toLowerCase().trim() : '';
const HWACCEL_MODE = ['vaapi', 'qsv', 'nvenc', 'v4l2m2m'].includes(RAW_HWACCEL) ? RAW_HWACCEL : '';
const HWACCEL_DEVICE = cfg.hwaccel_device || '/dev/dri/renderD128';

// Video dimensions (enforced even for YUV420p) and raw frame size in bytes (1.5 bytes per pixel).
const W = clampNum(cfg.width, 320, 3840, 1280) & ~1;
const H = clampNum(cfg.height, 240, 2160, 720) & ~1;
const FRAME = (W * H * 3) / 2;
const LIVE_FPS = clampNum(cfg.live_fps, 1, 60, 15);
const IDLE_FPS = clampNum(cfg.idle_fps, 1, 30, 5);

// Audio configuration: 16 kHz, 16-bit signed little-endian mono PCM sent in 100 ms chunks.
const AUDIO = cfg.audio !== false;
const RATE = 16000;
const AUDIO_TICK = 100;
const AUDIO_CHUNK = (RATE * 2 * AUDIO_TICK) / 1000;
const SILENCE = Buffer.alloc(AUDIO_CHUNK);

// Four-color semantic palette used across 'default', 'icons', and 'minimal' themes.
const COLOR_GREEN = [74, 222, 128];
const COLOR_BLUE = [56, 189, 248];
const COLOR_YELLOW = [250, 204, 21];
const COLOR_RED = [248, 113, 113];

// Mapping of Eufy event keywords to Frigate event labels.
const LABELS = [
  ['person', 'person'],
  ['ring', RING_LABEL],
  ['vehicle', 'car'],
  ['dog', 'dog'],
  ['pet', 'dog'],
];

// Built-in priority boosts by Eufy event type (combined with per-camera config priority).
const EVENT_PRIORITIES = [
  ['ring', 1000],
  ['identity person', 300],
  ['stranger', 200],
  ['person', 200],
  ['vehicle', 100],
  ['pet', 100],
  ['dog', 100],
  ['crying', 50],
  ['sound', 50],
  ['motion', 10],
];

/**
 * Returns the built-in priority boost for a Eufy trigger event name.
 *
 * @param {string} evName - Eufy event string.
 * @returns {number} Priority boost score.
 */
function getEventPriority(evName) {
  const s = String(evName || '').toLowerCase();
  for (const [keyword, score] of EVENT_PRIORITIES) {
    if (s.includes(keyword)) return score;
  }
  return 10;
}

/**
 * Builds the normalized Set of Eufy event names that wake a camera.
 * Accepts both full eufy-security-ws event names (such as 'motion detected') and shorthand
 * names from README.md (such as 'motion', 'person', 'stranger', 'ringing').
 *
 * @param {string[]|undefined} rawEvents - Optional array of trigger event strings from config.json.
 * @returns {Set<string>} Normalized set of Eufy event names.
 */
function buildTriggerSet(rawEvents) {
  const aliases = {
    motion: ['motion detected'],
    person: ['person detected', 'identity person detected', 'stranger person detected'],
    pet: ['pet detected'],
    vehicle: ['vehicle detected'],
    dog: ['dog detected'],
    stranger: ['stranger person detected'],
    'identity person': ['identity person detected'],
    sound: ['sound detected', 'crying detected'],
    ring: ['rings'],
    rings: ['rings'],
    ringing: ['rings'],
  };
  const defaults = [
    'motion detected',
    'person detected',
    'pet detected',
    'vehicle detected',
    'dog detected',
    'stranger person detected',
    'identity person detected',
    'sound detected',
    'rings',
  ];
  const input = Array.isArray(rawEvents) && rawEvents.length ? rawEvents : defaults;
  const out = new Set();
  for (const item of input) {
    const key = String(item).toLowerCase().trim();
    out.add(key);
    if (aliases[key]) {
      for (const expanded of aliases[key]) {
        out.add(expanded);
      }
    }
  }
  return out;
}

const TRIGGERS = buildTriggerSet(cfg.trigger_events);

/**
 * Resolves a writable directory for storing cached camera snapshots across restarts.
 *
 * @returns {string} Writable directory path for snapshot cache files.
 */
function resolveCacheDir() {
  const preferred = cfg.cache_dir || '/config/cache';
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
 * @returns {string} Validated hwaccel mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m') or '' for software.
 */
function resolveHwaccel() {
  if (!HWACCEL_MODE) return '';
  if ((HWACCEL_MODE === 'vaapi' || HWACCEL_MODE === 'qsv') && !fs.existsSync(HWACCEL_DEVICE)) {
    log.warn(
        'bridge',
        'hwaccel "' +
        HWACCEL_MODE +
        '" requested, but ' +
        HWACCEL_DEVICE +
        ' is not accessible; falling back to software libx264'
    );
    return '';
  }
  return HWACCEL_MODE;
}

const ACTIVE_HWACCEL = resolveHwaccel();

/**
 * Resolves the effective telemetry configuration for a camera by merging global cfg.telemetry
 * settings with any per-camera camConfig.telemetry overrides.
 *
 * @param {Record<string, *>} camConfig - Individual camera configuration object from cfg.cameras.
 * @returns {Record<string, boolean>} Normalized telemetry options object.
 */
function resolveTelemetryConfig(camConfig) {
  const globalCfg = cfg.telemetry;
  const camCfg = camConfig.telemetry;

  const globalEnabled =
      globalCfg === undefined ? true : typeof globalCfg === 'boolean' ? globalCfg : globalCfg.enabled !== false;
  const camEnabled =
      camCfg === undefined ? globalEnabled : typeof camCfg === 'boolean' ? camCfg : camCfg.enabled !== false;

  const pickOption = (key) => {
    if (camCfg && typeof camCfg === 'object' && key in camCfg) return Boolean(camCfg[key]);
    if (globalCfg && typeof globalCfg === 'object' && key in globalCfg) return Boolean(globalCfg[key]);
    return true;
  };

  return {
    enabled: camEnabled,
    battery: camEnabled && pickOption('battery'),
    powerSource: camEnabled && pickOption('power_source'),
    wifi: camEnabled && pickOption('wifi'),
    rssi: camEnabled && pickOption('rssi'),
    temperature: camEnabled && pickOption('temperature'),
    lastSeen: camEnabled && pickOption('last_seen'),
  };
}

/**
 * Resolves the effective status card theme ('default', 'icons', 'minimal', 'none'),
 * card_position ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'), and
 * card_background ('snapshot', 'slate', 'black') for a camera.
 *
 * @param {Record<string, *>} camConfig - Individual camera configuration object from cfg.cameras.
 * @returns {{ theme: string, position: string, background: string, dimBackground: boolean }}
 */
function resolveCardConfig(camConfig) {
  const scope = camConfig.name || 'bridge';
  const rawTheme =
      camConfig.card_theme !== undefined
          ? camConfig.card_theme
          : cfg.card_theme !== undefined
              ? cfg.card_theme
              : 'default';
  const rawPos =
      camConfig.card_position ||
      camConfig.card_corner ||
      cfg.card_position ||
      cfg.card_corner ||
      'center';
  const hasExplicitBg = camConfig.card_background !== undefined || cfg.card_background !== undefined;
  const rawBg = camConfig.card_background !== undefined ? camConfig.card_background : cfg.card_background;
  const dimBackground =
      camConfig.card_dim_background !== undefined
          ? Boolean(camConfig.card_dim_background)
          : GLOBAL_DIM_BACKGROUND;

  const normalizePosition = (val) => {
    const s = String(val || '')
        .toLowerCase()
        .trim()
        .replace(/[_\s]+/g, '-');
    if (['tl', 'top-left', 'topleft', 'left-top', 'lefttop'].includes(s)) return 'top-left';
    if (['tr', 'top-right', 'topright', 'right-top', 'righttop'].includes(s)) return 'top-right';
    if (['bl', 'bottom-left', 'bottomleft', 'left-bottom', 'leftbottom', 'corner'].includes(s)) {
      return 'bottom-left';
    }
    if (['br', 'bottom-right', 'bottomright', 'right-bottom', 'rightbottom'].includes(s)) {
      return 'bottom-right';
    }
    if (s && s !== 'center' && s !== 'middle') {
      log.warn(scope, 'unknown card_position "' + val + '", defaulting to "center"');
    }
    return 'center';
  };

  let position = normalizePosition(rawPos);
  let theme = 'default';
  const themeStr = String(rawTheme)
      .toLowerCase()
      .trim()
      .replace(/[_\s]+/g, '-');

  if (
      rawTheme === false ||
      ['none', 'blank', 'black', 'off', 'disabled'].includes(themeStr)
  ) {
    theme = 'none';
  } else if (['icons', 'icons-only', 'icon', 'corner-icons'].includes(themeStr)) {
    theme = 'icons';
  } else if (['minimal', 'dots', 'three-dots', '3dots', 'corner-minimal', 'corner-simple'].includes(themeStr)) {
    theme = 'minimal';
  } else if (
      [
        'corner',
        'corner-card',
        'corner-full',
        'top-left',
        'topleft',
        'left-top',
        'tl',
        'top-right',
        'topright',
        'right-top',
        'tr',
        'bottom-left',
        'bottomleft',
        'left-bottom',
        'bl',
        'bottom-right',
        'bottomright',
        'right-bottom',
        'br',
      ].includes(themeStr)
  ) {
    theme = 'default';
    if (position === 'center') {
      position = normalizePosition(themeStr);
    }
  } else if (themeStr !== 'default') {
    log.warn(scope, 'unknown card_theme "' + rawTheme + '", defaulting to "default"');
  }

  let background = 'snapshot';
  if (!hasExplicitBg && themeStr === 'black') {
    background = 'black';
  } else if (hasExplicitBg) {
    const bgStr = String(rawBg).toLowerCase().trim();
    if (rawBg === false || ['none', 'blank', 'black', 'off'].includes(bgStr)) {
      background = 'black';
    } else if (bgStr === 'slate' || bgStr === 'gray' || bgStr === 'grey' || bgStr === 'solid') {
      background = 'slate';
    } else if (bgStr !== 'snapshot') {
      log.warn(scope, 'unknown card_background "' + rawBg + '", defaulting to "snapshot"');
    }
  }

  return {theme, position, background, dimBackground};
}

module.exports = {
  cfgPath,
  cfg,
  clampNum,
  ACTIVE_LOG_LEVEL_NAME,
  MAX_MS,
  VIEW_MAX_MS,
  HOLD_MS,
  LINGER_MS,
  COOLDOWN_MS,
  EVENT_SECS,
  SNAP_DELAY_MS,
  RING_LABEL,
  FORWARD_FACE_NAMES,
  GLOBAL_PRESERVE_ASPECT,
  GLOBAL_DIM_BACKGROUND,
  PREEMPT_EVENT_STREAMS,
  LET_EUFY_DECIDE_END,
  GLOBAL_USE_RTSP,
  BACKFILL_DOWNLOADS,
  BACKFILL_DELAY_MS,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
  INSTANT_EVENT_SNAPSHOT,
  EARLY_SLEEP_MS,
  LOW_BAT_THRESHOLD,
  LOW_BAT_HOLD_MS,
  LOW_BAT_WAKE_ON_VIEW,
  ENFORCE_QUALITY,
  TELEMETRY_POLL_MS,
  GLOBAL_STARTUP_SNAPSHOT,
  HWACCEL_MODE,
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
  COLOR_GREEN,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_RED,
  LABELS,
  EVENT_PRIORITIES,
  TRIGGERS,
  CACHE_DIR,
  getEventPriority,
  buildTriggerSet,
  resolveCacheDir,
  resolveHwaccel,
  resolveTelemetryConfig,
  resolveCardConfig,
};
