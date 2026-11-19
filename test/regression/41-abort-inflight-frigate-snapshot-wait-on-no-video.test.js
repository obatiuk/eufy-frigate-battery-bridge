/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 41. In-Flight `WAITING_SNAPSHOT` Frigate Event Aborted When Session Ends Without
 * Video (docs/regression/41-abort-inflight-frigate-snapshot-wait-on-no-video.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {frigateEvent} = require('../../src/services/frigate-client');

installDefaultFetchStub();

describe('Regression 41. In-Flight `WAITING_SNAPSHOT` Frigate Event Aborted When Session Ends Without Video', () => {
  it(
    'Regression 41: aborts in-flight WAITING_SNAPSHOT Frigate event filing when a backfill or ' +
      'live session ends without video',
    async (t) => {
      // Regression: once the 600ms evTimer fired into WAITING_SNAPSHOT, if start_download failed or a session was
      // preempted before decoding Frame 0, the snapshot-wait loop exited on !cam.isSessionActive() and still POSTed
      // a stale-snapshot Frigate event before the 4s backfill retry filed a second event.
      t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1000000});

      const advanceFakeClock = async (totalMs, stepMs = 100) => {
        for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
          t.mock.timers.tick(Math.min(stepMs, totalMs - elapsed));
          await Promise.resolve();
          await Promise.resolve();
        }
      };

      const cachedSnap = Buffer.alloc(FRAME, 0x42);
      const cam = new Camera(
        {serial: 'T8214T0000000108', name: 'doorbell_abort_ev', mode: 'backfill'},
        {frame: cachedSnap, lastSeen: '11:30'}
      );
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
              return {event_id: 'ev-' + createdEvents.length};
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
        // 1. Backfill download attempt 1 enters WAITING_SNAPSHOT at 600ms, then fails before Frame 0 at 900ms
        cam.queueEventBackfill(Date.now() - 15000, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
        cam.recordMotionCleared(Date.now() - 10000, 4000, 10000, 'person detected');
        assert.equal(
          cam.tryMatchBackfillCandidate({
            devSn: 'T8214T0000000108',
            storagePath: '/zx/abort_snap.zxvideo',
            cipherId: 1,
            clipMs: Date.now() - 14000,
          }),
          true
        );

        cam.beginBackfillDownload(cam.getBackfillClip(), false, Date.now());
        frigateEvent(cam, 'person detected', 'Alice');
        assert.equal(cam.getFrigateEventState(Date.now()), 'queued');

        await advanceFakeClock(700);
        assert.equal(cam.getFrigateEventState(Date.now()), 'waiting_snapshot');

        cam.terminateSession(Date.now(), 'start_download RPC failed', false, 'error/download-failed');
        assert.equal(
          cam.getFrigateEventState(Date.now()),
          'idle',
          'Ending session without video must reset WAITING_SNAPSHOT back to IDLE'
        );

        await advanceFakeClock(2000);
        assert.equal(
          createdEvents.length,
          0,
          'Aborted 0-frame backfill attempt must NOT POST a stale-snapshot Frigate event'
        );
        assert.equal(cam.isLiveCardSuppressed(), false);

        // 4s retry succeeds and decodes Frame 0 -> files exactly one real Frigate event
        await advanceFakeClock(3000);
        assert.equal(cam.isReadyForBackfillDownload(Date.now()), true);
        cam.beginBackfillDownload(cam.getBackfillClip(), false, Date.now());
        frigateEvent(cam, 'person detected', 'Alice');
        const realFrame = Buffer.alloc(FRAME, 0x99);
        cam.recordDecodedFrame(realFrame, realFrame, Date.now() + 100, '11:31');
        await advanceFakeClock(2000);
        assert.equal(createdEvents.length, 1, 'Successful retry files the single real Frigate event');
        assert.equal(createdEvents[0].url.endsWith('/api/events/doorbell_abort_ev/person/create'), true);
        assert.equal(createdEvents[0].body.sub_label, 'Alice');
        cam.terminateSession(Date.now(), 'post-event clip download stream completed', false, 'eufy/download-finished');
        await advanceFakeClock(40000);

        // 2. Preempted live P2P session without video in WAITING_SNAPSHOT also aborts cleanly
        createdEvents.length = 0;
        cam.beginSession('p2p', Date.now(), true);
        frigateEvent(cam, 'motion detected', '');
        await advanceFakeClock(700);
        assert.equal(cam.getFrigateEventState(Date.now()), 'waiting_snapshot');
        cam.terminateSession(Date.now(), 'preempted before video', false, 'bridge-arbitrator/higher-priority-event');
        assert.equal(cam.getFrigateEventState(Date.now()), 'idle');
        await advanceFakeClock(2000);
        assert.equal(createdEvents.length, 0, 'Preempted 0-frame live session must not file stale-snapshot event');

        // 3. Control (AT-17.3): an active wake session that stays active past the snapshot wait window without video
        //    still injects the clean cached snapshot and files the fallback Frigate event
        cam.beginSession('rtsp', Date.now(), true);
        frigateEvent(cam, 'motion detected', '');
        await advanceFakeClock(27000, 200);
        assert.equal(
          createdEvents.length,
          1,
          'Active wake timing out on snapshot wait still files clean-snapshot fallback event'
        );
        cam.endSession(Date.now(), false, false, 'rtsp');
        await advanceFakeClock(2000, 200);
      } finally {
        global.fetch = origFetch;
      }
    }
  );
});
