/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 36. Same-Camera Backfill Chronological Event Ordering & Deferred Live Wakes
 * (docs/regression/36-same-camera-backfill-chronological-event-order.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {log} = require('../../src/logger');
const {Camera, WakeRequest} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {
  initOrchestrator,
  onEvent,
  wakeCameraExternal,
  stop,
  processBackfillQueue,
  arbitrate,
} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 36. Same-Camera Backfill Chronological Event Ordering & Deferred Live Wakes', () => {
  it(
    'Regression 36: defers post-backfill live wakes in chronological order ' +
      'across clip drains, PIR upgrades, and disconnects',
    () => {
      // Regression: same-camera /api/wake during STREAM_MODES.DOWNLOAD was wiped by endSession zeroing motionUntil
      // or decayed while Event 1 drained. Verify full-duration promotion after Event 1 (and any earlier Job 2).
      const cam = new Camera({
        serial: 'T8161T0000000095',
        name: 'garage_seq',
        mode: 'auto',
        station_serial: 'T8030P0000000095',
      });
      cam.updateDiscoveredRtspConfig('T8030P0000000095', 'rtsp://192.0.2.10/live0');

      const t0 = 100000;
      cam.setReason('event 1 clip');
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/ev1.zxvideo',
          cipherId: 1,
          clipMs: t0 - 15000,
          event: 'motion detected',
          personName: '',
          reason: 'event 1 clip',
        },
        false,
        t0
      );

      // Coalesce view + motion deferred wakes: motion wins createEvent, max duration (25s), and highest priority (250)
      cam.schedulePostBackfillWake(
        WakeRequest.view('viewer peek', 15000).withInitiator('api-wake').withCreateEvent(false).build(),
        t0 + 1000
      );
      const coalescedDur = cam.schedulePostBackfillWake(
        WakeRequest.motion('driveway beam', 25000)
          .withInitiator('api-wake')
          .withPriority(250)
          .withCreateEvent(true)
          .build(),
        t0 + 2000
      );
      assert.equal(coalescedDur, 25000);
      assert.equal(
        cam.getReason(),
        'backfill: event 1 clip',
        'Deferred wake must not overwrite active backfill reason'
      );

      // Finish Event 1 40s later (> 25s requested duration): deferred wake starts fresh 25s hold at t0 + 40000!
      cam.endSession(t0 + 40000, true, false, 'download');
      assert.equal(cam.wantsRtspWake(t0 + 40000), true);
      assert.equal(
        cam.getMotionUntil(),
        t0 + 65000,
        'Deferred wake must grant full 25s duration starting after Event 1 ends'
      );
      assert.equal(cam.getReason(), 'driveway beam');

      // Case 2: /api/wake at t+1s followed by Eufy PIR at t+3s during DOWNLOAD -> absorbed into Job 2 BackfillJob
      const t2 = 300000;
      cam.setMotionUntil(0);
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/ev1_b.zxvideo',
          cipherId: 2,
          clipMs: t2 - 15000,
          event: 'motion detected',
          personName: '',
          reason: 'ev1_b',
        },
        false,
        t2
      );
      cam.schedulePostBackfillWake(
        WakeRequest.motion('gate sensor', 30000)
          .withInitiator('api-wake')
          .withPriority(250)
          .withCreateEvent(true)
          .build(),
        t2 + 1000
      );
      cam.queueEventBackfill(t2 + 3000, 'person detected', 'Bob', 'person detected (Bob)', 200, true);
      assert.equal(
        cam.getPendingBackfillJob()?.priority,
        250,
        'PIR Job 2 absorbs higher priority from preceding deferred wake'
      );
      assert.equal(cam.getPendingBackfillJob()?.personName, 'Bob');
      cam.recordMotionCleared(t2 + 8000, 4000, 10000, 'person detected');

      // Case 3: A later /api/wake at t+20s (after Job 2 settled at t+8s) waits behind Job 2 (1 -> 2 -> 3)!
      cam.schedulePostBackfillWake(
        WakeRequest.motion('late sensor', 20000)
          .withInitiator('api-wake')
          .withPriority(250)
          .withCreateEvent(true)
          .build(),
        t2 + 20000
      );
      cam.endSession(t2 + 21000, true, false, 'download');
      assert.equal(
        cam.wantsWake(t2 + 21000),
        false,
        'Event 3 deferred wake must wait behind Event 2 pendingBackfill to preserve 1 -> 2 -> 3 order'
      );
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8161T0000000095',
          storagePath: '/zx/ev2_b.zxvideo',
          cipherId: 3,
          clipMs: t2 + 3500,
        }),
        true
      );
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t2 + 22000);
      cam.endSession(t2 + 30000, true, false, 'download');
      assert.equal(
        cam.wantsRtspWake(t2 + 30000),
        true,
        'Event 3 deferred wake promotes immediately once Event 2 backfill finishes'
      );
      assert.equal(cam.getMotionUntil(), t2 + 50000);

      // Station disconnect, offline transition, and shutdown clear any pending deferred wake
      cam.setMotionUntil(0);
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/ev1_c.zxvideo',
          cipherId: 4,
          clipMs: t2 + 60000,
          event: 'motion detected',
          personName: '',
          reason: 'ev1_c',
        },
        false,
        t2 + 70000
      );
      cam.schedulePostBackfillWake(
        WakeRequest.motion('disc wake', 20000).withInitiator('api-wake').withCreateEvent(true).build(),
        t2 + 71000
      );
      cam.handleStationDisconnected('ws_closed');
      cam.endSession(t2 + 72000, false, false, 'download');
      cam.clearPendingBackfill();
      assert.equal(cam.wantsWake(t2 + 72000), false, 'Station disconnect clears deferred post-backfill wake');

      cam.schedulePostBackfillWake(
        WakeRequest.motion('shutdown wake', 20000).withInitiator('api-wake').withCreateEvent(true).build(),
        t2 + 80000
      );
      cam.prepareForShutdown();
      cam.endSession(t2 + 81000, true, false, 'download');
      assert.equal(cam.wantsWake(t2 + 81000), false, 'Shutdown clears deferred post-backfill wake');
    }
  );

  it(
    'Regression 36: preserves chronological event order on p2p/rtsp/auto cameras when motion or ' +
      '/api/wake arrives during DOWNLOAD',
    async () => {
      // Regression: on non-"backfill" cameras in STREAM_MODES.DOWNLOAD, Eufy motion logged "already live" and mutated
      // Event 1's reason, 'rtsp livestream started' was dropped, and /api/wake was wiped by endSession.
      const p2pNoBf = new Camera({
        serial: 'T8214T0000000096',
        name: 'doorbell_nobf',
        mode: 'custom',
        use_rtsp: false,
        backfill_enabled: false,
        station_serial: 'T8030P0000000096',
      });
      const autoCam = new Camera({
        serial: 'T8161T0000000097',
        name: 'yard_auto',
        mode: 'auto',
        station_serial: 'T8030P0000000096',
      });
      autoCam.updateDiscoveredRtspConfig('T8030P0000000096', 'rtsp://192.0.2.10/live1');

      const infos = [];
      const origInfo = log.info;
      log.info = (_scope, msg) => {
        infos.push(String(msg));
      };

      try {
        class MockSeqWs {
          constructor() {
            this.readyState = 1;
            this.handlers = new Map();
          }
          on(ev, fn) {
            this.handlers.set(ev, fn);
          }
          send(raw, cb) {
            const msg = JSON.parse(raw);
            if (cb) cb();
            const h = this.handlers.get('message');
            if (h) {
              queueMicrotask(() => {
                h(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
              });
            }
          }
        }
        let wsInst = null;
        const cams = [p2pNoBf, autoCam];
        const bySn = new Map(cams.map((c) => [c.getSerial(), c]));
        initOrchestrator(cams, bySn, () => false);
        configureEufyClientHooks({
          cams,
          bySerial: bySn,
          isShuttingDown: () => false,
          WebSocket: function SeqWs() {
            wsInst = new MockSeqWs();
            return wsInst;
          },
        });
        connectWs();
        await wsInst.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        configureEufyClientHooks({isShuttingDown: () => false, wsReadyAt: Date.now() - 10000});

        // 1. autoCam in DOWNLOAD: Eufy motion queues Job 2 without logging "already live" or mutating Event 1 reason
        const now = Date.now();
        autoCam.setReason('ev1 clip');
        autoCam.beginBackfillDownload(
          {
            storagePath: '/zx/auto_seq1.zxvideo',
            cipherId: 1,
            clipMs: now - 15000,
            event: 'motion detected',
            personName: '',
            reason: 'ev1 clip',
          },
          false,
          now
        );
        infos.length = 0;
        onEvent({
          source: 'device',
          event: 'person detected',
          serialNumber: autoCam.getSerial(),
          state: true,
        });
        assert.equal(autoCam.getActiveMode(), 'download');
        assert.equal(autoCam.getReason(), 'backfill: ev1 clip');
        assert.equal(autoCam.hasPendingBackfill(), true);
        assert.equal(
          infos.some((m) => m.includes('already live')),
          false,
          'Eufy trigger during DOWNLOAD must not log misleading "already live" message'
        );

        // If Job 2 later exhausts 10 query attempts while a subsequent /api/wake (Event 3) is deferred behind it,
        // processBackfillQueue promotes Event 3 immediately so it is not stranded!
        onEvent({
          source: 'device',
          event: 'person detected',
          serialNumber: autoCam.getSerial(),
          state: false,
        });
        const tSettled = now + 10000;
        const wakeEv3 = wakeCameraExternal(autoCam, {
          durationMs: 25000,
          reason: 'yard sensor ev3',
          createEvent: true,
          delayMs: 0,
        });
        assert.equal(wakeEv3.status, 'scheduled');
        const dlFrame = Buffer.alloc(1382400, 0x44);
        autoCam.markP2pVideoPacketReceived(now + 500);
        autoCam.recordDecodedFrame(dlFrame, dlFrame, now + 500, '12:00');
        autoCam.markDownloadFinished(now + 1000);
        stop(autoCam, 'post-event clip download stream completed', false, 'eufy/download-finished');
        for (let i = 1; i <= 10; i++) {
          autoCam.beginBackfillDatabaseQuery(tSettled + i * 13000, 10);
        }
        await processBackfillQueue(tSettled + 150000);
        assert.equal(
          autoCam.getActiveMode(),
          'rtsp',
          'Exhausting Job 2 query attempts must promote and wake deferred Event 3 live'
        );
        stop(autoCam, 'cleanup autoCam', false, 'bridge-test');

        // 2. backfill_enabled: false camera in SIGUSR1 DOWNLOAD defers motion until DOWNLOAD ends
        const tNoBf = Date.now();
        p2pNoBf.setReason('sigusr1 test clip');
        p2pNoBf.beginBackfillDownload(
          {
            storagePath: '/zx/sigusr1.zxvideo',
            cipherId: 2,
            clipMs: tNoBf - 10000,
            event: 'backfill test',
            personName: '',
            reason: 'sigusr1 test clip',
          },
          true,
          tNoBf
        );
        onEvent({
          source: 'device',
          event: 'rings',
          serialNumber: p2pNoBf.getSerial(),
          state: true,
        });
        assert.equal(p2pNoBf.getActiveMode(), 'download', 'SIGUSR1 backfill finishes before deferred live ring wake');
        p2pNoBf.markP2pVideoPacketReceived(tNoBf + 500);
        p2pNoBf.recordDecodedFrame(dlFrame, dlFrame, tNoBf + 500, '12:00');
        p2pNoBf.markDownloadFinished(tNoBf + 1000);
        stop(p2pNoBf, 'post-event clip download stream completed', false, 'eufy/download-finished');
        arbitrate(Date.now());
        assert.equal(
          p2pNoBf.getActiveMode(),
          'p2p',
          'backfill_enabled: false camera wakes live P2P immediately after SIGUSR1 download completes'
        );
        stop(p2pNoBf, 'cleanup p2pNoBf', false, 'bridge-test');
      } finally {
        log.info = origInfo;
        configureEufyClientHooks({isShuttingDown: () => true});
      }
    }
  );
});
