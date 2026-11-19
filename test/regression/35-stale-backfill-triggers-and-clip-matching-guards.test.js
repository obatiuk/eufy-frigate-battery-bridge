/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 35. Stale Backfill Trigger Expiry, Timestamp-Less Clip Rejection & FSM Guards
 * (docs/regression/35-stale-backfill-triggers-and-clip-matching-guards.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {BACKFILL_STATES} = require('../../src/domain/backfill-job');
const {Camera} = require('../../src/domain/camera');

describe('Regression 35. Stale Backfill Trigger Expiry, Timestamp-Less Clip Rejection & FSM Guards', () => {
  it(
    'Regression 35: expires stale Eufy hardware triggers past max clip ' +
      'length and clears them on disconnect or offline',
    () => {
      // Regression: when a state=false clear event is lost on a backfill camera, activeTriggerEvents previously
      // stayed populated after DOWNLOAD endSession(), sticking hasActiveHardwareTriggers(), /api/wake routing,
      // and subsequent BackfillJob.activeEvents indefinitely.
      const cam = new Camera({serial: 'SN0000000072', name: 'doorbell_stale_trig', mode: 'backfill'});
      const t0 = 1000000;
      cam.setLastMotionAt(t0);
      cam.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
      assert.equal(cam.hasActiveHardwareTriggers(t0 + 5000), true);

      // Complete Clip 1 backfill download without ever receiving state=false for 'person detected'
      cam.beginBackfillDatabaseQuery(t0 + 40000);
      cam.tryMatchBackfillCandidate({
        devSn: 'SN0000000072',
        storagePath: '/zx/lost_clear_clip.zxvideo',
        cipherId: 1,
        clipMs: t0 + 1000,
      });
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t0 + 41000);
      cam.endSession(t0 + 55000, true, false, 'download');

      // Within max clip window (120s), un-cleared trigger is still considered active
      assert.equal(cam.hasActiveHardwareTriggers(t0 + 60000), true);

      // Past max clip length + margin (> 130s), stale trigger expires by clock
      const tAfterExpiry = t0 + 131000;
      assert.equal(
        cam.hasActiveHardwareTriggers(tAfterExpiry),
        false,
        'Stale hardware trigger must expire past Eufy max clip length + margin when state=false is lost'
      );
      assert.equal(
        cam.shouldBackfillOnlyOnApiWake(tAfterExpiry),
        false,
        'Expired hardware trigger must not force /api/wake into backfill-only mode'
      );
      assert.equal(
        cam.canPiggybackExternalP2pInBackfill(tAfterExpiry),
        true,
        'Expired hardware trigger must allow external Eufy app P2P piggybacking again'
      );

      // A fresh motion event at t0 + 200s must not inherit the expired 'person detected' in activeEvents
      const tFresh = t0 + 200000;
      cam.setLastMotionAt(tFresh);
      cam.queueEventBackfill(tFresh, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(tFresh + 5000, 4000, 10000, 'motion detected');
      assert.equal(
        cam.getPendingBackfillJob()?.state,
        BACKFILL_STATES.SETTLING,
        'Clearing the fresh trigger must transition BackfillJob to SETTLING without stalling on expired triggers'
      );
      cam.clearPendingBackfill();

      // Station / WebSocket disconnect clears active hardware triggers immediately
      const tDisc = t0 + 300000;
      cam.setLastMotionAt(tDisc);
      cam.queueEventBackfill(tDisc, 'rings', '', 'rings', 1000, true);
      assert.equal(cam.hasActiveHardwareTriggers(tDisc + 1000), true);
      cam.handleStationDisconnected('ws_disconnected');
      assert.equal(
        cam.hasActiveHardwareTriggers(tDisc + 1000),
        false,
        'handleStationDisconnected must clear active hardware triggers on WS/station close'
      );
      cam.clearPendingBackfill();

      // Camera going offline clears active hardware triggers immediately
      const tOff = t0 + 400000;
      cam.setLastMotionAt(tOff);
      cam.queueEventBackfill(tOff, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(cam.hasActiveHardwareTriggers(tOff + 1000), true);
      cam.applyTelemetryProperties({battery: 0, chargingStatus: 2}, true, tOff + 2000);
      assert.equal(cam.isDeviceOffline(), true);
      assert.equal(
        cam.hasActiveHardwareTriggers(tOff + 2000),
        false,
        'Device offline transition must clear active hardware triggers'
      );
    }
  );
});
