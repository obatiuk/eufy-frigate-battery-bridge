# 50. Graceful Shutdown Drain for Station Stops, Snapshot Saves & Trigger Guards

- **Scope:** `src/app.js`, `src/domain/camera.js`, `src/domain/station.js`, `src/overlay/snapshot-cache.js`,
  `src/services/orchestrator/context.js`, `src/services/orchestrator/wake.js`,
  `src/services/orchestrator/arbitration.js`, `src/services/orchestrator/event-router.js`
- **Cause:** `shutdownBridge()` in `src/app.js` called `stop()` without awaiting per-station teardown transitions or
  async `saveCachedFrame()` `ffmpeg` encodes before calling `process.exit(0)` after `1.5s`, `prepareForShutdown()` left
  `viewUntil` set, and `trigger()`, `arbitrate()`, and `onEvent()` lacked `isShuttingDown()` guards.
- **Fix:** Cleared `viewUntil` and scheduled `/api/wake` timers in `Camera.prepareForShutdown()`; guarded `trigger()`,
  `arbitrate()`, `onEvent()`, and post-stop `device.get_properties` with `isShuttingDown()`; added
  `waitForPendingSnapshotSaves()` and `waitForStationTransitions()`; and updated `shutdownBridge()` to race them against
  a bounded `5s` deadline before closing the WebSocket and exiting.
- **Tests:** `test/overlay/snapshot-cache.test.js`, `test/services/orchestrator/modules.test.js`, and
  `test/regression/50-graceful-shutdown-await-stops-snapshots-and-ignore-triggers.test.js`.
