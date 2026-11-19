# 49. Frigate Event POST Failure Cooldown Rollback & Scoped Card Suppression

- **Cause:** `frigateEvent()` in `src/services/frigate-client.js` called `completeFrigateEventFiling()` before
  `POST /api/events/<cam>/<label>/create` and held `enableCleanSnapshotCardSuppression()` in an outer `try/finally`
  spanning the `1.5s` review lookup delay and `5s` `GET /api/review` call. When the `POST` failed (`500` or network
  timeout), the camera stayed stuck in `COOLDOWN` until `evUntil`, dropping subsequent triggers for an event that was
  never created in Frigate, while clean-snapshot card suppression hid live overlays for several extra seconds.
- **Fix:** Added `FrigateEventFiling.rollback()` (`Camera.rollbackFrigateEventFiling()`) to reset `until`,
  `dispatchedAt`, and state back to `IDLE` whenever the `POST` fails or returns no `event_id` (unless a newer companion
  filing already superseded `waitId`), and scoped `enableCleanSnapshotCardSuppression()` /
  `disableCleanSnapshotCardSuppression()` to an inner `try/finally` around snapshot injection and event `POST` only.
- **Tests:** `test/domain/camera/frigate-event-filing.test.js` (`rolls back a failed filing...`) and
  `test/regression/49-frigate-event-post-failure-rollback-and-card-suppression.test.js`.
