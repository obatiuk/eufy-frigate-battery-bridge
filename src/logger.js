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
 * Resolves the log scope label from a stateful domain object or scope string.
 *
 * @param {string|{
 *   getScopeName?: () => string,
 *   getName?: () => string,
 *   name?: string,
 *   cameraName?: string,
 *   sessionState?: string,
 *   state?: string,
 *   decoderState?: string,
 *   evState?: string
 * }|null|undefined} scope - Stateful domain instance or scope name.
 * @returns {string}
 */
function resolveScopeName(scope) {
  if (!scope) {
    return 'bridge';
  }
  switch (typeof scope) {
    case 'object':
      if (typeof scope.getScopeName === 'function') {
        return scope.getScopeName();
      }
      if (typeof scope.getName === 'function') {
        return scope.getName() || 'bridge';
      }
      return scope.name || scope.cameraName || 'bridge';
    default:
      return String(scope);
  }
}

/**
 * Resolves the uppercase state badge prefix for log lines when scope is a stateful domain object
 * (Camera with sessionState, BackfillJob with state, or sub-FSM scope with decoderState / evState).
 *
 * @param {string|{
 *   name?: string,
 *   cameraName?: string,
 *   sessionState?: string,
 *   state?: string,
 *   decoderState?: string,
 *   evState?: string
 * }|null|undefined} scope - Stateful domain instance or scope name.
 * @returns {string}
 */
function resolveStatePrefix(scope) {
  if (!scope || typeof scope !== 'object') {
    return '';
  }
  const rawState = scope.sessionState || scope.state || scope.decoderState || scope.evState || '';
  return rawState ? '[' + String(rawState).toUpperCase() + '] ' : '';
}

/**
 * Formats a single structured log line for Grafana Alloy / Loki:
 *   YYYY-MM-DD HH:MM:SS - [LEVEL] - [bridge] message
 *   YYYY-MM-DD HH:MM:SS - [LEVEL] - [camera] [STATE] message
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Log severity level.
 * @param {string|{name?: string, sessionState?: string}|null|undefined} scope - Camera scope or name.
 * @param {Array<*>} args - Message segments.
 * @param {Date} [now=new Date()] - Timestamp to format.
 * @returns {string}
 */
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

function formatLogLine(level, scope, args, now = new Date()) {
  const normLevel = normalizeLevelName(level);
  const timestamp = formatLocalTimestamp(now);
  const levelTag = `[${normLevel.toUpperCase().padEnd(LOG_LEVEL_NAME_WIDTH)}]`;
  const scopeName = sanitizeLogSegment(resolveScopeName(scope));
  const statePrefix = sanitizeLogSegment(resolveStatePrefix(scope));
  const message = sanitizeLogSegment(args.join(' '));
  return `${timestamp} - ${levelTag} - [${scopeName}] ${statePrefix}${message}`;
}

/**
 * Writes a structured log line to stdout when 'level' meets or exceeds currentLogLevel.
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
  normalizeLevelName,
  maskSecrets,
  formatErrorMessage,
  extractFfmpegStderrLines,
  formatLogLine,
  log,
  initLogger,
};
