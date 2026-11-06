# AGENTS.md

Eufy battery camera and doorbell bridge for Frigate and go2rtc (Node.js 22, CommonJS, no frameworks). Repository
visibility: public (no personal data in any file; see the `markdown` skill).
Commit trailer: `Co-authored-by: Gemini <gemini@google.com>` (used by the `git-commit` skill).

Global skills apply (`tdd-workflow`, `nodejs-development`, `markdown`, `git-commit`, `release-and-ci`,
`project-docs-hygiene`). This file holds only what is specific to this project. Step-by-step procedures live in the
project skill `bridge-change-workflow` (`.agents/skills/`). Always capitalize Eufy in prose.

## Before You Change Code

1. Read `docs/ACCEPTANCE.md` sections 1 (mode matrix) and 3 (file and concern maps), then every
   `docs/acceptance/AT-NN.md` listed for the files and concern you change. `make check` runs all 18 locked acceptance
   tests regardless.
2. Never edit, weaken, skip, or delete a test in `test/acceptance.test.js` unless the user explicitly asks to change
   that requirement. A requirement change edits `docs/acceptance/AT-NN.md` and its test together.
3. Work test first: Red, verify Red, Green, then `make check` (`tsc`, `knip`, `eslint`, docs check, `node --check`,
   and `node --test`). Use the `tdd-workflow` skill.
4. If your change touches a topic in the doc map below, read that document before editing.

## Doc Map (Read When)

| Document                                                           | Read when you touch or debug                                                          |
| :----------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| [`docs/stream-lifecycle.md`](docs/stream-lifecycle.md)             | wake, arbitration, RTSP, P2P, backfill download, hold extension, HTTP wake API        |
| [`docs/config-modes.md`](docs/config-modes.md)                     | `src/config.js`, `deploy/config.*.json` schema/examples, modes, timers, Power Manager |
| [`docs/status-card-and-hud.md`](docs/status-card-and-hud.md)       | `src/domain/status-card.js`, `src/overlay/*`, Frigate mask sync, `debug` theme        |
| [`docs/architecture.md`](docs/architecture.md)                     | module layout, layer rules, state machines, zero-allocation buffers                   |
| [`docs/logging-and-initiators.md`](docs/logging-and-initiators.md) | log lines, stop reasons, `initiator=...` values                                       |
| [`docs/operations.md`](docs/operations.md)                         | build, test, publish, health check, `SIGUSR1` and `SIGUSR2` diagnostics               |
| [`docs/REGRESSION.md`](docs/REGRESSION.md)                         | any bug fix, or before changing code listed in its `Files` column                     |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)                         | mode matrix, `AT-01..AT-18` index, file map, and subsystem concern map                |
| [`docs/acceptance/AT-NN.md`](docs/acceptance/)                     | the behavior locked by acceptance test `AT-NN`                                        |
| [`README.md`](README.md)                                           | user-facing setup, configuration reference, troubleshooting                           |
| [`docs/TODO.md`](docs/TODO.md) and [`CHANGELOG.md`](CHANGELOG.md)  | open work (`docs/TODO.md`) and finished work (`CHANGELOG.md`)                         |

## Where New Information Goes

Do not add reference text to this file. Route it:

| New information                                     | Goes to                                                                          |
| :-------------------------------------------------- | :------------------------------------------------------------------------------- |
| A rule every change must follow (two lines at most) | "Project Rules" below, only if no tool can enforce it                            |
| A rule a tool can check                             | the tool configuration (`scripts/eslint.config.js`, `scripts/`), not prose       |
| A user-visible behavior that must never regress     | `docs/acceptance/AT-NN.md`, the index in `docs/ACCEPTANCE.md`, and a locked test |
| A diagnosed bug and its fix                         | `docs/regression/NN-slug.md` plus one row in `docs/REGRESSION.md`                |
| Domain explanation                                  | the matching document in `docs/`                                                 |
| Planned work, then finished work                    | `docs/TODO.md`, then one line in `CHANGELOG.md`                                  |

## Project Rules

- Build configuration once at startup (`BridgeConfigBuilder`, `CameraConfig`, `resolveCameraConfig()` in
  `src/config.js`) into the frozen `cfg` singleton, and reuse the identity helpers and `Camera` accessors
  (`getName()`, `getSerial()`, `getScopeName()`, `getCacheFileName()`) everywhere.
- Validate all required, unknown, and mixed keys in a single pass in `validateConfig()`; log one structured `[ERROR]`
  line on failure without a stack trace. Pure upstream (`ljlongwing`) legacy configs stay supported with a deprecation
  warning and `mode: "auto"`; mixing legacy and current keys is rejected.
- Use exported constant groups and frozen lookup maps instead of magic numbers or strings. Inline strings are allowed
  only in `log.*()` calls, FFmpeg argument builders, and HTTP headers.
- Mutate buffers in place only for the pre-allocated hot-path media buffers (`StatusCard` frame buffers,
  `yuv-canvas` scratch buffers, decoder stream `buf`, `liveFrameRing`, `downloadFramePool`, `consumeAudioChunk`).
- Never toggle the camera spotlight (`light`) on normal session start or stop. Turn off a stuck spotlight only when
  `track_stuck_spotlight: true` (experimental, default `false`), after the `130s` idle grace.
- Keep `AGENTS.md` under 8 KB (hard limit 16 KB) and every file in `docs/` under 20 KB; `make docs-check` enforces it.

## Key Commands

- `make env`: bootstrap the hermetic `.venv` toolchain (Node.js plus dev dependencies).
- `make check`: `tsc`, `knip`, `eslint`, `docs-check`, `node --check`, and all tests. Run it before every commit.
- `make format-docs`: align Markdown tables and wrapping with `prettier`.
- `make docker-build`, `make publish`: image build and publish (see `docs/operations.md`).
- `podman exec eufy-frigate-battery-bridge wget -qO- http://127.0.0.1:8080/healthz`: readiness probe.
