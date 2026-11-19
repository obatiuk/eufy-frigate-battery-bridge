// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Frigate motion/object mask synchronization: builds the bridge status card polygon payloads, applies them
 * through PUT /api/config/set, and tracks Frigate API connectivity.
 */
'use strict';

const {cfg} = require('../config');
const {log, formatErrorMessage} = require('../logger');
const {seedOfflineCameraSnapshots} = require('../media/encoder');
const {syncServiceHealthFlags, readHttpErrorSnippet, FRIGATE_API_TIMEOUT_MS} = require('./upstream-health');

/** @typedef {import("../domain/camera").Camera} Camera */

const FRIGATE_CONFIG_PUT_TIMEOUT_MS = 8000;
const ENCODER_RECONNECT_MASK_SYNC_DELAY_MS = 6000;
const MASK_SYNC_INTERVAL_MS = 60000;
const FRIGATE_BRIDGE_MASK_KEY = 'eufy_bridge_card';
const FRIGATE_BRIDGE_MASK_FRIENDLY_NAME = 'Eufy Bridge Status Card';

let isSyncingMasks = false;
let frigateApiDown = false;
let lastMaskCheckAt = Date.now();

const isFrigateConnected = () => !frigateApiDown;

/**
 * Builds the Frigate PUT /api/config/set JSON envelope for updating or deleting eufy_bridge_card.
 *
 * @param {string} cameraName - Camera name in Frigate config.
 * @param {'motion'|'objects'} section - Frigate config section ('motion' or 'objects').
 * @param {Record<string, *>|string} maskEntry - Named mask object or '' to delete the key.
 * @returns {Record<string, *>}
 */
function buildFrigateMaskEnvelope(cameraName, section, maskEntry) {
  return Object.freeze({
    requires_restart: 0,
    update_topic: 'config/cameras/' + cameraName + '/' + section,
    config_data: {
      cameras: {
        [cameraName]: {
          [section]: {
            mask: {
              [FRIGATE_BRIDGE_MASK_KEY]: maskEntry,
            },
          },
        },
      },
    },
  });
}

/**
 * Builds the Frigate PUT /api/config/set JSON body for updating a camera's eufy_bridge_card mask.
 *
 * @param {string} cameraName - Camera name in Frigate config.
 * @param {'motion'|'objects'} section - Frigate config section ('motion' or 'objects').
 * @param {{ enabled: boolean, coordinates: string }} spec - Mask payload options:
 *   enabled (whether the mask is enabled) and coordinates (normalized polygon string).
 * @returns {Record<string, unknown>}
 */
function buildFrigateMaskPayload(cameraName, section, spec) {
  return buildFrigateMaskEnvelope(cameraName, section, {
    friendly_name: FRIGATE_BRIDGE_MASK_FRIENDLY_NAME,
    enabled: spec.enabled,
    coordinates: spec.coordinates,
  });
}

/**
 * Builds the Frigate PUT /api/config/set JSON body for deleting only the bridge-created
 * eufy_bridge_card mask entry (leaving all user-defined masks intact).
 *
 * @param {string} cameraName - Camera name in Frigate config.
 * @param {'motion'|'objects'} section - Frigate config section ('motion' or 'objects').
 * @returns {Record<string, *>}
 */
function buildFrigateMaskDeletePayload(cameraName, section) {
  return buildFrigateMaskEnvelope(cameraName, section, '');
}

/**
 * Checks whether an existing Frigate named mask entry matches the expected polygon and is enabled.
 *
 * @param {Record<string, *>|null|undefined} maskEntry - Frigate eufy_bridge_card object.
 * @param {string} expectedPoly - Expected normalized polygon string.
 * @returns {boolean}
 */
function isFrigateMaskIntact(maskEntry, expectedPoly) {
  return Boolean(maskEntry && typeof maskEntry === 'object' && maskEntry.enabled !== false)
    ? maskEntry.coordinates === expectedPoly ||
        (Array.isArray(maskEntry.coordinates) &&
          maskEntry.coordinates.length === 1 &&
          maskEntry.coordinates[0] === expectedPoly)
    : false;
}

/**
 * Deletes the bridge-created eufy_bridge_card mask entry from a single Frigate camera section.
 *
 * @param {Camera} cam - Camera state object.
 * @param {'motion'|'objects'} section - Frigate mask section ('motion' or 'objects').
 * @param {string} [frigateUrl=cfg.frigate_url] - Frigate base URL.
 * @returns {Promise<'deleted'|'failed'>}
 */
async function deleteFrigateMaskSection(cam, section, frigateUrl = cfg.frigate_url) {
  try {
    const deletePayload = buildFrigateMaskDeletePayload(cam.getName(), section);
    const res = await fetch(frigateUrl + '/api/config/set', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
      body: JSON.stringify(deletePayload),
    });
    if (!res.ok) {
      const errText = await readHttpErrorSnippet(res);
      log.warn(cam, 'could not delete Frigate ' + section + '.mask (HTTP ' + res.status + '): ' + errText);
      return 'failed';
    }
    return 'deleted';
  } catch (err) {
    log.warn(cam, 'failed to delete Frigate ' + section + '.mask: ' + formatErrorMessage(err));
    return 'failed';
  }
}

/**
 * Synchronizes a single mask section ('motion' or 'objects') for a camera in Frigate via
 * PUT /api/config/set (requires_restart: 0).
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>|null|undefined} camCfg - Camera configuration object from Frigate /api/config.
 * @param {{ section: 'motion'|'objects', poly: string, frigateUrl?: string }} spec - Sync options:
 *   section ('motion' or 'objects'), poly (normalized polygon string, or '' to delete the bridge-created mask),
 *   and optional frigateUrl (Frigate base URL, default cfg.frigate_url).
 * @returns {Promise<'verified'|'applied'|'deleted'|'none'|'failed'>}
 */
async function syncSingleFrigateMaskSection(cam, camCfg, spec) {
  const {section, poly, frigateUrl = cfg.frigate_url} = spec;
  const camName = cam.getName();
  const sectionObj = camCfg && camCfg[section] ? camCfg[section] : null;
  const existingMasks = sectionObj ? sectionObj.mask : undefined;
  const isNamedDict = existingMasks !== null && typeof existingMasks === 'object' && !Array.isArray(existingMasks);
  const hasBridgeMask =
    isNamedDict &&
    Object.prototype.hasOwnProperty.call(existingMasks, FRIGATE_BRIDGE_MASK_KEY) &&
    Boolean(existingMasks[FRIGATE_BRIDGE_MASK_KEY]);

  if (!poly) {
    return hasBridgeMask ? deleteFrigateMaskSection(cam, section, frigateUrl) : 'none';
  }

  if (isNamedDict && isFrigateMaskIntact(existingMasks[FRIGATE_BRIDGE_MASK_KEY], poly)) {
    return 'verified';
  }
  if (cam.isMaskSectionAlreadySynced(section, poly)) {
    return 'verified';
  }

  try {
    const enablePayload = buildFrigateMaskPayload(camName, section, {enabled: true, coordinates: poly});
    const putRes = await fetch(frigateUrl + '/api/config/set', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
      body: JSON.stringify(enablePayload),
    });

    if (putRes.ok) {
      return 'applied';
    }
    const errText = await readHttpErrorSnippet(putRes);

    const legacyUrl =
      frigateUrl +
      '/api/config/set?cameras.' +
      encodeURIComponent(camName) +
      '.' +
      section +
      '.mask=' +
      encodeURIComponent(poly);
    let legacyFailureSuffix = '';
    try {
      const legRes = await fetch(legacyUrl, {
        method: 'PUT',
        signal: AbortSignal.timeout(FRIGATE_CONFIG_PUT_TIMEOUT_MS),
      });
      if (legRes.ok) {
        return 'applied';
      }
      if (legRes.status !== putRes.status) {
        legacyFailureSuffix = '; legacy fallback HTTP ' + legRes.status;
      }
    } catch (legErr) {
      legacyFailureSuffix = '; legacy fallback failed: ' + formatErrorMessage(legErr);
    }

    log.warn(
      cam,
      'could not auto-apply Frigate ' +
        section +
        '.mask (HTTP ' +
        putRes.status +
        '): ' +
        errText +
        legacyFailureSuffix +
        ' (calculated mask=' +
        poly +
        ')'
    );
    return 'failed';
  } catch (err) {
    log.warn(cam, 'error syncing Frigate ' + section + '.mask (' + poly + '): ' + formatErrorMessage(err));
    return 'failed';
  }
}

/**
 * Synchronizes both motion and object masks for one camera against fetched Frigate config.
 *
 * @param {Camera} cam - Camera instance.
 * @param {Record<string, *>|null} frigateCfg - Parsed Frigate /api/config payload.
 * @param {string} frigateUrl - Frigate base URL.
 * @returns {Promise<boolean>} True if at least one mask section was newly applied.
 */
async function syncCameraFrigateMasks(cam, frigateCfg, frigateUrl) {
  if (!cam.hasAutoFrigateMask()) {
    return false;
  }
  const poly = cam.computeMaskPolygon();
  const camCfg = frigateCfg && frigateCfg.cameras ? frigateCfg.cameras[cam.getName()] : null;
  if (!camCfg) {
    return false;
  }

  const motMask = camCfg.motion && camCfg.motion.mask ? camCfg.motion.mask[FRIGATE_BRIDGE_MASK_KEY] : null;
  const objMask = camCfg.objects && camCfg.objects.mask ? camCfg.objects.mask[FRIGATE_BRIDGE_MASK_KEY] : null;
  const masksIntact =
    isFrigateMaskIntact(motMask, poly) &&
    (isFrigateMaskIntact(objMask, poly) || cam.isMaskSectionAlreadySynced('objects', poly));

  if (cam.isMaskSynced(poly, masksIntact)) {
    return false;
  }

  const motionStatus = await syncSingleFrigateMaskSection(cam, camCfg, {section: 'motion', poly, frigateUrl});
  const objectStatus = await syncSingleFrigateMaskSection(cam, camCfg, {section: 'objects', poly, frigateUrl});

  if (!poly) {
    if (motionStatus !== 'failed' && objectStatus !== 'failed') {
      cam.resetMaskSync();
    }
    if (motionStatus === 'deleted' || objectStatus === 'deleted') {
      log.info(
        cam,
        'deleted Frigate motion & object masks ' +
          FRIGATE_BRIDGE_MASK_KEY +
          ' (card is ' +
          cam.formatCardPlacementSummary('/') +
          ')'
      );
    }
    return false;
  }

  if (motionStatus === 'failed' || objectStatus === 'failed') {
    return false;
  }
  cam.markMaskSynced(poly);
  const wasApplied = motionStatus === 'applied' || objectStatus === 'applied';
  const actionVerb = wasApplied ? 'auto-applied' : 'verified';
  const logMaskFn = wasApplied ? log.info : log.debug;
  logMaskFn(
    cam,
    actionVerb +
      ' Frigate motion & object masks eufy_bridge_card (' +
      cam.formatCardPlacementSummary('@') +
      ' -> ' +
      poly +
      ')'
  );
  return wasApplied;
}

/**
 * Automatically synchronizes each camera's calculated corner status card motion.mask and
 * objects.mask into Frigate via Frigate's HTTP API (GET /api/config + PUT /api/config/set).
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {{ forceResync?: boolean, shuttingDown?: boolean, frigateUrl?: string }|boolean} [opts={}] - Sync options:
 *   forceResync (whether to clear cached polygons and re-verify all cameras), shuttingDown (whether the bridge is
 *   shutting down), and frigateUrl (Frigate base URL, default cfg.frigate_url).
 */
async function syncFrigateMotionMasks(cams, opts = {}) {
  const isLegacyPositional = typeof opts === 'boolean';
  const forceResync = isLegacyPositional ? opts : Boolean(opts.forceResync);
  const shuttingDown = isLegacyPositional ? Boolean(arguments[2]) : Boolean(opts.shuttingDown);
  const frigateUrl =
    (isLegacyPositional ? (typeof arguments[3] === 'string' ? arguments[3] : undefined) : opts.frigateUrl) ??
    cfg.frigate_url;

  if (isSyncingMasks || shuttingDown || !frigateUrl) {
    return;
  }
  if (!cams.some((c) => c.hasAutoFrigateMask())) {
    if (frigateApiDown) {
      frigateApiDown = false;
      syncServiceHealthFlags(cams, {frigateConnected: true});
    }
    return;
  }
  isSyncingMasks = true;
  lastMaskCheckAt = Date.now();
  try {
    const wasFrigateApiDown = frigateApiDown;
    const hadPriorMaskSync = cams.some((c) => c.hasSyncedMaskPolygon());
    let anyMaskReapplied = false;
    if (forceResync) {
      for (const c of cams) {
        c.resetMaskSync();
      }
    }
    let frigateCfg = null;
    const markFrigateApiDown = (/** @type {string} */ reason) => {
      frigateApiDown = true;
      syncServiceHealthFlags(cams, {frigateConnected: false});
      if (!wasFrigateApiDown) {
        log.warn('bridge', 'Frigate API unreachable (' + frigateUrl + ', ' + reason + '), retrying periodically');
      } else {
        log.debug('bridge', 'could not fetch Frigate /api/config for auto_frigate_mask: ' + reason);
      }
    };
    try {
      const r = await fetch(frigateUrl + '/api/config', {signal: AbortSignal.timeout(FRIGATE_API_TIMEOUT_MS)});
      if (!r.ok) {
        const snippet = await readHttpErrorSnippet(r);
        markFrigateApiDown('HTTP ' + r.status + (snippet ? ': ' + snippet : ''));
        return;
      }
      frigateCfg = await r.json();
    } catch (err) {
      markFrigateApiDown(formatErrorMessage(err));
      return;
    }

    frigateApiDown = false;
    syncServiceHealthFlags(cams, {frigateConnected: true});
    if (wasFrigateApiDown) {
      log.info('bridge', 'Frigate API recovered after restart/outage, re-verifying motion & object masks');
    }
    lastMaskCheckAt = Date.now();
    for (const cam of cams) {
      const applied = await syncCameraFrigateMasks(cam, frigateCfg, frigateUrl);
      anyMaskReapplied = anyMaskReapplied || applied;
    }
    if (wasFrigateApiDown || (hadPriorMaskSync && anyMaskReapplied)) {
      seedOfflineCameraSnapshots(cams);
    }
  } finally {
    isSyncingMasks = false;
  }
}

/**
 * Marks Frigate's API as down and schedules a mask re-verification after recovery.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {() => boolean} isShuttingDownFn - Callback returning shutdown state.
 */
function handleEncoderReconnectMaskSync(cams, isShuttingDownFn) {
  frigateApiDown = true;
  syncServiceHealthFlags(cams, {frigateConnected: false});
  const timer = setTimeout(() => {
    if (!isShuttingDownFn()) {
      void syncFrigateMotionMasks(cams, {forceResync: true, shuttingDown: isShuttingDownFn()});
    }
  }, ENCODER_RECONNECT_MASK_SYNC_DELAY_MS);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

/**
 * Runs the periodic 60s mask drift check if due.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {number} now - Current epoch timestamp.
 * @param {boolean} shuttingDown - Whether the bridge is shutting down.
 */
function checkPeriodicMaskSync(cams, now, shuttingDown) {
  if (now - lastMaskCheckAt >= MASK_SYNC_INTERVAL_MS) {
    lastMaskCheckAt = now;
    void syncFrigateMotionMasks(cams, {forceResync: false, shuttingDown});
  }
}

module.exports = {
  isFrigateConnected,
  buildFrigateMaskPayload,
  buildFrigateMaskDeletePayload,
  isFrigateMaskIntact,
  syncSingleFrigateMaskSection,
  syncFrigateMotionMasks,
  handleEncoderReconnectMaskSync,
  checkPeriodicMaskSync,
};
