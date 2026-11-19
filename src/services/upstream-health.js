// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Shared upstream (Frigate and go2rtc) HTTP helpers: bounded error snippets, request timeouts, and service
 * health flag propagation to cameras.
 */
'use strict';

const {renderCameraCards} = require('../overlay/card-renderer');
const {pushFrameToEncoder} = require('../media/encoder');

/** @typedef {import("../domain/camera").Camera} Camera */

const FRIGATE_API_TIMEOUT_MS = 5000;
const FRIGATE_FAST_QUERY_TIMEOUT_MS = 2500;
const ERROR_SNIPPET_MAX_CHARS = 1024;

/**
 * Updates upstream service connectivity flags on all cameras and re-renders sleeping cards when changed.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {{
 *   wsConnected?: boolean,
 *   frigateConnected?: boolean,
 *   go2rtcConnected?: boolean
 * }} flags - Service health flags.
 */
function syncServiceHealthFlags(cams, flags) {
  for (const cam of cams) {
    if (cam.updateServiceHealth(flags)) {
      renderCameraCards(cam);
      pushFrameToEncoder(cam);
    }
  }
}

/**
 * Reads a bounded diagnostic body snippet from a failed HTTP Response when available.
 *
 * @param {{ status: number, text?: () => Promise<string> }} res - Fetch response object.
 * @returns {Promise<string>}
 */
async function readHttpErrorSnippet(res) {
  if (!res || typeof res.text !== 'function') {
    return '';
  }
  const raw = await res.text().catch(() => {
    // Best-effort diagnostic snippet; return empty string if response body cannot be read.
    return '';
  });
  return String(raw || '')
    .trim()
    .slice(0, ERROR_SNIPPET_MAX_CHARS);
}

module.exports = {FRIGATE_API_TIMEOUT_MS, FRIGATE_FAST_QUERY_TIMEOUT_MS, syncServiceHealthFlags, readHttpErrorSnippet};
