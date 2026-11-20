# 58. Short-Circuit Oversized HTTP Bodies, Add Body Timeout & Close Connections on Shutdown

- **Scope:** `src/services/wake-request.js`, `src/services/http-server.js`, `src/services/http-responses.js`, `AT-08`,
  `AT-17`
- **Cause:** `readJsonBody()` marked `tooLarge = true` after `totalBytes > MAX_JSON_BODY_BYTES` (`16384`) yet continued
  consuming incoming chunks until `'end'` and had no read timeout, allowing oversized or slow-loris `POST /api/wake`
  uploads to keep sockets open indefinitely. In addition, `stopHttpServer()` called `httpServer.close()` without
  `httpServer.closeAllConnections()`, allowing idle `HTTP` keep-alive connections to delay container shutdown.
- **Fix:** Checked numeric `Content-Length > MAX_JSON_BODY_BYTES` upfront in `readJsonBody()` and immediately settled
  with `413` (`PAYLOAD_TOO_LARGE`) on the first chunk exceeding `16384` bytes, detaching stream listeners and pausing
  the request stream cleanly. Added an `.unref()`-ed `5000ms` body read timeout returning `408` (`REQUEST_TIMEOUT`) when
  a `POST` body stalls mid-stream, sent `Connection: close` (with post-flush socket close) on `413` and `408` responses,
  and invoked `httpServer.closeAllConnections()` inside `stopHttpServer()`.
