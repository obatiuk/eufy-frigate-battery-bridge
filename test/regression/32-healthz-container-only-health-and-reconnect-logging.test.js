/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 32. Container-Only `/healthz` Check & Graceful External Reconnect Logging
 * (docs/regression/32-healthz-container-only-health-and-reconnect-logging.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs, isWsReady} = require('../../src/services/eufy-client');
const {buildHealthPayload} = require('../../src/services/http-server');
const {initOrchestrator, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 32. Container-Only `/healthz` Check & Graceful External Reconnect Logging', () => {
  it(
    'Regression 32: reconnects eufy-security-ws gracefully with ' +
      'outage/recovery logs and ignores stale socket close',
    async () => {
      // Regression 32: reconnects eufy-security-ws gracefully with outage/recovery logs and ignores stale socket
      // close.
      const cam = new Camera({serial: 'T8161T9200000001', name: 'ws_reconnect_cam', mode: 'rtsp'});
      const testCams = [cam];
      const testBySerial = new Map([[cam.getSerial(), cam]]);
      const sockets = [];
      let throwOnConstruct = false;
      const warnings = [];
      const infos = [];
      const errors = [];
      const origWarn = log.warn;
      const origInfo = log.info;
      const origError = log.error;
      log.warn = (_s, ...a) => warnings.push(a.join(' '));
      log.info = (_s, ...a) => infos.push(a.join(' '));
      log.error = (_s, ...a) => errors.push(a.join(' '));

      class ReconnectWs {
        constructor() {
          if (throwOnConstruct) {
            throw new Error('ECONNREFUSED');
          }
          this.readyState = 1;
          this.handlers = new Map();
          sockets.push(this);
        }
        on(ev, fn) {
          this.handlers.set(ev, fn);
        }
        close() {}
        send(raw, cb) {
          const msg = JSON.parse(raw);
          if (cb) cb();
          const msgHandler = this.handlers.get('message');
          if (!msgHandler) return;
          queueMicrotask(() => {
            if (msg.command === 'start_listening') {
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {state: {driver: {connected: true}, stations: [], devices: []}},
                })
              );
            } else {
              msgHandler(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
            }
          });
        }
      }

      try {
        initOrchestrator(testCams, testBySerial, () => false);
        configureEufyClientHooks({
          cams: testCams,
          bySerial: testBySerial,
          isShuttingDown: () => false,
          onDeviceOnlineResume: () => {},
          onWsClosedStop: () => {},
          WebSocket: ReconnectWs,
        });

        connectWs();
        sockets[0].handlers.get('open')?.();
        await sockets[0].handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        assert.equal(isWsReady(), true);
        assert.equal(
          infos.some((m) => m.includes('eufy-security-ws connected')),
          false,
          'Socket open event must log at debug level so startup emits only listening at info'
        );

        // Simulate outage disconnect -> keeps /healthz healthy (ok=true) and logs retry once per outage
        configureEufyClientHooks({isShuttingDown: () => true});
        sockets[0].handlers.get('close')();
        assert.equal(isWsReady(), false);
        assert.deepEqual(buildHealthPayload(false), {ok: true});
        assert.equal(
          warnings.filter((m) => m.includes('eufy-security-ws connection closed, retrying in 10 s')).length,
          1
        );

        // Repeated synchronous construct failures log error once per outage instead of spamming every 10s
        throwOnConstruct = true;
        configureEufyClientHooks({isShuttingDown: () => false});
        assert.doesNotThrow(() => connectWs());
        assert.doesNotThrow(() => connectWs());
        assert.equal(
          errors.filter((m) => m.includes('eufy-security-ws connect failed')).length,
          1,
          'Repeated WebSocket construct errors during an active outage must not spam error logs'
        );

        // Successful reconnect logs explicit reconnection message and ignores stale sockets[0] close
        throwOnConstruct = false;
        infos.length = 0;
        connectWs();
        await sockets[1].handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        assert.equal(isWsReady(), true);
        assert.equal(
          infos.some((m) => m.includes('eufy-security-ws reconnected')),
          true,
          'Reconnecting after WS close must log an explicit reconnected message'
        );

        sockets[0].handlers.get('close')();
        assert.equal(isWsReady(), true, 'Close event from a superseded stale WebSocket must be ignored');
      } finally {
        log.warn = origWarn;
        log.info = origInfo;
        log.error = origError;
        configureEufyClientHooks({isShuttingDown: () => true});
        const latestSocket = sockets[sockets.length - 1];
        if (latestSocket && latestSocket.handlers.get('close')) {
          latestSocket.handlers.get('close')();
        }
        configureEufyClientHooks({
          isShuttingDown: () => false,
          onDeviceOnlineResume: () => {},
          onWsClosedStop: () => {},
        });
        stop(cam, 'cleanup', false, 'bridge-test');
      }
    }
  );
});
