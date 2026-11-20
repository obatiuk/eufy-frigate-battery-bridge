# 55. Tighten Encoder `hwaccel` Fallback Regex, Safe `{name}` Replacer & Shutdown `SIGKILL`

- **Scope:** `src/media/encoder.js`, `src/domain/camera.js`, `AT-07`, `AT-08`, `AT-18`
- **Cause:** `HWACCEL_FAILURE_STDERR_REGEX` matched bare `device`, `driver`, and `Invalid argument` tokens, allowing
  transient `go2rtc` or `TCP` `RTSP` output errors within `5s` of encoder spawn to permanently downgrade GPU encoding
  (`vaapi`/`qsv`/`nvenc`/`v4l2m2m`) to software `libx264`. In addition, `buildEncoderArgs()` used a string second
  argument in `.replace('{name}', cam.getName())` (which expands `$&` and `$$` replacement patterns), and
  `Camera.stopEncoderProcess()` sent only `SIGTERM` on shutdown without escalating to `SIGKILL` when an `ffmpeg` encoder
  process stayed wedged.
- **Fix:** Restricted `HWACCEL_FAILURE_STDERR_REGEX` to hardware-device, codec, and filter initialization signatures
  (`vaapi`, `qsv`, `nvenc`, `v4l2m2m`, `hwupload`, `init_hw_device`, `/dev/dri`, `libva`, `cuda`, `mfx`,
  `AVHWDeviceContext`, `AVHWFramesContext`, `Device creation failed`, `Function not implemented`) so `RTSP` and network
  errors never disable `hwaccel`. Switched `buildEncoderArgs()` to a function replacer `() => cam.getName()`, and added
  an `.unref()`-ed `2s` `SIGKILL` escalation timer (cleared on process `'exit'`) in `Camera.stopEncoderProcess()`.
