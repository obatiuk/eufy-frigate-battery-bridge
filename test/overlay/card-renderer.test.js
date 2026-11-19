/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for YUV420p sleep screens, card themes (glance, minimal, pebbles, none), embedded Lucide contour
 * sprites, and Smoked Obsidian crystal surfaces (src/overlay/card-renderer.js, ui-glyphs.js, yuv-canvas.js).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards, renderLiveFrameWithCard} = require('../../src/overlay/card-renderer');
const {prepareBackgroundCanvas} = require('../../src/overlay/yuv-canvas');

describe('Card Renderer, Themes & Embedded Glyphs (src/overlay/)', () => {
  it(
    'respects sleep_screen ("snapshot", "slate", "black") for startup snapshot probing and YUV ' + 'canvas rendering',
    () => {
      // Verify: respects sleep_screen ("snapshot", "slate", "black") for startup snapshot probing and YUV canvas
      // rendering.
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

      assert.equal(snapCamNoCache.requiresStartupSnapshot(), true);
      assert.equal(snapCamWithCache.requiresStartupSnapshot(), false);
      assert.equal(blackCam.requiresStartupSnapshot(), false);
      assert.equal(slateCam.requiresStartupSnapshot(), false);

      const blackBg = prepareBackgroundCanvas(blackCam.getCardConfig(), snapCamWithCache.getLastFrameBuffer());
      assert.equal(blackBg.hasBackground, false);
      assert.equal(blackBg.baseCanvas[0], 0x10);

      const slateBg = prepareBackgroundCanvas(slateCam.getCardConfig(), snapCamWithCache.getLastFrameBuffer());
      assert.equal(slateBg.hasBackground, false);
      assert.equal(slateBg.baseCanvas[0], 0x22);

      const snapBg = prepareBackgroundCanvas(snapCamWithCache.getCardConfig(), snapCamWithCache.getLastFrameBuffer());
      assert.equal(snapBg.hasBackground, true);
      assert.equal(snapBg.baseCanvas[0], 0x50);
    }
  );

  it(
    'renders asleep, waking, busy, and live overlay frames across "glance", "minimal", ' +
      '"pebbles", and "none" themes',
    () => {
      // Verify: renders asleep, waking, busy, and live overlay frames across "glance", "minimal", "pebbles", and
      // "none" themes.
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

      assert.equal(glanceCam.getAsleepCardBuffer().length, FRAME);
      assert.equal(minimalCam.getAsleepCardBuffer().length, FRAME);
      assert.equal(pebblesCam.getAsleepCardBuffer().length, FRAME);
      assert.equal(noneCam.getAsleepCardBuffer().length, FRAME);
      assert.equal(noneCam.getAsleepCardBuffer()[0], 0x10);

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
      // Verify: honors startup_snapshot (true, false, "always") and card_show_on_live (true vs false, Live vs
      // Backfill indicator).
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

      assert.equal(startupTrueNoCache.requiresStartupSnapshot(), true);
      assert.equal(startupTrueWithCache.requiresStartupSnapshot(), false);
      assert.equal(startupFalseNoCache.requiresStartupSnapshot(), false);
      assert.equal(startupAlwaysWithCache.requiresStartupSnapshot(), true);

      const hideLiveCardCam = new Camera(
        {serial: 'T8161T0000000000', card_theme: 'glance', card_position: 'bottom-left', card_show_on_live: false},
        {frame: cachedFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      assert.equal(hideLiveCardCam.shouldOverlayCardOnLive(), false);

      const showLiveCardCam = new Camera(
        {serial: 'T8214T2222222222', card_theme: 'glance', card_position: 'bottom-left', card_show_on_live: true},
        {frame: cachedFrame, lastSeen: '12:00'},
        renderCameraCards
      );
      assert.equal(showLiveCardCam.shouldOverlayCardOnLive(), true);

      // Live stream (activeMode='p2p') vs Backfill playback (activeMode='download') render distinct status glyphs
      showLiveCardCam.setSessionActive(true);
      showLiveCardCam.setActiveMode('p2p');
      const liveOverlayBuf = Buffer.from(renderLiveFrameWithCard(showLiveCardCam, cachedFrame));
      showLiveCardCam.setActiveMode('download');
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
      minimalMarkerCam.setSessionActive(true);
      minimalMarkerCam.setActiveMode('download');
      minimalMarkerCam.setDownloadPlayedFrameCount(1);
      assert.equal(minimalMarkerCam.getFrameMarker(), 'FB');
      minimalMarkerCam.setDownloadPlayedFrameCount(2);
      assert.equal(minimalMarkerCam.getFrameMarker(), 'B');
      const bMinimalBuf = Buffer.from(renderLiveFrameWithCard(minimalMarkerCam, cachedFrame));
      minimalMarkerCam.setActiveMode('p2p');
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

      hudMarkerCam.setSessionActive(true);
      hudMarkerCam.setActiveMode('download');
      hudMarkerCam.setFirstFrameAt(1000);
      hudMarkerCam.setGotVideo(true);
      hudMarkerCam.setDownloadPlayedFrameCount(1);
      const fbDebugBuf = Buffer.from(renderLiveFrameWithCard(hudMarkerCam, cachedFrame, 1500));
      hudMarkerCam.setDownloadPlayedFrameCount(2);
      const bDebugBuf = Buffer.from(renderLiveFrameWithCard(hudMarkerCam, cachedFrame, 1500));
      hudMarkerCam.setActiveMode('p2p');
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
      const {LUCIDE_ICON_SPRITES, getClockHandsMask} = require('../../src/overlay/ui-glyphs');

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

        cornerGlance.setSessionActive(true);
        cornerGlance.setActiveMode('p2p');
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

        cornerGlance.setActiveMode('download');
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
        return Buffer.from(c.getAsleepCardBuffer());
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

      const rendererSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'overlay', 'card-renderer.js'),
        'utf8'
      );
      assert.equal(rendererSrc.includes('spawnSync'), false, 'card-renderer.js must not spawn FFmpeg');
      assert.equal(rendererSrc.includes('FONT_FILE'), false, 'card-renderer.js must not read FONT_FILE');

      const dockerfilePath = path.join(__dirname, '..', '..', 'deploy', 'Dockerfile');
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
      const {LUCIDE_ICON_SPRITES} = require('../../src/overlay/ui-glyphs');
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

      const rendererSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'overlay', 'card-renderer.js'),
        'utf8'
      );
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
      assert.equal(centerTopCam.getCardPosition(), 'top-center');
      assert.equal(topCenterCam.getCardPosition(), 'top-center');
      assert.equal(centerBottomCam.getCardPosition(), 'bottom-center');
      assert.equal(bottomCenterCam.getCardPosition(), 'bottom-center');
      assert.deepEqual(centerTopCam.getCardBounds(), {boxX: 608, boxY: 24, boxW: 64, boxH: 12});
      assert.deepEqual(topCenterCam.getCardBounds(), {boxX: 608, boxY: 24, boxW: 64, boxH: 12});
      assert.deepEqual(centerBottomCam.getCardBounds(), {boxX: 608, boxY: 684, boxW: 64, boxH: 12});
      assert.deepEqual(bottomCenterCam.getCardBounds(), {boxX: 608, boxY: 684, boxW: 64, boxH: 12});
      assert.equal(centerTopCam.shouldOverlayCardOnLive(), true);
      assert.equal(centerBottomCam.shouldOverlayCardOnLive(), true);
      assert.ok(centerTopCam.computeMaskPolygon().length > 0);
      assert.ok(centerBottomCam.computeMaskPolygon().length > 0);

      // Verify minimal theme has NO background (gap pixel stays untouched 0xd0) and keeps bright semantic dot fill
      const minCy = minBounds.boxY + 6;
      const minGapLuma = minCam.getAsleepCardBuffer()[minCy * 1280 + (minBounds.boxX + 29)];
      const minDotCenterLuma = minCam.getAsleepCardBuffer()[minCy * 1280 + (minBounds.boxX + 39)];
      assert.equal(
        minGapLuma,
        0xd0,
        'Minimal theme must have no background surface (gap between pill and dot stays raw 0xd0 backdrop)'
      );
      assert.ok(minDotCenterLuma >= 0xd8, 'Minimal theme dot center must render bright semantic ink');

      // Verify Smoked Obsidian (#080b12 at 54% alpha, borderless) crystal surface and
      // solid-filled status icon on Glance
      const glanceCy = glanceBounds.boxY + 22;
      const glanceCrystalLuma = glanceCam.getAsleepCardBuffer()[glanceCy * 1280 + (glanceBounds.boxX + 44)];
      const glanceMoonFillLuma = glanceCam.getAsleepCardBuffer()[(glanceCy + 2) * 1280 + (glanceBounds.boxX + 22)];
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
      const blackCrystalLuma = blackGlanceCam.getAsleepCardBuffer()[glanceCy * 1280 + (glanceBounds.boxX + 44)];
      const blackMoonFillLuma = blackGlanceCam.getAsleepCardBuffer()[(glanceCy + 2) * 1280 + (glanceBounds.boxX + 22)];
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
      const gap1Luma = minCam.getAsleepCardBuffer()[minCy * 1280 + (minBounds.boxX + 29)];
      const gap2Luma = minCam.getAsleepCardBuffer()[minCy * 1280 + (minBounds.boxX + 48)];
      assert.equal(
        gap1Luma,
        gap2Luma,
        'Both compacted 7px inter-item gaps in minimal must preserve identical backdrop luma'
      );

      // Verify Battery dot (x=33) and Wi-Fi dot (x=52) render identical 12x12 dots when healthy unplugged
      for (let row = 0; row < 12; row++) {
        for (let col = 0; col < 12; col++) {
          const y = minBounds.boxY + row;
          const pBat = minCam.getAsleepCardBuffer()[y * 1280 + (minBounds.boxX + 33 + col)];
          const pWifi = minCam.getAsleepCardBuffer()[y * 1280 + (minBounds.boxX + 52 + col)];
          assert.equal(pBat, pWifi, 'Healthy Battery and Wi-Fi 12x12 dots must match identically');
        }
      }

      // Verify minimal Live renders a solid red stadium pill while Backfill renders a hollow red stadium pill ring
      const darkScene = Buffer.alloc(FRAME, 0x24);
      darkScene.fill(0x80, 1280 * 720);
      minCam.setSessionActive(true);
      minCam.setActiveMode('p2p');
      const minLive = Buffer.from(renderLiveFrameWithCard(minCam, darkScene));
      minCam.setActiveMode('download');
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
      glanceCam.setLastFrameBuffer(darkScene);
      renderCameraCards(glanceCam);
      const glanceOpenGlass = glanceCam.getAsleepCardBuffer()[glanceCy * 1280 + (glanceBounds.boxX + 46)];
      const insideMoonConcavity = glanceCam.getAsleepCardBuffer()[(glanceCy - 4) * 1280 + (glanceBounds.boxX + 32)];
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

      const {computePebblesCardWidths} = require('../../src/domain/status-card');
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

      pebblesCam.setLastFrameBuffer(darkScene);
      renderCameraCards(pebblesCam);
      const pebblesCy = pebblesBounds.boxY + 22;
      // All-icons layout: [44, 44, 44, 44, 44] with 8px gaps at x offsets 44..51, 96..103, 148..155, 200..207
      for (const gapStart of [44, 96, 148, 200]) {
        const gapMidX = pebblesBounds.boxX + gapStart + 4;
        assert.equal(
          pebblesCam.getAsleepCardBuffer()[pebblesCy * 1280 + gapMidX],
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
        noTempClockPebblesCam.getAsleepCardBuffer()[pebblesCy * 1280 + (pebblesBounds.boxX + 156 + 22)],
        0x24,
        'Disabled Temperature pebble region must remain untouched background video'
      );

      pebblesCam.setSessionActive(true);
      pebblesCam.setActiveMode('p2p');
      const pebblesLive = Buffer.from(renderLiveFrameWithCard(pebblesCam, darkScene));
      // Status Pebble interior (boxX + 6, cy) floods with translucent Red jewel tint on Live (V chroma > 145),
      // while Asleep stays neutral crystal (V ~ 127..128)
      const pebbleSampleX = (pebblesBounds.boxX + 6) & ~1;
      const pebbleSampleY = pebblesCy & ~1;
      const pebbleVIdx = 1280 * 720 + 640 * 360 + (pebbleSampleY >> 1) * 640 + (pebbleSampleX >> 1);
      assert.ok(
        Math.abs(pebblesCam.getAsleepCardBuffer()[pebbleVIdx] - 0x80) <= 2,
        'Pebbles Status Pebble must stay neutral crystal without red jewel flood when Asleep'
      );
      assert.ok(
        pebblesLive[pebbleVIdx] > 145,
        'Pebbles Status Pebble must flood with semantic red jewel tint when Live'
      );

      // Verify hairline-free, borderless smooth anti-aliased Smoked Obsidian crystal surface and 2x2 YUV420p
      // chroma on odd-X pebbles battery
      const outerAboveDark = glanceCam.getAsleepCardBuffer()[(glanceBounds.boxY - 1) * 1280 + (glanceBounds.boxX + 46)];
      const darkTopEdge = glanceCam.getAsleepCardBuffer()[glanceBounds.boxY * 1280 + (glanceBounds.boxX + 46)];
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
      const oddFillU = pebblesCam.getAsleepCardBuffer()[1280 * 720 + oddFillCIdx];
      assert.ok(
        oddFillU > 134,
        'Odd-X battery charge fill bar in Pebbles must blend sky-blue U chroma (> 134) on its left edge ' +
          'without odd-column chroma drop'
      );
      const wakingIconCenterLuma = glanceCam.getWakingCardBuffer()[glanceCy * 1280 + (glanceBounds.boxX + 28)];
      assert.ok(
        wakingIconCenterLuma - glanceOpenGlass >= 55,
        'Waking status icon (zap) must be solid-filled in its interior'
      );
    }
  );
});
