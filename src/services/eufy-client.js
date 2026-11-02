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

const WebSocket = require('ws');
const {
  cfg,
  ENFORCE_QUALITY,
  FORWARD_FACE_NAMES,
  TELEMETRY_POLL_MS,
} = require('../config');
const {log} = require('../logger');
const {isLowBattery, clearViewerQueue} = require('../domain/camera');
const {renderCameraCards} = require('../overlay/card-renderer');
const {pushFrameToEncoder} = require('../media/encoder');
const {startRtspDecoder} = require('../media/decoder');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
}

/**
 * Returns true if the eufy-security-ws WebSocket is connected and start_listening succeeded.
 *
 * @returns {boolean}
 */
const isWsReady = () => wsReady;

/**
 * Returns the epoch timestamp when start_listening last succeeded.
 *
 * @returns {number}
 */
const getWsReadyAt = () => wsReadyAt;

/**
 * Returns true once initial device telemetry has been queried across all cameras.
 *
 * @returns {boolean}
 */
const isInitialTelemetryLoaded = () => initialTelemetryLoaded;

/**
 * Sends a command object to eufy-security-ws over WebSocket and resolves with the response message.
 * Times out after 20 seconds or resolves immediately with an error if the socket is closed.
 *
 * @param {Record<string, *>} commandPayload - Command fields to send alongside the generated messageId.
 * @returns {Promise<Record<string, *>>} Response object from eufy-security-ws.
 */
function call(commandPayload) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return resolve({success: false, errorCode: 'ws_closed'});
    }
    const id = 'b' + ++seq;
    const timer = setTimeout(() => {
      if (waiting.delete(id)) resolve({success: false, errorCode: 'no_reply'});
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
 * Unwraps a property value returned by eufy-security-ws, handling both direct values
 * (API schema 10+) and metadata-wrapped { value } objects (older schemas).
 *
 * @param {*} prop - Raw property entry from eufy-security-ws.
 * @returns {*} Unwrapped primitive or object value.
 */
function unwrapProperty(prop) {
  return prop !== null && typeof prop === 'object' && 'value' in prop ? prop.value : prop;
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
  if (!ENFORCE_QUALITY || cam.qualityChecked || !props || !('videoStreamingQuality' in props)) return;
  const currentQuality = Number(unwrapProperty(props.videoStreamingQuality));
  if (Number.isNaN(currentQuality)) return;
  cam.qualityChecked = true;

  const targetQuality = typeof ENFORCE_QUALITY === 'number' ? ENFORCE_QUALITY : 7;
  const shouldUpdate = typeof ENFORCE_QUALITY === 'number' ? currentQuality !== targetQuality : currentQuality === 0;

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
        log.warn(cam, 'could not set videoStreamingQuality: ' + (res.errorCode || 'unknown'));
      }
    });
  }
}

/**
 * Applies device telemetry properties (battery, chargingStatus, powerSource, wifiSignalLevel,
 * wifiRssi, and batteryTemperature) from eufy-security-ws to a camera's state.
 * Intentionally ignores props.picture because eufy-security-client on HomeBase 2/3 can populate
 * picture with the last notification thumbnail from a different camera on the same station.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} props - Properties dictionary from device.get_properties or start_listening.
 * @param {boolean} [allowCardRebuild=false] - Whether to re-render the sleeping card immediately.
 */
function applyDeviceProperties(cam, props, allowCardRebuild = false) {
  if (!props || typeof props !== 'object') return;

  checkStreamingQuality(cam, props);

  const hadInitialTelemetry = cam.battery !== null;
  const prevBattery = cam.battery;
  const prevCharging = cam.charging;
  const prevWifi = cam.wifi;
  const prevRssi = cam.rssi;
  const prevTemp = cam.temp;
  const wasLowBat = isLowBattery(cam);

  const bat = unwrapProperty(props.battery ?? props.batteryLevel);
  const chgStatus = unwrapProperty(props.chargingStatus);
  const chgBool = unwrapProperty(props.batteryIsCharging);
  const pwrSrc = unwrapProperty(props.powerSource);
  const wifi = unwrapProperty(props.wifiSignalLevel ?? props.cellularSignalLevel);
  const rssi = unwrapProperty(props.wifiRssi ?? props.cellularRSSI);
  const temp = unwrapProperty(props.batteryTemperature ?? props.temperature);
  const model = unwrapProperty(props.model);
  const swVer = unwrapProperty(props.softwareVersion);
  const stationSn = unwrapProperty(props.stationSerialNumber);
  const rtspUrlProp = unwrapProperty(props.rtspStreamUrl);
  const rtspStreamProp = unwrapProperty(props.rtspStream);

  if (stationSn && typeof stationSn === 'string') {
    cam.stationSerial = stationSn;
  }
  if (rtspUrlProp && typeof rtspUrlProp === 'string' && !cam.rtsp_url) {
    if (cam.rtspUrl !== rtspUrlProp) {
      cam.rtspUrl = rtspUrlProp;
      cam.rtspSupported = true;
      log.info(cam, 'discovered HomeBase RTSP URL (' + rtspUrlProp.replace(/:\/\/[^@]+@/, '://***@') + ')');
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

  if (bat !== undefined && bat !== null) {
    cam.battery = Number(bat);
  }

  if (chgStatus !== undefined && chgStatus !== null) {
    const code = Number(chgStatus);
    cam.charging = chgStatus === true || code === 1 || code === 3 || code === 4;
    cam.powerLabel = code === 4 ? 'Solar' : code === 3 ? 'Plugged' : cam.charging ? 'Charging' : '';
  } else if (chgBool !== undefined && chgBool !== null) {
    cam.charging = Boolean(chgBool);
    if (cam.charging && !cam.powerLabel) cam.powerLabel = 'Charging';
    if (!cam.charging) cam.powerLabel = '';
  }

  if (pwrSrc !== undefined && pwrSrc !== null && Number(pwrSrc) === 1 && !cam.powerLabel) {
    cam.powerLabel = 'Solar';
  }

  if (rssi !== undefined && rssi !== null && Number(rssi) < 0) {
    cam.rssi = Number(rssi);
  }

  if (wifi !== undefined && wifi !== null) {
    cam.wifi = Number(wifi);
  } else if (cam.wifi === null && cam.rssi !== null) {
    const dbm = cam.rssi;
    cam.wifi = dbm >= -60 ? 4 : dbm >= -70 ? 3 : dbm >= -80 ? 2 : 1;
  }

  if (temp !== undefined && temp !== null) {
    cam.temp = Number(temp);
  }

  const nowLowBat = isLowBattery(cam);
  const batterySwapped =
      prevBattery !== null && cam.battery !== null && Math.abs(cam.battery - prevBattery) >= 10;
  const stateChanged =
      hadInitialTelemetry &&
      (wasLowBat !== nowLowBat || prevCharging !== cam.charging || batterySwapped);
  const minorTelemetryChanged =
      hadInitialTelemetry &&
      !stateChanged &&
      (prevBattery !== cam.battery ||
          prevWifi !== cam.wifi ||
          prevRssi !== cam.rssi ||
          prevTemp !== cam.temp);

  if (!hadInitialTelemetry && cam.battery !== null) {
    const hwInfo = model || swVer ? 'model=' + (model || 'n/a') + ', fw=' + (swVer || 'n/a') + ', ' : '';
    const pwrMode = cam.powerLabel || (nowLowBat ? 'battery [ECO]' : 'battery');
    const wifiVal = cam.wifi ?? 'n/a';
    const rssiVal = cam.rssi ?? 'n/a';
    const tempVal = cam.temp ?? 'n/a';
    log.info(
        cam,
        'telemetry loaded (' +
        hwInfo +
        'battery=' +
        cam.battery +
        '%, power=' +
        pwrMode +
        ', wifi=' +
        wifiVal +
        '/4, rssi=' +
        rssiVal +
        'dBm, temp=' +
        tempVal +
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
  if (!wsReady) return;
  if (forceRefresh || camsRef.some((c) => isLowBattery(c))) {
    log.debug('bridge', 'polling HomeBase via driver.poll_refresh for fresh battery telemetry');
    await call({command: 'driver.poll_refresh'});
    await sleep(2000);
  }
  for (const cam of camsRef) {
    if (!wsReady) return;
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
 * Establishes and maintains the WebSocket connection to eufy-security-ws.
 */
function connectWs() {
  if (isShuttingDownFn()) return;
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
    if (!isShuttingDownFn()) setTimeout(connectWs, 10000);
  });

  ws.on('error', (e) => log.error('bridge', 'eufy-security-ws error: ' + e.message));

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch (err) {
      return;
    }

    if (m.type === 'version') {
      const targetSchema = Math.min(m.maxSchemaVersion, 21);
      await call({command: 'set_api_schema', schemaVersion: targetSchema});
      const st = await call({command: 'start_listening'});
      wsReady = Boolean(st.success);
      wsReadyAt = Date.now();
      if (wsReady) {
        log.info('bridge', 'listening for eufy events (apiSchema=' + targetSchema + ')');
      } else {
        log.error('bridge', 'start_listening failed: ' + (st.errorCode || 'unknown'));
      }

      if (wsReady) {
        const devices = (st.result && st.result.state && st.result.state.devices) || [];
        for (const dev of devices) {
          if (dev && typeof dev === 'object' && dev.serialNumber) {
            const cam = bySerialRef.get(dev.serialNumber);
            if (cam) applyDeviceProperties(cam, dev, true);
          }
        }
        await fetchAllCameraTelemetry();
        setTimeout(() => {
          if (wsReady && camsRef.some((c) => c.battery === null)) {
            void fetchAllCameraTelemetry();
          }
        }, 10000);
      }
    } else if (m.type === 'result' && m.messageId) {
      const r = waiting.get(m.messageId);
      if (r) {
        waiting.delete(m.messageId);
        r(m);
      }
    } else if (m.type === 'event' && onEventCallback) {
      try {
        onEventCallback(m.event || {});
      } catch (err) {
        log.error('bridge', 'unhandled error in onEvent: ' + err.message);
      }
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
 * @returns {string} Recognized person name, or empty string if unknown/disabled.
 */
function extractRecognizedPerson(e) {
  if (!FORWARD_FACE_NAMES || !e) return '';
  const rawName = e.person || e.personName || '';
  if (typeof rawName !== 'string') return '';
  const cleaned = rawName.trim();
  if (!cleaned || /^unknown$/i.test(cleaned) || /^stranger$/i.test(cleaned)) return '';
  return cleaned;
}

module.exports = {
  configureEufyClientHooks,
  isWsReady,
  getWsReadyAt,
  isInitialTelemetryLoaded,
  call,
  unwrapProperty,
  checkStreamingQuality,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  connectWs,
  startTelemetryPoller,
  extractRecognizedPerson,
};
