# 8. Duplicate Startup Mask Sync & Post-Viewer Linger `RTSP` Re-Wake Loops

- **Scope:** Duplicate Startup Mask Sync, Post-Viewer Linger RTSP Re-Wake Loops & Lingering Station Stream Preemption

- **Cause 1:** `syncFrigateMotionMasks` ran twice on startup (via a redundant `2500ms` timer in `src/app.js` and an
  uninitialized `lastMaskCheckAt = 0` in `frigate-client.js`), and Frigate's `GET /api/config` omits `objects.mask`
  at the camera root when only `motion.mask` is serialized in memory.
- **Cause 2:** When a viewer closed Live View on an RTSP camera (`viewers.size === 0`, lingering for `20s`), a
  clip-boundary drop triggered `handleRtspStreamDropped`, which reset `viewUntil = now + LINGER_MS`
  (`view_linger_secs`) and called `startRtspStream` in a loop.
- **Cause 3:** When clicking Back to the Frigate multi-camera dashboard while 1 camera was still active, the 2
  sleeping cameras connected simultaneously (`camerasWithNewViewers.length === 2` while
  `anyCameraAlreadyActive === true`), bypassing `isDashboardGrid` and waking the second camera; conversely, opening a
  second camera on the same HomeBase while the first was lingering with 0 viewers caused RTSP/P2P contention on the
  HomeBase.
- **Fix:** Removed the duplicate startup timer, initialized `lastMaskCheckAt = Date.now()`, and checked both
  `motion.mask` and `objects.mask` sections independently; added `Camera.shouldRewakeRtspOnDrop(now)` so RTSP drops
  during 0-viewer post-linger stop cleanly (`initiator=eufy/rtsp-end`); updated `isDashboardGrid` to catch `>= 2`
  simultaneous sleeping camera connections whenever `< 2` cameras are active; and added
  `Camera.shouldYieldToNewStationViewer(targetCam, now)` so 0-viewer lingering `P2P` streams on the same HomeBase stop
  immediately (`initiator=viewer-preempt`) when the user opens another `P2P` camera while keeping `RTSP` Live Views
  open in parallel (`AT-14`).
