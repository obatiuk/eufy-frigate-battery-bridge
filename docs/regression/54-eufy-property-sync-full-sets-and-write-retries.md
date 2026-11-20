# 54. Sync Eufy Hardware Properties Only from Full Property Sets & Retry Failed Writes

- **Scope:** `src/services/eufy/telemetry-sync.js`, `src/services/orchestrator/event-router.js`,
  `src/domain/telemetry.js`, `src/domain/camera.js`, `src/services/orchestrator/housekeeping.js`, `AT-05`, `AT-07`,
  `AT-08`, `AT-10`, `AT-18`
- **Cause:** `handlePropertyChanged()` passed single-key `{[e.name]: e.value}` payloads into `applyDeviceProperties()`,
  running streaming-quality, Power Manager, and `RTSP` sync checks on every `wifiRssi` or `battery` event. In addition,
  `Telemetry.evaluateRecordingModeChanges()` used `RECORDING_MODE_PROPERTIES.some(...)`, latching
  `recordingModeChecked = true` when any single recording key arrived and treating the remaining three absent keys as
  `undefined` (`n/a -> targetValue` writes). Finally, `qualityChecked`, `recordingModeChecked`, `rtspEnabledChecked`,
  and stuck-spotlight `clearLightOn()` committed synchronously before `setCameraProperty()` confirmed `res.success`, so
  failed or dropped `HomeBase` `P2P` writes never retried.
- **Fix:** Added `{fullSync: false}` support to `applyDeviceProperties()` and passed it from `handlePropertyChanged()`
  so single-key `property changed` events skip Power Manager and streaming-quality sync while still updating discovered
  `rtspStreamUrl` and `rtspStream` when present. Required all four `RECORDING_MODE_PROPERTIES` keys (`every(...)`)
  before evaluating Power Manager recording sync. Updated `setCameraProperty()` to return `Promise<boolean>` (`true`
  only when `device.set_property` resolves with `res.success === true`), guarded in-flight property syncs per camera to
  prevent duplicate concurrent enqueues, committed `qualityChecked`, `recordingModeChecked`, and `rtspEnabledChecked`
  only after RPC confirmation, and restored spotlight state when `setCameraProperty(cam, 'light', false)` fails so idle
  spotlight turn-off retries on subsequent ticks.
