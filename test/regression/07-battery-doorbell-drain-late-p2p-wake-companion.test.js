/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 7. Battery Doorbell Drain, Late P2P Wake & Companion-Event Backfill Cancellation
 * (docs/regression/07-battery-doorbell-drain-late-p2p-wake-companion.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');

describe('Regression 7. Battery Doorbell Drain, Late P2P Wake & Companion-Event Backfill Cancellation', () => {
  it(
    'Regression 7: keeps pendingBackfill across companion AI events before sustained live video decodes ' +
      'and prevents RTSP sessions from blocking sibling P2P backfills',
    () => {
      // Regression: companion AI events arriving 3-5s after motion detected cleared pendingBackfill before any live
      // video decoded, and active/slept RTSP cameras delayed sibling P2P backfills on the same HomeBase.
      const liveP2pCam = new Camera({
        serial: 'T8214T0000070001',
        name: 'doorbell_comp',
        mode: 'p2p',
        hold_secs: 60,
        station_serial: 'T8030P0000070000',
      });
      const rtspSibling = new Camera({
        serial: 'T8161T0000070002',
        name: 'driveway_rtsp',
        mode: 'rtsp',
        station_serial: 'T8030P0000070000',
      });

      const t0 = 100000;
      liveP2pCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      liveP2pCam.beginSession('p2p', t0, false);
      liveP2pCam.applyMotionTrigger(t0 + 4000, 'person detected', 200, 'eufy/companion', 60000, 5000, true, 'Alice');
      assert.equal(liveP2pCam.hasPendingBackfill(), true);

      rtspSibling.beginSession('rtsp', t0, false);
      assert.equal(rtspSibling.isBlockingStationBackfill('T8030P0000070000', t0 + 1000, 5000, false), false);
      rtspSibling.endSession(t0 + 2000, true, false, 'rtsp');
      assert.equal(rtspSibling.isBlockingStationBackfill('T8030P0000070000', t0 + 3000, 5000, false), false);
    }
  );
});
