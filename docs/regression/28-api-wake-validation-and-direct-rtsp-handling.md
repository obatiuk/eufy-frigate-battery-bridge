# 28. Invalid `/api/wake` Targets, Malformed Payloads & Direct `rtsp_url` Handling

- **Cause:** Five edge cases degraded `/api/wake/:cameras` safety and diagnostics: (1) direct `rtsp_url` cameras were
  accepted by `canServeWakeRequest()` and `wakeCameraExternal()`, filing Frigate events or restarting `5s` passive
  probes while returning misleading `hold_secs` values ignored by continuous streams; (2) partial comma-separated
  misses such as `/api/wake/garage,missing` silently dropped unknown tokens and returned `200`; (3) malformed percent
  encoding (`%`) threw an uncaught `URIError` in `decodeURIComponent()`; (4) invalid JSON, non-object bodies, oversized
  bodies (`> 16384` bytes), and invalid `duration` / `create_event` parameters silently coerced to defaults; and (5)
  unsupported HTTP methods returned `404` while shutdown/all-offline targets returned `200`.
- **Fix:** Added `Camera.supportsApiWake()`, `Camera.toApiWakeErrorResponse()`, `resolveTargetSelection()`, strict
  `readJsonBody()` / `parseWakeParams()`, and `createHttpRequestHandler()` in `http-server.js` and
  `stream-orchestrator.js`: returning `422 UNSUPPORTED_OPERATION` when targeting direct `rtsp_url` cameras exclusively
  and skipping them as `status: "unsupported"` in mixed/`all` calls, failing atomically (`404 CAMERA_NOT_FOUND`) when
  any token is unknown, and returning structured `400` / `405` / `413` / `503` JSON payloads.
- **Tests:** `test/regression/28-api-wake-validation-and-direct-rtsp-handling.test.js` (`enforces /api/wake hybrid
direct rtsp_url handling...`) and `test/acceptance/AT-17.test.js`.
