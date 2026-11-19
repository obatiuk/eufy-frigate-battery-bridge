/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the WakeRequest value object and the WakeScheduler domain model
 * (src/domain/camera/wake-scheduler.js): the paced /api/wake timer and the live wake deferred until active backfill
 * playback finishes.
 */
'use strict';

const {describe, it, mock, afterEach} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {WAKE_KINDS, WakeRequest, WakeScheduler} = require('../../../src/domain/camera/wake-scheduler');
const camera = require('../../../src/domain/camera');

afterEach(() => {
  mock.timers.reset();
});

/**
 * Builds a frozen wake request.
 *
 * @param {Record<string, *>} [opts] - kind, reason, durationMs, initiator, priority, createEvent.
 * @returns {*}
 */
function wake(opts = {}) {
  const builder =
    opts.kind === 'motion'
      ? WakeRequest.motion(opts.reason ?? 'r', opts.durationMs ?? 1000).withPriority(opts.priority ?? 0)
      : WakeRequest.view(opts.reason ?? 'r', opts.durationMs ?? 1000);
  return builder
    .withInitiator(opts.initiator ?? '')
    .withCreateEvent(Boolean(opts.createEvent))
    .build();
}

describe('WakeRequest', () => {
  it('builds a frozen value object with defaults and clamped inputs', () => {
    // Verify: builds a frozen value object with defaults and clamped inputs.
    assert.deepEqual(WakeRequest.view('viewer opened', 30000).build(), {
      kind: 'view',
      reason: 'viewer opened',
      durationMs: 30000,
      initiator: 'bridge',
      priority: 10,
      createEvent: false,
      delayMs: 0,
    });
    const built = WakeRequest.motion('motion', 5000).withInitiator('eufy-event').withCreateEvent(true).withDelay(-5);
    assert.equal(built.build().delayMs, 0);
    assert.equal(built.build().kind, 'motion');
    assert.equal(Object.isFrozen(built.build()), true);
    assert.deepEqual({...WAKE_KINDS}, {MOTION: 'motion', VIEW: 'view'});
  });

  it('is still exported by the camera module', () => {
    // Verify: tests and services import WakeRequest and WAKE_KINDS from camera.js.
    assert.equal(camera.WakeRequest, WakeRequest);
    assert.equal(camera.WAKE_KINDS, WAKE_KINDS);
  });
});

describe('WakeScheduler paced api wake', () => {
  it('schedules one timer, reports its duration, and fires once with the pending options', () => {
    // Verify: scheduleApi stores the timer and pending options and clears both before invoking onFire.
    mock.timers.enable({apis: ['setTimeout']});
    const scheduler = new WakeScheduler();
    const fired = [];
    assert.equal(scheduler.hasPendingApiTimer(), false);
    assert.equal(scheduler.getScheduledApiDurationMs(), 0);
    scheduler.scheduleApi(
      {durationMs: 30000, reason: 'porch', createEvent: true, delayMs: 2500, now: 1000},
      (pending) => fired.push(pending)
    );
    assert.equal(scheduler.hasPendingApiTimer(), true);
    assert.equal(scheduler.getScheduledApiDurationMs(), 30000);
    assert.equal(scheduler.apiScheduledAt, 3500);
    mock.timers.tick(2499);
    assert.deepEqual(fired, []);
    mock.timers.tick(1);
    assert.deepEqual(fired, [{durationMs: 30000, reason: 'porch', createEvent: true}]);
    assert.equal(scheduler.hasPendingApiTimer(), false);
    assert.equal(scheduler.apiScheduledAt, 0);
  });

  it('replaces a pending timer instead of firing both', () => {
    // Verify: calling scheduleApi while a timer is pending cancels the earlier timer before scheduling the replacement.
    mock.timers.enable({apis: ['setTimeout']});
    const scheduler = new WakeScheduler();
    const fired = [];
    scheduler.scheduleApi({durationMs: 1000, reason: 'first', createEvent: false, delayMs: 15, now: 0}, () =>
      fired.push('first')
    );
    scheduler.scheduleApi({durationMs: 2000, reason: 'second', createEvent: true, delayMs: 25, now: 0}, (pending) =>
      fired.push(pending.reason)
    );
    mock.timers.tick(100);
    assert.deepEqual(fired, ['second']);
  });

  it('coalesces a duplicate request into the longer duration and returns the remaining delay', () => {
    // Verify: coalesceApi keeps max duration and sticky createEvent while computing non-negative remaining delay.
    mock.timers.enable({apis: ['setTimeout']});
    const scheduler = new WakeScheduler();
    scheduler.scheduleApi({durationMs: 30000, reason: 'first', createEvent: true, delayMs: 2500, now: 1000}, () => {});
    const remaining = scheduler.coalesceApi({durationMs: 10000, reason: 'second', createEvent: false}, 2000);
    assert.equal(remaining, 1500);
    assert.deepEqual(scheduler.apiPendingOpts, {durationMs: 30000, reason: 'second', createEvent: true});
    assert.equal(
      scheduler.coalesceApi({durationMs: 45000, reason: 'third', createEvent: false}, 9000),
      0,
      'remaining delay never goes negative'
    );
    assert.equal(scheduler.getScheduledApiDurationMs(), 45000);
  });

  it('coalesces with no pending timer using now as the schedule time', () => {
    // Verify: coalesceApi returns 0ms remaining delay when called without a prior scheduled timer.
    const scheduler = new WakeScheduler();
    assert.equal(scheduler.coalesceApi({durationMs: 5000, reason: 'only', createEvent: false}, 777), 0);
    assert.equal(scheduler.getScheduledApiDurationMs(), 5000);
  });

  it('clears the timer, options, and schedule time', () => {
    // Verify: clearApiTimer cancels any pending timeout and resets pending options and scheduled timestamp.
    mock.timers.enable({apis: ['setTimeout']});
    const scheduler = new WakeScheduler();
    let fired = 0;
    scheduler.scheduleApi({durationMs: 1000, reason: 'x', createEvent: false, delayMs: 50, now: 0}, () => fired++);
    scheduler.clearApiTimer();
    assert.equal(scheduler.hasPendingApiTimer(), false);
    assert.equal(scheduler.apiPendingOpts, null);
    assert.equal(scheduler.apiScheduledAt, 0);
    mock.timers.tick(500);
    assert.equal(fired, 0);
  });
});

describe('WakeScheduler deferred live wake', () => {
  it('queues one wake and merges later requests into the longest duration and highest priority', () => {
    // Verify: queues one wake and merges later requests into the longest duration and highest priority.
    const scheduler = new WakeScheduler();
    assert.equal(scheduler.hasDeferred(), false);
    assert.equal(
      scheduler.defer(wake({kind: 'view', durationMs: 30000, reason: 'viewer', initiator: 'viewer'})),
      30000
    );
    assert.equal(scheduler.hasDeferred(), true);
    const merged = scheduler.defer(
      wake({
        kind: 'motion',
        durationMs: 20000,
        reason: 'person',
        initiator: 'eufy-event',
        priority: 300,
        createEvent: true,
      })
    );
    assert.equal(merged, 30000);
    assert.deepEqual(scheduler.takeDeferred(), {
      kind: 'motion',
      reason: 'person',
      durationMs: 30000,
      initiator: 'eufy-event',
      priority: 300,
      createEvent: true,
      delayMs: 0,
    });
    assert.equal(scheduler.hasDeferred(), false);
    assert.equal(scheduler.takeDeferred(), null);
  });

  it('keeps the previous reason and initiator when the new request has none, and createEvent stays sticky', () => {
    // Verify: keeps the previous reason and initiator when the new request has none, and createEvent stays sticky.
    // WakeRequest builders always set an initiator, so plain request objects exercise the fallbacks.
    const scheduler = new WakeScheduler();
    scheduler.defer(wake({kind: 'motion', reason: 'first', initiator: 'api-wake', priority: 100, createEvent: true}));
    scheduler.defer({kind: 'view', reason: '', durationMs: 500, initiator: '', priority: 0, createEvent: false});
    const taken = scheduler.takeDeferred();
    assert.equal(taken.reason, 'first');
    assert.equal(taken.initiator, 'api-wake');
    assert.equal(taken.createEvent, true);
    assert.equal(taken.priority, 100);
  });

  it('defaults the initiator to api-wake and ignores a request that is not an object', () => {
    // Verify: defaults the initiator to api-wake and ignores a request that is not an object.
    const scheduler = new WakeScheduler();
    assert.equal(scheduler.defer(null), 0);
    assert.equal(scheduler.defer('nope'), 0);
    assert.equal(scheduler.hasDeferred(), false);
    scheduler.defer({kind: 'view', reason: 'x', durationMs: 100, initiator: '', priority: 0, createEvent: false});
    assert.equal(scheduler.takeDeferred().initiator, 'api-wake');
  });

  it('absorbs the deferred priority into a hardware event priority and drops the deferred wake', () => {
    // Verify: absorbs the deferred priority into a hardware event priority and drops the deferred wake.
    const scheduler = new WakeScheduler();
    assert.equal(scheduler.absorbPriority(150), 150, 'nothing deferred keeps the event priority');
    scheduler.defer(wake({kind: 'motion', priority: 400, createEvent: true}));
    assert.equal(scheduler.absorbPriority(150), 400);
    assert.equal(scheduler.hasDeferred(), false);
    scheduler.defer(wake({kind: 'motion', priority: 100, createEvent: true}));
    assert.equal(scheduler.absorbPriority(250), 250);
  });

  it('clears the deferred wake', () => {
    // Verify: clears the deferred wake.
    const scheduler = new WakeScheduler();
    scheduler.defer(wake({}));
    scheduler.clearDeferred();
    assert.equal(scheduler.hasDeferred(), false);
  });
});
