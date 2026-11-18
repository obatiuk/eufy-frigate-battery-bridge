# 43. Backfill Clip Event Label Preserved When Extending Frigate Events on Download Finished

- **Scope:** `src/domain/camera.js`, `src/services/frigate-client.js`, `src/services/stream-orchestrator.js`
- **Cause:** When a long HomeBase backfill clip finished transferring and buffered frames required extending the active
  Frigate event (`shouldExtendFrigateEvent()`), `handleDownloadFinishedEvent()` passed `cam.getReason()`
  (`"backfill: <reason>"`) into `frigateEvent()` instead of the matched clip's hardware event or upgraded `evLabel`, and
  `resolveFrigateEventLabel()` did not match already-mapped Frigate labels such as `"car"`. If an `/api/wake` request
  had overridden `reason` (for example `"driveway sensor"` on a `"person detected"` clip) and `evUntil` elapsed during
  the transfer, the extended Frigate event downgraded to `"motion"`.
- **Fix:** Added `getBackfillEventLabel()` and `getBackfillEventPerson()` on `Camera` to supply the matched
  `activeBackfillClip` event (or an upgraded non-motion `evLabel`) and recognized person in
  `handleDownloadFinishedEvent()`, and updated `resolveFrigateEventLabel()` to preserve already-resolved Frigate labels
  from `LABELS`.
- **Tests:** `test/services.test.js`.
