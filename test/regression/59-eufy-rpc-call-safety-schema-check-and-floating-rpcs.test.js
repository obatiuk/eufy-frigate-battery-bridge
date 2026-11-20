/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 59:
 * Harden Eufy RPC `call()`, Check `set_api_schema` & Guard Floating Background RPCs
 * (docs/regression/59-eufy-rpc-call-safety-schema-check-and-floating-rpcs.md).
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {Camera} = require('../../src/domain/camera');
const {stations} = require('../../src/domain/station');
const {log} = require('../../src/logger');
const {
  registerEufySubsystems,
  configureEufyClientHooks,
  isWsReady,
  call,
  connectWs,
  stopWsClient,
} = require('../../src/services/eufy/ws-transport');
const {initOrchestrator, wakeCameraExternal, stop} = require('../../src/services/stream-orchestrator');

describe('Regression 59: Harden Eufy RPC call(), Check set_api_schema & Guard Floating Background RPCs', () => {
  afterEach(() => {
    stopWsClient();
    registerEufySubsystems({onRecoverDriverAndStations: async () => {}});
    configureEufyClientHooks({cams: [], bySerial: new Map(), isShuttingDown: () => false});
    initOrchestrator([], new Map(), () => false);
    stations.resetRecovery();
    stations.resetOrchestration();
  });

  it(
    'Regression 59: resolves call() without rejecting when ws.send throws synchronously and aborts handshake ' +
      'before start_listening when set_api_schema fails',
    async (t) => {
      // Regression: ws.send throwing synchronously inside call() rejected the returned Promise and leaked pending
      // RPC state, while handleVersionMessage ignored failed set_api_schema responses and called start_listening.
      t.mock.timers.enable({apis: ['setTimeout']});
      const errors = [];
      const origError = log.error;
      log.error = (_scope, ...args) => errors.push(args.join(' '));

      /** @type {MockWs[]} */
      const sockets = [];
      class MockWs extends EventEmitter {
        constructor() {
          super();
          this.readyState = 1;
          /** @type {Array<Record<string, *>>} */
          this.sent = [];
          sockets.push(this);
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          this.sent.push(msg);
          if (cb) cb(null);
          if (msg.command === 'set_api_schema') {
            this.emit(
              'message',
              JSON.stringify({
                type: 'result',
                messageId: msg.messageId,
                success: false,
                errorCode: 'schema_version_not_supported',
              })
            );
          } else if (msg.command === 'start_listening') {
            this.emit(
              'message',
              JSON.stringify({
                type: 'result',
                messageId: msg.messageId,
                success: true,
                result: {state: {driver: {connected: true}, stations: [], devices: []}},
              })
            );
          }
        }
        close() {
          this.readyState = 3;
        }
      }

      try {
        const cam = new Camera({serial: 'T8161T0000000059', name: 'front_gate', mode: 'rtsp'});
        cam.updateServiceHealth({wsConnected: true});
        configureEufyClientHooks({
          cams: [cam],
          bySerial: new Map([[cam.getSerial(), cam]]),
          WebSocket: /** @type {*} */ (MockWs),
          isShuttingDown: () => false,
          onDeviceOnlineResume: () => {},
        });
        connectWs();
        assert.equal(sockets.length, 1);

        sockets[0].emit('message', JSON.stringify({type: 'version', serverVersion: '1.9.9', maxSchemaVersion: 21}));
        await flushAsync(4);

        assert.deepEqual(
          sockets[0].sent.map((m) => m.command),
          ['set_api_schema'],
          'Failed set_api_schema must abort handshake before sending start_listening'
        );
        assert.equal(isWsReady(), false);
        assert.equal(cam.hasServiceDisruption(), true);
        assert.equal(
          errors.some(
            (line) => line.includes('set_api_schema failed') && line.includes('schema_version_not_supported')
          ),
          true
        );

        sockets[0].send = () => {
          throw new Error('WebSocket is not open: readyState 2 (CLOSING)');
        };
        const res = await call({command: 'station.is_connected', serialNumber: 'T8030P0000000059'});
        assert.deepEqual(res, {
          success: false,
          errorCode: 'WebSocket is not open: readyState 2 (CLOSING)',
        });

        t.mock.timers.tick(11_000);
        assert.equal(sockets.length, 2, 'Failed set_api_schema must schedule a WebSocket reconnect');
      } finally {
        log.error = origError;
      }
    }
  );

  it(
    'Regression 59: guards background offline api-wake refresh and post-stop device.get_properties against ' +
      'unhandled rejections',
    async () => {
      // Regression: floating .then() chains in refreshOfflineCameraOnApiWake and stop() lacked .catch() handlers.
      /** @type {unknown[]} */
      const unhandled = [];
      const onUnhandled = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandled);

      const warnings = [];
      const debugs = [];
      const origWarn = log.warn;
      const origDebug = log.debug;
      log.warn = (_scope, ...args) => warnings.push(args.join(' '));
      log.debug = (_scope, ...args) => debugs.push(args.join(' '));

      let failPostStopResume = false;
      class FloatingRpcWs extends EventEmitter {
        constructor() {
          super();
          this.readyState = 1;
          FloatingRpcWs.last = this;
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          if (cb) cb(null);
          setImmediate(() => {
            if (msg.command === 'driver.poll_refresh') {
              this.emit(
                'message',
                JSON.stringify({type: 'result', messageId: msg.messageId, success: false, errorCode: 'no_reply'})
              );
            } else if (msg.command === 'device.get_properties') {
              this.emit(
                'message',
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {properties: {state: {value: 1}, battery: {value: 88}}},
                })
              );
            } else if (msg.command === 'start_listening') {
              this.emit(
                'message',
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {state: {driver: {connected: true}, stations: [], devices: []}},
                })
              );
            } else {
              this.emit(
                'message',
                JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
              );
            }
          });
        }
        close() {
          this.readyState = 3;
        }
      }
      /** @type {FloatingRpcWs|null} */
      FloatingRpcWs.last = null;

      const offlineCam = new Camera({serial: 'T8161T0000000159', name: 'shed', mode: 'p2p'});
      const activeCam = new Camera({serial: 'T8161T0000000259', name: 'alley', mode: 'p2p'});
      const cams = [offlineCam, activeCam];
      const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));

      try {
        initOrchestrator(cams, bySerial, () => false);
        configureEufyClientHooks({
          cams,
          bySerial,
          WebSocket: /** @type {*} */ (FloatingRpcWs),
          isShuttingDown: () => false,
          onDeviceOnlineResume: () => {
            if (failPostStopResume) {
              throw new Error('post-stop callback boom');
            }
          },
        });
        connectWs();
        assert.ok(FloatingRpcWs.last);
        FloatingRpcWs.last.emit(
          'message',
          JSON.stringify({type: 'version', serverVersion: '1.9.9', maxSchemaVersion: 21})
        );
        await flushAsync(6);

        offlineCam.applyTelemetryProperties({state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100}, false);
        registerEufySubsystems({
          onRecoverDriverAndStations: async () => {
            throw new Error('offline wake recovery boom');
          },
        });

        wakeCameraExternal(offlineCam, {durationMs: 30_000, reason: 'webhook', createEvent: false});
        await flushAsync(6);

        activeCam.applyTelemetryProperties({state: 1, battery: 88, chargingStatus: 2, wifiRssi: -62}, false);
        activeCam.beginSession('p2p', Date.now(), false);
        activeCam.setGotVideo(true);
        failPostStopResume = true;
        stop(activeCam, 'hold expired', {initiator: 'bridge'});
        await flushAsync(6);

        assert.deepEqual(unhandled, [], 'Background RPC chains in wake.js must not produce unhandled rejections');
        assert.equal(
          warnings.some((line) => line.includes('offline wake recovery boom')),
          true
        );
        assert.equal(
          debugs.some((line) => line.includes('post-stop callback boom')),
          true
        );
      } finally {
        process.off('unhandledRejection', onUnhandled);
        log.warn = origWarn;
        log.debug = origDebug;
      }
    }
  );
});
