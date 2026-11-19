// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Status card rendering engine ('glance', 'minimal', 'pebbles', 'hud', 'none')
 * and live-stream corner overlay compositing using Smoked Obsidian Crystal surfaces,
 * embedded Lucide contour icons, 3-dot waiting ellipsis, and diagnostic HUD.
 */
'use strict';

const {
  FRAME,
  SHORT_KEYFRAME_BURST_MS,
  CARD_THEMES,
  CARD_STATUS_TITLES,
  CAMERA_MODES,
  FRAME_STAGE_MARKERS,
  COLOR_WHITE,
  COLOR_GREY,
  COLOR_GREEN,
  COLOR_BLUE,
  COLOR_YELLOW,
  resolveCardConfig,
} = require('../config');
const {POWER_LABELS, STATUS_KINDS, evaluateTelemetryState} = require('../domain/telemetry');
const {
  MINIMAL_CARD_HEIGHT,
  MINIMAL_PILL_WIDTH,
  MINIMAL_DOT_SIZE,
  MINIMAL_ITEM_GAP,
  GLANCE_CARD_HEIGHT,
  GLANCE_CARD_PAD_X,
  GLANCE_CARD_ITEM_GAP,
  GLANCE_STATUS_WIDTH,
  PEBBLE_SIZE,
  computeMinimalCardWidth,
  computeGlanceCardWidth,
  computePebblesCardWidths,
  computeHudCardBounds,
  getCardBoxCoords,
} = require('../domain/status-card');
const {
  blendYuvPixel,
  fillYuvRect,
  drawCrystalSurface,
  drawHudSurface,
  prepareBackgroundCanvas,
  drawMonospaceText,
} = require('./yuv-canvas');
const {LUCIDE_ICON_SPRITES, blitAlphaSprite, getClockHandsMask} = require('./ui-glyphs');

/** @typedef {import("../domain/camera").Camera} Camera */

const POWER_BADGE_KINDS = Object.freeze({
  SOLAR: 'solar',
  PLUGGED: 'plugged',
  BOLT: 'bolt',
  UNKNOWN: 'unknown',
  NONE: 'none',
});

const STATUS_GLYPH_OPACITY = 1;

const BAT_FILL_PCT_MAX = 100;
const BAT_MIN_FILL_W = 2;
const BAT_FILL_X = 4;
const BAT_FILL_Y = 5;
const BAT_FILL_MAX_W = 17;
const BAT_FILL_H = 10;
const BAT_LOW_FILL_ALPHA = 0.92;
const BAT_NORMAL_FILL_ALPHA = 0.86;
const BAT_NA_OPACITY = 0.72;
const BAT_SHELL_OPACITY = 1;
const BADGE_BATTERY_SHIFT_DOWN_Y = 1;
const POWER_BADGE_OFFSET_X = 14;
const POWER_BADGE_OFFSET_Y = -4;
const POWER_BADGE_OPACITY = 1;

const WIFI_STD_HALF = 12;
const WIFI_STD_WIDTH = 24;
const WIFI_LIT_OPACITY = 1;
const WIFI_NA_OPACITY = 0.45;
const WIFI_UNLIT_OPACITY = 0.45;

const THERM_STD_HALF = 12;
const THERM_ACTIVE_OPACITY = 1;
const THERM_NA_OPACITY = 0.72;

const CLOCK_STD_SIZE = 24;
const CLOCK_RING_OPACITY = 1;
const CLOCK_HANDS_OPACITY = 1;
const CLOCK_NA_OPACITY = 0.72;

const MINIMAL_ITEM_TOP_OFFSET = 0;
const MINIMAL_STATUS_OFFSET_X = 0;
const MINIMAL_FG_OPACITY = 0.98;

const GLANCE_CY_OFFSET = 22;
const GLANCE_STATUS_HALF = 12;
const PEBBLES_ICON_OFFSET_X = 10;
const PEBBLES_BATTERY_OFFSET_X = 9;
const PEBBLES_TEMP_OFFSET_X = 12;
const PEBBLES_JEWEL_ALPHA = 0.72;
const PEBBLES_JEWEL_FROST_ALPHA = 0.06;
const PEBBLES_CALM_FROST_ALPHA = 0.12;

const BLOCK_B_STEM_W = 3;
const BLOCK_B_H = 14;
const BLOCK_B_BAR_W = 9;
const BLOCK_B_BAR_H = 3;
const BLOCK_B_MID_Y = 6;
const BLOCK_B_BOT_Y = 11;
const BLOCK_B_R_X = 8;
const BLOCK_B_LOBE_H = 4;
const BLOCK_B_BOT_LOBE_Y = 8;

const STAGE_BOX_X = 8;
const STAGE_BOX_HALF_Y = 10;
const STAGE_BOX_W = 26;
const STAGE_BOX_H = 20;
const STAGE_TOP_OFFSET = 7;
const STAGE_F_X = 10;
const STAGE_F_MID_W = 7;
const STAGE_FB_B_X = 21;
const STAGE_SINGLE_X = 16;
const STAGE_L_W = 10;
const STAGE_S_X = 15;
const STAGE_S_W = 12;
const STAGE_S_R_X = 9;
const STAGE_S_STEP = 3;

const RGB_SHIFT_R = 16;
const RGB_SHIFT_G = 8;
const RGB_CHANNEL_MASK = 0xff;

/**
 * Unpack a 24-bit `0xRRGGBB` constant into a frozen `[r, g, b]` tuple.
 *
 * @param {number} hex
 * @return {readonly [number, number, number]}
 */
function rgbTuple(hex) {
  return Object.freeze([
    (hex >> RGB_SHIFT_R) & RGB_CHANNEL_MASK,
    (hex >> RGB_SHIFT_G) & RGB_CHANNEL_MASK,
    hex & RGB_CHANNEL_MASK,
  ]);
}

const DEBUG_STAGE_YELLOW_HEX = 0xeab308;
const DEBUG_STAGE_RED_HEX = 0xef4444;
const DEBUG_STAGE_DARK_TEXT_HEX = 0x0f0f14;
const DEBUG_STAGE_LIGHT_TEXT_HEX = 0xffffff;

const DEBUG_STAGE_YELLOW_RGB = rgbTuple(DEBUG_STAGE_YELLOW_HEX);
const DEBUG_STAGE_RED_RGB = rgbTuple(DEBUG_STAGE_RED_HEX);
const DEBUG_STAGE_DARK_TEXT_RGB = rgbTuple(DEBUG_STAGE_DARK_TEXT_HEX);
const DEBUG_STAGE_LIGHT_TEXT_RGB = rgbTuple(DEBUG_STAGE_LIGHT_TEXT_HEX);
const DEBUG_STAGE_BOX_OPACITY = 0.96;
const DEBUG_STAGE_SNAPSHOT_BOX_OPACITY = 0.92;
const DEBUG_STAGE_GLYPH_OPACITY = 0.98;
const DEBUG_HUD_MAX_SESSION_DISPLAY = 99;
const DEBUG_HUD_SESSION_PAD_LEN = 2;
const DEBUG_HUD_MODE_TAG_LEN = 4;
const DEBUG_HUD_LEFT_COL_OFFSET_X = 12;
const DEBUG_HUD_STAGE_SQUARE_OFFSET_X = 4;
const DEBUG_HUD_STAGE_SQUARE_CENTER_Y = 19;
const DEBUG_HUD_MODE_ROW_INDEX = 2;
const DEBUG_HUD_SESSION_ROW_INDEX = 3;
const DEBUG_HUD_TEXT_LEFT_OFFSET_X = 52;
const DEBUG_HUD_TEXT_TOP_OFFSET_Y = 9;
const DEBUG_HUD_LINE_STEP_Y = 15;
const DEFAULT_LIVE_OVERLAY_MAX_AGE_MS = 2000;

const DEBUG_HUD_DIRECT_RTSP_TAG = 'DIR ';

/** @type {Readonly<Record<string, string>>} */
const DEBUG_HUD_MODE_TAGS = Object.freeze({
  [CAMERA_MODES.AUTO]: 'AUTO',
  [CAMERA_MODES.RTSP]: 'RTSP',
  [CAMERA_MODES.P2P]: 'P2P ',
  [CAMERA_MODES.BACKFILL]: 'BF  ',
  [CAMERA_MODES.CUSTOM]: 'CUST',
});

/**
 * Resolves which Lucide inline power icon ('solar', 'plugged', 'bolt', 'unknown', or 'none') accompanies the battery.
 *
 * @param {string} powerLabel - Parsed power source label ('Solar', 'Plugged', 'Charging', or '').
 * @param {boolean} showBadge - Whether power-source iconography is active for this battery state.
 * @param {boolean} [hasBat=true] - Whether a numeric battery charge percentage is available.
 * @returns {'solar'|'plugged'|'bolt'|'unknown'|'none'}
 */
function resolvePowerBadgeKind(powerLabel, showBadge, hasBat = true) {
  if (!showBadge) {
    return hasBat ? POWER_BADGE_KINDS.NONE : POWER_BADGE_KINDS.UNKNOWN;
  }
  if (powerLabel === POWER_LABELS.SOLAR) {
    return POWER_BADGE_KINDS.SOLAR;
  }
  if (powerLabel === POWER_LABELS.PLUGGED) {
    return POWER_BADGE_KINDS.PLUGGED;
  }
  return POWER_BADGE_KINDS.BOLT;
}

/**
 * Draws a solid-filled Lucide status icon ('standby' crescent moon, 'live' play,
 * 'backfill' rewind, 'waking' zap, 'waiting' three-dot ellipsis, or 'disconnected' wifi-off)
 * with strictly zero circular glare or halo disc underneath.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{
 *   x: number,
 *   y: number,
 *   rgbOverride?: readonly number[]|null
 * }} pos - Top-left position and optional color override.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawStatusGlyph(canvas, pos, st) {
  const spriteSet = LUCIDE_ICON_SPRITES.status;
  let sprite = spriteSet.standby;
  switch (st.statusKind) {
    case STATUS_KINDS.LIVE:
      sprite = spriteSet.live;
      break;
    case STATUS_KINDS.BACKFILL:
      sprite = spriteSet.backfill;
      break;
    case STATUS_KINDS.WAKING:
      sprite = spriteSet.waking;
      break;
    case STATUS_KINDS.WAITING:
      sprite = spriteSet.waiting;
      break;
    case STATUS_KINDS.DISCONNECTED:
      sprite = spriteSet.disconnected;
      break;
    default:
      break;
  }
  const fgRgb = pos.rgbOverride || st.statusRgb;
  blitAlphaSprite(canvas, {x: pos.x, y: pos.y, sprite}, {rgb: fgRgb, opacity: STATUS_GLYPH_OPACITY, shadow: false});
}

/**
 * Draws the charge fill bar inside the battery shell, attenuating pixels inside the top-right badge cutout.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{
 *   x: number,
 *   y: number,
 *   w: number,
 *   rgb: readonly number[],
 *   alpha: number,
 *   keepMap: Uint8Array|null
 * }} bar - Charge bar geometry and color.
 */
function drawBatteryFillBar(canvas, bar) {
  const {x, y, w, rgb, alpha, keepMap} = bar;
  if (!keepMap) {
    fillYuvRect(canvas, x, y, w, BAT_FILL_H, rgb[0], rgb[1], rgb[2], alpha);
    return;
  }
  for (let fy = 0; fy < BAT_FILL_H; fy++) {
    const rowOff = fy * BAT_FILL_MAX_W;
    for (let fx = 0; fx < w; fx++) {
      const keep = keepMap[rowOff + fx];
      if (keep > 0) {
        blendYuvPixel(canvas, x + fx, y + fy, rgb[0], rgb[1], rgb[2], (alpha * keep) / RGB_CHANNEL_MASK);
      }
    }
  }
}

/**
 * Draws the Lucide contour battery shell, proportional charge fill (sky-blue when charging,
 * calm white when unplugged and healthy, yellow when low, purple when critical), and optional
 * top-right overlaid Solar/Plugged/Charging/Unknown 15x15 badge with a crystal cutout, returning
 * total horizontal advance.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, cy: number }} pos - Left X and vertical center Y.
 * @param {{
 *   hasBat: boolean,
 *   batPct: number,
 *   batRgb?: readonly number[],
 *   charging: boolean,
 *   economyMode: boolean,
 *   badgeKind: 'solar'|'plugged'|'bolt'|'unknown'|'none'
 * }} opts - Battery visual state.
 * @returns {number}
 */
function drawBatteryIcon(canvas, pos, opts) {
  const hasBadge = Boolean(opts.badgeKind && opts.badgeKind !== POWER_BADGE_KINDS.NONE);
  const shell = hasBadge ? LUCIDE_ICON_SPRITES.batteryCutout[opts.badgeKind] : LUCIDE_ICON_SPRITES.batteryShell;
  const topY = Math.round(pos.cy - shell.height / 2) + (hasBadge ? BADGE_BATTERY_SHIFT_DOWN_Y : 0);
  const lowCrit = opts.hasBat && opts.economyMode && !opts.charging;
  const isPowered = opts.charging || (hasBadge && opts.badgeKind !== POWER_BADGE_KINDS.UNKNOWN);
  const alertRgb = opts.batRgb || COLOR_YELLOW;
  const shellRgb = !opts.hasBat ? COLOR_GREY : lowCrit ? alertRgb : COLOR_WHITE;

  if (opts.hasBat && opts.batPct > 0) {
    const fillRgb = lowCrit ? alertRgb : isPowered ? COLOR_BLUE : COLOR_WHITE;
    const fillAlpha = lowCrit ? BAT_LOW_FILL_ALPHA : BAT_NORMAL_FILL_ALPHA;
    const fillW = Math.max(BAT_MIN_FILL_W, Math.round((BAT_FILL_MAX_W * opts.batPct) / BAT_FILL_PCT_MAX));
    drawBatteryFillBar(canvas, {
      x: pos.x + BAT_FILL_X,
      y: topY + BAT_FILL_Y,
      w: fillW,
      rgb: fillRgb,
      alpha: fillAlpha,
      keepMap: hasBadge ? LUCIDE_ICON_SPRITES.batteryFillKeep[opts.badgeKind] : null,
    });
  }

  blitAlphaSprite(
    canvas,
    {x: pos.x, y: topY, sprite: shell},
    {rgb: shellRgb, opacity: opts.hasBat ? BAT_SHELL_OPACITY : BAT_NA_OPACITY, shadow: false}
  );

  if (hasBadge) {
    const badge = LUCIDE_ICON_SPRITES.powerBadge15[opts.badgeKind];
    blitAlphaSprite(
      canvas,
      {x: pos.x + POWER_BADGE_OFFSET_X, y: topY + POWER_BADGE_OFFSET_Y, sprite: badge},
      {rgb: COLOR_WHITE, opacity: POWER_BADGE_OPACITY, shadow: false}
    );
  }
  return shell.width;
}

/**
 * Draws the 4-tier Lucide Wi-Fi fan (calm white when >= 2 bars, amber when <= 1 bar, grey when unavailable).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, cy: number }} pos - Left X and vertical center Y.
 * @param {{ hasSignal: boolean, wifiBars: number, rgb: readonly number[] }} opts - Signal bar tier and active RGB.
 * @returns {number}
 */
function drawWifiArcsIcon(canvas, pos, opts) {
  const tiers = LUCIDE_ICON_SPRITES.wifiTiers;
  const weakAlert = opts.hasSignal && opts.wifiBars <= 1;

  for (let i = 0; i < tiers.length; i++) {
    const lit = !opts.hasSignal ? false : weakAlert ? i <= 1 : opts.wifiBars >= i + 1;
    blitAlphaSprite(
      canvas,
      {x: pos.x, y: pos.cy - WIFI_STD_HALF, sprite: tiers[i]},
      {
        rgb: lit ? opts.rgb : !opts.hasSignal ? COLOR_GREY : COLOR_WHITE,
        opacity: lit ? WIFI_LIT_OPACITY : !opts.hasSignal ? WIFI_NA_OPACITY : WIFI_UNLIT_OPACITY,
        shadow: false,
      }
    );
  }
  return WIFI_STD_WIDTH;
}

/**
 * Draws the Lucide contour thermometer icon colored by thermal state.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, cy: number }} pos - Left X and vertical center Y.
 * @param {Record<string, *>} st - Evaluated telemetry state.
 * @returns {number}
 */
function drawThermometerIcon(canvas, pos, st) {
  const sprite = LUCIDE_ICON_SPRITES.thermometer;
  blitAlphaSprite(
    canvas,
    {x: pos.x, y: pos.cy - THERM_STD_HALF, sprite},
    {
      rgb: st.tempRgb,
      opacity: st.hasTemp ? THERM_ACTIVE_OPACITY : THERM_NA_OPACITY,
      shadow: false,
    }
  );
  return sprite.width;
}

/**
 * Draws the Lucide hollow clock ring and cached dynamic HH:MM hands mask.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, cy: number }} pos - Left X and vertical center Y.
 * @param {string} seenVal - Formatted 'HH:MM' timestamp.
 */
function drawAnalogClockIcon(canvas, pos, seenVal) {
  const half = CLOCK_STD_SIZE / 2;
  const hasSeen = Boolean(seenVal);
  const rgb = hasSeen ? COLOR_WHITE : COLOR_GREY;
  const ringSprite = LUCIDE_ICON_SPRITES.clockRing;
  blitAlphaSprite(
    canvas,
    {x: pos.x, y: pos.cy - half, sprite: ringSprite},
    {rgb, opacity: hasSeen ? CLOCK_RING_OPACITY : CLOCK_NA_OPACITY, shadow: false}
  );
  const handsSprite = {
    width: CLOCK_STD_SIZE,
    height: CLOCK_STD_SIZE,
    mask: getClockHandsMask(seenVal, CLOCK_STD_SIZE),
  };
  blitAlphaSprite(
    canvas,
    {x: pos.x, y: pos.cy - half, sprite: handsSprite},
    {rgb, opacity: hasSeen ? CLOCK_HANDS_OPACITY : CLOCK_NA_OPACITY, shadow: false}
  );
}

/**
 * Draws the sensor icon strip (battery + overlaid power badge, Wi-Fi, thermometer, and clock)
 * inside the 'glance' theme capsule.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{
 *   startX: number,
 *   cy: number,
 *   showBat: boolean,
 *   badgeKind: 'solar'|'plugged'|'bolt'|'unknown'|'none',
 *   showWifi: boolean,
 *   showTemp: boolean,
 *   showClock: boolean
 * }} layout - Strip layout flags.
 * @param {Record<string, *>} st - Evaluated telemetry state.
 */
function drawSensorIconStrip(canvas, layout, st) {
  let cursorX = layout.startX;
  const {cy} = layout;

  if (layout.showBat) {
    const batAdv = drawBatteryIcon(
      canvas,
      {x: cursorX, cy},
      {
        hasBat: Boolean(st.hasBat),
        batPct: st.batPct,
        batRgb: st.batRgb,
        charging: Boolean(st.charging),
        economyMode: Boolean(st.economyMode),
        badgeKind: layout.badgeKind,
      }
    );
    cursorX += batAdv + GLANCE_CARD_ITEM_GAP;
  }

  if (layout.showWifi) {
    const wifiAdv = drawWifiArcsIcon(
      canvas,
      {x: cursorX, cy},
      {hasSignal: Boolean(st.hasWifi || st.hasRssi), wifiBars: st.wifiBars, rgb: st.wifiRgb}
    );
    cursorX += wifiAdv + GLANCE_CARD_ITEM_GAP;
  }

  if (layout.showTemp) {
    const thermAdv = drawThermometerIcon(canvas, {x: cursorX, cy}, st);
    cursorX += thermAdv + GLANCE_CARD_ITEM_GAP;
  }

  if (layout.showClock) {
    drawAnalogClockIcon(canvas, {x: cursorX, cy}, st.seenVal);
  }
}

/**
 * Draws a bold 11x14 block letter 'B' at (pos.x, pos.top) using the given RGB color.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, top: number }} pos - Left and top coordinates of the 'B' glyph.
 * @param {readonly number[]} rgb - RGB color array [r, g, b].
 */
function drawBlockLetterB(canvas, pos, rgb) {
  const [r, g, b] = rgb;
  fillYuvRect(canvas, pos.x, pos.top, BLOCK_B_STEM_W, BLOCK_B_H, r, g, b, DEBUG_STAGE_GLYPH_OPACITY);
  fillYuvRect(canvas, pos.x, pos.top, BLOCK_B_BAR_W, BLOCK_B_BAR_H, r, g, b, DEBUG_STAGE_GLYPH_OPACITY);
  fillYuvRect(canvas, pos.x, pos.top + BLOCK_B_MID_Y, BLOCK_B_BAR_W, 2, r, g, b, DEBUG_STAGE_GLYPH_OPACITY);
  fillYuvRect(canvas, pos.x, pos.top + BLOCK_B_BOT_Y, BLOCK_B_BAR_W, BLOCK_B_BAR_H, r, g, b, DEBUG_STAGE_GLYPH_OPACITY);
  fillYuvRect(
    canvas,
    pos.x + BLOCK_B_R_X,
    pos.top + 2,
    BLOCK_B_STEM_W,
    BLOCK_B_LOBE_H,
    r,
    g,
    b,
    DEBUG_STAGE_GLYPH_OPACITY
  );
  fillYuvRect(
    canvas,
    pos.x + BLOCK_B_R_X,
    pos.top + BLOCK_B_BOT_LOBE_Y,
    BLOCK_B_STEM_W,
    BLOCK_B_LOBE_H,
    r,
    g,
    b,
    DEBUG_STAGE_GLYPH_OPACITY
  );
}

/**
 * Draws the colored status square and crisp block-letter frame marker ('S', 'FB', 'B', or 'L')
 * inside the left status slot of the 'hud' diagnostic card (keeping [S] Green when Asleep).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ boxX: number, cy: number, marker: string }} slot - Left X, vertical center Y, and frame stage marker.
 * @param {Record<string, *>} st - Evaluated telemetry state.
 */
function drawDebugStageSquare(canvas, slot, st) {
  const {boxX, cy, marker} = slot;
  const top = cy - STAGE_TOP_OFFSET;
  const [yr, yg, yb] = DEBUG_STAGE_YELLOW_RGB;
  const [rr, rg, rb] = DEBUG_STAGE_RED_RGB;
  const [dr, dg, db] = DEBUG_STAGE_DARK_TEXT_RGB;
  const [lr, lg, lb] = DEBUG_STAGE_LIGHT_TEXT_RGB;
  switch (marker) {
    case FRAME_STAGE_MARKERS.FIRST_BACKFILL: {
      fillYuvRect(
        canvas,
        boxX + STAGE_BOX_X,
        cy - STAGE_BOX_HALF_Y,
        STAGE_BOX_W,
        STAGE_BOX_H,
        yr,
        yg,
        yb,
        DEBUG_STAGE_BOX_OPACITY
      );
      const fx = boxX + STAGE_F_X;
      fillYuvRect(canvas, fx, top, BLOCK_B_STEM_W, BLOCK_B_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, fx, top, BLOCK_B_BAR_W, BLOCK_B_BAR_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, fx, top + BLOCK_B_MID_Y, STAGE_F_MID_W, BLOCK_B_BAR_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      drawBlockLetterB(canvas, {x: boxX + STAGE_FB_B_X, top}, DEBUG_STAGE_DARK_TEXT_RGB);
      return;
    }
    case FRAME_STAGE_MARKERS.BACKFILL:
      fillYuvRect(
        canvas,
        boxX + STAGE_BOX_X,
        cy - STAGE_BOX_HALF_Y,
        STAGE_BOX_W,
        STAGE_BOX_H,
        rr,
        rg,
        rb,
        DEBUG_STAGE_BOX_OPACITY
      );
      drawBlockLetterB(canvas, {x: boxX + STAGE_SINGLE_X, top}, DEBUG_STAGE_LIGHT_TEXT_RGB);
      return;
    case FRAME_STAGE_MARKERS.LIVE: {
      fillYuvRect(
        canvas,
        boxX + STAGE_BOX_X,
        cy - STAGE_BOX_HALF_Y,
        STAGE_BOX_W,
        STAGE_BOX_H,
        rr,
        rg,
        rb,
        DEBUG_STAGE_BOX_OPACITY
      );
      const lx = boxX + STAGE_SINGLE_X;
      fillYuvRect(canvas, lx, top, BLOCK_B_STEM_W, BLOCK_B_H, lr, lg, lb, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, lx, top + BLOCK_B_BOT_Y, STAGE_L_W, BLOCK_B_BAR_H, lr, lg, lb, DEBUG_STAGE_GLYPH_OPACITY);
      return;
    }
    case FRAME_STAGE_MARKERS.SNAPSHOT:
    default: {
      const stageRgb =
        st.statusKind === STATUS_KINDS.ASLEEP || st.statusKind === STATUS_KINDS.LOW_BATTERY
          ? COLOR_GREEN
          : st.statusRgb;
      const [sr, sg, sb] = stageRgb;
      fillYuvRect(
        canvas,
        boxX + STAGE_BOX_X,
        cy - STAGE_BOX_HALF_Y,
        STAGE_BOX_W,
        STAGE_BOX_H,
        sr,
        sg,
        sb,
        DEBUG_STAGE_SNAPSHOT_BOX_OPACITY
      );
      const sx = boxX + STAGE_S_X;
      fillYuvRect(canvas, sx, top, STAGE_S_W, BLOCK_B_BAR_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, sx, top + STAGE_S_STEP, BLOCK_B_STEM_W, STAGE_S_STEP, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, sx, top + BLOCK_B_MID_Y, STAGE_S_W, 2, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(
        canvas,
        sx + STAGE_S_R_X,
        top + BLOCK_B_BOT_LOBE_Y,
        BLOCK_B_STEM_W,
        STAGE_S_STEP,
        dr,
        dg,
        db,
        DEBUG_STAGE_GLYPH_OPACITY
      );
      fillYuvRect(canvas, sx, top + BLOCK_B_BOT_Y, STAGE_S_W, BLOCK_B_BAR_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      return;
    }
  }
}

/**
 * Renders the 'minimal' theme directly over the video frame with no background capsule,
 * using a 26x12 stadium pill (hollow ring in Backfill) + 7px gaps + optional 12x12 battery and Wi-Fi dots.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ position: string }} opts - Placement options.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawMinimalDotsCard(canvas, opts, st) {
  const showBat = Boolean(st.telCfg && st.telCfg.enabled && st.telCfg.battery);
  const showWifi = Boolean(st.telCfg && st.telCfg.enabled && st.telCfg.wifi);
  const boxW = computeMinimalCardWidth({showBat, showWifi});
  const {boxX, boxY} = getCardBoxCoords(opts.position, boxW, MINIMAL_CARD_HEIGHT);
  const minSprites = LUCIDE_ICON_SPRITES.minimal;
  const statusSprite = st.statusKind === STATUS_KINDS.BACKFILL ? minSprites.pillRing : minSprites.pillFg;
  const itemY = boxY + MINIMAL_ITEM_TOP_OFFSET;
  let cursorX = boxX + MINIMAL_STATUS_OFFSET_X;
  blitAlphaSprite(
    canvas,
    {x: cursorX, y: itemY, sprite: statusSprite},
    {rgb: st.statusRgb, opacity: MINIMAL_FG_OPACITY, shadow: true}
  );
  cursorX += MINIMAL_PILL_WIDTH;
  if (showBat) {
    cursorX += MINIMAL_ITEM_GAP;
    blitAlphaSprite(
      canvas,
      {x: cursorX, y: itemY, sprite: minSprites.dotFg},
      {rgb: st.batRgb, opacity: MINIMAL_FG_OPACITY, shadow: true}
    );
    cursorX += MINIMAL_DOT_SIZE;
  }
  if (showWifi) {
    cursorX += MINIMAL_ITEM_GAP;
    blitAlphaSprite(
      canvas,
      {x: cursorX, y: itemY, sprite: minSprites.dotFg},
      {rgb: st.wifiRgb, opacity: MINIMAL_FG_OPACITY, shadow: true}
    );
  }
}

/**
 * Renders the diagnostic 'hud' overlay with a deep-slate matte scrim,
 * alternating row bands, colored frame-stage square ('S', 'FB', 'B', 'L'), and
 * 4 haloed neutral-luma monospace rows.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{
 *   position: string,
 *   blurBackdrop?: boolean,
 *   cam?: Camera|null,
 *   frameMarker?: string,
 *   now?: number
 * }} hud - HUD options.
 * @param {Record<string, *>} st - Evaluated telemetry state.
 */
function drawDebugHudCard(canvas, hud, st) {
  const blurBackdrop = hud.blurBackdrop !== false;
  const cam = hud.cam || null;
  const frameMarker = hud.frameMarker || FRAME_STAGE_MARKERS.SNAPSHOT;
  const now = hud.now === undefined ? Date.now() : hud.now;
  const {boxX, boxY, boxW, boxH} = computeHudCardBounds(hud.position);
  drawHudSurface(canvas, {boxX, boxY, boxW, boxH}, blurBackdrop);

  drawDebugStageSquare(
    canvas,
    {
      boxX: boxX + DEBUG_HUD_STAGE_SQUARE_OFFSET_X,
      cy: boxY + DEBUG_HUD_STAGE_SQUARE_CENTER_Y,
      marker: frameMarker,
    },
    st
  );
  const configuredMode = cam && typeof cam.getConfiguredMode === 'function' ? cam.getConfiguredMode() : '';
  const modeKey = configuredMode ? String(configuredMode).toLowerCase() : CAMERA_MODES.AUTO;
  const modeTag =
    cam && typeof cam.isRtspDirect === 'function' && cam.isRtspDirect()
      ? DEBUG_HUD_DIRECT_RTSP_TAG
      : DEBUG_HUD_MODE_TAGS[modeKey] ||
        String(modeKey).toUpperCase().slice(0, DEBUG_HUD_MODE_TAG_LEN).padEnd(DEBUG_HUD_MODE_TAG_LEN, ' ');
  const sessNum = Math.max(
    0,
    Math.min(
      DEBUG_HUD_MAX_SESSION_DISPLAY,
      Number(cam && typeof cam.getSessionId === 'function' ? cam.getSessionId() || 0 : 0)
    )
  );
  const sessTag = '#' + String(sessNum).padStart(DEBUG_HUD_SESSION_PAD_LEN, '0') + ' ';
  const leftColX = boxX + DEBUG_HUD_LEFT_COL_OFFSET_X;
  drawMonospaceText(
    canvas,
    {
      x: leftColX,
      y: boxY + DEBUG_HUD_TEXT_TOP_OFFSET_Y + DEBUG_HUD_MODE_ROW_INDEX * DEBUG_HUD_LINE_STEP_Y,
    },
    {text: modeTag, syntaxHighlight: false}
  );
  drawMonospaceText(
    canvas,
    {
      x: leftColX,
      y: boxY + DEBUG_HUD_TEXT_TOP_OFFSET_Y + DEBUG_HUD_SESSION_ROW_INDEX * DEBUG_HUD_LINE_STEP_Y,
    },
    {text: sessTag, syntaxHighlight: false}
  );

  if (cam && typeof cam.buildDebugHudLines === 'function') {
    const lines = cam.buildDebugHudLines(now);
    const textX = boxX + DEBUG_HUD_TEXT_LEFT_OFFSET_X;
    for (let i = 0; i < lines.length; i++) {
      drawMonospaceText(
        canvas,
        {x: textX, y: boxY + DEBUG_HUD_TEXT_TOP_OFFSET_Y + i * DEBUG_HUD_LINE_STEP_Y},
        {text: lines[i], syntaxHighlight: true}
      );
    }
  }
}

/**
 * Evaluates visible sensor flags and power badge kind for the 'glance' and 'pebbles' themes.
 *
 * @param {Record<string, *>} st - Evaluated telemetry state.
 * @returns {{
 *   showBat: boolean,
 *   badgeKind: 'solar'|'plugged'|'bolt'|'unknown'|'none',
 *   showWifi: boolean,
 *   showTemp: boolean,
 *   showClock: boolean
 * }}
 */
function resolveIconStripFlags(st) {
  const {telCfg} = st;
  const showBat = Boolean(telCfg.enabled && telCfg.battery);
  const showBadge = Boolean(showBat && telCfg.powerSource && (st.charging || st.powerLabel));
  const badgeKind = showBat
    ? resolvePowerBadgeKind(st.powerLabel, showBadge, Boolean(st.hasBat))
    : POWER_BADGE_KINDS.NONE;
  const showWifi = Boolean(telCfg.enabled && telCfg.wifi);
  const showTemp = Boolean(telCfg.enabled && telCfg.temperature);
  const showClock = Boolean(telCfg.enabled && telCfg.lastSeen);
  return {showBat, badgeKind, showWifi, showTemp, showClock};
}

/**
 * Renders the 'glance' theme inside a 44px Smoked Obsidian Crystal capsule using
 * solid-filled 24x24 Lucide status icons and contour sensor sprites with zero text and zero glare discs.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ position: string, blurBackdrop?: boolean }} opts - Placement and backdrop blur flag.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawGlanceCard(canvas, opts, st) {
  const blurBackdrop = opts.blurBackdrop !== false;
  const flags = resolveIconStripFlags(st);
  const boxW = computeGlanceCardWidth(flags);
  const boxH = GLANCE_CARD_HEIGHT;
  const {boxX, boxY} = getCardBoxCoords(opts.position, boxW, boxH);
  const cy = boxY + GLANCE_CY_OFFSET;

  drawCrystalSurface(canvas, {boxX, boxY, boxW, boxH}, {blurBackdrop});

  const statusX = boxX + GLANCE_CARD_PAD_X;
  drawStatusGlyph(canvas, {x: statusX, y: cy - GLANCE_STATUS_HALF}, st);

  drawSensorIconStrip(
    canvas,
    {
      startX: statusX + GLANCE_STATUS_WIDTH + GLANCE_CARD_ITEM_GAP,
      cy,
      showBat: flags.showBat,
      badgeKind: flags.badgeKind,
      showWifi: flags.showWifi,
      showTemp: flags.showTemp,
      showClock: flags.showClock,
    },
    st
  );
}

/**
 * Renders the 'pebbles' theme as a row of separate 44px Smoked Obsidian crystal pebbles
 * separated by 8px untouched video gaps: a circular 44x44 Status Pebble (Smoked Obsidian
 * crystal when Asleep, translucent semantic jewel flood + crisp white icon when active/fault)
 * followed by individual pebbles for each enabled sensor icon (Battery, Wi-Fi, Temperature, Clock).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ position: string, blurBackdrop?: boolean }} opts - Placement and backdrop blur flag.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawPebblesCard(canvas, opts, st) {
  const blurBackdrop = opts.blurBackdrop !== false;
  const flags = resolveIconStripFlags(st);
  const {statusW, batW, wifiW, tempW, clockW, gapPx, totalW} = computePebblesCardWidths(flags);
  const {boxX, boxY} = getCardBoxCoords(opts.position, totalW, PEBBLE_SIZE);
  const cy = boxY + GLANCE_CY_OFFSET;
  const useJewel = st.statusKind !== STATUS_KINDS.ASLEEP && st.statusKind !== STATUS_KINDS.LOW_BATTERY;
  let cursorX = boxX;

  drawCrystalSurface(
    canvas,
    {boxX: cursorX, boxY, boxW: statusW, boxH: PEBBLE_SIZE},
    {
      blurBackdrop,
      jewelRgb: useJewel ? st.statusRgb : null,
      jewelAlpha: useJewel ? PEBBLES_JEWEL_ALPHA : 0,
      whiteFrostAlpha: useJewel ? PEBBLES_JEWEL_FROST_ALPHA : PEBBLES_CALM_FROST_ALPHA,
    }
  );
  drawStatusGlyph(
    canvas,
    {
      x: cursorX + PEBBLES_ICON_OFFSET_X,
      y: cy - GLANCE_STATUS_HALF,
      rgbOverride: useJewel ? COLOR_WHITE : null,
    },
    st
  );
  cursorX += statusW + gapPx;

  if (batW > 0) {
    drawCrystalSurface(canvas, {boxX: cursorX, boxY, boxW: batW, boxH: PEBBLE_SIZE}, {blurBackdrop});
    drawBatteryIcon(
      canvas,
      {x: cursorX + PEBBLES_BATTERY_OFFSET_X, cy},
      {
        hasBat: Boolean(st.hasBat),
        batPct: st.batPct,
        batRgb: st.batRgb,
        charging: Boolean(st.charging),
        economyMode: Boolean(st.economyMode),
        badgeKind: flags.badgeKind,
      }
    );
    cursorX += batW + gapPx;
  }

  if (wifiW > 0) {
    drawCrystalSurface(canvas, {boxX: cursorX, boxY, boxW: wifiW, boxH: PEBBLE_SIZE}, {blurBackdrop});
    drawWifiArcsIcon(
      canvas,
      {x: cursorX + PEBBLES_ICON_OFFSET_X, cy},
      {hasSignal: Boolean(st.hasWifi || st.hasRssi), wifiBars: st.wifiBars, rgb: st.wifiRgb}
    );
    cursorX += wifiW + gapPx;
  }

  if (tempW > 0) {
    drawCrystalSurface(canvas, {boxX: cursorX, boxY, boxW: tempW, boxH: PEBBLE_SIZE}, {blurBackdrop});
    drawThermometerIcon(canvas, {x: cursorX + PEBBLES_TEMP_OFFSET_X, cy}, st);
    cursorX += tempW + gapPx;
  }

  if (clockW > 0) {
    drawCrystalSurface(canvas, {boxX: cursorX, boxY, boxW: clockW, boxH: PEBBLE_SIZE}, {blurBackdrop});
    drawAnalogClockIcon(canvas, {x: cursorX + PEBBLES_ICON_OFFSET_X, cy}, st.seenVal);
  }
}

/**
 * Renders a static YUV420p status frame according to card_theme ('glance', 'minimal', 'pebbles',
 * 'hud', or 'none') and card_position, mutating targetBuf in-place when provided.
 *
 * @param {string} titleText - Card status heading ('Asleep', 'Waking Up...', 'Waiting', etc.).
 * @param {{
 *   status: Record<string, *>|null,
 *   preparedBg: Uint8Array,
 *   hasBackground: boolean,
 *   targetBuf?: Uint8Array|null
 * }} renderCtx - Background and buffer context.
 * @returns {Uint8Array} Raw YUV420p frame buffer of length FRAME.
 */
function renderSingleStatusCard(titleText, renderCtx) {
  const {status, preparedBg, hasBackground} = renderCtx;
  const cardCfg = (status && status.cardCfg) || resolveCardConfig({});
  const canvas =
    Buffer.isBuffer(renderCtx.targetBuf) && renderCtx.targetBuf.length === FRAME
      ? renderCtx.targetBuf
      : Buffer.allocUnsafe(FRAME);
  canvas.set(preparedBg);

  if (cardCfg.theme === CARD_THEMES.NONE) {
    return canvas;
  }

  const st = evaluateTelemetryState(titleText, status);

  switch (cardCfg.theme) {
    case CARD_THEMES.HUD:
      drawDebugHudCard(
        canvas,
        {
          position: cardCfg.position,
          blurBackdrop: hasBackground,
          cam: status && status.cam ? status.cam : null,
          frameMarker: FRAME_STAGE_MARKERS.SNAPSHOT,
        },
        st
      );
      return canvas;
    case CARD_THEMES.GLANCE:
      drawGlanceCard(canvas, {position: cardCfg.position, blurBackdrop: hasBackground}, st);
      return canvas;
    case CARD_THEMES.PEBBLES:
      drawPebblesCard(canvas, {position: cardCfg.position, blurBackdrop: hasBackground}, st);
      return canvas;
    case CARD_THEMES.MINIMAL:
    default:
      drawMinimalDotsCard(canvas, {position: cardCfg.position}, st);
      return canvas;
  }
}

/**
 * Renders the asleep, waking, and busy status cards for a camera using its Telemetry
 * and StatusCard domain models and a single shared background buffer.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function renderCameraCards(cam) {
  cam.setLazyCardRenderer((titleText, targetBuf) => {
    const lazyCtx = cam.prepareCardRenderContext();
    const lazyBg = prepareBackgroundCanvas(lazyCtx.cardConfig, lazyCtx.lastFrame);
    return renderSingleStatusCard(titleText, {
      status: lazyCtx.status,
      preparedBg: lazyBg.baseCanvas,
      hasBackground: lazyBg.hasBackground,
      targetBuf,
    });
  });
  const ctx = cam.prepareCardRenderContext();
  const {baseCanvas, hasBackground} = prepareBackgroundCanvas(ctx.cardConfig, ctx.lastFrame);

  cam.commitRenderedCards(
    {
      asleep: renderSingleStatusCard(ctx.asleepTitle, {
        status: ctx.status,
        preparedBg: baseCanvas,
        hasBackground,
        targetBuf: ctx.asleepBuf,
      }),
      waking: ctx.wakingBuf
        ? renderSingleStatusCard(CARD_STATUS_TITLES.WAKING_UP, {
            status: ctx.status,
            preparedBg: baseCanvas,
            hasBackground,
            targetBuf: ctx.wakingBuf,
          })
        : null,
      busy: ctx.busyBuf
        ? renderSingleStatusCard(CARD_STATUS_TITLES.WAITING, {
            status: ctx.status,
            preparedBg: baseCanvas,
            hasBackground,
            targetBuf: ctx.busyBuf,
          })
        : null,
    },
    Date.now(),
    SHORT_KEYFRAME_BURST_MS
  );
}

/**
 * Composites the camera's corner status card (or diagnostic HUD) onto a copy of a frame
 * when card_show_on_live is enabled, leaving the original raw frame (and cam.lastFrame) untouched.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {Uint8Array} rawFrame - Source YUV420p frame buffer.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 * @returns {Uint8Array} YUV420p frame buffer with corner overlay applied (or rawFrame if disabled).
 */
function renderLiveFrameWithCard(cam, rawFrame, now = Date.now()) {
  if (!cam.shouldOverlayCardOnLive() && !cam.hasDynamicDebugCard()) {
    return rawFrame;
  }
  if (cam.usesDebugHudTheme()) {
    const isLive = cam.isStreamingLive(now, DEFAULT_LIVE_OVERLAY_MAX_AGE_MS);
    const {baseCanvas, hasBackground} = isLive
      ? {baseCanvas: rawFrame, hasBackground: true}
      : prepareBackgroundCanvas(cam.getCardConfig(), cam.getLastFrameBuffer());
    const out = cam.acquireLiveOverlayBuffer(baseCanvas);
    const titleForState = isLive
      ? cam.isBackfillPlayback()
        ? CARD_STATUS_TITLES.BACKFILL
        : CARD_STATUS_TITLES.LIVE
      : cam.isSessionActive() && !cam.isBackfillPlayback() && !cam.isPassiveRtspDirectProbe()
        ? CARD_STATUS_TITLES.WAKING_UP
        : cam.isWaitingForSlotOrBackfill(now)
          ? CARD_STATUS_TITLES.WAITING
          : cam.hasServiceDisruption()
            ? CARD_STATUS_TITLES.DISCONNECTED
            : cam.isLowBattery()
              ? CARD_STATUS_TITLES.ASLEEP_LOW_BATTERY
              : CARD_STATUS_TITLES.ASLEEP;
    const st = cam.evaluateVisualState(titleForState);
    const stageMarker = isLive || cam.hasGotVideo() ? cam.getFrameMarker() : FRAME_STAGE_MARKERS.SNAPSHOT;
    drawDebugHudCard(
      out,
      {
        position: cam.getCardPosition(),
        blurBackdrop: hasBackground,
        cam,
        frameMarker: stageMarker,
        now,
      },
      st
    );
    return out;
  }

  const {out, theme, position, st} = cam.prepareLiveCardOverlay(rawFrame);

  switch (theme) {
    case CARD_THEMES.MINIMAL:
      drawMinimalDotsCard(out, {position}, st);
      return out;
    case CARD_THEMES.GLANCE:
      drawGlanceCard(out, {position, blurBackdrop: true}, st);
      return out;
    case CARD_THEMES.PEBBLES:
      drawPebblesCard(out, {position, blurBackdrop: true}, st);
      return out;
    default:
      return rawFrame;
  }
}

module.exports = {
  renderCameraCards,
  renderLiveFrameWithCard,
};
