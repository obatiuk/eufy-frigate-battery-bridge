/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-15`: Proportional `20%` Safety-Net Backfill Cutoff & Bounded `120s` Recording
 * Wait (docs/acceptance/AT-15.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-15.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {BridgeConfigBuilder} = require('../../src/config');
const {BackfillJob} = require('../../src/domain/backfill-job');
const {Camera} = require('../../src/domain/camera');

describe('Locked Acceptance Criterion AT-15 (docs/acceptance/AT-15.md)', () => {
  it(
    'AT-15: Derives safety-net Backfill cancellation cutoff as 20% of configured clip/hold duration ' +
      '(clamped to 3s..15s) and caps Backfill recording wait at Eufy 120s max hardware clip limit (+4s) ' +
      'from initial trigger',
    () => {
      const cam20s = new Camera({serial: 'T8161T0000000024', mode: 'custom', hold_secs: 20, end_early: true});
      const cam30s = new Camera({serial: 'T8161T0000000025', mode: 'custom', hold_secs: 30, end_early: true});
      const cam60s = new Camera({serial: 'T8161T0000000026', mode: 'rtsp', hold_secs: 60});
      const cam120s = new Camera({serial: 'T8161T0000000027', mode: 'rtsp', hold_secs: 120});

      // 1. Proportional 20% cutoff clamped to [3s..15s]
      assert.equal(cam20s.getSustainedLiveVideoCutoffMs(), 4000, '20% of 20s clip = 4s (< 5s)');
      assert.equal(cam30s.getSustainedLiveVideoCutoffMs(), 6000, '20% of 30s clip = 6s');
      assert.equal(cam60s.getSustainedLiveVideoCutoffMs(), 12000, '20% of 60s clip = 12s');
      assert.equal(cam120s.getSustainedLiveVideoCutoffMs(), 15000, '20% of 120s clip clamped to 15s max');

      const t0 = 1000000;
      const frameBuf = Buffer.alloc(1382400, 0x33);
      cam60s.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
      cam60s.beginSession('rtsp', t0, true);
      cam60s.recordDecodedFrame(frameBuf, frameBuf, t0 + 1000, '12:00');
      // At 6s of video (< 12s cutoff for a 60s camera), safety-net pendingBackfill MUST remain intact!
      cam60s.recordDecodedFrame(frameBuf, frameBuf, t0 + 7000, '12:00');
      assert.equal(
        cam60s.hasPendingBackfill(),
        true,
        'AT-15: 60s camera must NOT cancel safety-net Backfill after only 6s of video (< 12s 20% cutoff)'
      );
      // At 12s of video (>= 12s 20% cutoff), safety-net pendingBackfill is canceled
      cam60s.recordDecodedFrame(frameBuf, frameBuf, t0 + 13000, '12:00');
      assert.equal(
        cam60s.hasPendingBackfill(),
        false,
        'AT-15: 60s camera cancels safety-net Backfill once 12s (20%) of live video is decoded'
      );

      // 2. BackfillJob waits for state=false + 4s settle, or hold_secs + 4s after last trigger,
      //    hard-capped at 120s + 4s (124s) from initial trigger (this.at) when continuous triggers fire
      const job = new BackfillJob({
        at: t0,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
        priority: 10,
      });
      // Simulate continuous re-triggers every 20s up to t0 + 115s without state=false
      for (let offset = 20000; offset <= 115000; offset += 20000) {
        job.upgradeEvent({
          at: t0 + offset,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
          priority: 200,
        });
      }
      assert.equal(
        job.isReadyToQuery(t0 + 120000, 34000),
        false,
        'Still waiting while active triggers fired within 34s and total elapsed < 124s'
      );
      assert.equal(
        job.isReadyToQuery(t0 + 124000, 34000),
        true,
        'AT-15: Hard 120s + 4s Eufy max hardware clip cap from initial trigger (this.at) forces query so ' +
          'continuous motion never delays Clip 1 indefinitely'
      );
      assert.equal(job.isExpired(t0 + 100000 + 300000), false);
      assert.equal(job.isExpired(t0 + 100000 + 300001), true);

      const clearJob = new BackfillJob({
        at: t0,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
        priority: 10,
      });
      clearJob.markRecordingCleared(t0 + 5000);
      assert.equal(clearJob.isReadyToQuery(t0 + 8999, 34000), false);
      assert.equal(clearJob.isReadyToQuery(t0 + 9000, 34000), true);

      // 3. Default 2s (2000ms) station P2P slot idle delay, 35s minimum fallback, and back-to-back job isolation
      const builtCfg = new BridgeConfigBuilder({
        cameras: [{serial: 'T8214T0000000099', name: 'doorbell'}],
      }).build();
      assert.equal(builtCfg.backfillDelayMs, 2000, 'AT-15: Default backfill_delay_secs is 2s (2000ms)');

      const bfCam = new Camera({
        serial: 'T8214T0000000091',
        name: 'bf_cam',
        mode: 'backfill',
        hold_secs: 20,
        station_serial: 'T8030P0000000015',
      });
      const p2pSibling = new Camera({
        serial: 'T8214T0000000092',
        name: 'p2p_sib',
        mode: 'p2p',
        station_serial: 'T8030P0000000015',
      });
      bfCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(
        bfCam.canQueryBackfill(t0 + 34999, 4000, 12000),
        false,
        'AT-15: Missing state=false fallback honors 35s minimum wait when hold_secs + 4s < 35s'
      );
      assert.equal(bfCam.canQueryBackfill(t0 + 35000, 4000, 12000), true);

      p2pSibling.setSleptAt(t0 + 34000);
      assert.equal(
        bfCam.canQueryBackfillNow([bfCam, p2pSibling], t0 + 35999, 4000, 12000, 2000),
        false,
        'AT-15: Waits 2s (2000ms) after sibling P2P stream sleeps before querying HomeBase'
      );
      assert.equal(bfCam.canQueryBackfillNow([bfCam, p2pSibling], t0 + 36000, 4000, 12000, 2000), true);

      // Settled Job 1 stays queryable when a back-to-back state=true trigger arrives for Job 2
      const b2bCam = new Camera({
        serial: 'T8214T0000000093',
        name: 'b2b_cam',
        mode: 'backfill',
        station_serial: 'T8030P0000000015',
      });
      b2bCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      b2bCam.recordMotionCleared(t0 + 3000, 4000, 10000);
      assert.equal(b2bCam.canQueryBackfill(t0 + 7000, 4000, 12000), true);
      b2bCam.queueEventBackfill(t0 + 8000, 'person detected', '', 'person detected', 200, true);
      assert.equal(
        b2bCam.canQueryBackfill(t0 + 8000, 4000, 12000),
        true,
        'AT-15: Settled BackfillJob must remain queryable when a back-to-back state=true trigger arrives'
      );
      assert.equal(b2bCam.getPendingBackfillJob()?.at, t0);
      assert.equal(b2bCam.getQueuedBackfillJob()?.at, t0 + 8000);
    }
  );
});
