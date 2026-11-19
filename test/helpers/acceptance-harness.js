/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Shared mock eufy-security-ws WebSocket harness for locked AT-01..AT-19 acceptance tests.
 */
'use strict';

require('./test-env');

const {installDefaultFetchStub} = require('./service-mocks');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {initOrchestrator, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

/**
 * Installs a mock eufy-security-ws WebSocket harness that records all outbound RPC commands
 * and device.set_property calls for acceptance verification.
 *
 * @param {import('../../src/domain/camera').Camera[]} cams - Camera domain instances under test.
 * @returns {Promise<{ sentCommands: string[], setPropCalls: string[], wsInstance: * }>}
 */
async function setupAcceptanceHarness(cams) {
  /** @type {string[]} */
  const sentCommands = [];
  /** @type {string[]} */
  const setPropCalls = [];
  const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
  /** @type {*} */
  let wsInstance = null;

  class AcceptanceWs {
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
      if (msg.command === 'device.set_property') {
        setPropCalls.push(msg.name + '=' + msg.value);
      }
      if (cb) cb();
      const msgHandler = this.handlers.get('message');
      if (msgHandler) {
        queueMicrotask(() => {
          msgHandler(
            JSON.stringify({
              type: 'result',
              messageId: msg.messageId,
              success: true,
              result: msg.command === 'start_listening' ? {state: {devices: []}} : {},
            })
          );
        });
      }
    }
  }

  initOrchestrator(cams, bySerial, () => false);
  configureEufyClientHooks({
    cams,
    bySerial,
    isShuttingDown: () => false,
    onWsClosedStop: (cam) => stop(cam, 'bridge lost eufy-security-ws connection', false, 'error/ws-disconnect'),
    onDeviceOnlineResume: () => {},
    WebSocket: /** @type {*} */ (
      function MockAcceptanceWs() {
        wsInstance = new AcceptanceWs();
        return wsInstance;
      }
    ),
  });
  connectWs();
  await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
  configureEufyClientHooks({isShuttingDown: () => true, wsReadyAt: Date.now() - 10000});
  sentCommands.length = 0;
  setPropCalls.length = 0;
  return {sentCommands, setPropCalls, wsInstance};
}

module.exports = {
  setupAcceptanceHarness,
};
