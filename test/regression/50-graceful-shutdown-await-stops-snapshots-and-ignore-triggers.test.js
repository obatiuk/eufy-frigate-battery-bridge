/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 50. Graceful Shutdown Drain for Station Stops, Snapshot Saves & Trigger Guards
 * (docs/regression/50-graceful-shutdown-await-stops-snapshots-and-ignore-triggers.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

require('../helpers/test-env');
const {flushAsync, waitUntil} = require('../helpers/async');
const {createFakeFfmpegProcess, finishFakeFfmpegProcess} = require('../helpers/media-mocks');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {getCacheFilePath} = require('../../src/overlay/snapshot-cache');
const {initOrchestrator, trigger, arbitrate, onEvent} = require('../../src/services/stream-orchestrator');
const {shutdownBridge, resetBridgeShutdownForTests} = require('../../src/app');

describe('Regression 50. Graceful Shutdown Drain for Station Stops, Snapshot Saves & Trigger Guards', () => {
  it(
    'Regression 50: clears viewUntil on shutdown, ignores new triggers while shutting down, and awaits ' +
      'station teardown RPCs and in-flight snapshot saves before exiting',
    async (t) => {
      // Regression: shutdownBridge exited without awaiting station stop RPCs or async saveCachedFrame encodes, left
      // viewUntil set in prepareForShutdown, and allowed trigger/arbitrate/onEvent to run while shutting down.
      const childProcess = require('node:child_process');
      const cam = new Camera({
        serial: 'SN0000000501',
        name: 'shutdown_drain_cam',
        mode: 'p2p',
        station_serial: 'T8030P0000000050',
      });
      const idleCam = new Camera({
        serial: 'SN0000000502',
        name: 'shutdown_idle_cam',
        mode: 'p2p',
        station_serial: 'T8030P0000000050',
      });

      let shuttingDown = false;
      const {sentCommands, wsInstance} = await setupAcceptanceHarness([cam, idleCam]);
      initOrchestrator(
        [cam, idleCam],
        new Map([
          [cam.getSerial(), cam],
          [idleCam.getSerial(), idleCam],
        ]),
        () => shuttingDown
      );

      // 1. Entrypoints (trigger, onEvent, arbitrate) must ignore wake attempts while shuttingDown is true.
      shuttingDown = true;
      trigger(idleCam, {reason: 'late viewer', ms: 15_000, kind: 'view', initiator: 'viewer'});
      onEvent({source: 'device', event: 'person detected', serialNumber: idleCam.getSerial(), state: true});
      arbitrate(Date.now());
      assert.equal(idleCam.isSessionActive(), false);
      assert.equal(idleCam.getMotionUntil(), 0);
      assert.equal(idleCam.getViewUntil(), 0);

      // 2. prepareForShutdown clears viewUntil as well as motionUntil, and shutdownBridge awaits both
      //    device.stop_livestream teardown and async FFmpeg snapshot save before calling process.exit(0).
      shuttingDown = false;
      resetBridgeShutdownForTests();
      const t0 = Date.now();
      cam.beginSession('p2p', t0 - 10_000, false);
      cam.setViewUntil(t0 + 25_000);
      cam.recordDecodedFrame(Buffer.alloc(FRAME, 0x66), Buffer.alloc(FRAME, 0x66), t0 - 1_000, '13:00');
      const finalFile = getCacheFilePath(cam);

      const spawned = [];
      t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
        const proc = createFakeFfmpegProcess();
        spawned.push({cmd, args, opts, proc});
        return proc;
      });
      const exitCodes = [];
      let wsClosedWhenSnapshotFinished = false;
      t.mock.method(process, 'exit', (code) => {
        exitCodes.push(code);
      });

      try {
        sentCommands.length = 0;
        const drainingShutdown = shutdownBridge([cam, idleCam]);
        assert.equal(cam.getViewUntil(), 0, 'prepareForShutdown must clear viewUntil');

        await waitUntil(() => spawned.length > 0 && sentCommands.includes('device.stop_livestream'));
        assert.equal(exitCodes.length, 0, 'process.exit must wait while snapshot FFmpeg encode is still running');

        const tempFile = spawned[0].args[spawned[0].args.length - 1];
        fs.writeFileSync(tempFile, 'saved-before-exit');
        wsClosedWhenSnapshotFinished = wsInstance.readyState === 3;
        finishFakeFfmpegProcess(spawned[0].proc, {status: 0});

        await drainingShutdown;
        await flushAsync();
        assert.equal(wsClosedWhenSnapshotFinished, false, 'WebSocket must stay open while stop RPCs drain');
        assert.equal(fs.readFileSync(finalFile, 'utf8'), 'saved-before-exit');
        assert.deepEqual(exitCodes, [0]);
      } finally {
        resetBridgeShutdownForTests();
        initOrchestrator([], new Map(), () => true);
        fs.rmSync(finalFile, {force: true});
      }
    }
  );
});
