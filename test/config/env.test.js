/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for ${ENV_VAR} config placeholder expansion, environment endpoint validation,
 * and BridgeConfigBuilder option propagation (src/config/env.js, src/config/builder.js).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {TEST_TMP_DIR, REPO_ROOT} = require('../helpers/test-env');
const {expandConfigEnvVars, loadConfigFile, BridgeConfigBuilder} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {buildConfigPayload} = require('../../src/services/http-server');

describe('Environment Variable Expansion (${ENV_VAR} in config.yaml)', () => {
  it(
    'expands ${ENV_VAR} and ${ENV_VAR:-default} placeholders across strings, arrays, and nested objects ' +
      'without mutating input or double-expanding special characters',
    () => {
      // Verify ${ENV_VAR}, ${ENV_VAR:-default}, $${VAR} escaping, and special $ characters in secrets
      // expand cleanly in one pass
      const rawInput = {
        trigger_events: ['${PRIMARY_TRIGGER:-person}', 'ring'],
        cameras: [
          {
            name: 'play_mat_camera',
            title: 'Play Mat $${LITERAL_TAG}',
            mode: 'rtsp',
            rtsp_url: 'rtsp://${RTSP_USER}:${RTSP_PASSWORD}@192.0.2.10:554/live0',
          },
          {
            name: 'crib_camera',
            rtsp_url: '${CRIB_CAMERA_RTSP_URL}',
          },
        ],
      };
      const env = {
        RTSP_USER: 'cam_user',
        RTSP_PASSWORD: 'p$ss$$w0rd$&$\'"\\${UNEXPANDED_INNER}',
        CRIB_CAMERA_RTSP_URL: 'rtsp://crib_user:crib$pass@192.0.2.11:554/live0',
      };

      const expanded = expandConfigEnvVars(rawInput, env);
      assert.equal(rawInput.cameras[0].rtsp_url, 'rtsp://${RTSP_USER}:${RTSP_PASSWORD}@192.0.2.10:554/live0');
      assert.deepEqual(expanded.trigger_events, ['person', 'ring']);
      assert.equal(expanded.cameras[0].title, 'Play Mat ${LITERAL_TAG}');
      assert.equal(
        expanded.cameras[0].rtsp_url,
        'rtsp://cam_user:p$ss$$w0rd$&$\'"\\${UNEXPANDED_INNER}@192.0.2.10:554/live0'
      );
      assert.equal(expanded.cameras[1].rtsp_url, 'rtsp://crib_user:crib$pass@192.0.2.11:554/live0');
    }
  );

  it(
    'loads config.yaml from disk via loadConfigFile, resolves direct rtsp_url cameras, and masks expanded ' +
      'RTSP credentials in /api/config',
    () => {
      // Verify loadConfigFile parses YAML with comments, expands secrets before validateConfig, and masks
      // credentials in /api/config
      const tmpDir = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'bridge-env-cfg-'));
      const cfgPath = path.join(tmpDir, 'custom-bridge.yaml');
      try {
        fs.writeFileSync(
          cfgPath,
          [
            '# yaml-language-server: $schema=https://example.invalid/config.schema.json',
            '# Camera topology configuration',
            'cameras:',
            '  - name: play_mat_camera',
            '    title: Play Mat Camera',
            '    mode: rtsp',
            '    rtsp_url: rtsp://${RTSP_USER}:${RTSP_PASSWORD}@192.0.2.10:554/live0',
            '  - name: nursery_camera',
            '    title: Nursery Camera',
            '    rtsp_url: ${NURSERY_CAMERA_RTSP_URL}',
          ].join('\n'),
          'utf8'
        );

        const loaded = loadConfigFile(cfgPath, {
          RTSP_USER: 'admin',
          RTSP_PASSWORD: 's3cr3t_value',
          NURSERY_CAMERA_RTSP_URL: 'rtsps://viewer:other_s3cr3t@192.0.2.11:8555/live0',
        });
        const built = new BridgeConfigBuilder(loaded, {FRIGATE_HOST: 'frigate'}).build();
        assert.equal(built.frigate_url, 'http://frigate:5000');
        assert.equal(built.eufy_security_ws_url, '');
        assert.equal(built.cameras[0].rtsp_url, 'rtsp://admin:s3cr3t_value@192.0.2.10:554/live0');
        assert.equal(built.cameras[1].rtsp_url, 'rtsps://viewer:other_s3cr3t@192.0.2.11:8555/live0');
        assert.equal(built.cameras[1].timers.mode, 'rtsp');

        const cams = built.cameras.map((camCfg) => new Camera(camCfg));
        assert.equal(cams[0].getRtspUrl(), 'rtsp://admin:s3cr3t_value@192.0.2.10:554/live0');
        const apiPayload = buildConfigPayload(cams);
        const serialized = JSON.stringify(apiPayload);
        assert.equal(apiPayload.cameras[0].rtsp_url, 'rtsp://***@192.0.2.10:554/live0');
        assert.equal(apiPayload.cameras[1].rtsp_url, 'rtsps://***@192.0.2.11:8555/live0');
        assert.equal(serialized.includes('s3cr3t_value'), false);
        assert.equal(serialized.includes('other_s3cr3t'), false);
      } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    }
  );

  it(
    'fails in a single pass when any referenced ${ENV_VAR} is unset, empty, or an Object.prototype key ' +
      'without leaking resolved secrets',
    () => {
      // Verify unset, empty, and prototype-named environment placeholders all report in one error without
      // leaking other secrets
      const tmpDir = fs.mkdtempSync(path.join(TEST_TMP_DIR, 'bridge-env-missing-'));
      const cfgPath = path.join(tmpDir, 'config.yaml');
      try {
        fs.writeFileSync(
          cfgPath,
          [
            'cameras:',
            '  - name: play_mat_camera',
            '    mode: rtsp',
            '    rtsp_url: rtsp://${MISSING_RTSP_USER}:${EMPTY_RTSP_PASSWORD}@192.0.2.10:554/${toString}',
            '  - name: secret_cam',
            '    mode: rtsp',
            '    rtsp_url: rtsp://user:${VALID_SECRET}@192.0.2.12:554/live0',
          ].join('\n'),
          'utf8'
        );

        assert.throws(
          () =>
            loadConfigFile(cfgPath, {
              VALID_SECRET: 'DO_NOT_LEAK_ME_999',
              EMPTY_RTSP_PASSWORD: '',
            }),
          (err) => {
            assert.match(err.message, /config\.yaml:/);
            assert.match(err.message, /environment variable "MISSING_RTSP_USER" is not set \(cameras\[0\]\.rtsp_url\)/);
            assert.match(
              err.message,
              /environment variable "EMPTY_RTSP_PASSWORD" is not set \(cameras\[0\]\.rtsp_url\)/
            );
            assert.match(err.message, /environment variable "toString" is not set \(cameras\[0\]\.rtsp_url\)/);
            assert.equal(err.message.includes('DO_NOT_LEAK_ME_999'), false);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    }
  );

  it('passes inside an isolated deploy/Dockerfile builder-stage layout with .dockerignore files excluded', () => {
    // Regression: deploy/Dockerfile runs node --test in a builder stage where .dockerignore excludes scripts/,
    // docs/, Makefile, .gitignore, .dockerignore, and *.md; tests must never fail when those files are absent
    const dockerignorePath = path.join(REPO_ROOT, '.dockerignore');
    if (process.env.DOCKER_BUILDER_SIM === '1' || !fs.existsSync(dockerignorePath)) {
      return;
    }

    const ignorePatterns = fs
      .readFileSync(dockerignorePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const isDockerIgnored = (relPosix) =>
      ignorePatterns.some((pat) => {
        if (pat.endsWith('/')) {
          return relPosix === pat.slice(0, -1) || relPosix.startsWith(pat);
        }
        if (pat.startsWith('*.')) {
          return path.posix.basename(relPosix).endsWith(pat.slice(1));
        }
        return relPosix === pat;
      });

    const copyFiltered = (srcAbs, dstAbs, relPosix) => {
      if (isDockerIgnored(relPosix)) {
        return;
      }
      const stat = fs.statSync(srcAbs);
      if (stat.isDirectory()) {
        fs.mkdirSync(dstAbs, {recursive: true});
        for (const entry of fs.readdirSync(srcAbs)) {
          const childRel = relPosix ? relPosix + '/' + entry : entry;
          copyFiltered(path.join(srcAbs, entry), path.join(dstAbs, entry), childRel);
        }
        return;
      }
      fs.mkdirSync(path.dirname(dstAbs), {recursive: true});
      fs.copyFileSync(srcAbs, dstAbs);
    };

    const dockerfileText = fs.readFileSync(path.join(REPO_ROOT, 'deploy/Dockerfile'), 'utf8');
    const builderStage = dockerfileText.split(/^FROM\s+/m)[1] || '';
    const simRoot = path.join(TEST_TMP_DIR, 'docker-builder-sim-' + process.pid);
    fs.rmSync(simRoot, {recursive: true, force: true});

    try {
      for (const match of builderStage.matchAll(/^COPY\s+(?!--from=)(.+)\s+(\S+)\s*$/gm)) {
        const sources = match[1].trim().split(/\s+/);
        const destRaw = match[2].trim().replace(/^\/app\/?/, '');
        for (const srcToken of sources) {
          const cleanSrc = srcToken.replace(/\/+$/, '');
          const srcAbs = path.join(REPO_ROOT, cleanSrc);
          if (!fs.existsSync(srcAbs)) {
            continue;
          }
          const srcIsDir = fs.statSync(srcAbs).isDirectory();
          const dstAbs = srcIsDir
            ? path.join(simRoot, destRaw || cleanSrc)
            : destRaw && !match[2].endsWith('/')
              ? path.join(simRoot, destRaw)
              : path.join(simRoot, destRaw, path.basename(cleanSrc));
          copyFiltered(srcAbs, dstAbs, cleanSrc);
        }
      }

      assert.equal(fs.existsSync(path.join(simRoot, 'scripts')), false);
      assert.equal(fs.existsSync(path.join(simRoot, 'docs')), false);

      const simTmp = path.join(simRoot, '.tmp');
      const simCache = path.join(simTmp, 'cache');
      fs.mkdirSync(simCache, {recursive: true});
      const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
      const {execFileSync} = require('node:child_process');
      const simOut = execFileSync(
        process.execPath,
        [
          '--test',
          '--test-reporter=' + path.join(simRoot, 'test/reporter.js'),
          path.join(simRoot, 'test/config/config.test.js'),
        ],
        {
          cwd: simRoot,
          env: {
            ...cleanEnv,
            DOCKER_BUILDER_SIM: '1',
            TMPDIR: simTmp,
            BRIDGE_CACHE_DIR: simCache,
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }
      );
      assert.match(simOut, /^Tests passed: \d+\/\d+/m);
    } finally {
      fs.rmSync(simRoot, {recursive: true, force: true});
    }
  });

  it(
    'propagates top-level BridgeConfigBuilder timer and quality defaults into per-camera timers ' +
      'and hwRecordingConfig without module-global bleed',
    () => {
      // Verify: propagates top-level BridgeConfigBuilder timer and quality defaults into per-camera timers and
      // hwRecordingConfig without module-global bleed.
      const built = new BridgeConfigBuilder(
        {
          stream_max_secs: 180,
          view_linger_secs: 15,
          view_max_secs: 120,
          idle_timeout_secs: 25,
          low_battery_hold_secs: 15,
          low_battery_wake_on_view: true,
          power_mode: 'battery',
          streaming_quality: 'medium',
          cameras: [{serial: 'T8161T0000000099', mode: 'rtsp'}],
        },
        {}
      ).build();

      const camCfg = built.cameras[0];
      assert.equal(camCfg.timers.maxMs, 180000);
      assert.equal(camCfg.timers.lingerMs, 15000);
      assert.equal(camCfg.timers.viewMaxMs, 120000);
      assert.equal(camCfg.timers.earlySleepMs, 25000);
      assert.equal(camCfg.timers.lowBatHoldMs, 15000);
      assert.equal(camCfg.timers.lowBatWakeOnView, true);
      assert.equal(camCfg.hwRecordingConfig.powerMode, 'battery');
      assert.equal(camCfg.hwRecordingConfig.powerWorkingMode, 0);
      assert.equal(camCfg.hwRecordingConfig.streamingQuality, 'medium');
    }
  );
});
