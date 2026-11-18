/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Enterprise unit test suite for media & cache pipelines: encoder, decoder, and snapshot-cache.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_TMP_DIR = path.resolve(__dirname, '..', '.tmp');
const TEST_CACHE_DIR = path.join(TEST_TMP_DIR, 'cache');
fs.mkdirSync(TEST_CACHE_DIR, {recursive: true});
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.BRIDGE_LOG_LEVEL = 'error';
process.env.TMPDIR = TEST_TMP_DIR;
process.env.BRIDGE_CACHE_DIR = TEST_CACHE_DIR;

const {FRAME, CACHE_DIR, IDLE_FPS, LIVE_FPS} = require('../src/config');
const {log} = require('../src/logger');
const {DOWNLOAD_FRAME_HIGH_WATERMARK, DOWNLOAD_FRAME_LOW_WATERMARK, Camera} = require('../src/domain/camera');
const {renderCameraCards} = require('../src/overlay/card-renderer');
const {
  buildDecodeJpegArgs,
  buildEncodeJpegArgs,
  getCacheFilePath,
  migrateLegacyDuplicateCacheFile,
  loadCachedFrame,
  saveCachedFrame,
} = require('../src/overlay/snapshot-cache');
const {
  FfmpegArgsBuilder,
  configureEncoderHooks,
  buildVideoCodecArgs,
  buildEncoderArgs,
  selectEncoderFrame,
  shouldWriteEncoderFrame,
  pushFrameToEncoder,
  stopEncoder,
  seedOfflineCameraSnapshot,
  startEncoder,
} = require('../src/media/encoder');
const {extractBlurredRegion} = require('../src/overlay/yuv-canvas');
const {
  configureDecoderHooks,
  setDecoderStopHandler,
  setRtspDropHandler,
  buildScaleFilter,
  buildP2pDecoderArgs,
  buildRtspDecoderArgs,
  findNalHeaderOffset,
  isKeyPacket,
  attachDecoderStreams,
  handleDecodedP2pFrame,
  handleDecodedRtspFrame,
  handleP2pDecoderExit,
  appendAudioPcmChunk,
  startRtspDecoder,
  flushDecoderInput,
  stopDecoder,
  onVideo,
  onAudio,
} = require('../src/media/decoder');

describe('Persistent FFmpeg Encoder Pipeline (src/media/encoder.js)', () => {
  it('builds FFmpeg codec and encoder CLI arguments for vaapi, qsv, nvenc, v4l2m2m, and software libx264', () => {
    const cam = new Camera({serial: 'T8161T0000000000', name: 'front_door'});

    const vaapiCodec = buildVideoCodecArgs('vaapi', '15');
    assert.ok(vaapiCodec.includes('h264_vaapi'));
    assert.ok(vaapiCodec.includes('format=nv12,hwupload'));

    const qsvCodec = buildVideoCodecArgs('qsv', '15');
    assert.ok(qsvCodec.includes('h264_qsv'));

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
    assert.equal(selectEncoderFrame(cam, t0).frame === cam.card.asleep, true);
    assert.equal(selectEncoderFrame(cam, t0).isLive, false);

    // Waiting for station slot while motionUntil is active selects card.busy
    cam.motionUntil = t0 + 30000;
    assert.equal(selectEncoderFrame(cam, t0 + 100).frame === cam.card.busy, true);

    // Waking state before first frame selects card.waking
    cam.beginSession('p2p', t0 + 200, false);
    assert.equal(selectEncoderFrame(cam, t0 + 300).frame === cam.card.waking, true);
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
    cam.lastWrite = t0;
    pushFrameToEncoder(cam, t0 + 5000);
    assert.equal(killedSignal, '', 'Must not kill encoder before 10s drain stall threshold');
    pushFrameToEncoder(cam, t0 + 11000);
    assert.equal(killedSignal, 'SIGKILL', 'Must SIGKILL wedged encoder when stdin drain stalls > 10s');
  });

  it(
    'throttles asleep frames to idle_fps (5 fps) while streaming active frames at live_fps ' +
      '(15 fps) and supports clean event thumbnail injection',
    () => {
      const cleanSnapshot = Buffer.alloc(FRAME, 0x38);
      const cam = new Camera(
        {serial: 'T8161T0000000000', mode: 'p2p', card_theme: 'glance', card_position: 'bottom-left'},
        {frame: cleanSnapshot, lastSeen: '11:30'},
        renderCameraCards
      );

      const t0 = 80000;
      const liveTickMs = Math.floor(1000 / LIVE_FPS);
      const idleIntervalMs = Math.ceil(1000 / IDLE_FPS);
      cam.lastWrite = t0;

      // Sleeping camera (isLive=false, waking=false, changed=false): skips 66ms tick, writes
      // once 1000/IDLE_FPS (200ms) elapses
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + liveTickMs), false);
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + idleIntervalMs), true);

      // Active camera (isLive=true, frameNew=true): writes on every 15 fps tick,
      // and never floods duplicate frames during keyframe bursts when frameNew=false
      cam.frameNew = true;
      assert.equal(shouldWriteEncoderFrame(cam, true, false, false, t0 + liveTickMs), true);
      cam.frameNew = false;
      assert.equal(
        shouldWriteEncoderFrame(cam, true, false, true, t0 + 10),
        false,
        'Live stream must NOT write duplicate frames during inBurst when frameNew is false'
      );

      // Clean event thumbnail fallback (instant_event_snapshot: true): while waking before live video arrives,
      // suppressing the waking status card causes selectEncoderFrame to emit clean cam.lastFrame
      cam.beginSession('p2p', t0 + 500, false);
      assert.equal(cam.canInjectCleanEventSnapshot(true), true);
      assert.equal(cam.canInjectCleanEventSnapshot(false), false);
      assert.equal(selectEncoderFrame(cam, t0 + 600).frame === cam.card.waking, true);

      cam.card.suppressLiveCard = true;
      const suppressedSelection = selectEncoderFrame(cam, t0 + 650);
      assert.equal(
        suppressedSelection.frame === cleanSnapshot,
        true,
        'Must emit clean lastFrame without "Waking Up..." status card during instant_event_snapshot capture'
      );
      cam.card.suppressLiveCard = false;
    }
  );

  it(
    'stops the encoder when a camera goes offline, and seeds the cached snapshot before ' +
      'stopping if already offline on startup or Frigate reload (only when ' +
      'sleep_screen="snapshot" and snapshot is available)',
    async () => {
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
      assert.equal(seedOfflineCameraSnapshot(camWithSnap, 25), 'seeded');
      assert.equal(camWithSnap.isSeedingOfflineSnapshot(), true);
      assert.equal(camWithSnap.hasEncoderProcess(), true, 'Encoder stays alive during brief snapshot seed window');
      assert.equal(snapEnc.writtenCount, 1, 'Cached snapshot frame is pushed to encoder immediately');

      await new Promise((resolve) => setTimeout(resolve, 40));
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
});

describe('FFmpeg P2P/RTSP Decoder & Annex-B NAL Parser (src/media/decoder.js)', () => {
  it('builds aspect-preserving or exact-fill scale filters and P2P/RTSP decoder CLI arguments', () => {
    const paddedScale = buildScaleFilter(true);
    assert.ok(paddedScale.includes('force_original_aspect_ratio=decrease'));
    assert.ok(paddedScale.includes('pad='));

    const fillScale = buildScaleFilter(false);
    assert.ok(!fillScale.includes('pad='));

    const p2pArgs = buildP2pDecoderArgs('hevc', paddedScale);
    assert.ok(p2pArgs.includes('hevc'));
    assert.ok(p2pArgs.includes('pipe:0'));
    assert.ok(
      p2pArgs.includes('+genpts') && !p2pArgs.includes('+genpts+nobuffer'),
      'Decoder must use -fflags +genpts without +nobuffer so avformat_find_stream_info never discards Frame 0'
    );
    assert.equal(
      p2pArgs.includes('-use_wallclock_as_timestamps'),
      false,
      'P2P/backfill decoder must never stamp burst-transferred packets with wall-clock arrival timestamps'
    );
    assert.ok(
      p2pArgs.includes('1024'),
      'P2P audio pipe:3 must use a 1024-byte probesize so initial AAC frames decode without buffering delay'
    );
    assert.ok(
      p2pArgs.includes('asetpts=N/(SR*10)/TB') && !p2pArgs.includes('aresample=async=1:first_pts=0'),
      'P2P decoder audio pipe must assign monotonic sample-counted PTS via ' +
        'asetpts=N/(SR*10)/TB without dropping samples'
    );

    const rtspArgs = buildRtspDecoderArgs('rtsp://192.168.1.50/live0', fillScale);
    assert.ok(rtspArgs.includes('rtsp://192.168.1.50/live0'));
    assert.ok(rtspArgs.includes('-rtsp_transport'));
    const rtspFragArgs = buildRtspDecoderArgs('rtsp://user:pa#ss@192.0.2.10/live0#backchannel=0', fillScale);
    assert.ok(
      rtspFragArgs.includes('rtsp://user:pa#ss@192.0.2.10/live0'),
      'buildRtspDecoderArgs must strip URI #fragment suffixes (such as #backchannel=0) while ' +
        'preserving # in credentials'
    );
    assert.ok(
      rtspArgs.includes('asetpts=N/(SR*10)/TB') && !rtspArgs.includes('aresample=async=1:first_pts=0'),
      'RTSP decoder audio pipe must sanitize non-monotonic RTP audio timestamps via ' +
        'asetpts=N/(SR*10)/TB without dropping samples'
    );
    assert.ok(
      rtspArgs.includes('5000000'),
      'RTSP pull decoder must use a 5s (5000000us) socket timeout to tolerate brief weak-Wi-Fi retransmission jitter'
    );
  });

  it('detects H.264 SPS (NAL=7) and H.265 VPS/SPS (NAL=32/33) across 3-byte and 4-byte Annex-B start codes', () => {
    const nonStartBuf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    assert.equal(findNalHeaderOffset(nonStartBuf, 0), -1);

    // 3-byte start code (00 00 01) + H.264 SPS (NAL type 7 -> 0x67 & 0x1f === 7)
    const h264Sps3Byte = Buffer.from([0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]);
    assert.equal(findNalHeaderOffset(h264Sps3Byte, 0), 3);
    assert.equal(isKeyPacket(h264Sps3Byte, 'H264'), true);
    assert.equal(isKeyPacket(h264Sps3Byte, 'H265'), false);

    // 4-byte start code (00 00 00 01) + H.264 non-IDR slice (NAL type 1 -> 0x41 & 0x1f === 1)
    const h264PFrame = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x24, 0x6c]);
    assert.equal(findNalHeaderOffset(h264PFrame, 0), 4);
    assert.equal(isKeyPacket(h264PFrame, 'H264'), false);

    // 4-byte start code + H.265 VPS (NAL type 32 -> (0x40 >> 1) & 0x3f === 32)
    const hevcVps4Byte = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0c, 0x01]);
    assert.equal(isKeyPacket(hevcVps4Byte, 'H265'), true);
    assert.equal(isKeyPacket(hevcVps4Byte, 'H264'), false);

    // 3-byte start code + H.265 SPS (NAL type 33 -> (0x42 >> 1) & 0x3f === 33)
    const hevcSps3Byte = Buffer.from([0x00, 0x00, 0x01, 0x42, 0x01, 0x01, 0x01]);
    assert.equal(isKeyPacket(hevcSps3Byte, 'HEVC'), true);
  });

  it('routes decoded P2P/backfill and RTSP frames, flushes decoder pipes on EOF, and completes startup probes', () => {
    const cam = new Camera(
      {serial: 'T8214T2222222222', mode: 'backfill'},
      {frame: null, lastSeen: ''},
      renderCameraCards
    );

    const t0 = 100000;
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo',
        cipherId: 0,
        clipMs: t0 - 20000,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      },
      false,
      t0
    );

    const frame0 = Buffer.alloc(FRAME, 0x61);
    const frame1 = Buffer.alloc(FRAME, 0x62);

    // Frame 0 in download mode is committed immediately to cam.frame; Frame 1 is buffered into downloadFrames
    handleDecodedP2pFrame(cam, frame0, t0 + 100);
    assert.ok(cam.frame);
    assert.equal(cam.frame[0], 0x61);
    assert.equal(cam.downloadFrames.length, 0);

    handleDecodedP2pFrame(cam, frame1, t0 + 120);
    assert.equal(cam.frame[0], 0x61, 'Frame 0 remains current until encoder advances at 15 fps');
    assert.equal(cam.downloadFrames.length, 1);
    assert.equal(cam.downloadFrames[0][0], 0x62);

    // Audio PCM chunk buffering and flushDecoderInput on EOF
    appendAudioPcmChunk(cam, Buffer.alloc(6400, 0x01));
    assert.equal(cam.pcmLen, 6400);

    let stdinEnded = false;
    let audioEnded = false;
    let audioWritten = 0;
    cam.attachDecoder({
      stdin: {
        writable: true,
        end() {
          stdinEnded = true;
        },
      },
      stdio: [
        null,
        null,
        null,
        {
          writable: true,
          write(buf) {
            audioWritten += buf.length;
          },
          end() {
            audioEnded = true;
          },
        },
      ],
    });
    onAudio(cam, {buffer: Buffer.from([1, 2, 3, 4])});
    assert.equal(audioWritten, 4);
    flushDecoderInput(cam);
    assert.equal(stdinEnded, true);
    assert.equal(audioEnded, true);

    // RTSP frame decoding + P2P startup snapshot probe auto-stop callback
    const rtspCam = new Camera(
      {serial: 'T8161T0000000000', mode: 'rtsp'},
      {frame: null, lastSeen: ''},
      renderCameraCards
    );
    rtspCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://10.0.0.1/live0');
    rtspCam.beginSession('rtsp', t0, false);
    handleDecodedRtspFrame(rtspCam, Buffer.alloc(FRAME, 0x70), t0 + 500, rtspCam.sessionId);
    assert.equal(rtspCam.gotVideo, true);
    assert.equal(rtspCam.frame[0], 0x70);

    const probeCam = new Camera(
      {serial: 'T8161T1111111111', mode: 'p2p'},
      {frame: null, lastSeen: ''},
      renderCameraCards
    );
    let stoppedReason = '';
    setDecoderStopHandler((c, reason) => {
      stoppedReason = reason;
    });
    probeCam.beginSession('p2p', t0, false);
    probeCam.startStartupProbe();
    handleDecodedP2pFrame(probeCam, Buffer.alloc(FRAME, 0x71), t0 + 500);
    assert.equal(stoppedReason, '', 'Probe waits until 2s (STARTUP_PROBE_CAPTURE_MS) of video is captured');
    handleDecodedP2pFrame(probeCam, Buffer.alloc(FRAME, 0x72), t0 + 2600);
    assert.equal(stoppedReason, 'startup snapshot captured after 2s stable video');
    setDecoderStopHandler(null);
  });

  it('builds deterministic JPEG snapshot cache paths and FFmpeg decode/encode CLI arguments', () => {
    // Verify cache paths keep last_<name>_<serial>.jpg when name !== serial, collapse to last_<name>.jpg when
    // serial === name, and migrate legacy last_<name>_<name>.jpg files in place
    const cam = new Camera({serial: 'T8161T0000000000', name: 'front_yard'});
    const cachePath = getCacheFilePath(cam);
    assert.equal(cachePath, path.join(CACHE_DIR, 'last_front_yard_T8161T0000000000.jpg'));

    const serialOnlyCam = new Camera({serial: 'T8161T0000000000'});
    assert.equal(getCacheFilePath(serialOnlyCam), path.join(CACHE_DIR, 'last_T8161T0000000000.jpg'));

    const directCam = new Camera({name: 'nursery_cam', rtsp_url: 'rtsp://192.0.2.10/live0'});
    assert.equal(getCacheFilePath(directCam), path.join(CACHE_DIR, 'last_nursery_cam.jpg'));

    const migDir = fs.mkdtempSync(path.join(CACHE_DIR, 'mig-'));
    try {
      const legacyDup = path.join(migDir, 'last_nursery_cam_nursery_cam.jpg');
      const dedupTarget = path.join(migDir, 'last_nursery_cam.jpg');
      fs.writeFileSync(legacyDup, 'jpeg-bytes-1');
      migrateLegacyDuplicateCacheFile(directCam, migDir);
      assert.equal(fs.existsSync(legacyDup), false);
      assert.equal(fs.readFileSync(dedupTarget, 'utf8'), 'jpeg-bytes-1');

      // When the deduplicated file already exists, any leftover duplicate file is removed cleanly
      fs.writeFileSync(dedupTarget, 'jpeg-bytes-fresh');
      fs.writeFileSync(legacyDup, 'jpeg-bytes-stale');
      migrateLegacyDuplicateCacheFile(directCam, migDir);
      assert.equal(fs.existsSync(legacyDup), false);
      assert.equal(fs.readFileSync(dedupTarget, 'utf8'), 'jpeg-bytes-fresh');
    } finally {
      fs.rmSync(migDir, {recursive: true, force: true});
    }

    const decArgs = buildDecodeJpegArgs(cachePath);
    assert.ok(decArgs.includes(cachePath));
    assert.ok(decArgs.includes('rawvideo'));

    const encArgs = buildEncodeJpegArgs(cachePath);
    assert.ok(encArgs.includes('-q:v'));
    assert.ok(encArgs.includes(cachePath));
  });

  it(
    'bounds backfill memory by pausing decoder stdout at DOWNLOAD_FRAME_HIGH_WATERMARK and ' +
      'resuming at DOWNLOAD_FRAME_LOW_WATERMARK',
    () => {
      assert.equal(DOWNLOAD_FRAME_HIGH_WATERMARK, 30);
      assert.equal(DOWNLOAD_FRAME_LOW_WATERMARK, 10);

      const cam = new Camera(
        {serial: 'T8214T2222222222', mode: 'backfill'},
        {frame: null, lastSeen: ''},
        renderCameraCards
      );
      cam.attachEncoder(
        {
          stdin: {
            writable: true,
            writableNeedDrain: false,
            write() {},
          },
        },
        1000
      );

      const t0 = 10000;
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo',
          cipherId: 0,
          clipMs: t0 - 30000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0
      );

      let pauseCount = 0;
      let resumeCount = 0;
      let stdinWriteCount = 0;
      let stdinEnded = false;
      let audioEnded = false;
      cam.attachDecoder({
        stdin: {
          writable: true,
          writableNeedDrain: false,
          write() {
            stdinWriteCount++;
          },
          end() {
            stdinEnded = true;
          },
        },
        stdout: {
          pause() {
            pauseCount++;
          },
          resume() {
            resumeCount++;
          },
        },
        stdio: [
          null,
          null,
          null,
          {
            writable: true,
            writableNeedDrain: false,
            write() {},
            end() {
              audioEnded = true;
            },
          },
        ],
      });

      const reusableRaw = Buffer.alloc(FRAME, 0x42);
      // Frame 0 commits immediately to cam.frame
      handleDecodedP2pFrame(cam, reusableRaw, t0 + 100);
      assert.equal(cam.downloadFrames.length, 0);
      assert.equal(pauseCount, 0);

      // Push frames 1 .. HIGH_WATERMARK (30) into downloadFrames
      for (let i = 1; i <= DOWNLOAD_FRAME_HIGH_WATERMARK; i++) {
        handleDecodedP2pFrame(cam, reusableRaw, t0 + 100 + i);
        if (i < DOWNLOAD_FRAME_HIGH_WATERMARK) {
          assert.equal(pauseCount, 0, 'Must not pause before reaching DOWNLOAD_FRAME_HIGH_WATERMARK');
        }
      }
      assert.equal(cam.downloadFrames.length, DOWNLOAD_FRAME_HIGH_WATERMARK);
      assert.equal(pauseCount, 1, 'Must pause decoder.stdout at DOWNLOAD_FRAME_HIGH_WATERMARK (30 frames)');
      assert.equal(cam.decoderStdoutPaused, true);

      // While decoder.stdout is paused, incoming compressed H.264 packets queue in cam.pendingVideoPackets
      // instead of overflowing FFmpeg stdin, and flushDecoderInput defers stdin.end() until drained
      const h264Packet1 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x01]);
      const h264Packet2 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x02]);
      onVideo(cam, {buffer: h264Packet1, metadata: {videoCodec: 'H264', videoWidth: 1280, videoHeight: 720}});
      onVideo(cam, {buffer: h264Packet2, metadata: {videoCodec: 'H264', videoWidth: 1280, videoHeight: 720}});
      assert.equal(
        cam.pendingVideoPackets.length,
        2,
        'Compressed H.264 packets must queue in RAM while decoder stdout is paused'
      );
      assert.equal(stdinWriteCount, 0);

      flushDecoderInput(cam);
      assert.equal(
        stdinEnded,
        false,
        'Must not end dec.stdin while compressed packets are still queued in pendingVideoPackets'
      );
      assert.equal(
        audioEnded,
        true,
        'Must end dec.stdio[3] (audio pipe) immediately on EOF when pendingAudioPackets is empty ' +
          'so FFmpeg never deadlocks waiting for audio while video packets are still queued'
      );

      // Drain frames at 15 fps after Frame 0 warmup down to LOW_WATERMARK + 1 (11 frames) -> still paused
      let tTick = t0 + 3200;
      while (cam.downloadFrames.length > DOWNLOAD_FRAME_LOW_WATERMARK + 1) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      assert.equal(cam.downloadFrames.length, DOWNLOAD_FRAME_LOW_WATERMARK + 1);
      assert.equal(resumeCount, 0, 'Must remain paused above DOWNLOAD_FRAME_LOW_WATERMARK');
      assert.equal(cam.pendingVideoPackets.length, 2);

      // Next 15 fps tick drains to DOWNLOAD_FRAME_LOW_WATERMARK (10 frames) -> resumes decoder.stdout,
      // drains pendingVideoPackets into dec.stdin, and closes dec.stdin for EOF flush
      tTick += 67;
      pushFrameToEncoder(cam, tTick);
      assert.equal(cam.downloadFrames.length, DOWNLOAD_FRAME_LOW_WATERMARK);
      assert.equal(resumeCount, 1, 'Must resume decoder.stdout at DOWNLOAD_FRAME_LOW_WATERMARK (10 frames)');
      assert.equal(cam.decoderStdoutPaused, false);
      assert.equal(
        cam.pendingVideoPackets.length,
        0,
        'Queued compressed H.264 packets must drain into dec.stdin on resume'
      );
      assert.equal(stdinWriteCount, 2);
      assert.equal(stdinEnded, true, 'dec.stdin.end() must fire once all queued compressed packets have drained');

      // If FFmpeg child process emits "exit" while dec.stdout is paused at HIGH_WATERMARK with tail frames
      // still buffered in stdout, handleP2pDecoderExit must NOT detach cam.dec until stdout emits "close"
      let stdoutCloseCb = null;
      const exitDec = {
        stdin: {writable: false, end() {}},
        stdout: {
          readableEnded: false,
          closed: false,
          readableLength: FRAME * 2,
          pause() {
            pauseCount++;
          },
          resume() {
            resumeCount++;
          },
          once(ev, fn) {
            if (ev === 'close') {
              stdoutCloseCb = fn;
            }
          },
          on(ev, fn) {
            if (ev === 'close') {
              stdoutCloseCb = fn;
            }
          },
        },
        stdio: [null, null, null, null],
      };
      cam.attachDecoder(exitDec);
      while (cam.downloadFrames.length < DOWNLOAD_FRAME_HIGH_WATERMARK) {
        handleDecodedP2pFrame(cam, reusableRaw, tTick + 10);
      }
      assert.equal(cam.decoderStdoutPaused, true);
      handleP2pDecoderExit(cam, exitDec, cam.getSessionId(), 0);
      assert.equal(
        cam.hasDecoderProcess(),
        true,
        'Must keep cam.dec attached when process exits while stdout is still paused with unread tail frames'
      );
      while (cam.downloadFrames.length > DOWNLOAD_FRAME_LOW_WATERMARK) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      assert.equal(
        cam.decoderStdoutPaused,
        false,
        'Draining to LOW_WATERMARK must resume stdout even after process exit'
      );
      handleDecodedP2pFrame(cam, reusableRaw, tTick + 20);
      if (stdoutCloseCb) {
        stdoutCloseCb();
      }
      assert.equal(cam.hasDecoderProcess(), false, 'Detaches cam.dec once stdout emits close');
    }
  );

  it(
    'paces backfill playback at 15 fps without slow-motion stalls when encoder stdin emits ' +
      'drain events or unaligned ticks fire',
    () => {
      const cam = new Camera(
        {serial: 'T8214T2222222222', mode: 'backfill', card_show_on_live: false},
        {frame: null, lastSeen: ''},
        renderCameraCards
      );

      const encodedBytes = [];
      const encoderStdin = {
        writable: true,
        writableNeedDrain: false,
        write(buf) {
          encodedBytes.push(buf[0]);
          this.writableNeedDrain = true;
          return false;
        },
      };
      const t0 = 50000;
      cam.attachEncoder({stdin: encoderStdin}, t0);

      cam.beginBackfillDownload(
        {
          storagePath: '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo',
          cipherId: 0,
          clipMs: t0 - 20000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0
      );

      const rawBuf = Buffer.alloc(FRAME, 0);
      // Decode 6 distinct backfill frames (0x10 .. 0x15)
      for (let i = 0; i < 6; i++) {
        rawBuf.fill(0x10 + i);
        handleDecodedP2pFrame(cam, rawBuf, t0 + 100 + i);
      }

      // Frame 0 (0x10) was committed and written immediately at t0 + 100; Frames 1..5 are queued
      assert.deepEqual(encodedBytes, [0x10]);
      assert.equal(cam.downloadFrames.length, 5);
      assert.equal(cam.lastWrite, t0 + 100);
      assert.equal(
        cam.isInKeyframeBurst(t0 + 105),
        false,
        'Backfill frame writes must not trigger a 1,200ms keyframe burst that forces duplicate writes on drain'
      );

      // 10ms later (t0 + 110), FFmpeg finishes reading Frame 0 from enc.stdin and emits "drain"
      encoderStdin.writableNeedDrain = false;
      assert.equal(
        cam.shouldDrainEncoderOnReady(t0 + 110, 62),
        false,
        'shouldDrainEncoderOnReady must return false 10ms after a write when the next backfill ' +
          'frame is not due yet (< 62ms)'
      );

      // Even if an unaligned setInterval ticker calls pushFrameToEncoder 20ms after Frame 0 (t0 + 120),
      // it must NOT re-write Frame 0 or reset cam.lastWrite
      pushFrameToEncoder(cam, t0 + 120);
      assert.deepEqual(encodedBytes, [0x10]);
      assert.equal(cam.lastWrite, t0 + 100, 'Unaligned early tick must not reset lastWrite');

      // Now simulate five 15 fps ticks (every 67ms) after the 3100ms Frame 0 warmup window,
      // each followed 10ms later by an enc.stdin "drain" event
      let tTick = t0 + 100 + 3100 - 67;
      for (let step = 1; step <= 5; step++) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
        assert.equal(
          encodedBytes.length,
          step + 1,
          'Each 67ms tick must advance and encode the next backfill frame without slow-motion freeze'
        );
        assert.equal(encodedBytes[step], 0x10 + step);
        assert.equal(cam.lastWrite, tTick);

        // 10ms after each frame write, enc.stdin drains
        encoderStdin.writableNeedDrain = false;
        if (cam.shouldDrainEncoderOnReady(tTick + 10, 62)) {
          pushFrameToEncoder(cam, tTick + 10);
        }
        assert.equal(
          encodedBytes.length,
          step + 1,
          'enc.stdin drain 10ms after frame write must not re-encode the same frame or reset lastWrite'
        );
        assert.equal(cam.lastWrite, tTick);
      }
      assert.equal(cam.downloadFrames.length, 0);

      // Verify decoder stdin drain and audio EOF coordination when pendingVideoPackets and
      // pendingAudioPackets are queued
      let decVideoWrites = 0;
      let decAudioWrites = 0;
      let decVideoEnded = false;
      let decAudioEnded = false;
      const decStdin = {
        writable: true,
        writableNeedDrain: false,
        write() {
          decVideoWrites++;
          this.writableNeedDrain = true;
          return false;
        },
        end() {
          decVideoEnded = true;
        },
      };
      const decAudioPipe = {
        writable: true,
        writableNeedDrain: false,
        write() {
          decAudioWrites++;
          return true;
        },
        end() {
          decAudioEnded = true;
        },
      };
      cam.attachDecoder({
        stdin: decStdin,
        stdout: {pause() {}, resume() {}},
        stdio: [null, null, null, decAudioPipe],
      });
      cam.pauseDecoderStdout();
      cam.enqueueOrWriteVideoPacket(Buffer.from([1, 2, 3]), true);
      cam.enqueueOrWriteVideoPacket(Buffer.from([4, 5, 6]), true);
      cam.enqueueOrWriteAudioPacket(Buffer.from([7, 8]), true);
      assert.equal(
        decAudioWrites,
        1,
        'Compressed AAC audio packets must write directly to pipe:3 even while video stdout ' +
          '(pipe:1) is paused for backpressure'
      );
      assert.equal(cam.pendingAudioPackets.length, 0);
      cam.markDecoderInputEnded(true);

      // Effective event duration and markDownloadFinished account for both downloadFrames and
      // compressed pendingVideoPackets
      cam.downloadFrames = Array.from({length: 30}, () => Buffer.alloc(10));
      cam.pendingVideoPackets = Array.from({length: 120}, () => Buffer.from([1]));
      assert.equal(
        cam.getEffectiveEventDurationSecs(15),
        Math.max(cam.timers.eventSecs, Math.ceil((30 + 120 + 1) / 15)) + 6
      );
      assert.equal(
        cam.markDownloadFinished(tTick + 50),
        150,
        'markDownloadFinished must include both decoded downloadFrames and compressed pendingVideoPackets'
      );
      renderCameraCards(cam);
      assert.equal(
        cam.isInKeyframeBurst(tTick + 60),
        false,
        'Re-rendering cards during backfill playback must not trigger a keyframe burst'
      );
      cam.downloadFrames = [];
      cam.pendingVideoPackets = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])];

      cam.resumeDecoderStdout();
      assert.equal(
        cam.decoderState,
        'decoding',
        'Resuming at low watermark while compressed packets remain in pendingVideoPackets must ' +
          'stay in decoding state until stdin.end()'
      );
      assert.equal(decVideoWrites, 1, 'First video packet writes until decStdin.writableNeedDrain becomes true');
      assert.equal(decAudioWrites, 1, 'Audio packet writes to pipe:3');
      assert.equal(
        decAudioEnded,
        true,
        'Must close audio pipe:3 immediately once pendingAudioPackets is empty so FFmpeg does not ' +
          'block waiting on pipe:3 while video packets remain queued'
      );
      assert.equal(decVideoEnded, false, 'Video stdin remains open until all pendingVideoPackets drain');

      // Even if decoderStdoutPaused becomes true again from buffered stdout frames, dec.stdin
      // "drain" must continue draining pendingVideoPackets
      cam.pauseDecoderStdout();
      decStdin.writableNeedDrain = false;
      cam.drainPendingDecoderInput(true, true);
      assert.equal(decVideoWrites, 2, 'dec.stdin drain callback must drain remaining video packet');
      assert.equal(decVideoEnded, true, 'Both video and audio pipes close once all pending packets have drained');
      assert.equal(decAudioEnded, true);
      cam.resumeDecoderStdout();
      assert.equal(
        cam.decoderState,
        'flushing_eof',
        'Once all pending compressed packets have drained and stdin ended, resuming transitions to flushing_eof'
      );
    }
  );

  it(
    'eliminates per-frame heap allocations via FfmpegArgsBuilder, StatusCard buffer reuse, ' +
      'liveFrameRing, downloadFramePool, and O(1) audio consumption',
    () => {
      // 1. Fluent FfmpegArgsBuilder produces frozen CLI arrays
      assert.ok(FfmpegArgsBuilder);
      const customArgs = new FfmpegArgsBuilder()
        .hideBanner('error')
        .flag('-an')
        .option('-f', 'rawvideo')
        .output('pipe:1')
        .build();
      assert.ok(Object.isFrozen(customArgs));
      assert.deepEqual(customArgs, ['-hide_banner', '-loglevel', 'error', '-an', '-f', 'rawvideo', 'pipe:1']);

      const cam = new Camera(
        {serial: 'T8161T0000000000', name: 'front_door', card_theme: 'glance'},
        {frame: Buffer.alloc(FRAME, 0x20), lastSeen: '12:00'},
        renderCameraCards
      );
      assert.ok(Object.isFrozen(buildEncoderArgs(cam)));
      assert.ok(Object.isFrozen(buildP2pDecoderArgs('h264', 'none')));

      // 2. StatusCard buffer reuse: re-rendering telemetry cards mutates existing 1.38 MB buffers in-place
      const asleepBufBefore = cam.card.asleep;
      const wakingBufBefore = cam.card.waking;
      const busyBufBefore = cam.card.busy;
      cam.telemetry.applyProperties({battery: 75, wifiRssi: -62});
      renderCameraCards(cam);
      assert.equal(
        cam.card.asleep,
        asleepBufBefore,
        'Must reuse pre-allocated card.asleep buffer across telemetry renders'
      );
      assert.equal(
        cam.card.waking,
        wakingBufBefore,
        'Must reuse pre-allocated card.waking buffer across telemetry renders'
      );
      assert.equal(cam.card.busy, busyBufBefore, 'Must reuse pre-allocated card.busy buffer across telemetry renders');

      // 3. extractBlurredRegion reuses scratch buffer view without heap allocation
      const blurView1 = extractBlurredRegion(cam.card.asleep, 24, 24, 200, 44);
      const blurView2 = extractBlurredRegion(cam.card.asleep, 24, 24, 200, 44);
      assert.equal(
        blurView1.buffer,
        blurView2.buffer,
        'extractBlurredRegion must reuse underlying scratch ArrayBuffer'
      );

      // 4. Live P2P/RTSP decoding alternates between 2 pre-allocated liveFrameRing slots (zero Buffer.from per frame)
      cam.beginSession('p2p', 1000, false);
      const rawScratch = Buffer.alloc(FRAME, 0x31);
      handleDecodedP2pFrame(cam, rawScratch, 1100);
      const firstSlot = cam.frame;
      rawScratch.fill(0x32);
      handleDecodedP2pFrame(cam, rawScratch, 1166);
      const secondSlot = cam.frame;
      assert.notEqual(
        firstSlot,
        secondSlot,
        'Two consecutive frames use distinct ring slots so lastFrame and frame never alias'
      );
      assert.equal(cam.lastFrame, firstSlot);
      assert.equal(
        cam.lastFrame[0],
        0x31,
        'lastFrame retains previous frame contents when next frame overwrites other ring slot'
      );
      rawScratch.fill(0x33);
      handleDecodedP2pFrame(cam, rawScratch, 1233);
      assert.equal(cam.frame, firstSlot, 'Third frame wraps around to reuse first ring slot');

      // 5. Backfill download recycles buffers via downloadFramePool and frees pool on endSession
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/clip.zxvideo',
          cipherId: 0,
          clipMs: 500,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        2000
      );
      handleDecodedP2pFrame(cam, rawScratch, 2100); // Frame 0
      cam.markFrameEncoded(cam.frame, 2100);
      handleDecodedP2pFrame(cam, rawScratch, 2110); // Frame 1 (queued in downloadFrames)
      const queuedBuf = cam.downloadFrames[0];
      const consumedBuf = cam.consumeNextDownloadFrame(2200, 62, '12:01');
      assert.ok(consumedBuf === queuedBuf, 'consumeNextDownloadFrame must advance to queued Frame 1');
      handleDecodedP2pFrame(cam, rawScratch, 2210); // Frame 2 (Consumed Frame 0 is now recycled into pool)
      handleDecodedP2pFrame(cam, rawScratch, 2220); // Frame 3
      assert.ok(cam.downloadFramePool.length <= DOWNLOAD_FRAME_HIGH_WATERMARK + 2);
      cam.endSession(3000);
      assert.equal(cam.downloadFramePool.length, 0, 'endSession must release pooled backfill buffers back to GC');

      // 6. Preserve Whole Object: startRtspDecoder accepts only (cam) and queries cam.getRtspUrl() internally
      const {startRtspDecoder} = require('../src/media/decoder');
      assert.equal(
        startRtspDecoder.length,
        1,
        'startRtspDecoder must accept only (cam) and read cam.getRtspUrl() internally'
      );

      // 7. Pre-decoder AAC packet queueing & backfill Frame 0 audio lockstep
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/clip_audio.zxvideo',
          cipherId: 0,
          clipMs: 600,
          event: 'ring',
          personName: '',
          reason: 'ring',
        },
        false,
        4000
      );
      const earlyAacPkt = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc]);
      assert.equal(
        cam.enqueueOrWriteAudioPacket(earlyAacPkt, true),
        true,
        'Must queue early AAC packets arriving while p2pReady before first video keyframe spawns decoder'
      );
      assert.equal(cam.pendingAudioPackets.length, 1);

      const writtenAudioPkts = [];
      const mockAudioPipe = {
        writable: true,
        writableNeedDrain: false,
        write(chunk) {
          writtenAudioPkts.push(chunk);
          return true;
        },
        end() {},
      };
      const mockStdin = {
        writable: true,
        writableNeedDrain: false,
        write() {
          return true;
        },
        end() {},
      };
      cam.attachDecoder({
        stdin: mockStdin,
        stdout: {pause() {}, resume() {}},
        stdio: [null, null, null, mockAudioPipe],
      });
      cam.drainPendingDecoderInput(true);
      assert.equal(cam.pendingAudioPackets.length, 0);
      assert.equal(writtenAudioPkts.length, 1);
      assert.equal(writtenAudioPkts[0], earlyAacPkt);

      const silenceBuf = Buffer.alloc(3200, 0);
      const pcmPayload = Buffer.alloc(3200, 0x55);
      cam.appendAudioChunk(pcmPayload, 32000, 320000);
      assert.equal(cam.sessionState, 'handshaking_backfill');
      assert.equal(
        cam.consumeAudioChunk(3200, silenceBuf),
        silenceBuf,
        'Must hold buffered backfill PCM audio and emit silence while handshaking before Frame 0 is decoded'
      );
      assert.equal(cam.pcmLen, 3200, 'Buffered PCM audio must remain intact until Frame 0 is decoded');

      handleDecodedP2pFrame(cam, rawScratch, 4100); // Frame 0 decoded -> playing_backfill
      assert.equal(cam.sessionState, 'playing_backfill');
      assert.equal(
        cam.consumeAudioChunk(3200, silenceBuf),
        pcmPayload,
        'Must consume buffered PCM audio in lockstep immediately once Frame 0 is decoded'
      );

      cam.appendAudioChunk(pcmPayload, 32000, 320000);
      cam.endSession(5000);
      assert.equal(cam.pcmLen, 0, 'endSession must clear residual PCM audio');
      assert.equal(cam.pcm.length, 0);

      // 8. Live RTSP/P2P multi-frame TCP burst buffering & 15 fps pacing without dropping intermediate frames
      const liveCam = new Camera(
        {serial: 'T8161T0000000000', name: 'garage', mode: 'rtsp', card_show_on_live: false},
        {frame: null, lastSeen: ''},
        renderCameraCards
      );
      const liveEncodedBytes = [];
      const liveEncoderStdin = {
        writable: true,
        writableNeedDrain: false,
        write(buf) {
          liveEncodedBytes.push(buf[0]);
          this.writableNeedDrain = true;
          return false;
        },
      };
      const tLive = 200000;
      liveCam.attachEncoder({stdin: liveEncoderStdin}, tLive);
      liveCam.beginSession('rtsp', tLive, true);

      // Simulate a 4-frame TCP read burst (0x41, 0x42, 0x43, 0x44) arriving within 3ms
      for (let i = 0; i < 4; i++) {
        rawScratch.fill(0x41 + i);
        handleDecodedRtspFrame(liveCam, rawScratch, tLive + 100 + i, liveCam.getSessionId());
      }

      assert.deepEqual(
        liveEncodedBytes,
        [0x41],
        'Frame 0 of a live TCP burst encodes immediately while Frames 1..3 queue in liveFrames'
      );
      assert.equal(
        liveCam.liveFrames.length,
        3,
        'Must queue all 3 trailing frames of the TCP burst in liveFrames without overwriting or dropping them'
      );

      // 10ms later, enc.stdin drains, but next frame is not due yet (< 62ms)
      liveEncoderStdin.writableNeedDrain = false;
      assert.equal(liveCam.shouldDrainEncoderOnReady(tLive + 110, 62), false);

      // Drain all 3 queued live burst frames across the next three 15 fps ticks (every 67ms)
      let tLiveTick = tLive + 100;
      for (let step = 1; step <= 3; step++) {
        tLiveTick += 67;
        liveEncoderStdin.writableNeedDrain = false;
        pushFrameToEncoder(liveCam, tLiveTick);
        assert.equal(liveEncodedBytes.length, step + 1);
        assert.equal(liveEncodedBytes[step], 0x41 + step);
      }
      assert.equal(liveCam.liveFrames.length, 0);
    }
  );

  it(
    'caps FFmpeg filtergraph threads, demuxer packet queues, hardware frame pools, and ' + 'software/snapshot threads',
    () => {
      const cam = new Camera({serial: 'T8161T0000000000', name: 'front_door'});

      const vaapiFullArgs = buildEncoderArgs(cam, 'vaapi');
      const filterThreadsIdx = vaapiFullArgs.indexOf('-filter_threads');
      assert.ok(filterThreadsIdx >= 0 && vaapiFullArgs[filterThreadsIdx + 1] === '1');
      const filterComplexIdx = vaapiFullArgs.indexOf('-filter_complex_threads');
      assert.ok(filterComplexIdx >= 0 && vaapiFullArgs[filterComplexIdx + 1] === '1');
      const pipe0Idx = vaapiFullArgs.indexOf('pipe:0');
      const rawQueueIdx = vaapiFullArgs.indexOf('-thread_queue_size');
      assert.ok(rawQueueIdx >= 0 && rawQueueIdx < pipe0Idx && vaapiFullArgs[rawQueueIdx + 1] === '2');

      const vaapiCodec = buildVideoCodecArgs('vaapi', '15');
      const asyncDepthIdx = vaapiCodec.indexOf('-async_depth');
      assert.ok(asyncDepthIdx >= 0 && vaapiCodec[asyncDepthIdx + 1] === '1');

      const qsvCodec = buildVideoCodecArgs('qsv', '15');
      assert.ok(qsvCodec.includes('format=nv12,hwupload=extra_hw_frames=8'));
      assert.ok(qsvCodec.includes('3500k'));

      const swCodec = buildVideoCodecArgs('', '15');
      const swThreadsIdx = swCodec.indexOf('-threads');
      assert.ok(swThreadsIdx >= 0 && swCodec[swThreadsIdx + 1] === '2');
      assert.ok(swCodec.includes('3500k'));

      const p2pArgs = buildP2pDecoderArgs('hevc', buildScaleFilter(true));
      assert.equal(p2pArgs[p2pArgs.indexOf('-filter_threads') + 1], '1');
      assert.equal(p2pArgs[p2pArgs.indexOf('-filter_complex_threads') + 1], '1');
      const p2pThreadsIdx = p2pArgs.indexOf('-threads');
      assert.ok(p2pThreadsIdx >= 0 && p2pThreadsIdx < p2pArgs.indexOf('pipe:0') && p2pArgs[p2pThreadsIdx + 1] === '2');
      assert.equal(p2pArgs[p2pArgs.indexOf('-thread_queue_size') + 1], '16');

      const rtspArgs = buildRtspDecoderArgs('rtsp://192.0.2.20/live0', buildScaleFilter(false));
      assert.equal(rtspArgs[rtspArgs.indexOf('-filter_threads') + 1], '1');
      assert.equal(rtspArgs[rtspArgs.indexOf('-filter_complex_threads') + 1], '1');
      assert.equal(rtspArgs[rtspArgs.indexOf('-probesize') + 1], '524288');
      assert.equal(rtspArgs[rtspArgs.indexOf('-analyzeduration') + 1], '1000000');
      assert.equal(rtspArgs[rtspArgs.indexOf('-thread_queue_size') + 1], '32');
      const rtspThreadsIdx = rtspArgs.indexOf('-threads');
      assert.ok(
        rtspThreadsIdx >= 0 &&
          rtspThreadsIdx < rtspArgs.indexOf('rtsp://192.0.2.20/live0') &&
          rtspArgs[rtspThreadsIdx + 1] === '2'
      );

      const snapFixturePath = path.join(TEST_CACHE_DIR, 'snap.jpg');
      const decodeJpegArgs = buildDecodeJpegArgs(snapFixturePath);
      assert.equal(decodeJpegArgs[decodeJpegArgs.indexOf('-threads') + 1], '1');
      assert.equal(decodeJpegArgs[decodeJpegArgs.indexOf('-filter_threads') + 1], '1');

      const encodeJpegArgs = buildEncodeJpegArgs(snapFixturePath);
      assert.equal(encodeJpegArgs[encodeJpegArgs.indexOf('-threads') + 1], '1');
      assert.equal(encodeJpegArgs[encodeJpegArgs.indexOf('-filter_threads') + 1], '1');
    }
  );

  it(
    'reuses a single per-camera decoder stdout assembly buffer across restarts and ignores ' + 'stale exiting decoders',
    () => {
      const {EventEmitter} = require('node:events');
      assert.equal(typeof attachDecoderStreams, 'function');

      const cam = new Camera({serial: 'T8161T0000000000', name: 'nursery_cam', mode: 'rtsp'});
      assert.equal(cam.decoderReadBuf, null, 'decoderReadBuf must stay unallocated until a decoder spawns');

      const makeMockDecoder = () => ({
        stdout: Object.assign(new EventEmitter(), {
          readableEnded: false,
          closed: false,
          readableLength: 0,
          pause() {},
          resume() {},
        }),
        stderr: new EventEmitter(),
        stdio: [null, null, null, null, new EventEmitter()],
      });

      cam.beginSession('rtsp', 1000, true);
      const session1 = cam.getSessionId();
      const dec1 = makeMockDecoder();
      cam.attachDecoder(dec1, 1000);
      const seenBuffers = [];
      attachDecoderStreams(cam, dec1, session1, (buf) => {
        seenBuffers.push({buf, byte0: buf[0]});
      });
      assert.ok(Buffer.isBuffer(cam.decoderReadBuf) && cam.decoderReadBuf.length === FRAME);
      const sharedReadBuf = cam.decoderReadBuf;

      dec1.stdout.emit('data', Buffer.alloc(FRAME, 0x21));
      assert.equal(seenBuffers.length, 1);
      assert.equal(seenBuffers[0].buf, sharedReadBuf);
      assert.equal(seenBuffers[0].byte0, 0x21);

      // Replace dec1 with dec2: stale dec1 stdout data must not touch sharedReadBuf, and dec1
      // exit must not resume paused dec2
      const dec2 = makeMockDecoder();
      cam.attachDecoder(dec2, 2000);
      attachDecoderStreams(cam, dec2, session1, (buf) => {
        seenBuffers.push({buf, byte0: buf[0]});
      });
      assert.equal(cam.decoderReadBuf, sharedReadBuf, 'Second decoder must reuse the existing 1.38 MB decoderReadBuf');

      // Emit half a frame on dec2 (0x44), then trailing stale chunk on dec1 (0x99), then remaining half on dec2 (0x44)
      const halfFrame = FRAME / 2;
      dec2.stdout.emit('data', Buffer.alloc(halfFrame, 0x44));
      dec1.stdout.emit('data', Buffer.alloc(FRAME, 0x99));
      dec2.stdout.emit('data', Buffer.alloc(halfFrame, 0x44));
      assert.equal(seenBuffers.length, 2);
      assert.equal(seenBuffers[1].buf, sharedReadBuf);
      assert.equal(
        seenBuffers[1].byte0,
        0x44,
        'Stale exited decoder stdout chunks must never corrupt active decoderReadBuf'
      );
      assert.equal(sharedReadBuf[FRAME - 1], 0x44);

      // Pause dec2 for backpressure, then trigger late exit of stale dec1
      cam.pauseDecoderStdout();
      assert.equal(cam.decoderStdoutPaused, true);
      handleP2pDecoderExit(cam, dec1, session1, 0, () => '');
      assert.equal(
        cam.decoderStdoutPaused,
        true,
        'Stale decoder exit must not call resumeDecoderStdout() on the newly attached paused decoder'
      );
      assert.equal(cam.dec, dec2);
    }
  );

  it('lazy-allocates StatusCard waking, busy, liveOverlayBufs, and Camera liveFrameRing only when first needed', () => {
    const cam = new Camera(
      {serial: 'T8161T0000000000', name: 'standby_cam', mode: 'backfill', card_theme: 'glance'},
      {frame: Buffer.alloc(FRAME, 0x18), lastSeen: '09:00'},
      renderCameraCards
    );

    // At startup, only card.asleep is allocated; waking, busy, liveOverlayBufs, and liveFrameRing are all null
    assert.ok(Buffer.isBuffer(cam.card.asleep) && cam.card.asleep.length === FRAME);
    assert.equal(cam.card.peekWakingBuffer(), null);
    assert.equal(cam.card.peekBusyBuffer(), null);
    assert.equal(cam.card.liveOverlayBufs, null);
    assert.equal(cam.liveFrameRing, null);

    // Telemetry card refreshes while idle keep waking & busy unallocated
    cam.telemetry.applyProperties({battery: 88, wifiRssi: -58});
    renderCameraCards(cam);
    assert.equal(cam.card.peekWakingBuffer(), null);
    assert.equal(cam.card.peekBusyBuffer(), null);

    // Entering waiting state lazily allocates & renders card.busy once, then reuses it in-place
    cam.motionUntil = 60000;
    const selectedBusy = selectEncoderFrame(cam, 1000).frame;
    assert.ok(Buffer.isBuffer(cam.card.peekBusyBuffer()) && cam.card.peekBusyBuffer().length === FRAME);
    assert.equal(selectedBusy, cam.card.busy);
    assert.equal(cam.card.peekWakingBuffer(), null, 'Reading card.busy must not allocate card.waking');

    const busyBeforeUpdate = cam.card.busy;
    cam.telemetry.applyProperties({battery: 42});
    renderCameraCards(cam);
    assert.equal(
      cam.card.busy,
      busyBeforeUpdate,
      'Allocated card.busy buffer must be reused in-place on subsequent renders'
    );

    // Backfill download playback uses downloadFramePool and keeps liveFrameRing unallocated
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/lazy_clip.zxvideo',
        cipherId: 0,
        clipMs: 1200,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
      },
      false,
      2000
    );
    handleDecodedP2pFrame(cam, Buffer.alloc(FRAME, 0x30), 2100);
    assert.equal(cam.liveFrameRing, null, 'Backfill playback must not allocate liveFrameRing');
    cam.endSession(3000);

    // Live overlay scratch buffers stay null until prepareLiveOverlayBuffer is called
    assert.equal(cam.card.liveOverlayBufs, null);
    const overlayOut = cam.card.prepareLiveOverlayBuffer(Buffer.alloc(FRAME, 0x25));
    assert.ok(Array.isArray(cam.card.liveOverlayBufs) && cam.card.liveOverlayBufs.length === 2);
    assert.equal(overlayOut.length, FRAME);

    // Live P2P/RTSP decoding lazily initializes liveFrameRing
    cam.beginSession('p2p', 4000, true);
    handleDecodedP2pFrame(cam, Buffer.alloc(FRAME, 0x35), 4100);
    assert.ok(Array.isArray(cam.liveFrameRing) && cam.liveFrameRing.length === 2);
  });

  it(
    'detaches encoder and decoders and schedules backoff retries when FFmpeg fails to spawn ' + 'without emitting exit',
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
          rtspCam.decSpawnedAt,
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
    'paces live keyframe bursts at 15 fps for fast MSE attach, drains due liveFrames on decode ' +
      'without drift lag, and caps >15 fps RTSP inputs (Regression #27)',
    () => {
      // Regression: (1) shouldWriteEncoderFrame ignored inBurst when isLive=true, delaying
      // H.264 -g 15 keyframes up to 7.5s on VFR/night streams when Frigate Grid View attached
      // MSE; (2) handleDecodedRtspFrame/handleDecodedP2pFrame did not flush due frames when
      // buffering into liveFrames, causing 66.67ms (15 fps) streams to drift behind
      // setInterval(67ms) up to 12 frames (800ms lag + head drops); (3) buildRtspDecoderArgs
      // lacked a non-duplicating VFR 15 fps cap for 20-30 fps cameras.
      const burstCam = new Camera(
        {serial: 'T8161T9900000027', name: 'nursery_grid', mode: 'rtsp', card_show_on_live: false},
        {frame: Buffer.alloc(FRAME, 0x22), lastSeen: '21:00'},
        renderCameraCards
      );
      const t0 = 500000;
      burstCam.lastWrite = t0;
      burstCam.frameNew = false;

      assert.equal(
        shouldWriteEncoderFrame(burstCam, true, false, true, t0 + 10),
        false,
        'Live keyframe burst must still block sub-frame duplicate floods 10ms after lastWrite'
      );
      assert.equal(
        shouldWriteEncoderFrame(burstCam, true, false, true, t0 + 67),
        true,
        'Live keyframe burst must write at 15 fps cadence (>=62ms) even when frameNew is false ' +
          'so MSE receives an IDR keyframe within 1s'
      );
      assert.equal(
        shouldWriteEncoderFrame(burstCam, true, false, false, t0 + 67),
        false,
        'Outside keyframe burst, static/VFR live streams with frameNew=false must remain ' +
          'throttled to heartbeat interval'
      );

      // Continuous 15.00 fps (66ms) RTSP decode after a 2-frame Wi-Fi jitter pair must drain due frames immediately
      // on frame arrival instead of accumulating a 12-frame (800ms) backlog behind setInterval(67ms).
      const encodedFirstBytes = [];
      const mockStdin = {
        writable: true,
        writableNeedDrain: false,
        write(buf) {
          encodedFirstBytes.push(buf[0]);
          return true;
        },
      };
      burstCam.attachEncoder({stdin: mockStdin}, t0);
      burstCam.beginSession('rtsp', t0, true);
      const scratch = Buffer.alloc(FRAME, 0x51);
      const sid = burstCam.getSessionId();

      // Frame A and Frame B arrive 2ms apart -> A encodes immediately, B queues in liveFrames (length=1)
      handleDecodedRtspFrame(burstCam, scratch, t0 + 100, sid);
      scratch.fill(0x52);
      handleDecodedRtspFrame(burstCam, scratch, t0 + 102, sid);
      assert.deepEqual(encodedFirstBytes, [0x51]);
      assert.equal(burstCam.liveFrames.length, 1);

      // Steady 15 fps frames arrive every 66ms before setInterval(67ms) ticks -> each arrival
      // drains the due frame so queue stays at 1!
      let now = t0 + 100;
      for (let i = 0; i < 20; i++) {
        now += 66;
        scratch.fill(0x60 + i);
        handleDecodedRtspFrame(burstCam, scratch, now, sid);
        assert.equal(
          burstCam.liveFrames.length,
          1,
          'Continuous 15 fps RTSP stream must drain due frame on decode instead of drifting ' +
            'up to MAX_LIVE_BURST_FRAMES (12)'
        );
      }
      assert.equal(encodedFirstBytes.length, 21);
      burstCam.endSession(now + 100, true, false, 'rtsp');

      // Verify RTSP decoder -vf prepends a non-duplicating select= VFR cap at LIVE_FPS (15 fps) ahead of scale=
      const scale = buildScaleFilter(false);
      const rtspArgs = buildRtspDecoderArgs('rtsp://127.0.0.1:8554/nursery', scale);
      const vfIdx = rtspArgs.indexOf('-vf');
      assert.notEqual(vfIdx, -1);
      const vfVal = rtspArgs[vfIdx + 1];
      assert.equal(
        vfVal.startsWith("select='if(isnan(t),1,") && vfVal.includes('1/' + LIVE_FPS) && vfVal.endsWith(',' + scale),
        true,
        'RTSP decoder -vf must prepend non-duplicating select VFR framerate cap ahead of scale filter'
      );
      assert.equal(
        vfVal.includes('fps='),
        false,
        'RTSP decoder must not use duplicating fps= filter that adds 1-frame lookahead ' +
          'latency and duplicates 10 fps IR night frames'
      );
    }
  );

  it('redacts URL credentials in FFmpeg stderr tail summaries for decoder and encoder logs', () => {
    const EventEmitter = require('node:events');
    const mockProc = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    const collector = FfmpegArgsBuilder.attachStderrTailCollector(mockProc);
    mockProc.stderr.emit('data', Buffer.from('Opening rtsp://admin:s3cr@t@192.168.1.50:554/live0\r\n'));
    mockProc.stderr.emit('data', Buffer.from('Connection refused from rtsp://u:pw@10.0.0.5:8554/cam'));

    const summary = collector.getSummary();
    const lastLine = collector.getLastLine();
    assert.equal(summary.includes('s3cr@t'), false);
    assert.equal(summary.includes('pw@10'), false);
    assert.equal(summary.includes('rtsp://***@192.168.1.50:554/live0'), true);
    assert.equal(summary.includes('rtsp://***@10.0.0.5:8554/cam'), true);
    assert.equal(lastLine, 'Connection refused from rtsp://***@10.0.0.5:8554/cam');
  });

  it('defers backfill decoder detach on exit until flowing stdout closes so tail frames are not dropped', () => {
    // Regression: when FFmpeg exits at EOF while dec.stdout is in flowing mode (!decoderStdoutPaused &&
    // readableLength === 0), handleP2pDecoderExit must wait for dec.stdout "close" before detaching cam.dec
    // so tail frames arriving from the OS pipe between process "exit" and stdout "close" are decoded.
    const EventEmitter = require('node:events');
    const cam = new Camera({serial: 'T8214T7777777771', name: 'tail_drain_cam', mode: 'backfill'});
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/tail_test.zxvideo',
        cipherId: 1,
        clipMs: 10000,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
      },
      false,
      20000
    );
    const sid = cam.getSessionId();
    const stdoutEmitter = Object.assign(new EventEmitter(), {
      readableEnded: false,
      closed: false,
      readableLength: 0,
      pause() {},
      resume() {},
    });
    const mockDec = {
      stdin: {writable: false, end() {}},
      stdout: stdoutEmitter,
      stderr: new EventEmitter(),
      stdio: [null, stdoutEmitter, null, null, null],
    };
    cam.attachDecoder(mockDec);
    const decodedCount = [];
    attachDecoderStreams(cam, /** @type {*} */ (mockDec), sid, (frameBuf, now) => {
      handleDecodedP2pFrame(cam, frameBuf, now);
      decodedCount.push(frameBuf[0]);
    });

    const frame0 = Buffer.alloc(FRAME, 0xaa);
    stdoutEmitter.emit('data', frame0);
    assert.equal(decodedCount.length, 1);
    assert.equal(cam.decoderStdoutPaused, false);

    // FFmpeg process exits while final frame is still in the OS pipe (readableLength === 0 in flowing mode)
    handleP2pDecoderExit(cam, mockDec, sid, 0);
    assert.equal(
      cam.hasDecoderProcess(),
      true,
      'Must keep cam.dec attached until flowing dec.stdout emits close so tail frames are not discarded'
    );

    const finalTailFrame = Buffer.alloc(FRAME, 0xbb);
    stdoutEmitter.emit('data', finalTailFrame);
    assert.equal(decodedCount.length, 2, 'Tail frame arriving after process exit but before stdout close must decode');
    assert.equal(cam.downloadFrames.length, 1);

    stdoutEmitter.closed = true;
    stdoutEmitter.emit('close');
    assert.equal(cam.hasDecoderProcess(), false, 'Detaches cam.dec once dec.stdout emits close');
  });

  it(
    'preserves root-cause FFmpeg stderr lines instead of overriding with FFmpeg 7/8 exit footers ' +
      'or truncating at 500 chars',
    (t) => {
      // Regression: FFmpeg 7/8 appends generic "Error opening input file ...", "Error opening input files: ...",
      // and "Conversion failed!" footers after protocol/muxer root-cause lines, STDERR_TAIL_MAX_CHARS=500 truncated
      // multi-line bursts, and snapshot-cache hid decode/save FFmpeg root causes.
      const EventEmitter = require('node:events');
      const childProcess = require('node:child_process');

      // 1. >600-char RTSP DESCRIBE failure burst with FFmpeg 7/8 exit footers and embedded credentials
      const mockProc = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      const collector = FfmpegArgsBuilder.attachStderrTailCollector(mockProc);
      const longPass = 's3cr3t_password_padding_' + 'x'.repeat(220);
      mockProc.stderr.emit(
        'data',
        Buffer.from(
          '[rtsp @ 0x7fcd8729a980] method DESCRIBE failed: 453 Not Enough Bandwidth\r\n' +
            '[in#0 @ 0x7fcd8729a800] Error opening input: ' +
            'Server returned 4XX Client Error, but not one of 40{0,1,3,4}\r\n' +
            'Error opening input file rtsp://admin:' +
            longPass +
            '@192.0.2.50:554/live0.\r\n' +
            'Error opening input files: Server returned 4XX Client Error, but not one of 40{0,1,3,4}\r\n'
        )
      );

      assert.equal(collector.getLastLine().includes('method DESCRIBE failed: 453 Not Enough Bandwidth'), true);
      assert.equal(collector.getLastLine().includes('Error opening input files:'), false);
      assert.equal(collector.getSummary().includes('method DESCRIBE failed: 453 Not Enough Bandwidth'), true);
      assert.equal(collector.getSummary().includes('Error opening input files:'), false);
      assert.equal(collector.getSummary().includes('s3cr3t_password_padding_'), false);

      // 2. Multi-line RTSP handshake failure in startRtspDecoder before gotVideo preserves all root-cause lines
      const directCam = new Camera({
        name: 'nursery_direct_cam',
        mode: 'rtsp',
        rtsp_url: 'rtsp://viewer:pw@192.0.2.55:554/live0',
      });
      directCam.beginRtspDirectProbeSession(10000);
      const spawnedProcs = [];
      const dropEvents = [];
      configureDecoderHooks({
        spawn: /** @type {*} */ (
          () => {
            const p = Object.assign(new EventEmitter(), {
              pid: 4242,
              stdout: new EventEmitter(),
              stderr: new EventEmitter(),
              stdio: [null, new EventEmitter(), new EventEmitter(), null, new EventEmitter()],
              kill() {},
            });
            spawnedProcs.push(p);
            return p;
          }
        ),
      });
      setRtspDropHandler((cam, code, reasonText) => {
        dropEvents.push({cam, code, reasonText});
      });
      try {
        startRtspDecoder(directCam);
        assert.equal(spawnedProcs.length, 1);
        spawnedProcs[0].stderr.emit(
          'data',
          Buffer.from(
            '[rtsp @ 0x7f11] Nonmatching transport in server reply\n' +
              '[rtsp @ 0x7f11] method SETUP failed: 461 Unsupported Transport\n' +
              '[in#0 @ 0x7f00] Error opening input: Invalid data found when processing input\n' +
              'Error opening input file rtsp://viewer:pw@192.0.2.55:554/live0.\n' +
              'Error opening input files: Invalid data found when processing input\n'
          )
        );
        spawnedProcs[0].emit('exit', 1);

        assert.equal(dropEvents.length, 1);
        assert.equal(dropEvents[0].reasonText.includes('Nonmatching transport in server reply'), true);
        assert.equal(dropEvents[0].reasonText.includes('method SETUP failed: 461 Unsupported Transport'), true);
        assert.equal(dropEvents[0].reasonText.includes('Error opening input files:'), false);
      } finally {
        configureDecoderHooks({spawn: null});
        setRtspDropHandler(null);
      }

      // 3. Snapshot cache decode & save failures preserve real FFmpeg / OS error instead of "Conversion failed!"
      const snapCam = new Camera({serial: 'T8161T0000009991', name: 'snap_diag_cam'});
      const snapFile = getCacheFilePath(snapCam);
      fs.writeFileSync(snapFile, Buffer.from('corrupt-jpeg'));
      const capturedWarns = [];
      const origWarn = log.warn;
      log.warn = (scope, ...args) => {
        capturedWarns.push(args.join(' '));
      };
      t.mock.method(childProcess, 'spawnSync', (_cmd, args) => {
        const isDecode = Array.isArray(args) && args.includes('rawvideo') && args[args.length - 1] === 'pipe:1';
        if (isDecode) {
          return {
            status: 1,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(
              '[mjpeg @ 0x7f22] No JPEG data found in image\n' +
                '[in#0 @ 0x7f20] Error decodingframes\n' +
                'Conversion failed!\n'
            ),
            error: undefined,
          };
        }
        return {
          status: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(
            "[image2 @ 0x7f33] Could not open file '/config/cache/last_snap_diag_cam.jpg': Read-only file system\n" +
              '[vost#0:0/mjpeg @ 0x7f34] Error submitting a packet to the muxer: Read-only file system\n' +
              '[out#0/image2 @ 0x7f35] Error muxing a packet\n' +
              '[out#0/image2 @ 0x7f35] video:24KiB audio:0KiB subtitle:0KiB other streams:0KiB ' +
              'global headers:0KiB muxing overhead: unknown\n' +
              'Conversion failed!\n'
          ),
          error: undefined,
        };
      });
      try {
        const loaded = loadCachedFrame(snapCam);
        assert.equal(loaded.frame, null);
        assert.equal(
          capturedWarns.some(
            (w) => w.includes('failed to decode cached snapshot') && w.includes('No JPEG data found in image')
          ),
          true,
          'loadCachedFrame must include the underlying FFmpeg decode error'
        );

        capturedWarns.length = 0;
        snapCam.recordDecodedFrame(Buffer.alloc(FRAME, 0x33), Buffer.alloc(FRAME, 0x33), 20000, '10:00');
        saveCachedFrame(snapCam);
        assert.equal(
          capturedWarns.some(
            (w) =>
              w.includes('failed to save cached snapshot:') &&
              w.includes('Read-only file system') &&
              !w.endsWith('Conversion failed!')
          ),
          true,
          'saveCachedFrame must preserve the root-cause mux/open error instead of overriding with Conversion failed!'
        );
      } finally {
        log.warn = origWarn;
        fs.rmSync(snapFile, {force: true});
      }
    }
  );
});
