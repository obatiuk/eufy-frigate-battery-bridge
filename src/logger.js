// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
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

const LOG_LEVEL_NAME_WIDTH = 5;
const MAX_ERROR_CAUSE_DEPTH = 4;
const MS_PER_SECOND = 1000;
const JUST_NOW_THRESHOLD_SECS = 5;
const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;
const SECS_PER_DAY = 86400;
const FILE_TIMESTAMP_REGEX = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;
const AGE_JUST_NOW = 'just now';
const AGE_SECONDS_SUFFIX = 's ago';
const AGE_MINUTES_SUFFIX = 'm ago';
const AGE_HOURS_INFIX = 'h ';
const AGE_HOURS_SUFFIX = 'h ago';
const AGE_DAYS_INFIX = 'd ';
const AGE_DAYS_SUFFIX = 'd ago';
const GENERIC_OBJECT_TO_STRING = '[object Object]';
const BARE_AGGREGATE_ERROR_LABEL = 'AggregateError';
const URL_CREDENTIALS_REGEX = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
const URL_CREDENTIALS_REPLACEMENT = '$1***@';
const LOG_CR_REGEX = /\r/g;
const LOG_LF_REGEX = /\n/g;
const FFMPEG_BOILERPLATE_LINE_REGEX = new RegExp(
  '^(?:Conversion failed!|Error opening (?:input|output) file .+\\.|' +
    '\\[out#\\d+\\/[^\\]]+\\]\\s+(?:video:\\S+\\s+audio:\\S+.*muxing overhead:|' +
    'Nothing was written into output file\\b))',
  'i'
);
const FFMPEG_PLURAL_OPEN_FILES_REGEX = /^Error opening (input|output) files:\s*(.+)$/i;
const FFMPEG_SECONDARY_IO_WRAPPER_REGEX = new RegExp(
  '^(?:\\[(?:in|out)#\\d+(?:\\/[^\\s\\]]+)?\\s*@\\s*0x[0-9a-f]+\\]\\s*Error ' +
    '(?:opening (?:input|output)|muxing a packet)\\b|' +
    '\\[(?:vost|aost|vist|aist)#[^\\]]+\\]\\s*Error ' +
    '(?:submitting a packet to the muxer|initializing output stream|decoding\\s*frames?)\\b)',
  'i'
);

/** @type {number} */
let currentLogLevel = LOG_LEVELS.info;

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
 * Formats a Date object as 'YYYY-MM-DD_HH-MM-SS' in local time for filesystem-safe snapshot filenames.
 *
 * @param {Date} [date=new Date()] - Date instance to format.
 * @returns {string}
 */
function formatFileTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = padTwoDigits(date.getMonth() + 1);
  const day = padTwoDigits(date.getDate());
  const hours = padTwoDigits(date.getHours());
  const minutes = padTwoDigits(date.getMinutes());
  const seconds = padTwoDigits(date.getSeconds());

  return year + '-' + month + '-' + day + '_' + hours + '-' + minutes + '-' + seconds;
}

/**
 * Parses a 'YYYY-MM-DD_HH-MM-SS' local timestamp string into epoch milliseconds, or returns 0 when malformed.
 *
 * @param {string} rawStamp - Candidate filename timestamp segment.
 * @returns {number}
 */
function parseFileTimestampMs(rawStamp) {
  const match = FILE_TIMESTAMP_REGEX.exec(String(rawStamp || '').trim());
  if (!match) {
    return 0;
  }
  const [, rawYear, rawMonth, rawDay, rawHour, rawMin, rawSec] = match;
  const year = Number(rawYear);
  const monthIdx = Number(rawMonth) - 1;
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMin);
  const second = Number(rawSec);
  const parsed = new Date(year, monthIdx, day, hour, minute, second, 0);
  const matchesCalendar =
    parsed.getFullYear() === year &&
    parsed.getMonth() === monthIdx &&
    parsed.getDate() === day &&
    parsed.getHours() === hour &&
    parsed.getMinutes() === minute &&
    parsed.getSeconds() === second;
  return matchesCalendar ? parsed.getTime() : 0;
}

/**
 * Formats an elapsed millisecond duration into a concise human-friendly relative age ('just now', '45s ago',
 * '12m ago', '2h 35m ago', '3d 4h ago').
 *
 * @param {number} elapsedMs - Elapsed duration in milliseconds (clamped at 0).
 * @returns {string}
 */
function formatRelativeAge(elapsedMs) {
  if (!Number.isFinite(elapsedMs)) {
    return '';
  }
  const totalSecs = Math.max(0, Math.floor(elapsedMs / MS_PER_SECOND));
  if (totalSecs < JUST_NOW_THRESHOLD_SECS) {
    return AGE_JUST_NOW;
  }
  if (totalSecs < SECS_PER_MINUTE) {
    return totalSecs + AGE_SECONDS_SUFFIX;
  }
  if (totalSecs < SECS_PER_HOUR) {
    return Math.floor(totalSecs / SECS_PER_MINUTE) + AGE_MINUTES_SUFFIX;
  }
  if (totalSecs < SECS_PER_DAY) {
    const hours = Math.floor(totalSecs / SECS_PER_HOUR);
    const mins = Math.floor((totalSecs % SECS_PER_HOUR) / SECS_PER_MINUTE);
    return mins > 0 ? hours + AGE_HOURS_INFIX + mins + AGE_MINUTES_SUFFIX : hours + AGE_HOURS_SUFFIX;
  }
  const days = Math.floor(totalSecs / SECS_PER_DAY);
  const remHours = Math.floor((totalSecs % SECS_PER_DAY) / SECS_PER_HOUR);
  return remHours > 0 ? days + AGE_DAYS_INFIX + remHours + AGE_HOURS_SUFFIX : days + AGE_DAYS_SUFFIX;
}

/**
 * Normalizes a log level string ('warning' -> 'warn', unknown -> 'info').
 *
 * @param {string} rawLevel - Raw severity string.
 * @returns {'debug'|'info'|'warn'|'error'}
 */
function normalizeLevelName(rawLevel) {
  switch (
    String(rawLevel || '')
      .toLowerCase()
      .trim()
  ) {
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
 * Explicit log scope: the camera or component label plus an optional state badge.
 *
 * @typedef {{name?: string, state?: string}} LogScope
 */

/**
 * Any value accepted as a log scope: nothing or a name string (`'bridge'`), an explicit `{name, state}` object, or a
 * domain object that hands the logger its scope through `getLogScope()`.
 *
 * @typedef {string|LogScope|{getLogScope: () => LogScope}|null|undefined} LogScopeInput
 */

/**
 * Returns true when the scope object hands the logger its explicit scope through `getLogScope()`.
 *
 * @param {LogScope|{getLogScope: () => LogScope}} scope - Scope object.
 * @returns {scope is {getLogScope: () => LogScope}}
 */
function isLogScopeProvider(scope) {
  return 'getLogScope' in scope && typeof scope.getLogScope === 'function';
}

/**
 * Resolves any accepted scope input to an explicit scope. Only `getLogScope()`, `name`, and `state` are read; other
 * properties of the passed object are never inspected.
 *
 * @param {LogScopeInput} scope - Scope name, explicit scope, or provider of a scope.
 * @returns {{name: string, state: string}}
 */
function resolveLogScope(scope) {
  if (!scope) {
    return {name: 'bridge', state: ''};
  }
  if (typeof scope !== 'object') {
    return {name: String(scope), state: ''};
  }
  const explicit = isLogScopeProvider(scope) ? scope.getLogScope() : scope;
  return {name: explicit.name || 'bridge', state: explicit.state || ''};
}

/**
 * Masks embedded URL userinfo credentials (including passwords containing '@') in text.
 *
 * @param {string|null|undefined} text - Input text that may contain URLs with userinfo credentials.
 * @returns {string} Text with embedded credentials replaced by '***'.
 */
function maskSecrets(text) {
  if (text === null || text === undefined) {
    return '';
  }
  return String(text).replace(URL_CREDENTIALS_REGEX, URL_CREDENTIALS_REPLACEMENT);
}

/**
 * Formats a single error node (including AggregateError sub-errors and empty-message SystemErrors).
 *
 * @param {*} node - Error instance, plain error-like object, or primitive.
 * @returns {string}
 */
function formatSingleErrorNode(node) {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node !== 'object') {
    return String(node).trim();
  }
  const rawMsg = typeof node.message === 'string' ? node.message.trim() : '';
  const rawCode = typeof node.code === 'string' || typeof node.code === 'number' ? String(node.code).trim() : '';
  const subParts = [];
  if (Array.isArray(node.errors)) {
    for (const sub of node.errors) {
      const subText = formatSingleErrorNode(sub);
      if (subText && !subParts.includes(subText)) {
        subParts.push(subText);
      }
    }
  }
  const subJoined = subParts.join('; ');
  if (rawMsg && subJoined && !rawMsg.includes(subJoined)) {
    return rawMsg + ' (' + subJoined + ')';
  }
  if (rawMsg) {
    return rawCode && !rawMsg.includes(rawCode) ? rawMsg + ' [' + rawCode + ']' : rawMsg;
  }
  if (subJoined) {
    return subJoined;
  }
  if (rawCode) {
    return rawCode;
  }
  try {
    const str = String(node).trim();
    return str === GENERIC_OBJECT_TO_STRING || str === BARE_AGGREGATE_ERROR_LABEL ? '' : str;
  } catch (convErr) {
    // Null-prototype objects throw on String(node); return empty so caller falls back cleanly.
    return '';
  }
}

/**
 * Formats an Error or thrown value with its full underlying cause chain and AggregateError
 * sub-errors (such as Node.js fetch TypeError("fetch failed", {cause}) and dual-stack socket
 * AggregateErrors) while redacting any embedded URL credentials.
 *
 * @param {*} err - Thrown Error, AggregateError, reason object, or primitive.
 * @param {boolean} [includeStack=false] - Whether to include err.stack when available.
 * @returns {string}
 */
function formatErrorMessage(err, includeStack = false) {
  if (err === null || err === undefined) {
    return 'unknown error';
  }
  const seen = new Set();
  const parts = [];
  let cursor = err;
  for (let depth = 0; depth <= MAX_ERROR_CAUSE_DEPTH && cursor !== null && cursor !== undefined; depth++) {
    if (typeof cursor === 'object') {
      if (seen.has(cursor)) {
        break;
      }
      seen.add(cursor);
    }
    const text = formatSingleErrorNode(cursor);
    if (text && !parts.some((existing) => existing.includes(text))) {
      parts.push(text);
    }
    cursor = typeof cursor === 'object' ? cursor.cause : undefined;
  }

  if (includeStack && typeof err === 'object' && typeof err.stack === 'string' && err.stack.trim()) {
    const stackText = err.stack.trim();
    const extraCauses = parts.filter((part) => !stackText.includes(part));
    const combinedStack = extraCauses.length > 0 ? stackText + ' (cause: ' + extraCauses.join(' -> ') + ')' : stackText;
    return maskSecrets(combinedStack);
  }

  if (parts.length === 0) {
    return 'unknown error';
  }
  const summary = parts.length === 1 ? parts[0] : parts[0] + ' (cause: ' + parts.slice(1).join(' -> ') + ')';
  return maskSecrets(summary);
}

/**
 * Extracts distinct root-cause diagnostic lines from FFmpeg stderr output, redacting embedded URL
 * credentials and stripping FFmpeg 6/7/8 CLI exit footers ("Conversion failed!",
 * "Error opening input file ...", "Error opening input files: ...", and secondary mux/demux
 * wrapper lines when a primary protocol/codec/device error line is already present).
 *
 * @param {string|Buffer|Uint8Array|null|undefined} rawStderr - Raw FFmpeg stderr buffer or string.
 * @returns {string[]}
 */
function extractFfmpegStderrLines(rawStderr) {
  const masked = maskSecrets(rawStderr ? String(rawStderr) : '').trim();
  if (!masked) {
    return [];
  }
  const rawLines = masked
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length === 0) {
    return [];
  }

  const nonBoilerplate = rawLines.filter((line) => !FFMPEG_BOILERPLATE_LINE_REGEX.test(line));
  const baseLines = nonBoilerplate.length > 0 ? nonBoilerplate : rawLines;
  const withoutPlural = baseLines.filter((line) => !FFMPEG_PLURAL_OPEN_FILES_REGEX.test(line));
  const unpluralized =
    withoutPlural.length > 0
      ? withoutPlural
      : baseLines.map((line) => line.replace(FFMPEG_PLURAL_OPEN_FILES_REGEX, 'Error opening $1: $2'));

  const primaryLines = unpluralized.filter((line) => !FFMPEG_SECONDARY_IO_WRAPPER_REGEX.test(line));
  const selected = primaryLines.length > 0 ? primaryLines : unpluralized;
  const unique = [];
  for (const line of selected) {
    if (!unique.includes(line)) {
      unique.push(line);
    }
  }
  return unique;
}

/**
 * Redacts embedded credentials and escapes raw CR/LF newlines to prevent log injection.
 *
 * @param {*} value - Raw log segment value.
 * @returns {string} Sanitized single-line segment.
 */
function sanitizeLogSegment(value) {
  return maskSecrets(value).replace(LOG_CR_REGEX, '\\r').replace(LOG_LF_REGEX, '\\n');
}

/**
 * Formats a single structured log line for Grafana Alloy / Loki:
 *   YYYY-MM-DD HH:MM:SS - [LEVEL] - [bridge] message
 *   YYYY-MM-DD HH:MM:SS - [LEVEL] - [camera] [STATE] message
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Log severity level.
 * @param {LogScopeInput} scope - Camera scope or name.
 * @param {Array<*>} args - Message segments.
 * @param {Date} [now=new Date()] - Timestamp to format.
 * @returns {string}
 */
function formatLogLine(level, scope, args, now = new Date()) {
  const normLevel = normalizeLevelName(level);
  const timestamp = formatLocalTimestamp(now);
  const levelTag = '[' + normLevel.toUpperCase().padEnd(LOG_LEVEL_NAME_WIDTH) + ']';
  const resolved = resolveLogScope(scope);
  const scopeName = sanitizeLogSegment(resolved.name);
  const statePrefix = sanitizeLogSegment(resolved.state ? '[' + resolved.state.toUpperCase() + '] ' : '');
  const message = sanitizeLogSegment(args.join(' '));
  return timestamp + ' - ' + levelTag + ' - [' + scopeName + '] ' + statePrefix + message;
}

/**
 * Writes a structured log line to stdout when 'level' meets or exceeds currentLogLevel.
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Log severity level.
 * @param {LogScopeInput} scope - Camera scope, explicit scope object, or 'bridge'.
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
 * Initializes the active log severity level from BRIDGE_LOG_LEVEL.
 *
 * @param {string|undefined} rawLevel - Configured log level string.
 * @returns {string} Normalized active log level name.
 */
function initLogger(rawLevel) {
  const cleaned = String(rawLevel || 'info')
    .toLowerCase()
    .trim();
  const isKnown = cleaned in LOG_LEVELS;
  const activeLogLevelName = normalizeLevelName(cleaned);
  currentLogLevel = LOG_LEVELS[activeLogLevelName];

  if (!isKnown) {
    log.warn('bridge', 'unknown BRIDGE_LOG_LEVEL "' + cleaned + '", defaulting to "info"');
  }
  return activeLogLevelName;
}

module.exports = {
  formatLocalTimestamp,
  formatLocalHm,
  formatFileTimestamp,
  parseFileTimestampMs,
  formatRelativeAge,
  normalizeLevelName,
  maskSecrets,
  formatErrorMessage,
  extractFfmpegStderrLines,
  formatLogLine,
  log,
  initLogger,
};
