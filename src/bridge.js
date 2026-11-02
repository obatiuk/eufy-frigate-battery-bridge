// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Enhanced and refactored in collaboration with Gemini (Google).
 */

/**
 * eufy-frigate-battery-bridge: event-only Frigate feed for Eufy battery cameras.
 *
 * Frigate sees each camera as a normal, always-on RTSP stream published by this bridge into
 * Frigate's go2rtc. While the camera sleeps, the stream displays a static status card
 * (no motion, so Frigate records nothing). The real camera is woken via an Eufy P2P livestream
 * through eufy-security-ws (the same path the Eufy app uses) when:
 *   - Eufy reports motion/person/pet/ring/etc. on it -> live until hold_secs after the last report
 *   - someone opens the camera's live view           -> live while they watch (go2rtc shows a viewer)
 *
 * Each HomeBase serves one P2P livestream at a time, while RTSP-capable cameras stream in parallel.
 * On shared P2P slots, cameras take turns by effective priority (camera priority + event boost)
 * with zero dwell delay. Viewers never block or outlast another
 * camera's motion.
 *
 * Going asleep <-> live looks like motion to Frigate, and Frigate's Live dashboard auto-opens
 * streams for cameras with activity. Such viewers must not keep a camera awake, so only a viewer
 * that connected while the camera was asleep (and not right after it fell asleep) counts as
 * someone asking for live view.
 *
 * One continuous encoder per camera keeps the output stream unbroken across asleep <-> live, so
 * Frigate's recorder never has to reconnect at the start of an event.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
const WebSocket = require('ws');

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

// Structured logging configuration (LOG_LEVEL env variable or config.json log_level; default: 'info').
const LOG_LEVELS = {debug: 0, info: 1, warn: 2, warning: 2, error: 3};
const RAW_LOG_LEVEL = String(process.env.LOG_LEVEL || cfg.log_level || 'info')
    .toLowerCase()
    .trim();
const CURRENT_LOG_LEVEL = LOG_LEVELS[RAW_LOG_LEVEL] ?? LOG_LEVELS.info;
const ACTIVE_LOG_LEVEL_NAME =
    Object.keys(LOG_LEVELS).find((k) => k !== 'warning' && LOG_LEVELS[k] === CURRENT_LOG_LEVEL) || 'info';

/**
 * Formats a Date object as 'YYYY-MM-DD HH:MM:SS' in local time (via TZ) without ICU locale dependencies.
 *
 * @param {Date} [d=new Date()] - Date instance to format.
 * @returns {string}
 */
function formatLocalTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes()) +
      ':' +
      pad(d.getSeconds())
  );
}

/**
 * Formats a Date object as 'HH:MM' in local time (via TZ) without ICU locale dependencies.
 *
 * @param {Date} [d=new Date()] - Date instance to format.
 * @returns {string}
 */
function formatLocalHm(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/**
 * Formats and writes a structured log line to stdout when `level` meets or exceeds CURRENT_LOG_LEVEL.
 * Every line uses the identical prefix layout for Grafana Alloy parsing:
 *   YYYY-MM-DD HH:MM:SS [LEVEL] [camera_or_bridge] message
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Log severity level.
 * @param {string|{name?: string}|null|undefined} scope - Camera state/config object, camera name, or 'bridge'.
 * @param {...*} args - Message segments.
 */
function writeLog(level, scope, ...args) {
  const normLevel = level === 'warning' ? 'warn' : level;
  const weight = LOG_LEVELS[normLevel] ?? LOG_LEVELS.info;
  if (weight < CURRENT_LOG_LEVEL) return;
  const ts = formatLocalTimestamp();
  const lvlTag = normLevel.toUpperCase();
  const scopeName =
      scope && typeof scope === 'object' ? scope.name || 'bridge' : String(scope || 'bridge');
  console.log(ts + ' [' + lvlTag + '] [' + scopeName + '] ' + args.join(' '));
}

const log = {
  debug: (scope, ...args) => writeLog('debug', scope, ...args),
  info: (scope, ...args) => writeLog('info', scope, ...args),
  warn: (scope, ...args) => writeLog('warn', scope, ...args),
  error: (scope, ...args) => writeLog('error', scope, ...args),
};

if (!(RAW_LOG_LEVEL in LOG_LEVELS)) {
  log.warn('bridge', 'unknown LOG_LEVEL "' + RAW_LOG_LEVEL + '", defaulting to "info"');
}

// Stream timing and arbitration limits (in milliseconds).
const MAX_MS = clampNum(cfg.max_secs, 10, 86400, 900) * 1000;
const VIEW_MAX_MS = clampNum(cfg.view_max_secs, 10, 86400, 300) * 1000;
const HOLD_MS = Math.min(MAX_MS, clampNum(cfg.hold_secs, 5, 86400, 60) * 1000);
const LINGER_MS = Math.min(VIEW_MAX_MS, clampNum(cfg.view_linger_secs, 5, 86400, 20) * 1000);
const COOLDOWN_MS = clampNum(cfg.viewer_cooldown_secs, 0, 3600, 5) * 1000;
const EVENT_SECS = clampNum(cfg.event_secs, 1, 3600, 30);
const SNAP_DELAY_MS = clampNum(cfg.snapshot_delay_secs, 0, 60, 3) * 1000;

// Doorbell, HomeBase 3 face recognition, and aspect ratio options.
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
 * Returns a Promise that resolves after the specified number of milliseconds.
 *
 * @param {number} ms - Delay duration in milliseconds.
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Prefers cfg.cache_dir or /config/cache on the persistent volume, falling back to /tmp
 * if the /config mount is read-only or not writable by the container user.
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
 * Falls back to software libx264 if a required render node (such as /dev/dri/renderD128) is absent.
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
 * settings with any per-camera camConfig.telemetry overrides. Telemetry is enabled by default.
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
 * Blends an RGB pixel with opacity alpha (0..1) into a raw YUV420p frame buffer at (x, y).
 *
 * @param {Uint8Array} yuvBuf - Target YUV420p frame buffer of length FRAME.
 * @param {number} x - Horizontal pixel coordinate (0..W-1).
 * @param {number} y - Vertical pixel coordinate (0..H-1).
 * @param {number} r - Red component (0..255).
 * @param {number} g - Green component (0..255).
 * @param {number} b - Blue component (0..255).
 * @param {number} alpha - Opacity from 0.0 (transparent) to 1.0 (opaque).
 */
function blendYuvPixel(yuvBuf, x, y, r, g, b, alpha) {
  if (x < 0 || x >= W || y < 0 || y >= H || alpha <= 0) return;
  const a = alpha > 1 ? 1 : alpha;
  const invA = 1 - a;

  const yVal = (0.257 * r + 0.504 * g + 0.098 * b + 16.5) | 0;
  const yIdx = y * W + x;
  yuvBuf[yIdx] = (yuvBuf[yIdx] * invA + yVal * a + 0.5) | 0;

  if ((x & 1) === 0 && (y & 1) === 0) {
    const uVal = (-0.148 * r - 0.291 * g + 0.439 * b + 128.5) | 0;
    const vVal = (0.439 * r - 0.368 * g - 0.071 * b + 128.5) | 0;
    const chromaOffset = (y >> 1) * (W >> 1) + (x >> 1);
    const uIdx = W * H + chromaOffset;
    const vIdx = uIdx + (W >> 1) * (H >> 1);
    yuvBuf[uIdx] = (yuvBuf[uIdx] * invA + uVal * a + 0.5) | 0;
    yuvBuf[vIdx] = (yuvBuf[vIdx] * invA + vVal * a + 0.5) | 0;
  }
}

/**
 * Draws a filled rectangle onto a YUV420p frame buffer with alpha blending.
 *
 * @param {Uint8Array} yuvBuf - Target YUV420p frame buffer.
 * @param {number} rx - Left X coordinate.
 * @param {number} ry - Top Y coordinate.
 * @param {number} rw - Rectangle width in pixels.
 * @param {number} rh - Rectangle height in pixels.
 * @param {number} r - Red component (0..255).
 * @param {number} g - Green component (0..255).
 * @param {number} b - Blue component (0..255).
 * @param {number} alpha - Opacity (0..1).
 */
function fillYuvRect(yuvBuf, rx, ry, rw, rh, r, g, b, alpha) {
  const x0 = Math.max(0, Math.round(rx));
  const y0 = Math.max(0, Math.round(ry));
  const x1 = Math.min(W, Math.round(rx + rw));
  const y1 = Math.min(H, Math.round(ry + rh));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      blendYuvPixel(yuvBuf, x, y, r, g, b, alpha);
    }
  }
}

/**
 * Draws an anti-aliased filled circle onto a YUV420p frame buffer.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} radius - Circle radius in pixels.
 * @param {number[]} rgb - RGB color array [r, g, b].
 * @param {number} alpha - Opacity (0..1).
 */
function drawYuvCircle(canvas, cx, cy, radius, rgb, alpha) {
  const [r, g, b] = rgb;
  const pad = Math.ceil(radius + 1);
  const y0 = Math.max(0, Math.floor(cy - pad));
  const y1 = Math.min(H - 1, Math.ceil(cy + pad));
  const x0 = Math.max(0, Math.floor(cx - pad));
  const x1 = Math.min(W - 1, Math.ceil(cx + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cov = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x - cx, y - cy)));
      if (cov > 0) {
        blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
      }
    }
  }
}

/**
 * Draws an anti-aliased ring outline onto a YUV420p frame buffer.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} radius - Ring radius in pixels.
 * @param {number} strokeHalf - Half of the ring stroke width in pixels.
 * @param {number[]} rgb - RGB color array [r, g, b].
 * @param {number} alpha - Opacity (0..1).
 */
function drawYuvRing(canvas, cx, cy, radius, strokeHalf, rgb, alpha) {
  const [r, g, b] = rgb;
  const pad = Math.ceil(radius + strokeHalf + 1);
  const y0 = Math.max(0, Math.floor(cy - pad));
  const y1 = Math.min(H - 1, Math.ceil(cy + pad));
  const x0 = Math.max(0, Math.floor(cx - pad));
  const x1 = Math.min(W - 1, Math.ceil(cx + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const cov = Math.min(1, Math.max(0, strokeHalf + 0.5 - Math.abs(d - radius)));
      if (cov > 0) {
        blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
      }
    }
  }
}

/**
 * Draws an anti-aliased line segment between (x1, y1) and (x2, y2) onto a YUV420p buffer.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} x1 - Start X coordinate.
 * @param {number} y1 - Start Y coordinate.
 * @param {number} x2 - End X coordinate.
 * @param {number} y2 - End Y coordinate.
 * @param {number} strokeHalf - Half of the line thickness in pixels.
 * @param {number[]} rgb - RGB color array [r, g, b].
 * @param {number} alpha - Opacity (0..1).
 */
function drawYuvLine(canvas, x1, y1, x2, y2, strokeHalf, rgb, alpha) {
  const [r, g, b] = rgb;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - strokeHalf - 1));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + strokeHalf + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - strokeHalf - 1));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + strokeHalf + 1));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq));
      const dist = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      const cov = Math.min(1, Math.max(0, strokeHalf + 0.5 - dist));
      if (cov > 0) {
        blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
      }
    }
  }
}

// Reusable scratch buffer for separable box-blur passes to avoid per-render heap allocations.
let blurScratch = Buffer.allocUnsafe(0);

/**
 * Performs a single horizontal + vertical sliding-window box blur pass on a planar Y, U, or V buffer.
 *
 * @param {Uint8Array} buf - Target YUV420p region buffer.
 * @param {number} offset - Byte offset where the plane starts.
 * @param {number} width - Plane width in pixels.
 * @param {number} height - Plane height in pixels.
 * @param {number} radius - Blur kernel radius in pixels.
 */
function boxBlurPlane(buf, offset, width, height, radius) {
  const planeLen = width * height;
  if (blurScratch.length < planeLen) {
    blurScratch = Buffer.allocUnsafe(planeLen);
  }
  const diam = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    const rowOff = offset + y * width;
    const tmpRow = y * width;
    let sum = buf[rowOff] * (radius + 1);
    for (let i = 1; i <= radius; i++) {
      sum += buf[rowOff + Math.min(width - 1, i)];
    }
    for (let x = 0; x < width; x++) {
      blurScratch[tmpRow + x] = (sum / diam) | 0;
      const leftIdx = Math.max(0, x - radius);
      const rightIdx = Math.min(width - 1, x + radius + 1);
      sum += buf[rowOff + rightIdx] - buf[rowOff + leftIdx];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = blurScratch[x] * (radius + 1);
    for (let i = 1; i <= radius; i++) {
      sum += blurScratch[Math.min(height - 1, i) * width + x];
    }
    for (let y = 0; y < height; y++) {
      buf[offset + y * width + x] = (sum / diam) | 0;
      const topIdx = Math.max(0, y - radius);
      const botIdx = Math.min(height - 1, y + radius + 1);
      sum += blurScratch[botIdx * width + x] - blurScratch[topIdx * width + x];
    }
  }
}

/**
 * Extracts and blurs a rectangular sub-region of a YUV420p frame buffer using a 3-pass
 * separable box blur to produce a frosted-glass backdrop behind status cards.
 *
 * @param {Uint8Array} canvas - Source YUV420p frame buffer of length FRAME.
 * @param {number} rx0 - Even-aligned left X coordinate of the region.
 * @param {number} ry0 - Even-aligned top Y coordinate of the region.
 * @param {number} rw - Even-aligned width of the region.
 * @param {number} rh - Even-aligned height of the region.
 * @returns {{ buf: Uint8Array, lumaSize: number, chromaSize: number, cw: number }}
 */
function extractBlurredRegion(canvas, rx0, ry0, rw, rh) {
  const cw = rw >> 1;
  const ch = rh >> 1;
  const lumaSize = rw * rh;
  const chromaSize = cw * ch;
  const regionBuf = Buffer.allocUnsafe(lumaSize + chromaSize * 2);

  for (let y = 0; y < rh; y++) {
    const srcOff = (ry0 + y) * W + rx0;
    canvas.copy(regionBuf, y * rw, srcOff, srcOff + rw);
  }

  const fullCw = W >> 1;
  const fullChromaSize = fullCw * (H >> 1);
  for (let cy = 0; cy < ch; cy++) {
    const srcU = W * H + ((ry0 >> 1) + cy) * fullCw + (rx0 >> 1);
    const srcV = srcU + fullChromaSize;
    canvas.copy(regionBuf, lumaSize + cy * cw, srcU, srcU + cw);
    canvas.copy(regionBuf, lumaSize + chromaSize + cy * cw, srcV, srcV + cw);
  }

  for (let pass = 0; pass < 3; pass++) {
    boxBlurPlane(regionBuf, 0, rw, rh, 12);
    boxBlurPlane(regionBuf, lumaSize, cw, ch, 6);
    boxBlurPlane(regionBuf, lumaSize + chromaSize, cw, ch, 6);
  }

  return {buf: regionBuf, lumaSize, chromaSize, cw};
}

/**
 * Draws a frosted-glass rounded rectangle or capsule onto a YUV420p frame buffer:
 * blurs only the background pixels inside the rounded boundary (when blurBackdrop is true),
 * then blends the dark translucent glass tint and subtle anti-aliased rim highlight on top.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer of length FRAME.
 * @param {number} boxX - Left X coordinate.
 * @param {number} boxY - Top Y coordinate.
 * @param {number} boxW - Box width in pixels.
 * @param {number} boxH - Box height in pixels.
 * @param {number} radius - Corner radius in pixels.
 * @param {number} opacity - Dark glass tint opacity (0..1).
 * @param {number} [borderOpacity=0.16] - Subtle rim highlight opacity (0..1).
 * @param {boolean} [blurBackdrop=true] - Whether to run a frosted-glass blur on the underlying pixels.
 */
function drawRoundedBox(canvas, boxX, boxY, boxW, boxH, radius, opacity, borderOpacity = 0.16, blurBackdrop = true) {
  const pad = 28;
  const rx0 = Math.max(0, (boxX - pad) & ~1);
  const ry0 = Math.max(0, (boxY - pad) & ~1);
  const rx1 = Math.min(W, (boxX + boxW + pad + 1) & ~1);
  const ry1 = Math.min(H, (boxY + boxH + pad + 1) & ~1);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;

  const blurred = blurBackdrop ? extractBlurredRegion(canvas, rx0, ry0, rw, rh) : null;
  const rSafe = Math.min(radius, Math.floor(boxW / 2), Math.floor(boxH / 2));

  for (let py = 0; py < boxH; py++) {
    for (let px = 0; px < boxW; px++) {
      const gx = boxX + px;
      const gy = boxY + py;
      if (gx < rx0 || gx >= rx1 || gy < ry0 || gy >= ry1) continue;

      const dx = Math.max(rSafe - px, 0, px - (boxW - 1 - rSafe));
      const dy = Math.max(rSafe - py, 0, py - (boxH - 1 - rSafe));
      const dist = Math.hypot(dx, dy);
      const cov = Math.min(1, Math.max(0, rSafe + 0.5 - dist));
      if (cov > 0) {
        if (blurred) {
          const lx = gx - rx0;
          const ly = gy - ry0;
          const yIdx = gy * W + gx;
          const bY = blurred.buf[ly * rw + lx];
          canvas[yIdx] = (canvas[yIdx] * (1 - cov) + bY * cov + 0.5) | 0;

          if ((gx & 1) === 0 && (gy & 1) === 0) {
            const cOff = (gy >> 1) * (W >> 1) + (gx >> 1);
            const uIdx = W * H + cOff;
            const vIdx = uIdx + (W >> 1) * (H >> 1);
            const rOff = (ly >> 1) * blurred.cw + (lx >> 1);
            const bU = blurred.buf[blurred.lumaSize + rOff];
            const bV = blurred.buf[blurred.lumaSize + blurred.chromaSize + rOff];
            canvas[uIdx] = (canvas[uIdx] * (1 - cov) + bU * cov + 0.5) | 0;
            canvas[vIdx] = (canvas[vIdx] * (1 - cov) + bV * cov + 0.5) | 0;
          }
        }

        blendYuvPixel(canvas, gx, gy, 12, 12, 14, opacity * cov);
        if (borderOpacity > 0) {
          const borderCov = Math.min(1, Math.max(0, 1.1 - Math.abs(dist - (rSafe - 0.6))));
          if (borderCov > 0) {
            blendYuvPixel(canvas, gx, gy, 255, 255, 255, borderOpacity * borderCov * cov);
          }
        }
      }
    }
  }
}

/**
 * Draws the color-coded status ring and inner state glyph (dot for Asleep/Low-Battery,
 * play triangle for Waking Up, pause bars for Waiting) at the requested scale.
 * Used by both the 'icons' theme (scale = 1.0) and the centered 'default' modal (scale = 3.0).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} scale - Size multiplier (1.0 = 20x20 icon, 3.0 = 60x60 modal icon).
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawStatusGlyph(canvas, cx, cy, scale, st) {
  drawYuvRing(canvas, cx, cy, 8.2 * scale, Math.max(1.4, 1.1 * scale), st.statusRgb, 0.96);

  if (st.statusKind === 'waiting') {
    const barW = Math.max(2, Math.round(2.2 * scale));
    const barH = Math.round(8.0 * scale);
    const offset = Math.round(3.0 * scale);
    fillYuvRect(
        canvas,
        cx - offset,
        cy - barH / 2,
        barW,
        barH,
        st.statusRgb[0],
        st.statusRgb[1],
        st.statusRgb[2],
        0.95
    );
    fillYuvRect(
        canvas,
        cx + offset - barW,
        cy - barH / 2,
        barW,
        barH,
        st.statusRgb[0],
        st.statusRgb[1],
        st.statusRgb[2],
        0.95
    );
  } else if (st.statusKind === 'waking' || st.statusKind === 'live') {
    const xLeft = cx - 2.2 * scale;
    const xRight = cx + 3.6 * scale;
    const yHalf = 3.6 * scale;
    const stroke = Math.max(1.3, 1.1 * scale);
    drawYuvLine(canvas, xLeft, cy - yHalf, xRight, cy, stroke, st.statusRgb, 0.96);
    drawYuvLine(canvas, xRight, cy, xLeft, cy + yHalf, stroke, st.statusRgb, 0.96);
    drawYuvLine(canvas, xLeft, cy - yHalf, xLeft, cy + yHalf, stroke, st.statusRgb, 0.96);
  } else {
    drawYuvCircle(canvas, cx, cy, 4.0 * scale, st.statusRgb, 0.96);
  }
}

/**
 * Draws a 37x16 vector battery icon with a proportional inner charge bar
 * and optional charging bolt.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} bx - Left X coordinate of the battery shell.
 * @param {number} batY - Top Y coordinate of the battery shell.
 * @param {number} batPct - Battery percentage (0..100).
 * @param {number[]} shellRgb - RGB color array [r, g, b] for the shell outline.
 * @param {number[]} fillRgb - RGB color array [r, g, b] for the inner charge bar.
 * @param {boolean} showBolt - Whether to draw a charging bolt across the center of the battery.
 */
function drawBatteryIcon(canvas, bx, batY, batPct, shellRgb, fillRgb, showBolt) {
  const [sr, sg, sb] = shellRgb;
  const [fr, fg, fb] = fillRgb;
  fillYuvRect(canvas, bx, batY, 34, 2, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx, batY + 14, 34, 2, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx, batY + 2, 2, 12, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx + 32, batY + 2, 2, 12, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx + 34, batY + 5, 3, 6, sr, sg, sb, 0.92);
  const fillW = Math.max(3, Math.round((26 * batPct) / 100));
  fillYuvRect(canvas, bx + 4, batY + 4, fillW, 8, fr, fg, fb, 0.95);
  if (showBolt) {
    drawYuvLine(canvas, bx + 18, batY + 3, bx + 14, batY + 8, 1.1, [20, 20, 24], 0.95);
    drawYuvLine(canvas, bx + 14, batY + 8, bx + 19, batY + 8, 1.1, [20, 20, 24], 0.95);
    drawYuvLine(canvas, bx + 19, batY + 8, bx + 15, batY + 13, 1.1, [20, 20, 24], 0.95);
  }
}

/**
 * Draws a curved Wi-Fi signal icon (base dot + 3 concentric upper-sector wave arcs)
 * colored by RSSI/signal quality.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Horizontal center X coordinate of the Wi-Fi fan.
 * @param {number} bottomY - Vertical Y coordinate of the bottom apex dot.
 * @param {number} wifiBars - Number of lit signal levels (0..4).
 * @param {number[]} rgb - Active signal RGB color array [r, g, b].
 */
function drawWifiArcsIcon(canvas, cx, bottomY, wifiBars, rgb) {
  const dotLit = wifiBars >= 1;
  drawYuvCircle(canvas, cx, bottomY, 2.1, dotLit ? rgb : [113, 113, 122], dotLit ? 0.96 : 0.45);

  const radii = [5.4, 9.2, 13.0];
  const strokeHalf = 1.25;
  for (let i = 0; i < 3; i++) {
    const rad = radii[i];
    const lit = wifiBars >= i + 2;
    const [r, g, b] = lit ? rgb : [113, 113, 122];
    const alpha = lit ? 0.95 : 0.42;
    const pad = Math.ceil(rad + strokeHalf + 1);
    for (let y = Math.floor(bottomY - pad); y <= Math.ceil(bottomY + 1); y++) {
      for (let x = Math.floor(cx - pad); x <= Math.ceil(cx + pad); x++) {
        const dx = x - cx;
        const dy = y - bottomY;
        const angle = Math.atan2(dy, dx);
        if (angle >= -2.38 && angle <= -0.76) {
          const d = Math.hypot(dx, dy);
          const cov = Math.min(1, Math.max(0, strokeHalf + 0.5 - Math.abs(d - rad)));
          if (cov > 0) {
            blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
          }
        }
      }
    }
  }
}

/**
 * Computes the top-left (boxX, boxY) coordinates for a card of size (boxW, boxH)
 * based on the configured card_position ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 *
 * @param {string} position - Normalized position string.
 * @param {number} boxW - Card width in pixels.
 * @param {number} boxH - Card height in pixels.
 * @returns {{ boxX: number, boxY: number }}
 */
function getCardBoxCoords(position, boxW, boxH) {
  if (position === 'center') {
    return {
      boxX: Math.round((W - boxW) / 2),
      boxY: Math.round((H - boxH) / 2),
    };
  }
  const margin = 24;
  return {
    boxX: position.endsWith('right') ? W - boxW - margin : margin,
    boxY: position.startsWith('bottom') ? H - boxH - margin : margin,
  };
}

/**
 * Resolves the effective status card theme ('default', 'icons', 'minimal', 'none'),
 * card_position ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'), and
 * card_background ('snapshot', 'slate', 'black') for a camera.
 * Accepts flexible corner word order (e.g., 'left-bottom' or 'bottom-left') and logs a
 * warning if an unrecognized option value is supplied.
 *
 * @param {Record<string, *>} camConfig - Individual camera configuration object from cfg.cameras.
 * @returns {{ theme: string, position: string, background: string }}
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

/**
 * Evaluates the 4-color semantic state (Green, Blue, Yellow, Red) for camera status,
 * battery, Wi-Fi/RSSI, and temperature.
 *
 * @param {string} titleText - Card heading ('Asleep', 'Waking Up...', 'Waiting', etc.).
 * @param {Record<string, *>|null} status - Camera telemetry state object.
 * @returns {Record<string, *>} Evaluated values and RGB colors for status, battery, wifi, temp, and lastSeen.
 */
function evaluateTelemetryState(titleText, status) {
  const telCfg = status && status.telCfg ? status.telCfg : {enabled: false};
  const batRaw = status && status.battery != null ? status.battery : null;
  const wifiRaw = status && status.wifi != null ? status.wifi : null;
  const rssiRaw = status && status.rssi != null ? status.rssi : null;
  const tempRaw = status && status.temp != null ? status.temp : null;
  const seenRaw = status && status.lastSeen ? status.lastSeen : '';
  const charging = Boolean(status && status.charging);
  const economyMode = Boolean(status && status.economyMode);

  // 1. Camera Status Color: Green = Asleep, Blue = Waking Up / Live, Yellow = Waiting, Red = Low-Bat Eco.
  const statusKind = /^Live\b/i.test(titleText)
      ? 'live'
      : /Waking/i.test(titleText)
          ? 'waking'
          : /Waiting/i.test(titleText)
              ? 'waiting'
              : economyMode || /Low Battery/i.test(titleText)
                  ? 'low'
                  : 'asleep';
  const statusRgb =
      statusKind === 'waking' || statusKind === 'live'
          ? COLOR_BLUE
          : statusKind === 'waiting'
              ? COLOR_YELLOW
              : statusKind === 'low'
                  ? COLOR_RED
                  : COLOR_GREEN;

  // 2. Battery Color: Blue = Charging/Solar/Plugged, Green >= 50%, Yellow 21..49%, Red <= 20% or n/a.
  const redBatCutoff = LOW_BAT_THRESHOLD > 0 ? LOW_BAT_THRESHOLD : 20;
  const hasBat = batRaw != null && !Number.isNaN(Number(batRaw));
  const batPct = hasBat ? clampNum(Math.round(Number(batRaw)), 0, 100, 0) : 0;
  const batRgb = charging
      ? COLOR_BLUE
      : !hasBat || batPct <= redBatCutoff
          ? COLOR_RED
          : batPct >= 50
              ? COLOR_GREEN
              : COLOR_YELLOW;
  const batHex = charging
      ? '0x38bdf8'
      : !hasBat || batPct <= redBatCutoff
          ? '0xf87171'
          : batPct >= 50
              ? '0x4ade80'
              : '0xfacc15';

  // 3. Wi-Fi & RSSI Color: Green = Strong (>= -65dBm or 4/4), Blue = Good (-66..-72dBm or 3/4),
  // Yellow = Fair (-73..-80dBm or 2/4), Red = Poor (< -80dBm or 0-1/4).
  const hasWifi = wifiRaw != null && !Number.isNaN(Number(wifiRaw));
  const hasRssi = rssiRaw != null && !Number.isNaN(Number(rssiRaw));
  const rssiNum = hasRssi ? Math.round(Number(rssiRaw)) : null;
  const wifiBars = hasWifi
      ? clampNum(Math.round(Number(wifiRaw)), 0, 4, 0)
      : hasRssi
          ? rssiNum >= -65
              ? 4
              : rssiNum >= -72
                  ? 3
                  : rssiNum >= -80
                      ? 2
                      : 1
          : 0;
  const wifiRgb = hasRssi
      ? rssiNum >= -65
          ? COLOR_GREEN
          : rssiNum >= -72
              ? COLOR_BLUE
              : rssiNum >= -80
                  ? COLOR_YELLOW
                  : COLOR_RED
      : hasWifi
          ? wifiBars >= 4
              ? COLOR_GREEN
              : wifiBars === 3
                  ? COLOR_BLUE
                  : wifiBars === 2
                      ? COLOR_YELLOW
                      : COLOR_RED
          : COLOR_RED;

  // 4. Temperature Color: Blue <= 5C, Green 6..35C, Yellow 36..44C, Red >= 45C.
  const hasTemp = tempRaw != null && !Number.isNaN(Number(tempRaw));
  const tempNum = hasTemp ? Math.round(Number(tempRaw)) : null;
  const tempRgb = !hasTemp
      ? COLOR_GREEN
      : tempNum <= 5
          ? COLOR_BLUE
          : tempNum <= 35
              ? COLOR_GREEN
              : tempNum < 45
                  ? COLOR_YELLOW
                  : COLOR_RED;
  const tempHex =
      tempNum !== null && tempNum <= 5
          ? '0x38bdf8'
          : tempNum !== null && tempNum >= 45
              ? '0xf87171'
              : tempNum !== null && tempNum >= 36
                  ? '0xfacc15'
                  : '0xd4d4d8';

  return {
    telCfg,
    statusKind,
    statusRgb,
    hasBat,
    batPct,
    charging,
    economyMode,
    powerLabel: (status && status.powerLabel) || '',
    batRgb,
    batHex,
    hasWifi,
    wifiBars,
    hasRssi,
    rssiNum,
    wifiRgb,
    hasTemp,
    tempNum,
    tempRgb,
    tempHex,
    seenVal: seenRaw,
  };
}

/**
 * Builds the list of enabled telemetry segments for rendering in the 'default' theme.
 *
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @returns {Array<Record<string, *>>} Array of telemetry segment descriptors.
 */
function buildTelemetrySegments(st) {
  const {telCfg} = st;
  if (!telCfg.enabled) return [];

  const segments = [];
  if (telCfg.battery && st.hasBat) {
    const powerText =
        telCfg.powerSource && st.powerLabel
            ? ' ' + st.powerLabel
            : st.charging
                ? ' Charging'
                : st.economyMode
                    ? ' Eco'
                    : '';
    const label = st.batPct + '%' + powerText;
    segments.push({
      type: 'bat',
      batPct: st.batPct,
      charging: st.charging,
      batHex: st.batHex,
      batRgb: st.batRgb,
      label,
      width: 45 + label.length * 11,
    });
  }

  if (telCfg.wifi && (st.hasWifi || st.hasRssi)) {
    const showRssi = telCfg.rssi && st.hasRssi;
    const label = showRssi ? st.rssiNum + ' dBm' : 'Wi-Fi';
    segments.push({
      type: 'wifi',
      wifiBars: st.wifiBars,
      wifiRgb: st.wifiRgb,
      label,
      width: 38 + label.length * 11,
    });
  }

  if (telCfg.temperature && st.hasTemp) {
    const label = st.tempNum + '°C';
    segments.push({
      type: 'temp',
      tempHex: st.tempHex,
      tempRgb: st.tempRgb,
      tempNum: st.tempNum,
      label,
      width: label.length * 12,
    });
  }

  if (telCfg.lastSeen && st.seenVal) {
    const label = 'Last live ' + st.seenVal;
    segments.push({
      type: 'seen',
      seenVal: st.seenVal,
      label,
      width: label.length * 11,
    });
  }

  return segments;
}

/**
 * Draws the vector battery icon and curved Wi-Fi arc icon alongside their text labels
 * for the 'default' theme.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {Array<Record<string, *>>} segments - Telemetry segments from buildTelemetrySegments().
 * @param {number} startX - Left X coordinate where the telemetry row begins.
 * @param {number} textY - Top Y coordinate for 20px drawtext strings.
 * @param {number} gap - Horizontal pixel gap between segments.
 * @param {Function} buildDrawtext - Helper that formats a drawtext filter string.
 * @returns {string[]} Array of FFmpeg drawtext filter strings.
 */
function drawTelemetryRow(canvas, segments, startX, textY, gap, buildDrawtext) {
  const filters = [];
  const textBaselineY = textY + 14;
  let cursorX = startX;

  for (const seg of segments) {
    if (seg.type === 'bat') {
      drawBatteryIcon(canvas, cursorX, textY - 1, seg.batPct, [212, 212, 216], seg.batRgb, false);
      filters.push(buildDrawtext(seg.label, seg.batHex, 20, String(cursorX + 45), textY));
    } else if (seg.type === 'wifi') {
      drawWifiArcsIcon(canvas, cursorX + 16, textBaselineY - 1, seg.wifiBars, seg.wifiRgb);
      filters.push(buildDrawtext(seg.label, '0xd4d4d8', 20, String(cursorX + 38), textY));
    } else if (seg.type === 'temp') {
      filters.push(buildDrawtext(seg.label, seg.tempHex, 20, String(cursorX), textY));
    } else if (seg.type === 'seen') {
      filters.push(buildDrawtext(seg.label, '0xa1a1aa', 20, String(cursorX), textY));
    }
    cursorX += seg.width + gap;
  }

  return filters;
}

/**
 * Renders the 'minimal' three-dot theme with graduated status dots inside a capsule:
 *   - Dot 1 (6.8px): Camera Status (Green = Asleep, Blue = Waking, Yellow = Waiting, Red = Low-Bat Eco)
 *   - Dot 2 (6.0px): Battery State (Blue = Charging/Solar, Green >= 50%, Yellow 21..49%, Red <= 20%)
 *   - Dot 3 (5.2px): Wi-Fi Signal (Green = Strong, Blue = Average, Yellow = Weak, Red = Poor)
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {string} position - Placement ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 */
function drawMinimalDotsCard(canvas, position, st, blurBackdrop = true) {
  const boxW = 92;
  const boxH = 36;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 18, 0.42, 0.16, blurBackdrop);

  const cy = boxY + 18;
  drawYuvCircle(canvas, boxX + 22, cy, 6.8, st.statusRgb, 0.96);
  drawYuvCircle(canvas, boxX + 46, cy, 6.0, st.batRgb, 0.96);
  drawYuvCircle(canvas, boxX + 70, cy, 5.2, st.wifiRgb, 0.96);
}

/**
 * Renders the 'icons' theme: converts all enabled status and telemetry items into crisp
 * vector icons (Status ring/glyph, Battery + bolt, Curved Wi-Fi arcs colored by RSSI,
 * Thermometer with tick marks, and Last-Seen filled analog clock with HH:MM hands) inside
 * a full-radius capsule with zero text and no FFmpeg subprocess.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {string} position - Placement ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 */
function drawIconsOnlyCard(canvas, position, st, blurBackdrop = true) {
  const {telCfg} = st;
  const showBat = telCfg.enabled && telCfg.battery && st.hasBat;
  const showWifi = telCfg.enabled && telCfg.wifi && (st.hasWifi || st.hasRssi);
  const showTemp = telCfg.enabled && telCfg.temperature && st.hasTemp;
  const showClock = telCfg.enabled && telCfg.lastSeen && Boolean(st.seenVal);

  const padX = 16;
  const gap = 16;
  let contentW = 20;
  if (showBat) contentW += gap + 37;
  if (showWifi) contentW += gap + 28;
  if (showTemp) contentW += gap + 16;
  if (showClock) contentW += gap + 20;

  const boxW = contentW + padX * 2;
  const boxH = 44;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);
  const cy = boxY + 22;

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 22, 0.44, 0.16, blurBackdrop);

  // 1. Status Icon (20x20): outer ring + inner state glyph.
  let cursorX = boxX + padX;
  drawStatusGlyph(canvas, cursorX + 10, cy, 1.0, st);
  cursorX += 20 + gap;

  // 2. Battery + Power Source Icon (37x16) with inner bolt.
  if (showBat) {
    const showBolt = Boolean(telCfg.powerSource && (st.charging || st.powerLabel));
    drawBatteryIcon(canvas, cursorX, cy - 8, st.batPct, st.batRgb, st.batRgb, showBolt);
    cursorX += 37 + gap;
  }

  // 3. Curved Wi-Fi Signal Arcs + RSSI Color (28x16).
  if (showWifi) {
    drawWifiArcsIcon(canvas, cursorX + 14, cy + 7, st.wifiBars, st.wifiRgb);
    cursorX += 28 + gap;
  }

  // 4. Temperature Thermometer Icon with Tick Marks (16x20).
  if (showTemp) {
    const thermCx = cursorX + 6;
    const bulbCy = cy + 5;
    const stemTop = cy - 9;
    const [tr, tg, tb] = st.tempRgb;
    fillYuvRect(canvas, thermCx - 3, stemTop, 6, 12, tr, tg, tb, 0.85);
    fillYuvRect(canvas, thermCx - 1, stemTop + 2, 2, 10, 24, 24, 28, 0.9);
    fillYuvRect(canvas, thermCx + 5, stemTop + 2, 3, 1, tr, tg, tb, 0.8);
    fillYuvRect(canvas, thermCx + 5, stemTop + 5, 3, 1, tr, tg, tb, 0.8);
    fillYuvRect(canvas, thermCx + 5, stemTop + 8, 3, 1, tr, tg, tb, 0.8);
    drawYuvCircle(canvas, thermCx, bulbCy, 4.8, st.tempRgb, 0.92);
    drawYuvCircle(canvas, thermCx, bulbCy, 3.2, st.tempRgb, 0.98);
    const clampedTemp = clampNum(st.tempNum, 0, 50, 22);
    const mercuryH = Math.max(2, Math.round((clampedTemp / 50) * 10));
    fillYuvRect(canvas, thermCx - 1, bulbCy - 2 - mercuryH, 2, mercuryH + 2, tr, tg, tb, 0.95);
    cursorX += 16 + gap;
  }

  // 5. Last Seen Filled Analog Clock Icon (20x20) with HH:MM hands.
  if (showClock) {
    const clockCx = cursorX + 10;
    drawYuvCircle(canvas, clockCx, cy, 8.5, [244, 244, 245], 0.95);
    const match = /^(\d{1,2}):(\d{2})/.exec(String(st.seenVal || ''));
    const hours = match ? Number(match[1]) % 12 : 4;
    const mins = match ? Number(match[2]) % 60 : 20;
    const hourAngle = ((hours + mins / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    const minAngle = (mins / 60) * Math.PI * 2 - Math.PI / 2;
    drawYuvLine(
        canvas,
        clockCx,
        cy,
        clockCx + Math.cos(hourAngle) * 4.4,
        cy + Math.sin(hourAngle) * 4.4,
        1.2,
        [24, 24, 27],
        0.95
    );
    drawYuvLine(
        canvas,
        clockCx,
        cy,
        clockCx + Math.cos(minAngle) * 6.2,
        cy + Math.sin(minAngle) * 6.2,
        1.0,
        [24, 24, 27],
        0.95
    );
  }
}

/**
 * Composites the centered rounded translucent modal box ('default' theme at 'center' position),
 * the color-coded status glyph, and the baseline-aligned telemetry icons onto the canvas.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer (modified in place).
 * @param {number} boxX - Left coordinate of the centered modal box.
 * @param {number} boxY - Top coordinate of the centered modal box.
 * @param {number} boxW - Width of the centered modal box.
 * @param {number} boxH - Height of the centered modal box.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @param {Array<Record<string, *>>} segments - Telemetry segments from buildTelemetrySegments().
 * @param {Function} buildDrawtext - Helper that formats a drawtext filter string.
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 * @returns {string[]} Array of FFmpeg drawtext filter strings for the telemetry row.
 */
function drawFrigateModalGraphics(canvas, boxX, boxY, boxW, boxH, st, segments, buildDrawtext, blurBackdrop = true) {
  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 26, 0.56, 0.16, blurBackdrop);
  drawStatusGlyph(canvas, W / 2, boxY + 114, 3.0, st);

  if (!segments.length) return [];

  fillYuvRect(canvas, boxX + 44, boxY + 254, boxW - 88, 1, 255, 255, 255, 0.16);
  const gap = 32;
  const totalW = segments.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, segments.length - 1);
  const startX = Math.round(W / 2 - totalW / 2);
  return drawTelemetryRow(canvas, segments, startX, boxY + 278, gap, buildDrawtext);
}

/**
 * Draws the compact corner card for the 'default' theme when card_position is one of the
 * four corners ('top-left', 'top-right', 'bottom-left', 'bottom-right').
 * Dynamically expands width if the camera title or telemetry row exceeds 540px.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer (modified in place).
 * @param {string} position - Corner name ('top-left', 'top-right', 'bottom-left', 'bottom-right').
 * @param {string} headerText - Status and camera title shown on the top line of the card.
 * @param {number[]} dotRgb - RGB color array [r, g, b] for the status indicator dot.
 * @param {Array<Record<string, *>>} segments - Telemetry segments from buildTelemetrySegments().
 * @param {Function} buildDrawtext - Helper that formats a drawtext filter string.
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 * @returns {string[]} Array of FFmpeg drawtext filter strings for the corner card.
 */
function drawCornerDefaultCard(canvas, position, headerText, dotRgb, segments, buildDrawtext, blurBackdrop = true) {
  const hasTelemetry = segments.length > 0;
  const gap = 18;
  const telContentW = hasTelemetry
      ? segments.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, segments.length - 1) + 44
      : 0;
  const headerContentW = 42 + headerText.length * 11 + 24;
  const boxW = Math.min(W - 48, Math.max(hasTelemetry ? 540 : 400, telContentW, headerContentW));
  const boxH = hasTelemetry ? 88 : 48;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 22, 0.58, 0.16, blurBackdrop);
  drawYuvCircle(canvas, boxX + 26, boxY + 23, 5.6, dotRgb, 0.96);

  const filters = [buildDrawtext(headerText, '0xffffff', 20, String(boxX + 42), boxY + 15)];
  if (hasTelemetry) {
    fillYuvRect(canvas, boxX + 20, boxY + 44, boxW - 40, 1, 255, 255, 255, 0.16);
    filters.push(...drawTelemetryRow(canvas, segments, boxX + 22, boxY + 54, gap, buildDrawtext));
  }
  return filters;
}

/**
 * Prepares the base YUV420p background canvas once per renderCameraCards() cycle so it can be
 * shared across the asleep, waking, and busy cards without repeating full-frame pixel loops.
 *
 * @param {{ theme: string, position: string, background: string }} cardCfg - Resolved card config.
 * @param {Uint8Array|null} bgFrame - Last captured YUV420p video frame for this camera.
 * @returns {{ baseCanvas: Uint8Array, hasBackground: boolean }}
 */
function prepareBackgroundCanvas(cardCfg, bgFrame) {
  const baseCanvas = Buffer.allocUnsafe(FRAME);
  const hasBackground =
      cardCfg.background === 'snapshot' && Buffer.isBuffer(bgFrame) && bgFrame.length === FRAME;

  if (hasBackground) {
    bgFrame.copy(baseCanvas);
    if (cardCfg.dimBackground) {
      const lumaEnd = W * H;
      for (let i = 0; i < lumaEnd; i++) {
        baseCanvas[i] = Math.max(16, ((baseCanvas[i] - 16) * 0.55 + 16.5) | 0);
      }
      for (let i = lumaEnd; i < FRAME; i++) {
        baseCanvas[i] = ((baseCanvas[i] - 128) * 0.65 + 128.5) | 0;
      }
    }
  } else {
    baseCanvas.fill(0x80, W * H);
    baseCanvas.fill(cardCfg.background === 'black' ? 0x10 : 0x22, 0, W * H);
  }

  return {baseCanvas, hasBackground};
}

/**
 * Renders a static YUV420p status frame according to card_theme ('default', 'icons', 'minimal',
 * or 'none') and card_position ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 *
 * @param {string} titleText - Heading displayed on the card (e.g., "Asleep").
 * @param {string} line1 - First line of descriptive text below the circular icon.
 * @param {string} line2 - Second line of descriptive text.
 * @param {Record<string, *>|null} status - Camera telemetry and config flags.
 * @param {Uint8Array} preparedBg - Pre-dimmed YUV420p background frame from prepareBackgroundCanvas().
 * @param {boolean} hasBackground - Whether preparedBg contains a camera snapshot.
 * @returns {Uint8Array} Raw YUV420p frame buffer of length FRAME.
 */
function card(titleText, line1, line2, status, preparedBg, hasBackground) {
  const camScope = (status && status.camName) || 'bridge';
  const cardCfg = (status && status.cardCfg) || resolveCardConfig({});
  const canvas = Buffer.allocUnsafe(FRAME);
  preparedBg.copy(canvas);

  // 1. No-overlay mode ('none' / 'blank'): returns the prepared background (snapshot, slate, or black) as-is.
  if (cardCfg.theme === 'none') {
    return canvas;
  }

  const st = evaluateTelemetryState(titleText, status);

  // 2. Minimal 3-dot theme ('minimal'): graduated Status + Battery + Wi-Fi dots (no text, no FFmpeg).
  if (cardCfg.theme === 'minimal') {
    drawMinimalDotsCard(canvas, cardCfg.position, st, hasBackground);
    return canvas;
  }

  // 3. Icons-only theme ('icons'): vector Status + Battery + Wi-Fi arcs + Temp + Clock (no text, no FFmpeg).
  if (cardCfg.theme === 'icons') {
    drawIconsOnlyCard(canvas, cardCfg.position, st, hasBackground);
    return canvas;
  }

  const fontCandidates = [
    cfg.font_file,
    process.env.FONT_FILE,
    '/usr/share/fonts/Inter.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
  ].filter(Boolean);
  const font = fontCandidates.find((f) => fs.existsSync(f));
  if (!font) {
    log.warn(camScope, 'no TrueType font found for default theme, falling back to vector icons card');
    drawIconsOnlyCard(canvas, cardCfg.position, st, hasBackground);
    return canvas;
  }

  const esc = (t) => String(t).replace(/[\\']/g, ' ').replace(/:/g, '\\:');
  const buildDrawtext = (text, color, size, xExpr, yVal) =>
      'drawtext=fontfile=' +
      font +
      ':expansion=none:text=\'' +
      esc(text) +
      '\':fontcolor=' +
      color +
      ':fontsize=' +
      size +
      ':x=' +
      xExpr +
      ':y=' +
      yVal;

  const segments = buildTelemetrySegments(st);
  const hasTelemetry = segments.length > 0;
  const drawtextList = ['format=yuv420p'];

  // 4. Default theme at a corner position ('top-left', 'top-right', 'bottom-left', 'bottom-right').
  if (cardCfg.position !== 'center') {
    const camLabel = status && status.camTitle ? '  -  ' + status.camTitle : '';
    drawtextList.push(
        ...drawCornerDefaultCard(
            canvas,
            cardCfg.position,
            titleText + camLabel,
            st.statusRgb,
            segments,
            buildDrawtext,
            hasBackground
        )
    );
  } else {
    // 5. Default theme at 'center' position.
    const boxW = 820;
    const boxH = hasTelemetry ? 336 : 268;
    const {boxX, boxY} = getCardBoxCoords('center', boxW, boxH);
    const modalTelFilters = drawFrigateModalGraphics(
        canvas,
        boxX,
        boxY,
        boxW,
        boxH,
        st,
        segments,
        buildDrawtext,
        hasBackground
    );
    drawtextList.push(
        buildDrawtext(titleText, '0xffffff', 36, '(w-text_w)/2', boxY + 30),
        buildDrawtext(line1, '0xe4e4e7', 24, '(w-text_w)/2', boxY + 168),
        buildDrawtext(line2, '0xe4e4e7', 24, '(w-text_w)/2', boxY + 204),
        ...modalTelFilters
    );
  }

  const r = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        W + 'x' + H,
        '-i',
        'pipe:0',
        '-vf',
        drawtextList.join(','),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      {input: canvas, maxBuffer: FRAME * 2}
  );

  if (r.status === 0 && Buffer.isBuffer(r.stdout) && r.stdout.length === FRAME) {
    return r.stdout;
  }

  log.warn(
      camScope,
      'could not render text card (' +
      titleText +
      '), using plain backdrop: ' +
      String(r.stderr || '').trim().split('\n').pop()
  );
  return canvas;
}

/**
 * Decodes a JPEG file into a raw WxH YUV420p frame Buffer.
 *
 * @param {string} filePath - Filesystem path to a JPEG image.
 * @returns {Uint8Array|null} Decoded YUV420p Buffer of length FRAME, or null if decoding fails.
 */
function decodeJpegToYuv(filePath) {
  const r = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-vf',
        'scale=' + W + ':' + H + ':flags=lanczos',
        '-pix_fmt',
        'yuv420p',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      {maxBuffer: FRAME * 2}
  );
  return r.status === 0 && Buffer.isBuffer(r.stdout) && r.stdout.length === FRAME ? r.stdout : null;
}

/**
 * Returns the unique cache file path in CACHE_DIR for a specific camera's last verified live frame,
 * keyed by both camera name and hardware serial number so frames can never collide across cameras.
 *
 * @param {Record<string, *>} cam - Camera configuration or state object.
 * @returns {string} Filesystem path in CACHE_DIR.
 */
const getCacheFilePath = (cam) => path.join(CACHE_DIR, 'last_' + cam.name + '_' + cam.serial + '.jpg');

/**
 * Loads the last cached live frame for a camera from CACHE_DIR (or legacy /tmp) if one was saved
 * prior to a container restart.
 *
 * @param {Record<string, *>} cam - Camera configuration object.
 * @returns {{ frame: Uint8Array|null, lastSeen: string }} YUV420p frame buffer and formatted mtime.
 */
function loadCachedFrame(cam) {
  const candidates = [getCacheFilePath(cam), '/tmp/last_' + cam.name + '_' + cam.serial + '.jpg'];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const decoded = decodeJpegToYuv(file);
      if (decoded) {
        let lastSeen = '';
        try {
          const st = fs.statSync(file);
          lastSeen = formatLocalHm(new Date(st.mtimeMs));
        } catch (err) {
          // Ignore stat errors on cached snapshot.
        }
        log.debug(cam, 'loaded cached snapshot from ' + file + (lastSeen ? ' (lastSeen=' + lastSeen + ')' : ''));
        return {frame: decoded, lastSeen};
      }
      log.warn(cam, 'failed to decode cached snapshot at ' + file);
    }
  }
  return {frame: null, lastSeen: ''};
}

/**
 * Saves the camera's latest verified raw YUV420p live frame to CACHE_DIR as a JPEG snapshot.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function saveCachedFrame(cam) {
  if (!Buffer.isBuffer(cam.lastFrame) || cam.lastFrame.length !== FRAME) return;
  const targetFile = getCacheFilePath(cam);
  try {
    const r = spawnSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'yuv420p',
          '-s',
          W + 'x' + H,
          '-i',
          'pipe:0',
          '-frames:v',
          '1',
          '-q:v',
          '2',
          targetFile,
        ],
        {input: cam.lastFrame}
    );
    if (r.status === 0) {
      log.debug(cam, 'saved cached snapshot to ' + targetFile);
    } else {
      log.warn(
          cam,
          'failed to save cached snapshot: ' + String(r.stderr || '').trim().split('\n').pop()
      );
    }
  } catch (err) {
    log.warn(cam, 'error saving cached snapshot: ' + err.message);
  }
}

/**
 * Returns true if the camera is currently in Low-Battery Economy Mode (battery is at or below
 * LOW_BAT_THRESHOLD and the camera is not actively charging).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {boolean}
 */
function isLowBattery(cam) {
  return (
      LOW_BAT_THRESHOLD > 0 &&
      cam.battery !== null &&
      !Number.isNaN(Number(cam.battery)) &&
      Number(cam.battery) <= LOW_BAT_THRESHOLD &&
      !cam.charging
  );
}

/**
 * Renders the asleep, waking, and busy status cards for a camera using its latest telemetry
 * and a single shared pre-dimmed background buffer.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function renderCameraCards(cam) {
  const title = cam.title || cam.name;
  const lowBat = isLowBattery(cam);
  const status = {
    camName: cam.name,
    camTitle: title,
    cardCfg: cam.cardCfg,
    telCfg: cam.telCfg,
    battery: cam.battery,
    charging: cam.charging,
    powerLabel: cam.powerLabel,
    economyMode: lowBat,
    wifi: cam.wifi,
    rssi: cam.rssi,
    temp: cam.temp,
    lastSeen: cam.lastSeen,
  };
  const {baseCanvas, hasBackground} = prepareBackgroundCanvas(cam.cardCfg, cam.lastFrame);
  const asleepTitle = lowBat ? 'Asleep (Low Battery)' : 'Asleep';
  const asleepLine2 =
      lowBat && !LOW_BAT_WAKE_ON_VIEW
          ? 'economy mode active, waking on motion events only'
          : 'feed, open this camera to wake it, or wait for motion';

  cam.asleep = card(
      asleepTitle,
      'No active stream on the ' + title + ' detect',
      asleepLine2,
      status,
      baseCanvas,
      hasBackground
  );
  cam.waking = card(
      'Waking Up...',
      'Connecting to ' + title + ' P2P livestream,',
      'live video starts in a few seconds',
      status,
      baseCanvas,
      hasBackground
  );
  cam.busy = card(
      'Waiting',
      'Another camera is currently live on the HomeBase,',
      'only one battery camera can stream at a time',
      status,
      baseCanvas,
      hasBackground
  );
  cam.liveTelState = evaluateTelemetryState('Live', status);
  if (cam.showCardOnLive && cam.cardCfg.theme === 'default' && cam.cardCfg.position !== 'center') {
    cam.liveCard = card('Live', '', '', status, baseCanvas, hasBackground);
  } else {
    cam.liveCard = null;
  }
  cam.burstUntil = Date.now() + 1200;
}

// Initialize runtime state for each configured camera.
const cams = cfg.cameras.map((c) => {
  const preserveAspect =
      c.preserve_aspect_ratio !== undefined ? Boolean(c.preserve_aspect_ratio) : GLOBAL_PRESERVE_ASPECT;
  const cardCfg = resolveCardConfig(c);
  const startupMode = c.startup_snapshot !== undefined ? c.startup_snapshot : GLOBAL_STARTUP_SNAPSHOT;
  const cached = loadCachedFrame(c);
  const usesSnapshot = cardCfg.background === 'snapshot';
  const needsStartupSnapshot =
      usesSnapshot && (startupMode === 'always' ? true : Boolean(startupMode) && cached.frame === null);

  const cam = {
    ...c,
    priority: clampNum(c.priority, -10000, 10000, 0),
    eventPriority: 0,
    stationSerial: c.station_serial || '',
    useRtsp: c.use_rtsp !== undefined ? Boolean(c.use_rtsp) : GLOBAL_USE_RTSP || Boolean(c.rtsp_url),
    rtspUrl: c.rtsp_url || '',
    rtspSupported: Boolean(c.rtsp_url || c.use_rtsp === true),
    rtspEnabledChecked: false,
    rtspFallbackUntil: 0,
    lastStoppedAt: 0,
    activeMode: '',
    pendingBackfill: null,
    backfillClip: null,
    lastBackfillQueryAt: 0,
    downloadedPaths: new Set(),
    downloadFrames: [],
    downloadFinished: false,
    isTestBackfill: false,
    preserveAspect,
    cardCfg,
    telCfg: resolveTelemetryConfig(c),
    autoFrigateMask:
        c.auto_frigate_mask !== undefined ? Boolean(c.auto_frigate_mask) : GLOBAL_AUTO_FRIGATE_MASK,
    showCardOnLive:
        c.card_show_on_live !== undefined ? Boolean(c.card_show_on_live) : GLOBAL_CARD_SHOW_ON_LIVE,
    lastSyncedMaskPoly: '',
    liveTelState: null,
    liveCard: null,
    liveOverlayBuf: Buffer.allocUnsafe(FRAME),
    suppressLiveCard: false,
    needsStartupSnapshot,
    isStartupProbe: false,
    useHwaccel: Boolean(ACTIVE_HWACCEL),
    active: false,
    starting: false,
    startPromise: null,
    eventActive: false,
    sessionId: 0,
    p2pReady: false,
    lastUnsolicitedStopAt: 0,
    videoWidth: 0,
    videoHeight: 0,
    videoCodec: '',
    motionUntil: 0,
    lastMotionAt: 0,
    motionClearedAt: 0,
    lastEarlySleepCheckAt: 0,
    viewUntil: 0,
    viewSince: 0,
    reason: '',
    wakeInitiator: '',
    sleptAt: 0,
    burstUntil: Date.now() + 2000,
    firstVideoAt: 0,
    firstFrameAt: 0,
    startedAt: 0,
    lastStartAt: 0,
    lastVideoAt: 0,
    restarts: 0,
    gotVideo: false,
    evTimer: null,
    evPending: false,
    evLabel: '',
    evPerson: '',
    evUntil: 0,
    battery: null,
    charging: false,
    powerLabel: '',
    wifi: null,
    rssi: null,
    temp: null,
    lastLowBatRefreshAt: 0,
    qualityChecked: false,
    lastSeen: cached.lastSeen,
    enc: null,
    dec: null,
    frame: null,
    lastFrame: cached.frame,
    frameAt: 0,
    frameNew: false,
    lastWrite: Date.now(),
    lastSent: null,
    pcm: [],
    pcmLen: 0,
    viewers: 0,
    viewerIds: new Map(),
    asleep: null,
    waking: null,
    busy: null,
  };
  renderCameraCards(cam);
  return cam;
});

const bySerial = new Map(cams.map((c) => [c.serial, c]));

/**
 * Returns the timestamp until which a camera wants to remain awake (the later of motion or viewer timers).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {number} Epoch timestamp in milliseconds.
 */
const want = (cam) => Math.max(cam.motionUntil, cam.viewUntil);

/**
 * Returns true if the camera is currently within an active motion hold window.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {boolean}
 */
const inMotion = (cam) => Date.now() < cam.motionUntil;

/**
 * Returns the effective arbitration priority score for a camera (camera priority + active event boost).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {number}
 */
const getEffectivePriority = (cam) =>
    inMotion(cam) ? cam.priority + (cam.eventPriority || 0) : cam.priority;

/**
 * Returns true if the camera is currently active using the shared HomeBase P2P slot
 * (either a live P2P stream or a post-event P2P clip download).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {boolean}
 */
const usesP2pSlot = (cam) => Boolean(cam.active && cam.activeMode !== 'rtsp');

/**
 * Returns true if the camera is configured and able to stream via HomeBase native RTSP.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {boolean}
 */
const isRtspCapable = (cam) =>
    Boolean(
        cam.useRtsp &&
        cam.rtspUrl &&
        cam.activeMode !== 'p2p' &&
        cam.activeMode !== 'download' &&
        Date.now() >= (cam.rtspFallbackUntil || 0)
    );

/**
 * Returns the station serial key governing a camera's P2P slot.
 * Standalone Wi-Fi cameras/doorbells have their own serial as stationSerialNumber,
 * allowing them to stream concurrently with HomeBase-paired cameras.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {string}
 */
const getStationKey = (cam) => cam.stationSerial || cam.station_serial || 'default_station';

/**
 * Clears any pending viewer wake timer on a camera and marks all of its current go2rtc
 * consumers as ineligible to wake it until they disconnect and reconnect.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} [clearReason=''] - Optional diagnostic context for why the viewer queue was cleared.
 */
function clearViewerQueue(cam, clearReason = '') {
  const hadViewers = cam.viewUntil > Date.now() || [...cam.viewerIds.values()].some(Boolean);
  cam.viewUntil = 0;
  cam.viewSince = 0;
  for (const id of cam.viewerIds.keys()) {
    cam.viewerIds.set(id, false);
  }
  if (hadViewers && clearReason) {
    log.debug(cam, 'cleared pending viewer wake queue (' + clearReason + ')');
  }
}

/**
 * Computes the bounding box { boxX, boxY, boxW, boxH } of a camera's corner status card
 * across all states so Frigate motion/object masks and live overlays cover the exact card footprint.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {{ boxX: number, boxY: number, boxW: number, boxH: number }|null}
 */
function getCameraCardBounds(cam) {
  const {theme, position} = cam.cardCfg;
  if (theme === 'none' || position === 'center') return null;

  let boxW = 92;
  let boxH = 36;
  if (theme === 'icons') {
    const tc = cam.telCfg;
    let contentW = 20;
    if (tc.enabled && tc.battery) contentW += 16 + 37;
    if (tc.enabled && tc.wifi) contentW += 16 + 28;
    if (tc.enabled && tc.temperature) contentW += 16 + 16;
    if (tc.enabled && tc.lastSeen) contentW += 16 + 20;
    boxW = contentW + 32;
    boxH = 44;
  } else if (theme === 'default') {
    const title = cam.title || cam.name;
    const maxHeader = 'Asleep (Low Battery)  -  ' + title;
    const headerW = 42 + maxHeader.length * 11 + 24;
    const st = cam.liveTelState || evaluateTelemetryState('Asleep', {
      telCfg: cam.telCfg,
      battery: cam.battery ?? 100,
      charging: cam.charging,
      powerLabel: cam.powerLabel || 'Charging',
      wifi: cam.wifi ?? 4,
      rssi: cam.rssi ?? -60,
      temp: cam.temp ?? 25,
      lastSeen: cam.lastSeen || '00:00',
    });
    const segments = buildTelemetrySegments(st);
    const hasTelemetry = cam.telCfg.enabled && segments.length > 0;
    const gap = 18;
    const telW = hasTelemetry
        ? segments.reduce((sum, seg) => sum + seg.width, 0) + gap * Math.max(0, segments.length - 1) + 44
        : 0;
    boxW = Math.min(W - 48, Math.max(hasTelemetry ? 540 : 400, telW, headerW));
    boxH = hasTelemetry ? 88 : 48;
  }

  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);
  return {boxX, boxY, boxW, boxH};
}

/**
 * Copies the rectangular sub-region (boxX, boxY, boxW, boxH) from srcYuv to dstYuv.
 *
 * @param {Uint8Array} srcYuv - Source YUV420p frame buffer.
 * @param {Uint8Array} dstYuv - Destination YUV420p frame buffer.
 * @param {number} boxX - Left X coordinate.
 * @param {number} boxY - Top Y coordinate.
 * @param {number} boxW - Width in pixels.
 * @param {number} boxH - Height in pixels.
 */
function copyYuvRegion(srcYuv, dstYuv, boxX, boxY, boxW, boxH) {
  const x0 = Math.max(0, boxX & ~1);
  const y0 = Math.max(0, boxY & ~1);
  const x1 = Math.min(W, (boxX + boxW + 1) & ~1);
  const y1 = Math.min(H, (boxY + boxH + 1) & ~1);
  const rw = x1 - x0;
  if (rw <= 0 || y1 <= y0) return;

  for (let y = y0; y < y1; y++) {
    const off = y * W + x0;
    srcYuv.copy(dstYuv, off, off, off + rw);
  }
  const cw = W >> 1;
  const cSize = cw * (H >> 1);
  const cx0 = x0 >> 1;
  const cy0 = y0 >> 1;
  const cy1 = y1 >> 1;
  const crw = rw >> 1;
  for (let cy = cy0; cy < cy1; cy++) {
    const uOff = W * H + cy * cw + cx0;
    const vOff = uOff + cSize;
    srcYuv.copy(dstYuv, uOff, uOff, uOff + crw);
    srcYuv.copy(dstYuv, vOff, vOff, vOff + crw);
  }
}

/**
 * Composites the camera's corner status card onto a copy of a live video frame when
 * card_show_on_live is enabled, leaving the original raw frame (and cam.lastFrame) untouched.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Uint8Array} rawFrame - Clean decoded YUV420p video frame.
 * @returns {Uint8Array} YUV420p frame buffer with corner overlay applied (or rawFrame if disabled).
 */
function renderLiveFrameWithCard(cam, rawFrame) {
  if (
      !cam.showCardOnLive ||
      cam.suppressLiveCard ||
      cam.cardCfg.theme === 'none' ||
      cam.cardCfg.position === 'center'
  ) {
    return rawFrame;
  }
  const out = cam.liveOverlayBuf;
  rawFrame.copy(out);
  const st = cam.liveTelState || evaluateTelemetryState('Live', {
    telCfg: cam.telCfg,
    battery: cam.battery,
    charging: cam.charging,
    powerLabel: cam.powerLabel,
    economyMode: isLowBattery(cam),
    wifi: cam.wifi,
    rssi: cam.rssi,
    temp: cam.temp,
    lastSeen: cam.lastSeen,
  });

  if (cam.cardCfg.theme === 'minimal') {
    drawMinimalDotsCard(out, cam.cardCfg.position, st, true);
    return out;
  }
  if (cam.cardCfg.theme === 'icons') {
    drawIconsOnlyCard(out, cam.cardCfg.position, st, true);
    return out;
  }
  if (cam.cardCfg.theme === 'default' && Buffer.isBuffer(cam.liveCard)) {
    const bounds = getCameraCardBounds(cam);
    if (bounds) {
      copyYuvRegion(cam.liveCard, out, bounds.boxX, bounds.boxY, bounds.boxW, bounds.boxH);
    }
    return out;
  }
  return rawFrame;
}

/**
 * Computes the normalized Frigate mask polygon string ('x0,y0,x0,y1,x1,y1,x1,y0')
 * for a camera's status card with a 6px chroma/anti-aliasing safety margin.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {string} Normalized polygon coordinates, or '' if no corner card is active.
 */
function computeFrigateMaskPolygon(cam) {
  const bounds = getCameraCardBounds(cam);
  if (!bounds) return '';
  const pad = 6;
  const x0 = Math.max(0, (bounds.boxX - pad) / W).toFixed(3);
  const y0 = Math.max(0, (bounds.boxY - pad) / H).toFixed(3);
  const x1 = Math.min(1, (bounds.boxX + bounds.boxW + pad) / W).toFixed(3);
  const y1 = Math.min(1, (bounds.boxY + bounds.boxH + pad) / H).toFixed(3);
  return x0 + ',' + y0 + ',' + x0 + ',' + y1 + ',' + x1 + ',' + y1 + ',' + x1 + ',' + y0;
}

/**
 * Synchronizes a single mask section ('motion' or 'objects') for a camera in Frigate via
 * PUT /api/config/set (requires_restart: 0).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} camCfg - Camera configuration object from Frigate /api/config.
 * @param {'motion'|'objects'} section - Frigate mask section ('motion' or 'objects').
 * @param {string} poly - Normalized polygon string, or '' to disable.
 * @returns {Promise<'verified'|'applied'|'disabled'|'none'|'failed'>}
 */
async function syncSingleFrigateMaskSection(cam, camCfg, section, poly) {
  const sectionObj = camCfg && camCfg[section] ? camCfg[section] : null;
  const existingMasks = sectionObj ? sectionObj.mask : undefined;
  const isNamedDict =
      existingMasks !== null && typeof existingMasks === 'object' && !Array.isArray(existingMasks);

  if (!poly) {
    if (isNamedDict && existingMasks.eufy_bridge_card && existingMasks.eufy_bridge_card.enabled) {
      try {
        const res = await fetch(cfg.frigate_api + '/api/config/set', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            requires_restart: 0,
            update_topic: 'config/cameras/' + cam.name + '/' + section,
            config_data: {
              cameras: {
                [cam.name]: {
                  [section]: {
                    mask: {
                      eufy_bridge_card: {
                        friendly_name: 'Eufy Bridge Status Card',
                        enabled: false,
                        coordinates: existingMasks.eufy_bridge_card.coordinates,
                      },
                    },
                  },
                },
              },
            },
          }),
        });
        return res.ok ? 'disabled' : 'failed';
      } catch (err) {
        log.warn(cam, 'failed to disable Frigate ' + section + '.mask: ' + err.message);
        return 'failed';
      }
    }
    return 'none';
  }

  if (
      isNamedDict &&
      existingMasks.eufy_bridge_card &&
      existingMasks.eufy_bridge_card.enabled !== false &&
      existingMasks.eufy_bridge_card.coordinates === poly
  ) {
    return 'verified';
  }

  try {
    const putRes = await fetch(cfg.frigate_api + '/api/config/set', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        requires_restart: 0,
        update_topic: 'config/cameras/' + cam.name + '/' + section,
        config_data: {
          cameras: {
            [cam.name]: {
              [section]: {
                mask: {
                  eufy_bridge_card: {
                    friendly_name: 'Eufy Bridge Status Card',
                    enabled: true,
                    coordinates: poly,
                  },
                },
              },
            },
          },
        },
      }),
    });

    if (putRes.ok) {
      return 'applied';
    }

    // Fallback for Frigate 0.14-0.16 query parameter format.
    const legacyUrl =
        cfg.frigate_api +
        '/api/config/set?cameras.' +
        encodeURIComponent(cam.name) +
        '.' +
        section +
        '.mask=' +
        encodeURIComponent(poly);
    const legRes = await fetch(legacyUrl, {
      method: 'PUT',
      signal: AbortSignal.timeout(8000),
    });
    if (legRes.ok) {
      return 'applied';
    }

    const errText = (await putRes.text()).slice(0, 160);
    log.warn(
        cam,
        'could not auto-apply Frigate ' +
        section +
        '.mask (HTTP ' +
        putRes.status +
        '): ' +
        errText +
        ' (calculated mask=' +
        poly +
        ')'
    );
    return 'failed';
  } catch (err) {
    log.warn(cam, 'error syncing Frigate ' + section + '.mask (' + poly + '): ' + err.message);
    return 'failed';
  }
}

/**
 * Automatically synchronizes each camera's calculated corner status card motion.mask and
 * objects.mask into Frigate via Frigate's HTTP API (GET /api/config + PUT /api/config/set).
 */
let isSyncingMasks = false;
let frigateApiDown = false;
let lastMaskCheckAt = 0;

async function syncFrigateMotionMasks(forceResync = false) {
  if (isSyncingMasks || shuttingDown || !cfg.frigate_api || !cams.some((c) => c.autoFrigateMask)) return;
  isSyncingMasks = true;
  try {
    if (forceResync) {
      for (const c of cams) c.lastSyncedMaskPoly = '';
    }
    let frigateCfg = null;
    try {
      const r = await fetch(cfg.frigate_api + '/api/config', {signal: AbortSignal.timeout(5000)});
      if (!r.ok) {
        frigateApiDown = true;
        return;
      }
      frigateCfg = await r.json();
    } catch (err) {
      frigateApiDown = true;
      log.debug('bridge', 'could not fetch Frigate /api/config for auto_frigate_mask: ' + err.message);
      return;
    }

    lastMaskCheckAt = Date.now();
    for (const cam of cams) {
      if (!cam.autoFrigateMask) continue;
      const poly = computeFrigateMaskPolygon(cam);
      const camCfg = frigateCfg && frigateCfg.cameras ? frigateCfg.cameras[cam.name] : null;
      if (!camCfg) continue;

      const motMask = camCfg.motion && camCfg.motion.mask ? camCfg.motion.mask.eufy_bridge_card : null;
      const objMask = camCfg.objects && camCfg.objects.mask ? camCfg.objects.mask.eufy_bridge_card : null;
      const masksIntact =
          motMask &&
          motMask.enabled !== false &&
          motMask.coordinates === poly &&
          objMask &&
          objMask.enabled !== false &&
          objMask.coordinates === poly;

      if (poly && cam.lastSyncedMaskPoly === poly && masksIntact) continue;

      const motionStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'motion', poly);
      const objectStatus = await syncSingleFrigateMaskSection(cam, camCfg, 'objects', poly);

      if (!poly) {
        if (motionStatus === 'disabled' || objectStatus === 'disabled') {
          log.info(
              cam,
              'disabled Frigate motion & object masks eufy_bridge_card (card is ' +
              cam.cardCfg.theme +
              '/' +
              cam.cardCfg.position +
              ')'
          );
        }
        continue;
      }

      if (motionStatus !== 'failed' && objectStatus !== 'failed') {
        cam.lastSyncedMaskPoly = poly;
        const actionVerb =
            motionStatus === 'applied' || objectStatus === 'applied' ? 'auto-applied' : 'verified';
        log.info(
            cam,
            actionVerb +
            ' Frigate motion & object masks eufy_bridge_card (' +
            cam.cardCfg.theme +
            '@' +
            cam.cardCfg.position +
            ' -> ' +
            poly +
            ')'
        );
      }
    }
  } finally {
    isSyncingMasks = false;
  }
}

/**
 * Pushes the appropriate video frame (live decoded video, waking card, busy card, or asleep card)
 * to a camera's persistent FFmpeg encoder stdin immediately when a state change or new decoded
 * frame arrives, or on the periodic frame tick.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
function pushFrameToEncoder(cam, now = Date.now()) {
  const enc = cam.enc;
  if (!enc || !enc.stdin || !enc.stdin.writable) return;
  if (enc.stdin.writableNeedDrain) {
    if (now - cam.lastWrite > 10000) {
      log.error(
          cam,
          'encoder stdin wedged for >10s (initiator=bridge-watchdog, reason=encoder_stdin_backpressure), killing encoder process'
      );
      try {
        enc.kill('SIGKILL');
      } catch (err) {
        // Ignore kill errors on wedged encoder.
      }
    }
    return;
  }

  if (
      cam.active &&
      cam.activeMode === 'download' &&
      cam.downloadFrames.length > 0 &&
      now - cam.lastWrite >= Math.floor(1000 / LIVE_FPS) - 4
  ) {
    const nextBuf = cam.downloadFrames.shift();
    cam.frame = nextBuf;
    cam.frameAt = now;
    cam.lastVideoAt = now;
    cam.frameNew = true;
    cam.lastFrame = nextBuf;
    cam.lastSeen = formatLocalHm(new Date(now));
  }

  const hasFreshFrame = Boolean(cam.frame && now - cam.frameAt < 2000);
  const live = cam.active && (hasFreshFrame || (cam.gotVideo && Buffer.isBuffer(cam.lastFrame)));
  const rawLiveFrame = hasFreshFrame ? cam.frame : cam.lastFrame;
  const liveFrame =
      live && rawLiveFrame ? renderLiveFrameWithCard(cam, rawLiveFrame) : rawLiveFrame;
  const frame = live
      ? liveFrame
      : cam.suppressLiveCard && Buffer.isBuffer(cam.lastFrame)
          ? cam.lastFrame
          : cam.active
              ? cam.waking
              : now < want(cam)
                  ? cam.busy
                  : cam.asleep;
  const stateChanged = frame !== cam.lastSent;
  if (stateChanged) {
    cam.burstUntil = Math.max(cam.burstUntil || 0, now + 1200);
  }
  const inBurst = now < (cam.burstUntil || 0);

  if (
      live
          ? cam.frameNew || now - cam.lastWrite >= 500
          : stateChanged || inBurst || now - cam.lastWrite >= 1000 / IDLE_FPS
  ) {
    enc.stdin.write(frame);
    cam.lastWrite = now;
    cam.lastSent = frame;
    cam.frameNew = false;
  }
}

let ws = null;
let wsReady = false;
let wsReadyAt = 0;
let initialTelemetryLoaded = false;
let seq = 0;
let shuttingDown = false;
const stationTransitions = new Map();
const getStationTransition = (cam) => stationTransitions.get(getStationKey(cam)) || Promise.resolve();
const setStationTransition = (cam, p) => stationTransitions.set(getStationKey(cam), p);
const waiting = new Map();

/**
 * Sends a command object to eufy-security-ws over WebSocket and resolves with the response message.
 * Times out after 20 seconds or resolves immediately with an error if the socket is closed.
 *
 * @param {Record<string, *>} commandPayload - Command fields to send alongside the generated messageId.
 * @returns {Promise<Record<string, *>>} Response object from eufy-security-ws.
 */
function call(commandPayload) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return resolve({success: false, errorCode: 'ws_closed'});
    }
    const id = 'b' + ++seq;
    const timer = setTimeout(() => {
      if (waiting.delete(id)) resolve({success: false, errorCode: 'no_reply'});
    }, 20000);
    waiting.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    ws.send(JSON.stringify({messageId: id, ...commandPayload}), (err) => {
      if (err && waiting.delete(id)) {
        clearTimeout(timer);
        resolve({success: false, errorCode: err.message});
      }
    });
  });
}

/**
 * Unwraps a property value returned by eufy-security-ws, handling both direct values
 * (API schema 10+) and metadata-wrapped { value } objects (older schemas).
 *
 * @param {*} prop - Raw property entry from eufy-security-ws.
 * @returns {*} Unwrapped primitive or object value.
 */
function unwrapProperty(prop) {
  return prop !== null && typeof prop === 'object' && 'value' in prop ? prop.value : prop;
}

/**
 * Checks the camera's videoStreamingQuality property and, if enforce_streaming_quality is enabled,
 * automatically switches cameras configured as "Auto" (0) to Medium (7, 1280x720) so P2P streams
 * do not negotiate 4K and stall.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties.
 */
function checkStreamingQuality(cam, props) {
  if (!ENFORCE_QUALITY || cam.qualityChecked || !props || !('videoStreamingQuality' in props)) return;
  const currentQuality = Number(unwrapProperty(props.videoStreamingQuality));
  if (Number.isNaN(currentQuality)) return;
  cam.qualityChecked = true;

  const targetQuality = typeof ENFORCE_QUALITY === 'number' ? ENFORCE_QUALITY : 7;
  const shouldUpdate = typeof ENFORCE_QUALITY === 'number' ? currentQuality !== targetQuality : currentQuality === 0;

  if (shouldUpdate) {
    log.info(
        cam,
        'videoStreamingQuality is ' +
        currentQuality +
        ' (Auto), setting to ' +
        targetQuality +
        ' (Medium 720p) to prevent P2P stalls'
    );
    call({
      command: 'device.set_property',
      serialNumber: cam.serial,
      name: 'videoStreamingQuality',
      value: targetQuality,
    }).then((res) => {
      if (!res.success) {
        log.warn(cam, 'could not set videoStreamingQuality: ' + (res.errorCode || 'unknown'));
      }
    });
  }
}

/**
 * Applies device telemetry properties (battery, chargingStatus, powerSource, wifiSignalLevel,
 * wifiRssi, and batteryTemperature) from eufy-security-ws to a camera's state.
 * Always updates telemetry values in memory even when cam.telCfg.enabled is false so that
 * Low-Battery Economy Mode and the 'minimal' 3-dot theme always have live state data.
 * Intentionally ignores props.picture because eufy-security-client on HomeBase 2/3 can populate
 * picture with the last notification thumbnail from a different camera on the same station.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties or start_listening.
 * @param {boolean} [allowCardRebuild=false] - Whether to re-render the sleeping card immediately.
 */
function applyDeviceProperties(cam, props, allowCardRebuild = false) {
  if (!props || typeof props !== 'object') return;

  checkStreamingQuality(cam, props);

  const hadInitialTelemetry = cam.battery !== null;
  const prevBattery = cam.battery;
  const prevCharging = cam.charging;
  const prevWifi = cam.wifi;
  const prevRssi = cam.rssi;
  const prevTemp = cam.temp;
  const wasLowBat = isLowBattery(cam);

  const bat = unwrapProperty(props.battery ?? props.batteryLevel);
  const chgStatus = unwrapProperty(props.chargingStatus);
  const chgBool = unwrapProperty(props.batteryIsCharging);
  const pwrSrc = unwrapProperty(props.powerSource);
  const wifi = unwrapProperty(props.wifiSignalLevel ?? props.cellularSignalLevel);
  const rssi = unwrapProperty(props.wifiRssi ?? props.cellularRSSI);
  const temp = unwrapProperty(props.batteryTemperature ?? props.temperature);
  const model = unwrapProperty(props.model);
  const swVer = unwrapProperty(props.softwareVersion);
  const stationSn = unwrapProperty(props.stationSerialNumber);
  const rtspUrlProp = unwrapProperty(props.rtspStreamUrl);
  const rtspStreamProp = unwrapProperty(props.rtspStream);

  if (stationSn && typeof stationSn === 'string') {
    cam.stationSerial = stationSn;
  }
  if (rtspUrlProp && typeof rtspUrlProp === 'string' && !cam.rtsp_url) {
    if (cam.rtspUrl !== rtspUrlProp) {
      cam.rtspUrl = rtspUrlProp;
      cam.rtspSupported = true;
      log.info(cam, 'discovered HomeBase RTSP URL (' + rtspUrlProp.replace(/:\/\/[^@]+@/, '://***@') + ')');
      if (cam.active && cam.activeMode === 'rtsp' && !cam.dec) {
        startRtspDecoder(cam, cam.rtspUrl);
      }
    }
  }
  if (cam.useRtsp && cam.rtspUrl && !cam.rtspEnabledChecked && rtspStreamProp === false) {
    cam.rtspEnabledChecked = true;
    log.info(cam, 'enabling HomeBase RTSP stream (rtspStream=true) via eufy-security-ws');
    call({
      command: 'device.set_property',
      serialNumber: cam.serial,
      name: 'rtspStream',
      value: true,
    }).then((res) => {
      if (!res.success) {
        log.warn(cam, 'could not set rtspStream property: ' + (res.errorCode || 'unknown'));
      }
    });
  }

  if (bat !== undefined && bat !== null) {
    cam.battery = Number(bat);
  }

  if (chgStatus !== undefined && chgStatus !== null) {
    // Eufy ChargingType: 1 = CHARGING, 2 = UNPLUGGED, 3 = PLUGGED, 4 = SOLAR_CHARGING.
    const code = Number(chgStatus);
    cam.charging = chgStatus === true || code === 1 || code === 3 || code === 4;
    cam.powerLabel = code === 4 ? 'Solar' : code === 3 ? 'Plugged' : cam.charging ? 'Charging' : '';
  } else if (chgBool !== undefined && chgBool !== null) {
    cam.charging = Boolean(chgBool);
    if (cam.charging && !cam.powerLabel) cam.powerLabel = 'Charging';
    if (!cam.charging) cam.powerLabel = '';
  }

  if (pwrSrc !== undefined && pwrSrc !== null && Number(pwrSrc) === 1 && !cam.powerLabel) {
    cam.powerLabel = 'Solar';
  }

  if (rssi !== undefined && rssi !== null && Number(rssi) < 0) {
    cam.rssi = Number(rssi);
  }

  if (wifi !== undefined && wifi !== null) {
    cam.wifi = Number(wifi);
  } else if (cam.wifi === null && cam.rssi !== null) {
    const dbm = cam.rssi;
    cam.wifi = dbm >= -60 ? 4 : dbm >= -70 ? 3 : dbm >= -80 ? 2 : 1;
  }

  if (temp !== undefined && temp !== null) {
    cam.temp = Number(temp);
  }

  const nowLowBat = isLowBattery(cam);
  const batterySwapped =
      prevBattery !== null && cam.battery !== null && Math.abs(cam.battery - prevBattery) >= 10;
  const stateChanged =
      hadInitialTelemetry &&
      (wasLowBat !== nowLowBat || prevCharging !== cam.charging || batterySwapped);
  const minorTelemetryChanged =
      hadInitialTelemetry &&
      !stateChanged &&
      (prevBattery !== cam.battery ||
          prevWifi !== cam.wifi ||
          prevRssi !== cam.rssi ||
          prevTemp !== cam.temp);

  if (!hadInitialTelemetry && cam.battery !== null) {
    const hwInfo = model || swVer ? 'model=' + (model || 'n/a') + ', fw=' + (swVer || 'n/a') + ', ' : '';
    const pwrMode = cam.powerLabel || (nowLowBat ? 'battery [ECO]' : 'battery');
    const wifiVal = cam.wifi ?? 'n/a';
    const rssiVal = cam.rssi ?? 'n/a';
    const tempVal = cam.temp ?? 'n/a';
    log.info(
        cam,
        'telemetry loaded (' +
        hwInfo +
        'battery=' +
        cam.battery +
        '%, power=' +
        pwrMode +
        ', wifi=' +
        wifiVal +
        '/4, rssi=' +
        rssiVal +
        'dBm, temp=' +
        tempVal +
        '°C)'
    );
  } else if (stateChanged) {
    const ecoStatus = nowLowBat ? 'entered low-battery economy mode' : 'normal mode restored';
    log.info(
        cam,
        'battery state updated (' +
        (prevBattery ?? 'n/a') +
        '% -> ' +
        cam.battery +
        '%, power=' +
        (cam.powerLabel || 'battery') +
        ', ' +
        ecoStatus +
        ')'
    );
  } else if (minorTelemetryChanged) {
    log.debug(
        cam,
        'telemetry updated (battery=' +
        (cam.battery ?? 'n/a') +
        '%, power=' +
        (cam.powerLabel || 'battery') +
        ', wifi=' +
        (cam.wifi ?? 'n/a') +
        '/4, rssi=' +
        (cam.rssi ?? 'n/a') +
        'dBm, temp=' +
        (cam.temp ?? 'n/a') +
        '°C)'
    );
  }

  // Rebuild the static card on initial load, explicit sleep refresh, or significant battery/economy state change.
  if (allowCardRebuild || !hadInitialTelemetry || stateChanged) {
    renderCameraCards(cam);
    pushFrameToEncoder(cam);
  }
}

/**
 * Queries device.get_properties for all configured cameras so battery, charging/power mode,
 * Wi-Fi signal/RSSI, temperature, and streaming quality are populated on API schema 13+.
 * If any camera is in Low-Battery Economy Mode (or forceRefresh is true), issues driver.poll_refresh
 * first so eufy-security-ws syncs fresh battery data from the HomeBase after a physical battery swap.
 *
 * @param {boolean} [forceRefresh=false] - Whether to force a driver.poll_refresh before reading properties.
 */
async function fetchAllCameraTelemetry(forceRefresh = false) {
  if (!wsReady) return;
  if (forceRefresh || cams.some((c) => isLowBattery(c))) {
    log.debug('bridge', 'polling HomeBase via driver.poll_refresh for fresh battery telemetry');
    await call({command: 'driver.poll_refresh'});
    await sleep(2000);
  }
  for (const cam of cams) {
    if (!wsReady) return;
    const res = await call({command: 'device.get_properties', serialNumber: cam.serial});
    if (res.success && res.result && res.result.properties) {
      applyDeviceProperties(cam, res.result.properties, cam.battery === null);
    } else if (!res.success) {
      log.warn(cam, 'device.get_properties failed: ' + (res.errorCode || 'unknown'));
    }
  }
  if (!initialTelemetryLoaded) {
    initialTelemetryLoaded = true;
    void syncFrigateMotionMasks();
  }
}

/**
 * Establishes and maintains the WebSocket connection to eufy-security-ws.
 * Negotiates the API schema version, starts listening for Eufy events, and loads initial telemetry.
 */
function connectWs() {
  if (shuttingDown) return;
  ws = new WebSocket(cfg.eufy_ws);

  ws.on('open', () => log.info('bridge', 'eufy-security-ws connected (' + cfg.eufy_ws + ')'));

  ws.on('close', () => {
    wsReady = false;
    initialTelemetryLoaded = false;
    for (const [id, resolve] of waiting) {
      waiting.delete(id);
      resolve({success: false, errorCode: 'ws_closed'});
    }
    log.warn('bridge', 'eufy-security-ws connection closed, retrying in 10 s');
    for (const c of cams) {
      c.motionUntil = 0;
      clearViewerQueue(c, 'ws_closed');
      if (c.active) {
        stop(c, 'bridge lost eufy-security-ws connection', false, 'error/ws-disconnect');
      }
    }
    if (!shuttingDown) setTimeout(connectWs, 10000);
  });

  ws.on('error', (e) => log.error('bridge', 'eufy-security-ws error: ' + e.message));

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch (err) {
      return;
    }

    if (m.type === 'version') {
      const targetSchema = Math.min(m.maxSchemaVersion, 21);
      await call({command: 'set_api_schema', schemaVersion: targetSchema});
      const st = await call({command: 'start_listening'});
      wsReady = Boolean(st.success);
      wsReadyAt = Date.now();
      if (wsReady) {
        log.info('bridge', 'listening for eufy events (apiSchema=' + targetSchema + ')');
      } else {
        log.error('bridge', 'start_listening failed: ' + (st.errorCode || 'unknown'));
      }

      if (wsReady) {
        const devices = (st.result && st.result.state && st.result.state.devices) || [];
        for (const dev of devices) {
          if (dev && typeof dev === 'object' && dev.serialNumber) {
            const cam = bySerial.get(dev.serialNumber);
            if (cam) applyDeviceProperties(cam, dev, true);
          }
        }
        await fetchAllCameraTelemetry();
        setTimeout(() => {
          if (wsReady && cams.some((c) => c.battery === null)) {
            void fetchAllCameraTelemetry();
          }
        }, 10000);
      }
    } else if (m.type === 'result' && m.messageId) {
      const r = waiting.get(m.messageId);
      if (r) {
        waiting.delete(m.messageId);
        r(m);
      }
    } else if (m.type === 'event') {
      try {
        onEvent(m.event || {});
      } catch (err) {
        log.error('bridge', 'unhandled error in onEvent: ' + err.message);
      }
    }
  });
}

/**
 * Extracts a recognized person's name from an Eufy event payload (such as 'identity person detected'
 * on HomeBase 3) when forward_face_names is enabled.
 *
 * @param {Record<string, *>} e - Event object from eufy-security-ws.
 * @returns {string} Recognized person name, or empty string if unknown/disabled.
 */
function extractRecognizedPerson(e) {
  if (!FORWARD_FACE_NAMES || !e) return '';
  const rawName = e.person || e.personName || '';
  if (typeof rawName !== 'string') return '';
  const cleaned = rawName.trim();
  if (!cleaned || /^unknown$/i.test(cleaned) || /^stranger$/i.test(cleaned)) return '';
  return cleaned;
}

/**
 * Handles incoming event notifications from eufy-security-ws, including livestream media packets,
 * stream start/stop notifications, device telemetry updates, and motion/person/pet/ring triggers.
 * If a camera finishes waking on the HomeBase after its session was already canceled or preempted,
 * immediately sends device.stop_livestream so it does not remain awake in the background.
 *
 * @param {Record<string, *>} e - Event object from eufy-security-ws.
 */
function onEvent(e) {
  if (e.event === 'device added' && e.device && e.device.serialNumber) {
    const cam = bySerial.get(e.device.serialNumber);
    if (cam) applyDeviceProperties(cam, e.device, cam.battery === null);
    return;
  }
  if (e.source === 'station') {
    const stationId = e.serialNumber || 'homebase';
    if (e.event === 'close' || e.event === 'connection error') {
      log.warn('bridge', 'HomeBase station (' + stationId + ') P2P disconnected or restarting (' + e.event + ')');
      for (const c of cams) {
        if (c.stationSerial && e.serialNumber && c.stationSerial !== e.serialNumber) continue;
        c.motionUntil = 0;
        clearViewerQueue(c, 'station_disconnected');
        if (c.active) {
          stop(c, 'Station (' + stationId + ') P2P disconnected/restarting', false, 'error/station-disconnect');
        }
      }
    } else if (e.event === 'connect') {
      log.info('bridge', 'HomeBase station (' + stationId + ') P2P connected');
      setTimeout(() => {
        if (wsReady && !shuttingDown) void fetchAllCameraTelemetry();
      }, 3000);
    } else if (e.event && e.event.includes('database query')) {
      handleDatabaseQueryResult(e);
    }
    return;
  }

  const cam = bySerial.get(e.serialNumber);
  if (!cam) return;

  switch (e.event) {
    case 'livestream video data':
      if (!cam.active) {
        const now = Date.now();
        const stoppedRef = Math.max(cam.sleptAt || 0, cam.lastStoppedAt || 0);
        if (now - stoppedRef > 5000 && now - cam.lastUnsolicitedStopAt > 5000) {
          cam.lastUnsolicitedStopAt = now;
          const sleptAgo = stoppedRef ? Math.round((now - stoppedRef) / 1000) + 's' : 'never';
          log.warn(
              cam,
              'received video while inactive, forcing stop of late stream (initiator=bridge, cause=eufy_unsolicited_video, sleptAgo=' +
              sleptAgo +
              ')'
          );
          void call({command: 'device.stop_livestream', serialNumber: cam.serial});
        }
        return;
      }
      return onVideo(cam, e);

    case 'livestream audio data':
      return onAudio(cam, e);

    case 'download video data':
      if (!cam.active || cam.activeMode !== 'download') return;
      return onVideo(cam, e);

    case 'download audio data':
      if (!cam.active || cam.activeMode !== 'download') return;
      return onAudio(cam, e);

    case 'download started':
      if (!cam.active || cam.activeMode !== 'download') {
        void call({command: 'device.cancel_download', serialNumber: cam.serial});
        return;
      }
      cam.p2pReady = true;
      return log.info(cam, 'eufy clip download started (session=' + cam.sessionId + ')');

    case 'download finished':
      if (cam.active && cam.activeMode === 'download') {
        cam.downloadFinished = true;
        if (cam.downloadFrames.length > 0) {
          log.info(
              cam,
              'eufy clip transfer complete, playing remaining ' +
              cam.downloadFrames.length +
              ' buffered frames at ' +
              LIVE_FPS +
              ' fps (session=' +
              cam.sessionId +
              ')'
          );
          return;
        }
      }
      if (cam.active && cam.activeMode === 'download') {
        const elapsed = Date.now() - cam.startedAt;
        const waitMs = cam.gotVideo && elapsed < 4500 ? 4500 - elapsed : 0;
        if (waitMs > 0) {
          const finSession = cam.sessionId;
          setTimeout(() => {
            if (cam.active && cam.activeMode === 'download' && cam.sessionId === finSession) {
              stop(cam, 'post-event clip download finished', false, 'eufy/download-finished');
              arbitrate();
            }
          }, waitMs);
        } else {
          stop(cam, 'post-event clip download finished', false, 'eufy/download-finished');
          arbitrate();
        }
      }
      return;

    case 'rtsp livestream started':
      if (cam.active && cam.activeMode === 'rtsp') {
        if (cam.rtspUrl && !cam.dec) {
          startRtspDecoder(cam, cam.rtspUrl);
        }
        return log.info(cam, 'eufy RTSP livestream started (session=' + cam.sessionId + ')');
      }
      return log.debug(cam, 'ignoring RTSP livestream started event while in P2P/idle mode');

    case 'rtsp livestream stopped':
      if (cam.active && cam.activeMode === 'rtsp') {
        stop(cam, 'eufy ended RTSP livestream', false, 'eufy/rtsp-end');
        arbitrate();
      }
      return;

    case 'livestream started':
      if (!cam.active) {
        log.warn(
            cam,
            'eufy livestream started after session was already closed/canceled, forcing immediate stop (initiator=bridge, cause=eufy_late_start)'
        );
        void call({command: 'device.stop_livestream', serialNumber: cam.serial});
        return;
      }
      cam.p2pReady = true;
      return log.info(cam, 'eufy livestream started (session=' + cam.sessionId + ')');

    case 'livestream stopped': {
      const now = Date.now();
      const liveSecs = cam.startedAt ? Math.round((now - cam.startedAt) / 1000) : 0;
      const lastVideoAgo = cam.lastVideoAt ? ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
      cam.p2pReady = false;
      stopDecoder(cam);

      // When Eufy/HomeBase ends an event stream according to app settings and no viewer is watching,
      // let the camera sleep cleanly instead of forcing it to re-wake.
      const eufyEndedEventCleanly =
          cam.active &&
          cam.eventActive &&
          LET_EUFY_DECIDE_END &&
          cam.gotVideo &&
          now >= cam.viewUntil &&
          (cam.motionClearedAt > cam.lastMotionAt || now - cam.firstVideoAt >= 3000);

      if (eufyEndedEventCleanly) {
        cam.motionUntil = 0;
        stop(cam, 'eufy/camera ended event livestream', false, 'eufy/camera-event-end');
        arbitrate();
        return;
      }

      // Eufy/HomeBase ends P2P sessions after a few minutes or on camera sleep; restart if it should still be live.
      if (cam.active && now < want(cam)) {
        const remainingSecs = Math.round((want(cam) - now) / 1000);
        log.warn(
            cam,
            'stream interrupted by eufy/camera (initiator=eufy/camera, reason="livestream stopped event while session active", live=' +
            liveSecs +
            's, gotVideo=' +
            cam.gotVideo +
            ', lastVideoAgo=' +
            lastVideoAgo +
            ', remainingHold=' +
            remainingSecs +
            's) - re-requesting livestream'
        );
        void startLivestream(cam);
      } else if (cam.active) {
        stop(cam, 'eufy livestream stopped as hold/view timer expired', false, 'eufy/camera');
      } else {
        log.debug(cam, 'eufy confirmed livestream stopped (initiator=bridge/eufy)');
      }
      return;
    }

    case 'property changed':
      if (
          [
            'battery',
            'batteryLevel',
            'chargingStatus',
            'batteryIsCharging',
            'powerSource',
            'wifiSignalLevel',
            'wifiRssi',
            'cellularSignalLevel',
            'cellularRSSI',
            'batteryTemperature',
            'temperature',
            'videoStreamingQuality',
            'rtspStream',
            'rtspStreamUrl',
          ].includes(e.name)
      ) {
        applyDeviceProperties(cam, {[e.name]: e.value}, false);
      }
      return;

    default:
      if (TRIGGERS.has(String(e.event || '').toLowerCase())) {
        // Track when Eufy reports that motion/person activity has ended for early-sleep battery conservation.
        if (e.state === false) {
          const now = Date.now();
          cam.motionClearedAt = now;
          if (LET_EUFY_DECIDE_END && cam.active && inMotion(cam) && cam.gotVideo) {
            const minEnd = Math.max(now + 5000, (cam.firstVideoAt || now) + 10000);
            if (cam.motionUntil > minEnd) {
              cam.motionUntil = minEnd;
              log.info(
                  cam,
                  'eufy reported activity cleared (event="' +
                  e.event +
                  '"), ending stream in ' +
                  Math.round((minEnd - now) / 1000) +
                  's'
              );
              return;
            }
          }
          log.debug(cam, 'eufy reported activity cleared (event="' + e.event + '")');
          return;
        }
        // Ignore cached state sync events during the first 5s after start_listening connects.
        if (e.state === true && Date.now() - wsReadyAt > 5000) {
          cam.motionClearedAt = 0;
          cam.isStartupProbe = false;
          cam.needsStartupSnapshot = false;
          const holdDuration = isLowBattery(cam) ? Math.min(HOLD_MS, LOW_BAT_HOLD_MS) : HOLD_MS;
          const personName = extractRecognizedPerson(e);
          const triggerDesc = personName ? e.event + ' (' + personName + ')' : e.event;
          const evPrio = getEventPriority(e.event);
          if (BACKFILL_DOWNLOADS && !isRtspCapable(cam)) {
            cam.pendingBackfill = {
              at: Date.now(),
              event: e.event,
              personName,
              reason: triggerDesc,
              priority: cam.priority + evPrio,
              attempts: 0,
            };
          }
          trigger(cam, triggerDesc, holdDuration, 'motion', 'eufy-event', evPrio);
          if (cam.active && cam.activeMode !== 'download') {
            frigateEvent(cam, e.event, personName);
          }
        }
      }
  }
}

/**
 * Sends an optional webhook POST notification to Home Assistant when an event starts and once
 * the corresponding Frigate event has been created. Includes recognized person name if present.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} extra - Additional JSON fields to include in the webhook body.
 */
function notifyHA(cam, extra) {
  if (!cfg.ha_webhook) return;
  const payload = {
    camera: cam.name,
    title: cam.title || cam.name,
    label: cam.evLabel,
    ...extra,
  };
  if (cam.evPerson) {
    payload.person = cam.evPerson;
  }
  fetch(cfg.ha_webhook, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify(payload),
  })
      .then((r) => {
        if (!r.ok) log.warn(cam, 'HA webhook failed (HTTP ' + r.status + ')');
      })
      .catch((err) => log.warn(cam, 'HA webhook failed: ' + err.message));
}

/**
 * Files an external detection event in Frigate via its HTTP API and notifies Home Assistant.
 * Waits until live decoded video has been flowing for SNAP_DELAY_MS before creating the Frigate
 * event so Frigate captures a live video frame rather than the waking card.
 * Allows companion Eufy events (e.g., 'person detected' or 'identity person detected' arriving
 * after 'motion detected') to upgrade the label and recognized person name while waiting for video.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} ev - Eufy event name that triggered the detection.
 * @param {string} [personName=''] - Optional recognized face name from HomeBase 3.
 */
function frigateEvent(cam, ev, personName = '') {
  if (!cfg.frigate_api) return;
  const matched = LABELS.find(([k]) => ev.includes(k));
  const label = matched ? matched[1] : ev.startsWith('test') ? 'test' : 'motion';

  // Upgrade "motion" to a specific label (person/car/dog) or attach face name while an event is pending.
  if (cam.evTimer || cam.evPending) {
    if (cam.evLabel === 'motion' && label !== 'motion') {
      log.debug(cam, 'upgraded pending Frigate event label ("motion" -> "' + label + '")');
      cam.evLabel = label;
    }
    if (personName && !cam.evPerson) {
      log.debug(cam, 'attached recognized person "' + personName + '" to pending Frigate event');
      cam.evPerson = personName;
    }
    return;
  }
  if (Date.now() < (cam.evUntil || 0)) return;

  cam.evLabel = label;
  cam.evPerson = personName || '';
  cam.evPending = true;
  cam.evTimer = setTimeout(async () => {
    cam.evTimer = null;
    notifyHA(cam, {});

    const requiredDelayMs =
        cam.activeMode === 'download'
            ? 0
            : cam.activeMode === 'rtsp' && INSTANT_EVENT_SNAPSHOT
                ? Math.min(SNAP_DELAY_MS, 1200)
                : SNAP_DELAY_MS;
    const showing = () =>
        (cam.active &&
            cam.frame &&
            Date.now() - cam.frameAt < 1500 &&
            Date.now() - cam.firstFrameAt >= requiredDelayMs) ||
        (INSTANT_EVENT_SNAPSHOT && !cam.active && cam.gotVideo && Date.now() - cam.lastVideoAt < 5000);

    const maxWaitLoops = Math.max(125, Math.ceil((SNAP_DELAY_MS + 15000) / 200));
    for (let i = 0; i < maxWaitLoops && cam.evLabel !== 'test' && !showing(); i++) {
      await sleep(200);
    }

    const noVideo = cam.evLabel !== 'test' && !showing();
    if (noVideo && INSTANT_EVENT_SNAPSHOT && Buffer.isBuffer(cam.lastFrame)) {
      cam.suppressLiveCard = true;
      cam.burstUntil = Date.now() + 1500;
      pushFrameToEncoder(cam, Date.now());
      await sleep(450);
    }
    const finalLabel = cam.evLabel;
    const finalPerson = cam.evPerson;
    const subLabel = finalPerson || 'eufy';
    cam.evPending = false;
    cam.evUntil = Date.now() + EVENT_SECS * 1000;

    try {
      const createUrl = cfg.frigate_api + '/api/events/' + cam.name + '/' + finalLabel + '/create';
      const r = await fetch(createUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          source_type: 'api',
          sub_label: subLabel,
          duration: EVENT_SECS,
          include_recording: true,
        }),
      });
      if (!r.ok) {
        const errBody = (await r.text()).slice(0, 200);
        log.error(cam, 'Frigate event "' + finalLabel + '" failed (HTTP ' + r.status + ' ' + errBody + ')');
        return;
      }
      const resJson = await r.json();
      const eventId = resJson.event_id;
      const personSuffix = finalPerson ? ' [person: ' + finalPerson + ']' : '';
      if (noVideo) {
        log.warn(
            cam,
            'Frigate event "' +
            finalLabel +
            '" created' +
            personSuffix +
            ' (camera sent no live video, snapshot is a placeholder)'
        );
      } else {
        log.info(cam, 'Frigate event "' + finalLabel + '" created' + personSuffix + ' (eventId=' + eventId + ')');
      }

      await sleep(1500);
      let reviewId = '';
      try {
        const reviewUrl = cfg.frigate_api + '/api/review?cameras=' + cam.name + '&limit=5';
        const rvRes = await fetch(reviewUrl, {signal: AbortSignal.timeout(5000)});
        const rv = rvRes.ok ? await rvRes.json() : null;
        if (Array.isArray(rv)) {
          const found = rv.find(
              (x) => x.data && Array.isArray(x.data.detections) && x.data.detections.includes(eventId)
          );
          reviewId = found && found.id ? found.id : '';
        }
      } catch (err) {
        // Fallback to general review page if lookup fails.
      }
      notifyHA(cam, {event_id: eventId, review_id: reviewId, no_video: noVideo});
    } catch (err) {
      log.error(cam, 'Frigate event failed: ' + err.message);
    } finally {
      if (cam.suppressLiveCard) {
        cam.suppressLiveCard = false;
        pushFrameToEncoder(cam, Date.now());
      }
    }
  }, 600);
}

// Test hook: "docker kill -s USR2 eufy-frigate-battery-bridge" files a "test" event on the first camera without waking it.
process.on('SIGUSR2', () => {
  log.info(cams[0], 'received SIGUSR2 signal, triggering synthetic test event');
  frigateEvent(cams[0], 'test detected');
});

// Test hook: "docker kill -s USR1 eufy-frigate-battery-bridge" triggers a backfill download of the latest HomeBase clip.
process.on('SIGUSR1', () => {
  const targetCam = cams.find((c) => !c.useRtsp || !c.rtspUrl) || cams[cams.length - 1];
  if (!targetCam) return;
  log.info(targetCam, 'received SIGUSR1 signal, queueing test backfill download of latest HomeBase clip');
  for (const c of cams) {
    if (usesP2pSlot(c) && !inMotion(c)) {
      stop(c, 'yielding P2P slot for SIGUSR1 backfill test', true, 'bridge-backfill');
    } else if (!c.active && !isRtspCapable(c)) {
      clearViewerQueue(c, 'SIGUSR1 backfill test');
    }
  }
  targetCam.downloadedPaths.clear();
  targetCam.backfillClip = null;
  targetCam.lastBackfillQueryAt = 0;
  targetCam.pendingBackfill = {
    at: Date.now() - 10000,
    ignoreTimeWindow: true,
    event: 'motion detected',
    personName: '',
    reason: 'SIGUSR1 backfill test',
    priority: 9999,
    attempts: 0,
  };
  setTimeout(() => void processBackfillQueue(Date.now()), 300);
});

/**
 * Checks whether Frigate currently has any active non-synthetic object detections in progress
 * for a camera, used to decide whether early sleep can safely put a motion-woken camera to sleep.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {Promise<boolean>} True if Frigate has no active tracked object detections on this camera.
 */
async function isFrigateCameraIdle(cam) {
  if (!cfg.frigate_api) return true;
  try {
    const url = cfg.frigate_api + '/api/events?cameras=' + cam.name + '&in_progress=1&limit=10';
    const r = await fetch(url, {signal: AbortSignal.timeout(2500)});
    if (!r.ok) return false;
    const events = await r.json();
    if (!Array.isArray(events)) return false;
    const activeTracked = events.some(
        (ev) => ev.sub_label !== 'eufy' && (!cam.evPerson || ev.sub_label !== cam.evPerson)
    );
    return !activeTracked;
  } catch (err) {
    return false;
  }
}

/**
 * Evaluates whether an active motion-woken camera can go to sleep early to conserve battery.
 * Triggers once the camera has streamed at least EARLY_SLEEP_MS of live video, no viewer is watching,
 * and EARLY_SLEEP_MS has elapsed since the last motion trigger (or since Eufy reported motion cleared).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function evaluateEarlySleep(cam, now) {
  if (EARLY_SLEEP_MS <= 0 || !cam.active || !inMotion(cam) || now < cam.viewUntil) return;
  if (!cam.gotVideo || now - cam.firstVideoAt < EARLY_SLEEP_MS) return;
  if (now - cam.lastEarlySleepCheckAt < 5000) return;

  const clearedByEufy = cam.motionClearedAt > cam.lastMotionAt && now - cam.motionClearedAt >= 5000;
  const elapsedQuiet = now - cam.lastMotionAt >= EARLY_SLEEP_MS;
  if (!clearedByEufy && !elapsedQuiet) return;

  cam.lastEarlySleepCheckAt = now;
  const frigateIdle = await isFrigateCameraIdle(cam);
  if (!cam.active || !inMotion(cam) || now < cam.viewUntil) return;

  if (frigateIdle && Date.now() - cam.lastMotionAt >= Math.min(EARLY_SLEEP_MS, 10000)) {
    const quietSecs = Math.round((Date.now() - cam.lastMotionAt) / 1000);
    const initiator = clearedByEufy
        ? 'bridge-early-sleep/eufy-cleared'
        : 'bridge-early-sleep/quiet-timeout';
    cam.motionUntil = Date.now();
    stop(
        cam,
        'motion cleared early (battery saver, quietFor=' + quietSecs + 's, frigateIdle=true)',
        false,
        initiator
    );
    arbitrate();
  }
}

/**
 * Extends a camera's wake timer for either a motion event or an active live viewer and runs
 * stream arbitration across all cameras.
 * When a viewer triggers a camera (kind === 'view'), any pending viewer timers on other
 * cameras are immediately cleared so an earlier slow-starting camera never stays in the queue.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} reason - Description of what triggered the wake request.
 * @param {number} ms - Duration in milliseconds to hold the camera awake.
 * @param {'motion'|'view'} kind - Type of wake trigger.
 * @param {string} [initiator=''] - Who initiated the wake trigger ('eufy-event', 'viewer', 'bridge-probe').
 */
function trigger(cam, reason, ms, kind, initiator = '', evPriority = 10) {
  const now = Date.now();
  if (!wsReady) return;
  const resolvedInitiator = initiator || (kind === 'motion' ? 'eufy-event' : 'viewer');
  if (now >= want(cam)) {
    cam.reason = reason;
    cam.wakeInitiator = resolvedInitiator;
  }
  if (kind === 'motion') {
    if (!inMotion(cam) && !cam.active) {
      cam.reason = reason;
      cam.wakeInitiator = resolvedInitiator;
      cam.eventPriority = evPriority;
    } else if (evPriority >= (cam.eventPriority || 0)) {
      cam.eventPriority = evPriority;
      cam.reason = reason;
    }
    const prevMotionAt = cam.lastMotionAt || 0;
    const prevPriority = cam.eventPriority || 0;
    cam.eventActive = true;
    cam.motionUntil = Math.max(cam.motionUntil, now + ms);
    cam.lastMotionAt = now;
    if (cam.active) {
      const holdSecs = Math.round((cam.motionUntil - now) / 1000);
      const ecoNote = isLowBattery(cam) ? ', low-battery eco hold ' + Math.round(ms / 1000) + 's' : '';
      const logFn = now - prevMotionAt < 2000 && evPriority <= prevPriority ? log.debug : log.info;
      logFn(
          cam,
          'activity trigger "' +
          reason +
          '" (initiator=' +
          resolvedInitiator +
          ', already live, holdExtendedTo=' +
          holdSecs +
          's, priority=' +
          getEffectivePriority(cam) +
          ecoNote +
          ')'
      );
    }
  } else {
    // Only purge viewer queues on other P2P-only cameras sharing the same station P2P slot.
    if (!isRtspCapable(cam) && now >= cam.viewUntil) {
      for (const other of cams) {
        if (
            other !== cam &&
            !isRtspCapable(other) &&
            getStationKey(other) === getStationKey(cam) &&
            (other.viewUntil > 0 || [...other.viewerIds.values()].some(Boolean))
        ) {
          clearViewerQueue(other, 'superseded by P2P viewer on ' + cam.name);
        }
      }
    }
    if (now >= cam.viewUntil) cam.viewSince = now;
    cam.viewUntil = Math.max(cam.viewUntil, now + ms);
  }
  arbitrate();
}

/**
 * Arbitrates which camera gets the single HomeBase P2P livestream slot.
 * Event-triggered (motion/person/ring) streams ALWAYS take priority over viewer streams.
 * If let_eufy_decide_event_end is enabled, active un-cleared event streams that are still
 * receiving video are extended rather than cut off abruptly at hold_secs.
 */
function arbitrate() {
  const now = Date.now();

  // 1. Check active RTSP cameras independently of the P2P slot.
  for (const rCam of cams.filter((c) => c.active && c.activeMode === 'rtsp')) {
    if (now >= want(rCam)) {
      stop(rCam, 'RTSP hold/view timer expired', false, 'bridge-timer');
    }
  }

  // 2. Wake any wanting cameras that have HomeBase RTSP enabled immediately (no P2P slot needed).
  for (const rCam of cams.filter((c) => !c.active && now < want(c) && isRtspCapable(c))) {
    rCam.active = true;
    rCam.activeMode = 'rtsp';
    rCam.eventActive = inMotion(rCam);
    rCam.pendingBackfill = null;
    rCam.sessionId++;
    rCam.p2pReady = true;
    rCam.startedAt = now;
    rCam.lastStartAt = now;
    rCam.gotVideo = false;
    rCam.restarts = 0;
    rCam.lastVideoAt = 0;
    rCam.burstUntil = now + 1500;
    pushFrameToEncoder(rCam, now);
    log.info(
        rCam,
        'WAKE [RTSP] (initiator=' +
        (rCam.wakeInitiator || 'bridge') +
        ', reason="' +
        rCam.reason +
        '", priority=' +
        getEffectivePriority(rCam) +
        ', session=' +
        rCam.sessionId +
        ')'
    );
    void startRtspStream(rCam);
  }

  // 3. Arbitrate P2P slots independently per stationSerial (HomeBase vs standalone cameras).
  const stationKeys = new Set(cams.filter((c) => !isRtspCapable(c)).map((c) => getStationKey(c)));
  for (const stationKey of stationKeys) {
    const stationCams = cams.filter((c) => !isRtspCapable(c) && getStationKey(c) === stationKey);
    let cur = stationCams.find((c) => usesP2pSlot(c));

    if (cur && cur.activeMode !== 'download' && now >= want(cur)) {
      stop(cur, 'hold/view timer expired, no more activity or viewers', false, 'bridge-timer');
      cur = null;
    }

    const wanting = stationCams.filter((c) => !c.active && now < want(c));
    if (!wanting.length || !wsReady) continue;

    const pick = wanting.sort(
        (a, b) =>
            Number(inMotion(b)) - Number(inMotion(a)) ||
            (inMotion(a)
                ? getEffectivePriority(b) - getEffectivePriority(a) || b.lastMotionAt - a.lastMotionAt
                : b.viewSince - a.viewSince)
    )[0];

    if (cur && cur.activeMode === 'download') {
      if (cur.isTestBackfill && !inMotion(pick)) {
        continue;
      }
      stop(
          cur,
          'backfill download preempted by live request on ' + pick.name + ' (' + pick.reason + ')',
          !inMotion(pick),
          'bridge-arbitrator/live-over-download'
      );
      cur = null;
    }

    if (cur) {
      const pickScore = getEffectivePriority(pick);
      const curScore = getEffectivePriority(cur);
      const curFinishedOrStalled =
          cur.motionClearedAt > cur.lastMotionAt || (!cur.gotVideo && now - cur.startedAt >= 8000);

      let ok = false;
      if (inMotion(pick)) {
        if (!inMotion(cur)) {
          ok = true;
        } else if (pickScore > curScore) {
          ok = true;
        } else if (pickScore === curScore && pick.lastMotionAt > cur.lastMotionAt) {
          ok = PREEMPT_EVENT_STREAMS || curFinishedOrStalled;
        } else if (pickScore < curScore && curFinishedOrStalled) {
          ok = true;
        }
      } else {
        ok = !inMotion(cur) && pick.viewSince > cur.viewSince;
      }

      if (!ok) {
        for (const c of wanting) {
          if (!inMotion(c)) {
            clearViewerQueue(c, 'blocked by active stream on ' + cur.name);
          } else if (!PREEMPT_EVENT_STREAMS && c.lastMotionAt > cur.lastMotionAt) {
            c.motionUntil = 0;
            c.eventPriority = 0;
          }
          pushFrameToEncoder(c, now);
        }
        continue;
      }
      const preemptInitiator = inMotion(pick)
          ? !inMotion(cur)
              ? 'bridge-arbitrator/motion-over-viewer'
              : pickScore > curScore
                  ? 'bridge-arbitrator/higher-priority-event'
                  : 'bridge-arbitrator/newer-motion'
          : 'bridge-arbitrator/newer-viewer';
      stop(
          cur,
          'preempted by ' + pick.name + ' (' + pick.reason + ', priority=' + pickScore + ' vs ' + curScore + ')',
          !inMotion(pick),
          preemptInitiator
      );
    }

    for (const c of wanting) {
      if (c !== pick && !inMotion(c)) {
        clearViewerQueue(c, 'not selected by arbitrator, ' + pick.name + ' won station slot');
      }
    }

    pick.active = true;
    pick.activeMode = 'p2p';
    pick.eventActive = inMotion(pick);
    pick.sessionId++;
    pick.p2pReady = false;
    pick.startedAt = now;
    pick.gotVideo = false;
    pick.restarts = 0;
    pick.lastVideoAt = 0;
    pick.burstUntil = now + 1500;
    pushFrameToEncoder(pick, now);
    const ecoTag = isLowBattery(pick) ? ' [low-battery economy mode]' : '';
    log.info(
        pick,
        'WAKE (initiator=' +
        (pick.wakeInitiator || 'bridge') +
        ', reason="' +
        pick.reason +
        '", station=' +
        stationKey +
        ', priority=' +
        getEffectivePriority(pick) +
        ', session=' +
        pick.sessionId +
        ')' +
        ecoTag
    );
    if (pick.eventActive) {
      frigateEvent(pick, pick.reason, pick.pendingBackfill ? pick.pendingBackfill.personName : '');
    }
    void startLivestream(pick);
  }
}

/**
 * Starts a HomeBase RTSP pull stream for a camera and requests device.start_rtsp_livestream.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
async function startRtspStream(cam) {
  if (!cam.active || cam.activeMode !== 'rtsp' || !cam.rtspUrl) return;
  const mySession = cam.sessionId;
  cam.lastStartAt = Date.now();
  if (cam.rtspUrl && !cam.dec) {
    startRtspDecoder(cam, cam.rtspUrl);
  }
  if (cam.eventActive) {
    frigateEvent(cam, cam.reason, '');
  }
  // On HomeBase 3 battery cameras (T8160/T8161), setting rtspStream=true triggers CMD_NAS_TEST,
  // which physically wakes the camera RTSP stream on the HomeBase.
  await call({
    command: 'device.set_property',
    serialNumber: cam.serial,
    name: 'rtspStream',
    value: true,
  });
  if (!cam.active || cam.sessionId !== mySession || cam.activeMode !== 'rtsp') return;
  const r = await call({command: 'device.start_rtsp_livestream', serialNumber: cam.serial});
  if (!r.success && r.errorCode && !/already_running/i.test(r.errorCode)) {
    log.debug(
        cam,
        'device.start_rtsp_livestream returned ' +
        r.errorCode +
        ' (relying on rtspStream property wake)'
    );
  }
  if (cam.active && cam.sessionId === mySession && cam.activeMode === 'rtsp' && cam.rtspUrl && !cam.dec) {
    startRtspDecoder(cam, cam.rtspUrl);
  }
}

/**
 * Handles station database query results ("database query local" / "database query latest")
 * to locate and download missed event clips from the HomeBase internal storage.
 *
 * @param {Record<string, *>} e - Station event payload from eufy-security-ws.
 */
function handleDatabaseQueryResult(e) {
  const rows = Array.isArray(e.data) ? e.data : [];
  log.info(
      'bridge',
      'received HomeBase (' +
      (e.serialNumber || 'station') +
      ') event "' +
      e.event +
      '" (returnCode=' +
      (e.returnCode ?? 'n/a') +
      ', records=' +
      rows.length +
      ')'
  );
  if (!rows.length) return;

  const candidates = [];
  for (const item of rows) {
    const rec =
        item && typeof item === 'object'
            ? item.record && typeof item.record === 'object'
                ? item.record
                : item
            : null;
    if (!rec) continue;

    const devSn = rec.device_sn || rec.deviceSN || rec.deviceSerial || rec.serialNumber || '';
    if (!devSn) continue;

    let storagePath = rec.storage_path || rec.storagePath || rec.local_path || rec.localPath || '';
    const cropPath = rec.crop_local_path || rec.cropLocalPath || rec.thumb_path || '';
    if (!storagePath && cropPath) {
      const m = /^(.*\/(\d{14}))\/[^/]+$/.exec(String(cropPath));
      if (m) {
        storagePath = m[1] + '/' + m[2] + '.zxvideo';
      }
    }
    if (!storagePath) continue;

    const cipherId = Number(rec.cipher_id ?? rec.cipherId ?? 0);
    const startStr = rec.start_time || rec.startTime || rec.create_time || rec.createTime || '';
    let clipMs = startStr ? new Date(startStr).getTime() : 0;
    if (!clipMs || Number.isNaN(clipMs)) {
      const tm = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(storagePath);
      if (tm) {
        clipMs = new Date(
            Number(tm[1]),
            Number(tm[2]) - 1,
            Number(tm[3]),
            Number(tm[4]),
            Number(tm[5]),
            Number(tm[6])
        ).getTime();
      } else {
        clipMs = 0;
      }
    }
    candidates.push({devSn, storagePath, cipherId, clipMs});
  }

  // Sort newest clips first so multi-day responses always match the most recent recording.
  candidates.sort((a, b) => b.clipMs - a.clipMs);

  let matchedAny = false;
  for (const cand of candidates) {
    const cam = bySerial.get(cand.devSn);
    if (!cam || !cam.pendingBackfill || cam.backfillClip) continue;
    if (cam.downloadedPaths.has(cand.storagePath)) continue;

    if (
        !cam.pendingBackfill.ignoreTimeWindow &&
        cand.clipMs &&
        (cand.clipMs < cam.pendingBackfill.at - 45000 || cand.clipMs > cam.pendingBackfill.at + 180000)
    ) {
      continue;
    }

    cam.backfillClip = {
      storagePath: cand.storagePath,
      cipherId: cand.cipherId,
      event: cam.pendingBackfill.event,
      personName: cam.pendingBackfill.personName,
      reason: cam.pendingBackfill.reason,
    };
    matchedAny = true;
    log.info(
        cam,
        'matched recorded HomeBase clip for backfill (path="' +
        cand.storagePath +
        '", cipherId=' +
        cand.cipherId +
        ', reason="' +
        cam.pendingBackfill.reason +
        '")'
    );
  }

  if (matchedAny) {
    void processBackfillQueue(Date.now());
  }
}

/**
 * Queries the HomeBase local database and starts downloading a missed event clip when the P2P slot is idle.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
async function processBackfillQueue(now) {
  if (!BACKFILL_DOWNLOADS || !wsReady || shuttingDown) return;
  if (cams.some((c) => usesP2pSlot(c) || (!c.active && !isRtspCapable(c) && now < want(c)))) {
    return;
  }
  const hasUrgentTest = cams.some((c) => c.pendingBackfill && c.pendingBackfill.ignoreTimeWindow);
  const lastP2pActivity = Math.max(0, ...cams.map((c) => c.sleptAt || 0));
  if (!hasUrgentTest && now - lastP2pActivity < BACKFILL_DELAY_MS) return;

  // Expire stale backfill requests older than 5 minutes.
  for (const c of cams) {
    if (c.pendingBackfill && now - c.pendingBackfill.at > 300000) {
      log.debug(c, 'expired unfulfilled backfill request (' + c.pendingBackfill.reason + ')');
      c.pendingBackfill = null;
      c.backfillClip = null;
    }
  }

  // 1. If a camera already has a matched clip, start downloading it immediately.
  const readyCam = cams
      .filter((c) => c.backfillClip && !c.active)
      .sort((a, b) => (b.pendingBackfill?.priority || 0) - (a.pendingBackfill?.priority || 0))[0];

  if (readyCam) {
    const clip = readyCam.backfillClip;
    const isTest = Boolean(readyCam.pendingBackfill && readyCam.pendingBackfill.ignoreTimeWindow);
    readyCam.backfillClip = null;
    readyCam.pendingBackfill = null;
    readyCam.downloadedPaths.add(clip.storagePath);

    readyCam.active = true;
    readyCam.activeMode = 'download';
    readyCam.isTestBackfill = isTest;
    readyCam.downloadFinished = false;
    readyCam.downloadFrames = [];
    readyCam.eventActive = false;
    readyCam.reason = 'backfill: ' + clip.reason;
    readyCam.wakeInitiator = 'bridge-backfill';
    readyCam.sessionId++;
    readyCam.p2pReady = true;
    readyCam.startedAt = now;
    readyCam.lastStartAt = now;
    readyCam.gotVideo = false;
    readyCam.restarts = 0;
    readyCam.lastVideoAt = 0;
    readyCam.burstUntil = now + 1500;
    pushFrameToEncoder(readyCam, now);

    log.info(
        readyCam,
        'WAKE [BACKFILL DOWNLOAD] (initiator=bridge-backfill, reason="' +
        clip.reason +
        '", path="' +
        clip.storagePath +
        '", session=' +
        readyCam.sessionId +
        ')'
    );
    frigateEvent(readyCam, clip.event || 'motion detected', clip.personName || '');

    const res = await call({
      command: 'device.start_download',
      serialNumber: readyCam.serial,
      path: clip.storagePath,
      cipherId: clip.cipherId,
    });
    if (!res.success) {
      log.warn(
          readyCam,
          'device.start_download failed (errorCode=' + (res.errorCode || 'unknown') + ')'
      );
      stop(readyCam, 'start_download RPC failed', false, 'error/download-failed');
    }
    return;
  }

  // 2. Otherwise, query the HomeBase database for the highest-priority camera waiting for backfill.
  const queryCam = cams
      .filter(
          (c) =>
              c.pendingBackfill &&
              !c.backfillClip &&
              now - c.pendingBackfill.at >= 8000 &&
              now - c.lastBackfillQueryAt >= 12000
      )
      .sort((a, b) => b.pendingBackfill.priority - a.pendingBackfill.priority)[0];

  if (!queryCam) return;
  queryCam.lastBackfillQueryAt = now;
  if (++queryCam.pendingBackfill.attempts > 4) {
    log.debug(
        queryCam,
        'giving up on backfill query after 4 attempts (' + queryCam.pendingBackfill.reason + ')'
    );
    queryCam.pendingBackfill = null;
    return;
  }

  const stationSn =
      queryCam.stationSerial ||
      cams.find((c) => c.stationSerial && c.stationSerial.startsWith('T8030'))?.stationSerial ||
      cams.find((c) => c.stationSerial)?.stationSerial ||
      '';
  if (!stationSn) {
    log.warn(queryCam, 'cannot query backfill clip: stationSerial not yet known');
    return;
  }

  const dStart = new Date(now - 86400000);
  const dEnd = new Date(now + 86400000);
  const fmtYmd = (d) =>
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');

  log.info(
      queryCam,
      'querying HomeBase (' +
      stationSn +
      ') local database for missed event clip (attempt=' +
      queryCam.pendingBackfill.attempts +
      '/4, reason="' +
      queryCam.pendingBackfill.reason +
      '")'
  );
  await call({command: 'station.connect', serialNumber: stationSn});
  await call({
    command: 'station.database_query_latest_info',
    serialNumber: stationSn,
  });
  await call({
    command: 'station.database_query_by_date',
    serialNumber: stationSn,
    serialNumbers: [queryCam.serial],
    startDate: fmtYmd(dStart),
    endDate: fmtYmd(dEnd),
  });
}

/**
 * Sends device.start_livestream to eufy-security-ws for the specified camera.
 * Awaits p2pTransitionPromise first so any previous camera's stop_livestream has completed
 * and the HomeBase P2P buffer has settled before starting the new camera stream.
 * Marks cam.p2pReady = true immediately before sending device.start_livestream so the very
 * first keyframe packet from the camera is accepted without waiting for the RPC response.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
async function startLivestream(cam) {
  if (cam.starting || !cam.active) return;
  cam.starting = true;
  const mySession = cam.sessionId;

  const runStart = async () => {
    try {
      await getStationTransition(cam);
      if (!cam.active || cam.sessionId !== mySession) {
        log.debug(
            cam,
            'aborted start_livestream before RPC call (initiator=bridge, reason=session_canceled_or_preempted, session=' +
            mySession +
            ')'
        );
        return;
      }

      cam.p2pReady = true;
      cam.lastStartAt = Date.now();
      let r = await call({command: 'device.start_livestream', serialNumber: cam.serial});

      // If this camera was preempted while start_livestream was waiting for the camera to wake,
      // stop the newly woken stream immediately so it does not stay live on the HomeBase.
      if (!cam.active || cam.sessionId !== mySession) {
        if (r.success) {
          log.info(
              cam,
              'stopping newly woken stream because session ' +
              mySession +
              ' was preempted/closed during wake (initiator=bridge)'
          );
          await call({command: 'device.stop_livestream', serialNumber: cam.serial});
        }
        return;
      }

      if (!r.success && /already_running/.test(r.errorCode || '')) {
        log.warn(
            cam,
            'eufy-security-ws reports stale livestream (errorCode=' +
            r.errorCode +
            '), forcing stop and restart (initiator=bridge/eufy-ws, session=' +
            mySession +
            ')'
        );
        cam.p2pReady = false;
        await call({command: 'device.stop_livestream', serialNumber: cam.serial});
        await sleep(1000);
        if (!cam.active || cam.sessionId !== mySession) return;
        cam.p2pReady = true;
        cam.lastStartAt = Date.now();
        r = await call({command: 'device.start_livestream', serialNumber: cam.serial});
        if (!cam.active || cam.sessionId !== mySession) {
          if (r.success) {
            log.info(
                cam,
                'stopping restarted stream because session ' +
                mySession +
                ' was preempted/closed during retry (initiator=bridge)'
            );
            await call({command: 'device.stop_livestream', serialNumber: cam.serial});
          }
          return;
        }
      }

      if (!r.success) {
        log.error(
            cam,
            'start_livestream failed (initiator=eufy-ws, errorCode=' +
            (r.errorCode || 'unknown') +
            ', session=' +
            mySession +
            ')'
        );
        if (cam.active && cam.sessionId === mySession) {
          cam.lastStartAt = Date.now() - 5000;
        }
      }
    } finally {
      if (cam.sessionId === mySession) {
        cam.starting = false;
      }
    }
  };

  cam.startPromise = runStart();
  return cam.startPromise;
}

/**
 * Stops an active camera's P2P livestream, waits for any in-flight startPromise on that camera
 * before sending device.stop_livestream via p2pTransitionPromise, clears its viewer queue,
 * tears down the decoder, and refreshes the sleeping card with the camera's own last frame.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} why - Reason the camera is going to sleep.
 * @param {boolean} [preemptedByViewer=false] - True if stopped because the user opened another camera.
 * @param {string} [initiator='bridge'] - Decision maker ('bridge-timer', 'eufy/camera', 'bridge-arbitrator/...', 'error/...', etc.).
 */
function stop(cam, why, preemptedByViewer = false, initiator = 'bridge') {
  if (!cam.active) return;
  const now = Date.now();
  const inFlightStart = cam.startPromise;
  const hadVideo = cam.gotVideo;
  const liveSecs = Math.round((now - cam.startedAt) / 1000);
  const lastVideoAgo = cam.lastVideoAt ? ((now - cam.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
  const restartsCount = cam.restarts;
  const closedSession = cam.sessionId;
  const closedMode = cam.activeMode || 'p2p';

  if (Buffer.isBuffer(cam.frame) && cam.frame.length === FRAME) {
    cam.lastFrame = Buffer.from(cam.frame);
  }
  cam.active = false;
  cam.activeMode = '';
  cam.isTestBackfill = false;
  cam.downloadFinished = false;
  cam.downloadFrames = [];
  cam.starting = false;
  cam.startPromise = null;
  cam.eventActive = false;
  cam.motionUntil = 0;
  cam.eventPriority = 0;
  cam.p2pReady = false;
  cam.isStartupProbe = false;
  cam.motionClearedAt = 0;
  cam.sessionId++;
  cam.lastStoppedAt = now;
  cam.rtspFallbackUntil = 0;
  if (hadVideo && !preemptedByViewer && closedMode !== 'download') {
    cam.sleptAt = now;
  }
  cam.burstUntil = now + 1500;
  clearViewerQueue(cam);

  const sleepMsg =
      'SLEEP (initiator=' +
      initiator +
      ', reason="' +
      why +
      '", live=' +
      liveSecs +
      's, gotVideo=' +
      hadVideo +
      ', lastVideoAgo=' +
      lastVideoAgo +
      ', restarts=' +
      restartsCount +
      ', session=' +
      closedSession +
      ')';

  if (initiator.startsWith('error/')) {
    log.error(cam, sleepMsg);
  } else if (initiator === 'bridge-max-limit') {
    log.warn(cam, sleepMsg);
  } else {
    log.info(cam, sleepMsg);
  }

  stopDecoder(cam);

  // Wait for any in-flight start_livestream call to settle before sending stop_livestream,
  // then pause 400ms so the HomeBase P2P channel flushes cleanly before the next camera starts.
  setStationTransition(
      cam,
      getStationTransition(cam)
          .then(async () => {
        if (inFlightStart) {
          try {
            await inFlightStart;
          } catch (err) {
            // Ignore errors from canceled start promise.
          }
        }
        if (closedMode === 'rtsp') {
          // Do not call device.stop_rtsp_livestream, as it disables the NAS/RTSP stream on the HomeBase.
          await sleep(50);
        } else if (closedMode === 'download') {
          await call({command: 'device.cancel_download', serialNumber: cam.serial});
          await sleep(150);
        } else {
          const res = await call({command: 'device.stop_livestream', serialNumber: cam.serial});
          if (!res.success && res.errorCode && !/ws_closed|not_running/i.test(res.errorCode)) {
            log.debug(cam, 'device.stop_livestream returned errorCode=' + res.errorCode);
          }
          await sleep(150);
        }
          })
          .catch(() => {
          })
  );

  if (cam.lastFrame) {
    saveCachedFrame(cam);
  }
  renderCameraCards(cam);
  pushFrameToEncoder(cam);

  call({command: 'device.get_properties', serialNumber: cam.serial}).then((res) => {
    if (res.success && res.result && res.result.properties) {
      applyDeviceProperties(cam, res.result.properties, false);
    }
  });
}

/**
 * Spawns the persistent FFmpeg encoder process for a camera.
 * Reads raw YUV420p video frames from stdin (pipe:0) and s16le PCM audio from fd 3 (pipe:3),
 * publishing a continuous H.264 + AAC RTSP stream to go2rtc.
 * Supports optional hardware acceleration ('vaapi', 'qsv', 'nvenc', 'v4l2m2m') and automatically
 * falls back to software libx264 if hardware initialization fails.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function startEncoder(cam) {
  if (shuttingDown || cam.enc) return;

  const hwMode = cam.useHwaccel ? ACTIVE_HWACCEL : '';
  const gop = String(Math.max(4, LIVE_FPS));
  const args = ['-hide_banner', '-loglevel', 'warning'];

  if (hwMode === 'vaapi') {
    args.push('-init_hw_device', 'vaapi=va:' + HWACCEL_DEVICE, '-filter_hw_device', 'va');
  } else if (hwMode === 'qsv') {
    args.push('-init_hw_device', 'qsv=hw:' + HWACCEL_DEVICE, '-filter_hw_device', 'hw');
  }

  args.push(
      '-use_wallclock_as_timestamps',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-s',
      W + 'x' + H,
      '-i',
      'pipe:0'
  );

  if (AUDIO) {
    args.push(
        '-use_wallclock_as_timestamps',
        '1',
        '-f',
        's16le',
        '-ar',
        String(RATE),
        '-ac',
        '1',
        '-i',
        'pipe:3',
        '-map',
        '0:v',
        '-map',
        '1:a'
    );
  }

  args.push('-fps_mode', 'passthrough');

  if (hwMode === 'vaapi') {
    args.push(
        '-vf',
        'format=nv12,hwupload',
        '-c:v',
        'h264_vaapi',
        '-bf',
        '0',
        '-qp',
        '18',
        '-g',
        gop
    );
  } else if (hwMode === 'qsv') {
    args.push(
        '-vf',
        'format=nv12,hwupload=extra_hw_frames=64',
        '-c:v',
        'h264_qsv',
        '-global_quality',
        '19',
        '-maxrate',
        '3500k',
        '-bufsize',
        '5000k',
        '-g',
        gop
    );
  } else if (hwMode === 'nvenc') {
    args.push(
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p3',
        '-tune',
        'ull',
        '-pix_fmt',
        'yuv420p',
        '-cq',
        '19',
        '-maxrate',
        '3500k',
        '-bufsize',
        '5000k',
        '-g',
        gop
    );
  } else if (hwMode === 'v4l2m2m') {
    args.push('-c:v', 'h264_v4l2m2m', '-pix_fmt', 'yuv420p', '-b:v', '3000k', '-g', gop);
  } else {
    args.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '19',
        '-maxrate',
        '3500k',
        '-bufsize',
        '5000k',
        '-g',
        gop
    );
  }

  if (AUDIO) {
    args.push('-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '32k');
  }
  args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', cfg.rtsp_publish.replace('{name}', cam.name));

  const spawnAt = Date.now();
  const enc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'ignore', 'pipe', AUDIO ? 'pipe' : 'ignore'],
  });
  cam.enc = enc;
  cam.lastSent = null;
  cam.lastWrite = Date.now();
  cam.burstUntil = Date.now() + 1500;

  enc.on('error', (e) => log.error(cam, 'encoder process error: ' + e.message));
  enc.stdin.on('error', () => {
  });
  enc.stdin.on('drain', () => {
    if (cam.frameNew) pushFrameToEncoder(cam);
  });
  if (AUDIO && enc.stdio[3]) enc.stdio[3].on('error', () => {
  });

  let tail = '';
  enc.stderr.on('data', (d) => {
    tail = (tail + d).slice(-500);
  });
  enc.on('exit', (code) => {
    if (cam.enc === enc) cam.enc = null;
    if (shuttingDown) return;
    const errSummary = tail.trim().split('\n').join(' | ');

    // If hardware encoding failed immediately (e.g. driver/device error, not RTSP EOF), fall back to libx264.
    if (
        hwMode &&
        Date.now() - spawnAt < 5000 &&
        /vaapi|qsv|nvenc|v4l2|hwupload|device|driver|Invalid argument|Function not implemented/i.test(tail)
    ) {
      cam.useHwaccel = false;
      log.warn(
          cam,
          'hwaccel (' +
          hwMode +
          ') encoder failed (' +
          errSummary +
          '), falling back to software libx264'
      );
      setTimeout(() => {
        if (!cam.enc && !shuttingDown) startEncoder(cam);
      }, 1000);
      return;
    }

    log.error(cam, 'encoder exited (code=' + code + ') ' + errSummary + ' - restarting in 3 s');
    if (Date.now() - spawnAt > 10000) {
      frigateApiDown = true;
      setTimeout(() => {
        if (!shuttingDown) void syncFrigateMotionMasks(true);
      }, 6000);
    }
    setTimeout(() => {
      if (!cam.enc && !shuttingDown) startEncoder(cam);
    }, 3000);
  });

  const codecLabel = hwMode ? 'h264_' + hwMode : 'libx264';
  log.info(cam, 'encoder (' + codecLabel + ') publishing to go2rtc');
}

/**
 * Spawns a low-latency per-session FFmpeg decoder for an active camera livestream.
 * Uses nobuffer, low_delay, and a 32 KB probesize so the first keyframe is decoded and
 * pushed to Frigate immediately without waiting in avformat_find_stream_info.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} codec - Video codec name reported by eufy-security-ws ('H264' or 'H265').
 */
function startDecoder(cam, codec) {
  const mySession = cam.sessionId;
  const vfmt = /265|hevc/i.test(codec) ? 'hevc' : 'h264';
  const scaleFilter = cam.preserveAspect
      ? 'scale=' +
      W +
      ':' +
      H +
      ':flags=lanczos:force_original_aspect_ratio=decrease,pad=' +
      W +
      ':' +
      H +
      ':(ow-iw)/2:(oh-ih)/2:color=0x1c1c1c'
      : 'scale=' + W + ':' + H + ':flags=lanczos';

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts+nobuffer',
    '-flags',
    'low_delay',
    '-use_wallclock_as_timestamps',
    '1',
    '-probesize',
    '32768',
    '-analyzeduration',
    '0',
    '-f',
    vfmt,
    '-i',
    'pipe:0',
  ];
  if (AUDIO) {
    args.push(
        '-use_wallclock_as_timestamps',
        '1',
        '-probesize',
        '8192',
        '-analyzeduration',
        '0',
        '-f',
        'aac',
        '-i',
        'pipe:3'
    );
  }
  args.push(
      '-map',
      '0:v',
      '-vf',
      scaleFilter,
      '-pix_fmt',
      'yuv420p',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      'pipe:1'
  );
  if (AUDIO) {
    args.push('-map', '1:a', '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:4');
  }

  const dec = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe', AUDIO ? 'pipe' : 'ignore', AUDIO ? 'pipe' : 'ignore'],
  });
  cam.dec = dec;
  log.debug(cam, 'started FFmpeg decoder (codec=' + vfmt + ', session=' + mySession + ')');

  dec.on('error', (e) => log.error(cam, 'decoder process error: ' + e.message));
  dec.stdin.on('error', () => {
  });
  if (AUDIO && dec.stdio[3]) dec.stdio[3].on('error', () => {
  });

  let buf = Buffer.allocUnsafe(FRAME);
  let fill = 0;
  dec.stdout.on('data', (d) => {
    let off = 0;
    while (off < d.length) {
      const n = Math.min(FRAME - fill, d.length - off);
      d.copy(buf, fill, off, off + n);
      fill += n;
      off += n;
      if (fill === FRAME) {
        if (cam.active && cam.dec === dec && cam.sessionId === mySession) {
          const now = Date.now();
          if (!cam.firstFrameAt) cam.firstFrameAt = now;
          const frameCopy = Buffer.from(buf);
          if (cam.activeMode === 'download') {
            if (!cam.frame) {
              cam.frame = frameCopy;
              cam.frameAt = now;
              cam.frameNew = true;
              cam.lastFrame = frameCopy;
              cam.lastSeen = formatLocalHm(new Date(now));
              pushFrameToEncoder(cam, now);
            } else if (cam.downloadFrames.length < LIVE_FPS * 60) {
              cam.downloadFrames.push(frameCopy);
            }
            buf = Buffer.allocUnsafe(FRAME);
            fill = 0;
            continue;
          }
          cam.frame = buf;
          cam.frameAt = now;
          cam.frameNew = true;
          cam.lastFrame = frameCopy;
          cam.needsStartupSnapshot = false;
          if (
              cam.pendingBackfill &&
              !cam.pendingBackfill.ignoreTimeWindow &&
              cam.activeMode !== 'download' &&
              now - cam.firstFrameAt >= 5000
          ) {
            cam.pendingBackfill = null;
            cam.backfillClip = null;
          }
          cam.lastSeen = formatLocalHm(new Date(now));
          pushFrameToEncoder(cam, now);

          // For startup snapshot probes, allow 2s of video for auto-exposure to settle before stopping.
          if (now - cam.firstFrameAt >= 2000 && cam.isStartupProbe) {
            cam.isStartupProbe = false;
            const hasHumanViewer = [...cam.viewerIds.values()].some(Boolean);
            if (!inMotion(cam) && !hasHumanViewer) {
              stop(
                  cam,
                  'startup snapshot captured after 2s stable video',
                  false,
                  'bridge-startup-probe'
              );
              return;
            }
          }
        }
        buf = Buffer.allocUnsafe(FRAME);
        fill = 0;
      }
    }
  });

  if (AUDIO && dec.stdio[4]) {
    dec.stdio[4].on('data', (d) => {
      if (!cam.active || cam.dec !== dec || cam.sessionId !== mySession) return;
      cam.pcm.push(d);
      cam.pcmLen += d.length;
      while (cam.pcmLen > RATE * 2 && cam.pcm.length > 1) {
        const dropped = cam.pcm.shift();
        if (dropped) cam.pcmLen -= dropped.length;
      }
    });
  }

  let tail = '';
  dec.stderr.on('data', (d) => {
    tail = (tail + d).slice(-400);
  });
  dec.on('exit', (code) => {
    if (cam.dec === dec) {
      cam.dec = null;
      if (cam.active && cam.sessionId === mySession) {
        const lastLine = tail.trim().split('\n').pop() || 'no stderr output';
        log.warn(
            cam,
            'decoder exited while stream active (initiator=ffmpeg-decoder, code=' +
            code +
            ', session=' +
            mySession +
            '): ' +
            lastLine
        );
      }
    }
  });
}

/**
 * Spawns a low-latency FFmpeg RTSP client decoder that pulls directly from a camera's HomeBase
 * RTSP URL without using the shared P2P livestream slot.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} rtspUrl - HomeBase RTSP stream URL.
 */
function startRtspDecoder(cam, rtspUrl) {
  const mySession = cam.sessionId;
  const scaleFilter = cam.preserveAspect
      ? 'scale=' +
      W +
      ':' +
      H +
      ':flags=lanczos:force_original_aspect_ratio=decrease,pad=' +
      W +
      ':' +
      H +
      ':(ow-iw)/2:(oh-ih)/2:color=0x1c1c1c'
      : 'scale=' + W + ':' + H + ':flags=lanczos';

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts+nobuffer',
    '-flags',
    'low_delay',
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-map',
    '0:v:0',
    '-vf',
    scaleFilter,
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
  if (AUDIO) {
    args.push('-map', '0:a:0?', '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:4');
  }

  const dec = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', AUDIO ? 'pipe' : 'ignore'],
  });
  cam.dec = dec;
  log.debug(cam, 'started FFmpeg RTSP pull decoder (session=' + mySession + ')');

  dec.on('error', (e) => log.error(cam, 'RTSP decoder process error: ' + e.message));

  let buf = Buffer.allocUnsafe(FRAME);
  let fill = 0;
  dec.stdout.on('data', (d) => {
    let off = 0;
    while (off < d.length) {
      const n = Math.min(FRAME - fill, d.length - off);
      d.copy(buf, fill, off, off + n);
      fill += n;
      off += n;
      if (fill === FRAME) {
        if (cam.active && cam.dec === dec && cam.sessionId === mySession) {
          const now = Date.now();
          cam.lastVideoAt = now;
          if (!cam.gotVideo) {
            cam.gotVideo = true;
            cam.firstVideoAt = now;
            const delaySec = ((now - cam.startedAt) / 1000).toFixed(1);
            log.info(cam, 'first RTSP video ' + delaySec + ' s after wake (session=' + mySession + ')');
          }
          if (!cam.firstFrameAt) cam.firstFrameAt = now;
          cam.frame = buf;
          cam.frameAt = now;
          cam.frameNew = true;
          cam.lastFrame = Buffer.from(buf);
          cam.needsStartupSnapshot = false;
          cam.lastSeen = formatLocalHm(new Date(now));
          pushFrameToEncoder(cam, now);
        }
        buf = Buffer.allocUnsafe(FRAME);
        fill = 0;
      }
    }
  });

  if (AUDIO && dec.stdio[4]) {
    dec.stdio[4].on('data', (d) => {
      if (!cam.active || cam.dec !== dec || cam.sessionId !== mySession) return;
      cam.pcm.push(d);
      cam.pcmLen += d.length;
      while (cam.pcmLen > RATE * 2 && cam.pcm.length > 1) {
        const dropped = cam.pcm.shift();
        if (dropped) cam.pcmLen -= dropped.length;
      }
    });
  }

  let tail = '';
  dec.stderr.on('data', (d) => {
    tail = (tail + d).slice(-400);
  });
  dec.on('exit', (code) => {
    if (cam.dec === dec) {
      cam.dec = null;
      if (cam.active && cam.sessionId === mySession && cam.activeMode === 'rtsp') {
        const lastLine = tail.trim().split('\n').pop() || 'no stderr output';
        log.debug(
            cam,
            'RTSP decoder exited while camera waking/streaming (code=' +
            code +
            ', session=' +
            mySession +
            '): ' +
            lastLine +
            ' - retrying in 750ms'
        );
        setTimeout(() => {
          if (
              cam.active &&
              cam.sessionId === mySession &&
              cam.activeMode === 'rtsp' &&
              !cam.dec &&
              cam.rtspUrl
          ) {
            startRtspDecoder(cam, cam.rtspUrl);
          }
        }, 750);
      }
    }
  });
}

/**
 * Stops a camera's active FFmpeg decoder process and clears its temporary A/V buffers.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function stopDecoder(cam) {
  const dec = cam.dec;
  cam.dec = null;
  cam.frame = null;
  cam.firstFrameAt = 0;
  cam.frameNew = false;
  cam.videoWidth = 0;
  cam.videoHeight = 0;
  cam.videoCodec = '';
  cam.pcm = [];
  cam.pcmLen = 0;
  if (!dec) return;
  try {
    dec.stdin.end();
  } catch (err) {
    // Ignore errors when closing decoder stdin.
  }
  setTimeout(() => {
    try {
      dec.kill('SIGKILL');
    } catch (err) {
      // Ignore errors if decoder already exited.
    }
  }, 2000);
}

/**
 * Converts a serialized Buffer payload from eufy-security-ws into a Node.js Buffer.
 *
 * @param {Record<string, *>} e - Event object containing buffer.
 * @returns {Uint8Array}
 */
const bytes = (e) => Buffer.from((e.buffer && e.buffer.data) ?? e.buffer ?? []);

/**
 * Inspects an Annex-B video packet to determine whether it contains codec parameter sets
 * (HEVC VPS=32 / SPS=33, or H.264 SPS=7) required for FFmpeg to initialize a decoder cleanly.
 *
 * @param {Uint8Array} buf - Raw video packet buffer.
 * @param {string} codec - Video codec string ('H264' or 'H265').
 * @returns {boolean} True if the packet starts with a keyframe parameter set.
 */
function isKeyPacket(buf, codec) {
  const isHevc = /265|hevc/i.test(codec);
  const limit = Math.min(buf.length - 4, 128);
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    const idx = buf[i + 2] === 1 ? i + 3 : buf[i + 2] === 0 && buf[i + 3] === 1 ? i + 4 : -1;
    if (idx < 0 || idx >= buf.length) continue;
    const t = isHevc ? (buf[idx] >> 1) & 0x3f : buf[idx] & 0x1f;
    if (isHevc ? t === 32 || t === 33 : t === 7) return true;
    i = idx;
  }
  return false;
}

/**
 * Handles an incoming raw video packet from eufy-security-ws.
 * Accepts packets as soon as the camera's P2P transition is ready, restarts the decoder
 * if the video codec changes, and begins decoding on the first keyframe.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} e - Livestream video data event.
 */
function onVideo(cam, e) {
  if (!cam.active || !cam.p2pReady) return;

  const meta = e.metadata || {};
  const codec = meta.videoCodec || 'H265';
  const width = Number(meta.videoWidth) || 0;
  const height = Number(meta.videoHeight) || 0;

  // Only reset the decoder if the video codec itself changes; FFmpeg's scale filter handles
  // Eufy's dynamic P2P resolution shifts (e.g. 3840x2160 <-> 2304x1296) seamlessly in-band.
  if (cam.dec && cam.videoCodec && codec !== cam.videoCodec) {
    log.info(
        cam,
        'stream codec changed (' +
        cam.videoCodec +
        ' -> ' +
        codec +
        '), resetting decoder (initiator=camera-stream)'
    );
    stopDecoder(cam);
  } else if (
      cam.dec &&
      ((width && cam.videoWidth && width !== cam.videoWidth) ||
          (height && cam.videoHeight && height !== cam.videoHeight))
  ) {
    log.debug(
        cam,
        'stream resolution changed in-band (' +
        cam.videoWidth +
        'x' +
        cam.videoHeight +
        ' -> ' +
        width +
        'x' +
        height +
        ')'
    );
    cam.videoWidth = width;
    cam.videoHeight = height;
  }

  cam.lastVideoAt = Date.now();
  const buf = bytes(e);
  if (!cam.dec) {
    if (!isKeyPacket(buf, codec)) return;
    cam.videoCodec = codec;
    cam.videoWidth = width;
    cam.videoHeight = height;
    startDecoder(cam, codec);
  }
  if (cam.dec && cam.dec.stdin && cam.dec.stdin.writable) {
    cam.dec.stdin.write(buf);
  }
  if (!cam.gotVideo) {
    cam.gotVideo = true;
    cam.firstVideoAt = Date.now();
    const delaySec = ((Date.now() - cam.startedAt) / 1000).toFixed(1);
    log.info(
        cam,
        'first video (' +
        codec +
        ' ' +
        width +
        'x' +
        height +
        ') ' +
        delaySec +
        ' s after wake (session=' +
        cam.sessionId +
        ')'
    );
  }
}

/**
 * Handles an incoming raw AAC audio packet from eufy-security-ws and forwards it to the active decoder.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} e - Livestream audio data event.
 */
function onAudio(cam, e) {
  if (cam.active && cam.p2pReady && cam.dec && AUDIO && cam.dec.stdio[3] && cam.dec.stdio[3].writable) {
    cam.dec.stdio[3].write(bytes(e));
  }
}

// Feed video frames to each camera's persistent encoder at LIVE_FPS when live/bursting or IDLE_FPS when idle.
setInterval(() => {
  const now = Date.now();
  for (const cam of cams) {
    pushFrameToEncoder(cam, now);
  }
}, Math.round(1000 / LIVE_FPS));

// Feed steady 100 ms chunks of PCM audio (or silence when idle) to each camera's encoder.
if (AUDIO) {
  setInterval(() => {
    for (const cam of cams) {
      const enc = cam.enc;
      if (!enc || !enc.stdio[3] || !enc.stdio[3].writable || enc.stdio[3].writableNeedDrain) continue;
      let out = SILENCE;
      if (cam.pcmLen >= AUDIO_CHUNK) {
        const all = cam.pcm.length === 1 ? cam.pcm[0] : Buffer.concat(cam.pcm);
        out = all.subarray(0, AUDIO_CHUNK);
        const rest = all.subarray(AUDIO_CHUNK);
        cam.pcm = rest.length ? [rest] : [];
        cam.pcmLen = rest.length;
      }
      enc.stdio[3].write(out);
    }
  }, AUDIO_TICK);
}

/**
 * Polls go2rtc for active stream consumers on each camera every 750ms.
 * Ignores Frigate's own FFmpeg processes and internal go2rtc probes regardless of IPv4/IPv6/Docker address.
 * Respects Low-Battery Economy Mode and triggers an immediate 1s keyframe burst whenever a new
 * viewer connects so Frigate's MSE/WebRTC player renders the current frame without delay.
 */
let isPollingViewers = false;

async function pollViewers() {
  if (isPollingViewers || shuttingDown) return;
  isPollingViewers = true;
  try {
    const findStationMotionCam = (cam) => cams.find((c) => inMotion(c) && !isRtspCapable(c) && getStationKey(c) === getStationKey(cam));
    const newConnections = [];

    let anyPollOk = false;
    let allPollsFailed = true;
    for (const cam of cams) {
      try {
        const r = await fetch(cfg.go2rtc_api + '/api/streams?src=' + cam.name, {
          signal: AbortSignal.timeout(2500),
        });
        if (!r.ok) continue;
        allPollsFailed = false;
        anyPollOk = true;
        const d = await r.json();
        const viewers = (d.consumers || []).filter(
            (c) => !/FFmpeg Frigate|^go2rtc/i.test(c.user_agent || '')
        );
        const now = Date.now();
        const seen = new Set();

        for (const v of viewers) {
          seen.add(v.id);
          if (cam.viewerIds.has(v.id)) continue;

          const clientInfo = (v.format_name || v.protocol || '') + ' ' + (v.remote_addr || '');
          cam.viewerIds.set(v.id, false);
          cam.burstUntil = Math.max(cam.burstUntil || 0, now + 1200);
          pushFrameToEncoder(cam, now);
          newConnections.push({cam, id: v.id, clientInfo: clientInfo.trim(), now});
        }

        for (const [id, wasActiveViewer] of [...cam.viewerIds.entries()]) {
          if (!seen.has(id)) {
            cam.viewerIds.delete(id);
            log.debug(
                cam,
                'viewer disconnected (id=' +
                id +
                ', wasWakingViewer=' +
                wasActiveViewer +
                ', remainingViewers=' +
                viewers.length +
                ')'
            );
          }
        }
        cam.viewers = viewers.length;
      } catch (err) {
        // Ignore transient errors while go2rtc/Frigate is restarting.
      }
    }
    if (allPollsFailed) {
      frigateApiDown = true;
    } else if (anyPollOk && frigateApiDown) {
      frigateApiDown = false;
      log.info('bridge', 'Frigate API recovered after restart/outage, re-verifying motion & object masks');
      setTimeout(() => {
        if (!shuttingDown) void syncFrigateMotionMasks(true);
      }, 3000);
    }

    // Only classify as a multi-camera dashboard grid if 2+ sleeping cameras got new viewers AND 2+ cameras have active viewers.
    const activeViewerCams = cams.filter((c) => c.viewers > 0);
    const distinctSleepingNewCams = new Set(
        newConnections.filter((x) => !x.cam.active).map((x) => x.cam)
    );
    const isDashboardGrid = distinctSleepingNewCams.size > 1 && activeViewerCams.length > 1;
    let newestViewerCam = null;

    for (const conn of newConnections) {
      const {cam, id, clientInfo, now} = conn;
      const blockedByEco = isLowBattery(cam) && !LOW_BAT_WAKE_ON_VIEW;
      const activeP2pMotionCam = findStationMotionCam(cam);
      const blockedByP2pMotion = !isRtspCapable(cam) && Boolean(activeP2pMotionCam);
      const alreadyViewing = cam.active && (now < cam.viewUntil || cam.activeMode === 'download');
      const asked =
          !isDashboardGrid &&
          (!cam.active || alreadyViewing) &&
          !blockedByP2pMotion &&
          !blockedByEco &&
          (alreadyViewing || now - cam.sleptAt >= COOLDOWN_MS);

      cam.viewerIds.set(id, asked);
      if (asked) {
        newestViewerCam = cam;
      }
      if (!isDashboardGrid && blockedByEco && now - cam.lastLowBatRefreshAt > 30000) {
        cam.lastLowBatRefreshAt = now;
        log.info(cam, 'viewer connected while in low-battery mode, polling HomeBase for battery swap');
        void fetchAllCameraTelemetry(true);
      }

      const actionDesc = asked
          ? cam.active
              ? 'extending active live view'
              : 'waking the camera'
          : cam.active
              ? 'joined while live, does not extend it'
              : isDashboardGrid
                  ? 'ignored, multi-camera dashboard grid view'
                  : blockedByP2pMotion
                      ? 'ignored, ' + activeP2pMotionCam.name + ' is active with P2P motion/event'
                      : blockedByEco
                          ? 'ignored, camera is in low-battery economy mode (' + cam.battery + '%)'
                          : 'ignored, camera just went to sleep (cooldown)';

      log.info(cam, 'viewer connected (' + clientInfo + ') - ' + actionDesc);
    }

    if (newestViewerCam) {
      newestViewerCam.isStartupProbe = false;
      newestViewerCam.needsStartupSnapshot = false;
      if (!isRtspCapable(newestViewerCam)) {
        for (const other of cams) {
          if (other !== newestViewerCam && !isRtspCapable(other) && getStationKey(other) === getStationKey(newestViewerCam)) {
            clearViewerQueue(other, 'viewer switched to ' + newestViewerCam.name);
            if (other.active && !inMotion(other)) {
              stop(
                  other,
                  'preempted by live view opened on ' + newestViewerCam.name,
                  true,
                  'viewer-preempt'
              );
            }
          }
        }
      }
    }
    for (const cam of cams) {
      if ([...cam.viewerIds.values()].some(Boolean)) {
        cam.isStartupProbe = false;
        trigger(cam, 'live view opened', LINGER_MS, 'view', 'viewer');
      }
    }
  } finally {
    isPollingViewers = false;
  }
}

setInterval(() => {
  void pollViewers();
}, 750);

// Periodic housekeeping: run stream arbitration, schedule initial startup snapshot probes one by one,
// enforce max duration limits, check early sleep, and retry stalled streams.
setInterval(() => {
  const now = Date.now();
  arbitrate();
  void processBackfillQueue(now);
  if (wsReady && now - lastMaskCheckAt >= 60000) {
    lastMaskCheckAt = now;
    void syncFrigateMotionMasks(false);
  }

  if (wsReady && initialTelemetryLoaded && now - wsReadyAt > 6000) {
    const nextProbeCam = cams.find(
        (c) =>
            c.needsStartupSnapshot &&
            !isLowBattery(c) &&
            !cams.some((o) => getStationKey(o) === getStationKey(c) && (o.active || now < want(o)))
    );
    if (nextProbeCam) {
      nextProbeCam.needsStartupSnapshot = false;
      nextProbeCam.isStartupProbe = true;
      trigger(nextProbeCam, 'startup snapshot probe', 25000, 'view', 'bridge-probe');
    }
  }

  for (const cam of cams) {
    if (!cam.active) continue;
    if (now - cam.startedAt >= MAX_MS) {
      cam.motionUntil = 0;
      stop(
          cam,
          'reached max_secs limit (' + Math.round(MAX_MS / 60000) + 'm)',
          false,
          'bridge-max-limit'
      );
      continue;
    }
    if (!inMotion(cam) && now - Math.max(cam.startedAt, cam.motionUntil) >= VIEW_MAX_MS) {
      stop(
          cam,
          'reached view_max_secs limit (' + Math.round(VIEW_MAX_MS / 60000) + 'm)',
          false,
          'bridge-view-limit'
      );
      continue;
    }
    void evaluateEarlySleep(cam, now);
    const quietSince = Math.max(cam.lastVideoAt, cam.lastStartAt);
    if (cam.activeMode === 'rtsp') {
      if (!cam.gotVideo && now - quietSince > 6500 && cam.restarts === 0) {
        cam.restarts = 1;
        cam.lastStartAt = now;
        log.info(
            cam,
            'RTSP wake still waiting for video after 6.5s, re-sending start_rtsp_livestream (session=' +
            cam.sessionId +
            ')'
        );
        stopDecoder(cam);
        void startRtspStream(cam);
      } else if (!cam.gotVideo && now - cam.startedAt > 14000) {
        log.warn(
            cam,
            'HomeBase RTSP stream yielded no video after 14s, queueing P2P fallback for 60s (session=' +
            cam.sessionId +
            ')'
        );
        stopDecoder(cam);
        cam.rtspFallbackUntil = now + 60000;
        cam.active = false;
        cam.activeMode = '';
        arbitrate();
      } else if (cam.gotVideo && now - cam.lastVideoAt > 8000) {
        log.warn(
            cam,
            'RTSP stream stalled mid-session (quietFor=' +
            ((now - cam.lastVideoAt) / 1000).toFixed(1) +
            's), restarting RTSP decoder (session=' +
            cam.sessionId +
            ')'
        );
        cam.lastVideoAt = now;
        stopDecoder(cam);
        void startRtspStream(cam);
      }
      continue;
    }
    if (cam.activeMode === 'download') {
      if (cam.downloadFrames.length > 0) {
        continue;
      }
      if (cam.gotVideo && (cam.downloadFinished || now - cam.lastVideoAt > 3000)) {
        stop(cam, 'post-event clip download stream completed', false, 'eufy/download-finished');
        arbitrate();
      } else if (!cam.gotVideo && now - quietSince > 10000) {
        log.warn(cam, 'post-event clip download timed out with no video after 10s');
        stop(cam, 'post-event clip download timed out', false, 'error/download-timeout');
        arbitrate();
      }
      continue;
    }
    const retryAfterMs = cam.restarts === 0 ? 5500 : 8000;
    if (now - quietSince > retryAfterMs && !cam.starting) {
      const quietSecs = ((now - quietSince) / 1000).toFixed(1);
      const stallCause = cam.gotVideo ? 'stream_stalled_mid_session' : 'no_initial_video_after_wake';
      if (++cam.restarts > 3) {
        cam.motionUntil = 0;
        stop(
            cam,
            'camera stopped sending video after 3 retries (cause=' +
            stallCause +
            ', quietFor=' +
            quietSecs +
            's)',
            false,
            'error/watchdog-timeout'
        );
        continue;
      }
      log.warn(
          cam,
          'stream stalled (initiator=bridge-watchdog, cause=' +
          stallCause +
          ', quietFor=' +
          quietSecs +
          's, gotVideo=' +
          cam.gotVideo +
          ', retry=' +
          cam.restarts +
          '/3) - resetting decoder and re-requesting livestream from eufy'
      );
      stopDecoder(cam);
      if (cam.activeMode === 'rtsp') {
        void startRtspStream(cam);
      } else {
        void startLivestream(cam);
      }
    }
  }
}, 500);

// Periodically poll camera telemetry so battery swaps and charging updates are detected while sleeping.
if (TELEMETRY_POLL_MS > 0) {
  setInterval(() => {
    if (wsReady && !shuttingDown) {
      void fetchAllCameraTelemetry(false);
    }
  }, TELEMETRY_POLL_MS);
}

/**
 * Gracefully stops all active camera livestreams and terminates FFmpeg encoder processes on shutdown.
 */
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('bridge', 'received shutdown signal, stopping active streams and encoders');
  for (const c of cams) {
    c.motionUntil = 0;
    stop(c, 'bridge container shutting down', false, 'system-shutdown');
    try {
      if (c.enc) c.enc.kill('SIGTERM');
    } catch (err) {
      // Ignore errors when stopping encoder on shutdown.
    }
  }
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  log.error('bridge', 'uncaught exception (service continuing): ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (reason) => {
  log.error('bridge', 'unhandled promise rejection (service continuing): ' + reason);
});

const camListStr = cams.map((c) => c.name).join(', ');
const hwDesc = ACTIVE_HWACCEL ? ACTIVE_HWACCEL + ' (' + HWACCEL_DEVICE + ')' : 'software (libx264)';
const startMsg =
    'eufy-frigate-battery-bridge starting: cameras=[' +
    camListStr +
    '], logLevel=' +
    ACTIVE_LOG_LEVEL_NAME +
    ', cache=' +
    CACHE_DIR +
    ', encoder=' +
    hwDesc +
    ', useRtsp=' +
    GLOBAL_USE_RTSP +
    ', backfill=' +
    BACKFILL_DOWNLOADS +
    ', autoMask=' +
    GLOBAL_AUTO_FRIGATE_MASK +
    ', cardOnLive=' +
    GLOBAL_CARD_SHOW_ON_LIVE +
    ', letEufyDecideEnd=' +
    LET_EUFY_DECIDE_END +
    ', dimBg=' +
    GLOBAL_DIM_BACKGROUND +
    ', hold=' +
    HOLD_MS / 1000 +
    's, earlySleep=' +
    EARLY_SLEEP_MS / 1000 +
    's, viewerLinger=' +
    LINGER_MS / 1000 +
    's, max=' +
    MAX_MS / 1000 +
    's';
log.info('bridge', startMsg);

for (const c of cams) startEncoder(c);
connectWs();
setTimeout(() => void syncFrigateMotionMasks(), 2500);
