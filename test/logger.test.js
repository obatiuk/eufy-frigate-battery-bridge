/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for structured Alloy/Loki logging and local timestamp formatting (src/logger.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-env');
const {installDefaultFetchStub} = require('./helpers/service-mocks');
const {
  formatLocalTimestamp,
  formatLocalHm,
  formatFileTimestamp,
  parseFileTimestampMs,
  formatRelativeAge,
  normalizeLevelName,
  formatLogLine,
  initLogger,
} = require('../src/logger');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('Structured Alloy/Loki Logger & Root-Cause Error Diagnostics (src/logger.js)', () => {
  it('formats local timestamps, normalizes log severity levels, and formats scoped log lines', () => {
    // Verify: formats local timestamps, normalizes log severity levels, and formats scoped log lines.
    const fixedDate = new Date(2026, 10, 5, 8, 4, 9);
    assert.equal(formatLocalTimestamp(fixedDate), '2026-11-05 08:04:09');
    assert.equal(formatLocalHm(fixedDate), '08:04');

    assert.equal(normalizeLevelName('WARNING'), 'warn');
    assert.equal(normalizeLevelName('DEBUG'), 'debug');
    assert.equal(normalizeLevelName('invalid_level'), 'info');

    const camScope = {name: 'T8214T2222222222', state: 'handshaking_backfill'};
    const warnLine = formatLogLine('warn', camScope, ['stream stalled', 'retrying'], fixedDate);
    const infoLine = formatLogLine('info', camScope, ['WAKE'], fixedDate);
    const debugLine = formatLogLine('debug', camScope, ['started FFmpeg decoder'], fixedDate);
    const errorLine = formatLogLine('error', camScope, ['socket closed'], fixedDate);
    assert.equal(
      warnLine,
      '2026-11-05 08:04:09 - [WARN ] - [T8214T2222222222] [HANDSHAKING_BACKFILL] stream stalled retrying'
    );
    assert.equal(infoLine, '2026-11-05 08:04:09 - [INFO ] - [T8214T2222222222] [HANDSHAKING_BACKFILL] WAKE');
    assert.equal(
      debugLine,
      '2026-11-05 08:04:09 - [DEBUG] - [T8214T2222222222] [HANDSHAKING_BACKFILL] started FFmpeg decoder'
    );
    assert.equal(errorLine, '2026-11-05 08:04:09 - [ERROR] - [T8214T2222222222] [HANDSHAKING_BACKFILL] socket closed');
    assert.equal(warnLine.indexOf('[T8214T2222222222]'), debugLine.indexOf('[T8214T2222222222]'));
    assert.equal(infoLine.indexOf('[T8214T2222222222]'), errorLine.indexOf('[T8214T2222222222]'));
    const backfillScope = {name: 'doorbell', state: 'ready_to_query'};
    assert.equal(
      formatLogLine('info', backfillScope, ['querying HomeBase'], fixedDate),
      '2026-11-05 08:04:09 - [INFO ] - [doorbell] [READY_TO_QUERY] querying HomeBase'
    );
    const decoderScope = {name: 'doorbell', state: 'paused_backpressure'};
    assert.equal(
      formatLogLine('debug', decoderScope, ['decoder paused'], fixedDate),
      '2026-11-05 08:04:09 - [DEBUG] - [doorbell] [PAUSED_BACKPRESSURE] decoder paused'
    );
    const eventScope = {name: 'doorbell', state: 'waiting_snapshot'};
    assert.equal(
      formatLogLine('debug', eventScope, ['waiting for clean snapshot'], fixedDate),
      '2026-11-05 08:04:09 - [DEBUG] - [doorbell] [WAITING_SNAPSHOT] waiting for clean snapshot'
    );
    assert.equal(
      formatLogLine('debug', 'bridge', ['polling HomeBase'], fixedDate),
      '2026-11-05 08:04:09 - [DEBUG] - [bridge] polling HomeBase'
    );
    assert.equal(
      formatLogLine('info', null, ['listening'], fixedDate),
      '2026-11-05 08:04:09 - [INFO ] - [bridge] listening'
    );

    assert.equal(initLogger('debug'), 'debug');
    assert.equal(initLogger('error'), 'error');
  });

  it('resolves explicit log scopes: a name string, {name, state}, or an object that provides getLogScope()', () => {
    // Verify: the logger reads one explicit contract (a string, {name, state}, or getLogScope()), never the
    // sessionState / decoderState / evState / cameraName / getName() fields of whatever object it is handed.
    const fixedDate = new Date(2026, 10, 5, 8, 4, 9);
    const stamp = '2026-11-05 08:04:09 - [INFO ] - ';

    const provider = {getLogScope: () => ({name: 'porch', state: 'streaming_live'})};
    assert.equal(formatLogLine('info', provider, ['hello'], fixedDate), stamp + '[porch] [STREAMING_LIVE] hello');

    const stateless = {getLogScope: () => ({name: 'porch'})};
    assert.equal(formatLogLine('info', stateless, ['hello'], fixedDate), stamp + '[porch] hello');

    assert.equal(formatLogLine('info', {name: 'porch'}, ['hello'], fixedDate), stamp + '[porch] hello');
    assert.equal(formatLogLine('info', '', ['hello'], fixedDate), stamp + '[bridge] hello');
    assert.equal(formatLogLine('info', {}, ['hello'], fixedDate), stamp + '[bridge] hello');

    const legacyScopes = [
      {name: 'porch', sessionState: 'idle'},
      {name: 'porch', decoderState: 'detached'},
      {name: 'porch', evState: 'idle'},
    ];
    for (const legacy of legacyScopes) {
      assert.equal(
        formatLogLine('info', legacy, ['hello'], fixedDate),
        stamp + '[porch] hello',
        'legacy duck-typed state key must not add a state tag: ' + JSON.stringify(legacy)
      );
    }
    assert.equal(formatLogLine('info', {cameraName: 'porch'}, ['hello'], fixedDate), stamp + '[bridge] hello');
    assert.equal(formatLogLine('info', {getName: () => 'porch'}, ['hello'], fixedDate), stamp + '[bridge] hello');
  });

  it('formats and parses filesystem-safe timestamps and formats human-friendly relative ages', () => {
    // Verify: snapshot filenames round-trip local timestamps without colons and format friendly relative ages.
    const fixedDate = new Date(2026, 10, 19, 18, 16, 4);
    const stamp = formatFileTimestamp(fixedDate);
    assert.equal(stamp, '2026-11-19_18-16-04');
    assert.equal(parseFileTimestampMs(stamp), fixedDate.getTime());
    assert.equal(parseFileTimestampMs('2026-02-31_12-00-00'), 0);
    assert.equal(parseFileTimestampMs('not-a-timestamp'), 0);
    assert.equal(parseFileTimestampMs(''), 0);

    assert.equal(formatRelativeAge(0), 'just now');
    assert.equal(formatRelativeAge(4_000), 'just now');
    assert.equal(formatRelativeAge(45_000), '45s ago');
    assert.equal(formatRelativeAge(12 * 60_000 + 19_000), '12m ago');
    assert.equal(formatRelativeAge(2 * 3_600_000), '2h ago');
    assert.equal(formatRelativeAge(2 * 3_600_000 + 35 * 60_000), '2h 35m ago');
    assert.equal(formatRelativeAge(3 * 86_400_000), '3d ago');
    assert.equal(formatRelativeAge(3 * 86_400_000 + 4 * 3_600_000), '3d 4h ago');
  });
});
