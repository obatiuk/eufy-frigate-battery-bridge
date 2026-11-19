/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for split Eufy WebSocket client modules:
 * src/services/eufy/{ws-transport,telemetry-sync,station-recovery}.js and src/services/eufy-client.js re-exports.
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../../helpers/test-env');

const {
  registerEufySubsystems,
  configureEufyClientHooks,
  isWsReady,
  isWsSettledForEvents,
  canRunStartupProbeNow,
  formatRpcError,
  computeWsReconnectDelayMs,
  call,
  connectWs,
  stopWsClient,
} = require('../../../src/services/eufy/ws-transport');
const {
  isTrackedPropertyEvent,
  resolvePropertyTriggerEvent,
  fetchAllCameraTelemetry,
  stopTelemetryPoller,
  extractRecognizedPerson,
} = require('../../../src/services/eufy/telemetry-sync');
const {Camera} = require('../../../src/domain/camera');
const {
  isStationRecycling,
  noteStationActivity,
  recoverUnresponsiveStation,
} = require('../../../src/services/eufy/station-recovery');
const eufyClient = require('../../../src/services/eufy-client');
const {stations} = require('../../../src/domain/station');
const {log} = require('../../../src/logger');

/**
 * Minimal deterministic WebSocket fake for testing JSON-RPC and handshake frames.
 */
class FakeWebSocket extends EventEmitter {
  /**
   * @param {string} url - Target WebSocket URL.
   */
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    /** @type {Array<Record<string, *>>} */
    this.sent = [];
    FakeWebSocket.lastInstance = this;
  }

  /**
   * @param {string} raw - Serialized JSON command frame.
   * @param {(err?: Error|null) => void} [cb] - Send completion callback.
   */
  send(raw, cb) {
    const parsed = JSON.parse(raw);
    this.sent.push(parsed);
    if (cb) {
      cb(null);
    }
    if (FakeWebSocket.onSend) {
      FakeWebSocket.onSend(this, parsed);
    }
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
/** @type {FakeWebSocket|null} */
FakeWebSocket.lastInstance = null;
/** @type {((sock: FakeWebSocket, msg: Record<string, *>) => void)|null} */
FakeWebSocket.onSend = null;

describe('src/services/eufy split modules', () => {
  afterEach(() => {
    if (FakeWebSocket.lastInstance && FakeWebSocket.lastInstance.readyState === 1) {
      configureEufyClientHooks({isShuttingDown: () => true});
      FakeWebSocket.lastInstance.close();
    }
    FakeWebSocket.lastInstance = null;
    FakeWebSocket.onSend = null;
    configureEufyClientHooks({cams: [], bySerial: new Map(), isShuttingDown: () => false});
    stations.resetRecovery();
    stations.resetOrchestration();
  });

  it('handles RPC formatting, readiness windows, and JSON-RPC correlation in ws-transport.js', async () => {
    // Verify ws-transport formats compound RPC errors, returns ws_closed when disconnected, and correlates replies.
    assert.equal(formatRpcError({errorCode: 'unknown_error', message: 'timeout'}), 'unknown_error (timeout)');
    assert.equal(formatRpcError({errorCode: 'station_not_connected'}), 'station_not_connected');
    assert.equal(formatRpcError(null), 'unknown');

    assert.deepEqual(await call({command: 'driver.is_connected'}), {success: false, errorCode: 'ws_closed'});

    FakeWebSocket.onSend = (sock, msg) => {
      if (msg.command === 'set_api_schema') {
        sock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
      } else if (msg.command === 'start_listening') {
        sock.emit(
          'message',
          JSON.stringify({
            type: 'result',
            messageId: msg.messageId,
            success: true,
            result: {state: {driver: {connected: true}, stations: [], devices: []}},
          })
        );
      } else if (msg.command === 'driver.is_connected') {
        sock.emit(
          'message',
          JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {connected: true}})
        );
      }
    };

    configureEufyClientHooks({cams: [], bySerial: new Map(), WebSocket: FakeWebSocket, isShuttingDown: () => false});
    connectWs();
    assert.ok(FakeWebSocket.lastInstance);
    FakeWebSocket.lastInstance.emit('message', JSON.stringify({type: 'version', maxSchemaVersion: 21}));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(isWsReady(), true);
    const futureNow = Date.now() + 10_000;
    assert.equal(isWsSettledForEvents(futureNow, 5_000), true);
    assert.equal(canRunStartupProbeNow(futureNow, 6_000), true);
  });

  it('classifies tracked properties, detection triggers, and face names in telemetry-sync.js', () => {
    // Verify telemetry-sync maps detection properties and filters unknown/stranger face placeholders.
    assert.equal(isTrackedPropertyEvent('battery'), true);
    assert.equal(isTrackedPropertyEvent('untrackedProp'), false);
    assert.equal(resolvePropertyTriggerEvent('personDetected'), 'person detected');
    assert.equal(resolvePropertyTriggerEvent('ringing'), 'rings');
    assert.equal(resolvePropertyTriggerEvent('battery'), '');

    assert.equal(extractRecognizedPerson({person: ' Alice '}, true), 'Alice');
    assert.equal(extractRecognizedPerson({person: 'Unknown'}, true), '');
    assert.equal(extractRecognizedPerson({personName: 'Stranger'}, true), '');
    assert.equal(extractRecognizedPerson({person: 'Alice'}, false), '');
  });

  it('reconnects disconnected HomeBase stations and tracks activity in station-recovery.js', async () => {
    // Verify station-recovery sends station.connect when station.is_connected reports connected=false.
    FakeWebSocket.onSend = (sock, msg) => {
      if (msg.command === 'set_api_schema' || msg.command === 'station.connect') {
        sock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
      } else if (msg.command === 'start_listening') {
        sock.emit(
          'message',
          JSON.stringify({
            type: 'result',
            messageId: msg.messageId,
            success: true,
            result: {state: {driver: {connected: true}, stations: [], devices: []}},
          })
        );
      } else if (msg.command === 'station.is_connected') {
        sock.emit(
          'message',
          JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {connected: false}})
        );
      }
    };

    configureEufyClientHooks({cams: [], bySerial: new Map(), WebSocket: FakeWebSocket, isShuttingDown: () => false});
    connectWs();
    FakeWebSocket.lastInstance.emit('message', JSON.stringify({type: 'version', maxSchemaVersion: 21}));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(isStationRecycling('SN0000000010'), false);
    const recovered = await recoverUnresponsiveStation('SN0000000010', 'wake_timeout', false);
    assert.equal(recovered, true);
    assert.equal(stations.get('SN0000000010').disconnected, false);
    noteStationActivity('SN0000000010');
    assert.equal(stations.get('SN0000000010').known, true);
  });

  it('re-exports the split module API unchanged from src/services/eufy-client.js', () => {
    // Verify existing callers importing src/services/eufy-client.js receive the exact same function references.
    assert.equal(eufyClient.configureEufyClientHooks, configureEufyClientHooks);
    assert.equal(eufyClient.call, call);
    assert.equal(eufyClient.connectWs, connectWs);
    assert.equal(eufyClient.isTrackedPropertyEvent, isTrackedPropertyEvent);
    assert.equal(eufyClient.resolvePropertyTriggerEvent, resolvePropertyTriggerEvent);
    assert.equal(eufyClient.extractRecognizedPerson, extractRecognizedPerson);
    assert.equal(eufyClient.recoverUnresponsiveStation, recoverUnresponsiveStation);
    assert.equal(eufyClient.noteStationActivity, noteStationActivity);
  });

  it('logs a soft warning on outdated eufy-security-ws version handshake while continuing listening', async () => {
    // Verify ws-transport warns when serverVersion < 1.9.9 or maxSchemaVersion < 18 without blocking startup.
    const warnings = [];
    const origWarn = log.warn;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));
    FakeWebSocket.onSend = (sock, msg) => {
      if (msg.command === 'set_api_schema') {
        sock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
      } else if (msg.command === 'start_listening') {
        sock.emit(
          'message',
          JSON.stringify({
            type: 'result',
            messageId: msg.messageId,
            success: true,
            result: {state: {driver: {connected: true}, stations: [], devices: []}},
          })
        );
      }
    };

    try {
      configureEufyClientHooks({cams: [], bySerial: new Map(), WebSocket: FakeWebSocket, isShuttingDown: () => false});
      connectWs();
      FakeWebSocket.lastInstance.emit(
        'message',
        JSON.stringify({type: 'version', serverVersion: '1.9.8', maxSchemaVersion: 17})
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(isWsReady(), true);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].includes('1.9.8') && warnings[0].includes('1.9.9'), true);
      assert.equal(warnings[0].includes('17') && warnings[0].includes('18'), true);
    } finally {
      log.warn = origWarn;
    }
  });

  it('catches async message handler rejections and exposes stopWsClient / stopTelemetryPoller', async () => {
    // Verify socket.on('message') catches async version handshake errors and stop helpers clean up background timers.
    assert.equal(typeof stopWsClient, 'function');
    assert.equal(typeof stopTelemetryPoller, 'function');
    assert.equal(eufyClient.stopWsClient, stopWsClient);
    assert.equal(eufyClient.stopTelemetryPoller, stopTelemetryPoller);

    const errors = [];
    const origError = log.error;
    log.error = (_scope, ...args) => errors.push(args.join(' '));
    FakeWebSocket.onSend = (sock, msg) => {
      if (msg.command === 'set_api_schema') {
        sock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
      } else if (msg.command === 'start_listening') {
        sock.emit(
          'message',
          JSON.stringify({
            type: 'result',
            messageId: msg.messageId,
            success: true,
            result: {state: {driver: {connected: true}, stations: [], devices: []}},
          })
        );
      }
    };
    registerEufySubsystems({
      onEnsureInitialConnected: async () => {
        throw new Error('simulated handshake boom');
      },
    });
    try {
      configureEufyClientHooks({cams: [], bySerial: new Map(), WebSocket: FakeWebSocket, isShuttingDown: () => false});
      connectWs();
      FakeWebSocket.lastInstance.emit('message', JSON.stringify({type: 'version', maxSchemaVersion: 21}));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(
        errors.some((line) => line.includes('simulated handshake boom')),
        true
      );
      stopWsClient();
      assert.equal(isWsReady(), false);
    } finally {
      log.error = origError;
      registerEufySubsystems({onEnsureInitialConnected: async () => {}});
    }
  });

  it('computes bounded exponential reconnect backoff with jitter in computeWsReconnectDelayMs', () => {
    // Verify initial reconnect stays around 10s while consecutive failures back off with jitter up to 60s max.
    assert.equal(typeof computeWsReconnectDelayMs, 'function');
    const firstMin = computeWsReconnectDelayMs(0, () => 0);
    const firstMax = computeWsReconnectDelayMs(0, () => 1);
    assert.equal(Math.round(firstMin / 1000), 10);
    assert.equal(Math.round(firstMax / 1000), 10);
    assert.equal(firstMax > firstMin, true, 'attempt 0 still applies sub-second jitter');

    const secondLow = computeWsReconnectDelayMs(1, () => 0);
    const secondHigh = computeWsReconnectDelayMs(1, () => 1);
    assert.equal(secondLow >= 16_000 && secondLow <= 20_000, true);
    assert.equal(secondHigh >= 20_000 && secondHigh <= 24_000, true);
    assert.equal(secondHigh > secondLow, true);

    const capped = computeWsReconnectDelayMs(8, () => 1);
    assert.equal(capped <= 60_000, true);
    assert.equal(capped >= 48_000, true);
  });

  it('serializes concurrent fetchAllCameraTelemetry calls in telemetry-sync.js', async () => {
    // Verify concurrent telemetry polls coalesce into a single device.get_properties pass per camera.
    const cam = new Camera({serial: 'T8161T0000000099', name: 'patio', station_serial: 'T8030P0000000010'});
    cam.applyTelemetryProperties({state: 1, battery: 90, chargingStatus: 2, wifiRssi: -60}, false);

    FakeWebSocket.onSend = (sock, msg) => {
      if (msg.command === 'set_api_schema') {
        sock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
      } else if (msg.command === 'start_listening') {
        sock.emit(
          'message',
          JSON.stringify({
            type: 'result',
            messageId: msg.messageId,
            success: true,
            result: {state: {driver: {connected: true}, stations: [], devices: []}},
          })
        );
      } else if (msg.command === 'device.get_properties') {
        setImmediate(() => {
          sock.emit(
            'message',
            JSON.stringify({
              type: 'result',
              messageId: msg.messageId,
              success: true,
              result: {properties: {state: {value: 1}, battery: {value: 90}, wifiRssi: {value: -60}}},
            })
          );
        });
      }
    };

    configureEufyClientHooks({
      cams: [cam],
      bySerial: new Map([[cam.getSerial(), cam]]),
      WebSocket: FakeWebSocket,
      isShuttingDown: () => false,
      onDeviceOnlineResume: () => {},
    });
    connectWs();
    FakeWebSocket.lastInstance.emit('message', JSON.stringify({type: 'version', maxSchemaVersion: 21}));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    FakeWebSocket.lastInstance.sent.length = 0;
    await Promise.all([fetchAllCameraTelemetry(false), fetchAllCameraTelemetry(false), fetchAllCameraTelemetry(false)]);
    assert.equal(FakeWebSocket.lastInstance.sent.filter((m) => m.command === 'device.get_properties').length, 1);
  });
});
