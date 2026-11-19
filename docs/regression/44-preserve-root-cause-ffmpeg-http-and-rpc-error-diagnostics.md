# 44. Preserve Root-Cause FFmpeg, HTTP, WebSocket, and RPC Error Diagnostics

- **Scope:** `src/app.js`, `src/config.js`, `src/domain/camera.js`, `src/logger.js`, `src/media/decoder.js`,
  `src/media/encoder.js`, `src/overlay/snapshot-cache.js`, `src/services/eufy-client.js`,
  `src/services/frigate-client.js`, `src/services/ha-notifier.js`, `src/services/http-server.js`,
  `src/services/stream-orchestrator.js`
- **Cause:** Several error paths hid, truncated, or overrode actual failure diagnostics:
  1. `FfmpegArgsBuilder.attachStderrTailCollector().getLastLine()` returned only `.pop()` from a `500`-char rolling
     `stderr` window, so `ffmpeg` 7/8's generic exit footers (`Error opening input file ...`,
     `Error opening input files: ...`, and `Conversion failed!`) overrode earlier `[rtsp @ ...]` or `[image2 @ ...]`
     root-cause lines, `evaluateRtspDirectDrop()` labeled closed/rejected `RTSP` handshakes as
     `direct RTSP endpoint unreachable`, and `snapshot-cache.js` discarded `loadCachedFrame()` decode errors and
     overrode `saveCachedFrame()` write errors with `Conversion failed!`.
  2. Service `catch` blocks logged only `err.message`, which reduced Node.js `fetch()` failures to bare `fetch failed`
     (dropping `err.cause`) and dual-stack `AggregateError` socket failures to an empty string (`""`).
  3. `frigate-client.js` truncated `HTTP` error bodies at `200` chars, let legacy mask-fallback timeouts override the
     primary `PUT /api/config/set` error, and dropped `go2rtc` outage reasons in `pollViewers()`, while `notifyHA()`
     dropped non-`2xx` webhook error bodies and `eufy-security-ws` `RPC` logs omitted `res.message` and overrode
     `start_download` and expired `RTSP` stop reasons.
- **Fix:** Added `formatErrorMessage()` (unwrapping `cause` chains, `AggregateError` sub-errors, and error codes) and
  `extractFfmpegStderrLines()` (stripping `ffmpeg` 7/8 CLI exit footers while retaining all handshake error lines across
  a `4096`-char buffer) in `logger.js`; clarified `RTSP` handshake rejections vs. unreachable hosts in
  `evaluateRtspDirectDrop()`; surfaced `ffmpeg` and `spawnSync` errors in `snapshot-cache.js`; raised `HTTP` error
  snippets to `1024` chars while preserving primary `PUT` errors, `go2rtc` poll failures, and `HA` webhook bodies; and
  added `formatRpcError()` so `eufy-security-ws` `errorCode` and `message` details are preserved in logs and stop
  reasons.
- **Tests:** `test/regression/44-preserve-root-cause-ffmpeg-http-and-rpc-error-diagnostics.test.js`.
