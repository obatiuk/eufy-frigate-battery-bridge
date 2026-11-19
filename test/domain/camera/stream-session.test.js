/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the StreamSession domain model (src/domain/camera/stream-session.js): active stream session state,
 * hold window and duration cap math, direct RTSP probe rules, RTSP/P2P health watchdogs, and decoder backpressure.
 */
'use strict';

const {describe, it, mock, afterEach} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {StreamSession} = require('../../../src/domain/camera/stream-session');

afterEach(() => {
  mock.timers.reset();
});

/**
 * Builds a StreamSession with default test timers.
 *
 * @param {Record<string, *>} [overrides] - Optional constructor overrides.
 * @returns {StreamSession}
 */
function makeSession(overrides = {}) {
  return new StreamSession({
    directRtsp: Boolean(overrides.directRtsp),
    timers: {
      holdMs: 30000,
      lowBatHoldMs: 15000,
      maxMs: 900000,
      viewMaxMs: 300000,
      lingerMs: 15000,
      earlySleepMs: 20000,
      letEufyDecideEnd: false,
      ...(overrides.timers || {}),
    },
    onDecoderTransition: overrides.onDecoderTransition,
    onDecoderRefused: overrides.onDecoderRefused,
  });
}

describe('StreamSession lifecycle and P2P/RTSP state', () => {
  it('initializes idle fields, increments id on begin and end, and tracks slot occupancy', () => {
    // Verify: begin() and end() advance monotonic session id, reset per-session counters, and release P2P channel on
    // completed download transfer.
    const s = makeSession();
    assert.equal(s.id, 0);
    assert.equal(s.active, false);
    assert.equal(s.usesP2pSlot(), false);

    const nextState = s.begin('p2p', 1000, false);
    assert.equal(nextState, 'waking_p2p');
    assert.equal(s.id, 1);
    assert.equal(s.active, true);
    assert.equal(s.mode, 'p2p');
    assert.equal(s.p2pReady, false);
    assert.equal(s.startedAt, 1000);
    assert.equal(s.lastStartAt, 1000);
    assert.equal(s.isCurrent(1, 'p2p'), true);
    assert.equal(s.isCurrent(1, 'rtsp'), false);
    assert.equal(s.isActiveLive(), true);
    assert.equal(s.usesP2pSlot(), true);
    assert.equal(s.isOccupyingP2pChannel(false), true);

    s.markDeviceHeard();
    assert.equal(s.heardFromDevice, true);

    const p2pPacket = s.markP2pVideoPacketReceived(2500);
    assert.deepEqual(p2pPacket, {isFirstVideo: true, elapsedSec: '1.5'});
    assert.equal(s.gotVideo, true);
    assert.equal(s.firstVideoAt, 2500);
    assert.deepEqual(s.markP2pVideoPacketReceived(2600), {isFirstVideo: false, elapsedSec: '0.0'});

    s.end(4000, true);
    assert.equal(s.id, 2);
    assert.equal(s.active, false);
    assert.equal(s.mode, '');
    assert.equal(s.lastStoppedAt, 4000);
    assert.equal(s.heardFromDevice, false);
    assert.equal(s.gotVideo, true, 'gotVideo stays true after a session that had video for recent snapshot checks');

    assert.equal(s.begin('download', 5000, true), 'handshaking_backfill');
    assert.equal(s.isBackfillPlayback(), true);
    assert.equal(s.isActiveLive(), false);
    assert.equal(s.isOccupyingP2pChannel(false), true);
    assert.equal(s.isOccupyingP2pChannel(true), false);

    s.end(6000, false);
    assert.equal(s.gotVideo, false, 'ending with hadVideo=false clears gotVideo');
  });

  it('tracks P2P start attempts, failed start backoff, and RTSP re-wake transitions', () => {
    // Verify: P2P start locking, backoff, RTSP attempt dedup, re-wake minimum hold, and retry timer cleanup work.
    mock.timers.enable({apis: ['setTimeout']});
    const s = makeSession();
    s.begin('p2p', 1000, false);
    assert.equal(s.canBeginP2pStart(), true);
    const sid = s.beginP2pStartAttempt();
    assert.equal(sid, 1);
    assert.equal(s.canBeginP2pStart(), false);
    s.applyFailedStartBackoff(sid, 3000, 5000);
    assert.equal(s.lastStartAt, -2000);
    s.markP2pStreamReady(3500, true);
    assert.equal(s.canIngestP2pPacket(), true);
    assert.equal(s.lastStartAt, 3500);
    s.markP2pStreamNotReady();
    assert.equal(s.canIngestP2pPacket(), false);
    s.finishP2pStartAttempt(sid);
    assert.equal(s.starting, false);

    assert.equal(s.begin('rtsp', 10000, true), 'waking_rtsp');
    assert.equal(s.isActiveRtsp(), true);
    assert.equal(s.markRtspAttemptStart(10500), 2);
    assert.equal(s.hasRecentRtspStartAttempt(11500, 2000), true);
    assert.equal(s.hasRecentRtspStartAttempt(13000, 2000), false);
    assert.equal(s.resetStalledRtspWake(25000, 10000), true);
    assert.equal(s.startedAt, 25000);

    const firstRtsp = s.markRtspFrameReceived(26200);
    assert.deepEqual(firstRtsp, {isFirstVideo: true, isRewakeResume: false, elapsedSec: '1.2'});
    assert.equal(s.isEstablishedRtsp(), true);

    s.motionUntil = 29000;
    const remSecs = s.beginRtspRewake(27000, {minHoldMs: 10000, canExtendHold: false, baseHoldMs: 30000});
    assert.equal(remSecs, 10);
    assert.equal(s.rtspRewaking, true);
    assert.equal(s.isEstablishedRtsp(), false);
    assert.deepEqual(s.markRtspFrameReceived(28400), {isFirstVideo: false, isRewakeResume: true, elapsedSec: '1.4'});

    let retried = 0;
    s.scheduleRtspDecoderRetry(750, () => retried++);
    mock.timers.tick(750);
    assert.equal(retried, 1);
  });

  it('evaluates RTSP and P2P watchdog retries, handshakes, and timeouts', () => {
    // Verify: evaluateRtspHealth honors decoder handshake windows, retries up to maxRetries, and times out cleanly;
    // evaluateP2pHealth distinguishes viewer linger expiry from stalled stream retries and timeout.
    const s = makeSession();
    s.begin('rtsp', 1000, true);
    s.dec = {};
    s.decSpawnedAt = 10500;
    assert.equal(s.evaluateRtspHealth(11500).action, 'none', 'active RTSP handshake suppresses wake retry');

    s.decSpawnedAt = 1000;
    const retry1 = s.evaluateRtspHealth(12000);
    assert.equal(retry1.action, 'retry');
    assert.equal(retry1.killStalledDec, true);
    assert.equal(s.restarts, 1);

    s.restarts = 5;
    s.motionUntil = 40000;
    const timeout = s.evaluateRtspHealth(30000);
    assert.equal(timeout.action, 'timeout');
    assert.equal(s.motionUntil, 0);

    s.begin('p2p', 50000, true);
    s.motionUntil = 80000;
    const p2pRetry = s.evaluateP2pHealth(56000, {hasWakingViewer: false, isPiggybackedExternal: false});
    assert.equal(p2pRetry.action, 'retry');
    assert.equal(s.restarts, 1);

    s.gotVideo = true;
    s.motionUntil = 0;
    const p2pExpired = s.evaluateP2pHealth(65000, {hasWakingViewer: false, isPiggybackedExternal: false});
    assert.equal(p2pExpired.action, 'expired');
  });
});

describe('StreamSession hold window and duration caps', () => {
  it('computes trigger holds, extends active holds, and enforces max_secs and view_max_secs', () => {
    // Verify: computeTriggerHoldUntil, extendActiveHold, expireMaxDurationHold,getViewMaxDurationReason, and
    // shortenHoldOnMotionClear match AT-11 and AT-12 math.
    const s = makeSession({timers: {holdMs: 30000, maxMs: 120000, viewMaxMs: 60000, letEufyDecideEnd: true}});
    assert.equal(s.computeTriggerHoldUntil(1000, 30000, {isMidStream: false}), 31000);

    s.begin('rtsp', 1000, true);
    s.gotVideo = true;
    s.firstVideoAt = 2000;
    s.motionUntil = 31000;
    s.lastMotionAt = 1000;

    assert.equal(
      s.computeTriggerHoldUntil(20000, 30000, {minExtendMs: 5000, isMidStream: true, isCompanionBurst: false}),
      50000
    );
    assert.equal(
      s.computeTriggerHoldUntil(20000, 30000, {minExtendMs: 5000, isMidStream: true, isCompanionBurst: true}),
      50000,
      'companion burst still guarantees at least a full hold window from now'
    );

    const ext = s.extendActiveHold(25000, {
      baseHoldMs: 30000,
      minExtendMs: 5000,
      capAtFullHold: true,
      hasActiveTriggers: true,
    });
    assert.deepEqual(ext, {extended: true, extendMs: 15000, holdSecs: 21});
    assert.equal(s.motionUntil, 46000);
    assert.equal(s.runtimeExtended, true);

    const shortened = s.shortenHoldOnMotionClear(15000, 5000, 10000);
    assert.equal(shortened, 5);
    assert.equal(s.motionUntil, 20000);

    assert.equal(s.expireMaxDurationHold(120999), '');
    assert.equal(s.expireMaxDurationHold(121000), 'reached max_secs limit (2m)');
    assert.equal(s.motionUntil, 0);

    s.viewUntil = 200000;
    assert.equal(s.getViewMaxDurationReason(61000), 'reached view_max_secs limit (1m)');
  });
});

describe('StreamSession direct rtsp_url probe rules', () => {
  it('runs passive probes, classifies 404 vs network failures, and bypasses session timeouts', () => {
    // Verify: directRtsp cameras identify passive probes, classify 404 Not Found as reachable standby, and never
    // expire holds or max durations.
    const s = makeSession({directRtsp: true});
    assert.equal(s.shouldStartRtspDirect(1000, true, 5000), false);
    assert.equal(s.shouldStartRtspDirect(6000, true, 5000), true);

    s.beginRtspDirectProbe(6000, 30000);
    assert.equal(s.isPassiveRtspDirectProbe(), true);
    assert.equal(s.hasExpiredLiveHold(999999), false);
    assert.equal(s.hasReachedMaxDuration(999999), false);
    assert.equal(s.hasReachedViewMaxDuration(999999), false);

    assert.equal(StreamSession.isStandby404('Server returned 404 Not Found'), true);
    assert.equal(StreamSession.isStandby404('Connection refused'), false);

    const standbyDrop = s.evaluateRtspDirectDrop(1, 'Server returned 404 Not Found', () => ({
      isReachableStandby: true,
      disruptionChanged: true,
    }));
    assert.equal(standbyDrop.stopInitiator, 'rtsp-direct-probe');
    assert.equal(standbyDrop.isReachableStandby, true);
    assert.match(standbyDrop.statusLog, /Asleep$/);

    const netDrop = s.evaluateRtspDirectDrop(1, 'Connection refused', () => ({
      isReachableStandby: false,
      disruptionChanged: true,
    }));
    assert.equal(netDrop.isReachableStandby, false);
    assert.match(netDrop.statusLog, /Disconnected$/);

    s.gotVideo = true;
    const endedDrop = s.evaluateRtspDirectDrop(0, 'EOF', () => ({
      isReachableStandby: false,
      disruptionChanged: false,
    }));
    assert.equal(endedDrop.stopInitiator, 'eufy/rtsp-end');
    assert.equal(endedDrop.isReachableStandby, true);
  });
});

describe('StreamSession decoder backpressure FSM and packet queues', () => {
  it('transitions decoder states, pauses/resumes stdout, and drains bounded A/V packets to EOF', () => {
    // Verify: decoder FSM transitions DETACHED -> HANDSHAKING -> DECODING -> PAUSED_BACKPRESSURE -> FLUSHING_EOF ->
    // DETACHED while preserving queued packets and counting evictions.
    const transitions = [];
    const s = makeSession({
      onDecoderTransition: (prev, next, reason) => transitions.push(prev + '->' + next + ':' + reason),
    });
    s.begin('download', 1000, true);

    const writtenVideo = [];
    const writtenAudio = [];
    let paused = 0;
    let resumed = 0;
    let videoEnded = false;
    let audioEnded = false;
    const dec = {
      stdin: {
        writable: true,
        writableNeedDrain: false,
        write(pkt) {
          writtenVideo.push(pkt);
        },
        end() {
          videoEnded = true;
        },
      },
      stdout: {
        readableEnded: false,
        closed: false,
        on() {},
        pause() {
          paused++;
        },
        resume() {
          resumed++;
        },
      },
      stdio: [
        null,
        null,
        null,
        {
          writable: true,
          writableNeedDrain: false,
          write(pkt) {
            writtenAudio.push(pkt);
          },
          end() {
            audioEnded = true;
          },
        },
      ],
    };

    assert.equal(s.enqueueOrWriteAudioPacket(Buffer.from([1]), true), true, 'queues audio while decoder spawns');
    s.attachDecoder(dec, 1000, true);
    assert.equal(s.decoderState, 'handshaking');
    assert.equal(writtenAudio.length, 1);

    s.markDecoderDecoding();
    assert.equal(s.decoderState, 'decoding');

    s.pauseDecoderStdout();
    assert.equal(s.decoderState, 'paused_backpressure');
    assert.equal(paused, 1);

    s.enqueueOrWriteVideoPacket(Buffer.from([9]), true);
    assert.equal(writtenVideo.length, 0, 'video packet stays queued while stdout is paused');
    assert.equal(s.hasPendingVideoPackets(), true);

    s.markDecoderInputEnded(true);
    assert.equal(videoEnded, false, 'stdin stays open until paused video packet drains');
    assert.equal(audioEnded, true, 'audio pipe closes immediately when audio queue is empty');

    s.resumeDecoderStdout(true);
    assert.equal(resumed, 1);
    assert.equal(writtenVideo.length, 1);
    assert.equal(videoEnded, true);
    assert.equal(s.decoderState, 'flushing_eof');
    assert.equal(s.shouldDeferDecoderDetachOnExit(dec), true);

    s.updateStreamFormat('h264', 1920, 1080);
    assert.equal(s.hasResolutionChanged(2560, 1440), true);
    assert.equal(s.hasCodecChanged('hevc'), true);

    assert.equal(s.detachDecoder(), dec);
    assert.equal(s.decoderState, 'detached');
    assert.equal(s.videoCodec, '');
    assert.deepEqual(transitions, [
      'detached->handshaking:decoder attached',
      'handshaking->decoding:first frame decoded',
      'decoding->paused_backpressure:high watermark reached',
      'paused_backpressure->decoding:low watermark resumed',
      'decoding->flushing_eof:input pipe ended',
      'flushing_eof->detached:decoder detached',
    ]);
  });

  it('reports refused decoder state transitions via onDecoderRefused without mutating decoderState', () => {
    // Verify: disallowed decoder transitions invoke onDecoderRefused and preserve the current decoderState.
    const refused = [];
    const s = makeSession({
      onDecoderRefused: (prev, next, reason) => {
        refused.push(prev + '->' + next + ':' + reason);
      },
    });
    assert.equal(s.transitionDecoderTo('decoding', 'skipped handshaking'), 'detached');
    assert.equal(s.decoderState, 'detached');
    assert.deepEqual(refused, ['detached->decoding:skipped handshaking']);
  });
});
