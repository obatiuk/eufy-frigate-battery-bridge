# 41. In-Flight `WAITING_SNAPSHOT` Frigate Event Aborted When Session Ends Without Video

- **Scope:** `src/domain/camera.js`, `src/services/frigate-client.js`
- **Cause:** `endSession()` only canceled pending Frigate event filing when `this.evTimer` had not yet fired (`QUEUED`
  within the initial `600ms` dispatch window). Once `evTimer` fired and transitioned `evState` to `WAITING_SNAPSHOT`
  (`evTimer === null`), if `device.start_download` failed, timed out, or a backfill or live session was preempted before
  decoding Frame 0 (`!hadVideo`), the `200ms` snapshot-wait loop exited on `!cam.isSessionActive()` and still injected a
  cached snapshot and POSTed `/api/events/.../create` before the `4s` backfill retry filed a duplicate event.
- **Fix:** Added a monotonic `evWaitId` token and `abortPendingFrigateEvent()` on `Camera` (called in `endSession()`
  whenever `!hadVideo`) to cancel both `QUEUED` and in-flight `WAITING_SNAPSHOT` requests and immediately reset
  `evState` to `IDLE`, and checked `isFrigateSnapshotWaitActive(waitId)` inside `frigateEvent()` while preserving
  clean-snapshot fallback for wakes that remain active past the snapshot wait window (`AT-17.3`).
- **Tests:** `test/services.test.js`.
