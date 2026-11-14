# 30. Mid-Backfill /api/wake Upgrade, Download Queue Preservation & WS-Drop Wake Safety

- **Cause:** Three `/api/wake` edge cases dropped or broke ongoing sessions: (1) `queueApiWakeBackfill()` in
  `stream-orchestrator.js` returned `false` whenever `hasPendingBackfill()` or `hasActiveHardwareTriggers()` was
  true, ignoring priority/reason upgrades during active backfill while returning `status: "backfill"`; (2)
  `applyViewTrigger()` in `camera.js` checked `this.active` instead of `this.isActiveLiveSession()`, allowing view
  `api-wake` calls during `STREAM_MODES.DOWNLOAD` to set `runtimeExtended = true` and call `clearPendingBackfill()`,
  wiping `backfillClipQueue`; and (3) `scheduleApiWake()` overwrote `apiWakeTimer` without `clearTimeout()`, while
  scheduled wake callbacks mutated `motionClearedAt` and left stale pacing slots when `eufy-security-ws` disconnected
  before fire time.
- **Fix:** Added `Camera.queueOrUpgradeApiWakeBackfill()` to upgrade pending or active `BackfillJob` priority/reason
  and clip metadata in place without clobbering specific hardware labels (`person detected`, `rings`) or creating
  duplicate jobs; restricted `isMidStreamView` and log guards in `applyViewTrigger()` to `this.isActiveLiveSession()`;
  and made `scheduleApiWake()` clear any prior timer first while scheduled wake callbacks re-check `isWsReady()`,
  roll back `stationNextWakeAt`, skip `applyWakeTrigger()`, and log a warning on disconnect.
- **Tests:** `test/domain.test.js` (`clears any existing apiWakeTimer...`), `test/services.test.js` (`upgrades an
existing pending or active BackfillJob...`, `rejects a scheduled /api/wake...`), and `test/acceptance.test.js`
  (`AT-17`).
