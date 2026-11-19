/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 28. Invalid `/api/wake` Targets, Malformed Payloads & Direct `rtsp_url` Handling
 * (docs/regression/28-api-wake-validation-and-direct-rtsp-handling.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {createHttpRequestHandler, resolveTargetSelection} = require('../../src/services/http-server');

installDefaultFetchStub();

describe('Regression 28. Invalid `/api/wake` Targets, Malformed Payloads & Direct `rtsp_url` Handling', () => {
  it(
    'Regression 28: enforces /api/wake hybrid direct rtsp_url handling, atomic target resolution, ' +
      'and HTTP error payloads',
    async () => {
      // Regression: /api/wake rejects exclusive direct rtsp_url targets (422), skips them in mixed/all
      // targets, rejects partial unknown names atomically (404), and validates malformed inputs (400/405/413/503)
      const {PassThrough} = require('node:stream');
      const eufyCam = new Camera({serial: 'T8161T0000000010', name: 'garage', title: 'Garage Camera', mode: 'rtsp'});
      eufyCam.updateDiscoveredRtspConfig('T8030P0000000010', 'rtsp://127.0.0.1:8554/garage');
      const directCam = new Camera({
        name: 'baby_cam',
        title: 'Baby Monitor',
        mode: 'rtsp',
        rtsp_url: 'rtsp://127.0.0.1:8554/baby',
      });
      const offlineCam = new Camera({
        serial: 'T8214T0000000011',
        name: 'doorbell',
        title: 'Front Doorbell',
        mode: 'p2p',
      });
      offlineCam.applyTelemetryProperties({state: 3, battery: 1, chargingStatus: 2}, false);
      const cams = [eufyCam, directCam, offlineCam];

      const dispatchCalls = [];
      let shuttingDown = false;
      const handler = createHttpRequestHandler(cams, {
        wakeCameraExternal: (cam, wakeReq) => {
          dispatchCalls.push({name: cam.getName(), wakeReq});
          if (cam === offlineCam) {
            return {
              camera: cam.getName(),
              title: cam.getDisplayTitle(),
              status: 'offline',
              mode: 'p2p',
              hold_secs: 0,
              delay_ms: 0,
              error: 'Camera is offline (device offline); telemetry refresh requested',
            };
          }
          return cam.toApiWakeResponse('waking', wakeReq.durationMs, 0);
        },
        isShuttingDown: () => shuttingDown,
      });

      const invokeHttp = async (method, url, body = null) => {
        const req = Object.assign(new PassThrough(), {method, url});
        const resHeaders = {};
        let statusCode = 0;
        let rawBody = '';
        const done = new Promise((resolve) => {
          const res = {
            setHeader(k, v) {
              resHeaders[String(k).toLowerCase()] = v;
            },
            writeHead(code, hdrs = {}) {
              statusCode = code;
              for (const [k, v] of Object.entries(hdrs)) {
                resHeaders[String(k).toLowerCase()] = v;
              }
            },
            end(chunk = '') {
              rawBody += String(chunk || '');
              resolve();
            },
          };
          void handler(req, res);
        });
        if (body !== null) {
          req.end(body);
        } else {
          req.end();
        }
        await done;
        return {status: statusCode, headers: resHeaders, json: JSON.parse(rawBody)};
      };

      // 1. resolveTargetSelection detects partial unknown targets without dropping typos
      assert.deepEqual(resolveTargetSelection('garage,nonexistent', cams).unknown, ['nonexistent']);
      assert.equal(resolveTargetSelection('all,typo', cams).unknown[0], 'typo');
      assert.equal(resolveTargetSelection('%E0%A4%A', cams).invalidEncoding, true);

      // 2. Method validation (405 + Allow header)
      const putRes = await invokeHttp('PUT', '/api/wake/garage', '{}');
      assert.equal(putRes.status, 405);
      assert.equal(putRes.headers.allow, 'POST, GET');
      assert.equal(putRes.json.error_code, 'METHOD_NOT_ALLOWED');

      // 3. Malformed URL encoding, invalid JSON, non-object JSON, oversized body, invalid query/body params
      const badUrlRes = await invokeHttp('POST', '/api/wake/%');
      assert.equal(badUrlRes.status, 400);
      assert.equal(badUrlRes.json.error_code, 'INVALID_TARGET_ENCODING');

      const badJsonRes = await invokeHttp('POST', '/api/wake/garage', '{broken');
      assert.equal(badJsonRes.status, 400);
      assert.equal(badJsonRes.json.error_code, 'INVALID_REQUEST');

      const arrayJsonRes = await invokeHttp('POST', '/api/wake/garage', '[]');
      assert.equal(arrayJsonRes.status, 400);
      assert.equal(arrayJsonRes.json.error_code, 'INVALID_REQUEST');

      const bigBodyRes = await invokeHttp('POST', '/api/wake/garage', 'x'.repeat(16385));
      assert.equal(bigBodyRes.status, 413);
      assert.equal(bigBodyRes.json.error_code, 'PAYLOAD_TOO_LARGE');

      const badDurationRes = await invokeHttp('POST', '/api/wake/garage', '{"duration": -5}');
      assert.equal(badDurationRes.status, 400);
      assert.equal(badDurationRes.json.error_code, 'INVALID_REQUEST');

      const badCreateEventRes = await invokeHttp('GET', '/api/wake/garage?create_event=maybe');
      assert.equal(badCreateEventRes.status, 400);
      assert.equal(badCreateEventRes.json.error_code, 'INVALID_REQUEST');

      // 4. Partial unknown targets fail atomically with 404 before waking valid sibling cameras
      const partialRes = await invokeHttp('POST', '/api/wake/garage,missing_cam', '{"duration": 30}');
      assert.equal(partialRes.status, 404);
      assert.equal(partialRes.json.error_code, 'CAMERA_NOT_FOUND');
      assert.deepEqual(partialRes.json.unknown, ['missing_cam']);
      assert.equal(dispatchCalls.length, 0, 'Partial unknown target must not wake valid cameras');

      // 5. Exclusive direct rtsp_url target fails with 422 UNSUPPORTED_OPERATION even while WS is disconnected
      const directRes = await invokeHttp('POST', '/api/wake/baby_cam', '{"duration": 30}');
      assert.equal(directRes.status, 422);
      assert.equal(directRes.json.ok, false);
      assert.equal(directRes.json.error_code, 'UNSUPPORTED_OPERATION');
      assert.equal(directRes.json.results[0].camera, 'baby_cam');
      assert.equal(directRes.json.results[0].status, 'unsupported');
      assert.equal(dispatchCalls.length, 0);

      // 6. External outages keep /healthz 200 ({ok: true}, without ws_connected or external status), while
      //    /api/wake on a Eufy target returns 503 WS_DISCONNECTED
      eufyCam.updateServiceHealth({frigateConnected: false, go2rtcConnected: false});
      const wsDownHealthRes = await invokeHttp('GET', '/healthz');
      assert.equal(wsDownHealthRes.status, 200);
      assert.deepEqual(wsDownHealthRes.json, {ok: true});
      assert.equal('ws_connected' in wsDownHealthRes.json, false);
      assert.equal(wsDownHealthRes.headers['content-length'], '11');
      assert.equal(wsDownHealthRes.headers['cache-control'], 'no-store');
      assert.equal(wsDownHealthRes.headers.connection, 'close');
      const wsDownRes = await invokeHttp('POST', '/api/wake/garage', '{}');
      assert.equal(wsDownRes.status, 503);
      assert.equal(wsDownRes.json.error_code, 'WS_DISCONNECTED');

      // Connect mock WS so remaining dispatch checks run
      const wsHandlers = new Map();
      let mockWs = null;
      configureEufyClientHooks({
        cams,
        bySerial: new Map(),
        isShuttingDown: () => false,
        WebSocket: function ReadyMockWs() {
          mockWs = this;
          this.readyState = 1;
          this.on = (ev, fn) => wsHandlers.set(ev, fn);
          this.send = (raw, cb) => {
            const msg = JSON.parse(raw);
            if (cb) cb();
            const onMsg = wsHandlers.get('message');
            if (onMsg) {
              queueMicrotask(() => {
                onMsg(
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: true,
                    result: msg.command === 'start_listening' ? {state: {devices: []}} : {},
                  })
                );
              });
            }
          };
        },
      });
      connectWs();
      await wsHandlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));

      try {
        // 7. Mixed /api/wake/all succeeds (200) and marks direct rtsp_url as unsupported without calling orchestrator
        const allRes = await invokeHttp('POST', '/api/wake/all', '{"duration": 25, "reason": "front gate"}');
        assert.equal(allRes.status, 200);
        assert.equal(allRes.json.ok, true);
        assert.deepEqual(
          dispatchCalls.map((c) => c.name),
          ['garage', 'doorbell']
        );
        const unsupportedItem = allRes.json.results.find((r) => r.camera === 'baby_cam');
        assert.equal(unsupportedItem.status, 'unsupported');
        assert.equal(unsupportedItem.mode, 'rtsp');

        // 8. Exclusive offline target returns 503 CAMERA_OFFLINE while still dispatching refresh hook
        dispatchCalls.length = 0;
        const offlineRes = await invokeHttp('POST', '/api/wake/doorbell', '{}');
        assert.equal(offlineRes.status, 503);
        assert.equal(offlineRes.json.ok, false);
        assert.equal(offlineRes.json.error_code, 'CAMERA_OFFLINE');
        assert.equal(offlineRes.json.results[0].status, 'offline');
        assert.equal(dispatchCalls.length, 1);

        // 9. Shutdown guard returns 503 on both /api/wake and /healthz
        shuttingDown = true;
        const shutdownHealthRes = await invokeHttp('GET', '/healthz');
        assert.equal(shutdownHealthRes.status, 503);
        assert.equal(shutdownHealthRes.json.ok, false);
        const shutdownRes = await invokeHttp('POST', '/api/wake/garage', '{}');
        assert.equal(shutdownRes.status, 503);
        assert.equal(shutdownRes.json.error_code, 'BRIDGE_SHUTTING_DOWN');
      } finally {
        configureEufyClientHooks({isShuttingDown: () => true});
        if (mockWs) {
          mockWs.readyState = 3;
        }
        if (wsHandlers.has('close')) {
          wsHandlers.get('close')();
        }
      }
    }
  );
});
