// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Single-pass YAML configuration schema validation and startup config file loading.
 */
'use strict';

const fs = require('node:fs');
const jsYaml = require('js-yaml');
const {log, formatErrorMessage, initLogger} = require('../logger');
const {
  DEFAULT_LOG_LEVEL,
  MIN_STREAMING_QUALITY,
  MAX_STREAMING_QUALITY,
  ALLOWED_TOP_KEYS,
  ALLOWED_CAMERA_KEYS,
  CAMERA_MODES,
  POWER_MODES,
  STREAMING_QUALITIES,
  RTSP_PROTOCOLS,
  BOOLEAN_CONFIG_KEYS,
  INTEGER_CONFIG_KEYS,
  FLOAT_CONFIG_KEYS,
  ALLOWED_TELEMETRY_KEYS,
} = require('./constants');
const {stripRtspUrlFragment, hasDirectRtspUrl, CameraConfig} = require('./camera-config');
const {
  readEnvString,
  resolveServiceEndpoints,
  resolveRuntimeEnv,
  expandConfigEnvVars,
  resolveConfigFilePath,
  clearReadyMarkerFile,
} = require('./env');

const RTSP_URL_PROTOCOL_REGEX = /^rtsps?:\/\/.+/i;
const SAFE_IDENTITY_TOKEN_REGEX = /^[A-Za-z0-9._-]+$/;
const FULL_ENV_PLACEHOLDER_REGEX = /^\$\{[^}]+\}$/;
const INLINE_ENV_PLACEHOLDER_REGEX = /\$\{[^}]+\}/g;
/** @type {Set<string>} */
const SUPPORTED_POWER_MODES = new Set(Object.values(POWER_MODES));
/** @type {Set<string>} */
const SUPPORTED_STREAMING_QUALITIES = new Set(Object.values(STREAMING_QUALITIES));

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
    // Malformed URL syntax returns empty host so caller reports a validation error.
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
 * Returns true when value is a string containing at least one non-whitespace character.
 *
 * @param {unknown} item - Candidate array element.
 * @returns {boolean}
 */
function isNonEmptyString(item) {
  return typeof item === 'string' && Boolean(item.trim());
}

/**
 * Returns true when value is a finite JavaScript number.
 *
 * @param {unknown} value - Candidate priority value.
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates optional `power_mode` and `streaming_quality` profile values on a top-level or camera node.
 *
 * @param {Record<string, *>} node - Top-level or per-camera configuration mapping.
 * @param {string} prefix - Scope prefix ('' or 'cameras[i] ').
 * @param {string[]} errors - Mutable validation error collector.
 */
function validatePowerAndQualityOptions(node, prefix, errors) {
  if (node.power_mode !== undefined) {
    if (typeof node.power_mode !== 'string' || !SUPPORTED_POWER_MODES.has(node.power_mode)) {
      errors.push(prefix + '"power_mode" must be one of "keep", "battery", "surveillance", or "custom"');
    }
  }
  if (node.streaming_quality !== undefined) {
    const q = node.streaming_quality;
    const isNamedQuality = typeof q === 'string' && SUPPORTED_STREAMING_QUALITIES.has(q);
    const isCustomIntQuality =
      prefix !== '' && Number.isInteger(q) && q >= MIN_STREAMING_QUALITY && q <= MAX_STREAMING_QUALITY;
    if (!isNamedQuality && !isCustomIntQuality) {
      errors.push(
        prefix +
          '"streaming_quality" must be one of "keep", "auto", "low", "medium", "high", "ultra"' +
          (prefix !== '' ? ', or integer 0..10' : '')
      );
    }
  }
}

/**
 * Validates shared boolean, numeric, startup_snapshot, power_mode, streaming_quality, trigger_events, and telemetry.
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
  validatePowerAndQualityOptions(node, prefix, errors);
  if (node.trigger_events !== undefined) {
    const validTriggers =
      Array.isArray(node.trigger_events) &&
      node.trigger_events.length > 0 &&
      node.trigger_events.every(isNonEmptyString);
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
    if (!cam.name && name && !Object.isFrozen(cam)) {
      cam.name = name;
    }
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
      Boolean(ep) && typeof ep === 'object' && !Array.isArray(ep) && Object.values(ep).every(isFiniteNumber);
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

module.exports = {
  validateConfig,
  loadConfigFile,
  loadConfig,
};
