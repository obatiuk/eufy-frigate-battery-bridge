/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 48. Per-Camera Housekeeping Error Isolation & Fatal Uncaught Exception Shutdown
 * (docs/regression/48-housekeeping-per-camera-error-isolation-and-fatal-exit.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {runHousekeepingTick, initOrchestrator} = require('../../src/services/stream-orchestrator');
const {resetHousekeepingErrorState} = require('../../src/services/orchestrator/housekeeping');
const {handleUncaughtException} = require('../../src/app');

describe('Regression 48. Per-Camera Housekeeping Error Isolation & Fatal Uncaught Exception Shutdown', () => {
  it(
    'Regression 48: isolates per-camera housekeeping throws with rate-limited error logs and shuts down ' +
      'non-zero on fatal uncaught exceptions',
    (t) => {
      // Regression: a throwing camera inside runHousekeepingTick aborted the loop before inspecting later cameras and
      // logged uncaught errors every 500ms, while uncaughtException kept running with corrupted state.
      resetHousekeepingErrorState();
      const t0 = 1_794_700_000_000;

      const brokenCam = new Camera({
        serial: 'SN0000000481',
        name: 'broken_cam',
        mode: 'p2p',
        hold_secs: 30,
        stream_max_secs: 60,
        startup_snapshot: false,
      });
      const healthyCam = new Camera({
        serial: 'SN0000000482',
        name: 'healthy_cam',
        mode: 'p2p',
        hold_secs: 30,
        stream_max_secs: 60,
        startup_snapshot: false,
      });

      // Arm healthyCam at its 60s max-duration cap so inspectCameraOnTick / prepareExpiredCameraHolds must stop it.
      healthyCam.beginSession('p2p', t0, true);
      healthyCam.setGotVideo(true);
      healthyCam.setFirstVideoAt(t0 + 1_000);
      healthyCam.setLastVideoAt(t0 + 60_000);
      healthyCam.setMotionUntil(t0 + 60_000);

      // Make brokenCam throw deterministically during both expired-hold prep and per-camera inspection.
      brokenCam.beginSession('p2p', t0, true);
      t.mock.method(brokenCam, 'hasExpiredLiveHold', () => {
        throw new Error('corrupt camera state');
      });
      t.mock.method(brokenCam, 'expireMaxDurationHold', () => {
        throw new Error('corrupt camera state');
      });

      const errorLogs = [];
      const origError = log.error;
      log.error = (scope, msg) => {
        const name = scope && typeof scope === 'object' && scope.getScopeName ? scope.getScopeName() : String(scope);
        errorLogs.push({scope: name, msg: String(msg)});
      };

      try {
        initOrchestrator(
          [brokenCam, healthyCam],
          new Map([
            [brokenCam.getSerial(), brokenCam],
            [healthyCam.getSerial(), healthyCam],
          ]),
          () => false
        );

        // Tick 1: brokenCam throws, must not throw out of runHousekeepingTick, and healthyCam still stops cleanly.
        assert.doesNotThrow(() => runHousekeepingTick(t0 + 60_000));
        assert.equal(
          healthyCam.isSessionActive(),
          false,
          'healthy_cam must still be processed after broken_cam throws'
        );
        const brokenErrorsAfterTick1 = errorLogs.filter((e) => e.scope === 'broken_cam');
        assert.equal(brokenErrorsAfterTick1.length > 0, true);

        // Immediate repeat ticks within the 30s rate-limit window must not spam additional ERROR lines.
        const countAfterFirstTick = brokenErrorsAfterTick1.length;
        runHousekeepingTick(t0 + 60_500);
        runHousekeepingTick(t0 + 61_000);
        const countDuringCooldown = errorLogs.filter((e) => e.scope === 'broken_cam').length;
        assert.equal(countDuringCooldown, countAfterFirstTick, 'repeat throws within 30s must be rate-limited');

        // Once 30s elapses, the error logs again.
        runHousekeepingTick(t0 + 91_000);
        const countAfterCooldown = errorLogs.filter((e) => e.scope === 'broken_cam').length;
        assert.equal(countAfterCooldown > countDuringCooldown, true);

        // Fatal top-level uncaughtException must initiate shutdown and exit with code 1 instead of continuing.
        t.mock.timers.enable({apis: ['setTimeout']});
        const exitCodes = [];
        t.mock.method(process, 'exit', (code) => {
          exitCodes.push(code);
        });
        assert.equal(typeof handleUncaughtException, 'function');
        handleUncaughtException([], new Error('unrecoverable invariant violation'));
        t.mock.timers.tick(2_000);
        assert.deepEqual(exitCodes, [1]);
        assert.equal(
          errorLogs.some((e) => e.scope === 'bridge' && e.msg.includes('unrecoverable invariant violation')),
          true
        );
      } finally {
        brokenCam.endSession(t0 + 92_000, false, false, 'p2p');
        resetHousekeepingErrorState();
        initOrchestrator([], new Map(), () => true);
        log.error = origError;
      }
    }
  );
});
