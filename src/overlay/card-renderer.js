// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Status card rendering engine ('default', 'icons', 'minimal', 'none'),
 * 4-color semantic telemetry evaluation, live-stream corner overlays,
 * and Frigate motion/object mask polygon calculation.
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
  LOW_BAT_THRESHOLD,
  LOW_BAT_WAKE_ON_VIEW,
  COLOR_GREEN,
  COLOR_BLUE,
  COLOR_YELLOW,
  COLOR_RED,
  resolveCardConfig,
} = require('../config');
const {log} = require('../logger');
const {isLowBattery} = require('../domain/camera');
const {
  fillYuvRect,
  drawYuvCircle,
  drawYuvRing,
  drawYuvLine,
  drawRoundedBox,
  getCardBoxCoords,
  prepareBackgroundCanvas,
  copyYuvRegion,
} = require('./yuv-canvas');

/**
 * Draws the color-coded status ring and inner state glyph (dot for Asleep/Low-Battery,
 * play triangle for Waking Up / Live, pause bars for Waiting) at the requested scale.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} scale - Size multiplier (1.0 = 20x20 icon, 3.0 = 60x60 modal icon).
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 */
function drawStatusGlyph(canvas, cx, cy, scale, st) {
  drawYuvRing(canvas, cx, cy, 8.2 * scale, Math.max(1.4, 1.1 * scale), st.statusRgb, 0.96);

  if (st.statusKind === 'waiting') {
    const barW = Math.max(2, Math.round(2.2 * scale));
    const barH = Math.round(8.0 * scale);
    const offset = Math.round(3.0 * scale);
    fillYuvRect(
        canvas,
        cx - offset,
        cy - barH / 2,
        barW,
        barH,
        st.statusRgb[0],
        st.statusRgb[1],
        st.statusRgb[2],
        0.95
    );
    fillYuvRect(
        canvas,
        cx + offset - barW,
        cy - barH / 2,
        barW,
        barH,
        st.statusRgb[0],
        st.statusRgb[1],
        st.statusRgb[2],
        0.95
    );
  } else if (st.statusKind === 'waking' || st.statusKind === 'live') {
    const xLeft = cx - 2.2 * scale;
    const xRight = cx + 3.6 * scale;
    const yHalf = 3.6 * scale;
    const stroke = Math.max(1.3, 1.1 * scale);
    drawYuvLine(canvas, xLeft, cy - yHalf, xRight, cy, stroke, st.statusRgb, 0.96);
    drawYuvLine(canvas, xRight, cy, xLeft, cy + yHalf, stroke, st.statusRgb, 0.96);
    drawYuvLine(canvas, xLeft, cy - yHalf, xLeft, cy + yHalf, stroke, st.statusRgb, 0.96);
  } else {
    drawYuvCircle(canvas, cx, cy, 4.0 * scale, st.statusRgb, 0.96);
  }
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
  drawYuvCircle(canvas, cx, bottomY, 2.1, dotLit ? rgb : [113, 113, 122], dotLit ? 0.96 : 0.45);

  const radii = [5.4, 9.2, 13.0];
  const strokeHalf = 1.25;
  for (let i = 0; i < 3; i++) {
    const rad = radii[i];
    const lit = wifiBars >= i + 2;
    const [r, g, b] = lit ? rgb : [113, 113, 122];
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
            const {blendYuvPixel} = require('./yuv-canvas');
            blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
          }
        }
      }
    }
  }
}

/**
 * Evaluates the 4-color semantic state (Green, Blue, Yellow, Red) for camera status,
 * battery, Wi-Fi/RSSI, and temperature.
 *
 * @param {string} titleText - Card heading ('Asleep', 'Waking Up...', 'Waiting', 'Live', etc.).
 * @param {Record<string, *>|null} status - Camera telemetry state object.
 * @returns {Record<string, *>} Evaluated values and RGB colors for status, battery, wifi, temp, and lastSeen.
 */
function evaluateTelemetryState(titleText, status) {
  const telCfg = status && status.telCfg ? status.telCfg : {enabled: false};
  const batRaw = status && status.battery != null ? status.battery : null;
  const wifiRaw = status && status.wifi != null ? status.wifi : null;
  const rssiRaw = status && status.rssi != null ? status.rssi : null;
  const tempRaw = status && status.temp != null ? status.temp : null;
  const seenRaw = status && status.lastSeen ? status.lastSeen : '';
  const charging = Boolean(status && status.charging);
  const economyMode = Boolean(status && status.economyMode);

  // 1. Camera Status Color: Green = Asleep, Blue = Waking Up / Live, Yellow = Waiting, Red = Low-Bat Eco.
  const statusKind = /^Live\b/i.test(titleText)
      ? 'live'
      : /Waking/i.test(titleText)
          ? 'waking'
          : /Waiting/i.test(titleText)
              ? 'waiting'
              : economyMode || /Low Battery/i.test(titleText)
                  ? 'low'
                  : 'asleep';
  const statusRgb =
      statusKind === 'waking' || statusKind === 'live'
          ? COLOR_BLUE
          : statusKind === 'waiting'
              ? COLOR_YELLOW
              : statusKind === 'low'
                  ? COLOR_RED
                  : COLOR_GREEN;

  // 2. Battery Color: Blue = Charging/Solar/Plugged, Green >= 50%, Yellow 21..49%, Red <= 20% or n/a.
  const redBatCutoff = LOW_BAT_THRESHOLD > 0 ? LOW_BAT_THRESHOLD : 20;
  const hasBat = batRaw != null && !Number.isNaN(Number(batRaw));
  const batPct = hasBat ? clampNum(Math.round(Number(batRaw)), 0, 100, 0) : 0;
  const batRgb = charging
      ? COLOR_BLUE
      : !hasBat || batPct <= redBatCutoff
          ? COLOR_RED
          : batPct >= 50
              ? COLOR_GREEN
              : COLOR_YELLOW;
  const batHex = charging
      ? '0x38bdf8'
      : !hasBat || batPct <= redBatCutoff
          ? '0xf87171'
          : batPct >= 50
              ? '0x4ade80'
              : '0xfacc15';

  // 3. Wi-Fi & RSSI Color: Green = Strong (>= -65dBm or 4/4), Blue = Good (-66..-72dBm or 3/4),
  // Yellow = Fair (-73..-80dBm or 2/4), Red = Poor (< -80dBm or 0-1/4).
  const hasWifi = wifiRaw != null && !Number.isNaN(Number(wifiRaw));
  const hasRssi = rssiRaw != null && !Number.isNaN(Number(rssiRaw));
  const rssiNum = hasRssi ? Math.round(Number(rssiRaw)) : null;
  const wifiBars = hasWifi
      ? clampNum(Math.round(Number(wifiRaw)), 0, 4, 0)
      : hasRssi
          ? rssiNum >= -65
              ? 4
              : rssiNum >= -72
                  ? 3
                  : rssiNum >= -80
                      ? 2
                      : 1
          : 0;
  const wifiRgb = hasRssi
      ? rssiNum >= -65
          ? COLOR_GREEN
          : rssiNum >= -72
              ? COLOR_BLUE
              : rssiNum >= -80
                  ? COLOR_YELLOW
                  : COLOR_RED
      : hasWifi
          ? wifiBars >= 4
              ? COLOR_GREEN
              : wifiBars === 3
                  ? COLOR_BLUE
                  : wifiBars === 2
                      ? COLOR_YELLOW
                      : COLOR_RED
          : COLOR_RED;

  // 4. Temperature Color: Blue <= 5C, Green 6..35C, Yellow 36..44C, Red >= 45C.
  const hasTemp = tempRaw != null && !Number.isNaN(Number(tempRaw));
  const tempNum = hasTemp ? Math.round(Number(tempRaw)) : null;
  const tempRgb = !hasTemp
      ? COLOR_GREEN
      : tempNum <= 5
          ? COLOR_BLUE
          : tempNum <= 35
              ? COLOR_GREEN
              : tempNum < 45
                  ? COLOR_YELLOW
                  : COLOR_RED;
  const tempHex =
      tempNum !== null && tempNum <= 5
          ? '0x38bdf8'
          : tempNum !== null && tempNum >= 45
              ? '0xf87171'
              : tempNum !== null && tempNum >= 36
                  ? '0xfacc15'
                  : '0xd4d4d8';

  return {
    telCfg,
    statusKind,
    statusRgb,
    hasBat,
    batPct,
    charging,
    economyMode,
    powerLabel: (status && status.powerLabel) || '',
    batRgb,
    batHex,
    hasWifi,
    wifiBars,
    hasRssi,
    rssiNum,
    wifiRgb,
    hasTemp,
    tempNum,
    tempRgb,
    tempHex,
    seenVal: seenRaw,
  };
}

/**
 * Builds the list of enabled telemetry segments for rendering in the 'default' theme.
 *
 * @param {Record<string, *>} st - Evaluated telemetry state from evaluateTelemetryState().
 * @returns {Array<Record<string, *>>} Array of telemetry segment descriptors.
 */
function buildTelemetrySegments(st) {
  const {telCfg} = st;
  if (!telCfg.enabled) return [];

  const segments = [];
  if (telCfg.battery && st.hasBat) {
    const powerText =
        telCfg.powerSource && st.powerLabel
            ? ' ' + st.powerLabel
            : st.charging
                ? ' Charging'
                : st.economyMode
                    ? ' Eco'
                    : '';
    const label = st.batPct + '%' + powerText;
    segments.push({
      type: 'bat',
      batPct: st.batPct,
      charging: st.charging,
      batHex: st.batHex,
      batRgb: st.batRgb,
      label,
      width: 45 + label.length * 11,
    });
  }

  if (telCfg.wifi && (st.hasWifi || st.hasRssi)) {
    const showRssi = telCfg.rssi && st.hasRssi;
    const label = showRssi ? st.rssiNum + ' dBm' : 'Wi-Fi';
    segments.push({
      type: 'wifi',
      wifiBars: st.wifiBars,
      wifiRgb: st.wifiRgb,
      label,
      width: 38 + label.length * 11,
    });
  }

  if (telCfg.temperature && st.hasTemp) {
    const label = st.tempNum + '°C';
    segments.push({
      type: 'temp',
      tempHex: st.tempHex,
      tempRgb: st.tempRgb,
      tempNum: st.tempNum,
      label,
      width: label.length * 12,
    });
  }

  if (telCfg.lastSeen && st.seenVal) {
    const label = 'Last live ' + st.seenVal;
    segments.push({
      type: 'seen',
      seenVal: st.seenVal,
      label,
      width: label.length * 11,
    });
  }

  return segments;
}

/**
 * Draws the vector battery icon and curved Wi-Fi arc icon alongside their text labels
 * for the 'default' theme.
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
    if (seg.type === 'bat') {
      drawBatteryIcon(canvas, cursorX, textY - 1, seg.batPct, [212, 212, 216], seg.batRgb, false);
      filters.push(buildDrawtext(seg.label, seg.batHex, 20, String(cursorX + 45), textY));
    } else if (seg.type === 'wifi') {
      drawWifiArcsIcon(canvas, cursorX + 16, textBaselineY - 1, seg.wifiBars, seg.wifiRgb);
      filters.push(buildDrawtext(seg.label, '0xd4d4d8', 20, String(cursorX + 38), textY));
    } else if (seg.type === 'temp') {
      filters.push(buildDrawtext(seg.label, seg.tempHex, 20, String(cursorX), textY));
    } else if (seg.type === 'seen') {
      filters.push(buildDrawtext(seg.label, '0xa1a1aa', 20, String(cursorX), textY));
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
  const boxW = 92;
  const boxH = 36;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 18, 0.42, 0.16, blurBackdrop);

  const cy = boxY + 18;
  drawYuvCircle(canvas, boxX + 22, cy, 6.8, st.statusRgb, 0.96);
  drawYuvCircle(canvas, boxX + 46, cy, 6.0, st.batRgb, 0.96);
  drawYuvCircle(canvas, boxX + 70, cy, 5.2, st.wifiRgb, 0.96);
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

  const padX = 16;
  const gap = 16;
  let contentW = 20;
  if (showBat) contentW += gap + 37;
  if (showWifi) contentW += gap + 28;
  if (showTemp) contentW += gap + 16;
  if (showClock) contentW += gap + 20;

  const boxW = contentW + padX * 2;
  const boxH = 44;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);
  const cy = boxY + 22;

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 22, 0.44, 0.16, blurBackdrop);

  // 1. Status Icon (20x20): outer ring + inner state glyph.
  let cursorX = boxX + padX;
  drawStatusGlyph(canvas, cursorX + 10, cy, 1.0, st);
  cursorX += 20 + gap;

  // 2. Battery + Power Source Icon (37x16) with inner bolt.
  if (showBat) {
    const showBolt = Boolean(telCfg.powerSource && (st.charging || st.powerLabel));
    drawBatteryIcon(canvas, cursorX, cy - 8, st.batPct, st.batRgb, st.batRgb, showBolt);
    cursorX += 37 + gap;
  }

  // 3. Curved Wi-Fi Signal Arcs + RSSI Color (28x16).
  if (showWifi) {
    drawWifiArcsIcon(canvas, cursorX + 14, cy + 7, st.wifiBars, st.wifiRgb);
    cursorX += 28 + gap;
  }

  // 4. Temperature Thermometer Icon with Tick Marks (16x20).
  if (showTemp) {
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
    cursorX += 16 + gap;
  }

  // 5. Last Seen Filled Analog Clock Icon (20x20) with HH:MM hands.
  if (showClock) {
    const clockCx = cursorX + 10;
    drawYuvCircle(canvas, clockCx, cy, 8.5, [244, 244, 245], 0.95);
    const match = /^(\d{1,2}):(\d{2})/.exec(String(st.seenVal || ''));
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
}

/**
 * Composites the centered rounded translucent modal box ('default' theme at 'center' position),
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

  if (!segments.length) return [];

  fillYuvRect(canvas, boxX + 44, boxY + 254, boxW - 88, 1, 255, 255, 255, 0.16);
  const gap = 32;
  const totalW = segments.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, segments.length - 1);
  const startX = Math.round(W / 2 - totalW / 2);
  return drawTelemetryRow(canvas, segments, startX, boxY + 278, gap, buildDrawtext);
}

/**
 * Draws the compact corner card for the 'default' theme when card_position is one of the
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
function drawCornerDefaultCard(canvas, position, headerText, dotRgb, segments, buildDrawtext, blurBackdrop = true) {
  const hasTelemetry = segments.length > 0;
  const gap = 18;
  const telContentW = hasTelemetry
      ? segments.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, segments.length - 1) + 44
      : 0;
  const headerContentW = 42 + headerText.length * 11 + 24;
  const boxW = Math.min(W - 48, Math.max(hasTelemetry ? 540 : 400, telContentW, headerContentW));
  const boxH = hasTelemetry ? 88 : 48;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);

  drawRoundedBox(canvas, boxX, boxY, boxW, boxH, 22, 0.58, 0.16, blurBackdrop);
  drawYuvCircle(canvas, boxX + 26, boxY + 23, 5.6, dotRgb, 0.96);

  const filters = [buildDrawtext(headerText, '0xffffff', 20, String(boxX + 42), boxY + 15)];
  if (hasTelemetry) {
    fillYuvRect(canvas, boxX + 20, boxY + 44, boxW - 40, 1, 255, 255, 255, 0.16);
    filters.push(...drawTelemetryRow(canvas, segments, boxX + 22, boxY + 54, gap, buildDrawtext));
  }
  return filters;
}

/**
 * Renders a static YUV420p status frame according to card_theme ('default', 'icons', 'minimal',
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

  if (cardCfg.theme === 'minimal') {
    drawMinimalDotsCard(canvas, cardCfg.position, st, hasBackground);
    return canvas;
  }

  if (cardCfg.theme === 'icons') {
    drawIconsOnlyCard(canvas, cardCfg.position, st, hasBackground);
    return canvas;
  }

  const fontCandidates = [
    cfg.font_file,
    process.env.FONT_FILE,
    '/usr/share/fonts/Inter.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
  ].filter(Boolean);
  const font = fontCandidates.find((f) => fs.existsSync(f));
  if (!font) {
    log.warn(camScope, 'no TrueType font found for default theme, falling back to vector icons card');
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
    drawtextList.push(
        ...drawCornerDefaultCard(
            canvas,
            cardCfg.position,
            titleText + camLabel,
            st.statusRgb,
            segments,
            buildDrawtext,
            hasBackground
        )
    );
  } else {
    const boxW = 820;
    const boxH = hasTelemetry ? 336 : 268;
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
      {input: canvas, maxBuffer: FRAME * 2}
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
 * latest telemetry and a single shared background buffer.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function renderCameraCards(cam) {
  const title = cam.title || cam.name;
  const lowBat = isLowBattery(cam);
  const status = {
    camName: cam.name,
    camTitle: title,
    cardCfg: cam.cardCfg,
    telCfg: cam.telCfg,
    battery: cam.battery,
    charging: cam.charging,
    powerLabel: cam.powerLabel,
    economyMode: lowBat,
    wifi: cam.wifi,
    rssi: cam.rssi,
    temp: cam.temp,
    lastSeen: cam.lastSeen,
  };
  const {baseCanvas, hasBackground} = prepareBackgroundCanvas(cam.cardCfg, cam.lastFrame);
  const asleepTitle = lowBat ? 'Asleep (Low Battery)' : 'Asleep';
  const asleepLine2 =
      lowBat && !LOW_BAT_WAKE_ON_VIEW
          ? 'economy mode active, waking on motion events only'
          : 'feed, open this camera to wake it, or wait for motion';

  cam.asleep = card(
      asleepTitle,
      'No active stream on the ' + title + ' detect',
      asleepLine2,
      status,
      baseCanvas,
      hasBackground
  );
  cam.waking = card(
      'Waking Up...',
      'Connecting to ' + title + ' P2P livestream,',
      'live video starts in a few seconds',
      status,
      baseCanvas,
      hasBackground
  );
  cam.busy = card(
      'Waiting',
      'Another camera is currently live on the HomeBase,',
      'only one battery camera can stream at a time',
      status,
      baseCanvas,
      hasBackground
  );
  cam.liveTelState = evaluateTelemetryState('Live', status);
  if (cam.showCardOnLive && cam.cardCfg.theme === 'default' && cam.cardCfg.position !== 'center') {
    cam.liveCard = card('Live', '', '', status, baseCanvas, hasBackground);
  } else {
    cam.liveCard = null;
  }
  cam.burstUntil = Date.now() + 1200;
}

/**
 * Computes the bounding box { boxX, boxY, boxW, boxH } of a camera's corner status card
 * across all states so Frigate motion/object masks and live overlays cover the exact card footprint.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {{ boxX: number, boxY: number, boxW: number, boxH: number }|null}
 */
function getCameraCardBounds(cam) {
  const {theme, position} = cam.cardCfg;
  if (theme === 'none' || position === 'center') return null;

  let boxW = 92;
  let boxH = 36;
  if (theme === 'icons') {
    const tc = cam.telCfg;
    let contentW = 20;
    if (tc.enabled && tc.battery) contentW += 16 + 37;
    if (tc.enabled && tc.wifi) contentW += 16 + 28;
    if (tc.enabled && tc.temperature) contentW += 16 + 16;
    if (tc.enabled && tc.lastSeen) contentW += 16 + 20;
    boxW = contentW + 32;
    boxH = 44;
  } else if (theme === 'default') {
    const title = cam.title || cam.name;
    const maxHeader = 'Asleep (Low Battery)  -  ' + title;
    const headerW = 42 + maxHeader.length * 11 + 24;
    const st = cam.liveTelState || evaluateTelemetryState('Asleep', {
      telCfg: cam.telCfg,
      battery: cam.battery ?? 100,
      charging: cam.charging,
      powerLabel: cam.powerLabel || 'Charging',
      wifi: cam.wifi ?? 4,
      rssi: cam.rssi ?? -60,
      temp: cam.temp ?? 25,
      lastSeen: cam.lastSeen || '00:00',
    });
    const segments = buildTelemetrySegments(st);
    const hasTelemetry = cam.telCfg.enabled && segments.length > 0;
    const gap = 18;
    const telW = hasTelemetry
        ? segments.reduce((sum, seg) => sum + seg.width, 0) + gap * Math.max(0, segments.length - 1) + 44
        : 0;
    boxW = Math.min(W - 48, Math.max(hasTelemetry ? 540 : 400, telW, headerW));
    boxH = hasTelemetry ? 88 : 48;
  }

  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);
  return {boxX, boxY, boxW, boxH};
}

/**
 * Composites the camera's corner status card onto a copy of a live video frame when
 * card_show_on_live is enabled, leaving the original raw frame (and cam.lastFrame) untouched.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Uint8Array} rawFrame - Clean decoded YUV420p video frame.
 * @returns {Uint8Array} YUV420p frame buffer with corner overlay applied (or rawFrame if disabled).
 */
function renderLiveFrameWithCard(cam, rawFrame) {
  if (
      !cam.showCardOnLive ||
      cam.suppressLiveCard ||
      cam.cardCfg.theme === 'none' ||
      cam.cardCfg.position === 'center'
  ) {
    return rawFrame;
  }
  const out = cam.liveOverlayBuf;
  rawFrame.copy(out);
  const st = cam.liveTelState || evaluateTelemetryState('Live', {
    telCfg: cam.telCfg,
    battery: cam.battery,
    charging: cam.charging,
    powerLabel: cam.powerLabel,
    economyMode: isLowBattery(cam),
    wifi: cam.wifi,
    rssi: cam.rssi,
    temp: cam.temp,
    lastSeen: cam.lastSeen,
  });

  if (cam.cardCfg.theme === 'minimal') {
    drawMinimalDotsCard(out, cam.cardCfg.position, st, true);
    return out;
  }
  if (cam.cardCfg.theme === 'icons') {
    drawIconsOnlyCard(out, cam.cardCfg.position, st, true);
    return out;
  }
  if (cam.cardCfg.theme === 'default' && Buffer.isBuffer(cam.liveCard)) {
    const bounds = getCameraCardBounds(cam);
    if (bounds) {
      copyYuvRegion(cam.liveCard, out, bounds.boxX, bounds.boxY, bounds.boxW, bounds.boxH);
    }
    return out;
  }
  return rawFrame;
}

/**
 * Computes the normalized Frigate mask polygon string ('x0,y0,x0,y1,x1,y1,x1,y0')
 * for a camera's status card with a 6px chroma/anti-aliasing safety margin.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {string} Normalized polygon coordinates, or '' if no corner card is active.
 */
function computeFrigateMaskPolygon(cam) {
  const bounds = getCameraCardBounds(cam);
  if (!bounds) return '';
  const pad = 6;
  const x0 = Math.max(0, (bounds.boxX - pad) / W).toFixed(3);
  const y0 = Math.max(0, (bounds.boxY - pad) / H).toFixed(3);
  const x1 = Math.min(1, (bounds.boxX + bounds.boxW + pad) / W).toFixed(3);
  const y1 = Math.min(1, (bounds.boxY + bounds.boxH + pad) / H).toFixed(3);
  return x0 + ',' + y0 + ',' + x0 + ',' + y1 + ',' + x1 + ',' + y1 + ',' + x1 + ',' + y0;
}

module.exports = {
  drawStatusGlyph,
  drawBatteryIcon,
  drawWifiArcsIcon,
  evaluateTelemetryState,
  buildTelemetrySegments,
  drawTelemetryRow,
  drawMinimalDotsCard,
  drawIconsOnlyCard,
  drawFrigateModalGraphics,
  drawCornerDefaultCard,
  card,
  renderCameraCards,
  getCameraCardBounds,
  renderLiveFrameWithCard,
  computeFrigateMaskPolygon,
};
