# 10. Backfill Slow-Motion Playback Under Backpressure & Low-Battery Poll Drain

- **Scope:** Backfill Slow-Motion Playback Under Backpressure, Low-Battery `driver.poll_refresh` Drain & Deferred Wi-Fi
  Tier Card Rebuild

- **Cause 1 (Backfill Slow-Motion & Premature Completion Under Backpressure):** During burst `.zxvideo` downloads,
  `dec.stdout` paused at `DOWNLOAD_FRAME_HIGH_WATERMARK = 30`, causing `drainPendingDecoderInput` to bail out on
  `dec.stdin.on('drain')` while `decoderStdoutPaused === true` and starving the FFmpeg decoder of Annex-B packets.
  Simultaneously, `enc.stdin.on('drain')` and `applyDeviceProperties` called `pushFrameToEncoder(cam)` without
  advancing `downloadFrames`, resetting `cam.lastWrite = now` every `16-40ms` so `canAdvanceDownloadFrame(now, 62)`
  failed and only advanced 1 frame every `1.28s` (`0.78 fps` slow-motion). Additionally, `isDownloadComplete` only
  checked `downloadFrames.length === 0` without checking `pendingVideoPackets.length === 0` or
  `!decoderStdoutPaused`, and `startMediaTickers` skipped advancing `downloadFrames` while
  `enc.stdin.writableNeedDrain` was temporarily true.
- **Cause 2 (Low-Battery `driver.poll_refresh` Radio-Wake Death Spiral):** In
  `fetchAllCameraTelemetry(forceRefresh = false)`, `if (forceRefresh || camsRef.some((c) => c.isLowBattery()))`
  caused the periodic 5-minute `telemetry_poll_secs` (`300s`) background timer to execute `driver.poll_refresh`
  (`288` times/day) whenever any camera was in low-battery economy mode (`<= 20%`). Unlike `device.get_properties`
  (cached in `eufy-security-ws` memory with zero radio wake), `driver.poll_refresh` forced the HomeBase to actively
  wake battery cameras over the radio every 5 minutes, keeping the battery doorbell's Wi-Fi chip awake at `31°C` and
  draining ~10% battery per hour.
- **Cause 3 (Deferred Wi-Fi Signal Bar Tier Card Rebuild):** When `battery` telemetry arrived before `wifiRssi`
  (`hadInitialTelemetry === true` while `wifi === null`), subsequent `wifiRssi` updates (`-26 dBm` -> `wifi = 4`) did
  not set `shouldRebuildCard = true` in `Camera.applyTelemetryProperties`, leaving the 3rd dot in `"minimal"` mode
  stuck on `Purple` (`unknown`).
- **Fix:** Allowed `drainPendingDecoderInput(audioEnabled, true)` to flush queued packets on decoder pipe `drain`
  events even while `decoderStdoutPaused` is true; guarded `enc.stdin.on('drain')` and `applyDeviceProperties`
  against calling `pushFrameToEncoder(cam)` during `isBackfillPlayback()` without advancing a frame; decoupled
  `consumeNextDownloadFrame` from `isEncoderStdinBackpressured` in `startMediaTickers`; required
  `pendingVideoPackets.length === 0 && !this.decoderStdoutPaused` in `isDownloadComplete` (and included
  `pendingVideoPackets.length` in `markDownloadFinished` and `getEffectiveEventDurationSecs`); removed
  `camsRef.some((c) => c.isLowBattery())` from `fetchAllCameraTelemetry` so `driver.poll_refresh` only runs when
  `forceRefresh === true`; and added `wifiTierChanged` (`prevWifi !== this.wifi`) to `Telemetry.applyProperties` /
  `Camera.applyTelemetryProperties`.
