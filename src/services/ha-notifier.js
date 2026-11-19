// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Home Assistant webhook notification client.
 */
'use strict';

const {cfg} = require('../config');
const {log, formatErrorMessage} = require('../logger');

/** @typedef {import("../domain/camera").Camera} Camera */

const HA_WEBHOOK_TIMEOUT_MS = 5000;
const HA_ERROR_SNIPPET_MAX_CHARS = 1024;

/**
 * Sends an optional webhook POST notification to Home Assistant when an event starts and once
 * the corresponding Frigate event has been created.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} [extra={}] - Additional JSON fields to include in the webhook body.
 * @param {string} [webhookUrl=cfg.ha_webhook_url] - Home Assistant webhook URL.
 * @returns {Promise<boolean>} Resolves to true when the webhook request succeeds.
 */
async function notifyHA(cam, extra = {}, webhookUrl = cfg.ha_webhook_url) {
  if (!webhookUrl) {
    return false;
  }
  const bodyJson = JSON.stringify(cam.toHaWebhookPayload(extra));
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(HA_WEBHOOK_TIMEOUT_MS),
      body: bodyJson,
    });
    if (!response.ok) {
      const rawBody =
        typeof response.text === 'function'
          ? await response.text().catch(() => {
              // Best-effort diagnostic snippet; log HTTP status alone if body stream fails.
              return '';
            })
          : '';
      const snippet = String(rawBody || '')
        .trim()
        .slice(0, HA_ERROR_SNIPPET_MAX_CHARS);
      log.warn(cam, 'HA webhook failed (HTTP ' + response.status + (snippet ? ': ' + snippet : '') + ')');
      return false;
    }
    return true;
  } catch (err) {
    log.warn(cam, 'HA webhook failed: ' + formatErrorMessage(err));
    return false;
  }
}

module.exports = {
  notifyHA,
};
