# 21. End-of-Hold Frigate Blind Spot, Stale Event Cooldown & No-Op Hold Extensions

- **Cause:** Three session-hold defects combined when an external `/api/wake` pre-woke multiple cameras at once:
  1. `startHousekeepingLoop()` ran `arbitrate()` before `evaluateActiveHoldExtension()`, and
     `shouldPollFrigateForHoldOrBackfill()` enforced its `4s` Frigate poll cooldown right up to `wantUntil()` expiry. If
     Frigate was polled `1-3.5s` before `wantUntil()` while still idle and a person walked into view during that final
     `<4s` window, `arbitrate()` stopped the stream via `bridge-timer` without ever re-checking Frigate.
  2. `getFrigateEventState()` advanced `COOLDOWN -> IDLE` without resetting `evUntil = 0`. In the next session, while
     the new Frigate event was still pending snapshot dispatch, `shouldPollFrigateForHoldOrBackfill()` read the previous
     session's expired `evUntil > 0` (`evUntil - now <= 12000`) and polled Frigate `45s` early.
  3. `extendActiveHold()` fell back to setting `viewUntil` instead of `motionUntil` when an expiry-tick Frigate check
     resolved at or a few milliseconds after `motionUntil`, and unconditionally set `runtimeExtended = true`, cleared
     `pendingBackfill`, and returned a positive `extendMs` even when `wantUntil()` did not increase (such as a `30s`
     hold camera woken for `60s` via `/api/wake` with `54s` still remaining).
- **Fix:** `runHousekeepingTick()` now launches a single final Frigate check (`extendCheckInFlight`) when a live hold
  reaches `wantUntil()` after a prior check (`lastExtendCheckAt < wantUntil()`), deferring `bridge-timer` teardown in
  `arbitrate()` until `evaluateActiveHoldExtension()` finishes and re-arbitrates if still expired.
  `getFrigateEventState()`, `beginSession()`, and `endSession()` clear expired `evUntil` and extend-check state;
  `nearEventExpiry` ignores pending or prior-session `evUntil` values; and `extendActiveHold()` keeps motion sessions on
  `motionUntil` while reporting `extended: false` (`extendMs: 0`) without side effects when `wantUntil()` is unchanged.
- **Tests:** `test/regression/21-end-of-hold-frigate-blind-spot-and-stale-event-cooldown.test.js`
  (`runHousekeepingTick` end-of-hold person detection, expired `evUntil` reset across sessions, motion-vs-viewer
  expiry extension, and no-op `/api/wake` hold extension).
