// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Fixed-width diagnostic text rows for the "hud" status card theme, formatted from a plain DebugHudSnapshot so the
 * layout never reaches into the Camera entity.
 */
'use strict';

const {
  LIVE_FPS,
  IDLE_FPS,
  STREAM_MODES,
  POWER_WORKING_MODES,
  OPTIMAL_BATTERY_MAX_CLIP_SECS,
  SURVEILLANCE_HOLD_SECS,
  MAX_STREAMING_QUALITY,
} = require('../../config');
const {WIFI_SIGNAL_LEVELS} = require('../telemetry');
const {BACKFILL_STATES, BACKFILL_MAX_QUERY_ATTEMPTS} = require('../backfill-job');
const {SESSION_STATES, FRIGATE_EVENT_STATES, DECODER_STATES} = require('./states');

/**
 * @typedef {{
 *   sessionState: string, prevSessionState: string, sessionStateChangedAt: number, decoderState: string,
 *   holdUntilMs: number|null, live: boolean, measuredFps: number,
 *   backfillState: string, backfillAttempts: number, backfillWaitSince: number|null, backfillClipQueueLength: number,
 *   wsOk: boolean, stationOk: boolean, frigateOk: boolean, go2rtcOk: boolean,
 *   liveQueueLength: number, downloadQueueLength: number, droppedFrames: number, restarts: number,
 *   lightOn: boolean, battery: number|null, charging: boolean, lowBattery: boolean,
 *   wifi: number|null, rssi: number|null, idleRssiChangeCount: number, temp: number|null,
 *   hwPowerMode: *, hwClipLength: *, hwEndEarly: *, hwQuality: *, rtspEnabled: boolean, lastSeen: string|null,
 *   active: boolean, activeMode: string|null, lastMotionAt: number, lastVideoAt: number,
 *   wakingViewers: number, viewers: number, triggersActive: boolean, motionClearedAt: number, stoppingP2p: boolean,
 *   eventState: string, eventUntil: number, lastCreatedEventId: *,
 *   downloadPlayedFrames: number, downloadDecodedFrames: number, backfillContinuation: boolean, wakeInitiator: *
 * }} DebugHudSnapshot
 */

const DEBUG_HUD_ROW_CHARS = 110;
const MS_PER_SECOND = 1000;
const DECIMAL_BASE = 10;

const HUD_MAX_SECONDS_DISPLAY = 999;
const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;
const SECS_PER_DAY = 86400;
const SECS_PER_WEEK = 604800;
const SECS_PER_YEAR = 31536000;
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
const HUD_UNKNOWN_CHAR = '-';
const HUD_UNKNOWN_CLIP_SECS = '---s';
const HUD_QUALITY_ULTRA_LABEL = 'U';

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

/**
 * Formats a non-negative duration in seconds as a fixed 4-character '<3 digits><unit>' token,
 * showing seconds up to 999s ('000s'..'999s') and scaling to minutes ('m'), hours ('h'),
 * days ('d'), weeks ('w'), and years ('y') beyond 999s.
 *
 * @param {number} rawSecs - Duration in seconds.
 * @returns {string}
 */
function formatHudDuration(rawSecs) {
  const secs = Math.max(0, Math.round(Number(rawSecs) || 0));
  if (secs <= HUD_MAX_SECONDS_DISPLAY) {
    return formatZeroPaddedInt(secs, HUD_SECS_PAD_WIDTH) + 's';
  }
  if (secs < SECS_PER_HOUR) {
    return formatZeroPaddedInt(Math.floor(secs / SECS_PER_MINUTE), HUD_SECS_PAD_WIDTH) + 'm';
  }
  if (secs < SECS_PER_DAY) {
    return formatZeroPaddedInt(Math.floor(secs / SECS_PER_HOUR), HUD_SECS_PAD_WIDTH) + 'h';
  }
  if (secs < SECS_PER_WEEK) {
    return formatZeroPaddedInt(Math.floor(secs / SECS_PER_DAY), HUD_SECS_PAD_WIDTH) + 'd';
  }
  if (secs < SECS_PER_YEAR) {
    return formatZeroPaddedInt(Math.floor(secs / SECS_PER_WEEK), HUD_SECS_PAD_WIDTH) + 'w';
  }
  return formatZeroPaddedInt(Math.floor(secs / SECS_PER_YEAR), HUD_SECS_PAD_WIDTH) + 'y';
}

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
 * @param {string} state - BackfillJob state value, or an empty string when no job exists.
 * @returns {string}
 */
function formatShortBackfillState(state) {
  if (!state) {
    return SHORT_SESSION_STATE_LABELS[SESSION_STATES.IDLE];
  }
  return SHORT_BACKFILL_STATE_LABELS[state] || String(state).toUpperCase().slice(0, HUD_STATE_PAD_WIDTH);
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
 * Formats a service connectivity flag as the 2-character HUD label.
 *
 * @param {boolean} ok - Whether the service is connected.
 * @returns {string}
 */
function formatServiceStatus(ok) {
  return ok ? HUD_SERVICE_OK_LABEL : HUD_SERVICE_DOWN_LABEL;
}

/**
 * Formats the battery percentage as a fixed 4-character token ('---%' when unknown).
 *
 * @param {number|null} battery - Battery percentage.
 * @returns {string}
 */
function formatBatteryPercent(battery) {
  return battery !== null ? formatZeroPaddedInt(battery, HUD_SECS_PAD_WIDTH) + '%' : '---%';
}

/**
 * Returns the 3-character power tag (charging, low battery, or on battery).
 *
 * @param {{ charging: boolean, lowBattery: boolean }} snap - HUD snapshot.
 * @returns {string}
 */
function formatPowerModeTag(snap) {
  if (snap.charging) {
    return HUD_POWER_CHARGING_LABEL;
  }
  return snap.lowBattery ? HUD_POWER_LOW_LABEL : HUD_POWER_BATTERY_LABEL;
}

/**
 * Formats the Wi-Fi bar count as a single digit ('-' when unknown).
 *
 * @param {number|null} wifi - Wi-Fi signal bars.
 * @returns {string}
 */
function formatWifiBars(wifi) {
  return wifi !== null ? formatZeroPaddedInt(wifi, HUD_SINGLE_DIGIT_WIDTH) : '-';
}

/**
 * Formats the Wi-Fi RSSI as '-NNNdBm' ('----dBm' when unknown).
 *
 * @param {number|null} rssi - Wi-Fi RSSI in dBm.
 * @returns {string}
 */
function formatRssi(rssi) {
  return rssi !== null ? '-' + formatZeroPaddedInt(Math.abs(rssi), HUD_SECS_PAD_WIDTH) + 'dBm' : '----dBm';
}

/**
 * Formats the temperature in Celsius ('--C' when unknown).
 *
 * @param {number|null} temp - Temperature in degrees Celsius.
 * @returns {string}
 */
function formatTemperature(temp) {
  if (temp === null) {
    return '--C';
  }
  const digits =
    temp < 0
      ? '-' + formatZeroPaddedInt(Math.abs(temp), HUD_SINGLE_DIGIT_WIDTH)
      : formatZeroPaddedInt(temp, HUD_TEMP_POS_DIGITS);
  return digits + 'C';
}

/**
 * Returns true when a snapshot hardware value is neither null nor undefined.
 *
 * @param {*} value - Candidate hardware reading.
 * @returns {boolean}
 */
function isKnownHwValue(value) {
  return value !== null ? value !== undefined : false;
}

/**
 * Formats the single-character quality slot (`0`..`9`, `U` for Ultra `10+`, or `-` when unknown).
 *
 * @param {*} hwQuality - Reported Eufy `videoStreamingQuality` value.
 * @returns {string}
 */
function formatHudQuality(hwQuality) {
  if (!isKnownHwValue(hwQuality)) {
    return HUD_UNKNOWN_CHAR;
  }
  return Math.round(Number(hwQuality)) >= MAX_STREAMING_QUALITY
    ? HUD_QUALITY_ULTRA_LABEL
    : formatZeroPaddedInt(Number(hwQuality), HUD_SINGLE_DIGIT_WIDTH);
}

/**
 * Resolves effective clip-length and early-end tokens for the HUD `HW:` column so preset modes
 * (`M0` -> `020s/EE:Y`, `M1` -> `060s/EE:Y`, `M3+` -> `---s/EE:-`) never display leftover `M2` values.
 *
 * @param {Readonly<DebugHudSnapshot>} snap - HUD snapshot.
 * @returns {{ clipLength: string, endEarly: string }}
 */
function resolveHudClipAndEndEarly(snap) {
  if (snap.hwPowerMode === POWER_WORKING_MODES.BATTERY_SAVER) {
    return {clipLength: formatHudDuration(OPTIMAL_BATTERY_MAX_CLIP_SECS), endEarly: HUD_FLAG_YES};
  }
  if (snap.hwPowerMode === POWER_WORKING_MODES.SURVEILLANCE) {
    return {clipLength: formatHudDuration(SURVEILLANCE_HOLD_SECS), endEarly: HUD_FLAG_YES};
  }
  if (isKnownHwValue(snap.hwPowerMode) && Number(snap.hwPowerMode) > POWER_WORKING_MODES.CUSTOMIZE_RECORDING) {
    return {clipLength: HUD_UNKNOWN_CLIP_SECS, endEarly: HUD_UNKNOWN_CHAR};
  }
  const clipLength = isKnownHwValue(snap.hwClipLength) ? formatHudDuration(snap.hwClipLength) : HUD_UNKNOWN_CLIP_SECS;
  const endEarly = !isKnownHwValue(snap.hwEndEarly) ? HUD_UNKNOWN_CHAR : snap.hwEndEarly ? HUD_FLAG_YES : HUD_FLAG_NO;
  return {clipLength, endEarly};
}

/**
 * Formats the hardware recording settings summary (power mode, clip length, end-early, quality, RTSP flag).
 *
 * @param {Readonly<DebugHudSnapshot>} snap - HUD snapshot.
 * @returns {string}
 */
function formatHardwareSummary(snap) {
  const powerMode = isKnownHwValue(snap.hwPowerMode)
    ? String(snap.hwPowerMode).slice(0, HUD_SINGLE_DIGIT_WIDTH)
    : HUD_UNKNOWN_CHAR;
  const {clipLength, endEarly} = resolveHudClipAndEndEarly(snap);
  const quality = formatHudQuality(snap.hwQuality);
  const rtspFlag = snap.rtspEnabled ? HUD_FLAG_YES : HUD_FLAG_NO;
  return 'M' + powerMode + '/' + clipLength + '/EE:' + endEarly + '/Q' + quality + '/RTSP:' + rtspFlag;
}

/**
 * Formats the session mode column ('NONE' when idle, 'BF' for backfill downloads, otherwise the stream mode).
 *
 * @param {{ active: boolean, activeMode: string|null }} snap - HUD snapshot.
 * @returns {string}
 */
function formatSessionMode(snap) {
  if (!snap.active) {
    return HUD_SESSION_NONE_LABEL;
  }
  if (snap.activeMode === STREAM_MODES.DOWNLOAD) {
    return HUD_SESSION_BACKFILL_LABEL;
  }
  return String(snap.activeMode || HUD_SESSION_P2P_FALLBACK).toUpperCase();
}

/**
 * Builds 4 fixed-width monospace diagnostic text lines for the "hud" diagnostic theme.
 * Every field is padded to a constant column width so text never shifts horizontally when values change.
 *
 * @param {Readonly<DebugHudSnapshot>} snap - Camera state captured by Camera.getDebugHudSnapshot().
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {ReadonlyArray<string>}
 */
function buildDebugHudLines(snap, now) {
  const curState = formatShortSessionState(snap.sessionState);
  const prevState = formatShortSessionState(snap.prevSessionState);
  const stateAgeSecs = Math.max(0, Math.round((now - (snap.sessionStateChangedAt || now)) / MS_PER_SECOND));
  const hasFiniteHold = snap.holdUntilMs !== null;
  const holdRemSecs = hasFiniteHold ? Math.max(0, Math.round((snap.holdUntilMs - now) / MS_PER_SECOND)) : 0;
  const targetFps = snap.live ? LIVE_FPS : IDLE_FPS;
  const rawFps = snap.measuredFps > 0 ? snap.measuredFps : targetFps;
  const fpsStr =
    formatZeroPaddedInt(Math.round(rawFps), HUD_FPS_PAD_WIDTH) +
    '/' +
    formatZeroPaddedInt(targetFps, HUD_FPS_PAD_WIDTH);

  const decState = formatShortDecoderState(snap.decoderState);
  const bfState = formatShortBackfillState(snap.backfillState);
  const svcStr =
    'WS:' +
    formatServiceStatus(snap.wsOk) +
    ' HB:' +
    formatServiceStatus(snap.stationOk) +
    ' FRG:' +
    formatServiceStatus(snap.frigateOk) +
    ' RTC:' +
    formatServiceStatus(snap.go2rtcOk);
  const qShortStr =
    formatZeroPaddedInt(snap.liveQueueLength, HUD_QUEUE_PAD_WIDTH) +
    '/' +
    formatZeroPaddedInt(snap.downloadQueueLength, HUD_QUEUE_PAD_WIDTH);
  const dropRstStr =
    'DROP:' +
    formatZeroPaddedInt(snap.droppedFrames, HUD_SINGLE_DIGIT_WIDTH) +
    ' RST:' +
    formatZeroPaddedInt(snap.restarts, HUD_SINGLE_DIGIT_WIDTH);

  const stAgeToken = '+' + formatHudDuration(stateAgeSecs);
  const stSpan12 =
    padFixedWidth('ST:' + prevState + ' -> ' + curState, HUD_SPAN12_WIDTH - stAgeToken.length) +
    padFixedWidth(stAgeToken, stAgeToken.length, true);

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

  const row2 = padFixedWidth(
    padFixedWidth('LIGHT:' + (snap.lightOn ? HUD_LIGHT_ON_LABEL : HUD_LIGHT_OFF_LABEL), HUD_COL1_WIDTH) +
      ' | ' +
      padFixedWidth('BAT:' + formatBatteryPercent(snap.battery) + ' ' + formatPowerModeTag(snap), HUD_COL2_WIDTH) +
      ' | ' +
      padFixedWidth(
        'WIFI:' +
          formatWifiBars(snap.wifi) +
          '/' +
          WIFI_SIGNAL_LEVELS.FULL +
          ' ' +
          formatRssi(snap.rssi) +
          ' IDLE:' +
          formatZeroPaddedInt(snap.idleRssiChangeCount, HUD_SINGLE_DIGIT_WIDTH),
        HUD_SPAN34_WIDTH
      ) +
      ' | ' +
      padFixedWidth('TMP:' + padFixedWidth(formatTemperature(snap.temp), HUD_TEMP_PAD_WIDTH), HUD_COL5_WIDTH) +
      ' | ' +
      padFixedWidth('HW:' + formatHardwareSummary(snap), HUD_COL6_WIDTH) +
      ' | ' +
      padFixedWidth('SEEN:' + padFixedWidth(snap.lastSeen || HUD_EMPTY_SEEN_4, HUD_SEEN_PAD_WIDTH), HUD_COL7_WIDTH),
    DEBUG_HUD_ROW_CHARS
  );

  const holdRemStr = hasFiniteHold ? formatHudDuration(holdRemSecs) : HUD_EMPTY_DURATION_4;
  const idleAgeStr =
    !snap.active && snap.lastMotionAt > 0
      ? formatHudDuration(Math.round((now - snap.lastMotionAt) / MS_PER_SECOND))
      : HUD_EMPTY_DURATION_4;
  const vidAgeStr =
    snap.active && snap.lastVideoAt > 0
      ? Math.min(HUD_MAX_VIDEO_AGE_SECS_DISPLAY, Math.max(0, (now - snap.lastVideoAt) / MS_PER_SECOND)).toFixed(1) + 's'
      : HUD_EMPTY_DURATION_4;
  const vwStr =
    formatZeroPaddedInt(snap.wakingViewers, HUD_SINGLE_DIGIT_WIDTH) +
    '/' +
    formatZeroPaddedInt(snap.viewers, HUD_SINGLE_DIGIT_WIDTH);
  const trigRefAt = snap.triggersActive ? snap.lastMotionAt : snap.motionClearedAt || snap.lastMotionAt;
  const trigAgeStr =
    trigRefAt > 0 ? formatHudDuration(Math.round((now - trigRefAt) / MS_PER_SECOND)) : HUD_EMPTY_DURATION_4;
  const trigStr = (snap.triggersActive ? HUD_TRIGGER_ACTIVE_LABEL : HUD_TRIGGER_CLEAR_LABEL) + trigAgeStr;
  const stopStr = padFixedWidth(snap.stoppingP2p ? HUD_SESSION_P2P_FALLBACK : HUD_FLAG_NO, HUD_STOP_PAD_WIDTH);

  const row3 = padFixedWidth(
    padFixedWidth(
      'SES:' +
        padFixedWidth(formatSessionMode(snap), HUD_SESSION_MODE_PAD_WIDTH) +
        ' R:' +
        formatZeroPaddedInt(snap.restarts, HUD_RESTARTS_PAD_WIDTH),
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

  const evRemStr =
    snap.eventUntil > now && Number.isFinite(snap.eventUntil)
      ? formatHudDuration(Math.round((snap.eventUntil - now) / MS_PER_SECOND))
      : HUD_EMPTY_DURATION_4;
  const evIdStr = padFixedWidth(
    snap.lastCreatedEventId ? String(snap.lastCreatedEventId).slice(-HUD_EVENT_ID_SLICE_LEN) : HUD_EMPTY_EVENT_ID_6,
    HUD_EVENT_ID_SLICE_LEN
  );
  const bfqWaitStr =
    snap.backfillWaitSince !== null
      ? formatHudDuration(Math.max(0, Math.round((now - (snap.backfillWaitSince || now)) / MS_PER_SECOND)))
      : HUD_EMPTY_DURATION_4;
  const bfqStr =
    bfqWaitStr +
    ' TRY:' +
    formatZeroPaddedInt(snap.backfillAttempts, HUD_SINGLE_DIGIT_WIDTH) +
    '/' +
    formatZeroPaddedInt(BACKFILL_MAX_QUERY_ATTEMPTS, HUD_FPS_PAD_WIDTH) +
    ' Q:' +
    formatZeroPaddedInt(snap.backfillClipQueueLength, HUD_SINGLE_DIGIT_WIDTH);
  const clipStr =
    formatZeroPaddedInt(snap.downloadPlayedFrames, HUD_FRAME_COUNT_PAD_WIDTH) +
    '/' +
    formatZeroPaddedInt(snap.downloadDecodedFrames, HUD_FRAME_COUNT_PAD_WIDTH) +
    'f';
  const initStr = padFixedWidth(
    String(snap.wakeInitiator || 'none').replace('bridge-backfill', 'backfill'),
    HUD_INITIATOR_PAD_WIDTH
  );

  const row4 = padFixedWidth(
    padFixedWidth(
      'EV:' +
        padFixedWidth(formatShortEvState(snap.eventState), HUD_EVENT_STATE_PAD_WIDTH) +
        ' ' +
        evRemStr +
        '/' +
        evIdStr,
      HUD_SPAN12_WIDTH
    ) +
      ' | ' +
      padFixedWidth('BFQ:' + bfqStr, HUD_SPAN34_WIDTH) +
      ' | ' +
      padFixedWidth('CONT:' + (snap.backfillContinuation ? HUD_FLAG_YES : HUD_FLAG_NO), HUD_COL5_WIDTH) +
      ' | ' +
      padFixedWidth('CLIP:' + clipStr, HUD_COL6_WIDTH) +
      ' | ' +
      padFixedWidth('INIT:' + initStr, HUD_COL7_WIDTH),
    DEBUG_HUD_ROW_CHARS
  );

  return Object.freeze([row1, row2, row3, row4]);
}

module.exports = {buildDebugHudLines};
