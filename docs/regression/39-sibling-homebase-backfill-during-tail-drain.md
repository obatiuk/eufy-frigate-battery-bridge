# 39. Sibling HomeBase Backfill Unblocked During Tail Frame Drain

- **Scope:** `src/domain/camera.js`, `src/services/stream-orchestrator.js`
- **Cause:** `isBlockingStationBackfill()` checked `this.usesP2pSlot()` (`true` throughout `STREAM_MODES.DOWNLOAD`, even
  after `downloadFinished === true`) rather than `this.isOccupyingStationP2pChannel()` (with a self-only bypass in
  `isStationIdleForBackfill()`). When `Camera A` finished transferring its `.zxvideo` clip from `HomeBase 3` and spent
  `30s`-`120s` draining buffered frames from RAM (`DRAINING_BACKFILL_TAIL`), sibling cameras sharing the same `HomeBase`
  remained blocked from querying `station.database_query_*` or starting `device.start_download` even though the
  `HomeBase` `P2P` channel was already free.
- **Fix:**
  1. Switched `isBlockingStationBackfill()` to `this.isOccupyingStationP2pChannel()` (and scoped the post-sleep
     `sleptAt` `delayMs` check to inactive cameras so a prior `sleptAt` timestamp never blocks during active RAM drain),
     removing the self-only `allowDrainingSelf` special case from `isStationIdleForBackfill()`.
  2. Triggered `processBackfillQueue(now)` alongside `arbitrate(now)` inside `handleDownloadFinishedEvent()` so waiting
     sibling backfill queries and downloads start immediately as soon as `HomeBase` finishes transferring a clip.
- **Tests:** `test/acceptance/AT-13.test.js` and
  `test/regression/39-sibling-homebase-backfill-during-tail-drain.test.js`.
