// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Camera domain entity encapsulating per-camera configuration, session state,
 * telemetry, and stream arbitration priority rules.
 */
'use strict';

const {
  clampNum,
  GLOBAL_PRESERVE_ASPECT,
  GLOBAL_STARTUP_SNAPSHOT,
  GLOBAL_USE_RTSP,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
  ACTIVE_HWACCEL,
  FRAME,
  LOW_BAT_THRESHOLD,
  resolveCardConfig,
  resolveTelemetryConfig,
} = require('../config');
const {log} = require('../logger');

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

    const preserveAspect =
        rawCamCfg.preserve_aspect_ratio !== undefined
            ? Boolean(rawCamCfg.preserve_aspect_ratio)
            : GLOBAL_PRESERVE_ASPECT;
    const cardCfg = resolveCardConfig(rawCamCfg);
    const startupMode =
        rawCamCfg.startup_snapshot !== undefined ? rawCamCfg.startup_snapshot : GLOBAL_STARTUP_SNAPSHOT;
    const usesSnapshot = cardCfg.background === 'snapshot';
    const needsStartupSnapshot =
        usesSnapshot &&
        (startupMode === 'always' ? true : Boolean(startupMode) && cachedSnapshot.frame === null);

    this.priority = clampNum(rawCamCfg.priority, -10000, 10000, 0);
    this.eventPriority = 0;
    this.stationSerial = rawCamCfg.station_serial || '';
    this.useRtsp =
        rawCamCfg.use_rtsp !== undefined
            ? Boolean(rawCamCfg.use_rtsp)
            : GLOBAL_USE_RTSP || Boolean(rawCamCfg.rtsp_url);
    this.rtspUrl = rawCamCfg.rtsp_url || '';
    this.rtspSupported = Boolean(rawCamCfg.rtsp_url || rawCamCfg.use_rtsp === true);
    this.rtspEnabledChecked = false;
    this.rtspFallbackUntil = 0;
    this.lastStoppedAt = 0;
    this.activeMode = '';
    this.pendingBackfill = null;
    this.backfillClip = null;
    this.lastBackfillQueryAt = 0;
    this.downloadedPaths = new Set();
    this.downloadFrames = [];
    this.downloadFinished = false;
    this.isTestBackfill = false;
    this.preserveAspect = preserveAspect;
    this.cardCfg = cardCfg;
    this.telCfg = resolveTelemetryConfig(rawCamCfg);
    this.autoFrigateMask =
        rawCamCfg.auto_frigate_mask !== undefined
            ? Boolean(rawCamCfg.auto_frigate_mask)
            : GLOBAL_AUTO_FRIGATE_MASK;
    this.showCardOnLive =
        rawCamCfg.card_show_on_live !== undefined
            ? Boolean(rawCamCfg.card_show_on_live)
            : GLOBAL_CARD_SHOW_ON_LIVE;
    this.lastSyncedMaskPoly = '';
    this.liveTelState = null;
    this.liveCard = null;
    this.liveOverlayBuf = Buffer.allocUnsafe(FRAME);
    this.suppressLiveCard = false;
    this.needsStartupSnapshot = needsStartupSnapshot;
    this.isStartupProbe = false;
    this.useHwaccel = Boolean(ACTIVE_HWACCEL);
    this.active = false;
    this.starting = false;
    this.startPromise = null;
    this.eventActive = false;
    this.sessionId = 0;
    this.p2pReady = false;
    this.lastUnsolicitedStopAt = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoCodec = '';
    this.motionUntil = 0;
    this.lastMotionAt = 0;
    this.motionClearedAt = 0;
    this.lastEarlySleepCheckAt = 0;
    this.viewUntil = 0;
    this.viewSince = 0;
    this.reason = '';
    this.wakeInitiator = '';
    this.sleptAt = 0;
    this.burstUntil = Date.now() + 2000;
    this.firstVideoAt = 0;
    this.firstFrameAt = 0;
    this.startedAt = 0;
    this.lastStartAt = 0;
    this.lastVideoAt = 0;
    this.restarts = 0;
    this.gotVideo = false;
    this.evTimer = null;
    this.evPending = false;
    this.evLabel = '';
    this.evPerson = '';
    this.evUntil = 0;
    this.battery = null;
    this.charging = false;
    this.powerLabel = '';
    this.wifi = null;
    this.rssi = null;
    this.temp = null;
    this.lastLowBatRefreshAt = 0;
    this.qualityChecked = false;
    this.lastSeen = cachedSnapshot.lastSeen;
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
    this.asleep = null;
    this.waking = null;
    this.busy = null;

    if (typeof renderCardsFn === 'function') {
      renderCardsFn(this);
    }
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
    return this.isInMotion(now) ? this.priority + (this.eventPriority || 0) : this.priority;
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
    return Boolean(
        this.useRtsp &&
        this.rtspUrl &&
        this.activeMode !== 'p2p' &&
        this.activeMode !== 'download' &&
        now >= (this.rtspFallbackUntil || 0)
    );
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
    return (
        LOW_BAT_THRESHOLD > 0 &&
        this.battery !== null &&
        !Number.isNaN(Number(this.battery)) &&
        Number(this.battery) <= LOW_BAT_THRESHOLD &&
        !this.charging
    );
  }

  /**
   * Clears any pending viewer wake timer on this camera and marks all current go2rtc
   * consumers as ineligible to wake it until they disconnect and reconnect.
   *
   * @param {string} [clearReason=''] - Optional diagnostic context for why the viewer queue was cleared.
   */
  clearViewerQueue(clearReason = '') {
    const hadViewers = this.viewUntil > Date.now() || [...this.viewerIds.values()].some(Boolean);
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
  want,
  inMotion,
  getEffectivePriority,
  usesP2pSlot,
  isRtspCapable,
  getStationKey,
  isLowBattery,
  clearViewerQueue,
};
