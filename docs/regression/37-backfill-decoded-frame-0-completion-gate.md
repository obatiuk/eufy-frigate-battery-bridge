# 37. Backfill Decoded Frame-0 Completion Gate & Stalled Probe Timeout

- **Scope:** `src/domain/camera.js`
- **Cause:** `markP2pVideoPacketReceived()` set `gotVideo = true` on the very first raw compressed `.zxvideo` packet
  before `FFmpeg`'s `32 KB` stream probe decoded **Frame 0** (`firstFrameAt > 0`). When a `HomeBase` clip transfer sent
  truncated or header-only packets and stalled (or emitted `'download finished'` without decodable frames), three gates
  treated the `0`-frame session as having valid video:
  1. `hasDownloadTimedOut()` checked `!this.gotVideo`, so a stalled transfer that received even one compressed packet
     never timed out after `15s`.
  2. `isDownloadComplete()` checked `this.gotVideo` without requiring `firstFrameAt > 0`, so
     `checkDownloadSessionHealth` finished the `0`-frame transfer as `"completed"` (`eufy/download-finished`) via the
     `3s` idle fallback (or after `'download finished'`).
  3. `terminateSession()` passed `hadVideo = this.gotVideo` into `endSession()`, leaving `clip.storagePath` in
     `downloadedPaths` instead of re-queuing the clip for retry.
- **Fix:**
  1. Added `hasDecodedFrame()` (`downloadDecodedFrames > 0 || firstFrameAt > 0` so post-EOF `detachDecoder()` preserves
     decoded-frame confirmation during final-frame hold) and `hasConfirmedSessionVideo()` on `Camera`, and gated
     `hasDownloadTimedOut()`, `isDownloadComplete()`, `markDownloadFinished()`, and `terminateSession()`'s `hadVideo` on
     `hasDecodedFrame()` for `STREAM_MODES.DOWNLOAD` while keeping live `P2P` packet detection unchanged.
  2. Updated `recordDecodedFrame()` to ensure `gotVideo = true` whenever Frame 0 decodes, and `endSession()` to clear
     `gotVideo = false` when a session ends with `hadVideo === false` so failed `0`-frame downloads re-queue cleanly up
     to `MAX_BACKFILL_CLIP_DOWNLOAD_ATTEMPTS` (`3`) after the `4s` cooldown without persisting stale snapshots.
- **Tests:** `test/acceptance/AT-16.test.js` and
  `test/regression/37-backfill-decoded-frame-0-completion-gate.test.js`.
