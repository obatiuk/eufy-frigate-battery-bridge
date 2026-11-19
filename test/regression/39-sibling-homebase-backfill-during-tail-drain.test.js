/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 39. Sibling HomeBase Backfill Unblocked During Tail Frame Drain
 * (docs/regression/39-sibling-homebase-backfill-during-tail-drain.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {Camera, SESSION_STATES} = require('../../src/domain/camera');

describe('Regression 39. Sibling HomeBase Backfill Unblocked During Tail Frame Drain', () => {
  it(
    'Regression 39: unblocks sibling HomeBase backfill queries and ' +
      'downloads while a camera drains tail frames from RAM',
    () => {
      // Regression: isBlockingStationBackfill checked usesP2pSlot() instead of isOccupyingStationP2pChannel(),
      // blocking other cameras on the same HomeBase from querying or downloading clips during DRAINING_BACKFILL_TAIL.
      const camA = new Camera({
        serial: 'T8214T0000000101',
        name: 'doorbell_a',
        mode: 'backfill',
        station_serial: 'T8030P0000000050',
      });
      const camB = new Camera({
        serial: 'T8160T0000000102',
        name: 'porch_b',
        mode: 'p2p',
        station_serial: 'T8030P0000000050',
      });
      const allCams = [camA, camB];
      const t0 = 900000;

      camB.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
      camB.recordMotionCleared(t0 + 5000, 4000, 10000, 'person detected');

      // Simulate camA having a recent sleptAt (< 2s ago) before starting its backfill download
      camA.setSleptAt(t0 + 19000);
      camA.beginBackfillDownload(
        {
          storagePath: '/zx/cam_a_clip1.zxvideo',
          cipherId: 1,
          clipMs: t0 - 10000,
          event: 'rings',
          personName: '',
          reason: 'rings',
        },
        false,
        t0 + 19500
      );
      const frame0 = Buffer.alloc(FRAME, 0x88);
      camA.recordDecodedFrame(frame0, frame0, t0 + 19700, '12:20');
      camA.bufferDownloadFrame(frame0, 1800);

      // While camA is actively transferring over HomeBase P2P (!downloadFinished), sibling camB is blocked
      assert.equal(camA.isBlockingStationBackfill('T8030P0000000050', t0 + 20000, 2000), true);
      assert.equal(camB.canQueryBackfillNow(allCams, t0 + 20000, 4000, 12000, 2000), false);

      // Once camA reaches DRAINING_BACKFILL_TAIL (downloadFinished=true), HomeBase P2P channel is free for camB
      camA.markDownloadFinished(t0 + 20100);
      assert.equal(camA.getStoredSessionState(), SESSION_STATES.DRAINING_BACKFILL_TAIL);
      assert.equal(camA.isBlockingStationBackfill('T8030P0000000050', t0 + 20200, 2000), false);
      assert.equal(camB.canQueryBackfillNow(allCams, t0 + 20200, 4000, 12000, 2000), true);

      assert.equal(
        camB.tryMatchBackfillCandidate({
          devSn: 'T8160T0000000102',
          storagePath: '/zx/cam_b_clip1.zxvideo',
          cipherId: 2,
          clipMs: t0 + 1000,
        }),
        true
      );
      assert.equal(camB.canStartBackfillDownloadNow(allCams, t0 + 20300, 2000), true);
      assert.equal(
        camA.canStartBackfillDownloadNow(allCams, t0 + 20300, 2000),
        false,
        'Draining camA itself must not start a second download until its active clip finishes draining'
      );
    }
  );
});
