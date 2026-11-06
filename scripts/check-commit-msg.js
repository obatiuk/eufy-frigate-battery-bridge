/**
 * Validates a commit message file against the git-commit skill: no subject line, bullet lines only, at most 8 lines,
 * a Co-authored-by trailer after one blank line, no escapes, no en-dash or em-dash, no home paths.
 * Usage: node scripts/check-commit-msg.js <message-file>
 */
'use strict';

const fs = require('node:fs');

const MAX_LINES = 8;
const MAX_BULLETS = 6;
const TRAILER_PREFIX = 'Co-authored-by: ';
const DASH_REGEX = new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']');
const HOME_REGEX = /\/home\/[a-z0-9_-]+/i;

/**
 * Returns the list of rule violations for a commit message.
 *
 * @param {string} message - Full commit message text.
 * @returns {string[]}
 */
function findProblems(message) {
  const lines = message.replace(/\s+$/, '').split('\n');
  const problems = [];
  const trailerIdx = lines.length - 1;
  const bullets = lines.filter((l) => l.startsWith('- '));
  if (lines.length > MAX_LINES) {
    problems.push('more than ' + MAX_LINES + ' lines');
  }
  if (bullets.length > MAX_BULLETS) {
    problems.push('more than ' + MAX_BULLETS + ' bullet lines');
  }
  if (!lines[0].startsWith('- ')) {
    problems.push('must start with a bullet (no subject line)');
  }
  if (!lines[trailerIdx].startsWith(TRAILER_PREFIX) || lines[trailerIdx - 1] !== '') {
    problems.push('must end with a blank line and a "' + TRAILER_PREFIX + '" trailer');
  }
  lines.slice(0, trailerIdx - 1).forEach((line) => {
    if (!line.startsWith('- ')) {
      problems.push('every body line must be a bullet: "' + line.slice(0, 40) + '"');
    }
  });
  if (/\\[-<]/.test(message)) {
    problems.push('contains a Markdown escape (backslash before - or <)');
  }
  if (DASH_REGEX.test(message)) {
    problems.push('contains an en-dash or em-dash');
  }
  if (HOME_REGEX.test(message)) {
    problems.push('contains a home directory path');
  }
  return problems;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: check-commit-msg.js <message-file>');
  process.exit(2);
}
const found = findProblems(fs.readFileSync(file, 'utf8'));
if (found.length > 0) {
  console.error('commit message rejected:\n- ' + found.join('\n- '));
  process.exit(1);
}
