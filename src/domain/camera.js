// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Camera domain entity composing StatusCard, Telemetry, and BackfillJob models
 * alongside per-camera stream session state and arbitration priority rules.
 */
'use strict';

const {
  clampNum,
  FRAME,
  MAX_MS,
  VIEW_MAX_MS,
  HOLD_MS,
  LOW_BAT_HOLD_MS,
  EARLY_SLEEP_MS,
  COOLDOWN_MS,
  EVENT_SECS,
  PREEMPT_EVENT_STREAMS,
  LET_EUFY_DECIDE_END,
  BACKFILL_DOWNLOADS,
  INSTANT_EVENT_SNAPSHOT,
  MIN_CAMERA_PRIORITY,
  MAX_CAMERA_PRIORITY,
  DEFAULT_CAMERA_PRIORITY,
  KEYFRAME_BURST_MS,
  SHORT_KEYFRAME_BURST_MS,
  GLOBAL_PRESERVE_ASPECT,
  GLOBAL_STARTUP_SNAPSHOT,
  GLOBAL_USE_RTSP,
  ACTIVE_HWACCEL,
} = require('../config');
const {log} = require('../logger');
const {Telemetry} = require('./telemetry');
const {StatusCard} = require('./status-card');
const {DEFAULT_BACKFILL_MAX_AGE_MS, BackfillJob} = require('./backfill-job');

const INITIAL_KEYFRAME_BURST_MS = 2000;

/**
 * Determines whether a camera needs a brief startup snapshot probe on boot.
 *
 * @param {string} backgroundMode - Resolved card background ('snapshot', 'slate', 'black').
 * @param {boolean|string} startupMode - Configured startup_snapshot setting.
 * @param {Uint8Array|null} cachedFrame - Cached YUV420p frame loaded from disk, if any.
 * @returns {boolean}
 */
function shouldProbeStartupSnapshot(backgroundMode, startupMode, cachedFrame) {
  if (backgroundMode !== 'snapshot') {
    return false;
  }
  if (startupMode === 'always') {
    return true;
  }
  return Boolean(startupMode) && cachedFrame === null;
}

/**
 * Represents a configured Eufy camera and its runtime stream, overlay, and telemetry state.
 */
class Camera {
  /**
   * @param {Record<string, *>} rawCamCfg - Camera entry from config.json cameras[].
   * @param {{ frame: Uint8Array|null, lastSeen: string }} cachedSnapshot - Initial cached frame from disk.
   * @param {(cam: Camera) => void} [renderCardsFn] - Optional callback to pre-render initial status cards.
   */
  constructor(rawCamCfg, cachedSnapshot = {frame: null, lastSeen: ''}, renderCardsFn = null) {
    Object.assign(this, rawCamCfg);

    // 1. Composed Domain Models (StatusCard & Telemetry)
    /** @type {StatusCard} */
    this.card = new StatusCard(rawCamCfg);
    /** @type {Telemetry} */
    this.telemetry = new Telemetry(rawCamCfg, cachedSnapshot.lastSeen);

    // 2. Identity, Priority & Routing Configuration
    const startupMode = rawCamCfg.startup_snapshot ?? GLOBAL_STARTUP_SNAPSHOT;
    this.priority = clampNum(
        rawCamCfg.priority,
        MIN_CAMERA_PRIORITY,
        MAX_CAMERA_PRIORITY,
        DEFAULT_CAMERA_PRIORITY
    );
    this.eventPriority = 0;
    this.stationSerial = rawCamCfg.station_serial || '';
    this.useRtsp = rawCamCfg.use_rtsp ?? (GLOBAL_USE_RTSP || Boolean(rawCamCfg.rtsp_url));
    this.rtspUrl = rawCamCfg.rtsp_url || '';
    this.rtspSupported = Boolean(rawCamCfg.rtsp_url || rawCamCfg.use_rtsp === true);
    this.rtspEnabledChecked = false;
    this.preserveAspect = rawCamCfg.preserve_aspect_ratio ?? GLOBAL_PRESERVE_ASPECT;
    this.useHwaccel = Boolean(ACTIVE_HWACCEL);

    // 3. Startup Snapshot & Backfill State
    this.needsStartupSnapshot = shouldProbeStartupSnapshot(
        this.card.background,
        startupMode,
        cachedSnapshot.frame
    );
    this.isStartupProbe = false;
    /** @type {BackfillJob|null} */
    this.pendingBackfill = null;
    this.backfillClip = null;
    this.lastBackfillQueryAt = 0;
    this.downloadedPaths = new Set();
    this.downloadFrames = [];
    this.downloadFinished = false;
    this.isTestBackfill = false;

    // 4. Active Stream Session & Timers
    this.active = false;
    this.activeMode = '';
    this.starting = false;
    this.startPromise = null;
    this.eventActive = false;
    this.sessionId = 0;
    this.p2pReady = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.rtspRetryTimer = null;
    this.lastStoppedAt = 0;
    this.lastUnsolicitedStopAt = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoCodec = '';
    this.motionUntil = 0;
    this.lastMotionAt = 0;
    this.motionClearedAt = 0;
    this.lastEarlySleepCheckAt = 0;
    this.lastExtendCheckAt = 0;
    this.viewUntil = 0;
    this.viewSince = 0;
    this.apiWakeTimer = null;
    this.apiWakePendingOpts = null;
    this.apiWakeScheduledAt = 0;
    this.lastApiWakeAt = 0;
    this.lastApiTriggerLogAt = 0;
    this.reason = '';
    this.wakeInitiator = '';
    this.sleptAt = 0;
    this.burstUntil = Date.now() + INITIAL_KEYFRAME_BURST_MS;
    this.firstVideoAt = 0;
    this.firstFrameAt = 0;
    this.startedAt = 0;
    this.lastStartAt = 0;
    this.lastVideoAt = 0;
    this.restarts = 0;
    this.gotVideo = false;
    this.frigateSawObject = false;
    this.runtimeExtended = false;

    // 5. Frigate External Event State
    this.evTimer = null;
    this.evPending = false;
    this.evLabel = '';
    this.evPerson = '';
    this.evUntil = 0;

    // 6. FFmpeg Process & Media Buffers
    this.enc = null;
    this.dec = null;
    this.decSpawnedAt = 0;
    this.frame = null;
    this.lastFrame = cachedSnapshot.frame;
    this.frameAt = 0;
    this.frameNew = false;
    this.lastWrite = Date.now();
    this.lastSent = null;
    this.pcm = [];
    this.pcmLen = 0;
    this.viewers = 0;
    this.viewerIds = new Map();

    if (typeof renderCardsFn === 'function') {
      renderCardsFn(this);
    }
  }

  /**
   * Returns the human-readable display title for this camera.
   *
   * @returns {string}
   */
  getDisplayTitle() {
    return this.title || this.name;
  }

  /**
   * Extends the encoder keyframe burst window by durationMs from now.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [durationMs=SHORT_KEYFRAME_BURST_MS] - Burst duration in milliseconds.
   */
  triggerKeyframeBurst(now = Date.now(), durationMs = SHORT_KEYFRAME_BURST_MS) {
    this.burstUntil = Math.max(this.burstUntil || 0, now + durationMs);
  }

  /**
   * Returns true if the camera is currently inside a keyframe burst window.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isInKeyframeBurst(now = Date.now()) {
    return now < (this.burstUntil || 0);
  }

  /**
   * Initializes per-session runtime state when a camera transitions to active streaming.
   *
   * @param {'rtsp'|'p2p'|'download'} mode - Active stream mode.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [p2pReady=true] - Whether the stream is ready to receive video frames immediately.
   */
  beginSession(mode, now = Date.now(), p2pReady = true) {
    this.active = true;
    this.activeMode = mode;
    this.sessionId++;
    this.p2pReady = p2pReady;
    this.startedAt = now;
    this.lastStartAt = now;
    this.gotVideo = false;
    this.frigateSawObject = false;
    this.runtimeExtended = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.restarts = 0;
    this.lastVideoAt = 0;
    this.burstUntil = now + KEYFRAME_BURST_MS;
  }

  /**
   * Resets per-session runtime state when an active stream stops and transitions to sleep.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [hadVideo=false] - Whether decoded video was received during the session.
   * @param {boolean} [preemptedByViewer=false] - Whether stopped due to viewer switching cameras.
   * @param {string} [closedMode='p2p'] - Stream mode that just closed.
   */
  endSession(now = Date.now(), hadVideo = false, preemptedByViewer = false, closedMode = 'p2p') {
    this.active = false;
    this.activeMode = '';
    this.isTestBackfill = false;
    this.downloadFinished = false;
    this.downloadFrames = [];
    this.starting = false;
    this.startPromise = null;
    this.eventActive = false;
    this.runtimeExtended = false;
    this.motionUntil = 0;
    this.eventPriority = 0;
    this.p2pReady = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.isStartupProbe = false;
    this.motionClearedAt = 0;
    this.sessionId++;
    this.lastStoppedAt = now;
    this.decSpawnedAt = 0;
    if (hadVideo && !preemptedByViewer && closedMode !== 'download') {
      this.sleptAt = now;
    }
    this.burstUntil = now + KEYFRAME_BURST_MS;
    this.clearViewerQueue();
  }

  /**
   * Captures final session metrics, preserves the latest decoded frame into lastFrame,
   * transitions the camera to sleep via endSession(), and returns the formatted SLEEP log message.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} why - Reason the camera is going to sleep.
   * @param {boolean} [preemptedByViewer=false] - Whether stopped due to viewer switching cameras.
   * @param {string} [initiator='bridge'] - Decision maker identifier.
   * @returns {{ inFlightStart: Promise<*>|null, closedMode: string, sleepMsg: string }}
   */
  terminateSession(now, why, preemptedByViewer = false, initiator = 'bridge') {
    const inFlightStart = this.startPromise;
    const hadVideo = this.gotVideo;
    const liveSecs = Math.round((now - this.startedAt) / 1000);
    const lastVideoAgo = this.lastVideoAt ? ((now - this.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
    const restartsCount = this.restarts;
    const closedSession = this.sessionId;
    const closedMode = this.activeMode || 'p2p';

    this.clearApiWakeTimer();
    if (Buffer.isBuffer(this.frame) && this.frame.length === FRAME) {
      this.lastFrame = Buffer.from(this.frame);
    }
    this.endSession(now, hadVideo, preemptedByViewer, closedMode);

    const sleepMsg =
        'SLEEP (initiator=' +
        initiator +
        ', reason="' +
        why +
        '", live=' +
        liveSecs +
        's, gotVideo=' +
        hadVideo +
        ', lastVideoAgo=' +
        lastVideoAgo +
        ', restarts=' +
        restartsCount +
        ', session=' +
        closedSession +
        ')';

    return {inFlightStart, closedMode, sleepMsg};
  }

  /**
   * Returns the timestamp until which the camera wants to remain awake.
   *
   * @returns {number}
   */
  wantUntil() {
    return Math.max(this.motionUntil, this.viewUntil);
  }

  /**
   * Returns true if the camera is currently within an active motion hold window.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @returns {boolean}
   */
  isInMotion(now = Date.now()) {
    return now < this.motionUntil;
  }

  /**
   * Returns the effective arbitration priority score (base camera priority + active event boost).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @returns {number}
   */
  getEffectivePriority(now = Date.now()) {
    if (!this.isInMotion(now)) {
      return this.priority;
    }
    return this.priority + (this.eventPriority || 0);
  }

  /**
   * Returns true if the camera is currently active using the shared HomeBase P2P slot.
   *
   * @returns {boolean}
   */
  usesP2pSlot() {
    return Boolean(this.active && this.activeMode !== 'rtsp');
  }

  /**
   * Returns true if the camera is currently active in HomeBase clip backfill download mode.
   *
   * @returns {boolean}
   */
  isBackfillPlayback() {
    return Boolean(this.active && this.activeMode === 'download');
  }

  /**
   * Returns true if the camera is configured and eligible to stream via HomeBase native RTSP.
   *
   * @returns {boolean}
   */
  isRtspCapable() {
    if (!this.useRtsp || !this.rtspUrl) {
      return false;
    }
    return this.activeMode !== 'p2p' && this.activeMode !== 'download';
  }

  /**
   * Returns the station serial key governing this camera's P2P slot.
   *
   * @returns {string}
   */
  getStationKey() {
    return this.stationSerial || this.station_serial || 'default_station';
  }

  /**
   * Returns true if the camera is currently in Low-Battery Economy Mode.
   *
   * @returns {boolean}
   */
  isLowBattery() {
    return this.telemetry.isLowBattery();
  }

  /**
   * Returns true if at least one connected go2rtc consumer is an eligible waking human viewer.
   *
   * @returns {boolean}
   */
  hasWakingViewer() {
    for (const isWaking of this.viewerIds.values()) {
      if (isWaking) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clears any pending viewer wake timer on this camera and marks all current go2rtc
   * consumers as ineligible to wake it until they disconnect and reconnect.
   *
   * @param {string} [clearReason=''] - Optional diagnostic context for why the viewer queue was cleared.
   */
  clearViewerQueue(clearReason = '') {
    const hadViewers = this.viewUntil > Date.now() || this.hasWakingViewer();
    this.viewUntil = 0;
    this.viewSince = 0;
    for (const id of this.viewerIds.keys()) {
      this.viewerIds.set(id, false);
    }
    if (hadViewers && clearReason) {
      log.debug(this, 'cleared pending viewer wake queue (' + clearReason + ')');
    }
  }

  /**
   * Clears any pending or matched HomeBase backfill clip request on this camera.
   */
  clearPendingBackfill() {
    this.pendingBackfill = null;
    this.backfillClip = null;
  }

  /**
   * Cancels a pending non-test backfill request once live streaming has delivered at least
   * minVideoMs of video or the session runtime has been extended.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minVideoMs - Minimum decoded video duration required to cancel backfill.
   * @returns {boolean} True if a pending backfill job was canceled.
   */
  cancelBackfillIfLiveConfirmed(now, minVideoMs) {
    if (!this.pendingBackfill || this.pendingBackfill.isUrgentTest() || this.activeMode === 'download') {
      return false;
    }
    const videoStartRef = this.firstFrameAt || this.firstVideoAt;
    const hasSustainedLiveVideo = videoStartRef > 0 && now - videoStartRef >= minVideoMs;
    if (this.runtimeExtended || this.frigateSawObject || hasSustainedLiveVideo) {
      this.clearPendingBackfill();
      return true;
    }
    return false;
  }

  /**
   * Returns true if the camera has a pending backfill job waiting for Frigate object confirmation.
   *
   * @returns {boolean}
   */
  needsBackfillObjectCheck() {
    return Boolean(this.pendingBackfill && !this.frigateSawObject);
  }

  /**
   * Returns true if the camera has an unfulfilled backfill request that has exceeded maxAgeMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [maxAgeMs=DEFAULT_BACKFILL_MAX_AGE_MS] - Maximum allowed age in milliseconds.
   * @returns {boolean}
   */
  isBackfillExpired(now, maxAgeMs = DEFAULT_BACKFILL_MAX_AGE_MS) {
    if (!this.pendingBackfill) {
      return false;
    }
    return this.pendingBackfill.isExpired(now, maxAgeMs);
  }

  /**
   * Returns true if this camera is idle and ready to query the HomeBase database for a backfill clip.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minEventAgeMs - Minimum age of the trigger event before querying HomeBase.
   * @param {number} queryCooldownMs - Minimum interval between database queries on the same camera.
   * @returns {boolean}
   */
  canQueryBackfill(now, minEventAgeMs, queryCooldownMs) {
    return Boolean(
        !this.active &&
        this.pendingBackfill &&
        !this.backfillClip &&
        now - this.pendingBackfill.at >= minEventAgeMs &&
        now - this.lastBackfillQueryAt >= queryCooldownMs
    );
  }

  /**
   * Attempts to match a parsed HomeBase database clip candidate against this camera's pending
   * BackfillJob, storing the matched clip descriptor on this.backfillClip when within the window.
   *
   * @param {{ devSn: string, storagePath: string, cipherId: number, clipMs: number }} candidate - Parsed DB row.
   * @returns {boolean} True if matched and assigned to this.backfillClip.
   */
  tryMatchBackfillCandidate(candidate) {
    if (!this.pendingBackfill || this.backfillClip) {
      return false;
    }
    const job =
        this.pendingBackfill instanceof BackfillJob
            ? this.pendingBackfill
            : new BackfillJob(this.pendingBackfill);
    if (!job.matchesCandidate(candidate, this.downloadedPaths)) {
      return false;
    }
    this.backfillClip = job.toMatchedClip(candidate);
    return true;
  }

  /**
   * Returns true if the camera is currently active in the given sessionId (and optional mode).
   *
   * @param {number} sessionId - Expected session identifier.
   * @param {string} [mode=''] - Optional expected activeMode ('rtsp', 'p2p', 'download').
   * @returns {boolean}
   */
  isCurrentSession(sessionId, mode = '') {
    return Boolean(
        this.active && this.sessionId === sessionId && (!mode || this.activeMode === mode)
    );
  }

  /**
   * Returns true if the given FFmpeg decoder process is still the active decoder for sessionId.
   *
   * @param {*} dec - Spawned FFmpeg decoder process.
   * @param {number} sessionId - Expected session identifier.
   * @param {string} [mode=''] - Optional expected activeMode.
   * @returns {boolean}
   */
  isActiveDecoder(dec, sessionId, mode = '') {
    return Boolean(this.isCurrentSession(sessionId, mode) && this.dec === dec);
  }

  /**
   * Returns true if the camera is active and ready to ingest incoming P2P/download A/V packets.
   *
   * @returns {boolean}
   */
  canIngestP2pPacket() {
    return Boolean(this.active && this.p2pReady);
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
   * Checks whether a startup snapshot probe has captured enough stable video and, if no motion
   * or human viewer is holding the stream, marks the probe complete and returns true to stop.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minCaptureMs - Required video capture duration in milliseconds.
   * @returns {boolean} True if the camera should be stopped after completing the startup probe.
   */
  completeStartupProbeIfReady(now, minCaptureMs) {
    if (!this.isStartupProbe || !this.firstFrameAt || now - this.firstFrameAt < minCaptureMs) {
      return false;
    }
    this.isStartupProbe = false;
    return !this.isInMotion(now) && !this.hasWakingViewer();
  }

  /**
   * Marks this camera as actively running a startup snapshot probe.
   */
  startStartupProbe() {
    this.needsStartupSnapshot = false;
    this.isStartupProbe = true;
  }

  /**
   * Cancels any pending or active startup snapshot probe on this camera.
   */
  cancelStartupProbe() {
    this.isStartupProbe = false;
    this.needsStartupSnapshot = false;
  }

  /**
   * Returns true if the camera has a decoded video frame newer than maxAgeMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} maxAgeMs - Maximum frame age in milliseconds.
   * @returns {boolean}
   */
  hasFreshFrame(now, maxAgeMs) {
    return Boolean(this.frame && now - this.frameAt < maxAgeMs);
  }

  /**
   * Returns true if the camera is actively streaming live video (or holding its last frame while active).
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} freshFrameMaxAgeMs - Maximum age of a live frame in milliseconds.
   * @returns {boolean}
   */
  isStreamingLive(now, freshFrameMaxAgeMs) {
    return Boolean(
        this.active &&
        (this.hasFreshFrame(now, freshFrameMaxAgeMs) ||
            (this.gotVideo && Buffer.isBuffer(this.lastFrame)))
    );
  }

  /**
   * Returns true if the camera has decoded enough live video (or just finished a short clip)
   * to file a Frigate detection event with a clean live snapshot.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} requiredDelayMs - Required continuous video duration in milliseconds.
   * @param {number} freshFrameMs - Maximum age of a live frame in milliseconds.
   * @param {number} recentFallbackMs - Window after stream stop where gotVideo still counts.
   * @returns {boolean}
   */
  isReadyForEventSnapshot(now, requiredDelayMs, freshFrameMs, recentFallbackMs) {
    const hasSustainedLiveVideo =
        this.active &&
        this.hasFreshFrame(now, freshFrameMs) &&
        this.firstFrameAt > 0 &&
        now - this.firstFrameAt >= requiredDelayMs;
    const hasRecentCompletedVideo =
        INSTANT_EVENT_SNAPSHOT &&
        !this.active &&
        this.gotVideo &&
        now - this.lastVideoAt < recentFallbackMs;
    return Boolean(hasSustainedLiveVideo || hasRecentCompletedVideo);
  }

  /**
   * Returns true if the camera is already active in a live-view or backfill download session.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isActivelyViewing(now = Date.now()) {
    return Boolean(this.active && (now < this.viewUntil || this.activeMode === 'download'));
  }

  /**
   * Returns true if the camera recently went to sleep and is within the viewer cooldown window.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isInViewerCooldown(now = Date.now()) {
    return now - this.sleptAt < COOLDOWN_MS;
  }

  /**
   * Evaluates whether an active live session is due for a Frigate object-detection poll
   * (either to extend the hold near timeout or to confirm live capture for backfill cancellation).
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} checkWindowMs - Remaining hold window within which to check for hold extension.
   * @param {number} safetyMarginMs - Safety buffer before MAX_MS.
   * @param {number} pollCooldownMs - Minimum interval between Frigate polls.
   * @returns {{ shouldPoll: boolean, needsTimeoutExtendCheck: boolean }}
   */
  shouldPollFrigateForHoldOrBackfill(now, checkWindowMs, safetyMarginMs, pollCooldownMs) {
    const canEvaluate = Boolean(
        this.active && this.gotVideo && this.activeMode !== 'download' && !this.isStartupProbe
    );
    if (!canEvaluate) {
      return {shouldPoll: false, needsTimeoutExtendCheck: false};
    }
    const nearMaxLimit = now - this.startedAt >= MAX_MS - safetyMarginMs;
    const needsTimeoutExtendCheck = this.wantUntil() - now <= checkWindowMs && !nearMaxLimit;
    if (!needsTimeoutExtendCheck && !this.needsBackfillObjectCheck()) {
      return {shouldPoll: false, needsTimeoutExtendCheck: false};
    }
    if (now - (this.lastExtendCheckAt || 0) < pollCooldownMs) {
      return {shouldPoll: false, needsTimeoutExtendCheck: false};
    }
    this.lastExtendCheckAt = now;
    return {shouldPoll: true, needsTimeoutExtendCheck};
  }

  /**
   * Evaluates whether an active motion-woken camera is due for an early-sleep Frigate idle check.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} pollIntervalMs - Minimum interval between Frigate idle polls.
   * @param {number} settleMs - Settle delay after Eufy reports activity cleared.
   * @returns {{ due: boolean, clearedByEufy: boolean }}
   */
  checkEarlySleepDue(now, pollIntervalMs, settleMs) {
    if (EARLY_SLEEP_MS <= 0 || !this.active || !this.isInMotion(now) || now < this.viewUntil) {
      return {due: false, clearedByEufy: false};
    }
    if (!this.gotVideo || now - this.firstVideoAt < EARLY_SLEEP_MS) {
      return {due: false, clearedByEufy: false};
    }
    if (now - this.lastEarlySleepCheckAt < pollIntervalMs) {
      return {due: false, clearedByEufy: false};
    }
    const clearedByEufy =
        this.motionClearedAt > this.lastMotionAt && now - this.motionClearedAt >= settleMs;
    const elapsedQuiet = now - this.lastMotionAt >= EARLY_SLEEP_MS;
    if (!clearedByEufy && !elapsedQuiet) {
      return {due: false, clearedByEufy: false};
    }
    this.lastEarlySleepCheckAt = now;
    return {due: true, clearedByEufy};
  }

  /**
   * Returns true if an RTSP pull decoder process has stayed alive past initial 404 rejection
   * and is actively negotiating RTSP setup or waiting for the first keyframe.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minActiveMs - Minimum process age indicating 404 did not immediately exit.
   * @param {number} maxStallMs - Maximum time to wait for the first frame before considering stalled.
   * @returns {boolean}
   */
  isRtspDecoderHandshaking(now, minActiveMs, maxStallMs) {
    if (!this.dec || !this.decSpawnedAt) {
      return false;
    }
    const decAgeMs = now - this.decSpawnedAt;
    return decAgeMs >= minActiveMs && decAgeMs < maxStallMs;
  }

  /**
   * Returns true if Eufy cleanly ended an active event livestream when let_eufy_decide_event_end is enabled.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minCleanVideoMs - Minimum decoded video duration before honoring Eufy stop.
   * @returns {boolean}
   */
  didEufyEndEventCleanly(now, minCleanVideoMs) {
    return Boolean(
        this.active &&
        this.eventActive &&
        LET_EUFY_DECIDE_END &&
        this.gotVideo &&
        now >= this.viewUntil &&
        (this.motionClearedAt > this.lastMotionAt || now - this.firstVideoAt >= minCleanVideoMs)
    );
  }

  /**
   * Returns true if an inactive camera is outside the post-sleep guard window and can adopt
   * an externally initiated stream from eufy-security-ws.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} guardMs - Post-stop guard window in milliseconds.
   * @param {boolean} [requireP2pOnly=true] - If true, requires !isRtspCapable(); if false, requires isRtspCapable().
   * @returns {boolean}
   */
  canAdoptExternalWake(now, guardMs, requireP2pOnly = true) {
    if (this.active) {
      return false;
    }
    const stoppedRef = Math.max(this.sleptAt || 0, this.lastStoppedAt || 0);
    if (now - stoppedRef <= guardMs) {
      return false;
    }
    return requireP2pOnly ? !this.isRtspCapable() : this.isRtspCapable();
  }

  /**
   * Adopts an externally initiated P2P livestream from eufy-security-ws when outside guardMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} guardMs - Post-stop guard window in milliseconds.
   * @returns {boolean} True if adopted and transitioned to active P2P session.
   */
  adoptExternalP2pWake(now, guardMs) {
    if (!this.canAdoptExternalWake(now, guardMs, true)) {
      return false;
    }
    this.reason = 'external P2P wake - eufy-security-ws';
    this.wakeInitiator = 'eufy-ws';
    this.viewSince = now;
    this.viewUntil = Math.max(this.viewUntil, now + HOLD_MS);
    this.beginSession('p2p', now, true);
    return true;
  }

  /**
   * Evaluates whether unsolicited P2P video packets arriving while inactive should trigger
   * a forced stop_livestream, updating lastUnsolicitedStopAt when true.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} delayMs - Minimum delay since last stop and last unsolicited stop.
   * @returns {{ shouldStop: boolean, sleptAgo: string }}
   */
  shouldStopUnsolicitedVideo(now, delayMs) {
    const stoppedRef = Math.max(this.sleptAt || 0, this.lastStoppedAt || 0);
    if (now - stoppedRef <= delayMs || now - this.lastUnsolicitedStopAt <= delayMs) {
      return {shouldStop: false, sleptAgo: '0s'};
    }
    this.lastUnsolicitedStopAt = now;
    const sleptAgo = stoppedRef ? Math.round((now - stoppedRef) / 1000) + 's' : 'never';
    return {shouldStop: true, sleptAgo};
  }

  /**
   * Returns true if the active stream has reached the hard max_secs limit.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasReachedMaxDuration(now) {
    return Boolean(this.active && now - this.startedAt >= MAX_MS);
  }

  /**
   * Returns true if a viewer-only stream has reached the view_max_secs limit.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasReachedViewMaxDuration(now) {
    return Boolean(
        this.active &&
        !this.isInMotion(now) &&
        now - Math.max(this.startedAt, this.motionUntil) >= VIEW_MAX_MS
    );
  }

  /**
   * Returns true if the camera is replaying a buffered backfill download and enough time has
   * elapsed since lastWrite to advance to the next frame.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} frameIntervalMs - Minimum interval between download frames in milliseconds.
   * @returns {boolean}
   */
  canAdvanceDownloadFrame(now, frameIntervalMs) {
    return Boolean(
        this.active &&
        this.activeMode === 'download' &&
        this.downloadFrames.length > 0 &&
        now - this.lastWrite >= frameIntervalMs
    );
  }

  /**
   * Returns true if the camera is configured for RTSP and needs its rtspStream property
   * enabled on the HomeBase via eufy-security-ws.
   *
   * @param {*} rtspStreamProp - Current rtspStream property value from eufy-security-ws.
   * @returns {boolean}
   */
  shouldEnableRtspProperty(rtspStreamProp) {
    if (this.useRtsp && this.rtspUrl && !this.rtspEnabledChecked && rtspStreamProp === false) {
      this.rtspEnabledChecked = true;
      return true;
    }
    return false;
  }

  /**
   * Returns true if this camera is currently in its initial RTSP wake handshake window on the
   * same station as otherCam.
   *
   * @param {Camera} otherCam - Camera waiting to start a P2P stream.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} windowMs - Maximum RTSP wake handshake window in milliseconds.
   * @returns {boolean}
   */
  isWakingRtspOnStation(otherCam, now, windowMs) {
    return Boolean(
        this !== otherCam &&
        this.active &&
        this.activeMode === 'rtsp' &&
        !this.gotVideo &&
        now - this.startedAt < windowMs &&
        this.getStationKey() === otherCam.getStationKey()
    );
  }

  /**
   * Returns true if this camera needs a startup snapshot probe and its station has no active
   * or pending streams.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  canStartStartupProbe(allCams, now) {
    if (!this.needsStartupSnapshot || this.isLowBattery()) {
      return false;
    }
    const stationKey = this.getStationKey();
    return !allCams.some(
        (other) => other.getStationKey() === stationKey && (other.active || now < other.wantUntil())
    );
  }

  /**
   * Returns the bounding box { boxX, boxY, boxW, boxH } of this camera's corner status card.
   *
   * @returns {{ boxX: number, boxY: number, boxW: number, boxH: number }|null}
   */
  getCardBounds() {
    return this.card.getBounds(this.getDisplayTitle(), this.telemetry);
  }

  /**
   * Computes the normalized Frigate mask polygon string for this camera's corner status card.
   *
   * @returns {string}
   */
  computeMaskPolygon() {
    return this.card.computeMaskPolygon(this.getDisplayTitle(), this.telemetry);
  }

  /**
   * Returns true if this camera matches a target identifier token (by name, serial, or slugified title).
   *
   * @param {string} lowerToken - Lowercase raw token.
   * @param {string} slugToken - Slugified alphanumeric token.
   * @param {(str: string) => string} slugifyFn - Slug normalizer helper.
   * @returns {boolean}
   */
  matchesTargetToken(lowerToken, slugToken, slugifyFn) {
    return Boolean(
        String(this.name).toLowerCase() === lowerToken ||
        String(this.serial).toLowerCase() === lowerToken ||
        slugifyFn(this.name) === slugToken ||
        slugifyFn(this.title) === slugToken
    );
  }

  /**
   * Resets backfill state and queues a synthetic high-priority BackfillJob for SIGUSR1 testing.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   */
  prepareSigUsr1BackfillTest(now = Date.now()) {
    this.downloadedPaths.clear();
    this.backfillClip = null;
    this.lastBackfillQueryAt = 0;
    this.pendingBackfill = BackfillJob.createSigUsr1TestJob(now);
  }

  /**
   * Returns true if this camera is idle and has a matched HomeBase clip ready to download.
   *
   * @returns {boolean}
   */
  isReadyForBackfillDownload() {
    return Boolean(this.backfillClip && !this.active);
  }

  /**
   * Transitions the camera into active backfill download mode for the given matched clip.
   *
   * @param {{ storagePath: string, cipherId: number, event: string, personName: string, reason: string }} clip - Matched clip.
   * @param {boolean} isTest - Whether triggered by SIGUSR1 test hook.
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  beginBackfillDownload(clip, isTest, now) {
    this.clearPendingBackfill();
    this.downloadedPaths.add(clip.storagePath);
    this.isTestBackfill = Boolean(isTest);
    this.downloadFinished = false;
    this.downloadFrames = [];
    this.eventActive = false;
    this.reason = 'backfill: ' + clip.reason;
    this.wakeInitiator = 'bridge-backfill';
    this.evUntil = 0;
    this.beginSession('download', now, true);
  }

  /**
   * Coalesces a duplicate /api/wake request into the camera's pending wake timer options
   * and returns the remaining delay in milliseconds.
   *
   * @param {number} durationMs - Requested wake hold duration in milliseconds.
   * @param {string} reason - Wake reason string.
   * @param {boolean} createEvent - Whether to file a synthetic Frigate event.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {number} Remaining scheduled delay in milliseconds.
   */
  coalesceApiWake(durationMs, reason, createEvent, now) {
    const prevDuration = this.apiWakePendingOpts ? this.apiWakePendingOpts.durationMs : 0;
    const prevCreateEvent = Boolean(this.apiWakePendingOpts && this.apiWakePendingOpts.createEvent);
    this.apiWakePendingOpts = {
      durationMs: Math.max(prevDuration, durationMs),
      reason,
      createEvent: Boolean(prevCreateEvent || createEvent),
    };
    return Math.max(0, (this.apiWakeScheduledAt || now) - now);
  }

  /**
   * Schedules a paced /api/wake timer on this camera.
   *
   * @param {number} durationMs - Requested wake duration in milliseconds.
   * @param {string} reason - Wake reason string.
   * @param {boolean} createEvent - Whether to file a synthetic Frigate event.
   * @param {number} delayMs - Pacing delay in milliseconds.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {(pending: { durationMs: number, reason: string, createEvent: boolean }) => void} onFire - Callback when timer fires.
   */
  scheduleApiWake(durationMs, reason, createEvent, delayMs, now, onFire) {
    this.apiWakePendingOpts = {durationMs, reason, createEvent};
    this.apiWakeScheduledAt = now + delayMs;
    this.apiWakeTimer = setTimeout(() => {
      const pending = this.apiWakePendingOpts || {durationMs, reason, createEvent};
      this.clearApiWakeTimer();
      onFire(pending);
    }, delayMs);
  }

  /**
   * Resets RTSP wake timestamps and retry counters if an active RTSP wake has stalled for stallMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} stallMs - Stall threshold in milliseconds.
   * @returns {boolean} True if the RTSP wake was stalled and reset.
   */
  resetStalledRtspWakeIfNeeded(now, stallMs) {
    if (this.activeMode === 'rtsp' && !this.gotVideo && now - this.startedAt > stallMs) {
      this.startedAt = now;
      this.lastStartAt = now;
      this.restarts = 0;
      return true;
    }
    return false;
  }

  /**
   * Builds the JSON response object returned by the /api/wake HTTP endpoint for this camera.
   *
   * @param {'extended'|'scheduled'|'waking'} status - Resulting wake status.
   * @param {number} durationMs - Effective hold duration in milliseconds.
   * @param {number} delayMs - Scheduled pacing delay in milliseconds.
   * @returns {{ camera: string, title: string, status: string, mode: string, hold_secs: number, delay_ms: number }}
   */
  toApiWakeResponse(status, durationMs, delayMs) {
    return {
      camera: this.name,
      title: this.getDisplayTitle(),
      status,
      mode: this.activeMode || (this.isRtspCapable() ? 'rtsp' : 'p2p'),
      hold_secs: Math.round(durationMs / 1000),
      delay_ms: delayMs,
    };
  }

  /**
   * Returns true if an active backfill download has finished transferring and playing all frames.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} idleCompleteMs - Fallback idle duration after last frame if downloadFinished was missed.
   * @returns {boolean}
   */
  isDownloadComplete(now, idleCompleteMs) {
    if (this.downloadFrames.length > 0 || !this.gotVideo) {
      return false;
    }
    return Boolean(this.downloadFinished || now - this.lastVideoAt > idleCompleteMs);
  }

  /**
   * Marks an active backfill download transfer as finished and returns buffered frame count and
   * any remaining minimum playback wait time.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minPlaybackMs - Minimum playback duration in milliseconds.
   * @returns {{ bufferedCount: number, waitMs: number }}
   */
  markDownloadFinished(now, minPlaybackMs) {
    this.downloadFinished = true;
    const bufferedCount = this.downloadFrames.length;
    const elapsed = now - this.startedAt;
    const waitMs =
        bufferedCount === 0 && this.gotVideo && elapsed < minPlaybackMs
            ? minPlaybackMs - elapsed
            : 0;
    return {bufferedCount, waitMs};
  }

  /**
   * Returns true if a clean un-overlayed snapshot can be injected into the encoder stream
   * when a Frigate event wake times out without receiving live video.
   *
   * @param {boolean} noVideo - Whether the event wake timed out without video.
   * @returns {boolean}
   */
  canInjectCleanEventSnapshot(noVideo) {
    return Boolean(noVideo && INSTANT_EVENT_SNAPSHOT && Buffer.isBuffer(this.lastFrame));
  }

  /**
   * Determines whether this candidate camera is allowed to preempt currently active camera cur
   * on the same station P2P slot.
   *
   * @param {Camera} cur - Currently active camera on the station P2P slot.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} stallPreemptMs - Wake stall duration after which an unstarted stream can be preempted.
   * @returns {boolean}
   */
  canPreempt(cur, now, stallPreemptMs) {
    if (!this.isInMotion(now)) {
      return !cur.isInMotion(now) && this.viewSince > cur.viewSince;
    }
    if (!cur.isInMotion(now)) {
      return true;
    }

    const pickScore = this.getEffectivePriority(now);
    const curScore = cur.getEffectivePriority(now);
    const curFinishedOrStalled =
        cur.motionClearedAt > cur.lastMotionAt ||
        (!cur.gotVideo && now - cur.startedAt >= stallPreemptMs);

    if (pickScore > curScore) {
      return true;
    }
    if (pickScore === curScore && this.lastMotionAt > cur.lastMotionAt) {
      return Boolean(PREEMPT_EVENT_STREAMS || curFinishedOrStalled);
    }
    return Boolean(curFinishedOrStalled);
  }

  /**
   * Resolves the structured initiator tag when this camera preempts cur on a station P2P slot.
   *
   * @param {Camera} cur - Preempted camera.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  resolvePreemptInitiator(cur, now = Date.now()) {
    if (!this.isInMotion(now)) {
      return 'bridge-arbitrator/newer-viewer';
    }
    if (!cur.isInMotion(now)) {
      return 'bridge-arbitrator/motion-over-viewer';
    }
    if (this.getEffectivePriority(now) > cur.getEffectivePriority(now)) {
      return 'bridge-arbitrator/higher-priority-event';
    }
    return 'bridge-arbitrator/newer-motion';
  }

  /**
   * Comparator that orders wanting cameras so motion events beat viewer requests, higher
   * effective priority beats lower priority, and newer requests beat older ones.
   *
   * @param {Camera} a - First candidate camera.
   * @param {Camera} b - Second candidate camera.
   * @returns {number}
   */
  static compareWanting(a, b) {
    const aMotion = Number(a.isInMotion());
    const bMotion = Number(b.isInMotion());
    if (bMotion !== aMotion) {
      return bMotion - aMotion;
    }
    if (aMotion) {
      const prioDiff = b.getEffectivePriority() - a.getEffectivePriority();
      if (prioDiff !== 0) {
        return prioDiff;
      }
      return b.lastMotionAt - a.lastMotionAt;
    }
    return b.viewSince - a.viewSince;
  }

  /**
   * Returns true if lastFrame is a valid YUV420p Buffer of length FRAME.
   *
   * @returns {boolean}
   */
  hasValidSnapshotFrame() {
    return Buffer.isBuffer(this.lastFrame) && this.lastFrame.length === FRAME;
  }

  /**
   * Appends a decoded s16le PCM audio chunk to the camera audio queue, dropping oldest
   * chunks if the buffer exceeds maxBytes.
   *
   * @param {Uint8Array} chunk - Raw s16le PCM buffer.
   * @param {number} maxBytes - Maximum buffered PCM bytes.
   */
  appendAudioChunk(chunk, maxBytes) {
    this.pcm.push(chunk);
    this.pcmLen += chunk.length;
    while (this.pcmLen > maxBytes && this.pcm.length > 1) {
      const dropped = this.pcm.shift();
      if (dropped) {
        this.pcmLen -= dropped.length;
      }
    }
  }

  /**
   * Consumes the next chunkBytes of PCM audio for the encoder pipe, or returns silenceBuf.
   *
   * @param {number} chunkBytes - Number of bytes per audio tick.
   * @param {Uint8Array} silenceBuf - Pre-allocated silence buffer.
   * @returns {Uint8Array}
   */
  consumeAudioChunk(chunkBytes, silenceBuf) {
    if (this.pcmLen < chunkBytes) {
      return silenceBuf;
    }
    const all = this.pcm.length === 1 ? this.pcm[0] : Buffer.concat(this.pcm);
    const out = all.subarray(0, chunkBytes);
    const rest = all.subarray(chunkBytes);
    this.pcm = rest.length ? [rest] : [];
    this.pcmLen = rest.length;
    return out;
  }

  /**
   * Commits a newly decoded YUV420p video frame, updates lastFrame/lastSeen, and cancels
   * pending backfill if live capture is confirmed.
   *
   * @param {Uint8Array} liveFrame - Frame buffer assigned to this.frame.
   * @param {Uint8Array} snapshotCopy - Independent Buffer copy assigned to this.lastFrame.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} lastSeenHm - Formatted HH:MM timestamp string.
   * @param {number} cancelBackfillMs - Minimum video duration to cancel backfill.
   */
  recordDecodedFrame(liveFrame, snapshotCopy, now, lastSeenHm, cancelBackfillMs) {
    this.frame = liveFrame;
    this.frameAt = now;
    this.frameNew = true;
    this.lastFrame = snapshotCopy;
    this.needsStartupSnapshot = false;
    this.cancelBackfillIfLiveConfirmed(now, cancelBackfillMs);
    this.telemetry.updateLastSeen(lastSeenHm);
  }

  /**
   * Handles a decoded frame during a backfill download session: returns false if it is the
   * very first frame (so the caller commits it immediately), or buffers it into downloadFrames
   * and returns true.
   *
   * @param {Uint8Array} frameCopy - Independent Buffer copy of the decoded frame.
   * @param {number} maxBufferFrames - Maximum frames to hold in downloadFrames.
   * @returns {boolean} True if buffered for paced playback, false if it should be committed now.
   */
  bufferDownloadFrame(frameCopy, maxBufferFrames) {
    if (!this.frame) {
      return false;
    }
    if (this.downloadFrames.length < maxBufferFrames) {
      this.downloadFrames.push(frameCopy);
    }
    return true;
  }

  /**
   * Advances the buffered download frame queue by one frame when due.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} frameIntervalMs - Minimum interval between download frames in milliseconds.
   * @param {string} lastSeenHm - Formatted HH:MM timestamp string.
   */
  consumeNextDownloadFrame(now, frameIntervalMs, lastSeenHm) {
    if (!this.canAdvanceDownloadFrame(now, frameIntervalMs)) {
      return;
    }
    const nextBuf = this.downloadFrames.shift();
    this.frame = nextBuf;
    this.frameAt = now;
    this.lastVideoAt = now;
    this.frameNew = true;
    this.lastFrame = nextBuf;
    this.telemetry.updateLastSeen(lastSeenHm);
  }

  /**
   * Records that the given YUV420p frame buffer was written to the FFmpeg encoder stdin.
   *
   * @param {Uint8Array} frame - Frame buffer written to encoder.
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  markFrameEncoded(frame, now) {
    this.lastWrite = now;
    this.lastSent = frame;
    this.frameNew = false;
  }

  /**
   * Attaches a newly spawned persistent FFmpeg encoder process and initializes burst state.
   *
   * @param {*} enc - Spawned FFmpeg encoder ChildProcess.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   */
  attachEncoder(enc, now = Date.now()) {
    this.enc = enc;
    this.lastSent = null;
    this.lastWrite = now;
    this.burstUntil = now + KEYFRAME_BURST_MS;
  }

  /**
   * Terminates the persistent FFmpeg encoder process on bridge shutdown.
   */
  stopEncoderProcess() {
    if (!this.enc) {
      return;
    }
    try {
      this.enc.kill('SIGTERM');
    } catch (err) {
      // Ignore errors when stopping encoder on shutdown.
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
        elapsedSec: ((now - this.startedAt) / 1000).toFixed(1),
      };
    }
    if (this.rtspRewaking) {
      this.rtspRewaking = false;
      this.restarts = 0;
      const refAt = this.rtspRewakeStartedAt || this.lastStartAt || now;
      return {
        isFirstVideo: false,
        isRewakeResume: true,
        elapsedSec: ((now - refAt) / 1000).toFixed(1),
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
      return {isFirstVideo: true, elapsedSec: ((now - this.startedAt) / 1000).toFixed(1)};
    }
    return {isFirstVideo: false, elapsedSec: '0.0'};
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
   * Attaches a spawned FFmpeg decoder process to this camera.
   *
   * @param {*} dec - Spawned FFmpeg ChildProcess.
   * @param {number} [spawnedAt=0] - Spawn timestamp in milliseconds (for RTSP handshake tracking).
   */
  attachDecoder(dec, spawnedAt = 0) {
    this.dec = dec;
    this.decSpawnedAt = spawnedAt;
  }

  /**
   * Clears any pending RTSP retry timer, resets decoder/A/V session buffers, and returns
   * the detached FFmpeg decoder process (if any).
   *
   * @returns {*} Detached FFmpeg ChildProcess or null.
   */
  detachDecoder() {
    if (this.rtspRetryTimer) {
      clearTimeout(this.rtspRetryTimer);
      this.rtspRetryTimer = null;
    }
    const dec = this.dec;
    this.dec = null;
    this.decSpawnedAt = 0;
    this.frame = null;
    this.firstFrameAt = 0;
    this.frameNew = false;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoCodec = '';
    this.pcm = [];
    this.pcmLen = 0;
    return dec;
  }

  /**
   * Updates stationSerial and auto-discovered rtspUrl from device properties, returning true
   * if a new RTSP URL was discovered.
   *
   * @param {*} stationSn - Unwrapped stationSerialNumber property.
   * @param {*} rtspUrlProp - Unwrapped rtspStreamUrl property.
   * @returns {boolean} True if a new rtspUrl was discovered.
   */
  updateDiscoveredRtspConfig(stationSn, rtspUrlProp) {
    if (stationSn && typeof stationSn === 'string') {
      this.stationSerial = stationSn;
    }
    if (rtspUrlProp && typeof rtspUrlProp === 'string' && !this.rtsp_url && this.rtspUrl !== rtspUrlProp) {
      this.rtspUrl = rtspUrlProp;
      this.rtspSupported = true;
      return true;
    }
    return false;
  }

  /**
   * Evaluates a new Frigate event request against any in-flight or active event window,
   * upgrading the label/person in-place if pending or queuing a new pending event.
   *
   * @param {string} label - Resolved Frigate event label.
   * @param {string} personName - Optional recognized person name.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {{ status: 'upgraded'|'cooldown'|'queued', upgradedLabel: boolean, attachedPerson: boolean }}
   */
  tryUpgradeOrQueueFrigateEvent(label, personName, now = Date.now()) {
    if (this.evTimer || this.evPending) {
      let upgradedLabel = false;
      let attachedPerson = false;
      if (this.evLabel === 'motion' && label !== 'motion') {
        this.evLabel = label;
        upgradedLabel = true;
      }
      if (personName && !this.evPerson) {
        this.evPerson = personName;
        attachedPerson = true;
      }
      return {status: 'upgraded', upgradedLabel, attachedPerson};
    }
    if (now < (this.evUntil || 0)) {
      return {status: 'cooldown', upgradedLabel: false, attachedPerson: false};
    }
    this.evLabel = label;
    this.evPerson = personName || '';
    this.evPending = true;
    return {status: 'queued', upgradedLabel: false, attachedPerson: false};
  }

  /**
   * Marks a pending Frigate event as dispatched and sets the event cooldown window.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {{ finalLabel: string, finalPerson: string, subLabel: string }}
   */
  completeFrigateEventFiling(now = Date.now()) {
    const finalLabel = this.evLabel;
    const finalPerson = this.evPerson;
    const subLabel = finalPerson || 'eufy';
    this.evPending = false;
    this.evUntil = now + EVENT_SECS * 1000;
    return {finalLabel, finalPerson, subLabel};
  }

  /**
   * Registers a newly connected go2rtc consumer ID and triggers a short keyframe burst.
   *
   * @param {string|number} id - Consumer identifier from go2rtc.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   */
  registerNewViewer(id, now = Date.now()) {
    this.viewerIds.set(id, false);
    this.triggerKeyframeBurst(now, SHORT_KEYFRAME_BURST_MS);
  }

  /**
   * Removes go2rtc consumer IDs that are no longer present in seenIds, updates this.viewers,
   * and returns the list of disconnected viewer descriptors.
   *
   * @param {Set<string|number>} seenIds - Set of currently connected consumer IDs.
   * @param {number} totalViewers - Total active non-recorder viewer count.
   * @returns {Array<{ id: string|number, wasActiveViewer: boolean }>} Disconnected viewers.
   */
  pruneDisconnectedViewers(seenIds, totalViewers) {
    const disconnected = [];
    for (const [id, wasActiveViewer] of [...this.viewerIds.entries()]) {
      if (!seenIds.has(id)) {
        this.viewerIds.delete(id);
        disconnected.push({id, wasActiveViewer});
      }
    }
    this.viewers = totalViewers;
    return disconnected;
  }

  /**
   * Builds the JSON payload sent to the Home Assistant webhook.
   *
   * @param {Record<string, *>} [extra={}] - Additional fields (event_id, review_id, no_video).
   * @returns {Record<string, *>}
   */
  toHaWebhookPayload(extra = {}) {
    const payload = {
      camera: this.name,
      title: this.getDisplayTitle(),
      label: this.evLabel,
      ...extra,
    };
    if (this.evPerson) {
      payload.person = this.evPerson;
    }
    return payload;
  }

  /**
   * Extends an active camera hold timer by half of its base hold duration up to MAX_MS.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minExtendMs - Minimum hold extension in milliseconds.
   * @param {boolean} [capAtFullHold=true] - Whether to cap the new hold at now + baseHoldMs.
   * @returns {{ extendMs: number, holdSecs: number }}
   */
  extendActiveHold(now, minExtendMs, capAtFullHold = true) {
    const baseHoldMs = this.isLowBattery() ? Math.min(HOLD_MS, LOW_BAT_HOLD_MS) : HOLD_MS;
    const extendMs = Math.max(minExtendMs, Math.round(baseHoldMs / 2));
    const maxAllowedUntil = this.startedAt + MAX_MS;
    const uncappedNext = Math.min(maxAllowedUntil, Math.max(this.wantUntil(), now) + extendMs);
    const nextUntil = capAtFullHold ? Math.min(now + baseHoldMs, uncappedNext) : uncappedNext;
    if (this.isInMotion(now)) {
      this.motionUntil = Math.max(this.motionUntil, nextUntil);
    } else {
      this.viewUntil = Math.max(this.viewUntil, nextUntil);
    }
    this.runtimeExtended = true;
    this.clearPendingBackfill();
    return {extendMs, holdSecs: Math.round((this.wantUntil() - now) / 1000)};
  }

  /**
   * Computes the target expiration timestamp for a motion or view trigger, applying
   * a half-hold extension (ms / 2) when extending an already-active stream.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} ms - Requested hold duration in milliseconds.
   * @param {number} minExtendMs - Minimum trigger extension in milliseconds.
   * @param {boolean} isMidStream - Whether this trigger is extending an active mid-stream session.
   * @returns {number}
   */
  computeTriggerHoldUntil(now, ms, minExtendMs, isMidStream) {
    if (!isMidStream) {
      return now + ms;
    }
    const halfMs = Math.max(minExtendMs, Math.round(ms / 2));
    const maxAllowedUntil = this.active && this.startedAt ? this.startedAt + MAX_MS : now + MAX_MS;
    return Math.min(maxAllowedUntil, now + ms, Math.max(this.wantUntil(), now) + halfMs);
  }

  /**
   * Applies a motion/event wake or mid-stream hold extension to this camera and returns
   * optional log metadata when the camera is already live.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} reason - Trigger reason description.
   * @param {number} ms - Requested hold duration in milliseconds.
   * @param {string} initiator - Trigger initiator tag.
   * @param {number} evPriority - Event priority boost score.
   * @param {number} midStreamGraceMs - Grace window after session start before half-hold extension applies.
   * @param {number} minExtendMs - Minimum mid-stream extension in milliseconds.
   * @param {number} debounceMs - Log debounce window for companion events.
   * @returns {{ shouldLog: boolean, isDebug: boolean, message: string }}
   */
  applyMotionTrigger(now, reason, ms, initiator, evPriority, midStreamGraceMs, minExtendMs, debounceMs) {
    if (now >= this.wantUntil()) {
      this.reason = reason;
      this.wakeInitiator = initiator;
    }
    if (!this.isInMotion(now) && !this.active) {
      this.reason = reason;
      this.wakeInitiator = initiator;
      this.eventPriority = evPriority;
    } else if (evPriority >= (this.eventPriority || 0)) {
      this.eventPriority = evPriority;
      this.reason = reason;
    }

    const prevMotionAt = this.lastMotionAt || 0;
    const prevPriority = this.eventPriority || 0;
    const isMidStream = this.active && now - this.startedAt > midStreamGraceMs;
    const targetUntil = this.computeTriggerHoldUntil(now, ms, minExtendMs, isMidStream);
    this.eventActive = true;
    this.motionUntil = Math.max(this.motionUntil, targetUntil);
    this.lastMotionAt = now;
    if (isMidStream || (this.active && this.gotVideo)) {
      this.runtimeExtended = true;
      this.clearPendingBackfill();
    }

    if (!this.active) {
      return {shouldLog: false, isDebug: false, message: ''};
    }

    const holdSecs = Math.round((this.wantUntil() - now) / 1000);
    const ecoNote = this.isLowBattery() ? ', low-battery eco hold ' + Math.round(ms / 1000) + 's' : '';
    const isDebug = now - prevMotionAt < debounceMs && evPriority <= prevPriority;
    const message =
        'activity trigger "' +
        reason +
        '" (initiator=' +
        initiator +
        ', already live, holdExtendedTo=' +
        holdSecs +
        's, priority=' +
        this.getEffectivePriority(now) +
        ecoNote +
        ')';
    return {shouldLog: true, isDebug, message};
  }

  /**
   * Applies a viewer/external wake or mid-stream hold extension to this camera, clearing
   * superseded viewer queues on other P2P cameras on the same station.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} reason - Trigger reason description.
   * @param {number} ms - Requested hold duration in milliseconds.
   * @param {string} initiator - Trigger initiator tag.
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} midStreamGraceMs - Grace window after session start before half-hold extension applies.
   * @param {number} minExtendMs - Minimum mid-stream extension in milliseconds.
   * @param {number} debounceMs - Log debounce window for repeated api-wake calls.
   * @returns {{ shouldLog: boolean, isDebug: boolean, message: string }}
   */
  applyViewTrigger(now, reason, ms, initiator, allCams, midStreamGraceMs, minExtendMs, debounceMs) {
    if (now >= this.wantUntil()) {
      this.reason = reason;
      this.wakeInitiator = initiator;
    }
    if (!this.isRtspCapable() && now >= this.viewUntil) {
      const stationKey = this.getStationKey();
      for (const other of allCams) {
        if (
            other !== this &&
            !other.isRtspCapable() &&
            other.getStationKey() === stationKey &&
            (other.viewUntil > 0 || other.hasWakingViewer())
        ) {
          other.clearViewerQueue('superseded by P2P viewer on ' + this.name);
        }
      }
    }
    if (now >= this.viewUntil) {
      this.viewSince = now;
    }
    const isMidStreamView =
        this.active &&
        now - this.startedAt > midStreamGraceMs &&
        (initiator === 'eufy-ws' || initiator === 'api-wake');
    const targetViewUntil = this.computeTriggerHoldUntil(now, ms, minExtendMs, isMidStreamView);
    this.viewUntil = Math.max(this.viewUntil, targetViewUntil);
    if (isMidStreamView) {
      this.runtimeExtended = true;
      this.clearPendingBackfill();
    }

    if (!this.active || initiator !== 'api-wake') {
      return {shouldLog: false, isDebug: false, message: ''};
    }

    const holdSecs = Math.round((this.wantUntil() - now) / 1000);
    const isDebug = now - (this.lastApiTriggerLogAt || 0) < debounceMs;
    this.lastApiTriggerLogAt = now;
    const message =
        'activity trigger "' +
        reason +
        '" (initiator=api-wake, already live, holdExtendedTo=' +
        holdSecs +
        's)';
    return {shouldLog: true, isDebug, message};
  }

  /**
   * Prepares the camera state for an immediate mid-session RTSP re-wake and returns remaining hold seconds.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minHoldMs - Minimum hold window required to complete RTSP re-wake.
   * @returns {number} Remaining hold duration in seconds.
   */
  beginRtspRewake(now, minHoldMs) {
    this.rtspRewaking = true;
    this.rtspRewakeStartedAt = now;
    this.restarts = 0;
    this.lastStartAt = now;
    if (this.viewUntil > now && this.viewUntil - now < minHoldMs) {
      this.viewUntil = now + minHoldMs;
    }
    if (this.motionUntil > now && this.motionUntil - now < minHoldMs) {
      this.motionUntil = now + minHoldMs;
    }
    return Math.round((this.wantUntil() - now) / 1000);
  }

  /**
   * Evaluates RTSP session health, non-destructive wake retries, handshake protection, and timeouts.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} quietSince - Timestamp of last video packet or start attempt.
   * @param {number} handshakeMinMs - Minimum decoder age indicating active RTSP handshake.
   * @param {number} decStallMs - Decoder age after which a silent handshake is considered stalled.
   * @param {number} retryMs - Interval between start_rtsp_livestream wake retries.
   * @param {number} maxRetries - Maximum RTSP wake retries before timeout.
   * @param {number} timeoutMs - Hard RTSP wake timeout in milliseconds.
   * @param {number} midStallMs - Mid-session frame silence threshold in milliseconds.
   * @returns {{ action: 'none'|'retry'|'timeout'|'dropped', killStalledDec: boolean, logMsg: string }}
   */
  evaluateRtspHealth(
      now,
      quietSince,
      handshakeMinMs,
      decStallMs,
      retryMs,
      maxRetries,
      timeoutMs,
      midStallMs
  ) {
    const waitingForWake = !this.gotVideo || this.rtspRewaking;
    const wakeQuietSince = this.rtspRewaking ? this.lastStartAt : quietSince;
    const wakeStartedAt = this.rtspRewaking ? this.rtspRewakeStartedAt || this.lastStartAt : this.startedAt;

    if (waitingForWake) {
      if (this.isRtspDecoderHandshaking(now, handshakeMinMs, decStallMs)) {
        return {action: 'none', killStalledDec: false, logMsg: ''};
      }
      if (now - wakeQuietSince > retryMs && this.restarts < maxRetries) {
        this.restarts++;
        this.lastStartAt = now;
        const retryWaitSecs = (retryMs / 1000).toFixed(1);
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
            this.sessionId +
            ')';
        return {action: 'retry', killStalledDec, logMsg};
      }
      if (now - wakeStartedAt > timeoutMs) {
        const timeoutSecs = Math.round(timeoutMs / 1000);
        this.motionUntil = 0;
        const logMsg =
            'HomeBase RTSP stream yielded no video after ' +
            timeoutSecs +
            's (' +
            this.restarts +
            ' retries)';
        return {action: 'timeout', killStalledDec: false, logMsg};
      }
      return {action: 'none', killStalledDec: false, logMsg: ''};
    }

    if (now - this.lastVideoAt > midStallMs) {
      return {
        action: 'dropped',
        killStalledDec: false,
        logMsg: 'no frames for ' + ((now - this.lastVideoAt) / 1000).toFixed(1) + 's',
      };
    }
    return {action: 'none', killStalledDec: false, logMsg: ''};
  }

  /**
   * Evaluates P2P watchdog stall and retry conditions for an active P2P livestream session.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} quietSince - Timestamp of last video packet or start attempt.
   * @param {number} initialRetryMs - Quiet duration before retry 1.
   * @param {number} subsequentRetryMs - Quiet duration before retries 2..maxRetries.
   * @param {number} maxRetries - Maximum watchdog retries before forced error sleep.
   * @returns {{ action: 'none'|'retry'|'timeout', logMsg: string }}
   */
  evaluateP2pHealth(now, quietSince, initialRetryMs, subsequentRetryMs, maxRetries) {
    const retryAfterMs = this.restarts === 0 ? initialRetryMs : subsequentRetryMs;
    if (now - quietSince <= retryAfterMs || this.starting) {
      return {action: 'none', logMsg: ''};
    }
    const quietSecs = ((now - quietSince) / 1000).toFixed(1);
    const stallCause = this.gotVideo ? 'stream_stalled_mid_session' : 'no_initial_video_after_wake';
    if (++this.restarts > maxRetries) {
      this.motionUntil = 0;
      const logMsg =
          'camera stopped sending video after ' +
          maxRetries +
          ' retries (cause=' +
          stallCause +
          ', quietFor=' +
          quietSecs +
          's)';
      return {action: 'timeout', logMsg};
    }
    const logMsg =
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
        ') - resetting decoder and re-requesting livestream from eufy';
    return {action: 'retry', logMsg};
  }

  /**
   * Records that Eufy reported motion/activity cleared (state: false) and optionally shortens
   * motionUntil when let_eufy_decide_event_end is enabled.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} settleMs - Post-clear settle duration in milliseconds.
   * @param {number} minVideoMs - Minimum event video duration in milliseconds.
   * @returns {number|null} Shortened remaining seconds if applied, or null.
   */
  recordMotionCleared(now, settleMs, minVideoMs) {
    this.motionClearedAt = now;
    if (LET_EUFY_DECIDE_END && this.active && this.isInMotion(now) && this.gotVideo) {
      const minEnd = Math.max(now + settleMs, (this.firstVideoAt || now) + minVideoMs);
      if (this.motionUntil > minEnd) {
        this.motionUntil = minEnd;
        return Math.round((minEnd - now) / 1000);
      }
    }
    return null;
  }

  /**
   * Queues a pending BackfillJob when a Eufy trigger event fires and backfill_downloads is enabled.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} eventName - Raw Eufy event string.
   * @param {string} personName - Optional recognized person name.
   * @param {string} reason - Formatted trigger description.
   * @param {number} evPriority - Event priority boost score.
   */
  queueEventBackfill(now, eventName, personName, reason, evPriority) {
    if (!BACKFILL_DOWNLOADS || this.runtimeExtended || (this.active && this.gotVideo)) {
      return;
    }
    const nextPriority = this.priority + evPriority;
    if (
        this.pendingBackfill &&
        !this.pendingBackfill.isExpired(now) &&
        nextPriority < this.pendingBackfill.priority
    ) {
      if (personName && !this.pendingBackfill.personName) {
        this.pendingBackfill.personName = personName;
      }
      return;
    }
    this.pendingBackfill = new BackfillJob({
      at: now,
      event: eventName,
      personName,
      reason,
      priority: nextPriority,
      attempts: 0,
    });
  }

  /**
   * Returns true if this camera has an urgent SIGUSR1 test BackfillJob queued.
   *
   * @returns {boolean}
   */
  hasUrgentTestBackfill() {
    return Boolean(
        this.pendingBackfill &&
        typeof this.pendingBackfill.isUrgentTest === 'function' &&
        this.pendingBackfill.isUrgentTest()
    );
  }

  /**
   * Clears any scheduled /api/wake pacing timer and pending options on this camera.
   */
  clearApiWakeTimer() {
    if (this.apiWakeTimer) {
      clearTimeout(this.apiWakeTimer);
      this.apiWakeTimer = null;
    }
    this.apiWakePendingOpts = null;
    this.apiWakeScheduledAt = 0;
  }
}

module.exports = {
  Camera,
};
