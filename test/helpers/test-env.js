// @ts-check
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Isolates tests from the host environment and any local `./config.yaml` or `/config/config.yaml`
 * before `src/config` evaluates its startup singleton.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEST_TMP_DIR = path.join(REPO_ROOT, '.tmp');
const TEST_CACHE_DIR = path.join(TEST_TMP_DIR, 'cache');
const TEST_CONFIG_PATH = path.join(TEST_TMP_DIR, 'test-config.yaml');
const DEFAULT_TEST_CONFIG_YAML = 'cameras:\n  - serial: T8161T0000000000\n    mode: rtsp\n';

const SCRUBBED_PREFIXES = Object.freeze(['EUFY_WS_', 'FRIGATE_', 'GO2RTC_']);
const SCRUBBED_KEYS = new Set([
  'HA_WEBHOOK_URL',
  'BRIDGE_HWACCEL',
  'BRIDGE_HWACCEL_DEVICE',
  'BRIDGE_HTTP_PORT',
  'BRIDGE_VERSION',
  'BRIDGE_COMMIT',
]);

/**
 * Returns true if an environment variable key is an external endpoint or runtime override
 * that should be cleared before loading `src/` in unit tests.
 *
 * @param {string} key - Environment variable name.
 * @returns {boolean}
 */
function shouldScrubEnvKey(key) {
  return SCRUBBED_KEYS.has(key) ? true : SCRUBBED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Ensures `.tmp/cache` and `.tmp/test-config.yaml` exist, clears ambient endpoint/runtime
 * environment variables on `env`, and points `BRIDGE_CONFIG` and `BRIDGE_CACHE_DIR` at `.tmp/`.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Target environment dictionary.
 * @returns {Readonly<{ repoRoot: string, tmpDir: string, cacheDir: string, configPath: string }>}
 */
function initTestEnv(env = process.env) {
  fs.mkdirSync(TEST_CACHE_DIR, {recursive: true});
  if (!fs.existsSync(TEST_CONFIG_PATH) || fs.readFileSync(TEST_CONFIG_PATH, 'utf8') !== DEFAULT_TEST_CONFIG_YAML) {
    fs.writeFileSync(TEST_CONFIG_PATH, DEFAULT_TEST_CONFIG_YAML, 'utf8');
  }
  for (const key of Object.keys(env)) {
    if (shouldScrubEnvKey(key)) {
      delete env[key];
    }
  }
  env.NODE_ENV = 'test';
  env.BRIDGE_LOG_LEVEL = 'error';
  env.TMPDIR = TEST_TMP_DIR;
  env.BRIDGE_CACHE_DIR = TEST_CACHE_DIR;
  env.BRIDGE_CONFIG = TEST_CONFIG_PATH;
  return Object.freeze({
    repoRoot: REPO_ROOT,
    tmpDir: TEST_TMP_DIR,
    cacheDir: TEST_CACHE_DIR,
    configPath: TEST_CONFIG_PATH,
  });
}

initTestEnv(process.env);

module.exports = {
  REPO_ROOT,
  TEST_TMP_DIR,
  TEST_CACHE_DIR,
  initTestEnv,
};
