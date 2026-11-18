# 38. Backfill Clip Playback Exempt from `stream_max_secs` Live Duration Cap

- **Scope:** `src/domain/camera.js`
- **Cause:** `hasReachedMaxDuration()` checked `this.active` instead of `this.isActiveLiveSession()` (unlike
  `hasReachedViewMaxDuration()` right below it). When `stream_max_secs` was configured below `120s` (e.g., `60s` to cap
  live battery drain) while `HomeBase 3` recorded up to `120s` clips (`MAX_DOWNLOAD_BUFFER_SECS = 120`),
  `runHousekeepingTick()` terminated `STREAM_MODES.DOWNLOAD` clip playback mid-stream via `expireMaxDurationHold()` with
  `initiator=bridge-max-limit` even while frames were draining from RAM at zero battery cost (and re-queued the clip up
  to `3` times if cut off before `'download finished'`).
- **Fix:** Restricted `hasReachedMaxDuration()` to `this.isActiveLiveSession()` (`!this.isRtspDirect() &&
this.isActiveLiveSession()`) so `stream_max_secs` continues to cap active live `RTSP` and `P2P` sessions without
  truncating `HomeBase` backfill clip playback.
- **Tests:** `test/acceptance.test.js` (`AT-12`, `AT-16`) and `test/domain.test.js`.
