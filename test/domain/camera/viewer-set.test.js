/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the ViewerSet domain model (src/domain/camera/viewer-set.js): the go2rtc consumers connected to one
 * camera and which of them are allowed to wake or hold it.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {ViewerSet} = require('../../../src/domain/camera/viewer-set');

describe('ViewerSet (src/domain/camera/viewer-set.js)', () => {
  it('starts empty with no waking viewers', () => {
    // Verify: a new camera has no connected or waking viewers.
    const viewers = new ViewerSet();
    assert.equal(viewers.hasAny(), false);
    assert.equal(viewers.count(), 0);
    assert.equal(viewers.hasWaking(), false);
    assert.equal(viewers.wakingCount(), 0);
    assert.equal(viewers.has('a'), false);
  });

  it('registers new consumers as non-waking until they are allowed to wake the camera', () => {
    // Verify: a freshly connected consumer is tracked but never wakes the camera on its own.
    const viewers = new ViewerSet();
    viewers.register('a');
    assert.equal(viewers.has('a'), true);
    assert.equal(viewers.hasWaking(), false);

    viewers.setWaking('a', true);
    assert.equal(viewers.hasWaking(), true);
    assert.equal(viewers.wakingCount(), 1);

    viewers.setWaking('a', 0);
    assert.equal(viewers.hasWaking(), false, 'any falsy value clears the waking flag');
    viewers.setWaking('a', 'yes');
    assert.equal(viewers.wakingCount(), 1, 'any truthy value sets the waking flag');
  });

  it('clears every waking flag but keeps the consumers tracked until they disconnect', () => {
    // Verify: clearing the wake queue stops viewers from waking the camera without forgetting them, so a viewer must
    // disconnect and reconnect before it can wake the camera again.
    const viewers = new ViewerSet();
    viewers.register('a');
    viewers.register('b');
    viewers.setWaking('a', true);
    viewers.setWaking('b', true);
    assert.equal(viewers.wakingCount(), 2);

    viewers.clearWaking();
    assert.equal(viewers.wakingCount(), 0);
    assert.equal(viewers.has('a'), true);
    assert.equal(viewers.has('b'), true);
  });

  it('prunes consumers that left go2rtc, reports them, and stores the new viewer total', () => {
    // Verify: pruning drops consumers missing from the latest poll, reports whether each was waking the camera, and
    // records the polled non-recorder viewer count (which may differ from the tracked consumer count).
    const viewers = new ViewerSet();
    viewers.register('a');
    viewers.register('b');
    viewers.register('c');
    viewers.setWaking('b', true);

    const disconnected = viewers.prune(new Set(['a']), 3);
    assert.deepEqual(disconnected, [
      {id: 'b', wasActiveViewer: true},
      {id: 'c', wasActiveViewer: false},
    ]);
    assert.equal(viewers.has('a'), true);
    assert.equal(viewers.has('b'), false);
    assert.equal(viewers.count(), 3);
    assert.equal(viewers.hasAny(), true);

    assert.deepEqual(viewers.prune(new Set(), 0), [{id: 'a', wasActiveViewer: false}]);
    assert.equal(viewers.count(), 0);
    assert.equal(viewers.hasAny(), false);
  });
});
