// @ts-check
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
  AUDIO,
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
  clampNum,
  resolveCameraConfig,
} = require('../config');
const {formatLocalTimestamp, log} = require('../logger');
const {WIFI_SIGNAL_LEVELS, Telemetry} = require('./telemetry');
const {StatusCard} = require('./status-card');
const {
  BACKFILL_STATES,
  DEFAULT_BACKFILL_MAX_AGE_MS,
  BACKFILL_POST_CLEAR_SETTLE_MS,
  BACKFILL_RECORDING_WAIT_CAP_MS,
  BACKFILL_MAX_QUERY_ATTEMPTS,
  BackfillJob,
} = require('./backfill-job');

const INITIAL_KEYFRAME_BURST_MS = 2000;
const DOWNLOAD_EOF_FLUSH_SETTLE_MS = 1000;
const DOWNLOAD_EVENT_DURATION_MARGIN_SECS = 6;
const DOWNLOAD_FRAME_HIGH_WATERMARK = 30;
const DOWNLOAD_FRAME_LOW_WATERMARK = 10;
const DOWNLOAD_POOL_MAX_BUFFERS = DOWNLOAD_FRAME_HIGH_WATERMARK + 2;
const MAX_BACKFILL_CLIP_DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS = 4000;
const MAX_LIVE_BURST_FRAMES = 12;
const DEFAULT_LIVE_FRAME_PACE_MS = 62;

// Default domain policy thresholds for watchdog health, Frigate polling, and trigger extensions.
const DEFAULT_RTSP_HANDSHAKE_MIN_MS = 400;
const DEFAULT_RTSP_DEC_STALL_MS = 7500;
const DEFAULT_RTSP_RETRY_MS = 10000;
const DEFAULT_RTSP_MAX_RETRIES = 5;
const DEFAULT_RTSP_TIMEOUT_MS = 25000;
const DEFAULT_RTSP_MID_STALL_MS = 5000;
const DEFAULT_P2P_INITIAL_RETRY_MS = 5500;
const DEFAULT_P2P_SUBSEQUENT_RETRY_MS = 8000;
const DEFAULT_P2P_MAX_RETRIES = 3;
const DEFAULT_HOLD_EXTEND_WINDOW_MS = 12000;
const DEFAULT_HOLD_SAFETY_MARGIN_MS = 5000;
const NO_FRIGATE_POLL = Object.freeze({shouldPoll: false, needsTimeoutExtendCheck: false});
const DEBUG_HUD_ROW_CHARS = 110;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const DECIMAL_BASE = 10;
const ISO_TIME_START_INDEX = 11;
const HOMEBASE_3_SERIAL_PREFIX = 'T8030';
const DOORBELL_SERIAL_PREFIX = 'T8214';
const DEFAULT_MIN_WAKE_SECS = 5;
const DEFAULT_RTSP_START_DEDUP_WINDOW_MS = 2000;
const DEFAULT_FAILED_START_BACKOFF_MS = 5000;
const DEFAULT_MIN_CLEAN_VIDEO_MS = 3000;
const DEFAULT_ENCODER_WEDGED_TIMEOUT_MS = 10000;
const DEFAULT_FRESH_FRAME_MAX_AGE_MS = 2000;
const DEFAULT_DOWNLOAD_PACE_LEAD_MS = 4;
const DEFAULT_LIVE_HEARTBEAT_WRITE_MS = 500;
const DEFAULT_MIN_RTSP_REWAKE_HOLD_MS = 10000;
const FIRST_BACKFILL_PLAYED_FRAME_COUNT = 1;
const HUD_MAX_SECONDS_DISPLAY = 999;
const HUD_MAX_VIDEO_AGE_SECS_DISPLAY = 9.9;
const HUD_STATE_PAD_WIDTH = 7;
const HUD_DEC_PAD_WIDTH = 6;
const HUD_SECS_PAD_WIDTH = 3;
const HUD_FPS_PAD_WIDTH = 2;
const HUD_QUEUE_PAD_WIDTH = 2;
const HUD_SINGLE_DIGIT_WIDTH = 1;
const HUD_TEMP_POS_DIGITS = 2;
const HUD_TEMP_PAD_WIDTH = 3;
const HUD_SEEN_PAD_WIDTH = 5;
const HUD_SESSION_MODE_PAD_WIDTH = 4;
const HUD_RESTARTS_PAD_WIDTH = 2;
const HUD_STOP_PAD_WIDTH = 3;
const HUD_EVENT_STATE_PAD_WIDTH = 6;
const HUD_EVENT_ID_SLICE_LEN = 6;
const HUD_FRAME_COUNT_PAD_WIDTH = 4;
const HUD_INITIATOR_PAD_WIDTH = 8;
const HUD_COL1_WIDTH = 13;
const HUD_COL2_WIDTH = 12;
const HUD_SPAN12_WIDTH = 28;
const HUD_COL3_WIDTH = 10;
const HUD_COL4_WIDTH = 10;
const HUD_SPAN34_WIDTH = 23;
const HUD_COL5_WIDTH = 9;
const HUD_COL6_WIDTH = 25;
const HUD_COL7_WIDTH = 13;
const HUD_FLAG_YES = 'Y';
const HUD_FLAG_NO = 'N';
const HUD_LIGHT_ON_LABEL = 'ON ';
const HUD_LIGHT_OFF_LABEL = 'OFF';
const RTSP_CREDENTIALS_REGEX = /:\/\/[^@]+@/;
const HUD_POWER_CHARGING_LABEL = 'CHG';
const HUD_POWER_LOW_LABEL = 'LOW';
const HUD_POWER_BATTERY_LABEL = 'BAT';
const HUD_SESSION_NONE_LABEL = 'NONE';
const HUD_SESSION_BACKFILL_LABEL = 'BF';
const HUD_SESSION_P2P_FALLBACK = 'P2P';
const HUD_TRIGGER_ACTIVE_LABEL = 'ACTIVE ';
const HUD_TRIGGER_CLEAR_LABEL = 'CLEAR  ';
const HUD_SERVICE_OK_LABEL = 'OK';
const HUD_SERVICE_DOWN_LABEL = 'DN';
const HUD_EMPTY_DURATION_4 = '--- ';
const HUD_EMPTY_SEEN_4 = '----';
const HUD_EMPTY_EVENT_ID_6 = '------';

/**
 * Pads or truncates a value to an exact fixed character width so diagnostic HUD columns never shift.
 *
 * @param {*} val - Value to format.
 * @param {number} width - Fixed character width.
 * @param {boolean} [alignRight=false] - Whether to right-align within width.
 * @returns {string}
 */
function padFixedWidth(val, width, alignRight = false) {
  const s = String(val ?? '').slice(0, width);
  return alignRight ? s.padStart(width, ' ') : s.padEnd(width, ' ');
}

/**
 * Formats an integer with leading zeros up to digits width (clamped to width).
 *
 * @param {number} num - Integer value.
 * @param {number} width - Fixed digit width.
 * @returns {string}
 */
function formatZeroPaddedInt(num, width) {
  const clamped = Math.max(0, Math.min(Math.pow(DECIMAL_BASE, width) - 1, Math.round(Number(num) || 0)));
  return String(clamped).padStart(width, '0');
}

const DEFAULT_FRIGATE_POLL_COOLDOWN_MS = 4000;
const DEFAULT_RECENT_FRIGATE_OBJECT_MS = 15000;
const DEFAULT_EVENT_EXTEND_MARGIN_MS = 5000;
const COMPANION_EVENT_BURST_MS = 1000;
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
const DEFAULT_DOWNLOAD_IDLE_COMPLETE_MS = 3000;
const DEFAULT_DOWNLOAD_POST_PLAYBACK_HOLD_MS = 2500;
const DEFAULT_DOWNLOAD_MIN_PLAYBACK_MS = 4500;
const EXTERNAL_P2P_WAKE_REASON = 'external P2P wake - eufy-security-ws';
const EXTERNAL_RTSP_WAKE_REASON = 'external RTSP wake - eufy-security-ws';
const EXTERNAL_WAKE_INITIATOR = 'eufy-ws';
const ARBITRATOR_INITIATOR_PREFIX = 'bridge-arbitrator/';
const DOWNLOAD_COMPLETED_INITIATOR = 'eufy/download-finished';

/**
 * Returns true when a stopped backfill download counts as complete: the HomeBase transfer finished, or the
 * orchestrator ended playback as complete (including the idle fallback when 'download finished' was missed). Any
 * other stop (station disconnect, preemption, cancel, offline) is an interruption that must be retried.
 *
 * @param {boolean} downloadFinished - Whether the 'download finished' transfer event was received.
 * @param {string} initiator - Decision maker identifier of the stop.
 * @returns {boolean}
 */
function isCompletedDownloadStop(downloadFinished, initiator) {
  return downloadFinished || initiator === DOWNLOAD_COMPLETED_INITIATOR;
}

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
 * Enumerates the finite states of a Camera streaming session.
 *
 * @readonly
 * @enum {string}
 */
const SESSION_STATES = Object.freeze({
  IDLE: 'idle',
  WAKING_RTSP: 'waking_rtsp',
  WAKING_P2P: 'waking_p2p',
  HANDSHAKING_BACKFILL: 'handshaking_backfill',
  STREAMING_LIVE: 'streaming_live',
  PLAYING_BACKFILL: 'playing_backfill',
  DRAINING_BACKFILL_TAIL: 'draining_backfill_tail',
  COOLDOWN: 'cooldown',
});

/**
 * Validated transition map for the Camera session finite state machine.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const ALLOWED_SESSION_TRANSITIONS = Object.freeze({
  [SESSION_STATES.IDLE]: Object.freeze(
      new Set([
        SESSION_STATES.IDLE,
        SESSION_STATES.WAKING_RTSP,
        SESSION_STATES.WAKING_P2P,
        SESSION_STATES.HANDSHAKING_BACKFILL,
      ])
  ),
  [SESSION_STATES.WAKING_RTSP]: Object.freeze(
      new Set([
        SESSION_STATES.WAKING_RTSP,
        SESSION_STATES.STREAMING_LIVE,
        SESSION_STATES.IDLE,
      ])
  ),
  [SESSION_STATES.WAKING_P2P]: Object.freeze(
      new Set([
        SESSION_STATES.WAKING_P2P,
        SESSION_STATES.STREAMING_LIVE,
        SESSION_STATES.IDLE,
      ])
  ),
  [SESSION_STATES.HANDSHAKING_BACKFILL]: Object.freeze(
      new Set([
        SESSION_STATES.HANDSHAKING_BACKFILL,
        SESSION_STATES.PLAYING_BACKFILL,
        SESSION_STATES.DRAINING_BACKFILL_TAIL,
        SESSION_STATES.IDLE,
      ])
  ),
  [SESSION_STATES.STREAMING_LIVE]: Object.freeze(
      new Set([
        SESSION_STATES.STREAMING_LIVE,
        SESSION_STATES.WAKING_RTSP,
        SESSION_STATES.COOLDOWN,
        SESSION_STATES.IDLE,
      ])
  ),
  [SESSION_STATES.PLAYING_BACKFILL]: Object.freeze(
      new Set([
        SESSION_STATES.PLAYING_BACKFILL,
        SESSION_STATES.DRAINING_BACKFILL_TAIL,
        SESSION_STATES.IDLE,
      ])
  ),
  [SESSION_STATES.DRAINING_BACKFILL_TAIL]: Object.freeze(
      new Set([SESSION_STATES.DRAINING_BACKFILL_TAIL, SESSION_STATES.IDLE])
  ),
  [SESSION_STATES.COOLDOWN]: Object.freeze(
      new Set([
        SESSION_STATES.COOLDOWN,
        SESSION_STATES.WAKING_RTSP,
        SESSION_STATES.WAKING_P2P,
        SESSION_STATES.HANDSHAKING_BACKFILL,
        SESSION_STATES.IDLE,
      ])
  ),
});

/**
 * Returns true if transitioning a Camera session from fromState to toState is permitted by the FSM.
 *
 * @param {string} fromState - Current session state.
 * @param {string} toState - Target session state.
 * @returns {boolean}
 */
function canTransitionSession(fromState, toState) {
  const allowed = ALLOWED_SESSION_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.has(toState));
}

/**
 * Enumerates the finite states of a Camera's Frigate detection event filing lifecycle.
 *
 * @readonly
 * @enum {string}
 */
const FRIGATE_EVENT_STATES = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  WAITING_SNAPSHOT: 'waiting_snapshot',
  COOLDOWN: 'cooldown',
});

/**
 * Validated transition map for the Frigate event lifecycle finite state machine.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const ALLOWED_FRIGATE_EVENT_TRANSITIONS = Object.freeze({
  [FRIGATE_EVENT_STATES.IDLE]: Object.freeze(
      new Set([FRIGATE_EVENT_STATES.IDLE, FRIGATE_EVENT_STATES.QUEUED])
  ),
  [FRIGATE_EVENT_STATES.QUEUED]: Object.freeze(
      new Set([
        FRIGATE_EVENT_STATES.QUEUED,
        FRIGATE_EVENT_STATES.WAITING_SNAPSHOT,
        FRIGATE_EVENT_STATES.COOLDOWN,
        FRIGATE_EVENT_STATES.IDLE,
      ])
  ),
  [FRIGATE_EVENT_STATES.WAITING_SNAPSHOT]: Object.freeze(
      new Set([
        FRIGATE_EVENT_STATES.WAITING_SNAPSHOT,
        FRIGATE_EVENT_STATES.COOLDOWN,
        FRIGATE_EVENT_STATES.IDLE,
      ])
  ),
  [FRIGATE_EVENT_STATES.COOLDOWN]: Object.freeze(
      new Set([
        FRIGATE_EVENT_STATES.COOLDOWN,
        FRIGATE_EVENT_STATES.QUEUED,
        FRIGATE_EVENT_STATES.IDLE,
      ])
  ),
});

/**
 * Enumerates the finite states of a Camera's FFmpeg decoder backpressure and EOF flush pipeline.
 *
 * @readonly
 * @enum {string}
 */
const DECODER_STATES = Object.freeze({
  DETACHED: 'detached',
  HANDSHAKING: 'handshaking',
  DECODING: 'decoding',
  PAUSED_BACKPRESSURE: 'paused_backpressure',
  FLUSHING_EOF: 'flushing_eof',
});

/**
 * Validated transition map for the decoder backpressure finite state machine.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const ALLOWED_DECODER_TRANSITIONS = Object.freeze({
  [DECODER_STATES.DETACHED]: Object.freeze(
      new Set([DECODER_STATES.DETACHED, DECODER_STATES.HANDSHAKING])
  ),
  [DECODER_STATES.HANDSHAKING]: Object.freeze(
      new Set([
        DECODER_STATES.HANDSHAKING,
        DECODER_STATES.DECODING,
        DECODER_STATES.PAUSED_BACKPRESSURE,
        DECODER_STATES.FLUSHING_EOF,
        DECODER_STATES.DETACHED,
      ])
  ),
  [DECODER_STATES.DECODING]: Object.freeze(
      new Set([
        DECODER_STATES.DECODING,
        DECODER_STATES.PAUSED_BACKPRESSURE,
        DECODER_STATES.FLUSHING_EOF,
        DECODER_STATES.DETACHED,
      ])
  ),
  [DECODER_STATES.PAUSED_BACKPRESSURE]: Object.freeze(
      new Set([
        DECODER_STATES.PAUSED_BACKPRESSURE,
        DECODER_STATES.DECODING,
        DECODER_STATES.FLUSHING_EOF,
        DECODER_STATES.DETACHED,
      ])
  ),
  [DECODER_STATES.FLUSHING_EOF]: Object.freeze(
      new Set([
        DECODER_STATES.FLUSHING_EOF,
        DECODER_STATES.PAUSED_BACKPRESSURE,
        DECODER_STATES.DETACHED,
      ])
  ),
});

/** @type {Readonly<Record<string, string>>} */
const SHORT_SESSION_STATE_LABELS = Object.freeze({
  [SESSION_STATES.IDLE]: 'IDLE',
  [SESSION_STATES.WAKING_RTSP]: 'WK_RTSP',
  [SESSION_STATES.WAKING_P2P]: 'WK_P2P',
  [SESSION_STATES.STREAMING_LIVE]: 'LIVE',
  [SESSION_STATES.HANDSHAKING_BACKFILL]: 'BF_HSHK',
  [SESSION_STATES.PLAYING_BACKFILL]: 'BF_PLAY',
  [SESSION_STATES.DRAINING_BACKFILL_TAIL]: 'BF_TAIL',
  [SESSION_STATES.COOLDOWN]: 'COOLDWN',
});

/** @type {Readonly<Record<string, string>>} */
const SHORT_DECODER_STATE_LABELS = Object.freeze({
  [DECODER_STATES.DETACHED]: 'DETACH',
  [DECODER_STATES.HANDSHAKING]: 'HSHK',
  [DECODER_STATES.DECODING]: 'DECODE',
  [DECODER_STATES.PAUSED_BACKPRESSURE]: 'PAUSED',
  [DECODER_STATES.FLUSHING_EOF]: 'FLUSH',
});

/** @type {Readonly<Record<string, string>>} */
const SHORT_BACKFILL_STATE_LABELS = Object.freeze({
  [BACKFILL_STATES.RECORDING]: 'ACTIVE',
  [BACKFILL_STATES.SETTLING]: 'WAIT_Q',
  [BACKFILL_STATES.READY_TO_QUERY]: 'QUERY',
  [BACKFILL_STATES.MATCHED]: 'MATCH',
  [BACKFILL_STATES.DOWNLOADING]: 'PLAYING',
  [BACKFILL_STATES.COMPLETED]: 'DONE',
  [BACKFILL_STATES.EXPIRED]: 'EXPIRED',
});

/** @type {Readonly<Record<string, string>>} */
const SHORT_FRIGATE_EVENT_STATE_LABELS = Object.freeze({
  [FRIGATE_EVENT_STATES.IDLE]: 'IDLE',
  [FRIGATE_EVENT_STATES.QUEUED]: 'QUEUED',
  [FRIGATE_EVENT_STATES.WAITING_SNAPSHOT]: 'WAIT_S',
  [FRIGATE_EVENT_STATES.COOLDOWN]: 'RECORD',
});

/**
 * Abbreviates a SESSION_STATES value to fit inside a 7-character fixed column.
 *
 * @param {string} state - Session state value.
 * @returns {string}
 */
function formatShortSessionState(state) {
  return (
    SHORT_SESSION_STATE_LABELS[state] ||
    String(state || SHORT_SESSION_STATE_LABELS[SESSION_STATES.IDLE])
        .toUpperCase()
        .slice(0, HUD_STATE_PAD_WIDTH)
  );
}

/**
 * Abbreviates a DECODER_STATES value to fit inside a 6-character fixed column.
 *
 * @param {string} state - Decoder state value.
 * @returns {string}
 */
function formatShortDecoderState(state) {
  return (
    SHORT_DECODER_STATE_LABELS[state] ||
    String(state || SHORT_DECODER_STATE_LABELS[DECODER_STATES.DETACHED])
        .toUpperCase()
        .slice(0, HUD_DEC_PAD_WIDTH)
  );
}

/**
 * Abbreviates a BackfillJob state value to fit inside a 7-character fixed column.
 *
 * @param {*} bfJob - Active or pending BackfillJob instance (or null).
 * @returns {string}
 */
function formatShortBackfillState(bfJob) {
  if (!bfJob || !bfJob.state) {
    return SHORT_SESSION_STATE_LABELS[SESSION_STATES.IDLE];
  }
  return (
    SHORT_BACKFILL_STATE_LABELS[bfJob.state] ||
    String(bfJob.state).toUpperCase().slice(0, HUD_STATE_PAD_WIDTH)
  );
}

/**
 * Abbreviates a FRIGATE_EVENT_STATES value to fit inside a 6-character fixed column.
 *
 * @param {string} state - Frigate event state value.
 * @returns {string}
 */
function formatShortEvState(state) {
  return (
    SHORT_FRIGATE_EVENT_STATE_LABELS[state] ||
    String(state || SHORT_FRIGATE_EVENT_STATE_LABELS[FRIGATE_EVENT_STATES.IDLE])
        .toUpperCase()
        .slice(0, HUD_EVENT_STATE_PAD_WIDTH)
  );
}

/**
 * Wake trigger kinds distinguishing motion/detection events from human viewer/API requests.
 *
 * @readonly
 * @enum {string}
 */
const WAKE_KINDS = Object.freeze({
  MOTION: 'motion',
  VIEW: 'view',
});

/**
 * Fluent builder producing immutable wake/hold request value objects for Camera.applyWakeRequest().
 */
class WakeRequest {
  /**
   * @param {'motion'|'view'} kind - Wake trigger kind.
   * @param {string} reason - Human-readable trigger description.
   * @param {number} durationMs - Requested hold duration in milliseconds.
   */
  constructor(kind, reason, durationMs) {
    /** @type {'motion'|'view'} */
    this._kind = kind === WAKE_KINDS.MOTION ? WAKE_KINDS.MOTION : WAKE_KINDS.VIEW;
    this._reason = String(reason || '');
    this._durationMs = Number(durationMs) || 0;
    this._initiator = 'bridge';
    this._priority = DEFAULT_EVENT_PRIORITY;
    this._createEvent = false;
    this._delayMs = 0;
  }

  /**
   * Creates a motion/event wake request builder.
   *
   * @param {string} reason - Motion or detection event description.
   * @param {number} durationMs - Hold duration in milliseconds.
   * @returns {WakeRequest}
   */
  static motion(reason, durationMs) {
    return new WakeRequest(WAKE_KINDS.MOTION, reason, durationMs);
  }

  /**
   * Creates a viewer or external API wake request builder.
   *
   * @param {string} reason - Viewer or API wake description.
   * @param {number} durationMs - Hold duration in milliseconds.
   * @returns {WakeRequest}
   */
  static view(reason, durationMs) {
    return new WakeRequest(WAKE_KINDS.VIEW, reason, durationMs);
  }

  /**
   * Sets the structured initiator tag on this wake request.
   *
   * @param {string} initiator - Initiator tag (e.g. 'eufy-event', 'viewer', 'api-wake').
   * @returns {this}
   */
  withInitiator(initiator) {
    this._initiator = String(initiator || 'bridge');
    return this;
  }

  /**
   * Sets the event priority boost score on this wake request.
   *
   * @param {number} priority - Priority score.
   * @returns {this}
   */
  withPriority(priority) {
    this._priority = Number(priority) || 0;
    return this;
  }

  /**
   * Sets whether this wake request should also file a synthetic Frigate event.
   *
   * @param {boolean} createEvent - Whether to create a Frigate event.
   * @returns {this}
   */
  withCreateEvent(createEvent) {
    this._createEvent = Boolean(createEvent);
    return this;
  }

  /**
   * Sets an optional scheduling delay in milliseconds for API wake pacing.
   *
   * @param {number} delayMs - Delay in milliseconds.
   * @returns {this}
   */
  withDelay(delayMs) {
    this._delayMs = Math.max(0, Number(delayMs) || 0);
    return this;
  }

  /**
   * Builds and returns a deeply frozen immutable wake request object.
   *
   * @returns {Readonly<{ kind: 'motion'|'view', reason: string, durationMs: number, initiator: string, priority: number, createEvent: boolean, delayMs: number }>}
   */
  build() {
    return Object.freeze({
      kind: this._kind,
      reason: this._reason,
      durationMs: this._durationMs,
      initiator: this._initiator,
      priority: this._priority,
      createEvent: this._createEvent,
      delayMs: this._delayMs,
    });
  }
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
   * @param {Record<string, *>} rawCamCfg - Camera entry from config.json cameras[].
   * @param {{ frame: Uint8Array|null, lastSeen: string }} cachedSnapshot - Initial cached frame from disk.
   * @param {(cam: Camera) => void} [renderCardsFn] - Optional callback to pre-render initial status cards.
   */
  constructor(rawCamCfg, cachedSnapshot = {frame: null, lastSeen: ''}, renderCardsFn = null) {
    const resolvedCfg = resolveCameraConfig(rawCamCfg);
    Object.assign(this, resolvedCfg);
    /** @type {string} */
    this.serial = resolvedCfg.serial;
    this.name = resolvedCfg.name;
    /** @type {string} */
    this.title = resolvedCfg.title;
    /** @type {string} */
    this.station_serial = resolvedCfg.station_serial;
    /** @type {string} */
    this.homebase_rtsp_url = resolvedCfg.homebase_rtsp_url;

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
    this.rtspUrl = resolvedCfg.homebase_rtsp_url || '';
    this.rtspSupported = Boolean(
        resolvedCfg.homebase_rtsp_url ||
        (!this.isDoorbell() && (this.mode === CAMERA_MODES.RTSP || resolvedCfg.use_rtsp === true))
    );
    this.rtspEnabledChecked = false;
    this.unexpectedRtspActive = false;
    this.heardFromDeviceInSession = false;
    this.preserveAspect = resolvedCfg.preserveAspect;
    this.trackStuckSpotlight = Boolean(resolvedCfg.trackStuckSpotlight);
    this.useHwaccel = Boolean(ACTIVE_HWACCEL);

    // 3. Startup Snapshot & Backfill State
    this.needsStartupSnapshot = shouldProbeStartupSnapshot(
        this.card.sleepScreen,
        resolvedCfg.startupSnapshot,
        cachedSnapshot.frame
    );
    this.isStartupProbe = false;
    /** @type {BackfillJob|null} */
    this.pendingBackfill = null;
    /** @type {BackfillJob|null} */
    this.activeBackfillJob = null;
    this.activeBackfillClip = null;
    this.backfillClip = null;
    this.backfillClipQueue = [];
    this.lastDownloadedClipMs = 0;
    this.lastBackfillQueryAt = 0;
    this.lastBackfillDownloadFailedAt = 0;
    this.downloadedPaths = new Set();
    this.downloadFrames = [];
    this.liveFrames = [];
    this.pendingVideoPackets = [];
    this.pendingAudioPackets = [];
    this.decoderInputEnded = false;
    this.decoderStdoutPaused = false;
    this.downloadFinished = false;
    this.downloadFinishedAt = 0;
    this.backfillClipStartMs = 0;
    this.backfillTriggerAtMs = 0;
    this.backfillClearedAtMs = 0;
    this.backfillPlaybackStartedAt = 0;
    this.downloadVideoPackets = 0;
    this.downloadDecodedFrames = 0;
    this.downloadPlayedFrames = 0;
    this.isTestBackfill = false;
    this.backfillContinuation = false;
    this.activeTriggerEvents = new Set();
    this.lastTriggerStartEvent = '';
    this.lastTriggerStartAt = 0;
    this.lastTriggerClearEvent = '';
    this.lastTriggerClearAt = 0;
    /** @type {Record<string, *>|null} */
    this.lastSessionEventInfo = null;

    // 4. Active Stream Session & Timers
    /** @type {string} */
    this.sessionState = SESSION_STATES.IDLE;
    /** @type {string} */
    this.prevSessionState = SESSION_STATES.IDLE;
    this.sessionStateChangedAt = Date.now();
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
    this.extendCheckInFlight = false;
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
    this.lastFrigateObjectAt = 0;
    this.runtimeExtended = false;

    // 5. Frigate External Event State (FRIGATE_EVENT_STATES FSM)
    /** @type {string} */
    this.evState = FRIGATE_EVENT_STATES.IDLE;
    this.evTimer = null;
    this.evPending = false;
    this.evLabel = '';
    this.evPerson = '';
    this.evUntil = 0;
    this.evDispatchedAt = 0;
    this.evCreatedAt = 0;
    this.lastCreatedFrigateEventId = '';

    // 6. FFmpeg Process, Decoder Backpressure FSM & Zero-Allocation Media Buffers
    /** @type {string} */
    this.decoderState = DECODER_STATES.DETACHED;
    this.enc = null;
    this.encoderStoppedForOffline = false;
    this.offlineSeedTimer = null;
    this.offlineSeedConsumerSeen = false;
    this.offlineSeedExpireFn = null;
    this.encoderConsumerConnected = false;
    this.stoppingP2p = false;
    this.idleRssiChangeCount = 0;
    this.idleRssiWindowStartAt = 0;
    this.lastWedgedRadioStopAt = 0;
    this.dec = null;
    this.decSpawnedAt = 0;
    this.frame = null;
    this.lastFrame = cachedSnapshot.frame;
    this.frameAt = 0;
    this.frameNew = false;
    this.lastWrite = Date.now();
    this.lastSent = null;
    this.fpsWindowStartAt = 0;
    this.fpsFrameCount = 0;
    this.measuredFps = 0;
    this.liveFrameRing = [Buffer.allocUnsafe(FRAME), Buffer.allocUnsafe(FRAME)];
    this.liveFrameRingIdx = 0;
    /** @type {Buffer[]} */
    this.downloadFramePool = [];
    this.audioOutBuf = Buffer.allocUnsafe(AUDIO_CHUNK);
    this.pcm = [];
    this.pcmLen = 0;
    this.viewers = 0;
    this.viewerIds = new Map();
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
   * Returns the unique snapshot cache filename ('last_<name>_<serial>.jpg') for this camera.
   *
   * @returns {string}
   */
  getCacheFileName() {
    return 'last_' + this.name + '_' + this.serial + '.jpg';
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
    return this.reason;
  }

  /**
   * Returns the current monotonic session identifier.
   *
   * @returns {number}
   */
  getSessionId() {
    return this.sessionId;
  }

  /**
   * Returns true if a live or backfill session is currently active on this camera.
   *
   * @returns {boolean}
   */
  isSessionActive() {
    return Boolean(this.active);
  }

  /**
   * Returns the current active stream mode ('rtsp', 'p2p', 'download', or '').
   *
   * @returns {string}
   */
  getActiveMode() {
    return this.activeMode;
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
    return String(this.rtspUrl || '').replace(RTSP_CREDENTIALS_REGEX, '://***@');
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
    return this.videoCodec;
  }

  /**
   * Returns the formatted 'WxH' dimensions of the current video stream.
   *
   * @returns {string}
   */
  getStreamDimensionsSummary() {
    return this.videoWidth + 'x' + this.videoHeight;
  }

  /**
   * Returns the configured standard hold duration in milliseconds.
   *
   * @returns {number}
   */
  getHoldDurationMs() {
    return this.timers.holdMs;
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
   * Returns an immutable sanitized summary of this camera's resolved configuration for GET /api/config.
   *
   * @returns {Readonly<Record<string, *>>}
   */
  toConfigSummary() {
    return Object.freeze({
      name: this.name,
      serial: this.serial,
      title: this.getDisplayTitle(),
      station_serial: this.stationSerial || '',
      mode: this.mode,
      priority: this.priority,
      use_rtsp: Boolean(this.useRtsp),
      rtsp_capable: this.isRtspCapable(),
      homebase_rtsp_url: this.getMaskedRtspUrl(),
      backfill_only: Boolean(this.alwaysBackfill),
      backfill_enabled: Boolean(this.backfillDownloads),
      hold_secs: Math.round(this.timers.holdMs / MS_PER_SECOND),
      stream_max_secs: Math.round(this.timers.maxMs / MS_PER_SECOND),
      frigate_event_secs: this.timers.eventSecs,
      end_early: Boolean(this.timers.letEufyDecideEnd),
      idle_timeout_secs: Math.round(this.timers.earlySleepMs / MS_PER_SECOND),
      view_linger_secs: Math.round(this.timers.lingerMs / MS_PER_SECOND),
      view_max_secs: Math.round(this.timers.viewMaxMs / MS_PER_SECOND),
      low_battery_threshold: this.telemetry.lowBatThreshold,
      low_battery_hold_secs: Math.round(this.timers.lowBatHoldMs / MS_PER_SECOND),
      low_battery_wake_on_view: Boolean(this.telemetry.lowBatWakeOnView),
      track_stuck_spotlight: this.hasStuckSpotlightTracking(),
      card_theme: this.card.theme,
      card_position: this.card.position,
      sleep_screen: this.card.sleepScreen,
      card_show_on_live: this.card.shouldOverlayOnLive(),
      auto_frigate_mask: this.hasAutoFrigateMask(),
      preserve_aspect_ratio: this.getPreserveAspect(),
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
   * @param {{ hadInitialTelemetry: boolean, prevBattery: number|null, nowLowBat: boolean, nowOffline: boolean, stateChanged: boolean, minorTelemetryChanged: boolean, model: string, swVer: string }} summary - Property application summary.
   * @returns {{ logLevel: 'warn'|'info'|'debug'|'', logMsg: string }}
   */
  resolveTelemetryLogOutput(summary) {
    const {
      hadInitialTelemetry,
      prevBattery,
      nowLowBat,
      nowOffline,
      stateChanged,
      minorTelemetryChanged,
      model,
      swVer,
    } = summary;
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
   * @returns {Readonly<{ shouldRebuildCard: boolean, hadInitialTelemetry: boolean, isOffline: boolean, offlineChanged: boolean, stateChanged: boolean, logLevel: 'warn'|'info'|'debug'|'', logMsg: string }>}
   */
  applyTelemetryProperties(props, allowCardRebuild = false, now = Date.now()) {
    const summary = this.telemetry.applyProperties(props, now);
    const {
      hadInitialTelemetry,
      nowOffline,
      offlineChanged,
      stateChanged,
      wifiTierChanged,
    } = summary;
    const {logLevel, logMsg} = this.resolveTelemetryLogOutput(summary);

    const shouldRebuildCard = Boolean(
        allowCardRebuild || !hadInitialTelemetry || stateChanged || wifiTierChanged
    );
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
   * Formats the status card theme and position summary (e.g. 'icons@top-left' or 'icons/top-left').
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
    const prevState = this.sessionState;
    if (prevState && !canTransitionSession(prevState, nextState)) {
      return this.sessionState;
    }
    this.sessionState = nextState;
    if (nextState === SESSION_STATES.COOLDOWN && !this.sleptAt) {
      this.sleptAt = now;
    }
    if (prevState && prevState !== nextState) {
      this.prevSessionState = prevState;
      this.sessionStateChangedAt = now;
      const suffix = reason ? ' (' + reason + ')' : '';
      log.debug(this, 'session state: ' + prevState + ' -> ' + nextState + suffix);
    }
    return this.sessionState;
  }

  /**
   * Transitions the decoder backpressure FSM to nextState when permitted by ALLOWED_DECODER_TRANSITIONS.
   *
   * @param {string} nextState - Target DECODER_STATES value.
   * @param {string} [reason=''] - Optional human-readable transition trigger reason.
   * @returns {string}
   */
  _transitionDecoderTo(nextState, reason = '') {
    const prevState = this.decoderState;
    const allowed = ALLOWED_DECODER_TRANSITIONS[prevState];
    if (!prevState || (allowed && allowed.has(nextState))) {
      this.decoderState = nextState;
      if (prevState && prevState !== nextState) {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug(
            {name: this.name, decoderState: this.decoderState},
            'decoder state: ' + prevState + ' -> ' + nextState + suffix
        );
      }
    }
    return this.decoderState;
  }

  /**
   * Transitions the Frigate event lifecycle FSM to nextState when permitted by ALLOWED_FRIGATE_EVENT_TRANSITIONS.
   *
   * @param {string} nextState - Target FRIGATE_EVENT_STATES value.
   * @param {string} [reason=''] - Optional human-readable transition trigger reason.
   * @returns {string}
   */
  _transitionFrigateEventTo(nextState, reason = '') {
    const prevState = this.evState;
    const allowed = ALLOWED_FRIGATE_EVENT_TRANSITIONS[prevState];
    if (!prevState || (allowed && allowed.has(nextState))) {
      this.evState = nextState;
      if (prevState && prevState !== nextState) {
        const suffix = reason ? ' (' + reason + ')' : '';
        log.debug(
            {name: this.name, evState: this.evState},
            'frigate event state: ' + prevState + ' -> ' + nextState + suffix
        );
      }
    }
    return this.evState;
  }

  /**
   * Resets per-decoder backpressure queues and active frame state.
   */
  _resetDecoderPipeState() {
    this.pendingVideoPackets = [];
    this.pendingAudioPackets = [];
    this.liveFrames = [];
    this.decoderInputEnded = false;
    this.decoderStdoutPaused = false;
    this.frame = null;
    this.firstFrameAt = 0;
    this.frameNew = false;
    this.pcm = [];
    this.pcmLen = 0;
  }

  /**
   * Returns the current session FSM state, automatically advancing COOLDOWN to IDLE once
   * COOLDOWN_MS has elapsed since sleptAt.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string}
   */
  getSessionState(now = Date.now()) {
    if (this.sessionState === SESSION_STATES.COOLDOWN && now - this.sleptAt >= COOLDOWN_MS) {
      this.transitionTo(SESSION_STATES.IDLE, now, 'cooldown elapsed');
    }
    return this.sessionState;
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
    this.active = true;
    this.stoppingP2p = false;
    this.unexpectedRtspActive = false;
    this.heardFromDeviceInSession = false;
    this.idleRssiChangeCount = 0;
    this.idleRssiWindowStartAt = 0;
    this.activeMode = mode;
    switch (mode) {
      case STREAM_MODES.RTSP:
        this.transitionTo(SESSION_STATES.WAKING_RTSP, now, 'session start: rtsp');
        break;
      case STREAM_MODES.DOWNLOAD:
        this.transitionTo(SESSION_STATES.HANDSHAKING_BACKFILL, now, 'session start: backfill download');
        break;
      default:
        this.transitionTo(SESSION_STATES.WAKING_P2P, now, 'session start: p2p');
        break;
    }
    if (mode !== STREAM_MODES.DOWNLOAD) {
      this.activeBackfillJob = null;
      this.backfillContinuation = false;
    }
    this.sessionId++;
    this.p2pReady = p2pReady;
    this.startedAt = now;
    this.lastStartAt = now;
    this.gotVideo = false;
    this.frigateSawObject = false;
    this.lastFrigateObjectAt = 0;
    this.lastExtendCheckAt = 0;
    this.extendCheckInFlight = false;
    this.runtimeExtended = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.restarts = 0;
    this.lastVideoAt = 0;
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
      closedMode = this.activeMode || STREAM_MODES.P2P
  ) {
    this.active = false;
    this.activeMode = '';
    this.unexpectedRtspActive = false;
    this.heardFromDeviceInSession = false;
    this.idleRssiChangeCount = 0;
    this.idleRssiWindowStartAt = 0;
    this.isTestBackfill = false;
    this.downloadFinished = false;
    this.downloadFinishedAt = 0;
    this.downloadFrames = [];
    this.downloadFramePool.length = 0;
    this._resetDecoderPipeState();
    this._transitionDecoderTo(DECODER_STATES.DETACHED, 'session ended');
    this.starting = false;
    this.startPromise = null;
    if (!hadVideo && this.evTimer) {
      clearTimeout(this.evTimer);
      this.evTimer = null;
      this.evPending = false;
      this.evUntil = 0;
      this._transitionFrigateEventTo(FRIGATE_EVENT_STATES.IDLE, 'session ended without video');
    }
    this.getFrigateEventState(now);
    this.eventActive = false;
    this.frigateSawObject = false;
    this.lastFrigateObjectAt = 0;
    this.lastExtendCheckAt = 0;
    this.extendCheckInFlight = false;
    this.runtimeExtended = false;
    this.motionUntil = 0;
    this.eventPriority = 0;
    this.p2pReady = false;
    this.rtspRewaking = false;
    this.rtspRewakeStartedAt = 0;
    this.isStartupProbe = false;
    this.motionClearedAt = 0;
    this.lastStartAt = 0;
    this.sessionId++;
    this.lastStoppedAt = now;
    this.decSpawnedAt = 0;
    if (closedMode === STREAM_MODES.DOWNLOAD) {
      const activeClip = this.activeBackfillClip;
      const downloadSucceeded = hadVideo === undefined ? true : Boolean(hadVideo);
      this.activeBackfillClip = null;
      this.transitionTo(SESSION_STATES.IDLE, now, 'backfill session ended');
      if (downloadSucceeded) {
        this.lastBackfillDownloadFailedAt = 0;
      } else if (!preemptedByViewer && activeClip) {
        const attempts = Number(activeClip.downloadAttempts) || 1;
        if (attempts < MAX_BACKFILL_CLIP_DOWNLOAD_ATTEMPTS) {
          this.downloadedPaths.delete(activeClip.storagePath);
          this.backfillClipQueue = [
            activeClip,
            ...this.backfillClipQueue.filter((item) => item.storagePath !== activeClip.storagePath),
          ];
          this.backfillClip = this.backfillClipQueue[0] || null;
          if (this.activeBackfillJob && !this.pendingBackfill) {
            this.activeBackfillJob.transitionTo(
                BACKFILL_STATES.MATCHED,
                're-queued after failed download'
            );
            this.pendingBackfill = this.activeBackfillJob;
          }
          this.lastBackfillDownloadFailedAt = now;
        }
      }
      if (
          downloadSucceeded &&
          !preemptedByViewer &&
          !this.pendingBackfill &&
          this.backfillClipQueue.length === 0 &&
          this.activeBackfillJob &&
          this.activeBackfillJob.needsFollowUpClipQuery(this.lastDownloadedClipMs)
      ) {
        this.activeBackfillJob.prepareFollowUpQuery(now);
        this.pendingBackfill = this.activeBackfillJob;
        this.lastBackfillQueryAt = 0;
      }
      this.backfillContinuation = Boolean(
          !preemptedByViewer &&
          downloadSucceeded &&
          (this.backfillClipQueue.length > 0 || this.pendingBackfill)
      );
      if (this.backfillClipQueue.length === 0) {
        if (this.activeBackfillJob && !this.pendingBackfill) {
          this.activeBackfillJob.completeCurrentDownload();
        }
        this.activeBackfillJob = null;
      }
    } else {
      this.activeBackfillClip = null;
      this.backfillContinuation = false;
      this.activeTriggerEvents.clear();
      if (hadVideo && !preemptedByViewer) {
        this.sleptAt = now;
        this.transitionTo(SESSION_STATES.COOLDOWN, now, 'live session ended, entering cooldown');
      } else {
        this.transitionTo(
            SESSION_STATES.IDLE,
            now,
            preemptedByViewer ? 'preempted by viewer' : 'session ended without video'
        );
      }
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
   * @returns {{ inFlightStart: Promise<*>|null, closedMode: string, hadDownloadFinished: boolean, hadUnexpectedRtsp: boolean, wokeWithoutDeviceReply: boolean, sleepMsg: string }}
   */
  terminateSession(now, why, preemptedByViewer = false, initiator = 'bridge') {
    const inFlightStart = this.startPromise;
    const hadVideo = this.gotVideo;
    const hadDownloadFinished = Boolean(this.downloadFinished);
    const hadUnexpectedRtsp = Boolean(this.unexpectedRtspActive);
    const hadHeardFromDevice = Boolean(this.heardFromDeviceInSession);
    const wasEventActive = this.eventActive;
    const prevMotionUntil = this.motionUntil;
    const liveSecs = Math.round((now - this.startedAt) / 1000);
    const lastVideoAgo = this.lastVideoAt ? ((now - this.lastVideoAt) / 1000).toFixed(1) + 's' : 'none';
    const restartsCount = this.restarts;
    const closedSession = this.sessionId;
    const closedMode = this.activeMode || STREAM_MODES.P2P;
    const isDownload = closedMode === STREAM_MODES.DOWNLOAD;
    const frameBasis = this.downloadDecodedFrames || this.downloadVideoPackets;
    const clipDurationSecs = (frameBasis / Math.max(1, LIVE_FPS)).toFixed(1);
    const playbackSpanSecs =
        this.backfillPlaybackStartedAt > 0 && this.lastVideoAt >= this.backfillPlaybackStartedAt
            ? ((this.lastVideoAt - this.backfillPlaybackStartedAt) / 1000).toFixed(1)
            : '0.0';
    const postHoldSecs =
        this.lastVideoAt > 0 ? ((now - this.lastVideoAt) / 1000).toFixed(1) : '0.0';
    const backfillSummary = isDownload
        ? ', clipStart=' +
            formatEpochHms(this.backfillClipStartMs) +
            ', triggerAt=' +
            formatEpochHms(this.backfillTriggerAtMs) +
            ', clipDuration=' +
            clipDurationSecs +
            's, decodedFrames=' +
            this.downloadDecodedFrames +
            ', playedFrames=' +
            this.downloadPlayedFrames +
            ', packets=' +
            this.downloadVideoPackets +
            ', playbackSpan=' +
            playbackSpanSecs +
            's, postHold=' +
            postHoldSecs +
            's'
        : '';

    this.clearApiWakeTimer();
    if (Buffer.isBuffer(this.frame) && this.frame.length === FRAME) {
      this.lastFrame = Buffer.from(this.frame);
    }
    // A download cut after Frame 0 is reported as unsuccessful so endSession() re-queues the clip within its attempts.
    const endedWithVideo = isDownload
        ? hadVideo && isCompletedDownloadStop(hadDownloadFinished, initiator)
        : hadVideo;
    this.endSession(now, endedWithVideo, preemptedByViewer, closedMode);
    this.stoppingP2p = closedMode === STREAM_MODES.P2P;
    if (
        wasEventActive &&
        !isDownload &&
        (preemptedByViewer || String(initiator).startsWith(ARBITRATOR_INITIATOR_PREFIX)) &&
        prevMotionUntil > now &&
        !this.pendingBackfill &&
        this.backfillDownloads
    ) {
      this.pendingBackfill = new BackfillJob(
          this.lastSessionEventInfo || {
            name: this.name,
            at: this.startedAt || now,
            lastActivityAt: this.lastMotionAt || now,
            event: this.evLabel || 'motion detected',
            personName: this.evPerson || '',
            reason: this.reason || 'motion detected',
            priority: this.priority + (this.eventPriority || DEFAULT_EVENT_PRIORITY),
            attempts: 0,
            recordingActive: true,
          }
      );
    }
    const wokeWithoutDeviceReply = Boolean(
        !hadVideo &&
        !hadHeardFromDevice &&
        (initiator === 'error/watchdog-timeout' || initiator === 'error/rtsp-wake-timeout')
    );
    if (wokeWithoutDeviceReply && !wasEventActive) {
      this.telemetry.markWakeTimedOut();
    }
    if (this.isDeviceOffline()) {
      this.motionUntil = 0;
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
      sleepMsg,
    };
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
   * Returns true if the camera is currently active using a non-RTSP session mode (P2P or DOWNLOAD).
   *
   * @returns {boolean}
   */
  usesP2pSlot() {
    return Boolean(this.active && this.activeMode !== STREAM_MODES.RTSP);
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
    return Boolean(
        this.active &&
        this.activeMode !== STREAM_MODES.RTSP &&
        !(this.activeMode === STREAM_MODES.DOWNLOAD && this.downloadFinished)
    );
  }

  /**
   * Returns true if the camera is currently active in HomeBase native RTSP mode.
   *
   * @returns {boolean}
   */
  isActiveRtspSession() {
    return Boolean(this.active && this.activeMode === STREAM_MODES.RTSP);
  }

  /**
   * Returns true if the camera is currently active in a live (non-download) session.
   *
   * @returns {boolean}
   */
  isActiveLiveSession() {
    return Boolean(this.active && this.activeMode !== STREAM_MODES.DOWNLOAD);
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
   * @param {number} [sessionId=this.sessionId] - Expected session identifier.
   * @returns {boolean}
   */
  canSpawnRtspDecoder(sessionId = this.sessionId) {
    return Boolean(
        this.isCurrentSession(sessionId, STREAM_MODES.RTSP) && this.rtspUrl && !this.dec
    );
  }

  /**
   * Returns true if the initial Frigate detection event should be filed on RTSP stream start.
   *
   * @returns {boolean}
   */
  shouldFileInitialRtspEvent() {
    return Boolean(this.eventActive && !this.rtspRewaking && this.restarts === 0);
  }

  /**
   * Returns true if an RTSP session has received decoded video and is not currently re-waking.
   *
   * @returns {boolean}
   */
  isEstablishedRtspStream() {
    return Boolean(this.gotVideo && !this.rtspRewaking);
  }

  /**
   * Returns true if the camera is currently inactive, online, and has an unexpired motion or viewer wake request.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  wantsWake(now = Date.now()) {
    return Boolean(!this.active && !this.isDeviceOffline() && now < this.wantUntil());
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
    return Boolean(this.isActiveLiveSession() && now >= this.wantUntil());
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
    return Boolean(this.active && this.activeMode === STREAM_MODES.DOWNLOAD);
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
        ? this.activeMode !== STREAM_MODES.P2P && this.activeMode !== STREAM_MODES.DOWNLOAD
        : false;
  }

  /**
   * Records that the camera actively emitted a property update or livestream event during the current session.
   */
  markDeviceHeardInSession() {
    if (this.active) {
      this.heardFromDeviceInSession = true;
    }
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
   * @param {{ wsConnected?: boolean, stationConnected?: boolean, frigateConnected?: boolean, go2rtcConnected?: boolean }} [flags={}] - Service health flags.
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
    if (this.offlineSeedTimer) {
      clearTimeout(this.offlineSeedTimer);
      this.offlineSeedTimer = null;
    }
    this.offlineSeedConsumerSeen = false;
    this.offlineSeedExpireFn = null;
  }

  /**
   * Returns true while a temporary offline snapshot seed timer is active on this camera.
   *
   * @returns {boolean}
   */
  isSeedingOfflineSnapshot() {
    return Boolean(this.offlineSeedTimer);
  }

  /**
   * Schedules a timer to stop the encoder after seeding the cached snapshot to Frigate while offline.
   *
   * @param {number} seedDurationMs - Duration in milliseconds to stream the cached snapshot before stopping.
   * @param {() => void} onExpire - Callback invoked when the seed window expires.
   */
  scheduleOfflineSeedStop(seedDurationMs, onExpire) {
    this.clearOfflineSeedTimer();
    this.offlineSeedExpireFn = onExpire;
    const waitMs = Math.max(1, Number(seedDurationMs) || 1);
    const timer = setTimeout(() => {
      this.offlineSeedTimer = null;
      this.offlineSeedConsumerSeen = false;
      this.offlineSeedExpireFn = null;
      onExpire();
    }, waitMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.offlineSeedTimer = timer;
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
    if (!this.offlineSeedTimer || this.offlineSeedConsumerSeen || !this.offlineSeedExpireFn) {
      return false;
    }
    const expireFn = this.offlineSeedExpireFn;
    const holdMs = Math.max(1, Number(postConsumerHoldMs) || 1);
    this.triggerKeyframeBurst(now, holdMs + SHORT_KEYFRAME_BURST_MS);
    this.scheduleOfflineSeedStop(holdMs, expireFn);
    this.offlineSeedConsumerSeen = true;
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
  notifyEncoderConsumersObserved(
      consumerCount,
      postConsumerHoldMs = SHORT_KEYFRAME_BURST_MS,
      now = Date.now()
  ) {
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
    this.encoderStoppedForOffline = true;
  }

  /**
   * Stops this camera's persistent FFmpeg encoder process with SIGKILL when the camera is offline so
   * go2rtc and Frigate detect the offline RTSP stream without flushing a partial rawvideo frame.
   *
   * @returns {boolean} True if an active encoder process was stopped or newly marked stopped for offline.
   */
  pauseEncoderForOffline() {
    this.clearOfflineSeedTimer();
    this.encoderConsumerConnected = false;
    const wasAlreadyPaused = Boolean(this.encoderStoppedForOffline && !this.enc);
    this.encoderStoppedForOffline = true;
    if (!this.enc) {
      return !wasAlreadyPaused;
    }
    const enc = this.enc;
    this.enc = null;
    try {
      enc.kill(PROCESS_SIGNALS.SIGKILL);
    } catch (err) {
      // Ignore errors when stopping encoder for offline state.
    }
    return true;
  }

  /**
   * Returns true when the camera is back online after its encoder was stopped for an offline state.
   *
   * @returns {boolean}
   */
  shouldResumeOfflineEncoder() {
    return Boolean(this.encoderStoppedForOffline && !this.isDeviceOffline());
  }

  /**
   * Clears the offline encoder pause flag when the camera's encoder is restarted.
   *
   * @returns {boolean} True if the encoder had been paused for offline.
   */
  clearEncoderOfflinePause() {
    this.clearOfflineSeedTimer();
    const wasPaused = Boolean(this.encoderStoppedForOffline);
    this.encoderStoppedForOffline = false;
    return wasPaused;
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
    return this.isLowBattery()
        ? Math.min(this.timers.holdMs, this.timers.lowBatHoldMs)
        : this.timers.holdMs;
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
   * Returns true if this camera is configured with always_backfill: true and should skip
   * waking for a live stream on Eufy motion/person/ring events in favor of HomeBase clip backfill.
   *
   * @returns {boolean}
   */
  shouldBackfillOnlyOnEvent() {
    return Boolean(this.backfillDownloads && this.alwaysBackfill && !this.isActiveLiveSession());
  }

  /**
   * Returns true if an external /api/wake request while idle should stay in backfill-only mode
   * instead of starting a live stream (only when the camera is in backfill mode and a Eufy hardware
   * trigger or BackfillJob is already active).
   *
   * @returns {boolean}
   */
  shouldBackfillOnlyOnApiWake() {
    return Boolean(
        this.shouldBackfillOnlyOnEvent() &&
        (this.hasActiveHardwareTriggers() || this.hasPendingBackfill() || this.isBackfillPlayback())
    );
  }

  /**
   * Returns true if a human Live View connection should be blocked from waking a live stream
   * because the camera is idle with a pending HomeBase BackfillJob.
   *
   * @returns {boolean}
   */
  isViewerBlockedByBackfill() {
    return Boolean(!this.active && this.hasPendingBackfill());
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
    return this.active
        ? Boolean(this.isBackfillPlayback() && !this.isStreamingLive(now, freshFrameMaxAgeMs))
        : this.hasPendingBackfill();
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
    return Boolean(now < this.wantUntil() || this.isWaitingForBackfill(now, freshFrameMaxAgeMs));
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
        ? this.usesP2pSlot() ||
            (!this.isRtspCapable() &&
              (this.wantsWake(now) || (!urgentTest && now - (this.sleptAt || 0) < delayMs)))
        : false;
  }

  /**
   * Returns true if this camera's HomeBase station P2P slot is idle and past the post-sleep
   * backfill delay across all non-RTSP cameras on the same station.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} delayMs - Required idle delay after P2P sleep in milliseconds.
   * @param {boolean} [allowDrainingSelf=false] - Whether to ignore this camera's own RAM-draining backfill playback when querying HomeBase.
   * @returns {boolean}
   */
  isStationIdleForBackfill(allCams, now, delayMs, allowDrainingSelf = false) {
    const stationKey = this.getStationKey();
    const urgentTest = this.hasUrgentTestBackfill();
    return !allCams.some((other) =>
      allowDrainingSelf && other === this && this.isBackfillPlayback() && this.downloadFinished
          ? false
          : other.isBlockingStationBackfill(stationKey, now, delayMs, urgentTest)
    );
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
   * Returns true if this camera currently has a non-zero viewer hold timestamp or an active waking viewer.
   *
   * @returns {boolean}
   */
  hasPendingViewerWake() {
    return Boolean(this.viewUntil > 0 || this.hasWakingViewer());
  }

  /**
   * Clears any pending viewer wake timer on this camera and marks all current go2rtc
   * consumers as ineligible to wake it until they disconnect and reconnect.
   *
   * @param {string} [clearReason=''] - Optional diagnostic context for why the viewer queue was cleared.
   */
  clearViewerQueue(clearReason = '') {
    const hadViewers = this.hasPendingViewerWake();
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
    this.activeBackfillJob = null;
    this.activeBackfillClip = null;
    this.backfillClip = null;
    this.backfillClipQueue = [];
    this.lastBackfillDownloadFailedAt = 0;
    if (!this.active) {
      this.activeTriggerEvents.clear();
    }
  }

  /**
   * Returns true if this camera has a pending or matched BackfillJob waiting to be queried or downloaded.
   *
   * @returns {boolean}
   */
  hasPendingBackfill() {
    return Boolean(this.pendingBackfill || this.backfillClip || this.backfillClipQueue.length > 0);
  }

  /**
   * Computes the safety-net Backfill cancellation cutoff as 20% of the camera's configured
   * hardware clip or hold duration, clamped to [3000ms..15000ms].
   *
   * @returns {number}
   */
  getSustainedLiveVideoCutoffMs() {
    const clipSecs = this.telemetry.hwRecordingCfg.recordingClipLength;
    const baseMs =
        typeof clipSecs === 'number' && clipSecs > 0
            ? clipSecs * MS_PER_SECOND
            : this.timers.holdMs;
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
   * @param {number} [minVideoMs=this.getSustainedLiveVideoCutoffMs()] - Minimum decoded video duration required to cancel backfill.
   * @returns {boolean} True if a pending backfill job was canceled.
   */
  cancelBackfillIfLiveConfirmed(now, minVideoMs = this.getSustainedLiveVideoCutoffMs()) {
    if (
        !this.pendingBackfill ||
        this.pendingBackfill.isUrgentTest() ||
        this.activeMode === STREAM_MODES.DOWNLOAD
    ) {
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
    return this.pendingBackfill ? this.pendingBackfill.isExpired(now, maxAgeMs) : false;
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
    const maxRecordingWaitMs = Math.max(
        BACKFILL_RECORDING_WAIT_CAP_MS,
        this.timers.holdMs + BACKFILL_POST_CLEAR_SETTLE_MS
    );
    const canQueryWhileIdleOrDraining =
        !this.active || Boolean(this.isBackfillPlayback() && this.downloadFinished);
    return canQueryWhileIdleOrDraining &&
        this.pendingBackfill &&
        !this.backfillClip &&
        now - this.lastBackfillQueryAt >= queryCooldownMs
        ? this.pendingBackfill.isReadyToQuery(now, minEventAgeMs, maxRecordingWaitMs)
        : false;
  }

  /**
   * Attempts to match a parsed HomeBase database clip candidate against this camera's pending
   * or active BackfillJob, queuing matching clips in chronological order on this.backfillClipQueue
   * and setting this.backfillClip to the next clip to download.
   *
   * @param {{ devSn: string, storagePath: string, cipherId: number, clipMs: number }} candidate - Parsed DB row.
   * @returns {boolean} True if matched and queued for download.
   */
  tryMatchBackfillCandidate(candidate) {
    const job = this.pendingBackfill || this.activeBackfillJob;
    if (!job || !candidate) {
      return false;
    }
    if (job.isUrgentTest() && this.backfillClip) {
      return false;
    }
    if (this.backfillClipQueue.some((c) => c.storagePath === candidate.storagePath)) {
      return false;
    }
    if (!job.enqueueMatchedCandidate(candidate, this.downloadedPaths)) {
      return false;
    }
    const newlyMatched = job.matchedClips.find((c) => c.storagePath === candidate.storagePath);
    if (newlyMatched) {
      this.backfillClipQueue.push(newlyMatched);
      if (!job.isUrgentTest()) {
        this.backfillClipQueue.sort((a, b) => (a.clipMs || 0) - (b.clipMs || 0));
      }
    }
    this.backfillClip = this.backfillClipQueue[0] || null;
    return true;
  }

  /**
   * Formats a structured log line when a HomeBase database record matches a pending or active BackfillJob.
   *
   * @param {{ storagePath: string, cipherId: number, clipMs?: number }} candidate - Matched DB row.
   * @returns {string}
   */
  formatBackfillClipMatchLog(candidate) {
    const job = this.pendingBackfill || this.activeBackfillJob;
    const clipMs = candidate && candidate.clipMs ? candidate.clipMs : 0;
    const triggerMs = job && job.at ? job.at : 0;
    const clearedMs = job && job.clearedAt ? job.clearedAt : 0;
    const preRollStr =
        clipMs > 0 && triggerMs > 0 ? ((triggerMs - clipMs) / 1000).toFixed(1) + 's' : 'n/a';
    const sensorSpanStr =
        triggerMs > 0 && clearedMs >= triggerMs
            ? ((clearedMs - triggerMs) / 1000).toFixed(1) + 's'
            : 'active';
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
      this.getBackfillReason('backfill') +
      '")'
    );
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
            (this.firstFrameAt > 0 && this.gotVideo && Buffer.isBuffer(this.lastFrame)) ||
            (this.isBackfillPlayback() &&
              this.backfillContinuation &&
              Buffer.isBuffer(this.lastFrame)))
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
        (this.hasFreshFrame(now, freshFrameMs) ||
            (this.evDispatchedAt > 0 && this.gotVideo && Buffer.isBuffer(this.lastFrame))) &&
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
   * Returns true if the camera is already active in a live-view session.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isActivelyViewing(now = Date.now()) {
    return Boolean(this.active && now < this.viewUntil);
  }

  /**
   * Returns true if the camera recently went to sleep and is within the viewer cooldown window.
   * Cooldown is bypassed when the camera has active hardware triggers (Eufy motion/AI events).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isInViewerCooldown(now = Date.now()) {
    return this.hasActiveHardwareTriggers()
        ? false
        : this.getSessionState(now) === SESSION_STATES.COOLDOWN || now - this.sleptAt < COOLDOWN_MS;
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
        this.active &&
        this.gotVideo &&
        !this.extendCheckInFlight &&
        this.activeMode !== STREAM_MODES.DOWNLOAD &&
        !this.isStartupProbe
    );
    if (!canEvaluate) {
      return NO_FRIGATE_POLL;
    }
    this.getFrigateEventState(now);
    const holdUntil = this.wantUntil();
    const nearMaxLimit = now - this.startedAt >= this.timers.maxMs - safetyMarginMs;
    const nearHoldExpiry = holdUntil - now <= checkWindowMs;
    const nearEventExpiry = Boolean(
        this.eventActive &&
        !this.evPending &&
        !this.evTimer &&
        this.evUntil > this.startedAt &&
        this.evUntil - now <= checkWindowMs
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
    return Boolean(this.active && this.isInMotion(now) && now >= this.viewUntil);
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
        this.timers.earlySleepMs > 0 &&
        this.isMotionOnlyActiveSession(now) &&
        now - this.lastMotionAt >= Math.min(this.timers.earlySleepMs, minEventVideoMs)
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
    return Boolean(this.gotVideo && now - (this.lastStartAt || 0) > graceMs);
  }

  /**
   * Evaluates whether an active motion-woken camera is due for an early-sleep Frigate idle check.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [pollIntervalMs=DEFAULT_EARLY_SLEEP_POLL_MS] - Minimum interval between Frigate idle polls.
   * @param {number} [settleMs=DEFAULT_EARLY_SLEEP_SETTLE_MS] - Settle delay after Eufy reports activity cleared.
   * @returns {{ due: boolean, clearedByEufy: boolean }}
   */
  checkEarlySleepDue(
      now,
      pollIntervalMs = DEFAULT_EARLY_SLEEP_POLL_MS,
      settleMs = DEFAULT_EARLY_SLEEP_SETTLE_MS
  ) {
    const earlySleepMs = this.timers.earlySleepMs;
    if (earlySleepMs <= 0 || !this.isMotionOnlyActiveSession(now)) {
      return {due: false, clearedByEufy: false};
    }
    if (!this.gotVideo || now - this.firstVideoAt < earlySleepMs) {
      return {due: false, clearedByEufy: false};
    }
    if (now - this.lastEarlySleepCheckAt < pollIntervalMs) {
      return {due: false, clearedByEufy: false};
    }
    const clearedByEufy =
        this.motionClearedAt > this.lastMotionAt && now - this.motionClearedAt >= settleMs;
    const elapsedQuiet = now - this.lastMotionAt >= earlySleepMs;
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
    const decAgeMs = now - this.decSpawnedAt;
    return this.dec && this.decSpawnedAt
        ? decAgeMs >= minActiveMs && decAgeMs < maxStallMs
        : false;
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
        this.active &&
        this.eventActive &&
        this.timers.letEufyDecideEnd &&
        this.gotVideo &&
        now >= this.viewUntil &&
        (this.motionClearedAt > this.lastMotionAt || now - this.firstVideoAt >= minCleanVideoMs)
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
    const stoppedRef = Math.max(this.sleptAt || 0, this.lastStoppedAt || 0);
    const isBackfillRecording = Boolean(this.pendingBackfill && this.pendingBackfill.recordingActive);
    const hasStuckIdleLight = this.hasStuckIdleLightPastGrace(now);
    if (
        (this.isRtspCapable() && !hasStuckIdleLight) ||
        this.isSessionActive() ||
        this.stoppingP2p ||
        this.hasActiveHardwareTriggers() ||
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
   * @returns {boolean}
   */
  canPiggybackExternalP2pInBackfill() {
    return Boolean(!this.hasActiveHardwareTriggers() && !this.hasPendingBackfill());
  }

  /**
   * Returns true if the current session is a passive external P2P piggyback on a "backfill"
   * camera with no connected Frigate human viewer.
   *
   * @returns {boolean}
   */
  isPiggybackedExternalSession() {
    return Boolean(
        this.active &&
        this.alwaysBackfill &&
        this.wakeInitiator === EXTERNAL_WAKE_INITIATOR &&
        !this.hasWakingViewer()
    );
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
    const stoppedRef = Math.max(this.sleptAt || 0, this.lastStoppedAt || 0);
    const allowedInMode = !this.alwaysBackfill || this.canPiggybackExternalP2pInBackfill();
    return Boolean(
        !this.active &&
        !this.stoppingP2p &&
        allowedInMode &&
        (stoppedRef <= 0 || now - stoppedRef > guardMs)
    );
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
    this.reason = EXTERNAL_P2P_WAKE_REASON;
    this.wakeInitiator = EXTERNAL_WAKE_INITIATOR;
    this.lastMotionAt = now;
    this.motionUntil = Math.max(this.motionUntil, now + this.getEventHoldMs());
    this.viewSince = now;
    this.viewUntil = Math.max(this.viewUntil, now + this.timers.holdMs);
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
    this.reason = EXTERNAL_RTSP_WAKE_REASON;
    this.wakeInitiator = EXTERNAL_WAKE_INITIATOR;
    this.lastMotionAt = now;
    this.motionUntil = Math.max(this.motionUntil, now + this.getEventHoldMs());
    this.viewSince = now;
    this.viewUntil = Math.max(this.viewUntil, now + this.timers.holdMs);
    this.eventActive = true;
    this.beginSession(STREAM_MODES.RTSP, now, true);
    return true;
  }

  /**
   * Evaluates whether unsolicited P2P video packets arriving while inactive should trigger
   * a forced stop_livestream, updating lastUnsolicitedStopAt when true.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [delayMs=DEFAULT_UNSOLICITED_VIDEO_DELAY_MS] - Minimum delay since last stop and last unsolicited stop.
   * @returns {{ shouldStop: boolean, sleptAgo: string }}
   */
  shouldStopUnsolicitedVideo(now, delayMs = DEFAULT_UNSOLICITED_VIDEO_DELAY_MS) {
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
    return Boolean(this.active && now - this.startedAt >= this.timers.maxMs);
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
        now - Math.max(this.startedAt, this.motionUntil) >= this.timers.viewMaxMs
    );
  }

  /**
   * Returns true if the camera has buffered backfill download frames waiting to be encoded.
   *
   * @returns {boolean}
   */
  hasBufferedDownloadFrames() {
    return Boolean(this.isBackfillPlayback() && this.downloadFrames.length > 0);
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
    return Boolean(
        this.hasBufferedDownloadFrames() &&
        !this.frameNew &&
        now - this.lastWrite >= frameIntervalMs
    );
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
        !this.active ||
        this.isBackfillPlayback() ||
        !this.hasWritableEncoderStdin() ||
        !this.firstFrameAt ||
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
  bufferLiveFrame(
      rawBuf,
      now = Date.now(),
      lastSeenHm = '',
      maxBurstFrames = MAX_LIVE_BURST_FRAMES
  ) {
    if (!this.shouldBufferLiveFrame(now)) {
      return false;
    }
    if (this.liveFrames.length >= maxBurstFrames) {
      const dropped = this.liveFrames.shift();
      if (
          Buffer.isBuffer(dropped) &&
          this.downloadFramePool.length < DOWNLOAD_POOL_MAX_BUFFERS
      ) {
        this.downloadFramePool.push(dropped);
      }
    }
    const frameCopy = this.acquireDownloadFrameBuffer(rawBuf);
    this.liveFrames.push(frameCopy);
    this.frameAt = now;
    this.lastVideoAt = now;
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
        prevFrame !== this.liveFrameRing[0] &&
        prevFrame !== this.liveFrameRing[1] &&
        this.downloadFramePool.length < DOWNLOAD_POOL_MAX_BUFFERS
    ) {
      this.downloadFramePool.push(prevFrame);
    }
    this.frame = nextBuf;
    this.frameAt = now;
    this.lastVideoAt = now;
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
    if (
        this.useRtsp &&
        (this.rtspUrl || this.rtspSupported) &&
        !this.rtspEnabledChecked &&
        rtspStreamProp === false
    ) {
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
        this.isCurrentSession(this.sessionId, STREAM_MODES.RTSP) ||
        (this.isCurrentSession(this.sessionId, STREAM_MODES.P2P) && this.gotVideo) ||
        (this.useRtsp && !this.isDoorbell() && !this.isCurrentSession(this.sessionId, STREAM_MODES.P2P))
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
        this.telemetry.hasPowerConservationEnabled() &&
        (!this.useRtsp || !this.rtspUrl || this.isDoorbell())
    );
    const shouldRestartP2p = Boolean(
        this.isCurrentSession(this.sessionId, STREAM_MODES.P2P) && !this.gotVideo
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
        this.sleptAt || 0,
        this.lastStoppedAt || 0,
        this.motionClearedAt || 0,
        this.lastMotionAt || 0,
        this.telemetry.lightOnAt || 0
    );
    if (
        this.hasStuckSpotlightTracking() &&
        this.telemetry.isLightOn() &&
        !this.isSessionActive() &&
        !this.stoppingP2p &&
        !this.hasActiveHardwareTriggers() &&
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
    const stationKey = this.getStationKey();
    return this.needsStartupSnapshot && !this.isLowBattery() && !this.isDeviceOffline()
        ? !allCams.some(
            (other) =>
              other.getStationKey() === stationKey &&
              (other.isSessionActive() || other.wantsWake(now))
          )
        : false;
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
    this.clearPendingBackfill();
    this.lastBackfillQueryAt = 0;
    this.pendingBackfill = BackfillJob.createSigUsr1TestJob(now, this.name);
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
    return Boolean(!this.active && !this.isRtspCapable());
  }

  /**
   * Formats the concise camera mode/hold entry for the startup banner log.
   *
   * @returns {string}
   */
  formatStartupSummary() {
    return this.name + '(' + this.mode + ':' + Math.round(this.timers.holdMs / 1000) + 's)';
  }

  /**
   * Returns true if this camera is idle, has a matched HomeBase clip ready to download,
   * and is past any post-failure download retry cooldown.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [retryCooldownMs=DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS] - Cooldown after a failed download attempt in ms.
   * @returns {boolean}
   */
  isReadyForBackfillDownload(
      now = Date.now(),
      retryCooldownMs = DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS
  ) {
    const cooldownElapsed =
        !this.lastBackfillDownloadFailedAt ||
        now - this.lastBackfillDownloadFailedAt >= retryCooldownMs;
    return Boolean(this.backfillClip && !this.active && cooldownElapsed);
  }

  /**
   * Returns true if this camera has a pending BackfillJob that still needs a HomeBase
   * station.database_query_latest_info fallback query (including while draining a previous clip tail).
   *
   * @returns {boolean}
   */
  needsLatestInfoBackfillQuery() {
    return Boolean(this.pendingBackfill && !this.backfillClip);
  }

  /**
   * Returns true if this camera has a matched backfill clip ready to download and its station's P2P slot is idle.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} delayMs - Required idle delay after P2P sleep in milliseconds.
   * @param {number} [retryCooldownMs=DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS] - Cooldown after a failed download attempt in ms.
   * @returns {boolean}
   */
  canStartBackfillDownloadNow(
      allCams,
      now,
      delayMs,
      retryCooldownMs = DEFAULT_BACKFILL_DOWNLOAD_RETRY_COOLDOWN_MS
  ) {
    return Boolean(
        this.isReadyForBackfillDownload(now, retryCooldownMs) &&
        this.isStationIdleForBackfill(allCams, now, delayMs)
    );
  }

  /**
   * Returns true if this camera is ready to query HomeBase for a backfill clip and its station's P2P slot is idle.
   *
   * @param {Camera[]} allCams - All configured Camera instances.
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} minEventAgeMs - Minimum age of the trigger event before querying HomeBase.
   * @param {number} queryCooldownMs - Minimum interval between database queries on the same camera.
   * @param {number} delayMs - Required idle delay after P2P sleep in milliseconds.
   * @returns {boolean}
   */
  canQueryBackfillNow(allCams, now, minEventAgeMs, queryCooldownMs, delayMs) {
    return Boolean(
        this.canQueryBackfill(now, minEventAgeMs, queryCooldownMs) &&
        this.isStationIdleForBackfill(allCams, now, delayMs, true)
    );
  }

  /**
   * Returns the effective priority of this camera's pending or active BackfillJob (or 0 if none).
   *
   * @returns {number}
   */
  getBackfillPriority() {
    return (this.pendingBackfill || this.activeBackfillJob)?.priority || 0;
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
    return this.viewers > 0;
  }

  /**
   * Records the latest Frigate event ID created via POST /api/events/<camera>/<label>/create
   * so subsequent /api/events queries can exclude synthetic bridge events by ID.
   *
   * @param {*} eventId - Created Frigate event ID.
   * @param {number} [now=Date.now()] - Timestamp when Frigate confirmed event creation.
   */
  recordCreatedFrigateEvent(eventId, now = Date.now()) {
    this.lastCreatedFrigateEventId = String(eventId || '');
    this.evCreatedAt = now;
  }

  /**
   * Returns the recognized person name currently associated with this camera's Frigate event.
   *
   * @returns {string}
   */
  getEventPerson() {
    return this.evPerson || '';
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
        (this.lastCreatedFrigateEventId && ev.id === this.lastCreatedFrigateEventId) ||
        ev.sub_label === 'eufy' ||
        ev.source_type === 'api' ||
        ev.data?.type === 'api'
        ? false
        : (ev.data?.type === 'object' ? true : !this.evPerson || ev.sub_label !== this.evPerson);
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
  evaluateFrigateEventsActivity(
      events,
      now = Date.now(),
      recentTailMs = DEFAULT_RECENT_FRIGATE_OBJECT_MS
  ) {
    if (!Array.isArray(events)) {
      return false;
    }
    const minEndMs = Math.max(this.startedAt || 0, now - recentTailMs);
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
    const hasExplicit =
        rawDuration !== undefined && rawDuration !== null && !Number.isNaN(Number(rawDuration));
    return hasExplicit
        ? Math.max(minSecs, Math.min(camMaxSecs, Number(rawDuration)))
        : camHoldSecs;
  }

  /**
   * Transitions the camera into active backfill download mode for the given matched clip,
   * advancing backfillClipQueue to any subsequent clip from the same activity window.
   *
   * @param {{ storagePath: string, cipherId: number, clipMs?: number, downloadAttempts?: number, event: string, personName: string, reason: string }} clip - Matched clip.
   * @param {boolean} isTest - Whether triggered by SIGUSR1 test hook.
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  beginBackfillDownload(clip, isTest, now) {
    if (this.pendingBackfill) {
      this.activeBackfillJob = this.pendingBackfill;
      this.pendingBackfill = null;
    }
    if (this.activeBackfillJob) {
      if (this.activeBackfillJob.matchedClips.length > 0) {
        this.activeBackfillJob.shiftNextClipForDownload();
      } else {
        if (
            this.activeBackfillJob.state !== BACKFILL_STATES.MATCHED &&
            this.activeBackfillJob.state !== BACKFILL_STATES.DOWNLOADING
        ) {
          this.activeBackfillJob.transitionTo(
              BACKFILL_STATES.MATCHED,
              'clip matched for download'
          );
        }
        this.activeBackfillJob.transitionTo(
            BACKFILL_STATES.DOWNLOADING,
            'clip dequeued for download'
        );
      }
    }
    const nextAttempt = (Number(clip.downloadAttempts) || 0) + 1;
    this.activeBackfillClip = Object.freeze({...clip, downloadAttempts: nextAttempt});
    this.backfillClipQueue = this.backfillClipQueue.filter(
        (item) => item.storagePath !== clip.storagePath
    );
    this.backfillClip = this.backfillClipQueue[0] || null;
    this.downloadedPaths.add(clip.storagePath);
    this.lastDownloadedClipMs = clip.clipMs || now;
    this.backfillClipStartMs = clip.clipMs || 0;
    this.backfillTriggerAtMs = this.activeBackfillJob ? this.activeBackfillJob.at || 0 : 0;
    this.backfillClearedAtMs = this.activeBackfillJob ? this.activeBackfillJob.clearedAt || 0 : 0;
    this.backfillPlaybackStartedAt = 0;
    this.downloadVideoPackets = 0;
    this.downloadDecodedFrames = 0;
    this.downloadPlayedFrames = 0;
    this.isTestBackfill = Boolean(isTest);
    this.downloadFinished = false;
    this.downloadFinishedAt = 0;
    this.downloadFrames = [];
    this.eventActive = false;
    this.reason = 'backfill: ' + clip.reason;
    this.wakeInitiator = 'bridge-backfill';
    this.evUntil = 0;
    this.evDispatchedAt = 0;
    this.evCreatedAt = 0;
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
      (this.wakeInitiator || 'bridge') +
      ', reason="' +
      this.reason +
      '", priority=' +
      this.getEffectivePriority(now) +
      ', session=' +
      this.sessionId +
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
        (this.wakeInitiator || 'bridge') +
        ', reason="' +
        this.reason +
        '", station=' +
        stationKey +
        ', priority=' +
        this.getEffectivePriority(now) +
        ', session=' +
        this.sessionId +
        ')' +
        ecoTag;
    return Object.freeze({
      shouldFileEvent: Boolean(this.eventActive),
      eventReason: this.reason,
      personName: this.pendingBackfill ? this.pendingBackfill.personName : '',
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
    return Boolean(!candidateCam.isInMotion(now));
  }

  /**
   * Clears a blocked motion hold on this camera when preempt_event_streams is disabled
   * and this camera's motion arrived after activeCam's motion.
   *
   * @param {Camera} activeCam - Camera currently occupying the station P2P slot.
   * @param {boolean} [preemptEnabled=PREEMPT_EVENT_STREAMS] - Whether event stream preemption is enabled.
   */
  expireBlockedMotionHold(activeCam, preemptEnabled = PREEMPT_EVENT_STREAMS) {
    if (!preemptEnabled && this.lastMotionAt > activeCam.lastMotionAt) {
      this.motionUntil = 0;
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
    this.lastStartAt = now;
    return this.sessionId;
  }

  /**
   * Returns true if a device.start_rtsp_livestream wake attempt was recorded within windowMs.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [windowMs=2000] - Recency window in milliseconds.
   * @returns {boolean}
   */
  hasRecentRtspStartAttempt(now = Date.now(), windowMs = DEFAULT_RTSP_START_DEDUP_WINDOW_MS) {
    return Boolean(this.lastStartAt > 0 && now - this.lastStartAt < windowMs);
  }

  /**
   * Returns true if this is the initial wake attempt (restarts === 0) of the current session.
   *
   * @returns {boolean}
   */
  isFirstWakeAttempt() {
    return this.restarts === 0;
  }

  /**
   * Marks the camera's motion hold as ended at checkNow for early sleep and returns the elapsed quiet seconds.
   *
   * @param {number} [checkNow=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {number} Elapsed quiet duration in seconds.
   */
  markEarlySleep(checkNow = Date.now()) {
    const quietSecs = Math.round((checkNow - this.lastMotionAt) / 1000);
    this.motionUntil = checkNow;
    return quietSecs;
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
    return this.startedAt ? Math.round((now - this.startedAt) / 1000) : 0;
  }

  /**
   * Records that an /api/wake trigger is being applied to this camera.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [createEvent=false] - Whether a synthetic Frigate event is being created.
   */
  recordApiWakeTriggered(now = Date.now(), createEvent = false) {
    this.lastApiWakeAt = now;
    if (createEvent) {
      this.motionClearedAt = 0;
    }
  }

  /**
   * Returns true if a paced /api/wake timer is currently scheduled on this camera.
   *
   * @returns {boolean}
   */
  hasPendingApiWakeTimer() {
    return Boolean(this.apiWakeTimer);
  }

  /**
   * Returns the scheduled hold duration (in ms) of the currently pending /api/wake timer.
   *
   * @returns {number}
   */
  getScheduledApiWakeDurationMs() {
    return this.apiWakePendingOpts ? this.apiWakePendingOpts.durationMs : 0;
  }

  /**
   * Returns the human-readable reason of the pending or active BackfillJob on this camera.
   *
   * @param {string} [fallback='backfill'] - Fallback string when no job is present.
   * @returns {string}
   */
  getBackfillReason(fallback = 'backfill') {
    return (this.pendingBackfill || this.activeBackfillJob)?.reason || fallback;
  }

  /**
   * Expires an unfulfilled pending BackfillJob if it has exceeded maxAgeMs and returns its reason string.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string} Expired backfill reason, or empty string if not expired.
   */
  expirePendingBackfillIfNeeded(now = Date.now()) {
    if (this.isBackfillExpired(now)) {
      const reason = this.pendingBackfill ? this.pendingBackfill.reason : 'backfill';
      this.clearPendingBackfill();
      return reason;
    }
    return '';
  }

  /**
   * Starts the next matched backfill download session and returns an immutable descriptor `{ clip, sessionId }`.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {Readonly<{ clip: Record<string, *>, sessionId: number }>}
   */
  startNextBackfillDownload(now = Date.now()) {
    const clip = this.backfillClip;
    const isTest = this.hasUrgentTestBackfill();
    this.beginBackfillDownload(clip, isTest, now);
    return Object.freeze({clip, sessionId: this.sessionId});
  }

  /**
   * Consumes a HomeBase database query attempt for the pending BackfillJob and returns an immutable outcome.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [maxAttempts=BACKFILL_MAX_QUERY_ATTEMPTS] - Maximum allowed query attempts.
   * @returns {Readonly<{ allowed: boolean, attempts: number, maxAttempts: number, reason: string }>}
   */
  beginBackfillDatabaseQuery(now = Date.now(), maxAttempts = BACKFILL_MAX_QUERY_ATTEMPTS) {
    this.lastBackfillQueryAt = now;
    if (!this.pendingBackfill) {
      return Object.freeze({allowed: false, attempts: 0, maxAttempts, reason: ''});
    }
    const reason = this.pendingBackfill.reason;
    const allowed = this.pendingBackfill.consumeQueryAttempt(maxAttempts);
    const attempts = this.pendingBackfill.attempts;
    if (!allowed) {
      this.clearPendingBackfill();
    }
    return Object.freeze({allowed, attempts, maxAttempts, reason});
  }

  /**
   * Returns true if this camera is active and not already in the middle of a start_livestream RPC call.
   *
   * @returns {boolean}
   */
  canBeginP2pStart() {
    return Boolean(this.active && !this.starting);
  }

  /**
   * Marks this camera as actively executing a start_livestream RPC call and returns its sessionId.
   *
   * @returns {number}
   */
  beginP2pStartAttempt() {
    this.starting = true;
    return this.sessionId;
  }

  /**
   * Marks the camera's P2P stream as ready to ingest packets and optionally updates lastStartAt.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {boolean} [updateStartAt=true] - Whether to set lastStartAt = now.
   */
  markP2pStreamReady(now = Date.now(), updateStartAt = true) {
    this.p2pReady = true;
    if (updateStartAt) {
      this.lastStartAt = now;
    }
  }

  /**
   * Marks the camera's P2P stream as not ready to ingest packets.
   */
  markP2pStreamNotReady() {
    this.p2pReady = false;
  }

  /**
   * Applies a backoff offset to lastStartAt after a failed start_livestream RPC if sessionId is still current.
   *
   * @param {number} sessionId - Session identifier of the failed attempt.
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @param {number} [backoffMs=5000] - Backoff offset in milliseconds.
   */
  applyFailedStartBackoff(sessionId, now = Date.now(), backoffMs = DEFAULT_FAILED_START_BACKOFF_MS) {
    if (this.isCurrentSession(sessionId)) {
      this.lastStartAt = now - backoffMs;
    }
  }

  /**
   * Clears the starting flag if sessionId still matches the current session.
   *
   * @param {number} sessionId - Session identifier of the completed start attempt.
   */
  finishP2pStartAttempt(sessionId) {
    if (this.sessionId === sessionId) {
      this.starting = false;
    }
  }

  /**
   * Stores and returns the in-flight start_livestream Promise on this camera.
   *
   * @param {Promise<*>} promise - In-flight start promise.
   * @returns {Promise<*>}
   */
  setStartPromise(promise) {
    this.startPromise = promise;
    return promise;
  }

  /**
   * Clears motion and viewer queues when the HomeBase station or WebSocket disconnects and returns true if active.
   *
   * @param {string} [clearReason='station_disconnected'] - Reason for clearing viewer queue.
   * @returns {boolean} True if the camera was active and needs to be stopped.
   */
  handleStationDisconnected(clearReason = 'station_disconnected') {
    this.motionUntil = 0;
    this.clearViewerQueue(clearReason);
    return Boolean(this.active);
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
        (this.stoppingP2p && (!this.active || (this.starting && !this.gotVideo)))
    ) {
      return Object.freeze({action: 'inactive', warnMsg: ''});
    }
    if (this.active && this.starting) {
      return Object.freeze({action: 'inactive', warnMsg: ''});
    }
    const liveSecs = this.getLiveDurationSecs(now);
    const lastVideoAgo = this.lastVideoAt ? ((now - this.lastVideoAt) / MS_PER_SECOND).toFixed(1) + 's' : 'none';
    this.p2pReady = false;

    if (this.isPiggybackedExternalSession() || this.didEufyEndEventCleanly(now, minCleanVideoMs)) {
      this.motionUntil = 0;
      this.viewUntil = 0;
      return Object.freeze({action: 'clean_end', warnMsg: ''});
    }
    if (this.active && !this.isInMotion(now) && !this.hasWakingViewer() && this.gotVideo) {
      return Object.freeze({action: 'expired', warnMsg: ''});
    }
    if (this.active && now < this.wantUntil()) {
      const remainingSecs = Math.round((this.wantUntil() - now) / MS_PER_SECOND);
      const warnMsg =
          'stream interrupted by eufy/camera (initiator=eufy/camera, reason="livestream stopped event while session active", live=' +
          liveSecs +
          's, gotVideo=' +
          this.gotVideo +
          ', lastVideoAgo=' +
          lastVideoAgo +
          ', remainingHold=' +
          remainingSecs +
          's) - re-requesting livestream';
      return Object.freeze({action: 'interrupted', warnMsg});
    }
    if (this.active) {
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
    if (!this.pendingBackfill) {
      return Object.freeze({
        hasPending: false,
        isInfo: false,
        logMsg: 'eufy reported activity cleared (event="' + eventName + '")',
      });
    }
    if (this.isBackfillRecordingCleared()) {
      return Object.freeze({
        hasPending: true,
        isInfo: Boolean(this.alwaysBackfill),
        logMsg:
            'eufy reported activity cleared (event="' +
            eventName +
            '"), queued clip backfill ready after HomeBase settle delay',
      });
    }
    return Object.freeze({
      hasPending: true,
      isInfo: false,
      logMsg:
          'eufy reported "' +
          eventName +
          '" cleared while other trigger events remain active for backfill',
    });
  }

  /**
   * Resets motionClearedAt and cancels any startup snapshot probe when a new motion trigger arrives.
   */
  prepareForMotionTrigger() {
    this.motionClearedAt = 0;
    this.cancelStartupProbe();
  }

  /**
   * Returns true if an active backfill download has timed out waiting for initial video.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} timeoutMs - Timeout threshold in milliseconds.
   * @param {number} [quietSince=this.getQuietSinceTimestamp()] - Timestamp of last video packet or start attempt.
   * @returns {boolean}
   */
  hasDownloadTimedOut(now, timeoutMs, quietSince = this.getQuietSinceTimestamp()) {
    return Boolean(!this.gotVideo && now - quietSince > timeoutMs);
  }

  /**
   * If this camera has reached its max_secs duration limit, clears motionUntil and returns the stop reason.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string} Formatted stop reason if limit reached, or empty string.
   */
  expireMaxDurationHold(now = Date.now()) {
    if (!this.hasReachedMaxDuration(now)) {
      return '';
    }
    this.motionUntil = 0;
    return 'reached max_secs limit (' + Math.round(this.timers.maxMs / MS_PER_MINUTE) + 'm)';
  }

  /**
   * If this camera has reached its view_max_secs duration limit, returns the formatted stop reason.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {string} Formatted stop reason if limit reached, or empty string.
   */
  getViewMaxDurationReason(now = Date.now()) {
    if (!this.hasReachedViewMaxDuration(now)) {
      return '';
    }
    return 'reached view_max_secs limit (' + Math.round(this.timers.viewMaxMs / MS_PER_MINUTE) + 'm)';
  }

  /**
   * Returns the latest timestamp between lastVideoAt and lastStartAt for health watchdog checks.
   *
   * @returns {number}
   */
  getQuietSinceTimestamp() {
    return Math.max(this.lastVideoAt, this.lastStartAt);
  }

  /**
   * Resets motion hold state prior to graceful bridge shutdown.
   */
  prepareForShutdown() {
    this.motionUntil = 0;
  }

  /**
   * Returns true if the given go2rtc viewer consumer ID is already tracked on this camera.
   *
   * @param {*} viewerId - Consumer ID from go2rtc.
   * @returns {boolean}
   */
  hasRegisteredViewer(viewerId) {
    return this.viewerIds.has(viewerId);
  }

  /**
   * Updates whether a tracked go2rtc viewer consumer ID is actively waking/holding this camera.
   *
   * @param {*} viewerId - Consumer ID from go2rtc.
   * @param {boolean} asked - Whether this viewer is allowed to wake/extend the camera.
   */
  setViewerWakingStatus(viewerId, asked) {
    this.viewerIds.set(viewerId, Boolean(asked));
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
   * Returns an immutable logger scope object `{ name, evState }` for Frigate event lifecycle logs.
   *
   * @returns {Readonly<{ name: string, evState: string }>}
   */
  getEventLogScope() {
    return Object.freeze({name: this.name, evState: this.evState});
  }

  /**
   * Stores the scheduled Frigate event dispatch timer on this camera.
   *
   * @param {*} timer - Node.js Timeout handle.
   */
  setFrigateEventTimer(timer) {
    this.evTimer = timer;
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
        this.evLabel !== 'test' &&
        !this.isReadyForEventSnapshot(now, requiredDelayMs, freshFrameMs, recentFallbackMs)
    );
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
    if (this.apiWakeTimer && typeof this.apiWakeTimer.unref === 'function') {
      this.apiWakeTimer.unref();
    }
  }

  /**
   * Resets RTSP wake timestamps and retry counters if an active RTSP wake has stalled for stallMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} stallMs - Stall threshold in milliseconds.
   * @returns {boolean} True if the RTSP wake was stalled and reset.
   */
  resetStalledRtspWakeIfNeeded(now, stallMs) {
    if (this.activeMode === STREAM_MODES.RTSP && !this.gotVideo && now - this.startedAt > stallMs) {
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
      mode: this.activeMode || (this.isRtspCapable() ? STREAM_MODES.RTSP : STREAM_MODES.P2P),
      hold_secs: Math.round(durationMs / MS_PER_SECOND),
      delay_ms: delayMs,
    };
  }

  /**
   * Returns true if an active backfill download has finished transferring, flushed its decoder,
   * played out all buffered frames, and completed its post-playback hold window.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [idleCompleteMs=DEFAULT_DOWNLOAD_IDLE_COMPLETE_MS] - Fallback idle duration after last frame if downloadFinished was missed.
   * @param {number} [postPlaybackHoldMs=DEFAULT_DOWNLOAD_POST_PLAYBACK_HOLD_MS] - Hold duration after the final frame is encoded.
   * @param {number} [minPlaybackMs=DEFAULT_DOWNLOAD_MIN_PLAYBACK_MS] - Minimum total playback session duration in milliseconds.
   * @returns {boolean}
   */
  isDownloadComplete(
      now,
      idleCompleteMs = DEFAULT_DOWNLOAD_IDLE_COMPLETE_MS,
      postPlaybackHoldMs = DEFAULT_DOWNLOAD_POST_PLAYBACK_HOLD_MS,
      minPlaybackMs = DEFAULT_DOWNLOAD_MIN_PLAYBACK_MS
  ) {
    const readyToComplete = Boolean(
        this.gotVideo &&
        this.downloadFrames.length === 0 &&
        (minPlaybackMs <= 0 || now - this.startedAt >= minPlaybackMs)
    );
    const hasBufferedStdout = Boolean(
        this.dec && this.dec.stdout && this.dec.stdout.readableLength > 0
    );
    const allPipesDrained =
        this.pendingVideoPackets.length === 0 && !this.decoderStdoutPaused && !hasBufferedStdout;
    const decoderFlushed =
        !this.dec ||
        now - Math.max(this.downloadFinishedAt || 0, this.lastVideoAt || 0) >=
            DOWNLOAD_EOF_FLUSH_SETTLE_MS;
    const effectivePostHoldMs =
        this.backfillClipQueue.length > 0 || Boolean(this.pendingBackfill) ? 0 : postPlaybackHoldMs;
    return readyToComplete
        ? (this.downloadFinished && allPipesDrained
            ? Boolean(decoderFlushed && now - this.lastVideoAt >= effectivePostHoldMs)
            : now - this.lastVideoAt > idleCompleteMs)
        : false;
  }

  /**
   * Marks an active backfill download transfer as finished and returns the total number of
   * buffered decoded frames and queued compressed packets remaining to play out.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {number} Number of buffered frames and queued video packets remaining.
   */
  markDownloadFinished(now) {
    this.downloadFinished = true;
    this.downloadFinishedAt = now;
    if (this.isBackfillPlayback() && this.firstFrameAt > 0) {
      this.transitionTo(SESSION_STATES.DRAINING_BACKFILL_TAIL, now, 'download transfer finished');
    }
    return this.downloadFrames.length + this.pendingVideoPackets.length;
  }

  /**
   * Formats a structured log line when HomeBase P2P clip transfer completes during backfill download.
   *
   * @param {number} bufferedCount - Total buffered decoded frames and pending video packets remaining.
   * @param {number} [fps=LIVE_FPS] - Playback frame rate in frames per second.
   * @returns {string}
   */
  formatBackfillTransferCompleteLog(bufferedCount, fps = LIVE_FPS) {
    const frameBasis = Math.max(this.downloadDecodedFrames, this.downloadVideoPackets);
    const estClipSecs = (frameBasis / Math.max(1, fps)).toFixed(1);
    return (
      'eufy clip transfer complete, playing remaining ' +
      bufferedCount +
      ' buffered frames at ' +
      fps +
      ' fps (clipStart=' +
      formatEpochHms(this.backfillClipStartMs) +
      ', packets=' +
      this.downloadVideoPackets +
      ', decodedFrames=' +
      this.downloadDecodedFrames +
      ', playedFrames=' +
      this.downloadPlayedFrames +
      ', bufferedFrames=' +
      this.downloadFrames.length +
      ', pendingPackets=' +
      this.pendingVideoPackets.length +
      ', estClipDuration=' +
      estClipSecs +
      's, session=' +
      this.sessionId +
      ')'
    );
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
        ? !(this.isBackfillPlayback() && this.downloadFinished && exitCode === 0)
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
        cur.motionClearedAt > cur.lastMotionAt ||
        (!cur.gotVideo && now - cur.startedAt >= stallPreemptMs);
    const samePriorityCanPreempt =
        pickScore === curScore &&
        this.lastMotionAt > cur.lastMotionAt &&
        Boolean(preemptEnabled || curFinishedOrStalled);
    return !this.isInMotion(now)
        ? !cur.isInMotion(now) && this.viewSince > cur.viewSince
        : !cur.isInMotion(now) ||
            pickScore > curScore ||
            samePriorityCanPreempt ||
            Boolean(curFinishedOrStalled);
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
   * Comparator that orders cameras by pending/active backfill priority (highest first).
   *
   * @param {Camera} a - First candidate camera.
   * @param {Camera} b - Second candidate camera.
   * @returns {number}
   */
  static compareBackfillPriority(a, b) {
    return b.getBackfillPriority() - a.getBackfillPriority();
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
   * @param {Uint8Array} chunk - Raw s16le PCM buffer.
   * @param {number} maxLiveBytes - Maximum buffered PCM bytes during live streaming.
   * @param {number} [maxDownloadBytes=maxLiveBytes] - Maximum buffered PCM bytes during clip downloads.
   */
  appendAudioChunk(chunk, maxLiveBytes, maxDownloadBytes = maxLiveBytes) {
    const maxBytes = this.activeMode === STREAM_MODES.DOWNLOAD ? maxDownloadBytes : maxLiveBytes;
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
   * Consumes the next chunkBytes of PCM audio for the encoder pipe in O(1) without Buffer.concat,
   * or returns silenceBuf when insufficient audio is buffered or before the first backfill frame is decoded.
   *
   * @param {number} chunkBytes - Number of bytes per audio tick.
   * @param {Uint8Array} silenceBuf - Pre-allocated silence buffer.
   * @returns {Uint8Array}
   */
  consumeAudioChunk(chunkBytes, silenceBuf) {
    if ((this.isBackfillPlayback() && !this.firstFrameAt) || this.pcmLen < chunkBytes) {
      return silenceBuf;
    }
    const first = this.pcm[0];
    if (first.length >= chunkBytes) {
      let out = first;
      if (first.length === chunkBytes) {
        this.pcm.shift();
      } else {
        out = first.subarray(0, chunkBytes);
        this.pcm[0] = first.subarray(chunkBytes);
      }
      this.pcmLen -= chunkBytes;
      return out;
    }

    if (this.audioOutBuf.length < chunkBytes) {
      this.audioOutBuf = Buffer.allocUnsafe(chunkBytes);
    }
    const out = this.audioOutBuf.subarray(0, chunkBytes);
    let copied = 0;
    while (copied < chunkBytes && this.pcm.length > 0) {
      const head = this.pcm[0];
      const need = chunkBytes - copied;
      if (head.length <= need) {
        out.set(head, copied);
        copied += head.length;
        this.pcm.shift();
      } else {
        out.set(head.subarray(0, need), copied);
        this.pcm[0] = head.subarray(need);
        copied += need;
      }
    }
    this.pcmLen -= copied;
    return out;
  }

  /**
   * Copies a newly decoded YUV420p live frame into the next alternating slot of liveFrameRing
   * so consecutive frames never allocate 1.38 MB on the heap and this.frame / this.lastFrame never alias.
   *
   * @param {Uint8Array} rawBuf - Raw decoded YUV420p frame buffer.
   * @returns {Buffer} Populated ring buffer slot.
   */
  acquireNextLiveFrameSlot(rawBuf) {
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
    const buf =
        this.downloadFramePool.length > 0
            ? this.downloadFramePool.pop()
            : Buffer.allocUnsafe(FRAME);
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
    if (!this.firstFrameAt) {
      this.firstFrameAt = now;
      if (this.isBackfillPlayback()) {
        this.backfillPlaybackStartedAt = now;
      }
    }
    this.markDecoderDecoding();
    if (this.active) {
      if (this.isBackfillPlayback()) {
        this.backfillContinuation = false;
        this.downloadDecodedFrames++;
        this.downloadPlayedFrames++;
        this.transitionTo(
            this.downloadFinished
                ? SESSION_STATES.DRAINING_BACKFILL_TAIL
                : SESSION_STATES.PLAYING_BACKFILL,
            now,
            this.downloadFinished ? 'download transfer finished' : 'first backfill frame decoded'
        );
      } else {
        this.transitionTo(SESSION_STATES.STREAMING_LIVE, now, 'first live frame decoded');
      }
    }
    const prevFrame = this.frame;
    this.frame = liveFrame;
    this.frameAt = now;
    this.frameNew = true;
    this.lastFrame =
        snapshotCopy === liveFrame && prevFrame && prevFrame !== liveFrame
            ? prevFrame
            : snapshotCopy;
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
    if (!this.frame) {
      return false;
    }
    this.downloadDecodedFrames++;
    if (this.downloadFrames.length < maxBufferFrames) {
      this.downloadFrames.push(frameCopy);
    }
    if (
        !this.decoderStdoutPaused &&
        this.downloadFrames.length >= DOWNLOAD_FRAME_HIGH_WATERMARK
    ) {
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
    if (!this.decoderStdoutPaused && !this.decoderInputEnded) {
      return this._transitionDecoderTo(DECODER_STATES.DECODING, 'first frame decoded');
    }
    return this.decoderState;
  }

  /**
   * Pauses the FFmpeg decoder stdout stream when backfill frame buffering reaches
   * DOWNLOAD_FRAME_HIGH_WATERMARK and transitions the decoder FSM to PAUSED_BACKPRESSURE.
   *
   * @returns {string} Resulting decoder FSM state.
   */
  pauseDecoderStdout() {
    this.decoderStdoutPaused = true;
    this._transitionDecoderTo(DECODER_STATES.PAUSED_BACKPRESSURE, 'high watermark reached');
    if (this.dec && this.dec.stdout && typeof this.dec.stdout.pause === 'function') {
      this.dec.stdout.pause();
    }
    return this.decoderState;
  }

  /**
   * Enqueues a compressed Annex-B video packet in RAM when decoder stdout is paused (or stdin
   * needs drain) or writes it directly to the active FFmpeg decoder stdin.
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
    if (
        this.decoderStdoutPaused ||
        this.pendingVideoPackets.length > 0 ||
        stdin.writableNeedDrain
    ) {
      this.pendingVideoPackets.push(packetBuf);
      if (!this.decoderStdoutPaused && !stdin.writableNeedDrain) {
        this.drainPendingDecoderInput(audioEnabled);
      }
      return true;
    }
    stdin.write(packetBuf);
    return true;
  }

  /**
   * Writes a compressed AAC audio packet directly to the active FFmpeg decoder audio pipe
   * (stdio[3]), or queues it in RAM if the decoder is still spawning or the audio pipe needs drain.
   * Does not pause on video stdout backpressure (decoderStdoutPaused) so audio decodes continuously
   * without gaps during backfill playback.
   *
   * @param {Uint8Array} packetBuf - Raw compressed AAC packet.
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio is enabled.
   * @returns {boolean} True if written or queued.
   */
  enqueueOrWriteAudioPacket(packetBuf, audioEnabled = AUDIO) {
    if (!audioEnabled) {
      return false;
    }
    if (!this.dec && this.canIngestP2pPacket()) {
      this.pendingAudioPackets.push(packetBuf);
      return true;
    }
    const audioStream = this.dec && this.dec.stdio && this.dec.stdio[3] ? this.dec.stdio[3] : null;
    if (!audioStream || !audioStream.writable) {
      return false;
    }
    if (this.pendingAudioPackets.length > 0 || audioStream.writableNeedDrain) {
      this.pendingAudioPackets.push(packetBuf);
      if (!audioStream.writableNeedDrain) {
        this.drainPendingDecoderInput(audioEnabled);
      }
      return true;
    }
    audioStream.write(packetBuf);
    return true;
  }

  /**
   * Drains queued compressed video/audio packets into the FFmpeg decoder pipes once backpressure
   * clears, closing the input pipes if markDecoderInputEnded was requested on download EOF.
   *
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio pipe draining is enabled.
   * @param {boolean} [fromPipeDrain=false] - Whether invoked from a decoder input pipe drain event.
   */
  drainPendingDecoderInput(audioEnabled = AUDIO, fromPipeDrain = false) {
    if (!this.dec) {
      return;
    }
    const stdin = this.dec.stdin;
    if (!this.decoderStdoutPaused || fromPipeDrain) {
      while (
          this.pendingVideoPackets.length > 0 &&
          stdin &&
          stdin.writable &&
          !stdin.writableNeedDrain
      ) {
        const nextPkt = this.pendingVideoPackets.shift();
        stdin.write(nextPkt);
      }
    }

    const audioStream = audioEnabled && this.dec.stdio && this.dec.stdio[3] ? this.dec.stdio[3] : null;
    while (
        this.pendingAudioPackets.length > 0 &&
        audioStream &&
        audioStream.writable &&
        !audioStream.writableNeedDrain
    ) {
      const nextAudio = this.pendingAudioPackets.shift();
      audioStream.write(nextAudio);
    }

    if (this.decoderInputEnded) {
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
          this._transitionDecoderTo(DECODER_STATES.FLUSHING_EOF, 'input pipe ended');
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
  }

  /**
   * Marks the decoder input stream as ended (on backfill download EOF) and closes the FFmpeg
   * input pipes immediately or as soon as any queued compressed packets finish draining.
   *
   * @param {boolean} [audioEnabled=AUDIO] - Whether audio pipe is enabled.
   */
  markDecoderInputEnded(audioEnabled = AUDIO) {
    this.decoderInputEnded = true;
    if (
        !this.decoderStdoutPaused &&
        this.pendingVideoPackets.length === 0 &&
        this.pendingAudioPackets.length === 0
    ) {
      this._transitionDecoderTo(DECODER_STATES.FLUSHING_EOF, 'input pipe ended');
    }
    this.drainPendingDecoderInput(audioEnabled);
  }

  /**
   * Resumes the FFmpeg decoder stdout stream if it was paused for backfill backpressure
   * and drains any compressed packets queued while paused.
   */
  resumeDecoderStdout() {
    if (!this.decoderStdoutPaused && this.decoderState !== DECODER_STATES.PAUSED_BACKPRESSURE) {
      return;
    }
    this.decoderStdoutPaused = false;
    const allInputDrained =
        this.decoderInputEnded &&
        this.pendingVideoPackets.length === 0 &&
        this.pendingAudioPackets.length === 0;
    this._transitionDecoderTo(
        allInputDrained ? DECODER_STATES.FLUSHING_EOF : DECODER_STATES.DECODING,
        allInputDrained ? 'input pipe ended' : 'low watermark resumed'
    );
    if (this.dec && this.dec.stdout && typeof this.dec.stdout.resume === 'function') {
      this.dec.stdout.resume();
    }
    this.drainPendingDecoderInput();
  }

  /**
   * Advances the buffered download frame queue by one frame when due, recycling the previous
   * frame buffer into downloadFramePool and resuming the paused FFmpeg decoder stdout stream
   * once the queue drains down to DOWNLOAD_FRAME_LOW_WATERMARK.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number|string} [frameIntervalMsOrHm=62] - Minimum interval between download frames (ms) or HH:MM string.
   * @param {string|number} [lastSeenHm=''] - Formatted HH:MM timestamp string.
   * @returns {Uint8Array|null} Newly committed download frame buffer or null if not advanced.
   */
  consumeNextDownloadFrame(now, frameIntervalMsOrHm = DEFAULT_LIVE_FRAME_PACE_MS, lastSeenHm = '') {
    const isDirectAdvance = typeof frameIntervalMsOrHm === 'string';
    const hm = isDirectAdvance ? frameIntervalMsOrHm : String(lastSeenHm || '');
    if (isDirectAdvance) {
      if (this.downloadFrames.length === 0) {
        return null;
      }
    } else if (!this.canAdvanceDownloadFrame(now, frameIntervalMsOrHm)) {
      return null;
    }
    const prevFrame = this.frame;
    const nextBuf = this.downloadFrames.shift();
    this.downloadPlayedFrames++;
    if (
        Buffer.isBuffer(prevFrame) &&
        prevFrame !== nextBuf &&
        this.downloadFramePool.length < DOWNLOAD_POOL_MAX_BUFFERS
    ) {
      this.downloadFramePool.push(prevFrame);
    }
    this.frame = nextBuf;
    this.frameAt = now;
    this.lastVideoAt = now;
    this.frameNew = true;
    this.lastFrame = nextBuf;
    if (hm) {
      this.telemetry.updateLastSeen(hm);
    }
    if (this.decoderStdoutPaused && this.downloadFrames.length <= DOWNLOAD_FRAME_LOW_WATERMARK) {
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
    this.encoderStoppedForOffline = false;
    this.encoderConsumerConnected = false;
    this.lastSent = null;
    this.lastWrite = now;
    this.burstUntil = now + KEYFRAME_BURST_MS;
  }

  /**
   * Terminates the persistent FFmpeg encoder process on bridge shutdown.
   */
  stopEncoderProcess() {
    this.clearOfflineSeedTimer();
    if (!this.enc) {
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
    if (!this.enc) {
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
    if (this.active && !this.isBackfillPlayback()) {
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
   * @param {number} [downloadPaceLeadMs=DEFAULT_DOWNLOAD_PACE_LEAD_MS] - Pacing lead margin (ms) during backfill playback.
   * @param {number} [liveHeartbeatWriteMs=DEFAULT_LIVE_HEARTBEAT_WRITE_MS] - Maximum interval between live frame writes in ms.
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
    const liveIntervalMs = this.isBackfillPlayback()
        ? Math.floor(MS_PER_SECOND / liveFps) - downloadPaceLeadMs
        : liveHeartbeatWriteMs;
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
   * @param {number} [frameIntervalMs=DEFAULT_LIVE_FRAME_PACE_MS] - Minimum interval between download frames in milliseconds.
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
   * Disables hardware acceleration on this camera after a hardware encoder failure so it falls back to software libx264.
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
    return Boolean(this.dec);
  }

  /**
   * Clears this.dec (and optionally decSpawnedAt) if it matches the exiting decoder process.
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
   * Returns true if an exiting P2P/backfill FFmpeg decoder still has a paused or unread stdout
   * stream that must finish draining into downloadFrames before this.dec is detached.
   *
   * @param {*} dec - Exiting FFmpeg decoder process.
   * @returns {boolean}
   */
  shouldDeferDecoderDetachOnExit(dec) {
    return Boolean(
        this.dec === dec &&
        this.isBackfillPlayback() &&
        dec &&
        dec.stdout &&
        !dec.stdout.readableEnded &&
        !dec.stdout.closed &&
        (this.decoderStdoutPaused || dec.stdout.readableLength > 0)
    );
  }

  /**
   * Returns true if a paused backfill decoder stdout stream is already at or below
   * DOWNLOAD_FRAME_LOW_WATERMARK when the decoder process exits and should be resumed immediately.
   *
   * @returns {boolean}
   */
  shouldResumePausedDecoderOnExit() {
    return Boolean(
        this.decoderStdoutPaused && this.downloadFrames.length <= DOWNLOAD_FRAME_LOW_WATERMARK
    );
  }

  /**
   * Returns the visual frame stage marker (FRAME_STAGE_MARKERS.SNAPSHOT for sleeping/snapshot frame,
   * FRAME_STAGE_MARKERS.FIRST_BACKFILL for First Backfill Frame 0, FRAME_STAGE_MARKERS.BACKFILL for
   * subsequent Backfill video frames, or FRAME_STAGE_MARKERS.LIVE for Live stream).
   *
   * @returns {'S'|'FB'|'B'|'L'}
   */
  getFrameMarker() {
    return !this.active
        ? FRAME_STAGE_MARKERS.SNAPSHOT
        : this.isBackfillPlayback()
            ? (this.downloadPlayedFrames > FIRST_BACKFILL_PLAYED_FRAME_COUNT || this.backfillContinuation
                ? FRAME_STAGE_MARKERS.BACKFILL
                : FRAME_STAGE_MARKERS.FIRST_BACKFILL)
            : FRAME_STAGE_MARKERS.LIVE;
  }

  /**
   * Clears any pending RTSP decoder retry timer on this camera.
   */
  clearRtspRetryTimer() {
    if (this.rtspRetryTimer) {
      clearTimeout(this.rtspRetryTimer);
      this.rtspRetryTimer = null;
    }
  }

  /**
   * Schedules an RTSP decoder retry timer after delayMs, replacing any existing retry timer.
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
   * Builds the rendering context needed by renderCameraCards() without exposing internal sub-models.
   *
   * @returns {Readonly<{ title: string, lowBat: boolean, canWakeOnView: boolean, asleepTitle: string, asleepLine2: string, cardConfig: { theme: string, position: string, sleepScreen: string }, lastFrame: Uint8Array|null, status: Record<string, *>, asleepBuf: Uint8Array, wakingBuf: Uint8Array, busyBuf: Uint8Array }>}
   */
  prepareCardRenderContext() {
    const title = this.getDisplayTitle();
    const lowBat = this.isLowBattery();
    const canWakeOnView = this.canWakeOnViewerInLowBattery();
    const asleepTitle = this.hasServiceDisruption()
        ? CARD_STATUS_TITLES.DISCONNECTED
        : lowBat
            ? CARD_STATUS_TITLES.ASLEEP_LOW_BATTERY
            : CARD_STATUS_TITLES.ASLEEP;
    const asleepLine2 = canWakeOnView
        ? 'feed, open this camera to wake it, or wait for motion'
        : 'economy mode active, waking on motion events only';
    const status = this.telemetry.toStatusSnapshot(this.name, title, this.card.config);
    status.cam = this;
    return Object.freeze({
      title,
      lowBat,
      canWakeOnView,
      asleepTitle,
      asleepLine2,
      cardConfig: this.card.config,
      lastFrame: this.lastFrame,
      status,
      asleepBuf: this.card.asleep,
      wakingBuf: this.card.waking,
      busyBuf: this.card.busy,
    });
  }

  /**
   * Stores the rendered card buffers on this camera's StatusCard and triggers a short keyframe burst.
   *
   * @param {{ asleep: Uint8Array, waking: Uint8Array, busy: Uint8Array, liveTelState: Record<string, *>, backfillTelState: Record<string, *> }} rendered - Rendered card buffers.
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
   * Returns true when this camera uses the diagnostic "debug" HUD theme and is not
   * currently suppressing its overlay for a clean Frigate event snapshot.
   *
   * @returns {boolean}
   */
  hasDynamicDebugCard() {
    return Boolean(this.card.theme === CARD_THEMES.DEBUG && !this.card.suppressLiveCard);
  }

  /**
   * Builds 4 fixed-width monospace diagnostic text lines for the "debug" HUD theme.
   * Every field is padded to a constant column width so text never shifts horizontally when values change.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {ReadonlyArray<string>}
   */
  buildDebugHudLines(now = Date.now()) {
    const curState = formatShortSessionState(this.sessionState);
    const prevState = formatShortSessionState(this.prevSessionState);
    const stateAgeSecs = Math.min(
        HUD_MAX_SECONDS_DISPLAY,
        Math.max(0, Math.round((now - (this.sessionStateChangedAt || now)) / MS_PER_SECOND))
    );
    const holdRemSecs = this.active
        ? Math.min(HUD_MAX_SECONDS_DISPLAY, Math.max(0, Math.round((this.wantUntil() - now) / MS_PER_SECOND)))
        : 0;
    const targetFps = this.active || this.isInKeyframeBurst(now) ? LIVE_FPS : IDLE_FPS;
    const rawFps =
        this.measuredFps > 0
            ? this.measuredFps
            : this.active || this.isInKeyframeBurst(now)
                ? LIVE_FPS
                : IDLE_FPS;
    const fpsStr =
        formatZeroPaddedInt(Math.round(rawFps), HUD_FPS_PAD_WIDTH) +
        '/' +
        formatZeroPaddedInt(targetFps, HUD_FPS_PAD_WIDTH);

    const decState = formatShortDecoderState(this.decoderState);
    const bfJob = this.pendingBackfill || this.activeBackfillJob;
    const bfState = formatShortBackfillState(bfJob);
    const wsSvc = this.telemetry.wsConnected ? HUD_SERVICE_OK_LABEL : HUD_SERVICE_DOWN_LABEL;
    const hbSvc =
        !this.isDeviceOffline() && this.telemetry.stationConnected
            ? HUD_SERVICE_OK_LABEL
            : HUD_SERVICE_DOWN_LABEL;
    const frgSvc = this.telemetry.frigateConnected ? HUD_SERVICE_OK_LABEL : HUD_SERVICE_DOWN_LABEL;
    const rtcSvc = this.telemetry.go2rtcConnected ? HUD_SERVICE_OK_LABEL : HUD_SERVICE_DOWN_LABEL;
    const svcStr = 'WS:' + wsSvc + ' HB:' + hbSvc + ' FRG:' + frgSvc + ' RTC:' + rtcSvc;
    const qShortStr =
        formatZeroPaddedInt(this.liveFrames.length, HUD_QUEUE_PAD_WIDTH) +
        '/' +
        formatZeroPaddedInt(this.downloadFrames.length, HUD_QUEUE_PAD_WIDTH);
    const dropRstStr =
        'DROP:0 RST:' + formatZeroPaddedInt(this.restarts || 0, HUD_SINGLE_DIGIT_WIDTH);

    const stAgeToken = '+' + formatZeroPaddedInt(stateAgeSecs, HUD_SECS_PAD_WIDTH) + 's';
    const stSpan12 =
        padFixedWidth(
            'ST:' + prevState + ' -> ' + curState,
            HUD_SPAN12_WIDTH - stAgeToken.length
        ) + padFixedWidth(stAgeToken, stAgeToken.length, true);

    const row1 = padFixedWidth(
        stSpan12 +
          ' | ' +
          padFixedWidth('DEC:' + padFixedWidth(decState, HUD_DEC_PAD_WIDTH), HUD_COL3_WIDTH) +
          ' | ' +
          padFixedWidth('BF:' + padFixedWidth(bfState, HUD_STATE_PAD_WIDTH), HUD_COL4_WIDTH) +
          ' | ' +
          padFixedWidth('FPS:' + fpsStr, HUD_COL5_WIDTH) +
          ' | ' +
          padFixedWidth(svcStr, HUD_COL6_WIDTH) +
          ' | ' +
          padFixedWidth(dropRstStr, HUD_COL7_WIDTH),
        DEBUG_HUD_ROW_CHARS
    );

    const lgtStr = this.telemetry.isLightOn() ? HUD_LIGHT_ON_LABEL : HUD_LIGHT_OFF_LABEL;
    const batNum = this.telemetry.battery;
    const batPctStr = batNum !== null ? formatZeroPaddedInt(batNum, HUD_SECS_PAD_WIDTH) + '%' : '---%';
    const batModeTag = this.telemetry.charging
        ? HUD_POWER_CHARGING_LABEL
        : this.isLowBattery()
            ? HUD_POWER_LOW_LABEL
            : HUD_POWER_BATTERY_LABEL;
    const wifiBars =
        this.telemetry.wifi !== null
            ? formatZeroPaddedInt(this.telemetry.wifi, HUD_SINGLE_DIGIT_WIDTH)
            : '-';
    const rssiVal =
        this.telemetry.rssi !== null
            ? '-' + formatZeroPaddedInt(Math.abs(this.telemetry.rssi), HUD_SECS_PAD_WIDTH) + 'dBm'
            : '----dBm';
    const idleRssiNum = formatZeroPaddedInt(this.idleRssiChangeCount || 0, HUD_SINGLE_DIGIT_WIDTH);
    const tempVal =
        this.telemetry.temp !== null
            ? (this.telemetry.temp < 0
                ? '-' + formatZeroPaddedInt(Math.abs(this.telemetry.temp), HUD_SINGLE_DIGIT_WIDTH)
                : formatZeroPaddedInt(this.telemetry.temp, HUD_TEMP_POS_DIGITS)) + 'C'
            : '--C';
    const pwrM =
        this.telemetry.hwPowerMode !== null && this.telemetry.hwPowerMode !== undefined
            ? String(this.telemetry.hwPowerMode).slice(0, HUD_SINGLE_DIGIT_WIDTH)
            : '-';
    const clipL =
        this.telemetry.hwClipLength !== null && this.telemetry.hwClipLength !== undefined
            ? formatZeroPaddedInt(this.telemetry.hwClipLength, HUD_SECS_PAD_WIDTH) + 's'
            : '---s';
    const eeVal =
        this.telemetry.hwEndEarly === null || this.telemetry.hwEndEarly === undefined
            ? '-'
            : this.telemetry.hwEndEarly
                ? HUD_FLAG_YES
                : HUD_FLAG_NO;
    const qVal =
        this.telemetry.hwQuality !== null && this.telemetry.hwQuality !== undefined
            ? formatZeroPaddedInt(this.telemetry.hwQuality, HUD_SINGLE_DIGIT_WIDTH)
            : '-';
    const rtspFlag =
        this.useRtsp && (this.rtspUrl || this.rtspSupported) ? HUD_FLAG_YES : HUD_FLAG_NO;
    const hwStr =
        'M' + pwrM + '/' + clipL + '/EE:' + eeVal + '/Q' + qVal + '/RTSP:' + rtspFlag;
    const seenStr = padFixedWidth(this.telemetry.lastSeen || HUD_EMPTY_SEEN_4, HUD_SEEN_PAD_WIDTH);

    const row2 = padFixedWidth(
        padFixedWidth('LIGHT:' + lgtStr, HUD_COL1_WIDTH) +
          ' | ' +
          padFixedWidth('BAT:' + batPctStr + ' ' + batModeTag, HUD_COL2_WIDTH) +
          ' | ' +
          padFixedWidth(
              'WIFI:' +
                wifiBars +
                '/' +
                WIFI_SIGNAL_LEVELS.FULL +
                ' ' +
                rssiVal +
                ' IDLE:' +
                idleRssiNum,
              HUD_SPAN34_WIDTH
          ) +
          ' | ' +
          padFixedWidth('TMP:' + padFixedWidth(tempVal, HUD_TEMP_PAD_WIDTH), HUD_COL5_WIDTH) +
          ' | ' +
          padFixedWidth('HW:' + hwStr, HUD_COL6_WIDTH) +
          ' | ' +
          padFixedWidth('SEEN:' + seenStr, HUD_COL7_WIDTH),
        DEBUG_HUD_ROW_CHARS
    );

    const sesMode = !this.active
        ? HUD_SESSION_NONE_LABEL
        : this.activeMode === STREAM_MODES.DOWNLOAD
            ? HUD_SESSION_BACKFILL_LABEL
            : String(this.activeMode || HUD_SESSION_P2P_FALLBACK).toUpperCase();
    const holdRemStr = this.active
        ? formatZeroPaddedInt(holdRemSecs, HUD_SECS_PAD_WIDTH) + 's'
        : HUD_EMPTY_DURATION_4;
    const idleAgeStr =
        !this.active && this.lastMotionAt > 0
            ? formatZeroPaddedInt(Math.round((now - this.lastMotionAt) / MS_PER_SECOND), HUD_SECS_PAD_WIDTH) + 's'
            : HUD_EMPTY_DURATION_4;
    const vidAgeStr =
        this.active && this.lastVideoAt > 0
            ? Math.min(HUD_MAX_VIDEO_AGE_SECS_DISPLAY, Math.max(0, (now - this.lastVideoAt) / MS_PER_SECOND)).toFixed(1) + 's'
            : HUD_EMPTY_DURATION_4;
    let wakingViewers = 0;
    for (const isWaking of this.viewerIds.values()) {
      if (isWaking) wakingViewers++;
    }
    const vwStr =
        formatZeroPaddedInt(wakingViewers, HUD_SINGLE_DIGIT_WIDTH) +
        '/' +
        formatZeroPaddedInt(this.viewers || 0, HUD_SINGLE_DIGIT_WIDTH);
    const hasTrig = this.hasActiveHardwareTriggers();
    const trigRefAt = hasTrig ? this.lastMotionAt : this.motionClearedAt || this.lastMotionAt;
    const trigAgeStr =
        trigRefAt > 0
            ? formatZeroPaddedInt(Math.round((now - trigRefAt) / MS_PER_SECOND), HUD_SECS_PAD_WIDTH) + 's'
            : HUD_EMPTY_DURATION_4;
    const trigStr = (hasTrig ? HUD_TRIGGER_ACTIVE_LABEL : HUD_TRIGGER_CLEAR_LABEL) + trigAgeStr;
    const stopStr = padFixedWidth(
        this.stoppingP2p ? HUD_SESSION_P2P_FALLBACK : HUD_FLAG_NO,
        HUD_STOP_PAD_WIDTH
    );

    const row3 = padFixedWidth(
        padFixedWidth(
            'SES:' +
              padFixedWidth(sesMode, HUD_SESSION_MODE_PAD_WIDTH) +
              ' R:' +
              formatZeroPaddedInt(this.restarts || 0, HUD_RESTARTS_PAD_WIDTH),
            HUD_COL1_WIDTH
        ) +
          ' | ' +
          padFixedWidth('HOLD:' + holdRemStr, HUD_COL2_WIDTH) +
          ' | ' +
          padFixedWidth('IDLE:' + idleAgeStr, HUD_COL3_WIDTH) +
          ' | ' +
          padFixedWidth('VID:' + vidAgeStr, HUD_COL4_WIDTH) +
          ' | ' +
          padFixedWidth('VW:' + vwStr, HUD_COL5_WIDTH) +
          ' | ' +
          padFixedWidth('TRIG:' + trigStr + '  Q:' + qShortStr, HUD_COL6_WIDTH) +
          ' | ' +
          padFixedWidth('STOP:' + stopStr, HUD_COL7_WIDTH),
        DEBUG_HUD_ROW_CHARS
    );

    const evStr = formatShortEvState(this.evState);
    const evRemStr =
        this.evUntil > now
            ? formatZeroPaddedInt(Math.round((this.evUntil - now) / MS_PER_SECOND), HUD_SECS_PAD_WIDTH) + 's'
            : HUD_EMPTY_DURATION_4;
    const evIdStr = padFixedWidth(
        this.lastCreatedFrigateEventId
            ? String(this.lastCreatedFrigateEventId).slice(-HUD_EVENT_ID_SLICE_LEN)
            : HUD_EMPTY_EVENT_ID_6,
        HUD_EVENT_ID_SLICE_LEN
    );
    const bfAtt = bfJob ? bfJob.attempts || 0 : 0;
    const bfqWaitStr =
        this.pendingBackfill && !this.backfillClip
            ? formatZeroPaddedInt(
                Math.max(0, Math.round((now - (this.pendingBackfill.at || now)) / MS_PER_SECOND)),
                HUD_SECS_PAD_WIDTH
              ) + 's'
            : HUD_EMPTY_DURATION_4;
    const bfqStr =
        bfqWaitStr +
        ' TRY:' +
        formatZeroPaddedInt(bfAtt, HUD_SINGLE_DIGIT_WIDTH) +
        '/' +
        formatZeroPaddedInt(BACKFILL_MAX_QUERY_ATTEMPTS, HUD_FPS_PAD_WIDTH) +
        ' Q:' +
        formatZeroPaddedInt(this.backfillClipQueue.length, HUD_SINGLE_DIGIT_WIDTH);
    const clipStr =
        formatZeroPaddedInt(this.downloadPlayedFrames || 0, HUD_FRAME_COUNT_PAD_WIDTH) +
        '/' +
        formatZeroPaddedInt(this.downloadDecodedFrames || 0, HUD_FRAME_COUNT_PAD_WIDTH) +
        'f';
    const contStr = this.backfillContinuation ? HUD_FLAG_YES : HUD_FLAG_NO;
    const initStr = padFixedWidth(
        String(this.wakeInitiator || 'none').replace('bridge-backfill', 'backfill'),
        HUD_INITIATOR_PAD_WIDTH
    );

    const row4 = padFixedWidth(
        padFixedWidth(
            'EV:' +
              padFixedWidth(evStr, HUD_EVENT_STATE_PAD_WIDTH) +
              ' ' +
              evRemStr +
              '/' +
              evIdStr,
            HUD_SPAN12_WIDTH
        ) +
          ' | ' +
          padFixedWidth('BFQ:' + bfqStr, HUD_SPAN34_WIDTH) +
          ' | ' +
          padFixedWidth('CONT:' + contStr, HUD_COL5_WIDTH) +
          ' | ' +
          padFixedWidth('CLIP:' + clipStr, HUD_COL6_WIDTH) +
          ' | ' +
          padFixedWidth('INIT:' + initStr, HUD_COL7_WIDTH),
        DEBUG_HUD_ROW_CHARS
    );

    return Object.freeze([row1, row2, row3, row4]);
  }

  /**
   * Prepares the alternating scratch buffer and visual state needed to composite a corner status card onto rawFrame.
   *
   * @param {Uint8Array} rawFrame - Source decoded YUV420p video frame.
   * @returns {Readonly<{ out: Uint8Array, theme: string, position: string, camTitle: string, statusTitle: string, st: Record<string, *> }>}
   */
  prepareLiveCardOverlay(rawFrame) {
    const out = this.card.prepareLiveOverlayBuffer(rawFrame);
    const isBackfill = this.isBackfillPlayback();
    const statusTitle = isBackfill ? CARD_STATUS_TITLES.BACKFILL : CARD_STATUS_TITLES.LIVE;
    const st = this.telemetry.evaluateVisualState(statusTitle);
    return Object.freeze({
      out,
      theme: this.card.theme,
      position: this.card.position,
      camTitle: this.getDisplayTitle(),
      statusTitle,
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
    this.lastVideoAt = now;
    if (!this.firstFrameAt) {
      this.firstFrameAt = now;
    }
    if (this.isActiveRtspSession()) {
      this.transitionTo(
          SESSION_STATES.STREAMING_LIVE,
          now,
          this.rtspRewaking ? 'rtsp re-wake frame received' : 'first rtsp frame received'
      );
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
    if (this.isBackfillPlayback()) {
      this.downloadVideoPackets++;
    } else {
      this.telemetry.markDeviceOnline();
    }
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
   * Attaches a spawned FFmpeg decoder process to this camera and transitions decoderState to HANDSHAKING.
   *
   * @param {*} dec - Spawned FFmpeg ChildProcess.
   * @param {number} [spawnedAt=0] - Spawn timestamp in milliseconds (for RTSP handshake tracking).
   */
  attachDecoder(dec, spawnedAt = 0) {
    this.dec = dec;
    this.decSpawnedAt = spawnedAt;
    this._transitionDecoderTo(DECODER_STATES.HANDSHAKING, 'decoder attached');
    this.drainPendingDecoderInput();
  }

  /**
   * Clears any pending RTSP retry timer, resets decoder/A/V session buffers, transitions
   * decoderState to DETACHED, and returns the detached FFmpeg decoder process (if any).
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
    this._resetDecoderPipeState();
    this._transitionDecoderTo(DECODER_STATES.DETACHED, 'decoder detached');
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoCodec = '';
    this.pcm = [];
    this.pcmLen = 0;
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
        !this.homebase_rtsp_url &&
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
    if (this.evState === FRIGATE_EVENT_STATES.COOLDOWN && now >= (this.evUntil || 0)) {
      this.evUntil = 0;
      this._transitionFrigateEventTo(FRIGATE_EVENT_STATES.IDLE, 'cooldown elapsed');
    }
    if (this.evUntil > 0 && now >= this.evUntil && !this.evPending && !this.evTimer) {
      this.evUntil = 0;
    }
    return this.evState;
  }

  /**
   * Transitions the Frigate event FSM from QUEUED to WAITING_SNAPSHOT when the dispatch timer fires.
   *
   * @returns {boolean} True if transitioned to WAITING_SNAPSHOT.
   */
  beginFrigateSnapshotWait() {
    this.evTimer = null;
    this._transitionFrigateEventTo(
        FRIGATE_EVENT_STATES.WAITING_SNAPSHOT,
        'dispatch timer fired'
    );
    return this.evState === FRIGATE_EVENT_STATES.WAITING_SNAPSHOT;
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
  shouldExtendFrigateEvent(
      now = Date.now(),
      liveFps = LIVE_FPS,
      marginMs = DEFAULT_EVENT_EXTEND_MARGIN_MS
  ) {
    if (!this.active || this.evPending || this.evTimer || (!this.eventActive && !this.isBackfillPlayback())) {
      return false;
    }
    const targetUntil = this.isBackfillPlayback()
        ? now + this.getEffectiveEventDurationSecs(liveFps, now) * MS_PER_SECOND
        : this.wantUntil();
    return targetUntil > Math.max(now, this.evUntil || 0) + marginMs;
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
    const normalizedLabel = label === 'motion detected' ? 'motion' : label;

    this.getFrigateEventState(now);
    if (
        this.evTimer ||
        this.evPending ||
        this.evState === FRIGATE_EVENT_STATES.QUEUED ||
        this.evState === FRIGATE_EVENT_STATES.WAITING_SNAPSHOT
    ) {
      let upgradedLabel = false;
      let attachedPerson = false;
      if (this.evLabel === 'motion' && normalizedLabel !== 'motion') {
        this.evLabel = normalizedLabel;
        upgradedLabel = true;
      }
      if (personName && !this.evPerson) {
        this.evPerson = personName;
        attachedPerson = true;
      }
      return Object.freeze({status: 'upgraded', upgradedLabel, attachedPerson});
    }
    if (now < (this.evUntil || 0)) {
      const upgradedLabelInCooldown =
          Boolean(this.evLabel === 'motion' && normalizedLabel !== 'motion');
      const attachedPersonInCooldown = Boolean(personName && !this.evPerson);
      if (
          !upgradedLabelInCooldown &&
          !attachedPersonInCooldown &&
          !this.shouldExtendFrigateEvent(now)
      ) {
        this._transitionFrigateEventTo(FRIGATE_EVENT_STATES.COOLDOWN, 'event in cooldown');
        return Object.freeze({status: 'cooldown', upgradedLabel: false, attachedPerson: false});
      }
      if (upgradedLabelInCooldown) {
        this.evLabel = normalizedLabel;
      }
      if (attachedPersonInCooldown) {
        this.evPerson = personName;
      }
      this.evPending = true;
      this._transitionFrigateEventTo(FRIGATE_EVENT_STATES.QUEUED, 'event extended or upgraded');
      return Object.freeze({
        status: 'queued',
        upgradedLabel: upgradedLabelInCooldown,
        attachedPerson: attachedPersonInCooldown,
      });
    }
    this.evLabel = normalizedLabel;
    this.evPerson = personName || '';
    this.evPending = true;
    this._transitionFrigateEventTo(FRIGATE_EVENT_STATES.QUEUED, 'event queued');
    return Object.freeze({status: 'queued', upgradedLabel: false, attachedPerson: false});
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
      return (
        Math.max(
            this.timers.eventSecs,
            Math.ceil(
                (this.downloadFrames.length + this.pendingVideoPackets.length + 1) /
                  Math.max(1, liveFps)
            )
        ) + DOWNLOAD_EVENT_DURATION_MARGIN_SECS
      );
    }
    const remainingHoldSecs = this.active
        ? Math.ceil(Math.max(0, this.wantUntil() - now) / MS_PER_SECOND)
        : 0;
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
    const finalLabel = this.evLabel;
    const finalPerson = this.evPerson;
    const subLabel = finalPerson || null;
    const durationSecs = this.getEffectiveEventDurationSecs(liveFps, now);
    this.evPending = false;
    this.evDispatchedAt = now;
    this.evUntil = Math.max(this.evUntil || 0, now + durationSecs * MS_PER_SECOND);
    this._transitionFrigateEventTo(FRIGATE_EVENT_STATES.COOLDOWN, 'event filed');
    return Object.freeze({finalLabel, finalPerson, subLabel, durationSecs});
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
    /** @type {Record<string, *>} */
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
   * Extends an active camera hold timer by half of its base hold duration up to maxMs.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [minExtendMs=DEFAULT_MIN_EXTEND_MS] - Minimum hold extension in milliseconds.
   * @param {boolean} [capAtFullHold=true] - Whether to cap the new hold at now + baseHoldMs.
   * @returns {Readonly<{ extended: boolean, extendMs: number, holdSecs: number }>}
   */
  extendActiveHold(now, minExtendMs = DEFAULT_MIN_EXTEND_MS, capAtFullHold = true) {
    const prevUntil = this.wantUntil();
    const baseHoldMs = this.getEventHoldMs();
    const stepMs = Math.max(minExtendMs, Math.round(baseHoldMs / 2));
    const maxAllowedUntil = this.startedAt + this.timers.maxMs;
    const uncappedNext = Math.min(maxAllowedUntil, Math.max(prevUntil, now) + stepMs);
    const nextUntil = capAtFullHold ? Math.min(now + baseHoldMs, uncappedNext) : uncappedNext;
    const extendMotionHold =
        this.isInMotion(now) ||
        this.hasActiveHardwareTriggers() ||
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
      this.clearPendingBackfill();
    }
    return Object.freeze({
      extended,
      extendMs,
      holdSecs: Math.round((this.wantUntil() - now) / MS_PER_SECOND),
    });
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
  computeTriggerHoldUntil(
      now,
      ms,
      minExtendMs = DEFAULT_MIN_EXTEND_MS,
      isMidStream = false,
      isCompanionBurst = false
  ) {
    if (!isMidStream) {
      return now + ms;
    }
    const halfMs = Math.max(minExtendMs, Math.round(ms / 2));
    const maxMs = this.timers.maxMs;
    const maxAllowedUntil = this.active && this.startedAt ? this.startedAt + maxMs : now + maxMs;
    const extendedFromCurrent = isCompanionBurst
        ? this.wantUntil()
        : Math.max(this.wantUntil(), now) + halfMs;
    return Math.min(maxAllowedUntil, Math.max(now + ms, extendedFromCurrent));
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
   * @param {number} [midStreamGraceMs=DEFAULT_MID_STREAM_GRACE_MS] - Grace window after session start before half-hold extension applies.
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
    const isCompanionBurst = prevMotionAt > 0 && now - prevMotionAt < COMPANION_EVENT_BURST_MS;
    const videoStartRef = this.firstFrameAt || this.firstVideoAt;
    const hasSustainedLiveVideo =
        this.isActiveLiveSession() &&
        this.gotVideo &&
        videoStartRef > 0 &&
        now - videoStartRef >= minExtendMs;
    const isMidStream = hasSustainedLiveVideo && now - this.startedAt > midStreamGraceMs;
    const targetUntil = this.computeTriggerHoldUntil(
        now,
        ms,
        minExtendMs,
        isMidStream,
        isCompanionBurst
    );
    this.eventActive = true;
    this.motionUntil = Math.max(this.motionUntil, targetUntil);
    this.lastMotionAt = now;
    if (hasSustainedLiveVideo) {
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
   * @param {string} [initiator='frigate-viewer'] - Trigger initiator tag.
   * @param {Camera[]} [allCams=[]] - All configured Camera instances.
   * @param {number} [midStreamGraceMs=DEFAULT_MID_STREAM_GRACE_MS] - Grace window after session start before half-hold extension applies.
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
      this.reason = reason;
      this.wakeInitiator = initiator;
    }
    if (!this.isRtspCapable() && now >= this.viewUntil) {
      const stationKey = this.getStationKey();
      for (const other of allCams) {
        if (
            other !== this &&
            other.belongsToStationP2pSlot(stationKey) &&
            other.hasPendingViewerWake()
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
    return isEligibleOnSameStation
        ? !newestViewerCam.isRtspCapable() && !this.isRtspCapable()
        : false;
  }

  /**
   * Returns true if Eufy hardware trigger events (motion/person/ring) are still reported as active
   * and have not cleared since the latest motion trigger timestamp.
   *
   * @returns {boolean}
   */
  hasActiveHardwareTriggers() {
    return this.activeTriggerEvents.size > 0 ? this.motionClearedAt <= this.lastMotionAt : false;
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
        this.gotVideo &&
        this.firstVideoAt > 0 &&
        now - this.firstVideoAt >= minVideoMs &&
        now - this.lastMotionAt >= this.getEventHoldMs() &&
        this.motionClearedAt > this.lastMotionAt &&
        now - this.motionClearedAt >= settleMs &&
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
    const hwActive = this.hasActiveHardwareTriggers() && !this.hasReachedMaxDuration(now);
    const frigateActive =
        this.hasRecentFrigateObjectActivity(now) && !this.hasReachedMaxDuration(now);
    const activeMotionNeedsRewake =
        this.isInMotion(now) && !this.didRtspMotionStreamFinishCleanly(now);
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
  beginRtspRewake(now, minHoldMs = DEFAULT_MIN_RTSP_REWAKE_HOLD_MS) {
    this.transitionTo(SESSION_STATES.WAKING_RTSP, now, 'rtsp stream dropped, re-waking');
    this.rtspRewaking = true;
    this.rtspRewakeStartedAt = now;
    this.restarts = 0;
    this.lastStartAt = now;
    if (this.hasActiveHardwareTriggers() && !this.hasReachedMaxDuration(now)) {
      this.extendActiveHold(now);
    }
    if (this.viewUntil > now && this.viewUntil - now < minHoldMs) {
      this.viewUntil = now + minHoldMs;
    }
    if (this.motionUntil > now && this.motionUntil - now < minHoldMs) {
      this.motionUntil = now + minHoldMs;
    }
    return Math.round((this.wantUntil() - now) / MS_PER_SECOND);
  }

  /**
   * Evaluates RTSP session health, non-destructive wake retries, handshake protection, and timeouts.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} [quietSince=this.lastVideoAt || this.lastStartAt || this.startedAt] - Timestamp of last video packet or start attempt.
   * @param {number} [handshakeMinMs=DEFAULT_RTSP_HANDSHAKE_MIN_MS] - Minimum decoder age indicating active RTSP handshake.
   * @param {number} [decStallMs=DEFAULT_RTSP_DEC_STALL_MS] - Decoder age after which a silent handshake is considered stalled.
   * @param {number} [retryMs=DEFAULT_RTSP_RETRY_MS] - Interval between start_rtsp_livestream wake retries.
   * @param {number} [maxRetries=DEFAULT_RTSP_MAX_RETRIES] - Maximum RTSP wake retries before timeout.
   * @param {number} [timeoutMs=DEFAULT_RTSP_TIMEOUT_MS] - Hard RTSP wake timeout in milliseconds.
   * @param {number} [midStallMs=DEFAULT_RTSP_MID_STALL_MS] - Mid-session frame silence threshold in milliseconds.
   * @returns {{ action: 'none'|'retry'|'timeout'|'dropped', killStalledDec: boolean, logMsg: string }}
   */
  evaluateRtspHealth(
      now,
      quietSince = this.getQuietSinceTimestamp() || this.startedAt,
      handshakeMinMs = DEFAULT_RTSP_HANDSHAKE_MIN_MS,
      decStallMs = DEFAULT_RTSP_DEC_STALL_MS,
      retryMs = DEFAULT_RTSP_RETRY_MS,
      maxRetries = DEFAULT_RTSP_MAX_RETRIES,
      timeoutMs = DEFAULT_RTSP_TIMEOUT_MS,
      midStallMs = DEFAULT_RTSP_MID_STALL_MS
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
   * @param {number} [quietSince=this.lastVideoAt || this.lastStartAt || this.startedAt] - Timestamp of last video packet or start attempt.
   * @param {number} [initialRetryMs=DEFAULT_P2P_INITIAL_RETRY_MS] - Quiet duration before retry 1.
   * @param {number} [subsequentRetryMs=DEFAULT_P2P_SUBSEQUENT_RETRY_MS] - Quiet duration before retries 2..maxRetries.
   * @param {number} [maxRetries=DEFAULT_P2P_MAX_RETRIES] - Maximum watchdog retries before forced error sleep.
   * @returns {{ action: 'none'|'retry'|'timeout'|'expired', logMsg: string }}
   */
  evaluateP2pHealth(
      now,
      quietSince = this.getQuietSinceTimestamp() || this.startedAt,
      initialRetryMs = DEFAULT_P2P_INITIAL_RETRY_MS,
      subsequentRetryMs = DEFAULT_P2P_SUBSEQUENT_RETRY_MS,
      maxRetries = DEFAULT_P2P_MAX_RETRIES
  ) {
    const retryAfterMs = this.restarts === 0 ? initialRetryMs : subsequentRetryMs;
    if (now - quietSince <= retryAfterMs || this.starting) {
      return {action: 'none', logMsg: ''};
    }
    if (this.isPiggybackedExternalSession()) {
      this.motionUntil = 0;
      this.viewUntil = 0;
      return {action: 'expired', logMsg: 'external Eufy app stream stopped sending video'};
    }
    if (!this.isInMotion(now) && !this.hasWakingViewer() && this.gotVideo) {
      return {action: 'expired', logMsg: 'viewer disconnected and camera stopped sending video'};
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
    const evKey = String(eventName || '').toLowerCase();
    const backfillPerson = (this.pendingBackfill || this.activeBackfillJob)?.personName || '';
    return isStart
        ? Boolean(
            this.activeTriggerEvents.has(evKey) &&
            this.lastTriggerStartEvent === evKey &&
            now - this.lastTriggerStartAt < COMPANION_EVENT_BURST_MS &&
            (!personName || backfillPerson === personName)
          )
        : Boolean(
            !this.activeTriggerEvents.has(evKey) &&
            this.lastTriggerClearEvent === evKey &&
            now - this.lastTriggerClearAt < COMPANION_EVENT_BURST_MS
          );
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
    if (eventName) {
      const lowerEvent = String(eventName).toLowerCase();
      this.activeTriggerEvents.delete(lowerEvent);
      this.lastTriggerClearEvent = lowerEvent;
      this.lastTriggerClearAt = now;
    } else {
      this.activeTriggerEvents.clear();
    }
    let allCleared = this.activeTriggerEvents.size === 0;
    if (this.activeBackfillJob && this.activeBackfillJob !== this.pendingBackfill) {
      allCleared = this.activeBackfillJob.markRecordingCleared(now, eventName);
    }
    if (this.pendingBackfill) {
      allCleared = this.pendingBackfill.markRecordingCleared(now, eventName);
    }
    if (allCleared && (this.pendingBackfill || this.activeBackfillJob)) {
      this.lastBackfillQueryAt = 0;
    }
    if (!allCleared) {
      return null;
    }
    this.motionClearedAt = now;
    if (this.timers.letEufyDecideEnd && this.active && this.isInMotion(now) && this.gotVideo) {
      const minEnd = Math.max(now + settleMs, (this.firstVideoAt || now) + minVideoMs);
      if (this.motionUntil > minEnd) {
        this.motionUntil = minEnd;
        return Math.round((minEnd - now) / 1000);
      }
    }
    return null;
  }

  /**
   * Returns true if the camera has a pending BackfillJob whose hardware recording has cleared.
   *
   * @returns {boolean}
   */
  isBackfillRecordingCleared() {
    return Boolean(this.pendingBackfill && !this.pendingBackfill.recordingActive);
  }

  /**
   * Queues or upgrades a pending BackfillJob when a Eufy trigger event fires and backfill_downloads is enabled.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {string} eventName - Raw Eufy event string.
   * @param {string} personName - Optional recognized person name.
   * @param {string} reason - Formatted trigger description.
   * @param {number} evPriority - Event priority boost score.
   * @param {boolean} [recordingActive=true] - Whether the camera hardware clip is still actively recording.
   */
  queueEventBackfill(now, eventName, personName, reason, evPriority, recordingActive = true) {
    if (recordingActive && eventName) {
      const lowerEvent = String(eventName).toLowerCase();
      this.activeTriggerEvents.add(lowerEvent);
      this.lastTriggerStartEvent = lowerEvent;
      this.lastTriggerStartAt = now;
    }
    const nextPriority = this.priority + evPriority;
    this.lastSessionEventInfo = Object.freeze({
      name: this.name,
      at: now,
      lastActivityAt: now,
      event: eventName || 'motion detected',
      personName: personName || '',
      reason: reason || eventName || 'motion detected',
      priority: nextPriority,
      attempts: 0,
      recordingActive,
      activeEvents: [...this.activeTriggerEvents],
    });
    if (
        !this.backfillDownloads ||
        (!this.alwaysBackfill && (this.runtimeExtended || (this.isActiveLiveSession() && this.gotVideo)))
    ) {
      return;
    }
    const syncQueuedClipMeta = (sourceJob) => {
      if (this.backfillClip) {
        this.backfillClip = Object.freeze({
          ...this.backfillClip,
          event: sourceJob.event,
          personName: sourceJob.personName,
          reason: sourceJob.reason,
        });
      }
      this.backfillClipQueue = this.backfillClipQueue.map((queuedClip) =>
        Object.freeze({
          ...queuedClip,
          event: sourceJob.event,
          personName: sourceJob.personName,
          reason: sourceJob.reason,
        })
      );
    };

    if (this.activeBackfillJob) {
      this.activeBackfillJob.upgradeEvent(
          eventName,
          personName,
          reason,
          nextPriority,
          now,
          recordingActive
      );
      syncQueuedClipMeta(this.activeBackfillJob);
    }

    if (this.pendingBackfill && !this.pendingBackfill.isExpired(now)) {
      this.pendingBackfill.upgradeEvent(
          eventName,
          personName,
          reason,
          nextPriority,
          now,
          recordingActive
      );
      syncQueuedClipMeta(this.pendingBackfill);
      return;
    }

    this.pendingBackfill = new BackfillJob({
      name: this.name,
      at: now,
      lastActivityAt: now,
      event: eventName,
      personName,
      reason,
      priority: nextPriority,
      attempts: 0,
      recordingActive,
      activeEvents: [...this.activeTriggerEvents],
    });
  }

  /**
   * Returns true if this camera has an urgent SIGUSR1 test BackfillJob queued.
   *
   * @returns {boolean}
   */
  hasUrgentTestBackfill() {
    return Boolean(this.pendingBackfill && this.pendingBackfill.isUrgentTest());
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
  DOWNLOAD_COMPLETED_INITIATOR,
  DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
  DOWNLOAD_FRAME_HIGH_WATERMARK,
  DOWNLOAD_FRAME_LOW_WATERMARK,
  SESSION_STATES,
  ALLOWED_SESSION_TRANSITIONS,
  canTransitionSession,
  FRIGATE_EVENT_STATES,
  DECODER_STATES,
  WAKE_KINDS,
  WakeRequest,
  Camera,
};
