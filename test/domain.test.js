/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Enterprise unit test suite for domain models: Camera, StatusCard, Telemetry, and BackfillJob.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';
process.env.CACHE_DIR = '/tmp';

const {FRAME} = require('../src/config');
const {Camera} = require('../src/domain/camera');
const {
  BackfillJob,
  BACKFILL_POST_CLEAR_SETTLE_MS,
  BACKFILL_RECORDING_WAIT_CAP_MS,
} = require('../src/domain/backfill-job');
const {prepareBackgroundCanvas} = require('../src/overlay/yuv-canvas');
const {renderCameraCards, renderLiveFrameWithCard} = require('../src/overlay/card-renderer');

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
      rtsp_url: 'rtsp://192.168.1.50/live0',
    });
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

  it('enables rtspStream=true on startup in "rtsp" mode and ignores rtspStreamUrl in "p2p"/"backfill" modes', () => {
    const rtspCam = new Camera({serial: 'T8161T0000000000', mode: 'rtsp'});
    const p2pCam = new Camera({serial: 'T8161T1111111111', mode: 'p2p'});
    const backfillCam = new Camera({serial: 'T8214T2222222222', mode: 'backfill'});

    assert.equal(rtspCam.shouldEnableRtspProperty(false), true);
    assert.equal(rtspCam.shouldEnableRtspProperty(false), false, 'Only checks rtspStream once per session');
    assert.equal(rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live0'), true);
    assert.equal(rtspCam.isRtspCapable(), true);

    assert.equal(p2pCam.shouldEnableRtspProperty(false), false);
    assert.equal(p2pCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live1'), false);
    assert.equal(p2pCam.isRtspCapable(), false);
    assert.equal(p2pCam.stationSerial, 'T8030T0000000000');

    assert.equal(backfillCam.shouldEnableRtspProperty(false), false);
    assert.equal(backfillCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live2'), false);
    assert.equal(backfillCam.isRtspCapable(), false);
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
    p2pCam.applyMotionTrigger(
      t0 + 4000,
      'identity person detected (Alice)',
      60000,
      'eufy-event',
      300,
      3000,
      5000,
      3000
    );
    assert.ok(p2pCam.pendingBackfill instanceof BackfillJob);
    assert.equal(p2pCam.pendingBackfill.event, 'identity person detected');
    assert.equal(p2pCam.pendingBackfill.personName, 'Alice');

    // Once >= 5s of live video is decoded, subsequent extension clears pendingBackfill
    p2pCam.gotVideo = true;
    p2pCam.firstFrameAt = t0 + 1000;
    p2pCam.firstVideoAt = t0 + 1000;
    p2pCam.applyMotionTrigger(
      t0 + 7000,
      'person detected',
      60000,
      'eufy-event',
      200,
      3000,
      5000,
      3000
    );
    assert.equal(p2pCam.pendingBackfill, null);
  });

  it('honors per-camera trigger_events, backfill_downloads, low_battery_threshold, and low_battery_wake_on_view', () => {
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
      backfill_downloads: false,
      low_battery_threshold: 0,
      low_battery_wake_on_view: true,
    });

    assert.equal(doorbellCam.shouldTriggerOnEvent('rings'), true);
    assert.equal(doorbellCam.shouldTriggerOnEvent('person detected'), true);
    assert.equal(doorbellCam.shouldTriggerOnEvent('motion detected'), false);
    assert.equal(standaloneCam.shouldTriggerOnEvent('motion detected'), true);

    // Per-camera backfill_downloads=false prevents queuing BackfillJob on standalone camera
    standaloneCam.queueEventBackfill(10000, 'motion detected', '', 'motion detected', 10, true);
    assert.equal(standaloneCam.pendingBackfill, null);

    // Per-camera low_battery_threshold=35 triggers low-battery mode at 30% on doorbellCam, while threshold=0 disables it on standaloneCam
    doorbellCam.telemetry.applyProperties({battery: 30, chargingStatus: 2});
    standaloneCam.telemetry.applyProperties({battery: 10, chargingStatus: 2});

    assert.equal(doorbellCam.isLowBattery(), true);
    assert.equal(doorbellCam.canWakeOnViewerInLowBattery(), false);
    assert.equal(standaloneCam.isLowBattery(), false);
    assert.equal(standaloneCam.canWakeOnViewerInLowBattery(), true);
  });

  it('prevents RTSP re-wake loops during post-viewer linger and yields lingering station streams on viewer switch', () => {
    const cam1 = new Camera({
      serial: 'T8161T0000000000',
      station_serial: 'T8030T9999999999',
      mode: 'rtsp',
      rtsp_url: 'rtsp://10.0.0.1/live0',
    });
    const cam2 = new Camera({
      serial: 'T8161T1111111111',
      station_serial: 'T8030T9999999999',
      mode: 'rtsp',
      rtsp_url: 'rtsp://10.0.0.1/live1',
    });
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
    assert.equal(
      cam1.shouldYieldToNewStationViewer(cam2, t0 + 15000),
      true,
      'Lingering RTSP camera with 0 viewers on same station must yield when user opens cam2'
    );
    assert.equal(
      doorbell.shouldYieldToNewStationViewer(cam2, t0 + 15000),
      true,
      'Lingering P2P camera with 0 viewers on same station must yield when user opens cam2'
    );

    cam1.motionUntil = t0 + 60000;
    assert.equal(
      cam1.shouldYieldToNewStationViewer(cam2, t0 + 15000),
      false,
      'Camera with active motion must never yield to viewer switch'
    );
  });
});

describe('StatusCard Domain Model & Frigate Polygon Masks', () => {
  it('computes corner bounding boxes and normalized Frigate polygon masks for icons, minimal, and detailed themes', () => {
    const iconsCam = new Camera({serial: 'T8161T0000000000', card_theme: 'icons', card_position: 'top-left'});
    const detailedCam = new Camera({serial: 'T8161T1111111111', card_theme: 'detailed', card_position: 'bottom-right'});
    const centerCam = new Camera({serial: 'T8161T2222222222', card_theme: 'detailed', card_position: 'center'});

    assert.equal(iconsCam.card.needsDetailedLiveCard(), false);
    assert.equal(detailedCam.card.needsDetailedLiveCard(), true);
    assert.equal(centerCam.card.needsDetailedLiveCard(), false);

    const iconsPoly = iconsCam.computeMaskPolygon();
    assert.match(iconsPoly, /^0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3}$/);

    const detailedBounds = detailedCam.getCardBounds();
    assert.ok(detailedBounds && detailedBounds.boxW >= 400 && detailedBounds.boxH >= 48);
    assert.equal(centerCam.computeMaskPolygon(), '');
  });

  it('respects sleep_screen ("snapshot", "slate", "black") for startup snapshot probing and YUV canvas rendering', () => {
    const snapCamNoCache = new Camera({serial: 'T8161T0000000000', sleep_screen: 'snapshot'}, {frame: null, lastSeen: ''});
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
  });

  it('renders asleep, waking, busy, and live overlay frames across "icons", "minimal", and "none" themes', () => {
    const rawFrame = Buffer.alloc(FRAME, 0x40);
    const iconsCam = new Camera(
      {serial: 'T8161T0000000000', card_theme: 'icons', card_position: 'top-left', sleep_screen: 'snapshot'},
      {frame: rawFrame, lastSeen: '14:30'},
      renderCameraCards
    );
    const minimalCam = new Camera(
      {serial: 'T8161T1111111111', card_theme: 'minimal', card_position: 'bottom-left', sleep_screen: 'slate'},
      {frame: null, lastSeen: '14:30'},
      renderCameraCards
    );
    const noneCam = new Camera(
      {serial: 'T8161T2222222222', card_theme: 'none', sleep_screen: 'black'},
      {frame: rawFrame, lastSeen: '14:30'},
      renderCameraCards
    );

    assert.equal(iconsCam.card.asleep.length, FRAME);
    assert.equal(minimalCam.card.asleep.length, FRAME);
    assert.equal(noneCam.card.asleep.length, FRAME);
    assert.equal(noneCam.card.asleep[0], 0x10);

    const liveIcons = renderLiveFrameWithCard(iconsCam, rawFrame);
    assert.notEqual(liveIcons, rawFrame, 'Corner card must composite onto scratch buffer without mutating rawFrame');
    assert.equal(rawFrame[0], 0x40);

    const liveNone = renderLiveFrameWithCard(noneCam, rawFrame);
    assert.equal(liveNone, rawFrame, '"none" theme must return rawFrame directly');
  });
});

describe('BackfillJob Event-End Aware Settlement & Clip Matching', () => {
  it('waits for state=false + 2s settle (or 25s cap) when recordingActive=true', () => {
    const doorbellCam = new Camera({
      serial: 'T8214T2222222222',
      mode: 'backfill',
    });

    const t0 = 1000000;
    doorbellCam.queueEventBackfill(t0, 'motion detected', '', 'motion detected', 10, true);
    assert.equal(doorbellCam.canQueryBackfill(t0 + 10000, 8000, 12000), false);
    assert.equal(doorbellCam.canQueryBackfill(t0 + BACKFILL_RECORDING_WAIT_CAP_MS + 50, 8000, 12000), true);

    const tClear = t0 + 11000;
    doorbellCam.recordMotionCleared(tClear, 5000, 10000);
    assert.equal(doorbellCam.canQueryBackfill(tClear + 1000, 8000, 12000), false);
    assert.equal(doorbellCam.canQueryBackfill(tClear + BACKFILL_POST_CLEAR_SETTLE_MS + 50, 8000, 12000), true);
  });
});
