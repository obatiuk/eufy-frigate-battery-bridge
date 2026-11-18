// @ts-check
/**
 * Documentation checks run by `make docs-check`: size budgets, relative links, ASCII hyphens, 120 columns, and
 * mechanical parity between ACCEPTANCE.md / docs/acceptance/AT-NN.md and docs/REGRESSION.md / docs/regression/NN-*.md.
 * Table alignment is checked separately by prettier.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const KB = 1024;
const AGENTS_FILE = 'AGENTS.md';
const ACCEPTANCE_FILE = 'docs/ACCEPTANCE.md';
const ACCEPTANCE_TEST_FILE = 'test/acceptance.test.js';
const REGRESSION_INDEX_FILE = 'docs/REGRESSION.md';
const AGENTS_TARGET_BYTES = 8 * KB;
const AGENTS_LIMIT_BYTES = 16 * KB;
const DOC_LIMIT_BYTES = 20 * KB;
const SKILL_LIMIT_BYTES = 4 * KB;
const MAX_LINE = 120;
const MAX_REGRESSION_TITLE = 100;
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const DASH_REGEX = new RegExp('[' + EN_DASH + EM_DASH + ']');
const LINK_REGEX = /\]\(([^)\s]+)\)/g;
const URL_REGEX = /https?:\/\//;
const AT_TOKEN_REGEX = /\bAT-\d{2}\b/g;
const SRC_REQUIRE_REGEX =
  /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z0-9_$]+)\s*=\s*require\(['"]\.\.\/src\/([^'"]+)['"]\)/g;
const UPPER_CONSTANT_REGEX = /^[A-Z][A-Z0-9_]*$/;
const AT_TEST_TITLE_REGEX = /\bit\(\s*['"](AT-\d{2}):/g;
const FORBIDDEN_ACCEPTANCE_IMPORTS = new Set(['cfg']);
const AT_REF_FILES = [/^docs\//, /^\.agents\//];
const PII_FILES = [/\.md$/, /^deploy\//];
const PII_RULES = [
  {label: 'home path', re: /\/(?:home|Users)\/[A-Za-z0-9_.-]+/},
  {
    label: 'private LAN IP (use 192.0.2.10 or 127.0.0.1)',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  {label: 'local/internal hostname', re: /\b[a-z0-9-]+\.(?:local|lan|internal|ts\.net|home\.arpa)\b/i},
  {label: 'full T8 serial (use SN0000000001 placeholder)', re: /\bT8[0-9A-Z]{6,}\b/},
];
const SKIP_DIRS = new Set(['.git', '.tmp', '.venv', 'node_modules', 'cache']);
const WIDTH_FILES = [/^AGENTS\.md$/, /^README\.md$/, /^CHANGELOG\.md$/, /^docs\/.*\.md$/, /^\.agents\//];
const DASH_FILES = [/\.md$/, /^(src|test|scripts)\/.*\.js$/, /^Makefile$/];
const COMPOSE_FILE_REGEX = /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/;
const COMPOSE_HEALTHCHECK_REGEX = /^\s*healthcheck\s*:/;

/**
 * Lists repository files below dir (relative paths with forward slashes), skipping tool folders.
 *
 * @param {string} dir - Absolute directory path.
 * @returns {string[]}
 */
function listFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : listFiles(abs);
    }
    return [path.relative(ROOT, abs).split(path.sep).join('/')];
  });
}

/**
 * Returns lines of a Markdown file that must obey the width rule (not headings, tables, code blocks, or URL lines).
 *
 * @param {string} text - File content.
 * @returns {Array<{no: number, text: string}>}
 */
function widthLines(text) {
  let fenced = false;
  const out = [];
  text.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      return;
    }
    const exempt = fenced || /^(#|\s*\|)/.test(line) || URL_REGEX.test(line);
    if (!exempt) {
      out.push({no: index + 1, text: line});
    }
  });
  return out;
}

/**
 * Validates 1:1 parity between ACCEPTANCE.md section 2 and docs/acceptance/AT-NN.md.
 *
 * @param {string[]} allFiles - All relative repo file paths.
 * @param {string[]} errs - Error accumulator.
 * @returns {Set<string>} Set of valid AT-NN identifiers.
 */
function checkAcceptanceIndex(allFiles, errs) {
  const atFiles = allFiles.filter((f) => /^docs\/acceptance\/AT-\d{2}\.md$/.test(f)).sort();
  const validIds = new Set(atFiles.map((f) => path.basename(f, '.md')));
  const accText = fs.readFileSync(path.join(ROOT, ACCEPTANCE_FILE), 'utf8');
  const seenIds = [];

  for (const line of accText.split('\n')) {
    const match = line.match(/^\|\s*\[(AT-\d{2})\]\((acceptance\/AT-\d{2}\.md)\)\s*\|\s*(.+?)\s*\|$/);
    if (!match) {
      continue;
    }
    const [, id, rel, title] = match;
    const repoRel = 'docs/' + rel;
    seenIds.push(id);
    if (rel !== 'acceptance/' + id + '.md' || !validIds.has(id)) {
      errs.push(ACCEPTANCE_FILE + ': broken or mismatched acceptance index row for ' + id);
      continue;
    }
    const h1 = fs.readFileSync(path.join(ROOT, repoRel), 'utf8').split('\n')[0];
    const expectedH1 = '# `' + id + '`: ' + title;
    if (h1 !== expectedH1) {
      errs.push(repoRel + ':1: heading does not match ' + ACCEPTANCE_FILE + ' index title for ' + id);
    }
  }

  atFiles.forEach((file, idx) => {
    const expectedId = 'AT-' + String(idx + 1).padStart(2, '0');
    const actualId = path.basename(file, '.md');
    if (actualId !== expectedId) {
      errs.push(file + ': expected contiguous acceptance ID ' + expectedId);
    }
    if (!seenIds.includes(actualId)) {
      errs.push(ACCEPTANCE_FILE + ': missing index row for ' + file);
    }
  });
  if (seenIds.length !== new Set(seenIds).size) {
    errs.push(ACCEPTANCE_FILE + ': duplicate AT-NN row in section 2 index');
  }
  return validIds;
}

/**
 * Validates 1:1 AT-NN test coverage in test/acceptance.test.js and forbids importing or referencing constants, enums,
 * or singleton config thresholds from src/ (acceptance assertions must lock literal specification values).
 *
 * @param {Set<string>} validAtIds - Known AT-NN identifiers.
 * @param {string[]} errs - Error accumulator.
 */
function checkAcceptanceTestSuite(validAtIds, errs) {
  const testText = fs.readFileSync(path.join(ROOT, ACCEPTANCE_TEST_FILE), 'utf8');
  const importedLocalBindings = new Set();

  for (const match of testText.matchAll(SRC_REQUIRE_REGEX)) {
    const [, binding, modPath] = match;
    if (!binding.startsWith('{')) {
      errs.push(
        ACCEPTANCE_TEST_FILE +
          ': use destructured function/class imports from ../src/' +
          modPath +
          ' (namespace imports could read production constants)'
      );
      continue;
    }
    const entries = binding
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const [exportedRaw, localRaw] = entry.split(':').map((s) => s.trim());
      const sym = exportedRaw;
      const localName = localRaw || exportedRaw;
      importedLocalBindings.add(localName);
      if (UPPER_CONSTANT_REGEX.test(sym) || FORBIDDEN_ACCEPTANCE_IMPORTS.has(sym)) {
        errs.push(
          ACCEPTANCE_TEST_FILE +
            ': forbidden constant/config import "' +
            sym +
            '" from ../src/' +
            modPath +
            ' (use literal values in acceptance tests)'
        );
      }
    }
  }

  for (const localName of importedLocalBindings) {
    const staticConstRe = new RegExp('\\b' + localName + '\\.([A-Z][A-Z0-9_]*)\\b', 'g');
    for (const refMatch of testText.matchAll(staticConstRe)) {
      errs.push(
        ACCEPTANCE_TEST_FILE +
          ': forbidden production constant reference "' +
          localName +
          '.' +
          refMatch[1] +
          '" (use literal values in acceptance tests)'
      );
    }
  }

  const seenTestIds = [...testText.matchAll(AT_TEST_TITLE_REGEX)].map((m) => m[1]);
  for (const id of validAtIds) {
    if (!seenTestIds.includes(id)) {
      errs.push(ACCEPTANCE_TEST_FILE + ': missing locked acceptance test for ' + id);
    }
  }
  if (seenTestIds.length !== new Set(seenTestIds).size) {
    errs.push(ACCEPTANCE_TEST_FILE + ': duplicate AT-NN test title');
  }
}

/**
 * Validates 1:1 parity between docs/REGRESSION.md and docs/regression/NN-*.md, concise titles, src/ files,
 * and AT-NN references.
 *
 * @param {string[]} allFiles - All relative repo file paths.
 * @param {Set<string>} validAtIds - Known AT-NN identifiers.
 * @param {string[]} errs - Error accumulator.
 */
function checkRegressionIndex(allFiles, validAtIds, errs) {
  const srcBasenames = new Set(
    allFiles.filter((f) => f.startsWith('src/') && f.endsWith('.js')).map((f) => path.basename(f))
  );
  const regFiles = allFiles.filter((f) => /^docs\/regression\/\d{2,}-.*\.md$/.test(f)).sort();
  const regByRel = new Map(regFiles.map((f) => ['regression/' + path.basename(f), f]));
  const indexText = fs.readFileSync(path.join(ROOT, REGRESSION_INDEX_FILE), 'utf8');
  const seenRels = new Set();
  let expectedNum = 1;

  indexText.split('\n').forEach((line, idx) => {
    if (!/^\|\s*\d+\s*\|/.test(line)) {
      return;
    }
    const loc = REGRESSION_INDEX_FILE + ':' + (idx + 1);
    const cols = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cols.length !== 4) {
      errs.push(loc + ': expected 4 table columns');
      return;
    }
    const [numCol, linkCol, filesCol, atCol] = cols;
    const num = Number(numCol);
    if (num !== expectedNum) {
      errs.push(loc + ': expected regression #' + expectedNum + ', found #' + numCol);
    }
    expectedNum = num + 1;

    const linkMatch = linkCol.match(/^\[(.+)\]\(([^)]+)\)$/);
    if (!linkMatch) {
      errs.push(loc + ': malformed Title link cell');
      return;
    }
    const [, title, rel] = linkMatch;
    if (title.length > MAX_REGRESSION_TITLE) {
      errs.push(
        loc + ': title is ' + title.length + ' chars (limit ' + MAX_REGRESSION_TITLE + '; move detail to Scope)'
      );
    }
    if (seenRels.has(rel)) {
      errs.push(loc + ': duplicate link to ' + rel);
    }
    seenRels.add(rel);

    const fullPath = regByRel.get(rel);
    if (!fullPath) {
      errs.push(loc + ': target regression file docs/' + rel + ' does not exist');
    } else {
      const fileNum = Number(path.basename(rel).split('-')[0]);
      if (fileNum !== num) {
        errs.push(loc + ': row #' + num + ' links to mismatched file number ' + rel);
      }
      const h1 = fs.readFileSync(path.join(ROOT, fullPath), 'utf8').split('\n')[0];
      const hMatch = h1.match(/^#\s+0*(\d+)\.\s+(.+)$/);
      if (!hMatch || Number(hMatch[1]) !== num || hMatch[2] !== title) {
        errs.push(fullPath + ':1: heading must match REGRESSION.md row #' + num + ' ("# ' + num + '. ' + title + '")');
      }
    }

    const codeFiles = [...filesCol.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (codeFiles.length === 0) {
      errs.push(loc + ': Files column must list at least one backticked src/ filename');
    }
    for (const codeFile of codeFiles) {
      if (!srcBasenames.has(codeFile)) {
        errs.push(loc + ': unknown src/ filename `' + codeFile + '` in Files column');
      }
    }

    if (atCol !== '-' && !/^AT-\d{2}(\s*,\s*AT-\d{2})*$/.test(atCol)) {
      errs.push(loc + ': Acceptance column must be "-" or comma-separated AT-NN IDs');
    }
    for (const atMatch of atCol.matchAll(AT_TOKEN_REGEX)) {
      if (!validAtIds.has(atMatch[0])) {
        errs.push(loc + ': unknown acceptance ID ' + atMatch[0]);
      }
    }
  });

  for (const [rel, fullPath] of regByRel.entries()) {
    if (!seenRels.has(rel)) {
      errs.push(REGRESSION_INDEX_FILE + ': missing row for ' + fullPath);
    }
  }
}

/**
 * Validates CHANGELOG.md release heading parity on exact vX.Y.Z Git tags: forbids ## dev and
 * requires the newest ## section to match ## vX.Y.Z with at least one bullet entry.
 *
 * @param {string} exactTag - Exact Git release tag (e.g. 'v0.0.2').
 * @param {string} changelogText - Contents of CHANGELOG.md.
 * @param {string[]} errs - Error accumulator.
 */
function checkChangelogReleaseTag(exactTag, changelogText, errs) {
  const lines = changelogText.split(/\r?\n/);
  if (lines.some((line) => line.trim() === '## dev')) {
    errs.push('CHANGELOG.md: unreleased "## dev" heading is forbidden on release tag "' + exactTag + '"');
  }
  const headingIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      headingIndices.push(i);
    }
  }
  const expectedHeading = '## ' + exactTag;
  if (headingIndices.length === 0 || lines[headingIndices[0]].trim() !== expectedHeading) {
    errs.push('CHANGELOG.md: newest release heading must be "' + expectedHeading + '" on tag "' + exactTag + '"');
    return;
  }
  const startLine = headingIndices[0] + 1;
  const endLine = headingIndices.length > 1 ? headingIndices[1] : lines.length;
  const hasBullets = lines.slice(startLine, endLine).some((line) => /^- /.test(line));
  if (!hasBullets) {
    errs.push('CHANGELOG.md: section "' + expectedHeading + '" must contain at least one "- " entry');
  }
}

/**
 * Parses top-level `## ` sections of CHANGELOG.md in order.
 *
 * @param {string} changelogText - Raw CHANGELOG.md contents.
 * @returns {Array<{heading: string, body: string}>}
 */
function parseChangelogSections(changelogText) {
  const lines = changelogText.replace(/\r\n/g, '\n').split('\n');
  const indices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      indices.push(i);
    }
  }
  return indices.map((startIdx, pos) => {
    const endIdx = pos + 1 < indices.length ? indices[pos + 1] : lines.length;
    return {
      heading: lines[startIdx].trim(),
      body: lines
        .slice(startIdx + 1, endIdx)
        .join('\n')
        .trim(),
    };
  });
}

/**
 * Validates post-release CHANGELOG.md edits: ensures all previously tagged `## vX.Y.Z` sections
 * remain untouched and any new changes added after latestTag live under `## dev` (or the next
 * bumped `## vX.Y.Z` release heading) above `## <latestTag>`.
 *
 * @param {string} latestTag - Latest reachable vX.Y.Z Git tag (e.g. 'v0.0.2').
 * @param {string} taggedChangelogText - CHANGELOG.md contents at latestTag.
 * @param {string} currentChangelogText - Current working-tree CHANGELOG.md contents.
 * @param {string} pkgVersion - Current version string from package.json (e.g. '0.0.2').
 * @param {string[]} errs - Error accumulator.
 */
function checkChangelogPostRelease(latestTag, taggedChangelogText, currentChangelogText, pkgVersion, errs) {
  const taggedNorm = taggedChangelogText.replace(/\r\n/g, '\n').trim();
  const currentNorm = currentChangelogText.replace(/\r\n/g, '\n').trim();
  if (currentNorm === taggedNorm) {
    return;
  }

  const taggedSections = parseChangelogSections(taggedNorm);
  const currentSections = parseChangelogSections(currentNorm);
  const currentByHeading = new Map(currentSections.map((s) => [s.heading, s]));

  for (const taggedSec of taggedSections) {
    const curSec = currentByHeading.get(taggedSec.heading);
    if (!curSec || curSec.body !== taggedSec.body) {
      errs.push(
        'CHANGELOG.md: released section "' +
          taggedSec.heading +
          '" must not be modified after tag "' +
          latestTag +
          '" (record new changes under "## dev")'
      );
    }
  }

  if (currentSections.length === 0) {
    errs.push('CHANGELOG.md: missing "## dev" section above "## ' + latestTag + '"');
    return;
  }

  const topSection = currentSections[0];
  const nextTagHeading = '## v' + pkgVersion;
  const canStampNextRelease = Boolean(pkgVersion && 'v' + pkgVersion !== latestTag);
  const allowedTopHeadings = canStampNextRelease ? ['## dev', nextTagHeading] : ['## dev'];
  if (!allowedTopHeadings.includes(topSection.heading)) {
    errs.push(
      'CHANGELOG.md: new changes after tag "' +
        latestTag +
        '" must be recorded under "## dev" above "## ' +
        latestTag +
        '" (found "' +
        topSection.heading +
        '")'
    );
    return;
  }

  const hasBullets = topSection.body.split('\n').some((line) => /^- /.test(line));
  if (!hasBullets) {
    errs.push('CHANGELOG.md: section "' + topSection.heading + '" must contain at least one "- " entry');
  }
}

/**
 * Validates package.json / package-lock.json version parity and exact vX.Y.Z Git tag alignment.
 *
 * @param {string[]} errs - Error accumulator.
 */
function checkPackageVersionAndLockfile(errs) {
  const pkgPath = path.join(ROOT, 'package.json');
  const lockPath = path.join(ROOT, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!fs.existsSync(lockPath)) {
    errs.push('package-lock.json: missing lockfile');
    return;
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const lockRootVersion = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;
  if (lock.version !== pkg.version || lockRootVersion !== pkg.version) {
    errs.push('package-lock.json: version does not match package.json (' + pkg.version + ')');
  }

  const changelogText = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  let statusPorcelain = '';
  try {
    statusPorcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    return;
  }

  if (!statusPorcelain) {
    try {
      const exactTag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const tagMatch = exactTag.match(/^v(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/);
      if (tagMatch) {
        if (pkg.version !== tagMatch[1]) {
          errs.push('package.json: version "' + pkg.version + '" does not match exact Git tag "' + exactTag + '"');
        }
        checkChangelogReleaseTag(exactTag, changelogText, errs);
        return;
      }
    } catch (err) {
      // HEAD is ahead of the latest tag; fall through to post-release check.
    }
  }

  try {
    const latestTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (latestTag) {
      const taggedChangelog = execFileSync('git', ['show', latestTag + ':CHANGELOG.md'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      checkChangelogPostRelease(latestTag, taggedChangelog, changelogText, pkg.version, errs);
    }
  } catch (err) {
    // No reachable v* release tag yet or CHANGELOG.md did not exist at tag.
  }
}

/**
 * Rejects a `healthcheck:` key in Compose files: the Dockerfile HEALTHCHECK is the single home of the probe.
 *
 * @param {string} file - Relative Compose file path.
 * @param {string} text - Compose file content.
 * @param {string[]} errs - Error accumulator.
 */
function checkComposeHasNoHealthcheck(file, text, errs) {
  text.split('\n').forEach((line, index) => {
    if (COMPOSE_HEALTHCHECK_REGEX.test(line)) {
      errs.push(file + ':' + (index + 1) + ': remove healthcheck, deploy/Dockerfile HEALTHCHECK is its only home');
    }
  });
}

/**
 * Runs all repository documentation, acceptance, regression, and release parity checks.
 */
function runDocsCheck() {
  const errors = [];
  const files = listFiles(ROOT);
  const matches = (file, patterns) => patterns.some((p) => p.test(file));
  const validAtIds = checkAcceptanceIndex(files, errors);
  checkAcceptanceTestSuite(validAtIds, errors);
  checkRegressionIndex(files, validAtIds, errors);
  checkPackageVersionAndLockfile(errors);
  for (const file of files.filter((f) => COMPOSE_FILE_REGEX.test(f))) {
    checkComposeHasNoHealthcheck(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), errors);
  }

  for (const file of files) {
    const abs = path.join(ROOT, file);
    const bytes = fs.statSync(abs).size;
    if (file === AGENTS_FILE && bytes > AGENTS_LIMIT_BYTES) {
      errors.push(file + ': ' + bytes + ' bytes exceeds the hard limit of ' + AGENTS_LIMIT_BYTES);
    } else if (file.startsWith('docs/') && file.endsWith('.md') && bytes > DOC_LIMIT_BYTES) {
      errors.push(file + ': ' + bytes + ' bytes exceeds ' + DOC_LIMIT_BYTES + '; split it');
    } else if (file.startsWith('.agents/') && file.endsWith('SKILL.md') && bytes > SKILL_LIMIT_BYTES) {
      errors.push(file + ': ' + bytes + ' bytes exceeds ' + SKILL_LIMIT_BYTES + '; move detail to references/');
    }
    if (!matches(file, DASH_FILES) && !matches(file, WIDTH_FILES) && !matches(file, PII_FILES)) {
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    if (matches(file, PII_FILES)) {
      text.split('\n').forEach((line, index) => {
        for (const rule of PII_RULES) {
          if (rule.re.test(line)) {
            errors.push(file + ':' + (index + 1) + ': forbidden personal/environment data (' + rule.label + ')');
          }
        }
      });
    }
    if (matches(file, DASH_FILES)) {
      text.split('\n').forEach((line, index) => {
        if (DASH_REGEX.test(line)) {
          errors.push(file + ':' + (index + 1) + ': use a plain ASCII hyphen instead of an en-dash or em-dash');
        }
      });
    }
    if (file.endsWith('.md') && matches(file, AT_REF_FILES)) {
      for (const atMatch of text.matchAll(AT_TOKEN_REGEX)) {
        if (!validAtIds.has(atMatch[0])) {
          errors.push(file + ': unknown acceptance reference ' + atMatch[0]);
        }
      }
    }
    if (file.endsWith('.md') && matches(file, WIDTH_FILES)) {
      for (const {no, text: line} of widthLines(text)) {
        if (line.length > MAX_LINE) {
          errors.push(file + ':' + no + ': line is ' + line.length + ' characters (limit ' + MAX_LINE + ')');
        }
      }
      for (const match of text.matchAll(LINK_REGEX)) {
        const target = match[1].split('#')[0];
        const isLocal = target && !/^[a-z]+:/i.test(target);
        if (isLocal && !fs.existsSync(path.resolve(path.dirname(abs), target))) {
          errors.push(file + ': broken relative link ' + match[1]);
        }
      }
    }
  }

  const agentsBytes = fs.statSync(path.join(ROOT, AGENTS_FILE)).size;
  if (agentsBytes > AGENTS_TARGET_BYTES) {
    console.log('note: ' + AGENTS_FILE + ' is ' + agentsBytes + ' bytes (target ' + AGENTS_TARGET_BYTES + ')');
  }
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    console.error('docs-check failed: ' + errors.length + ' problem(s)');
    process.exit(1);
  }
  console.log('docs-check passed');
}

if (require.main === module) {
  runDocsCheck();
}

module.exports = {
  checkChangelogReleaseTag,
  checkChangelogPostRelease,
  checkComposeHasNoHealthcheck,
};
