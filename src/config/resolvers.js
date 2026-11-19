// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Event priority scoring, card/sleep normalizers, mode-aware camera timer and Power Manager
 * resolvers, ignored-option startup warnings, and resolveCameraConfig.
 */
'use strict';

const {log} = require('../logger');
const {
  MS_PER_SECOND,
  CARD_THEMES,
  CARD_POSITIONS,
  CARD_POS_ALIAS_CENTER_TOP,
  CARD_POS_ALIAS_CENTER_BOTTOM,
  SLEEP_SCREENS,
  CAMERA_MODES,
  HWACCEL_MODES,
  TRIGGER_EVENT_ALIASES,
  DEFAULT_TRIGGER_EVENTS,
  MIN_CAMERA_PRIORITY,
  MAX_CAMERA_PRIORITY,
  DEFAULT_CAMERA_PRIORITY,
  DEFAULT_EVENT_PRIORITY,
  EVENT_PRIORITIES,
  MIN_LIVE_FPS,
  MAX_LIVE_FPS,
  DEFAULT_LIVE_FPS,
  MIN_IDLE_FPS,
  MAX_IDLE_FPS,
  DEFAULT_IDLE_FPS,
  DEFAULT_TRACK_STUCK_SPOTLIGHT,
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
  MIN_POWER_WORKING_MODE,
  MAX_POWER_WORKING_MODE,
  OPTIMAL_BATTERY_MAX_CLIP_SECS,
  MIN_RECORDING_CLIP_SECS,
  MAX_RECORDING_CLIP_SECS,
  MIN_RETRIGGER_INTERVAL_SECS,
  MAX_RETRIGGER_INTERVAL_SECS,
  DEFAULT_RETRIGGER_INTERVAL_SECS,
  clampNum,
} = require('./constants');
const {stripRtspUrlFragment, hasDirectRtspUrl, CameraConfig} = require('./camera-config');
const {readEnvString} = require('./env');

const ASCII_WORD_CHAR_REGEX = /[a-z0-9]/;

/** @type {Record<string, *>} */
let activeRawCfg = {};
/** @type {Record<string, *>} */
let activeBuiltCfg = {};
/** @type {Set<string>|null} */
let activeTriggers = null;

/**
 * Binds the process-wide loaded raw config, built frozen config, and default trigger set
 * once `src/config/index.js` initializes the singleton.
 *
 * @param {{
 *   rawCfg: Record<string, *>,
 *   builtCfg: Record<string, *>,
 *   triggers: Set<string>,
 * }} defaults - Active process configuration defaults.
 */
function bindActiveConfigDefaults(defaults) {
  activeRawCfg = defaults.rawCfg;
  activeBuiltCfg = defaults.builtCfg;
  activeTriggers = defaults.triggers;
}

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
      : activeBuiltCfg && typeof activeBuiltCfg.event_priorities === 'object'
        ? activeBuiltCfg.event_priorities
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
 * Resolves low_battery_threshold and critical_battery_threshold with defensive non-contradiction
 * clamping (0 < criticalBatThreshold < lowBatThreshold <= 99).
 *
 * @param {Record<string, *>} [rawCfg=activeRawCfg] - Raw configuration object (global or camera).
 * @param {{ lowFallback?: number, critFallback?: number }} [fallbacks={}] - Default fallback percentages.
 * @param {string} [scope='bridge'] - Logger scope name.
 * @returns {Readonly<{ lowBatThreshold: number, criticalBatThreshold: number }>}
 */
function resolveBatteryThresholds(rawCfg = activeRawCfg, fallbacks = {}, scope = 'bridge') {
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
 * @param {Record<string, *>} [rawCfg=activeRawCfg] - Raw configuration object.
 * @returns {{ liveFps: number, idleFps: number }}
 */
function resolveFrameRates(rawCfg = activeRawCfg) {
  const liveFps = clampNum(rawCfg.live_fps, MIN_LIVE_FPS, MAX_LIVE_FPS, DEFAULT_LIVE_FPS);
  const rawIdleFps = clampNum(rawCfg.idle_fps, MIN_IDLE_FPS, MAX_IDLE_FPS, DEFAULT_IDLE_FPS);
  if (rawIdleFps > liveFps) {
    log.warn(
      'bridge',
      'idle_fps (' + rawIdleFps + ') exceeds live_fps (' + liveFps + '), clamping idle_fps to ' + liveFps
    );
  }
  return Object.freeze({liveFps, idleFps: Math.min(liveFps, rawIdleFps)});
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
 * @param {Record<string, *>} [baseCfg=activeRawCfg] - Global configuration object.
 * @returns {Record<string, boolean>} Normalized telemetry options object.
 */
function resolveTelemetryConfig(camConfig = {}, baseCfg = activeRawCfg) {
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
 * @param {Record<string, *>} [baseCfg=activeRawCfg] - Global configuration object.
 * @returns {{
 *   theme: 'glance'|'minimal'|'pebbles'|'hud'|'none',
 *   position: 'center'|'top-left'|'top-center'|'top-right'|'bottom-left'|'bottom-center'|'bottom-right',
 *   sleepScreen: 'snapshot'|'slate'|'black'
 * }}
 */
function resolveCardConfig(camConfig = {}, baseCfg = activeRawCfg) {
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

/**
 * Resolves the normalized Set of Eufy trigger events that wake a specific camera,
 * falling back to the global TRIGGERS set when per-camera trigger_events is omitted.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {Set<string>} [globalTriggers] - Fallback global trigger set.
 * @returns {Set<string>}
 */
function resolveCameraTriggers(camConfig = {}, globalTriggers = activeTriggers || buildTriggerSet(undefined)) {
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
 * Resolves mode, RTSP transport, and backfill flags for a camera with non-contradiction warnings.
 *
 * @param {Record<string, *>} camConfig - Camera configuration entry.
 * @param {Record<string, *>} baseCfg - Global configuration object.
 * @param {string} scope - Logger scope name.
 * @returns {{
 *   mode: 'auto'|'rtsp'|'p2p'|'backfill'|'custom',
 *   isRtspDirect: boolean,
 *   alwaysBackfill: boolean,
 *   useRtsp: boolean,
 *   backfillDownloads: boolean,
 * }}
 */
function resolveModeAndBackfillFlags(camConfig, baseCfg, scope) {
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
  return {mode, isRtspDirect, alwaysBackfill, useRtsp, backfillDownloads};
}

/**
 * Resolves maxMs, viewMaxMs, lingerMs, eventSecs, and earlySleepMs with non-contradiction clamping.
 *
 * @param {Record<string, *>} camConfig - Camera configuration entry.
 * @param {Record<string, *>} baseCfg - Global configuration object.
 * @param {{holdMs: number, holdSecs: number, defaultHoldSecs: number, scope: string}} ctx - Hold context.
 * @returns {{maxMs: number, viewMaxMs: number, lingerMs: number, eventSecs: number, earlySleepMs: number}}
 */
function resolveClampedSessionDurations(camConfig, baseCfg, ctx) {
  const {holdMs, holdSecs, defaultHoldSecs, scope} = ctx;
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

  return {maxMs, viewMaxMs, lingerMs, eventSecs, earlySleepMs};
}

/**
 * Resolves per-camera stream timing and mode settings with mode-aware defaults and
 * defensive non-contradiction clamping.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {Record<string, *>} [baseCfg=activeBuiltCfg] - Global configuration object.
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
function resolveCameraTimers(camConfig = {}, baseCfg = activeBuiltCfg) {
  if (camConfig && camConfig.timers && Object.isFrozen(camConfig.timers)) {
    return camConfig.timers;
  }
  const scope = CameraConfig.resolveScopeName(camConfig);
  const {mode, isRtspDirect, alwaysBackfill, useRtsp, backfillDownloads} = resolveModeAndBackfillFlags(
    camConfig,
    baseCfg,
    scope
  );

  const defaultHoldSecs = alwaysBackfill ? DEFAULT_BACKFILL_HOLD_SECS : DEFAULT_HOLD_SECS;
  const rawHoldSecs = camConfig.hold_secs ?? baseCfg.hold_secs;
  const holdSecs =
    rawHoldSecs !== undefined ? clampNum(rawHoldSecs, MIN_HOLD_SECS, MAX_HOLD_SECS, defaultHoldSecs) : defaultHoldSecs;
  const holdMs = holdSecs * MS_PER_SECOND;

  const {maxMs, viewMaxMs, lingerMs, eventSecs, earlySleepMs} = resolveClampedSessionDurations(camConfig, baseCfg, {
    holdMs,
    holdSecs,
    defaultHoldSecs,
    scope,
  });

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
 * Resolves effective powerWorkingMode and whether custom clip settings apply, promoting mode 0/1 to 2 when conflicting.
 *
 * @param {*} rawPowerMode - Raw power_working_mode value.
 * @param {boolean} hasExplicitClipCfg - Whether explicit clip overrides were set.
 * @param {{defaultClipSecs: number, letEufyDecideEnd: boolean, scope: string}} ctx - Clip context.
 * @returns {{powerWorkingMode: number, sendCustomClips: boolean}}
 */
function resolveEffectivePowerWorkingMode(rawPowerMode, hasExplicitClipCfg, ctx) {
  const {defaultClipSecs, letEufyDecideEnd, scope} = ctx;
  let powerWorkingMode =
    rawPowerMode !== undefined && rawPowerMode !== null && !Number.isNaN(Number(rawPowerMode))
      ? clampNum(
          Math.round(Number(rawPowerMode)),
          MIN_POWER_WORKING_MODE,
          MAX_POWER_WORKING_MODE,
          MAX_POWER_WORKING_MODE
        )
      : MAX_POWER_WORKING_MODE;

  if (powerWorkingMode >= MAX_POWER_WORKING_MODE) {
    return {powerWorkingMode, sendCustomClips: true};
  }
  if (hasExplicitClipCfg) {
    log.warn(
      scope,
      'power_working_mode=' +
        powerWorkingMode +
        ' ignores custom clip settings on Eufy firmware; promoting power_working_mode to 2 (Customize Recording)'
    );
    return {powerWorkingMode: MAX_POWER_WORKING_MODE, sendCustomClips: true};
  }
  if (
    powerWorkingMode === MIN_POWER_WORKING_MODE &&
    (defaultClipSecs > OPTIMAL_BATTERY_MAX_CLIP_SECS || !letEufyDecideEnd)
  ) {
    log.warn(
      scope,
      'power_working_mode=0 (Optimal Battery Life) hardcodes 20s early-ending clips on Eufy firmware, ' +
        'which conflicts with hold_secs=' +
        defaultClipSecs +
        's / end_early=' +
        letEufyDecideEnd +
        '; promoting power_working_mode to 2 (Customize Recording)'
    );
    return {powerWorkingMode: MAX_POWER_WORKING_MODE, sendCustomClips: true};
  }
  return {powerWorkingMode, sendCustomClips: false};
}

/**
 * Resolves customized clip length, early-end, and retrigger interval properties for Power Working Mode 2.
 *
 * @param {{explicitClipLen: *, explicitEndEarly: *, explicitRetrigger: *}} explicitCfg - Explicit clip overrides.
 * @param {{defaultClipSecs: number, letEufyDecideEnd: boolean, scope: string}} ctx - Clip defaults and scope.
 * @returns {{recordingClipLength: number, recordingEndClipMotionStops: boolean, recordingRetriggerInterval: number}}
 */
function resolveCustomClipRecordingFields(explicitCfg, ctx) {
  const {explicitClipLen, explicitEndEarly, explicitRetrigger} = explicitCfg;
  const {defaultClipSecs, letEufyDecideEnd, scope} = ctx;
  const recordingEndClipMotionStops =
    explicitEndEarly !== undefined && explicitEndEarly !== null ? Boolean(explicitEndEarly) : letEufyDecideEnd;

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
  return {recordingClipLength, recordingEndClipMotionStops, recordingRetriggerInterval};
}

/**
 * Resolves per-camera Eufy hardware Power Manager settings, automatically deriving
 * clip length and early-end behavior from the camera's resolved hold_secs and end_early
 * with defensive validation against contradictory overrides.
 *
 * @param {Record<string, *>} [camConfig={}] - Individual camera configuration object from cfg.cameras.
 * @param {ReturnType<typeof resolveCameraTimers>|null} [resolvedTimers=null] - Pre-resolved camera timers.
 * @param {Record<string, *>} [baseCfg=activeBuiltCfg] - Global configuration object.
 * @returns {{
 *   enforceQuality: boolean|number|null,
 *   powerWorkingMode: number|null,
 *   recordingClipLength: number|null,
 *   recordingEndClipMotionStops: boolean|null,
 *   recordingRetriggerInterval: number|null
 * }}
 */
function resolveHardwareRecordingConfig(camConfig = {}, resolvedTimers = null, baseCfg = activeBuiltCfg) {
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

  if ((camConfig.sync_power ?? baseCfg.sync_power ?? true) === false) {
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

  const {powerWorkingMode, sendCustomClips} = resolveEffectivePowerWorkingMode(
    camConfig.power_working_mode ?? baseCfg.power_working_mode,
    hasExplicitClipCfg,
    {defaultClipSecs, letEufyDecideEnd: timers.letEufyDecideEnd, scope}
  );
  if (!sendCustomClips) {
    return Object.freeze({
      enforceQuality,
      powerWorkingMode,
      recordingClipLength: null,
      recordingEndClipMotionStops: null,
      recordingRetriggerInterval: null,
    });
  }

  const clipFields = resolveCustomClipRecordingFields(
    {explicitClipLen, explicitEndEarly, explicitRetrigger},
    {defaultClipSecs, letEufyDecideEnd: timers.letEufyDecideEnd, scope}
  );
  return Object.freeze({
    enforceQuality,
    powerWorkingMode,
    ...clipFields,
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
 * Returns true when a Power Manager camera key is explicitly set and ignored under sync_power=false.
 *
 * @param {string} key - Candidate power configuration key.
 * @param {Record<string, *>} rawCam - Raw camera configuration object.
 * @param {string} mode - Resolved camera mode.
 * @returns {boolean}
 */
function isIgnoredSyncPowerKey(key, rawCam, mode) {
  const feedsCustomEndEarly =
    key === 'recording_end_early' && mode === CAMERA_MODES.CUSTOM && rawCam.end_early === undefined;
  return rawCam[key] !== undefined && !feedsCustomEndEarly;
}

/**
 * Returns true when a card/telemetry key is explicitly set and ignored under card_theme="none".
 *
 * @param {string} key - Candidate card configuration key.
 * @param {Record<string, *>} node - Top-level or camera configuration object.
 * @param {boolean} isDirectRtsp - Whether direct rtsp_url disables telemetry independently.
 * @returns {boolean}
 */
function isIgnoredCardNoneKey(key, node, isDirectRtsp) {
  return node[key] !== undefined && !(isDirectRtsp && key === 'telemetry');
}

/**
 * Returns true when a camera entry explicitly configures a visible (non-"none") card_theme.
 *
 * @param {Record<string, *>|null|undefined} cam - Candidate camera configuration object.
 * @returns {boolean}
 */
function hasExplicitVisibleCardTheme(cam) {
  return Boolean(cam && cam.card_theme !== undefined && normalizeCardTheme(cam.card_theme) !== CARD_THEMES.NONE);
}

/**
 * Returns true when a camera entry explicitly configures sleep_screen="snapshot".
 *
 * @param {Record<string, *>|null|undefined} cam - Candidate camera configuration object.
 * @returns {boolean}
 */
function hasExplicitSnapshotSleepScreen(cam) {
  return Boolean(
    cam && cam.sleep_screen !== undefined && normalizeSleepScreen(cam.sleep_screen) === SLEEP_SCREENS.SNAPSHOT
  );
}

/**
 * Logs startup warnings when explicitly specified per-camera mode, transport, timer, or Power Manager
 * options are ignored due to direct rtsp_url, the resolved camera mode, or sync_power=false.
 *
 * @param {Record<string, *>} rawCam - Original un-normalized camera configuration object.
 * @param {{ timers: ReturnType<typeof resolveCameraTimers>, scope: string }} ctx - Resolved timers and scope.
 * @param {Record<string, *>} [baseCfg=activeRawCfg] - Global configuration object.
 */
function warnIgnoredCameraModeOptions(rawCam, {timers, scope}, baseCfg = activeRawCfg) {
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
    const ignoredPower = SYNC_POWER_IGNORED_CAMERA_KEYS.filter((key) =>
      isIgnoredSyncPowerKey(key, rawCam, timers.mode)
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
    const ignoredCard = CARD_NONE_IGNORED_KEYS.filter((key) => isIgnoredCardNoneKey(key, rawCam, timers.rtspDirect));
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
    const anyVisibleCamCard = cams.some(hasExplicitVisibleCardTheme);
    if (!anyVisibleCamCard) {
      const ignoredTopCard = CARD_NONE_IGNORED_KEYS.filter((key) => isIgnoredCardNoneKey(key, rawCfg, allDirect));
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
    const anySnapshotCam = cams.some(hasExplicitSnapshotSleepScreen);
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
 * @param {Record<string, *>} [baseCfg=activeRawCfg] - Global configuration object.
 * @returns {Readonly<CameraConfig & Record<string, *>>}
 */
function resolveCameraConfig(camConfig = {}, baseCfg = activeRawCfg) {
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

  const fallbackTriggers =
    baseCfg.triggers instanceof Set ? baseCfg.triggers : activeTriggers || buildTriggerSet(undefined);
  const timers = resolveCameraTimers(normalizedCam, baseCfg);
  const triggers = resolveCameraTriggers(normalizedCam, fallbackTriggers);
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

module.exports = {
  bindActiveConfigDefaults,
  getEventPriority,
  buildTriggerSet,
  normalizeCardPosition,
  normalizeCardTheme,
  normalizeSleepScreen,
  resolveBatteryThresholds,
  resolveFrameRates,
  resolveTelemetryConfig,
  resolveCardConfig,
  resolveCameraTriggers,
  resolveCameraMode,
  resolveCameraTimers,
  resolveHardwareRecordingConfig,
  warnIgnoredTopLevelOptions,
  resolveCameraConfig,
};
