# 3. Spontaneous Camera Wakeups, Multi-Camera Grid Wakeups & Decoder Resets

- **Cause 1 (IPv6 / Docker Bridge Recorder Filter):** The original viewer filter required `127.0.0.1` alongside
  `FFmpeg Frigate`.
- **Cause 2 (Mid-Sleep Card Re-renders):** Re-rendering `cam.asleep` on `property changed` events while asleep caused
  Frigate's `detect` stream to detect the pixel change as motion.
- **Cause 3 (Slow-Waking Camera Left in Queue on Fast Camera Switching):** Switching cameras quickly left the first
  camera's `start_livestream` in flight and its viewer queue active.
- **Cause 4 (Frigate Multi-Camera Dashboard Grid):** Opening Frigate's Live dashboard connects `mse/fmp4` viewers to
  all cameras in the same second, waking sleeping cameras after cooldown.
- **Cause 5 (Dynamic P2P Resolution Shifts):** Eufy camera and doorbell streams dynamically shift resolution
  (`3840x2160 <-> 2304x1296`, `1600x2200 <-> 1024x1408`) mid-session; restarting `ffmpeg` on width/height changes
  caused 1-2s freezes.
- **Fix:** Filter `/FFmpeg Frigate|^go2rtc/i` regardless of IP; ignore poll cycles where 2+ sleeping cameras get new
  viewers simultaneously (`isDashboardGrid`); only restart the decoder if the video codec changes; purge other P2P
  cameras' viewer queues on single-camera switch; await `cam.startPromise` before `stop_livestream`.
