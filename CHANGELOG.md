# Changelog

Finished work, newest first. Open work lives in [docs/TODO.md](docs/TODO.md).

## dev

- Return an unknown activity status when `Frigate` event queries time out or fail so outages neither extend battery
  camera holds to their maximum duration nor trigger premature early sleep
- Soft-validate the `Frigate`, `go2rtc`, and `eufy-security-ws` versions on startup and log a warning without blocking
  readiness when a service is older than supported
- Align the stored Wi-Fi signal tier with the rounded status card reading, clear stale signal readings when a camera
  reports itself shut off, log refused state-machine transitions at debug level, guard version handshakes, and clear
  background timers on shutdown
- Split configuration, camera sub-models, station state, upstream clients, and stream orchestration into focused
  modules with encapsulated state, explicit log scopes, and reference guides for the media pipeline and upstream
  integrations
- Mirror the source hierarchy across isolated unit tests, split the locked acceptance and numbered regression suites
  into one-file-per-case directories, replace fixed test waits with fake timers, scope `CI` workflow permissions, and
  tighten commit, coupling, and hygiene checks
- Keep the bridge responsive while camera snapshots are decoded at startup and saved when a stream ends by running
  `ffmpeg` in the background with a kill timeout, decoding all snapshots in parallel, and writing each snapshot to a
  temporary file first so a failed or killed save never corrupts the previous one
- Detect Frigate Live View viewers with a single `go2rtc` request per poll for all cameras instead of one request per
  camera, so a slow or unreachable `go2rtc` no longer multiplies wake-detection delay by the camera count, and warn once
  when `go2rtc` answers with an unusable stream list instead of silently missing viewers
- Remove the duplicated container health check from the example `Compose` file so the image remains its only
  definition, and fail the documentation check when any `Compose` file defines one again
- **BREAKING:** Validate configuration value types, integer fields, service URL schemes, runtime log and
  hardware-acceleration modes, and unique safe camera identities at startup, and require a live post-validation process
  marker when the `HTTP` listener is disabled so invalid configurations never report healthy
- **BREAKING:** Simplify container health checks to return an immediate, dependency-free liveness response as soon as
  the `HTTP` listener binds on startup, removing `WebSocket` status from the health payload and shortening the
  container probe interval so services exit the starting state promptly
- Expose full upstream service, `HomeBase` station, stream session, encoder, viewer, backfill, and live sensor telemetry
  details on the runtime status endpoint while keeping the container health endpoint lightweight for frequent probes
- Surface root-cause `ffmpeg`, `RTSP` handshake, snapshot cache, `HTTP`, `WebSocket`, and `Eufy` command errors in logs
  instead of masking them behind generic `ffmpeg` exit footers, bare `fetch failed` or blank dual-stack socket errors,
  truncated validation responses, or generic stop reasons
- Deduplicate snapshot cache filenames whenever a camera's hardware serial matches its stream name, and automatically
  migrate existing duplicated cache files on startup
- Preserve the matched clip's hardware detection label and recognized person when extending long backfill `Frigate`
  events after transfer completion, even when an external wake request customized the event reason
- Serialize `HomeBase` backfill queue steps and pace database lookups per station across sibling cameras while allowing
  multiple `HomeBase` stations to query and download clips independently
- Abort in-flight `Frigate` event snapshot waits when a backfill download or live wake ends without decoded video so
  failed or preempted attempts do not post duplicate stale-snapshot events
- Preserve queued follow-on backfill jobs and active clip playback when an earlier backfill query expires or exhausts
  its database lookup attempts
- Allow sibling cameras on the same `HomeBase` to query and download backfill clips as soon as an earlier clip finishes
  transferring and is draining buffered frames from memory
- Allow `HomeBase` backfill clips up to `120s` to play to completion without being cut off by shorter live stream
  maximum duration caps
- Require at least one decoded video frame before treating a `HomeBase` backfill clip download as completed, timing out
  and retrying truncated or stalled transfers that only deliver un-decodable packets
- Preserve chronological event ordering across all camera modes when motion, hardware `RTSP` starts, or external wake
  requests arrive during active clip backfill playback, queuing follow-on clips or deferring full-duration live wakes
  until the current clip finishes
- Preserve settled clip queries, follow-up split-clip retry budgets, and flowing decoder tail frames across
  back-to-back `P2P` backfill downloads without matching incomplete in-progress recordings
- Expire stale hardware trigger state when clear events are lost or connections drop, reject timestamp-less clip
  records across timezones, tighten backfill state transitions, and log failed backfill query and cancel commands
- Enforce immutable released changelog sections, a post-release `dev` heading, and builder-stage container test
  isolation

## v0.0.2

- **BREAKING:** Detach the project from the original fork into a standalone codebase following a full code redesign
- **BREAKING:** Replace JSON configuration (`config.json`) with commented `config.yaml` (validated against the updated
  `YAML` schema), and fail fast in production when `config.yaml` is missing
- **BREAKING:** Move service endpoints and container runtime settings into prefixed environment variables (`BRIDGE_*`,
  `EUFY_WS_*`, `FRIGATE_*`, `GO2RTC_*`, `HA_WEBHOOK_URL`), rejecting service/runtime keys in `config.yaml` alongside
  removed keys (`$schema`, top-level `backfill_only`, `homebase_rtsp_url`, `rtsp_output_url` replaced by
  `rtsp_publish_url` / `GO2RTC_RTSP_URL`, and unprefixed `HTTP_PORT`)
- **BREAKING:** Reject invalid port environment variables and unset, malformed, or unclosed `${...}` placeholders at
  startup without exposing secrets (requiring `$${...}` for literal placeholders)
- **BREAKING:** Rename `card_theme` presets `icons` and `debug` to `minimal` (new default) and `hud`, remove
  `detailed` (unknown values warn and default to `minimal`), switch healthy `Asleep` indicators from green to calm
  white, hide temperature and last-active icons by default, raise the default low-battery threshold from `20%` to `30%`,
  and add a configurable `5%` purple critical battery threshold (`0 < critical < low <= 99%`)
- **BREAKING:** Fail `/api/wake` requests atomically with `404` when any comma-separated target is unknown, return
  `400` / `405` / `413` / `422` JSON errors for invalid inputs, unsupported methods, oversized bodies, or direct
  `RTSP`-only targets, and report `200` on `/healthz` during external outages or disabled HTTP listeners (`503` only on
  shutdown; check `ws_connected` in the response payload for WebSocket state)
- Redesign status cards with a backgroundless pill-and-dots `minimal` indicator, borderless smoked-obsidian `glance`
  capsules, circular `pebbles`, and a matte-slate diagnostic `hud` overlay across all seven card positions, featuring
  Lucide status and power-badge icons, sky-blue charging fills, scaled `hud` timers past `999s` through years, immediate
  `Disconnected` cards on startup even while `eufy-security-ws` is booting or unreachable, and refreshed `README`
  theme previews
- Support direct camera `RTSP` URLs for Eufy Baby (`E20` / `E21`) and standalone `RTSP` cameras without querying
  `eufy-security-ws`, streaming continuously without session timeouts, keeping active and idle feeds responsive in
  Frigate dashboard grids, maintaining cached sleeping snapshots, status cards, and automatic Frigate masks across
  camera power cycles, and warning on ignored options
- Keep camera `RTSP` streams online across `eufy-security-ws` and bridge restarts without restarting Frigate by
  preserving deep-standby cameras before initial battery telemetry arrives, keeping outbound `RTSP` encoders running
  while WebSocket, cloud-driver, and HomeBase connections recover, and separating `go2rtc` connectivity tracking from
  Frigate API health recovery
- Harden wake arbitration, battery swap recovery, and backfill downloads by recovering offline low-battery cameras
  after a `10%+` swap even within the low-battery threshold, scoping viewer-triggered offline HomeBase refreshes
  strictly to cameras gaining new single-camera live viewers, ignoring trailing hardware stream-start events within the
  `3s` post-sleep guard in backfill mode, upgrading queued or active backfill priority on mid-backfill external
  pre-wakes, protecting active clip downloads from view-only clears while preserving download state across queued clips,
  and canceling delayed wakes cleanly on WebSocket disconnect
- Redact embedded stream credentials containing `@` characters and escape line breaks in structured logs and `FFmpeg`
  error summaries, reconnect automatically with clean outage and recovery transitions while quieting repetitive retry,
  database query, and sub-step chatter at the default `info` level, and document health check behavior and non-root
  cache directory ownership (`UID` `1000`) in `README`
- Smooth Frigate multi-camera dashboard grid and continuous live streaming by sending `15 fps` keyframe bursts when new
  live viewers attach, draining due live frames immediately on decode to prevent drift lag, and capping `> 15 fps`
  `RTSP` camera feeds without duplicating low-rate night-vision frames
- Reduce multi-camera memory usage, harden `FFmpeg` process management, and improve test isolation by capping worker
  threads, input packet queues, `RTSP` probe sizes, and hardware frame pools, allocating status-card and live-frame
  buffers lazily, reusing a single per-camera decoder read buffer, bounding clip history and stalled queues, releasing
  settled transitions, preventing unspawned child handles from signaling the process group, backing off spawn errors,
  handling null-prototype test runner errors, and isolating test cache files
- Align the container runtime image with `Node.js` `22`, commit an `npm` lockfile for deterministic dependency installs,
  and enforce package, lockfile, and changelog release heading parity on tagged commits

## v0.0.1

- Add GitHub Actions continuous integration and container publishing for pull request verification, main-branch `dev`
  image builds, and versioned plus `latest` release images on GitHub Container Registry
- Recover automatically from Wi-Fi outages and wedged `HomeBase` sessions by reconnecting disconnected cloud drivers and
  stations on startup, refresh timeouts, and wake retries, recycling unresponsive station links without aborting sibling
  wakes, and regenerating missing `RTSP` stream addresses
- Replay `HomeBase 3` recorded clips from the opening frame at `15 fps` with sample-counted audio, chronological
  multi-clip queuing, background follow-up queries, mobile app stream isolation, and automatic download retries
- Support per-camera operating modes (`auto`, `rtsp`, `backfill`, `p2p`, and `custom`) with automatic Eufy Power Manager
  synchronization, parallel `HomeBase` `RTSP` streaming, priority-based `P2P` arbitration, and zero-delay same-station
  camera switching
- Extend active streams and Frigate event recordings across motion, AI, doorbell ring, radar, crying, and end-of-hold
  Frigate object detections while adopting external Home Assistant and Eufy mobile app wakes
- Conserve battery and reflect device availability by pausing a camera stream when its battery depletes or the device
  goes offline, resuming automatically on recharge or battery swap, shortening holds on low battery, blocking background
  polls and post-sleep trailing packets from waking sleeping cameras, and offering opt-in experimental stuck-spotlight
  protection
- Render frosted-glass status cards (`icons`, `minimal`, and `detailed`) and a live `debug` diagnostic `HUD` purely in
  JavaScript with anti-aliased text and Eufy-style icons, a 6-color palette (`Green` asleep vs `Grey` disconnected),
  persistent clean snapshots, and automatic Frigate motion and object masks
- Add a built-in `HTTP` server for container readiness checks, runtime configuration inspection, and paced external
  camera pre-wakes alongside Home Assistant webhook notifications and recognized face names
- Simplify configuration to require only the Eufy WebSocket URL, Frigate URL, and camera serials while auto-deriving
  `go2rtc` and `RTSP` addresses, validating settings and numeric bounds with an IDE `JSON` schema, and supporting legacy
  upstream configurations
- Support hardware-accelerated `H.264` video encoding (`vaapi`, `qsv`, `nvenc`, and `v4l2m2m`) with automatic software
  fallback and aspect-ratio-preserving scaling
- Govern camera sessions, backfill jobs, Frigate events, and decoders with strict state machines, state-prefixed
  structured logs, and pre-allocated media buffers
- Add a hermetic local Node.js toolchain with static type checking, dead-code and lint gates, documentation validators,
  and automated acceptance and unit test suites
