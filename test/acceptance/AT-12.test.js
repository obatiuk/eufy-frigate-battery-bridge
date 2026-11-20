/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-12`: Default `end_early: true` Clean End, `RTSP` Clip Continuation,
 * `end_early: false` Re-Wake & Session Caps (docs/acceptance/AT-12.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-12.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');

describe('Locked Acceptance Criterion AT-12 (docs/acceptance/AT-12.md)', () => {
  it(
    'AT-12: Defaults to end_early=true (30s live / 20s backfill) with clean post-motion RTSP/P2P end and ' +
      'active viewer/detection RTSP continuation, re-wakes mid-hold drops when end_early=false, and enforces ' +
      'stream_max_secs, view_max_secs, idle_timeout_secs, and direct rtsp_url bypasses',
    () => {
      const defaultLiveRtspCam = new Camera({
        serial: 'T8161T0000000014',
        name: 'storage_default',
        mode: 'rtsp',
      });
      defaultLiveRtspCam.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.0.2.50/live0');
      const defaultBackfillCam = new Camera({
        serial: 'T8214T0000000014',
        name: 'doorbell_default',
        mode: 'backfill',
      });
      assert.equal(defaultLiveRtspCam.getEventHoldMs(), 30000, 'Live modes default to 30s hold_secs');
      assert.equal(defaultBackfillCam.getEventHoldMs(), 20000, '"backfill" mode defaults to 20s hold_secs');
      assert.equal(defaultLiveRtspCam.shouldLetEufyDecideEnd(), true, 'end_early defaults to true across all modes');

      // 1. Default end_early=true on RTSP: sleeps cleanly once motion cleared and no viewer/object is active,
      //    yet re-wakes across clip boundaries while Eufy triggers, Frigate objects, or a waking viewer stay active
      const t0 = 1000000;
      defaultLiveRtspCam.beginSession('rtsp', t0, true);
      defaultLiveRtspCam.setGotVideo(true);
      defaultLiveRtspCam.setFirstVideoAt(t0 + 1000);
      defaultLiveRtspCam.setLastMotionAt(t0);
      defaultLiveRtspCam.setMotionUntil(t0 + 30000);
      defaultLiveRtspCam.addActiveTriggerEvent('motion detected');
      assert.equal(
        defaultLiveRtspCam.shouldRewakeRtspOnDrop(t0 + 20000),
        true,
        'AT-12: Active Eufy trigger re-wakes RTSP across hardware clip boundary under end_early=true'
      );

      defaultLiveRtspCam.recordMotionCleared(t0 + 12000, 5000, 10000, 'motion detected');
      assert.equal(defaultLiveRtspCam.getMotionUntil(), t0 + 17000);
      assert.equal(
        defaultLiveRtspCam.shouldRewakeRtspOnDrop(t0 + 15000),
        false,
        'AT-12: Cleared motion with no viewer or Frigate object sleeps cleanly without second cold RTSP wake'
      );

      defaultLiveRtspCam.confirmFrigateObjectDetected(t0 + 14000);
      assert.equal(
        defaultLiveRtspCam.shouldRewakeRtspOnDrop(t0 + 15000),
        true,
        'AT-12: Recent Frigate tracked object re-wakes RTSP across clip boundary under end_early=true'
      );

      // 2. Explicit end_early=false re-wakes mid-session hardware cutoffs before hold_secs expires
      const fullHoldCam = new Camera({
        serial: 'T8161T0000000015',
        name: 'driveway',
        mode: 'rtsp',
        hold_secs: 60,
        stream_max_secs: 120,
        end_early: false,
      });
      fullHoldCam.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.0.2.50/live1');
      const earlyEndCam = new Camera({
        serial: 'T8161T0000000016',
        name: 'porch',
        mode: 'custom',
        hold_secs: 60,
        idle_timeout_secs: 15,
        end_early: true,
      });

      fullHoldCam.beginSession('rtsp', t0, true);
      fullHoldCam.setGotVideo(true);
      fullHoldCam.setFirstVideoAt(t0 + 1000);
      fullHoldCam.setLastMotionAt(t0);
      fullHoldCam.setMotionUntil(t0 + 60000);
      fullHoldCam.recordMotionCleared(t0 + 10000, 5000, 10000, 'motion detected');

      assert.equal(fullHoldCam.shouldRewakeRtspOnDrop(t0 + 35000), true);
      fullHoldCam.setMotionUntil(t0 + 90000);
      assert.equal(fullHoldCam.shouldRewakeRtspOnDrop(t0 + 65000), false);
      assert.equal(fullHoldCam.hasReachedMaxDuration(t0 + 119999), false);
      assert.equal(
        fullHoldCam.hasReachedMaxDuration(t0 + 120000),
        true,
        'AT-12: Live session reaches stream_max_secs (120s) hard cap at 120000ms'
      );

      // 3. STREAM_MODES.DOWNLOAD backfill playback must never be cut off by stream_max_secs or view_max_secs
      const backfillCapCam = new Camera({
        serial: 'T8214T0000000097',
        name: 'backfill_cap_check',
        mode: 'backfill',
        hold_secs: 30,
        stream_max_secs: 60,
        view_max_secs: 45,
      });
      backfillCapCam.beginBackfillDownload(
        {
          storagePath: '/zx/long_120s.zxvideo',
          cipherId: 1,
          clipMs: t0 - 120000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0
      );
      assert.equal(
        backfillCapCam.hasReachedMaxDuration(t0 + 115000),
        false,
        'AT-12: stream_max_secs (60s) must never truncate active STREAM_MODES.DOWNLOAD playback at 115s'
      );
      assert.equal(backfillCapCam.expireMaxDurationHold(t0 + 115000), '');
      assert.equal(backfillCapCam.hasReachedViewMaxDuration(t0 + 115000), false);
      backfillCapCam.endSession(t0 + 120000, true, false, 'download');

      // 4. end_early=true on P2P + idle_timeout_secs = 15s early-sleep
      earlyEndCam.beginSession('p2p', t0, true);
      earlyEndCam.setGotVideo(true);
      earlyEndCam.setEventActive(true);
      earlyEndCam.setFirstVideoAt(t0 + 1000);
      earlyEndCam.setLastMotionAt(t0);
      earlyEndCam.setMotionUntil(t0 + 60000);
      assert.equal(earlyEndCam.recordMotionCleared(t0 + 15000, 5000, 10000), 5);
      assert.equal(earlyEndCam.getMotionUntil(), t0 + 20000);
      assert.equal(earlyEndCam.didEufyEndEventCleanly(t0 + 16000, 8000), true);

      assert.equal(earlyEndCam.canSleepEarlyOnIdle(t0 + 8000, 10000), false);
      assert.deepEqual(earlyEndCam.checkEarlySleepDue(t0 + 10000, 3000, 4000), {
        due: false,
        clearedByEufy: false,
      });
      assert.equal(earlyEndCam.canSleepEarlyOnIdle(t0 + 17000, 10000), true);
      assert.deepEqual(earlyEndCam.checkEarlySleepDue(t0 + 19500, 3000, 4000), {
        due: true,
        clearedByEufy: true,
      });

      // 5. Direct rtsp_url camera bypasses all session hold, max duration, viewer linger, viewer cooldown,
      //    Frigate hold poll, and idle_timeout_secs timeouts so active streams flow continuously
      const directCam = new Camera({
        name: 'baby_cam_timeout_check',
        mode: 'rtsp',
        rtsp_url: 'rtsp://127.0.0.1:8554/baby_cam',
        hold_secs: 10,
        stream_max_secs: 20,
        view_linger_secs: 5,
        view_max_secs: 15,
        idle_timeout_secs: 10,
      });
      directCam.beginSession('rtsp', t0, false);
      directCam.setGotVideo(true);
      directCam.setFirstVideoAt(t0 + 500);
      directCam.setLastVideoAt(t0 + 100000);
      directCam.setMotionUntil(t0 + 10000);
      directCam.setViewUntil(t0 + 5000);
      directCam.setSleptAt(t0 - 1000);
      assert.equal(directCam.hasExpiredLiveHold(t0 + 100000), false);
      assert.equal(directCam.hasReachedMaxDuration(t0 + 100000), false);
      assert.equal(directCam.hasReachedViewMaxDuration(t0 + 100000), false);
      assert.equal(directCam.canSleepEarlyOnIdle(t0 + 100000, 10000), false);
      assert.deepEqual(directCam.checkEarlySleepDue(t0 + 100000, 3000, 4000), {
        due: false,
        clearedByEufy: false,
      });
      assert.equal(directCam.shouldPollFrigateForHoldOrBackfill(t0 + 9000, 12000).shouldPoll, false);
      assert.equal(directCam.isInViewerCooldown(t0), false);
    }
  );
});
