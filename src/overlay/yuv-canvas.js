// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Low-level YUV420p planar pixel blending, anti-aliased vector primitives,
 * separable box blur, and region copying.
 */
'use strict';

const {W, H, FRAME, SLEEP_SCREENS} = require('../config');

const FROSTED_BLUR_PASSES = 3;
const FROSTED_LUMA_BLUR_RADIUS = 12;
const FROSTED_CHROMA_BLUR_RADIUS = 6;
const ROUNDED_BOX_BLUR_PAD_PX = 28;
const HALF_PIXEL = 0.5;
const DEFAULT_BORDER_OPACITY = 0.18;
const RIM_WIDTH_PX = 1.25;
const GLASS_TINT_R = 12;
const GLASS_TINT_G = 12;
const GLASS_TINT_B = 14;
const MAX_CHANNEL_BYTE = 255;
const BLACK_BG_LUMA = 0x10;
const SLATE_BG_LUMA = 0x22;
const NEUTRAL_CHROMA = 0x80;

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

  const yVal = (0.257 * r + 0.504 * g + 0.098 * b + 16.5) | 0;
  const yIdx = y * W + x;
  yuvBuf[yIdx] = (yuvBuf[yIdx] * invA + yVal * a + 0.5) | 0;

  if ((x & 1) === 0 && (y & 1) === 0) {
    const uVal = (-0.148 * r - 0.291 * g + 0.439 * b + 128.5) | 0;
    const vVal = (0.439 * r - 0.368 * g - 0.071 * b + 128.5) | 0;
    const chromaOffset = (y >> 1) * (W >> 1) + (x >> 1);
    const uIdx = W * H + chromaOffset;
    const vIdx = uIdx + (W >> 1) * (H >> 1);
    yuvBuf[uIdx] = (yuvBuf[uIdx] * invA + uVal * a + 0.5) | 0;
    yuvBuf[vIdx] = (yuvBuf[vIdx] * invA + vVal * a + 0.5) | 0;
  }
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
 * @returns {{ buf: Uint8Array, buffer: ArrayBufferLike, lumaSize: number, chromaSize: number, cw: number }}
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

  return {buf: regionBuf, buffer: regionBuf.buffer, lumaSize, chromaSize, cw};
}

/**
 * Blends a single blurred backdrop pixel into the target YUV420p canvas at (gx, gy).
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} gx - Global X coordinate.
 * @param {number} gy - Global Y coordinate.
 * @param {number} rx0 - Region left X offset.
 * @param {number} ry0 - Region top Y offset.
 * @param {number} rw - Region width.
 * @param {{ buf: Uint8Array, lumaSize: number, chromaSize: number, cw: number }} blurred - Blurred region data.
 * @param {number} cov - Coverage weight (0..1).
 */
function blendBlurredBackdropPixel(canvas, gx, gy, rx0, ry0, rw, blurred, cov) {
  const lx = gx - rx0;
  const ly = gy - ry0;
  const yIdx = gy * W + gx;
  const bY = blurred.buf[ly * rw + lx];
  canvas[yIdx] = (canvas[yIdx] * (1 - cov) + bY * cov + 0.5) | 0;

  if ((gx & 1) === 0 && (gy & 1) === 0) {
    const cOff = (gy >> 1) * (W >> 1) + (gx >> 1);
    const uIdx = W * H + cOff;
    const vIdx = uIdx + (W >> 1) * (H >> 1);
    const rOff = (ly >> 1) * blurred.cw + (lx >> 1);
    const bU = blurred.buf[blurred.lumaSize + rOff];
    const bV = blurred.buf[blurred.lumaSize + blurred.chromaSize + rOff];
    canvas[uIdx] = (canvas[uIdx] * (1 - cov) + bU * cov + 0.5) | 0;
    canvas[vIdx] = (canvas[vIdx] * (1 - cov) + bV * cov + 0.5) | 0;
  }
}

/**
 * Draws a frosted-glass rounded rectangle or capsule onto a YUV420p frame buffer.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer of length FRAME.
 * @param {number} boxX - Left X coordinate.
 * @param {number} boxY - Top Y coordinate.
 * @param {number} boxW - Box width in pixels.
 * @param {number} boxH - Box height in pixels.
 * @param {number} radius - Corner radius in pixels.
 * @param {number} opacity - Dark glass tint opacity (0..1).
 * @param {number} [borderOpacity=DEFAULT_BORDER_OPACITY] - Subtle rim highlight opacity (0..1).
 * @param {boolean} [blurBackdrop=true] - Whether to run a frosted-glass blur on the underlying pixels.
 */
function drawRoundedBox(
    canvas,
    boxX,
    boxY,
    boxW,
    boxH,
    radius,
    opacity,
    borderOpacity = DEFAULT_BORDER_OPACITY,
    blurBackdrop = true
) {
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
  const rSafe = Math.min(radius, hx, hy);
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
        blendBlurredBackdropPixel(canvas, gx, gy, rx0, ry0, rw, blurred, cov);
      }

      blendYuvPixel(canvas, gx, gy, GLASS_TINT_R, GLASS_TINT_G, GLASS_TINT_B, opacity * cov);
      if (borderOpacity > 0) {
        const innerCov = Math.min(1, Math.max(0, HALF_PIXEL - (sdf + RIM_WIDTH_PX)));
        const rimCov = cov - innerCov;
        if (rimCov > 0) {
          blendYuvPixel(
              canvas,
              gx,
              gy,
              MAX_CHANNEL_BYTE,
              MAX_CHANNEL_BYTE,
              MAX_CHANNEL_BYTE,
              borderOpacity * rimCov
          );
        }
      }
    }
  }
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
      cardCfg.sleepScreen === SLEEP_SCREENS.SNAPSHOT &&
      Buffer.isBuffer(bgFrame) &&
      bgFrame.length === FRAME;

  if (hasBackground) {
    bgFrame.copy(baseCanvas);
  } else {
    baseCanvas.fill(NEUTRAL_CHROMA, W * H);
    baseCanvas.fill(
        cardCfg.sleepScreen === SLEEP_SCREENS.BLACK ? BLACK_BG_LUMA : SLATE_BG_LUMA,
        0,
        W * H
    );
  }

  return {baseCanvas, hasBackground};
}

const MONO_CHAR_ADVANCE_PX = 7;
const MONO_GLYPH_W = 5;
const MONO_GLYPH_H = 9;

/**
 * Fixed-width 5x9 monospace bitmap glyph table for zero-subprocess diagnostic HUD text rendering.
 *
 * @type {Readonly<Record<string, ReadonlyArray<number>>>}
 */
const MONO_FONT_5X9 = Object.freeze({
  '0': [0x0e, 0x11, 0x11, 0x13, 0x15, 0x19, 0x11, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x14, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1f],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x10, 0x11, 0x1f],
  '3': [0x0e, 0x11, 0x01, 0x01, 0x06, 0x01, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x12, 0x1f, 0x02, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x10, 0x1e, 0x01, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x11, 0x01, 0x02, 0x04, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x02, 0x0c],
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
 * Renders fixed-width monospace text directly onto a YUV420p canvas using a 5x9 bitmap font
 * with a 1px dark luma shadow so small white characters remain razor-sharp over blurred video.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} x - Left X coordinate of the first character cell.
 * @param {number} y - Top Y coordinate of the text row.
 * @param {string} text - Text string to render.
 * @param {readonly [number, number, number]} [rgb=[250, 250, 255]] - Foreground [R, G, B] color.
 */
function drawMonospaceText(canvas, x, y, text, rgb = [250, 250, 255]) {
  const [r, g, b] = rgb;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (ch === ' ') {
      continue;
    }
    const glyph = MONO_FONT_5X9[ch] || MONO_FONT_5X9[ch.toUpperCase()];
    if (!glyph) {
      continue;
    }
    const cx = x + i * MONO_CHAR_ADVANCE_PX;
    if (cx + MONO_GLYPH_W >= W) {
      break;
    }
    for (let row = 0; row < MONO_GLYPH_H; row++) {
      const bits = glyph[row];
      if (!bits) {
        continue;
      }
      const gy = y + row;
      for (let col = 0; col < MONO_GLYPH_W; col++) {
        if ((bits & (1 << (MONO_GLYPH_W - 1 - col))) !== 0) {
          const gx = cx + col;
          blendYuvPixel(canvas, gx + 1, gy + 1, 8, 8, 10, 0.85);
          blendYuvPixel(canvas, gx, gy, r, g, b, 1);
        }
      }
    }
  }
}

module.exports = {
  blendYuvPixel,
  fillYuvRect,
  extractBlurredRegion,
  drawRoundedBox,
  prepareBackgroundCanvas,
  drawMonospaceText,
};
