/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Concise node:test reporter that prints only test failures or a single total success summary line. It fails the run
 * on skipped, todo, and empty runs, which node:test itself accepts.
 */
'use strict';

const util = require('node:util');

/**
 * Skip reasons that do not fail the run. The type-level camera coupling check needs `typescript`, which the Docker
 * builder stage does not install, and the check still runs in `make check`.
 */
const ALLOWED_SKIP_REASONS = Object.freeze(new Set(['typescript is not installed']));

/**
 * Formats a node:test error or cause value safely without throwing on null-prototype IPC objects.
 *
 * @param {*} err - Candidate error payload from event.data.details.
 * @returns {string}
 */
function formatReporterError(err) {
  if (!err) {
    return 'Test failed';
  }
  if (typeof err === 'string') {
    return err;
  }
  const cause = typeof err === 'object' && 'cause' in err ? err.cause : null;
  if (cause && typeof cause === 'object') {
    if (typeof cause.stack === 'string' && cause.stack) {
      return cause.stack;
    }
    if (typeof cause.message === 'string' && cause.message) {
      return cause.message;
    }
  }
  if (typeof err === 'object') {
    if (typeof err.stack === 'string' && err.stack) {
      return err.stack;
    }
    if (typeof err.message === 'string' && err.message) {
      return err.message;
    }
  }
  return util.inspect(cause || err, {depth: 4});
}

/**
 * Classifies a passing leaf test: a todo test or a skipped test is a violation (node:test counts both as passed and
 * exits 0), except the single documented skip when the type-level coupling check lacks `typescript`.
 *
 * @param {Record<string, *>} data - `test:pass` event data.
 * @returns {'pass'|'allowed-skip'|'skip'|'todo'}
 */
function classifyPassedTest(data) {
  if (data.todo) {
    return 'todo';
  }
  if (!data.skip) {
    return 'pass';
  }
  return ALLOWED_SKIP_REASONS.has(data.skip) ? 'allowed-skip' : 'skip';
}

/**
 * Formats node:test stream events into a concise summary or error report. A run that skipped a test, left a todo
 * test, or ran nothing fails: the failure is reported and `onFailure(1)` sets the process exit code, because
 * node:test itself exits 0 for those runs.
 *
 * @param {AsyncIterable<Record<string, *>>} source - Node test runner event stream.
 * @param {(exitCode: number) => void} onFailure - Receives the exit code to set when the run must fail.
 * @yields {string}
 */
async function* report(source, onFailure) {
  let passed = 0;
  let failed = 0;
  let allowedSkips = 0;
  let durationMs = 0;
  const failures = [];

  for await (const event of source) {
    const data = event && event.data ? event.data : {};
    const details = data.details || null;
    const isSuite = Boolean(details && details.type === 'suite');

    if (event.type === 'test:pass' && !isSuite) {
      const kind = classifyPassedTest(data);
      if (kind === 'pass') {
        passed++;
      } else if (kind === 'allowed-skip') {
        allowedSkips++;
      } else {
        failed++;
        failures.push('FAIL: ' + (data.name || 'test') + '\n' + (kind === 'todo' ? 'todo' : 'skipped') + ' test');
      }
    } else if (event.type === 'test:fail') {
      const err = details ? details.error : null;
      const isSuiteRollup = Boolean(isSuite && err && typeof err === 'object' && err.failureType === 'subtestsFailed');
      if (!isSuiteRollup) {
        failed++;
        failures.push('FAIL: ' + (data.name || data.file || 'suite') + '\n' + formatReporterError(err));
      }
    } else if (event.type === 'test:summary' && !data.file) {
      durationMs = Math.round(data.duration_ms || 0);
      if (data.success === false && failures.length === 0) {
        failed = Math.max(1, failed);
        failures.push('FAIL: test runner exited with failure');
      }
    }
  }

  if (passed + failed === 0) {
    failed++;
    failures.push('FAIL: no tests ran');
  }

  if (failures.length > 0) {
    onFailure(1);
    yield failures.join('\n\n') + '\n';
    yield 'Tests failed: ' + failed + ' failed, ' + passed + ' passed (' + durationMs + 'ms)\n';
    return;
  }

  const skippedNote = allowedSkips > 0 ? ', ' + allowedSkips + ' skipped' : '';
  yield 'Tests passed: ' + passed + '/' + (passed + failed) + ' (' + durationMs + 'ms)' + skippedNote + '\n';
}

/**
 * Reporter entry point used by `node --test --test-reporter`.
 *
 * @param {AsyncIterable<Record<string, *>>} source - Node test runner event stream.
 * @yields {string}
 */
async function* conciseReporter(source) {
  yield* report(source, (exitCode) => {
    process.exitCode = exitCode;
  });
}

conciseReporter.report = report;

module.exports = conciseReporter;
