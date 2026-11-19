# 48. Per-Camera Housekeeping Error Isolation & Fatal Uncaught Exception Shutdown

- **Cause:** `runHousekeepingTick()` and `prepareExpiredCameraHolds()` in
  `src/services/orchestrator/housekeeping.js` ran every `500ms` without step or per-camera `try/catch` guards, so a
  deterministic throw on one camera skipped every later camera on every tick while logging `~2` error lines per second
  through `process.on('uncaughtException')` in `src/app.js`, which logged `"service continuing"` and kept running with
  potentially corrupted process state.
- **Fix:** Wrapped `arbitrate()`, `processBackfillQueue()`, mask/probe checks, and each per-camera step inside
  `prepareExpiredCameraHolds()` and `runHousekeepingTick()` (plus async `evaluateEarlySleep` /
  `evaluateActiveHoldExtension` rejections) in `try/catch` with `30s` bounded per-step error rate-limiting
  (`logHousekeepingError`), and updated `handleUncaughtException()` in `src/app.js` to trigger graceful shutdown and
  exit with code `1` so the container supervisor restarts into a clean state.
- **Tests:** `test/services/orchestrator/modules.test.js` and
  `test/regression/48-housekeeping-per-camera-error-isolation-and-fatal-exit.test.js`.
