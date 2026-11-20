# Upstream integrations: `eufy-security-ws`, Frigate, `go2rtc`, and Home Assistant

Read when: changing `src/services/eufy/*`, `src/services/frigate-client.js`, `src/services/frigate-masks.js`,
`src/services/go2rtc-viewers.js`, `src/services/ha-notifier.js`, `src/services/service-versions.js`, or
`src/services/upstream-health.js`.
Related: [stream-lifecycle.md](stream-lifecycle.md), [status-card-and-hud.md](status-card-and-hud.md),
[ACCEPTANCE.md](ACCEPTANCE.md) (`AT-03`, `AT-04`, `AT-07`, `AT-08`, `AT-09`, `AT-10`, `AT-14`, `AT-16`, `AT-17`,
`AT-18`).

## Startup API Version Soft Validation (`src/services/service-versions.js`)

- **Minimum Supported Versions & Protocol Floors (`MIN_SUPPORTED_VERSIONS`):**
  - `Frigate >= 0.14.0` (`GET /api/version` plain text or JSON): required for `GET /api/review` detection-to-review ID
    lookups (introduced in `0.14.0`) and `PUT /api/config/set` mask updates.
  - `go2rtc >= 1.9.0` (`GET /api` -> `version`): required for the `GET /api/streams` `core.Connection` consumer schema
    providing numeric `consumer.id` and `format_name` (`<= 1.8.5` omitted `id`).
  - `eufy-security-ws >= 1.9.9` and `maxSchemaVersion >= 18` (initial WebSocket `type: "version"` frame): required for
    `station.database_query_latest_info` (added in schema `18`) and `station.database_query_by_date` (`1.9.9`).
  - `HA_WEBHOOK_URL` is a fire-and-forget trigger webhook with no unauthenticated version endpoint.
- **Non-Disruptive Startup Guarantees (`verifyUpstreamServiceVersions`, `validateEufyWsVersion`):**
  - Runs asynchronously in `startServices()` after `startHttpServer()` and `markBridgeReady()`, so `/healthz` and
    `BRIDGE_HTTP_PORT=0` `HEALTHCHECK` probes never wait on upstream responses (`AT-08`).
  - Reads at most `64 KB` (`MAX_VERSION_RESPONSE_BYTES`, cancelling streaming bodies immediately), retries transient
    network/`5xx` failures up to `6` times (`10s` `.unref()` timer) for only the unverified service, aborts in-flight
    `fetch` calls immediately on `stopUpstreamVersionChecks()` (`SIGTERM`), ignores non-semver builds (`"dev"`), and
    logs one `[WARN ]` per outdated service (deduplicating identical `eufy-security-ws` reconnect handshakes).

## `eufy-security-ws` Transport, Property Sync & Station Recovery (`src/services/eufy/*`)

- **WebSocket Lifecycle & JSON-RPC (`ws-transport.js`):**
  - Skips connection completely when all configured cameras specify direct `rtsp_url` (`isRtspDirect()`).
  - Connects with a `10s` `handshakeTimeout` plus a `10s` post-open `'version'` frame watchdog, and runs a `30s`
    WebSocket `ping` keepalive loop (`10s` `pong`/inbound-message timeout) that terminates half-open dead sockets.
  - On `'version'`, calls `validateEufyWsVersion(m)`, negotiates `set_api_schema` (`Math.min(m.maxSchemaVersion, 21)`,
    scheduling a reconnect without calling `start_listening` if rejected), and sends `start_listening`. Each `call()`
    assigns `messageId: "b<seq>"` with a `20s` `.unref()` timeout (`WS_RPC_TIMEOUT_MS`, catching synchronous `ws.send`
    throws and resolving `{success: false, errorCode}` without rejecting).
  - On `close`, marks `wsReady = false`, fails pending RPCs, stops active Eufy streams (`error/ws-disconnect`), updates
    camera `wsConnected` health (`Grey` `Disconnected` card), and retries with jittered exponential backoff (`10s`
    initial up to `60s` max, edge-logging the initial outage at `WARN`/`ERROR` and subsequent retries at `DEBUG` while
    `/healthz` stays `200 OK` per `AT-08`).
- **Property Unwrapping & Serialized Hardware Sync (`telemetry-sync.js`):**
  - `unwrapProperty()` normalizes both `{value}` metadata objects and raw scalars across `eufy-security-ws` schemas,
    while `DETECTION_PROPERTY_EVENT_MAP` maps boolean `'property changed'` updates (`motionDetected`, `personDetected`,
    `ringing`, etc.) to canonical trigger names.
  - `setCameraProperty()` chains `device.set_property` calls per camera serial (`propertySyncChains`) so `HomeBase`
    never drops concurrent `P2P` `CMD_SET_PAYLOAD` writes when syncing opted-in `power_mode` (`powerWorkingMode` or
    `recording*`), `streaming_quality` (`videoStreamingQuality` resolved via `device.get_properties_metadata` `states`),
    and `rtspStream` (`AT-10`). Default `power_mode: "keep"` and `streaming_quality: "keep"` send zero writes; whenever
    an opted-in `power_mode` or `streaming_quality` differs from the camera's reported settings, the bridge logs `WARN`
    with the camera's existing settings and target overrides before writing. Permanent device rejections
    (`device_invalid_property`, `device_invalid_property_value`, `device_not_supported`,
    `device_property_not_supported`, `read_only_property`) log once at `WARN` and latch the per-camera check flag so
    unsupported properties never retry on subsequent polls, while transient `no_reply` / `ws_closed` failures retry.
    Enabling `rtspStream: true` when `rtspStreamUrl` is empty immediately follows up with `device.get_properties`.
  - `applyDeviceProperties()` inspects reported Eufy Motion Detection properties (`motionDetection`,
    `motionDetectionType*`, `petDetection`, `loiteringDetection`, `soundDetection`, `cryingDetection`) strictly
    read-only (never calling `device.set_property` on them), exposes them under `telemetry.motion_detection` in
    `GET /api/status`, and logs a deduplicated `WARN` when `motionDetection` is `false` or active `trigger_events`
    categories are disabled in the Eufy app (`AT-10`).
- **Telemetry Refresh & `HomeBase` Station Self-Healing (`telemetry-sync.js`, `station-recovery.js`):**
  - `fetchAllCameraTelemetry()` coalesces concurrent callers onto one active pass (queuing one forced follow-up if
    `forceRefresh=true` arrives mid-flight) and issues `driver.poll_refresh` (`2s` `POLL_REFRESH_SETTLE_MS`) when
    forced or at most once per `60` minutes (`OFFLINE_POLL_REFRESH_COOLDOWN_MS`) while any Eufy camera is offline due to
    a recoverable power/link/timeout condition (`shouldPollRefreshWhileOffline()`, skipping `state: 2/4/5` manually
    disabled or unpaired cameras) before querying `device.get_properties` per camera.
  - `ensureInitialDriverAndStationConnected()` checks `driver.is_connected` and `station.is_connected` after
    `start_listening` and dispatches `driver.connect` / `station.connect` when disconnected.
  - If `driver.poll_refresh` fails, `station.is_connected` times out (`no_reply`), a `P2P` wake stalls to retry `>= 2`
    with zero device events, or an `RTSP` wake retry toggle (`rtspStream: false -> true`) still yields an empty
    `rtspStreamUrl`, `recoverUnresponsiveStation()` recycles wedged station sessions via
    `station.disconnect -> station.connect` (`60s` `STATION_RECOVERY_COOLDOWN_MS`, skipped whenever any camera on that
    station is actively decoding video) and resets per-camera hardware sync flags (`resetStationSyncFlags`).

## `Frigate` HTTP Integration (`src/services/frigate-client.js`, `src/services/frigate-masks.js`)

- **External Events, Clean Snapshot Fallback & Review Lookup (`frigateEvent`):**
  - Coalesces companion triggers over `600ms` (`EVENT_DISPATCH_DELAY_MS`, upgrading `"motion"` -> `"person"` / `"car"` /
    `"dog"` and attaching `HomeBase 3` recognized face names via `tryUpgradeOrQueueFrigateEvent`).
  - Waits for sustained decoded video (`1s` `FAST_LIVE_SNAP_DELAY_MS` when `instant_event_snapshot: true`, `0.8s`
    `BACKFILL_SNAP_DELAY_MS` on backfill playback, or `snapshot_capture_delay_secs`). If a session aborts without video,
    the pending snapshot wait cancels cleanly (`isFrigateSnapshotWaitActive`); if a wake times out without video while
    still filing, `enableCleanSnapshotCardSuppression()` suppresses the status card for `450ms` so Frigate captures an
    un-overlayed cached snapshot (`AT-17`).
  - Posts `POST /api/events/<cam>/<label>/create` (`source_type: "api"`, `duration`, `include_recording: true`, and
    optional `sub_label` face name, rolling back event cooldown to `IDLE` if the `POST` fails and releasing clean
    snapshot card suppression immediately after the `POST`), then waits `1.5s` (`REVIEW_LOOKUP_DELAY_MS`) and queries
    `GET /api/review?cameras=<cam>&limit=5` to match `data.detections` and forward `review_id` to Home Assistant.
- **Active Object Hold Polling (`isFrigateCameraIdle`, `FRIGATE_CAMERA_STATES`):** Queries
  `GET /api/events?cameras=<cam>&limit=10` (`2.5s` `FRIGATE_FAST_QUERY_TIMEOUT_MS`) and returns `'idle'`, `'active'`, or
  `'unknown'` (on timeout, non-`2xx`, or malformed JSON) so outages neither extend holds to `stream_max_secs` nor
  confirm early battery-saver sleep (`AT-11`, `AT-12`).
- **Named Auto-Mask Sync (`syncFrigateMotionMasks`):**
  - Runs on initial telemetry load, every `60s` (`MASK_SYNC_INTERVAL_MS`), and `6s` after encoder drop recovery.
  - Fetches `GET /api/config` (`5s` timeout) to track `frigateConnected` service health (`AT-08`, `AT-18`) and inspect
    each camera's `motion.mask` and `objects.mask`.
  - Applies normalized card polygons (`6px` chroma safety margin) via JSON `PUT /api/config/set` (`8s` timeout,
    `requires_restart: 0`) using named `eufy_bridge_card` mask entries (`friendly_name: "Eufy Bridge Status Card"`),
    and warns once per episode when a configured camera name is absent from `Frigate`'s `cameras` dictionary.
  - When `card_theme: "none"` or `card_position: "center"`, deletes only `eufy_bridge_card` (`maskEntry: ""`), leaving
    user-defined masks untouched (`AT-17`). When `Frigate` recovers from an outage, re-verifies masks and calls
    `seedOfflineCameraSnapshots()`.

## `go2rtc` Viewer Polling (`src/services/go2rtc-viewers.js`) & `HA_WEBHOOK_URL` (`src/services/ha-notifier.js`)

- **Bulk Stream Poll & Viewer Classification (`pollViewers`, every `750ms`):**
  - Queries `GET /api/streams` once per tick (`2.5s` timeout) for all cameras, tracking `go2rtcConnected` health,
    re-seeding offline snapshots on recovery, and warning once per episode if `go2rtc` returns a reachable but unusable
    payload.
  - Filters out internal recorder consumers matching `/FFmpeg Frigate|^go2rtc/i` (`INTERNAL_RECORDER_USER_AGENT_REGEX`)
    and tracks human `WebRTC` / `MSE` / `MP4` / `HLS` viewers by `consumer.id` (triggering an immediate `15 fps`
    keyframe burst on attach).
  - Treats simultaneous attaches across multiple cameras (`distinctNewCams.size > 1 && activeViewerCams.length > 1`) as
    a multi-camera dashboard grid and ignores them (`AT-14`, except direct `rtsp_url` cameras which always connect).
  - Single-camera viewer activity on an offline Eufy camera triggers an immediate `fetchAllCameraTelemetry(true)`
    `HomeBase` refresh (`shouldRefreshOfflineOnView`) to detect swapped/recharged batteries (`AT-07`).
  - `classifyViewerAction()` evaluates offline state, pending `BackfillJob` blocks (`AT-03`, `AT-04`), active
    same-station `P2P` motion, Low-Battery Saver (`!canWakeOnViewerInLowBattery`), and `view_cooldown_secs` (`AT-09`)
    before waking or preempting (`newestViewerCam` wins when switching `P2P` cameras on the same station).
- **Two-Stage Home Assistant Webhook (`notifyHA`):** When `HA_WEBHOOK_URL` is configured, sends a `5s`-bounded JSON
  `POST` immediately on trigger (`camera`, `title`, `label`, `person`) and a second `POST` after Frigate event creation
  adding `event_id`, `review_id`, and `no_video`, logging `[WARN ]` with a `1 KB`-bounded error snippet on failure
  without interrupting Frigate event creation (`AT-17`).
