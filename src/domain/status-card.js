// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * StatusCard domain model encapsulating card theme/position/background settings,
 * pre-rendered YUV420p card buffers, corner bounding-box geometry, and Frigate
 * motion/object mask polygon calculation.
 */
'use strict';

const {
  W,
  H,
  FRAME,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
  resolveCardConfig,
} = require('../config');
const {TEL_TEXT_CHAR_WIDTH, evaluateTelemetryState, buildTelemetrySegments} = require('./telemetry');

const CARD_CORNER_MARGIN_PX = 24;
const MINIMAL_CARD_WIDTH = 92;
const MINIMAL_CARD_HEIGHT = 36;
const ICONS_CARD_HEIGHT = 44;
const ICONS_CARD_PAD_X = 16;
const ICONS_CARD_ITEM_GAP = 16;
const ICONS_STATUS_WIDTH = 20;
const ICONS_BATTERY_WIDTH = 37;
const ICONS_WIFI_WIDTH = 28;
const ICONS_TEMP_WIDTH = 16;
const ICONS_CLOCK_WIDTH = 20;
const DETAILED_CORNER_MIN_WIDTH_WITH_TEL = 540;
const DETAILED_CORNER_MIN_WIDTH_NO_TEL = 400;
const DETAILED_CORNER_HEIGHT_WITH_TEL = 88;
const DETAILED_CORNER_HEIGHT_NO_TEL = 48;
const DETAILED_CORNER_TEL_GAP = 18;
const DETAILED_CORNER_TEL_PAD_X = 44;
const DETAILED_CORNER_CARD_RADIUS = 22;
const DETAILED_CORNER_HEADER_LEFT_X = 42;
const DETAILED_CORNER_HEADER_CHAR_W = TEL_TEXT_CHAR_WIDTH;
const DETAILED_CORNER_HEADER_RIGHT_PAD = 24;
const FRIGATE_MASK_SAFETY_PAD_PX = 6;

/**
 * Computes the total width in pixels for the icons-only capsule card given visible icon flags.
 *
 * @param {{ showBat?: boolean, showWifi?: boolean, showTemp?: boolean, showClock?: boolean }} flags - Enabled icon flags.
 * @returns {number}
 */
function computeIconsCardWidth(flags) {
  let contentW = ICONS_STATUS_WIDTH;
  if (flags.showBat) contentW += ICONS_CARD_ITEM_GAP + ICONS_BATTERY_WIDTH;
  if (flags.showWifi) contentW += ICONS_CARD_ITEM_GAP + ICONS_WIFI_WIDTH;
  if (flags.showTemp) contentW += ICONS_CARD_ITEM_GAP + ICONS_TEMP_WIDTH;
  if (flags.showClock) contentW += ICONS_CARD_ITEM_GAP + ICONS_CLOCK_WIDTH;
  return contentW + ICONS_CARD_PAD_X * 2;
}

/**
 * Computes the bounding dimensions { boxW, boxH, hasTelemetry, gap } for a corner detailed card.
 *
 * @param {string} headerText - Header text rendered on the top row.
 * @param {Array<Record<string, *>>} segments - Telemetry segments.
 * @returns {{ boxW: number, boxH: number, hasTelemetry: boolean, gap: number }}
 */
function computeCornerDetailedCardDimensions(headerText, segments) {
  const hasTelemetry = segments.length > 0;
  const gap = DETAILED_CORNER_TEL_GAP;
  const telW = hasTelemetry
      ? segments.reduce((sum, seg) => sum + seg.width, 0) +
        gap * Math.max(0, segments.length - 1) +
        DETAILED_CORNER_TEL_PAD_X
      : 0;
  const headerW =
      DETAILED_CORNER_HEADER_LEFT_X +
      headerText.length * DETAILED_CORNER_HEADER_CHAR_W +
      DETAILED_CORNER_HEADER_RIGHT_PAD;
  const minW = hasTelemetry ? DETAILED_CORNER_MIN_WIDTH_WITH_TEL : DETAILED_CORNER_MIN_WIDTH_NO_TEL;
  const boxW = Math.min(W - CARD_CORNER_MARGIN_PX * 2, Math.max(minW, telW, headerW));
  const boxH = hasTelemetry ? DETAILED_CORNER_HEIGHT_WITH_TEL : DETAILED_CORNER_HEIGHT_NO_TEL;
  return {boxW, boxH, hasTelemetry, gap};
}

/**
 * Computes the top-left (boxX, boxY) coordinates for a card of size (boxW, boxH)
 * based on the configured card_position ('center', 'top-left', 'top-right', 'bottom-left', 'bottom-right').
 *
 * @param {string} position - Normalized position string.
 * @param {number} boxW - Card width in pixels.
 * @param {number} boxH - Card height in pixels.
 * @returns {{ boxX: number, boxY: number }}
 */
function getCardBoxCoords(position, boxW, boxH) {
  const margin = CARD_CORNER_MARGIN_PX;
  switch (position) {
    case 'top-left':
      return {boxX: margin, boxY: margin};
    case 'top-right':
      return {boxX: W - boxW - margin, boxY: margin};
    case 'bottom-left':
      return {boxX: margin, boxY: H - boxH - margin};
    case 'bottom-right':
      return {boxX: W - boxW - margin, boxY: H - boxH - margin};
    case 'center':
    default:
      return {
        boxX: Math.round((W - boxW) / 2),
        boxY: Math.round((H - boxH) / 2),
      };
  }
}

/**
 * Domain model representing a camera's status overlay card configuration, geometry, and frame buffers.
 */
class StatusCard {
  /**
   * @param {Record<string, *>} rawCamCfg - Camera entry from config.json.
   */
  constructor(rawCamCfg = {}) {
    const resolved = resolveCardConfig(rawCamCfg);
    this.config = resolved;
    this.theme = resolved.theme;
    this.position = resolved.position;
    this.sleepScreen = resolved.sleepScreen;

    this.autoFrigateMask = rawCamCfg.auto_frigate_mask ?? GLOBAL_AUTO_FRIGATE_MASK;
    this.showOnLive = rawCamCfg.card_show_on_live ?? GLOBAL_CARD_SHOW_ON_LIVE;
    this.lastSyncedMaskPoly = '';
    this.suppressLiveCard = false;

    this.liveTelState = null;
    this.backfillTelState = null;
    this.liveCard = null;
    this.backfillCard = null;
    this.liveOverlayBufs = [Buffer.allocUnsafe(FRAME), Buffer.allocUnsafe(FRAME)];
    this.liveOverlayIdx = 0;
    this.liveOverlayBuf = this.liveOverlayBufs[0];
    this.asleep = null;
    this.waking = null;
    this.busy = null;
  }

  /**
   * Returns true if the card uses a visible theme placed in one of the four corners.
   *
   * @returns {boolean}
   */
  isCorner() {
    return this.theme !== 'none' && this.position !== 'center';
  }

  /**
   * Returns true if the corner card should be composited onto live video frames.
   *
   * @returns {boolean}
   */
  shouldOverlayOnLive() {
    return Boolean(this.showOnLive && !this.suppressLiveCard && this.isCorner());
  }

  /**
   * Returns true if the pre-rendered detailed corner live card buffer needs to be built.
   *
   * @returns {boolean}
   */
  needsDetailedLiveCard() {
    return Boolean(this.showOnLive && this.theme === 'detailed' && this.isCorner());
  }

  /**
   * Returns true if the given non-empty polygon is already synced and intact in Frigate.
   *
   * @param {string} poly - Normalized polygon string.
   * @param {boolean} masksIntact - Whether Frigate motion and object masks match poly.
   * @returns {boolean}
   */
  isMaskSynced(poly, masksIntact) {
    return Boolean(poly && this.lastSyncedMaskPoly === poly && masksIntact);
  }

  /**
   * Clears the cached Frigate mask polygon so the next sync cycle re-verifies Frigate config.
   */
  resetMaskSync() {
    this.lastSyncedMaskPoly = '';
  }

  /**
   * Records the normalized polygon string that was verified or applied in Frigate.
   *
   * @param {string} poly - Normalized polygon coordinates.
   */
  markMaskSynced(poly) {
    this.lastSyncedMaskPoly = poly;
  }

  /**
   * Stores the pre-rendered YUV420p status card buffers and live/backfill telemetry visual states.
   *
   * @param {{ asleep: Uint8Array, waking: Uint8Array, busy: Uint8Array, liveTelState: Record<string, *>, backfillTelState: Record<string, *>, liveCard: Uint8Array|null, backfillCard: Uint8Array|null }} rendered - Rendered card buffers.
   */
  setRenderedFrames(rendered) {
    this.asleep = rendered.asleep;
    this.waking = rendered.waking;
    this.busy = rendered.busy;
    this.liveTelState = rendered.liveTelState;
    this.backfillTelState = rendered.backfillTelState;
    this.liveCard = rendered.liveCard;
    this.backfillCard = rendered.backfillCard;
  }

  /**
   * Copies a raw live YUV420p video frame into the next alternating scratch buffer for corner card
   * compositing so an in-flight encoder pipe write is never mutated mid-frame.
   *
   * @param {Uint8Array} rawFrame - Source YUV420p frame buffer.
   * @returns {Uint8Array} Scratch buffer containing a copy of rawFrame.
   */
  prepareLiveOverlayBuffer(rawFrame) {
    this.liveOverlayIdx = (this.liveOverlayIdx + 1) & 1;
    const targetBuf = this.liveOverlayBufs[this.liveOverlayIdx];
    rawFrame.copy(targetBuf);
    this.liveOverlayBuf = targetBuf;
    return targetBuf;
  }

  /**
   * Computes the corner bounding box { boxX, boxY, boxW, boxH } for this StatusCard,
   * or returns null if the card is centered or hidden.
   *
   * @param {string} displayTitle - Camera display title.
   * @param {import("./telemetry").Telemetry} telemetry - Camera Telemetry domain instance.
   * @returns {{ boxX: number, boxY: number, boxW: number, boxH: number }|null}
   */
  getBounds(displayTitle, telemetry) {
    if (!this.isCorner()) {
      return null;
    }
    let boxW = MINIMAL_CARD_WIDTH;
    let boxH = MINIMAL_CARD_HEIGHT;

    switch (this.theme) {
      case 'icons': {
        const tc = telemetry.config;
        boxW = computeIconsCardWidth({
          showBat: Boolean(tc.enabled && tc.battery),
          showWifi: Boolean(tc.enabled && tc.wifi),
          showTemp: Boolean(tc.enabled && tc.temperature),
          showClock: Boolean(tc.enabled && tc.lastSeen),
        });
        boxH = ICONS_CARD_HEIGHT;
        break;
      }
      case 'detailed': {
        const maxHeader = 'Asleep (Low Battery)  -  ' + displayTitle;
        const tc = telemetry.config;
        const st = this.liveTelState || evaluateTelemetryState('Asleep', {
          telCfg: tc,
          battery: telemetry.battery ?? 100,
          charging: telemetry.charging,
          powerLabel: telemetry.powerLabel || 'Charging',
          wifi: telemetry.wifi ?? 4,
          rssi: telemetry.rssi ?? -60,
          temp: telemetry.temp ?? 25,
          lastSeen: telemetry.lastSeen || '00:00',
        });
        const segments = tc.enabled ? buildTelemetrySegments(st) : [];
        const dims = computeCornerDetailedCardDimensions(maxHeader, segments);
        boxW = dims.boxW;
        boxH = dims.boxH;
        break;
      }
      case 'minimal':
      default:
        break;
    }

    const {boxX, boxY} = getCardBoxCoords(this.position, boxW, boxH);
    return {boxX, boxY, boxW, boxH};
  }

  /**
   * Computes the normalized Frigate mask polygon string for this StatusCard.
   *
   * @param {string} displayTitle - Camera display title.
   * @param {import("./telemetry").Telemetry} telemetry - Camera Telemetry domain instance.
   * @returns {string}
   */
  computeMaskPolygon(displayTitle, telemetry) {
    const bounds = this.getBounds(displayTitle, telemetry);
    if (!bounds) {
      return '';
    }
    const pad = FRIGATE_MASK_SAFETY_PAD_PX;
    const x0 = Math.max(0, (bounds.boxX - pad) / W).toFixed(3);
    const y0 = Math.max(0, (bounds.boxY - pad) / H).toFixed(3);
    const x1 = Math.min(1, (bounds.boxX + bounds.boxW + pad) / W).toFixed(3);
    const y1 = Math.min(1, (bounds.boxY + bounds.boxH + pad) / H).toFixed(3);
    return x0 + ',' + y0 + ',' + x0 + ',' + y1 + ',' + x1 + ',' + y1 + ',' + x1 + ',' + y0;
  }
}

module.exports = {
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
  StatusCard,
  computeIconsCardWidth,
  computeCornerDetailedCardDimensions,
  getCardBoxCoords,
};
