/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 57:
 * Make Frigate Mask Sync Safer & Warn Once per Missing Camera
 * (docs/regression/57-frigate-mask-no-legacy-fallback-and-missing-camera-warn.md).
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {log} = require('../../src/logger');
const {
  resetFrigateMaskSyncState,
  syncSingleFrigateMaskSection,
  syncFrigateMotionMasks,
} = require('../../src/services/frigate-masks');

installDefaultFetchStub();

describe('Regression 57: Make Frigate Mask Sync Safer & Warn Once per Missing Camera', () => {
  afterEach(() => {
    resetFrigateMaskSyncState();
  });

  it(
    'Regression 57: removes legacy query-string PUT fallback on non-2xx mask responses while preserving HTTP status ' +
      'and validation body diagnostics',
    async () => {
      // Regression: syncSingleFrigateMaskSection fell back to PUT /api/config/set?cameras.<name>.<section>.mask=<poly>
      // on non-2xx responses, risking flat-string overwrite of user-defined masks and issuing a second failing PUT.
      const cam = new Camera({
        serial: 'T8161T0000000057',
        name: 'front_gate',
        card_theme: 'glance',
        card_position: 'bottom-left',
        auto_frigate_mask: true,
      });

      /** @type {string[]} */
      const calledUrls = [];
      /** @type {string[]} */
      const warnings = [];
      const origWarn = log.warn;
      const origFetch = global.fetch;
      log.warn = (scope, ...args) => {
        warnings.push((typeof scope === 'object' && scope ? scope.getName() : String(scope)) + ': ' + args.join(' '));
      };

      try {
        global.fetch = /** @type {*} */ (
          async (url) => {
            calledUrls.push(String(url));
            if (String(url).includes('?cameras.')) {
              return {
                ok: true,
                status: 200,
                async text() {
                  return '';
                },
              };
            }
            return {
              ok: false,
              status: 422,
              async text() {
                return '{"detail":"schema validation rejected mask"}';
              },
            };
          }
        );

        const res = await syncSingleFrigateMaskSection(
          cam,
          {motion: {mask: {user_driveway: {enabled: true, coordinates: '0.1,0.1,0.2,0.2'}}}},
          {
            section: 'motion',
            poly: cam.computeMaskPolygon(),
            frigateUrl: 'http://127.0.0.1:5000',
          }
        );

        assert.equal(res, 'failed');
        assert.deepEqual(calledUrls, ['http://127.0.0.1:5000/api/config/set']);
        assert.equal(
          warnings.some((w) => w.includes('HTTP 422') && w.includes('schema validation rejected mask')),
          true
        );
      } finally {
        log.warn = origWarn;
        global.fetch = origFetch;
      }
    }
  );

  it(
    'Regression 57: warns once per missing camera in Frigate /api/config cameras and ' +
      're-arms once the camera appears',
    async () => {
      // Regression: syncCameraFrigateMasks silently returned false when frigateCfg.cameras[cam.getName()] was missing.
      const cam = new Camera({
        serial: 'T8161T0000000058',
        name: 'unmapped_bridge_cam',
        card_theme: 'minimal',
        card_position: 'bottom-left',
        auto_frigate_mask: true,
      });

      /** @type {string[]} */
      const warnings = [];
      const origWarn = log.warn;
      const origFetch = global.fetch;
      log.warn = (scope, ...args) => {
        warnings.push((typeof scope === 'object' && scope ? scope.getName() : String(scope)) + ': ' + args.join(' '));
      };

      let includeCamera = false;
      try {
        global.fetch = /** @type {*} */ (
          async (url) => {
            if (String(url).endsWith('/api/config')) {
              return {
                ok: true,
                status: 200,
                async json() {
                  return includeCamera
                    ? {cameras: {unmapped_bridge_cam: {motion: {mask: {}}, objects: {mask: {}}}}}
                    : {cameras: {different_frigate_cam: {motion: {mask: {}}, objects: {mask: {}}}}};
                },
              };
            }
            return {
              ok: true,
              status: 200,
              async text() {
                return '';
              },
            };
          }
        );

        // 1. Missing camera warns once across repeated 60s mask sync passes
        await syncFrigateMotionMasks([cam], {
          forceResync: false,
          shuttingDown: false,
          frigateUrl: 'http://127.0.0.1:5000',
        });
        await syncFrigateMotionMasks([cam], {
          forceResync: false,
          shuttingDown: false,
          frigateUrl: 'http://127.0.0.1:5000',
        });
        assert.equal(warnings.filter((w) => w.includes('unmapped_bridge_cam')).length, 1);

        // 2. Camera appears in Frigate /api/config -> clears missing warning state and applies masks
        includeCamera = true;
        await syncFrigateMotionMasks([cam], {
          forceResync: false,
          shuttingDown: false,
          frigateUrl: 'http://127.0.0.1:5000',
        });
        assert.equal(cam.hasSyncedMaskPolygon(), true);

        // 3. If camera is later removed from Frigate config again, warns once for the new episode
        includeCamera = false;
        await syncFrigateMotionMasks([cam], {
          forceResync: false,
          shuttingDown: false,
          frigateUrl: 'http://127.0.0.1:5000',
        });
        assert.equal(warnings.filter((w) => w.includes('unmapped_bridge_cam')).length, 2);
      } finally {
        log.warn = origWarn;
        global.fetch = origFetch;
      }
    }
  );
});
