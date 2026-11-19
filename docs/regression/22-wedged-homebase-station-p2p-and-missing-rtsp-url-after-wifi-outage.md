# 22. Wedged HomeBase Station P2P Session & Missing `rtspStreamUrl` After Wi-Fi Outage

- **Cause:** After an intermediate Wi-Fi outage, all camera wakes (`RTSP` and `P2P`) timed out indefinitely even after
  restarting Frigate and `eufy-frigate-battery-bridge`, while the Eufy mobile app continued streaming live:
  1. `eufy-security-ws` runs in a separate container whose `UDP` `P2P` session to the `HomeBase` station and cloud poll
     channel wedged during the Wi-Fi drop, whereas the Eufy mobile app opens its own direct `P2P` session to the
     `HomeBase`. Restarting Frigate and the bridge reconnected to the same wedged `eufy-security-ws` daemon without
     verifying `driver` or `station` connectivity (`driver.is_connected`, `station.is_connected`) on `start_listening`.
  2. When `driver.poll_refresh` timed out after `20s` (`errorCode: 'no_reply'`), `fetchAllCameraTelemetry()` ignored the
     failure and read stale cached `device.get_properties` values from `eufy-security-ws` memory. That cleared
     `wakeTimedOutOffline` (`normal mode restored`) and resumed the `RTSP` encoder without ever calling `driver.connect`
     or `station.connect`.
  3. On `RTSP`-capable cameras (`rtsp` and `backfill` modes), `eufy-security-ws` reported `rtspStream: true` from cloud
     state while `rtspStreamUrl` was empty (`""`), so `startRtspDecoder()` never spawned. Retrying
     `device.set_property(rtspStream, true)` when `rtspStream` was already `true` was a no-op on `eufy-security-ws` and
     never caused `HomeBase` to regenerate `rtspStreamUrl`.
  4. Startup hardware property writes (`recordingEndClipMotionStops`, `videoStreamingQuality`) were dropped while the
     station `P2P` link was down, but `recordingModeChecked`, `qualityChecked`, and `rtspEnabledChecked` remained `true`
     after station reconnect.
- **Fix:**
  1. `handleVersionMessage()` now calls `ensureInitialDriverAndStationsConnected()` after `start_listening` to check
     `driver` and `station` connection state and dispatch `driver.connect` and `station.connect` whenever disconnected.
  2. `fetchAllCameraTelemetry()` checks the `driver.poll_refresh` result; on failure (`no_reply`), it skips stale cached
     `device.get_properties` reads and runs `recoverDriverAndStations()` (`driver.connect` plus `station.disconnect ->
station.connect` per station).
  3. `startRtspStream()` (`prepareRtspWakeAttempt()`, `ensureRtspUrlAfterWakeStart()`, `refreshMissingRtspUrlOnStart()`)
     and `startLivestream()` (`ensureStationReadyForP2pRetry()`) verify `ensureStationConnected()` before waking,
     immediately toggle `rtspStream: false -> true` when `rtsp livestream started` or an `RTSP` wake retry still has an
     empty `rtspStreamUrl`, and recycle wedged station `P2P` sessions (`station.disconnect -> station.connect`, `60s`
     cooldown) mid-wake when retries receive zero device replies.
  4. `recoverUnresponsiveStation()` marks the station in `recyclingStations` during `station.disconnect ->
station.connect` so `handleStationEvent()` ignores the self-inflicted `'connection error'` / `'close'` event without
     aborting concurrently waking cameras, and `evaluateUnexpectedRtspStart()` ignores spurious `'rtsp livestream
started'` events on cameras already receiving `P2P` video (`gotVideo === true`).
  5. `stop()` tracks `wokeWithoutDeviceReply` (`!gotVideo && !heardFromDeviceInSession`); `recordStationWakeTimeout()`
     recycles zombie `P2P` sessions on an unresponsive wake timeout, while `handleStationEvent()` schedules periodic
     `station.connect` retries while a station stays disconnected and `resetStationSyncFlags()` re-runs hardware
     property and `RTSP` sync upon station `connect`.
- **Tests:** `test/regression/22-wedged-homebase-station-p2p-and-missing-rtsp-url-after-wifi-outage.test.js`
  (`Regression 22: recovers disconnected or wedged eufy-security-ws driver/station sessions and missing rtspStreamUrl
after Wi-Fi outages`), `test/domain/camera/debug-hud.test.js`.
