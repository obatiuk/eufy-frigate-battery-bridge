/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 25. Multi-Camera FFmpeg Thread Footprint, Probe Buffer Churn & Unbounded Queues
 * (docs/regression/25-multi-camera-ffmpeg-thread-footprint-and-buffer-leaks.md).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {TEST_CACHE_DIR} = require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {
  MAX_DOWNLOADED_PATHS_HISTORY,
  MAX_LIVE_PENDING_VIDEO_PACKETS,
  MAX_DOWNLOAD_PENDING_VIDEO_PACKETS,
  MAX_LIVE_PENDING_AUDIO_PACKETS,
  Camera,
} = require('../../src/domain/camera');
const {buildDecodeJpegArgs, buildEncodeJpegArgs} = require('../../src/overlay/snapshot-cache');
const {buildP2pDecoderArgs, buildScaleFilter, buildRtspDecoderArgs} = require('../../src/media/decoder');
const {buildEncoderArgs, buildVideoCodecArgs} = require('../../src/media/encoder');
const {getActiveStationTransitionCount, initOrchestrator, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('Regression 25. Multi-Camera FFmpeg Thread Footprint, Probe Buffer Churn & Unbounded Queues', () => {
  it(
    'Regression 25: bounds downloadedPaths FIFO history and caps stalled pendingVideoPackets/pendingAudioPackets ' +
      'with HUD DROP counter',
    () => {
      // Regression 25: bounds downloadedPaths FIFO history and caps stalled pendingVideoPackets/pendingAudioPackets
      // with HUD DROP counter.
      assert.equal(MAX_DOWNLOADED_PATHS_HISTORY, 500);
      assert.equal(MAX_LIVE_PENDING_VIDEO_PACKETS, 150);
      assert.equal(MAX_DOWNLOAD_PENDING_VIDEO_PACKETS, 2400);
      assert.equal(MAX_LIVE_PENDING_AUDIO_PACKETS, 200);

      const bfCam = new Camera({serial: 'T8161T0000000000', name: 'garage', mode: 'backfill'});
      for (let i = 0; i < MAX_DOWNLOADED_PATHS_HISTORY + 5; i++) {
        bfCam.beginBackfillDownload(
          {
            storagePath: '/zx/clip_' + i + '.zxvideo',
            cipherId: 0,
            clipMs: 1000 + i,
            event: 'motion detected',
            personName: '',
            reason: 'motion detected',
          },
          false,
          10000 + i
        );
        bfCam.endSession(10001 + i, true, false, 'download');
      }
      assert.equal(bfCam.getDownloadedClipPathCount(), MAX_DOWNLOADED_PATHS_HISTORY);
      assert.equal(bfCam.hasDownloadedClipPath('/zx/clip_0.zxvideo'), false);
      assert.equal(bfCam.hasDownloadedClipPath('/zx/clip_4.zxvideo'), false);
      assert.equal(bfCam.hasDownloadedClipPath('/zx/clip_5.zxvideo'), true);
      assert.equal(bfCam.hasDownloadedClipPath('/zx/clip_504.zxvideo'), true);

      // Live P2P stalled decoder caps pendingVideoPackets & pendingAudioPackets using
      // drop-oldest policy and increments HUD DROP
      const liveCam = new Camera({serial: 'T8161T1111111111', name: 'patio', mode: 'p2p', card_theme: 'hud'});
      liveCam.beginSession('p2p', 20000, true);
      liveCam.attachDecoder({
        stdin: {writable: true, writableNeedDrain: true, write() {}},
        stdio: [null, null, null, {writable: true, writableNeedDrain: true, write() {}}],
        stdout: {pause() {}, resume() {}},
      });

      for (let i = 0; i < MAX_LIVE_PENDING_VIDEO_PACKETS + 5; i++) {
        liveCam.enqueueOrWriteVideoPacket(Buffer.from([i & 0xff]));
      }
      assert.equal(liveCam.getPendingVideoPackets().length, MAX_LIVE_PENDING_VIDEO_PACKETS);
      assert.equal(liveCam.getPendingVideoPackets()[0][0], 5, 'Drop-oldest policy must evict oldest 5 video packets');
      assert.equal(liveCam.getDroppedFrameCount(), 5);
      assert.ok(liveCam.buildDebugHudLines(20500)[0].includes('DROP:5'));

      for (let i = 0; i < MAX_LIVE_PENDING_AUDIO_PACKETS + 3; i++) {
        liveCam.enqueueOrWriteAudioPacket(Buffer.from([i & 0xff]), true);
      }
      assert.equal(liveCam.getPendingAudioPackets().length, MAX_LIVE_PENDING_AUDIO_PACKETS);
      assert.equal(liveCam.getPendingAudioPackets()[0][0], 3, 'Drop-oldest policy must evict oldest 3 audio packets');
      assert.equal(liveCam.getDroppedFrameCount(), 8);
      assert.ok(liveCam.buildDebugHudLines(20600)[0].includes('DROP:8'));

      // Backfill download mode allows up to MAX_DOWNLOAD_PENDING_VIDEO_PACKETS (2400) so full 120s clips never truncate
      bfCam.beginBackfillDownload(
        {
          storagePath: '/zx/long_clip.zxvideo',
          cipherId: 0,
          clipMs: 30000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        30000
      );
      bfCam.attachDecoder({
        stdin: {writable: true, writableNeedDrain: true, write() {}},
        stdio: [null, null, null, {writable: true, writableNeedDrain: true, write() {}}],
        stdout: {pause() {}, resume() {}},
      });
      bfCam.pauseDecoderStdout();
      for (let i = 0; i < 1800; i++) {
        bfCam.enqueueOrWriteVideoPacket(Buffer.from([1]));
      }
      assert.equal(bfCam.getPendingVideoPackets().length, 1800);
      assert.equal(bfCam.getDroppedFrameCount(), 0, '120s backfill clip (1800 frames @ 15 fps) must not drop packets');
    }
  );

  it(
    'Regression 25: caps FFmpeg filtergraph threads, demuxer packet queues, hardware frame pools, and ' +
      'software/snapshot threads',
    () => {
      // Regression 25: caps FFmpeg filtergraph threads, demuxer packet queues, hardware frame pools, and
      // software/snapshot threads.
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
    'Regression 25: skips stationTransitions on direct rtsp_url stops and ' + 'deletes settled HomeBase transitions',
    async () => {
      // Regression 25: skips stationTransitions on direct rtsp_url stops and deletes settled HomeBase transitions.
      assert.equal(typeof getActiveStationTransitionCount, 'function');
      const directProbeCam = new Camera({
        name: 'nursery_probe_cam',
        mode: 'rtsp',
        rtsp_url: 'rtsp://192.0.2.20:8554/nursery',
      });
      const stationCam = new Camera({
        serial: 'T8161T7000000001',
        name: 'front_station_cam',
        mode: 'rtsp',
        station_serial: 'T8030P0000000001',
      });
      initOrchestrator(
        [directProbeCam, stationCam],
        new Map([
          [directProbeCam.getSerial(), directProbeCam],
          [stationCam.getSerial(), stationCam],
        ]),
        () => false
      );
      assert.equal(getActiveStationTransitionCount(), 0);

      directProbeCam.beginSession('rtsp', 50000, true);
      stop(directProbeCam, 'standby probe 404', false, 'rtsp-direct-probe');
      assert.equal(
        getActiveStationTransitionCount(),
        0,
        'Direct rtsp_url camera stops must not queue HomeBase stationTransitions timers'
      );

      stationCam.beginSession('rtsp', 51000, true);
      mock.timers.enable({apis: ['setTimeout']});
      stop(stationCam, 'rtsp session ended', false, 'bridge-timer');
      assert.equal(
        getActiveStationTransitionCount(),
        1,
        'Active HomeBase stop settle promise must be tracked in stationTransitions while pending'
      );

      await flushAsync();
      mock.timers.tick(250);
      await flushAsync();
      assert.equal(
        getActiveStationTransitionCount(),
        0,
        'Settled station transition promise must be deleted from stationTransitions so closures do not leak'
      );
    }
  );
});
