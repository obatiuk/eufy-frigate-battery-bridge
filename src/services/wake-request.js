// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Wake request parsing and dispatch for GET/POST /api/wake/:cameras: target selection, JSON body reading, parameter
 * validation, per-camera dispatch, and the HTTP handler that ties them together.
 */
'use strict';

const {Camera, WakeRequest, API_WAKE_STATUSES} = require('../domain/camera');
const {isWsReady} = require('./eufy-client');
const {
  HTTP_STATUS_OK,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_UNPROCESSABLE,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  ERROR_CODES,
  sendJson,
} = require('./http-responses');

const MAX_JSON_BODY_BYTES = 16384;
const MIN_WAKE_DURATION_SECS = 5;
const MS_PER_SECOND = 1000;
const DEFAULT_WAKE_REASON = 'external api wake';
const WS_DISCONNECTED_ERROR = 'eufy-security-ws not connected';
const SHUTTING_DOWN_ERROR = 'Bridge is shutting down';
const NON_ALPHANUMERIC_SLUG_REGEX = /[^a-z0-9]+/g;
const LEADING_SLASHES_REGEX = /^\/+/;
const TRUE_STRING = 'true';
const FALSE_STRING = 'false';
const DIRECT_RTSP_UNSUPPORTED_ERROR = 'Direct rtsp_url camera(s) connect automatically and do not support /api/wake';
const ALL_OFFLINE_ERROR = 'Target camera(s) offline; telemetry refresh requested';

/**
 * Normalizes a camera identifier or title into a lowercase alphanumeric slug for flexible matching.
 *
 * @param {string} str - Raw camera name, serial, or title.
 * @returns {string}
 */
function normalizeLookupKey(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_SLUG_REGEX, '_');
}

/**
 * Parses and resolves a comma-separated camera target string ('all', serial, name, or slugified title)
 * into matched Camera instances, unrecognized tokens, and URI decoding error state.
 *
 * @param {string} targetSpec - URL path parameter after /api/wake/.
 * @param {Camera[]} cams - Configured Camera instances.
 * @returns {{ invalidEncoding: boolean, targets: Camera[], unknown: string[] }}
 */
function resolveTargetSelection(targetSpec, cams) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(targetSpec || ''));
  } catch (err) {
    return {invalidEncoding: true, targets: [], unknown: []};
  }

  const rawTokens = decoded
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!rawTokens.length) {
    return {invalidEncoding: false, targets: [], unknown: []};
  }

  const matched = new Set();
  const unknown = [];
  for (const token of rawTokens) {
    const lower = token.toLowerCase();
    if (lower === 'all') {
      for (const cam of cams) {
        matched.add(cam);
      }
      continue;
    }
    const slug = normalizeLookupKey(token);
    let tokenMatched = false;
    for (const cam of cams) {
      if (cam.matchesTargetToken(lower, slug, normalizeLookupKey)) {
        matched.add(cam);
        tokenMatched = true;
      }
    }
    if (!tokenMatched) {
      unknown.push(token);
    }
  }
  return {invalidEncoding: false, targets: [...matched], unknown};
}

/**
 * Resolves a comma-separated camera target string ('all', serial, name, or slugified title)
 * into matching Camera instances.
 *
 * @param {string} targetSpec - URL path parameter after /api/wake/.
 * @param {Camera[]} cams - Configured Camera instances.
 * @returns {Camera[]}
 */
function resolveTargetCameras(targetSpec, cams) {
  return resolveTargetSelection(targetSpec, cams).targets;
}

/**
 * Reads and strictly validates an optional JSON object request body (up to 16 KB).
 *
 * @param {import('node:http').IncomingMessage} req - Incoming HTTP request.
 * @returns {Promise<{
 *   ok: boolean,
 *   body?: Record<string, *>,
 *   statusCode?: number,
 *   errorCode?: string,
 *   error?: string,
 * }>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (outcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buf.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (tooLarge) {
        return finish({
          ok: false,
          statusCode: HTTP_STATUS_PAYLOAD_TOO_LARGE,
          errorCode: ERROR_CODES.PAYLOAD_TOO_LARGE,
          error: 'Request body exceeds ' + MAX_JSON_BODY_BYTES + ' bytes',
        });
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        return finish({ok: true, body: {}});
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return finish({
          ok: false,
          statusCode: HTTP_STATUS_BAD_REQUEST,
          errorCode: ERROR_CODES.INVALID_REQUEST,
          error: 'Invalid JSON request body',
        });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return finish({
          ok: false,
          statusCode: HTTP_STATUS_BAD_REQUEST,
          errorCode: ERROR_CODES.INVALID_REQUEST,
          error: 'JSON request body must be an object',
        });
      }
      finish({ok: true, body: parsed});
    });

    req.on('error', () =>
      finish({
        ok: false,
        statusCode: HTTP_STATUS_BAD_REQUEST,
        errorCode: ERROR_CODES.INVALID_REQUEST,
        error: 'Failed to read request body',
      })
    );
  });
}

/**
 * Validates and extracts wake request parameters from parsed JSON body and URL query string.
 *
 * @param {Record<string, *>} body - Parsed JSON body object.
 * @param {URL} urlObj - Parsed request URL.
 * @returns {{
 *   ok: boolean,
 *   params?: { rawDuration: *, reason: string, createEvent: boolean },
 *   error?: string,
 * }}
 */
function parseWakeParams(body, urlObj) {
  const rawDuration = body.duration ?? urlObj.searchParams.get('duration');
  if (rawDuration !== undefined && rawDuration !== null) {
    const emptyStr = typeof rawDuration === 'string' && !rawDuration.trim();
    const invalidType = typeof rawDuration === 'boolean' || typeof rawDuration === 'object' || emptyStr;
    const numericDuration = Number(rawDuration);
    if (invalidType || !Number.isFinite(numericDuration) || numericDuration <= 0) {
      return {ok: false, error: 'duration must be a positive number of seconds'};
    }
  }

  const rawCreateEvent = body.create_event ?? urlObj.searchParams.get('create_event');
  let createEvent = true;
  if (rawCreateEvent !== undefined && rawCreateEvent !== null) {
    if (typeof rawCreateEvent === 'boolean') {
      createEvent = rawCreateEvent;
    } else if (typeof rawCreateEvent === 'string') {
      const normalized = rawCreateEvent.trim().toLowerCase();
      if (normalized === TRUE_STRING) {
        createEvent = true;
      } else if (normalized === FALSE_STRING) {
        createEvent = false;
      } else {
        return {ok: false, error: 'create_event must be a boolean'};
      }
    } else {
      return {ok: false, error: 'create_event must be a boolean'};
    }
  }

  const rawReason = body.reason ?? urlObj.searchParams.get('reason');
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') {
    return {ok: false, error: 'reason must be a string'};
  }
  const reason = String(rawReason || DEFAULT_WAKE_REASON).trim() || DEFAULT_WAKE_REASON;
  return {ok: true, params: {rawDuration, reason, createEvent}};
}

/**
 * Returns true if the bridge can wake at least one target camera over eufy-security-ws
 * (direct rtsp_url cameras connect continuously and do not support /api/wake).
 *
 * @param {Camera[]} targets - Resolved target Camera instances (or all configured cameras).
 * @param {boolean} [wsConnected=isWsReady()] - Whether eufy-security-ws is connected.
 * @returns {boolean}
 */
function canServeWakeRequest(targets, wsConnected = isWsReady()) {
  return Boolean(wsConnected && targets.some((c) => c.supportsApiWake()));
}

/**
 * Returns true if a single per-camera /api/wake result represents an accepted wake/backfill action.
 *
 * @param {Record<string, *>} result - Single camera result object.
 * @returns {boolean}
 */
function isWakeSuccessResult(result) {
  return Boolean(
    result &&
    result.status !== API_WAKE_STATUSES.UNSUPPORTED &&
    result.status !== API_WAKE_STATUSES.OFFLINE &&
    result.status !== API_WAKE_STATUSES.UNAVAILABLE
  );
}

/**
 * Dispatches wake requests across resolved target cameras, marking direct rtsp_url cameras
 * as unsupported and skipping Eufy cameras when WS is down.
 *
 * @param {Camera[]} targets - Resolved target Camera instances.
 * @param {{ rawDuration: *, reason: string, createEvent: boolean, wakeCameraExternal: Function }} opts - Wake options.
 * @returns {Array<Record<string, *>>}
 */
function dispatchWakeTargets(targets, {rawDuration, reason, createEvent, wakeCameraExternal}) {
  const wsConnected = isWsReady();
  const orderedTargets = [...targets].sort(Camera.compareRtspFirst);
  return orderedTargets.map((cam) => {
    if (!cam.supportsApiWake()) {
      return Object.freeze(cam.toApiWakeErrorResponse(API_WAKE_STATUSES.UNSUPPORTED));
    }
    if (!wsConnected) {
      return Object.freeze(cam.toApiWakeErrorResponse(API_WAKE_STATUSES.UNAVAILABLE, WS_DISCONNECTED_ERROR));
    }
    const durationSecs = cam.resolveApiWakeDurationSecs(rawDuration, MIN_WAKE_DURATION_SECS);
    const durationMs = durationSecs * MS_PER_SECOND;
    const wakeReq = (createEvent ? WakeRequest.motion(reason, durationMs) : WakeRequest.view(reason, durationMs))
      .withInitiator('api-wake')
      .withCreateEvent(createEvent)
      .build();
    return wakeCameraExternal(cam, wakeReq);
  });
}

/**
 * Handles GET/POST /api/wake/:cameras HTTP requests with hybrid rtsp_url support, atomic target
 * validation, and structured JSON errors.
 *
 * @param {import('node:http').IncomingMessage} req - Incoming HTTP request.
 * @param {import('node:http').ServerResponse} res - Outgoing HTTP response.
 * @param {{ urlObj: URL, cams: Camera[], wakeCameraExternal: Function, isShuttingDown?: Function }} ctx - Context.
 * @returns {Promise<void>}
 */
async function handleWakeHttpRequest(req, res, {urlObj, cams, wakeCameraExternal, isShuttingDown}) {
  if (isShuttingDown && isShuttingDown()) {
    sendJson(res, HTTP_STATUS_SERVICE_UNAVAILABLE, {
      ok: false,
      error_code: ERROR_CODES.BRIDGE_SHUTTING_DOWN,
      error: SHUTTING_DOWN_ERROR,
    });
    return;
  }

  const rawTarget = urlObj.pathname.slice('/api/wake'.length).replace(LEADING_SLASHES_REGEX, '') || 'all';
  const selection = resolveTargetSelection(rawTarget, cams);
  if (selection.invalidEncoding) {
    sendJson(res, HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error_code: ERROR_CODES.INVALID_TARGET_ENCODING,
      error: 'Malformed camera target in URL path',
    });
    return;
  }

  const bodyResult = req.method === 'POST' ? await readJsonBody(req) : {ok: true, body: {}};
  if (!bodyResult.ok) {
    sendJson(res, bodyResult.statusCode || HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error_code: bodyResult.errorCode || ERROR_CODES.INVALID_REQUEST,
      error: bodyResult.error,
    });
    return;
  }

  const paramResult = parseWakeParams(bodyResult.body || {}, urlObj);
  if (!paramResult.ok) {
    sendJson(res, HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error_code: ERROR_CODES.INVALID_REQUEST,
      error: paramResult.error,
    });
    return;
  }

  if (!selection.targets.length || selection.unknown.length > 0) {
    const errorMsg = selection.targets.length
      ? 'Unknown camera target(s): ' + selection.unknown.join(', ')
      : 'No matching camera found for: ' + rawTarget;
    sendJson(res, HTTP_STATUS_NOT_FOUND, {
      ok: false,
      error_code: ERROR_CODES.CAMERA_NOT_FOUND,
      error: errorMsg,
      unknown: selection.unknown,
      available: cams.map((c) => c.toAvailableCameraSummary()),
    });
    return;
  }

  const wakeableTargets = selection.targets.filter((c) => c.supportsApiWake());
  if (!wakeableTargets.length) {
    const results = selection.targets.map((c) => c.toApiWakeErrorResponse(API_WAKE_STATUSES.UNSUPPORTED));
    sendJson(res, HTTP_STATUS_UNPROCESSABLE, {
      ok: false,
      error_code: ERROR_CODES.UNSUPPORTED_OPERATION,
      error: DIRECT_RTSP_UNSUPPORTED_ERROR,
      results,
    });
    return;
  }

  if (!canServeWakeRequest(selection.targets)) {
    sendJson(res, HTTP_STATUS_SERVICE_UNAVAILABLE, {
      ok: false,
      error_code: ERROR_CODES.WS_DISCONNECTED,
      error: WS_DISCONNECTED_ERROR,
    });
    return;
  }

  const {rawDuration, reason, createEvent} = paramResult.params;
  const results = dispatchWakeTargets(selection.targets, {
    rawDuration,
    reason,
    createEvent,
    wakeCameraExternal,
  });

  if (!results.some(isWakeSuccessResult)) {
    sendJson(res, HTTP_STATUS_SERVICE_UNAVAILABLE, {
      ok: false,
      error_code: ERROR_CODES.CAMERA_OFFLINE,
      error: ALL_OFFLINE_ERROR,
      results,
    });
    return;
  }

  sendJson(res, HTTP_STATUS_OK, {ok: true, results});
}

module.exports = {
  normalizeLookupKey,
  resolveTargetSelection,
  resolveTargetCameras,
  readJsonBody,
  parseWakeParams,
  canServeWakeRequest,
  isWakeSuccessResult,
  dispatchWakeTargets,
  handleWakeHttpRequest,
};
