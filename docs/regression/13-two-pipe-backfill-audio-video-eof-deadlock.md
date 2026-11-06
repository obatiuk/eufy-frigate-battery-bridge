# 13. Two-Pipe Backfill Audio/Video EOF Deadlock & `RTSP` Re-Wake Loops

- **Scope:** Two-Pipe Backfill Audio/Video EOF Deadlock, Stale Waking Snapshot Flash on Mid-Session `RTSP` Re-Wake,
  Post-Motion `RTSP` Re-Wake Loops & Premature `RTSP` Handshake Kills

- **Cause 1 (Two-Pipe `ffmpeg` Audio/Video EOF Deadlock During Backfill Playback with `audio: true`):** When
  `audio: true` was enabled, `buildP2pDecoderArgs` spawned `ffmpeg` with two input pipes (`-f h264 -i pipe:0` and
  `-f aac -i pipe:3`). During burst `.zxvideo` downloads under backpressure (`decoderStdoutPaused = true`),
  `drainPendingDecoderInput` waited for **both**
  `pendingVideoPackets.length === 0 && pendingAudioPackets.length === 0` before calling `audioStream.end()`
  (`pipe:3`). Because `AAC` audio is tiny (`~40 KB`) relative to `H.264` video (`~4 MB`), `pendingAudioPackets`
  emptied into `pipe:3` long before `pendingVideoPackets`. Once `ffmpeg` decoded the last `AAC` packet in `pipe:3`,
  `pipe:3` had `0` bytes left while still open (`!ended`), causing `ffmpeg` to block waiting on `pipe:3` and stop
  reading `pipe:0` (`stdin`), wedging the backfill session in `DRAINING_BACKFILL_TAIL` for up to `5 minutes`
  (`view_max_secs`) and delaying subsequent doorbell backfill downloads so they collided with live camera streams.
- **Cause 2 (Stale Previous-Session Snapshot Flashed During Mid-Session `RTSP` Re-Wakes):** `renderCameraCards(cam)`
  was only called when a session ended (`stop()`), baking the previous session's snapshot into `cam.card.waking`.
  During a subsequent `RTSP` session, `recordDecodedFrame` updated `cam.lastFrame` on every live frame, but when
  `handleRtspStreamDropped` transitioned to `WAKING_RTSP` (`beginRtspRewake`), `cam.card.waking` was not re-rendered.
  Two seconds after each mid-session drop (`freshFrameMaxAgeMs = 2000ms`), `selectEncoderFrame` switched to
  `cam.card.waking`, flashing the stale snapshot from the previous session instead of the latest live frame.
- **Cause 3 (Forced `RTSP` Re-Wakes After Hardware Post-Motion Clip End & Spurious 30-Second
  `'rtsp livestream started'` Loop):** On `RTSP`-capable battery cameras, the camera hardware stops its `RTSP` stream
  `30s` after PIR motion clears (`state: false`). Because `shouldRewakeRtspOnDrop` did not check whether motion had
  already cleared (`didRtspMotionStreamFinishCleanly`), it forced the sleeping camera to re-wake into an empty room.
  Simultaneously, `eufy-security-ws` periodically emitted `'rtsp livestream started'` every `30s` on `RTSP`-enabled
  cameras, which `onEvent` treated as a mid-stream `+30s` hold extension while active.
- **Cause 4 (Premature `RTSP` Handshake Kills & Duplicate `start_rtsp_livestream` Resetting Bitrate):** During a
  mid-session `RTSP` re-wake, `HomeBase 3`'s `/live0` mount remained registered (`200 OK`) while the camera took
  `5.3-6.2s` to wake. Because `DEFAULT_RTSP_DEC_STALL_MS` (`4.5s`), `DEFAULT_RTSP_RETRY_MS` (`3.5s`), and
  `RTSP_SOCKET_TIMEOUT_US` (`2.5s`) were shorter than the camera wake time, `evaluateRtspHealth` killed the
  handshaking `ffmpeg` decoder (`code=183`) and re-sent `device.start_rtsp_livestream` mid-wake, resetting the
  camera's encoder to minimum quality and causing jerky video. Conversely, spawning `startRtspDecoder(cam)` _before_
  `device.start_rtsp_livestream` caused `ffmpeg` to read `0.3s` of cached tail frames from the previous session on
  `HomeBase 3`, exit with `code=0`, and trigger a duplicate `start_rtsp_livestream`.
- **Cause 5 (Incomplete Event Recordings from Early Hardware `RTSP` Stops, Unextended Frigate `COOLDOWN` Events,
  Mid-Session `RTSP` Re-Wake `evUntil` Blind Spot, Short Late-Window Extensions & Brief Object Occlusions):** (a)
  When Eufy's PIR sensor flipped `state: false` `~10s` into a visit and the camera firmware closed `RTSP` `30s` later
  (`t=40s`), `didRtspMotionStreamFinishCleanly` allowed the `60s` (`end_early: false`) stream to end `20s` early; (b)
  `tryUpgradeOrQueueFrigateEvent` returned `'cooldown'` whenever `now < evUntil`, and `handleRtspStreamDropped`
  pushed `motionUntil` out by `+20s` without extending `evUntil` or polling Frigate before `evUntil` expired; (c)
  `computeTriggerHoldUntil` used `Math.min(now + ms, wantUntil + halfMs)`, granting less than a full `hold_secs`
  window when a new Eufy event arrived in the second half of the hold; (d) `isFrigateCameraIdle` queried
  `&in_progress=1` only in the final `4s` window, missing objects that were momentarily occluded a few seconds
  earlier; and (e) radar/loitering/package/dog-activity events and boolean detection `'property changed'`
  notifications were not mapped to trigger extensions.
- **Fix:** Updated `drainPendingDecoderInput` to close `audioStream.end()` (`pipe:3`) immediately when
  `decoderInputEnded && pendingAudioPackets.length === 0` even while `pendingVideoPackets` is still draining; tracked
  `cam.lastRenderedSnapshot` in `commitRenderedCards` and `selectEncoderFrame` (and called `renderCameraCards(cam)`
  in `handleRtspStreamDropped`) so `card.waking` / `card.busy` / `card.asleep` always composite over the latest
  `lastFrame`; required `now - lastMotionAt >= getEventHoldMs() && !hasRecentFrigateObjectActivity(now)` in
  `didRtspMotionStreamFinishCleanly()` so `end_early: false` streams never stop before the full `hold_secs` window or
  while Frigate recently saw an object; ignored `'rtsp livestream started'` events when already established
  (`isEstablishedRtspStream()`) or on non-`RTSP` cameras; raised `RTSP_SOCKET_TIMEOUT_US` (`5.0s`),
  `DEFAULT_RTSP_RETRY_MS` (`10s`), `DEFAULT_RTSP_DEC_STALL_MS` (`7.5s`), and `DEFAULT_RTSP_MID_STALL_MS` (`5.0s`),
  and waited for `device.start_rtsp_livestream` before spawning `startRtspDecoder` (with `hasRecentRtspStartAttempt`
  retrying sub-`2s` initial drops without re-sending `start_rtsp_livestream`); extended Frigate API events
  (`shouldExtendFrigateEvent`, `tryUpgradeOrQueueFrigateEvent`, `isReadyForEventSnapshot`,
  `shouldPollFrigateForHoldOrBackfill`) whenever mid-stream triggers, `RTSP` re-wakes, Frigate object hold
  extensions, or backfill clips extend past `evUntil`; updated `computeTriggerHoldUntil` to
  `Math.min(maxAllowedUntil, Math.max(now + ms, extendedFromCurrent))` with `1s` companion-burst coalescing; widened
  `DEFAULT_HOLD_EXTEND_WINDOW_MS` to `12s` and added `evaluateFrigateEventsActivity` (`15s` recent-object tail
  window, excluding `lastCreatedFrigateEventId`); and added radar/loitering/package/dog-activity triggers plus
  `resolvePropertyTriggerEvent` for `'property changed'` detection signals.
