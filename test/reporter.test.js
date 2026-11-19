/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the concise node:test reporter (test/reporter.js): a run that skipped tests, left a todo test, or
 * ran nothing must fail, so a silent skip can never pass the gate.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

const conciseReporter = require('./reporter');

const COUPLING_SKIP_REASON = 'typescript is not installed';

/**
 * Builds a node:test `test:pass` event for a leaf test.
 *
 * @param {string} name - Test name.
 * @param {Record<string, *>} [extra] - Extra event data such as `skip` or `todo`.
 * @returns {Record<string, *>}
 */
function passEvent(name, extra = {}) {
  return {type: 'test:pass', data: {name, details: {type: 'test'}, ...extra}};
}

/**
 * Runs the concise test reporter over synthetic events and returns captured output and exit codes.
 *
 * @param {Record<string, *>[]} events - Events to replay.
 * @returns {Promise<{output: string, exitCodes: number[]}>}
 */
async function runReporter(events) {
  const exitCodes = [];
  async function* source() {
    yield* events;
  }
  let output = '';
  for await (const chunk of conciseReporter.report(source(), (code) => exitCodes.push(code))) {
    output += chunk;
  }
  return {output, exitCodes};
}

describe('test reporter', () => {
  it('reports a clean run as passed without requesting a failing exit code', async () => {
    // Verify: reports a clean run as passed without requesting a failing exit code.
    const {output, exitCodes} = await runReporter([passEvent('a'), passEvent('b')]);
    assert.match(output, /^Tests passed: 2\/2 \(\d+ms\)\n$/);
    assert.deepEqual(exitCodes, []);
  });

  it('fails a run that skipped a test', async () => {
    // Verify: a skipped test is not a passing test, so the gate must not stay green.
    const {output, exitCodes} = await runReporter([passEvent('a'), passEvent('b', {skip: 'flaky on CI'})]);
    assert.match(output, /FAIL: b\n/);
    assert.match(output, /skipped/);
    assert.match(output, /Tests failed: 1 failed, 1 passed/);
    assert.deepEqual(exitCodes, [1]);
  });

  it('fails a run that skipped a test without a reason', async () => {
    // Verify: fails a run that skipped a test without a reason.
    const {output, exitCodes} = await runReporter([passEvent('a'), passEvent('b', {skip: true})]);
    assert.match(output, /Tests failed: 1 failed, 1 passed/);
    assert.deepEqual(exitCodes, [1]);
  });

  it('fails a run that contains a todo test', async () => {
    // Verify: fails a run that contains a todo test.
    const {output, exitCodes} = await runReporter([passEvent('a'), passEvent('c', {todo: 'later'})]);
    assert.match(output, /FAIL: c\n/);
    assert.match(output, /todo/);
    assert.match(output, /Tests failed: 1 failed, 1 passed/);
    assert.deepEqual(exitCodes, [1]);
  });

  it('fails an empty run', async () => {
    // Verify: fails an empty run.
    const {output, exitCodes} = await runReporter([]);
    assert.match(output, /FAIL: no tests ran\n/);
    assert.match(output, /Tests failed: 1 failed, 0 passed/);
    assert.deepEqual(exitCodes, [1]);
  });

  it('fails a run in which every test was skipped', async () => {
    // Verify: fails a run in which every test was skipped.
    const {exitCodes} = await runReporter([passEvent('a', {skip: COUPLING_SKIP_REASON})]);
    assert.deepEqual(exitCodes, [1]);
  });

  it('allows the one documented skip when typescript is missing and still passes the run', async () => {
    // Verify: allows the one documented skip when typescript is missing and still passes the run.
    // The Docker builder stage installs production dependencies only, so the type-level coupling check skips.
    const {output, exitCodes} = await runReporter([passEvent('a'), passEvent('b', {skip: COUPLING_SKIP_REASON})]);
    assert.match(output, /^Tests passed: 1\/1 \(\d+ms\), 1 skipped\n$/);
    assert.deepEqual(exitCodes, []);
  });

  it('keeps counting real failures and requests a failing exit code', async () => {
    // Verify: keeps counting real failures and requests a failing exit code.
    const {output, exitCodes} = await runReporter([
      passEvent('a'),
      {type: 'test:fail', data: {name: 'b', details: {type: 'test', error: new Error('boom')}}},
    ]);
    assert.match(output, /FAIL: b\n/);
    assert.match(output, /Tests failed: 1 failed, 1 passed/);
    assert.deepEqual(exitCodes, [1]);
  });
});
