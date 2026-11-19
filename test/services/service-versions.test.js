/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for startup external service API version soft validation (src/services/service-versions.js, src/app.js).
 */
'use strict';

const {afterEach, describe, it, mock} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync, spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const {WebSocketServer} = require('ws');

const {REPO_ROOT, TEST_TMP_DIR} = require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {log} = require('../../src/logger');
const {
  MIN_SUPPORTED_VERSIONS,
  parseSemver,
  isVersionLowerThan,
  validateEufyWsVersion,
  verifyUpstreamServiceVersions,
  stopUpstreamVersionChecks,
  resetServiceVersionChecks,
} = require('../../src/services/service-versions');

installDefaultFetchStub();

describe('External Service API Version Soft Validation (src/services/service-versions.js)', () => {
  afterEach(() => {
    stopUpstreamVersionChecks();
    resetServiceVersionChecks();
    mock.timers.reset();
    installDefaultFetchStub();
  });

  it('locks actual minimum supported versions and parses semver strings accurately', () => {
    // Verify minimum supported versions reflect actual API requirements rather than tested versions,
    // and semver comparisons handle commit suffixes and multi-digit minor/patch numbers numerically.
    assert.equal(MIN_SUPPORTED_VERSIONS.FRIGATE, '0.14.0');
    assert.equal(MIN_SUPPORTED_VERSIONS.GO2RTC, '1.9.0');
    assert.equal(MIN_SUPPORTED_VERSIONS.EUFY_WS, '1.9.9');
    assert.equal(MIN_SUPPORTED_VERSIONS.EUFY_WS_SCHEMA, 18);

    const minFrigate = parseSemver('0.14.0');
    const minGo2rtc = parseSemver('1.9.0');
    const minEufyWs = parseSemver('1.9.9');
    assert.deepEqual(minFrigate, {major: 0, minor: 14, patch: 0, raw: '0.14.0'});
    assert.deepEqual(parseSemver('v1.9.14'), {major: 1, minor: 9, patch: 14, raw: 'v1.9.14'});
    assert.deepEqual(parseSemver('0.18.0-9034454'), {major: 0, minor: 18, patch: 0, raw: '0.18.0-9034454'});
    assert.deepEqual(parseSemver('1.9'), {major: 1, minor: 9, patch: 0, raw: '1.9'});
    assert.equal(parseSemver(''), null);
    assert.equal(parseSemver('dev'), null);
    assert.equal(parseSemver(null), null);

    assert.equal(isVersionLowerThan(parseSemver('0.14.0-9034454'), minFrigate), false);
    assert.equal(isVersionLowerThan(parseSemver('0.9.4-26ae608'), minFrigate), true);
    assert.equal(isVersionLowerThan(parseSemver('0.13.9-abcdef0'), minFrigate), true);
    assert.equal(isVersionLowerThan(parseSemver('1.10.0'), minGo2rtc), false);
    assert.equal(isVersionLowerThan(parseSemver('1.8.5'), minGo2rtc), true);
    assert.equal(isVersionLowerThan(parseSemver('1.9.9'), minEufyWs), false);
    assert.equal(isVersionLowerThan(parseSemver('1.9.8'), minEufyWs), true);
  });

  it('passes silently when Frigate and go2rtc meet minimum supported API versions on startup', async () => {
    // Verify Frigate >= 0.14.0 and go2rtc >= 1.9.0 produce zero startup warnings.
    const warnings = [];
    const requestedUrls = [];
    const origWarn = log.warn;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));
    global.fetch = /** @type {typeof fetch} */ (
      async (url) => {
        const u = String(url);
        requestedUrls.push(u);
        if (u === 'http://frigate:5000/api/version') {
          return /** @type {*} */ ({
            ok: true,
            status: 200,
            async text() {
              return '0.14.0-9034454\n';
            },
          });
        }
        if (u === 'http://frigate:1984/api') {
          return /** @type {*} */ ({
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({version: '1.9.0', revision: 'dfe4755', rtsp: {listen: ':8554'}});
            },
          });
        }
        throw new Error('Unexpected URL: ' + u);
      }
    );

    try {
      await verifyUpstreamServiceVersions({
        frigateUrl: 'http://frigate:5000',
        go2rtcUrl: 'http://frigate:1984',
      });
      assert.deepEqual(requestedUrls.sort(), ['http://frigate:1984/api', 'http://frigate:5000/api/version']);
      assert.deepEqual(warnings, []);
    } finally {
      log.warn = origWarn;
    }
  });

  it('logs warnings without failing startup when Frigate or go2rtc API versions are below minimum', async () => {
    // Verify soft validation warns clearly when Frigate < 0.14.0 or go2rtc < 1.9.0 and continues cleanly.
    const warnings = [];
    const origWarn = log.warn;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));
    global.fetch = /** @type {typeof fetch} */ (
      async (url) => {
        const u = String(url);
        if (u === 'http://frigate:5000/api/version') {
          return /** @type {*} */ ({
            ok: true,
            status: 200,
            async text() {
              return '0.13.2-26ae608';
            },
          });
        }
        if (u === 'http://frigate:1984/api') {
          return /** @type {*} */ ({
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({version: '1.8.5', rtsp: {listen: ':8554'}});
            },
          });
        }
        throw new Error('Unexpected URL: ' + u);
      }
    );

    try {
      await verifyUpstreamServiceVersions({
        frigateUrl: 'http://frigate:5000',
        go2rtcUrl: 'http://frigate:1984',
      });
      assert.equal(warnings.length, 2);
      assert.equal(
        warnings.some((w) => w.includes('Frigate') && w.includes('0.13.2-26ae608') && w.includes('0.14.0')),
        true
      );
      assert.equal(
        warnings.some((w) => w.includes('go2rtc') && w.includes('1.8.5') && w.includes('1.9.0')),
        true
      );
    } finally {
      log.warn = origWarn;
    }
  });

  it('retries unverified upstream services after startup network errors and ignores dev stubs', async () => {
    // Verify slow-booting Frigate is retried without re-querying already-verified go2rtc, and warns once reachable.
    mock.timers.enable({apis: ['setTimeout']});
    const warnings = [];
    const calls = [];
    let frigateUp = false;
    const origWarn = log.warn;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));
    global.fetch = /** @type {typeof fetch} */ (
      async (url) => {
        const u = String(url);
        calls.push(u);
        if (u === 'http://frigate:5000/api/version') {
          if (!frigateUp) {
            throw new Error('connect ECONNREFUSED');
          }
          return /** @type {*} */ ({
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({version: '0.12.1'});
            },
          });
        }
        if (u === 'http://frigate:1984/api') {
          return /** @type {*} */ ({
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({version: 'dev'});
            },
          });
        }
        throw new Error('Unexpected URL: ' + u);
      }
    );

    try {
      await verifyUpstreamServiceVersions({
        frigateUrl: 'http://frigate:5000',
        go2rtcUrl: 'http://frigate:1984',
        retryDelayMs: 5000,
        maxRetries: 2,
      });
      assert.deepEqual(warnings, []);
      assert.equal(calls.filter((u) => u.endsWith('/api')).length, 1);
      assert.equal(calls.filter((u) => u.endsWith('/api/version')).length, 1);

      frigateUp = true;
      mock.timers.tick(5000);
      await flushAsync();

      assert.equal(calls.filter((u) => u.endsWith('/api')).length, 1);
      assert.equal(calls.filter((u) => u.endsWith('/api/version')).length, 2);
      assert.equal(warnings.length, 1);
      assert.equal(
        warnings[0].includes('Frigate') && warnings[0].includes('0.12.1') && warnings[0].includes('0.14.0'),
        true
      );
    } finally {
      log.warn = origWarn;
    }
  });

  it('validates eufy-security-ws serverVersion (>= 1.9.9) and maxSchemaVersion (>= 18) without duplicate spam', () => {
    // Verify eufy-security-ws soft validation accepts 1.9.9 / schema 18, warns on lower serverVersion or schema,
    // and deduplicates identical reconnect handshakes.
    const warnings = [];
    const origWarn = log.warn;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));

    try {
      assert.equal(validateEufyWsVersion({serverVersion: '1.9.9', maxSchemaVersion: 18}).ok, true);
      assert.equal(validateEufyWsVersion({serverVersion: '1.9.9', maxSchemaVersion: 20}).ok, true);
      assert.equal(validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: 21}).ok, true);
      assert.equal(validateEufyWsVersion({maxSchemaVersion: 18}).ok, true);
      assert.equal(warnings.length, 0);

      const lowServer = validateEufyWsVersion({serverVersion: '1.9.8', maxSchemaVersion: 20});
      assert.equal(lowServer.ok, false);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].includes('1.9.8') && warnings[0].includes('1.9.9'), true);

      // Duplicate reconnect with identical outdated version must not spam a second warning
      validateEufyWsVersion({serverVersion: '1.9.8', maxSchemaVersion: 20});
      assert.equal(warnings.length, 1);

      // Upgrading clears warning state; a different outdated schema/version warns once
      assert.equal(validateEufyWsVersion({serverVersion: '2.0.0', maxSchemaVersion: 20}).ok, true);
      const lowBoth = validateEufyWsVersion({serverVersion: '1.5.2', maxSchemaVersion: 17});
      assert.equal(lowBoth.ok, false);
      assert.equal(warnings.length, 2);
      assert.equal(
        warnings[1].includes('1.5.2') &&
          warnings[1].includes('17') &&
          warnings[1].includes('1.9.9') &&
          warnings[1].includes('18'),
        true
      );
    } finally {
      log.warn = origWarn;
    }
  });

  it('wires verifyUpstreamServiceVersions into startServices() and cleanup into shutdownBridge() in src/app.js', () => {
    // Verify application bootstrap invokes upstream version verification at startup and clears retry timers on exit.
    const appSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'app.js'), 'utf8');
    assert.equal(appSource.includes('verifyUpstreamServiceVersions('), true);
    assert.equal(appSource.includes('stopUpstreamVersionChecks('), true);
  });

  it('never throws or emits false schema-0 warnings on malformed eufy-security-ws version frames', () => {
    // Verify malformed or non-numeric maxSchemaVersion/serverVersion fields never throw or coerce to schema 0.
    const warnings = [];
    const origWarn = log.warn;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));

    try {
      assert.equal(validateEufyWsVersion(null).ok, true);
      assert.equal(validateEufyWsVersion(undefined).ok, true);
      assert.equal(validateEufyWsVersion({}).ok, true);
      assert.equal(validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: ''}).ok, true);
      assert.equal(validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: '   '}).ok, true);
      assert.equal(validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: false}).ok, true);
      assert.equal(validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: []}).ok, true);
      assert.equal(validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: Symbol('bad')}).ok, true);
      assert.equal(
        validateEufyWsVersion({serverVersion: Object.create(null), maxSchemaVersion: Object.create(null)}).ok,
        true
      );
      const throwingFrame = Object.defineProperty({}, 'maxSchemaVersion', {
        get() {
          throw new Error('corrupt getter');
        },
      });
      assert.equal(validateEufyWsVersion(throwingFrame).ok, true);
      assert.deepEqual(warnings, []);

      assert.equal(validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: '18'}).ok, true);
      assert.deepEqual(warnings, []);

      const stringLowSchema = validateEufyWsVersion({serverVersion: '3.1.0', maxSchemaVersion: '17'});
      assert.equal(stringLowSchema.ok, false);
      assert.equal(stringLowSchema.schemaBelowMin, true);
      assert.equal(warnings.length, 1);
    } finally {
      log.warn = origWarn;
    }
  });

  it('aborts in-flight probes on shutdown, caps oversized bodies, and never rejects on broken responses', async () => {
    // Verify stopUpstreamVersionChecks aborts hanging startup probes, suppresses post-shutdown warnings,
    // caps streaming bodies, and swallows broken Response errors without unhandled rejections.
    const warnings = [];
    const errors = [];
    const origWarn = log.warn;
    const origError = log.error;
    log.warn = (_scope, ...args) => warnings.push(args.join(' '));
    log.error = (_scope, ...args) => errors.push(args.join(' '));

    try {
      let shuttingDown = false;
      /** @type {AbortSignal|null} */
      let frigateSignal = null;
      /** @type {((val: *) => void)|null} */
      let resolveGo2rtc = null;

      global.fetch = /** @type {typeof fetch} */ (
        (url, opts) => {
          const u = String(url);
          if (u === 'http://frigate:5000/api/version') {
            frigateSignal = opts && opts.signal ? opts.signal : null;
            return new Promise((_resolve, reject) => {
              if (frigateSignal) {
                frigateSignal.addEventListener('abort', () => reject(new Error('This operation was aborted')), {
                  once: true,
                });
              }
            });
          }
          if (u === 'http://frigate:1984/api') {
            return new Promise((resolve) => {
              resolveGo2rtc = resolve;
            });
          }
          return Promise.reject(new Error('Unexpected URL: ' + u));
        }
      );

      const inFlightCheck = verifyUpstreamServiceVersions({
        frigateUrl: 'http://frigate:5000',
        go2rtcUrl: 'http://frigate:1984',
        isShuttingDown: () => shuttingDown,
      });

      assert.ok(frigateSignal, 'Expected AbortSignal to be passed to startup version fetch');
      assert.equal(frigateSignal.aborted, false);

      shuttingDown = true;
      stopUpstreamVersionChecks();
      assert.equal(frigateSignal.aborted, true, 'stopUpstreamVersionChecks() must abort in-flight startup fetch');
      if (resolveGo2rtc) {
        resolveGo2rtc({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({version: '1.8.0'});
          },
        });
      }
      await inFlightCheck;
      assert.deepEqual(warnings, [], 'Post-shutdown responses must not emit startup version warnings');
      assert.deepEqual(errors, []);

      // Oversized/infinite streaming response body must be capped and cancelled promptly
      let generatedChunks = 0;
      let streamCancelled = false;
      const chunkPayload = new Uint8Array(32768).fill(0x61);
      global.fetch = /** @type {typeof fetch} */ (
        async () => {
          const body = new ReadableStream({
            pull(controller) {
              generatedChunks += 1;
              controller.enqueue(chunkPayload);
            },
            cancel() {
              streamCancelled = true;
            },
          });
          return /** @type {*} */ ({ok: true, status: 200, body});
        }
      );

      await verifyUpstreamServiceVersions({
        frigateUrl: 'http://frigate:5000',
        go2rtcUrl: '',
        maxRetries: 0,
      });
      assert.equal(streamCancelled, true, 'Oversized version stream must be cancelled instead of buffered to EOF');
      assert.equal(generatedChunks <= 4, true, 'Expected bounded chunk reads, got ' + generatedChunks);

      // Synchronous throws inside res.text() on 200 or 500 responses must never reject or log [ERROR]
      global.fetch = /** @type {typeof fetch} */ (
        async (url) => {
          if (String(url).endsWith('/api/version')) {
            return /** @type {*} */ ({
              ok: true,
              status: 200,
              text() {
                throw new Error('sync 200 text throw');
              },
            });
          }
          return /** @type {*} */ ({
            ok: false,
            status: 500,
            text() {
              throw new Error('sync 500 text throw');
            },
          });
        }
      );

      await verifyUpstreamServiceVersions({
        frigateUrl: 'http://frigate:5000',
        go2rtcUrl: 'http://frigate:1984',
        maxRetries: 0,
      });
      assert.deepEqual(warnings, []);
      assert.deepEqual(errors, []);
    } finally {
      log.warn = origWarn;
      log.error = origError;
    }
  });

  it('keeps container startup and HEALTHCHECK healthy when upstreams hang, fail, or warn', async () => {
    // Verify real src/app.js startup serves 200 /healthz and passes Dockerfile HEALTHCHECK immediately while
    // upstream version endpoints hang, refuse connections, or report outdated versions, and aborts probes on SIGTERM.
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'deploy/Dockerfile'), 'utf8');
    const healthMatch = dockerfile.match(/HEALTHCHECK[^\n]*\\\r?\n\s*CMD\s+(.+)/);
    assert.ok(healthMatch, 'deploy/Dockerfile must declare HEALTHCHECK CMD');
    const healthCmd = healthMatch[1].trim();

    const reservePort = () =>
      new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          const addr = /** @type {net.AddressInfo} */ (srv.address());
          srv.close((err) => (err ? reject(err) : resolve(addr.port)));
        });
      });

    const baseCleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          k !== 'NODE_TEST_CONTEXT' &&
          !k.startsWith('BRIDGE_') &&
          !k.startsWith('EUFY_WS_') &&
          !k.startsWith('FRIGATE_') &&
          !k.startsWith('GO2RTC_') &&
          k !== 'HA_WEBHOOK_URL'
      )
    );

    const bootDir = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'version-boot-'));
    const binDir = path.join(bootDir, 'bin');
    fs.mkdirSync(binDir, {recursive: true});
    const fakeFfmpegPath = path.join(binDir, 'ffmpeg');
    fs.writeFileSync(fakeFfmpegPath, '#!/bin/sh\ncat >/dev/null\n', {mode: 0o755});
    const configPath = path.join(bootDir, 'config.yaml');
    fs.writeFileSync(configPath, 'cameras:\n  - serial: SN0000000001\n    mode: rtsp\n', 'utf8');

    let frigateRequestArrived = false;
    let frigateRequestAborted = false;
    let notifyMockState = () => {};

    const upstreamServer = http.createServer((req, res) => {
      if (req.url === '/api/version') {
        frigateRequestArrived = true;
        notifyMockState();
        req.once('close', () => {
          if (!res.writableEnded) {
            frigateRequestAborted = true;
            notifyMockState();
          }
        });
        // Intentionally never respond so Frigate /api/version hangs across container startup.
        return;
      }
      if (req.url === '/api') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({version: '1.8.5', rtsp: {listen: ':8554'}}));
        return;
      }
      if (req.url === '/api/streams') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end('{}');
        return;
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end('{"cameras":{}}');
    });

    const wss = new WebSocketServer({server: upstreamServer});
    wss.on('connection', (sock) => {
      sock.send(
        JSON.stringify({
          type: 'version',
          driverVersion: '2.4.0',
          serverVersion: '1.9.8',
          minSchemaVersion: 0,
          maxSchemaVersion: 17,
        })
      );
      sock.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.command === 'set_api_schema') {
          sock.send(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
        } else if (msg.command === 'start_listening') {
          sock.send(
            JSON.stringify({
              type: 'result',
              messageId: msg.messageId,
              success: true,
              result: {state: {driver: {connected: true}, stations: [], devices: []}},
            })
          );
        } else {
          sock.send(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
        }
      });
    });

    await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = /** @type {net.AddressInfo} */ (upstreamServer.address()).port;
    const bridgePort = await reservePort();

    /** @type {import('node:child_process').ChildProcess|null} */
    let child = null;
    /** @type {import('node:child_process').ChildProcess|null} */
    let portZeroChild = null;

    try {
      const state = {logs: '', waiters: /** @type {Array<() => void>} */ ([])};
      const wakeWaiters = () => {
        const current = state.waiters.splice(0, state.waiters.length);
        for (const fn of current) {
          fn();
        }
      };
      notifyMockState = wakeWaiters;

      const waitForCondition = (predicate, description) =>
        new Promise((resolve, reject) => {
          const check = () => {
            if (predicate()) {
              resolve();
              return;
            }
            if (child && child.exitCode !== null) {
              reject(
                new Error('Bridge exited early (' + child.exitCode + ') before ' + description + '\n' + state.logs)
              );
              return;
            }
            state.waiters.push(check);
          };
          check();
        });

      const caseTmp = path.join(bootDir, 'tmp-http');
      fs.mkdirSync(caseTmp, {recursive: true});
      const childEnv = {
        ...baseCleanEnv,
        PATH: binDir + path.delimiter + (baseCleanEnv.PATH || '/usr/bin:/bin'),
        NODE_ENV: 'production',
        TMPDIR: caseTmp,
        BRIDGE_CACHE_DIR: path.join(caseTmp, 'cache'),
        BRIDGE_CONFIG: configPath,
        BRIDGE_HTTP_PORT: String(bridgePort),
        BRIDGE_LOG_LEVEL: 'info',
        FRIGATE_URL: 'http://127.0.0.1:' + upstreamPort,
        GO2RTC_URL: 'http://127.0.0.1:' + upstreamPort,
        EUFY_WS_URL: 'ws://127.0.0.1:' + upstreamPort,
      };

      child = spawn(process.execPath, [path.join(REPO_ROOT, 'src/app.js')], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        state.logs += chunk.toString('utf8');
        wakeWaiters();
      });
      child.stderr.on('data', (chunk) => {
        state.logs += chunk.toString('utf8');
        wakeWaiters();
      });
      child.once('exit', wakeWaiters);

      await waitForCondition(
        () =>
          state.logs.includes('HTTP server listening on 0.0.0.0:' + bridgePort) &&
          frigateRequestArrived &&
          state.logs.includes('go2rtc API version 1.8.5 is lower than minimum supported version 1.9.0') &&
          state.logs.includes('eufy-security-ws version 1.9.8 (maxSchemaVersion=17)') &&
          state.logs.includes('listening for eufy events (apiSchema=17)'),
        'HTTP server + hanging Frigate probe + go2rtc/eufy-ws soft warnings'
      );

      // While Frigate /api/version is still hanging and other upstreams reported outdated versions,
      // both HTTP /healthz and the exact Dockerfile HEALTHCHECK CMD must succeed immediately.
      execFileSync('/bin/sh', ['-c', healthCmd], {env: childEnv, stdio: 'pipe'});
      const healthProbe = await new Promise((resolve, reject) => {
        http
          .get('http://127.0.0.1:' + bridgePort + '/healthz', (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
              body += c;
            });
            res.on('end', () => resolve({status: res.statusCode, body}));
          })
          .once('error', reject);
      });
      assert.equal(healthProbe.status, 200);
      assert.equal(healthProbe.body, '{"ok":true}');
      assert.equal(child.exitCode, null);
      assert.equal(state.logs.includes('[ERROR]'), false, 'Unexpected [ERROR] during startup:\n' + state.logs);

      // SIGTERM must immediately abort the hanging Frigate version check before exit delay elapses
      const exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      child.kill('SIGTERM');
      await waitForCondition(() => frigateRequestAborted, 'hanging Frigate version probe abort on SIGTERM');
      assert.equal(child.exitCode, null, 'Hanging probe must abort immediately before 1500ms process.exit');
      const exitCode = await exitPromise;
      assert.equal(exitCode, 0);
      assert.equal(fs.existsSync(path.join(caseTmp, 'eufy-bridge-ready.pid')), false);
      assert.equal(state.logs.includes('[ERROR]'), false, 'Unexpected [ERROR] on shutdown:\n' + state.logs);

      // Verify BRIDGE_HTTP_PORT=0 readiness marker HEALTHCHECK when all upstreams refuse connections
      const portZeroTmp = path.join(bootDir, 'tmp-port0');
      fs.mkdirSync(portZeroTmp, {recursive: true});
      const closedPort = await reservePort();
      const portZeroEnv = {
        ...baseCleanEnv,
        PATH: binDir + path.delimiter + (baseCleanEnv.PATH || '/usr/bin:/bin'),
        NODE_ENV: 'production',
        TMPDIR: portZeroTmp,
        BRIDGE_CACHE_DIR: path.join(portZeroTmp, 'cache'),
        BRIDGE_CONFIG: configPath,
        BRIDGE_HTTP_PORT: '0',
        BRIDGE_LOG_LEVEL: 'info',
        FRIGATE_URL: 'http://127.0.0.1:' + closedPort,
        GO2RTC_URL: 'http://127.0.0.1:' + closedPort,
        EUFY_WS_URL: 'ws://127.0.0.1:' + closedPort,
      };

      let portZeroLogs = '';
      portZeroChild = spawn(process.execPath, [path.join(REPO_ROOT, 'src/app.js')], {
        env: portZeroEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise((resolve, reject) => {
        const onChunk = (chunk) => {
          portZeroLogs += chunk.toString('utf8');
          if (portZeroLogs.includes('eufy-frigate-battery-bridge starting:')) {
            resolve();
          }
        };
        portZeroChild.stdout.on('data', onChunk);
        portZeroChild.stderr.on('data', onChunk);
        portZeroChild.once('exit', (code) =>
          reject(new Error('BRIDGE_HTTP_PORT=0 exited early (' + code + '):\n' + portZeroLogs))
        );
      });

      execFileSync('/bin/sh', ['-c', healthCmd], {env: portZeroEnv, stdio: 'pipe'});
      assert.equal(portZeroLogs.includes('unhandled promise rejection'), false);
      assert.equal(portZeroLogs.includes('uncaught exception'), false);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
      }
      if (portZeroChild && portZeroChild.exitCode === null) {
        portZeroChild.kill('SIGKILL');
      }
      wss.close();
      upstreamServer.closeAllConnections();
      await new Promise((resolve) => upstreamServer.close(() => resolve()));
      fs.rmSync(bootDir, {recursive: true, force: true});
    }
  });
});
