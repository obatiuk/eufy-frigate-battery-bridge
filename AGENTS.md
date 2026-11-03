# AGENTS.md

## Repository Layout

```text
.
├── Dockerfile                         # Multi-stage alpine:3.23 build (COPY src/ /app/)
├── Makefile                           # Podman build, syntax check (make check), publish & clean targets
├── README.md                          # User documentation, feature guide & troubleshooting
├── AGENTS.md                          # Architecture, domain model, post-mortems & roadmap
├── examples/
│   ├── config.example.minimal.json    # Minimal configuration example
│   ├── config.example.full.json       # Full configuration example with all options
│   ├── docker-compose.example.yml     # Example Docker Compose deployment
│   └── icons-theme-sample.jpeg        # Visual preview of the icons status card theme
└── src/
    ├── app.js                         # Application composition root, wiring & signal handlers
    ├── config.js                      # Config loader, validation, numeric clamping & constants
    ├── logger.js                      # Structured Alloy/Loki logger & ICU-free local ISO timestamps
    ├── domain/
    │   ├── camera.js                  # Camera entity composing StatusCard, Telemetry & stream rules
    │   ├── status-card.js             # StatusCard model (theme/position, bounds & Frigate mask polygon)
    │   ├── telemetry.js               # Telemetry model (sensor state, Eufy parsing & 6-color rules)
    │   └── backfill-job.js            # BackfillJob model (.zxvideo record parser & time-window matcher)
    ├── overlay/
    │   ├── yuv-canvas.js              # Low-level YUV420p drawing, anti-aliasing & box blur
    │   ├── card-renderer.js           # Theme engines (default, icons, minimal, none) & mask bounds
    │   └── snapshot-cache.js          # Persistent JPEG <-> YUV420p snapshot cache (/config/cache)
    ├── media/
    │   ├── encoder.js                 # Persistent FFmpeg RTSP encoder, drain pipe & A/V tickers
    │   └── decoder.js                 # Per-session P2P Annex-B & RTSP pull FFmpeg decoders
    └── services/
        ├── eufy-client.js             # eufy-security-ws WebSocket RPC client & telemetry sync
        ├── frigate-client.js          # Frigate & go2rtc HTTP client (events, masks, idle & viewer poll)
        ├── ha-notifier.js             # Home Assistant webhook notification client
        ├── http-server.js             # Built-in HTTP server (/api/wake/:cameras & /healthz)
        └── stream-orchestrator.js     # Per-station arbitration, RTSP/P2P wake, backfill & watchdog
```

## Key Commands

- Syntax Check: `make check` (runs `node --check` across all `.js` modules in `src/`)
- Build Image Locally: `make docker-build` (validates `src/app.js` and builds multi-stage `alpine:3.23` image using
  `/usr/bin/podman` by default)
- Publish Locally: `make publish` (builds and tags `localhost/eufy-frigate-battery-bridge:latest`; skips remote push
  when `REGISTRY` is empty)
- Publish to Private Registry: `make publish REGISTRY=<registry> BUILD_VERSION=<version>` (tags during build and pushes
  with `--tls-verify=false`)
- Clean Images: `make clean` (removes local build and publish tags)
- Print Makefile Variables: `make print-vars`
- Check Bridge Readiness: `curl -s http://127.0.0.1:8080/healthz`
- Trigger External Camera Pre-Wake: `curl -s -X POST http://127.0.0.1:8080/api/wake/all -H "Content-Type: application/json" -d '{"reason":"test wake","duration":30}'`
- Trigger Test Frigate Event: `podman kill -s USR2 eufy-frigate-battery-bridge` (files a `"test"` event on the first
  camera without waking it)
- Trigger Test Backfill Download: `podman kill -s USR1 eufy-frigate-battery-bridge` (queries HomeBase 3 and replays the
  latest recorded `.zxvideo` clip at `15 fps` into Frigate)
- Inspect Hardware & Firmware Versions (run inside container):

```shell
podman exec eufy-frigate-battery-bridge node -e '
  const fs = require("fs");
  const WS = require("ws");
  const cfgPath = process.env.BRIDGE_CONFIG || process.env.CONFIG_PATH || "/config/config.json";
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const ws = new WS(cfg.eufy_ws);

  let id = 0;
  const send = (cmd) => ws.send(JSON.stringify({ messageId: String(++id), ...cmd }));
  const unwrap = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "version") {
      send({ command: "set_api_schema", schemaVersion: Math.min(m.maxSchemaVersion, 21) });
      send({ command: "start_listening" });
    } else if (m.messageId === "2") {
      for (const s of m.result?.state?.stations || []) {
        send({ command: "station.get_properties", serialNumber: s.serialNumber || s });
      }
      for (const d of m.result?.state?.devices || []) {
        send({ command: "device.get_properties", serialNumber: d.serialNumber || d });
      }
      setTimeout(() => process.exit(0), 1500);
    } else if (m.type === "result" && m.result?.properties) {
      const p = m.result.properties;
      console.log(
        unwrap(p.name) +
          " | model=" + unwrap(p.model) +
          " | serial=" + unwrap(p.serialNumber) +
          " | fw=" + unwrap(p.softwareVersion) +
          " | hw=" + unwrap(p.hardwareVersion)
      );
    }
  });
'
```

## Coding & Style Guidelines for Agents

- Step-by-Step Scoped Patches: Keep patch scripts small, modular, and scoped step-by-step per file rather than bundling
  large multi-file rewrites into a single script. Never use nested backtick template literals inside patch scripts.
- No Magic Numbers & Config-First Constants: Never embed unexplained magic numbers (such as raw millisecond timeouts,
  retry counts, buffer sizes, or priority scores) inside functions. Always reference configurable values exported from
  `src/config.js` (`HOLD_MS`, `MAX_MS`, `LOW_BAT_HOLD_MS`, `VIEW_MAX_MS`, `EARLY_SLEEP_MS`, `BACKFILL_DELAY_MS`,
  `LIVE_FPS`, `getEventPriority`) and define descriptive `UPPER_SNAKE_CASE` module constants for internal protocol or
  timing thresholds (except obvious unit conversions such as `* 1000` or `/ 1000`).
- Idiomatic, Self-Documenting & Testable Code: Write clean, idiomatic Node.js with small, single-responsibility
  functions. Extract complex boolean conditions into named variables or pure helper predicates, and structure
  orchestrator and domain functions so state transitions can be unit-tested deterministically without live hardware.
- Block-Grouped Roadmap Convention: Always organize grouped changes, multi-part enhancements, and sequential
  implementation steps (such as Step 1/2/3) into dedicated, numbered `Block` sections under `Roadmap & TODO List` in
  `AGENTS.md`.
- Backward Compatibility: Strictly preserve drop-in compatibility with existing `config.json` files (supporting both
  `BRIDGE_CONFIG` and `CONFIG_PATH` environment variables, plus shorthand `trigger_events` aliases) and `README.md`
  behavior.
- Comment Formatting: Always use clean, left-justified comments and comprehensive JSDoc blocks on every function. Never
  add decorative comment dividers (such as `// ----`).
- String & Template Safety in `src/app.js`: Use standard single-quoted strings (`'...'`) with `+` concatenation
  instead of multi-line backtick template literals or backticks inside comments to prevent parser/linter errors across
  strict IDEs.
- Documentation Conventions in `README.md`: Always capitalize Eufy in prose, and wrap service names, binaries,
  protocols, codecs, and config keys (`go2rtc`, `ffmpeg`, `eufy-security-ws`, `RTSP`, `P2P`, `WebSocket`, `Podman`,
  `H.264`, `H.265`) in backticks.
- Commit Message Attribution: Always include `Co-authored-by: Gemini <gemini@google.com>` at the end of git commit
  messages.

## Configuration Reference (`config.json`)

### Required Keys

- `eufy_ws`: `WebSocket` URL for `eufy-security-ws` (e.g., `ws://eufy-security-ws:3000`)
- `go2rtc_api`: Frigate's `go2rtc` HTTP API URL (e.g., `http://frigate:1984`)
- `rtsp_publish`: `RTSP` publish URL template containing `{name}` (e.g., `rtsp://frigate:8554/{name}`)
- `cameras`: Array of camera objects
  `[{ "name", "serial", "title", "priority", "use_rtsp", "rtsp_url", "station_serial", "telemetry", "card_theme", "card_position", "card_background", "card_dim_background", "card_show_on_live", "auto_frigate_mask", "preserve_aspect_ratio", "startup_snapshot" }]`

### Optional Core Keys

- `frigate_api`: Frigate HTTP API URL (`http://frigate:5000`) for filing external events and checking active detections
- `http_port`: Internal HTTP server port for `/api/wake/:cameras` and `/healthz` (default: `8080`, `0` to disable; also configurable via `HTTP_PORT` env var)
- `ha_webhook`: Home Assistant webhook URL (receives POST on trigger start and after Frigate event creation)
- `log_level`: Minimum log level (`"debug"`, `"info"` [default], `"warn"`, `"error"`); also configurable via `LOG_LEVEL`
  env var
- `use_rtsp`: Automatically use HomeBase native `RTSP` (`rtspStreamUrl`) on cameras that support `NAS / RTSP Stream` so
  the HomeBase `P2P` slot remains free for `P2P`-only cameras/doorbells (default: `true`; can be overridden per camera)
- `backfill_downloads`: Automatically query HomeBase local storage (`station.database_query_latest_info` /
  `station.database_query_by_date`) and download missed event clips (`device.start_download`) at `15 fps` real-time
  speed into Frigate when a P2P camera triggers while its station P2P slot is busy (default: `true`)
- `backfill_delay_secs`: Seconds a station's P2P slot must be idle before starting a queued backfill download (default:
  `5`)
- `let_eufy_decide_event_end`: Optional battery-saver mode to end event livestreams early when Eufy sends `livestream stopped` or `5s` after Eufy
  reports `state: false` (once at least `10s` of video has been shown) (default: `false` so cameras stay live for the full `hold_secs`)
- `preempt_event_streams`: Allow newer motion on an equal-priority camera to preempt an active event stream immediately
  (default: `true`)
- `audio`: Enable audio passthrough (default: `true`)
- `hold_secs`: Initial duration to stay live on wake (default: `60`). While active, subsequent events, mid-stream camera re-triggers, or active Frigate object detections within `4s` of timeout (`evaluateActiveHoldExtension`) extend the hold by `hold_secs / 2` (`+30s`) up to `max_secs` (`900s`).
- `max_secs`: Hard cap for a single continuous live period (default: `900`)
- `view_linger_secs`: Stay live after the last viewer disconnects (default: `20`)
- `view_max_secs`: Hard cap for a viewer-only live session (default: `300`)
- `viewer_cooldown_secs`: Ignore viewers connecting this soon after a camera finishes streaming (default: `5`)
- `trigger_events`: Array of Eufy event names or shorthand aliases (`motion`, `person`, `pet`, `vehicle`, `dog`,
  `stranger`, `identity person`, `sound`, `rings`, `ringing`)
- `event_secs`: Duration of the Frigate event in seconds (default: `30`)
- `snapshot_delay_secs`: Seconds of continuous decoded video required before filing the Frigate event so the snapshot is
  live video (default: `3`)
- `width` / `height`: Output stream resolution (default: `1280` x `720`)
- `live_fps` / `idle_fps`: Output frame rate when live (`15`) vs. asleep (`5`)
- `font_file`: Path to `.ttf` font (defaults to `/usr/share/fonts/Inter.ttf` from `Dockerfile`)

### Optional Card Themes, Placement, Telemetry, Doorbell, Smart Battery & Hardware Acceleration Keys

- `priority` (per camera in `cameras[]`): Base integer priority weight (`-10000` to `10000`, default: `0`). Added to
  built-in event priority boosts (`EVENT_PRIORITIES`: `ring` `+1000`, `identity person` `+300`, `person`/`stranger`
  `+200`, `vehicle`/`pet`/`dog` `+100`, `crying`/`sound` `+50`, `motion` `+10`) to compute `getEffectivePriority(cam)`.
- `use_rtsp` / `rtsp_url` (per camera in `cameras[]`): Enable/disable HomeBase RTSP pull for a specific camera or
  override the auto-discovered `rtspStreamUrl`.
- `station_serial` (per camera in `cameras[]`): Optional explicit station serial override (auto-populated from
  `stationSerialNumber` in `device.get_properties`).
- `card_theme`:
	- `"default"` (default): Frosted-glass panel with full text (`Asleep`, `Asleep (Low Battery)`, `Waking Up...`,
	  `Waiting`) + graphical telemetry icons. Renders the centered `820x336` modal with a color-coded status glyph when
	  `card_position` is `"center"`, or a compact `540x88` card when `card_position` is a corner.
	- `"icons"` (alias `"icons-only"`): Crisp vector icons inside a `44px`-high frosted-glass capsule (`44%` opacity)
	  with zero text and no `ffmpeg` spawn (Status glyph, Battery + charging bolt, Curved Wi-Fi arcs colored by `RSSI`,
	  Thermometer with tick marks, and `Last live` analog clock with `HH:MM` hands).
	- `"minimal"` (alias `"dots"`): Three graduated color-coded semantic dots (`[Status]  [Battery]  [Wi-Fi]`) inside a
	  `92x36` frosted-glass capsule (`42%` opacity) with zero text and no `ffmpeg` spawn.
	- `"none"` (aliases `"blank"`, `"black"`, `false`): Hides the status overlay while honoring `card_background`
	  (`"snapshot"`, `"slate"`, or `"black"`).
- `card_position` (alias `card_corner`): `"center"` (default), `"bottom-left"`, `"bottom-right"`, `"top-left"`, or
  `"top-right"` (also accepts `"left-bottom"`, `"right-top"`, etc.). Applies to `"default"`, `"icons"`, and `"minimal"`
  themes. Can be overridden per camera.
- `card_background`: `"snapshot"` (default last live frame), `"slate"` (solid dark slate `0x22`), or `"black"`/`"none"`
  (pitch-black `0x10` background). Can be overridden per camera.
- `card_dim_background`: `false` (default) or `true`. Controls whether `"snapshot"` backgrounds are dimmed across the
  entire frame behind status cards. Disabled by default so unmasked background pixels do not trigger Frigate motion
  detection on sleep/wake transitions. Can be overridden per camera.
- `card_show_on_live`: `true` (default) or `true`/`false` per camera. Keeps corner status cards
  (`card_position !== "center"`) visible on the live video stream (using a `Red` on-air live dot/play glyph) via a
  zero-allocation scratch buffer while keeping `cam.lastFrame` and `/config/cache` snapshots clean.
- `auto_frigate_mask`: `true` (default) or `true`/`false` per camera. Computes the exact normalized bounding-box polygon
  for each camera's corner status card (with a `6px` chroma/anti-aliasing safety margin) and syncs both
  `motion.mask.eufy_bridge_card` and `objects.mask.eufy_bridge_card` into Frigate via `GET /api/config` and
  `PUT /api/config/set` (`requires_restart: 0`) on startup, every 60s, and automatically whenever Frigate restarts.
- `instant_event_snapshot`: `true` (default). Uses a fast `1.2s` snapshot delay on RTSP wakes, files events immediately
  if a clip ends early after receiving video, and temporarily pushes the clean un-overlayed `cam.lastFrame` on `noVideo`
  timeouts so Frigate never saves the `"Waking Up..."` card as an event thumbnail.
- `telemetry`: `true` (default), `false`, or object
  `{ "enabled": true, "battery": true, "power_source": true, "wifi": true, "rssi": true, "temperature": true, "last_seen": true }`.
  Can also be overridden per camera in `cameras[]`.
- `telemetry_poll_secs`: Interval in seconds to poll `device.get_properties` (and `driver.poll_refresh` when in
  Low-Battery Economy Mode) so battery swaps and charging updates are detected while sleeping (default: `300`, `0` to
  disable).
- `cache_dir`: Directory for storing persistent camera snapshots `last_<name>_<serial>.jpg` across container restarts
  (default: `/config/cache`, falls back to `/tmp`).
- `startup_snapshot`: `true` (default) wakes a camera once on startup if it has no cached frame on disk (and
  `card_background` is `"snapshot"`) and puts it right back to sleep after 2s of clean video; `"always"` forces a
  startup snapshot probe even if cached; `false` disables. Can be overridden per camera.
- `hwaccel`: `false` (default), `"vaapi"`, `"qsv"`, `"nvenc"`, or `"v4l2m2m"`. Offloads continuous H.264 encoding to GPU
  (`-qp 18` on `vaapi`, `-crf 19` on `libx264`) and falls back to `libx264` automatically on error.
- `hwaccel_device`: Render node path for `vaapi`/`qsv` (default: `/dev/dri/renderD128`).
- `preserve_aspect_ratio`: `true` (default) scales non-16:9 streams (such as 4:3 or dual-lens `T8214` doorbells)
  proportionally with Lanczos scaling and dark letterbox/pillarbox padding instead of stretching. Can be overridden per
  camera.
- `forward_face_names`: `true` (default) forwards recognized face names from HomeBase 3 (`identity person detected`) as
  Frigate's `sub_label` and includes `person` in the Home Assistant webhook payload.
- `ring_label`: Frigate event label used when a doorbell `rings` event fires (default: `'person'`).
- `early_sleep_secs`: Optional battery saver that shortens the motion hold window once `early_sleep_secs` (default:
  `0` [disabled]) has elapsed since motion cleared with no active Frigate object detections.
- `low_battery_threshold`: Battery percentage at or below which uncharged cameras enter Low-Battery Economy Mode
  (default: `20`, set `0` to disable).
- `low_battery_hold_secs`: Reduced `hold_secs` used when a camera is in Low-Battery Economy Mode (default: `20`).
- `low_battery_wake_on_view`: Whether live-view requests are allowed to wake a camera in Low-Battery Economy Mode
  (default: `false`).
- `enforce_streaming_quality`: `true` (default), `false`, or integer quality ID (e.g., `7` for Medium `1280x720`). When
  `true`, automatically switches cameras configured as `"Auto"` (`0`) to `7` (`Medium`) so `P2P` streams do not
  negotiate `4K` and stall.

## Architecture & Hardware Environment

### Modular Architecture & Dependency Flow

Data and dependencies flow strictly top-down from the composition root (`src/app.js`) to the foundation layer
(`domain/camera.js`, `config.js`, `logger.js`) with zero circular `require()` dependencies:

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

- Per-Station P2P Stream Arbitration (`arbitrate`, `getStationKey`): Eufy HomeBase stations multiplex one active P2P
  stream (`activeMode === 'p2p'` or `'download'`) at a time per `stationSerial`. Standalone Wi-Fi cameras/doorbells
  (`stationSerial === cam.serial`) and multiple HomeBase stations are arbitrated independently with per-station
  transition locks (`stationTransitions`), allowing concurrent P2P streaming across distinct stations.
- HomeBase Native RTSP Ingestion (`use_rtsp`, `startRtspStream`, `startRtspDecoder`): Enabled (`true`) by default.
  Automatically discovers `rtspStreamUrl` from `device.get_properties` on cameras with NAS/RTSP support (`T8161`), wakes
  the camera via `rtspStream=true` and `device.start_rtsp_livestream`, and streams them in `activeMode = 'rtsp'`
  concurrently alongside P2P cameras (`usesP2pSlot(cam) === false`). Retries RTSP connection every `750ms` during the
  wake window, re-sends `start_rtsp_livestream` every `3.5s` (`RTSP_WAKE_RETRY_MS`) if needed, immediately re-wakes (`0ms`) on mid-session clip boundary drops, and queues a `60s` P2P fallback
  (`rtspFallbackUntil`, reset on `stop()`) routed cleanly through `arbitrate()` if no RTSP frames arrive within `22s`.
- Post-Event Clip Download Backfill (`backfill_downloads`, `processBackfillQueue`, `handleDatabaseQueryResult`): Enabled
  (`true`) by default. When a P2P camera triggers motion while its station's P2P slot is busy (or is preempted before
  capturing 5s of video), `pendingBackfill` records the event metadata. Once the P2P slot is idle for
  `backfill_delay_secs` (`5s`), the bridge connects to the station (`station.connect`), calls
  `station.database_query_latest_info` and `station.database_query_by_date`, matches the latest `.zxvideo` clip
  (`storage_path` / `crop_local_path` and `cipher_id`), buffers burst-downloaded frames into `downloadFrames` to play
  out at `15 fps` (`LIVE_FPS`) via `device.start_download` (`activeMode = 'download'`, `initiator = 'bridge-backfill'`),
  and files the Frigate event. Any live motion or viewer request immediately preempts an active download
  (`initiator = 'bridge-arbitrator/live-over-download'`).
- Camera & Event Priority Tiers (`getEffectivePriority`): Combines per-camera `priority` from `config.json` with
  built-in `EVENT_PRIORITIES` (`ring`: `+1000`, `identity person`: `+300`, `person`/`stranger`: `+200`, `vehicle`/`pet`/
  `dog`: `+100`, `crying`/`sound`: `+50`, `motion`: `+10`). Companion events arriving while a camera is already live
  automatically upgrade `cam.eventPriority` in-place.
- Zero-Dwell Event Switching: `min_dwell_secs` has been removed. Higher-priority events (`pickScore > curScore`,
  `initiator=bridge-arbitrator/higher-priority-event`) and newer events on equal-priority cameras
  (`pickScore === curScore`, `initiator=bridge-arbitrator/newer-motion` when `preempt_event_streams` is `true`) preempt
  the active camera immediately with a `150ms` P2P handover settle delay. Lower-priority cameras
  (`pickScore < curScore`) are blocked from preempting an active higher-priority event until its motion clears or
  stalls.
- Eufy Power Manager (`powerWorkingMode`) & Event Hold Interaction: Eufy cameras in `Optimal Battery Life` (`powerWorkingMode: 0`) send `state: false` (`activity cleared`) `10s` after motion starts regardless of `recordingClipLength`. Because `let_eufy_decide_event_end` defaults to `false`, the bridge ignores early `state: false` events and re-requests streams if stopped before `want(cam)`, keeping streams alive for the full `hold_secs` (`60s`). For uninterrupted `60s` hardware clips without camera-side re-wakes, cameras should be switched to `Customize Recording` (`powerWorkingMode: 2`, `recordingClipLength: 60`, `recordingEndClipMotionStops: false`, `recordingRetriggerInterval: 5`).
- Eufy-Controlled Event End (`let_eufy_decide_event_end`): Disabled (`false`) by default. When explicitly enabled (`true`), when Eufy/HomeBase sends
  `livestream stopped` on an active event stream (after 3s of video or after Eufy reports `state: false`), the bridge
  puts the camera to sleep cleanly (`initiator=eufy/camera-event-end`). Additionally, when Eufy reports `state: false`
  (`activity cleared`) on an active event stream with decoded video, `motionUntil` is shortened to
  `Math.max(now + 5000, firstVideoAt + 10000)` so P2P streams do not linger after motion ends.
- Drain-Aware Frame Pipeline (`live_fps: 15`, `idle_fps: 5`): `enc.stdin.on('drain')` immediately flushes any pending
  `cam.frameNew` frame that arrived while the `1.38 MB` raw YUV420p pipe buffer was full, eliminating dropped frames and
  playback jerkiness.
- Early Sleep (`early_sleep_secs`): Disabled (`0`) by default so Frigate's internal object tracker cannot prematurely
  terminate Eufy-triggered event recordings.
- Immediate Snapshot Persistence (`lastFrame`): `cam.lastFrame` and `cam.lastSeen` update on the very first decoded
  keyframe of every session (the 2s settle delay applies only to `startup_snapshot` probes). While
  `cam.active && cam.gotVideo`, the encoder holds `cam.frame || cam.lastFrame` so preempted or stopping streams never
  flash the pre-stream `waking` card.
- Background Dimming (`card_dim_background`): Disabled (`false`) by default (configurable globally and per-camera).
  Keeps background snapshot pixels outside the status card 100% unchanged across `Live <-> Asleep` transitions so
  Frigate does not record false full-frame motion when the card area is covered by a Frigate motion mask.
- External Stream Adoption (`initiator=eufy-ws`) & HTTP Pre-Wake/Readiness Server (`http_port`, `startHttpServer`, `wakeCameraExternal`): Wakes initiated directly through `eufy-security-ws` (such as an external integration starting an `RTSP` or `P2P` stream) are automatically adopted by `onEvent` (`initiator=eufy-ws`) for `HOLD_MS` (`60s`). For CLI testing or external services without direct `eufy-security-ws` access, the HTTP server exposes `POST/GET /api/wake/:cameras` (supporting `name`, `serial`, slugified `title`, comma-separated lists, and `all`, with `RTSP`-first ordering, `2500ms` per-station pacing, and burst coalescing) alongside `GET/HEAD /healthz` (container `HEALTHCHECK` readiness probe).
- HomeBase Reboot Resilience: `onEvent` handles `source === 'station'` events (`close`, `connection error`, `connect`),
  cleanly stopping active streams on that station (`initiator=error/station-disconnect`) and re-fetching telemetry on
  reconnect without dropping FFmpeg RTSP feeds to `go2rtc`.

### Structured Logging, Priorities & Stream Initiators

All log output in `app.js` and service modules must use `log.debug()`, `log.info()`, `log.warn()`, or `log.error()` with a camera state
object (or `'bridge'` for global events) as the first argument so every line is formatted identically for Grafana
Alloy / Loki ingestion:

    YYYY-MM-DD HH:MM:SS [LEVEL] [camera_or_bridge] message

- Timestamps: Formatted via `formatLocalTimestamp()` (`YYYY-MM-DD HH:MM:SS`) using local `Date` getters (respecting
  `TZ`) with zero ICU locale dependencies so Grafana Alloy's ISO-8601 regex always matches.
- Configuration: Controlled via the `LOG_LEVEL` environment variable or `log_level` in `config.json` (`debug`,
  `info` [default], `warn`, `error`).
- Key-Value Context: Lifecycle and stream interruption logs must include structured `key=value` pairs (`initiator=...`,
  `reason="..."`, `live=...s`, `gotVideo=...`, `lastVideoAgo=...`, `session=...`).

#### Log Priority Levels

| Level   | Usage Guidelines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|:--------|:--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ERROR` | Unrecoverable session or subsystem failures: `eufy-security-ws` socket errors, `start_listening` failures, `device.start_livestream` RPC failures, watchdog forced stream closures after 3 failed retries (`initiator=error/watchdog-timeout`), wedged FFmpeg encoder `stdin` (>10s backpressure), FFmpeg encoder/decoder spawn failures, HTTP server listen errors, and Frigate HTTP event creation errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WARN`  | Recoverable interruptions, fallbacks, or abnormal terminations: unsolicited `livestream stopped` from Eufy/camera while a session is still active (`initiator=eufy/camera`), RTSP wake timeout fallback to P2P, backfill download RPC/timeout failures (`initiator=error/download-failed`, `initiator=error/download-timeout`), watchdog stall retries 1-3 (`initiator=bridge-watchdog`), `already_running` stale stream recovery (`initiator=bridge/eufy-ws`), late video/start events arriving after a session closed (`initiator=bridge`), hitting `max_secs` (`initiator=bridge-max-limit`), WebSocket/station disconnects (`initiator=error/ws-disconnect`, `initiator=error/station-disconnect`), hardware acceleration fallback to `libx264`, Frigate events created without live video, Home Assistant webhook failures, and invalid config/font fallbacks. |
| `INFO`  | Normal operational lifecycle: bridge and HTTP server startup/shutdown, `eufy-security-ws` connected/listening, HomeBase station reconnects, encoder startup, initial camera telemetry and RTSP URL discovery, battery economy mode transitions, `WAKE` / `WAKE [RTSP]` / `WAKE [BACKFILL DOWNLOAD]` / `SLEEP` transitions, `eufy livestream started`, first decoded keyframe timing, activity-cleared 5s countdown, mid-stream codec changes (`initiator=camera-stream`), Frigate event creation, and viewer connection decisions.                                                                                                                                                                                                                                                                                                                                                  |
| `DEBUG` | High-frequency or diagnostic details: routine telemetry refreshes, companion event deduplication, HomeBase local database queries, 750ms RTSP wake retries, clean `livestream stopped` confirmations after `SLEEP`, in-band resolution changes, mid-flight `start_livestream` cancellations when preempted, viewer disconnections, viewer queue clears, and snapshot cache read/write operations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Stream Interruption & Lifecycle Initiators (`initiator=...`)

- `eufy-event`: Woken or hold-extended by a Eufy motion/person/pet/ring event.
- `eufy-ws`: Woken externally via `eufy-security-ws` (e.g., an external integration starting an `RTSP` or `P2P` stream directly) and automatically adopted by the bridge.
- `api-wake`: Woken or extended via the `POST/GET /api/wake/:cameras` HTTP endpoint (for CLI testing or external services without direct `eufy-security-ws` access).
- `eufy/camera-event-end` / `eufy/rtsp-end` / `eufy/download-finished`: Cleanly ended by Eufy/HomeBase when the camera
  finishes its P2P event recording, RTSP stream, or post-event clip download.
- `eufy/camera`: Stream interrupted or stopped by Eufy/HomeBase while hold/view timer is still active.
- `viewer`: Woken or extended by a human viewer connecting via `go2rtc`.
- `viewer-preempt`: Active viewer-only stream stopped because a human viewer opened a different camera on the same
  station P2P slot.
- `bridge-backfill`: Woken in `download` mode to replay a missed HomeBase event recording into Frigate
  (`device.start_download`).
- `bridge-probe` / `bridge-startup-probe`: Woken for initial startup snapshot capture and stopped once 2s of stable
  video is saved.
- `bridge-timer`: Normal `SLEEP` when both `hold_secs` and `view_linger_secs` timers expire.
- `bridge-early-sleep/eufy-cleared` / `bridge-early-sleep/quiet-timeout`: Closed early by optional battery saver once
  `early_sleep_secs` has elapsed and Frigate confirms no active tracked objects.
- `bridge-arbitrator/motion-over-viewer` / `bridge-arbitrator/higher-priority-event` /
  `bridge-arbitrator/newer-motion` / `bridge-arbitrator/newer-viewer` / `bridge-arbitrator/live-over-download`: Active
  camera or backfill download preempted on the station P2P slot by a higher-priority or live request.
- `bridge-max-limit` / `bridge-view-limit`: Forced `SLEEP` upon reaching `max_secs` or `view_max_secs`.
- `bridge/eufy-ws`: Forced stop/restart when `eufy-security-ws` reports `already_running` on a stale P2P session.
- `bridge-watchdog`: Stream stalled (`no_initial_video_after_wake` or `stream_stalled_mid_session`), triggering decoder
  reset and re-request (retries 1-3), or killing a wedged encoder process.
- `error/watchdog-timeout` / `error/download-failed` / `error/download-timeout`: Forced `SLEEP` after 3 failed watchdog
  retries or failed/stalled clip download.
- `error/ws-disconnect` / `error/station-disconnect`: Forced `SLEEP` across active cameras when `eufy-security-ws` or
  the station P2P connection drops.
- `camera-stream`: Decoder reset triggered by an in-band video codec change (`H264` <-> `H265`).
- `ffmpeg-decoder`: Unexpected FFmpeg decoder process exit while the camera session is still active.
- `system-shutdown`: Graceful stream stop on container `SIGTERM`/`SIGINT`.

### Tested Hardware Stack

- Station: Eufy HomeBase 3 (S380) (`T8030`, fw `3.8.7.4`, hw `V05`) + Video Doorbell Dual Chime (`T8023`, fw
  `3.3.2.2m_0.1`, hw `P0`)
- Cameras: Eufy Video Doorbell E340 Dual (`T8214`, fw `3.2.7.2`, hw `P2`) and two eufyCam S300 (eufyCam 3C) (`T8161`, fw
  `3.4.3.0`, hw `P1`)
- Host & GPU: Fedora 44 with AMD Radeon 8060S Graphics (`radeonsi`, `gfx1151`, VCN 4.0.5)
- Runtime: Multi-stage `alpine:3.23` container under `Podman` Quadlet, using `Mesa 25.2+` (`mesa-va-gallium`), `tini` as
  `PID 1`, non-root `node` user (`UID 1000`), `Inter.ttf` UI font, `ffmpeg`, `go2rtc`, `Frigate 0.18`, and
  `eufy-security-ws` (API schema `21`).

## Regressions Found & Resolved (Post-Mortem Knowledge Base)

1. Missing Comma & Failed `%` Rendering in `drawtext` Cards:

- Cause: The original `esc()` regex stripped commas (`replace(/[:'\\,]/g, ' ')`), turning `"wake it, or"` into
  `"wake it  or"`. Later, adding battery percentages (`85%`) caused `ffmpeg` `drawtext` to fail with
  `Stray % near '85%'` because `drawtext` defaults to `expansion=normal`.
- Fix: Preserved commas inside single-quoted `text='...'` strings, escaped colons as `\:`, and added `expansion=none` to
  all `drawtext` filters.

2. Missing Telemetry on `eufy-security-ws` API Schema 13-21:

- Cause: In schema 13+, `start_listening` returns `result.state.devices` as an array of serial number strings
  (`["T8161...", ...]`) rather than device objects, so `dev.serialNumber` was `undefined`.
- Fix: Added `fetchAllCameraTelemetry()` to explicitly invoke `device.get_properties` per camera after
  `start_listening`, unwrapping both direct values and `{ value }` metadata objects.

3. Cross-Camera Residual Frame Contamination (Doorbell Showing Another Camera's View):

- Cause 1: `eufy-security-client` caches notification thumbnails (`properties.picture`) at the HomeBase station level,
  frequently returning the last event picture from a different camera on the same HomeBase.
- Cause 2: Unsynchronized `P2P` channel switching (`stop_livestream` vs. `start_livestream`) caused residual packets in
  the HomeBase `P2P` buffer from Camera A to be emitted after Camera B started.
- Fix: Never decode `properties.picture`. Key cached snapshots by both name and serial (`last_<name>_<serial>.jpg`).
  Serialize all `P2P` handovers via per-station `stationTransitions` (awaiting `stop_livestream` + 150ms settle delay),
  update `cam.lastFrame` immediately on the first decoded keyframe of the session, and hold `cam.frame || cam.lastFrame`
  while `cam.active && cam.gotVideo`.

4. Spontaneous Camera Wakeups, Multi-Camera Grid Wakeups & Decoder Resets:

- Cause 1 (IPv6 / Docker Bridge Recorder Filter): The original viewer filter required `127.0.0.1` alongside
  `FFmpeg Frigate`.
- Cause 2 (Mid-Sleep Card Re-renders): Re-rendering `cam.asleep` on `property changed` events while asleep caused
  Frigate's `detect` stream to detect the pixel change as motion.
- Cause 3 (Slow-Waking Camera Left in Queue on Fast Camera Switching): Switching cameras quickly left the first camera's
  `start_livestream` in flight and its viewer queue active.
- Cause 4 (Frigate Multi-Camera Dashboard Grid): Opening Frigate's Live dashboard connects `mse/fmp4` viewers to all
  cameras in the same second, waking sleeping cameras after cooldown.
- Cause 5 (Dynamic P2P Resolution Shifts): Eufy `T8161`/`T8214` streams dynamically shift resolution
  (`3840x2160 <-> 2304x1296`, `1600x2200 <-> 1024x1408`) mid-session; restarting `ffmpeg` on width/height changes caused
  1-2s freezes.
- Fix: Filter `/FFmpeg Frigate|^go2rtc/i` regardless of IP; ignore poll cycles where 2+ sleeping cameras get new viewers
  simultaneously (`isDashboardGrid`); only restart the decoder if the video codec changes; purge other P2P cameras'
  viewer queues on single-camera switch; await `cam.startPromise` before `stop_livestream`.

5. Telemetry Icons Hanging Below Text Baseline & Stuck Low-Battery State After Physical Swap:

- Cause 1: For `fontsize=20` at `textY`, FFmpeg renders cap-top at `textY` and baseline at `textY + 14` (center
  `textY + 7`), whereas 18px icons at `textY..textY+18` hung 4px below the baseline.
- Cause 2: Swapping a physical battery while a camera was in Low-Battery Economy Mode left the card stuck at `14%`
  because `eufy-security-ws` needed `driver.poll_refresh` and `applyDeviceProperties` did not re-render cards on battery
  jumps while asleep.
- Fix: Unified icon rendering in `drawTelemetryRow()`, added `telemetry_poll_secs` + `driver.poll_refresh`, and
  auto-rebuilt cards on >= 10% battery jumps or economy mode changes.

6. AMD Radeon 8060S (`gfx1151`) VA-API Hardware Encoding & Sleeping Frame Sharpness:

- Cause: `alpine:3.20` ships `Mesa 24.0.9`, which lacks VCN 4.0.5 (`gfx1150`/`gfx1151`) encode profile tables, VCN 4.0.5
  rejects B-frames by default, and `-qp 24` with default JPEG caching softened dark sleeping snapshots.
- Fix: Upgraded runtime base image to `alpine:3.23` (`Mesa 25.2+`) with `mesa-va-gallium`, set `-bf 0 -qp 18` on
  `h264_vaapi`, added `-q:v 2` to cached JPEG snapshots, and enabled `flags=lanczos` scaling.

7. Center Overlay False Motion & Black Screens on Rapid Camera Switching:

- Cause 1: The centered `820x336` modal cannot be masked in Frigate without blinding center-frame motion detection.
- Cause 2: A 10-second keyframe interval (`-g 20` at `2 fps`) and resetting `sleptAt` on card rebuilds caused MSE/WebRTC
  players to show a black screen or hit false cooldowns when clicking cameras sequentially.
- Fix: Unified placement under `card_position` (`center` + 4 corners) with frosted-glass `default`, `icons`, `minimal`,
  and `none` themes; added event-driven frame pushing, `1.2s` keyframe bursts on viewer connect/state change, `750ms`
  viewer polling, and zero-probe low-latency decoder startup.

8. HomeBase 3 RTSP Wake Sequence, P2P Extension Loops & Burst Download Pacing:

- Cause 1: Calling `device.stop_rtsp_livestream` on sleep disabled the camera's NAS/RTSP toggle on the HomeBase, while
  passing `-analyzeduration 0` to `ffmpeg -rtsp_transport tcp` aborted RTSP SDP dimension probing.
- Cause 2: Extending `motionUntil` by `+5s` whenever video was still flowing kept `device.start_livestream` P2P sessions
  open until the HomeBase 2.5-5m hard limit.
- Cause 3: HomeBase 3 ignores legacy `station.database_query_local` and bursts `.zxvideo` clip downloads at ~10x
  real-time speed.
- Fix: Wake RTSP via sequential `rtspStream=true` + `device.start_rtsp_livestream` with `750ms` retries and never call
  `stop_rtsp_livestream` on sleep; end P2P event streams `5s` after Eufy reports `state: false`; query HomeBase 3 via
  `station.database_query_latest_info` / `station.database_query_by_date` and pace buffered `downloadFrames` at `15 fps`
  (`LIVE_FPS`).

## Roadmap & TODO List

### Implemented

- [x] Frosted-Glass UI, Vector Telemetry Icons, Curved Wi-Fi Arcs & Dimmed Snapshot Overlay
- [x] Unified `card_position` (`center` + 4 corners) & `card_theme` (`default`, `icons`, `minimal`, `none`)
- [x] Low-Latency Stream Pipeline, Instant Keyframe Bursts & Fast Camera Switching
- [x] Cross-Camera Frame Isolation, Multi-Camera Grid Filter & In-Band Resolution Handling
- [x] Block 1 - Doorbell & HomeBase 3 Intelligence (`rings`, `forward_face_names`, `preserve_aspect_ratio`)
- [x] Block 2 - Smart Battery Conservation & Battery Swap Detection (`early_sleep_secs`, Low-Battery Economy Mode,
  `enforce_streaming_quality`, `telemetry_poll_secs`, `driver.poll_refresh`)
- [x] Block 3 (Part 1) - Persistent Snapshot Cache (`/config/cache`), Startup Snapshot Probe (`startup_snapshot`), and
  Hardware-Accelerated FFmpeg Encoding (`hwaccel`: `vaapi`, `qsv`, `nvenc`, `v4l2m2m`)
- [x] Block 5 - Structured Logging (`[LEVEL] [camera]`, `LOG_LEVEL`), HomeBase Reboot Resilience, Eufy-Controlled Event
  End (`let_eufy_decide_event_end`), and Un-Dimmed Card Background (`card_dim_background: false`)
- [x] Block 6 (Step 1) - Configurable Camera Priority (`priority`), Built-In Event Priority Boosts (`EVENT_PRIORITIES`),
  Zero-Dwell Instant Event Switching, and `15 fps` / `5 fps` Drain-Aware Encoder Pipeline
- [x] Block 6 (Step 2) - HomeBase Native RTSP Ingestion (`use_rtsp`, `rtsp_url`, `startRtspDecoder` with `750ms` wake
  retries & `arbitrate()` P2P fallback) & HomeBase 3 Post-Event Clip Download Backfill (`backfill_downloads`,
  `station.database_query_latest_info`/`by_date`, `device.start_download` with `15 fps` real-time playback & `SIGUSR1`
  test hook)
- [x] Block 6 (Step 3) - Standalone Camera / Multi-Station Concurrent Streaming (`stationSerial` P2P Arbitration &
  Per-Station Transition Locks)
- [x] Block 6 (Step 4) - Auto-Applied Frigate Motion & Object Masks (`auto_frigate_mask` with Frigate restart recovery),
  Live-Stream Corner Status Cards (`card_show_on_live`), and Instant Clean Event Snapshot Fallback
  (`instant_event_snapshot`)
- [x] Block 7 - Enterprise Modular Refactoring (`src/config.js`, `src/logger.js`, `src/domain/*` [`camera.js`,
  `status-card.js`, `telemetry.js`, `backfill-job.js`], `src/overlay/*`, `src/media/*`, `src/services/*`) & 6-Color
  Semantic Palette (`Red`, `Grey`, `Green`, `Blue`, `Yellow`, `Purple`)
- [x] Block 8 (Step 1) - Built-In HTTP Server (`src/services/http-server.js`, `http_port`), Container Readiness `/healthz` Probe (`Dockerfile` `HEALTHCHECK`), and External Camera Pre-Wake Endpoint (`/api/wake/:cameras` & `/api/wake/all`)
- [x] Block 8 (Step 2) - Cross-Camera Hold Persistence (`let_eufy_decide_event_end: false` default, RTSP early-stop re-wake, `2.5s` RTSP socket timeout), Per-Station Wake Pacing (`stationNextWakeAt`, RTSP-before-P2P ordering, P2P wait during active RTSP wake handshake), and Sensor Burst Deduplication (`cam.apiWakeTimer`)
- [x] Block 8 (Step 3) - External `eufy-security-ws` Stream Adoption (`initiator=eufy-ws`), Instant (`0ms`) Mid-Session RTSP Re-Wake with `3.5s` Fast Retries, Active Hold Extension (`+30s` / `hold_secs / 2` on mid-stream events and `evaluateActiveHoldExtension`), and Config-First Named Constants Refactoring

### Pending (Next Up)

- [ ] Block 3 (Part 2) - Prometheus `/metrics` Endpoint on Built-In HTTP Server (`http_port`):
	- [ ] Expose `/metrics` in Prometheus text format (battery %, charging state, Wi-Fi RSSI, battery temperature, wake
	  counts by reason, total live seconds, and P2P/RTSP wake latency histogram).
- [ ] Block 4 - Parallel Python Prototype (`eufy-frigate-battery-bridge-python`):
	- [ ] Build a separate container (`Dockerfile.python` + `bridge.py` using `asyncio`, `websockets`, `aiohttp`, and
	  `Pillow`) to benchmark memory footprint, CPU usage, and native `Pillow` overlay rendering against the Node.js
	  container in parallel.
