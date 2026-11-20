# TODO

## Open

Work order inside each section is suggested priority (standard backlog first, then `(post-v0.0.2)` and `(low)`). Follow
strict TDD (`Red -> Green -> make check`) for every code item and never weaken a locked `AT-*` test. Cite functions and
classes, not line numbers (they drift); find them with `grep`.

- [A. Reliability and runtime bugs](#a-reliability-and-runtime-bugs) - experimental stuck-spotlight detection
- [B. Configuration and validation](#b-configuration-and-validation) - dedicated clamp bounds, unified `cfg` usage, and
  strict full-repo type-checking
- [C. Security, logging, and error handling](#c-security-logging-and-error-handling) - HTTP API authentication,
  method/header checks, and exposure documentation
- [D. Domain and status card cleanups](#d-domain-and-status-card-cleanups) - `Camera` sub-model encapsulation and
  command/query separation

### A. Reliability and runtime bugs

- [ ] Refine experimental stuck-spotlight detection (`track_stuck_spotlight`) (low)
  - `shouldTurnOffStuckIdleLight()` and `hasStuckIdleLightPastGrace()` (disabled by default) rely on a fixed `130s`
    grace and cached `light` events. Handle missed `light=false` updates, manual toggles, and active schedules before
    enabling by default.

### B. Configuration and validation

- [ ] Enable `strict: true` and include `test/**/*.js` in `scripts/tsconfig.json`
  - `scripts/tsconfig.json` checks `src/**/*.js` and `scripts/**/*.js` with `"strict": false`, and JSDoc `*`
    annotations remain at dynamic JSON/YAML/RPC boundaries. Replace remaining `*` annotations with `unknown` plus
    narrowing predicates, add `../test/**/*.js` to `include`, and turn on `"strict": true` in `make deadcode`.
- [ ] Use dedicated clamp constants in `BridgeConfigBuilder` and unify `cfg` usage (low)
  - `BridgeConfigBuilder.withTimersAndArbitration()` (`builder.js`) reuses unrelated clamp constants; exported
    resolvers default `baseCfg` to `rawLoadedCfg` instead of `cfg`; and runtime modules mix `cfg.*` with derived
    constants. Give each option dedicated bounds and use frozen `cfg` consistently.

### C. Security, logging, and error handling

- [ ] Harden the unauthenticated HTTP API and document its exposure
  - `http-server.js` listens on `0.0.0.0` without auth. `GET /api/wake/...` has side effects (any page in a LAN
    browser can trigger it with an `<img src>`, and repeated wakes drain batteries), `POST` accepts any content type,
    there is no `Host` / `Origin` check against DNS rebinding, and `GET /api/config` exposes camera serials to
    containers on the same network. The example Compose file already publishes the port on `127.0.0.1` only.
  - Add optional `BRIDGE_HTTP_TOKEN` Bearer auth, make `GET /api/wake` opt-in (or `POST`-only), require
    `Content-Type: application/json` for `POST`, reject unexpected `Host` values, and document the exposure and
    recommended network setup in `README.md`.

### D. Domain and status card cleanups

- [ ] Encapsulate remaining internal `Camera` sub-model field accesses behind intention-revealing methods
  - `Camera` (`camera.js`) still reads and writes fields directly on its composed `StreamSession`, `BackfillState`,
    `Telemetry`, `FrigateEventFiling`, and `StatusCard` instances. Move remaining field reads/writes behind sub-model
    methods and add all five classes to the cross-model AST guard in `test/camera-coupling.test.js`.
- [ ] Use monomorphic options objects and separate commands from `is*` / `should*` / `get*` queries on `Camera` and
      `Telemetry`
  - `applyMotionTrigger()` / `applyViewTrigger()` take 8 positional args (`camera.js` still carries legacy `max-params`
    suppressions), and `evaluateExternalLivestreamStop()`, `getSessionState()`, `getFrigateEventState()`,
    `shouldEnableRtspProperty()`, `shouldDisableRtspProperty()`, `evaluateUnexpectedRtspStart()`,
    `shouldTurnOffStuckIdleLight()`, `shouldPollFrigateForHoldOrBackfill()`, `checkEarlySleepDue()`,
    `shouldStopUnsolicitedVideo()`, `completeStartupProbeIfReady()`, and `Telemetry.shouldRefreshLowBatteryOnView()`
    mutate state. Use options objects and split pure predicates from explicit commands.
