/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 54:
 * Sync Eufy Hardware Properties Only from Full Property Sets & Retry Failed Writes
 * (docs/regression/54-eufy-property-sync-full-sets-and-write-retries.md).
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {
  configureEufyClientHooks,
  connectWs,
  stopWsClient,
  applyDeviceProperties,
  setCameraProperty,
} = require('../../src/services/eufy-client');
const {initOrchestrator, onEvent, runHousekeepingTick} = require('../../src/services/stream-orchestrator');
const {stations} = require('../../src/domain/station');

installDefaultFetchStub();

/**
 * Minimal deterministic WebSocket fake for verifying property sync and RPC write retries.
 */
class PropSyncFakeWs extends EventEmitter {
  /**
   * @param {string} url - Target WebSocket URL.
   */
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    /** @type {Array<Record<string, *>>} */
    this.sent = [];
    PropSyncFakeWs.lastInstance = this;
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
    if (PropSyncFakeWs.onSend) {
      PropSyncFakeWs.onSend(this, parsed);
    }
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
/** @type {PropSyncFakeWs|null} */
PropSyncFakeWs.lastInstance = null;
/** @type {((sock: PropSyncFakeWs, msg: Record<string, *>) => void)|null} */
PropSyncFakeWs.onSend = null;

/**
 * Connects PropSyncFakeWs through the initial version + start_listening handshake.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {(sock: PropSyncFakeWs, msg: Record<string, *>) => void} rpcHandler - Per-command handler after handshake.
 * @returns {Promise<PropSyncFakeWs>}
 */
async function setupPropSyncWs(cams, rpcHandler) {
  const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
  initOrchestrator(cams, bySerial, () => false);
  PropSyncFakeWs.onSend = (sock, msg) => {
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
    onEvent,
    WebSocket: PropSyncFakeWs,
    isShuttingDown: () => false,
    onDeviceOnlineResume: () => {},
  });
  connectWs();
  const sock = PropSyncFakeWs.lastInstance;
  assert.ok(sock);
  sock.emit('message', JSON.stringify({type: 'version', serverVersion: '1.9.9', maxSchemaVersion: 21}));
  await flushAsync(6);
  sock.sent.length = 0;
  return sock;
}

describe('Regression 54: Sync Eufy Hardware Properties Only from Full Property Sets & Retry Failed Writes', () => {
  afterEach(() => {
    configureEufyClientHooks({isShuttingDown: () => true});
    stopWsClient();
    PropSyncFakeWs.lastInstance = null;
    PropSyncFakeWs.onSend = null;
    configureEufyClientHooks({cams: [], bySerial: new Map(), isShuttingDown: () => false});
    stations.resetRecovery();
    stations.resetOrchestration();
  });

  it(
    'Regression 54: skips Power Manager and streaming quality sync on single-key property changed events while ' +
      'updating discovered rtspStreamUrl and requiring all 4 recording keys',
    async () => {
      // Regression: single-key property changed events must pass fullSync: false and partial recording sets must not
      // latch recordingModeChecked or emit undefined -> targetValue writes.
      const cam = new Camera({
        serial: 'T8161T0000000054',
        name: 'driveway',
        mode: 'backfill',
        station_serial: 'T8030P0000000054',
      });

      const sock = await setupPropSyncWs([cam], (wsSock, msg) => {
        queueMicrotask(() => {
          wsSock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
        });
      });

      // 1. Single-key property changed events (wifiRssi, battery, videoStreamingQuality, powerWorkingMode)
      //    must never trigger Power Manager or streaming quality writes
      onEvent({event: 'property changed', serialNumber: cam.getSerial(), name: 'wifiRssi', value: -68});
      onEvent({event: 'property changed', serialNumber: cam.getSerial(), name: 'battery', value: 77});
      onEvent({event: 'property changed', serialNumber: cam.getSerial(), name: 'videoStreamingQuality', value: 0});
      onEvent({event: 'property changed', serialNumber: cam.getSerial(), name: 'powerWorkingMode', value: 0});
      await flushAsync(4);

      assert.equal(sock.sent.filter((m) => m.command === 'device.set_property').length, 0);
      assert.equal(cam.hasQualityChecked(), false);
      assert.equal(cam.hasRecordingModeChecked(), false);

      // 2. Single-key rtspStreamUrl and rtspStream property changed events still update RTSP discovery/enabling
      onEvent({
        event: 'property changed',
        serialNumber: cam.getSerial(),
        name: 'rtspStreamUrl',
        value: 'rtsp://192.0.2.10/live0',
      });
      assert.equal(cam.getRtspUrl(), 'rtsp://192.0.2.10/live0');

      // 3. Partial recording property bag in applyDeviceProperties (only 1 of 4 keys) must not latch or write n/a
      applyDeviceProperties(cam, {recordingClipLength: {value: 60}, battery: {value: 77}}, false);
      await flushAsync(4);
      assert.equal(sock.sent.filter((m) => m.command === 'device.set_property').length, 0);
      assert.equal(cam.hasRecordingModeChecked(), false);
    }
  );

  it(
    'Regression 54: returns RPC confirmation from setCameraProperty and retries failed quality, Power Manager, ' +
      'rtspStream, and stuck spotlight writes without duplicate in-flight enqueues',
    async () => {
      // Regression: one-shot sync flags and spotlight clear commit only after device.set_property succeeds so
      // dropped HomeBase writes retry on the next pass.
      const cam = new Camera({
        serial: 'T8161T0000000055',
        name: 'backyard',
        mode: 'backfill',
        track_stuck_spotlight: true,
        station_serial: 'T8030P0000000054',
      });

      let allowWrites = false;
      /** @type {Array<() => void>} */
      const pendingSetReplies = [];
      let gateSetReplies = true;

      const sock = await setupPropSyncWs([cam], (wsSock, msg) => {
        if (msg.command === 'device.set_property') {
          const reply = () => {
            wsSock.emit(
              'message',
              JSON.stringify(
                allowWrites
                  ? {type: 'result', messageId: msg.messageId, success: true, result: {}}
                  : {type: 'result', messageId: msg.messageId, success: false, errorCode: 'no_reply'}
              )
            );
          };
          if (gateSetReplies) {
            pendingSetReplies.push(reply);
          } else {
            queueMicrotask(reply);
          }
          return;
        }
        queueMicrotask(() => {
          wsSock.emit(
            'message',
            JSON.stringify({
              type: 'result',
              messageId: msg.messageId,
              success: true,
              result: {properties: {rtspStreamUrl: {value: 'rtsp://192.0.2.10/live1'}, rtspStream: {value: true}}},
            })
          );
        });
      });

      const fullProps = {
        stationSerialNumber: {value: 'T8030P0000000054'},
        rtspStreamUrl: {value: 'rtsp://192.0.2.10/live1'},
        rtspStream: {value: false},
        videoStreamingQuality: {value: 0},
        powerWorkingMode: {value: 2},
        recordingClipLength: {value: 60},
        recordingEndClipMotionStops: {value: false},
        recordingRetriggerInterval: {value: 5},
        battery: {value: 82},
      };

      // 1. First sync starts writes; duplicate applyDeviceProperties while writes are queued must not double-enqueue
      applyDeviceProperties(cam, fullProps, false);
      applyDeviceProperties(cam, fullProps, false);
      assert.equal(cam.hasQualityChecked(), false);
      assert.equal(cam.hasRecordingModeChecked(), false);
      assert.equal(cam.hasRtspPropertyChecked(), false);

      // Release gated failing replies (allowWrites = false)
      gateSetReplies = false;
      while (pendingSetReplies.length > 0) {
        const fn = pendingSetReplies.shift();
        if (fn) fn();
      }
      await flushAsync(8);

      const firstPassWrites = sock.sent
        .filter((m) => m.command === 'device.set_property')
        .map((m) => m.name + '=' + m.value);
      assert.deepEqual(firstPassWrites, [
        'videoStreamingQuality=7',
        'recordingClipLength=30',
        'recordingEndClipMotionStops=true',
        'rtspStream=true',
      ]);
      assert.equal(cam.hasQualityChecked(), false, 'Failed videoStreamingQuality write must stay uncommitted');
      assert.equal(cam.hasRecordingModeChecked(), false, 'Failed Power Manager writes must stay uncommitted');
      assert.equal(cam.hasRtspPropertyChecked(), false, 'Failed rtspStream write must stay uncommitted');

      // Direct setCameraProperty resolves false on failure and true on success
      assert.equal(await setCameraProperty(cam, 'videoStreamingQuality', 7), false);

      // 2. Next full property sync retries all failed writes and commits flags once HomeBase confirms success
      sock.sent.length = 0;
      allowWrites = true;
      assert.equal(await setCameraProperty(cam, 'recordingRetriggerInterval', 5), true);
      sock.sent.length = 0;

      applyDeviceProperties(cam, fullProps, false);
      await flushAsync(8);

      const retryWrites = sock.sent
        .filter((m) => m.command === 'device.set_property')
        .map((m) => m.name + '=' + m.value);
      assert.deepEqual(retryWrites, [
        'videoStreamingQuality=7',
        'recordingClipLength=30',
        'recordingEndClipMotionStops=true',
        'rtspStream=true',
      ]);
      assert.equal(cam.hasQualityChecked(), true);
      assert.equal(cam.hasRecordingModeChecked(), true);
      assert.equal(cam.hasRtspPropertyChecked(), true);

      // 3. Stuck spotlight: failed light=false RPC restores spotlight state so the next housekeeping tick retries
      const t0 = 500_000;
      cam.applyTelemetryProperties({light: false}, false, t0 - 1000);
      cam.applyTelemetryProperties({light: true}, false, t0);
      cam.setSleptAt(t0 + 2000);
      cam.setMotionClearedAt(t0 + 2000);

      sock.sent.length = 0;
      allowWrites = false;
      runHousekeepingTick(t0 + 140_000);
      await flushAsync(6);

      assert.deepEqual(
        sock.sent.filter((m) => m.command === 'device.set_property').map((m) => m.name + '=' + m.value),
        ['light=false']
      );
      assert.equal(cam.isSpotlightOn(), true, 'Failed light=false RPC must restore spotlight state for retry');

      sock.sent.length = 0;
      allowWrites = true;
      runHousekeepingTick(t0 + 141_000);
      await flushAsync(6);

      assert.deepEqual(
        sock.sent.filter((m) => m.command === 'device.set_property').map((m) => m.name + '=' + m.value),
        ['light=false']
      );
      assert.equal(cam.isSpotlightOn(), false);
    }
  );
});
