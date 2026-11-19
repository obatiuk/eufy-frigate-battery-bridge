// @ts-check
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Shared service-layer test stubs and WebSocket/camera fixtures for Frigate, HTTP, Eufy, and orchestrator tests.
 */
'use strict';

require('./test-env');

const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {initOrchestrator} = require('../../src/services/stream-orchestrator');

/**
 * Installs an in-memory default `global.fetch` stub returning HTTP 200 JSON responses so service
 * tests never open real network sockets.
 */
function installDefaultFetchStub() {
  global.fetch = /** @type {typeof fetch} */ (
    async () =>
      /** @type {*} */ ({
        ok: true,
        status: 200,
        async json() {
          return {event_id: 'mock-ev', consumers: []};
        },
        async text() {
          return '';
        },
      })
  );
}

/**
 * Builds fresh online/offline cameras and a mock Eufy recovery WebSocket for telemetry and orchestrator tests.
 *
 * @returns {Promise<{
 *   onlineCam1: Camera,
 *   onlineCam2: Camera,
 *   offlineDoorbell: Camera,
 *   cams: Camera[],
 *   bySerial: Map<string, Camera>,
 *   sentCommands: string[],
 *   resumedCams: string[],
 *   wsInstance: *,
 *   armStopNotRunningOnce: () => void
 * }>}
 */
async function createOfflineRecoveryHarness() {
  const onlineCam1 = new Camera({
    serial: 'T8161T0000000000',
    name: 'driveway',
    mode: 'rtsp',
    station_serial: 'T8030P0000000000',
  });
  const onlineCam2 = new Camera({
    serial: 'T8161T1111111111',
    name: 'backyard',
    mode: 'rtsp',
    station_serial: 'T8030P0000000000',
  });
  const offlineDoorbell = new Camera({
    serial: 'T8214T2222222222',
    name: 'doorbell',
    mode: 'backfill',
    station_serial: 'T8030P0000000000',
  });
  const cams = [onlineCam1, onlineCam2, offlineDoorbell];
  const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));

  onlineCam1.applyTelemetryProperties({state: 1, battery: 100, wifiRssi: -70}, false);
  onlineCam2.applyTelemetryProperties({state: 1, battery: 95, wifiRssi: -71}, false);
  offlineDoorbell.applyTelemetryProperties({state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100}, false);
  offlineDoorbell.pauseEncoderForOffline();

  /** @type {string[]} */
  const sentCommands = [];
  /** @type {string[]} */
  const resumedCams = [];
  let stopNotRunningOnce = false;

  class RecoveryWs {
    constructor() {
      this.readyState = 1;
      this.handlers = new Map();
    }
    /**
     * @param {string} ev - Event name.
     * @param {Function} fn - Listener callback.
     */
    on(ev, fn) {
      this.handlers.set(ev, fn);
    }
    /**
     * @param {string} raw - Outbound JSON payload.
     * @param {Function} [cb] - Optional send callback.
     */
    send(raw, cb) {
      const msg = JSON.parse(raw);
      sentCommands.push(msg.command);
      if (cb) cb();
      const msgHandler = this.handlers.get('message');
      if (!msgHandler) return;
      queueMicrotask(() => {
        if (msg.command === 'start_listening') {
          msgHandler(
            JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {state: {devices: []}}})
          );
        } else if (msg.command === 'device.get_properties') {
          const isDoorbell = msg.serialNumber === offlineDoorbell.getSerial();
          const properties = isDoorbell
            ? {state: {value: 3}, battery: {value: 100}, wifiRssi: {value: -100}}
            : {state: {value: 1}, battery: {value: 100}, wifiRssi: {value: -70}};
          msgHandler(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {properties}}));
        } else if (msg.command === 'device.stop_livestream' && stopNotRunningOnce) {
          stopNotRunningOnce = false;
          msgHandler(
            JSON.stringify({
              type: 'result',
              messageId: msg.messageId,
              success: false,
              errorCode: 'device_livestream_not_running',
            })
          );
        } else {
          msgHandler(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
        }
      });
    }
  }

  /** @type {*} */
  let wsInstance = null;
  initOrchestrator(cams, bySerial, () => false);
  configureEufyClientHooks({
    cams,
    bySerial,
    isShuttingDown: () => false,
    onDeviceOnlineResume: (cam) => resumedCams.push(cam.getName()),
    WebSocket: /** @type {*} */ (
      function MockRecoveryWs() {
        wsInstance = new RecoveryWs();
        return wsInstance;
      }
    ),
  });
  connectWs();
  configureEufyClientHooks({isShuttingDown: () => true});
  await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));

  offlineDoorbell.applyTelemetryProperties({state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100}, false);
  offlineDoorbell.pauseEncoderForOffline();
  sentCommands.length = 0;
  resumedCams.length = 0;

  return {
    onlineCam1,
    onlineCam2,
    offlineDoorbell,
    cams,
    bySerial,
    sentCommands,
    resumedCams,
    wsInstance,
    armStopNotRunningOnce: () => {
      stopNotRunningOnce = true;
    },
  };
}

module.exports = {
  installDefaultFetchStub,
  createOfflineRecoveryHarness,
};
