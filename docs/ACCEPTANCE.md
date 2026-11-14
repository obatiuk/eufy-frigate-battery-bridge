# Core System Acceptance Criteria (`ACCEPTANCE.md`)

> [!IMPORTANT]
> **Non-Negotiable System Invariants for Agents & Contributors:**
>
> 1. **Read the Matrix, the Index, and the Relevant Criteria Before Touching Code:** Read section 1 (the matrix) and
>    section 3 (the file and concern maps) of this document, then read every `docs/acceptance/AT-NN.md` listed for the
>    files and subsystem concern you change. `make check` always runs all 19 locked tests as a full safety net.
> 2. **1:1 Executable Acceptance Suite (`test/acceptance.test.js`):** Every acceptance criterion (`AT-01`-`AT-19`) has
>    one file in `docs/acceptance/` and one locked test in `test/acceptance.test.js` whose title starts with `AT-NN:`.
> 3. **Never Modify or Weaken Acceptance Tests Without Explicit User Confirmation:** Do **not** delete, skip, or weaken
>    any test in `test/acceptance.test.js` to make a build pass unless the user explicitly instructs you to change the
>    requirement. A requirement change edits the matching `docs/acceptance/AT-NN.md` and its test in the same change.

---

## 1. Camera Mode × Hardware Type × Trigger Source Matrix

Every camera resolves one of five operating modes (`"backfill"`, `"rtsp"`, `"p2p"`, `"auto"`, or `"custom"`, where
`"custom"` follows `"backfill"` when `backfill_only: true` and otherwise `"rtsp"` or `"p2p"` per `use_rtsp`, and a
camera with an explicit `rtsp_url` resolves `"rtsp"` and pulls directly without querying `eufy-security-ws`). The bridge
must strictly enforce the following behavior across all event and wake sources:

| Mode           | Hardware Type                    | Motion / AI / Ring Event While `IDLE` (`handleTriggerEvent`)            | Hardware `'rtsp livestream started'` / `'livestream started'` While `IDLE`                                                     | Human Frigate Live View (`pollViewers`)                                                     | `POST /api/wake/:cameras` (`wakeCameraExternal`) While `IDLE`                                         |
| :------------- | :------------------------------- | :---------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------- |
| **`backfill`** | **`RTSP`-capable camera**        | **Backfill only** (queues `BackfillJob`, stays `IDLE`, shows `Yellow`)  | `'rtsp'` or trigger-paired `'livestream'`: **Backfill only**; Eufy app `'livestream'` outside `3s` post-sleep guard: **`P2P`** | Wakes live **`RTSP`** (`eventActive: false`); **blocked (`Yellow`) if `BackfillJob` set**   | Wakes live **`RTSP`** if no Eufy trigger/backfill active; else **Backfill only**                      |
| **`backfill`** | **`P2P`-only camera / doorbell** | **Backfill only** (queues `BackfillJob`, stays `IDLE`, shows `Yellow`)  | `'rtsp'` or trigger-paired `'livestream'`: **Backfill only**; Eufy app `'livestream'` outside `3s` post-sleep guard: **`P2P`** | Wakes live **`P2P`** (`eventActive: false`); **blocked (`Yellow`) if `BackfillJob` set**    | Wakes live **`P2P`** if no Eufy trigger/backfill active; else **Backfill only**                       |
| **`rtsp`**     | **`RTSP`-capable camera**        | Wakes live **`RTSP`** (`eventActive: true`)                             | Adopts external **`RTSP`** or **`P2P`** wake outside `3s` post-sleep guard                                                     | Wakes live **`RTSP`** (`eventActive: false`); **blocked (`Yellow`) if `BackfillJob` set**   | Wakes live **`RTSP`**                                                                                 |
| **`rtsp`**     | **Direct `rtsp_url` camera**     | N/A (passively probes `rtsp_url` every `5s` without `eufy-security-ws`) | N/A (no `eufy-security-ws` RPCs; keeps sleeping card until Frame 0 decodes)                                                    | Pulls direct **`RTSP`** (`rtsp_url`, zero stream timeouts; never ignored by dashboard grid) | Unsupported (`422` when targeted directly; skipped as `status: "unsupported"` in `all`/mixed targets) |
| **`p2p`**      | **Any camera or doorbell**       | Wakes live **`P2P`** (`eventActive: true`)                              | Adopts external **`P2P`** wake outside `3s` post-sleep guard                                                                   | Wakes live **`P2P`** (`eventActive: false`); **blocked (`Yellow`) if `BackfillJob` set**    | Wakes live **`P2P`**                                                                                  |
| **`auto`**     | **`RTSP` or `P2P`**              | Same as **`rtsp`** if `RTSP`-capable, else **`p2p`**                    | Adopts **`RTSP`** (if capable) or **`P2P`** outside `3s` post-sleep guard                                                      | Live **`RTSP`** if capable, else **`P2P`**; **blocked (`Yellow`) if `BackfillJob` set**     | Live **`RTSP`** if `RTSP`-capable, else **`P2P`**                                                     |

---

## 2. Index of Locked Criteria (`AT-01` - `AT-19`)

| ID                           | Criterion                                                                                                          |
| :--------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| [AT-01](acceptance/AT-01.md) | `"backfill"` Mode on `RTSP`-Capable Cameras - Motion, `/api/wake` & Hardware Events While `IDLE`                   |
| [AT-02](acceptance/AT-02.md) | `"backfill"` Mode on `P2P`-Only Cameras & Doorbells - Motion, `/api/wake` & Hardware Events While `IDLE`           |
| [AT-03](acceptance/AT-03.md) | `"backfill"` Mode on `RTSP`-Capable Cameras - Human Frigate Live View vs. `/api/wake`                              |
| [AT-04](acceptance/AT-04.md) | `"backfill"` Mode on `P2P`-Only Cameras & Doorbells - Human Frigate Live View, `/api/wake` & Stray `RTSP` Recovery |
| [AT-05](acceptance/AT-05.md) | `"rtsp"`, `"p2p"`, and `"auto"` Modes - Motion Wakes, Direct `rtsp_url` Probes & Stream Adoption                   |
| [AT-06](acceptance/AT-06.md) | Per-Station `P2P` Arbitration vs. Parallel `RTSP` Independence                                                     |
| [AT-07](acceptance/AT-07.md) | Offline Detection, Deep-Standby Protection & Battery-Swap Recovery                                                 |
| [AT-08](acceptance/AT-08.md) | Post-Sleep `3s` Guard, Idle Wedged `P2P` Radio Recovery & Service Disruption Resilience                            |
| [AT-09](acceptance/AT-09.md) | Post-Viewer Linger Clean Termination & Trigger-Bypassed Viewer Cooldown                                            |
| [AT-10](acceptance/AT-10.md) | Hardware Power Manager Sync & Stuck Spotlight (`light`) Conservation                                               |
| [AT-11](acceptance/AT-11.md) | Mid-Stream Hold Extensions Across All Modes & Signal Sources                                                       |
| [AT-12](acceptance/AT-12.md) | `end_early: false` Mid-Session Re-Wake, `end_early: true` Clean End, Hard Duration Caps & `idle_timeout_secs`      |
| [AT-13](acceptance/AT-13.md) | Per-Station `P2P` Priority Preemption, Preempted Event Backfill & Instant Back-to-Back Switching                   |
| [AT-14](acceptance/AT-14.md) | Human Frigate Live View - Dashboard Grid Ignore, Same-Station Switching & Blocks                                   |
| [AT-15](acceptance/AT-15.md) | Proportional `20%` Safety-Net Backfill Cutoff & Bounded `120s` Recording Wait                                      |
| [AT-16](acceptance/AT-16.md) | Backfill `15 fps` Frame-0 Playback, Multi-Clip Continuity, Live `P2P` Isolation & Download Retry                   |
| [AT-17](acceptance/AT-17.md) | `POST /api/wake/:cameras`, Frigate Event Snapshots/Extensions, Auto-Masks & `HA_WEBHOOK_URL`                       |
| [AT-18](acceptance/AT-18.md) | 6-Color Status Palette, Debug HUD Service Statuses, Frame Pacing, Snapshot Isolation & `hwaccel` Fallback          |
| [AT-19](acceptance/AT-19.md) | YAML Config Validation, Env Endpoints, Direct `rtsp_url` Resolution, Clamping, Warnings & `/api/config`            |

## 3. File Map: Which Criteria to Read Before Changing a File

The matrix in section 1 always applies. `AT-NN` links are in the index above.

| File                                  | Read these criteria first                                                                 |
| :------------------------------------ | :---------------------------------------------------------------------------------------- |
| `src/domain/camera.js`                | Section 3.1 concern map (read the matching concern rows)                                  |
| `src/domain/backfill-job.js`          | AT-01, AT-02, AT-03, AT-04, AT-15, AT-16, AT-17                                           |
| `src/domain/telemetry.js`             | AT-07, AT-08, AT-10, AT-18, AT-19                                                         |
| `src/domain/status-card.js`           | AT-17, AT-18, AT-19                                                                       |
| `src/services/stream-orchestrator.js` | Section 3.1 concern map (read the matching concern rows)                                  |
| `src/services/eufy-client.js`         | AT-01, AT-02, AT-05, AT-06, AT-07, AT-08, AT-10, AT-16, AT-18                             |
| `src/services/frigate-client.js`      | AT-03, AT-04, AT-07, AT-08, AT-09, AT-11, AT-12, AT-14, AT-16, AT-17, AT-18               |
| `src/services/http-server.js`         | AT-01, AT-02, AT-03, AT-04, AT-08, AT-17, AT-19                                           |
| `src/services/ha-notifier.js`         | AT-17                                                                                     |
| `src/media/encoder.js`                | AT-07, AT-08, AT-14, AT-16, AT-18                                                         |
| `src/media/decoder.js`                | AT-05, AT-06, AT-16, AT-18                                                                |
| `src/overlay/*`                       | AT-17, AT-18                                                                              |
| `src/config.js`                       | AT-01, AT-02, AT-03, AT-04, AT-05, AT-06, AT-07, AT-10, AT-12, AT-13, AT-17, AT-18, AT-19 |
| `src/app.js`                          | AT-08                                                                                     |
| `src/logger.js`                       | AT-19                                                                                     |

### 3.1 Concern Map for `camera.js` and `stream-orchestrator.js`

`camera.js` and `stream-orchestrator.js` coordinate every camera mode and stream state, so read the `3`-`8` criteria
matching the subsystem concern(s) you touch instead of loading all `19` files at once:

| Subsystem concern in `camera.js` / `stream-orchestrator.js`                                        | Read these criteria first                              |
| :------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| `"backfill"` mode wakes, `/api/wake` routing, and clip download/playback                           | AT-01, AT-02, AT-03, AT-04, AT-13, AT-15, AT-16, AT-17 |
| `"rtsp"`, `"p2p"`, and `"auto"` mode wakes, direct `rtsp_url` probes, and stream adoption          | AT-05, AT-06, AT-08, AT-11, AT-12                      |
| Per-station `P2P` arbitration, priority preemption, and back-to-back switching                     | AT-06, AT-13, AT-14                                    |
| Mid-stream hold extensions, `end_early`, duration caps, and `idle_timeout_secs`                    | AT-11, AT-12, AT-17                                    |
| Human Frigate Live View, dashboard grid ignore, post-viewer linger, cooldown, and blocks           | AT-03, AT-04, AT-09, AT-11, AT-14                      |
| Offline / deep-standby protection, post-sleep `3s` guard, wedged `P2P` radio, Power Manager, light | AT-07, AT-08, AT-10                                    |
| `POST /api/wake/:cameras`, Frigate events/snapshots/masks, `HA_WEBHOOK_URL`, status colors, HUD    | AT-01, AT-02, AT-17, AT-18                             |
| Configuration resolution, identity/title defaults, direct `rtsp_url` isolation, and `/api/config`  | AT-05, AT-10, AT-12, AT-19                             |
