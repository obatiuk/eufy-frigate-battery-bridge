# 45. Fast Dependency-Free `/healthz` Liveness Response & Immediate Startup Binding

- **Cause:** Container health status remained in `starting` for 30+ seconds after boot because `deploy/Dockerfile`
  configured `HEALTHCHECK --interval=30s --start-period=15s` (delaying the very first probe in Podman and Docker by a
  full `30s` interval), `main()` in `src/app.js` waited until synchronous `ffmpeg` snapshot decoding and initial encoder
  spawns finished before calling `startHttpServer()`, and `GET /healthz` in `src/services/http-server.js` still queried
  `isWsReady()` to include `ws_connected` while allocating `URL` / JSON responses using chunked keep-alive framing. In
  addition, setting `BRIDGE_HTTP_PORT=0` unconditionally exited `0` in `HEALTHCHECK` even when configuration validation
  failed, and invalid URL schemes, unknown `BRIDGE_HWACCEL` / `BRIDGE_LOG_LEVEL` values, duplicate/unsafe camera
  identities, or wrong YAML option types could bypass startup checks.
- **Fix:** Simplified `buildHealthPayload()` and `/healthz` (`/health`) in `src/services/http-server.js` to return a
  pre-encoded fixed-length `{"ok":true}` (`200`) or `{"ok":false}` (`503` on shutdown) buffer with `Connection: close`
  on a synchronous fast-path before `URL` allocation and with zero external service fields (`ws_connected` lives on
  `/api/status`); moved `startHttpServer()` ahead of `initCameras()` in `src/app.js` (exiting `1` if the HTTP port
  cannot bind); tightened `HEALTHCHECK` in `deploy/Dockerfile` to `5s` (`2s` timeout) while verifying a live
  post-validation PID marker when `BRIDGE_HTTP_PORT=0`; and enforced strict URL scheme,
  runtime env, identity uniqueness, safe-name, and scalar/integer type checks at startup in `src/config.js`.
- **Tests:** `test/acceptance/AT-08.test.js`,
  `test/regression/45-fast-dependency-free-healthz-and-startup-probe.test.js` (`serves dependency-free fixed-length
/healthz responses...`), and `test/regression/45-fast-dependency-free-healthz-and-startup-probe.test.js` (`exits 0
in Dockerfile HEALTHCHECK...`).
