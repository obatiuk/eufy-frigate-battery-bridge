// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Soft startup validation of upstream external service API versions (Frigate, go2rtc, and eufy-security-ws),
 * warning when a configured service reports a version or API schema lower than the minimum supported version.
 */
'use strict';

const {cfg} = require('../config');
const {log, formatErrorMessage} = require('../logger');
const {FRIGATE_API_TIMEOUT_MS, readHttpErrorSnippet} = require('./upstream-health');

const FRIGATE_MIN_MAJOR = 0;
const FRIGATE_MIN_MINOR = 14;
const FRIGATE_MIN_PATCH = 0;

const GO2RTC_MIN_MAJOR = 1;
const GO2RTC_MIN_MINOR = 9;
const GO2RTC_MIN_PATCH = 0;

const EUFY_WS_MIN_MAJOR = 1;
const EUFY_WS_MIN_MINOR = 9;
const EUFY_WS_MIN_PATCH = 9;
const MIN_EUFY_WS_SCHEMA = 18;

const HTTP_SERVER_ERROR_STATUS = 500;
const MAX_VERSION_RESPONSE_BYTES = 65536;
const UPSTREAM_VERSION_RETRY_DELAY_MS = 10000;
const MAX_UPSTREAM_VERSION_RETRIES = 6;

const FRIGATE_VERSION_PATH = '/api/version';
const GO2RTC_INFO_PATH = '/api';
const JSON_OBJECT_PREFIX = '{';
const JSON_QUOTE_CHAR = '"';
const SEMVER_REGEX = /^[vV]?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z._-]+)?$/;

const MIN_SUPPORTED_VERSIONS = Object.freeze({
  FRIGATE: FRIGATE_MIN_MAJOR + '.' + FRIGATE_MIN_MINOR + '.' + FRIGATE_MIN_PATCH,
  GO2RTC: GO2RTC_MIN_MAJOR + '.' + GO2RTC_MIN_MINOR + '.' + GO2RTC_MIN_PATCH,
  EUFY_WS: EUFY_WS_MIN_MAJOR + '.' + EUFY_WS_MIN_MINOR + '.' + EUFY_WS_MIN_PATCH,
  EUFY_WS_SCHEMA: MIN_EUFY_WS_SCHEMA,
});

const MIN_FRIGATE_SEMVER = Object.freeze({
  major: FRIGATE_MIN_MAJOR,
  minor: FRIGATE_MIN_MINOR,
  patch: FRIGATE_MIN_PATCH,
  raw: MIN_SUPPORTED_VERSIONS.FRIGATE,
});

const MIN_GO2RTC_SEMVER = Object.freeze({
  major: GO2RTC_MIN_MAJOR,
  minor: GO2RTC_MIN_MINOR,
  patch: GO2RTC_MIN_PATCH,
  raw: MIN_SUPPORTED_VERSIONS.GO2RTC,
});

const MIN_EUFY_WS_SEMVER = Object.freeze({
  major: EUFY_WS_MIN_MAJOR,
  minor: EUFY_WS_MIN_MINOR,
  patch: EUFY_WS_MIN_PATCH,
  raw: MIN_SUPPORTED_VERSIONS.EUFY_WS,
});

const VALID_EUFY_WS_VERSION_RESULT = Object.freeze({
  ok: true,
  serverBelowMin: false,
  schemaBelowMin: false,
});

/** @type {ReturnType<typeof setTimeout>|null} */
let versionRetryTimer = null;
/** @type {AbortController|null} */
let activeProbeAbortController = null;
let lastWarnedEufyWsSignature = '';

/**
 * Parses a version string (e.g. '0.14.0-9034454', 'v1.9.14', or '1.9') into an immutable numeric tuple,
 * returning null when the input is empty or non-semver (such as 'dev').
 *
 * @param {*} rawVersion - Candidate version value.
 * @returns {Readonly<{ major: number, minor: number, patch: number, raw: string }>|null}
 */
function parseSemver(rawVersion) {
  if (typeof rawVersion !== 'string') {
    return null;
  }
  const trimmed = rawVersion.trim();
  const match = SEMVER_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, rawMajor, rawMinor, rawPatch] = match;
  const major = Number(rawMajor);
  const minor = Number(rawMinor);
  const patch = rawPatch !== undefined ? Number(rawPatch) : 0;
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return Object.freeze({major, minor, patch, raw: trimmed});
}

/**
 * Returns true when candidate has a strictly lower (major, minor, patch) tuple than minimum.
 *
 * @param {{ major: number, minor: number, patch: number }|null|undefined} candidate - Parsed service version.
 * @param {{ major: number, minor: number, patch: number }|null|undefined} minimum - Minimum required version.
 * @returns {boolean}
 */
function isVersionLowerThan(candidate, minimum) {
  return candidate && minimum
    ? candidate.major !== minimum.major
      ? candidate.major < minimum.major
      : candidate.minor !== minimum.minor
        ? candidate.minor < minimum.minor
        : candidate.patch < minimum.patch
    : false;
}

/**
 * Extracts a version string from Frigate's /api/version response (plain text, quoted JSON string, or JSON object).
 *
 * @param {string} rawBody - Response body text.
 * @returns {string}
 */
function extractFrigateVersionText(rawBody) {
  const trimmed = String(rawBody || '').trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith(JSON_OBJECT_PREFIX) || trimmed.startsWith(JSON_QUOTE_CHAR)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed.trim();
      }
      if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string') {
        return parsed.version.trim();
      }
    } catch (err) {
      // Fall back to first plain-text line when body is not valid JSON.
    }
  }
  const [firstLine] = trimmed.split(/\r?\n/);
  return firstLine.trim();
}

/**
 * Extracts the string `version` field from go2rtc's GET /api JSON info payload.
 *
 * @param {string} rawBody - Response body text.
 * @returns {string}
 */
function extractGo2rtcVersionText(rawBody) {
  const trimmed = String(rawBody || '').trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && typeof parsed.version === 'string' ? parsed.version.trim() : '';
  } catch (err) {
    // Non-JSON /api response returns empty string so probe reports unparseable version.
    return '';
  }
}

/**
 * Returns true when an upstream probe was cancelled by shutdown or stopUpstreamVersionChecks().
 *
 * @param {AbortSignal} abortSignal - Shared probe cancellation signal.
 * @param {() => boolean} isShuttingDown - Bridge shutdown predicate.
 * @returns {boolean}
 */
function isProbeCancelled(abortSignal, isShuttingDown) {
  return abortSignal.aborted ? true : Boolean(isShuttingDown());
}

/**
 * @typedef {{
 *   read: () => Promise<{ done: boolean, value?: Uint8Array }>,
 *   cancel: () => Promise<unknown>,
 * }} BoundedStreamReader
 */

/**
 * @typedef {{
 *   body?: { getReader?: () => BoundedStreamReader }|null,
 *   text?: () => Promise<string>,
 * }} BoundedFetchResponse
 */

/**
 * Reads up to MAX_VERSION_RESPONSE_BYTES of UTF-8 text from an HTTP response, cancelling streaming
 * bodies immediately if a misconfigured endpoint streams unbounded data.
 *
 * @param {BoundedFetchResponse|null|undefined} res - Fetch response object.
 * @returns {Promise<string>}
 */
async function readBoundedResponseText(res) {
  if (!res) {
    return '';
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength > 0) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_VERSION_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {
              // Ignore stream cancel errors when truncating oversized responses.
            });
            return '';
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
      return Buffer.concat(chunks, totalBytes).toString('utf8');
    } catch (err) {
      // Aborted or broken body stream resolves empty so caller checks cancellation or parse result.
      return '';
    }
  }
  if (typeof res.text === 'function') {
    try {
      const raw = await res.text();
      return String(raw || '').slice(0, MAX_VERSION_RESPONSE_BYTES);
    } catch (err) {
      // Body read failure resolves empty so probe degrades gracefully.
      return '';
    }
  }
  return '';
}

/**
 * Queries one HTTP upstream version endpoint and logs a soft warning when the reported version is below minimum.
 * Returns true once the check has settled (valid, warned, 4xx, cancelled, or unparseable) and false on transient
 * network/5xx errors so startup can retry slow-booting companion containers.
 *
 * @param {{
 *   serviceLabel: string,
 *   baseUrl: string,
 *   endpointPath: string,
 *   minimum: Readonly<{ major: number, minor: number, patch: number, raw: string }>,
 *   extractVersion: (body: string) => string,
 *   abortSignal: AbortSignal,
 *   isShuttingDown: () => boolean
 * }} spec - Service probe specification.
 * @returns {Promise<boolean>}
 */
async function probeHttpServiceVersion(spec) {
  const {serviceLabel, baseUrl, endpointPath, minimum, extractVersion, abortSignal, isShuttingDown} = spec;
  if (!baseUrl || isProbeCancelled(abortSignal, isShuttingDown)) {
    return true;
  }
  let res;
  try {
    const requestSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(FRIGATE_API_TIMEOUT_MS)]);
    res = await fetch(baseUrl + endpointPath, {signal: requestSignal});
  } catch (err) {
    if (isProbeCancelled(abortSignal, isShuttingDown)) {
      return true;
    }
    log.debug(
      'bridge',
      'could not verify ' + serviceLabel + ' API version yet (' + baseUrl + ', ' + formatErrorMessage(err) + ')'
    );
    return false;
  }

  if (isProbeCancelled(abortSignal, isShuttingDown)) {
    return true;
  }

  try {
    if (!res.ok) {
      const snippet = await Promise.resolve()
        .then(() => readHttpErrorSnippet(res))
        .catch(() => {
          // Best-effort diagnostic snippet; fall back to status code alone on body read error.
          return '';
        });
      if (isProbeCancelled(abortSignal, isShuttingDown)) {
        return true;
      }
      const detail = 'HTTP ' + res.status + (snippet ? ': ' + snippet : '');
      log.debug('bridge', 'could not query ' + serviceLabel + ' API version (' + baseUrl + ', ' + detail + ')');
      return res.status < HTTP_SERVER_ERROR_STATUS;
    }

    const rawText = await readBoundedResponseText(res);
    if (isProbeCancelled(abortSignal, isShuttingDown)) {
      return true;
    }
    const parsed = parseSemver(extractVersion(rawText));
    if (!parsed) {
      log.debug('bridge', 'could not parse ' + serviceLabel + ' API version from ' + baseUrl + endpointPath);
      return true;
    }
    if (isVersionLowerThan(parsed, minimum)) {
      log.warn(
        'bridge',
        serviceLabel +
          ' API version ' +
          parsed.raw +
          ' is lower than minimum supported version ' +
          minimum.raw +
          ' (' +
          baseUrl +
          '); some features may not work'
      );
      return true;
    }
    log.debug('bridge', 'verified ' + serviceLabel + ' API version ' + parsed.raw + ' >= ' + minimum.raw);
    return true;
  } catch (err) {
    log.debug(
      'bridge',
      'ignoring unexpected ' + serviceLabel + ' API version response error (' + formatErrorMessage(err) + ')'
    );
    return true;
  }
}

/**
 * Cancels any pending background retry timer and aborts any in-flight startup version probes.
 */
function stopUpstreamVersionChecks() {
  if (versionRetryTimer) {
    clearTimeout(versionRetryTimer);
    versionRetryTimer = null;
  }
  if (activeProbeAbortController) {
    activeProbeAbortController.abort();
    activeProbeAbortController = null;
  }
}

/**
 * Resets cached eufy-security-ws warning deduplication and pending retry timers.
 */
function resetServiceVersionChecks() {
  stopUpstreamVersionChecks();
  lastWarnedEufyWsSignature = '';
}

/**
 * Soft-validates Frigate and go2rtc API versions on startup in parallel, scheduling bounded background retries
 * only for services that are temporarily unreachable while containers finish booting.
 *
 * @param {{
 *   frigateUrl?: string,
 *   go2rtcUrl?: string,
 *   isShuttingDown?: () => boolean,
 *   retryDelayMs?: number,
 *   maxRetries?: number
 * }} [opts={}] - Startup verification options.
 * @returns {Promise<void>}
 */
async function verifyUpstreamServiceVersions(opts = {}) {
  stopUpstreamVersionChecks();
  const frigateUrl = opts.frigateUrl !== undefined ? opts.frigateUrl : cfg.frigate_url;
  const go2rtcUrl = opts.go2rtcUrl !== undefined ? opts.go2rtcUrl : cfg.go2rtc_url;
  const isShuttingDown = typeof opts.isShuttingDown === 'function' ? opts.isShuttingDown : () => false;
  const retryDelayMs = opts.retryDelayMs !== undefined ? opts.retryDelayMs : UPSTREAM_VERSION_RETRY_DELAY_MS;
  const maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : MAX_UPSTREAM_VERSION_RETRIES;

  let frigateSettled = !frigateUrl;
  let go2rtcSettled = !go2rtcUrl;

  /**
   * @param {number} attempt - Zero-based attempt counter.
   * @returns {Promise<void>}
   */
  const runProbeAttempt = async (attempt) => {
    try {
      if (isShuttingDown()) {
        return;
      }
      const probeController = new AbortController();
      activeProbeAbortController = probeController;
      const {signal} = probeController;

      const [nextFrigateSettled, nextGo2rtcSettled] = await Promise.all([
        frigateSettled
          ? Promise.resolve(true)
          : probeHttpServiceVersion({
              serviceLabel: 'Frigate',
              baseUrl: frigateUrl,
              endpointPath: FRIGATE_VERSION_PATH,
              minimum: MIN_FRIGATE_SEMVER,
              extractVersion: extractFrigateVersionText,
              abortSignal: signal,
              isShuttingDown,
            }),
        go2rtcSettled
          ? Promise.resolve(true)
          : probeHttpServiceVersion({
              serviceLabel: 'go2rtc',
              baseUrl: go2rtcUrl,
              endpointPath: GO2RTC_INFO_PATH,
              minimum: MIN_GO2RTC_SEMVER,
              extractVersion: extractGo2rtcVersionText,
              abortSignal: signal,
              isShuttingDown,
            }),
      ]);

      if (activeProbeAbortController === probeController) {
        activeProbeAbortController = null;
      }
      if (isProbeCancelled(signal, isShuttingDown)) {
        return;
      }
      frigateSettled = nextFrigateSettled;
      go2rtcSettled = nextGo2rtcSettled;

      if ((frigateSettled && go2rtcSettled) || attempt >= maxRetries) {
        return;
      }
      versionRetryTimer = setTimeout(() => {
        versionRetryTimer = null;
        void runProbeAttempt(attempt + 1);
      }, retryDelayMs);
      if (versionRetryTimer && typeof versionRetryTimer.unref === 'function') {
        versionRetryTimer.unref();
      }
    } catch (err) {
      log.debug('bridge', 'startup service version check skipped (' + formatErrorMessage(err) + ')');
    }
  };

  await runProbeAttempt(0);
}

/**
 * Safely parses `maxSchemaVersion` from an eufy-security-ws handshake frame without throwing on
 * Symbols/null-prototype objects or coercing empty strings, booleans, or arrays to schema 0.
 *
 * @param {*} rawSchema - Candidate maxSchemaVersion field.
 * @returns {number} Finite schema version or NaN when absent/non-numeric.
 */
function parseSchemaVersion(rawSchema) {
  if (typeof rawSchema === 'number') {
    return Number.isFinite(rawSchema) ? rawSchema : Number.NaN;
  }
  if (typeof rawSchema === 'string') {
    const trimmed = rawSchema.trim();
    if (!trimmed) {
      return Number.NaN;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/**
 * Soft-validates the initial 'version' handshake message from eufy-security-ws against the minimum supported
 * serverVersion (1.9.9) and maxSchemaVersion (18), logging one warning per distinct outdated version.
 *
 * @param {Record<string, *>|null|undefined} versionMsg - Parsed 'version' message from eufy-security-ws.
 * @returns {Readonly<{ ok: boolean, serverBelowMin: boolean, schemaBelowMin: boolean }>}
 */
function validateEufyWsVersion(versionMsg) {
  try {
    const parsedServer = parseSemver(versionMsg && versionMsg.serverVersion);
    const serverBelowMin = isVersionLowerThan(parsedServer, MIN_EUFY_WS_SEMVER);
    const rawMaxSchema = versionMsg ? parseSchemaVersion(versionMsg.maxSchemaVersion) : Number.NaN;
    const schemaBelowMin = Number.isFinite(rawMaxSchema) && rawMaxSchema < MIN_EUFY_WS_SCHEMA;

    if (!serverBelowMin && !schemaBelowMin) {
      lastWarnedEufyWsSignature = '';
      if (parsedServer || Number.isFinite(rawMaxSchema)) {
        const verLabel = parsedServer ? parsedServer.raw : 'n/a';
        const schemaLabel = Number.isFinite(rawMaxSchema) ? String(rawMaxSchema) : 'n/a';
        log.debug(
          'bridge',
          'verified eufy-security-ws version=' + verLabel + ' (maxSchemaVersion=' + schemaLabel + ')'
        );
      }
      return VALID_EUFY_WS_VERSION_RESULT;
    }

    const signature =
      (parsedServer ? parsedServer.raw : '') + ':' + (Number.isFinite(rawMaxSchema) ? rawMaxSchema : '');
    if (signature !== lastWarnedEufyWsSignature) {
      lastWarnedEufyWsSignature = signature;
      if (serverBelowMin && schemaBelowMin && parsedServer) {
        log.warn(
          'bridge',
          'eufy-security-ws version ' +
            parsedServer.raw +
            ' (maxSchemaVersion=' +
            rawMaxSchema +
            ') is lower than minimum supported version ' +
            MIN_SUPPORTED_VERSIONS.EUFY_WS +
            ' (API schema >= ' +
            MIN_EUFY_WS_SCHEMA +
            '); some features may not work'
        );
      } else if (serverBelowMin && parsedServer) {
        log.warn(
          'bridge',
          'eufy-security-ws version ' +
            parsedServer.raw +
            ' is lower than minimum supported version ' +
            MIN_SUPPORTED_VERSIONS.EUFY_WS +
            ' (API schema >= ' +
            MIN_EUFY_WS_SCHEMA +
            '); some features may not work'
        );
      } else {
        log.warn(
          'bridge',
          'eufy-security-ws API schema ' +
            rawMaxSchema +
            ' is lower than minimum supported schema ' +
            MIN_EUFY_WS_SCHEMA +
            ' (version >= ' +
            MIN_SUPPORTED_VERSIONS.EUFY_WS +
            '); some features may not work'
        );
      }
    }
    return Object.freeze({ok: false, serverBelowMin, schemaBelowMin});
  } catch (err) {
    log.debug('bridge', 'ignoring malformed eufy-security-ws version payload (' + formatErrorMessage(err) + ')');
    return VALID_EUFY_WS_VERSION_RESULT;
  }
}

module.exports = {
  MIN_SUPPORTED_VERSIONS,
  parseSemver,
  isVersionLowerThan,
  validateEufyWsVersion,
  verifyUpstreamServiceVersions,
  stopUpstreamVersionChecks,
  resetServiceVersionChecks,
};
