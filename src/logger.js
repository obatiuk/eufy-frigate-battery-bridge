// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Structured logging and ICU-free local timestamp formatting for Grafana Alloy / Loki.
 */
'use strict';

const LOG_LEVELS = {debug: 0, info: 1, warn: 2, warning: 2, error: 3};
let currentLogLevel = LOG_LEVELS.info;
let activeLogLevelName = 'info';

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
 * Formats and writes a structured log line to stdout when `level` meets or exceeds currentLogLevel.
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
  if (weight < currentLogLevel) return;
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

/**
 * Initializes the active log severity level from LOG_LEVEL or config.json.
 *
 * @param {string|undefined} rawLevel - Configured log level string.
 * @returns {string} Normalized active log level name.
 */
function initLogger(rawLevel) {
  const cleaned = String(rawLevel || 'info')
      .toLowerCase()
      .trim();
  currentLogLevel = LOG_LEVELS[cleaned] ?? LOG_LEVELS.info;
  activeLogLevelName =
      Object.keys(LOG_LEVELS).find((k) => k !== 'warning' && LOG_LEVELS[k] === currentLogLevel) || 'info';
  if (!(cleaned in LOG_LEVELS)) {
    log.warn('bridge', 'unknown LOG_LEVEL "' + cleaned + '", defaulting to "info"');
  }
  return activeLogLevelName;
}

/**
 * Returns the currently active normalized log level name.
 *
 * @returns {string}
 */
function getActiveLogLevelName() {
  return activeLogLevelName;
}

module.exports = {
  LOG_LEVELS,
  formatLocalTimestamp,
  formatLocalHm,
  writeLog,
  log,
  initLogger,
  getActiveLogLevelName,
};
