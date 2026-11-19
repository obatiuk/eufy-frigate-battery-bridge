/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the BackfillState domain model (src/domain/camera/backfill-state.js): pending/queued/active
 * BackfillJob queues, chronological clip matching, bounded downloaded path history, and retry/follow-up rules.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {
  DOWNLOAD_FRAME_HIGH_WATERMARK,
  MAX_DOWNLOADED_PATHS_HISTORY,
  BackfillState,
} = require('../../../src/domain/camera/backfill-state');

/**
 * Builds a BackfillState instance with default test parameters.
 *
 * @param {Record<string, *>} [overrides] - Optional constructor overrides.
 * @returns {BackfillState}
 */
function makeBackfill(overrides = {}) {
  return new BackfillState({
    name: 'porch',
    priority: 100,
    holdMs: 30000,
    alwaysBackfill: false,
    backfillDownloads: true,
    ...overrides,
  });
}

describe('BackfillState job queuing, upgrades, and settled split-job preservation', () => {
  it('queues events, upgrades companion labels in place, and queues a follow-on job once settled', () => {
    // Verify: companion events upgrade an in-recording pending job, while a new trigger after settle keeps the
    // settled job queryable and creates queuedBackfillJob (AT-15, AT-16).
    const bf = makeBackfill({alwaysBackfill: true});
    assert.equal(bf.hasPending(), false);

    bf.queueEvent(1000, {
      eventName: 'motion detected',
      personName: '',
      reason: 'motion detected',
      evPriority: 10,
      recordingActive: true,
      activeEvents: ['motion detected'],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    assert.equal(bf.hasPending(), true);
    assert.equal(bf.getPriority(), 110);

    bf.queueEvent(2000, {
      eventName: 'person detected',
      personName: 'Alice',
      reason: 'person detected (Alice)',
      evPriority: 300,
      recordingActive: true,
      activeEvents: ['motion detected', 'person detected'],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    assert.equal(bf.pending.personName, 'Alice');
    assert.equal(bf.getPriority(), 400);
    assert.equal(bf.queued, null);

    bf.markTriggersCleared(5000, '', []);
    assert.equal(bf.isRecordingCleared(), true);
    assert.equal(bf.canQuery(9500, true, {minEventAgeMs: 4000, queryCooldownMs: 4000}), true);

    bf.queueEvent(10000, {
      eventName: 'vehicle detected',
      personName: '',
      reason: 'vehicle detected',
      evPriority: 100,
      recordingActive: true,
      activeEvents: ['vehicle detected'],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    assert.equal(bf.pending.recordingActive, false, 'settled pending job stays settled');
    assert.ok(bf.queued, 'follow-on trigger queues a second BackfillJob');
    assert.equal(bf.queued.event, 'vehicle detected');
  });

  it('upgrades existing jobs on /api/wake without clobbering specific Eufy event labels', () => {
    // Verify: queueOrUpgradeApiWake raises priority and reason while keeping the hardware event label.
    const bf = makeBackfill({alwaysBackfill: true});
    bf.queueEvent(1000, {
      eventName: 'person detected',
      personName: 'Bob',
      reason: 'person detected',
      evPriority: 200,
      recordingActive: true,
      activeEvents: ['person detected'],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    const upgraded = bf.queueOrUpgradeApiWake(2000, 'gate sensor', {evPriority: 250});
    assert.equal(upgraded, true);
    assert.equal(bf.pending.event, 'person detected');
    assert.equal(bf.pending.personName, 'Bob');
    assert.equal(bf.pending.reason, 'gate sensor');
    assert.equal(bf.getPriority(), 350);
  });
});

describe('BackfillState clip matching, download retries, and bounded history', () => {
  it('matches clips chronologically and retries interrupted downloads up to 3 attempts', () => {
    // Verify: tryMatchCandidate sorts oldest-first, prepareDownload advances attempts, and finalizeDownloadEnd
    // re-queues failed clips below 3 attempts and schedules follow-up queries on extended activity (AT-16).
    const bf = makeBackfill({alwaysBackfill: true});
    bf.queueEvent(10000, {
      eventName: 'person detected',
      personName: '',
      reason: 'person detected',
      evPriority: 200,
      recordingActive: false,
      activeEvents: [],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });

    assert.equal(bf.tryMatchCandidate({devSn: 'SN1', storagePath: '/b.zxvideo', cipherId: 2, clipMs: 12000}), true);
    assert.equal(bf.tryMatchCandidate({devSn: 'SN1', storagePath: '/a.zxvideo', cipherId: 1, clipMs: 9000}), true);
    assert.equal(bf.clip.storagePath, '/a.zxvideo');
    assert.equal(bf.clipQueue.length, 2);

    const activeClip1 = bf.prepareDownload(bf.clip, 20000);
    assert.equal(activeClip1.downloadAttempts, 1);
    assert.equal(bf.downloadedPaths.has('/a.zxvideo'), true);
    assert.equal(bf.clip.storagePath, '/b.zxvideo');

    bf.finalizeDownloadEnd(22000, false, false);
    assert.equal(bf.clip.storagePath, '/a.zxvideo', 'failed attempt 1 re-queues at front of clipQueue');
    assert.equal(bf.downloadedPaths.has('/a.zxvideo'), false);
    assert.equal(bf.isReadyForDownload(23000, false, 4000), false, '4s retry cooldown blocks immediate retry');
    assert.equal(bf.isReadyForDownload(26500, false, 4000), true);

    bf.prepareDownload(bf.clip, 27000);
    bf.finalizeDownloadEnd(28000, true, false);
    assert.equal(bf.continuation, true, 'remaining clip keeps continuation true');
    assert.equal(bf.clip.storagePath, '/b.zxvideo');
  });

  it('schedules an immediate follow-up database query when activity extends at least 15s past the clip', () => {
    // Verify: finalizeDownloadEnd resets lastQueryAt and sets followUpQueried when activity outlasts clipMs by >=15s.
    const bf = makeBackfill({alwaysBackfill: true});
    bf.queueEvent(10000, {
      eventName: 'person detected',
      personName: '',
      reason: 'person detected',
      evPriority: 200,
      recordingActive: false,
      activeEvents: [],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    bf.pending.lastActivityAt = 35000;
    assert.equal(bf.tryMatchCandidate({devSn: 'SN1', storagePath: '/c.zxvideo', cipherId: 3, clipMs: 12000}), true);
    bf.prepareDownload(bf.clip, 20000);
    bf.finalizeDownloadEnd(25000, true, false);
    assert.equal(bf.shouldClearStationQueryCooldown('download'), true);
    assert.equal(bf.pending.followUpQueried, true);
  });

  it('bounds downloadedPaths FIFO history and signals decoder pause at high watermark', () => {
    // Verify: recordDownloadedPath caps Set size at MAX_DOWNLOADED_PATHS_HISTORY and bufferFrame triggers pause at
    // DOWNLOAD_FRAME_HIGH_WATERMARK.
    const bf = makeBackfill();
    for (let i = 0; i < MAX_DOWNLOADED_PATHS_HISTORY + 5; i++) {
      bf.recordDownloadedPath('/clip_' + i + '.zxvideo');
    }
    assert.equal(bf.downloadedPaths.size, MAX_DOWNLOADED_PATHS_HISTORY);
    assert.equal(bf.downloadedPaths.has('/clip_0.zxvideo'), false);
    assert.equal(bf.downloadedPaths.has('/clip_' + (MAX_DOWNLOADED_PATHS_HISTORY + 4) + '.zxvideo'), true);

    assert.equal(bf.bufferFrame(false, Buffer.alloc(4), 50).buffered, false, 'Frame 0 commits directly');
    let paused = false;
    for (let i = 0; i < DOWNLOAD_FRAME_HIGH_WATERMARK; i++) {
      const res = bf.bufferFrame(true, Buffer.alloc(4), 50);
      paused = paused || res.shouldPauseDecoder;
    }
    assert.equal(paused, true);
    assert.equal(bf.decodedFrames, DOWNLOAD_FRAME_HIGH_WATERMARK);
  });

  it('preserves active download and promotes queuedBackfillJob when pendingBackfill exhausts queries', () => {
    // Verify: Regression 40 behavior - exhausting query attempts on pending promotes queued without dropping active.
    const bf = makeBackfill({alwaysBackfill: true});
    bf.queueEvent(1000, {
      eventName: 'motion',
      personName: '',
      reason: 'first',
      evPriority: 10,
      recordingActive: false,
      activeEvents: [],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    bf.pending.clearedAt = 1000;
    bf.queueEvent(10000, {
      eventName: 'person',
      personName: '',
      reason: 'second',
      evPriority: 200,
      recordingActive: true,
      activeEvents: ['person'],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    const out = bf.beginDatabaseQuery(12000, false, 0);
    assert.equal(out.allowed, false);
    assert.equal(bf.pending.reason, 'second');
    assert.equal(bf.queued, null);
  });

  it('manages live session reset helpers and continuation state via explicit methods', () => {
    // Verify: resetTransferState, clearActiveForLiveSession, clearActiveClipAfterLiveEnd, and hasContinuation
    // encapsulate live/download session transitions without external field mutation.
    const bf = makeBackfill({alwaysBackfill: true});
    bf.queueEvent(1000, {
      eventName: 'motion detected',
      personName: '',
      reason: 'motion detected',
      evPriority: 10,
      recordingActive: false,
      activeEvents: [],
      isLiveWithVideo: false,
      runtimeExtended: false,
    });
    bf.tryMatchCandidate({
      devSn: 'SN0000000901',
      storagePath: '/clip_live_reset.zxvideo',
      cipherId: 1,
      clipMs: 1000,
    });
    bf.prepareDownload(bf.clip, 2000);
    bf.bufferFrame(true, Buffer.alloc(4), 10);
    bf.markTransferFinished(3000, 0);
    bf.continuation = true;

    assert.equal(bf.hasContinuation(), true);
    bf.resetTransferState();
    assert.equal(bf.finished, false);
    assert.equal(bf.finishedAt, 0);
    assert.equal(bf.frames.length, 0);

    bf.clearActiveForLiveSession();
    assert.equal(bf.active, null);
    assert.equal(bf.hasContinuation(), false);

    bf.continuation = true;
    bf.clearActiveClipAfterLiveEnd();
    assert.equal(bf.activeClip, null);
    assert.equal(bf.hasContinuation(), false);
  });
});
