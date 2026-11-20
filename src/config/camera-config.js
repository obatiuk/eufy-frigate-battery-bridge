// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Immutable CameraConfig domain value object, camera identity normalization,
 * snapshot cache filename formatting, and RTSP URI fragment stripping.
 */
'use strict';

const {formatFileTimestamp} = require('../logger');

const URL_SCHEME_DELIM = '://';
const CACHE_SNAPSHOT_INFIX = '_snapshot_';
const CACHE_JPEG_EXT = '.jpg';
const LEGACY_CACHE_PREFIX = 'last_';
const NAME_SERIAL_SEP = '_';

/**
 * Normalizes a Date, epoch millisecond timestamp, or pre-formatted timestamp string into 'YYYY-MM-DD_HH-MM-SS'.
 *
 * @param {Date|number|string} [at=Date.now()] - Capture timestamp or Date.
 * @returns {string}
 */
function resolveSnapshotTimestamp(at = Date.now()) {
  if (typeof at === 'string' && at.trim()) {
    return at.trim();
  }
  if (at instanceof Date) {
    return formatFileTimestamp(at);
  }
  const ms = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : Date.now();
  return formatFileTimestamp(new Date(ms));
}

/**
 * Extracts normalized { name, serial } from either a Camera domain object (with getName/getSerial)
 * or a raw/CameraConfig configuration object.
 *
 * @param {unknown} rawCam - Camera configuration or domain instance.
 * @returns {{ name: string, serial: string }}
 */
function extractNameAndSerial(rawCam) {
  const hasGetters =
    rawCam &&
    typeof rawCam === 'object' &&
    typeof (/** @type {{ getName?: unknown }} */ (rawCam).getName) === 'function' &&
    typeof (/** @type {{ getSerial?: unknown }} */ (rawCam).getSerial) === 'function';
  if (hasGetters) {
    return {
      name: /** @type {{ getName: () => string }} */ (rawCam).getName(),
      serial: /** @type {{ getSerial: () => string }} */ (rawCam).getSerial(),
    };
  }
  const {name, serial} = CameraConfig.normalizeIdentity(rawCam);
  return {name, serial};
}

/**
 * Strips any RFC 3986 URI `#fragment` suffix (such as go2rtc's `#backchannel=0`) after the
 * RTSP authority (`rtsp://[user:pass@]host[:port]`) without altering `#` inside credentials.
 *
 * @param {unknown} rawUrl - Candidate RTSP URL string.
 * @returns {string}
 */
function stripRtspUrlFragment(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  const schemeEnd = trimmed.indexOf(URL_SCHEME_DELIM);
  if (schemeEnd === -1) return trimmed;
  const authStart = schemeEnd + URL_SCHEME_DELIM.length;
  const slashIdx = trimmed.indexOf('/', authStart);
  const searchFrom = slashIdx !== -1 ? slashIdx : Math.max(authStart, trimmed.lastIndexOf('@') + 1);
  const hashIdx = trimmed.indexOf('#', searchFrom);
  return hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
}

/**
 * Returns true when a camera configuration entry explicitly specifies a non-empty direct rtsp_url.
 *
 * @param {unknown} camConfig - Candidate camera configuration object.
 * @returns {boolean}
 */
function hasDirectRtspUrl(camConfig) {
  if (!camConfig || typeof camConfig !== 'object') {
    return false;
  }
  const rec = /** @type {Record<string, unknown>} */ (camConfig);
  return Boolean(String(rec.rtsp_url || '').trim());
}

/**
 * Immutable per-camera configuration domain value object encapsulating camera identity
 * normalization, scope resolution, snapshot cache filename formatting, and resolved sub-configs.
 */
class CameraConfig {
  /**
   * @param {Record<string, *>} props - Resolved camera configuration properties.
   */
  constructor(props = {}) {
    /** @type {string} */
    this.serial = String(props.serial || '');
    /** @type {string} */
    this.explicitSerial = String(props.explicitSerial || '');
    /** @type {string} */
    this.name = String(props.name || this.serial);
    /** @type {string} */
    this.title = String(props.title || '');
    /** @type {string} */
    this.station_serial = String(props.station_serial || '');
    /** @type {string} */
    this.rtsp_url = stripRtspUrlFragment(props.rtsp_url);
    /** @type {string} */
    this.mode = props.timers && props.timers.mode ? String(props.timers.mode) : String(props.mode || '');
    /** @type {boolean|undefined} */
    this.use_rtsp = typeof props.use_rtsp === 'boolean' ? props.use_rtsp : undefined;
    /** @type {number} */
    this.priority = typeof props.priority === 'number' ? props.priority : 0;
    /** @type {boolean} */
    this.preserveAspect = Boolean(props.preserveAspect ?? true);
    /** @type {boolean} */
    this.autoFrigateMask = Boolean(props.autoFrigateMask ?? true);
    /** @type {boolean} */
    this.cardShowOnLive = Boolean(props.cardShowOnLive ?? true);
    /** @type {boolean} */
    this.trackStuckSpotlight = Boolean(props.trackStuckSpotlight ?? false);
    /** @type {boolean|string} */
    this.startupSnapshot = props.startupSnapshot ?? true;
    this.timers = props.timers || null;
    this.triggers = props.triggers || null;
    /** @type {boolean} */
    this.hasExplicitTriggers = Boolean(props.hasExplicitTriggers);
    /** @type {ReadonlySet<string>|null} */
    this.rawTriggers = props.rawTriggers instanceof Set ? props.rawTriggers : null;
    this.cardConfig = props.cardConfig || null;
    this.telemetryConfig = props.telemetryConfig || null;
    this.hwRecordingConfig = props.hwRecordingConfig || null;
  }

  /**
   * Returns the normalized internal camera stream name.
   *
   * @returns {string}
   */
  getName() {
    return this.name;
  }

  /**
   * Returns the normalized hardware serial number.
   *
   * @returns {string}
   */
  getSerial() {
    return this.serial;
  }

  /**
   * Returns the structured logger scope name for this camera.
   *
   * @param {string} [fallback='bridge'] - Fallback scope when name and serial are empty.
   * @returns {string}
   */
  getScopeName(fallback = 'bridge') {
    return this.name || this.serial || fallback;
  }

  /**
   * Returns the unique timestamped snapshot cache filename (`<name>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when
   * `serial === name`, or `<name>_<serial>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when they differ) for this camera.
   *
   * @param {Date|number|string} [at] - Optional explicit capture timestamp or Date.
   * @returns {string}
   */
  getCacheFileName(at = undefined) {
    return CameraConfig.formatCacheFileName(this.name, this.serial, at);
  }

  /**
   * Returns true if this camera configuration has a valid non-empty serial and name.
   *
   * @returns {boolean}
   */
  hasValidIdentity() {
    return Boolean(this.serial && this.name);
  }

  /**
   * Returns true if camConfig is an already-built and frozen CameraConfig instance.
   *
   * @param {unknown} camConfig - Candidate camera configuration object.
   * @returns {boolean}
   */
  static isResolved(camConfig) {
    return Boolean(camConfig instanceof CameraConfig && Object.isFrozen(camConfig));
  }

  /**
   * Purely normalizes a raw camera configuration object's serial and name (defaulting name to
   * serial when omitted, or deriving an internal scope serial from name when direct rtsp_url is
   * set) without mutating rawCam, returning an immutable `{ serial, name, explicitSerial }` tuple.
   *
   * @param {unknown} rawCam - Raw or resolved camera configuration entry.
   * @returns {Readonly<{ serial: string, name: string, explicitSerial: string }>}
   */
  static normalizeIdentity(rawCam) {
    if (!rawCam || typeof rawCam !== 'object') {
      return Object.freeze({serial: '', name: '', explicitSerial: ''});
    }
    if (rawCam instanceof CameraConfig) {
      return Object.freeze({
        serial: rawCam.serial,
        name: rawCam.name,
        explicitSerial: rawCam.explicitSerial,
      });
    }
    const rec = /** @type {Record<string, unknown>} */ (rawCam);
    const rawSerial = String(rec.serial || '').trim();
    const rawName = String(rec.name || '').trim();
    const explicitSerial = typeof rec.explicitSerial === 'string' ? rec.explicitSerial : rawSerial;
    const serial = rawSerial || (hasDirectRtspUrl(rec) ? rawName : '');
    const name = rawName || serial;
    return Object.freeze({serial, name, explicitSerial});
  }

  /**
   * Purely checks whether a camera entry has a valid non-empty normalized serial and name.
   *
   * @param {unknown} rawCam - Raw or resolved camera configuration entry.
   * @returns {boolean}
   */
  static hasValidIdentity(rawCam) {
    if (
      rawCam &&
      typeof rawCam === 'object' &&
      typeof (/** @type {{ hasValidIdentity?: unknown }} */ (rawCam).hasValidIdentity) === 'function'
    ) {
      return Boolean(/** @type {{ hasValidIdentity: () => boolean }} */ (rawCam).hasValidIdentity());
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return Boolean(serial && name);
  }

  /**
   * Resolves the logger scope name for any raw, resolved, or domain camera object.
   *
   * @param {unknown} rawCam - Camera configuration or domain instance.
   * @param {string} [fallback='bridge'] - Fallback scope name.
   * @returns {string}
   */
  static resolveScopeName(rawCam, fallback = 'bridge') {
    if (
      rawCam &&
      typeof rawCam === 'object' &&
      typeof (/** @type {{ getScopeName?: unknown }} */ (rawCam).getScopeName) === 'function'
    ) {
      return /** @type {{ getScopeName: (fb?: string) => string }} */ (rawCam).getScopeName(fallback);
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return name || serial || fallback;
  }

  /**
   * Formats the deterministic camera snapshot filename prefix (`<name>_snapshot_` when `serial === name`,
   * or `<name>_<serial>_snapshot_` when both differ).
   *
   * @param {string} name - Camera stream name.
   * @param {string} serial - Camera serial number.
   * @returns {string}
   */
  static formatCacheFilePrefix(name, serial) {
    const stem = serial && serial !== name ? name + NAME_SERIAL_SEP + serial : name || serial;
    return stem + CACHE_SNAPSHOT_INFIX;
  }

  /**
   * Resolves the camera snapshot filename prefix (`<name>[_<serial>]_snapshot_`) for any camera or config object.
   *
   * @param {unknown} rawCam - Camera configuration or domain instance.
   * @returns {string}
   */
  static resolveCacheFilePrefix(rawCam) {
    const {name, serial} = extractNameAndSerial(rawCam);
    return CameraConfig.formatCacheFilePrefix(name, serial);
  }

  /**
   * Formats the timestamped JPEG cache filename (`<name>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when `serial === name`,
   * or `<name>_<serial>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when both differ).
   *
   * @param {string} name - Camera stream name.
   * @param {string} serial - Camera serial number.
   * @param {Date|number|string} [at=Date.now()] - Capture timestamp or Date.
   * @returns {string}
   */
  static formatCacheFileName(name, serial, at = Date.now()) {
    return CameraConfig.formatCacheFilePrefix(name, serial) + resolveSnapshotTimestamp(at) + CACHE_JPEG_EXT;
  }

  /**
   * Resolves the timestamped JPEG cache filename (`<name>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when `serial === name`,
   * or `<name>_<serial>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when they differ) for any camera configuration or domain
   * instance.
   *
   * @param {unknown} rawCam - Camera configuration or domain instance.
   * @param {Date|number|string} [at] - Optional explicit capture timestamp or Date.
   * @returns {string}
   */
  static resolveCacheFileName(rawCam, at = undefined) {
    if (
      rawCam &&
      typeof rawCam === 'object' &&
      typeof (/** @type {{ getCacheFileName?: unknown }} */ (rawCam).getCacheFileName) === 'function'
    ) {
      return /** @type {{ getCacheFileName: (ts?: Date|number|string) => string }} */ (rawCam).getCacheFileName(at);
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return CameraConfig.formatCacheFileName(name, serial, at);
  }

  /**
   * Returns the ordered list of legacy `last_*.jpg` filenames (`last_<name>_<serial>.jpg`, `last_<name>.jpg`,
   * and `last_<name>_<name>.jpg` when `serial === name`) that earlier bridge versions created for this camera.
   *
   * @param {unknown} rawCam - Camera configuration or domain instance.
   * @returns {readonly string[]}
   */
  static resolveLegacyCacheFileNames(rawCam) {
    const {name, serial} = extractNameAndSerial(rawCam);
    const stem = serial && serial !== name ? name + NAME_SERIAL_SEP + serial : name || serial;
    if (!stem) {
      return Object.freeze([]);
    }
    const primaryLegacy = LEGACY_CACHE_PREFIX + stem + CACHE_JPEG_EXT;
    if (name && serial && serial === name) {
      return Object.freeze([primaryLegacy, LEGACY_CACHE_PREFIX + name + NAME_SERIAL_SEP + serial + CACHE_JPEG_EXT]);
    }
    return Object.freeze([primaryLegacy]);
  }
}

module.exports = {
  stripRtspUrlFragment,
  hasDirectRtspUrl,
  CameraConfig,
};
