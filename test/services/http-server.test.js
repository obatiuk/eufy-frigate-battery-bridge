/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for HTTP wake target resolution and /api/config + /api/status payload builders
 * (src/services/http-server.js, api-payloads.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {
  normalizeLookupKey,
  resolveTargetCameras,
  buildHealthPayload,
  buildConfigPayload,
  buildStatusPayload,
  createHttpRequestHandler,
} = require('../../src/services/http-server');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('HTTP Wake Target Resolution & Server Endpoints (src/services/http-server.js)', () => {
  it('resolves "all", comma-separated names, hardware serials, and slugified titles without duplicates', () => {
    // Verify: resolves "all", comma-separated names, hardware serials, and slugified titles without duplicates.
    const cam1 = new Camera({serial: 'T8161T0000000000', name: 'driveway', title: 'Front Driveway'});
    const cam2 = new Camera({serial: 'T8214T2222222222', name: 'doorbell', title: 'Main Entrance Doorbell'});
    const cams = [cam1, cam2];

    assert.equal(normalizeLookupKey('Front Driveway'), 'front_driveway');
    assert.deepEqual(resolveTargetCameras('all', cams), [cam1, cam2]);
    assert.deepEqual(resolveTargetCameras('T8214T2222222222', cams), [cam2]);
    assert.deepEqual(resolveTargetCameras('front-driveway,doorbell,driveway', cams), [cam1, cam2]);
    assert.deepEqual(resolveTargetCameras('nonexistent_cam', cams), []);

    const health = buildHealthPayload(false);
    assert.deepEqual(health, {ok: true});
    assert.equal('ws_connected' in health, false);
    assert.equal('uptime_secs' in health, false);
    assert.equal('version' in health, false);
    assert.equal('commit' in health, false);

    cam1.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://admin:secret@192.168.1.50/live0');
    const cfgPayload = buildConfigPayload(cams);
    assert.equal(typeof cfgPayload.version, 'string');
    assert.ok(cfgPayload.version.length > 0);
    assert.equal(typeof cfgPayload.commit, 'string');
    assert.ok(cfgPayload.commit.length > 0);
    assert.equal(typeof cfgPayload.log_level, 'string');
    assert.equal(typeof cfgPayload.live_fps, 'number');
    assert.equal(typeof cfgPayload.idle_fps, 'number');
    assert.equal(typeof cfgPayload.backfill_enabled, 'boolean');
    assert.equal(cfgPayload.track_stuck_spotlight, false);
    assert.equal(typeof cfgPayload.view_has_priority, 'boolean');
    assert.equal(typeof cfgPayload.snapshot_capture_delay_secs, 'number');
    assert.equal(typeof cfgPayload.view_cooldown_secs, 'number');
    assert.equal(Array.isArray(cfgPayload.cameras), true);
    assert.equal(cfgPayload.cameras.length, 2);
    assert.equal(cfgPayload.cameras[0].name, 'driveway');
    assert.equal(cfgPayload.cameras[0].track_stuck_spotlight, false);
    assert.equal('homebase_rtsp_url' in cfgPayload.cameras[0], false);
    assert.equal(cfgPayload.cameras[0].rtsp_url, 'rtsp://***@192.168.1.50/live0');
    assert.equal(cfgPayload.cameras[0].hold_secs, 30);
    assert.equal(cfgPayload.cameras[1].name, 'doorbell');
    assert.equal(cfgPayload.cameras[1].rtsp_url, null);

    // Verify direct rtsp_url camera is rejected by canServeWakeRequest while /healthz remains ok
    const directOnlyPayload = buildConfigPayload([
      new Camera({name: 'baby_crib', rtsp_url: 'rtsp://192.168.1.50/live0', card_theme: 'none'}),
    ]);
    assert.equal(directOnlyPayload.use_rtsp, null);
    assert.equal(directOnlyPayload.backfill_enabled, null);
    assert.equal(directOnlyPayload.telemetry_poll_secs, null);
    assert.equal(directOnlyPayload.low_battery_threshold, null);
    assert.equal(directOnlyPayload.card_show_on_live, null);
  });

  it(
    'keeps /healthz minimal for frequent container probes and exposes full runtime details on ' +
      'GET/HEAD /api/status',
    async () => {
      // Verify /healthz omits camera arrays to minimize per-probe overhead, while /api/status
      // exposes upstream services, stations, summary counts, and every configured camera's state/telemetry.
      const {PassThrough} = require('node:stream');
      const t0 = 200000;

      const directLiveCam = new Camera(
        {
          name: 'play_mat_camera',
          title: 'Play Mat Camera',
          mode: 'rtsp',
          rtsp_url: 'rtsp://user:pass@192.0.2.51/live0',
        },
        {frame: Buffer.alloc(FRAME, 0x11), lastSeen: '19:27'}
      );
      directLiveCam.beginSession('rtsp', t0 - 20000, true);
      directLiveCam.markRtspFrameReceived(t0 - 19500);

      const directDownCam = new Camera({
        name: 'kids_room_camera',
        title: 'Kids Room Camera',
        mode: 'rtsp',
        rtsp_url: 'rtsp://user:pass@192.0.2.52/live0',
      });
      directDownCam.recordRtspDirectProbeFailure('Connection refused');

      const sleepingEufyCam = new Camera({
        serial: 'T8161T0000000031',
        name: 'storage_cam',
        title: 'Storage Room Camera',
        station_serial: 'T8030T0000000030',
        mode: 'auto',
      });
      sleepingEufyCam.applyTelemetryProperties(
        {
          state: 1,
          model: 'T8161',
          softwareVersion: '3.4.3.0',
          battery: 96,
          chargingStatus: 2,
          wifiSignalLevel: 3,
          wifiRssi: -70,
          temperature: 20,
        },
        false,
        t0 - 10000
      );

      const waitingBfCam = new Camera({
        serial: 'T8214T0000000032',
        name: 'front_doorbell',
        title: 'Front Doorbell',
        station_serial: 'T8030T0000000030',
        mode: 'backfill',
      });
      waitingBfCam.applyTelemetryProperties(
        {state: 1, model: 'T8214', softwareVersion: '3.2.7.2', battery: 22, chargingStatus: 2},
        false,
        t0 - 10000
      );
      waitingBfCam.queueEventBackfill(t0 - 5000, 'person detected', '', 'person', 100, true);

      const offlineEufyCam = new Camera({
        serial: 'T8161T0000000033',
        name: 'shed_cam',
        title: 'Shed Camera',
        station_serial: 'T8030T0000000030',
        mode: 'p2p',
      });
      offlineEufyCam.applyTelemetryProperties({state: 3, battery: 1, chargingStatus: 2}, false, t0 - 10000);

      const cams = [directLiveCam, directDownCam, sleepingEufyCam, waitingBfCam, offlineEufyCam];

      // 1. /healthz payload is strictly {ok: true}/{ok: false} with zero external dependency or camera fields
      const minHealth = buildHealthPayload(false);
      assert.deepEqual(Object.keys(minHealth), ['ok']);
      assert.deepEqual(minHealth, {ok: true});
      assert.deepEqual(buildHealthPayload(true), {ok: false});
      assert.equal('ws_connected' in minHealth, false);
      assert.equal('uptime_secs' in minHealth, false);
      assert.equal('active_cameras' in minHealth, false);
      assert.equal('offline_cameras' in minHealth, false);

      // 2. buildStatusPayload includes services, stations, summary counts, and all 5 cameras
      const status = buildStatusPayload(cams, {shuttingDown: false, startMs: t0 - 60000, now: t0});
      assert.equal(status.ok, true);
      assert.equal(status.shutting_down, false);
      assert.equal(typeof status.version, 'string');
      assert.equal(typeof status.commit, 'string');
      assert.equal(status.uptime_secs, 60);
      assert.equal(typeof status.services.ws_connected, 'boolean');
      assert.equal(typeof status.services.initial_telemetry_loaded, 'boolean');
      assert.equal(status.services.frigate_connected, true);
      assert.equal(status.services.go2rtc_connected, true);
      assert.equal(status.stations.length, 1);
      assert.equal(status.stations[0].serial, 'T8030T0000000030');
      assert.deepEqual(status.stations[0].cameras, ['storage_cam', 'front_doorbell', 'shed_cam']);
      assert.equal(status.stations[0].p2p_busy, false);
      assert.equal(status.stations[0].active_p2p_camera, null);

      assert.equal(status.summary.total_cameras, 5);
      assert.equal(status.summary.streaming_cameras, 1);
      assert.equal(status.summary.waiting_cameras, 1);
      assert.equal(status.summary.sleeping_cameras, 1);
      assert.equal(status.summary.offline_cameras, 1);
      assert.equal(status.summary.low_battery_cameras, 1);
      assert.equal(status.summary.pending_backfills, 1);
      assert.equal(status.cameras.length, 5);
      assert.deepEqual(
        status.cameras.map((c) => [c.name, c.status]),
        [
          ['play_mat_camera', 'live'],
          ['kids_room_camera', 'disconnected'],
          ['storage_cam', 'asleep'],
          ['front_doorbell', 'waiting'],
          ['shed_cam', 'disconnected'],
        ]
      );
      assert.equal(status.cameras[0].rtsp_url, 'rtsp://***@192.0.2.51/live0');
      assert.equal(status.cameras[2].telemetry.battery_pct, 96);
      assert.equal(status.cameras[4].offline, true);
      assert.equal(status.cameras[4].offline_reason, 'offline (low battery)');

      // 3. Direct-RTSP-only configuration sets ws_connected/initial_telemetry_loaded to null and stations to []
      const directOnlyStatus = buildStatusPayload([directLiveCam], {shuttingDown: false, startMs: t0 - 5000, now: t0});
      assert.equal(directOnlyStatus.services.ws_connected, null);
      assert.equal(directOnlyStatus.services.initial_telemetry_loaded, null);
      assert.deepEqual(directOnlyStatus.stations, []);

      // 4. HTTP handler serves GET/HEAD /api/status, HEAD /healthz (empty body), 405 on POST, and 503 on shutdown
      let shuttingDown = false;
      const handler = createHttpRequestHandler(cams, {
        wakeCameraExternal: () => ({}),
        isShuttingDown: () => shuttingDown,
      });

      const invokeRaw = async (method, url) => {
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
        req.end();
        await done;
        return {status: statusCode, headers: resHeaders, body: rawBody};
      };

      const getStatusRes = await invokeRaw('GET', '/api/status');
      assert.equal(getStatusRes.status, 200);
      const parsedStatus = JSON.parse(getStatusRes.body);
      assert.equal(parsedStatus.ok, true);
      assert.equal(parsedStatus.cameras.length, 5);

      const headStatusRes = await invokeRaw('HEAD', '/api/status');
      assert.equal(headStatusRes.status, 200);
      assert.equal(headStatusRes.body, '');

      const headHealthRes = await invokeRaw('HEAD', '/healthz');
      assert.equal(headHealthRes.status, 200);
      assert.equal(headHealthRes.body, '');
      assert.equal(headHealthRes.headers['content-length'], '11');
      assert.equal(headHealthRes.headers.connection, 'close');

      const aliasHealthRes = await invokeRaw('GET', '/health?probe=1');
      assert.equal(aliasHealthRes.status, 200);
      assert.equal(aliasHealthRes.body, '{"ok":true}');

      const postHealthRes = await invokeRaw('POST', '/healthz');
      assert.equal(postHealthRes.status, 405);
      assert.equal(postHealthRes.headers.allow, 'GET, HEAD');
      assert.equal(JSON.parse(postHealthRes.body).error_code, 'METHOD_NOT_ALLOWED');

      const postStatusRes = await invokeRaw('POST', '/api/status');
      assert.equal(postStatusRes.status, 405);
      assert.equal(postStatusRes.headers.allow, 'GET, HEAD');
      assert.equal(JSON.parse(postStatusRes.body).error_code, 'METHOD_NOT_ALLOWED');

      shuttingDown = true;
      const downStatusRes = await invokeRaw('GET', '/api/status');
      assert.equal(downStatusRes.status, 503);
      const parsedDown = JSON.parse(downStatusRes.body);
      assert.equal(parsedDown.ok, false);
      assert.equal(parsedDown.shutting_down, true);
    }
  );
});

describe('HTTP API Payload Builders (src/services/api-payloads.js)', () => {
  it('builds the config and status payloads in api-payloads.js and keeps http-server.js exporting them', () => {
    // Verify: the read-only /api/config and /api/status payload builders live in their own module, and
    // http-server.js re-exports the identical functions so existing imports keep working.
    const payloads = require('../../src/services/api-payloads');
    const server = require('../../src/services/http-server');
    for (const name of ['buildConfigPayload', 'buildStatusPayload']) {
      assert.equal(typeof payloads[name], 'function', name + ' must be exported by api-payloads.js');
      assert.equal(server[name], payloads[name], name + ' must be re-exported unchanged by http-server.js');
    }
    const emptyConfig = payloads.buildConfigPayload([]);
    assert.ok(Object.isFrozen(emptyConfig));
    assert.deepEqual(emptyConfig.cameras, []);
    const emptyStatus = payloads.buildStatusPayload([], {shuttingDown: true, startMs: 1000, now: 61000});
    assert.equal(emptyStatus.ok, false);
    assert.equal(emptyStatus.shutting_down, true);
    assert.equal(emptyStatus.uptime_secs, 60);
    assert.deepEqual(emptyStatus.stations, []);
    assert.equal(emptyStatus.summary.total_cameras, 0);
  });

  it('closes all active keep-alive connections in stopHttpServer during shutdown', (t) => {
    // Verify stopHttpServer invokes both server.close() and server.closeAllConnections().
    const http = require('node:http');
    const {startHttpServer, stopHttpServer} = require('../../src/services/http-server');
    let closedCalled = false;
    let closedAllCalled = false;
    t.mock.method(http, 'createServer', () => ({
      on() {},
      listen() {},
      close() {
        closedCalled = true;
      },
      closeAllConnections() {
        closedAllCalled = true;
      },
    }));

    startHttpServer([], {wakeCameraExternal: () => ({}), isShuttingDown: () => false});
    stopHttpServer();
    assert.equal(closedCalled, true);
    assert.equal(closedAllCalled, true);
  });
});
