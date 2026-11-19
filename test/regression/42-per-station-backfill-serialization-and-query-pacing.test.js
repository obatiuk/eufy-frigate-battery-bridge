/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 42. Per-Station Backfill Serialization & HomeBase Database Query Pacing
 * (docs/regression/42-per-station-backfill-serialization-and-query-pacing.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {initOrchestrator, processBackfillQueue, onEvent, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 42. Per-Station Backfill Serialization & HomeBase Database Query Pacing', () => {
  it(
    'Regression 42: paces backfill queries across sibling cameras on the ' +
      'same HomeBase while isolating other stations',
    () => {
      // Regression: tracking lastBackfillQueryAt only per camera let sibling cameras on the same HomeBase hammer
      // station.connect + database_query_* back-to-back within the 4s cooldown and starved equal-priority siblings.
      const t0 = 5000000;
      const camA = new Camera({
        serial: 'T8214T0000000201',
        name: 'hb1_doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000000201',
      });
      const camB = new Camera({
        serial: 'T8160T0000000202',
        name: 'hb1_yard',
        mode: 'backfill',
        station_serial: 'T8030P0000000201',
      });
      const camOtherStation = new Camera({
        serial: 'T8160T0000000203',
        name: 'hb2_garage',
        mode: 'backfill',
        station_serial: 'T8030P0000000202',
      });
      const allCams = [camA, camB, camOtherStation];

      for (const c of allCams) {
        c.queueEventBackfill(t0 - 20000, 'person detected', '', 'person detected', 200, true);
        c.recordMotionCleared(t0 - 15000, 4000, 10000, 'person detected');
      }

      assert.equal(camA.canQueryBackfillNow(allCams, t0, 4000, 4000, 2000), true);
      assert.equal(camB.canQueryBackfillNow(allCams, t0, 4000, 4000, 2000), true);

      // camA queries HomeBase 1 at t0
      assert.equal(camA.beginBackfillDatabaseQuery(t0, 10).allowed, true);
      assert.equal(camB.getLastBackfillQueryAt(), 0);

      // Within 4000ms of camA's query, sibling camB on HomeBase 1 is paced, while HomeBase 2 is unaffected
      assert.equal(
        camB.canQueryBackfillNow(allCams, t0 + 1000, 4000, 4000, 2000),
        false,
        'Sibling camera on same HomeBase must wait for the 4000ms station query cooldown'
      );
      assert.equal(camB.canQueryBackfillNow(allCams, t0 + 3999, 4000, 4000, 2000), false);
      assert.equal(
        camOtherStation.canQueryBackfillNow(allCams, t0 + 1000, 4000, 4000, 2000),
        true,
        'Camera on a different HomeBase station must not be paced by HomeBase 1 query cooldown'
      );

      // At t0 + 4000ms, both camA and camB are eligible again, and equal-priority round-robin picks camB next
      assert.equal(camB.canQueryBackfillNow(allCams, t0 + 4000, 4000, 4000, 2000), true);
      const ordered = [camA, camB].sort(Camera.compareBackfillPriority);
      assert.equal(ordered[0], camB, 'Equal-priority cameras must round-robin by oldest lastBackfillQueryAt');

      // Urgent SIGUSR1 test backfill bypasses sibling query pacing
      camB.prepareSigUsr1BackfillTest(t0 + 4100);
      assert.equal(camA.beginBackfillDatabaseQuery(t0 + 4100, 10).allowed, true);
      assert.equal(camB.canQueryBackfillNow(allCams, t0 + 4200, 4000, 4000, 2000), true);
    }
  );

  it(
    'Regression 42: serializes processBackfillQueue steps per HomeBase station and paces queries ' +
      'across sibling cameras without blocking other stations',
    async () => {
      // Regression: processBackfillQueue lacked a per-station in-flight guard and tracked lastBackfillQueryAt per
      // camera rather than per station, allowing overlapping station.connect, database_query_*, and start_download
      // RPCs on the same HomeBase when housekeeping ticks or database query events arrived mid-step.
      const hb1Sn = 'T8030P0000000211';
      const hb2Sn = 'T8030P0000000212';
      const camA = new Camera({
        serial: 'T8214T0000000211',
        name: 'hb1_cam_a',
        mode: 'backfill',
        station_serial: hb1Sn,
      });
      const camB = new Camera({
        serial: 'T8160T0000000212',
        name: 'hb1_cam_b',
        mode: 'backfill',
        station_serial: hb1Sn,
      });
      const camC = new Camera({
        serial: 'T8160T0000000213',
        name: 'hb2_cam_c',
        mode: 'backfill',
        station_serial: hb2Sn,
      });

      const hb1PendingRpcs = [];
      const rpcLog = [];
      let holdHb1Rpcs = false;

      class ControlledBackfillWs {
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
          if (msg.command === 'set_api_schema' || msg.command === 'start_listening') {
            queueMicrotask(() => {
              h(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {
                    state: {
                      driver: {connected: true},
                      stations: [
                        {serialNumber: hb1Sn, connected: true},
                        {serialNumber: hb2Sn, connected: true},
                      ],
                      devices: [],
                    },
                  },
                })
              );
            });
            return;
          }
          const targetStation =
            msg.serialNumber === hb1Sn || msg.serialNumber === camA.getSerial() || msg.serialNumber === camB.getSerial()
              ? hb1Sn
              : hb2Sn;
          rpcLog.push({
            station: targetStation,
            command: msg.command,
            serialNumber: msg.serialNumber,
            serialNumbers: msg.serialNumbers || null,
          });
          if (targetStation === hb1Sn && holdHb1Rpcs) {
            hb1PendingRpcs.push({
              msg,
              resolve: (success = true) => {
                h(JSON.stringify({type: 'result', messageId: msg.messageId, success, result: {}}));
              },
            });
            return;
          }
          queueMicrotask(() => {
            h(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
          });
        }
      }

      let wsInst = null;
      const testCams = [camA, camB, camC];
      const testBySn = new Map(testCams.map((c) => [c.getSerial(), c]));
      const origFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return {event_id: 'ev-bf-serial'};
        },
        async text() {
          return '';
        },
      });

      try {
        initOrchestrator(testCams, testBySn, () => false);
        configureEufyClientHooks({
          cams: testCams,
          bySerial: testBySn,
          isShuttingDown: () => false,
          WebSocket: function MockWs() {
            wsInst = new ControlledBackfillWs();
            return wsInst;
          },
        });
        connectWs();
        await wsInst.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        await new Promise((resolve) => setImmediate(resolve));
        configureEufyClientHooks({isShuttingDown: () => false, wsReadyAt: Date.now() - 10000});

        const t0 = Date.now();
        for (const c of testCams) {
          c.queueEventBackfill(t0 - 20000, 'person detected', '', 'person detected', 200, true);
          c.recordMotionCleared(t0 - 15000, 4000, 10000, 'person detected');
        }
        rpcLog.length = 0;
        holdHb1Rpcs = true;

        // 1. Launch processBackfillQueue(t0): HomeBase 1 holds station.connect in flight while HomeBase 2 runs freely
        const p1 = processBackfillQueue(t0);
        await new Promise((resolve) => setImmediate(resolve));

        const hb2InitialCmds = rpcLog.filter((r) => r.station === hb2Sn).map((r) => r.command);
        assert.deepEqual(
          hb2InitialCmds,
          ['station.connect', 'station.database_query_by_date', 'station.database_query_latest_info'],
          'HomeBase 2 must query independently without waiting for slow HomeBase 1 RPCs'
        );
        assert.deepEqual(
          rpcLog.filter((r) => r.station === hb1Sn).map((r) => r.command),
          ['station.connect'],
          'HomeBase 1 must have only its single station.connect in flight'
        );

        // 2. Overlapping housekeeping calls while station.connect is in flight must NOT start a second query on HB1
        const p2 = processBackfillQueue(t0 + 500);
        const p3 = processBackfillQueue(t0 + 1000);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          rpcLog.filter((r) => r.station === hb1Sn).map((r) => r.command),
          ['station.connect'],
          'Concurrent processBackfillQueue calls must not dispatch overlapping HomeBase 1 RPCs'
        );

        // 3. Advance HB1 to database_query_by_date, then emit mid-query clip match for camB (triggers re-entrant call)
        assert.equal(hb1PendingRpcs.length, 1);
        hb1PendingRpcs.shift().resolve(true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          rpcLog.filter((r) => r.station === hb1Sn).map((r) => r.command),
          ['station.connect', 'station.database_query_by_date']
        );

        onEvent({
          source: 'station',
          serialNumber: hb1Sn,
          event: 'database query local',
          returnCode: 0,
          data: [
            {
              device_sn: camB.getSerial(),
              storage_path: '/zx/hb1_cam_b_clip.zxvideo',
              cipher_id: 7,
              start_time: Math.floor((t0 - 18000) / 1000),
            },
          ],
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(camB.getBackfillClip()?.storagePath, '/zx/hb1_cam_b_clip.zxvideo');
        assert.equal(
          rpcLog.some((r) => r.station === hb1Sn && r.command === 'device.start_download'),
          false,
          'Mid-query clip match must NOT dispatch device.start_download while database_query_by_date is in flight'
        );

        // Resolve database_query_by_date -> database_query_latest_info runs next -> still no start_download yet
        assert.equal(hb1PendingRpcs.length, 1);
        hb1PendingRpcs.shift().resolve(true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          rpcLog.filter((r) => r.station === hb1Sn).map((r) => r.command),
          ['station.connect', 'station.database_query_by_date', 'station.database_query_latest_info'],
          'database_query_latest_info must run before any coalesced start_download step'
        );

        // Resolve database_query_latest_info and let coalesced follow-up step dispatch device.start_download cleanly
        holdHb1Rpcs = false;
        assert.equal(hb1PendingRpcs.length, 1);
        hb1PendingRpcs.shift().resolve(true);
        await Promise.all([p1, p2, p3]);
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(
          rpcLog.filter((r) => r.station === hb1Sn).map((r) => r.command),
          [
            'station.connect',
            'station.database_query_by_date',
            'station.database_query_latest_info',
            'device.start_download',
          ],
          'Coalesced follow-up step must start_download strictly after database query RPCs complete'
        );
        assert.equal(camB.getActiveMode(), 'download');

        // Finish camB's download cleanly so HomeBase 1 P2P slot is idle again before t0 + 4000ms
        const dlFrame = Buffer.alloc(FRAME, 0x55);
        camB.markP2pVideoPacketReceived(t0 + 1200);
        camB.recordDecodedFrame(dlFrame, dlFrame, t0 + 1200, '12:30');
        camB.markDownloadFinished(t0 + 1400);
        stop(camB, 'post-event clip download stream completed', false, 'eufy/download-finished');
        await new Promise((resolve) => setImmediate(resolve));

        // 4. Per-station query pacing: queue a fresh settled job on camB (camB.lastBackfillQueryAt === 0),
        //    while HomeBase 1 queried at t0 -> < 4000ms dispatches zero HB1 queries, >= 4000ms allows one!
        camB.queueEventBackfill(t0 - 10000, 'motion detected', '', 'motion detected', 200, true);
        camB.recordMotionCleared(t0 - 5000, 4000, 10000, 'motion detected');
        assert.equal(camB.getLastBackfillQueryAt(), 0);
        rpcLog.length = 0;

        await processBackfillQueue(t0 + 2500);
        await processBackfillQueue(t0 + 3999);
        assert.equal(
          rpcLog.filter((r) => r.station === hb1Sn).length,
          0,
          'Station query cooldown (4000ms) must block sibling camB from querying HomeBase 1 early'
        );

        await processBackfillQueue(t0 + 4000);
        const hb1AfterCooldown = rpcLog.filter((r) => r.station === hb1Sn);
        assert.deepEqual(
          hb1AfterCooldown.map((r) => r.command),
          ['station.connect', 'station.database_query_by_date', 'station.database_query_latest_info'],
          'Once 4000ms elapses, HomeBase 1 allows exactly one paced query sequence'
        );
        assert.deepEqual(
          hb1AfterCooldown[1].serialNumbers,
          [camB.getSerial()],
          'Equal-priority round-robin selects sibling camB after camA queried at t0'
        );
      } finally {
        holdHb1Rpcs = false;
        while (hb1PendingRpcs.length > 0) {
          hb1PendingRpcs.shift().resolve(false);
        }
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        global.fetch = origFetch;
        for (const c of testCams) {
          if (c.getFrigateEventTimer()) {
            clearTimeout(c.getFrigateEventTimer());
            c.setFrigateEventTimer(null);
          }
          c.clearPendingBackfill();
          stop(c, 'cleanup', false, 'bridge-test');
        }
        configureEufyClientHooks({isShuttingDown: () => true});
      }
    }
  );
});
