/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Enterprise unit test suite for domain models: Camera, StatusCard, Telemetry, and BackfillJob.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const testFs = require('node:fs');
const testPath = require('node:path');

const testTmpDir = testPath.resolve(__dirname, '..', '.tmp');
const testCacheDir = testPath.join(testTmpDir, 'cache');
testFs.mkdirSync(testCacheDir, {recursive: true});
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.BRIDGE_LOG_LEVEL = 'error';
process.env.TMPDIR = testTmpDir;
process.env.BRIDGE_CACHE_DIR = testCacheDir;

const {
  FRAME,
  PROCESS_SIGNALS,
  CARD_THEMES,
  CARD_POSITIONS,
  CARD_STATUS_TITLES,
  STREAM_MODES,
  FRAME_STAGE_MARKERS,
  COLOR_WHITE,
  COLOR_RED,
  COLOR_GREY,
  COLOR_GREEN,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_PURPLE,
} = require('../src/config');
const {initLogger} = require('../src/logger');
const {
  DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
  MAX_DOWNLOADED_PATHS_HISTORY,
  MAX_LIVE_PENDING_VIDEO_PACKETS,
  MAX_DOWNLOAD_PENDING_VIDEO_PACKETS,
  MAX_LIVE_PENDING_AUDIO_PACKETS,
  SESSION_STATES,
  ALLOWED_SESSION_TRANSITIONS,
  canTransitionSession,
  FRIGATE_EVENT_STATES,
  DECODER_STATES,
  WAKE_KINDS,
  WakeRequest,
  Camera,
} = require('../src/domain/camera');
const {
  STATUS_KINDS,
  POWER_LABELS,
  EUFY_DEVICE_STATES,
  EUFY_CHARGING_STATUS,
  EUFY_POWER_SOURCES,
  WIFI_SIGNAL_LEVELS,
  Telemetry,
  unwrapProperty,
  evaluateTelemetryState,
} = require('../src/domain/telemetry');
const {
  BackfillJob,
  BACKFILL_STATES,
  ALLOWED_BACKFILL_TRANSITIONS,
  canTransitionBackfill,
  extractDatabaseRecordCandidate,
  DEFAULT_BACKFILL_MAX_AGE_MS,
  BACKFILL_POST_CLEAR_SETTLE_MS,
  BACKFILL_RECORDING_WAIT_CAP_MS,
  BACKFILL_MAX_QUERY_ATTEMPTS,
} = require('../src/domain/backfill-job');
const {prepareBackgroundCanvas} = require('../src/overlay/yuv-canvas');
const {renderCameraCards, renderLiveFrameWithCard} = require('../src/overlay/card-renderer');
const {selectEncoderFrame, shouldWriteEncoderFrame, pushFrameToEncoder} = require('../src/media/encoder');
const {BACKFILL_SNAP_DELAY_MS, computeRequiredSnapshotDelay} = require('../src/services/frigate-client');

describe('Camera & Telemetry Domain Models', () => {
  it('derives Eufy Power Manager property sync changes for "rtsp" and "backfill" modes', () => {
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

    assert.equal(rtspCam.name, 'T8161T0000000000');
    assert.equal(backfillCam.name, 'T8214T2222222222');

    const rtspChanges = rtspCam.telemetry.evaluateRecordingModeChanges({
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

    const backfillChanges = backfillCam.telemetry.evaluateRecordingModeChanges({
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
    rtspCam.active = true;
    rtspCam.activeMode = 'rtsp';
    rtspCam.sleptAt = now - 500;

    doorbellCam.active = false;
    doorbellCam.sleptAt = now - 10000;

    assert.equal(doorbellCam.shouldBackfillOnlyOnEvent(), true);
    assert.equal(rtspCam.shouldBackfillOnlyOnEvent(), false);
    assert.equal(
      doorbellCam.isStationIdleForBackfill([rtspCam, doorbellCam], now, 5000),
      true,
      'RTSP activity on the same HomeBase must not block P2P backfill downloads'
    );

    rtspCam.active = false;
    rtspCam.activeMode = '';
    doorbellCam.sleptAt = now - 2000;
    assert.equal(
      doorbellCam.isStationIdleForBackfill([rtspCam, doorbellCam], now, 5000),
      false,
      'Recent P2P sleep within backfill_delay_secs must hold backfill'
    );
  });

  it(
    'enables rtspStream=true on startup in "rtsp" and RTSP-capable "backfill" modes, and ignores ' +
      'rtspStreamUrl in "p2p" mode',
    () => {
      const rtspCam = new Camera({serial: 'T8161T0000000000', mode: 'rtsp'});
      const p2pCam = new Camera({serial: 'T8161T1111111111', mode: 'p2p'});
      const backfillRtspCam = new Camera({serial: 'T8161T3333333333', mode: 'backfill'});
      const backfillDoorbell = new Camera({serial: 'T8214T2222222222', mode: 'backfill'});

      assert.equal(rtspCam.shouldEnableRtspProperty(false), true);
      assert.equal(rtspCam.shouldEnableRtspProperty(false), false, 'Only checks rtspStream once per session');
      assert.equal(rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live0'), true);
      assert.equal(rtspCam.isRtspCapable(), true);

      assert.equal(p2pCam.shouldEnableRtspProperty(false), false);
      assert.equal(p2pCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live1'), false);
      assert.equal(p2pCam.isRtspCapable(), false);
      assert.equal(p2pCam.stationSerial, 'T8030T0000000000');

      assert.equal(backfillRtspCam.shouldEnableRtspProperty(false), true);
      assert.equal(
        backfillRtspCam.isRtspCapable(),
        true,
        'RTSP-capable camera in backfill mode must be RTSP-capable immediately when rtspStream boolean ' +
          'is present even before rtspStreamUrl is populated'
      );
      backfillRtspCam.viewUntil = Date.now() + 20000;
      assert.equal(
        backfillRtspCam.wantsRtspWake(Date.now()),
        true,
        'Opening Live View on an RTSP-capable backfill camera must wake via RTSP, never P2P'
      );
      backfillRtspCam.viewUntil = 0;
      assert.equal(backfillRtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live2'), true);
      assert.equal(backfillRtspCam.isRtspCapable(), true);
      assert.equal(backfillRtspCam.shouldBackfillOnlyOnEvent(), true);

      assert.equal(backfillDoorbell.shouldEnableRtspProperty(undefined), false);
      assert.equal(backfillDoorbell.updateDiscoveredRtspConfig('T8030T0000000000', ''), false);
      assert.equal(backfillDoorbell.isRtspCapable(), false);

      // Regression: cameras in "backfill" mode never adopt external RTSP wakes or trigger-paired P2P wakes,
      // but can piggyback on standalone P2P wakes when no trigger/backfill is active (AT-01, AT-02, AT-05)
      const checkNow = Date.now() + 60000;
      assert.equal(backfillRtspCam.adoptExternalRtspWake(checkNow, 3000), false);
      assert.equal(backfillRtspCam.canAdoptExternalWake(checkNow, 3000), true);
      assert.equal(backfillDoorbell.canAdoptExternalWake(checkNow, 3000), true);
      backfillRtspCam.queueEventBackfill(checkNow, 'motion detected', '', 'motion detected', 50, true);
      backfillDoorbell.queueEventBackfill(checkNow, 'rings', '', 'rings', 100, true);
      assert.equal(backfillRtspCam.canAdoptExternalWake(checkNow, 3000), false);
      assert.equal(backfillDoorbell.canAdoptExternalWake(checkNow, 3000), false);
      backfillRtspCam.clearPendingBackfill();
      backfillDoorbell.clearPendingBackfill();
      assert.equal(rtspCam.canAdoptExternalWake(checkNow, 3000), true);
      assert.equal(p2pCam.canAdoptExternalWake(checkNow, 3000), true);

      // Regression: RTSP-capable camera in "backfill" mode emitting "rtsp livestream started" while IDLE
      // recording to HomeBase must not stop RTSP or disable rtspStream
      assert.deepEqual(backfillRtspCam.evaluateUnexpectedRtspStart(), {
        shouldStopRtsp: false,
        shouldDisableRtspProp: false,
        shouldRestartP2p: false,
      });
      assert.equal(backfillRtspCam.isRtspCapable(), true);
    }
  );

  it('auto-detects RTSP vs P2P in "auto" mode and defaults omitted title to Eufy device name', () => {
    const autoRtspCam = new Camera({serial: 'T8161T0000000000', name: 'garage'});
    const autoP2pCam = new Camera({serial: 'T8214T2222222222'});
    const explicitTitleCam = new Camera({
      serial: 'T8161T1111111111',
      name: 'driveway',
      title: 'Front Driveway Custom',
    });

    assert.equal(autoRtspCam.mode, 'auto');
    assert.equal(autoRtspCam.isRtspCapable(), false, 'Before rtspStreamUrl discovery, "auto" uses P2P');
    assert.equal(autoRtspCam.backfillDownloads, true);
    assert.equal(autoRtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live0'), true);
    assert.equal(autoRtspCam.isRtspCapable(), true, 'Uses HomeBase RTSP once rtspStreamUrl is discovered');

    assert.equal(autoP2pCam.updateDiscoveredRtspConfig('T8030T0000000000', ''), false);
    assert.equal(autoP2pCam.isRtspCapable(), false, 'Falls back to P2P when camera does not expose rtspStreamUrl');
    assert.equal(autoP2pCam.stationSerial, 'T8030T0000000000');

    // Omitted title defaults to camera name before telemetry load, then Eufy device name after telemetry load
    assert.equal(autoRtspCam.getDisplayTitle(), 'garage');
    autoRtspCam.telemetry.applyProperties({name: {value: 'Garage S350'}});
    assert.equal(autoRtspCam.getDisplayTitle(), 'Garage S350');

    // Explicit title in config.yaml always takes precedence over Eufy device name
    explicitTitleCam.telemetry.applyProperties({name: {value: 'Eufy App Name'}});
    assert.equal(explicitTitleCam.getDisplayTitle(), 'Front Driveway Custom');
  });

  it('preserves and upgrades pendingBackfill across companion events until 5s of live video is decoded', () => {
    const p2pCam = new Camera({
      serial: 'T8140T0000000000',
      mode: 'p2p',
    });

    const t0 = 500000;
    p2pCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    p2pCam.applyMotionTrigger(t0, 'motion detected', 60000, 'eufy-event', 10, 3000, 5000, 3000);
    assert.ok(p2pCam.pendingBackfill instanceof BackfillJob);
    assert.equal(p2pCam.pendingBackfill.event, 'motion detected');

    p2pCam.active = true;
    p2pCam.startedAt = t0;
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
    assert.ok(p2pCam.pendingBackfill instanceof BackfillJob);
    assert.equal(p2pCam.pendingBackfill.event, 'identity person detected');
    assert.equal(p2pCam.pendingBackfill.personName, 'Alice');

    // Once >= 20% of hold_secs (12s for a 60s hold) of live video is decoded, subsequent extension
    // clears pendingBackfill (AT-15)
    p2pCam.gotVideo = true;
    p2pCam.firstFrameAt = t0 + 1000;
    p2pCam.firstVideoAt = t0 + 1000;
    p2pCam.applyMotionTrigger(t0 + 14000, 'person detected', 60000, 'eufy-event', 200);
    assert.equal(p2pCam.pendingBackfill, null);
  });

  it('honors per-camera trigger_events, backfill_enabled, low_battery_threshold, and low_battery_wake_on_view', () => {
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
    assert.equal(standaloneCam.pendingBackfill, null);

    // Per-camera low_battery_threshold=35 triggers low-battery mode at 30% on doorbellCam, while
    // threshold=10 keeps 15% normal on standaloneCam
    doorbellCam.telemetry.applyProperties({battery: 30, chargingStatus: 2});
    standaloneCam.telemetry.applyProperties({battery: 15, chargingStatus: 2});

    assert.equal(doorbellCam.isLowBattery(), true);
    assert.equal(doorbellCam.canWakeOnViewerInLowBattery(), false);
    assert.equal(standaloneCam.isLowBattery(), false);
    assert.equal(standaloneCam.canWakeOnViewerInLowBattery(), true);
    standaloneCam.telemetry.applyProperties({battery: 4, chargingStatus: 2});
    assert.equal(standaloneCam.isCriticalBattery(), true);
  });

  it(
    'prevents RTSP re-wake loops during post-viewer linger and yields lingering station streams ' + 'on viewer switch',
    () => {
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
      cam1.viewUntil = t0 + 20000;
      cam1.viewerIds.set('v1', true);

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

      cam1.motionUntil = t0 + 60000;
      assert.equal(
        cam1.shouldRewakeRtspOnDrop(t0 + 15000),
        true,
        'Must re-wake RTSP on drop while motion hold is active'
      );

      cam1.motionUntil = 0;
      doorbell.beginSession('p2p', t0, false);
      doorbell.viewUntil = t0 + 20000;
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

      cam1.motionUntil = t0 + 60000;
      assert.equal(
        cam1.shouldYieldToNewStationViewer(cam2, t0 + 15000),
        false,
        'Camera with active motion must never yield to viewer switch'
      );
    }
  );
});

describe('StatusCard Domain Model & Frigate Polygon Masks', () => {
  it(
    'computes corner bounding boxes and worst-case invariant Frigate polygon masks across glance, minimal, ' +
      'pebbles, and hud themes',
    () => {
      const glanceCam = new Camera({serial: 'T8161T0000000000', card_theme: 'glance', card_position: 'top-left'});
      const pebblesCam = new Camera({serial: 'T8161T0101010101', card_theme: 'pebbles', card_position: 'bottom-left'});
      const minimalCam = new Camera({
        serial: 'T8161T1111111111',
        title: 'Front Patio',
        card_theme: 'minimal',
        card_position: 'bottom-right',
      });
      const centerCam = new Camera({serial: 'T8161T2222222222', card_theme: 'glance', card_position: 'center'});

      assert.equal(glanceCam.card.shouldOverlayOnLive(), true);
      assert.equal(pebblesCam.card.shouldOverlayOnLive(), true);
      assert.equal(minimalCam.card.shouldOverlayOnLive(), true);
      assert.equal(centerCam.card.shouldOverlayOnLive(), false);

      // Verify worst-case Frigate mask invariance when chargingStatus toggles Solar <-> Unplugged or lastSeen arrives
      const glancePolyInitial = glanceCam.computeMaskPolygon();
      const pebblesPolyInitial = pebblesCam.computeMaskPolygon();
      const minimalPolyInitial = minimalCam.computeMaskPolygon();
      assert.match(glancePolyInitial, /^0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3}$/);

      for (const c of [glanceCam, pebblesCam, minimalCam]) {
        c.applyTelemetryProperties({battery: 85, chargingStatus: 4, wifiRssi: -61, batteryTemperature: 23}, false);
        c.telemetry.updateLastSeen('14:30');
      }
      assert.equal(
        glanceCam.computeMaskPolygon(),
        glancePolyInitial,
        'Glance mask polygon must remain invariant across Solar and lastSeen telemetry changes'
      );
      assert.equal(
        pebblesCam.computeMaskPolygon(),
        pebblesPolyInitial,
        'Pebbles mask polygon must remain invariant across Solar and lastSeen telemetry changes'
      );
      assert.equal(
        minimalCam.computeMaskPolygon(),
        minimalPolyInitial,
        'Minimal corner mask polygon must remain invariant across Solar and lastSeen telemetry changes'
      );

      for (const c of [glanceCam, pebblesCam, minimalCam]) {
        c.applyTelemetryProperties({battery: 84, chargingStatus: 2}, false);
      }
      assert.equal(glanceCam.computeMaskPolygon(), glancePolyInitial);
      assert.equal(pebblesCam.computeMaskPolygon(), pebblesPolyInitial);
      assert.equal(minimalCam.computeMaskPolygon(), minimalPolyInitial);

      const glanceBounds = glanceCam.getCardBounds();
      assert.deepEqual(
        glanceBounds,
        {boxX: 24, boxY: 24, boxW: 138, boxH: 44},
        'Default Glance card (Status + merged Battery + Wi-Fi, with temperature and last_seen false by default) ' +
          'must be 138x44'
      );
      const pebblesBounds = pebblesCam.getCardBounds();
      assert.deepEqual(
        pebblesBounds,
        {boxX: 24, boxY: 652, boxW: 148, boxH: 44},
        'Default Pebbles card (three 44x44 circles for Status, merged Battery, and Wi-Fi + two 8px gaps) must be 148x44'
      );
      assert.equal(centerCam.computeMaskPolygon(), '');
    }
  );

  it(
    'respects sleep_screen ("snapshot", "slate", "black") for startup snapshot probing and YUV ' + 'canvas rendering',
    () => {
      const snapCamNoCache = new Camera(
        {serial: 'T8161T0000000000', sleep_screen: 'snapshot'},
        {frame: null, lastSeen: ''}
      );
      const snapCamWithCache = new Camera(
        {serial: 'T8161T0000000000', sleep_screen: 'snapshot'},
        {frame: Buffer.alloc(FRAME, 0x50), lastSeen: '12:00'}
      );
      const blackCam = new Camera({serial: 'T8161T1111111111', sleep_screen: 'black'}, {frame: null, lastSeen: ''});
      const slateCam = new Camera({serial: 'T8161T2222222222', sleep_screen: 'slate'}, {frame: null, lastSeen: ''});

      assert.equal(snapCamNoCache.needsStartupSnapshot, true);
      assert.equal(snapCamWithCache.needsStartupSnapshot, false);
      assert.equal(blackCam.needsStartupSnapshot, false);
      assert.equal(slateCam.needsStartupSnapshot, false);

      const blackBg = prepareBackgroundCanvas(blackCam.card.config, snapCamWithCache.lastFrame);
      assert.equal(blackBg.hasBackground, false);
      assert.equal(blackBg.baseCanvas[0], 0x10);

      const slateBg = prepareBackgroundCanvas(slateCam.card.config, snapCamWithCache.lastFrame);
      assert.equal(slateBg.hasBackground, false);
      assert.equal(slateBg.baseCanvas[0], 0x22);

      const snapBg = prepareBackgroundCanvas(snapCamWithCache.card.config, snapCamWithCache.lastFrame);
      assert.equal(snapBg.hasBackground, true);
      assert.equal(snapBg.baseCanvas[0], 0x50);
    }
  );

  it(
    'renders asleep, waking, busy, and live overlay frames across "glance", "minimal", ' +
      '"pebbles", and "none" themes',
    () => {
      const rawFrame = Buffer.alloc(FRAME, 0x40);
      const glanceCam = new Camera(
        {serial: 'T8161T0000000000', card_theme: 'glance', card_position: 'top-left', sleep_screen: 'snapshot'},
        {frame: rawFrame, lastSeen: '14:30'},
        renderCameraCards
      );
      const minimalCam = new Camera(
        {serial: 'T8161T1111111111', card_theme: 'minimal', card_position: 'bottom-left', sleep_screen: 'slate'},
        {frame: null, lastSeen: '14:30'},
        renderCameraCards
      );
      const pebblesCam = new Camera(
        {serial: 'T8161T3333333333', card_theme: 'pebbles', card_position: 'bottom-left', sleep_screen: 'snapshot'},
        {frame: rawFrame, lastSeen: '14:30'},
        renderCameraCards
      );
      const noneCam = new Camera(
        {serial: 'T8161T2222222222', card_theme: 'none', sleep_screen: 'black'},
        {frame: rawFrame, lastSeen: '14:30'},
        renderCameraCards
      );

      assert.equal(glanceCam.card.asleep.length, FRAME);
      assert.equal(minimalCam.card.asleep.length, FRAME);
      assert.equal(pebblesCam.card.asleep.length, FRAME);
      assert.equal(noneCam.card.asleep.length, FRAME);
      assert.equal(noneCam.card.asleep[0], 0x10);

      const liveGlance = renderLiveFrameWithCard(glanceCam, rawFrame);
      assert.notEqual(liveGlance, rawFrame, 'Corner card must composite onto scratch buffer without mutating rawFrame');
      assert.equal(rawFrame[0], 0x40);
      const liveGlanceNext = renderLiveFrameWithCard(glanceCam, rawFrame);
      assert.notEqual(
        liveGlanceNext,
        liveGlance,
        'Consecutive live overlay renders must alternate double buffers so in-flight encoder pipe writes never tear'
      );

      const livePebbles = renderLiveFrameWithCard(pebblesCam, rawFrame);
      assert.notEqual(livePebbles, rawFrame, 'Pebbles corner overlay must render onto scratch buffer');
      assert.equal(
        livePebbles.equals(Buffer.from(liveGlance)),
        false,
        'Pebbles overlay must differ from single-capsule Glance overlay'
      );

      const liveNone = renderLiveFrameWithCard(noneCam, rawFrame);
      assert.equal(liveNone, rawFrame, '"none" theme must return rawFrame directly');
    }
  );

  it(
    'honors startup_snapshot (true, false, "always") and card_show_on_live (true vs false, ' +
      'Live vs Backfill indicator)',
    () => {
      const cachedFrame = Buffer.alloc(FRAME, 0x55);

      const startupTrueNoCache = new Camera(
        {serial: 'T8161T0000000000', startup_snapshot: true, sleep_screen: 'snapshot'},
        {frame: null, lastSeen: ''}
      );
      const startupTrueWithCache = new Camera(
        {serial: 'T8161T0000000000', startup_snapshot: true, sleep_screen: 'snapshot'},
        {frame: cachedFrame, lastSeen: '12:00'}
      );
      const startupFalseNoCache = new Camera(
        {serial: 'T8161T1111111111', startup_snapshot: false, sleep_screen: 'snapshot'},
        {frame: null, lastSeen: ''}
      );
      const startupAlwaysWithCache = new Camera(
        {serial: 'T8214T2222222222', startup_snapshot: 'always', sleep_screen: 'snapshot'},
        {frame: cachedFrame, lastSeen: '12:00'}
      );

      assert.equal(startupTrueNoCache.needsStartupSnapshot, true);
      assert.equal(startupTrueWithCache.needsStartupSnapshot, false);
      assert.equal(startupFalseNoCache.needsStartupSnapshot, false);
      assert.equal(startupAlwaysWithCache.needsStartupSnapshot, true);

      const hideLiveCardCam = new Camera(
        {serial: 'T8161T0000000000', card_theme: 'glance', card_position: 'bottom-left', card_show_on_live: false},
        {frame: cachedFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      assert.equal(hideLiveCardCam.card.shouldOverlayOnLive(), false);

      const showLiveCardCam = new Camera(
        {serial: 'T8214T2222222222', card_theme: 'glance', card_position: 'bottom-left', card_show_on_live: true},
        {frame: cachedFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      assert.equal(showLiveCardCam.card.shouldOverlayOnLive(), true);

      // Live stream (activeMode='p2p') vs Backfill playback (activeMode='download') render distinct status glyphs
      showLiveCardCam.active = true;
      showLiveCardCam.activeMode = 'p2p';
      const liveOverlayBuf = Buffer.from(renderLiveFrameWithCard(showLiveCardCam, cachedFrame));
      showLiveCardCam.activeMode = 'download';
      const backfillOverlayBuf = Buffer.from(renderLiveFrameWithCard(showLiveCardCam, cachedFrame));
      assert.equal(
        liveOverlayBuf.equals(backfillOverlayBuf),
        false,
        'Backfill playback must render the rewind glyph instead of the live play triangle'
      );

      // Minimal theme renders tight backgroundless 64x12 footprint
      // (26x12 stadium pill [hollow in Backfill] + 7px gaps + two 12x12 dots)
      const minimalMarkerCam = new Camera(
        {serial: 'T8214T2222222222', card_theme: 'minimal', card_position: 'bottom-left', card_show_on_live: true},
        {frame: cachedFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      const minimalBounds = minimalMarkerCam.getCardBounds();
      assert.deepEqual(minimalBounds, {boxX: 24, boxY: 684, boxW: 64, boxH: 12});
      const maskPolyBefore = minimalMarkerCam.computeMaskPolygon();
      assert.equal(minimalMarkerCam.getFrameMarker(), 'S');
      minimalMarkerCam.active = true;
      minimalMarkerCam.activeMode = 'download';
      minimalMarkerCam.downloadPlayedFrames = 1;
      assert.equal(minimalMarkerCam.getFrameMarker(), 'FB');
      minimalMarkerCam.downloadPlayedFrames = 2;
      assert.equal(minimalMarkerCam.getFrameMarker(), 'B');
      const bMinimalBuf = Buffer.from(renderLiveFrameWithCard(minimalMarkerCam, cachedFrame));
      minimalMarkerCam.activeMode = 'p2p';
      assert.equal(minimalMarkerCam.getFrameMarker(), 'L');
      const lMinimalBuf = Buffer.from(renderLiveFrameWithCard(minimalMarkerCam, cachedFrame));
      assert.equal(
        bMinimalBuf.equals(lMinimalBuf),
        false,
        'Minimal card must distinguish hollow Backfill pill ring from solid Live pill'
      );
      assert.equal(
        minimalMarkerCam.computeMaskPolygon(),
        maskPolyBefore,
        'Minimal card Frigate mask bounds must remain unchanged'
      );

      // HUD theme renders distinct S, FB, B, and L frame stage markers in its status square
      // while keeping green [S] when Asleep
      const hudMarkerCam = new Camera(
        {serial: 'T8214T2222222222', card_theme: 'hud', card_position: 'bottom-left', card_show_on_live: true},
        {frame: cachedFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      const hudAsleepBuf = Buffer.from(renderLiveFrameWithCard(hudMarkerCam, cachedFrame, 1500));
      // Verify [S] stage square in HUD preserves green chroma (U < 120, V < 115) when camera is Asleep
      const hudBounds = hudMarkerCam.getCardBounds();
      assert.ok(hudBounds);
      const sqX = hudBounds.boxX + 14;
      const sqY = hudBounds.boxY + 14;
      const sqCIdx = (sqY >> 1) * 640 + (sqX >> 1);
      assert.ok(
        hudAsleepBuf[1280 * 720 + sqCIdx] < 120 && hudAsleepBuf[1280 * 720 + 640 * 360 + sqCIdx] < 115,
        'HUD [S] stage square must remain green when camera is Asleep'
      );

      hudMarkerCam.active = true;
      hudMarkerCam.activeMode = 'download';
      hudMarkerCam.firstFrameAt = 1000;
      hudMarkerCam.gotVideo = true;
      hudMarkerCam.downloadPlayedFrames = 1;
      const fbDebugBuf = Buffer.from(renderLiveFrameWithCard(hudMarkerCam, cachedFrame, 1500));
      hudMarkerCam.downloadPlayedFrames = 2;
      const bDebugBuf = Buffer.from(renderLiveFrameWithCard(hudMarkerCam, cachedFrame, 1500));
      hudMarkerCam.activeMode = 'p2p';
      const lDebugBuf = Buffer.from(renderLiveFrameWithCard(hudMarkerCam, cachedFrame, 1500));
      assert.equal(
        fbDebugBuf.equals(bDebugBuf),
        false,
        'HUD must distinguish FB (First Backfill frame) from B (Backfill frames)'
      );
      assert.equal(bDebugBuf.equals(lDebugBuf), false, 'HUD must distinguish B (Backfill frames) from L (Live frames)');
    }
  );

  it(
    'renders embedded Lucide contour sprites (zero glare, sky-blue charging fill, 3-dot waiting ellipsis) ' +
      'without external fonts or FFmpeg',
    () => {
      // Verify embedded Lucide contour sprites, 3-dot waiting ellipsis, clock hands mask, and
      // zero-FFmpeg card rendering
      const fs = require('node:fs');
      const path = require('node:path');
      const {LUCIDE_ICON_SPRITES, getClockHandsMask} = require('../src/overlay/ui-glyphs');

      // Verify bare Lucide contour sprites (crescent moon standby, 3-dot waiting ellipsis, wifi-off
      // disconnected, 15x15 power badges)
      assert.equal(LUCIDE_ICON_SPRITES.wifiTiers.length, 4);
      assert.equal(LUCIDE_ICON_SPRITES.status.waiting.width, 24);
      assert.equal(LUCIDE_ICON_SPRITES.powerBadge15.plugged.width, 15);
      assert.equal(LUCIDE_ICON_SPRITES.powerBadge15.bolt.width, 15);
      assert.equal(
        Buffer.from(LUCIDE_ICON_SPRITES.powerBadge15.solar.mask).equals(
          Buffer.from(LUCIDE_ICON_SPRITES.powerBadge15.bolt.mask)
        ),
        false,
        'Lucide Solar sun badge must differ from USB charging bolt badge'
      );
      assert.equal(
        Buffer.from(LUCIDE_ICON_SPRITES.status.disconnected.mask).equals(
          Buffer.from(LUCIDE_ICON_SPRITES.status.standby.mask)
        ),
        false,
        'Disconnected wifi-off sprite must differ from Standby crescent moon'
      );
      assert.equal(
        Buffer.from(LUCIDE_ICON_SPRITES.status.waiting.mask).equals(
          Buffer.from(LUCIDE_ICON_SPRITES.status.standby.mask)
        ),
        false,
        'Waiting 3-dot ellipsis sprite must differ from Standby crescent moon'
      );
      // Verify closed status icons (including 24x24 waking zap) are solid-filled inside without outer glare discs
      assert.equal(LUCIDE_ICON_SPRITES.status.standby.width, 24, 'Standard status icons must be 24x24');
      assert.equal(LUCIDE_ICON_SPRITES.batteryShell.width, 30, 'Standard battery icon must be 30x20');
      assert.equal(LUCIDE_ICON_SPRITES.batteryShell.height, 20, 'Standard battery icon must be 30x20');
      assert.equal(LUCIDE_ICON_SPRITES.powerBadge15.solar.width, 15, 'Top-right power badge must be 15x15');
      assert.equal(LUCIDE_ICON_SPRITES.wifiTiers[0].width, 24, 'Standard Wi-Fi icon must be 24x24');
      assert.equal(LUCIDE_ICON_SPRITES.thermometer.width, 20, 'Standard thermometer icon must be 20x24');
      assert.equal(LUCIDE_ICON_SPRITES.thermometer.height, 24, 'Standard thermometer icon must be 20x24');
      assert.equal(LUCIDE_ICON_SPRITES.clockRing.width, 24, 'Standard clock icon must be 24x24');
      assert.equal(
        LUCIDE_ICON_SPRITES.status.waking.mask[12 * 24 + 12],
        255,
        'Waking status icon (zap) must be solid-filled at its center'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.waking.mask[0],
        0,
        'Status icons must have no solid filled glare disc in outer corners'
      );

      const handsA = getClockHandsMask('09:15', 24);
      const handsB = getClockHandsMask('03:45', 24);
      assert.equal(
        handsA,
        getClockHandsMask('09:15', 24),
        'Clock hands mask must be cached for identical HH:MM and size'
      );
      assert.equal(Buffer.from(handsA).equals(Buffer.from(handsB)), false);

      // Verify corner Glance card renders without FONT_FILE and blurs live video directly
      const prevFontEnv = process.env.FONT_FILE;
      process.env.FONT_FILE = '/nonexistent/missing.ttf';
      try {
        const darkSnap = Buffer.alloc(FRAME, 0x20);
        darkSnap.fill(0x80, 1280 * 720);
        const cornerGlance = new Camera(
          {
            serial: 'T8161T3333333333',
            title: 'Front Patio',
            card_theme: 'glance',
            card_position: 'bottom-left',
            card_show_on_live: true,
          },
          {frame: darkSnap, lastSeen: '14:30'},
          renderCameraCards
        );
        cornerGlance.applyTelemetryProperties({
          battery: 88,
          chargingStatus: 4,
          wifiRssi: -61,
          temperature: 23,
        });
        renderCameraCards(cornerGlance);

        cornerGlance.active = true;
        cornerGlance.activeMode = 'p2p';
        const brightLiveFrame = Buffer.alloc(FRAME, 0xc8);
        brightLiveFrame.fill(0x80, 1280 * 720);
        const liveOverDark = Buffer.from(renderLiveFrameWithCard(cornerGlance, darkSnap));
        const liveOverBright = Buffer.from(renderLiveFrameWithCard(cornerGlance, brightLiveFrame));
        const bounds = cornerGlance.getCardBounds();
        assert.ok(bounds);
        assert.equal(bounds.boxH, 44, 'Glance corner card must be 44px tall');
        const sampleIdx = (bounds.boxY + 12) * 1280 + (bounds.boxX + 44);
        assert.notEqual(
          liveOverDark[sampleIdx],
          liveOverBright[sampleIdx],
          'Glance live overlay must blur the real live frame backdrop instead of copying a stale sleeping snapshot'
        );

        cornerGlance.activeMode = 'download';
        const bfOverDark = Buffer.from(renderLiveFrameWithCard(cornerGlance, darkSnap));
        assert.equal(liveOverDark.equals(bfOverDark), false);
      } finally {
        if (prevFontEnv === undefined) {
          delete process.env.FONT_FILE;
        } else {
          process.env.FONT_FILE = prevFontEnv;
        }
      }

      // Verify overlaid Lucide power badges (Solar vs Plugged vs Charging) + sky-blue fill on "glance" theme
      const snap = Buffer.alloc(FRAME, 0x30);
      snap.fill(0x80, 1280 * 720);
      const makeGlanceCardForCharging = (chargingStatus) => {
        const c = new Camera(
          {serial: 'T8161T5555555555', card_theme: 'glance', card_position: 'top-left'},
          {frame: snap, lastSeen: '10:20'}
        );
        c.applyTelemetryProperties({battery: 80, chargingStatus, wifiRssi: -60, temperature: 22});
        renderCameraCards(c);
        return Buffer.from(c.card.asleep);
      };
      const usbChargingBuf = makeGlanceCardForCharging(1);
      const pluggedBuf = makeGlanceCardForCharging(3);
      const solarBuf = makeGlanceCardForCharging(4);
      const unpluggedBuf = makeGlanceCardForCharging(2);
      assert.equal(usbChargingBuf.equals(solarBuf), false, 'Lucide Solar icon must differ from USB Charging bolt');
      assert.equal(usbChargingBuf.equals(pluggedBuf), false, 'Lucide Plugged icon must differ from USB Charging bolt');
      assert.equal(solarBuf.equals(pluggedBuf), false, 'Lucide Solar icon must differ from Plugged icon');
      assert.equal(
        solarBuf.equals(unpluggedBuf),
        false,
        'Charging sky-blue fill + Solar icon must differ from unplugged white fill'
      );

      const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'card-renderer.js'), 'utf8');
      assert.equal(rendererSrc.includes('spawnSync'), false, 'card-renderer.js must not spawn FFmpeg');
      assert.equal(rendererSrc.includes('FONT_FILE'), false, 'card-renderer.js must not read FONT_FILE');

      const dockerfilePath = path.join(__dirname, '..', 'deploy', 'Dockerfile');
      if (fs.existsSync(dockerfilePath)) {
        const dockerfileText = fs.readFileSync(dockerfilePath, 'utf8');
        assert.equal(dockerfileText.includes('font-inter'), false, 'Dockerfile must not install font-inter');
        assert.equal(dockerfileText.includes('FONT_FILE'), false, 'Dockerfile must not define FONT_FILE');
      }
    }
  );

  it(
    'renders backgroundless "minimal" (26x12 pill + hollow Backfill pill + 7px gaps + 12x12 dots), ' +
      'multi-pebble "pebbles" theme, solid-filled status icons, and Smoked Obsidian crystal surface',
    () => {
      // Verify backgroundless minimal geometry, multi-pebble pebbles theme + 8px gaps, solid-filled
      // status icons, and Smoked Obsidian (#080b12) crystal surface
      const fs = require('node:fs');
      const path = require('node:path');
      const {LUCIDE_ICON_SPRITES} = require('../src/overlay/ui-glyphs');
      assert.ok(
        LUCIDE_ICON_SPRITES.minimal,
        'LUCIDE_ICON_SPRITES.minimal must provide pre-baked minimal pill & dot sprites'
      );
      assert.equal(LUCIDE_ICON_SPRITES.minimal.pillFg.width, 26);
      assert.equal(LUCIDE_ICON_SPRITES.minimal.pillFg.height, 12);
      assert.equal(LUCIDE_ICON_SPRITES.minimal.pillRing.width, 26);
      assert.equal(LUCIDE_ICON_SPRITES.minimal.pillRing.height, 12);
      assert.equal(LUCIDE_ICON_SPRITES.minimal.dotFg.width, 12);
      assert.equal(LUCIDE_ICON_SPRITES.minimal.dotFg.height, 12);

      // Verify status icons (standby moon, live play, backfill rewind, waiting 3-dot ellipsis)
      // are solid-filled silhouettes
      assert.equal(
        LUCIDE_ICON_SPRITES.status.standby.mask[14 * 24 + 6],
        255,
        'status.standby crescent moon interior must be solid-filled (255)'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.live.mask[12 * 24 + 10],
        255,
        'status.live play triangle interior must be solid-filled (255)'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.backfill.mask[12 * 24 + 8],
        255,
        'status.backfill rewind triangle interior must be solid-filled (255)'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.waiting.mask[12 * 24 + 5],
        255,
        'status.waiting left ellipsis dot center (x=5, y=12) must be solid-filled (255)'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.waiting.mask[12 * 24 + 12],
        255,
        'status.waiting middle ellipsis dot center (x=12, y=12) must be solid-filled (255)'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.waiting.mask[12 * 24 + 19],
        255,
        'status.waiting right ellipsis dot center (x=19, y=12) must be solid-filled (255)'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.waiting.mask[12 * 24 + 8],
        0,
        'status.waiting gap between left and middle ellipsis dots (x=8, y=12) must be empty (0)'
      );
      assert.equal(
        LUCIDE_ICON_SPRITES.status.waiting.mask[5 * 24 + 12],
        0,
        'status.waiting top center (x=12, y=5) must be empty (0)'
      );

      const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'card-renderer.js'), 'utf8');
      const minimalFnMatch = /function drawMinimalDotsCard[\s\S]*?\n\}/.exec(rendererSrc);
      assert.ok(minimalFnMatch, 'drawMinimalDotsCard must exist');
      assert.equal(
        minimalFnMatch[0].includes('drawStatusGlyph'),
        false,
        'drawMinimalDotsCard must never render icons via drawStatusGlyph'
      );
      assert.equal(
        minimalFnMatch[0].includes('drawCrystalSurface'),
        false,
        'drawMinimalDotsCard must render with no background surface at all'
      );

      const brightSkyFrame = Buffer.alloc(FRAME, 0xd0);
      brightSkyFrame.fill(0x80, 1280 * 720);
      const minCam = new Camera(
        {serial: 'SN0000000066', card_theme: 'minimal', card_position: 'bottom-left', card_show_on_live: true},
        {frame: brightSkyFrame, lastSeen: '13:45'},
        renderCameraCards
      );
      const glanceCam = new Camera(
        {serial: 'SN0000000067', card_theme: 'glance', card_position: 'bottom-left', card_show_on_live: true},
        {frame: brightSkyFrame, lastSeen: '13:45'},
        renderCameraCards
      );
      const pebblesCam = new Camera(
        {
          serial: 'SN0000000070',
          card_theme: 'pebbles',
          card_position: 'bottom-left',
          card_show_on_live: true,
          telemetry: {temperature: true, last_seen: true},
        },
        {frame: brightSkyFrame, lastSeen: '13:45'},
        renderCameraCards
      );
      for (const c of [minCam, glanceCam, pebblesCam]) {
        c.applyTelemetryProperties({battery: 85, chargingStatus: 2, wifiRssi: -60, temperature: 21});
        renderCameraCards(c);
      }

      const minBounds = minCam.getCardBounds();
      const glanceBounds = glanceCam.getCardBounds();
      const pebblesBounds = pebblesCam.getCardBounds();
      assert.deepEqual(minBounds, {boxX: 24, boxY: 684, boxW: 64, boxH: 12});
      assert.equal(glanceBounds.boxH, 44, 'Glance capsule must be 44px tall for crisp 24x24 icons');
      assert.equal(pebblesBounds.boxH, 44, 'Pebbles split theme must match 44px height');

      // Verify center-top / top-center and center-bottom / bottom-center positions
      const centerTopCam = new Camera(
        {serial: 'SN0000000072', card_theme: 'minimal', card_position: 'center-top', card_show_on_live: true},
        {frame: brightSkyFrame, lastSeen: '13:45'},
        renderCameraCards
      );
      const topCenterCam = new Camera(
        {serial: 'SN0000000073', card_theme: 'minimal', card_position: 'top-center', card_show_on_live: true},
        {frame: brightSkyFrame, lastSeen: '13:45'},
        renderCameraCards
      );
      const centerBottomCam = new Camera(
        {serial: 'SN0000000074', card_theme: 'minimal', card_position: 'center-bottom', card_show_on_live: true},
        {frame: brightSkyFrame, lastSeen: '13:45'},
        renderCameraCards
      );
      const bottomCenterCam = new Camera(
        {serial: 'SN0000000075', card_theme: 'minimal', card_position: 'bottom-center', card_show_on_live: true},
        {frame: brightSkyFrame, lastSeen: '13:45'},
        renderCameraCards
      );
      assert.equal(centerTopCam.card.position, 'top-center');
      assert.equal(topCenterCam.card.position, 'top-center');
      assert.equal(centerBottomCam.card.position, 'bottom-center');
      assert.equal(bottomCenterCam.card.position, 'bottom-center');
      assert.deepEqual(centerTopCam.getCardBounds(), {boxX: 608, boxY: 24, boxW: 64, boxH: 12});
      assert.deepEqual(topCenterCam.getCardBounds(), {boxX: 608, boxY: 24, boxW: 64, boxH: 12});
      assert.deepEqual(centerBottomCam.getCardBounds(), {boxX: 608, boxY: 684, boxW: 64, boxH: 12});
      assert.deepEqual(bottomCenterCam.getCardBounds(), {boxX: 608, boxY: 684, boxW: 64, boxH: 12});
      assert.equal(centerTopCam.card.shouldOverlayOnLive(), true);
      assert.equal(centerBottomCam.card.shouldOverlayOnLive(), true);
      assert.ok(centerTopCam.computeMaskPolygon().length > 0);
      assert.ok(centerBottomCam.computeMaskPolygon().length > 0);

      // Verify minimal theme has NO background (gap pixel stays untouched 0xd0) and keeps bright semantic dot fill
      const minCy = minBounds.boxY + 6;
      const minGapLuma = minCam.card.asleep[minCy * 1280 + (minBounds.boxX + 29)];
      const minDotCenterLuma = minCam.card.asleep[minCy * 1280 + (minBounds.boxX + 39)];
      assert.equal(
        minGapLuma,
        0xd0,
        'Minimal theme must have no background surface (gap between pill and dot stays raw 0xd0 backdrop)'
      );
      assert.ok(minDotCenterLuma >= 0xd8, 'Minimal theme dot center must render bright semantic ink');

      // Verify Smoked Obsidian (#080b12 at 54% alpha, borderless) crystal surface and
      // solid-filled status icon on Glance
      const glanceCy = glanceBounds.boxY + 22;
      const glanceCrystalLuma = glanceCam.card.asleep[glanceCy * 1280 + (glanceBounds.boxX + 44)];
      const glanceMoonFillLuma = glanceCam.card.asleep[(glanceCy + 2) * 1280 + (glanceBounds.boxX + 22)];
      assert.ok(
        glanceCrystalLuma >= 0x58 && glanceCrystalLuma <= 0x88,
        'Smoked Obsidian crystal surface must smoke bright 0xd0 scenes into 0x58..0x88 luma'
      );
      assert.ok(
        glanceMoonFillLuma >= 0xd8 && glanceMoonFillLuma - glanceCrystalLuma >= 75,
        'Solid-filled standby moon icon must render bright calm-white (>= 0xd8) over Smoked Obsidian glass'
      );
      const blackGlanceCam = new Camera(
        {serial: 'SN0000000071', card_theme: 'glance', card_position: 'bottom-left', sleep_screen: 'black'},
        {frame: null, lastSeen: '13:45'},
        renderCameraCards
      );
      blackGlanceCam.applyTelemetryProperties({battery: 85, chargingStatus: 2, wifiRssi: -60, temperature: 21});
      renderCameraCards(blackGlanceCam);
      const blackCrystalLuma = blackGlanceCam.card.asleep[glanceCy * 1280 + (glanceBounds.boxX + 44)];
      const blackMoonFillLuma = blackGlanceCam.card.asleep[(glanceCy + 2) * 1280 + (glanceBounds.boxX + 22)];
      assert.ok(
        blackCrystalLuma >= 0x1a && blackCrystalLuma <= 0x36,
        'Smoked Obsidian crystal surface on black background must stay near classic 0x1a..0x36 luma'
      );
      assert.ok(
        blackMoonFillLuma >= 0xd8,
        'Solid-filled standby moon icon must stay calm-white (>= 0xd8) on dark/black backgrounds'
      );

      // Verify compacted 7px gaps in tight 64x12 minimal: pill [x=0..25], gap1 [x=26..32], bat dot [x=33..44],
      // gap2 [x=45..51], wifi dot [x=52..63]
      const gap1Luma = minCam.card.asleep[minCy * 1280 + (minBounds.boxX + 29)];
      const gap2Luma = minCam.card.asleep[minCy * 1280 + (minBounds.boxX + 48)];
      assert.equal(
        gap1Luma,
        gap2Luma,
        'Both compacted 7px inter-item gaps in minimal must preserve identical backdrop luma'
      );

      // Verify Battery dot (x=33) and Wi-Fi dot (x=52) render identical 12x12 dots when healthy unplugged
      for (let row = 0; row < 12; row++) {
        for (let col = 0; col < 12; col++) {
          const y = minBounds.boxY + row;
          const pBat = minCam.card.asleep[y * 1280 + (minBounds.boxX + 33 + col)];
          const pWifi = minCam.card.asleep[y * 1280 + (minBounds.boxX + 52 + col)];
          assert.equal(pBat, pWifi, 'Healthy Battery and Wi-Fi 12x12 dots must match identically');
        }
      }

      // Verify minimal Live renders a solid red stadium pill while Backfill renders a hollow red stadium pill ring
      const darkScene = Buffer.alloc(FRAME, 0x24);
      darkScene.fill(0x80, 1280 * 720);
      minCam.active = true;
      minCam.activeMode = 'p2p';
      const minLive = Buffer.from(renderLiveFrameWithCard(minCam, darkScene));
      minCam.activeMode = 'download';
      const minBackfill = Buffer.from(renderLiveFrameWithCard(minCam, darkScene));
      assert.equal(
        minLive.equals(minBackfill),
        false,
        'Minimal must distinguish solid Live pill from hollow Backfill pill ring'
      );

      const pillCx = minBounds.boxX + 13;
      const darkBackdropAtGap = minBackfill[minCy * 1280 + (minBounds.boxX + 29)];
      assert.equal(
        minBackfill[minCy * 1280 + pillCx],
        darkBackdropAtGap,
        'Hollow Backfill pill ring center must expose untouched backdrop without any fill'
      );
      assert.ok(
        minLive[minCy * 1280 + pillCx] > darkBackdropAtGap + 20,
        'Live stadium pill center must be solidly filled'
      );

      // Verify zero glare under status icon in Glance: open corner inside moon curve matches adjacent crystal luma
      glanceCam.lastFrame = darkScene;
      renderCameraCards(glanceCam);
      const glanceOpenGlass = glanceCam.card.asleep[glanceCy * 1280 + (glanceBounds.boxX + 46)];
      const insideMoonConcavity = glanceCam.card.asleep[(glanceCy - 4) * 1280 + (glanceBounds.boxX + 32)];
      assert.ok(
        Math.abs(insideMoonConcavity - glanceOpenGlass) <= 2,
        'Status icon must have zero circular glare or halo disc underneath'
      );

      // Verify Pebbles: every enabled icon renders in an identical 44x44 circular pebble separated by 8px
      // untouched video gaps, and merges the 15x15 power badge on top of the top-right battery corner with
      // a crystal cutout
      assert.ok(
        LUCIDE_ICON_SPRITES.powerBadge15,
        'LUCIDE_ICON_SPRITES.powerBadge15 must provide 15x15 top-right badges'
      );
      assert.equal(LUCIDE_ICON_SPRITES.powerBadge15.bolt.width, 15);
      assert.equal(LUCIDE_ICON_SPRITES.powerBadge15.solar.width, 15);
      assert.equal(LUCIDE_ICON_SPRITES.powerBadge15.plugged.width, 15);
      assert.ok(
        LUCIDE_ICON_SPRITES.batteryCutout,
        'LUCIDE_ICON_SPRITES.batteryCutout must provide pre-cutout battery shells'
      );

      const {computePebblesCardWidths} = require('../src/domain/status-card');
      assert.deepEqual(
        computePebblesCardWidths({
          showBat: true,
          showWifi: true,
          showTemp: true,
          showClock: true,
        }).pebbleWidths,
        [44, 44, 44, 44, 44],
        'Pebbles must allocate identical 44x44 circular pebbles for Status, Battery, Wi-Fi, Temperature, and Clock'
      );
      assert.deepEqual(
        computePebblesCardWidths({
          showBat: false,
          showWifi: true,
          showTemp: false,
          showClock: true,
        }).pebbleWidths,
        [44, 44, 44],
        'Pebbles must omit any icon pebble configured not to be shown'
      );
      assert.deepEqual(
        computePebblesCardWidths({
          showBat: false,
          showWifi: false,
          showTemp: false,
          showClock: false,
        }).pebbleWidths,
        [44],
        'Pebbles must render only the 44x44 Status pebble when all sensor icons are disabled'
      );

      pebblesCam.lastFrame = darkScene;
      renderCameraCards(pebblesCam);
      const pebblesCy = pebblesBounds.boxY + 22;
      // All-icons layout: [44, 44, 44, 44, 44] with 8px gaps at x offsets 44..51, 96..103, 148..155, 200..207
      for (const gapStart of [44, 96, 148, 200]) {
        const gapMidX = pebblesBounds.boxX + gapStart + 4;
        assert.equal(
          pebblesCam.card.asleep[pebblesCy * 1280 + gapMidX],
          0x24,
          'Each 8px gap between separate icon pebbles (offset ' + gapStart + ') must expose the untouched video frame'
        );
      }
      const noTempClockPebblesCam = new Camera(
        {
          serial: 'SN0000000076',
          card_theme: 'pebbles',
          card_position: 'bottom-left',
          telemetry: {battery: true, power_source: false, wifi: true, temperature: false, last_seen: false},
        },
        {frame: darkScene, lastSeen: '13:45'},
        renderCameraCards
      );
      noTempClockPebblesCam.applyTelemetryProperties({battery: 85, chargingStatus: 2, wifiRssi: -60, temperature: 21});
      renderCameraCards(noTempClockPebblesCam);
      assert.equal(
        noTempClockPebblesCam.getCardBounds().boxW,
        44 + 8 + 44 + 8 + 44,
        'Pebbles bounds must shrink to match only the configured 44x44 pebbles (Status + Battery + Wi-Fi)'
      );
      assert.equal(
        noTempClockPebblesCam.card.asleep[pebblesCy * 1280 + (pebblesBounds.boxX + 156 + 22)],
        0x24,
        'Disabled Temperature pebble region must remain untouched background video'
      );

      pebblesCam.active = true;
      pebblesCam.activeMode = 'p2p';
      const pebblesLive = Buffer.from(renderLiveFrameWithCard(pebblesCam, darkScene));
      // Status Pebble interior (boxX + 6, cy) floods with translucent Red jewel tint on Live (V chroma > 145),
      // while Asleep stays neutral crystal (V ~ 127..128)
      const pebbleSampleX = (pebblesBounds.boxX + 6) & ~1;
      const pebbleSampleY = pebblesCy & ~1;
      const pebbleVIdx = 1280 * 720 + 640 * 360 + (pebbleSampleY >> 1) * 640 + (pebbleSampleX >> 1);
      assert.ok(
        Math.abs(pebblesCam.card.asleep[pebbleVIdx] - 0x80) <= 2,
        'Pebbles Status Pebble must stay neutral crystal without red jewel flood when Asleep'
      );
      assert.ok(
        pebblesLive[pebbleVIdx] > 145,
        'Pebbles Status Pebble must flood with semantic red jewel tint when Live'
      );

      // Verify hairline-free, borderless smooth anti-aliased Smoked Obsidian crystal surface and 2x2 YUV420p
      // chroma on odd-X pebbles battery
      const outerAboveDark = glanceCam.card.asleep[(glanceBounds.boxY - 1) * 1280 + (glanceBounds.boxX + 46)];
      const darkTopEdge = glanceCam.card.asleep[glanceBounds.boxY * 1280 + (glanceBounds.boxX + 46)];
      assert.equal(
        outerAboveDark,
        0x24,
        'Smoked Obsidian crystal surface must have zero outer hairline or shadow halo above boxY'
      );
      assert.ok(
        darkTopEdge >= Math.min(0x24, glanceOpenGlass) && darkTopEdge <= Math.max(0x24, glanceOpenGlass) + 2,
        'Smoked Obsidian crystal top edge must transition monotonically without a dark trench or white rim'
      );
      // Verify odd-X battery fill bar in Pebbles (boxX=24, batPebbleX=76, batX=85, fillX=89) blends sky-blue
      // U chroma (> 134) on its left edge
      pebblesCam.applyTelemetryProperties({battery: 80, chargingStatus: 1, wifiRssi: -60, temperature: 21});
      renderCameraCards(pebblesCam);
      const oddFillLeftX = pebblesBounds.boxX + 52 + 9 + 4;
      const oddFillCIdx = (pebblesCy >> 1) * 640 + (oddFillLeftX >> 1);
      const oddFillU = pebblesCam.card.asleep[1280 * 720 + oddFillCIdx];
      assert.ok(
        oddFillU > 134,
        'Odd-X battery charge fill bar in Pebbles must blend sky-blue U chroma (> 134) on its left edge ' +
          'without odd-column chroma drop'
      );
      const wakingIconCenterLuma = glanceCam.card.waking[glanceCy * 1280 + (glanceBounds.boxX + 28)];
      assert.ok(
        wakingIconCenterLuma - glanceOpenGlass >= 55,
        'Waking status icon (zap) must be solid-filled in its interior'
      );
    }
  );
});

describe('BackfillJob Event-End Aware Settlement & Clip Matching', () => {
  it('waits for all active trigger properties to report state=false + 4s settle (or scaled holdMs + 4s cap)', () => {
    const doorbellCam = new Camera({
      serial: 'T8214T2222222222',
      mode: 'backfill',
    });

    const t0 = 1000000;
    doorbellCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    doorbellCam.queueEventBackfill(t0 + 2000, 'person detected', '', 'person detected', 200, true);
    assert.equal(doorbellCam.canQueryBackfill(t0 + 10000, 8000, 12000), false);
    assert.equal(doorbellCam.canQueryBackfill(t0 + BACKFILL_RECORDING_WAIT_CAP_MS + 50, 8000, 12000), true);

    // Clearing only "person detected" while "motion detected" is still active must NOT mark recording cleared
    doorbellCam.recordMotionCleared(t0 + 6000, 5000, 10000, 'person detected');
    assert.equal(doorbellCam.isBackfillRecordingCleared(), false);
    assert.equal(doorbellCam.canQueryBackfill(t0 + 11000, 8000, 12000), false);

    // Clearing "motion detected" completes all active triggers and starts the 4s post-clear settle window
    const tClear = t0 + 11000;
    doorbellCam.recordMotionCleared(tClear, 5000, 10000, 'motion detected');
    assert.equal(doorbellCam.isBackfillRecordingCleared(), true);
    assert.equal(doorbellCam.canQueryBackfill(tClear + 1000, 8000, 12000), false);
    assert.equal(doorbellCam.canQueryBackfill(tClear + BACKFILL_POST_CLEAR_SETTLE_MS + 50, 8000, 12000), true);

    // Follow-up state=true trigger before query re-asserts active recording state
    doorbellCam.queueEventBackfill(tClear + 1500, 'rings', '', 'rings', 1000, true);
    assert.equal(doorbellCam.isBackfillRecordingCleared(), false);
    assert.equal(doorbellCam.canQueryBackfill(tClear + BACKFILL_POST_CLEAR_SETTLE_MS + 50, 8000, 12000), false);
  });

  it('queues multi-clip HomeBase recordings in chronological order while keeping SIGUSR1 single-clip', () => {
    const doorbellCam = new Camera({
      serial: 'T8214T2222222222',
      mode: 'backfill',
    });

    const t0 = 2000000;
    doorbellCam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
    doorbellCam.recordMotionCleared(t0 + 25000, 5000, 10000, 'person detected');

    const newerClip = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170020.zxvideo',
      cipherId: 2,
      clipMs: t0 + 20000,
    };
    const olderClip = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170002.zxvideo',
      cipherId: 1,
      clipMs: t0 + 2000,
    };

    // Database query returns newest first; Camera must sort queued event clips chronologically (oldest -> newest)
    assert.equal(doorbellCam.tryMatchBackfillCandidate(newerClip), true);
    assert.equal(doorbellCam.tryMatchBackfillCandidate(olderClip), true);
    assert.equal(doorbellCam.backfillClipQueue.length, 2);
    assert.equal(doorbellCam.backfillClip.storagePath, olderClip.storagePath);

    // Starting download of Clip 1 shifts Clip 1 and keeps Clip 2 ready in backfillClipQueue
    doorbellCam.beginBackfillDownload(doorbellCam.backfillClip, false, t0 + 30000);
    assert.equal(doorbellCam.backfillClipQueue.length, 1);
    assert.equal(doorbellCam.backfillClip.storagePath, newerClip.storagePath);
    assert.ok(doorbellCam.activeBackfillJob instanceof BackfillJob);

    doorbellCam.endSession(t0 + 40000);
    assert.equal(doorbellCam.isReadyForBackfillDownload(), true);
    assert.equal(doorbellCam.backfillClip.storagePath, newerClip.storagePath);
    assert.equal(doorbellCam.tryMatchBackfillCandidate(olderClip), false, 'Already downloaded path is skipped');

    // SIGUSR1 urgent test clears downloadedPaths and only matches the single newest clip
    doorbellCam.prepareSigUsr1BackfillTest(t0 + 50000);
    const sigClip1 = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170100.zxvideo',
      cipherId: 3,
      clipMs: t0 + 49000,
    };
    const sigClip2 = {
      devSn: 'T8214T2222222222',
      storagePath: '/media/mmcblk0p1/video/20261105170050.zxvideo',
      cipherId: 4,
      clipMs: t0 + 45000,
    };
    assert.equal(doorbellCam.tryMatchBackfillCandidate(sigClip1), true);
    assert.equal(doorbellCam.tryMatchBackfillCandidate(sigClip2), false);
    assert.equal(doorbellCam.backfillClipQueue.length, 1);
  });

  it(
    'schedules a follow-up query for split clips and enforces frame-drain, decoder flush, ' + 'and post-playback hold',
    () => {
      const doorbellCam = new Camera({
        serial: 'T8214T2222222222',
        mode: 'backfill',
      });

      const t0 = 3000000;
      doorbellCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
      doorbellCam.queueEventBackfill(t0 + 20000, 'person detected', '', 'person detected', 200, true);
      doorbellCam.recordMotionCleared(t0 + 22000, 5000, 10000);

      const clip1 = {
        devSn: 'T8214T2222222222',
        storagePath: '/media/mmcblk0p1/video/20261105171001.zxvideo',
        cipherId: 10,
        clipMs: t0 + 1000,
      };
      assert.equal(doorbellCam.tryMatchBackfillCandidate(clip1), true);
      const matchLog = doorbellCam.formatBackfillClipMatchLog(clip1);
      assert.ok(matchLog.includes('preRoll=-1.0s'));
      assert.ok(matchLog.includes('sensorSpan=22.0s'));
      doorbellCam.beginBackfillDownload(doorbellCam.backfillClip, false, t0 + 27000);

      // Burst-downloaded audio chunks are preserved up to maxDownloadBytes instead of being capped at 1s
      doorbellCam.appendAudioChunk(Buffer.alloc(32000), 32000, 32000 * 120);
      doorbellCam.appendAudioChunk(Buffer.alloc(32000), 32000, 32000 * 120);
      assert.equal(doorbellCam.pcmLen, 64000);

      // Frame 0 committed -> immediately ready to advance to Frame 1 on the next 15 fps tick (62ms) without freezing
      const dummyFrame1 = Buffer.alloc(FRAME, 0x30);
      const dummyFrame2 = Buffer.alloc(FRAME, 0x50);
      const tFirstFrame = t0 + 27100;
      assert.equal(doorbellCam.bufferDownloadFrame(dummyFrame1, 900), false);
      doorbellCam.recordDecodedFrame(dummyFrame1, dummyFrame1, tFirstFrame, '17:10', 5000);
      assert.equal(doorbellCam.firstFrameAt, tFirstFrame);
      assert.equal(doorbellCam.bufferDownloadFrame(dummyFrame2, 900), true);
      assert.equal(
        doorbellCam.canAdvanceDownloadFrame(tFirstFrame + 100, 62),
        false,
        'Must not overwrite un-encoded Frame 0'
      );

      doorbellCam.markFrameEncoded(dummyFrame1, tFirstFrame);
      const silenceBuf = Buffer.alloc(3200, 0);
      const tNextTick = tFirstFrame + 62;
      assert.equal(
        doorbellCam.canAdvanceDownloadFrame(tNextTick, 62),
        true,
        'Advances to Frame 1 on the very next 15 fps tick (62ms) after Frame 0 is encoded'
      );
      assert.notEqual(doorbellCam.consumeAudioChunk(3200, silenceBuf), silenceBuf);
      doorbellCam.consumeNextDownloadFrame(tNextTick, 62, '17:10');
      doorbellCam.markFrameEncoded(dummyFrame2, tNextTick + 10);
      doorbellCam.gotVideo = true;

      // Mark download finished while decoder process is still attached -> waits for EOF flush
      // settle and 2.5s post-playback hold
      doorbellCam.attachDecoder({});
      assert.equal(doorbellCam.shouldLogUnexpectedDecoderExit(doorbellCam.sessionId, 0), true);
      assert.equal(doorbellCam.markDownloadFinished(tNextTick + 500), 0);
      assert.equal(
        doorbellCam.shouldLogUnexpectedDecoderExit(doorbellCam.sessionId, 0),
        false,
        'Clean exit (code=0) after flushDecoderInput on downloadFinished must not log a warning'
      );
      assert.equal(doorbellCam.shouldLogUnexpectedDecoderExit(doorbellCam.sessionId, 1), true);
      assert.equal(doorbellCam.isDownloadComplete(tNextTick + 1000, 3000, 2500, 4500), false);
      doorbellCam.detachDecoder();
      assert.equal(
        doorbellCam.isDownloadComplete(tNextTick + 4500, 3000, 2500, 4500),
        true,
        'Completes once minPlaybackMs (4.5s) and postPlaybackHoldMs (2.5s) have elapsed'
      );

      // Scales Frigate event duration with DOWNLOAD_EVENT_DURATION_MARGIN_SECS (6s) for backfill downloads
      // and only populates subLabel when a recognized face name is present (null otherwise)
      doorbellCam.downloadFrames = new Array(600);
      doorbellCam.tryUpgradeOrQueueFrigateEvent('person', '', tNextTick + 500);
      const filedNoFace = doorbellCam.completeFrigateEventFiling(tNextTick + 1000, 15);
      assert.equal(filedNoFace.subLabel, null);
      assert.equal(filedNoFace.durationSecs, 41 + DOWNLOAD_EVENT_DURATION_MARGIN_SECS);

      doorbellCam.evUntil = 0;
      doorbellCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', tNextTick + 1100);
      const filedWithFace = doorbellCam.completeFrigateEventFiling(tNextTick + 1200, 15);
      assert.equal(filedWithFace.subLabel, 'Alice');
      doorbellCam.downloadFrames = [];

      // Ending session promotes activeBackfillJob to a follow-up query because activity spanned 21s past clip1
      doorbellCam.endSession(tNextTick + 3000);
      assert.ok(doorbellCam.pendingBackfill instanceof BackfillJob);
      assert.equal(doorbellCam.pendingBackfill.followUpQueried, true);

      // A short 10s event whose clip filename starts 5s earlier (pre-roll) must not schedule a false follow-up query
      const shortJob = new BackfillJob({
        at: t0,
        lastActivityAt: t0,
        clearedAt: t0 + 10000,
      });
      assert.equal(
        shortJob.needsFollowUpClipQuery(t0 - 5000),
        false,
        'Pre-roll clip timestamp (5s before trigger) must not inflate post-trigger activity span'
      );
    }
  );

  it(
    'streams backfill clips from Frame 0 at 15 fps without starving encoder pipe during ' +
      'handshake or freezing Frame 0',
    () => {
      const oldSnapshot = Buffer.alloc(FRAME, 0x11);
      const doorbellCam = new Camera(
        {
          serial: 'T8214T2222222222',
          mode: 'backfill',
        },
        {frame: oldSnapshot, lastSeen: '18:21'},
        renderCameraCards
      );

      const writtenFrames = [];
      doorbellCam.attachEncoder(
        {
          stdin: {
            writable: true,
            writableNeedDrain: false,
            write(buf) {
              writtenFrames.push(Buffer.from(buf));
            },
          },
        },
        1000
      );
      // Simulate sleeping state before backfill wake
      pushFrameToEncoder(doorbellCam, 1000);
      assert.equal(writtenFrames.length, 1);
      assert.equal(doorbellCam.lastSent, doorbellCam.card.asleep);
      writtenFrames.length = 0;

      const tWake = 5000;
      const clip = {
        storagePath: '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo',
        cipherId: 0,
        clipMs: tWake - 30000,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      };

      // Phase 1: beginBackfillDownload (before Frame 0 is decoded)
      doorbellCam.beginBackfillDownload(clip, false, tWake);
      assert.equal(doorbellCam.firstFrameAt, 0);
      assert.equal(doorbellCam.frame, null);
      assert.equal(
        doorbellCam.isActivelyViewing(tWake + 50),
        false,
        'Automatic Frigate UI consumer joining during backfill download must be classified as ' +
          '"joined while live", not an active viewer wake'
      );
      assert.equal(
        doorbellCam.isInKeyframeBurst(tWake + 50),
        false,
        'Must NOT trigger a 15 fps keyframe burst of old card.asleep before Frame 0 is decoded'
      );

      // Even after the first raw H.264 network packet arrives (gotVideo=true), isStreamingLive
      // must remain false until Frame 0 is decoded
      doorbellCam.markP2pVideoPacketReceived(tWake + 200);
      assert.equal(doorbellCam.gotVideo, true);
      assert.equal(
        doorbellCam.isStreamingLive(tWake + 200, 2000),
        false,
        'Must NOT treat previous session lastFrame as live video before Frame 0 is decoded'
      );
      pushFrameToEncoder(doorbellCam, tWake + 250);
      assert.equal(
        writtenFrames.length,
        1,
        'Encoder stdin continues normal idle card pacing during backfill handshake instead of starving pipe:0'
      );
      writtenFrames.length = 0;

      const requiredDelayMs = computeRequiredSnapshotDelay('download');
      assert.equal(
        requiredDelayMs,
        BACKFILL_SNAP_DELAY_MS,
        'Backfill download must wait BACKFILL_SNAP_DELAY_MS for Frame 0 to traverse ' +
          'h264_vaapi -> go2rtc -> Frigate before creating the Frigate event'
      );
      assert.equal(
        doorbellCam.isReadyForEventSnapshot(tWake + 250, requiredDelayMs, 1500, 5000),
        false,
        'Must not file Frigate event before Frame 0 is decoded'
      );

      // Phase 2: Frame 0, Frame 1, Frame 2 decoded from .zxvideo
      const tFrame0 = tWake + 300;
      const frame0 = Buffer.alloc(FRAME, 0x80);
      const frame1 = Buffer.alloc(FRAME, 0x81);
      const frame2 = Buffer.alloc(FRAME, 0x82);

      assert.equal(doorbellCam.bufferDownloadFrame(frame0, 1800), false);
      doorbellCam.recordDecodedFrame(frame0, frame0, tFrame0, '20:07', 5000);
      pushFrameToEncoder(doorbellCam, tFrame0);
      assert.equal(doorbellCam.bufferDownloadFrame(frame1, 1800), true);
      assert.equal(doorbellCam.bufferDownloadFrame(frame2, 1800), true);

      assert.equal(writtenFrames.length, 1);
      assert.equal(doorbellCam.lastSent, frame0, 'lastSent must track raw Frame 0');
      assert.equal(writtenFrames[0][0], 0x80, 'First encoded frame of backfill must be Frame 0');
      assert.equal(doorbellCam.getFrameMarker(), 'FB');
      assert.equal(doorbellCam.downloadFrames.length, 2, 'Frame 1 and Frame 2 are buffered behind Frame 0');
      assert.equal(doorbellCam.downloadDecodedFrames, 3, 'Tracks Frame 0 + Frame 1 + Frame 2 as 3 decoded frames');
      assert.equal(doorbellCam.downloadPlayedFrames, 1, 'Tracks Frame 0 as 1 played frame');
      assert.equal(doorbellCam.downloadVideoPackets, 1, 'Tracks incoming P2P video packet count during download');
      assert.equal(doorbellCam.backfillPlaybackStartedAt, tFrame0);

      // Phase 3: Next 15 fps tick (tFrame0 + 62ms) immediately advances to Frame 1 (B) without any frozen warmup hold
      const tTick1 = tFrame0 + 62;
      pushFrameToEncoder(doorbellCam, tTick1);
      assert.equal(writtenFrames.length, 2);
      assert.equal(doorbellCam.lastSent, frame1);
      assert.equal(writtenFrames[1][0], 0x81, 'Next 15 fps tick immediately advances to Frame 1');
      assert.equal(doorbellCam.downloadPlayedFrames, 2);
      assert.equal(doorbellCam.getFrameMarker(), 'B');

      const transferLog = doorbellCam.formatBackfillTransferCompleteLog(1, 15);
      assert.ok(transferLog.includes('packets=1'));
      assert.ok(transferLog.includes('decodedFrames=3'));
      assert.ok(transferLog.includes('playedFrames=2'));
      assert.ok(transferLog.includes('estClipDuration=0.2s'));

      const tTick2 = tTick1 + 62;
      pushFrameToEncoder(doorbellCam, tTick2);
      assert.equal(writtenFrames.length, 3);
      assert.equal(doorbellCam.lastSent, frame2);
      assert.equal(writtenFrames[2][0], 0x82, 'Subsequent 15 fps tick advances to Frame 2');
      assert.equal(doorbellCam.downloadPlayedFrames, 3);

      // Phase 4: Frigate event waits for pipeline transit (BACKFILL_SNAP_DELAY_MS) after firstFrameAt
      assert.equal(
        doorbellCam.isReadyForEventSnapshot(tFrame0 + 200, requiredDelayMs, 1500, 5000),
        false,
        'Must wait while initial frames are still in flight through h264_vaapi -> go2rtc -> Frigate'
      );
      assert.equal(
        doorbellCam.isReadyForEventSnapshot(tFrame0 + BACKFILL_SNAP_DELAY_MS, requiredDelayMs, 1500, 5000),
        true,
        'Becomes ready to create Frigate event once initial frames have reached Frigate'
      );

      // Phase 5: Backfill SLEEP summary includes clipStart, clipDuration, decodedFrames,
      // playedFrames, playbackSpan, and postHold
      const sleepResult = doorbellCam.terminateSession(
        tTick2 + 2500,
        'backfill clip completed',
        false,
        'bridge-backfill'
      );
      assert.ok(sleepResult.sleepMsg.includes('clipDuration=0.2s'));
      assert.ok(sleepResult.sleepMsg.includes('decodedFrames=3'));
      assert.ok(sleepResult.sleepMsg.includes('playedFrames=3'));
      assert.ok(sleepResult.sleepMsg.includes('playbackSpan=0.1s'));
      assert.ok(sleepResult.sleepMsg.includes('postHold=2.5s'));
    }
  );

  it(
    'extracts database record candidates from explicit storage_path or synthesized ' +
      'crop_local_path and enforces time window and expiry',
    () => {
      assert.equal(extractDatabaseRecordCandidate(null), null);
      assert.equal(extractDatabaseRecordCandidate({device_sn: 'T8214T2222222222'}), null);

      const directCandidate = extractDatabaseRecordCandidate({
        device_sn: 'T8214T2222222222',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
        video_type: 1,
        cipher_id: 7,
        start_time: '2026-11-05T20:07:09Z',
      });
      assert.ok(directCandidate);
      assert.equal(directCandidate.devSn, 'T8214T2222222222');
      assert.equal(directCandidate.storagePath, '/media/mmcblk0p1/video/20261105200709.zxvideo');
      assert.equal(directCandidate.cipherId, 7);
      assert.equal(directCandidate.clipMs, Date.parse('2026-11-05T20:07:09Z'));

      const cropCandidate = extractDatabaseRecordCandidate({
        serialNumber: 'T8214T2222222222',
        crop_local_path: '/zx/hdd_data0/Camera02/202611/20261105200709/pic20261105200709.jpg',
        cipherId: 0,
        create_time: '2026-11-05T20:07:09Z',
      });
      assert.ok(cropCandidate);
      assert.equal(cropCandidate.storagePath, '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo');
      assert.equal(cropCandidate.clipMs, Date.parse('2026-11-05T20:07:09Z'));

      const tTrigger = 1793927229000;
      const job = new BackfillJob({
        at: tTrigger,
        event: 'person detected',
        personName: 'Alice',
        reason: 'person detected (Alice)',
        priority: 200,
      });
      const downloadedPaths = new Set();

      assert.equal(
        job.matchesCandidate(
          {
            devSn: 'T8214T2222222222',
            storagePath: '/path/pre_roll.zxvideo',
            clipMs: tTrigger - 40000,
          },
          downloadedPaths
        ),
        true,
        'Matches clip within 45s pre-roll window before trigger'
      );
      assert.equal(
        job.matchesCandidate(
          {
            devSn: 'T8214T2222222222',
            storagePath: '/path/too_old.zxvideo',
            clipMs: tTrigger - 46000,
          },
          downloadedPaths
        ),
        false,
        'Rejects clip older than 45s before trigger'
      );
      assert.equal(
        job.matchesCandidate(
          {
            devSn: 'T8214T2222222222',
            storagePath: '/path/too_late.zxvideo',
            clipMs: tTrigger + 185000,
          },
          downloadedPaths
        ),
        false,
        'Rejects clip more than 180s after latest trigger'
      );

      for (let i = 1; i <= BACKFILL_MAX_QUERY_ATTEMPTS; i++) {
        assert.equal(job.consumeQueryAttempt(), true);
      }
      assert.equal(
        BACKFILL_MAX_QUERY_ATTEMPTS,
        10,
        'Allows 10 query attempts (~40s after sensor clear) so 30s hardware clips finish recording'
      );
      assert.equal(job.consumeQueryAttempt(), false, 'Returns false when max query attempts are exhausted');
      assert.equal(job.isExpired(tTrigger + DEFAULT_BACKFILL_MAX_AGE_MS - 1), false);
      assert.equal(job.isExpired(tTrigger + DEFAULT_BACKFILL_MAX_AGE_MS + 1), true);
    }
  );

  it('rejects timestamp-less backfill candidates on normal jobs and parses clip timestamps across TZ values', () => {
    // Verify normal BackfillJobs reject candidates with missing clipMs (0), synthetic SIGUSR1 test jobs still
    // accept them, and extractDatabaseRecordCandidate handles ISO, epoch, and local-path timestamps across two TZs.
    const tTrigger = Date.parse('2026-11-05T20:07:09Z');
    const normalJob = new BackfillJob({
      at: tTrigger,
      event: 'motion detected',
      reason: 'motion detected',
      priority: 100,
    });
    const urgentJob = BackfillJob.createSigUsr1TestJob(tTrigger, 'doorbell');
    const noTsCandidate = extractDatabaseRecordCandidate({
      device_sn: 'SN0000000001',
      storage_path: '/media/mmcblk0p1/video/corrupt_no_ts.zxvideo',
      cipher_id: 3,
    });
    assert.ok(noTsCandidate);
    assert.equal(noTsCandidate.clipMs, 0);
    assert.equal(
      normalJob.matchesCandidate(noTsCandidate, new Set()),
      false,
      'Normal BackfillJob must reject timestamp-less candidates instead of matching arbitrary clips'
    );
    assert.equal(
      urgentJob.matchesCandidate(noTsCandidate, new Set()),
      true,
      'Synthetic SIGUSR1 urgent test job still accepts timestamp-less candidates'
    );

    const prevTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utcIsoCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
        start_time: '2026-11-05T20:07:09Z',
      });
      const utcEpochSecCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/epoch_sec.zxvideo',
        start_time: Math.floor(tTrigger / 1000),
      });
      const utcPathOnlyCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
      });
      assert.equal(utcIsoCand?.clipMs, tTrigger);
      assert.equal(utcEpochSecCand?.clipMs, tTrigger);
      assert.equal(utcPathOnlyCand?.clipMs, tTrigger);
      assert.equal(normalJob.matchesCandidate(utcPathOnlyCand, new Set()), true);

      process.env.TZ = 'America/New_York';
      const nyIsoCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105150709.zxvideo',
        start_time: '2026-11-05T15:07:09-05:00',
      });
      const nyEpochSecCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/epoch_sec.zxvideo',
        start_time: String(Math.floor(tTrigger / 1000)),
      });
      const nyPathOnlyCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105150709.zxvideo',
      });
      const nyMismatchedUtcPathCand = extractDatabaseRecordCandidate({
        device_sn: 'SN0000000001',
        storage_path: '/media/mmcblk0p1/video/20261105200709.zxvideo',
      });
      assert.equal(nyIsoCand?.clipMs, tTrigger);
      assert.equal(nyEpochSecCand?.clipMs, tTrigger);
      assert.equal(nyPathOnlyCand?.clipMs, tTrigger);
      assert.equal(normalJob.matchesCandidate(nyPathOnlyCand, new Set()), true);
      assert.equal(
        normalJob.matchesCandidate(nyMismatchedUtcPathCand, new Set()),
        false,
        'Path-only timestamp is interpreted in container TZ (5h offset in America/New_York)'
      );
    } finally {
      if (prevTz === undefined) {
        process.env.TZ = '';
      } else {
        process.env.TZ = prevTz;
      }
    }
  });
});

describe('Telemetry Semantic Colors, Segments & Property Parsing', () => {
  it('evaluates 6-color semantic state across status, battery, charging, Wi-Fi RSSI, and temperature', () => {
    assert.equal(unwrapProperty({value: 85}), 85);
    assert.equal(unwrapProperty(42), 42);
    assert.equal(unwrapProperty(null), null);

    const lowBatState = evaluateTelemetryState('Asleep (Low Battery)', {
      telCfg: {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      },
      battery: 25,
      charging: false,
      economyMode: true,
      wifi: 1,
      rssi: -82,
      temp: 52,
      lastSeen: '19:45',
    });
    assert.equal(lowBatState.statusKind, 'low');
    assert.deepEqual(lowBatState.statusRgb, COLOR_WHITE);
    assert.deepEqual(lowBatState.batRgb, [250, 204, 21]);
    assert.equal(lowBatState.wifiBars, 1);
    assert.deepEqual(lowBatState.tempRgb, [232, 121, 249]);

    const chargingState = evaluateTelemetryState('Waking Up...', {
      telCfg: {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      },
      battery: 55,
      charging: true,
      powerLabel: 'Charging',
      economyMode: false,
      lowBatThreshold: 20,
      wifi: 4,
      rssi: -55,
      temp: 24,
      lastSeen: '19:45',
    });
    assert.equal(chargingState.statusKind, 'waking');
    assert.deepEqual(chargingState.batRgb, [56, 189, 248]);
    assert.equal(chargingState.wifiBars, 4);
    assert.deepEqual(chargingState.tempRgb, COLOR_WHITE);

    const liveState = evaluateTelemetryState('Live', {
      telCfg: {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      },
      battery: 90,
      charging: false,
      powerLabel: 'Plugged',
      economyMode: false,
      lowBatThreshold: 20,
      wifi: 2,
      rssi: -72,
      temp: 0,
      lastSeen: '19:45',
    });
    assert.equal(liveState.statusKind, 'live');
    assert.deepEqual(liveState.batRgb, COLOR_WHITE);
    assert.equal(liveState.wifiBars, 3);
    assert.deepEqual(liveState.tempRgb, [56, 189, 248]);
    assert.equal(liveState.powerLabel, 'Plugged');
    assert.equal(liveState.seenVal, '19:45');
  });

  it(
    'matches the calm-white-when-healthy and sky-blue charging palette across Status, Battery, ' +
      'Wi-Fi, and Temperature',
    () => {
      const allEnabled = {
        enabled: true,
        battery: true,
        powerSource: true,
        wifi: true,
        rssi: true,
        temperature: true,
        lastSeen: true,
      };

      // 1. Status colors: Red (Live / Backfill), Calm White (Asleep & Asleep Low Battery
      // sleep-ready), Grey (Disconnected), Blue (Waking Up...), Yellow (Waiting)
      assert.deepEqual(evaluateTelemetryState('Live', {telCfg: allEnabled}).statusRgb, COLOR_RED);
      assert.equal(evaluateTelemetryState('Live', {telCfg: allEnabled}).statusKind, 'live');
      assert.deepEqual(evaluateTelemetryState('Backfill', {telCfg: allEnabled}).statusRgb, COLOR_RED);
      assert.equal(evaluateTelemetryState('Backfill', {telCfg: allEnabled}).statusKind, 'backfill');
      assert.deepEqual(evaluateTelemetryState('Asleep', {telCfg: allEnabled}).statusRgb, COLOR_WHITE);
      assert.equal(evaluateTelemetryState('Asleep', {telCfg: allEnabled}).statusKind, 'asleep');
      assert.deepEqual(evaluateTelemetryState('Disconnected', {telCfg: allEnabled}).statusRgb, COLOR_GREY);
      assert.equal(evaluateTelemetryState('Disconnected', {telCfg: allEnabled}).statusKind, 'disconnected');
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, serviceDisrupted: true}).statusRgb,
        COLOR_GREY
      );
      assert.equal(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, serviceDisrupted: true}).statusKind,
        'disconnected'
      );
      assert.deepEqual(evaluateTelemetryState('Waking Up...', {telCfg: allEnabled}).statusRgb, COLOR_BLUE);
      assert.equal(evaluateTelemetryState('Waking Up...', {telCfg: allEnabled}).statusKind, 'waking');
      assert.deepEqual(evaluateTelemetryState('Waiting', {telCfg: allEnabled}).statusRgb, COLOR_YELLOW);
      assert.equal(evaluateTelemetryState('Waiting', {telCfg: allEnabled}).statusKind, 'waiting');
      assert.deepEqual(
        evaluateTelemetryState('Asleep (Low Battery)', {telCfg: allEnabled, economyMode: true}).statusRgb,
        COLOR_WHITE
      );
      assert.equal(
        evaluateTelemetryState('Asleep (Low Battery)', {telCfg: allEnabled, economyMode: true}).statusKind,
        'low'
      );

      // 2. Battery colors: Calm White (> lowBatThreshold unplugged, default 30%), Sky-Blue
      // (Charging / Solar / Plugged), Yellow (criticalBatThreshold < bat <= lowBatThreshold unplugged),
      // Purple (<= criticalBatThreshold unplugged, default 5%), Grey (N/A)
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 50, charging: false}).batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 100, charging: false}).batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {
          telCfg: allEnabled,
          battery: 40,
          charging: true,
          powerLabel: 'Solar',
        }).batRgb,
        COLOR_BLUE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 31, charging: false}).batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 30, charging: false}).batRgb,
        COLOR_YELLOW
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 6, charging: false}).batRgb,
        COLOR_YELLOW
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 5, charging: false}).batRgb,
        COLOR_PURPLE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 21, charging: false, lowBatThreshold: 20})
          .batRgb,
        COLOR_WHITE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: 20, charging: false, lowBatThreshold: 20})
          .batRgb,
        COLOR_YELLOW
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {
          telCfg: allEnabled,
          battery: 8,
          charging: false,
          lowBatThreshold: 20,
          criticalBatThreshold: 8,
        }).batRgb,
        COLOR_PURPLE
      );
      assert.deepEqual(
        evaluateTelemetryState('Asleep', {telCfg: allEnabled, battery: null, charging: false}).batRgb,
        COLOR_GREY
      );

      // Verify critical battery (<= 5%) renders Purple in minimal, glance, and pebbles themes (differing from
      // Yellow low battery), while hud theme keeps its non-purple stage/text rendering
      const critTestSnap = Buffer.alloc(FRAME, 0x30);
      critTestSnap.fill(0x80, 1280 * 720);
      for (const theme of ['minimal', 'glance', 'pebbles']) {
        const lowThemeCam = new Camera(
          {serial: 'T8161T0000000080', card_theme: theme, card_position: 'top-left'},
          {frame: critTestSnap, lastSeen: '12:00'}
        );
        lowThemeCam.applyTelemetryProperties({battery: 20, chargingStatus: 2, wifiRssi: -60});
        renderCameraCards(lowThemeCam);

        const critThemeCam = new Camera(
          {serial: 'T8161T0000000081', card_theme: theme, card_position: 'top-left'},
          {frame: critTestSnap, lastSeen: '12:00'}
        );
        critThemeCam.applyTelemetryProperties({battery: 5, chargingStatus: 2, wifiRssi: -60});
        renderCameraCards(critThemeCam);

        assert.equal(
          Buffer.from(lowThemeCam.card.asleep).equals(Buffer.from(critThemeCam.card.asleep)),
          false,
          theme + ' theme must render critical battery (5% purple) differently from low battery (20% yellow)'
        );
      }

      // 3. Wi-Fi colors & bars: Calm White (2-4 bars >= -80 dBm), Yellow (Weak 1 bar <= -81 dBm), Grey (Not available)
      const wifiStrong = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -65});
      assert.equal(wifiStrong.wifiBars, 4);
      assert.deepEqual(wifiStrong.wifiRgb, COLOR_WHITE);

      const wifiGood = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -70});
      assert.equal(wifiGood.wifiBars, 3);
      assert.deepEqual(wifiGood.wifiRgb, COLOR_WHITE);

      const wifiFair = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -78});
      assert.equal(wifiFair.wifiBars, 2);
      assert.deepEqual(wifiFair.wifiRgb, COLOR_WHITE);

      const wifiWeak = evaluateTelemetryState('Asleep', {telCfg: allEnabled, rssi: -81});
      assert.equal(wifiWeak.wifiBars, 1);
      assert.deepEqual(wifiWeak.wifiRgb, COLOR_YELLOW);

      const wifiMissing = evaluateTelemetryState('Asleep', {telCfg: allEnabled, wifi: null, rssi: null});
      assert.equal(wifiMissing.wifiBars, 0);
      assert.deepEqual(wifiMissing.wifiRgb, COLOR_GREY);

      // 4. Temperature colors: Calm White (Normal 6-35°C), Blue (Cold <=5°C), Yellow (Warm 36-44°C),
      // Purple (Hot >=45°C), Grey (Not available)
      const tempNormal = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 22});
      assert.deepEqual(tempNormal.tempRgb, COLOR_WHITE);

      const tempCold = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 5});
      assert.deepEqual(tempCold.tempRgb, COLOR_BLUE);

      const tempWarm = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 36});
      assert.deepEqual(tempWarm.tempRgb, COLOR_YELLOW);

      const tempHot = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: 45});
      assert.deepEqual(tempHot.tempRgb, COLOR_PURPLE);

      const tempMissing = evaluateTelemetryState('Asleep', {telCfg: allEnabled, temp: null});
      assert.deepEqual(tempMissing.tempRgb, COLOR_GREY);
    }
  );

  it(
    'distinguishes major battery/charging state changes from minor telemetry updates and ' +
      'evaluates quality/refresh rules',
    () => {
      const tel = new Telemetry({
        mode: 'custom',
        low_battery_threshold: 20,
        enforce_streaming_quality: 3,
        sync_power: true,
        power_working_mode: 2,
        recording_clip_length: 60,
        recording_end_early: false,
        recording_retrigger_interval: 5,
      });

      const initial = tel.applyProperties({
        name: {value: 'FrontCam'},
        model: {value: 'T8161'},
        softwareVersion: {value: '3.1.4'},
        battery: {value: 50},
        chargingStatus: {value: 2},
        wifiSignalLevel: {value: 3},
        wifiRssi: {value: -68},
        batteryTemperature: {value: 25},
      });
      assert.equal(initial.hadInitialTelemetry, false);
      assert.equal(initial.nowLowBat, false);
      assert.ok(tel.formatLoadedLog(initial.model, initial.swVer, initial.nowLowBat).includes('T8161'));

      // Minor 2% drop does not trigger stateChanged (card rebuild), only minorTelemetryChanged
      const minor = tel.applyProperties({battery: 48, wifiRssi: -69});
      assert.equal(minor.hadInitialTelemetry, true);
      assert.equal(minor.stateChanged, false);
      assert.equal(minor.minorTelemetryChanged, true);
      assert.ok(tel.formatUpdateLog().includes('battery=48%'));

      // >= 10% jump (e.g. battery swap from 48% to 95%) triggers stateChanged
      const swapped = tel.applyProperties({battery: 95});
      assert.equal(swapped.stateChanged, true);
      assert.ok(tel.formatStateChangeLog(swapped.prevBattery, swapped.nowLowBat).includes('48% -> 95%'));

      assert.deepEqual(tel.evaluateQualityChange({videoStreamingQuality: {value: 1}}, 'T8161T0000000000'), {
        shouldUpdate: true,
        currentQuality: 1,
        targetQuality: 3,
      });
      assert.deepEqual(
        tel.evaluateQualityChange({videoStreamingQuality: {value: 3}}, 'T8161T0000000000'),
        {shouldUpdate: false, currentQuality: 0, targetQuality: 7},
        'Only checks streaming quality once per session'
      );

      // Offline viewer refresh cooldown (300s / 5m)
      tel.applyProperties({battery: 15, chargingStatus: 2});
      assert.equal(tel.isLowBattery(), true);
      assert.equal(tel.shouldRefreshLowBatteryOnView(400000), true);
      assert.equal(tel.shouldRefreshLowBatteryOnView(500000), false, 'Respects 300s poll cooldown');
      assert.equal(tel.shouldRefreshLowBatteryOnView(705000), true);
    }
  );
});

describe('Camera Arbitration, Hold Extension, Early Sleep & Watchdog Health', () => {
  it('compares wanting cameras by priority and preempts lower-priority P2P sessions', () => {
    const lowCam = new Camera({serial: 'T8161T0000000000', priority: 10});
    const highCam = new Camera({serial: 'T8214T2222222222', priority: 100});

    const t0 = Date.now();
    lowCam.beginSession('p2p', t0, false);
    lowCam.motionUntil = t0 + 60000;
    lowCam.lastMotionAt = t0;

    highCam.beginSession('p2p', t0, false);
    highCam.motionUntil = t0 + 60000;
    highCam.lastMotionAt = t0 + 500;

    assert.equal(highCam.canPreempt(lowCam, t0 + 1000, 12000), true);
    assert.equal(lowCam.canPreempt(highCam, t0 + 1000, 12000), false);
    assert.equal(highCam.resolvePreemptInitiator(lowCam, t0 + 1000), 'bridge-arbitrator/higher-priority-event');

    lowCam.motionUntil = 0;
    assert.equal(highCam.resolvePreemptInitiator(lowCam, t0 + 1000), 'bridge-arbitrator/motion-over-viewer');

    highCam.motionUntil = 0;
    highCam.viewUntil = t0 + 20000;
    assert.equal(highCam.resolvePreemptInitiator(lowCam, t0 + 1000), 'bridge-arbitrator/newer-viewer');

    // Compare wanting order: motion beats viewer; higher effective priority beats lower priority
    lowCam.active = false;
    lowCam.activeMode = '';
    lowCam.motionUntil = t0 + 60000;
    highCam.motionUntil = t0 + 60000;
    const sorted = [lowCam, highCam].sort((a, b) => Camera.compareWanting(a, b));
    assert.equal(sorted[0], highCam);
  });

  it(
    'evaluates active hold extensions near expiry, early sleep on motion cleared, and Eufy ' + 'clean-end detection',
    () => {
      const cam = new Camera({serial: 'T8161T0000000000', mode: 'p2p', hold_secs: 60, stream_max_secs: 120});
      const t0 = 100000;
      cam.beginSession('p2p', t0, false);
      cam.gotVideo = true;
      cam.firstFrameAt = t0 + 1000;
      cam.firstVideoAt = t0 + 1000;
      cam.motionUntil = t0 + 60000;

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
      assert.equal(cam.motionUntil, t0 + 90000);

      // Early sleep when letEufyDecideEnd=true and motion clears after first video
      const earlyCam = new Camera({
        serial: 'T8161T1111111111',
        mode: 'custom',
        end_early: true,
        idle_timeout_secs: 10,
        hold_secs: 60,
      });
      earlyCam.beginSession('p2p', t0, false);
      earlyCam.gotVideo = true;
      earlyCam.eventActive = true;
      earlyCam.firstVideoAt = t0 + 1000;
      earlyCam.lastMotionAt = t0 + 1000;
      earlyCam.motionUntil = t0 + 60000;

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

  it('evaluates RTSP and P2P watchdog health, unsolicited video filtering, and HTTP/HA payload formatting', () => {
    const rtspCam = new Camera({
      serial: 'T8161T0000000000',
      title: 'Driveway',
      mode: 'rtsp',
    });
    rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://10.0.0.1/live0');
    const t0 = 200000;
    rtspCam.beginSession('rtsp', t0, false);
    rtspCam.motionUntil = t0 + 60000;

    assert.equal(rtspCam.evaluateRtspHealth(t0 + 2000, t0, 1200, 6000, 3500, 3, 15000, 6000).action, 'none');
    assert.equal(
      rtspCam.evaluateRtspHealth(t0 + 4000, t0, 1200, 6000, 3500, 3, 15000, 6000).action,
      'retry',
      'Retries start_rtsp_livestream after retryMs when no video has arrived'
    );

    rtspCam.markRtspFrameReceived(t0 + 4500);
    assert.equal(rtspCam.evaluateRtspHealth(t0 + 6000, t0 + 4500, 1200, 6000, 3500, 3, 15000, 6000).action, 'none');
    assert.equal(
      rtspCam.evaluateRtspHealth(t0 + 8200, t0 + 4500).action,
      'none',
      'Default midStallMs (5000ms) must tolerate a 3.7s Wi-Fi retransmission pause without tearing down RTSP'
    );
    assert.equal(
      rtspCam.evaluateRtspHealth(t0 + 9800, t0 + 4500).action,
      'dropped',
      'Default midStallMs (5000ms) must report dropped once RTSP frames stop for > 5s'
    );
    assert.equal(
      rtspCam.evaluateRtspHealth(t0 + 12000, t0 + 4500, 1200, 6000, 3500, 3, 15000, 6000).action,
      'dropped',
      'Reports dropped if RTSP frames stop for > midStallMs'
    );

    const slowWakeCam = new Camera({
      serial: 'T8161T0000000001',
      title: 'Slow Wake',
      mode: 'rtsp',
    });
    slowWakeCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://10.0.0.1/live1');
    slowWakeCam.beginSession('rtsp', t0, false);
    slowWakeCam.motionUntil = t0 + 60000;
    assert.equal(
      slowWakeCam.evaluateRtspHealth(t0 + 8500, t0).action,
      'none',
      'Default RTSP retry interval must outlast an observed 7-8.5s HomeBase RTSP cold wake so ' +
        'a retry does not restart a wake in progress'
    );
    assert.equal(slowWakeCam.evaluateRtspHealth(t0 + 10500, t0).action, 'retry');

    // Unsolicited P2P video filtering when camera recently slept vs past delayMs
    rtspCam.endSession(t0 + 19000);
    assert.equal(
      rtspCam.shouldStopUnsolicitedVideo(t0 + 20000, 3000).shouldStop,
      false,
      'Within 3s post-stop window, ignores trailing packets without sending redundant stop_livestream'
    );
    assert.equal(
      rtspCam.shouldStopUnsolicitedVideo(t0 + 25000, 3000).shouldStop,
      true,
      'Past 3s post-stop window, triggers stop_livestream for unsolicited video'
    );

    // Adopt external P2P wake and verify P2P watchdog health states
    const p2pCam = new Camera({serial: 'T8161T1111111111', title: 'Backyard', mode: 'p2p'});
    assert.equal(p2pCam.adoptExternalP2pWake(t0, 5000), true);
    assert.equal(p2pCam.active, true);
    assert.equal(p2pCam.activeMode, 'p2p');
    assert.equal(p2pCam.wakeInitiator, 'eufy-ws');
    assert.equal(p2pCam.evaluateP2pHealth(t0 + 7000, t0, 6000, 8000, 3).action, 'retry');

    // Coalesce HTTP /api/wake bursts and verify API + HA webhook payloads
    p2pCam.apiWakeScheduledAt = t0 + 2500;
    assert.equal(p2pCam.coalesceApiWake(30000, 'ha-automation', true, t0 + 1000), 1500);
    const apiResp = p2pCam.toApiWakeResponse('scheduled', 30000, 1500);
    assert.equal(apiResp.camera, 'T8161T1111111111');
    assert.equal(apiResp.status, 'scheduled');
    assert.equal(apiResp.hold_secs, 30);

    p2pCam.evLabel = 'person';
    p2pCam.evPerson = 'Alice';
    const haPayload = p2pCam.toHaWebhookPayload({event_id: 'evt-123'});
    assert.equal(haPayload.camera, 'T8161T1111111111');
    assert.equal(haPayload.person, 'Alice');
    assert.equal(haPayload.event_id, 'evt-123');
  });

  it('transitions Camera.sessionState deterministically across RTSP, P2P, and Backfill FSM lifecycle states', () => {
    assert.ok(SESSION_STATES);
    const rtspCam = new Camera({
      serial: 'T8161T0000000000',
      mode: 'rtsp',
    });
    rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://10.0.0.1/live0');
    const p2pCam = new Camera({serial: 'T8161T1111111111', mode: 'p2p'});
    const backfillCam = new Camera({serial: 'T8214T2222222222', mode: 'backfill'});

    const t0 = 500000;
    // 1. RTSP lifecycle: IDLE -> WAKING_RTSP -> STREAMING_LIVE -> WAKING_RTSP (rewake) -> STREAMING_LIVE -> IDLE
    assert.equal(rtspCam.sessionState, SESSION_STATES.IDLE);
    rtspCam.beginSession('rtsp', t0, false);
    assert.equal(rtspCam.sessionState, SESSION_STATES.WAKING_RTSP);
    rtspCam.markRtspFrameReceived(t0 + 1000);
    assert.equal(rtspCam.sessionState, SESSION_STATES.STREAMING_LIVE);
    rtspCam.beginRtspRewake(t0 + 5000, 10000);
    assert.equal(rtspCam.sessionState, SESSION_STATES.WAKING_RTSP);
    rtspCam.markRtspFrameReceived(t0 + 6000);
    assert.equal(rtspCam.sessionState, SESSION_STATES.STREAMING_LIVE);
    rtspCam.endSession(t0 + 10000);
    assert.equal(rtspCam.sessionState, SESSION_STATES.IDLE);

    // 2. P2P lifecycle: IDLE -> WAKING_P2P -> STREAMING_LIVE -> COOLDOWN -> IDLE
    assert.equal(p2pCam.sessionState, SESSION_STATES.IDLE);
    assert.equal(p2pCam.transitionTo(SESSION_STATES.WAKING_P2P, t0), SESSION_STATES.WAKING_P2P);
    p2pCam.beginSession('p2p', t0, false);
    assert.equal(p2pCam.sessionState, SESSION_STATES.WAKING_P2P);
    const p2pFrame = Buffer.alloc(FRAME, 0x44);
    p2pCam.markP2pVideoPacketReceived(t0 + 700);
    p2pCam.recordDecodedFrame(p2pFrame, p2pFrame, t0 + 800, '12:00', 5000);
    assert.equal(p2pCam.sessionState, SESSION_STATES.STREAMING_LIVE);
    p2pCam.endSession(t0 + 10000, true, false, 'p2p');
    assert.equal(p2pCam.sessionState, SESSION_STATES.COOLDOWN);
    assert.equal(p2pCam.isInViewerCooldown(t0 + 10500), true);

    // Regression #18: isInViewerCooldown bypassed when hardware triggers active
    p2pCam.activeTriggerEvents.add('motion');
    p2pCam.lastMotionAt = t0 + 12000;
    p2pCam.motionUntil = t0 + 12000 + 20000;
    p2pCam.motionClearedAt = 0;
    assert.equal(p2pCam.hasActiveHardwareTriggers(), true);
    assert.equal(p2pCam.isInViewerCooldown(t0 + 12000), false);

    // Regression #18: hasActiveHardwareTriggers returns false after motion clears
    p2pCam.motionClearedAt = t0 + 35000;
    assert.equal(p2pCam.hasActiveHardwareTriggers(), false);

    assert.equal(p2pCam.getSessionState(t0 + 30000), SESSION_STATES.IDLE);
    assert.equal(p2pCam.sessionState, SESSION_STATES.IDLE);

    // 3. Backfill lifecycle: IDLE -> HANDSHAKING_BACKFILL -> PLAYING_BACKFILL -> DRAINING_BACKFILL_TAIL -> IDLE
    assert.equal(backfillCam.sessionState, SESSION_STATES.IDLE);
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
    assert.equal(backfillCam.sessionState, SESSION_STATES.HANDSHAKING_BACKFILL);

    const bfFrame0 = Buffer.alloc(FRAME, 0x55);
    backfillCam.recordDecodedFrame(bfFrame0, bfFrame0, t0 + 300, '12:01', 5000);
    assert.equal(backfillCam.sessionState, SESSION_STATES.PLAYING_BACKFILL);

    backfillCam.markDownloadFinished(t0 + 4000);
    assert.equal(backfillCam.sessionState, SESSION_STATES.DRAINING_BACKFILL_TAIL);

    backfillCam.endSession(t0 + 30000);
    assert.equal(backfillCam.sessionState, SESSION_STATES.IDLE);
  });

  it('logs every camera session FSM transition exactly once with structured from -> to and reason context', () => {
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

  it(
    'enforces strict FSM transition validation across Session, BackfillJob, FrigateEvent, and ' +
      'Decoder state machines, plus WakeRequest builder',
    () => {
      // 1. Session FSM transition table validation
      assert.ok(Object.isFrozen(SESSION_STATES));
      assert.ok(Object.isFrozen(ALLOWED_SESSION_TRANSITIONS));
      assert.equal(canTransitionSession(SESSION_STATES.IDLE, SESSION_STATES.WAKING_P2P), true);
      assert.equal(canTransitionSession(SESSION_STATES.IDLE, SESSION_STATES.PLAYING_BACKFILL), false);
      assert.equal(canTransitionSession(SESSION_STATES.IDLE, SESSION_STATES.DRAINING_BACKFILL_TAIL), false);

      const cam = new Camera({serial: 'T8161T0000000000', mode: 'p2p', hold_secs: 60});
      assert.equal(
        cam.transitionTo(SESSION_STATES.PLAYING_BACKFILL, 1000, 'illegal jump'),
        SESSION_STATES.IDLE,
        'Must reject illegal transition from IDLE directly to PLAYING_BACKFILL'
      );

      // 2. BackfillJob strict FSM transitions: RECORDING -> SETTLING -> RECORDING -> SETTLING ->
      // READY_TO_QUERY -> MATCHED -> DOWNLOADING -> COMPLETED | EXPIRED
      // Verify tightened transition map, refused-transition debug logs, monomorphic upgradeEvent(opts),
      // pure isReadyToQuery/isExpired predicates vs explicit commands, and isUrgentBackfillProtectedFrom on IDLE.
      assert.ok(Object.isFrozen(BACKFILL_STATES));
      assert.ok(Object.isFrozen(ALLOWED_BACKFILL_TRANSITIONS));
      assert.equal(canTransitionBackfill(BACKFILL_STATES.RECORDING, BACKFILL_STATES.SETTLING), true);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.RECORDING, BACKFILL_STATES.DOWNLOADING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.READY_TO_QUERY, BACKFILL_STATES.RECORDING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.READY_TO_QUERY, BACKFILL_STATES.SETTLING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.MATCHED, BACKFILL_STATES.RECORDING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.MATCHED, BACKFILL_STATES.SETTLING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.MATCHED, BACKFILL_STATES.READY_TO_QUERY), false);

      const viewerCandidate = new Camera({serial: 'SN0000000099', name: 'viewer_only', mode: 'p2p'});
      viewerCandidate.viewUntil = 50000;
      assert.equal(
        cam.isUrgentBackfillProtectedFrom(viewerCandidate, 1000),
        false,
        'Idle camera must not report urgent backfill protection against viewer wakes'
      );

      const t0 = 100000;
      const job = new BackfillJob({
        name: 'doorbell',
        at: t0,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
        priority: 100,
      });
      assert.equal(job.state, BACKFILL_STATES.RECORDING);
      assert.throws(
        () => job.upgradeEvent(/** @type {*} */ ('person detected')),
        TypeError,
        'upgradeEvent must require a monomorphic options object'
      );

      const refusedDebugLines = [];
      const prevLog = console.log;
      initLogger('debug');
      console.log = (line) => refusedDebugLines.push(line);
      try {
        assert.equal(job.transitionTo(BACKFILL_STATES.DOWNLOADING, 'illegal skip'), BACKFILL_STATES.RECORDING);
      } finally {
        console.log = prevLog;
        initLogger('error');
      }
      assert.equal(
        refusedDebugLines.some((line) =>
          line.includes('refused backfill state: recording -> downloading (illegal skip)')
        ),
        true,
        'Disallowed BackfillJob transition must log a refused debug message'
      );

      job.markRecordingCleared(t0 + 10000, 'motion detected');
      assert.equal(job.state, BACKFILL_STATES.SETTLING);

      // Companion event re-activates recording from SETTLING
      job.upgradeEvent({
        at: t0 + 11000,
        event: 'person detected',
        personName: 'Alice',
        reason: 'person detected (Alice)',
        priority: 250,
      });
      assert.equal(job.state, BACKFILL_STATES.RECORDING);
      job.markRecordingCleared(t0 + 20000, 'person detected');
      assert.equal(job.state, BACKFILL_STATES.SETTLING);

      // Pure predicate isReadyToQuery must not mutate state; markReadyToQueryIfSettled performs transition
      assert.equal(job.isReadyToQuery(t0 + 20000 + BACKFILL_POST_CLEAR_SETTLE_MS, 65000), true);
      assert.equal(job.state, BACKFILL_STATES.SETTLING, 'Pure isReadyToQuery must not mutate BackfillJob state');
      assert.equal(job.markReadyToQueryIfSettled(t0 + 20000 + BACKFILL_POST_CLEAR_SETTLE_MS, 65000), true);
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY);

      // Once READY_TO_QUERY, upgradeEvent with recordingActive=true upgrades metadata without regressing to RECORDING
      job.upgradeEvent({
        at: t0 + 24500,
        event: 'rings',
        personName: 'Alice',
        reason: 'rings',
        priority: 1000,
        recordingActive: true,
      });
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY);
      assert.equal(job.recordingActive, false);
      assert.equal(job.event, 'rings');

      const candidate = {
        devSn: 'T8161T0000000000',
        storagePath: '/zx/clip1.zxvideo',
        cipherId: 0,
        clipMs: t0 + 1000,
      };
      assert.equal(job.enqueueMatchedCandidate(candidate, new Set()), true);
      assert.equal(job.state, BACKFILL_STATES.MATCHED);

      const nextClip = job.shiftNextClipForDownload();
      assert.ok(nextClip);
      assert.equal(job.state, BACKFILL_STATES.DOWNLOADING);

      // Regression: matching a second clip while Clip 1 is DOWNLOADING must keep DOWNLOADING state
      const candidate2 = {
        devSn: 'T8161T0000000000',
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 0,
        clipMs: t0 + 2000,
      };
      assert.equal(job.enqueueMatchedCandidate(candidate2, new Set()), true);
      assert.equal(job.state, BACKFILL_STATES.DOWNLOADING);
      assert.equal(job.completeCurrentDownload(), BACKFILL_STATES.MATCHED);
      assert.ok(job.shiftNextClipForDownload());
      assert.equal(job.state, BACKFILL_STATES.DOWNLOADING);

      // Follow-up query transitions DOWNLOADING -> READY_TO_QUERY
      assert.equal(job.prepareFollowUpQuery(t0 + 25000), true);
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY);

      // Pure predicate isExpired must not mutate state; expireIfNeeded transitions to EXPIRED
      const expiredAt = t0 + 25000 + DEFAULT_BACKFILL_MAX_AGE_MS + 1000;
      assert.equal(job.isExpired(expiredAt), true);
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY, 'Pure isExpired must not mutate BackfillJob state');
      assert.equal(job.expireIfNeeded(expiredAt), true);
      assert.equal(job.state, BACKFILL_STATES.EXPIRED);

      // Terminal EXPIRED job ignores subsequent upgradeEvent mutations
      assert.equal(
        job.upgradeEvent({
          at: expiredAt + 1000,
          event: 'identity person detected',
          personName: 'Bob',
          reason: 'identity person detected (Bob)',
          priority: 5000,
          recordingActive: true,
        }),
        false
      );
      assert.equal(job.personName, 'Alice');
      assert.equal(job.recordingActive, false);

      // 3. Frigate Event Lifecycle FSM: IDLE -> QUEUED -> WAITING_SNAPSHOT -> COOLDOWN -> IDLE
      assert.ok(Object.isFrozen(FRIGATE_EVENT_STATES));
      assert.equal(cam.getFrigateEventState(t0), FRIGATE_EVENT_STATES.IDLE);
      assert.equal(cam.tryUpgradeOrQueueFrigateEvent('motion detected', '', t0).status, 'queued');
      assert.equal(cam.getFrigateEventState(t0), FRIGATE_EVENT_STATES.QUEUED);
      assert.equal(cam.beginFrigateSnapshotWait(), true);
      assert.equal(cam.getFrigateEventState(t0 + 600), FRIGATE_EVENT_STATES.WAITING_SNAPSHOT);
      cam.completeFrigateEventFiling(t0 + 2000, 15);
      assert.equal(cam.getFrigateEventState(t0 + 2500), FRIGATE_EVENT_STATES.COOLDOWN);
      assert.equal(cam.getFrigateEventState(t0 + 120000), FRIGATE_EVENT_STATES.IDLE);

      // 4. Decoder Backpressure FSM: DETACHED -> HANDSHAKING -> DECODING -> PAUSED_BACKPRESSURE ->
      // FLUSHING_EOF -> DETACHED
      assert.ok(Object.isFrozen(DECODER_STATES));
      assert.equal(cam.decoderState, DECODER_STATES.DETACHED);
      cam.attachDecoder({stdin: {writable: true, write() {}, end() {}}, stdout: {pause() {}, resume() {}}});
      assert.equal(cam.decoderState, DECODER_STATES.HANDSHAKING);
      cam.markDecoderDecoding();
      assert.equal(cam.decoderState, DECODER_STATES.DECODING);
      cam.pauseDecoderStdout();
      assert.equal(cam.decoderState, DECODER_STATES.PAUSED_BACKPRESSURE);
      cam.resumeDecoderStdout();
      assert.equal(cam.decoderState, DECODER_STATES.DECODING);
      cam.markDecoderInputEnded();
      assert.equal(cam.decoderState, DECODER_STATES.FLUSHING_EOF);
      cam.detachDecoder();
      assert.equal(cam.decoderState, DECODER_STATES.DETACHED);

      // 5. Immutable WakeRequest Builder & default health policy methods
      const req = WakeRequest.motion('person detected (Alice)', 45000)
        .withInitiator('eufy-ws/event')
        .withPriority(250)
        .withCreateEvent(true)
        .build();
      assert.ok(Object.isFrozen(req));
      assert.equal(req.kind, 'motion');
      assert.equal(req.reason, 'person detected (Alice)');
      assert.equal(req.durationMs, 45000);
      assert.equal(req.initiator, 'eufy-ws/event');
      assert.equal(req.priority, 250);

      const applied = cam.applyWakeRequest(req, t0, [cam]);
      assert.equal(applied.accepted, true);
      assert.equal(cam.motionUntil, t0 + 45000);
      assert.equal(cam.wakeInitiator, 'eufy-ws/event');

      cam.beginSession('p2p', t0, false);
      // Default thresholds on evaluateP2pHealth & shouldPollFrigateForHoldOrBackfill work without magic numbers
      assert.equal(cam.evaluateP2pHealth(t0 + 1000, t0).action, 'none');
      assert.equal(cam.shouldPollFrigateForHoldOrBackfill(t0 + 1000).shouldPoll, false);

      // 6. State transition logging for BackfillJob, FrigateEvent, and Decoder state machines
      const loggedLines = [];
      const origConsoleLog = console.log;
      initLogger('debug');
      console.log = (line) => loggedLines.push(line);
      try {
        const logCam = new Camera({serial: 'T8214T2222222222', name: 'doorbell', mode: 'backfill'});
        logCam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
        logCam.recordMotionCleared(t0 + 5000, 5000, 10000, 'person detected');
        assert.equal(logCam.canQueryBackfill(t0 + 10000, 8000, 12000), true);
        logCam.beginBackfillDatabaseQuery(t0 + 10000);
        logCam.tryMatchBackfillCandidate({
          devSn: 'T8214T2222222222',
          storagePath: '/zx/clip_log.zxvideo',
          cipherId: 0,
          clipMs: t0 + 1000,
        });
        logCam.beginBackfillDownload(logCam.backfillClip, false, t0 + 11000);

        logCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', t0);
        logCam.beginFrigateSnapshotWait();
        logCam.completeFrigateEventFiling(t0 + 2000, 15);
        logCam.getFrigateEventState(t0 + 120000);

        logCam.attachDecoder({stdin: {writable: true, write() {}, end() {}}, stdout: {pause() {}, resume() {}}});
        logCam.markDecoderDecoding();
        logCam.pauseDecoderStdout();
        logCam.resumeDecoderStdout();
        logCam.markDecoderInputEnded();
        logCam.detachDecoder();
      } finally {
        console.log = origConsoleLog;
        initLogger('error');
      }

      const strippedLogs = loggedLines.map((line) =>
        line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[DEBUG\] - /, '')
      );
      assert.deepEqual(
        strippedLogs.filter((l) => l.includes('backfill state:')),
        [
          '[doorbell] [SETTLING] backfill state: recording -> settling (all triggers cleared)',
          '[doorbell] [READY_TO_QUERY] backfill state: settling -> ready_to_query (settle window elapsed)',
          '[doorbell] [MATCHED] backfill state: ready_to_query -> matched (candidate clip matched)',
          '[doorbell] [DOWNLOADING] backfill state: matched -> downloading (clip dequeued for download)',
        ]
      );
      assert.deepEqual(
        strippedLogs.filter((l) => l.includes('frigate event state:')),
        [
          '[doorbell] [QUEUED] frigate event state: idle -> queued (event queued)',
          '[doorbell] [WAITING_SNAPSHOT] frigate event state: queued -> waiting_snapshot (dispatch timer fired)',
          '[doorbell] [COOLDOWN] frigate event state: waiting_snapshot -> cooldown (event filed)',
          '[doorbell] [IDLE] frigate event state: cooldown -> idle (cooldown elapsed)',
        ]
      );
      assert.deepEqual(
        strippedLogs.filter((l) => l.includes('decoder state:')),
        [
          '[doorbell] [HANDSHAKING] decoder state: detached -> handshaking (decoder attached)',
          '[doorbell] [DECODING] decoder state: handshaking -> decoding (first frame decoded)',
          '[doorbell] [PAUSED_BACKPRESSURE] decoder state: decoding -> paused_backpressure (high watermark reached)',
          '[doorbell] [DECODING] decoder state: paused_backpressure -> decoding (low watermark resumed)',
          '[doorbell] [FLUSHING_EOF] decoder state: decoding -> flushing_eof (input pipe ended)',
          '[doorbell] [DETACHED] decoder state: flushing_eof -> detached (decoder detached)',
        ]
      );
    }
  );

  it('provides named domain predicates, filters, and comparators on Camera', () => {
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

    rtspCam.motionUntil = t0 + 60000;
    assert.equal(rtspCam.wantsWake(t0), true);
    assert.equal(rtspCam.wantsRtspWake(t0), true);
    assert.equal(p2pCam.wantsRtspWake(t0), false);
    assert.deepEqual(
      allCams.filter((c) => c.wantsRtspWake(t0)).map((c) => c.name),
      ['driveway']
    );

    rtspCam.eventActive = true;
    rtspCam.beginSession('rtsp', t0, true);
    assert.equal(rtspCam.isActiveRtspSession(), true);
    assert.equal(rtspCam.isActiveLiveSession(), true);
    assert.equal(rtspCam.canStartRtspStream(), true);
    assert.equal(rtspCam.shouldFileInitialRtspEvent(), true);
    assert.equal(rtspCam.canSpawnRtspDecoder(rtspCam.sessionId), true);
    assert.equal(rtspCam.isEstablishedRtspStream(), false);

    rtspCam.markRtspFrameReceived(t0 + 1000);
    assert.equal(rtspCam.isEstablishedRtspStream(), true);
    assert.equal(rtspCam.hasExpiredLiveHold(t0 + 30000), false);
    assert.equal(rtspCam.hasExpiredLiveHold(t0 + 60000), true);

    // 2. Station P2P slot and early-sleep predicates
    assert.equal(p2pCam.belongsToStationP2pSlot('T8030P0000000000'), true);
    assert.equal(rtspCam.belongsToStationP2pSlot('T8030P0000000000'), false);
    p2pCam.motionUntil = t0 + 60000;
    p2pCam.lastMotionAt = t0;
    assert.equal(p2pCam.isHoldingStationP2pForMotion('T8030P0000000000', t0), true);

    p2pCam.beginSession('p2p', t0, true);
    p2pCam.gotVideo = true;
    assert.equal(p2pCam.isMotionOnlyActiveSession(t0 + 5000), true);
    assert.equal(p2pCam.canSleepEarlyOnIdle(t0 + 5000, 10000), false);
    assert.equal(p2pCam.canSleepEarlyOnIdle(t0 + 15000, 10000), true);
    assert.equal(p2pCam.isMidStreamRetrigger(t0 + 6000, 5000), true);

    // 3. Backfill download/query filters, station resolution, and comparators
    p2pCam.endSession(t0 + 16000, false, false, 'p2p');
    p2pCam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, false);
    assert.equal(p2pCam.getBackfillPriority(), p2pCam.priority + 200);
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
    p2pCam.viewers = 2;
    assert.equal(p2pCam.hasConnectedViewers(), true);
    p2pCam.evPerson = 'Alice';
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
    rtspCam.gotVideo = true;
    rtspCam.lastMotionAt = t0;
    rtspCam.motionUntil = t0 + 60000;
    rtspCam.activeTriggerEvents.add('motion detected');
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
    rtspCam.firstVideoAt = t0 + 2000;
    rtspCam.motionUntil = t0 + 60000;
    rtspCam.recordMotionCleared(t0 + 10000, 5000, 10000, 'motion detected');
    assert.equal(
      rtspCam.shouldRewakeRtspOnDrop(t0 + 40000),
      true,
      'Must re-wake RTSP when hardware closes stream at 40s (20s before 60s hold_secs expires) ' +
        'even if PIR cleared at 10s'
    );
    rtspCam.recordMotionCleared(t0 + 60000, 5000, 10000, 'motion detected');
    rtspCam.motionUntil = t0 + 90000;
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
    extendCam.gotVideo = true;
    extendCam.firstVideoAt = t0 + 1000;
    extendCam.firstFrameAt = t0 + 1000;
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
    assert.equal(extendCam.motionUntil, t0 + 90000);
    extendCam.applyMotionTrigger(t0 + 20100, 'person detected', 60000, 'eufy-event', 200);
    assert.equal(extendCam.motionUntil, t0 + 90000, 'Companion event 100ms later must not double-add halfMs');

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
      extendCam.motionUntil,
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
          asleep: c.card.asleep,
          waking: c.card.waking,
          busy: c.card.busy,
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
    p2pCam.gotVideo = true;
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
    defaultUntrackedCam.sleptAt = t0 + 1000;
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
    assert.equal(freshStartupCam.telemetry.isLightOn(), true);
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
    assert.equal(freshStartupCam.telemetry.isLightOn(), false);

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
    freshLightRtspCam.activeTriggerEvents.clear();
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
    p2pCam.telemetry.markWakeTimedOut();
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
    p2pCam.gotVideo = true;
    p2pCam.firstFrameAt = t0 + 500;
    p2pCam.lastVideoAt = t0 + 5000;
    p2pCam.markDownloadFinished(t0 + 5000);
    p2pCam.backfillClipQueue = [
      {
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 0,
        clipMs: t0 + 30000,
        event: 'person detected',
        personName: 'Alice',
        reason: 'person detected (Alice)',
      },
    ];
    assert.equal(
      p2pCam.isDownloadComplete(t0 + 6100, 3000, 2500, 4500),
      true,
      'Must complete clip 1 immediately after decoder flush (without 2.5s postPlaybackHoldMs) when clip 2 is queued'
    );

    // Back-to-back doorbell clips: while Clip 1 is draining in RAM (downloadFinished=true), a newly settled
    // pendingBackfill job can query HomeBase in the background, skips the 2.5s postPlaybackHoldMs, and keeps
    // isStreamingLive() === true across the brief Clip 2 handshake so the stream never flashes the Asleep (S) card
    p2pCam.backfillClipQueue = [];
    p2pCam.backfillClip = null;
    p2pCam.lastBackfillQueryAt = 0;
    const tNewTrigger = t0 + 5200;
    p2pCam.queueEventBackfill(tNewTrigger, 'person detected', '', 'person detected', 200, true);
    p2pCam.recordMotionCleared(tNewTrigger + 9000, 5000, 10000, 'person detected');
    assert.equal(p2pCam.pendingBackfill.recordingActive, false);
    assert.equal(p2pCam.activeBackfillJob.recordingActive, false);
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
    p2pCam.frame = Buffer.alloc(1382400, 0x44);
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
    extendCam.motionUntil = t0 + 95000;
    extendCam.evUntil = t0 + 81000;
    extendCam.evDispatchedAt = t0 + 21000;
    extendCam.lastExtendCheckAt = 0;
    assert.deepEqual(
      extendCam.shouldPollFrigateForHoldOrBackfill(t0 + 75000, 12000, 5000, 4000),
      {shouldPoll: true, needsTimeoutExtendCheck: true},
      'Must poll Frigate and extend evUntil when evUntil is within 12s even if motionUntil is 20s away'
    );
    extendCam.frameAt = t0 + 70000;
    extendCam.lastFrame = Buffer.alloc(1382400, 0x66);
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

  it('encapsulates Law-of-Demeter accessors, mutators, and immutable value objects across domain models', () => {
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
    cam.motionUntil = t0 + 60000;
    cam.lastMotionAt = t0;
    const rtspWakeLog = cam.beginRtspWakeSession(t0);
    assert.equal(cam.isSessionActive(), true);
    assert.match(rtspWakeLog, /WAKE \[RTSP\]/);
    assert.equal(cam.isFirstWakeAttempt(), true);
    const sessId = cam.markRtspAttemptStart(t0 + 500);
    assert.equal(sessId, cam.getSessionId());

    const quietSecs = cam.markEarlySleep(t0 + 12000);
    assert.equal(quietSecs, 12);
    assert.equal(cam.handleStationDisconnected('station_disconnected'), true);
    assert.equal(cam.motionUntil, 0);

    // 5. External livestream stop evaluation
    cam.endSession(t0 + 13000, false, false, 'rtsp');
    cam.motionUntil = t0 + 60000;
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
      otherCam.sleptAt = t0 + 3000;
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
      otherCam.viewUntil = t0 + 20000;
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

  it(
    'uses semantically distinct domain constants for telemetry visual status kinds, segment ' +
      'types, power labels, wake kinds, and process signals',
    () => {
      assert.equal(Object.isFrozen(STATUS_KINDS), true);
      assert.deepEqual(STATUS_KINDS, {
        LIVE: 'live',
        BACKFILL: 'backfill',
        WAKING: 'waking',
        WAITING: 'waiting',
        LOW_BATTERY: 'low',
        DISCONNECTED: 'disconnected',
        ASLEEP: 'asleep',
      });

      assert.equal(Object.isFrozen(POWER_LABELS), true);
      assert.deepEqual(POWER_LABELS, {
        CHARGING: 'Charging',
        PLUGGED: 'Plugged',
        SOLAR: 'Solar',
      });

      assert.equal(Object.isFrozen(WAKE_KINDS), true);
      assert.deepEqual(WAKE_KINDS, {
        MOTION: 'motion',
        VIEW: 'view',
      });

      assert.equal(Object.isFrozen(EUFY_CHARGING_STATUS), true);
      assert.deepEqual(EUFY_CHARGING_STATUS, {
        CHARGING: 1,
        UNPLUGGED: 2,
        PLUGGED: 3,
        SOLAR: 4,
      });

      assert.equal(Object.isFrozen(EUFY_POWER_SOURCES), true);
      assert.deepEqual(EUFY_POWER_SOURCES, {
        BATTERY: 0,
        SOLAR: 1,
      });

      assert.equal(Object.isFrozen(WIFI_SIGNAL_LEVELS), true);
      assert.deepEqual(WIFI_SIGNAL_LEVELS, {
        NONE: 0,
        WEAK: 1,
        FAIR: 2,
        GOOD: 3,
        FULL: 4,
      });

      // Verify Telemetry visual states use CARD_STATUS_TITLES input and produce STATUS_KINDS
      // output without mixing meanings
      const cam = new Camera({
        serial: 'T8161T0000000000',
        name: 'driveway',
        card_theme: CARD_THEMES.GLANCE,
        card_position: CARD_POSITIONS.BOTTOM_LEFT,
        telemetry: {temperature: true, last_seen: true},
      });
      cam.applyTelemetryProperties({battery: 90, chargingStatus: 1, wifiRssi: -58, batteryTemperature: 22}, false);
      const liveVisual = cam.telemetry.evaluateVisualState(CARD_STATUS_TITLES.LIVE);
      const backfillVisual = cam.telemetry.evaluateVisualState(CARD_STATUS_TITLES.BACKFILL);
      const asleepVisual = cam.telemetry.evaluateVisualState(CARD_STATUS_TITLES.ASLEEP);
      assert.equal(liveVisual.statusKind, STATUS_KINDS.LIVE);
      assert.equal(backfillVisual.statusKind, STATUS_KINDS.BACKFILL);
      assert.equal(asleepVisual.statusKind, STATUS_KINDS.ASLEEP);
      assert.equal(asleepVisual.powerLabel, POWER_LABELS.CHARGING);
      const snapshot = cam.telemetry.toStatusSnapshot(cam.card.config);
      assert.equal(snapshot.powerLabel, POWER_LABELS.CHARGING);
      assert.equal(snapshot.battery, 90);

      // Verify WakeRequest uses WAKE_KINDS and Camera encoder process control uses PROCESS_SIGNALS
      const motionReq = WakeRequest.motion('person detected', 60000).build();
      const viewReq = WakeRequest.view('live view', 20000).build();
      assert.equal(motionReq.kind, WAKE_KINDS.MOTION);
      assert.equal(viewReq.kind, WAKE_KINDS.VIEW);

      const signalsSent = [];
      cam.attachEncoder({
        kill(sig) {
          signalsSent.push(sig);
        },
      });
      cam.stopEncoderProcess();
      cam.killWedgedEncoder();
      assert.deepEqual(signalsSent, [PROCESS_SIGNALS.SIGTERM, PROCESS_SIGNALS.SIGKILL]);

      // Verify STREAM_MODES vs CARD_STATUS_TITLES vs STATUS_KINDS are never conflated
      assert.notEqual(STREAM_MODES.DOWNLOAD, CARD_STATUS_TITLES.BACKFILL);
      assert.notEqual(STREAM_MODES.DOWNLOAD, STATUS_KINDS.BACKFILL);
      assert.notEqual(CARD_STATUS_TITLES.BACKFILL, STATUS_KINDS.BACKFILL);
    }
  );

  it(
    'rebuilds the status card when Wi-Fi signal bar tier changes after initial battery load, ' +
      'while ignoring minor RSSI jitter within the same bar tier',
    () => {
      const doorbell = new Camera({
        serial: 'T8214T2222222222',
        title: 'Front Doorbell',
        mode: 'backfill',
        card_theme: CARD_THEMES.MINIMAL,
      });

      // 1. Initial battery property arrives before wifiRssi
      const firstOutcome = doorbell.applyTelemetryProperties({battery: 9}, false);
      assert.equal(firstOutcome.shouldRebuildCard, true);
      assert.equal(doorbell.telemetry.wifi, null);

      // 2. Subsequent wifiRssi property arrives (-26 dBm -> wifi=4 bars): must rebuild card so 3rd dot turns Green
      const wifiLoadedOutcome = doorbell.applyTelemetryProperties({wifiRssi: -26}, false);
      assert.equal(doorbell.telemetry.wifi, 4);
      assert.equal(
        wifiLoadedOutcome.shouldRebuildCard,
        true,
        'Must rebuild card when Wi-Fi bars transition from null to 4'
      );

      // 3. Minor 1 dBm RSSI fluctuation within the same 4-bar tier (-26 -> -27 dBm) must not rebuild card
      const jitterOutcome = doorbell.applyTelemetryProperties({wifiRssi: -27}, false);
      assert.equal(doorbell.telemetry.wifi, 4);
      assert.equal(jitterOutcome.shouldRebuildCard, false);

      // 4. Signal drop across bar tiers (-27 -> -76 dBm, 4 -> 2 bars) must rebuild card
      const tierChangeOutcome = doorbell.applyTelemetryProperties({wifiRssi: -76}, false);
      assert.equal(doorbell.telemetry.wifi, 2);
      assert.equal(tierChangeOutcome.shouldRebuildCard, true);

      // 5. Subsequent batteryTemperature property arriving (null -> 21°C) must rebuild card so
      // Grey thermometer turns Green
      const tempLoadedOutcome = doorbell.applyTelemetryProperties({batteryTemperature: 21}, false);
      assert.equal(doorbell.telemetry.temp, 21);
      assert.equal(tempLoadedOutcome.shouldRebuildCard, true);
    }
  );

  it(
    'detects offline/dead camera states (Eufy DeviceState, 0% depleted battery, and non-event ' +
      'wake timeouts), pauses encoder, and evaluates offline snapshot seeding eligibility',
    () => {
      assert.equal(Object.isFrozen(EUFY_DEVICE_STATES), true);
      assert.deepEqual(EUFY_DEVICE_STATES, {
        OFFLINE: 0,
        ONLINE: 1,
        MANUALLY_DISABLED: 2,
        OFFLINE_LOWBAT: 3,
        REMOVE_AND_READD: 4,
        RESET_AND_READD: 5,
      });

      const doorbell = new Camera(
        {
          serial: 'T8214T2222222222',
          name: 'doorbell',
          title: 'Front Doorbell',
          mode: 'backfill',
          sleep_screen: 'snapshot',
        },
        {frame: Buffer.alloc(FRAME, 0x30), lastSeen: '10:00'}
      );
      const noSnapCam = new Camera({serial: 'T8161T0000000000', sleep_screen: 'snapshot'}, {frame: null, lastSeen: ''});
      const blackScreenCam = new Camera(
        {serial: 'T8161T1111111111', sleep_screen: 'black'},
        {frame: Buffer.alloc(FRAME, 0x30), lastSeen: '10:00'}
      );

      assert.equal(doorbell.hasOfflineSnapshotToSeed(), true);
      assert.equal(noSnapCam.hasOfflineSnapshotToSeed(), false, 'Must not seed when no cached snapshot is available');
      assert.equal(
        blackScreenCam.hasOfflineSnapshotToSeed(),
        false,
        'Must not seed when sleep_screen is not "snapshot"'
      );

      assert.equal(doorbell.isDeviceOffline(), false);
      assert.equal(doorbell.getOfflineReason(), '');

      // 1. Depleted battery (0% while unplugged) marks camera offline and blocks wakes/startup probes
      const depletedOutcome = doorbell.applyTelemetryProperties({battery: 0, chargingStatus: 2}, false);
      assert.equal(depletedOutcome.hadInitialTelemetry, false);
      assert.equal(depletedOutcome.isOffline, true);
      assert.equal(depletedOutcome.offlineChanged, true);
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'battery depleted (0%)');

      const now = 50000;
      doorbell.viewUntil = now + 20000;
      doorbell.needsStartupSnapshot = true;
      assert.equal(doorbell.wantsWake(now), false, 'Offline camera must not request wake');
      assert.equal(
        doorbell.canStartStartupProbe([doorbell], now),
        false,
        'Offline camera must not start startup snapshot probe'
      );

      // 2. Plugging camera in to charge clears 0% depleted battery offline state
      const chargingOutcome = doorbell.applyTelemetryProperties({chargingStatus: 1}, false);
      assert.equal(chargingOutcome.hadInitialTelemetry, true);
      assert.equal(chargingOutcome.isOffline, false);
      assert.equal(chargingOutcome.offlineChanged, true);
      assert.equal(doorbell.isDeviceOffline(), false);
      assert.equal(doorbell.getOfflineReason(), '');

      // 3. Explicit Eufy DeviceState OFFLINE_LOWBAT (3) vs deep-sleep standby OFFLINE (0)
      doorbell.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT, chargingStatus: 2, battery: 5},
        false
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'offline (low battery)');

      // Healthy battery camera (e.g. T8161 at 100% battery and -72 dBm RSSI) reporting state=0
      // in deep standby must NOT be marked offline
      doorbell.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 100, wifiRssi: -72, wifiSignalLevel: 3},
        false
      );
      assert.equal(
        doorbell.isDeviceOffline(),
        false,
        'Battery camera in deep standby (state=0 with healthy battery and Wi-Fi RSSI) must not be marked offline'
      );
      assert.equal(doorbell.getOfflineReason(), '');

      // Regression: deep-standby state=0 reported before battery telemetry is populated
      // (battery=null) must NOT falsely mark camera offline
      const bootingStandbyCam = new Camera({serial: 'T8161T0000000099', name: 'boot_standby'});
      bootingStandbyCam.applyTelemetryProperties({state: EUFY_DEVICE_STATES.OFFLINE, wifiRssi: -70}, false);
      assert.equal(
        bootingStandbyCam.isDeviceOffline(),
        false,
        'Deep-standby state=0 before battery property is populated (battery=null) must not mark camera offline'
      );
      assert.equal(bootingStandbyCam.getOfflineReason(), '');

      // state=0 with dead link (rssi <= -95 dBm) or critical battery (<= 5%) is genuinely offline
      doorbell.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 45, wifiRssi: -100, wifiSignalLevel: 0},
        false
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'device offline');

      doorbell.applyTelemetryProperties({state: EUFY_DEVICE_STATES.ONLINE, wifiRssi: -68}, false);
      assert.equal(doorbell.isDeviceOffline(), false);
      assert.equal(doorbell.getOfflineReason(), '');

      // 4. Non-event wake timeout without video marks camera unreachable/offline, whereas event wake timeout does not
      doorbell.eventActive = false;
      doorbell.beginSession(STREAM_MODES.P2P, now, false);
      doorbell.terminateSession(
        now + 15000,
        'no initial video for 15s after 3 start attempts',
        false,
        'error/watchdog-timeout'
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      assert.equal(doorbell.getOfflineReason(), 'unreachable (wake timed out)');

      doorbell.markDeviceOnline();
      assert.equal(doorbell.isDeviceOffline(), false);

      doorbell.eventActive = true;
      doorbell.beginSession(STREAM_MODES.P2P, now + 20000, false);
      doorbell.terminateSession(
        now + 35000,
        'no initial video for 15s after 3 start attempts',
        false,
        'error/watchdog-timeout'
      );
      assert.equal(
        doorbell.isDeviceOffline(),
        false,
        'Motion-triggered wake timeout must not mark camera offline because hardware is awake recording for backfill'
      );

      // 5. Encoder pause/resume lifecycle for Frigate "device offline" display
      const signals = [];
      doorbell.attachEncoder({
        kill(sig) {
          signals.push(sig);
        },
      });
      doorbell.applyTelemetryProperties({state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT}, false);
      assert.equal(doorbell.pauseEncoderForOffline(), true);
      assert.deepEqual(signals, [PROCESS_SIGNALS.SIGKILL]);
      assert.equal(doorbell.hasEncoderProcess(), false);
      assert.equal(doorbell.shouldResumeOfflineEncoder(), false);

      doorbell.applyTelemetryProperties({state: EUFY_DEVICE_STATES.ONLINE, battery: 60}, false);
      assert.equal(doorbell.shouldResumeOfflineEncoder(), true);
      doorbell.clearEncoderOfflinePause();
      assert.equal(doorbell.shouldResumeOfflineEncoder(), false);

      // 6. Battery swap recovery when device.get_properties still carries stale state=3
      // (OFFLINE_LOWBAT) or state=0 + dead RSSI
      doorbell.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 2,
          chargingStatus: 2,
          wifiRssi: -100,
          wifiSignalLevel: 1,
        },
        false
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      doorbell.applyTelemetryProperties({battery: 1}, false);
      assert.equal(
        doorbell.isDeviceOffline(),
        true,
        'A 2% -> 1% property changed event without state must not clear OFFLINE_LOWBAT while still in low battery'
      );
      assert.equal(doorbell.shouldRefreshOfflineOnView(400000), true);
      assert.equal(
        doorbell.shouldRefreshOfflineOnView(500000),
        false,
        'Respects 5m (300s) refresh cooldown while offline so MSE reconnects do not spam driver.poll_refresh'
      );

      const swappedWithStaleState3 = doorbell.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 100,
          chargingStatus: 2,
          wifiRssi: -100,
          wifiSignalLevel: 1,
        },
        false
      );
      assert.equal(
        doorbell.isDeviceOffline(),
        false,
        'Must clear stale OFFLINE_LOWBAT (state=3) when battery is swapped to 100% even if ' +
          'state=3 is present in device.get_properties'
      );
      assert.equal(swappedWithStaleState3.offlineChanged, true);
      assert.equal(swappedWithStaleState3.stateChanged, true);
      assert.equal(swappedWithStaleState3.shouldRebuildCard, true);
      assert.equal(doorbell.shouldRefreshOfflineOnView(800000), false);

      // Regression: a >= 10% battery swap must also clear OFFLINE_LOWBAT / OFFLINE when the
      // replacement battery is still at or below low_battery_threshold (e.g., 2% -> 15% <= 30%),
      // while smaller fluctuations (< 10%) and initial stale state=3 at 15% remain offline.
      const lowSwapCam = new Camera({serial: 'T8161T2222222222', low_battery_threshold: 30});
      lowSwapCam.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 15,
          chargingStatus: 2,
        },
        false
      );
      assert.equal(
        lowSwapCam.isDeviceOffline(),
        true,
        'Initial state=3 at 15% with no prior battery must remain OFFLINE_LOWBAT'
      );

      const minorRiseCam = new Camera({serial: 'T8161T3333333333', low_battery_threshold: 30});
      minorRiseCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT, battery: 2, chargingStatus: 2},
        false
      );
      minorRiseCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT, battery: 5, chargingStatus: 2},
        false
      );
      assert.equal(
        minorRiseCam.isDeviceOffline(),
        true,
        'A 2% -> 5% (< 10%) rise must not clear OFFLINE_LOWBAT while still in low battery'
      );

      const partialSwapOutcome = minorRiseCam.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 15,
          chargingStatus: 2,
          wifiRssi: -100,
          wifiSignalLevel: 1,
        },
        false
      );
      assert.equal(
        minorRiseCam.isDeviceOffline(),
        false,
        'A 5% -> 15% (>= 10%) battery swap must clear OFFLINE_LOWBAT even while <= 30% threshold'
      );
      assert.equal(minorRiseCam.isLowBattery(), true);
      assert.equal(partialSwapOutcome.offlineChanged, true);

      const standbySwapCam = new Camera({serial: 'T8161T4444444444', low_battery_threshold: 30});
      standbySwapCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 2, chargingStatus: 2},
        false
      );
      standbySwapCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 12, chargingStatus: 2},
        false
      );
      assert.equal(
        standbySwapCam.isDeviceOffline(),
        false,
        'A 2% -> 12% (>= 10%) battery swap must clear OFFLINE even while <= 30% threshold'
      );

      // 7. Consumer (re-)connection triggers an immediate 15 fps keyframe burst so Frigate
      // attaches without waiting for 1 fps GOP
      const tAttach = 300000;
      doorbell.attachEncoder({stdin: {writable: true, write() {}}, kill() {}}, tAttach);
      assert.equal(doorbell.isInKeyframeBurst(tAttach + 5000), false);
      assert.equal(doorbell.notifyEncoderConsumersObserved(1, 6000, tAttach + 5000), true);
      assert.equal(doorbell.isInKeyframeBurst(tAttach + 5500), true);
      assert.equal(
        doorbell.notifyEncoderConsumersObserved(1, 6000, tAttach + 6000),
        false,
        'Does not re-trigger burst while consumer remains connected'
      );
      assert.equal(doorbell.notifyEncoderConsumersObserved(0, 6000, tAttach + 9000), false);
      assert.equal(
        doorbell.notifyEncoderConsumersObserved(1, 6000, tAttach + 10000),
        true,
        'Re-triggers keyframe burst when go2rtc consumer disconnects and reconnects'
      );

      // 8. Deduplicates simultaneous property changed + native trigger start/clear pairs within 1s burst
      const tBurst = 900000;
      assert.equal(doorbell.isDuplicateTriggerEvent('person detected', true, '', tBurst), false);
      doorbell.queueEventBackfill(tBurst, 'person detected', '', 'person detected', 200, true);
      assert.equal(
        doorbell.isDuplicateTriggerEvent('person detected', true, '', tBurst + 5),
        true,
        'Duplicate person detected start within 1s burst must be coalesced'
      );
      assert.equal(
        doorbell.isDuplicateTriggerEvent('person detected', true, 'Alice', tBurst + 10),
        false,
        'Must allow companion face name upgrade on the same trigger event'
      );
      assert.equal(doorbell.isDuplicateTriggerEvent('person detected', false, '', tBurst + 10000), false);
      doorbell.recordMotionCleared(tBurst + 10000, 5000, 10000, 'person detected');
      assert.equal(
        doorbell.isDuplicateTriggerEvent('person detected', false, '', tBurst + 10005),
        true,
        'Duplicate person detected clear within 1s burst must be coalesced'
      );

      // 9. terminateSession reports hadDownloadFinished so stop() skips redundant
      // device.cancel_download after normal completion
      doorbell.beginBackfillDownload(
        {
          storagePath: '/zx/clip_done.zxvideo',
          cipherId: 0,
          cipher_id: 0,
          clipMs: tBurst - 10000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        tBurst + 20000
      );
      doorbell.markDownloadFinished(tBurst + 25000);
      const termDone = doorbell.terminateSession(
        tBurst + 55000,
        'post-event clip download stream completed',
        false,
        'eufy/download-finished'
      );
      assert.equal(termDone.hadDownloadFinished, true);

      // 10. P2P viewer linger disconnect, mid-session starting guard, and lastStartAt refresh in backfill mode
      const garageCam = new Camera({serial: 'T8161T1111111111', name: 'garage', mode: 'backfill'});
      const tView = 1000000;
      garageCam.applyViewTrigger(tView, 'live view opened', 20000, 'viewer');
      garageCam.beginSession('p2p', tView, true);
      garageCam.markP2pVideoPacketReceived(tView + 4000);
      garageCam.recordDecodedFrame(Buffer.alloc(FRAME, 0x20), Buffer.alloc(FRAME, 0x20), tView + 4000, '22:22');
      const liveOverlaySpec = garageCam.prepareLiveCardOverlay(Buffer.alloc(FRAME, 0x20));
      assert.equal('frameMarker' in liveOverlaySpec, false);

      // When all viewers disconnect (viewerIds empty) and stream stops during post-viewer linger,
      // end cleanly ('expired') instead of re-waking
      assert.equal(garageCam.hasWakingViewer(), false);
      assert.equal(
        garageCam.evaluateExternalLivestreamStop(tView + 12000, 3000).action,
        'expired',
        'Must not re-request P2P livestream during post-viewer linger after all viewers disconnected'
      );
      assert.equal(
        garageCam.evaluateP2pHealth(tView + 12000, tView + 4000).action,
        'expired',
        'Watchdog must expire viewer-only P2P stream cleanly when camera stops sending video after viewer disconnected'
      );

      // While an active viewer is connected, markP2pStreamReady updates lastStartAt and
      // starting=true suppresses self-stop events
      garageCam.registerNewViewer('v1', tView + 5000);
      garageCam.setViewerWakingStatus('v1', true);
      garageCam.beginP2pStartAttempt();
      assert.equal(
        garageCam.evaluateExternalLivestreamStop(tView + 13000, 3000).action,
        'inactive',
        'Must ignore livestream stopped events while startLivestream (starting=true) is restarting the stream'
      );
      garageCam.markP2pStreamReady(tView + 14000);
      garageCam.finishP2pStartAttempt(garageCam.getSessionId());
      assert.equal(
        garageCam.isMidStreamRetrigger(tView + 15000, 5000),
        false,
        'markP2pStreamReady must refresh lastStartAt so watchdog retries do not trigger false ' +
          '+15s mid-stream hold extensions'
      );
      const termP2p = garageCam.terminateSession(tView + 16000, 'viewer closed', false, 'eufy/camera');
      assert.equal(termP2p.hadUnexpectedRtsp, false);
      assert.deepEqual(
        garageCam.evaluateQualityChange({videoStreamingQuality: {value: 10}}),
        {shouldUpdate: true, currentQuality: 10, targetQuality: 7},
        'evaluateQualityChange must clamp High/Ultra/4K (>7) streaming quality down to Medium (7) ' +
          'to prevent 4K bandwidth stalls over weak Wi-Fi'
      );

      // 11. Back-to-back backfill during DRAINING_BACKFILL_TAIL: needsLatestInfoBackfillQuery
      // returns true whenever pendingBackfill has no matched clip
      const backToBackCam = new Camera({serial: 'T8161T4444444444', name: 'garage_b2b', mode: 'backfill'});
      const tClip1 = 2000000;
      backToBackCam.beginBackfillDownload(
        {
          storagePath: '/zx/clip1.zxvideo',
          cipherId: 0,
          clipMs: tClip1 - 15000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        tClip1
      );
      const tailFrame = Buffer.alloc(FRAME, 0x33);
      backToBackCam.recordDecodedFrame(tailFrame, tailFrame, tClip1 + 500, '20:40', 5000);
      backToBackCam.markDownloadFinished(tClip1 + 3000);
      assert.equal(backToBackCam.sessionState, SESSION_STATES.DRAINING_BACKFILL_TAIL);
      assert.equal(backToBackCam.needsLatestInfoBackfillQuery(), false);
      backToBackCam.queueEventBackfill(tClip1 + 4000, 'person detected', '', 'person detected', 250, true);
      backToBackCam.recordMotionCleared(tClip1 + 14000, 4000, 30000, 'person detected');
      assert.equal(
        backToBackCam.needsLatestInfoBackfillQuery(),
        true,
        'Must query station.database_query_latest_info even while Clip 1 is in ' +
          'DRAINING_BACKFILL_TAIL so Clip 2 is matched before Clip 1 finishes'
      );
      backToBackCam.tryMatchBackfillCandidate({
        devSn: 'T8161T4444444444',
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 0,
        clipMs: tClip1 + 4500,
      });
      assert.equal(
        backToBackCam.needsLatestInfoBackfillQuery(),
        false,
        'Once Clip 2 is matched into backfillClip, needsLatestInfoBackfillQuery returns false'
      );

      // Regression: /api/wake on backfill camera upgrades priority/reason in place without
      // clobbering higher-specificity hardware event labels or creating duplicate BackfillJobs,
      // and a view api-wake during DOWNLOAD preserves backfillClipQueue and pendingBackfill.
      const upgradeCam = new Camera({serial: 'T8161T4444444446', name: 'upgrade_cam', mode: 'backfill'});
      const tUpg = 910000;
      upgradeCam.queueEventBackfill(tUpg, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(upgradeCam.queueOrUpgradeApiWakeBackfill(tUpg + 1000, 'garage sensor', 250), true);
      assert.equal(upgradeCam.pendingBackfill.priority, 250);
      assert.equal(upgradeCam.pendingBackfill.reason, 'garage sensor');
      assert.equal(upgradeCam.pendingBackfill.event, 'motion detected');
      assert.equal(upgradeCam.activeBackfillJob, null);

      const personUpgradeCam = new Camera({serial: 'T8161T4444444447', name: 'person_upg_cam', mode: 'backfill'});
      personUpgradeCam.queueEventBackfill(tUpg, 'person detected', '', 'person detected', 200, true);
      assert.equal(personUpgradeCam.queueOrUpgradeApiWakeBackfill(tUpg + 1000, 'driveway beam', 250), true);
      assert.equal(personUpgradeCam.pendingBackfill.priority, 250);
      assert.equal(personUpgradeCam.pendingBackfill.reason, 'driveway beam');
      assert.equal(
        personUpgradeCam.pendingBackfill.event,
        'person detected',
        'API wake upgrade must preserve higher-specificity hardware event label like person detected'
      );

      const ringUpgradeCam = new Camera({serial: 'T8161T4444444448', name: 'ring_upg_cam', mode: 'backfill'});
      ringUpgradeCam.queueEventBackfill(tUpg, 'rings', '', 'rings', 1000, true);
      assert.equal(ringUpgradeCam.queueOrUpgradeApiWakeBackfill(tUpg + 1000, 'porch sensor', 250), false);
      assert.equal(ringUpgradeCam.pendingBackfill.priority, 1000);
      assert.equal(ringUpgradeCam.pendingBackfill.event, 'rings');
      assert.equal(ringUpgradeCam.pendingBackfill.reason, 'rings');

      const dlCam = new Camera({
        serial: 'T8161T4444444449',
        name: 'dl_preserve_cam',
        mode: 'rtsp',
        backfill_downloads: true,
      });
      dlCam.queueEventBackfill(tUpg, 'motion detected', '', 'motion detected', 10, false);
      dlCam.beginSession(STREAM_MODES.DOWNLOAD, tUpg, false);
      dlCam.backfillClipQueue.push(
        Object.freeze({
          storagePath: '/zx/dl1.zxvideo',
          cipherId: 0,
          clipMs: tUpg - 5000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        })
      );
      const dlViewRes = dlCam.applyViewTrigger(tUpg + 20000, 'api-view-wake', 30000, 'api-wake', [dlCam], 15000);
      assert.equal(dlCam.runtimeExtended, false, 'View api-wake during DOWNLOAD must not set runtimeExtended');
      assert.equal(dlCam.hasPendingBackfill(), true, 'View api-wake during DOWNLOAD must preserve pendingBackfill');
      assert.equal(dlCam.backfillClipQueue.length, 1, 'View api-wake during DOWNLOAD must preserve backfillClipQueue');
      assert.equal(dlViewRes.shouldLog, false);
      assert.equal(dlViewRes.message, '');

      // 12. Diagnostic HUD theme (card_theme: "hud") supports all card_position placements like any other theme
      const debugCam = new Camera(
        {
          serial: 'T8161T5555555555',
          name: 'debug_cam',
          mode: 'backfill',
          card_theme: 'hud',
          card_position: 'top-right',
        },
        {frame: Buffer.alloc(FRAME, 0x22), lastSeen: '20:45'},
        renderCameraCards
      );
      assert.equal(debugCam.card.theme, CARD_THEMES.HUD);
      assert.equal(debugCam.hasDynamicDebugCard(), true);
      const bounds = debugCam.getCardBounds();
      assert.ok(bounds);
      assert.ok(bounds.boxW <= Math.floor((1280 * 2) / 3), 'Debug HUD width must be <= 2/3 of frame width');
      assert.deepEqual(
        bounds,
        {boxX: 1280 - 832 - 24, boxY: 24, boxW: 832, boxH: 76},
        'Debug HUD in top-right must use standard 24px corner margins at the top-right of the frame'
      );
      assert.ok(
        debugCam.computeMaskPolygon().includes(','),
        'Debug HUD on perimeter must generate a Frigate motion/object mask polygon'
      );

      const centerHudCam = new Camera({
        serial: 'T8161T5555555556',
        name: 'center_hud_cam',
        card_theme: 'hud',
        card_position: 'center',
      });
      assert.equal(centerHudCam.getCardBounds(), null, 'Centered HUD must not generate a perimeter Frigate mask');
      assert.equal(centerHudCam.computeMaskPolygon(), '');

      debugCam.applyTelemetryProperties(
        {
          state: 1,
          battery: 83,
          chargingStatus: 2,
          wifiSignalLevel: 4,
          wifiRssi: -71,
          batteryTemperature: 21,
          light: true,
          rtspStream: false,
          powerWorkingMode: 2,
          recordingClipLength: 30,
          recordingEndClipMotionStops: true,
          videoStreamingQuality: 7,
        },
        false
      );
      const idleLines = debugCam.buildDebugHudLines(tClip1 + 5000);
      assert.equal(idleLines.length, 4);
      assert.ok(idleLines[0].includes('ST:IDLE -> IDLE'));
      assert.ok(idleLines[1].includes('LIGHT:ON '));
      assert.ok(idleLines[1].includes('HW:M2/030s/EE:Y/Q7/RTSP:N'));

      // Verify BACKFILL_STATES.RECORDING and BACKFILL_STATES.SETTLING map to ACTIVE and WAIT_Q in the Debug HUD
      debugCam.queueEventBackfill(tClip1 + 6000, 'person detected', 'Alice', 'person detected', 200, true);
      const recLines = debugCam.buildDebugHudLines(tClip1 + 6500);
      assert.ok(recLines[0].includes('BF:ACTIVE '), 'BACKFILL_STATES.RECORDING must render as BF:ACTIVE in Debug HUD');
      debugCam.recordMotionCleared(tClip1 + 7000, 4000, 30000, 'person detected');
      const settleLines = debugCam.buildDebugHudLines(tClip1 + 7500);
      assert.ok(
        settleLines[0].includes('BF:WAIT_Q '),
        'BACKFILL_STATES.SETTLING must render as BF:WAIT_Q in Debug HUD'
      );

      // Transition to streaming backfill and verify fixed column layout does not shift horizontally
      debugCam.beginBackfillDownload(
        {
          storagePath: '/zx/debug_clip.zxvideo',
          cipherId: 0,
          clipMs: tClip1,
          event: 'person detected',
          personName: 'Alice',
          reason: 'person detected',
        },
        false,
        tClip1 + 10000
      );
      const liveFrame = Buffer.alloc(FRAME, 0x55);
      debugCam.recordDecodedFrame(liveFrame, liveFrame, tClip1 + 10500, '20:46', 5000);
      assert.equal(
        debugCam.getFrameMarker(),
        FRAME_STAGE_MARKERS.FIRST_BACKFILL,
        'First decoded backfill frame must return FRAME_STAGE_MARKERS.FIRST_BACKFILL (FB)'
      );
      debugCam.markFrameEncoded(liveFrame, tClip1 + 10500);
      debugCam.markFrameEncoded(liveFrame, tClip1 + 10566);
      debugCam.applyTelemetryProperties({light: false, battery: 100}, false);
      const activeLines = debugCam.buildDebugHudLines(tClip1 + 11000);
      assert.equal(activeLines.length, 4);
      assert.ok(
        activeLines[0].includes('BF:PLAYING'),
        'BACKFILL_STATES.PLAYING must render as BF:PLAYING in Debug HUD'
      );
      assert.equal(activeLines[0].length, idleLines[0].length, 'Row 1 must have fixed character width');
      assert.equal(activeLines[1].length, idleLines[1].length, 'Row 2 must have fixed character width');
      assert.equal(activeLines[2].length, idleLines[2].length, 'Row 3 must have fixed character width');
      assert.equal(activeLines[3].length, idleLines[3].length, 'Row 4 must have fixed character width');
      assert.equal(activeLines[0].indexOf('| DEC:'), idleLines[0].indexOf('| DEC:'));
      assert.equal(activeLines[0].indexOf('| BF:'), idleLines[0].indexOf('| BF:'));
      assert.equal(activeLines[0].indexOf('| FPS:'), idleLines[0].indexOf('| FPS:'));
      assert.equal(activeLines[0].indexOf('| WS:'), idleLines[0].indexOf('| WS:'));
      assert.equal(activeLines[0].indexOf('| DROP:'), idleLines[0].indexOf('| DROP:'));
      assert.equal(activeLines[1].indexOf('| BAT:'), idleLines[1].indexOf('| BAT:'));
      assert.equal(activeLines[1].indexOf('| WIFI:'), idleLines[1].indexOf('| WIFI:'));
      assert.equal(activeLines[1].indexOf('| HW:'), idleLines[1].indexOf('| HW:'));
      assert.equal(activeLines[2].indexOf('| HOLD:'), idleLines[2].indexOf('| HOLD:'));
      assert.equal(activeLines[2].indexOf('| TRIG:'), idleLines[2].indexOf('| TRIG:'));
      assert.equal(activeLines[3].indexOf('| BFQ:'), idleLines[3].indexOf('| BFQ:'));
      assert.equal(activeLines[3].indexOf('| CLIP:'), idleLines[3].indexOf('| CLIP:'));
      assert.equal(activeLines[3].indexOf('| INIT:'), idleLines[3].indexOf('| INIT:'));
      // Verify vertical column alignment across all 4 HUD rows (with 2-column spans for ST, EV, WIFI, and BFQ)
      assert.ok(activeLines[0].includes('ST:BF_HSHK -> BF_PLAY'));
      assert.ok(activeLines[0].includes('WS:OK HB:OK FRG:OK RTC:OK'));
      assert.ok(activeLines[2].includes('  Q:00/00'));
      assert.equal(activeLines[0].indexOf('s | DEC:'), activeLines[0].indexOf('| DEC:') - 2);
      assert.equal(activeLines[1].indexOf('| BAT:'), activeLines[2].indexOf('| HOLD:'));
      assert.equal(activeLines[0].indexOf('| DEC:'), activeLines[1].indexOf('| WIFI:'));
      assert.equal(activeLines[0].indexOf('| DEC:'), activeLines[2].indexOf('| IDLE:'));
      assert.equal(activeLines[0].indexOf('| DEC:'), activeLines[3].indexOf('| BFQ:'));
      assert.equal(activeLines[0].indexOf('| BF:'), activeLines[2].indexOf('| VID:'));
      assert.equal(activeLines[0].indexOf('| FPS:'), activeLines[1].indexOf('| TMP:'));
      assert.equal(activeLines[0].indexOf('| FPS:'), activeLines[2].indexOf('| VW:'));
      assert.equal(activeLines[0].indexOf('| FPS:'), activeLines[3].indexOf('| CONT:'));
      assert.equal(activeLines[0].indexOf('| WS:'), activeLines[1].indexOf('| HW:'));
      assert.equal(activeLines[0].indexOf('| WS:'), activeLines[2].indexOf('| TRIG:'));
      assert.equal(activeLines[0].indexOf('| WS:'), activeLines[3].indexOf('| CLIP:'));
      assert.equal(activeLines[0].indexOf('| DROP:'), activeLines[1].indexOf('| SEEN:'));
      assert.equal(activeLines[0].indexOf('| DROP:'), activeLines[2].indexOf('| STOP:'));
      assert.equal(activeLines[0].indexOf('| DROP:'), activeLines[3].indexOf('| INIT:'));
      assert.ok(activeLines[1].includes('LIGHT:OFF'));

      // Service disruption switches WS/HB/FRG/RTC from OK to DN and marks hasServiceDisruption() true
      assert.equal(debugCam.hasServiceDisruption(), false);
      assert.equal(
        debugCam.updateServiceHealth({wsConnected: false, frigateConnected: false, go2rtcConnected: false}),
        true
      );
      assert.equal(debugCam.hasServiceDisruption(), true);
      const downLines = debugCam.buildDebugHudLines(tClip1 + 11000);
      assert.ok(downLines[0].includes('WS:DN HB:OK FRG:DN RTC:DN'));
      assert.equal(downLines[0].length, activeLines[0].length);
      debugCam.updateServiceHealth({wsConnected: true, frigateConnected: true, go2rtcConnected: true});
      assert.equal(debugCam.hasServiceDisruption(), false);

      const overlaidLive = renderLiveFrameWithCard(debugCam, liveFrame, tClip1 + 11000);
      assert.notEqual(overlaidLive, liveFrame, 'Debug HUD must composite onto live frames via scratch buffer');

      // Verify Debug HUD scales elapsed/remaining durations past 999s into minutes (m), hours (h),
      // days (d), weeks (w), and years (y) without shifting any column delimiter
      debugCam.sessionStateChangedAt = tClip1;
      debugCam.motionUntil = tClip1 + 1200000;
      const hud999s = debugCam.buildDebugHudLines(tClip1 + 999000);
      const hud20m = debugCam.buildDebugHudLines(tClip1 + 1200000 - 180000);
      const hud2h = debugCam.buildDebugHudLines(tClip1 + 7200000);
      const hud3d = debugCam.buildDebugHudLines(tClip1 + 259200000);
      const hud2w = debugCam.buildDebugHudLines(tClip1 + 1209600000);
      const hud1y = debugCam.buildDebugHudLines(tClip1 + 31536000000);
      assert.ok(hud999s[0].includes('+999s | DEC:'));
      assert.ok(hud20m[0].includes('+017m | DEC:'));
      assert.ok(hud2h[0].includes('+002h | DEC:'));
      assert.ok(hud3d[0].includes('+003d | DEC:'));
      assert.ok(hud2w[0].includes('+002w | DEC:'));
      assert.ok(hud1y[0].includes('+001y | DEC:'));
      assert.equal(hud20m[0].indexOf('| DEC:'), activeLines[0].indexOf('| DEC:'));
      assert.equal(hud2h[0].indexOf('| DEC:'), activeLines[0].indexOf('| DEC:'));
      assert.equal(hud3d[0].indexOf('| DEC:'), activeLines[0].indexOf('| DEC:'));
      assert.equal(hud2w[0].indexOf('| DEC:'), activeLines[0].indexOf('| DEC:'));
      assert.equal(hud1y[0].indexOf('| DEC:'), activeLines[0].indexOf('| DEC:'));

      // Verify getFrameMarker() returns FRAME_STAGE_MARKERS.SNAPSHOT ('S') while idle, and
      // shouldEnableRtspProperty recovers rtspStream=false on backfill RTSP cameras
      const rtspBackfillCam = new Camera({
        serial: 'T8161T6666666666',
        name: 'garage_rtsp_bf',
        mode: 'backfill',
      });
      assert.equal(rtspBackfillCam.shouldBackfillOnlyOnApiWake(), false);
      assert.equal(rtspBackfillCam.isViewerBlockedByBackfill(), false);
      assert.equal(rtspBackfillCam.isWaitingForBackfill(tClip1), false);
      assert.equal(rtspBackfillCam.isWaitingForSlotOrBackfill(tClip1), false);
      rtspBackfillCam.queueEventBackfill(tClip1, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(rtspBackfillCam.shouldBackfillOnlyOnApiWake(), true);
      assert.equal(rtspBackfillCam.isViewerBlockedByBackfill(), true);
      assert.equal(rtspBackfillCam.isWaitingForBackfill(tClip1), true);
      assert.equal(rtspBackfillCam.isWaitingForSlotOrBackfill(tClip1), true);
      rtspBackfillCam.clearPendingBackfill();
      rtspBackfillCam.activeTriggerEvents.clear();
      assert.equal(
        rtspBackfillCam.getFrameMarker(),
        FRAME_STAGE_MARKERS.SNAPSHOT,
        'Frame marker must be FRAME_STAGE_MARKERS.SNAPSHOT (S) while camera is idle'
      );
      assert.equal(
        rtspBackfillCam.shouldEnableRtspProperty(false),
        true,
        'RTSP-capable camera in backfill mode must re-enable rtspStream=true when ' +
          'eufy-security-ws reports rtspStream=false'
      );
      rtspBackfillCam.beginSession('rtsp', tClip1 + 12000, true);
      assert.equal(
        rtspBackfillCam.gotVideo,
        false,
        'gotVideo remains false while waking before first video frame arrives'
      );
      rtspBackfillCam.markRtspFrameReceived(tClip1 + 13000);
      assert.equal(
        rtspBackfillCam.getFrameMarker(),
        FRAME_STAGE_MARKERS.LIVE,
        'Frame marker is FRAME_STAGE_MARKERS.LIVE (L) once RTSP video frame arrives'
      );

      // Doorbell (T8214) in backfill mode must never enable RTSP, must recover from unexpected
      // RTSP start during P2P wake, and must not be marked offline on watchdog timeout when
      // device telemetry/events arrived in session
      const doorbellBf = new Camera({
        serial: 'T8214T5555555555',
        name: 'doorbell_bf',
        mode: 'backfill',
      });
      assert.equal(doorbellBf.isDoorbell(), true);
      assert.equal(doorbellBf.isRtspCapable(), false);
      assert.equal(doorbellBf.shouldEnableRtspProperty(false), false);
      assert.equal(doorbellBf.shouldDisableRtspProperty(true), true);

      doorbellBf.beginSession('p2p', tClip1 + 14000, true);
      doorbellBf.markDeviceHeardInSession();
      assert.deepEqual(doorbellBf.evaluateUnexpectedRtspStart(), {
        shouldStopRtsp: true,
        shouldDisableRtspProp: true,
        shouldRestartP2p: true,
      });
      // Regression: subsequent 'rtsp livestream started' in the same session must be ignored to prevent restart loops
      assert.deepEqual(doorbellBf.evaluateUnexpectedRtspStart(), {
        shouldStopRtsp: false,
        shouldDisableRtspProp: false,
        shouldRestartP2p: false,
      });
      const termHeard = doorbellBf.terminateSession(
        tClip1 + 45000,
        'camera stopped sending video after 3 retries',
        false,
        'error/watchdog-timeout'
      );
      assert.equal(termHeard.hadUnexpectedRtsp, true);

      // Regression: spurious 'rtsp livestream started' after P2P video has already arrived
      // (gotVideo=true) must be ignored
      doorbellBf.beginSession('p2p', tClip1 + 46000, true);
      doorbellBf.markP2pVideoPacketReceived(tClip1 + 47000);
      assert.deepEqual(
        doorbellBf.evaluateUnexpectedRtspStart(),
        {
          shouldStopRtsp: false,
          shouldDisableRtspProp: false,
          shouldRestartP2p: false,
        },
        'Spurious rtsp livestream started on a doorbell already receiving P2P video must not ' +
          'stop RTSP or set rtspStream=false'
      );
      doorbellBf.endSession(tClip1 + 48000, true, false, 'p2p');
      assert.equal(
        doorbellBf.isDeviceOffline(),
        false,
        'Online camera that sent telemetry or stream events during session must not be marked ' +
          'offline on watchdog timeout'
      );

      // Unresponsive camera that sent zero events during session is still marked offline on watchdog timeout
      doorbellBf.beginSession('p2p', tClip1 + 50000, true);
      doorbellBf.terminateSession(
        tClip1 + 80000,
        'camera stopped sending video after 3 retries',
        false,
        'error/watchdog-timeout'
      );
      assert.equal(doorbellBf.isDeviceOffline(), true);
    }
  );

  it(
    'closes the end-of-hold Frigate poll blind spot, clears expired event cooldowns, and ' +
      'skips no-op hold extensions',
    () => {
      // Regression: (1) expired evUntil from a prior session triggered premature Frigate hold checks in the next
      // session, (2) the 4s Frigate poll cooldown blinded the final <4s of a hold window so active objects were missed
      // at hold expiry, and (3) extendActiveHold reported fake extensions or switched motion holds to viewer holds.
      const t0 = 1794513000000;
      const rtspCam = new Camera({
        serial: 'T8161T0000000091',
        name: 'storage_room',
        mode: 'rtsp',
      });

      // 1. Session 1 files a Frigate event (evUntil = t0 + 62000), then ends after video.
      rtspCam.motionUntil = t0 + 60000;
      rtspCam.lastMotionAt = t0;
      rtspCam.eventActive = true;
      rtspCam.beginSession('rtsp', t0, true);
      rtspCam.gotVideo = true;
      rtspCam.tryUpgradeOrQueueFrigateEvent('motion', '', t0 + 2000);
      rtspCam.beginFrigateSnapshotWait();
      rtspCam.completeFrigateEventFiling(t0 + 2000, 15);
      assert.equal(rtspCam.evUntil, t0 + 62000);
      rtspCam.endSession(t0 + 60000, true, false, 'rtsp');

      // Session 2 starts 30s later (t2 = t0 + 90000) after Session 1's evUntil has elapsed.
      const t2 = t0 + 90000;
      assert.equal(rtspCam.getFrigateEventState(t2), 'idle');
      assert.equal(
        rtspCam.evUntil,
        0,
        'Advancing Frigate event state from COOLDOWN to IDLE must reset expired evUntil to 0'
      );

      rtspCam.motionUntil = t2 + 60000;
      rtspCam.lastMotionAt = t2;
      rtspCam.eventActive = true;
      rtspCam.beginSession('rtsp', t2, true);
      rtspCam.gotVideo = true;
      rtspCam.tryUpgradeOrQueueFrigateEvent('motion', '', t2);
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 3000, 12000, 5000, 4000),
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'New session with 57s hold remaining and pending initial event must not poll Frigate early from a stale evUntil'
      );

      // 2. Final <4s of hold window: polled at t2 + 57000 (3s left), must bypass 4s cooldown once at t2 + 60000 expiry.
      rtspCam.beginFrigateSnapshotWait();
      rtspCam.completeFrigateEventFiling(t2 + 3000, 15);
      assert.deepEqual(rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 57000, 12000, 5000, 4000), {
        shouldPoll: true,
        needsTimeoutExtendCheck: true,
      });
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 58500, 12000, 5000, 4000),
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'Mid-window poll 1.5s later remains throttled while hold has not expired yet'
      );
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 60000, 12000, 5000, 4000),
        {shouldPoll: true, needsTimeoutExtendCheck: true},
        'Hold expiry at t2 + 60000 must run one final Frigate check even if polled 3s earlier (<4s cooldown)'
      );
      const afterExpiryPoll = rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 60500, 12000, 5000, 4000);
      assert.deepEqual(
        afterExpiryPoll,
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'Once the final expiry check ran for holdUntil, it must not re-poll in a loop when holdUntil did not increase'
      );
      assert.equal(Object.isFrozen(afterExpiryPoll), true);

      rtspCam.setExtendCheckInFlight(true);
      assert.equal(rtspCam.isExtendCheckInFlight(), true);
      rtspCam.lastExtendCheckAt = 0;
      assert.deepEqual(
        rtspCam.shouldPollFrigateForHoldOrBackfill(t2 + 60000, 12000, 5000, 4000),
        {shouldPoll: false, needsTimeoutExtendCheck: false},
        'Overlapping Frigate extend checks must be suppressed while extendCheckInFlight is true'
      );
      rtspCam.setExtendCheckInFlight(false);

      // 3. Extending at/just after motionUntil expiry on a motion session must extend motionUntil, not viewUntil.
      const expiryExt = rtspCam.extendActiveHold(t2 + 60050);
      assert.equal(Object.isFrozen(expiryExt), true);
      assert.deepEqual(expiryExt, {extended: true, extendMs: 30000, holdSecs: 30});
      assert.equal(rtspCam.motionUntil, t2 + 90050);
      assert.equal(
        rtspCam.viewUntil,
        0,
        'Expiry-tick hold extension on a motion session must keep extending motionUntil rather than setting viewUntil'
      );

      // 4. Backfill camera (30s base hold) woken for 60s via /api/wake with 54s left must report extended=false.
      const backfillCam = new Camera({
        serial: 'T8161T0000000092',
        name: 'garage_cam',
        mode: 'backfill',
      });
      backfillCam.motionUntil = t0 + 60000;
      backfillCam.lastMotionAt = t0;
      backfillCam.eventActive = true;
      backfillCam.beginSession('rtsp', t0, true);
      backfillCam.queueEventBackfill(t0, 'person detected', '', 'person detected', 100, false);

      const noopExt = backfillCam.extendActiveHold(t0 + 6000);
      assert.equal(Object.isFrozen(noopExt), true);
      assert.deepEqual(
        noopExt,
        {extended: false, extendMs: 0, holdSecs: 54},
        'extendActiveHold must report extended=false and extendMs=0 when wantUntil already exceeds nextUntil'
      );
      assert.equal(backfillCam.runtimeExtended, false);
      assert.equal(
        backfillCam.hasPendingBackfill(),
        true,
        'No-op hold extension must not clear safety-net pendingBackfill'
      );
    }
  );

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

      assert.equal(babyCam.mode, 'rtsp');
      assert.equal(babyCam.isRtspDirect(), true);
      assert.equal(babyCam.isRtspCapable(), true);
      assert.equal(babyCam.getRtspUrl(), 'rtsp://admin:secret@192.168.1.50:554/live0');
      assert.equal(babyCam.getMaskedRtspUrl(), 'rtsp://***@192.168.1.50:554/live0');
      assert.equal(babyCam.needsStartupSnapshot, false);

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
        babyCam.card.asleep,
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
      assert.equal(babyCam.sessionState, SESSION_STATES.STREAMING_LIVE);
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
      assert.equal(timedDirectCam.telemetry.config.enabled, false, 'direct rtsp_url must disable telemetry completely');
      assert.equal(timedDirectCam.telemetry.config.battery, false);
      assert.equal(timedDirectCam.telemetry.config.powerSource, false);
      assert.equal(timedDirectCam.telemetry.config.wifi, false);
      assert.equal(timedDirectCam.telemetry.config.rssi, false);
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
        explicitTelDirectCam.telemetry.config.enabled,
        false,
        'direct rtsp_url must ignore explicit telemetry config'
      );
      assert.equal(explicitTelDirectCam.telemetry.config.battery, false);
      assert.equal(explicitTelDirectCam.telemetry.config.wifi, false);
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
      timedDirectCam.motionClearedAt = t0 + 2000;
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
      const {LUCIDE_ICON_SPRITES} = require('../src/overlay/ui-glyphs');
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
      const unknownBatBuf = Buffer.from(unknownBatGlance.card.asleep);
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
      const knownZeroBatBuf = Buffer.from(knownZeroBatGlance.card.asleep);
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
    'bounds downloadedPaths FIFO history and caps stalled pendingVideoPackets/pendingAudioPackets ' +
      'with HUD DROP counter',
    () => {
      assert.equal(MAX_DOWNLOADED_PATHS_HISTORY, 500);
      assert.equal(MAX_LIVE_PENDING_VIDEO_PACKETS, 150);
      assert.equal(MAX_DOWNLOAD_PENDING_VIDEO_PACKETS, 2400);
      assert.equal(MAX_LIVE_PENDING_AUDIO_PACKETS, 200);

      const bfCam = new Camera({serial: 'T8161T0000000000', name: 'garage', mode: 'backfill'});
      for (let i = 0; i < MAX_DOWNLOADED_PATHS_HISTORY + 5; i++) {
        bfCam.beginBackfillDownload(
          {
            storagePath: '/zx/clip_' + i + '.zxvideo',
            cipherId: 0,
            clipMs: 1000 + i,
            event: 'motion detected',
            personName: '',
            reason: 'motion detected',
          },
          false,
          10000 + i
        );
        bfCam.endSession(10001 + i, true, false, 'download');
      }
      assert.equal(bfCam.downloadedPaths.size, MAX_DOWNLOADED_PATHS_HISTORY);
      assert.equal(bfCam.downloadedPaths.has('/zx/clip_0.zxvideo'), false);
      assert.equal(bfCam.downloadedPaths.has('/zx/clip_4.zxvideo'), false);
      assert.equal(bfCam.downloadedPaths.has('/zx/clip_5.zxvideo'), true);
      assert.equal(bfCam.downloadedPaths.has('/zx/clip_504.zxvideo'), true);

      // Live P2P stalled decoder caps pendingVideoPackets & pendingAudioPackets using
      // drop-oldest policy and increments HUD DROP
      const liveCam = new Camera({serial: 'T8161T1111111111', name: 'patio', mode: 'p2p', card_theme: 'hud'});
      liveCam.beginSession('p2p', 20000, true);
      liveCam.attachDecoder({
        stdin: {writable: true, writableNeedDrain: true, write() {}},
        stdio: [null, null, null, {writable: true, writableNeedDrain: true, write() {}}],
        stdout: {pause() {}, resume() {}},
      });

      for (let i = 0; i < MAX_LIVE_PENDING_VIDEO_PACKETS + 5; i++) {
        liveCam.enqueueOrWriteVideoPacket(Buffer.from([i & 0xff]));
      }
      assert.equal(liveCam.pendingVideoPackets.length, MAX_LIVE_PENDING_VIDEO_PACKETS);
      assert.equal(liveCam.pendingVideoPackets[0][0], 5, 'Drop-oldest policy must evict oldest 5 video packets');
      assert.equal(liveCam.droppedFrames, 5);
      assert.ok(liveCam.buildDebugHudLines(20500)[0].includes('DROP:5'));

      for (let i = 0; i < MAX_LIVE_PENDING_AUDIO_PACKETS + 3; i++) {
        liveCam.enqueueOrWriteAudioPacket(Buffer.from([i & 0xff]), true);
      }
      assert.equal(liveCam.pendingAudioPackets.length, MAX_LIVE_PENDING_AUDIO_PACKETS);
      assert.equal(liveCam.pendingAudioPackets[0][0], 3, 'Drop-oldest policy must evict oldest 3 audio packets');
      assert.equal(liveCam.droppedFrames, 8);
      assert.ok(liveCam.buildDebugHudLines(20600)[0].includes('DROP:8'));

      // Backfill download mode allows up to MAX_DOWNLOAD_PENDING_VIDEO_PACKETS (2400) so full 120s clips never truncate
      bfCam.beginBackfillDownload(
        {
          storagePath: '/zx/long_clip.zxvideo',
          cipherId: 0,
          clipMs: 30000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        30000
      );
      bfCam.attachDecoder({
        stdin: {writable: true, writableNeedDrain: true, write() {}},
        stdio: [null, null, null, {writable: true, writableNeedDrain: true, write() {}}],
        stdout: {pause() {}, resume() {}},
      });
      bfCam.pauseDecoderStdout();
      for (let i = 0; i < 1800; i++) {
        bfCam.enqueueOrWriteVideoPacket(Buffer.from([1]));
      }
      assert.equal(bfCam.pendingVideoPackets.length, 1800);
      assert.equal(bfCam.droppedFrames, 0, '120s backfill clip (1800 frames @ 15 fps) must not drop packets');
    }
  );
});

describe('API Wake Timer Replacement (Camera.scheduleApiWake)', () => {
  it('clears any existing apiWakeTimer before scheduling a replacement wake', async () => {
    const cam = new Camera({serial: 'T8161T6666666666', name: 'wake_timer_cam'});
    let firstFired = 0;
    const secondPayloads = [];
    const now = Date.now();
    cam.scheduleApiWake(30000, 'first wake', false, 15, now, () => {
      firstFired += 1;
    });
    cam.scheduleApiWake(45000, 'second wake', true, 25, now, (pending) => {
      secondPayloads.push(pending);
    });
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(firstFired, 0, 'Prior apiWakeTimer must be cleared before setting replacement timer');
    assert.deepEqual(secondPayloads, [{durationMs: 45000, reason: 'second wake', createEvent: true}]);
  });

  it('masks RTSP URL credentials even when the password contains @ characters', () => {
    const cam = new Camera({serial: 'T8161T6666666667', name: 'masked_rtsp_cam'});
    cam.rtspUrl = 'rtsp://admin:p@ss:123@192.168.1.50:554/live0';
    assert.equal(cam.getMaskedRtspUrl(), 'rtsp://***@192.168.1.50:554/live0');
  });

  it('logs activity cleared before HomeBase backfill settle at debug level rather than info', () => {
    const cam = new Camera({serial: 'T8161T6666666668', name: 'bf_log_cam', mode: 'backfill'});
    cam.queueEventBackfill(100000, 'motion detected', '', 'motion detected', 10, true);
    cam.recordMotionCleared(105000, 4000, 30000, 'motion detected');
    const res = cam.evaluateBackfillAfterMotionCleared('motion detected');
    assert.equal(res.hasPending, true);
    assert.equal(res.isInfo, false, 'Activity cleared for queued backfill must log at debug level, not info');
  });

  it('preserves settled Clip 1 queries, follow-up retry budgets, and frame drains in back-to-back backfill', () => {
    // Regression: when Clip 1 has already cleared and elapsed its 4s settle window (or already matched a clip),
    // a new state=true trigger for Clip 2 must not regress Job 1 back to RECORDING or overwrite Job 2 when
    // starting a queued clip download.
    const cam = new Camera(
      {serial: 'T8214T6666666669', name: 'doorbell_b2b', mode: 'backfill', station_serial: 'T8030P0000000001'},
      {frame: Buffer.alloc(FRAME, 0x22), lastSeen: '10:00'},
      renderCameraCards
    );
    const t0 = 500000;
    cam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    cam.recordMotionCleared(t0 + 10000, 4000, 10000, 'motion detected');
    assert.equal(cam.canQueryBackfill(t0 + 14500, 4000, 4000), true);
    assert.equal(cam.pendingBackfill.state, BACKFILL_STATES.SETTLING);
    assert.equal(cam.pendingBackfill.markReadyToQueryIfSettled(t0 + 14500, 4000), true);
    assert.equal(cam.pendingBackfill.state, BACKFILL_STATES.READY_TO_QUERY);

    // Trailing state=false for another property must not reset clearedAt or regress READY_TO_QUERY back to SETTLING
    cam.recordMotionCleared(t0 + 15000, 4000, 10000, 'person detected');
    assert.equal(cam.pendingBackfill.state, BACKFILL_STATES.READY_TO_QUERY);
    assert.equal(cam.pendingBackfill.clearedAt, t0 + 10000);
    assert.equal(cam.canQueryBackfill(t0 + 15500, 4000, 4000), true);

    // A new trigger arriving after Clip 1 settled (t0 + 16s) keeps Job 1 ready to query Clip 1 while queuing Job 2
    cam.queueEventBackfill(t0 + 16000, 'person detected', 'Alice', 'person detected (Alice)', 300, true);
    assert.equal(
      cam.canQueryBackfill(t0 + 16500, 4000, 4000),
      true,
      'Settled Job 1 must remain ready to query Clip 1 on HomeBase 3 even after Clip 2 trigger starts'
    );
    assert.equal(
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T6666666669',
        storagePath: '/zx/clip2_incomplete.zxvideo',
        cipherId: 2,
        clipMs: t0 + 16000,
      }),
      false,
      'Settled Job 1 must not match Clip 2 while Clip 2 is still actively recording'
    );
    assert.equal(
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T6666666669',
        storagePath: '/zx/clip1_complete.zxvideo',
        cipherId: 1,
        clipMs: t0 + 1000,
      }),
      true
    );

    // Starting Clip 1 promotes Job 1 to activeBackfillJob and shifts Job 2 into pendingBackfill
    cam.beginBackfillDownload(cam.backfillClip, false, t0 + 17000);
    assert.equal(cam.activeBackfillJob?.at, t0);
    assert.equal(cam.pendingBackfill?.at, t0 + 16000);
    assert.equal(cam.pendingBackfill?.recordingActive, true);

    // Clip 2 clears while Clip 1 is playing -> settles and becomes queryable while Clip 1 drains
    cam.recordMotionCleared(t0 + 25000, 4000, 10000, 'person detected');
    assert.equal(cam.pendingBackfill?.recordingActive, false);
    assert.equal(cam.activeBackfillJob?.state, BACKFILL_STATES.DOWNLOADING);

    const frame1 = Buffer.alloc(FRAME, 0x77);
    cam.markP2pVideoPacketReceived(t0 + 17400);
    cam.recordDecodedFrame(frame1, frame1, t0 + 17500, '10:01');
    assert.equal(cam.lastVideoAt, t0 + 17500, 'recordDecodedFrame must update lastVideoAt on Frame 0');
    cam.markDownloadFinished(t0 + 18000);
    cam.detachDecoder();

    // While frameNew is true on an attached writable encoder, isDownloadComplete waits for the final frame write
    cam.attachEncoder({stdin: {writable: true, writableNeedDrain: false, write() {}}}, t0);
    cam.frameNew = true;
    assert.equal(
      cam.isDownloadComplete(t0 + 29500, 3000, 2500, 4500),
      false,
      'Must not complete download before the final decoded frame (frameNew=true) is written to encoder stdin'
    );
    cam.frameNew = false;

    // While pendingVideoPackets remain un-decoded, isDownloadComplete must never complete via idleCompleteMs
    cam.pendingVideoPackets.push(Buffer.from([1, 2, 3]));
    assert.equal(
      cam.isDownloadComplete(t0 + 29500, 3000, 2500, 4500),
      false,
      'Must not complete download while pendingVideoPackets remain queued'
    );
    cam.pendingVideoPackets.length = 0;
    assert.equal(cam.isDownloadComplete(t0 + 29500, 3000, 2500, 4500), true);

    // Ending Clip 1 while Job 2 is waiting to query holds Clip 1's final frame (isStreamingLive=true, marker='B')
    cam.terminateSession(t0 + 29500, 'post-event clip download stream completed', false, 'eufy/download-finished');
    assert.equal(cam.backfillContinuation, true);
    assert.equal(
      cam.isStreamingLive(t0 + 29600, 2000),
      true,
      'Must keep holding Clip 1 final frame while waiting to query/start Clip 2 in back-to-back continuation'
    );
    assert.equal(cam.getFrameMarker(), FRAME_STAGE_MARKERS.BACKFILL);

    // Follow-up split-clip queries must be immediately ready to query (no 4s stall) with a full retry budget
    // (attempts=0) and support 3+ split clips in a long visit
    const splitCam = new Camera({serial: 'T8214T6666666670', name: 'doorbell_split', mode: 'backfill'});
    splitCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    splitCam.queueEventBackfill(t0 + 40000, 'person detected', '', 'person detected', 200, true);
    splitCam.recordMotionCleared(t0 + 45000, 4000, 10000);
    splitCam.canQueryBackfill(t0 + 50000, 4000, 4000);
    splitCam.beginBackfillDatabaseQuery(t0 + 50000);
    splitCam.tryMatchBackfillCandidate({
      devSn: 'T8214T6666666670',
      storagePath: '/zx/split1.zxvideo',
      cipherId: 1,
      clipMs: t0 + 1000,
    });
    splitCam.beginBackfillDownload(splitCam.backfillClip, false, t0 + 51000);
    splitCam.endSession(t0 + 60000, true, false, 'download');
    assert.equal(splitCam.pendingBackfill?.followUpQueried, true);
    assert.equal(
      splitCam.pendingBackfill?.attempts,
      0,
      'prepareFollowUpQuery must reset attempts to 0 so Clip 2 gets a full query retry budget'
    );
    assert.equal(
      splitCam.canQueryBackfill(t0 + 60000, 4000, 4000),
      true,
      'prepareFollowUpQuery must be immediately ready to query at endSession without a redundant 4s delay'
    );
    assert.equal(
      splitCam.tryMatchBackfillCandidate({
        devSn: 'T8214T6666666670',
        storagePath: '/zx/split2.zxvideo',
        cipherId: 2,
        clipMs: t0 + 21000,
      }),
      true
    );
    splitCam.beginBackfillDownload(splitCam.backfillClip, false, t0 + 61000);
    splitCam.endSession(t0 + 70000, true, false, 'download');
    assert.equal(
      splitCam.pendingBackfill?.followUpQueried,
      true,
      'When activity extends >= 15s past Clip 2 as well, a follow-up query for Clip 3 must be scheduled'
    );

    // View max duration and early sleep must never trigger during STREAM_MODES.DOWNLOAD, and Frigate event duration
    // must account for packets already written to decoder stdin
    const p2pDlCam = new Camera({
      serial: 'T8214T6666666671',
      name: 'p2p_dl_cam',
      mode: 'p2p',
      view_linger_secs: 10,
      view_max_secs: 15,
      idle_timeout_secs: 10,
      frigate_event_secs: 20,
    });
    p2pDlCam.beginBackfillDownload(
      {
        storagePath: '/zx/p2p_dl.zxvideo',
        cipherId: 1,
        clipMs: t0,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
      },
      false,
      t0
    );
    p2pDlCam.gotVideo = true;
    p2pDlCam.firstVideoAt = t0 + 500;
    p2pDlCam.downloadVideoPackets = 600;
    p2pDlCam.downloadDecodedFrames = 30;
    p2pDlCam.downloadPlayedFrames = 15;
    p2pDlCam.downloadFrames = new Array(15);
    p2pDlCam.pendingVideoPackets = [];
    assert.equal(
      p2pDlCam.getEffectiveEventDurationSecs(15, t0 + 1500),
      39 + DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
      'getEffectiveEventDurationSecs must account for received downloadVideoPackets already written to dec.stdin'
    );
    assert.equal(
      p2pDlCam.hasReachedViewMaxDuration(t0 + 20000),
      false,
      'view_max_secs must never terminate a backfill download session'
    );
    p2pDlCam.applyMotionTrigger(t0 + 2000, 'motion detected', 60000, 'eufy-event', 10);
    assert.equal(
      p2pDlCam.isMotionOnlyActiveSession(t0 + 15000),
      false,
      'isMotionOnlyActiveSession must be false during backfill download so early-sleep never kills playback'
    );
  });

  it('expires stale Eufy hardware triggers past max clip length and clears them on disconnect or offline', () => {
    // Regression: when a state=false clear event is lost on a backfill camera, activeTriggerEvents previously
    // stayed populated after DOWNLOAD endSession(), sticking hasActiveHardwareTriggers(), /api/wake routing,
    // and subsequent BackfillJob.activeEvents indefinitely.
    const cam = new Camera({serial: 'SN0000000072', name: 'doorbell_stale_trig', mode: 'backfill'});
    const t0 = 1000000;
    cam.lastMotionAt = t0;
    cam.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
    assert.equal(cam.hasActiveHardwareTriggers(t0 + 5000), true);

    // Complete Clip 1 backfill download without ever receiving state=false for 'person detected'
    cam.beginBackfillDatabaseQuery(t0 + 40000);
    cam.tryMatchBackfillCandidate({
      devSn: 'SN0000000072',
      storagePath: '/zx/lost_clear_clip.zxvideo',
      cipherId: 1,
      clipMs: t0 + 1000,
    });
    cam.beginBackfillDownload(cam.backfillClip, false, t0 + 41000);
    cam.endSession(t0 + 55000, true, false, 'download');

    // Within max clip window (120s), un-cleared trigger is still considered active
    assert.equal(cam.hasActiveHardwareTriggers(t0 + 60000), true);

    // Past max clip length + margin (> 130s), stale trigger expires by clock
    const tAfterExpiry = t0 + 131000;
    assert.equal(
      cam.hasActiveHardwareTriggers(tAfterExpiry),
      false,
      'Stale hardware trigger must expire past Eufy max clip length + margin when state=false is lost'
    );
    assert.equal(
      cam.shouldBackfillOnlyOnApiWake(tAfterExpiry),
      false,
      'Expired hardware trigger must not force /api/wake into backfill-only mode'
    );
    assert.equal(
      cam.canPiggybackExternalP2pInBackfill(tAfterExpiry),
      true,
      'Expired hardware trigger must allow external Eufy app P2P piggybacking again'
    );

    // A fresh motion event at t0 + 200s must not inherit the expired 'person detected' in activeEvents
    const tFresh = t0 + 200000;
    cam.lastMotionAt = tFresh;
    cam.queueEventBackfill(tFresh, 'motion detected', '', 'motion detected', 10, true);
    cam.recordMotionCleared(tFresh + 5000, 4000, 10000, 'motion detected');
    assert.equal(
      cam.pendingBackfill?.state,
      BACKFILL_STATES.SETTLING,
      'Clearing the fresh trigger must transition BackfillJob to SETTLING without stalling on expired triggers'
    );
    cam.clearPendingBackfill();

    // Station / WebSocket disconnect clears active hardware triggers immediately
    const tDisc = t0 + 300000;
    cam.lastMotionAt = tDisc;
    cam.queueEventBackfill(tDisc, 'rings', '', 'rings', 1000, true);
    assert.equal(cam.hasActiveHardwareTriggers(tDisc + 1000), true);
    cam.handleStationDisconnected('ws_disconnected');
    assert.equal(
      cam.hasActiveHardwareTriggers(tDisc + 1000),
      false,
      'handleStationDisconnected must clear active hardware triggers on WS/station close'
    );
    cam.clearPendingBackfill();

    // Camera going offline clears active hardware triggers immediately
    const tOff = t0 + 400000;
    cam.lastMotionAt = tOff;
    cam.queueEventBackfill(tOff, 'motion detected', '', 'motion detected', 10, true);
    assert.equal(cam.hasActiveHardwareTriggers(tOff + 1000), true);
    cam.applyTelemetryProperties({battery: 0, chargingStatus: 2}, true, tOff + 2000);
    assert.equal(cam.isDeviceOffline(), true);
    assert.equal(
      cam.hasActiveHardwareTriggers(tOff + 2000),
      false,
      'Device offline transition must clear active hardware triggers'
    );
  });

  it('defers post-backfill live wakes in chronological order across clip drains, PIR upgrades, and disconnects', () => {
    // Regression: same-camera /api/wake during STREAM_MODES.DOWNLOAD was wiped by endSession zeroing motionUntil
    // or decayed while Event 1 drained. Verify full-duration promotion after Event 1 (and any earlier Job 2).
    const cam = new Camera({
      serial: 'T8161T0000000095',
      name: 'garage_seq',
      mode: 'auto',
      station_serial: 'T8030P0000000095',
    });
    cam.updateDiscoveredRtspConfig('T8030P0000000095', 'rtsp://192.0.2.10/live0');

    const t0 = 100000;
    cam.reason = 'event 1 clip';
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/ev1.zxvideo',
        cipherId: 1,
        clipMs: t0 - 15000,
        event: 'motion detected',
        personName: '',
        reason: 'event 1 clip',
      },
      false,
      t0
    );

    // Coalesce view + motion deferred wakes: motion wins createEvent, max duration (25s), and highest priority (250)
    cam.schedulePostBackfillWake(
      WakeRequest.view('viewer peek', 15000).withInitiator('api-wake').withCreateEvent(false).build(),
      t0 + 1000
    );
    const coalescedDur = cam.schedulePostBackfillWake(
      WakeRequest.motion('driveway beam', 25000)
        .withInitiator('api-wake')
        .withPriority(250)
        .withCreateEvent(true)
        .build(),
      t0 + 2000
    );
    assert.equal(coalescedDur, 25000);
    assert.equal(cam.getReason(), 'backfill: event 1 clip', 'Deferred wake must not overwrite active backfill reason');

    // Finish Event 1 40s later (> 25s requested duration): deferred wake starts fresh 25s hold at t0 + 40000!
    cam.endSession(t0 + 40000, true, false, 'download');
    assert.equal(cam.wantsRtspWake(t0 + 40000), true);
    assert.equal(cam.motionUntil, t0 + 65000, 'Deferred wake must grant full 25s duration starting after Event 1 ends');
    assert.equal(cam.getReason(), 'driveway beam');

    // Case 2: /api/wake at t+1s followed by Eufy PIR at t+3s during DOWNLOAD -> absorbed into Job 2 BackfillJob
    const t2 = 300000;
    cam.motionUntil = 0;
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/ev1_b.zxvideo',
        cipherId: 2,
        clipMs: t2 - 15000,
        event: 'motion detected',
        personName: '',
        reason: 'ev1_b',
      },
      false,
      t2
    );
    cam.schedulePostBackfillWake(
      WakeRequest.motion('gate sensor', 30000)
        .withInitiator('api-wake')
        .withPriority(250)
        .withCreateEvent(true)
        .build(),
      t2 + 1000
    );
    cam.queueEventBackfill(t2 + 3000, 'person detected', 'Bob', 'person detected (Bob)', 200, true);
    assert.equal(cam.pendingBackfill?.priority, 250, 'PIR Job 2 absorbs higher priority from preceding deferred wake');
    assert.equal(cam.pendingBackfill?.personName, 'Bob');
    cam.recordMotionCleared(t2 + 8000, 4000, 10000, 'person detected');

    // Case 3: A later /api/wake at t+20s (after Job 2 settled at t+8s) waits behind Job 2 (1 -> 2 -> 3)!
    cam.schedulePostBackfillWake(
      WakeRequest.motion('late sensor', 20000)
        .withInitiator('api-wake')
        .withPriority(250)
        .withCreateEvent(true)
        .build(),
      t2 + 20000
    );
    cam.endSession(t2 + 21000, true, false, 'download');
    assert.equal(
      cam.wantsWake(t2 + 21000),
      false,
      'Event 3 deferred wake must wait behind Event 2 pendingBackfill to preserve 1 -> 2 -> 3 order'
    );
    assert.equal(
      cam.tryMatchBackfillCandidate({
        devSn: 'T8161T0000000095',
        storagePath: '/zx/ev2_b.zxvideo',
        cipherId: 3,
        clipMs: t2 + 3500,
      }),
      true
    );
    cam.beginBackfillDownload(cam.backfillClip, false, t2 + 22000);
    cam.endSession(t2 + 30000, true, false, 'download');
    assert.equal(
      cam.wantsRtspWake(t2 + 30000),
      true,
      'Event 3 deferred wake promotes immediately once Event 2 backfill finishes'
    );
    assert.equal(cam.motionUntil, t2 + 50000);

    // Station disconnect, offline transition, and shutdown clear any pending deferred wake
    cam.motionUntil = 0;
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/ev1_c.zxvideo',
        cipherId: 4,
        clipMs: t2 + 60000,
        event: 'motion detected',
        personName: '',
        reason: 'ev1_c',
      },
      false,
      t2 + 70000
    );
    cam.schedulePostBackfillWake(
      WakeRequest.motion('disc wake', 20000).withInitiator('api-wake').withCreateEvent(true).build(),
      t2 + 71000
    );
    cam.handleStationDisconnected('ws_closed');
    cam.endSession(t2 + 72000, false, false, 'download');
    cam.clearPendingBackfill();
    assert.equal(cam.wantsWake(t2 + 72000), false, 'Station disconnect clears deferred post-backfill wake');

    cam.schedulePostBackfillWake(
      WakeRequest.motion('shutdown wake', 20000).withInitiator('api-wake').withCreateEvent(true).build(),
      t2 + 80000
    );
    cam.prepareForShutdown();
    cam.endSession(t2 + 81000, true, false, 'download');
    assert.equal(cam.wantsWake(t2 + 81000), false, 'Shutdown clears deferred post-backfill wake');
  });

  it('requires decoded Frame 0 before treating backfill downloads as complete or suppressing timeout', () => {
    // Regression: markP2pVideoPacketReceived set gotVideo=true on the first raw compressed packet before FFmpeg's
    // 32 KB probe decoded Frame 0, causing truncated/stalled transfers to bypass hasDownloadTimedOut and finish
    // via isDownloadComplete after 3s without retrying.
    const cam = new Camera({serial: 'T8214T0000000098', name: 'doorbell_probe', mode: 'backfill'});
    const t0 = 500000;
    cam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
    cam.recordMotionCleared(t0 + 4000, 4000, 10000, 'person detected');
    assert.equal(
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000098',
        storagePath: '/zx/truncated.zxvideo',
        cipherId: 9,
        clipMs: t0 + 500,
      }),
      true
    );

    cam.beginBackfillDownload(cam.backfillClip, false, t0 + 10000);
    cam.markP2pVideoPacketReceived(t0 + 10250);
    assert.equal(cam.gotVideo, true);
    assert.equal(cam.hasDecodedFrame(), false);
    assert.equal(
      cam.isDownloadComplete(t0 + 14000, 3000, 2500, 0),
      false,
      'Must not treat raw-packet-only download as complete after 3s idleCompleteMs without Frame 0'
    );
    assert.equal(cam.hasDownloadTimedOut(t0 + 25250, 15000), false);
    assert.equal(
      cam.hasDownloadTimedOut(t0 + 25251, 15000),
      true,
      'Stalled download that never decoded Frame 0 must time out past timeoutMs after last packet'
    );

    // Even if downloadFinished arrives on a corrupt 0-frame clip, completion stays false and termination re-queues it
    cam.markDownloadFinished(t0 + 25251);
    assert.equal(cam.isDownloadComplete(t0 + 30000, 3000, 2500, 0), false);
    const term = cam.terminateSession(
      t0 + 30000,
      'post-event clip download timed out',
      false,
      'eufy/download-finished'
    );
    assert.equal(term.shouldPersistSnapshot, false, 'Must not persist snapshot on a 0-decoded-frame download');
    assert.ok(term.sleepMsg.includes('gotVideo=false'), 'SLEEP log must report gotVideo=false when 0 frames decoded');
    assert.equal(cam.gotVideo, false, 'Failed 0-frame download must clear gotVideo on session end');
    assert.equal(cam.downloadedPaths.has('/zx/truncated.zxvideo'), false);
    assert.equal(cam.backfillClip?.storagePath, '/zx/truncated.zxvideo');
    assert.equal(cam.isReadyForBackfillDownload(t0 + 32000), false);
    assert.equal(cam.isReadyForBackfillDownload(t0 + 34001), true);

    // Retry succeeds once Frame 0 decodes via recordDecodedFrame
    cam.beginBackfillDownload(cam.backfillClip, false, t0 + 34500);
    const frame0 = Buffer.alloc(FRAME, 0x66);
    cam.recordDecodedFrame(frame0, frame0, t0 + 34700, '12:05');
    assert.equal(cam.hasDecodedFrame(), true);
    assert.equal(cam.gotVideo, true);
    cam.frameNew = false;
    cam.markDownloadFinished(t0 + 35000);
    assert.equal(cam.isDownloadComplete(t0 + 38000, 3000, 2500, 0), true);
    const okTerm = cam.terminateSession(
      t0 + 38000,
      'post-event clip download stream completed',
      false,
      'eufy/download-finished'
    );
    assert.ok(okTerm.sleepMsg.includes('gotVideo=true'));
    assert.equal(cam.downloadedPaths.has('/zx/truncated.zxvideo'), true);
    assert.equal(cam.backfillClip, null);
  });

  it('exempts STREAM_MODES.DOWNLOAD clip playback from stream_max_secs duration caps', () => {
    // Regression: hasReachedMaxDuration checked this.active instead of this.isActiveLiveSession(), causing
    // stream_max_secs < 120 to cut off 90s-120s HomeBase clips mid-playback with bridge-max-limit.
    const cam = new Camera({
      serial: 'T8214T0000000099',
      name: 'doorbell_max_secs',
      mode: 'backfill',
      hold_secs: 30,
      stream_max_secs: 60,
    });
    const t0 = 800000;
    cam.beginBackfillDownload(
      {
        storagePath: '/zx/long_clip_120s.zxvideo',
        cipherId: 10,
        clipMs: t0 - 120000,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      },
      false,
      t0
    );
    const frame0 = Buffer.alloc(FRAME, 0x77);
    cam.recordDecodedFrame(frame0, frame0, t0 + 300, '12:10');
    assert.equal(cam.hasReachedMaxDuration(t0 + 60000), false);
    assert.equal(cam.hasReachedMaxDuration(t0 + 119000), false);
    assert.equal(cam.expireMaxDurationHold(t0 + 119000), '');
    cam.endSession(t0 + 122000, true, false, 'download');

    // Live P2P/RTSP sessions on the same camera remain hard-capped at stream_max_secs (60s)
    cam.beginSession('p2p', t0 + 130000, true);
    assert.equal(cam.hasReachedMaxDuration(t0 + 189999), false);
    assert.equal(cam.hasReachedMaxDuration(t0 + 190000), true);
    assert.equal(cam.expireMaxDurationHold(t0 + 190000), 'reached max_secs limit (1m)');
  });

  it('unblocks sibling HomeBase backfill queries and downloads while a camera drains tail frames from RAM', () => {
    // Regression: isBlockingStationBackfill checked usesP2pSlot() instead of isOccupyingStationP2pChannel(),
    // blocking other cameras on the same HomeBase from querying or downloading clips during DRAINING_BACKFILL_TAIL.
    const camA = new Camera({
      serial: 'T8214T0000000101',
      name: 'doorbell_a',
      mode: 'backfill',
      station_serial: 'T8030P0000000050',
    });
    const camB = new Camera({
      serial: 'T8160T0000000102',
      name: 'porch_b',
      mode: 'p2p',
      station_serial: 'T8030P0000000050',
    });
    const allCams = [camA, camB];
    const t0 = 900000;

    camB.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
    camB.recordMotionCleared(t0 + 5000, 4000, 10000, 'person detected');

    // Simulate camA having a recent sleptAt (< 2s ago) before starting its backfill download
    camA.sleptAt = t0 + 19000;
    camA.beginBackfillDownload(
      {
        storagePath: '/zx/cam_a_clip1.zxvideo',
        cipherId: 1,
        clipMs: t0 - 10000,
        event: 'rings',
        personName: '',
        reason: 'rings',
      },
      false,
      t0 + 19500
    );
    const frame0 = Buffer.alloc(FRAME, 0x88);
    camA.recordDecodedFrame(frame0, frame0, t0 + 19700, '12:20');
    camA.bufferDownloadFrame(frame0, 1800);

    // While camA is actively transferring over HomeBase P2P (!downloadFinished), sibling camB is blocked
    assert.equal(camA.isBlockingStationBackfill('T8030P0000000050', t0 + 20000, 2000), true);
    assert.equal(camB.canQueryBackfillNow(allCams, t0 + 20000, 4000, 12000, 2000), false);

    // Once camA reaches DRAINING_BACKFILL_TAIL (downloadFinished=true), HomeBase P2P channel is free for camB
    camA.markDownloadFinished(t0 + 20100);
    assert.equal(camA.sessionState, SESSION_STATES.DRAINING_BACKFILL_TAIL);
    assert.equal(camA.isBlockingStationBackfill('T8030P0000000050', t0 + 20200, 2000), false);
    assert.equal(camB.canQueryBackfillNow(allCams, t0 + 20200, 4000, 12000, 2000), true);

    assert.equal(
      camB.tryMatchBackfillCandidate({
        devSn: 'T8160T0000000102',
        storagePath: '/zx/cam_b_clip1.zxvideo',
        cipherId: 2,
        clipMs: t0 + 1000,
      }),
      true
    );
    assert.equal(camB.canStartBackfillDownloadNow(allCams, t0 + 20300, 2000), true);
    assert.equal(
      camA.canStartBackfillDownloadNow(allCams, t0 + 20300, 2000),
      false,
      'Draining camA itself must not start a second download until its active clip finishes draining'
    );
  });

  it('preserves queuedBackfillJob and active downloads when pendingBackfill expires or exhausts query attempts', () => {
    // Regression: expirePendingBackfillIfNeeded and beginBackfillDatabaseQuery called clearPendingBackfill(),
    // wiping queuedBackfillJob, activeBackfillJob, activeBackfillClip, and backfillClipQueue whenever Job 1
    // yielded no HomeBase clip or expired during active playback.
    const cam = new Camera({
      serial: 'T8214T0000000105',
      name: 'doorbell_queue_keep',
      mode: 'backfill',
      priority: 100,
    });
    const t0 = 1200000;

    // 1. Job 1 settles -> Job 2 arrives into queuedBackfillJob -> /api/wake upgrades queuedBackfillJob ->
    //    Job 1 exhausts all 10 query attempts -> Job 2 promotes into pendingBackfill without losing trigger state
    cam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    cam.recordMotionCleared(t0 + 4000, 4000, 10000, 'motion detected');
    assert.equal(cam.beginBackfillDatabaseQuery(t0 + 9000, 10).allowed, true);

    const tJob2 = t0 + 15000;
    cam.queueEventBackfill(tJob2, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
    assert.ok(cam.queuedBackfillJob, 'Job 2 is isolated in queuedBackfillJob while Job 1 is querying');
    assert.equal(cam.queueOrUpgradeApiWakeBackfill(tJob2 + 500, 'porch doorbell automation', {evPriority: 250}), true);
    assert.equal(cam.queuedBackfillJob?.priority, 350, '/api/wake upgrades queuedBackfillJob priority in place');
    assert.equal(cam.queuedBackfillJob?.reason, 'porch doorbell automation');
    assert.equal(cam.queuedBackfillJob?.personName, 'Alice');

    for (let attempt = 2; attempt <= 10; attempt++) {
      assert.equal(cam.beginBackfillDatabaseQuery(tJob2 + attempt * 12000, 10).allowed, true);
    }
    const exhausted = cam.beginBackfillDatabaseQuery(tJob2 + 132000, 10);
    assert.equal(exhausted.allowed, false);
    assert.equal(
      cam.pendingBackfill?.at,
      tJob2,
      'Exhausting Job 1 query attempts must promote queuedBackfillJob (Job 2) into pendingBackfill'
    );
    assert.equal(cam.queuedBackfillJob, null);
    assert.equal(cam.lastBackfillQueryAt, 0, 'Promoted Job 2 must not inherit a 12s cooldown from exhausted Job 1');
    assert.equal(cam.hasActiveHardwareTriggers(tJob2 + 100000), true);

    // 2. While Clip 1 (activeBackfillJob + activeBackfillClip + queued Clip 1b) is actively playing in DOWNLOAD,
    //    expiring pendingBackfill (Job 2) promotes Job 3 without wiping Clip 1, Clip 1b, or activeBackfillJob
    const tPlay = 2000000;
    cam.clearPendingBackfill();
    cam.queueEventBackfill(tPlay, 'person detected', '', 'person detected', 200, true);
    cam.recordMotionCleared(tPlay + 5000, 4000, 10000, 'person detected');
    assert.equal(
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000105',
        storagePath: '/zx/job1_part1.zxvideo',
        cipherId: 1,
        clipMs: tPlay + 1000,
      }),
      true
    );
    assert.equal(
      cam.tryMatchBackfillCandidate({
        devSn: 'T8214T0000000105',
        storagePath: '/zx/job1_part2.zxvideo',
        cipherId: 2,
        clipMs: tPlay + 20000,
      }),
      true
    );
    const staleJob2 = new BackfillJob({
      name: cam.getName(),
      at: tPlay - 285000,
      lastActivityAt: tPlay - 285000,
      event: 'rings',
      personName: '',
      reason: 'stale job 2',
      priority: 1200,
      attempts: 1,
      recordingActive: false,
      clearedAt: tPlay - 280000,
    });
    cam.queuedBackfillJob = staleJob2;
    cam.beginBackfillDownload(cam.backfillClip, false, tPlay + 10000);
    assert.equal(cam.pendingBackfill, staleJob2);
    assert.equal(cam.backfillClip?.storagePath, '/zx/job1_part2.zxvideo');

    // Queue fresh Job 3 behind staleJob2 while Clip 1 is playing
    const tJob3 = tPlay + 12000;
    cam.queueEventBackfill(tJob3, 'rings', '', 'rings', 1000, true);
    cam.recordMotionCleared(tJob3 + 3000, 4000, 10000, 'rings');
    assert.equal(cam.queuedBackfillJob?.at, tJob3);

    // Advance past staleJob2's 300s max age while Clip 1 is still active -> staleJob2 expires, Job 3 promotes,
    // and activeBackfillJob + activeBackfillClip + backfillClipQueue ('/zx/job1_part2.zxvideo') remain intact!
    const expiredReason = cam.expirePendingBackfillIfNeeded(tPlay + 20000, 4000);
    assert.equal(expiredReason, 'stale job 2');
    assert.ok(cam.activeBackfillJob, 'Active download BackfillJob must remain intact when pendingBackfill expires');
    assert.equal(
      cam.activeBackfillClip?.storagePath,
      '/zx/job1_part1.zxvideo',
      'Active download clip must remain intact so interrupted transfers can still re-queue'
    );
    assert.equal(
      cam.backfillClip?.storagePath,
      '/zx/job1_part2.zxvideo',
      'Remaining matched split clip in backfillClipQueue must remain intact when pendingBackfill expires'
    );
    assert.equal(
      cam.pendingBackfill?.at,
      tJob3,
      'Expiring pendingBackfill must promote queuedBackfillJob (Job 3) into pendingBackfill'
    );
    assert.equal(cam.queuedBackfillJob, null);
  });

  it('paces backfill queries across sibling cameras on the same HomeBase while isolating other stations', () => {
    // Regression: tracking lastBackfillQueryAt only per camera let sibling cameras on the same HomeBase hammer
    // station.connect + database_query_* back-to-back within the 4s cooldown and starved equal-priority siblings.
    const t0 = 5000000;
    const camA = new Camera({
      serial: 'T8214T0000000201',
      name: 'hb1_doorbell',
      mode: 'backfill',
      station_serial: 'T8030P0000000201',
    });
    const camB = new Camera({
      serial: 'T8160T0000000202',
      name: 'hb1_yard',
      mode: 'backfill',
      station_serial: 'T8030P0000000201',
    });
    const camOtherStation = new Camera({
      serial: 'T8160T0000000203',
      name: 'hb2_garage',
      mode: 'backfill',
      station_serial: 'T8030P0000000202',
    });
    const allCams = [camA, camB, camOtherStation];

    for (const c of allCams) {
      c.queueEventBackfill(t0 - 20000, 'person detected', '', 'person detected', 200, true);
      c.recordMotionCleared(t0 - 15000, 4000, 10000, 'person detected');
    }

    assert.equal(camA.canQueryBackfillNow(allCams, t0, 4000, 4000, 2000), true);
    assert.equal(camB.canQueryBackfillNow(allCams, t0, 4000, 4000, 2000), true);

    // camA queries HomeBase 1 at t0
    assert.equal(camA.beginBackfillDatabaseQuery(t0, 10).allowed, true);
    assert.equal(camB.lastBackfillQueryAt, 0);

    // Within 4000ms of camA's query, sibling camB on HomeBase 1 is paced, while HomeBase 2 is unaffected
    assert.equal(
      camB.canQueryBackfillNow(allCams, t0 + 1000, 4000, 4000, 2000),
      false,
      'Sibling camera on same HomeBase must wait for the 4000ms station query cooldown'
    );
    assert.equal(camB.canQueryBackfillNow(allCams, t0 + 3999, 4000, 4000, 2000), false);
    assert.equal(
      camOtherStation.canQueryBackfillNow(allCams, t0 + 1000, 4000, 4000, 2000),
      true,
      'Camera on a different HomeBase station must not be paced by HomeBase 1 query cooldown'
    );

    // At t0 + 4000ms, both camA and camB are eligible again, and equal-priority round-robin picks camB next
    assert.equal(camB.canQueryBackfillNow(allCams, t0 + 4000, 4000, 4000, 2000), true);
    const ordered = [camA, camB].sort(Camera.compareBackfillPriority);
    assert.equal(ordered[0], camB, 'Equal-priority cameras must round-robin by oldest lastBackfillQueryAt');

    // Urgent SIGUSR1 test backfill bypasses sibling query pacing
    camB.prepareSigUsr1BackfillTest(t0 + 4100);
    assert.equal(camA.beginBackfillDatabaseQuery(t0 + 4100, 10).allowed, true);
    assert.equal(camB.canQueryBackfillNow(allCams, t0 + 4200, 4000, 4000, 2000), true);
  });

  it(
    'distinguishes direct RTSP handshake/protocol failures from network unreachability ' +
      'in evaluateRtspDirectDrop()',
    () => {
      // Regression: evaluateRtspDirectDrop() reported "direct RTSP endpoint unreachable (Error opening input files:
      // Invalid data found when processing input)" even when TCP connected and the camera closed or rejected the RTSP
      // handshake; must explain closed/invalid RTSP replies and distinguish handshake rejections from unreachable IPs.
      const cam = new Camera({
        name: 'kids_room_camera',
        mode: 'rtsp',
        rtsp_url: 'rtsp://viewer:secret@192.0.2.77:554/live0',
      });

      // 1. Bare FFmpeg AVERROR_INVALIDDATA on RTSP open (camera accepted TCP then closed/reset before valid RTSP reply)
      cam.beginRtspDirectProbeSession(1000);
      const eofDrop = cam.evaluateRtspDirectDrop(
        1,
        '[in#0 @ 0x55c2] Error opening input: Invalid data found when processing input'
      );
      assert.equal(eofDrop.isReachableStandby, false);
      assert.equal(eofDrop.disruptionChanged, true);
      assert.equal(eofDrop.statusLog.includes('direct RTSP handshake failed'), true);
      assert.equal(eofDrop.statusLog.includes('RTSP server closed connection or sent invalid reply'), true);
      assert.equal(eofDrop.statusLog.includes('endpoint unreachable'), false);
      assert.equal(eofDrop.statusLog.includes('-> Disconnected'), true);

      // 2. Restore connected health, then test explicit RTSP 453 / 401 protocol rejection
      cam.markRtspFrameReceived(2000);
      cam.endSession(3000, true, false, 'rtsp');
      cam.beginRtspDirectProbeSession(8000);
      const protoDrop = cam.evaluateRtspDirectDrop(
        1,
        '[rtsp @ 0x7f12] method DESCRIBE failed: 453 Not Enough Bandwidth'
      );
      assert.equal(protoDrop.isReachableStandby, false);
      assert.equal(protoDrop.disruptionChanged, true);
      assert.equal(
        protoDrop.statusLog,
        'direct RTSP handshake failed ' +
          '([rtsp @ 0x7f12] method DESCRIBE failed: 453 Not Enough Bandwidth) -> Disconnected'
      );

      // 3. Restore connected health, then test genuine network unreachability (Connection refused / timeout)
      cam.markRtspFrameReceived(9000);
      cam.endSession(10000, true, false, 'rtsp');
      cam.beginRtspDirectProbeSession(15000);
      const netDrop = cam.evaluateRtspDirectDrop(
        1,
        '[tcp @ 0x7f12] Connection to tcp://192.0.2.77:554 failed: Connection refused'
      );
      assert.equal(netDrop.isReachableStandby, false);
      assert.equal(netDrop.disruptionChanged, true);
      assert.equal(
        netDrop.statusLog,
        'direct RTSP endpoint unreachable ([tcp @ 0x7f12] Connection to tcp://192.0.2.77:554 failed: Connection refused) -> Disconnected'
      );

      // 4. Standby 404 Not Found transitions back to Asleep
      const standbyDrop = cam.evaluateRtspDirectDrop(1, '[rtsp @ 0x7f12] method DESCRIBE failed: 404 Not Found');
      assert.equal(standbyDrop.isReachableStandby, true);
      assert.equal(standbyDrop.disruptionChanged, true);
      assert.equal(standbyDrop.statusLog, 'direct RTSP endpoint reachable in standby (404 Not Found) -> Asleep');
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
      directCam.wakeInitiator = 'viewer';
      directCam.reason = 'rtsp direct stream';
      directCam.markRtspFrameReceived(t0 + 400);
      directCam.videoCodec = 'h264';
      directCam.videoWidth = 1920;
      directCam.videoHeight = 1080;

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
      eufyCam.evState = 'cooldown';
      eufyCam.evUntil = t0 + 5000;
      assert.equal(eufyCam.sessionState, 'cooldown');
      const postCooldown = eufyCam.toStatusSummary(t0 + 20000);
      assert.equal(postCooldown.session_state, 'idle');
      assert.equal(postCooldown.frigate_event.state, 'idle');
      assert.equal(eufyCam.sessionState, 'cooldown', 'toStatusSummary must not mutate sessionState');
      assert.equal(eufyCam.evState, 'cooldown', 'toStatusSummary must not mutate evState');

      // 5. Encoder hwaccel fallback reporting
      eufyCam.disableHwaccel();
      assert.equal(eufyCam.toStatusSummary(t0 + 20000).encoder.codec, 'libx264');
    }
  );
});
