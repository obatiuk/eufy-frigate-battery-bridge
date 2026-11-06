# 12. Delayed Offline Battery-Swap Recovery & Early Pre-Decoder Audio Drop

- **Scope:** Delayed Offline Battery-Swap Recovery, Early Pre-Decoder Audio Drop & Stream Continuation Across Timeout
  Boundaries

- **Cause 1 (Delayed Offline Battery-Swap Recovery):** `eufy-security-ws` does not receive push events on a physical
  battery swap and only updates its cached battery reading when `driver.poll_refresh` is called;
  `Telemetry.applyProperties(props)` only cleared `OFFLINE_LOWBAT` (`state = 3`) when `!('state' in props)`, leaving
  sticky `state = 3` offline even when `battery = 100`; `pollViewers` and `/api/wake/:cameras` did not trigger
  `driver.poll_refresh` when a human opened the Frigate dashboard while a camera was offline; and when
  `startEncoder(cam)` resumed, its `2s` keyframe burst expired before Frigate's `FFmpeg Frigate` consumer
  reconnected.
- **Cause 2 (Pre-Decoder Audio Drop):** `enqueueOrWriteAudioPacket` dropped early `AAC` audio packets arriving before
  the `ffmpeg` decoder spawned on the first video keyframe (`!this.dec`).
- **Cause 3 (Stream Continuation Across `hold_secs` Timeout):** (a) When movement continued past `hold_secs` (`60s`),
  Eufy's hardware sensor kept `activeTriggerEvents` active without emitting a new `state: true` event, and
  `evaluateActiveHoldExtension` / `shouldRewakeRtspOnDrop` ignored `hasActiveHardwareTriggers()`, putting the camera
  to sleep at `60s`; (b) `isNonSyntheticFrigateEvent(ev)` rejected real Frigate detector `person` tracks
  (`ev.data.type === 'object'`) whenever `ev.sub_label` matched `this.evPerson`; and (c) multi-clip backfill playback
  waited `2.5s` (`postPlaybackHoldMs`) between split clips and `12s` (`BACKFILL_QUERY_COOLDOWN_MS`) between
  `HomeBase` queries.
- **Fix:** Updated `Telemetry.applyProperties` to clear `OFFLINE_LOWBAT` / `OFFLINE` whenever `charging` is true or
  `battery` recovers above the low-battery threshold; added on-demand `driver.poll_refresh` hooks in `pollViewers`
  and `/api/wake/:cameras`, plus `notifyEncoderConsumersObserved()` to trigger a `15 fps` keyframe burst on `go2rtc`
  consumer attach; buffered pre-decoder `AAC` packets in `enqueueOrWriteAudioPacket`; added
  `Camera.hasActiveHardwareTriggers()` so `evaluateActiveHoldExtension`, `shouldRewakeRtspOnDrop`, and
  `beginRtspRewake` automatically extend the hold and re-wake when hardware triggers remain active at the `60s`
  boundary; updated `isNonSyntheticFrigateEvent` to accept `ev.data?.type === 'object'`; skipped redundant
  `device.set_property(rtspStream: true)` once `rtspEnabledChecked` is true; and skipped `postPlaybackHoldMs` when
  another clip is queued or pending while lowering `BACKFILL_MIN_EVENT_AGE_MS` and `BACKFILL_QUERY_COOLDOWN_MS` to
  `4s`.
