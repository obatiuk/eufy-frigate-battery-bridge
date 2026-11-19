# 31. Credential Redaction With '@' Passwords, Newline Escaping & Strict Port Validation

- **Cause:** `Camera.getMaskedRtspUrl()` used a single non-global `/:\/\/[^@]+@/` regex that stopped at the first `@`
  inside a password, FFmpeg stderr tail summaries in `encoder.js` / `decoder.js` could contain raw URL credentials,
  and `formatLogLine()` in `logger.js` omitted secret masking and CR/LF escaping. In addition, `config.js` passed
  TCP/HTTP port environment variables through `clampNum()` (coercing malformed strings such as `"8080abc"`), and the
  container `HEALTHCHECK` probed `:0/healthz` when `BRIDGE_HTTP_PORT=0`.
- **Fix:** Added and exported `maskSecrets()` (`/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi`) plus CR/LF escaping in
  `logger.js`, reused `maskSecrets()` across `Camera.getMaskedRtspUrl()` and
  `FfmpegArgsBuilder.attachStderrTailCollector()`, enforced strict integer range validation via `parseEnvPort()` in
  `config.js` (caught cleanly inside `loadConfig()`), and updated `deploy/Dockerfile` `HEALTHCHECK` to exit `0` when
  `BRIDGE_HTTP_PORT=0`.
- **Tests:** `test/regression/31-secret-redaction-log-escaping-and-port-validation.test.js` (`masks RTSP URL
credentials...`), `test/regression/31-secret-redaction-log-escaping-and-port-validation.test.js` (`masks URL
credentials with @ passwords...`), `test/regression/31-secret-redaction-log-escaping-and-port-validation.test.js`
  (`redacts URL credentials in FFmpeg stderr tail summaries...`), and
  `test/regression/31-secret-redaction-log-escaping-and-port-validation.test.js` (`rejects non-integer or out-of-range
port environment variables...`).
