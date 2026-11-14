// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Low-level YUV420p planar pixel blending, Smoked Obsidian Crystal surfaces,
 * high-contrast diagnostic HUD matte scrim + haloed monospace text, separable
 * box blur, and region copying.
 */
'use strict';

const {W, H, FRAME, SLEEP_SCREENS} = require('../config');

const FROSTED_BLUR_PASSES = 3;
const FROSTED_LUMA_BLUR_RADIUS = 12;
const FROSTED_CHROMA_BLUR_RADIUS = 6;
const ROUNDED_BOX_BLUR_PAD_PX = 28;
const HALF_PIXEL = 0.5;
const MAX_CHANNEL_BYTE = 255;
const BLACK_BG_LUMA = 0x10;
const SLATE_BG_LUMA = 0x22;
const NEUTRAL_CHROMA = 0x80;

const SMOKED_OBSIDIAN_R = 8;
const SMOKED_OBSIDIAN_G = 11;
const SMOKED_OBSIDIAN_B = 18;
const SMOKED_OBSIDIAN_ALPHA = 0.54;
const CRYSTAL_CHROMA_DAMP = 0.82;
const CRYSTAL_FROST_ALPHA = 0.11;
const CRYSTAL_FROST_GRAD_DROP = 0.65;
const CRYSTAL_AA_RADIUS = 0.82;
const CRYSTAL_TANGENT_INSET = 0.5;
const CRYSTAL_SSAA_GRID = 4;
const CRYSTAL_SSAA_SAMPLES = 16;
const SMOOTHSTEP_A = 3;
const SMOOTHSTEP_B = 2;
const CHROMA_ODD_WEIGHT = 0.5;
const CHROMA_QUAD_AVG = 0.25;
const LUMA_COEFF_R = 0.257;
const LUMA_COEFF_G = 0.504;
const LUMA_COEFF_B = 0.098;
const LUMA_OFFSET = 16;
const CHROMA_U_R = -0.148;
const CHROMA_U_G = -0.291;
const CHROMA_U_B = 0.439;
const CHROMA_V_R = 0.439;
const CHROMA_V_G = -0.368;
const CHROMA_V_B = -0.071;
const CHROMA_OFFSET = 128;

const HUD_CORNER_RADIUS_PX = 6;
const HUD_MAX_BLUR_LUMA = 60;
const HUD_LUMA_SCALE = 0.25;
const HUD_LUMA_LIFT = 12;
const HUD_CHROMA_DAMP = 0.08;
const HUD_SCRIM_R = 10;
const HUD_SCRIM_G = 13;
const HUD_SCRIM_B = 19;
const HUD_SCRIM_ALPHA = 0.86;
const HUD_BORDER_ALPHA = 0.22;
const HUD_RIM_WIDTH_PX = 1;
const HUD_BAND_OFFSET_X = 48;
const HUD_BAND_RIGHT_INSET = 54;
const HUD_BAND_ROW1_Y = 21;
const HUD_BAND_ROW3_Y = 51;
const HUD_BAND_HEIGHT = 14;
const HUD_BAND_ALPHA = 0.045;
const HUD_DIVIDER_X = 45;
const HUD_DIVIDER_PAD_Y = 8;
const HUD_DIVIDER_ALPHA = 0.14;

const MONO_CHAR_ADVANCE_PX = 7;
const MONO_GLYPH_W = 5;
const MONO_GLYPH_H = 9;
const HUD_HALO_R = 4;
const HUD_HALO_G = 5;
const HUD_HALO_B = 8;
const HUD_HALO_SIDE_WEIGHT = 0.65;
const HUD_HALO_TRAIL_WEIGHT = 0.85;
const HUD_PIPE_HALO_ALPHA = 0.45;
const HUD_KEY_HALO_ALPHA = 0.75;
const HUD_VAL_HALO_ALPHA = 0.88;
const HUD_PLAIN_HALO_ALPHA = 0.8;
const HUD_PIPE_RGB = Object.freeze([105, 110, 120]);
const HUD_KEY_RGB = Object.freeze([176, 182, 192]);
const HUD_VAL_RGB = Object.freeze([255, 255, 255]);

// Reusable scratch buffers for separable box-blur passes, blurred sub-regions, and base backdrop canvas.
let blurScratch = Buffer.allocUnsafe(0);
let regionScratch = Buffer.allocUnsafe(0);
const bgCanvasScratch = Buffer.allocUnsafe(FRAME);

/**
 * Blends an RGB pixel with opacity alpha (0..1) into a raw YUV420p frame buffer at (x, y).
 *
 * @param {Uint8Array} yuvBuf - Target YUV420p frame buffer of length FRAME.
 * @param {number} x - Horizontal pixel coordinate (0..W-1).
 * @param {number} y - Vertical pixel coordinate (0..H-1).
 * @param {number} r - Red component (0..255).
 * @param {number} g - Green component (0..255).
 * @param {number} b - Blue component (0..255).
 * @param {number} alpha - Opacity from 0.0 (transparent) to 1.0 (opaque).
 */
function blendYuvPixel(yuvBuf, x, y, r, g, b, alpha) {
  if (x < 0 || x >= W || y < 0 || y >= H || alpha <= 0) {
    return;
  }
  const a = alpha > 1 ? 1 : alpha;
  const invA = 1 - a;

  const yVal = (LUMA_COEFF_R * r + LUMA_COEFF_G * g + LUMA_COEFF_B * b + LUMA_OFFSET + HALF_PIXEL) | 0;
  const yIdx = y * W + x;
  yuvBuf[yIdx] = (yuvBuf[yIdx] * invA + yVal * a + HALF_PIXEL) | 0;

  const chromaA = (x & 1) === 0 && (y & 1) === 0 ? a : a * CHROMA_ODD_WEIGHT;
  const invChromaA = 1 - chromaA;
  const uVal = (CHROMA_U_R * r + CHROMA_U_G * g + CHROMA_U_B * b + CHROMA_OFFSET + HALF_PIXEL) | 0;
  const vVal = (CHROMA_V_R * r + CHROMA_V_G * g + CHROMA_V_B * b + CHROMA_OFFSET + HALF_PIXEL) | 0;
  const chromaOffset = (y >> 1) * (W >> 1) + (x >> 1);
  const uIdx = W * H + chromaOffset;
  const vIdx = uIdx + (W >> 1) * (H >> 1);
  yuvBuf[uIdx] = (yuvBuf[uIdx] * invChromaA + uVal * chromaA + HALF_PIXEL) | 0;
  yuvBuf[vIdx] = (yuvBuf[vIdx] * invChromaA + vVal * chromaA + HALF_PIXEL) | 0;
}

/**
 * Draws a filled rectangle onto a YUV420p frame buffer with alpha blending.
 *
 * @param {Uint8Array} yuvBuf - Target YUV420p frame buffer.
 * @param {number} rx - Left X coordinate.
 * @param {number} ry - Top Y coordinate.
 * @param {number} rw - Rectangle width in pixels.
 * @param {number} rh - Rectangle height in pixels.
 * @param {number} r - Red component (0..255).
 * @param {number} g - Green component (0..255).
 * @param {number} b - Blue component (0..255).
 * @param {number} alpha - Opacity (0..1).
 */
function fillYuvRect(yuvBuf, rx, ry, rw, rh, r, g, b, alpha) {
  const x0 = Math.max(0, Math.round(rx));
  const y0 = Math.max(0, Math.round(ry));
  const x1 = Math.min(W, Math.round(rx + rw));
  const y1 = Math.min(H, Math.round(ry + rh));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      blendYuvPixel(yuvBuf, x, y, r, g, b, alpha);
    }
  }
}

/**
 * Performs a single horizontal + vertical sliding-window box blur pass on a planar Y, U, or V buffer.
 *
 * @param {Uint8Array} buf - Target YUV420p region buffer.
 * @param {number} offset - Byte offset where the plane starts.
 * @param {number} width - Plane width in pixels.
 * @param {number} height - Plane height in pixels.
 * @param {number} radius - Blur kernel radius in pixels.
 */
function boxBlurPlane(buf, offset, width, height, radius) {
  const planeLen = width * height;
  if (blurScratch.length < planeLen) {
    blurScratch = Buffer.allocUnsafe(planeLen);
  }
  const diam = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    const rowOff = offset + y * width;
    const tmpRow = y * width;
    let sum = buf[rowOff] * (radius + 1);
    for (let i = 1; i <= radius; i++) {
      sum += buf[rowOff + Math.min(width - 1, i)];
    }
    for (let x = 0; x < width; x++) {
      blurScratch[tmpRow + x] = (sum / diam) | 0;
      const leftIdx = Math.max(0, x - radius);
      const rightIdx = Math.min(width - 1, x + radius + 1);
      sum += buf[rowOff + rightIdx] - buf[rowOff + leftIdx];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = blurScratch[x] * (radius + 1);
    for (let i = 1; i <= radius; i++) {
      sum += blurScratch[Math.min(height - 1, i) * width + x];
    }
    for (let y = 0; y < height; y++) {
      buf[offset + y * width + x] = (sum / diam) | 0;
      const topIdx = Math.max(0, y - radius);
      const botIdx = Math.min(height - 1, y + radius + 1);
      sum += blurScratch[botIdx * width + x] - blurScratch[topIdx * width + x];
    }
  }
}

/**
 * Extracts and blurs a rectangular sub-region of a YUV420p frame buffer using a 3-pass
 * separable box blur to produce a frosted-glass backdrop behind status cards.
 *
 * @param {Uint8Array} canvas - Source YUV420p frame buffer of length FRAME.
 * @param {number} rx0 - Even-aligned left X coordinate of the region.
 * @param {number} ry0 - Even-aligned top Y coordinate of the region.
 * @param {number} rw - Even-aligned width of the region.
 * @param {number} rh - Even-aligned height of the region.
 * @returns {{ buf: Uint8Array, lumaSize: number, chromaSize: number, cw: number }}
 */
function extractBlurredRegion(canvas, rx0, ry0, rw, rh) {
  const cw = rw >> 1;
  const ch = rh >> 1;
  const lumaSize = rw * rh;
  const chromaSize = cw * ch;
  const totalBytes = lumaSize + chromaSize * 2;
  if (regionScratch.length < totalBytes) {
    regionScratch = Buffer.allocUnsafe(totalBytes);
  }
  const regionBuf = regionScratch.subarray(0, totalBytes);

  for (let y = 0; y < rh; y++) {
    const srcOff = (ry0 + y) * W + rx0;
    regionBuf.set(canvas.subarray(srcOff, srcOff + rw), y * rw);
  }

  const fullCw = W >> 1;
  const fullChromaSize = fullCw * (H >> 1);
  for (let cy = 0; cy < ch; cy++) {
    const srcU = W * H + ((ry0 >> 1) + cy) * fullCw + (rx0 >> 1);
    const srcV = srcU + fullChromaSize;
    regionBuf.set(canvas.subarray(srcU, srcU + cw), lumaSize + cy * cw);
    regionBuf.set(canvas.subarray(srcV, srcV + cw), lumaSize + chromaSize + cy * cw);
  }

  for (let pass = 0; pass < FROSTED_BLUR_PASSES; pass++) {
    boxBlurPlane(regionBuf, 0, rw, rh, FROSTED_LUMA_BLUR_RADIUS);
    boxBlurPlane(regionBuf, lumaSize, cw, ch, FROSTED_CHROMA_BLUR_RADIUS);
    boxBlurPlane(regionBuf, lumaSize + chromaSize, cw, ch, FROSTED_CHROMA_BLUR_RADIUS);
  }

  return {buf: regionBuf, lumaSize, chromaSize, cw};
}

/**
 * Converts RGB (0..255) to floating-point BT.601 [y, u, v] values.
 *
 * @param {number} r - Red component.
 * @param {number} g - Green component.
 * @param {number} b - Blue component.
 * @returns {readonly [number, number, number]}
 */
function rgbToYuvFloat(r, g, b) {
  return Object.freeze([
    LUMA_COEFF_R * r + LUMA_COEFF_G * g + LUMA_COEFF_B * b + LUMA_OFFSET,
    CHROMA_U_R * r + CHROMA_U_G * g + CHROMA_U_B * b + CHROMA_OFFSET,
    CHROMA_V_R * r + CHROMA_V_G * g + CHROMA_V_B * b + CHROMA_OFFSET,
  ]);
}

/**
 * Evaluates a cubic Hermite smoothstep from edge0 (0.0) to edge1 (1.0).
 *
 * @param {number} edge0 - Lower edge.
 * @param {number} edge1 - Upper edge.
 * @param {number} x - Sample value.
 * @returns {number}
 */
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (SMOOTHSTEP_A - SMOOTHSTEP_B * t);
}

/**
 * Computes 4x4 subpixel Gaussian/smoothstep anti-aliased capsule coverage (0..1) at (px, py).
 *
 * @param {number} px - Capsule-relative X.
 * @param {number} py - Capsule-relative Y.
 * @param {{ hx: number, hy: number, innerHalfW: number, innerHalfH: number, rSafe: number }} geom - Capsule geometry.
 * @returns {number}
 */
function computeSmoothCapsuleCov(px, py, geom) {
  const {hx, hy, innerHalfW, innerHalfH, rSafe} = geom;
  const qxCenter = Math.abs(px + HALF_PIXEL - hx) - innerHalfW;
  const qyCenter = Math.abs(py + HALF_PIXEL - hy) - innerHalfH;
  const sdfCenter =
    Math.hypot(Math.max(qxCenter, 0), Math.max(qyCenter, 0)) + Math.min(Math.max(qxCenter, qyCenter), 0) - rSafe;

  const fastMargin = CRYSTAL_AA_RADIUS + HALF_PIXEL;
  if (sdfCenter <= -fastMargin) {
    return 1;
  }
  if (sdfCenter >= fastMargin) {
    return 0;
  }

  const invGrid = 1 / CRYSTAL_SSAA_GRID;
  let sum = 0;
  for (let sy = 0; sy < CRYSTAL_SSAA_GRID; sy++) {
    const yf = py + (sy + HALF_PIXEL) * invGrid;
    const qy = Math.abs(yf - hy) - innerHalfH;
    const qyPos = Math.max(qy, 0);
    for (let sx = 0; sx < CRYSTAL_SSAA_GRID; sx++) {
      const xf = px + (sx + HALF_PIXEL) * invGrid;
      const qx = Math.abs(xf - hx) - innerHalfW;
      const qxPos = Math.max(qx, 0);
      const d = Math.hypot(qxPos, qyPos) + Math.min(Math.max(qx, qy), 0) - rSafe;
      sum += smoothstep(CRYSTAL_AA_RADIUS, -CRYSTAL_AA_RADIUS, d);
    }
  }
  return sum / CRYSTAL_SSAA_SAMPLES;
}

/**
 * Normalizes optional crystal surface style overrides to concrete numeric thresholds.
 *
 * @param {{
 *   radius?: number,
 *   blurBackdrop?: boolean,
 *   jewelRgb?: readonly number[]|null,
 *   jewelAlpha?: number,
 *   whiteFrostAlpha?: number
 * }} opts - Raw options.
 * @param {number} defaultRadius - Default pill radius (hy).
 * @returns {{
 *   radius: number,
 *   blurBackdrop: boolean,
 *   jewelRgb: readonly number[]|null,
 *   jewelAlpha: number,
 *   frostAlpha: number
 * }}
 */
function resolveCrystalStyle(opts, defaultRadius) {
  return {
    radius: opts.radius === undefined ? defaultRadius : opts.radius,
    blurBackdrop: opts.blurBackdrop !== false,
    jewelRgb: opts.jewelRgb || null,
    jewelAlpha: opts.jewelAlpha || 0,
    frostAlpha: opts.whiteFrostAlpha === undefined ? CRYSTAL_FROST_ALPHA : opts.whiteFrostAlpha,
  };
}

const OBSIDIAN_YUV = rgbToYuvFloat(SMOKED_OBSIDIAN_R, SMOKED_OBSIDIAN_G, SMOKED_OBSIDIAN_B);
const WHITE_YUV = rgbToYuvFloat(MAX_CHANNEL_BYTE, MAX_CHANNEL_BYTE, MAX_CHANNEL_BYTE);

/**
 * Evaluates the composite YUV target color at one pixel (gx, gy) for single-pass crystal compositing.
 *
 * @param {number} gx - Frame X coordinate.
 * @param {number} gy - Frame Y coordinate.
 * @param {{
 *   canvas: Uint8Array,
 *   boxX: number,
 *   boxY: number,
 *   boxH: number,
 *   rx0: number,
 *   ry0: number,
 *   rw: number,
 *   rh: number,
 *   blurred: { buf: Uint8Array, lumaSize: number, chromaSize: number, cw: number }|null,
 *   geom: { hx: number, hy: number, innerHalfW: number, innerHalfH: number, rSafe: number },
 *   hasJewel: boolean,
 *   jewelYuv: readonly [number, number, number],
 *   jewelAlpha: number,
 *   frostAlpha: number
 * }} ctx - Crystal context.
 * @returns {{ y: number, u: number, v: number }}
 */
function evalCrystalPixelTarget(gx, gy, ctx) {
  const {canvas} = ctx;
  const halfW = W >> 1;
  const uOff = W * H;
  const vOff = uOff + halfW * (H >> 1);
  const bgY = canvas[gy * W + gx];
  const cIdx = (gy >> 1) * halfW + (gx >> 1);
  const bgU = canvas[uOff + cIdx];
  const bgV = canvas[vOff + cIdx];

  const px = gx - ctx.boxX;
  const py = gy - ctx.boxY;
  if (px < 0 || px >= ctx.geom.hx * 2 || py < 0 || py >= ctx.boxH) {
    return {y: bgY, u: bgU, v: bgV};
  }
  const cov = computeSmoothCapsuleCov(px, py, ctx.geom);
  if (cov <= 0) {
    return {y: bgY, u: bgU, v: bgV};
  }

  let intY = bgY;
  let intU = bgU;
  let intV = bgV;
  if (ctx.blurred) {
    const lx = Math.max(0, Math.min(ctx.rw - 1, gx - ctx.rx0));
    const ly = Math.max(0, Math.min(ctx.rh - 1, gy - ctx.ry0));
    intY = ctx.blurred.buf[ly * ctx.rw + lx];
    const rOff = (ly >> 1) * ctx.blurred.cw + (lx >> 1);
    intU = NEUTRAL_CHROMA + (ctx.blurred.buf[ctx.blurred.lumaSize + rOff] - NEUTRAL_CHROMA) * CRYSTAL_CHROMA_DAMP;
    intV =
      NEUTRAL_CHROMA +
      (ctx.blurred.buf[ctx.blurred.lumaSize + ctx.blurred.chromaSize + rOff] - NEUTRAL_CHROMA) * CRYSTAL_CHROMA_DAMP;
  }

  if (!ctx.hasJewel) {
    intY = intY * (1 - SMOKED_OBSIDIAN_ALPHA) + OBSIDIAN_YUV[0] * SMOKED_OBSIDIAN_ALPHA;
    intU = intU * (1 - SMOKED_OBSIDIAN_ALPHA) + OBSIDIAN_YUV[1] * SMOKED_OBSIDIAN_ALPHA;
    intV = intV * (1 - SMOKED_OBSIDIAN_ALPHA) + OBSIDIAN_YUV[2] * SMOKED_OBSIDIAN_ALPHA;
  } else {
    intY = intY * (1 - ctx.jewelAlpha) + ctx.jewelYuv[0] * ctx.jewelAlpha;
    intU = intU * (1 - ctx.jewelAlpha) + ctx.jewelYuv[1] * ctx.jewelAlpha;
    intV = intV * (1 - ctx.jewelAlpha) + ctx.jewelYuv[2] * ctx.jewelAlpha;
  }

  if (ctx.frostAlpha > 0) {
    const grad = Math.max(0, 1 - CRYSTAL_FROST_GRAD_DROP * (py / Math.max(1, ctx.boxH)));
    const fAlpha = ctx.frostAlpha * grad;
    intY = intY * (1 - fAlpha) + WHITE_YUV[0] * fAlpha;
    intU = intU * (1 - fAlpha) + NEUTRAL_CHROMA * fAlpha;
    intV = intV * (1 - fAlpha) + NEUTRAL_CHROMA * fAlpha;
  }

  return {
    y: bgY * (1 - cov) + intY * cov,
    u: bgU * (1 - cov) + intU * cov,
    v: bgV * (1 - cov) + intV * cov,
  };
}

/**
 * Renders the borderless, hairline-free Smoked Obsidian Crystal surface using 16x subpixel
 * Gaussian/smoothstep anti-aliasing and 2x2 YUV420p chroma averaging:
 * - 3-pass video blur with 0.82 chroma damping
 * - 54% Smoked Obsidian (#080b12) tint on non-jewel capsules
 * - 11% top-lit white frost sheen
 * - Strictly 0px border rim and 0px outer hairline
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer of length FRAME.
 * @param {{ boxX: number, boxY: number, boxW: number, boxH: number }} bounds - Card bounds.
 * @param {{
 *   radius?: number,
 *   blurBackdrop?: boolean,
 *   jewelRgb?: readonly number[]|null,
 *   jewelAlpha?: number,
 *   whiteFrostAlpha?: number
 * }} [opts={}] - Surface options.
 */
function drawCrystalSurface(canvas, bounds, opts = {}) {
  const {boxX, boxY, boxW, boxH} = bounds;
  const hx = boxW / 2;
  const hy = boxH / 2;
  const style = resolveCrystalStyle(opts, hy);
  const pad = ROUNDED_BOX_BLUR_PAD_PX;
  const rx0 = Math.max(0, (boxX - pad) & ~1);
  const ry0 = Math.max(0, (boxY - pad) & ~1);
  const rx1 = Math.min(W, (boxX + boxW + pad + 1) & ~1);
  const ry1 = Math.min(H, (boxY + boxH + pad + 1) & ~1);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  const blurred = style.blurBackdrop ? extractBlurredRegion(canvas, rx0, ry0, rw, rh) : null;

  const rSafe = Math.max(1, Math.min(style.radius, hx, hy) - CRYSTAL_TANGENT_INSET);
  const geom = {
    hx,
    hy,
    innerHalfW: Math.max(0, hx - CRYSTAL_TANGENT_INSET - rSafe),
    innerHalfH: Math.max(0, hy - CRYSTAL_TANGENT_INSET - rSafe),
    rSafe,
  };
  const hasJewel = Boolean(style.jewelRgb && style.jewelAlpha > 0);
  const jewelYuv =
    hasJewel && style.jewelRgb ? rgbToYuvFloat(style.jewelRgb[0], style.jewelRgb[1], style.jewelRgb[2]) : OBSIDIAN_YUV;
  const ctx = {
    canvas,
    boxX,
    boxY,
    boxH,
    rx0,
    ry0,
    rw,
    rh,
    blurred,
    geom,
    hasJewel,
    jewelYuv,
    jewelAlpha: style.jewelAlpha,
    frostAlpha: style.frostAlpha,
  };

  const xStart = Math.max(0, boxX & ~1);
  const yStart = Math.max(0, boxY & ~1);
  const xEnd = Math.min(W, (boxX + boxW + 1) & ~1);
  const yEnd = Math.min(H, (boxY + boxH + 1) & ~1);
  const halfW = W >> 1;
  const uOff = W * H;
  const vOff = uOff + halfW * (H >> 1);

  for (let gy = yStart; gy < yEnd; gy += 2) {
    for (let gx = xStart; gx < xEnd; gx += 2) {
      const p00 = evalCrystalPixelTarget(gx, gy, ctx);
      const p10 = evalCrystalPixelTarget(gx + 1, gy, ctx);
      const p01 = evalCrystalPixelTarget(gx, gy + 1, ctx);
      const p11 = evalCrystalPixelTarget(gx + 1, gy + 1, ctx);

      canvas[gy * W + gx] = (p00.y + HALF_PIXEL) | 0;
      canvas[gy * W + gx + 1] = (p10.y + HALF_PIXEL) | 0;
      canvas[(gy + 1) * W + gx] = (p01.y + HALF_PIXEL) | 0;
      canvas[(gy + 1) * W + gx + 1] = (p11.y + HALF_PIXEL) | 0;

      const cIdx = (gy >> 1) * halfW + (gx >> 1);
      canvas[uOff + cIdx] = ((p00.u + p10.u + p01.u + p11.u) * CHROMA_QUAD_AVG + HALF_PIXEL) | 0;
      canvas[vOff + cIdx] = ((p00.v + p10.v + p01.v + p11.v) * CHROMA_QUAD_AVG + HALF_PIXEL) | 0;
    }
  }
}

/**
 * Renders the high-contrast diagnostic HUD surface (6px rounded deep-slate matte scrim,
 * normalized backdrop luma, 92% chroma desaturation, 1px crisp white border, alternating
 * subtle row bands, and left status divider).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer of length FRAME.
 * @param {{ boxX: number, boxY: number, boxW: number, boxH: number }} bounds - HUD bounding box.
 * @param {boolean} [blurBackdrop=true] - Whether to blur and normalize the underlying video region.
 */
function drawHudSurface(canvas, bounds, blurBackdrop = true) {
  const {boxX, boxY, boxW, boxH} = bounds;
  const pad = ROUNDED_BOX_BLUR_PAD_PX;
  const rx0 = Math.max(0, (boxX - pad) & ~1);
  const ry0 = Math.max(0, (boxY - pad) & ~1);
  const rx1 = Math.min(W, (boxX + boxW + pad + 1) & ~1);
  const ry1 = Math.min(H, (boxY + boxH + pad + 1) & ~1);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  const blurred = blurBackdrop ? extractBlurredRegion(canvas, rx0, ry0, rw, rh) : null;

  const hx = boxW / 2;
  const hy = boxH / 2;
  const rSafe = Math.min(HUD_CORNER_RADIUS_PX, hx, hy);
  const innerHalfW = hx - rSafe;
  const innerHalfH = hy - rSafe;

  for (let py = 0; py < boxH; py++) {
    const qy = Math.abs(py + HALF_PIXEL - hy) - innerHalfH;
    for (let px = 0; px < boxW; px++) {
      const gx = boxX + px;
      const gy = boxY + py;
      if (gx < rx0 || gx >= rx1 || gy < ry0 || gy >= ry1) {
        continue;
      }
      const qx = Math.abs(px + HALF_PIXEL - hx) - innerHalfW;
      const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rSafe;
      const cov = Math.min(1, Math.max(0, HALF_PIXEL - sdf));
      if (cov <= 0) {
        continue;
      }

      if (blurred) {
        const lx = gx - rx0;
        const ly = gy - ry0;
        const yIdx = gy * W + gx;
        const rawY = blurred.buf[ly * rw + lx];
        const normY = Math.min(HUD_MAX_BLUR_LUMA, rawY * HUD_LUMA_SCALE + HUD_LUMA_LIFT);
        canvas[yIdx] = (canvas[yIdx] * (1 - cov) + normY * cov + HALF_PIXEL) | 0;

        if ((gx & 1) === 0 && (gy & 1) === 0) {
          const cOff = (gy >> 1) * (W >> 1) + (gx >> 1);
          const uIdx = W * H + cOff;
          const vIdx = uIdx + (W >> 1) * (H >> 1);
          const rOff = (ly >> 1) * blurred.cw + (lx >> 1);
          const bU = NEUTRAL_CHROMA + (blurred.buf[blurred.lumaSize + rOff] - NEUTRAL_CHROMA) * HUD_CHROMA_DAMP;
          const bV =
            NEUTRAL_CHROMA +
            (blurred.buf[blurred.lumaSize + blurred.chromaSize + rOff] - NEUTRAL_CHROMA) * HUD_CHROMA_DAMP;
          canvas[uIdx] = (canvas[uIdx] * (1 - cov) + bU * cov + HALF_PIXEL) | 0;
          canvas[vIdx] = (canvas[vIdx] * (1 - cov) + bV * cov + HALF_PIXEL) | 0;
        }
      }

      blendYuvPixel(canvas, gx, gy, HUD_SCRIM_R, HUD_SCRIM_G, HUD_SCRIM_B, HUD_SCRIM_ALPHA * cov);
      const innerCov = Math.min(1, Math.max(0, HALF_PIXEL - (sdf + HUD_RIM_WIDTH_PX)));
      const rimCov = cov - innerCov;
      if (rimCov > 0) {
        blendYuvPixel(canvas, gx, gy, MAX_CHANNEL_BYTE, MAX_CHANNEL_BYTE, MAX_CHANNEL_BYTE, HUD_BORDER_ALPHA * rimCov);
      }
    }
  }

  fillYuvRect(
    canvas,
    boxX + HUD_BAND_OFFSET_X,
    boxY + HUD_BAND_ROW1_Y,
    boxW - HUD_BAND_RIGHT_INSET,
    HUD_BAND_HEIGHT,
    MAX_CHANNEL_BYTE,
    MAX_CHANNEL_BYTE,
    MAX_CHANNEL_BYTE,
    HUD_BAND_ALPHA
  );
  fillYuvRect(
    canvas,
    boxX + HUD_BAND_OFFSET_X,
    boxY + HUD_BAND_ROW3_Y,
    boxW - HUD_BAND_RIGHT_INSET,
    HUD_BAND_HEIGHT,
    MAX_CHANNEL_BYTE,
    MAX_CHANNEL_BYTE,
    MAX_CHANNEL_BYTE,
    HUD_BAND_ALPHA
  );
  fillYuvRect(
    canvas,
    boxX + HUD_DIVIDER_X,
    boxY + HUD_DIVIDER_PAD_Y,
    1,
    boxH - HUD_DIVIDER_PAD_Y * 2,
    MAX_CHANNEL_BYTE,
    MAX_CHANNEL_BYTE,
    MAX_CHANNEL_BYTE,
    HUD_DIVIDER_ALPHA
  );
}

/**
 * Prepares the base YUV420p sleeping screen canvas once per renderCameraCards() cycle so it can be
 * shared across the asleep, waking, and busy cards without repeating full-frame pixel loops.
 *
 * @param {{ theme: string, position: string, sleepScreen: string }} cardCfg - Resolved card config.
 * @param {Uint8Array|null} bgFrame - Last captured YUV420p video frame for this camera.
 * @returns {{ baseCanvas: Uint8Array, hasBackground: boolean }}
 */
function prepareBackgroundCanvas(cardCfg, bgFrame) {
  const baseCanvas = bgCanvasScratch;
  const hasBackground =
    cardCfg.sleepScreen === SLEEP_SCREENS.SNAPSHOT && Buffer.isBuffer(bgFrame) && bgFrame.length === FRAME;

  if (hasBackground) {
    bgFrame.copy(baseCanvas);
  } else {
    baseCanvas.fill(NEUTRAL_CHROMA, W * H);
    baseCanvas.fill(cardCfg.sleepScreen === SLEEP_SCREENS.BLACK ? BLACK_BG_LUMA : SLATE_BG_LUMA, 0, W * H);
  }

  return {baseCanvas, hasBackground};
}

/**
 * Fixed-width 5x9 monospace bitmap glyph table for zero-subprocess diagnostic HUD text rendering.
 *
 * @type {Readonly<Record<string, ReadonlyArray<number>>>}
 */
const MONO_FONT_5X9 = Object.freeze({
  0: [0x0e, 0x11, 0x11, 0x13, 0x15, 0x19, 0x11, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x14, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1f],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x10, 0x11, 0x1f],
  3: [0x0e, 0x11, 0x01, 0x01, 0x06, 0x01, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x12, 0x1f, 0x02, 0x02, 0x02],
  5: [0x1f, 0x10, 0x10, 0x1e, 0x01, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x11, 0x01, 0x02, 0x04, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x02, 0x0c],
  A: [0x04, 0x0a, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x10, 0x17, 0x11, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x18, 0x14, 0x12, 0x11, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x19, 0x15, 0x15, 0x13, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x15, 0x13, 0x0e, 0x01],
  R: [0x1e, 0x11, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11, 0x11],
  S: [0x0e, 0x11, 0x10, 0x08, 0x06, 0x01, 0x01, 0x11, 0x0e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x0a, 0x04, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x04, 0x08, 0x10, 0x10, 0x1f],
  ':': [0x00, 0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00, 0x00],
  '/': [0x01, 0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10, 0x10],
  '-': [0x00, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x00],
  '+': [0x00, 0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00, 0x00],
  '>': [0x00, 0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10, 0x00],
  _: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '%': [0x19, 0x19, 0x02, 0x04, 0x04, 0x08, 0x13, 0x13, 0x00],
  '*': [0x00, 0x04, 0x15, 0x0e, 0x1f, 0x0e, 0x15, 0x04, 0x00],
  '|': [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x0a, 0x0a, 0x1f, 0x0a, 0x0a],
});

/**
 * Draws a single 5x9 monospace glyph with a 5-sample dark luma halo so H.264 4:2:0 subsampling
 * never washes out 1px strokes over bright live video.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number, ch: string }} cell - Character position and character.
 * @param {{ rgb: readonly number[], haloAlpha: number }} style - Foreground RGB and halo alpha.
 */
function drawHaloMonoChar(canvas, cell, style) {
  const glyph = MONO_FONT_5X9[cell.ch] || MONO_FONT_5X9[cell.ch.toUpperCase()];
  if (!glyph || cell.x + MONO_GLYPH_W >= W) {
    return;
  }
  const {haloAlpha} = style;
  for (let row = 0; row < MONO_GLYPH_H; row++) {
    const bits = glyph[row];
    if (!bits) {
      continue;
    }
    const gy = cell.y + row;
    for (let col = 0; col < MONO_GLYPH_W; col++) {
      if ((bits & (1 << (MONO_GLYPH_W - 1 - col))) !== 0) {
        const gx = cell.x + col;
        blendYuvPixel(canvas, gx - 1, gy, HUD_HALO_R, HUD_HALO_G, HUD_HALO_B, haloAlpha * HUD_HALO_SIDE_WEIGHT);
        blendYuvPixel(canvas, gx + 1, gy, HUD_HALO_R, HUD_HALO_G, HUD_HALO_B, haloAlpha * HUD_HALO_TRAIL_WEIGHT);
        blendYuvPixel(canvas, gx, gy - 1, HUD_HALO_R, HUD_HALO_G, HUD_HALO_B, haloAlpha * HUD_HALO_SIDE_WEIGHT);
        blendYuvPixel(canvas, gx, gy + 1, HUD_HALO_R, HUD_HALO_G, HUD_HALO_B, haloAlpha * HUD_HALO_TRAIL_WEIGHT);
        blendYuvPixel(canvas, gx + 1, gy + 1, HUD_HALO_R, HUD_HALO_G, HUD_HALO_B, haloAlpha);
      }
    }
  }
  const [r, g, b] = style.rgb;
  for (let row = 0; row < MONO_GLYPH_H; row++) {
    const bits = glyph[row];
    if (!bits) {
      continue;
    }
    const gy = cell.y + row;
    for (let col = 0; col < MONO_GLYPH_W; col++) {
      if ((bits & (1 << (MONO_GLYPH_W - 1 - col))) !== 0) {
        blendYuvPixel(canvas, cell.x + col, gy, r, g, b, 1);
      }
    }
  }
}

/**
 * Renders fixed-width 5x9 monospace text onto a YUV420p canvas using neutral-luma
 * hierarchy (muted '|' pipes, silver 'KEY:' labels, crisp white values) or uniform white.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number }} pos - Top-left cell coordinates.
 * @param {{ text: string, syntaxHighlight?: boolean }} opts - Text string and optional KEY:VALUE hierarchy flag.
 */
function drawMonospaceText(canvas, pos, opts) {
  const {text} = opts;
  const len = text.length;
  if (!opts.syntaxHighlight) {
    for (let i = 0; i < len; i++) {
      if (text[i] !== ' ') {
        drawHaloMonoChar(
          canvas,
          {x: pos.x + i * MONO_CHAR_ADVANCE_PX, y: pos.y, ch: text[i]},
          {rgb: HUD_VAL_RGB, haloAlpha: HUD_PLAIN_HALO_ALPHA}
        );
      }
    }
    return;
  }

  let inKey = true;
  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (ch === ' ') {
      const rest = text.slice(i + 1);
      const nextSpace = rest.indexOf(' ');
      const nextColon = rest.indexOf(':');
      inKey = nextColon !== -1 && (nextSpace === -1 || nextColon < nextSpace);
      continue;
    }
    if (ch === '|') {
      drawHaloMonoChar(
        canvas,
        {x: pos.x + i * MONO_CHAR_ADVANCE_PX, y: pos.y, ch},
        {rgb: HUD_PIPE_RGB, haloAlpha: HUD_PIPE_HALO_ALPHA}
      );
      inKey = true;
      continue;
    }
    if (inKey) {
      drawHaloMonoChar(
        canvas,
        {x: pos.x + i * MONO_CHAR_ADVANCE_PX, y: pos.y, ch},
        {rgb: HUD_KEY_RGB, haloAlpha: HUD_KEY_HALO_ALPHA}
      );
      if (ch === ':') {
        inKey = false;
      }
    } else {
      drawHaloMonoChar(
        canvas,
        {x: pos.x + i * MONO_CHAR_ADVANCE_PX, y: pos.y, ch},
        {rgb: HUD_VAL_RGB, haloAlpha: HUD_VAL_HALO_ALPHA}
      );
    }
  }
}

module.exports = {
  blendYuvPixel,
  fillYuvRect,
  extractBlurredRegion,
  drawCrystalSurface,
  drawHudSurface,
  prepareBackgroundCanvas,
  drawMonospaceText,
};
