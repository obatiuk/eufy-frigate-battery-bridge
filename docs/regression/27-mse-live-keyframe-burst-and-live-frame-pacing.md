# 27. MSE Live Keyframe Burst, Live Frame Drain Drift & High-FPS RTSP Overflow

- **Cause:** Three media-pipeline pacing behaviors degraded live viewer attach latency and continuous `RTSP`/`P2P`
  playback: (1) `Camera.shouldWriteEncoderFrame()` ignored `inBurst` when `isLive` was `true`, falling back to the
  `500ms` (`2 fps`) heartbeat on VFR or night-vision live feeds so `go2rtc` `MSE` viewers waited up to `7.5s` for a
  `-g 15` `IDR` keyframe whenever Frigate's Smart Streaming grid attached to a tile; (2) `handleDecodedRtspFrame()` and
  `handleDecodedP2pFrame()` did not call `pushFrameToEncoder()` after queueing into `cam.liveFrames`, allowing
  continuous `15.00 fps` (`66.67ms`) streams to drift behind `setInterval(67ms)` up to `MAX_LIVE_BURST_FRAMES` (`12`
  frames, `800ms` lag plus periodic head-drops); and (3) `buildRtspDecoderArgs()` had no framerate cap, decoding and
  Lanczos-scaling `20`/`25`/`30 fps` `RTSP` cameras into a `15 fps` pipe until `liveFrames` overflowed every second.
- **Fix:** Paced live `inBurst` encoder writes at `15 fps` (`62ms`) in `Camera.shouldWriteEncoderFrame()` so newly
  connected `MSE` viewers receive an `IDR` keyframe within `<= 1s` without sub-frame duplicate floods; flushed due
  `liveFrames` immediately via `pushFrameToEncoder()` on decoded `RTSP` and `P2P` frame arrival; and prepended a
  non-duplicating Bresenham VFR `select` cap (`<= 15 fps`) in `buildRtspVideoFilter()`.
- **Tests:** `test/media.test.js` (`Regression #27`).
