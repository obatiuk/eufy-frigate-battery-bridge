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
 *   on: (event: string, listener: (...args: *[]) => void) => void,
 * }} WsSocketLike
 */
/** @typedef {new (url: string) => WsSocketLike} WsSocketConstructor */

const WS_OPEN = 1;
const WS_RPC_TIMEOUT_MS = 20000;
const WS_RECONNECT_DELAY_MS = 10000;
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
/** @type {ReturnType<typeof setTimeout>|null} */
let wsReconnectTimer = null;
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
    resetServiceVersionChecks();
    wsHasEverDisconnected = false;
    wsOutageWarned = false;
    wsOutageErrorLogged = false;
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

function scheduleWsReconnect() {
  clearWsReconnectTimer();
  if (isShuttingDownFn()) {
    return;
  }
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, WS_RECONNECT_DELAY_MS);
  if (wsReconnectTimer && typeof wsReconnectTimer.unref === 'function') {
    wsReconnectTimer.unref();
  }
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
    log.error('bridge', 'start_listening failed (' + formatRpcError(st) + '), retrying connection in 10 s');
    ensureCameraEncodersStarted({wsConnected: false});
    scheduleWsReconnect();
    return;
  }

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
    socket = new WebSocket(cfg.eufy_security_ws_url);
  } catch (err) {
    wsReady = Boolean(false);
    wsHasEverDisconnected = true;
    const errMsg = formatErrorMessage(err);
    const logConnectErr = !wsOutageErrorLogged ? log.error : log.debug;
    wsOutageErrorLogged = true;
    logConnectErr('bridge', 'eufy-security-ws connect failed (' + errMsg + '), retrying in 10 s');
    ensureCameraEncodersStarted({wsConnected: false});
    scheduleWsReconnect();
    return;
  }
  ws = socket;

  socket.on('open', () => log.debug('bridge', 'eufy-security-ws connected (' + cfg.eufy_security_ws_url + ')'));

  socket.on('close', () => {
    if (socket !== ws) {
      return;
    }
    wsReady = Boolean(false);
    wsHasEverDisconnected = true;
    initialTelemetryLoaded = false;
    stations.resetRecovery();
    onResetPropertyChainsFn();
    failPendingRpcRequests();
    const logClose = !wsOutageWarned ? log.warn : log.debug;
    wsOutageWarned = true;
    logClose('bridge', 'eufy-security-ws connection closed, retrying in 10 s');
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
    scheduleWsReconnect();
  });

  socket.on('error', (err) => {
    if (socket === ws) {
      const logWsErr = !wsOutageErrorLogged ? log.error : log.debug;
      wsOutageErrorLogged = true;
      logWsErr('bridge', 'eufy-security-ws error: ' + formatErrorMessage(err));
    }
  });

  socket.on('message', async (rawFrame) => {
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
  call,
  ensureCameraEncodersStarted,
  connectWs,
  stopWsClient,
};
