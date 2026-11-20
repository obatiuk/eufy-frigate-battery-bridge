// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Read-only JSON payload builders for GET/HEAD /api/config and GET/HEAD /api/status.
 */
'use strict';

const {
  cfg,
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  ACTIVE_LOG_LEVEL_NAME,
  W,
  H,
  LIVE_FPS,
  IDLE_FPS,
  AUDIO,
  ACTIVE_HWACCEL,
  BACKFILL_DELAY_MS,
  PREEMPT_EVENT_STREAMS,
  INSTANT_EVENT_SNAPSHOT,
  SNAP_DELAY_MS,
  COOLDOWN_MS,
  TELEMETRY_POLL_MS,
  LOW_BAT_THRESHOLD,
  CRITICAL_BAT_THRESHOLD,
  CAMERA_MODES,
  POWER_MODES,
  FORWARD_FACE_NAMES,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
} = require('../config');
const {CAMERA_RUNTIME_STATUSES} = require('../domain/camera');
const {stations} = require('../domain/station');
const {isWsReady, isInitialTelemetryLoaded} = require('./eufy-client');
const {isFrigateConnected, isGo2rtcConnected} = require('./frigate-client');

/** @typedef {import("../domain/camera").Camera} Camera */

const MS_PER_SECOND = 1000;
const startedAtMs = Date.now();

/**
 * Builds the sanitized JSON payload returned by GET/HEAD /api/config, setting top-level
 * Eufy-WS and live-card options to null when no configured camera uses them.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @returns {Readonly<Record<string, *>>}
 */
function buildConfigPayload(cams) {
  const hasEufyCameras = cams.length === 0 || cams.some((c) => !c.isRtspDirect());
  const hasCustomEufyCamera =
    cams.length === 0 || cams.some((c) => !c.isRtspDirect() && c.getConfiguredMode() === CAMERA_MODES.CUSTOM);
  const effectiveTopPowerMode =
    cfg.power_mode === POWER_MODES.CUSTOM && !hasCustomEufyCamera ? POWER_MODES.KEEP : cfg.power_mode;
  const hasLiveCardTarget = cams.length === 0 || cams.some((c) => c.supportsLiveCardOverlay());
  return Object.freeze({
    version: BRIDGE_VERSION,
    commit: BRIDGE_COMMIT,
    log_level: ACTIVE_LOG_LEVEL_NAME,
    width: W,
    height: H,
    live_fps: LIVE_FPS,
    idle_fps: IDLE_FPS,
    audio: AUDIO,
    hwaccel: ACTIVE_HWACCEL || null,
    use_rtsp: hasEufyCameras ? Boolean(cfg.use_rtsp) : null,
    backfill_enabled: hasEufyCameras ? Boolean(cfg.backfill_enabled) : null,
    backfill_delay_secs: hasEufyCameras ? Math.round(BACKFILL_DELAY_MS / MS_PER_SECOND) : null,
    view_has_priority: hasEufyCameras ? PREEMPT_EVENT_STREAMS : null,
    instant_event_snapshot: hasEufyCameras ? INSTANT_EVENT_SNAPSHOT : null,
    snapshot_capture_delay_secs: hasEufyCameras ? Math.round(SNAP_DELAY_MS / MS_PER_SECOND) : null,
    view_cooldown_secs: hasEufyCameras ? Math.round(COOLDOWN_MS / MS_PER_SECOND) : null,
    telemetry_poll_secs: hasEufyCameras ? Math.round(TELEMETRY_POLL_MS / MS_PER_SECOND) : null,
    low_battery_threshold: hasEufyCameras ? LOW_BAT_THRESHOLD : null,
    critical_battery_threshold: hasEufyCameras ? CRITICAL_BAT_THRESHOLD : null,
    power_mode: hasEufyCameras ? effectiveTopPowerMode : null,
    streaming_quality: hasEufyCameras ? cfg.streaming_quality : null,
    track_stuck_spotlight: hasEufyCameras ? Boolean(cfg.track_stuck_spotlight) : null,
    forward_face_names: hasEufyCameras ? FORWARD_FACE_NAMES : null,
    auto_frigate_mask: GLOBAL_AUTO_FRIGATE_MASK,
    card_show_on_live: hasLiveCardTarget ? GLOBAL_CARD_SHOW_ON_LIVE : null,
    ha_webhook_configured: Boolean(cfg.ha_webhook_url),
    cameras: Object.freeze(cams.map((c) => c.toConfigSummary())),
  });
}

/**
 * Builds per-station P2P connectivity and single-slot arbitration summaries for GET /api/status.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {boolean} wsConnected - Whether eufy-security-ws is currently connected.
 * @returns {ReadonlyArray<Readonly<Record<string, *>>>}
 */
function buildStationsSummary(cams, wsConnected) {
  return stations.buildSummaries(cams, wsConnected);
}

/**
 * Aggregates high-level camera status, disruption, battery, backfill, and viewer counts in one pass.
 *
 * @param {ReadonlyArray<Record<string, *>>} cameraSummaries - Per-camera toStatusSummary() objects.
 * @returns {Readonly<Record<string, number>>}
 */
function buildCamerasAggregateSummary(cameraSummaries) {
  let streaming = 0;
  let waking = 0;
  let waiting = 0;
  let sleeping = 0;
  let disrupted = 0;
  let offline = 0;
  let lowBattery = 0;
  let pendingBackfills = 0;
  let connectedViewers = 0;

  for (const cam of cameraSummaries) {
    if (cam.status === CAMERA_RUNTIME_STATUSES.LIVE || cam.status === CAMERA_RUNTIME_STATUSES.BACKFILL) {
      streaming++;
    } else if (cam.status === CAMERA_RUNTIME_STATUSES.WAKING) {
      waking++;
    } else if (cam.status === CAMERA_RUNTIME_STATUSES.WAITING) {
      waiting++;
    } else if (cam.status === CAMERA_RUNTIME_STATUSES.ASLEEP || cam.status === CAMERA_RUNTIME_STATUSES.LOW_BATTERY) {
      sleeping++;
    }
    if (cam.disrupted) {
      disrupted++;
    }
    if (cam.offline) {
      offline++;
    }
    if (!cam.offline && cam.telemetry && cam.telemetry.low_battery) {
      lowBattery++;
    }
    if (cam.backfill && (cam.backfill.pending || cam.backfill.playing)) {
      pendingBackfills++;
    }
    connectedViewers += cam.viewers ? cam.viewers.connected : 0;
  }

  return Object.freeze({
    total_cameras: cameraSummaries.length,
    streaming_cameras: streaming,
    waking_cameras: waking,
    waiting_cameras: waiting,
    sleeping_cameras: sleeping,
    disrupted_cameras: disrupted,
    offline_cameras: offline,
    low_battery_cameras: lowBattery,
    pending_backfills: pendingBackfills,
    connected_viewers: connectedViewers,
  });
}

/**
 * Builds the full runtime status payload returned by GET/HEAD /api/status, exposing upstream
 * service health, HomeBase station P2P slots, aggregate counts, and every configured camera's
 * live session, encoder, viewer, event, backfill, trigger, and sensor telemetry state.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {{ shuttingDown?: boolean, startMs?: number, now?: number }} [opts={}] - Status timing/shutdown options.
 * @returns {Readonly<Record<string, *>>}
 */
function buildStatusPayload(cams, opts = {}) {
  const shuttingDown = Boolean(opts.shuttingDown);
  const startMs = opts.startMs !== undefined ? opts.startMs : startedAtMs;
  const now = opts.now !== undefined ? opts.now : Date.now();
  const hasEufyCameras = cams.length === 0 || cams.some((c) => !c.isRtspDirect());
  const wsConnected = isWsReady();
  const frigateOk = cams.length > 0 ? cams.every((c) => c.isFrigateConnected()) : isFrigateConnected();
  const go2rtcOk = cams.length > 0 ? cams.every((c) => c.isGo2rtcConnected()) : isGo2rtcConnected();
  const cameraSummaries = Object.freeze(cams.map((c) => c.toStatusSummary(now)));

  return Object.freeze({
    ok: !shuttingDown,
    shutting_down: shuttingDown,
    version: BRIDGE_VERSION,
    commit: BRIDGE_COMMIT,
    uptime_secs: Math.max(0, Math.round((now - startMs) / MS_PER_SECOND)),
    services: Object.freeze({
      ws_connected: hasEufyCameras ? Boolean(wsConnected) : null,
      initial_telemetry_loaded: hasEufyCameras ? Boolean(isInitialTelemetryLoaded()) : null,
      frigate_connected: Boolean(frigateOk),
      go2rtc_connected: Boolean(go2rtcOk),
      ha_webhook_configured: Boolean(cfg.ha_webhook_url),
    }),
    stations: hasEufyCameras ? buildStationsSummary(cams, wsConnected) : Object.freeze([]),
    summary: buildCamerasAggregateSummary(cameraSummaries),
    cameras: cameraSummaries,
  });
}

module.exports = {buildConfigPayload, buildStatusPayload};
