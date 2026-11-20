/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Test hygiene: tests must be deterministic, so no test file may wait for a fixed wall-clock delay with
 * `await new Promise((r) => setTimeout(r, N))`. Use `flushAsync()` from test/helpers/async.js for promise chains and
 * `mock.timers` for production timers. Locked `test/acceptance/AT-NN.test.js` files are exempted only from the
 * fixed-wait scan while still obeying 1:1 file naming, <= 2100 lines, and `test-env` isolation.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const LOCKED_TEST_DIRS = new Set(['acceptance']);
const ALLOWED_ROOT_UNLOCKED_TESTS = new Set([
  'camera-coupling.test.js',
  'logger.test.js',
  'reporter.test.js',
  'test-hygiene.test.js',
]);
const EXTRA_REQUIRED_TEST_DIRS = ['regression', 'scripts'];
const MAX_UNLOCKED_TEST_LINES = 2100;
const FIXED_WAIT_REGEX = /new Promise\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\(\s*\w+\s*,\s*\d+\s*\)\s*\)/g;
const SRC_IMPORT_REGEX = /require\(\s*['"]\.\.(?:\/\.\.)*\/src(?:\/|['"])/;
const TEST_ENV_IMPORT_REGEX = /require\(\s*['"](?:\.\/|(?:\.\.\/)+)helpers\/test-env['"]\s*\)/;
const SHARED_REFRESH_RESET_REGEX = /lastLowBatRefreshAt\s*=/;
const PROCESS_HWACCEL_RENDER_REGEX = /process\.env\.BRIDGE_HWACCEL\s*=\s*['"](?:vaapi|qsv|true)['"]/i;
const PROCESS_HWACCEL_DEVICE_REGEX = /process\.env\.BRIDGE_HWACCEL_DEVICE\s*=/;
const MULTI_REGRESSION_TAG_REGEX = /\bit\(\s*(?:\r?\n\s*)?['"]Regression \d+(?:, \d+)+:/g;
const REGRESSION_IT_REGEX = /\bit\(\s*(?:\r?\n\s*)?['"]Regression (\d+):/g;
const ACCEPTANCE_IT_REGEX = /\bit\(\s*(?:\r?\n\s*)?['"](AT-\d{2}):/g;

/**
 * Lists unlocked `*.test.js` files below dir as paths relative to `test/`.
 *
 * @param {string} dir - Directory to scan.
 * @returns {string[]}
 */
function listUnlockedTestFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === TEST_DIR && LOCKED_TEST_DIRS.has(entry.name)) {
        return [];
      }
      return listUnlockedTestFiles(abs);
    }
    if (!entry.name.endsWith('.test.js')) {
      return [];
    }
    return [path.relative(TEST_DIR, abs).split(path.sep).join('/')];
  });
}

/**
 * Lists subdirectories below rootDir as forward-slash relative paths.
 *
 * @param {string} rootDir - Root directory.
 * @param {string} [currentDir] - Current scan directory.
 * @returns {string[]}
 */
function listSubdirs(rootDir, currentDir = rootDir) {
  return fs.readdirSync(currentDir, {withFileTypes: true}).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    const abs = path.join(currentDir, entry.name);
    const rel = path.relative(rootDir, abs).split(path.sep).join('/');
    return [rel, ...listSubdirs(rootDir, abs)];
  });
}

describe('test hygiene', () => {
  it('has no fixed setTimeout wait in any unlocked test file', () => {
    // Verify: fixed waits make tests slow and flaky; each hit below is a wall-clock sleep to replace.
    const offenders = [];
    for (const rel of listUnlockedTestFiles(TEST_DIR)) {
      const lines = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (FIXED_WAIT_REGEX.test(line)) {
          offenders.push('test/' + rel + ':' + (index + 1));
        }
        FIXED_WAIT_REGEX.lastIndex = 0;
      });
    }
    assert.deepEqual(offenders, []);
  });

  it('loads test/helpers/test-env before importing src/ in every unlocked test file', () => {
    // Verify: importing src/ before isolating BRIDGE_CONFIG and scrubbing host env vars could read a local
    // ./config.yaml or developer environment variables.
    const offenders = [];
    for (const rel of listUnlockedTestFiles(TEST_DIR)) {
      const text = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
      const srcMatch = SRC_IMPORT_REGEX.exec(text);
      if (!srcMatch) {
        continue;
      }
      const envMatch = TEST_ENV_IMPORT_REGEX.exec(text);
      if (!envMatch || envMatch.index > srcMatch.index) {
        offenders.push('test/' + rel);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('never resets lastLowBatRefreshAt to reuse a shared camera across telemetry refresh tests', () => {
    // Verify: each telemetry refresh test constructs its own camera instead of mutating cooldown timestamps.
    const offenders = [];
    for (const rel of listUnlockedTestFiles(TEST_DIR)) {
      const lines = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (SHARED_REFRESH_RESET_REGEX.test(line)) {
          offenders.push('test/' + rel + ':' + (index + 1));
        }
      });
    }
    assert.deepEqual(offenders, []);
  });

  it('scrubs ambient host service/runtime variables and writes an isolated BRIDGE_CONFIG fixture', () => {
    // Verify: initTestEnv isolates tests from host environment overrides and local ./config.yaml files.
    const {initTestEnv} = require('./helpers/test-env');
    const sampleEnv = {
      PATH: '/usr/bin',
      EUFY_WS_URL: 'ws://192.0.2.10:3000',
      FRIGATE_URL: 'http://192.0.2.10:5000',
      GO2RTC_URL: 'http://192.0.2.10:1984',
      HA_WEBHOOK_URL: 'http://192.0.2.10:8123/api/webhook/x',
      BRIDGE_HWACCEL: 'vaapi',
      BRIDGE_HTTP_PORT: '9090',
    };
    const paths = initTestEnv(sampleEnv);

    assert.equal(sampleEnv.EUFY_WS_URL, undefined);
    assert.equal(sampleEnv.FRIGATE_URL, undefined);
    assert.equal(sampleEnv.GO2RTC_URL, undefined);
    assert.equal(sampleEnv.HA_WEBHOOK_URL, undefined);
    assert.equal(sampleEnv.BRIDGE_HWACCEL, undefined);
    assert.equal(sampleEnv.BRIDGE_HTTP_PORT, undefined);
    assert.equal(sampleEnv.NODE_ENV, 'test');
    assert.equal(sampleEnv.BRIDGE_LOG_LEVEL, 'error');
    assert.equal(sampleEnv.BRIDGE_CONFIG, paths.configPath);
    assert.equal(sampleEnv.BRIDGE_CACHE_DIR, paths.cacheDir);
    assert.equal(fs.existsSync(paths.configPath), true);
  });

  it('requires explicit BRIDGE_HWACCEL_DEVICE whenever a test enables vaapi or qsv on process.env', () => {
    // Verify: container builds and headless CI runners have no /dev/dri/renderD128 node, so any test enabling vaapi or
    // qsv on process.env must point BRIDGE_HWACCEL_DEVICE at a deterministic fixture path instead of host hardware.
    const offenders = [];
    for (const rel of listUnlockedTestFiles(TEST_DIR).sort()) {
      const text = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
      if (PROCESS_HWACCEL_RENDER_REGEX.test(text) && !PROCESS_HWACCEL_DEVICE_REGEX.test(text)) {
        offenders.push('test/' + rel);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('keeps every unlocked test file at or below 2100 lines', () => {
    // Verify: oversized multi-thousand-line test suites are split by module so failures stay local and fast to read.
    const offenders = [];
    for (const rel of listUnlockedTestFiles(TEST_DIR).sort()) {
      const lineCount = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8').split('\n').length;
      if (lineCount > MAX_UNLOCKED_TEST_LINES) {
        offenders.push('test/' + rel + ' (' + lineCount + ' lines)');
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('gives each Regression test title a single entry number', () => {
    // Verify: each tagged regression test locks one post-mortem instead of bundling unrelated bugs into one monolith.
    const offenders = [];
    for (const rel of listUnlockedTestFiles(TEST_DIR).sort()) {
      const text = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
      for (const match of text.matchAll(MULTI_REGRESSION_TAG_REGEX)) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push('test/' + rel + ':' + line);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('mirrors src/ package directories under test/ without stray root unit files', () => {
    // Verify: unit tests follow the same package hierarchy as src/ so every module has an obvious test home.
    const unlockedFiles = listUnlockedTestFiles(TEST_DIR);
    const requiredDirs = [...listSubdirs(SRC_DIR), ...EXTRA_REQUIRED_TEST_DIRS].sort();
    const missingOrEmptyDirs = requiredDirs.filter(
      (dir) => !unlockedFiles.some((rel) => path.posix.dirname(rel) === dir)
    );
    const strayRootTests = unlockedFiles
      .filter((rel) => !rel.includes('/') && !ALLOWED_ROOT_UNLOCKED_TESTS.has(rel))
      .sort();

    assert.deepEqual(missingOrEmptyDirs, []);
    assert.deepEqual(strayRootTests, []);
  });

  it('keeps each Regression NN test inside its matching test/regression/NN-slug.test.js file', () => {
    // Verify: each post-mortem regression case lives in its own test/regression/NN-slug.test.js file matching NN.
    const outsideRegressionDir = [];
    const mismatchedFiles = [];
    const regressionFiles = [];

    for (const rel of listUnlockedTestFiles(TEST_DIR).sort()) {
      const text = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
      const nums = [...text.matchAll(REGRESSION_IT_REGEX)].map((m) => ({
        num: Number(m[1]),
        line: text.slice(0, m.index).split('\n').length,
      }));

      if (!rel.startsWith('regression/')) {
        for (const {num, line} of nums) {
          outsideRegressionDir.push('test/' + rel + ':' + line + ' (Regression ' + num + ')');
        }
        continue;
      }

      regressionFiles.push(rel);
      const fileMatch = rel.match(/^regression\/(\d{2,})-[a-z0-9-]+\.test\.js$/);
      if (!fileMatch) {
        mismatchedFiles.push('test/' + rel + ' (expected test/regression/NN-slug.test.js)');
        continue;
      }
      const expectedNum = Number(fileMatch[1]);
      if (nums.length === 0) {
        mismatchedFiles.push('test/' + rel + ' (missing Regression ' + expectedNum + ': test)');
        continue;
      }
      for (const {num, line} of nums) {
        if (num !== expectedNum) {
          mismatchedFiles.push(
            'test/' + rel + ':' + line + ' (found Regression ' + num + ', expected Regression ' + expectedNum + ')'
          );
        }
      }
    }

    assert.deepEqual(outsideRegressionDir, []);
    assert.equal(regressionFiles.length > 0, true, 'test/regression/ must contain NN-slug.test.js files');
    assert.deepEqual(mismatchedFiles, []);
  });

  it('keeps locked AT-NN acceptance tests in isolated 1:1 test/acceptance/AT-NN.test.js files', () => {
    // Verify: each AT-NN criterion lives in its own test/acceptance/AT-NN.test.js file (<= 2100 lines, test-env first).
    const acceptanceDir = path.join(TEST_DIR, 'acceptance');
    assert.equal(fs.existsSync(acceptanceDir), true, 'test/acceptance/ directory must exist');

    const files = fs
      .readdirSync(acceptanceDir)
      .filter((f) => f.endsWith('.test.js'))
      .sort();
    assert.equal(files.length > 0, true, 'test/acceptance/ must contain AT-NN.test.js files');

    const offenders = [];
    for (const file of files) {
      const m = file.match(/^(AT-\d{2})\.test\.js$/);
      if (!m) {
        offenders.push('test/acceptance/' + file + ' (expected AT-NN.test.js)');
        continue;
      }
      const expectedId = m[1];
      const text = fs.readFileSync(path.join(acceptanceDir, file), 'utf8');
      const lineCount = text.split('\n').length;
      if (lineCount > MAX_UNLOCKED_TEST_LINES) {
        offenders.push('test/acceptance/' + file + ' (' + lineCount + ' lines)');
      }
      const srcMatch = SRC_IMPORT_REGEX.exec(text);
      const envMatch = TEST_ENV_IMPORT_REGEX.exec(text);
      if (srcMatch && (!envMatch || envMatch.index > srcMatch.index)) {
        offenders.push('test/acceptance/' + file + ' (missing test-env import before src/)');
      }
      const ids = [...text.matchAll(ACCEPTANCE_IT_REGEX)].map((hit) => hit[1]);
      if (ids.length !== 1 || ids[0] !== expectedId) {
        offenders.push(
          'test/acceptance/' + file + ' (expected single ' + expectedId + ' test, found ' + ids.join(',') + ')'
        );
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('keeps newly extracted modules free of eslint-suppressions.json entries and legacy rest-arg bypasses', () => {
    // Verify: newly split modules obey max-params <= 3 and complexity <= 25 without suppressions or ...legacyArgs.
    const suppressionsPath = path.join(TEST_DIR, '..', 'scripts', 'eslint-suppressions.json');
    if (fs.existsSync(suppressionsPath)) {
      const suppressions = JSON.parse(fs.readFileSync(suppressionsPath, 'utf8'));
      const forbiddenSuppressedFiles = [
        'src/domain/camera/wake-scheduler.js',
        'src/domain/telemetry-visuals.js',
        'src/services/frigate-masks.js',
        'src/services/go2rtc-viewers.js',
      ];
      const present = forbiddenSuppressedFiles.filter((rel) => Object.hasOwn(suppressions, rel));
      assert.deepEqual(present, []);
    }

    const wakeText = fs.readFileSync(path.join(SRC_DIR, 'services', 'orchestrator', 'wake.js'), 'utf8');
    assert.equal(wakeText.includes('legacyArgs'), false, 'wake.js must not use ...legacyArgs rest-parameter bypasses');
  });

  it('forbids explicit JSDoc any types and dynamic Object.assign(this) across src/ and scripts/', () => {
    // Verify: production and tooling scripts avoid explicit JSDoc any annotations and dynamic constructor shapes.
    const scriptsDir = path.join(TEST_DIR, '..', 'scripts');
    const listJs = (dir) =>
      fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
        const abs = path.join(dir, e.name);
        return e.isDirectory() ? listJs(abs) : abs.endsWith('.js') ? [abs] : [];
      });
    const explicitAnyRe = /@(?:type|typedef|property|param|returns?)\s*\{[^}]*\bany\b/;
    const dynamicThisRe = /\bObject\.assign\(\s*this\s*,/;
    const offenders = [];
    const targetFiles = [...listJs(SRC_DIR), ...(fs.existsSync(scriptsDir) ? listJs(scriptsDir) : [])];

    for (const abs of targetFiles) {
      const rel = path.relative(path.join(TEST_DIR, '..'), abs).split(path.sep).join('/');
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (explicitAnyRe.test(line)) {
          offenders.push(rel + ':' + (idx + 1) + ' (explicit JSDoc any)');
        }
        if (dynamicThisRe.test(line)) {
          offenders.push(rel + ':' + (idx + 1) + ' (Object.assign(this, ...))');
        }
      });
    }
    assert.deepEqual(offenders, []);
  });

  it('forbids JS template literals and undocumented silent catch blocks', (t) => {
    // Verify: string concatenation is used instead of template literals and every silent catch documents why.
    const scriptsDir = path.join(TEST_DIR, '..', 'scripts');
    const listJs = (dir) =>
      fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
        const abs = path.join(dir, e.name);
        return e.isDirectory() ? listJs(abs) : abs.endsWith('.js') ? [abs] : [];
      });

    const catchOffenders = [];
    const bareCatchCallbackRe = /\.catch\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|''|""|false|null|undefined)\s*\)/g;
    const silentTryCatchRe = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g;
    for (const abs of listJs(SRC_DIR)) {
      const rel = path.relative(path.join(TEST_DIR, '..'), abs).split(path.sep).join('/');
      const txt = fs.readFileSync(abs, 'utf8');
      for (const m of txt.matchAll(bareCatchCallbackRe)) {
        const line = txt.slice(0, m.index).split('\n').length;
        catchOffenders.push(rel + ':' + line + ' (undocumented .catch(() => ...))');
      }
      for (const m of txt.matchAll(silentTryCatchRe)) {
        const body = m[1];
        const isSilentFallback = /^\s*(?:return\s+(?:''|""|false|true|null|undefined)\s*;?\s*)?$/.test(body);
        if (isSilentFallback && !body.includes('//')) {
          const line = txt.slice(0, m.index).split('\n').length;
          catchOffenders.push(rel + ':' + line + ' (undocumented silent catch)');
        }
      }
    }
    assert.deepEqual(catchOffenders, []);

    let ts = null;
    try {
      ts = require('typescript');
    } catch (err) {
      ts = null;
    }
    if (!ts) {
      t.skip('typescript is not installed');
      return;
    }
    const unlockedAbs = listUnlockedTestFiles(TEST_DIR).map((rel) => path.join(TEST_DIR, rel));
    const astTargets = [...listJs(SRC_DIR), ...(fs.existsSync(scriptsDir) ? listJs(scriptsDir) : []), ...unlockedAbs];
    const templateOffenders = [];
    for (const abs of astTargets) {
      const rel = path.relative(path.join(TEST_DIR, '..'), abs).split(path.sep).join('/');
      const src = fs.readFileSync(abs, 'utf8');
      const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        if (
          node.kind === ts.SyntaxKind.TemplateExpression ||
          node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
          const {line} = sf.getLineAndCharacterOfPosition(node.getStart());
          templateOffenders.push(rel + ':' + (line + 1));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    assert.deepEqual(templateOffenders, []);
  });

  it('starts every unlocked it() body with a // Verify or // Regression comment', (t) => {
    // Verify: every unlocked unit and regression test documents what behavior it verifies on its first body line.
    let ts = null;
    try {
      ts = require('typescript');
    } catch (err) {
      ts = null;
    }
    if (!ts) {
      t.skip('typescript is not installed');
      return;
    }
    const offenders = [];
    for (const rel of listUnlockedTestFiles(TEST_DIR).sort()) {
      const abs = path.join(TEST_DIR, rel);
      const src = fs.readFileSync(abs, 'utf8');
      const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'it') {
          const fnArg = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
          if (fnArg && ts.isBlock(fnArg.body)) {
            const bodyText = src.slice(fnArg.body.getStart(sf) + 1, fnArg.body.getEnd() - 1);
            const firstNonEmpty =
              bodyText
                .split('\n')
                .map((l) => l.trim())
                .find(Boolean) || '';
            if (!/^\/\/\s*(?:Verify|Regression)\b/.test(firstNonEmpty)) {
              const {line} = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              offenders.push('test/' + rel + ':' + (line + 1));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    assert.deepEqual(offenders, []);
  });

  it('keeps Makefile free of mkdir -p / cp and release.yml least-privilege with concurrency', () => {
    // Verify: Makefile uses install -d / install -m and release.yml scopes packages: write to push jobs only.
    const repoRoot = path.join(TEST_DIR, '..');
    const makefilePath = path.join(repoRoot, 'Makefile');
    if (fs.existsSync(makefilePath)) {
      const makefileText = fs.readFileSync(makefilePath, 'utf8');
      assert.equal(/\bmkdir\s+-p\b/.test(makefileText), false, 'Makefile must use install -d instead of mkdir -p');
      assert.equal(/^\t@?cp\s+/m.test(makefileText), false, 'Makefile must use install -m instead of cp');
    }

    const releaseYmlPath = path.join(repoRoot, '.github', 'workflows', 'release.yml');
    if (fs.existsSync(releaseYmlPath)) {
      const releaseYml = fs.readFileSync(releaseYmlPath, 'utf8');
      const beforeJobs = releaseYml.split('\njobs:')[0];
      assert.equal(beforeJobs.includes('contents: read'), true, 'release.yml must set top-level contents: read');
      assert.equal(beforeJobs.includes('packages: write'), false, 'release.yml must not set top-level packages: write');
      assert.equal(beforeJobs.includes('concurrency:'), true, 'release.yml must declare a concurrency group');
    }
  });

  it('runs tooling and hygiene tests cleanly in the Dockerfile builder layout', (t) => {
    // Verify: deploy/Dockerfile stage 1 copies only package.json, src/, test/, deploy/ with production deps only.
    const repoRoot = path.join(TEST_DIR, '..');
    if (!fs.existsSync(path.join(repoRoot, 'scripts'))) {
      return;
    }
    const {execFileSync} = require('node:child_process');
    const tmpBase = path.join(repoRoot, '.tmp');
    fs.mkdirSync(tmpBase, {recursive: true});
    const simDir = fs.mkdtempSync(path.join(tmpBase, 'docker-builder-sim-'));
    t.after(() => fs.rmSync(simDir, {recursive: true, force: true}));

    fs.symlinkSync(path.join(repoRoot, 'package.json'), path.join(simDir, 'package.json'));
    fs.symlinkSync(path.join(repoRoot, 'src'), path.join(simDir, 'src'));
    fs.symlinkSync(path.join(repoRoot, 'deploy'), path.join(simDir, 'deploy'));
    fs.cpSync(path.join(repoRoot, 'test'), path.join(simDir, 'test'), {recursive: true});
    const simMods = path.join(simDir, 'node_modules');
    fs.mkdirSync(simMods, {recursive: true});
    for (const prodDep of ['js-yaml', 'ws', 'argparse']) {
      const depSrc = path.join(repoRoot, '.venv', 'node_modules', prodDep);
      if (fs.existsSync(depSrc)) {
        fs.symlinkSync(depSrc, path.join(simMods, prodDep));
      }
    }
    const simTmp = path.join(simDir, '.tmp');
    fs.mkdirSync(path.join(simTmp, 'cache'), {recursive: true});
    const noTsPreload = path.join(simTmp, 'omit-dev.js');
    fs.writeFileSync(
      noTsPreload,
      [
        "'use strict';",
        "const fs = require('node:fs');",
        'const origExists = fs.existsSync;',
        'fs.existsSync = function (p) {',
        "  return String(p).startsWith('/dev/dri') ? false : origExists.call(this, p);",
        '};',
        "const Module = require('node:module');",
        'const origLoad = Module._load;',
        'Module._load = function (req, parent, isMain) {',
        "  if (req === 'typescript') {",
        "    const err = new Error('Cannot find module typescript');",
        "    err.code = 'MODULE_NOT_FOUND';",
        '    throw err;',
        '  }',
        '  return origLoad.call(this, req, parent, isMain);',
        '};',
      ].join('\n'),
      'utf8'
    );

    const out = execFileSync(
      process.execPath,
      [
        '--require',
        noTsPreload,
        '--test',
        '--test-reporter=' + path.join(simDir, 'test', 'reporter.js'),
        path.join(simDir, 'test', 'camera-coupling.test.js'),
        path.join(simDir, 'test', 'test-hygiene.test.js'),
        path.join(simDir, 'test', 'regression', '55-encoder-hwaccel-regex-url-replacer-and-sigkill.test.js'),
        path.join(simDir, 'test', 'scripts', 'check-docs.test.js'),
        path.join(simDir, 'test', 'scripts', 'check-docs-regression.test.js'),
        path.join(simDir, 'test', 'scripts', 'check-commit-msg.test.js'),
      ],
      {
        cwd: simDir,
        env: {
          PATH: process.env.PATH,
          HOME: simTmp,
          TMPDIR: simTmp,
          BRIDGE_CACHE_DIR: path.join(simTmp, 'cache'),
          NODE_ENV: 'production',
        },
        encoding: 'utf8',
      }
    );
    assert.match(out, /Tests passed:/);
  });
});
