# TODO

## Open

Work order inside each section is suggested priority. Follow strict TDD (`Red -> Green -> make check`) for every code
item and never weaken a locked `AT-*` test.

- [A. Reliability and runtime bugs](#a-reliability-and-runtime-bugs) - trigger expiry, Frigate/Eufy error recovery,
  boot encoders, healthcheck port, and FFmpeg resilience
- [B. Configuration and validation](#b-configuration-and-validation) - missing-config exit, strict type/format
  validation, and `baseCfg` timer propagation
- [C. Security, logging, and error handling](#c-security-logging-and-error-handling) - HTTP wake auth, credential
  redaction, swallowed service errors, and floating promises
- [D. Domain, backfill, and status card cleanups](#d-domain-backfill-and-status-card-cleanups) - detailed card grey
  placeholders, multi-clip state, transition guards, clip timestamps, and command/query separation
- [E. Release readiness](#e-release-readiness) - Node/version pins and README cache/healthz notes
- [F. Tests, docs, and structure](#f-tests-docs-and-structure) - `README.md` checks, deterministic tests, and `Camera`
  slices

### A. Reliability and runtime bugs

- [ ] Honor the `3s` post-sleep guard before backfill fallthrough on hardware stream-start events
  - In `"backfill"` mode, `'rtsp livestream started'` (`0..3000ms` post-sleep) and `'livestream started'`
    (`250..3000ms` post-sleep, when `tryAdoptExternalP2pWake()` returns `false`) fall through to
    `shouldBackfillOnlyOnEvent()` in `stream-orchestrator.js` (~1435-1452, ~1508-1527), queuing a spurious `BackfillJob`
    (`AT-08.1`). Guard both paths with `isStoppingP2p()` and `EXTERNAL_WAKE_GUARD_MS`.
- [ ] Clear stale offline status on a `>= 10%` battery swap even when still in low-battery range
  - `Telemetry.applyProperties()` (`telemetry.js` ~928-945) keeps `EUFY_DEVICE_STATES.OFFLINE` (`state: 3`) latched when
    battery rises `>= 10%` (`BATTERY_SWAP_DELTA_PCT`) without `charging: true` and stays `<= low_battery_threshold`
    (`2% -> 15%`, `AT-07.3`). Clear offline on `batterySwapped` whenever `!isBatteryDepleted()`.
- [ ] Upgrade or extend an active backfill when `POST /api/wake/:cameras` arrives mid-backfill
  - `queueApiWakeBackfill()` (`stream-orchestrator.js` ~263-278) returns `false` without upgrading or extending when
    `hasPendingBackfill()` or `hasActiveHardwareTriggers()` is already true (`AT-17.1`). Upgrade priority/event metadata
    on an existing `BackfillJob` and return `status: "backfill"`.
- [ ] Refine experimental stuck-spotlight detection (`track_stuck_spotlight`)
  - `shouldTurnOffStuckIdleLight()` and `hasStuckIdleLightPastGrace()` (`camera.js`, disabled by default via
    `track_stuck_spotlight: false`) rely on a fixed `130s` grace and cached `light` events. Account for missed
    `light=false` updates, manual toggles, and active schedules before enabling by default.
- [ ] Expire stale Eufy trigger state when a clear event is lost
  - `activeTriggerEvents` (`camera.js`) only clears on `state: false`, session end (~1521), or `clearPendingBackfill()`
    (~2291-2301), leaving `hasActiveHardwareTriggers()` stuck `true` if `state: false` is lost. Store start timestamps
    in a `Map`, expire past max clip length + margin in housekeeping, clear on WS close (`handleStationDisconnected()`
    ~4016-4020) and offline, and test clock-based expiry.
- [ ] Roll back Frigate event filing when it fails, and keep card suppression exception-safe
  - `frigateEvent()` (`frigate-client.js` ~484-536) calls `completeFrigateEventFiling()` before `POST` (blocking
    subsequent triggers in `COOLDOWN` on errors) and holds clean-snapshot suppression across the 1.5s + 5s review
    lookup. Complete filing only after `POST` succeeds (or reset `evUntil`/`IDLE` and retry once), release suppression
    right after event creation, and test recovery after Frigate `500`.
- [ ] Sync Eufy hardware properties only from full property sets, and retry failed writes
  - `applyDeviceProperties()` (`eufy-client.js` ~799) runs on single-key `property changed` events,
    `Telemetry.evaluateRecordingModeChanges()` (~785-805) sets `recordingModeChecked` when any of the 4 keys arrives,
    and one-shot flags / `clearLightOn()` commit before `setCameraProperty()` (~246-285) confirms RPC success. Sync
    recording mode only on `device.get_properties` (or all 4 keys), return RPC success from `setCameraProperty()`,
    commit flags only after success, and test single-key events + failed RPC retries.
- [ ] Do not wipe the backfill job when an API wake extends a running download
  - `applyViewTrigger()` (`camera.js` ~6239-6248) sets `isMidStreamView` on `DOWNLOAD` sessions past the grace window
    for `api-wake` and calls `clearPendingBackfill()`, wiping `backfillClipQueue`. Restrict `isMidStreamView` and
    `clearPendingBackfill()` to `isActiveLiveSession()` and test a view `api-wake` during a two-clip download.
- [ ] Start every camera's encoder at boot so the Disconnected card is published when eufy-security-ws is down
  - `startEncoder()` only runs on `onDeviceOnlineResume` / `resumeOfflineCameraIfNeeded()`, leaving go2rtc with no feed
    instead of the `AT-18` Grey `Disconnected` card when `eufy-security-ws` is down at boot. Start encoders per camera
    in `createCameras()` / `startBridge()` (`app.js`, keeping offline pause for known-offline cameras) and test boot
    with WS refused.
- [ ] Keep `p2p` mode on `P2P` when `homebase_rtsp_url` is set
  - `resolveCameraTimers()` (`config.js` ~1370-1376) sets `useRtsp = true` whenever `homebase_rtsp_url` is set before
    checking `mode`. Force `useRtsp: false` in `p2p` mode (or reject the pair in `validateConfig()`) and add a test.
- [ ] Stop treating an unreachable Frigate as "object still active"
  - `isFrigateCameraIdle()` (`frigate-client.js` ~551-574) returns `false` on timeout, non-2xx, or bad JSON, causing
    `evaluateActiveHoldExtension()` (`stream-orchestrator.js` 194-251) to extend holds up to `stream_max_secs` during
    Frigate outages. Return tri-state (`idle`, `active`, `unknown`), skip hold extension and confirmation on `unknown`,
    and test Frigate `500`, timeout, and invalid JSON.
- [ ] Wrap every housekeeping step in error handling
  - The 500ms `runHousekeepingTick()` (`stream-orchestrator.js` 1739-1796) has no `try/catch`, so a throw in
    `arbitrate()` or one camera aborts checks for later cameras. Wrap `arbitrate()`, `processBackfillQueue()`, and each
    per-camera tick in `try/catch` with camera-scoped error logs, and test isolation when one camera throws.
- [ ] Make shutdown wait for camera stops and ignore new triggers
  - `shutdownBridge()` (`app.js` 138-152) exits 1.5s after un-awaited `stop()`, `trigger()`/`arbitrate()`/`onEvent` lack
    shutdown guards, and `prepareForShutdown()` leaves `viewUntil` set. Await pending station transitions (bounded ~5s
    timeout), clear `viewUntil`, guard `trigger()`/`arbitrate()` with `isShuttingDownFn()`, stop housekeeping, and close
    the WS before exit.
- [ ] Detect a dead Eufy WebSocket connection with keepalive pings
  - `eufy-client.js` (~951-1025) lacks `ping`/`pong`, inactivity timeouts, and `handshakeTimeout`, keeping `wsReady` and
    `/healthz` green on half-open sockets. Add periodic `ping` + pong/message timeout, `handshakeTimeout`, jittered
    reconnect backoff, and `try/catch` around `new WebSocket(url)`, and test with an unresponsive mock WS.
- [ ] Stop forcing HomeBase refreshes on every telemetry poll while a camera is offline
  - `fetchAllCameraTelemetry()` (`eufy-client.js` ~862-881) sets `shouldRefreshHomeBase` whenever any camera is offline
    (check `AT-07.4` and `services.test.js` ~875-893) and lacks an in-flight guard. Rate-limit station
    `driver.poll_refresh` with the 5-minute offline cooldown, add an in-flight guard, and test call counts.
- [ ] Separate go2rtc health from Frigate API health in the viewer poller
  - `pollViewers()` (`frigate-client.js` ~711-727) and `handleEncoderReconnectMaskSync()` (~375-386) clear
    `frigateApiDown` when go2rtc answers, flapping every 750ms against `syncFrigateMotionMasks()` (~291-303) when
    Frigate is down. Track go2rtc and Frigate API health separately, clear the Frigate flag only after a Frigate API
    response, and test go2rtc up + Frigate down.
- [ ] Reject scheduled API wakes cleanly when the WebSocket drops, and clear existing wake timers
  - `scheduleApiWake()` (`camera.js` ~4267-4278, called from `stream-orchestrator.js` ~398-407) overwrites
    `apiWakeTimer` without `clearTimeout()` and can fire after WS drop. Clear any existing timer in `scheduleApiWake()`,
    re-check `isWsReady()` on fire, roll back bookkeeping on drop, and log a warning.
- [ ] Return clean HTTP errors for malformed wake URLs and oversized/invalid JSON bodies
  - In `http-server.js`, `resolveTargetCameras()` calls `decodeURIComponent()` without `try/catch` (`/api/wake/%` hangs
    the socket), and `readJsonBody()` turns `> 16 KB` or invalid JSON bodies into `{}`. Return `400` JSON on malformed
    URLs or invalid JSON and `413` on oversized bodies (keeping empty bodies valid), with tests.
- [ ] Make the container healthcheck follow the configured HTTP port
  - `config.js` resolves `http_port` (`0` disables the server), while `deploy/Dockerfile` probes static
    `127.0.0.1:${HTTP_PORT:-8080}/healthz` and non-integer ports throw in `listen()`. Use a `node` healthcheck probe
    that reads effective `http_port` (exiting `0` when disabled), document precedence, reject non-integer/empty ports in
    `validateConfig()`, and add tests.
- [ ] Recover when an FFmpeg process fails to spawn
  - `encoder.js` (~565) and `decoder.js` (~337, ~373) only log on child `error` events while detach/restart lives in
    `exit` handlers (~579-622, ~349, ~379), leaving `hasEncoderProcess()` stuck `true` on `ENOENT`/`EAGAIN`/`EMFILE`.
    Detach and schedule a backoff restart on `error` before spawn, and test emitting `error` without `exit`.
- [ ] Add backoff and tighten the hardware-acceleration fallback in the encoder
  - `encoder.js` retries every fixed 3s at error level (~613-621), matches generic `device` in the hwaccel failure regex
    (~47-48), uses unencoded `.replace('{name}', cam.getName())` (~453), and only sends `SIGTERM` on shutdown
    (`camera.js` ~4990-5000). Add retry backoff, tighten the regex, encode `{name}` via function replacer, and add a
    `SIGKILL` shutdown fallback.
- [ ] Cap the queues of compressed packets waiting for the decoder
  - `camera.js` (~4758, ~4783, ~4791) pushes to `pendingVideoPackets` and `pendingAudioPackets` without a cap while
    decoder stdin/stdout is stalled and drains with `O(n)` `shift()` (~4820). Use a bounded ring / drop-oldest policy
    with a debug HUD counter and test with a stalled decoder.
- [ ] Put timeouts on synchronous snapshot FFmpeg calls and move them off the event loop
  - `spawnSync('ffmpeg')` runs without `timeout` in `snapshot-cache.js` (~82, ~152, called from `stop()`). Use async
    `spawn` with a `timeout` (or `timeout` + `killSignal` on `spawnSync`) and write snapshots via temp-file rename.
- [ ] Make Frigate mask sync safer and louder
  - `syncSingleFrigateMaskSection()` (`frigate-client.js` ~173-258) falls back to legacy
    `PUT /api/config/set?cameras.<name>.<section>.mask=<polygon>` and silently skips cameras missing from Frigate's
    `/api/config` (~313-316). Remove the legacy fallback, log one warning per missing camera, and test both paths.
- [ ] Stop an old decoder's exit from resuming the new decoder (low)
  - `handleP2pDecoderExit()` (`decoder.js` ~288-317) calls `cam.resumeDecoderStdout()` before checking
    `detachDecoderIfMatch()`. Only call `resumeDecoderStdout()` when `cam.dec === dec` and add a two-decoder media test.

### B. Configuration and validation

- [ ] Fail loudly when the configuration file is missing
  - `loadConfig()` (`config.js` ~1012-1032) silently boots with a hardcoded placeholder config when
    `/config/config.json` is missing and `BRIDGE_CONFIG` / `CONFIG_PATH` are unset. Log `[ERROR]` and exit non-zero
    when no config file is found, keeping the built-in fixture behind a test env var.
- [ ] Validate configuration value types, formats, and camera identities in `validateConfig()`
  - `clampNum()` (`config.js` ~421) coerces `""`, `[]`, and `true`; `frigate_url` without a scheme, invalid
    `eufy_security_ws_url`, unknown `hwaccel`, arbitrary `startup_snapshot`, out-of-range `enforce_streaming_quality`,
    non-integers, duplicate `name`/`serial`, and unsafe `name` characters pass silently. Validate types, URL schemes,
    enums, integers, unique `name`/`serial`, and `^[A-Za-z0-9_-]+$` `name` pattern in `validateConfig()`.
- [ ] Unify `BridgeConfigBuilder` and module-level config constants so `baseCfg` is honored everywhere
  - `resolveCameraTimers()` (`config.js` ~1398-1475) falls back to module constants instead of `baseCfg`;
    `BridgeConfigBuilder` reuses unrelated clamp constants (~1788-1806); `resolveHardwareRecordingConfig()` checks
    unreachable top-level keys (~1547-1555); and runtime modules mix `cfg.*` with module constants. Resolve fallbacks
    from `baseCfg` and use frozen `cfg` consistently.

### C. Security, logging, and error handling

- [ ] Document and decide on the unauthenticated HTTP API
  - `http-server.js` listens on `0.0.0.0` without auth, allows `GET /api/wake/...`, and exposes serials on
    `GET /api/config` to containers on the `frigate` network. Document exposure in `README.md`, add an optional
    `http_token` Bearer setting (including `deploy/config.schema.json`), and make `GET /api/wake` opt-in or `POST`-only.
- [ ] Centralize secret redaction and newline escaping in `logger.js`
  - The masking regex in `camera.js` (~119, `/:\/\/[^@]+@/`) stops at the first `@`; `decoder.js` (~306-313, ~387-398)
    and `encoder.js` (~602, ~613) log unmasked `ffmpeg` stderr tails; and `logger.js` (~134-141) neither redacts URLs
    nor escapes newlines. Apply one `maskSecrets()` helper (matching userinfo up to the last `@` before the host) and
    newline escaping in `logger.js`, and test `@` in passwords.
- [ ] Log swallowed service-layer errors, handle floating promises, and validate `maxSchemaVersion`
  - Empty catches / unchecked RPCs exist in `pollViewers()` (`frigate-client.js` ~707-709), backfill queries and
    `stop()` (`stream-orchestrator.js` ~775-788, ~942-1001), `eufy-client.js` (~911-916 `Math.min(m.maxSchemaVersion,
21)` `NaN` when missing, ~992-996 JSON parse), and unguarded async callbacks; `unhandledRejection` in `app.js`
    (~169-176) logs `reason` without `reason.stack`. Log `reason.stack || reason`, attach `.catch` handlers, check RPC
    failures, and validate `maxSchemaVersion`.

### D. Domain, backfill, and status card cleanups

- [ ] Show grey placeholders for missing battery, Wi-Fi, and temperature in the `detailed` status card
  - `buildTelemetrySegments()` (`telemetry.js`) omits segments when `hasBat`, `hasWifi || hasRssi`, or `hasTemp` is
    false, while `AT-18` specifies Grey `Not available` across all card themes and `StatusCard.getBounds()` (~270-320)
    derives the mask polygon from segments. Render grey `--` segments in `detailed` (keeping `getBounds()` stable) with
    `domain.test.js` coverage.
- [ ] Stop a queued second clip from flipping `BackfillJob` state from `DOWNLOADING` back to `MATCHED`
  - `enqueueMatchedCandidate()` calls `toMatchedClip()`, transitioning `DOWNLOADING -> MATCHED` (`backfill-job.js`
    ~89-97, ~443-477) while clip 1 plays. Transition to `MATCHED` only from states prior to `DOWNLOADING`, audit
    `pendingBackfill.state` readers, and add a multi-clip test.
- [ ] Guard state-machine transitions and log refused transitions across `BackfillJob` and `Camera`
  - `BackfillJob.upgradeEvent()` (~267-275) mutates `recordingActive = true` and `clearedAt = 0` before
    `transitionTo()`, and `BackfillJob` / `Camera` transition helpers (~1271-1333) silently ignore disallowed
    transitions. Guard `upgradeEvent()` by state, tighten transition maps, and log refused transitions at debug level.
- [ ] Reject timestamp-less backfill clips and verify timezone handling in `parseClipTimestampMs()`
  - `matchesCandidate()` (`backfill-job.js` ~431) accepts any candidate with `!candidate.clipMs`, and
    `parseClipTimestampMs()` (~121-138) parses storage paths in container-local `TZ`. Reject candidates without a parsed
    timestamp (except synthetic urgent test jobs) and test clip matching across two `TZ` values.
- [ ] Use monomorphic options objects and separate state-mutating commands from `is*` / `should*` / `get*` queries
  - `BackfillJob.upgradeEvent()`, `markRecordingCleared()` (~247-323), and `Camera.consumeNextDownloadFrame()`
    (`camera.js` ~4912-4944) overload arguments, `applyMotionTrigger()` / `applyViewTrigger()` take 8 positional args,
    and `isReadyToQuery()`, `isExpired()`, `evaluateExternalLivestreamStop()`, `getSessionState()`,
    `getFrigateEventState()`, `shouldEnableRtspProperty()`, `shouldDisableRtspProperty()`,
    `evaluateUnexpectedRtspStart()`, `shouldTurnOffStuckIdleLight()`, `shouldPollFrigateForHoldOrBackfill()`,
    `checkEarlySleepDue()`, `shouldStopUnsolicitedVideo()`, `completeStartupProbeIfReady()`, and
    `Telemetry.shouldRefreshLowBatteryOnView()` mutate state. Convert wide/overloaded methods to options objects and
    split each mutating query into a pure predicate plus an explicit command method.
- [ ] Make `isUrgentBackfillProtectedFrom` check `this.isBackfillPlayback()` directly (low)
  - `Camera.isUrgentBackfillProtectedFrom()` (`camera.js` ~3764-3766) only checks `!candidateCam.isInMotion(now)`.
    Guard with `this.isBackfillPlayback()` inside the method and test on an idle camera.

### E. Release readiness

- [ ] Align version, Node.js pins, and container build toolchain
  - `package.json` hardcodes `"version": "0.0.1"` while `Makefile` derives `BUILD_VERSION` from git tags; `Makefile`
    uses Node `22.16.0`, the Docker builder uses `node:22-alpine3.23`, and the runtime stage installs Alpine `nodejs`
    plus writes unused `/app/.version`. Derive version from git tags, align Node 22 across `Makefile` and
    `deploy/Dockerfile`, remove `/app/.version`, and commit a lockfile (`.npmrc` disables `package-lock.json`).
- [ ] Document cache folder permissions and `/healthz` restart behavior in `README.md`
  - Document `chown 1000:1000 cache` (for non-root `node` uid `1000` writing `/config/cache`) and note that `/healthz`
    returns `503` while `eufy-security-ws` is disconnected (`AT-08.4`), so `--health-on-failure=restart` or autoheal
    sidecars will restart the container during `eufy-security-ws` outages.

### F. Tests, docs, and structure

- [ ] Bring `README.md` under `make docs-check`
  - Add `README.md` to `DOC_PATHS` in `Makefile` and `WIDTH_FILES` in `scripts/check-docs.js`, run `make format-docs`,
    and wrap remaining lines `> 120` chars.
- [ ] Make tests deterministic and independent of host environment
  - Replace real `setTimeout` waits (`media.test.js` ~237, `services.test.js` ~939-1266 and ~1864-1986,
    `acceptance.test.js`) with injected clocks / `mock.timers`; point `BRIDGE_CONFIG` and `cache_dir` at test fixtures
    before importing `src/`; split the shared-state test in `services.test.js` (~939-1035); and fail in
    `test/reporter.js` on skipped/todo or `0/0` test runs.
- [ ] Split the `Camera` class into focused domain collaborators
  - After release, extract one slice at a time behind unchanged `Camera` methods (and run `make lint-prune` on each):
    debug HUD formatting (`SHORT_*`, `buildDebugHudLines`), media frame/audio/packet buffers, paced API wake
    scheduling, backfill query/download session helpers, Frigate event state machine (`FRIGATE_EVENT_STATES`), and
    `Telemetry` pass-throughs.
- [ ] Small cleanups (low)
  - Count real frame drops in `buildDebugHudLines()` (`DROP:0`) or remove the field; report configured
    `card_show_on_live` alongside effective `suppressLiveCard` in `toConfigSummary()`; reconcile
    `rssiToWifiSignalLevel()` with `Telemetry.applyProperties()` (~888-896) and reset RSSI on offline; drop test-only
    snake_case fallbacks in `StatusCard` (`status-card.js` ~168-174); extract magic numbers in `card-renderer.js`; and
    cap `downloadedPaths` in `camera.js` (~709).
