# 19. RTSP Wake Retry Restarted a Camera Wake That Was Still in Progress

- **Cause:** `DEFAULT_RTSP_RETRY_MS` was `6.5s`, shorter than the observed `7-8.5s` HomeBase RTSP cold wake, so the
  retry re-sent `start_rtsp_livestream` while the camera was still waking. With two RTSP cameras on one HomeBase this
  produced `7-26s` recording gaps, repeated `404` pulls, and in one log a sibling stream ended by Eufy within a second
  of the retry command (a correlation, not a confirmed cause).
- **Fix:** `DEFAULT_RTSP_RETRY_MS` is now `10s` (still `5` retries and the `25s` wake timeout). `api-wake` on a
  `backfill`-mode camera that starts a live stream now logs why (nothing active to wait for).
- **Tests:** `test/domain.test.js` (`evaluateRtspHealth` default retry interval).
