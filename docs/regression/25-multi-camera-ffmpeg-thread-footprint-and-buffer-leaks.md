# 25. Multi-Camera FFmpeg Thread Footprint, Probe Buffer Churn & Unbounded Queues

- **Cause:** Running multi-camera deployments on high-core hosts exposed six memory footprint and retention issues: (1)
  `buildEncoderArgs()`, `buildP2pDecoderArgs()`, `buildRtspDecoderArgs()`, and snapshot `ffmpeg` invocations left
  filtergraph threads, H.264/HEVC frame-decoder threads, `rawvideo` input packet queues (`8` frames), `RTSP` `probesize`
  (`5 MB`), and `h264_qsv` `extra_hw_frames` (`64`) uncapped so each `ffmpeg` process spawned dozens of worker threads
  and multiplied full-resolution reference/frame pools; (2) `StatusCard` and `Camera` eagerly allocated `7 x 1.38 MB`
  raw YUV420p buffers per camera at startup even for cameras that never enter `waking`, `busy`, live overlay, or live
  P2P/RTSP decoding; (3) `attachDecoderStreams()` allocated a fresh `1.38 MB` `Buffer` on every decoder spawn instead of
  reusing a per-camera buffer; (4) `downloadedPaths`, `pendingVideoPackets`, and `pendingAudioPackets` in
  `src/domain/camera.js` grew without caps; (5) `handleP2pDecoderExit()` called `cam.resumeDecoderStdout()` before
  checking `cam.dec === dec`, allowing an exiting old decoder to resume a newly attached paused decoder; and (6)
  `setStationTransition()` in `src/services/stream-orchestrator.js` retained settled stop-transition promises in
  `stationTransitions`.
- **Fix:** Added `-filter_threads 1 -filter_complex_threads 1`, bounded `-thread_queue_size`, `-async_depth 1` on
  `vaapi`, `extra_hw_frames=8` on `qsv`, `3500k` VBV `bufsize`, `-threads 2` on `libx264` and P2P/RTSP decoders, bounded
  `512 KB` / `1s` `RTSP` probe limits, `-threads 1` on snapshot JPEG helpers, and `MESA_SHADER_CACHE_DISABLE=true` in
  `deploy/Dockerfile`; lazy-allocated `StatusCard` `waking`, `busy`, and `liveOverlayBufs` plus `Camera` `liveFrameRing`
  and reused a single per-camera `decoderReadBuf` gated on `isActiveDecoder()`; capped `downloadedPaths` (`500` FIFO)
  and stalled `pendingVideoPackets`/`pendingAudioPackets` with drop-oldest eviction and live `DROP:<n>` HUD reporting;
  guarded `resumeDecoderStdout()` on `cam.dec === dec`; and skipped `stationTransitions` on direct `rtsp_url` stops
  while deleting settled HomeBase promises from `stationTransitions`.
- **Tests:** `test/regression/25-multi-camera-ffmpeg-thread-footprint-and-buffer-leaks.test.js` (`caps FFmpeg
filtergraph threads...`, `reuses a single per-camera decoder stdout...`, `lazy-allocates StatusCard waking,
busy...`), `test/regression/25-multi-camera-ffmpeg-thread-footprint-and-buffer-leaks.test.js` (`bounds
downloadedPaths FIFO history...`), and
  `test/regression/25-multi-camera-ffmpeg-thread-footprint-and-buffer-leaks.test.js` (`skips stationTransitions on
direct rtsp_url stops...`).
