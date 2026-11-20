# 57. Make Frigate Mask Sync Safer & Warn Once per Missing Camera

- **Scope:** `src/services/frigate-masks.js`, `AT-17`, `AT-19`
- **Cause:** `syncSingleFrigateMaskSection()` fell back on non-`2xx` `PUT /api/config/set` responses to legacy
  `PUT /api/config/set?cameras.<name>.<section>.mask=<polygon>`, issuing a redundant failing request on modern `Frigate`
  and risking overwriting user-defined masks with a flat string. In addition, `syncCameraFrigateMasks()` silently
  returned `false` when `frigateCfg.cameras[cam.getName()]` was missing, leaving camera-name mismatches undiagnosed.
- **Fix:** Removed the legacy query-string `PUT` fallback from `syncSingleFrigateMaskSection()`, logging the structured
  warning directly from the JSON `PUT /api/config/set` HTTP status and validation body. Tracked missing camera names in
  `warnedMissingMaskCameras` (clearing when the camera appears in `frigateCfg.cameras` or on reset) so
  `syncCameraFrigateMasks()` logs one `log.warn` per missing camera episode without spamming every `60s` sync tick.
