// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Enhanced and refactored in collaboration with Gemini (Google).
 *
 * eufy-frigate-battery-bridge: application composition root, dependency wiring,
 * signal/test hooks, and graceful shutdown lifecycle.
 */
'use strict';

const {
  cfg,
  ACTIVE_LOG_LEVEL_NAME,
  CACHE_DIR,
  ACTIVE_HWACCEL,
  HWACCEL_DEVICE,
  GLOBAL_USE_RTSP,
  BACKFILL_DOWNLOADS,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
  LET_EUFY_DECIDE_END,
  GLOBAL_DIM_BACKGROUND,
  HOLD_MS,
  EARLY_SLEEP_MS,
  LINGER_MS,
  MAX_MS,
} = require('./config');
const {log} = require('./logger');
const {Camera, usesP2pSlot, inMotion, isRtspCapable, clearViewerQueue} = require('./domain/camera');
const {loadCachedFrame} = require('./overlay/snapshot-cache');
const {renderCameraCards} = require('./overlay/card-renderer');
const {configureEncoderHooks, startEncoder, startMediaTickers} = require('./media/encoder');
const {setDecoderStopHandler} = require('./media/decoder');
const {
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  frigateEvent,
  pollViewers,
} = require('./services/frigate-service');
const {
  configureEufyClientHooks,
  connectWs,
  startTelemetryPoller,
  fetchAllCameraTelemetry,
} = require('./services/eufy-client');
const {
  initOrchestrator,
  trigger,
  stop,
  onEvent,
  processBackfillQueue,
  startHousekeepingLoop,
} = require('./services/stream-orchestrator');

let shuttingDown = false;
const isShuttingDown = () => shuttingDown;

// 1. Instantiate Camera domain entities and pre-render status cards.
const cams = cfg.cameras.map((c) => new Camera(c, loadCachedFrame(c), renderCameraCards));
const bySerial = new Map(cams.map((c) => [c.serial, c]));

// 2. Wire cross-module lifecycle hooks.
initOrchestrator(cams, bySerial, isShuttingDown);

setDecoderStopHandler(stop);

configureEncoderHooks({
  isShuttingDown,
  onEncoderDrop: () => handleEncoderReconnectMaskSync(cams, isShuttingDown),
});

configureEufyClientHooks({
  cams,
  bySerial,
  isShuttingDown,
  onEvent,
  onWsClosedStop: (cam) => stop(cam, 'bridge lost eufy-security-ws connection', false, 'error/ws-disconnect'),
  onInitialTelemetryLoaded: () => void syncFrigateMotionMasks(cams, false, shuttingDown),
});

// 3. Test hooks (SIGUSR2 synthetic Frigate event, SIGUSR1 HomeBase clip backfill download).
process.on('SIGUSR2', () => {
  log.info(cams[0], 'received SIGUSR2 signal, triggering synthetic test event');
  frigateEvent(cams[0], 'test detected');
});

process.on('SIGUSR1', () => {
  const targetCam = cams.find((c) => !c.useRtsp || !c.rtspUrl) || cams[cams.length - 1];
  if (!targetCam) return;
  log.info(targetCam, 'received SIGUSR1 signal, queueing test backfill download of latest HomeBase clip');
  for (const c of cams) {
    if (usesP2pSlot(c) && !inMotion(c)) {
      stop(c, 'yielding P2P slot for SIGUSR1 backfill test', true, 'bridge-backfill');
    } else if (!c.active && !isRtspCapable(c)) {
      clearViewerQueue(c, 'SIGUSR1 backfill test');
    }
  }
  targetCam.downloadedPaths.clear();
  targetCam.backfillClip = null;
  targetCam.lastBackfillQueryAt = 0;
  targetCam.pendingBackfill = {
    at: Date.now() - 10000,
    ignoreTimeWindow: true,
    event: 'motion detected',
    personName: '',
    reason: 'SIGUSR1 backfill test',
    priority: 9999,
    attempts: 0,
  };
  setTimeout(() => void processBackfillQueue(Date.now()), 300);
});

// 4. Graceful shutdown and process error handlers.
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('bridge', 'received shutdown signal, stopping active streams and encoders');
  for (const c of cams) {
    c.motionUntil = 0;
    stop(c, 'bridge container shutting down', false, 'system-shutdown');
    try {
      if (c.enc) c.enc.kill('SIGTERM');
    } catch (err) {
      // Ignore errors when stopping encoder on shutdown.
    }
  }
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  log.error('bridge', 'uncaught exception (service continuing): ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (reason) => {
  log.error('bridge', 'unhandled promise rejection (service continuing): ' + reason);
});

// 5. Start background tickers, encoders, viewer polling, and Eufy WebSocket client.
const camListStr = cams.map((c) => c.name).join(', ');
const hwDesc = ACTIVE_HWACCEL ? ACTIVE_HWACCEL + ' (' + HWACCEL_DEVICE + ')' : 'software (libx264)';
const startMsg =
    'eufy-frigate-battery-bridge starting: cameras=[' +
    camListStr +
    '], logLevel=' +
    ACTIVE_LOG_LEVEL_NAME +
    ', cache=' +
    CACHE_DIR +
    ', encoder=' +
    hwDesc +
    ', useRtsp=' +
    GLOBAL_USE_RTSP +
    ', backfill=' +
    BACKFILL_DOWNLOADS +
    ', autoMask=' +
    GLOBAL_AUTO_FRIGATE_MASK +
    ', cardOnLive=' +
    GLOBAL_CARD_SHOW_ON_LIVE +
    ', letEufyDecideEnd=' +
    LET_EUFY_DECIDE_END +
    ', dimBg=' +
    GLOBAL_DIM_BACKGROUND +
    ', hold=' +
    HOLD_MS / 1000 +
    's, earlySleep=' +
    EARLY_SLEEP_MS / 1000 +
    's, viewerLinger=' +
    LINGER_MS / 1000 +
    's, max=' +
    MAX_MS / 1000 +
    's';
log.info('bridge', startMsg);

startMediaTickers(cams);
setInterval(() => {
  void pollViewers(cams, {
    isShuttingDown,
    fetchAllCameraTelemetry,
    stopCam: stop,
    triggerCam: trigger,
  });
}, 750);
startHousekeepingLoop();
startTelemetryPoller();

for (const c of cams) {
  startEncoder(c);
}

connectWs();

setTimeout(() => void syncFrigateMotionMasks(cams, false, shuttingDown), 2500);
