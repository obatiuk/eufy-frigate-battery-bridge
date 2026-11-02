// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Structured logging and ICU-free local timestamp formatting for Grafana Alloy / Loki.
 */
'use strict';

const LOG_LEVELS = Object.freeze({
  debug: 0,
  info: 1,
  warn: 2,
  warning: 2,
  error: 3,
});

let currentLogLevel = LOG_LEVELS.info;
let activeLogLevelName = 'info';

/**
 * Pads a number to 2 digits with a leading zero.
 *
 * @param {number} value - Number to pad.
 * @returns {string}
 */
function padTwoDigits(value) {
  return String(value).padStart(2, '0');
}

/**
 * Formats a Date object as 'YYYY-MM-DD HH:MM:SS' in local time without ICU locale dependencies.
 *
 * @param {Date} [date=new Date()] - Date instance to format.
 * @returns {string}
 */
function formatLocalTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = padTwoDigits(date.getMonth() + 1);
  const day = padTwoDigits(date.getDate());
  const hours = padTwoDigits(date.getHours());
  const minutes = padTwoDigits(date.getMinutes());
  const seconds = padTwoDigits(date.getSeconds());

  return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes + ':' + seconds;
}

/**
 * Formats a Date object as 'HH:MM' in local time without ICU locale dependencies.
 *
 * @param {Date} [date=new Date()] - Date instance to format.
 * @returns {string}
 */
function formatLocalHm(date = new Date()) {
  return padTwoDigits(date.getHours()) + ':' + padTwoDigits(date.getMinutes());
}

/**
 * Normalizes a log level string ('warning' -> 'warn', unknown -> 'info').
 *
 * @param {string} rawLevel - Raw severity string.
 * @returns {'debug'|'info'|'warn'|'error'}
 */
function normalizeLevelName(rawLevel) {
  switch (String(rawLevel || '').toLowerCase().trim()) {
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * Resolves the log scope label from a camera object or scope string.
 *
 * @param {string|{name?: string}|null|undefined} scope - Camera instance or scope name.
 * @returns {string}
 */
function resolveScopeName(scope) {
  if (!scope) {
    return 'bridge';
  }
  if (typeof scope === 'object') {
    return scope.name || 'bridge';
  }
  return String(scope);
}

/**
 * Formats a single structured log line for Grafana Alloy / Loki:
 *   YYYY-MM-DD HH:MM:SS [LEVEL] [camera_or_bridge] message
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Log severity level.
 * @param {string|{name?: string}|null|undefined} scope - Camera state/config object or scope string.
 * @param {Array<*>} args - Message segments.
 * @param {Date} [now=new Date()] - Timestamp to format.
 * @returns {string}
 */
function formatLogLine(level, scope, args, now = new Date()) {
  const normLevel = normalizeLevelName(level);
  const timestamp = formatLocalTimestamp(now);
  const scopeName = resolveScopeName(scope);
  return timestamp + ' [' + normLevel.toUpperCase() + '] [' + scopeName + '] ' + args.join(' ');
}

/**
 * Writes a structured log line to stdout when `level` meets or exceeds currentLogLevel.
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Log severity level.
 * @param {string|{name?: string}|null|undefined} scope - Camera state/config object or 'bridge'.
 * @param {...*} args - Message segments.
 */
function writeLog(level, scope, ...args) {
  const normLevel = normalizeLevelName(level);
  const weight = LOG_LEVELS[normLevel];
  if (weight < currentLogLevel) {
    return;
  }
  console.log(formatLogLine(normLevel, scope, args));
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
  const cleaned = String(rawLevel || 'info').toLowerCase().trim();
  const isKnown = cleaned in LOG_LEVELS;

  activeLogLevelName = normalizeLevelName(cleaned);
  currentLogLevel = LOG_LEVELS[activeLogLevelName];

  if (!isKnown) {
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
  normalizeLevelName,
  resolveScopeName,
  formatLogLine,
  writeLog,
  log,
  initLogger,
  getActiveLogLevelName,
};
