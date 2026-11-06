# 15. Missing Initial Backfill Frames, Choppy Audio & Clip Gaps

- **Scope:** Missing Initial `~1.07s` (`16` Frames), Choppy Audio & Back-to-Back Clip Gaps on Backfilled Clips, Live
  Burst Frame Drops, and `"backfill"`-Mode `RTSP` Live View vs. Hardware `RTSP` Start Hijacking

- **Cause 1 (`-fflags +genpts+nobuffer` Discarding the First `32,768` Bytes / `~16` Frames Including the Initial
  `t=0` IDR Keyframe During `avformat_find_stream_info` & Premature `dec.on('exit')` Detach):**
  `FfmpegArgsBuilder.withLowLatencyFlags()` passed `-fflags +genpts+nobuffer` alongside
  `-probesize 32768 -analyzeduration 0 -f h264 -i pipe:0` in `buildP2pDecoderArgs()`. In `ffmpeg`
  (`libavformat/demux.c`), `AVFMT_FLAG_NOBUFFER` (`+nobuffer`) causes `avformat_find_stream_info()` to free and
  discard all packets read during the `32,768`-byte probe instead of retaining them in `ic->packet_buffer`. For a
  `15 fps` `.zxvideo` stream (`~300 kbps`), those first `32,768` bytes contained the first `~16` frames (`1.07s`) of
  the clip - **including the initial IDR keyframe (`Frame 0` at `t=0.0s`)** - causing the `H.264` decoder to drop all
  subsequent P-frames until the second IDR keyframe arrived at `Frame 16` (`t=1.07s`). Additionally, calling
  `cam.detachDecoder()` immediately in `dec.on('exit')` while `dec.stdout` was paused at
  `DOWNLOAD_FRAME_HIGH_WATERMARK` (`30` frames) detached the decoder before buffered tail frames finished draining.
- **Cause 2 (Choppy/Dropped Backfill Audio from `-use_wallclock_as_timestamps 1` + `aresample=async=1` &
  `PAUSED_BACKPRESSURE` Audio Stalls):** During a `.zxvideo` backfill download, `HomeBase 3` transfers `30s` of
  compressed `AAC` audio in `~3.5s` of wall-clock time. Passing `-use_wallclock_as_timestamps 1` on `pipe:0`/`pipe:3`
  in `buildP2pDecoderArgs` stamped `30s` of `AAC` packets with `~3.5s` of wall-clock `PTS`, causing
  `-af aresample=async=1:first_pts=0` to delete `> 90%` of the audio samples to compress `30s` of audio into `3.5s`
  of wall-clock `PTS`. Simultaneously, `enqueueOrWriteAudioPacket` stopped writing `AAC` packets to `dec.stdio[3]`
  whenever `decoderStdoutPaused` (`PAUSED_BACKPRESSURE` on `pipe:1` rawvideo) was true, and `ffmpeg`'s internal
  `choose_output()` scheduler paused `pipe:3 -> pipe:4` audio whenever `ost[1]->cur_dts` (audio) reached
  `ost[0]->cur_dts` (video at `30` buffered frames).
- **Cause 3 (Back-to-Back Backfill Clip Gap During `DRAINING_BACKFILL_TAIL`):** On `HomeBase 3`,
  `station.database_query_by_date` only returns date summary counters (`{count,oday}`), whereas
  `station.database_query_latest_info` returns the actual latest `.zxvideo` record path per camera. While Clip 1 was
  draining decoded frames from RAM (`DRAINING_BACKFILL_TAIL`) after a second clip triggered and cleared, skipping
  `station.database_query_latest_info` or waiting until Clip 1 finished playing (`+2.5s` `postPlaybackHoldMs`) burned
  query attempts and caused a `~7-8s` gap between Clip 1 and Clip 2. Furthermore, with Eufy PIR sensors reporting
  `state: false` after `~10.1s` while the camera continues recording its `30s` clip (`~20s` after `clearedAt`), `6`
  query attempts (`24s` window) could expire before `HomeBase 3` finished indexing the file.
- **Cause 4 (Live `RTSP`/`P2P` Multi-Frame TCP Burst Drops & `inBurst` Duplicate Writes):** Writing live decoded
  `1.38 MB` frames directly to `enc.stdin` (`64 KB` Linux pipe) dropped intermediate frames whenever 2-4 frames
  arrived in a single Wi-Fi/TCP burst while `enc.stdin.writableNeedDrain` was true, and including
  `(!this.isBackfillPlayback() && inBurst)` in `Camera.shouldWriteEncoderFrame` flooded duplicate live frames on
  every `67ms` tick and pipe `drain` event during keyframe burst windows.
- **Cause 5 (`RTSP` Cameras in `"backfill"` Mode Failing Live View When `use_rtsp` Was Disabled, Doorbell
  `rtspStream` Hijacking `P2P` Live View, and Hardware `'rtsp livestream started'` Hijacking `"backfill"` Motion Into
  Live `RTSP`):** Disabling `useRtsp` (`rtspStream: false`) on an `RTSP`-capable camera in `"mode": "backfill"`
  cleared `rtspStreamUrl` in `eufy-security-ws` while the sleeping camera firmware remained in NAS/RTSP mode;
  conversely, enabling `rtspStream: true` on a non-RTSP doorbell in `"mode": "backfill"` caused `HomeBase 3` to emit
  `'rtsp livestream started'` during `WAKING_P2P` Live View and send zero `P2P` video packets while
  `onEvent('rtsp livestream started')` ignored the event, and `Camera.terminateSession` then falsely marked the
  responsive doorbell offline (`wakeTimedOutOffline`) on watchdog timeout. Furthermore, when an `RTSP`-capable
  camera in `"mode": "backfill"` detected PIR motion to record a native `.zxvideo` clip to `HomeBase 3`, the
  hardware simultaneously emitted `'rtsp livestream started'`; adopting `'rtsp livestream started'` on an `IDLE`
  camera hijacked the `"backfill"` camera into a live `RTSP` session (which then canceled `pendingBackfill` after
  `5s`), whereas calling `device.stop_rtsp_livestream` on an `IDLE` `RTSP`-capable camera would abort the hardware
  clip recording on `HomeBase 3`.
- **Fix:** Replaced `-fflags +genpts+nobuffer` with `-fflags +genpts` in `FfmpegArgsBuilder.withLowLatencyFlags()` so
  `ffmpeg` retains all `32 KB` probed packets in `ic->packet_buffer` and decodes from the true initial keyframe
  `Frame 0` (`t=0.0s`) with zero dropped frames (`450 -> 450`); extracted `handleP2pDecoderExit` so `cam.dec` stays
  attached until paused `dec.stdout` buffers drain and close; removed `-use_wallclock_as_timestamps 1` from
  `buildP2pDecoderArgs`, lowered `P2P_AUDIO_PROBESIZE_BYTES` to `'1024'`, replaced `'aresample=async=1:first_pts=0'`
  with `DEC_PCM_PTS_FILTER = 'asetpts=N/(SR*10)/TB'` in `FfmpegArgsBuilder.withS16leAudioOutput` (assigning strictly
  monotonic sample-counted `PTS` with zero sample dropping while keeping audio `cur_dts` below video `cur_dts` so
  `ffmpeg` decodes `100%` of `pipe:3 -> pipe:4` audio continuously even while `dec.stdout` is paused at `30` video
  frames), and updated `Camera.enqueueOrWriteAudioPacket` so compressed `AAC` packets write directly to
  `dec.stdio[3]` without blocking on `this.decoderStdoutPaused`; added `Camera.needsLatestInfoBackfillQuery()`,
  `isStationIdleForBackfill(..., allowDrainingSelf = true)`, `backfillContinuation`, and
  `BACKFILL_MAX_QUERY_ATTEMPTS = 10` (`40s` query window) so Clip 2 is queried via both `database_query_by_date` and
  `database_query_latest_info` while Clip 1 drains from RAM and transitions immediately into Clip 2 while holding
  Clip 1's final frame (`B`); added bounded live burst frame buffering (`cam.liveFrames`, `bufferLiveFrame`,
  `consumeNextLiveFrame`) and removed `(!this.isBackfillPlayback() && inBurst)` from `shouldWriteEncoderFrame` when
  `isLive` is true; preserved `useRtsp: true` by default in `"backfill"` and `"custom"` modes for `RTSP`-capable
  cameras while excluding non-RTSP doorbells (`Camera.isDoorbell()`) and recovering from unexpected hardware `RTSP`
  starts during `WAKING_P2P` (`Camera.evaluateUnexpectedRtspStart()`, guarded by `this.unexpectedRtspActive` so stray
  `RTSP` recovery runs at most once per session, disabling `rtspStream: false`, stopping the stray `RTSP` stream, and
  restarting `P2P` Live View on non-RTSP/P2P sessions while leaving `RTSP`-capable cameras untouched in
  `IDLE`/`DOWNLOAD`) without marking responsive devices offline on wake timeout (`markDeviceHeardInSession()`); updated
  external stream handling (`AT-01`, `AT-02`, `AT-03`, `AT-05`) so `"backfill"` cameras queue/extend `BackfillJob` on
  idle hardware `RTSP` starts and piggyback on standalone Eufy app `P2P` Live Views while `"rtsp"`, `"p2p"`, and
  `"auto"` cameras adopt external `RTSP`/`P2P` wakes outside the `3s` post-sleep guard; and added `card_theme: "debug"`
  (`832x76` bottom diagnostic HUD with `FRAME_STAGE_MARKERS` `S`/`FB`/`B`/`L` and 4 fixed-width real-time telemetry
  rows) alongside `GET /api/config` (`buildConfigPayload`).
