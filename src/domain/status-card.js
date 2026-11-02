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
const {evaluateTelemetryState, buildTelemetrySegments} = require('./telemetry');

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
  const margin = 24;
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
 * Computes the bounding box { boxX, boxY, boxW, boxH } of a camera's corner status card
 * across all states so Frigate motion/object masks and live overlays cover the exact card footprint.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @returns {{ boxX: number, boxY: number, boxW: number, boxH: number }|null}
 */
function getCameraCardBounds(cam) {
  const {theme, position} = cam.cardCfg;
  if (theme === 'none' || position === 'center') {
    return null;
  }

  let boxW = 92;
  let boxH = 36;

  switch (theme) {
    case 'icons': {
      const tc = cam.telCfg;
      let contentW = 20;
      if (tc.enabled && tc.battery) contentW += 16 + 37;
      if (tc.enabled && tc.wifi) contentW += 16 + 28;
      if (tc.enabled && tc.temperature) contentW += 16 + 16;
      if (tc.enabled && tc.lastSeen) contentW += 16 + 20;
      boxW = contentW + 32;
      boxH = 44;
      break;
    }
    case 'default': {
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
      break;
    }
    case 'minimal':
    default:
      break;
  }

  const {boxX, boxY} = getCardBoxCoords(position, boxW, boxH);
  return {boxX, boxY, boxW, boxH};
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
  if (!bounds) {
    return '';
  }
  const pad = 6;
  const x0 = Math.max(0, (bounds.boxX - pad) / W).toFixed(3);
  const y0 = Math.max(0, (bounds.boxY - pad) / H).toFixed(3);
  const x1 = Math.min(1, (bounds.boxX + bounds.boxW + pad) / W).toFixed(3);
  const y1 = Math.min(1, (bounds.boxY + bounds.boxH + pad) / H).toFixed(3);
  return x0 + ',' + y0 + ',' + x0 + ',' + y1 + ',' + x1 + ',' + y1 + ',' + x1 + ',' + y0;
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
    this.background = resolved.background;
    this.dimBackground = resolved.dimBackground;

    this.autoFrigateMask = rawCamCfg.auto_frigate_mask ?? GLOBAL_AUTO_FRIGATE_MASK;
    this.showOnLive = rawCamCfg.card_show_on_live ?? GLOBAL_CARD_SHOW_ON_LIVE;
    this.lastSyncedMaskPoly = '';
    this.suppressLiveCard = false;

    this.liveTelState = null;
    this.liveCard = null;
    this.liveOverlayBuf = Buffer.allocUnsafe(FRAME);
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
}

module.exports = {
  StatusCard,
  getCardBoxCoords,
  getCameraCardBounds,
  computeFrigateMaskPolygon,
};
