# Stream lifecycle, priorities, RTSP, backfill, and multi-station rules

Read when: changing wake, arbitration, RTSP, P2P, backfill download, hold extension, or the HTTP wake API.
Related: [ACCEPTANCE.md](ACCEPTANCE.md) section 3.1 concern map (`AT-01`..`AT-04`, `AT-15`, `AT-16` backfill;
`AT-05`, `AT-06`, `AT-08` `RTSP`/`P2P` wakes; `AT-06`, `AT-13` arbitration; `AT-09`, `AT-14` Live View; `AT-11`,
`AT-12` holds/caps; `AT-17` `/api/wake`), [architecture.md](architecture.md).

## Stream Lifecycle, Event Priority, RTSP, Backfill & Multi-Station Rules

- **Per-Station P2P Stream Arbitration (`arbitrate`, `getStationKey`):** Eufy HomeBase stations multiplex one active P2P
  stream (`activeMode === 'p2p'` or `'download'`) at a time per `stationSerial`. Standalone Wi-Fi cameras/doorbells
  (`stationSerial === cam.serial`) and multiple HomeBase stations are arbitrated independently with per-station
  transition locks (`stationTransitions`), allowing concurrent P2P streaming across distinct stations. Station wake
  pacing (`STATION_WAKE_PACING_MS = 2500ms`) spaces consecutive wake START commands on the same station to avoid
  radio collisions, but when a station P2P slot is released by a stopped session, any waiting camera on that station
  starts immediately with zero pacing delay (pacing still applies to external `/api/wake` requests and RTSP wakes).
- **HomeBase Native RTSP Ingestion (`use_rtsp`, `startRtspStream`, `startRtspDecoder`):** Automatically discovers
  `rtspStreamUrl` from `device.get_properties` on cameras with NAS/RTSP support, wakes the camera via
  `rtspStream=true` and `device.start_rtsp_livestream`, and streams them in `activeMode = 'rtsp'` concurrently
  alongside P2P cameras (`usesP2pSlot() === false`). Retries RTSP connection every `750ms` during the wake window,
  preserves active `ffmpeg` handshakes (`isRtspDecoderHandshaking`, `400ms..7500ms`), re-sends `start_rtsp_livestream`
  every `10s` (`DEFAULT_RTSP_RETRY_MS`, up to `5` retries, so a retry never restarts the camera's `7-8.5s` cold wake)
  when idle, immediately re-wakes (`0ms`, or `750ms` if `lastStartAt` was within `2s`, extending `motionUntil` to at
  least `20s`) on mid-session clip boundary drops, and sleeps cleanly after `25s`
  (`initiator=error/rtsp-wake-timeout`) without falling back to `P2P`.
- **Standalone Direct RTSP Ingestion (`rtsp_url`, `beginRtspDirectProbeSession`, `recordRtspDirectProbeFailure`):**
  When explicit `rtsp_url` is set on a camera (`mode: "rtsp"` or `"auto"`), pulls `RTSP` video/audio directly from
  `rtsp_url` without `eufy-security-ws` RPCs or WS event subscriptions,
  passively probing every `5s` while idle (`initiator=rtsp-direct-probe`) and immediately connecting on viewer attach
  (`connecting direct RTSP stream`, never ignored or logged as `multi-camera dashboard grid view`, while keeping the
  `Asleep` or `Disconnected` card displayed until Frame 0 decodes), bypassing all session timeouts (`hold_secs`,
  `view_linger_secs`, `stream_max_secs`, `view_max_secs`, `idle_timeout_secs`, `view_cooldown_secs`, and Frigate hold
  polls) so active feeds stream continuously until the `RTSP` connection ends or drops, and distinguishing reachable
  standby (`404 Not Found` -> `Asleep` White) from unreachable/powered-off (`Connection refused` / timeout ->
  `Disconnected` Grey) while keeping the persistent `5 fps` snapshot encoder running.
- **Post-Event Clip Download Backfill (`backfill_enabled`, `backfill_only`, `processBackfillQueue`,
  `handleDatabaseQueryResult`):**
  - **Queueing & Priority Upgrade:** Triggered when a camera's station P2P slot is busy, an RTSP wake fails, a live
    stream stops before capturing `20%` of the configured clip/hold duration (`getSustainedLiveVideoCutoffMs()`, clamped
    to `3s..15s`), an active event-driven live session is preempted early before `motionUntil` (`AT-13`), or the camera
    uses `"backfill"` mode (`shouldBackfillOnlyOnEvent`). `queueEventBackfill` upgrades `pendingBackfill` in-place via
    `upgradeEvent` when companion `"person"`/`"identity person"`/`"ring"` events arrive after `"motion"`, and cancels
    the safety-net `pendingBackfill` only after `getSustainedLiveVideoCutoffMs()` (`20%` of hold/clip duration, clamped
    to `3s..15s`) of sustained live video (re-queuing `pendingBackfill` in `terminateSession` if the session is later
    preempted mid-event).
  - **Multi-Trigger Settlement & Per-Station Isolation:** `BackfillJob` tracks all active `state: true` trigger
    properties (`activeEvents`) so an early `state: false` on one companion property never marks recording finished
    early; `isReadyToQuery` waits `4s` (`BACKFILL_POST_CLEAR_SETTLE_MS`) after **all** active trigger properties clear
    (`markRecordingCleared`, or up to `Math.max(35000, holdMs + 4000)`, hard-capped at `124s` /
    `BACKFILL_MAX_TOTAL_RECORDING_WAIT_MS` = Eufy's `120s` max hardware clip length `+ 4s` settle from initial trigger
    `this.at`). Station P2P idle and `backfill_delay_secs` (`2s`) cooldown checks are scoped per station across non-RTSP
    P2P cameras (`isStationIdleForBackfill`). The post-viewer cooldown (`view_cooldown_secs`) only guards pure viewer
    re-wakes and is bypassed whenever a Eufy hardware trigger is active.
  - **Chronological Multi-Clip Query & Paced Playback:** Connects via `station.connect`, queries
    `station.database_query_by_date` and `station.database_query_latest_info` (via `needsLatestInfoBackfillQuery()`, up
    to `10` attempts / `BACKFILL_MAX_QUERY_ATTEMPTS`, including in the background while a previous clip is draining from
    RAM in `DRAINING_BACKFILL_TAIL`), queues matching `.zxvideo` clips chronologically (`oldest -> newest`, scheduling a
    follow-up query via `needsFollowUpClipQuery` if post-trigger activity extended `>= 15s` past the clip), retains
    initial `32 KB` decoder probe packets (`-fflags +genpts`) and sample-counted audio `PTS`
    (`asetpts=N/(SR*10)/TB`), keeps the sleeping snapshot flowing during the download handshake and immediately plays
    out `Frame 0..N` (up to `120s` / `MAX_DOWNLOAD_BUFFER_SECS` of video/audio) at `15 fps` (`LIVE_FPS`) via
    `device.start_download` (`activeMode = 'download'`, `initiator = 'bridge-backfill'`), waits `800ms`
    (`BACKFILL_SNAP_DELAY_MS`) after `firstFrameAt` before filing the Frigate event, flushes the decoder
    (`flushDecoderInput`) on `'download finished'`, holds the final frame for `2.5s`
    (`DEFAULT_DOWNLOAD_POST_PLAYBACK_HOLD_MS`, or `0ms` while preserving the final frame across back-to-back clip
    continuation handshakes), and scales Frigate's event `duration` (`getEffectiveEventDurationSecs`). Any live `P2P`
    motion/event request immediately preempts an active in-transfer download (`!downloadFinished`,
    `initiator = 'bridge-arbitrator/live-over-download'`), whereas viewer-only wakes never preempt an active backfill
    download (`isUrgentBackfillProtectedFrom`), and once the `HomeBase 3` transfer completes (`downloadFinished: true`,
    draining from RAM), the camera releases the station `P2P` channel (`isOccupyingStationP2pChannel() === false`).
- **Camera & Event Priority Tiers (`getEffectivePriority`):** Combines per-camera `priority` from `config.yaml` with
  built-in `EVENT_PRIORITIES` (`ring`: `+1000`, `identity person`: `+300`, `person`/`stranger`/`loitering`: `+200`,
  `package`: `+150`, `vehicle`/`pet`/`dog`: `+100`, `crying`/`sound`: `+50`, `radar`/`motion`: `+10`, plus optional
  `event_priorities` overrides and `+250` `API_WAKE_EVENT_PRIORITY` for `/api/wake`). Companion events arriving while a
  camera is already live automatically upgrade `cam.eventPriority` in-place.
- **Zero-Dwell Event Switching:** Higher-priority events (`pickScore > curScore`,
  `initiator=bridge-arbitrator/higher-priority-event`) and newer events on equal-priority cameras
  (`pickScore === curScore`, `initiator=bridge-arbitrator/newer-motion` when `view_has_priority` is `true`, or once the
  active camera's motion has cleared or stalled `>= 8s` without video) preempt the active camera immediately with a
  `250ms` P2P handover settle delay. Lower-priority cameras (`pickScore < curScore`) are blocked from preempting an
  active higher-priority event until its motion clears (`motionClearedAt > lastMotionAt`) or stalls (`>= 8s` without
  video).
- **Drain-Aware & Burst-Paced Frame Pipeline (`live_fps: 15`, `idle_fps: 5`):** Multi-frame live TCP decode bursts are
  buffered in `cam.liveFrames` (`bufferLiveFrame`, `consumeNextLiveFrame`) and drained both on the `15 fps` ticker and
  immediately on decoded frame arrival (`handleDecodedRtspFrame`, `handleDecodedP2pFrame`) so continuous `15 fps`
  streams never drift into a standing queue backlog, while `RTSP` pull decoders decimate `> 15 fps` inputs via a
  non-duplicating Bresenham VFR `select` filter (`buildRtspVideoFilter`), live viewer keyframe bursts (`inBurst`) pace
  encoder writes at `15 fps` for sub-second `MSE` keyframe attach, and `enc.stdin.on('drain')` immediately flushes any
  pending `cam.frameNew` frame that arrived while the `1.38 MB` raw YUV420p pipe buffer was full.
- **Immediate Snapshot Persistence (`lastFrame`, `/config/cache`):** `cam.lastFrame` and `cam.telemetry.lastSeen` update
  in RAM on the first decoded frame of every live/backfill session (`lastFrame` also updates after `2s` on first-boot
  `startup_snapshot` probes). Clean un-overlayed `JPEG` frames are persisted to
  `/config/cache/last_<name>_<serial>.jpg` when a session that decoded video (or is not a passive `rtsp-direct-probe`
  without video) stops (`stop()`, falling back to `os.tmpdir()` / `TMPDIR` if `BRIDGE_CACHE_DIR` is unwritable)
  so container restarts never need to wake cameras that already have a cached snapshot. While
  `cam.active && cam.gotVideo`, the encoder holds `cam.frame || cam.lastFrame` so preempted or stopping streams never
  flash the pre-stream `waking` card.
- **External Stream Adoption (`initiator=eufy-ws`) & HTTP Server (`BRIDGE_HTTP_PORT`, `startHttpServer`,
  `wakeCameraExternal`):** `RTSP` and `P2P` wakes initiated externally through `eufy-security-ws` while inactive
  outside the `3s` post-sleep guard (`adoptExternalRtspWake`, `adoptExternalP2pWake`) are adopted for
  `getEventHoldMs()` / `holdMs` with Frigate event recording (`eventActive = true`, except in `"backfill"` mode where
  `'rtsp livestream started'` and trigger-paired `'livestream started'` backfill instead). The HTTP server exposes
  `POST/GET /api/wake` and `/api/wake/:cameras` (resolving `name`, `serial`, slugified `title`, comma-separated lists,
  and `all`, failing atomically with `404 CAMERA_NOT_FOUND` on any unknown token, rejecting direct `rtsp_url` cameras
  with `422 UNSUPPORTED_OPERATION` when targeted exclusively or skipping them as `status: "unsupported"` in mixed/`all`
  lists, validating URL encoding, JSON bodies `<= 16 KB`, `duration`/`create_event`/`reason`, HTTP methods `405`, and
  shutdown/WS/all-offline `503` states, with `RTSP`-first ordering, `2500ms` per-station pacing, burst coalescing, and
  `create_event: true` by default), `GET/HEAD /api/config` (`buildConfigPayload` exposing build `version`, Git `commit`,
  and sanitized effective runtime config with `null` for inapplicable fields), and `GET/HEAD /health` + `/healthz`
  (container `HEALTHCHECK` liveness probe returning `200` when running and not shutting down, with `ws_connected`
  reported in the payload for diagnostics rather than triggering restarts on external service outages).
- **HomeBase Reboot & Wi-Fi Outage Self-Healing:** On initial `start_listening`, the bridge verifies `driver` and
  `station` connectivity (`driver.is_connected`, `station.is_connected`) and dispatches `driver.connect` and
  `station.connect` whenever disconnected. `onEvent` handles `source === 'station'` events (`close`, `connection error`,
  `connect`), cleanly stopping active streams on that station (`initiator=error/station-disconnect`), scheduling
  periodic `station.connect` retries while disconnected, and resetting one-time hardware sync flags on reconnect so
  dropped property writes and missing `rtspStreamUrl` values are re-synchronized. If `driver.poll_refresh` fails or
  times out, the bridge skips stale cached property reads and recycles `driver.connect` and
  `station.disconnect -> station.connect` (`60s` cooldown when no station video is active). On `'rtsp livestream
started'` or `RTSP` wake retry 1, the bridge ensures the station is connected and immediately toggles
  `rtspStream: false -> true` when `rtspStreamUrl` is empty so `HomeBase` regenerates the URL; on `P2P` wake retries or
  unresponsive wake timeouts, it recycles zombie station `P2P` sessions (`60s` cooldown) while suppressing
  self-inflicted station disconnect events, and ignores spurious `'rtsp livestream started'` events on cameras already
  streaming `P2P` video.
