/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the SessionLifecycle domain model (src/domain/camera/session-lifecycle.js): the streaming session
 * state machine of one camera plus the cooldown that follows a finished live session.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {SessionLifecycle} = require('../../../src/domain/camera/session-lifecycle');

const COOLDOWN_MS = 5000;

/**
 * Builds a lifecycle that records every reported state change.
 *
 * @param {number} [createdAt=1000] - Epoch ms the lifecycle starts at.
 * @returns {{ lifecycle: SessionLifecycle, changes: string[] }}
 */
function createRecordingLifecycle(createdAt = 1000) {
  const changes = [];
  const lifecycle = new SessionLifecycle(
    COOLDOWN_MS,
    (prev, next, reason) => {
      changes.push(prev + '->' + next + (reason ? ' (' + reason + ')' : ''));
    },
    createdAt
  );
  return {lifecycle, changes};
}

describe('SessionLifecycle (src/domain/camera/session-lifecycle.js)', () => {
  it('starts idle, remembering when it was created', () => {
    // Verify: a new camera is idle, has never slept, and its state age counts from creation.
    const {lifecycle} = createRecordingLifecycle(1000);
    assert.equal(lifecycle.state, 'idle');
    assert.equal(lifecycle.prevState, 'idle');
    assert.equal(lifecycle.changedAt, 1000);
    assert.equal(lifecycle.sleptAt, 0);
  });

  it('only follows permitted transitions and reports each real change or refusal', () => {
    // Verify: idle cannot jump straight to live streaming, refused transitions invoke onRefused, same-state transitions
    // change nothing, and an accepted change records prevState, changedAt, and invokes onTransition.
    const changes = [];
    const refused = [];
    const lifecycle = new SessionLifecycle(COOLDOWN_MS, {
      onTransition: (prev, next, reason) => {
        changes.push(prev + '->' + next + (reason ? ' (' + reason + ')' : ''));
      },
      onRefused: (prev, next, reason) => {
        refused.push(prev + '->' + next + (reason ? ' (' + reason + ')' : ''));
      },
      createdAt: 1000,
    });

    assert.equal(lifecycle.transitionTo('streaming_live', 2000, 'skipped ahead'), 'idle');
    assert.equal(lifecycle.transitionTo('idle', 2100, 'same state'), 'idle');
    assert.equal(lifecycle.changedAt, 1000, 'refused and same-state transitions leave the change time alone');
    assert.deepEqual(changes, []);
    assert.deepEqual(refused, ['idle->streaming_live (skipped ahead)']);

    assert.equal(lifecycle.transitionTo('waking_rtsp', 3000, 'rtsp wake'), 'waking_rtsp');
    assert.equal(lifecycle.prevState, 'idle');
    assert.equal(lifecycle.changedAt, 3000);
    assert.equal(lifecycle.transitionTo('streaming_live', 4000), 'streaming_live');
    assert.equal(lifecycle.prevState, 'waking_rtsp');
    assert.deepEqual(changes, ['idle->waking_rtsp (rtsp wake)', 'waking_rtsp->streaming_live']);
  });

  it('starts the cooldown clock when a live session ends and keeps an earlier sleep time', () => {
    // Verify: entering cooldown stamps the sleep time unless one was already recorded for this stop.
    const {lifecycle} = createRecordingLifecycle();
    lifecycle.transitionTo('waking_rtsp', 2000);
    lifecycle.transitionTo('streaming_live', 3000);
    lifecycle.transitionTo('cooldown', 9000, 'live session ended');
    assert.equal(lifecycle.sleptAt, 9000);

    const marked = createRecordingLifecycle();
    marked.lifecycle.transitionTo('waking_rtsp', 2000);
    marked.lifecycle.transitionTo('streaming_live', 3000);
    marked.lifecycle.markSlept(8000);
    marked.lifecycle.transitionTo('cooldown', 9000);
    assert.equal(marked.lifecycle.sleptAt, 8000, 'an explicitly recorded sleep time is kept');
  });

  it('returns to idle once the cooldown has elapsed', () => {
    // Verify: refresh() moves cooldown to idle exactly when the cooldown time has passed since the camera slept.
    const {lifecycle, changes} = createRecordingLifecycle();
    lifecycle.transitionTo('waking_rtsp', 2000);
    lifecycle.transitionTo('streaming_live', 3000);
    lifecycle.markSlept(10000);
    lifecycle.transitionTo('cooldown', 10000, 'ended');

    assert.equal(lifecycle.refresh(14999), 'cooldown');
    assert.equal(lifecycle.refresh(15000), 'idle');
    assert.deepEqual(changes.slice(-1), ['cooldown->idle (cooldown elapsed)']);
    assert.equal(lifecycle.refresh(99999), 'idle');
  });

  it('peeks the effective state without mutating the lifecycle', () => {
    // Verify: peeking reports idle once the cooldown elapsed but leaves the stored state and callback untouched.
    const {lifecycle, changes} = createRecordingLifecycle();
    lifecycle.transitionTo('waking_rtsp', 2000);
    lifecycle.transitionTo('streaming_live', 3000);
    lifecycle.markSlept(10000);
    lifecycle.transitionTo('cooldown', 10000);
    const changeCount = changes.length;

    assert.equal(lifecycle.peekEffective(14999), 'cooldown');
    assert.equal(lifecycle.peekEffective(15000), 'idle');
    assert.equal(lifecycle.state, 'cooldown');
    assert.equal(changes.length, changeCount);
  });
});
