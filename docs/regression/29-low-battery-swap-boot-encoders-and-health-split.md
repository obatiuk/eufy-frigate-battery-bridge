# 29. Low-Battery Swap Offline Latch, Eager Boot Encoders & Service Health Split

- **Cause:** Three service-recovery and offline-state edges caused unnecessary unavailability:
  (1) `Telemetry.applyProperties()` left `EUFY_DEVICE_STATES.OFFLINE_LOWBAT` / `OFFLINE` latched after a `>= 10%`
  battery swap (`BATTERY_SWAP_DELTA_PCT`) when the replacement cell remained `<= low_battery_threshold` (e.g.
  `2% -> 15%`);
  (2) `startServices()` and failed `start_listening` handshakes left non-offline Eufy encoders unstarted until
  initial telemetry or `ws.close()`, starving Frigate of the `AT-18` `Disconnected` card during WS boot outages; and
  (3) `pollViewers()` overwrote `frigateApiDown` when go2rtc failed and cleared `frigateConnected: false` whenever
  go2rtc replied `200 OK`, causing 750ms mask-sync flapping while Frigate was down.
- **Fix:** Added `batteryRiseSwapped` clearing in `telemetry.js` whenever battery increases `>= 10%` and
  `!isBatteryDepleted()`; extracted `ensureCameraEncodersStarted({wsConnected, rtspDirectOnly})` in `eufy-client.js` and
  invoked it from `app.js` `startServices()` and the `start_listening` error path; and separated `go2rtcApiDown` from
  `frigateApiDown` in `frigate-client.js` so `pollViewers()` manages `go2rtcConnected` without clearing
  `frigateConnected`.
- **Tests:** `test/regression/29-low-battery-swap-boot-encoders-and-health-split.test.js` (`clears stale
OFFLINE_LOWBAT and OFFLINE states on >= 10% battery swaps...`),
  `test/regression/29-low-battery-swap-boot-encoders-and-health-split.test.js` (`tracks go2rtc health separately...`),
  `test/regression/29-low-battery-swap-boot-encoders-and-health-split.test.js` (`starts non-offline Eufy encoders
eagerly...`), and `test/acceptance/AT-07.test.js`, `test/acceptance/AT-08.test.js`, `test/acceptance/AT-18.test.js`.
