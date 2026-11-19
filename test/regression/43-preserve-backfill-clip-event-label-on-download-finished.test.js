/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 43. Backfill Clip Event Label Preserved When Extending Frigate Events on Download
 * Finished (docs/regression/43-preserve-backfill-clip-event-label-on-download-finished.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {frigateEvent} = require('../../src/services/frigate-client');
const {
  initOrchestrator,
  wakeCameraExternal,
  processBackfillQueue,
  onEvent,
  stop,
} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 43. Backfill Clip Event Label on Download Finished', () => {
  it(
    'Regression 43: preserves the matched clip hardware event label when extending Frigate events on ' +
      'download finished after an /api/wake reason override',
    async (t) => {
      // Regression: handleDownloadFinishedEvent passed cam.getReason() ("backfill: <reason>") instead of
      // activeBackfillClip.event / evLabel into frigateEvent(), downgrading person/vehicle backfill clips to
      // "motion" when an /api/wake reason override was present and evUntil elapsed before download finished.
      t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 2000000});

      const advanceFakeClock = async (totalMs, stepMs = 200) => {
        for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
          t.mock.timers.tick(Math.min(stepMs, totalMs - elapsed));
          await Promise.resolve();
          await Promise.resolve();
        }
      };

      const stationSn = 'T8030P0000000221';
      const cam = new Camera({
        serial: 'T8214T0000000221',
        name: 'doorbell_dl_ext',
        mode: 'backfill',
        station_serial: stationSn,
      });

      class InstantMockWs {
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
          if (!h) return;
          queueMicrotask(() => {
            h(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
          });
        }
      }

      let wsInst = null;
      const testCams = [cam];
      const testBySn = new Map([[cam.getSerial(), cam]]);
      const createdEvents = [];
      const origFetch = global.fetch;
      global.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/api/events/')) {
          createdEvents.push({url: u, body: JSON.parse(opts.body)});
          return {
            ok: true,
            status: 200,
            async json() {
              return {event_id: 'ev-dl-ext-' + createdEvents.length};
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return [];
          },
          async text() {
            return '';
          },
        };
      };

      try {
        initOrchestrator(testCams, testBySn, () => false);
        configureEufyClientHooks({
          cams: testCams,
          bySerial: testBySn,
          isShuttingDown: () => false,
          WebSocket: function MockWs() {
            wsInst = new InstantMockWs();
            return wsInst;
          },
        });
        connectWs();
        await wsInst.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        configureEufyClientHooks({isShuttingDown: () => false, wsReadyAt: Date.now() - 10000});

        // 1. Eufy "person detected" (Alice) upgraded with /api/wake reason="driveway sensor"
        const t0 = Date.now();
        cam.queueEventBackfill(t0 - 20000, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
        const wakeRes = wakeCameraExternal(cam, {
          durationMs: 30000,
          reason: 'driveway sensor',
          createEvent: true,
          delayMs: 0,
        });
        assert.equal(wakeRes.status, 'backfill');
        assert.equal(cam.getPendingBackfillJob()?.event, 'person detected');
        assert.equal(cam.getPendingBackfillJob()?.reason, 'driveway sensor');

        cam.recordMotionCleared(t0 - 15000, 4000, 10000, 'person detected');
        assert.equal(
          cam.tryMatchBackfillCandidate({
            devSn: cam.getSerial(),
            storagePath: '/zx/person_long.zxvideo',
            cipherId: 1,
            clipMs: t0 - 19000,
          }),
          true
        );

        await processBackfillQueue(Date.now());
        assert.equal(cam.getActiveMode(), 'download');
        assert.equal(cam.getReason(), 'backfill: driveway sensor');

        const frameBuf = Buffer.alloc(FRAME, 0x77);
        cam.markP2pVideoPacketReceived(Date.now() + 100);
        cam.recordDecodedFrame(frameBuf, frameBuf, Date.now() + 100, '13:00');
        await advanceFakeClock(2500);
        assert.equal(createdEvents.length, 1, 'Initial backfill Frigate event must be filed');
        assert.equal(createdEvents[0].url.endsWith('/api/events/doorbell_dl_ext/person/create'), true);
        assert.equal(createdEvents[0].body.sub_label, 'Alice');

        // Advance past initial 36s evUntil window during a long clip transfer, then emit 'download finished'
        await advanceFakeClock(40000, 1000);
        assert.equal(cam.getFrigateEventState(Date.now()), 'idle');
        for (let i = 0; i < 300; i++) {
          cam.bufferDownloadFrame(frameBuf, 1800);
        }
        cam.recordDecodedFrame(frameBuf, frameBuf, Date.now(), '13:01');
        onEvent({
          source: 'device',
          event: 'download finished',
          serialNumber: cam.getSerial(),
        });
        await advanceFakeClock(2500);

        assert.equal(createdEvents.length, 2, 'Long buffered clip on download finished must extend Frigate event');
        assert.equal(
          createdEvents[1].url.endsWith('/api/events/doorbell_dl_ext/person/create'),
          true,
          'Extended Frigate event on download finished must preserve "person" label instead of downgrading to "motion"'
        );
        assert.equal(createdEvents[1].body.sub_label, 'Alice');

        stop(cam, 'post-event clip download stream completed', false, 'eufy/download-finished');
        await advanceFakeClock(60000, 1000);

        // 2. Upgraded non-motion evLabel ("car" from "vehicle detected") on a "motion detected" clip is also preserved
        createdEvents.length = 0;
        cam.beginBackfillDownload(
          {
            storagePath: '/zx/vehicle_upgrade.zxvideo',
            cipherId: 2,
            clipMs: Date.now() - 15000,
            event: 'motion detected',
            personName: '',
            reason: 'gate beam',
          },
          false,
          Date.now()
        );
        frigateEvent(cam, 'motion detected', '');
        frigateEvent(cam, 'vehicle detected', '');
        cam.markP2pVideoPacketReceived(Date.now() + 100);
        cam.recordDecodedFrame(frameBuf, frameBuf, Date.now() + 100, '13:02');
        await advanceFakeClock(2500);
        assert.equal(createdEvents.length, 1);
        assert.equal(createdEvents[0].url.endsWith('/api/events/doorbell_dl_ext/car/create'), true);

        await advanceFakeClock(40000, 1000);
        for (let i = 0; i < 300; i++) {
          cam.bufferDownloadFrame(frameBuf, 1800);
        }
        cam.recordDecodedFrame(frameBuf, frameBuf, Date.now(), '13:03');
        onEvent({
          source: 'device',
          event: 'download finished',
          serialNumber: cam.getSerial(),
        });
        await advanceFakeClock(2500);

        assert.equal(createdEvents.length, 2);
        assert.equal(
          createdEvents[1].url.endsWith('/api/events/doorbell_dl_ext/car/create'),
          true,
          'Extended Frigate event on download finished must preserve upgraded "car" label'
        );
      } finally {
        global.fetch = origFetch;
        if (cam.getFrigateEventTimer()) {
          clearTimeout(cam.getFrigateEventTimer());
          cam.setFrigateEventTimer(null);
        }
        cam.clearPendingBackfill();
        stop(cam, 'cleanup', false, 'bridge-test');
        await advanceFakeClock(1000);
        configureEufyClientHooks({isShuttingDown: () => true});
      }
    }
  );
});
