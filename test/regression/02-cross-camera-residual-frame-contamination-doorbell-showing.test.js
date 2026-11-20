/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 2. Cross-Camera Residual Frame Contamination (Doorbell Showing Another Camera's
 * View) (docs/regression/02-cross-camera-residual-frame-contamination-doorbell-showing.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {CACHE_DIR, FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {getCacheFilePath} = require('../../src/overlay/snapshot-cache');
const {selectEncoderFrame} = require('../../src/media/encoder');
const {applyDeviceProperties} = require('../../src/services/eufy-client');

installDefaultFetchStub();

describe("Regression 2. Cross-Camera Residual Frame Contamination (Doorbell Showing Another Camera's View)", () => {
  it(
    'Regression 2: ignores Eufy station-cached properties.picture, isolates cache filenames by name and serial, ' +
      'and holds lastFrame during active sessions once video has arrived',
    () => {
      // Regression: HomeBase caches notification thumbnails across cameras on properties.picture, and mid-session
      // re-wakes flashed "Waking Up..." when frame temporarily cleared after gotVideo became true.
      const doorbell = new Camera({serial: 'T8214T0000000001', name: 'doorbell', mode: 'p2p'});
      const driveway = new Camera({serial: 'T8161T0000000002', name: 'driveway', mode: 'rtsp'});
      const snapAt = new Date(2026, 10, 19, 12, 0, 0);

      assert.equal(
        getCacheFilePath(doorbell, snapAt),
        path.join(CACHE_DIR, 'doorbell_T8214T0000000001_snapshot_2026-11-19_12-00-00.jpg')
      );
      assert.equal(
        getCacheFilePath(driveway, snapAt),
        path.join(CACHE_DIR, 'driveway_T8161T0000000002_snapshot_2026-11-19_12-00-00.jpg')
      );
      assert.equal(doorbell.getLastFrameBuffer(), null);

      applyDeviceProperties(
        doorbell,
        {
          battery: {value: 92},
          picture: {value: {data: [0xff, 0xd8, 0xff, 0xd9], type: {ext: 'jpg'}}},
        },
        false
      );
      assert.equal(doorbell.getLastFrameBuffer(), null);

      const cleanSnapshot = Buffer.alloc(FRAME, 0x42);
      const liveFrame = Buffer.alloc(FRAME, 0x55);
      doorbell.beginSession('rtsp', 10000, false);
      doorbell.markP2pVideoPacketReceived(10800);
      doorbell.recordDecodedFrame(liveFrame, cleanSnapshot, 11000, '12:00');
      assert.equal(doorbell.getLastFrameBuffer() === cleanSnapshot, true);

      // Simulate mid-session re-wake holding lastFrame once gotVideo is true and frame ages out
      doorbell.beginRtspRewake(18000);
      const selected = selectEncoderFrame(doorbell, 18000);
      assert.equal(selected.frame === cleanSnapshot, true);
      assert.equal(selected.isLive, true);
    }
  );
});
