# AGENTS.md

## Repository Layout

```text
.
├── Dockerfile                         # Multi-stage alpine:3.23 build (COPY package.json & src/ /app/)
├── Makefile                           # Hermetic .venv Node.js toolchain, node:test, Podman build & clean
├── package.json                       # Project metadata, engine constraints & dependencies (ws)
├── README.md                          # User-friendly setup guide, mode selector & configuration reference
├── AGENTS.md                          # Architecture, domain model, diagnostic scripts & post-mortems
├── examples/
│   ├── config.example.minimal.json    # Minimal configuration example
│   ├── config.example.full.json       # Full configuration example with all options
│   └── docker-compose.example.yml     # Example Docker Compose deployment
└── src/
    ├── app.js                         # Application composition root, wiring & signal handlers
    ├── config.js                      # Config loader, defensive validation, numeric clamping & constants
    ├── logger.js                      # Structured Alloy/Loki logger & ICU-free local ISO timestamps
    ├── domain/
    │   ├── camera.js                  # Camera entity composing StatusCard, Telemetry & stream rules
    │   ├── status-card.js             # StatusCard model (theme/position, bounds & Frigate mask polygon)
    │   ├── telemetry.js               # Telemetry model (sensor state, Eufy parsing & 6-color rules)
    │   └── backfill-job.js            # BackfillJob model (.zxvideo record parser & time-window matcher)
    ├── overlay/
    │   ├── yuv-canvas.js              # Low-level YUV420p drawing, anti-aliasing & box blur
    │   ├── card-renderer.js           # Theme engines (detailed, icons, minimal, none) & mask bounds
    │   └── snapshot-cache.js          # Persistent JPEG <-> YUV420p snapshot cache (/config/cache)
    ├── media/
    │   ├── encoder.js                 # Persistent FFmpeg RTSP encoder, drain pipe & A/V tickers
    │   └── decoder.js                 # Per-session P2P Annex-B & RTSP pull FFmpeg decoders
    └── services/
        ├── eufy-client.js             # eufy-security-ws WebSocket RPC client & telemetry/power sync
        ├── frigate-client.js          # Frigate & go2rtc HTTP client (events, masks, idle & viewer poll)
        ├── ha-notifier.js             # Home Assistant webhook notification client
        ├── http-server.js             # Built-in HTTP server (/api/wake/:cameras & /healthz)
        └── stream-orchestrator.js     # Per-station arbitration, RTSP/P2P wake, backfill & watchdog
└── test/
    ├── reporter.js                    # Concise node:test reporter (errors or single summary line)
    ├── config.test.js                 # Enterprise node:test suite for config, modes & defensive rules
    └── domain.test.js                 # Enterprise node:test suite for Camera, StatusCard, Telemetry & BackfillJob
```

## Key Commands & Diagnostic Scripts

- **Bootstrap Hermetic Local Environment:** `make env` (automatically downloads a project-local Node.js runtime into `.venv/node` and installs `package.json` dependencies into `.venv/node_modules` with isolated `HOME=.venv/home`, `NPM_CONFIG_CACHE=.venv/npm-cache`, and `NPM_CONFIG_USERCONFIG=.venv/npmrc`—never touching global `$HOME` caches or settings)
- **Run Unit Tests & Syntax Check:** `make test` or `make check` (auto-creates `.venv` if missing, then runs `.venv/node/bin/node --check` and `.venv/node/bin/node --test test/*.test.js`)
- **Build Image Locally:** `make docker-build` (runs `make check` and executes `node --test /app/test/*.test.js` inside the `node:22-alpine3.23` builder stage before building the `alpine:3.23` runtime image)
- **Publish Locally:** `make publish` (builds and tags `localhost/eufy-frigate-battery-bridge:latest`; skips remote push when `REGISTRY` is empty)
- **Publish to Private Registry:** `make publish REGISTRY=<registry> BUILD_VERSION=<version>` (tags during build and pushes with `--tls-verify=false`)
- **Clean Images & Local Environment:** `make clean` (removes local build/publish container images and deletes `.venv/` completely)
- **Print Makefile Variables:** `make print-vars`
- **Check Bridge Readiness:** `curl -s http://127.0.0.1:8080/healthz`
- **Trigger External Camera Pre-Wake:** `curl -s -X POST http://127.0.0.1:8080/api/wake/all -H "Content-Type: application/json" -d '{"reason":"test wake","duration":30}'`
- **Trigger Test Frigate Event:** `podman kill -s USR2 eufy-frigate-battery-bridge` (files a `"test"` event on the first camera without waking it)
- **Trigger Test Backfill Download:** `podman kill -s USR1 eufy-frigate-battery-bridge` (queries `HomeBase 3` and replays the latest recorded `.zxvideo` clip at `15 fps` into Frigate)

<details>
<summary><strong>Diagnostic Script 1: Inspect Hardware Models, Serial Numbers & Firmware Versions</strong></summary>

```shell
podman exec eufy-frigate-battery-bridge node -e '
  const fs = require("fs");
  const WS = require("ws");
  const cfgPath = process.env.BRIDGE_CONFIG || process.env.CONFIG_PATH || "/config/config.json";
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const ws = new WS(cfg.eufy_ws);
  let id = 0;
  let remaining = 0;
  const send = (cmd) => ws.send(JSON.stringify({ messageId: String(++id), ...cmd }));
  const unwrap = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "version") {
      send({ command: "set_api_schema", schemaVersion: Math.min(m.maxSchemaVersion, 21) });
      send({ command: "start_listening" });
    } else if (m.messageId === "2") {
      const stations = m.result?.state?.stations || [];
      const devices = m.result?.state?.devices || [];
      remaining = stations.length + devices.length;
      for (const s of stations) send({ command: "station.get_properties", serialNumber: s.serialNumber || s });
      for (const d of devices) send({ command: "device.get_properties", serialNumber: d.serialNumber || d });
      if (!remaining) process.exit(0);
      setTimeout(() => process.exit(0), 3000);
    } else if (m.type === "result" && m.result?.properties) {
      const p = m.result.properties;
      console.log(
        unwrap(p.name) +
          " | model=" + unwrap(p.model) +
          " | serial=" + unwrap(p.serialNumber) +
          " | fw=" + unwrap(p.softwareVersion) +
          " | hw=" + unwrap(p.hardwareVersion)
      );
      if (--remaining <= 0) process.exit(0);
    }
  });
'
```
</details>

<details>
<summary><strong>Diagnostic Script 2: Inspect Camera Power Manager, Streaming Quality, RTSP & Telemetry State</strong></summary>

```shell
podman exec eufy-frigate-battery-bridge node -e '
  const fs = require("fs");
  const WS = require("ws");
  const cfgPath = process.env.BRIDGE_CONFIG || process.env.CONFIG_PATH || "/config/config.json";
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const ws = new WS(cfg.eufy_ws);
  let id = 0;
  let remaining = cfg.cameras.length;
  const send = (cmd) => ws.send(JSON.stringify({ messageId: String(++id), ...cmd }));
  const unwrap = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "version") {
      send({ command: "set_api_schema", schemaVersion: Math.min(m.maxSchemaVersion, 21) });
      send({ command: "start_listening" });
    } else if (m.messageId === "2") {
      for (const c of cfg.cameras) send({ command: "device.get_properties", serialNumber: c.serial });
      setTimeout(() => process.exit(0), 3000);
    } else if (m.type === "result" && m.result?.properties) {
      const p = m.result.properties;
      console.log(
        unwrap(p.name) + " (" + unwrap(p.serialNumber) + "): " +
          "powerMode=" + unwrap(p.powerWorkingMode) + " (0=Battery, 1=Surveillance, 2=Custom)" +
          ", clipLen=" + unwrap(p.recordingClipLength) + "s" +
          ", endEarly=" + unwrap(p.recordingEndClipMotionStops) +
          ", retrigger=" + unwrap(p.recordingRetriggerInterval) + "s" +
          ", quality=" + unwrap(p.streamingQuality) +
          ", rtsp=" + unwrap(p.rtspStream) + " (" + (unwrap(p.rtspStreamUrl) || "n/a") + ")" +
          ", bat=" + unwrap(p.battery) + "% (chg=" + unwrap(p.chargingStatus) + ")" +
          ", wifi=" + unwrap(p.wifiSignalLevel) + " (" + unwrap(p.wifiRssi) + " dBm)" +
          ", temp=" + unwrap(p.batteryTemperature) + "C"
      );
      if (--remaining <= 0) process.exit(0);
    }
  });
'
```
</details>

<details>
<summary><strong>Diagnostic Script 3: Inspect Latest HomeBase 3 Recorded Clips (<code>database_query_latest_info</code>)</strong></summary>

```shell
podman exec eufy-frigate-battery-bridge node -e '
  const fs = require("fs");
  const WS = require("ws");
  const cfgPath = process.env.BRIDGE_CONFIG || process.env.CONFIG_PATH || "/config/config.json";
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const ws = new WS(cfg.eufy_ws);
  let id = 0;
  const send = (cmd) => ws.send(JSON.stringify({ messageId: String(++id), ...cmd }));

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "version") {
      send({ command: "set_api_schema", schemaVersion: Math.min(m.maxSchemaVersion, 21) });
      send({ command: "start_listening" });
    } else if (m.messageId === "2") {
      for (const s of m.result?.state?.stations || []) {
        const serialNumber = s.serialNumber || s;
        send({ command: "station.connect", serialNumber });
        send({ command: "station.database_query_latest_info", serialNumber });
      }
      setTimeout(() => process.exit(0), 4000);
    } else if (m.type === "event" && m.event?.event === "database query latest") {
      console.log("Station " + m.event.serialNumber + " latest records:", JSON.stringify(m.event.data, null, 2));
      process.exit(0);
    }
  });
'
```
</details>

## Coding & Style Guidelines for Agents

- **Step-by-Step Scoped Patches:** Keep patch scripts small, modular, and scoped step-by-step per file rather than bundling large multi-file rewrites into a single script. Never use nested backtick template literals inside patch scripts.
- **No Magic Numbers & Config-First Constants:** Never embed unexplained magic numbers (such as raw millisecond timeouts, retry counts, buffer sizes, or priority scores) inside functions. Always reference configurable values exported from `src/config.js` (`HOLD_MS`, `MAX_MS`, `LOW_BAT_HOLD_MS`, `VIEW_MAX_MS`, `EARLY_SLEEP_MS`, `BACKFILL_DELAY_MS`, `LIVE_FPS`, `getEventPriority`) and define descriptive `UPPER_SNAKE_CASE` module constants for internal protocol or timing thresholds (except obvious unit conversions such as `* 1000` or `/ 1000`).
- **Idiomatic, Self-Documenting & Testable Code ("Tell, Don't Ask") & Permanent Test Suite (`test/*.test.js`):** Write clean, idiomatic Node.js with small, single-responsibility functions. Never write multi-clause `if` statements in service or media modules that inspect multiple internal properties of `cam`—encapsulate multi-property camera state checks and transitions as expressive, well-named methods on the `Camera` domain model (`src/domain/camera.js`, passing arguments such as `now` or thresholds when needed) so state invariants live in the domain layer and can be unit-tested deterministically without live hardware. Never create throwaway dynamic test scripts—always add unit tests directly to the permanent `node:test` suite in `test/*.test.js`, which runs automatically during `make check`, `make test`, and `make docker-build`.
- **Block-Grouped Roadmap Convention:** Always organize grouped changes, multi-part enhancements, and sequential implementation steps into dedicated, numbered `Block` sections under `Implementation History` in `AGENTS.md`.
- **Canonical Configuration Keys:** Keep `src/config.js` strictly clean and free of redundant legacy key aliases (supporting both `BRIDGE_CONFIG` and `CONFIG_PATH` environment variables plus shorthand `trigger_events`).
- **Comment Formatting:** Always use clean, left-justified comments and comprehensive JSDoc blocks on every function. Never add decorative comment dividers (such as `// ----`).
- **No Icons or Emojis in Code, Comments, or Documentation:** Never put icons, emojis, or decorative Unicode symbols inside source code, code comments, or markdown documentation (`README.md`, `AGENTS.md`, `examples/*`) unless the character is part of a runtime string displayed to the user (such as `'°C'` temperature unit suffixes).
- **String & Template Safety in `src/app.js`:** Use standard single-quoted strings (`'...'`) with `+` concatenation instead of multi-line backtick template literals or backticks inside comments to prevent parser/linter errors across strict IDEs.
- **Documentation Conventions in `README.md`:** Always capitalize Eufy in prose, and wrap service names, binaries, protocols, codecs, and config keys (`go2rtc`, `ffmpeg`, `eufy-security-ws`, `RTSP`, `P2P`, `WebSocket`, `Podman`, `H.264`, `H.265`) in backticks. Never include real personal serial numbers in documentation or examples—use anonymized placeholders (`T8161T0000000000`, `T8161T1111111111`, `T8214T2222222222`).
- **Commit Message Attribution & Plain Text Formatting:** Always include `Co-authored-by: Gemini <gemini@google.com>` at the end of git commit messages, and **never wrap commit messages in fenced code blocks (` ``` `) or `<details>` tags**—always display them directly as plain un-fenced text so the chat UI never folds them.

## Configuration & Mode Architecture (`src/config.js`)

### Camera Modes (`resolveCameraMode`) & Defensive Validation

Each camera in `cameras[]` resolves its operating mode via `resolveCameraMode(camConfig)` (`name` defaults to `serial` when omitted):

- `"auto"` (default): Uses HomeBase native `RTSP` (`rtspStreamUrl`) when supported by the camera, or live `P2P` otherwise, with automatic HomeBase clip backfill when busy or interrupted (`hold_secs: 60`, `end_early: false`).
- `"rtsp"`: Uses HomeBase native `RTSP` (`useRtsp: true`, `alwaysBackfill: false`, default `hold_secs: 60`, `end_early: false`).
- `"p2p"`: Uses live `P2P` on events (`useRtsp: false`, `alwaysBackfill: false`, default `hold_secs: 60`, `end_early: false`).
- `"backfill"`: Battery-saver clip replay mode for doorbells (`T8214`) and high-traffic cameras (`useRtsp: false`, `alwaysBackfill: true`, default `hold_secs: 30`, `end_early: true`). Skips waking the camera for a live `P2P`/`RTSP` stream on Eufy motion/person/ring events and instead queues a `BackfillJob` so the camera records its brief native clip (with `t=0` pre-roll) to HomeBase 3 and immediately returns to sleep; once Eufy reports `state: false` (`activity cleared`), the bridge downloads and plays out the `.zxvideo` recording at `15 fps` into Frigate. Manual Frigate Live View and `/api/wake` requests still wake the live `P2P` stream on demand.
- `"custom"`: Advanced per-camera tuning mode exposing granular overrides (`use_rtsp`, `always_backfill`, `backfill_downloads`, `trigger_events`, `low_battery_threshold`, `low_battery_wake_on_view`, `event_secs`, `sync_power`, `power_working_mode`, `recording_clip_length`, `recording_end_early`, `recording_retrigger_interval`, `enforce_streaming_quality`) while enforcing defensive non-contradiction rules:
  1. `IDLE_FPS <= LIVE_FPS`: If `idle_fps > live_fps`, logs a warning and clamps `IDLE_FPS = LIVE_FPS`.
  2. `use_rtsp` vs `always_backfill` & `backfill_downloads`: If `use_rtsp` and `always_backfill` are both enabled, logs a warning and disables `useRtsp`. If `backfill_downloads: false` is set on a `"backfill"` camera, logs a warning and keeps `backfillDownloads = true`.
  3. `max_secs >= hold_secs`, `view_max_secs >= view_linger_secs` & `low_battery_hold_secs <= hold_secs`: Clamps `maxMs >= holdMs`, `viewMaxMs >= lingerMs`, and `lowBatHoldMs <= holdMs` with startup warnings.
  4. `recording_clip_length >= hold_secs` when `end_early: false`: Raises `recordingClipLength` to `hold_secs` (`5..120s`) so the Eufy camera hardware does not cut off the stream before `hold_secs` expires.
  5. `power_working_mode < 2` with custom clip overrides or conflicting `hold_secs`: Automatically promotes `powerWorkingMode` to `2` (`Customize Recording`) when custom clip properties (`recording_clip_length`, `recording_end_early`, `recording_retrigger_interval`) are specified or when `power_working_mode: 0` (`Optimal Battery Life`, which hardcodes `20s` early-ending clips) conflicts with `hold_secs > 20` or `end_early: false`; preserves `1` (`Optimal Surveillance`) or compatible `0` (`hold_secs <= 20` + `end_early: true`) without sending conflicting clip properties.

### Unified `hold_secs` & `end_early` Auto-Sync (`resolveCameraTimers` & `resolveHardwareRecordingConfig`)

- `hold_secs` (default `60` for `auto`/`rtsp`/`p2p`/`custom`, `30` for `backfill`): Sets the bridge live hold duration (`holdMs`), the Frigate event duration (`eventSecs`, unless `event_secs` is explicitly set), and the Eufy hardware `recordingClipLength` (`5..120s`). While active, subsequent events, mid-stream camera re-triggers, or active Frigate object detections within `4s` of timeout (`evaluateActiveHoldExtension`) extend the hold by `hold_secs / 2` up to `max_secs` (`900s`).
- `end_early` (default `false` for `auto`/`rtsp`/`p2p`/`custom`, `true` for `backfill`): Sets both the bridge's `letEufyDecideEnd` behavior and Eufy's hardware `recordingEndClipMotionStops` property.
- Unless `sync_power: false` is set, the bridge automatically syncs `powerWorkingMode: 2` (`Customize Recording`), `recordingClipLength`, `recordingEndClipMotionStops`, and `recordingRetriggerInterval: 5` to each camera via `device.set_property` on initial telemetry load whenever the hardware value differs.

### Status Card Themes & Overlay Pipeline (`src/domain/status-card.js` & `src/overlay/*`)

- `card_theme`:
  - `"icons"` (default): Crisp vector icons inside a `44px`-high frosted-glass capsule (`44%` opacity) with zero text and no `ffmpeg` spawn (Status glyph, Battery + charging bolt, Curved Wi-Fi arcs colored by `RSSI`, Thermometer with tick marks, and `Last live` analog clock with `HH:MM` hands).
  - `"minimal"`: Three graduated color-coded semantic dots (`[Status]  [Battery]  [Wi-Fi]`) inside a `92x36` frosted-glass capsule (`42%` opacity) with zero text and no `ffmpeg` spawn.
  - `"detailed"`: Frosted-glass panel with full text (`Asleep`, `Asleep (Low Battery)`, `Waking Up...`, `Waiting`) + graphical telemetry icons. Renders the centered `820x336` modal with a color-coded status glyph when `card_position` is `"center"`, or a compact `540x88` card when `card_position` is a corner.
  - `"none"`: Hides the status overlay while honoring `sleep_screen` (`"snapshot"`, `"slate"`, or `"black"`).
- `card_position`: `"bottom-left"` (default), `"top-left"`, `"bottom-right"`, `"top-right"`, or `"center"`.
- `sleep_screen`: `"snapshot"` (default, last camera frame from `/config/cache`), `"slate"` (solid `#222222`), or `"black"` (solid `#101010`).
- `card_show_on_live` (`true` by default): Composites corner status cards onto live/backfill video frames via a reusable scratch buffer (`prepareLiveOverlayBuffer`) using a `Red` play glyph/dot for live video or a `Red` double-triangle rewind glyph / concentric bullseye dot during backfill playback, while keeping `cam.lastFrame` and `/config/cache` snapshots clean.
- `auto_frigate_mask` (`true` by default): Computes the normalized polygon bounding box for each camera's corner status card (with a `6px` chroma/anti-aliasing safety margin) and syncs both `motion.mask.eufy_bridge_card` and `objects.mask.eufy_bridge_card` into Frigate via `GET /api/config` and `PUT /api/config/set` (`requires_restart: 0`) on startup, every 60s, and after Frigate restarts.

## Architecture & Runtime Rules

### Modular Dependency Flow

Data and dependencies flow strictly top-down from the composition root (`src/app.js`) to the foundation layer (`domain/*`, `config.js`, `logger.js`) with zero circular `require()` dependencies:

```text
                          ┌──────────────────────┐
                          │      src/app.js      │  (Composition Root & Signal Hooks)
                          └──────────┬───────────┘
                                     │
        ┌───────────────────┬────────┴─────────┬────────────────┐
        ▼                   ▼                  ▼                ▼
┌───────────────┐ ┌────────────────────┐ ┌───────────┐ ┌──────────────────┐
│  http-server  │ │stream-orchestrator │ │eufy-client│ │  frigate-client  │  (Service Layer)
└───────┬───────┘ └─────────┬──────────┘ └─────┬─────┘ └────────┬─────────┘
        │                   │                  │                │
        │                   ▼                  ▼                ▼
        │            ┌─────────────┐    ┌─────────────┐  ┌─────────────┐
        │            │ media/*     │    │ overlay/*   │  │ ha-notifier │  (Media & Overlay Layer)
        │            │ (enc / dec) │    │ (card / yuv)│  └──────┬──────┘
        │            └──────┬──────┘    └──────┬──────┘         │
        │                   │                  │                │
        └───────────────────┴────────┬─────────┴────────────────┘
                                     ▼
                        ┌─────────────────────────┐
                        │ domain/* (camera, card, │  (Domain & Foundation Layer)
                        │ telemetry, backfill)    │
                        │ config.js / logger.js   │
                        └─────────────────────────┘
```

### Stream Lifecycle, Event Priority, RTSP, Backfill & Multi-Station Rules

- **Per-Station P2P Stream Arbitration (`arbitrate`, `getStationKey`):** Eufy HomeBase stations multiplex one active P2P stream (`activeMode === 'p2p'` or `'download'`) at a time per `stationSerial`. Standalone Wi-Fi cameras/doorbells (`stationSerial === cam.serial`) and multiple HomeBase stations are arbitrated independently with per-station transition locks (`stationTransitions`), allowing concurrent P2P streaming across distinct stations.
- **HomeBase Native RTSP Ingestion (`use_rtsp`, `startRtspStream`, `startRtspDecoder`):** Automatically discovers `rtspStreamUrl` from `device.get_properties` on cameras with NAS/RTSP support (`T8161`), wakes the camera via `rtspStream=true` and `device.start_rtsp_livestream`, and streams them in `activeMode = 'rtsp'` concurrently alongside P2P cameras (`usesP2pSlot === false`). Retries RTSP connection every `750ms` during the wake window, preserves active `ffmpeg` handshakes (`isRtspDecoderHandshaking`, `400ms..6000ms`), re-sends `start_rtsp_livestream` every `3.5s` (`RTSP_WAKE_RETRY_MS`, up to `5` retries) when idle, immediately re-wakes (`0ms`) on mid-session clip boundary drops, and sleeps cleanly after `25s` (`initiator=error/rtsp-wake-timeout`) without falling back to `P2P`.
- **Post-Event Clip Download Backfill (`backfill_downloads`, `always_backfill`, `processBackfillQueue`, `handleDatabaseQueryResult`):** When any camera triggers an event while its station's P2P slot is busy, fails an RTSP wake, is preempted/stopped before capturing `5s` of live video, or runs in `"backfill"` mode (`shouldBackfillOnlyOnEvent`), `pendingBackfill` preserves the highest-priority event metadata (`queueEventBackfill` upgrades `pendingBackfill` in-place via `upgradeEvent` when companion `"person"`/`"identity person"`/`"ring"` events arrive after `"motion"`, and cancels `pendingBackfill` only once `5s` of live video is captured across decoder resets). While `recordingActive` is `true`, `BackfillJob` tracks all active `state: true` trigger properties (`activeEvents`) so an early `state: false` on one companion property (such as `"person detected"` or `"rings"` clearing while `"motion detected"` is still active) never marks the recording finished early; `isReadyToQuery` waits until `4s` (`BACKFILL_POST_CLEAR_SETTLE_MS`) after **all** active trigger properties report `state: false` (`markRecordingCleared`, or up to `Math.max(35000, holdMs + 4000)`) so `HomeBase 3` has finished flushing and indexing the complete `.zxvideo` clip before querying. Station P2P idle and `backfill_delay_secs` (`5s`) cooldown checks are scoped per station across non-RTSP P2P cameras (`isStationIdleForBackfill`), ensuring RTSP camera activity never delays P2P backfill downloads. Once ready, the bridge connects to the station (`station.connect`), calls `station.database_query_by_date` followed by `station.database_query_latest_info`, queues all matching `.zxvideo` clips from the activity window in chronological order (`oldest -> newest`) in `cam.backfillClipQueue` (while preserving `activeBackfillJob` during playback and scheduling a single follow-up query if activity extended `>= 15s` past the first clip), keeps `enc.stdin` quiet during the download handshake until `Frame 0` is decoded (`shouldWriteEncoderFrame`), buffers burst-downloaded video frames (`MAX_DOWNLOAD_BUFFER_SECS = 120`) and PCM audio into `downloadFrames` / `cam.pcm` to play out continuously from `Frame 0` at `15 fps` (`LIVE_FPS`) via `device.start_download` (`activeMode = 'download'`, `initiator = 'bridge-backfill'`), waits `800ms` (`BACKFILL_SNAP_DELAY_MS`) after `firstFrameAt` so `Frame 0` traverses the `h264_vaapi -> go2rtc -> Frigate` pipeline before `POST /api/events/.../create` fires, flushes the FFmpeg decoder (`flushDecoderInput`) on `'download finished'`, holds the final frame for `2.5s` (`DOWNLOAD_POST_PLAYBACK_HOLD_MS`) so Frigate records the full tail, and scales Frigate's event `duration` (`getEffectiveEventDurationSecs`). Any live motion or viewer request immediately preempts an active download (`initiator = 'bridge-arbitrator/live-over-download'`).
- **Camera & Event Priority Tiers (`getEffectivePriority`):** Combines per-camera `priority` from `config.json` with built-in `EVENT_PRIORITIES` (`ring`: `+1000`, `identity person`: `+300`, `person`/`stranger`: `+200`, `vehicle`/`pet`/`dog`: `+100`, `crying`/`sound`: `+50`, `motion`: `+10`). Companion events arriving while a camera is already live automatically upgrade `cam.eventPriority` in-place.
- **Zero-Dwell Event Switching:** Higher-priority events (`pickScore > curScore`, `initiator=bridge-arbitrator/higher-priority-event`) and newer events on equal-priority cameras (`pickScore === curScore`, `initiator=bridge-arbitrator/newer-motion` when `preempt_event_streams` is `true`) preempt the active camera immediately with a `150ms` P2P handover settle delay. Lower-priority cameras (`pickScore < curScore`) are blocked from preempting an active higher-priority event until its motion clears or stalls.
- **Drain-Aware Frame Pipeline (`live_fps: 15`, `idle_fps: 5`):** `enc.stdin.on('drain')` immediately flushes any pending `cam.frameNew` frame that arrived while the `1.38 MB` raw YUV420p pipe buffer was full, eliminating dropped frames and playback jerkiness.
- **Immediate Snapshot Persistence (`lastFrame`, `/config/cache`):** `cam.lastFrame` and `cam.lastSeen` update on the very first decoded keyframe of every session (the 2s settle delay applies only to first-boot `startup_snapshot` probes). Clean un-overlayed `JPEG` frames are persisted to `/config/cache/last_<name>_<serial>.jpg` so container restarts never need to wake cameras that already have a cached snapshot. While `cam.active && cam.gotVideo`, the encoder holds `cam.frame || cam.lastFrame` so preempted or stopping streams never flash the pre-stream `waking` card.
- **External Stream Adoption (`initiator=eufy-ws`) & HTTP Pre-Wake/Readiness Server (`http_port`, `startHttpServer`, `wakeCameraExternal`):** Wakes initiated directly through `eufy-security-ws` are automatically adopted by `onEvent` (`initiator=eufy-ws`) for `holdMs`. The HTTP server exposes `POST/GET /api/wake/:cameras` (supporting `name`, `serial`, slugified `title`, comma-separated lists, and `all`, with `RTSP`-first ordering, `2500ms` per-station pacing, and burst coalescing) alongside `GET/HEAD /healthz` (container `HEALTHCHECK` readiness probe).
- **HomeBase Reboot Resilience:** `onEvent` handles `source === 'station'` events (`close`, `connection error`, `connect`), cleanly stopping active streams on that station (`initiator=error/station-disconnect`) and re-fetching telemetry on reconnect without dropping FFmpeg RTSP feeds to `go2rtc`.

### Structured Logging, Priorities & Stream Initiators

All log output in `app.js` and service modules must use `log.debug()`, `log.info()`, `log.warn()`, or `log.error()` with a camera state object (or `'bridge'` for global events) as the first argument so every line is formatted identically for Grafana Alloy / Loki ingestion:

    YYYY-MM-DD HH:MM:SS [LEVEL] [camera_or_bridge] message

- **Timestamps:** Formatted via `formatLocalTimestamp()` (`YYYY-MM-DD HH:MM:SS`) using local `Date` getters (respecting `TZ`) with zero ICU locale dependencies so Grafana Alloy's ISO-8601 regex always matches.
- **Key-Value Context:** Lifecycle and stream interruption logs must include structured `key=value` pairs (`initiator=...`, `reason="..."`, `live=...s`, `gotVideo=...`, `lastVideoAgo=...`, `session=...`).

#### Log Priority Levels

| Level   | Usage Guidelines |
|:--------|:-----------------|
| `ERROR` | Unrecoverable session or subsystem failures: `eufy-security-ws` socket errors, `start_listening` failures, `device.start_livestream` RPC failures, watchdog forced stream closures after 3 failed retries (`initiator=error/watchdog-timeout`), wedged FFmpeg encoder `stdin` (>10s backpressure), FFmpeg encoder/decoder spawn failures, HTTP server listen errors, and Frigate HTTP event creation errors. |
| `WARN`  | Recoverable interruptions, fallbacks, or abnormal terminations: unsolicited `livestream stopped` from Eufy/camera while a session is still active (`initiator=eufy/camera`), RTSP wake timeout (`initiator=error/rtsp-wake-timeout`), backfill download RPC/timeout failures (`initiator=error/download-failed`, `initiator=error/download-timeout`), watchdog stall retries 1-3 (`initiator=bridge-watchdog`), `already_running` stale stream recovery (`initiator=bridge/eufy-ws`), late video/start events arriving after a session closed (`initiator=bridge`), hitting `max_secs` (`initiator=bridge-max-limit`), WebSocket/station disconnects (`initiator=error/ws-disconnect`, `initiator=error/station-disconnect`), hardware acceleration fallback to `libx264`, Frigate events created without live video, Home Assistant webhook failures, and invalid/contradictory config or font fallbacks. |
| `INFO`  | Normal operational lifecycle: bridge and HTTP server startup/shutdown, `eufy-security-ws` connected/listening, HomeBase station reconnects, encoder startup, initial camera telemetry, RTSP URL discovery, Eufy Power Manager property sync, battery economy mode transitions, `WAKE` / `WAKE [RTSP]` / `WAKE [BACKFILL DOWNLOAD]` / `SLEEP` transitions, `eufy livestream started`, first decoded keyframe timing, activity-cleared 5s countdown, mid-stream codec changes (`initiator=camera-stream`), Frigate event creation, and viewer connection decisions. |
| `DEBUG` | High-frequency or diagnostic details: routine telemetry refreshes, companion event deduplication, HomeBase local database queries, 750ms RTSP wake retries, clean `livestream stopped` confirmations after `SLEEP`, in-band resolution changes, mid-flight `start_livestream` cancellations when preempted, viewer disconnections, viewer queue clears, and snapshot cache read/write operations. |

### Stream Interruption & Lifecycle Initiators (`initiator=...`)

- `eufy-event`: Woken or hold-extended by a Eufy motion/person/pet/ring event.
- `eufy-ws`: Woken externally via `eufy-security-ws` and automatically adopted by the bridge.
- `api-wake`: Woken or extended via the `POST/GET /api/wake/:cameras` HTTP endpoint.
- `eufy/camera-event-end` / `eufy/rtsp-end` / `eufy/download-finished`: Cleanly ended by Eufy/HomeBase when the camera finishes its P2P event recording, RTSP stream, or post-event clip download.
- `eufy/camera`: Stream interrupted or stopped by Eufy/HomeBase while hold/view timer is still active.
- `viewer` / `viewer-preempt`: Woken, extended, or preempted by a human viewer connecting via `go2rtc`.
- `bridge-backfill`: Woken in `download` mode to replay a HomeBase event recording into Frigate (`device.start_download`).
- `bridge-probe` / `bridge-startup-probe`: Woken for initial startup snapshot capture and stopped once 2s of stable video is saved.
- `bridge-timer`: Normal `SLEEP` when both `hold_secs` and `view_linger_secs` timers expire.
- `bridge-early-sleep/eufy-cleared` / `bridge-early-sleep/quiet-timeout`: Closed early by optional battery saver once `early_sleep_secs` has elapsed and Frigate confirms no active tracked objects.
- `bridge-arbitrator/motion-over-viewer` / `bridge-arbitrator/higher-priority-event` / `bridge-arbitrator/newer-motion` / `bridge-arbitrator/newer-viewer` / `bridge-arbitrator/live-over-download`: Active camera or backfill download preempted on the station P2P slot by a higher-priority or live request.
- `bridge-max-limit` / `bridge-view-limit`: Forced `SLEEP` upon reaching `max_secs` or `view_max_secs`.
- `bridge/eufy-ws`: Forced stop/restart when `eufy-security-ws` reports `already_running` on a stale P2P session.
- `bridge-watchdog`: Stream stalled (`no_initial_video_after_wake` or `stream_stalled_mid_session`), triggering decoder reset and re-request (retries 1-3), or killing a wedged encoder process.
- `error/watchdog-timeout` / `error/rtsp-wake-timeout` / `error/download-failed` / `error/download-timeout`: Forced `SLEEP` after 3 failed P2P watchdog retries, 25s RTSP wake timeout, or failed/stalled clip download.
- `error/ws-disconnect` / `error/station-disconnect`: Forced `SLEEP` across active cameras when `eufy-security-ws` or the station P2P connection drops.
- `camera-stream` / `ffmpeg-decoder`: Decoder reset triggered by an in-band video codec change (`H264` <-> `H265`) or unexpected FFmpeg decoder process exit.
- `system-shutdown`: Graceful stream stop on container `SIGTERM`/`SIGINT`.

### Tested Hardware Stack

- **Station:** Eufy HomeBase 3 (S380) (`T8030`, fw `3.8.7.4`, hw `V05`) + Video Doorbell Dual Chime (`T8023`, fw `3.3.2.2m_0.1`, hw `P0`)
- **Cameras:** Eufy Video Doorbell E340 Dual (`T8214`, fw `3.2.7.2`, hw `P2`) and two eufyCam S300 (eufyCam 3C) (`T8161`, fw `3.4.3.0`, hw `P1`)
- **Host & GPU:** Fedora 44 with AMD Radeon 8060S Graphics (`radeonsi`, `gfx1151`, VCN 4.0.5)
- **Runtime:** Multi-stage `alpine:3.23` container under `Podman` Quadlet, using `Mesa 25.2+` (`mesa-va-gallium`), `tini` as `PID 1`, non-root `node` user (`UID 1000`), `Inter.ttf` UI font, `ffmpeg`, `go2rtc`, `Frigate 0.18`, and `eufy-security-ws` (API schema `21`).

## Regressions Found & Resolved (Post-Mortem Knowledge Base)

1. **Missing Comma & Failed `%` Rendering in `drawtext` Cards:**
   - **Cause:** The original `esc()` regex stripped commas (`replace(/[:'\\,]/g, ' ')`), turning `"wake it, or"` into `"wake it  or"`. Later, adding battery percentages (`85%`) caused `ffmpeg` `drawtext` to fail with `Stray % near '85%'` because `drawtext` defaults to `expansion=normal`.
   - **Fix:** Preserved commas inside single-quoted `text='...'` strings, escaped colons as `\:`, and added `expansion=none` to all `drawtext` filters.

2. **Missing Telemetry on `eufy-security-ws` API Schema 13-21:**
   - **Cause:** In schema 13+, `start_listening` returns `result.state.devices` as an array of serial number strings (`["T8161...", ...]`) rather than device objects, so `dev.serialNumber` was `undefined`.
   - **Fix:** Added `fetchAllCameraTelemetry()` to explicitly invoke `device.get_properties` per camera after `start_listening`, unwrapping both direct values and `{ value }` metadata objects.

3. **Cross-Camera Residual Frame Contamination (Doorbell Showing Another Camera's View):**
   - **Cause 1:** `eufy-security-client` caches notification thumbnails (`properties.picture`) at the HomeBase station level, frequently returning the last event picture from a different camera on the same HomeBase.
   - **Cause 2:** Unsynchronized `P2P` channel switching (`stop_livestream` vs. `start_livestream`) caused residual packets in the HomeBase `P2P` buffer from Camera A to be emitted after Camera B started.
   - **Fix:** Never decode `properties.picture`. Key cached snapshots by both name and serial (`last_<name>_<serial>.jpg`). Serialize all `P2P` handovers via per-station `stationTransitions` (awaiting `stop_livestream` + 150ms settle delay), update `cam.lastFrame` immediately on the first decoded keyframe of the session, and hold `cam.frame || cam.lastFrame` while `cam.active && cam.gotVideo`.

4. **Spontaneous Camera Wakeups, Multi-Camera Grid Wakeups & Decoder Resets:**
   - **Cause 1 (IPv6 / Docker Bridge Recorder Filter):** The original viewer filter required `127.0.0.1` alongside `FFmpeg Frigate`.
   - **Cause 2 (Mid-Sleep Card Re-renders):** Re-rendering `cam.asleep` on `property changed` events while asleep caused Frigate's `detect` stream to detect the pixel change as motion.
   - **Cause 3 (Slow-Waking Camera Left in Queue on Fast Camera Switching):** Switching cameras quickly left the first camera's `start_livestream` in flight and its viewer queue active.
   - **Cause 4 (Frigate Multi-Camera Dashboard Grid):** Opening Frigate's Live dashboard connects `mse/fmp4` viewers to all cameras in the same second, waking sleeping cameras after cooldown.
   - **Cause 5 (Dynamic P2P Resolution Shifts):** Eufy `T8161`/`T8214` streams dynamically shift resolution (`3840x2160 <-> 2304x1296`, `1600x2200 <-> 1024x1408`) mid-session; restarting `ffmpeg` on width/height changes caused 1-2s freezes.
   - **Fix:** Filter `/FFmpeg Frigate|^go2rtc/i` regardless of IP; ignore poll cycles where 2+ sleeping cameras get new viewers simultaneously (`isDashboardGrid`); only restart the decoder if the video codec changes; purge other P2P cameras' viewer queues on single-camera switch; await `cam.startPromise` before `stop_livestream`.

5. **Telemetry Icons Hanging Below Text Baseline & Stuck Low-Battery State After Physical Swap:**
   - **Cause 1:** For `fontsize=20` at `textY`, FFmpeg renders cap-top at `textY` and baseline at `textY + 14` (center `textY + 7`), whereas 18px icons at `textY..textY+18` hung 4px below the baseline.
   - **Cause 2:** Swapping a physical battery while a camera was in Low-Battery Economy Mode left the card stuck at `14%` because `eufy-security-ws` needed `driver.poll_refresh` and `applyDeviceProperties` did not re-render cards on battery jumps while asleep.
   - **Fix:** Unified icon rendering in `drawTelemetryRow()`, added `telemetry_poll_secs` + `driver.poll_refresh`, and auto-rebuilt cards on >= 10% battery jumps or economy mode changes.

6. **AMD Radeon 8060S (`gfx1151`) VA-API Hardware Encoding & Sleeping Frame Sharpness:**
   - **Cause:** `alpine:3.20` ships `Mesa 24.0.9`, which lacks VCN 4.0.5 (`gfx1150`/`gfx1151`) encode profile tables, VCN 4.0.5 rejects B-frames by default, and `-qp 24` with default JPEG caching softened dark sleeping snapshots.
   - **Fix:** Upgraded runtime base image to `alpine:3.23` (`Mesa 25.2+`) with `mesa-va-gallium`, set `-bf 0 -qp 18` on `h264_vaapi`, added `-q:v 2` to cached JPEG snapshots, and enabled `flags=lanczos` scaling.

7. **Center Overlay False Motion & Black Screens on Rapid Camera Switching:**
   - **Cause 1:** The centered `820x336` modal cannot be masked in Frigate without blinding center-frame motion detection.
   - **Cause 2:** A 10-second keyframe interval (`-g 20` at `2 fps`) and resetting `sleptAt` on card rebuilds caused MSE/WebRTC players to show a black screen or hit false cooldowns when clicking cameras sequentially.
   - **Fix:** Unified placement under `card_position` (`center` + 4 corners) with frosted-glass `detailed`, `icons`, `minimal`, and `none` themes; added event-driven frame pushing, `1.2s` keyframe bursts on viewer connect/state change, `750ms` viewer polling, and zero-probe low-latency decoder startup.

8. **HomeBase 3 RTSP Wake Sequence, P2P Extension Loops & Burst Download Pacing:**
   - **Cause 1:** Calling `device.stop_rtsp_livestream` on sleep disabled the camera's NAS/RTSP toggle on the HomeBase, while passing `-analyzeduration 0` to `ffmpeg -rtsp_transport tcp` aborted RTSP SDP dimension probing.
   - **Cause 2:** Extending `motionUntil` by `+5s` whenever video was still flowing kept `device.start_livestream` P2P sessions open until the HomeBase 2.5-5m hard limit.
   - **Cause 3:** HomeBase 3 ignores legacy `station.database_query_local` and bursts `.zxvideo` clip downloads at ~10x real-time speed.
   - **Fix:** Wake RTSP via sequential `rtspStream=true` + `device.start_rtsp_livestream` with `750ms` retries and never call `stop_rtsp_livestream` on sleep; end P2P event streams `5s` after Eufy reports `state: false`; query HomeBase 3 via `station.database_query_latest_info` / `station.database_query_by_date` and pace buffered `downloadFrames` at `15 fps` (`LIVE_FPS`).

9. **Doorbell (`T8214`) Battery Drain, Late P2P Wake & Companion-Event Backfill Cancellation:**
   - **Cause 1:** Global `hold_secs: 60` + `let_eufy_decide_event_end: false` (plus setting `recordingClipLength: 60` across all cameras) forced the battery doorbell to stay awake for `60s` on every hallway pass-by, while P2P wake latency (`3-6s`) missed the person walking past and recorded `60s` of an empty hallway.
   - **Cause 2:** In `applyMotionTrigger()`, companion AI events (`person detected` / `identity person detected` arriving `3-5s` after `motion detected`) set `runtimeExtended = true` and cleared `pendingBackfill` whenever `now - startedAt > 3000`, even if `0s` of live video had been decoded.
   - **Cause 3:** `processBackfillQueue()` checked `sleptAt` across all cameras globally (allowing RTSP sleeps to delay P2P backfills) and queried HomeBase DB at a fixed `+8s` while the hardware clip was still recording.
   - **Fix:** Added per-camera mode presets (`"rtsp"`, `"backfill"`, `"p2p"`, `"custom"`), per-camera timer overrides (`resolveCameraTimers`), and Eufy Power Manager auto-sync (`resolveHardwareRecordingConfig`) so the doorbell records a brief native clip (with `t=0` pre-roll) to HomeBase 3 and sleeps immediately; required `hasSustainedLiveVideo` (`>= 5s`) before clearing `pendingBackfill`; waited for `state: false` (`markRecordingCleared`) + `2s` settle before querying HomeBase DB; and scoped backfill idle checks per station across non-RTSP P2P cameras (`isStationIdleForBackfill`).

10. **Duplicate Startup Mask Sync, Post-Viewer Linger RTSP Re-Wake Loops & Lingering Station Stream Preemption:**
   - **Cause 1:** `syncFrigateMotionMasks` ran twice on startup (via a redundant `2500ms` timer in `src/app.js` and an uninitialized `lastMaskCheckAt = 0` in `frigate-client.js`), and Frigate's `GET /api/config` omits `objects.mask` at the camera root when only `motion.mask` is serialized in memory.
   - **Cause 2:** When a viewer closed Live View on an RTSP camera (`viewers.size === 0`, lingering for `20s`), a clip-boundary drop triggered `handleRtspStreamDropped`, which reset `viewUntil = now + VIEW_LINGER_MS` and called `startRtspStream` in a loop.
   - **Cause 3:** When clicking Back to the Frigate multi-camera dashboard while 1 camera was still active, the 2 sleeping cameras connected simultaneously (`camerasWithNewViewers.length === 2` while `anyCameraAlreadyActive === true`), bypassing `isDashboardGrid` and waking the second camera; conversely, opening a second camera on the same HomeBase while the first was lingering with 0 viewers caused RTSP/P2P contention on the HomeBase.
   - **Fix:** Removed the duplicate startup timer, initialized `lastMaskCheckAt = Date.now()`, and tracked `objectsMaskSynced`; added `Camera.shouldRewakeRtspOnDrop(now)` so RTSP drops during 0-viewer post-linger stop cleanly (`initiator=eufy/rtsp-end`); updated `isDashboardGrid` to catch `>= 2` simultaneous sleeping camera connections whenever `< 2` cameras are active; and added `Camera.shouldYieldToNewStationViewer(targetCam, now)` so 0-viewer lingering streams on the same HomeBase stop immediately (`initiator=viewer-preempt`) when the user opens another camera.

11. **Truncated `"backfill"` Clips on Doorbell (`T8214`) & Multi-Clip Visits:**
   - **Cause 1 (Premature Query on Partial Clear):** Eufy doorbells emit multiple concurrent trigger properties (`motion detected`, `person detected`, `identity person detected`, `rings`). When one property flipped to `state: false` early while `motion detected` was still active, `markRecordingCleared` immediately started a `2s` timer, and `extractDatabaseRecordCandidate` synthesized the `.zxvideo` path from `crop_local_path` (which `HomeBase 3` creates at `t=0` when recording starts), causing `device.start_download` to pull an incomplete file while the camera was still recording.
   - **Cause 2 (Unflushed FFmpeg Decoder Tail & Immediate Sleep after Last Frame):** When `eufy-security-ws` emitted `'download finished'`, `dec.stdin` was never closed for EOF (`flushDecoderInput`), leaving the last `0.5-1.5s` of frames inside FFmpeg's `H.265`/`H.264` reorder buffer, and `checkDownloadSessionHealth` immediately switched the stream back to the static `5 fps` sleeping card on the tick the last buffered frame was written (`downloadFrames.length === 0`), cutting off Frigate's recording tail. Additionally, `appendAudioPcmChunk` capped `cam.pcm` at `1s` (`RATE * 2`), discarding ~90% of burst-downloaded audio.
   - **Cause 3 (Single-Clip Overwrite & Query Ordering on Multi-Clip Visits):** Calling `station.database_query_latest_info` (which returns only 1 record per camera) before `station.database_query_by_date` caused the single latest clip to immediately start downloading and call `clearPendingBackfill()`, discarding earlier or split clips from the same visit.
   - **Fix:** Tracked active trigger properties per camera/job (`activeTriggerEvents` / `activeEvents`) so `markRecordingCleared` only marks recording complete once all active properties report `state: false`, raised `BACKFILL_POST_CLEAR_SETTLE_MS` to `4000ms` (and scaled the wait cap to `Math.max(35000, holdMs + 4000)`), added `flushDecoderInput(cam)` on `'download finished'`, held the final frame for `2500ms` (`DOWNLOAD_POST_PLAYBACK_HOLD_MS`), expanded burst download video/audio buffers (`MAX_DOWNLOAD_BUFFER_SECS = 120`, `KEY_PACKET_SCAN_BYTES = 4096`), queried `database_query_by_date` before `database_query_latest_info`, queued all matching clips chronologically in `cam.backfillClipQueue` with automatic post-download follow-up queries for split clips (`needsFollowUpClipQuery`), and scaled Frigate's event `duration` (`getEffectiveEventDurationSecs`).

## Implementation History

- [x] Block 1 - Doorbell & HomeBase 3 Intelligence (`rings`, `forward_face_names`, `preserve_aspect_ratio`)
- [x] Block 2 - Smart Battery Conservation & Battery Swap Detection (`early_sleep_secs`, Low-Battery Economy Mode, `enforce_streaming_quality`, `telemetry_poll_secs`, `driver.poll_refresh`)
- [x] Block 3 - Persistent Snapshot Cache (`/config/cache`), Startup Snapshot Probe (`startup_snapshot`), and Hardware-Accelerated FFmpeg Encoding (`hwaccel`: `vaapi`, `qsv`, `nvenc`, `v4l2m2m`)
- [x] Block 5 - Structured Logging (`[LEVEL] [camera]`, `LOG_LEVEL`), HomeBase Reboot Resilience, Eufy-Controlled Event End (`let_eufy_decide_event_end`), and Un-Dimmed Card Background (`card_dim_background: false`)
- [x] Block 6 (Steps 1-4) - Camera/Event Priority Arbitration (`priority`, `EVENT_PRIORITIES`), HomeBase Native RTSP Ingestion (`use_rtsp`), HomeBase 3 Post-Event Clip Backfill (`backfill_downloads`, `SIGUSR1`), Multi-Station Concurrent P2P Arbitration (`stationSerial`), Auto-Applied Frigate Corner Masks (`auto_frigate_mask`), Live Corner Cards (`card_show_on_live`), and Instant Event Snapshots (`instant_event_snapshot`)
- [x] Block 7 - Enterprise Modular Refactoring (`src/config.js`, `src/logger.js`, `src/domain/*`, `src/overlay/*`, `src/media/*`, `src/services/*`) & 6-Color Semantic Palette (`Red`, `Grey`, `Green`, `Blue`, `Yellow`, `Purple`)
- [x] Block 8 (Steps 1-4) - Built-In HTTP Server (`/api/wake/:cameras` & `/healthz`), Cross-Camera Hold Persistence, Per-Station Wake Pacing, External `eufy-security-ws` Stream Adoption (`initiator=eufy-ws`), Non-Destructive RTSP Handshake Guard, and Backfill Visual Indicators (double-triangle rewind glyph & concentric bullseye dot)
- [x] Block 9 - Per-Camera Recording Timers (`resolveCameraTimers`), Eufy Hardware Power Manager Auto-Sync (`resolveHardwareRecordingConfig`), Backfill-Only Event Mode (`always_backfill`), Event-End Aware Backfill (`state: false` + `2s` settle), Companion-Event Backfill Preservation, and Per-Station Backfill Queue Isolation (`isStationIdleForBackfill`)
- [x] Block 10 - Configuration Simplification (`mode`: `"auto" | "rtsp" | "p2p" | "backfill" | "custom"` via `resolveCameraMode`, `sleep_screen`: `"snapshot" | "slate" | "black"`, per-camera `trigger_events`, `backfill_downloads`, `low_battery_threshold`, & `low_battery_wake_on_view`, defensive non-contradiction validation for `"custom"` overrides & `idle_fps <= live_fps`, unified `hold_secs` & `end_early` auto-syncing Eufy Power Manager on startup, optional `cameras[].name` defaulting to `serial`, default `card_theme: "icons"` and `card_position: "top-left"`, `"default"` theme renamed to `"detailed"`, Startup Mask Sync & Post-Viewer Linger/Preemption Fixes (`shouldRewakeRtspOnDrop`, `shouldYieldToNewStationViewer`), hermetic `.venv/` local Node.js toolchain, concise `node:test` reporter (`test/reporter.js`) & suite in `test/*.test.js`, and User-Friendly `README.md` Rewrite)
- [x] Block 11 - Complete HomeBase 3 Backfill Clip Capture & Multi-Clip Playback (Active multi-trigger settlement via `activeTriggerEvents` / `activeEvents` + `4s` `BACKFILL_POST_CLEAR_SETTLE_MS`, chronological multi-clip queue `backfillClipQueue` with `database_query_by_date`-first ordering & automatic follow-up queries for split clips via `needsFollowUpClipQuery`, quiet encoder handshake before `Frame 0` + double-buffered `liveOverlayBufs` + `800ms` `BACKFILL_SNAP_DELAY_MS` pipeline transit synchronization, FFmpeg decoder EOF tail flush via `flushDecoderInput`, `2.5s` `DOWNLOAD_POST_PLAYBACK_HOLD_MS` tail hold, `120s` burst video/audio download buffering, drain-safe `canAdvanceDownloadFrame`, and dynamic Frigate event duration scaling via `getEffectiveEventDurationSecs`)
