# 46. Event-Loop-Blocking Snapshot FFmpeg Calls & Serial go2rtc Viewer Polling

- **Cause:** `loadCachedFrame()` and `saveCachedFrame()` in `src/overlay/snapshot-cache.js` ran `spawnSync('ffmpeg')`
  with no timeout. At startup every camera decode blocked the event loop after the HTTP listener had bound, so
  `/healthz` could not answer (regression 45 only moved the bind earlier), and every session `stop()` froze the shared
  frame tick of all cameras during a JPEG encode. A hung FFmpeg would have frozen the bridge, and the encode wrote the
  snapshot in place, so a killed encode truncated the previous one. `pollViewers()` in `src/services/frigate-client.js`
  also awaited one go2rtc request per camera in sequence every 750ms, so a go2rtc outage delayed viewer (wake)
  detection by cameras x the request timeout.
- **Fix:** Snapshot cache FFmpeg now runs through an async `spawn` with a `10s` `SIGKILL` timeout and bounded output.
  `initCameras()` in `src/app.js` decodes all cached snapshots in parallel before building cameras. Saves encode a
  private copy of the frame into a temp file and rename it over the snapshot, and are skipped while a save of the same
  file is still running. `pollViewers()` now fetches the go2rtc stream table for all cameras with one
  `GET /api/streams` request, picks each camera's consumers by stream name (a stream that is not listed yet has no
  consumers, and unrelated streams are ignored), and warns once per episode when go2rtc answers with an unusable
  stream list.
- **Tests:** `test/overlay/snapshot-cache.test.js` and
  `test/regression/46-event-loop-blocking-snapshot-ffmpeg-and-serial-viewer-polling.test.js` (`Snapshot Cache
Event-Loop Safety`) and `test/services/frigate-client.test.js` (`polls go2rtc once for all cameras through the bulk
streams endpoint...`, `warns once when go2rtc answers with an unusable stream list...`), plus the `pollViewers`
  fixtures in `test/acceptance/AT-03.test.js`, `test/acceptance/AT-04.test.js`, `test/acceptance/AT-14.test.js`
  updated to the keyed stream table.
