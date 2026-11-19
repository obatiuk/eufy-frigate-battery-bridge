// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * eufy-security-ws WebSocket connection lifecycle, schema negotiation, JSON-RPC transport,
 * and shared client hook/readiness state.
 */
'use strict';

const {cfg} = require('../../config');
const {log, formatErrorMessage} = require('../../logger');
const {stations} = require('../../domain/station');
const {renderCameraCards} = require('../../overlay/card-renderer');
const {pushFrameToEncoder} = require('../../media/encoder');
const {validateEufyWsVersion, resetServiceVersionChecks} = require('../service-versions');

/** @typedef {import("../../domain/camera").Camera} Camera */
/**
 * @typedef {{
 *   readyState: number,
 *   send: (data: string, cb?: (err?: Error|null) => void) => void,
 *   close: () => void,
 *   ping?: () => void,
 *   terminate?: () => void,
 *   on: (event: string, listener: (...args: *[]) => void) => void,
 * }} WsSocketLike
 */
/** @typedef {new (url: string, options?: {handshakeTimeout?: number}) => WsSocketLike} WsSocketConstructor */

const WS_OPEN = 1;
const WS_RPC_TIMEOUT_MS = 20000;
const WS_RECONNECT_DELAY_MS = 10000;
const WS_RECONNECT_MAX_DELAY_MS = 60000;
const WS_RECONNECT_BACKOFF_FACTOR = 2;
const WS_RECONNECT_INITIAL_JITTER_MS = 400;
const WS_RECONNECT_JITTER_RATIO = 0.2;
const WS_RECONNECT_JITTER_MIDPOINT = 0.5;
const WS_RECONNECT_JITTER_SCALE = 2;
const WS_HANDSHAKE_TIMEOUT_MS = 10000;
const WS_PING_INTERVAL_MS = 30000;
const WS_PONG_TIMEOUT_MS = 10000;
const MS_PER_SECOND = 1000;
const INITIAL_TELEMETRY_RETRY_MS = 10000;
const MAX_SUPPORTED_API_SCHEMA = 21;

/** @type {WsSocketConstructor|null} */
let WebSocketCtor = null;
/** @type {WsSocketLike|null} */
let ws = null;
let wsReady = false;
let wsReadyAt = 0;
let wsHasEverDisconnected = false;
let wsOutageWarned = false;
let wsOutageErrorLogged = false;
let wsReconnectAttempts = 0;
let awaitingPong = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let wsReconnectTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let wsHandshakeTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let wsPingTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let wsPongTimeoutTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let initialTelemetryRetryTimer = null;
let initialTelemetryLoaded = false;
let rpcSequence = 0;
const pendingRpcMap = new Map();

/** @type {Camera[]} */
let camsRef = [];
/** @type {Map<string, Camera>} */
let bySerialRef = new Map();
let isShuttingDownFn = () => false;
let onEventCallback = null;
let onWsClosedStopCallback = null;
let onDeviceOfflineStopCallback = null;
let onDeviceOnlineResumeCallback = null;
let onInitialTelemetryCallback = null;

/** @type {(stateObj: Record<string, *>) => Promise<void>} */
let onEnsureInitialConnectedFn = async () => {};
/** @type {(forceRefresh?: boolean) => Promise<void>} */
let onFetchAllTelemetryFn = async () => {};
/** @type {(cam: Camera, props: Record<string, *>, allowCardRebuild?: boolean) => void} */
let onApplyDevicePropertiesFn = () => {};
/** @type {() => void} */
let onResetPropertyChainsFn = () => {};
/** @type {(reason: string) => Promise<void>} */
let onRecoverDriverAndStationsFn = async () => {};

/**
 * Registers cross-module handshake, recovery, and property-sync callbacks so ws-transport
 * stays at the base of the eufy service dependency graph.
 *
 * @param {{
 *   onEnsureInitialConnected?: (stateObj: Record<string, *>) => Promise<void>,
 *   onFetchAllTelemetry?: (forceRefresh?: boolean) => Promise<void>,
 *   onApplyDeviceProperties?: (cam: Camera, props: Record<string, *>, allowCardRebuild?: boolean) => void,
 *   onResetPropertyChains?: () => void,
 *   onRecoverDriverAndStations?: (reason: string) => Promise<void>,
 * }} [handlers={}] - Subsystem callbacks.
 */
function registerEufySubsystems(handlers = {}) {
  if (typeof handlers.onEnsureInitialConnected === 'function') {
    onEnsureInitialConnectedFn = handlers.onEnsureInitialConnected;
  }
  if (typeof handlers.onFetchAllTelemetry === 'function') {
    onFetchAllTelemetryFn = handlers.onFetchAllTelemetry;
  }
  if (typeof handlers.onApplyDeviceProperties === 'function') {
    onApplyDevicePropertiesFn = handlers.onApplyDeviceProperties;
  }
  if (typeof handlers.onResetPropertyChains === 'function') {
    onResetPropertyChainsFn = handlers.onResetPropertyChains;
  }
  if (typeof handlers.onRecoverDriverAndStations === 'function') {
    onRecoverDriverAndStationsFn = handlers.onRecoverDriverAndStations;
  }
}

/**
 * Lazily loads the 'ws' WebSocket constructor (or returns an injected constructor).
 *
 * @returns {WsSocketConstructor}
 */
function getWebSocketConstructor() {
  if (!WebSocketCtor) {
    WebSocketCtor = /** @type {WsSocketConstructor} */ (/** @type {unknown} */ (require('ws')));
  }
  return WebSocketCtor;
}

/**
 * Configures runtime references and lifecycle callbacks for the Eufy WebSocket client.
 *
 * @param {Record<string, *>} hooks - Client wiring options.
 */
function configureEufyClientHooks(hooks = {}) {
  if (Array.isArray(hooks.cams)) {
    camsRef = hooks.cams;
    stations.bindCameras(camsRef);
  }
  if (hooks.bySerial instanceof Map) bySerialRef = hooks.bySerial;
  if (typeof hooks.wsReadyAt === 'number') wsReadyAt = hooks.wsReadyAt;
  if (typeof hooks.isShuttingDown === 'function') isShuttingDownFn = hooks.isShuttingDown;
  if (typeof hooks.onEvent === 'function') onEventCallback = hooks.onEvent;
  if (typeof hooks.onWsClosedStop === 'function') onWsClosedStopCallback = hooks.onWsClosedStop;
  if (typeof hooks.onDeviceOfflineStop === 'function') {
    onDeviceOfflineStopCallback = hooks.onDeviceOfflineStop;
  }
  if (typeof hooks.onDeviceOnlineResume === 'function') {
    onDeviceOnlineResumeCallback = hooks.onDeviceOnlineResume;
  }
  if (typeof hooks.onInitialTelemetryLoaded === 'function') {
    onInitialTelemetryCallback = hooks.onInitialTelemetryLoaded;
    initialTelemetryLoaded = false;
  }
  if (typeof hooks.WebSocket === 'function') {
    WebSocketCtor = hooks.WebSocket;
    clearWsReconnectTimer();
    clearWsKeepaliveTimers();
    resetServiceVersionChecks();
    wsReconnectAttempts = 0;
    wsHasEverDisconnected = false;
    wsOutageWarned = false;
    wsOutageErrorLogged = false;
  }
}

/**
 * Computes the next WebSocket reconnect delay in milliseconds using bounded exponential backoff
 * (`10s` initial, `20s`, `40s`, up to `60s` max) with jitter.
 *
 * @param {number} [attempt=0] - Zero-based consecutive failed reconnect attempt counter.
 * @param {() => number} [randomFn=Math.random] - Uniform `[0, 1)` random generator.
 * @returns {number}
 */
function computeWsReconnectDelayMs(attempt = 0, randomFn = Math.random) {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const rand = Math.min(1, Math.max(0, Number(randomFn()) || 0));
  if (safeAttempt === 0) {
    return WS_RECONNECT_DELAY_MS + Math.round(rand * WS_RECONNECT_INITIAL_JITTER_MS);
  }
  const expDelay = Math.min(
    WS_RECONNECT_MAX_DELAY_MS,
    WS_RECONNECT_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** safeAttempt
  );
  const centered = (rand - WS_RECONNECT_JITTER_MIDPOINT) * WS_RECONNECT_JITTER_SCALE;
  const jittered = Math.round(expDelay * (1 + centered * WS_RECONNECT_JITTER_RATIO));
  return Math.min(WS_RECONNECT_MAX_DELAY_MS, Math.max(WS_RECONNECT_DELAY_MS, jittered));
}

function clearWsHandshakeTimer() {
  if (wsHandshakeTimer) {
    clearTimeout(wsHandshakeTimer);
    wsHandshakeTimer = null;
  }
}

function clearWsPongTimeoutTimer() {
  if (wsPongTimeoutTimer) {
    clearTimeout(wsPongTimeoutTimer);
    wsPongTimeoutTimer = null;
  }
}

function clearWsKeepaliveTimers() {
  clearWsHandshakeTimer();
  clearWsPongTimeoutTimer();
  if (wsPingTimer) {
    clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
  awaitingPong = false;
}

/**
 * Terminates a stalled or half-open WebSocket immediately, falling back to close() on minimal test stubs.
 *
 * @param {WsSocketLike} socket - Target socket instance.
 */
function terminateWsSocket(socket) {
  try {
    if (typeof socket.terminate === 'function') {
      socket.terminate();
    } else if (typeof socket.close === 'function') {
      socket.close();
    }
  } catch (err) {
    // Ignore errors terminating an already-closing socket.
  }
}

/**
 * Records inbound frame activity (pong or JSON message) on socket so keepalive checks stay satisfied.
 *
 * @param {WsSocketLike} socket - Active socket instance.
 */
function noteWsSocketInbound(socket) {
  if (socket === ws) {
    awaitingPong = false;
    clearWsPongTimeoutTimer();
  }
}

/**
 * Starts a 10s watchdog requiring the initial 'version' frame after connectWs() opens a socket.
 *
 * @param {WsSocketLike} socket - Newly created WebSocket instance.
 */
function startWsHandshakeTimer(socket) {
  clearWsHandshakeTimer();
  wsHandshakeTimer = setTimeout(() => {
    wsHandshakeTimer = null;
    if (socket === ws && !wsReady) {
      log.warn('bridge', 'eufy-security-ws version handshake timed out after 10 s, reconnecting');
      terminateWsSocket(socket);
    }
  }, WS_HANDSHAKE_TIMEOUT_MS);
  if (wsHandshakeTimer && typeof wsHandshakeTimer.unref === 'function') {
    wsHandshakeTimer.unref();
  }
}

/**
 * Starts periodic 30s WebSocket ping probes with a 10s pong/message timeout to detect half-open sockets.
 *
 * @param {WsSocketLike} socket - Open WebSocket instance.
 */
function startWsKeepaliveLoop(socket) {
  if (typeof socket.ping !== 'function') {
    return;
  }
  if (wsPingTimer) {
    clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
  awaitingPong = false;
  wsPingTimer = setInterval(() => {
    if (socket !== ws || socket.readyState !== WS_OPEN || typeof socket.ping !== 'function') {
      return;
    }
    awaitingPong = true;
    clearWsPongTimeoutTimer();
    wsPongTimeoutTimer = setTimeout(() => {
      wsPongTimeoutTimer = null;
      if (socket === ws && awaitingPong) {
        log.warn('bridge', 'eufy-security-ws keepalive ping timed out after 10 s, reconnecting');
        terminateWsSocket(socket);
      }
    }, WS_PONG_TIMEOUT_MS);
    if (wsPongTimeoutTimer && typeof wsPongTimeoutTimer.unref === 'function') {
      wsPongTimeoutTimer.unref();
    }
    try {
      socket.ping();
    } catch (err) {
      terminateWsSocket(socket);
    }
  }, WS_PING_INTERVAL_MS);
  if (wsPingTimer && typeof wsPingTimer.unref === 'function') {
    wsPingTimer.unref();
  }
}

function clearWsReconnectTimer() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (initialTelemetryRetryTimer) {
    clearTimeout(initialTelemetryRetryTimer);
    initialTelemetryRetryTimer = null;
  }
}

/**
 * Schedules a jittered exponential reconnect timer when not shutting down and returns the rounded delay in seconds.
 *
 * @returns {number}
 */
function scheduleWsReconnect() {
  clearWsReconnectTimer();
  const delayMs = computeWsReconnectDelayMs(wsReconnectAttempts);
  wsReconnectAttempts += 1;
  const delaySecs = Math.round(delayMs / MS_PER_SECOND);
  if (isShuttingDownFn()) {
    return delaySecs;
  }
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, delayMs);
  if (wsReconnectTimer && typeof wsReconnectTimer.unref === 'function') {
    wsReconnectTimer.unref();
  }
  return delaySecs;
}

const isWsReady = () => wsReady;
const isInitialTelemetryLoaded = () => initialTelemetryLoaded;
const getCams = () => camsRef;
const isShuttingDown = () => isShuttingDownFn();
const getOfflineStopCallback = () => onDeviceOfflineStopCallback;
const getOnlineResumeCallback = () => onDeviceOnlineResumeCallback;
const invokeRecoverDriverAndStations = (reason) => onRecoverDriverAndStationsFn(reason);

/**
 * Returns the active WebSocket instance when it is currently in WS_OPEN state, or null otherwise.
 *
 * @returns {WsSocketLike|null}
 */
function getOpenWsSocket() {
  return ws && ws.readyState === WS_OPEN ? ws : null;
}

/**
 * Marks initial camera telemetry as loaded and fires the one-time startup callback when set.
 */
function markInitialTelemetryLoaded() {
  if (!initialTelemetryLoaded) {
    initialTelemetryLoaded = true;
    if (onInitialTelemetryCallback) {
      onInitialTelemetryCallback();
    }
  }
}

/**
 * Returns true when the WebSocket connection has been open and settled for at least settleMs.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} settleMs - Required post-connect settle window in milliseconds.
 * @returns {boolean}
 */
function isWsSettledForEvents(now, settleMs) {
  return wsReady && now - wsReadyAt > settleMs;
}

/**
 * Returns true when the WebSocket connection is ready, initial telemetry has loaded,
 * and the post-connect startup probe delay has elapsed.
 *
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} readyDelayMs - Required post-connect delay before startup probes.
 * @returns {boolean}
 */
function canRunStartupProbeNow(now, readyDelayMs) {
  return wsReady && initialTelemetryLoaded && now - wsReadyAt > readyDelayMs;
}

/**
 * Formats an eufy-security-ws RPC error response, combining errorCode with any diagnostic
 * message or error detail so generic errorCodes like 'unknown_error' do not hide root causes.
 *
 * @param {Record<string, *>|null|undefined} res - RPC response object from eufy-security-ws.
 * @returns {string}
 */
function formatRpcError(res) {
  const code = res && res.errorCode ? String(res.errorCode).trim() : '';
  const rawDetail = res ? res.message || res.error || '' : '';
  const detail = typeof rawDetail === 'string' ? rawDetail.trim() : rawDetail ? formatErrorMessage(rawDetail) : '';
  if (code && detail && detail !== code) {
    return code + ' (' + detail + ')';
  }
  return code || detail || 'unknown';
}

/**
 * Sends a command object to eufy-security-ws over WebSocket and resolves with the response message.
 *
 * @param {Record<string, *>} commandPayload - Command fields to send alongside the generated messageId.
 * @returns {Promise<Record<string, *>>} Response object from eufy-security-ws.
 */
function call(commandPayload) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WS_OPEN) {
      resolve({success: false, errorCode: 'ws_closed'});
      return;
    }
    rpcSequence += 1;
    const requestId = 'b' + rpcSequence;
    const timeoutTimer = setTimeout(() => {
      if (pendingRpcMap.delete(requestId)) {
        resolve({success: false, errorCode: 'no_reply'});
      }
    }, WS_RPC_TIMEOUT_MS);
    if (timeoutTimer && typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }
    pendingRpcMap.set(requestId, (responsePayload) => {
      clearTimeout(timeoutTimer);
      resolve(responsePayload);
    });
    const serializedCommand = JSON.stringify({messageId: requestId, ...commandPayload});
    ws.send(serializedCommand, (sendErr) => {
      if (sendErr && pendingRpcMap.delete(requestId)) {
        clearTimeout(timeoutTimer);
        resolve({success: false, errorCode: formatErrorMessage(sendErr)});
      }
    });
  });
}

/**
 * Ensures non-offline cameras have an active FFmpeg RTSP encoder (and updates wsConnected health
 * and status cards when specified).
 *
 * @param {{wsConnected?: boolean, rtspDirectOnly?: boolean}} [opts={}] - Startup options.
 */
function ensureCameraEncodersStarted(opts = {}) {
  const {wsConnected, rtspDirectOnly = false} = opts;
  for (const cam of camsRef) {
    if (rtspDirectOnly && !cam.isRtspDirect()) {
      continue;
    }
    const healthChanged = typeof wsConnected === 'boolean' && cam.updateServiceHealth({wsConnected});
    if (healthChanged) {
      renderCameraCards(cam);
    }
    if (!cam.isDeviceOffline() && !cam.hasEncoderProcess() && onDeviceOnlineResumeCallback) {
      onDeviceOnlineResumeCallback(cam);
    } else if (healthChanged) {
      pushFrameToEncoder(cam);
    }
  }
}

/**
 * Returns true when a non-direct camera still lacks battery telemetry, shows disruption, or lacks RTSP URL.
 *
 * @param {Camera} cam - Camera domain instance.
 * @returns {boolean}
 */
function needsInitialTelemetryRetry(cam) {
  return (
    !cam.isRtspDirect() &&
    (!cam.hasBatteryReading() ||
      cam.hasServiceDisruption() ||
      (cam.isRtspEnabled() && !cam.isDoorbell() && !cam.getRtspUrl()))
  );
}

/**
 * Handles the initial 'version' message from eufy-security-ws by negotiating schema version
 * and starting event listening.
 *
 * @param {Record<string, *>} m - Parsed 'version' message from eufy-security-ws.
 */
async function handleVersionMessage(m) {
  clearWsHandshakeTimer();
  validateEufyWsVersion(m);
  const rawMaxSchema = Number(m.maxSchemaVersion);
  const targetSchema = Number.isFinite(rawMaxSchema)
    ? Math.min(rawMaxSchema, MAX_SUPPORTED_API_SCHEMA)
    : MAX_SUPPORTED_API_SCHEMA;
  await call({command: 'set_api_schema', schemaVersion: targetSchema});
  const st = await call({command: 'start_listening'});
  wsReady = Boolean(st.success);
  wsReadyAt = Date.now();
  for (const c of camsRef) {
    if (c.updateServiceHealth({wsConnected: wsReady})) {
      renderCameraCards(c);
      pushFrameToEncoder(c);
    }
  }

  if (!wsReady) {
    wsHasEverDisconnected = true;
    const retrySecs = scheduleWsReconnect();
    log.error(
      'bridge',
      'start_listening failed (' + formatRpcError(st) + '), retrying connection in ' + retrySecs + ' s'
    );
    ensureCameraEncodersStarted({wsConnected: false});
    return;
  }

  wsReconnectAttempts = 0;
  const listenMsg = wsHasEverDisconnected
    ? 'eufy-security-ws reconnected, listening for eufy events (apiSchema=' + targetSchema + ')'
    : 'listening for eufy events (apiSchema=' + targetSchema + ')';
  wsHasEverDisconnected = false;
  wsOutageWarned = false;
  wsOutageErrorLogged = false;
  log.info('bridge', listenMsg);
  const stateSnapshot = (st.result && st.result.state) || {};
  await onEnsureInitialConnectedFn(stateSnapshot);
  await onFetchAllTelemetryFn();
  const devices = stateSnapshot.devices || [];
  for (const dev of devices) {
    if (dev && typeof dev === 'object' && dev.serialNumber) {
      const cam = bySerialRef.get(dev.serialNumber);
      if (cam && !cam.isRtspDirect() && !cam.hasBatteryReading() && !cam.isDeviceOffline()) {
        onApplyDevicePropertiesFn(cam, dev, true);
      }
    }
  }
  if (initialTelemetryRetryTimer) {
    clearTimeout(initialTelemetryRetryTimer);
  }
  initialTelemetryRetryTimer = setTimeout(() => {
    initialTelemetryRetryTimer = null;
    if (wsReady && camsRef.some(needsInitialTelemetryRetry)) {
      void onFetchAllTelemetryFn();
    }
  }, INITIAL_TELEMETRY_RETRY_MS);
  if (initialTelemetryRetryTimer && typeof initialTelemetryRetryTimer.unref === 'function') {
    initialTelemetryRetryTimer.unref();
  }
}

/**
 * Rejects all in-flight RPC requests with ws_closed when the WebSocket disconnects or resets.
 */
function failPendingRpcRequests() {
  for (const [requestId, resolveRpc] of pendingRpcMap) {
    pendingRpcMap.delete(requestId);
    resolveRpc({success: false, errorCode: 'ws_closed'});
  }
}

/**
 * Establishes and maintains the WebSocket connection to eufy-security-ws.
 *
 * @returns {void}
 */
function connectWs() {
  clearWsReconnectTimer();
  clearWsKeepaliveTimers();
  if (isShuttingDownFn()) {
    return;
  }
  ensureCameraEncodersStarted({rtspDirectOnly: true});
  if (!cfg.eufy_security_ws_url || (camsRef.length > 0 && camsRef.every((c) => c.isRtspDirect()))) {
    log.info('bridge', 'skipping eufy-security-ws connection (all cameras specify direct rtsp_url)');
    markInitialTelemetryLoaded();
    return;
  }
  const prevWs = ws;
  ws = null;
  if (prevWs && typeof prevWs.close === 'function') {
    try {
      prevWs.close();
    } catch (err) {
      // Ignore errors closing a superseded socket.
    }
  }
  stations.resetRecovery();
  onResetPropertyChainsFn();
  failPendingRpcRequests();
  const WebSocket = getWebSocketConstructor();
  let socket;
  try {
    socket = new WebSocket(cfg.eufy_security_ws_url, {handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS});
  } catch (err) {
    wsReady = Boolean(false);
    wsHasEverDisconnected = true;
    const retrySecs = scheduleWsReconnect();
    const errMsg = formatErrorMessage(err);
    const logConnectErr = !wsOutageErrorLogged ? log.error : log.debug;
    wsOutageErrorLogged = true;
    logConnectErr('bridge', 'eufy-security-ws connect failed (' + errMsg + '), retrying in ' + retrySecs + ' s');
    ensureCameraEncodersStarted({wsConnected: false});
    return;
  }
  ws = socket;
  startWsHandshakeTimer(socket);

  socket.on('open', () => {
    if (socket !== ws) {
      return;
    }
    log.debug('bridge', 'eufy-security-ws connected (' + cfg.eufy_security_ws_url + ')');
    startWsKeepaliveLoop(socket);
  });

  socket.on('pong', () => noteWsSocketInbound(socket));

  socket.on('close', () => {
    if (socket !== ws) {
      return;
    }
    clearWsKeepaliveTimers();
    wsReady = Boolean(false);
    wsHasEverDisconnected = true;
    initialTelemetryLoaded = false;
    stations.resetRecovery();
    onResetPropertyChainsFn();
    failPendingRpcRequests();
    const retrySecs = scheduleWsReconnect();
    const logClose = !wsOutageWarned ? log.warn : log.debug;
    wsOutageWarned = true;
    logClose('bridge', 'eufy-security-ws connection closed, retrying in ' + retrySecs + ' s');
    for (const c of camsRef) {
      const healthChanged = c.updateServiceHealth({wsConnected: false});
      if (c.handleStationDisconnected('ws_closed') && onWsClosedStopCallback) {
        onWsClosedStopCallback(c);
      } else if (!c.isDeviceOffline() && !c.hasEncoderProcess() && onDeviceOnlineResumeCallback) {
        if (healthChanged) {
          renderCameraCards(c);
        }
        onDeviceOnlineResumeCallback(c);
      } else if (healthChanged) {
        renderCameraCards(c);
        pushFrameToEncoder(c);
      }
    }
  });

  socket.on('error', (err) => {
    if (socket === ws) {
      const logWsErr = !wsOutageErrorLogged ? log.error : log.debug;
      wsOutageErrorLogged = true;
      logWsErr('bridge', 'eufy-security-ws error: ' + formatErrorMessage(err));
    }
  });

  socket.on('message', async (rawFrame) => {
    noteWsSocketInbound(socket);
    let parsedMsg;
    try {
      parsedMsg = JSON.parse(String(rawFrame));
    } catch (err) {
      log.warn('bridge', 'ignoring malformed eufy-security-ws message (' + formatErrorMessage(err) + ')');
      return;
    }

    switch (parsedMsg.type) {
      case 'version':
        try {
          await handleVersionMessage(parsedMsg);
        } catch (err) {
          log.error('bridge', 'unhandled error in version handshake: ' + formatErrorMessage(err, true));
        }
        break;
      case 'result':
        if (parsedMsg.messageId) {
          const resolvePending = pendingRpcMap.get(parsedMsg.messageId);
          if (resolvePending) {
            pendingRpcMap.delete(parsedMsg.messageId);
            resolvePending(parsedMsg);
          }
        }
        break;
      case 'event':
        if (onEventCallback) {
          try {
            onEventCallback(parsedMsg.event || {});
          } catch (err) {
            log.error('bridge', 'unhandled error in onEvent: ' + formatErrorMessage(err, true));
          }
        }
        break;
      default:
        break;
    }
  });
}

/**
 * Stops the active Eufy WebSocket connection, clears reconnect/retry timers, and fails pending RPCs.
 */
function stopWsClient() {
  clearWsReconnectTimer();
  clearWsKeepaliveTimers();
  wsReconnectAttempts = 0;
  wsReady = false;
  const activeWs = ws;
  ws = null;
  failPendingRpcRequests();
  if (activeWs && typeof activeWs.close === 'function') {
    try {
      activeWs.close();
    } catch (err) {
      // Ignore errors closing socket during shutdown.
    }
  }
}

module.exports = {
  registerEufySubsystems,
  configureEufyClientHooks,
  isWsReady,
  isInitialTelemetryLoaded,
  isWsSettledForEvents,
  canRunStartupProbeNow,
  getCams,
  isShuttingDown,
  getOfflineStopCallback,
  getOnlineResumeCallback,
  getOpenWsSocket,
  markInitialTelemetryLoaded,
  invokeRecoverDriverAndStations,
  formatRpcError,
  computeWsReconnectDelayMs,
  call,
  ensureCameraEncodersStarted,
  connectWs,
  stopWsClient,
};
