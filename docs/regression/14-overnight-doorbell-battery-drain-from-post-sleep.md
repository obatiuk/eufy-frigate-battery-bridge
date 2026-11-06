# 14. Overnight Doorbell Battery Drain from Post-Sleep `P2P` Re-Wake Loops

- **Scope:** Overnight Doorbell Battery Drain from Post-Sleep `P2P` Self-Re-Wake Loops, Sub-`100ms` `stop_livestream` /
  `start_livestream` Radio Collisions, Low-Battery `MSE` Viewer `driver.poll_refresh` Wakes, Stuck Idle Spotlights &
  Sticky `wakeTimedOutOffline` Below `20%` Battery

- **Cause 1 (Post-Sleep `P2P` Self-Re-Wake Loop & Trailing `'livestream video data'` Adoption):** Bypassing the
  `3000ms` `EXTERNAL_WAKE_GUARD_MS` post-sleep guard on natural timer stops or calling `tryAdoptExternalP2pWake` on
  `'livestream video data'` caused trailing packets arriving `1-5ms` after `SLEEP` (while `device.stop_livestream`
  was still in flight) to immediately self-adopt a new `30s` `WAKE (initiator=eufy-ws)`. Milliseconds later, when our
  own `device.stop_livestream` from the previous session completed on `eufy-security-ws` and emitted `'livestream
 stopped'`, `handleLivestreamStoppedEvent` treated it as an unexpected camera interruption and fired
  `device.start_livestream` again.
- **Cause 2 (Low-Battery `MSE` Viewer `driver.poll_refresh` Radio Wakes, Stuck Idle Spotlights & `station.disconnect`
  Reconnect Loops):** While an online camera was in Low-Battery Economy Mode (`3%..20%`), its persistent encoder
  stayed running so Frigate's `mse/fmp4` player reconnected every `~54s`; calling `fetchAllCameraTelemetry(true)`
  (`driver.poll_refresh`) when `blockedByEco && !blockedByOffline` forced `HomeBase 3` to actively wake the battery
  doorbell over the wireless radio every `~54s`. Similarly, a spotlight (`light: true`, such as Color Night Vision on
  spotlight-equipped cameras) left stuck on while `[IDLE]` kept the camera MCU/Wi-Fi radio awake (`29°C`, continuous
  `wifiRssi` updates), whereas calling `station.disconnect` or pulsing `start_livestream` -> `stop_livestream` in
  `forceStopWedgedP2pRadio` forced an automatic `eufy-security-ws` station reconnect `15-18s` later that ran
  `database query latest` and woke attached battery cameras in a repeating `~2m` battery-drain loop.
- **Cause 3 (Sticky `wakeTimedOutOffline` Below `20%` Battery, False `OFFLINE_LOWBAT` Bounce on `1%` Battery Updates,
  Post-Viewer Linger Re-Wake Loops & Duplicate `'property changed'` Trigger Pairs):** Once a non-event wake timed out
  (`markWakeTimedOut()` -> `wakeTimedOutOffline = true`), calling `device.get_properties` unconditionally in `stop()`
  returned cached properties that cleared `wakeTimedOutOffline` in the same millisecond, whereas
  `Telemetry.applyProperties` never cleared `wakeTimedOutOffline` on `{state: 0, battery: 6..20}` and falsely cleared
  `OFFLINE_LOWBAT` (`state = 3`) back to `ONLINE` on `{battery: 1}` updates lacking `state`. Furthermore, when all
  human viewers disconnected and the camera stopped its `P2P` stream during `view_linger_secs`,
  `evaluateExternalLivestreamStop` and `evaluateP2pHealth` treated the stop as an active interruption and re-woke the
  camera with `0` viewers, while `markP2pStreamReady` failed to refresh `lastStartAt` on retries.
- **Fix:** Added `stoppingP2p` (`markP2pStopInFlight()`, `clearP2pStopInFlight()`, `isStoppingP2p()`) in `Camera`,
  always enforcing the full `3000ms` `EXTERNAL_WAKE_GUARD_MS` post-sleep guard and blocking `canAdoptExternalWake`
  while `device.stop_livestream` is in flight; ignored `'livestream stopped'` while `stoppingP2p` or `starting`;
  removed `tryAdoptExternalP2pWake` from `case 'livestream video data':` so trailing packets within `3s` are ignored
  and unsolicited video past `3s` (`UNSOLICITED_VIDEO_STOP_DELAY_MS = 3000`) sends `device.stop_livestream`; removed
  `blockedByEco && !blockedByOffline` `driver.poll_refresh` calls in `pollViewers` and raised
  `LOW_BAT_VIEWER_REFRESH_COOLDOWN_MS` to `300000` (`5m`); tracked `light` in `Telemetry` and added
  `shouldTurnOffStuckIdleLight` (`15s` grace, later made opt-in via `track_stuck_spotlight: true` with a `130s` grace
  in `#20`), while hardening `recordIdleRssiChange` (at most once per completed session unless `hasStuckIdleLight` is
  active) and `forceStopWedgedP2pRadio` (sending only `device.stop_livestream` plus `light: false` when stuck past
  grace, never `station.disconnect` or `device.start_livestream`);
  serialized `setCameraProperty` RPC calls per camera (`propertySyncChains`) so `HomeBase 3` never drops concurrent
  writes; guarded post-session `device.get_properties` in `stop()` so it is skipped after backfill downloads or when
  `isDeviceOffline()`; updated `evaluateExternalLivestreamStop` and `evaluateP2pHealth` to return `'expired'` when
  `!isInMotion(now) && !hasWakingViewer() && gotVideo` and refreshed `lastStartAt` in `markP2pStreamReady`; clamped
  `videoStreamingQuality` (`0` `Auto` or `> 7` `High`/`4K`) to `7` (`Medium`); added
  `Camera.isDuplicateTriggerEvent()` to coalesce simultaneous `'property changed'` + native trigger pairs within
  `1s`; updated `BackfillJob.needsFollowUpClipQuery` to use `Math.max(this.at || 0, lastClipMs || 0)` so `5s`
  pre-roll timestamps never inflate post-trigger activity spans; and updated `Telemetry.applyProperties` so
  `OFFLINE_LOWBAT` only clears when `charging` or `!isLowBattery()` while clearing `wakeTimedOutOffline` whenever
  `!isReportedOfflineByState() && !isBatteryDepleted()`.
