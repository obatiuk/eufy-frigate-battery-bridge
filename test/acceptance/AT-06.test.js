/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-06`: Per-Station `P2P` Arbitration vs. Parallel `RTSP` Independence
 * (docs/acceptance/AT-06.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-06.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');

describe('Locked Acceptance Criterion AT-06 (docs/acceptance/AT-06.md)', () => {
  it('AT-06: RTSP sessions run in parallel without blocking P2P backfill downloads on the same HomeBase', () => {
    const rtspCam1 = new Camera({
      serial: 'T8161T0000000006',
      name: 'storage',
      mode: 'rtsp',
      station_serial: 'T8030P0000000001',
    });
    rtspCam1.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');
    const rtspCam2 = new Camera({
      serial: 'T8161T0000000007',
      name: 'garage',
      mode: 'backfill',
      station_serial: 'T8030P0000000001',
    });
    rtspCam2.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live1');
    const doorbellBf = new Camera({
      serial: 'T8214T0000000008',
      name: 'doorbell',
      mode: 'backfill',
      station_serial: 'T8030P0000000001',
    });

    const now = 100000;
    rtspCam1.beginSession('rtsp', now, true);
    rtspCam2.beginSession('rtsp', now, false);
    assert.equal(rtspCam1.usesP2pSlot(), false);
    assert.equal(rtspCam2.usesP2pSlot(), false);

    assert.equal(
      doorbellBf.isStationIdleForBackfill([rtspCam1, rtspCam2, doorbellBf], now + 10000, 5000),
      true,
      'Active RTSP sessions must never block P2P backfill downloads on the same HomeBase'
    );
  });
});
