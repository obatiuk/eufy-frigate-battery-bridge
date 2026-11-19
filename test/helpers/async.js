/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Deterministic async helpers for tests: wait for promise chains and I/O callbacks to settle without a wall-clock
 * sleep.
 */
'use strict';

const DEFAULT_FLUSH_TURNS = 25;
const DEFAULT_WAIT_TURNS = 200;

/**
 * Yields to the event loop a bounded number of times so queued microtasks, `process.nextTick` callbacks, and
 * `setImmediate` callbacks (including promise chains that hop between them) run to completion. It never waits for a
 * timer: advance fake timers with `mock.timers.tick()` before flushing when production code sleeps.
 *
 * @param {number} [turns=25] - Number of event-loop turns to yield.
 * @returns {Promise<void>}
 */
async function flushAsync(turns = DEFAULT_FLUSH_TURNS) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Yields to the event loop until `predicate()` returns true (bounded by iterations, never by wall-clock time).
 *
 * @param {() => boolean} predicate - Condition to wait for.
 * @returns {Promise<void>}
 */
async function waitUntil(predicate) {
  for (let turn = 0; turn < DEFAULT_WAIT_TURNS && !predicate(); turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

module.exports = {flushAsync, waitUntil};
