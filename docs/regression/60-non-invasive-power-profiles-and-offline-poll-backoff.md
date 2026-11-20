# 60. Non-Invasive `power_mode` & `streaming_quality` Profiles, Rejection Latch & `60m` Offline Poll

- **Scope:** `src/config/constants.js`, `src/config/camera-config.js`, `src/config/validation.js`,
  `src/config/resolvers.js`, `src/config/builder.js`, `src/domain/telemetry.js`, `src/domain/camera.js`,
  `src/services/eufy/telemetry-sync.js`, `src/services/api-payloads.js`, `AT-07`, `AT-10`, `AT-12`, `AT-19`
- **Cause:** `sync_power: true` and `enforce_streaming_quality: true` defaulted to overwriting every Eufy camera into
  `powerWorkingMode: 2` (`Customize Recording`, `60s`, `end_early: false` in live modes) and `videoStreamingQuality: 7`
  (`Medium`), disabling Eufy's firmware-level adaptive PIR backoff, forcing `60s` hardware `RTSP` transmission plus a
  second cold `RTSP` wake after brief motion cleared, downgrading `2K`/`4K` Eufy mobile app Live View, and retrying
  rejected `device_invalid_property_value` writes every `5` minutes. In addition, background telemetry polls fired
  global `driver.poll_refresh` every `5` minutes (`288/day`) whenever any camera was manually disabled (`state: 2/4/5`)
  or had a depleted battery, waking all healthy sibling cameras over the `HomeBase` radio.
- **Fix:** Replaced `sync_power`, `power_working_mode`, and `enforce_streaming_quality` with non-invasive grouped
  `power_mode` (`"keep"` default, `"battery"`, `"surveillance"`, and `"custom"` in `mode: "custom"`) and
  `streaming_quality` (`"keep"` default, `"auto"`, `"low"`, `"medium"`, `"high"`, `"ultra"`, plus `0..10` in
  `mode: "custom"` resolved via `device.get_properties_metadata` `states`), emitting `[WARN ]` logs with the camera's
  existing settings whenever an opted-in profile overrides them. Lowered default `hold_secs` to `30s` live / `20s`
  backfill with `end_early: true` across all modes (mirroring reported Eufy telemetry under `power_mode: "keep"` and
  re-waking `RTSP` clip drops only while a waking viewer or active detection remains), skipped background
  `driver.poll_refresh` for `state: 2/4/5` cameras, backed off unforced offline `driver.poll_refresh` to `60` minutes,
  latched permanent `device.set_property` rejections without repeating `P2P` writes, and added read-only inspection of
  Eufy `motionDetection*` settings with deduplicated `WARN` logs when active `trigger_events` categories are disabled in
  the Eufy app.
