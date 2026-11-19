/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 8. Duplicate Startup Mask Sync & Post-Viewer Linger `RTSP` Re-Wake Loops
 * (docs/regression/08-duplicate-startup-mask-sync-post-viewer-linger.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {syncFrigateMotionMasks} = require('../../src/services/frigate-client');

installDefaultFetchStub();

describe('Regression 8. Duplicate Startup Mask Sync & Post-Viewer Linger `RTSP` Re-Wake Loops', () => {
  it(
    'Regression 8: syncs missing objects.mask independently of motion.mask, stops post-linger RTSP drops, ' +
      'and yields lingering P2P streams to sibling viewers',
    async () => {
      // Regression: Frigate omits objects.mask when only motion.mask is set, 0-viewer post-linger RTSP drops looped,
      // and 0-viewer lingering P2P streams contended with newly opened sibling P2P cameras.
      const maskCam = new Camera({
        serial: 'T8161T0000080001',
        name: 'mask_indep_cam',
        mode: 'rtsp',
        auto_frigate_mask: true,
        card_theme: 'glance',
        card_position: 'bottom-left',
      });
      const poly = maskCam.computeMaskPolygon();
      const putBodies = [];
      const origFetch = global.fetch;
      global.fetch = async (_url, opts = {}) => {
        if (opts.method === 'PUT') {
          putBodies.push(JSON.parse(String(opts.body)));
          return {
            ok: true,
            status: 200,
            async text() {
              return '';
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              cameras: {
                mask_indep_cam: {
                  motion: {mask: {eufy_bridge_card: {coordinates: poly}}},
                  objects: {},
                },
              },
            };
          },
        };
      };
      try {
        await syncFrigateMotionMasks([maskCam]);
      } finally {
        global.fetch = origFetch;
      }
      assert.equal(putBodies.length, 1);
      assert.ok(putBodies[0].config_data.cameras.mask_indep_cam.objects.mask.eufy_bridge_card);
      assert.equal(putBodies[0].config_data.cameras.mask_indep_cam.motion, undefined);

      const t0 = 50000;
      maskCam.applyViewTrigger(t0, 'viewer open', 20000, 'viewer');
      maskCam.beginSession('rtsp', t0, false);
      assert.equal(maskCam.shouldRewakeRtspOnDrop(t0 + 5000), false);

      const p2pA = new Camera({
        serial: 'T8214T0000080002',
        name: 'p2p_a',
        mode: 'p2p',
        station_serial: 'T8030P0000080000',
      });
      const p2pB = new Camera({
        serial: 'T8214T0000080003',
        name: 'p2p_b',
        mode: 'p2p',
        station_serial: 'T8030P0000080000',
      });
      p2pA.applyViewTrigger(t0, 'viewer open', 20000, 'viewer');
      p2pA.beginSession('p2p', t0, false);
      assert.equal(p2pA.shouldYieldToNewStationViewer(p2pB, t0 + 5000), true);
      assert.equal(maskCam.shouldYieldToNewStationViewer(p2pB, t0 + 5000), false);
    }
  );
});
