# Logging, priorities, and stream initiators

Read when: adding or changing a log line, a stop reason, or an `initiator=...` value.

## Structured Logging, Priorities & Stream Initiators

All log output in `app.js` and service modules must use `log.debug()`, `log.info()`, `log.warn()`, or `log.error()` with
a camera state object (or `'bridge'` for global events) as the first argument so every line is formatted identically for
Grafana Alloy / Loki ingestion (`[LEVEL]` is right-padded inside the brackets to `5` characters via
`.padEnd(LOG_LEVEL_NAME_WIDTH)` so the `[camera]` / `[bridge]` block always starts at the same column, and every log
line across all 4 severity levels for a stateful `Camera`, `BackfillJob`, decoder, or event scope automatically prefixes
its current uppercase `[STATE]` badge; omitted only on raw `CameraConfig` startup cache logs before `Camera`
construction):

    YYYY-MM-DD HH:MM:SS - [INFO ] - [bridge] message
    YYYY-MM-DD HH:MM:SS - [DEBUG] - [camera] [STATE] message

- **Timestamps:** Formatted via `formatLocalTimestamp()` (`YYYY-MM-DD HH:MM:SS`) using local `Date` getters (respecting
  `TZ`) with zero ICU locale dependencies so Grafana Alloy's ISO-8601 regex always matches.
- **Key-Value Context:** Lifecycle and stream interruption logs must include structured `key=value` pairs
  (`initiator=...`, `reason="..."`, `live=...s`, `gotVideo=...`, `lastVideoAgo=...`, `session=...`).

### Log Priority Levels

| Level   | Usage Guidelines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERROR` | Unrecoverable session or subsystem failures: startup `config.json` validation errors, `eufy-security-ws` socket/`start_listening` failures, `device.start_livestream` RPC failures (`initiator=eufy-ws`), all forced error `SLEEP` closures in `stop()` (`initiator=error/watchdog-timeout`, `error/rtsp-wake-timeout`, `error/download-failed`, `error/download-timeout`, `error/device-offline`, `error/ws-disconnect`, `error/station-disconnect`), wedged FFmpeg encoder `stdin` (>10s backpressure), unexpected FFmpeg encoder exits or spawn failures, HTTP server listen errors, Frigate HTTP event creation errors, and uncaught callback/process exceptions.                                                                                                                                                                                                                  |
| `WARN`  | Recoverable interruptions, fallbacks, or abnormal terminations: unsolicited `livestream stopped` from Eufy/camera while hold/view is still active (`initiator=eufy/camera`), preliminary WebSocket/station disconnect or backfill download RPC/timeout warnings before `stop()`, watchdog stall retries 1-3 (`initiator=bridge-watchdog`), `already_running` stale stream recovery (`initiator=bridge/eufy-ws`), late video/start events arriving after a session closed (`initiator=bridge`), hitting `stream_max_secs` or `view_max_secs` (`initiator=bridge-max-limit`, `initiator=bridge-view-limit`), offline camera telemetry transitions, hardware acceleration fallback to `libx264`, Frigate events created without live video, Home Assistant webhook failures, `driver.poll_refresh` failures or wedged station `P2P` recycles, and invalid/contradictory config fallbacks. |
| `INFO`  | Normal operational lifecycle: bridge and HTTP server startup/shutdown, `eufy-security-ws` connected/listening, HomeBase station reconnects, encoder startup, initial online camera telemetry, RTSP URL discovery, Eufy Power Manager property sync, battery economy mode transitions, `WAKE` / `WAKE [RTSP]` / `WAKE [BACKFILL DOWNLOAD]` / normal `SLEEP` transitions, `eufy livestream started`, first decoded keyframe timing, activity-cleared 5s countdown, mid-stream codec changes (`initiator=camera-stream`), Frigate event creation, and viewer connection decisions.                                                                                                                                                                                                                                                                                                        |
| `DEBUG` | High-frequency or diagnostic details (prefixed with `[STATE]` for stateful scopes): all 4 FSM transition logs (`session state`, `backfill state`, `decoder state`, `frigate event state`), routine telemetry refreshes, companion event deduplication, HomeBase local database queries, 750ms RTSP wake retries, clean `livestream stopped` confirmations after `SLEEP` (`initiator=bridge/eufy`), in-band resolution changes, mid-flight `start_livestream` cancellations when preempted (`initiator=bridge`), viewer disconnections, viewer queue clears, and snapshot cache read/write operations.                                                                                                                                                                                                                                                                                  |

## Stream Interruption & Lifecycle Initiators (`initiator=...`)

- `eufy-event`: Woken or hold-extended by a Eufy motion/person/pet/ring event.
- `eufy-ws`: Woken externally via `eufy-security-ws` and adopted by the bridge (or logged when `device.start_livestream`
  returns an RPC error).
- `api-wake`: Woken or extended via the `POST/GET /api/wake` or `/api/wake/:cameras` HTTP endpoint.
- `eufy/camera-event-end` / `eufy/rtsp-end` / `eufy/download-finished`: Cleanly ended by Eufy/HomeBase when the camera
  finishes its P2P event recording, RTSP stream, or post-event clip download.
- `eufy/camera`: Stream stopped by Eufy/HomeBase (`WARN` if hold/viewer is still active, or normal `INFO` `SLEEP` after
  hold/viewer expired).
- `viewer` / `viewer-preempt`: Woken, extended, or preempted by a human viewer connecting via `go2rtc`.
- `bridge-backfill`: Woken in `download` mode to replay a HomeBase event recording into Frigate
  (`device.start_download`), or used by `SIGUSR1` to free a non-motion `P2P` slot for test backfill.
- `bridge-probe` / `bridge-startup-probe`: Woken for initial startup snapshot capture and stopped once 2s of stable
  video is saved.
- `bridge-timer`: Normal `SLEEP` when both `hold_secs` and `view_linger_secs` timers expire.
- `bridge-early-sleep/eufy-cleared` / `bridge-early-sleep/quiet-timeout`: Closed early by optional battery saver once
  `idle_timeout_secs` has elapsed and Frigate confirms no active tracked objects.
- `bridge-arbitrator/motion-over-viewer` / `bridge-arbitrator/higher-priority-event` / `bridge-arbitrator/newer-motion`
  / `bridge-arbitrator/newer-viewer` / `bridge-arbitrator/live-over-download`: Active camera or backfill download
  preempted on the station P2P slot by a higher-priority or live request.
- `bridge-max-limit` / `bridge-view-limit`: Forced `SLEEP` upon reaching `stream_max_secs` or `view_max_secs`.
- `bridge`: Default `stop()` fallback, mid-wake cancellation when preempted/stopped, unsolicited video while inactive,
  or late `livestream started` arriving after a session closed.
- `bridge/eufy`: `DEBUG` confirmation when Eufy reports `livestream stopped` for an already-idle or stopping camera.
- `bridge/eufy-ws`: Forced stop/restart when `eufy-security-ws` reports `already_running` on a stale P2P session.
- `bridge-watchdog`: Stream stalled (`no_initial_video_after_wake` or `stream_stalled_mid_session`), triggering decoder
  reset and re-request (retries 1-3), or killing a wedged encoder process.
- `error/watchdog-timeout` / `error/rtsp-wake-timeout` / `error/download-failed` / `error/download-timeout`: Forced
  `ERROR` `SLEEP` after 3 failed P2P watchdog retries, 25s RTSP wake timeout, or failed/stalled clip download.
- `error/device-offline`: Forced `ERROR` `SLEEP` when `eufy-security-ws` reports a camera offline (`state != 1` or `0%`
  depleted battery while unplugged) during an active session.
- `error/ws-disconnect` / `error/station-disconnect`: Forced `ERROR` `SLEEP` across active cameras when
  `eufy-security-ws` or the station P2P connection drops.
- `camera-stream` / `ffmpeg-decoder`: Decoder reset triggered by an in-band video codec change (`H264` <-> `H265`) or
  unexpected FFmpeg decoder process exit.
- `system-shutdown`: Graceful stream stop on container `SIGTERM`/`SIGINT`.
