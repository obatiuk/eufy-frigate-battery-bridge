/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 20. Stuck Spotlight Watchdog Switched Off a Light That a Recording Still Needed
 * (docs/regression/20-stuck-spotlight-watchdog-switched-off-recording-light.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME_STAGE_MARKERS} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');

describe('Regression 20. Stuck Spotlight Watchdog Switched Off a Light That a Recording Still Needed', () => {
  it('Regression 20: provides named domain predicates, filters, and comparators on Camera', () => {
    // Regression 20: provides named domain predicates, filters, and comparators on Camera.
    const t0 = 1710000000000;
    const rtspCam = new Camera({
      serial: 'T8161T0000000000',
      name: 'driveway',
      mode: 'rtsp',
      station_serial: 'T8030P0000000000',
    });
    rtspCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://127.0.0.1:8554/driveway');
    const p2pCam = new Camera({
      serial: 'T8214T2222222222',
      name: 'doorbell',
      mode: 'p2p',
      idle_timeout_secs: 15,
      station_serial: 'T8030P0000000000',
    });
    const allCams = [rtspCam, p2pCam];

    // 1. RTSP wake, session, and decoder predicates
    assert.equal(rtspCam.isActiveRtspSession(), false);
    assert.equal(rtspCam.canStartRtspStream(), false);
    assert.equal(rtspCam.wantsWake(t0), false);
    assert.equal(rtspCam.wantsRtspWake(t0), false);

    rtspCam.setMotionUntil(t0 + 60000);
    assert.equal(rtspCam.wantsWake(t0), true);
    assert.equal(rtspCam.wantsRtspWake(t0), true);
    assert.equal(p2pCam.wantsRtspWake(t0), false);
    assert.deepEqual(
      allCams.filter((c) => c.wantsRtspWake(t0)).map((c) => c.getName()),
      ['driveway']
    );

    rtspCam.setEventActive(true);
    rtspCam.beginSession('rtsp', t0, true);
    assert.equal(rtspCam.isActiveRtspSession(), true);
    assert.equal(rtspCam.isActiveLiveSession(), true);
    assert.equal(rtspCam.canStartRtspStream(), true);
    assert.equal(rtspCam.shouldFileInitialRtspEvent(), true);
    assert.equal(rtspCam.canSpawnRtspDecoder(rtspCam.getSessionId()), true);
    assert.equal(rtspCam.isEstablishedRtspStream(), false);

    rtspCam.markRtspFrameReceived(t0 + 1000);
    assert.equal(rtspCam.isEstablishedRtspStream(), true);
    assert.equal(rtspCam.hasExpiredLiveHold(t0 + 30000), false);
    assert.equal(rtspCam.hasExpiredLiveHold(t0 + 60000), true);

    // 2. Station P2P slot and early-sleep predicates
    assert.equal(p2pCam.belongsToStationP2pSlot('T8030P0000000000'), true);
    assert.equal(rtspCam.belongsToStationP2pSlot('T8030P0000000000'), false);
    p2pCam.setMotionUntil(t0 + 60000);
    p2pCam.setLastMotionAt(t0);
    assert.equal(p2pCam.isHoldingStationP2pForMotion('T8030P0000000000', t0), true);

    p2pCam.beginSession('p2p', t0, true);
    p2pCam.setGotVideo(true);
    assert.equal(p2pCam.isMotionOnlyActiveSession(t0 + 5000), true);
    assert.equal(p2pCam.canSleepEarlyOnIdle(t0 + 5000, 10000), false);
    assert.equal(p2pCam.canSleepEarlyOnIdle(t0 + 15000, 10000), true);
    assert.equal(p2pCam.isMidStreamRetrigger(t0 + 6000, 5000), true);

    // 3. Backfill download/query filters, station resolution, and comparators
    p2pCam.endSession(t0 + 16000, false, false, 'p2p');
    p2pCam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, false);
    assert.equal(p2pCam.getBackfillPriority(), p2pCam.getBasePriority() + 200);
    assert.equal(Camera.compareBackfillPriority(rtspCam, p2pCam) > 0, true);
    assert.equal(Camera.compareRtspFirst(rtspCam, p2pCam) < 0, true);
    assert.equal(p2pCam.resolveHomeBaseStationSerial(allCams), 'T8030P0000000000');
    assert.equal(p2pCam.isOnStation('T8030P0000000000'), true);
    assert.equal(p2pCam.isOnStation('OTHER_STATION'), false);
    assert.equal(p2pCam.canQueryBackfillNow(allCams, t0 + 25000, 8000, 12000, 5000), true);

    p2pCam.tryMatchBackfillCandidate({
      devSn: 'T8214T2222222222',
      storagePath: '/zx/clip1.zxvideo',
      cipherId: 0,
      clipMs: t0 + 1000,
    });
    assert.equal(p2pCam.canStartBackfillDownloadNow(allCams, t0 + 25000, 5000), true);

    // 4. Viewer, Frigate event, API wake duration, and startup summary helpers
    assert.equal(p2pCam.hasConnectedViewers(), false);
    p2pCam.pruneDisconnectedViewers(new Set(['v1', 'v2']), 2);
    assert.equal(p2pCam.hasConnectedViewers(), true);
    p2pCam.setFrigateEventPerson('Alice');
    assert.equal(p2pCam.isNonSyntheticFrigateEvent({sub_label: 'eufy'}), false);
    assert.equal(p2pCam.isNonSyntheticFrigateEvent({sub_label: 'Alice'}), false);
    assert.equal(p2pCam.isNonSyntheticFrigateEvent({data: {type: 'api'}, sub_label: null}), false);
    assert.equal(
      p2pCam.isNonSyntheticFrigateEvent({data: {type: 'object'}, sub_label: 'Alice'}),
      true,
      'Real Frigate detector object (data.type === "object") must extend hold even if sub_label matches evPerson'
    );
    assert.equal(p2pCam.isNonSyntheticFrigateEvent({sub_label: null}), true);
    assert.equal(p2pCam.resolveApiWakeDurationSecs(undefined, 5), 60);
    assert.equal(p2pCam.resolveApiWakeDurationSecs(2, 5), 5);
    assert.equal(p2pCam.shouldClearQueueForSigUsr1Test(), true);
    assert.equal(p2pCam.formatStartupSummary(), 'doorbell(p2p:60s)');

    // 5. Fast continuation across timeout boundary when hardware triggers remain active or split clips are queued
    rtspCam.beginSession('rtsp', t0, true);
    rtspCam.setGotVideo(true);
    rtspCam.setLastMotionAt(t0);
    rtspCam.setMotionUntil(t0 + 60000);
    rtspCam.addActiveTriggerEvent('motion detected');
    assert.equal(rtspCam.hasActiveHardwareTriggers(), true);
    assert.equal(
      rtspCam.shouldRewakeRtspOnDrop(t0 + 60000),
      true,
      'Must re-wake RTSP at 60s clip boundary when Eufy hardware trigger has not cleared yet'
    );
    rtspCam.recordMotionCleared(t0 + 60000, 5000, 10000, 'motion detected');
    assert.equal(rtspCam.hasActiveHardwareTriggers(), false);

    // Once motion has cleared and the full 60s hold_secs has elapsed since lastMotionAt, a
    // hardware RTSP clip stop sleeps cleanly; however, if the camera cuts off RTSP at t=40s
    // (before the 60s hold_secs has elapsed), it MUST re-wake to finish the 60s hold!
    rtspCam.setFirstVideoAt(t0 + 2000);
    rtspCam.setMotionUntil(t0 + 60000);
    rtspCam.recordMotionCleared(t0 + 10000, 5000, 10000, 'motion detected');
    assert.equal(
      rtspCam.shouldRewakeRtspOnDrop(t0 + 40000),
      true,
      'Must re-wake RTSP when hardware closes stream at 40s (20s before 60s hold_secs expires) ' +
        'even if PIR cleared at 10s'
    );
    rtspCam.recordMotionCleared(t0 + 60000, 5000, 10000, 'motion detected');
    rtspCam.setMotionUntil(t0 + 90000);
    assert.equal(
      rtspCam.shouldRewakeRtspOnDrop(t0 + 66000),
      false,
      'Must not force RTSP re-wake once full 60s hold_secs has elapsed since lastMotionAt and ' +
        'no Frigate object is active'
    );
    assert.equal(
      rtspCam.evaluateFrigateEventsActivity(
        [{id: 'obj-1', label: 'person', data: {type: 'object'}, end_time: (t0 + 60000) / 1000}],
        t0 + 66000
      ),
      true,
      'Recently finished Frigate object track (6s ago) must count as active object activity ' +
        'when remaining tail is short'
    );
    assert.equal(
      rtspCam.shouldRewakeRtspOnDrop(t0 + 66000),
      true,
      'Must re-wake RTSP at 66s when Frigate recently detected a person at 60s'
    );

    // Mid-stream Eufy events in the second half of hold_secs guarantee at least a full hold_secs window from now,
    // and extending motionUntil past evUntil re-queues Frigate event creation so recordings are never cut off early
    const extendCam = new Camera({serial: 'T8161T0000000000', mode: 'rtsp', hold_secs: 60});
    extendCam.applyMotionTrigger(t0, 'motion detected', 60000, 'eufy-event', 10);
    extendCam.beginSession('rtsp', t0, true);
    extendCam.setGotVideo(true);
    extendCam.setFirstVideoAt(t0 + 1000);
    extendCam.setFirstFrameAt(t0 + 1000);
    assert.equal(extendCam.tryUpgradeOrQueueFrigateEvent('motion', '', t0 + 1000).status, 'queued');
    extendCam.beginFrigateSnapshotWait();
    const initialFiling = extendCam.completeFrigateEventFiling(t0 + 2000, 15);
    assert.equal(initialFiling.durationSecs, 60);
    extendCam.recordCreatedFrigateEvent('synth-evt-1');
    assert.equal(
      extendCam.evaluateFrigateEventsActivity([{id: 'synth-evt-1', label: 'motion', end_time: null}], t0 + 10000),
      false,
      'Bridge must ignore its own synthetic Frigate event ID when checking for detector object activity'
    );

    // Mid-stream trigger in first half (t=20s) extends by +30s (to t=90s); companion trigger
    // 100ms later does not double-add +30s
    extendCam.applyMotionTrigger(t0 + 20000, 'motion detected', 60000, 'eufy-event', 10);
    assert.equal(extendCam.getMotionUntil(), t0 + 90000);
    extendCam.applyMotionTrigger(t0 + 20100, 'person detected', 60000, 'eufy-event', 200);
    assert.equal(extendCam.getMotionUntil(), t0 + 90000, 'Companion event 100ms later must not double-add halfMs');

    // Because motionUntil (t+90s) now exceeds evUntil (t+62s) + 5s (and label upgraded motion -> person),
    // tryUpgradeOrQueueFrigateEvent during COOLDOWN re-queues the Frigate event for the remaining hold duration
    assert.equal(extendCam.shouldExtendFrigateEvent(t0 + 20100, 15), true);
    assert.equal(
      extendCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', t0 + 20100).status,
      'queued',
      'Must re-queue Frigate event during cooldown when hold extends beyond evUntil or label/person upgrades'
    );
    extendCam.beginFrigateSnapshotWait();
    const extendedFiling = extendCam.completeFrigateEventFiling(t0 + 21000, 15);
    assert.equal(
      extendedFiling.durationSecs,
      69,
      'Extended Frigate event duration must cover the full remaining 69s of motionUntil'
    );

    // Mid-stream trigger in second half (t=85s, 5s before t=90s timeout) grants a full 60s hold from t=85s (to t=145s)
    extendCam.applyMotionTrigger(t0 + 85000, 'person detected', 60000, 'eufy-event', 200);
    assert.equal(
      extendCam.getMotionUntil(),
      t0 + 145000,
      'Mid-stream event near timeout must guarantee a full 60s hold window from the new event timestamp'
    );

    // Mid-session RTSP re-wake refreshes stale waking card snapshot when lastFrame was updated during live streaming
    let cardRenderCount = 0;
    const snapCam = new Camera(
      {serial: 'T8161T0000000000', mode: 'rtsp'},
      {frame: Buffer.alloc(1382400, 0x10), lastSeen: '19:09'},
      (c) => {
        cardRenderCount++;
        c.commitRenderedCards({
          asleep: c.getAsleepCardBuffer(),
          waking: c.getWakingCardBuffer(),
          busy: c.getBusyCardBuffer(),
        });
      }
    );
    snapCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://127.0.0.1:8554/driveway');
    assert.equal(cardRenderCount, 1);
    snapCam.beginSession('rtsp', t0, true);
    const liveBuf = Buffer.alloc(1382400, 0x55);
    snapCam.recordDecodedFrame(liveBuf, liveBuf, t0 + 2000, '19:10');
    snapCam.beginRtspRewake(t0 + 40000, 20000);
    snapCam.selectEncoderFrame(t0 + 43000, 2000);
    assert.equal(
      cardRenderCount >= 2,
      true,
      'Must re-render status cards with latest live frame before displaying waking card on mid-session re-wake'
    );

    // Natural timer expiration enforces the 3s post-sleep guard and in-flight stop guard so
    // trailing packets/events from our own closing P2P session never self-adopt as an external wake
    p2pCam.beginSession('p2p', t0, true);
    p2pCam.setGotVideo(true);
    p2pCam.terminateSession(t0 + 60000, 'hold/view timer expired', false, 'bridge-timer');
    assert.equal(
      p2pCam.canAdoptExternalWake(t0 + 60500, 3000),
      false,
      'Natural timer expiration must enforce the 3s post-sleep guard against trailing packets/events'
    );
    assert.equal(
      p2pCam.canAdoptExternalWake(t0 + 64000, 3000),
      false,
      'Must block external wake adoption while P2P stop_livestream is still in flight'
    );
    assert.equal(
      p2pCam.evaluateExternalLivestreamStop(t0 + 60200, 3000).action,
      'inactive',
      'Bridge-initiated stop_livestream completion must return inactive while stoppingP2p is active'
    );
    p2pCam.clearP2pStopInFlight();
    assert.equal(
      p2pCam.canAdoptExternalWake(t0 + 64000, 3000),
      true,
      'Must allow external wake adoption once P2P stop has settled and 3s guard has elapsed'
    );

    // Default experimental track_stuck_spotlight=false leaves spotlight untouched even past 130s
    const defaultUntrackedCam = new Camera({
      serial: 'T8161T9999999997',
      name: 'garage_default_light',
      mode: 'rtsp',
      station_serial: 'T8030P0000000000',
    });
    defaultUntrackedCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://192.168.1.50/live4');
    assert.equal(defaultUntrackedCam.hasStuckSpotlightTracking(), false);
    defaultUntrackedCam.applyTelemetryProperties({light: true, battery: 80, wifiRssi: -72}, false, t0);
    defaultUntrackedCam.setSleptAt(t0 + 1000);
    assert.equal(defaultUntrackedCam.shouldTurnOffStuckIdleLight(t0 + 200000), false);
    for (let i = 1; i <= 4; i++) {
      assert.equal(defaultUntrackedCam.recordIdleRssiChange(t0 + 200000 + i * 2000), false);
    }

    // Idle wedged P2P radio & stuck spotlight detection when track_stuck_spotlight=true:
    // - Never triggers on startup before any session has run (sleptAt=0, lastStoppedAt=0) when spotlight is off
    // - Triggers recordIdleRssiChange when light=true is stuck on while idle or >15s after a completed session
    const freshStartupCam = new Camera({
      serial: 'T8161T9999999999',
      name: 'garage_backfill',
      mode: 'backfill',
      track_stuck_spotlight: true,
      station_serial: 'T8030P0000000000',
    });
    assert.equal(freshStartupCam.hasStuckSpotlightTracking(), true);
    for (let i = 0; i < 5; i++) {
      assert.equal(
        freshStartupCam.recordIdleRssiChange(t0 + i * 2000),
        false,
        'Must not trigger wedged-radio stop on startup before any bridge session has run when light is off'
      );
    }

    // If spotlight turns on and gets stuck while idle, recordIdleRssiChange and shouldTurnOffStuckIdleLight detect it
    freshStartupCam.applyTelemetryProperties({light: true, battery: 80, wifiRssi: -72}, false);
    assert.equal(freshStartupCam.isSpotlightOn(), true);
    assert.equal(freshStartupCam.recordIdleRssiChange(t0 + 20000), false);
    assert.equal(freshStartupCam.recordIdleRssiChange(t0 + 22000), false);
    assert.equal(freshStartupCam.recordIdleRssiChange(t0 + 24000), false);
    assert.equal(
      freshStartupCam.recordIdleRssiChange(t0 + 26000),
      true,
      '4th idle wifiRssi change while spotlight is stuck on must trigger idle drain recovery'
    );
    assert.equal(
      freshStartupCam.shouldTurnOffStuckIdleLight(Date.now() + 1000),
      false,
      'Grace must outlast a hardware clip'
    );
    assert.equal(freshStartupCam.shouldTurnOffStuckIdleLight(Date.now() + 200000), true);
    assert.equal(freshStartupCam.isSpotlightOn(), false);

    // Regression: recordIdleRssiChange must not treat a freshly lit spotlight (<=130s) or pending BackfillJob as stuck
    const freshLightRtspCam = new Camera({
      serial: 'T8161T9999999998',
      name: 'patio_rtsp',
      mode: 'rtsp',
      track_stuck_spotlight: true,
      station_serial: 'T8030P0000000000',
    });
    freshLightRtspCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://192.168.1.50/live3');
    const tClip = 500000;
    freshLightRtspCam.applyTelemetryProperties({light: true, battery: 85}, false, tClip);
    for (let i = 1; i <= 4; i++) {
      assert.equal(
        freshLightRtspCam.recordIdleRssiChange(tClip + i * 2000),
        false,
        'Freshly lit spotlight within 130s grace must not trigger wedged-radio stop during hardware clip'
      );
    }
    freshLightRtspCam.queueEventBackfill(tClip, 'motion detected', '', 'motion detected', 10, true);
    freshLightRtspCam.clearActiveTriggerEvents();
    for (let i = 1; i <= 4; i++) {
      assert.equal(
        freshLightRtspCam.recordIdleRssiChange(tClip + 140000 + i * 2000),
        false,
        'Active recording BackfillJob must block idle RSSI wedged-radio stop even after 130s'
      );
    }
    freshLightRtspCam.clearPendingBackfill();
    assert.equal(freshLightRtspCam.recordIdleRssiChange(tClip + 150000), false);
    assert.equal(freshLightRtspCam.recordIdleRssiChange(tClip + 152000), false);
    assert.equal(freshLightRtspCam.recordIdleRssiChange(tClip + 154000), false);
    assert.equal(
      freshLightRtspCam.recordIdleRssiChange(tClip + 156000),
      true,
      'Spotlight stuck past 130s grace with no pending BackfillJob must trigger idle drain recovery'
    );

    const idleBase = t0 + 90000;
    assert.equal(p2pCam.recordIdleRssiChange(idleBase + 1000), false);
    assert.equal(p2pCam.recordIdleRssiChange(idleBase + 3000), false);
    assert.equal(p2pCam.recordIdleRssiChange(idleBase + 15000), false);
    assert.equal(
      p2pCam.recordIdleRssiChange(idleBase + 17000),
      true,
      '4th wifiRssi change within 60s after a completed session must trigger wedged-radio force-stop once'
    );
    assert.equal(
      p2pCam.recordIdleRssiChange(idleBase + 25000),
      false,
      'Must respect cooldown after triggering wedged-radio force-stop'
    );
    for (let i = 0; i < 5; i++) {
      assert.equal(
        p2pCam.recordIdleRssiChange(idleBase + 120000 + i * 2000),
        false,
        'Must not re-trigger wedged-radio force-stop in an infinite loop while no new session has run'
      );
    }

    // Transient wakeTimedOutOffline clears on normal standby properties even when battery is
    // <= low_battery_threshold (20%)
    p2pCam.markWakeTimedOut();
    assert.equal(p2pCam.isDeviceOffline(), true);
    p2pCam.applyTelemetryProperties({state: 0, battery: 15, wifiRssi: -25}, false);
    assert.equal(
      p2pCam.isDeviceOffline(),
      false,
      'Healthy standby telemetry (state=0, battery=15%, rssi=-25) must clear transient ' +
        'wakeTimedOutOffline even below 20% low battery threshold'
    );

    // Split backfill clips skip the 2.5s post-playback hold when another clip is already queued in backfillClipQueue
    p2pCam.beginBackfillDownload(
      {
        storagePath: '/zx/clip1.zxvideo',
        cipherId: 0,
        clipMs: t0,
        event: 'person detected',
        personName: 'Alice',
        reason: 'person detected (Alice)',
      },
      false,
      t0
    );
    p2pCam.setGotVideo(true);
    p2pCam.setFirstFrameAt(t0 + 500);
    p2pCam.setLastVideoAt(t0 + 5000);
    p2pCam.markDownloadFinished(t0 + 5000);
    p2pCam.setBackfillClipQueue([
      {
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 0,
        clipMs: t0 + 30000,
        event: 'person detected',
        personName: 'Alice',
        reason: 'person detected (Alice)',
      },
    ]);
    assert.equal(
      p2pCam.isDownloadComplete(t0 + 6100, 3000, 2500, 4500),
      true,
      'Must complete clip 1 immediately after decoder flush (without 2.5s postPlaybackHoldMs) when clip 2 is queued'
    );

    // Back-to-back doorbell clips: while Clip 1 is draining in RAM (downloadFinished=true), a newly settled
    // pendingBackfill job can query HomeBase in the background, skips the 2.5s postPlaybackHoldMs, and keeps
    // isStreamingLive() === true across the brief Clip 2 handshake so the stream never flashes the Asleep (S) card
    p2pCam.setBackfillClipQueue([]);
    p2pCam.setBackfillClip(null);
    p2pCam.setLastBackfillQueryAt(0);
    const tNewTrigger = t0 + 5200;
    p2pCam.queueEventBackfill(tNewTrigger, 'person detected', '', 'person detected', 200, true);
    p2pCam.recordMotionCleared(tNewTrigger + 9000, 5000, 10000, 'person detected');
    assert.equal(p2pCam.getPendingBackfillJob().recordingActive, false);
    assert.equal(p2pCam.getActiveBackfillJob().recordingActive, false);
    assert.equal(
      p2pCam.canQueryBackfillNow([p2pCam], tNewTrigger + 13500, 8000, 12000, 5000),
      true,
      'Must allow background HomeBase database query for Clip 2 while Clip 1 is draining buffered frames in RAM'
    );
    assert.equal(
      p2pCam.isDownloadComplete(t0 + 6100, 3000, 2500, 4500),
      true,
      'Must skip 2.5s postPlaybackHoldMs when a new pendingBackfill job is waiting'
    );
    p2pCam.setCurrentFrameBuffer(Buffer.alloc(1382400, 0x44));
    p2pCam.terminateSession(
      tNewTrigger + 14000,
      'post-event clip download stream completed',
      false,
      'eufy/download-finished'
    );
    p2pCam.beginBackfillDownload(
      {
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 0,
        clipMs: tNewTrigger,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      },
      false,
      tNewTrigger + 14010
    );
    assert.equal(
      p2pCam.isStreamingLive(tNewTrigger + 14100, 2000),
      true,
      'Back-to-back continuation clip must hold Clip 1 final frame as live video during Clip 2 ' +
        'handshake instead of flashing Asleep card'
    );
    assert.equal(
      p2pCam.getFrameMarker(),
      FRAME_STAGE_MARKERS.BACKFILL,
      'Back-to-back continuation clip must keep BACKFILL (B) marker during handshake instead of ' +
        'flashing SNAPSHOT (S) or FIRST_BACKFILL (FB)'
    );

    // Mid-session RTSP re-wake and Frigate event expiry polling:
    // 1. shouldPollFrigateForHoldOrBackfill must trigger when evUntil is within checkWindowMs (12s)
    //    even if beginRtspRewake pushed motionUntil out to 20s
    // 2. isReadyForEventSnapshot must return true immediately for mid-session event extensions
    //    (evDispatchedAt > 0) even while rtspRewaking has no fresh frame
    // 3. hasRecentRtspStartAttempt detects start_rtsp_livestream calls within 2s to prevent duplicate wake resets
    extendCam.setMotionUntil(t0 + 95000);
    extendCam.setFrigateEventUntil(t0 + 81000);
    extendCam.setLastExtendCheckAt(0);
    assert.deepEqual(
      extendCam.shouldPollFrigateForHoldOrBackfill(t0 + 75000, 12000, 5000, 4000),
      {shouldPoll: true, needsTimeoutExtendCheck: true},
      'Must poll Frigate and extend evUntil when evUntil is within 12s even if motionUntil is 20s away'
    );
    extendCam.setFrameTimestamp(t0 + 70000);
    extendCam.setLastFrameBuffer(Buffer.alloc(1382400, 0x66));
    extendCam.beginRtspRewake(t0 + 75000, 20000);
    assert.equal(extendCam.hasRecentRtspStartAttempt(t0 + 76000, 2000), true);
    assert.equal(extendCam.hasRecentRtspStartAttempt(t0 + 78000, 2000), false);
    assert.equal(
      extendCam.isReadyForEventSnapshot(t0 + 76000, 1500, 1500, 5000),
      true,
      'Mid-session Frigate event extension must not block waiting for a fresh frame when ' +
        'gotVideo and lastFrame are already established'
    );
  });
});
