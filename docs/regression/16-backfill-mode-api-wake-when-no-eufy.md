# 16. `"backfill"` Mode `/api/wake` With No Eufy Clip, Viewer Block & Download Isolation

- **Scope:** `"backfill"` Mode `/api/wake` When No Eufy Clip Is Recording, Blocking Frigate Live View During Pending
  `BackfillJob`, Yellow `Waiting` (`card.busy`) Backfill Status Indicator & `STREAM_MODES.DOWNLOAD` Eufy App
  Isolation/Retry (`AT-01`-`AT-04`, `AT-13`, `AT-14`, `AT-16`, `AT-17`, `AT-18`)

- **Cause 1 (`POST /api/wake/:cameras` Queuing a `BackfillJob` When `HomeBase 3` Never Recorded a `.zxvideo`
  Clip):** When an external automation (such as a `Ratgdo` garage door opener in Home Assistant) called
  `POST /api/wake/:cameras` on an `IDLE` `"backfill"` camera before Eufy's PIR sensor fired, queuing a `BackfillJob`
  without waking the camera meant `HomeBase 3` never recorded a `.zxvideo` clip for that HTTP request (`10/10`
  database queries returned `0` matching clips). Conversely, if a Eufy hardware trigger or `BackfillJob` was already
  active when `/api/wake` arrived, waking a live stream would interrupt the hardware clip recording.
- **Cause 2 (Opening Frigate Live View During a Pending `BackfillJob` Canceling the `BackfillJob` After `20%` Live
  Video & Recording `0` Events):** When a user opened a single-camera Frigate Live View while a `BackfillJob` was
  pending, `pollViewers` woke a live stream (`eventActive: false`, `reason='viewer'`) and then
  `cancelBackfillIfLiveConfirmed` canceled the pending `BackfillJob` once `20%` (`6s`) of live viewer frames
  decoded, leaving `0` recorded events in Frigate (`eventActive: false` and `BackfillJob` canceled) and showing the
  normal `Asleep` card beforehand with no visual indication that `HomeBase 3` / the bridge was busy handling a clip
  backfill.
- **Cause 3 (External Eufy App `P2P` Events or Interrupted `start_download` Transfers in `STREAM_MODES.DOWNLOAD`):**
  If `eufy-security-ws` emitted `'livestream stopped'` or `'livestream video/audio data'` when the user opened/closed
  the Eufy mobile app while the bridge was draining buffered backfill frames in `STREAM_MODES.DOWNLOAD`,
  `evaluateExternalLivestreamStop` treated the session as an expired live stream and stopped the backfill playback; and
  if `device.start_download` failed, timed out with `0` decoded frames, or was interrupted after Frame 0 before
  `'download finished'` (station disconnect, live preemption, or `device.cancel_download`), `downloadedPaths` retained
  the clip path and did not retry.
- **Fix:** Updated `Camera.shouldBackfillOnlyOnApiWake()` and `wakeCameraExternal` so `POST /api/wake/:cameras` on an
  `IDLE` `"backfill"` camera wakes a live `RTSP` or `P2P` stream (`status: 'waking'` / `'scheduled'`, paced by `2.5s`
  per station) and files a Frigate event when no Eufy hardware trigger or `BackfillJob` is active, and stays in `IDLE`
  extending the `BackfillJob` (`status: 'backfill'`) when a Eufy hardware trigger or `BackfillJob` is already active;
  added `Camera.isViewerBlockedByBackfill()` and updated `classifyViewerAction` / `pollViewers` so single-camera
  Frigate Live View is blocked (`'ignored, waiting for HomeBase clip backfill'`) for the entire pending `BackfillJob`
  lifecycle across all camera modes; added `Camera.isWaitingForBackfill()` / `Camera.isWaitingForSlotOrBackfill()`
  across `Camera.selectEncoderFrame()` and `renderLiveFrameWithCard()` so all status card themes (`"debug"` HUD left
  square, `"icons"`, `"minimal"`, `"detailed"`) render the **Yellow** (`CARD_STATUS_TITLES.WAITING` /
  `STATUS_KINDS.WAITING` / `card.busy`) indicator while `IDLE` with a pending `BackfillJob` or while in
  `HANDSHAKING_BACKFILL` (`FB`) before Frame 0 of the `.zxvideo` clip is decoded, then transition to **Red**
  (`CARD_STATUS_TITLES.BACKFILL` / `B`) once Frame 0 plays; isolated `STREAM_MODES.DOWNLOAD` from live `P2P` events
  (`'livestream started'`, `'livestream stopped'`, `'livestream video/audio data'`), protected active backfill
  playbacks from viewer preemption (`shouldYieldToNewStationViewer`, `isUrgentBackfillProtectedFrom`), released the
  station `P2P` channel once the `2-3s` `HomeBase 3` transfer completes (`Camera.isOccupyingStationP2pChannel()`), and
  re-queued incomplete downloads (unless `downloadFinished` or stopped via `eufy/download-finished`) up to
  `MAX_BACKFILL_CLIP_DOWNLOAD_ATTEMPTS = 3` after a `4s` cooldown (`AT-16`).
