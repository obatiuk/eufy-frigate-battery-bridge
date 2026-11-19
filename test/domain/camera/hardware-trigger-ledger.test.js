/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the HardwareTriggerLedger domain model (src/domain/camera/hardware-trigger-ledger.js): the Eufy
 * hardware detection events (motion, person, ring) currently reported as active for one camera.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {HardwareTriggerLedger} = require('../../../src/domain/camera/hardware-trigger-ledger');

describe('HardwareTriggerLedger (src/domain/camera/hardware-trigger-ledger.js)', () => {
  it('tracks started events by lowercase name and clears them individually or all at once', () => {
    // Verify: event names are case-insensitive, repeated starts do not duplicate, and clearing removes the entry.
    const ledger = new HardwareTriggerLedger();
    assert.equal(ledger.isEmpty(), true);
    assert.deepEqual(ledger.activeEvents(), []);

    ledger.start('Motion Detected', 1000);
    ledger.start('motion detected', 1500);
    ledger.start('Person Detected', 1600);
    assert.deepEqual(ledger.activeEvents(), ['motion detected', 'person detected']);
    assert.equal(ledger.isEmpty(), false);
    assert.equal(ledger.lastStartEvent(), 'person detected');

    ledger.clear('MOTION DETECTED', 2000);
    assert.deepEqual(ledger.activeEvents(), ['person detected']);
    ledger.clear('unknown event', 2100);
    assert.deepEqual(ledger.activeEvents(), ['person detected']);

    ledger.clearAll();
    assert.equal(ledger.isEmpty(), true);
    const copy = ledger.activeEvents();
    copy.push('mutated');
    assert.deepEqual(ledger.activeEvents(), [], 'activeEvents() returns a copy');
  });

  it('expires entries older than the maximum age and keeps entries with an unknown start time', () => {
    // Verify: a lost clear event cannot keep the camera "triggered" forever; entries expire once strictly older than
    // 130s, an entry exactly 130s old is kept, and entries without a recorded start are never expired.
    const ledger = new HardwareTriggerLedger();
    ledger.start('motion detected', 1000);
    ledger.start('person detected', 100000);

    ledger.expireStale(131000);
    assert.deepEqual(ledger.activeEvents(), ['motion detected', 'person detected'], 'exactly 130s old is kept');
    ledger.expireStale(131001);
    assert.deepEqual(ledger.activeEvents(), ['person detected']);
    ledger.expireStale(230001);
    assert.deepEqual(ledger.activeEvents(), []);

    ledger.events.add('ring detected');
    ledger.expireStale(999999999);
    assert.deepEqual(ledger.activeEvents(), ['ring detected'], 'unknown start time is never expired');
  });

  it('reports unexpired entries for a given maximum age', () => {
    // Verify: hasUnexpired() is true while any entry is within the age limit or has no recorded start.
    const ledger = new HardwareTriggerLedger();
    assert.equal(ledger.hasUnexpired(5000, 130000), false);
    ledger.start('motion detected', 1000);
    assert.equal(ledger.hasUnexpired(131000, 130000), true);
    assert.equal(ledger.hasUnexpired(131001, 130000), false);
    assert.equal(ledger.hasUnexpired(131001, 200000), true);
    ledger.events.add('ring detected');
    assert.equal(ledger.hasUnexpired(999999999, 130000), true);
  });

  it('detects companion start and clear duplicates only within one second', () => {
    // Verify: eufy-security-ws fires both a property change and the native event for one detection; the second is a
    // duplicate only when it names the same event, arrives under 1000ms later, and (for starts) the person matches.
    const ledger = new HardwareTriggerLedger();
    ledger.start('motion detected', 10000);
    assert.equal(ledger.isDuplicateStart('Motion Detected', 10999, true), true);
    assert.equal(ledger.isDuplicateStart('motion detected', 11000, true), false, 'exactly 1000ms is not a duplicate');
    assert.equal(ledger.isDuplicateStart('motion detected', 10500, false), false, 'a different person is not');
    assert.equal(ledger.isDuplicateStart('person detected', 10500, true), false, 'a different event is not');

    ledger.clear('motion detected', 20000);
    assert.equal(ledger.isDuplicateClear('MOTION DETECTED', 20999), true);
    assert.equal(ledger.isDuplicateClear('motion detected', 21000), false);
    assert.equal(ledger.isDuplicateClear('person detected', 20500), false);

    ledger.start('motion detected', 30000);
    assert.equal(ledger.isDuplicateClear('motion detected', 30100), false, 'an active event is not a clear duplicate');
  });
});
