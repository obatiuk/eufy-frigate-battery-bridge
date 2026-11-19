# 36. Same-Camera Backfill Chronological Event Ordering & Deferred Live Wakes

- **Scope:** `src/domain/camera.js`, `src/services/stream-orchestrator.js`
- **Cause:** When a `"p2p"`, `"rtsp"`, or `"auto"` camera (`alwaysBackfill === false`) was actively playing back an
  earlier recorded clip in `STREAM_MODES.DOWNLOAD` (`Event 1`), incoming activity on that same camera misbehaved in
  three ways:
  1. Eufy motion/person/ring triggers called `trigger(cam, ...)` during `DOWNLOAD`, overwriting `Event 1`'s active
     session `reason`, setting `eventActive = true`, and logging a misleading `"already live, holdExtendedTo=..."` line
     (while dropping the live wake when `backfill_enabled: false` because `endSession` zeroed `motionUntil`).
  2. Hardware `'rtsp livestream started'` events on `"rtsp"` or `"auto"` cameras during `DOWNLOAD` skipped both
     `shouldBackfillOnlyOnEvent()` and `!isSessionActive()`, dropping `Event 2` without queuing a `BackfillJob` or a
     post-backfill wake.
  3. External `POST /api/wake/:cameras` requests during `DOWNLOAD` (when no Eufy hardware trigger was recording)
     returned `status: "waking"` even though `wantsWake()` required `!active`, and `endSession(..., 'download')` wiped
     `motionUntil = 0` (`create_event: true`) or let `duration` decay while `Event 1` drained, dropping the wake
     entirely; conversely, preempting `Event 1` immediately with a live `Event 2` would invert chronological event order
     (`Event 2 -> Event 1`) in Frigate.
- **Fix:**
  1. Kept `Event 1` backfill playback uninterrupted on all camera modes during `STREAM_MODES.DOWNLOAD`, routing Eufy
     hardware triggers and `'rtsp livestream started'` to `BackfillJob` queueing when `backfill_enabled: true` (without
     mutating `Event 1`'s active `reason` or logging `"already live"`) and to `schedulePostBackfillWake` when
     `backfill_enabled: false`.
  2. Extended `shouldBackfillOnlyOnApiWake(now)` and `queueOrUpgradeApiWakeBackfill` so `/api/wake` during `DOWNLOAD`
     with an unexpired Eufy hardware trigger upgrades the recording `BackfillJob` (`status: "backfill"`), and otherwise
     coalesces a deferred post-backfill wake (`status: "scheduled"`) that promotes for its full requested `duration` as
     soon as `Event 1` (and any earlier `BackfillJob`) finishes or expires, absorbing deferred priority if a Eufy PIR
     trigger starts recording moments later and clearing deferred wakes on disconnect, offline, or shutdown.
- **Tests:** `test/acceptance/AT-13.test.js`, `test/acceptance/AT-16.test.js`, `test/acceptance/AT-17.test.js`,
  `test/regression/36-same-camera-backfill-chronological-event-order.test.js`, and
  `test/regression/36-same-camera-backfill-chronological-event-order.test.js`.
