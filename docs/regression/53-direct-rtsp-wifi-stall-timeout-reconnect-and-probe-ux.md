# 53. Direct RTSP Wi-Fi Stall Tolerance, Fast Live Reconnect & Passive Probe Handling

- **Scope:** `src/media/decoder.js`, `src/domain/camera/stream-session.js`, `src/domain/camera.js`,
  `src/services/go2rtc-viewers.js`, `src/app.js`, `AT-05`, `AT-12`, `AT-14`
- **Cause:** Direct `rtsp_url` cameras shared the `5s` `HomeBase` `RTSP` socket read timeout (`-timeout 5000000`) and
  `5s` mid-stream frame watchdog (`DEFAULT_RTSP_MID_STALL_MS`), which aborted healthy 24/7 Wi-Fi `TCP` streams during
  `6s - 12s` off-channel roam scans and `TCP` retransmission backoffs even though all video frames remained intact in
  the camera's send buffer. When an established direct `RTSP` stream ended, `endSession()` entered the `5s` viewer
  `COOLDOWN` state and waited the full `5s` passive probe interval before reconnecting, `pollViewers()` logged
  `"streaming direct RTSP"` with `asked: false` when a viewer joined an un-decoded `5s` passive probe, and `SIGUSR2`
  dispatched synthetic `Frigate` test events to `cams[0]` even when it was a direct `rtsp_url` camera.
- **Fix:** Raised the `TCP` socket read timeout (`RTSP_DIRECT_SOCKET_TIMEOUT_US = '15000000'`) and mid-stream stall
  threshold (`DEFAULT_RTSP_DIRECT_MID_STALL_MS = 15000`) to `15s` for `rtsp_url` cameras while keeping the `8s` initial
  probe timeout so unreachable cameras still fail fast. Skipped viewer `COOLDOWN` on direct `RTSP` stream ends and
  shortened post-live reconnect delay to `1s` (`DEFAULT_RTSP_DIRECT_LIVE_RECONNECT_MS = 1000`, reverting to `5s` once a
  probe exits without video). Treated un-decoded passive probes as `"connecting direct RTSP stream"` in `pollViewers()`
  with in-place viewer promotion, and updated `SIGUSR2` (`handleSigUsr2SyntheticEventTest`) to select the first
  non-direct Eufy camera.
