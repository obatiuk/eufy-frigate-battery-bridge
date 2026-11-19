# Media pipeline: FFmpeg encoders, decoders, hardware acceleration, and buffers

Read when: changing `src/media/encoder.js`, `src/media/decoder.js`, `src/media/ffmpeg-args.js`,
`src/domain/camera/audio-queue.js`, `src/overlay/snapshot-cache.js`, or hot-path frame/audio buffers.
Related: [architecture.md](architecture.md), [stream-lifecycle.md](stream-lifecycle.md),
[status-card-and-hud.md](status-card-and-hud.md), [ACCEPTANCE.md](ACCEPTANCE.md) (`AT-05`, `AT-06`, `AT-07`, `AT-08`,
`AT-14`, `AT-16`, `AT-18`).

## Persistent Per-Camera `RTSP` Encoder (`src/media/encoder.js`, `src/media/ffmpeg-args.js`)

- **Continuous `RTSP` Restream Architecture (`startEncoder`, `buildEncoderArgs`):** Each non-offline camera runs one
  persistent `ffmpeg` child process pushing TCP `RTSP` (`-f rtsp -rtsp_transport tcp -fps_mode passthrough`) into
  `go2rtc` (`cfg.rtsp_publish_url` with `{name}` replaced by `cam.getName()`). Video enters on `pipe:0` as raw
  `YUV420p` frames (`W x H`, default `1280x720`, `-use_wallclock_as_timestamps 1 -thread_queue_size 2`), and when
  `audio: true`, mono `s16le` PCM enters on `pipe:3` (`RATE` Hz, `-thread_queue_size 8`, `-af aresample=async=1 -c:a aac
-b:a 32k`).
- **Thread Footprint Bounds (`FfmpegArgsBuilder.withSingleFilterThreads`):** Every `ffmpeg` encoder and decoder sets
  `-filter_threads 1 -filter_complex_threads 1` (plus `-threads 2` on `libx264` and video decoders) so multi-core
  hosts running many cameras do not spawn dozens of idle filtergraph worker threads per process.
- **Frame Pacing, Heartbeats & `MSE` Keyframe Bursts (`startMediaTickers`, `pushFrameToEncoder`):**
  - A shared video ticker runs every `Math.round(1000 / LIVE_FPS)` ms (`~67ms` at `15 fps`) alongside a `100ms` audio
    ticker (`AUDIO_TICK`, writing `AUDIO_CHUNK` bytes or `SILENCE`).
  - While asleep, `shouldWriteEncoderFrame()` writes at `idle_fps` (`5` default, matching Frigate's `detect.fps` so
    identical frames compress to `~20-40 kbps`). During live streaming or `.zxvideo` backfill playback, it paces writes
    at `live_fps` (`15` default, with a `4ms` `DOWNLOAD_PACE_LEAD_MS` lead and a `500ms` `LIVE_HEARTBEAT_WRITE_MS`
    keepalive when source frames pause).
  - Whenever a viewer connects (`registerNewViewer`) or the standby card transitions (`triggerKeyframeBurst`), `inBurst`
    temporarily forces `15 fps` output (`-g max(4, LIVE_FPS)`) so `go2rtc` `MSE` and `WebRTC` consumers receive an
    immediate `IDR` keyframe without multi-second startup lag.
- **Drain-Aware `stdin` Backpressure & Wedged-Pipe Watchdog:** When `enc.stdin.write()` returns `false`, the camera
  marks `stdin` backpressured and `enc.stdin.on('drain')` immediately flushes any newer frame
  (`shouldDrainEncoderOnReady`) without waiting for the next ticker cycle. If `stdin` stays backpressured for more than
  `10s` (`ENCODER_WEDGED_TIMEOUT_MS`), `pushFrameToEncoder()` logs an `ERROR` (`initiator=bridge-watchdog,
reason=encoder_stdin_backpressure`) and kills the wedged encoder (`killWedgedEncoder`) so the exit handler respawns it.
- **Exponential Restart Backoff & Offline Pause / Snapshot Seeding:**
  - Unexpected encoder exits or spawn errors schedule `scheduleEncoderRestartBackoff()` (`3s` base, doubling up to
    `30s`, resetting failures after `10s` of healthy uptime and firing `onEncoderDrop` so Frigate masks are re-verified
    once `go2rtc`/Frigate recovers).
  - When a camera is reported offline (`state != 1` or `0%` unplugged battery), `stopEncoder()` terminates the encoder
    and latches `OfflineState` so `go2rtc` and Frigate mark the camera stream offline instead of showing a misleading
    live feed (`AT-07`). On initial startup or after Frigate/`go2rtc` recovers, `seedOfflineCameraSnapshot()` briefly
    runs the encoder in keyframe-burst mode (`6s` `OFFLINE_SNAPSHOT_SEED_MS` once a `go2rtc` consumer attaches, capped
    at `30s` `OFFLINE_SNAPSHOT_MAX_WAIT_MS`) to push the last clean cached snapshot into Frigate before stopping again.

## Hardware Acceleration & Runtime Fallback (`BRIDGE_HWACCEL`, `buildVideoCodecArgs`)

- **Supported Hardware Modes (`ACTIVE_HWACCEL`, `HWACCEL_DEVICE`):**
  - `vaapi`: `-init_hw_device vaapi=va:<device> -filter_hw_device va -vf format=nv12,hwupload -c:v h264_vaapi
-async_depth 1 -bf 0 -qp 18`
  - `qsv`: `-init_hw_device qsv=hw:<device> -filter_hw_device hw -vf format=nv12,hwupload=extra_hw_frames=8 -c:v
h264_qsv -global_quality 19 -maxrate 3500k -bufsize 3500k`
  - `nvenc`: `-c:v h264_nvenc -preset p3 -tune ull -pix_fmt yuv420p -cq 19 -maxrate 3500k -bufsize 3500k`
  - `v4l2m2m`: `-c:v h264_v4l2m2m -pix_fmt yuv420p -b:v 3000k`
  - Software default (`""` / `disabled`): `-c:v libx264 -threads 2 -preset veryfast -tune zerolatency -pix_fmt yuv420p
-crf 19 -maxrate 3500k -bufsize 3500k`
- **Automatic `libx264` Fallback (`AT-18`):** If an `hwaccel` encoder exits within `5s` of spawn
  (`HWACCEL_FAIL_WINDOW_MS`) and its rolling `stderr` tail (`attachStderrTailCollector`) matches
  `HWACCEL_FAILURE_STDERR_REGEX` (`vaapi`, `qsv`, `nvenc`, `v4l2`, `hwupload`, `device`, `driver`, `Invalid argument`,
  `Function not implemented`), `cam.disableHwaccel()` disables hardware encoding for that camera, logs a `[WARN ]`
  with the `ffmpeg` root cause, and restarts on software `libx264` after `1s` (`HWACCEL_FALLBACK_RESTART_MS`).

## Per-Session `P2P` & `RTSP` Decoders (`src/media/decoder.js`)

- **Decoder Backpressure FSM (`DECODER_STATES`):** Each `Camera` tracks its active session decoder across
  `DETACHED -> HANDSHAKING -> DECODING (<-> PAUSED_BACKPRESSURE) -> FLUSHING_EOF -> DETACHED` (plus `* -> DETACHED`).
  Compressed `P2P` packets queue and drain via `enqueueOrWriteVideoPacket`, `enqueueOrWriteAudioPacket`, and
  `drainPendingDecoderInput`, while backfill RAM backpressure pauses/resumes `decoder.stdout` (`pauseDecoderStdout`,
  `resumeDecoderStdout`) so fast `.zxvideo` bursts never drop decoded frames.
- **Two-Pipe `P2P` Annex-B & Backfill Decoder (`startDecoder`, `buildP2pDecoderArgs`):**
  - Spawns `ffmpeg` with 5 stdio descriptors (`pipe:0` compressed `h264`/`hevc` video, `pipe:1` raw `YUV420p` stdout,
    `pipe:2` stderr tail, `pipe:3` raw `AAC` audio input, `pipe:4` decoded `s16le` mono PCM audio output).
  - Uses `-fflags +genpts -flags low_delay -probesize 32768 -analyzeduration 0` on `pipe:0` (deliberately omitting
    `+nobuffer` so `avformat_find_stream_info` retains the initial `32 KB` probed keyframe packets and never drops the
    opening ~1 second / Frame `0` of a backfill clip) and `-probesize 1024 -analyzeduration 0` on `pipe:3`.
  - Applies `-af asetpts=N/(SR*10)/TB` (`DEC_PCM_PTS_FILTER`) on `pipe:4` so `s16le` audio receives monotonic
    sample-counted timestamps without `aresample=async=1` discarding burst-downloaded backfill samples or deadlocking
    `pipe:3 -> pipe:4` when `pipe:1` rawvideo pauses under backpressure.
- **Keyframe Gate, In-Band Codec Switches & Clean EOF Tail Drain (`onVideo`, `flushDecoderInput`,
  `handleP2pDecoderExit`):**
  - Live `P2P` streams wait for an Annex-B keyframe parameter set (`isKeyPacket`: `HEVC` `VPS=32`/`SPS=33` or `H.264`
    `SPS=7` within the first `4 KB`) before spawning `ffmpeg` so the decoder never initializes on mid-GOP P-slices
    (backfill downloads spawn immediately on packet `0`).
  - If `videoEvent.metadata.videoCodec` switches mid-session (`H264` <-> `H265`), `onVideo()` stops and respawns the
    decoder (`initiator=camera-stream`); in-band resolution changes update `updateStreamFormat` without restarting.
  - On `'download finished'`, `flushDecoderInput()` closes `pipe:0` and `pipe:3` (`markDecoderInputEnded`) so `ffmpeg`
    flushes trailing reorder-buffer frames to `pipe:1` before exiting. If `decoder.stdout` is still open or paused when
    the process `'exit'` event fires (`shouldDeferDecoderDetachOnExit`), `handleP2pDecoderExit()` resumes `stdout` and
    waits for `stdout` `'close'` before detaching so buffered tail frames finish draining. Forced `stopDecoder()` calls
    send `SIGTERM` followed by a `2s` `SIGKILL` timer (`DECODER_SIGKILL_DELAY_MS`).
- **`HomeBase` & Direct `RTSP` Pull Decoder (`startRtspDecoder`, `buildRtspDecoderArgs`, `buildRtspVideoFilter`):**
  - Pulls TCP `RTSP` (`-rtsp_transport tcp -timeout 5000000 -probesize 524288 -analyzeduration 1000000`) with URL
    fragments stripped (`stripRtspUrlFragment`) and optional audio mapping (`0:a:0?`).
  - Prepends a non-duplicating Bresenham VFR `select` filter (`buildRtspVideoFilter`) ahead of Lanczos scaling/padding
    (`buildScaleFilter`, `0x1c1c1c` pillarbox/letterbox bars when `preserve_aspect_ratio: true`) so `20/25/30 fps`
    cameras are decimated to `<= LIVE_FPS` before rawvideo output while `<= LIVE_FPS` feeds (such as `10 fps` IR night
    vision) pass through untouched with zero Frame `0` lookahead delay.
  - Retries exited `RTSP` handshakes every `750ms` (`RTSP_RETRY_DELAY_MS`, or exponential backoff up to `15s` on spawn
    errors) and notifies `rtspDropCallback` immediately when an established or direct `RTSP` stream drops.

## Zero-Allocation Hot-Path Buffers & Snapshot Persistence

- **`StatusCard` & Overlay Scratch Rings (`src/domain/status-card.js`, `src/overlay/yuv-canvas.js`):** `StatusCard`
  pre-allocates `asleep` (`1.38 MB` `FRAME` `YUV420p` at `1280x720`) at construction, lazy-allocates `waking`, `busy`,
  and the 2-slot `liveOverlayBufs` ring on first use, and mutates them in place on card redraws; `yuv-canvas.js` reuses
  module-level `blurScratch`, `regionScratch`, and `bgCanvasScratch` planes.
- **Decoder & Playback Frame Pools (`src/domain/camera/stream-session.js`, `backfill-state.js`):**
  `attachDecoderStreams()` chunks `pipe:1` reads into one reusable `1.38 MB` `cam.decoderReadBuf` per camera; live
  frames alternate across a 2-slot `cam.liveFrameRing`, Wi-Fi/TCP decode bursts queue up to `12` frames in
  `cam.liveFrames`, and `.zxvideo` downloads (up to `120s` / `MAX_DOWNLOAD_BUFFER_SECS`) recycle buffers through a
  bounded `cam.downloadFramePool` (capped at `32` reusable buffers) so steady-state streaming performs zero `1.38 MB`
  heap allocations.
- **O(1) PCM `AudioQueue` (`src/domain/camera/audio-queue.js`):** Caps queued PCM at `1s` for live streams (`120s`
  during backfill downloads), slices exact `AUDIO_CHUNK` subarrays from the head chunk without `Buffer.concat`, and
  copies into a single reusable `outBuf` only when a `100ms` tick straddles two chunks (returning `SILENCE` while muted
  before backfill Frame `0` or when underflowed).
- **Async Snapshot Cache (`src/overlay/snapshot-cache.js`):** Decodes cached `JPEG` files (`last_<name>.jpg`, or
  `last_<name>_<serial>.jpg` when `name !== serial`, migrating legacy `last_<name>_<name>.jpg` files) in parallel
  background `ffmpeg` processes at startup with kill timeouts, and persists clean un-overlayed `JPEG` snapshots on
  session stop via atomic temp-file renames (`TMPDIR` fallback if `BRIDGE_CACHE_DIR` is unwritable).
