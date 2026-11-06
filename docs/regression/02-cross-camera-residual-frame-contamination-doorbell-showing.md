# 2. Cross-Camera Residual Frame Contamination (Doorbell Showing Another Camera's View)

- **Cause 1:** `eufy-security-client` caches notification thumbnails (`properties.picture`) at the HomeBase station
  level, frequently returning the last event picture from a different camera on the same HomeBase.
- **Cause 2:** Unsynchronized `P2P` channel switching (`stop_livestream` vs. `start_livestream`) caused residual
  packets in the HomeBase `P2P` buffer from Camera A to be emitted after Camera B started.
- **Fix:** Never decode `properties.picture`. Key cached snapshots by both name and serial
  (`last_<name>_<serial>.jpg`). Serialize all `P2P` handovers via per-station `stationTransitions` (awaiting
  `stop_livestream` + 150ms settle delay, later raised to 250ms), update `cam.lastFrame` immediately on the first
  decoded keyframe of the session, and hold `cam.frame || cam.lastFrame` while `cam.active && cam.gotVideo`.
