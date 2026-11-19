/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the OfflineState domain model (src/domain/camera/offline-state.js): the offline encoder pause flag
 * and the temporary snapshot seed window that lets Frigate pick up the last snapshot of an offline camera.
 */
'use strict';

const {describe, it, mock, afterEach} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {OfflineState} = require('../../../src/domain/camera/offline-state');

afterEach(() => {
  mock.timers.reset();
});

describe('OfflineState encoder pause flag', () => {
  it('starts with the encoder running and no seed window', () => {
    // Verify: starts with the encoder running and no seed window.
    const offline = new OfflineState();
    assert.equal(offline.isEncoderStopped(), false);
    assert.equal(offline.isSeeding(), false);
  });

  it('marks the encoder stopped and started without touching the seed window', () => {
    // Verify: marks the encoder stopped and started without touching the seed window.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    offline.scheduleSeedStop(1000, () => {});
    offline.markEncoderStopped();
    assert.equal(offline.isEncoderStopped(), true);
    offline.markEncoderStarted();
    assert.equal(offline.isEncoderStopped(), false);
    assert.equal(offline.isSeeding(), true, 'attaching an encoder must not cancel an active seed window');
  });

  it('reports whether pausing was a no-op: already paused with no encoder process', () => {
    // Verify: reports whether pausing was a no-op: already paused with no encoder process.
    const offline = new OfflineState();
    assert.equal(offline.pause(true), false, 'first pause with a running encoder is a real stop');
    assert.equal(offline.isEncoderStopped(), true);
    assert.equal(offline.pause(true), false, 'still a real stop while an encoder process exists');
    assert.equal(offline.pause(false), true, 'paused again without an encoder process changes nothing');
  });

  it('clears the pause and the seed window together and reports whether it was paused', () => {
    // Verify: clears the pause and the seed window together and reports whether it was paused.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    assert.equal(offline.clearEncoderPause(), false);
    offline.markEncoderStopped();
    offline.scheduleSeedStop(1000, () => {});
    assert.equal(offline.clearEncoderPause(), true);
    assert.equal(offline.isEncoderStopped(), false);
    assert.equal(offline.isSeeding(), false);
  });

  it('cancels the seed window when pausing', () => {
    // Verify: cancels the seed window when pausing.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    let expired = 0;
    offline.scheduleSeedStop(1000, () => expired++);
    offline.pause(true);
    assert.equal(offline.isSeeding(), false);
    mock.timers.tick(5000);
    assert.equal(expired, 0);
  });
});

describe('OfflineState snapshot seed window', () => {
  it('runs the expiry callback once after the seed duration and ends the window', () => {
    // Verify: runs the expiry callback once after the seed duration and ends the window.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    let expired = 0;
    offline.scheduleSeedStop(25, () => expired++);
    assert.equal(offline.isSeeding(), true);
    mock.timers.tick(24);
    assert.equal(expired, 0);
    mock.timers.tick(1);
    assert.equal(expired, 1);
    assert.equal(offline.isSeeding(), false);
    mock.timers.tick(1000);
    assert.equal(expired, 1);
  });

  it('replaces a pending seed window and waits at least 1 ms', () => {
    // Verify: replaces a pending seed window and waits at least 1 ms.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    const calls = [];
    offline.scheduleSeedStop(100, () => calls.push('first'));
    offline.scheduleSeedStop(0, () => calls.push('second'));
    mock.timers.tick(1);
    assert.deepEqual(calls, ['second']);
    mock.timers.tick(1000);
    assert.deepEqual(calls, ['second']);
  });

  it('shortens the window to the post-consumer hold on the first consumer only', () => {
    // Verify: shortens the window to the post-consumer hold on the first consumer only.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    let expired = 0;
    offline.scheduleSeedStop(10000, () => expired++);
    assert.equal(offline.beginConsumerHold(300), 300);
    assert.equal(offline.beginConsumerHold(300), 0, 'a second consumer during the same window does nothing');
    mock.timers.tick(299);
    assert.equal(expired, 0);
    mock.timers.tick(1);
    assert.equal(expired, 1);
    assert.equal(offline.isSeeding(), false);
  });

  it('ignores a consumer when no seed window is active and floors the hold at 1 ms', () => {
    // Verify: ignores a consumer when no seed window is active and floors the hold at 1 ms.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    assert.equal(offline.beginConsumerHold(300), 0);
    offline.scheduleSeedStop(10000, () => {});
    assert.equal(offline.beginConsumerHold(0), 1);
  });

  it('clears the consumer-seen flag when a new window starts', () => {
    // Verify: clears the consumer-seen flag when a new window starts.
    mock.timers.enable({apis: ['setTimeout']});
    const offline = new OfflineState();
    offline.scheduleSeedStop(10000, () => {});
    assert.equal(offline.beginConsumerHold(50), 50);
    mock.timers.tick(50);
    offline.scheduleSeedStop(10000, () => {});
    assert.equal(offline.beginConsumerHold(60), 60);
  });
});
