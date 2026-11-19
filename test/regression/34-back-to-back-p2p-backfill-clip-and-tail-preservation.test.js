/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 34. Back-to-Back P2P Backfill Clip Preservation, Follow-Up Queries & Tail Frame
 * Drain (docs/regression/34-back-to-back-p2p-backfill-clip-and-tail-preservation.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME, FRAME_STAGE_MARKERS} = require('../../src/config');
const {BACKFILL_STATES} = require('../../src/domain/backfill-job');
const {Camera, DOWNLOAD_EVENT_DURATION_MARGIN_SECS} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {attachDecoderStreams, handleDecodedP2pFrame, handleP2pDecoderExit} = require('../../src/media/decoder');
const {initOrchestrator, onEvent} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 34. Back-to-Back P2P Backfill Clip Preservation, Follow-Up Queries & Tail Frame Drain', () => {
  it(
    'Regression 34: preserves settled Clip 1 queries, follow-up retry ' +
      'budgets, and frame drains in back-to-back backfill',
    () => {
      // Regression: when Clip 1 has already cleared and elapsed its 4s settle window (or already matched a clip),
      // a new state=true trigger for Clip 2 must not regress Job 1 back to RECORDING or overwrite Job 2 when
      // starting a queued clip download.
      const cam = new Camera(
        {serial: 'T8214T6666666669', name: 'doorbell_b2b', mode: 'backfill', station_serial: 'T8030P0000000001'},
        {frame: Buffer.alloc(FRAME, 0x22), lastSeen: '10:00'},
        renderCameraCards
      );
      const t0 = 500000;
      cam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      cam.recordMotionCleared(t0 + 10000, 4000, 10000, 'motion detected');
      assert.equal(cam.canQueryBackfill(t0 + 14500, 4000, 4000), true);
      assert.equal(cam.getPendingBackfillJob().state, BACKFILL_STATES.SETTLING);
      assert.equal(cam.getPendingBackfillJob().markReadyToQueryIfSettled(t0 + 14500, 4000), true);
      assert.equal(cam.getPendingBackfillJob().state, BACKFILL_STATES.READY_TO_QUERY);

      // Trailing state=false for another property must not reset clearedAt or regress READY_TO_QUERY back to SETTLING
      cam.recordMotionCleared(t0 + 15000, 4000, 10000, 'person detected');
      assert.equal(cam.getPendingBackfillJob().state, BACKFILL_STATES.READY_TO_QUERY);
      assert.equal(cam.getPendingBackfillJob().clearedAt, t0 + 10000);
      assert.equal(cam.canQueryBackfill(t0 + 15500, 4000, 4000), true);

      // A new trigger arriving after Clip 1 settled (t0 + 16s) keeps Job 1 ready to query Clip 1 while queuing Job 2
      cam.queueEventBackfill(t0 + 16000, 'person detected', 'Alice', 'person detected (Alice)', 300, true);
      assert.equal(
        cam.canQueryBackfill(t0 + 16500, 4000, 4000),
        true,
        'Settled Job 1 must remain ready to query Clip 1 on HomeBase 3 even after Clip 2 trigger starts'
      );
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T6666666669',
          storagePath: '/zx/clip2_incomplete.zxvideo',
          cipherId: 2,
          clipMs: t0 + 16000,
        }),
        false,
        'Settled Job 1 must not match Clip 2 while Clip 2 is still actively recording'
      );
      assert.equal(
        cam.tryMatchBackfillCandidate({
          devSn: 'T8214T6666666669',
          storagePath: '/zx/clip1_complete.zxvideo',
          cipherId: 1,
          clipMs: t0 + 1000,
        }),
        true
      );

      // Starting Clip 1 promotes Job 1 to activeBackfillJob and shifts Job 2 into pendingBackfill
      cam.beginBackfillDownload(cam.getBackfillClip(), false, t0 + 17000);
      assert.equal(cam.getActiveBackfillJob()?.at, t0);
      assert.equal(cam.getPendingBackfillJob()?.at, t0 + 16000);
      assert.equal(cam.getPendingBackfillJob()?.recordingActive, true);

      // Clip 2 clears while Clip 1 is playing -> settles and becomes queryable while Clip 1 drains
      cam.recordMotionCleared(t0 + 25000, 4000, 10000, 'person detected');
      assert.equal(cam.getPendingBackfillJob()?.recordingActive, false);
      assert.equal(cam.getActiveBackfillJob()?.state, BACKFILL_STATES.DOWNLOADING);

      const frame1 = Buffer.alloc(FRAME, 0x77);
      cam.markP2pVideoPacketReceived(t0 + 17400);
      cam.recordDecodedFrame(frame1, frame1, t0 + 17500, '10:01');
      assert.equal(cam.getLastVideoAt(), t0 + 17500, 'recordDecodedFrame must update lastVideoAt on Frame 0');
      cam.markDownloadFinished(t0 + 18000);
      cam.detachDecoder();

      // While frameNew is true on an attached writable encoder, isDownloadComplete waits for the final frame write
      cam.attachEncoder({stdin: {writable: true, writableNeedDrain: false, write() {}}}, t0);
      cam.setFrameNew(true);
      assert.equal(
        cam.isDownloadComplete(t0 + 29500, 3000, 2500, 4500),
        false,
        'Must not complete download before the final decoded frame (frameNew=true) is written to encoder stdin'
      );
      cam.setFrameNew(false);

      // While pendingVideoPackets remain un-decoded, isDownloadComplete must never complete via idleCompleteMs
      cam.getPendingVideoPackets().push(Buffer.from([1, 2, 3]));
      assert.equal(
        cam.isDownloadComplete(t0 + 29500, 3000, 2500, 4500),
        false,
        'Must not complete download while pendingVideoPackets remain queued'
      );
      cam.clearPendingVideoPackets();
      assert.equal(cam.isDownloadComplete(t0 + 29500, 3000, 2500, 4500), true);

      // Ending Clip 1 while Job 2 is waiting to query holds Clip 1's final frame (isStreamingLive=true, marker='B')
      cam.terminateSession(t0 + 29500, 'post-event clip download stream completed', false, 'eufy/download-finished');
      assert.equal(cam.hasBackfillContinuation(), true);
      assert.equal(
        cam.isStreamingLive(t0 + 29600, 2000),
        true,
        'Must keep holding Clip 1 final frame while waiting to query/start Clip 2 in back-to-back continuation'
      );
      assert.equal(cam.getFrameMarker(), FRAME_STAGE_MARKERS.BACKFILL);

      // Follow-up split-clip queries must be immediately ready to query (no 4s stall) with a full retry budget
      // (attempts=0) and support 3+ split clips in a long visit
      const splitCam = new Camera({serial: 'T8214T6666666670', name: 'doorbell_split', mode: 'backfill'});
      splitCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      splitCam.queueEventBackfill(t0 + 40000, 'person detected', '', 'person detected', 200, true);
      splitCam.recordMotionCleared(t0 + 45000, 4000, 10000);
      splitCam.canQueryBackfill(t0 + 50000, 4000, 4000);
      splitCam.beginBackfillDatabaseQuery(t0 + 50000);
      splitCam.tryMatchBackfillCandidate({
        devSn: 'T8214T6666666670',
        storagePath: '/zx/split1.zxvideo',
        cipherId: 1,
        clipMs: t0 + 1000,
      });
      splitCam.beginBackfillDownload(splitCam.getBackfillClip(), false, t0 + 51000);
      splitCam.endSession(t0 + 60000, true, false, 'download');
      assert.equal(splitCam.getPendingBackfillJob()?.followUpQueried, true);
      assert.equal(
        splitCam.getPendingBackfillJob()?.attempts,
        0,
        'prepareFollowUpQuery must reset attempts to 0 so Clip 2 gets a full query retry budget'
      );
      assert.equal(
        splitCam.canQueryBackfill(t0 + 60000, 4000, 4000),
        true,
        'prepareFollowUpQuery must be immediately ready to query at endSession without a redundant 4s delay'
      );
      assert.equal(
        splitCam.tryMatchBackfillCandidate({
          devSn: 'T8214T6666666670',
          storagePath: '/zx/split2.zxvideo',
          cipherId: 2,
          clipMs: t0 + 21000,
        }),
        true
      );
      splitCam.beginBackfillDownload(splitCam.getBackfillClip(), false, t0 + 61000);
      splitCam.endSession(t0 + 70000, true, false, 'download');
      assert.equal(
        splitCam.getPendingBackfillJob()?.followUpQueried,
        true,
        'When activity extends >= 15s past Clip 2 as well, a follow-up query for Clip 3 must be scheduled'
      );

      // View max duration and early sleep must never trigger during STREAM_MODES.DOWNLOAD, and Frigate event duration
      // must account for packets already written to decoder stdin
      const p2pDlCam = new Camera({
        serial: 'T8214T6666666671',
        name: 'p2p_dl_cam',
        mode: 'p2p',
        view_linger_secs: 10,
        view_max_secs: 15,
        idle_timeout_secs: 10,
        frigate_event_secs: 20,
      });
      p2pDlCam.beginBackfillDownload(
        {
          storagePath: '/zx/p2p_dl.zxvideo',
          cipherId: 1,
          clipMs: t0,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        t0
      );
      p2pDlCam.setGotVideo(true);
      p2pDlCam.setFirstVideoAt(t0 + 500);
      p2pDlCam.setDownloadVideoPacketCount(600);
      p2pDlCam.setDownloadDecodedFrameCount(30);
      p2pDlCam.setDownloadPlayedFrameCount(15);
      p2pDlCam.setBufferedDownloadFrames(new Array(15));
      p2pDlCam.setPendingVideoPackets([]);
      assert.equal(
        p2pDlCam.getEffectiveEventDurationSecs(15, t0 + 1500),
        39 + DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
        'getEffectiveEventDurationSecs must account for received downloadVideoPackets already written to dec.stdin'
      );
      assert.equal(
        p2pDlCam.hasReachedViewMaxDuration(t0 + 20000),
        false,
        'view_max_secs must never terminate a backfill download session'
      );
      p2pDlCam.applyMotionTrigger(t0 + 2000, 'motion detected', 60000, 'eufy-event', 10);
      assert.equal(
        p2pDlCam.isMotionOnlyActiveSession(t0 + 15000),
        false,
        'isMotionOnlyActiveSession must be false during backfill download so early-sleep never kills playback'
      );
    }
  );

  it(
    'Regression 34: defers backfill decoder detach on exit until flowing ' +
      'stdout closes so tail frames are not dropped',
    () => {
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
      assert.equal(cam.isDecoderStdoutPaused(), false);

      // FFmpeg process exits while final frame is still in the OS pipe (readableLength === 0 in flowing mode)
      handleP2pDecoderExit(cam, mockDec, sid, 0);
      assert.equal(
        cam.hasDecoderProcess(),
        true,
        'Must keep cam.dec attached until flowing dec.stdout emits close so tail frames are not discarded'
      );

      const finalTailFrame = Buffer.alloc(FRAME, 0xbb);
      stdoutEmitter.emit('data', finalTailFrame);
      assert.equal(
        decodedCount.length,
        2,
        'Tail frame arriving after process exit but before stdout close must decode'
      );
      assert.equal(cam.getBufferedDownloadFrames().length, 1);

      stdoutEmitter.closed = true;
      stdoutEmitter.emit('close');
      assert.equal(cam.hasDecoderProcess(), false, 'Detaches cam.dec once dec.stdout emits close');
    }
  );

  it(
    'Regression 34: ignores in-progress recording cameras when a ' +
      'station-wide database query latest response arrives',
    () => {
      // Regression: station.database_query_latest_info returns rows for all cameras on the HomeBase station,
      // and HomeBase 3 creates crop_local_path at t=0 when recording starts. A camera whose BackfillJob is
      // still in RECORDING or SETTLING must not match and download its own incomplete file from another
      // camera's query response.
      const camReady = new Camera({
        serial: 'T8214T8888888881',
        name: 'ready_doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      const camRecording = new Camera({
        serial: 'T8214T8888888882',
        name: 'recording_cam',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      const now = Date.now();
      camReady.queueEventBackfill(now - 25000, 'person detected', '', 'person detected', 200, true);
      camReady.recordMotionCleared(now - 10000, 4000, 10000, 'person detected');
      assert.equal(camReady.canQueryBackfill(now, 4000, 4000), true);

      camRecording.queueEventBackfill(now - 2000, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(camRecording.getPendingBackfillJob()?.recordingActive, true);

      initOrchestrator(
        [camReady, camRecording],
        new Map([
          [camReady.getSerial(), camReady],
          [camRecording.getSerial(), camRecording],
        ]),
        () => false
      );

      onEvent({
        source: 'station',
        event: 'database query latest',
        serialNumber: 'T8030P0000000001',
        returnCode: 0,
        data: [
          {
            device_sn: camReady.getSerial(),
            crop_local_path: '/zx/hdd_data0/Camera01/202611/20261117010000/pic20261117010000.jpg',
            create_time: new Date(now - 24000).toISOString(),
          },
          {
            device_sn: camRecording.getSerial(),
            crop_local_path: '/zx/hdd_data0/Camera02/202611/20261117010023/pic20261117010023.jpg',
            create_time: new Date(now - 2000).toISOString(),
          },
        ],
      });

      assert.equal(
        camReady.getBackfillClip()?.storagePath,
        '/zx/hdd_data0/Camera01/202611/20261117010000/20261117010000.zxvideo'
      );
      assert.equal(
        camRecording.getBackfillClip(),
        null,
        'Camera still actively recording must not match its incomplete clip from a station-wide query result'
      );
    }
  );
});
