/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Concise node:test reporter that prints only test failures or a single total success summary line.
 */
'use strict';

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
    const details = event.data && event.data.details ? event.data.details : null;
    const isSuite = details && details.type === 'suite';

    if (event.type === 'test:pass' && !isSuite) {
      passed++;
    } else if (event.type === 'test:fail' && !isSuite) {
      failed++;
      const err = details ? details.error : null;
      const errMsg = (err && (err.stack || err.message)) || String(err || 'Test failed');
      failures.push('FAIL: ' + event.data.name + '\n' + errMsg);
    } else if (event.type === 'test:summary' && !event.data.file) {
      durationMs = Math.round(event.data.duration_ms || 0);
    }
  }

  if (failures.length > 0) {
    yield failures.join('\n\n') + '\n';
    yield 'Tests failed: ' + failed + ' failed, ' + passed + ' passed (' + durationMs + 'ms)\n';
    return;
  }

  yield 'Tests passed: ' + passed + '/' + (passed + failed) + ' (' + durationMs + 'ms)\n';
};
