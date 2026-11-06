/**
 * ESLint flat config: mechanical enforcement of the structural rules from the nodejs-development skill.
 * Existing violations are recorded in scripts/eslint-suppressions.json (bulk suppressions), so only new violations fail.
 * Run `make lint-prune` after fixing violations to prune the suppressions file.
 */
'use strict';

const MAX_PARAMS = 3;
const MAX_FILE_LINES = 1500;
const MAX_COMPLEXITY = 25;
const ALLOWED_LITERALS = [-1, 0, 1, 2];

module.exports = [
  {
    files: ['src/**/*.js'],
    languageOptions: {ecmaVersion: 2022, sourceType: 'commonjs'},
    rules: {
      'max-params': ['error', MAX_PARAMS],
      'max-lines': ['error', {max: MAX_FILE_LINES, skipBlankLines: true, skipComments: true}],
      complexity: ['error', MAX_COMPLEXITY],
      'no-magic-numbers': ['error', {ignore: ALLOWED_LITERALS, ignoreArrayIndexes: true}],
    },
  },
];
