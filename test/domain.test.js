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
const {
  DOWNLOAD_EVENT_DURATION_MARGIN_SECS,
  Camera,
} = require('../src/domain/camera');
const {
  BackfillJob,
  BACKFILL_POST_CLEAR_SETTLE_MS,
  BACKFILL_RECORDING_WAIT_CAP_MS,
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
    const liveIconsNext = renderLiveFrameWithCard(iconsCam, rawFrame);
    assert.notEqual(
      liveIconsNext,
      liveIcons,
      'Consecutive live overlay renders must alternate double buffers so in-flight encoder pipe writes never tear'
    );

    const liveNone = renderLiveFrameWithCard(noneCam, rawFrame);
    assert.equal(liveNone, rawFrame, '"none" theme must return rawFrame directly');
  });
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

  it('schedules a follow-up query for split clips and enforces frame-drain, decoder flush, and post-playback hold', () => {
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
    doorbellCam.beginBackfillDownload(doorbellCam.backfillClip, false, t0 + 27000);

    // Burst-downloaded audio chunks are preserved up to maxDownloadBytes instead of being capped at 1s
    doorbellCam.appendAudioChunk(Buffer.alloc(32000), 32000, 32000 * 120);
    doorbellCam.appendAudioChunk(Buffer.alloc(32000), 32000, 32000 * 120);
    assert.equal(doorbellCam.pcmLen, 64000);

    // Frame 0 committed -> advances to Frame 1 on the very next 15 fps tick once encoded (zero still-frame hold)
    const dummyFrame1 = Buffer.alloc(FRAME, 0x30);
    const dummyFrame2 = Buffer.alloc(FRAME, 0x50);
    const tFirstFrame = t0 + 27100;
    assert.equal(doorbellCam.bufferDownloadFrame(dummyFrame1, 900), false);
    doorbellCam.recordDecodedFrame(dummyFrame1, dummyFrame1, tFirstFrame, '17:10', 5000);
    assert.equal(doorbellCam.firstFrameAt, tFirstFrame);
    assert.equal(doorbellCam.bufferDownloadFrame(dummyFrame2, 900), true);
    assert.equal(doorbellCam.canAdvanceDownloadFrame(tFirstFrame + 100, 62), false, 'Must not overwrite un-encoded Frame 0');

    doorbellCam.markFrameEncoded(dummyFrame1, tFirstFrame);
    const tNextTick = tFirstFrame + 62;
    assert.equal(
      doorbellCam.canAdvanceDownloadFrame(tNextTick, 62),
      true,
      'Must advance immediately to Frame 1 on the next 15 fps tick without holding still frames'
    );
    const silenceBuf = Buffer.alloc(3200, 0);
    assert.notEqual(doorbellCam.consumeAudioChunk(3200, silenceBuf), silenceBuf);
    doorbellCam.consumeNextDownloadFrame(tNextTick, 62, '17:10');
    doorbellCam.markFrameEncoded(dummyFrame2, tNextTick + 10);
    doorbellCam.gotVideo = true;

    // Mark download finished while decoder process is still attached -> waits for EOF flush settle and 2.5s post-playback hold
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

    // Scales Frigate event duration with DOWNLOAD_EVENT_DURATION_MARGIN_SECS (8s) for backfill downloads
    doorbellCam.downloadFrames = new Array(600);
    doorbellCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', tNextTick + 500);
    const filed = doorbellCam.completeFrigateEventFiling(tNextTick + 1000, 15);
    assert.equal(filed.durationSecs, 41 + DOWNLOAD_EVENT_DURATION_MARGIN_SECS);
    doorbellCam.downloadFrames = [];

    // Ending session promotes activeBackfillJob to a follow-up query because activity spanned 21s past clip1
    doorbellCam.endSession(tNextTick + 3000);
    assert.ok(doorbellCam.pendingBackfill instanceof BackfillJob);
    assert.equal(doorbellCam.pendingBackfill.followUpQueried, true);
  });

  it('streams backfill clips from Frame 0 at 15 fps without encoding old snapshots, freezing still frames, or filing Frigate events before pipeline transit', () => {
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
      'Automatic Frigate UI consumer joining during backfill download must be classified as "joined while live", not an active viewer wake'
    );
    assert.equal(
      doorbellCam.isInKeyframeBurst(tWake + 50),
      false,
      'Must NOT trigger a 15 fps keyframe burst of old card.asleep before Frame 0 is decoded'
    );

    // Even after the first raw H.264 network packet arrives (gotVideo=true), isStreamingLive must remain false until Frame 0 is decoded
    doorbellCam.markP2pVideoPacketReceived(tWake + 200);
    assert.equal(doorbellCam.gotVideo, true);
    assert.equal(
      doorbellCam.isStreamingLive(tWake + 200, 2000),
      false,
      'Must NOT treat previous session lastFrame as live video before Frame 0 is decoded'
    );
    pushFrameToEncoder(doorbellCam, tWake + 100);
    pushFrameToEncoder(doorbellCam, tWake + 250);
    assert.equal(
      writtenFrames.length,
      0,
      'Encoder stdin must remain completely quiet during backfill handshake before Frame 0 is decoded so zero old snapshot frames queue ahead of Frame 0'
    );

    const requiredDelayMs = computeRequiredSnapshotDelay('download');
    assert.equal(
      requiredDelayMs,
      BACKFILL_SNAP_DELAY_MS,
      'Backfill download must wait BACKFILL_SNAP_DELAY_MS for Frame 0 to traverse h264_vaapi -> go2rtc -> Frigate before creating the Frigate event'
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
    assert.equal(writtenFrames[0][0], 0x80, 'First encoded frame of backfill must be Frame 0, never oldSnapshot or card.asleep');

    // Phase 3: Continuous 15 fps advancement (Frame 0 -> Frame 1 -> Frame 2 with zero still-frame freeze)
    const tTick1 = tFrame0 + 62;
    pushFrameToEncoder(doorbellCam, tTick1);
    assert.equal(writtenFrames.length, 2);
    assert.equal(doorbellCam.lastSent, frame1);
    assert.equal(writtenFrames[1][0], 0x81, 'Tick 1 (62ms) must advance immediately to Frame 1 without freezing Frame 0');

    const tTick2 = tTick1 + 62;
    pushFrameToEncoder(doorbellCam, tTick2);
    assert.equal(writtenFrames.length, 3);
    assert.equal(doorbellCam.lastSent, frame2);
    assert.equal(writtenFrames[2][0], 0x82, 'Tick 2 (124ms) must advance immediately to Frame 2');

    // Phase 4: Frigate event waits for pipeline transit (BACKFILL_SNAP_DELAY_MS) after firstFrameAt
    assert.equal(
      doorbellCam.isReadyForEventSnapshot(tFrame0 + 200, requiredDelayMs, 1500, 5000),
      false,
      'Must wait while Frame 0 is still in flight through h264_vaapi -> go2rtc -> Frigate'
    );
    assert.equal(
      doorbellCam.isReadyForEventSnapshot(tFrame0 + BACKFILL_SNAP_DELAY_MS, requiredDelayMs, 1500, 5000),
      true,
      'Becomes ready to create Frigate event once Frame 0 has reached Frigate'
    );
  });
});
