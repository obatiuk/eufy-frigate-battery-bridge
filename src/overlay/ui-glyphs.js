// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Pre-baked proportional anti-aliased UI glyph atlas (20px, 24px, 36px) and
 * 4x4 supersampled Eufy Security standard UI icon alpha masks for zero-FFmpeg,
 * zero-font-file status card and live overlay rendering.
 */
'use strict';

const zlib = require('node:zlib');
const {W, H} = require('../config');
const {blendYuvPixel} = require('./yuv-canvas');

const FONT_SIZE_SM = 20;
const FONT_SIZE_MD = 24;
const FONT_SIZE_LG = 36;

/**
 * Supported proportional UI font pixel sizes for the 'detailed' status card theme.
 *
 * @readonly
 * @enum {number}
 */
const UI_FONT_SIZES = Object.freeze({
  SM: FONT_SIZE_SM,
  MD: FONT_SIZE_MD,
  LG: FONT_SIZE_LG,
});

const SIZE_HDR_BYTES = 3;
const GLYPH_HDR_BYTES = 7;
const HDR_DX_OFFSET = 3;
const HDR_DY_OFFSET = 4;
const HDR_W_OFFSET = 5;
const HDR_H_OFFSET = 6;
const BYTE_SHIFT = 8;
const SIGNED_BYTE_MIN = 128;
const BYTE_RANGE = 256;
const NIBBLE_SHIFT = 4;
const NIBBLE_MASK = 0x0f;
const MAX_NIBBLE = 15;
const MAX_ALPHA_BYTE = 255;
const FALLBACK_CHAR_CODE = 63;
const SHADOW_RGB_R = 8;
const SHADOW_RGB_G = 8;
const SHADOW_RGB_B = 10;
const TEXT_SHADOW_ALPHA = 0.42;
const ICON_SHADOW_ALPHA = 0.42;

const SSAA_GRID = 4;
const SSAA_SAMPLES = 16;
const HALF = 0.5;

const SMALL_ICON_SIZE = 22;
const MODAL_ICON_SIZE = 60;
const SMALL_SCALE = 1.1;
const MODAL_SCALE = 3;

const PLAY_LEFT_X = -4.3;
const PLAY_RIGHT_X = 5.9;
const PLAY_HALF_Y = 5.8;
const PLAY_CORNER_R = 1.35;

const REW_HALF_Y = 5.0;
const REW_CORNER_R = 1.05;
const REW_L_APEX = -6.9;
const REW_L_BASE = -0.5;
const REW_R_APEX = -0.1;
const REW_R_BASE = 6.2;

const STATUS_RING_R = 7.0;
const STATUS_STROKE_R = 1.42;
const WAKING_DOT_R = 2.55;
const WAKING_ARC_START = -2.2;
const WAKING_ARC_END = 2.35;
const SLASH_EXTENT = 4.85;

const STANDBY_OFFSET_X = 3.4;
const STANDBY_HALF_H = 4.9;
const STANDBY_BAR_R = 1.9;

const BAT_SHELL_W = 38;
const BAT_SHELL_H = 18;
const BAT_OUTER_X = 0.5;
const BAT_OUTER_Y = 0.5;
const BAT_OUTER_W = 33.0;
const BAT_OUTER_H = 17.0;
const BAT_OUTER_R = 4.0;
const BAT_INNER_X = 2.8;
const BAT_INNER_Y = 2.8;
const BAT_INNER_W = 28.4;
const BAT_INNER_H = 12.4;
const BAT_INNER_R = 2.0;
const BAT_CAP_X = 32.5;
const BAT_CAP_MIN_X = 34.0;
const BAT_CAP_Y = 5.2;
const BAT_CAP_W = 4.8;
const BAT_CAP_H = 7.6;
const BAT_CAP_R = 1.8;

const BADGE_SIZE = 18;
const BADGE_CENTER = 9.0;
const BADGE_HALO_PAD = 1.15;

const BOLT_TOP_X = 10.6;
const BOLT_TOP_Y = 1.8;
const BOLT_MID_L_X = 4.6;
const BOLT_MID_L_Y = 9.6;
const BOLT_MID_IN_L_X = 9.3;
const BOLT_BOT_X = 7.4;
const BOLT_BOT_Y = 16.2;
const BOLT_MID_R_X = 13.4;
const BOLT_MID_R_Y = 8.4;
const BOLT_MID_IN_R_X = 8.7;
const BOLT_CORNER_R = 0.3;

const SOLAR_DISC_R = 2.35;
const SOLAR_RAY_COUNT = 8;
const SOLAR_RAY_R0 = 3.9;
const SOLAR_RAY_R1 = 5.6;
const SOLAR_RAY_STROKE = 0.68;

const PLUG_BODY_X = 5.0;
const PLUG_BODY_Y = 5.4;
const PLUG_BODY_W = 4.4;
const PLUG_BODY_H = 7.2;
const PLUG_BODY_R = 1.5;
const PLUG_PRONG_X0 = 9.2;
const PLUG_PRONG_X1 = 13.4;
const PLUG_PRONG_TOP_Y = 7.1;
const PLUG_PRONG_BOT_Y = 10.9;
const PLUG_PRONG_R = 0.72;
const PLUG_CORD_X0 = 2.5;
const PLUG_CORD_X1 = 5.2;
const PLUG_CORD_R = 0.78;

const WIFI_W = 30;
const WIFI_H = 22;
const WIFI_CX = 15.0;
const WIFI_BOT_Y = 18.0;
const WIFI_DOT_R = 2.35;
const WIFI_ARC_START = -2.36;
const WIFI_ARC_END = -0.78;
const WIFI_STROKE_R = 1.42;
const WIFI_ARC_R1 = 6.0;
const WIFI_ARC_R2 = 10.2;
const WIFI_ARC_R3 = 14.4;
const WIFI_RADII = Object.freeze([WIFI_ARC_R1, WIFI_ARC_R2, WIFI_ARC_R3]);

const THERM_W = 18;
const THERM_H = 22;
const THERM_CX = 6.5;
const THERM_STEM_TOP = 2.5;
const THERM_STEM_BOT = 15.2;
const THERM_STEM_R = 3.1;
const THERM_BULB_CY = 16.0;
const THERM_BULB_R = 4.9;
const THERM_BORE_TOP = 3.8;
const THERM_BORE_BOT = 13.8;
const THERM_BORE_R = 1.2;
const THERM_TICK_X0 = 11.4;
const THERM_TICK_X1 = 14.8;
const THERM_TICK_R = 0.75;
const THERM_TICK_Y1 = 4.0;
const THERM_TICK_Y2 = 7.2;
const THERM_TICK_Y3 = 10.4;
const THERM_TICKS_Y = Object.freeze([THERM_TICK_Y1, THERM_TICK_Y2, THERM_TICK_Y3]);

const CLOCK_SIZE = 22;
const CLOCK_CENTER = 11.0;
const CLOCK_RING_R = 9.0;
const CLOCK_RING_STROKE = 1.28;
const CLOCK_PIVOT_R = 1.35;
const CLOCK_HOUR_LEN = 4.5;
const CLOCK_MIN_LEN = 6.4;
const CLOCK_HOUR_R = 1.05;
const CLOCK_MIN_R = 0.9;
const HOURS_PER_DIAL = 12;
const MINS_PER_HOUR = 60;
const DEFAULT_CLOCK_HOURS = 4;
const DEFAULT_CLOCK_MINS = 20;
const MAX_CLOCK_CACHE = 64;

const MIN_DOT_SIZE = 18;
const MIN_DOT_CENTER = 9.0;
const MIN_DOT_R = 8.4;
const MIN_RING_INNER_R = 4.6;

const CLOCK_HM_REGEX = /^(\d{1,2}):(\d{2})/;
const UNICODE_DASH_REGEX = /[\u2010-\u2015\u2212]/g;
const UNICODE_SQUOTE_REGEX = /[\u2018\u2019]/g;
const UNICODE_DQUOTE_REGEX = /[\u201c\u201d]/g;

const ATLAS_DEFLATED_B64 =
  '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';

/**
 * @typedef {{ advance: number, dx: number, dy: number, w: number, h: number, alpha: Uint8Array }} GlyphEntry
 * @typedef {{ width: number, height: number, mask: Uint8Array }} AlphaSprite
 */

/**
 * Unpacks the compressed proportional FreeType glyph atlas once at module initialization.
 *
 * @returns {ReadonlyMap<number, ReadonlyMap<number, GlyphEntry>>}
 */
function unpackProportionalFontAtlas() {
  const buf = zlib.inflateRawSync(Buffer.from(ATLAS_DEFLATED_B64, 'base64'));
  let off = 0;
  const numSizes = buf[off++];
  /** @type {Map<number, ReadonlyMap<number, GlyphEntry>>} */
  const bySize = new Map();

  for (let s = 0; s < numSizes; s++) {
    const fontSize = buf[off];
    const numGlyphs = buf[off + 2];
    off += SIZE_HDR_BYTES;
    /** @type {Map<number, GlyphEntry>} */
    const glyphMap = new Map();

    for (let g = 0; g < numGlyphs; g++) {
      const code = buf[off] | (buf[off + 1] << BYTE_SHIFT);
      const advance = buf[off + 2];
      const rawDx = buf[off + HDR_DX_OFFSET];
      const rawDy = buf[off + HDR_DY_OFFSET];
      const dx = rawDx >= SIGNED_BYTE_MIN ? rawDx - BYTE_RANGE : rawDx;
      const dy = rawDy >= SIGNED_BYTE_MIN ? rawDy - BYTE_RANGE : rawDy;
      const w = buf[off + HDR_W_OFFSET];
      const h = buf[off + HDR_H_OFFSET];
      off += GLYPH_HDR_BYTES;

      const totalPx = w * h;
      const alpha = new Uint8Array(totalPx);
      const byteLen = (totalPx + 1) >> 1;
      for (let i = 0; i < totalPx; i++) {
        const packed = buf[off + (i >> 1)];
        const nib = (i & 1) === 0 ? (packed >> NIBBLE_SHIFT) & NIBBLE_MASK : packed & NIBBLE_MASK;
        alpha[i] = Math.round((nib * MAX_ALPHA_BYTE) / MAX_NIBBLE);
      }
      off += byteLen;
      glyphMap.set(code, Object.freeze({advance, dx, dy, w, h, alpha}));
    }
    bySize.set(fontSize, glyphMap);
  }
  return bySize;
}

const FONT_ATLAS = unpackProportionalFontAtlas();

/**
 * Normalizes common Unicode punctuation into printable ASCII equivalents while preserving '°'.
 *
 * @param {string} raw - Input UI label string.
 * @returns {string}
 */
function normalizeUiString(raw) {
  return String(raw || '')
      .replace(UNICODE_DASH_REGEX, '-')
      .replace(UNICODE_SQUOTE_REGEX, '\'')
      .replace(UNICODE_DQUOTE_REGEX, '"');
}

/**
 * Resolves the glyph map for a requested font size, defaulting to 20px.
 *
 * @param {number} fontSize - Requested pixel size (20, 24, or 36).
 * @returns {ReadonlyMap<number, GlyphEntry>}
 */
function getSizeGlyphMap(fontSize) {
  return /** @type {ReadonlyMap<number, GlyphEntry>} */ (
    FONT_ATLAS.get(fontSize) || FONT_ATLAS.get(FONT_SIZE_SM)
  );
}

/**
 * Measures the exact horizontal pixel width of a string in the proportional UI glyph atlas.
 *
 * @param {string} text - Text string to measure.
 * @param {number} [fontSize=UI_FONT_SIZES.SM] - Font pixel size (20, 24, or 36).
 * @returns {number}
 */
function measureUiText(text, fontSize = UI_FONT_SIZES.SM) {
  const clean = normalizeUiString(text);
  const glyphMap = getSizeGlyphMap(fontSize);
  const fallback = glyphMap.get(FALLBACK_CHAR_CODE);
  let width = 0;
  for (let i = 0; i < clean.length; i++) {
    const g = glyphMap.get(clean.charCodeAt(i)) || fallback;
    if (g) {
      width += g.advance;
    }
  }
  return width;
}

/**
 * Blits a single anti-aliased glyph entry onto a YUV420p frame buffer with a subtle 1px luma shadow.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ penX: number, topY: number, glyph: GlyphEntry }} layout - Pen origin and glyph metrics.
 * @param {readonly number[]} rgb - Foreground RGB color [r, g, b].
 */
function blitProportionalGlyph(canvas, layout, rgb) {
  const {penX, topY, glyph} = layout;
  if (glyph.w === 0 || glyph.h === 0) {
    return;
  }
  const [r, g, b] = rgb;
  const x0 = Math.round(penX + glyph.dx);
  const y0 = Math.round(topY + glyph.dy);

  for (let row = 0; row < glyph.h; row++) {
    const gy = y0 + row;
    if (gy < 0 || gy >= H) {
      continue;
    }
    const rowOff = row * glyph.w;
    for (let col = 0; col < glyph.w; col++) {
      const aByte = glyph.alpha[rowOff + col];
      if (aByte === 0) {
        continue;
      }
      const gx = x0 + col;
      if (gx < 0 || gx >= W) {
        continue;
      }
      const cov = aByte / MAX_ALPHA_BYTE;
      blendYuvPixel(canvas, gx + 1, gy + 1, SHADOW_RGB_R, SHADOW_RGB_G, SHADOW_RGB_B, TEXT_SHADOW_ALPHA * cov);
      blendYuvPixel(canvas, gx, gy, r, g, b, cov);
    }
  }
}

/**
 * Renders anti-aliased proportional UI text directly onto a YUV420p frame buffer.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number, text: string, fontSize?: number, rgb: readonly number[], centered?: boolean }} opts - Text layout options.
 */
function drawUiText(canvas, opts) {
  const fontSize = opts.fontSize || UI_FONT_SIZES.SM;
  const clean = normalizeUiString(opts.text);
  if (!clean) {
    return;
  }
  const glyphMap = getSizeGlyphMap(fontSize);
  const fallback = glyphMap.get(FALLBACK_CHAR_CODE);
  let penX = opts.centered ? Math.round(opts.x - measureUiText(clean, fontSize) / 2) : Math.round(opts.x);
  const topY = Math.round(opts.y);

  for (let i = 0; i < clean.length; i++) {
    const glyph = glyphMap.get(clean.charCodeAt(i)) || fallback;
    if (!glyph) {
      continue;
    }
    blitProportionalGlyph(canvas, {penX, topY, glyph}, opts.rgb);
    penX += glyph.advance;
  }
}

/**
 * Blits a pre-baked 8-bit alpha coverage sprite onto a YUV420p frame buffer,
 * optionally casting a subtle 1px directional drop-shadow behind the glyph.
 *
 * @param {Uint8Array} canvas - Target YUV420p frame buffer.
 * @param {{ x: number, y: number, sprite: AlphaSprite }} pos - Top-left destination coordinates and sprite.
 * @param {{ rgb: readonly number[], opacity?: number, shadow?: boolean }} style - RGB tint, opacity, and drop-shadow flag.
 */
function blitAlphaSprite(canvas, pos, style) {
  const {sprite} = pos;
  const baseX = Math.round(pos.x);
  const baseY = Math.round(pos.y);
  const [r, g, b] = style.rgb;
  const opacity = style.opacity === undefined ? 1 : style.opacity;
  const {width, height, mask} = sprite;

  if (style.shadow) {
    const shadowScale = (ICON_SHADOW_ALPHA * opacity) / MAX_ALPHA_BYTE;
    for (let row = 0; row < height; row++) {
      const sy = baseY + row + 1;
      if (sy < 0 || sy >= H) {
        continue;
      }
      const rowOff = row * width;
      for (let col = 0; col < width; col++) {
        const aByte = mask[rowOff + col];
        if (aByte !== 0) {
          blendYuvPixel(canvas, baseX + col + 1, sy, SHADOW_RGB_R, SHADOW_RGB_G, SHADOW_RGB_B, aByte * shadowScale);
        }
      }
    }
  }

  const fgScale = opacity / MAX_ALPHA_BYTE;
  for (let row = 0; row < height; row++) {
    const gy = baseY + row;
    if (gy < 0 || gy >= H) {
      continue;
    }
    const rowOff = row * width;
    for (let col = 0; col < width; col++) {
      const aByte = mask[rowOff + col];
      if (aByte !== 0) {
        blendYuvPixel(canvas, baseX + col, gy, r, g, b, aByte * fgScale);
      }
    }
  }
}

/**
 * Rasterizes a 2D boolean predicate into an 8-bit alpha sprite using 4x4 subpixel supersampling.
 *
 * @param {{ width: number, height: number }} dims - Sprite pixel dimensions.
 * @param {(sx: number, sy: number) => boolean} sampleFn - Inside-shape predicate in sprite coordinates.
 * @returns {Readonly<AlphaSprite>}
 */
function rasterizeSprite(dims, sampleFn) {
  const {width, height} = dims;
  const mask = new Uint8Array(width * height);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let hits = 0;
      for (let sy = 0; sy < SSAA_GRID; sy++) {
        const y = py + (sy + HALF) / SSAA_GRID;
        for (let sx = 0; sx < SSAA_GRID; sx++) {
          const x = px + (sx + HALF) / SSAA_GRID;
          if (sampleFn(x, y)) {
            hits++;
          }
        }
      }
      if (hits > 0) {
        mask[py * width + px] = Math.round((hits * MAX_ALPHA_BYTE) / SSAA_SAMPLES);
      }
    }
  }
  return Object.freeze({width, height, mask});
}

/**
 * Euclidean distance from point { x, y } to line segment { x1, y1, x2, y2 }.
 *
 * @param {{ x: number, y: number }} pt - Sample point.
 * @param {{ x1: number, y1: number, x2: number, y2: number }} seg - Segment endpoints.
 * @returns {number}
 */
function distToSegment(pt, seg) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((pt.x - seg.x1) * dx + (pt.y - seg.y1) * dy) / lenSq));
  return Math.hypot(pt.x - (seg.x1 + t * dx), pt.y - (seg.y1 + t * dy));
}

/**
 * Signed distance from point { x, y } to rounded rectangle { x, y, w, h, r } (<= 0 inside).
 *
 * @param {{ x: number, y: number }} pt - Sample point.
 * @param {{ x: number, y: number, w: number, h: number, r: number }} rect - Rounded rectangle bounds.
 * @returns {number}
 */
function signedDistRoundedRect(pt, rect) {
  const hx = rect.w / 2;
  const hy = rect.h / 2;
  const qx = Math.abs(pt.x - (rect.x + hx)) - (hx - rect.r);
  const qy = Math.abs(pt.y - (rect.y + hy)) - (hy - rect.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rect.r;
}

/**
 * Signed distance from point { x, y } to 2D triangle { ax, ay, bx, by, cx, cy } (<= 0 inside).
 *
 * @param {{ x: number, y: number }} pt - Sample point.
 * @param {{ ax: number, ay: number, bx: number, by: number, cx: number, cy: number }} tri - Triangle vertices.
 * @returns {number}
 */
function signedDistTriangle(pt, tri) {
  const d0 = distToSegment(pt, {x1: tri.ax, y1: tri.ay, x2: tri.bx, y2: tri.by});
  const d1 = distToSegment(pt, {x1: tri.bx, y1: tri.by, x2: tri.cx, y2: tri.cy});
  const d2 = distToSegment(pt, {x1: tri.cx, y1: tri.cy, x2: tri.ax, y2: tri.ay});
  const minEdge = Math.min(d0, d1, d2);

  const c0 = (tri.bx - tri.ax) * (pt.y - tri.ay) - (tri.by - tri.ay) * (pt.x - tri.ax);
  const c1 = (tri.cx - tri.bx) * (pt.y - tri.by) - (tri.cy - tri.by) * (pt.x - tri.bx);
  const c2 = (tri.ax - tri.cx) * (pt.y - tri.cy) - (tri.ay - tri.cy) * (pt.x - tri.cx);
  const inside = (c0 >= 0 && c1 >= 0 && c2 >= 0) || (c0 <= 0 && c1 <= 0 && c2 <= 0);
  return inside ? -minEdge : minEdge;
}

/**
 * Euclidean distance from point { x, y } to circular arc { cx, cy, r, a0, a1 } with rounded end-caps.
 *
 * @param {{ x: number, y: number }} pt - Sample point.
 * @param {{ cx: number, cy: number, r: number, a0: number, a1: number }} arc - Arc geometry in radians.
 * @returns {number}
 */
function distToArc(pt, arc) {
  const dx = pt.x - arc.cx;
  const dy = pt.y - arc.cy;
  const ang = Math.atan2(dy, dx);
  if (ang >= arc.a0 && ang <= arc.a1) {
    return Math.abs(Math.hypot(dx, dy) - arc.r);
  }
  const dStart = Math.hypot(pt.x - (arc.cx + Math.cos(arc.a0) * arc.r), pt.y - (arc.cy + Math.sin(arc.a0) * arc.r));
  const dEnd = Math.hypot(pt.x - (arc.cx + Math.cos(arc.a1) * arc.r), pt.y - (arc.cy + Math.sin(arc.a1) * arc.r));
  return Math.min(dStart, dEnd);
}

/**
 * Builds the 5 Eufy status indicator sprites ('live', 'backfill', 'waking', 'disconnected', 'standby')
 * at a given pixel size and scale multiplier.
 *
 * @param {number} size - Square sprite dimension in pixels.
 * @param {number} scale - Geometry scale factor (1.1 for 22x22, 3 for 60x60 modal).
 * @returns {Readonly<{ live: AlphaSprite, backfill: AlphaSprite, waking: AlphaSprite, disconnected: AlphaSprite, standby: AlphaSprite }>}
 */
function buildStatusSpriteSet(size, scale) {
  const c = size / 2;
  const dims = {width: size, height: size};

  const live = rasterizeSprite(dims, (x, y) => {
    const tri = {
      ax: c + PLAY_LEFT_X * scale,
      ay: c - PLAY_HALF_Y * scale,
      bx: c + PLAY_RIGHT_X * scale,
      by: c,
      cx: c + PLAY_LEFT_X * scale,
      cy: c + PLAY_HALF_Y * scale,
    };
    return signedDistTriangle({x, y}, tri) <= PLAY_CORNER_R * scale;
  });

  const backfill = rasterizeSprite(dims, (x, y) => {
    const leftTri = {
      ax: c + REW_L_APEX * scale,
      ay: c,
      bx: c + REW_L_BASE * scale,
      by: c - REW_HALF_Y * scale,
      cx: c + REW_L_BASE * scale,
      cy: c + REW_HALF_Y * scale,
    };
    const rightTri = {
      ax: c + REW_R_APEX * scale,
      ay: c,
      bx: c + REW_R_BASE * scale,
      by: c - REW_HALF_Y * scale,
      cx: c + REW_R_BASE * scale,
      cy: c + REW_HALF_Y * scale,
    };
    const r = REW_CORNER_R * scale;
    return signedDistTriangle({x, y}, leftTri) <= r || signedDistTriangle({x, y}, rightTri) <= r;
  });

  const waking = rasterizeSprite(dims, (x, y) => {
    const dDot = Math.hypot(x - c, y - c);
    if (dDot <= WAKING_DOT_R * scale) {
      return true;
    }
    const dArc = distToArc(
        {x, y},
        {cx: c, cy: c, r: STATUS_RING_R * scale, a0: WAKING_ARC_START, a1: WAKING_ARC_END}
    );
    return dArc <= STATUS_STROKE_R * scale;
  });

  const disconnected = rasterizeSprite(dims, (x, y) => {
    const dRing = Math.abs(Math.hypot(x - c, y - c) - STATUS_RING_R * scale);
    if (dRing <= STATUS_STROKE_R * scale) {
      return true;
    }
    const ext = SLASH_EXTENT * scale;
    const dSlash = distToSegment({x, y}, {x1: c - ext, y1: c - ext, x2: c + ext, y2: c + ext});
    return dSlash <= STATUS_STROKE_R * scale;
  });

  const standby = rasterizeSprite(dims, (x, y) => {
    const offX = STANDBY_OFFSET_X * scale;
    const halfH = STANDBY_HALF_H * scale;
    const barR = STANDBY_BAR_R * scale;
    const dLeft = distToSegment({x, y}, {x1: c - offX, y1: c - halfH, x2: c - offX, y2: c + halfH});
    const dRight = distToSegment({x, y}, {x1: c + offX, y1: c - halfH, x2: c + offX, y2: c + halfH});
    return dLeft <= barR || dRight <= barR;
  });

  return Object.freeze({live, backfill, waking, disconnected, standby});
}

/**
 * Builds the Eufy rounded battery shell sprite (38x18).
 *
 * @returns {Readonly<AlphaSprite>}
 */
function buildBatteryShellSprite() {
  return rasterizeSprite({width: BAT_SHELL_W, height: BAT_SHELL_H}, (x, y) => {
    const inOuter =
      signedDistRoundedRect(
          {x, y},
          {x: BAT_OUTER_X, y: BAT_OUTER_Y, w: BAT_OUTER_W, h: BAT_OUTER_H, r: BAT_OUTER_R}
      ) <= 0;
    const inInner =
      signedDistRoundedRect(
          {x, y},
          {x: BAT_INNER_X, y: BAT_INNER_Y, w: BAT_INNER_W, h: BAT_INNER_H, r: BAT_INNER_R}
      ) <= 0;
    if (inOuter && !inInner) {
      return true;
    }
    return (
      x >= BAT_CAP_MIN_X &&
      signedDistRoundedRect({x, y}, {x: BAT_CAP_X, y: BAT_CAP_Y, w: BAT_CAP_W, h: BAT_CAP_H, r: BAT_CAP_R}) <= 0
    );
  });
}

/**
 * Signed distance to the Eufy USB-C charging lightning bolt inside an 18x18 badge.
 *
 * @param {number} x - Badge X coordinate.
 * @param {number} y - Badge Y coordinate.
 * @returns {number}
 */
function signedDistBolt(x, y) {
  const upper = signedDistTriangle(
      {x, y},
      {
        ax: BOLT_TOP_X,
        ay: BOLT_TOP_Y,
        bx: BOLT_MID_L_X,
        by: BOLT_MID_L_Y,
        cx: BOLT_MID_IN_L_X,
        cy: BOLT_MID_L_Y,
      }
  );
  const lower = signedDistTriangle(
      {x, y},
      {
        ax: BOLT_BOT_X,
        ay: BOLT_BOT_Y,
        bx: BOLT_MID_R_X,
        by: BOLT_MID_R_Y,
        cx: BOLT_MID_IN_R_X,
        cy: BOLT_MID_R_Y,
      }
  );
  return Math.min(upper, lower) - BOLT_CORNER_R;
}

/**
 * Signed distance to the Eufy Solar Panel sun + 8 radial rays glyph inside an 18x18 badge.
 *
 * @param {number} x - Badge X coordinate.
 * @param {number} y - Badge Y coordinate.
 * @returns {number}
 */
function signedDistSolarSun(x, y) {
  let minDist = Math.hypot(x - BADGE_CENTER, y - BADGE_CENTER) - SOLAR_DISC_R;
  for (let i = 0; i < SOLAR_RAY_COUNT; i++) {
    const ang = (i * Math.PI * 2) / SOLAR_RAY_COUNT;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const dRay =
      distToSegment(
          {x, y},
          {
            x1: BADGE_CENTER + cosA * SOLAR_RAY_R0,
            y1: BADGE_CENTER + sinA * SOLAR_RAY_R0,
            x2: BADGE_CENTER + cosA * SOLAR_RAY_R1,
            y2: BADGE_CENTER + sinA * SOLAR_RAY_R1,
          }
      ) - SOLAR_RAY_STROKE;
    if (dRay < minDist) {
      minDist = dRay;
    }
  }
  return minDist;
}

/**
 * Signed distance to the Eufy continuous wired AC power plug glyph inside an 18x18 badge.
 *
 * @param {number} x - Badge X coordinate.
 * @param {number} y - Badge Y coordinate.
 * @returns {number}
 */
function signedDistPlug(x, y) {
  const dBody = signedDistRoundedRect(
      {x, y},
      {x: PLUG_BODY_X, y: PLUG_BODY_Y, w: PLUG_BODY_W, h: PLUG_BODY_H, r: PLUG_BODY_R}
  );
  const dTopProng =
    distToSegment({x, y}, {x1: PLUG_PRONG_X0, y1: PLUG_PRONG_TOP_Y, x2: PLUG_PRONG_X1, y2: PLUG_PRONG_TOP_Y}) -
    PLUG_PRONG_R;
  const dBotProng =
    distToSegment({x, y}, {x1: PLUG_PRONG_X0, y1: PLUG_PRONG_BOT_Y, x2: PLUG_PRONG_X1, y2: PLUG_PRONG_BOT_Y}) -
    PLUG_PRONG_R;
  const dCord =
    distToSegment({x, y}, {x1: PLUG_CORD_X0, y1: BADGE_CENTER, x2: PLUG_CORD_X1, y2: BADGE_CENTER}) -
    PLUG_CORD_R;
  return Math.min(dBody, dTopProng, dBotProng, dCord);
}

/**
 * Builds a foreground + dark cutout halo sprite pair from a signed distance function.
 *
 * @param {(x: number, y: number) => number} sdfFn - Signed distance function (<= 0 inside glyph).
 * @returns {Readonly<{ width: number, height: number, fg: Uint8Array, halo: Uint8Array, fgSprite: AlphaSprite, haloSprite: AlphaSprite }>}
 */
function buildPowerBadgePair(sdfFn) {
  const dims = {width: BADGE_SIZE, height: BADGE_SIZE};
  const fgSprite = rasterizeSprite(dims, (x, y) => sdfFn(x, y) <= 0);
  const haloSprite = rasterizeSprite(dims, (x, y) => sdfFn(x, y) <= BADGE_HALO_PAD);
  return Object.freeze({
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    fg: fgSprite.mask,
    halo: haloSprite.mask,
    fgSprite,
    haloSprite,
  });
}

/**
 * Builds the 4 Eufy Wi-Fi signal fan sprites (base dot + 3 rounded-cap concentric wave arcs).
 *
 * @returns {ReadonlyArray<AlphaSprite>}
 */
function buildWifiTierSprites() {
  const dims = {width: WIFI_W, height: WIFI_H};
  const dot = rasterizeSprite(dims, (x, y) => Math.hypot(x - WIFI_CX, y - WIFI_BOT_Y) <= WIFI_DOT_R);
  const arcs = WIFI_RADII.map((rad) =>
    rasterizeSprite(dims, (x, y) => {
      const d = distToArc({x, y}, {cx: WIFI_CX, cy: WIFI_BOT_Y, r: rad, a0: WIFI_ARC_START, a1: WIFI_ARC_END});
      return d <= WIFI_STROKE_R;
    })
  );
  return Object.freeze([dot, ...arcs]);
}

/**
 * Builds the Eufy thermometer outer body and inner capillary bore sprites (18x22).
 *
 * @returns {Readonly<{ bodySprite: AlphaSprite, boreSprite: AlphaSprite }>}
 */
function buildThermometerSprites() {
  const dims = {width: THERM_W, height: THERM_H};
  const bodySprite = rasterizeSprite(dims, (x, y) => {
    const dStem = distToSegment({x, y}, {x1: THERM_CX, y1: THERM_STEM_TOP, x2: THERM_CX, y2: THERM_STEM_BOT});
    if (dStem <= THERM_STEM_R || Math.hypot(x - THERM_CX, y - THERM_BULB_CY) <= THERM_BULB_R) {
      return true;
    }
    return THERM_TICKS_Y.some(
        (ty) => distToSegment({x, y}, {x1: THERM_TICK_X0, y1: ty, x2: THERM_TICK_X1, y2: ty}) <= THERM_TICK_R
    );
  });
  const boreSprite = rasterizeSprite(dims, (x, y) => {
    const dBore = distToSegment({x, y}, {x1: THERM_CX, y1: THERM_BORE_TOP, x2: THERM_CX, y2: THERM_BORE_BOT});
    return dBore <= THERM_BORE_R;
  });
  return Object.freeze({bodySprite, boreSprite});
}

/**
 * Builds the Eufy hollow ring clock dial sprite (22x22).
 *
 * @returns {Readonly<AlphaSprite>}
 */
function buildClockDialSprite() {
  return rasterizeSprite({width: CLOCK_SIZE, height: CLOCK_SIZE}, (x, y) => {
    const dCenter = Math.hypot(x - CLOCK_CENTER, y - CLOCK_CENTER);
    return Math.abs(dCenter - CLOCK_RING_R) <= CLOCK_RING_STROKE || dCenter <= CLOCK_PIVOT_R;
  });
}

/**
 * Builds the pre-baked halo-free circle sprites (18x18 solid dot and hollow Backfill ring) for the 'minimal' theme.
 *
 * @returns {Readonly<{ dotFg: AlphaSprite, dotRing: AlphaSprite }>}
 */
function buildMinimalSprites() {
  const dotDims = {width: MIN_DOT_SIZE, height: MIN_DOT_SIZE};
  const dotFg = rasterizeSprite(dotDims, (x, y) => Math.hypot(x - MIN_DOT_CENTER, y - MIN_DOT_CENTER) <= MIN_DOT_R);
  const dotRing = rasterizeSprite(dotDims, (x, y) => {
    const d = Math.hypot(x - MIN_DOT_CENTER, y - MIN_DOT_CENTER);
    return d >= MIN_RING_INNER_R && d <= MIN_DOT_R;
  });
  return Object.freeze({dotFg, dotRing});
}

const EUFY_ICON_SPRITES = Object.freeze({
  statusSmall: buildStatusSpriteSet(SMALL_ICON_SIZE, SMALL_SCALE),
  statusModal: buildStatusSpriteSet(MODAL_ICON_SIZE, MODAL_SCALE),
  minimal: buildMinimalSprites(),
  batteryShell: buildBatteryShellSprite(),
  powerBadges: Object.freeze({
    bolt: buildPowerBadgePair(signedDistBolt),
    solar: buildPowerBadgePair(signedDistSolarSun),
    plugged: buildPowerBadgePair(signedDistPlug),
  }),
  wifiTiers: buildWifiTierSprites(),
  thermometer: buildThermometerSprites(),
  clockDial: buildClockDialSprite(),
});

/** @type {Map<string, Uint8Array>} */
const clockHandsCache = new Map();

/**
 * Returns a cached 22x22 8-bit alpha mask of rounded analog clock hands for an 'HH:MM' timestamp.
 *
 * @param {string} seenVal - Formatted local 'HH:MM' timestamp.
 * @returns {Uint8Array}
 */
function getClockHandsMask(seenVal) {
  const match = CLOCK_HM_REGEX.exec(String(seenVal || ''));
  const hours = match ? Number(match[1]) % HOURS_PER_DIAL : DEFAULT_CLOCK_HOURS;
  const mins = match ? Number(match[2]) % MINS_PER_HOUR : DEFAULT_CLOCK_MINS;
  const key = hours + ':' + mins;

  const cached = clockHandsCache.get(key);
  if (cached) {
    return cached;
  }

  const hourAngle = ((hours + mins / MINS_PER_HOUR) / HOURS_PER_DIAL) * Math.PI * 2 - Math.PI / 2;
  const minAngle = (mins / MINS_PER_HOUR) * Math.PI * 2 - Math.PI / 2;
  const hx = CLOCK_CENTER + Math.cos(hourAngle) * CLOCK_HOUR_LEN;
  const hy = CLOCK_CENTER + Math.sin(hourAngle) * CLOCK_HOUR_LEN;
  const mx = CLOCK_CENTER + Math.cos(minAngle) * CLOCK_MIN_LEN;
  const my = CLOCK_CENTER + Math.sin(minAngle) * CLOCK_MIN_LEN;

  const sprite = rasterizeSprite({width: CLOCK_SIZE, height: CLOCK_SIZE}, (x, y) => {
    const dHour = distToSegment({x, y}, {x1: CLOCK_CENTER, y1: CLOCK_CENTER, x2: hx, y2: hy});
    const dMin = distToSegment({x, y}, {x1: CLOCK_CENTER, y1: CLOCK_CENTER, x2: mx, y2: my});
    return dHour <= CLOCK_HOUR_R || dMin <= CLOCK_MIN_R;
  });

  if (clockHandsCache.size >= MAX_CLOCK_CACHE) {
    const oldestKey = clockHandsCache.keys().next().value;
    if (oldestKey !== undefined) {
      clockHandsCache.delete(oldestKey);
    }
  }
  clockHandsCache.set(key, sprite.mask);
  return sprite.mask;
}

module.exports = {
  UI_FONT_SIZES,
  EUFY_ICON_SPRITES,
  measureUiText,
  drawUiText,
  blitAlphaSprite,
  getClockHandsMask,
};
