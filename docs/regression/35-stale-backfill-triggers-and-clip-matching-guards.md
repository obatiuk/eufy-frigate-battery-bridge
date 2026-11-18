# 35. Stale Backfill Trigger Expiry, Timestamp-Less Clip Rejection & FSM Guards

- **Scope:** `src/domain/backfill-job.js`, `src/domain/camera.js`, `src/services/stream-orchestrator.js`
- **Cause:** Five backfill and trigger-tracking gaps remained after back-to-back clip preservation:
  1. On `"backfill"` cameras, `activeTriggerEvents` only cleared on `state: false`, non-`DOWNLOAD` `endSession()`, or
     `clearPendingBackfill()`. When a `state: false` event was lost over RF or WebSocket reconnects, completing a
     `DOWNLOAD` backfill session left the stale trigger in `activeTriggerEvents` indefinitely, sticking
     `hasActiveHardwareTriggers()` `true`, forcing future `/api/wake` calls and Eufy app streams into backfill-only
     routing, and stalling subsequent `BackfillJob.activeEvents` settlements.
  2. `BackfillJob.matchesCandidate()` accepted any candidate with `!candidate.clipMs` (`0`) even on normal non-test
     jobs, allowing malformed timestamp-less database rows to match unrelated triggers, while `parseClipTimestampMs()`
     did not normalize numeric Unix epoch second timestamps.
  3. `ALLOWED_BACKFILL_TRANSITIONS` permitted `READY_TO_QUERY` and `MATCHED` jobs to regress to `RECORDING` or
     `SETTLING`, `BackfillJob.transitionTo()` silently ignored refused transitions, and `upgradeEvent()` /
     `markRecordingCleared()` mutated recording flags before verifying state eligibility.
  4. `BackfillJob.upgradeEvent()` overloaded positional and object arguments, `isReadyToQuery()` and `isExpired()`
     mutated FSM state inside predicates, and `Camera.isUrgentBackfillProtectedFrom()` omitted
     `this.isBackfillPlayback()`.
  5. `processBackfillQueue()` left `station.connect`, `station.database_query_by_date`, and
     `station.database_query_latest_info` RPC failures (plus `device.cancel_download` errors and thrown tick exceptions)
     unlogged or unhandled on floating invocations.
- **Fix:**
  1. Tracked per-trigger start timestamps in `activeTriggerStartedAt` (`Map`), expired stale hardware triggers past
     Eufy's max clip length plus margin (`130s`), and cleared active triggers on WebSocket/station disconnects and
     device offline transitions.
  2. Required `candidate.clipMs > 0` on non-test `BackfillJob`s, normalized numeric epoch second/millisecond timestamps
     in `parseClipTimestampMs()`, and verified candidate matching across `UTC` and `America/New_York` timezones.
  3. Tightened `ALLOWED_BACKFILL_TRANSITIONS` against backward regressions from `READY_TO_QUERY` and `MATCHED`, logged
     refused transitions at `DEBUG`, and guarded `upgradeEvent()` and `markRecordingCleared()` by state.
  4. Made `BackfillJob.upgradeEvent(opts)` monomorphic, split pure `isReadyToQuery()` / `isExpired()` predicates from
     `markReadyToQueryIfSettled()` / `expireIfNeeded()`, and checked `this.isBackfillPlayback()` in
     `isUrgentBackfillProtectedFrom()`.
  5. Logged failed backfill query and `cancel_download` RPC responses and wrapped `processBackfillQueue()` in
     `try/catch` error logging.
- **Tests:** `test/domain.test.js` and `test/services.test.js`.
