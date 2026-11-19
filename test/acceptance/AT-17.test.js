/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-17`: `POST /api/wake/:cameras`, Frigate Event Snapshots/Extensions, Auto-Masks &
 * `HA_WEBHOOK_URL` (docs/acceptance/AT-17.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-17.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {selectEncoderFrame} = require('../../src/media/encoder');
const {syncFrigateMotionMasks} = require('../../src/services/frigate-client');
const {notifyHA} = require('../../src/services/ha-notifier');
const {resolveTargetCameras, createHttpRequestHandler} = require('../../src/services/http-server');
const {wakeCameraExternal, stop, arbitrate, onEvent} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-17 (docs/acceptance/AT-17.md)', () => {
  it(
    'AT-17: Resolves /api/wake targets (RTSP before P2P), waits for real video or clean snapshot before ' +
      'filing Frigate events, upgrades/extends events, auto-syncs Frigate masks, and posts ha_webhook',
    async () => {
      const p2pCam = new Camera({
        serial: 'T8214T0000000029',
        name: 'doorbell',
        title: 'Front Doorbell',
        mode: 'p2p',
        card_theme: 'glance',
        card_position: 'bottom-left',
        auto_frigate_mask: true,
      });
      const rtspCam = new Camera({
        serial: 'T8161T0000000030',
        name: 'driveway',
        title: 'Front Driveway',
        mode: 'rtsp',
        card_theme: 'none',
        auto_frigate_mask: true,
      });
      rtspCam.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');

      // 1. resolveTargetCameras + RTSP-first sorting
      const targets = resolveTargetCameras('all', [p2pCam, rtspCam]).sort((a, b) => Camera.compareRtspFirst(a, b));
      assert.deepEqual(
        targets.map((c) => c.getName()),
        ['driveway', 'doorbell']
      );

      // 2. Clean event snapshot fallback + Frigate event upgrade/extension
      const t0 = 400000;
      const cleanSnap = Buffer.alloc(1382400, 0x55);
      const snapCam = new Camera(
        {serial: 'T8161T0000000031', name: 'porch', mode: 'rtsp', hold_secs: 60},
        {frame: cleanSnap, lastSeen: '12:00'},
        renderCameraCards
      );
      snapCam.beginSession('rtsp', t0, true);
      snapCam.setLiveCardSuppressed(true);
      assert.equal(selectEncoderFrame(snapCam, t0 + 100).frame, cleanSnap);
      snapCam.setLiveCardSuppressed(false);

      snapCam.setGotVideo(true);
      snapCam.setFirstVideoAt(t0 + 1000);
      snapCam.setFirstFrameAt(t0 + 1000);
      snapCam.setMotionUntil(t0 + 60000);
      assert.equal(snapCam.tryUpgradeOrQueueFrigateEvent('motion', '', t0 + 1000).status, 'queued');
      snapCam.beginFrigateSnapshotWait();
      snapCam.completeFrigateEventFiling(t0 + 2000, 15);
      snapCam.setMotionUntil(t0 + 95000);
      assert.equal(
        snapCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', t0 + 25000).status,
        'queued',
        'AT-17: Re-queues Frigate event when label/person upgrades and hold extends past evUntil'
      );

      // 3. Auto-sync Frigate masks + ha_webhook
      const putPayloads = [];
      const webhookBodies = [];
      const origFetch = global.fetch;
      global.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.endsWith('/api/config')) {
          return {
            ok: true,
            async json() {
              return {
                cameras: {
                  doorbell: {motion: {mask: {}}, objects: {mask: {}}},
                  driveway: {
                    motion: {
                      mask: {
                        eufy_bridge_card: {enabled: true, coordinates: '0,0,1,1'},
                        user_trees: {enabled: true, coordinates: '0.5,0.5,1,1'},
                      },
                    },
                    objects: {
                      mask: {
                        eufy_bridge_card: {enabled: false, coordinates: '0,0,1,1'},
                        user_street: {enabled: true, coordinates: '0.2,0.2,0.4,0.4'},
                      },
                    },
                  },
                },
              };
            },
          };
        }
        if (u.includes('/api/config/set')) {
          putPayloads.push(JSON.parse(opts.body));
          return {
            ok: true,
            async text() {
              return '';
            },
          };
        }
        if (u.includes('webhook')) {
          webhookBodies.push(JSON.parse(opts.body));
          return {ok: true, status: 200};
        }
        throw new Error('Unexpected URL: ' + u);
      };
      try {
        await syncFrigateMotionMasks([p2pCam, rtspCam], true, false, 'http://frigate:5000');
        p2pCam.setFrigateEventLabel('person');
        p2pCam.setFrigateEventPerson('Alice');
        notifyHA(p2pCam, {event_id: 'evt-1', review_id: 'rev-1'}, 'http://ha:8123/api/webhook/test');
      } finally {
        global.fetch = origFetch;
      }
      assert.equal(putPayloads.length, 4);
      assert.equal(putPayloads[2].update_topic, 'config/cameras/driveway/motion');
      assert.equal(putPayloads[2].config_data.cameras.driveway.motion.mask.eufy_bridge_card, '');
      assert.equal(putPayloads[2].config_data.cameras.driveway.motion.mask.user_trees, undefined);
      assert.equal(putPayloads[3].update_topic, 'config/cameras/driveway/objects');
      assert.equal(putPayloads[3].config_data.cameras.driveway.objects.mask.eufy_bridge_card, '');
      assert.equal(putPayloads[3].config_data.cameras.driveway.objects.mask.user_street, undefined);
      assert.equal(webhookBodies.length, 1);
      assert.equal(webhookBodies[0].event_id, 'evt-1');

      // 4. Hybrid direct rtsp_url handling, atomic unknown targets, and HTTP error responses on /api/wake
      const {PassThrough} = require('node:stream');
      const directCam = new Camera({
        name: 'nursery',
        title: 'Nursery Monitor',
        mode: 'rtsp',
        rtsp_url: 'rtsp://127.0.0.1:8554/nursery',
      });
      const {wsInstance} = await setupAcceptanceHarness([rtspCam, p2pCam, directCam]);
      try {
        const directWakeResp = wakeCameraExternal(directCam, {
          durationMs: 30000,
          reason: 'direct wake check',
          createEvent: true,
        });
        assert.equal(directWakeResp.status, 'unsupported');
        assert.equal(directWakeResp.hold_secs, 0);
        assert.equal(directCam.isSessionActive(), false);
        assert.equal(directCam.getFrigateEventTimer(), null);

        const wakeHandler = createHttpRequestHandler([rtspCam, p2pCam, directCam], {
          wakeCameraExternal,
          isShuttingDown: () => false,
        });
        const callWakeEndpoint = async (method, url, body = null) => {
          const req = Object.assign(new PassThrough(), {method, url});
          const headers = {};
          let status = 0;
          let payload = '';
          const done = new Promise((resolve) => {
            const res = {
              setHeader(k, v) {
                headers[String(k).toLowerCase()] = v;
              },
              writeHead(code, hdrs = {}) {
                status = code;
                for (const [k, v] of Object.entries(hdrs)) {
                  headers[String(k).toLowerCase()] = v;
                }
              },
              end(chunk = '') {
                payload += String(chunk || '');
                resolve();
              },
            };
            void wakeHandler(req, res);
          });
          req.end(body !== null ? body : undefined);
          await done;
          return {status, headers, json: JSON.parse(payload)};
        };

        const directOnlyHttp = await callWakeEndpoint('POST', '/api/wake/nursery', '{"duration": 30}');
        assert.equal(directOnlyHttp.status, 422);
        assert.equal(directOnlyHttp.json.ok, false);
        assert.equal(directOnlyHttp.json.error_code, 'UNSUPPORTED_OPERATION');
        assert.equal(directOnlyHttp.json.results[0].status, 'unsupported');

        const partialMissHttp = await callWakeEndpoint('POST', '/api/wake/driveway,missing_cam', '{"duration": 30}');
        assert.equal(partialMissHttp.status, 404);
        assert.equal(partialMissHttp.json.error_code, 'CAMERA_NOT_FOUND');
        assert.deepEqual(partialMissHttp.json.unknown, ['missing_cam']);
        assert.equal(rtspCam.isSessionActive(), false);

        const badPercentHttp = await callWakeEndpoint('POST', '/api/wake/%');
        assert.equal(badPercentHttp.status, 400);
        assert.equal(badPercentHttp.json.error_code, 'INVALID_TARGET_ENCODING');

        const badJsonHttp = await callWakeEndpoint('POST', '/api/wake/driveway', '{invalid');
        assert.equal(badJsonHttp.status, 400);
        assert.equal(badJsonHttp.json.error_code, 'INVALID_REQUEST');

        const tooBigHttp = await callWakeEndpoint('POST', '/api/wake/driveway', 'a'.repeat(16385));
        assert.equal(tooBigHttp.status, 413);
        assert.equal(tooBigHttp.json.error_code, 'PAYLOAD_TOO_LARGE');

        const badMethodHttp = await callWakeEndpoint('DELETE', '/api/wake/driveway');
        assert.equal(badMethodHttp.status, 405);
        assert.equal(badMethodHttp.headers.allow, 'POST, GET');

        const allWakeHttp = await callWakeEndpoint('POST', '/api/wake/all', '{"duration": 30, "create_event": false}');
        assert.equal(allWakeHttp.status, 200);
        assert.equal(allWakeHttp.json.ok, true);
        assert.equal(allWakeHttp.json.results.find((r) => r.camera === 'nursery').status, 'unsupported');
        assert.equal(directCam.isSessionActive(), false);

        // Verify /api/wake during STREAM_MODES.DOWNLOAD on rtsp/p2p cameras preserves chronological order
        stop(rtspCam, 'reset before download wake test', false, 'bridge-test');
        stop(p2pCam, 'reset before download wake test', false, 'bridge-test');
        rtspCam.clearApiWakeTimer();
        p2pCam.clearApiWakeTimer();
        const tDlWake = Date.now();
        rtspCam.beginSession('download', tDlWake - 100, true);
        stop(rtspCam, 'clear station pacing before download wake test', false, 'eufy/download-finished');
        rtspCam.beginBackfillDownload(
          {
            storagePath: '/zx/rtsp_ev1.zxvideo',
            cipherId: 21,
            clipMs: tDlWake - 20000,
            event: 'motion detected',
            personName: '',
            reason: 'ev1 clip',
          },
          false,
          tDlWake
        );
        const deferredHttp = await callWakeEndpoint(
          'POST',
          '/api/wake/driveway',
          '{"duration": 20, "reason": "driveway beam", "create_event": true}'
        );
        assert.equal(deferredHttp.status, 200);
        assert.equal(
          deferredHttp.json.results[0].status,
          'scheduled',
          'AT-17: /api/wake on rtsp/p2p camera in backfill download without hardware trigger returns scheduled'
        );
        assert.equal(
          rtspCam.getActiveMode(),
          'download',
          'AT-17: /api/wake must let Event 1 backfill download finish first'
        );
        assert.equal(rtspCam.getReason(), 'backfill: ev1 clip');
        // Finish Event 1 30s later (> 20s requested duration) -> Event 2 wakes live RTSP for full 20s!
        const dlFrame = Buffer.alloc(1382400, 0x33);
        rtspCam.markP2pVideoPacketReceived(tDlWake + 500);
        rtspCam.recordDecodedFrame(dlFrame, dlFrame, tDlWake + 500, '12:00');
        rtspCam.markDownloadFinished(tDlWake + 1000);
        stop(rtspCam, 'post-event clip download stream completed', false, 'eufy/download-finished');
        arbitrate(Date.now());
        assert.equal(
          rtspCam.getActiveMode(),
          'rtsp',
          'AT-17: Deferred /api/wake wakes live RTSP immediately after Event 1 backfill finishes'
        );
        assert.equal(rtspCam.getReason(), 'driveway beam');
        stop(rtspCam, 'cleanup deferred rtsp wake', false, 'bridge-test');

        // When an unexpired Eufy hardware trigger IS recording Event 2 during DOWNLOAD, /api/wake upgrades BackfillJob
        const tDlTrig = Date.now();
        p2pCam.beginBackfillDownload(
          {
            storagePath: '/zx/p2p_ev1.zxvideo',
            cipherId: 22,
            clipMs: tDlTrig - 20000,
            event: 'motion detected',
            personName: '',
            reason: 'ev1 doorbell',
          },
          false,
          tDlTrig
        );
        onEvent({
          source: 'device',
          event: 'person detected',
          serialNumber: p2pCam.getSerial(),
          state: true,
        });
        const bfUpgradeHttp = await callWakeEndpoint(
          'POST',
          '/api/wake/doorbell',
          '{"duration": 30, "reason": "porch beam", "create_event": true}'
        );
        assert.equal(bfUpgradeHttp.status, 200);
        assert.equal(
          bfUpgradeHttp.json.results[0].status,
          'backfill',
          'AT-17: /api/wake during backfill download with active Eufy hardware trigger stays in backfill mode'
        );
        assert.equal(p2pCam.getPendingBackfillJob()?.reason, 'porch beam');
        p2pCam.clearPendingBackfill();
      } finally {
        p2pCam.clearApiWakeTimer();
        stop(rtspCam, 'cleanup', false, 'bridge-test');
        stop(p2pCam, 'cleanup', false, 'bridge-test');
        if (wsInstance) {
          wsInstance.readyState = 3;
          if (wsInstance.handlers.has('close')) {
            wsInstance.handlers.get('close')();
          }
        }
      }
    }
  );
});
