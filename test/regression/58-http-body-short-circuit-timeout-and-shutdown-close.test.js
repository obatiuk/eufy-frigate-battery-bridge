/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 58:
 * Short-Circuit Oversized HTTP Bodies, Add Body Timeout & Close Connections on Shutdown
 * (docs/regression/58-http-body-short-circuit-timeout-and-shutdown-close.md).
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {Camera} = require('../../src/domain/camera');
const {createHttpRequestHandler, startHttpServer, stopHttpServer} = require('../../src/services/http-server');

describe('Regression 58: Short-Circuit Oversized HTTP Bodies, Add Body Timeout & Close Connections on Shutdown', () => {
  afterEach(() => {
    stopHttpServer();
  });

  it(
    'Regression 58: rejects oversized Content-Length and streaming POST bodies immediately with 413 Connection: ' +
      'close and times out stalled bodies after 5s',
    async (t) => {
      // Regression: readJsonBody waited until end after exceeding 16384 bytes and lacked a body read timeout.
      t.mock.timers.enable({apis: ['setTimeout']});
      const cam = new Camera({serial: 'T8161T0000000058', name: 'driveway', mode: 'rtsp'});
      const handler = createHttpRequestHandler([cam], {
        wakeCameraExternal: () => ({camera: 'driveway', status: 'waking', hold_secs: 60}),
        isShuttingDown: () => false,
      });

      const makeMockRes = () => {
        /** @type {Record<string, string>} */
        const headers = {};
        let status = 0;
        let body = '';
        let ended = false;
        const emitter = new EventEmitter();
        const res = Object.assign(emitter, {
          setHeader(k, v) {
            headers[String(k).toLowerCase()] = String(v);
          },
          writeHead(code, hdrs = {}) {
            status = code;
            for (const [k, v] of Object.entries(hdrs)) {
              headers[String(k).toLowerCase()] = String(v);
            }
          },
          end(chunk = '') {
            body += String(chunk || '');
            ended = true;
            emitter.emit('finish');
          },
          getResult: () => ({ended, status, headers, json: body ? JSON.parse(body) : null}),
        });
        return res;
      };

      // 1. Declared Content-Length > 16384 responds 413 + Connection: close immediately without end
      const reqHeaderBig = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/api/wake/driveway',
        headers: {'content-length': '1048576'},
      });
      const resHeaderBig = makeMockRes();
      let headerDone = false;
      const headerPromise = Promise.resolve(
        handler(/** @type {*} */ (reqHeaderBig), /** @type {*} */ (resHeaderBig))
      ).then(() => {
        headerDone = true;
      });
      await flushAsync(2);
      const headerSettledBeforeEnd = headerDone;
      if (!headerDone) {
        reqHeaderBig.emit('end');
      }
      await headerPromise;
      assert.equal(headerSettledBeforeEnd, true);
      const outHeaderBig = resHeaderBig.getResult();
      assert.equal(outHeaderBig.ended, true);
      assert.equal(outHeaderBig.status, 413);
      assert.equal(outHeaderBig.headers.connection, 'close');
      assert.equal(outHeaderBig.json.error_code, 'PAYLOAD_TOO_LARGE');

      // 2. Streaming chunk > 16384 responds 413 + Connection: close before end and ignores trailing error
      const reqStreamBig = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/api/wake/driveway',
        headers: {},
      });
      const resStreamBig = makeMockRes();
      let streamDone = false;
      const streamPromise = Promise.resolve(
        handler(/** @type {*} */ (reqStreamBig), /** @type {*} */ (resStreamBig))
      ).then(() => {
        streamDone = true;
      });
      reqStreamBig.emit('data', Buffer.alloc(16385, 0x78));
      await flushAsync(2);
      const settledBeforeEnd = streamDone;
      if (!streamDone) {
        reqStreamBig.emit('end');
      }
      await streamPromise;
      assert.equal(settledBeforeEnd, true, 'Streaming chunk > 16384 must respond 413 before end');
      reqStreamBig.emit('error', new Error('client aborted upload'));
      const outStreamBig = resStreamBig.getResult();
      assert.equal(outStreamBig.ended, true);
      assert.equal(outStreamBig.status, 413);
      assert.equal(outStreamBig.headers.connection, 'close');
      assert.equal(outStreamBig.json.error_code, 'PAYLOAD_TOO_LARGE');

      // 3. Stalled POST body times out after 5000ms with 408 REQUEST_TIMEOUT + Connection: close
      const reqStalled = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/api/wake/driveway',
        headers: {},
      });
      const resStalled = makeMockRes();
      let stalledDone = false;
      const stalledPromise = Promise.resolve(
        handler(/** @type {*} */ (reqStalled), /** @type {*} */ (resStalled))
      ).then(() => {
        stalledDone = true;
      });
      reqStalled.emit('data', Buffer.from('{"reason":"slow'));
      t.mock.timers.tick(5000);
      await flushAsync(2);
      const timedOutBeforeEnd = stalledDone;
      if (!stalledDone) {
        reqStalled.emit('end');
      }
      await stalledPromise;
      assert.equal(timedOutBeforeEnd, true);
      const outStalled = resStalled.getResult();
      assert.equal(outStalled.ended, true);
      assert.equal(outStalled.status, 408);
      assert.equal(outStalled.headers.connection, 'close');
      assert.equal(outStalled.json.error_code, 'REQUEST_TIMEOUT');
    }
  );

  it('Regression 58: closes idle HTTP keep-alive connections immediately on stopHttpServer', async (t) => {
    // Regression: stopHttpServer called httpServer.close() without closeAllConnections(), letting keep-alive sockets
    // block clean shutdown.
    const origCreateServer = http.createServer;
    /** @type {http.Server|null} */
    let boundServer = null;
    let closeAllCalled = false;

    t.mock.method(http, 'createServer', (listener) => {
      const srv = origCreateServer(listener);
      boundServer = srv;
      const origListen = srv.listen.bind(srv);
      const origCloseAll = srv.closeAllConnections.bind(srv);
      srv.listen = /** @type {*} */ ((_p, _h, cb) => origListen(0, '127.0.0.1', cb));
      srv.closeAllConnections = () => {
        closeAllCalled = true;
        return origCloseAll();
      };
      return srv;
    });

    startHttpServer([], {wakeCameraExternal: () => ({}), isShuttingDown: () => false});
    assert.ok(boundServer);
    const srv = /** @type {http.Server} */ (boundServer);
    if (!srv.listening) {
      await new Promise((resolve) => srv.once('listening', resolve));
    }
    const addr = /** @type {net.AddressInfo} */ (srv.address());

    // Open a raw TCP HTTP/1.1 keep-alive connection and leave it open after reading the 200 response
    const clientSock = net.connect(addr.port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      let buf = '';
      clientSock.on('error', reject);
      clientSock.on('connect', () => {
        clientSock.write('GET /api/config HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
      });
      clientSock.on('data', (chunk) => {
        buf += String(chunk);
        if (buf.includes('"cameras":[]')) {
          resolve(null);
        }
      });
    });

    const serverClosed = new Promise((resolve) => srv.once('close', resolve));
    stopHttpServer();
    if (!closeAllCalled) {
      clientSock.destroy();
    }
    await serverClosed;
    assert.equal(closeAllCalled, true);
    clientSock.destroy();
  });
});
