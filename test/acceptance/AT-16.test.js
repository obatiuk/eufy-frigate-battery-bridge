/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-16`: Backfill `15 fps` Frame-0 Playback, Multi-Clip Continuity, Live `P2P`
 * Isolation & Download Retry (docs/acceptance/AT-16.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-16.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {handleDecodedP2pFrame, flushDecoderInput} = require('../../src/media/decoder');
const {pushFrameToEncoder, selectEncoderFrame} = require('../../src/media/encoder');
const {initOrchestrator, onEvent, runHousekeepingTick} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Locked Acceptance Criterion AT-16 (docs/acceptance/AT-16.md)', () => {
  it(
    'AT-16: Streams Backfill clips chronologically from Frame 0 at 15 fps with audio lockstep, 30/10 frame ' +
      'backpressure watermarks, EOF flush, and 2.5s final hold (0s across back-to-back clips)',
    () => {
      const cam = new Camera(
        {serial: 'T8214T0000000028', name: 'doorbell', mode: 'backfill'},
        {frame: Buffer.alloc(1382400, 0x10), lastSeen: '12:00'},
        renderCameraCards
      );
      const encodedFirstBytes = [];
      cam.attachEncoder(
        {
          stdin: {
            writable: true,
            writableNeedDrain: false,
            write(buf) {
              encodedFirstBytes.push(buf[0]);
            },
          },
        },
        1000
      );

      const t0 = 50000;
      cam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      cam.queueEventBackfill(
        t0 + 2000,
        'identity person detected',
        'Alice',
        'identity person detected (Alice)',
        300,
        true
      );
      assert.equal(cam.getPendingBackfillJob().personName, 'Alice');
      assert.equal(
        cam.canMatchDatabaseQueryResult(t0 + 2500, 4000),
        false,
        'AT-16: Camera actively recording must ignore station-wide database query rows before settle/timeout'
      );
      cam.recordMotionCleared(t0 + 5000, 4000, 10000);
      assert.equal(cam.canQueryBackfill(t0 + 10000, 8000, 12000), true);
      assert.equal(cam.canMatchDatabaseQueryResult(t0 + 10000, 4000), true);
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/missing-ts.zxvideo',
          cipherId: 99,
          clipMs: 0,
        }),
        false,
        'AT-16: Normal BackfillJob must reject timestamp-less database candidates (clipMs <= 0)'
      );

      // Match two clips out of order -> sorted chronologically (oldest -> newest)
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 2,
        clipMs: t0 + 20000,
      });
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip1.zxvideo',
        cipherId: 1,
        clipMs: t0 + 1000,
      });
      assert.equal(cam.getBackfillClip().storagePath, '/zx/clip1.zxvideo');

      cam.beginBackfillDownload(cam.getBackfillClip(), false, t0 + 30000);
      let paused = 0;
      let resumed = 0;
      let stdinEnded = false;
      cam.attachDecoder({
        stdin: {
          writable: true,
          writableNeedDrain: false,
          write() {},
          end() {
            stdinEnded = true;
          },
        },
        stdout: {
          pause() {
            paused++;
          },
          resume() {
            resumed++;
          },
        },
        stdio: [null, null, null, {writable: true, writableNeedDrain: false, write() {}, end() {}}],
      });

      // Decode Frame 0 (0x90) + 30 frames (0x91..) to hit the 30-frame high watermark
      const scratch = Buffer.alloc(1382400, 0x90);
      cam.markP2pVideoPacketReceived(t0 + 30100);
      handleDecodedP2pFrame(cam, scratch, t0 + 30100);
      assert.equal(cam.getFrameMarker(), 'FB');
      for (let i = 1; i <= 30; i++) {
        scratch.fill(0x90 + (i % 50));
        handleDecodedP2pFrame(cam, scratch, t0 + 30100 + i);
      }
      assert.equal(paused, 1, 'Pauses decoder stdout at 30 buffered frames');

      // Drain down to the 10-frame low watermark at 15 fps
      let tTick = t0 + 30100;
      while (cam.getBufferedDownloadFrames().length > 10) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      assert.equal(resumed, 1, 'Resumes decoder stdout at 10 buffered frames');
      assert.equal(cam.getFrameMarker(), 'B');

      // Drain remaining frames and flush EOF; because clip2 is queued in backfillClipQueue, skips 2.5s
      // post-playback hold!
      while (cam.getBufferedDownloadFrames().length > 0) {
        tTick += 67;
        pushFrameToEncoder(cam, tTick);
      }
      flushDecoderInput(cam);
      assert.equal(stdinEnded, true);
      cam.markDownloadFinished(tTick);
      // Live P2P events ('livestream stopped', etc.), /api/wake, and hardware 'rtsp livestream started' during
      // 'download' must never stop backfill playback
      const stopEval = cam.evaluateExternalLivestreamStop(tTick + 50, 3000);
      assert.equal(
        stopEval.action,
        'inactive',
        'AT-16: External livestream stopped must be ignored during backfill playback'
      );
      assert.equal(
        cam.isP2pReady(),
        true,
        'AT-16: External livestream stopped must not clear p2pReady during backfill playback'
      );
      assert.equal(
        cam.shouldBackfillOnlyOnApiWake(),
        true,
        'AT-16: /api/wake during active backfill playback stays in backfill mode'
      );
      assert.equal(
        cam.evaluateUnexpectedRtspStart().shouldStopRtsp,
        false,
        'AT-16: Hardware RTSP start during active backfill playback must not stop RTSP'
      );
      cam.detachDecoder();
      assert.equal(
        cam.isDownloadComplete(tTick + 100, 3000, 2500, 0),
        true,
        'AT-16: Skips 2.5s post-playback hold when Clip 2 is queued next'
      );
      cam.endSession(tTick + 100, true, false, 'download');

      // Clip 2 download failure/0-frame timeout re-queues the clip up to 3 attempts with a 4s retry cooldown
      assert.equal(cam.getBackfillClip().storagePath, '/zx/clip2.zxvideo');
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tTick + 200);
      // Attempt 1 fails with hadVideo=false -> re-queued at front of backfillClipQueue with 4s cooldown
      cam.endSession(tTick + 300, false, false, 'download');
      assert.equal(cam.hasDownloadedClipPath('/zx/clip2.zxvideo'), false);
      assert.equal(cam.getBackfillClip()?.storagePath, '/zx/clip2.zxvideo');
      assert.equal(cam.hasPendingBackfill(), true);
      assert.equal(
        cam.isReadyForBackfillDownload(tTick + 2000),
        false,
        'AT-16: Waits for 4s cooldown before retrying failed download'
      );
      assert.equal(
        cam.isReadyForBackfillDownload(tTick + 4300),
        true,
        'AT-16: Ready to retry failed download after 4s cooldown'
      );

      // Attempt 2 fails with hadVideo=false -> re-queued again
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tTick + 4300);
      cam.endSession(tTick + 4400, false, false, 'download');
      assert.equal(cam.getBackfillClip()?.storagePath, '/zx/clip2.zxvideo');

      // Attempt 3 fails with hadVideo=false -> gives up after 3 attempts
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tTick + 8500);
      cam.endSession(tTick + 8600, false, false, 'download');
      assert.equal(cam.getBackfillClip(), null, 'AT-16: Gives up on backfill clip after 3 failed download attempts');

      // A transfer cut after Frame 0 (station disconnect, preemption, cancel) is interrupted, not complete: the clip is
      // re-queued and replayed from Frame 0 within the same 3 attempt budget and 4s cooldown
      const t3 = tTick + 20000;
      cam.queueEventBackfill(t3, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t3 + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip3.zxvideo',
        cipherId: 3,
        clipMs: t3 + 1000,
      });
      assert.equal(cam.getBackfillClip()?.storagePath, '/zx/clip3.zxvideo');

      cam.beginBackfillDownload(cam.getBackfillClip(), false, t3 + 10000);
      cam.markP2pVideoPacketReceived(t3 + 10100);
      handleDecodedP2pFrame(cam, scratch, t3 + 10100);
      cam.terminateSession(t3 + 10200, 'Station P2P disconnected/restarting', false, 'error/station-disconnect');
      assert.equal(
        cam.hasDownloadedClipPath('/zx/clip3.zxvideo'),
        false,
        'AT-16: Interrupted transfer after Frame 0 is not marked downloaded'
      );
      assert.equal(
        cam.getBackfillClip()?.storagePath,
        '/zx/clip3.zxvideo',
        'AT-16: Interrupted transfer after Frame 0 re-queues the clip'
      );
      assert.equal(cam.hasPendingBackfill(), true);
      assert.equal(
        cam.isReadyForBackfillDownload(t3 + 12000),
        false,
        'AT-16: Waits for 4s cooldown before retrying an interrupted transfer'
      );
      assert.equal(cam.isReadyForBackfillDownload(t3 + 14300), true);

      // An interruption on every attempt gives up after 3 attempts like a failed start
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t3 + 14300);
      cam.markP2pVideoPacketReceived(t3 + 14400);
      handleDecodedP2pFrame(cam, scratch, t3 + 14400);
      cam.terminateSession(t3 + 14500, 'Station P2P disconnected/restarting', false, 'error/station-disconnect');
      assert.equal(cam.getBackfillClip()?.storagePath, '/zx/clip3.zxvideo');
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t3 + 19000);
      cam.markP2pVideoPacketReceived(t3 + 19100);
      handleDecodedP2pFrame(cam, scratch, t3 + 19100);
      cam.terminateSession(t3 + 19200, 'Station P2P disconnected/restarting', false, 'error/station-disconnect');
      assert.equal(cam.getBackfillClip(), null, 'AT-16: Gives up on an interrupted clip after 3 attempts');

      // A raw-packet-only transfer that never decodes Frame 0 (firstFrameAt === 0) must NOT complete after 3s idle or
      // 'download finished', must time out after 15s, and must re-queue the clip for retry
      const tRaw = t3 + 22000;
      cam.queueEventBackfill(tRaw, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(tRaw + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip0frame.zxvideo',
        cipherId: 39,
        clipMs: tRaw + 1000,
      });
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tRaw + 10000);
      cam.markP2pVideoPacketReceived(tRaw + 10200);
      assert.equal(
        cam.isDownloadComplete(tRaw + 14000, 3000, 2500, 0),
        false,
        'AT-16: Raw compressed packets without decoded Frame 0 must not complete via 3s idle fallback'
      );
      assert.equal(
        cam.hasDownloadTimedOut(tRaw + 25200, 15000),
        false,
        'AT-16: Download timeout waits full 15s from last packet while waiting for Frame 0'
      );
      assert.equal(
        cam.hasDownloadTimedOut(tRaw + 25201, 15000),
        true,
        'AT-16: Stalled download without decoded Frame 0 times out after 15s even if raw packets arrived'
      );
      cam.markDownloadFinished(tRaw + 25201);
      assert.equal(
        cam.isDownloadComplete(tRaw + 29000, 3000, 2500, 0),
        false,
        'AT-16: downloadFinished without decoded Frame 0 must not mark playback complete'
      );
      cam.terminateSession(tRaw + 29000, 'post-event clip download timed out', false, 'eufy/download-finished');
      assert.equal(
        cam.hasDownloadedClipPath('/zx/clip0frame.zxvideo'),
        false,
        'AT-16: 0-decoded-frame transfer removes storagePath from downloadedPaths'
      );
      assert.equal(
        cam.getBackfillClip()?.storagePath,
        '/zx/clip0frame.zxvideo',
        'AT-16: 0-decoded-frame transfer re-queues the clip at the front of backfillClipQueue'
      );
      cam.clearPendingBackfill();

      // Once Frame 0 has decoded, a finished transfer or 3s idle-fallback playback is complete and stays downloaded
      const t4 = t3 + 60000;
      cam.queueEventBackfill(t4, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t4 + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip4.zxvideo',
        cipherId: 4,
        clipMs: t4 + 1000,
      });
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t4 + 10000);
      cam.markP2pVideoPacketReceived(t4 + 10100);
      handleDecodedP2pFrame(cam, scratch, t4 + 10100);
      pushFrameToEncoder(cam, t4 + 10150);
      cam.markDownloadFinished(t4 + 10200);
      cam.terminateSession(t4 + 12000, 'post-event clip download stream completed', false, 'eufy/download-finished');
      assert.equal(cam.hasDownloadedClipPath('/zx/clip4.zxvideo'), true, 'AT-16: Finished transfer stays downloaded');
      assert.equal(cam.getBackfillClip(), null, 'AT-16: Finished transfer is not re-queued');

      const t5 = t4 + 30000;
      cam.queueEventBackfill(t5, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t5 + 5000, 4000, 10000);
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000028',
        storagePath: '/zx/clip5.zxvideo',
        cipherId: 5,
        clipMs: t5 + 1000,
      });
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t5 + 10000);
      cam.markP2pVideoPacketReceived(t5 + 10100);
      handleDecodedP2pFrame(cam, scratch, t5 + 10100);
      pushFrameToEncoder(cam, t5 + 10150);
      cam.terminateSession(t5 + 14000, 'post-event clip download stream completed', false, 'eufy/download-finished');
      assert.equal(
        cam.hasDownloadedClipPath('/zx/clip5.zxvideo'),
        true,
        'AT-16: Idle-fallback completion stays downloaded'
      );
      assert.equal(cam.getBackfillClip(), null, 'AT-16: Idle-fallback completion is not re-queued');

      // Split-clip follow-up queries reset the 10-attempt budget across 3+ clips without a redundant 4s settle wait
      const tSplit = t5 + 30000;
      cam.queueEventBackfill(tSplit, 'motion detected', '', 'motion detected', 10, true);
      cam.queueEventBackfill(tSplit + 40000, 'person detected', '', 'person detected', 200, true);
      cam.recordMotionCleared(tSplit + 42000, 4000, 10000);
      for (let attempt = 1; attempt <= 9; attempt++) {
        assert.equal(cam.beginBackfillDatabaseQuery(tSplit + 46000 + attempt * 12000, 10).allowed, true);
      }
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/split1.zxvideo',
          cipherId: 6,
          clipMs: tSplit + 1000,
        }),
        true
      );
      const tSplitPlay1 = tSplit + 170000;
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tSplitPlay1);
      cam.markP2pVideoPacketReceived(tSplitPlay1 + 100);
      handleDecodedP2pFrame(cam, scratch, tSplitPlay1 + 100);
      pushFrameToEncoder(cam, tSplitPlay1 + 200);
      cam.markDownloadFinished(tSplitPlay1 + 300);
      cam.endSession(tSplitPlay1 + 400, true, false, 'download');
      assert.equal(
        cam.canQueryBackfill(tSplitPlay1 + 400, 4000, 12000),
        true,
        'AT-16: Follow-up split-clip query is ready immediately without a redundant 4s settle stall'
      );
      assert.equal(
        cam.getPendingBackfillJob()?.attempts,
        0,
        'AT-16: Follow-up split-clip query resets the 10-attempt query budget'
      );
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/split2.zxvideo',
          cipherId: 7,
          clipMs: tSplit + 20000,
        }),
        true
      );
      const tSplitPlay2 = tSplitPlay1 + 5000;
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tSplitPlay2);
      cam.markP2pVideoPacketReceived(tSplitPlay2 + 100);
      handleDecodedP2pFrame(cam, scratch, tSplitPlay2 + 100);
      pushFrameToEncoder(cam, tSplitPlay2 + 200);
      cam.markDownloadFinished(tSplitPlay2 + 300);
      cam.endSession(tSplitPlay2 + 400, true, false, 'download');
      assert.equal(
        cam.canQueryBackfill(tSplitPlay2 + 400, 4000, 12000),
        true,
        'AT-16: Matching Clip 2 resets followUpQueried so a 3rd split clip is also queried'
      );
      cam.clearPendingBackfill();

      // Inter-job continuation holds Clip 1's final frame with 0s post-playback hold while Job 2 settles
      const tCont = tSplitPlay2 + 30000;
      const contFrame = Buffer.alloc(1382400, 0xa5);
      cam.queueEventBackfill(tCont, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(tCont + 3000, 4000, 10000);
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000028',
          storagePath: '/zx/cont1.zxvideo',
          cipherId: 8,
          clipMs: tCont + 1000,
        }),
        true
      );
      cam.beginBackfillDownload(cam.getBackfillClip(), false, tCont + 8000);
      cam.markP2pVideoPacketReceived(tCont + 8100);
      handleDecodedP2pFrame(cam, contFrame, tCont + 8100);
      pushFrameToEncoder(cam, tCont + 8200);
      // Back-to-back Event 2 triggers while Clip 1 is playing -> queued in pendingBackfill/queuedBackfillJob
      cam.queueEventBackfill(tCont + 8300, 'person detected', '', 'person detected', 200, true);
      cam.markDownloadFinished(tCont + 8400);
      assert.equal(
        cam.isDownloadComplete(tCont + 8500, 3000, 2500, 0),
        true,
        'AT-16: Skips 2.5s post-playback hold when a back-to-back BackfillJob is pending'
      );
      cam.endSession(tCont + 8500, true, false, 'download');
      const heldBetweenJobs = selectEncoderFrame(cam, tCont + 9000);
      assert.notEqual(
        heldBetweenJobs.frame,
        cam.getAsleepCardBuffer(),
        'AT-16: Holds final video frame instead of flashing Asleep card while Job 2 settles'
      );
      assert.notEqual(
        heldBetweenJobs.frame,
        cam.getBusyCardBuffer(),
        'AT-16: Holds final video frame instead of flashing Waiting card while Job 2 settles'
      );

      // Verify auto/rtsp camera in STREAM_MODES.DOWNLOAD queues BackfillJob on hardware 'rtsp livestream started'
      const autoDlCam = new Camera({
        serial: 'T8161T0000000094',
        name: 'auto_dl_cam',
        mode: 'auto',
        station_serial: 'T8030P0000000028',
      });
      autoDlCam.updateDiscoveredRtspConfig('T8030P0000000028', 'rtsp://192.0.2.10/live0');
      initOrchestrator([autoDlCam], new Map([[autoDlCam.getSerial(), autoDlCam]]), () => false);
      const tAutoDl = Date.now();
      autoDlCam.beginBackfillDownload(
        {
          storagePath: '/zx/auto_ev1.zxvideo',
          cipherId: 9,
          clipMs: tAutoDl - 15000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        tAutoDl
      );
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: autoDlCam.getSerial(),
      });
      assert.equal(
        autoDlCam.getActiveMode(),
        'download',
        'AT-16: Hardware RTSP start on auto/rtsp camera must not interrupt active backfill download'
      );
      assert.equal(
        autoDlCam.hasPendingBackfill(),
        true,
        'AT-16: Hardware RTSP start on auto/rtsp camera during backfill download queues Event 2 BackfillJob'
      );
      autoDlCam.clearPendingBackfill();
      autoDlCam.endSession(tAutoDl + 1000, true, false, 'download');

      // A 90s-120s HomeBase clip draining from RAM at 15 fps must play to completion without being terminated by
      // runHousekeepingTick when stream_max_secs < 120 (e.g., stream_max_secs: 60)
      const maxClipCam = new Camera({
        serial: 'T8214T0000000096',
        name: 'doorbell_long_clip',
        mode: 'backfill',
        hold_secs: 30,
        stream_max_secs: 60,
        station_serial: 'T8030P0000000028',
      });
      initOrchestrator([maxClipCam], new Map([[maxClipCam.getSerial(), maxClipCam]]), () => false);
      const tLong = 2000000;
      maxClipCam.beginBackfillDownload(
        {
          storagePath: '/zx/clip_120s.zxvideo',
          cipherId: 12,
          clipMs: tLong - 120000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        tLong
      );
      maxClipCam.markP2pVideoPacketReceived(tLong + 200);
      handleDecodedP2pFrame(maxClipCam, scratch, tLong + 200);
      handleDecodedP2pFrame(maxClipCam, scratch, tLong + 250);
      maxClipCam.markDownloadFinished(tLong + 4000);
      runHousekeepingTick(tLong + 95000);
      assert.equal(
        maxClipCam.getActiveMode(),
        'download',
        'AT-16: 95s into a 120s backfill clip, runHousekeepingTick must not cut off playback at stream_max_secs (60s)'
      );
      assert.equal(maxClipCam.hasDownloadedClipPath('/zx/clip_120s.zxvideo'), true);
      assert.equal(maxClipCam.getBackfillClip(), null);
      maxClipCam.endSession(tLong + 122500, true, false, 'download');
    }
  );
});
