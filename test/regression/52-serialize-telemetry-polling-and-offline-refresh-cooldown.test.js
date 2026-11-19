/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 52:
 * Serialized Telemetry Polling & 5-Minute Unforced Offline HomeBase Refresh Cooldown
 * (docs/regression/52-serialize-telemetry-polling-and-offline-refresh-cooldown.md).
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {Camera} = require('../../src/domain/camera');
const {
  configureEufyClientHooks,
  connectWs,
  stopWsClient,
  fetchAllCameraTelemetry,
} = require('../../src/services/eufy-client');
const {stations} = require('../../src/domain/station');

/**
 * Minimal deterministic WebSocket fake for counting JSON-RPC commands during telemetry polls.
 */
class TelemetryFakeWs extends EventEmitter {
  /**
   * @param {string} url - Target WebSocket URL.
   */
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    /** @type {Array<Record<string, *>>} */
    this.sent = [];
    TelemetryFakeWs.lastInstance = this;
  }

  /**
   * @param {string} raw - Outbound JSON-RPC payload.
   * @param {(err?: Error|null) => void} [cb] - Optional send callback.
   */
  send(raw, cb) {
    const parsed = JSON.parse(raw);
    this.sent.push(parsed);
    if (cb) {
      cb(null);
    }
    if (TelemetryFakeWs.onSend) {
      TelemetryFakeWs.onSend(this, parsed);
    }
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
/** @type {TelemetryFakeWs|null} */
TelemetryFakeWs.lastInstance = null;
/** @type {((sock: TelemetryFakeWs, msg: Record<string, *>) => void)|null} */
TelemetryFakeWs.onSend = null;

/**
 * Completes the initial version + start_listening handshake on TelemetryFakeWs.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {(sock: TelemetryFakeWs, msg: Record<string, *>) => void} rpcHandler - Per-command handler after handshake.
 * @returns {Promise<TelemetryFakeWs>}
 */
async function setupTelemetryWs(cams, rpcHandler) {
  const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
  TelemetryFakeWs.onSend = (sock, msg) => {
    if (msg.command === 'set_api_schema') {
      queueMicrotask(() => {
        sock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
      });
      return;
    }
    if (msg.command === 'start_listening') {
      queueMicrotask(() => {
        sock.emit(
          'message',
          JSON.stringify({
            type: 'result',
            messageId: msg.messageId,
            success: true,
            result: {state: {driver: {connected: true}, stations: [], devices: []}},
          })
        );
      });
      return;
    }
    rpcHandler(sock, msg);
  };

  configureEufyClientHooks({
    cams,
    bySerial,
    WebSocket: TelemetryFakeWs,
    isShuttingDown: () => false,
    onDeviceOnlineResume: () => {},
  });
  connectWs();
  const sock = TelemetryFakeWs.lastInstance;
  assert.ok(sock);
  sock.emit('message', JSON.stringify({type: 'version', serverVersion: '1.9.9', maxSchemaVersion: 21}));
  await flushAsync(6);
  sock.sent.length = 0;
  return sock;
}

describe('Regression 52: Serialized Telemetry Polling & 5-Minute Unforced Offline HomeBase Refresh Cooldown', () => {
  afterEach(() => {
    configureEufyClientHooks({isShuttingDown: () => true});
    stopWsClient();
    TelemetryFakeWs.lastInstance = null;
    TelemetryFakeWs.onSend = null;
    configureEufyClientHooks({cams: [], bySerial: new Map(), isShuttingDown: () => false});
    stations.resetRecovery();
    stations.resetOrchestration();
  });

  it(
    'Regression 52: coalesces concurrent fetchAllCameraTelemetry callers and ' + 'upgrades mid-flight forced refreshes',
    async (t) => {
      // Regression: concurrent poller/retry/viewer calls share one pass and queue at most one forced follow-up.
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 500_000});
      const camA = new Camera({serial: 'T8161T0000000052', name: 'cam_a', station_serial: 'T8030P0000000050'});
      const camB = new Camera({serial: 'T8161T0000000053', name: 'cam_b', station_serial: 'T8030P0000000050'});
      camA.applyTelemetryProperties({state: 1, battery: 80, chargingStatus: 2, wifiRssi: -65}, false);
      camB.applyTelemetryProperties({state: 1, battery: 75, chargingStatus: 2, wifiRssi: -68}, false);

      /** @type {Array<() => void>} */
      const gatedReplies = [];
      let gateGetProps = false;

      const sock = await setupTelemetryWs([camA, camB], (wsSock, msg) => {
        const sendReply = () => {
          if (msg.command === 'driver.poll_refresh') {
            wsSock.emit(
              'message',
              JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
            );
            return;
          }
          if (msg.command === 'device.get_properties') {
            wsSock.emit(
              'message',
              JSON.stringify({
                type: 'result',
                messageId: msg.messageId,
                success: true,
                result: {properties: {state: {value: 1}, battery: {value: 82}, wifiRssi: {value: -64}}},
              })
            );
          }
        };
        if (gateGetProps && msg.command === 'device.get_properties') {
          gatedReplies.push(sendReply);
        } else {
          queueMicrotask(sendReply);
        }
      });

      // 1. Three concurrent unforced polls coalesce into one device.get_properties per camera (2 total, 0 poll_refresh)
      await Promise.all([
        fetchAllCameraTelemetry(false),
        fetchAllCameraTelemetry(false),
        fetchAllCameraTelemetry(false),
      ]);
      assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 0);
      assert.equal(sock.sent.filter((m) => m.command === 'device.get_properties').length, 2);

      // 2. Two forced refreshes arriving while an unforced poll is mid-flight coalesce into one forced follow-up pass
      sock.sent.length = 0;
      gateGetProps = true;
      const unforcedPromise = fetchAllCameraTelemetry(false);
      await flushAsync(2);
      assert.equal(gatedReplies.length, 1);

      let forcedResolved = false;
      const forcedPromise1 = fetchAllCameraTelemetry(true).then(() => {
        forcedResolved = true;
      });
      const forcedPromise2 = fetchAllCameraTelemetry(true);

      // Release camA and camB for the initial unforced pass
      gateGetProps = false;
      while (gatedReplies.length > 0) {
        const release = gatedReplies.shift();
        if (release) release();
      }
      await flushAsync(4);
      assert.equal(forcedResolved, false, 'Forced caller must wait for the follow-up driver.poll_refresh settle pass');

      // Advance past POLL_REFRESH_SETTLE_MS (2000ms) so the coalesced forced follow-up pass completes
      t.mock.timers.tick(2000);
      await flushAsync(6);
      await Promise.all([unforcedPromise, forcedPromise1, forcedPromise2]);

      assert.equal(forcedResolved, true);
      assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 1);
      assert.equal(sock.sent.filter((m) => m.command === 'device.get_properties').length, 4);
    }
  );

  it(
    'Regression 52: rate-limits unforced offline driver.poll_refresh to once per 5 minutes while allowing forced ' +
      'refreshes',
    async (t) => {
      // Regression: offline cameras must not force HomeBase driver.poll_refresh on every unforced poll inside 5 min.
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
      const offlineCam = new Camera({
        serial: 'T8214T0000000052',
        name: 'doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000000050',
      });

      let reportedBattery = 2;
      let reportedRssi = -100;

      const sock = await setupTelemetryWs([offlineCam], (wsSock, msg) => {
        queueMicrotask(() => {
          if (msg.command === 'driver.poll_refresh') {
            wsSock.emit(
              'message',
              JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
            );
            return;
          }
          if (msg.command === 'device.get_properties') {
            wsSock.emit(
              'message',
              JSON.stringify({
                type: 'result',
                messageId: msg.messageId,
                success: true,
                result: {
                  properties: {
                    state: {value: 3},
                    battery: {value: reportedBattery},
                    chargingStatus: {value: 2},
                    wifiRssi: {value: reportedRssi},
                  },
                },
              })
            );
          }
        });
      });

      offlineCam.applyTelemetryProperties({state: 3, battery: 2, chargingStatus: 2, wifiRssi: -100}, false);
      offlineCam.pauseEncoderForOffline();
      assert.equal(offlineCam.isDeviceOffline(), true);

      const runPoll = async (force) => {
        const p = fetchAllCameraTelemetry(force);
        await flushAsync(3);
        t.mock.timers.tick(2000);
        await flushAsync(4);
        await p;
      };

      // 1. First unforced poll at t=1_000_000 runs driver.poll_refresh once
      await runPoll(false);
      assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 1);
      assert.equal(sock.sent.filter((m) => m.command === 'device.get_properties').length, 1);
      assert.equal(offlineCam.isDeviceOffline(), true);

      // 2. Unforced polls within the 5-minute (300_000ms) cooldown skip driver.poll_refresh
      t.mock.timers.tick(60_000);
      await runPoll(false);
      t.mock.timers.tick(180_000);
      await runPoll(false);
      assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 1);
      assert.equal(sock.sent.filter((m) => m.command === 'device.get_properties').length, 3);

      // 3. Explicit forced refresh (viewer / /api/wake) bypasses cooldown and resets the 5-minute window
      const forcedStart = Date.now();
      await runPoll(true);
      assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 2);

      // Advance to 290_000ms after forcedStart (< 300_000ms): unforced poll still skips driver.poll_refresh
      t.mock.timers.tick(290_000 - (Date.now() - forcedStart));
      await runPoll(false);
      assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 2);

      // 4. Once >= 300_000ms elapses since forcedStart, unforced poll runs driver.poll_refresh and detects battery swap
      reportedBattery = 100;
      reportedRssi = -70;
      t.mock.timers.tick(300_000 - (Date.now() - forcedStart));
      await runPoll(false);
      assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 3);
      assert.equal(offlineCam.isDeviceOffline(), false);
    }
  );
});
