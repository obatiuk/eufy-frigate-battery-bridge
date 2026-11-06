# 17. Back-to-Back Same-Station P2P Switching Lost ~2.5s Recording Window

- **Symptom:** When a waiting camera on the same station started immediately after another camera's session ended, the
  station wake pacing delay (`STATION_WAKE_PACING_MS = 2500ms`) was applied, causing the second camera to wait ~2.5s
  before starting and losing the first ~2.5s of the event recording.
- **Cause:** The per-station pacing mechanism in `arbitrateStationP2pSlot` and `wakeCameraExternal` always applied the
  `2500ms` delay after any wake START command on the same station, without distinguishing between (a) consecutive
  external/API wakes (where pacing prevents radio collisions) and (b) back-to-back switching where a station P2P slot
  was just released by a stopped session (where instant switching is required to preserve recording continuity).
- **Fix:** `stop()` (for non-RTSP sessions) and `handleDownloadFinishedEvent()` now clear `stationNextWakeAt` for the
  station when its P2P channel is released, allowing back-to-back camera wakes on the same station to start immediately
  with zero delay while still recording `STATION_WAKE_PACING_MS` whenever a fresh live START command
  (`wakeCameraExternal`, `activateRtspCamera`, or `arbitrateStationP2pSlot`, including preemptions) is issued. `AT-13`
  section 5 locks the instant-switching and pacing behavior.
- **Files:** `src/services/stream-orchestrator.js`
- **Tests:** `test/acceptance.test.js` (`AT-13`), `test/services.test.js` (back-to-back same-station switching test),
  `docs/acceptance/AT-13.md` section 5
