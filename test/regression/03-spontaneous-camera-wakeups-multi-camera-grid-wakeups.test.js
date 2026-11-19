/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 3. Spontaneous Camera Wakeups, Multi-Camera Grid Wakeups & Decoder Resets
 * (docs/regression/03-spontaneous-camera-wakeups-multi-camera-grid-wakeups.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {pollViewers} = require('../../src/services/frigate-client');

installDefaultFetchStub();

describe('Regression 3. Spontaneous Camera Wakeups, Multi-Camera Grid Wakeups & Decoder Resets', () => {
  it(
    'Regression 3: ignores FFmpeg Frigate recorders on bridge IPs, skips multi-camera dashboard grids, ' +
      'and avoids decoder restarts on resolution-only shifts',
    async () => {
      // Regression: recorder clients on Docker bridge IPs and simultaneous dashboard grid MSE attaches woke sleeping
      // cameras, while mid-session P2P resolution shifts restarted FFmpeg and froze video.
      const camA = new Camera({serial: 'T8161T0000030001', name: 'grid_a', mode: 'rtsp'});
      const camB = new Camera({serial: 'T8161T0000030002', name: 'grid_b', mode: 'rtsp'});
      const woken = [];
      const origFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            grid_a: {
              consumers: [
                {id: 'rec-bridge', user_agent: 'FFmpeg Frigate', remote_addr: '172.18.0.5:51000'},
                {id: 'mse-a', user_agent: 'Mozilla/5.0', format_name: 'mse'},
              ],
            },
            grid_b: {
              consumers: [{id: 'mse-b', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
            },
          };
        },
      });
      try {
        await pollViewers([camA, camB], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: (c) => woken.push(c.getName()),
        });
      } finally {
        global.fetch = origFetch;
      }
      assert.deepEqual(woken, []);

      camA.beginSession('p2p', 10000, false);
      camA.attachDecoder({pid: 101});
      camA.updateStreamFormat('H264', 3840, 2160);
      assert.equal(camA.hasResolutionChanged(2304, 1296), true);
      assert.equal(camA.hasCodecChanged('H264'), false);
      assert.equal(camA.hasCodecChanged('H265'), true);
      camA.detachDecoder();
    }
  );
});
