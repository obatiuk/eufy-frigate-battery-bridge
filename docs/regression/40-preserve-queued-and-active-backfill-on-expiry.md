# 40. Queued Backfill & Active Download Preservation on Pending Job Expiry

- **Scope:** `src/domain/backfill-job.js`, `src/domain/camera.js`
- **Cause:** `expirePendingBackfillIfNeeded()` and `beginBackfillDatabaseQuery()` called `clearPendingBackfill()`
  whenever `pendingBackfill` aged past `5m` or exhausted its `10` database query attempts (for example, when an earlier
  short motion trigger produced no saved `HomeBase` clip), `beginBackfillDatabaseQuery()` stamped
  `lastBackfillQueryAt = now` even when `allowed === false`, and `BackfillJob.upgradeEvent()` bumped `lastActivityAt`
  even when `recordingActive === false` (extending stale settled jobs' `5m` expiry whenever follow-on events arrived).
  That wiped any follow-on `queuedBackfillJob`, cleared its active hardware triggers, and cleared `activeBackfillJob`,
  `activeBackfillClip`, and remaining `backfillClipQueue` entries if an earlier clip download was still playing.
- **Fix:** Added `_dropUnfulfilledPendingBackfill(now)` so expiring or exhausting `pendingBackfill` drops only that
  unfulfilled job, promotes any unexpired `queuedBackfillJob` into `pendingBackfill` with `lastBackfillQueryAt = 0`
  (stamping `lastBackfillQueryAt` only when a query attempt is permitted), gated `BackfillJob.upgradeEvent()`'s
  `lastActivityAt` update on active recording transitions, reset `motionClearedAt = 0` inside `queueEventBackfill()` on
  new active triggers, and preserved `activeBackfillJob`, `activeBackfillClip`, `backfillClipQueue`, and active
  hardware triggers.
- **Tests:** `test/domain.test.js`.
