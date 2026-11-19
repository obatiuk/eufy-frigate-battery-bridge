# 52. Serialized Telemetry Polling & 5-Minute Unforced Offline HomeBase Refresh Cooldown

- **Scope:** `src/services/eufy/telemetry-sync.js`, `AT-07`, `AT-08`
- **Cause:** `fetchAllCameraTelemetry()` had no in-flight serialization guard even though the background poller,
  initial `3s` retry timer, `driver` / `station` reconnect handlers, single-camera viewer joins, and `/api/wake`
  offline recovery all invoked it asynchronously (with `driver.poll_refresh` sleeping `2s` before per-camera
  `device.get_properties` calls). In addition, `shouldRefreshHomeBase` triggered `driver.poll_refresh` on every
  unforced poll whenever any configured Eufy camera was offline, repeatedly refreshing `HomeBase` across overlapping or
  frequent polls instead of respecting a `5`-minute cooldown.
- **Fix:** Serialized `fetchAllCameraTelemetry()` behind a coalescing in-flight `Promise` that shares one active RPC
  pass across concurrent callers and schedules at most one forced follow-up pass when `forceRefresh=true` arrives
  mid-flight during an unforced poll. Rate-limited unforced offline `driver.poll_refresh` calls with a `5`-minute
  cooldown (`OFFLINE_POLL_REFRESH_COOLDOWN_MS = 300000`, reset on `WebSocket` reconnect), while explicit forced
  refreshes (`fetchAllCameraTelemetry(true)` on viewer joins and `/api/wake`) still poll `HomeBase` immediately.
