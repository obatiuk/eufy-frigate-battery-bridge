// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * eufy-frigate-battery-bridge: application composition root, dependency wiring,
 * signal/test hooks, and graceful shutdown lifecycle.
 */
'use strict';

const fs = require('node:fs');
const {
  cfg,
  READY_MARKER_FILE,
  BRIDGE_VERSION,
  BRIDGE_COMMIT,
  ACTIVE_HWACCEL,
  HWACCEL_DEVICE,
  ACTIVE_LOG_LEVEL_NAME,
  CACHE_DIR,
  AUDIO,
  PROCESS_SIGNALS,
} = require('./config');
const {log, formatErrorMessage} = require('./logger');
const {Camera} = require('./domain/camera');
const {loadCachedFrame, waitForPendingSnapshotSaves} = require('./overlay/snapshot-cache');
const {renderCameraCards} = require('./overlay/card-renderer');
const {configureEncoderHooks, startEncoder, startMediaTickers, stopMediaTickers} = require('./media/encoder');
const {setDecoderStopHandler} = require('./media/decoder');
const {
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  frigateEvent,
  pollViewers,
} = require('./services/frigate-client');
const {
  configureEufyClientHooks,
  ensureCameraEncodersStarted,
  connectWs,
  stopWsClient,
  startTelemetryPoller,
  stopTelemetryPoller,
  fetchAllCameraTelemetry,
} = require('./services/eufy-client');
const {
  initOrchestrator,
  waitForStationTransitions,
  wakeCameraExternal,
  trigger,
  stop,
  onEvent,
  processBackfillQueue,
  startHousekeepingLoop,
  stopHousekeepingLoop,
} = require('./services/stream-orchestrator');
const {startHttpServer, stopHttpServer} = require('./services/http-server');
const {verifyUpstreamServiceVersions, stopUpstreamVersionChecks} = require('./services/service-versions');

const SIGUSR1_BACKFILL_DELAY_MS = 300;
const SHUTDOWN_EXIT_DELAY_MS = 1500;
const SHUTDOWN_MAX_DRAIN_MS = 5000;
const VIEWER_POLL_INTERVAL_MS = 750;

let bridgeShuttingDown = false;
/** @type {ReturnType<typeof setInterval>|null} */
let viewerPollTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let sigUsr1BackfillTimer = null;
const isShuttingDown = () => bridgeShuttingDown;

/**
 * Records the live bridge PID after startup configuration validation succeeds (used by HEALTHCHECK
 * when BRIDGE_HTTP_PORT=0 disables the HTTP listener).
 */
function markBridgeReady() {
  try {
    fs.writeFileSync(READY_MARKER_FILE, String(process.pid), 'utf8');
  } catch (err) {
    // Ignore read-only temp directory errors when HTTP healthcheck is active.
  }
}

/**
 * Removes the readiness PID marker during shutdown or process exit.
 */
function clearBridgeReady() {
  try {
    fs.rmSync(READY_MARKER_FILE, {force: true});
  } catch (err) {
    // Ignore cleanup errors on exit.
  }
}

/**
 * Instantiates all configured Camera domain objects into `cams` after decoding their cached snapshots in parallel
 * off the event loop, so the already-bound HTTP listener keeps answering health probes meanwhile.
 *
 * @param {Camera[]} cams - Active camera collection populated in place during bootstrap.
 * @returns {Promise<Map<string, Camera>>} Lookup map by hardware serial number.
 */
async function initCameras(cams) {
  const snapshots = await Promise.all(cfg.cameras.map((rawCam) => loadCachedFrame(rawCam)));
  cfg.cameras.forEach((rawCam, index) => {
    cams.push(new Camera(rawCam, snapshots[index], renderCameraCards));
  });
  return new Map(cams.filter((cam) => !cam.isRtspDirect()).map((cam) => [cam.getSerial(), cam]));
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
      stop(cam, 'bridge lost eufy-security-ws connection', {
        preemptedByViewer: false,
        initiator: 'error/ws-disconnect',
      }),
    onDeviceOfflineStop: (cam) =>
      stop(cam, 'camera reported offline (' + cam.getOfflineReason() + ')', {
        preemptedByViewer: false,
        initiator: 'error/device-offline',
      }),
    onDeviceOnlineResume: (cam) => startEncoder(cam),
    onInitialTelemetryLoaded: () =>
      void syncFrigateMotionMasks(cams, {forceResync: false, shuttingDown: bridgeShuttingDown}),
  });
}

/**
 * Triggers an on-demand HomeBase clip backfill download test when SIGUSR1 is received.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function handleSigUsr1BackfillTest(cams) {
  const eufyCams = cams.filter((cam) => !cam.isRtspDirect());
  const targetCam = eufyCams.find((cam) => !cam.isRtspCapable()) || eufyCams[eufyCams.length - 1];
  if (!targetCam) {
    return;
  }

  log.info(targetCam, 'received SIGUSR1 signal, queueing test backfill download of latest HomeBase clip');
  for (const cam of cams) {
    if (cam.shouldStopForSigUsr1Test()) {
      stop(cam, 'yielding P2P slot for SIGUSR1 backfill test', {
        preemptedByViewer: true,
        initiator: 'bridge-backfill',
      });
    } else if (cam.shouldClearQueueForSigUsr1Test()) {
      cam.clearViewerQueue('SIGUSR1 backfill test');
    }
  }

  targetCam.prepareSigUsr1BackfillTest(Date.now());
  if (sigUsr1BackfillTimer) {
    clearTimeout(sigUsr1BackfillTimer);
  }
  sigUsr1BackfillTimer = setTimeout(() => {
    sigUsr1BackfillTimer = null;
    void processBackfillQueue(Date.now());
  }, SIGUSR1_BACKFILL_DELAY_MS);
  if (sigUsr1BackfillTimer && typeof sigUsr1BackfillTimer.unref === 'function') {
    sigUsr1BackfillTimer.unref();
  }
}

/**
 * Resets module-level shutdown latch state between isolated unit/regression tests.
 */
function resetBridgeShutdownForTests() {
  bridgeShuttingDown = false;
}

/**
 * Gracefully stops all active camera livestreams, waits up to 5s for station teardown RPCs and
 * in-flight async snapshot encodes to complete, terminates encoders, and exits.
 *
 * @param {Camera[]} cams - Active camera collection.
 * @param {number} [exitCode=0] - Process exit status code once teardown settles.
 * @returns {Promise<void>}
 */
function shutdownBridge(cams, exitCode = 0) {
  if (bridgeShuttingDown) {
    return Promise.resolve();
  }
  bridgeShuttingDown = true;
  clearBridgeReady();
  if (viewerPollTimer) {
    clearInterval(viewerPollTimer);
    viewerPollTimer = null;
  }
  if (sigUsr1BackfillTimer) {
    clearTimeout(sigUsr1BackfillTimer);
    sigUsr1BackfillTimer = null;
  }
  stopHousekeepingLoop();
  stopTelemetryPoller();
  stopMediaTickers();
  stopUpstreamVersionChecks();
  stopHttpServer();
  log.info('bridge', 'received shutdown signal, stopping active streams and encoders');

  for (const cam of cams) {
    cam.prepareForShutdown();
    stop(cam, 'bridge container shutting down', {preemptedByViewer: false, initiator: 'system-shutdown'});
    cam.stopEncoderProcess();
  }

  const maxDrainMs = exitCode === 0 ? SHUTDOWN_MAX_DRAIN_MS : SHUTDOWN_EXIT_DELAY_MS;
  return new Promise((resolve) => {
    let finished = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let maxExitTimer = null;
    const finishExit = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (maxExitTimer) {
        clearTimeout(maxExitTimer);
        maxExitTimer = null;
      }
      stopWsClient();
      resolve();
      process.exit(exitCode);
    };
    maxExitTimer = setTimeout(finishExit, maxDrainMs);
    if (maxExitTimer && typeof maxExitTimer.unref === 'function') {
      maxExitTimer.unref();
    }
    if (exitCode === 0) {
      void Promise.allSettled([waitForStationTransitions(), waitForPendingSnapshotSaves()]).finally(finishExit);
    }
  });
}

/**
 * Logs a fatal top-level uncaught exception and shuts down with exit code 1 so the container
 * supervisor restarts the bridge into a clean state instead of continuing with corrupted invariants.
 *
 * @param {Camera[]} cams - Active camera collection.
 * @param {unknown} err - Uncaught error value.
 */
function handleUncaughtException(cams, err) {
  log.error('bridge', 'fatal uncaught exception, shutting down: ' + formatErrorMessage(err, true));
  if (bridgeShuttingDown) {
    clearBridgeReady();
    const fatalExitTimer = setTimeout(() => {
      process.exit(1);
    }, SHUTDOWN_EXIT_DELAY_MS);
    if (fatalExitTimer && typeof fatalExitTimer.unref === 'function') {
      fatalExitTimer.unref();
    }
    return;
  }
  shutdownBridge(cams, 1);
}

/**
 * Registers POSIX signal hooks (SIGUSR1, SIGUSR2, SIGTERM, SIGINT) and global error handlers.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function registerSignalHandlers(cams) {
  process.on(PROCESS_SIGNALS.SIGUSR2, () => {
    log.info(cams[0], 'received SIGUSR2 signal, triggering synthetic test event');
    frigateEvent(cams[0], 'test detected');
  });

  process.on(PROCESS_SIGNALS.SIGUSR1, () => handleSigUsr1BackfillTest(cams));
  process.on(PROCESS_SIGNALS.SIGTERM, () => void shutdownBridge(cams));
  process.on(PROCESS_SIGNALS.SIGINT, () => void shutdownBridge(cams));
  process.on('exit', clearBridgeReady);

  process.on('uncaughtException', (err) => handleUncaughtException(cams, err));

  process.on('unhandledRejection', (reason) => {
    log.error('bridge', 'unhandled promise rejection (service continuing): ' + formatErrorMessage(reason, true));
  });
}

/**
 * Formats and writes the startup configuration summary banner to the log.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function logStartupBanner(cams) {
  const camSummary = cams.map((cam) => cam.formatStartupSummary()).join(', ');
  const encoderDesc = ACTIVE_HWACCEL ? ACTIVE_HWACCEL + ' (' + HWACCEL_DEVICE + ')' : 'software (libx264)';

  const summary = [
    'version=' + BRIDGE_VERSION + ' (' + BRIDGE_COMMIT + ')',
    'cameras=[' + camSummary + ']',
    'logLevel=' + ACTIVE_LOG_LEVEL_NAME,
    'cache=' + CACHE_DIR,
    'encoder=' + encoderDesc,
    'audio=' + AUDIO,
  ].join(', ');

  log.info('bridge', 'eufy-frigate-battery-bridge starting: ' + summary);
}

/**
 * Starts all background loops, per-camera FFmpeg encoders, and the Eufy WebSocket client.
 *
 * @param {Camera[]} cams - Active camera collection.
 */
function startServices(cams) {
  logStartupBanner(cams);
  startMediaTickers(cams);
  ensureCameraEncodersStarted({wsConnected: false});

  const runViewerPollTick = () => {
    void pollViewers(cams, {
      isShuttingDown,
      fetchAllCameraTelemetry,
      stopCam: stop,
      triggerCam: trigger,
    });
  };
  if (viewerPollTimer) {
    clearInterval(viewerPollTimer);
  }
  viewerPollTimer = setInterval(runViewerPollTick, VIEWER_POLL_INTERVAL_MS);
  if (viewerPollTimer && typeof viewerPollTimer.unref === 'function') {
    viewerPollTimer.unref();
  }

  startHousekeepingLoop();
  startTelemetryPoller();
  void verifyUpstreamServiceVersions({isShuttingDown});
  connectWs();
}

/**
 * Application bootstrap entrypoint. Binds the HTTP listener immediately after configuration
 * validation so container /healthz probes succeed without waiting on snapshot decodes or external services.
 *
 * @returns {Promise<void>}
 */
async function main() {
  /** @type {Camera[]} */
  const cams = [];
  registerSignalHandlers(cams);
  startHttpServer(cams, {
    wakeCameraExternal,
    isShuttingDown: () => bridgeShuttingDown,
  });
  markBridgeReady();
  const bySerial = await initCameras(cams);
  wireServices(cams, bySerial);
  startServices(cams);
}

if (require.main === module) {
  main().catch((err) => {
    log.error('bridge', 'startup failed: ' + formatErrorMessage(err, true));
    process.exit(1);
  });
}

module.exports = {
  shutdownBridge,
  handleUncaughtException,
  resetBridgeShutdownForTests,
};
