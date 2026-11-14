// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Embedded Lucide contour icon alpha sprites (Copyright (c) Lucide Contributors, ISC License),
 * 4x4-supersampled 3-dot waiting ellipsis, dynamic clock hands, and 'minimal' theme stadium/dot
 * primitives for zero-FFmpeg, zero-external-file rendering.
 */
'use strict';

const zlib = require('node:zlib');
const {H} = require('../config');
const {blendYuvPixel} = require('./yuv-canvas');

const NIBBLE_SHIFT = 4;
const NIBBLE_MASK = 0x0f;
const NIBBLE_TO_BYTE = 17;
const MAX_ALPHA_BYTE = 255;

const HALO_RGB_R = 8;
const HALO_RGB_G = 10;
const HALO_RGB_B = 16;
const HALO_WEIGHT_DOWN = 0.34;
const HALO_WEIGHT_DIAG = 0.38;
const HALO_WEIGHT_LEFT = 0.22;
const HALO_WEIGHT_RIGHT = 0.24;
const HALO_WEIGHT_UP = 0.2;
const HALO_BG_START_LUMA = 56;
const HALO_BG_SPAN_LUMA = 90;
const CANVAS_WIDTH = 1280;

/** @type {ReadonlyArray<readonly [number, number, number]>} */
const OPTICAL_HALO_OFFSETS = Object.freeze([
  [0, 1, HALO_WEIGHT_DOWN],
  [1, 1, HALO_WEIGHT_DIAG],
  [-1, 0, HALO_WEIGHT_LEFT],
  [1, 0, HALO_WEIGHT_RIGHT],
  [0, -1, HALO_WEIGHT_UP],
]);

const SSAA_GRID = 4;
const SSAA_SAMPLES = 16;
const HALF = 0.5;
const SMOOTHSTEP_A = 3;
const SMOOTHSTEP_B = 2;
const DEFAULT_SDF_AA_RADIUS = 0.68;

const MINIMAL_PILL_WIDTH = 26;
const MINIMAL_PILL_HEIGHT = 12;
const MINIMAL_PILL_RING_STROKE = 2.5;
const MINIMAL_DOT_SIZE = 12;

const BAT_WIDTH = 30;
const BAT_HEIGHT = 20;
const BAT_BODY_CX = 12.5;
const BAT_BODY_CY = 10;
const BAT_OUTER_HX = 12;
const BAT_OUTER_HY = 8;
const BAT_OUTER_R = 3;
const BAT_INNER_HX = 9.9;
const BAT_INNER_HY = 5.9;
const BAT_INNER_R = 1.4;
const BAT_NUB_CX = 26.6;
const BAT_NUB_HX = 1.15;
const BAT_NUB_HY = 3.1;
const BAT_NUB_R = 0.9;

const POWER_BADGE_SIZE = 15;
const POWER_BADGE_OFFSET_X = 14;
const POWER_BADGE_OFFSET_Y = -4;
const POWER_BADGE_CUTOUT_GAP = 1.65;
const BAT_FILL_OFFSET_X = 4;
const BAT_FILL_OFFSET_Y = 5;
const BAT_FILL_MAX_W = 17;
const BAT_FILL_H = 10;

const BOLT_STROKE_EXPAND = 0.15;
const SOLAR_CX = 7.5;
const SOLAR_CY = 7.2;
const SOLAR_CORE_R = 2.45;
const SOLAR_RAY_COUNT = 8;
const SOLAR_RAY_QUADRANT_DIV = 4;
const SOLAR_RAY_STEP_RAD = Math.PI / SOLAR_RAY_QUADRANT_DIV;
const SOLAR_RAY_R0 = 3.85;
const SOLAR_RAY_R1 = 5.45;
const SOLAR_RAY_TH = 0.68;
const PLUG_CX = 7.5;
const PLUG_PRONG_LX = 5.7;
const PLUG_PRONG_RX = 9.3;
const PLUG_PRONG_Y0 = 1.6;
const PLUG_PRONG_Y1 = 4.8;
const PLUG_PRONG_TH = 0.72;
const PLUG_CAP_Y = 5.2;
const PLUG_CAP_HX = 3.9;
const PLUG_CAP_HY = 1;
const PLUG_CAP_R = 0.5;
const PLUG_BODY_Y = 7;
const PLUG_BODY_HX = 3.2;
const PLUG_BODY_HY = 2.3;
const PLUG_BODY_R = 1.6;
const PLUG_CORD_Y0 = 9;
const PLUG_CORD_Y1 = 12.2;
const PLUG_CORD_TH = 0.8;

const QUESTION_X0 = 5.3;
const QUESTION_Y0 = 4.2;
const QUESTION_X1 = 6.2;
const QUESTION_Y1 = 2.4;
const QUESTION_X2 = 8.9;
const QUESTION_Y2 = 2.4;
const QUESTION_X3 = 9.7;
const QUESTION_Y3 = 4.5;
const QUESTION_X4 = 7.5;
const QUESTION_Y4 = 6.9;
const QUESTION_Y5 = 8.9;
const QUESTION_STROKE_TH = 0.82;
const QUESTION_DOT_CX = 7.5;
const QUESTION_DOT_CY = 12;
const QUESTION_DOT_R = 1.05;

const MOON_OUTER_CX = 12.2;
const MOON_OUTER_CY = 12;
const MOON_OUTER_R = 8.2;
const MOON_CUT_CX = 15.8;
const MOON_CUT_CY = 8.4;
const MOON_CUT_R = 6.8;
const MOON_TIP_SMOOTH_K = 0.85;
const MOON_TIP_SMOOTH_WEIGHT = 0.25;
const PLAY_CORNER_R = 1.15;
const WIFI_CX = 12;
const WIFI_CY = 18.2;
const WIFI_DOT_R = 1.55;
const WIFI_ARC_HALF_DEG = 42;
const DEG_PER_HALF_TURN = 180;
const WIFI_ARC_HALF_RAD = (WIFI_ARC_HALF_DEG * Math.PI) / DEG_PER_HALF_TURN;
const WIFI_ARC_TH = 1.15;
const WIFI_R_TIER_1 = 5;
const WIFI_R_TIER_2 = 9.2;
const WIFI_R_TIER_3 = 13.4;
const WIFI_RADII = Object.freeze([0, WIFI_R_TIER_1, WIFI_R_TIER_2, WIFI_R_TIER_3]);

const BOLT_PT0_X = 8.5;
const BOLT_PT0_Y = 1.2;
const BOLT_PT1_X = 3;
const BOLT_PT1_Y = 8;
const BOLT_PT2_X = 7.1;
const BOLT_PT3_X = 6.2;
const BOLT_PT3_Y = 13.2;
const BOLT_PT4_X = 12;
const BOLT_PT4_Y = 6.4;
const BOLT_PT5_X = 7.9;
const PLAY_PT_LEFT_X = 7.5;
const PLAY_PT_TOP_Y = 5.2;
const PLAY_PT_BOT_Y = 18.8;
const PLAY_PT_RIGHT_X = 18.8;
const PLAY_PT_MID_Y = 12;

const ICON_VIEWBOX_SIZE = 24;
const WAITING_DOT_LEFT_X = 5;
const WAITING_DOT_MID_X = 12;
const WAITING_DOT_RIGHT_X = 19;
const WAITING_DOT_RADIUS_PX = 1.9;

const DEFAULT_CLOCK_SIZE = 24;
const CLOCK_PIVOT_RATIO = 0.068;
const CLOCK_HOUR_LEN_RATIO = 0.21;
const CLOCK_MIN_LEN_RATIO = 0.3;
const CLOCK_HOUR_STROKE_RATIO = 0.062;
const CLOCK_MIN_STROKE_RATIO = 0.054;
const MIN_HAND_STROKE_PX = 0.95;
const HOURS_PER_DIAL = 12;
const MINS_PER_HOUR = 60;
const DEFAULT_CLOCK_HOURS = 4;
const DEFAULT_CLOCK_MINS = 20;
const MAX_CLOCK_CACHE = 64;

const SPRITE_IDX_BACKFILL = 0;
const SPRITE_IDX_WAKING = 1;
const SPRITE_IDX_DISCONNECTED = 2;
const SPRITE_IDX_THERMOMETER = 3;
const SPRITE_IDX_CLOCK_RING = 4;

const CLOCK_HM_REGEX = /^(\d{1,2}):(\d{2})/;

const LUCIDE_ICON_ATLAS_B64 =
  'eNqdk89r1EAUx1+SzbJFDymWthYCexfa/Qe0FXp1m4MIXtztwau9e2n8C9aTp8riX7DiNWB68LKnUBCkIARqbx4CrV03TaZf' +
  'mZlMZqKCre8QPsm8H9/33sRdXaX/MZs/FiVOiaj1RXA/J6L9OccOcqI1cLZi5OSkgu8DOT0D5zaAfAGCJwCK5E82fczYRk6z' +
  'VkNDQ5up+Sb2twlZBj8ypvJds59rjuc1djCreQ8XClvAueJ14EzVSYEiiiKPiG5BmEg1kvyeu0RRFAPMq0I2gBOVaRPYUjxo' +
  'FA5rHhVa5/hI88eu5s9Gu96/JmS90txh2t1Kjew+855G0ZtuddDnKw/kwZ3t7ZdZ2SN68VBErGQz6iD0mffYo7sI3QsRUQ5p' +
  'EJDnfPLZUsZ6fCOD0kqP3FQMtf+a11g4ldta4amkFDs99ZUq6+uWVrUoVFUvbqAP9n/qg3Gu+7j3wYzgfYTGTBpzWvrtDjm9' +
  '+mqo8btFHFRDO9sIr0Xnm4pYekPymeoiPphKCXaxfhKLhbTmo/lIXBzncufHRGpNd5eZjHhwlX2r7vvb4+61/xr7yXPl3E6A' +
  'cignkWB6gFLU6LNdouWU78zJ3vEva1c9otuXMmpySLRXqfZnRMmwylaSDbVRdN1SVUyCdv0Tjocmmz5mrJmzUcvUYGozNTd6' +
  'MXts9F7bL1/fLzQ=';

/**
 * Unpacks 4-bit nibble-packed alpha coverage bytes into an 8-bit 0..255 Uint8Array mask.
 *
 * @param {Buffer} buf - Inflated binary buffer.
 * @param {number} offset - Starting byte offset of packed nibbles.
 * @param {number} pixelCount - Total w * h pixels to unpack.
 * @returns {{ mask: Uint8Array, nextOffset: number }}
 */
function unpackNibbleMask(buf, offset, pixelCount) {
  const mask = new Uint8Array(pixelCount);
  let pos = offset;
  for (let p = 0; p < pixelCount; p += 2) {
    const packed = buf[pos++];
    mask[p] = ((packed >> NIBBLE_SHIFT) & NIBBLE_MASK) * NIBBLE_TO_BYTE;
    if (p + 1 < pixelCount) {
      mask[p + 1] = (packed & NIBBLE_MASK) * NIBBLE_TO_BYTE;
    }
  }
  return {mask, nextOffset: pos};
}

/**
 * Inflates and decodes the 5 embedded Lucide contour icon alpha sprites ('backfill', 'waking',
 * 'disconnected', 'thermometer', and 'clockRing') on startup.
 *
 * @returns {Array<Readonly<{ width: number, height: number, mask: Uint8Array }>>}
 */
function unpackLucideSprites() {
  const buf = zlib.inflateSync(Buffer.from(LUCIDE_ICON_ATLAS_B64, 'base64'));
  let pos = 0;
  const count = buf[pos++];
  const sprites = [];
  for (let i = 0; i < count; i++) {
    const width = buf[pos++];
    const height = buf[pos++];
    const unpacked = unpackNibbleMask(buf, pos, width * height);
    pos = unpacked.nextOffset;
    sprites.push(Object.freeze({width, height, mask: unpacked.mask}));
  }
  return sprites;
}

/**
 * Evaluates a cubic Hermite smoothstep from edge0 (0.0) to edge1 (1.0).
 *
 * @param {number} edge0 - Lower threshold.
 * @param {number} edge1 - Upper threshold.
 * @param {number} x - Sample value.
 * @returns {number}
 */
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (SMOOTHSTEP_A - SMOOTHSTEP_B * t);
}

/**
 * Evaluates a 4x4 subpixel Gaussian/smoothstep-filtered SDF mask (width x height)
 * for smooth 8-bit anti-aliased vector sprites.
 *
 * @param {number} width - Sprite width in pixels.
 * @param {number} height - Sprite height in pixels.
 * @param {(x: number, y: number) => number} sdfFn - Signed distance function (negative inside).
 * @returns {Readonly<{ width: number, height: number, mask: Uint8Array }>}
 */
function buildSmoothSdfSprite(width, height, sdfFn) {
  const mask = new Uint8Array(width * height);
  const invGrid = 1 / SSAA_GRID;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let sum = 0;
      for (let sy = 0; sy < SSAA_GRID; sy++) {
        const y = py + (sy + HALF) * invGrid;
        for (let sx = 0; sx < SSAA_GRID; sx++) {
          const x = px + (sx + HALF) * invGrid;
          sum += smoothstep(DEFAULT_SDF_AA_RADIUS, -DEFAULT_SDF_AA_RADIUS, sdfFn(x, y));
        }
      }
      mask[py * width + px] = Math.round((sum * MAX_ALPHA_BYTE) / SSAA_SAMPLES);
    }
  }
  return Object.freeze({width, height, mask});
}

/**
 * Signed distance to a 2D rounded box centered at (cx, cy) with half-extents (hx, hy) and corner radius r.
 *
 * @param {{ x: number, y: number }} pt - Sample point.
 * @param {{ cx: number, cy: number, hx: number, hy: number, r: number }} box - Rounded box geometry.
 * @returns {number}
 */
function sdfRoundedBox(pt, box) {
  const qx = Math.abs(pt.x - box.cx) - (box.hx - box.r);
  const qy = Math.abs(pt.y - box.cy) - (box.hy - box.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - box.r;
}

/**
 * Signed distance to a 2D closed polygon (negative inside, positive outside).
 *
 * @param {number} px - X coordinate.
 * @param {number} py - Y coordinate.
 * @param {ReadonlyArray<readonly [number, number]>} pts - Polygon vertices.
 * @returns {number}
 */
function sdfPolygon(px, py, pts) {
  let d = Infinity;
  let s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = px - xi;
    const wy = py - yi;
    const proj = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const dx = wx - ex * proj;
    const dy = wy - ey * proj;
    d = Math.min(d, dx * dx + dy * dy);
    const cond1 = py >= yi;
    const cond2 = py < yj;
    const cond3 = ex * wy > ey * wx;
    if ((cond1 && cond2 && cond3) || (!cond1 && !cond2 && !cond3)) {
      s = -s;
    }
  }
  return s * Math.sqrt(d);
}

/**
 * Signed distance to a circular arc centered at (cx, cy) along -Y (upward Wi-Fi fan).
 *
 * @param {number} px - X coordinate.
 * @param {number} py - Y coordinate.
 * @param {number} r - Arc radius.
 * @returns {number}
 */
function sdfUpwardWifiArc(px, py, r) {
  const rx = -(py - WIFI_CY);
  const ry = Math.abs(px - WIFI_CX);
  const scX = Math.cos(WIFI_ARC_HALF_RAD);
  const scY = Math.sin(WIFI_ARC_HALF_RAD);
  const dist = scY * rx > scX * ry ? Math.abs(Math.hypot(rx, ry) - r) : Math.hypot(rx - r * scX, ry - r * scY);
  return dist - WIFI_ARC_TH;
}

/** @type {ReadonlyArray<readonly [number, number]>} */
const BOLT_POLYGON_PTS = Object.freeze([
  [BOLT_PT0_X, BOLT_PT0_Y],
  [BOLT_PT1_X, BOLT_PT1_Y],
  [BOLT_PT2_X, BOLT_PT1_Y],
  [BOLT_PT3_X, BOLT_PT3_Y],
  [BOLT_PT4_X, BOLT_PT4_Y],
  [BOLT_PT5_X, BOLT_PT4_Y],
]);

/** @type {ReadonlyArray<readonly [number, number]>} */
const PLAY_TRIANGLE_PTS = Object.freeze([
  [PLAY_PT_LEFT_X, PLAY_PT_TOP_Y],
  [PLAY_PT_LEFT_X, PLAY_PT_BOT_Y],
  [PLAY_PT_RIGHT_X, PLAY_PT_MID_Y],
]);

/**
 * Evaluates the continuous SDF for a 15x15 power badge ('bolt', 'solar', 'plugged', or 'unknown').
 *
 * @param {'bolt'|'solar'|'plugged'|'unknown'} kind - Power badge kind.
 * @param {number} x - Badge-local X coordinate.
 * @param {number} y - Badge-local Y coordinate.
 * @returns {number}
 */
function evalPowerBadge15Sdf(kind, x, y) {
  if (kind === 'bolt') {
    return sdfPolygon(x, y, BOLT_POLYGON_PTS) - BOLT_STROKE_EXPAND;
  }
  if (kind === 'solar') {
    const dCore = Math.hypot(x - SOLAR_CX, y - SOLAR_CY) - SOLAR_CORE_R;
    let dRays = Infinity;
    for (let i = 0; i < SOLAR_RAY_COUNT; i++) {
      const ang = i * SOLAR_RAY_STEP_RAD;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const seg = {
        ax: SOLAR_CX + ca * SOLAR_RAY_R0,
        ay: SOLAR_CY + sa * SOLAR_RAY_R0,
        bx: SOLAR_CX + ca * SOLAR_RAY_R1,
        by: SOLAR_CY + sa * SOLAR_RAY_R1,
      };
      dRays = Math.min(dRays, distToSegment({px: x, py: y}, seg) - SOLAR_RAY_TH);
    }
    return Math.min(dCore, dRays);
  }
  if (kind === 'unknown') {
    const pt = {px: x, py: y};
    const dHookL =
      distToSegment(pt, {ax: QUESTION_X0, ay: QUESTION_Y0, bx: QUESTION_X1, by: QUESTION_Y1}) - QUESTION_STROKE_TH;
    const dHookTop =
      distToSegment(pt, {ax: QUESTION_X1, ay: QUESTION_Y1, bx: QUESTION_X2, by: QUESTION_Y2}) - QUESTION_STROKE_TH;
    const dHookR =
      distToSegment(pt, {ax: QUESTION_X2, ay: QUESTION_Y2, bx: QUESTION_X3, by: QUESTION_Y3}) - QUESTION_STROKE_TH;
    const dNeck =
      distToSegment(pt, {ax: QUESTION_X3, ay: QUESTION_Y3, bx: QUESTION_X4, by: QUESTION_Y4}) - QUESTION_STROKE_TH;
    const dStem =
      distToSegment(pt, {ax: QUESTION_X4, ay: QUESTION_Y4, bx: QUESTION_X4, by: QUESTION_Y5}) - QUESTION_STROKE_TH;
    const dDot = Math.hypot(x - QUESTION_DOT_CX, y - QUESTION_DOT_CY) - QUESTION_DOT_R;
    return Math.min(dHookL, dHookTop, dHookR, dNeck, dStem, dDot);
  }
  const pt = {px: x, py: y};
  const boxPt = {x, y};
  const dProngL =
    distToSegment(pt, {ax: PLUG_PRONG_LX, ay: PLUG_PRONG_Y0, bx: PLUG_PRONG_LX, by: PLUG_PRONG_Y1}) - PLUG_PRONG_TH;
  const dProngR =
    distToSegment(pt, {ax: PLUG_PRONG_RX, ay: PLUG_PRONG_Y0, bx: PLUG_PRONG_RX, by: PLUG_PRONG_Y1}) - PLUG_PRONG_TH;
  const dCap = sdfRoundedBox(boxPt, {
    cx: PLUG_CX,
    cy: PLUG_CAP_Y,
    hx: PLUG_CAP_HX,
    hy: PLUG_CAP_HY,
    r: PLUG_CAP_R,
  });
  const dBody = sdfRoundedBox(boxPt, {
    cx: PLUG_CX,
    cy: PLUG_BODY_Y,
    hx: PLUG_BODY_HX,
    hy: PLUG_BODY_HY,
    r: PLUG_BODY_R,
  });
  const dCord = distToSegment(pt, {ax: PLUG_CX, ay: PLUG_CORD_Y0, bx: PLUG_CX, by: PLUG_CORD_Y1}) - PLUG_CORD_TH;
  return Math.min(dProngL, dProngR, dCap, dBody, dCord);
}

/**
 * Evaluates the continuous SDF for the 30x20 hollow rounded battery shell and positive terminal nub.
 *
 * @param {number} x - Battery-local X coordinate.
 * @param {number} y - Battery-local Y coordinate.
 * @returns {number}
 */
function evalBatteryShellSdf(x, y) {
  const pt = {x, y};
  const dOuter = sdfRoundedBox(pt, {
    cx: BAT_BODY_CX,
    cy: BAT_BODY_CY,
    hx: BAT_OUTER_HX,
    hy: BAT_OUTER_HY,
    r: BAT_OUTER_R,
  });
  const dInner = sdfRoundedBox(pt, {
    cx: BAT_BODY_CX,
    cy: BAT_BODY_CY,
    hx: BAT_INNER_HX,
    hy: BAT_INNER_HY,
    r: BAT_INNER_R,
  });
  const dNub = sdfRoundedBox(pt, {
    cx: BAT_NUB_CX,
    cy: BAT_BODY_CY,
    hx: BAT_NUB_HX,
    hy: BAT_NUB_HY,
    r: BAT_NUB_R,
  });
  return Math.min(Math.max(dOuter, -dInner), dNub);
}

/**
 * Pre-bakes the 16x-subpixel smoothstep SDF cutout battery shell (30x20) and charge-fill retention map (17x10)
 * for a given power badge kind.
 *
 * @param {'bolt'|'solar'|'plugged'|'unknown'} kind - Power badge kind.
 * @returns {{
 *   badge: Readonly<{ width: number, height: number, mask: Uint8Array }>,
 *   cutoutShell: Readonly<{ width: number, height: number, mask: Uint8Array }>,
 *   fillKeep: Uint8Array
 * }}
 */
function buildPowerBadgeAssetsForKind(kind) {
  const badge = buildSmoothSdfSprite(POWER_BADGE_SIZE, POWER_BADGE_SIZE, (x, y) => evalPowerBadge15Sdf(kind, x, y));
  const cutoutShell = buildSmoothSdfSprite(BAT_WIDTH, BAT_HEIGHT, (x, y) => {
    const dShell = evalBatteryShellSdf(x, y);
    const dBadgeCut =
      evalPowerBadge15Sdf(kind, x - POWER_BADGE_OFFSET_X, y - POWER_BADGE_OFFSET_Y) - POWER_BADGE_CUTOUT_GAP;
    return Math.max(dShell, -dBadgeCut);
  });
  const fullKeep = buildSmoothSdfSprite(BAT_WIDTH, BAT_HEIGHT, (x, y) => {
    const dBadgeCut =
      evalPowerBadge15Sdf(kind, x - POWER_BADGE_OFFSET_X, y - POWER_BADGE_OFFSET_Y) - POWER_BADGE_CUTOUT_GAP;
    return -dBadgeCut;
  });
  const fillKeep = new Uint8Array(BAT_FILL_MAX_W * BAT_FILL_H);
  for (let fy = 0; fy < BAT_FILL_H; fy++) {
    for (let fx = 0; fx < BAT_FILL_MAX_W; fx++) {
      fillKeep[fy * BAT_FILL_MAX_W + fx] =
        fullKeep.mask[(BAT_FILL_OFFSET_Y + fy) * BAT_WIDTH + (BAT_FILL_OFFSET_X + fx)];
    }
  }
  return {badge, cutoutShell, fillKeep};
}

/**
 * Builds a 4x4-supersampled anti-aliased stadium pill, hollow stadium ring, or dot sprite
 * for the "minimal" theme.
 *
 * @param {{ width: number, height: number, hollowStroke: number }} spec - Shape dimensions and optional ring stroke.
 * @returns {Readonly<{ width: number, height: number, mask: Uint8Array }>}
 */
function buildMinimalStadiumSprite(spec) {
  const {width, height, hollowStroke} = spec;
  const mask = new Uint8Array(width * height);
  const cx = width / 2;
  const cy = height / 2;
  const rOuter = height / 2 - HALF;
  const halfInnerW = Math.max(0, width / 2 - height / 2);
  const rInner = Math.max(HALF, rOuter - hollowStroke);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let covSum = 0;
      for (let sy = 0; sy < SSAA_GRID; sy++) {
        const y = py + (sy + HALF) / SSAA_GRID;
        const dy = y - cy;
        for (let sx = 0; sx < SSAA_GRID; sx++) {
          const x = px + (sx + HALF) / SSAA_GRID;
          const qx = Math.max(0, Math.abs(x - cx) - halfInnerW);
          const dist = Math.hypot(qx, dy);
          if (dist <= rOuter && (hollowStroke <= 0 || dist >= rInner)) {
            covSum++;
          }
        }
      }
      mask[py * width + px] = Math.round((covSum * MAX_ALPHA_BYTE) / SSAA_SAMPLES);
    }
  }
  return Object.freeze({width, height, mask});
}

/**
 * Builds a 24x24 4x4-supersampled anti-aliased three-horizontal-dots (•••) ellipsis sprite
 * for the "Waiting" (busy / queued) status icon.
 *
 * @returns {Readonly<{ width: number, height: number, mask: Uint8Array }>}
 */
function buildWaitingEllipsisSprite() {
  const cy = ICON_VIEWBOX_SIZE / 2 + HALF;
  const cx0 = WAITING_DOT_LEFT_X + HALF;
  const cx1 = WAITING_DOT_MID_X + HALF;
  const cx2 = WAITING_DOT_RIGHT_X + HALF;
  return buildSmoothSdfSprite(ICON_VIEWBOX_SIZE, ICON_VIEWBOX_SIZE, (x, y) => {
    const dy = y - cy;
    return Math.min(Math.hypot(x - cx0, dy), Math.hypot(x - cx1, dy), Math.hypot(x - cx2, dy)) - WAITING_DOT_RADIUS_PX;
  });
}

/**
 * Builds the 6-state 24x24 status sprite set (smooth vector standby moon, live play, waiting ellipsis,
 * and unpacked backfill, waking, disconnected).
 *
 * @param {Array<Readonly<{ width: number, height: number, mask: Uint8Array }>>} list - Unpacked sprite list.
 * @returns {Readonly<{
 *   standby: { width: number, height: number, mask: Uint8Array },
 *   live: { width: number, height: number, mask: Uint8Array },
 *   backfill: { width: number, height: number, mask: Uint8Array },
 *   waking: { width: number, height: number, mask: Uint8Array },
 *   waiting: { width: number, height: number, mask: Uint8Array },
 *   disconnected: { width: number, height: number, mask: Uint8Array }
 * }>}
 */
function buildStatusSpriteGroup(list) {
  const standby = buildSmoothSdfSprite(ICON_VIEWBOX_SIZE, ICON_VIEWBOX_SIZE, (x, y) => {
    const dOuter = Math.hypot(x - MOON_OUTER_CX, y - MOON_OUTER_CY) - MOON_OUTER_R;
    const dCut = Math.hypot(x - MOON_CUT_CX, y - MOON_CUT_CY) - MOON_CUT_R;
    const h = Math.max(MOON_TIP_SMOOTH_K - Math.abs(dOuter - -dCut), 0) / MOON_TIP_SMOOTH_K;
    return Math.max(dOuter, -dCut) + h * h * MOON_TIP_SMOOTH_K * MOON_TIP_SMOOTH_WEIGHT;
  });
  const live = buildSmoothSdfSprite(
    ICON_VIEWBOX_SIZE,
    ICON_VIEWBOX_SIZE,
    (x, y) => sdfPolygon(x, y, PLAY_TRIANGLE_PTS) - PLAY_CORNER_R
  );
  return Object.freeze({
    standby,
    live,
    backfill: list[SPRITE_IDX_BACKFILL],
    waking: list[SPRITE_IDX_WAKING],
    waiting: buildWaitingEllipsisSprite(),
    disconnected: list[SPRITE_IDX_DISCONNECTED],
  });
}

const UNPACKED_SPRITES = unpackLucideSprites();
const BASE_BATTERY_SHELL = buildSmoothSdfSprite(BAT_WIDTH, BAT_HEIGHT, evalBatteryShellSdf);
const SOLAR_BADGE_ASSETS = buildPowerBadgeAssetsForKind('solar');
const PLUGGED_BADGE_ASSETS = buildPowerBadgeAssetsForKind('plugged');
const BOLT_BADGE_ASSETS = buildPowerBadgeAssetsForKind('bolt');
const UNKNOWN_BADGE_ASSETS = buildPowerBadgeAssetsForKind('unknown');
const SMOOTH_WIFI_TIERS = Object.freeze(
  WIFI_RADII.map((r, tier) =>
    buildSmoothSdfSprite(ICON_VIEWBOX_SIZE, ICON_VIEWBOX_SIZE, (x, y) =>
      tier === 0 ? Math.hypot(x - WIFI_CX, y - WIFI_CY) - WIFI_DOT_R : sdfUpwardWifiArc(x, y, r)
    )
  )
);

const LUCIDE_ICON_SPRITES = Object.freeze({
  status: buildStatusSpriteGroup(UNPACKED_SPRITES),
  batteryShell: BASE_BATTERY_SHELL,
  powerBadge15: Object.freeze({
    solar: SOLAR_BADGE_ASSETS.badge,
    plugged: PLUGGED_BADGE_ASSETS.badge,
    bolt: BOLT_BADGE_ASSETS.badge,
    unknown: UNKNOWN_BADGE_ASSETS.badge,
  }),
  batteryCutout: Object.freeze({
    solar: SOLAR_BADGE_ASSETS.cutoutShell,
    plugged: PLUGGED_BADGE_ASSETS.cutoutShell,
    bolt: BOLT_BADGE_ASSETS.cutoutShell,
    unknown: UNKNOWN_BADGE_ASSETS.cutoutShell,
  }),
  batteryFillKeep: Object.freeze({
    solar: SOLAR_BADGE_ASSETS.fillKeep,
    plugged: PLUGGED_BADGE_ASSETS.fillKeep,
    bolt: BOLT_BADGE_ASSETS.fillKeep,
    unknown: UNKNOWN_BADGE_ASSETS.fillKeep,
  }),
  wifiTiers: SMOOTH_WIFI_TIERS,
  thermometer: UNPACKED_SPRITES[SPRITE_IDX_THERMOMETER],
  clockRing: UNPACKED_SPRITES[SPRITE_IDX_CLOCK_RING],
  minimal: Object.freeze({
    pillFg: buildMinimalStadiumSprite({
      width: MINIMAL_PILL_WIDTH,
      height: MINIMAL_PILL_HEIGHT,
      hollowStroke: 0,
    }),
    pillRing: buildMinimalStadiumSprite({
      width: MINIMAL_PILL_WIDTH,
      height: MINIMAL_PILL_HEIGHT,
      hollowStroke: MINIMAL_PILL_RING_STROKE,
    }),
    dotFg: buildMinimalStadiumSprite({
      width: MINIMAL_DOT_SIZE,
      height: MINIMAL_DOT_SIZE,
      hollowStroke: 0,
    }),
  }),
});

/** @type {Map<string, Uint8Array>} */
const clockHandsCache = new Map();

/**
 * Computes the Euclidean distance from point (px, py) to line segment (ax, ay)-(bx, by).
 *
 * @param {{ px: number, py: number }} pt - Sample point.
 * @param {{ ax: number, ay: number, bx: number, by: number }} seg - Line segment endpoints.
 * @returns {number}
 */
function distToSegment(pt, seg) {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(pt.px - seg.ax, pt.py - seg.ay);
  }
  const t = Math.max(0, Math.min(1, ((pt.px - seg.ax) * dx + (pt.py - seg.ay) * dy) / lenSq));
  return Math.hypot(pt.px - (seg.ax + t * dx), pt.py - (seg.ay + t * dy));
}

/**
 * Returns a cached 4x4-SSAA alpha mask for the 24x24 analog clock hour/minute hands and center pivot
 * matching an HH:MM timestamp.
 *
 * @param {string} hmText - Formatted HH:MM string.
 * @param {number} [size=DEFAULT_CLOCK_SIZE] - Square icon pixel dimension.
 * @returns {Uint8Array}
 */
function getClockHandsMask(hmText, size = DEFAULT_CLOCK_SIZE) {
  const match = CLOCK_HM_REGEX.exec(String(hmText || ''));
  const hours = match ? Number(match[1]) % HOURS_PER_DIAL : DEFAULT_CLOCK_HOURS;
  const mins = match ? Number(match[2]) % MINS_PER_HOUR : DEFAULT_CLOCK_MINS;
  const cacheKey = size + ':' + hours + ':' + mins;
  const cached = clockHandsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const center = size / 2;
  const hourAngle = ((hours + mins / MINS_PER_HOUR) / HOURS_PER_DIAL) * Math.PI * 2 - Math.PI / 2;
  const minAngle = (mins / MINS_PER_HOUR) * Math.PI * 2 - Math.PI / 2;
  const hourLen = size * CLOCK_HOUR_LEN_RATIO;
  const minLen = size * CLOCK_MIN_LEN_RATIO;
  const hourStroke = Math.max(MIN_HAND_STROKE_PX, size * CLOCK_HOUR_STROKE_RATIO);
  const minStroke = Math.max(MIN_HAND_STROKE_PX, size * CLOCK_MIN_STROKE_RATIO);
  const pivotR = Math.max(1, size * CLOCK_PIVOT_RATIO);

  const hourSeg = {
    ax: center,
    ay: center,
    bx: center + Math.cos(hourAngle) * hourLen,
    by: center + Math.sin(hourAngle) * hourLen,
  };
  const minSeg = {
    ax: center,
    ay: center,
    bx: center + Math.cos(minAngle) * minLen,
    by: center + Math.sin(minAngle) * minLen,
  };

  const mask = new Uint8Array(size * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SSAA_GRID; sy++) {
        const y = py + (sy + HALF) / SSAA_GRID;
        for (let sx = 0; sx < SSAA_GRID; sx++) {
          const x = px + (sx + HALF) / SSAA_GRID;
          const pt = {px: x, py: y};
          if (
            Math.hypot(x - center, y - center) <= pivotR ||
            distToSegment(pt, hourSeg) <= hourStroke ||
            distToSegment(pt, minSeg) <= minStroke
          ) {
            hits++;
          }
        }
      }
      mask[py * size + px] = Math.round((hits * MAX_ALPHA_BYTE) / SSAA_SAMPLES);
    }
  }

  if (clockHandsCache.size >= MAX_CLOCK_CACHE) {
    const oldestKey = clockHandsCache.keys().next().value;
    if (oldestKey !== undefined) {
      clockHandsCache.delete(oldestKey);
    }
  }
  clockHandsCache.set(cacheKey, mask);
  return mask;
}

/**
 * Renders one 5-sample outer optical halo pass around an alpha sprite, masking out the sprite's
 * own interior pixels (1 - selfAlpha) and tapering halo strength on dark backdrops so thin icon
 * strokes are never self-eroded or darkened.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{
 *   baseX: number,
 *   baseY: number,
 *   width: number,
 *   height: number,
 *   mask: Uint8Array,
 *   opacity: number
 * }} layer - Sprite layer geometry.
 */
function renderOuterOpticalHalo(canvas, layer) {
  const {baseX, baseY, width, height, mask, opacity} = layer;
  for (const [ox, oy, weight] of OPTICAL_HALO_OFFSETS) {
    const sScale = (weight * opacity) / MAX_ALPHA_BYTE;
    for (let row = 0; row < height; row++) {
      const py = baseY + row + oy;
      if (py < 0 || py >= H) {
        continue;
      }
      const rowOff = row * width;
      const tRow = row + oy;
      const inRow = tRow >= 0 && tRow < height;
      for (let col = 0; col < width; col++) {
        const a = mask[rowOff + col];
        if (a === 0) {
          continue;
        }
        const tCol = col + ox;
        const gx = baseX + tCol;
        if (gx < 0 || gx >= CANVAS_WIDTH) {
          continue;
        }
        const selfA = inRow && tCol >= 0 && tCol < width ? mask[tRow * width + tCol] : 0;
        const outerWeight = 1 - selfA / MAX_ALPHA_BYTE;
        const bgY = canvas[py * CANVAS_WIDTH + gx];
        const bgWeight = Math.max(0, Math.min(1, (bgY - HALO_BG_START_LUMA) / HALO_BG_SPAN_LUMA));
        const effAlpha = a * sScale * outerWeight * bgWeight;
        if (effAlpha > 0) {
          blendYuvPixel(canvas, gx, py, HALO_RGB_R, HALO_RGB_G, HALO_RGB_B, effAlpha);
        }
      }
    }
  }
}

/**
 * Blits an anti-aliased alpha mask sprite onto a YUV420p frame buffer with an optional
 * 5-sample outer optical micro-contrast halo so white contours stay legible on sunlit scenes
 * without eroding thin strokes on dark backgrounds.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{
 *   x: number,
 *   y: number,
 *   sprite: { width: number, height: number, mask: Uint8Array }
 * }} pos - Top-left coordinates and sprite.
 * @param {{
 *   rgb: readonly number[],
 *   opacity?: number,
 *   shadow?: boolean
 * }} style - Foreground RGB, opacity, and halo flag.
 */
function blitAlphaSprite(canvas, pos, style) {
  const {sprite} = pos;
  const opacity = style.opacity === undefined ? 1 : style.opacity;
  if (!sprite || opacity <= 0) {
    return;
  }
  const baseX = Math.round(pos.x);
  const baseY = Math.round(pos.y);
  const {width, height, mask} = sprite;

  if (style.shadow !== false) {
    renderOuterOpticalHalo(canvas, {baseX, baseY, width, height, mask, opacity});
  }

  const [r, g, b] = style.rgb;
  const fgScale = opacity / MAX_ALPHA_BYTE;
  for (let row = 0; row < height; row++) {
    const py = baseY + row;
    if (py < 0 || py >= H) {
      continue;
    }
    const rowOff = row * width;
    for (let col = 0; col < width; col++) {
      const a = mask[rowOff + col];
      if (a !== 0) {
        blendYuvPixel(canvas, baseX + col, py, r, g, b, a * fgScale);
      }
    }
  }
}

module.exports = {
  LUCIDE_ICON_SPRITES,
  blitAlphaSprite,
  getClockHandsMask,
};
