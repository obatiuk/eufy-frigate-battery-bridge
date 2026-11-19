// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Active streaming session state of one camera: monotonic session id and mode, hold window and duration caps,
 * direct rtsp_url passive probe rules, RTSP and P2P health watchdogs, and the per-session decoder backpressure FSM.
 */
'use strict';

const {AUDIO, STREAM_MODES} = require('../../config');
const {SESSION_STATES, DECODER_STATES, ALLOWED_DECODER_TRANSITIONS} = require('./states');

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const DECODER_AUDIO_PIPE_INDEX = 3;

const MAX_LIVE_PENDING_VIDEO_PACKETS = 150;
const MAX_DOWNLOAD_PENDING_VIDEO_PACKETS = 2400;
const MAX_LIVE_PENDING_AUDIO_PACKETS = 200;
const MAX_DOWNLOAD_PENDING_AUDIO_PACKETS = 3000;

const DEFAULT_RTSP_HANDSHAKE_MIN_MS = 400;
const DEFAULT_RTSP_DEC_STALL_MS = 7500;
const DEFAULT_RTSP_RETRY_MS = 10000;
const DEFAULT_RTSP_MAX_RETRIES = 5;
const DEFAULT_RTSP_TIMEOUT_MS = 25000;
const DEFAULT_RTSP_MID_STALL_MS = 5000;
const DEFAULT_RTSP_DIRECT_MID_STALL_MS = 15000;
const DEFAULT_RTSP_DIRECT_TIMEOUT_MS = 8000;
const DEFAULT_RTSP_DIRECT_PROBE_INTERVAL_MS = 5000;
const DEFAULT_RTSP_DIRECT_LIVE_RECONNECT_MS = 1000;
const DEFAULT_RTSP_START_DEDUP_WINDOW_MS = 2000;
const DEFAULT_MIN_RTSP_REWAKE_HOLD_MS = 10000;

const DEFAULT_P2P_INITIAL_RETRY_MS = 5500;
const DEFAULT_P2P_SUBSEQUENT_RETRY_MS = 8000;
const DEFAULT_P2P_MAX_RETRIES = 3;
const DEFAULT_FAILED_START_BACKOFF_MS = 5000;

const DEFAULT_MID_STREAM_GRACE_MS = 3000;
const DEFAULT_MIN_EXTEND_MS = 5000;
const DEFAULT_MOTION_CLEAR_SETTLE_MS = 5000;
const DEFAULT_MIN_EVENT_VIDEO_MS = 10000;

const RTSP_DIRECT_PROBE_INITIATOR = 'rtsp-direct-probe';
const RTSP_DIRECT_STREAM_REASON = 'rtsp direct stream';
const RTSP_DIRECT_VIEWER_INITIATOR = 'viewer';
const RTSP_DIRECT_VIEWER_REASON = 'live view opened';
const RTSP_STANDBY_404_REGEX = /\b404\b|not found/i;
const RTSP_NETWORK_UNREACHABLE_REGEX = new RegExp(
  '\\b(?:connection refused|timed out|timeout|no route to host|host is down|network is unreachable|' +
    'name or service not known|temporary failure in name resolution|yielded no video)\\b',
  'i'
);
const RTSP_BARE_INVALID_DATA_REGEX = /\binvalid data found when processing input\b/i;
const RTSP_COMPONENT_TAG_REGEX = /\[rtsp\s*@/i;

/**
 * Owns per-session streaming timestamps, hold windows, direct RTSP probe rules, health watchdogs, and decoder pipes.
 */
class StreamSession {
  /**
   * @param {{
   *   directRtsp?: boolean,
   *   timers: {
   *     holdMs: number,
   *     lowBatHoldMs?: number,
   *     maxMs: number,
   *     viewMaxMs: number,
   *     lingerMs?: number,
   *     earlySleepMs?: number,
   *     letEufyDecideEnd?: boolean,
   *   },
   *   onDecoderTransition?: (prev: string, next: string, reason: string) => void,
   *   onDecoderRefused?: (prev: string, next: string, reason: string) => void,
   * }} opts - Static camera session options and decoder transition logger callbacks.
   */
  constructor(opts) {
    this.directRtsp = Boolean(opts.directRtsp);
    this.timers = opts.timers;
    this.onDecoderTransition = typeof opts.onDecoderTransition === 'function' ? opts.onDecoderTransition : () => {};
    this.onDecoderRefused = typeof opts.onDecoderRefused === 'function' ? opts.onDecoderRefused : () => {};

    this.id = 0;
    this.active = false;
    /** @type {string} */
    this.mode = '';
    this.starting = false;
    /** @type {Promise<*>|null} */
    this.startPromise = null;
    this.p2pReady = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.rtspRetryTimer = null;
    this.startedAt = 0;
    this.lastStartAt = 0;
    this.lastStoppedAt = 0;
    this.lastEndedHadVideo = false;
    this.gotVideo = false;
    this.firstVideoAt = 0;
    this.firstFrameAt = 0;
    this.lastVideoAt = 0;
    this.restarts = 0;
    this.droppedFrames = 0;
    this.heardFromDevice = false;
    this.reason = '';
    this.initiator = '';
    this.runtimeExtended = false;

    this.motionUntil = 0;
    this.lastMotionAt = 0;
    this.motionClearedAt = 0;
    this.viewUntil = 0;
    this.viewSince = 0;

    /** @type {string} */
    this.decoderState = DECODER_STATES.DETACHED;
    /** @type {*} */
    this.dec = null;
    this.decSpawnedAt = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoCodec = '';
    /** @type {Uint8Array[]} */
    this.pendingVideoPackets = [];
    /** @type {Uint8Array[]} */
    this.pendingAudioPackets = [];
    this.decoderInputEnded = false;
    this.decoderStdoutPaused = false;
  }

  /**
   * Returns true when an FFmpeg stderr line reports RTSP 404 Not Found (camera reachable in standby).
   *
   * @param {string} [lastLine=''] - Last stderr line or failure reason from FFmpeg.
   * @returns {boolean}
   */
  static isStandby404(lastLine = '') {
    return RTSP_STANDBY_404_REGEX.test(String(lastLine || ''));
  }

  /**
   * Initializes active session counters for mode and returns the target SESSION_STATES state.
   *
   * @param {'rtsp'|'p2p'|'download'} mode - Active stream mode.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} [p2pReady=true] - Whether incoming P2P packets may be ingested immediately.
   * @returns {string} Initial SESSION_STATES state for this mode.
   */
  begin(mode, now, p2pReady = true) {
    this.active = true;
    this.heardFromDevice = false;
    this.mode = mode;
    this.id++;
    this.p2pReady = p2pReady;
    this.startedAt = now;
    this.lastStartAt = now;
    this.gotVideo = false;
    this.runtimeExtended = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.restarts = 0;
    this.droppedFrames = 0;
    this.lastVideoAt = 0;
    this.resetDecoderPipeState();
    switch (mode) {
      case STREAM_MODES.RTSP:
        return SESSION_STATES.WAKING_RTSP;
      case STREAM_MODES.DOWNLOAD:
        return SESSION_STATES.HANDSHAKING_BACKFILL;
      default:
        return SESSION_STATES.WAKING_P2P;
    }
  }

  /**
   * Resets active session flags and advances the session id when a stream ends.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean|undefined} hadVideo - Whether decoded video was received (false clears gotVideo).
   */
  end(now, hadVideo = undefined) {
    this.active = false;
    this.mode = '';
    this.heardFromDevice = false;
    this.resetDecoderPipeState();
    this.transitionDecoderTo(DECODER_STATES.DETACHED, 'session ended');
    this.starting = false;
    this.startPromise = null;
    this.lastEndedHadVideo = Boolean(hadVideo === undefined ? this.gotVideo : hadVideo);
    if (hadVideo === false) {
      this.gotVideo = false;
    }
    this.runtimeExtended = false;
    this.motionUntil = 0;
    this.p2pReady = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.motionClearedAt = 0;
    this.lastStartAt = 0;
    this.id++;
    this.lastStoppedAt = now;
    this.decSpawnedAt = 0;
  }

  /**
   * Returns true if the session is active in sessionId (and optional mode).
   *
   * @param {number} sessionId - Expected session identifier.
   * @param {string} [mode=''] - Optional expected stream mode.
   * @returns {boolean}
   */
  isCurrent(sessionId, mode = '') {
    return Boolean(this.active && this.id === sessionId && (!mode || this.mode === mode));
  }

  /**
   * Returns true if the session is active in a non-RTSP mode (P2P or DOWNLOAD).
   *
   * @returns {boolean}
   */
  usesP2pSlot() {
    return Boolean(this.active && this.mode !== STREAM_MODES.RTSP);
  }

  /**
   * Returns true if the session is holding the station P2P network channel (P2P live, or DOWNLOAD before transfer end).
   *
   * @param {boolean} downloadFinished - Whether HomeBase clip transfer has completed.
   * @returns {boolean}
   */
  isOccupyingP2pChannel(downloadFinished) {
    return Boolean(
      this.active && this.mode !== STREAM_MODES.RTSP && !(this.mode === STREAM_MODES.DOWNLOAD && downloadFinished)
    );
  }

  /**
   * Returns true if the session is active in RTSP mode.
   *
   * @returns {boolean}
   */
  isActiveRtsp() {
    return Boolean(this.active && this.mode === STREAM_MODES.RTSP);
  }

  /**
   * Returns true if the session is active in a live (non-download) mode.
   *
   * @returns {boolean}
   */
  isActiveLive() {
    return Boolean(this.active && this.mode !== STREAM_MODES.DOWNLOAD);
  }

  /**
   * Returns true if the session is active in HomeBase clip backfill download mode.
   *
   * @returns {boolean}
   */
  isBackfillPlayback() {
    return Boolean(this.active && this.mode === STREAM_MODES.DOWNLOAD);
  }

  /**
   * Returns true once an RTSP session has decoded video and is not mid re-wake.
   *
   * @returns {boolean}
   */
  isEstablishedRtsp() {
    return Boolean(this.gotVideo && !this.rtspRewaking);
  }

  /**
   * Records that the camera emitted a property update or livestream event during the active session.
   */
  markDeviceHeard() {
    if (this.active) {
      this.heardFromDevice = true;
    }
  }

  /**
   * Returns true if the session is active and not already executing a start_livestream RPC.
   *
   * @returns {boolean}
   */
  canBeginP2pStart() {
    return Boolean(this.active && !this.starting);
  }

  /**
   * Marks a P2P start_livestream RPC attempt in flight and returns the session id.
   *
   * @returns {number}
   */
  beginP2pStartAttempt() {
    this.starting = true;
    return this.id;
  }

  /**
   * Clears the P2P starting flag when sessionId still matches the current session.
   *
   * @param {number} sessionId - Session identifier of the completed start attempt.
   */
  finishP2pStartAttempt(sessionId) {
    if (this.id === sessionId) {
      this.starting = false;
    }
  }

  /**
   * Marks the P2P stream ready to ingest packets and optionally updates lastStartAt.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} [updateStartAt=true] - Whether to update lastStartAt.
   */
  markP2pStreamReady(now, updateStartAt = true) {
    this.p2pReady = true;
    if (updateStartAt) {
      this.lastStartAt = now;
    }
  }

  /**
   * Marks the P2P stream not ready to ingest packets.
   */
  markP2pStreamNotReady() {
    this.p2pReady = false;
  }

  /**
   * Returns true when incoming P2P/download A/V packets may be ingested.
   *
   * @returns {boolean}
   */
  canIngestP2pPacket() {
    return Boolean(this.active && this.p2pReady);
  }

  /**
   * Applies a backoff offset to lastStartAt after a failed start_livestream RPC if sessionId is still active.
   *
   * @param {number} sessionId - Session identifier of the failed attempt.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [backoffMs=DEFAULT_FAILED_START_BACKOFF_MS] - Backoff offset in milliseconds.
   */
  applyFailedStartBackoff(sessionId, now, backoffMs = DEFAULT_FAILED_START_BACKOFF_MS) {
    if (this.isCurrent(sessionId)) {
      this.lastStartAt = now - backoffMs;
    }
  }

  /**
   * Stores and returns the in-flight start_livestream Promise.
   *
   * @param {Promise<*>} promise - In-flight start promise.
   * @returns {Promise<*>}
   */
  setStartPromise(promise) {
    this.startPromise = promise;
    return promise;
  }

  /**
   * Records the start of an RTSP connection/wake attempt and returns the current session id.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {number}
   */
  markRtspAttemptStart(now) {
    this.lastStartAt = now;
    return this.id;
  }

  /**
   * Returns true if an RTSP start attempt was recorded within windowMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [windowMs=DEFAULT_RTSP_START_DEDUP_WINDOW_MS] - Recency window in milliseconds.
   * @returns {boolean}
   */
  hasRecentRtspStartAttempt(now, windowMs = DEFAULT_RTSP_START_DEDUP_WINDOW_MS) {
    return Boolean(this.lastStartAt > 0 && now - this.lastStartAt < windowMs);
  }

  /**
   * Returns true if no wake retries have occurred yet in this session.
   *
   * @returns {boolean}
   */
  isFirstWakeAttempt() {
    return this.restarts === 0;
  }

  /**
   * Resets RTSP wake timestamps and retry count if an unstarted RTSP wake stalled past stallMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} stallMs - Stall threshold in milliseconds.
   * @returns {boolean} True if reset.
   */
  resetStalledRtspWake(now, stallMs) {
    if (this.mode === STREAM_MODES.RTSP && !this.gotVideo && now - this.startedAt > stallMs) {
      this.startedAt = now;
      this.lastStartAt = now;
      this.restarts = 0;
      return true;
    }
    return false;
  }

  /**
   * Clears any pending RTSP decoder retry timer.
   */
  clearRtspRetryTimer() {
    if (this.rtspRetryTimer) {
      clearTimeout(this.rtspRetryTimer);
      this.rtspRetryTimer = null;
    }
  }

  /**
   * Schedules an RTSP decoder retry timer after delayMs, replacing any pending timer.
   *
   * @param {number} delayMs - Delay before retry in milliseconds.
   * @param {() => void} onRetry - Callback invoked when the retry timer fires.
   */
  scheduleRtspDecoderRetry(delayMs, onRetry) {
    this.clearRtspRetryTimer();
    this.rtspRetryTimer = setTimeout(() => {
      this.rtspRetryTimer = null;
      onRetry();
    }, delayMs);
    if (this.rtspRetryTimer && typeof this.rtspRetryTimer.unref === 'function') {
      this.rtspRetryTimer.unref();
    }
  }

  /**
   * Updates session timing state when a decoded RTSP frame arrives and returns transition metadata.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {{ isFirstVideo: boolean, isRewakeResume: boolean, elapsedSec: string }}
   */
  markRtspFrameReceived(now) {
    this.lastVideoAt = now;
    if (!this.firstFrameAt) {
      this.firstFrameAt = now;
    }
    if (!this.gotVideo) {
      this.gotVideo = true;
      this.firstVideoAt = now;
      this.rtspRewaking = false;
      this.restarts = 0;
      return {
        isFirstVideo: true,
        isRewakeResume: false,
        elapsedSec: ((now - this.startedAt) / MS_PER_SECOND).toFixed(1),
      };
    }
    if (this.rtspRewaking) {
      this.rtspRewaking = false;
      this.restarts = 0;
      const refAt = this.rtspRewakeStartedAt || this.lastStartAt || now;
      return {
        isFirstVideo: false,
        isRewakeResume: true,
        elapsedSec: ((now - refAt) / MS_PER_SECOND).toFixed(1),
      };
    }
    return {isFirstVideo: false, isRewakeResume: false, elapsedSec: '0.0'};
  }

  /**
   * Updates session timing state when an incoming P2P video packet is ingested.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {{ isFirstVideo: boolean, elapsedSec: string }}
   */
  markP2pVideoPacketReceived(now) {
    this.lastVideoAt = now;
    if (!this.gotVideo) {
      this.gotVideo = true;
      this.firstVideoAt = now;
      return {isFirstVideo: true, elapsedSec: ((now - this.startedAt) / MS_PER_SECOND).toFixed(1)};
    }
    return {isFirstVideo: false, elapsedSec: '0.0'};
  }

  /**
   * Returns the latest timestamp between lastVideoAt and lastStartAt for watchdog checks.
   *
   * @returns {number}
   */
  getQuietSince() {
    return Math.max(this.lastVideoAt, this.lastStartAt);
  }

  /**
   * Returns elapsed live duration in seconds since startedAt.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {number}
   */
  getLiveDurationSecs(now) {
    return this.startedAt ? Math.round((now - this.startedAt) / MS_PER_SECOND) : 0;
  }

  /**
   * Returns true if video was already received and a subsequent start event arrived after graceMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [graceMs=DEFAULT_MID_STREAM_GRACE_MS] - Grace window in milliseconds.
   * @returns {boolean}
   */
  isMidStreamRetrigger(now, graceMs = DEFAULT_MID_STREAM_GRACE_MS) {
    return Boolean(this.gotVideo && now - (this.lastStartAt || 0) > graceMs);
  }

  /**
   * Returns the timestamp until which the session wants to stay awake.
   *
   * @returns {number}
   */
  wantUntil() {
    return Math.max(this.motionUntil, this.viewUntil);
  }

  /**
   * Returns true if now is within an active motion hold window.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isInMotion(now) {
    return now < this.motionUntil;
  }

  /**
   * Returns true if the session is active with an unexpired viewer hold.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isActivelyViewing(now) {
    return Boolean(this.active && now < this.viewUntil);
  }

  /**
   * Returns true if the session is active in live motion mode with no active viewer hold.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isMotionOnlyActive(now) {
    return Boolean(this.isActiveLive() && this.isInMotion(now) && now >= this.viewUntil);
  }

  /**
   * Clears viewer hold timestamps.
   */
  clearViewerHold() {
    this.viewUntil = 0;
    this.viewSince = 0;
  }

  /**
   * Returns true if an active live session's motion and view hold timers have expired.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasExpiredLiveHold(now) {
    return Boolean(!this.directRtsp && this.isActiveLive() && now >= this.wantUntil());
  }

  /**
   * Returns true if an active live stream has reached the hard max_secs limit.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasReachedMaxDuration(now) {
    return !this.directRtsp && this.isActiveLive() ? now - this.startedAt >= this.timers.maxMs : false;
  }

  /**
   * Returns true if a viewer-only live stream has reached the view_max_secs limit.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasReachedViewMaxDuration(now) {
    return Boolean(
      !this.directRtsp &&
      this.isActiveLive() &&
      !this.isInMotion(now) &&
      now - Math.max(this.startedAt, this.motionUntil) >= this.timers.viewMaxMs
    );
  }

  /**
   * Clears motionUntil and returns the stop reason when max_secs is reached, or empty string otherwise.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  expireMaxDurationHold(now) {
    if (!this.hasReachedMaxDuration(now)) {
      return '';
    }
    this.motionUntil = 0;
    return 'reached max_secs limit (' + Math.round(this.timers.maxMs / MS_PER_MINUTE) + 'm)';
  }

  /**
   * Returns the formatted stop reason when view_max_secs is reached, or empty string otherwise.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  getViewMaxDurationReason(now) {
    if (!this.hasReachedViewMaxDuration(now)) {
      return '';
    }
    return 'reached view_max_secs limit (' + Math.round(this.timers.viewMaxMs / MS_PER_MINUTE) + 'm)';
  }

  /**
   * Marks the motion hold as ended at checkNow for early sleep and returns elapsed quiet seconds.
   *
   * @param {number} checkNow - Current epoch timestamp in milliseconds.
   * @returns {number}
   */
  markEarlySleep(checkNow) {
    const quietSecs = Math.round((checkNow - this.lastMotionAt) / MS_PER_SECOND);
    this.motionUntil = checkNow;
    return quietSecs;
  }

  /**
   * Computes the target expiration timestamp for a motion or view trigger, guaranteeing at least now + ms and
   * extending an active mid-stream session by half-hold up to maxMs while coalescing companion bursts.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} ms - Requested hold duration in milliseconds.
   * @param {{
   *   minExtendMs?: number,
   *   isMidStream?: boolean,
   *   isCompanionBurst?: boolean,
   * }} [opts={}] - Extension options.
   * @returns {number}
   */
  computeTriggerHoldUntil(now, ms, opts = {}) {
    const minExtendMs = opts.minExtendMs ?? DEFAULT_MIN_EXTEND_MS;
    if (!opts.isMidStream) {
      return now + ms;
    }
    const halfMs = Math.max(minExtendMs, Math.round(ms / 2));
    const maxMs = this.timers.maxMs;
    const maxAllowedUntil = this.active && this.startedAt ? this.startedAt + maxMs : now + maxMs;
    const extendedFromCurrent = opts.isCompanionBurst ? this.wantUntil() : Math.max(this.wantUntil(), now) + halfMs;
    return Math.min(maxAllowedUntil, Math.max(now + ms, extendedFromCurrent));
  }

  /**
   * Extends the active motion or viewer hold by half of baseHoldMs up to maxMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {{
   *   baseHoldMs: number,
   *   minExtendMs?: number,
   *   capAtFullHold?: boolean,
   *   hasActiveTriggers?: boolean,
   * }} opts - Active hold extension parameters.
   * @returns {Readonly<{ extended: boolean, extendMs: number, holdSecs: number }>}
   */
  extendActiveHold(now, opts) {
    const baseHoldMs = opts.baseHoldMs;
    const minExtendMs = opts.minExtendMs ?? DEFAULT_MIN_EXTEND_MS;
    const capAtFullHold = opts.capAtFullHold ?? true;
    const prevUntil = this.wantUntil();
    const stepMs = Math.max(minExtendMs, Math.round(baseHoldMs / 2));
    const maxAllowedUntil = this.startedAt + this.timers.maxMs;
    const uncappedNext = Math.min(maxAllowedUntil, Math.max(prevUntil, now) + stepMs);
    const nextUntil = capAtFullHold ? Math.min(now + baseHoldMs, uncappedNext) : uncappedNext;
    const extendMotionHold =
      this.isInMotion(now) ||
      Boolean(opts.hasActiveTriggers) ||
      (this.motionUntil > 0 && this.motionUntil >= this.viewUntil);
    if (extendMotionHold) {
      this.motionUntil = Math.max(this.motionUntil, nextUntil);
    } else {
      this.viewUntil = Math.max(this.viewUntil, nextUntil);
    }
    const extendMs = Math.max(0, this.wantUntil() - Math.max(prevUntil, now));
    const extended = extendMs > 0;
    if (extended) {
      this.runtimeExtended = true;
    }
    return Object.freeze({
      extended,
      extendMs,
      holdSecs: Math.round((this.wantUntil() - now) / MS_PER_SECOND),
    });
  }

  /**
   * Records motionClearedAt and shortens motionUntil when end_early (letEufyDecideEnd) is enabled.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [settleMs=DEFAULT_MOTION_CLEAR_SETTLE_MS] - Post-clear settle duration in ms.
   * @param {number} [minVideoMs=DEFAULT_MIN_EVENT_VIDEO_MS] - Minimum event video duration in ms.
   * @returns {number|null} Shortened remaining seconds if applied, or null.
   */
  shortenHoldOnMotionClear(now, settleMs = DEFAULT_MOTION_CLEAR_SETTLE_MS, minVideoMs = DEFAULT_MIN_EVENT_VIDEO_MS) {
    this.motionClearedAt = now;
    if (this.timers.letEufyDecideEnd && this.active && this.isInMotion(now) && this.gotVideo) {
      const minEnd = Math.max(now + settleMs, (this.firstVideoAt || now) + minVideoMs);
      if (this.motionUntil > minEnd) {
        this.motionUntil = minEnd;
        return Math.round((minEnd - now) / MS_PER_SECOND);
      }
    }
    return null;
  }

  /**
   * Prepares session state for an immediate mid-session RTSP re-wake and returns remaining hold seconds.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {{
   *   minHoldMs?: number,
   *   canExtendHold?: boolean,
   *   baseHoldMs: number,
   * }} opts - Re-wake hold parameters.
   * @returns {{ remainingSecs: number, extended: boolean }}
   */
  prepareRtspRewake(now, opts) {
    const minHoldMs = opts.minHoldMs ?? DEFAULT_MIN_RTSP_REWAKE_HOLD_MS;
    this.rtspRewaking = true;
    this.rtspRewakeStartedAt = now;
    this.restarts = 0;
    this.lastStartAt = now;
    let extended = false;
    if (opts.canExtendHold) {
      const ext = this.extendActiveHold(now, {baseHoldMs: opts.baseHoldMs, hasActiveTriggers: true});
      extended = ext.extended;
    }
    if (this.viewUntil > now && this.viewUntil - now < minHoldMs) {
      this.viewUntil = now + minHoldMs;
    }
    if (this.motionUntil > now && this.motionUntil - now < minHoldMs) {
      this.motionUntil = now + minHoldMs;
    }
    return {
      remainingSecs: Math.round((this.wantUntil() - now) / MS_PER_SECOND),
      extended,
    };
  }

  /**
   * Convenience wrapper preparing an RTSP re-wake and returning remaining hold seconds directly.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {{ minHoldMs?: number, canExtendHold?: boolean, baseHoldMs: number }} opts - Re-wake hold parameters.
   * @returns {number}
   */
  beginRtspRewake(now, opts) {
    return this.prepareRtspRewake(now, opts).remainingSecs;
  }

  /**
   * Returns true if the camera is running a passive background RTSP direct probe before Frame 0 decodes.
   *
   * @returns {boolean}
   */
  isPassiveRtspDirectProbe() {
    return Boolean(this.directRtsp && this.active && !this.gotVideo && this.initiator === RTSP_DIRECT_PROBE_INITIATOR);
  }

  /**
   * Returns true if an idle direct-rtsp_url session should start pulling now.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} hasRtspUrl - Whether a non-empty rtspUrl is configured.
   * @param {number} [intervalMs] - Optional explicit minimum interval between probes in ms.
   * @returns {boolean}
   */
  shouldStartRtspDirect(now, hasRtspUrl, intervalMs = undefined) {
    if (!this.directRtsp || this.active || !hasRtspUrl) {
      return false;
    }
    if (now < this.wantUntil()) {
      return true;
    }
    const effectiveIntervalMs =
      intervalMs ??
      (this.lastEndedHadVideo ? DEFAULT_RTSP_DIRECT_LIVE_RECONNECT_MS : DEFAULT_RTSP_DIRECT_PROBE_INTERVAL_MS);
    return now - (this.lastStoppedAt || 0) >= effectiveIntervalMs;
  }

  /**
   * Promotes an in-flight passive direct-RTSP background probe into an explicit viewer session without
   * restarting an already-spawned FFmpeg RTSP pull decoder.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} lingerMs - Viewer hold duration in milliseconds.
   * @returns {boolean} True if an active passive probe was promoted.
   */
  promotePassiveProbeToViewer(now, lingerMs) {
    if (!this.isPassiveRtspDirectProbe()) {
      return false;
    }
    this.initiator = RTSP_DIRECT_VIEWER_INITIATOR;
    this.reason = RTSP_DIRECT_VIEWER_REASON;
    this.viewSince = now;
    this.viewUntil = Math.max(this.viewUntil, now + lingerMs);
    return true;
  }

  /**
   * Sets direct-RTSP passive probe reason and initiator metadata before starting a probe session.
   */
  markRtspDirectProbeMeta() {
    this.reason = RTSP_DIRECT_STREAM_REASON;
    this.initiator = RTSP_DIRECT_PROBE_INITIATOR;
  }

  /**
   * Starts a passive background direct-RTSP probe session and ensures motionUntil covers holdMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} holdMs - Initial probe hold duration in milliseconds.
   * @returns {string} Initial SESSION_STATES state.
   */
  beginRtspDirectProbe(now, holdMs) {
    this.markRtspDirectProbeMeta();
    const state = this.begin(STREAM_MODES.RTSP, now, true);
    this.motionUntil = Math.max(this.motionUntil, now + holdMs);
    return state;
  }

  /**
   * Evaluates stop reason, initiator, and service-health log output when a direct-rtsp_url stream or probe exits.
   *
   * @param {number|null} code - FFmpeg exit code or null on timeout/stall.
   * @param {string} reasonText - Exit stderr line or timeout description.
   * @param {(clarifiedReason: string) => { isReachableStandby: boolean, disruptionChanged: boolean }} recordFailure
   *   - Callback updating camera reachability when no video was decoded.
   * @returns {Readonly<{
   *   stopWhy: string,
   *   stopInitiator: string,
   *   disruptionChanged: boolean,
   *   isReachableStandby: boolean,
   *   statusLog: string,
   * }>}
   */
  evaluateRtspDirectDrop(code, reasonText, recordFailure) {
    if (this.gotVideo) {
      return Object.freeze({
        stopWhy: 'direct RTSP stream ended (code=' + code + ', info="' + (reasonText || '') + '")',
        stopInitiator: 'eufy/rtsp-end',
        disruptionChanged: false,
        isReachableStandby: true,
        statusLog: '',
      });
    }
    const rawReason = String(reasonText || '').trim();
    const clarifiedReason =
      RTSP_BARE_INVALID_DATA_REGEX.test(rawReason) && !RTSP_COMPONENT_TAG_REGEX.test(rawReason)
        ? 'RTSP server closed connection or sent invalid reply (' + rawReason + ')'
        : rawReason;
    const isNetworkUnreachable = !rawReason || RTSP_NETWORK_UNREACHABLE_REGEX.test(rawReason);
    const {isReachableStandby, disruptionChanged} = recordFailure(clarifiedReason);
    return Object.freeze({
      stopWhy: this._formatDirectProbeStopWhy(isReachableStandby, isNetworkUnreachable, clarifiedReason),
      stopInitiator: RTSP_DIRECT_PROBE_INITIATOR,
      disruptionChanged,
      isReachableStandby,
      statusLog: disruptionChanged
        ? this._formatDirectProbeStatusLog(isReachableStandby, isNetworkUnreachable, clarifiedReason)
        : '',
    });
  }

  /**
   * Formats the stop reason for a direct RTSP probe that exited without video.
   *
   * @param {boolean} isReachableStandby - True on 404 Not Found.
   * @param {boolean} isNetworkUnreachable - True on connection/timeout error.
   * @param {string} clarifiedReason - Clarified stderr snippet.
   * @returns {string}
   */
  _formatDirectProbeStopWhy(isReachableStandby, isNetworkUnreachable, clarifiedReason) {
    if (isReachableStandby) {
      return 'direct RTSP server reachable in standby (404 Not Found)';
    }
    if (isNetworkUnreachable) {
      return 'direct RTSP probe failed (' + (clarifiedReason || 'no video') + ')';
    }
    return 'direct RTSP handshake failed (' + clarifiedReason + ')';
  }

  /**
   * Formats the reachability transition log message for a direct RTSP probe failure.
   *
   * @param {boolean} isReachableStandby - True on 404 Not Found.
   * @param {boolean} isNetworkUnreachable - True on connection/timeout error.
   * @param {string} clarifiedReason - Clarified stderr snippet.
   * @returns {string}
   */
  _formatDirectProbeStatusLog(isReachableStandby, isNetworkUnreachable, clarifiedReason) {
    if (isReachableStandby) {
      return 'direct RTSP endpoint reachable in standby (404 Not Found) -> Asleep';
    }
    if (isNetworkUnreachable) {
      return 'direct RTSP endpoint unreachable (' + (clarifiedReason || 'connection failed') + ') -> Disconnected';
    }
    return 'direct RTSP handshake failed (' + clarifiedReason + ') -> Disconnected';
  }

  /**
   * Evaluates RTSP session health, non-destructive wake retries, handshake protection, and timeouts.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {{
   *   quietSince?: number,
   *   handshakeMinMs?: number,
   *   decStallMs?: number,
   *   retryMs?: number,
   *   maxRetries?: number,
   *   timeoutMs?: number,
   *   midStallMs?: number,
   * }} [opts={}] - Watchdog threshold overrides.
   * @returns {{ action: 'none'|'retry'|'timeout'|'dropped', killStalledDec: boolean, logMsg: string }}
   */
  evaluateRtspHealth(now, opts = {}) {
    const quietSince = opts.quietSince ?? (this.getQuietSince() || this.startedAt);
    const defaultMidStallMs = this.directRtsp ? DEFAULT_RTSP_DIRECT_MID_STALL_MS : DEFAULT_RTSP_MID_STALL_MS;
    const midStallMs = opts.midStallMs ?? defaultMidStallMs;
    if (!this.gotVideo || this.rtspRewaking) {
      return this._evaluateRtspWakeHealth(now, quietSince, opts);
    }
    if (now - this.lastVideoAt > midStallMs) {
      return {
        action: 'dropped',
        killStalledDec: false,
        logMsg: 'no frames for ' + ((now - this.lastVideoAt) / MS_PER_SECOND).toFixed(1) + 's',
      };
    }
    return {action: 'none', killStalledDec: false, logMsg: ''};
  }

  /**
   * Evaluates RTSP wake / re-wake retries and timeouts while waiting for video frames.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} quietSince - Last video or attempt timestamp.
   * @param {Record<string, number|undefined>} opts - Watchdog threshold overrides.
   * @returns {{ action: 'none'|'retry'|'timeout'|'dropped', killStalledDec: boolean, logMsg: string }}
   */
  _evaluateRtspWakeHealth(now, quietSince, opts) {
    const handshakeMinMs = opts.handshakeMinMs ?? DEFAULT_RTSP_HANDSHAKE_MIN_MS;
    const decStallMs = opts.decStallMs ?? DEFAULT_RTSP_DEC_STALL_MS;
    const retryMs = opts.retryMs ?? DEFAULT_RTSP_RETRY_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_RTSP_MAX_RETRIES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RTSP_TIMEOUT_MS;
    const wakeQuietSince = this.rtspRewaking ? this.lastStartAt : quietSince;
    const wakeStartedAt = this.rtspRewaking ? this.rtspRewakeStartedAt || this.lastStartAt : this.startedAt;

    if (this.directRtsp) {
      const directTimeoutMs = Math.min(timeoutMs, DEFAULT_RTSP_DIRECT_TIMEOUT_MS);
      if (now - wakeStartedAt > directTimeoutMs) {
        this.motionUntil = 0;
        return {
          action: 'dropped',
          killStalledDec: false,
          logMsg: 'direct RTSP stream yielded no video after ' + Math.round(directTimeoutMs / MS_PER_SECOND) + 's',
        };
      }
      return {action: 'none', killStalledDec: false, logMsg: ''};
    }
    if (this.isRtspDecoderHandshaking(now, handshakeMinMs, decStallMs)) {
      return {action: 'none', killStalledDec: false, logMsg: ''};
    }
    if (now - wakeQuietSince > retryMs && this.restarts < maxRetries) {
      this.restarts++;
      this.lastStartAt = now;
      const retryWaitSecs = (retryMs / MS_PER_SECOND).toFixed(1);
      const killStalledDec = Boolean(this.dec && now - (this.decSpawnedAt || 0) >= decStallMs);
      const logMsg =
        'RTSP ' +
        (this.rtspRewaking ? 're-wake' : 'wake') +
        ' still waiting for video after ' +
        retryWaitSecs +
        's (retry=' +
        this.restarts +
        '/' +
        maxRetries +
        '), re-sending start_rtsp_livestream (session=' +
        this.id +
        ')';
      return {action: 'retry', killStalledDec, logMsg};
    }
    if (now - wakeStartedAt > timeoutMs) {
      const timeoutSecs = Math.round(timeoutMs / MS_PER_SECOND);
      this.motionUntil = 0;
      const logMsg = 'HomeBase RTSP stream yielded no video after ' + timeoutSecs + 's (' + this.restarts + ' retries)';
      return {action: 'timeout', killStalledDec: false, logMsg};
    }
    return {action: 'none', killStalledDec: false, logMsg: ''};
  }

  /**
   * Evaluates P2P watchdog stall and retry conditions for an active P2P livestream session.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {{
   *   quietSince?: number,
   *   initialRetryMs?: number,
   *   subsequentRetryMs?: number,
   *   maxRetries?: number,
   *   isPiggybackedExternal?: boolean,
   *   hasWakingViewer?: boolean,
   * }} [opts={}] - Watchdog options and caller predicates.
   * @returns {{ action: 'none'|'retry'|'timeout'|'expired', logMsg: string }}
   */
  evaluateP2pHealth(now, opts = {}) {
    const quietSince = opts.quietSince ?? (this.getQuietSince() || this.startedAt);
    const initialRetryMs = opts.initialRetryMs ?? DEFAULT_P2P_INITIAL_RETRY_MS;
    const subsequentRetryMs = opts.subsequentRetryMs ?? DEFAULT_P2P_SUBSEQUENT_RETRY_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_P2P_MAX_RETRIES;
    const retryAfterMs = this.restarts === 0 ? initialRetryMs : subsequentRetryMs;
    if (now - quietSince <= retryAfterMs || this.starting) {
      return {action: 'none', logMsg: ''};
    }
    if (opts.isPiggybackedExternal) {
      this.motionUntil = 0;
      this.viewUntil = 0;
      return {action: 'expired', logMsg: 'external Eufy app stream stopped sending video'};
    }
    if (!this.isInMotion(now) && !opts.hasWakingViewer && this.gotVideo) {
      return {action: 'expired', logMsg: 'viewer disconnected and camera stopped sending video'};
    }
    const quietSecs = ((now - quietSince) / MS_PER_SECOND).toFixed(1);
    const stallCause = this.gotVideo ? 'stream_stalled_mid_session' : 'no_initial_video_after_wake';
    if (++this.restarts > maxRetries) {
      this.motionUntil = 0;
      return {
        action: 'timeout',
        logMsg:
          'camera stopped sending video after ' +
          maxRetries +
          ' retries (cause=' +
          stallCause +
          ', quietFor=' +
          quietSecs +
          's)',
      };
    }
    return {
      action: 'retry',
      logMsg:
        'stream stalled (initiator=bridge-watchdog, cause=' +
        stallCause +
        ', quietFor=' +
        quietSecs +
        's, gotVideo=' +
        this.gotVideo +
        ', retry=' +
        this.restarts +
        '/' +
        maxRetries +
        ') - resetting decoder and re-requesting livestream from eufy',
    };
  }

  /**
   * Transitions the decoder backpressure FSM to nextState when permitted by ALLOWED_DECODER_TRANSITIONS.
   *
   * @param {string} nextState - Target DECODER_STATES value.
   * @param {string} [reason=''] - Human-readable transition reason.
   * @returns {string}
   */
  transitionDecoderTo(nextState, reason = '') {
    const prevState = this.decoderState;
    const allowed = ALLOWED_DECODER_TRANSITIONS[prevState];
    if (prevState && !(allowed && allowed.has(nextState))) {
      this.onDecoderRefused(prevState, nextState, reason);
      return this.decoderState;
    }
    this.decoderState = nextState;
    if (prevState && prevState !== nextState) {
      this.onDecoderTransition(prevState, nextState, reason);
    }
    return this.decoderState;
  }

  /**
   * Resets per-decoder packet queues, pause/EOF flags, and firstFrameAt.
   */
  resetDecoderPipeState() {
    this.pendingVideoPackets = [];
    this.pendingAudioPackets = [];
    this.decoderInputEnded = false;
    this.decoderStdoutPaused = false;
    this.firstFrameAt = 0;
  }

  /**
   * Returns true if proc is the currently attached decoder process.
   *
   * @param {*} proc - Candidate FFmpeg decoder process.
   * @returns {boolean}
   */
  isDecoderProcess(proc) {
    return this.dec === proc;
  }

  /**
   * Returns true if dec is the active decoder for sessionId (and optional mode).
   *
   * @param {*} dec - Spawned FFmpeg decoder process.
   * @param {number} sessionId - Expected session identifier.
   * @param {string} [mode=''] - Optional expected stream mode.
   * @returns {boolean}
   */
  isActiveDecoder(dec, sessionId, mode = '') {
    return Boolean(this.isCurrent(sessionId, mode) && this.dec === dec);
  }

  /**
   * Returns true if a decoder process is currently attached.
   *
   * @returns {boolean}
   */
  hasDecoderProcess() {
    return Boolean(this.dec);
  }

  /**
   * Returns true when compressed video packets are queued waiting for decoder drain.
   *
   * @returns {boolean}
   */
  hasPendingVideoPackets() {
    return this.pendingVideoPackets.length > 0;
  }

  /**
   * Returns true if an RTSP pull decoder has stayed alive past initial 404 exit and is negotiating handshake.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minActiveMs - Minimum process age indicating 404 did not immediately exit.
   * @param {number} maxStallMs - Maximum time to wait for Frame 0 before considering stalled.
   * @returns {boolean}
   */
  isRtspDecoderHandshaking(now, minActiveMs, maxStallMs) {
    const decAgeMs = now - this.decSpawnedAt;
    return this.dec && this.decSpawnedAt ? decAgeMs >= minActiveMs && decAgeMs < maxStallMs : false;
  }

  /**
   * Returns true if incoming stream dimensions differ from the current session dimensions.
   *
   * @param {number} width - Incoming packet width.
   * @param {number} height - Incoming packet height.
   * @returns {boolean}
   */
  hasResolutionChanged(width, height) {
    return Boolean(
      (width && this.videoWidth && width !== this.videoWidth) ||
      (height && this.videoHeight && height !== this.videoHeight)
    );
  }

  /**
   * Returns true if an active decoder is running and the incoming stream codec changed.
   *
   * @param {string} codec - Incoming video codec string.
   * @returns {boolean}
   */
  hasCodecChanged(codec) {
    return Boolean(this.dec && this.videoCodec && codec !== this.videoCodec);
  }

  /**
   * Updates the current session video codec and resolution metadata.
   *
   * @param {string} codec - Video codec name.
   * @param {number} width - Video width in pixels.
   * @param {number} height - Video height in pixels.
   */
  updateStreamFormat(codec, width, height) {
    this.videoCodec = codec;
    this.videoWidth = width;
    this.videoHeight = height;
  }

  /**
   * Attaches a spawned FFmpeg decoder process, transitions to HANDSHAKING, and drains queued packets.
   *
   * @param {*} dec - Spawned FFmpeg ChildProcess.
   * @param {number} [spawnedAt=0] - Spawn timestamp in milliseconds.
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio pipe draining is enabled.
   */
  attachDecoder(dec, spawnedAt = 0, audioEnabled = AUDIO) {
    this.dec = dec;
    this.decSpawnedAt = spawnedAt;
    this.transitionDecoderTo(DECODER_STATES.HANDSHAKING, 'decoder attached');
    this.drainPendingDecoderInput(audioEnabled);
  }

  /**
   * Clears any RTSP retry timer, resets decoder pipes and format state, transitions to DETACHED, and returns dec.
   *
   * @returns {*} Detached FFmpeg ChildProcess or null.
   */
  detachDecoder() {
    this.clearRtspRetryTimer();
    const dec = this.dec;
    this.dec = null;
    this.decSpawnedAt = 0;
    this.resetDecoderPipeState();
    this.transitionDecoderTo(DECODER_STATES.DETACHED, 'decoder detached');
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoCodec = '';
    return dec;
  }

  /**
   * Clears dec (and optionally decSpawnedAt) when it matches the exiting decoder process.
   *
   * @param {*} dec - Exiting FFmpeg decoder process.
   * @param {boolean} [clearSpawnedAt=false] - Whether to reset decSpawnedAt = 0.
   * @returns {boolean} True if matched and cleared.
   */
  detachDecoderIfMatch(dec, clearSpawnedAt = false) {
    if (this.dec === dec) {
      this.dec = null;
      if (clearSpawnedAt) {
        this.decSpawnedAt = 0;
      }
      return true;
    }
    return false;
  }

  /**
   * Returns true if an exiting backfill decoder still has unread stdout frames that must finish draining first.
   *
   * @param {*} dec - Exiting FFmpeg decoder process.
   * @returns {boolean}
   */
  shouldDeferDecoderDetachOnExit(dec) {
    const canListenStdoutClose = Boolean(
      dec &&
      dec.stdout &&
      !dec.stdout.readableEnded &&
      !dec.stdout.closed &&
      (typeof dec.stdout.once === 'function' || typeof dec.stdout.on === 'function')
    );
    return Boolean(this.dec === dec && this.isBackfillPlayback() && canListenStdoutClose);
  }

  /**
   * Marks the attached FFmpeg decoder as actively decoding media.
   *
   * @returns {string} Resulting decoder FSM state.
   */
  markDecoderDecoding() {
    if (!this.decoderStdoutPaused && !this.decoderInputEnded) {
      return this.transitionDecoderTo(DECODER_STATES.DECODING, 'first frame decoded');
    }
    return this.decoderState;
  }

  /**
   * Pauses decoder stdout when backfill frame buffering hits high watermark and transitions to PAUSED_BACKPRESSURE.
   *
   * @returns {string} Resulting decoder FSM state.
   */
  pauseDecoderStdout() {
    this.decoderStdoutPaused = true;
    this.transitionDecoderTo(DECODER_STATES.PAUSED_BACKPRESSURE, 'high watermark reached');
    if (this.dec && this.dec.stdout && typeof this.dec.stdout.pause === 'function') {
      this.dec.stdout.pause();
    }
    return this.decoderState;
  }

  /**
   * Appends a compressed packet to a bounded queue using a drop-oldest policy.
   *
   * @param {Uint8Array[]} queue - Target pending packet queue.
   * @param {Uint8Array} packetBuf - Compressed packet buffer.
   * @param {number} maxPackets - Maximum packets retained before evicting oldest.
   */
  _pushBoundedPacket(queue, packetBuf, maxPackets) {
    while (queue.length >= maxPackets) {
      queue.shift();
      this.droppedFrames++;
    }
    queue.push(packetBuf);
  }

  /**
   * Queues a compressed Annex-B video packet when paused/backpressured or writes it directly to decoder stdin.
   *
   * @param {Uint8Array} packetBuf - Raw compressed H.264/H.265 packet.
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio pipe draining is enabled.
   * @returns {boolean} True if written or queued.
   */
  enqueueOrWriteVideoPacket(packetBuf, audioEnabled = AUDIO) {
    const stdin = this.dec ? this.dec.stdin : null;
    if (!stdin || !stdin.writable) {
      return false;
    }
    if (this.decoderStdoutPaused || this.pendingVideoPackets.length > 0 || stdin.writableNeedDrain) {
      const maxVideoPkts = this.isBackfillPlayback()
        ? MAX_DOWNLOAD_PENDING_VIDEO_PACKETS
        : MAX_LIVE_PENDING_VIDEO_PACKETS;
      this._pushBoundedPacket(this.pendingVideoPackets, packetBuf, maxVideoPkts);
      if (!this.decoderStdoutPaused && !stdin.writableNeedDrain) {
        this.drainPendingDecoderInput(audioEnabled);
      }
      return true;
    }
    stdin.write(packetBuf);
    return true;
  }

  /**
   * Writes a compressed AAC audio packet to decoder stdio[3] or queues it while spawning/backpressured.
   *
   * @param {Uint8Array} packetBuf - Raw compressed AAC packet.
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio is enabled.
   * @returns {boolean} True if written or queued.
   */
  enqueueOrWriteAudioPacket(packetBuf, audioEnabled = AUDIO) {
    if (!audioEnabled) {
      return false;
    }
    const maxAudioPkts = this.isBackfillPlayback()
      ? MAX_DOWNLOAD_PENDING_AUDIO_PACKETS
      : MAX_LIVE_PENDING_AUDIO_PACKETS;
    if (!this.dec && this.canIngestP2pPacket()) {
      this._pushBoundedPacket(this.pendingAudioPackets, packetBuf, maxAudioPkts);
      return true;
    }
    const audioStream =
      this.dec && this.dec.stdio && this.dec.stdio[DECODER_AUDIO_PIPE_INDEX]
        ? this.dec.stdio[DECODER_AUDIO_PIPE_INDEX]
        : null;
    if (!audioStream || !audioStream.writable) {
      return false;
    }
    if (this.pendingAudioPackets.length > 0 || audioStream.writableNeedDrain) {
      this._pushBoundedPacket(this.pendingAudioPackets, packetBuf, maxAudioPkts);
      if (!audioStream.writableNeedDrain) {
        this.drainPendingDecoderInput(audioEnabled);
      }
      return true;
    }
    audioStream.write(packetBuf);
    return true;
  }

  /**
   * Drains queued video/audio packets into FFmpeg decoder pipes and closes pipes once markDecoderInputEnded was set.
   *
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio pipe draining is enabled.
   * @param {boolean} [fromPipeDrain=false] - Whether invoked from an input pipe drain event.
   */
  drainPendingDecoderInput(audioEnabled = AUDIO, fromPipeDrain = false) {
    if (!this.dec) {
      return;
    }
    const stdin = this.dec.stdin;
    if (!this.decoderStdoutPaused || fromPipeDrain) {
      while (this.pendingVideoPackets.length > 0 && stdin && stdin.writable && !stdin.writableNeedDrain) {
        stdin.write(this.pendingVideoPackets.shift());
      }
    }
    const audioStream =
      audioEnabled && this.dec.stdio && this.dec.stdio[DECODER_AUDIO_PIPE_INDEX]
        ? this.dec.stdio[DECODER_AUDIO_PIPE_INDEX]
        : null;
    while (
      this.pendingAudioPackets.length > 0 &&
      audioStream &&
      audioStream.writable &&
      !audioStream.writableNeedDrain
    ) {
      audioStream.write(this.pendingAudioPackets.shift());
    }
    if (this.decoderInputEnded) {
      this._closeEndedDecoderPipes(stdin, audioStream);
    }
  }

  /**
   * Closes drained FFmpeg decoder input pipes after EOF has been signaled.
   *
   * @param {*} stdin - Decoder video stdin pipe.
   * @param {*} audioStream - Decoder audio pipe (stdio[3]).
   */
  _closeEndedDecoderPipes(stdin, audioStream) {
    if (this.pendingAudioPackets.length === 0) {
      try {
        if (audioStream && audioStream.writable) {
          audioStream.end();
        }
      } catch (err) {
        // Ignore errors when closing decoder audio pipe after draining.
      }
    }
    if (this.pendingVideoPackets.length === 0) {
      if (!this.decoderStdoutPaused && this.pendingAudioPackets.length === 0) {
        this.transitionDecoderTo(DECODER_STATES.FLUSHING_EOF, 'input pipe ended');
      }
      try {
        if (stdin && stdin.writable) {
          stdin.end();
        }
      } catch (err) {
        // Ignore errors when closing decoder video pipe after draining.
      }
    }
  }

  /**
   * Marks decoder input as ended (on backfill download EOF) and drains/closes input pipes.
   *
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio pipe is enabled.
   */
  markDecoderInputEnded(audioEnabled = AUDIO) {
    this.decoderInputEnded = true;
    if (!this.decoderStdoutPaused && this.pendingVideoPackets.length === 0 && this.pendingAudioPackets.length === 0) {
      this.transitionDecoderTo(DECODER_STATES.FLUSHING_EOF, 'input pipe ended');
    }
    this.drainPendingDecoderInput(audioEnabled);
  }

  /**
   * Resumes decoder stdout when paused for backfill backpressure and drains queued compressed packets.
   *
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio pipe draining is enabled.
   */
  resumeDecoderStdout(audioEnabled = AUDIO) {
    if (!this.decoderStdoutPaused && this.decoderState !== DECODER_STATES.PAUSED_BACKPRESSURE) {
      return;
    }
    this.decoderStdoutPaused = false;
    const allInputDrained =
      this.decoderInputEnded && this.pendingVideoPackets.length === 0 && this.pendingAudioPackets.length === 0;
    this.transitionDecoderTo(
      allInputDrained ? DECODER_STATES.FLUSHING_EOF : DECODER_STATES.DECODING,
      allInputDrained ? 'input pipe ended' : 'low watermark resumed'
    );
    if (this.dec && this.dec.stdout && typeof this.dec.stdout.resume === 'function') {
      this.dec.stdout.resume();
    }
    this.drainPendingDecoderInput(audioEnabled);
  }
}

module.exports = {
  MAX_LIVE_PENDING_VIDEO_PACKETS,
  MAX_DOWNLOAD_PENDING_VIDEO_PACKETS,
  MAX_LIVE_PENDING_AUDIO_PACKETS,
  StreamSession,
};
