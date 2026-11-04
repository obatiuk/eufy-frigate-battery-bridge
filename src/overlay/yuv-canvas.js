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

const {W, H, FRAME} = require('../config');

const FROSTED_BLUR_PASSES = 3;
const FROSTED_LUMA_BLUR_RADIUS = 12;
const FROSTED_CHROMA_BLUR_RADIUS = 6;
const ROUNDED_BOX_BLUR_PAD_PX = 28;
const DIM_LUMA_FACTOR = 0.55;
const DIM_CHROMA_FACTOR = 0.65;
const BLACK_BG_LUMA = 0x10;
const SLATE_BG_LUMA = 0x22;
const NEUTRAL_CHROMA = 0x80;

// Reusable scratch buffer for separable box-blur passes to avoid per-render heap allocations.
let blurScratch = Buffer.allocUnsafe(0);

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
 * Draws an anti-aliased filled circle onto a YUV420p frame buffer.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} cx - Center X coordinate.
 * @param {number} cy - Center Y coordinate.
 * @param {number} radius - Circle radius in pixels.
 * @param {number[]} rgb - RGB color array [r, g, b].
 * @param {number} alpha - Opacity (0..1).
 */
function drawYuvCircle(canvas, cx, cy, radius, rgb, alpha) {
  const [r, g, b] = rgb;
  const pad = Math.ceil(radius + 1);
  const y0 = Math.max(0, Math.floor(cy - pad));
  const y1 = Math.min(H - 1, Math.ceil(cy + pad));
  const x0 = Math.max(0, Math.floor(cx - pad));
  const x1 = Math.min(W - 1, Math.ceil(cx + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cov = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x - cx, y - cy)));
      if (cov > 0) {
        blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
      }
    }
  }
}


/**
 * Draws an anti-aliased line segment between (x1, y1) and (x2, y2) onto a YUV420p buffer.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {number} x1 - Start X coordinate.
 * @param {number} y1 - Start Y coordinate.
 * @param {number} x2 - End X coordinate.
 * @param {number} y2 - End Y coordinate.
 * @param {number} strokeHalf - Half of the line thickness in pixels.
 * @param {number[]} rgb - RGB color array [r, g, b].
 * @param {number} alpha - Opacity (0..1).
 */
function drawYuvLine(canvas, x1, y1, x2, y2, strokeHalf, rgb, alpha) {
  const [r, g, b] = rgb;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - strokeHalf - 1));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + strokeHalf + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - strokeHalf - 1));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + strokeHalf + 1));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq));
      const dist = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      const cov = Math.min(1, Math.max(0, strokeHalf + 0.5 - dist));
      if (cov > 0) {
        blendYuvPixel(canvas, x, y, r, g, b, alpha * cov);
      }
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
  const regionBuf = Buffer.allocUnsafe(lumaSize + chromaSize * 2);

  for (let y = 0; y < rh; y++) {
    const srcOff = (ry0 + y) * W + rx0;
    canvas.copy(regionBuf, y * rw, srcOff, srcOff + rw);
  }

  const fullCw = W >> 1;
  const fullChromaSize = fullCw * (H >> 1);
  for (let cy = 0; cy < ch; cy++) {
    const srcU = W * H + ((ry0 >> 1) + cy) * fullCw + (rx0 >> 1);
    const srcV = srcU + fullChromaSize;
    canvas.copy(regionBuf, lumaSize + cy * cw, srcU, srcU + cw);
    canvas.copy(regionBuf, lumaSize + chromaSize + cy * cw, srcV, srcV + cw);
  }

  for (let pass = 0; pass < FROSTED_BLUR_PASSES; pass++) {
    boxBlurPlane(regionBuf, 0, rw, rh, FROSTED_LUMA_BLUR_RADIUS);
    boxBlurPlane(regionBuf, lumaSize, cw, ch, FROSTED_CHROMA_BLUR_RADIUS);
    boxBlurPlane(regionBuf, lumaSize + chromaSize, cw, ch, FROSTED_CHROMA_BLUR_RADIUS);
  }

  return {buf: regionBuf, lumaSize, chromaSize, cw};
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
 * @param {number} [borderOpacity=0.16] - Subtle rim highlight opacity (0..1).
 * @param {boolean} [blurBackdrop=true] - Whether to run a frosted-glass blur on the underlying pixels.
 */
function drawRoundedBox(canvas, boxX, boxY, boxW, boxH, radius, opacity, borderOpacity = 0.16, blurBackdrop = true) {
  const pad = ROUNDED_BOX_BLUR_PAD_PX;
  const rx0 = Math.max(0, (boxX - pad) & ~1);
  const ry0 = Math.max(0, (boxY - pad) & ~1);
  const rx1 = Math.min(W, (boxX + boxW + pad + 1) & ~1);
  const ry1 = Math.min(H, (boxY + boxH + pad + 1) & ~1);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;

  const blurred = blurBackdrop ? extractBlurredRegion(canvas, rx0, ry0, rw, rh) : null;
  const rSafe = Math.min(radius, Math.floor(boxW / 2), Math.floor(boxH / 2));

  for (let py = 0; py < boxH; py++) {
    for (let px = 0; px < boxW; px++) {
      const gx = boxX + px;
      const gy = boxY + py;
      if (gx < rx0 || gx >= rx1 || gy < ry0 || gy >= ry1) {
        continue;
      }

      const dx = Math.max(rSafe - px, 0, px - (boxW - 1 - rSafe));
      const dy = Math.max(rSafe - py, 0, py - (boxH - 1 - rSafe));
      const dist = Math.hypot(dx, dy);
      const cov = Math.min(1, Math.max(0, rSafe + 0.5 - dist));
      if (cov <= 0) {
        continue;
      }

      if (blurred) {
        blendBlurredBackdropPixel(canvas, gx, gy, rx0, ry0, rw, blurred, cov);
      }

      blendYuvPixel(canvas, gx, gy, 12, 12, 14, opacity * cov);
      if (borderOpacity > 0) {
        const borderCov = Math.min(1, Math.max(0, 1.1 - Math.abs(dist - (rSafe - 0.6))));
        if (borderCov > 0) {
          blendYuvPixel(canvas, gx, gy, 255, 255, 255, borderOpacity * borderCov * cov);
        }
      }
    }
  }
}

/**
 * Prepares the base YUV420p background canvas once per renderCameraCards() cycle so it can be
 * shared across the asleep, waking, and busy cards without repeating full-frame pixel loops.
 *
 * @param {{ theme: string, position: string, background: string, dimBackground?: boolean }} cardCfg - Resolved card config.
 * @param {Uint8Array|null} bgFrame - Last captured YUV420p video frame for this camera.
 * @returns {{ baseCanvas: Uint8Array, hasBackground: boolean }}
 */
function prepareBackgroundCanvas(cardCfg, bgFrame) {
  const baseCanvas = Buffer.allocUnsafe(FRAME);
  const hasBackground =
      cardCfg.background === 'snapshot' && Buffer.isBuffer(bgFrame) && bgFrame.length === FRAME;

  if (hasBackground) {
    bgFrame.copy(baseCanvas);
    if (cardCfg.dimBackground) {
      const lumaEnd = W * H;
      for (let i = 0; i < lumaEnd; i++) {
        baseCanvas[i] = Math.max(BLACK_BG_LUMA, ((baseCanvas[i] - BLACK_BG_LUMA) * DIM_LUMA_FACTOR + 16.5) | 0);
      }
      for (let i = lumaEnd; i < FRAME; i++) {
        baseCanvas[i] = ((baseCanvas[i] - NEUTRAL_CHROMA) * DIM_CHROMA_FACTOR + 128.5) | 0;
      }
    }
  } else {
    baseCanvas.fill(NEUTRAL_CHROMA, W * H);
    baseCanvas.fill(cardCfg.background === 'black' ? BLACK_BG_LUMA : SLATE_BG_LUMA, 0, W * H);
  }

  return {baseCanvas, hasBackground};
}

/**
 * Copies a rounded-rectangle sub-region (boxX, boxY, boxW, boxH) with corner radius from
 * srcYuv onto dstYuv, leaving pixels outside the rounded corners untouched and smoothly
 * alpha-blending the anti-aliased corner arc.
 *
 * @param {Uint8Array} srcYuv - Source YUV420p frame buffer.
 * @param {Uint8Array} dstYuv - Destination YUV420p frame buffer.
 * @param {number} boxX - Left X coordinate.
 * @param {number} boxY - Top Y coordinate.
 * @param {number} boxW - Width in pixels.
 * @param {number} boxH - Height in pixels.
 * @param {number} radius - Corner radius in pixels.
 */
function copyRoundedYuvRegion(srcYuv, dstYuv, boxX, boxY, boxW, boxH, radius) {
  const rSafe = Math.min(radius, Math.floor(boxW / 2), Math.floor(boxH / 2));
  const cw = W >> 1;
  const cSize = cw * (H >> 1);

  for (let py = 0; py < boxH; py++) {
    const gy = boxY + py;
    if (gy < 0 || gy >= H) {
      continue;
    }
    const dy = Math.max(rSafe - py, 0, py - (boxH - 1 - rSafe));
    const rowOff = gy * W;

    for (let px = 0; px < boxW; px++) {
      const gx = boxX + px;
      if (gx < 0 || gx >= W) {
        continue;
      }
      const dx = Math.max(rSafe - px, 0, px - (boxW - 1 - rSafe));
      const cov =
          dx === 0 && dy === 0 ? 1 : Math.min(1, Math.max(0, rSafe + 0.5 - Math.hypot(dx, dy)));
      if (cov <= 0) {
        continue;
      }

      const yIdx = rowOff + gx;
      if (cov >= 1) {
        dstYuv[yIdx] = srcYuv[yIdx];
      } else {
        dstYuv[yIdx] = (dstYuv[yIdx] * (1 - cov) + srcYuv[yIdx] * cov + 0.5) | 0;
      }

      if ((gx & 1) === 0 && (gy & 1) === 0) {
        const uIdx = W * H + (gy >> 1) * cw + (gx >> 1);
        const vIdx = uIdx + cSize;
        if (cov >= 1) {
          dstYuv[uIdx] = srcYuv[uIdx];
          dstYuv[vIdx] = srcYuv[vIdx];
        } else {
          dstYuv[uIdx] = (dstYuv[uIdx] * (1 - cov) + srcYuv[uIdx] * cov + 0.5) | 0;
          dstYuv[vIdx] = (dstYuv[vIdx] * (1 - cov) + srcYuv[vIdx] * cov + 0.5) | 0;
        }
      }
    }
  }
}

module.exports = {
  blendYuvPixel,
  fillYuvRect,
  drawYuvCircle,
  drawYuvLine,
  drawRoundedBox,
  prepareBackgroundCanvas,
  copyRoundedYuvRegion,
};
