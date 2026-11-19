/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 51. Eufy WebSocket Keepalive Pings, Handshake Timeout & Jittered Reconnect Backoff
 * (docs/regression/51-websocket-keepalive-ping-handshake-timeout-and-backoff.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs, stopWsClient, isWsReady} = require('../../src/services/eufy-client');

describe('Regression 51. Eufy WebSocket Keepalive Pings, Handshake Timeout & Jittered Reconnect Backoff', () => {
  it(
    'Regression 51: passes handshakeTimeout, terminates silent half-open sockets on missed pong, times out ' +
      'stalled handshakes, and backs off reconnects with jitter',
    async (t) => {
      // Regression: connectWs lacked ping/pong keepalives, handshakeTimeout, and reconnect backoff, leaving wsReady
      // true forever on half-open dead TCP sockets and retrying on a fixed unjittered 10s interval.
      t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date'], now: 1_794_900_000_000});

      /** @type {KeepaliveWs[]} */
      const sockets = [];
      let autoHandshake = true;

      class KeepaliveWs extends EventEmitter {
        /**
         * @param {string} url - WebSocket URL.
         * @param {Record<string, *>} [options] - Constructor options.
         */
        constructor(url, options = {}) {
          super();
          this.url = url;
          this.options = options;
          this.readyState = 1;
          this.pings = 0;
          this.terminated = false;
          sockets.push(this);
        }

        send(raw, cb) {
          const msg = JSON.parse(raw);
          if (cb) {
            cb(null);
          }
          if (!autoHandshake) {
            return;
          }
          if (msg.command === 'set_api_schema') {
            this.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
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

        ping() {
          this.pings += 1;
        }

        terminate() {
          this.terminated = true;
          this.readyState = 3;
          this.emit('close');
        }

        close() {
          this.readyState = 3;
          this.emit('close');
        }
      }

      const cam = new Camera({serial: 'SN0000000511', name: 'ws_keepalive_cam', mode: 'p2p'});
      let wsClosedStops = 0;

      try {
        configureEufyClientHooks({
          cams: [cam],
          bySerial: new Map([[cam.getSerial(), cam]]),
          isShuttingDown: () => false,
          WebSocket: KeepaliveWs,
          onDeviceOnlineResume: () => {},
          onWsClosedStop: (c) => {
            wsClosedStops += 1;
            c.endSession(Date.now(), false, false, 'p2p');
          },
        });

        // 1. Passes handshakeTimeout option to WebSocket constructor and starts keepalive pings once open.
        connectWs();
        assert.equal(sockets.length, 1);
        assert.equal(sockets[0].options.handshakeTimeout, 10_000);
        sockets[0].emit('open');
        sockets[0].emit('message', JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        await flushAsync();
        assert.equal(isWsReady(), true);

        // First 30s ping answered by pong within 10s keeps socket alive.
        cam.beginSession('p2p', Date.now(), true);
        t.mock.timers.tick(30_000);
        assert.equal(sockets[0].pings, 1);
        t.mock.timers.tick(5_000);
        sockets[0].emit('pong');
        t.mock.timers.tick(6_000);
        assert.equal(isWsReady(), true);
        assert.equal(sockets[0].terminated, false);

        // Next 30s ping receives NO pong or message for 10s -> terminates dead half-open socket and stops active cam.
        t.mock.timers.tick(25_000);
        assert.equal(sockets[0].pings, 2);
        t.mock.timers.tick(10_500);
        await flushAsync();
        assert.equal(sockets[0].terminated, true);
        assert.equal(isWsReady(), false);
        assert.equal(wsClosedStops, 1);
        assert.equal(cam.isSessionActive(), false);

        // 2. Reconnect fires after ~10s (attempt 0); if that socket stalls without 'version', handshake times out at
        //    10s and the next reconnect backs off past 15s (> fixed 10s).
        autoHandshake = false;
        t.mock.timers.tick(10_500);
        await flushAsync();
        assert.equal(sockets.length, 2, 'attempt 0 reconnects around 10s');
        sockets[1].emit('open');

        // Stalled version handshake times out at 10s.
        t.mock.timers.tick(10_500);
        await flushAsync();
        assert.equal(sockets[1].readyState, 3, 'stalled version handshake must close socket after timeout');

        // Second consecutive reconnect must NOT fire at 10s (exponential backoff ~20s +/- jitter >= 16s).
        t.mock.timers.tick(12_000);
        assert.equal(sockets.length, 2, 'attempt 1 must back off beyond fixed 10s');
        t.mock.timers.tick(13_000);
        assert.equal(sockets.length, 3, 'attempt 1 reconnects after jittered ~20s backoff');
      } finally {
        stopWsClient();
        configureEufyClientHooks({cams: [], bySerial: new Map(), isShuttingDown: () => false});
      }
    }
  );
});
