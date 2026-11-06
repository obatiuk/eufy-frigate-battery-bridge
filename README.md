# Eufy Battery Camera Bridge for Frigate

[![CI](https://github.com/obatiuk/eufy-frigate-battery-bridge/actions/workflows/release.yml/badge.svg)](https://github.com/obatiuk/eufy-frigate-battery-bridge/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/tag/obatiuk/eufy-frigate-battery-bridge?label=release)](https://github.com/obatiuk/eufy-frigate-battery-bridge/releases)
[![Node.js 22](https://img.shields.io/badge/node-22-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> **Note:** This is an enhanced fork of
> [ljlongwing/eufy-frigate-battery-bridge](https://github.com/ljlongwing/eufy-frigate-battery-bridge) that adds
> HomeBase RTSP streaming, HomeBase 3 recorded clip replay, automatic Eufy power and Frigate mask setup, customizable
> corner status cards, low-battery and offline protection, external wake triggers, and GPU video encoding. It works as a
> drop-in replacement for the
> [original project](https://github.com/ljlongwing/eufy-frigate-battery-bridge/commit/1d8f9f1fdb3879c8b610607c2f7f5b8db9baf577)
> and supports existing configurations out of the box - see
> [Migrating from the Original Configuration](#migrating-from-the-original-configuration) for details.

Use your Eufy battery cameras and video doorbells in **[Frigate](https://frigate.video/)** without draining their
batteries.

**Frigate** is built for wired security cameras that stream video 24/7, while Eufy battery cameras stay asleep to save
power and only wake up briefly when something happens. This bridge connects
[eufy-security-ws](https://github.com/bropat/eufy-security-ws) (the service that talks to your Eufy account and
`HomeBase`) with Frigate's built-in [go2rtc](https://github.com/AlexxIT/go2rtc) video server - sending Frigate a
lightweight stand-in feed while your cameras sleep, and switching to real video the moment activity happens or you open
Live View.

## How It Works

1. **Standby screen while asleep:** Sends Frigate the camera's last clean picture (or a dark screen) with a small status
   card showing battery, charging/solar status, Wi-Fi signal, temperature, and last active time - using almost zero CPU
   or disk space, and automatically stopping the stream if a battery dies or a camera goes offline so Frigate marks it
   unreachable.
2. **Smart event recording (live stream or clip replay):** When motion, a person, a pet, a vehicle, sound, crying, or a
   doorbell ring is detected, the bridge either wakes the camera live or replays the recorded clip from `HomeBase 3`
   (`"backfill"` mode so battery doorbells never miss fast walk-bys), extends the recording while activity continues,
   prioritizes urgent alerts like doorbell rings, and forwards recognized face names to Frigate and
   [Home Assistant](https://www.home-assistant.io/).
3. **On-demand Live View:** Wakes a camera when you open its single-camera view in Frigate (ignoring multi-camera
   dashboard grids so sleeping cameras stay asleep), shares live views opened in the Eufy mobile app without waking the
   camera twice, and puts the camera back to sleep shortly after you close the view.
4. **Automatic Frigate & Eufy setup:** Automatically masks the corner status card in Frigate on startup and after
   Frigate restarts so status updates never trigger false motion alerts, and automatically configures each camera's Eufy
   Power Manager recording length, retrigger delay, and video quality to match your chosen mode.
5. **Built-in battery & hardware safeguards:** Shortens recordings when a battery runs low, recovers stalled streams and
   `HomeBase` connections after Wi-Fi drops automatically, supports optional GPU video encoding, and provides an `HTTP`
   wake endpoint (`/api/wake`) for Home Assistant sensors and automations.

## Choosing a `mode` for Each Camera

Eufy cameras can send video to Frigate in three ways:
- **`RTSP` (local network stream):** Built into cameras that have **NAS / `RTSP` Stream** in the Eufy app. Multiple
  `RTSP` cameras can stream at the same time.
- **`P2P` (direct station stream):** Eufy's standard connection used by battery doorbells and cameras without `RTSP`.
  Only one `P2P` camera on a `HomeBase` can stream or download a clip at a time.
- **`"backfill"` (recorded clip replay):** Instead of waking a live stream when motion happens, the camera records its
  short clip to `HomeBase 3` (including the few seconds of pre-roll right before motion triggered) and goes straight
  back to sleep. Once movement finishes, the bridge downloads that clip from `HomeBase 3` and plays it into Frigate.

Each camera in your `config.json` can be set to one of five modes:

| Mode                             | Best For                                                                                | How It Works                                                                                                                                                                                        | Default Recording Length                            |
| :------------------------------- | :-------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| `"auto"` (default when omitted)  | Automatic detection                                                                     | Uses `"rtsp"` automatically on cameras that support `HomeBase` `RTSP`, or `"p2p"` (with automatic `HomeBase` clip replay fallback if busy) on all others.                                           | `60` seconds (full 60s clip)                        |
| `"rtsp"`                         | Cameras with NAS / `RTSP` Stream support (e.g. eufyCam 3 / S300 `T8161`, solar cameras) | Wakes a live `HomeBase` `RTSP` stream on events and Live View. Multiple `RTSP` cameras can stream at the same time without blocking your doorbell.                                                  | `60` seconds (full 60s clip)                        |
| `"backfill"`                     | Battery Doorbells (`T8214`) & high-traffic `RTSP`/`P2P` cameras (`T8161`)               | Best battery life & zero missed walk-bys. Never wakes live on Eufy motion/ring: records clip to `HomeBase 3`, sleeps, then replays into Frigate. Streams live on Live View or `/api/wake` when idle. | `30` seconds (stops early as soon as motion clears) |
| `"p2p"`                          | Battery cameras without `RTSP` when you prefer live streaming on motion                 | Wakes a live `P2P` stream on motion, and automatically falls back to `HomeBase` clip replay if another `P2P` camera is already streaming.                                                           | `60` seconds (full 60s clip)                        |
| `"custom"`                       | Advanced per-camera tuning                                                              | Lets you override individual stream, timer, and Eufy Power Manager settings while automatically checking and fixing any conflicting values.                                                         | `60` seconds (unless overridden)                    |

## Quick Start (3 Steps)

### Requirements (Minimum Versions)

Make sure your setup meets these minimum versions so all features work properly:

| Component                                                                                               | Minimum Version                     | Tested Version         | Why It Is Needed                                                                                                                                        |
| :------------------------------------------------------------------------------------------------------ | :---------------------------------- | :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Frigate](https://frigate.video/)**                                                                   | `>= 0.16.0`                         | `0.18.x`               | Needed for automatic corner masks, recognized face names (`sub_label`), and event recording via Frigate's `HTTP` API.                                   |
| **[go2rtc](https://github.com/AlexxIT/go2rtc)**                                                         | Included in Frigate (`>= 1.9.0`)    | `1.9.x` (bundled)      | Included inside Frigate (or run standalone) to receive the bridge's `RTSP` feeds and report active Live View connections.                               |
| **[eufy-security-ws](https://github.com/bropat/eufy-security-ws)**                                      | `>= 2.0.0` (API schema `>= 20`)     | `3.1.0+` (schema `21`) | Needed for `HomeBase 3` clip downloads and automatic Eufy Power Manager setup.                                                                          |
| **[Docker](https://docs.docker.com/) / [Podman](https://podman.io/)**                                   | Docker `>= 24.0` or Podman `>= 4.5` | Podman `5.x`           | Needed to build and run the container image (`deploy/docker-compose.example.yml`).                                                                      |
| **[Eufy HomeBase](https://support.eufy.com/s/article/S380-HomeBase-HomeBase-3-Compatibility)**          | `HomeBase 3` fw `>= 3.5.x`          | `3.8.7.4`              | Needed for `"backfill"` clip replay and facial recognition. `HomeBase 2` and standalone Wi-Fi cameras work in `"rtsp"` and `"p2p"` modes.               |
| **[Eufy Account](https://support.eufy.com/s/article/Share-Your-eufySecurity-Devices-With-Your-Family)** | Dedicated secondary account         | -                      | Share your cameras from your main Eufy account to a second Eufy account for `eufy-security-ws`, and keep *push notifications turned ON* on that account. |

### Step 1: Create `config.json`

Copy [`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) and create a `config.json` next to it
(see [`deploy/config.example.minimal.json`](deploy/config.example.minimal.json) and
[`deploy/config.schema.json`](deploy/config.schema.json) for IDE autocomplete):

```json
{
  "$schema": "https://raw.githubusercontent.com/obatiuk/eufy-frigate-battery-bridge/main/deploy/config.schema.json",
  "eufy_security_ws_url": "ws://eufy-security-ws:3000",
  "frigate_url": "http://frigate:5000",
  "hwaccel": "vaapi",
  "cameras": [
    {
      "serial": "SN0000000001",
      "title": "Storage Room Camera",
      "mode": "rtsp",
      "priority": 50
    },
    {
      "serial": "SN0000000002",
      "title": "Garage Camera",
      "mode": "rtsp",
      "priority": 50
    },
    {
      "serial": "SN0000000003",
      "title": "Front Doorbell",
      "mode": "backfill",
      "priority": 100
    }
  ]
}
```

> [!TIP]
> You can use either the camera's `"serial"` (like `SN0000000001`) or a custom `"name"` (like `"garage"`) - both are
> supported, as long as it matches the camera name in Frigate's `config.yml` exactly.

### Step 2: Add the Cameras to Frigate (`config.yml`)

In Frigate's `config.yml`, list each camera under `go2rtc.streams` **with an empty value** (the bridge pushes video into
`go2rtc`), then add the camera under `cameras`:

```yaml
go2rtc:
  streams:
    SN0000000001: # leave empty - the bridge publishes into this stream
    SN0000000002:

cameras:
  SN0000000001:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/SN0000000001
          input_args: preset-rtsp-restream
          roles: [record, detect]
      output_args:
        record: preset-record-generic-audio-copy # or preset-record-generic if "audio": false
    detect:
      width: 1280
      height: 720
      fps: 5
    record:
      continuous:
        days: 0 # only save motion/events, not hours of "camera asleep"
    live:
      streams:
        Main: SN0000000001
```

### Step 3: Start the Bridge

```bash
docker compose -f deploy/docker-compose.example.yml --project-directory . up -d
```

*(Prebuilt images are published to `ghcr.io/obatiuk/eufy-frigate-battery-bridge:latest` for tagged releases and `:dev`
for the latest `main` branch commit; uncomment `build:` in
[`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) and pass `--build` to build locally from
source.)*

## Status Card & Sleeping Screen Styles

You can customize the corner status card and what Frigate shows while a camera is asleep using `card_theme`,
`card_position`, and `sleep_screen`.

**Status Card Themes (`card_theme`):**
- **`"icons"` *(default)*:** Compact frosted-glass pill with Eufy-style icons for **Status**, **Battery** (with solar
  sun, AC plug, or charging bolt), **Wi-Fi signal**, **Temperature**, and **Last active time** (clock).
- **`"minimal"`:** Compact frosted-glass pill matching `"icons"` height with three clean color-coded circles for
  **Status**, **Battery**, and **Wi-Fi** (never icons or text).
- **`"detailed"`:** Larger panel with text labels (`Asleep`, `Asleep (Low Battery)`, `Waking Up...`, `Waiting`,
  `Live`, `Backfill`, `Disconnected`) alongside battery, Wi-Fi, temperature, and last-active icons (omitting sensor
  segments that have not been reported yet).
- **`"debug"`:** Bottom diagnostic bar showing live stream stage, state transitions, frame rate, service health
  (`WS`, `HB`, `FRG`, `RTC`), spotlight state, camera hardware settings, and active timers.
- **`"none"`:** Hides the status card completely and shows only the sleeping screen configured by `sleep_screen`.

**Sleeping Screen Backgrounds (`sleep_screen`):**
- **`"snapshot"` *(default)*:** The last clean picture captured from the camera (saved across restarts in
  `/config/cache`).
- **`"slate"`:** A solid dark-slate gray screen (<span style="color: #222222">■</span> `#222222`).
- **`"black"`:** A solid black screen (<span style="color: #101010">■</span> `#101010`).

### What the Status Colors Mean

| Color                                          | Status Icon / Circle 1                                                       | Battery Icon / Circle 2          | Wi-Fi Icon / Circle 3 | Temperature (`icons` / `detailed`)             |
| :--------------------------------------------- | :--------------------------------------------------------------------------- | :------------------------------- | :-------------------- | :--------------------------------------------- |
| **<span style="color: #ef4444">Red</span>**    | `Live` (play icon / solid circle) or `Backfill` (rewind icon / ring)         | -                                | -                     | -                                              |
| **<span style="color: #4ade80">Green</span>**  | `Asleep` (Standby & ready)                                                   | `Good` (`50% - 100%`)            | `Strong`              | `Normal` (`6°C - 35°C`; light grey text)       |
| **<span style="color: #b4b4be">Grey</span>**   | `Disconnected` (`eufy-security-ws`, `HomeBase`, `Frigate`, or `go2rtc` down) | `Not available`                  | `Not available`       | `Not available` (`icons`)                      |
| **<span style="color: #38bdf8">Blue</span>**   | `Waking Up...` (Connecting)                                                  | `Charging / Solar / Plugged`     | `Good`                | `Cold` (`<= 5°C`)                              |
| **<span style="color: #facc15">Yellow</span>** | `Waiting` (`HomeBase` busy or recording/preparing clip backfill)             | `Medium` (`21% - 49%`)           | `Fair`                | `Warm` (`36°C - 44°C`)                         |
| **<span style="color: #e879f9">Purple</span>** | `Asleep (Low Battery)` (`<= 20%` unplugged)                                  | `Low` (`<= 20%`)                 | `Weak`                | `Hot` (`>= 45°C`)                              |

## Configuration Reference

### Main Settings (`config.json`)

| Key                    | Required |                Default                | Meaning                                                                                                        |
| :--------------------- | :------: | :-----------------------------------: | :------------------------------------------------------------------------------------------------------------- |
| `eufy_security_ws_url` | **Yes**  |                   -                   | `WebSocket` URL of your `eufy-security-ws` container (`ws://eufy-security-ws:3000`)                            |
| `frigate_url`          | **Yes**  |                   -                   | Frigate base URL (`http://frigate:5000`); also auto-derives `go2rtc_url` and `rtsp_output_url`                 |
| `cameras`              | **Yes**  |                   -                   | List of cameras (see table below)                                                                              |
| `go2rtc_url`           |    No    |     `http://<frigate-host>:1984`      | `go2rtc` base URL (auto-derived from `frigate_url`; set only if `go2rtc` runs on a custom host/port)           |
| `rtsp_output_url`      |    No    | `rtsp://<frigate-host>:8554/{name}`   | `RTSP` publish URL or template (auto-derived; appends `/{name}` automatically if `{name}` is omitted)          |
| `card_theme`           |    No    |               `"icons"`               | `"icons"`, `"minimal"`, `"detailed"`, `"debug"`, or `"none"` (also overridable per camera)                     |
| `card_position`        |    No    |            `"bottom-left"`            | `"bottom-left"`, `"top-left"`, `"top-right"`, `"bottom-right"`, or `"center"` (also overridable per camera)    |
| `sleep_screen`         |    No    |             `"snapshot"`              | `"snapshot"` (last camera frame), `"slate"` (dark gray), or `"black"` (also overridable per camera)            |
| `audio`                |    No    |                `true`                 | Include camera audio in the stream (`true` or `false`)                                                         |
| `hwaccel`              |    No    |                `false`                | GPU encoding: `false`, `true` (`"vaapi"`), `"vaapi"` (Intel/AMD), `"qsv"`, `"nvenc"` (NVIDIA), or `"v4l2m2m"`  |
| `ha_webhook_url`       |    No    |                   -                   | Optional Home Assistant webhook URL for instant event & snapshot notifications                                 |
| `log_level`            |    No    |               `"info"`                | `"info"`, `"debug"`, `"warn"` (`"warning"`), or `"error"`                                                      |

### Per-Camera Settings (`cameras[]`)

| Key         | Required |            Default             | Meaning                                                                                                                        |
| :---------- | :------: | :----------------------------: | :----------------------------------------------------------------------------------------------------------------------------- |
| `serial`    | **Yes**  |               -                | Camera serial number from the Eufy app (e.g. `SN0000000001`)                                                                   |
| `name`      |    No    |            `serial`            | Camera name in Frigate (defaults to `serial` when omitted)                                                                     |
| `title`     |    No    |           Eufy name            | Friendly display name for logs, notifications, and the `"detailed"` card theme                                                 |
| `mode`      |    No    |            `"auto"`            | `"rtsp"`, `"backfill"`, `"p2p"`, `"custom"`, or `"auto"`                                                                       |
| `hold_secs` |    No    |   `60` (`30` in `backfill`)    | Recording & event duration in seconds (`5 - 86400`, global or per-camera; syncs to the Eufy camera, the bridge, and Frigate)   |
| `end_early` |    No    | `false` (`true` in `backfill`) | Stop recording early as soon as motion clears (`true` or `false`, global or per-camera)                                        |
| `priority`  |    No    |              `0`               | Priority when two `P2P` cameras trigger at the same time (`-10000 - 10000`, higher number wins)                                |

*(You can also override `card_theme`, `card_position`, `sleep_screen`, `telemetry`, `trigger_events`,
`backfill_enabled`, `low_battery_threshold`, or `low_battery_wake_on_view` on individual cameras - see
[Advanced Settings & Custom Mode](#advanced-settings--custom-mode) below.)*

## Optional Integrations

### Waking Cameras from Home Assistant or Scripts (`/api/wake`)

To wake cameras from external door or motion sensors, send a `POST /api/wake/<cameras>` request to port `8080` (using
one or more comma-separated camera names, serials, or titles, or `all`). The bridge wakes `RTSP` cameras before `P2P`,
spaces out `HomeBase` wakes, ignores duplicate bursts, and records a Frigate event by default (pass
`"create_event": false` for a view-only wake):

```bash
# Wake one or more cameras for 30 seconds and record an event in Frigate
curl -X POST "http://127.0.0.1:8080/api/wake/garage,front_doorbell" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Garage door opened", "duration": 30}'
```

In Home Assistant, add a `rest_command` in `configuration.yaml` and call it from your automation:

```yaml
rest_command:
  wake_eufy_cameras:
    url: "http://127.0.0.1:8080/api/wake/{{ cameras }}"
    method: POST
    content_type: "application/json"
    payload: '{"reason": "{{ reason }}", "duration": 30}'

automation:
  - alias: "Pre-wake Eufy cameras when garage opens"
    triggers:
      - trigger: state
        entity_id: binary_sensor.garage_door
        from: "off"
        to: "on"
    actions:
      - action: rest_command.wake_eufy_cameras
        data:
          cameras: "garage,front_doorbell"
          reason: "Garage door opened"
```

> [!NOTE]
> When `/api/wake` is called while a camera has no active Eufy hardware recording or pending clip replay, the bridge
> wakes the camera live (`RTSP` if supported, else `P2P`) and records a Frigate event - including in `"backfill"` mode
> (because `HomeBase 3` only records native `.zxvideo` clips when the camera's own motion or doorbell sensor triggers).
> If a Eufy hardware recording or `HomeBase 3` clip backfill is already in progress, both `/api/wake` and Frigate Live
> View wait for the clip backfill to finish instead of interrupting the recording.

### Home Assistant Webhook Notifications (`ha_webhook_url`)

When `ha_webhook_url` is set, the bridge sends two `POST` messages to Home Assistant for every event:

1. **Immediately when triggered:** `{"camera", "title", "label", "person"}` for an instant notification (including the
   recognized person's name when `HomeBase 3` identifies someone).
2. **Once the Frigate event is ready:** The same fields plus `event_id` and `review_id` so you can attach the Frigate
   event snapshot image.

## Automatic Startup & Runtime Checks

The bridge automatically validates settings and heals common camera hiccups on startup and while running:

- **Startup checks:**
  - **Configuration safety:** Checks all global and per-camera settings for conflicts (such as sleeping frame rates set
    higher than live frame rates, or camera clip lengths set shorter than hold times) and adjusts them automatically.
  - **Camera & Power Manager sync:** Reads each camera's battery, signal, and recording settings, then configures Eufy
    Power Manager mode, clip length, retrigger delay, streaming quality, and `RTSP` toggles to match your chosen `mode`.
  - **Service & `HomeBase` connection check:** Verifies that `eufy-security-ws` is connected to Eufy's cloud and every
    `HomeBase` station on startup, reconnecting automatically if an earlier Wi-Fi drop left them disconnected.
  - **Initial snapshots & Frigate masks:** Loads saved snapshots from disk (or briefly wakes a newly added camera once
    if no snapshot exists yet) and sends the corner status card mask coordinates to Frigate.
- **Runtime checks:**
  - **Stream health & automatic recovery:** Watches active streams for stalls, mid-session clip cutoffs, or `HomeBase`
    reconnections, automatically re-waking dropped streams while movement or a viewer is still active.
  - **Activity & hold extensions:** Watches both Eufy motion sensors and Frigate object detection near the end of a
    recording to keep the stream and Frigate event going as long as someone is still in view.
  - **Battery & offline protection:** Shortens recordings when a battery is low, stops the camera's stream if its
    battery dies or the device goes offline so Frigate marks it offline, and resumes automatically once recharged.
  - **Idle wireless radio & connection guard:** Detects if a camera's wireless radio stays stuck awake after a finished
    session and sends a clean stop command, and reconnects `HomeBase` links automatically if a background refresh times
    out.

## Advanced Settings & Custom Mode

Most setups never need to change these - the built-in modes (`"auto"`, `"rtsp"`, `"backfill"`, and `"p2p"`) already tune
recording lengths, frame rates, snapshots, and Eufy Power Manager settings automatically.

### When Are Advanced Settings or `"mode": "custom"` Useful?

- **Filtering out false alerts on a busy street:** Set `"trigger_events": ["person", "ring"]` on a front camera so
  swaying trees or passing cars do not wake it.
- **Solar or wired cameras in high-activity areas:** Increase `hold_secs` to `120` seconds for longer clips, and set
  `idle_timeout_secs: 15` so the stream still closes early once Frigate confirms nobody is left in view.
- **Indoor or nursery cameras:** Wake only on `"crying"` or `"sound"`, hide temperature or Wi-Fi icons on the status
  card (`telemetry`), and allow longer Live View sessions (`view_max_secs: 900`).
- **Managing camera schedules yourself in the Eufy app or using `HomeBase 2`:** Set `sync_power: false` so the bridge
  never touches your Eufy Power Manager settings, or set `backfill_enabled: false` on older `HomeBase 2` stations that
  do not support clip downloads.

Settings marked **`Global & Camera`** can be placed at the top of `config.json` (for all cameras) or inside a single
camera in `cameras[]`. Settings marked **`Camera ("custom")`** apply to individual cameras when `"mode": "custom"` is
set.

### 1. Status Card, Display & Snapshots

- **Saved snapshots (`/config/cache`):** Whenever a camera streams live video or replays a clip, the bridge saves a
  clean `JPEG` picture (without the corner status card) to `/config/cache` and uses it as the sleeping backdrop
  (`sleep_screen: "snapshot"`).
- **First-boot snapshot (`startup_snapshot: true`):** When `sleep_screen` is `"snapshot"`, the bridge **only** wakes a
  camera on startup if there is **no saved picture on disk yet** for that camera (for example, the first time you add a
  new camera, it briefly wakes to take an initial picture). On all later restarts, it loads the saved file from
  `/config/cache` without waking the camera.
- **Clean Frigate event thumbnails (`instant_event_snapshot: true`):** On motion or doorbell events, the bridge waits
  for `1` second of real video (`0.8s` on backfill clip replays) before creating the Frigate event so the event
  thumbnail shows live action. If a wake ever times out without video, the bridge temporarily hides the `"Waking Up..."`
  card so Frigate gets a clean thumbnail.

| Key                           |      Scope      |     Default     |     Valid Range / Values     | Meaning                                                                                                                                                                   |
| :---------------------------- | :-------------: | :-------------: | :--------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `card_show_on_live`           | Global & Camera |     `true`      |      `true` or `false`       | Keep the corner status card visible (`Red` live/replay indicator) during active streams                                                                                   |
| `auto_frigate_mask`           | Global & Camera |     `true`      |      `true` or `false`       | Automatically mask the corner status card in Frigate so status changes never trigger motion                                                                               |
| `telemetry`                   | Global & Camera |     `true`      |  `true`, `false`, or object  | Show or hide status card items (`{"enabled": true, "battery": true, "power_source": true, "wifi": true, "rssi": true, "temperature": true, "last_seen": true}`)           |
| `telemetry_poll_secs`         |     Global      |      `300`      |  `0 - 86400` (`0` disables)  | How often (in seconds) to refresh battery, Wi-Fi, and temperature while sleeping                                                                                          |
| `preserve_aspect_ratio`       | Global & Camera |     `true`      |      `true` or `false`       | Keep native camera proportions (such as `4:3` or portrait doorbells) with dark sidebars                                                                                   |
| `width` / `height`            |     Global      | `1280` / `720`  | `320 - 3840` / `240 - 2160`  | Output `RTSP` stream resolution (even numbers)                                                                                                                            |
| `startup_snapshot`            | Global & Camera |     `true`      | `true`, `false`, `"always"`  | Briefly wake a camera on startup when `sleep_screen: "snapshot"` if no saved snapshot exists (`"always"` refreshes on every restart)                                      |
| `instant_event_snapshot`      |     Global      |     `true`      |      `true` or `false`       | Create Frigate events after `1s` of live video and use a clean cached snapshot if a wake times out                                                                        |
| `snapshot_capture_delay_secs` |     Global      |       `3`       |           `0 - 60`           | Maximum seconds of live video to wait before creating a Frigate event when `instant_event_snapshot` is `false`                                                            |
| `cache_dir`                   |     Global      | `/config/cache` |        Directory path        | Folder where clean `JPEG` camera snapshots are saved across restarts                                                                                                      |

### 2. Event Triggers, Priorities & Face Recognition

- **Filtering triggers (`trigger_events`):** Choose which Eufy alerts (`motion`, `radar`, `person`, `identity person`,
  `stranger`, `loitering`, `package`, `pet`, `dog`, `vehicle`, `sound`, `crying`, `ring`) wake or backfill each camera.
- **Priority switching (`priority` & `event_priorities`):** Because a `HomeBase` can only run one `P2P` stream or clip
  download at a time, the bridge adds each camera's `priority` to the event score (`ring` beats `person`, which beats
  general `motion`). If a higher-priority `P2P` alert arrives while another `P2P` camera is streaming, the bridge
  switches to the more important camera immediately and replays the interrupted camera's recorded clip from `HomeBase 3`
  afterward.
- **Face recognition (`forward_face_names`):** When `HomeBase 3` recognizes a familiar person, the bridge forwards their
  name to Frigate's event `sub_label` and to Home Assistant.

| Key                  |      Scope      |      Default       |  Valid Range / Values  | Meaning                                                                                                                                                                     |
| :------------------- | :-------------: | :----------------: | :--------------------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger_events`     | Global & Camera | All motion/AI/ring |    Array of strings    | Event types that wake/backfill cameras (`["motion", "radar", "person", "identity person", "stranger", "loitering", "package", "pet", "dog", "vehicle", "sound", "crying", "ring"]`) |
| `event_priorities`   |     Global      |   Built-in tiers   | Object (`{key: num}`)  | Priority boost per event type (`ring: 1000`, `identity person: 300`, `person/stranger/loitering: 200`, `package: 150`, `vehicle/pet/dog: 100`, `crying/sound: 50`, `radar/motion: 10`) |
| `view_has_priority`  |     Global      |       `true`       |   `true` or `false`    | Allow a human Frigate Live View or newer equal-priority motion event to take over an active `P2P` stream on the same `HomeBase`                                             |
| `forward_face_names` |     Global      |       `true`       |   `true` or `false`    | Forward recognized person names from `HomeBase 3` to Frigate `sub_label` and Home Assistant                                                                                 |
| `ring_label`         |     Global      |     `"person"`     |         String         | Frigate event label used when someone rings the doorbell                                                                                                                    |

### 3. Recording Timers, Live View & Low-Battery Saver

- **Recording & early-sleep timers (`stream_max_secs` & `idle_timeout_secs`):** Active streams automatically extend when
  movement continues, up to `stream_max_secs` (`15` minutes by default). Setting `idle_timeout_secs` (for example, `15`)
  lets the bridge close a motion stream early once Frigate confirms `0` tracked objects for `15` seconds.
- **Live View timers (`view_linger_secs`, `view_max_secs`, `view_cooldown_secs`):** Keeps the stream warm for `20`
  seconds after you close Frigate Live View so switching cameras is fast, while capping forgotten Live Views at `5`
  minutes (`view_max_secs`).
- **Low-Battery Saver (`low_battery_threshold`, `low_battery_hold_secs`, `low_battery_wake_on_view`):** When an
  unplugged camera's battery drops to `20%` or below, the bridge shows a purple status indicator, shortens motion
  recordings to `20` seconds, and prevents Live View from waking the camera so remaining battery power is saved for
  events.

| Key                        |      Scope      | Default |         Valid Range / Values         | Meaning                                                                                                 |
| :------------------------- | :-------------: | :-----: | :----------------------------------: | :------------------------------------------------------------------------------------------------------ |
| `stream_max_secs`          | Global & Camera |  `900`  |     `10 - 86400` (`>= hold_secs`)    | Maximum continuous live session length (`15` minutes) when motion keeps re-triggering                   |
| `idle_timeout_secs`        | Global & Camera |   `0`   |       `0 - 3600` (`0` disables)      | Optional battery saver: close motion streams early once Frigate sees `0` active objects for `N` seconds |
| `view_linger_secs`         | Global & Camera |  `20`   |              `5 - 86400`             | How long to stay live after you close Frigate Live View                                                 |
| `view_max_secs`            | Global & Camera |  `300`  | `10 - 86400` (`>= view_linger_secs`) | Maximum duration for a manual Live View session (`5` minutes)                                           |
| `view_cooldown_secs`       |     Global      |   `5`   |              `0 - 3600`              | Short pause after sleep before a pure viewer re-wake; bypassed while a Eufy hardware trigger is active  |
| `low_battery_threshold`    | Global & Camera |  `20`   |       `0 - 100` (`0` disables)       | Battery `%` at or below which unplugged cameras enter Low-Battery Saver Mode                            |
| `low_battery_hold_secs`    | Global & Camera |  `20`   |      `5 - 3600` (`<= hold_secs`)     | Shorter recording duration when a camera is in Low-Battery Saver Mode                                   |
| `low_battery_wake_on_view` | Global & Camera | `false` |           `true` or `false`          | Allow manual Frigate Live View to wake a camera while its battery is low                                |

### 4. Frame Rates, GPU Encoding & Network

- **Streams (`idle_fps: 5` while asleep -> `live_fps: 15` when active):**
  - While a camera is **asleep**, the bridge sends `5` identical frames per second (`idle_fps`) to `go2rtc`. Because the
    picture is not changing, video compression shrinks those frames to almost nothing (`~20-40 kbps`), keeping Frigate's
    connection ready with minimal CPU or GPU usage.
  - As soon as a camera **wakes up** or **replays a `HomeBase 3` clip**, the bridge switches to `15` frames per second
    (`live_fps`) to match Eufy's native camera speed.
- **Detection (Zero AI load while asleep):**
  - Matching Frigate's `detect.fps: 5` to `idle_fps: 5` prevents dropped-frame warnings in Frigate. Because the sleeping
    snapshot is completely still and the corner status card is automatically masked, Frigate runs **zero** AI object
    checks while the camera sleeps.
- **Storage (Zero disk usage while asleep):**
  - With `record.continuous.days: 0` in Frigate's `config.yml`, Frigate discards sleeping frames in memory and uses
    **0 MB of disk space** while cameras sleep - only saving video during real events.

| Key              | Scope  |        Default        |   Valid Range / Values   | Meaning                                                                                  |
| :--------------- | :----: | :-------------------: | :----------------------: | :--------------------------------------------------------------------------------------- |
| `live_fps`       | Global |         `15`          |         `5 - 60`         | Output frame rate while a camera is streaming or replaying a clip                        |
| `idle_fps`       | Global |          `5`          | `1 - 30` (`<= live_fps`) | Output frame rate while a camera is asleep (match Frigate's `detect.fps`)                |
| `hwaccel_device` | Global | `/dev/dri/renderD128` |           Path           | GPU device path when `hwaccel` is set to `"vaapi"` or `"qsv"`                            |
| `http_port`      | Global |        `8080`         | `0 - 65535` (`0` = off)  | Port for `/healthz`, `/api/config`, and `/api/wake/:cameras`                             |

### 5. Custom Mode (`"mode": "custom"`), Clip Backfill & Eufy Power Manager Overrides

- **When to use `"mode": "custom"`:** Use `"mode": "custom"` on a camera when you want to manually control its streaming
  protocol (`use_rtsp`), clip-replay behavior (`backfill_only`, `backfill_enabled`), Frigate event length
  (`frigate_event_secs`), or Eufy hardware Power Manager settings (`power_working_mode`, `recording_clip_length`,
  `recording_end_early`, `recording_retrigger_interval`) instead of using a preset mode.
- **Automatic conflict protection:** Even in `"mode": "custom"`, the bridge checks all settings on startup and
  automatically fixes any contradiction:
  - **`idle_fps > live_fps`:** Lowers `idle_fps` to match `live_fps` so a sleeping stream never runs at a higher frame
    rate than live video.
  - **`stream_max_secs < hold_secs` or `low_battery_hold_secs > hold_secs`:** Raises `stream_max_secs` to at least
    `hold_secs` and caps `low_battery_hold_secs` at `hold_secs`.
  - **`recording_clip_length < hold_secs` when `end_early: false`:** Raises `recording_clip_length` to match `hold_secs`
    (up to `120s`) so the camera does not stop recording before `hold_secs` finishes.
  - **`power_working_mode: 0` or `1` with conflicting hold/clip settings:** Switches `power_working_mode` to `2`
    (`Customize Recording`) whenever custom clip settings are used or when mode `0` (`Optimal Battery Life`, which fixes
    clips at `20s`) conflicts with `hold_secs > 20` or `end_early: false`.
  - **`backfill_enabled: false` in `"backfill"` mode:** Keeps `backfill_enabled: true` on any `"mode": "backfill"`
    camera so clip-replay events are never lost.

| Key                            |            Scope            |             Default             |     Valid Range / Values     | Meaning                                                                                                                     |
| :----------------------------- | :-------------------------: | :-----------------------------: | :--------------------------: | :-------------------------------------------------------------------------------------------------------------------------- |
| `use_rtsp`                     |       Global & Camera       |             `true`              |      `true` or `false`       | Use `HomeBase` native `RTSP` (`true`) or `P2P` (`false`)                                                                    |
| `homebase_rtsp_url`            |           Camera            |         Auto-discovered         |         `rtsp://...`         | Custom `RTSP` stream URL override if not discovered automatically from `eufy-security-ws`                                   |
| `station_serial`               |           Camera            |         Auto-discovered         |        `SN0000000000`        | Explicit `HomeBase` station serial number for multi-station `P2P` setups                                                    |
| `backfill_only`                | Global & Camera (`"custom"`) |             `false`             |      `true` or `false`       | Use clip-replay backfill mode on events when a camera uses `"mode": "custom"`                                               |
| `backfill_enabled`             |       Global & Camera       |             `true`              |      `true` or `false`       | Replay recorded clips from `HomeBase 3` when a `P2P` stream is busy or in `"backfill"` mode (`false` on `HB2`)              |
| `backfill_delay_secs`          |           Global            |               `2`               |          `2 - 120`           | Wait time after a `HomeBase` `P2P` stream finishes before downloading a recorded clip                                       |
| `frigate_event_secs`           |       Global & Camera       | `hold_secs` (`60` / `30` in BF) |          `1 - 3600`          | Frigate event duration in seconds (defaults to matching `hold_secs`)                                                        |
| `sync_power`                   |       Global & Camera       |             `true`              |      `true` or `false`       | Automatically sync Eufy Power Manager mode and clip settings on startup (`false` leaves Power Manager settings untouched)   |
| `track_stuck_spotlight`        |       Global & Camera       |             `false`             |      `true` or `false`       | **Experimental:** Turn off a camera spotlight left stuck on (`>130s` idle); disabled by default while refined               |
| `power_working_mode`           |           Camera            |        `2` (`Customize`)        |       `0`, `1`, or `2`       | Eufy Power Manager mode (`0` Optimal Battery, `1` Optimal Surveillance, `2` Customize Recording; honored when `sync_power`) |
| `recording_clip_length`        |           Camera            |           `hold_secs`           |          `5 - 120`           | Camera hardware clip length in seconds (honored when `sync_power: true`)                                                    |
| `recording_end_early`          |           Camera            |           `end_early`           |      `true` or `false`       | Camera hardware setting to stop recording early when motion stops (also falls back to `end_early` in `"custom"` mode)       |
| `recording_retrigger_interval` |           Camera            |               `5`               |           `0 - 60`           | Minimum pause in seconds between camera hardware motion triggers (honored when `sync_power: true`)                          |
| `enforce_streaming_quality`    |       Global & Camera       |             `true`              | `true`, `false`, or `1 - 10` | Clamp non-doorbell `P2P` quality (`0` Auto or `> 7` High/4K) to `7` (`1280x720`), or set an explicit `1 - 10` value         |

## Troubleshooting & FAQ

### Events & Motion Detection

- **Nothing happens when I walk in front of a camera:**
  Make sure **push notifications are turned ON** for that camera in the Eufy app on the account used by
  `eufy-security-ws`. Eufy only sends motion alerts when notifications are enabled (you can mute the Eufy app in your
  phone's OS notification settings instead).
- **My battery doorbell (or walkway camera) misses fast walk-bys, or wakes up after the person has already left:**
  Waking a sleeping battery camera over `P2P` takes `3-6` seconds. Set `"mode": "backfill"` on that camera in
  `config.json`. Instead of trying to open a live stream on motion, the camera records its native clip (including the
  pre-roll right before motion triggered) to `HomeBase 3` and goes straight back to sleep; once movement clears, the
  bridge downloads and replays the complete clip into Frigate from the very first frame.
- **In `"backfill"` mode, why is there a short delay before the clip appears in Frigate (and why does Live View wait
  while a clip is pending)?**
  In `"backfill"` mode, the camera must finish recording its clip to `HomeBase 3` and all motion triggers must clear
  (plus a few seconds for `HomeBase 3` to save the file) before the bridge can download and replay it. While that
  recording or clip replay is pending (**Yellow** `Waiting` indicator), Frigate Live View and `/api/wake` wait for the
  clip backfill to complete so the `HomeBase 3` recording is never interrupted or truncated.
- **Frigate is recording 24/7 or creating false motion alerts while cameras are asleep:**
  1. Set `record.continuous.days: 0` for each battery camera in Frigate's `config.yml` so Frigate only saves events.
  2. Set `frigate_url` (e.g. `"http://frigate:5000"`) in `config.json` and keep `auto_frigate_mask: true` (default)
     with a corner `card_position` (`"bottom-left"`, `"top-left"`, `"top-right"`, or `"bottom-right"`). Avoid
     `"card_position": "center"` unless Frigate motion detection is disabled on that camera.

### Live View & Streaming

- **Clicking a camera in Frigate doesn't wake it up:**
  - **Multi-camera dashboard grid:** Opening Frigate's multi-camera overview connects to all cameras at once; the bridge
    ignores simultaneous grid connections so it never wakes all your sleeping cameras at the same time. Click into a
    **single camera's** Live View to wake it.
  - **Low-Battery Saver Mode (*Purple* status icon):** When an unplugged camera is at or below `20%` battery
    (`low_battery_threshold`), Live View wakes are blocked by default to save battery for motion events (set
    `"low_battery_wake_on_view": true` if you still want Live View to wake it).
  - **`HomeBase` busy (*Yellow* `"Waiting"` icon):** On `P2P` cameras, if another `P2P` camera on the same `HomeBase` is
    currently recording a motion event or downloading a clip, Live View waits until that `P2P` slot is free.
- **The logs say `"Failed reading RTSP data: End of file"` every 3 seconds:**
  Make sure the camera's `name` (or `serial`) is listed under `go2rtc.streams:` in Frigate's `config.yml` (with an empty
  value), and that `rtsp_output_url` in `config.json` points to your Frigate container.
- **My `"rtsp"` camera doesn't connect over `RTSP`:**
  In the Eufy app, open **Camera Settings -> Storage -> NAS (`RTSP`)** once to turn on the `RTSP` switch. After that,
  the bridge wakes and manages the `RTSP` stream automatically.
- **My `P2P` live stream is slow to start, stutters, or times out:**
  When Eufy's `P2P` streaming quality is set to `Auto`, `High`, or `4K`, the camera sends a heavy stream that often
  stalls over `HomeBase` `P2P`. Keep `enforce_streaming_quality: true` (on by default, independent of `sync_power`) so
  the bridge automatically clamps non-doorbell `P2P` streaming quality to `Medium` (`1280x720`), which starts much
  faster.

### Battery, Offline Cameras & Hardware

- **A camera's battery is draining faster than expected even with few events:**
  - **External polling or wake scripts:** Make sure Home Assistant's Eufy Security integration is not configured to
    periodically poll the camera or press `start_rtsp_livestream` / `start_p2p_livestream` in the background.
  - **Too many street or tree triggers:** Either adjust detection zones in the Eufy app, or set
    `"trigger_events": ["person", "ring"]` on that camera in `config.json` so swaying trees or passing cars do not wake
    it.
  - **Stuck camera spotlight:** On spotlight cameras (such as Color Night Vision), a light left stuck on after an event
    keeps the camera radio awake. You can opt into `"track_stuck_spotlight": true` (globally or per-camera) so the
    bridge turns off a spotlight stuck on for more than `130` seconds while idle; this feature is **experimental** and
    disabled (`false`) by default while its detection heuristic is refined.
- **How do I tell whether a camera is sleeping normally vs. out of battery or offline?**
  Sleeping cameras show their last saved snapshot with a **Green** (`Asleep`) status card (or **Grey** `Disconnected` if
  `eufy-security-ws`, `HomeBase`, `Frigate`, or `go2rtc` is unreachable). If a camera's battery runs completely flat,
  `eufy-security-ws` reports the camera offline, or a manual wake fails to respond, the bridge stops that camera's video
  stream so Frigate shows it as offline (after briefly sending the last cached snapshot on restart if available). As
  soon as you recharge the battery or the camera comes back online, the bridge restarts its stream automatically.
- **I swapped or recharged a dead battery, why does the camera still show as offline in Frigate?**
  Eufy cameras do not push an instant notification when you physically swap a battery while the camera is asleep. Wait up
  to `5` minutes (`telemetry_poll_secs`), open the camera in Frigate Live View, call `/api/wake/<camera>`, or walk in
  front of the camera - the bridge will refresh the battery reading and restart the stream automatically.
- **GPU encoding (`hwaccel: "vaapi"`, `"qsv"`, or `"nvenc"`) fails at startup:**
  If the container cannot access your GPU, the bridge **automatically falls back to CPU encoding** so your streams still
  work. To use GPU encoding, make sure `/dev/dri:/dev/dri` is passed through in your `docker-compose.yml` and the
  container has permission to access `/dev/dri/renderD128`.

### Diagnostics & Health Checks

- **How do I check if the bridge is healthy or inspect its active config?**
  - Run `curl http://127.0.0.1:8080/healthz` - returns `"ok": true` and `"ws_connected": true` when connected to
    `eufy-security-ws`, along with `"active_cameras"` and `"offline_cameras"`.
  - Run `curl http://127.0.0.1:8080/api/config` - returns the running bridge version, Git commit, and active settings.
- **How do I visually see what the bridge and camera are doing inside Frigate?**
  Set `"card_theme": "debug"` (globally or on a single camera in `config.json`). This displays a bottom diagnostic bar
  directly on the video stream showing the current state (`IDLE`, `WK_RTSP`, `WK_P2P`, `LIVE`, `BF_HSHK`, `BF_PLAY`,
  `BF_TAIL`, `COOLDWN`), frame rate, service health (`WS`, `HB`, `FRG`, `RTC`), battery/Wi-Fi/temperature, spotlight
  state, Eufy hardware recording settings, and active timers.

## Migrating from the Original Configuration

If you are upgrading from the original
[ljlongwing/eufy-frigate-battery-bridge](https://github.com/ljlongwing/eufy-frigate-battery-bridge/commit/1d8f9f1fdb3879c8b610607c2f7f5b8db9baf577),
your existing `config.json` works immediately without any changes.

> **Important:** Do not mix old and new property names in the same `config.json`. Either keep your original
> `config.json` as-is, or update the renamed keys below to use the new features (such as per-camera `mode` or status
> card themes). Because [`deploy/config.schema.json`](deploy/config.schema.json) validates the current property names,
> omit `"$schema"` until migrating if your editor flags legacy keys.

### 1. Renamed & Updated Properties

Several property names from the original project were renamed to make their purpose clearer and to auto-derive
connection addresses from `frigate_url` so fewer settings are required:

| Original Property                                                                                                      | New Property                  | What Changed & How It Works                                                                                                                                    |
| :--------------------------------------------------------------------------------------------------------------------- | :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eufy_ws`                                                                                                              | `eufy_security_ws_url`        | Renamed to make clear it is the full `WebSocket` URL of the `eufy-security-ws` container.                                                                      |
| `frigate_api`                                                                                                          | `frigate_url`                 | Required in the new format. In an original `config.json` where `frigate_api` was omitted, it is derived from `go2rtc_api`.                                     |
| `go2rtc_api`                                                                                                           | `go2rtc_url`                  | Now optional - automatically derived from `frigate_url` on port `1984` unless you run a separate `go2rtc` server.                                              |
| `rtsp_publish`                                                                                                         | `rtsp_output_url`             | Now optional - automatically derived from `go2rtc_url` or `frigate_url` on port `8554`.                                                                        |
| `ha_webhook`                                                                                                           | `ha_webhook_url`              | Renamed for consistency with the other service URL settings.                                                                                                   |
| `max_secs`                                                                                                             | `stream_max_secs`             | Renamed to distinguish the maximum motion recording duration from `view_max_secs` (the maximum Live View duration).                                            |
| `viewer_cooldown_secs`                                                                                                 | `view_cooldown_secs`          | Renamed to match `view_linger_secs` and `view_max_secs`. Default lowered from `45` seconds to `5` seconds because dashboard grids are filtered automatically.  |
| `event_secs`                                                                                                           | `frigate_event_secs`          | Renamed to clarify that it controls the event duration sent to Frigate's `HTTP` API (which now defaults to matching `hold_secs`).                              |
| `snapshot_delay_secs`                                                                                                  | `snapshot_capture_delay_secs` | Renamed to clarify that it controls how long the bridge waits after live video starts before asking Frigate to capture an event snapshot.                      |
| `min_dwell_secs`                                                                                                       | *(Replaced by priorities)*    | Replaced by camera `priority` and automatic event priority tiers (doorbell rings beat motion).                                                                 |
| `cameras[].name`                                                                                                       | `cameras[].name` *(optional)* | Required in an original `config.json`; optional in the new format (defaults to the camera's `serial` when omitted).                                            |
| `cameras[].serial`                                                                                                     | `cameras[].serial`            | Unchanged (required in both formats).                                                                                                                          |
| `cameras[].title`                                                                                                      | `cameras[].title`             | Unchanged (optional in both formats; defaults to the camera's name in the Eufy app when omitted).                                                              |
| `hold_secs`, `audio`, `width`, `height`, `live_fps`, `idle_fps`, `view_linger_secs`, `view_max_secs`, `trigger_events` | *(Same name in both)*         | Unchanged and work identically in both formats.                                                                                                                |

### 2. Default Settings Applied to an Original Configuration

Because the original configuration format did not include camera operating modes, status card themes, or battery
safeguards, the bridge automatically applies the following defaults when running with an original `config.json`:

| New Feature / Setting                                                | Default Used                 | What It Does Automatically                                                                                                                                                      |
| :------------------------------------------------------------------- | :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Camera operating mode (`mode`)                                       | `"auto"`                     | Uses `HomeBase` native `RTSP` automatically on cameras that support it, or live `P2P` with automatic `HomeBase 3` clip-replay fallback on other cameras.                        |
| Status card style (`card_theme` & `card_position`)                   | `"icons"` in `"bottom-left"` | Replaces the full-screen text placeholder with a small frosted-glass corner badge showing status, battery, Wi-Fi signal, temperature, and last active time.                     |
| Standby background (`sleep_screen`)                                  | `"snapshot"`                 | Displays the last clean video frame captured from the camera while it sleeps (saved across container restarts in `/config/cache`).                                              |
| Frigate motion & object masks (`auto_frigate_mask`)                  | `true` (enabled)             | Automatically configures Frigate's motion and object masks over the corner status card so status updates never trigger false recordings in Frigate.                             |
| Eufy Power Manager sync (`sync_power` & `enforce_streaming_quality`) | `true` (enabled)             | Syncs each camera's Eufy recording length to match `hold_secs` (`60` seconds by default) and caps non-doorbell `P2P` streaming quality at `Medium` (`720p`) to prevent stalls. |
| Frame rates (`live_fps` / `idle_fps`)                                | `15 fps` / `5 fps`           | Smooths live video to `15` frames per second and keeps sleeping streams at `5` frames per second (unless overridden in your `config.json`).                                     |
| Low-battery protection (`low_battery_threshold`)                     | `20%` (`20s` hold)           | Shortens motion recordings to `20` seconds and blocks Live View wakes when an unplugged camera's battery drops to `20%` or below.                                               |

## Credits & License

- Originally created by [ljlongwing](https://github.com/ljlongwing)
  ([ljlongwing/eufy-frigate-battery-bridge](https://github.com/ljlongwing/eufy-frigate-battery-bridge)) with help from
  Claude (Anthropic).
- Enhanced and maintained by [obatiuk](https://github.com/obatiuk) in collaboration with Gemini (Google).
- Tested on Eufy **HomeBase 3 (S380)** (`T8030`), **Video Doorbell E340 Dual** (`T8214`), and **eufyCam S300 (3C)**
  (`T8161`).
- Built to integrate [Frigate NVR](https://frigate.video/) and [go2rtc](https://github.com/AlexxIT/go2rtc) by
  [AlexxIT](https://github.com/AlexxIT) with [eufy-security-ws](https://github.com/bropat/eufy-security-ws) by
  [bropat](https://github.com/bropat).
- [MIT License](LICENSE).
