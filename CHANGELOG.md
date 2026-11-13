# Changelog

Finished work, newest first. Open work lives in [docs/TODO.md](docs/TODO.md).

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
