# 34. Back-to-Back P2P Backfill Clip Preservation, Follow-Up Queries & Tail Frame Drain

- **Scope:** `src/domain/backfill-job.js`, `src/domain/camera.js`, `src/services/stream-orchestrator.js`
- **Cause:** Six issues caused missing clips or truncated tail frames during back-to-back P2P backfill on HomeBase
  cameras:
  1. When `pendingBackfill` (`Job 1`) had already settled (`>= 4s` post-clear) or matched Clip 1 and a new `state: true`
     trigger arrived for Clip 2, `queueEventBackfill` called `upgradeEvent(..., recordingActive = true)` on `Job 1`,
     resetting it to `RECORDING` so Clip 1 could not be queried before Clip 2 overwrote it in
     `station.database_query_latest_info`. Trailing `state: false` events on cleared jobs also reset `clearedAt` and
     regressed `READY_TO_QUERY` / `MATCHED` to `SETTLING`.
  2. When `activeBackfillJob` (`Job 1`) still had queued clips in `backfillClipQueue` and `pendingBackfill` held
     `Job 2`, `beginBackfillDownload` unconditionally overwrote `activeBackfillJob` with `pendingBackfill`, losing
     `Job 2` when `Job 1`'s remaining clip finished.
  3. `prepareFollowUpQuery(now)` set `clearedAt = now` (stalling follow-up queries for a redundant `4s` settle delay)
     and set `attempts = maxAttempts - 1` (`9/10`, leaving only 1 query attempt before expiry), while
     `followUpQueried = true` was never reset after matching Clip 2, blocking a 3rd split clip.
  4. `handleDatabaseQueryResult` matched station-wide `station.database_query_latest_info` rows against cameras still
     actively recording (`recordingActive: true` before settle/timeout), pulling incomplete 1-2s `.zxvideo` clips and
     recording their paths in `downloadedPaths`.
  5. `shouldDeferDecoderDetachOnExit(dec)` only deferred detach when `decoderStdoutPaused` or
     `dec.stdout.readableLength > 0`, detaching `this.dec` early and dropping `< 20` flowing tail frames arriving
     between `FFmpeg` process `'exit'` and stdout `'close'`. `isDownloadComplete()` also ignored unencoded
     `this.frameNew` frames and allowed `idleCompleteMs` completion before `allPipesDrained`.
  6. Across the `backfillContinuation` gap between Clip 1 ending and Clip 2 starting, `isStreamingLive()` returned
     `false` and `stop()` pushed `card.busy` over Clip 1's final frame; `getEffectiveEventDurationSecs()` ignored
     in-flight decoder packet counts, and `isMotionOnlyActiveSession()` / `hasReachedViewMaxDuration()` did not check
     `isActiveLiveSession()`.
- **Fix:**
  1. Added `queuedBackfillJob` on `Camera` so triggers arriving after `pendingBackfill` has settled or matched Clip 1
     queue `Job 2` separately without resetting `Job 1`, and guarded `markRecordingCleared` against regressing
     already-cleared jobs.
  2. Promoted `pendingBackfill` to `activeBackfillJob` in `beginBackfillDownload` only when `activeBackfillJob` is empty
     or `pendingBackfill` owns the starting clip, shifting `queuedBackfillJob` into `pendingBackfill`.
  3. Preserved settled `clearedAt`, reset `attempts = 0` in `prepareFollowUpQuery(now)`, and reset
     `followUpQueried = false` in `enqueueMatchedCandidate()` when a follow-up clip matches.
  4. Added `Camera.canMatchDatabaseQueryResult(now)` and guarded `handleDatabaseQueryResult` and
     `tryMatchBackfillCandidate` against matching in-progress recordings.
  5. Deferred backfill decoder detach on process exit until `dec.stdout` closes (`!readableEnded && !closed`), updated
     `lastVideoAt` in `recordDecodedFrame`, and required `allPipesDrained` (including `!frameNew`) in
     `isDownloadComplete()`.
  6. Held Clip 1's final frame across `backfillContinuation` while `hasPendingBackfill()`, counted in-flight packets in
     `getEffectiveEventDurationSecs()`, and restricted `isMotionOnlyActiveSession()` / `hasReachedViewMaxDuration()` to
     `isActiveLiveSession()`.
- **Tests:** `test/regression/34-back-to-back-p2p-backfill-clip-and-tail-preservation.test.js`.
