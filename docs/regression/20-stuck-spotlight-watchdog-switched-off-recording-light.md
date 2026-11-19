# 20. Stuck Spotlight Watchdog Switched Off a Light That a Recording Still Needed

- **Cause:** `shouldTurnOffStuckIdleLight()` measured its `15s` grace from the last session or motion event and only
  used the time the light turned on when no activity had ever been recorded. A spotlight that motion had just switched
  on was therefore judged stuck at once, and the bridge sent `light=false` while the camera started a hardware clip
  (log: `turning off stuck spotlight while idle` at the same second as the new clip start, `4s` before the Eufy motion
  event arrived), giving dark recordings. The startup check and the wedged-radio path (no grace) had the same flaw.
- **Fix:** The grace is now `STUCK_LIGHT_GRACE_MS` (`130s`, longer than the longest hardware clip) measured from the
  later of the light turning on and the last activity, and it never fires during a `BackfillJob` or backfill playback.
  Both the wedged-radio path and idle RSSI light detection now apply the same grace, the startup check was removed, and
  stuck-spotlight shutoff is gated behind experimental opt-in `track_stuck_spotlight: false` by default.
- **Tests:** `AT-10` (fresh light after a long idle period, pending `BackfillJob`, `130s` grace),
  `test/regression/20-stuck-spotlight-watchdog-switched-off-recording-light.test.js`, and
  `test/regression/20-stuck-spotlight-watchdog-switched-off-recording-light.test.js` (wedged-radio recovery).
