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

/**
 * Builds the JSON payload sent to the Home Assistant webhook.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} [extra={}] - Additional fields (event_id, review_id, no_video).
 * @returns {Record<string, *>}
 */
function buildHaWebhookPayload(cam, extra = {}) {
  const payload = {
    camera: cam.name,
    title: cam.title || cam.name,
    label: cam.evLabel,
    ...extra,
  };
  if (cam.evPerson) {
    payload.person = cam.evPerson;
  }
  return payload;
}

/**
 * Sends an optional webhook POST notification to Home Assistant when an event starts and once
 * the corresponding Frigate event has been created.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {Record<string, *>} [extra={}] - Additional JSON fields to include in the webhook body.
 */
function notifyHA(cam, extra = {}) {
  if (!cfg.ha_webhook) {
    return;
  }
  const payload = buildHaWebhookPayload(cam, extra);
  fetch(cfg.ha_webhook, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(5000),
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
  buildHaWebhookPayload,
  notifyHA,
};
