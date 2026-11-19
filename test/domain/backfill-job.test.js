/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for BackfillJob record parsing, clip window matching, and FSM transitions (src/domain/backfill-job.js).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {
  BACKFILL_RECORDING_WAIT_CAP_MS,
  BACKFILL_POST_CLEAR_SETTLE_MS,
  BackfillJob,
  extractDatabaseRecordCandidate,
  BACKFILL_MAX_QUERY_ATTEMPTS,
  DEFAULT_BACKFILL_MAX_AGE_MS,
} = require('../../src/domain/backfill-job');
const {Camera, DOWNLOAD_EVENT_DURATION_MARGIN_SECS} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {pushFrameToEncoder} = require('../../src/media/encoder');
const {computeRequiredSnapshotDelay, BACKFILL_SNAP_DELAY_MS} = require('../../src/services/frigate-client');

describe('BackfillJob Event-End Aware Settlement & Clip Matching', () => {
  it('waits for all active trigger properties to report state=false + 4s settle (or scaled holdMs + 4s cap)', () => {
    // Verify: waits for all active trigger properties to report state=false + 4s settle (or scaled holdMs + 4s cap).
    const doorbellCam = new Camera({
      serial: 'T8214T2222222222',
      mode: 'backfill',
    });

    const t0 = 1000000;
    doorbellCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    doorbellCam.queueEventBackfill(t0 + 2000, 'person detected', '', 'person detected', 200, true);
    assert.equal(doorbellCam.canQueryBackfill(t0 + 10000, 8000, 12000), false);
    assert.equal(doorbellCam.canQueryBackfill(t0 + BACKFILL_RECORDING_WAIT_CAP_MS + 50, 8000, 12000), true);

    // Clearing only "person detected" while "motion detected" is still active must NOT mark recording cleared
    doorbellCam.recordMotionCleared(t0 + 6000, 5000, 10000, 'person detected');
    assert.equal(doorbellCam.isBackfillRecordingCleared(), false);
    assert.equal(doorbellCam.canQueryBackfill(t0 + 11000, 8000, 12000), false);

    // Clearing "motion detected" completes all active triggers and starts the 4s post-clear settle window
    const tClear = t0 + 11000;
    doorbellCam.recordMotionCleared(tClear, 5000, 10000, 'motion detected');
    assert.equal(doorbellCam.isBackfillRecordingCleared(), true);
    assert.equal(doorbellCam.canQueryBackfill(tClear + 1000, 8000, 12000), false);
    assert.equal(doorbellCam.canQueryBackfill(tClear + BACKFILL_POST_CLEAR_SETTLE_MS + 50, 8000, 12000), true);

    // Follow-up state=true trigger before query re-asserts active recording state
    doorbellCam.queueEventBackfill(tClear + 1500, 'rings', '', 'rings', 1000, true);
    assert.equal(doorbellCam.isBackfillRecordingCleared(), false);
    assert.equal(doorbellCam.canQueryBackfill(tClear + BACKFILL_POST_CLEAR_SETTLE_MS + 50, 8000, 12000), false);
  });

  it('queues multi-clip HomeBase recordings in chronological order while keeping SIGUSR1 single-clip', () => {
    // Verify: queues multi-clip HomeBase recordings in chronological order while keeping SIGUSR1 single-clip.
    const doorbellCam = new Camera({
      serial: 'T8214T2222222222',
      mode: 'backfill',
    });

    const t0 = 2000000;
    doorbellCam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
    doorbellCam.recordMotionCleared(t0 + 25000, 5000, 10000, 'person detected');

    const newerClip = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170020.zxvideo',
      cipherId: 2,
      clipMs: t0 + 20000,
    };
    const olderClip = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170002.zxvideo',
      cipherId: 1,
      clipMs: t0 + 2000,
    };

    // Database query returns newest first; Camera must sort queued event clips chronologically (oldest -> newest)
    assert.equal(doorbellCam.tryMatchBackfillCandidate(newerClip), true);
    assert.equal(doorbellCam.tryMatchBackfillCandidate(olderClip), true);
    assert.equal(doorbellCam.getBackfillClipQueue().length, 2);
    assert.equal(doorbellCam.getBackfillClip().storagePath, olderClip.storagePath);

    // Starting download of Clip 1 shifts Clip 1 and keeps Clip 2 ready in backfillClipQueue
    doorbellCam.beginBackfillDownload(doorbellCam.getBackfillClip(), false, t0 + 30000);
    assert.equal(doorbellCam.getBackfillClipQueue().length, 1);
    assert.equal(doorbellCam.getBackfillClip().storagePath, newerClip.storagePath);
    assert.ok(doorbellCam.getActiveBackfillJob() instanceof BackfillJob);

    doorbellCam.endSession(t0 + 40000);
    assert.equal(doorbellCam.isReadyForBackfillDownload(), true);
    assert.equal(doorbellCam.getBackfillClip().storagePath, newerClip.storagePath);
    assert.equal(doorbellCam.tryMatchBackfillCandidate(olderClip), false, 'Already downloaded path is skipped');

    // SIGUSR1 urgent test clears downloadedPaths and only matches the single newest clip
    doorbellCam.prepareSigUsr1BackfillTest(t0 + 50000);
    const sigClip1 = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170100.zxvideo',
      cipherId: 3,
      clipMs: t0 + 49000,
    };
    const sigClip2 = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170050.zxvideo',
      cipherId: 4,
      clipMs: t0 + 45000,
    };
    assert.equal(doorbellCam.tryMatchBackfillCandidate(sigClip1), true);
    assert.equal(doorbellCam.tryMatchBackfillCandidate(sigClip2), false);
    assert.equal(doorbellCam.getBackfillClipQueue().length, 1);
  });

  it(
    'schedules a follow-up query for split clips and enforces frame-drain, decoder flush, ' + 'and post-playback hold',
    () => {
      // Verify: schedules a follow-up query for split clips and enforces frame-drain, decoder flush, and
      // post-playback hold.
      const doorbellCam = new Camera({
        serial: 'T8214T2222222222',
        mode: 'backfill',
      });

      const t0 = 3000000;
      doorbellCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      doorbellCam.queueEventBackfill(t0 + 20000, 'person detected', '', 'person detected', 200, true);
      doorbellCam.recordMotionCleared(t0 + 22000, 5000, 10000);

      const clip1 = {
        devSn: 'T8214T2222222222',
        storagePath: '/media/mmcblk0p1/video/20261105171001.zxvideo',
        cipherId: 10,
        clipMs: t0 + 1000,
      };
      assert.equal(doorbellCam.tryMatchBackfillCandidate(clip1), true);
      const matchLog = doorbellCam.formatBackfillClipMatchLog(clip1);
      assert.ok(matchLog.includes('preRoll=-1.0s'));
      assert.ok(matchLog.includes('sensorSpan=22.0s'));
      doorbellCam.beginBackfillDownload(doorbellCam.getBackfillClip(), false, t0 + 27000);

      // Burst-downloaded audio chunks are preserved up to maxDownloadBytes instead of being capped at 1s
      doorbellCam.appendAudioChunk(Buffer.alloc(32000), 32000, 32000 * 120);
      doorbellCam.appendAudioChunk(Buffer.alloc(32000), 32000, 32000 * 120);
      assert.equal(doorbellCam.getBufferedAudioBytes(), 64000);

      // Frame 0 committed -> immediately ready to advance to Frame 1 on the next 15 fps tick (62ms) without freezing
      const dummyFrame1 = Buffer.alloc(FRAME, 0x30);
      const dummyFrame2 = Buffer.alloc(FRAME, 0x50);
      const tFirstFrame = t0 + 27100;
      assert.equal(doorbellCam.bufferDownloadFrame(dummyFrame1, 900), false);
      doorbellCam.recordDecodedFrame(dummyFrame1, dummyFrame1, tFirstFrame, '17:10', 5000);
      assert.equal(doorbellCam.getFirstFrameAt(), tFirstFrame);
      assert.equal(doorbellCam.bufferDownloadFrame(dummyFrame2, 900), true);
      assert.equal(
        doorbellCam.canAdvanceDownloadFrame(tFirstFrame + 100, 62),
        false,
        'Must not overwrite un-encoded Frame 0'
      );

      doorbellCam.markFrameEncoded(dummyFrame1, tFirstFrame);
      const silenceBuf = Buffer.alloc(3200, 0);
      const tNextTick = tFirstFrame + 62;
      assert.equal(
        doorbellCam.canAdvanceDownloadFrame(tNextTick, 62),
        true,
        'Advances to Frame 1 on the very next 15 fps tick (62ms) after Frame 0 is encoded'
      );
      assert.notEqual(doorbellCam.consumeAudioChunk(3200, silenceBuf), silenceBuf);
      doorbellCam.consumeNextDownloadFrame(tNextTick, 62, '17:10');
      doorbellCam.markFrameEncoded(dummyFrame2, tNextTick + 10);
      doorbellCam.setGotVideo(true);

      // Mark download finished while decoder process is still attached -> waits for EOF flush
      // settle and 2.5s post-playback hold
      doorbellCam.attachDecoder({});
      assert.equal(doorbellCam.shouldLogUnexpectedDecoderExit(doorbellCam.getSessionId(), 0), true);
      assert.equal(doorbellCam.markDownloadFinished(tNextTick + 500), 0);
      assert.equal(
        doorbellCam.shouldLogUnexpectedDecoderExit(doorbellCam.getSessionId(), 0),
        false,
        'Clean exit (code=0) after flushDecoderInput on downloadFinished must not log a warning'
      );
      assert.equal(doorbellCam.shouldLogUnexpectedDecoderExit(doorbellCam.getSessionId(), 1), true);
      assert.equal(doorbellCam.isDownloadComplete(tNextTick + 1000, 3000, 2500, 4500), false);
      doorbellCam.detachDecoder();
      assert.equal(
        doorbellCam.isDownloadComplete(tNextTick + 4500, 3000, 2500, 4500),
        true,
        'Completes once minPlaybackMs (4.5s) and postPlaybackHoldMs (2.5s) have elapsed'
      );

      // Scales Frigate event duration with DOWNLOAD_EVENT_DURATION_MARGIN_SECS (6s) for backfill downloads
      // and only populates subLabel when a recognized face name is present (null otherwise)
      doorbellCam.setBufferedDownloadFrames(new Array(600));
      doorbellCam.tryUpgradeOrQueueFrigateEvent('person', '', tNextTick + 500);
      const filedNoFace = doorbellCam.completeFrigateEventFiling(tNextTick + 1000, 15);
      assert.equal(filedNoFace.subLabel, null);
      assert.equal(filedNoFace.durationSecs, 41 + DOWNLOAD_EVENT_DURATION_MARGIN_SECS);

      doorbellCam.setFrigateEventUntil(0);
      doorbellCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', tNextTick + 1100);
      const filedWithFace = doorbellCam.completeFrigateEventFiling(tNextTick + 1200, 15);
      assert.equal(filedWithFace.subLabel, 'Alice');
      doorbellCam.setBufferedDownloadFrames([]);

      // Ending session promotes activeBackfillJob to a follow-up query because activity spanned 21s past clip1
      doorbellCam.endSession(tNextTick + 3000);
      assert.ok(doorbellCam.getPendingBackfillJob() instanceof BackfillJob);
      assert.equal(doorbellCam.getPendingBackfillJob().followUpQueried, true);

      // A short 10s event whose clip filename starts 5s earlier (pre-roll) must not schedule a false follow-up query
      const shortJob = new BackfillJob({
        at: t0,
        lastActivityAt: t0,
        clearedAt: t0 + 10000,
      });
      assert.equal(
        shortJob.needsFollowUpClipQuery(t0 - 5000),
        false,
        'Pre-roll clip timestamp (5s before trigger) must not inflate post-trigger activity span'
      );
    }
  );

  it(
    'streams backfill clips from Frame 0 at 15 fps without starving encoder pipe during ' +
      'handshake or freezing Frame 0',
    () => {
      // Verify: streams backfill clips from Frame 0 at 15 fps without starving encoder pipe during handshake or
      // freezing Frame 0.
      const oldSnapshot = Buffer.alloc(FRAME, 0x11);
      const doorbellCam = new Camera(
        {
          serial: 'T8214T2222222222',
          mode: 'backfill',
        },
        {frame: oldSnapshot, lastSeen: '18:21'},
        renderCameraCards
      );

      const writtenFrames = [];
      doorbellCam.attachEncoder(
        {
          stdin: {
            writable: true,
            writableNeedDrain: false,
            write(buf) {
              writtenFrames.push(Buffer.from(buf));
            },
          },
        },
        1000
      );
      // Simulate sleeping state before backfill wake
      pushFrameToEncoder(doorbellCam, 1000);
      assert.equal(writtenFrames.length, 1);
      assert.equal(doorbellCam.getLastSentFrameBuffer(), doorbellCam.getAsleepCardBuffer());
      writtenFrames.length = 0;

      const tWake = 5000;
      const clip = {
        storagePath: '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo',
        cipherId: 0,
        clipMs: tWake - 30000,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      };

      // Phase 1: beginBackfillDownload (before Frame 0 is decoded)
      doorbellCam.beginBackfillDownload(clip, false, tWake);
      assert.equal(doorbellCam.getFirstFrameAt(), 0);
      assert.equal(doorbellCam.getCurrentFrameBuffer(), null);
      assert.equal(
        doorbellCam.isActivelyViewing(tWake + 50),
        false,
        'Automatic Frigate UI consumer joining during backfill download must be classified as ' +
          '"joined while live", not an active viewer wake'
      );
      assert.equal(
        doorbellCam.isInKeyframeBurst(tWake + 50),
        false,
        'Must NOT trigger a 15 fps keyframe burst of old card.asleep before Frame 0 is decoded'
      );

      // Even after the first raw H.264 network packet arrives (gotVideo=true), isStreamingLive
      // must remain false until Frame 0 is decoded
      doorbellCam.markP2pVideoPacketReceived(tWake + 200);
      assert.equal(doorbellCam.hasGotVideo(), true);
      assert.equal(
        doorbellCam.isStreamingLive(tWake + 200, 2000),
        false,
        'Must NOT treat previous session lastFrame as live video before Frame 0 is decoded'
      );
      pushFrameToEncoder(doorbellCam, tWake + 250);
      assert.equal(
        writtenFrames.length,
        1,
        'Encoder stdin continues normal idle card pacing during backfill handshake instead of starving pipe:0'
      );
      writtenFrames.length = 0;

      const requiredDelayMs = computeRequiredSnapshotDelay('download');
      assert.equal(
        requiredDelayMs,
        BACKFILL_SNAP_DELAY_MS,
        'Backfill download must wait BACKFILL_SNAP_DELAY_MS for Frame 0 to traverse ' +
          'h264_vaapi -> go2rtc -> Frigate before creating the Frigate event'
      );
      assert.equal(
        doorbellCam.isReadyForEventSnapshot(tWake + 250, requiredDelayMs, 1500, 5000),
        false,
        'Must not file Frigate event before Frame 0 is decoded'
      );

      // Phase 2: Frame 0, Frame 1, Frame 2 decoded from .zxvideo
      const tFrame0 = tWake + 300;
      const frame0 = Buffer.alloc(FRAME, 0x80);
      const frame1 = Buffer.alloc(FRAME, 0x81);
      const frame2 = Buffer.alloc(FRAME, 0x82);

      assert.equal(doorbellCam.bufferDownloadFrame(frame0, 1800), false);
      doorbellCam.recordDecodedFrame(frame0, frame0, tFrame0, '20:07', 5000);
      pushFrameToEncoder(doorbellCam, tFrame0);
      assert.equal(doorbellCam.bufferDownloadFrame(frame1, 1800), true);
      assert.equal(doorbellCam.bufferDownloadFrame(frame2, 1800), true);

      assert.equal(writtenFrames.length, 1);
      assert.equal(doorbellCam.getLastSentFrameBuffer(), frame0, 'lastSent must track raw Frame 0');
      assert.equal(writtenFrames[0][0], 0x80, 'First encoded frame of backfill must be Frame 0');
      assert.equal(doorbellCam.getFrameMarker(), 'FB');
      assert.equal(
        doorbellCam.getBufferedDownloadFrames().length,
        2,
        'Frame 1 and Frame 2 are buffered behind Frame 0'
      );
      assert.equal(
        doorbellCam.getDownloadDecodedFrameCount(),
        3,
        'Tracks Frame 0 + Frame 1 + Frame 2 as 3 decoded frames'
      );
      assert.equal(doorbellCam.getDownloadPlayedFrameCount(), 1, 'Tracks Frame 0 as 1 played frame');
      assert.equal(
        doorbellCam.getDownloadVideoPacketCount(),
        1,
        'Tracks incoming P2P video packet count during download'
      );
      assert.equal(doorbellCam.getBackfillPlaybackStartedAt(), tFrame0);

      // Phase 3: Next 15 fps tick (tFrame0 + 62ms) immediately advances to Frame 1 (B) without any frozen warmup hold
      const tTick1 = tFrame0 + 62;
      pushFrameToEncoder(doorbellCam, tTick1);
      assert.equal(writtenFrames.length, 2);
      assert.equal(doorbellCam.getLastSentFrameBuffer(), frame1);
      assert.equal(writtenFrames[1][0], 0x81, 'Next 15 fps tick immediately advances to Frame 1');
      assert.equal(doorbellCam.getDownloadPlayedFrameCount(), 2);
      assert.equal(doorbellCam.getFrameMarker(), 'B');

      const transferLog = doorbellCam.formatBackfillTransferCompleteLog(1, 15);
      assert.ok(transferLog.includes('packets=1'));
      assert.ok(transferLog.includes('decodedFrames=3'));
      assert.ok(transferLog.includes('playedFrames=2'));
      assert.ok(transferLog.includes('estClipDuration=0.2s'));

      const tTick2 = tTick1 + 62;
      pushFrameToEncoder(doorbellCam, tTick2);
      assert.equal(writtenFrames.length, 3);
      assert.equal(doorbellCam.getLastSentFrameBuffer(), frame2);
      assert.equal(writtenFrames[2][0], 0x82, 'Subsequent 15 fps tick advances to Frame 2');
      assert.equal(doorbellCam.getDownloadPlayedFrameCount(), 3);

      // Phase 4: Frigate event waits for pipeline transit (BACKFILL_SNAP_DELAY_MS) after firstFrameAt
      assert.equal(
        doorbellCam.isReadyForEventSnapshot(tFrame0 + 200, requiredDelayMs, 1500, 5000),
        false,
        'Must wait while initial frames are still in flight through h264_vaapi -> go2rtc -> Frigate'
      );
      assert.equal(
        doorbellCam.isReadyForEventSnapshot(tFrame0 + BACKFILL_SNAP_DELAY_MS, requiredDelayMs, 1500, 5000),
        true,
        'Becomes ready to create Frigate event once initial frames have reached Frigate'
      );

      // Phase 5: Backfill SLEEP summary includes clipStart, clipDuration, decodedFrames,
      // playedFrames, playbackSpan, and postHold
      const sleepResult = doorbellCam.terminateSession(
        tTick2 + 2500,
        'backfill clip completed',
        false,
        'bridge-backfill'
      );
      assert.ok(sleepResult.sleepMsg.includes('clipDuration=0.2s'));
      assert.ok(sleepResult.sleepMsg.includes('decodedFrames=3'));
      assert.ok(sleepResult.sleepMsg.includes('playedFrames=3'));
      assert.ok(sleepResult.sleepMsg.includes('playbackSpan=0.1s'));
      assert.ok(sleepResult.sleepMsg.includes('postHold=2.5s'));
    }
  );

  it(
    'extracts database record candidates from explicit storage_path or synthesized ' +
      'crop_local_path and enforces time window and expiry',
    () => {
      // Verify: extracts database record candidates from explicit storage_path or synthesized crop_local_path and
      // enforces time window and expiry.
      assert.equal(extractDatabaseRecordCandidate(null), null);
      assert.equal(extractDatabaseRecordCandidate({device_sn: 'T8214T2222222222'}), null);

      const directCandidate = extractDatabaseRecordCandidate({
        device_sn: 'T8214T2222222222',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
        video_type: 1,
        cipher_id: 7,
        start_time: '2026-11-05T20:07:09Z',
      });
      assert.ok(directCandidate);
      assert.equal(directCandidate.devSn, 'T8214T2222222222');
      assert.equal(directCandidate.storagePath, '/media/mmcblk0p1/video/20261105200709.zxvideo');
      assert.equal(directCandidate.cipherId, 7);
      assert.equal(directCandidate.clipMs, Date.parse('2026-11-05T20:07:09Z'));

      const cropCandidate = extractDatabaseRecordCandidate({
        serialNumber: 'T8214T2222222222',
        crop_local_path: '/zx/hdd_data0/Camera02/202611/20261105200709/pic20261105200709.jpg',
        cipherId: 0,
        create_time: '2026-11-05T20:07:09Z',
      });
      assert.ok(cropCandidate);
      assert.equal(cropCandidate.storagePath, '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo');
      assert.equal(cropCandidate.clipMs, Date.parse('2026-11-05T20:07:09Z'));

      const tTrigger = 1793927229000;
      const job = new BackfillJob({
        at: tTrigger,
        event: 'person detected',
        personName: 'Alice',
        reason: 'person detected (Alice)',
        priority: 200,
      });
      const downloadedPaths = new Set();

      assert.equal(
        job.matchesCandidate(
          {
            devSn: 'T8214T2222222222',
            storagePath: '/path/pre_roll.zxvideo',
            clipMs: tTrigger - 40000,
          },
          downloadedPaths
        ),
        true,
        'Matches clip within 45s pre-roll window before trigger'
      );
      assert.equal(
        job.matchesCandidate(
          {
            devSn: 'T8214T2222222222',
            storagePath: '/path/too_old.zxvideo',
            clipMs: tTrigger - 46000,
          },
          downloadedPaths
        ),
        false,
        'Rejects clip older than 45s before trigger'
      );
      assert.equal(
        job.matchesCandidate(
          {
            devSn: 'T8214T2222222222',
            storagePath: '/path/too_late.zxvideo',
            clipMs: tTrigger + 185000,
          },
          downloadedPaths
        ),
        false,
        'Rejects clip more than 180s after latest trigger'
      );

      for (let i = 1; i <= BACKFILL_MAX_QUERY_ATTEMPTS; i++) {
        assert.equal(job.consumeQueryAttempt(), true);
      }
      assert.equal(
        BACKFILL_MAX_QUERY_ATTEMPTS,
        10,
        'Allows 10 query attempts (~40s after sensor clear) so 30s hardware clips finish recording'
      );
      assert.equal(job.consumeQueryAttempt(), false, 'Returns false when max query attempts are exhausted');
      assert.equal(job.isExpired(tTrigger + DEFAULT_BACKFILL_MAX_AGE_MS - 1), false);
      assert.equal(job.isExpired(tTrigger + DEFAULT_BACKFILL_MAX_AGE_MS + 1), true);
    }
  );

  it('rejects timestamp-less backfill candidates on normal jobs and parses clip timestamps across TZ values', () => {
    // Verify normal BackfillJobs reject candidates with missing clipMs (0), synthetic SIGUSR1 test jobs still
    // accept them, and extractDatabaseRecordCandidate handles ISO, epoch, and local-path timestamps across two TZs.
    const tTrigger = Date.parse('2026-11-05T20:07:09Z');
    const normalJob = new BackfillJob({
      at: tTrigger,
      event: 'motion detected',
      reason: 'motion detected',
      priority: 100,
    });
    const urgentJob = BackfillJob.createSigUsr1TestJob(tTrigger, 'doorbell');
    const noTsCandidate = extractDatabaseRecordCandidate({
      device_sn: 'SN0000000001',
      storage_path: '/media/mmcblk0p1/video/corrupt_no_ts.zxvideo',
      cipher_id: 3,
    });
    assert.ok(noTsCandidate);
    assert.equal(noTsCandidate.clipMs, 0);
    assert.equal(
      normalJob.matchesCandidate(noTsCandidate, new Set()),
      false,
      'Normal BackfillJob must reject timestamp-less candidates instead of matching arbitrary clips'
    );
    assert.equal(
      urgentJob.matchesCandidate(noTsCandidate, new Set()),
      true,
      'Synthetic SIGUSR1 urgent test job still accepts timestamp-less candidates'
    );

    const prevTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utcIsoCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
        start_time: '2026-11-05T20:07:09Z',
      });
      const utcEpochSecCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/epoch_sec.zxvideo',
        start_time: Math.floor(tTrigger / 1000),
      });
      const utcPathOnlyCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
      });
      assert.equal(utcIsoCand?.clipMs, tTrigger);
      assert.equal(utcEpochSecCand?.clipMs, tTrigger);
      assert.equal(utcPathOnlyCand?.clipMs, tTrigger);
      assert.equal(normalJob.matchesCandidate(utcPathOnlyCand, new Set()), true);

      process.env.TZ = 'America/New_York';
      const nyIsoCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105150709.zxvideo',
        start_time: '2026-11-05T15:07:09-05:00',
      });
      const nyEpochSecCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/epoch_sec.zxvideo',
        start_time: String(Math.floor(tTrigger / 1000)),
      });
      const nyPathOnlyCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105150709.zxvideo',
      });
      const nyMismatchedUtcPathCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
      });
      assert.equal(nyIsoCand?.clipMs, tTrigger);
      assert.equal(nyEpochSecCand?.clipMs, tTrigger);
      assert.equal(nyPathOnlyCand?.clipMs, tTrigger);
      assert.equal(normalJob.matchesCandidate(nyPathOnlyCand, new Set()), true);
      assert.equal(
        normalJob.matchesCandidate(nyMismatchedUtcPathCand, new Set()),
        false,
        'Path-only timestamp is interpreted in container TZ (5h offset in America/New_York)'
      );
    } finally {
      if (prevTz === undefined) {
        process.env.TZ = '';
      } else {
        process.env.TZ = prevTz;
      }
    }
  });

  it('exposes intention-revealing query/clip accessors and beginDownloadFromQueue transitions', () => {
    // Verify BackfillJob encapsulates recording, metadata, matched clip lookup, and download state transitions.
    const job = new BackfillJob({
      name: 'porch',
      at: 5000,
      event: 'person detected',
      personName: 'Alice',
      reason: 'person detected (Alice)',
      priority: 300,
      recordingActive: true,
    });
    assert.equal(job.isRecordingActive(), true);
    assert.equal(job.getPriority(), 300);
    assert.equal(job.getReason(), 'person detected (Alice)');
    assert.equal(job.getEvent(), 'person detected');
    assert.equal(job.getPersonName(), 'Alice');
    assert.equal(job.getTriggerAt(), 5000);
    assert.equal(job.getClearedAt(), 0);
    assert.equal(job.getState(), 'recording');
    assert.equal(job.getQueryAttempts(), 0);
    assert.equal(job.hasFollowUpQueried(), false);
    assert.equal(job.isRecordingNewerOrAt(5000), true);
    assert.equal(job.isRecordingNewerOrAt(4999), false);
    assert.equal(job.isSettledOrMatched(10000), false);

    job.markRecordingCleared(6000, 'person detected');
    assert.equal(job.isRecordingActive(), false);
    assert.equal(job.getClearedAt(), 6000);
    assert.equal(job.isSettledOrMatched(10000), true);

    assert.equal(job.hasMatchedClips(), false);
    assert.equal(
      job.enqueueMatchedCandidate(
        {devSn: 'SN0000000001', storagePath: '/clip_a.zxvideo', cipherId: 7, clipMs: 5500},
        new Set()
      ),
      true
    );
    assert.equal(job.hasMatchedClips(), true);
    assert.equal(job.hasMatchedClipPath('/clip_a.zxvideo'), true);
    assert.equal(job.findMatchedClipByPath('/clip_a.zxvideo')?.cipherId, 7);
    assert.deepEqual(job.getMatchedClipPaths(), ['/clip_a.zxvideo']);

    job.beginDownloadFromQueue();
    assert.equal(job.getState(), 'downloading');
    assert.equal(job.hasMatchedClips(), false);
  });
});
