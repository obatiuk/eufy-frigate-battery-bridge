# 24. Service Restart Marked Cameras Unavailable Without Frigate Restart

- **Cause:** Restarting `eufy-security-ws` or `eufy-frigate-battery-bridge` while Frigate stayed running could leave
  cameras marked unavailable in Frigate for two reasons: (1) `Telemetry.isReportedOfflineByState()` in
  `src/domain/telemetry.js` required `this.battery !== null` when evaluating deep-standby `state: 0` (`OFFLINE`), so
  initial `start_listening` or `device.get_properties` payloads that reported `state: 0` before HomeBase populated
  `battery` falsely marked sleeping cameras `isDeviceOffline() === true` and stopped their `ffmpeg` `RTSP` encoder 6
  seconds after Frigate's existing `go2rtc` consumer was polled; and (2) if `eufy-security-ws` closed or
  `driver.poll_refresh` failed while reconnecting, `eufy-client.js` returned early without starting `RTSP` encoders for
  non-offline cameras or retrying telemetry when `hasBatteryReading()` was already true from before the restart.
- **Fix:** Updated `Telemetry.isReportedOfflineByState()` to treat `this.battery === null` (unpopulated initial battery)
  like `this.rssi === null` on `state: 0` deep-standby cameras; ensured `ws.on('close')` and `driver.poll_refresh`
  error recovery in `src/services/eufy-client.js` still start encoders for non-offline cameras with the `Disconnected`
  card; extended the post-handshake telemetry retry and station reconnect timers to cover service/station disruptions
  and missing `RTSP` URLs; handled `driver` `'connect'` events in `src/services/stream-orchestrator.js`; and cleared
  `frigateApiDown` in `syncFrigateMotionMasks()` when `auto_frigate_mask` is disabled.
- **Tests:** `test/domain.test.js` (`detects offline/dead camera states`) and `test/services.test.js` (`Regression:
recovers disconnected or wedged eufy-security-ws driver/station sessions and missing rtspStreamUrl after Wi-Fi
outages`).
