# 32. Container-Only `/healthz` Check & Graceful External Reconnect Logging

- **Cause:** `/healthz` returned `503 Service Unavailable` (`ok: false`) whenever `eufy-security-ws` was disconnected
  while any Eufy camera was configured, causing container supervisors (`--health-on-failure=restart`, `autoheal`) to
  restart the bridge unnecessarily during upstream outages. In addition, `eufy-client.js` left stale reconnect timers
  untracked across WebSocket retries (`start_listening` failure or synchronous constructor error), `pollViewers()` did
  not log when `go2rtc` became unreachable, and `syncFrigateMotionMasks()` did not emit an outage warning when
  Frigate returned non-2xx responses.
- **Fix:** Updated `buildHealthPayload()` in `http-server.js` to set `ok: !shuttingDown` so `/healthz` reports `200`
  whenever the bridge process is running with valid config (`503` only on shutdown) while still reporting `ws_connected`
  for diagnostics; added tracked reconnect timers, constructor error recovery, stale-socket guards, and reconnect logs
  in `eufy-client.js`; and added edge-triggered outage warnings in `frigate-client.js` for Frigate and `go2rtc`
  outages alongside recovery logs. Also updated `AT-08`, `README.md`, and `docs/stream-lifecycle.md`.
- **Tests:** `test/acceptance.test.js` (`AT-08`) and `test/services.test.js` (`tracks go2rtc health separately...`,
  `enforces /api/wake hybrid direct rtsp_url handling...`, `reconnects eufy-security-ws gracefully...`).
