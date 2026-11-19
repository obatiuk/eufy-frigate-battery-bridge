# Architecture

Read when: adding a module, moving code between layers, or touching a state machine.
Related: [stream-lifecycle.md](stream-lifecycle.md), [media-pipeline.md](media-pipeline.md),
[upstream-integrations.md](upstream-integrations.md), [config-modes.md](config-modes.md).

## Repository layout

```text
.
├── Makefile                                # Hermetic .venv Node.js toolchain, tsc, knip, eslint, prettier, node:test & Podman build
├── package.json                            # Project metadata, dependencies, knip & prettier config
├── README.md                               # User-friendly setup guide, mode selector & configuration reference
├── AGENTS.md                               # Always-loaded rules, doc map and routing rules (under 8 KB)
├── CHANGELOG.md                            # Finished work, newest first
├── .github/workflows/release.yml           # GitHub Actions CI checks, :dev image on main/master, :v* + :latest on tags
├── .agents/skills/                         # Project skill bridge-change-workflow (procedures)
├── docs/                                   # Topic docs, ACCEPTANCE.md, REGRESSION.md, TODO.md, acceptance/, regression/, images/
├── scripts/                                # check-docs.js, check-commit-msg.js, eslint.config.js, eslint-suppressions.json, tsconfig.json
├── deploy/
│   ├── Dockerfile                          # Multi-stage node:22-alpine3.23 test/build -> alpine:3.23 runtime (/app/)
│   ├── config.schema.json                  # JSON Schema (Draft-07) for IDE validation & autocompletion
│   ├── config.example.minimal.yaml         # Minimal configuration example
│   ├── config.example.full.yaml            # Full configuration example with all options
│   └── docker-compose.example.yml          # Example Docker Compose deployment
├── src/
│   ├── app.js                              # Application composition root, wiring & signal handlers
│   ├── logger.js                           # Structured Alloy/Loki logger & ICU-free local ISO timestamps
│   ├── config/
│   │   ├── index.js                        # Frozen startup cfg singleton & unified public configuration exports
│   │   ├── constants.js                    # Schema key sets, frozen enums, priority tiers, colors, bounds & clampNum
│   │   ├── camera-config.js                # CameraConfig value object, identity normalizers & RTSP fragment stripping
│   │   ├── env.js                          # Env endpoints, runtime vars, ${ENV_VAR} expansion & build metadata
│   │   ├── validation.js                   # Single-pass YAML schema validation & config file loader
│   │   ├── resolvers.js                    # Mode, timer, card, telemetry & Power Manager resolvers + ignored warnings
│   │   └── builder.js                      # Fluent BridgeConfigBuilder producing deeply frozen config instances
│   ├── domain/
│   │   ├── camera.js                       # Camera entity composing StatusCard, Telemetry & stream collaborators
│   │   ├── camera/
│   │   │   ├── states.js                   # Session, Frigate event & decoder FSM enums and transition maps
│   │   │   ├── debug-hud.js                # Pure fixed-width "hud" diagnostic rows from a Camera snapshot
│   │   │   ├── viewer-set.js               # ViewerSet model: connected go2rtc consumers & who may wake the camera
│   │   │   ├── hardware-trigger-ledger.js  # HardwareTriggerLedger: active Eufy trigger events, expiry & duplicates
│   │   │   ├── frigate-event-filing.js     # FrigateEventFiling: queued/waiting/filed/cooldown Frigate event lifecycle
│   │   │   ├── audio-queue.js              # AudioQueue: bounded PCM FIFO feeding the encoder without per-tick allocations
│   │   │   ├── session-lifecycle.js        # SessionLifecycle: session state machine & post-session cooldown clock
│   │   │   ├── offline-state.js            # OfflineState: offline encoder pause flag & snapshot seed window timer
│   │   │   ├── wake-scheduler.js           # WakeRequest value object & WakeScheduler: paced api wake & deferred live wake
│   │   │   ├── stream-session.js           # StreamSession: session state, holds/caps, direct RTSP probes, watchdogs & decoder FSM
│   │   │   └── backfill-state.js           # BackfillState: pending/queued/active BackfillJobs, clip queues & playback counters
│   │   ├── status-card.js                  # StatusCard model (theme/position, bounds & Frigate mask polygon)
│   │   ├── station.js                      # Station & StationRegistry: P2P slot locks, wake/query pacing, recovery & summaries
│   │   ├── telemetry.js                    # Telemetry model (sensor state, Eufy property parsing, low-battery rules)
│   │   ├── telemetry-visuals.js            # Pure resolvers: charging state, Wi-Fi tiers & 6-color status/battery/temp
│   │   └── backfill-job.js                 # BackfillJob model (.zxvideo record parser & time-window matcher)
│   ├── overlay/
│   │   ├── yuv-canvas.js                   # Low-level YUV420p drawing, crystal/HUD surfaces & box blur
│   │   ├── ui-glyphs.js                    # Embedded Lucide contour icon sprites, clock hands & minimal primitives
│   │   ├── card-renderer.js                # Theme engines (glance, minimal, pebbles, hud, none) & live overlays
│   │   └── snapshot-cache.js               # Persistent JPEG <-> YUV420p snapshot cache (/config/cache)
│   ├── media/
│   │   ├── ffmpeg-args.js                  # Fluent FFmpeg argument builder & stderr tail collector (encoder + decoder)
│   │   ├── encoder.js                      # Persistent FFmpeg RTSP encoder, drain pipe & A/V tickers
│   │   └── decoder.js                      # Per-session P2P Annex-B & RTSP pull FFmpeg decoders
│   └── services/
│       ├── eufy-client.js                  # Public facade re-exporting src/services/eufy/*
│       ├── eufy/
│       │   ├── ws-transport.js             # eufy-security-ws WebSocket connection, schema negotiation & JSON-RPC transport
│       │   ├── telemetry-sync.js           # Device property serialization, Power Manager sync, telemetry & face names
│       │   └── station-recovery.js         # HomeBase station P2P health, wedged-session recycle & RTSP URL recovery
│       ├── frigate-client.js               # Frigate HTTP client (external events, snapshots, idle checks) + re-exports
│       ├── frigate-masks.js                # Frigate auto-mask sync (PUT /api/config/set) & Frigate API health
│       ├── go2rtc-viewers.js               # go2rtc bulk stream poll, viewer wake classification & go2rtc API health
│       ├── upstream-health.js              # Shared upstream HTTP timeouts, error snippets & service health flags
│       ├── service-versions.js             # Soft startup API version validation for Frigate, go2rtc & eufy-security-ws
│       ├── api-payloads.js                 # Read-only /api/config and /api/status JSON payload builders
│       ├── ha-notifier.js                  # Home Assistant webhook notification client
│       ├── http-server.js                  # Built-in HTTP server (/api/wake/:cameras, /api/config, /api/status & /healthz)
│       ├── wake-request.js                 # /api/wake parsing, target selection, JSON body reading & dispatch
│       ├── http-responses.js               # Shared JSON response helpers, HTTP status codes & error codes
│       ├── stream-orchestrator.js          # Public facade re-exporting src/services/orchestrator/*
│       └── orchestrator/
│           ├── context.js                  # Shared camera list, serial map, station transition locks & offline resume
│           ├── wake.js                     # /api/wake, trigger, HomeBase RTSP/P2P start & serialized stop teardown
│           ├── arbitration.js              # Per-station P2P slot arbitration, preemption & parallel RTSP wake
│           ├── backfill-queue.js           # HomeBase local DB queries, serialized backfill drain & download finish
│           ├── event-router.js             # Frozen Eufy device event dispatch table, stream adoption & RTSP re-wake
│           └── housekeeping.js             # 500ms tick: early sleep, Frigate hold extension, probes & watchdogs
└── test/
    ├── camera-coupling.test.js             # Type-checked guard: zero Camera field access in src/ or test/ outside camera.js
    ├── logger.test.js                      # Structured Alloy/Loki logger & timestamp formatting tests (mirrors src/logger.js)
    ├── reporter.js / reporter.test.js      # Concise node:test reporter (fails skipped/todo/empty runs)
    ├── test-hygiene.test.js                # Enforces no fixed waits, isolated test-env, <=2100 lines, package mirror & 1:1 suites
    ├── helpers/                            # acceptance-harness.js, async.js, media-mocks.js, service-mocks.js, test-env.js
    ├── scripts/                            # check-docs.test.js & check-docs-regression.test.js (docs budget, parity & release checks)
    ├── config/                             # config, env, resolvers & modules tests (mirrors src/config/*)
    ├── domain/                             # camera, status-card, station, telemetry, telemetry-visuals & backfill-job tests
    │   └── camera/                         # debug-hud, viewer-set, trigger-ledger, frigate-event-filing, audio-queue & lifecycle tests
    ├── overlay/                            # card-renderer & snapshot-cache tests (mirrors src/overlay/*)
    ├── media/                              # encoder & decoder tests (mirrors src/media/*)
    ├── services/                           # eufy-client, frigate-client, http-server, service-versions, orchestrator & wake tests
    │   ├── eufy/                           # modules.test.js for ws-transport, telemetry-sync & station-recovery (mirrors src/services/eufy/*)
    │   └── orchestrator/                   # modules.test.js for context, wake, arbitration, backfill-queue, event-router & housekeeping
    ├── acceptance/                         # AT-01..AT-19.test.js: locked 1:1 acceptance suite mirroring docs/acceptance/AT-NN.md
    └── regression/                         # NN-slug.test.js (01..46): 1:1 per-case regression suite mirroring docs/regression/NN-slug.md
```

### Modular Dependency Flow

Data and dependencies flow top-down from the composition root (`src/app.js`) through `services/*` (where
`stream-orchestrator` also calls `eufy-client` and `frigate-client`, `http-server` reads `eufy-client` readiness, and
`frigate-client` calls `ha-notifier`) into `media/*` and `overlay/*`, down to `domain/*`, `config/*`, and
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
                              │ config/* / logger.js    │
                              └─────────────────────────┘
```

### Strict Finite State Machines & Builders

- **Camera Session FSM (`SESSION_STATES`, `ALLOWED_SESSION_TRANSITIONS`, `canTransitionSession`, `transitionTo`):**
  Every `Camera` entity (`src/domain/camera.js`) governs its session lifecycle via `getSessionState()` across
  `IDLE | COOLDOWN -> WAKING_RTSP | WAKING_P2P -> STREAMING_LIVE (<-> WAKING_RTSP) -> COOLDOWN | IDLE` (plus direct
  wake aborts `WAKING_* -> IDLE` and `COOLDOWN -> IDLE`) for live sessions and
  `IDLE | COOLDOWN -> HANDSHAKING_BACKFILL -> PLAYING_BACKFILL (-> DRAINING_BACKFILL_TAIL) -> IDLE` for backfill clip
  downloads, enforced by `canTransitionSession(fromState, toState)` in `cam.transitionTo(nextState, now, reason)`.
  Every log line for a stateful scope (an explicit `{name, state}` object, or a `Camera` or `BackfillJob` that hands the
  logger one through `getLogScope()`) across all severity levels (`DEBUG`, `INFO`, `WARN`, `ERROR`) prefixes the
  current uppercase state
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
  `DETACHED -> HANDSHAKING -> DECODING (<-> PAUSED_BACKPRESSURE) -> FLUSHING_EOF -> DETACHED` (plus `* -> DETACHED`),
  logging `[DEBUG] - [camera] [NEXT_STATE] decoder state: <prev> -> <next> (<reason>)` on each transition; pipe layout,
  hardware acceleration fallback, and zero-allocation buffers live in [media-pipeline.md](media-pipeline.md).
- **Immutable Value Objects & Builders (`Object.freeze`, `WakeRequest`, `FfmpegArgsBuilder`):** Configuration resolvers
  (`resolveFrameRates`, `resolveTelemetryConfig`, `resolveCardConfig`, `resolveCameraTimers`,
  `resolveHardwareRecordingConfig`), `COLOR_*` palettes, `BackfillJob` clip descriptors,
  `WakeRequest.motion(...).build()` / `WakeRequest.view(...).build()`, and `FfmpegArgsBuilder.build()` return frozen
  (`Object.freeze`) immutable value objects.

### Tested Hardware Stack

- **Station:** Eufy HomeBase 3 (S380) (`T8030`, fw `3.8.7.4`, hw `V05`) + Video Doorbell Dual Chime (`T8023`, fw
  `3.3.2.2m_0.1`, hw `P0`)
- **Cameras:** Eufy Video Doorbell E340 Dual (`T8214`, fw `3.2.7.2`, hw `P2`) and two eufyCam S300 (eufyCam 3C)
  (`T8161`, fw `3.4.3.0`, hw `P1`)
- **Runtime:** Multi-stage `node:22-alpine3.23` container under `Podman` Quadlet, using `Mesa 25.2+`
  (`mesa-va-gallium`), `tini` as `PID 1`, non-root `node` user (`UID 1000`), `ffmpeg`, `go2rtc`, `Frigate 0.18`, and
  `eufy-security-ws` (API schema `21`).
