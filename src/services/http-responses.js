// @ts-check
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Shared JSON response helpers, HTTP status codes, and structured error codes of the built-in HTTP server and the
 * /api/wake request handler.
 */
'use strict';

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const HTTP_STATUS_UNPROCESSABLE = 422;
const HTTP_STATUS_INTERNAL_ERROR = 500;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const CONTENT_TYPE_JSON = Object.freeze({'Content-Type': 'application/json'});
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

/**
 * Writes a JSON response with Content-Type application/json.
 *
 * @param {import('node:http').ServerResponse} res - Outgoing HTTP response.
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
 * @param {import('node:http').ServerResponse} res - Outgoing HTTP response.
 * @param {number} statusCode - HTTP status code.
 */
function sendJsonHead(res, statusCode) {
  res.writeHead(statusCode, CONTENT_TYPE_JSON);
  res.end();
}

module.exports = {
  HTTP_STATUS_OK,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_UNPROCESSABLE,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  ERROR_CODES,
  sendJson,
  sendJsonHead,
};
