/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 49. Frigate Event POST Failure Cooldown Rollback & Scoped Card Suppression
 * (docs/regression/49-frigate-event-post-failure-rollback-and-card-suppression.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {frigateEvent} = require('../../src/services/frigate-client');

describe('Regression 49. Frigate Event POST Failure Cooldown Rollback & Scoped Card Suppression', () => {
  it(
    'Regression 49: rolls back Frigate event cooldown on HTTP 500 or network errors and releases clean-snapshot ' +
      'card suppression immediately after POST before review lookup',
    async (t) => {
      // Regression: frigateEvent() committed COOLDOWN before POSTing, stranding follow-up triggers after a 500 error,
      // and held enableCleanSnapshotCardSuppression() across the 1.5s + 5s review lookup.
      t.mock.timers.enable({apis: ['setTimeout', 'Date']});
      t.mock.timers.setTime(1_794_800_000_000);

      const cleanSnap = Buffer.alloc(FRAME, 0x44);
      const cam = new Camera(
        {
          serial: 'SN0000000491',
          name: 'porch_event_cam',
          mode: 'rtsp',
          hold_secs: 30,
          card_show_on_live: true,
          instant_event_snapshot: true,
        },
        {frame: cleanSnap, lastSeen: '12:00'},
        renderCameraCards
      );

      const t0 = Date.now();
      cam.beginSession('rtsp', t0, true);
      cam.recordDecodedFrame(cleanSnap, cleanSnap, t0, '12:00');
      cam.setLastVideoAt(t0 + 2_000);
      cam.setMotionUntil(t0 + 30_000);

      let postAttempts = 0;
      let suppressedDuringReviewLookup = null;
      const origFetch = global.fetch;

      try {
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes('/api/events/porch_event_cam/motion/create')) {
            postAttempts += 1;
            if (postAttempts === 1) {
              return {
                ok: false,
                status: 500,
                async text() {
                  return 'Internal Server Error';
                },
              };
            }
            if (postAttempts === 2) {
              throw new Error('socket hang up');
            }
            return {
              ok: true,
              status: 200,
              async json() {
                return {event_id: 'evt-recovered-49'};
              },
            };
          }
          if (u.includes('/api/review')) {
            suppressedDuringReviewLookup = cam.isLiveCardSuppressed();
            return {
              ok: true,
              status: 200,
              async json() {
                return [];
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {};
            },
            async text() {
              return '';
            },
          };
        };

        const tickUntilAttempt = async (targetAttempt, maxSteps = 140) => {
          for (let i = 0; i < maxSteps; i++) {
            t.mock.timers.tick(250);
            await flushAsync();
            if (postAttempts >= targetAttempt) {
              break;
            }
          }
          await flushAsync();
        };

        // Attempt 1: Frigate returns 500 -> must roll back to IDLE with until=0 instead of stranding in COOLDOWN.
        frigateEvent(cam, 'motion detected');
        await tickUntilAttempt(1, 20);
        assert.equal(postAttempts, 1);
        assert.equal(cam.getFrigateEventState(Date.now()), 'idle');
        assert.equal(cam.getFrigateEventUntil(), 0);

        // Attempt 2: Immediate follow-up motion trigger is NOT dropped by a bogus cooldown; network throw rolls back.
        cam.recordDecodedFrame(cleanSnap, cleanSnap, Date.now(), '12:01');
        frigateEvent(cam, 'motion detected');
        await tickUntilAttempt(2, 20);
        assert.equal(postAttempts, 2);
        assert.equal(cam.getFrigateEventState(Date.now()), 'idle');
        assert.equal(cam.getFrigateEventUntil(), 0);

        // Attempt 3 (with noVideo clean-snapshot fallback): wakes without decoded frames so clean snapshot suppression
        // activates, succeeds on POST, and releases BEFORE the 1500ms review lookup delay elapses.
        cam.endSession(Date.now(), true, false, 'rtsp');
        const tNoVideo = Date.now() + 5_000;
        t.mock.timers.setTime(tNoVideo);
        cam.beginSession('rtsp', tNoVideo, true);
        cam.setMotionUntil(tNoVideo + 30_000);

        frigateEvent(cam, 'motion detected');
        await tickUntilAttempt(3, 150);
        assert.equal(postAttempts, 3);
        assert.equal(cam.getFrigateEventState(Date.now()), 'cooldown');
        assert.equal(
          cam.isLiveCardSuppressed(),
          false,
          'Clean-snapshot card suppression must be released immediately after POST before review lookup'
        );

        // Advance past the 1500ms review lookup delay and confirm suppression stayed false during /api/review.
        t.mock.timers.tick(2_000);
        await flushAsync();
        assert.equal(suppressedDuringReviewLookup, false);
      } finally {
        if (cam.getFrigateEventTimer()) {
          clearTimeout(cam.getFrigateEventTimer());
          cam.setFrigateEventTimer(null);
        }
        cam.endSession(Date.now(), false, false, 'rtsp');
        global.fetch = origFetch;
      }
    }
  );
});
