# Architecture

Read when: adding a module, moving code between layers, or touching a state machine or media buffer.
Related: [stream-lifecycle.md](stream-lifecycle.md), [config-modes.md](config-modes.md).

## Repository layout

```text
.
├── Makefile                           # Hermetic .venv Node.js toolchain, tsc, knip, eslint, prettier, node:test & Podman build
├── package.json                       # Project metadata, dependencies, knip & prettier config
├── README.md                          # User-friendly setup guide, mode selector & configuration reference
├── AGENTS.md                          # Always-loaded rules, doc map and routing rules (under 8 KB)
├── CHANGELOG.md                       # Finished work, newest first
├── .github/workflows/release.yml      # GitHub Actions CI checks, :dev image on main/master, :v* + :latest on tags
├── .agents/skills/                    # Project skill bridge-change-workflow (procedures)
├── docs/                              # Topic docs, ACCEPTANCE.md, REGRESSION.md, TODO.md, acceptance/, regression/, images/
├── scripts/                           # check-docs.js, check-commit-msg.js, eslint.config.js, eslint-suppressions.json, tsconfig.json
├── deploy/
│   ├── Dockerfile                     # Multi-stage node:22-alpine3.23 test/build -> alpine:3.23 runtime (/app/)
│   ├── config.schema.json             # JSON Schema (Draft-07) for IDE validation & autocompletion
│   ├── config.example.minimal.yaml    # Minimal configuration example
│   ├── config.example.full.yaml       # Full configuration example with all options
│   └── docker-compose.example.yml     # Example Docker Compose deployment
├── src/
│   ├── app.js                         # Application composition root, wiring & signal handlers
│   ├── config.js                      # Config loader, defensive validation, numeric clamping & constants
│   ├── logger.js                      # Structured Alloy/Loki logger & ICU-free local ISO timestamps
│   ├── domain/
│   │   ├── camera.js                  # Camera entity composing StatusCard, Telemetry & stream rules
│   │   ├── status-card.js             # StatusCard model (theme/position, bounds & Frigate mask polygon)
│   │   ├── telemetry.js               # Telemetry model (sensor state, Eufy parsing & 6-color rules)
│   │   └── backfill-job.js            # BackfillJob model (.zxvideo record parser & time-window matcher)
│   ├── overlay/
│   │   ├── yuv-canvas.js              # Low-level YUV420p drawing, crystal/HUD surfaces & box blur
│   │   ├── ui-glyphs.js               # Embedded Lucide contour icon sprites, clock hands & minimal primitives
│   │   ├── card-renderer.js           # Theme engines (glance, minimal, pebbles, hud, none) & live overlays
│   │   └── snapshot-cache.js          # Persistent JPEG <-> YUV420p snapshot cache (/config/cache)
│   ├── media/
│   │   ├── encoder.js                 # Persistent FFmpeg RTSP encoder, drain pipe & A/V tickers
│   │   └── decoder.js                 # Per-session P2P Annex-B & RTSP pull FFmpeg decoders
│   └── services/
│       ├── eufy-client.js             # eufy-security-ws WebSocket RPC client & telemetry/power sync
│       ├── frigate-client.js          # Frigate & go2rtc HTTP client (events, masks, idle & viewer poll)
│       ├── ha-notifier.js             # Home Assistant webhook notification client
│       ├── http-server.js             # Built-in HTTP server (/api/wake/:cameras, /api/config, /api/status & /healthz)
│       └── stream-orchestrator.js     # Per-station arbitration, RTSP/P2P wake, backfill & watchdog
└── test/
    ├── reporter.js                    # Concise node:test reporter (errors or single summary line)
    ├── acceptance.test.js             # Locked AT-01..AT-19 acceptance test suite mapping 1:1 to ACCEPTANCE.md
    ├── config.test.js                 # node:test suite for config, modes & defensive rules
    ├── domain.test.js                 # node:test suite for Camera, StatusCard, Telemetry & BackfillJob
    ├── media.test.js                  # node:test suite for encoder, decoder, NAL parser & backpressure
    └── services.test.js               # node:test suite for Frigate/go2rtc, HTTP, Eufy RPC & logger
```

### Modular Dependency Flow

Data and dependencies flow top-down from the composition root (`src/app.js`) through `services/*` (where
`stream-orchestrator` also calls `eufy-client` and `frigate-client`, `http-server` reads `eufy-client` readiness, and
`frigate-client` calls `ha-notifier`) into `media/*` and `overlay/*`, down to `domain/*`, `config.js`, and
`logger.js` with zero circular `require()` dependencies:

```text
                                 ┌──────────────────────┐
                                 │      src/app.js      │  (Composition Root & Signal Hooks)
                                 └──────────┬───────────┘
                                            │
        ┌───────────────────┬───────────────┼───────────────┬────────────────┐
        ▼                   ▼               ▼               ▼                ▼
┌───────────────┐ ┌────────────────────┐ ┌───────────┐ ┌──────────────────┐ ┌─────────────┐
│  http-server  │ │stream-orchestrator │ │eufy-client│ │  frigate-client  │ │ ha-notifier │  (Service Layer)
└───────┬───────┘ └─────────┬──────────┘ └─────┬─────┘ └────────┬─────────┘ └──────┬──────┘
        │                   │                  │                │                  │
        │                   ├──────────────────┴────────┐       │                  │
        │                   ▼                           ▼       │                  │
        │            ┌─────────────┐             ┌─────────────┐│                  │
        │            │ media/*     │             │ overlay/*   ││                  │  (Media & Overlay Layer)
        │            │ (enc / dec) │             │ (card / yuv)││                  │
        │            └──────┬──────┘             └──────┬──────┘│                  │
        │                   │                           │       │                  │
        └───────────────────┴──────────────┬────────────┴───────┴──────────────────┘
                                           ▼
                              ┌─────────────────────────┐
                              │ domain/* (camera, card, │  (Domain & Foundation Layer)
                              │ telemetry, backfill)    │
                              │ config.js / logger.js   │
                              └─────────────────────────┘
```

### Strict Finite State Machines, Builders & Zero-Allocation Memory Architecture

- **Camera Session FSM (`SESSION_STATES`, `ALLOWED_SESSION_TRANSITIONS`, `canTransitionSession`, `transitionTo`):**
  Every `Camera` entity (`src/domain/camera.js`) governs its session lifecycle via `cam.sessionState` across
  `IDLE | COOLDOWN -> WAKING_RTSP | WAKING_P2P -> STREAMING_LIVE (<-> WAKING_RTSP) -> COOLDOWN | IDLE` (plus direct
  wake aborts `WAKING_* -> IDLE` and `COOLDOWN -> IDLE`) for live sessions and
  `IDLE | COOLDOWN -> HANDSHAKING_BACKFILL -> PLAYING_BACKFILL (-> DRAINING_BACKFILL_TAIL) -> IDLE` for backfill clip
  downloads, enforced by `canTransitionSession(fromState, toState)` in `cam.transitionTo(nextState, now, reason)`.
  Every log line for any stateful scope (`sessionState`, `state`, `decoderState`, or `evState`) across all severity
  levels (`DEBUG`, `INFO`, `WARN`, `ERROR`) automatically prefixes the current uppercase state
  (`YYYY-MM-DD HH:MM:SS - [LEVEL] - [camera] [STATE] message`), and every state change logs a `DEBUG` line formatted as
  `[DEBUG] - [camera] [NEXT_STATE] <machine> state: <prev> -> <next> (<reason>)`.
- **BackfillJob Lifecycle FSM (`BACKFILL_STATES`, `ALLOWED_BACKFILL_TRANSITIONS`, `canTransitionBackfill`,
  `transitionTo`):** `BackfillJob` (`src/domain/backfill-job.js`) encapsulates its own matched clip queue
  (`matchedClips`) and enforces validated transitions across
  `RECORDING -> SETTLING | READY_TO_QUERY -> MATCHED -> DOWNLOADING -> COMPLETED | EXPIRED` (allowing companion
  re-triggers `SETTLING -> RECORDING`, queued multi-clip / follow-up transitions `DOWNLOADING -> MATCHED |
READY_TO_QUERY`, and `-> EXPIRED` from any pre-terminal state), logging
  `[DEBUG] - [camera] [NEXT_STATE] backfill state: <prev> -> <next> (<reason>)` on each transition.
- **Frigate Event Filing FSM (`FRIGATE_EVENT_STATES`):** Each `Camera` tracks external Frigate event creation across
  `IDLE -> QUEUED -> WAITING_SNAPSHOT -> COOLDOWN -> IDLE | QUEUED` (plus abort `QUEUED | WAITING_SNAPSHOT -> IDLE`;
  `tryUpgradeOrQueueFrigateEvent`, `beginFrigateSnapshotWait`, `completeFrigateEventFiling`, `getFrigateEventState`),
  logging `[DEBUG] - [camera] [NEXT_STATE] frigate event state: <prev> -> <next> (<reason>)` on each transition.
- **Decoder Backpressure FSM (`DECODER_STATES`):** Each `Camera` tracks its per-session FFmpeg decoder pipeline across
  `DETACHED -> HANDSHAKING -> DECODING (<-> PAUSED_BACKPRESSURE) -> FLUSHING_EOF -> DETACHED` (plus `* -> DETACHED`;
  `attachDecoder`, `markDecoderDecoding`, `pauseDecoderStdout`, `resumeDecoderStdout`, `markDecoderInputEnded`,
  `detachDecoder`), logging `[DEBUG] - [camera] [NEXT_STATE] decoder state: <prev> -> <next> (<reason>)` on each
  transition and queuing/draining compressed packets via `enqueueOrWriteVideoPacket`, `enqueueOrWriteAudioPacket`,
  `drainPendingDecoderInput`, and `_resetDecoderPipeState`.
- **Immutable Value Objects & Builders (`Object.freeze`, `WakeRequest`, `FfmpegArgsBuilder`):** Configuration resolvers
  (`resolveFrameRates`, `resolveTelemetryConfig`, `resolveCardConfig`, `resolveCameraTimers`,
  `resolveHardwareRecordingConfig`), `COLOR_*` palettes, `BackfillJob` clip descriptors,
  `WakeRequest.motion(...).build()` / `WakeRequest.view(...).build()`, and `FfmpegArgsBuilder.build()` return frozen
  (`Object.freeze`) immutable value objects.
- **Zero-Allocation Frame & Audio Buffers:**
  - `StatusCard` pre-allocates `asleep` (`1.38 MB` `FRAME` YUV420p) on construction while lazy-allocating `waking` and
    `busy` on first access (`peekWakingBuffer`, `peekBusyBuffer`) and lazy-allocating the 2-slot `1.38 MB`
    `liveOverlayBufs` ring on first `prepareLiveOverlayBuffer()` call; `renderSingleStatusCard()` and
    `renderCameraCards()` mutate allocated buffers in-place on telemetry updates.
  - `yuv-canvas.js` reuses module-level `blurScratch`, `regionScratch`, and `bgCanvasScratch` buffers in
    `boxBlurPlane()`, `extractBlurredRegion()`, and `prepareBackgroundCanvas()`.
  - `attachDecoderStreams()` reuses a single lazily allocated `1.38 MB` `cam.decoderReadBuf`
    (`acquireDecoderReadBuffer`) per camera across decoder restarts and standby probes; live P2P/RTSP frames alternate
    across a lazily allocated 2-slot `cam.liveFrameRing` (`acquireNextLiveFrameSlot`), and live TCP decode bursts
    (`cam.liveFrames`, cap `12`) plus burst backfill downloads recycle buffers through a bounded `cam.downloadFramePool`
    (`acquireDownloadFrameBuffer`, capped at `32` buffers) so steady-state streaming and backfill playback perform zero
    `1.38 MB` heap allocations.
  - `cam.consumeAudioChunk()` slices directly from `cam.pcm[0]` or copies into a pre-allocated `cam.audioOutBuf` in O(1)
    time without `Buffer.concat`.

### Tested Hardware Stack

- **Station:** Eufy HomeBase 3 (S380) (`T8030`, fw `3.8.7.4`, hw `V05`) + Video Doorbell Dual Chime (`T8023`, fw
  `3.3.2.2m_0.1`, hw `P0`)
- **Cameras:** Eufy Video Doorbell E340 Dual (`T8214`, fw `3.2.7.2`, hw `P2`) and two eufyCam S300 (eufyCam 3C)
  (`T8161`, fw `3.4.3.0`, hw `P1`)
- **Runtime:** Multi-stage `node:22-alpine3.23` container under `Podman` Quadlet, using `Mesa 25.2+`
  (`mesa-va-gallium`), `tini` as `PID 1`, non-root `node` user (`UID 1000`), `ffmpeg`, `go2rtc`, `Frigate 0.18`, and
  `eufy-security-ws` (API schema `21`).
