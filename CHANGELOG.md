# Changelog

Finished work, newest first. Open work lives in [docs/TODO.md](docs/TODO.md).

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
