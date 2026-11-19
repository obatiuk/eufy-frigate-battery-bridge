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

const URL_SCHEME_DELIM = '://';

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
   * Returns the unique snapshot cache filename (`last_<name>.jpg` when `serial === name`,
   * or `last_<name>_<serial>.jpg` when they differ) for this camera.
   *
   * @returns {string}
   */
  getCacheFileName() {
    return CameraConfig.formatCacheFileName(this.name, this.serial);
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
   * Formats the deterministic JPEG cache filename (`last_<name>.jpg` when `serial === name`,
   * or `last_<name>_<serial>.jpg` when both differ).
   *
   * @param {string} name - Camera stream name.
   * @param {string} serial - Camera serial number.
   * @returns {string}
   */
  static formatCacheFileName(name, serial) {
    const suffix = serial && serial !== name ? name + '_' + serial : name || serial;
    return 'last_' + suffix + '.jpg';
  }

  /**
   * Resolves the deterministic JPEG cache filename (`last_<name>.jpg` when `serial === name`,
   * or `last_<name>_<serial>.jpg` when they differ) for any camera configuration or domain instance.
   *
   * @param {unknown} rawCam - Camera configuration or domain instance.
   * @returns {string}
   */
  static resolveCacheFileName(rawCam) {
    if (
      rawCam &&
      typeof rawCam === 'object' &&
      typeof (/** @type {{ getCacheFileName?: unknown }} */ (rawCam).getCacheFileName) === 'function'
    ) {
      return /** @type {{ getCacheFileName: () => string }} */ (rawCam).getCacheFileName();
    }
    const {serial, name} = CameraConfig.normalizeIdentity(rawCam);
    return CameraConfig.formatCacheFileName(name, serial);
  }

  /**
   * Returns the legacy duplicated cache filename (`last_<name>_<name>.jpg`) when a camera's
   * normalized serial equals its name, or an empty string when no legacy duplicate existed.
   *
   * @param {unknown} rawCam - Camera configuration or domain instance.
   * @returns {string}
   */
  static resolveLegacyDuplicateCacheFileName(rawCam) {
    const hasGetters =
      rawCam &&
      typeof rawCam === 'object' &&
      typeof (/** @type {{ getName?: unknown }} */ (rawCam).getName) === 'function' &&
      typeof (/** @type {{ getSerial?: unknown }} */ (rawCam).getSerial) === 'function';
    const name = hasGetters
      ? /** @type {{ getName: () => string }} */ (rawCam).getName()
      : CameraConfig.normalizeIdentity(rawCam).name;
    const serial = hasGetters
      ? /** @type {{ getSerial: () => string }} */ (rawCam).getSerial()
      : CameraConfig.normalizeIdentity(rawCam).serial;
    return name && serial && serial === name ? 'last_' + name + '_' + serial + '.jpg' : '';
  }
}

module.exports = {
  stripRtspUrlFragment,
  hasDirectRtspUrl,
  CameraConfig,
};
