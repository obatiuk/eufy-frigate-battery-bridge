// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Camera domain entity composing StatusCard, Telemetry, and BackfillJob models
 * alongside per-camera stream session state and arbitration priority rules.
 */
'use strict';

const {
  FRAME,
  AUDIO_CHUNK,
  LIVE_FPS,
  IDLE_FPS,
  COOLDOWN_MS,
  PREEMPT_EVENT_STREAMS,
  INSTANT_EVENT_SNAPSHOT,
  DEFAULT_EVENT_PRIORITY,
  KEYFRAME_BURST_MS,
  SHORT_KEYFRAME_BURST_MS,
  ACTIVE_HWACCEL,
  PROCESS_SIGNALS,
  CARD_THEMES,
  SLEEP_SCREENS,
  CARD_STATUS_TITLES,
  CAMERA_MODES,
  STREAM_MODES,
  FRAME_STAGE_MARKERS,
  CameraConfig,
  clampNum,
  resolveCameraConfig,
} = require('../config');
const {log, maskSecrets} = require('../logger');
const {Telemetry} = require('./telemetry');
const {StatusCard} = require('./status-card');
const {ViewerSet} = require('./camera/viewer-set');
const {AudioQueue} = require('./camera/audio-queue');
const {SessionLifecycle} = require('./camera/session-lifecycle');
const {FrigateEventFiling} = require('./camera/frigate-event-filing');
const {OfflineState} = require('./camera/offline-state');
const {WAKE_KINDS, WakeRequest, WakeScheduler} = require('./camera/wake-scheduler');
const {
  MAX_LIVE_PENDING_VIDEO_PACKETS,
  MAX_DOWNLOAD_PENDING_VIDEO_PACKETS,
  MAX_LIVE_PENDING_AUDIO_PACKETS,
  StreamSession,
} = require('./camera/stream-session');
const {
  DOWNLOAD_COMPLETED_INITIATOR,
  DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
  DOWNLOAD_FRAME_HIGH_WATERMARK,
  DOWNLOAD_FRAME_LOW_WATERMARK,
  MAX_DOWNLOADED_PATHS_HISTORY,
  isCompletedDownloadStop,
  BackfillState,
} = require('./camera/backfill-state');
const {HardwareTriggerLedger, COMPANION_EVENT_BURST_MS} = require('./camera/hardware-trigger-ledger');
const {
  SESSION_STATES,
  ALLOWED_SESSION_TRANSITIONS,
  canTransitionSession,
  FRIGATE_EVENT_STATES,
  DECODER_STATES,
} = require('./camera/states');
const {buildDebugHudLines: formatDebugHudLines} = require('./camera/debug-hud');

const INITIAL_KEYFRAME_BURST_MS = 2000;
const DOWNLOAD_POOL_MAX_BUFFERS = DOWNLOAD_FRAME_HIGH_WATERMARK + 2;
const MAX_LIVE_BURST_FRAMES = 12;
const DEFAULT_LIVE_FRAME_PACE_MS = 62;

// Default domain policy thresholds for watchdog health, Frigate polling, and trigger extensions.
const DEFAULT_HOLD_EXTEND_WINDOW_MS = 12000;
const DEFAULT_HOLD_SAFETY_MARGIN_MS = 5000;
const NO_FRIGATE_POLL = Object.freeze({shouldPoll: false, needsTimeoutExtendCheck: false});
const MS_PER_SECOND = 1000;
const HOMEBASE_3_SERIAL_PREFIX = 'T8030';
const DOORBELL_SERIAL_PREFIX = 'T8214';
const DEFAULT_MIN_WAKE_SECS = 5;
const DEFAULT_MIN_CLEAN_VIDEO_MS = 3000;
const DEFAULT_ENCODER_WEDGED_TIMEOUT_MS = 10000;
const DEFAULT_FRESH_FRAME_MAX_AGE_MS = 2000;
const DEFAULT_DOWNLOAD_PACE_LEAD_MS = 4;
const DEFAULT_LIVE_HEARTBEAT_WRITE_MS = 500;
const FIRST_BACKFILL_PLAYED_FRAME_COUNT = 1;
const DEFAULT_FRIGATE_POLL_COOLDOWN_MS = 4000;
const DEFAULT_RECENT_FRIGATE_OBJECT_MS = 15000;
const DEFAULT_EVENT_EXTEND_MARGIN_MS = 5000;
const DEFAULT_EARLY_SLEEP_POLL_MS = 5000;
const DEFAULT_EARLY_SLEEP_SETTLE_MS = 5000;
const IDLE_WEDGED_RSSI_THRESHOLD = 4;
const IDLE_WEDGED_RSSI_WINDOW_MS = 60000;
const IDLE_WEDGED_MIN_STOPPED_MS = 15000;
// A spotlight is only judged stuck after staying on this long with no activity; must exceed the longest hardware
// clip (BACKFILL_MAX_TOTAL_RECORDING_WAIT_MS = 124s) so a light that a recording still needs is never switched off.
const STUCK_LIGHT_GRACE_MS = 130000;
const IDLE_WEDGED_STOP_COOLDOWN_MS = 60000;
const DEFAULT_MID_STREAM_GRACE_MS = 3000;
const DEFAULT_MIN_EXTEND_MS = 5000;
const DEFAULT_TRIGGER_LOG_DEBOUNCE_MS = 3000;
const DEFAULT_CANCEL_BACKFILL_VIDEO_MS = 5000;
const SUSTAINED_LIVE_VIDEO_CUTOFF_RATIO = 0.2;
const MIN_SUSTAINED_LIVE_VIDEO_CUTOFF_MS = 3000;
const MAX_SUSTAINED_LIVE_VIDEO_CUTOFF_MS = 15000;
const DEFAULT_UNSOLICITED_VIDEO_DELAY_MS = 3000;
const DEFAULT_MOTION_CLEAR_SETTLE_MS = 5000;
const DEFAULT_MIN_EVENT_VIDEO_MS = 10000;
const EXTERNAL_P2P_WAKE_REASON = 'external P2P wake - eufy-security-ws';
const EXTERNAL_RTSP_WAKE_REASON = 'external RTSP wake - eufy-security-ws';
const EXTERNAL_WAKE_INITIATOR = 'eufy-ws';
const ARBITRATOR_INITIATOR_PREFIX = 'bridge-arbitrator/';
const API_WAKE_STATUSES = Object.freeze({
  WAKING: 'waking',
  SCHEDULED: 'scheduled',
  EXTENDED: 'extended',
  BACKFILL: 'backfill',
  OFFLINE: 'offline',
  UNAVAILABLE: 'unavailable',
  UNSUPPORTED: 'unsupported',
});
const CAMERA_RUNTIME_STATUSES = Object.freeze({
  LIVE: 'live',
  BACKFILL: 'backfill',
  WAKING: 'waking',
  WAITING: 'waiting',
  DISCONNECTED: 'disconnected',
  LOW_BATTERY: 'low_battery',
  ASLEEP: 'asleep',
});
const SOFTWARE_VIDEO_CODEC = 'libx264';
const HW_VIDEO_CODEC_PREFIX = 'h264_';
const TENTHS_ROUNDING_FACTOR = 10;
const DIRECT_RTSP_WAKE_UNSUPPORTED_ERROR =
  'Direct rtsp_url camera connects automatically and does not support /api/wake';

/**
 * Rounds a floating-point value to 1 decimal place.
 *
 * @param {number} val - Numeric value to round.
 * @returns {number}
 */
function roundTenths(val) {
  return Math.round(val * TENTHS_ROUNDING_FACTOR) / TENTHS_ROUNDING_FACTOR;
}

/**
 * Determines whether a camera needs a brief startup snapshot probe on boot.
 *
 * @param {string} sleepScreen - Resolved sleep_screen mode ('snapshot', 'slate', 'black').
 * @param {boolean|string} startupMode - Configured startup_snapshot setting.
 * @param {Uint8Array|null} cachedFrame - Cached YUV420p frame loaded from disk, if any.
 * @returns {boolean}
 */
function shouldProbeStartupSnapshot(sleepScreen, startupMode, cachedFrame) {
  return sleepScreen === SLEEP_SCREENS.SNAPSHOT
    ? startupMode === 'always' || (Boolean(startupMode) && cachedFrame === null)
    : false;
}

/**
 * Represents a configured Eufy camera and its runtime stream, overlay, and telemetry state.
 */
class Camera {
  /**
   * @param {Record<string, *>} rawCamCfg - Camera entry from config.yaml cameras[].
   * @param {{ frame: Uint8Array|null, lastSeen: string }} cachedSnapshot - Initial cached frame from disk.
   * @param {(cam: Camera) => void} [renderCardsFn] - Optional callback to pre-render initial status cards.
   */
  constructor(rawCamCfg, cachedSnapshot = {frame: null, lastSeen: ''}, renderCardsFn = null) {
    const resolvedCfg = resolveCameraConfig(rawCamCfg);
    /** @type {string} */
    this.serial = resolvedCfg.serial;
    /** @type {string} */
    this.explicitSerial = String(resolvedCfg.explicitSerial || '');
    this.name = resolvedCfg.name;
    /** @type {string} */
    this.title = resolvedCfg.title;
    /** @type {string} */
    this.station_serial = resolvedCfg.station_serial;
    /** @type {string} */
    this.rtsp_url = resolvedCfg.rtsp_url || '';
    this.directRtsp = Boolean(this.rtsp_url);

    // 1. Identity, Priority & Routing Configuration
    this.timers = resolvedCfg.timers;
    this.triggers = resolvedCfg.triggers;
    this.mode = this.timers.mode;
    this.alwaysBackfill = Boolean(this.timers.alwaysBackfill);
    this.backfillDownloads = Boolean(this.timers.backfillDownloads);

    // 2. Composed Domain Models (StatusCard & Telemetry)
    /** @type {StatusCard} */
    this.card = new StatusCard(resolvedCfg);
    /** @type {Telemetry} */
    this.telemetry = new Telemetry(resolvedCfg, cachedSnapshot.lastSeen, this.timers);
    this.priority = resolvedCfg.priority;
    this.eventPriority = 0;
    this.stationSerial = resolvedCfg.station_serial || '';
    this.useRtsp = Boolean(this.timers.useRtsp);
    this.rtspUrl = this.rtsp_url;
    this.rtspSupported = Boolean(
      this.directRtsp || (!this.isDoorbell() && (this.mode === CAMERA_MODES.RTSP || resolvedCfg.use_rtsp === true))
    );
    this.rtspEnabledChecked = false;
    this.unexpectedRtspActive = false;
    this.preserveAspect = resolvedCfg.preserveAspect;
    this.trackStuckSpotlight = Boolean(resolvedCfg.trackStuckSpotlight);
    this.useHwaccel = Boolean(ACTIVE_HWACCEL);

    // 3. Startup Snapshot & Backfill State
    /** @type {boolean|string} */
    this.startupSnapshot = resolvedCfg.startupSnapshot;
    this.needsStartupSnapshot = this.directRtsp
      ? false
      : shouldProbeStartupSnapshot(this.card.sleepScreen, resolvedCfg.startupSnapshot, cachedSnapshot.frame);
    this.isStartupProbe = false;
    this.backfill = new BackfillState({
      name: this.name,
      priority: this.priority,
      holdMs: this.timers.holdMs,
      alwaysBackfill: this.alwaysBackfill,
      backfillDownloads: this.backfillDownloads,
    });
    this.liveFrames = [];
    this.hardwareTriggers = new HardwareTriggerLedger();

    // 4. Active Stream Session & Timers
    this.sessionLifecycle = new SessionLifecycle(COOLDOWN_MS, {
      onTransition: (prev, next, reason) => {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug(this, 'session state: ' + prev + ' -> ' + next + suffix);
      },
      onRefused: (prev, next, reason) => {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug(this, 'refused session state: ' + prev + ' -> ' + next + suffix);
      },
    });
    this.session = new StreamSession({
      directRtsp: this.directRtsp,
      timers: this.timers,
      onDecoderTransition: (prev, next, reason) => {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug({name: this.name, state: next}, 'decoder state: ' + prev + ' -> ' + next + suffix);
      },
      onDecoderRefused: (prev, next, reason) => {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug({name: this.name, state: prev}, 'refused decoder state: ' + prev + ' -> ' + next + suffix);
      },
    });
    this.eventActive = false;
    this.lastUnsolicitedStopAt = 0;
    this.lastEarlySleepCheckAt = 0;
    this.lastExtendCheckAt = 0;
    this.extendCheckInFlight = false;
    this.wake = new WakeScheduler();
    this.lastApiTriggerLogAt = 0;
    this.burstUntil = Date.now() + INITIAL_KEYFRAME_BURST_MS;
    this.frigateSawObject = false;
    this.lastFrigateObjectAt = 0;

    // 5. Frigate External Event State (FrigateEventFiling model owns the FSM)
    this.eventFiling = new FrigateEventFiling(
      (prev, next, reason) => {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug({name: this.name, state: next}, 'frigate event state: ' + prev + ' -> ' + next + suffix);
      },
      (prev, next, reason) => {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug({name: this.name, state: prev}, 'refused frigate event state: ' + prev + ' -> ' + next + suffix);
      }
    );

    // 6. FFmpeg Process & Zero-Allocation Media Buffers
    this.enc = null;
    this.offline = new OfflineState();
    this.encoderConsumerConnected = false;
    this.stoppingP2p = false;
    this.idleRssiChangeCount = 0;
    this.idleRssiWindowStartAt = 0;
    this.lastWedgedRadioStopAt = 0;
    this.frame = null;
    this.lastFrame = cachedSnapshot.frame;
    this.frameAt = 0;
    this.frameNew = false;
    this.lastWrite = Date.now();
    this.lastSent = null;
    this.fpsWindowStartAt = 0;
    this.fpsFrameCount = 0;
    this.measuredFps = 0;
    /** @type {Buffer[]|null} */
    this.liveFrameRing = null;
    this.liveFrameRingIdx = 0;
    /** @type {Buffer|null} */
    this.decoderReadBuf = null;
    /** @type {Buffer[]} */
    this.downloadFramePool = [];
    this.audioQueue = new AudioQueue(AUDIO_CHUNK);
    this.viewerSet = new ViewerSet();
    this.renderCardsFn = typeof renderCardsFn === 'function' ? renderCardsFn : null;
    this.lastRenderedSnapshot = null;

    if (this.renderCardsFn) {
      this.renderCardsFn(this);
    }
  }

  /**
   * Returns the human-readable display title for this camera (configured title, Eufy device name, or stream name).
   *
   * @returns {string}
   */
  getDisplayTitle() {
    return this.title || this.telemetry.deviceName || this.name;
  }

  /**
   * Returns the internal Frigate/go2rtc camera stream name.
   *
   * @returns {string}
   */
  getName() {
    return this.name;
  }

  /**
   * Returns the hardware serial number of this camera.
   *
   * @returns {string}
   */
  getSerial() {
    return this.serial;
  }

  /**
   * Returns the structured logger scope name for this camera.
   *
   * @param {string} [fallback='bridge'] - Fallback scope when name and serial are empty.
   * @returns {string}
   */
  getScopeName(fallback = 'bridge') {
    return this.name || this.serial || fallback;
  }

  /**
   * Returns the unique snapshot cache filename (`last_<name>.jpg` when `serial === name`,
   * or `last_<name>_<serial>.jpg` when they differ) for this camera.
   *
   * @returns {string}
   */
  getCacheFileName() {
    return CameraConfig.formatCacheFileName(this.name, this.serial);
  }

  /**
   * Returns true if this camera has a valid non-empty serial and stream name.
   *
   * @returns {boolean}
   */
  hasValidIdentity() {
    return Boolean(this.serial && this.name);
  }

  /**
   * Returns the current session wake/event reason string.
   *
   * @returns {string}
   */
  getReason() {
    return this.session.reason;
  }

  /**
   * Returns the current monotonic session identifier.
   *
   * @returns {number}
   */
  getSessionId() {
    return this.session.id;
  }

  /**
   * Returns true if a live or backfill session is currently active on this camera.
   *
   * @returns {boolean}
   */
  isSessionActive() {
    return Boolean(this.session.active);
  }

  /**
   * Returns the current active stream mode ('rtsp', 'p2p', 'download', or '').
   *
   * @returns {string}
   */
  getActiveMode() {
    return this.session.mode;
  }

  /**
   * Returns the discovered or configured HomeBase RTSP pull URL.
   *
   * @returns {string}
   */
  getRtspUrl() {
    return this.rtspUrl;
  }

  /**
   * Returns the HomeBase RTSP URL with any embedded basic-auth credentials masked for safe logging.
   *
   * @returns {string}
   */
  getMaskedRtspUrl() {
    return maskSecrets(this.rtspUrl || '');
  }

  /**
   * Returns true if aspect ratio preservation is enabled for this camera.
   *
   * @returns {boolean}
   */
  getPreserveAspect() {
    return Boolean(this.preserveAspect);
  }

  /**
   * Returns the current session video codec name.
   *
   * @returns {string}
   */
  getVideoCodec() {
    return this.session.videoCodec;
  }

  /**
   * Returns the formatted 'WxH' dimensions of the current video stream.
   *
   * @returns {string}
   */
  getStreamDimensionsSummary() {
    return this.session.videoWidth + 'x' + this.session.videoHeight;
  }

  /**
   * Returns the last verified clean YUV420p live frame buffer (or null if none).
   *
   * @returns {Uint8Array|null}
   */
  getLastFrameBuffer() {
    return this.lastFrame;
  }

  /**
   * Returns the explicit logger scope of this camera: its scope name plus the current session state, which the
   * logger prints as the "[STATE]" tag.
   *
   * @returns {Readonly<{ name: string, state: string }>}
   */
  getLogScope() {
    return Object.freeze({name: this.getScopeName(), state: this.sessionLifecycle.getState()});
  }

  /**
   * Returns the resolved camera operating mode ('backfill', 'rtsp', 'p2p', 'auto', or 'custom').
   *
   * @returns {string}
   */
  getConfiguredMode() {
    return this.mode;
  }

  /**
   * Returns true when this camera is configured to use the RTSP stream (use_rtsp, or a direct rtsp_url).
   *
   * @returns {boolean}
   */
  isRtspEnabled() {
    return Boolean(this.useRtsp);
  }

  /**
   * Returns true once the active session has decoded its first video frame.
   *
   * @returns {boolean}
   */
  hasGotVideo() {
    return Boolean(this.session.gotVideo);
  }

  /**
   * Returns the number of wake or start retries made in the active session.
   *
   * @returns {number}
   */
  getRestartCount() {
    return this.session.restarts;
  }

  /**
   * Returns true once the camera hardware has sent any event or packet during the active session.
   *
   * @returns {boolean}
   */
  hasHeardFromDeviceInSession() {
    return Boolean(this.session.heardFromDevice);
  }

  /**
   * Returns true once the Eufy rtspStream property has been verified as enabled for this camera.
   *
   * @returns {boolean}
   */
  hasRtspPropertyChecked() {
    return Boolean(this.rtspEnabledChecked);
  }

  /**
   * Returns true while a backfill clip sequence continues after the current download finishes.
   *
   * @returns {boolean}
   */
  hasBackfillContinuation() {
    return this.backfill.hasContinuation();
  }

  /**
   * Returns true when video packets are queued waiting for a decoder process.
   *
   * @returns {boolean}
   */
  hasPendingVideoPackets() {
    return this.session.hasPendingVideoPackets();
  }

  /**
   * Returns true if proc is the decoder process currently attached to this camera.
   *
   * @param {*} proc - Candidate FFmpeg decoder process.
   * @returns {boolean}
   */
  isDecoderProcess(proc) {
    return this.session.isDecoderProcess(proc);
  }

  /**
   * Returns true once a Frigate mask polygon has been verified or applied for this camera.
   *
   * @returns {boolean}
   */
  hasSyncedMaskPolygon() {
    return Boolean(this.card.lastSyncedMaskPoly);
  }

  /**
   * Returns the status card configuration (theme, position, sleep screen) used for rendering.
   *
   * @returns {{ theme: string, position: string, sleepScreen: string }}
   */
  getCardConfig() {
    return this.card.config;
  }

  /**
   * Returns the configured status card placement.
   *
   * @returns {string}
   */
  getCardPosition() {
    return this.card.position;
  }

  /**
   * Returns true when this camera is configured with the diagnostic "hud" card theme.
   *
   * @returns {boolean}
   */
  usesDebugHudTheme() {
    return this.card.theme === CARD_THEMES.HUD;
  }

  /**
   * Evaluates the status card visual state (colors, battery, Wi-Fi, temperature) for a status title.
   *
   * @param {string} statusTitle - Card status title such as 'Live' or 'Asleep'.
   * @returns {Record<string, *>}
   */
  evaluateVisualState(statusTitle) {
    return this.telemetry.evaluateVisualState(statusTitle);
  }

  /**
   * Returns the alternating scratch buffer to composite a live status card onto baseCanvas.
   *
   * @param {Uint8Array} baseCanvas - Source or prepared background YUV420p frame.
   * @returns {Uint8Array}
   */
  acquireLiveOverlayBuffer(baseCanvas) {
    return this.card.prepareLiveOverlayBuffer(baseCanvas);
  }

  /**
   * Registers the lazy renderer used to build the asleep, waking, and busy status cards on demand.
   *
   * @param {(titleText: string, targetBuf: Uint8Array) => Uint8Array} renderer - Card renderer callback.
   */
  setLazyCardRenderer(renderer) {
    this.card.setLazyCardRenderer(renderer);
  }

  /**
   * Returns an immutable summary descriptor for the /api/wake 404 available-cameras list.
   *
   * @returns {Readonly<{ name: string, serial: string, title: string }>}
   */
  toAvailableCameraSummary() {
    return Object.freeze({
      name: this.name,
      serial: this.serial,
      title: this.getDisplayTitle(),
    });
  }

  /**
   * Returns true if this camera's card theme and placement support rendering a live stream overlay.
   *
   * @returns {boolean}
   */
  supportsLiveCardOverlay() {
    return this.card.supportsLiveCardOverlay();
  }

  /**
   * Returns an immutable sanitized summary of this camera's effective configuration for GET /api/config,
   * setting inapplicable or ignored fields to null.
   *
   * @returns {Readonly<Record<string, *>>}
   */
  toConfigSummary() {
    const cardCfg = this.card.toConfigSummary();
    if (this.directRtsp) {
      return Object.freeze({
        name: this.name,
        serial: this.explicitSerial || null,
        title: this.getDisplayTitle(),
        station_serial: null,
        mode: this.mode,
        priority: null,
        use_rtsp: Boolean(this.useRtsp),
        rtsp_capable: this.isRtspCapable(),
        rtsp_url: this.getMaskedRtspUrl() || null,
        backfill_only: null,
        backfill_enabled: null,
        hold_secs: null,
        stream_max_secs: null,
        frigate_event_secs: null,
        end_early: null,
        idle_timeout_secs: null,
        view_linger_secs: null,
        view_max_secs: null,
        low_battery_threshold: null,
        critical_battery_threshold: null,
        low_battery_hold_secs: null,
        low_battery_wake_on_view: null,
        sync_power: null,
        power_working_mode: null,
        recording_clip_length: null,
        recording_end_early: null,
        recording_retrigger_interval: null,
        enforce_streaming_quality: null,
        track_stuck_spotlight: null,
        card_theme: cardCfg.card_theme,
        card_position: cardCfg.card_position,
        sleep_screen: cardCfg.sleep_screen,
        startup_snapshot: null,
        card_show_on_live: cardCfg.card_show_on_live,
        auto_frigate_mask: this.hasAutoFrigateMask(),
        preserve_aspect_ratio: this.getPreserveAspect(),
        telemetry: null,
      });
    }
    const hwCfg = this.telemetry.hwRecordingCfg;
    return Object.freeze({
      name: this.name,
      serial: this.serial,
      title: this.getDisplayTitle(),
      station_serial: this.stationSerial || null,
      mode: this.mode,
      priority: this.priority,
      use_rtsp: Boolean(this.useRtsp),
      rtsp_capable: this.isRtspCapable(),
      rtsp_url: this.useRtsp ? this.getMaskedRtspUrl() || null : null,
      backfill_only: Boolean(this.alwaysBackfill),
      backfill_enabled: Boolean(this.backfillDownloads),
      hold_secs: Math.round(this.timers.holdMs / MS_PER_SECOND),
      stream_max_secs: Math.round(this.timers.maxMs / MS_PER_SECOND),
      frigate_event_secs: this.timers.eventSecs,
      end_early: Boolean(this.timers.letEufyDecideEnd),
      idle_timeout_secs: this.alwaysBackfill ? null : Math.round(this.timers.earlySleepMs / MS_PER_SECOND),
      view_linger_secs: Math.round(this.timers.lingerMs / MS_PER_SECOND),
      view_max_secs: Math.round(this.timers.viewMaxMs / MS_PER_SECOND),
      low_battery_threshold: this.telemetry.lowBatThreshold,
      critical_battery_threshold: this.telemetry.criticalBatThreshold,
      low_battery_hold_secs: Math.round(this.timers.lowBatHoldMs / MS_PER_SECOND),
      low_battery_wake_on_view: Boolean(this.telemetry.lowBatWakeOnView),
      sync_power: this.telemetry.hasPowerConservationEnabled(),
      power_working_mode: hwCfg.powerWorkingMode,
      recording_clip_length: hwCfg.recordingClipLength,
      recording_end_early: hwCfg.recordingEndClipMotionStops,
      recording_retrigger_interval: hwCfg.recordingRetriggerInterval,
      enforce_streaming_quality: hwCfg.enforceQuality,
      track_stuck_spotlight: this.hasStuckSpotlightTracking(),
      card_theme: cardCfg.card_theme,
      card_position: cardCfg.card_position,
      sleep_screen: cardCfg.sleep_screen,
      startup_snapshot: this.card.sleepScreen === SLEEP_SCREENS.SNAPSHOT ? this.startupSnapshot : null,
      card_show_on_live: cardCfg.card_show_on_live,
      auto_frigate_mask: this.hasAutoFrigateMask(),
      preserve_aspect_ratio: this.getPreserveAspect(),
      telemetry: this.telemetry.toConfigSummary(this.card.theme),
    });
  }

  /**
   * Returns the paired HomeBase/standalone station serial number, or empty string on direct rtsp_url cameras.
   *
   * @returns {string}
   */
  getStationSerial() {
    return this.directRtsp ? '' : this.stationSerial || '';
  }

  /**
   * Returns true if this camera's HomeBase station (or direct RTSP endpoint) is marked connected.
   *
   * @returns {boolean}
   */
  isStationConnected() {
    return this.telemetry.isStationConnected();
  }

  /**
   * Returns true if Frigate HTTP API connectivity is marked healthy on this camera.
   *
   * @returns {boolean}
   */
  isFrigateConnected() {
    return this.telemetry.isFrigateConnected();
  }

  /**
   * Returns true if go2rtc HTTP API connectivity is marked healthy on this camera.
   *
   * @returns {boolean}
   */
  isGo2rtcConnected() {
    return this.telemetry.isGo2rtcConnected();
  }

  /**
   * Returns true when this camera is reachable (direct RTSP endpoint reachable, or Eufy WS + station + device online).
   *
   * @returns {boolean}
   */
  isReachable() {
    return this.directRtsp
      ? this.telemetry.isStationConnected()
      : Boolean(this.telemetry.isWsConnected() && this.telemetry.isStationConnected() && !this.isDeviceOffline());
  }

  /**
   * Resolves the FFmpeg video encoder codec name ('h264_vaapi', 'h264_qsv', 'h264_nvenc',
   * 'h264_v4l2m2m', or 'libx264').
   *
   * @param {string} [globalHwaccel=ACTIVE_HWACCEL] - Configured global hardware acceleration mode.
   * @returns {string}
   */
  resolveEncoderCodec(globalHwaccel = ACTIVE_HWACCEL) {
    const hwMode = this.resolveActiveHwaccel(globalHwaccel);
    return hwMode ? HW_VIDEO_CODEC_PREFIX + hwMode : SOFTWARE_VIDEO_CODEC;
  }

  /**
   * Pure read-only lookup of the effective session FSM state without mutating cooldown state.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  peekEffectiveSessionState(now = Date.now()) {
    return this.sessionLifecycle.peekEffective(now);
  }

  /**
   * Pure read-only lookup of the effective Frigate event FSM state without mutating cooldown state.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  peekEffectiveFrigateEventState(now = Date.now()) {
    return this.eventFiling.peekEffectiveState(now);
  }

  /**
   * Resolves the high-level semantic runtime status kind ('live', 'backfill', 'waking', 'waiting',
   * 'disconnected', 'low_battery', or 'asleep') for GET /api/status without mutating state.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  resolveRuntimeStatus(now = Date.now()) {
    const streaming =
      this.isStreamingLive(now, DEFAULT_FRESH_FRAME_MAX_AGE_MS) ||
      Boolean(this.session.active && this.session.gotVideo);
    if (streaming) {
      return this.isBackfillPlayback() || this.backfill.hasContinuation()
        ? CAMERA_RUNTIME_STATUSES.BACKFILL
        : CAMERA_RUNTIME_STATUSES.LIVE;
    }
    if (this.session.active && !this.isBackfillPlayback() && !this.isRtspDirect()) {
      return CAMERA_RUNTIME_STATUSES.WAKING;
    }
    if (this.isWaitingForSlotOrBackfill(now, DEFAULT_FRESH_FRAME_MAX_AGE_MS)) {
      return CAMERA_RUNTIME_STATUSES.WAITING;
    }
    if (this.hasServiceDisruption()) {
      return CAMERA_RUNTIME_STATUSES.DISCONNECTED;
    }
    if (!this.isRtspDirect() && this.isLowBattery()) {
      return CAMERA_RUNTIME_STATUSES.LOW_BATTERY;
    }
    return CAMERA_RUNTIME_STATUSES.ASLEEP;
  }

  /**
   * Builds the upstream connectivity status sub-object for GET /api/status.
   *
   * @returns {Readonly<Record<string, boolean|null>>}
   */
  _buildServicesStatusSummary() {
    return Object.freeze({
      ws_connected: this.directRtsp ? null : this.telemetry.isWsConnected(),
      station_connected: this.directRtsp ? null : this.telemetry.isStationConnected(),
      endpoint_reachable: this.directRtsp ? this.telemetry.isStationConnected() : null,
      frigate_connected: this.telemetry.isFrigateConnected(),
      go2rtc_connected: this.telemetry.isGo2rtcConnected(),
    });
  }

  /**
   * Builds the FFmpeg encoder status sub-object for GET /api/status.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {Readonly<Record<string, *>>}
   */
  _buildEncoderStatusSummary(now) {
    return Object.freeze({
      running: this.hasEncoderProcess(),
      paused_for_offline: this.offline.isEncoderStopped(),
      codec: this.resolveEncoderCodec(ACTIVE_HWACCEL),
      hwaccel_fallback: Boolean(ACTIVE_HWACCEL && !this.useHwaccel),
      consumer_connected: Boolean(this.encoderConsumerConnected),
      stdin_backpressured: this.isEncoderStdinBackpressured(),
      target_fps: this.session.active || this.isInKeyframeBurst(now) ? LIVE_FPS : IDLE_FPS,
      measured_fps: this.measuredFps > 0 ? roundTenths(this.measuredFps) : 0,
      last_write_ago_secs: Math.max(0, roundTenths((now - this.lastWrite) / MS_PER_SECOND)),
      has_cached_snapshot: Buffer.isBuffer(this.lastFrame),
    });
  }

  /**
   * Builds the active stream session and decoder status sub-object for GET /api/status.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {Readonly<Record<string, *>>}
   */
  _buildSessionStatusSummary(now) {
    const wantUntilMs = this.wantUntil();
    const hasFiniteHold =
      this.session.active &&
      !this.isRtspDirect() &&
      !this.isBackfillPlayback() &&
      wantUntilMs > 0 &&
      Number.isFinite(wantUntilMs);
    const hasDimensions = this.session.active && this.session.videoWidth > 0 && this.session.videoHeight > 0;
    return Object.freeze({
      id: this.session.id,
      active_mode: this.session.active ? this.session.mode || null : null,
      initiator: this.session.active ? this.session.initiator || null : null,
      reason: this.session.active ? this.session.reason || null : null,
      got_video: Boolean(this.session.gotVideo),
      video_codec: this.session.active && this.session.videoCodec ? this.session.videoCodec : null,
      resolution: hasDimensions ? this.getStreamDimensionsSummary() : null,
      uptime_secs:
        this.session.active && this.session.startedAt > 0
          ? Math.max(0, Math.round((now - this.session.startedAt) / MS_PER_SECOND))
          : null,
      hold_remaining_secs: hasFiniteHold ? Math.max(0, Math.round((wantUntilMs - now) / MS_PER_SECOND)) : null,
      last_video_ago_secs:
        this.session.lastVideoAt > 0
          ? Math.max(0, roundTenths((now - this.session.lastVideoAt) / MS_PER_SECOND))
          : null,
      decoder_running: this.hasDecoderProcess(),
      decoder_state: this.session.decoderState,
      restarts: this.session.restarts || 0,
      dropped_frames: this.session.droppedFrames || 0,
      queued_live_frames: this.liveFrames.length,
      queued_download_frames: this.backfill.frames.length,
    });
  }

  /**
   * Builds the go2rtc viewer connection summary sub-object for GET /api/status.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {Readonly<Record<string, *>>}
   */
  _buildViewersStatusSummary(now) {
    return Object.freeze({
      connected: this.viewerSet.count(),
      waking: this.viewerSet.wakingCount(),
      actively_viewing: this.isActivelyViewing(now),
    });
  }

  /**
   * Builds the Frigate external event and auto-mask status sub-object for GET /api/status.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {Readonly<Record<string, *>>}
   */
  _buildFrigateEventStatusSummary(now) {
    const eventUntil = this.eventFiling.until;
    const hasRemaining = eventUntil > now && Number.isFinite(eventUntil);
    return Object.freeze({
      state: this.peekEffectiveFrigateEventState(now),
      label: this.eventFiling.label || null,
      remaining_secs: hasRemaining ? Math.max(0, Math.round((eventUntil - now) / MS_PER_SECOND)) : null,
      last_event_id: this.eventFiling.lastCreatedId || null,
      mask_synced: this.hasAutoFrigateMask() ? Boolean(this.card.lastSyncedMaskPoly) : null,
    });
  }

  /**
   * Builds the HomeBase backfill clip queue status sub-object for GET /api/status (null on direct rtsp_url).
   *
   * @returns {Readonly<Record<string, *>>|null}
   */
  _buildBackfillStatusSummary() {
    if (this.directRtsp) {
      return null;
    }
    const bfJob = this.backfill.pending || this.backfill.active;
    const playing = this.isBackfillPlayback();
    return Object.freeze({
      state: bfJob && bfJob.getState() ? bfJob.getState() : SESSION_STATES.IDLE,
      pending: this.hasPendingBackfill(),
      playing,
      label: bfJob && bfJob.getEvent() ? bfJob.getEvent() : null,
      query_attempts: bfJob ? bfJob.getQueryAttempts() || 0 : 0,
      queued_clips: this.backfill.clipQueue.length + (this.backfill.clip ? 1 : 0),
      played_frames: playing ? this.backfill.playedFrames || 0 : 0,
      decoded_frames: playing ? this.backfill.decodedFrames || 0 : 0,
    });
  }

  /**
   * Builds the Eufy hardware trigger status sub-object for GET /api/status (null on direct rtsp_url).
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {Readonly<Record<string, *>>|null}
   */
  _buildTriggersStatusSummary(now) {
    if (this.directRtsp) {
      return null;
    }
    const active = this.hasActiveHardwareTriggers(now);
    return Object.freeze({
      active,
      active_events: active ? Object.freeze(this.hardwareTriggers.activeEvents()) : Object.freeze([]),
      last_event: this.hardwareTriggers.lastStartEvent() || null,
      last_event_ago_secs:
        this.session.lastMotionAt > 0
          ? Math.max(0, Math.round((now - this.session.lastMotionAt) / MS_PER_SECOND))
          : null,
    });
  }

  /**
   * Returns a deeply frozen read-only runtime status summary of this camera for GET /api/status,
   * setting Eufy-only sub-objects to null on direct rtsp_url cameras without mutating FSM state.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {Readonly<Record<string, *>>}
   */
  toStatusSummary(now = Date.now()) {
    const rtspShown = this.directRtsp || Boolean(this.useRtsp);
    return Object.freeze({
      name: this.name,
      serial: this.directRtsp ? this.explicitSerial || null : this.serial,
      title: this.getDisplayTitle(),
      station_serial: this.directRtsp ? null : this.stationSerial || null,
      mode: this.mode,
      rtsp_direct: Boolean(this.directRtsp),
      rtsp_capable: this.isRtspCapable(),
      rtsp_url: rtspShown ? this.getMaskedRtspUrl() || null : null,
      status: this.resolveRuntimeStatus(now),
      session_state: this.peekEffectiveSessionState(now),
      state_duration_secs: Math.max(
        0,
        Math.round((now - (this.sessionLifecycle.getChangedAt() || now)) / MS_PER_SECOND)
      ),
      active: Boolean(this.session.active),
      passive_probe: this.isPassiveRtspDirectProbe(),
      reachable: this.isReachable(),
      disrupted: this.hasServiceDisruption(),
      offline: this.isDeviceOffline(),
      offline_reason: this.getOfflineReason() || null,
      last_seen: this.telemetry.getLastSeen() || null,
      services: this._buildServicesStatusSummary(),
      encoder: this._buildEncoderStatusSummary(now),
      session: this._buildSessionStatusSummary(now),
      viewers: this._buildViewersStatusSummary(now),
      frigate_event: this._buildFrigateEventStatusSummary(now),
      backfill: this._buildBackfillStatusSummary(),
      triggers: this._buildTriggersStatusSummary(now),
      telemetry: this.telemetry.toStatusSummary(),
    });
  }

  /**
   * Returns true once an initial battery percentage has been populated on this camera's Telemetry model.
   *
   * @returns {boolean}
   */
  hasBatteryReading() {
    return this.telemetry.hasBatteryReading();
  }

  /**
   * Returns the current battery percentage reading (or null if not yet populated).
   *
   * @returns {number|null}
   */
  getBatteryPct() {
    return this.telemetry.battery;
  }

  /**
   * Evaluates whether the camera's videoStreamingQuality property needs to be updated.
   *
   * @param {Record<string, *>} props - Raw properties dictionary from eufy-security-ws.
   * @returns {Readonly<{ shouldUpdate: boolean, currentQuality: number, targetQuality: number }>}
   */
  evaluateQualityChange(props) {
    return this.telemetry.evaluateQualityChange(props);
  }

  /**
   * Evaluates whether any Eufy Power Manager recording properties need to be synced to the camera.
   *
   * @param {Record<string, *>} props - Raw properties dictionary from eufy-security-ws.
   * @returns {ReadonlyArray<Readonly<{ name: string, currentValue: *, targetValue: * }>>}
   */
  evaluateRecordingModeChanges(props) {
    return this.telemetry.evaluateRecordingModeChanges(props);
  }

  /**
   * Resolves the structured log level and message after applying raw Eufy device properties.
   *
   * @param {{
   *   hadInitialTelemetry: boolean,
   *   prevBattery: number|null,
   *   nowLowBat: boolean,
   *   nowOffline: boolean,
   *   stateChanged: boolean,
   *   minorTelemetryChanged: boolean,
   *   model: string,
   *   swVer: string,
   * }} summary - Property application summary.
   * @returns {{ logLevel: 'warn'|'info'|'debug'|'', logMsg: string }}
   */
  resolveTelemetryLogOutput(summary) {
    const {hadInitialTelemetry, prevBattery, nowLowBat, nowOffline, stateChanged, minorTelemetryChanged, model, swVer} =
      summary;
    if (!hadInitialTelemetry && (this.telemetry.hasBatteryReading() || nowOffline)) {
      return {
        logLevel: nowOffline ? 'warn' : 'info',
        logMsg: this.telemetry.formatLoadedLog(model, swVer, nowLowBat),
      };
    }
    if (stateChanged) {
      return {
        logLevel: nowOffline ? 'warn' : 'info',
        logMsg: this.telemetry.formatStateChangeLog(prevBattery, nowLowBat),
      };
    }
    if (minorTelemetryChanged) {
      return {
        logLevel: 'debug',
        logMsg: this.telemetry.formatUpdateLog(),
      };
    }
    return {logLevel: '', logMsg: ''};
  }

  /**
   * Applies raw Eufy device telemetry properties and returns an immutable summary with formatted log output.
   *
   * @param {Record<string, *>} props - Raw properties dictionary from eufy-security-ws.
   * @param {boolean} [allowCardRebuild=false] - Whether to force a sleeping card rebuild.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {Readonly<{
   *   shouldRebuildCard: boolean,
   *   hadInitialTelemetry: boolean,
   *   isOffline: boolean,
   *   offlineChanged: boolean,
   *   stateChanged: boolean,
   *   logLevel: 'warn'|'info'|'debug'|'',
   *   logMsg: string,
   * }>}
   */
  applyTelemetryProperties(props, allowCardRebuild = false, now = Date.now()) {
    const summary = this.telemetry.applyProperties(props, now);
    const {hadInitialTelemetry, nowOffline, offlineChanged, stateChanged, wifiTierChanged} = summary;
    if (nowOffline) {
      this._clearActiveHardwareTriggers();
      this.clearDeferredLiveWake();
    }
    const {logLevel, logMsg} = this.resolveTelemetryLogOutput(summary);

    const shouldRebuildCard = Boolean(allowCardRebuild || !hadInitialTelemetry || stateChanged || wifiTierChanged);
    return Object.freeze({
      shouldRebuildCard,
      hadInitialTelemetry,
      isOffline: nowOffline,
      offlineChanged,
      stateChanged,
      logLevel,
      logMsg,
    });
  }

  /**
   * Returns true if this camera is currently offline and its HomeBase refresh cooldown has elapsed.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  shouldRefreshOfflineOnView(now = Date.now()) {
    return this.isDeviceOffline() ? this.telemetry.shouldRefreshLowBatteryOnView(now) : false;
  }

  /**
   * Returns true if automatic Frigate motion/object mask synchronization is enabled on this camera's StatusCard.
   *
   * @returns {boolean}
   */
  hasAutoFrigateMask() {
    return Boolean(this.card.autoFrigateMask);
  }

  /**
   * Clears the cached Frigate mask polygon on this camera's StatusCard.
   */
  resetMaskSync() {
    this.card.resetMaskSync();
  }

  /**
   * Returns true if the given mask section is 'objects' and the polygon matches the last synced polygon.
   *
   * @param {'motion'|'objects'} section - Frigate mask section.
   * @param {string} poly - Normalized polygon coordinates.
   * @returns {boolean}
   */
  isMaskSectionAlreadySynced(section, poly) {
    return Boolean(section === 'objects' && this.card.lastSyncedMaskPoly === poly);
  }

  /**
   * Returns true if the given polygon is already synced and intact in the camera's StatusCard.
   *
   * @param {string} poly - Normalized polygon coordinates.
   * @param {boolean} masksIntact - Whether Frigate motion and object masks match poly.
   * @returns {boolean}
   */
  isMaskSynced(poly, masksIntact) {
    return this.card.isMaskSynced(poly, masksIntact);
  }

  /**
   * Records that the given polygon has been verified or applied in Frigate.
   *
   * @param {string} poly - Normalized polygon coordinates.
   */
  markMaskSynced(poly) {
    this.card.markMaskSynced(poly);
  }

  /**
   * Formats the status card theme and position summary (e.g. 'glance@top-left' or 'glance/top-left').
   *
   * @param {string} [sep='@'] - Separator between theme and position.
   * @returns {string}
   */
  formatCardPlacementSummary(sep = '@') {
    return this.card.theme + sep + this.card.position;
  }

  /**
   * Suppresses the live corner card overlay temporarily while injecting a clean Frigate event snapshot.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [burstMs=KEYFRAME_BURST_MS] - Keyframe burst duration in milliseconds.
   */
  enableCleanSnapshotCardSuppression(now = Date.now(), burstMs = KEYFRAME_BURST_MS) {
    this.card.suppressLiveCard = true;
    this.triggerKeyframeBurst(now, burstMs);
  }

  /**
   * Restores live corner card rendering if it was suppressed for a clean Frigate event snapshot.
   *
   * @returns {boolean} True if suppression was active and has now been cleared.
   */
  disableCleanSnapshotCardSuppression() {
    if (this.card.suppressLiveCard) {
      this.card.suppressLiveCard = false;
      return true;
    }
    return false;
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
   * Transitions the camera session finite state machine to nextState when permitted by
   * ALLOWED_SESSION_TRANSITIONS, logs the transition when the state changes, and returns the state.
   *
   * @param {string} nextState - Target state from SESSION_STATES.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {string} [reason=''] - Optional human-readable transition trigger reason.
   * @returns {string}
   */
  transitionTo(nextState, now = Date.now(), reason = '') {
    return this.sessionLifecycle.transitionTo(nextState, now, reason);
  }

  /**
   * Resets per-decoder backpressure queues and active frame state.
   */
  _resetDecoderPipeState() {
    this.session.resetDecoderPipeState();
    this.liveFrames = [];
    this.frame = null;
    this.frameNew = false;
    this.audioQueue.clear();
  }

  /**
   * Returns the current session FSM state, automatically advancing COOLDOWN to IDLE once
   * COOLDOWN_MS has elapsed since sleptAt.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  getSessionState(now = Date.now()) {
    return this.sessionLifecycle.refresh(now);
  }

  /**
   * Initializes per-session runtime state when a camera transitions to active streaming.
   *
   * @param {'rtsp'|'p2p'|'download'} mode - Active stream mode.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [p2pReady=true] - Whether the stream is ready to receive video frames immediately.
   */
  beginSession(mode, now = Date.now(), p2pReady = true) {
    this.getSessionState(now);
    this.getFrigateEventState(now);
    this.stoppingP2p = false;
    this.unexpectedRtspActive = false;
    this.idleRssiChangeCount = 0;
    this.idleRssiWindowStartAt = 0;
    const nextState = this.session.begin(mode, now, p2pReady);
    const startReason =
      mode === STREAM_MODES.RTSP
        ? 'session start: rtsp'
        : mode === STREAM_MODES.DOWNLOAD
          ? 'session start: backfill download'
          : 'session start: p2p';
    this.transitionTo(nextState, now, startReason);
    if (mode !== STREAM_MODES.DOWNLOAD) {
      this.backfill.clearActiveForLiveSession();
      this.clearDeferredLiveWake();
    }
    this.frigateSawObject = false;
    this.lastFrigateObjectAt = 0;
    this.lastExtendCheckAt = 0;
    this.extendCheckInFlight = false;
    this._resetDecoderPipeState();
    this.burstUntil = mode === STREAM_MODES.DOWNLOAD ? 0 : now + KEYFRAME_BURST_MS;
  }

  /**
   * Resets per-session runtime state when an active stream stops and transitions to sleep.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [hadVideo=false] - Whether decoded video was received during the session.
   * @param {boolean} [preemptedByViewer=false] - Whether stopped due to viewer switching cameras.
   * @param {string} [closedMode='p2p'] - Stream mode that just closed.
   */
  endSession(
    now = Date.now(),
    hadVideo = undefined,
    preemptedByViewer = false,
    closedMode = this.session.mode || STREAM_MODES.P2P
  ) {
    this.unexpectedRtspActive = false;
    this.idleRssiChangeCount = 0;
    this.idleRssiWindowStartAt = 0;
    this.backfill.resetTransferState();
    this.downloadFramePool.length = 0;
    this._resetDecoderPipeState();
    this.session.end(now, hadVideo);
    if (!hadVideo) {
      this.abortPendingFrigateEvent('session ended without video');
    }
    this.getFrigateEventState(now);
    this.eventActive = false;
    this.frigateSawObject = false;
    this.lastFrigateObjectAt = 0;
    this.lastExtendCheckAt = 0;
    this.extendCheckInFlight = false;
    this.eventPriority = 0;
    this.isStartupProbe = false;
    if (closedMode === STREAM_MODES.DOWNLOAD) {
      this._finalizeDownloadSessionEnd(now, hadVideo, preemptedByViewer);
    } else {
      this.backfill.clearActiveClipAfterLiveEnd();
      this._clearActiveHardwareTriggers();
      if (hadVideo && !preemptedByViewer && !this.isRtspDirect()) {
        this.sessionLifecycle.markSlept(now);
        this.transitionTo(SESSION_STATES.COOLDOWN, now, 'live session ended, entering cooldown');
      } else {
        const idleReason = preemptedByViewer
          ? 'preempted by viewer'
          : hadVideo
            ? 'direct rtsp session ended'
            : 'session ended without video';
        this.transitionTo(SESSION_STATES.IDLE, now, idleReason);
      }
    }
    this.burstUntil = now + KEYFRAME_BURST_MS;
    this.clearViewerQueue();
    if (closedMode === STREAM_MODES.DOWNLOAD) {
      if (preemptedByViewer) {
        this.clearDeferredLiveWake();
      } else {
        this.promoteDeferredLiveWakeIfReady(now);
      }
    }
  }

  /**
   * Finalizes backfill clip/job queues, follow-up queries, and continuation state when a
   * STREAM_MODES.DOWNLOAD session ends.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean|undefined} hadVideo - Whether decoded video was received during the download.
   * @param {boolean} preemptedByViewer - Whether stopped due to viewer switching cameras.
   */
  _finalizeDownloadSessionEnd(now, hadVideo, preemptedByViewer) {
    this.transitionTo(SESSION_STATES.IDLE, now, 'backfill session ended');
    this.backfill.finalizeDownloadEnd(now, hadVideo, preemptedByViewer);
  }

  /**
   * Captures final session metrics, preserves the latest decoded frame into lastFrame,
   * transitions the camera to sleep via endSession(), and returns the formatted SLEEP log message.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} why - Reason the camera is going to sleep.
   * @param {boolean} [preemptedByViewer=false] - Whether stopped due to viewer switching cameras.
   * @param {string} [initiator='bridge'] - Decision maker identifier.
   * @returns {{
   *   inFlightStart: Promise<*>|null,
   *   closedMode: string,
   *   hadDownloadFinished: boolean,
   *   hadUnexpectedRtsp: boolean,
   *   wokeWithoutDeviceReply: boolean,
   *   shouldPersistSnapshot: boolean,
   *   sleepMsg: string,
   * }}
   */
  terminateSession(now, why, preemptedByViewer = false, initiator = 'bridge') {
    const effectiveNow = Math.max(now, this.session.lastStartAt || 0, this.session.startedAt || 0);
    const inFlightStart = this.session.startPromise;
    const hadVideo = this.hasConfirmedSessionVideo();
    const hasFreshSessionFrame = Buffer.isBuffer(this.frame) && this.frame.length === FRAME;
    const shouldPersistSnapshot = Boolean(hadVideo || this.hasDecodedFrame() || hasFreshSessionFrame);
    const hadDownloadFinished = Boolean(this.backfill.finished);
    const hadUnexpectedRtsp = Boolean(this.unexpectedRtspActive);
    const hadHeardFromDevice = Boolean(this.session.heardFromDevice);
    const wasEventActive = this.eventActive;
    const prevMotionUntil = this.session.motionUntil;
    const liveSecs = Math.round((effectiveNow - this.session.startedAt) / MS_PER_SECOND);
    const lastVideoAgo = this.session.lastVideoAt
      ? ((effectiveNow - this.session.lastVideoAt) / MS_PER_SECOND).toFixed(1) + 's'
      : 'none';
    const restartsCount = this.session.restarts;
    const closedSession = this.session.id;
    const closedMode = this.session.mode || STREAM_MODES.P2P;
    const isDownload = closedMode === STREAM_MODES.DOWNLOAD;
    const backfillSummary = isDownload
      ? this.backfill.formatSleepSummary(effectiveNow, this.session.lastVideoAt, LIVE_FPS)
      : '';

    this.clearApiWakeTimer();
    if (Buffer.isBuffer(this.frame) && this.frame.length === FRAME) {
      this.lastFrame = Buffer.from(this.frame);
    }
    // A download cut after Frame 0 is reported as unsuccessful so endSession() re-queues the clip within its attempts.
    const endedWithVideo = isDownload ? hadVideo && isCompletedDownloadStop(hadDownloadFinished, initiator) : hadVideo;
    this.endSession(effectiveNow, endedWithVideo, preemptedByViewer, closedMode);
    this.stoppingP2p = closedMode === STREAM_MODES.P2P;
    if (
      wasEventActive &&
      !isDownload &&
      (preemptedByViewer || String(initiator).startsWith(ARBITRATOR_INITIATOR_PREFIX)) &&
      prevMotionUntil > effectiveNow
    ) {
      this.backfill.requeuePreemptedEvent({
        name: this.name,
        at: this.session.startedAt || effectiveNow,
        lastActivityAt: this.session.lastMotionAt || effectiveNow,
        event: this.eventFiling.label || 'motion detected',
        personName: this.eventFiling.person || '',
        reason: this.session.reason || 'motion detected',
        priority: this.priority + (this.eventPriority || DEFAULT_EVENT_PRIORITY),
        attempts: 0,
        recordingActive: true,
      });
    }
    const wokeWithoutDeviceReply = Boolean(
      !this.isRtspDirect() &&
      !hadVideo &&
      !hadHeardFromDevice &&
      (initiator === 'error/watchdog-timeout' || initiator === 'error/rtsp-wake-timeout')
    );
    if (wokeWithoutDeviceReply && !wasEventActive) {
      this.telemetry.markWakeTimedOut();
    }
    if (this.isDeviceOffline()) {
      this.session.motionUntil = 0;
      this._clearActiveHardwareTriggers();
      this.clearDeferredLiveWake();
      this.clearViewerQueue('device_offline');
    }

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
      backfillSummary +
      ', session=' +
      closedSession +
      ')';

    return {
      inFlightStart,
      closedMode,
      hadDownloadFinished,
      hadUnexpectedRtsp,
      wokeWithoutDeviceReply,
      shouldPersistSnapshot,
      sleepMsg,
    };
  }

  /**
   * Returns the timestamp until which the camera wants to remain awake.
   *
   * @returns {number}
   */
  wantUntil() {
    return this.session.wantUntil();
  }

  /**
   * Returns true if the camera is currently within an active motion hold window.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @returns {boolean}
   */
  isInMotion(now = Date.now()) {
    return this.session.isInMotion(now);
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
   * Returns true if the camera is currently active using a non-RTSP session mode (P2P or DOWNLOAD).
   *
   * @returns {boolean}
   */
  usesP2pSlot() {
    return this.session.usesP2pSlot();
  }

  /**
   * Returns true if the camera is actively occupying the HomeBase P2P network channel
   * (active P2P live session or in-transfer backfill download before downloadFinished).
   * Once downloadFinished is true and the camera is merely draining buffered frames from RAM
   * into Frigate, the HomeBase P2P channel is free for other cameras on the station.
   *
   * @returns {boolean}
   */
  isOccupyingStationP2pChannel() {
    return this.session.isOccupyingP2pChannel(this.backfill.finished);
  }

  /**
   * Returns true if the camera is currently active in HomeBase native RTSP mode.
   *
   * @returns {boolean}
   */
  isActiveRtspSession() {
    return this.session.isActiveRtsp();
  }

  /**
   * Returns true if the camera is currently active in a live (non-download) session.
   *
   * @returns {boolean}
   */
  isActiveLiveSession() {
    return this.session.isActiveLive();
  }

  /**
   * Returns true if the camera is currently in an active RTSP session with a resolved RTSP URL.
   *
   * @returns {boolean}
   */
  canStartRtspStream() {
    return Boolean(this.isActiveRtspSession() && (this.rtspUrl || this.rtspSupported));
  }

  /**
   * Returns true if this camera is active in the given RTSP session, has a resolved rtspUrl,
   * and does not yet have a running FFmpeg decoder process.
   *
   * @param {number} [sessionId=this.session.id] - Expected session identifier.
   * @returns {boolean}
   */
  canSpawnRtspDecoder(sessionId = this.session.id) {
    return Boolean(this.isCurrentSession(sessionId, STREAM_MODES.RTSP) && this.rtspUrl && !this.session.dec);
  }

  /**
   * Returns true if the initial Frigate detection event should be filed on RTSP stream start.
   *
   * @returns {boolean}
   */
  shouldFileInitialRtspEvent() {
    return Boolean(this.eventActive && !this.session.rtspRewaking && this.session.restarts === 0);
  }

  /**
   * Returns true if an RTSP session has received decoded video and is not currently re-waking.
   *
   * @returns {boolean}
   */
  isEstablishedRtspStream() {
    return this.session.isEstablishedRtsp();
  }

  /**
   * Returns true if the camera is currently inactive, online, and has an unexpired motion or viewer wake request.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  wantsWake(now = Date.now()) {
    return Boolean(!this.session.active && !this.isDeviceOffline() && now < this.wantUntil());
  }

  /**
   * Returns true if the camera is inactive, wants to wake, and is eligible for HomeBase native RTSP.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  wantsRtspWake(now = Date.now()) {
    return Boolean(this.wantsWake(now) && this.isRtspCapable());
  }

  /**
   * Returns true if an active live session's motion and view hold timers have expired.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasExpiredLiveHold(now = Date.now()) {
    return this.session.hasExpiredLiveHold(now);
  }

  /**
   * Returns true if this camera competes for the P2P livestream slot on stationKey.
   *
   * @param {string} stationKey - Station serial key.
   * @returns {boolean}
   */
  belongsToStationP2pSlot(stationKey) {
    return Boolean(!this.isRtspCapable() && this.getStationKey() === stationKey);
  }

  /**
   * Returns true if this camera is holding the P2P slot on stationKey for an active motion event.
   *
   * @param {string} stationKey - Station serial key.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isHoldingStationP2pForMotion(stationKey, now = Date.now()) {
    return Boolean(this.isInMotion(now) && this.belongsToStationP2pSlot(stationKey));
  }

  /**
   * Returns true if the camera is currently active in HomeBase clip backfill download mode.
   *
   * @returns {boolean}
   */
  isBackfillPlayback() {
    return this.session.isBackfillPlayback();
  }

  /**
   * Returns true if this camera is a Eufy Video Doorbell (T8214), which does not support HomeBase native RTSP.
   *
   * @returns {boolean}
   */
  isDoorbell() {
    return Boolean(this.serial && this.serial.startsWith(DOORBELL_SERIAL_PREFIX));
  }

  /**
   * Returns true if the camera is configured and eligible to stream via HomeBase native RTSP.
   *
   * @returns {boolean}
   */
  isRtspCapable() {
    return Boolean(!this.isDoorbell() && this.useRtsp && (this.rtspUrl || this.rtspSupported))
      ? this.session.mode !== STREAM_MODES.P2P && this.session.mode !== STREAM_MODES.DOWNLOAD
      : false;
  }

  /**
   * Records that the camera actively emitted a property update or livestream event during the current session.
   */
  markDeviceHeardInSession() {
    this.session.markDeviceHeard();
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
   * Returns true if the camera is currently at or below its critical battery threshold and not charging.
   *
   * @returns {boolean}
   */
  isCriticalBattery() {
    return this.telemetry.isCriticalBattery();
  }

  /**
   * Returns true if the camera is currently offline/dead (reported offline by Eufy state,
   * depleted to 0% battery while unplugged, or unreachable after a wake timeout).
   *
   * @returns {boolean}
   */
  isDeviceOffline() {
    return this.telemetry.isDeviceOffline();
  }

  /**
   * Returns true when any upstream dependency or camera link (eufy-security-ws, HomeBase/camera,
   * Frigate API, or go2rtc API) is currently disconnected or offline.
   *
   * @returns {boolean}
   */
  hasServiceDisruption() {
    return this.telemetry.hasServiceDisruption();
  }

  /**
   * Updates upstream service connectivity flags on this camera's Telemetry model and returns
   * true if any flag or overall service disruption state changed.
   *
   * @param {{
   *   wsConnected?: boolean,
   *   stationConnected?: boolean,
   *   frigateConnected?: boolean,
   *   go2rtcConnected?: boolean,
   * }} [flags={}] - Service health flags.
   * @returns {boolean}
   */
  updateServiceHealth(flags = {}) {
    return this.telemetry.updateServiceHealth(flags);
  }

  /**
   * Resets one-time hardware sync flags (qualityChecked, recordingModeChecked, rtspEnabledChecked)
   * when a HomeBase station P2P link reconnects so dropped property writes and missing rtspStreamUrl
   * values are re-synchronized on the post-connect telemetry refresh.
   */
  resetStationSyncFlags() {
    this.telemetry.qualityChecked = false;
    this.telemetry.recordingModeChecked = false;
    this.rtspEnabledChecked = false;
  }

  /**
   * Returns a concise human-readable reason when the camera is offline, or an empty string when online.
   *
   * @returns {string}
   */
  getOfflineReason() {
    return this.telemetry.getOfflineReason();
  }

  /**
   * Clears any transient wake-timeout or stale offline state when the camera emits a live event or video frame.
   */
  markDeviceOnline() {
    this.telemetry.markDeviceOnline();
  }

  /**
   * Returns true when this camera is configured with sleep_screen: "snapshot" and holds
   * a valid cached snapshot frame in memory that should be seeded to Frigate before stopping
   * the RTSP encoder on startup or Frigate reload while offline.
   *
   * @returns {boolean}
   */
  hasOfflineSnapshotToSeed() {
    return Boolean(this.card.sleepScreen === SLEEP_SCREENS.SNAPSHOT && this.hasValidSnapshotFrame());
  }

  /**
   * Cancels any pending offline snapshot seeding timer on this camera.
   */
  clearOfflineSeedTimer() {
    this.offline.clearSeedTimer();
  }

  /**
   * Returns true while a temporary offline snapshot seed timer is active on this camera.
   *
   * @returns {boolean}
   */
  isSeedingOfflineSnapshot() {
    return this.offline.isSeeding();
  }

  /**
   * Schedules a timer to stop the encoder after seeding the cached snapshot to Frigate while offline.
   *
   * @param {number} seedDurationMs - Duration in milliseconds to stream the cached snapshot before stopping.
   * @param {() => void} onExpire - Callback invoked when the seed window expires.
   */
  scheduleOfflineSeedStop(seedDurationMs, onExpire) {
    this.offline.scheduleSeedStop(seedDurationMs, onExpire);
  }

  /**
   * Called when pollViewers observes that Frigate's FFmpeg consumer has connected to go2rtc
   * while this camera is seeding its offline snapshot: triggers a fresh 15 fps keyframe burst
   * and sets the seed timer to stop postConsumerHoldMs after Frigate connected.
   *
   * @param {number} postConsumerHoldMs - Duration in milliseconds to continue streaming after consumer connects.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean} True if this was the first consumer connection during the active seed window.
   */
  notifyOfflineSeedConsumerConnected(postConsumerHoldMs, now = Date.now()) {
    const holdMs = this.offline.beginConsumerHold(postConsumerHoldMs);
    if (!holdMs) {
      return false;
    }
    this.triggerKeyframeBurst(now, holdMs + SHORT_KEYFRAME_BURST_MS);
    return true;
  }

  /**
   * Tracks whether any go2rtc consumer (such as FFmpeg Frigate or a live viewer) is connected
   * to this camera's stream, triggering an immediate keyframe burst when a consumer first
   * attaches (or re-attaches after offline recovery) and delegating to notifyOfflineSeedConsumerConnected
   * while seeding an offline snapshot.
   *
   * @param {number} consumerCount - Total active go2rtc consumer count.
   * @param {number} [postConsumerHoldMs=SHORT_KEYFRAME_BURST_MS] - Seed hold duration when seeding an offline snapshot.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean} True if a new consumer transition triggered a keyframe burst or seed hold.
   */
  notifyEncoderConsumersObserved(consumerCount, postConsumerHoldMs = SHORT_KEYFRAME_BURST_MS, now = Date.now()) {
    if (consumerCount <= 0) {
      this.encoderConsumerConnected = false;
      return false;
    }
    if (this.isSeedingOfflineSnapshot()) {
      return this.notifyOfflineSeedConsumerConnected(postConsumerHoldMs, now);
    }
    if (this.encoderConsumerConnected) {
      return false;
    }
    this.encoderConsumerConnected = true;
    if (!this.isBackfillPlayback()) {
      this.triggerKeyframeBurst(now, KEYFRAME_BURST_MS);
    }
    return true;
  }

  /**
   * Marks this camera's persistent FFmpeg encoder as intentionally stopped because the camera is offline.
   */
  markEncoderStoppedForOffline() {
    this.offline.markEncoderStopped();
  }

  /**
   * Stops this camera's persistent FFmpeg encoder process with SIGKILL when the camera is offline so
   * go2rtc and Frigate detect the offline RTSP stream without flushing a partial rawvideo frame.
   *
   * @returns {boolean} True if an active encoder process was stopped or newly marked stopped for offline.
   */
  pauseEncoderForOffline() {
    this.encoderConsumerConnected = false;
    const wasAlreadyPaused = this.offline.pause(Boolean(this.enc));
    if (!this.enc) {
      return !wasAlreadyPaused;
    }
    const enc = this.enc;
    this.enc = null;
    if (Camera.canSignalProcess(enc)) {
      try {
        enc.kill(PROCESS_SIGNALS.SIGKILL);
      } catch (err) {
        // Ignore errors when stopping encoder for offline state.
      }
    }
    return true;
  }

  /**
   * Returns true when the camera is back online after its encoder was stopped for an offline state.
   *
   * @returns {boolean}
   */
  shouldResumeOfflineEncoder() {
    return this.offline.isEncoderStopped() && !this.isDeviceOffline();
  }

  /**
   * Clears the offline encoder pause flag when the camera's encoder is restarted.
   *
   * @returns {boolean} True if the encoder had been paused for offline.
   */
  clearEncoderOfflinePause() {
    return this.offline.clearEncoderPause();
  }

  /**
   * Returns true if a live viewer is allowed to wake this camera under its current
   * battery and low_battery_wake_on_view state.
   *
   * @returns {boolean}
   */
  canWakeOnViewerInLowBattery() {
    return !this.isLowBattery() || Boolean(this.telemetry.lowBatWakeOnView);
  }

  /**
   * Returns true if the given Eufy event name is configured to trigger this camera.
   *
   * @param {string} evName - Raw Eufy event name.
   * @returns {boolean}
   */
  shouldTriggerOnEvent(evName) {
    return this.triggers.has(String(evName || '').toLowerCase());
  }

  /**
   * Returns the effective event hold duration in milliseconds for this camera, accounting
   * for per-camera hold_secs and Low-Battery Economy Mode.
   *
   * @returns {number}
   */
  getEventHoldMs() {
    return this.isLowBattery() ? Math.min(this.timers.holdMs, this.timers.lowBatHoldMs) : this.timers.holdMs;
  }

  /**
   * Alias for getEventHoldMs() returning the effective event hold duration in milliseconds.
   *
   * @returns {number}
   */
  getEffectiveHoldMs() {
    return this.getEventHoldMs();
  }

  /**
   * Returns the effective viewer linger duration in milliseconds for this camera.
   *
   * @returns {number}
   */
  getViewLingerMs() {
    return this.timers.lingerMs;
  }

  /**
   * Returns true if this camera is configured for backfill-only motion capture (mode="backfill" or
   * backfill_only=true) and should skip waking for a live stream in favor of HomeBase clip backfill.
   *
   * @returns {boolean}
   */
  shouldBackfillOnlyOnEvent() {
    return Boolean(this.backfillDownloads && this.alwaysBackfill && !this.isActiveLiveSession());
  }

  /**
   * Returns true if an external /api/wake request should stay in backfill-only mode instead of
   * starting or scheduling a live stream (in "backfill" mode while a trigger/backfill is active,
   * or on any backfill-enabled camera during active backfill playback while an unexpired Eufy
   * hardware trigger is recording the new event).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  shouldBackfillOnlyOnApiWake(now = Date.now()) {
    return this.shouldBackfillOnlyOnEvent()
      ? this.hasActiveHardwareTriggers(now) || this.hasPendingBackfill() || this.isBackfillPlayback()
      : Boolean(this.backfillDownloads && this.isBackfillPlayback() && this.hasActiveHardwareTriggers(now));
  }

  /**
   * Returns true if a human Live View connection should be blocked from waking a live stream
   * because the camera is idle with a pending HomeBase BackfillJob.
   *
   * @returns {boolean}
   */
  isViewerBlockedByBackfill() {
    return Boolean(!this.session.active && this.hasPendingBackfill());
  }

  /**
   * Returns true if the camera is currently waiting for a HomeBase backfill clip (while idle with a
   * pending BackfillJob or while handshaking a backfill download before Frame 0 is decoded).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [freshFrameMaxAgeMs=DEFAULT_FRESH_FRAME_MAX_AGE_MS] - Maximum age of a live frame in milliseconds.
   * @returns {boolean}
   */
  isWaitingForBackfill(now = Date.now(), freshFrameMaxAgeMs = DEFAULT_FRESH_FRAME_MAX_AGE_MS) {
    return this.session.active
      ? Boolean(this.isBackfillPlayback() && !this.isStreamingLive(now, freshFrameMaxAgeMs))
      : this.hasPendingBackfill();
  }

  /**
   * Returns true if the camera is configured with an explicit direct `rtsp_url` (no Eufy WS queries).
   *
   * @returns {boolean}
   */
  isRtspDirect() {
    return this.directRtsp;
  }

  /**
   * Returns true if this camera supports external /api/wake triggers (direct rtsp_url cameras do not).
   *
   * @returns {boolean}
   */
  supportsApiWake() {
    return !this.directRtsp;
  }

  /**
   * Returns true if the camera is running a passive background RTSP direct probe before the first frame decodes.
   *
   * @returns {boolean}
   */
  isPassiveRtspDirectProbe() {
    return this.session.isPassiveRtspDirectProbe();
  }

  /**
   * Returns true when this camera has an active session for viewer classification, treating an
   * un-decoded passive direct-RTSP background probe as still connecting rather than actively streaming.
   *
   * @returns {boolean}
   */
  isActivelyStreamingForViewer() {
    return this.isRtspDirect()
      ? Boolean(this.session.active && !this.isPassiveRtspDirectProbe())
      : this.isSessionActive();
  }

  /**
   * Promotes an in-flight passive direct-RTSP background probe into an explicit viewer session
   * without restarting an already-spawned FFmpeg RTSP pull decoder.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean} True if an active passive probe was promoted.
   */
  promotePassiveRtspDirectProbeToViewer(now = Date.now()) {
    return this.session.promotePassiveProbeToViewer(now, this.getViewLingerMs());
  }

  /**
   * Returns true if an idle direct-`rtsp_url` camera should start a direct RTSP pull session now.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [intervalMs] - Minimum interval between passive probes in ms.
   * @returns {boolean}
   */
  shouldStartRtspDirectSession(now = Date.now(), intervalMs = undefined) {
    return this.session.shouldStartRtspDirect(now, Boolean(this.getRtspUrl()), intervalMs);
  }

  /**
   * Transitions an idle direct-`rtsp_url` camera into a passive background RTSP probe session.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   */
  beginRtspDirectProbeSession(now = Date.now()) {
    this.eventActive = false;
    this.session.markRtspDirectProbeMeta();
    this.beginSession(STREAM_MODES.RTSP, now, true);
    this.session.motionUntil = Math.max(this.session.motionUntil, now + this.getEventHoldMs());
  }

  /**
   * Starts an explicit RTSP wake session or passive direct-RTSP probe session when an idle
   * direct-`rtsp_url` camera begins a stream attempt, returning a wake log string when explicitly woken.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  prepareRtspDirectStart(now = Date.now()) {
    if (this.isSessionActive()) {
      return '';
    }
    if (now < this.wantUntil()) {
      return this.beginRtspWakeSession(now);
    }
    this.beginRtspDirectProbeSession(now);
    return '';
  }

  /**
   * Evaluates stop reason, initiator, and service-health transition when a direct-`rtsp_url`
   * stream or probe exits or stalls.
   *
   * @param {number|null} code - FFmpeg exit code or null on timeout/stall.
   * @param {string} [reasonText=''] - Exit stderr line or timeout description.
   * @returns {Readonly<{
   *   stopWhy: string,
   *   stopInitiator: string,
   *   disruptionChanged: boolean,
   *   isReachableStandby: boolean,
   *   statusLog: string,
   * }>}
   */
  evaluateRtspDirectDrop(code, reasonText = '') {
    return this.session.evaluateRtspDirectDrop(code, reasonText, (clarified) =>
      this.recordRtspDirectProbeFailure(clarified)
    );
  }

  /**
   * Updates reachability state after a direct RTSP probe or wake attempt exits without video:
   * RTSP 404 Not Found indicates the RTSP server is reachable in standby (`stationConnected = true`),
   * whereas connection refused/timeout indicates unreachable/powered-off (`stationConnected = false`).
   *
   * @param {string} [lastLine=''] - Last stderr line or failure reason from FFmpeg.
   * @returns {Readonly<{ isReachableStandby: boolean, disruptionChanged: boolean }>}
   */
  recordRtspDirectProbeFailure(lastLine = '') {
    const isReachableStandby = StreamSession.isStandby404(lastLine);
    const disruptionChanged = this.updateServiceHealth({stationConnected: isReachableStandby});
    return Object.freeze({isReachableStandby, disruptionChanged});
  }

  /**
   * Returns true if the camera should display the Yellow "Waiting" (busy) status card (waiting for a
   * station P2P slot, idle with a pending BackfillJob, or handshaking a backfill download before Frame 0).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [freshFrameMaxAgeMs=DEFAULT_FRESH_FRAME_MAX_AGE_MS] - Maximum age of a live frame in milliseconds.
   * @returns {boolean}
   */
  isWaitingForSlotOrBackfill(now = Date.now(), freshFrameMaxAgeMs = DEFAULT_FRESH_FRAME_MAX_AGE_MS) {
    return this.isRtspDirect()
      ? false
      : Boolean(now < this.wantUntil() || this.isWaitingForBackfill(now, freshFrameMaxAgeMs));
  }

  /**
   * Returns true if this camera is currently occupying or holding the P2P slot on stationKey
   * in a way that blocks a HomeBase backfill query or download.
   *
   * @param {string} stationKey - Target station serial key.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} delayMs - Required idle delay after P2P sleep in milliseconds.
   * @param {boolean} [urgentTest=false] - Whether the backfill is an urgent SIGUSR1 test.
   * @returns {boolean}
   */
  isBlockingStationBackfill(stationKey, now, delayMs, urgentTest = false) {
    return this.getStationKey() === stationKey
      ? this.isOccupyingStationP2pChannel() ||
          (!this.isRtspCapable() &&
            (this.wantsWake(now) ||
              (!this.session.active && !urgentTest && now - (this.sessionLifecycle.getSleptAt() || 0) < delayMs)))
      : false;
  }

  /**
   * Returns true if this camera's HomeBase station P2P slot is idle and past the post-sleep
   * backfill delay across all non-RTSP cameras on the same station.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} delayMs - Required idle delay after P2P sleep in milliseconds.
   * @returns {boolean}
   */
  isStationIdleForBackfill(allCams, now, delayMs) {
    const stationKey = this.getStationKey();
    const urgentTest = this.hasUrgentTestBackfill();
    return !allCams.some((other) => other.isBlockingStationBackfill(stationKey, now, delayMs, urgentTest));
  }

  /**
   * Returns true if at least one connected go2rtc consumer is an eligible waking human viewer.
   *
   * @returns {boolean}
   */
  hasWakingViewer() {
    return this.viewerSet.hasWaking();
  }

  /**
   * Returns true if this camera currently has a non-zero viewer hold timestamp or an active waking viewer.
   *
   * @returns {boolean}
   */
  hasPendingViewerWake() {
    return Boolean(this.session.viewUntil > 0 || this.hasWakingViewer());
  }

  /**
   * Clears any pending viewer wake timer on this camera and marks all current go2rtc
   * consumers as ineligible to wake it until they disconnect and reconnect.
   *
   * @param {string} [clearReason=''] - Optional diagnostic context for why the viewer queue was cleared.
   */
  clearViewerQueue(clearReason = '') {
    const hadViewers = this.hasPendingViewerWake();
    this.session.clearViewerHold();
    this.viewerSet.clearWaking();
    if (hadViewers && clearReason) {
      log.debug(this, 'cleared pending viewer wake queue (' + clearReason + ')');
    }
  }

  /**
   * Clears any pending or matched HomeBase backfill clip request on this camera.
   */
  clearPendingBackfill() {
    this.backfill.clearPending();
    if (!this.session.active) {
      this._clearActiveHardwareTriggers();
    }
  }

  /**
   * Returns true if this camera has a pending or matched BackfillJob waiting to be queried or downloaded.
   *
   * @returns {boolean}
   */
  hasPendingBackfill() {
    return this.backfill.hasPending();
  }

  /**
   * Computes the safety-net Backfill cancellation cutoff as 20% of the camera's configured
   * hardware clip or hold duration, clamped to [3000ms..15000ms].
   *
   * @returns {number}
   */
  getSustainedLiveVideoCutoffMs() {
    const clipSecs = this.telemetry.hwRecordingCfg.recordingClipLength;
    const baseMs = typeof clipSecs === 'number' && clipSecs > 0 ? clipSecs * MS_PER_SECOND : this.timers.holdMs;
    return clampNum(
      Math.round(baseMs * SUSTAINED_LIVE_VIDEO_CUTOFF_RATIO),
      MIN_SUSTAINED_LIVE_VIDEO_CUTOFF_MS,
      MAX_SUSTAINED_LIVE_VIDEO_CUTOFF_MS,
      DEFAULT_CANCEL_BACKFILL_VIDEO_MS
    );
  }

  /**
   * Cancels a pending non-test backfill request once live streaming has delivered at least
   * minVideoMs of video or the session runtime has been extended.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [minVideoMs=this.getSustainedLiveVideoCutoffMs()] - Minimum decoded video
   *   duration required to cancel backfill.
   * @returns {boolean} True if a pending backfill job was canceled.
   */
  cancelBackfillIfLiveConfirmed(now, minVideoMs = this.getSustainedLiveVideoCutoffMs()) {
    if (!this.backfill.pending || this.backfill.hasUrgentTest() || this.session.mode === STREAM_MODES.DOWNLOAD) {
      return false;
    }
    const videoStartRef = this.session.firstFrameAt || this.session.firstVideoAt;
    const hasSustainedLiveVideo = videoStartRef > 0 && now - videoStartRef >= minVideoMs;
    if (this.session.runtimeExtended || this.frigateSawObject || hasSustainedLiveVideo) {
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
    return this.backfill.needsObjectCheck(this.frigateSawObject);
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
    const canQueryInState = !this.session.active || Boolean(this.isBackfillPlayback() && this.backfill.finished);
    return this.backfill.canQuery(now, canQueryInState, {minEventAgeMs, queryCooldownMs});
  }

  /**
   * Returns true if this camera's pending or active BackfillJob is settled enough to accept a
   * station-wide database query result without matching an in-progress hardware recording.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [minEventAgeMs] - Minimum event age in milliseconds.
   * @returns {boolean}
   */
  canMatchDatabaseQueryResult(now = Date.now(), minEventAgeMs = undefined) {
    return this.backfill.canMatchQueryResult(now, minEventAgeMs);
  }

  /**
   * Attempts to match a parsed HomeBase database clip candidate against this camera's pending
   * or active BackfillJob, queuing matching clips in chronological order on backfillClipQueue
   * and setting backfillClip to the next clip to download.
   *
   * @param {{ devSn: string, storagePath: string, cipherId: number, clipMs: number }} candidate - Parsed DB row.
   * @returns {boolean} True if matched and queued for download.
   */
  tryMatchBackfillCandidate(candidate) {
    return this.backfill.tryMatchCandidate(candidate);
  }

  /**
   * Formats a structured log line when a HomeBase database record matches a pending or active BackfillJob.
   *
   * @param {{ storagePath: string, cipherId: number, clipMs?: number }} candidate - Matched DB row.
   * @returns {string}
   */
  formatBackfillClipMatchLog(candidate) {
    return this.backfill.formatClipMatchLog(candidate);
  }

  /**
   * Returns true if the camera is currently active in the given sessionId (and optional mode).
   *
   * @param {number} sessionId - Expected session identifier.
   * @param {string} [mode=''] - Optional expected activeMode ('rtsp', 'p2p', 'download').
   * @returns {boolean}
   */
  isCurrentSession(sessionId, mode = '') {
    return this.session.isCurrent(sessionId, mode);
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
    return this.session.isActiveDecoder(dec, sessionId, mode);
  }

  /**
   * Returns true if the camera is active and ready to ingest incoming P2P/download A/V packets.
   *
   * @returns {boolean}
   */
  canIngestP2pPacket() {
    return this.session.canIngestP2pPacket();
  }

  /**
   * Returns true if incoming stream dimensions differ from the current session dimensions.
   *
   * @param {number} width - Incoming packet width.
   * @param {number} height - Incoming packet height.
   * @returns {boolean}
   */
  hasResolutionChanged(width, height) {
    return this.session.hasResolutionChanged(width, height);
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
    if (!this.isStartupProbe || !this.session.firstFrameAt || now - this.session.firstFrameAt < minCaptureMs) {
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
    if (!this.session.active) {
      return Boolean(this.backfill.continuation && this.hasPendingBackfill() && Buffer.isBuffer(this.lastFrame));
    }
    return Boolean(
      this.hasFreshFrame(now, freshFrameMaxAgeMs) ||
      (this.session.firstFrameAt > 0 && this.session.gotVideo && Buffer.isBuffer(this.lastFrame)) ||
      (this.isBackfillPlayback() && this.backfill.continuation && Buffer.isBuffer(this.lastFrame))
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
      this.session.active &&
      (this.hasFreshFrame(now, freshFrameMs) ||
        (this.eventFiling.dispatchedAt > 0 && this.session.gotVideo && Buffer.isBuffer(this.lastFrame))) &&
      this.session.firstFrameAt > 0 &&
      now - this.session.firstFrameAt >= requiredDelayMs;
    const hasRecentCompletedVideo =
      INSTANT_EVENT_SNAPSHOT &&
      !this.session.active &&
      this.session.gotVideo &&
      now - this.session.lastVideoAt < recentFallbackMs;
    return Boolean(hasSustainedLiveVideo || hasRecentCompletedVideo);
  }

  /**
   * Returns true if the camera is already active in a live-view session.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isActivelyViewing(now = Date.now()) {
    return this.session.isActivelyViewing(now);
  }

  /**
   * Returns true if the camera recently went to sleep and is within the viewer cooldown window.
   * Cooldown is bypassed when the camera has active hardware triggers (Eufy motion/AI events).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isInViewerCooldown(now = Date.now()) {
    return this.isRtspDirect() || this.hasActiveHardwareTriggers(now)
      ? false
      : this.getSessionState(now) === SESSION_STATES.COOLDOWN || now - this.sessionLifecycle.getSleptAt() < COOLDOWN_MS;
  }

  /**
   * Returns true while an asynchronous Frigate object-detection poll for hold extension is in flight.
   *
   * @returns {boolean}
   */
  isExtendCheckInFlight() {
    return Boolean(this.extendCheckInFlight);
  }

  /**
   * Marks whether an asynchronous Frigate object-detection poll for hold extension is in flight.
   *
   * @param {boolean} inFlight - True while awaiting Frigate /api/events.
   */
  setExtendCheckInFlight(inFlight) {
    this.extendCheckInFlight = Boolean(inFlight);
  }

  /**
   * Evaluates whether an active live session is due for a Frigate object-detection poll
   * (either to extend the hold near timeout or to confirm live capture for backfill cancellation).
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [checkWindowMs=DEFAULT_HOLD_EXTEND_WINDOW_MS] - Hold-extension check window in ms.
   * @param {number} [safetyMarginMs=DEFAULT_HOLD_SAFETY_MARGIN_MS] - Safety buffer before MAX_MS.
   * @param {number} [pollCooldownMs=DEFAULT_FRIGATE_POLL_COOLDOWN_MS] - Minimum interval between Frigate polls.
   * @returns {Readonly<{ shouldPoll: boolean, needsTimeoutExtendCheck: boolean }>}
   */
  shouldPollFrigateForHoldOrBackfill(
    now,
    checkWindowMs = DEFAULT_HOLD_EXTEND_WINDOW_MS,
    safetyMarginMs = DEFAULT_HOLD_SAFETY_MARGIN_MS,
    pollCooldownMs = DEFAULT_FRIGATE_POLL_COOLDOWN_MS
  ) {
    const canEvaluate = Boolean(
      !this.isRtspDirect() &&
      this.session.active &&
      this.session.gotVideo &&
      !this.extendCheckInFlight &&
      this.session.mode !== STREAM_MODES.DOWNLOAD &&
      !this.isStartupProbe
    );
    if (!canEvaluate) {
      return NO_FRIGATE_POLL;
    }
    this.getFrigateEventState(now);
    const holdUntil = this.wantUntil();
    const nearMaxLimit = now - this.session.startedAt >= this.timers.maxMs - safetyMarginMs;
    const nearHoldExpiry = holdUntil - now <= checkWindowMs;
    const nearEventExpiry = Boolean(
      this.eventActive &&
      !this.eventFiling.hasPendingDispatch() &&
      this.eventFiling.until > this.session.startedAt &&
      this.eventFiling.until - now <= checkWindowMs
    );
    const needsTimeoutExtendCheck = (nearHoldExpiry || nearEventExpiry) && !nearMaxLimit;
    if (!needsTimeoutExtendCheck && !this.needsBackfillObjectCheck()) {
      return NO_FRIGATE_POLL;
    }
    const isFinalExpiryCheck = Boolean(
      needsTimeoutExtendCheck && now >= holdUntil && (this.lastExtendCheckAt || 0) < holdUntil
    );
    if (!isFinalExpiryCheck && now - (this.lastExtendCheckAt || 0) < pollCooldownMs) {
      return NO_FRIGATE_POLL;
    }
    this.lastExtendCheckAt = now;
    return Object.freeze({shouldPoll: true, needsTimeoutExtendCheck});
  }

  /**
   * Returns true if the camera is currently active in a motion-only session without an active viewer.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isMotionOnlyActiveSession(now = Date.now()) {
    return this.session.isMotionOnlyActive(now);
  }

  /**
   * Returns true if a motion-woken camera has remained quiet past the early-sleep threshold
   * after Frigate confirms no active objects.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [minEventVideoMs=DEFAULT_MIN_EVENT_VIDEO_MS] - Minimum event video duration in milliseconds.
   * @returns {boolean}
   */
  canSleepEarlyOnIdle(now = Date.now(), minEventVideoMs = DEFAULT_MIN_EVENT_VIDEO_MS) {
    return Boolean(
      !this.isRtspDirect() &&
      this.timers.earlySleepMs > 0 &&
      this.isMotionOnlyActiveSession(now) &&
      now - this.session.lastMotionAt >= Math.min(this.timers.earlySleepMs, minEventVideoMs)
    );
  }

  /**
   * Returns true if an active session has already received video and a subsequent start event
   * arrived after the mid-stream retrigger grace window.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [graceMs=DEFAULT_MID_STREAM_GRACE_MS] - Grace window in milliseconds.
   * @returns {boolean}
   */
  isMidStreamRetrigger(now = Date.now(), graceMs = DEFAULT_MID_STREAM_GRACE_MS) {
    return this.session.isMidStreamRetrigger(now, graceMs);
  }

  /**
   * Evaluates whether an active motion-woken camera is due for an early-sleep Frigate idle check.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [pollIntervalMs=DEFAULT_EARLY_SLEEP_POLL_MS] - Minimum interval between Frigate idle polls.
   * @param {number} [settleMs=DEFAULT_EARLY_SLEEP_SETTLE_MS] - Settle delay after Eufy reports activity cleared.
   * @returns {{ due: boolean, clearedByEufy: boolean }}
   */
  checkEarlySleepDue(now, pollIntervalMs = DEFAULT_EARLY_SLEEP_POLL_MS, settleMs = DEFAULT_EARLY_SLEEP_SETTLE_MS) {
    const earlySleepMs = this.timers.earlySleepMs;
    if (this.isRtspDirect() || earlySleepMs <= 0 || !this.isMotionOnlyActiveSession(now)) {
      return {due: false, clearedByEufy: false};
    }
    if (!this.session.gotVideo || now - this.session.firstVideoAt < earlySleepMs) {
      return {due: false, clearedByEufy: false};
    }
    if (now - this.lastEarlySleepCheckAt < pollIntervalMs) {
      return {due: false, clearedByEufy: false};
    }
    const clearedByEufy =
      this.session.motionClearedAt > this.session.lastMotionAt && now - this.session.motionClearedAt >= settleMs;
    const elapsedQuiet = now - this.session.lastMotionAt >= earlySleepMs;
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
    return this.session.isRtspDecoderHandshaking(now, minActiveMs, maxStallMs);
  }

  /**
   * Returns true if Eufy cleanly ended an active event livestream when end_early is enabled.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minCleanVideoMs - Minimum decoded video duration before honoring Eufy stop.
   * @returns {boolean}
   */
  didEufyEndEventCleanly(now, minCleanVideoMs) {
    return Boolean(
      this.session.active &&
      this.eventActive &&
      this.timers.letEufyDecideEnd &&
      this.session.gotVideo &&
      now >= this.session.viewUntil &&
      (this.session.motionClearedAt > this.session.lastMotionAt || now - this.session.firstVideoAt >= minCleanVideoMs)
    );
  }

  /**
   * Returns the camera's latest Wi-Fi RSSI in dBm, or null if unknown.
   *
   * @returns {number|null}
   */
  getRssi() {
    return this.telemetry.rssi;
  }

  /**
   * Returns true while a P2P stop_livestream command (or wedged-radio stop pulse) is in flight.
   *
   * @returns {boolean}
   */
  isStoppingP2p() {
    return Boolean(this.stoppingP2p);
  }

  /**
   * Marks that a P2P stop_livestream command is currently in flight.
   */
  markP2pStopInFlight() {
    this.stoppingP2p = true;
  }

  /**
   * Clears the in-flight P2P stop flag once device.stop_livestream and its settle window complete.
   */
  clearP2pStopInFlight() {
    this.stoppingP2p = false;
  }

  /**
   * Returns true if experimental stuck-spotlight tracking is enabled for this camera.
   *
   * @returns {boolean}
   */
  hasStuckSpotlightTracking() {
    return this.trackStuckSpotlight;
  }

  /**
   * Returns true if experimental stuck-spotlight tracking is enabled and the spotlight has stayed on past idleGraceMs.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [idleGraceMs=STUCK_LIGHT_GRACE_MS] - Required spotlight-on grace duration in milliseconds.
   * @returns {boolean}
   */
  hasStuckIdleLightPastGrace(now = Date.now(), idleGraceMs = STUCK_LIGHT_GRACE_MS) {
    const lightOnAt = this.telemetry.lightOnAt || 0;
    return this.hasStuckSpotlightTracking() && this.telemetry.isLightOn()
      ? lightOnAt <= 0 || now < lightOnAt || now - lightOnAt > idleGraceMs
      : false;
  }

  /**
   * Records a wifiRssi property change while the camera is idle and returns true if repeated
   * idle RSSI updates (>= 4 within 60s, > 15s after a completed session's sleep) indicate a
   * wedged-awake P2P radio on HomeBase that needs a single forced stop_livestream pulse.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  recordIdleRssiChange(now = Date.now()) {
    const stoppedRef = Math.max(this.sessionLifecycle.getSleptAt() || 0, this.session.lastStoppedAt || 0);
    const isBackfillRecording = Boolean(this.backfill.pending && this.backfill.pending.isRecordingActive());
    const hasStuckIdleLight = this.hasStuckIdleLightPastGrace(now);
    if (
      (this.isRtspCapable() && !hasStuckIdleLight) ||
      this.isSessionActive() ||
      this.stoppingP2p ||
      this.hasActiveHardwareTriggers(now) ||
      isBackfillRecording ||
      (stoppedRef <= 0 && !hasStuckIdleLight) ||
      (stoppedRef > 0 && this.lastWedgedRadioStopAt >= stoppedRef && !hasStuckIdleLight) ||
      (stoppedRef > 0 && now - stoppedRef <= IDLE_WEDGED_MIN_STOPPED_MS) ||
      now - this.lastWedgedRadioStopAt < IDLE_WEDGED_STOP_COOLDOWN_MS
    ) {
      this.idleRssiChangeCount = 0;
      this.idleRssiWindowStartAt = 0;
      return false;
    }
    if (!this.idleRssiWindowStartAt || now - this.idleRssiWindowStartAt > IDLE_WEDGED_RSSI_WINDOW_MS) {
      this.idleRssiWindowStartAt = now;
      this.idleRssiChangeCount = 1;
      return false;
    }
    this.idleRssiChangeCount++;
    if (this.idleRssiChangeCount >= IDLE_WEDGED_RSSI_THRESHOLD) {
      this.idleRssiChangeCount = 0;
      this.idleRssiWindowStartAt = 0;
      this.lastWedgedRadioStopAt = now;
      return true;
    }
    return false;
  }

  /**
   * Returns true if a camera in "backfill" mode can piggyback on an external P2P 'livestream started'
   * event (i.e. no Eufy motion/AI/ring hardware trigger or pending BackfillJob is active on this camera).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  canPiggybackExternalP2pInBackfill(now = Date.now()) {
    return Boolean(!this.hasActiveHardwareTriggers(now) && !this.hasPendingBackfill());
  }

  /**
   * Returns true if the current session is a passive external P2P piggyback on a "backfill"
   * camera with no connected Frigate human viewer.
   *
   * @returns {boolean}
   */
  isPiggybackedExternalSession() {
    return Boolean(
      this.session.active &&
      this.alwaysBackfill &&
      this.session.initiator === EXTERNAL_WAKE_INITIATOR &&
      !this.hasWakingViewer()
    );
  }

  /**
   * Returns true while an inactive camera is still inside its post-sleep guard window
   * (or while device.stop_livestream is still in flight), suppressing trailing stream-start events.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [guardMs=DEFAULT_UNSOLICITED_VIDEO_DELAY_MS] - Post-stop guard window in milliseconds.
   * @returns {boolean}
   */
  isWithinPostSleepGuard(now, guardMs = DEFAULT_UNSOLICITED_VIDEO_DELAY_MS) {
    if (this.session.active) {
      return false;
    }
    const stoppedRef = Math.max(this.sessionLifecycle.getSleptAt() || 0, this.session.lastStoppedAt || 0);
    return Boolean(this.stoppingP2p || (stoppedRef > 0 && now - stoppedRef <= guardMs));
  }

  /**
   * Returns true if an inactive camera is outside the post-sleep guard window and eligible
   * to adopt an externally initiated stream from eufy-security-ws.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [guardMs=DEFAULT_UNSOLICITED_VIDEO_DELAY_MS] - Post-stop guard window in milliseconds.
   * @returns {boolean}
   */
  canAdoptExternalWake(now, guardMs = DEFAULT_UNSOLICITED_VIDEO_DELAY_MS) {
    const allowedInMode = !this.alwaysBackfill || this.canPiggybackExternalP2pInBackfill(now);
    return !this.session.active && allowedInMode ? !this.isWithinPostSleepGuard(now, guardMs) : false;
  }

  /**
   * Adopts an externally initiated P2P livestream from eufy-security-ws when outside guardMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [guardMs=DEFAULT_UNSOLICITED_VIDEO_DELAY_MS] - Post-stop guard window in milliseconds.
   * @returns {boolean} True if adopted and transitioned to active P2P session.
   */
  adoptExternalP2pWake(now, guardMs = DEFAULT_UNSOLICITED_VIDEO_DELAY_MS) {
    if (!this.canAdoptExternalWake(now, guardMs)) {
      return false;
    }
    this.cancelStartupProbe();
    this.session.reason = EXTERNAL_P2P_WAKE_REASON;
    this.session.initiator = EXTERNAL_WAKE_INITIATOR;
    this.session.lastMotionAt = now;
    this.session.motionUntil = Math.max(this.session.motionUntil, now + this.getEventHoldMs());
    this.session.viewSince = now;
    this.session.viewUntil = Math.max(this.session.viewUntil, now + this.timers.holdMs);
    this.eventActive = true;
    this.beginSession(STREAM_MODES.P2P, now, true);
    return true;
  }

  /**
   * Adopts an externally initiated RTSP livestream from eufy-security-ws when outside guardMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [guardMs=DEFAULT_UNSOLICITED_VIDEO_DELAY_MS] - Post-stop guard window in milliseconds.
   * @returns {boolean} True if adopted and transitioned to active RTSP session.
   */
  adoptExternalRtspWake(now, guardMs = DEFAULT_UNSOLICITED_VIDEO_DELAY_MS) {
    if (this.alwaysBackfill || !this.isRtspCapable() || !this.canAdoptExternalWake(now, guardMs)) {
      return false;
    }
    this.cancelStartupProbe();
    this.session.reason = EXTERNAL_RTSP_WAKE_REASON;
    this.session.initiator = EXTERNAL_WAKE_INITIATOR;
    this.session.lastMotionAt = now;
    this.session.motionUntil = Math.max(this.session.motionUntil, now + this.getEventHoldMs());
    this.session.viewSince = now;
    this.session.viewUntil = Math.max(this.session.viewUntil, now + this.timers.holdMs);
    this.eventActive = true;
    this.beginSession(STREAM_MODES.RTSP, now, true);
    return true;
  }

  /**
   * Evaluates whether unsolicited P2P video packets arriving while inactive should trigger
   * a forced stop_livestream, updating lastUnsolicitedStopAt when true.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [delayMs=DEFAULT_UNSOLICITED_VIDEO_DELAY_MS] - Minimum delay since last stop
   *   and last unsolicited stop.
   * @returns {{ shouldStop: boolean, sleptAgo: string }}
   */
  shouldStopUnsolicitedVideo(now, delayMs = DEFAULT_UNSOLICITED_VIDEO_DELAY_MS) {
    const stoppedRef = Math.max(this.sessionLifecycle.getSleptAt() || 0, this.session.lastStoppedAt || 0);
    if (now - stoppedRef <= delayMs || now - this.lastUnsolicitedStopAt <= delayMs) {
      return {shouldStop: false, sleptAgo: '0s'};
    }
    this.lastUnsolicitedStopAt = now;
    const sleptAgo = stoppedRef ? Math.round((now - stoppedRef) / 1000) + 's' : 'never';
    return {shouldStop: true, sleptAgo};
  }

  /**
   * Returns true if the active live stream has reached the hard max_secs limit.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasReachedMaxDuration(now) {
    return this.session.hasReachedMaxDuration(now);
  }

  /**
   * Returns true if a viewer-only stream has reached the view_max_secs limit.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  hasReachedViewMaxDuration(now) {
    return this.session.hasReachedViewMaxDuration(now);
  }

  /**
   * Returns true if the camera has buffered backfill download frames waiting to be encoded.
   *
   * @returns {boolean}
   */
  hasBufferedDownloadFrames() {
    return Boolean(this.isBackfillPlayback() && this.backfill.frames.length > 0);
  }

  /**
   * Returns true if the camera is replaying a buffered backfill download and enough time has
   * elapsed since lastWrite to advance to the next frame without overwriting an unencoded frame.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} frameIntervalMs - Minimum interval between download frames in milliseconds.
   * @returns {boolean}
   */
  canAdvanceDownloadFrame(now, frameIntervalMs) {
    return Boolean(this.hasBufferedDownloadFrames() && !this.frameNew && now - this.lastWrite >= frameIntervalMs);
  }

  /**
   * Returns true if an incoming decoded live video frame arrived during an active encoder write
   * or within the minimum frame pacing interval so it should be queued in liveFrames rather than
   * overwriting this.frame in place.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [minIntervalMs=DEFAULT_LIVE_FRAME_PACE_MS] - Minimum interval between live frame writes in ms.
   * @returns {boolean}
   */
  shouldBufferLiveFrame(now = Date.now(), minIntervalMs = DEFAULT_LIVE_FRAME_PACE_MS) {
    if (
      !this.session.active ||
      this.isBackfillPlayback() ||
      !this.hasWritableEncoderStdin() ||
      !this.session.firstFrameAt ||
      !this.frame
    ) {
      return false;
    }
    return Boolean(
      this.frameNew ||
      this.isEncoderStdinBackpressured() ||
      this.liveFrames.length > 0 ||
      now - this.lastWrite < minIntervalMs
    );
  }

  /**
   * Buffers a decoded live video frame during a multi-frame Wi-Fi/TCP burst so intermediate
   * frames are paced out at LIVE_FPS instead of being overwritten and dropped while the encoder
   * stdin pipe is draining.
   *
   * @param {Uint8Array} rawBuf - Raw decoded YUV420p frame buffer.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {string} [lastSeenHm=''] - Formatted HH:MM timestamp string.
   * @param {number} [maxBurstFrames=MAX_LIVE_BURST_FRAMES] - Maximum burst frames to retain.
   * @returns {boolean} True if buffered in liveFrames, false if caller should commit immediately.
   */
  bufferLiveFrame(rawBuf, now = Date.now(), lastSeenHm = '', maxBurstFrames = MAX_LIVE_BURST_FRAMES) {
    if (!this.shouldBufferLiveFrame(now)) {
      return false;
    }
    if (this.liveFrames.length >= maxBurstFrames) {
      const dropped = this.liveFrames.shift();
      this.session.droppedFrames++;
      if (Buffer.isBuffer(dropped) && this.downloadFramePool.length < DOWNLOAD_POOL_MAX_BUFFERS) {
        this.downloadFramePool.push(dropped);
      }
    }
    const frameCopy = this.acquireDownloadFrameBuffer(rawBuf);
    this.liveFrames.push(frameCopy);
    this.frameAt = now;
    this.session.lastVideoAt = now;
    if (lastSeenHm) {
      this.telemetry.updateLastSeen(lastSeenHm);
    }
    return true;
  }

  /**
   * Returns true if the camera has buffered live burst frames and enough time has elapsed
   * since lastWrite to advance to the next frame without overwriting an unencoded frame.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} frameIntervalMs - Minimum interval between live frames in milliseconds.
   * @returns {boolean}
   */
  canAdvanceLiveFrame(now, frameIntervalMs) {
    return Boolean(
      this.isActiveLiveSession() &&
      this.liveFrames.length > 0 &&
      !this.frameNew &&
      now - this.lastWrite >= frameIntervalMs
    );
  }

  /**
   * Advances the buffered live burst frame queue by one frame when due, recycling the previous
   * pooled buffer into downloadFramePool.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [frameIntervalMs=DEFAULT_LIVE_FRAME_PACE_MS] - Minimum interval between live frames in ms.
   * @param {string} [lastSeenHm=''] - Formatted HH:MM timestamp string.
   * @returns {Uint8Array|null} Newly committed live frame buffer or null if not advanced.
   */
  consumeNextLiveFrame(now, frameIntervalMs = DEFAULT_LIVE_FRAME_PACE_MS, lastSeenHm = '') {
    if (!this.canAdvanceLiveFrame(now, frameIntervalMs)) {
      return null;
    }
    const prevFrame = this.frame;
    const nextBuf = this.liveFrames.shift();
    if (
      Buffer.isBuffer(prevFrame) &&
      prevFrame !== nextBuf &&
      (!this.liveFrameRing || (prevFrame !== this.liveFrameRing[0] && prevFrame !== this.liveFrameRing[1])) &&
      this.downloadFramePool.length < DOWNLOAD_POOL_MAX_BUFFERS
    ) {
      this.downloadFramePool.push(prevFrame);
    }
    this.frame = nextBuf;
    this.frameAt = now;
    this.session.lastVideoAt = now;
    this.frameNew = true;
    this.lastFrame = nextBuf;
    if (lastSeenHm) {
      this.telemetry.updateLastSeen(lastSeenHm);
    }
    return nextBuf;
  }

  /**
   * Returns true if the camera is configured for RTSP and needs its rtspStream property
   * enabled on the HomeBase via eufy-security-ws.
   *
   * @param {*} rtspStreamProp - Current rtspStream property value from eufy-security-ws.
   * @returns {boolean}
   */
  shouldEnableRtspProperty(rtspStreamProp) {
    if (this.isDoorbell()) {
      this.rtspSupported = false;
      return false;
    }
    if (typeof rtspStreamProp === 'boolean') {
      this.rtspSupported = true;
    }
    if (this.useRtsp && (this.rtspUrl || this.rtspSupported) && !this.rtspEnabledChecked && rtspStreamProp === false) {
      this.rtspEnabledChecked = true;
      return true;
    }
    return false;
  }

  /**
   * Returns true if the camera has RTSP disabled in its bridge mode (such as 'p2p') or is a
   * non-RTSP doorbell while rtspStream is still enabled on the Eufy camera hardware and power sync is enabled.
   *
   * @param {*} rtspStreamProp - Current rtspStream property value from eufy-security-ws.
   * @returns {boolean}
   */
  shouldDisableRtspProperty(rtspStreamProp) {
    if (
      (!this.useRtsp || this.isDoorbell()) &&
      this.telemetry.hwRecordingCfg.powerWorkingMode !== null &&
      !this.rtspEnabledChecked &&
      rtspStreamProp === true
    ) {
      this.rtspEnabledChecked = true;
      if (this.isDoorbell()) {
        this.rtspSupported = false;
      }
      return true;
    }
    return false;
  }

  /**
   * Evaluates whether an incoming 'rtsp livestream started' event arrived while the camera is not
   * in an active RTSP session, marking unexpectedRtspActive and returning whether the orchestrator
   * should stop the hardware RTSP stream, disable the rtspStream property, and restart P2P wake.
   *
   * @returns {Readonly<{ shouldStopRtsp: boolean, shouldDisableRtspProp: boolean, shouldRestartP2p: boolean }>}
   */
  evaluateUnexpectedRtspStart() {
    if (
      this.unexpectedRtspActive ||
      this.isBackfillPlayback() ||
      this.isCurrentSession(this.session.id, STREAM_MODES.RTSP) ||
      (this.isCurrentSession(this.session.id, STREAM_MODES.P2P) && this.session.gotVideo) ||
      (this.useRtsp && !this.isDoorbell() && !this.isCurrentSession(this.session.id, STREAM_MODES.P2P))
    ) {
      return Object.freeze({
        shouldStopRtsp: false,
        shouldDisableRtspProp: false,
        shouldRestartP2p: false,
      });
    }
    this.unexpectedRtspActive = true;
    if (!this.rtspUrl) {
      this.rtspSupported = false;
    }
    const shouldDisableRtspProp = Boolean(
      this.telemetry.hasPowerConservationEnabled() && (!this.useRtsp || !this.rtspUrl || this.isDoorbell())
    );
    const shouldRestartP2p = Boolean(
      this.isCurrentSession(this.session.id, STREAM_MODES.P2P) && !this.session.gotVideo
    );
    return Object.freeze({shouldStopRtsp: true, shouldDisableRtspProp, shouldRestartP2p});
  }

  /**
   * Returns true when the camera is idle with no active session, hardware trigger, or BackfillJob, experimental
   * stuck-spotlight tracking is enabled, and the spotlight (light=true) has stayed on past idleGraceMs (default 130s).
   * The grace runs from the later of the last session/motion activity and the moment the light turned on, so a
   * light that motion has just switched on (or that a hardware clip is still using) is never judged stuck.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [idleGraceMs=STUCK_LIGHT_GRACE_MS] - Required idle grace duration in milliseconds.
   * @returns {boolean}
   */
  shouldTurnOffStuckIdleLight(now = Date.now(), idleGraceMs = STUCK_LIGHT_GRACE_MS) {
    const lastActiveAt = Math.max(
      this.sessionLifecycle.getSleptAt() || 0,
      this.session.lastStoppedAt || 0,
      this.session.motionClearedAt || 0,
      this.session.lastMotionAt || 0,
      this.telemetry.lightOnAt || 0
    );
    if (
      this.hasStuckSpotlightTracking() &&
      this.telemetry.isLightOn() &&
      !this.isSessionActive() &&
      !this.stoppingP2p &&
      !this.hasActiveHardwareTriggers(now) &&
      !this.hasPendingBackfill() &&
      !this.isBackfillPlayback() &&
      lastActiveAt > 0 &&
      now - lastActiveAt > idleGraceMs
    ) {
      this.telemetry.clearLightOn();
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
      this.isActiveRtspSession() &&
      !this.session.gotVideo &&
      now - this.session.startedAt < windowMs &&
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
    const stationKey = this.getStationKey();
    return this.needsStartupSnapshot && !this.isLowBattery() && !this.isDeviceOffline()
      ? !allCams.some(
          (other) => other.getStationKey() === stationKey && (other.isSessionActive() || other.wantsWake(now))
        )
      : false;
  }

  /**
   * Returns the bounding box { boxX, boxY, boxW, boxH } of this camera's corner status card.
   *
   * @returns {{ boxX: number, boxY: number, boxW: number, boxH: number }|null}
   */
  getCardBounds() {
    return this.card.getBounds(this.telemetry);
  }

  /**
   * Computes the normalized Frigate mask polygon string for this camera's corner status card.
   *
   * @returns {string}
   */
  computeMaskPolygon() {
    return this.card.computeMaskPolygon(this.telemetry);
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
    this.backfill.prepareSigUsr1Test(now);
    if (!this.session.active) {
      this._clearActiveHardwareTriggers();
    }
  }

  /**
   * Returns true if this camera should stop its non-motion P2P session to yield the slot for a SIGUSR1 backfill test.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  shouldStopForSigUsr1Test(now = Date.now()) {
    return Boolean(this.usesP2pSlot() && !this.isInMotion(now));
  }

  /**
   * Returns true if this camera is an inactive non-RTSP camera whose viewer queue should be cleared on SIGUSR1 test.
   *
   * @returns {boolean}
   */
  shouldClearQueueForSigUsr1Test() {
    return Boolean(!this.session.active && !this.isRtspCapable());
  }

  /**
   * Formats the concise camera mode/hold entry for the startup banner log.
   *
   * @returns {string}
   */
  formatStartupSummary() {
    if (this.directRtsp) {
      return this.name + '(rtsp:direct)';
    }
    return this.name + '(' + this.mode + ':' + Math.round(this.timers.holdMs / MS_PER_SECOND) + 's)';
  }

  /**
   * Returns true if this camera is idle, has a matched HomeBase clip ready to download,
   * and is past any post-failure download retry cooldown.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [retryCooldownMs] - Cooldown after a failed download attempt in ms.
   * @returns {boolean}
   */
  isReadyForBackfillDownload(now = Date.now(), retryCooldownMs = undefined) {
    return this.backfill.isReadyForDownload(now, this.session.active, retryCooldownMs);
  }

  /**
   * Returns true if this camera has a pending BackfillJob that still needs a HomeBase
   * station.database_query_latest_info fallback query (including while draining a previous clip tail).
   *
   * @returns {boolean}
   */
  needsLatestInfoBackfillQuery() {
    return this.backfill.needsLatestInfoQuery();
  }

  /**
   * Returns true if this camera has a matched backfill clip ready to download and its station's P2P slot is idle.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} delayMs - Required idle delay after P2P sleep in milliseconds.
   * @param {number} [retryCooldownMs] - Cooldown after a failed download attempt in ms.
   * @returns {boolean}
   */
  canStartBackfillDownloadNow(allCams, now, delayMs, retryCooldownMs = undefined) {
    return Boolean(
      this.isReadyForBackfillDownload(now, retryCooldownMs) && this.isStationIdleForBackfill(allCams, now, delayMs)
    );
  }

  /**
   * Returns true if this camera is ready to query HomeBase for a backfill clip and its station's P2P slot is idle.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minEventAgeMs - Minimum age of the trigger event before querying HomeBase.
   * @param {number} queryCooldownMs - Minimum interval between database queries on the same station.
   * @param {number} delayMs - Required idle delay after P2P sleep in milliseconds.
   * @returns {boolean}
   */
  canQueryBackfillNow(allCams, now, minEventAgeMs, queryCooldownMs, delayMs) {
    return Boolean(
      this.canQueryBackfill(now, minEventAgeMs, queryCooldownMs) &&
      !this.hasRecentStationBackfillQuery(allCams, now, queryCooldownMs) &&
      this.isStationIdleForBackfill(allCams, now, delayMs)
    );
  }

  /**
   * Returns true if this camera is ready to query HomeBase for a backfill clip and its station is
   * both P2P-idle and past the station-level query cooldown timestamp.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {{
   *   now: number,
   *   minEventAgeMs: number,
   *   queryCooldownMs: number,
   *   delayMs: number,
   *   stationLastQueryAt: number,
   * }} timing - Backfill query timing thresholds and station last-query timestamp.
   * @returns {boolean}
   */
  canQueryStationBackfill(allCams, timing) {
    const stationCooledDown =
      this.hasUrgentTestBackfill() ||
      !timing.stationLastQueryAt ||
      timing.now - timing.stationLastQueryAt >= timing.queryCooldownMs;
    return stationCooledDown
      ? this.canQueryBackfillNow(allCams, timing.now, timing.minEventAgeMs, timing.queryCooldownMs, timing.delayMs)
      : false;
  }

  /**
   * Returns true when a completed backfill download session prepared an immediate split-clip
   * follow-up query (`followUpQueried && lastBackfillQueryAt === 0`) that bypasses station query cooldown.
   *
   * @param {string} closedMode - Stream mode that just ended.
   * @returns {boolean}
   */
  shouldClearStationQueryCooldownAfterStop(closedMode) {
    return this.backfill.shouldClearStationQueryCooldown(closedMode);
  }

  /**
   * Returns the effective priority of this camera's pending or active BackfillJob (or 0 if none).
   *
   * @returns {number}
   */
  getBackfillPriority() {
    return this.backfill.getPriority();
  }

  /**
   * Returns true if this camera's discovered stationSerial is a HomeBase 3 (T8030).
   *
   * @returns {boolean}
   */
  hasHomeBase3Station() {
    return Boolean(this.stationSerial && this.stationSerial.startsWith(HOMEBASE_3_SERIAL_PREFIX));
  }

  /**
   * Resolves the HomeBase station serial number for database queries, falling back to any
   * discovered T8030 HomeBase 3 or other station in allCams.
   *
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @returns {string}
   */
  resolveHomeBaseStationSerial(allCams = []) {
    return (
      this.stationSerial ||
      allCams.find((c) => c.hasHomeBase3Station())?.stationSerial ||
      allCams.find((c) => Boolean(c.stationSerial))?.stationSerial ||
      ''
    );
  }

  /**
   * Resolves the canonical HomeBase station key used to serialize and pace backfill queries and
   * downloads across cameras sharing the same HomeBase.
   *
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @returns {string}
   */
  resolveStationBackfillKey(allCams = []) {
    return this.resolveHomeBaseStationSerial(allCams) || this.getStationKey();
  }

  /**
   * Returns true if this camera maps to the given HomeBase backfill station key.
   *
   * @param {string} stationKey - Target HomeBase backfill station key.
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @returns {boolean}
   */
  hasStationBackfillKey(stationKey, allCams = []) {
    return this.resolveStationBackfillKey(allCams) === stationKey;
  }

  /**
   * Returns true if this camera is a non-direct-RTSP camera belonging to stationKey's backfill queue.
   *
   * @param {string} stationKey - Target HomeBase backfill station key.
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @returns {boolean}
   */
  isStationBackfillMember(stationKey, allCams = []) {
    return !this.isRtspDirect() ? this.hasStationBackfillKey(stationKey, allCams) : false;
  }

  /**
   * Returns true if this camera maps to stationKey and dispatched a HomeBase backfill query within queryCooldownMs.
   *
   * @param {string} stationKey - Target HomeBase backfill station key.
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {{ now: number, queryCooldownMs: number }} window - Current timestamp and station query cooldown in ms.
   * @returns {boolean}
   */
  isPacingStationBackfillQuery(stationKey, allCams, window) {
    return this.hasStationBackfillKey(stationKey, allCams) && this.backfill.lastQueryAt > 0
      ? window.now - this.backfill.lastQueryAt < window.queryCooldownMs
      : false;
  }

  /**
   * Returns true if any camera sharing this camera's HomeBase station dispatched a backfill
   * database query within queryCooldownMs (bypassed for urgent SIGUSR1 test jobs).
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} queryCooldownMs - Minimum interval between HomeBase database queries in ms.
   * @returns {boolean}
   */
  hasRecentStationBackfillQuery(allCams, now, queryCooldownMs) {
    const stationKey = this.resolveStationBackfillKey(allCams);
    return this.hasUrgentTestBackfill()
      ? false
      : allCams.some((other) => other.isPacingStationBackfillQuery(stationKey, allCams, {now, queryCooldownMs}));
  }

  /**
   * Collects the unique HomeBase backfill station keys across all configured non-direct-RTSP cameras.
   *
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @returns {string[]}
   */
  static collectStationBackfillKeys(allCams = []) {
    const keys = new Set();
    for (const cam of allCams) {
      if (!cam.isRtspDirect()) {
        keys.add(cam.resolveStationBackfillKey(allCams));
      }
    }
    return [...keys];
  }

  /**
   * Selects the highest-priority camera on a station that has a matched clip ready to download.
   *
   * @param {Camera[]} stationCams - Cameras attached to the target HomeBase station.
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {{ now: number, delayMs: number }} timing - Current timestamp and post-sleep backfill delay.
   * @returns {Camera|undefined}
   */
  static selectReadyBackfillCam(stationCams, allCams, timing) {
    return stationCams
      .filter((c) => c.canStartBackfillDownloadNow(allCams, timing.now, timing.delayMs))
      .sort(Camera.compareBackfillPriority)[0];
  }

  /**
   * Selects the highest-priority camera on a station that is ready to query HomeBase for a backfill clip.
   *
   * @param {Camera[]} stationCams - Cameras attached to the target HomeBase station.
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {{
   *   now: number,
   *   minEventAgeMs: number,
   *   queryCooldownMs: number,
   *   delayMs: number,
   *   stationLastQueryAt: number,
   * }} timing - Backfill query timing thresholds and station last-query timestamp.
   * @returns {Camera|undefined}
   */
  static selectQueryableBackfillCam(stationCams, allCams, timing) {
    return stationCams
      .filter((c) => c.canQueryStationBackfill(allCams, timing))
      .sort(Camera.compareBackfillPriority)[0];
  }

  /**
   * Returns true if this camera belongs to the given stationSerial (or if either stationSerial is unspecified).
   *
   * @param {string} [stationSerial=''] - Station serial from a station event.
   * @returns {boolean}
   */
  isOnStation(stationSerial = '') {
    return Boolean(!this.stationSerial || !stationSerial || this.stationSerial === stationSerial);
  }

  /**
   * Returns true if at least one non-recorder viewer is currently connected to this camera in go2rtc.
   *
   * @returns {boolean}
   */
  hasConnectedViewers() {
    return this.viewerSet.hasAny();
  }

  /**
   * Records the latest Frigate event ID created via POST /api/events/<camera>/<label>/create
   * so subsequent /api/events queries can exclude synthetic bridge events by ID.
   *
   * @param {*} eventId - Created Frigate event ID.
   */
  recordCreatedFrigateEvent(eventId) {
    this.eventFiling.recordCreatedId(eventId);
  }

  /**
   * Returns the recognized person name currently associated with this camera's Frigate event.
   *
   * @returns {string}
   */
  getEventPerson() {
    return this.eventFiling.person || '';
  }

  /**
   * Returns the hardware clip event description or upgraded Frigate label for extending
   * a backfill Frigate event on 'download finished', preserving specific labels (such as
   * 'person detected' or 'vehicle detected') even after an /api/wake reason override.
   *
   * @returns {string}
   */
  getBackfillEventLabel() {
    return this.backfill.resolveEventLabel(this.eventFiling.label, this.session.reason);
  }

  /**
   * Returns the recognized person name for the active backfill clip or current Frigate event.
   *
   * @returns {string}
   */
  getBackfillEventPerson() {
    return this.backfill.resolveEventPerson(this.eventFiling.person);
  }

  /**
   * Returns true if the given Frigate active event object is a non-synthetic object detection
   * (not created by the bridge's 'eufy' sub_label or API event injection).
   *
   * @param {Record<string, *>|null|undefined} ev - Frigate event object from /api/events.
   * @returns {boolean}
   */
  isNonSyntheticFrigateEvent(ev) {
    return !ev ||
      (this.eventFiling.lastCreatedId && ev.id === this.eventFiling.lastCreatedId) ||
      ev.sub_label === 'eufy' ||
      ev.source_type === 'api' ||
      ev.data?.type === 'api'
      ? false
      : ev.data?.type === 'object'
        ? true
        : !this.eventFiling.person || ev.sub_label !== this.eventFiling.person;
  }

  /**
   * Evaluates a list of Frigate events for either an in-progress non-synthetic object detection
   * or a non-synthetic object detection that ended within recentTailMs (to tolerate brief
   * object occlusion when a person/car steps behind an obstacle). Updates frigateSawObject
   * and lastFrigateObjectAt when activity is found.
   *
   * @param {Array<Record<string, *>>} events - Frigate events array from /api/events.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [recentTailMs=DEFAULT_RECENT_FRIGATE_OBJECT_MS] - Recent completion tail window in milliseconds.
   * @returns {boolean} True if active or recently ended object activity was found.
   */
  evaluateFrigateEventsActivity(events, now = Date.now(), recentTailMs = DEFAULT_RECENT_FRIGATE_OBJECT_MS) {
    if (!Array.isArray(events)) {
      return false;
    }
    const minEndMs = Math.max(this.session.startedAt || 0, now - recentTailMs);
    let sawActiveOrRecent = false;
    let latestEventMs = 0;

    for (const ev of events) {
      if (!this.isNonSyntheticFrigateEvent(ev)) {
        continue;
      }
      const endSec = ev.end_time;
      if (endSec === null || endSec === undefined) {
        sawActiveOrRecent = true;
        latestEventMs = Math.max(latestEventMs, now);
        continue;
      }
      const endMs = Number(endSec) * 1000;
      if (!Number.isNaN(endMs) && endMs >= minEndMs) {
        sawActiveOrRecent = true;
        latestEventMs = Math.max(latestEventMs, Math.min(now, Math.round(endMs)));
      }
    }

    if (sawActiveOrRecent) {
      this.confirmFrigateObjectDetected(latestEventMs || now);
    }
    return sawActiveOrRecent;
  }

  /**
   * Returns true if Frigate has reported an active or recently-seen non-synthetic object
   * on this camera within windowMs.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [windowMs=DEFAULT_RECENT_FRIGATE_OBJECT_MS] - Activity recency window in milliseconds.
   * @returns {boolean}
   */
  hasRecentFrigateObjectActivity(now = Date.now(), windowMs = DEFAULT_RECENT_FRIGATE_OBJECT_MS) {
    return Boolean(this.lastFrigateObjectAt > 0 && now - this.lastFrigateObjectAt <= windowMs);
  }

  /**
   * Resolves the clamped hold duration in seconds for an external /api/wake request on this camera.
   *
   * @param {*} rawDuration - Optional explicit duration (seconds) from request body/query.
   * @param {number} [minSecs=5] - Minimum allowed wake duration in seconds.
   * @returns {number}
   */
  resolveApiWakeDurationSecs(rawDuration, minSecs = DEFAULT_MIN_WAKE_SECS) {
    const camMaxSecs = Math.round(this.timers.maxMs / MS_PER_SECOND);
    const camHoldSecs = Math.round(this.timers.holdMs / MS_PER_SECOND);
    const hasExplicit = rawDuration !== undefined && rawDuration !== null && !Number.isNaN(Number(rawDuration));
    return hasExplicit ? Math.max(minSecs, Math.min(camMaxSecs, Number(rawDuration))) : camHoldSecs;
  }

  /**
   * Transitions the camera into active backfill download mode for the given matched clip,
   * advancing backfillClipQueue to any subsequent clip from the same activity window.
   *
   * @param {{
   *   storagePath: string,
   *   cipherId: number,
   *   clipMs?: number,
   *   downloadAttempts?: number,
   *   event: string,
   *   personName: string,
   *   reason: string,
   * }} clip - Matched clip.
   * @param {boolean} _isTest - Whether triggered by SIGUSR1 test hook (preserved for 3-arg caller compatibility).
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  beginBackfillDownload(clip, _isTest, now) {
    this.backfill.prepareDownload(clip, now);
    this.eventActive = false;
    this.session.reason = 'backfill: ' + clip.reason;
    this.session.initiator = 'bridge-backfill';
    this.eventFiling.resetWindow();
    this.beginSession(STREAM_MODES.DOWNLOAD, now, true);
  }

  /**
   * Starts an RTSP wake session on this camera and returns the formatted wake log line.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string} Formatted RTSP wake log line.
   */
  beginRtspWakeSession(now = Date.now()) {
    this.eventActive = this.isInMotion(now);
    if (!this.eventActive) {
      this.clearPendingBackfill();
    }
    this.beginSession(STREAM_MODES.RTSP, now, true);
    return (
      'WAKE [RTSP] (initiator=' +
      (this.session.initiator || 'bridge') +
      ', reason="' +
      this.session.reason +
      '", priority=' +
      this.getEffectivePriority(now) +
      ', session=' +
      this.session.id +
      ')'
    );
  }

  /**
   * Starts a P2P wake session on this camera and returns an immutable wake descriptor.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {string} [stationKey=this.getStationKey()] - Station serial identifier.
   * @returns {Readonly<{ shouldFileEvent: boolean, eventReason: string, personName: string, wakeLog: string }>}
   */
  beginP2pWakeSession(now = Date.now(), stationKey = this.getStationKey()) {
    this.eventActive = this.isInMotion(now);
    this.beginSession(STREAM_MODES.P2P, now, false);
    const ecoTag = this.isLowBattery() ? ' [low-battery economy mode]' : '';
    const wakeLog =
      'WAKE (initiator=' +
      (this.session.initiator || 'bridge') +
      ', reason="' +
      this.session.reason +
      '", station=' +
      stationKey +
      ', priority=' +
      this.getEffectivePriority(now) +
      ', session=' +
      this.session.id +
      ')' +
      ecoTag;
    return Object.freeze({
      shouldFileEvent: Boolean(this.eventActive),
      eventReason: this.session.reason,
      personName: this.backfill.pending ? this.backfill.pending.getPersonName() : '',
      wakeLog,
    });
  }

  /**
   * Returns true if this camera is currently replaying a backfill clip that should not be
   * preempted by a viewer-only wake on candidateCam.
   *
   * @param {Camera} candidateCam - Camera requesting the station P2P slot.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isUrgentBackfillProtectedFrom(candidateCam, now = Date.now()) {
    return this.isBackfillPlayback() ? !candidateCam.isInMotion(now) : false;
  }

  /**
   * Clears a blocked motion hold on this camera when preempt_events is disabled
   * and this camera's motion arrived after activeCam's motion.
   *
   * @param {Camera} activeCam - Camera currently occupying the station P2P slot.
   * @param {boolean} [preemptEnabled=PREEMPT_EVENT_STREAMS] - Whether event stream preemption is enabled.
   */
  expireBlockedMotionHold(activeCam, preemptEnabled = PREEMPT_EVENT_STREAMS) {
    if (!preemptEnabled && this.session.lastMotionAt > activeCam.session.lastMotionAt) {
      this.session.motionUntil = 0;
      this.eventPriority = 0;
    }
  }

  /**
   * Records the start of an RTSP connection/wake attempt and returns the current sessionId.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {number}
   */
  markRtspAttemptStart(now = Date.now()) {
    return this.session.markRtspAttemptStart(now);
  }

  /**
   * Returns true if a device.start_rtsp_livestream wake attempt was recorded within windowMs.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [windowMs] - Recency window in milliseconds.
   * @returns {boolean}
   */
  hasRecentRtspStartAttempt(now = Date.now(), windowMs = undefined) {
    return this.session.hasRecentRtspStartAttempt(now, windowMs);
  }

  /**
   * Returns true if this is the initial wake attempt (restarts === 0) of the current session.
   *
   * @returns {boolean}
   */
  isFirstWakeAttempt() {
    return this.session.isFirstWakeAttempt();
  }

  /**
   * Marks the camera's motion hold as ended at checkNow for early sleep and returns the elapsed quiet seconds.
   *
   * @param {number} [checkNow=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {number} Elapsed quiet duration in seconds.
   */
  markEarlySleep(checkNow = Date.now()) {
    return this.session.markEarlySleep(checkNow);
  }

  /**
   * Marks that Frigate detected an active object on this camera and cancels any pending backfill if live is confirmed.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   */
  confirmFrigateObjectDetected(now = Date.now()) {
    this.frigateSawObject = true;
    this.lastFrigateObjectAt = Math.max(this.lastFrigateObjectAt || 0, now);
    this.cancelBackfillIfLiveConfirmed(now);
  }

  /**
   * Returns the elapsed live duration in seconds since startedAt.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {number}
   */
  getLiveDurationSecs(now = Date.now()) {
    return this.session.getLiveDurationSecs(now);
  }

  /**
   * Records that an /api/wake trigger is being applied to this camera.
   *
   * @param {boolean} [createEvent=false] - Whether a synthetic Frigate event is being created.
   */
  recordApiWakeTriggered(createEvent = false) {
    if (createEvent) {
      this.session.motionClearedAt = 0;
    }
  }

  /**
   * Returns true if a paced /api/wake timer is currently scheduled on this camera.
   *
   * @returns {boolean}
   */
  hasPendingApiWakeTimer() {
    return this.wake.hasPendingApiTimer();
  }

  /**
   * Returns the scheduled hold duration (in ms) of the currently pending /api/wake timer.
   *
   * @returns {number}
   */
  getScheduledApiWakeDurationMs() {
    return this.wake.getScheduledApiDurationMs();
  }

  /**
   * Expires an unfulfilled pending BackfillJob if it has exceeded maxAgeMs, or advances settled
   * pending jobs to READY_TO_QUERY, and returns the expired reason string when expired.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [minEventAgeMs] - Minimum event age before READY_TO_QUERY.
   * @returns {string} Expired backfill reason, or empty string if not expired.
   */
  expirePendingBackfillIfNeeded(now = Date.now(), minEventAgeMs = undefined) {
    this.expireStaleHardwareTriggers(now);
    const {expiredReason, droppedPending, shouldClearTriggers} = this.backfill.expireIfNeeded(
      now,
      this.session.active,
      minEventAgeMs
    );
    if (shouldClearTriggers) {
      this._clearActiveHardwareTriggers();
    }
    if (droppedPending) {
      this.promoteDeferredLiveWakeIfReady(now);
    }
    return expiredReason;
  }

  /**
   * Starts the next matched backfill download session and returns an immutable
   * `{ clip, sessionId, wakeLog }` descriptor.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {Readonly<{ clip: Record<string, *>, sessionId: number, wakeLog: string }>}
   */
  startNextBackfillDownload(now = Date.now()) {
    const clip = this.backfill.clip;
    const isTest = this.hasUrgentTestBackfill();
    this.beginBackfillDownload(clip, isTest, now);
    const wakeLog =
      'WAKE [BACKFILL DOWNLOAD] (initiator=bridge-backfill, reason="' +
      clip.reason +
      '", path="' +
      clip.storagePath +
      '", session=' +
      this.session.id +
      ')';
    return Object.freeze({clip, sessionId: this.session.id, wakeLog});
  }

  /**
   * Formats the debug log line emitted before dispatching HomeBase backfill database queries.
   *
   * @param {string} stationSn - Target HomeBase station serial number.
   * @param {{ attempts: number, maxAttempts: number, reason: string }} queryState - Query attempt summary.
   * @returns {string}
   */
  formatBackfillQueryAttemptLog(stationSn, queryState) {
    return (
      'querying HomeBase (' +
      stationSn +
      ') local database for missed event clip (attempt=' +
      queryState.attempts +
      '/' +
      queryState.maxAttempts +
      ', reason="' +
      queryState.reason +
      '")'
    );
  }

  /**
   * Consumes a HomeBase database query attempt for the pending BackfillJob and returns an immutable outcome.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [maxAttempts] - Maximum allowed query attempts.
   * @returns {Readonly<{ allowed: boolean, attempts: number, maxAttempts: number, reason: string }>}
   */
  beginBackfillDatabaseQuery(now = Date.now(), maxAttempts = undefined) {
    const out = this.backfill.beginDatabaseQuery(now, this.session.active, maxAttempts);
    if (out.shouldClearTriggers) {
      this._clearActiveHardwareTriggers();
    }
    if (out.droppedPending) {
      this.promoteDeferredLiveWakeIfReady(now);
    }
    return Object.freeze({
      allowed: out.allowed,
      attempts: out.attempts,
      maxAttempts: out.maxAttempts,
      reason: out.reason,
    });
  }

  /**
   * Returns true if this camera is active and not already in the middle of a start_livestream RPC call.
   *
   * @returns {boolean}
   */
  canBeginP2pStart() {
    return this.session.canBeginP2pStart();
  }

  /**
   * Marks this camera as actively executing a start_livestream RPC call and returns its sessionId.
   *
   * @returns {number}
   */
  beginP2pStartAttempt() {
    return this.session.beginP2pStartAttempt();
  }

  /**
   * Marks the camera's P2P stream as ready to ingest packets and optionally updates lastStartAt.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [updateStartAt=true] - Whether to set lastStartAt = now.
   */
  markP2pStreamReady(now = Date.now(), updateStartAt = true) {
    this.session.markP2pStreamReady(now, updateStartAt);
  }

  /**
   * Marks the camera's P2P stream as not ready to ingest packets.
   */
  markP2pStreamNotReady() {
    this.session.markP2pStreamNotReady();
  }

  /**
   * Applies a backoff offset to lastStartAt after a failed start_livestream RPC if sessionId is still current.
   *
   * @param {number} sessionId - Session identifier of the failed attempt.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [backoffMs] - Backoff offset in milliseconds.
   */
  applyFailedStartBackoff(sessionId, now = Date.now(), backoffMs = undefined) {
    this.session.applyFailedStartBackoff(sessionId, now, backoffMs);
  }

  /**
   * Clears the starting flag if sessionId still matches the current session.
   *
   * @param {number} sessionId - Session identifier of the completed start attempt.
   */
  finishP2pStartAttempt(sessionId) {
    this.session.finishP2pStartAttempt(sessionId);
  }

  /**
   * Stores and returns the in-flight start_livestream Promise on this camera.
   *
   * @param {Promise<*>} promise - In-flight start promise.
   * @returns {Promise<*>}
   */
  setStartPromise(promise) {
    return this.session.setStartPromise(promise);
  }

  /**
   * Clears motion and viewer queues when the HomeBase station or WebSocket disconnects and returns true if active.
   *
   * @param {string} [clearReason='station_disconnected'] - Reason for clearing viewer queue.
   * @returns {boolean} True if the camera was active and needs to be stopped.
   */
  handleStationDisconnected(clearReason = 'station_disconnected') {
    if (this.isRtspDirect()) {
      return false;
    }
    this.session.motionUntil = 0;
    this._clearActiveHardwareTriggers();
    this.clearDeferredLiveWake();
    this.clearViewerQueue(clearReason);
    return Boolean(this.session.active);
  }

  /**
   * Evaluates how the orchestrator should handle a 'livestream stopped' event from eufy-security-ws.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [minCleanVideoMs=3000] - Minimum clean event video duration in milliseconds.
   * @returns {Readonly<{ action: 'clean_end'|'interrupted'|'expired'|'inactive', warnMsg: string }>}
   */
  evaluateExternalLivestreamStop(now = Date.now(), minCleanVideoMs = DEFAULT_MIN_CLEAN_VIDEO_MS) {
    if (
      this.isBackfillPlayback() ||
      (this.stoppingP2p && (!this.session.active || (this.session.starting && !this.session.gotVideo)))
    ) {
      return Object.freeze({action: 'inactive', warnMsg: ''});
    }
    if (this.session.active && this.session.starting) {
      return Object.freeze({action: 'inactive', warnMsg: ''});
    }
    const liveSecs = this.getLiveDurationSecs(now);
    const lastVideoAgo = this.session.lastVideoAt
      ? ((now - this.session.lastVideoAt) / MS_PER_SECOND).toFixed(1) + 's'
      : 'none';
    this.session.p2pReady = false;

    if (this.isPiggybackedExternalSession() || this.didEufyEndEventCleanly(now, minCleanVideoMs)) {
      this.session.motionUntil = 0;
      this.session.viewUntil = 0;
      return Object.freeze({action: 'clean_end', warnMsg: ''});
    }
    if (this.session.active && !this.isInMotion(now) && !this.hasWakingViewer() && this.session.gotVideo) {
      return Object.freeze({action: 'expired', warnMsg: ''});
    }
    if (this.session.active && now < this.wantUntil()) {
      const remainingSecs = Math.round((this.wantUntil() - now) / MS_PER_SECOND);
      const warnMsg =
        'stream interrupted by eufy/camera (initiator=eufy/camera, ' +
        'reason="livestream stopped event while session active", live=' +
        liveSecs +
        's, gotVideo=' +
        this.session.gotVideo +
        ', lastVideoAgo=' +
        lastVideoAgo +
        ', remainingHold=' +
        remainingSecs +
        's) - re-requesting livestream';
      return Object.freeze({action: 'interrupted', warnMsg});
    }
    if (this.session.active) {
      return Object.freeze({action: 'expired', warnMsg: ''});
    }
    return Object.freeze({action: 'inactive', warnMsg: ''});
  }

  /**
   * Evaluates backfill status after Eufy reports an event property cleared (state: false).
   *
   * @param {string} eventName - Eufy event property name.
   * @returns {Readonly<{ hasPending: boolean, isInfo: boolean, logMsg: string }>}
   */
  evaluateBackfillAfterMotionCleared(eventName) {
    return this.backfill.evaluateAfterMotionCleared(eventName);
  }

  /**
   * Resets motionClearedAt and cancels any startup snapshot probe when a new motion trigger arrives.
   */
  prepareForMotionTrigger() {
    this.session.motionClearedAt = 0;
    this.cancelStartupProbe();
  }

  /**
   * Returns true if at least one video frame (Frame 0) has been decoded in the current session.
   *
   * @returns {boolean}
   */
  hasDecodedFrame() {
    return this.isBackfillPlayback()
      ? this.backfill.decodedFrames > 0 || this.session.firstFrameAt > 0
      : this.session.firstFrameAt > 0;
  }

  /**
   * Returns true if the current session received confirmed video (decoded Frame 0 for backfill
   * downloads, or stream video packets/frames for live sessions).
   *
   * @returns {boolean}
   */
  hasConfirmedSessionVideo() {
    return this.isBackfillPlayback() ? this.hasDecodedFrame() : this.session.gotVideo;
  }

  /**
   * Returns true if an active backfill download has timed out waiting to decode Frame 0.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} timeoutMs - Timeout threshold in milliseconds.
   * @param {number} [quietSince=this.getQuietSinceTimestamp()] - Timestamp of last video packet or start attempt.
   * @returns {boolean}
   */
  hasDownloadTimedOut(now, timeoutMs, quietSince = this.getQuietSinceTimestamp()) {
    return !this.hasDecodedFrame() ? now - quietSince > timeoutMs : false;
  }

  /**
   * If this camera has reached its max_secs duration limit, clears motionUntil and returns the stop reason.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string} Formatted stop reason if limit reached, or empty string.
   */
  expireMaxDurationHold(now = Date.now()) {
    return this.session.expireMaxDurationHold(now);
  }

  /**
   * If this camera has reached its view_max_secs duration limit, returns the formatted stop reason.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string} Formatted stop reason if limit reached, or empty string.
   */
  getViewMaxDurationReason(now = Date.now()) {
    return this.session.getViewMaxDurationReason(now);
  }

  /**
   * Returns the latest timestamp between lastVideoAt and lastStartAt for health watchdog checks.
   *
   * @returns {number}
   */
  getQuietSinceTimestamp() {
    return this.session.getQuietSince();
  }

  /**
   * Resets motion and viewer hold timers plus pending wake queues prior to graceful bridge shutdown.
   */
  prepareForShutdown() {
    this.session.motionUntil = 0;
    this.session.viewUntil = 0;
    this.clearApiWakeTimer();
    this.clearDeferredLiveWake();
  }

  /**
   * Clears any deferred live wake request queued during active backfill playback.
   */
  clearDeferredLiveWake() {
    this.wake.clearDeferred();
  }

  /**
   * Queues or coalesces a live wake request so it starts for its full requested duration immediately
   * after active HomeBase backfill playback (and any earlier queued BackfillJob) completes.
   *
   * @param {ReturnType<WakeRequest['build']>} req - Frozen WakeRequest value object.
   * @param {number} [_now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {number} Coalesced wake duration in milliseconds.
   */
  schedulePostBackfillWake(req, _now = Date.now()) {
    return this.wake.defer(req);
  }

  /**
   * Promotes any deferred post-backfill live wake into an active motion/view wake request once
   * backfill playback and any preceding BackfillJobs have finished.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @returns {boolean} True if a deferred wake was promoted.
   */
  promoteDeferredLiveWakeIfReady(now = Date.now(), allCams = []) {
    if (!this.wake.hasDeferred() || this.session.active || this.hasPendingBackfill()) {
      return false;
    }
    const deferred = this.wake.takeDeferred();
    this.recordApiWakeTriggered(Boolean(deferred.createEvent));
    this.applyWakeRequest(deferred, now, allCams);
    return true;
  }

  /**
   * Absorbs any pending deferred live wake priority into an incoming Eufy hardware BackfillJob
   * when HomeBase clip backfill is enabled so the hardware-recorded clip carries the higher priority
   * without triggering a redundant live wake afterward.
   *
   * @param {number} evPriority - Incoming Eufy trigger priority boost.
   * @param {boolean} recordingActive - Whether the camera hardware clip is actively recording.
   * @returns {number} Effective event priority boost.
   */
  _consumeDeferredWakePriority(evPriority, recordingActive) {
    if (!recordingActive || !this.wake.hasDeferred() || !this.backfillDownloads) {
      return evPriority;
    }
    return this.wake.absorbPriority(evPriority);
  }

  /**
   * Schedules an external /api/wake request to start live immediately after active backfill playback
   * completes, returning the structured HTTP response payload.
   *
   * @param {{ reason: string, durationMs: number, createEvent: boolean, evPriority: number }} opts
   *   - API wake options.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {ReturnType<Camera['toApiWakeResponse']>}
   */
  deferApiWakeDuringBackfill(opts, now = Date.now()) {
    this.clearApiWakeTimer();
    const builder = opts.createEvent
      ? WakeRequest.motion(opts.reason, opts.durationMs).withPriority(opts.evPriority)
      : WakeRequest.view(opts.reason, opts.durationMs);
    const req = builder.withInitiator('api-wake').withCreateEvent(Boolean(opts.createEvent)).build();
    const scheduledDurationMs = this.schedulePostBackfillWake(req, now);
    return this.toApiWakeResponse(API_WAKE_STATUSES.SCHEDULED, scheduledDurationMs, 0);
  }

  /**
   * Routes a hardware motion or RTSP-start trigger arriving during active backfill playback:
   * returns 'backfill' when HomeBase clip backfill is enabled, or queues a deferred live wake and
   * returns 'deferred' when clip backfill is disabled.
   *
   * @param {string} reason - Trigger description.
   * @param {number} evPriority - Event priority boost score.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {'backfill'|'deferred'}
   */
  routeHardwareTriggerDuringBackfill(reason, evPriority, now = Date.now()) {
    if (this.backfillDownloads) {
      return 'backfill';
    }
    const req = WakeRequest.motion(reason, this.getEventHoldMs())
      .withInitiator('eufy-event')
      .withPriority(evPriority)
      .withCreateEvent(true)
      .build();
    this.schedulePostBackfillWake(req, now);
    return 'deferred';
  }

  /**
   * Returns true if the given go2rtc viewer consumer ID is already tracked on this camera.
   *
   * @param {*} viewerId - Consumer ID from go2rtc.
   * @returns {boolean}
   */
  hasRegisteredViewer(viewerId) {
    return this.viewerSet.has(viewerId);
  }

  /**
   * Updates whether a tracked go2rtc viewer consumer ID is actively waking/holding this camera.
   *
   * @param {*} viewerId - Consumer ID from go2rtc.
   * @param {boolean} asked - Whether this viewer is allowed to wake/extend the camera.
   */
  setViewerWakingStatus(viewerId, asked) {
    this.viewerSet.setWaking(viewerId, asked);
  }

  /**
   * Returns true if this camera has an active waking viewer, clearing isStartupProbe when true.
   *
   * @returns {boolean}
   */
  promoteStartupProbeToViewerWake() {
    if (this.hasWakingViewer()) {
      this.isStartupProbe = false;
      return true;
    }
    return false;
  }

  /**
   * Returns an immutable logger scope object `{ name, state }` for Frigate event lifecycle logs.
   *
   * @returns {Readonly<{ name: string, state: string }>}
   */
  getEventLogScope() {
    return Object.freeze({name: this.name, state: this.eventFiling.state});
  }

  /**
   * Stores the scheduled Frigate event dispatch timer on this camera.
   *
   * @param {*} timer - Node.js Timeout handle.
   */
  setFrigateEventTimer(timer) {
    this.eventFiling.setTimer(timer);
  }

  /**
   * Returns true if this camera's pending Frigate event is not a synthetic 'test' event and
   * is still waiting for a clean live snapshot frame.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} requiredDelayMs - Required continuous video duration in milliseconds.
   * @param {number} freshFrameMs - Maximum age of a live frame in milliseconds.
   * @param {number} recentFallbackMs - Window after stream stop where gotVideo still counts.
   * @returns {boolean}
   */
  shouldWaitForEventSnapshot(now, requiredDelayMs, freshFrameMs, recentFallbackMs) {
    return Boolean(
      this.eventFiling.label !== 'test' &&
      !this.isReadyForEventSnapshot(now, requiredDelayMs, freshFrameMs, recentFallbackMs)
    );
  }

  /**
   * Coalesces a duplicate /api/wake request into the camera's pending wake timer options
   * and returns the remaining delay in milliseconds.
   *
   * @param {{durationMs: number, reason: string, createEvent: boolean}} spec - Duplicate wake request options
   *   (durationMs: requested wake hold duration in ms; reason: wake reason string; createEvent: whether to file a
   *   synthetic Frigate event).
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {number} Remaining scheduled delay in milliseconds.
   */
  coalesceApiWake(spec, now) {
    return this.wake.coalesceApi(spec, now);
  }

  /**
   * Schedules a paced /api/wake timer on this camera.
   *
   * @param {{
   *   durationMs: number,
   *   reason: string,
   *   createEvent: boolean,
   *   delayMs: number,
   *   now: number,
   * }} spec - Paced wake specification (durationMs: requested wake duration in ms; reason: wake reason string;
   *   createEvent: whether to file a synthetic Frigate event; delayMs: pacing delay in ms; now: current epoch ms).
   * @param {(pending: {
   *   durationMs: number,
   *   reason: string,
   *   createEvent: boolean,
   * }) => void} onFire - Callback when timer fires.
   */
  scheduleApiWake(spec, onFire) {
    this.wake.scheduleApi(spec, onFire);
  }

  /**
   * Resets RTSP wake timestamps and retry counters if an active RTSP wake has stalled for stallMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} stallMs - Stall threshold in milliseconds.
   * @returns {boolean} True if the RTSP wake was stalled and reset.
   */
  resetStalledRtspWakeIfNeeded(now, stallMs) {
    return this.session.resetStalledRtspWake(now, stallMs);
  }

  /**
   * Builds the JSON response object returned by the /api/wake HTTP endpoint for this camera.
   *
   * @param {'extended'|'scheduled'|'waking'|'backfill'|'offline'} status - Resulting wake status.
   * @param {number} durationMs - Effective hold duration in milliseconds.
   * @param {number} delayMs - Scheduled pacing delay in milliseconds.
   * @returns {{ camera: string, title: string, status: string, mode: string, hold_secs: number, delay_ms: number }}
   */
  toApiWakeResponse(status, durationMs, delayMs) {
    return {
      camera: this.name,
      title: this.getDisplayTitle(),
      status,
      mode: this.session.mode || (this.isRtspCapable() ? STREAM_MODES.RTSP : STREAM_MODES.P2P),
      hold_secs: Math.round(durationMs / MS_PER_SECOND),
      delay_ms: delayMs,
    };
  }

  /**
   * Builds an error/skipped JSON response descriptor returned by /api/wake for non-woken cameras.
   *
   * @param {'offline'|'unavailable'|'unsupported'} status - Non-wake status code.
   * @param {string} [error] - Human-readable reason explaining why wake did not proceed.
   * @returns {{
   *   camera: string,
   *   title: string,
   *   status: string,
   *   mode: string,
   *   hold_secs: number,
   *   delay_ms: number,
   *   error: string,
   * }}
   */
  toApiWakeErrorResponse(status, error = DIRECT_RTSP_WAKE_UNSUPPORTED_ERROR) {
    return {
      camera: this.name,
      title: this.getDisplayTitle(),
      status,
      mode: this.session.mode || (this.isRtspCapable() ? STREAM_MODES.RTSP : STREAM_MODES.P2P),
      hold_secs: 0,
      delay_ms: 0,
      error,
    };
  }

  /**
   * Returns true if an active backfill download has finished transferring, flushed its decoder,
   * played out all buffered frames, and completed its post-playback hold window.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [idleCompleteMs=DEFAULT_DOWNLOAD_IDLE_COMPLETE_MS] - Fallback idle duration
   *   after last frame if downloadFinished was missed.
   * @param {number} [postPlaybackHoldMs=DEFAULT_DOWNLOAD_POST_PLAYBACK_HOLD_MS] - Hold duration
   *   after the final frame is encoded.
   * @param {number} [minPlaybackMs=DEFAULT_DOWNLOAD_MIN_PLAYBACK_MS] - Minimum total playback
   *   session duration in milliseconds.
   * @returns {boolean}
   */
  isDownloadComplete(now, idleCompleteMs = undefined, postPlaybackHoldMs = undefined, minPlaybackMs = undefined) {
    const hasBufferedStdout = Boolean(
      this.session.dec && this.session.dec.stdout && this.session.dec.stdout.readableLength > 0
    );
    const hasUnencodedFrame = Boolean(this.frameNew && this.hasWritableEncoderStdin());
    const allPipesDrained =
      !hasUnencodedFrame &&
      this.session.pendingVideoPackets.length === 0 &&
      !this.session.decoderStdoutPaused &&
      !hasBufferedStdout;
    return this.backfill.isDownloadComplete(now, {
      hasDecodedFrame: this.hasDecodedFrame(),
      gotVideo: this.session.gotVideo,
      allPipesDrained,
      hasDec: Boolean(this.session.dec),
      startedAt: this.session.startedAt,
      lastVideoAt: this.session.lastVideoAt,
      idleCompleteMs,
      postPlaybackHoldMs,
      minPlaybackMs,
    });
  }

  /**
   * Marks an active backfill download transfer as finished and returns the total number of
   * buffered decoded frames and queued compressed packets remaining to play out.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {number} Number of buffered frames and queued video packets remaining.
   */
  markDownloadFinished(now) {
    const remaining = this.backfill.markTransferFinished(now, this.session.pendingVideoPackets.length);
    if (this.isBackfillPlayback() && this.hasDecodedFrame()) {
      this.transitionTo(SESSION_STATES.DRAINING_BACKFILL_TAIL, now, 'download transfer finished');
    }
    return remaining;
  }

  /**
   * Formats a structured log line when HomeBase P2P clip transfer completes during backfill download.
   *
   * @param {number} bufferedCount - Total buffered decoded frames and pending video packets remaining.
   * @param {number} [fps=LIVE_FPS] - Playback frame rate in frames per second.
   * @returns {string}
   */
  formatBackfillTransferCompleteLog(bufferedCount, fps = LIVE_FPS) {
    return this.backfill.formatTransferCompleteLog(bufferedCount, this.session.pendingVideoPackets.length, {
      fps,
      sessionId: this.session.id,
    });
  }

  /**
   * Returns true if a decoder process exit while the session is active should be logged as a warning.
   *
   * @param {number} sessionId - Session identifier of the exited decoder.
   * @param {number|null} exitCode - Process exit code.
   * @returns {boolean}
   */
  shouldLogUnexpectedDecoderExit(sessionId, exitCode) {
    return this.isCurrentSession(sessionId)
      ? !(this.isBackfillPlayback() && this.backfill.finished && exitCode === 0)
      : false;
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
   * @param {boolean} [preemptEnabled=PREEMPT_EVENT_STREAMS] - Whether equal-priority event preemption is enabled.
   * @returns {boolean}
   */
  canPreempt(cur, now, stallPreemptMs, preemptEnabled = PREEMPT_EVENT_STREAMS) {
    const pickScore = this.getEffectivePriority(now);
    const curScore = cur.getEffectivePriority(now);
    const curFinishedOrStalled =
      cur.session.motionClearedAt > cur.session.lastMotionAt ||
      (!cur.session.gotVideo && now - cur.session.startedAt >= stallPreemptMs);
    const samePriorityCanPreempt =
      pickScore === curScore &&
      this.session.lastMotionAt > cur.session.lastMotionAt &&
      Boolean(preemptEnabled || curFinishedOrStalled);
    return !this.isInMotion(now)
      ? !cur.isInMotion(now) && this.session.viewSince > cur.session.viewSince
      : !cur.isInMotion(now) || pickScore > curScore || samePriorityCanPreempt || Boolean(curFinishedOrStalled);
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
      return b.session.lastMotionAt - a.session.lastMotionAt;
    }
    return b.session.viewSince - a.session.viewSince;
  }

  /**
   * Comparator that orders cameras by pending/active backfill priority (highest first), breaking
   * equal-priority ties by oldest lastBackfillQueryAt so sibling cameras round-robin fairly.
   *
   * @param {Camera} a - First candidate camera.
   * @param {Camera} b - Second candidate camera.
   * @returns {number}
   */
  static compareBackfillPriority(a, b) {
    const prioDiff = b.getBackfillPriority() - a.getBackfillPriority();
    if (prioDiff !== 0) {
      return prioDiff;
    }
    return (a.backfill.lastQueryAt || 0) - (b.backfill.lastQueryAt || 0);
  }

  /**
   * Comparator that orders RTSP-capable cameras ahead of P2P cameras.
   *
   * @param {Camera} a - First candidate camera.
   * @param {Camera} b - Second candidate camera.
   * @returns {number}
   */
  static compareRtspFirst(a, b) {
    return Number(b.isRtspCapable()) - Number(a.isRtspCapable());
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
   * Appends a decoded s16le PCM audio chunk to the camera audio queue, using the larger
   * download audio buffer cap during burst backfill downloads and dropping oldest chunks
   * only when the active mode's buffer limit is exceeded.
   *
   * @param {Uint8Array} pcmChunk - Raw s16le PCM buffer.
   * @param {number} maxLiveBytes - Maximum buffered PCM bytes during live streaming.
   * @param {number} [maxDownloadBytes=maxLiveBytes] - Maximum buffered PCM bytes during clip downloads.
   */
  appendAudioChunk(pcmChunk, maxLiveBytes, maxDownloadBytes = maxLiveBytes) {
    const byteCapacity = this.session.mode === STREAM_MODES.DOWNLOAD ? maxDownloadBytes : maxLiveBytes;
    this.audioQueue.push(pcmChunk, byteCapacity);
  }

  /**
   * Consumes the next chunkBytes of PCM audio for the encoder pipe in O(1) without Buffer.concat,
   * or returns silenceBuf when insufficient audio is buffered or before the first backfill frame is decoded.
   *
   * @param {number} chunkBytes - Number of bytes per audio tick.
   * @param {Uint8Array} silenceBuf - Pre-allocated silence buffer.
   * @returns {Uint8Array}
   */
  consumeAudioChunk(chunkBytes, silenceBuf) {
    return this.audioQueue.consume(chunkBytes, silenceBuf, this.isBackfillPlayback() && !this.session.firstFrameAt);
  }

  /**
   * Acquires the lazily allocated per-camera raw YUV420p decoder stdout assembly buffer
   * so standby probes and session restarts reuse a single 1.38 MB Buffer without churn.
   *
   * @returns {Buffer}
   */
  acquireDecoderReadBuffer() {
    if (!this.decoderReadBuf) {
      this.decoderReadBuf = Buffer.allocUnsafe(FRAME);
    }
    return this.decoderReadBuf;
  }

  /**
   * Copies a newly decoded YUV420p live frame into the next alternating slot of liveFrameRing
   * so consecutive frames never allocate 1.38 MB on the heap and this.frame / this.lastFrame never alias.
   *
   * @param {Uint8Array} rawBuf - Raw decoded YUV420p frame buffer.
   * @returns {Buffer} Populated ring buffer slot.
   */
  acquireNextLiveFrameSlot(rawBuf) {
    if (!this.liveFrameRing) {
      this.liveFrameRing = [Buffer.allocUnsafe(FRAME), Buffer.allocUnsafe(FRAME)];
    }
    this.liveFrameRingIdx = (this.liveFrameRingIdx + 1) & 1;
    const slot = this.liveFrameRing[this.liveFrameRingIdx];
    slot.set(rawBuf);
    return slot;
  }

  /**
   * Acquires a recycled YUV420p frame buffer from downloadFramePool (or allocates one if empty)
   * and copies rawBuf into it for bounded-memory backfill playback.
   *
   * @param {Uint8Array} rawBuf - Raw decoded YUV420p frame buffer.
   * @returns {Buffer}
   */
  acquireDownloadFrameBuffer(rawBuf) {
    const buf = this.downloadFramePool.length > 0 ? this.downloadFramePool.pop() : Buffer.allocUnsafe(FRAME);
    buf.set(rawBuf);
    return buf;
  }

  /**
   * Commits a newly decoded YUV420p video frame, updates lastFrame/lastSeen, and cancels
   * pending backfill if live capture is confirmed.
   *
   * @param {Uint8Array} liveFrame - Frame buffer assigned to this.frame.
   * @param {Uint8Array} [snapshotCopy=liveFrame] - Independent Buffer copy assigned to this.lastFrame.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {string} [lastSeenHm=''] - Formatted HH:MM timestamp string.
   * @param {number} [cancelBackfillMs=DEFAULT_CANCEL_BACKFILL_VIDEO_MS] - Minimum video duration to cancel backfill.
   */
  recordDecodedFrame(
    liveFrame,
    snapshotCopy = liveFrame,
    now = Date.now(),
    lastSeenHm = '',
    cancelBackfillMs = this.getSustainedLiveVideoCutoffMs()
  ) {
    if (!this.session.firstFrameAt) {
      this.session.firstFrameAt = now;
      if (this.isBackfillPlayback()) {
        this.backfill.playbackStartedAt = now;
        if (!this.session.gotVideo) {
          this.session.gotVideo = true;
          this.session.firstVideoAt = now;
        }
      }
    }
    this.markDecoderDecoding();
    if (this.session.active) {
      if (this.isBackfillPlayback()) {
        this.backfill.continuation = false;
        this.backfill.decodedFrames++;
        this.backfill.playedFrames++;
        this.transitionTo(
          this.backfill.finished ? SESSION_STATES.DRAINING_BACKFILL_TAIL : SESSION_STATES.PLAYING_BACKFILL,
          now,
          this.backfill.finished ? 'download transfer finished' : 'first backfill frame decoded'
        );
      } else {
        this.transitionTo(SESSION_STATES.STREAMING_LIVE, now, 'first live frame decoded');
      }
    }
    const prevFrame = this.frame;
    this.frame = liveFrame;
    this.frameAt = now;
    this.session.lastVideoAt = now;
    this.frameNew = true;
    this.lastFrame = snapshotCopy === liveFrame && prevFrame && prevFrame !== liveFrame ? prevFrame : snapshotCopy;
    this.needsStartupSnapshot = false;
    this.telemetry.markDeviceOnline();
    this.cancelBackfillIfLiveConfirmed(now, cancelBackfillMs);
    if (lastSeenHm) {
      this.telemetry.updateLastSeen(lastSeenHm);
    }
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
    const res = this.backfill.bufferFrame(Boolean(this.frame), frameCopy, maxBufferFrames);
    if (!res.buffered) {
      return false;
    }
    if (res.dropped) {
      this.session.droppedFrames++;
    }
    if (!this.session.decoderStdoutPaused && res.shouldPauseDecoder) {
      this.pauseDecoderStdout();
    }
    return true;
  }

  /**
   * Marks the attached FFmpeg decoder as actively decoding media.
   *
   * @returns {string} Resulting decoder FSM state.
   */
  markDecoderDecoding() {
    return this.session.markDecoderDecoding();
  }

  /**
   * Pauses the FFmpeg decoder stdout stream when backfill frame buffering reaches
   * DOWNLOAD_FRAME_HIGH_WATERMARK and transitions the decoder FSM to PAUSED_BACKPRESSURE.
   *
   * @returns {string} Resulting decoder FSM state.
   */
  pauseDecoderStdout() {
    return this.session.pauseDecoderStdout();
  }

  /**
   * Enqueues a compressed Annex-B video packet in RAM when decoder stdout is paused (or stdin
   * needs drain) or writes it directly to the active FFmpeg decoder stdin.
   *
   * @param {Uint8Array} packetBuf - Raw compressed H.264/H.265 packet.
   * @param {boolean} [audioEnabled] - Whether audio pipe draining is enabled.
   * @returns {boolean} True if written or queued.
   */
  enqueueOrWriteVideoPacket(packetBuf, audioEnabled = undefined) {
    return this.session.enqueueOrWriteVideoPacket(packetBuf, audioEnabled);
  }

  /**
   * Writes a compressed AAC audio packet directly to the active FFmpeg decoder audio pipe
   * (stdio[3]), or queues it in RAM if the decoder is still spawning or the audio pipe needs drain.
   * Does not pause on video stdout backpressure (decoderStdoutPaused) so audio decodes continuously
   * without gaps during backfill playback.
   *
   * @param {Uint8Array} packetBuf - Raw compressed AAC packet.
   * @param {boolean} [audioEnabled] - Whether audio is enabled.
   * @returns {boolean} True if written or queued.
   */
  enqueueOrWriteAudioPacket(packetBuf, audioEnabled = undefined) {
    return this.session.enqueueOrWriteAudioPacket(packetBuf, audioEnabled);
  }

  /**
   * Drains queued compressed video/audio packets into the FFmpeg decoder pipes once backpressure
   * clears, closing the input pipes if markDecoderInputEnded was requested on download EOF.
   *
   * @param {boolean} [audioEnabled] - Whether audio pipe draining is enabled.
   * @param {boolean} [fromPipeDrain=false] - Whether invoked from a decoder input pipe drain event.
   */
  drainPendingDecoderInput(audioEnabled = undefined, fromPipeDrain = false) {
    this.session.drainPendingDecoderInput(audioEnabled, fromPipeDrain);
  }

  /**
   * Marks the decoder input stream as ended (on backfill download EOF) and closes the FFmpeg
   * input pipes immediately or as soon as any queued compressed packets finish draining.
   *
   * @param {boolean} [audioEnabled] - Whether audio pipe is enabled.
   */
  markDecoderInputEnded(audioEnabled = undefined) {
    this.session.markDecoderInputEnded(audioEnabled);
  }

  /**
   * Resumes the FFmpeg decoder stdout stream if it was paused for backfill backpressure
   * and drains any compressed packets queued while paused.
   */
  resumeDecoderStdout() {
    this.session.resumeDecoderStdout();
  }

  /**
   * Advances the buffered download frame queue by one frame when due, recycling the previous
   * frame buffer into downloadFramePool and resuming the paused FFmpeg decoder stdout stream
   * once the queue drains down to DOWNLOAD_FRAME_LOW_WATERMARK.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [frameIntervalMs=62] - Minimum interval between download frames in milliseconds.
   * @param {string} [lastSeenHm=''] - Formatted HH:MM timestamp string.
   * @returns {Uint8Array|null} Newly committed download frame buffer or null if not advanced.
   */
  consumeNextDownloadFrame(now, frameIntervalMs = DEFAULT_LIVE_FRAME_PACE_MS, lastSeenHm = '') {
    if (!this.canAdvanceDownloadFrame(now, frameIntervalMs)) {
      return null;
    }
    const prevFrame = this.frame;
    const nextBuf = this.backfill.frames.shift();
    this.backfill.playedFrames++;
    if (
      Buffer.isBuffer(prevFrame) &&
      prevFrame !== nextBuf &&
      this.downloadFramePool.length < DOWNLOAD_POOL_MAX_BUFFERS
    ) {
      this.downloadFramePool.push(prevFrame);
    }
    this.frame = nextBuf;
    this.frameAt = now;
    this.session.lastVideoAt = now;
    this.frameNew = true;
    this.lastFrame = nextBuf;
    if (lastSeenHm) {
      this.telemetry.updateLastSeen(lastSeenHm);
    }
    if (this.session.decoderStdoutPaused && this.backfill.frames.length <= DOWNLOAD_FRAME_LOW_WATERMARK) {
      this.resumeDecoderStdout();
    }
    return nextBuf;
  }

  /**
   * Records that the given YUV420p frame buffer was written to the FFmpeg encoder stdin.
   *
   * @param {Uint8Array} frame - Frame buffer written to encoder.
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  markFrameEncoded(frame, now) {
    if (!this.fpsWindowStartAt || now < this.fpsWindowStartAt) {
      this.fpsWindowStartAt = now;
      this.fpsFrameCount = 1;
    } else {
      this.fpsFrameCount++;
      const elapsedMs = now - this.fpsWindowStartAt;
      if (elapsedMs >= MS_PER_SECOND) {
        this.measuredFps = (this.fpsFrameCount * MS_PER_SECOND) / elapsedMs;
        this.fpsWindowStartAt = now;
        this.fpsFrameCount = 0;
      } else if (this.measuredFps === 0 && elapsedMs > 0) {
        this.measuredFps = (Math.max(1, this.fpsFrameCount - 1) * MS_PER_SECOND) / elapsedMs;
      }
    }
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
    this.offline.markEncoderStarted();
    this.encoderConsumerConnected = false;
    this.lastSent = null;
    this.lastWrite = now;
    this.burstUntil = now + KEYFRAME_BURST_MS;
  }

  /**
   * Returns true if proc can safely receive a POSIX signal without triggering libuv kill(0, sig)
   * on an unspawned ChildProcess handle whose pid is undefined or 0 (before ENOENT nextTick).
   *
   * @param {*} proc - Candidate ChildProcess or test double.
   * @returns {boolean}
   */
  static canSignalProcess(proc) {
    if (!proc || typeof proc.kill !== 'function') {
      return false;
    }
    if ('pid' in proc) {
      return typeof proc.pid === 'number' && proc.pid > 0;
    }
    return true;
  }

  /**
   * Terminates the persistent FFmpeg encoder process on bridge shutdown.
   */
  stopEncoderProcess() {
    this.clearOfflineSeedTimer();
    if (!Camera.canSignalProcess(this.enc)) {
      return;
    }
    try {
      this.enc.kill(PROCESS_SIGNALS.SIGTERM);
    } catch (err) {
      // Ignore errors when stopping encoder on shutdown.
    }
  }

  /**
   * Returns true if a persistent FFmpeg encoder process is currently attached to this camera.
   *
   * @returns {boolean}
   */
  hasEncoderProcess() {
    return Boolean(this.enc);
  }

  /**
   * Returns true if the attached FFmpeg encoder has a writable stdin pipe.
   *
   * @returns {boolean}
   */
  hasWritableEncoderStdin() {
    return Boolean(this.enc && this.enc.stdin && this.enc.stdin.writable);
  }

  /**
   * Returns true if the attached FFmpeg encoder stdin pipe is currently applying backpressure.
   *
   * @returns {boolean}
   */
  isEncoderStdinBackpressured() {
    return Boolean(this.enc && this.enc.stdin && this.enc.stdin.writableNeedDrain);
  }

  /**
   * Returns true if the encoder has not accepted a frame within timeoutMs.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [timeoutMs=10000] - Wedged timeout threshold in milliseconds.
   * @returns {boolean}
   */
  isEncoderWedged(now = Date.now(), timeoutMs = DEFAULT_ENCODER_WEDGED_TIMEOUT_MS) {
    return Boolean(now - this.lastWrite > timeoutMs);
  }

  /**
   * Force-kills a wedged FFmpeg encoder process with SIGKILL.
   */
  killWedgedEncoder() {
    if (!Camera.canSignalProcess(this.enc)) {
      return;
    }
    try {
      this.enc.kill(PROCESS_SIGNALS.SIGKILL);
    } catch (err) {
      // Ignore kill errors on wedged encoder.
    }
  }

  /**
   * Selects the source YUV420p frame buffer to feed to the camera's encoder (raw live video,
   * clean snapshot fallback, waking card, busy card, or asleep card).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [freshFrameMaxAgeMs=DEFAULT_FRESH_FRAME_MAX_AGE_MS] - Maximum age of a live frame in milliseconds.
   * @returns {{ frame: Uint8Array, isLive: boolean }}
   */
  selectEncoderFrame(now = Date.now(), freshFrameMaxAgeMs = DEFAULT_FRESH_FRAME_MAX_AGE_MS) {
    this.getSessionState(now);
    if (this.isStreamingLive(now, freshFrameMaxAgeMs)) {
      const rawLiveFrame = this.hasFreshFrame(now, freshFrameMaxAgeMs) ? this.frame : this.lastFrame;
      return {frame: rawLiveFrame, isLive: true};
    }
    if (this.card.suppressLiveCard && Buffer.isBuffer(this.lastFrame)) {
      return {frame: this.lastFrame, isLive: false};
    }
    if (Buffer.isBuffer(this.lastFrame) && this.lastRenderedSnapshot !== this.lastFrame && this.renderCardsFn) {
      this.renderCardsFn(this);
    }
    if (this.session.active && !this.isBackfillPlayback() && !this.isRtspDirect()) {
      return {frame: this.card.waking, isLive: false};
    }
    if (this.isWaitingForSlotOrBackfill(now, freshFrameMaxAgeMs)) {
      return {frame: this.card.busy, isLive: false};
    }
    return {frame: this.card.asleep, isLive: false};
  }

  /**
   * Returns true if the given selected frame buffer differs from the last frame buffer sent to the encoder.
   *
   * @param {Uint8Array|null} frame - Selected source frame buffer.
   * @returns {boolean}
   */
  hasEncoderSourceChanged(frame) {
    return frame !== this.lastSent;
  }

  /**
   * Determines whether a frame should be written to the FFmpeg encoder stdin on the current tick.
   *
   * @param {boolean} isLive - Whether the camera is currently streaming live video.
   * @param {boolean} stateChanged - Whether the selected frame buffer changed since last write.
   * @param {boolean} inBurst - Whether the camera is in a keyframe burst window.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} liveFps - Target live frame rate.
   * @param {number} idleFps - Target sleeping card frame rate.
   * @param {number} [downloadPaceLeadMs=DEFAULT_DOWNLOAD_PACE_LEAD_MS] - Pacing lead margin (ms)
   *   during backfill playback.
   * @param {number} [liveHeartbeatWriteMs=DEFAULT_LIVE_HEARTBEAT_WRITE_MS] - Maximum interval
   *   between live frame writes in ms.
   * @returns {boolean}
   */
  shouldWriteEncoderFrame(
    isLive,
    stateChanged,
    inBurst,
    now,
    liveFps,
    idleFps,
    downloadPaceLeadMs = DEFAULT_DOWNLOAD_PACE_LEAD_MS,
    liveHeartbeatWriteMs = DEFAULT_LIVE_HEARTBEAT_WRITE_MS
  ) {
    const elapsedMs = now - this.lastWrite;
    const livePaceMs = Math.floor(MS_PER_SECOND / liveFps) - downloadPaceLeadMs;
    const liveIntervalMs = this.isBackfillPlayback() || inBurst ? livePaceMs : liveHeartbeatWriteMs;
    return isLive
      ? Boolean(this.frameNew || stateChanged || elapsedMs >= liveIntervalMs)
      : Boolean(stateChanged || inBurst || elapsedMs >= MS_PER_SECOND / idleFps);
  }

  /**
   * Writes an encoded output frame to the FFmpeg encoder stdin and updates lastWrite/lastSent/frameNew.
   *
   * @param {Uint8Array} outFrame - Frame buffer to write to stdin (with optional live card overlay).
   * @param {Uint8Array} rawFrame - Underlying source frame buffer for change tracking.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   */
  writeEncoderVideoFrame(outFrame, rawFrame, now = Date.now()) {
    if (this.enc && this.enc.stdin && this.enc.stdin.writable) {
      this.enc.stdin.write(outFrame);
      this.markFrameEncoded(rawFrame, now);
    }
  }

  /**
   * Writes one 100ms PCM audio chunk (or silence) to the FFmpeg encoder audio pipe (stdio[3]) when writable.
   *
   * @param {number} chunkBytes - Audio chunk size in bytes.
   * @param {Uint8Array} silenceBuf - Pre-allocated silence buffer.
   */
  writeEncoderAudioTick(chunkBytes, silenceBuf) {
    const enc = this.enc;
    if (!enc || !enc.stdio || !enc.stdio[3] || !enc.stdio[3].writable || enc.stdio[3].writableNeedDrain) {
      return;
    }
    enc.stdio[3].write(this.consumeAudioChunk(chunkBytes, silenceBuf));
  }

  /**
   * Returns true if a new frame or a due buffered download frame is waiting when encoder stdin drains.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [frameIntervalMs=DEFAULT_LIVE_FRAME_PACE_MS] - Minimum interval between
   *   download frames in milliseconds.
   * @returns {boolean}
   */
  shouldDrainEncoderOnReady(now = Date.now(), frameIntervalMs = DEFAULT_LIVE_FRAME_PACE_MS) {
    return Boolean(
      this.frameNew ||
      this.canAdvanceDownloadFrame(now, frameIntervalMs) ||
      this.canAdvanceLiveFrame(now, frameIntervalMs)
    );
  }

  /**
   * Resolves the effective hardware acceleration mode for this camera's encoder.
   *
   * @param {string} globalHwaccel - Global hardware acceleration mode from config.
   * @returns {string}
   */
  resolveActiveHwaccel(globalHwaccel) {
    return this.useHwaccel ? String(globalHwaccel || '') : '';
  }

  /**
   * Disables hardware acceleration on this camera after a hardware encoder failure so it falls back
   * to software libx264.
   */
  disableHwaccel() {
    this.useHwaccel = false;
  }

  /**
   * Clears this.enc if it matches the exiting encoder process.
   *
   * @param {*} enc - Exiting FFmpeg encoder process.
   * @returns {boolean} True if matched and cleared.
   */
  detachEncoderIfMatch(enc) {
    if (this.enc === enc) {
      this.enc = null;
      this.encoderConsumerConnected = false;
      return true;
    }
    return false;
  }

  /**
   * Returns true if a per-session FFmpeg decoder process is currently attached to this camera.
   *
   * @returns {boolean}
   */
  hasDecoderProcess() {
    return this.session.hasDecoderProcess();
  }

  /**
   * Clears this.dec (and optionally decSpawnedAt) if it matches the exiting decoder process.
   *
   * @param {*} dec - Exiting FFmpeg decoder process.
   * @param {boolean} [clearSpawnedAt=false] - Whether to reset decSpawnedAt = 0.
   * @returns {boolean} True if matched and cleared.
   */
  detachDecoderIfMatch(dec, clearSpawnedAt = false) {
    return this.session.detachDecoderIfMatch(dec, clearSpawnedAt);
  }

  /**
   * Returns true if an exiting P2P/backfill FFmpeg decoder still has a paused or unread stdout
   * stream that must finish draining into downloadFrames before this.dec is detached.
   *
   * @param {*} dec - Exiting FFmpeg decoder process.
   * @returns {boolean}
   */
  shouldDeferDecoderDetachOnExit(dec) {
    return this.session.shouldDeferDecoderDetachOnExit(dec);
  }

  /**
   * Returns true if a paused backfill decoder stdout stream is already at or below
   * DOWNLOAD_FRAME_LOW_WATERMARK when the decoder process exits and should be resumed immediately.
   *
   * @returns {boolean}
   */
  shouldResumePausedDecoderOnExit() {
    return Boolean(this.session.decoderStdoutPaused && this.backfill.frames.length <= DOWNLOAD_FRAME_LOW_WATERMARK);
  }

  /**
   * Returns the visual frame stage marker (FRAME_STAGE_MARKERS.SNAPSHOT for sleeping/snapshot frame,
   * FRAME_STAGE_MARKERS.FIRST_BACKFILL for First Backfill Frame 0, FRAME_STAGE_MARKERS.BACKFILL for
   * subsequent Backfill video frames, or FRAME_STAGE_MARKERS.LIVE for Live stream).
   *
   * @returns {'S'|'FB'|'B'|'L'}
   */
  getFrameMarker() {
    if (!this.session.active) {
      return this.backfill.continuation && this.hasPendingBackfill()
        ? FRAME_STAGE_MARKERS.BACKFILL
        : FRAME_STAGE_MARKERS.SNAPSHOT;
    }
    return this.isBackfillPlayback()
      ? this.backfill.playedFrames > FIRST_BACKFILL_PLAYED_FRAME_COUNT || this.backfill.continuation
        ? FRAME_STAGE_MARKERS.BACKFILL
        : FRAME_STAGE_MARKERS.FIRST_BACKFILL
      : FRAME_STAGE_MARKERS.LIVE;
  }

  /**
   * Clears any pending RTSP decoder retry timer on this camera.
   */
  clearRtspRetryTimer() {
    this.session.clearRtspRetryTimer();
  }

  /**
   * Schedules an RTSP decoder retry timer after delayMs, replacing any existing retry timer.
   *
   * @param {number} delayMs - Delay before retry in milliseconds.
   * @param {() => void} onRetry - Callback invoked when the retry timer fires.
   */
  scheduleRtspDecoderRetry(delayMs, onRetry) {
    this.session.scheduleRtspDecoderRetry(delayMs, onRetry);
  }

  /**
   * Builds the rendering context needed by renderCameraCards() without exposing internal sub-models.
   *
   * @returns {Readonly<{
   *   asleepTitle: string,
   *   cardConfig: { theme: string, position: string, sleepScreen: string },
   *   lastFrame: Uint8Array|null,
   *   status: Record<string, *>,
   *   asleepBuf: Uint8Array,
   *   wakingBuf: Uint8Array|null,
   *   busyBuf: Uint8Array|null,
   * }>}
   */
  prepareCardRenderContext() {
    const lowBat = this.isLowBattery();
    const disrupted = this.hasServiceDisruption();
    const asleepTitle = disrupted
      ? CARD_STATUS_TITLES.DISCONNECTED
      : lowBat
        ? CARD_STATUS_TITLES.ASLEEP_LOW_BATTERY
        : CARD_STATUS_TITLES.ASLEEP;
    const status = this.telemetry.toStatusSnapshot(this.card.config);
    status.cam = this;
    return Object.freeze({
      asleepTitle,
      cardConfig: this.card.config,
      lastFrame: this.lastFrame,
      status,
      asleepBuf: this.card.asleep,
      wakingBuf: this.card.peekWakingBuffer(),
      busyBuf: this.card.peekBusyBuffer(),
    });
  }

  /**
   * Stores the rendered card buffers on this camera's StatusCard and triggers a short keyframe burst.
   *
   * @param {{ asleep: Uint8Array, waking?: Uint8Array|null, busy?: Uint8Array|null }} rendered - Rendered card buffers.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [burstMs=SHORT_KEYFRAME_BURST_MS] - Keyframe burst duration in milliseconds.
   */
  commitRenderedCards(rendered, now = Date.now(), burstMs = SHORT_KEYFRAME_BURST_MS) {
    this.lastRenderedSnapshot = this.lastFrame;
    this.card.setRenderedFrames(rendered);
    if (!this.isBackfillPlayback()) {
      this.triggerKeyframeBurst(now, burstMs);
    }
  }

  /**
   * Returns true if the corner status card should be composited onto live video frames.
   *
   * @returns {boolean}
   */
  shouldOverlayCardOnLive() {
    return this.card.shouldOverlayOnLive();
  }

  /**
   * Returns true when this camera uses the diagnostic "hud" theme and is not
   * currently suppressing its overlay for a clean Frigate event snapshot.
   *
   * @returns {boolean}
   */
  hasDynamicDebugCard() {
    return Boolean(this.card.theme === CARD_THEMES.HUD && !this.card.suppressLiveCard);
  }

  /**
   * Captures every value the diagnostic "hud" theme prints as one immutable plain object, so the formatter in
   * `camera/debug-hud.js` never reaches into this Camera.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {Readonly<import("./camera/debug-hud").DebugHudSnapshot>}
   */
  getDebugHudSnapshot(now = Date.now()) {
    const wantUntilMs = this.wantUntil();
    const bfJob = this.backfill.pending || this.backfill.active;
    const tel = this.telemetry;
    return Object.freeze({
      sessionState: this.sessionLifecycle.getState(),
      prevSessionState: this.sessionLifecycle.getPrevState(),
      sessionStateChangedAt: this.sessionLifecycle.getChangedAt(),
      decoderState: this.session.decoderState,
      holdUntilMs: this.session.active && Number.isFinite(wantUntilMs) ? wantUntilMs : null,
      live: Boolean(this.session.active || this.isInKeyframeBurst(now)),
      measuredFps: this.measuredFps,
      backfillState: bfJob && bfJob.getState() ? bfJob.getState() : '',
      backfillAttempts: bfJob ? bfJob.getQueryAttempts() || 0 : 0,
      backfillWaitSince:
        this.backfill.pending && !this.backfill.clip ? this.backfill.pending.getTriggerAt() || 0 : null,
      backfillClipQueueLength: this.backfill.clipQueue.length,
      wsOk: this.isRtspDirect() || Boolean(tel.wsConnected),
      stationOk: !this.isDeviceOffline() && Boolean(tel.stationConnected),
      frigateOk: Boolean(tel.frigateConnected),
      go2rtcOk: Boolean(tel.go2rtcConnected),
      liveQueueLength: this.liveFrames.length,
      downloadQueueLength: this.backfill.frames.length,
      droppedFrames: this.session.droppedFrames || 0,
      restarts: this.session.restarts || 0,
      lightOn: tel.isLightOn(),
      battery: tel.battery,
      charging: Boolean(tel.charging),
      lowBattery: this.isLowBattery(),
      wifi: tel.wifi,
      rssi: tel.rssi,
      idleRssiChangeCount: this.idleRssiChangeCount || 0,
      temp: tel.temp,
      hwPowerMode: tel.hwPowerMode,
      hwClipLength: tel.hwClipLength,
      hwEndEarly: tel.hwEndEarly,
      hwQuality: tel.hwQuality,
      rtspEnabled: Boolean(this.useRtsp && (this.rtspUrl || this.rtspSupported)),
      lastSeen: tel.lastSeen,
      active: Boolean(this.session.active),
      activeMode: this.session.mode,
      lastMotionAt: this.session.lastMotionAt,
      lastVideoAt: this.session.lastVideoAt,
      wakingViewers: this.viewerSet.wakingCount(),
      viewers: this.viewerSet.count(),
      triggersActive: this.hasActiveHardwareTriggers(now),
      motionClearedAt: this.session.motionClearedAt,
      stoppingP2p: Boolean(this.stoppingP2p),
      eventState: this.eventFiling.state,
      eventUntil: this.eventFiling.until,
      lastCreatedEventId: this.eventFiling.lastCreatedId,
      downloadPlayedFrames: this.backfill.playedFrames || 0,
      downloadDecodedFrames: this.backfill.decodedFrames || 0,
      backfillContinuation: Boolean(this.backfill.continuation),
      wakeInitiator: this.session.initiator,
    });
  }

  /**
   * Builds 4 fixed-width monospace diagnostic text lines for the "hud" diagnostic theme.
   * Every field is padded to a constant column width so text never shifts horizontally when values change.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {ReadonlyArray<string>}
   */
  buildDebugHudLines(now = Date.now()) {
    return formatDebugHudLines(this.getDebugHudSnapshot(now), now);
  }

  /**
   * Prepares the alternating scratch buffer and visual state needed to composite a corner status card onto rawFrame.
   *
   * @param {Uint8Array} rawFrame - Source decoded YUV420p video frame.
   * @returns {Readonly<{ out: Uint8Array, theme: string, position: string, st: Record<string, *> }>}
   */
  prepareLiveCardOverlay(rawFrame) {
    const out = this.card.prepareLiveOverlayBuffer(rawFrame);
    const isBackfill = this.isBackfillPlayback() || this.backfill.continuation;
    const statusTitle = isBackfill ? CARD_STATUS_TITLES.BACKFILL : CARD_STATUS_TITLES.LIVE;
    const st = this.telemetry.evaluateVisualState(statusTitle);
    return Object.freeze({
      out,
      theme: this.card.theme,
      position: this.card.position,
      st,
    });
  }

  /**
   * Updates session timing state when a decoded RTSP frame arrives and returns transition metadata.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {{ isFirstVideo: boolean, isRewakeResume: boolean, elapsedSec: string }}
   */
  markRtspFrameReceived(now) {
    this.telemetry.markDeviceOnline();
    if (this.isRtspDirect()) {
      if (this.updateServiceHealth({stationConnected: true}) && this.renderCardsFn) {
        this.renderCardsFn(this);
      }
      this.session.motionUntil = Math.max(this.session.motionUntil, now + this.getEventHoldMs());
      this.session.lastMotionAt = now;
    }
    const wasRewaking = this.session.rtspRewaking;
    const result = this.session.markRtspFrameReceived(now);
    if (this.isActiveRtspSession()) {
      this.transitionTo(
        SESSION_STATES.STREAMING_LIVE,
        now,
        wasRewaking ? 'rtsp re-wake frame received' : 'first rtsp frame received'
      );
    }
    return result;
  }

  /**
   * Updates session timing state when an incoming P2P video packet is ingested.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {{ isFirstVideo: boolean, elapsedSec: string }}
   */
  markP2pVideoPacketReceived(now) {
    if (this.isBackfillPlayback()) {
      this.backfill.videoPackets++;
    } else {
      this.telemetry.markDeviceOnline();
    }
    return this.session.markP2pVideoPacketReceived(now);
  }

  /**
   * Returns true if an active decoder is running and the incoming stream codec changed.
   *
   * @param {string} codec - Incoming video codec string.
   * @returns {boolean}
   */
  hasCodecChanged(codec) {
    return this.session.hasCodecChanged(codec);
  }

  /**
   * Updates the current session video codec and resolution metadata.
   *
   * @param {string} codec - Video codec name.
   * @param {number} width - Video width in pixels.
   * @param {number} height - Video height in pixels.
   */
  updateStreamFormat(codec, width, height) {
    this.session.updateStreamFormat(codec, width, height);
  }

  /**
   * Attaches a spawned FFmpeg decoder process to this camera and transitions decoderState to HANDSHAKING.
   *
   * @param {*} dec - Spawned FFmpeg ChildProcess.
   * @param {number} [spawnedAt=0] - Spawn timestamp in milliseconds (for RTSP handshake tracking).
   */
  attachDecoder(dec, spawnedAt = 0) {
    this.session.attachDecoder(dec, spawnedAt);
  }

  /**
   * Clears any pending RTSP retry timer, resets decoder/A/V session buffers, transitions
   * decoderState to DETACHED, and returns the detached FFmpeg decoder process (if any).
   *
   * @returns {*} Detached FFmpeg ChildProcess or null.
   */
  detachDecoder() {
    const dec = this.session.detachDecoder();
    this.liveFrames = [];
    this.frame = null;
    this.frameNew = false;
    this.audioQueue.clear();
    return dec;
  }

  /**
   * Updates stationSerial and auto-discovered rtspUrl from device properties when useRtsp is enabled,
   * returning true if a new RTSP URL was discovered.
   *
   * @param {*} stationSn - Unwrapped stationSerialNumber property.
   * @param {*} rtspUrlProp - Unwrapped rtspStreamUrl property.
   * @returns {boolean} True if a new rtspUrl was discovered.
   */
  updateDiscoveredRtspConfig(stationSn, rtspUrlProp) {
    if (stationSn && typeof stationSn === 'string') {
      this.stationSerial = stationSn;
    }
    if (
      !this.isDoorbell() &&
      this.useRtsp &&
      rtspUrlProp &&
      typeof rtspUrlProp === 'string' &&
      !this.directRtsp &&
      this.rtspUrl !== rtspUrlProp
    ) {
      this.rtspUrl = rtspUrlProp;
      this.rtspSupported = true;
      return true;
    }
    return false;
  }

  /**
   * Returns the current Frigate event lifecycle state (FRIGATE_EVENT_STATES), automatically
   * advancing COOLDOWN to IDLE once evUntil has elapsed.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  getFrigateEventState(now = Date.now()) {
    return this.eventFiling.refresh(now);
  }

  /**
   * Returns the current monotonic Frigate event wait token queued on this camera.
   *
   * @returns {number}
   */
  getFrigateEventWaitId() {
    return this.eventFiling.waitId;
  }

  /**
   * Returns true if the given Frigate event wait token is still the active in-flight WAITING_SNAPSHOT request.
   *
   * @param {number} waitId - Frigate event wait token captured when queued.
   * @returns {boolean}
   */
  isFrigateSnapshotWaitActive(waitId) {
    return this.eventFiling.isSnapshotWaitActive(waitId);
  }

  /**
   * Aborts any queued or in-flight WAITING_SNAPSHOT Frigate event filing and resets the event state to IDLE.
   *
   * @param {string} [reason='session ended without video'] - Diagnostic reason for FSM transition.
   */
  abortPendingFrigateEvent(reason = 'session ended without video') {
    this.eventFiling.abort(reason);
  }

  /**
   * Transitions the Frigate event FSM from QUEUED to WAITING_SNAPSHOT when the dispatch timer fires,
   * returning false if the pending event wait was already aborted.
   *
   * @param {number} [waitId=this.eventFiling.waitId] - Expected Frigate event wait token.
   * @returns {boolean} True if transitioned to WAITING_SNAPSHOT.
   */
  beginFrigateSnapshotWait(waitId = this.eventFiling.waitId) {
    return this.eventFiling.beginSnapshotWait(waitId);
  }

  /**
   * Returns true if the camera's active hold window or buffered backfill playback extends
   * past the currently filed Frigate API event window (evUntil) by more than marginMs,
   * requiring a follow-up Frigate event creation so Frigate continues recording the full stream.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [liveFps=15] - Output playback frame rate.
   * @param {number} [marginMs=DEFAULT_EVENT_EXTEND_MARGIN_MS] - Minimum extension margin in milliseconds.
   * @returns {boolean}
   */
  shouldExtendFrigateEvent(now = Date.now(), liveFps = LIVE_FPS, marginMs = DEFAULT_EVENT_EXTEND_MARGIN_MS) {
    if (
      !this.session.active ||
      this.eventFiling.hasPendingDispatch() ||
      (!this.eventActive && !this.isBackfillPlayback())
    ) {
      return false;
    }
    const targetUntil = this.isBackfillPlayback()
      ? now + this.getEffectiveEventDurationSecs(liveFps, now) * MS_PER_SECOND
      : this.wantUntil();
    return targetUntil > Math.max(now, this.eventFiling.until || 0) + marginMs;
  }

  /**
   * Evaluates a new Frigate event request against any in-flight or active event window,
   * upgrading the label/person in-place if pending or queuing a new/extended event when
   * the session hold extends past evUntil or upgrades label/person.
   *
   * @param {string} label - Resolved Frigate event label.
   * @param {string} [personName=''] - Recognized person name.
   * @param {number} [now=Date.now()] - Epoch timestamp in milliseconds.
   * @returns {Readonly<{ status: 'upgraded'|'cooldown'|'queued', upgradedLabel: boolean, attachedPerson: boolean }>}
   */
  tryUpgradeOrQueueFrigateEvent(label, personName = '', now = Date.now()) {
    return this.eventFiling.request({
      label,
      personName,
      now,
      shouldExtend: () => this.shouldExtendFrigateEvent(now),
    });
  }

  /**
   * Computes the Frigate event duration in seconds, scaling up to cover the remaining
   * live session hold window (wantUntil - now) or the buffered backfill clip duration.
   *
   * @param {number} [liveFps=15] - Output playback frame rate.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {number}
   */
  getEffectiveEventDurationSecs(liveFps = LIVE_FPS, now = Date.now()) {
    if (this.isBackfillPlayback()) {
      const remainingFromPackets = Math.max(
        0,
        Math.max(this.backfill.decodedFrames, this.backfill.videoPackets) - this.backfill.playedFrames
      );
      const remainingFrames = Math.max(
        this.backfill.frames.length + this.session.pendingVideoPackets.length + 1,
        remainingFromPackets
      );
      return (
        Math.max(this.timers.eventSecs, Math.ceil(remainingFrames / Math.max(1, liveFps))) +
        DOWNLOAD_EVENT_DURATION_MARGIN_SECS
      );
    }
    const remainingHoldSecs = this.session.active ? Math.ceil(Math.max(0, this.wantUntil() - now) / MS_PER_SECOND) : 0;
    return Math.max(this.timers.eventSecs, remainingHoldSecs);
  }

  /**
   * Marks a pending Frigate event as dispatched and sets the event cooldown window.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [liveFps=LIVE_FPS] - Output playback frame rate for backfill duration scaling.
   * @returns {Readonly<{ finalLabel: string, finalPerson: string, subLabel: string|null, durationSecs: number }>}
   */
  completeFrigateEventFiling(now = Date.now(), liveFps = LIVE_FPS) {
    return this.eventFiling.complete(now, this.getEffectiveEventDurationSecs(liveFps, now));
  }

  /**
   * Rolls back a failed Frigate event HTTP POST so follow-up triggers are not stranded in cooldown.
   *
   * @param {number} waitId - Wait token of the failed filing attempt.
   * @param {string} [reason='event filing failed'] - Diagnostic rollback reason.
   * @returns {boolean}
   */
  rollbackFrigateEventFiling(waitId, reason = 'event filing failed') {
    return this.eventFiling.rollback(waitId, reason);
  }

  /**
   * Registers a newly connected go2rtc consumer ID and triggers a short keyframe burst.
   *
   * @param {string|number} id - Consumer identifier from go2rtc.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   */
  registerNewViewer(id, now = Date.now()) {
    this.viewerSet.register(id);
    this.triggerKeyframeBurst(now, SHORT_KEYFRAME_BURST_MS);
  }

  /**
   * Removes go2rtc consumer IDs that are no longer present in seenIds, updates the viewer total,
   * and returns the list of disconnected viewer descriptors.
   *
   * @param {Set<string|number>} seenIds - Set of currently connected consumer IDs.
   * @param {number} totalViewers - Total active non-recorder viewer count.
   * @returns {Array<{ id: string|number, wasActiveViewer: boolean }>} Disconnected viewers.
   */
  pruneDisconnectedViewers(seenIds, totalViewers) {
    return this.viewerSet.prune(seenIds, totalViewers);
  }

  /**
   * Builds the JSON payload sent to the Home Assistant webhook.
   *
   * @param {Record<string, *>} [extra={}] - Additional fields (event_id, review_id, no_video).
   * @returns {Record<string, *>}
   */
  toHaWebhookPayload(extra = {}) {
    /** @type {Record<string, *>} */
    const payload = {
      camera: this.name,
      title: this.getDisplayTitle(),
      label: this.eventFiling.label,
      ...extra,
    };
    if (this.eventFiling.person) {
      payload.person = this.eventFiling.person;
    }
    return payload;
  }

  /**
   * Extends an active camera hold timer by half of its base hold duration up to maxMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [minExtendMs=DEFAULT_MIN_EXTEND_MS] - Minimum hold extension in milliseconds.
   * @param {boolean} [capAtFullHold=true] - Whether to cap the new hold at now + baseHoldMs.
   * @returns {Readonly<{ extended: boolean, extendMs: number, holdSecs: number }>}
   */
  extendActiveHold(now, minExtendMs = DEFAULT_MIN_EXTEND_MS, capAtFullHold = true) {
    const res = this.session.extendActiveHold(now, {
      baseHoldMs: this.getEventHoldMs(),
      minExtendMs,
      capAtFullHold,
      hasActiveTriggers: this.hasActiveHardwareTriggers(now),
    });
    if (res.extended) {
      this.clearPendingBackfill();
    }
    return res;
  }

  /**
   * Computes the target expiration timestamp for a motion or view trigger, guaranteeing
   * at least a full hold window (now + ms) and extending an already-active stream by
   * half-hold (ms / 2) up to maxMs (while coalescing simultaneous companion bursts).
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} ms - Requested hold duration in milliseconds.
   * @param {number} [minExtendMs=DEFAULT_MIN_EXTEND_MS] - Minimum trigger extension in milliseconds.
   * @param {boolean} [isMidStream=false] - Whether this trigger is extending an active mid-stream session.
   * @param {boolean} [isCompanionBurst=false] - Whether this trigger arrived within 1s of the previous trigger.
   * @returns {number}
   */
  computeTriggerHoldUntil(now, ms, minExtendMs = DEFAULT_MIN_EXTEND_MS, isMidStream = false, isCompanionBurst = false) {
    return this.session.computeTriggerHoldUntil(now, ms, {minExtendMs, isMidStream, isCompanionBurst});
  }

  /**
   * Applies an immutable WakeRequest built via WakeRequest.motion() or WakeRequest.view().
   *
   * @param {ReturnType<WakeRequest['build']>} req - Frozen WakeRequest object.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @returns {Readonly<{ accepted: boolean, shouldLog: boolean, isDebug: boolean, message: string }>}
   */
  applyWakeRequest(req, now = Date.now(), allCams = []) {
    if (!req || typeof req !== 'object') {
      return Object.freeze({accepted: false, shouldLog: false, isDebug: false, message: ''});
    }
    let res;
    switch (req.kind) {
      case WAKE_KINDS.MOTION:
        res = this.applyMotionTrigger(now, req.reason, req.durationMs, req.initiator, req.priority);
        break;
      default:
        res = this.applyViewTrigger(now, req.reason, req.durationMs, req.initiator, allCams);
        break;
    }
    return Object.freeze({accepted: true, ...res});
  }

  /**
   * Applies a motion/event wake or mid-stream hold extension to this camera and returns
   * optional log metadata when the camera is already live.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} reason - Trigger reason description.
   * @param {number} ms - Requested hold duration in milliseconds.
   * @param {string} [initiator='eufy-event'] - Trigger initiator tag.
   * @param {number} [evPriority=DEFAULT_EVENT_PRIORITY] - Event priority boost score.
   * @param {number} [midStreamGraceMs=DEFAULT_MID_STREAM_GRACE_MS] - Grace window after session
   *   start before half-hold extension applies.
   * @param {number} [minExtendMs=DEFAULT_MIN_EXTEND_MS] - Minimum mid-stream extension in milliseconds.
   * @param {number} [debounceMs=DEFAULT_TRIGGER_LOG_DEBOUNCE_MS] - Log debounce window for companion events.
   * @returns {{ shouldLog: boolean, isDebug: boolean, message: string }}
   */
  applyMotionTrigger(
    now,
    reason,
    ms,
    initiator = 'eufy-event',
    evPriority = DEFAULT_EVENT_PRIORITY,
    midStreamGraceMs = DEFAULT_MID_STREAM_GRACE_MS,
    minExtendMs = this.getSustainedLiveVideoCutoffMs(),
    debounceMs = DEFAULT_TRIGGER_LOG_DEBOUNCE_MS
  ) {
    if (now >= this.wantUntil()) {
      this.session.reason = reason;
      this.session.initiator = initiator;
    }
    if (!this.isInMotion(now) && !this.session.active) {
      this.session.reason = reason;
      this.session.initiator = initiator;
      this.eventPriority = evPriority;
    } else if (evPriority >= (this.eventPriority || 0)) {
      this.eventPriority = evPriority;
      this.session.reason = reason;
    }

    const prevMotionAt = this.session.lastMotionAt || 0;
    const prevPriority = this.eventPriority || 0;
    const isCompanionBurst = prevMotionAt > 0 && now - prevMotionAt < COMPANION_EVENT_BURST_MS;
    const videoStartRef = this.session.firstFrameAt || this.session.firstVideoAt;
    const hasSustainedLiveVideo =
      this.isActiveLiveSession() && this.session.gotVideo && videoStartRef > 0 && now - videoStartRef >= minExtendMs;
    const isMidStream = hasSustainedLiveVideo && now - this.session.startedAt > midStreamGraceMs;
    const targetUntil = this.computeTriggerHoldUntil(now, ms, minExtendMs, isMidStream, isCompanionBurst);
    this.eventActive = true;
    this.session.motionUntil = Math.max(this.session.motionUntil, targetUntil);
    this.session.lastMotionAt = now;
    if (hasSustainedLiveVideo) {
      this.session.runtimeExtended = true;
      this.clearPendingBackfill();
    }

    if (!this.session.active) {
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
   * @param {string} [initiator='frigate-viewer'] - Trigger initiator tag.
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @param {number} [midStreamGraceMs=DEFAULT_MID_STREAM_GRACE_MS] - Grace window after session
   *   start before half-hold extension applies.
   * @param {number} [minExtendMs=DEFAULT_MIN_EXTEND_MS] - Minimum mid-stream extension in milliseconds.
   * @param {number} [debounceMs=DEFAULT_TRIGGER_LOG_DEBOUNCE_MS] - Log debounce window for repeated api-wake calls.
   * @returns {{ shouldLog: boolean, isDebug: boolean, message: string }}
   */
  applyViewTrigger(
    now,
    reason,
    ms,
    initiator = 'frigate-viewer',
    allCams = [],
    midStreamGraceMs = DEFAULT_MID_STREAM_GRACE_MS,
    minExtendMs = DEFAULT_MIN_EXTEND_MS,
    debounceMs = DEFAULT_TRIGGER_LOG_DEBOUNCE_MS
  ) {
    if (now >= this.wantUntil()) {
      this.session.reason = reason;
      this.session.initiator = initiator;
    }
    if (!this.isRtspCapable() && now >= this.session.viewUntil) {
      const stationKey = this.getStationKey();
      for (const other of allCams) {
        if (other !== this && other.belongsToStationP2pSlot(stationKey) && other.hasPendingViewerWake()) {
          other.clearViewerQueue('superseded by P2P viewer on ' + this.name);
        }
      }
    }
    if (now >= this.session.viewUntil) {
      this.session.viewSince = now;
    }
    const isMidStreamView =
      this.isActiveLiveSession() &&
      now - this.session.startedAt > midStreamGraceMs &&
      (initiator === 'eufy-ws' || initiator === 'api-wake');
    const targetViewUntil = this.computeTriggerHoldUntil(now, ms, minExtendMs, isMidStreamView);
    this.session.viewUntil = Math.max(this.session.viewUntil, targetViewUntil);
    if (isMidStreamView) {
      this.session.runtimeExtended = true;
      this.clearPendingBackfill();
    }

    if (!this.isActiveLiveSession() || initiator !== 'api-wake') {
      return {shouldLog: false, isDebug: false, message: ''};
    }

    const holdSecs = Math.round((this.wantUntil() - now) / 1000);
    const isDebug = now - (this.lastApiTriggerLogAt || 0) < debounceMs;
    this.lastApiTriggerLogAt = now;
    const message =
      'activity trigger "' + reason + '" (initiator=api-wake, already live, holdExtendedTo=' + holdSecs + 's)';
    return {shouldLog: true, isDebug, message};
  }

  /**
   * Returns true if this camera should yield its viewer queue (and stop if active without motion)
   * when a human viewer opens newestViewerCam on the same station.
   *
   * @param {Camera|null|undefined} newestViewerCam - Camera newly opened by a human viewer.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  shouldYieldToNewStationViewer(newestViewerCam, now = Date.now()) {
    const isEligibleOnSameStation = Boolean(
      newestViewerCam &&
      this !== newestViewerCam &&
      this.getStationKey() === newestViewerCam.getStationKey() &&
      !this.isInMotion(now) &&
      !this.isBackfillPlayback()
    );
    return isEligibleOnSameStation ? !newestViewerCam.isRtspCapable() && !this.isRtspCapable() : false;
  }

  /**
   * Forgets every active Eufy hardware trigger entry.
   */
  _clearActiveHardwareTriggers() {
    this.hardwareTriggers.clearAll();
  }

  /**
   * Prunes active Eufy hardware trigger entries whose age exceeds maxAgeMs (Eufy max clip length + margin).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [maxAgeMs] - Maximum trigger age before expiry in ms (defaults to the ledger maximum).
   */
  expireStaleHardwareTriggers(now = Date.now(), maxAgeMs = undefined) {
    this.hardwareTriggers.expireStale(now, maxAgeMs);
  }

  /**
   * Returns true if Eufy hardware trigger events (motion/person/ring) are still reported as active,
   * have not cleared since the latest motion trigger timestamp, and have not exceeded maxAgeMs.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [maxAgeMs] - Maximum trigger age before expiry in ms (defaults to the ledger maximum).
   * @returns {boolean}
   */
  hasActiveHardwareTriggers(now = Date.now(), maxAgeMs = undefined) {
    return !this.hardwareTriggers.isEmpty() && this.session.motionClearedAt <= this.session.lastMotionAt
      ? this.hardwareTriggers.hasUnexpired(now, maxAgeMs)
      : false;
  }

  /**
   * Returns true if an active motion-woken RTSP stream has already played at least minVideoMs
   * of video, satisfied its full configured hold duration (getEventHoldMs) since the latest
   * motion trigger, Eufy hardware trigger events cleared at least settleMs ago, and Frigate
   * has not reported recent object activity.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [settleMs=DEFAULT_MOTION_CLEAR_SETTLE_MS] - Post-clear settle duration in milliseconds.
   * @param {number} [minVideoMs=DEFAULT_MIN_EVENT_VIDEO_MS] - Minimum event video duration in milliseconds.
   * @returns {boolean}
   */
  didRtspMotionStreamFinishCleanly(
    now = Date.now(),
    settleMs = DEFAULT_MOTION_CLEAR_SETTLE_MS,
    minVideoMs = DEFAULT_MIN_EVENT_VIDEO_MS
  ) {
    return Boolean(
      this.session.gotVideo &&
      this.session.firstVideoAt > 0 &&
      now - this.session.firstVideoAt >= minVideoMs &&
      now - this.session.lastMotionAt >= this.getEventHoldMs() &&
      this.session.motionClearedAt > this.session.lastMotionAt &&
      now - this.session.motionClearedAt >= settleMs &&
      !this.hasRecentFrigateObjectActivity(now)
    );
  }

  /**
   * Returns true if an active RTSP session that dropped mid-stream should immediately re-wake
   * (requires end_early=false, unexpired wantUntil or active hardware/Frigate activity within max duration,
   * and either a connected viewer, active hardware triggers, recent Frigate object activity, or active
   * motion that has not already cleanly finished its post-motion hardware clip).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  shouldRewakeRtspOnDrop(now = Date.now()) {
    const hwActive = this.hasActiveHardwareTriggers(now) && !this.hasReachedMaxDuration(now);
    const frigateActive = this.hasRecentFrigateObjectActivity(now) && !this.hasReachedMaxDuration(now);
    const activeMotionNeedsRewake = this.isInMotion(now) && !this.didRtspMotionStreamFinishCleanly(now);
    return Boolean(
      !this.timers.letEufyDecideEnd &&
      (now < this.wantUntil() || hwActive || frigateActive) &&
      (activeMotionNeedsRewake || hwActive || frigateActive || this.hasWakingViewer())
    );
  }

  /**
   * Prepares the camera state for an immediate mid-session RTSP re-wake and returns remaining hold seconds.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [minHoldMs=10000] - Minimum hold window required to complete RTSP re-wake.
   * @returns {number} Remaining hold duration in seconds.
   */
  beginRtspRewake(now, minHoldMs = undefined) {
    this.transitionTo(SESSION_STATES.WAKING_RTSP, now, 'rtsp stream dropped, re-waking');
    const canExtendHold = this.hasActiveHardwareTriggers(now) && !this.hasReachedMaxDuration(now);
    const {remainingSecs, extended} = this.session.prepareRtspRewake(now, {
      minHoldMs,
      canExtendHold,
      baseHoldMs: this.getEventHoldMs(),
    });
    if (extended) {
      this.clearPendingBackfill();
    }
    return remainingSecs;
  }

  /**
   * Evaluates RTSP session health, non-destructive wake retries, handshake protection, and timeouts.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [quietSince] - Timestamp of last video packet or start attempt.
   * @param {number} [handshakeMinMs] - Minimum decoder age indicating active RTSP handshake.
   * @param {number} [decStallMs] - Decoder age after which a silent handshake is considered stalled.
   * @param {number} [retryMs] - Interval between start_rtsp_livestream wake retries.
   * @param {number} [maxRetries] - Maximum RTSP wake retries before timeout.
   * @param {number} [timeoutMs] - Hard RTSP wake timeout in milliseconds.
   * @param {number} [midStallMs] - Mid-session frame silence threshold in milliseconds.
   * @returns {{ action: 'none'|'retry'|'timeout'|'dropped', killStalledDec: boolean, logMsg: string }}
   */
  evaluateRtspHealth(
    now,
    quietSince = undefined,
    handshakeMinMs = undefined,
    decStallMs = undefined,
    retryMs = undefined,
    maxRetries = undefined,
    timeoutMs = undefined,
    midStallMs = undefined
  ) {
    return this.session.evaluateRtspHealth(now, {
      quietSince,
      handshakeMinMs,
      decStallMs,
      retryMs,
      maxRetries,
      timeoutMs,
      midStallMs,
    });
  }

  /**
   * Evaluates P2P watchdog stall and retry conditions for an active P2P livestream session.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [quietSince] - Timestamp of last video packet or start attempt.
   * @param {number} [initialRetryMs] - Quiet duration before retry 1.
   * @param {number} [subsequentRetryMs] - Quiet duration before retries 2..maxRetries.
   * @param {number} [maxRetries] - Maximum watchdog retries before forced error sleep.
   * @returns {{ action: 'none'|'retry'|'timeout'|'expired', logMsg: string }}
   */
  evaluateP2pHealth(
    now,
    quietSince = undefined,
    initialRetryMs = undefined,
    subsequentRetryMs = undefined,
    maxRetries = undefined
  ) {
    return this.session.evaluateP2pHealth(now, {
      quietSince,
      initialRetryMs,
      subsequentRetryMs,
      maxRetries,
      isPiggybackedExternal: this.isPiggybackedExternalSession(),
      hasWakingViewer: this.hasWakingViewer(),
    });
  }

  /**
   * Returns true if an incoming Eufy trigger start/clear event is a duplicate of the identical
   * event emitted within COMPANION_EVENT_BURST_MS (such as eufy-security-ws firing both
   * 'property changed' and the native detection event at the same millisecond).
   *
   * @param {string} eventName - Eufy trigger event name.
   * @param {boolean} isStart - True for state=true start, false for state=false clear.
   * @param {string} [personName=''] - Optional recognized person name.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isDuplicateTriggerEvent(eventName, isStart, personName = '', now = Date.now()) {
    if (!isStart) {
      return this.hardwareTriggers.isDuplicateClear(eventName, now);
    }
    const job = this.backfill.pending || this.backfill.active;
    const backfillPerson = (job && job.getPersonName()) || '';
    return this.hardwareTriggers.isDuplicateStart(eventName, now, !personName || backfillPerson === personName);
  }

  /**
   * Records that Eufy reported motion/activity cleared (state: false) for an event property,
   * marking recording cleared and optionally shortening motionUntil only once all active
   * trigger properties on this camera have cleared.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [settleMs=DEFAULT_MOTION_CLEAR_SETTLE_MS] - Post-clear settle duration in milliseconds.
   * @param {number} [minVideoMs=DEFAULT_MIN_EVENT_VIDEO_MS] - Minimum event video duration in milliseconds.
   * @param {string} [eventName=''] - Eufy event property that reported state: false.
   * @returns {number|null} Shortened remaining seconds if applied, or null.
   */
  recordMotionCleared(
    now,
    settleMs = DEFAULT_MOTION_CLEAR_SETTLE_MS,
    minVideoMs = DEFAULT_MIN_EVENT_VIDEO_MS,
    eventName = ''
  ) {
    this.expireStaleHardwareTriggers(now);
    if (eventName) {
      this.hardwareTriggers.clear(eventName, now);
    } else {
      this._clearActiveHardwareTriggers();
    }
    const allCleared = this.backfill.markTriggersCleared(now, eventName, {
      initiallyCleared: this.hardwareTriggers.isEmpty(),
      activeEvents: this.hardwareTriggers.activeEvents(),
    });
    if (!allCleared) {
      return null;
    }
    return this.session.shortenHoldOnMotionClear(now, settleMs, minVideoMs);
  }

  /**
   * Returns true if the camera has a pending BackfillJob whose hardware recording has cleared.
   *
   * @returns {boolean}
   */
  isBackfillRecordingCleared() {
    return this.backfill.isRecordingCleared();
  }

  /**
   * Queues a new BackfillJob for an external /api/wake request or upgrades an active/pending
   * BackfillJob's priority and reason in place without clobbering specific Eufy event labels.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} reason - Trigger reason supplied by the API wake request.
   * @param {number|{evPriority?: number, defaultEvent?: string}} [evPriorityOrOpts=DEFAULT_EVENT_PRIORITY]
   *   - Priority boost score or options object.
   * @returns {boolean} True if a BackfillJob was queued or upgraded in place.
   */
  queueOrUpgradeApiWakeBackfill(now, reason, evPriorityOrOpts = DEFAULT_EVENT_PRIORITY) {
    const opts = typeof evPriorityOrOpts === 'object' && evPriorityOrOpts !== null ? evPriorityOrOpts : null;
    const evPriority = opts ? Number(opts.evPriority ?? DEFAULT_EVENT_PRIORITY) : Number(evPriorityOrOpts);
    return this.backfill.queueOrUpgradeApiWake(now, reason, {
      evPriority,
      defaultEvent: opts ? opts.defaultEvent : undefined,
      activeEvents: this.hardwareTriggers.activeEvents(),
      isLiveWithVideo: Boolean(this.isActiveLiveSession() && this.session.gotVideo),
      runtimeExtended: this.session.runtimeExtended,
    });
  }

  /**
   * Queues or upgrades a pending BackfillJob when a Eufy trigger event fires and backfill_enabled is active.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} eventName - Raw Eufy event string.
   * @param {string} personName - Optional recognized person name.
   * @param {string} reason - Formatted trigger description.
   * @param {number} evPriority - Event priority boost score.
   * @param {boolean} [recordingActive=true] - Whether the camera hardware clip is still actively recording.
   */
  queueEventBackfill(now, eventName, personName, reason, evPriority, recordingActive = true) {
    this.expireStaleHardwareTriggers(now);
    if (recordingActive && eventName) {
      this.session.motionClearedAt = 0;
      this.hardwareTriggers.start(eventName, now);
    }
    const mergedEvPriority = this._consumeDeferredWakePriority(evPriority, recordingActive);
    this.backfill.queueEvent(now, {
      eventName,
      personName,
      reason,
      evPriority: mergedEvPriority,
      recordingActive,
      activeEvents: this.hardwareTriggers.activeEvents(),
      isLiveWithVideo: Boolean(this.isActiveLiveSession() && this.session.gotVideo),
      runtimeExtended: this.session.runtimeExtended,
    });
  }

  /**
   * Returns true if this camera has an urgent SIGUSR1 test BackfillJob queued.
   *
   * @returns {boolean}
   */
  hasUrgentTestBackfill() {
    return this.backfill.hasUrgentTest();
  }

  /**
   * Clears any scheduled /api/wake pacing timer and pending options on this camera.
   */
  clearApiWakeTimer() {
    this.wake.clearApiTimer();
  }

  /**
   * Returns the configured per-camera base priority score.
   *
   * @returns {number}
   */
  getBasePriority() {
    return this.priority;
  }

  /**
   * Returns the resolved per-camera timing and mode configuration object.
   *
   * @returns {Record<string, *>}
   */
  getTimersConfig() {
    return this.timers;
  }

  /**
   * Returns the resolved Set of trigger event keywords enabled for this camera.
   *
   * @returns {Set<string>}
   */
  getTriggersSet() {
    return this.triggers;
  }

  /**
   * Returns true when post-event HomeBase clip backfill downloads are enabled for this camera.
   *
   * @returns {boolean}
   */
  hasBackfillDownloadsEnabled() {
    return Boolean(this.backfillDownloads);
  }

  /**
   * Sets the HomeBase or direct RTSP pull URL on this camera.
   *
   * @param {string} url - Candidate RTSP URL string.
   */
  setRtspUrl(url) {
    this.rtspUrl = String(url || '');
  }

  /**
   * Sets whether this camera hardware supports native HomeBase RTSP streaming.
   *
   * @param {boolean} supported - True when native RTSP is supported.
   */
  setRtspSupported(supported) {
    this.rtspSupported = Boolean(supported);
  }

  /**
   * Sets whether the Eufy rtspStream property has been verified for this camera.
   *
   * @param {boolean} checked - Verification state.
   */
  setRtspPropertyChecked(checked) {
    this.rtspEnabledChecked = Boolean(checked);
  }

  /**
   * Returns true when this camera still needs a first-boot startup snapshot probe.
   *
   * @returns {boolean}
   */
  requiresStartupSnapshot() {
    return Boolean(this.needsStartupSnapshot);
  }

  /**
   * Sets whether this camera needs a first-boot startup snapshot probe.
   *
   * @param {boolean} needed - Whether a startup snapshot probe is required.
   */
  setRequiresStartupSnapshot(needed) {
    this.needsStartupSnapshot = Boolean(needed);
  }

  /**
   * Returns the normalized status card theme configured for this camera.
   *
   * @returns {string}
   */
  getCardTheme() {
    return this.card.theme;
  }

  /**
   * Returns the pre-allocated YUV420p sleeping status card buffer.
   *
   * @returns {Uint8Array}
   */
  getAsleepCardBuffer() {
    return this.card.asleep;
  }

  /**
   * Returns the YUV420p waking status card buffer (rendering lazily on first access).
   *
   * @returns {Uint8Array|null}
   */
  getWakingCardBuffer() {
    return this.card.waking;
  }

  /**
   * Returns the YUV420p busy/waiting status card buffer (rendering lazily on first access).
   *
   * @returns {Uint8Array|null}
   */
  getBusyCardBuffer() {
    return this.card.busy;
  }

  /**
   * Returns the raw waking card buffer without triggering lazy allocation.
   *
   * @returns {Uint8Array|null}
   */
  peekWakingCardBuffer() {
    return this.card.peekWakingBuffer();
  }

  /**
   * Returns the raw busy card buffer without triggering lazy allocation.
   *
   * @returns {Uint8Array|null}
   */
  peekBusyCardBuffer() {
    return this.card.peekBusyBuffer();
  }

  /**
   * Returns the alternating two-slot live overlay scratch buffers (or null before first live overlay).
   *
   * @returns {Buffer[]|null}
   */
  getLiveOverlayBuffers() {
    return this.card.liveOverlayBufs;
  }

  /**
   * Returns true when live status card rendering is temporarily suppressed for clean event snapshots.
   *
   * @returns {boolean}
   */
  isLiveCardSuppressed() {
    return Boolean(this.card.suppressLiveCard);
  }

  /**
   * Sets whether live status card rendering is temporarily suppressed.
   *
   * @param {boolean} suppressed - Suppression flag.
   */
  setLiveCardSuppressed(suppressed) {
    this.card.suppressLiveCard = Boolean(suppressed);
  }

  /**
   * Returns the resolved telemetry visibility configuration for this camera.
   *
   * @returns {Record<string, boolean>}
   */
  getTelemetryConfig() {
    return this.telemetry.config;
  }

  /**
   * Returns the resolved Eufy Power Manager hardware recording configuration for this camera.
   *
   * @returns {Record<string, *>}
   */
  getHardwareRecordingConfig() {
    return this.telemetry.hwRecordingCfg;
  }

  /**
   * Returns true when eufy-security-ws connectivity is marked healthy on this camera.
   *
   * @returns {boolean}
   */
  isWsConnected() {
    return Boolean(this.telemetry.wsConnected);
  }

  /**
   * Returns true when the camera battery is currently charging or externally powered.
   *
   * @returns {boolean}
   */
  isCharging() {
    return Boolean(this.telemetry.charging);
  }

  /**
   * Returns the human-readable power source label ('Solar', 'Plugged', 'Charging', or 'Battery').
   *
   * @returns {string}
   */
  getPowerLabel() {
    return this.telemetry.powerLabel;
  }

  /**
   * Returns true once the Eufy videoStreamingQuality check has run for this camera.
   *
   * @returns {boolean}
   */
  hasQualityChecked() {
    return Boolean(this.telemetry.qualityChecked);
  }

  /**
   * Returns true once the Eufy Power Manager recording mode sync check has run for this camera.
   *
   * @returns {boolean}
   */
  hasRecordingModeChecked() {
    return Boolean(this.telemetry.recordingModeChecked);
  }

  /**
   * Returns the current 0..4 Wi-Fi signal bar tier (or null before telemetry arrives).
   *
   * @returns {number|null}
   */
  getWifiSignal() {
    return this.telemetry.wifi;
  }

  /**
   * Returns the current camera temperature reading in degrees Celsius (or null if unavailable).
   *
   * @returns {number|null}
   */
  getTemperature() {
    return this.telemetry.temp;
  }

  /**
   * Returns true when the camera hardware spotlight (light) is currently reported on.
   *
   * @returns {boolean}
   */
  isSpotlightOn() {
    return this.telemetry.isLightOn();
  }

  /**
   * Returns true when Low-Battery Saver conservation is supported on this camera's telemetry model.
   *
   * @returns {boolean}
   */
  hasPowerConservationEnabled() {
    return this.telemetry.hasPowerConservationEnabled();
  }

  /**
   * Marks the camera offline after an unresponsive wake timeout.
   */
  markWakeTimedOut() {
    this.telemetry.markWakeTimedOut();
  }

  /**
   * Updates the formatted 'HH:MM' last-seen timestamp on the camera's telemetry model.
   *
   * @param {string} lastSeenHm - Formatted local 'HH:MM' timestamp.
   */
  updateLastSeen(lastSeenHm) {
    this.telemetry.updateLastSeen(lastSeenHm);
  }

  /**
   * Returns the structured telemetry status snapshot using this camera's card configuration.
   *
   * @returns {Record<string, *>}
   */
  toTelemetryStatusSnapshot() {
    return this.telemetry.toStatusSnapshot(this.card.config);
  }

  /**
   * Returns the stored session lifecycle state without mutating an elapsed cooldown.
   *
   * @returns {string}
   */
  getStoredSessionState() {
    return this.sessionLifecycle.getState();
  }

  /**
   * Sets the epoch timestamp when the camera last went to sleep.
   *
   * @param {number} sleptAt - Epoch timestamp in milliseconds.
   */
  setSleptAt(sleptAt) {
    this.sessionLifecycle.markSlept(sleptAt);
  }

  /**
   * Sets whether a stream session is currently marked active.
   *
   * @param {boolean} active - Active flag.
   */
  setSessionActive(active) {
    this.session.active = Boolean(active);
  }

  /**
   * Sets the active stream mode ('rtsp', 'p2p', 'download', or '').
   *
   * @param {string} mode - Stream mode identifier.
   */
  setActiveMode(mode) {
    this.session.mode = mode;
  }

  /**
   * Returns true when the P2P livestream channel has reported ready.
   *
   * @returns {boolean}
   */
  isP2pReady() {
    return Boolean(this.session.p2pReady);
  }

  /**
   * Returns the epoch timestamp when the current session started.
   *
   * @returns {number}
   */
  getSessionStartedAt() {
    return this.session.startedAt;
  }

  /**
   * Sets the epoch timestamp when the current session started.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setSessionStartedAt(ts) {
    this.session.startedAt = ts;
  }

  /**
   * Sets the epoch timestamp of the latest stream start attempt.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastStartAt(ts) {
    this.session.lastStartAt = ts;
  }

  /**
   * Returns the epoch timestamp when the camera session last stopped.
   *
   * @returns {number}
   */
  getLastStoppedAt() {
    return this.session.lastStoppedAt;
  }

  /**
   * Sets the epoch timestamp when the camera session last stopped.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastStoppedAt(ts) {
    this.session.lastStoppedAt = ts;
  }

  /**
   * Sets whether the current session has received video data.
   *
   * @param {boolean} gotVideo - Video received flag.
   */
  setGotVideo(gotVideo) {
    this.session.gotVideo = Boolean(gotVideo);
  }

  /**
   * Sets the epoch timestamp of the first video packet/frame in the current session.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setFirstVideoAt(ts) {
    this.session.firstVideoAt = ts;
  }

  /**
   * Returns the epoch timestamp of the first decoded YUV420p frame in the current session.
   *
   * @returns {number}
   */
  getFirstFrameAt() {
    return this.session.firstFrameAt;
  }

  /**
   * Sets the epoch timestamp of the first decoded YUV420p frame in the current session.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setFirstFrameAt(ts) {
    this.session.firstFrameAt = ts;
  }

  /**
   * Returns the epoch timestamp of the latest video packet/frame in the current session.
   *
   * @returns {number}
   */
  getLastVideoAt() {
    return this.session.lastVideoAt;
  }

  /**
   * Sets the epoch timestamp of the latest video packet/frame in the current session.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastVideoAt(ts) {
    this.session.lastVideoAt = ts;
  }

  /**
   * Returns the number of packets or frames dropped due to queue bounds in the current session.
   *
   * @returns {number}
   */
  getDroppedFrameCount() {
    return this.session.droppedFrames;
  }

  /**
   * Sets the human-readable wake/session reason string.
   *
   * @param {string} reason - Session wake reason.
   */
  setReason(reason) {
    this.session.reason = reason;
  }

  /**
   * Returns the structured initiator tag for the current or most recent session.
   *
   * @returns {string}
   */
  getWakeInitiator() {
    return this.session.initiator;
  }

  /**
   * Sets the structured initiator tag for the current session.
   *
   * @param {string} initiator - Session initiator tag.
   */
  setWakeInitiator(initiator) {
    this.session.initiator = initiator;
  }

  /**
   * Returns true when the current session's hold window was extended mid-stream.
   *
   * @returns {boolean}
   */
  isRuntimeExtended() {
    return Boolean(this.session.runtimeExtended);
  }

  /**
   * Returns the motion/event hold expiry timestamp in milliseconds.
   *
   * @returns {number}
   */
  getMotionUntil() {
    return this.session.motionUntil;
  }

  /**
   * Sets the motion/event hold expiry timestamp in milliseconds.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setMotionUntil(ts) {
    this.session.motionUntil = ts;
  }

  /**
   * Sets the latest motion trigger timestamp in milliseconds.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastMotionAt(ts) {
    this.session.lastMotionAt = ts;
  }

  /**
   * Returns the epoch timestamp when Eufy reported motion cleared in the current session.
   *
   * @returns {number}
   */
  getMotionClearedAt() {
    return this.session.motionClearedAt;
  }

  /**
   * Sets the epoch timestamp when Eufy reported motion cleared in the current session.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setMotionClearedAt(ts) {
    this.session.motionClearedAt = ts;
  }

  /**
   * Returns the live viewer hold expiry timestamp in milliseconds.
   *
   * @returns {number}
   */
  getViewUntil() {
    return this.session.viewUntil;
  }

  /**
   * Sets the live viewer hold expiry timestamp in milliseconds.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setViewUntil(ts) {
    this.session.viewUntil = ts;
  }

  /**
   * Returns true when Frigate event filing is enabled for the active wake/session.
   *
   * @returns {boolean}
   */
  isEventActive() {
    return Boolean(this.eventActive);
  }

  /**
   * Sets whether Frigate event filing is enabled for the active wake/session.
   *
   * @param {boolean} active - Event active flag.
   */
  setEventActive(active) {
    this.eventActive = Boolean(active);
  }

  /**
   * Returns the epoch timestamp of the last Frigate hold-extension poll.
   *
   * @returns {number}
   */
  getLastExtendCheckAt() {
    return this.lastExtendCheckAt;
  }

  /**
   * Sets the epoch timestamp of the last Frigate hold-extension poll.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastExtendCheckAt(ts) {
    this.lastExtendCheckAt = ts;
  }

  /**
   * Sets the epoch timestamp of the last unsolicited P2P stop command.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastUnsolicitedStopAt(ts) {
    this.lastUnsolicitedStopAt = ts;
  }

  /**
   * Sets the epoch timestamp of the last idle wedged-radio stop command.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastWedgedRadioStopAt(ts) {
    this.lastWedgedRadioStopAt = ts;
  }

  /**
   * Clears all tracked go2rtc viewer consumer IDs on this camera.
   */
  clearViewerIds() {
    this.viewerSet.clearAll();
  }

  /**
   * Marks a Eufy hardware trigger event name as currently active in the trigger ledger.
   *
   * @param {string} eventName - Raw or normalized Eufy event name.
   */
  addActiveTriggerEvent(eventName) {
    this.hardwareTriggers.addActive(eventName);
  }

  /**
   * Clears all active Eufy hardware trigger events from the trigger ledger.
   */
  clearActiveTriggerEvents() {
    this.hardwareTriggers.clearAll();
  }

  /**
   * Returns the stored Frigate event filing state without mutating an elapsed cooldown.
   *
   * @returns {string}
   */
  getStoredFrigateEventState() {
    return this.eventFiling.state;
  }

  /**
   * Sets the stored Frigate event filing state.
   *
   * @param {string} state - FRIGATE_EVENT_STATES value.
   */
  setStoredFrigateEventState(state) {
    this.eventFiling.state = state;
  }

  /**
   * Returns the Frigate event cooldown expiry timestamp in milliseconds.
   *
   * @returns {number}
   */
  getFrigateEventUntil() {
    return this.eventFiling.until;
  }

  /**
   * Sets the Frigate event cooldown expiry timestamp in milliseconds.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setFrigateEventUntil(ts) {
    this.eventFiling.until = ts;
  }

  /**
   * Returns the active Frigate event snapshot timer handle (or null if none).
   *
   * @returns {*}
   */
  getFrigateEventTimer() {
    return this.eventFiling.timer;
  }

  /**
   * Sets the queued/filed Frigate event label on this camera.
   *
   * @param {string} label - Frigate event label.
   */
  setFrigateEventLabel(label) {
    this.eventFiling.label = label;
  }

  /**
   * Sets the recognized person name for Frigate event filing on this camera.
   *
   * @param {string} person - Recognized person name.
   */
  setFrigateEventPerson(person) {
    this.eventFiling.person = person;
  }

  /**
   * Returns the current decoder backpressure FSM state.
   *
   * @returns {string}
   */
  getDecoderState() {
    return this.session.decoderState;
  }

  /**
   * Returns the epoch timestamp when the current FFmpeg decoder process was spawned.
   *
   * @returns {number}
   */
  getDecoderSpawnedAt() {
    return this.session.decSpawnedAt;
  }

  /**
   * Returns true when the attached FFmpeg decoder stdout stream is paused for backpressure.
   *
   * @returns {boolean}
   */
  isDecoderStdoutPaused() {
    return Boolean(this.session.decoderStdoutPaused);
  }

  /**
   * Returns the queued compressed video packets awaiting decoder stdin consumption.
   *
   * @returns {Uint8Array[]}
   */
  getPendingVideoPackets() {
    return this.session.pendingVideoPackets;
  }

  /**
   * Replaces the queued compressed video packet array on the stream session.
   *
   * @param {Uint8Array[]} packets - Replacement packet queue.
   */
  setPendingVideoPackets(packets) {
    this.session.pendingVideoPackets = packets;
  }

  /**
   * Empties any queued compressed video packets in place.
   */
  clearPendingVideoPackets() {
    this.session.pendingVideoPackets.length = 0;
  }

  /**
   * Returns the queued compressed audio packets awaiting decoder pipe consumption.
   *
   * @returns {Uint8Array[]}
   */
  getPendingAudioPackets() {
    return this.session.pendingAudioPackets;
  }

  /**
   * Returns the total bytes of decoded PCM audio currently buffered in the audio queue.
   *
   * @returns {number}
   */
  getBufferedAudioBytes() {
    return this.audioQueue.getBufferedBytes();
  }

  /**
   * Returns the latest decoded YUV420p frame buffer (with live overlay applied when enabled).
   *
   * @returns {Uint8Array|null}
   */
  getCurrentFrameBuffer() {
    return this.frame;
  }

  /**
   * Sets the current YUV420p frame buffer on this camera.
   *
   * @param {Uint8Array|null} frame - Frame buffer or null.
   */
  setCurrentFrameBuffer(frame) {
    this.frame = frame;
  }

  /**
   * Sets the clean snapshot YUV420p frame buffer on this camera.
   *
   * @param {Uint8Array|null} frame - Clean snapshot frame buffer or null.
   */
  setLastFrameBuffer(frame) {
    this.lastFrame = frame;
  }

  /**
   * Sets the epoch timestamp when the current decoded frame arrived.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setFrameTimestamp(ts) {
    this.frameAt = ts;
  }

  /**
   * Sets whether a newly decoded frame is waiting to be written to the encoder.
   *
   * @param {boolean} isNew - Pending frame flag.
   */
  setFrameNew(isNew) {
    this.frameNew = Boolean(isNew);
  }

  /**
   * Returns the epoch timestamp of the most recent encoder frame write.
   *
   * @returns {number}
   */
  getLastWriteAt() {
    return this.lastWrite;
  }

  /**
   * Sets the epoch timestamp of the most recent encoder frame write.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastWriteAt(ts) {
    this.lastWrite = ts;
  }

  /**
   * Returns the last YUV420p frame buffer written to the encoder stdin.
   *
   * @returns {Uint8Array|null}
   */
  getLastSentFrameBuffer() {
    return this.lastSent;
  }

  /**
   * Returns the pre-allocated decoder stdout assembly buffer (or null before first decode).
   *
   * @returns {Buffer|null}
   */
  getDecoderReadBuffer() {
    return this.decoderReadBuf;
  }

  /**
   * Returns the two-slot live frame ring buffer (or null before first live burst).
   *
   * @returns {Buffer[]|null}
   */
  getLiveFrameRing() {
    return this.liveFrameRing;
  }

  /**
   * Returns the number of decoded live frames currently queued for paced output.
   *
   * @returns {number}
   */
  getBufferedLiveFrameCount() {
    return this.liveFrames.length;
  }

  /**
   * Returns the number of reusable frame buffers currently pooled for backfill downloads.
   *
   * @returns {number}
   */
  getDownloadFramePoolCount() {
    return this.downloadFramePool.length;
  }

  /**
   * Returns the pending BackfillJob waiting for settlement or HomeBase query (or null).
   *
   * @returns {import("./backfill-job").BackfillJob|null}
   */
  getPendingBackfillJob() {
    return this.backfill.pending;
  }

  /**
   * Sets the pending BackfillJob on this camera.
   *
   * @param {import("./backfill-job").BackfillJob|null} job - Pending BackfillJob or null.
   */
  setPendingBackfillJob(job) {
    this.backfill.pending = job;
  }

  /**
   * Returns the secondary BackfillJob queued behind an already-querying pending job (or null).
   *
   * @returns {import("./backfill-job").BackfillJob|null}
   */
  getQueuedBackfillJob() {
    return this.backfill.queued;
  }

  /**
   * Sets the secondary queued BackfillJob on this camera.
   *
   * @param {import("./backfill-job").BackfillJob|null} job - Queued BackfillJob or null.
   */
  setQueuedBackfillJob(job) {
    this.backfill.queued = job;
  }

  /**
   * Returns the BackfillJob currently being downloaded/replayed (or null).
   *
   * @returns {import("./backfill-job").BackfillJob|null}
   */
  getActiveBackfillJob() {
    return this.backfill.active;
  }

  /**
   * Returns the clip descriptor currently being downloaded/replayed (or null).
   *
   * @returns {Record<string, *>|null}
   */
  getActiveBackfillClip() {
    return this.backfill.activeClip;
  }

  /**
   * Returns the next matched HomeBase clip ready for download (or null).
   *
   * @returns {Record<string, *>|null}
   */
  getBackfillClip() {
    return this.backfill.clip;
  }

  /**
   * Sets the next matched HomeBase clip descriptor on this camera.
   *
   * @param {Record<string, *>|null} clip - Matched clip descriptor or null.
   */
  setBackfillClip(clip) {
    this.backfill.clip = /** @type {*} */ (clip);
  }

  /**
   * Returns the queue of matched HomeBase clips awaiting download.
   *
   * @returns {Array<Record<string, *>>}
   */
  getBackfillClipQueue() {
    return this.backfill.clipQueue;
  }

  /**
   * Replaces the queue of matched HomeBase clips awaiting download.
   *
   * @param {Array<Record<string, *>>} clips - Replacement matched clip array.
   */
  setBackfillClipQueue(clips) {
    this.backfill.clipQueue = /** @type {*} */ (clips);
  }

  /**
   * Returns the epoch timestamp of the latest HomeBase database query for this camera.
   *
   * @returns {number}
   */
  getLastBackfillQueryAt() {
    return this.backfill.lastQueryAt;
  }

  /**
   * Sets the epoch timestamp of the latest HomeBase database query for this camera.
   *
   * @param {number} ts - Epoch timestamp in milliseconds.
   */
  setLastBackfillQueryAt(ts) {
    this.backfill.lastQueryAt = ts;
  }

  /**
   * Returns true if the given HomeBase clip storage path is recorded in downloadedPaths.
   *
   * @param {string} storagePath - HomeBase .zxvideo storage path.
   * @returns {boolean}
   */
  hasDownloadedClipPath(storagePath) {
    return this.backfill.downloadedPaths.has(storagePath);
  }

  /**
   * Returns the number of HomeBase clip paths retained in bounded downloadedPaths history.
   *
   * @returns {number}
   */
  getDownloadedClipPathCount() {
    return this.backfill.downloadedPaths.size;
  }

  /**
   * Returns the array of decoded YUV420p frames buffered for 15 fps backfill playback.
   *
   * @returns {Uint8Array[]}
   */
  getBufferedDownloadFrames() {
    return this.backfill.frames;
  }

  /**
   * Replaces the array of decoded frames buffered for backfill playback.
   *
   * @param {Uint8Array[]} frames - Replacement buffered frame array.
   */
  setBufferedDownloadFrames(frames) {
    this.backfill.frames = frames;
  }

  /**
   * Returns the epoch timestamp when Frame 0 of the active backfill clip began playback.
   *
   * @returns {number}
   */
  getBackfillPlaybackStartedAt() {
    return this.backfill.playbackStartedAt;
  }

  /**
   * Returns the count of compressed P2P video packets received during the active download.
   *
   * @returns {number}
   */
  getDownloadVideoPacketCount() {
    return this.backfill.videoPackets;
  }

  /**
   * Sets the count of compressed P2P video packets received during the active download.
   *
   * @param {number} count - Video packet count.
   */
  setDownloadVideoPacketCount(count) {
    this.backfill.videoPackets = count;
  }

  /**
   * Returns the count of YUV420p frames decoded during the active backfill download.
   *
   * @returns {number}
   */
  getDownloadDecodedFrameCount() {
    return this.backfill.decodedFrames;
  }

  /**
   * Sets the count of YUV420p frames decoded during the active backfill download.
   *
   * @param {number} count - Decoded frame count.
   */
  setDownloadDecodedFrameCount(count) {
    this.backfill.decodedFrames = count;
  }

  /**
   * Returns the count of backfill frames written out to the encoder during the active download.
   *
   * @returns {number}
   */
  getDownloadPlayedFrameCount() {
    return this.backfill.playedFrames;
  }

  /**
   * Sets the count of backfill frames written out to the encoder during the active download.
   *
   * @param {number} count - Played frame count.
   */
  setDownloadPlayedFrameCount(count) {
    this.backfill.playedFrames = count;
  }
}

module.exports = {
  DOWNLOAD_COMPLETED_INITIATOR,
  DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
  DOWNLOAD_FRAME_HIGH_WATERMARK,
  DOWNLOAD_FRAME_LOW_WATERMARK,
  MAX_DOWNLOADED_PATHS_HISTORY,
  MAX_LIVE_PENDING_VIDEO_PACKETS,
  MAX_DOWNLOAD_PENDING_VIDEO_PACKETS,
  MAX_LIVE_PENDING_AUDIO_PACKETS,
  SESSION_STATES,
  ALLOWED_SESSION_TRANSITIONS,
  canTransitionSession,
  FRIGATE_EVENT_STATES,
  DECODER_STATES,
  WAKE_KINDS,
  API_WAKE_STATUSES,
  CAMERA_RUNTIME_STATUSES,
  WakeRequest,
  Camera,
};
