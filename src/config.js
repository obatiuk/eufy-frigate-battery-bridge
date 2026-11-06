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

const REQUIRED_CONFIG_KEYS = ['eufy_ws', 'rtsp_publish', 'go2rtc_api'];
const SUPPORTED_HWACCEL_MODES = new Set(['vaapi', 'qsv', 'nvenc', 'v4l2m2m']);

const TRIGGER_EVENT_ALIASES = Object.freeze({
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
});

const DEFAULT_TRIGGER_EVENTS = Object.freeze([
  'motion detected',
  'person detected',
  'pet detected',
  'vehicle detected',
  'dog detected',
  'stranger person detected',
  'identity person detected',
  'sound detected',
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
const EVENT_PRIORITIES = Object.freeze([
  ['ring', 1000],
  ['identity person', 300],
  ['stranger', 200],
  ['person', 200],
  ['vehicle', 100],
  ['pet', 100],
  ['dog', 100],
  ['crying', 50],
  ['sound', 50],
  ['motion', DEFAULT_EVENT_PRIORITY],
]);

// Semantic palette used across 'detailed', 'icons', and 'minimal' themes:
// Red = Live only, Grey = Asleep, Green = Healthy, Blue = Waking/Charging/Good/Cold,
// Yellow = Waiting/Medium/Fair/Warm, Purple = Critical/Low-Battery/Poor/Hot.
const COLOR_RED = [239, 68, 68];
const COLOR_GREY = [180, 180, 190];
const COLOR_GREEN = [74, 222, 128];
const COLOR_BLUE = [56, 189, 248];
const COLOR_YELLOW = [250, 204, 21];
const COLOR_PURPLE = [232, 121, 249];

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
 * Validates a parsed configuration object and throws descriptive errors on invalid structure.
 *
 * @param {Record<string, *>} rawCfg - Parsed JSON configuration object.
 */
function validateConfig(rawCfg) {
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!rawCfg[key]) {
      throw new Error('config.json: "' + key + '" is required');
    }
  }

  if (Array.isArray(rawCfg.cameras)) {
    for (const cam of rawCfg.cameras) {
      if (cam && !cam.name && cam.serial) {
        cam.name = String(cam.serial).trim();
      }
    }
  }

  const hasValidCameras =
      Array.isArray(rawCfg.cameras) &&
      rawCfg.cameras.length > 0 &&
      rawCfg.cameras.every((cam) => Boolean(cam && cam.name && cam.serial));

  if (!hasValidCameras) {
    throw new Error('config.json: "cameras" must list at least one {"serial"}');
  }

  if (!rawCfg.rtsp_publish.includes('{name}')) {
    throw new Error('config.json: "rtsp_publish" must contain {name}');
  }
}

/**
 * Returns the built-in priority boost for a Eufy trigger event name.
 *
 * @param {string} evName - Eufy event string.
 * @returns {number} Priority boost score.
 */
function getEventPriority(evName) {
  const normalized = String(evName || '').toLowerCase();
  for (const [keyword, score] of EVENT_PRIORITIES) {
    if (normalized.includes(keyword)) {
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
    case 'bottom-left':
      return 'bottom-left';
    case 'top-left':
      return 'top-left';
    case 'top-right':
      return 'top-right';
    case 'bottom-right':
      return 'bottom-right';
    case 'center':
      return 'center';
    default:
      log.warn(scope, 'unknown card_position "' + rawPos + '", defaulting to "bottom-left"');
      return 'bottom-left';
  }
}

/**
 * Normalizes a card_theme string into one of the 4 supported themes.
 *
 * @param {*} rawTheme - Raw card_theme value from config.
 * @param {string} [scope='bridge'] - Log scope for warnings.
 * @returns {'icons'|'minimal'|'detailed'|'none'}
 */
function normalizeCardTheme(rawTheme, scope = 'bridge') {
  if (rawTheme === false) {
    return 'none';
  }

  const token = String(rawTheme ?? 'icons')
      .toLowerCase()
      .trim();

  switch (token) {
    case '':
    case 'icons':
      return 'icons';
    case 'minimal':
      return 'minimal';
    case 'detailed':
      return 'detailed';
    case 'none':
      return 'none';
    default:
      log.warn(scope, 'unknown card_theme "' + rawTheme + '", defaulting to "icons"');
      return 'icons';
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
    return 'snapshot';
  }
  if (rawScreen === false) {
    return 'black';
  }

  const token = String(rawScreen).toLowerCase().trim();
  switch (token) {
    case 'snapshot':
      return 'snapshot';
    case 'slate':
      return 'slate';
    case 'black':
      return 'black';
    default:
      log.warn(scope, 'unknown sleep_screen "' + rawScreen + '", defaulting to "snapshot"');
      return 'snapshot';
  }
}

/**
 * Loads and validates the configuration object from BRIDGE_CONFIG, CONFIG_PATH,
 * /config/config.json, or falls back to an in-memory default test configuration.
 *
 * @returns {Record<string, *>}
 */
function loadConfig() {
  const explicitPath = process.env.BRIDGE_CONFIG || process.env.CONFIG_PATH;
  const defaultPath = '/config/config.json';
  const targetPath = explicitPath || (fs.existsSync(defaultPath) ? defaultPath : '');
  const parsed = targetPath
      ? JSON.parse(fs.readFileSync(targetPath, 'utf8'))
      : {
          eufy_ws: 'ws://eufy-security-ws:3000',
          go2rtc_api: 'http://frigate:1984',
          rtsp_publish: 'rtsp://frigate:8554/{name}',
          frigate_api: 'http://frigate:5000',
          cameras: [{serial: 'T8161T0000000000', mode: 'rtsp'}],
        };
  validateConfig(parsed);
  return parsed;
}

const cfg = loadConfig();

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
const PREEMPT_EVENT_STREAMS = cfg.preempt_event_streams !== false;
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
const HTTP_PORT = clampNum(cfg.http_port ?? process.env.HTTP_PORT, 0, 65535, 8080);
const GLOBAL_STARTUP_SNAPSHOT = cfg.startup_snapshot !== undefined ? cfg.startup_snapshot : true;

/**
 * Normalizes the requested hardware acceleration mode from config.json.
 *
 * @param {*} rawHwaccel - Raw hwaccel value from config.json.
 * @returns {string}
 */
function parseHwaccelMode(rawHwaccel) {
  if (rawHwaccel === true) {
    return 'vaapi';
  }
  if (typeof rawHwaccel !== 'string') {
    return '';
  }
  const normalized = rawHwaccel.toLowerCase().trim();
  return SUPPORTED_HWACCEL_MODES.has(normalized) ? normalized : '';
}

const HWACCEL_MODE = parseHwaccelMode(cfg.hwaccel);
const HWACCEL_DEVICE = cfg.hwaccel_device || '/dev/dri/renderD128';

/**
 * Resolves live_fps and idle_fps with defensive non-contradiction clamping (idleFps <= liveFps).
 *
 * @param {Record<string, *>} [rawCfg=cfg] - Raw configuration object.
 * @returns {{ liveFps: number, idleFps: number }}
 */
function resolveFrameRates(rawCfg = cfg) {
  const liveFps = clampNum(rawCfg.live_fps, 5, 60, 15);
  const rawIdleFps = clampNum(rawCfg.idle_fps, 1, 30, 5);
  if (rawIdleFps > liveFps) {
    log.warn(
        'bridge',
        'idle_fps (' + rawIdleFps + ') exceeds live_fps (' + liveFps + '), clamping idle_fps to ' + liveFps
    );
  }
  return {liveFps, idleFps: Math.min(liveFps, rawIdleFps)};
}

// Video dimensions (enforced even for YUV420p) and raw frame size in bytes (1.5 bytes per pixel).
const W = clampNum(cfg.width, 320, 3840, 1280) & ~1;
const H = clampNum(cfg.height, 240, 2160, 720) & ~1;
const FRAME = (W * H * 3) / 2;
const {liveFps: LIVE_FPS, idleFps: IDLE_FPS} = resolveFrameRates(cfg);

// Audio configuration: 16 kHz, 16-bit signed little-endian mono PCM sent in 100 ms chunks.
const AUDIO = cfg.audio !== false;
const RATE = 16000;
const AUDIO_TICK = 100;
const AUDIO_CHUNK = (RATE * 2 * AUDIO_TICK) / 1000;
const SILENCE = Buffer.alloc(AUDIO_CHUNK);

// Mapping of Eufy event keywords to Frigate event labels.
const LABELS = [
  ['person', 'person'],
  ['ring', RING_LABEL],
  ['vehicle', 'car'],
  ['dog', 'dog'],
  ['pet', 'dog'],
];

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
  if (!HWACCEL_MODE) {
    return '';
  }
  const requiresRenderDevice = HWACCEL_MODE === 'vaapi' || HWACCEL_MODE === 'qsv';
  if (requiresRenderDevice && !fs.existsSync(HWACCEL_DEVICE)) {
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
 * Resolves a boolean flag from a telemetry config block (boolean or object).
 *
 * @param {boolean|Record<string, *>|undefined} block - Telemetry config block.
 * @param {boolean} fallback - Default value when undefined.
 * @returns {boolean}
 */
function isTelemetryBlockEnabled(block, fallback) {
  if (block === undefined) {
    return fallback;
  }
  if (typeof block === 'boolean') {
    return block;
  }
  return block.enabled !== false;
}

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

  const globalEnabled = isTelemetryBlockEnabled(globalCfg, true);
  const camEnabled = isTelemetryBlockEnabled(camCfg, globalEnabled);

  const pickOption = (key) => {
    if (camCfg && typeof camCfg === 'object' && key in camCfg) {
      return Boolean(camCfg[key]);
    }
    if (globalCfg && typeof globalCfg === 'object' && key in globalCfg) {
      return Boolean(globalCfg[key]);
    }
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
 * Resolves the effective status card theme, position, and sleeping screen backdrop for a camera.
 *
 * @param {Record<string, *>} camConfig - Individual camera configuration object from cfg.cameras.
 * @returns {{ theme: 'icons'|'minimal'|'detailed'|'none', position: 'center'|'top-left'|'top-right'|'bottom-left'|'bottom-right', sleepScreen: 'snapshot'|'slate'|'black' }}
 */
function resolveCardConfig(camConfig) {
  const scope = camConfig.name || camConfig.serial || 'bridge';
  const rawTheme = camConfig.card_theme ?? cfg.card_theme ?? 'icons';
  const rawPos = camConfig.card_position ?? cfg.card_position ?? 'bottom-left';
  const rawScreen = camConfig.sleep_screen ?? cfg.sleep_screen ?? 'snapshot';

  const position = normalizeCardPosition(rawPos, scope);
  const theme = normalizeCardTheme(rawTheme, scope);
  const sleepScreen = normalizeSleepScreen(rawScreen, scope);

  return {theme, position, sleepScreen};
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
const MIN_POWER_WORKING_MODE = 0;
const MAX_POWER_WORKING_MODE = 2;
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
 * @returns {Set<string>}
 */
function resolveCameraTriggers(camConfig = {}) {
  if (Array.isArray(camConfig.trigger_events) && camConfig.trigger_events.length > 0) {
    return buildTriggerSet(camConfig.trigger_events);
  }
  return TRIGGERS;
}

/**
 * Resolves the normalized streaming mode ('auto', 'rtsp', 'p2p', 'backfill', or 'custom') for a camera.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @returns {'auto'|'rtsp'|'p2p'|'backfill'|'custom'}
 */
function resolveCameraMode(camConfig = {}) {
  const scope = camConfig.name || camConfig.serial || 'bridge';
  if (camConfig.mode === undefined || camConfig.mode === null || camConfig.mode === '') {
    return 'auto';
  }
  const token = String(camConfig.mode).toLowerCase().trim();
  switch (token) {
    case 'auto':
      return 'auto';
    case 'rtsp':
      return 'rtsp';
    case 'p2p':
      return 'p2p';
    case 'backfill':
      return 'backfill';
    case 'custom':
      return 'custom';
    default:
      log.warn(scope, 'unknown camera mode "' + camConfig.mode + '", defaulting to "auto"');
      return 'auto';
  }
}

/**
 * Resolves per-camera stream timing and mode settings with mode-aware defaults and
 * defensive non-contradiction clamping.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
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
function resolveCameraTimers(camConfig = {}) {
  const scope = camConfig.name || camConfig.serial || 'bridge';
  const mode = resolveCameraMode(camConfig);
  const alwaysBackfill =
      mode === 'backfill' ||
      (mode === 'custom' && Boolean(camConfig.always_backfill ?? cfg.always_backfill));

  if (alwaysBackfill && (mode === 'rtsp' || camConfig.use_rtsp === true)) {
    log.warn(scope, 'cannot combine use_rtsp=true with backfill-only mode; disabling use_rtsp');
  }
  const requestedRtsp =
      mode === 'rtsp' ||
      Boolean(camConfig.rtsp_url) ||
      ((mode === 'auto' || mode === 'custom') &&
        (camConfig.use_rtsp !== undefined ? Boolean(camConfig.use_rtsp) : GLOBAL_USE_RTSP));
  const useRtsp = !alwaysBackfill && requestedRtsp;

  const rawBackfillDownloads =
      camConfig.backfill_downloads !== undefined
          ? Boolean(camConfig.backfill_downloads)
          : BACKFILL_DOWNLOADS;
  if (alwaysBackfill && !rawBackfillDownloads) {
    log.warn(
        scope,
        'cannot disable backfill_downloads in backfill-only mode; keeping backfill_downloads=true'
    );
  }
  const backfillDownloads = alwaysBackfill ? true : rawBackfillDownloads;

  const defaultHoldSecs = alwaysBackfill ? DEFAULT_BACKFILL_HOLD_SECS : DEFAULT_HOLD_SECS;
  const rawHoldSecs = camConfig.hold_secs ?? cfg.hold_secs;
  const holdSecs =
      rawHoldSecs !== undefined
          ? clampNum(rawHoldSecs, MIN_HOLD_SECS, MAX_HOLD_SECS, defaultHoldSecs)
          : defaultHoldSecs;
  const holdMs = holdSecs * 1000;

  const rawMaxMs =
      camConfig.max_secs !== undefined
          ? clampNum(camConfig.max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_MAX_SECS) * 1000
          : MAX_MS;
  if (rawMaxMs < holdMs) {
    log.warn(
        scope,
        'max_secs (' +
        Math.round(rawMaxMs / 1000) +
        's) is shorter than hold_secs (' +
        holdSecs +
        's), raising max_secs to ' +
        holdSecs +
        's'
    );
  }
  const maxMs = Math.max(holdMs, rawMaxMs);

  const rawLingerMs =
      camConfig.view_linger_secs !== undefined
          ? clampNum(camConfig.view_linger_secs, MIN_HOLD_SECS, MAX_HOLD_SECS, DEFAULT_LINGER_SECS) * 1000
          : LINGER_MS;
  const rawViewMaxMs =
      camConfig.view_max_secs !== undefined
          ? clampNum(camConfig.view_max_secs, MIN_SESSION_MAX_SECS, MAX_SESSION_MAX_SECS, DEFAULT_VIEW_MAX_SECS) * 1000
          : VIEW_MAX_MS;
  if (rawViewMaxMs < rawLingerMs) {
    log.warn(
        scope,
        'view_max_secs (' +
        Math.round(rawViewMaxMs / 1000) +
        's) is shorter than view_linger_secs (' +
        Math.round(rawLingerMs / 1000) +
        's), raising view_max_secs to ' +
        Math.round(rawLingerMs / 1000) +
        's'
    );
  }
  const viewMaxMs = Math.max(rawLingerMs, rawViewMaxMs);
  const lingerMs = Math.min(viewMaxMs, rawLingerMs);

  const rawEventSecs = camConfig.event_secs ?? cfg.event_secs;
  const eventSecs =
      rawEventSecs !== undefined
          ? clampNum(rawEventSecs, MIN_EVENT_SECS, MAX_EVENT_SECS, holdSecs)
          : clampNum(holdSecs, MIN_EVENT_SECS, MAX_EVENT_SECS, defaultHoldSecs);

  const earlySleepMs =
      camConfig.early_sleep_secs !== undefined
          ? clampNum(camConfig.early_sleep_secs, MIN_EARLY_SLEEP_SECS, MAX_EARLY_SLEEP_SECS, DEFAULT_EARLY_SLEEP_SECS) * 1000
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
          ? clampNum(camConfig.low_battery_hold_secs, MIN_LOW_BAT_HOLD_SECS, MAX_LOW_BAT_HOLD_SECS, DEFAULT_LOW_BAT_HOLD_SECS) * 1000
          : LOW_BAT_HOLD_MS;
  if (camConfig.low_battery_hold_secs !== undefined && rawLowBatHoldMs > holdMs) {
    log.warn(
        scope,
        'low_battery_hold_secs (' +
        Math.round(rawLowBatHoldMs / 1000) +
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
      (mode === 'custom' ? camConfig.recording_end_early : undefined) ??
      cfg.end_early;
  const letEufyDecideEnd =
      rawEndEarly !== undefined ? Boolean(rawEndEarly) : alwaysBackfill;

  return {
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
  };
}

/**
 * Resolves per-camera Eufy hardware Power Manager settings, automatically deriving
 * clip length and early-end behavior from the camera's resolved hold_secs and end_early
 * with defensive validation against contradictory overrides.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {ReturnType<typeof resolveCameraTimers>|null} [resolvedTimers=null] - Pre-resolved camera timers, if available.
 * @returns {{
 *   enforceQuality: boolean|number,
 *   powerWorkingMode: number|null,
 *   recordingClipLength: number|null,
 *   recordingEndClipMotionStops: boolean|null,
 *   recordingRetriggerInterval: number|null
 * }}
 */
function resolveHardwareRecordingConfig(camConfig = {}, resolvedTimers = null) {
  const scope = camConfig.name || camConfig.serial || 'bridge';
  const enforceQuality =
      camConfig.enforce_streaming_quality !== undefined
          ? camConfig.enforce_streaming_quality
          : ENFORCE_QUALITY;

  const syncPower = camConfig.sync_power ?? cfg.sync_power ?? true;
  if (syncPower === false) {
    return {
      enforceQuality,
      powerWorkingMode: null,
      recordingClipLength: null,
      recordingEndClipMotionStops: null,
      recordingRetriggerInterval: null,
    };
  }

  const timers = resolvedTimers || resolveCameraTimers(camConfig);
  const defaultClipSecs = clampNum(
      Math.round(timers.holdMs / 1000),
      MIN_RECORDING_CLIP_SECS,
      MAX_RECORDING_CLIP_SECS,
      DEFAULT_HOLD_SECS
  );

  const explicitClipLen = camConfig.recording_clip_length ?? cfg.recording_clip_length;
  const explicitEndEarly = camConfig.recording_end_early ?? cfg.recording_end_early;
  const explicitRetrigger = camConfig.recording_retrigger_interval ?? cfg.recording_retrigger_interval;
  const hasExplicitClipCfg =
      explicitClipLen !== undefined ||
      explicitEndEarly !== undefined ||
      explicitRetrigger !== undefined;

  const rawPowerMode = camConfig.power_working_mode ?? cfg.power_working_mode;
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
      return {
        enforceQuality,
        powerWorkingMode,
        recordingClipLength: null,
        recordingEndClipMotionStops: null,
        recordingRetriggerInterval: null,
      };
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

  return {
    enforceQuality,
    powerWorkingMode,
    recordingClipLength,
    recordingEndClipMotionStops,
    recordingRetriggerInterval,
  };
}

module.exports = {
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
  FORWARD_FACE_NAMES,
  GLOBAL_PRESERVE_ASPECT,
  PREEMPT_EVENT_STREAMS,
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
  HTTP_PORT,
  GLOBAL_STARTUP_SNAPSHOT,
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
  MIN_CAMERA_PRIORITY,
  MAX_CAMERA_PRIORITY,
  DEFAULT_CAMERA_PRIORITY,
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
  buildTriggerSet,
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
