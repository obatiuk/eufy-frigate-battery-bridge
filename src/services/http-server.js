// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Built-in HTTP server exposing:
 *   - POST/GET /api/wake/:cameras (external pre-wake webhook for CLI testing or external services)
 *   - GET/HEAD /healthz (container readiness & WebSocket health check)
 */
'use strict';

const http = require('http');
const {HTTP_PORT, HOLD_MS, MAX_MS} = require('../config');
const {log} = require('../logger');
const {isWsReady} = require('./eufy-client');

const MAX_JSON_BODY_BYTES = 16384;
const MIN_WAKE_DURATION_SECS = 5;
const MAX_WAKE_DURATION_SECS = Math.round(MAX_MS / 1000);
const DEFAULT_HOLD_DURATION_SECS = Math.round(HOLD_MS / 1000);

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
      .replace(/[^a-z0-9]+/g, '_');
}

/**
 * Resolves a comma-separated camera target string ('all', serial, name, or slugified title)
 * into matching Camera instances.
 *
 * @param {string} targetSpec - URL path parameter after /api/wake/.
 * @param {Array<Record<string, *>>} cams - Configured Camera instances.
 * @returns {Array<Record<string, *>>}
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
      if (
          String(cam.name).toLowerCase() === lower ||
          String(cam.serial).toLowerCase() === lower ||
          normalizeLookupKey(cam.name) === slug ||
          normalizeLookupKey(cam.title) === slug
      ) {
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
 * Starts the HTTP server for /api/wake/:cameras and /healthz if HTTP_PORT > 0.
 *
 * @param {Array<Record<string, *>>} cams - Configured Camera instances.
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

    if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (pathname === '/healthz' || pathname === '/health')
    ) {
      const ok = !isShuttingDown() && isWsReady();
      res.writeHead(ok ? 200 : 503, {'Content-Type': 'application/json'});
      res.end(
          JSON.stringify({
            ok,
            ws_connected: isWsReady(),
            uptime_secs: Math.round((Date.now() - startedAtMs) / 1000),
            active_cameras: cams.filter((c) => c.active).map((c) => c.name),
          })
      );
      return;
    }

    if ((req.method === 'POST' || req.method === 'GET') && (pathname === '/api/wake' || pathname.startsWith('/api/wake/'))) {
      if (!isWsReady()) {
        res.writeHead(503, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: 'eufy-security-ws not connected'}));
        return;
      }

      const rawTarget = pathname.slice('/api/wake'.length).replace(/^\/+/, '') || 'all';
      const targets = resolveTargetCameras(rawTarget, cams);
      if (!targets.length) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(
            JSON.stringify({
              ok: false,
              error: 'No matching camera found for: ' + rawTarget,
              available: cams.map((c) => ({name: c.name, serial: c.serial, title: c.title})),
            })
        );
        return;
      }

      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const rawDuration = body.duration ?? urlObj.searchParams.get('duration');
      const durationSecs =
          rawDuration !== undefined && rawDuration !== null && !Number.isNaN(Number(rawDuration))
              ? Math.max(MIN_WAKE_DURATION_SECS, Math.min(MAX_WAKE_DURATION_SECS, Number(rawDuration)))
              : DEFAULT_HOLD_DURATION_SECS;
      const reason = String(
          body.reason || urlObj.searchParams.get('reason') || 'external api wake'
      ).trim();
      const createEvent = Boolean(
          body.create_event ?? (urlObj.searchParams.get('create_event') === 'true')
      );

      const orderedTargets = [...targets].sort(
          (a, b) => Number(Boolean(b.useRtsp && b.rtspUrl)) - Number(Boolean(a.useRtsp && a.rtspUrl))
      );
      const results = orderedTargets.map((cam) =>
        wakeCameraExternal(cam, {
          durationMs: durationSecs * 1000,
          reason,
          createEvent,
        })
      );

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true, results}));
      return;
    }

    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: false, error: 'Not found'}));
  });

  httpServer.on('error', (err) => {
    log.error('bridge', 'HTTP server error on port ' + HTTP_PORT + ': ' + err.message);
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    log.info(
        'bridge',
        'HTTP server listening on 0.0.0.0:' + HTTP_PORT + ' (/api/wake/:cameras, /healthz)'
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
  startHttpServer,
  stopHttpServer,
};
