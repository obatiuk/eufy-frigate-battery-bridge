/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the documentation budgets in scripts/check-docs.js: the compact regression index entries, the width
 * rule exemption for them, and the per-file size limits (including the README budget).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TEST_TMP_DIR = path.join(REPO_ROOT, '.tmp');
const CHECK_DOCS_PATH = path.join(REPO_ROOT, 'scripts', 'check-docs.js');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');
const DOCKERIGNORE_PATH = path.join(REPO_ROOT, '.dockerignore');
const KB = 1024;

/**
 * Loads the check-docs exports, or returns null when scripts/ is absent (the Dockerfile builder stage skips it).
 *
 * @returns {Record<string, Function>|null}
 */
function loadCheckDocs() {
  if (!fs.existsSync(CHECK_DOCS_PATH)) {
    return null;
  }
  const {
    listFiles,
    parseRegressionIndexEntry,
    widthLines,
    checkSizeBudget,
    collectSrcBasenames,
    checkChangelogReleaseTag,
    checkChangelogPostRelease,
    checkComposeHasNoHealthcheck,
  } = require(CHECK_DOCS_PATH);
  for (const [name, fn] of Object.entries({
    listFiles,
    parseRegressionIndexEntry,
    widthLines,
    checkSizeBudget,
    collectSrcBasenames,
    checkChangelogReleaseTag,
    checkChangelogPostRelease,
    checkComposeHasNoHealthcheck,
  })) {
    assert.equal(typeof fn, 'function', 'scripts/check-docs.js must export ' + name);
  }
  return {
    listFiles,
    parseRegressionIndexEntry,
    widthLines,
    checkSizeBudget,
    collectSrcBasenames,
    checkChangelogReleaseTag,
    checkChangelogPostRelease,
    checkComposeHasNoHealthcheck,
  };
}

const ENTRY =
  '- **18** [Viewer Cooldown Must Not Block Wakes](regression/18-viewer-cooldown.md) - `camera.js`, `telemetry.js` - ' +
  'AT-09, AT-11';

describe('regression index entries', () => {
  it('parses number, title, link, files, and acceptance IDs from one list line', () => {
    // Verify: parses number, title, link, files, and acceptance IDs from one list line.
    const docs = loadCheckDocs();
    if (!docs) return;
    assert.deepEqual(docs.parseRegressionIndexEntry(ENTRY), {
      ok: true,
      num: 18,
      title: 'Viewer Cooldown Must Not Block Wakes',
      rel: 'regression/18-viewer-cooldown.md',
      files: ['camera.js', 'telemetry.js'],
      atText: 'AT-09, AT-11',
    });
  });

  it('accepts a dash for no acceptance test and a title with backticks', () => {
    // Verify: accepts a dash for no acceptance test and a title with backticks.
    const docs = loadCheckDocs();
    if (!docs) return;
    const entry = '- **16** [`"backfill"` Mode `/api/wake` With No Clip](regression/16-x.md) - `camera.js` - -';
    const parsed = docs.parseRegressionIndexEntry(entry);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.title, '`"backfill"` Mode `/api/wake` With No Clip');
    assert.equal(parsed.atText, '-');
  });

  it('ignores lines that are not index entries and flags a malformed entry', () => {
    // Verify: ignores lines that are not index entries and flags a malformed entry.
    const docs = loadCheckDocs();
    if (!docs) return;
    assert.equal(docs.parseRegressionIndexEntry('# Regression knowledge base'), null);
    assert.equal(docs.parseRegressionIndexEntry(''), null);
    assert.equal(docs.parseRegressionIndexEntry('- a plain bullet'), null);
    assert.deepEqual(docs.parseRegressionIndexEntry('- **7** Missing the link - `camera.js` - AT-01'), {ok: false});
  });

  it('maps src/<folder>/index.js to <folder>.js so historical regression entries stay valid', () => {
    // Verify splitting src/config.js into src/config/index.js keeps `config.js` valid in docs/REGRESSION.md.
    const docs = loadCheckDocs();
    if (!docs) return;
    const names = docs.collectSrcBasenames(['src/app.js', 'src/config/index.js', 'src/config/env.js', 'README.md']);
    assert.deepEqual([...names].sort(), ['app.js', 'config.js', 'env.js', 'index.js']);
  });
});

describe('width rule', () => {
  it('exempts regression index entries (they carry a long link) but not long prose', () => {
    // Verify: exempts regression index entries (they carry a long link) but not long prose.
    const docs = loadCheckDocs();
    if (!docs) return;
    const longProse = 'word '.repeat(30).trim();
    const lines = docs.widthLines([ENTRY + ' '.repeat(80), longProse].join('\n'));
    assert.deepEqual(
      lines.map((l) => l.text),
      [longProse]
    );
  });
});

describe('size budgets', () => {
  it('limits README.md to 68 KB so it cannot keep growing', () => {
    // Verify: README.md stays under 68 KB while preserving its standalone end-user setup and troubleshooting guide.
    const docs = loadCheckDocs();
    if (!docs) return;
    const errs = [];
    docs.checkSizeBudget('README.md', 68 * KB, errs);
    assert.deepEqual(errs, []);
    docs.checkSizeBudget('README.md', 68 * KB + 1, errs);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /^README\.md: 69633 bytes exceeds 69632; move detail to docs\/$/);
  });

  it('keeps the existing limits for AGENTS.md, docs, and skills', () => {
    // Verify: keeps the existing limits for AGENTS.md, docs, and skills.
    const docs = loadCheckDocs();
    if (!docs) return;
    const errs = [];
    docs.checkSizeBudget('AGENTS.md', 16 * KB, errs);
    docs.checkSizeBudget('docs/architecture.md', 20 * KB, errs);
    docs.checkSizeBudget('.agents/skills/x/SKILL.md', 4 * KB, errs);
    docs.checkSizeBudget('src/app.js', 500 * KB, errs);
    assert.deepEqual(errs, []);
    docs.checkSizeBudget('AGENTS.md', 16 * KB + 1, errs);
    docs.checkSizeBudget('docs/architecture.md', 20 * KB + 1, errs);
    docs.checkSizeBudget('.agents/skills/x/SKILL.md', 4 * KB + 1, errs);
    assert.equal(errs.length, 3);
  });
});

describe('release changelog and compose checks', () => {
  it('enforces CHANGELOG.md release heading parity on exact vX.Y.Z Git tags', () => {
    // Verify release tags require a matching ## vX.Y.Z top section with entries and forbid ## dev.
    const docs = loadCheckDocs();
    if (!docs) return;

    const validChangelog = '# Changelog\n\n## v0.0.2\n\n- Ship clean release\n\n## v0.0.1\n\n- Initial release\n';
    const okErrors = [];
    docs.checkChangelogReleaseTag('v0.0.2', validChangelog, okErrors);
    assert.deepEqual(okErrors, []);

    const devErrors = [];
    docs.checkChangelogReleaseTag('v0.0.2', '# Changelog\n\n## dev\n\n- Unreleased item\n', devErrors);
    assert.ok(devErrors.some((e) => e.includes('## dev')));

    const mismatchErrors = [];
    docs.checkChangelogReleaseTag('v0.0.3', validChangelog, mismatchErrors);
    assert.ok(mismatchErrors.some((e) => e.includes('v0.0.3')));

    const emptyErrors = [];
    docs.checkChangelogReleaseTag(
      'v0.0.2',
      '# Changelog\n\n## v0.0.2\n\n## v0.0.1\n\n- Initial release\n',
      emptyErrors
    );
    assert.ok(emptyErrors.length > 0);
  });

  it('rejects a healthcheck in Compose files because the Dockerfile owns it', () => {
    // Verify Compose files never redefine the image HEALTHCHECK, while commented mentions stay allowed.
    const docs = loadCheckDocs();
    if (!docs) return;

    const cleanErrs = [];
    docs.checkComposeHasNoHealthcheck(
      'deploy/docker-compose.example.yml',
      'services:\n  bridge:\n    # healthcheck: is defined in the Dockerfile\n    restart: unless-stopped\n',
      cleanErrs
    );
    assert.deepEqual(cleanErrs, []);

    const dupErrs = [];
    docs.checkComposeHasNoHealthcheck(
      'deploy/docker-compose.example.yml',
      'services:\n  bridge:\n    healthcheck:\n      test: [CMD, true]\n',
      dupErrs
    );
    assert.equal(dupErrs.length, 1);
    assert.ok(dupErrs[0].includes('deploy/docker-compose.example.yml:3'));
    assert.ok(dupErrs[0].includes('Dockerfile'));
  });

  it('enforces post-release ## dev section and immutable tagged sections', () => {
    // Verify post-release CHANGELOG.md edits go under ## dev above the latest tag and never mutate tagged sections.
    const docs = loadCheckDocs();
    if (!docs) return;

    const taggedV002 =
      '# Changelog\n\nFinished work, newest first.\n\n## v0.0.2\n\n- Ship v0.0.2\n\n## v0.0.1\n\n- Initial release\n';

    const unchangedErrs = [];
    docs.checkChangelogPostRelease('v0.0.2', taggedV002, taggedV002, '0.0.2', unchangedErrs);
    assert.deepEqual(unchangedErrs, []);

    const mutatedRelease =
      '# Changelog\n\nFinished work, newest first.\n\n## v0.0.2\n\n- Ship v0.0.2 and sneak in post-release fix\n\n' +
      '## v0.0.1\n\n- Initial release\n';
    const mutatedErrs = [];
    docs.checkChangelogPostRelease('v0.0.2', taggedV002, mutatedRelease, '0.0.2', mutatedErrs);
    assert.ok(
      mutatedErrs.some((e) => e.includes('## v0.0.2') && e.includes('## dev')),
      'Mutating a released ## v0.0.2 section after tagging must fail'
    );

    const validDev =
      '# Changelog\n\nFinished work, newest first.\n\n## dev\n\n- Fix backfill clip preservation\n\n' +
      '## v0.0.2\n\n- Ship v0.0.2\n\n## v0.0.1\n\n- Initial release\n';
    const devOkErrs = [];
    docs.checkChangelogPostRelease('v0.0.2', taggedV002, validDev, '0.0.2', devOkErrs);
    assert.deepEqual(devOkErrs, []);

    const emptyDev =
      '# Changelog\n\nFinished work, newest first.\n\n## dev\n\n' +
      '## v0.0.2\n\n- Ship v0.0.2\n\n## v0.0.1\n\n- Initial release\n';
    const emptyDevErrs = [];
    docs.checkChangelogPostRelease('v0.0.2', taggedV002, emptyDev, '0.0.2', emptyDevErrs);
    assert.ok(emptyDevErrs.some((e) => e.includes('## dev')));

    const nextRelease =
      '# Changelog\n\nFinished work, newest first.\n\n## v0.0.3\n\n- Fix backfill clip preservation\n\n' +
      '## v0.0.2\n\n- Ship v0.0.2\n\n## v0.0.1\n\n- Initial release\n';
    const nextUnbumpedErrs = [];
    docs.checkChangelogPostRelease('v0.0.2', taggedV002, nextRelease, '0.0.2', nextUnbumpedErrs);
    assert.ok(nextUnbumpedErrs.length > 0, 'Next release heading without package.json bump must fail');

    const nextBumpedErrs = [];
    docs.checkChangelogPostRelease('v0.0.2', taggedV002, nextRelease, '0.0.3', nextBumpedErrs);
    assert.deepEqual(nextBumpedErrs, []);
  });

  it('enforces 1:1 test/acceptance/AT-NN.test.js files and literal-only imports across ../../src/', () => {
    // Verify: each AT-NN criterion maps 1:1 to test/acceptance/AT-NN.test.js and forbids importing constants or cfg.
    if (!fs.existsSync(CHECK_DOCS_PATH)) return;
    const {checkAcceptanceTestSuite} = require(CHECK_DOCS_PATH);
    assert.equal(
      typeof checkAcceptanceTestSuite,
      'function',
      'scripts/check-docs.js must export checkAcceptanceTestSuite'
    );
    assert.equal(
      checkAcceptanceTestSuite.length,
      3,
      'checkAcceptanceTestSuite must accept (validAtIds, sources, errs)'
    );

    const srcRel = '../../' + 'src/';
    const validIds = new Set(['AT-01', 'AT-02']);
    const cleanSources = [
      {
        file: 'test/acceptance/AT-01.test.js',
        text: "const {Camera} = require('" + srcRel + "domain/camera');\nit('AT-01: wakes cleanly', () => {});\n",
      },
      {
        file: 'test/acceptance/AT-02.test.js',
        text:
          "const {BackfillJob} = require('" +
          srcRel +
          "domain/backfill-job');\nit('AT-02: matches clips', () => {});\n",
      },
    ];
    const okErrs = [];
    checkAcceptanceTestSuite(validIds, cleanSources, okErrs);
    assert.deepEqual(okErrs, []);

    const missingFileErrs = [];
    checkAcceptanceTestSuite(validIds, [cleanSources[0]], missingFileErrs);
    assert.ok(missingFileErrs.some((e) => e.includes('test/acceptance/AT-02.test.js')));

    const orphanAndWrongIdErrs = [];
    checkAcceptanceTestSuite(
      new Set(['AT-01']),
      [
        {file: 'test/acceptance/AT-01.test.js', text: "it('AT-02: wrong id in file', () => {});\n"},
        {file: 'test/acceptance/AT-99.test.js', text: "it('AT-99: orphan file', () => {});\n"},
      ],
      orphanAndWrongIdErrs
    );
    assert.ok(orphanAndWrongIdErrs.some((e) => e.includes('AT-01.test.js')));
    assert.ok(orphanAndWrongIdErrs.some((e) => e.includes('AT-99.test.js')));

    const constImportErrs = [];
    checkAcceptanceTestSuite(
      new Set(['AT-01']),
      [
        {
          file: 'test/acceptance/AT-01.test.js',
          text:
            "const camMod = require('" +
            srcRel +
            "domain/camera');\n" +
            "const {FRAME, cfg, Camera} = require('" +
            srcRel +
            "config');\n" +
            "it('AT-01: bad imports', () => { void Camera.DEFAULT_HOLD; });\n",
        },
      ],
      constImportErrs
    );
    assert.ok(constImportErrs.some((e) => e.includes('destructured')));
    assert.ok(constImportErrs.some((e) => e.includes('"FRAME"')));
    assert.ok(constImportErrs.some((e) => e.includes('"cfg"')));
    assert.ok(constImportErrs.some((e) => e.includes('Camera.DEFAULT_HOLD')));
  });

  it('keeps NOTES.md and .geminiignore gitignored while keeping .ignore tracked in the repository', (t) => {
    // Verify NOTES.md and .geminiignore stay gitignored/skipped while .ignore stays tracked with NOTES.md.
    const docs = loadCheckDocs();
    if (!docs) return;

    const gitignoreLines = fs
      .readFileSync(GITIGNORE_PATH, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    assert.equal(gitignoreLines.includes('NOTES.md'), true, '.gitignore must ignore NOTES.md');
    assert.equal(gitignoreLines.includes('THOUGHTS.md'), false, '.gitignore must not list old THOUGHTS.md');
    assert.equal(gitignoreLines.includes('.ignore'), false, '.gitignore must not ignore tracked .ignore');
    assert.equal(gitignoreLines.includes('.geminiignore'), true, '.gitignore must ignore .geminiignore');

    const ignoreLines = fs
      .readFileSync(path.join(REPO_ROOT, '.ignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    assert.equal(ignoreLines.includes('NOTES.md'), true, '.ignore must list NOTES.md');
    assert.equal(ignoreLines.includes('THOUGHTS.md'), false, '.ignore must not list old THOUGHTS.md');

    const dockerignoreLines = fs
      .readFileSync(DOCKERIGNORE_PATH, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    assert.equal(dockerignoreLines.includes('.ignore'), true, '.dockerignore must ignore .ignore');
    assert.equal(dockerignoreLines.includes('.geminiignore'), true, '.dockerignore must ignore .geminiignore');

    fs.mkdirSync(TEST_TMP_DIR, {recursive: true});
    const tmpRoot = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'check-docs-notes-'));
    t.after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'NOTES.md'), 'scratch notes ' + String.fromCharCode(0x2014) + '\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, '.ignore'), 'NOTES.md\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, '.geminiignore'), 'NOTES.md\n', 'utf8');
    fs.mkdirSync(path.join(tmpRoot, 'docs'), {recursive: true});
    fs.writeFileSync(path.join(tmpRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');

    const discovered = docs.listFiles(tmpRoot, tmpRoot).sort();
    assert.deepEqual(discovered, ['.ignore', 'AGENTS.md', 'docs/guide.md']);
  });
});
