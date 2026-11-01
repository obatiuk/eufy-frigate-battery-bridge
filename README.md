# eufy-frigate-battery-bridge

## Disclaimer

This is a fork of the original [ljlongwing/eufy-frigate-battery-bridge](https://github.com/ljlongwing/eufy-frigate-battery-bridge) repository with stability, visual, smart battery conservation, hardware-accelerated encoding, and telemetry enhancements.

All credit for the original concept and architecture goes to the original author under the [MIT License](LICENSE):

```
Copyright (c) 2026 ljlongwing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Description

Get **Eufy battery cameras** into **Frigate**: recordings and Frigate events when Eufy sees motion
or a person, plus live view on demand.

Eufy battery cameras sleep almost all the time, have no `RTSP` stream, and only stream when woken
over Eufy's own `P2P` connection (the one the Eufy app uses). `Frigate` needs a continuous stream. This
bridge sits in between:

- **Frigate sees a normal, always-on camera.** While the Eufy camera sleeps, the stream displays the
  camera's dimmed last live frame with a frosted-glass status overlay placed in the `"center"` or any
  corner (`"top-left"`, `"top-right"`, `"bottom-left"`, `"bottom-right"`), using full text (`"default"`),
  vector icons only (`"icons"`), three color-coded status dots (`"minimal"`), or no overlay (`"none"`).
- **On-screen telemetry while asleep.** Displays battery state, charging/solar/plugged/economy mode,
  Wi-Fi signal strength and `RSSI`, battery temperature, and the timestamp of the last live stream.
- **Persistent snapshot cache & startup probe.** Last live frames are saved to `/config/cache` so
  dimmed background snapshots survive container restarts. If a camera has no cached snapshot on
  startup, the bridge can briefly wake it once (`startup_snapshot`), capture a clean frame, and put it
  right back to sleep.
- **Motion or doorbell ring wakes it.** When Eufy reports motion, a person, a pet, or a doorbell press
  (`rings`), the bridge starts a `P2P` livestream through [`eufy-security-ws`](https://github.com/bropat/eufy-security-ws)
  and feeds the real video into the same stream for `hold_secs` after the last report (or sleeps early
  once activity ends). `Frigate` records it and runs detection on it like any other camera.
- **Eufy's detection becomes a Frigate event.** A walk-past is often over before the video arrives,
  so the bridge also files the event in `Frigate` directly (`person`, `car`, `dog` or `motion`, with
  `HomeBase 3` recognized face names forwarded as `sub_label` or `eufy` by default), with the recording
  attached. It shows up in `Review`.
- **Opening a single camera wakes it.** Opening a camera's single-stream live view in `Frigate` wakes
  the camera for as long as someone is watching, while multi-camera dashboard grid connections are
  automatically ignored so browsing the main dashboard never drains your batteries.
- **One stream at a time.** A `HomeBase` serves only one `P2P` livestream at a time, so the cameras take
  turns. Motion beats a viewer, newer motion on another camera takes over once the current one has
  shown `min_dwell_secs` of video, and a newer viewer beats an older one.
- **Optional Home Assistant webhook** for notifications (see below).

```
Eufy event ──► eufy-security-ws ──► bridge ──(wake, P2P video)──► ffmpeg ──RTSP──► Frigate's go2rtc ──► Frigate
                                       └──► Frigate API (event)      └──► HA webhook (optional)
```

One `ffmpeg` encoder per camera runs all the time, so the output stream never breaks between asleep
and live and Frigate's recorder never has to reconnect at the start of an event. While a camera is
live, a second `ffmpeg` decodes the Eufy video (`H.265` or `H.264`, any size) and scales it to `1280×720`.

## Enhancements in This Fork

- **Customizable status themes (`card_theme`), frosted-glass blur & placement (`card_position`):**
	- **`"default"` theme:** Frosted-glass backdrop panel with full text and graphical telemetry icons using
	  Frigate's `Inter` typeface—renders the centered modal (`820×336`) with a color-coded status glyph when
	  `card_position` is `"center"`, or a compact two-line card (`540×88`) when placed in `"top-left"`,
	  `"top-right"`, `"bottom-left"`, or `"bottom-right"`.
	- **`"icons"` theme:** Zero text and zero `ffmpeg` subprocesses—converts status ring/glyph, battery +
	  charging bolt, curved Wi-Fi wave arcs colored by `RSSI` quality, temperature thermometer with tick
	  marks, and `last_seen` analog clock hands into vector icons inside a frosted-glass `44px`-high capsule.
	- **`"minimal"` theme:** Ultra-minimalist `92×36` frosted-glass capsule displaying three graduated
	  color-coded dots (`[Camera Status]  [Battery]  [Wi-Fi]`) using a 4-color scale (`Green`, `Blue`, `Yellow`, `Red`).
	- **`"none"` (`"blank"`) theme:** Hides the status overlay while honoring `card_background` (`"snapshot"`
	  dimmed frame, `"slate"`, or `"black"` pitch-black frame).
- **Low-latency stream & keyframe pipeline:** Zero-probe `ffmpeg` decoder startup (`nobuffer`, `low_delay`),
  event-driven frame pushing, `750 ms` viewer polling, and automatic keyframe bursts on viewer connect or
  state change for near-instant live view and motion recording.
- **Live camera telemetry & battery swap detection:** Queries `device.get_properties` (compatible with
  `eufy-security-ws` API schema `13`–`21`), polls periodically (`telemetry_poll_secs`), and issues
  `driver.poll_refresh` to detect physical battery swaps and charging state transitions while asleep.
- **Persistent frame cache & startup snapshot probe:** Stores high-quality `last_<name>_<serial>.jpg`
  snapshots in `/config/cache` (`cache_dir`) across restarts and automatically probes cameras missing an
  initial snapshot (`startup_snapshot`).
- **Optional hardware-accelerated encoding (`hwaccel`):** Supports `vaapi` (Intel/AMD iGPUs, including
  AMD RDNA 3.5 `gfx1150`/`gfx1151` via `alpine:3.23` Mesa `25.2+`), `qsv`, `nvenc`, and `v4l2m2m` with
  automatic fallback to software `libx264`.
- **Doorbell & HomeBase 3 intelligence:**
	- **Doorbell ring wakeup (`rings`):** Wakes video doorbells (`T8214`) immediately on button press and
	  files a `Frigate` event (`ring_label`, default `person`).
	- **HomeBase 3 face name forwarding (`forward_face_names`):** Extracts recognized face names from
	  `identity person detected` events and passes them as Frigate's `sub_label` and in the `Home Assistant`
	  webhook payload (`person`).
	- **Aspect-ratio safe Lanczos scaling (`preserve_aspect_ratio`):** Uses `flags=lanczos` and
	  `force_original_aspect_ratio=decrease` with centered dark padding so `4:3` or portrait dual-lens
	  doorbell streams (`T8214`) are sharp and never stretched (configurable globally or per camera).
- **Smart battery conservation:**
	- **Early sleep (`early_sleep_secs`):** Puts a motion-woken camera back to sleep early once at least
	  `min_dwell_secs` of video has been shown, Eufy motion has cleared, and `Frigate` reports no active
	  tracked detections.
	- **Low-Battery Economy Mode (`low_battery_threshold`):** When battery drops to or below `20%` (and is
	  not charging), automatically shortens motion hold duration (`low_battery_hold_secs`) and blocks
	  viewer-triggered wakeups (`low_battery_wake_on_view: false`).
	- **Auto-enforce streaming quality (`enforce_streaming_quality`):** Automatically switches cameras set
	  to `"Auto"` (`0`) to `Medium` (`7`, `1280×720`) so `P2P` streams do not negotiate `4K` and stall.
- **Cross-camera frame isolation & spontaneous wakeup protection:** Serializes `P2P` stop/start
  handovers on shared `HomeBase` stations, ignores simultaneous multi-camera dashboard grid views,
  handles mid-stream Eufy resolution changes without restarting the decoder, cancels earlier viewer
  queues when switching cameras, and suppresses mid-sleep card re-renders from triggering `Frigate`
  motion.
- **Minimal multi-stage container image:** Built on `Alpine Linux 3.23` with `tini` as `PID 1`, running
  as a non-root `node` user (`UID 1000`).

## Requirements

- `Frigate` `0.14+` (uses its built-in `go2rtc` and the `/api/events/.../create` API)
- `eufy-security-ws`, already logged in to your Eufy account and seeing the cameras
- `Docker` or `Podman`, on the same container network as `Frigate`

## Setup

**1. Config.** Copy `examples/config.example.minimal.json` (or `examples/config.example.full.json`) to
`config.json` and fill it in. Settings are grouped by function below:

### Core & Connection Settings

| Key | Required | Default | Meaning |
|---|---|---|---|
| `eufy_ws` | yes | — | `eufy-security-ws` `WebSocket` URL (e.g., `ws://eufy-security-ws:3000`) |
| `go2rtc_api` | yes | — | Frigate's `go2rtc` HTTP API URL, normally `http://frigate:1984` |
| `rtsp_publish` | yes | — | Where to publish each camera. `{name}` is replaced by the camera name. If Frigate's `go2rtc` has `rtsp.username/password` set, put them in the URL. |
| `cameras` | yes | — | Array of camera objects: `[{ "name", "serial", "title", "telemetry", "card_theme", "card_position", "card_background", "preserve_aspect_ratio", "startup_snapshot" }]`. `name` must match the `Frigate` camera name; `title` is shown on the status card. |
| `frigate_api` | no | — | Frigate's internal HTTP API (`http://frigate:5000`). Without it, no `Frigate` events are filed and early-sleep object checks are skipped. |
| `ha_webhook` | no | — | `Home Assistant` webhook URL (see below) |

### Stream Timing & Arbitration

| Key | Default | Meaning |
|---|---|---|
| `hold_secs` | `60` | Stay live this long (seconds) after the last Eufy motion report |
| `max_secs` | `900` | Hard cap (seconds) for one continuous live period |
| `view_linger_secs` | `20` | Stay live this long (seconds) after the last viewer leaves |
| `view_max_secs` | `300` | Hard cap (seconds) for a live period only viewers asked for |
| `min_dwell_secs` | `15` | Minimum live video (seconds) a motion-woken camera gets before newer motion on another camera can take over |
| `viewer_cooldown_secs` | `5` | Ignore single-camera viewers that connect this soon (seconds) after a camera finishes streaming |

### Events, Doorbell & HomeBase 3 Intelligence

| Key | Default | Meaning |
|---|---|---|
| `trigger_events` | `motion`, `person`, `pet`, `vehicle`, `dog`, `stranger`, `identity person`, `sound`, `rings` | Eufy event names (or shorthand aliases) that wake the camera and trigger a `Frigate` event |
| `event_secs` | `30` | Duration of the `Frigate` event in seconds |
| `snapshot_delay_secs` | `3` | Seconds of continuous decoded video required before the event is filed, so its snapshot isn't the `"Waking Up..."` card |
| `forward_face_names` | `true` | Forwards `HomeBase 3` recognized face names (`identity person detected`) as Frigate's `sub_label` and `Home Assistant` webhook `person` |
| `ring_label` | `"person"` | `Frigate` event label filed when a doorbell `rings` event occurs |

### Smart Battery Conservation

| Key | Default | Meaning |
|---|---|---|
| `early_sleep_secs` | `20` | Put a motion-woken camera to sleep early if motion has cleared and `Frigate` sees no active objects after this many seconds (`0` to disable) |
| `low_battery_threshold` | `20` | Battery `%` at or below which uncharged cameras enter Low-Battery Economy Mode (`0` to disable) |
| `low_battery_hold_secs` | `20` | Reduced motion hold duration in seconds while in Low-Battery Economy Mode |
| `low_battery_wake_on_view` | `false` | Allow live-view requests to wake a camera in Low-Battery Economy Mode |
| `enforce_streaming_quality` | `true` | `true` switches cameras set to `"Auto"` (`0`) to `Medium` (`7`, `1280×720`) so `P2P` streams do not negotiate `4K` and stall, or pass an explicit integer quality ID |

### Status Card Themes, Placement, Snapshot Cache & Telemetry

| Key | Default | Meaning |
|---|---|---|
| `card_theme` | `"default"` | `"default"` (text + icons), `"icons"` (vector icons only), `"minimal"` (three graduated status dots), or `"none"`/`"blank"` (no overlay; displays `card_background`). Can be overridden per camera. |
| `card_position` | `"center"` | Overlay placement for any theme: `"center"`, `"bottom-left"`, `"bottom-right"`, `"top-left"`, or `"top-right"`. Can be overridden per camera. |
| `card_background` | `"snapshot"` | Background behind the status card: `"snapshot"` (dimmed last frame), `"slate"` (solid dark gray), or `"black"` (pitch-black). Can be overridden per camera. |
| `telemetry` | `true` | `true`, `false`, or an object controlling which telemetry items are shown on the sleeping card (see below). Can be overridden per camera. |
| `telemetry_poll_secs` | `300` | Background telemetry poll interval in seconds to detect battery swaps and charging updates while sleeping (`0` to disable) |
| `cache_dir` | `"/config/cache"` | Directory for persisting last live snapshots (`last_<name>_<serial>.jpg`) across container restarts (falls back to `"/tmp"`) |
| `startup_snapshot` | `true` | `true` probes cameras once on startup if no cached frame exists, `"always"` forces a fresh probe on startup, `false` disables. Can be overridden per camera. |
| `font_file` | `"/usr/share/fonts/Inter.ttf"` | Custom `.ttf` font path for `"default"` theme overlay text |

### Video, Audio & Hardware Acceleration

| Key | Default | Meaning |
|---|---|---|
| `audio` | `true` | Passes the camera's audio through (`16 kHz` mono `AAC`) |
| `preserve_aspect_ratio` | `true` | Preserves native aspect ratio with dark padding instead of stretching non-`16:9` streams. Can be overridden per camera. |
| `hwaccel` | `false` | `false`, `"vaapi"`, `"qsv"`, `"nvenc"`, or `"v4l2m2m"` to offload continuous `H.264` encoding to GPU (falls back to `libx264` on error) |
| `hwaccel_device` | `"/dev/dri/renderD128"` | Render device path for `vaapi`/`qsv` |
| `width` | `1280` | Output stream width in pixels |
| `height` | `720` | Output stream height in pixels |
| `live_fps` | `10` | Output frame rate while the camera is live |
| `idle_fps` | `4` | Output frame rate while the camera is asleep |

**2. Frigate.** Each battery camera reads the stream the bridge publishes into Frigate's `go2rtc`.
Declare the stream in `go2rtc` **with no source**: `go2rtc` refuses to accept a published stream it
doesn't know (the bridge's encoder then exits and restarts every 3 s with `"Failed reading RTSP data:
End of file"`).

```yaml
go2rtc:
  streams:
    shed:        # empty on purpose: the bridge publishes into it
cameras:
  shed:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/shed
          input_args: preset-rtsp-restream
          roles: [record, detect]
      output_args:
        record: preset-record-generic-audio-copy   # or preset-record-generic without audio
    detect:
      width: 1280
      height: 720
      fps: 5
    record:
      continuous:
        days: 0          # keep only motion/alerts/detections, not hours of "camera asleep"
    live:
      streams:
        Main: shed
```

**3. Run it:** `docker compose -f examples/docker-compose.example.yml --project-directory . up -d --build`.
The log shows every wake, sleep, take-over, telemetry update, and event.

To build and publish to a local or remote container registry using the included `Makefile` (defaults to `Podman`):

```bash
# Syntax-check src/bridge.js and build image locally
make docker-build

# Build, tag, and push to a registry (default: publish locally with `latest` version when REGISTRY is omitted)
make publish [REGISTRY=<registry>] [BUILD_VERSION=<version>]

# Remove local build and publish tags
make clean
```

**4. Eufy camera settings.** By default (`"enforce_streaming_quality": true`), if a camera's streaming
quality is set to `"Auto"` (`0`), the bridge automatically sets `videoStreamingQuality` to **Medium
(`1280×720`, value `7`)** via `eufy-security-ws` so `P2P` sessions do not pick `4K` and stall. To force
`Medium` even when a camera was manually set to `High`/`4K`, set `"enforce_streaming_quality": 7`.

## Card themes, corner placement & 4-color semantic scale

To prevent `Frigate` from triggering false motion detections on a centered status overlay when a camera
switches between asleep and live, you can either place the card in any corner (`"card_position": "bottom-left"`)
and cover that corner with a `Frigate` motion mask, choose a compact icon-only (`"icons"`) or 3-dot
(`"minimal"`) theme, or hide the overlay (`"card_theme": "none"`):

| `card_theme` | Size (`1280×720`) | Description |
|---|---|---|
| `"default"` | `820×336` (`center`) or `540×88` (corner) | Frosted-glass panel with full text + vector icons (`Asleep`, `Waking Up...`, `Waiting`) |
| `"icons"` | `Up to 216×44` | Frosted-glass capsule with vector icons only: Status glyph, Battery + charging bolt, Curved Wi-Fi arcs colored by `RSSI`, Thermometer, and `Last live` analog clock (`HH:MM` hands) |
| `"minimal"` | `92×36` | Frosted-glass capsule with three graduated color-coded dots: `[Camera Status]  [Battery]  [Wi-Fi]` |
| `"none"` | Full frame | No overlay; displays `card_background` (`"snapshot"`, `"slate"`, or `"black"`) |

### Visual Previews

Here is how the **Icons Theme** (`card_theme: "icons"`) looks:

![Icons Theme Preview](examples/icons-theme-sample.jpeg)

Note: All samples are AI-generated

### 4-Color Semantic Scale (`Green`, `Blue`, `Yellow`, `Red`)

| Color | Dot 1 / Status Icon | Dot 2 / Battery Icon | Dot 3 / Wi-Fi & `RSSI` Arcs | Thermometer Icon (`icons` theme) |
|---|---|---|---|---|
| **Green** (`#4ade80`) | **Asleep** (Online & ready) | **Good** (`>= 50%`) | **Strong** (`4/4` bars or `>= -65 dBm`) | **Normal** (`6°C – 35°C`) |
| **Blue** (`#38bdf8`) | **Waking Up** (`P2P` connecting) | **Charging / Solar / Plugged** | **Good / Average** (`3/4` bars or `-66..-72 dBm`) | **Cold** (`<= 5°C`) |
| **Yellow** (`#facc15`) | **Waiting** (`HomeBase` busy) | **Medium** (`21% – 49%`) | **Fair / Weak** (`2/4` bars or `-73..-80 dBm`) | **Warm** (`36°C – 44°C`) |
| **Red** (`#f87171`) | **Low-Battery Economy Mode** | **Low / Critical** (`<= 20%` or `n/a`) | **Poor** (`0–1/4` bars, `< -80 dBm`, or `n/a`) | **Hot** (`>= 45°C`) |

### Frigate `motion.mask` Coordinates for Corner Placement (`1280×720`)

| `card_position` | `"default"` (`540×88`) | `"icons"` (`216×44`) | `"minimal"` (`92×36`) |
|---|---|---|---|
| `"top-left"` | `0.015,0.028,0.015,0.160,0.445,0.160,0.445,0.028` | `0.015,0.028,0.015,0.100,0.190,0.100,0.190,0.028` | `0.015,0.028,0.015,0.090,0.095,0.090,0.095,0.028` |
| `"top-right"` | `0.555,0.028,0.555,0.160,0.985,0.160,0.985,0.028` | `0.810,0.028,0.810,0.100,0.985,0.100,0.985,0.028` | `0.905,0.028,0.905,0.090,0.985,0.090,0.985,0.028` |
| `"bottom-left"` | `0.015,0.840,0.015,0.972,0.445,0.972,0.445,0.840` | `0.015,0.900,0.015,0.972,0.190,0.972,0.190,0.900` | `0.015,0.910,0.015,0.972,0.095,0.972,0.095,0.910` |
| `"bottom-right"` | `0.555,0.840,0.555,0.972,0.985,0.972,0.985,0.840` | `0.810,0.900,0.810,0.972,0.985,0.972,0.985,0.900` | `0.905,0.910,0.905,0.972,0.985,0.972,0.985,0.910` |

## Telemetry configuration (optional)

Telemetry on the sleeping overlay is **enabled by default** and requires no configuration changes.
You can disable it globally (`"telemetry": false`), customize which metrics are displayed globally,
or override settings per camera inside the `"cameras"` array:

```json
{
  "telemetry": {
    "enabled": true,
    "battery": true,
    "power_source": true,
    "wifi": true,
    "rssi": true,
    "temperature": true,
    "last_seen": true
  },
  "cameras": [
    {
      "name": "front_doorbell",
      "serial": "T8214...",
      "title": "Front Doorbell",
      "card_theme": "icons",
      "card_position": "bottom-left",
      "preserve_aspect_ratio": false,
      "telemetry": {
        "temperature": false
      }
    }
  ]
}
```

| Telemetry Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch for telemetry items (`default` and `icons` themes) |
| `battery` | `true` | Color-coded battery icon and charge percentage (`0–100%`) |
| `power_source` | `true` | Appends `Charging`, `Solar`, `Plugged`, or `Eco` status (or lightning bolt in `icons` theme) |
| `wifi` | `true` | Curved Wi-Fi signal strength indicator (`0–4`) |
| `rssi` | `true` | Displays Wi-Fi `RSSI` in `dBm` (and colors Wi-Fi arcs by `RSSI` quality) |
| `temperature` | `true` | Displays battery temperature in `°C` (or thermometer icon in `icons` theme) |
| `last_seen` | `true` | Displays `Last live HH:MM` (or analog clock with `HH:MM` hands in `icons` theme) |

## Home Assistant notifications (optional)

With `ha_webhook` set, the bridge `POST`s `JSON` twice per Eufy event:

1. **Right away:** `{"camera", "title", "label"}` (plus `"person"` when `HomeBase 3` recognizes a face).
   Good for a fast text alert.
2. **Once the Frigate event exists:** the same keys plus `event_id`, `review_id` and `no_video`
   (`true` if the camera never sent video, so the snapshot is a placeholder). Good for a follow-up
   with the snapshot (`/api/frigate/notifications/<event_id>/snapshot.jpg` via the `Frigate`
   integration) and a link to Frigate's `Review` page.

Trigger an automation with `platform: webhook` and use `trigger.json.event_id` to tell the two apart.

## Troubleshooting

- **Encoder exits every 3 s with `"Failed reading RTSP data: End of file"`:** the stream isn't declared
  in `go2rtc.streams` (step 2), or the `RTSP` user/password in `rtsp_publish` is wrong.
- **Nothing wakes on motion:** notifications must be on for the camera in the Eufy app, otherwise
  `eufy-security-ws` gets no motion events. Mute them on the phone instead of turning them off.
- **Stuck on `"Waking Up..."`, then `"no video for 5.5 s, asking eufy again"`:** check the camera's streaming
  quality (step 4), its battery and Wi-Fi signal, and that the Eufy app can open it live.
- **`"start_livestream failed"`:** `eufy-security-ws` lost its Eufy session or the `HomeBase` is busy with
  another `P2P` stream (the Eufy app counts too).
- **Inspecting Eufy device models, serials, and firmware versions:**
  ```bash
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

## Good to know

- **Battery.** Every wake costs battery, the same as opening the camera in the Eufy app. `early_sleep_secs`
  and Low-Battery Economy Mode (`low_battery_threshold`) help minimize unnecessary live streaming time.
- **Latency.** First video arrives about 3–4 s after the wake, so a quick walk-past may be half over.
  That's why the bridge files Eufy's own detection as a `Frigate` event.
- **Missed events are Eufy-side.** If Eufy's own detection doesn't fire, nothing wakes the camera.
- **Asleep ↔ live switches look like motion to Frigate,** and Frigate's Live dashboard auto-opens
  cameras with activity. The bridge ignores viewers that connect while a camera is already live or
  just went to sleep, ignores simultaneous multi-camera grid views, cancels earlier viewer queues when
  switching cameras, and supports corner placements, `icons`/`minimal` themes, or `none` mode so
  `Frigate` never triggers false detections on the sleeping overlay.
- **CPU.** Idle ~1–3% of one core. While a camera is live, ~15–25% with `hwaccel: "vaapi"` or ~35–65%
  with software `libx264`.
- **Test hook:** `docker kill -s USR2 eufy-frigate-battery-bridge` files a `"test"` event on the first
  camera without waking it.

## Tested with

- **This fork's setup:**
	- **Station:** Eufy **HomeBase 3 (S380)** (`T8030`, firmware `3.8.7.4`, hardware `V05`) with **Video Doorbell Dual Chime** (`T8023`, firmware `3.3.2.2m_0.1`, hardware `P0`)
	- **Cameras:** Eufy **Video Doorbell E340 Dual** (`T8214`, firmware `3.2.7.2`, hardware `P2`) and two **eufyCam S300 (eufyCam 3C)** cameras (`T8161`, firmware `3.4.3.0`, hardware `P1`)
	- **Environment:** `Podman` Quadlet, `AMD Radeon 8060S` (`gfx1151`, `VA-API` via `Mesa 25.2`), `Frigate 0.18`, `go2rtc`, and `eufy-security-ws` (API schema `21`)
- **Original repository setup:** `Frigate` `0.18.2`, `eufy-security-ws` `3.1.0` (`eufy-security-client` `4.1.0`,
  API schema `21`), two Eufy `T8162` battery cameras (firmware `3.1.5.8`) on a **HomeBase 3**.
- **Reported working by users (#1):** **eufyCam 2C** `T8140-Z` (firmware `4.1.4`, motion + live view wake) and
  **eufyCam 3** `T8160` (firmware `3.4.3.0`, motion + live view wake), both on a **HomeBase 3**.

Heads-up: `eufy-security-client` describes itself as a stopgap while Eufy moves to a new platform,
so upstream changes may break this.

## Notes

- Originally created by [ljlongwing](https://github.com/ljlongwing) with help from Claude (Anthropic).
- Fork enhancements were architected and developed by [obatiuk](https://github.com/obatiuk) in collaboration with Gemini Argon (Google), and tested on a live HomeBase 3 setup.

## License

[`MIT`](LICENSE)
