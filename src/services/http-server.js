// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Built-in HTTP server exposing:
 *   - POST/GET /api/wake/:cameras (external pre-wake webhook for CLI testing or external services)
 *   - GET/HEAD /api/config (build version, Git commit hash & sanitized resolved runtime config in JSON)
 *   - GET/HEAD /api/status (full runtime status, upstream services, stations & per-camera telemetry)
 *   - GET/HEAD /healthz (minimal container process liveness check)
 */
'use strict';

const http = require('node:http');
const {
  cfg,
  HTTP_PORT,
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  ACTIVE_LOG_LEVEL_NAME,
  W,
  H,
  LIVE_FPS,
  IDLE_FPS,
  AUDIO,
  ACTIVE_HWACCEL,
  BACKFILL_DELAY_MS,
  PREEMPT_EVENT_STREAMS,
  INSTANT_EVENT_SNAPSHOT,
  SNAP_DELAY_MS,
  COOLDOWN_MS,
  TELEMETRY_POLL_MS,
  LOW_BAT_THRESHOLD,
  CRITICAL_BAT_THRESHOLD,
  FORWARD_FACE_NAMES,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
} = require('../config');
const {Camera, WakeRequest, API_WAKE_STATUSES, CAMERA_RUNTIME_STATUSES} = require('../domain/camera');
const {log, formatErrorMessage} = require('../logger');
const {
  isWsReady,
  isInitialTelemetryLoaded,
  getKnownStationSerials,
  isStationRecycling,
  isStationReconnecting,
  isStationDisconnected,
} = require('./eufy-client');
const {isFrigateConnected, isGo2rtcConnected} = require('./frigate-client');

const MAX_JSON_BODY_BYTES = 16384;
const MIN_WAKE_DURATION_SECS = 5;
const MS_PER_SECOND = 1000;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const HTTP_STATUS_UNPROCESSABLE = 422;
const HTTP_STATUS_INTERNAL_ERROR = 500;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const CONTENT_TYPE_JSON = Object.freeze({'Content-Type': 'application/json'});
const ALLOWED_WAKE_METHODS_HEADER = 'POST, GET';
const ALLOWED_READONLY_METHODS_HEADER = 'GET, HEAD';
const DEFAULT_WAKE_REASON = 'external api wake';
const WS_DISCONNECTED_ERROR = 'eufy-security-ws not connected';
const SHUTTING_DOWN_ERROR = 'Bridge is shutting down';
const DIRECT_RTSP_UNSUPPORTED_ERROR = 'Direct rtsp_url camera(s) connect automatically and do not support /api/wake';
const ALL_OFFLINE_ERROR = 'Target camera(s) offline; telemetry refresh requested';
const ERROR_CODES = Object.freeze({
  INVALID_TARGET_ENCODING: 'INVALID_TARGET_ENCODING',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CAMERA_NOT_FOUND: 'CAMERA_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  WS_DISCONNECTED: 'WS_DISCONNECTED',
  BRIDGE_SHUTTING_DOWN: 'BRIDGE_SHUTTING_DOWN',
  CAMERA_OFFLINE: 'CAMERA_OFFLINE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});
const NON_ALPHANUMERIC_SLUG_REGEX = /[^a-z0-9]+/g;
const LEADING_SLASHES_REGEX = /^\/+/;
const TRUE_STRING = 'true';
const FALSE_STRING = 'false';

let httpServer = null;
const startedAtMs = Date.now();

/**
 * Writes a JSON response with Content-Type application/json.
 *
 * @param {http.ServerResponse} res - Outgoing HTTP response.
 * @param {number} statusCode - HTTP status code.
 * @param {Record<string, *>} payload - JSON-serializable response payload.
 */
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, CONTENT_TYPE_JSON);
  res.end(JSON.stringify(payload));
}

/**
 * Writes HTTP response headers without a body for HEAD requests.
 *
 * @param {http.ServerResponse} res - Outgoing HTTP response.
 * @param {number} statusCode - HTTP status code.
 */
function sendJsonHead(res, statusCode) {
  res.writeHead(statusCode, CONTENT_TYPE_JSON);
  res.end();
}

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
 * @param {http.IncomingMessage} req - Incoming HTTP request.
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
 * Builds the sanitized JSON payload returned by GET/HEAD /api/config, setting top-level
 * Eufy-WS and live-card options to null when no configured camera uses them.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @returns {Readonly<Record<string, *>>}
 */
function buildConfigPayload(cams) {
  const hasEufyCameras = cams.length === 0 || cams.some((c) => !c.isRtspDirect());
  const hasLiveCardTarget = cams.length === 0 || cams.some((c) => c.supportsLiveCardOverlay());
  return Object.freeze({
    version: BRIDGE_VERSION,
    commit: BRIDGE_COMMIT,
    log_level: ACTIVE_LOG_LEVEL_NAME,
    width: W,
    height: H,
    live_fps: LIVE_FPS,
    idle_fps: IDLE_FPS,
    audio: AUDIO,
    hwaccel: ACTIVE_HWACCEL || null,
    use_rtsp: hasEufyCameras ? Boolean(cfg.use_rtsp) : null,
    backfill_enabled: hasEufyCameras ? Boolean(cfg.backfill_enabled) : null,
    backfill_delay_secs: hasEufyCameras ? Math.round(BACKFILL_DELAY_MS / MS_PER_SECOND) : null,
    view_has_priority: hasEufyCameras ? PREEMPT_EVENT_STREAMS : null,
    instant_event_snapshot: hasEufyCameras ? INSTANT_EVENT_SNAPSHOT : null,
    snapshot_capture_delay_secs: hasEufyCameras ? Math.round(SNAP_DELAY_MS / MS_PER_SECOND) : null,
    view_cooldown_secs: hasEufyCameras ? Math.round(COOLDOWN_MS / MS_PER_SECOND) : null,
    telemetry_poll_secs: hasEufyCameras ? Math.round(TELEMETRY_POLL_MS / MS_PER_SECOND) : null,
    low_battery_threshold: hasEufyCameras ? LOW_BAT_THRESHOLD : null,
    critical_battery_threshold: hasEufyCameras ? CRITICAL_BAT_THRESHOLD : null,
    track_stuck_spotlight: hasEufyCameras ? Boolean(cfg.track_stuck_spotlight) : null,
    forward_face_names: hasEufyCameras ? FORWARD_FACE_NAMES : null,
    auto_frigate_mask: GLOBAL_AUTO_FRIGATE_MASK,
    card_show_on_live: hasLiveCardTarget ? GLOBAL_CARD_SHOW_ON_LIVE : null,
    ha_webhook_configured: Boolean(cfg.ha_webhook_url),
    cameras: Object.freeze(cams.map((c) => c.toConfigSummary())),
  });
}

/**
 * Builds the minimal JSON payload returned by GET /healthz (and /health) so frequent container
 * supervisor probes perform zero camera-array iterations or allocations. Reports healthy (200)
 * whenever the bridge process is running and not shutting down.
 *
 * @param {Camera[]} _cams - Configured Camera instances (unused; full camera status lives on /api/status).
 * @param {boolean} shuttingDown - Whether the bridge is shutting down.
 * @param {number} [startMs=startedAtMs] - Process start timestamp in milliseconds.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 * @returns {Readonly<Record<string, *>>}
 */
function buildHealthPayload(_cams, shuttingDown, startMs = startedAtMs, now = Date.now()) {
  return Object.freeze({
    ok: !shuttingDown,
    ws_connected: isWsReady(),
    uptime_secs: Math.max(0, Math.round((now - startMs) / MS_PER_SECOND)),
  });
}

/**
 * Builds per-station P2P connectivity and single-slot arbitration summaries for GET /api/status.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {boolean} wsConnected - Whether eufy-security-ws is currently connected.
 * @returns {ReadonlyArray<Readonly<Record<string, *>>>}
 */
function buildStationsSummary(cams, wsConnected) {
  /** @type {Set<string>} */
  const serials = new Set();
  for (const cam of cams) {
    const stSn = cam.getStationSerial();
    if (stSn) {
      serials.add(stSn);
    }
  }
  for (const discoveredSn of getKnownStationSerials(cams)) {
    if (discoveredSn) {
      serials.add(discoveredSn);
    }
  }
  const stations = [];
  for (const stationSn of serials) {
    const stationCams = [];
    for (const cam of cams) {
      if (cam.getStationSerial() === stationSn) {
        stationCams.push(cam);
      }
    }
    const activeP2pCam = stationCams.find((c) => c.isOccupyingStationP2pChannel()) || null;
    const allCamsStationOk = stationCams.length === 0 || stationCams.every((c) => c.isStationConnected());
    stations.push(
      Object.freeze({
        serial: stationSn,
        connected: Boolean(wsConnected && !isStationDisconnected(stationSn) && allCamsStationOk),
        recycling: isStationRecycling(stationSn),
        reconnecting: isStationReconnecting(stationSn),
        p2p_busy: Boolean(activeP2pCam),
        active_p2p_camera: activeP2pCam ? activeP2pCam.getName() : null,
        cameras: Object.freeze(stationCams.map((c) => c.getName())),
      })
    );
  }
  return Object.freeze(stations);
}

/**
 * Aggregates high-level camera status, disruption, battery, backfill, and viewer counts in one pass.
 *
 * @param {ReadonlyArray<Record<string, *>>} cameraSummaries - Per-camera toStatusSummary() objects.
 * @returns {Readonly<Record<string, number>>}
 */
function buildCamerasAggregateSummary(cameraSummaries) {
  let streaming = 0;
  let waking = 0;
  let waiting = 0;
  let sleeping = 0;
  let disrupted = 0;
  let offline = 0;
  let lowBattery = 0;
  let pendingBackfills = 0;
  let connectedViewers = 0;

  for (const cam of cameraSummaries) {
    if (cam.status === CAMERA_RUNTIME_STATUSES.LIVE || cam.status === CAMERA_RUNTIME_STATUSES.BACKFILL) {
      streaming++;
    } else if (cam.status === CAMERA_RUNTIME_STATUSES.WAKING) {
      waking++;
    } else if (cam.status === CAMERA_RUNTIME_STATUSES.WAITING) {
      waiting++;
    } else if (cam.status === CAMERA_RUNTIME_STATUSES.ASLEEP || cam.status === CAMERA_RUNTIME_STATUSES.LOW_BATTERY) {
      sleeping++;
    }
    if (cam.disrupted) {
      disrupted++;
    }
    if (cam.offline) {
      offline++;
    }
    if (!cam.offline && cam.telemetry && cam.telemetry.low_battery) {
      lowBattery++;
    }
    if (cam.backfill && (cam.backfill.pending || cam.backfill.playing)) {
      pendingBackfills++;
    }
    connectedViewers += cam.viewers ? cam.viewers.connected : 0;
  }

  return Object.freeze({
    total_cameras: cameraSummaries.length,
    streaming_cameras: streaming,
    waking_cameras: waking,
    waiting_cameras: waiting,
    sleeping_cameras: sleeping,
    disrupted_cameras: disrupted,
    offline_cameras: offline,
    low_battery_cameras: lowBattery,
    pending_backfills: pendingBackfills,
    connected_viewers: connectedViewers,
  });
}

/**
 * Builds the full runtime status payload returned by GET/HEAD /api/status, exposing upstream
 * service health, HomeBase station P2P slots, aggregate counts, and every configured camera's
 * live session, encoder, viewer, event, backfill, trigger, and sensor telemetry state.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {{ shuttingDown?: boolean, startMs?: number, now?: number }} [opts={}] - Status timing/shutdown options.
 * @returns {Readonly<Record<string, *>>}
 */
function buildStatusPayload(cams, opts = {}) {
  const shuttingDown = Boolean(opts.shuttingDown);
  const startMs = opts.startMs !== undefined ? opts.startMs : startedAtMs;
  const now = opts.now !== undefined ? opts.now : Date.now();
  const hasEufyCameras = cams.length === 0 || cams.some((c) => !c.isRtspDirect());
  const wsConnected = isWsReady();
  const frigateOk = cams.length > 0 ? cams.every((c) => c.isFrigateConnected()) : isFrigateConnected();
  const go2rtcOk = cams.length > 0 ? cams.every((c) => c.isGo2rtcConnected()) : isGo2rtcConnected();
  const cameraSummaries = Object.freeze(cams.map((c) => c.toStatusSummary(now)));

  return Object.freeze({
    ok: !shuttingDown,
    shutting_down: shuttingDown,
    version: BRIDGE_VERSION,
    commit: BRIDGE_COMMIT,
    uptime_secs: Math.max(0, Math.round((now - startMs) / MS_PER_SECOND)),
    services: Object.freeze({
      ws_connected: hasEufyCameras ? Boolean(wsConnected) : null,
      initial_telemetry_loaded: hasEufyCameras ? Boolean(isInitialTelemetryLoaded()) : null,
      frigate_connected: Boolean(frigateOk),
      go2rtc_connected: Boolean(go2rtcOk),
      ha_webhook_configured: Boolean(cfg.ha_webhook_url),
    }),
    stations: hasEufyCameras ? buildStationsSummary(cams, wsConnected) : Object.freeze([]),
    summary: buildCamerasAggregateSummary(cameraSummaries),
    cameras: cameraSummaries,
  });
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
 * @param {http.IncomingMessage} req - Incoming HTTP request.
 * @param {http.ServerResponse} res - Outgoing HTTP response.
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

/**
 * Creates the HTTP request listener handling /api/config, /healthz, and /api/wake/:cameras.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {Record<string, Function>} hooks - Callbacks into stream-orchestrator and shutdown state.
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>}
 */
function createHttpRequestHandler(cams, hooks) {
  const {wakeCameraExternal, isShuttingDown} = hooks;
  return async (req, res) => {
    try {
      let urlObj;
      try {
        urlObj = new URL(req.url || '/', 'http://localhost');
      } catch (err) {
        sendJson(res, HTTP_STATUS_BAD_REQUEST, {
          ok: false,
          error_code: ERROR_CODES.INVALID_REQUEST,
          error: 'Malformed request URL',
        });
        return;
      }
      const pathname = urlObj.pathname;
      const isHead = req.method === 'HEAD';

      if ((req.method === 'GET' || isHead) && pathname === '/api/config') {
        if (isHead) {
          sendJsonHead(res, HTTP_STATUS_OK);
        } else {
          sendJson(res, HTTP_STATUS_OK, buildConfigPayload(cams));
        }
        return;
      }

      if (pathname === '/api/status') {
        if (req.method !== 'GET' && !isHead) {
          res.setHeader('Allow', ALLOWED_READONLY_METHODS_HEADER);
          sendJson(res, HTTP_STATUS_METHOD_NOT_ALLOWED, {
            ok: false,
            error_code: ERROR_CODES.METHOD_NOT_ALLOWED,
            error: 'Method not allowed; use GET or HEAD /api/status',
          });
          return;
        }
        const shuttingDown = Boolean(isShuttingDown && isShuttingDown());
        const statusCode = shuttingDown ? HTTP_STATUS_SERVICE_UNAVAILABLE : HTTP_STATUS_OK;
        if (isHead) {
          sendJsonHead(res, statusCode);
        } else {
          sendJson(res, statusCode, buildStatusPayload(cams, {shuttingDown}));
        }
        return;
      }

      if ((req.method === 'GET' || isHead) && (pathname === '/healthz' || pathname === '/health')) {
        const shuttingDown = Boolean(isShuttingDown && isShuttingDown());
        const statusCode = shuttingDown ? HTTP_STATUS_SERVICE_UNAVAILABLE : HTTP_STATUS_OK;
        if (isHead) {
          sendJsonHead(res, statusCode);
        } else {
          sendJson(res, statusCode, buildHealthPayload(cams, shuttingDown));
        }
        return;
      }

      if (pathname === '/api/wake' || pathname.startsWith('/api/wake/')) {
        if (req.method !== 'POST' && req.method !== 'GET') {
          res.setHeader('Allow', ALLOWED_WAKE_METHODS_HEADER);
          sendJson(res, HTTP_STATUS_METHOD_NOT_ALLOWED, {
            ok: false,
            error_code: ERROR_CODES.METHOD_NOT_ALLOWED,
            error: 'Method not allowed; use POST or GET /api/wake/:cameras',
          });
          return;
        }
        await handleWakeHttpRequest(req, res, {urlObj, cams, wakeCameraExternal, isShuttingDown});
        return;
      }

      sendJson(res, HTTP_STATUS_NOT_FOUND, {
        ok: false,
        error_code: ERROR_CODES.NOT_FOUND,
        error: 'Not found',
      });
    } catch (err) {
      log.error('bridge', 'HTTP request handler error: ' + formatErrorMessage(err, true));
      sendJson(res, HTTP_STATUS_INTERNAL_ERROR, {
        ok: false,
        error_code: ERROR_CODES.INTERNAL_ERROR,
        error: 'Internal server error',
      });
    }
  };
}

/**
 * Starts the HTTP server for /api/wake/:cameras, /api/config, and /healthz if HTTP_PORT > 0.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {Record<string, Function>} hooks - Callbacks into stream-orchestrator.
 */
function startHttpServer(cams, hooks) {
  if (!HTTP_PORT || HTTP_PORT <= 0 || httpServer) {
    return;
  }

  httpServer = http.createServer(createHttpRequestHandler(cams, hooks));

  httpServer.on('error', (err) => {
    log.error('bridge', 'HTTP server error on port ' + HTTP_PORT + ': ' + formatErrorMessage(err));
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    log.info(
      'bridge',
      'HTTP server listening on 0.0.0.0:' + HTTP_PORT + ' (/api/wake/:cameras, /api/config, /api/status, /healthz)'
    );
  });
}

/**
 * Stops the HTTP server during graceful shutdown.
 */
function stopHttpServer() {
  if (!httpServer) {
    return;
  }
  try {
    httpServer.close();
  } catch (err) {
    // Ignore close errors on shutdown.
  }
  httpServer = null;
}

module.exports = {
  normalizeLookupKey,
  resolveTargetSelection,
  resolveTargetCameras,
  canServeWakeRequest,
  buildConfigPayload,
  buildHealthPayload,
  buildStatusPayload,
  createHttpRequestHandler,
  startHttpServer,
  stopHttpServer,
};
