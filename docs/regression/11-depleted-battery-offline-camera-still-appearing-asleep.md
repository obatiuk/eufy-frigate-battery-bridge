# 11. Depleted Battery Camera Still Appearing Asleep & Deep-Standby False Positives

- **Scope:** Depleted Battery / Offline Camera Still Appearing Asleep in Frigate, Battery Camera Deep-Standby `state=0`
  False Positives & Color Burst on Full Restart Snapshot Seeding

- **Cause 1:** When a camera's battery drained to `0%` or the device went offline (`state = 3` `OFFLINE_LOWBAT`),
  `eufy-client.js` did not track the `state` property, `Telemetry` treated `0%` unplugged identically to `<= 20%`
  low-battery economy mode, and the persistent `5 fps` `ffmpeg` `RTSP` encoder kept streaming the sleeping card to
  `go2rtc` / Frigate indefinitely so Frigate never detected that the camera was offline.
- **Cause 2 (Battery Camera Deep-Standby `state = 0` False Positives):** Eufy battery cameras report `state = 0`
  (`EUFY_DEVICE_STATES.OFFLINE`) in `eufy-security-ws` whenever their Wi-Fi radio enters deep standby
  (`battery=100%, rssi=-72dBm`), whereas a genuinely dead/offline camera reports `state = 3`
  (`EUFY_DEVICE_STATES.OFFLINE_LOWBAT`), `state = 2/4/5`, or `state = 0` with a dead link (`rssi <= -95 dBm`) /
  critical battery (`<= 5%`).
- **Cause 3 (Color Burst Instead of Cached Snapshot on Full Restart of Frigate + Bridge):** First, stopping
  `ffmpeg -f rawvideo -i pipe:0` with `SIGTERM` while `1.38 MB` YUV420p frames were being piped across `64 KB` OS
  pipe chunks interrupted `avio_read` mid-frame (`EINTR`), causing `ffmpeg` to encode and flush a
  half-read/zero-padded YUV420p frame (`U=0, V=0` = neon green/magenta color burst) to `go2rtc` right before closing
  RTSP. Second, on a simultaneous full restart of Frigate and the bridge, `go2rtc` starts in `< 1s` while Frigate
  takes `8-20s` to boot and attach its `FFmpeg Frigate` consumer to `go2rtc`, and `inBurst` expired after `2s`
  (dropping the encoder to `5 fps` with `-g 15` = 1 IDR keyframe every `3s`), so killing the encoder after a fixed
  `6s` left Frigate with either no frames or P-frames without an IDR keyframe.
- **Fix:** Added `EUFY_DEVICE_STATES` (`OFFLINE: 0`, `ONLINE: 1`, `MANUALLY_DISABLED: 2`, `OFFLINE_LOWBAT: 3`,
  `REMOVE_AND_READD: 4`, `RESET_AND_READD: 5`) and offline detection in `Telemetry` / `Camera` (`isDeviceOffline()`,
  `getOfflineReason()`, `markWakeTimedOut()`, `markDeviceOnline()`, `hasOfflineSnapshotToSeed()`) that ignores
  `state = 0` when the camera has a healthy battery (`> 5%` or charging) and healthy Wi-Fi link (`rssi > -95 dBm`),
  while catching `state = 3` (`OFFLINE_LOWBAT`), `state = 2/4/5`, `state = 0` with `battery <= 5%` or
  `rssi <= -95 dBm`, `0%` unplugged battery (`isBatteryDepleted()`), and non-event live wake timeouts
  (`!hadVideo && !wasEventActive` on `error/watchdog-timeout` / `error/rtsp-wake-timeout`); deferred initial
  `startEncoder(cam)` until `eufy-security-ws` loads initial telemetry so offline cameras without a cached snapshot
  (or with `sleep_screen` other than `"snapshot"`) never spawn an encoder or stream anything at startup; updated
  `pauseEncoderForOffline()` to terminate the detached `ffmpeg` encoder with `PROCESS_SIGNALS.SIGKILL` so `ffmpeg`
  never flushes a partially-read `1.38 MB` `rawvideo` frame on exit; updated `seedOfflineCameraSnapshot(cam)`
  (`OFFLINE_SNAPSHOT_MAX_WAIT_MS = 30000ms`, `OFFLINE_SNAPSHOT_SEED_MS = 6000ms`) and `pollViewers`
  (`notifyOfflineSeedConsumerConnected`) to keep `15 fps` IDR keyframe bursts (`triggerKeyframeBurst`) active for the
  entire seed window and wait up to `30s` for `go2rtc` to report an active Frigate consumer (`consumers.length > 0`)
  before starting the `6s` post-consumer seed countdown (**only** when `sleep_screen === "snapshot"` and a cached
  snapshot exists); and automatically resumed the `RTSP` encoder (`startEncoder(cam)`) as soon as the camera comes
  back online or starts charging.
