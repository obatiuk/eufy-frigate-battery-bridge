# 9. Truncated `"backfill"` Clips on Battery Doorbells & Multi-Clip Visits

- **Cause 1 (Premature Query on Partial Clear):** Eufy doorbells emit multiple concurrent trigger properties
  (`motion detected`, `person detected`, `identity person detected`, `rings`). When one property flipped to
  `state: false` early while `motion detected` was still active, `markRecordingCleared` immediately started a `2s`
  timer, and `extractDatabaseRecordCandidate` synthesized the `.zxvideo` path from `crop_local_path` (which
  `HomeBase 3` creates at `t=0` when recording starts), causing `device.start_download` to pull an incomplete file
  while the camera was still recording.
- **Cause 2 (Unflushed FFmpeg Decoder Tail & Immediate Sleep after Last Frame):** When `eufy-security-ws` emitted
  `'download finished'`, `dec.stdin` was never closed for EOF (`flushDecoderInput`), leaving the last `0.5-1.5s` of
  frames inside FFmpeg's `H.265`/`H.264` reorder buffer, and `checkDownloadSessionHealth` immediately switched the
  stream back to the static `5 fps` sleeping card on the tick the last buffered frame was written
  (`downloadFrames.length === 0`), cutting off Frigate's recording tail. Additionally, `appendAudioPcmChunk` capped
  `cam.pcm` at `1s` (`RATE * 2`), discarding ~90% of burst-downloaded audio.
- **Cause 3 (Single-Clip Overwrite & Query Ordering on Multi-Clip Visits):** Calling
  `station.database_query_latest_info` (which returns only 1 record per camera) before
  `station.database_query_by_date` caused the single latest clip to immediately start downloading and call
  `clearPendingBackfill()`, discarding earlier or split clips from the same visit.
- **Fix:** Tracked active trigger properties per camera/job (`activeTriggerEvents` / `activeEvents`) so
  `markRecordingCleared` only marks recording complete once all active properties report `state: false`, raised
  `BACKFILL_POST_CLEAR_SETTLE_MS` to `4000ms` (and scaled the wait cap to `Math.max(35000, holdMs + 4000)`), added
  `flushDecoderInput(cam)` on `'download finished'`, held the final frame for `2500ms`
  (`DOWNLOAD_POST_PLAYBACK_HOLD_MS`), expanded burst download video/audio buffers (`MAX_DOWNLOAD_BUFFER_SECS = 120`,
  `KEY_PACKET_SCAN_BYTES = 4096`), queried `database_query_by_date` before `database_query_latest_info`, queued all
  matching clips chronologically in `cam.backfillClipQueue` with automatic post-download follow-up queries for split
  clips (`needsFollowUpClipQuery`), and scaled Frigate's event `duration` (`getEffectiveEventDurationSecs`).
