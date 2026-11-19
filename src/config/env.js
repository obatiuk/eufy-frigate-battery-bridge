// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Environment variable parsing, external service endpoint resolution,
 * `${ENV_VAR}` placeholder expansion, build version metadata, and runtime directories.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {log, formatErrorMessage} = require('../logger');
const {
  DEFAULT_FALLBACK_VERSION,
  DEFAULT_FALLBACK_COMMIT,
  DEFAULT_CACHE_DIR,
  DEFAULT_HWACCEL_DEVICE,
  DEFAULT_CONTAINER_CONFIG_PATH,
  DEFAULT_LOCAL_CONFIG_PATH,
  READY_MARKER_FILENAME,
  DEFAULT_EUFY_WS_HOST,
  DEFAULT_EUFY_WS_PORT,
  DEFAULT_FRIGATE_HOST,
  DEFAULT_FRIGATE_HTTP_PORT,
  DEFAULT_GO2RTC_HTTP_PORT,
  DEFAULT_GO2RTC_RTSP_PORT,
  DEFAULT_HTTP_PORT,
  DEFAULT_LOG_LEVEL,
  MIN_TCP_PORT,
  MIN_HTTP_LISTEN_PORT,
  MAX_TCP_PORT,
  DEFAULT_HTTP_PROTOCOL,
  DEFAULT_WS_PROTOCOL,
  RTSP_NAME_TEMPLATE_TOKEN,
  HWACCEL_MODES,
  SUPPORTED_HWACCEL_MODES,
  DISABLED_HWACCEL_TOKENS,
  SUPPORTED_LOG_LEVELS,
  HTTP_PROTOCOLS,
  WS_PROTOCOLS,
  RTSP_PROTOCOLS,
} = require('./constants');

const INTEGER_PORT_REGEX = /^\d+$/;
const TRAILING_SLASHES_REGEX = /\/+$/;
const TRAILING_API_PATH_REGEX = /\/api$/i;
const ENV_VAR_EXPR_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?$/;
const ENV_ESCAPED_OPEN_TOKEN = '$${';
const ENV_DOLLAR_CHAR = '$';
const ENV_DEFAULT_SEPARATOR = ':-';
const ENV_OPEN_TOKEN = '${';
const ENV_CLOSE_TOKEN = '}';
const MAX_MALFORMED_PLACEHOLDER_CHARS = 24;

const DEFAULT_PACKAGE_VERSION = (() => {
  const candidatePaths = [
    path.resolve(__dirname, '../../package.json'),
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
 * Resolves a writable directory for storing cached camera snapshots across restarts.
 *
 * @param {string} [preferredDir=DEFAULT_CACHE_DIR] - Preferred cache directory path.
 * @returns {string} Writable directory path for snapshot cache files.
 */
function resolveCacheDir(preferredDir = DEFAULT_CACHE_DIR) {
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
 * @param {string} [hwMode=HWACCEL_MODES.NONE] - Parsed hwaccel mode.
 * @param {string} [hwDevice=DEFAULT_HWACCEL_DEVICE] - Device node path.
 * @returns {string} Validated hwaccel mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m') or '' for software.
 */
function resolveHwaccel(hwMode = HWACCEL_MODES.NONE, hwDevice = DEFAULT_HWACCEL_DEVICE) {
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

module.exports = {
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  resolveBuildInfo,
  readEnvString,
  resolveServiceEndpoints,
  resolveRuntimeEnv,
  expandConfigEnvVars,
  resolveConfigFilePath,
  resolveReadyMarkerPath,
  clearReadyMarkerFile,
  resolveCacheDir,
  resolveHwaccel,
};
