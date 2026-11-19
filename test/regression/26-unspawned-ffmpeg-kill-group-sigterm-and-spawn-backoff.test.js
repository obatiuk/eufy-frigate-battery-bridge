/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 26. Unspawned FFmpeg Process-Group SIGTERM, Spawn-Error Detach & Reporter IPC Crash
 * (docs/regression/26-unspawned-ffmpeg-kill-group-sigterm-and-spawn-backoff.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const conciseReporter = require('../reporter');
const {Camera} = require('../../src/domain/camera');
const {configureDecoderHooks, startRtspDecoder, onVideo, stopDecoder} = require('../../src/media/decoder');
const {configureEncoderHooks, startEncoder} = require('../../src/media/encoder');

/**
 * Runs the concise test reporter over synthetic events and returns captured output and exit codes.
 *
 * @param {Record<string, *>[]} events - Events to replay.
 * @returns {Promise<{output: string, exitCodes: number[]}>}
 */
async function runReporter(events) {
  const exitCodes = [];
  async function* source() {
    yield* events;
  }
  let output = '';
  for await (const chunk of conciseReporter.report(source(), (code) => exitCodes.push(code))) {
    output += chunk;
  }
  return {output, exitCodes};
}

describe('Regression 26. Unspawned FFmpeg Process-Group SIGTERM, Spawn-Error Detach & Reporter IPC Crash', () => {
  it(
    'Regression 26: detaches encoder and decoders and schedules backoff retries when FFmpeg fails to spawn ' +
      'without emitting exit',
    () => {
      // Regression: when spawn('ffmpeg') emits 'error' without 'exit' (such as ENOENT in a minimal
      // container or EAGAIN), encoder and decoder handles must detach immediately instead of wedging
      // hasEncoderProcess/hasDecoderProcess/isWakingRtspOnStation
      const {EventEmitter} = require('node:events');
      const createMockFfmpegProcess = () => {
        const proc = new EventEmitter();
        const stdin = new EventEmitter();
        stdin.writable = true;
        stdin.writableNeedDrain = false;
        stdin.write = () => true;
        stdin.end = () => {};
        const stdout = new EventEmitter();
        stdout.pause = () => {};
        stdout.resume = () => {};
        const stderr = new EventEmitter();
        const audioPipe = new EventEmitter();
        audioPipe.writable = true;
        audioPipe.writableNeedDrain = false;
        audioPipe.write = () => true;
        audioPipe.end = () => {};
        proc.stdin = stdin;
        proc.stdout = stdout;
        proc.stderr = stderr;
        proc.stdio = [stdin, stdout, stderr, audioPipe, new EventEmitter()];
        proc.kill = () => {};
        return proc;
      };

      const origSetTimeout = global.setTimeout;
      const origDateNow = Date.now;
      let fakeNow = 100000;
      const scheduledDelays = [];
      const scheduledTimers = [];
      Date.now = () => fakeNow;
      global.setTimeout = /** @type {typeof setTimeout} */ (
        (fn, ms, ...rest) => {
          scheduledDelays.push(Number(ms) || 0);
          const handle = {
            fn,
            ms: Number(ms) || 0,
            rest,
            unref() {
              return this;
            },
          };
          scheduledTimers.push(handle);
          return /** @type {*} */ (handle);
        }
      );

      const encCam = new Camera({serial: 'T8161T0000000041', name: 'enc_enoent_cam'});
      const rtspCam = new Camera({
        serial: 'T8161T0000000042',
        name: 'rtsp_enoent_cam',
        mode: 'rtsp',
        station_serial: 'T8030P0000000040',
      });
      rtspCam.updateDiscoveredRtspConfig('T8030P0000000040', 'rtsp://127.0.0.1:1/live0');
      const p2pCam = new Camera({serial: 'T8161T0000000043', name: 'p2p_enoent_cam', mode: 'p2p'});

      const spawnedProcs = [];
      let throwSyncSpawn = false;
      const mockSpawn = () => {
        if (throwSyncSpawn) {
          throw Object.assign(new Error('spawn ffmpeg EAGAIN'), {code: 'EAGAIN'});
        }
        const proc = createMockFfmpegProcess();
        spawnedProcs.push(proc);
        return proc;
      };

      try {
        assert.equal(typeof configureDecoderHooks, 'function');
        configureEncoderHooks({spawn: mockSpawn, isShuttingDown: () => false});
        configureDecoderHooks({spawn: mockSpawn});

        // 1. Encoder emits 'error' (ENOENT) without 'exit' -> detaches immediately and backs off 3000ms -> 6000ms
        scheduledDelays.length = 0;
        startEncoder(encCam);
        assert.equal(encCam.hasEncoderProcess(), true);
        spawnedProcs[0].emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), {code: 'ENOENT'}));
        assert.equal(
          encCam.hasEncoderProcess(),
          false,
          'Encoder error without exit must immediately detach cam.enc so hasEncoderProcess() is not stuck true'
        );
        assert.equal(scheduledDelays.at(-1), 3000, 'First encoder spawn failure must schedule 3000ms retry');

        // Synchronous spawn throw (EAGAIN) on retry increments backoff to 6000ms without throwing out of startEncoder
        throwSyncSpawn = true;
        fakeNow += 3000;
        startEncoder(encCam);
        assert.equal(encCam.hasEncoderProcess(), false);
        assert.equal(scheduledDelays.at(-1), 6000, 'Second consecutive encoder spawn failure must back off to 6000ms');
        throwSyncSpawn = false;

        // 2. RTSP decoder emits 'error' (ENOENT) without 'exit' -> detaches cam.dec &
        // decSpawnedAt and backs off 750ms -> 1500ms
        scheduledDelays.length = 0;
        spawnedProcs.length = 0;
        rtspCam.beginSession('rtsp', fakeNow, false);
        startRtspDecoder(rtspCam);
        assert.equal(rtspCam.hasDecoderProcess(), true);
        spawnedProcs[0].emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), {code: 'ENOENT'}));
        assert.equal(
          rtspCam.hasDecoderProcess(),
          false,
          'RTSP decoder error without exit must immediately detach cam.dec'
        );
        assert.equal(
          rtspCam.getDecoderSpawnedAt(),
          0,
          'RTSP decoder error must reset decSpawnedAt so station handshake never wedges'
        );
        assert.equal(scheduledDelays.at(-1), 750);

        fakeNow += 750;
        startRtspDecoder(rtspCam);
        spawnedProcs[1].emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), {code: 'ENOENT'}));
        assert.equal(rtspCam.hasDecoderProcess(), false);
        assert.equal(
          scheduledDelays.at(-1),
          1500,
          'Second consecutive RTSP decoder spawn error must back off to 1500ms'
        );

        // 3. P2P decoder spawned via onVideo emits 'error' without 'exit' -> detaches
        // immediately and throttles re-spawns
        spawnedProcs.length = 0;
        p2pCam.beginSession('p2p', fakeNow, true);
        const spsKeyframe = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]);
        onVideo(p2pCam, {buffer: spsKeyframe, metadata: {videoCodec: 'H264', videoWidth: 1280, videoHeight: 720}});
        assert.equal(spawnedProcs.length, 1);
        assert.equal(p2pCam.hasDecoderProcess(), true);
        spawnedProcs[0].emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), {code: 'ENOENT'}));
        assert.equal(p2pCam.hasDecoderProcess(), false);

        // Next keyframe 50ms later within backoff window must not hammer-spawn FFmpeg
        fakeNow += 50;
        onVideo(p2pCam, {buffer: spsKeyframe, metadata: {videoCodec: 'H264', videoWidth: 1280, videoHeight: 720}});
        assert.equal(spawnedProcs.length, 1, 'P2P onVideo must honor spawn backoff window after FFmpeg spawn error');

        // Advancing past initial 1000ms P2P decoder spawn backoff allows a retry
        fakeNow += 1000;
        onVideo(p2pCam, {buffer: spsKeyframe, metadata: {videoCodec: 'H264', videoWidth: 1280, videoHeight: 720}});
        assert.equal(spawnedProcs.length, 2, 'P2P onVideo must retry spawning FFmpeg once spawn backoff expires');
        spawnedProcs[1].emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), {code: 'ENOENT'}));

        // 4. Stopping a decoder or encoder before ENOENT nextTick (pid === undefined / 0) must
        // NEVER invoke proc.kill(), which in libuv calls kill(0, SIGTERM) and terminates the
        // entire process group (including parent node --test!)
        const unspawnedSignals = [];
        rtspCam.attachDecoder({
          pid: undefined,
          stdin: {end() {}},
          kill(sig) {
            unspawnedSignals.push('dec:' + sig);
          },
        });
        stopDecoder(rtspCam);
        for (const timer of scheduledTimers) {
          if (timer.ms === 2000) {
            timer.fn();
          }
        }
        encCam.attachEncoder({
          pid: undefined,
          kill(sig) {
            unspawnedSignals.push('enc:' + sig);
          },
        });
        encCam.stopEncoderProcess();
        encCam.killWedgedEncoder();
        encCam.pauseEncoderForOffline();
        assert.deepEqual(
          unspawnedSignals,
          [],
          'Must never call .kill() on an unspawned ChildProcess (pid === undefined/0) to avoid ' +
            'POSIX kill(0, sig) process-group kills'
        );
      } finally {
        global.setTimeout = origSetTimeout;
        Date.now = origDateNow;
        encCam.stopEncoderProcess();
        rtspCam.clearRtspRetryTimer();
        rtspCam.endSession(fakeNow + 5000);
        p2pCam.endSession(fakeNow + 5000);
        configureEncoderHooks({spawn: null, isShuttingDown: () => false});
        if (typeof configureDecoderHooks === 'function') {
          configureDecoderHooks({spawn: null});
        }
      }
    }
  );

  it(
    'Regression 26: formats null-prototype IPC errors and suite-level worker crashes without throwing or ' +
      'hiding failures',
    async () => {
      // Regression: node:test IPC error payloads with Object.create(null) prototypes or file-level suite crashes
      // must never throw TypeError on String(err) or produce zero output on exit status 1.
      const nullProtoErr = Object.assign(Object.create(null), {
        code: 'ERR_TEST_FAILURE',
        failureType: 'testTimeoutFailure',
      });
      const {output: nullProtoOut} = await runReporter([
        {
          type: 'test:fail',
          data: {name: 'timed out test', details: {type: 'test', error: nullProtoErr}},
        },
        {type: 'test:summary', data: {duration_ms: 42, success: false}},
      ]);
      assert.match(nullProtoOut, /FAIL: timed out test/);
      assert.match(nullProtoOut, /ERR_TEST_FAILURE/);
      assert.match(nullProtoOut, /Tests failed: 1 failed, 0 passed \(42ms\)/);

      const suiteCrashErr = Object.assign(Object.create(null), {
        code: 'ERR_TEST_FAILURE',
        failureType: 'testCodeFailure',
        message: 'test/eufy-client.test.js exited with code 1',
      });
      const {output: suiteCrashOut} = await runReporter([
        {
          type: 'test:fail',
          data: {name: 'test/eufy-client.test.js', details: {type: 'suite', error: suiteCrashErr}},
        },
        {type: 'test:summary', data: {duration_ms: 8100, success: false}},
      ]);
      assert.match(suiteCrashOut, /FAIL: test\/eufy-client\.test\.js/);
      assert.match(suiteCrashOut, /exited with code 1/);
      assert.match(suiteCrashOut, /Tests failed: 1 failed, 0 passed \(8100ms\)/);

      const {output: rollupOut} = await runReporter([
        {type: 'test:pass', data: {name: 'ok leaf', details: {type: 'test'}}},
        {
          type: 'test:fail',
          data: {name: 'bad leaf', details: {type: 'test', error: new Error('boom')}},
        },
        {
          type: 'test:fail',
          data: {
            name: 'parent describe',
            details: {
              type: 'suite',
              error: Object.assign(new Error('1 subtest failed'), {failureType: 'subtestsFailed'}),
            },
          },
        },
        {type: 'test:summary', data: {duration_ms: 15, success: false}},
      ]);
      assert.match(rollupOut, /FAIL: bad leaf/);
      assert.equal(rollupOut.includes('FAIL: parent describe'), false);
      assert.match(rollupOut, /Tests failed: 1 failed, 1 passed \(15ms\)/);
    }
  );
});
