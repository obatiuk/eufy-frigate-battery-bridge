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

const config = require('./config');
const {log} = require('./logger');
const {Camera} = require('./domain/camera');
const {loadCachedFrame} = require('./overlay/snapshot-cache');
const {renderCameraCards} = require('./overlay/card-renderer');
const {configureEncoderHooks, startEncoder, startMediaTickers} = require('./media/encoder');
const {setDecoderStopHandler} = require('./media/decoder');
const {
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  frigateEvent,
  pollViewers,
} = require('./services/frigate-client');
const {
  configureEufyClientHooks,
  connectWs,
  startTelemetryPoller,
  fetchAllCameraTelemetry,
} = require('./services/eufy-client');
const {
  initOrchestrator,
  wakeCameraExternal,
  trigger,
  stop,
  onEvent,
  processBackfillQueue,
  startHousekeepingLoop,
} = require('./services/stream-orchestrator');
const {startHttpServer, stopHttpServer} = require('./services/http-server');

const SIGUSR1_BACKFILL_DELAY_MS = 300;
const SHUTDOWN_EXIT_DELAY_MS = 1500;
const VIEWER_POLL_INTERVAL_MS = 750;
const INITIAL_MASK_SYNC_DELAY_MS = 2500;

let shuttingDown = false;
const isShuttingDown = () => shuttingDown;

/**
 * Instantiates all configured Camera domain objects and loads their cached snapshots.
 *
 * @returns {{ cams: Camera[], bySerial: Map<string, Camera> }}
 */
function createCameras() {
  const cams = config.cfg.cameras.map(
      (rawCam) => new Camera(rawCam, loadCachedFrame(rawCam), renderCameraCards)
  );
  const bySerial = new Map(cams.map((cam) => [cam.serial, cam]));
  return {cams, bySerial};
}

/**
 * Connects cross-service callbacks between the orchestrator, media pipeline, Frigate, and Eufy WS.
 *
 * @param {Camera[]} cams - Active camera collection.
 * @param {Map<string, Camera>} bySerial - Lookup map by hardware serial number.
 */
function wireServices(cams, bySerial) {
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
    onWsClosedStop: (cam) =>
        stop(cam, 'bridge lost eufy-security-ws connection', false, 'error/ws-disconnect'),
    onInitialTelemetryLoaded: () => void syncFrigateMotionMasks(cams, false, shuttingDown),
  });
}

/**
 * Triggers an on-demand HomeBase clip backfill download test when SIGUSR1 is received.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function handleSigUsr1BackfillTest(cams) {
  const targetCam = cams.find((cam) => !cam.isRtspCapable()) || cams[cams.length - 1];
  if (!targetCam) {
    return;
  }

  log.info(targetCam, 'received SIGUSR1 signal, queueing test backfill download of latest HomeBase clip');
  for (const cam of cams) {
    if (cam.usesP2pSlot() && !cam.isInMotion()) {
      stop(cam, 'yielding P2P slot for SIGUSR1 backfill test', true, 'bridge-backfill');
    } else if (!cam.active && !cam.isRtspCapable()) {
      cam.clearViewerQueue('SIGUSR1 backfill test');
    }
  }

  targetCam.prepareSigUsr1BackfillTest(Date.now());
  setTimeout(() => void processBackfillQueue(Date.now()), SIGUSR1_BACKFILL_DELAY_MS);
}

/**
 * Gracefully stops all active camera livestreams and terminates FFmpeg encoder processes.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function shutdownBridge(cams) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopHttpServer();
  log.info('bridge', 'received shutdown signal, stopping active streams and encoders');

  for (const cam of cams) {
    cam.motionUntil = 0;
    stop(cam, 'bridge container shutting down', false, 'system-shutdown');
    cam.stopEncoderProcess();
  }
  setTimeout(() => process.exit(0), SHUTDOWN_EXIT_DELAY_MS);
}

/**
 * Registers POSIX signal hooks (SIGUSR1, SIGUSR2, SIGTERM, SIGINT) and global error handlers.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function registerSignalHandlers(cams) {
  process.on('SIGUSR2', () => {
    log.info(cams[0], 'received SIGUSR2 signal, triggering synthetic test event');
    frigateEvent(cams[0], 'test detected');
  });

  process.on('SIGUSR1', () => handleSigUsr1BackfillTest(cams));
  process.on('SIGTERM', () => shutdownBridge(cams));
  process.on('SIGINT', () => shutdownBridge(cams));

  process.on('uncaughtException', (err) => {
    const details = err && err.stack ? err.stack : err;
    log.error('bridge', 'uncaught exception (service continuing): ' + details);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('bridge', 'unhandled promise rejection (service continuing): ' + reason);
  });
}

/**
 * Formats and writes the startup configuration summary banner to the log.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function logStartupBanner(cams) {
  const camNames = cams.map((cam) => cam.name).join(', ');
  const alwaysBackfillCams = cams.filter((cam) => cam.alwaysBackfill).map((cam) => cam.name);
  const encoderDesc = config.ACTIVE_HWACCEL
      ? config.ACTIVE_HWACCEL + ' (' + config.HWACCEL_DEVICE + ')'
      : 'software (libx264)';

  const summaryParts = [
    'cameras=[' + camNames + ']',
    'logLevel=' + config.ACTIVE_LOG_LEVEL_NAME,
    'cache=' + config.CACHE_DIR,
    'encoder=' + encoderDesc,
    'useRtsp=' + config.GLOBAL_USE_RTSP,
    'backfill=' + config.BACKFILL_DOWNLOADS,
    'autoMask=' + config.GLOBAL_AUTO_FRIGATE_MASK,
    'cardOnLive=' + config.GLOBAL_CARD_SHOW_ON_LIVE,
    'letEufyDecideEnd=' + config.LET_EUFY_DECIDE_END,
    'dimBg=' + config.GLOBAL_DIM_BACKGROUND,
    'hold=' + config.HOLD_MS / 1000 + 's',
    'earlySleep=' + config.EARLY_SLEEP_MS / 1000 + 's',
    'viewerLinger=' + config.LINGER_MS / 1000 + 's',
    'max=' + config.MAX_MS / 1000 + 's',
  ];
  if (alwaysBackfillCams.length > 0) {
    summaryParts.push('alwaysBackfill=[' + alwaysBackfillCams.join(', ') + ']');
  }

  log.info('bridge', 'eufy-frigate-battery-bridge starting: ' + summaryParts.join(', '));
}

/**
 * Starts all background loops, per-camera FFmpeg encoders, and the Eufy WebSocket client.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function startServices(cams) {
  logStartupBanner(cams);
  startMediaTickers(cams);

  setInterval(() => {
    void pollViewers(cams, {
      isShuttingDown,
      fetchAllCameraTelemetry,
      stopCam: stop,
      triggerCam: trigger,
    });
  }, VIEWER_POLL_INTERVAL_MS);

  startHousekeepingLoop();
  startTelemetryPoller();

  for (const cam of cams) {
    startEncoder(cam);
  }
  startHttpServer(cams, {
    wakeCameraExternal,
    isShuttingDown: () => shuttingDown,
  });
  connectWs();
  setTimeout(() => void syncFrigateMotionMasks(cams, false, shuttingDown), INITIAL_MASK_SYNC_DELAY_MS);
}

/**
 * Application bootstrap entrypoint.
 */
function main() {
  const {cams, bySerial} = createCameras();
  wireServices(cams, bySerial);
  registerSignalHandlers(cams);
  startServices(cams);
}

main();
