# 33. Post-Sleep Backfill Guard, Scoped Viewer Refresh, Queue State & Env Syntax

- **Scope:** `src/services/frigate-client.js`, `src/services/stream-orchestrator.js`, `src/domain/camera.js`,
  `src/domain/backfill-job.js`, `src/config.js`
- **Cause:** Four pre-release reliability and validation gaps remained:
  1. `pollViewers()` filtered all configured `cams` instead of `[...distinctNewCams]` when calling
     `shouldRefreshOfflineOnView()`, firing spurious `driver.poll_refresh` calls and offline warnings for unrelated
     offline cameras when users viewed an online or direct `rtsp_url` camera.
  2. In `"backfill"` mode, trailing `'rtsp livestream started'` (`0..3000ms` post-sleep) and `'livestream started'`
     (`250..3000ms` post-sleep, after `tryAdoptExternalP2pWake()` returns `false`) bypassed the `3s` post-sleep guard
     and triggered `shouldBackfillOnlyOnEvent()`, queuing spurious `BackfillJob` runs.
  3. `enqueueMatchedCandidate()` called `toMatchedClip()` unconditionally while a job was already in `DOWNLOADING`,
     regressing `BackfillJob` state back to `MATCHED` while clip 1 played.
  4. `expandEnvString()` used a regex replacement over valid `${VAR}` / `${VAR:-default}` matches only, leaving
     malformed or unclosed placeholders such as `${RTSP_PASS`, `${123}`, or `${}` silently intact in configuration
     values.
- **Fix:**
  1. Scoped offline refresh candidate filtering in `pollViewers()` to `[...distinctNewCams]` (excluding direct
     `rtsp_url` cameras) only when `newConnections.length > 0` and not in a dashboard grid view.
  2. Extracted `Camera.isWithinPostSleepGuard(now, guardMs)` and guarded trailing `'rtsp livestream started'` and
     `'livestream started'` hardware events in `stream-orchestrator.js` before entering backfill handling.
  3. Restricted `BackfillJob.toMatchedClip()` transitions to pre-`DOWNLOADING` states (`RECORDING`, `SETTLING`,
     `READY_TO_QUERY`, `MATCHED`) and called `completeCurrentDownload()` explicitly when `endSession()` completes a
     queued clip cleanly so multi-clip transitions follow the strict state machine.
  4. Replaced regex matching in `expandEnvString()` with a single-pass scanner that unescapes `$${...}` literals,
     validates `${VAR}` / `${VAR:-default}` syntax, and collects malformed or unclosed `${` errors in
     `expandConfigEnvVars()` without leaking resolved secret values.
- **Tests:** `test/regression/33-post-sleep-backfill-guard-poll-scope-and-env-syntax.test.js` (`pollViewers` scoping),
  `test/regression/33-post-sleep-backfill-guard-poll-scope-and-env-syntax.test.js` (trailing hardware stream-start
  backfill guard), `test/regression/33-post-sleep-backfill-guard-poll-scope-and-env-syntax.test.js` (multi-clip
  `BackfillJob` `DOWNLOADING -> MATCHED` preservation), and
  `test/regression/33-post-sleep-backfill-guard-poll-scope-and-env-syntax.test.js` (malformed/unclosed `${...}`
  rejection and `$${...}` escaping).
