// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Status card rendering engine ('detailed', 'icons', 'minimal', 'none')
 * and live-stream corner overlay compositing.
 */
'use strict';

const fs = require('fs');
const {spawnSync} = require('child_process');
const {
  cfg,
  clampNum,
  W,
  H,
  FRAME,
  COLOR_GREY,
  SHORT_KEYFRAME_BURST_MS,
  MAX_FFMPEG_BUFFER_MULTIPLIER,
  resolveCardConfig,
} = require('../config');
const {log} = require('../logger');
const {
  TEL_BAT_LABEL_OFFSET_X,
  TEL_WIFI_LABEL_OFFSET_X,
  evaluateTelemetryState,
  buildTelemetrySegments,
} = require('../domain/telemetry');
const {
  DETAILED_CORNER_CARD_RADIUS,
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
  getCardBoxCoords,
} = require('../domain/status-card');
const {
  blendYuvPixel,
  fillYuvRect,
  drawYuvCircle,
  drawYuvLine,
  drawRoundedBox,
  prepareBackgroundCanvas,
  copyRoundedYuvRegion,
} = require('./yuv-canvas');

/** @typedef {import("../domain/camera").Camera} Camera */

const CENTER_MODAL_WIDTH = 820;
const CENTER_MODAL_HEIGHT_WITH_TEL = 336;
const CENTER_MODAL_HEIGHT_NO_TEL = 268;
const MINIMAL_DOT_OUTER_RADIUS = 6.8;
const MINIMAL_BULLSEYE_GAP_RADIUS = 4.3;
const MINIMAL_BULLSEYE_KERNEL_RADIUS = 3.4;

/**
 * Draws an anti-aliased filled right-pointing play triangle centered at (cx, cy).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} scale - Size multiplier (1.0 = 20x20 icon, 3.0 = 60x60 modal icon).
 * @param {number[]} rgb - RGB color array [r, g, b].
 */
function drawFilledPlayTriangle(canvas, cx, cy, scale, rgb) {
  const [r, g, b] = rgb;
  const xLeft = Math.round(cx - 4.8 * scale);
  const xRight = Math.round(cx + 6.2 * scale);
  const halfH = 6.6 * scale;
  const width = Math.max(1, xRight - xLeft);

  for (let x = xLeft; x <= xRight; x++) {
    const progress = (x - xLeft) / width;
    const span = halfH * (1 - progress);
    const yMin = Math.floor(cy - span - 1);
    const yMax = Math.ceil(cy + span + 1);
    for (let y = yMin; y <= yMax; y++) {
      const cov = Math.min(1, Math.max(0, span + 0.5 - Math.abs(y - cy)));
      if (cov > 0) {
        blendYuvPixel(canvas, x, y, r, g, b, 0.96 * cov);
      }
    }
  }
}

/**
 * Draws a single anti-aliased filled left-pointing triangle between xApex (left) and xBase (right).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} xApex - Left apex X coordinate.
 * @param {number} xBase - Right base X coordinate.
 * @param {number} cy - Vertical center Y coordinate.
 * @param {number} halfH - Half-height of the triangle base in pixels.
 * @param {number[]} rgb - RGB color array [r, g, b].
 */
function drawLeftRewindTriangle(canvas, xApex, xBase, cy, halfH, rgb) {
  const [r, g, b] = rgb;
  const width = Math.max(1, xBase - xApex);
  for (let x = xApex; x <= xBase; x++) {
    const progress = (x - xApex) / width;
    const span = halfH * progress;
    const yMin = Math.floor(cy - span - 1);
    const yMax = Math.ceil(cy + span + 1);
    for (let y = yMin; y <= yMax; y++) {
      const cov = Math.min(1, Math.max(0, span + 0.5 - Math.abs(y - cy)));
      if (cov > 0) {
        blendYuvPixel(canvas, x, y, r, g, b, 0.96 * cov);
      }
    }
  }
}

/**
 * Draws an anti-aliased double left-pointing rewind icon centered at (cx, cy).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} scale - Size multiplier (1.0 = 20x20 icon, 3.0 = 60x60 modal icon).
 * @param {number[]} rgb - RGB color array [r, g, b].
 */
function drawRewindGlyph(canvas, cx, cy, scale, rgb) {
  const halfH = 5.8 * scale;
  const leftApex = Math.round(cx - 7.4 * scale);
  const leftBase = Math.round(cx - 0.2 * scale);
  const rightApex = Math.round(cx - 0.6 * scale);
  const rightBase = Math.round(cx + 6.8 * scale);
  drawLeftRewindTriangle(canvas, leftApex, leftBase, cy, halfH, rgb);
  drawLeftRewindTriangle(canvas, rightApex, rightBase, cy, halfH, rgb);
}

/**
 * Draws the status glyph for 'icons' and centered 'detailed' themes:
 *   - 'live': Filled Play triangle (Red)
 *   - 'backfill': Filled Rewind double-triangle (Red)
 *   - 'waking': Solid circle dot (Blue) matching minimal and corner detailed themes
 *   - 'asleep' / 'waiting' / 'low': Pause bars (Grey / Yellow / Purple)
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} scale - Size multiplier (1.0 = 20x20 icon, 3.0 = 60x60 modal icon).
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawStatusGlyph(canvas, cx, cy, scale, st) {
  switch (st.statusKind) {
    case 'live':
      drawFilledPlayTriangle(canvas, cx, cy, scale, st.statusRgb);
      return;
    case 'backfill':
      drawRewindGlyph(canvas, cx, cy, scale, st.statusRgb);
      return;
    case 'waking':
      drawYuvCircle(canvas, cx, cy, 5.6 * scale, st.statusRgb, 0.96);
      return;
    default:
      break;
  }

  const barW = Math.max(3, Math.round(3.4 * scale));
  const barH = Math.round(12.0 * scale);
  const gapHalf = Math.max(2, Math.round(2.2 * scale));
  const topY = cy - barH / 2;

  fillYuvRect(
      canvas,
      cx - gapHalf - barW,
      topY,
      barW,
      barH,
      st.statusRgb[0],
      st.statusRgb[1],
      st.statusRgb[2],
      0.95
  );
  fillYuvRect(
      canvas,
      cx + gapHalf,
      topY,
      barW,
      barH,
      st.statusRgb[0],
      st.statusRgb[1],
      st.statusRgb[2],
      0.95
  );
}

/**
 * Draws a 37x16 vector battery icon with a proportional inner charge bar
 * and optional charging bolt.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} bx - Left X coordinate of the battery shell.
 * @param {number} batY - Top Y coordinate of the battery shell.
 * @param {number} batPct - Battery percentage (0..100).
 * @param {number[]} shellRgb - RGB color array [r, g, b] for the shell outline.
 * @param {number[]} fillRgb - RGB color array [r, g, b] for the inner charge bar.
 * @param {boolean} showBolt - Whether to draw a charging bolt across the center of the battery.
 */
function drawBatteryIcon(canvas, bx, batY, batPct, shellRgb, fillRgb, showBolt) {
  const [sr, sg, sb] = shellRgb;
  const [fr, fg, fb] = fillRgb;
  fillYuvRect(canvas, bx, batY, 34, 2, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx, batY + 14, 34, 2, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx, batY + 2, 2, 12, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx + 32, batY + 2, 2, 12, sr, sg, sb, 0.92);
  fillYuvRect(canvas, bx + 34, batY + 5, 3, 6, sr, sg, sb, 0.92);
  const fillW = Math.max(3, Math.round((26 * batPct) / 100));
  fillYuvRect(canvas, bx + 4, batY + 4, fillW, 8, fr, fg, fb, 0.95);
  if (showBolt) {
    drawYuvLine(canvas, bx + 18, batY + 3, bx + 14, batY + 8, 1.1, [20, 20, 24], 0.95);
    drawYuvLine(canvas, bx + 14, batY + 8, bx + 19, batY + 8, 1.1, [20, 20, 24], 0.95);
    drawYuvLine(canvas, bx + 19, batY + 8, bx + 15, batY + 13, 1.1, [20, 20, 24], 0.95);
  }
}

/**
 * Draws a curved Wi-Fi signal icon (base dot + 3 concentric upper-sector wave arcs)
 * colored by RSSI/signal quality.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Horizontal center X coordinate of the Wi-Fi fan.
 * @param {number} bottomY - Vertical Y coordinate of the bottom apex dot.
 * @param {number} wifiBars - Number of lit signal levels (0..4).
 * @param {number[]} rgb - Active signal RGB color array [r, g, b].
 */
function drawWifiArcsIcon(canvas, cx, bottomY, wifiBars, rgb) {
  const dotLit = wifiBars >= 1;
  const unlitRgb = [113, 113, 122];
  drawYuvCircle(canvas, cx, bottomY, 2.1, dotLit ? rgb : unlitRgb, dotLit ? 0.96 : 0.45);

  const radii = [5.4, 9.2, 13.0];
  const strokeHalf = 1.25;
  for (let i = 0; i < 3; i++) {
    const rad = radii[i];
    const lit = wifiBars >= i + 2;
    const [r, g, b] = lit ? rgb : unlitRgb;
    const alpha = lit ? 0.95 : 0.42;
    const pad = Math.ceil(rad + strokeHalf + 1);
    for (let y = Math.floor(bottomY - pad); y <= Math.ceil(bottomY + 1); y++) {
      for (let x = Math.floor(cx - pad); x <= Math.ceil(cx + pad); x++) {
        const dx = x - cx;
        const dy = y - bottomY;
        const angle = Math.atan2(dy, dx);
        if (angle >= -2.38 && angle <= -0.76) {
          const d = Math.hypot(dx, dy);
          const cov = Math.min(1, Math.max(0, strokeHalf + 0.5 - Math.abs(d - rad)));
          if (cov > 0) {
            blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
          }
        }
      }
    }
  }
}

/**
 * Draws the vector battery icon and curved Wi-Fi arc icon alongside their text labels
 * for the 'detailed' theme.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {Array<Record<string, *>>} segments - Telemetry segments from buildTelemetrySegments().
 * @param {number} startX - Left X coordinate where the telemetry row begins.
 * @param {number} textY - Top Y coordinate for 20px drawtext strings.
 * @param {number} gap - Horizontal pixel gap between segments.
 * @param {Function} buildDrawtext - Helper that formats a drawtext filter string.
 * @returns {string[]} Array of FFmpeg drawtext filter strings.
 */
function drawTelemetryRow(canvas, segments, startX, textY, gap, buildDrawtext) {
  const filters = [];
  const textBaselineY = textY + 14;
  let cursorX = startX;

  for (const seg of segments) {
    switch (seg.type) {
      case 'bat':
        drawBatteryIcon(canvas, cursorX, textY - 1, seg.batPct, seg.batRgb, seg.batRgb, Boolean(seg.showBolt));
        filters.push(buildDrawtext(seg.label, seg.batHex, 20, String(cursorX + TEL_BAT_LABEL_OFFSET_X), textY));
        break;
      case 'wifi':
        drawWifiArcsIcon(canvas, cursorX + 16, textBaselineY - 1, seg.wifiBars, seg.wifiRgb);
        filters.push(buildDrawtext(seg.label, '0xd4d4d8', 20, String(cursorX + TEL_WIFI_LABEL_OFFSET_X), textY));
        break;
      case 'temp':
        filters.push(buildDrawtext(seg.label, seg.tempHex, 20, String(cursorX), textY));
        break;
      case 'seen':
        filters.push(buildDrawtext(seg.label, '0xa1a1aa', 20, String(cursorX), textY));
        break;
      default:
        break;
    }
    cursorX += seg.width + gap;
  }

  return filters;
}

/**
 * Renders the 'minimal' three-dot theme with graduated status dots inside a capsule.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {string} position - Placement ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 */
function drawMinimalDotsCard(canvas, position, st, blurBackdrop = true) {
  const boxW = MINIMAL_CARD_WIDTH;
  const boxH = MINIMAL_CARD_HEIGHT;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 18, 0.42, 0.16, blurBackdrop);

  const cy = boxY + 18;
  const statusCx = boxX + 22;
  drawYuvCircle(canvas, statusCx, cy, MINIMAL_DOT_OUTER_RADIUS, st.statusRgb, 0.96);
  if (st.statusKind === 'backfill') {
    drawYuvCircle(canvas, statusCx, cy, MINIMAL_BULLSEYE_GAP_RADIUS, [20, 20, 24], 0.96);
    drawYuvCircle(canvas, statusCx, cy, MINIMAL_BULLSEYE_KERNEL_RADIUS, COLOR_GREY, 0.98);
  }
  drawYuvCircle(canvas, boxX + 46, cy, 6.0, st.batRgb, 0.96);
  drawYuvCircle(canvas, boxX + 70, cy, 5.2, st.wifiRgb, 0.96);
}

/**
 * Draws a 16x20 vector thermometer icon with tick marks and proportional mercury bar.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cursorX - Left X coordinate.
 * @param {number} cy - Vertical center Y coordinate.
 * @param {Record<string, *>} st - Evaluated telemetry state.
 */
function drawThermometerIcon(canvas, cursorX, cy, st) {
  const thermCx = cursorX + 6;
  const bulbCy = cy + 5;
  const stemTop = cy - 9;
  const [tr, tg, tb] = st.tempRgb;

  fillYuvRect(canvas, thermCx - 3, stemTop, 6, 12, tr, tg, tb, 0.85);
  fillYuvRect(canvas, thermCx - 1, stemTop + 2, 2, 10, 24, 24, 28, 0.9);
  fillYuvRect(canvas, thermCx + 5, stemTop + 2, 3, 1, tr, tg, tb, 0.8);
  fillYuvRect(canvas, thermCx + 5, stemTop + 5, 3, 1, tr, tg, tb, 0.8);
  fillYuvRect(canvas, thermCx + 5, stemTop + 8, 3, 1, tr, tg, tb, 0.8);
  drawYuvCircle(canvas, thermCx, bulbCy, 4.8, st.tempRgb, 0.92);
  drawYuvCircle(canvas, thermCx, bulbCy, 3.2, st.tempRgb, 0.98);

  const clampedTemp = clampNum(st.tempNum, 0, 50, 22);
  const mercuryH = Math.max(2, Math.round((clampedTemp / 50) * 10));
  fillYuvRect(canvas, thermCx - 1, bulbCy - 2 - mercuryH, 2, mercuryH + 2, tr, tg, tb, 0.95);
}

/**
 * Draws a 20x20 filled analog clock icon with hands positioned to the HH:MM lastSeen time.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cursorX - Left X coordinate.
 * @param {number} cy - Vertical center Y coordinate.
 * @param {string} seenVal - Formatted 'HH:MM' string.
 */
function drawAnalogClockIcon(canvas, cursorX, cy, seenVal) {
  const clockCx = cursorX + 10;
  drawYuvCircle(canvas, clockCx, cy, 8.5, [244, 244, 245], 0.95);

  const match = /^(\d{1,2}):(\d{2})/.exec(String(seenVal || ''));
  const hours = match ? Number(match[1]) % 12 : 4;
  const mins = match ? Number(match[2]) % 60 : 20;
  const hourAngle = ((hours + mins / 60) / 12) * Math.PI * 2 - Math.PI / 2;
  const minAngle = (mins / 60) * Math.PI * 2 - Math.PI / 2;

  drawYuvLine(
      canvas,
      clockCx,
      cy,
      clockCx + Math.cos(hourAngle) * 4.4,
      cy + Math.sin(hourAngle) * 4.4,
      1.2,
      [24, 24, 27],
      0.95
  );
  drawYuvLine(
      canvas,
      clockCx,
      cy,
      clockCx + Math.cos(minAngle) * 6.2,
      cy + Math.sin(minAngle) * 6.2,
      1.0,
      [24, 24, 27],
      0.95
  );
}

/**
 * Renders the 'icons' theme: converts all enabled status and telemetry items into crisp
 * vector icons inside a full-radius capsule with zero text and no FFmpeg subprocess.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {string} position - Placement ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 */
function drawIconsOnlyCard(canvas, position, st, blurBackdrop = true) {
  const {telCfg} = st;
  const showBat = telCfg.enabled && telCfg.battery && st.hasBat;
  const showWifi = telCfg.enabled && telCfg.wifi && (st.hasWifi || st.hasRssi);
  const showTemp = telCfg.enabled && telCfg.temperature && st.hasTemp;
  const showClock = telCfg.enabled && telCfg.lastSeen && Boolean(st.seenVal);

  const boxW = computeIconsCardWidth({showBat, showWifi, showTemp, showClock});
  const boxH = ICONS_CARD_HEIGHT;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);
  const cy = boxY + 22;

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 22, 0.44, 0.16, blurBackdrop);

  let cursorX = boxX + ICONS_CARD_PAD_X;
  drawStatusGlyph(canvas, cursorX + 10, cy, 1.0, st);
  cursorX += ICONS_STATUS_WIDTH + ICONS_CARD_ITEM_GAP;

  if (showBat) {
    const showBolt = Boolean(telCfg.powerSource && (st.charging || st.powerLabel));
    drawBatteryIcon(canvas, cursorX, cy - 8, st.batPct, st.batRgb, st.batRgb, showBolt);
    cursorX += ICONS_BATTERY_WIDTH + ICONS_CARD_ITEM_GAP;
  }

  if (showWifi) {
    drawWifiArcsIcon(canvas, cursorX + 14, cy + 7, st.wifiBars, st.wifiRgb);
    cursorX += ICONS_WIFI_WIDTH + ICONS_CARD_ITEM_GAP;
  }

  if (showTemp) {
    drawThermometerIcon(canvas, cursorX, cy, st);
    cursorX += ICONS_TEMP_WIDTH + ICONS_CARD_ITEM_GAP;
  }

  if (showClock) {
    drawAnalogClockIcon(canvas, cursorX, cy, st.seenVal);
  }
}

/**
 * Composites the centered rounded translucent modal box ('detailed' theme at 'center' position),
 * the color-coded status glyph, and the baseline-aligned telemetry icons onto the canvas.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer (modified in place).
 * @param {number} boxX - Left coordinate of the centered modal box.
 * @param {number} boxY - Top coordinate of the centered modal box.
 * @param {number} boxW - Width of the centered modal box.
 * @param {number} boxH - Height of the centered modal box.
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @param {Array<Record<string, *>>} segments - Telemetry segments from buildTelemetrySegments().
 * @param {Function} buildDrawtext - Helper that formats a drawtext filter string.
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 * @returns {string[]} Array of FFmpeg drawtext filter strings for the telemetry row.
 */
function drawFrigateModalGraphics(canvas, boxX, boxY, boxW, boxH, st, segments, buildDrawtext, blurBackdrop = true) {
  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 26, 0.56, 0.16, blurBackdrop);
  drawStatusGlyph(canvas, W / 2, boxY + 114, 3.0, st);

  if (!segments.length) {
    return [];
  }

  fillYuvRect(canvas, boxX + 44, boxY + 254, boxW - 88, 1, 255, 255, 255, 0.16);
  const gap = 32;
  const totalW = segments.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, segments.length - 1);
  const startX = Math.round(W / 2 - totalW / 2);
  return drawTelemetryRow(canvas, segments, startX, boxY + 278, gap, buildDrawtext);
}

/**
 * Draws the compact corner card for the 'detailed' theme when card_position is one of the
 * four corners ('top-left', 'top-right', 'bottom-left', 'bottom-right').
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer (modified in place).
 * @param {string} position - Corner name ('top-left', 'top-right', 'bottom-left', 'bottom-right').
 * @param {string} headerText - Status and camera title shown on the top line of the card.
 * @param {number[]} dotRgb - RGB color array [r, g, b] for the status indicator dot.
 * @param {Array<Record<string, *>>} segments - Telemetry segments from buildTelemetrySegments().
 * @param {Function} buildDrawtext - Helper that formats a drawtext filter string.
 * @param {boolean} [blurBackdrop=true] - Whether to blur the underlying snapshot pixels.
 * @returns {string[]} Array of FFmpeg drawtext filter strings for the corner card.
 */
function drawCornerDetailedCard(
    canvas,
    position,
    headerText,
    maxHeaderText,
    st,
    segments,
    buildDrawtext,
    blurBackdrop = true
) {
  const {boxW, boxH, hasTelemetry, gap} = computeCornerDetailedCardDimensions(maxHeaderText, segments);
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, DETAILED_CORNER_CARD_RADIUS, 0.58, 0.16, blurBackdrop);
  if (st.statusKind === 'backfill') {
    drawRewindGlyph(canvas, boxX + 26, boxY + 23, 0.95, st.statusRgb);
  } else {
    drawYuvCircle(canvas, boxX + 26, boxY + 23, 5.6, st.statusRgb, 0.96);
  }

  const filters = [buildDrawtext(headerText, '0xffffff', 20, String(boxX + 42), boxY + 15)];
  if (hasTelemetry) {
    fillYuvRect(canvas, boxX + 20, boxY + 44, boxW - 40, 1, 255, 255, 255, 0.16);
    filters.push(...drawTelemetryRow(canvas, segments, boxX + 22, boxY + 54, gap, buildDrawtext));
  }
  return filters;
}

/**
 * Locates the first available TrueType font file on disk for the 'detailed' text theme.
 *
 * @returns {string|undefined}
 */
function findAvailableFontFile() {
  const candidates = [
    cfg.font_file,
    process.env.FONT_FILE,
    '/usr/share/fonts/Inter.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
  ].filter(Boolean);

  return candidates.find((filePath) => fs.existsSync(filePath));
}

/**
 * Renders a static YUV420p status frame according to card_theme ('detailed', 'icons', 'minimal',
 * or 'none') and card_position ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 *
 * @param {string} titleText - Heading displayed on the card (e.g., "Asleep").
 * @param {string} line1 - First line of descriptive text below the circular icon.
 * @param {string} line2 - Second line of descriptive text.
 * @param {Record<string, *>|null} status - Camera telemetry and config flags.
 * @param {Uint8Array} preparedBg - Pre-dimmed YUV420p background frame from prepareBackgroundCanvas().
 * @param {boolean} hasBackground - Whether preparedBg contains a camera snapshot.
 * @returns {Uint8Array} Raw YUV420p frame buffer of length FRAME.
 */
function card(titleText, line1, line2, status, preparedBg, hasBackground) {
  const camScope = (status && status.camName) || 'bridge';
  const cardCfg = (status && status.cardCfg) || resolveCardConfig({});
  const canvas = Buffer.allocUnsafe(FRAME);
  preparedBg.copy(canvas);

  if (cardCfg.theme === 'none') {
    return canvas;
  }

  const st = evaluateTelemetryState(titleText, status);

  switch (cardCfg.theme) {
    case 'minimal':
      drawMinimalDotsCard(canvas, cardCfg.position, st, hasBackground);
      return canvas;
    case 'icons':
      drawIconsOnlyCard(canvas, cardCfg.position, st, hasBackground);
      return canvas;
    default:
      break;
  }

  const font = findAvailableFontFile();
  if (!font) {
    log.warn(camScope, 'no TrueType font found for detailed theme, falling back to vector icons card');
    drawIconsOnlyCard(canvas, cardCfg.position, st, hasBackground);
    return canvas;
  }

  const esc = (t) => String(t).replace(/[\\']/g, ' ').replace(/:/g, '\\:');
  const buildDrawtext = (text, color, size, xExpr, yVal) =>
      'drawtext=fontfile=' +
      font +
      ':expansion=none:text=\'' +
      esc(text) +
      '\':fontcolor=' +
      color +
      ':fontsize=' +
      size +
      ':x=' +
      xExpr +
      ':y=' +
      yVal;

  const segments = buildTelemetrySegments(st);
  const hasTelemetry = segments.length > 0;
  const drawtextList = ['format=yuv420p'];

  if (cardCfg.position !== 'center') {
    const camLabel = status && status.camTitle ? '  -  ' + status.camTitle : '';
    const maxHeaderText = 'Asleep (Low Battery)' + camLabel;
    drawtextList.push(
        ...drawCornerDetailedCard(
            canvas,
            cardCfg.position,
            titleText + camLabel,
            maxHeaderText,
            st,
            segments,
            buildDrawtext,
            hasBackground
        )
    );
  } else {
    const boxW = CENTER_MODAL_WIDTH;
    const boxH = hasTelemetry ? CENTER_MODAL_HEIGHT_WITH_TEL : CENTER_MODAL_HEIGHT_NO_TEL;
    const {boxX, boxY} = getCardBoxCoords('center', boxW, boxH);
    const modalTelFilters = drawFrigateModalGraphics(
        canvas,
        boxX,
        boxY,
        boxW,
        boxH,
        st,
        segments,
        buildDrawtext,
        hasBackground
    );
    drawtextList.push(
        buildDrawtext(titleText, '0xffffff', 36, '(w-text_w)/2', boxY + 30),
        buildDrawtext(line1, '0xe4e4e7', 24, '(w-text_w)/2', boxY + 168),
        buildDrawtext(line2, '0xe4e4e7', 24, '(w-text_w)/2', boxY + 204),
        ...modalTelFilters
    );
  }

  const r = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        W + 'x' + H,
        '-i',
        'pipe:0',
        '-vf',
        drawtextList.join(','),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      {input: canvas, maxBuffer: FRAME * MAX_FFMPEG_BUFFER_MULTIPLIER}
  );

  if (r.status === 0 && Buffer.isBuffer(r.stdout) && r.stdout.length === FRAME) {
    return r.stdout;
  }

  log.warn(
      camScope,
      'could not render text card (' +
      titleText +
      '), using plain backdrop: ' +
      String(r.stderr || '').trim().split('\n').pop()
  );
  return canvas;
}

/**
 * Renders the asleep, waking, busy, and live-corner status cards for a camera using its
 * Telemetry and StatusCard domain models and a single shared background buffer.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function renderCameraCards(cam) {
  const title = cam.getDisplayTitle();
  const lowBat = cam.isLowBattery();
  const status = cam.telemetry.toStatusSnapshot(cam.name, title, cam.card.config);
  const {baseCanvas, hasBackground} = prepareBackgroundCanvas(cam.card.config, cam.lastFrame);

  const asleepTitle = lowBat ? 'Asleep (Low Battery)' : 'Asleep';
  const asleepLine2 = !cam.canWakeOnViewerInLowBattery()
      ? 'economy mode active, waking on motion events only'
      : 'feed, open this camera to wake it, or wait for motion';

  cam.card.setRenderedFrames({
    asleep: card(
        asleepTitle,
        'No active stream on the ' + title + ' detect',
        asleepLine2,
        status,
      baseCanvas,
      hasBackground
    ),
    waking: card(
        'Waking Up...',
        'Connecting to ' + title + ' P2P livestream,',
        'live video starts in a few seconds',
        status,
        baseCanvas,
        hasBackground
    ),
    busy: card(
        'Waiting',
        'Another camera is currently live on the HomeBase,',
        'only one battery camera can stream at a time',
        status,
        baseCanvas,
        hasBackground
    ),
    liveTelState: evaluateTelemetryState('Live', status),
    backfillTelState: evaluateTelemetryState('Backfill', status),
    liveCard: cam.card.needsDetailedLiveCard()
        ? card('Live', '', '', status, baseCanvas, hasBackground)
        : null,
    backfillCard: cam.card.needsDetailedLiveCard()
        ? card('Backfill', '', '', status, baseCanvas, hasBackground)
        : null,
  });
  cam.triggerKeyframeBurst(Date.now(), SHORT_KEYFRAME_BURST_MS);
}

/**
 * Composites the camera's corner status card onto a copy of a live video frame when
 * card_show_on_live is enabled, leaving the original raw frame (and cam.lastFrame) untouched.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {Uint8Array} rawFrame - Clean decoded YUV420p video frame.
 * @returns {Uint8Array} YUV420p frame buffer with corner overlay applied (or rawFrame if disabled).
 */
function renderLiveFrameWithCard(cam, rawFrame) {
  if (!cam.card.shouldOverlayOnLive()) {
    return rawFrame;
  }
  const out = cam.card.prepareLiveOverlayBuffer(rawFrame);
  const isBackfill = cam.isBackfillPlayback();
  const st = isBackfill
      ? cam.card.backfillTelState || cam.telemetry.evaluateVisualState('Backfill')
      : cam.card.liveTelState || cam.telemetry.evaluateVisualState('Live');

  switch (cam.card.theme) {
    case 'minimal':
      drawMinimalDotsCard(out, cam.card.position, st, true);
      return out;
    case 'icons':
      drawIconsOnlyCard(out, cam.card.position, st, true);
      return out;
    case 'detailed': {
      const activeCardBuf = isBackfill ? cam.card.backfillCard : cam.card.liveCard;
      if (Buffer.isBuffer(activeCardBuf)) {
        const bounds = cam.getCardBounds();
        if (bounds) {
          copyRoundedYuvRegion(
              activeCardBuf,
              out,
              bounds.boxX,
              bounds.boxY,
              bounds.boxW,
              bounds.boxH,
              DETAILED_CORNER_CARD_RADIUS
          );
        }
        return out;
      }
      return rawFrame;
    }
    default:
      return rawFrame;
  }
}

module.exports = {
  renderCameraCards,
  renderLiveFrameWithCard,
};
