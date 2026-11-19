/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the Camera entity: mode derivation, arbitration, FSM transitions, direct RTSP lifecycle,
 * runtime summaries, collaborating accessors, and log scopes (src/domain/camera.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {initLogger} = require('../../src/logger');
const {BackfillJob} = require('../../src/domain/backfill-job');
const {Camera, SESSION_STATES} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');

afterEach(() => {
  mock.timers.reset();
});

describe('Camera & Telemetry Domain Models', () => {
  it('derives Eufy Power Manager property sync changes for "rtsp" and "backfill" modes', () => {
    // Verify: derives Eufy Power Manager property sync changes for "rtsp" and "backfill" modes.
    const rtspCam = new Camera({
      serial: 'T8161T0000000000',
      title: 'Storage Room Camera',
      mode: 'rtsp',
      priority: 50,
    });
    const backfillCam = new Camera({
      serial: 'T8214T2222222222',
      title: 'Front Doorbell',
      mode: 'backfill',
      priority: 100,
    });

    assert.equal(rtspCam.getName(), 'T8161T0000000000');
    assert.equal(backfillCam.getName(), 'T8214T2222222222');

    const rtspChanges = rtspCam.evaluateRecordingModeChanges({
      powerWorkingMode: {value: 0},
      recordingClipLength: {value: 20},
      recordingEndClipMotionStops: {value: true},
      recordingRetriggerInterval: {value: 5},
    });
    assert.deepEqual(rtspChanges, [
      {name: 'powerWorkingMode', currentValue: 0, targetValue: 2},
      {name: 'recordingClipLength', currentValue: 20, targetValue: 60},
      {name: 'recordingEndClipMotionStops', currentValue: true, targetValue: false},
    ]);

    const backfillChanges = backfillCam.evaluateRecordingModeChanges({
      powerWorkingMode: {value: 2},
      recordingClipLength: {value: 60},
      recordingEndClipMotionStops: {value: false},
      recordingRetriggerInterval: {value: 5},
    });
    assert.deepEqual(backfillChanges, [
      {name: 'recordingClipLength', currentValue: 60, targetValue: 30},
      {name: 'recordingEndClipMotionStops', currentValue: false, targetValue: true},
    ]);
  });

  it('isolates station idle checks so active RTSP cameras never block P2P backfill downloads', () => {
    // Verify: isolates station idle checks so active RTSP cameras never block P2P backfill downloads.
    const rtspCam = new Camera({
      serial: 'T8161T0000000000',
      mode: 'rtsp',
      station_serial: 'T8030T0000000000',
    });
    rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live0');
    const doorbellCam = new Camera({
      serial: 'T8214T2222222222',
      mode: 'backfill',
      station_serial: 'T8030T0000000000',
    });

    const now = 100000;
    rtspCam.setSessionActive(true);
    rtspCam.setActiveMode('rtsp');
    rtspCam.setSleptAt(now - 500);

    doorbellCam.setSessionActive(false);
    doorbellCam.setSleptAt(now - 10000);

    assert.equal(doorbellCam.shouldBackfillOnlyOnEvent(), true);
    assert.equal(rtspCam.shouldBackfillOnlyOnEvent(), false);
    assert.equal(
      doorbellCam.isStationIdleForBackfill([rtspCam, doorbellCam], now, 5000),
      true,
      'RTSP activity on the same HomeBase must not block P2P backfill downloads'
    );

    rtspCam.setSessionActive(false);
    rtspCam.setActiveMode('');
    doorbellCam.setSleptAt(now - 2000);
    assert.equal(
      doorbellCam.isStationIdleForBackfill([rtspCam, doorbellCam], now, 5000),
      false,
      'Recent P2P sleep within backfill_delay_secs must hold backfill'
    );
  });

  it('auto-detects RTSP vs P2P in "auto" mode and defaults omitted title to Eufy device name', () => {
    // Verify: auto-detects RTSP vs P2P in "auto" mode and defaults omitted title to Eufy device name.
    const autoRtspCam = new Camera({serial: 'T8161T0000000000', name: 'garage'});
    const autoP2pCam = new Camera({serial: 'T8214T2222222222'});
    const explicitTitleCam = new Camera({
      serial: 'T8161T1111111111',
      name: 'driveway',
      title: 'Front Driveway Custom',
    });

    assert.equal(autoRtspCam.getConfiguredMode(), 'auto');
    assert.equal(autoRtspCam.isRtspCapable(), false, 'Before rtspStreamUrl discovery, "auto" uses P2P');
    assert.equal(autoRtspCam.hasBackfillDownloadsEnabled(), true);
    assert.equal(autoRtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live0'), true);
    assert.equal(autoRtspCam.isRtspCapable(), true, 'Uses HomeBase RTSP once rtspStreamUrl is discovered');

    assert.equal(autoP2pCam.updateDiscoveredRtspConfig('T8030T0000000000', ''), false);
    assert.equal(autoP2pCam.isRtspCapable(), false, 'Falls back to P2P when camera does not expose rtspStreamUrl');
    assert.equal(autoP2pCam.getStationSerial(), 'T8030T0000000000');

    // Omitted title defaults to camera name before telemetry load, then Eufy device name after telemetry load
    assert.equal(autoRtspCam.getDisplayTitle(), 'garage');
    autoRtspCam.applyTelemetryProperties({name: {value: 'Garage S350'}});
    assert.equal(autoRtspCam.getDisplayTitle(), 'Garage S350');

    // Explicit title in config.yaml always takes precedence over Eufy device name
    explicitTitleCam.applyTelemetryProperties({name: {value: 'Eufy App Name'}});
    assert.equal(explicitTitleCam.getDisplayTitle(), 'Front Driveway Custom');
  });

  it('preserves and upgrades pendingBackfill across companion events until 5s of live video is decoded', () => {
    // Verify: preserves and upgrades pendingBackfill across companion events until 5s of live video is decoded.
    const p2pCam = new Camera({
      serial: 'T8140T0000000000',
      mode: 'p2p',
    });

    const t0 = 500000;
    p2pCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    p2pCam.applyMotionTrigger(t0, 'motion detected', 60000, 'eufy-event', 10, 3000, 5000, 3000);
    assert.ok(p2pCam.getPendingBackfillJob() instanceof BackfillJob);
    assert.equal(p2pCam.getPendingBackfillJob().event, 'motion detected');

    p2pCam.setSessionActive(true);
    p2pCam.setSessionStartedAt(t0);
    // Companion person event 4s later before 5s of video is decoded -> must upgrade, NOT cancel pendingBackfill
    p2pCam.queueEventBackfill(
      t0 + 4000,
      'identity person detected',
      'Alice',
      'identity person detected (Alice)',
      300,
      true
    );
    p2pCam.applyMotionTrigger(t0 + 4000, 'identity person detected (Alice)', 60000, 'eufy-event', 300);
    assert.ok(p2pCam.getPendingBackfillJob() instanceof BackfillJob);
    assert.equal(p2pCam.getPendingBackfillJob().event, 'identity person detected');
    assert.equal(p2pCam.getPendingBackfillJob().personName, 'Alice');

    // Once >= 20% of hold_secs (12s for a 60s hold) of live video is decoded, subsequent extension
    // clears pendingBackfill (AT-15)
    p2pCam.setGotVideo(true);
    p2pCam.setFirstFrameAt(t0 + 1000);
    p2pCam.setFirstVideoAt(t0 + 1000);
    p2pCam.applyMotionTrigger(t0 + 14000, 'person detected', 60000, 'eufy-event', 200);
    assert.equal(p2pCam.getPendingBackfillJob(), null);
  });

  it('honors per-camera trigger_events, backfill_enabled, low_battery_threshold, and low_battery_wake_on_view', () => {
    // Verify: honors per-camera trigger_events, backfill_enabled, low_battery_threshold, and low_battery_wake_on_view
    const doorbellCam = new Camera({
      serial: 'T8214T2222222222',
      mode: 'backfill',
      trigger_events: ['person', 'ring'],
      low_battery_threshold: 35,
      low_battery_wake_on_view: false,
    });
    const standaloneCam = new Camera({
      serial: 'T8134STANDALONE1',
      mode: 'p2p',
      backfill_enabled: false,
      low_battery_threshold: 10,
      critical_battery_threshold: 4,
      low_battery_wake_on_view: true,
    });

    assert.equal(doorbellCam.shouldTriggerOnEvent('rings'), true);
    assert.equal(doorbellCam.shouldTriggerOnEvent('person detected'), true);
    assert.equal(doorbellCam.shouldTriggerOnEvent('motion detected'), false);
    assert.equal(standaloneCam.shouldTriggerOnEvent('motion detected'), true);

    // Per-camera backfill_enabled=false prevents queuing BackfillJob on standalone camera
    standaloneCam.queueEventBackfill(10000, 'motion detected', '', 'motion detected', 10, true);
    assert.equal(standaloneCam.getPendingBackfillJob(), null);

    // Per-camera low_battery_threshold=35 triggers low-battery mode at 30% on doorbellCam, while
    // threshold=10 keeps 15% normal on standaloneCam
    doorbellCam.applyTelemetryProperties({battery: 30, chargingStatus: 2});
    standaloneCam.applyTelemetryProperties({battery: 15, chargingStatus: 2});

    assert.equal(doorbellCam.isLowBattery(), true);
    assert.equal(doorbellCam.canWakeOnViewerInLowBattery(), false);
    assert.equal(standaloneCam.isLowBattery(), false);
    assert.equal(standaloneCam.canWakeOnViewerInLowBattery(), true);
    standaloneCam.applyTelemetryProperties({battery: 4, chargingStatus: 2});
    assert.equal(standaloneCam.isCriticalBattery(), true);
  });

  it(
    'prevents RTSP re-wake loops during post-viewer linger and yields lingering station streams ' + 'on viewer switch',
    () => {
      // Verify: prevents RTSP re-wake loops during post-viewer linger and yields lingering station streams on viewer
      // switch.
      const cam1 = new Camera({
        serial: 'T8161T0000000000',
        station_serial: 'T8030T9999999999',
        mode: 'rtsp',
      });
      cam1.updateDiscoveredRtspConfig('T8030T9999999999', 'rtsp://10.0.0.1/live0');
      const cam2 = new Camera({
        serial: 'T8161T1111111111',
        station_serial: 'T8030T9999999999',
        mode: 'rtsp',
      });
      cam2.updateDiscoveredRtspConfig('T8030T9999999999', 'rtsp://10.0.0.1/live1');
      const doorbell = new Camera({
        serial: 'T8214T2222222222',
        station_serial: 'T8030T9999999999',
        mode: 'backfill',
      });

      const t0 = 1000000;
      cam1.beginSession('rtsp', t0, false);
      cam1.setViewUntil(t0 + 20000);
      cam1.setViewerWakingStatus('v1', true);

      assert.equal(
        cam1.shouldRewakeRtspOnDrop(t0 + 5000),
        true,
        'Must re-wake RTSP on drop while a waking viewer is still connected'
      );

      cam1.pruneDisconnectedViewers(new Set(), 0);
      assert.equal(cam1.hasWakingViewer(), false);
      assert.equal(
        cam1.shouldRewakeRtspOnDrop(t0 + 15000),
        false,
        'Must NOT re-wake RTSP on drop during post-viewer linger after viewer disconnected'
      );

      cam1.setMotionUntil(t0 + 60000);
      assert.equal(
        cam1.shouldRewakeRtspOnDrop(t0 + 15000),
        true,
        'Must re-wake RTSP on drop while motion hold is active'
      );

      cam1.setMotionUntil(0);
      doorbell.beginSession('p2p', t0, false);
      doorbell.setViewUntil(t0 + 20000);
      const p2pCam3 = new Camera({
        serial: 'T8214T3333333333',
        station_serial: 'T8030T9999999999',
        mode: 'p2p',
      });
      assert.equal(
        cam1.shouldYieldToNewStationViewer(cam2, t0 + 15000),
        false,
        'RTSP Live View camera on same station must stay open in parallel when user opens another camera (AT-14)'
      );
      assert.equal(
        doorbell.shouldYieldToNewStationViewer(cam2, t0 + 15000),
        false,
        'P2P Live View camera must not stop when user opens an RTSP camera on the same station (AT-14)'
      );
      assert.equal(
        doorbell.shouldYieldToNewStationViewer(p2pCam3, t0 + 15000),
        true,
        'P2P Live View camera on same station must yield when user opens another P2P camera (AT-14)'
      );

      cam1.setMotionUntil(t0 + 60000);
      assert.equal(
        cam1.shouldYieldToNewStationViewer(cam2, t0 + 15000),
        false,
        'Camera with active motion must never yield to viewer switch'
      );
    }
  );
});

describe('Camera Arbitration, Hold Extension, Early Sleep & Watchdog Health', () => {
  it('compares wanting cameras by priority and preempts lower-priority P2P sessions', () => {
    // Verify: compares wanting cameras by priority and preempts lower-priority P2P sessions.
    const lowCam = new Camera({serial: 'T8161T0000000000', priority: 10});
    const highCam = new Camera({serial: 'T8214T2222222222', priority: 100});

    const t0 = Date.now();
    lowCam.beginSession('p2p', t0, false);
    lowCam.setMotionUntil(t0 + 60000);
    lowCam.setLastMotionAt(t0);

    highCam.beginSession('p2p', t0, false);
    highCam.setMotionUntil(t0 + 60000);
    highCam.setLastMotionAt(t0 + 500);

    assert.equal(highCam.canPreempt(lowCam, t0 + 1000, 12000), true);
    assert.equal(lowCam.canPreempt(highCam, t0 + 1000, 12000), false);
    assert.equal(highCam.resolvePreemptInitiator(lowCam, t0 + 1000), 'bridge-arbitrator/higher-priority-event');

    lowCam.setMotionUntil(0);
    assert.equal(highCam.resolvePreemptInitiator(lowCam, t0 + 1000), 'bridge-arbitrator/motion-over-viewer');

    highCam.setMotionUntil(0);
    highCam.setViewUntil(t0 + 20000);
    assert.equal(highCam.resolvePreemptInitiator(lowCam, t0 + 1000), 'bridge-arbitrator/newer-viewer');

    // Compare wanting order: motion beats viewer; higher effective priority beats lower priority
    lowCam.setSessionActive(false);
    lowCam.setActiveMode('');
    lowCam.setMotionUntil(t0 + 60000);
    highCam.setMotionUntil(t0 + 60000);
    const sorted = [lowCam, highCam].sort((a, b) => Camera.compareWanting(a, b));
    assert.equal(sorted[0], highCam);
  });

  it(
    'evaluates active hold extensions near expiry, early sleep on motion cleared, and Eufy ' + 'clean-end detection',
    () => {
      // Verify: evaluates active hold extensions near expiry, early sleep on motion cleared, and Eufy clean-end
      // detection.
      const cam = new Camera({serial: 'T8161T0000000000', mode: 'p2p', hold_secs: 60, stream_max_secs: 120});
      const t0 = 100000;
      cam.beginSession('p2p', t0, false);
      cam.setGotVideo(true);
      cam.setFirstFrameAt(t0 + 1000);
      cam.setFirstVideoAt(t0 + 1000);
      cam.setMotionUntil(t0 + 60000);

      // Not near expiry yet (30s remaining > 4s window) -> no poll needed
      assert.deepEqual(cam.shouldPollFrigateForHoldOrBackfill(t0 + 30000, 4000, 2000, 2000), {
        shouldPoll: false,
        needsTimeoutExtendCheck: false,
      });

      // Within 4s of expiry -> polls and extends by holdMs / 2 (30s)
      assert.deepEqual(cam.shouldPollFrigateForHoldOrBackfill(t0 + 58000, 4000, 2000, 2000), {
        shouldPoll: true,
        needsTimeoutExtendCheck: true,
      });
      const ext = cam.extendActiveHold(t0 + 58000, 5000, true);
      assert.equal(ext.extendMs, 30000);
      assert.equal(cam.getMotionUntil(), t0 + 90000);

      // Early sleep when letEufyDecideEnd=true and motion clears after first video
      const earlyCam = new Camera({
        serial: 'T8161T1111111111',
        mode: 'custom',
        end_early: true,
        idle_timeout_secs: 10,
        hold_secs: 60,
      });
      earlyCam.beginSession('p2p', t0, false);
      earlyCam.setGotVideo(true);
      earlyCam.setEventActive(true);
      earlyCam.setFirstVideoAt(t0 + 1000);
      earlyCam.setLastMotionAt(t0 + 1000);
      earlyCam.setMotionUntil(t0 + 60000);

      assert.equal(earlyCam.recordMotionCleared(t0 + 8000, 5000, 10000), 5);
      assert.equal(earlyCam.checkEarlySleepDue(t0 + 9000, 3000, 4000).due, false);
      assert.deepEqual(earlyCam.checkEarlySleepDue(t0 + 12500, 3000, 4000), {
        due: true,
        clearedByEufy: true,
      });

      // Clean Eufy livestream stop detection vs premature interruption
      assert.equal(earlyCam.didEufyEndEventCleanly(t0 + 10000, 8000), true);
      assert.equal(cam.didEufyEndEventCleanly(t0 + 10000, 8000), false, 'letEufyDecideEnd=false requires full hold');
    }
  );

  it('logs every camera session FSM transition exactly once with structured from -> to and reason context', () => {
    // Verify: logs every camera session FSM transition exactly once with structured from -> to and reason context.
    const rtspCam = new Camera({serial: 'T8161T0000000000', name: 'front_yard', mode: 'rtsp'});
    const p2pCam = new Camera({serial: 'T8161T1111111111', name: 'back_yard', mode: 'p2p'});
    const backfillCam = new Camera({serial: 'T8214T2222222222', name: 'doorbell', mode: 'backfill'});
    const t0 = 200000;

    const loggedLines = [];
    const origConsoleLog = console.log;
    initLogger('debug');
    console.log = (line) => loggedLines.push(line);

    try {
      // 1. RTSP transitions including mid-session re-wake and cooldown expiry
      rtspCam.beginSession('rtsp', t0, false);
      rtspCam.markRtspFrameReceived(t0 + 1000);
      // Second RTSP frame in same state must not emit a duplicate transition log
      rtspCam.markRtspFrameReceived(t0 + 1066);
      rtspCam.beginRtspRewake(t0 + 5000, 10000);
      rtspCam.markRtspFrameReceived(t0 + 6000);
      rtspCam.endSession(t0 + 10000, true, false, 'rtsp');
      rtspCam.getSessionState(t0 + 30000);

      // 2. P2P transitions including viewer preemption
      p2pCam.beginSession('p2p', t0, false);
      const frame = Buffer.alloc(FRAME, 0x33);
      p2pCam.recordDecodedFrame(frame, frame, t0 + 500, '12:00', 5000);
      // Second P2P frame in same state must not emit a duplicate transition log
      p2pCam.recordDecodedFrame(frame, frame, t0 + 566, '12:00', 5000);
      p2pCam.endSession(t0 + 2000, true, true, 'p2p');

      // 3. Backfill download transitions
      backfillCam.beginBackfillDownload(
        {
          storagePath: '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo',
          cipherId: 0,
          clipMs: t0 - 30000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0
      );
      backfillCam.recordDecodedFrame(frame, frame, t0 + 300, '12:01', 5000);
      // Second backfill frame in same state must not emit a duplicate transition log
      backfillCam.recordDecodedFrame(frame, frame, t0 + 366, '12:01', 5000);
      backfillCam.markDownloadFinished(t0 + 4000);
      backfillCam.endSession(t0 + 30000, true, false, 'download');
    } finally {
      console.log = origConsoleLog;
      initLogger('error');
    }

    const transitionLogs = loggedLines
      .filter((line) => line.includes('session state:'))
      .map((line) => line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[DEBUG\] - /, ''));

    assert.deepEqual(transitionLogs, [
      '[front_yard] [WAKING_RTSP] session state: idle -> waking_rtsp (session start: rtsp)',
      '[front_yard] [STREAMING_LIVE] session state: waking_rtsp -> streaming_live (first rtsp frame received)',
      '[front_yard] [WAKING_RTSP] session state: streaming_live -> waking_rtsp (rtsp stream dropped, re-waking)',
      '[front_yard] [STREAMING_LIVE] session state: waking_rtsp -> streaming_live (rtsp re-wake frame received)',
      '[front_yard] [COOLDOWN] session state: streaming_live -> cooldown (live session ended, entering cooldown)',
      '[front_yard] [IDLE] session state: cooldown -> idle (cooldown elapsed)',
      '[back_yard] [WAKING_P2P] session state: idle -> waking_p2p (session start: p2p)',
      '[back_yard] [STREAMING_LIVE] session state: waking_p2p -> streaming_live (first live frame decoded)',
      '[back_yard] [IDLE] session state: streaming_live -> idle (preempted by viewer)',
      '[doorbell] [HANDSHAKING_BACKFILL] session state: idle -> handshaking_backfill ' +
        '(session start: backfill download)',
      '[doorbell] [PLAYING_BACKFILL] session state: handshaking_backfill -> playing_backfill ' +
        '(first backfill frame decoded)',
      '[doorbell] [DRAINING_BACKFILL_TAIL] session state: playing_backfill -> draining_backfill_tail ' +
        '(download transfer finished)',
      '[doorbell] [IDLE] session state: draining_backfill_tail -> idle (backfill session ended)',
    ]);
  });

  it('encapsulates Law-of-Demeter accessors, mutators, and immutable value objects across domain models', () => {
    // Verify: encapsulates Law-of-Demeter accessors, mutators, and immutable value objects across domain models.
    const t0 = 1710000000000;
    const cam = new Camera({
      serial: 'T8161T0000000000',
      name: 'driveway',
      title: 'Driveway Cam',
      mode: 'rtsp',
      station_serial: 'T8030P0000000000',
    });
    cam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://user:secret@192.168.1.50:8554/live0');

    // 1. Basic encapsulated accessors & immutable summaries
    assert.equal(cam.getName(), 'driveway');
    assert.equal(cam.getSerial(), 'T8161T0000000000');
    assert.equal(cam.getRtspUrl(), 'rtsp://user:secret@192.168.1.50:8554/live0');
    assert.equal(cam.getMaskedRtspUrl(), 'rtsp://***@192.168.1.50:8554/live0');
    assert.equal(cam.isSessionActive(), false);
    const avail = cam.toAvailableCameraSummary();
    assert.equal(Object.isFrozen(avail), true);
    assert.deepEqual(avail, {
      name: 'driveway',
      serial: 'T8161T0000000000',
      title: 'Driveway Cam',
    });

    // 2. Telemetry delegation without reaching into cam.telemetry.*
    assert.equal(cam.hasBatteryReading(), false);
    const telResult = cam.applyTelemetryProperties(
      {battery: 85, chargingStatus: 2, wifiRssi: -62, batteryTemperature: 21},
      false
    );
    assert.equal(Object.isFrozen(telResult), true);
    assert.equal(telResult.shouldRebuildCard, true);
    assert.equal(telResult.logLevel, 'info');
    assert.equal(cam.hasBatteryReading(), true);
    assert.equal(cam.getBatteryPct(), 85);

    // 3. StatusCard mask & overlay delegation without reaching into cam.card.*
    assert.equal(cam.hasAutoFrigateMask(), true);
    assert.equal(cam.formatCardPlacementSummary('@'), 'minimal@bottom-left');
    const poly = cam.computeMaskPolygon();
    cam.markMaskSynced(poly);
    assert.equal(cam.isMaskSectionAlreadySynced('objects', poly), true);
    cam.resetMaskSync();
    assert.equal(cam.isMaskSectionAlreadySynced('objects', poly), false);

    // 4. Session wake & stop encapsulation
    cam.setMotionUntil(t0 + 60000);
    cam.setLastMotionAt(t0);
    const rtspWakeLog = cam.beginRtspWakeSession(t0);
    assert.equal(cam.isSessionActive(), true);
    assert.match(rtspWakeLog, /WAKE \[RTSP\]/);
    assert.equal(cam.isFirstWakeAttempt(), true);
    const sessId = cam.markRtspAttemptStart(t0 + 500);
    assert.equal(sessId, cam.getSessionId());

    const quietSecs = cam.markEarlySleep(t0 + 12000);
    assert.equal(quietSecs, 12);
    assert.equal(cam.handleStationDisconnected('station_disconnected'), true);
    assert.equal(cam.getMotionUntil(), 0);

    // 5. External livestream stop evaluation
    cam.endSession(t0 + 13000, false, false, 'rtsp');
    cam.setMotionUntil(t0 + 60000);
    const p2pWake = cam.beginP2pWakeSession(t0 + 14000, 'T8030P0000000000');
    assert.equal(Object.isFrozen(p2pWake), true);
    assert.equal(p2pWake.shouldFileEvent, true);
    const extStop = cam.evaluateExternalLivestreamStop(t0 + 20000, 3000);
    assert.equal(Object.isFrozen(extStop), true);
    assert.equal(extStop.action, 'interrupted');
  });

  it(
    'evaluates single-expression boolean predicates for decoder exit logging, station ' +
      'backfill blocking, viewer yielding, and download completion',
    () => {
      // Verify: evaluates single-expression boolean predicates for decoder exit logging, station backfill blocking,
      // viewer yielding, and download completion.
      const t0 = 1710000000000;
      const cam = new Camera({
        serial: 'T8214T2222222222',
        name: 'doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000000000',
      });
      const otherCam = new Camera({
        serial: 'T8161T0000000000',
        name: 'driveway',
        mode: 'p2p',
        station_serial: 'T8030P0000000000',
      });

      // 1. shouldLogUnexpectedDecoderExit ternary predicate
      assert.equal(cam.shouldLogUnexpectedDecoderExit(999, 1), false, 'Returns false when sessionId is not current');
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/clip1.zxvideo',
          cipherId: 0,
          clipMs: t0 - 10000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        t0
      );
      const activeSid = cam.getSessionId();
      assert.equal(
        cam.shouldLogUnexpectedDecoderExit(activeSid, 0),
        true,
        'Returns true if backfill decoder exits with 0 before downloadFinished is marked'
      );
      assert.equal(
        cam.shouldLogUnexpectedDecoderExit(activeSid, 1),
        true,
        'Returns true if backfill decoder exits with non-zero code'
      );
      // 2. isBlockingStationBackfill & isStationIdleForBackfill predicates
      assert.equal(
        cam.isBlockingStationBackfill('T8030P0000000000', t0 + 1500, 5000, false),
        true,
        'Active P2P or in-transfer download session blocks station backfill'
      );
      assert.equal(
        cam.isBlockingStationBackfill('OTHER_STATION', t0 + 1500, 5000, false),
        false,
        'Different station never blocks'
      );
      cam.markDownloadFinished(t0 + 2000);
      assert.equal(
        cam.shouldLogUnexpectedDecoderExit(activeSid, 0),
        false,
        'Returns false on clean exitCode=0 after backfill downloadFinished'
      );
      assert.equal(
        cam.shouldLogUnexpectedDecoderExit(activeSid, 1),
        true,
        'Returns true on non-zero exitCode even after downloadFinished'
      );
      assert.equal(
        cam.isBlockingStationBackfill('T8030P0000000000', t0 + 3000, 5000, false),
        false,
        'RAM-draining backfill tail after downloadFinished unblocks station backfill'
      );
      cam.endSession(t0 + 3000, true, false, 'download');
      otherCam.setSleptAt(t0 + 3000);
      assert.equal(
        otherCam.isBlockingStationBackfill('T8030P0000000000', t0 + 5000, 5000, false),
        true,
        'Post-sleep cooldown blocks normal backfill'
      );
      assert.equal(
        otherCam.isBlockingStationBackfill('T8030P0000000000', t0 + 5000, 5000, true),
        false,
        'Urgent SIGUSR1 test bypasses post-sleep delay'
      );
      assert.equal(
        otherCam.isBlockingStationBackfill('T8030P0000000000', t0 + 9000, 5000, false),
        false,
        'Station becomes idle once delayMs has elapsed'
      );

      // 3. shouldYieldToNewStationViewer & canAdoptExternalWake ternary predicates
      otherCam.setViewUntil(t0 + 20000);
      assert.equal(otherCam.shouldYieldToNewStationViewer(cam, t0 + 10000), true);
      otherCam.setViewerWakingStatus('v1', true);
      assert.equal(
        otherCam.shouldYieldToNewStationViewer(cam, t0 + 10000),
        true,
        'P2P viewer yields when another P2P camera on the same station opens a viewer'
      );
      assert.equal(otherCam.canAdoptExternalWake(t0 + 4000, 3000), false, 'Inside guardMs');
      assert.equal(otherCam.canAdoptExternalWake(t0 + 7000, 3000), true, 'Outside guardMs');
    }
  );
});

describe('Camera Offline Detection, Battery-Swap Recovery & Direct RTSP Lifecycle', () => {
  it(
    'manages standalone direct rtsp_url camera lifecycle, WS-independent service health, ' +
      'passive probe card suppression, continuous frame hold extension, and null-filtered toConfigSummary',
    () => {
      // Verify direct rtsp_url camera ignores wsConnected disruption, keeps Asleep/Disconnected
      // card during passive probes, extends hold on live RTSP frames, and returns null for ignored config fields
      const t0 = 1800000000000;
      const rawSnap = Buffer.alloc(FRAME, 0x35);
      const babyCam = new Camera(
        {
          name: 'baby_crib',
          title: 'Baby Crib Camera',
          rtsp_url: 'rtsp://admin:secret@192.168.1.50:554/live0',
          card_theme: 'hud',
        },
        {frame: rawSnap, lastSeen: '21:15'},
        renderCameraCards
      );

      assert.equal(babyCam.getConfiguredMode(), 'rtsp');
      assert.equal(babyCam.isRtspDirect(), true);
      assert.equal(babyCam.isRtspCapable(), true);
      assert.equal(babyCam.getRtspUrl(), 'rtsp://admin:secret@192.168.1.50:554/live0');
      assert.equal(babyCam.getMaskedRtspUrl(), 'rtsp://***@192.168.1.50:554/live0');
      assert.equal(babyCam.requiresStartupSnapshot(), false);

      // 1. eufy-security-ws disconnect does not mark direct rtsp_url camera as service-disrupted
      assert.equal(babyCam.updateServiceHealth({wsConnected: false}), true);
      assert.equal(babyCam.hasServiceDisruption(), false);
      assert.equal(babyCam.buildDebugHudLines(t0)[0].includes('WS:OK HB:OK FRG:OK RTC:OK'), true);

      // 2. Passive background RTSP probe keeps sleeping card selected until first video frame arrives
      assert.equal(babyCam.shouldStartRtspDirectSession(t0), true);
      babyCam.beginRtspDirectProbeSession(t0);
      assert.equal(babyCam.isSessionActive(), true);
      assert.equal(babyCam.isPassiveRtspDirectProbe(), true);
      assert.equal(
        babyCam.selectEncoderFrame(t0 + 500).frame,
        babyCam.getAsleepCardBuffer(),
        'Passive direct rtsp_url probe must keep showing Asleep/Disconnected card until first video frame decodes'
      );

      // 3. Probe failure with Connection refused marks camera link disrupted (Disconnected card,
      // HB:DN) while keeping isDeviceOffline() false so snapshot encoder keeps running
      const failOut = babyCam.recordRtspDirectProbeFailure('Connection refused');
      assert.deepEqual(failOut, {disruptionChanged: true, isReachableStandby: false});
      assert.equal(babyCam.hasServiceDisruption(), true);
      assert.equal(babyCam.isDeviceOffline(), false);
      assert.equal(babyCam.buildDebugHudLines(t0 + 1000)[0].includes('WS:OK HB:DN FRG:OK RTC:OK'), true);
      const probeTermOut = babyCam.terminateSession(
        t0 + 1000,
        'direct RTSP server reachable in standby (404 Not Found)',
        false,
        'rtsp-direct-probe'
      );
      assert.equal(
        probeTermOut.shouldPersistSnapshot,
        false,
        'Failed passive probe without video must not re-save unchanged cached snapshot to disk'
      );
      assert.equal(babyCam.shouldStartRtspDirectSession(t0 + 3000), false, 'Respects 5s probe interval');
      assert.equal(babyCam.shouldStartRtspDirectSession(t0 + 6000), true);

      // 4. Probe failure with 404 Not Found indicates camera is reachable on Wi-Fi in standby
      // (restores Asleep card, HB:OK)
      const standbyOut = babyCam.recordRtspDirectProbeFailure('Server returned 404 Not Found');
      assert.deepEqual(standbyOut, {disruptionChanged: true, isReachableStandby: true});
      assert.equal(babyCam.hasServiceDisruption(), false);
      assert.equal(babyCam.buildDebugHudLines(t0 + 6500)[0].includes('WS:OK HB:OK FRG:OK RTC:OK'), true);

      // 5. Decoding RTSP frames transitions to STREAMING_LIVE and continuously extends hold
      // without hitting stream_max_secs
      babyCam.beginRtspDirectProbeSession(t0 + 10000);
      const firstFrameOut = babyCam.markRtspFrameReceived(t0 + 11000);
      assert.equal(firstFrameOut.isFirstVideo, true);
      assert.equal(babyCam.isPassiveRtspDirectProbe(), false);
      assert.equal(babyCam.getStoredSessionState(), SESSION_STATES.STREAMING_LIVE);
      babyCam.recordDecodedFrame(Buffer.alloc(FRAME, 0x44), Buffer.alloc(FRAME, 0x44), t0 + 11000, '21:16');
      assert.equal(babyCam.selectEncoderFrame(t0 + 11100).isLive, true);

      // Streaming 10 minutes later (> 180s stream_max_secs) keeps extending motionUntil and never
      // triggers max duration stop
      babyCam.markRtspFrameReceived(t0 + 600000);
      assert.equal(babyCam.hasReachedMaxDuration(t0 + 600000), false);
      assert.equal(babyCam.hasReachedViewMaxDuration(t0 + 600000), false);
      assert.ok(babyCam.wantUntil() >= t0 + 660000);
      const liveTermOut = babyCam.terminateSession(t0 + 601000, 'direct RTSP stream ended', false, 'eufy/rtsp-end');
      assert.equal(
        liveTermOut.shouldPersistSnapshot,
        true,
        'Completed live session with decoded frames must persist updated snapshot to disk'
      );

      // 6. None of the stream timeout / hold expiry / early sleep / Frigate poll / telemetry
      // settings ever apply to direct rtsp_url
      const timedDirectCam = new Camera(
        {
          serial: 'T8352P0000000002',
          name: 'kids_room_camera',
          mode: 'rtsp',
          rtsp_url: 'rtsp://admin:secret@192.168.1.51:554/live0',
          hold_secs: 20,
          stream_max_secs: 30,
          view_linger_secs: 10,
          view_max_secs: 20,
          idle_timeout_secs: 15,
        },
        {frame: rawSnap, lastSeen: '21:15'},
        renderCameraCards
      );
      assert.equal(
        timedDirectCam.getTelemetryConfig().enabled,
        false,
        'direct rtsp_url must disable telemetry completely'
      );
      assert.equal(timedDirectCam.getTelemetryConfig().battery, false);
      assert.equal(timedDirectCam.getTelemetryConfig().powerSource, false);
      assert.equal(timedDirectCam.getTelemetryConfig().wifi, false);
      assert.equal(timedDirectCam.getTelemetryConfig().rssi, false);
      assert.deepEqual(
        timedDirectCam.getCardBounds(),
        {boxX: 24, boxY: 684, boxW: 26, boxH: 12},
        'Default minimal card on direct rtsp_url (with telemetry disabled) must be 26x12 status pill only'
      );

      const explicitTelDirectCam = new Camera({
        serial: 'T8352P0000000003',
        name: 'explicit_direct',
        mode: 'rtsp',
        rtsp_url: 'rtsp://admin:secret@192.168.1.52:554/live0',
        telemetry: {battery: true, wifi: true},
      });
      assert.equal(
        explicitTelDirectCam.getTelemetryConfig().enabled,
        false,
        'direct rtsp_url must ignore explicit telemetry config'
      );
      assert.equal(explicitTelDirectCam.getTelemetryConfig().battery, false);
      assert.equal(explicitTelDirectCam.getTelemetryConfig().wifi, false);
      assert.deepEqual(explicitTelDirectCam.getCardBounds(), {boxX: 24, boxY: 684, boxW: 26, boxH: 12});

      // Verify toConfigSummary() returns null for inapplicable fields across direct rtsp_url,
      // card_theme, and mode combinations
      const babySummary = babyCam.toConfigSummary();
      assert.equal('homebase_rtsp_url' in babySummary, false);
      assert.equal(babySummary.serial, null, 'Derived serial from name on direct rtsp_url must report null');
      assert.equal(babySummary.mode, 'rtsp');
      assert.equal(babySummary.rtsp_url, 'rtsp://***@192.168.1.50:554/live0');
      assert.equal(babySummary.priority, null);
      assert.equal(babySummary.station_serial, null);
      assert.equal(babySummary.hold_secs, null);
      assert.equal(babySummary.stream_max_secs, null);
      assert.equal(babySummary.idle_timeout_secs, null);
      assert.equal(babySummary.view_linger_secs, null);
      assert.equal(babySummary.view_max_secs, null);
      assert.equal(babySummary.backfill_only, null);
      assert.equal(babySummary.backfill_enabled, null);
      assert.equal(babySummary.sync_power, null);
      assert.equal(babySummary.power_working_mode, null);
      assert.equal(babySummary.startup_snapshot, null);
      assert.equal(babySummary.telemetry, null);
      assert.equal(timedDirectCam.toConfigSummary().serial, 'T8352P0000000002');

      const p2pNoCardSummary = new Camera({
        serial: 'T8214T0000000099',
        name: 'doorbell_none',
        mode: 'p2p',
        sync_power: false,
        card_theme: 'none',
      }).toConfigSummary();
      assert.equal(p2pNoCardSummary.rtsp_url, null);
      assert.equal(p2pNoCardSummary.card_position, null);
      assert.equal(p2pNoCardSummary.card_show_on_live, null);
      assert.equal(p2pNoCardSummary.telemetry, null);
      assert.equal(p2pNoCardSummary.power_working_mode, null);
      assert.equal(p2pNoCardSummary.auto_frigate_mask, true);

      const backfillMinimalSummary = new Camera({
        serial: 'T8214T0000000098',
        name: 'doorbell_backfill',
        mode: 'backfill',
        card_theme: 'minimal',
        card_position: 'center',
        sleep_screen: 'black',
        telemetry: {battery: false, wifi: true, rssi: true, temperature: true, last_seen: true},
      }).toConfigSummary();
      assert.equal(backfillMinimalSummary.idle_timeout_secs, null);
      assert.equal(backfillMinimalSummary.startup_snapshot, null);
      assert.equal(backfillMinimalSummary.card_show_on_live, null);
      assert.deepEqual(backfillMinimalSummary.telemetry, {
        enabled: true,
        battery: false,
        power_source: false,
        wifi: true,
        rssi: true,
        temperature: false,
        last_seen: false,
      });

      const defaultMinimalSummary = new Camera({
        serial: 'T8161T0000000096',
        name: 'default_minimal_cam',
        mode: 'rtsp',
      }).toConfigSummary();
      assert.deepEqual(defaultMinimalSummary.telemetry, {
        enabled: true,
        battery: true,
        power_source: true,
        wifi: true,
        rssi: true,
        temperature: false,
        last_seen: false,
      });

      const disabledTelemetrySummary = new Camera({
        serial: 'T8161T0000000095',
        name: 'disabled_tel_cam',
        mode: 'rtsp',
        card_theme: 'glance',
        telemetry: false,
      }).toConfigSummary();
      assert.deepEqual(disabledTelemetrySummary.telemetry, {
        enabled: false,
        battery: false,
        power_source: false,
        wifi: false,
        rssi: false,
        temperature: false,
        last_seen: false,
      });

      timedDirectCam.beginRtspDirectProbeSession(t0);
      timedDirectCam.markRtspFrameReceived(t0 + 1000);
      timedDirectCam.setMotionClearedAt(t0 + 2000);
      const farFuture = t0 + 3600000;
      assert.equal(
        timedDirectCam.hasExpiredLiveHold(farFuture),
        false,
        'direct rtsp_url stream must never expire on hold_secs or view_linger_secs'
      );
      assert.equal(
        timedDirectCam.hasReachedMaxDuration(farFuture),
        false,
        'direct rtsp_url stream must never expire on stream_max_secs'
      );
      assert.equal(
        timedDirectCam.hasReachedViewMaxDuration(farFuture),
        false,
        'direct rtsp_url stream must never expire on view_max_secs'
      );
      assert.equal(
        timedDirectCam.canSleepEarlyOnIdle(farFuture),
        false,
        'direct rtsp_url stream must never sleep early on idle_timeout_secs'
      );
      assert.deepEqual(
        timedDirectCam.checkEarlySleepDue(farFuture),
        {due: false, clearedByEufy: false},
        'direct rtsp_url stream must never trigger early-sleep Frigate idle checks'
      );
      assert.deepEqual(
        timedDirectCam.shouldPollFrigateForHoldOrBackfill(farFuture),
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'direct rtsp_url stream must never poll Frigate for hold-extension timeouts'
      );
      timedDirectCam.endSession(farFuture, true, false, 'rtsp');
      assert.equal(
        timedDirectCam.isInViewerCooldown(farFuture + 1000),
        false,
        'direct rtsp_url stream must never be blocked by view_cooldown_secs'
      );

      // 7. Unknown battery level (!hasBat) renders a 15x15 question mark ('unknown') badge in
      // the top-right battery cutout on glance/pebbles
      const {LUCIDE_ICON_SPRITES} = require('../../src/overlay/ui-glyphs');
      assert.ok(
        LUCIDE_ICON_SPRITES.powerBadge15.unknown &&
          LUCIDE_ICON_SPRITES.powerBadge15.unknown.width === 15 &&
          LUCIDE_ICON_SPRITES.powerBadge15.unknown.height === 15,
        'LUCIDE_ICON_SPRITES.powerBadge15.unknown must be a pre-baked 15x15 question mark badge'
      );
      assert.ok(
        LUCIDE_ICON_SPRITES.batteryCutout.unknown &&
          LUCIDE_ICON_SPRITES.batteryCutout.unknown.width === 30 &&
          LUCIDE_ICON_SPRITES.batteryCutout.unknown.height === 20,
        'LUCIDE_ICON_SPRITES.batteryCutout.unknown must be a pre-baked 30x20 battery cutout shell'
      );
      assert.equal(
        Buffer.from(LUCIDE_ICON_SPRITES.batteryCutout.unknown.mask).equals(
          Buffer.from(LUCIDE_ICON_SPRITES.batteryShell.mask)
        ),
        false,
        'Unknown-battery cutout shell must have a top-right cutout differing from the plain battery shell'
      );
      const unknownBatGlance = new Camera(
        {
          serial: 'T8161T9999999999',
          card_theme: 'glance',
          card_position: 'top-left',
          telemetry: {battery: true, power_source: false, wifi: true},
        },
        {frame: rawSnap, lastSeen: '21:15'},
        renderCameraCards
      );
      const unknownBatBuf = Buffer.from(unknownBatGlance.getAsleepCardBuffer());
      // Top-right badge area of battery icon on top-left glance card:
      // boxX=24, statusX=40, startX=78, badgeX = 78 + 14 = 92..106,
      // topY = (24 + 22) - 10 + 1 = 37, badgeY = 37 - 4 = 33..47
      let badgeDiffPixels = 0;
      const knownZeroBatGlance = new Camera(
        {
          serial: 'T8161T9999999998',
          card_theme: 'glance',
          card_position: 'top-left',
          telemetry: {battery: true, power_source: false, wifi: true},
        },
        {frame: rawSnap, lastSeen: '21:15'},
        renderCameraCards
      );
      knownZeroBatGlance.applyTelemetryProperties({battery: 0, chargingStatus: 2});
      renderCameraCards(knownZeroBatGlance);
      const knownZeroBatBuf = Buffer.from(knownZeroBatGlance.getAsleepCardBuffer());
      for (let py = 33; py < 48; py++) {
        for (let px = 92; px < 107; px++) {
          if (unknownBatBuf[py * 1280 + px] !== knownZeroBatBuf[py * 1280 + px]) {
            badgeDiffPixels++;
          }
        }
      }
      assert.ok(
        badgeDiffPixels > 10,
        'Glance battery icon with unknown battery (!hasBat) must render the top-right question ' +
          'mark badge even when power_source is false'
      );
    }
  );

  it(
    'builds immutable per-camera runtime status summaries for direct rtsp_url and Eufy battery ' +
      'cameras without mutating FSM state',
    () => {
      // Verify Camera.toStatusSummary() exposes full runtime state, live telemetry, encoder codec/fallback,
      // reachability, and null-filtered Eufy fields on direct rtsp_url cameras without mutating cooldown FSMs.
      const t0 = 100000;
      const directCam = new Camera(
        {
          name: 'play_mat_camera',
          title: 'Play Mat Camera',
          mode: 'rtsp',
          rtsp_url: 'rtsp://viewer:secret@192.0.2.51/live0',
        },
        {frame: Buffer.alloc(FRAME, 0x10), lastSeen: '19:27'}
      );

      // 1. Direct rtsp_url camera streaming live video
      directCam.beginSession('rtsp', t0, true);
      directCam.setWakeInitiator('viewer');
      directCam.setReason('rtsp direct stream');
      directCam.markRtspFrameReceived(t0 + 400);
      directCam.updateStreamFormat('h264', 1920, 1080);

      const directLive = directCam.toStatusSummary(t0 + 5000);
      assert.equal(Object.isFrozen(directLive), true);
      assert.equal(directLive.name, 'play_mat_camera');
      assert.equal(directLive.serial, null);
      assert.equal(directLive.title, 'Play Mat Camera');
      assert.equal(directLive.station_serial, null);
      assert.equal(directLive.rtsp_direct, true);
      assert.equal(directLive.rtsp_url, 'rtsp://***@192.0.2.51/live0');
      assert.equal(directLive.status, 'live');
      assert.equal(directLive.session_state, 'streaming_live');
      assert.equal(directLive.reachable, true);
      assert.equal(directLive.disrupted, false);
      assert.equal(directLive.offline, false);
      assert.equal(directLive.offline_reason, null);
      assert.equal(directLive.last_seen, '19:27');
      assert.equal(directLive.services.ws_connected, null);
      assert.equal(directLive.services.station_connected, null);
      assert.equal(directLive.services.endpoint_reachable, true);
      assert.equal(directLive.session.active_mode, 'rtsp');
      assert.equal(directLive.session.hold_remaining_secs, null);
      assert.equal(directLive.session.resolution, '1920x1080');
      assert.equal(directLive.session.video_codec, 'h264');
      assert.equal(directLive.telemetry, null);
      assert.equal(directLive.backfill, null);
      assert.equal(directLive.triggers, null);

      // 2. Unreachable direct rtsp_url camera stays disconnected even during passive 5s probe
      directCam.endSession(t0 + 6000, true, false, 'rtsp');
      directCam.recordRtspDirectProbeFailure('Connection refused');
      directCam.beginRtspDirectProbeSession(t0 + 11000);
      const directProbe = directCam.toStatusSummary(t0 + 11500);
      assert.equal(directProbe.passive_probe, true);
      assert.equal(directProbe.status, 'disconnected');
      assert.equal(directProbe.reachable, false);
      assert.equal(directProbe.disrupted, true);
      assert.equal(directProbe.services.endpoint_reachable, false);

      // 3. Eufy battery camera preserves model/firmware/telemetry even with card_theme="minimal"
      const eufyCam = new Camera({
        serial: 'T8161T0000000088',
        name: 'storage_cam',
        title: 'Storage Room Camera',
        station_serial: 'T8030T0000000088',
        mode: 'auto',
        card_theme: 'minimal',
      });
      eufyCam.updateDiscoveredRtspConfig('T8030T0000000088', 'rtsp://admin:pw@192.0.2.187/live1');
      eufyCam.applyTelemetryProperties(
        {
          state: 1,
          model: 'T8161',
          softwareVersion: '3.4.3.0',
          battery: 25,
          chargingStatus: 2,
          wifiSignalLevel: 2,
          wifiRssi: -74,
          temperature: 18,
          light: false,
          powerWorkingMode: 2,
          recordingClipLength: 60,
          recordingEndClipMotionStops: false,
          videoStreamingQuality: 7,
        },
        false,
        t0
      );

      const eufyEco = eufyCam.toStatusSummary(t0 + 1000);
      assert.equal(eufyEco.status, 'low_battery');
      assert.equal(eufyEco.reachable, true);
      assert.equal(eufyEco.disrupted, false);
      assert.equal(eufyEco.rtsp_url, 'rtsp://***@192.0.2.187/live1');
      assert.equal(eufyEco.services.ws_connected, true);
      assert.equal(eufyEco.services.station_connected, true);
      assert.equal(eufyEco.services.endpoint_reachable, null);
      assert.equal(eufyEco.telemetry.model, 'T8161');
      assert.equal(eufyEco.telemetry.firmware, '3.4.3.0');
      assert.equal(eufyEco.telemetry.battery_pct, 25);
      assert.equal(eufyEco.telemetry.charging, false);
      assert.equal(eufyEco.telemetry.power_source, 'battery');
      assert.equal(eufyEco.telemetry.low_battery, true);
      assert.equal(eufyEco.telemetry.critical_battery, false);
      assert.equal(eufyEco.telemetry.wifi_signal, 2);
      assert.equal(eufyEco.telemetry.rssi_dbm, -74);
      assert.equal(eufyEco.telemetry.temperature_c, 18);
      assert.equal(eufyEco.telemetry.hardware_settings.power_working_mode, 2);
      assert.equal(eufyEco.telemetry.hardware_settings.streaming_quality, 7);

      // 4. Cooldown expiry in toStatusSummary() is pure (does not mutate sessionState or evState)
      eufyCam.beginSession('rtsp', t0 + 2000, true);
      eufyCam.markRtspFrameReceived(t0 + 2500);
      eufyCam.endSession(t0 + 4000, true, false, 'rtsp');
      eufyCam.setStoredFrigateEventState('cooldown');
      eufyCam.setFrigateEventUntil(t0 + 5000);
      assert.equal(eufyCam.getStoredSessionState(), 'cooldown');
      const postCooldown = eufyCam.toStatusSummary(t0 + 20000);
      assert.equal(postCooldown.session_state, 'idle');
      assert.equal(postCooldown.frigate_event.state, 'idle');
      assert.equal(eufyCam.getStoredSessionState(), 'cooldown', 'toStatusSummary must not mutate sessionState');
      assert.equal(eufyCam.getStoredFrigateEventState(), 'cooldown', 'toStatusSummary must not mutate evState');

      // 5. Encoder hwaccel fallback reporting
      eufyCam.disableHwaccel();
      assert.equal(eufyCam.toStatusSummary(t0 + 20000).encoder.codec, 'libx264');
    }
  );
});

describe('API Wake Timer Replacement (Camera.scheduleApiWake)', () => {
  it('logs activity cleared before HomeBase backfill settle at debug level rather than info', () => {
    // Verify: logs activity cleared before HomeBase backfill settle at debug level rather than info.
    const cam = new Camera({serial: 'T8161T6666666668', name: 'bf_log_cam', mode: 'backfill'});
    cam.queueEventBackfill(100000, 'motion detected', '', 'motion detected', 10, true);
    cam.recordMotionCleared(105000, 4000, 30000, 'motion detected');
    const res = cam.evaluateBackfillAfterMotionCleared('motion detected');
    assert.equal(res.hasPending, true);
    assert.equal(res.isInfo, false, 'Activity cleared for queued backfill must log at debug level, not info');
  });
});

describe('Camera Read Accessors for Collaborating Modules', () => {
  it('exposes intention-revealing accessors so services, decoder, and renderer never read Camera fields', () => {
    // Verify: callers outside camera.js ask the Camera through methods instead of reading its fields, so the fields
    // can move into collaborators without editing callers.
    const cam = new Camera({serial: 'T8161T0000000051', name: 'accessor_cam', mode: 'rtsp'});

    assert.equal(cam.getConfiguredMode(), 'rtsp');
    assert.equal(cam.isRtspEnabled(), Boolean(cam.isRtspEnabled()));

    assert.equal(cam.hasGotVideo(), false);
    cam.beginSession('rtsp', 1000, false);
    assert.equal(cam.getRestartCount(), 0);
    cam.evaluateRtspHealth(2000, 1000, 1500, 15000, 500, 5, 30000);
    cam.evaluateRtspHealth(3000, 2000, 1500, 15000, 500, 5, 30000);
    cam.evaluateRtspHealth(4000, 3000, 1500, 15000, 500, 5, 30000);
    assert.equal(cam.getRestartCount(), 3);

    assert.equal(cam.hasHeardFromDeviceInSession(), false);
    cam.markDeviceHeardInSession();
    assert.equal(cam.hasHeardFromDeviceInSession(), true);

    cam.markRtspFrameReceived(4500);
    assert.equal(cam.hasGotVideo(), true);

    assert.equal(cam.hasRtspPropertyChecked(), false);
    cam.setRtspPropertyChecked(true);
    assert.equal(cam.hasRtspPropertyChecked(), true);

    assert.equal(cam.hasBackfillContinuation(), false);
    cam.beginSession('download', 5000, false);
    cam.queueEventBackfill(5200, 'motion detected', '', 'motion detected', 10, false);
    cam.recordDecodedFrame(Buffer.alloc(FRAME, 1), Buffer.alloc(FRAME, 1), 5500, '12:00');
    cam.markDownloadFinished(5800);
    cam.terminateSession(6000, 'done', false, 'eufy/download-finished');
    assert.equal(cam.hasBackfillContinuation(), true);

    assert.equal(cam.hasPendingVideoPackets(), false);
    cam.getPendingVideoPackets().push(Buffer.from([1]));
    assert.equal(cam.hasPendingVideoPackets(), true);

    const decoderProc = {pid: 1};
    assert.equal(cam.isDecoderProcess(decoderProc), false);
    cam.attachDecoder(decoderProc);
    assert.equal(cam.isDecoderProcess(decoderProc), true);
    assert.equal(cam.isDecoderProcess({pid: 2}), false);

    assert.equal(cam.hasSyncedMaskPolygon(), false);
    cam.markMaskSynced('0.1,0.1,0.2,0.1,0.2,0.2');
    assert.equal(cam.hasSyncedMaskPolygon(), true);
    cam.resetMaskSync();
    assert.equal(cam.hasSyncedMaskPolygon(), false);

    assert.equal(cam.getCardConfig(), cam.getCardConfig());
    assert.equal(cam.getCardPosition(), cam.getCardPosition());
    assert.equal(cam.usesDebugHudTheme(), false);
    const hudCam = new Camera({serial: 'T8161T0000000052', name: 'accessor_hud_cam', card_theme: 'hud'});
    assert.equal(hudCam.usesDebugHudTheme(), true);

    assert.deepEqual(cam.evaluateVisualState('Live'), cam.evaluateVisualState('Live'));

    const overlay = cam.acquireLiveOverlayBuffer(Buffer.alloc(FRAME, 0x10));
    assert.equal(overlay.length, FRAME);

    let capturedTitle = '';
    cam.setLazyCardRenderer((title, targetBuf) => {
      capturedTitle = title;
      targetBuf[0] = 0x22;
      return targetBuf;
    });
    assert.equal(cam.getWakingCardBuffer()?.[0], 0x22);
    assert.equal(capturedTitle, 'Waking Up...');
  });
});

describe('Camera Log Scope Contract', () => {
  it('provides an explicit log scope {name, state} instead of a duck-typed sessionState property', () => {
    // Verify: the logger resolved the "[IDLE]" / "[LIVE]" tag from scope.sessionState, so Camera carried a
    // read-only sessionState getter only for logging. Camera now hands the logger an explicit scope.
    const scopeCam = new Camera({serial: 'T8161T0000000061', name: 'log_scope_cam', mode: 'rtsp'});
    assert.deepEqual(scopeCam.getLogScope(), {name: 'log_scope_cam', state: 'idle'});
    scopeCam.transitionTo('waking_rtsp', 1000, 'test wake');
    assert.deepEqual(scopeCam.getLogScope(), {name: 'log_scope_cam', state: 'waking_rtsp'});
    assert.equal(Object.isFrozen(scopeCam.getLogScope()), true);
    assert.equal('sessionState' in scopeCam, false);

    const unnamedCam = new Camera({serial: 'T8161T0000000062', mode: 'rtsp'});
    assert.equal(unnamedCam.getLogScope().name, unnamedCam.getScopeName());
  });

  it('tags log lines of a Camera, a BackfillJob, and the Frigate event scope with their current state', () => {
    // Verify: tags log lines of a Camera, a BackfillJob, and the Frigate event scope with their current state.
    const {formatLogLine} = require('../../src/logger');
    const fixedDate = new Date(2026, 10, 5, 8, 4, 9);
    const stamp = '2026-11-05 08:04:09 - [INFO ] - ';
    const scopeCam = new Camera({serial: 'T8161T0000000063', name: 'log_scope_cam2', mode: 'rtsp'});
    assert.equal(formatLogLine('info', scopeCam, ['hi'], fixedDate), stamp + '[log_scope_cam2] [IDLE] hi');
    scopeCam.transitionTo('waking_rtsp', 1000, 'test wake');
    assert.equal(formatLogLine('info', scopeCam, ['hi'], fixedDate), stamp + '[log_scope_cam2] [WAKING_RTSP] hi');

    const job = new BackfillJob({name: 'doorbell_job', recordingActive: false, ignoreTimeWindow: true});
    assert.equal(formatLogLine('info', job, ['hi'], fixedDate), stamp + '[doorbell_job] [READY_TO_QUERY] hi');

    assert.equal(
      formatLogLine('info', scopeCam.getEventLogScope(), ['hi'], fixedDate),
      stamp + '[log_scope_cam2] [IDLE] hi'
    );
  });

  it('logs refused session, Frigate event, and decoder FSM transitions at DEBUG level', () => {
    // Verify: Camera wires refused-transition callbacks on SessionLifecycle, FrigateEventFiling, and StreamSession.
    const {log} = require('../../src/logger');
    const debugLines = [];
    const origDebug = log.debug;
    log.debug = (_scope, ...args) => debugLines.push(args.join(' '));
    try {
      const fsmCam = new Camera({serial: 'T8161T0000000064', name: 'fsm_cam', mode: 'rtsp'});
      fsmCam.transitionTo('streaming_live', 1000, 'skip');
      fsmCam.completeFrigateEventFiling(1000);
      fsmCam.markDecoderDecoding();
      assert.deepEqual(debugLines, [
        'refused session state: idle -> streaming_live (skip)',
        'refused frigate event state: idle -> cooldown (event filed)',
        'refused decoder state: detached -> decoding (first frame decoded)',
      ]);
    } finally {
      log.debug = origDebug;
    }
  });
});
