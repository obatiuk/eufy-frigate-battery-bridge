// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * BackfillJob domain model encapsulating missed-event clip requests, HomeBase
 * database record parsing (.zxvideo / crop_local_path), and time-window matching.
 */
'use strict';

const {DEFAULT_EVENT_PRIORITY} = require('../config');
const {log} = require('../logger');
const DEFAULT_BACKFILL_MAX_AGE_MS = 300000;
const BACKFILL_MATCH_LOOKBACK_MS = 45000;
const BACKFILL_MATCH_LOOKAHEAD_MS = 180000;
const BACKFILL_MAX_QUERY_ATTEMPTS = 10;
const BACKFILL_POST_CLEAR_SETTLE_MS = 4000;
const BACKFILL_RECORDING_WAIT_CAP_MS = 35000;
const BACKFILL_MAX_TOTAL_RECORDING_WAIT_MS = 124000;
const INITIAL_COMPANION_ACTIVITY_WINDOW_MS = 5000;
const DEFAULT_MIN_EVENT_AGE_MS = 8000;
const BACKFILL_FOLLOWUP_ACTIVITY_MS = 15000;
const TEST_BACKFILL_OFFSET_MS = 10000;
const TEST_BACKFILL_PRIORITY = 9999;
const STORAGE_PATH_TIMESTAMP_REGEX = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/;
const CROP_LOCAL_PATH_REGEX = /^(.*\/(\d{14}))\/[^/]+$/;

/**
 * Enumerates the finite states of a BackfillJob lifecycle from initial trigger to completion or expiry.
 *
 * @readonly
 * @enum {string}
 */
const BACKFILL_STATES = Object.freeze({
  RECORDING: 'recording',
  SETTLING: 'settling',
  READY_TO_QUERY: 'ready_to_query',
  MATCHED: 'matched',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
});

/** @type {ReadonlySet<string>} */
const PRE_DOWNLOAD_BACKFILL_STATES = Object.freeze(
  new Set([
    BACKFILL_STATES.RECORDING,
    BACKFILL_STATES.SETTLING,
    BACKFILL_STATES.READY_TO_QUERY,
    BACKFILL_STATES.MATCHED,
  ])
);

/**
 * Validated transition map for the BackfillJob finite state machine.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const ALLOWED_BACKFILL_TRANSITIONS = Object.freeze({
  [BACKFILL_STATES.RECORDING]: Object.freeze(
    new Set([
      BACKFILL_STATES.RECORDING,
      BACKFILL_STATES.SETTLING,
      BACKFILL_STATES.READY_TO_QUERY,
      BACKFILL_STATES.MATCHED,
      BACKFILL_STATES.EXPIRED,
    ])
  ),
  [BACKFILL_STATES.SETTLING]: Object.freeze(
    new Set([
      BACKFILL_STATES.RECORDING,
      BACKFILL_STATES.SETTLING,
      BACKFILL_STATES.READY_TO_QUERY,
      BACKFILL_STATES.MATCHED,
      BACKFILL_STATES.EXPIRED,
    ])
  ),
  [BACKFILL_STATES.READY_TO_QUERY]: Object.freeze(
    new Set([
      BACKFILL_STATES.RECORDING,
      BACKFILL_STATES.SETTLING,
      BACKFILL_STATES.READY_TO_QUERY,
      BACKFILL_STATES.MATCHED,
      BACKFILL_STATES.EXPIRED,
    ])
  ),
  [BACKFILL_STATES.MATCHED]: Object.freeze(
    new Set([
      BACKFILL_STATES.RECORDING,
      BACKFILL_STATES.SETTLING,
      BACKFILL_STATES.READY_TO_QUERY,
      BACKFILL_STATES.MATCHED,
      BACKFILL_STATES.DOWNLOADING,
      BACKFILL_STATES.EXPIRED,
    ])
  ),
  [BACKFILL_STATES.DOWNLOADING]: Object.freeze(
    new Set([
      BACKFILL_STATES.DOWNLOADING,
      BACKFILL_STATES.MATCHED,
      BACKFILL_STATES.READY_TO_QUERY,
      BACKFILL_STATES.COMPLETED,
      BACKFILL_STATES.EXPIRED,
    ])
  ),
  [BACKFILL_STATES.COMPLETED]: Object.freeze(new Set([BACKFILL_STATES.COMPLETED])),
  [BACKFILL_STATES.EXPIRED]: Object.freeze(new Set([BACKFILL_STATES.EXPIRED])),
});

/**
 * Returns true if transitioning a BackfillJob from fromState to toState is permitted by the FSM.
 *
 * @param {string} fromState - Current BackfillJob state.
 * @param {string} toState - Target BackfillJob state.
 * @returns {boolean}
 */
function canTransitionBackfill(fromState, toState) {
  const allowed = ALLOWED_BACKFILL_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.has(toState));
}

/**
 * Parses the recording timestamp (ms) from a HomeBase database record's start_time or storage_path.
 *
 * @param {string} startStr - ISO or timestamp string from the database record.
 * @param {string} storagePath - HomeBase internal storage path containing YYYYMMDDHHMMSS.
 * @returns {number}
 */
function parseClipTimestampMs(startStr, storagePath) {
  const parsedDirect = startStr ? new Date(startStr).getTime() : 0;
  if (parsedDirect && !Number.isNaN(parsedDirect)) {
    return parsedDirect;
  }
  const tm = STORAGE_PATH_TIMESTAMP_REGEX.exec(String(storagePath || ''));
  if (!tm) {
    return 0;
  }
  return new Date(
    Number(tm[1]),
    Number(tm[2]) - 1,
    Number(tm[3]),
    Number(tm[4]),
    Number(tm[5]),
    Number(tm[6])
  ).getTime();
}

/**
 * Extracts a normalized clip candidate { devSn, storagePath, cipherId, clipMs } from a raw
 * HomeBase database query row, or returns null if the row is incomplete.
 *
 * @param {*} item - Raw row from station database query response.
 * @returns {{ devSn: string, storagePath: string, cipherId: number, clipMs: number }|null}
 */
function extractDatabaseRecordCandidate(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const rec = item.record && typeof item.record === 'object' ? item.record : item;
  const devSn = rec.device_sn || rec.deviceSN || rec.deviceSerial || rec.serialNumber || '';
  if (!devSn) {
    return null;
  }

  let storagePath = rec.storage_path || rec.storagePath || rec.local_path || rec.localPath || '';
  const cropPath = rec.crop_local_path || rec.cropLocalPath || rec.thumb_path || '';
  if (!storagePath && cropPath) {
    const m = CROP_LOCAL_PATH_REGEX.exec(String(cropPath));
    if (m) {
      storagePath = m[1] + '/' + m[2] + '.zxvideo';
    }
  }
  if (!storagePath) {
    return null;
  }

  const cipherId = Number(rec.cipher_id ?? rec.cipherId ?? 0);
  const startStr = rec.start_time || rec.startTime || rec.create_time || rec.createTime || '';
  const clipMs = parseClipTimestampMs(startStr, storagePath);

  return Object.freeze({devSn, storagePath, cipherId, clipMs});
}

/**
 * Domain model representing a pending missed-event clip backfill request on a HomeBase camera,
 * governed by a strict finite state machine (BACKFILL_STATES).
 */
class BackfillJob {
  /**
   * @param {Record<string, *>} opts - Backfill job parameters.
   */
  constructor(opts = {}) {
    this.name = String(opts.name || opts.cameraName || 'backfill');
    this.at = opts.at ?? Date.now();
    this.lastActivityAt = opts.lastActivityAt ?? this.at;
    this.event = opts.event || 'motion detected';
    this.personName = opts.personName || '';
    this.reason = opts.reason || this.event;
    this.priority = opts.priority ?? DEFAULT_EVENT_PRIORITY;
    this.attempts = opts.attempts ?? 0;
    this.ignoreTimeWindow = Boolean(opts.ignoreTimeWindow);
    this.recordingActive = opts.recordingActive !== undefined ? Boolean(opts.recordingActive) : !this.ignoreTimeWindow;
    this.clearedAt = opts.clearedAt ?? 0;
    this.followUpQueried = Boolean(opts.followUpQueried);
    this.activeEvents = new Set(Array.isArray(opts.activeEvents) ? opts.activeEvents : []);
    if (this.recordingActive && this.event && !this.ignoreTimeWindow) {
      this.activeEvents.add(String(this.event).toLowerCase());
    }
    /**
     * @type {Array<{
     *   storagePath: string,
     *   cipherId: number,
     *   clipMs: number,
     *   event: string,
     *   personName: string,
     *   reason: string
     * }>}
     */
    this.matchedClips = [];
    /** @type {string} */
    this.state = this.ignoreTimeWindow
      ? BACKFILL_STATES.READY_TO_QUERY
      : this.recordingActive
        ? BACKFILL_STATES.RECORDING
        : this.clearedAt > 0
          ? BACKFILL_STATES.SETTLING
          : BACKFILL_STATES.READY_TO_QUERY;
  }

  /**
   * Validates and executes a state transition on this BackfillJob, logging a DEBUG transition line.
   *
   * @param {string} nextState - Target BACKFILL_STATES value.
   * @param {string} [reason=''] - Human-readable reason for the transition.
   * @returns {string} Resulting state.
   */
  transitionTo(nextState, reason = '') {
    const prevState = this.state;
    if (!canTransitionBackfill(prevState, nextState)) {
      return prevState;
    }
    this.state = nextState;
    if (prevState && prevState !== nextState) {
      const suffix = reason ? ' (' + reason + ')' : '';
      log.debug(this, 'backfill state: ' + prevState + ' -> ' + nextState + suffix);
    }
    return this.state;
  }

  /**
   * Upgrades this backfill job in-place when a higher- or equal-priority companion event
   * arrives during the same motion window while preserving the original start timestamp
   * and re-asserting active recording state. Accepts either an options object or positional args.
   *
   * @param {string|Record<string, *>} eventNameOrOpts - New Eufy event string or options object.
   * @param {string} [personName=''] - Optional recognized person name.
   * @param {string} [reason=''] - Formatted trigger description.
   * @param {number} [nextPriority=DEFAULT_EVENT_PRIORITY] - Combined camera + event priority score.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [recordingActive=true] - Whether the trigger indicates active recording.
   * @returns {boolean} True if event/priority or personName was upgraded.
   */
  upgradeEvent(
    eventNameOrOpts,
    personName = '',
    reason = '',
    nextPriority = DEFAULT_EVENT_PRIORITY,
    now = Date.now(),
    recordingActive = true
  ) {
    const opts = typeof eventNameOrOpts === 'object' && eventNameOrOpts !== null ? eventNameOrOpts : null;
    const evName = opts ? String(opts.event || this.event) : String(eventNameOrOpts || '');
    const pName = opts ? String(opts.personName || '') : personName;
    const rsn = opts ? String(opts.reason || evName) : reason || evName;
    const prio = opts ? Number(opts.priority ?? this.priority) : nextPriority;
    const ts = opts ? Number(opts.at ?? opts.now ?? Date.now()) : now;
    const recActive = opts && opts.recordingActive !== undefined ? Boolean(opts.recordingActive) : recordingActive;

    this.lastActivityAt = Math.max(this.lastActivityAt || this.at, ts);
    if (recActive && !this.ignoreTimeWindow) {
      if (evName) {
        this.activeEvents.add(evName.toLowerCase());
      }
      this.recordingActive = true;
      this.clearedAt = 0;
      this.transitionTo(BACKFILL_STATES.RECORDING, 'companion event re-triggered recording');
    }
    let changed = false;
    if (prio >= this.priority) {
      if (this.event !== evName || this.reason !== rsn || this.priority !== prio) {
        this.event = evName;
        this.reason = rsn;
        this.priority = prio;
        changed = true;
      }
    }
    if (pName && !this.personName) {
      this.personName = pName;
      changed = true;
    }
    return changed;
  }

  /**
   * Records that a Eufy trigger property reported state: false, marking the hardware clip
   * recording as completed (SETTLING) only once all active trigger properties have cleared.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {string} [eventName=''] - Eufy event property that cleared (clears all when omitted).
   * @returns {boolean} True if all active triggers have cleared and recording is now settling.
   */
  markRecordingCleared(now = Date.now(), eventName = '') {
    this.lastActivityAt = Math.max(this.lastActivityAt || this.at, now);
    if (eventName) {
      this.activeEvents.delete(String(eventName).toLowerCase());
    } else {
      this.activeEvents.clear();
    }
    if (this.activeEvents.size > 0) {
      return false;
    }
    this.recordingActive = false;
    this.clearedAt = now;
    this.transitionTo(BACKFILL_STATES.SETTLING, 'all triggers cleared');
    return true;
  }

  /**
   * Evaluates whether the backfill settle or recording wait window has elapsed.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minEventAgeMs - Fallback minimum event age in milliseconds.
   * @param {number} maxRecordingWaitMs - Maximum wait while recordingActive is true.
   * @returns {boolean}
   */
  hasElapsedQuerySettleWindow(now, minEventAgeMs, maxRecordingWaitMs) {
    if (this.isUrgentTest()) {
      return true;
    }
    if (!this.recordingActive && this.clearedAt > 0) {
      return now - this.clearedAt >= BACKFILL_POST_CLEAR_SETTLE_MS;
    }
    if (this.recordingActive) {
      const hasSubsequentRetrigger = (this.lastActivityAt || this.at) - this.at > INITIAL_COMPANION_ACTIVITY_WINDOW_MS;
      const refAt = hasSubsequentRetrigger ? this.lastActivityAt : this.at;
      return now - refAt >= maxRecordingWaitMs || now - this.at >= BACKFILL_MAX_TOTAL_RECORDING_WAIT_MS;
    }
    return now - this.at >= minEventAgeMs;
  }

  /**
   * Returns true if enough time has elapsed (or Eufy reported all activity cleared + 4s settle)
   * to query the HomeBase local database for the recorded clip, transitioning to READY_TO_QUERY.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [minEventAgeMs=DEFAULT_MIN_EVENT_AGE_MS] - Fallback minimum event age in milliseconds.
   * @param {number} [maxRecordingWaitMs] - Maximum wait while recordingActive is true.
   * @returns {boolean}
   */
  isReadyToQuery(now = Date.now(), minEventAgeMs = DEFAULT_MIN_EVENT_AGE_MS, maxRecordingWaitMs = undefined) {
    const effectiveRecordingWaitMs =
      maxRecordingWaitMs !== undefined
        ? maxRecordingWaitMs
        : minEventAgeMs > DEFAULT_MIN_EVENT_AGE_MS
          ? minEventAgeMs
          : BACKFILL_RECORDING_WAIT_CAP_MS;
    const ready = this.hasElapsedQuerySettleWindow(now, minEventAgeMs, effectiveRecordingWaitMs);
    if (ready && (this.state === BACKFILL_STATES.RECORDING || this.state === BACKFILL_STATES.SETTLING)) {
      this.transitionTo(BACKFILL_STATES.READY_TO_QUERY, 'settle window elapsed');
    }
    return ready;
  }

  /**
   * Returns true if this backfill request is older than maxAgeMs (default 5 minutes),
   * transitioning the FSM to EXPIRED when true.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @param {number} [maxAgeMs=300000] - Maximum age in milliseconds.
   * @returns {boolean}
   */
  isExpired(now = Date.now(), maxAgeMs = DEFAULT_BACKFILL_MAX_AGE_MS) {
    const expired = now - Math.max(this.at, this.lastActivityAt || this.at) > maxAgeMs;
    if (expired) {
      this.transitionTo(BACKFILL_STATES.EXPIRED, 'max age exceeded');
    }
    return expired;
  }

  /**
   * Returns true if this backfill job was triggered by SIGUSR1 and ignores event time windows.
   *
   * @returns {boolean}
   */
  isUrgentTest() {
    return Boolean(this.ignoreTimeWindow);
  }

  /**
   * Increments the HomeBase database query attempt counter and returns true if this job
   * is still within maxAttempts.
   *
   * @param {number} [maxAttempts=BACKFILL_MAX_QUERY_ATTEMPTS] - Maximum allowed database query attempts.
   * @returns {boolean} True if the query attempt is allowed, false if exhausted.
   */
  consumeQueryAttempt(maxAttempts = BACKFILL_MAX_QUERY_ATTEMPTS) {
    this.attempts += 1;
    const allowed = this.attempts <= maxAttempts;
    if (!allowed) {
      this.transitionTo(BACKFILL_STATES.EXPIRED, 'max query attempts exhausted');
    }
    return allowed;
  }

  /**
   * Checks whether a parsed HomeBase clip candidate falls within this job's trigger time window.
   *
   * @param {{ storagePath: string, clipMs: number }} candidate - Parsed clip candidate.
   * @param {Set<string>} downloadedPaths - Set of already downloaded storage paths.
   * @returns {boolean}
   */
  matchesCandidate(candidate, downloadedPaths) {
    const endRef = Math.max(this.at, this.lastActivityAt || this.at, this.clearedAt || 0);
    return candidate && !downloadedPaths.has(candidate.storagePath)
      ? this.isUrgentTest() ||
          !candidate.clipMs ||
          (candidate.clipMs >= this.at - BACKFILL_MATCH_LOOKBACK_MS &&
            candidate.clipMs <= endRef + BACKFILL_MATCH_LOOKAHEAD_MS)
      : false;
  }

  /**
   * Creates an immutable matched clip descriptor ready for device.start_download and transitions to MATCHED.
   *
   * @param {{ storagePath: string, cipherId: number, clipMs?: number }} candidate - Matched database candidate.
   * @returns {Readonly<{
   *   storagePath: string,
   *   cipherId: number,
   *   clipMs: number,
   *   event: string,
   *   personName: string,
   *   reason: string
   * }>}
   */
  toMatchedClip(candidate) {
    if (PRE_DOWNLOAD_BACKFILL_STATES.has(this.state)) {
      this.transitionTo(BACKFILL_STATES.MATCHED, 'candidate clip matched');
    }
    return Object.freeze({
      storagePath: candidate.storagePath,
      cipherId: candidate.cipherId,
      clipMs: candidate.clipMs || 0,
      event: this.event,
      personName: this.personName,
      reason: this.reason,
    });
  }

  /**
   * Matches and enqueues a candidate clip in chronological order inside this job's matchedClips queue.
   *
   * @param {{ storagePath: string, cipherId: number, clipMs: number }} candidate - Database candidate.
   * @param {Set<string>} downloadedPaths - Set of already downloaded storage paths.
   * @returns {boolean} True if the candidate matched and was enqueued.
   */
  enqueueMatchedCandidate(candidate, downloadedPaths) {
    if (!this.matchesCandidate(candidate, downloadedPaths)) {
      return false;
    }
    if (this.matchedClips.some((c) => c.storagePath === candidate.storagePath)) {
      return false;
    }
    if (this.isUrgentTest() && this.matchedClips.length > 0) {
      return false;
    }
    this.matchedClips.push(this.toMatchedClip(candidate));
    if (this.matchedClips.length > 1) {
      this.matchedClips.sort((a, b) => (a.clipMs || 0) - (b.clipMs || 0));
    }
    return true;
  }

  /**
   * Shifts the next matched clip for download and transitions the job state to DOWNLOADING.
   *
   * @returns {Readonly<{
   *   storagePath: string,
   *   cipherId: number,
   *   clipMs: number,
   *   event: string,
   *   personName: string,
   *   reason: string
   * }>|null}
   */
  shiftNextClipForDownload() {
    if (this.matchedClips.length === 0) {
      return null;
    }
    const nextClip = this.matchedClips.shift() || null;
    this.transitionTo(BACKFILL_STATES.DOWNLOADING, 'clip dequeued for download');
    return nextClip;
  }

  /**
   * Marks the current download as started or completed, transitioning to MATCHED if more clips remain
   * or COMPLETED if all matched clips have finished.
   *
   * @returns {string} Resulting state.
   */
  completeCurrentDownload() {
    if (this.matchedClips.length > 0) {
      return this.transitionTo(BACKFILL_STATES.MATCHED, 'remaining clips queued');
    }
    return this.transitionTo(BACKFILL_STATES.COMPLETED, 'all matched clips downloaded');
  }

  /**
   * Returns true if camera activity continued at least minSpanMs past the downloaded clip's
   * start timestamp and a follow-up database query has not yet been performed for split clips.
   *
   * @param {number} [lastClipMs=0] - Timestamp (ms) of the last downloaded clip.
   * @param {number} [minSpanMs=BACKFILL_FOLLOWUP_ACTIVITY_MS] - Minimum activity span to trigger follow-up.
   * @returns {boolean}
   */
  needsFollowUpClipQuery(lastClipMs = 0, minSpanMs = BACKFILL_FOLLOWUP_ACTIVITY_MS) {
    if (this.isUrgentTest() || this.followUpQueried) {
      return false;
    }
    const activityEnd = Math.max(this.lastActivityAt || 0, this.clearedAt || 0);
    const clipStartRef = Math.max(this.at || 0, lastClipMs || 0);
    return activityEnd - clipStartRef >= minSpanMs;
  }

  /**
   * Prepares this job for a single post-download follow-up database query to catch split clips.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [maxAttempts=BACKFILL_MAX_QUERY_ATTEMPTS] - Maximum allowed query attempts.
   * @returns {boolean} True once transitioned to READY_TO_QUERY.
   */
  prepareFollowUpQuery(now = Date.now(), maxAttempts = BACKFILL_MAX_QUERY_ATTEMPTS) {
    this.followUpQueried = true;
    this.recordingActive = false;
    this.clearedAt = now;
    this.attempts = Math.max(0, maxAttempts - 1);
    this.transitionTo(BACKFILL_STATES.READY_TO_QUERY, 'follow-up query scheduled');
    return true;
  }

  /**
   * Creates a high-priority synthetic BackfillJob for the SIGUSR1 test hook.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @param {string} [cameraName='backfill'] - Camera name for scoped logging.
   * @returns {BackfillJob}
   */
  static createSigUsr1TestJob(now = Date.now(), cameraName = 'backfill') {
    return new BackfillJob({
      name: cameraName,
      at: now - TEST_BACKFILL_OFFSET_MS,
      ignoreTimeWindow: true,
      event: 'motion detected',
      personName: '',
      reason: 'SIGUSR1 backfill test',
      priority: TEST_BACKFILL_PRIORITY,
      attempts: 0,
    });
  }
}

module.exports = {
  BACKFILL_STATES,
  ALLOWED_BACKFILL_TRANSITIONS,
  canTransitionBackfill,
  DEFAULT_BACKFILL_MAX_AGE_MS,
  BACKFILL_MAX_QUERY_ATTEMPTS,
  BACKFILL_POST_CLEAR_SETTLE_MS,
  BACKFILL_RECORDING_WAIT_CAP_MS,
  BackfillJob,
  extractDatabaseRecordCandidate,
};
