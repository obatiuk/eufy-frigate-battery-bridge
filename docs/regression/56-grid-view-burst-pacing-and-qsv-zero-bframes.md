# 56. Smooth Multi-Camera Grid View Attaches & `h264_qsv` Zero-B-Frame Latency

- **Scope:** `src/media/encoder.js`, `src/services/go2rtc-viewers.js`, `src/domain/camera.js`, `AT-14`, `AT-18`
- **Cause:** `buildVideoCodecArgs()` omitted `-bf 0` on `HWACCEL_MODES.QSV` (unlike `VAAPI`), adding B-frame reordering
  latency on Intel Quick Sync. In addition, `applyStreamConsumers()` called `pushFrameToEncoder()` immediately inside
  its per-consumer loop across every camera while `!isLive && inBurst` in `Camera.shouldWriteEncoderFrame()` bypassed
  `livePaceMs` throttling completely, causing simultaneous unpaced multi-camera frame writes when Frigate Grid View
  attached. Finally, during `isLive && inBurst`, `livePaceMs` (`62ms` at `15 fps`) fired `4.7ms` ahead of steady
  `66.7ms` live decodes, writing a duplicate frame right before each new decoded frame arrived and pushing the real
  frame into `liveFrames`.
- **Fix:** Added `-bf 0` to `HWACCEL_MODES.QSV` in `buildVideoCodecArgs()`. Paced sleeping keyframe bursts
  (`!isLive && inBurst`) by `elapsedMs >= livePaceMs` instead of writing unpaced on back-to-back calls, and deferred
  multi-camera `isDashboardGrid` attaches in `pollViewers()` to the paced media ticker while keeping single-camera
  viewer attaches immediate. Set live keyframe burst cadence (`isLive && inBurst` outside backfill) to
  `Math.ceil(MS_PER_SECOND / liveFps)` (`67ms` at `15 fps`) so `VFR`/static streams still emit `15 fps` bursts without
  preempting steady `66ms` live decodes.
