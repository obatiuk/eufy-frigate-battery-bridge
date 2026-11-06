// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Built-in HTTP server exposing:
 *   - POST/GET /api/wake/:cameras (external pre-wake webhook for CLI testing or external services)
 *   - GET/HEAD /api/config (build version, Git commit hash & sanitized resolved runtime config in JSON)
 *   - GET/HEAD /healthz (container readiness & WebSocket health check)
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
  FORWARD_FACE_NAMES,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
} = require('../config');
const {Camera, WakeRequest} = require('../domain/camera');
const {log} = require('../logger');
const {isWsReady} = require('./eufy-client');

const MAX_JSON_BODY_BYTES = 16384;
const MIN_WAKE_DURATION_SECS = 5;
const MS_PER_SECOND = 1000;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const NON_ALPHANUMERIC_SLUG_REGEX = /[^a-z0-9]+/g;
const LEADING_SLASHES_REGEX = /^\/+/;

let httpServer = null;
const startedAtMs = Date.now();

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
 * Resolves a comma-separated camera target string ('all', serial, name, or slugified title)
 * into matching Camera instances.
 *
 * @param {string} targetSpec - URL path parameter after /api/wake/.
 * @param {Camera[]} cams - Configured Camera instances.
 * @returns {Camera[]}
 */
function resolveTargetCameras(targetSpec, cams) {
  const rawTokens = decodeURIComponent(String(targetSpec || ''))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  if (!rawTokens.length) {
    return [];
  }
  if (rawTokens.some((t) => t.toLowerCase() === 'all')) {
    return [...cams];
  }

  const matched = new Set();
  for (const token of rawTokens) {
    const lower = token.toLowerCase();
    const slug = normalizeLookupKey(token);
    for (const cam of cams) {
      if (cam.matchesTargetToken(lower, slug, normalizeLookupKey)) {
        matched.add(cam);
      }
    }
  }
  return [...matched];
}

/**
 * Reads and parses an optional JSON request body (up to 16 KB).
 *
 * @param {http.IncomingMessage} req - Incoming HTTP request.
 * @returns {Promise<Record<string, *>>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      if (raw.length < MAX_JSON_BODY_BYTES) {
        raw += chunk;
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        return resolve({});
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Builds the sanitized JSON payload returned by GET/HEAD /api/config.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @returns {Readonly<Record<string, *>>}
 */
function buildConfigPayload(cams) {
  return Object.freeze({
    version: BRIDGE_VERSION,
    commit: BRIDGE_COMMIT,
    log_level: ACTIVE_LOG_LEVEL_NAME,
    width: W,
    height: H,
    live_fps: LIVE_FPS,
    idle_fps: IDLE_FPS,
    audio: AUDIO,
    hwaccel: ACTIVE_HWACCEL,
    use_rtsp: Boolean(cfg.use_rtsp),
    backfill_enabled: Boolean(cfg.backfill_enabled),
    backfill_delay_secs: Math.round(BACKFILL_DELAY_MS / MS_PER_SECOND),
    view_has_priority: PREEMPT_EVENT_STREAMS,
    instant_event_snapshot: INSTANT_EVENT_SNAPSHOT,
    snapshot_capture_delay_secs: Math.round(SNAP_DELAY_MS / MS_PER_SECOND),
    view_cooldown_secs: Math.round(COOLDOWN_MS / MS_PER_SECOND),
    telemetry_poll_secs: Math.round(TELEMETRY_POLL_MS / MS_PER_SECOND),
    low_battery_threshold: LOW_BAT_THRESHOLD,
    track_stuck_spotlight: Boolean(cfg.track_stuck_spotlight),
    forward_face_names: FORWARD_FACE_NAMES,
    auto_frigate_mask: GLOBAL_AUTO_FRIGATE_MASK,
    card_show_on_live: GLOBAL_CARD_SHOW_ON_LIVE,
    ha_webhook_configured: Boolean(cfg.ha_webhook_url),
    cameras: Object.freeze(cams.map((c) => c.toConfigSummary())),
  });
}

/**
 * Builds the JSON payload returned by GET/HEAD /healthz.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {boolean} shuttingDown - Whether the bridge is shutting down.
 * @param {number} [startMs=startedAtMs] - Process start timestamp in milliseconds.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 * @returns {Readonly<Record<string, *>>}
 */
function buildHealthPayload(cams, shuttingDown, startMs = startedAtMs, now = Date.now()) {
  const wsConnected = isWsReady();
  return Object.freeze({
    ok: !shuttingDown && wsConnected,
    ws_connected: wsConnected,
    uptime_secs: Math.round((now - startMs) / MS_PER_SECOND),
    active_cameras: cams.filter((c) => c.isSessionActive()).map((c) => c.getName()),
    offline_cameras: cams.filter((c) => c.isDeviceOffline()).map((c) => c.getName()),
  });
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
  const {wakeCameraExternal, isShuttingDown} = hooks;

  httpServer = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const pathname = urlObj.pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/config') {
      res.writeHead(HTTP_STATUS_OK, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(buildConfigPayload(cams)));
      return;
    }

    if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (pathname === '/healthz' || pathname === '/health')
    ) {
      const payload = buildHealthPayload(cams, Boolean(isShuttingDown()));
      res.writeHead(
          payload.ok ? HTTP_STATUS_OK : HTTP_STATUS_SERVICE_UNAVAILABLE,
          {'Content-Type': 'application/json'}
      );
      res.end(JSON.stringify(payload));
      return;
    }

    if ((req.method === 'POST' || req.method === 'GET') && (pathname === '/api/wake' || pathname.startsWith('/api/wake/'))) {
      if (!isWsReady()) {
        res.writeHead(HTTP_STATUS_SERVICE_UNAVAILABLE, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: 'eufy-security-ws not connected'}));
        return;
      }

      const rawTarget = pathname.slice('/api/wake'.length).replace(LEADING_SLASHES_REGEX, '') || 'all';
      const targets = resolveTargetCameras(rawTarget, cams);
      if (!targets.length) {
        res.writeHead(HTTP_STATUS_NOT_FOUND, {'Content-Type': 'application/json'});
        res.end(
            JSON.stringify({
              ok: false,
              error: 'No matching camera found for: ' + rawTarget,
              available: cams.map((c) => c.toAvailableCameraSummary()),
            })
        );
        return;
      }

      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const rawDuration = body.duration ?? urlObj.searchParams.get('duration');
      const reason = String(
          body.reason || urlObj.searchParams.get('reason') || 'external api wake'
      ).trim();
      const rawCreateEvent = body.create_event ?? urlObj.searchParams.get('create_event');
      const createEvent =
          rawCreateEvent === undefined || rawCreateEvent === null
              ? true
              : rawCreateEvent !== false && String(rawCreateEvent).toLowerCase() !== 'false';

      const orderedTargets = [...targets].sort(Camera.compareRtspFirst);
      const results = orderedTargets.map((cam) => {
        const durationSecs = cam.resolveApiWakeDurationSecs(rawDuration, MIN_WAKE_DURATION_SECS);
        const durationMs = durationSecs * MS_PER_SECOND;
        const wakeReq = (createEvent
            ? WakeRequest.motion(reason, durationMs)
            : WakeRequest.view(reason, durationMs))
            .withInitiator('api-wake')
            .withCreateEvent(createEvent)
            .build();
        return wakeCameraExternal(cam, wakeReq);
      });

      res.writeHead(HTTP_STATUS_OK, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true, results}));
      return;
    }

    res.writeHead(HTTP_STATUS_NOT_FOUND, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: false, error: 'Not found'}));
  });

  httpServer.on('error', (err) => {
    log.error('bridge', 'HTTP server error on port ' + HTTP_PORT + ': ' + err.message);
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    log.info(
        'bridge',
        'HTTP server listening on 0.0.0.0:' +
        HTTP_PORT +
        ' (/api/wake/:cameras, /api/config, /healthz)'
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
  resolveTargetCameras,
  buildConfigPayload,
  buildHealthPayload,
  startHttpServer,
  stopHttpServer,
};
