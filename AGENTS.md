# AGENTS.md

## Repository Layout

- `src/bridge.js`: Main application entrypoint and stream/overlay engine
- `Dockerfile`: Multi-stage `alpine:3.23` container build (`COPY src/bridge.js /app/bridge.js`)
- `Makefile`: Podman build, syntax check (`make check`), registry publish, and cleanup targets
- `examples/config.example.minimal.json`: Minimal configuration example
- `examples/config.example.full.json`: Full configuration example with all supported global and per-camera options
- `examples/docker-compose.example.yml`: Example Docker Compose deployment

## Key Commands

- Syntax Check: `make check` (runs `node --check src/bridge.js`)
- Build Image Locally: `make docker-build` (validates `src/bridge.js` and builds multi-stage `alpine:3.23` image using `/usr/bin/podman` by default)
- Publish Locally: `make publish` (builds and tags `localhost/eufy-frigate-battery-bridge:latest`; skips remote push when `REGISTRY` is empty)
- Publish to Private Registry: `make publish REGISTRY=<registry> BUILD_VERSION=<version>` (tags during build and pushes with `--tls-verify=false`)
- Clean Images: `make clean` (removes local build and publish tags)
- Print Makefile Variables: `make print-vars`
- Trigger Test Frigate Event: `podman kill -s USR2 eufy-frigate-battery-bridge` (files a `"test"` event on the first camera without waking it)
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

- Patch-First Workflow: When modifying `src/bridge.js`, provide unified diff patches (`diff -u` against `a/src/bridge.js` and `b/src/bridge.js`) rather than regenerating the entire file unless explicitly requested.
- Block-Grouped Roadmap Convention: Always organize grouped changes, multi-part enhancements, and sequential implementation steps (such as Step 1/2/3) into dedicated, numbered `Block` sections under `Roadmap & TODO List` in `AGENTS.md`.
- Backward Compatibility: Strictly preserve drop-in compatibility with existing `config.json` files (supporting both `BRIDGE_CONFIG` and `CONFIG_PATH` environment variables, plus shorthand `trigger_events` aliases) and `README.md` behavior.
- Comment Formatting: Always use clean, left-justified comments and comprehensive JSDoc blocks on every function. Never add decorative comment dividers (such as `// ----`).
- String & Template Safety in `src/bridge.js`: Use standard single-quoted strings (`'...'`) with `+` concatenation instead of multi-line backtick template literals or backticks inside comments to prevent parser/linter errors across strict IDEs.
- Documentation Conventions in `README.md`: Always capitalize Eufy in prose, and wrap service names, binaries, protocols, codecs, and config keys (`go2rtc`, `ffmpeg`, `eufy-security-ws`, `RTSP`, `P2P`, `WebSocket`, `Podman`, `H.264`, `H.265`) in backticks.

## Configuration Reference (`config.json`)

### Required Keys

- `eufy_ws`: `WebSocket` URL for `eufy-security-ws` (e.g., `ws://eufy-security-ws:3000`)
- `go2rtc_api`: Frigate's `go2rtc` HTTP API URL (e.g., `http://frigate:1984`)
- `rtsp_publish`: `RTSP` publish URL template containing `{name}` (e.g., `rtsp://frigate:8554/{name}`)
- `cameras`: Array of camera objects `[{ "name", "serial", "title", "priority", "telemetry", "card_theme", "card_position", "card_background", "card_dim_background", "preserve_aspect_ratio", "startup_snapshot" }]`

### Optional Core Keys

- `frigate_api`: Frigate HTTP API URL (`http://frigate:5000`) for filing external events and checking active detections
- `ha_webhook`: Home Assistant webhook URL (receives POST on trigger start and after Frigate event creation)
- `log_level`: Minimum log level (`"debug"`, `"info"` [default], `"warn"`, `"error"`); also configurable via `LOG_LEVEL` env var
- `let_eufy_decide_event_end`: Allow Eufy/HomeBase to end event livestreams cleanly and extend active un-cleared event streams while video is flowing (default: `true`)
- `preempt_event_streams`: Allow newer motion on an equal-priority camera to preempt an active event stream immediately (default: `true`)
- `audio`: Enable audio passthrough (default: `true`)
- `hold_secs`: Stay live after the last Eufy motion report (default: `60`)
- `max_secs`: Hard cap for a single continuous live period (default: `900`)
- `view_linger_secs`: Stay live after the last viewer disconnects (default: `20`)
- `view_max_secs`: Hard cap for a viewer-only live session (default: `300`)
- `viewer_cooldown_secs`: Ignore viewers connecting this soon after a camera finishes streaming (default: `5`)
- `trigger_events`: Array of Eufy event names or shorthand aliases (`motion`, `person`, `pet`, `vehicle`, `dog`, `stranger`, `identity person`, `sound`, `rings`, `ringing`)
- `event_secs`: Duration of the Frigate event in seconds (default: `30`)
- `snapshot_delay_secs`: Seconds of continuous decoded video required before filing the Frigate event so the snapshot is live video (default: `3`)
- `width` / `height`: Output stream resolution (default: `1280` x `720`)
- `live_fps` / `idle_fps`: Output frame rate when live (`15`) vs. asleep (`5`)
- `font_file`: Path to `.ttf` font (defaults to `/usr/share/fonts/Inter.ttf` from `Dockerfile`)

### Optional Card Themes, Placement, Telemetry, Doorbell, Smart Battery & Hardware Acceleration Keys

- `priority` (per camera in `cameras[]`): Base integer priority weight (`-10000` to `10000`, default: `0`). Added to built-in event priority boosts (`EVENT_PRIORITIES`: `ring` `+1000`, `identity person` `+300`, `person`/`stranger` `+200`, `vehicle`/`pet`/`dog` `+100`, `crying`/`sound` `+50`, `motion` `+10`) to compute `getEffectivePriority(cam)`.
- `card_theme`:
	- `"default"` (default): Frosted-glass panel with full text (`Asleep`, `Asleep (Low Battery)`, `Waking Up...`, `Waiting`) + graphical telemetry icons. Renders the centered `820x336` modal with a color-coded status glyph when `card_position` is `"center"`, or a compact `540x88` card when `card_position` is a corner.
	- `"icons"` (alias `"icons-only"`): Crisp vector icons inside a `44px`-high frosted-glass capsule (`44%` opacity) with zero text and no `ffmpeg` spawn (Status glyph, Battery + charging bolt, Curved Wi-Fi arcs colored by `RSSI`, Thermometer with tick marks, and `Last live` analog clock with `HH:MM` hands).
	- `"minimal"` (alias `"dots"`): Three graduated color-coded semantic dots (`[Status]  [Battery]  [Wi-Fi]`) inside a `92x36` frosted-glass capsule (`42%` opacity) with zero text and no `ffmpeg` spawn.
	- `"none"` (aliases `"blank"`, `"black"`, `false`): Hides the status overlay while honoring `card_background` (`"snapshot"`, `"slate"`, or `"black"`).
- `card_position` (alias `card_corner`): `"center"` (default), `"bottom-left"`, `"bottom-right"`, `"top-left"`, or `"top-right"` (also accepts `"left-bottom"`, `"right-top"`, etc.). Applies to `"default"`, `"icons"`, and `"minimal"` themes. Can be overridden per camera.
- `card_background`: `"snapshot"` (default last live frame), `"slate"` (solid dark slate `0x22`), or `"black"`/`"none"` (pitch-black `0x10` background). Can be overridden per camera.
- `card_dim_background`: `false` (default) or `true`. Controls whether `"snapshot"` backgrounds are dimmed across the entire frame behind status cards. Disabled by default so unmasked background pixels do not trigger Frigate motion detection on sleep/wake transitions. Can be overridden per camera.
- `telemetry`: `true` (default), `false`, or object `{ "enabled": true, "battery": true, "power_source": true, "wifi": true, "rssi": true, "temperature": true, "last_seen": true }`. Can also be overridden per camera in `cameras[]`.
- `telemetry_poll_secs`: Interval in seconds to poll `device.get_properties` (and `driver.poll_refresh` when in Low-Battery Economy Mode) so battery swaps and charging updates are detected while sleeping (default: `300`, `0` to disable).
- `cache_dir`: Directory for storing persistent camera snapshots `last_<name>_<serial>.jpg` across container restarts (default: `/config/cache`, falls back to `/tmp`).
- `startup_snapshot`: `true` (default) wakes a camera once on startup if it has no cached frame on disk (and `card_background` is `"snapshot"`) and puts it right back to sleep after 2s of clean video; `"always"` forces a startup snapshot probe even if cached; `false` disables. Can be overridden per camera.
- `hwaccel`: `false` (default), `"vaapi"`, `"qsv"`, `"nvenc"`, or `"v4l2m2m"`. Offloads continuous H.264 encoding to GPU (`-qp 18` on `vaapi`, `-crf 19` on `libx264`) and falls back to `libx264` automatically on error.
- `hwaccel_device`: Render node path for `vaapi`/`qsv` (default: `/dev/dri/renderD128`).
- `preserve_aspect_ratio`: `true` (default) scales non-16:9 streams (such as 4:3 or dual-lens `T8214` doorbells) proportionally with Lanczos scaling and dark letterbox/pillarbox padding instead of stretching. Can be overridden per camera.
- `forward_face_names`: `true` (default) forwards recognized face names from HomeBase 3 (`identity person detected`) as Frigate's `sub_label` and includes `person` in the Home Assistant webhook payload.
- `ring_label`: Frigate event label used when a doorbell `rings` event fires (default: `'person'`).
- `early_sleep_secs`: Optional battery saver that shortens the motion hold window once `early_sleep_secs` (default: `0` [disabled]) has elapsed since motion cleared with no active Frigate object detections.
- `low_battery_threshold`: Battery percentage at or below which uncharged cameras enter Low-Battery Economy Mode (default: `20`, set `0` to disable).
- `low_battery_hold_secs`: Reduced `hold_secs` used when a camera is in Low-Battery Economy Mode (default: `20`).
- `low_battery_wake_on_view`: Whether live-view requests are allowed to wake a camera in Low-Battery Economy Mode (default: `false`).
- `enforce_streaming_quality`: `true` (default), `false`, or integer quality ID (e.g., `7` for Medium `1280x720`). When `true`, automatically switches cameras configured as `"Auto"` (`0`) to `7` (`Medium`) so `P2P` streams do not negotiate `4K` and stall.

## Architecture & Hardware Environment

### Stream Lifecycle, Event Priority & Card Rendering Rules

- Single P2P Stream Arbitration (`arbitrate`): Eufy HomeBase stations multiplex only one active P2P livestream at a time. Event-triggered streams (`motion`, `person`, `pet`, `ring`, etc.) always take priority over human viewer connections (`go2rtc` consumers).
- Camera & Event Priority Tiers (`getEffectivePriority`): Combines per-camera `priority` from `config.json` with built-in `EVENT_PRIORITIES` (`ring`: `+1000`, `identity person`: `+300`, `person`/`stranger`: `+200`, `vehicle`/`pet`/`dog`: `+100`, `crying`/`sound`: `+50`, `motion`: `+10`). Companion events arriving while a camera is already live automatically upgrade `cam.eventPriority` in-place.
- Zero-Dwell Event Switching: `min_dwell_secs` has been removed. Higher-priority events (`pickScore > curScore`, `initiator=bridge-arbitrator/higher-priority-event`) and newer events on equal-priority cameras (`pickScore === curScore`, `initiator=bridge-arbitrator/newer-motion` when `preempt_event_streams` is `true`) preempt the active camera immediately with a `150ms` P2P handover settle delay. Lower-priority cameras (`pickScore < curScore`) are blocked from preempting an active higher-priority event until its motion clears or stalls.
- Eufy-Controlled Event End (`let_eufy_decide_event_end`): Enabled (`true`) by default. When Eufy/HomeBase sends `livestream stopped` on an active event stream (after 3s of video or after Eufy reports `state: false`), the bridge puts the camera to sleep cleanly (`initiator=eufy/camera-event-end`) rather than forcing a re-wake. While Eufy is still actively sending video and no urgent higher/equal-priority motion event is waiting, the bridge extends `motionUntil` in 5s increments up to `max_secs`.
- Drain-Aware Frame Pipeline (`live_fps: 15`, `idle_fps: 5`): `enc.stdin.on('drain')` immediately flushes any pending `cam.frameNew` frame that arrived while the `1.38 MB` raw YUV420p pipe buffer was full, eliminating dropped frames and playback jerkiness.
- Early Sleep (`early_sleep_secs`): Disabled (`0`) by default so Frigate's internal object tracker cannot prematurely terminate Eufy-triggered event recordings.
- Immediate Snapshot Persistence (`lastFrame`): `cam.lastFrame` and `cam.lastSeen` update on the very first decoded keyframe of every session (the 2s settle delay applies only to `startup_snapshot` probes). While `cam.active && cam.gotVideo`, the encoder holds `cam.frame || cam.lastFrame` so preempted or stopping streams never flash the pre-stream `waking` card.
- Background Dimming (`card_dim_background`): Disabled (`false`) by default (configurable globally and per-camera). Keeps background snapshot pixels outside the status card 100% unchanged across `Live <-> Asleep` transitions so Frigate does not record false full-frame motion when the card area is covered by a Frigate motion mask.
- HomeBase Reboot Resilience: `onEvent` handles `source === 'station'` events (`close`, `connection error`, `connect`), cleanly stopping active streams (`initiator=error/station-disconnect`) and re-fetching telemetry on reconnect without dropping FFmpeg RTSP feeds to `go2rtc`.

### Structured Logging, Priorities & Stream Initiators

All log output in `bridge.js` must use `log.debug()`, `log.info()`, `log.warn()`, or `log.error()` with a camera state object (or `'bridge'` for global events) as the first argument so every line is formatted identically for Grafana Alloy / Loki ingestion:

    YYYY-MM-DD HH:MM:SS [LEVEL] [camera_or_bridge] message

- Timestamps: Formatted via `formatLocalTimestamp()` (`YYYY-MM-DD HH:MM:SS`) using local `Date` getters (respecting `TZ`) with zero ICU locale dependencies so Grafana Alloy's ISO-8601 regex always matches.
- Configuration: Controlled via the `LOG_LEVEL` environment variable or `log_level` in `config.json` (`debug`, `info` [default], `warn`, `error`).
- Key-Value Context: Lifecycle and stream interruption logs must include structured `key=value` pairs (`initiator=...`, `reason="..."`, `live=...s`, `gotVideo=...`, `lastVideoAgo=...`, `session=...`).

#### Log Priority Levels

| Level | Usage Guidelines |
| :--- | :--- |
| `ERROR` | Unrecoverable session or subsystem failures: `eufy-security-ws` socket errors, `start_listening` failures, `device.start_livestream` RPC failures, watchdog forced stream closures after 3 failed retries (`initiator=error/watchdog-timeout`), wedged FFmpeg encoder `stdin` (>10s backpressure), FFmpeg encoder/decoder spawn failures, and Frigate HTTP event creation errors. |
| `WARN` | Recoverable interruptions, fallbacks, or abnormal terminations: unsolicited `livestream stopped` from Eufy/camera while a session is still active (`initiator=eufy/camera`), watchdog stall retries 1-3 (`initiator=bridge-watchdog`), `already_running` stale stream recovery (`initiator=bridge/eufy-ws`), late video/start events arriving after a session closed (`initiator=bridge`), hitting `max_secs` (`initiator=bridge-max-limit`), WebSocket/station disconnects (`initiator=error/ws-disconnect`, `initiator=error/station-disconnect`), hardware acceleration fallback to `libx264`, Frigate events created without live video, Home Assistant webhook failures, and invalid config/font fallbacks. |
| `INFO` | Normal operational lifecycle: bridge startup/shutdown, `eufy-security-ws` connected/listening, HomeBase station reconnects, encoder startup, initial camera telemetry and battery economy mode transitions, `WAKE` / `SLEEP` transitions, `eufy livestream started`, first decoded keyframe timing, mid-stream codec changes (`initiator=camera-stream`), Frigate event creation, and viewer connection decisions. |
| `DEBUG` | High-frequency or diagnostic details: routine telemetry refreshes, Eufy motion-cleared (`state=false`) signals, 5s event stream hold extensions, clean `livestream stopped` confirmations after `SLEEP`, in-band resolution changes, mid-flight `start_livestream` cancellations when preempted, viewer disconnections, viewer queue clears, and snapshot cache read/write operations. |

### Stream Interruption & Lifecycle Initiators (`initiator=...`)

- `eufy-event`: Woken or hold-extended by a Eufy motion/person/pet/ring event.
- `eufy/camera-event-end`: Cleanly ended by Eufy/HomeBase when the camera finishes its event recording.
- `eufy/camera`: Stream interrupted or stopped by Eufy/HomeBase while hold/view timer is still active.
- `viewer`: Woken or extended by a human viewer connecting via `go2rtc`.
- `viewer-preempt`: Active viewer-only stream stopped because a human viewer opened a different camera.
- `bridge-probe` / `bridge-startup-probe`: Woken for initial startup snapshot capture and stopped once 2s of stable video is saved.
- `bridge-timer`: Normal `SLEEP` when both `hold_secs` and `view_linger_secs` timers expire.
- `bridge-early-sleep/eufy-cleared` / `bridge-early-sleep/quiet-timeout`: Closed early by optional battery saver once `early_sleep_secs` has elapsed and Frigate confirms no active tracked objects.
- `bridge-arbitrator/motion-over-viewer` / `bridge-arbitrator/higher-priority-event` / `bridge-arbitrator/newer-motion` / `bridge-arbitrator/newer-viewer`: Active camera preempted on the single HomeBase P2P slot by a higher-priority or newer request.
- `bridge-max-limit` / `bridge-view-limit`: Forced `SLEEP` upon reaching `max_secs` or `view_max_secs`.
- `bridge/eufy-ws`: Forced stop/restart when `eufy-security-ws` reports `already_running` on a stale P2P session.
- `bridge-watchdog`: Stream stalled (`no_initial_video_after_wake` or `stream_stalled_mid_session`), triggering decoder reset and re-request (retries 1-3), or killing a wedged encoder process.
- `error/watchdog-timeout`: Forced `SLEEP` after 3 failed watchdog retries with no video from the camera.
- `error/ws-disconnect` / `error/station-disconnect`: Forced `SLEEP` across active cameras when `eufy-security-ws` or the HomeBase P2P connection drops.
- `camera-stream`: Decoder reset triggered by an in-band video codec change (`H264` <-> `H265`).
- `ffmpeg-decoder`: Unexpected FFmpeg decoder process exit while the camera session is still active.
- `system-shutdown`: Graceful stream stop on container `SIGTERM`/`SIGINT`.

### Tested Hardware Stack

- Station: Eufy HomeBase 3 (S380) (`T8030`, fw `3.8.7.4`, hw `V05`) + Video Doorbell Dual Chime (`T8023`, fw `3.3.2.2m_0.1`, hw `P0`)
- Cameras: Eufy Video Doorbell E340 Dual (`T8214`, fw `3.2.7.2`, hw `P2`) and two eufyCam S300 (eufyCam 3C) (`T8161`, fw `3.4.3.0`, hw `P1`)
- Host & GPU: Fedora 44 with AMD Radeon 8060S Graphics (`radeonsi`, `gfx1151`, VCN 4.0.5)
- Runtime: Multi-stage `alpine:3.23` container under `Podman` Quadlet, using `Mesa 25.2+` (`mesa-va-gallium`), `tini` as `PID 1`, non-root `node` user (`UID 1000`), `Inter.ttf` UI font, `ffmpeg`, `go2rtc`, `Frigate 0.18`, and `eufy-security-ws` (API schema `21`).

## Regressions Found & Resolved (Post-Mortem Knowledge Base)

1. Missing Comma & Failed `%` Rendering in `drawtext` Cards:
- Cause: The original `esc()` regex stripped commas (`replace(/[:'\\,]/g, ' ')`), turning `"wake it, or"` into `"wake it  or"`. Later, adding battery percentages (`85%`) caused `ffmpeg` `drawtext` to fail with `Stray % near '85%'` because `drawtext` defaults to `expansion=normal`.
- Fix: Preserved commas inside single-quoted `text='...'` strings, escaped colons as `\:`, and added `expansion=none` to all `drawtext` filters.

2. Missing Telemetry on `eufy-security-ws` API Schema 13-21:
- Cause: In schema 13+, `start_listening` returns `result.state.devices` as an array of serial number strings (`["T8161...", ...]`) rather than device objects, so `dev.serialNumber` was `undefined`.
- Fix: Added `fetchAllCameraTelemetry()` to explicitly invoke `device.get_properties` per camera after `start_listening`, unwrapping both direct values and `{ value }` metadata objects.

3. Cross-Camera Residual Frame Contamination (Doorbell Showing Another Camera's View):
- Cause 1: `eufy-security-client` caches notification thumbnails (`properties.picture`) at the HomeBase station level, frequently returning the last event picture from a different camera on the same HomeBase.
- Cause 2: Unsynchronized `P2P` channel switching (`stop_livestream` vs. `start_livestream`) caused residual packets in the HomeBase `P2P` buffer from Camera A to be emitted after Camera B started.
- Fix: Never decode `properties.picture`. Key cached snapshots by both name and serial (`last_<name>_<serial>.jpg`). Serialize all `P2P` handovers via `p2pTransitionPromise` (awaiting `stop_livestream` + 150ms settle delay), update `cam.lastFrame` immediately on the first decoded keyframe of the session, and hold `cam.frame || cam.lastFrame` while `cam.active && cam.gotVideo`.

4. Spontaneous Camera Wakeups, Multi-Camera Grid Wakeups & Decoder Resets:
- Cause 1 (IPv6 / Docker Bridge Recorder Filter): The original viewer filter required `127.0.0.1` alongside `FFmpeg Frigate`.
- Cause 2 (Mid-Sleep Card Re-renders): Re-rendering `cam.asleep` on `property changed` events while asleep caused Frigate's `detect` stream to detect the pixel change as motion.
- Cause 3 (Slow-Waking Camera Left in Queue on Fast Camera Switching): Switching cameras quickly left the first camera's `start_livestream` in flight and its viewer queue active.
- Cause 4 (Frigate Multi-Camera Dashboard Grid): Opening Frigate's Live dashboard connects `mse/fmp4` viewers to all cameras in the same second, waking sleeping cameras after cooldown.
- Cause 5 (Dynamic P2P Resolution Shifts): Eufy `T8161`/`T8214` streams dynamically shift resolution (`3840x2160 <-> 2304x1296`, `1600x2200 <-> 1024x1408`) mid-session; restarting `ffmpeg` on width/height changes caused 1-2s freezes.
- Fix: Filter `/FFmpeg Frigate|^go2rtc/i` regardless of IP; ignore poll cycles where 2+ cameras get new viewers simultaneously and remain connected (`isDashboardGrid`); only restart the decoder if the video codec changes; purge other cameras' viewer queues on single-camera switch; await `cam.startPromise` before `stop_livestream`.

5. Telemetry Icons Hanging Below Text Baseline & Stuck Low-Battery State After Physical Swap:
- Cause 1: For `fontsize=20` at `textY`, FFmpeg renders cap-top at `textY` and baseline at `textY + 14` (center `textY + 7`), whereas 18px icons at `textY..textY+18` hung 4px below the baseline.
- Cause 2: Swapping a physical battery while a camera was in Low-Battery Economy Mode left the card stuck at `14%` because `eufy-security-ws` needed `driver.poll_refresh` and `applyDeviceProperties` did not re-render cards on battery jumps while asleep.
- Fix: Unified icon rendering in `drawTelemetryRow()`, added `telemetry_poll_secs` + `driver.poll_refresh`, and auto-rebuilt cards on >= 10% battery jumps or economy mode changes.

6. AMD Radeon 8060S (`gfx1151`) VA-API Hardware Encoding & Sleeping Frame Sharpness:
- Cause: `alpine:3.20` ships `Mesa 24.0.9`, which lacks VCN 4.0.5 (`gfx1150`/`gfx1151`) encode profile tables, VCN 4.0.5 rejects B-frames by default, and `-qp 24` with default JPEG caching softened dark sleeping snapshots.
- Fix: Upgraded runtime base image to `alpine:3.23` (`Mesa 25.2+`) with `mesa-va-gallium`, set `-bf 0 -qp 18` on `h264_vaapi`, added `-q:v 2` to cached JPEG snapshots, and enabled `flags=lanczos` scaling.

7. Center Overlay False Motion & Black Screens on Rapid Camera Switching:
- Cause 1: The centered `820x336` modal cannot be masked in Frigate without blinding center-frame motion detection.
- Cause 2: A 10-second keyframe interval (`-g 20` at `2 fps`) and resetting `sleptAt` on card rebuilds caused MSE/WebRTC players to show a black screen or hit false cooldowns when clicking cameras sequentially.
- Fix: Unified placement under `card_position` (`center` + 4 corners) with frosted-glass `default`, `icons`, `minimal`, and `none` themes; added event-driven frame pushing, `1.2s` keyframe bursts on viewer connect/state change, `750ms` viewer polling, and zero-probe low-latency decoder startup.

## Roadmap & TODO List

### Implemented
- [x] Frosted-Glass UI, Vector Telemetry Icons, Curved Wi-Fi Arcs & Dimmed Snapshot Overlay
- [x] Unified `card_position` (`center` + 4 corners) & `card_theme` (`default`, `icons`, `minimal`, `none`)
- [x] Low-Latency Stream Pipeline, Instant Keyframe Bursts & Fast Camera Switching
- [x] Cross-Camera Frame Isolation, Multi-Camera Grid Filter & In-Band Resolution Handling
- [x] Block 1 - Doorbell & HomeBase 3 Intelligence (`rings`, `forward_face_names`, `preserve_aspect_ratio`)
- [x] Block 2 - Smart Battery Conservation & Battery Swap Detection (`early_sleep_secs`, Low-Battery Economy Mode, `enforce_streaming_quality`, `telemetry_poll_secs`, `driver.poll_refresh`)
- [x] Block 3 (Part 1) - Persistent Snapshot Cache (`/config/cache`), Startup Snapshot Probe (`startup_snapshot`), and Hardware-Accelerated FFmpeg Encoding (`hwaccel`: `vaapi`, `qsv`, `nvenc`, `v4l2m2m`)
- [x] Block 5 - Structured Logging (`[LEVEL] [camera]`, `LOG_LEVEL`), HomeBase Reboot Resilience, Eufy-Controlled Event End (`let_eufy_decide_event_end`), and Un-Dimmed Card Background (`card_dim_background: false`)
- [x] Block 6 (Step 1) - Configurable Camera Priority (`priority`), Built-In Event Priority Boosts (`EVENT_PRIORITIES`), Zero-Dwell Instant Event Switching, and `15 fps` / `5 fps` Drain-Aware Encoder Pipeline

### Pending (Next Up)
- [ ] Block 6 (Step 2) - HomeBase Native RTSP Ingestion & Post-Event Clip Download Backfill (`device.start_download`):
	- [ ] Support optional HomeBase RTSP pull (`rtsp_source` / `device.start_rtsp_livestream`) for `T8161` cameras when woken by motion so the HomeBase P2P slot remains free for the doorbell.
	- [ ] Implement post-event clip download (`device.start_download` / `download video data`) to backfill missed camera recordings when a lower-priority camera triggers while a higher-priority camera holds the P2P slot.
- [ ] Block 6 (Step 3) - Standalone Camera / Multi-Station Concurrent Streaming (`stationSerial` Arbitration):
	- [ ] Track P2P stream arbitration per `stationSerial` instead of globally so a standalone Wi-Fi camera/doorbell (`T8214` with built-in storage + separate chime) can stream 100% concurrently alongside HomeBase-paired cameras.
- [ ] Block 3 (Part 2) - Built-In Prometheus `/metrics` & `/healthz` HTTP Server (`metrics_port`):
	- [ ] Expose `/healthz` for container healthchecks and `/metrics` for Prometheus (battery %, charging state, Wi-Fi RSSI, battery temperature, wake counts by reason, total live seconds, and P2P wake latency histogram).
- [ ] Block 4 - Parallel Python Prototype (`eufy-frigate-battery-bridge-python`):
	- [ ] Build a separate container (`Dockerfile.python` + `bridge.py` using `asyncio`, `websockets`, `aiohttp`, and `Pillow`) to benchmark memory footprint, CPU usage, and native `Pillow` overlay rendering against the Node.js container in parallel.
