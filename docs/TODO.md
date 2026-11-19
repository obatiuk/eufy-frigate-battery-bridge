# TODO

## Open

Work order inside each section is suggested priority (standard backlog first, then `(post-v0.0.2)` and `(low)`). Follow
strict TDD (`Red -> Green -> make check`) for every code item and never weaken a locked `AT-*` test. Cite functions and
classes, not line numbers (they drift); find them with `grep`.

- [A. Reliability and runtime bugs](#a-reliability-and-runtime-bugs) - Frigate/Eufy error recovery, housekeeping
  isolation, WebSocket keepalive, clean shutdown, telemetry polling, and FFmpeg resilience
- [B. Configuration and validation](#b-configuration-and-validation) - dedicated clamp bounds, unified `cfg` usage, and
  strict full-repo type-checking
- [C. Security, logging, and error handling](#c-security-logging-and-error-handling) - HTTP API exposure, body and
  timeout limits, RPC and promise hygiene
- [D. Domain and status card cleanups](#d-domain-and-status-card-cleanups) - `Camera` sub-model encapsulation and
  command/query separation

### A. Reliability and runtime bugs

- [ ] Stop treating an unreachable Frigate as "object still active"
  - `isFrigateCameraIdle()` (`frigate-client.js`) returns `false` on timeout, non-2xx, or bad JSON, so
    `evaluateActiveHoldExtension()` (`housekeeping.js`) extends holds to `stream_max_secs` during outages. Return
    tri-state (`idle`, `active`, `unknown`), skip extension and early-sleep confirmation on `unknown`, and test `500`,
    timeout, and invalid JSON.
- [ ] Isolate housekeeping failures per camera and stop masking fatal errors
  - `runHousekeepingTick()` (`housekeeping.js`, every 500ms) has no `try/catch`, so one throw skips every later camera
    and a deterministic throw starves them on every tick while logging about 2 lines per second through the
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
  - `applyDeviceProperties()` (`telemetry-sync.js`) runs on single-key `property changed` events,
    `Telemetry.evaluateRecordingModeChanges()` latches `recordingModeChecked` on any 1 of 4 keys, and one-shot flags /
    `clearLightOn()` commit before `setCameraProperty()` confirms RPC success. Sync recording mode only on full sets,
    return RPC success, commit after success, and test retries.
- [ ] Detect a dead Eufy WebSocket connection with keepalive pings
  - `connectWs()` (`ws-transport.js`) lacks `ping`/`pong`, an inactivity timeout, and `handshakeTimeout`, keeping
    `wsReady` `true` on half-open sockets, and reconnects on a fixed 10s delay. Add `ping` + pong/inactivity timeout,
    `handshakeTimeout`, and jittered reconnect backoff, with tests.
- [ ] Make shutdown wait for camera stops and ignore new triggers
  - `shutdownBridge()` (`app.js`) stops background timers and exits 1.5s after un-awaited `stop()` calls, while
    `trigger()` / `arbitrate()` / `onEvent` lack shutdown guards and `prepareForShutdown()` leaves `viewUntil` set.
    Await pending station transitions (~5s cap), clear `viewUntil`, guard entrypoints with `isShuttingDown()`, and wait
    for in-flight snapshot saves (`saveCachedFrame()` is async, so a save started by the shutdown `stop()` can be cut
    off by `process.exit`; the previous snapshot stays intact).
- [ ] Serialize telemetry polling and stop forcing HomeBase refreshes while a camera is offline
  - `fetchAllCameraTelemetry()` (`telemetry-sync.js`) has no in-flight guard although the poller, viewer joins, the
    initial retry timer, and offline recovery all call it (each run sleeps `POLL_REFRESH_SETTLE_MS`), and it sets
    `shouldRefreshHomeBase` whenever any camera is offline (`AT-07.4` covers online low-battery only).
  - Add an in-flight guard that coalesces callers, rate-limit `driver.poll_refresh` with the 5-minute cooldown when
    `!forceRefresh`, and test call counts.
- [ ] Tighten the hardware-acceleration fallback regex, URL replacer, and shutdown signal in the encoder
  - `HWACCEL_FAILURE_STDERR_REGEX` (`encoder.js`) matches generic `device`, the `{name}` placeholder uses string
    `.replace(..., cam.getName())`, and `Camera.stopEncoderProcess()` sends only `SIGTERM`. Tighten the regex, use a
    function replacer for `{name}`, and add a `SIGKILL` fallback.
- [ ] Make Frigate mask sync safer and louder
  - `syncSingleFrigateMaskSection()` (`frigate-masks.js`) falls back to legacy
    `PUT /api/config/set?cameras.<name>.<section>.mask=<polygon>` and silently skips missing cameras. Remove the
    legacy fallback, warn once per missing camera, and test both paths.
- [ ] Guard `SIGUSR2` synthetic test events against direct `rtsp_url` cameras and empty camera lists
  - `registerSignalHandlers()` (`app.js`) calls `frigateEvent(cams[0], 'test detected')` without skipping `rtsp_url`
    cameras or guarding `!targetCam` (unlike `handleSigUsr1BackfillTest()`). Select the first non-`rtsp_url` camera
    (or guard `!targetCam`), with a unit test.
- [ ] Report `"connecting direct RTSP stream"` when a viewer joins an `rtsp_url` passive probe (post-v0.0.2)
  - `pollViewers()` (`go2rtc-viewers.js`) passes `camActive: cam.isSessionActive()`, already `true` during a `5s`
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
- [ ] Short-circuit oversized HTTP bodies in `readJsonBody()` and close connections on shutdown
  - `readJsonBody()` (`wake-request.js`) keeps reading until `end` after `totalBytes > MAX_JSON_BODY_BYTES` (`16384`)
    and has no body timeout, while `stopHttpServer()` omits `closeAllConnections()`. Return `413` immediately with
    `Connection: close`, add a read timeout, and close sockets on shutdown.
- [ ] Harden the Eufy RPC `call()` and remaining background RPCs
  - `call()` (`ws-transport.js`) can throw synchronously from `ws.send` inside the Promise executor (a rejected promise
    for callers), and `handleVersionMessage()` ignores the `set_api_schema` result.
  - Unchecked floating RPCs remain in `wake.js` (`wakeCameraExternal()` offline refresh) and `housekeeping.js`
    (post-stop `device.get_properties`). Return a settled result from `call()` in every case, add `.catch` handlers,
    check `set_api_schema` RPC results, and test each path.

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
