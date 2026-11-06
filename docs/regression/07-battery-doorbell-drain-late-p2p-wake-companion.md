# 7. Battery Doorbell Drain, Late P2P Wake & Companion-Event Backfill Cancellation

- **Cause 1:** Global `hold_secs: 60` + `let_eufy_decide_event_end: false` (plus setting `recordingClipLength: 60`
  across all cameras) forced the battery doorbell to stay awake for `60s` on every hallway pass-by, while P2P wake
  latency (`3-6s`) missed the person walking past and recorded `60s` of an empty hallway.
- **Cause 2:** In `applyMotionTrigger()`, companion AI events (`person detected` / `identity person detected`
  arriving `3-5s` after `motion detected`) set `runtimeExtended = true` and cleared `pendingBackfill` whenever
  `now - startedAt > 3000`, even if `0s` of live video had been decoded.
- **Cause 3:** `processBackfillQueue()` checked `sleptAt` across all cameras globally (allowing RTSP sleeps to delay
  P2P backfills) and queried HomeBase DB at a fixed `+8s` while the hardware clip was still recording.
- **Fix:** Added per-camera mode presets (`"auto"`, `"rtsp"`, `"backfill"`, `"p2p"`, `"custom"`), per-camera timer
  overrides (`resolveCameraTimers`), and Eufy Power Manager auto-sync (`resolveHardwareRecordingConfig`) so the doorbell
  records a brief native clip (with `t=0` pre-roll) to HomeBase 3 and sleeps immediately; required
  `hasSustainedLiveVideo` (`20%` of hold/clip duration clamped to `3s..15s`, `AT-15`) before clearing
  `pendingBackfill`; waited for `state: false` (`markRecordingCleared`) + `2s` settle (later raised to `4s` in `#09`)
  before querying HomeBase DB; and scoped backfill idle checks per station across non-RTSP P2P cameras
  (`isStationIdleForBackfill`).
