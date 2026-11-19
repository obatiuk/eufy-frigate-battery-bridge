// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Public facade for the Eufy WebSocket RPC client, HomeBase station P2P recovery,
 * and camera telemetry/property synchronization modules under src/services/eufy/.
 */
'use strict';

const {
  configureEufyClientHooks,
  isWsReady,
  isInitialTelemetryLoaded,
  isWsSettledForEvents,
  canRunStartupProbeNow,
  formatRpcError,
  call,
  ensureCameraEncodersStarted,
  connectWs,
  stopWsClient,
} = require('./eufy/ws-transport');
const {
  isTrackedPropertyEvent,
  resolvePropertyTriggerEvent,
  setCameraProperty,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  startTelemetryPoller,
  stopTelemetryPoller,
  extractRecognizedPerson,
} = require('./eufy/telemetry-sync');
const {
  isStationRecycling,
  updateStationHealth,
  noteStationActivity,
  recoverUnresponsiveStation,
  ensureStationReadyForP2pRetry,
  prepareRtspWakeAttempt,
  ensureRtspUrlAfterWakeStart,
  refreshMissingRtspUrlOnStart,
  recordStationWakeTimeout,
  scheduleStationReconnect,
} = require('./eufy/station-recovery');

module.exports = {
  configureEufyClientHooks,
  isWsReady,
  isInitialTelemetryLoaded,
  isWsSettledForEvents,
  canRunStartupProbeNow,
  isTrackedPropertyEvent,
  resolvePropertyTriggerEvent,
  formatRpcError,
  call,
  setCameraProperty,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  ensureStationReadyForP2pRetry,
  prepareRtspWakeAttempt,
  ensureRtspUrlAfterWakeStart,
  refreshMissingRtspUrlOnStart,
  isStationRecycling,
  recoverUnresponsiveStation,
  recordStationWakeTimeout,
  noteStationActivity,
  scheduleStationReconnect,
  updateStationHealth,
  ensureCameraEncodersStarted,
  connectWs,
  stopWsClient,
  startTelemetryPoller,
  stopTelemetryPoller,
  extractRecognizedPerson,
};
