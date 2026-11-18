# TODO

## Open

Work order inside each section is suggested priority (standard backlog first, then `(post-v0.0.2)` and `(low)`). Follow
strict TDD (`Red -> Green -> make check`) for every code item and never weaken a locked `AT-*` test. Cite functions and
classes, not line numbers (they drift); find them with `grep`.

- [A. Reliability and runtime bugs](#a-reliability-and-runtime-bugs) - Frigate/Eufy error recovery, housekeeping
  isolation, WebSocket keepalive, clean shutdown, telemetry polling, and FFmpeg resilience
- [B. Configuration and validation](#b-configuration-and-validation) - dedicated clamp bounds and unified `cfg` usage
- [C. Security, logging, and error handling](#c-security-logging-and-error-handling) - HTTP API exposure, body and
  timeout limits, RPC and promise hygiene
- [D. Domain and status card cleanups](#d-domain-and-status-card-cleanups) - `Camera` FSM transition logging and
  command/query separation
- [E. Tests, docs, and structure](#e-tests-docs-and-structure) - deterministic tests, module decomposition, doc size
  budgets, and minor cleanups

### A. Reliability and runtime bugs

- [ ] Stop treating an unreachable Frigate as "object still active"
  - `isFrigateCameraIdle()` (`frigate-client.js`) returns `false` on timeout, non-2xx, or bad JSON, so
    `evaluateActiveHoldExtension()` (`stream-orchestrator.js`) extends holds to `stream_max_secs` during outages.
    Return tri-state (`idle`, `active`, `unknown`), skip extension and early-sleep confirmation on `unknown`, and test
    `500`, timeout, and invalid JSON.
- [ ] Isolate housekeeping failures per camera and stop masking fatal errors
  - `runHousekeepingTick()` (`stream-orchestrator.js`, every 500ms) has no `try/catch`, so one throw skips every later
    camera and a deterministic throw starves them on every tick while logging about 2 lines per second through the
    `uncaughtException` handler in `app.js`.
  - Wrap `arbitrate()`, `processBackfillQueue()`, and each per-camera step in `try/catch` with a rate-limited scoped
    error log, test that a throwing camera does not block the others, and decide whether `uncaughtException` should
    keep the "service continuing" policy or exit so the container restarts into a clean state.
- [ ] Roll back Frigate event filing when it fails, and keep card suppression exception-safe
  - `frigateEvent()` (`frigate-client.js`) calls `completeFrigateEventFiling()` before the `POST` and holds
    `enableCleanSnapshotCardSuppression()` across the 1.5s + 5s review lookup, so a failed `POST` leaves triggers
    stuck in `COOLDOWN`. Commit filing after `POST` succeeds (or reset `evUntil` / `IDLE` and retry once), release
    suppression right after `POST` in `try/finally`, and test `500` recovery.
- [ ] Sync Eufy hardware properties only from full property sets, and retry failed writes
  - `applyDeviceProperties()` (`eufy-client.js`) runs on single-key `property changed` events,
    `Telemetry.evaluateRecordingModeChanges()` latches `recordingModeChecked` on any 1 of 4 keys, and one-shot flags /
    `clearLightOn()` commit before `setCameraProperty()` confirms RPC success. Sync recording mode only on full sets,
    return RPC success, commit after success, and test retries.
- [ ] Detect a dead Eufy WebSocket connection with keepalive pings
  - `connectWs()` (`eufy-client.js`) lacks `ping`/`pong`, an inactivity timeout, and `handshakeTimeout`, keeping
    `wsReady` `true` on half-open sockets, and reconnects on a fixed 10s delay. Add `ping` + pong/inactivity timeout,
    `handshakeTimeout`, and jittered reconnect backoff, with tests.
- [ ] Make shutdown wait for camera stops and ignore new triggers
  - `shutdownBridge()` (`app.js`) exits 1.5s after un-awaited `stop()` calls, `trigger()` / `arbitrate()` / `onEvent`
    lack shutdown guards, and `prepareForShutdown()` leaves `viewUntil` set. Await pending station transitions (~5s
    cap), clear `viewUntil`, guard entrypoints with `isShuttingDownFn()`, stop housekeeping, viewer, and telemetry
    timers, wait for in-flight snapshot saves (`saveCachedFrame()` is now async, so a save started by the shutdown
    `stop()` can be cut off by `process.exit`; the previous snapshot stays intact), and close the WebSocket.
- [ ] Serialize telemetry polling and stop forcing HomeBase refreshes while a camera is offline
  - `fetchAllCameraTelemetry()` (`eufy-client.js`) has no in-flight guard although the poller, viewer joins, the
    initial retry timer, and offline recovery all call it (each run sleeps `POLL_REFRESH_SETTLE_MS`), and it sets
    `shouldRefreshHomeBase` whenever any camera is offline (`AT-07.4` covers online low-battery only).
  - Add an in-flight guard that coalesces callers, rate-limit `driver.poll_refresh` with the 5-minute cooldown when
    `!forceRefresh`, and test call counts (the shared-state tests that clear `lastLowBatRefreshAt` need splitting).
- [ ] Tighten the hardware-acceleration fallback regex, URL replacer, and shutdown signal in the encoder
  - `HWACCEL_FAILURE_STDERR_REGEX` (`encoder.js`) matches generic `device`, the `{name}` placeholder uses string
    `.replace(..., cam.getName())`, and `Camera.stopEncoderProcess()` sends only `SIGTERM`. Tighten the regex, use a
    function replacer for `{name}`, and add a `SIGKILL` fallback.
- [ ] Make Frigate mask sync safer and louder
  - `syncSingleFrigateMaskSection()` (`frigate-client.js`) falls back to legacy
    `PUT /api/config/set?cameras.<name>.<section>.mask=<polygon>` and silently skips missing cameras. Remove the
    legacy fallback, warn once per missing camera, and test both paths.
- [ ] Guard `SIGUSR2` synthetic test events against direct `rtsp_url` cameras and empty camera lists
  - `registerSignalHandlers()` (`app.js`) calls `frigateEvent(cams[0], 'test detected')` without skipping `rtsp_url`
    cameras or guarding `!targetCam` (unlike `handleSigUsr1BackfillTest()`). Select the first non-`rtsp_url` camera
    (or guard `!targetCam`), with a unit test.
- [ ] Report `"connecting direct RTSP stream"` when a viewer joins an `rtsp_url` passive probe (post-v0.0.2)
  - `pollViewers()` (`frigate-client.js`) passes `camActive: cam.isSessionActive()`, already `true` during a `5s`
    passive probe (`isPassiveRtspDirectProbe()`), logging `"streaming direct RTSP"` with `asked: false` before Frame 0
    decodes. Treat an un-decoded probe as connecting and keep `AT-14` coverage intact.
- [ ] Smooth multi-camera grid attaches and `h264_qsv` low-latency framing (post-v0.0.2)
  - `buildVideoCodecArgs()` (`encoder.js`) omits `-bf 0` on `h264_qsv` (unlike `vaapi`), and Grid View calls
    `registerNewViewer()` across all tiles while `shouldWriteEncoderFrame()` bursts frames between live decodes. Add
    `-bf 0` to `qsv`, smooth burst jitter, and verify `AT-14` / `AT-18`.
- [ ] Refine experimental stuck-spotlight detection (`track_stuck_spotlight`) (low)
  - `shouldTurnOffStuckIdleLight()` and `hasStuckIdleLightPastGrace()` (disabled by default) rely on a fixed `130s`
    grace and cached `light` events. Handle missed `light=false` updates, manual toggles, and active schedules before
    enabling by default.

### B. Configuration and validation

- [ ] Use dedicated clamp constants in `BridgeConfigBuilder` and unify `cfg` usage (low)
  - `BridgeConfigBuilder.withTimersAndArbitration()` (`config.js`) reuses unrelated clamp constants; exported
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
- [ ] Short-circuit oversized HTTP bodies in `readJsonBody()` and close connections on shutdown
  - `readJsonBody()` (`http-server.js`) keeps reading until `end` after `totalBytes > MAX_JSON_BODY_BYTES` (`16384`)
    and has no body timeout, while `stopHttpServer()` omits `closeAllConnections()`. Return `413` immediately with
    `Connection: close`, add a read timeout, and close sockets on shutdown.
- [ ] Harden the Eufy RPC `call()` and remaining background RPCs
  - `call()` (`eufy-client.js`) can throw synchronously from `ws.send` inside the Promise executor (a rejected promise
    for callers), `handleVersionMessage()` ignores the `set_api_schema` result and passes an unchecked
    `Math.min(m.maxSchemaVersion, ...)` (`NaN` on bad input), and the async `message` listener has no `.catch`.
  - Unchecked floating RPCs remain in `stream-orchestrator.js` (`wakeCameraExternal()` offline refresh, post-stop
    `device.get_properties`). Return a settled result from `call()` in every case, add `.catch` handlers, check RPC
    results, validate `maxSchemaVersion`, and test each path.

### D. Domain and status card cleanups

- [ ] Log refused state-machine transitions across `Camera` FSM helpers
  - `Camera` transition helpers (`transitionTo()`, `_transitionDecoderTo()`, and `_transitionFrigateEventTo()`)
    silently ignore disallowed transitions instead of logging refused transitions at debug level.
- [ ] Use monomorphic options objects and separate commands from `is*` / `should*` / `get*` queries on `Camera` and
      `Telemetry`
  - `applyMotionTrigger()` / `applyViewTrigger()` take 8 positional args (`camera.js` has 23 `max-params`
    suppressions), and `evaluateExternalLivestreamStop()`, `getSessionState()`, `getFrigateEventState()`,
    `shouldEnableRtspProperty()`, `shouldDisableRtspProperty()`, `evaluateUnexpectedRtspStart()`,
    `shouldTurnOffStuckIdleLight()`, `shouldPollFrigateForHoldOrBackfill()`, `checkEarlySleepDue()`,
    `shouldStopUnsolicitedVideo()`, `completeStartupProbeIfReady()`, and `Telemetry.shouldRefreshLowBatteryOnView()`
    mutate state. Use options objects and split pure predicates from explicit commands.

### E. Tests, docs, and structure

- [ ] Make tests deterministic and independent of host environment
  - Replace the real `setTimeout` / `sleep` waits (about 47 across `media.test.js`, `services.test.js`, and
    `acceptance.test.js`) with injected clocks / `mock.timers`; isolate `BRIDGE_CONFIG` fixtures before importing
    `src/`; split the shared-state test in `services.test.js` (the telemetry refresh test); and fail in
    `test/reporter.js` on skipped/todo or `0/0` runs.
- [ ] Keep documentation inside its size budgets and without duplicated text
  - `docs/REGRESSION.md` is about 18 KB of the 20 KB `docs-check` limit; shorten rows to one line per entry or split
    the index before the next fix lands. `README.md` is about 66 KB with no size check: add a budget to
    `scripts/check-docs.js`, and audit the Configuration Reference and Advanced Settings sections against
    `docs/config-modes.md`, keeping one home per fact and linking to it.
- [ ] Split the `Camera` class into focused domain collaborators (post-v0.0.2)
  - `camera.js` is about 8,000 lines with about 340 methods. Extract one slice at a time behind unchanged `Camera`
    methods (and run `make lint-prune` on each): debug HUD formatting (`SHORT_*`, `buildDebugHudLines`), media
    buffers, paced API wake scheduling, backfill query/download helpers, Frigate event FSM (`FRIGATE_EVENT_STATES`),
    and `Telemetry` pass-throughs.
- [ ] Split `src/config.js` into schema, validation, and builder modules (post-v0.0.2)
  - `config.js` is about 2,900 lines with 43 `no-magic-numbers` and several `complexity` / `max-lines` suppressions.
    Separate YAML/env loading, `validateConfig()`, `BridgeConfigBuilder`, and the exported resolvers while keeping the
    frozen `cfg` singleton and the single-pass validation rule.
- [ ] Small cleanups (low)
  - Reconcile `rssiToWifiSignalLevel()` (`telemetry.js`) with `Telemetry.applyProperties()` and reset RSSI on offline;
    drop unused snake_case fallbacks in `StatusCard` (`status-card.js`).
