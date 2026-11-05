# Eufy Battery Camera Bridge for Frigate

> **Note:** This is an enhanced fork of [ljlongwing/eufy-frigate-battery-bridge](https://github.com/ljlongwing/eufy-frigate-battery-bridge) featuring `HomeBase` native `RTSP` streaming, `HomeBase 3` clip-replay backfill (`"backfill"` mode), automatic Eufy Power Manager configuration, automatic Frigate corner masks, customizable status cards, and GPU-accelerated encoding.

Use your Eufy battery cameras and video doorbells in **Frigate** without draining their batteries.

Frigate expects every camera to stream video 24/7, but Eufy battery cameras sleep to save power and only wake up when something happens. This bridge sits between `eufy-security-ws` and Frigate's `go2rtc` to give Frigate the continuous `RTSP` stream it needs while keeping your cameras asleep.

---

## How It Works

1. **While your camera is asleep:** The bridge shows a still image of the camera's last view with a small frosted-glass status card in the corner (showing battery level, Wi-Fi signal, temperature, and when it was last active).
2. **Automatic Frigate mask & zone configuration:** You never have to draw corner masks by hand in Frigate. On startup (and automatically whenever Frigate restarts), the bridge calculates the exact bounding box of each camera's corner status card and configures both a motion mask (`motion.mask.eufy_bridge_card`) and an object detection mask (`objects.mask.eufy_bridge_card`) via Frigate's API so status updates never trigger false motion or AI alerts.
3. **When motion, a person, or a doorbell ring happens:** The bridge either wakes the camera live or replays the recorded clip from your Eufy `HomeBase 3` into Frigate, and files an event in Frigate (including recognized face names from `HomeBase 3`).
4. **When you open Live View in Frigate:** The bridge wakes the camera on demand so you can watch live, then puts it back to sleep shortly after you close the view.
5. **Automatic Eufy Power Manager setup:** You don't need to dig through Eufy app menus to tune clip lengths—the bridge automatically configures each camera's Eufy Power Manager settings on startup based on your chosen camera `mode`.

---

## Choosing a `mode` for Each Camera

Each camera in your `config.json` can be set to one of five modes depending on how it connects to your Eufy `HomeBase`:

| Mode | Best For | How It Works | Default Recording Length |
| :--- | :--- | :--- | :--- |
| **`"auto"`** *(default when omitted)* | Automatic detection | Uses `"rtsp"` automatically on cameras that support `HomeBase` `RTSP`, or `"p2p"` (with automatic `HomeBase` clip replay fallback) on all others. | **`60` seconds** (full 60s clip) |
| **`"rtsp"`** | Cameras with **NAS / `RTSP` Stream** support (e.g. eufyCam 3 / S300 `T8161`, solar cameras) | Streams over `HomeBase` native `RTSP`. Multiple `RTSP` cameras can stream at the same time without blocking your doorbell. | **`60` seconds** (full 60s clip) |
| **`"backfill"`** | **Battery Doorbells** (e.g. Video Doorbell E340 `T8214`) & high-traffic hallways | **Best battery life & zero missed walk-bys.** Instead of waking a slow live `P2P` stream on motion, the doorbell records its short native clip (including pre-roll from the very start of motion) to `HomeBase 3` and goes right back to sleep. Seconds later, the bridge replays that recording from `HomeBase 3` into Frigate. Opening Live View in Frigate still wakes the doorbell live. | **`30` seconds** (stops early as soon as motion clears) |
| **`"p2p"`** | Battery cameras without `RTSP` when you prefer live streaming on motion | Wakes a live `P2P` stream on motion (and automatically falls back to `HomeBase` clip replay if another `P2P` camera is already streaming). | **`60` seconds** (full 60s clip) |
| **`"custom"`** | Advanced per-camera tuning | Lets you override individual stream, timer, and Eufy Power Manager settings while automatically validating and fixing any contradictory values. | **`60` seconds** (unless overridden) |

---

## Quick Start (3 Steps)

### Requirements (Minimum Versions)

Before starting, make sure your setup meets these minimum versions so all features (automatic Frigate corner masks, Eufy Power Manager sync, and `HomeBase 3` clip replay) work properly:

| Component | Minimum Version | Tested Version | Why It Is Needed |
| :--- | :--- | :--- | :--- |
| **Frigate** | **`>= 0.16.0`** | `0.18.x` | Required for live config updates (`PUT /api/config/set`), named polygon corner masks (`motion.mask.eufy_bridge_card` & `objects.mask.eufy_bridge_card`), `sub_label` face names, and `review` events. |
| **`eufy-security-ws`** | **`>= 2.0.0`** (API schema `>= 20`) | `3.1.0+` (schema `21`) | Required for `HomeBase 3` clip queries (`station.database_query_latest_info` / `database_query_by_date`), `device.start_download`, and Power Manager property sync (`device.set_property`). |
| **Docker / Podman** | **Docker `>= 24.0`** or **Podman `>= 4.5`** | Podman `5.x` | Required to build and run the container image (`examples/docker-compose.example.yml`). |
| **Eufy HomeBase** | **`HomeBase 3` (`T8030`) fw `>= 3.5.x`** *(for `"backfill"`)* | `3.8.7.4` | Required for `"backfill"` clip replay and `HomeBase 3` facial recognition (`identity person detected`). `HomeBase 2` and standalone Wi-Fi cameras are supported in `"rtsp"` and `"p2p"` modes. |
| **Eufy Account** | Dedicated secondary account | — | Share your cameras from your main Eufy account to a second Eufy account for `eufy-security-ws`, and keep **push notifications turned ON** in the Eufy app on that account. |

### Step 1: Create `config.json`

Copy [`examples/docker-compose.example.yml`](examples/docker-compose.example.yml) and create a `config.json` next to it (see [`examples/config.example.minimal.json`](examples/config.example.minimal.json)):

```json
{
	"eufy_ws": "ws://eufy-security-ws:3000",
	"go2rtc_api": "http://frigate:1984",
	"rtsp_publish": "rtsp://frigate:8554/{name}",
	"frigate_api": "http://frigate:5000",
	"hwaccel": "vaapi",
	"card_theme": "minimal",
	"cameras": [
		{
			"serial": "T8161T0000000000",
			"title": "Storage Room Camera",
			"mode": "rtsp",
			"priority": 50
		},
		{
			"serial": "T8161T1111111111",
			"title": "Garage Camera",
			"mode": "rtsp",
			"priority": 50
		},
		{
			"serial": "T8214T2222222222",
			"title": "Front Doorbell",
			"mode": "backfill",
			"priority": 100
		}
	]
}
```

> [!TIP]
> If you omit `"name"` on a camera, the bridge uses its `"serial"` as the Frigate stream name (for example, `T8161T0000000000`). If you prefer shorter names in Frigate (like `"garage"`), add `"name": "garage"` to the camera entry.

### Step 2: Add the Cameras to Frigate (`config.yml`)

In Frigate's `config.yml`, declare each camera under `go2rtc.streams` **with an empty value** (the bridge publishes the stream into `go2rtc`), then add the camera under `cameras`:

```yaml
go2rtc:
  streams:
    T8161T1111111111: # leave empty — the bridge publishes into this stream
    T8214T2222222222:

cameras:
  T8161T1111111111:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/T8161T1111111111
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
        Main: T8161T1111111111
```

### Step 3: Start the Bridge

```bash
docker compose -f examples/docker-compose.example.yml --project-directory . up -d --build
```

---

## Status Card & Sleeping Screen Styles

You can customize the status indicator and what Frigate shows while a camera is asleep using `card_theme`, `card_position`, and `sleep_screen`:

| `card_theme` | What It Shows |
| :--- | :--- |
| **`"icons"`** *(default)* | Compact frosted-glass pill with vector icons: **Status**, **Battery** (with charging bolt), **Wi-Fi signal**, **Temperature**, and **Last active time** (analog clock). |
| **`"minimal"`** | Tiny pill with three color-coded dots: **`[Camera Status]  [Battery]  [Wi-Fi]`**. |
| **`"detailed"`** | Larger panel with full text labels (`Asleep`, `Waking Up...`, `Waiting`) + telemetry icons. |
| **`"none"`** | Hides the status card completely and shows only the sleeping screen configured by `sleep_screen`. |

| `sleep_screen` | What Frigate Shows Behind the Card While Asleep |
| :--- | :--- |
| **`"snapshot"`** *(default)* | The last clean `JPEG` frame captured from the camera (saved across restarts in `/config/cache`). |
| **`"slate"`** | A solid dark-slate gray screen (`#222222`). |
| **`"black"`** | A solid black screen (`#101010`). |

### What the Status Colors Mean

| Color | Status Icon / Dot 1 | Battery Icon / Dot 2 | Wi-Fi Icon / Dot 3 | Temperature (`icons` / `detailed`) |
| :--- | :--- | :--- | :--- | :--- |
| **Red** | **Live** (play icon) or **Clip Replay** (rewind icon / bullseye dot) | - | - | - |
| **Grey** | **Asleep** (Standby & ready) | - | - | - |
| **Green** | - | **Good** (`50% - 100%`) | **Strong** | **Normal** (`6°C - 35°C`) |
| **Blue** | **Waking Up** (Connecting) | **Charging / Solar** | **Good** | **Cold** (`<= 5°C`) |
| **Yellow** | **Waiting** (`HomeBase` busy) | **Medium** (`21% - 49%`) | **Fair** | **Warm** (`36°C - 44°C`) |
| **Purple** | **Low-Battery Saver** (`<= 20%`) | **Low** (`<= 20%`) | **Weak** | **Hot** (`>= 45°C`) |

---

## Configuration Reference

### Main Settings (`config.json`)

| Key | Required | Default | Meaning |
| :--- | :---: | :---: | :--- |
| `eufy_ws` | **Yes** | — | `WebSocket` URL of your `eufy-security-ws` container (`ws://eufy-security-ws:3000`) |
| `go2rtc_api` | **Yes** | — | Frigate's `go2rtc` HTTP API URL (`http://frigate:1984`) |
| `rtsp_publish` | **Yes** | — | `RTSP` URL template where streams are published (`rtsp://frigate:8554/{name}`) |
| `frigate_api` | No | — | Frigate's HTTP API (`http://frigate:5000`) for creating events and automatic corner masks |
| `cameras` | **Yes** | — | List of cameras (see table below) |
| `card_theme` | No | `"icons"` | `"icons"`, `"minimal"` (3 dots), `"detailed"` (text + icons), or `"none"` |
| `card_position` | No | `"top-left"` | `"top-left"`, `"bottom-left"`, `"top-right"`, `"bottom-right"`, or `"center"` |
| `sleep_screen` | No | `"snapshot"` | `"snapshot"` (last camera frame), `"slate"` (dark gray), or `"black"` |
| `audio` | No | `true` | Enable audio passthrough (`true` or `false`) |
| `hwaccel` | No | `false` | GPU encoding: `false`, `"vaapi"` (Intel/AMD), `"qsv"`, `"nvenc"` (NVIDIA), or `"v4l2m2m"` |
| `ha_webhook` | No | — | Optional Home Assistant webhook URL for instant event & snapshot notifications |
| `log_level` | No | `"info"` | `"info"`, `"debug"`, `"warn"`, or `"error"` |

### Per-Camera Settings (`cameras[]`)

| Key | Required | Default | Meaning |
| :--- | :---: | :---: | :--- |
| `serial` | **Yes** | — | Camera serial number from the Eufy app (e.g. `T8161...`, `T8214...`) |
| `name` | No | `serial` | Camera name in Frigate (defaults to `serial` when omitted) |
| `title` | No | Eufy name | Friendly display name for logs, notifications, and the `"detailed"` card theme |
| `mode` | No | `"auto"` | `"rtsp"`, `"backfill"`, `"p2p"`, `"custom"`, or `"auto"` |
| `hold_secs` | No | `60` (`30` in `backfill`) | Recording & event duration in seconds (automatically syncs to the Eufy camera, the bridge, and Frigate) |
| `end_early` | No | `false` (`true` in `backfill`) | Stop recording early as soon as motion clears (`true` or `false`) |
| `priority` | No | `0` | Priority when two `P2P` cameras trigger at the same time (higher number wins) |

*(You can also override `card_theme`, `card_position`, `sleep_screen`, `telemetry`, `trigger_events`, `backfill_downloads`, `low_battery_threshold`, or `low_battery_wake_on_view` on individual cameras.)*

<details>
<summary><strong>Advanced Settings (Frame Rates, Snapshots, Session Limits & Custom Mode)</strong></summary>

Most setups never need to change these, as the defaults are tuned for Eufy battery cameras and Frigate.

#### How Frame Rates (`idle_fps` & `live_fps`) Work

- **Streams (`idle_fps: 5` while asleep → `live_fps: 15` when active):**
  - While a camera is **asleep**, the bridge sends `5` static frames per second (`idle_fps`) to `go2rtc`. Because consecutive frames are identical while asleep, `H.264` video compression encodes them as tiny skip-frames (`~20–40 kbps`) with minimal CPU/GPU usage while keeping Frigate's `RTSP` connection alive and ready.
  - The instant a camera **wakes up** or **replays a `HomeBase 3` clip**, the bridge switches to `15` frames per second (`live_fps`) to match Eufy's native `15 fps` camera framerate (and paces bursty `HomeBase 3` clip downloads at `15 fps` real-time speed).
- **Detection (Zero AI load while asleep):**
  - Matching Frigate's `detect.fps: 5` to `idle_fps: 5` ensures Frigate never logs dropped-frame warnings while asleep. Because the sleeping snapshot is completely still and the corner status card is automatically masked (`motion.mask.eufy_bridge_card` and `objects.mask.eufy_bridge_card`), Frigate performs **zero** object-detection passes while the camera is asleep. During a `15 fps` live/backfill event, Frigate samples `5 fps` for AI object detection.
- **Storage (Zero disk usage while asleep):**
  - With `record.continuous.days: 0` in Frigate's `config.yml`, Frigate discards sleeping `5 fps` frames in memory and uses **0 MB of disk storage** while cameras are asleep. Disk space is only used during active motion or doorbell events (recorded at `15 fps`).

#### How Snapshots Work

- **Saved automatically during streams (`/config/cache`):** Whenever a camera streams live video or replays a clip, the bridge saves a clean `JPEG` snapshot (without the corner status card) to `/config/cache/last_<name>_<serial>.jpg` and uses it as the sleeping backdrop (`sleep_screen: "snapshot"`).
- **Startup behavior (`startup_snapshot: true`):** The bridge **only** wakes a camera on startup if there is **no cached `JPEG` on disk yet** for that camera (for example, the very first time you add a new camera—it wakes for `2` seconds to grab an initial picture and goes right back to sleep). On all subsequent container restarts, it loads the cached `JPEG` from `/config/cache` immediately without waking the camera. (Set `"startup_snapshot": false` to never wake even on first boot, or `"startup_snapshot": "always"` to force a fresh snapshot on every restart.)
- **Clean Frigate event thumbnails (`instant_event_snapshot: true`):** On motion or doorbell events, the bridge waits for `1` second of real video before filing the Frigate event so the event thumbnail is live video. If a camera ever times out without sending video, the bridge temporarily shows the clean cached snapshot (without the `"Waking Up..."` card) so Frigate never saves the `"Waking Up..."` overlay as an event thumbnail.

#### Global Advanced Settings (`config.json`)

| Key | Default | Valid Range / Values | Meaning |
| :--- | :---: | :---: | :--- |
| `live_fps` | `15` | `5 – 60` | Output frame rate while a camera is actively streaming or replaying a clip |
| `idle_fps` | `5` | `1 – 30` (`<= live_fps`) | Output frame rate while a camera is asleep (match Frigate's `detect.fps`) |
| `width` / `height` | `1280` / `720` | `320 – 3840` / `240 – 2160` | Output `RTSP` stream resolution (even integers) |
| `preserve_aspect_ratio` | `true` | `true` or `false` | Preserve native camera aspect ratio (e.g. `4:3` / portrait doorbells) with dark pillarbox bars |
| `card_show_on_live` | `true` | `true` or `false` | Keep the corner status card visible (`Red` live/backfill indicator) during active streams |
| `auto_frigate_mask` | `true` | `true` or `false` | Automatically sync the corner status card polygon to Frigate's `motion.mask` & `objects.mask` |
| `startup_snapshot` | `true` | `true`, `false`, `"always"` | Briefly wake cameras on first startup if no cached snapshot exists in `/config/cache` |
| `instant_event_snapshot` | `true` | `true` or `false` | File Frigate events after `1s` of live video and inject a clean cached snapshot if a wake times out |
| `snapshot_delay_secs` | `3` | `0 – 60` | Maximum seconds of live video to wait before filing a Frigate event when `instant_event_snapshot` is `false` |
| `cache_dir` | `/config/cache` | Directory path | Directory for persistent clean `JPEG` camera snapshots across restarts |
| `max_secs` | `900` | `>= hold_secs` | Maximum continuous live session duration (`15` minutes) when motion keeps re-triggering |
| `early_sleep_secs` | `0` | `0 – 3600` (`0` disables) | Optional battery saver: close motion streams early once Frigate confirms `0` active objects for `N` seconds |
| `view_linger_secs` | `20` | `5 – 86400` | How long to stay live after you close Frigate Live View |
| `view_max_secs` | `300` | `>= view_linger_secs` | Maximum duration for a manual Live View session (`5` minutes) |
| `viewer_cooldown_secs` | `5` | `0 – 3600` | Cooldown after a camera goes to sleep before a new viewer connection can re-wake it |
| `preempt_event_streams` | `true` | `true` or `false` | Allow a newer or higher-priority motion event to preempt an active `P2P` stream on the same station |
| `backfill_downloads` | `true` | `true` or `false` | Replay recorded clips from `HomeBase 3` when a `P2P` stream is busy or in `"backfill"` mode (`false` to disable on `HomeBase 2`) |
| `backfill_delay_secs` | `5` | `2 – 120` | Idle settle delay on the station `P2P` slot before querying/downloading a `HomeBase 3` backfill clip |
| `sync_power` | `true` | `true` or `false` | Automatically sync Eufy Power Manager settings on startup (`false` to manage Power Manager manually in the Eufy app) |
| `enforce_streaming_quality` | `true` | `true`, `false`, or `1 – 10` | Switch `P2P` quality from `"Auto"` (`0`) to `7` (`1280x720`) so `P2P` never stalls at `4K` |
| `low_battery_threshold` | `20` | `0 – 100` (`0` disables) | Battery `%` at or below which uncharged cameras enter Low-Battery Economy Mode |
| `low_battery_hold_secs` | `20` | `5 – 3600` (`<= hold_secs`) | Reduced live hold duration when a camera is in Low-Battery Economy Mode |
| `low_battery_wake_on_view` | `false` | `true` or `false` | Allow manual Frigate Live View to wake a camera while in Low-Battery Economy Mode |
| `telemetry` | `true` | `true`, `false`, or object | Show or hide specific status card items (`{"battery": true, "power_source": true, "wifi": true, "rssi": true, "temperature": true, "last_seen": true}`) |
| `telemetry_poll_secs` | `300` | `0` or `30 – 86400` | How often to refresh battery, Wi-Fi, and temperature while sleeping |
| `forward_face_names` | `true` | `true` or `false` | Forward recognized person names from `HomeBase 3` (`identity person detected`) to Frigate `sub_label` and Home Assistant |
| `ring_label` | `"person"` | String | Frigate event label used when a doorbell ring event triggers |
| `trigger_events` | All motion/AI/ring | Array of strings | Event types that wake/backfill cameras (`["motion", "person", "identity person", "stranger", "pet", "dog", "vehicle", "sound", "crying", "ring"]`) |
| `event_priorities` | Built-in tiers | Object (`{event: score}`) | Priority boost per event type (`ring: 1000`, `identity person: 300`, `person: 200`, `vehicle/pet/dog: 100`, `crying/sound: 50`, `motion: 10`) |
| `http_port` | `8080` | `0 – 65535` (`0` disables) | Port for `/healthz` and `/api/wake/:cameras` |
| `hwaccel_device` | `/dev/dri/renderD128` | Path | GPU device path for `"vaapi"` / `"qsv"` hardware encoding |

#### Per-Camera `"mode": "custom"` & Advanced Overrides (`cameras[]`)

In addition to overriding `card_theme`, `card_position`, `sleep_screen`, `card_show_on_live`, `auto_frigate_mask`, `preserve_aspect_ratio`, `startup_snapshot`, or `telemetry` on any camera, `"mode": "custom"` exposes full per-camera stream, battery, event, and hardware Power Manager overrides:

| Key | Default in `"custom"` | Meaning |
| :--- | :---: | :--- |
| `use_rtsp` | Global `use_rtsp` (`true`) | Use `HomeBase` native `RTSP` (`true`) or `P2P` (`false`) |
| `rtsp_url` | Auto-discovered | Explicit `RTSP` stream URL override (`rtsp://...`) if not auto-discovered from `eufy-security-ws` |
| `station_serial` | Auto-discovered | Explicit `HomeBase` station serial number (`T8030...`) for multi-station `P2P` arbitration |
| `always_backfill` | `false` | Use clip-replay backfill mode (`true` or `false`) |
| `backfill_downloads` | Global `backfill_downloads` (`true`) | Enable or disable `HomeBase 3` clip backfill for this camera (`true` or `false`) |
| `trigger_events` | Global `trigger_events` | Per-camera list of Eufy event types that trigger this camera (e.g. `["person", "ring"]`) |
| `max_secs` | Global `max_secs` (`900`) | Per-camera maximum continuous live session duration (`>= hold_secs`) |
| `event_secs` | `hold_secs` (`60`) | Per-camera Frigate event duration in seconds (independent of `hold_secs`) |
| `early_sleep_secs` | Global `early_sleep_secs` (`0`) | Per-camera early-sleep idle threshold in seconds |
| `view_linger_secs` | Global `view_linger_secs` (`20`) | Per-camera linger duration after closing Frigate Live View |
| `view_max_secs` | Global `view_max_secs` (`300`) | Per-camera maximum duration for a manual Live View session (`>= view_linger_secs`) |
| `low_battery_threshold` | Global `low_battery_threshold` (`20`) | Per-camera battery `%` threshold for Low-Battery Economy Mode (`0` disables) |
| `low_battery_hold_secs` | Global `low_battery_hold_secs` (`20`) | Per-camera live hold duration while in Low-Battery Economy Mode (`<= hold_secs`) |
| `low_battery_wake_on_view` | Global `low_battery_wake_on_view` (`false`) | Allow manual Frigate Live View to wake this camera while in Low-Battery Economy Mode |
| `sync_power` | Global `sync_power` (`true`) | Automatically sync Power Manager settings to this camera (`false` to leave hardware untouched) |
| `power_working_mode` | `2` (`Customize Recording`) | Eufy Power Manager mode (`0` Optimal Battery, `1` Optimal Surveillance, `2` Customize Recording) |
| `recording_clip_length` | `hold_secs` (`5 – 120`) | Eufy hardware clip length in seconds (`device.set_property` `recordingClipLength`) |
| `recording_end_early` | `end_early` (`false`) | Eufy hardware `recordingEndClipMotionStops` setting (`true` or `false`) |
| `recording_retrigger_interval` | `5` (`0 – 60`) | Eufy hardware `recordingRetriggerInterval` in seconds |
| `enforce_streaming_quality` | Global `enforce_streaming_quality` (`true`) | Switch `P2P` streaming quality from `"Auto"` (`0`) to `7` (`1280x720`) so `P2P` never stalls at `4K` |

#### Automatic Defensive Validation (No Contradictory Configs)

Even in `"mode": "custom"`, the bridge validates all settings on startup and logs a clear warning while automatically resolving any contradiction:
- **`idle_fps > live_fps`:** Clamps `idle_fps` down to `live_fps` so the sleeping stream never encodes at a higher frame rate than live video.
- **`use_rtsp: true` + `always_backfill: true`:** Disables `use_rtsp` because `HomeBase` clip backfill only applies to `P2P` / doorbell recordings.
- **`max_secs < hold_secs` or `low_battery_hold_secs > hold_secs`:** Raises `max_secs` to at least `hold_secs` and caps `low_battery_hold_secs` at `hold_secs`.
- **`recording_clip_length < hold_secs` when `end_early: false`:** Raises `recording_clip_length` to match `hold_secs` (up to `120s`) so the Eufy camera hardware does not cut off the stream before the bridge's `hold_secs` finishes.
- **`power_working_mode: 0` or `1` with conflicting hold/clip settings:** Automatically promotes `power_working_mode` to `2` (`Customize Recording`) whenever custom clip properties are specified or when `power_working_mode: 0` (`Optimal Battery Life`, which hardcodes `20s` early-ending clips on Eufy firmware) conflicts with `hold_secs > 20` or `end_early: false`.
- **`backfill_downloads: false` in `"backfill"` mode:** Keeps `backfill_downloads: true` on any `"mode": "backfill"` camera so doorbell/clip-replay events are never silently dropped.

</details>

---

## Optional Integrations

### Waking Cameras from Home Assistant or Scripts (`/api/wake`)

If you have external motion sensors, door sensors, or automations in Home Assistant, you can pre-wake one or more cameras (or all of them) with a simple HTTP request to port `8080`:

```bash
# Wake a specific camera (by name, serial, or title) for 30 seconds
curl -X POST "http://127.0.0.1:8080/api/wake/front_doorbell" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Front porch sensor", "duration": 30}'

# Wake all cameras for 30 seconds
curl -X POST "http://127.0.0.1:8080/api/wake/all" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Perimeter check", "duration": 30}'
```

### Home Assistant Webhook Notifications (`ha_webhook`)

When `ha_webhook` is set, the bridge sends two `POST` payloads to Home Assistant for every event:
1. **Immediately when triggered:** `{"camera", "title", "label", "person"}` (for an instant text notification, including the recognized face name when `HomeBase 3` identifies someone).
2. **Once the Frigate event is ready:** The same fields plus `event_id` and `review_id` so you can attach the Frigate event snapshot image.

---

## Troubleshooting & FAQ

- **Nothing happens when I walk in front of a camera:**
  Make sure **push notifications are turned ON** for that camera in the Eufy app on the account used by `eufy-security-ws`. Eufy only sends motion events when notifications are enabled (you can mute notifications in your phone's OS settings instead).
- **The logs say `"Failed reading RTSP data: End of file"` every 3 seconds:**
  Make sure the camera's `name` (or `serial`) is listed under `go2rtc.streams:` in Frigate's `config.yml`, and that the `rtsp_publish` URL matches your Frigate address.
- **My `"rtsp"` camera doesn't connect over `RTSP`:**
  In the Eufy app, open **Camera Settings → Storage → NAS (`RTSP`)** once to enable the `RTSP` toggle on `HomeBase 3`. After that, the bridge wakes and manages the `RTSP` stream automatically.
- **How do I check if the bridge is healthy?**
  Run `curl http://127.0.0.1:8080/healthz` — it returns `"ok": true` and `"ws_connected": true` when connected to `eufy-security-ws`.

---

## Credits & License

- Originally created by [ljlongwing](https://github.com/ljlongwing) ([ljlongwing/eufy-frigate-battery-bridge](https://github.com/ljlongwing/eufy-frigate-battery-bridge)) with help from Claude (Anthropic).
- Enhanced and maintained by [obatiuk](https://github.com/obatiuk) in collaboration with Gemini (Google), tested on Eufy **HomeBase 3 (S380)** (`T8030`), **Video Doorbell E340 Dual** (`T8214`), and **eufyCam S300 (3C)** (`T8161`).
- [MIT License](LICENSE). For architecture details, domain models, debugging scripts, and developer documentation, see [`AGENTS.md`](AGENTS.md).
