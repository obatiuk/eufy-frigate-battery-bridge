/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the regression tag check in scripts/check-docs.js: every docs/regression/NN-*.md entry needs a test
 * titled "Regression NN: ...", and every such tag needs an entry (like AT-NN for the acceptance suite).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_DOCS_PATH = path.join(__dirname, '..', '..', 'scripts', 'check-docs.js');

/**
 * Loads checkRegressionTags, or returns null when scripts/ is absent (the Dockerfile builder stage does not copy it).
 *
 * @returns {Function|null}
 */
function loadCheck() {
  if (!fs.existsSync(CHECK_DOCS_PATH)) {
    return null;
  }
  const {checkRegressionTags} = require(CHECK_DOCS_PATH);
  assert.equal(typeof checkRegressionTags, 'function', 'scripts/check-docs.js must export checkRegressionTags');
  return checkRegressionTags;
}

/**
 * Runs the check and returns its error list.
 *
 * @param {number[]} entries - Regression entry numbers that exist in docs/regression/.
 * @param {string[]} titles - Test titles, as written inside it('...').
 * @param {number[]} [untaggedBaseline] - Entries allowed to have no tagged test yet.
 * @returns {string[]|null}
 */
function runCheck(entries, titles, untaggedBaseline = []) {
  const check = loadCheck();
  if (!check) {
    return null;
  }
  const source = titles.map((title) => "  it('" + title + "', () => {});").join('\n');
  const errs = [];
  check(entries, [{file: 'test/sample.test.js', text: source}], new Set(untaggedBaseline), errs);
  return errs;
}

describe('regression tag check (scripts/check-docs.js)', () => {
  it('passes when every entry has a tagged test and every tag has an entry', () => {
    // Verify: passes when every entry has a tagged test and every tag has an entry.
    const errs = runCheck([1, 2], ['Regression 1: first bug', 'Regression 2: second bug', 'unrelated test']);
    assert.deepEqual(errs, errs === null ? null : []);
  });

  it('accepts several numbers in one title', () => {
    // Verify: accepts several numbers in one title.
    const errs = runCheck([11, 24], ['Regression 11, 24: shared test']);
    assert.deepEqual(errs, errs === null ? null : []);
  });

  it('fails an entry that has no tagged test and is not in the baseline', () => {
    // Verify: a new post-mortem must come with a test named after it.
    const errs = runCheck([1, 2], ['Regression 1: first bug']);
    if (errs !== null) {
      assert.equal(errs.length, 1);
      assert.match(errs[0], /regression entry 2 has no test titled "Regression 2: \.\.\."/);
    }
  });

  it('fails a tag that has no entry', () => {
    // Verify: fails a tag that has no entry.
    const errs = runCheck([1], ['Regression 1: first bug', 'Regression 7: ghost']);
    if (errs !== null) {
      assert.equal(errs.length, 1);
      assert.match(errs[0], /test\/sample\.test\.js: tag "Regression 7" has no docs\/regression\/07-\*\.md entry/);
    }
  });

  it('allows a baseline entry without a tagged test', () => {
    // Verify: allows a baseline entry without a tagged test.
    const errs = runCheck([1, 2], ['Regression 1: first bug'], [2]);
    assert.deepEqual(errs, errs === null ? null : []);
  });

  it('fails a baseline entry that is tagged now so the baseline only shrinks', () => {
    // Verify: fails a baseline entry that is tagged now so the baseline only shrinks.
    const errs = runCheck([1, 2], ['Regression 1: first bug', 'Regression 2: second bug'], [2]);
    if (errs !== null) {
      assert.equal(errs.length, 1);
      assert.match(errs[0], /regression entry 2 now has a tagged test; remove it from the untagged baseline/);
    }
  });

  it('fails a baseline entry that does not exist', () => {
    // Verify: fails a baseline entry that does not exist.
    const errs = runCheck([1], ['Regression 1: first bug'], [9]);
    if (errs !== null) {
      assert.equal(errs.length, 1);
      assert.match(errs[0], /untagged baseline lists regression entry 9 but docs\/regression has no such entry/);
    }
  });

  it('ignores a Regression word that is not a tag', () => {
    // Verify: ignores a Regression word that is not a tag.
    const errs = runCheck([1], ['Regression 1: first bug', 'Regression: untagged legacy title', 'See Regression 1: x']);
    assert.deepEqual(errs, null === errs ? null : []);
  });

  it('has emptied UNTAGGED_REGRESSIONS so every repository post-mortem has a Regression NN test', () => {
    // Verify: entries 1-10 and 16 all have dedicated Regression NN tests and the untagged baseline is empty.
    if (!fs.existsSync(CHECK_DOCS_PATH)) {
      return;
    }
    const {UNTAGGED_REGRESSIONS} = require(CHECK_DOCS_PATH);
    assert.equal(Array.isArray(UNTAGGED_REGRESSIONS), true);
    assert.deepEqual([...UNTAGGED_REGRESSIONS], []);
  });

  it('enforces 1:1 filename parity between docs/regression/NN-slug.md and test/regression/NN-slug.test.js', () => {
    // Verify: each regression post-mortem pairs with one test file sharing the exact NN-slug stem.
    if (!fs.existsSync(CHECK_DOCS_PATH)) {
      return;
    }
    const {checkRegressionTestFiles} = require(CHECK_DOCS_PATH);
    assert.equal(
      typeof checkRegressionTestFiles,
      'function',
      'scripts/check-docs.js must export checkRegressionTestFiles'
    );

    const okErrs = [];
    checkRegressionTestFiles(['docs/regression/01-first.md', 'test/regression/01-first.test.js'], okErrs);
    assert.deepEqual(okErrs, []);

    const missingTestErrs = [];
    checkRegressionTestFiles(
      ['docs/regression/01-first.md', 'docs/regression/02-second.md', 'test/regression/01-first.test.js'],
      missingTestErrs
    );
    assert.equal(missingTestErrs.length, 1);
    assert.match(
      missingTestErrs[0],
      /docs\/regression\/02-second\.md: missing matching test file test\/regression\/02-second\.test\.js/
    );

    const orphanTestErrs = [];
    checkRegressionTestFiles(
      ['docs/regression/01-first.md', 'test/regression/01-first.test.js', 'test/regression/03-orphan.test.js'],
      orphanTestErrs
    );
    assert.equal(orphanTestErrs.length, 1);
    assert.match(
      orphanTestErrs[0],
      /test\/regression\/03-orphan\.test\.js: missing matching post-mortem docs\/regression\/03-orphan\.md/
    );
  });
});
