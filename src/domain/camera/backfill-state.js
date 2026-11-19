// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * HomeBase clip backfill state of one camera: pending/queued/active BackfillJob lifecycle, chronological clip queue,
 * bounded downloaded path history, retry cooldowns, follow-up split-clip scheduling, and playback counters.
 */
'use strict';

const {LIVE_FPS, DEFAULT_EVENT_PRIORITY, STREAM_MODES} = require('../../config');
const {formatLocalTimestamp} = require('../../logger');
const {
  BACKFILL_POST_CLEAR_SETTLE_MS,
  BACKFILL_RECORDING_WAIT_CAP_MS,
  BACKFILL_MAX_QUERY_ATTEMPTS,
  BackfillJob,
} = require('../backfill-job');

const MS_PER_SECOND = 1000;
const ISO_TIME_START_INDEX = 11;
const DOWNLOAD_EOF_FLUSH_SETTLE_MS = 1000;
const DOWNLOAD_EVENT_DURATION_MARGIN_SECS = 6;
const DOWNLOAD_FRAME_HIGH_WATERMARK = 30;
const DOWNLOAD_FRAME_LOW_WATERMARK = 10;
const MAX_BACKFILL_CLIP_DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS = 4000;
const MAX_DOWNLOADED_PATHS_HISTORY = 500;
const DEFAULT_DOWNLOAD_IDLE_COMPLETE_MS = 3000;
const DEFAULT_DOWNLOAD_POST_PLAYBACK_HOLD_MS = 2500;
const DEFAULT_DOWNLOAD_MIN_PLAYBACK_MS = 4500;
const DEFAULT_MOTION_LABEL = 'motion';
const DEFAULT_MOTION_EVENT = 'motion detected';
const DOWNLOAD_COMPLETED_INITIATOR = 'eufy/download-finished';

/**
 * Formats an epoch millisecond timestamp as local 'HH:MM:SS' (or 'n/a' when <= 0).
 *
 * @param {number} ms - Epoch timestamp in milliseconds.
 * @returns {string}
 */
function formatEpochHms(ms) {
  return ms > 0 ? formatLocalTimestamp(new Date(ms)).slice(ISO_TIME_START_INDEX) : 'n/a';
}

/**
 * Returns true when a stopped backfill download counts as complete rather than an interrupted transfer.
 *
 * @param {boolean} downloadFinished - Whether the 'download finished' transfer event was received.
 * @param {string} initiator - Decision maker identifier of the stop.
 * @returns {boolean}
 */
function isCompletedDownloadStop(downloadFinished, initiator) {
  return downloadFinished || initiator === DOWNLOAD_COMPLETED_INITIATOR;
}

/**
 * @typedef {{
 *   storagePath: string,
 *   cipherId: number,
 *   clipMs?: number,
 *   downloadAttempts?: number,
 *   event: string,
 *   personName: string,
 *   reason: string,
 * }} MatchedBackfillClip
 */

/**
 * Owns per-camera HomeBase backfill jobs, matched clip queues, downloaded path history, and playback counters.
 */
class BackfillState {
  /**
   * @param {{
   *   name: string,
   *   priority: number,
   *   holdMs: number,
   *   alwaysBackfill: boolean,
   *   backfillDownloads: boolean,
   * }} opts - Static camera backfill options.
   */
  constructor(opts) {
    this.name = String(opts.name || 'backfill');
    this.priority = Number(opts.priority) || 0;
    this.holdMs = Number(opts.holdMs) || 0;
    this.alwaysBackfill = Boolean(opts.alwaysBackfill);
    this.backfillDownloads = Boolean(opts.backfillDownloads);

    /** @type {BackfillJob|null} */
    this.pending = null;
    /** @type {BackfillJob|null} */
    this.queued = null;
    /** @type {BackfillJob|null} */
    this.active = null;
    /** @type {MatchedBackfillClip|null} */
    this.activeClip = null;
    /** @type {MatchedBackfillClip|null} */
    this.clip = null;
    /** @type {MatchedBackfillClip[]} */
    this.clipQueue = [];
    this.lastDownloadedClipMs = 0;
    this.lastQueryAt = 0;
    this.lastDownloadFailedAt = 0;
    /** @type {Set<string>} */
    this.downloadedPaths = new Set();
    /** @type {Uint8Array[]} */
    this.frames = [];
    this.finished = false;
    this.finishedAt = 0;
    this.clipStartMs = 0;
    this.triggerAtMs = 0;
    this.playbackStartedAt = 0;
    this.videoPackets = 0;
    this.decodedFrames = 0;
    this.playedFrames = 0;
    this.continuation = false;
    /** @type {Record<string, *>|null} */
    this.lastSessionEventInfo = null;
  }

  /**
   * Returns the maximum hardware recording wait duration in milliseconds for this camera.
   *
   * @returns {number}
   */
  _maxRecordingWaitMs() {
    return Math.max(BACKFILL_RECORDING_WAIT_CAP_MS, this.holdMs + BACKFILL_POST_CLEAR_SETTLE_MS);
  }

  /**
   * Clears pending, queued, and active backfill jobs/clips and continuation state.
   */
  clearPending() {
    this.pending = null;
    this.queued = null;
    this.active = null;
    this.activeClip = null;
    this.clip = null;
    this.clipQueue = [];
    this.lastDownloadFailedAt = 0;
    this.continuation = false;
  }

  /**
   * Resets per-session transfer and frame-buffer fields when any stream session ends.
   */
  resetTransferState() {
    this.finished = false;
    this.finishedAt = 0;
    this.frames = [];
  }

  /**
   * Clears active backfill job and continuation state when starting a live (non-download) session.
   */
  clearActiveForLiveSession() {
    this.active = null;
    this.continuation = false;
  }

  /**
   * Clears active clip and continuation state when ending a live (non-download) session.
   */
  clearActiveClipAfterLiveEnd() {
    this.activeClip = null;
    this.continuation = false;
  }

  /**
   * Returns true if a pending/queued BackfillJob or matched clip is waiting to be queried or downloaded.
   *
   * @returns {boolean}
   */
  hasPending() {
    return Boolean(this.pending || this.queued || this.clip || this.clipQueue.length > 0);
  }

  /**
   * Returns true while a backfill clip sequence continues after the current download finishes.
   *
   * @returns {boolean}
   */
  hasContinuation() {
    return Boolean(this.continuation);
  }

  /**
   * Returns true if an urgent SIGUSR1 test BackfillJob is queued.
   *
   * @returns {boolean}
   */
  hasUrgentTest() {
    return Boolean(this.pending && this.pending.isUrgentTest());
  }

  /**
   * Returns true if pendingBackfill exists and its hardware recording has cleared.
   *
   * @returns {boolean}
   */
  isRecordingCleared() {
    return Boolean(this.pending && !this.pending.isRecordingActive());
  }

  /**
   * Returns true if pendingBackfill is waiting for Frigate object confirmation.
   *
   * @param {boolean} frigateSawObject - Whether Frigate already detected a live object in this session.
   * @returns {boolean}
   */
  needsObjectCheck(frigateSawObject) {
    return Boolean(this.pending && !frigateSawObject);
  }

  /**
   * Returns the effective priority of the pending or active BackfillJob (or 0 if none).
   *
   * @returns {number}
   */
  getPriority() {
    const job = this.pending || this.active;
    return job ? job.getPriority() || 0 : 0;
  }

  /**
   * Returns the human-readable reason of the pending or active BackfillJob.
   *
   * @param {string} [fallback='backfill'] - Fallback string when no job is present.
   * @returns {string}
   */
  getReason(fallback = 'backfill') {
    const job = this.pending || this.active;
    return (job && job.getReason()) || fallback;
  }

  /**
   * Returns true if pendingBackfill still needs a station.database_query_latest_info fallback query.
   *
   * @returns {boolean}
   */
  needsLatestInfoQuery() {
    return Boolean(this.pending && !this.clip);
  }

  /**
   * Returns true if the camera is inactive, has a matched clip, and is past any post-failure retry cooldown.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} isSessionActive - Whether a camera session is currently active.
   * @param {number} [retryCooldownMs=DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS] - Retry cooldown in ms.
   * @returns {boolean}
   */
  isReadyForDownload(now, isSessionActive, retryCooldownMs = DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS) {
    const cooldownElapsed = !this.lastDownloadFailedAt || now - this.lastDownloadFailedAt >= retryCooldownMs;
    return Boolean(this.clip && !isSessionActive && cooldownElapsed);
  }

  /**
   * Returns true if this camera is ready to query the HomeBase database for a backfill clip.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} canQueryInState - True when idle or draining a completed transfer tail.
   * @param {{ minEventAgeMs: number, queryCooldownMs: number }} timing - Query timing thresholds.
   * @returns {boolean}
   */
  canQuery(now, canQueryInState, timing) {
    return canQueryInState && this.pending && !this.clip && now - this.lastQueryAt >= timing.queryCooldownMs
      ? this.pending.isReadyToQuery(now, timing.minEventAgeMs, this._maxRecordingWaitMs())
      : false;
  }

  /**
   * Returns true if the pending or active job is settled enough to accept a station-wide database query result.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [minEventAgeMs=BACKFILL_POST_CLEAR_SETTLE_MS] - Minimum event age in milliseconds.
   * @returns {boolean}
   */
  canMatchQueryResult(now, minEventAgeMs = BACKFILL_POST_CLEAR_SETTLE_MS) {
    if (this.active) {
      return true;
    }
    if (!this.pending) {
      return false;
    }
    if (!this.pending.isRecordingActive()) {
      return true;
    }
    return this.pending.isReadyToQuery(now, minEventAgeMs, this._maxRecordingWaitMs());
  }

  /**
   * Attempts to match a parsed HomeBase database clip candidate against pending or active BackfillJob.
   *
   * @param {{ devSn: string, storagePath: string, cipherId: number, clipMs: number }} candidate - Parsed DB row.
   * @returns {boolean} True if matched and queued for download.
   */
  tryMatchCandidate(candidate) {
    const job = this.pending || this.active;
    if (!job || !candidate) {
      return false;
    }
    if (this.queued && this.queued.isRecordingNewerOrAt(candidate.clipMs)) {
      return false;
    }
    if (job.isUrgentTest() && this.clip) {
      return false;
    }
    if (this.clipQueue.some((c) => c.storagePath === candidate.storagePath)) {
      return false;
    }
    if (!job.enqueueMatchedCandidate(candidate, this.downloadedPaths)) {
      return false;
    }
    const newlyMatched = job.findMatchedClipByPath(candidate.storagePath);
    if (newlyMatched) {
      this.clipQueue.push(newlyMatched);
      if (!job.isUrgentTest()) {
        this.clipQueue.sort((a, b) => (a.clipMs || 0) - (b.clipMs || 0));
      }
    }
    this.clip = this.clipQueue[0] || null;
    return true;
  }

  /**
   * Formats a structured log line when a HomeBase database record matches a pending or active BackfillJob.
   *
   * @param {{ storagePath: string, cipherId: number, clipMs?: number }} candidate - Matched DB row.
   * @returns {string}
   */
  formatClipMatchLog(candidate) {
    const job = this.pending || this.active;
    const clipMs = candidate && candidate.clipMs ? candidate.clipMs : 0;
    const triggerMs = job ? job.getTriggerAt() || 0 : 0;
    const clearedMs = job ? job.getClearedAt() || 0 : 0;
    const preRollStr = clipMs > 0 && triggerMs > 0 ? ((triggerMs - clipMs) / MS_PER_SECOND).toFixed(1) + 's' : 'n/a';
    const sensorSpanStr =
      triggerMs > 0 && clearedMs >= triggerMs ? ((clearedMs - triggerMs) / MS_PER_SECOND).toFixed(1) + 's' : 'active';
    return (
      'matched recorded HomeBase clip for backfill (path="' +
      candidate.storagePath +
      '", clipStart=' +
      formatEpochHms(clipMs) +
      ', triggerAt=' +
      formatEpochHms(triggerMs) +
      ', clearedAt=' +
      formatEpochHms(clearedMs) +
      ', preRoll=' +
      preRollStr +
      ', sensorSpan=' +
      sensorSpanStr +
      ', cipherId=' +
      candidate.cipherId +
      ', reason="' +
      this.getReason('backfill') +
      '")'
    );
  }

  /**
   * Records a downloaded HomeBase clip path in bounded FIFO order.
   *
   * @param {string} storagePath - HomeBase clip storage path.
   */
  recordDownloadedPath(storagePath) {
    if (!storagePath) {
      return;
    }
    if (this.downloadedPaths.has(storagePath)) {
      this.downloadedPaths.delete(storagePath);
    } else {
      while (this.downloadedPaths.size >= MAX_DOWNLOADED_PATHS_HISTORY) {
        const oldest = this.downloadedPaths.values().next().value;
        if (oldest === undefined) {
          break;
        }
        this.downloadedPaths.delete(oldest);
      }
    }
    this.downloadedPaths.add(storagePath);
  }

  /**
   * Advances job/clip queues and resets download counters when starting a clip download.
   *
   * @param {{
   *   storagePath: string,
   *   cipherId: number,
   *   clipMs?: number,
   *   downloadAttempts?: number,
   *   event: string,
   *   personName: string,
   *   reason: string,
   * }} clip - Matched clip descriptor.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {Readonly<Record<string, *>>} Active frozen clip descriptor with incremented downloadAttempts.
   */
  prepareDownload(clip, now) {
    if (
      this.pending &&
      (!this.active || this.pending.hasMatchedClipPath(clip.storagePath) || this.pending.isUrgentTest())
    ) {
      this.active = this.pending;
      this.pending = this.queued;
      this.queued = null;
    }
    if (this.active) {
      this.active.beginDownloadFromQueue();
    }
    const nextAttempt = (Number(clip.downloadAttempts) || 0) + 1;
    this.activeClip = Object.freeze({...clip, downloadAttempts: nextAttempt});
    this.clipQueue = this.clipQueue.filter((item) => item.storagePath !== clip.storagePath);
    this.clip = this.clipQueue[0] || null;
    this.recordDownloadedPath(clip.storagePath);
    this.lastDownloadedClipMs = clip.clipMs || now;
    this.clipStartMs = clip.clipMs || 0;
    this.triggerAtMs = this.active ? this.active.getTriggerAt() || 0 : 0;
    this.playbackStartedAt = 0;
    this.videoPackets = 0;
    this.decodedFrames = 0;
    this.playedFrames = 0;
    this.finished = false;
    this.finishedAt = 0;
    this.frames = [];
    return this.activeClip;
  }

  /**
   * Re-queues an interrupted or failed download clip at the front of clipQueue when attempts remain.
   *
   * @param {MatchedBackfillClip|null} activeClip - Active clip descriptor from the ended download.
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  _requeueFailedClip(activeClip, now) {
    if (!activeClip) {
      return;
    }
    const attempts = Number(activeClip.downloadAttempts) || 1;
    if (attempts >= MAX_BACKFILL_CLIP_DOWNLOAD_ATTEMPTS) {
      return;
    }
    this.downloadedPaths.delete(activeClip.storagePath);
    this.clipQueue = [activeClip, ...this.clipQueue.filter((item) => item.storagePath !== activeClip.storagePath)];
    this.clip = this.clipQueue[0] || null;
    if (this.active && !this.pending) {
      this.active.requeueAfterFailedDownload();
      this.pending = this.active;
    }
    this.lastDownloadFailedAt = now;
  }

  /**
   * Finalizes clip/job queues, follow-up queries, and continuation state when a DOWNLOAD session ends.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean|undefined} hadVideo - Whether decoded video was received during the download.
   * @param {boolean} preemptedByViewer - Whether stopped due to viewer switching cameras.
   */
  finalizeDownloadEnd(now, hadVideo, preemptedByViewer) {
    const activeClip = this.activeClip;
    const downloadSucceeded = hadVideo === undefined ? true : Boolean(hadVideo);
    this.activeClip = null;
    if (downloadSucceeded) {
      this.lastDownloadFailedAt = 0;
    } else if (!preemptedByViewer) {
      this._requeueFailedClip(activeClip, now);
    }
    if (!this.pending && this.queued) {
      this.pending = this.queued;
      this.queued = null;
    }
    const shouldPrepareFollowUp = Boolean(
      downloadSucceeded &&
      !preemptedByViewer &&
      !this.pending &&
      this.clipQueue.length === 0 &&
      this.active &&
      this.active.needsFollowUpClipQuery(this.lastDownloadedClipMs)
    );
    if (shouldPrepareFollowUp && this.active) {
      this.active.prepareFollowUpQuery(now);
      this.pending = this.active;
      this.lastQueryAt = 0;
    }
    this.continuation = Boolean(
      !preemptedByViewer && downloadSucceeded && (this.clipQueue.length > 0 || Boolean(this.pending))
    );
    this._completeActiveAfterDownload(downloadSucceeded && !preemptedByViewer);
  }

  /**
   * Updates active job state once a download attempt finishes or yields to remaining clips.
   *
   * @param {boolean} completedCleanly - Whether the clip finished cleanly without viewer preemption.
   */
  _completeActiveAfterDownload(completedCleanly) {
    if (this.clipQueue.length === 0) {
      if (this.active && !this.pending) {
        this.active.completeCurrentDownload();
      }
      this.active = null;
      return;
    }
    if (completedCleanly && this.active && !this.pending && this.active.hasMatchedClips()) {
      this.active.completeCurrentDownload();
    }
  }

  /**
   * Returns true when a completed download prepared an immediate split-clip follow-up query.
   *
   * @param {string} closedMode - Stream mode that just ended.
   * @returns {boolean}
   */
  shouldClearStationQueryCooldown(closedMode) {
    return closedMode === STREAM_MODES.DOWNLOAD
      ? Boolean(this.pending && this.pending.hasFollowUpQueried() && this.lastQueryAt === 0)
      : false;
  }

  /**
   * Drops only an expired or query-exhausted pending job while preserving queued and active jobs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} isSessionActive - Whether the camera currently has an active stream session.
   * @returns {boolean} True when inactive with no remaining pending backfill (caller should clear triggers).
   */
  dropUnfulfilledPending(now, isSessionActive) {
    const droppedJob = this.pending;
    const nextJob = this.queued && !this.queued.expireIfNeeded(now) ? this.queued : null;
    this.pending = nextJob;
    this.queued = null;
    if (nextJob) {
      this.lastQueryAt = 0;
    }
    if (droppedJob && droppedJob.hasMatchedClips()) {
      const droppedPaths = new Set(droppedJob.getMatchedClipPaths());
      this.clipQueue = this.clipQueue.filter((c) => !droppedPaths.has(c.storagePath));
      this.clip = this.clipQueue[0] || null;
    }
    if (!isSessionActive && this.active === droppedJob) {
      this.active = null;
    }
    if (!isSessionActive && !this.hasPending()) {
      this.continuation = false;
      this.lastDownloadFailedAt = 0;
      return true;
    }
    return false;
  }

  /**
   * Expires unfulfilled pending/queued jobs past maxAgeMs and advances settled jobs to READY_TO_QUERY.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} isSessionActive - Whether a camera session is active.
   * @param {number} [minEventAgeMs=BACKFILL_POST_CLEAR_SETTLE_MS] - Minimum event age before READY_TO_QUERY.
   * @returns {{ expiredReason: string, droppedPending: boolean, shouldClearTriggers: boolean }}
   */
  expireIfNeeded(now, isSessionActive, minEventAgeMs = BACKFILL_POST_CLEAR_SETTLE_MS) {
    if (this.queued && this.queued.expireIfNeeded(now)) {
      this.queued = null;
    }
    let expiredReason = '';
    let droppedPending = false;
    let shouldClearTriggers = false;
    if (this.pending && this.pending.expireIfNeeded(now)) {
      expiredReason = this.pending.getReason();
      droppedPending = true;
      shouldClearTriggers = this.dropUnfulfilledPending(now, isSessionActive);
    }
    const maxWaitMs = this._maxRecordingWaitMs();
    if (this.pending) {
      this.pending.markReadyToQueryIfSettled(now, minEventAgeMs, maxWaitMs);
    }
    if (this.queued) {
      this.queued.markReadyToQueryIfSettled(now, minEventAgeMs, maxWaitMs);
    }
    return {expiredReason, droppedPending, shouldClearTriggers};
  }

  /**
   * Consumes one HomeBase database query attempt on pendingBackfill and returns an outcome descriptor.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} isSessionActive - Whether a camera session is active.
   * @param {number} [maxAttempts=BACKFILL_MAX_QUERY_ATTEMPTS] - Maximum allowed query attempts.
   * @returns {{
   *   allowed: boolean,
   *   attempts: number,
   *   maxAttempts: number,
   *   reason: string,
   *   droppedPending: boolean,
   *   shouldClearTriggers: boolean,
   * }}
   */
  beginDatabaseQuery(now, isSessionActive, maxAttempts = BACKFILL_MAX_QUERY_ATTEMPTS) {
    if (!this.pending) {
      return {allowed: false, attempts: 0, maxAttempts, reason: '', droppedPending: false, shouldClearTriggers: false};
    }
    this.pending.markReadyToQueryIfSettled(now, BACKFILL_POST_CLEAR_SETTLE_MS, this._maxRecordingWaitMs());
    const reason = this.pending.getReason();
    const allowed = this.pending.consumeQueryAttempt(maxAttempts);
    const attempts = this.pending.getQueryAttempts();
    let shouldClearTriggers = false;
    if (allowed) {
      this.lastQueryAt = now;
    } else {
      shouldClearTriggers = this.dropUnfulfilledPending(now, isSessionActive);
    }
    return {allowed, attempts, maxAttempts, reason, droppedPending: !allowed, shouldClearTriggers};
  }

  /**
   * Marks transfer finished and returns remaining buffered frames plus pending compressed video packets.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} pendingVideoPacketsCount - Queued compressed video packet count.
   * @returns {number}
   */
  markTransferFinished(now, pendingVideoPacketsCount) {
    this.finished = true;
    this.finishedAt = now;
    return this.frames.length + pendingVideoPacketsCount;
  }

  /**
   * Evaluates whether an active backfill download has completed transfer, pipe drain, and post-playback hold.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {{
   *   hasDecodedFrame: boolean,
   *   gotVideo: boolean,
   *   allPipesDrained: boolean,
   *   hasDec: boolean,
   *   startedAt: number,
   *   lastVideoAt: number,
   *   idleCompleteMs?: number,
   *   postPlaybackHoldMs?: number,
   *   minPlaybackMs?: number,
   * }} ctx - Session and pipe state plus timing thresholds.
   * @returns {boolean}
   */
  isDownloadComplete(now, ctx) {
    const idleCompleteMs = ctx.idleCompleteMs ?? DEFAULT_DOWNLOAD_IDLE_COMPLETE_MS;
    const postPlaybackHoldMs = ctx.postPlaybackHoldMs ?? DEFAULT_DOWNLOAD_POST_PLAYBACK_HOLD_MS;
    const minPlaybackMs = ctx.minPlaybackMs ?? DEFAULT_DOWNLOAD_MIN_PLAYBACK_MS;
    const readyToComplete = Boolean(
      ctx.hasDecodedFrame &&
      ctx.gotVideo &&
      this.frames.length === 0 &&
      ctx.allPipesDrained &&
      (minPlaybackMs <= 0 || now - ctx.startedAt >= minPlaybackMs)
    );
    const decoderFlushed =
      !ctx.hasDec || now - Math.max(this.finishedAt || 0, ctx.lastVideoAt || 0) >= DOWNLOAD_EOF_FLUSH_SETTLE_MS;
    const effectivePostHoldMs = this.clipQueue.length > 0 || Boolean(this.pending) ? 0 : postPlaybackHoldMs;
    return readyToComplete
      ? this.finished
        ? Boolean(decoderFlushed && now - ctx.lastVideoAt >= effectivePostHoldMs)
        : now - ctx.lastVideoAt > idleCompleteMs
      : false;
  }

  /**
   * Buffers a decoded backfill frame after Frame 0 and reports whether to pause decoder stdout.
   *
   * @param {boolean} hasCurrentFrame - True once Frame 0 has already been committed.
   * @param {Uint8Array} frameCopy - Independent Buffer copy of the decoded frame.
   * @param {number} maxBufferFrames - Maximum frames retained in RAM.
   * @returns {{ buffered: boolean, dropped: boolean, shouldPauseDecoder: boolean }}
   */
  bufferFrame(hasCurrentFrame, frameCopy, maxBufferFrames) {
    if (!hasCurrentFrame) {
      return {buffered: false, dropped: false, shouldPauseDecoder: false};
    }
    this.decodedFrames++;
    let dropped = false;
    if (this.frames.length < maxBufferFrames) {
      this.frames.push(frameCopy);
    } else {
      dropped = true;
    }
    return {
      buffered: true,
      dropped,
      shouldPauseDecoder: this.frames.length >= DOWNLOAD_FRAME_HIGH_WATERMARK,
    };
  }

  /**
   * Resets backfill state and queues a synthetic high-priority BackfillJob for SIGUSR1 testing.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  prepareSigUsr1Test(now) {
    this.downloadedPaths.clear();
    this.clearPending();
    this.lastQueryAt = 0;
    this.pending = BackfillJob.createSigUsr1TestJob(now, this.name);
  }

  /**
   * Marks hardware recording cleared across active, pending, and queued BackfillJobs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} eventName - Eufy event property that reported state: false.
   * @param {{ initiallyCleared: boolean, activeEvents: string[] }} ledgerState - Current trigger ledger snapshot.
   * @returns {boolean} True when all active trigger properties have cleared.
   */
  markTriggersCleared(now, eventName, ledgerState) {
    const activeEvents = Array.isArray(ledgerState) ? ledgerState : ledgerState.activeEvents;
    let allCleared = Array.isArray(ledgerState) ? ledgerState.length === 0 : Boolean(ledgerState.initiallyCleared);
    if (this.active && this.active !== this.pending) {
      allCleared = this.active.markRecordingCleared(now, eventName);
    }
    if (this.pending) {
      allCleared = this.pending.markRecordingCleared(now, eventName);
    }
    if (this.queued) {
      allCleared = this.queued.markRecordingCleared(now, eventName);
    }
    if (this.lastSessionEventInfo) {
      this.lastSessionEventInfo = Object.freeze({
        ...this.lastSessionEventInfo,
        recordingActive: !allCleared,
        activeEvents,
      });
    }
    if (allCleared && (this.pending || this.active || this.queued)) {
      this.lastQueryAt = 0;
    }
    return allCleared;
  }

  /**
   * Evaluates structured log output after Eufy reports an event property cleared (state: false).
   *
   * @param {string} eventName - Eufy event property name.
   * @returns {Readonly<{ hasPending: boolean, isInfo: boolean, logMsg: string }>}
   */
  evaluateAfterMotionCleared(eventName) {
    if (!this.pending) {
      return Object.freeze({
        hasPending: false,
        isInfo: false,
        logMsg: 'eufy reported activity cleared (event="' + eventName + '")',
      });
    }
    if (this.isRecordingCleared()) {
      return Object.freeze({
        hasPending: true,
        isInfo: false,
        logMsg:
          'eufy reported activity cleared (event="' +
          eventName +
          '"), queued clip backfill ready after HomeBase settle delay',
      });
    }
    return Object.freeze({
      hasPending: true,
      isInfo: false,
      logMsg: 'eufy reported "' + eventName + '" cleared while other trigger events remain active for backfill',
    });
  }

  /**
   * Resolves the backfill event label for Frigate extension on 'download finished'.
   *
   * @param {string} filedLabel - Label currently filed on FrigateEventFiling.
   * @param {string} sessionReason - Current session reason fallback.
   * @returns {string}
   */
  resolveEventLabel(filedLabel, sessionReason) {
    const clipEvent = this.activeClip && this.activeClip.event ? String(this.activeClip.event) : '';
    if (filedLabel && filedLabel !== DEFAULT_MOTION_LABEL && (!clipEvent || clipEvent === DEFAULT_MOTION_EVENT)) {
      return filedLabel;
    }
    return clipEvent || filedLabel || sessionReason;
  }

  /**
   * Resolves the recognized person name for the active backfill clip or current Frigate event.
   *
   * @param {string} filedPerson - Person currently filed on FrigateEventFiling.
   * @returns {string}
   */
  resolveEventPerson(filedPerson) {
    return filedPerson || (this.activeClip && this.activeClip.personName ? String(this.activeClip.personName) : '');
  }

  /**
   * Synchronizes queued clip metadata from a mutated BackfillJob.
   *
   * @param {BackfillJob} sourceJob - Updated backfill job providing event metadata.
   */
  _syncQueuedClipMeta(sourceJob) {
    const mergeMeta = (clip) =>
      Object.freeze({
        ...clip,
        event: sourceJob.getEvent(),
        personName: sourceJob.getPersonName(),
        reason: sourceJob.getReason(),
      });
    if (this.clip) {
      this.clip = mergeMeta(this.clip);
    }
    this.clipQueue = this.clipQueue.map(mergeMeta);
  }

  /**
   * Updates lastSessionEventInfo with a frozen summary snapshot.
   *
   * @param {{
   *   at: number,
   *   event: string,
   *   personName: string,
   *   reason: string,
   *   priority: number,
   *   recordingActive: boolean,
   *   activeEvents: string[],
   * }} meta - Session event summary fields.
   */
  _setLastSessionEventInfo(meta) {
    this.lastSessionEventInfo = Object.freeze({
      name: this.name,
      at: meta.at,
      lastActivityAt: meta.at,
      event: meta.event,
      personName: meta.personName,
      reason: meta.reason,
      priority: meta.priority,
      attempts: 0,
      recordingActive: meta.recordingActive,
      activeEvents: meta.activeEvents,
    });
  }

  /**
   * Re-queues a BackfillJob when an active event-driven live session is preempted mid-event.
   *
   * @param {Record<string, *>} fallbackMeta - Fallback event descriptor when lastSessionEventInfo is null.
   */
  requeuePreemptedEvent(fallbackMeta) {
    if (!this.pending && this.backfillDownloads) {
      this.pending = new BackfillJob(this.lastSessionEventInfo || fallbackMeta);
    }
  }

  /**
   * Upgrades any active, pending, or queued BackfillJobs in place for an /api/wake request.
   *
   * @param {(job: BackfillJob) => boolean} upgradeJobInPlace - Single-job upgrade callback.
   * @param {{ defaultEvent: string, resolvedReason: string, activeEvents: string[] }} meta - Label metadata.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {{ hadJob: boolean, upgraded: boolean }}
   */
  _upgradeExistingForApiWake(upgradeJobInPlace, meta, now) {
    const jobs = [
      this.active,
      this.pending && !this.pending.isExpired(now) && this.pending !== this.active ? this.pending : null,
      this.queued && !this.queued.isExpired(now) ? this.queued : null,
    ].filter(Boolean);
    if (jobs.length === 0) {
      return {hadJob: false, upgraded: false};
    }
    let upgraded = false;
    for (const job of jobs) {
      upgraded = upgradeJobInPlace(job) || upgraded;
    }
    const metaSource = jobs[jobs.length - 1];
    if (upgraded && metaSource) {
      this._setLastSessionEventInfo({
        at: now,
        event: metaSource.getEvent() || meta.defaultEvent,
        personName: metaSource.getPersonName() || '',
        reason: metaSource.getReason() || meta.resolvedReason,
        priority: metaSource.getPriority(),
        recordingActive: metaSource.isRecordingActive(),
        activeEvents: meta.activeEvents,
      });
    }
    return {hadJob: true, upgraded};
  }

  /**
   * Queues a new BackfillJob for /api/wake or upgrades existing jobs in place without clobbering Eufy labels.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} reason - Trigger reason supplied by the API wake request.
   * @param {{
   *   evPriority?: number,
   *   defaultEvent?: string,
   *   activeEvents?: string[],
   *   isLiveWithVideo?: boolean,
   *   runtimeExtended?: boolean,
   * }} [opts={}] - API wake backfill options.
   * @returns {boolean} True if queued or upgraded in place.
   */
  queueOrUpgradeApiWake(now, reason, opts = {}) {
    if (!this.backfillDownloads) {
      return false;
    }
    const evPriority = Number(opts.evPriority ?? DEFAULT_EVENT_PRIORITY);
    const defaultEvent = opts.defaultEvent || DEFAULT_MOTION_EVENT;
    const resolvedReason = reason || defaultEvent;
    const activeEvents = opts.activeEvents || [];
    const nextPriority = this.priority + evPriority;

    const upgradeJobInPlace = (/** @type {BackfillJob} */ job) => {
      const upgraded = job.upgradeEvent({
        event: job.getEvent() || defaultEvent,
        personName: job.getPersonName() || '',
        reason: resolvedReason,
        priority: nextPriority,
        at: now,
        recordingActive: false,
      });
      this._syncQueuedClipMeta(job);
      return upgraded;
    };

    const existing = this._upgradeExistingForApiWake(
      upgradeJobInPlace,
      {defaultEvent, resolvedReason, activeEvents},
      now
    );
    if (existing.hadJob) {
      return existing.upgraded;
    }
    this.queueEvent(now, {
      eventName: defaultEvent,
      personName: '',
      reason: resolvedReason,
      evPriority,
      recordingActive: false,
      activeEvents,
      isLiveWithVideo: Boolean(opts.isLiveWithVideo),
      runtimeExtended: Boolean(opts.runtimeExtended),
    });
    return Boolean(this.pending);
  }

  /**
   * Queues or upgrades a pending BackfillJob when a Eufy trigger event fires.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {{
   *   eventName: string,
   *   personName: string,
   *   reason: string,
   *   evPriority: number,
   *   recordingActive: boolean,
   *   activeEvents: string[],
   *   isLiveWithVideo: boolean,
   *   runtimeExtended: boolean,
   * }} opts - Event backfill parameters.
   */
  queueEvent(now, opts) {
    const nextPriority = this.priority + opts.evPriority;
    this._setLastSessionEventInfo({
      at: now,
      event: opts.eventName || DEFAULT_MOTION_EVENT,
      personName: opts.personName || '',
      reason: opts.reason || opts.eventName || DEFAULT_MOTION_EVENT,
      priority: nextPriority,
      recordingActive: opts.recordingActive,
      activeEvents: opts.activeEvents,
    });
    if (!this.backfillDownloads || (!this.alwaysBackfill && (opts.runtimeExtended || opts.isLiveWithVideo))) {
      return;
    }

    const nonRecordingUpgrade = {
      event: opts.eventName,
      personName: opts.personName,
      reason: opts.reason,
      priority: nextPriority,
      at: now,
      recordingActive: false,
    };
    const eventUpgrade = {...nonRecordingUpgrade, recordingActive: opts.recordingActive};

    if (this.active) {
      this.active.upgradeEvent(nonRecordingUpgrade);
      this._syncQueuedClipMeta(this.active);
    }

    if (this.pending && !this.pending.isExpired(now)) {
      if (this._isPendingSettledOrMatched(now, opts.recordingActive)) {
        this.pending.upgradeEvent(nonRecordingUpgrade);
        this._syncQueuedClipMeta(this.pending);
        if (this.queued && !this.queued.isExpired(now)) {
          this.queued.upgradeEvent(eventUpgrade);
        } else {
          this.queued = this._buildJob(now, nextPriority, opts);
        }
        return;
      }
      this.pending.upgradeEvent(eventUpgrade);
      this._syncQueuedClipMeta(this.pending);
      return;
    }

    this.pending = this._buildJob(now, nextPriority, opts);
  }

  /**
   * Returns true if pendingBackfill has already settled or matched a clip so new recording triggers queue separately.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} recordingActive - Whether the incoming event represents active hardware recording.
   * @returns {boolean}
   */
  _isPendingSettledOrMatched(now, recordingActive) {
    if (!recordingActive || !this.pending) {
      return false;
    }
    return Boolean(this.clip || this.pending.isSettledOrMatched(now));
  }

  /**
   * Constructs a new BackfillJob instance for this camera.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} priority - Effective job priority.
   * @param {{
   *   eventName: string,
   *   personName: string,
   *   reason: string,
   *   recordingActive: boolean,
   *   activeEvents: string[],
   * }} opts - Job options.
   * @returns {BackfillJob}
   */
  _buildJob(now, priority, opts) {
    return new BackfillJob({
      name: this.name,
      at: now,
      lastActivityAt: now,
      event: opts.eventName,
      personName: opts.personName,
      reason: opts.reason,
      priority,
      attempts: 0,
      recordingActive: opts.recordingActive,
      activeEvents: opts.activeEvents,
    });
  }

  /**
   * Formats the backfill download summary suffix appended to SLEEP log lines.
   *
   * @param {number} effectiveNow - Effective stop timestamp in milliseconds.
   * @param {number} lastVideoAt - Timestamp of the last video frame/packet in milliseconds.
   * @param {number} [fps=LIVE_FPS] - Playback frame rate.
   * @returns {string}
   */
  formatSleepSummary(effectiveNow, lastVideoAt, fps = LIVE_FPS) {
    const frameBasis = this.decodedFrames || this.videoPackets;
    const clipDurationSecs = (frameBasis / Math.max(1, fps)).toFixed(1);
    const playbackSpanSecs =
      this.playbackStartedAt > 0 && lastVideoAt >= this.playbackStartedAt
        ? ((lastVideoAt - this.playbackStartedAt) / MS_PER_SECOND).toFixed(1)
        : '0.0';
    const postHoldSecs = lastVideoAt > 0 ? ((effectiveNow - lastVideoAt) / MS_PER_SECOND).toFixed(1) : '0.0';
    return (
      ', clipStart=' +
      formatEpochHms(this.clipStartMs) +
      ', triggerAt=' +
      formatEpochHms(this.triggerAtMs) +
      ', clipDuration=' +
      clipDurationSecs +
      's, decodedFrames=' +
      this.decodedFrames +
      ', playedFrames=' +
      this.playedFrames +
      ', packets=' +
      this.videoPackets +
      ', playbackSpan=' +
      playbackSpanSecs +
      's, postHold=' +
      postHoldSecs +
      's'
    );
  }

  /**
   * Formats the structured log line emitted when HomeBase P2P clip transfer completes.
   *
   * @param {number} bufferedCount - Total buffered decoded frames and pending video packets remaining.
   * @param {number} pendingPackets - Pending compressed video packets in decoder queue.
   * @param {{ fps?: number, sessionId: number }} meta - Playback fps and session identifier.
   * @returns {string}
   */
  formatTransferCompleteLog(bufferedCount, pendingPackets, meta) {
    const fps = meta.fps ?? LIVE_FPS;
    const frameBasis = Math.max(this.decodedFrames, this.videoPackets);
    const estClipSecs = (frameBasis / Math.max(1, fps)).toFixed(1);
    return (
      'eufy clip transfer complete, playing remaining ' +
      bufferedCount +
      ' buffered frames at ' +
      fps +
      ' fps (clipStart=' +
      formatEpochHms(this.clipStartMs) +
      ', packets=' +
      this.videoPackets +
      ', decodedFrames=' +
      this.decodedFrames +
      ', playedFrames=' +
      this.playedFrames +
      ', bufferedFrames=' +
      this.frames.length +
      ', pendingPackets=' +
      pendingPackets +
      ', estClipDuration=' +
      estClipSecs +
      's, session=' +
      meta.sessionId +
      ')'
    );
  }
}

module.exports = {
  DOWNLOAD_COMPLETED_INITIATOR,
  DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
  DOWNLOAD_FRAME_HIGH_WATERMARK,
  DOWNLOAD_FRAME_LOW_WATERMARK,
  MAX_DOWNLOADED_PATHS_HISTORY,
  isCompletedDownloadStop,
  BackfillState,
};
