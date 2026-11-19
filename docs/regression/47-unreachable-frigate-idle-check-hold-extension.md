# 47. Unreachable Frigate Treated as Active Object During Hold & Early-Sleep Checks

- **Cause:** `isFrigateCameraIdle()` in `src/services/frigate-client.js` returned boolean `false` whenever
  `GET /api/events` timed out, returned a non-`2xx` HTTP status, or answered with malformed/non-array JSON. In
  `src/services/orchestrator/housekeeping.js`, `evaluateActiveHoldExtension()` treated `!frigateIdle` as a confirmed
  in-progress Frigate object detection (`confirmFrigateObjectDetected` + `extendActiveHold`), keeping battery cameras
  awake up to `stream_max_secs` (`900s`) throughout a Frigate restart or outage.
- **Fix:** `isFrigateCameraIdle()` now returns a frozen tri-state (`FRIGATE_CAMERA_STATES`: `'idle'`, `'active'`, or
  `'unknown'`). `evaluateActiveHoldExtension()` confirms object activity and extends holds only on `'active'` (or when
  an unexpired Eufy hardware trigger is still active), letting expired holds stop normally on `'unknown'`, and
  `evaluateEarlySleep()` confirms early battery-saver sleep only on `'idle'`.
- **Tests:** `test/services/frigate-client.test.js` (`returns tri-state idle, active, and unknown...`) and
  `test/regression/47-unreachable-frigate-idle-check-hold-extension.test.js`.
