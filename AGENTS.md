# AGENTS.md

Eufy battery camera and doorbell bridge for Frigate and go2rtc (Node.js 22, CommonJS, no frameworks). Repository
visibility: public (no personal data in any file).
Commit trailer: `Co-authored-by: Gemini <gemini@google.com>`

This file holds only what is specific to this project. Step-by-step procedures live in the project skill
`bridge-change-workflow` (`.agents/skills/`). Always capitalize Eufy in prose.

## Before You Change or Verify Code

1. Read `docs/ACCEPTANCE.md` sections 1 (mode matrix) and 3 (file and concern maps), then every
   `docs/acceptance/AT-NN.md` listed for the files and concern you change. `make check` runs all 19 locked acceptance
   tests regardless.
2. Never edit, weaken, skip, or delete a test in `test/acceptance/AT-NN.test.js` unless the user explicitly asks to
   change that requirement. A requirement change edits `docs/acceptance/AT-NN.md` and `test/acceptance/AT-NN.test.js`
   together.
3. When verifying behavior during development or investigating a request, check whether a test covers that logic; if
   not, write one from the expected behavior (never from the code) and run it to verify the code fits the test, never
   the reverse. Work test first: Red, verify Red, Green, then `make check`.
4. If your change touches a topic in the doc map below, read that document before editing.

## Doc Map (Read When)

| Document                                                           | Read when you touch or debug                                                              |
| :----------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| [`docs/stream-lifecycle.md`](docs/stream-lifecycle.md)             | wake, arbitration, RTSP, P2P, backfill download, hold extension, HTTP wake API            |
| [`docs/media-pipeline.md`](docs/media-pipeline.md)                 | `src/media/*`, `audio-queue.js`, `snapshot-cache.js`, FFmpeg args, `hwaccel`, hot buffers |
| [`docs/upstream-integrations.md`](docs/upstream-integrations.md)   | `src/services/eufy/*`, Frigate, `go2rtc`, `HA_WEBHOOK_URL`, `service-versions.js`         |
| [`docs/config-modes.md`](docs/config-modes.md)                     | `src/config/*`, `deploy/config.*.yaml` schema/examples, modes, timers, Power Manager      |
| [`docs/status-card-and-hud.md`](docs/status-card-and-hud.md)       | `src/domain/status-card.js`, `src/overlay/*`, Frigate mask sync, `hud` theme              |
| [`docs/architecture.md`](docs/architecture.md)                     | module layout, layer rules, state machines, immutable builders                            |
| [`docs/logging-and-initiators.md`](docs/logging-and-initiators.md) | log lines, stop reasons, `initiator=...` values                                           |
| [`docs/operations.md`](docs/operations.md)                         | build, test, publish, health check, `SIGUSR1` and `SIGUSR2` diagnostics                   |
| [`docs/REGRESSION.md`](docs/REGRESSION.md)                         | any bug fix, or before changing code listed in an entry's files list                      |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)                         | mode matrix, `AT-01..AT-19` index, file map, and subsystem concern map                    |
| [`docs/acceptance/AT-NN.md`](docs/acceptance/)                     | the behavior locked by acceptance test `AT-NN`                                            |
| [`README.md`](README.md)                                           | user-facing setup, configuration reference, troubleshooting                               |
| [`docs/TODO.md`](docs/TODO.md) and [`CHANGELOG.md`](CHANGELOG.md)  | open work (`docs/TODO.md`) and finished work (`CHANGELOG.md`)                             |

## Where New Information Goes

Do not add reference text to this file. Route it:

| New information                                     | Goes to                                                                          |
| :-------------------------------------------------- | :------------------------------------------------------------------------------- |
| A rule every change must follow (two lines at most) | "Project Rules" below, only if no tool can enforce it                            |
| A rule a tool can check                             | the tool configuration (`scripts/eslint.config.js`, `scripts/`), not prose       |
| A user-visible behavior that must never regress     | `docs/acceptance/AT-NN.md`, the index in `docs/ACCEPTANCE.md`, and a locked test |
| A diagnosed bug and its fix                         | `docs/regression/NN-slug.md` plus one line in `docs/REGRESSION.md`               |
| Domain explanation                                  | the matching document in `docs/`                                                 |
| Planned work, then finished work                    | `docs/TODO.md`, then one line in `CHANGELOG.md`                                  |

## Project Rules

- Build configuration once at startup (`BridgeConfigBuilder`, `CameraConfig`, `resolveCameraConfig()` in
  `src/config/`) into the frozen `cfg` singleton, and reuse the identity helpers and `Camera` accessors
  (`getName()`, `getSerial()`, `getScopeName()`, `getCacheFileName()`) everywhere.
- Validate all required and unknown camera configuration keys in a single pass in `validateConfig()`; log one structured
  `[ERROR]` line and exit on missing/invalid `config.yaml` without a stack trace. Service endpoints and container
  runtime settings live in prefixed environment variables (`BRIDGE_*`, `EUFY_WS_*`, `FRIGATE_*`, `GO2RTC_*`,
  `HA_WEBHOOK_URL`) and are rejected as unknown if placed in `config.yaml`.
- Use exported constant groups and frozen lookup maps instead of magic numbers or strings. Inline strings are allowed
  only in `log.*()` calls, FFmpeg argument builders, and HTTP headers.
- Mutate buffers in place only for the pre-allocated hot-path media buffers (`StatusCard` frame buffers,
  `yuv-canvas` scratch buffers, `decoderReadBuf`, `liveFrameRing`, `downloadFramePool`, `consumeAudioChunk`).
- Never toggle the camera spotlight (`light`) on normal session start or stop. Turn off a stuck spotlight only when
  `track_stuck_spotlight: true` (experimental, default `false`), after the `130s` idle grace.
- Keep `AGENTS.md` under 8 KB (hard limit 16 KB) and every file in `docs/` under 20 KB; `make docs-check` enforces it.
