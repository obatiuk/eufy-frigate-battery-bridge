# 42. Per-Station Backfill Serialization & HomeBase Database Query Pacing

- **Scope:** `src/domain/backfill-job.js`, `src/domain/camera.js`, `src/services/stream-orchestrator.js`
- **Cause:** `processBackfillQueue()` ran `runBackfillQueueStep()` without an in-flight guard and tracked
  `lastBackfillQueryAt` only per camera rather than per HomeBase station. When `500ms` housekeeping ticks or incoming
  `"database query local"` / `"database query latest"` station events arrived while `station.connect` or
  `station.database_query_*` was still awaiting a WebSocket reply, re-entrant calls dispatched overlapping database
  queries and `device.start_download` RPCs on the same HomeBase, and sibling cameras hammered HomeBase with back-to-back
  database queries inside the `4s` cooldown while equal-priority siblings starved behind the first camera in config
  order.
- **Fix:** Partitioned `processBackfillQueue()` per canonical HomeBase station key with an in-flight drain loop
  (`scheduleStationBackfill()`) that coalesces re-entrant ticks onto the active station promise while allowing
  independent HomeBase stations to run in parallel, enforced the `4000ms` query cooldown across all cameras sharing a
  HomeBase (preserving immediate split-clip follow-up and `SIGUSR1` test queries), and added equal-priority round-robin
  tie-breaking by oldest `lastBackfillQueryAt` in `Camera.compareBackfillPriority()`.
- **Tests:** `test/domain.test.js`, `test/services.test.js`.
