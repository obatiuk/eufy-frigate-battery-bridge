# TODO

## Open

Work order inside each section is suggested priority (standard backlog first, then `(post-v0.0.2)` and `(low)`). Follow
strict TDD (`Red -> Green -> make check`) for every code item and never weaken a locked `AT-*` test.

- [A. Reliability and runtime bugs](#a-reliability-and-runtime-bugs) - Frigate/Eufy error recovery, WebSocket keepalive,
  clean shutdown, snapshot timeouts, and FFmpeg resilience
- [B. Configuration and validation](#b-configuration-and-validation) - startup type, URL scheme, and identity checks,
  plus dedicated clamp bounds
- [C. Security, logging, and error handling](#c-security-logging-and-error-handling) - HTTP body/timeout limits,
  swallowed errors, floating promises, and HTTP auth
- [D. Domain and status card cleanups](#d-domain-and-status-card-cleanups) - `Camera` FSM transition logging and
  command/query separation
- [E. Tests, docs, and structure](#e-tests-docs-and-structure) - deterministic timer tests, `Camera` decomposition, and
  minor cleanups

### A. Reliability and runtime bugs

- [ ] Stop treating an unreachable Frigate as "object still active"
  - `isFrigateCameraIdle()` (`frigate-client.js` ~592-611) returns `false` on timeout, non-2xx, or bad JSON, so
    `evaluateActiveHoldExtension()` (`stream-orchestrator.js` ~196-247) extends holds to `stream_max_secs` during
    outages. Return tri-state (`idle`, `active`, `unknown`), skip extension/confirmation on `unknown`, and test `500`,
    timeout, and invalid JSON.
- [ ] Roll back Frigate event filing when it fails, and keep card suppression exception-safe
  - `frigateEvent()` (`frigate-client.js` ~479-582) runs `enableCleanSnapshotCardSuppression()` (~520) and
    `completeFrigateEventFiling()` (~525) before `POST` outside `try/finally` (sticking triggers in `COOLDOWN` on
    errors) and holds suppression across the 1.5s + 5s review lookup. Commit filing after `POST` succeeds (or reset
    `evUntil` / `IDLE` and retry once), release suppression right after `POST` in `try/finally`, and test `500`
    recovery.
- [ ] Sync Eufy hardware properties only from full property sets, and retry failed writes
  - `applyDeviceProperties()` (`eufy-client.js` ~785-798) runs on single-key `property changed` events,
    `Telemetry.evaluateRecordingModeChanges()` (`telemetry.js` ~721-741) latches `recordingModeChecked` on any 1 of 4
    keys, and one-shot flags / `clearLightOn()` commit before `setCameraProperty()` (~243-284) confirms RPC success.
    Sync recording mode only on full sets, return RPC success, commit after success, and test retries.
- [ ] Detect a dead Eufy WebSocket connection with keepalive pings
  - `eufy-client.js` (~975-1061) lacks `ping`/`pong`, inactivity timeouts, and `handshakeTimeout`, keeping `wsReady` and
    `/healthz` green on half-open sockets. Add `ping` + pong/inactivity timeout, `handshakeTimeout`, jittered reconnect
    backoff, and `try/catch` around `new WebSocket(url)`, with tests.
- [ ] Wrap every housekeeping step in error handling
  - The 500ms `runHousekeepingTick()` (`stream-orchestrator.js` ~1706-1764) lacks `try/catch`, so one exception aborts
    later cameras. Wrap `arbitrate()`, `processBackfillQueue()`, and each per-camera tick in `try/catch` with scoped
    error logs, and test isolation.
- [ ] Make shutdown wait for camera stops and ignore new triggers
  - `shutdownBridge()` (`app.js` ~128-142) exits 1.5s after un-awaited `stop()`, `trigger()`/`arbitrate()`/`onEvent`
    lack shutdown guards, and `prepareForShutdown()` leaves `viewUntil` set. Await pending station transitions (~5s
    cap), clear `viewUntil`, guard entrypoints with `isShuttingDownFn()`, stop housekeeping, and close the WS.
- [ ] Stop forcing HomeBase refreshes on every telemetry poll while a camera is offline
  - `fetchAllCameraTelemetry()` (`eufy-client.js` ~860-907) sets `shouldRefreshHomeBase` whenever any camera is offline
    (`AT-07.4` covers online low-battery; `services.test.js` ~1136-1802 clears `lastLowBatRefreshAt`) and lacks an
    in-flight guard. Rate-limit `driver.poll_refresh` with the 5-minute cooldown when `!forceRefresh`, add an in-flight
    guard, and test call counts.
- [ ] Tighten the hardware-acceleration fallback regex, URL replacer, and shutdown signal in the encoder
  - `encoder.js` matches generic `device` in `HWACCEL_FAILURE_STDERR_REGEX` (~47-48), uses string `.replace('{name}',
cam.getName())` (~549), and `stopEncoderProcess()` (`camera.js` ~5220-5230) sends only `SIGTERM`. Tighten the regex,
    use a function replacer for `{name}`, and add a `SIGKILL` fallback.
- [ ] Put timeouts on synchronous snapshot FFmpeg calls and move them off the event loop
  - `spawnSync('ffmpeg')` runs without `timeout` in `snapshot-cache.js` (~90-96, ~155-174, called from `stop()`). Use
    async `spawn` with `timeout` (or `timeout` + `killSignal` on `spawnSync`) and atomic temp-file rename.
- [ ] Make Frigate mask sync safer and louder
  - `syncSingleFrigateMaskSection()` (`frigate-client.js` ~229-297) falls back to legacy
    `PUT /api/config/set?cameras.<name>.<section>.mask=<polygon>` and silently skips missing cameras (~354-357). Remove
    the legacy fallback, warn once per missing camera, and test both paths.
- [ ] Guard `SIGUSR2` synthetic test events against direct `rtsp_url` cameras and empty camera lists
  - `registerSignalHandlers()` (`app.js` ~150-153) logs and calls `frigateEvent(cams[0], 'test detected')` on `SIGUSR2`
    without skipping `rtsp_url` cameras or guarding `!targetCam` (unlike `handleSigUsr1BackfillTest()` ~103-108). Select
    the first non-`rtsp_url` camera (or guard `!targetCam`), with a unit test.
- [ ] Report `"connecting direct RTSP stream"` when a viewer joins an `rtsp_url` passive probe (post-v0.0.2)
  - `pollViewers()` (`frigate-client.js` ~803-816) passes `camActive: cam.isSessionActive()`, already `true` during a
    `5s` passive probe (`isPassiveRtspDirectProbe()`, `camera.js` ~2314-2318), logging `"streaming direct RTSP"` with
    `asked: false` before Frame 0 decodes. Treat an un-decoded probe as connecting and keep `AT-14` coverage intact.
- [ ] Smooth multi-camera grid attaches and `h264_qsv` low-latency framing (post-v0.0.2)
  - `buildVideoCodecArgs()` (`encoder.js` ~439-453) omits `-bf 0` on `h264_qsv` (unlike `vaapi`), and Grid View calls
    `registerNewViewer()` (`frigate-client.js` ~733-734) across all tiles while `shouldWriteEncoderFrame()` (`camera.js`
    ~5338-5354) bursts frames between live decodes. Add `-bf 0` to `qsv`, smooth burst jitter, and verify `AT-14` /
    `AT-18`.
- [ ] Refine experimental stuck-spotlight detection (`track_stuck_spotlight`) (low)
  - `shouldTurnOffStuckIdleLight()` (`camera.js` ~3452-3475) and `hasStuckIdleLightPastGrace()` (~3057-3075, disabled
    by default) rely on a fixed `130s` grace and cached `light` events. Handle missed `light=false` updates, manual
    toggles, and active schedules before enabling by default.

### B. Configuration and validation

- [ ] Validate configuration value types, URL schemes, and camera identities in `validateConfig()` and env resolvers
  - `clampNum()` (`config.js` ~404-410) coerces `""`, `[]`, and `true`; invalid `FRIGATE_URL` / `EUFY_WS_URL` schemes,
    unknown `BRIDGE_HWACCEL`, invalid `startup_snapshot`, out-of-range `enforce_streaming_quality`, non-integers,
    duplicate `name`/`serial`, and unsafe `name` characters pass silently. Validate all at startup.
- [ ] Use dedicated clamp constants in `BridgeConfigBuilder` and unify `cfg` usage (low)
  - `BridgeConfigBuilder.withTimersAndArbitration()` (`config.js` ~2282-2328) reuses unrelated clamp constants;
    exported resolvers default `baseCfg` to `rawLoadedCfg` instead of `cfg`; and runtime modules mix `cfg.*` with
    derived constants. Give each option dedicated bounds and use frozen `cfg` consistently.

### C. Security, logging, and error handling

- [ ] Short-circuit oversized HTTP bodies in `readJsonBody()` and close connections on shutdown
  - `readJsonBody()` (`http-server.js` ~181-250) waits for `end` after `totalBytes > MAX_JSON_BODY_BYTES` (`16384`) and
    lacks a body timeout, while `stopHttpServer()` (~615-625) omits `closeAllConnections()`. Return `413` immediately
    with `Connection: close`, add a read timeout, and close sockets on shutdown.
- [ ] Handle remaining floating promises, unchecked background RPCs, and `maxSchemaVersion` validation
  - Unchecked background RPCs / floating promises remain in `stream-orchestrator.js` (`wakeCameraExternal()` offline
    refresh ~343-351, post-stop `device.get_properties` ~1065-1070) and `eufy-client.js` (~958
    `Math.min(m.maxSchemaVersion, 21)` `NaN`, async `message` listener). Add `.catch` handlers, check RPC results, and
    validate `maxSchemaVersion`.
- [ ] Document and decide on the unauthenticated HTTP API
  - `http-server.js` listens on `0.0.0.0` without auth, allows `GET /api/wake/...`, and exposes serials on
    `GET /api/config` to containers on the `frigate` network. Document exposure in `README.md`, add optional
    `BRIDGE_HTTP_TOKEN` Bearer auth, and make `GET /api/wake` opt-in or `POST`-only.

### D. Domain and status card cleanups

- [ ] Log refused state-machine transitions across `Camera` FSM helpers
  - `Camera` transition helpers (`transitionTo()`, `_transitionDecoderTo()`, and `_transitionFrigateEventTo()` in
    `camera.js` ~1355-1420) silently ignore disallowed transitions instead of logging refused transitions at debug
    level.
- [ ] Use monomorphic options objects and separate commands from `is*` / `should*` / `get*` queries on `Camera` and
      `Telemetry`
  - `applyMotionTrigger()` / `applyViewTrigger()` take 8 positional args, and `evaluateExternalLivestreamStop()`,
    `getSessionState()`, `getFrigateEventState()`, `shouldEnableRtspProperty()`, `shouldDisableRtspProperty()`,
    `evaluateUnexpectedRtspStart()`, `shouldTurnOffStuckIdleLight()`, `shouldPollFrigateForHoldOrBackfill()`,
    `checkEarlySleepDue()`, `shouldStopUnsolicitedVideo()`, `completeStartupProbeIfReady()`, and
    `Telemetry.shouldRefreshLowBatteryOnView()` mutate state. Use options objects and split pure predicates from
    explicit commands.

### E. Tests, docs, and structure

- [ ] Make tests deterministic and independent of host environment
  - Replace real `setTimeout` waits (`media.test.js` ~253, `services.test.js` ~1451-1729, ~2346-2599, ~2816,
    `acceptance.test.js`) with injected clocks / `mock.timers`; isolate `BRIDGE_CONFIG` fixtures before importing
    `src/`; split the shared-state test in `services.test.js` (~1136-1802); and fail in `test/reporter.js` on
    skipped/todo or `0/0` runs.
- [ ] Split the `Camera` class into focused domain collaborators (post-v0.0.2)
  - Extract one slice at a time behind unchanged `Camera` methods (and run `make lint-prune` on each): debug HUD
    formatting (`SHORT_*`, `buildDebugHudLines`), media buffers, paced API wake scheduling, backfill query/download
    helpers, Frigate event FSM (`FRIGATE_EVENT_STATES`), and `Telemetry` pass-throughs.
- [ ] Small cleanups (low)
  - Reconcile `rssiToWifiSignalLevel()` (`telemetry.js` ~220-225) with `Telemetry.applyProperties()` (~830-838) and
    reset RSSI on offline; drop unused snake_case fallbacks in `StatusCard` (`status-card.js` ~209-210).
