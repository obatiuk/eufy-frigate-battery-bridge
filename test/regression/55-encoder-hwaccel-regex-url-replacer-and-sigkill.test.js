/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 55:
 * Tighten Encoder hwaccel Fallback Regex, Safe {name} Replacer & Shutdown SIGKILL
 * (docs/regression/55-encoder-hwaccel-regex-url-replacer-and-sigkill.md).
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');
process.env.BRIDGE_HWACCEL = 'vaapi';
process.env.BRIDGE_HWACCEL_DEVICE = __filename;

const {ACTIVE_HWACCEL} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {configureEncoderHooks, buildEncoderArgs, startEncoder} = require('../../src/media/encoder');

/**
 * Creates a deterministic fake FFmpeg ChildProcess for startEncoder() exit tests.
 *
 * @returns {EventEmitter & {
 *   pid: number,
 *   exitCode: number|null,
 *   signalCode: string|null,
 *   stdin: EventEmitter & {writable: boolean, writableNeedDrain: boolean, write: () => boolean},
 *   stderr: EventEmitter,
 *   stdio: Array<EventEmitter|null>,
 *   signals: string[],
 *   kill: (sig: string) => void
 * }}
 */
function createFakeEncoderProcess() {
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    writableNeedDrain: false,
    write: () => true,
  });
  const stderr = new EventEmitter();
  const audioPipe = new EventEmitter();
  return Object.assign(new EventEmitter(), {
    pid: 5500,
    exitCode: null,
    signalCode: null,
    stdin,
    stderr,
    stdio: [stdin, null, stderr, audioPipe],
    /** @type {string[]} */
    signals: [],
    /**
     * @param {string} sig - Signal name.
     */
    kill(sig) {
      this.signals.push(sig);
    },
  });
}

describe('Regression 55: Tighten Encoder hwaccel Fallback Regex, Safe {name} Replacer & Shutdown SIGKILL', () => {
  afterEach(() => {
    configureEncoderHooks({spawn: null, isShuttingDown: () => false});
  });

  it(
    'Regression 55: keeps GPU hwaccel enabled across RTSP/TCP network errors while falling back on hardware/driver ' +
      'initialization failures',
    (t) => {
      // Regression: generic "device", "driver", or "Invalid argument" text in RTSP/TCP errors must not permanently
      // downgrade a camera from hwaccel to software libx264.
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 100_000});
      assert.equal(ACTIVE_HWACCEL, 'vaapi');

      /** @type {Array<{args: string[], proc: ReturnType<typeof createFakeEncoderProcess>}>} */
      const spawned = [];
      configureEncoderHooks({
        isShuttingDown: () => false,
        spawn: /** @type {*} */ (
          (_cmd, args) => {
            const proc = createFakeEncoderProcess();
            spawned.push({args, proc});
            return proc;
          }
        ),
      });

      const cam = new Camera({serial: 'T8161T0000000055', name: 'front_device_driver'});
      startEncoder(cam);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].args.includes('h264_vaapi'), true);

      // 1. RTSP/TCP failure within 5s containing "device", "driver", and "Invalid argument" must NOT disable hwaccel
      t.mock.timers.tick(400);
      spawned[0].proc.stderr.emit(
        'data',
        Buffer.from('[rtsp @ 0x55] Error writing header to rtsp://127.0.0.1:8554/front_device_driver: Invalid argument')
      );
      spawned[0].proc.emit('exit', 1);

      assert.equal(
        cam.resolveActiveHwaccel(ACTIVE_HWACCEL),
        'vaapi',
        'Transient go2rtc/RTSP output failure must not disable GPU hwaccel'
      );

      // Advance 3000ms backoff -> encoder restarts still using h264_vaapi
      t.mock.timers.tick(3000);
      assert.equal(spawned.length, 2);
      assert.equal(spawned[1].args.includes('h264_vaapi'), true);

      // 2. Genuine VAAPI / hardware initialization failure within 5s falls back to software libx264 after 1000ms
      t.mock.timers.tick(200);
      spawned[1].proc.stderr.emit(
        'data',
        Buffer.from('[AVHWDeviceContext @ 0x55] Failed to initialise VAAPI connection: -1 (unknown libva error)')
      );
      spawned[1].proc.emit('exit', 1);

      assert.equal(cam.resolveActiveHwaccel(ACTIVE_HWACCEL), '');
      t.mock.timers.tick(1000);
      assert.equal(spawned.length, 3);
      assert.equal(spawned[2].args.includes('libx264'), true);

      configureEncoderHooks({isShuttingDown: () => true});
      cam.stopEncoderProcess();
      spawned[2].proc.exitCode = 0;
      spawned[2].proc.emit('exit', 0);
    }
  );

  it(
    'Regression 55: uses a safe function replacer for {name} in buildEncoderArgs and escalates wedged encoders to ' +
      'SIGKILL on shutdown',
    (t) => {
      // Regression: $& / $$ replacement patterns must not expand in rtsp_publish_url and stopEncoderProcess must
      // escalate to SIGKILL if SIGTERM does not terminate ffmpeg.
      t.mock.timers.enable({apis: ['setTimeout']});
      const specialCam = /** @type {*} */ ({getName: () => 'cam_$&_$$'});
      const builtArgs = buildEncoderArgs(specialCam, '');
      assert.equal(builtArgs[builtArgs.length - 1].endsWith('/cam_$&_$$'), true);

      const cam = new Camera({serial: 'T8161T0000000056', name: 'side_yard'});
      const wedgedEnc = createFakeEncoderProcess();
      cam.attachEncoder(wedgedEnc, 1000);

      cam.stopEncoderProcess();
      assert.deepEqual(wedgedEnc.signals, ['SIGTERM']);

      t.mock.timers.tick(2000);
      assert.deepEqual(wedgedEnc.signals, ['SIGTERM', 'SIGKILL']);
    }
  );
});
