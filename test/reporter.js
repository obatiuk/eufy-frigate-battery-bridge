/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Concise node:test reporter that prints only test failures or a single total success summary line.
 */
'use strict';

const util = require('node:util');

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
 * Formats node:test stream events into a concise summary or error report.
 *
 * @param {AsyncIterable<Record<string, *>>} source - Node test runner event stream.
 * @yields {string}
 */
module.exports = async function* conciseReporter(source) {
  let passed = 0;
  let failed = 0;
  let durationMs = 0;
  const failures = [];

  for await (const event of source) {
    const data = event && event.data ? event.data : {};
    const details = data.details || null;
    const isSuite = Boolean(details && details.type === 'suite');

    if (event.type === 'test:pass' && !isSuite) {
      passed++;
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

  if (failures.length > 0) {
    yield failures.join('\n\n') + '\n';
    yield 'Tests failed: ' + failed + ' failed, ' + passed + ' passed (' + durationMs + 'ms)\n';
    return;
  }

  yield 'Tests passed: ' + passed + '/' + (passed + failed) + ' (' + durationMs + 'ms)\n';
};
