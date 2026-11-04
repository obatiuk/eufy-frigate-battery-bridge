// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Home Assistant webhook notification client.
 */
'use strict';

const {cfg} = require('../config');
const {log} = require('../logger');

/** @typedef {import("../domain/camera").Camera} Camera */

const HA_WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Sends an optional webhook POST notification to Home Assistant when an event starts and once
 * the corresponding Frigate event has been created.
 *
 * @param {Camera} cam - Camera domain instance.
 * @param {Record<string, *>} [extra={}] - Additional JSON fields to include in the webhook body.
 */
function notifyHA(cam, extra = {}) {
  if (!cfg.ha_webhook) {
    return;
  }
  const payload = cam.toHaWebhookPayload(extra);
  fetch(cfg.ha_webhook, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(HA_WEBHOOK_TIMEOUT_MS),
    body: JSON.stringify(payload),
  })
      .then((r) => {
        if (!r.ok) {
          log.warn(cam, 'HA webhook failed (HTTP ' + r.status + ')');
        }
      })
      .catch((err) => log.warn(cam, 'HA webhook failed: ' + err.message));
}

module.exports = {
  notifyHA,
};
