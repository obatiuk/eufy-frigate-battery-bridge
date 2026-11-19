/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the FrigateEventFiling domain model (src/domain/camera/frigate-event-filing.js): the lifecycle of
 * the external Frigate detection event the bridge files for one camera (queued, waiting for a clean snapshot, filed,
 * and cooling down).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {FrigateEventFiling} = require('../../../src/domain/camera/frigate-event-filing');

/**
 * Builds a filing that records every state change reported to its transition callback.
 *
 * @returns {{ filing: FrigateEventFiling, changes: string[] }}
 */
function createRecordingFiling() {
  const changes = [];
  const filing = new FrigateEventFiling((prev, next, reason) => {
    changes.push(prev + '->' + next + (reason ? ' (' + reason + ')' : ''));
  });
  return {filing, changes};
}

describe('FrigateEventFiling (src/domain/camera/frigate-event-filing.js)', () => {
  it('starts idle with nothing queued, filed, or created', () => {
    // Verify: a new camera has no Frigate event in flight.
    const filing = new FrigateEventFiling();
    assert.equal(filing.state, 'idle');
    assert.equal(filing.label, '');
    assert.equal(filing.person, '');
    assert.equal(filing.until, 0);
    assert.equal(filing.dispatchedAt, 0);
    assert.equal(filing.waitId, 0);
    assert.equal(filing.pending, false);
    assert.equal(filing.timer, null);
    assert.equal(filing.lastCreatedId, '');
    assert.equal(filing.hasPendingDispatch(), false);
    assert.equal(filing.isInFlight(), false);
  });

  it('only follows permitted lifecycle transitions and reports real changes and refusals', () => {
    // Verify: idle may only move to queued, refused transitions invoke onRefused, and onTransition fires once per
    // real change with the reason.
    const changes = [];
    const refused = [];
    const filing = new FrigateEventFiling(
      (prev, next, reason) => {
        changes.push(prev + '->' + next + (reason ? ' (' + reason + ')' : ''));
      },
      (prev, next, reason) => {
        refused.push(prev + '->' + next + (reason ? ' (' + reason + ')' : ''));
      }
    );

    assert.equal(filing.transitionTo('waiting_snapshot', 'skipped ahead'), 'idle');
    assert.equal(filing.transitionTo('idle', 'same state'), 'idle');
    assert.deepEqual(changes, []);
    assert.deepEqual(refused, ['idle->waiting_snapshot (skipped ahead)']);

    assert.equal(filing.transitionTo('queued', 'event queued'), 'queued');
    assert.equal(filing.transitionTo('waiting_snapshot'), 'waiting_snapshot');
    assert.equal(filing.transitionTo('queued', 'backwards'), 'waiting_snapshot', 'waiting_snapshot cannot go back');
    assert.deepEqual(changes, ['idle->queued (event queued)', 'queued->waiting_snapshot']);
    assert.deepEqual(refused, ['idle->waiting_snapshot (skipped ahead)', 'waiting_snapshot->queued (backwards)']);
  });

  it('queues a new event with a normalized label and a fresh wait token', () => {
    // Verify: a first request queues the event, normalizing "motion detected" to "motion".
    const {filing, changes} = createRecordingFiling();
    const result = filing.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});

    assert.deepEqual(result, {status: 'queued', upgradedLabel: false, attachedPerson: false});
    assert.equal(filing.label, 'motion');
    assert.equal(filing.person, '');
    assert.equal(filing.pending, true);
    assert.equal(filing.waitId, 1);
    assert.equal(filing.state, 'queued');
    assert.equal(filing.isInFlight(), true);
    assert.deepEqual(changes, ['idle->queued (event queued)']);
  });

  it('upgrades the label and attaches a person in place while an event is in flight', () => {
    // Verify: a queued event gets a more specific label once and the first recognized person only, without queueing
    // a second event or changing the wait token.
    const filing = new FrigateEventFiling();
    filing.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});

    const upgrade = filing.request({
      label: 'person detected',
      personName: 'Alice',
      now: 1100,
      shouldExtend: () => false,
    });
    assert.deepEqual(upgrade, {status: 'upgraded', upgradedLabel: true, attachedPerson: true});
    assert.equal(filing.label, 'person detected');
    assert.equal(filing.person, 'Alice');

    const second = filing.request({label: 'vehicle detected', personName: 'Bob', now: 1200, shouldExtend: () => false});
    assert.deepEqual(second, {status: 'upgraded', upgradedLabel: false, attachedPerson: false});
    assert.equal(filing.label, 'person detected', 'only a "motion" label is upgraded');
    assert.equal(filing.person, 'Alice', 'only the first person is kept');
    assert.equal(filing.waitId, 1);
    assert.equal(filing.state, 'queued');
  });

  it('files an event, cools down until it ends, then returns to idle', () => {
    // Verify: completing a filing records the dispatch, extends the window to now + duration, and reports the
    // label, person, sub label, and duration to post.
    const {filing, changes} = createRecordingFiling();
    filing.request({label: 'person detected', personName: 'Alice', now: 1000, shouldExtend: () => false});
    filing.beginSnapshotWait(1);

    const filed = filing.complete(2000, 30);
    assert.deepEqual(filed, {finalLabel: 'person detected', finalPerson: 'Alice', subLabel: 'Alice', durationSecs: 30});
    assert.equal(filing.pending, false);
    assert.equal(filing.dispatchedAt, 2000);
    assert.equal(filing.until, 32000);
    assert.equal(filing.state, 'cooldown');
    assert.deepEqual(changes.slice(-1), ['waiting_snapshot->cooldown (event filed)']);

    assert.equal(filing.refresh(31999), 'cooldown');
    assert.equal(filing.refresh(32000), 'idle');
    assert.equal(filing.until, 0);

    const anonymous = new FrigateEventFiling();
    anonymous.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});
    assert.equal(anonymous.complete(1500, 5).subLabel, null, 'no person means no sub label');
  });

  it('keeps the longer window when a later filing ends earlier', () => {
    // Verify: the filed window only ever grows.
    const filing = new FrigateEventFiling();
    filing.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});
    filing.complete(2000, 60);
    assert.equal(filing.until, 62000);
    filing.request({label: 'motion detected', personName: '', now: 3000, shouldExtend: () => true});
    filing.complete(4000, 5);
    assert.equal(filing.until, 62000);
  });

  it('suppresses repeat requests during cooldown unless the event must be extended or upgraded', () => {
    // Verify: inside the filed window a repeat request is a cooldown no-op, a needed extension or a more specific
    // label queues a follow-up filing, and the extension check is skipped when an upgrade already applies.
    const filing = new FrigateEventFiling();
    filing.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});
    filing.complete(2000, 30);

    assert.deepEqual(filing.request({label: 'motion detected', personName: '', now: 3000, shouldExtend: () => false}), {
      status: 'cooldown',
      upgradedLabel: false,
      attachedPerson: false,
    });
    assert.equal(filing.state, 'cooldown');
    assert.equal(filing.waitId, 1);

    assert.deepEqual(filing.request({label: 'motion detected', personName: '', now: 4000, shouldExtend: () => true}), {
      status: 'queued',
      upgradedLabel: false,
      attachedPerson: false,
    });
    assert.equal(filing.state, 'queued');
    assert.equal(filing.waitId, 2);
    assert.equal(filing.pending, true);

    const upgraded = new FrigateEventFiling();
    upgraded.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});
    upgraded.complete(2000, 30);
    let extensionChecks = 0;
    const result = upgraded.request({
      label: 'person detected',
      personName: 'Alice',
      now: 3000,
      shouldExtend: () => {
        extensionChecks++;
        return false;
      },
    });
    assert.deepEqual(result, {status: 'queued', upgradedLabel: true, attachedPerson: true});
    assert.equal(extensionChecks, 0);
    assert.equal(upgraded.label, 'person detected');
    assert.equal(upgraded.person, 'Alice');
  });

  it('moves from queued to waiting for a snapshot only for the current wait token', () => {
    // Verify: the dispatch timer can only start the snapshot wait for the token it was scheduled with.
    const filing = new FrigateEventFiling();
    filing.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});
    filing.setTimer(setTimeout(() => {}, 100000).unref());
    assert.equal(filing.hasPendingDispatch(), true);

    assert.equal(filing.beginSnapshotWait(99), false, 'a stale token is refused');
    assert.equal(filing.state, 'queued');

    assert.equal(filing.beginSnapshotWait(1), true);
    assert.equal(filing.state, 'waiting_snapshot');
    assert.equal(filing.timer, null);
    assert.equal(filing.isSnapshotWaitActive(1), true);
    assert.equal(filing.isSnapshotWaitActive(2), false);

    const idle = new FrigateEventFiling();
    assert.equal(idle.beginSnapshotWait(0), false, 'nothing pending');
  });

  it('aborts queued or waiting filings and ignores abort when nothing is in flight', () => {
    // Verify: aborting clears the timer, invalidates the wait token, and returns to idle; it does nothing when idle.
    const {filing, changes} = createRecordingFiling();
    filing.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});
    filing.setTimer(setTimeout(() => {}, 100000).unref());

    filing.abort('session ended without video');
    assert.equal(filing.timer, null);
    assert.equal(filing.pending, false);
    assert.equal(filing.until, 0);
    assert.equal(filing.waitId, 2, 'the wait token advances so a pending snapshot wait stops');
    assert.equal(filing.state, 'idle');
    assert.deepEqual(changes.slice(-1), ['queued->idle (session ended without video)']);

    filing.abort();
    assert.equal(filing.waitId, 2, 'aborting while idle changes nothing');
  });

  it('peeks the effective state without mutating it, and resets the filed window', () => {
    // Verify: peeking reports idle once cooldown elapsed but leaves state untouched; resetWindow() forgets the filed
    // window so a new backfill clip can be filed from scratch; created IDs are stored as strings.
    const filing = new FrigateEventFiling();
    filing.request({label: 'motion detected', personName: '', now: 1000, shouldExtend: () => false});
    filing.complete(2000, 30);
    assert.equal(filing.peekEffectiveState(31999), 'cooldown');
    assert.equal(filing.peekEffectiveState(32000), 'idle');
    assert.equal(filing.state, 'cooldown');

    filing.resetWindow();
    assert.equal(filing.until, 0);
    assert.equal(filing.dispatchedAt, 0);

    filing.recordCreatedId(12345);
    assert.equal(filing.lastCreatedId, '12345');
    filing.recordCreatedId(null);
    assert.equal(filing.lastCreatedId, '');
  });
});
