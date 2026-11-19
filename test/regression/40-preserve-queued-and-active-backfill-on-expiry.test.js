/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 40. Queued Backfill & Active Download Preservation on Pending Job Expiry
 * (docs/regression/40-preserve-queued-and-active-backfill-on-expiry.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {BackfillJob} = require('../../src/domain/backfill-job');
const {Camera} = require('../../src/domain/camera');

describe('Regression 40. Queued Backfill & Active Download Preservation on Pending Job Expiry', () => {
  it(
    'Regression 40: preserves queuedBackfillJob and active downloads when ' +
      'pendingBackfill expires or exhausts query attempts',
    () => {
      // Regression: expirePendingBackfillIfNeeded and beginBackfillDatabaseQuery called clearPendingBackfill(),
      // wiping queuedBackfillJob, activeBackfillJob, activeBackfillClip, and backfillClipQueue whenever Job 1
      // yielded no HomeBase clip or expired during active playback.
      const cam = new Camera({
        serial: 'T8214T0000000105',
        name: 'doorbell_queue_keep',
        mode: 'backfill',
        priority: 100,
      });
      const t0 = 1200000;

      // 1. Job 1 settles -> Job 2 arrives into queuedBackfillJob -> /api/wake upgrades queuedBackfillJob ->
      //    Job 1 exhausts all 10 query attempts -> Job 2 promotes into pendingBackfill without losing trigger state
      cam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t0 + 4000, 4000, 10000, 'motion detected');
      assert.equal(cam.beginBackfillDatabaseQuery(t0 + 9000, 10).allowed, true);

      const tJob2 = t0 + 15000;
      cam.queueEventBackfill(tJob2, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
      assert.ok(cam.getQueuedBackfillJob(), 'Job 2 is isolated in queuedBackfillJob while Job 1 is querying');
      assert.equal(
        cam.queueOrUpgradeApiWakeBackfill(tJob2 + 500, 'porch doorbell automation', {evPriority: 250}),
        true
      );
      assert.equal(cam.getQueuedBackfillJob()?.priority, 350, '/api/wake upgrades queuedBackfillJob priority in place');
      assert.equal(cam.getQueuedBackfillJob()?.reason, 'porch doorbell automation');
      assert.equal(cam.getQueuedBackfillJob()?.personName, 'Alice');

      for (let attempt = 2; attempt <= 10; attempt++) {
        assert.equal(cam.beginBackfillDatabaseQuery(tJob2 + attempt * 12000, 10).allowed, true);
      }
      const exhausted = cam.beginBackfillDatabaseQuery(tJob2 + 132000, 10);
      assert.equal(exhausted.allowed, false);
      assert.equal(
        cam.getPendingBackfillJob()?.at,
        tJob2,
        'Exhausting Job 1 query attempts must promote queuedBackfillJob (Job 2) into pendingBackfill'
      );
      assert.equal(cam.getQueuedBackfillJob(), null);
      assert.equal(
        cam.getLastBackfillQueryAt(),
        0,
        'Promoted Job 2 must not inherit a 12s cooldown from exhausted Job 1'
      );
      assert.equal(cam.hasActiveHardwareTriggers(tJob2 + 100000), true);

      // 2. While Clip 1 (activeBackfillJob + activeBackfillClip + queued Clip 1b) is actively playing in DOWNLOAD,
      //    expiring pendingBackfill (Job 2) promotes Job 3 without wiping Clip 1, Clip 1b, or activeBackfillJob
      const tPlay = 2000000;
      cam.clearPendingBackfill();
      cam.queueEventBackfill(tPlay, 'person detected', '', 'person detected', 200, true);
      cam.recordMotionCleared(tPlay + 5000, 4000, 10000, 'person detected');
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000105',
          storagePath: '/zx/job1_part1.zxvideo',
          cipherId: 1,
          clipMs: tPlay + 1000,
        }),
        true
      );
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000105',
          storagePath: '/zx/job1_part2.zxvideo',
          cipherId: 2,
          clipMs: tPlay + 20000,
        }),
        true
      );
      const staleJob2 = new BackfillJob({
        name: cam.getName(),
        at: tPlay - 285000,
        lastActivityAt: tPlay - 285000,
        event: 'rings',
        personName: '',
        reason: 'stale job 2',
        priority: 1200,
        attempts: 1,
        recordingActive: false,
        clearedAt: tPlay - 280000,
      });
      cam.setQueuedBackfillJob(staleJob2);
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tPlay + 10000);
      assert.equal(cam.getPendingBackfillJob(), staleJob2);
      assert.equal(cam.getBackfillClip()?.storagePath, '/zx/job1_part2.zxvideo');

      // Queue fresh Job 3 behind staleJob2 while Clip 1 is playing
      const tJob3 = tPlay + 12000;
      cam.queueEventBackfill(tJob3, 'rings', '', 'rings', 1000, true);
      cam.recordMotionCleared(tJob3 + 3000, 4000, 10000, 'rings');
      assert.equal(cam.getQueuedBackfillJob()?.at, tJob3);

      // Advance past staleJob2's 300s max age while Clip 1 is still active -> staleJob2 expires, Job 3 promotes,
      // and activeBackfillJob + activeBackfillClip + backfillClipQueue ('/zx/job1_part2.zxvideo') remain intact!
      const expiredReason = cam.expirePendingBackfillIfNeeded(tPlay + 20000, 4000);
      assert.equal(expiredReason, 'stale job 2');
      assert.ok(
        cam.getActiveBackfillJob(),
        'Active download BackfillJob must remain intact when pendingBackfill expires'
      );
      assert.equal(
        cam.getActiveBackfillClip()?.storagePath,
        '/zx/job1_part1.zxvideo',
        'Active download clip must remain intact so interrupted transfers can still re-queue'
      );
      assert.equal(
        cam.getBackfillClip()?.storagePath,
        '/zx/job1_part2.zxvideo',
        'Remaining matched split clip in backfillClipQueue must remain intact when pendingBackfill expires'
      );
      assert.equal(
        cam.getPendingBackfillJob()?.at,
        tJob3,
        'Expiring pendingBackfill must promote queuedBackfillJob (Job 3) into pendingBackfill'
      );
      assert.equal(cam.getQueuedBackfillJob(), null);
    }
  );
});
