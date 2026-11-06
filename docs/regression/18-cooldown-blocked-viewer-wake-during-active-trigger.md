# 18. Viewer Cooldown Must Not Block Wakes During Active Eufy Hardware Triggers

- **Symptom:** When a camera was in the post-viewer cooldown window (`view_cooldown_secs = 5s`), viewer wakes in Frigate
  Live View were blocked even though the camera hardware had an active motion or AI trigger.
- **Cause:** `isInViewerCooldown()` in `src/domain/camera.js` only checked the session state and elapsed time since
  sleep, without checking whether the camera had active hardware triggers (`activeTriggerEvents`, `motionUntil`).
- **Fix:** `isInViewerCooldown()` now checks `hasActiveHardwareTriggers()` first and returns `false` when motion or AI
  trigger events are active, allowing viewer wakes to proceed during cooldown while still guarding pure viewer re-wakes
  without triggers.
- **Files:** `src/domain/camera.js`
- **Tests:** `test/acceptance.test.js` (`AT-09`), `test/domain.test.js` (`isInViewerCooldown` with hardware triggers),
  `test/services.test.js` (`classifyViewerAction` during cooldown with triggers)
