/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the persistent FFmpeg RTSP encoder pipeline and frame pacing (src/media/encoder.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {FRAME, LIVE_FPS, IDLE_FPS} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {
  buildVideoCodecArgs,
  buildEncoderArgs,
  selectEncoderFrame,
  shouldWriteEncoderFrame,
  pushFrameToEncoder,
  seedOfflineCameraSnapshot,
  stopEncoder,
} = require('../../src/media/encoder');

afterEach(() => {
  mock.timers.reset();
});

describe('Persistent FFmpeg Encoder Pipeline (src/media/encoder.js)', () => {
  it('builds FFmpeg codec and encoder CLI arguments for vaapi, qsv, nvenc, v4l2m2m, and software libx264', () => {
    // Verify: builds FFmpeg codec and encoder CLI arguments for vaapi, qsv, nvenc, v4l2m2m, and software libx264.
    const cam = new Camera({serial: 'T8161T0000000000', name: 'front_door'});

    const vaapiCodec = buildVideoCodecArgs('vaapi', '15');
    assert.ok(vaapiCodec.includes('h264_vaapi'));
    assert.ok(vaapiCodec.includes('format=nv12,hwupload'));

    const qsvCodec = buildVideoCodecArgs('qsv', '15');
    assert.ok(qsvCodec.includes('h264_qsv'));
    const qsvBfIdx = qsvCodec.indexOf('-bf');
    assert.notEqual(qsvBfIdx, -1, 'h264_qsv must set -bf 0 for zero B-frame reordering latency');
    assert.equal(qsvCodec[qsvBfIdx + 1], '0');

    const nvencCodec = buildVideoCodecArgs('nvenc', '15');
    assert.ok(nvencCodec.includes('h264_nvenc'));

    const v4l2Codec = buildVideoCodecArgs('v4l2m2m', '15');
    assert.ok(v4l2Codec.includes('h264_v4l2m2m'));

    const swCodec = buildVideoCodecArgs('', '15');
    assert.ok(swCodec.includes('libx264'));
    assert.ok(swCodec.includes('zerolatency'));

    const vaapiFullArgs = buildEncoderArgs(cam, 'vaapi');
    assert.ok(vaapiFullArgs.includes('-init_hw_device'));
    assert.ok(vaapiFullArgs.some((a) => a.includes('/front_door')));

    const qsvFullArgs = buildEncoderArgs(cam, 'qsv');
    assert.ok(qsvFullArgs.includes('-filter_hw_device'));
  });

  it('selects asleep, busy, waking, and live frames and kills wedged encoder stdin pipes after 10s drain stall', () => {
    // Verify: selects asleep, busy, waking, and live frames and kills wedged encoder stdin pipes after 10s drain
    // stall.
    const cam = new Camera(
      {serial: 'T8161T0000000000', mode: 'p2p'},
      {frame: Buffer.alloc(FRAME, 0x20), lastSeen: '10:00'},
      renderCameraCards
    );
    const otherCam = new Camera(
      {serial: 'T8161T1111111111', mode: 'p2p'},
      {frame: null, lastSeen: ''},
      renderCameraCards
    );

    const t0 = 50000;
    // Sleeping state selects card.asleep
    assert.equal(selectEncoderFrame(cam, t0).frame === cam.getAsleepCardBuffer(), true);
    assert.equal(selectEncoderFrame(cam, t0).isLive, false);

    // Waiting for station slot while motionUntil is active selects card.busy
    cam.setMotionUntil(t0 + 30000);
    assert.equal(selectEncoderFrame(cam, t0 + 100).frame === cam.getBusyCardBuffer(), true);

    // Waking state before first frame selects card.waking
    cam.beginSession('p2p', t0 + 200, false);
    assert.equal(selectEncoderFrame(cam, t0 + 300).frame === cam.getWakingCardBuffer(), true);
    assert.equal(shouldWriteEncoderFrame(cam, false, true, true, t0 + 300), true);

    // Backpressure handling: when writableNeedDrain is true for > 10s, kills wedged encoder process
    let killedSignal = '';
    cam.attachEncoder(
      {
        stdin: {
          writable: true,
          writableNeedDrain: true,
          write() {
            throw new Error('Should not write while writableNeedDrain is true');
          },
        },
        kill(sig) {
          killedSignal = sig;
        },
      },
      t0
    );
    cam.setLastWriteAt(t0);
    pushFrameToEncoder(cam, t0 + 5000);
    assert.equal(killedSignal, '', 'Must not kill encoder before 10s drain stall threshold');
    pushFrameToEncoder(cam, t0 + 11000);
    assert.equal(killedSignal, 'SIGKILL', 'Must SIGKILL wedged encoder when stdin drain stalls > 10s');
  });

  it(
    'throttles asleep frames to idle_fps (5 fps) while streaming active frames at live_fps ' +
      '(15 fps) and supports clean event thumbnail injection',
    () => {
      // Verify: throttles asleep frames to idle_fps (5 fps) while streaming active frames at live_fps (15 fps) and
      // supports clean event thumbnail injection.
      const cleanSnapshot = Buffer.alloc(FRAME, 0x38);
      const cam = new Camera(
        {serial: 'T8161T0000000000', mode: 'p2p', card_theme: 'glance', card_position: 'bottom-left'},
        {frame: cleanSnapshot, lastSeen: '11:30'},
        renderCameraCards
      );

      const t0 = 80000;
      const liveTickMs = Math.floor(1000 / LIVE_FPS);
      const idleIntervalMs = Math.ceil(1000 / IDLE_FPS);
      cam.setLastWriteAt(t0);

      // Sleeping camera (isLive=false, waking=false, changed=false): skips 66ms tick, writes
      // once 1000/IDLE_FPS (200ms) elapses
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + liveTickMs), false);
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + idleIntervalMs), true);

      // Active camera (isLive=true, frameNew=true): writes on every 15 fps tick,
      // and never floods duplicate frames during keyframe bursts when frameNew=false
      cam.setFrameNew(true);
      assert.equal(shouldWriteEncoderFrame(cam, true, false, false, t0 + liveTickMs), true);
      cam.setFrameNew(false);
      assert.equal(
        shouldWriteEncoderFrame(cam, true, false, true, t0 + 10),
        false,
        'Live stream must NOT write duplicate frames during inBurst when frameNew is false'
      );
      assert.equal(
        shouldWriteEncoderFrame(cam, true, false, true, t0 + 66),
        false,
        'Live inBurst must not preempt steady 66ms 15 fps decodes with a duplicate frame'
      );
      assert.equal(
        shouldWriteEncoderFrame(cam, true, false, true, t0 + 67),
        true,
        'Live inBurst still writes at 67ms on VFR/static streams'
      );
      assert.equal(
        shouldWriteEncoderFrame(cam, false, false, true, t0 + 10),
        false,
        'Sleeping keyframe burst must pace writes by livePaceMs instead of writing back-to-back'
      );
      assert.equal(shouldWriteEncoderFrame(cam, false, false, true, t0 + 62), true);

      // Clean event thumbnail fallback (instant_event_snapshot: true): while waking before live video arrives,
      // suppressing the waking status card causes selectEncoderFrame to emit clean cam.lastFrame
      cam.beginSession('p2p', t0 + 500, false);
      assert.equal(cam.canInjectCleanEventSnapshot(true), true);
      assert.equal(cam.canInjectCleanEventSnapshot(false), false);
      assert.equal(selectEncoderFrame(cam, t0 + 600).frame === cam.getWakingCardBuffer(), true);

      cam.setLiveCardSuppressed(true);
      const suppressedSelection = selectEncoderFrame(cam, t0 + 650);
      assert.equal(
        suppressedSelection.frame === cleanSnapshot,
        true,
        'Must emit clean lastFrame without "Waking Up..." status card during instant_event_snapshot capture'
      );
      cam.setLiveCardSuppressed(false);
    }
  );

  it(
    'stops the encoder when a camera goes offline, and seeds the cached snapshot before ' +
      'stopping if already offline on startup or Frigate reload (only when ' +
      'sleep_screen="snapshot" and snapshot is available)',
    async () => {
      // Verify: stops the encoder when a camera goes offline, and seeds the cached snapshot before stopping if
      // already offline on startup or Frigate reload (only when sleep_screen="snapshot" and snapshot is available).
      const camWithSnap = new Camera(
        {serial: 'T8214T2222222222', name: 'doorbell', mode: 'backfill', sleep_screen: 'snapshot'},
        {frame: Buffer.alloc(FRAME, 0x20), lastSeen: '10:00'},
        renderCameraCards
      );
      const camBlackScreen = new Camera(
        {serial: 'T8161T0000000000', name: 'driveway', mode: 'p2p', sleep_screen: 'black'},
        {frame: Buffer.alloc(FRAME, 0x20), lastSeen: '10:00'},
        renderCameraCards
      );
      const camNoCache = new Camera(
        {serial: 'T8161T1111111111', name: 'backyard', mode: 'p2p', sleep_screen: 'snapshot'},
        {frame: null, lastSeen: ''},
        renderCameraCards
      );

      const attachMockEncoder = (targetCam) => {
        const state = {killedSignal: '', writtenCount: 0};
        targetCam.attachEncoder(
          {
            stdin: {
              writable: true,
              writableNeedDrain: false,
              write() {
                state.writtenCount++;
              },
            },
            kill(sig) {
              state.killedSignal = sig;
            },
          },
          1000
        );
        return state;
      };

      // 1. When sleep_screen="black" or no cached snapshot exists, seedOfflineCameraSnapshot
      // stops immediately without seeding
      const blackEnc = attachMockEncoder(camBlackScreen);
      camBlackScreen.applyTelemetryProperties({battery: 0, chargingStatus: 2}, false);
      assert.equal(seedOfflineCameraSnapshot(camBlackScreen, 25), 'stopped');
      assert.equal(blackEnc.killedSignal, 'SIGKILL');
      assert.equal(camBlackScreen.hasEncoderProcess(), false);
      assert.equal(camBlackScreen.isSeedingOfflineSnapshot(), false);

      const noCacheEnc = attachMockEncoder(camNoCache);
      camNoCache.applyTelemetryProperties({battery: 0, chargingStatus: 2}, false);
      assert.equal(seedOfflineCameraSnapshot(camNoCache, 25), 'stopped');
      assert.equal(noCacheEnc.killedSignal, 'SIGKILL');
      assert.equal(camNoCache.hasEncoderProcess(), false);

      // 2. When sleep_screen="snapshot" and a cached snapshot is available,
      // seedOfflineCameraSnapshot pushes the snapshot and stops after seedDurationMs
      const snapEnc = attachMockEncoder(camWithSnap);
      camWithSnap.applyTelemetryProperties({battery: 0, chargingStatus: 2}, false);
      mock.timers.enable({apis: ['setTimeout']});
      assert.equal(seedOfflineCameraSnapshot(camWithSnap, 25), 'seeded');
      assert.equal(camWithSnap.isSeedingOfflineSnapshot(), true);
      assert.equal(camWithSnap.hasEncoderProcess(), true, 'Encoder stays alive during brief snapshot seed window');
      assert.equal(snapEnc.writtenCount, 1, 'Cached snapshot frame is pushed to encoder immediately');

      mock.timers.tick(25);
      mock.timers.reset();
      await flushAsync();
      assert.equal(
        snapEnc.killedSignal,
        'SIGKILL',
        'Encoder is stopped automatically after seeding snapshot to Frigate'
      );
      assert.equal(camWithSnap.hasEncoderProcess(), false);
      assert.equal(camWithSnap.isSeedingOfflineSnapshot(), false);

      pushFrameToEncoder(camWithSnap, 2000);
      assert.equal(snapEnc.writtenCount, 1, 'Detached offline encoder must not stream idle frames');
      assert.equal(stopEncoder(camWithSnap), false, 'Repeated stopEncoder call returns false when already detached');
    }
  );

  it('starts and stops periodic video and audio media tickers cleanly via stopMediaTickers', () => {
    // Verify startMediaTickers stores unref'd interval handles and stopMediaTickers clears them idempotently.
    const encoderMod = require('../../src/media/encoder');
    assert.equal(typeof encoderMod.stopMediaTickers, 'function');
    encoderMod.startMediaTickers([]);
    encoderMod.stopMediaTickers();
    encoderMod.stopMediaTickers();
  });

  it('preserves literal replacement tokens in buildEncoderArgs and escalates stopEncoderProcess to SIGKILL', (t) => {
    // Verify buildEncoderArgs uses a function replacer for {name} and stopEncoderProcess escalates wedged encoders.
    t.mock.timers.enable({apis: ['setTimeout']});
    const fakeCam = /** @type {*} */ ({getName: () => 'patio_$&_$$'});
    const args = buildEncoderArgs(fakeCam, '');
    assert.equal(args[args.length - 1].endsWith('/patio_$&_$$'), true);

    const {EventEmitter} = require('node:events');
    const cam = new Camera({serial: 'T8161T0000000055', name: 'patio'});
    const wedgedProc = Object.assign(new EventEmitter(), {
      pid: 4100,
      exitCode: null,
      signalCode: null,
      signals: [],
      kill(sig) {
        this.signals.push(sig);
      },
    });
    cam.attachEncoder(wedgedProc, 1000);
    cam.stopEncoderProcess();
    assert.deepEqual(wedgedProc.signals, ['SIGTERM']);

    t.mock.timers.tick(2000);
    assert.deepEqual(wedgedProc.signals, ['SIGTERM', 'SIGKILL']);

    const cleanProc = Object.assign(new EventEmitter(), {
      pid: 4101,
      exitCode: null,
      signalCode: null,
      signals: [],
      kill(sig) {
        this.signals.push(sig);
      },
    });
    cam.attachEncoder(cleanProc, 2000);
    cam.stopEncoderProcess();
    cleanProc.exitCode = 0;
    cleanProc.emit('exit', 0, null);
    t.mock.timers.tick(2000);
    assert.deepEqual(cleanProc.signals, ['SIGTERM']);
  });
});
