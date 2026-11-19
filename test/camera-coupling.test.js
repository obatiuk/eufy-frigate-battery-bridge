/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Coupling guard for the Camera entity. Uses the TypeScript type checker (the same one `make deadcode` runs) to find
 * every property access whose receiver is a `Camera` and whose property is an instance field, then enforces:
 *   1. Production code outside `src/domain/camera.js` never reads or writes Camera fields (tell, don't ask).
 *   2. Test suites never read or write Camera fields directly or via any internal routing wrapper; all arrangement and
 *      inspection goes through Camera methods and accessors.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAMERA_FILE = path.join(ROOT, 'src', 'domain', 'camera.js');
const RETIRED_INTERNALS_HELPER = path.join(__dirname, 'helpers', 'camera-internals.js');
const RETIRED_INTERNALS_TEST = path.join(__dirname, 'camera-internals.test.js');
const MAX_LISTED_VIOLATIONS = 25;

/** @type {ReadonlyArray<{ className: string, ownerRel: string }>} */
const ENCAPSULATED_DOMAIN_MODELS = Object.freeze([
  {className: 'Station', ownerRel: 'src/domain/station.js'},
  {className: 'BackfillJob', ownerRel: 'src/domain/backfill-job.js'},
  {className: 'SessionLifecycle', ownerRel: 'src/domain/camera/session-lifecycle.js'},
  {className: 'AudioQueue', ownerRel: 'src/domain/camera/audio-queue.js'},
  {className: 'HardwareTriggerLedger', ownerRel: 'src/domain/camera/hardware-trigger-ledger.js'},
  {className: 'ViewerSet', ownerRel: 'src/domain/camera/viewer-set.js'},
  {className: 'WakeScheduler', ownerRel: 'src/domain/camera/wake-scheduler.js'},
  {className: 'WakeRequest', ownerRel: 'src/domain/camera/wake-scheduler.js'},
  {className: 'OfflineState', ownerRel: 'src/domain/camera/offline-state.js'},
  {className: 'BridgeConfigBuilder', ownerRel: 'src/config/builder.js'},
  {className: 'FfmpegArgsBuilder', ownerRel: 'src/media/ffmpeg-args.js'},
]);

/**
 * Loads the TypeScript compiler API, or returns null when dev dependencies are not installed (for example inside the
 * production image builder stage).
 *
 * @returns {*}
 */
function loadTypeScript() {
  try {
    return require('typescript');
  } catch (err) {
    return null;
  }
}

/**
 * Lists every `.js` file below dir.
 *
 * @param {string} dir - Absolute directory.
 * @returns {string[]}
 */
function listJsFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listJsFiles(abs);
    }
    return abs.endsWith('.js') ? [abs] : [];
  });
}

/**
 * Finds every direct Camera instance-field access in the given files.
 *
 * @param {*} ts - TypeScript compiler API.
 * @param {string[]} files - Absolute paths whose accesses are reported.
 * @returns {string[]} 'relative/path.js:line receiver.field' entries for direct field accesses.
 */
function findCameraFieldAccesses(ts, files) {
  const program = ts.createProgram([...listJsFiles(path.join(ROOT, 'src')), ...files], {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    baseUrl: ROOT,
    paths: {'*': ['./.venv/node_modules/*', './.venv/node_modules/@types/*']},
    typeRoots: [path.join(ROOT, '.venv/node_modules/@types')],
    types: ['node'],
    skipLibCheck: true,
    strict: false,
  });
  const checker = program.getTypeChecker();
  const isCamera = (type) => {
    if (!type) return false;
    if (type.isUnion && type.isUnion()) return type.types.some(isCamera);
    const symbol = type.getSymbol && type.getSymbol();
    return Boolean(symbol && symbol.getName() === 'Camera');
  };

  /** @type {Set<string>} */
  let fieldNames = new Set();
  const cameraSource = program.getSourceFile(CAMERA_FILE);
  ts.forEachChild(cameraSource, function findClass(node) {
    if (ts.isClassDeclaration(node) && node.name && node.name.text === 'Camera') {
      const declared = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(node.name));
      fieldNames = new Set(
        checker
          .getPropertiesOfType(declared)
          .filter((s) => (s.flags & ts.SymbolFlags.Property) !== 0 && (s.flags & ts.SymbolFlags.Method) === 0)
          .map((s) => s.getName())
      );
    }
    ts.forEachChild(node, findClass);
  });
  assert.ok(fieldNames.size > 20, 'Camera instance fields must be discoverable through the type checker');

  const violations = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    ts.forEachChild(source, function visit(node) {
      if (ts.isPropertyAccessExpression(node) && fieldNames.has(node.name.text)) {
        const receiver = node.expression;
        if (isCamera(checker.getTypeAtLocation(receiver))) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(path.relative(ROOT, file) + ':' + line + ' ' + node.getText(source).slice(0, 60));
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return violations;
}

describe('Camera Coupling Guard', () => {
  const ts = loadTypeScript();
  const productionFiles = listJsFiles(path.join(ROOT, 'src')).filter((file) => file !== CAMERA_FILE);
  const testFiles = listJsFiles(__dirname).filter((file) => file !== __filename);

  it('keeps production code outside camera.js from reading or writing Camera fields', (t) => {
    // Verify: services, media, and overlay modules ask the Camera through methods (tell, don't ask) instead of
    // touching its instance fields, so fields can move into collaborators without editing callers.
    if (!ts) {
      t.skip('typescript is not installed');
      return;
    }
    const violations = findCameraFieldAccesses(ts, productionFiles);
    assert.deepEqual(
      violations.slice(0, MAX_LISTED_VIOLATIONS),
      [],
      violations.length + ' direct Camera field access(es) found outside camera.js'
    );
  });

  it('keeps tests from reading or writing Camera fields or retaining camera-internals.js', (t) => {
    // Verify: tests go exclusively through Camera methods/accessors and the legacy camera-internals helper is deleted.
    assert.equal(fs.existsSync(RETIRED_INTERNALS_HELPER), false, 'test/helpers/camera-internals.js must be deleted');
    assert.equal(fs.existsSync(RETIRED_INTERNALS_TEST), false, 'test/camera-internals.test.js must be deleted');
    for (const file of testFiles) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(
        content.includes('camInternals'),
        false,
        path.relative(ROOT, file) + ' must not reference camInternals'
      );
    }
    if (!ts) {
      t.skip('typescript is not installed');
      return;
    }
    const violations = findCameraFieldAccesses(ts, testFiles);
    assert.deepEqual(
      violations.slice(0, MAX_LISTED_VIOLATIONS),
      [],
      violations.length + ' direct Camera field access(es) found in tests'
    );
  });

  it('keeps production code from accessing encapsulated domain model fields outside their owning files', (t) => {
    // Verify: Station, BackfillJob, SessionLifecycle, ViewerSet, HardwareTriggerLedger, AudioQueue, WakeScheduler,
    // OfflineState, BridgeConfigBuilder, and FfmpegArgsBuilder hide internal fields behind methods across src/.
    if (!ts) {
      t.skip('typescript is not installed');
      return;
    }
    const allSrcFiles = listJsFiles(path.join(ROOT, 'src'));
    const program = ts.createProgram(allSrcFiles, {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      baseUrl: ROOT,
      paths: {'*': ['./.venv/node_modules/*', './.venv/node_modules/@types/*']},
      typeRoots: [path.join(ROOT, '.venv/node_modules/@types')],
      types: ['node'],
      skipLibCheck: true,
      strict: false,
    });
    const checker = program.getTypeChecker();
    const violations = [];

    for (const {className, ownerRel} of ENCAPSULATED_DOMAIN_MODELS) {
      const ownerAbs = path.join(ROOT, ownerRel);
      const ownerSource = program.getSourceFile(ownerAbs);
      /** @type {Set<string>} */
      let fieldNames = new Set();
      ts.forEachChild(ownerSource, function findClass(node) {
        if (ts.isClassDeclaration(node) && node.name && node.name.text === className) {
          const declared = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(node.name));
          fieldNames = new Set(
            checker
              .getPropertiesOfType(declared)
              .filter((s) => (s.flags & ts.SymbolFlags.Property) !== 0 && (s.flags & ts.SymbolFlags.Method) === 0)
              .map((s) => s.getName())
          );
        }
        ts.forEachChild(node, findClass);
      });
      const matchesClass = (type) => {
        if (!type) return false;
        if (type.isUnion && type.isUnion()) return type.types.some(matchesClass);
        const symbol = type.getSymbol && type.getSymbol();
        return Boolean(symbol && symbol.getName() === className);
      };
      for (const file of allSrcFiles) {
        if (file === ownerAbs) continue;
        const source = program.getSourceFile(file);
        ts.forEachChild(source, function visit(node) {
          if (ts.isPropertyAccessExpression(node) && fieldNames.has(node.name.text)) {
            if (matchesClass(checker.getTypeAtLocation(node.expression))) {
              const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
              violations.push(path.relative(ROOT, file) + ':' + line + ' (' + className + '.' + node.name.text + ')');
            }
          }
          ts.forEachChild(node, visit);
        });
      }
    }
    assert.deepEqual(
      violations.slice(0, MAX_LISTED_VIOLATIONS),
      [],
      violations.length + ' cross-model field access(es) found in src/'
    );
  });

  it('leaves zero uncalled class methods across src/', (t) => {
    // Verify: every class method in src/ has at least one caller across src/, test/, or scripts/ (knip does not flag
    // unused JavaScript class methods).
    if (!ts) {
      t.skip('typescript is not installed');
      return;
    }
    const allSrcFiles = listJsFiles(path.join(ROOT, 'src'));
    const scriptsDir = path.join(ROOT, 'scripts');
    const allRepoJs = [
      ...allSrcFiles,
      ...listJsFiles(__dirname),
      ...(fs.existsSync(scriptsDir) ? listJsFiles(scriptsDir) : []),
    ];
    const allTexts = allRepoJs.map((f) => fs.readFileSync(f, 'utf8'));
    const deadMethods = [];

    for (const srcFile of allSrcFiles) {
      const sf = ts.createSourceFile(srcFile, fs.readFileSync(srcFile, 'utf8'), ts.ScriptTarget.ES2022, true);
      ts.forEachChild(sf, function find(node) {
        if (ts.isClassDeclaration(node) && node.name) {
          for (const member of node.members) {
            if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
              const methodName = member.name.text;
              const callPattern = new RegExp('\\.' + methodName + '\\b');
              if (!allTexts.some((txt) => callPattern.test(txt))) {
                const line = sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1;
                deadMethods.push(path.relative(ROOT, srcFile) + ':' + line + ' ' + node.name.text + '.' + methodName);
              }
            }
          }
        }
        ts.forEachChild(node, find);
      });
    }
    assert.deepEqual(deadMethods, [], 'Unused class methods found: ' + deadMethods.join(', '));
  });
});
