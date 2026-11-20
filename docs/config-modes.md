# Configuration and camera modes

Read when: changing `src/config/*`, `deploy/config.*.yaml`, camera modes, timers, Power Manager sync, or validation.
Related: [ACCEPTANCE.md](ACCEPTANCE.md) (`AT-05`, `AT-10`, `AT-12`, `AT-19`), [README.md](../README.md) configuration
reference, [config.schema.json](../deploy/config.schema.json).
Sync targets when adding, renaming, or changing any option default or bound: `src/config/` (`constants.js`,
`BridgeConfigBuilder`, and `resolveCameraConfig()`), [config.schema.json](../deploy/config.schema.json),
[config.example.minimal.yaml](../deploy/config.example.minimal.yaml),
[config.example.full.yaml](../deploy/config.example.full.yaml), and the configuration tables in
[README.md](../README.md) (`test/config/config.test.js` enforces schema default parity).

## Camera Modes (`resolveCameraMode`) & Defensive Validation

When loading `config.yaml` from disk (`BRIDGE_CONFIG`, defaulting to `/config/config.yaml` or `./config.yaml`),
`loadConfigFile()` parses YAML via `js-yaml`, expands `${ENV_VAR}` and `${ENV_VAR:-default}` placeholders across all
string values via `expandConfigEnvVars()` (escaping literal `$${...}` and failing in a single pass when any required
variable is unset or empty or any unescaped placeholder is malformed or unclosed), and validates the camera topology in
one pass via `validateConfig()`. External service
endpoints (`EUFY_WS_*`, `FRIGATE_*`, `GO2RTC_*`, `HA_WEBHOOK_URL`) and container runtime settings (`BRIDGE_LOG_LEVEL`,
`BRIDGE_HTTP_PORT`, `BRIDGE_CACHE_DIR`, `BRIDGE_HWACCEL`, `BRIDGE_HWACCEL_DEVICE`, `BRIDGE_VERSION`, `BRIDGE_COMMIT`)
are resolved exclusively from environment variables via `resolveServiceEndpoints()` and `resolveRuntimeEnv()`. Each
camera in `cameras[]` normalizes its identity via `CameraConfig.normalizeIdentity()` (`name` defaults to `serial` when
omitted) and resolves its operating mode via `resolveCameraMode(camConfig)`:

- `"auto"` (default): Uses HomeBase native `RTSP` (`rtspStreamUrl`) when supported by the camera (unless `use_rtsp:
false` is set), resolves to `"rtsp"` when explicit `rtsp_url` is configured, or uses live `P2P` otherwise, with
  automatic HomeBase clip backfill when busy or interrupted (default `hold_secs: 30`, `end_early: true`, or mirrored
  from Eufy hardware telemetry under `power_mode: "keep"`).
- `"rtsp"`: Uses HomeBase native `RTSP` (`useRtsp: true`, `alwaysBackfill: false`, default `hold_secs: 30`,
  `end_early: true`) auto-discovered via `eufy-security-ws` `rtspStreamUrl` when `rtsp_url` is omitted. When explicit
  `rtsp_url` (`rtsp://` or `rtsps://`) is configured on an `"rtsp"` or `"auto"` camera (for Eufy Baby cameras such as
  Baby Monitor E20 `T8352` / E21 `T8354` or standalone `RTSP` cameras), the bridge pulls directly from `rtsp_url` and
  never queries `eufy-security-ws` (`backfillDownloads: false`, `powerMode: null`, `streamingQuality: null`, `telemetry`
  disabled with `enabled: false`, `serial` optional when `name` is set, active streams flowing continuously with all
  session/hold/idle/viewer timeouts bypassed, and `validateConfig()` rejecting `rtsp_url` combined with `"p2p"`,
  `"backfill"`, or `"custom"`).
- `"p2p"`: Uses live `P2P` on events (`useRtsp: false`, `alwaysBackfill: false`, default `hold_secs: 30`,
  `end_early: true`).
- `"backfill"`: Battery-saver clip replay mode for battery doorbells and high-traffic cameras (`useRtsp: true` by
  default when supported, `alwaysBackfill: true`, default `hold_secs: 20`, `end_early: true`). **Never** wakes a live
  `RTSP` or `P2P` stream on Eufy motion/person/ring events or hardware `'rtsp livestream started'` / trigger-paired
  `'livestream started'` notifications regardless of camera type (`RTSP`-capable or `P2P`-only); instead, it queues a
  `BackfillJob` (displaying a **Yellow** `Waiting` / `card.busy` status indicator across all card themes and the Debug
  HUD) so the camera records its brief native clip (with `t=0` pre-roll) to HomeBase 3 and immediately returns to sleep,
  then downloads and plays out the `.zxvideo` recording at `live_fps` (`15 fps` default, `STREAM_MODES.DOWNLOAD`,
  **Red** `Backfill` / `FB` -> `B`) into Frigate once activity clears. While a `BackfillJob` is pending
  (`hasPendingBackfill()`), single-camera Frigate Live View (`pollViewers`) is **blocked** from waking a live stream so
  the pending clip is never canceled or truncated, and `POST /api/wake/:cameras` stays in `IDLE` with
  `status: 'backfill'`. Live streaming in `"backfill"` mode occurs when no Eufy hardware trigger or `BackfillJob` is
  active and: (1) a human opens Frigate Live View (`pollViewers` wakes live `RTSP` on `RTSP`-capable cameras or `P2P`
  on `P2P`-only cameras/doorbells), (2) an external automation calls `POST /api/wake/:cameras` while `IDLE`
  (`wakeCameraExternal` wakes live `RTSP` or `P2P` and creates a Frigate event because `HomeBase 3` does not record a
  `.zxvideo` clip on HTTP calls alone), or (3) a standalone `'livestream started'` event arrives outside the `3s`
  post-sleep guard with no active trigger/backfill (Eufy mobile app Live View, which the bridge piggybacks on as `P2P`
  without sending `device.start_livestream` and stops immediately on `'livestream stopped'`). If the camera is already
  streaming live, `/api/wake` or motion triggers extend the active hold (`status: 'extended'`).
- `"custom"`: Advanced per-camera tuning mode enabling `backfill_only` (`alwaysBackfill: true`, inheriting `20s` hold,
  `end_early: true`, and `backfillDownloads = true` when `backfill_only: true`), `power_mode: "custom"` (custom hardware
  clip controls `recording_clip_length`, `recording_end_early`, and `recording_retrigger_interval`), and raw integer
  `streaming_quality` (`0..10`), while falling back to `recording_end_early` for bridge `end_early` when `end_early` is
  omitted, alongside per-camera overrides (`use_rtsp`, `backfill_enabled`, `trigger_events`, `low_battery_threshold`,
  `critical_battery_threshold`, `low_battery_hold_secs`, `low_battery_wake_on_view`, `frigate_event_secs`, `power_mode`,
  `track_stuck_spotlight`, `streaming_quality`). Removed legacy keys (`sync_power`, `power_working_mode`,
  `enforce_streaming_quality`) are rejected as unknown by `validateConfig()`. Defensive non-contradiction rules run
  across all modes:
  1. `IDLE_FPS <= LIVE_FPS`: If `idle_fps > live_fps`, logs a warning and clamps `IDLE_FPS = LIVE_FPS`.
  2. `backfill_only` & `backfill_enabled`: If `backfill_enabled: false` is set when `alwaysBackfill` is active
     (`"backfill"` or `"custom"` + `backfill_only: true`), logs a warning and keeps `backfillDownloads = true`.
     (`use_rtsp: true` and `backfill_only: true` coexist cleanly so `RTSP`-capable cameras can stream on-demand Live
     View over `RTSP` while backfilling `.zxvideo` clips on motion events.)
  3. `stream_max_secs >= hold_secs`, `view_max_secs >= view_linger_secs`, `low_battery_hold_secs <= hold_secs`, &
     `0 < critical_battery_threshold < low_battery_threshold <= 99`: Clamps `maxMs >= holdMs`, `viewMaxMs >= lingerMs`,
     `lowBatHoldMs <= holdMs`, `lowBatThreshold` to `2..99` (default `30`), and `criticalBatThreshold` to
     `1..min(98, lowBatThreshold - 1)` (default `5`) with startup warnings.
  4. `recording_clip_length >= hold_secs` when `mode: "custom"`, `power_mode: "custom"`, and
     `!recordingEndClipMotionStops`: Raises explicit `recordingClipLength` to `hold_secs` (`5..120s`) so the Eufy camera
     hardware does not cut off the stream before `hold_secs` expires.
  5. Native grouped presets (`power_mode: "battery"` -> `powerWorkingMode: 0`, `power_mode: "surveillance"` ->
     `powerWorkingMode: 1`) are never silently promoted to `2` (`Customize Recording`), even when `hold_secs` or
     `end_early` is customized on the bridge.
  6. Ignored-option startup warnings & `null`-filtered `/api/config` (`warnIgnoredCameraModeOptions`,
     `warnIgnoredCameraCardOptions`, `warnIgnoredTopLevelOptions`, `buildConfigPayload`, `Camera.toConfigSummary`):
     Logs a `[WARN ]` message whenever any explicitly specified top-level or per-camera option is ignored (such as
     session timeout, Eufy WS, telemetry, backfill, `power_mode`, or `streaming_quality` options when `rtsp_url` is set
     or when all cameras specify `rtsp_url`, `backfill_only`, `power_mode: "custom"`, or integer `streaming_quality`
     outside `"custom"` mode, `recording_*` clip options when `power_mode !== "custom"`, `use_rtsp` when overridden by
     `"rtsp"`/`"p2p"` mode, `idle_timeout_secs` in backfill-only mode, card/telemetry options when `card_theme: "none"`,
     `card_position: "center"`, `card_theme: "minimal"`, or `telemetry.enabled: false`, `startup_snapshot` when
     `sleep_screen` is `"slate"` or `"black"`, and `BRIDGE_HWACCEL_DEVICE` when `BRIDGE_HWACCEL` does not use a device
     node), and sets those inapplicable fields to `null` in `GET /api/config`.

## Non-Invasive `power_mode`, `streaming_quality` & Telemetry Auto-Mirroring

- `power_mode` (global and per-camera: `"keep"` default, `"battery"`, `"surveillance"`, or `"custom"` in
  `mode: "custom"`):
  - `"keep"` (default): Sends **zero** Power Manager `device.set_property` writes so Eufy app schedules and battery
    modes stay untouched. When `hold_secs` / `end_early` (or `frigate_event_secs`) are omitted in `config.yaml`,
    `Camera` mirrors the camera's reported telemetry (`powerWorkingMode === 0 -> 20s, end_early: true`;
    `1 -> 60s, end_early: true`; `2 -> recordingClipLength` clamped `5..120s` and `recordingEndClipMotionStops`, falling
    back to `30s` live / `20s` backfill and `end_early: true` before telemetry arrives or on schedule/geofence modes
    `>= 3`). Explicit `hold_secs` or `end_early` in `config.yaml` always wins.
  - `"battery"` (`powerWorkingMode: 0`, default `hold_secs: 20`, `end_early: true`) and `"surveillance"`
    (`powerWorkingMode: 1`, default `hold_secs: 60`, `end_early: true`): Sync only `powerWorkingMode` without touching
    custom clip properties.
  - `"custom"` (only in `mode: "custom"`): Syncs `powerWorkingMode: 2` (`Customize Recording`), `recordingClipLength`
    (defaulting to clamped `hold_secs`), `recordingEndClipMotionStops` (defaulting to `end_early`), and
    `recordingRetriggerInterval` (default `5`).
- `streaming_quality` (global and per-camera: `"keep"` default, `"auto"`, `"low"`, `"medium"`, `"high"`, `"ultra"`, or
  integer `0..10` in `mode: "custom"`): `"keep"` sends **zero** `videoStreamingQuality` writes. Opted-in named tiers
  query `device.get_properties_metadata` once per camera (`videoStreamingQuality.states`) to map both Eufy hardware
  scales (`0..3` on doorbells/2K cameras vs `0/5/7/10` on 4K S3 cameras, with `"ultra"`/`"high"` falling back to the
  highest available state when no exact label exists).
- `hold_secs` (default `30` in live modes, `20` when `alwaysBackfill` or `power_mode: "battery"` is active, `60` under
  `power_mode: "surveillance"`) and `end_early` (default `true` across all modes): Govern live hold windows (`holdMs`),
  Frigate event durations (`eventSecs`, unless `frigate_event_secs` is set), and clean post-motion termination while
  allowing active Eufy triggers, Frigate object detections, and connected waking viewers to re-wake `RTSP` across clip
  boundaries (`AT-11`, `AT-12`).
- `track_stuck_spotlight` (experimental, default `false` globally and per-camera): Controls whether the `500ms`
  housekeeping watchdog and idle `wifiRssi` recovery turn off a camera spotlight (`light: false`) left on past `130s`
  while `IDLE` with no active triggers or pending `BackfillJob`. Disabled by default while the detection heuristic is
  refined.
- `trigger_events` (global and per-camera): Filters incoming Eufy trigger events locally without writing any camera
  `motionDetection*` properties; `Telemetry` inspects reported Eufy Motion Detection toggles read-only and logs a
  deduplicated `WARN` when `motionDetection` is `false` or active `trigger_events` categories are disabled in the Eufy
  app (`AT-10`).

## Session Timers, Low-Battery Saver, Frame Rates & Snapshot Options

- **Session & Viewer Timers (`stream_max_secs`, `idle_timeout_secs`, `view_linger_secs`, `view_max_secs`,
  `view_cooldown_secs`):** Active motion holds extend up to `stream_max_secs` (`900s` default, `>= hold_secs`). When
  `idle_timeout_secs > 0` (`earlySleepMs`), live motion streams poll Frigate and close early once `0` tracked objects
  remain for `idle_timeout_secs` (or `5s` after Eufy reports activity cleared once `idle_timeout_secs` of video has
  elapsed). Manual Live View sessions stay warm for `view_linger_secs` (`20s`) after the last viewer disconnects, cap
  at `view_max_secs` (`300s`, `>= view_linger_secs`), and apply a `view_cooldown_secs` (`5s`) guard against pure viewer
  re-wakes (bypassed whenever an unexpired Eufy hardware trigger is active).
- **Low-Battery Saver (`low_battery_threshold`, `critical_battery_threshold`, `low_battery_hold_secs`,
  `low_battery_wake_on_view`):** Unplugged cameras at or below `low_battery_threshold` (`30%` default) render a yellow
  battery indicator (purple at or below `critical_battery_threshold`, `5%` default), shorten live event holds to
  `low_battery_hold_secs` (`20s` default, `<= hold_secs`), and block manual Live View wakes unless
  `low_battery_wake_on_view: true` is set.
- **Frame Rates & Snapshots (`live_fps`, `idle_fps`, `startup_snapshot`, `instant_event_snapshot`,
  `snapshot_capture_delay_secs`, `telemetry_poll_secs`):** Encoders send `idle_fps` (`5` default, matching Frigate's
  `detect.fps` so still frames consume `~20-40 kbps` and zero detector checks when `record.continuous.days: 0`) while
  asleep, switching to `live_fps` (`15` default) during live or backfill playback. `startup_snapshot` (`true`, `false`,
  or `"always"`) wakes a camera on startup only when `sleep_screen: "snapshot"` has no cached file in
  `BRIDGE_CACHE_DIR` (`"always"` refreshes on every restart). `instant_event_snapshot: true` files Frigate events after
  `1s` of live video (`0.8s` on backfill) and falls back to a clean un-overlayed snapshot if a wake times out without
  video; when `false`, `snapshot_capture_delay_secs` (`3s` default) sets the wait window. `telemetry_poll_secs` (`300s`
  default, `0` disables) refreshes sleeping telemetry periodically.
