// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * eufy-security-ws WebSocket RPC client, schema negotiation, device telemetry
 * synchronization, streaming quality enforcement, and battery swap polling.
 */
'use strict';

const {
  cfg,
  ENFORCE_QUALITY,
  FORWARD_FACE_NAMES,
  TELEMETRY_POLL_MS,
} = require('../config');
const {log} = require('../logger');
const {isLowBattery, clearViewerQueue} = require('../domain/camera');
const {unwrapProperty, parseChargingState, rssiToWifiSignalLevel} = require('../domain/telemetry');
const {renderCameraCards} = require('../overlay/card-renderer');
const {pushFrameToEncoder} = require('../media/encoder');
const {startRtspDecoder} = require('../media/decoder');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WS_OPEN = 1;
let WebSocketCtor = null;

/**
 * Lazily loads the 'ws' WebSocket constructor (or returns an injected constructor).
 *
 * @returns {Function}
 */
function getWebSocketConstructor() {
  if (!WebSocketCtor) {
    WebSocketCtor = require('ws');
  }
  return WebSocketCtor;
}

const TRACKED_PROPERTY_NAMES = new Set([
  'battery',
  'batteryLevel',
  'chargingStatus',
  'batteryIsCharging',
  'powerSource',
  'wifiSignalLevel',
  'wifiRssi',
  'cellularSignalLevel',
  'cellularRSSI',
  'batteryTemperature',
  'temperature',
  'videoStreamingQuality',
  'rtspStream',
  'rtspStreamUrl',
]);

let ws = null;
let wsReady = false;
let wsReadyAt = 0;
let initialTelemetryLoaded = false;
let seq = 0;
const waiting = new Map();

let camsRef = [];
let bySerialRef = new Map();
let isShuttingDownFn = () => false;
let onEventCallback = null;
let onWsClosedStopCallback = null;
let onInitialTelemetryCallback = null;

/**
 * Configures runtime references and lifecycle callbacks for the Eufy WebSocket client.
 *
 * @param {Record<string, *>} hooks - Client wiring options.
 */
function configureEufyClientHooks(hooks = {}) {
  if (Array.isArray(hooks.cams)) camsRef = hooks.cams;
  if (hooks.bySerial instanceof Map) bySerialRef = hooks.bySerial;
  if (typeof hooks.isShuttingDown === 'function') isShuttingDownFn = hooks.isShuttingDown;
  if (typeof hooks.onEvent === 'function') onEventCallback = hooks.onEvent;
  if (typeof hooks.onWsClosedStop === 'function') onWsClosedStopCallback = hooks.onWsClosedStop;
  if (typeof hooks.onInitialTelemetryLoaded === 'function') {
    onInitialTelemetryCallback = hooks.onInitialTelemetryLoaded;
  }
  if (typeof hooks.WebSocket === 'function') {
    WebSocketCtor = hooks.WebSocket;
  }
}

const isWsReady = () => wsReady;
const getWsReadyAt = () => wsReadyAt;
const isInitialTelemetryLoaded = () => initialTelemetryLoaded;

/**
 * Returns true if a Eufy 'property changed' event name is tracked by the bridge.
 *
 * @param {string} propName - Property name from Eufy event.
 * @returns {boolean}
 */
function isTrackedPropertyEvent(propName) {
  return TRACKED_PROPERTY_NAMES.has(propName);
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
      return resolve({success: false, errorCode: 'ws_closed'});
    }
    const id = 'b' + ++seq;
    const timer = setTimeout(() => {
      if (waiting.delete(id)) {
        resolve({success: false, errorCode: 'no_reply'});
      }
    }, 20000);
    waiting.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    ws.send(JSON.stringify({messageId: id, ...commandPayload}), (err) => {
      if (err && waiting.delete(id)) {
        clearTimeout(timer);
        resolve({success: false, errorCode: err.message});
      }
    });
  });
}

/**
 * Checks the camera's videoStreamingQuality property and, if enforce_streaming_quality is enabled,
 * automatically switches cameras configured as "Auto" (0) to Medium (7, 1280x720) so P2P streams
 * do not negotiate 4K and stall.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties.
 */
function checkStreamingQuality(cam, props) {
  if (!ENFORCE_QUALITY || cam.qualityChecked || !props || !('videoStreamingQuality' in props)) {
    return;
  }
  const currentQuality = Number(unwrapProperty(props.videoStreamingQuality));
  if (Number.isNaN(currentQuality)) {
    return;
  }
  cam.qualityChecked = true;

  const isDoorbellT8214 = /^T8214/i.test(cam.serial || '');
  if (ENFORCE_QUALITY === true && isDoorbellT8214) {
    return;
  }
  const targetQuality = typeof ENFORCE_QUALITY === 'number' ? ENFORCE_QUALITY : 7;
  const shouldUpdate =
      typeof ENFORCE_QUALITY === 'number' ? currentQuality !== targetQuality : currentQuality === 0;

  if (shouldUpdate) {
    log.info(
        cam,
        'videoStreamingQuality is ' +
        currentQuality +
        ' (Auto), setting to ' +
        targetQuality +
        ' (Medium 720p) to prevent P2P stalls'
    );
    call({
      command: 'device.set_property',
      serialNumber: cam.serial,
      name: 'videoStreamingQuality',
      value: targetQuality,
    }).then((res) => {
      if (!res.success) {
        const logFn = res.errorCode === 'device_invalid_property_value' ? log.debug : log.warn;
        logFn(cam, 'could not set videoStreamingQuality: ' + (res.errorCode || 'unknown'));
      }
    });
  }
}

/**
 * Applies RTSP URL discovery and automatic rtspStream property enabling from device properties.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {*} stationSn - Unwrapped stationSerialNumber.
 * @param {*} rtspUrlProp - Unwrapped rtspStreamUrl.
 * @param {*} rtspStreamProp - Unwrapped rtspStream boolean.
 */
function syncCameraRtspProperties(cam, stationSn, rtspUrlProp, rtspStreamProp) {
  if (stationSn && typeof stationSn === 'string') {
    cam.stationSerial = stationSn;
  }
  if (rtspUrlProp && typeof rtspUrlProp === 'string' && !cam.rtsp_url) {
    if (cam.rtspUrl !== rtspUrlProp) {
      cam.rtspUrl = rtspUrlProp;
      cam.rtspSupported = true;
      const maskedUrl = rtspUrlProp.replace(/:\/\/[^@]+@/, '://***@');
      log.info(cam, 'discovered HomeBase RTSP URL (' + maskedUrl + ')');
      if (cam.active && cam.activeMode === 'rtsp' && !cam.dec) {
        startRtspDecoder(cam, cam.rtspUrl);
      }
    }
  }
  if (cam.useRtsp && cam.rtspUrl && !cam.rtspEnabledChecked && rtspStreamProp === false) {
    cam.rtspEnabledChecked = true;
    log.info(cam, 'enabling HomeBase RTSP stream (rtspStream=true) via eufy-security-ws');
    call({
      command: 'device.set_property',
      serialNumber: cam.serial,
      name: 'rtspStream',
      value: true,
    }).then((res) => {
      if (!res.success) {
        log.warn(cam, 'could not set rtspStream property: ' + (res.errorCode || 'unknown'));
      }
    });
  }
}

/**
 * Applies device telemetry properties from eufy-security-ws to a camera's Telemetry domain model.
 *
 * @param {Record<string, *>} cam - Camera domain instance.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties or start_listening.
 * @param {boolean} [allowCardRebuild=false] - Whether to re-render the sleeping card immediately.
 */
function applyDeviceProperties(cam, props, allowCardRebuild = false) {
  if (!props || typeof props !== 'object') {
    return;
  }

  checkStreamingQuality(cam, props);
  syncCameraRtspProperties(
      cam,
      unwrapProperty(props.stationSerialNumber),
      unwrapProperty(props.rtspStreamUrl),
      unwrapProperty(props.rtspStream)
  );

  const {
    hadInitialTelemetry,
    prevBattery,
    nowLowBat,
    stateChanged,
    minorTelemetryChanged,
    model,
    swVer,
  } = cam.telemetry.applyProperties(props);

  if (!hadInitialTelemetry && cam.battery !== null) {
    const hwInfo = model || swVer ? 'model=' + (model || 'n/a') + ', fw=' + (swVer || 'n/a') + ', ' : '';
    const pwrMode = cam.powerLabel || (nowLowBat ? 'battery [ECO]' : 'battery');
    log.info(
        cam,
        'telemetry loaded (' +
        hwInfo +
        'battery=' +
        cam.battery +
        '%, power=' +
        pwrMode +
        ', wifi=' +
        (cam.wifi ?? 'n/a') +
        '/4, rssi=' +
        (cam.rssi ?? 'n/a') +
        'dBm, temp=' +
        (cam.temp ?? 'n/a') +
        '°C)'
    );
  } else if (stateChanged) {
    const ecoStatus = nowLowBat ? 'entered low-battery economy mode' : 'normal mode restored';
    log.info(
        cam,
        'battery state updated (' +
        (prevBattery ?? 'n/a') +
        '% -> ' +
        cam.battery +
        '%, power=' +
        (cam.powerLabel || 'battery') +
        ', ' +
        ecoStatus +
        ')'
    );
  } else if (minorTelemetryChanged) {
    log.debug(
        cam,
        'telemetry updated (battery=' +
        (cam.battery ?? 'n/a') +
        '%, power=' +
        (cam.powerLabel || 'battery') +
        ', wifi=' +
        (cam.wifi ?? 'n/a') +
        '/4, rssi=' +
        (cam.rssi ?? 'n/a') +
        'dBm, temp=' +
        (cam.temp ?? 'n/a') +
        '°C)'
    );
  }

  if (allowCardRebuild || !hadInitialTelemetry || stateChanged) {
    renderCameraCards(cam);
    pushFrameToEncoder(cam);
  }
}

/**
 * Queries device.get_properties for all configured cameras so battery, charging/power mode,
 * Wi-Fi signal/RSSI, temperature, and streaming quality are populated on API schema 13+.
 *
 * @param {boolean} [forceRefresh=false] - Whether to force a driver.poll_refresh before reading properties.
 */
async function fetchAllCameraTelemetry(forceRefresh = false) {
  if (!wsReady) {
    return;
  }
  if (forceRefresh || camsRef.some((c) => isLowBattery(c))) {
    log.debug('bridge', 'polling HomeBase via driver.poll_refresh for fresh battery telemetry');
    await call({command: 'driver.poll_refresh'});
    await sleep(2000);
  }
  for (const cam of camsRef) {
    if (!wsReady) {
      return;
    }
    const res = await call({command: 'device.get_properties', serialNumber: cam.serial});
    if (res.success && res.result && res.result.properties) {
      applyDeviceProperties(cam, res.result.properties, cam.battery === null);
    } else if (!res.success) {
      log.warn(cam, 'device.get_properties failed: ' + (res.errorCode || 'unknown'));
    }
  }
  if (!initialTelemetryLoaded) {
    initialTelemetryLoaded = true;
    if (onInitialTelemetryCallback) {
      onInitialTelemetryCallback();
    }
  }
}

/**
 * Handles the initial 'version' message from eufy-security-ws by negotiating schema version
 * and starting event listening.
 *
 * @param {Record<string, *>} m - Parsed 'version' message from eufy-security-ws.
 */
async function handleVersionMessage(m) {
  const targetSchema = Math.min(m.maxSchemaVersion, 21);
  await call({command: 'set_api_schema', schemaVersion: targetSchema});
  const st = await call({command: 'start_listening'});
  wsReady = Boolean(st.success);
  wsReadyAt = Date.now();

  if (!wsReady) {
    log.error('bridge', 'start_listening failed: ' + (st.errorCode || 'unknown'));
    return;
  }

  log.info('bridge', 'listening for eufy events (apiSchema=' + targetSchema + ')');
  const devices = (st.result && st.result.state && st.result.state.devices) || [];
  for (const dev of devices) {
    if (dev && typeof dev === 'object' && dev.serialNumber) {
      const cam = bySerialRef.get(dev.serialNumber);
      if (cam) {
        applyDeviceProperties(cam, dev, true);
      }
    }
  }
  await fetchAllCameraTelemetry();
  setTimeout(() => {
    if (wsReady && camsRef.some((c) => c.battery === null)) {
      void fetchAllCameraTelemetry();
    }
  }, 10000);
}

/**
 * Establishes and maintains the WebSocket connection to eufy-security-ws.
 */
function connectWs() {
  if (isShuttingDownFn()) {
    return;
  }
  const WebSocket = getWebSocketConstructor();
  ws = new WebSocket(cfg.eufy_ws);

  ws.on('open', () => log.info('bridge', 'eufy-security-ws connected (' + cfg.eufy_ws + ')'));

  ws.on('close', () => {
    wsReady = false;
    initialTelemetryLoaded = false;
    for (const [id, resolve] of waiting) {
      waiting.delete(id);
      resolve({success: false, errorCode: 'ws_closed'});
    }
    log.warn('bridge', 'eufy-security-ws connection closed, retrying in 10 s');
    for (const c of camsRef) {
      c.motionUntil = 0;
      clearViewerQueue(c, 'ws_closed');
      if (c.active && onWsClosedStopCallback) {
        onWsClosedStopCallback(c);
      }
    }
    if (!isShuttingDownFn()) {
      setTimeout(connectWs, 10000);
    }
  });

  ws.on('error', (e) => log.error('bridge', 'eufy-security-ws error: ' + e.message));

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch (err) {
      return;
    }

    switch (m.type) {
      case 'version':
        await handleVersionMessage(m);
        break;
      case 'result':
        if (m.messageId) {
          const r = waiting.get(m.messageId);
          if (r) {
            waiting.delete(m.messageId);
            r(m);
          }
        }
        break;
      case 'event':
        if (onEventCallback) {
          try {
            onEventCallback(m.event || {});
          } catch (err) {
            log.error('bridge', 'unhandled error in onEvent: ' + err.message);
          }
        }
        break;
      default:
        break;
    }
  });
}

/**
 * Starts the periodic background telemetry refresh timer if telemetry_poll_secs > 0.
 */
function startTelemetryPoller() {
  if (TELEMETRY_POLL_MS > 0) {
    setInterval(() => {
      if (wsReady && !isShuttingDownFn()) {
        void fetchAllCameraTelemetry(false);
      }
    }, TELEMETRY_POLL_MS);
  }
}

/**
 * Extracts a recognized person's name from an Eufy event payload (such as 'identity person detected'
 * on HomeBase 3) when forward_face_names is enabled.
 *
 * @param {Record<string, *>} e - Event object from eufy-security-ws.
 * @param {boolean} [forwardEnabled=FORWARD_FACE_NAMES] - Whether face name forwarding is enabled.
 * @returns {string} Recognized person name, or empty string if unknown/disabled.
 */
function extractRecognizedPerson(e, forwardEnabled = FORWARD_FACE_NAMES) {
  if (!forwardEnabled || !e) {
    return '';
  }
  const rawName = e.person || e.personName || '';
  if (typeof rawName !== 'string') {
    return '';
  }
  const cleaned = rawName.trim();
  if (!cleaned || /^unknown$/i.test(cleaned) || /^stranger$/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

module.exports = {
  configureEufyClientHooks,
  isWsReady,
  getWsReadyAt,
  isInitialTelemetryLoaded,
  isTrackedPropertyEvent,
  call,
  unwrapProperty,
  parseChargingState,
  rssiToWifiSignalLevel,
  checkStreamingQuality,
  syncCameraRtspProperties,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  handleVersionMessage,
  connectWs,
  startTelemetryPoller,
  extractRecognizedPerson,
};
