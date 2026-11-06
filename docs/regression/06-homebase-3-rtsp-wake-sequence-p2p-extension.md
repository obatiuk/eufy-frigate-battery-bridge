# 6. HomeBase 3 RTSP Wake Sequence, P2P Extension Loops & Burst Download Pacing

- **Cause 1:** Calling `device.stop_rtsp_livestream` on sleep disabled the camera's NAS/RTSP toggle on the HomeBase,
  while passing `-analyzeduration 0` to `ffmpeg -rtsp_transport tcp` aborted RTSP SDP dimension probing.
- **Cause 2:** Extending `motionUntil` by `+5s` whenever video was still flowing kept `device.start_livestream` P2P
  sessions open until the HomeBase 2.5-5m hard limit.
- **Cause 3:** HomeBase 3 ignores legacy `station.database_query_local` and bursts `.zxvideo` clip downloads at ~10x
  real-time speed.
- **Fix:** Wake RTSP via sequential `rtspStream=true` + `device.start_rtsp_livestream` with `750ms` retries and never
  call `stop_rtsp_livestream` on sleep; end P2P event streams `5s` after Eufy reports `state: false`; query HomeBase
  3 via `station.database_query_latest_info` / `station.database_query_by_date` and pace buffered `downloadFrames` at
  `15 fps` (`LIVE_FPS`).
