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
const {HTTP_PORT} = require('../config');
const {Camera} = require('../domain/camera');
const {log, formatErrorMessage} = require('../logger');
const {buildConfigPayload, buildStatusPayload} = require('./api-payloads');
const {
  HTTP_STATUS_OK,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  ERROR_CODES,
  sendJson,
  sendJsonHead,
} = require('./http-responses');
const {
  normalizeLookupKey,
  resolveTargetSelection,
  resolveTargetCameras,
  canServeWakeRequest,
  handleWakeHttpRequest,
} = require('./wake-request');

const HEALTH_OK_PAYLOAD = Object.freeze({ok: true});
const HEALTH_SHUTTING_DOWN_PAYLOAD = Object.freeze({ok: false});
const HEALTH_OK_BODY = Buffer.from(JSON.stringify(HEALTH_OK_PAYLOAD));
const HEALTH_SHUTTING_DOWN_BODY = Buffer.from(JSON.stringify(HEALTH_SHUTTING_DOWN_PAYLOAD));
const HEALTH_OK_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'Content-Length': String(HEALTH_OK_BODY.byteLength),
  'Cache-Control': 'no-store',
  Connection: 'close',
});
const HEALTH_SHUTTING_DOWN_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'Content-Length': String(HEALTH_SHUTTING_DOWN_BODY.byteLength),
  'Cache-Control': 'no-store',
  Connection: 'close',
});
const HEALTH_PATHS = new Set(['/healthz', '/health']);
const ALLOWED_WAKE_METHODS_HEADER = 'POST, GET';
const ALLOWED_READONLY_METHODS_HEADER = 'GET, HEAD';

let httpServer = null;

/**
 * Returns the static frozen JSON payload for GET /healthz (and /health).
 * Reports healthy ({ok: true}) whenever the bridge process is running and not shutting down,
 * with zero external-service dependencies or per-request allocations.
 *
 * @param {boolean} [shuttingDown=false] - Whether the bridge is shutting down.
 * @returns {Readonly<{ ok: boolean }>}
 */
function buildHealthPayload(shuttingDown = false) {
  return shuttingDown ? HEALTH_SHUTTING_DOWN_PAYLOAD : HEALTH_OK_PAYLOAD;
}

/**
 * Extracts the pathname from a standard origin-form HTTP request target without allocating a URL object.
 *
 * @param {string|undefined} rawUrl - Raw IncomingMessage url string.
 * @returns {string}
 */
function extractFastPathname(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) {
    return '';
  }
  const queryIdx = rawUrl.indexOf('?');
  return queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
}

/**
 * Returns true if pathname matches a container liveness endpoint (/healthz or /health).
 *
 * @param {string} pathname - Normalized URL pathname.
 * @returns {boolean}
 */
function isHealthPathname(pathname) {
  return HEALTH_PATHS.has(pathname);
}

/**
 * Writes an immediate, fixed-length, non-chunked liveness response with zero allocations.
 *
 * @param {http.IncomingMessage} req - Incoming HTTP request.
 * @param {http.ServerResponse} res - Outgoing HTTP response.
 * @param {Function|undefined} isShuttingDown - Callback returning true while the bridge is shutting down.
 */
function respondHealthCheck(req, res, isShuttingDown) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', ALLOWED_READONLY_METHODS_HEADER);
    sendJson(res, HTTP_STATUS_METHOD_NOT_ALLOWED, {
      ok: false,
      error_code: ERROR_CODES.METHOD_NOT_ALLOWED,
      error: 'Method not allowed; use GET or HEAD /healthz',
    });
    return;
  }
  const shuttingDown = Boolean(isShuttingDown && isShuttingDown());
  const statusCode = shuttingDown ? HTTP_STATUS_SERVICE_UNAVAILABLE : HTTP_STATUS_OK;
  const headers = shuttingDown ? HEALTH_SHUTTING_DOWN_HEADERS : HEALTH_OK_HEADERS;
  res.writeHead(statusCode, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(shuttingDown ? HEALTH_SHUTTING_DOWN_BODY : HEALTH_OK_BODY);
  }
}

/**
 * Creates the HTTP request listener handling /healthz, /api/config, /api/status, and /api/wake/:cameras.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {Record<string, Function>} hooks - Callbacks into stream-orchestrator and shutdown state.
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>|void}
 */
function createHttpRequestHandler(cams, hooks) {
  const {wakeCameraExternal, isShuttingDown} = hooks;
  const handleAsyncRequest = async (req, res) => {
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

      if (isHealthPathname(pathname)) {
        respondHealthCheck(req, res, isShuttingDown);
        return;
      }

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

  return (req, res) => {
    if (isHealthPathname(extractFastPathname(req.url))) {
      respondHealthCheck(req, res, isShuttingDown);
      return;
    }
    return handleAsyncRequest(req, res);
  };
}

/**
 * Starts the HTTP server for /api/wake/:cameras, /api/config, /api/status, and /healthz if HTTP_PORT > 0.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {Record<string, Function>} hooks - Callbacks into stream-orchestrator.
 */
function startHttpServer(cams, hooks) {
  if (!HTTP_PORT || HTTP_PORT <= 0 || httpServer) {
    return;
  }

  let serverListening = false;
  httpServer = http.createServer(createHttpRequestHandler(cams, hooks));

  httpServer.on('error', (err) => {
    log.error('bridge', 'HTTP server error on port ' + HTTP_PORT + ': ' + formatErrorMessage(err));
    if (!serverListening) {
      process.exit(1);
    }
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    serverListening = true;
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
