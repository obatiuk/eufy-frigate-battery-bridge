// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Status card rendering engine ('detailed', 'icons', 'minimal', 'debug', 'none')
 * and live-stream corner overlay compositing using pre-baked proportional UI glyphs
 * and Eufy Security standard icon alpha sprites.
 */
'use strict';

const {
  clampNum,
  W,
  FRAME,
  SHORT_KEYFRAME_BURST_MS,
  CARD_THEMES,
  CARD_POSITIONS,
  CARD_STATUS_TITLES,
  CAMERA_MODES,
  FRAME_STAGE_MARKERS,
  resolveCardConfig,
} = require('../config');
const {
  POWER_LABELS,
  TEL_BAT_LABEL_OFFSET_X,
  TEL_WIFI_LABEL_OFFSET_X,
  TEL_TEMP_LABEL_OFFSET_X,
  TEL_SEEN_LABEL_OFFSET_X,
  STATUS_KINDS,
  TELEMETRY_SEGMENT_TYPES,
  evaluateTelemetryState,
  buildTelemetrySegments,
} = require('../domain/telemetry');
const {
  CARD_CORNER_RADIUS,
  MINIMAL_CARD_WIDTH,
  MINIMAL_CARD_HEIGHT,
  ICONS_CARD_HEIGHT,
  ICONS_CARD_PAD_X,
  ICONS_CARD_ITEM_GAP,
  ICONS_STATUS_WIDTH,
  ICONS_BATTERY_WIDTH,
  ICONS_WIFI_WIDTH,
  ICONS_TEMP_WIDTH,
  computeIconsCardWidth,
  computeCornerDetailedCardDimensions,
  computeDebugCardBounds,
  getCardBoxCoords,
} = require('../domain/status-card');
const {
  fillYuvRect,
  drawRoundedBox,
  prepareBackgroundCanvas,
  drawMonospaceText,
} = require('./yuv-canvas');
const {
  UI_FONT_SIZES,
  EUFY_ICON_SPRITES,
  measureUiText,
  drawUiText,
  blitAlphaSprite,
  getClockHandsMask,
} = require('./ui-glyphs');

/** @typedef {import("../domain/camera").Camera} Camera */

const CENTER_MODAL_WIDTH = 820;
const CENTER_MODAL_HEIGHT_WITH_TEL = 336;
const CENTER_MODAL_HEIGHT_NO_TEL = 268;
const CENTER_MODAL_ICON_CY = 114;
const CENTER_MODAL_TITLE_Y = 30;
const CENTER_MODAL_LINE1_Y = 168;
const CENTER_MODAL_LINE2_Y = 204;
const CENTER_MODAL_DIVIDER_PAD_X = 44;
const CENTER_MODAL_DIVIDER_Y = 254;
const CENTER_MODAL_TEL_GAP = 28;
const CENTER_MODAL_TEL_Y = 278;

const CARD_BG_OPACITY = 0.64;
const CARD_BORDER_OPACITY = 0.18;
const DIVIDER_OPACITY = 0.16;
const STATUS_GLYPH_OPACITY = 1;

const BAT_SHELL_OPACITY = 0.98;
const BAT_FILL_OPACITY = 0.98;
const BAT_FILL_X = 4;
const BAT_FILL_Y = 4;
const BAT_FILL_MAX_W = 26;
const BAT_FILL_MIN_W = 3;
const BAT_FILL_H = 10;
const BAT_PCT_MAX = 100;
const BAT_BADGE_OFFSET_X = 8;
const BADGE_HALO_OPACITY = 0.92;
const BADGE_FG_OPACITY = 0.98;

const WIFI_LIT_OPACITY = 1;
const WIFI_UNLIT_OPACITY = 0.34;

const THERM_BODY_OPACITY = 0.98;
const THERM_BORE_OPACITY = 0.92;
const THERM_MERCURY_OPACITY = 1;
const THERM_MAX_C = 50;
const THERM_DEFAULT_C = 22;
const THERM_MERCURY_MAX_H = 10;
const THERM_MERCURY_X = 5;
const THERM_MERCURY_W = 3;
const THERM_BULB_JOIN_Y = 14;

const CLOCK_SIZE_PX = 22;
const CLOCK_DIAL_OPACITY = 0.98;
const CLOCK_HANDS_OPACITY = 1;

const MINIMAL_DOT_TOP_OFFSET = 13;
const MINIMAL_STATUS_OFFSET_X = 16;
const MINIMAL_BAT_OFFSET_X = 46;
const MINIMAL_WIFI_OFFSET_X = 76;
const MINIMAL_FG_OPACITY = 1;

const ICONS_CY_OFFSET = 22;
const ICONS_STATUS_HALF_W = 11;
const ICONS_BAT_TOP_OFFSET = 9;
const ICONS_WIFI_TOP_OFFSET = 11;
const ICONS_THERM_TOP_OFFSET = 11;
const ICONS_CLOCK_TOP_OFFSET = 11;

const DETAILED_STATUS_CX_OFFSET = 26;
const DETAILED_STATUS_CY_OFFSET = 23;
const DETAILED_HEADER_X_OFFSET = 45;
const DETAILED_HEADER_Y_OFFSET = 15;
const DETAILED_DIVIDER_PAD_X = 20;
const DETAILED_DIVIDER_Y_OFFSET = 44;
const DETAILED_TEL_X_OFFSET = 22;
const DETAILED_TEL_Y_OFFSET = 54;
const TEL_BAT_ICON_Y_OFFSET = -2;
const TEL_WIFI_ICON_Y_OFFSET = -4;
const TEL_THERM_ICON_Y_OFFSET = -4;
const TEL_CLOCK_ICON_Y_OFFSET = -4;

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

const NORMAL_TEMP_HEX = '0xd4d4d8';
const WHITE_RGB = Object.freeze([255, 255, 255]);
const MODAL_BODY_RGB = Object.freeze([228, 228, 231]);
const ZINC_TEXT_RGB = Object.freeze([212, 212, 216]);
const MUTED_SEEN_RGB = Object.freeze([161, 161, 170]);
const UNLIT_WIFI_RGB = Object.freeze([113, 113, 122]);
const DARK_GLASS_RGB = Object.freeze([24, 24, 28]);
const BADGE_HALO_RGB = Object.freeze([18, 18, 22]);
const BADGE_FG_RGB = Object.freeze([250, 250, 252]);
const CLOCK_DIAL_RGB = Object.freeze([228, 228, 231]);

const DEBUG_STAGE_YELLOW_RGB = Object.freeze([234, 179, 8]);
const DEBUG_STAGE_RED_RGB = Object.freeze([239, 68, 68]);
const DEBUG_STAGE_DARK_TEXT_RGB = Object.freeze([15, 15, 20]);
const DEBUG_STAGE_LIGHT_TEXT_RGB = Object.freeze([255, 255, 255]);
const DEBUG_STAGE_BOX_OPACITY = 0.96;
const DEBUG_STAGE_SNAPSHOT_BOX_OPACITY = 0.92;
const DEBUG_STAGE_GLYPH_OPACITY = 0.98;
const DEBUG_HUD_BG_OPACITY = 0.74;
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

/** @type {Readonly<Record<string, string>>} */
const DEBUG_HUD_MODE_TAGS = Object.freeze({
  [CAMERA_MODES.AUTO]: 'AUTO',
  [CAMERA_MODES.RTSP]: 'RTSP',
  [CAMERA_MODES.P2P]: 'P2P ',
  [CAMERA_MODES.BACKFILL]: 'BF  ',
  [CAMERA_MODES.CUSTOM]: 'CUST',
});

/**
 * Resolves which Eufy Power Manager badge ('solar', 'plugged', 'bolt', or 'none') to overlay on the battery icon.
 *
 * @param {string} powerLabel - Parsed power source label ('Solar', 'Plugged', 'Charging', or '').
 * @param {boolean} showBadge - Whether power-source iconography is active for this battery state.
 * @returns {'solar'|'plugged'|'bolt'|'none'}
 */
function resolvePowerBadgeKind(powerLabel, showBadge) {
  if (!showBadge) {
    return 'none';
  }
  if (powerLabel === POWER_LABELS.SOLAR) {
    return 'solar';
  }
  if (powerLabel === POWER_LABELS.PLUGGED) {
    return 'plugged';
  }
  return 'bolt';
}

/**
 * Draws the pre-baked Eufy status glyph sprite ('live', 'backfill', 'waking', 'disconnected', 'standby').
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ cx: number, cy: number, modal?: boolean }} pos - Center coordinates and modal size flag.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawStatusGlyph(canvas, pos, st) {
  const spriteSet = pos.modal ? EUFY_ICON_SPRITES.statusModal : EUFY_ICON_SPRITES.statusSmall;
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
    case STATUS_KINDS.DISCONNECTED:
      sprite = spriteSet.disconnected;
      break;
    default:
      break;
  }
  blitAlphaSprite(
      canvas,
      {x: pos.cx - sprite.width / 2, y: pos.cy - sprite.height / 2, sprite},
      {rgb: st.statusRgb, opacity: STATUS_GLYPH_OPACITY, shadow: true}
  );
}

/**
 * Draws the 38x18 Eufy rounded battery icon, proportional charge fill bar, and optional
 * Eufy Power Manager badge (Solar sun, AC Plug, or USB-C Lightning Bolt).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number }} pos - Top-left coordinates of the battery shell.
 * @param {{ batPct: number, rgb: readonly number[], badgeKind: 'solar'|'plugged'|'bolt'|'none' }} opts - Battery visual state.
 */
function drawBatteryIcon(canvas, pos, opts) {
  blitAlphaSprite(
      canvas,
      {x: pos.x, y: pos.y, sprite: EUFY_ICON_SPRITES.batteryShell},
      {rgb: opts.rgb, opacity: BAT_SHELL_OPACITY, shadow: true}
  );
  if (opts.batPct > 0) {
    const fillW = Math.max(BAT_FILL_MIN_W, Math.round((BAT_FILL_MAX_W * opts.batPct) / BAT_PCT_MAX));
    const [fr, fg, fb] = opts.rgb;
    fillYuvRect(canvas, pos.x + BAT_FILL_X, pos.y + BAT_FILL_Y, fillW, BAT_FILL_H, fr, fg, fb, BAT_FILL_OPACITY);
  }
  if (opts.badgeKind !== 'none') {
    const badge = EUFY_ICON_SPRITES.powerBadges[opts.badgeKind];
    const badgeX = pos.x + BAT_BADGE_OFFSET_X;
    blitAlphaSprite(
        canvas,
        {x: badgeX, y: pos.y, sprite: badge.haloSprite},
        {rgb: BADGE_HALO_RGB, opacity: BADGE_HALO_OPACITY}
    );
    blitAlphaSprite(
        canvas,
        {x: badgeX, y: pos.y, sprite: badge.fgSprite},
        {rgb: BADGE_FG_RGB, opacity: BADGE_FG_OPACITY}
    );
  }
}

/**
 * Draws the pre-baked 4-tier Eufy rounded-cap Wi-Fi signal fan colored by RSSI/signal quality.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number }} pos - Top-left coordinates of the 30x22 Wi-Fi icon slot.
 * @param {{ wifiBars: number, rgb: readonly number[] }} opts - Signal bar tier (0..4) and active RGB color.
 */
function drawWifiArcsIcon(canvas, pos, opts) {
  const tiers = EUFY_ICON_SPRITES.wifiTiers;
  for (let i = 0; i < tiers.length; i++) {
    const lit = opts.wifiBars >= i + 1;
    blitAlphaSprite(
        canvas,
        {x: pos.x, y: pos.y, sprite: tiers[i]},
        {
          rgb: lit ? opts.rgb : UNLIT_WIFI_RGB,
          opacity: lit ? WIFI_LIT_OPACITY : WIFI_UNLIT_OPACITY,
          shadow: lit,
        }
    );
  }
}

/**
 * Draws the pre-baked 18x22 Eufy thermometer icon with graduation ticks and proportional mercury bar.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number }} pos - Top-left coordinates of the 18x22 thermometer slot.
 * @param {Record<string, *>} st - Evaluated telemetry state or temperature segment.
 */
function drawThermometerIcon(canvas, pos, st) {
  blitAlphaSprite(
      canvas,
      {x: pos.x, y: pos.y, sprite: EUFY_ICON_SPRITES.thermometer.bodySprite},
      {rgb: st.tempRgb, opacity: THERM_BODY_OPACITY, shadow: true}
  );
  blitAlphaSprite(
      canvas,
      {x: pos.x, y: pos.y, sprite: EUFY_ICON_SPRITES.thermometer.boreSprite},
      {rgb: DARK_GLASS_RGB, opacity: THERM_BORE_OPACITY}
  );
  if (st.hasTemp) {
    const clampedTemp = clampNum(st.tempNum, 0, THERM_MAX_C, THERM_DEFAULT_C);
    const mercuryH = Math.max(2, Math.round((clampedTemp / THERM_MAX_C) * THERM_MERCURY_MAX_H));
    const [tr, tg, tb] = st.tempRgb;
    fillYuvRect(
        canvas,
        pos.x + THERM_MERCURY_X,
        pos.y + THERM_BULB_JOIN_Y - mercuryH,
        THERM_MERCURY_W,
        mercuryH + 2,
        tr,
        tg,
        tb,
        THERM_MERCURY_OPACITY
    );
  }
}

/**
 * Draws the pre-baked 22x22 Eufy hollow-ring clock dial and cached HH:MM hands mask.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number }} pos - Top-left coordinates of the 22x22 clock slot.
 * @param {string} seenVal - Formatted 'HH:MM' timestamp.
 */
function drawAnalogClockIcon(canvas, pos, seenVal) {
  blitAlphaSprite(
      canvas,
      {x: pos.x, y: pos.y, sprite: EUFY_ICON_SPRITES.clockDial},
      {rgb: CLOCK_DIAL_RGB, opacity: CLOCK_DIAL_OPACITY, shadow: true}
  );
  const handsSprite = {
    width: CLOCK_SIZE_PX,
    height: CLOCK_SIZE_PX,
    mask: getClockHandsMask(seenVal),
  };
  blitAlphaSprite(
      canvas,
      {x: pos.x, y: pos.y, sprite: handsSprite},
      {rgb: BADGE_FG_RGB, opacity: CLOCK_HANDS_OPACITY, shadow: true}
  );
}

/**
 * Measures the rendered pixel width (icon + proportional label) of a single telemetry segment.
 *
 * @param {Record<string, *>} seg - Telemetry segment from buildTelemetrySegments().
 * @returns {number}
 */
function measureTelemetrySegmentWidth(seg) {
  const textW = measureUiText(seg.label, UI_FONT_SIZES.SM);
  switch (seg.type) {
    case TELEMETRY_SEGMENT_TYPES.BATTERY:
      return TEL_BAT_LABEL_OFFSET_X + textW;
    case TELEMETRY_SEGMENT_TYPES.WIFI:
      return TEL_WIFI_LABEL_OFFSET_X + textW;
    case TELEMETRY_SEGMENT_TYPES.TEMPERATURE:
      return TEL_TEMP_LABEL_OFFSET_X + textW;
    case TELEMETRY_SEGMENT_TYPES.LAST_SEEN:
      return TEL_SEEN_LABEL_OFFSET_X + textW;
    default:
      return textW;
  }
}

/**
 * Draws the Eufy telemetry icons alongside their proportional anti-aliased text labels
 * for the 'detailed' theme without spawning FFmpeg.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ startX: number, textY: number, gap: number }} layout - Row start coordinates and segment gap.
 * @param {Array<Record<string, *>>} segments - Telemetry segments from buildTelemetrySegments().
 */
function drawTelemetryRow(canvas, layout, segments) {
  let cursorX = layout.startX;
  const {textY, gap} = layout;

  for (const seg of segments) {
    switch (seg.type) {
      case TELEMETRY_SEGMENT_TYPES.BATTERY: {
        const badgeKind = resolvePowerBadgeKind(seg.powerLabel, Boolean(seg.showBolt));
        drawBatteryIcon(
            canvas,
            {x: cursorX, y: textY + TEL_BAT_ICON_Y_OFFSET},
            {batPct: seg.batPct, rgb: seg.batRgb, badgeKind}
        );
        drawUiText(canvas, {
          x: cursorX + TEL_BAT_LABEL_OFFSET_X,
          y: textY,
          text: seg.label,
          fontSize: UI_FONT_SIZES.SM,
          rgb: seg.batRgb,
        });
        break;
      }
      case TELEMETRY_SEGMENT_TYPES.WIFI:
        drawWifiArcsIcon(
            canvas,
            {x: cursorX, y: textY + TEL_WIFI_ICON_Y_OFFSET},
            {wifiBars: seg.wifiBars, rgb: seg.wifiRgb}
        );
        drawUiText(canvas, {
          x: cursorX + TEL_WIFI_LABEL_OFFSET_X,
          y: textY,
          text: seg.label,
          fontSize: UI_FONT_SIZES.SM,
          rgb: ZINC_TEXT_RGB,
        });
        break;
      case TELEMETRY_SEGMENT_TYPES.TEMPERATURE: {
        drawThermometerIcon(canvas, {x: cursorX, y: textY + TEL_THERM_ICON_Y_OFFSET}, seg);
        const tempTextRgb = seg.tempHex === NORMAL_TEMP_HEX ? ZINC_TEXT_RGB : seg.tempRgb;
        drawUiText(canvas, {
          x: cursorX + TEL_TEMP_LABEL_OFFSET_X,
          y: textY,
          text: seg.label,
          fontSize: UI_FONT_SIZES.SM,
          rgb: tempTextRgb,
        });
        break;
      }
      case TELEMETRY_SEGMENT_TYPES.LAST_SEEN:
        drawAnalogClockIcon(canvas, {x: cursorX, y: textY + TEL_CLOCK_ICON_Y_OFFSET}, seg.seenVal);
        drawUiText(canvas, {
          x: cursorX + TEL_SEEN_LABEL_OFFSET_X,
          y: textY,
          text: seg.label,
          fontSize: UI_FONT_SIZES.SM,
          rgb: MUTED_SEEN_RGB,
        });
        break;
      default:
        break;
    }
    cursorX += measureTelemetrySegmentWidth(seg) + gap;
  }
}

/**
 * Draws a bold 11x14 block letter 'B' at (bx, top) using the given RGB color.
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
  fillYuvRect(canvas, pos.x + BLOCK_B_R_X, pos.top + 2, BLOCK_B_STEM_W, BLOCK_B_LOBE_H, r, g, b, DEBUG_STAGE_GLYPH_OPACITY);
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
 * inside the left status slot of the 'debug' HUD card.
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
      fillYuvRect(canvas, boxX + STAGE_BOX_X, cy - STAGE_BOX_HALF_Y, STAGE_BOX_W, STAGE_BOX_H, yr, yg, yb, DEBUG_STAGE_BOX_OPACITY);
      const fx = boxX + STAGE_F_X;
      fillYuvRect(canvas, fx, top, BLOCK_B_STEM_W, BLOCK_B_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, fx, top, BLOCK_B_BAR_W, BLOCK_B_BAR_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, fx, top + BLOCK_B_MID_Y, STAGE_F_MID_W, BLOCK_B_BAR_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      drawBlockLetterB(canvas, {x: boxX + STAGE_FB_B_X, top}, DEBUG_STAGE_DARK_TEXT_RGB);
      return;
    }
    case FRAME_STAGE_MARKERS.BACKFILL:
      fillYuvRect(canvas, boxX + STAGE_BOX_X, cy - STAGE_BOX_HALF_Y, STAGE_BOX_W, STAGE_BOX_H, rr, rg, rb, DEBUG_STAGE_BOX_OPACITY);
      drawBlockLetterB(canvas, {x: boxX + STAGE_SINGLE_X, top}, DEBUG_STAGE_LIGHT_TEXT_RGB);
      return;
    case FRAME_STAGE_MARKERS.LIVE: {
      fillYuvRect(canvas, boxX + STAGE_BOX_X, cy - STAGE_BOX_HALF_Y, STAGE_BOX_W, STAGE_BOX_H, rr, rg, rb, DEBUG_STAGE_BOX_OPACITY);
      const lx = boxX + STAGE_SINGLE_X;
      fillYuvRect(canvas, lx, top, BLOCK_B_STEM_W, BLOCK_B_H, lr, lg, lb, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, lx, top + BLOCK_B_BOT_Y, STAGE_L_W, BLOCK_B_BAR_H, lr, lg, lb, DEBUG_STAGE_GLYPH_OPACITY);
      return;
    }
    case FRAME_STAGE_MARKERS.SNAPSHOT:
    default: {
      const [sr, sg, sb] = st.statusRgb;
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
      fillYuvRect(canvas, sx + STAGE_S_R_X, top + BLOCK_B_BOT_LOBE_Y, BLOCK_B_STEM_W, STAGE_S_STEP, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      fillYuvRect(canvas, sx, top + BLOCK_B_BOT_Y, STAGE_S_W, BLOCK_B_BAR_H, dr, dg, db, DEBUG_STAGE_GLYPH_OPACITY);
      return;
    }
  }
}

/**
 * Renders the shared frosted-glass rounded card surface (22px corner radius, 64% dark glass tint,
 * and uniform 1.25px anti-aliased frosted rim) used identically by all non-HUD themes.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ boxX: number, boxY: number, boxW: number, boxH: number }} bounds - Even-aligned card bounds.
 * @param {boolean} blurBackdrop - Whether to blur the live/snapshot backdrop underneath the box.
 */
function drawCardSurface(canvas, bounds, blurBackdrop) {
  drawRoundedBox(
      canvas,
      bounds.boxX,
      bounds.boxY,
      bounds.boxW,
      bounds.boxH,
      CARD_CORNER_RADIUS,
      CARD_BG_OPACITY,
      CARD_BORDER_OPACITY,
      blurBackdrop
  );
}

/**
 * Renders the 'minimal' theme inside a 110x44 frosted-glass capsule using three 18x18 halo-free
 * shadowed circles (Status solid circle or hollow ring for Backfill, Battery, and Wi-Fi) and zero icons.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ position: string, blurBackdrop?: boolean }} opts - Placement and backdrop blur flag.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawMinimalDotsCard(canvas, opts, st) {
  const blurBackdrop = opts.blurBackdrop !== false;
  const {boxX, boxY} = getCardBoxCoords(opts.position, MINIMAL_CARD_WIDTH, MINIMAL_CARD_HEIGHT);

  drawCardSurface(canvas, {boxX, boxY, boxW: MINIMAL_CARD_WIDTH, boxH: MINIMAL_CARD_HEIGHT}, blurBackdrop);

  const minSprites = EUFY_ICON_SPRITES.minimal;
  const statusSprite = st.statusKind === STATUS_KINDS.BACKFILL ? minSprites.dotRing : minSprites.dotFg;
  const dotY = boxY + MINIMAL_DOT_TOP_OFFSET;
  blitAlphaSprite(
      canvas,
      {x: boxX + MINIMAL_STATUS_OFFSET_X, y: dotY, sprite: statusSprite},
      {rgb: st.statusRgb, opacity: MINIMAL_FG_OPACITY, shadow: true}
  );
  blitAlphaSprite(
      canvas,
      {x: boxX + MINIMAL_BAT_OFFSET_X, y: dotY, sprite: minSprites.dotFg},
      {rgb: st.batRgb, opacity: MINIMAL_FG_OPACITY, shadow: true}
  );
  blitAlphaSprite(
      canvas,
      {x: boxX + MINIMAL_WIFI_OFFSET_X, y: dotY, sprite: minSprites.dotFg},
      {rgb: st.wifiRgb, opacity: MINIMAL_FG_OPACITY, shadow: true}
  );
}

/**
 * Renders the diagnostic 'debug' bottom HUD with a sharp blurred backdrop,
 * colored frame-stage square ('S', 'FB', 'B', 'L'), and 4 fixed-width monospace rows.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ position: string, blurBackdrop?: boolean, cam?: Camera|null, frameMarker?: string, now?: number }} hud - HUD options.
 * @param {Record<string, *>} st - Evaluated telemetry state.
 */
function drawDebugHudCard(canvas, hud, st) {
  const blurBackdrop = hud.blurBackdrop !== false;
  const cam = hud.cam || null;
  const frameMarker = hud.frameMarker || FRAME_STAGE_MARKERS.SNAPSHOT;
  const now = hud.now === undefined ? Date.now() : hud.now;
  const {boxX, boxY, boxW, boxH} = computeDebugCardBounds(hud.position);
  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 0, DEBUG_HUD_BG_OPACITY, 0, blurBackdrop);

  drawDebugStageSquare(
      canvas,
      {
        boxX: boxX + DEBUG_HUD_STAGE_SQUARE_OFFSET_X,
        cy: boxY + DEBUG_HUD_STAGE_SQUARE_CENTER_Y,
        marker: frameMarker,
      },
      st
  );
  const modeKey = cam && cam.mode ? String(cam.mode).toLowerCase() : CAMERA_MODES.AUTO;
  const modeTag =
      DEBUG_HUD_MODE_TAGS[modeKey] ||
      String(modeKey).toUpperCase().slice(0, DEBUG_HUD_MODE_TAG_LEN).padEnd(DEBUG_HUD_MODE_TAG_LEN, ' ');
  const sessNum = Math.max(
      0,
      Math.min(DEBUG_HUD_MAX_SESSION_DISPLAY, Number(cam && cam.sessionId ? cam.sessionId : 0))
  );
  const sessTag = '#' + String(sessNum).padStart(DEBUG_HUD_SESSION_PAD_LEN, '0') + ' ';
  const leftColX = boxX + DEBUG_HUD_LEFT_COL_OFFSET_X;
  drawMonospaceText(
      canvas,
      leftColX,
      boxY + DEBUG_HUD_TEXT_TOP_OFFSET_Y + DEBUG_HUD_MODE_ROW_INDEX * DEBUG_HUD_LINE_STEP_Y,
      modeTag
  );
  drawMonospaceText(
      canvas,
      leftColX,
      boxY + DEBUG_HUD_TEXT_TOP_OFFSET_Y + DEBUG_HUD_SESSION_ROW_INDEX * DEBUG_HUD_LINE_STEP_Y,
      sessTag
  );

  if (cam && typeof cam.buildDebugHudLines === 'function') {
    const lines = cam.buildDebugHudLines(now);
    const textX = boxX + DEBUG_HUD_TEXT_LEFT_OFFSET_X;
    for (let i = 0; i < lines.length; i++) {
      drawMonospaceText(
          canvas,
          textX,
          boxY + DEBUG_HUD_TEXT_TOP_OFFSET_Y + i * DEBUG_HUD_LINE_STEP_Y,
          lines[i]
      );
    }
  }
}

/**
 * Renders the 'icons' theme using pre-baked Eufy Security standard UI icon sprites
 * inside a full-radius frosted-glass capsule with zero text and zero FFmpeg subprocesses.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ position: string, blurBackdrop?: boolean }} opts - Placement and backdrop blur flag.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawIconsOnlyCard(canvas, opts, st) {
  const blurBackdrop = opts.blurBackdrop !== false;
  const {telCfg} = st;
  const showBat = Boolean(telCfg.enabled && telCfg.battery);
  const showWifi = Boolean(telCfg.enabled && telCfg.wifi);
  const showTemp = Boolean(telCfg.enabled && telCfg.temperature);
  const showClock = Boolean(telCfg.enabled && telCfg.lastSeen && st.seenVal);

  const boxW = computeIconsCardWidth({showBat, showWifi, showTemp, showClock});
  const boxH = ICONS_CARD_HEIGHT;
  const {boxX, boxY} = getCardBoxCoords(opts.position, boxW, boxH);
  const cy = boxY + ICONS_CY_OFFSET;

  drawCardSurface(canvas, {boxX, boxY, boxW, boxH}, blurBackdrop);

  let cursorX = boxX + ICONS_CARD_PAD_X;
  drawStatusGlyph(canvas, {cx: cursorX + ICONS_STATUS_HALF_W, cy, modal: false}, st);
  cursorX += ICONS_STATUS_WIDTH + ICONS_CARD_ITEM_GAP;

  if (showBat) {
    const showBadge = Boolean(telCfg.powerSource && (st.charging || st.powerLabel));
    const badgeKind = resolvePowerBadgeKind(st.powerLabel, showBadge);
    drawBatteryIcon(
        canvas,
        {x: cursorX, y: cy - ICONS_BAT_TOP_OFFSET},
        {batPct: st.batPct, rgb: st.batRgb, badgeKind}
    );
    cursorX += ICONS_BATTERY_WIDTH + ICONS_CARD_ITEM_GAP;
  }

  if (showWifi) {
    drawWifiArcsIcon(canvas, {x: cursorX, y: cy - ICONS_WIFI_TOP_OFFSET}, {wifiBars: st.wifiBars, rgb: st.wifiRgb});
    cursorX += ICONS_WIFI_WIDTH + ICONS_CARD_ITEM_GAP;
  }

  if (showTemp) {
    drawThermometerIcon(canvas, {x: cursorX, y: cy - ICONS_THERM_TOP_OFFSET}, st);
    cursorX += ICONS_TEMP_WIDTH + ICONS_CARD_ITEM_GAP;
  }

  if (showClock) {
    drawAnalogClockIcon(canvas, {x: cursorX, y: cy - ICONS_CLOCK_TOP_OFFSET}, st.seenVal);
  }
}

/**
 * Composites the centered rounded translucent modal ('detailed' theme at 'center' position),
 * 60x60 Eufy status sprite, proportional anti-aliased copy, and baseline-aligned telemetry row.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer (modified in place).
 * @param {{ titleText: string, line1: string, line2: string, segments: Array<Record<string, *>>, blurBackdrop: boolean }} modal - Modal content.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawCenteredDetailedModal(canvas, modal, st) {
  const {segments, blurBackdrop} = modal;
  const boxW = CENTER_MODAL_WIDTH;
  const boxH = segments.length > 0 ? CENTER_MODAL_HEIGHT_WITH_TEL : CENTER_MODAL_HEIGHT_NO_TEL;
  const {boxX, boxY} = getCardBoxCoords(CARD_POSITIONS.CENTER, boxW, boxH);

  drawCardSurface(canvas, {boxX, boxY, boxW, boxH}, blurBackdrop);
  drawStatusGlyph(canvas, {cx: W / 2, cy: boxY + CENTER_MODAL_ICON_CY, modal: true}, st);

  drawUiText(canvas, {
    x: W / 2,
    y: boxY + CENTER_MODAL_TITLE_Y,
    text: modal.titleText,
    fontSize: UI_FONT_SIZES.LG,
    rgb: WHITE_RGB,
    centered: true,
  });
  drawUiText(canvas, {
    x: W / 2,
    y: boxY + CENTER_MODAL_LINE1_Y,
    text: modal.line1,
    fontSize: UI_FONT_SIZES.MD,
    rgb: MODAL_BODY_RGB,
    centered: true,
  });
  drawUiText(canvas, {
    x: W / 2,
    y: boxY + CENTER_MODAL_LINE2_Y,
    text: modal.line2,
    fontSize: UI_FONT_SIZES.MD,
    rgb: MODAL_BODY_RGB,
    centered: true,
  });

  if (segments.length > 0) {
    fillYuvRect(
        canvas,
        boxX + CENTER_MODAL_DIVIDER_PAD_X,
        boxY + CENTER_MODAL_DIVIDER_Y,
        boxW - CENTER_MODAL_DIVIDER_PAD_X * 2,
        1,
        WHITE_RGB[0],
        WHITE_RGB[1],
        WHITE_RGB[2],
        DIVIDER_OPACITY
    );
    const totalW =
      segments.reduce((sum, seg) => sum + measureTelemetrySegmentWidth(seg), 0) +
      CENTER_MODAL_TEL_GAP * Math.max(0, segments.length - 1);
    const startX = Math.round(W / 2 - totalW / 2);
    drawTelemetryRow(canvas, {startX, textY: boxY + CENTER_MODAL_TEL_Y, gap: CENTER_MODAL_TEL_GAP}, segments);
  }
}

/**
 * Draws the compact corner card for the 'detailed' theme using frosted-glass live/snapshot blur,
 * pre-baked Eufy status/telemetry sprites, and proportional anti-aliased UI glyphs.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer (modified in place).
 * @param {{ position: string, headerText: string, maxHeaderText: string, segments: Array<Record<string, *>>, blurBackdrop: boolean }} corner - Corner layout.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawCornerDetailedCard(canvas, corner, st) {
  const {boxW, boxH, hasTelemetry, gap} = computeCornerDetailedCardDimensions(
      corner.maxHeaderText,
      corner.segments
  );
  const {boxX, boxY} = getCardBoxCoords(corner.position, boxW, boxH);

  drawCardSurface(canvas, {boxX, boxY, boxW, boxH}, corner.blurBackdrop);
  drawStatusGlyph(
      canvas,
      {cx: boxX + DETAILED_STATUS_CX_OFFSET, cy: boxY + DETAILED_STATUS_CY_OFFSET, modal: false},
      st
  );
  drawUiText(canvas, {
    x: boxX + DETAILED_HEADER_X_OFFSET,
    y: boxY + DETAILED_HEADER_Y_OFFSET,
    text: corner.headerText,
    fontSize: UI_FONT_SIZES.SM,
    rgb: WHITE_RGB,
  });

  if (hasTelemetry) {
    fillYuvRect(
        canvas,
        boxX + DETAILED_DIVIDER_PAD_X,
        boxY + DETAILED_DIVIDER_Y_OFFSET,
        boxW - DETAILED_DIVIDER_PAD_X * 2,
        1,
        WHITE_RGB[0],
        WHITE_RGB[1],
        WHITE_RGB[2],
        DIVIDER_OPACITY
    );
    drawTelemetryRow(
        canvas,
        {startX: boxX + DETAILED_TEL_X_OFFSET, textY: boxY + DETAILED_TEL_Y_OFFSET, gap},
        corner.segments
    );
  }
}

/**
 * Renders a static YUV420p status frame according to card_theme ('detailed', 'icons', 'minimal',
 * 'debug', or 'none') and card_position, mutating targetBuf in-place when provided.
 *
 * @param {{ titleText: string, line1: string, line2: string }} copy - Card title and modal body strings.
 * @param {{ status: Record<string, *>|null, preparedBg: Uint8Array, hasBackground: boolean, targetBuf?: Uint8Array|null }} renderCtx - Background and buffer context.
 * @returns {Uint8Array} Raw YUV420p frame buffer of length FRAME.
 */
function renderSingleStatusCard(copy, renderCtx) {
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

  const st = evaluateTelemetryState(copy.titleText, status);

  switch (cardCfg.theme) {
    case CARD_THEMES.DEBUG:
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
    case CARD_THEMES.MINIMAL:
      drawMinimalDotsCard(canvas, {position: cardCfg.position, blurBackdrop: hasBackground}, st);
      return canvas;
    case CARD_THEMES.ICONS:
      drawIconsOnlyCard(canvas, {position: cardCfg.position, blurBackdrop: hasBackground}, st);
      return canvas;
    default:
      break;
  }

  const segments = buildTelemetrySegments(st);
  if (cardCfg.position !== CARD_POSITIONS.CENTER) {
    const camLabel = status && status.camTitle ? '  -  ' + status.camTitle : '';
    const maxHeaderText = CARD_STATUS_TITLES.ASLEEP_LOW_BATTERY + camLabel;
    drawCornerDetailedCard(
        canvas,
        {
          position: cardCfg.position,
          headerText: copy.titleText + camLabel,
          maxHeaderText,
          segments,
          blurBackdrop: hasBackground,
        },
        st
    );
    return canvas;
  }

  drawCenteredDetailedModal(
      canvas,
      {
        titleText: copy.titleText,
        line1: copy.line1,
        line2: copy.line2,
        segments,
        blurBackdrop: hasBackground,
      },
      st
  );
  return canvas;
}

/**
 * Renders the asleep, waking, and busy status cards for a camera using its Telemetry
 * and StatusCard domain models and a single shared background buffer.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function renderCameraCards(cam) {
  const ctx = cam.prepareCardRenderContext();
  const {baseCanvas, hasBackground} = prepareBackgroundCanvas(ctx.cardConfig, ctx.lastFrame);

  cam.commitRenderedCards(
      {
        asleep: renderSingleStatusCard(
            {
              titleText: ctx.asleepTitle,
              line1: 'No active stream on the ' + ctx.title + ' detect',
              line2: ctx.asleepLine2,
            },
            {status: ctx.status, preparedBg: baseCanvas, hasBackground, targetBuf: ctx.asleepBuf}
        ),
        waking: renderSingleStatusCard(
            {
              titleText: CARD_STATUS_TITLES.WAKING_UP,
              line1: 'Connecting to ' + ctx.title + ' P2P livestream,',
              line2: 'live video starts in a few seconds',
            },
            {status: ctx.status, preparedBg: baseCanvas, hasBackground, targetBuf: ctx.wakingBuf}
        ),
        busy: renderSingleStatusCard(
            {
              titleText: CARD_STATUS_TITLES.WAITING,
              line1: 'Another camera is currently live on the HomeBase,',
              line2: 'only one battery camera can stream at a time',
            },
            {status: ctx.status, preparedBg: baseCanvas, hasBackground, targetBuf: ctx.busyBuf}
        ),
        liveTelState: evaluateTelemetryState(CARD_STATUS_TITLES.LIVE, ctx.status),
        backfillTelState: evaluateTelemetryState(CARD_STATUS_TITLES.BACKFILL, ctx.status),
      },
      Date.now(),
      SHORT_KEYFRAME_BURST_MS
  );
}

/**
 * Composites the camera's corner status card (or bottom diagnostic HUD) onto a copy of a frame
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
  if (cam.card.theme === CARD_THEMES.DEBUG) {
    const isLive = cam.isStreamingLive(now, DEFAULT_LIVE_OVERLAY_MAX_AGE_MS);
    const {baseCanvas, hasBackground} = isLive
        ? {baseCanvas: rawFrame, hasBackground: true}
        : prepareBackgroundCanvas(cam.card.config, cam.lastFrame);
    const out = cam.card.prepareLiveOverlayBuffer(baseCanvas);
    const titleForState = isLive
        ? cam.isBackfillPlayback()
            ? CARD_STATUS_TITLES.BACKFILL
            : CARD_STATUS_TITLES.LIVE
        : cam.active && !cam.isBackfillPlayback()
            ? CARD_STATUS_TITLES.WAKING_UP
            : cam.isWaitingForSlotOrBackfill(now)
                ? CARD_STATUS_TITLES.WAITING
                : cam.hasServiceDisruption()
                    ? CARD_STATUS_TITLES.DISCONNECTED
                    : cam.isLowBattery()
                        ? CARD_STATUS_TITLES.ASLEEP_LOW_BATTERY
                        : CARD_STATUS_TITLES.ASLEEP;
    const st = cam.telemetry.evaluateVisualState(titleForState);
    const stageMarker =
        isLive || cam.gotVideo ? cam.getFrameMarker() : FRAME_STAGE_MARKERS.SNAPSHOT;
    drawDebugHudCard(
        out,
        {
          position: cam.card.position,
          blurBackdrop: hasBackground,
          cam,
          frameMarker: stageMarker,
          now,
        },
        st
    );
    return out;
  }

  const {out, theme, position, camTitle, statusTitle, st} =
      cam.prepareLiveCardOverlay(rawFrame);

  switch (theme) {
    case CARD_THEMES.MINIMAL:
      drawMinimalDotsCard(out, {position, blurBackdrop: true}, st);
      return out;
    case CARD_THEMES.ICONS:
      drawIconsOnlyCard(out, {position, blurBackdrop: true}, st);
      return out;
    case CARD_THEMES.DETAILED: {
      const camLabel = camTitle ? '  -  ' + camTitle : '';
      drawCornerDetailedCard(
          out,
          {
            position,
            headerText: statusTitle + camLabel,
            maxHeaderText: CARD_STATUS_TITLES.ASLEEP_LOW_BATTERY + camLabel,
            segments: buildTelemetrySegments(st),
            blurBackdrop: true,
          },
          st
      );
      return out;
    }
    default:
      return rawFrame;
  }
}

module.exports = {
  renderCameraCards,
  renderLiveFrameWithCard,
};
