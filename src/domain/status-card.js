// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
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
  CARD_THEMES,
  CARD_POSITIONS,
  CARD_STATUS_TITLES,
  GLOBAL_AUTO_FRIGATE_MASK,
  GLOBAL_CARD_SHOW_ON_LIVE,
  resolveCardConfig,
} = require('../config');

const CARD_CORNER_MARGIN_PX = 24;
const MASK_NORMALIZED_COORD_DECIMALS = 3;
const HUD_WIDTH_DENOMINATOR = 3;
const MIN_HUD_CARD_WIDTH = 240;

const MINIMAL_CARD_WIDTH = 64;
const MINIMAL_CARD_HEIGHT = 12;
const MINIMAL_PILL_WIDTH = 26;
const MINIMAL_DOT_SIZE = 12;
const MINIMAL_ITEM_GAP = 7;

const GLANCE_CARD_HEIGHT = 44;
const GLANCE_CARD_PAD_X = 16;
const GLANCE_CARD_ITEM_GAP = 14;
const GLANCE_STATUS_WIDTH = 24;
const GLANCE_BATTERY_WIDTH = 30;
const GLANCE_WIFI_WIDTH = 24;
const GLANCE_TEMP_WIDTH = 20;
const GLANCE_CLOCK_WIDTH = 24;

const PEBBLE_SIZE = 44;
const PEBBLES_GAP_PX = 8;

const HUD_CARD_MAX_WIDTH = 832;
const HUD_CARD_HEIGHT = 76;
const FRIGATE_MASK_SAFETY_PAD_PX = 6;

/**
 * Computes the bounding box { boxX, boxY, boxW, boxH } for the diagnostic "hud" theme
 * at the configured card_position, strictly capped at <= 2/3 of the frame width.
 *
 * @param {string} position - Normalized card_position string.
 * @returns {Readonly<{ boxX: number, boxY: number, boxW: number, boxH: number }>}
 */
function computeHudCardBounds(position) {
  const maxTwoThirds = Math.floor((W * 2) / HUD_WIDTH_DENOMINATOR) & ~1;
  const boxW = Math.min(HUD_CARD_MAX_WIDTH, Math.max(MIN_HUD_CARD_WIDTH, maxTwoThirds));
  const boxH = HUD_CARD_HEIGHT;
  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);
  return Object.freeze({boxX, boxY, boxW, boxH});
}

/**
 * Computes the inner width of the sensor icon strip (battery, Wi-Fi, thermometer, and analog clock)
 * for the "glance" theme.
 *
 * @param {{ showBat?: boolean, showWifi?: boolean, showTemp?: boolean, showClock?: boolean }} flags - Icon flags.
 * @returns {number}
 */
function computeSensorIconsStripWidth(flags) {
  const widths = [];
  if (flags.showBat) {
    widths.push(GLANCE_BATTERY_WIDTH);
  }
  if (flags.showWifi) widths.push(GLANCE_WIFI_WIDTH);
  if (flags.showTemp) widths.push(GLANCE_TEMP_WIDTH);
  if (flags.showClock) widths.push(GLANCE_CLOCK_WIDTH);
  if (widths.length === 0) {
    return 0;
  }
  const itemsSum = widths.reduce((sum, w) => sum + w, 0);
  return itemsSum + GLANCE_CARD_ITEM_GAP * (widths.length - 1);
}

/**
 * Computes the even-aligned total width in pixels for the "glance" capsule card given visible icon flags.
 *
 * @param {{ showBat?: boolean, showWifi?: boolean, showTemp?: boolean, showClock?: boolean }} flags - Icon flags.
 * @returns {number}
 */
function computeGlanceCardWidth(flags) {
  const sensorStripW = computeSensorIconsStripWidth(flags);
  const contentW = GLANCE_STATUS_WIDTH + (sensorStripW > 0 ? GLANCE_CARD_ITEM_GAP + sensorStripW : 0);
  const rawW = contentW + GLANCE_CARD_PAD_X * 2;
  return (rawW + 1) & ~1;
}

/**
 * Computes the total width in pixels for the backgroundless "minimal" card given visible icon flags.
 *
 * @param {{ showBat?: boolean, showWifi?: boolean }} [flags={}] - Enabled dot flags.
 * @returns {number}
 */
function computeMinimalCardWidth(flags = {}) {
  let width = MINIMAL_PILL_WIDTH;
  if (flags.showBat) {
    width += MINIMAL_ITEM_GAP + MINIMAL_DOT_SIZE;
  }
  if (flags.showWifi) {
    width += MINIMAL_ITEM_GAP + MINIMAL_DOT_SIZE;
  }
  return width;
}

/**
 * Computes the individual 44x44 crystal pebble widths (Status, Battery, Wi-Fi, Temperature, Clock),
 * inter-pebble gap, and total bounding width for the "pebbles" theme.
 *
 * @param {{ showBat?: boolean, showWifi?: boolean, showTemp?: boolean, showClock?: boolean }} flags - Icon flags.
 * @returns {Readonly<{
 *   statusW: number,
 *   batW: number,
 *   wifiW: number,
 *   tempW: number,
 *   clockW: number,
 *   gapPx: number,
 *   pebbleWidths: ReadonlyArray<number>,
 *   totalW: number
 * }>}
 */
function computePebblesCardWidths(flags) {
  const statusW = PEBBLE_SIZE;
  const batW = flags.showBat ? PEBBLE_SIZE : 0;
  const wifiW = flags.showWifi ? PEBBLE_SIZE : 0;
  const tempW = flags.showTemp ? PEBBLE_SIZE : 0;
  const clockW = flags.showClock ? PEBBLE_SIZE : 0;
  const pebbleWidths = [statusW];
  if (batW > 0) pebbleWidths.push(batW);
  if (wifiW > 0) pebbleWidths.push(wifiW);
  if (tempW > 0) pebbleWidths.push(tempW);
  if (clockW > 0) pebbleWidths.push(clockW);
  const gapPx = pebbleWidths.length > 1 ? PEBBLES_GAP_PX : 0;
  const itemsSum = pebbleWidths.reduce((sum, w) => sum + w, 0);
  const totalW = itemsSum + gapPx * (pebbleWidths.length - 1);
  return Object.freeze({
    statusW,
    batW,
    wifiW,
    tempW,
    clockW,
    gapPx,
    pebbleWidths: Object.freeze(pebbleWidths),
    totalW,
  });
}

/**
 * Computes the top-left (boxX, boxY) coordinates for a card of size (boxW, boxH)
 * based on the configured card_position.
 *
 * @param {string} position - Normalized position string.
 * @param {number} boxW - Card width in pixels.
 * @param {number} boxH - Card height in pixels.
 * @returns {Readonly<{ boxX: number, boxY: number }>}
 */
function getCardBoxCoords(position, boxW, boxH) {
  const margin = CARD_CORNER_MARGIN_PX;
  const centerBoxX = Math.round((W - boxW) / 2) & ~1;
  switch (position) {
    case CARD_POSITIONS.TOP_LEFT:
      return Object.freeze({boxX: margin, boxY: margin});
    case CARD_POSITIONS.TOP_CENTER:
      return Object.freeze({boxX: centerBoxX, boxY: margin});
    case CARD_POSITIONS.TOP_RIGHT:
      return Object.freeze({boxX: W - boxW - margin, boxY: margin});
    case CARD_POSITIONS.BOTTOM_LEFT:
      return Object.freeze({boxX: margin, boxY: H - boxH - margin});
    case CARD_POSITIONS.BOTTOM_CENTER:
      return Object.freeze({boxX: centerBoxX, boxY: H - boxH - margin});
    case CARD_POSITIONS.BOTTOM_RIGHT:
      return Object.freeze({boxX: W - boxW - margin, boxY: H - boxH - margin});
    case CARD_POSITIONS.CENTER:
    default:
      return Object.freeze({
        boxX: centerBoxX,
        boxY: Math.round((H - boxH) / 2) & ~1,
      });
  }
}

/**
 * Domain model representing a camera's status overlay card configuration, geometry, and frame buffers.
 */
class StatusCard {
  /**
   * @param {Record<string, *>} rawCamCfg - Camera entry from config.yaml.
   */
  constructor(rawCamCfg = {}) {
    const resolved = resolveCardConfig(rawCamCfg);
    this.config = resolved;
    this.theme = resolved.theme;
    this.position = resolved.position;
    this.sleepScreen = resolved.sleepScreen;

    this.autoFrigateMask = rawCamCfg.autoFrigateMask ?? rawCamCfg.auto_frigate_mask ?? GLOBAL_AUTO_FRIGATE_MASK;
    this.showOnLive = rawCamCfg.cardShowOnLive ?? rawCamCfg.card_show_on_live ?? GLOBAL_CARD_SHOW_ON_LIVE;
    this.lastSyncedMaskPoly = '';
    this.suppressLiveCard = false;

    /** @type {Buffer[]|null} */
    this.liveOverlayBufs = null;
    this.liveOverlayIdx = 0;
    /** @type {Uint8Array} */
    this.asleep = Buffer.allocUnsafe(FRAME);
    /** @type {Uint8Array|null} */
    this._waking = null;
    /** @type {Uint8Array|null} */
    this._busy = null;
    this._wakingDirty = true;
    this._busyDirty = true;
    /** @type {((titleText: string, targetBuf: Uint8Array) => Uint8Array)|null} */
    this._lazyRenderFn = null;
  }

  /**
   * Returns the waking status card frame buffer, allocating and rendering it on first access.
   *
   * @returns {Uint8Array}
   */
  get waking() {
    if (!this._waking) {
      this._waking = Buffer.allocUnsafe(FRAME);
      this._wakingDirty = true;
    }
    if (this._wakingDirty && this._lazyRenderFn) {
      this._wakingDirty = false;
      this._lazyRenderFn(CARD_STATUS_TITLES.WAKING_UP, this._waking);
    }
    return this._waking;
  }

  /**
   * Returns the busy/waiting status card frame buffer, allocating and rendering it on first access.
   *
   * @returns {Uint8Array}
   */
  get busy() {
    if (!this._busy) {
      this._busy = Buffer.allocUnsafe(FRAME);
      this._busyDirty = true;
    }
    if (this._busyDirty && this._lazyRenderFn) {
      this._busyDirty = false;
      this._lazyRenderFn(CARD_STATUS_TITLES.WAITING, this._busy);
    }
    return this._busy;
  }

  /**
   * Returns the already-allocated waking card buffer, or null if it has not been requested yet.
   *
   * @returns {Uint8Array|null}
   */
  peekWakingBuffer() {
    return this._waking;
  }

  /**
   * Returns the already-allocated busy card buffer, or null if it has not been requested yet.
   *
   * @returns {Uint8Array|null}
   */
  peekBusyBuffer() {
    return this._busy;
  }

  /**
   * Registers the on-demand render callback used when waking or busy buffers are first read.
   *
   * @param {((titleText: string, targetBuf: Uint8Array) => Uint8Array)|null} fn - Lazy render callback.
   */
  setLazyCardRenderer(fn) {
    this._lazyRenderFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * Returns true if the card uses a visible theme placed along the frame perimeter (non-center).
   *
   * @returns {boolean}
   */
  isCorner() {
    return this.theme !== CARD_THEMES.NONE && this.position !== CARD_POSITIONS.CENTER;
  }

  /**
   * Returns true if this card theme and placement can render an overlay during live streaming.
   *
   * @returns {boolean}
   */
  supportsLiveCardOverlay() {
    return this.theme === CARD_THEMES.HUD || this.isCorner();
  }

  /**
   * Returns the sanitized StatusCard configuration fields for GET /api/config, using null
   * for placement and live-overlay flags that are inactive under the resolved theme or position.
   *
   * @returns {Readonly<{
   *   card_theme: string,
   *   card_position: string|null,
   *   sleep_screen: string,
   *   card_show_on_live: boolean|null
   * }>}
   */
  toConfigSummary() {
    return Object.freeze({
      card_theme: this.theme,
      card_position: this.theme === CARD_THEMES.NONE ? null : this.position,
      sleep_screen: this.sleepScreen,
      card_show_on_live: this.supportsLiveCardOverlay() ? Boolean(this.showOnLive) : null,
    });
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
   * Stores the pre-rendered YUV420p status card buffers (asleep, and optional waking/busy).
   *
   * @param {{ asleep: Uint8Array, waking?: Uint8Array|null, busy?: Uint8Array|null }} rendered - Rendered card buffers.
   */
  setRenderedFrames(rendered) {
    this.asleep = rendered.asleep;
    if (rendered.waking) {
      this._waking = rendered.waking;
      this._wakingDirty = false;
    } else {
      this._wakingDirty = true;
    }
    if (rendered.busy) {
      this._busy = rendered.busy;
      this._busyDirty = false;
    } else {
      this._busyDirty = true;
    }
  }

  /**
   * Copies a raw live YUV420p video frame into the next alternating scratch buffer for corner card
   * compositing so an in-flight encoder pipe write is never mutated mid-frame.
   *
   * @param {Uint8Array} rawFrame - Source YUV420p frame buffer.
   * @returns {Uint8Array} Scratch buffer containing a copy of rawFrame.
   */
  prepareLiveOverlayBuffer(rawFrame) {
    if (!this.liveOverlayBufs) {
      this.liveOverlayBufs = [Buffer.allocUnsafe(FRAME), Buffer.allocUnsafe(FRAME)];
    }
    this.liveOverlayIdx = (this.liveOverlayIdx + 1) & 1;
    const targetBuf = this.liveOverlayBufs[this.liveOverlayIdx];
    targetBuf.set(rawFrame);
    return targetBuf;
  }

  /**
   * Computes the worst-case corner bounding box { boxX, boxY, boxW, boxH } for this StatusCard,
   * or returns null if the card is centered or hidden.
   *
   * @param {import("./telemetry").Telemetry} telemetry - Camera Telemetry domain instance.
   * @returns {{ boxX: number, boxY: number, boxW: number, boxH: number }|null}
   */
  getBounds(telemetry) {
    if (!this.isCorner()) {
      return null;
    }
    let boxW = MINIMAL_CARD_WIDTH;
    let boxH = MINIMAL_CARD_HEIGHT;

    switch (this.theme) {
      case CARD_THEMES.HUD:
        return computeHudCardBounds(this.position);
      case CARD_THEMES.GLANCE: {
        const tc = telemetry.config;
        boxW = computeGlanceCardWidth({
          showBat: Boolean(tc.enabled && tc.battery),
          showWifi: Boolean(tc.enabled && tc.wifi),
          showTemp: Boolean(tc.enabled && tc.temperature),
          showClock: Boolean(tc.enabled && tc.lastSeen),
        });
        boxH = GLANCE_CARD_HEIGHT;
        break;
      }
      case CARD_THEMES.PEBBLES: {
        const tc = telemetry.config;
        const widths = computePebblesCardWidths({
          showBat: Boolean(tc.enabled && tc.battery),
          showWifi: Boolean(tc.enabled && tc.wifi),
          showTemp: Boolean(tc.enabled && tc.temperature),
          showClock: Boolean(tc.enabled && tc.lastSeen),
        });
        boxW = widths.totalW;
        boxH = PEBBLE_SIZE;
        break;
      }
      case CARD_THEMES.MINIMAL:
      default: {
        const tc = telemetry && telemetry.config ? telemetry.config : null;
        boxW = tc
          ? computeMinimalCardWidth({
              showBat: Boolean(tc.enabled && tc.battery),
              showWifi: Boolean(tc.enabled && tc.wifi),
            })
          : MINIMAL_CARD_WIDTH;
        break;
      }
    }

    const {boxX, boxY} = getCardBoxCoords(this.position, boxW, boxH);
    return Object.freeze({boxX, boxY, boxW, boxH});
  }

  /**
   * Computes the normalized Frigate mask polygon string for this StatusCard.
   *
   * @param {import("./telemetry").Telemetry} telemetry - Camera Telemetry domain instance.
   * @returns {string}
   */
  computeMaskPolygon(telemetry) {
    const bounds = this.getBounds(telemetry);
    if (!bounds) {
      return '';
    }
    const pad = FRIGATE_MASK_SAFETY_PAD_PX;
    const x0 = Math.max(0, (bounds.boxX - pad) / W).toFixed(MASK_NORMALIZED_COORD_DECIMALS);
    const y0 = Math.max(0, (bounds.boxY - pad) / H).toFixed(MASK_NORMALIZED_COORD_DECIMALS);
    const x1 = Math.min(1, (bounds.boxX + bounds.boxW + pad) / W).toFixed(MASK_NORMALIZED_COORD_DECIMALS);
    const y1 = Math.min(1, (bounds.boxY + bounds.boxH + pad) / H).toFixed(MASK_NORMALIZED_COORD_DECIMALS);
    return x0 + ',' + y0 + ',' + x0 + ',' + y1 + ',' + x1 + ',' + y1 + ',' + x1 + ',' + y0;
  }
}

module.exports = {
  MINIMAL_CARD_HEIGHT,
  MINIMAL_PILL_WIDTH,
  MINIMAL_DOT_SIZE,
  MINIMAL_ITEM_GAP,
  GLANCE_CARD_HEIGHT,
  GLANCE_CARD_PAD_X,
  GLANCE_CARD_ITEM_GAP,
  GLANCE_STATUS_WIDTH,
  PEBBLE_SIZE,
  StatusCard,
  computeMinimalCardWidth,
  computeGlanceCardWidth,
  computePebblesCardWidths,
  computeHudCardBounds,
  getCardBoxCoords,
};
