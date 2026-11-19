/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for P2P/RTSP FFmpeg decoders, Annex-B NAL detection, backpressure watermarks, and zero-allocation
 * frame buffer reuse (src/media/decoder.js, ffmpeg-args.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {Camera, DOWNLOAD_FRAME_HIGH_WATERMARK, DOWNLOAD_FRAME_LOW_WATERMARK} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {extractBlurredRegion} = require('../../src/overlay/yuv-canvas');
const {
  buildScaleFilter,
  buildP2pDecoderArgs,
  buildRtspDecoderArgs,
  findNalHeaderOffset,
  isKeyPacket,
  handleDecodedP2pFrame,
  appendAudioPcmChunk,
  onAudio,
  flushDecoderInput,
  handleDecodedRtspFrame,
  setDecoderStopHandler,
  onVideo,
  handleP2pDecoderExit,
  attachDecoderStreams,
} = require('../../src/media/decoder');
const {pushFrameToEncoder, buildEncoderArgs, selectEncoderFrame} = require('../../src/media/encoder');
const {FfmpegArgsBuilder} = require('../../src/media/ffmpeg-args');

afterEach(() => {
  mock.timers.reset();
});

describe('FFmpeg P2P/RTSP Decoder & Annex-B NAL Parser (src/media/decoder.js)', () => {
  it('builds aspect-preserving or exact-fill scale filters and P2P/RTSP decoder CLI arguments', () => {
    // Verify: builds aspect-preserving or exact-fill scale filters and P2P/RTSP decoder CLI arguments.
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
    // Verify: detects H.264 SPS (NAL=7) and H.265 VPS/SPS (NAL=32/33) across 3-byte and 4-byte Annex-B start codes.
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
    // Verify: routes decoded P2P/backfill and RTSP frames, flushes decoder pipes on EOF, and completes startup probes
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
    assert.ok(cam.getCurrentFrameBuffer());
    assert.equal(cam.getCurrentFrameBuffer()[0], 0x61);
    assert.equal(cam.getBufferedDownloadFrames().length, 0);

    handleDecodedP2pFrame(cam, frame1, t0 + 120);
    assert.equal(cam.getCurrentFrameBuffer()[0], 0x61, 'Frame 0 remains current until encoder advances at 15 fps');
    assert.equal(cam.getBufferedDownloadFrames().length, 1);
    assert.equal(cam.getBufferedDownloadFrames()[0][0], 0x62);

    // Audio PCM chunk buffering and flushDecoderInput on EOF
    appendAudioPcmChunk(cam, Buffer.alloc(6400, 0x01));
    assert.equal(cam.getBufferedAudioBytes(), 6400);

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
    handleDecodedRtspFrame(rtspCam, Buffer.alloc(FRAME, 0x70), t0 + 500, rtspCam.getSessionId());
    assert.equal(rtspCam.hasGotVideo(), true);
    assert.equal(rtspCam.getCurrentFrameBuffer()[0], 0x70);

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

  it(
    'bounds backfill memory by pausing decoder stdout at DOWNLOAD_FRAME_HIGH_WATERMARK and ' +
      'resuming at DOWNLOAD_FRAME_LOW_WATERMARK',
    () => {
      // Verify: bounds backfill memory by pausing decoder stdout at DOWNLOAD_FRAME_HIGH_WATERMARK and resuming at
      // DOWNLOAD_FRAME_LOW_WATERMARK.
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
      assert.equal(cam.getBufferedDownloadFrames().length, 0);
      assert.equal(pauseCount, 0);

      // Push frames 1 .. HIGH_WATERMARK (30) into downloadFrames
      for (let i = 1; i <= DOWNLOAD_FRAME_HIGH_WATERMARK; i++) {
        handleDecodedP2pFrame(cam, reusableRaw, t0 + 100 + i);
        if (i < DOWNLOAD_FRAME_HIGH_WATERMARK) {
          assert.equal(pauseCount, 0, 'Must not pause before reaching DOWNLOAD_FRAME_HIGH_WATERMARK');
        }
      }
      assert.equal(cam.getBufferedDownloadFrames().length, DOWNLOAD_FRAME_HIGH_WATERMARK);
      assert.equal(pauseCount, 1, 'Must pause decoder.stdout at DOWNLOAD_FRAME_HIGH_WATERMARK (30 frames)');
      assert.equal(cam.isDecoderStdoutPaused(), true);

      // While decoder.stdout is paused, incoming compressed H.264 packets queue in cam.pendingVideoPackets
      // instead of overflowing FFmpeg stdin, and flushDecoderInput defers stdin.end() until drained
      const h264Packet1 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x01]);
      const h264Packet2 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x02]);
      onVideo(cam, {buffer: h264Packet1, metadata: {videoCodec: 'H264', videoWidth: 1280, videoHeight: 720}});
      onVideo(cam, {buffer: h264Packet2, metadata: {videoCodec: 'H264', videoWidth: 1280, videoHeight: 720}});
      assert.equal(
        cam.getPendingVideoPackets().length,
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
      while (cam.getBufferedDownloadFrames().length > DOWNLOAD_FRAME_LOW_WATERMARK + 1) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      assert.equal(cam.getBufferedDownloadFrames().length, DOWNLOAD_FRAME_LOW_WATERMARK + 1);
      assert.equal(resumeCount, 0, 'Must remain paused above DOWNLOAD_FRAME_LOW_WATERMARK');
      assert.equal(cam.getPendingVideoPackets().length, 2);

      // Next 15 fps tick drains to DOWNLOAD_FRAME_LOW_WATERMARK (10 frames) -> resumes decoder.stdout,
      // drains pendingVideoPackets into dec.stdin, and closes dec.stdin for EOF flush
      tTick += 67;
      pushFrameToEncoder(cam, tTick);
      assert.equal(cam.getBufferedDownloadFrames().length, DOWNLOAD_FRAME_LOW_WATERMARK);
      assert.equal(resumeCount, 1, 'Must resume decoder.stdout at DOWNLOAD_FRAME_LOW_WATERMARK (10 frames)');
      assert.equal(cam.isDecoderStdoutPaused(), false);
      assert.equal(
        cam.getPendingVideoPackets().length,
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
      while (cam.getBufferedDownloadFrames().length < DOWNLOAD_FRAME_HIGH_WATERMARK) {
        handleDecodedP2pFrame(cam, reusableRaw, tTick + 10);
      }
      assert.equal(cam.isDecoderStdoutPaused(), true);
      handleP2pDecoderExit(cam, exitDec, cam.getSessionId(), 0);
      assert.equal(
        cam.hasDecoderProcess(),
        true,
        'Must keep cam.dec attached when process exits while stdout is still paused with unread tail frames'
      );
      while (cam.getBufferedDownloadFrames().length > DOWNLOAD_FRAME_LOW_WATERMARK) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      assert.equal(
        cam.isDecoderStdoutPaused(),
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
      // Verify: paces backfill playback at 15 fps without slow-motion stalls when encoder stdin emits drain events or
      // unaligned ticks fire.
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
      assert.equal(cam.getBufferedDownloadFrames().length, 5);
      assert.equal(cam.getLastWriteAt(), t0 + 100);
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
      assert.equal(cam.getLastWriteAt(), t0 + 100, 'Unaligned early tick must not reset lastWrite');

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
        assert.equal(cam.getLastWriteAt(), tTick);

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
        assert.equal(cam.getLastWriteAt(), tTick);
      }
      assert.equal(cam.getBufferedDownloadFrames().length, 0);

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
      assert.equal(cam.getPendingAudioPackets().length, 0);
      cam.markDecoderInputEnded(true);

      // Effective event duration and markDownloadFinished account for both downloadFrames and
      // compressed pendingVideoPackets
      cam.setBufferedDownloadFrames(Array.from({length: 30}, () => Buffer.alloc(10)));
      cam.setPendingVideoPackets(Array.from({length: 120}, () => Buffer.from([1])));
      assert.equal(
        cam.getEffectiveEventDurationSecs(15),
        Math.max(cam.getTimersConfig().eventSecs, Math.ceil((30 + 120 + 1) / 15)) + 6
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
      cam.setBufferedDownloadFrames([]);
      cam.setPendingVideoPackets([Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])]);

      cam.resumeDecoderStdout();
      assert.equal(
        cam.getDecoderState(),
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
        cam.getDecoderState(),
        'flushing_eof',
        'Once all pending compressed packets have drained and stdin ended, resuming transitions to flushing_eof'
      );
    }
  );

  it(
    'eliminates per-frame heap allocations via FfmpegArgsBuilder, StatusCard buffer reuse, ' +
      'liveFrameRing, downloadFramePool, and O(1) audio consumption',
    () => {
      // Verify: eliminates per-frame heap allocations via FfmpegArgsBuilder, StatusCard buffer reuse, liveFrameRing,
      // downloadFramePool, and O(1) audio consumption.
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
      const asleepBufBefore = cam.getAsleepCardBuffer();
      const wakingBufBefore = cam.getWakingCardBuffer();
      const busyBufBefore = cam.getBusyCardBuffer();
      cam.applyTelemetryProperties({battery: 75, wifiRssi: -62});
      renderCameraCards(cam);
      assert.equal(
        cam.getAsleepCardBuffer(),
        asleepBufBefore,
        'Must reuse pre-allocated card.asleep buffer across telemetry renders'
      );
      assert.equal(
        cam.getWakingCardBuffer(),
        wakingBufBefore,
        'Must reuse pre-allocated card.waking buffer across telemetry renders'
      );
      assert.equal(
        cam.getBusyCardBuffer(),
        busyBufBefore,
        'Must reuse pre-allocated card.busy buffer across telemetry renders'
      );

      // 3. extractBlurredRegion reuses scratch buffer view without heap allocation
      const blurView1 = extractBlurredRegion(cam.getAsleepCardBuffer(), 24, 24, 200, 44);
      const blurView2 = extractBlurredRegion(cam.getAsleepCardBuffer(), 24, 24, 200, 44);
      assert.equal(
        blurView1.buffer,
        blurView2.buffer,
        'extractBlurredRegion must reuse underlying scratch ArrayBuffer'
      );

      // 4. Live P2P/RTSP decoding alternates between 2 pre-allocated liveFrameRing slots (zero Buffer.from per frame)
      cam.beginSession('p2p', 1000, false);
      const rawScratch = Buffer.alloc(FRAME, 0x31);
      handleDecodedP2pFrame(cam, rawScratch, 1100);
      const firstSlot = cam.getCurrentFrameBuffer();
      rawScratch.fill(0x32);
      handleDecodedP2pFrame(cam, rawScratch, 1166);
      const secondSlot = cam.getCurrentFrameBuffer();
      assert.notEqual(
        firstSlot,
        secondSlot,
        'Two consecutive frames use distinct ring slots so lastFrame and frame never alias'
      );
      assert.equal(cam.getLastFrameBuffer(), firstSlot);
      assert.equal(
        cam.getLastFrameBuffer()[0],
        0x31,
        'lastFrame retains previous frame contents when next frame overwrites other ring slot'
      );
      rawScratch.fill(0x33);
      handleDecodedP2pFrame(cam, rawScratch, 1233);
      assert.equal(cam.getCurrentFrameBuffer(), firstSlot, 'Third frame wraps around to reuse first ring slot');

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
      cam.markFrameEncoded(cam.getCurrentFrameBuffer(), 2100);
      handleDecodedP2pFrame(cam, rawScratch, 2110); // Frame 1 (queued in downloadFrames)
      const queuedBuf = cam.getBufferedDownloadFrames()[0];
      const consumedBuf = cam.consumeNextDownloadFrame(2200, 62, '12:01');
      assert.ok(consumedBuf === queuedBuf, 'consumeNextDownloadFrame must advance to queued Frame 1');
      handleDecodedP2pFrame(cam, rawScratch, 2210); // Frame 2 (Consumed Frame 0 is now recycled into pool)
      handleDecodedP2pFrame(cam, rawScratch, 2220); // Frame 3
      assert.ok(cam.getDownloadFramePoolCount() <= DOWNLOAD_FRAME_HIGH_WATERMARK + 2);
      cam.endSession(3000);
      assert.equal(cam.getDownloadFramePoolCount(), 0, 'endSession must release pooled backfill buffers back to GC');

      // 6. Preserve Whole Object: startRtspDecoder accepts only (cam) and queries cam.getRtspUrl() internally
      const {startRtspDecoder} = require('../../src/media/decoder');
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
      assert.equal(cam.getPendingAudioPackets().length, 1);

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
      assert.equal(cam.getPendingAudioPackets().length, 0);
      assert.equal(writtenAudioPkts.length, 1);
      assert.equal(writtenAudioPkts[0], earlyAacPkt);

      const silenceBuf = Buffer.alloc(3200, 0);
      const pcmPayload = Buffer.alloc(3200, 0x55);
      cam.appendAudioChunk(pcmPayload, 32000, 320000);
      assert.equal(cam.getStoredSessionState(), 'handshaking_backfill');
      assert.equal(
        cam.consumeAudioChunk(3200, silenceBuf),
        silenceBuf,
        'Must hold buffered backfill PCM audio and emit silence while handshaking before Frame 0 is decoded'
      );
      assert.equal(cam.getBufferedAudioBytes(), 3200, 'Buffered PCM audio must remain intact until Frame 0 is decoded');

      handleDecodedP2pFrame(cam, rawScratch, 4100); // Frame 0 decoded -> playing_backfill
      assert.equal(cam.getStoredSessionState(), 'playing_backfill');
      assert.equal(
        cam.consumeAudioChunk(3200, silenceBuf),
        pcmPayload,
        'Must consume buffered PCM audio in lockstep immediately once Frame 0 is decoded'
      );

      cam.appendAudioChunk(pcmPayload, 32000, 320000);
      cam.endSession(5000);
      assert.equal(cam.getBufferedAudioBytes(), 0, 'endSession must clear residual PCM audio');
      assert.equal(cam.consumeAudioChunk(3200, silenceBuf), silenceBuf);

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
        liveCam.getBufferedLiveFrameCount(),
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
      assert.equal(liveCam.getBufferedLiveFrameCount(), 0);
    }
  );

  it(
    'reuses a single per-camera decoder stdout assembly buffer across restarts and ignores ' + 'stale exiting decoders',
    () => {
      // Verify: reuses a single per-camera decoder stdout assembly buffer across restarts and ignores stale exiting
      // decoders.
      const {EventEmitter} = require('node:events');
      assert.equal(typeof attachDecoderStreams, 'function');

      const cam = new Camera({serial: 'T8161T0000000000', name: 'nursery_cam', mode: 'rtsp'});
      assert.equal(cam.getDecoderReadBuffer(), null, 'decoderReadBuf must stay unallocated until a decoder spawns');

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
      assert.ok(Buffer.isBuffer(cam.getDecoderReadBuffer()) && cam.getDecoderReadBuffer().length === FRAME);
      const sharedReadBuf = cam.getDecoderReadBuffer();

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
      assert.equal(
        cam.getDecoderReadBuffer(),
        sharedReadBuf,
        'Second decoder must reuse the existing 1.38 MB decoderReadBuf'
      );

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
      assert.equal(cam.isDecoderStdoutPaused(), true);
      handleP2pDecoderExit(cam, dec1, session1, 0, () => '');
      assert.equal(
        cam.isDecoderStdoutPaused(),
        true,
        'Stale decoder exit must not call resumeDecoderStdout() on the newly attached paused decoder'
      );
      assert.equal(cam.isDecoderProcess(dec2), true);
    }
  );

  it('lazy-allocates StatusCard waking, busy, liveOverlayBufs, and Camera liveFrameRing only when first needed', () => {
    // Verify: lazy-allocates StatusCard waking, busy, liveOverlayBufs, and Camera liveFrameRing only when first
    // needed.
    const cam = new Camera(
      {serial: 'T8161T0000000000', name: 'standby_cam', mode: 'backfill', card_theme: 'glance'},
      {frame: Buffer.alloc(FRAME, 0x18), lastSeen: '09:00'},
      renderCameraCards
    );

    // At startup, only card.asleep is allocated; waking, busy, liveOverlayBufs, and liveFrameRing are all null
    assert.ok(Buffer.isBuffer(cam.getAsleepCardBuffer()) && cam.getAsleepCardBuffer().length === FRAME);
    assert.equal(cam.peekWakingCardBuffer(), null);
    assert.equal(cam.peekBusyCardBuffer(), null);
    assert.equal(cam.getLiveOverlayBuffers(), null);
    assert.equal(cam.getLiveFrameRing(), null);

    // Telemetry card refreshes while idle keep waking & busy unallocated
    cam.applyTelemetryProperties({battery: 88, wifiRssi: -58});
    renderCameraCards(cam);
    assert.equal(cam.peekWakingCardBuffer(), null);
    assert.equal(cam.peekBusyCardBuffer(), null);

    // Entering waiting state lazily allocates & renders card.busy once, then reuses it in-place
    cam.setMotionUntil(60000);
    const selectedBusy = selectEncoderFrame(cam, 1000).frame;
    assert.ok(Buffer.isBuffer(cam.peekBusyCardBuffer()) && cam.peekBusyCardBuffer().length === FRAME);
    assert.equal(selectedBusy, cam.getBusyCardBuffer());
    assert.equal(cam.peekWakingCardBuffer(), null, 'Reading card.busy must not allocate card.waking');

    const busyBeforeUpdate = cam.getBusyCardBuffer();
    cam.applyTelemetryProperties({battery: 42});
    renderCameraCards(cam);
    assert.equal(
      cam.getBusyCardBuffer(),
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
    assert.equal(cam.getLiveFrameRing(), null, 'Backfill playback must not allocate liveFrameRing');
    cam.endSession(3000);

    // Live overlay scratch buffers stay null until prepareLiveOverlayBuffer is called
    assert.equal(cam.getLiveOverlayBuffers(), null);
    const overlayOut = cam.acquireLiveOverlayBuffer(Buffer.alloc(FRAME, 0x25));
    assert.ok(Array.isArray(cam.getLiveOverlayBuffers()) && cam.getLiveOverlayBuffers().length === 2);
    assert.equal(overlayOut.length, FRAME);

    // Live P2P/RTSP decoding lazily initializes liveFrameRing
    cam.beginSession('p2p', 4000, true);
    handleDecodedP2pFrame(cam, Buffer.alloc(FRAME, 0x35), 4100);
    assert.ok(Array.isArray(cam.getLiveFrameRing()) && cam.getLiveFrameRing().length === 2);
  });
});
