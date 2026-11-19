/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for scripts/check-commit-msg.js and script-level // @ts-check coverage.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../helpers/test-env');

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');
const CHECK_COMMIT_MSG_PATH = path.join(SCRIPTS_DIR, 'check-commit-msg.js');

/**
 * Loads check-commit-msg exports, or returns null when scripts/ is absent (Dockerfile builder stage).
 *
 * @returns {{ findProblems: (msg: string) => string[] }|null}
 */
function loadCheckCommitMsg() {
  if (!fs.existsSync(CHECK_COMMIT_MSG_PATH)) {
    return null;
  }
  return require(CHECK_COMMIT_MSG_PATH);
}

describe('scripts/check-commit-msg.js', () => {
  it('enables // @ts-check across all scripts/*.js tooling files', () => {
    // Verify: every .js file in scripts/ starts with // @ts-check so tsc validates tooling alongside src/.
    if (!fs.existsSync(SCRIPTS_DIR)) {
      return;
    }
    const jsFiles = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((f) => f.endsWith('.js'))
      .sort();
    const missing = jsFiles.filter((f) => {
      const firstLine = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8').split('\n')[0];
      return firstLine.trim() !== '// @ts-check';
    });
    assert.deepEqual(missing, []);
  });

  it('accepts a valid <= 120-char bullet-only commit message with Co-authored-by trailer', () => {
    // Verify: findProblems returns an empty array for compliant bullet-only messages with a Co-authored-by trailer.
    const mod = loadCheckCommitMsg();
    if (!mod) {
      return;
    }
    const valid = [
      '- Align module boundaries, state-machine logging, and shutdown timer cleanup across services',
      '- Enforce 120-column commit lines, least-privilege CI permissions, and test verification comments',
      '',
      'Co-authored-by: Gemini <gemini@google.com>',
    ].join('\n');
    assert.deepEqual(mod.findProblems(valid), []);
  });

  it('rejects lines over 120 characters, subject lines, escapes, dashes, and home paths', () => {
    // Verify: findProblems flags lines > 120 chars as well as missing trailers, escapes, dashes, and PII paths.
    const mod = loadCheckCommitMsg();
    if (!mod) {
      return;
    }
    const overlongBullet = '- ' + 'a'.repeat(119);
    const overlongProblems = mod.findProblems(overlongBullet + '\n\nCo-authored-by: Gemini <gemini@google.com>\n');
    assert.equal(
      overlongProblems.some((p) => p.includes('120')),
      true
    );

    const escapedProblems = mod.findProblems('\\- Escaped bullet\n\nCo-authored-by: Gemini \\<gemini@google.com\\>\n');
    assert.equal(
      escapedProblems.some((p) => p.includes('escape')),
      true
    );

    const dashChar = String.fromCharCode(0x2014);
    const piiPath = '/' + 'home' + '/alice/config.yaml';
    const dashAndPii = mod.findProblems(
      '- Bad ' + dashChar + ' dash at ' + piiPath + '\n\nCo-authored-by: Gemini <gemini@google.com>\n'
    );
    assert.equal(
      dashAndPii.some((p) => p.includes('en-dash or em-dash')),
      true
    );
    assert.equal(
      dashAndPii.some((p) => p.includes('home directory')),
      true
    );
  });
});
