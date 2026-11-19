/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for fixed-width diagnostic HUD formatting and camera state enums
 * (src/domain/camera/debug-hud.js, states.js).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');
const {FRAME, CARD_THEMES, FRAME_STAGE_MARKERS} = require('../../../src/config');
const {Camera, SESSION_STATES} = require('../../../src/domain/camera');
const {renderCameraCards, renderLiveFrameWithCard} = require('../../../src/overlay/card-renderer');

describe('Camera Diagnostic HUD Layout & Doorbell Unexpected RTSP Recovery', () => {
  it(
    'renders fixed-width diagnostic HUD rows across positions and duration scales and ' +
      'guards unexpected doorbell RTSP',
    () => {
      // Verify: renders fixed-width diagnostic HUD rows across positions and duration scales and guards unexpected
      // doorbell RTSP.
      const tClip1 = 2000000;
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
      assert.equal(debugCam.getCardTheme(), CARD_THEMES.HUD);
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
      debugCam.transitionTo(SESSION_STATES.DRAINING_BACKFILL_TAIL, tClip1);
      debugCam.setMotionUntil(tClip1 + 1200000);
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
      rtspBackfillCam.clearActiveTriggerEvents();
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
        rtspBackfillCam.hasGotVideo(),
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
});

describe('Camera State Enums & Debug HUD Modules (src/domain/camera/)', () => {
  it('shares the session, Frigate event, and decoder state enums from camera/states.js', () => {
    // Verify: the finite-state enums and transition maps live in their own module and camera.js re-exports the
    // identical frozen objects, so every existing import keeps working.
    const states = require('../../../src/domain/camera/states');
    const cameraModule = require('../../../src/domain/camera');
    for (const name of [
      'SESSION_STATES',
      'ALLOWED_SESSION_TRANSITIONS',
      'canTransitionSession',
      'FRIGATE_EVENT_STATES',
      'DECODER_STATES',
    ]) {
      assert.ok(states[name], name + ' must be exported by camera/states.js');
      assert.equal(cameraModule[name], states[name], name + ' must be re-exported unchanged by camera.js');
    }
    assert.ok(Object.isFrozen(states.FRIGATE_EVENT_STATES));
    assert.ok(Object.isFrozen(states.DECODER_STATES));
  });

  it('formats the four fixed-width debug HUD rows from a plain snapshot without touching the Camera', () => {
    // Verify: the HUD formatter is a pure function of a frozen snapshot, and Camera.buildDebugHudLines() returns
    // exactly its output (rows keep their fixed 108-character layout).
    const {buildDebugHudLines} = require('../../../src/domain/camera/debug-hud');
    const hudCam = new Camera({serial: 'T8161T0000000042', name: 'hud_golden_cam'});
    const now = 1000000;
    const idleRows = [
      'ST:IDLE -> IDLE        +000s | DEC:DETACH | BF:IDLE    | FPS:15/15 | WS:OK HB:OK FRG:OK RTC:OK | DROP:0 RST:0 ',
      'LIGHT:OFF     | BAT:---% BAT | WIFI:-/4 ----dBm IDLE:0 | TMP:--C   | HW:M2/060s/EE:N/Q-/RTSP:N | SEEN:----    ',
      'SES:NONE R:00 | HOLD:---     | IDLE:---   | VID:---    | VW:0/0    | TRIG:CLEAR  ---   Q:00/00 | STOP:N       ',
      'EV:IDLE   --- /------        | BFQ:---  TRY:0/10 Q:0   | CONT:N    | CLIP:0000/0000f           | INIT:none    ',
    ];

    const snapshot = hudCam.getDebugHudSnapshot(now);
    assert.ok(Object.isFrozen(snapshot), 'HUD snapshot must be an immutable plain object');
    assert.deepEqual([...buildDebugHudLines(snapshot, now)], idleRows);
    assert.deepEqual([...hudCam.buildDebugHudLines(now)], idleRows);

    const busyRows = buildDebugHudLines({...snapshot, droppedFrames: 5, restarts: 3, rtspEnabled: true}, now);
    assert.ok(Object.isFrozen(busyRows));
    assert.ok(busyRows[0].endsWith('| DROP:5 RST:3 '));
    assert.ok(busyRows[1].includes('/RTSP:Y |'));
    assert.ok(busyRows[2].startsWith('SES:NONE R:03 |'));
    assert.deepEqual([...buildDebugHudLines(snapshot, now)], idleRows, 'formatting must not mutate the snapshot');
  });
});
