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
  MIN_CAMERA_PRIORITY,
  MAX_CAMERA_PRIORITY,
  DEFAULT_CAMERA_PRIORITY,
  KEYFRAME_BURST_MS,
  GLOBAL_PRESERVE_ASPECT,
  GLOBAL_STARTUP_SNAPSHOT,
  GLOBAL_USE_RTSP,
  ACTIVE_HWACCEL,
} = require('../config');
const {log} = require('../logger');
const {Telemetry} = require('./telemetry');
const {StatusCard} = require('./status-card');

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
   * @param {Function} [renderCardsFn] - Optional callback to pre-render initial status cards.
   */
  constructor(rawCamCfg, cachedSnapshot = {frame: null, lastSeen: ''}, renderCardsFn = null) {
    Object.assign(this, rawCamCfg);

    // 1. Composed Domain Models (StatusCard & Telemetry)
    this.card = new StatusCard(rawCamCfg);
    this.telemetry = new Telemetry(rawCamCfg, cachedSnapshot.lastSeen);

    // 2. Identity, Priority & Routing Configuration
    const startupMode = rawCamCfg.startup_snapshot ?? GLOBAL_STARTUP_SNAPSHOT;
    this.priority = clampNum(rawCamCfg.priority, MIN_CAMERA_PRIORITY, MAX_CAMERA_PRIORITY, DEFAULT_CAMERA_PRIORITY);
    this.eventPriority = 0;
    this.stationSerial = rawCamCfg.station_serial || '';
    this.useRtsp = rawCamCfg.use_rtsp ?? (GLOBAL_USE_RTSP || Boolean(rawCamCfg.rtsp_url));
    this.rtspUrl = rawCamCfg.rtsp_url || '';
    this.rtspSupported = Boolean(rawCamCfg.rtsp_url || rawCamCfg.use_rtsp === true);
    this.rtspEnabledChecked = false;
    this.rtspFallbackUntil = 0;
    this.preserveAspect = rawCamCfg.preserve_aspect_ratio ?? GLOBAL_PRESERVE_ASPECT;
    this.useHwaccel = Boolean(ACTIVE_HWACCEL);

    // 3. Startup Snapshot & Backfill State
    this.needsStartupSnapshot = shouldProbeStartupSnapshot(
        this.card.background,
        startupMode,
        cachedSnapshot.frame
    );
    this.isStartupProbe = false;
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

    // 5. Frigate External Event State
    this.evTimer = null;
    this.evPending = false;
    this.evLabel = '';
    this.evPerson = '';
    this.evUntil = 0;

    // 6. FFmpeg Process & Media Buffers
    this.enc = null;
    this.dec = null;
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

  // Delegated StatusCard accessors
  get cardCfg() { return this.card.config; }
  set cardCfg(v) { this.card.config = v; }
  get autoFrigateMask() { return this.card.autoFrigateMask; }
  set autoFrigateMask(v) { this.card.autoFrigateMask = v; }
  get showCardOnLive() { return this.card.showOnLive; }
  set showCardOnLive(v) { this.card.showOnLive = v; }
  get lastSyncedMaskPoly() { return this.card.lastSyncedMaskPoly; }
  set lastSyncedMaskPoly(v) { this.card.lastSyncedMaskPoly = v; }
  get liveTelState() { return this.card.liveTelState; }
  set liveTelState(v) { this.card.liveTelState = v; }
  get liveCard() { return this.card.liveCard; }
  set liveCard(v) { this.card.liveCard = v; }
  get liveOverlayBuf() { return this.card.liveOverlayBuf; }
  set liveOverlayBuf(v) { this.card.liveOverlayBuf = v; }
  get suppressLiveCard() { return this.card.suppressLiveCard; }
  set suppressLiveCard(v) { this.card.suppressLiveCard = v; }
  get asleep() { return this.card.asleep; }
  set asleep(v) { this.card.asleep = v; }
  get waking() { return this.card.waking; }
  set waking(v) { this.card.waking = v; }
  get busy() { return this.card.busy; }
  set busy(v) { this.card.busy = v; }

  // Delegated Telemetry accessors
  get telCfg() { return this.telemetry.config; }
  set telCfg(v) { this.telemetry.config = v; }
  get battery() { return this.telemetry.battery; }
  set battery(v) { this.telemetry.battery = v; }
  get charging() { return this.telemetry.charging; }
  set charging(v) { this.telemetry.charging = v; }
  get powerLabel() { return this.telemetry.powerLabel; }
  set powerLabel(v) { this.telemetry.powerLabel = v; }
  get wifi() { return this.telemetry.wifi; }
  set wifi(v) { this.telemetry.wifi = v; }
  get rssi() { return this.telemetry.rssi; }
  set rssi(v) { this.telemetry.rssi = v; }
  get temp() { return this.telemetry.temp; }
  set temp(v) { this.telemetry.temp = v; }
  get lastSeen() { return this.telemetry.lastSeen; }
  set lastSeen(v) { this.telemetry.lastSeen = v; }
  get lastLowBatRefreshAt() { return this.telemetry.lastLowBatRefreshAt; }
  set lastLowBatRefreshAt(v) { this.telemetry.lastLowBatRefreshAt = v; }
  get qualityChecked() { return this.telemetry.qualityChecked; }
  set qualityChecked(v) { this.telemetry.qualityChecked = v; }

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
    this.motionUntil = 0;
    this.eventPriority = 0;
    this.p2pReady = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.isStartupProbe = false;
    this.motionClearedAt = 0;
    this.sessionId++;
    this.lastStoppedAt = now;
    this.rtspFallbackUntil = 0;
    if (hadVideo && !preemptedByViewer && closedMode !== 'download') {
      this.sleptAt = now;
    }
    this.burstUntil = now + KEYFRAME_BURST_MS;
    this.clearViewerQueue();
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
   * Returns true if the camera is configured and eligible to stream via HomeBase native RTSP.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @returns {boolean}
   */
  isRtspCapable(now = Date.now()) {
    if (!this.useRtsp || !this.rtspUrl) {
      return false;
    }
    if (this.activeMode === 'p2p' || this.activeMode === 'download') {
      return false;
    }
    return now >= (this.rtspFallbackUntil || 0);
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
}

const want = (cam) => cam.wantUntil();
const inMotion = (cam) => cam.isInMotion();
const getEffectivePriority = (cam) => cam.getEffectivePriority();
const usesP2pSlot = (cam) => cam.usesP2pSlot();
const isRtspCapable = (cam) => cam.isRtspCapable();
const getStationKey = (cam) => cam.getStationKey();
const isLowBattery = (cam) => cam.isLowBattery();
const clearViewerQueue = (cam, clearReason = '') => cam.clearViewerQueue(clearReason);

module.exports = {
  Camera,
  shouldProbeStartupSnapshot,
  want,
  inMotion,
  getEffectivePriority,
  usesP2pSlot,
  isRtspCapable,
  getStationKey,
  isLowBattery,
  clearViewerQueue,
};
