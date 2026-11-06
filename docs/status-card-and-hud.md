# Status card themes, mask sync, and debug HUD

Read when: changing `src/domain/status-card.js`, `src/overlay/*`, Frigate mask sync, or the `debug` theme.
Related: [ACCEPTANCE.md](ACCEPTANCE.md) (`AT-17`, `AT-18`).

## Status Card Themes & Overlay Pipeline (`src/domain/status-card.js` & `src/overlay/*`)

- `card_theme`:
  - `"icons"` (default): Pre-baked 4x4-supersampled Eufy-style alpha sprites (`22px` slot height, bolder strokes, and
    `1px` directional drop-shadow) inside a `44px`-high frosted-glass capsule (`64%` opacity with a uniform `1.25px`
    SDF-anti-aliased frosted rim at `18%` opacity) with zero text and no `ffmpeg` spawn (Status glyph with Play, Rewind,
    Waking arc-ring, Disconnected circle-slash, or Standby pill bars; rounded `38x18` Battery + Solar sun / AC plug /
    USB charging bolt; rounded-cap `30x22` Wi-Fi arcs colored by `RSSI`; `18x22` Thermometer with graduation ticks; and
    hollow-ring `22x22` `Last live` clock with cached `HH:MM` hands).
  - `"minimal"`: Three equal `18x18` halo-free shadowed circles (`Status` solid circle or hollow circular ring for
    `Backfill`, `Battery`, and `Wi-Fi` - never icons or text) inside a `110x44` frosted-glass capsule (`22px` corner
    radius, `64%` opacity, and uniform `1.25px` frosted rim shared identically with `"icons"` and `"detailed"`) with no
    `ffmpeg` spawn.
  - `"detailed"`: Shared frosted-glass surface (`22px` corner radius, `64%` opacity, and uniform `1.25px` frosted rim)
    rendered purely in JavaScript via the pre-baked proportional anti-aliased UI glyph atlas (`20px`, `24px`, `36px` in
    `src/overlay/ui-glyphs.js`) and bolder shadowed Eufy icon sprites with zero external font files and no `ffmpeg`
    spawn. Renders a centered `820x336` modal (`820x268` when telemetry is disabled or empty) with a `60x60` status
    glyph when `card_position` is `"center"`, or a compact corner card (`540x88` minimum with telemetry or `400x48`
    without, expanding dynamically up to `W - 48` for long titles) that blurs live video via the 2-slot alternating
    `liveOverlayBufs` scratch ring (`prepareLiveOverlayBuffer`).
  - `"debug"`: Sharp rectangular (`radius: 0`, `borderOpacity: 0`, `74%` blurred background) bottom-anchored diagnostic
    HUD (`832x76`, `<= 2/3` of the `1280px` frame width; anchored bottom-right for `*-right` positions, else
    bottom-left) with a left semantic status square (`S`/`FB`/`B`/`L` frame stage glyph + right-padded camera mode +
    session counter) and 4 vertically aligned multi-column (`110`-char) non-shifting bright-white monospace telemetry
    rows (`5x9` pixel bitmap font with 1px luma shadow, zero `ffmpeg` spawn) updated dynamically on both sleeping and
    live frames (`hasDynamicDebugCard()`, regardless of `card_show_on_live`).
  - `"none"`: Hides the status overlay while honoring `sleep_screen` (`"snapshot"`, `"slate"`, or `"black"`).
- `card_position`: `"bottom-left"` (default), `"top-left"`, `"bottom-right"`, `"top-right"`, or `"center"`.
- `sleep_screen`: `"snapshot"` (default, last camera frame from `/config/cache`), `"slate"` (solid `#222222`), or
  `"black"` (solid `#101010`).
- `card_show_on_live` (`true` by default): Composites corner status cards onto live/backfill video frames via the 2-slot
  alternating `liveOverlayBufs` scratch ring (`prepareLiveOverlayBuffer`) using `Red` status indicators (Eufy
  play/rewind glyphs in `"icons"` and `"detailed"`, or a solid circle / hollow circle ring in `"minimal"`), while
  keeping `cam.lastFrame` and `/config/cache` snapshots clean (`"debug"` always renders on live frames unless
  `suppressLiveCard` is active).
- `auto_frigate_mask` (`true` by default): Computes the normalized polygon bounding box for each camera's corner status
  card (with a `6px` chroma/anti-aliasing safety margin) and syncs both `motion.mask.eufy_bridge_card` and
  `objects.mask.eufy_bridge_card` into Frigate via `GET /api/config` and `PUT /api/config/set` (`requires_restart: 0`)
  on startup, every 60s, and after Frigate restarts.

## Troubleshooting & Visual Diagnostics (`card_theme: "debug"`)

Setting `"card_theme": "debug"` (globally or per camera) renders a bottom-anchored diagnostic HUD (`832x76`) over both
sleeping and live frames so you can visually inspect every state transition, frame stage, hardware property, and
backfill clip directly inside Frigate Live View or recorded clips:

```text
+------+---------------------------------------------------------------------------------------------------------------+
| [B]  | ST:BF_HSHK -> BF_PLAY  +004s | DEC:DECODE | BF:PLAYING | FPS:15/15 | WS:OK HB:OK FRG:OK RTC:OK | DROP:0 RST:0  |
|      | LIGHT:OFF     | BAT:084% BAT | WIFI:4/4 -062dBm IDLE:0 | TMP:23C   | HW:M2/030s/EE:Y/Q7/RTSP:N | SEEN:14:32    |
| BF   | SES:BF   R:00 | HOLD:026s    | IDLE:---   | VID:0.1s   | VW:0/0    | TRIG:CLEAR  008s  Q:00/28 | STOP:N        |
| #04  | EV:RECORD 026s/4f8a1c        | BFQ:---  TRY:2/10 Q:0   | CONT:N    | CLIP:0060/0450f           | INIT:backfill |
+------+---------------------------------------------------------------------------------------------------------------+
```

### Left Status Column (Frame Stage Square, Camera Mode & Session Counter)

- **Top Colored Square (`[S]` / `[FB]` / `[B]` / `[L]`):**
  - `[S]` (**Snapshot / Sleeping / Waking Frame**): Shown whenever the encoder is outputting the cached sleeping
    snapshot (while idle, waiting, or waking before `gotVideo` is set on the session). The square background color
    reflects the current non-live status: **Green** (`Asleep`, standby & ready), **Grey** (`Disconnected` when
    `eufy-security-ws`, `HomeBase`/camera, `Frigate`, or `go2rtc` is down/unavailable), **Blue** (`Waking Up...`),
    **Yellow** (`Waiting` for station slot or `BackfillJob`), or **Purple** (`Asleep (Low Battery)`).
  - `[FB]` (**First Backfill Frame `0`**, **Yellow** background with dark block letters): Shown on the very first
    decoded frame (`Frame 0`, while `downloadPlayedFrames <= 1`) of a newly started `.zxvideo` backfill download so you
    can visually pinpoint the exact `t=0` start frame of the clip.
  - `[B]` (**Backfill Video Frames `1..N`**, **Red** background with white block letter): Shown on all subsequent
    frames (`downloadPlayedFrames > 1`) of a `.zxvideo` backfill playback (and held continuously across back-to-back
    continuation handshakes when `CONT:Y` is active so the badge never flashes back to `S` or `FB` between split clips).
  - `[L]` (**Live Stream Video Frames**, **Red** background with white block letter): Shown once live `RTSP` or `P2P`
    video is active (`gotVideo === true`).
- **Middle Tag (`BF` / `RTSP` / `P2P` / `AUTO` / `CUST`):** Configured camera operating mode (`mode`).
- **Bottom Tag (`#00`-`#99`):** Monotonic session counter (`sessionId` clamped at `99`) incremented on each session
  start (wake or backfill download).

### What Each Row Displays (for Instant Visual Verification & Future Debugging)

1. **Row 1 - FSM States, Transitions, Frame Pacing & Service Health:**
   - `ST:<prev>-><curr>+<age>`: Previous -> current session state (`IDLE`, `WK_RTSP`, `WK_P2P`, `LIVE`, `BF_HSHK`,
     `BF_PLAY`, `BF_TAIL`, `COOLDWN`) and exact seconds in the current state.
   - `DEC:<state>`: Decoder FSM state (`DETACH`, `HSHK`, `DECODE`, `PAUSED`, `FLUSH`).
   - `BF:<state>`: Backfill FSM state (`IDLE`, `ACTIVE`, `WAIT_Q`, `QUERY`, `MATCH`, `PLAYING`, `DONE`, `EXPIRED`).
   - `FPS:<measured>/<target>`: Real-time measured output FPS over a rolling `1s` window vs target FPS (`05` idle / `15`
     live).
   - `WS:<OK|DN> HB:<OK|DN> FRG:<OK|DN> RTC:<OK|DN>`: Real-time connectivity indicators for `eufy-security-ws` (`WS`),
     `HomeBase`/camera (`HB`), `Frigate` (`FRG`), and `go2rtc` (`RTC`).
   - `DROP:0 RST:<n>`: Frame-drop counter slot (`0`) and mid-session restart count (`0-9`).
2. **Row 2 - Spotlight (`light`), Battery, Radio/Idle RSSI Drain Detector & Synced Hardware Settings:**
   - `LIGHT:ON` / `LIGHT:OFF`: Real-time camera spotlight (`light`) state.
   - `BAT:<pct>% <src>`: Battery percentage (`000%-100%`, or `---%` before telemetry) and power status (`CHG` when
     charging/solar/plugged, `LOW` in low-battery saver, or `BAT`).
   - `WIFI:<bars>/4 <rssi>dBm IDLE:<n>`: Wi-Fi bars, RSSI in dBm, and `IDLE:<n>` (`idleRssiChangeCount` counter so you
     can immediately see if a sleeping camera is spamming `wifiRssi` updates).
   - `TMP:<c>C`: Camera battery temperature.
   - `HW:M<mode>/<clipLen>s/EE:<Y|N>/Q<quality>/RTSP:<Y|N>`: Eufy hardware settings (`powerWorkingMode`,
     `recordingClipLength`, `recordingEndClipMotionStops`, `videoStreamingQuality`, and `RTSP` capability/URL status
     `useRtsp && (rtspUrl || rtspSupported)`, seeded from `hwRecordingCfg` until camera properties arrive).
   - `SEEN:<HH:MM>`: Local wall-clock `HH:MM` timestamp of the last decoded video frame or cached snapshot (`----` when
     none).
3. **Row 3 - Active Session, Hold/Cooldown Timers, Viewers, Eufy Trigger State & Frame Queues:**
   - `SES:<mode> R:<retries>`: Active stream mode (`NONE`, `RTSP`, `P2P`, `BF`) and retry count.
   - `HOLD:<rem>`: Remaining seconds on the active `motionUntil` / `viewUntil` hold timer.
   - `IDLE:<age>`: Elapsed seconds since the last motion trigger (`lastMotionAt`) while inactive (`---` while active).
   - `VID:<age>`: Time since the last decoded video frame arrived (`0.0s-9.9s`).
   - `VW:<waking>/<total>`: Active single-camera waking viewers vs total `go2rtc` viewers.
   - `TRIG:ACTIVE <age>  Q:<live>/<dl>` / `TRIG:CLEAR  <age>  Q:<live>/<dl>`: Whether Eufy hardware trigger state
     (`activeTriggerEvents`) is currently active or cleared, for how long, and queued frames in `liveFrames` /
     `downloadFrames` RAM buffers.
   - `STOP:<N|P2P>`: Whether an in-flight `device.stop_livestream` (`P2P`) is currently active.
4. **Row 4 - Frigate Event Lifecycle & Backfill Clip Progress:**
   - `EV:<state> <rem>/<id>`: Frigate event state (`IDLE`, `QUEUED`, `WAIT_S`, `RECORD`), remaining event window seconds
     (`evUntil`), and the `6`-char Frigate event ID suffix.
   - `BFQ:<wait> TRY:<x>/10 Q:<n>`: Seconds elapsed since `pendingBackfill.at` while waiting to match a `HomeBase 3`
     clip (`---` once matched or idle), single-digit query attempt (`0-9`), and number of pre-matched clips waiting in
     `backfillClipQueue`.
   - `CONT:<Y|N>`: Whether back-to-back clip continuation (`backfillContinuation`) is active.
   - `CLIP:<played>/<decoded>f`: Backfill frames played vs total frames decoded (e.g. `0450/0450f`).
   - `INIT:<initiator>`: `8`-char wake initiator (`none`, `eufy-eve`, `viewer`, `backfill`, `api-wake`, `eufy-ws`,
     `bridge-p`).
