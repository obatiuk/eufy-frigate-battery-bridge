/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-18`: 6-Color Status Palette, Debug HUD Service Statuses, Frame Pacing, Snapshot
 * Isolation & `hwaccel` Fallback (docs/acceptance/AT-18.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-18.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {resolveCardConfig} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {evaluateTelemetryState} = require('../../src/domain/telemetry');
const {renderCameraCards, renderLiveFrameWithCard} = require('../../src/overlay/card-renderer');
const {selectEncoderFrame, shouldWriteEncoderFrame} = require('../../src/media/encoder');

describe('Locked Acceptance Criterion AT-18 (docs/acceptance/AT-18.md)', () => {
  it(
    'AT-18: Enforces 6-color status palette (White Asleep vs Grey Disconnected), Debug HUD service statuses ' +
      '(WS/HB/FRG/RTC), 5 fps / 15 fps pacing, and startup snapshot probe eligibility',
    () => {
      const rawFrame = Buffer.alloc(1382400, 0x42);
      for (const theme of ['glance', 'minimal', 'pebbles', 'hud', 'none']) {
        const cardCfg = resolveCardConfig({
          card_theme: theme,
          card_position: 'bottom-left',
          sleep_screen: 'snapshot',
        });
        assert.equal(cardCfg.theme, theme);
      }

      // 1. 6-color semantic status palette: White (Asleep / Asleep Low Battery sleep-ready, battery > 30%),
      //    Grey (Disconnected), Yellow (Waiting & Low Battery 6..30%), Blue (Waking), Red (Live/Backfill),
      //    Purple (Critical Battery <= 5% & Hot temp)
      const healthyAsleep = evaluateTelemetryState('Asleep', {});
      assert.equal(healthyAsleep.statusKind, 'asleep');
      assert.deepEqual(healthyAsleep.statusRgb, [255, 255, 255]);

      const disruptedAsleep = evaluateTelemetryState('Asleep', {serviceDisrupted: true});
      assert.equal(disruptedAsleep.statusKind, 'disconnected');
      assert.deepEqual(disruptedAsleep.statusRgb, [180, 180, 190]);

      const explicitDisconnected = evaluateTelemetryState('Disconnected', {});
      assert.equal(explicitDisconnected.statusKind, 'disconnected');
      assert.deepEqual(explicitDisconnected.statusRgb, [180, 180, 190]);

      const lowBatAsleep = evaluateTelemetryState('Asleep (Low Battery)', {
        battery: 30,
        charging: false,
        economyMode: true,
      });
      assert.deepEqual(lowBatAsleep.statusRgb, [255, 255, 255]);
      assert.deepEqual(lowBatAsleep.batRgb, [250, 204, 21]);
      assert.deepEqual(evaluateTelemetryState('Asleep', {battery: 6, charging: false}).batRgb, [250, 204, 21]);
      assert.deepEqual(evaluateTelemetryState('Asleep', {battery: 5, charging: false}).batRgb, [232, 121, 249]);
      assert.deepEqual(evaluateTelemetryState('Asleep', {battery: 31, charging: false}).batRgb, [255, 255, 255]);
      assert.deepEqual(evaluateTelemetryState('Waiting', {}).statusRgb, [250, 204, 21]);
      assert.deepEqual(evaluateTelemetryState('Waking Up...', {}).statusRgb, [56, 189, 248]);
      assert.deepEqual(evaluateTelemetryState('Live', {}).statusRgb, [239, 68, 68]);
      assert.deepEqual(evaluateTelemetryState('Backfill', {}).statusRgb, [239, 68, 68]);
      const unknownBadgeCam = new Camera(
        {
          serial: 'T8214T0000000038',
          name: 'unknown_bat_with_badge',
          card_theme: 'glance',
          card_position: 'top-left',
          telemetry: {battery: true, power_source: false, wifi: true},
        },
        {frame: rawFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      const knownZeroBatCam = new Camera(
        {
          serial: 'T8214T0000000039',
          name: 'known_zero_bat_no_badge',
          card_theme: 'glance',
          card_position: 'top-left',
          telemetry: {battery: true, power_source: false, wifi: true},
        },
        {frame: rawFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      knownZeroBatCam.applyTelemetryProperties({battery: 0, chargingStatus: 2});
      renderCameraCards(knownZeroBatCam);
      let badgeDiffPixels = 0;
      for (let py = 33; py < 48; py++) {
        for (let px = 92; px < 107; px++) {
          if (
            unknownBadgeCam.getAsleepCardBuffer()[py * 1280 + px] !==
            knownZeroBatCam.getAsleepCardBuffer()[py * 1280 + px]
          ) {
            badgeDiffPixels++;
          }
        }
      }
      assert.ok(
        badgeDiffPixels > 10,
        'AT-18: Unavailable battery (!hasBat) must render the top-right 15x15 question mark (?) ' +
          'badge on the battery icon'
      );

      const cam = new Camera(
        {
          serial: 'T8214T0000000032',
          name: 'doorbell',
          mode: 'backfill',
          card_theme: 'glance',
          card_position: 'bottom-left',
          card_show_on_live: true,
          sleep_screen: 'snapshot',
        },
        {frame: rawFrame, lastSeen: '12:00'},
        renderCameraCards
      );

      // 2. Debug HUD Row 1 Col 6 displays WS:OK HB:OK FRG:OK RTC:OK and Row 3 Col 6 displays TRIG:...  Q:00/00
      const hudLinesOk = cam.buildDebugHudLines(1000);
      assert.ok(hudLinesOk[0].includes('WS:OK HB:OK FRG:OK RTC:OK'));
      assert.ok(hudLinesOk[2].includes('  Q:00/00'));
      cam.updateServiceHealth({wsConnected: false, frigateConnected: false});
      const hudLinesDn = cam.buildDebugHudLines(1000);
      assert.ok(hudLinesDn[0].includes('WS:DN HB:OK FRG:DN RTC:OK'));
      cam.updateServiceHealth({wsConnected: true, frigateConnected: true});

      // Verify "hud" supports all 7 card_position placements identically to other themes
      const hudTopLeftCam = new Camera({serial: 'T8214T0000000040', card_theme: 'hud', card_position: 'top-left'});
      const hudBottomRightCam = new Camera({
        serial: 'T8214T0000000041',
        card_theme: 'hud',
        card_position: 'bottom-right',
      });
      const hudCenterCam = new Camera({serial: 'T8214T0000000042', card_theme: 'hud', card_position: 'center'});
      assert.deepEqual(hudTopLeftCam.getCardBounds(), {boxX: 24, boxY: 24, boxW: 832, boxH: 76});
      assert.deepEqual(hudBottomRightCam.getCardBounds(), {boxX: 424, boxY: 620, boxW: 832, boxH: 76});
      assert.equal(hudCenterCam.getCardBounds(), null);

      // 3. Live vs Backfill vs Waiting (Yellow) vs Asleep (Green) overlay distinction without mutating rawFrame
      cam.setSessionActive(true);
      cam.setActiveMode('p2p');
      const liveOut = Buffer.from(renderLiveFrameWithCard(cam, rawFrame));
      cam.setActiveMode('download');
      const bfOut = Buffer.from(renderLiveFrameWithCard(cam, rawFrame));
      assert.equal(liveOut.equals(bfOut), false);
      assert.equal(rawFrame[0], 0x42);

      cam.setSessionActive(false);
      cam.setActiveMode('');
      assert.equal(selectEncoderFrame(cam, 1000).frame, cam.getAsleepCardBuffer());
      cam.queueEventBackfill(1000, 'motion detected', '', 'motion detected', 10, true);
      assert.equal(
        selectEncoderFrame(cam, 1500).frame,
        cam.getBusyCardBuffer(),
        'AT-18: IDLE camera with pending BackfillJob must select Yellow Waiting (card.busy) frame'
      );
      cam.beginBackfillDownload(
        {
          storagePath: '/zx/bf_handshake.zxvideo',
          cipherId: 0,
          clipMs: 1000,
          event: 'motion detected',
          personName: '',
          reason: 'motion detected',
        },
        false,
        2000
      );
      assert.equal(
        selectEncoderFrame(cam, 2100).frame,
        cam.getBusyCardBuffer(),
        'AT-18: HANDSHAKING_BACKFILL before Frame 0 decodes must select Yellow Waiting (card.busy) frame'
      );
      cam.endSession(3000);
      cam.clearPendingBackfill();

      // 4. 5 fps (200ms) idle throttling vs 15 fps (66ms) live frame pacing
      const t0 = 100000;
      cam.setLastWriteAt(t0);
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + 66), false);
      assert.equal(shouldWriteEncoderFrame(cam, false, false, false, t0 + 200), true);
      cam.setFrameNew(true);
      assert.equal(shouldWriteEncoderFrame(cam, true, false, false, t0 + 66), true);

      // 5. Per-camera timestamped snapshot cache filename isolation (deduplicated when serial === name) and probe
      const snapAt = new Date(2026, 10, 19, 18, 16, 4);
      assert.equal(cam.getCacheFileName(snapAt), 'doorbell_T8214T0000000032_snapshot_2026-11-19_18-16-04.jpg');
      const probeCam = new Camera(
        {serial: 'T8161T0000000033', sleep_screen: 'snapshot', startup_snapshot: true},
        {frame: null, lastSeen: ''}
      );
      assert.equal(probeCam.getCacheFileName(snapAt), 'T8161T0000000033_snapshot_2026-11-19_18-16-04.jpg');
      assert.equal(probeCam.requiresStartupSnapshot(), true);
      const directSnapCam = new Camera({name: 'nursery', rtsp_url: 'rtsp://192.0.2.10/live0'});
      assert.equal(directSnapCam.getCacheFileName(snapAt), 'nursery_snapshot_2026-11-19_18-16-04.jpg');
    }
  );
});
