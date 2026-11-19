/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 21. End-of-Hold Frigate Blind Spot, Stale Event Cooldown & No-Op Hold Extensions
 * (docs/regression/21-end-of-hold-frigate-blind-spot-and-stale-event-cooldown.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {runHousekeepingTick, initOrchestrator} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 21. End-of-Hold Frigate Blind Spot, Stale Event Cooldown & No-Op Hold Extensions', () => {
  it(
    'Regression 21: closes the end-of-hold Frigate poll blind spot, clears expired event cooldowns, and ' +
      'skips no-op hold extensions',
    () => {
      // Regression: (1) expired evUntil from a prior session triggered premature Frigate hold checks in the next
      // session, (2) the 4s Frigate poll cooldown blinded the final <4s of a hold window so active objects were missed
      // at hold expiry, and (3) extendActiveHold reported fake extensions or switched motion holds to viewer holds.
      const t0 = 1794513000000;
      const rtspCam = new Camera({
        serial: 'T8161T0000000091',
        name: 'storage_room',
        mode: 'rtsp',
      });

      // 1. Session 1 files a Frigate event (evUntil = t0 + 62000), then ends after video.
      rtspCam.setMotionUntil(t0 + 60000);
      rtspCam.setLastMotionAt(t0);
      rtspCam.setEventActive(true);
      rtspCam.beginSession('rtsp', t0, true);
      rtspCam.setGotVideo(true);
      rtspCam.tryUpgradeOrQueueFrigateEvent('motion', '', t0 + 2000);
      rtspCam.beginFrigateSnapshotWait();
      rtspCam.completeFrigateEventFiling(t0 + 2000, 15);
      assert.equal(rtspCam.getFrigateEventUntil(), t0 + 62000);
      rtspCam.endSession(t0 + 60000, true, false, 'rtsp');

      // Session 2 starts 30s later (t2 = t0 + 90000) after Session 1's evUntil has elapsed.
      const t2 = t0 + 90000;
      assert.equal(rtspCam.getFrigateEventState(t2), 'idle');
      assert.equal(
        rtspCam.getFrigateEventUntil(),
        0,
        'Advancing Frigate event state from COOLDOWN to IDLE must reset expired evUntil to 0'
      );

      rtspCam.setMotionUntil(t2 + 60000);
      rtspCam.setLastMotionAt(t2);
      rtspCam.setEventActive(true);
      rtspCam.beginSession('rtsp', t2, true);
      rtspCam.setGotVideo(true);
      rtspCam.tryUpgradeOrQueueFrigateEvent('motion', '', t2);
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 3000, 12000, 5000, 4000),
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'New session with 57s hold remaining and pending initial event must not poll Frigate early from a stale evUntil'
      );

      // 2. Final <4s of hold window: polled at t2 + 57000 (3s left), must bypass 4s cooldown once at t2 + 60000 expiry.
      rtspCam.beginFrigateSnapshotWait();
      rtspCam.completeFrigateEventFiling(t2 + 3000, 15);
      assert.deepEqual(rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 57000, 12000, 5000, 4000), {
        shouldPoll: true,
        needsTimeoutExtendCheck: true,
      });
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 58500, 12000, 5000, 4000),
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'Mid-window poll 1.5s later remains throttled while hold has not expired yet'
      );
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 60000, 12000, 5000, 4000),
        {shouldPoll: true, needsTimeoutExtendCheck: true},
        'Hold expiry at t2 + 60000 must run one final Frigate check even if polled 3s earlier (<4s cooldown)'
      );
      const afterExpiryPoll = rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 60500, 12000, 5000, 4000);
      assert.deepEqual(
        afterExpiryPoll,
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'Once the final expiry check ran for holdUntil, it must not re-poll in a loop when holdUntil did not increase'
      );
      assert.equal(Object.isFrozen(afterExpiryPoll), true);

      rtspCam.setExtendCheckInFlight(true);
      assert.equal(rtspCam.isExtendCheckInFlight(), true);
      rtspCam.setLastExtendCheckAt(0);
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 60000, 12000, 5000, 4000),
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'Overlapping Frigate extend checks must be suppressed while extendCheckInFlight is true'
      );
      rtspCam.setExtendCheckInFlight(false);

      // 3. Extending at/just after motionUntil expiry on a motion session must extend motionUntil, not viewUntil.
      const expiryExt = rtspCam.extendActiveHold(t2 + 60050);
      assert.equal(Object.isFrozen(expiryExt), true);
      assert.deepEqual(expiryExt, {extended: true, extendMs: 30000, holdSecs: 30});
      assert.equal(rtspCam.getMotionUntil(), t2 + 90050);
      assert.equal(
        rtspCam.getViewUntil(),
        0,
        'Expiry-tick hold extension on a motion session must keep extending motionUntil rather than setting viewUntil'
      );

      // 4. Backfill camera (30s base hold) woken for 60s via /api/wake with 54s left must report extended=false.
      const backfillCam = new Camera({
        serial: 'T8161T0000000092',
        name: 'garage_cam',
        mode: 'backfill',
      });
      backfillCam.setMotionUntil(t0 + 60000);
      backfillCam.setLastMotionAt(t0);
      backfillCam.setEventActive(true);
      backfillCam.beginSession('rtsp', t0, true);
      backfillCam.queueEventBackfill(t0, 'person detected', '', 'person detected', 100, false);

      const noopExt = backfillCam.extendActiveHold(t0 + 6000);
      assert.equal(Object.isFrozen(noopExt), true);
      assert.deepEqual(
        noopExt,
        {extended: false, extendMs: 0, holdSecs: 54},
        'extendActiveHold must report extended=false and extendMs=0 when wantUntil already exceeds nextUntil'
      );
      assert.equal(backfillCam.isRuntimeExtended(), false);
      assert.equal(
        backfillCam.hasPendingBackfill(),
        true,
        'No-op hold extension must not clear safety-net pendingBackfill'
      );
    }
  );

  it(
    'Regression 21: defers bridge-timer stop for a final Frigate check on hold expiry and suppresses no-op ' +
      'hold extension logs',
    async () => {
      // Regression: startHousekeepingLoop ran arbitrate() before evaluateActiveHoldExtension() and skipped Frigate
      // polls within 4s of the previous poll, killing active RTSP streams when a person entered in the final <4s.
      assert.equal(
        typeof runHousekeepingTick,
        'function',
        'runHousekeepingTick must be exported for deterministic tick testing'
      );

      const t0 = 1794513168000;
      const storageCam = new Camera({
        serial: 'T8161T0000000093',
        name: 'storage_room',
        mode: 'rtsp',
        startup_snapshot: false,
      });
      const garageCam = new Camera({
        serial: 'T8161T0000000094',
        name: 'garage_cam',
        mode: 'backfill',
        startup_snapshot: false,
      });
      storageCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://127.0.0.1:8554/storage');
      garageCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://127.0.0.1:8554/garage');

      const cams = [storageCam, garageCam];
      const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
      initOrchestrator(cams, bySerial, () => false);

      // Start both sessions at t0 with 60s hold (e.g. external /api/wake door-open trigger).
      storageCam.setMotionUntil(t0 + 60000);
      storageCam.setLastMotionAt(t0);
      storageCam.setEventActive(true);
      storageCam.setReason('door opening');
      storageCam.beginSession('rtsp', t0, true);
      storageCam.setGotVideo(true);
      storageCam.setFirstVideoAt(t0 + 2000);
      storageCam.setLastVideoAt(t0 + 57000);
      storageCam.setFrigateEventUntil(t0 + 60000);
      storageCam.setStoredFrigateEventState('cooldown');

      garageCam.setMotionUntil(t0 + 60000);
      garageCam.setLastMotionAt(t0);
      garageCam.setEventActive(true);
      garageCam.setReason('door opening');
      garageCam.beginSession('rtsp', t0, true);
      garageCam.setGotVideo(true);
      garageCam.setFirstVideoAt(t0 + 2000);
      garageCam.setLastVideoAt(t0 + 6000);
      garageCam.queueEventBackfill(t0, 'person detected', '', 'person detected', 100, false);

      /** @type {Record<string, Array<Record<string, *>>>} */
      const activeEventsByCam = {
        storage_room: [],
        garage_cam: [
          {
            id: '1794513173.0-garage-person',
            label: 'person',
            data: {type: 'object'},
            start_time: (t0 + 5000) / 1000,
            end_time: null,
          },
        ],
      };
      const infoLogs = [];
      const origFetch = global.fetch;
      const origLogInfo = log.info;
      const origDateNow = Date.now;
      let mockWallNow = 1700000000000;
      Date.now = () => mockWallNow;

      global.fetch = async (url) => {
        mockWallNow += 25;
        const u = String(url);
        if (u.includes('/api/events?cameras=storage_room')) {
          return {
            ok: true,
            async json() {
              return activeEventsByCam.storage_room;
            },
          };
        }
        if (u.includes('/api/events?cameras=garage_cam')) {
          return {
            ok: true,
            async json() {
              return activeEventsByCam.garage_cam;
            },
          };
        }
        return {
          ok: true,
          async json() {
            return [];
          },
          async text() {
            return '';
          },
        };
      };
      log.info = (scope, msg) => {
        infoLogs.push({scope: scope && scope.name ? scope.name : String(scope || ''), msg: String(msg)});
      };

      const isGarageHoldExtendedLog = (entry) =>
        entry.scope === 'garage_cam' && entry.msg.includes('extended stream hold by +');

      try {
        // 1. At t0 + 6000 (54s left on garageCam's 60s /api/wake hold, > 30s base hold), backfill object check polls
        //    Frigate: must confirm object detection without logging a bogus "+15s (holdExtendedTo=54s)" hold extension.
        garageCam.setFrigateEventUntil(t0 + 12000);
        runHousekeepingTick(t0 + 6000);
        await new Promise((r) => setImmediate(r));
        assert.equal(garageCam.getMotionUntil(), t0 + 60000);
        assert.equal(
          infoLogs.some(isGarageHoldExtendedLog),
          false,
          'No-op hold extension when 54s already remain on a 30s-hold camera must not log extended stream hold'
        );

        // 2. At t0 + 57000 (3s before storageCam's 60s hold expires), Frigate has no person yet.
        runHousekeepingTick(t0 + 57000);
        await new Promise((r) => setImmediate(r));
        assert.equal(storageCam.isSessionActive(), true);
        assert.equal(storageCam.getLastExtendCheckAt(), t0 + 57000);

        // 3. Person enters storage_room at t0 + 58500 (1.5s before hold expiry).
        activeEventsByCam.storage_room = [
          {
            id: '1794513226.5-storage-person',
            label: 'person',
            data: {type: 'object'},
            start_time: (t0 + 58500) / 1000,
            end_time: null,
          },
        ];
        storageCam.setLastVideoAt(t0 + 60000);
        garageCam.setLastVideoAt(t0 + 60000);

        // At t0 + 60000 (hold expiry, only 3s after t0 + 57000 poll), runHousekeepingTick must defer bridge-timer stop
        // while the final Frigate check is in flight, then extend motionUntil to t0 + 90000.
        runHousekeepingTick(t0 + 60000);
        assert.equal(
          storageCam.isSessionActive(),
          true,
          'arbitrate() must not kill storageCam synchronously before the final expiry Frigate check resolves'
        );
        assert.equal(storageCam.isExtendCheckInFlight(), true);

        await new Promise((r) => setImmediate(r));
        assert.equal(storageCam.isExtendCheckInFlight(), false);
        assert.equal(storageCam.isSessionActive(), true, 'Active person in Frigate must keep storageCam streaming');
        assert.equal(
          storageCam.getMotionUntil(),
          t0 + 90000,
          'storageCam motionUntil must extend by +30s to t0 + 90000'
        );
        assert.equal(storageCam.getViewUntil(), 0, 'Expiry extension on motion session must not set viewUntil');

        // 4. At t0 + 90000, person has left (Frigate idle); final expiry check resolves idle
        // and stops via bridge-timer.
        activeEventsByCam.storage_room = [];
        storageCam.setLastVideoAt(t0 + 90000);
        runHousekeepingTick(t0 + 90000);
        await new Promise((r) => setImmediate(r));
        assert.equal(
          storageCam.isSessionActive(),
          false,
          'Once Frigate confirms idle at t0 + 90000, storageCam must stop cleanly via bridge-timer'
        );
      } finally {
        if (storageCam.getFrigateEventTimer()) {
          clearTimeout(storageCam.getFrigateEventTimer());
          storageCam.setFrigateEventTimer(null);
        }
        if (garageCam.getFrigateEventTimer()) {
          clearTimeout(garageCam.getFrigateEventTimer());
          garageCam.setFrigateEventTimer(null);
        }
        if (storageCam.isSessionActive()) {
          storageCam.endSession(t0 + 91000, true, false, 'rtsp');
        }
        if (garageCam.isSessionActive()) {
          garageCam.endSession(t0 + 91000, true, false, 'rtsp');
        }
        initOrchestrator([], new Map(), () => true);
        Date.now = origDateNow;
        global.fetch = origFetch;
        log.info = origLogInfo;
      }
    }
  );
});
