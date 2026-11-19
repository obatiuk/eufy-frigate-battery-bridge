/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 45. Fast Dependency-Free `/healthz` Liveness Response & Immediate Startup Binding
 * (docs/regression/45-fast-dependency-free-healthz-and-startup-probe.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {REPO_ROOT, TEST_TMP_DIR} = require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {createHttpRequestHandler} = require('../../src/services/http-server');

installDefaultFetchStub();

describe('Regression 45. Fast Dependency-Free `/healthz` Liveness Response & Immediate Startup Binding', () => {
  it(
    'Regression 45: exits 0 in Dockerfile HEALTHCHECK when BRIDGE_HTTP_PORT=0 has a live ready marker and ' +
      'exits 1 before marking ready on invalid startup configuration',
    () => {
      // Regression: .dockerignore must not exclude deploy/Dockerfile so Stage 1 builder tests can read it
      const dockerignorePath = path.join(REPO_ROOT, '.dockerignore');
      if (fs.existsSync(dockerignorePath)) {
        const dockerignoreLines = fs.readFileSync(dockerignorePath, 'utf8').split(/\r?\n/);
        assert.equal(
          dockerignoreLines.includes('deploy/Dockerfile') || dockerignoreLines.includes('deploy/'),
          false,
          '.dockerignore must not exclude deploy/Dockerfile or deploy/ (needed by builder-stage tests)'
        );
      }

      const dockerfile = fs.readFileSync(path.resolve(__dirname, '..', '..', 'deploy', 'Dockerfile'), 'utf8');
      assert.equal(
        dockerfile.includes('mesa-dri-gallium'),
        false,
        'deploy/Dockerfile must not install unneeded OpenGL 3D mesa-dri-gallium drivers'
      );
      assert.ok(
        dockerfile.includes('FROM docker.io/library/alpine:3.23'),
        'deploy/Dockerfile runtime stage must use minimal alpine:3.23 without npm/yarn/corepack'
      );
      assert.ok(
        dockerfile.includes('COPY --from=builder /usr/local/bin/node /usr/local/bin/node'),
        'deploy/Dockerfile must copy only the stripped node binary from builder'
      );
      assert.ok(
        dockerfile.includes('find /app/node_modules') && dockerfile.includes('-empty -delete'),
        'deploy/Dockerfile builder must prune empty @scope dirs and docs from /app/node_modules'
      );
      const healthDirectiveMatch = dockerfile.match(/(HEALTHCHECK[^\n]*)\\\r?\n\s*CMD\s+(.+)/);
      assert.ok(healthDirectiveMatch, 'deploy/Dockerfile must declare a HEALTHCHECK CMD');
      const [, healthFlags, healthCmd] = healthDirectiveMatch;
      assert.match(
        healthFlags,
        /--interval=5s/,
        'deploy/Dockerfile HEALTHCHECK must probe every 5s so containers exit starting state promptly'
      );
      assert.match(healthFlags, /--timeout=2s/, 'deploy/Dockerfile HEALTHCHECK must bound probe timeout to 2s');
      assert.match(
        healthFlags,
        /--start-period=5s/,
        'deploy/Dockerfile HEALTHCHECK must keep start-period aligned with the 5s interval'
      );
      assert.equal(
        healthFlags.includes('--start-interval'),
        false,
        'deploy/Dockerfile HEALTHCHECK must avoid --start-interval so Buildah < 1.37 builds cleanly'
      );
      const {execFileSync, spawnSync} = require('node:child_process');
      const healthTmpDir = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'health-port0-'));
      try {
        // Without a live ready marker (unstarted or failed config), BRIDGE_HTTP_PORT=0 must NOT report healthy
        assert.throws(() => {
          execFileSync('/bin/sh', ['-c', healthCmd.trim()], {
            env: {BRIDGE_HTTP_PORT: '0', TMPDIR: healthTmpDir},
            stdio: 'pipe',
          });
        });

        // Once a live bridge process writes its PID after passing config validation, BRIDGE_HTTP_PORT=0 exits 0
        const readyFile = path.join(healthTmpDir, 'eufy-bridge-ready.pid');
        fs.writeFileSync(readyFile, String(process.pid), 'utf8');
        execFileSync('/bin/sh', ['-c', healthCmd.trim()], {
          env: {BRIDGE_HTTP_PORT: '0', TMPDIR: healthTmpDir},
          stdio: 'pipe',
        });

        // Dead/exited PID in marker file must NOT report healthy
        fs.writeFileSync(readyFile, '99999999', 'utf8');
        assert.throws(() => {
          execFileSync('/bin/sh', ['-c', healthCmd.trim()], {
            env: {BRIDGE_HTTP_PORT: '0', TMPDIR: healthTmpDir},
            stdio: 'pipe',
          });
        });
      } finally {
        fs.rmSync(healthTmpDir, {recursive: true, force: true});
      }

      assert.throws(() => {
        execFileSync('/bin/sh', ['-c', healthCmd.trim()], {
          env: {BRIDGE_HTTP_PORT: '1'},
          stdio: 'pipe',
        });
      });

      // Regression: invalid configuration (YAML or env) must exit(1) cleanly before binding HTTP or marking
      // ready, so HEALTHCHECK never returns healthy (0) on invalid config under any BRIDGE_HTTP_PORT
      const invalidBootDir = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'invalid-cfg-health-'));
      try {
        const missingYamlPath = path.join(invalidBootDir, 'does-not-exist.yaml');
        const brokenSyntaxPath = path.join(invalidBootDir, 'broken-syntax.yaml');
        fs.writeFileSync(brokenSyntaxPath, 'cameras:\n  - serial: [unclosed\n', 'utf8');
        const badSchemaPath = path.join(invalidBootDir, 'bad-schema.yaml');
        fs.writeFileSync(badSchemaPath, 'unknown_option: true\ncameras: []\n', 'utf8');
        const dupCamPath = path.join(invalidBootDir, 'dup-cam.yaml');
        fs.writeFileSync(
          dupCamPath,
          'cameras:\n  - serial: SN0000000001\n    name: front\n  - serial: SN0000000002\n    name: front\n',
          'utf8'
        );
        const validYamlPath = path.join(invalidBootDir, 'valid.yaml');
        fs.writeFileSync(validYamlPath, 'cameras:\n  - serial: SN0000000001\n    mode: rtsp\n', 'utf8');

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

        const invalidStartupCases = [
          {label: 'missing config.yaml in production', env: {NODE_ENV: 'production', BRIDGE_CONFIG: missingYamlPath}},
          {label: 'malformed YAML syntax', env: {NODE_ENV: 'production', BRIDGE_CONFIG: brokenSyntaxPath}},
          {label: 'unknown key and empty cameras', env: {NODE_ENV: 'production', BRIDGE_CONFIG: badSchemaPath}},
          {label: 'duplicate camera name', env: {NODE_ENV: 'production', BRIDGE_CONFIG: dupCamPath}},
          {
            label: 'invalid EUFY_WS_URL scheme on port 0',
            env: {
              NODE_ENV: 'production',
              BRIDGE_CONFIG: validYamlPath,
              BRIDGE_HTTP_PORT: '0',
              EUFY_WS_URL: 'http://wrong-scheme:3000',
            },
          },
          {
            label: 'invalid FRIGATE_URL syntax',
            env: {NODE_ENV: 'production', BRIDGE_CONFIG: validYamlPath, FRIGATE_URL: 'not-a-valid-url'},
          },
          {
            label: 'unknown BRIDGE_HWACCEL mode',
            env: {NODE_ENV: 'production', BRIDGE_CONFIG: validYamlPath, BRIDGE_HWACCEL: 'cuda_typo'},
          },
          {
            label: 'unknown BRIDGE_LOG_LEVEL',
            env: {NODE_ENV: 'production', BRIDGE_CONFIG: validYamlPath, BRIDGE_LOG_LEVEL: 'verbose_typo'},
          },
        ];

        for (const tc of invalidStartupCases) {
          const caseTmp = fs.mkdtempSync(path.join(invalidBootDir, 'case-'));
          // Pre-seed a stale PID marker to verify failed startup clears it so port=0 healthcheck still fails
          fs.writeFileSync(path.join(caseTmp, 'eufy-bridge-ready.pid'), String(process.pid), 'utf8');
          const runEnv = {
            ...baseCleanEnv,
            TMPDIR: caseTmp,
            BRIDGE_CACHE_DIR: path.join(caseTmp, 'cache'),
            BRIDGE_HTTP_PORT: tc.env.BRIDGE_HTTP_PORT || '1',
            ...tc.env,
          };
          const appRun = spawnSync(process.execPath, [path.join(REPO_ROOT, 'src/app.js')], {
            env: runEnv,
            encoding: 'utf8',
            timeout: 5000,
          });
          assert.equal(appRun.status, 1, 'Expected exit code 1 for invalid config case: ' + tc.label);
          const combinedLogs = (appRun.stdout || '') + (appRun.stderr || '');
          assert.match(
            combinedLogs,
            /\[ERROR\] - \[bridge\] startup configuration error:/,
            'Expected structured startup error log for: ' + tc.label
          );
          assert.equal(
            combinedLogs.includes('\n    at '),
            false,
            'Startup configuration error must not print a stack trace for: ' + tc.label
          );

          const probeRun = spawnSync('/bin/sh', ['-c', healthCmd.trim()], {
            env: runEnv,
            encoding: 'utf8',
            timeout: 5000,
          });
          assert.notEqual(
            probeRun.status,
            0,
            'HEALTHCHECK must NEVER return 0 (healthy) when configuration is invalid: ' + tc.label
          );
        }
      } finally {
        fs.rmSync(invalidBootDir, {recursive: true, force: true});
      }
    }
  );

  it(
    'Regression 45: serves dependency-free fixed-length /healthz responses immediately on startup without ' +
      'exposing ws_connected or waiting for camera initialization',
    async () => {
      // Regression: /healthz must reply immediately with fixed-length {"ok":true} (Connection: close)
      // even before cameras finish initializing and must omit ws_connected regardless of WS state
      const {PassThrough} = require('node:stream');
      /** @type {Camera[]} */
      const bootstrapCams = [];
      let shuttingDown = false;
      const handler = createHttpRequestHandler(bootstrapCams, {
        wakeCameraExternal: () => ({}),
        isShuttingDown: () => shuttingDown,
      });

      const sendProbe = async (method, url) => {
        const req = Object.assign(new PassThrough(), {method, url});
        const headers = {};
        let status = 0;
        let body = '';
        const done = new Promise((resolve) => {
          const res = {
            setHeader(k, v) {
              headers[String(k).toLowerCase()] = String(v);
            },
            writeHead(code, hdrs = {}) {
              status = code;
              for (const [k, v] of Object.entries(hdrs)) {
                headers[String(k).toLowerCase()] = String(v);
              }
            },
            end(chunk = '') {
              body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
              resolve();
            },
          };
          void handler(req, res);
        });
        req.end();
        await done;
        return {status, headers, body};
      };

      const earlyProbe = await sendProbe('GET', '/healthz');
      assert.equal(earlyProbe.status, 200);
      assert.equal(earlyProbe.body, '{"ok":true}');
      assert.equal(earlyProbe.headers['content-type'], 'application/json');
      assert.equal(earlyProbe.headers['content-length'], '11');
      assert.equal(earlyProbe.headers['cache-control'], 'no-store');
      assert.equal(earlyProbe.headers.connection, 'close');

      const absUriProbe = await sendProbe('GET', 'http://127.0.0.1:8080/healthz');
      assert.equal(absUriProbe.status, 200);
      assert.equal(absUriProbe.body, '{"ok":true}');

      shuttingDown = true;
      const shutdownProbe = await sendProbe('GET', '/healthz');
      assert.equal(shutdownProbe.status, 503);
      assert.equal(shutdownProbe.body, '{"ok":false}');
      assert.equal(shutdownProbe.headers['content-length'], '12');
      assert.equal(shutdownProbe.headers.connection, 'close');

      const shutdownHeadProbe = await sendProbe('HEAD', '/health');
      assert.equal(shutdownHeadProbe.status, 503);
      assert.equal(shutdownHeadProbe.body, '');
      assert.equal(shutdownHeadProbe.headers['content-length'], '12');

      const appSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'app.js'), 'utf8');
      const mainBodyMatch = appSource.match(/function main\(\)\s*\{([\s\S]*?)\n\}/);
      assert.ok(mainBodyMatch, 'src/app.js must define main()');
      const mainBody = mainBodyMatch[1];
      const httpStartIdx = mainBody.indexOf('startHttpServer(');
      const camInitIdx = mainBody.search(/initCameras\(|createCameras\(/);
      assert.ok(
        httpStartIdx !== -1 && camInitIdx !== -1 && httpStartIdx < camInitIdx,
        'main() must bind startHttpServer() before synchronous camera snapshot decoding'
      );
    }
  );
});
