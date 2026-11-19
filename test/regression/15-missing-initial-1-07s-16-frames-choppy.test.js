/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 15. Missing Initial Backfill Frames, Choppy Audio & Clip Gaps
 * (docs/regression/15-missing-initial-1-07s-16-frames-choppy.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');

describe('Regression 15. Missing Initial Backfill Frames, Choppy Audio & Clip Gaps', () => {
  it(
    'Regression 15: enables rtspStream=true on startup in "rtsp" and RTSP-capable "backfill" modes, and ignores ' +
      'rtspStreamUrl in "p2p" mode',
    () => {
      // Regression 15: enables rtspStream=true on startup in "rtsp" and RTSP-capable "backfill" modes, and ignores
      // rtspStreamUrl in "p2p" mode.
      const rtspCam = new Camera({serial: 'T8161T0000000000', mode: 'rtsp'});
      const p2pCam = new Camera({serial: 'T8161T1111111111', mode: 'p2p'});
      const backfillRtspCam = new Camera({serial: 'T8161T3333333333', mode: 'backfill'});
      const backfillDoorbell = new Camera({serial: 'T8214T2222222222', mode: 'backfill'});

      assert.equal(rtspCam.shouldEnableRtspProperty(false), true);
      assert.equal(rtspCam.shouldEnableRtspProperty(false), false, 'Only checks rtspStream once per session');
      assert.equal(rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live0'), true);
      assert.equal(rtspCam.isRtspCapable(), true);

      assert.equal(p2pCam.shouldEnableRtspProperty(false), false);
      assert.equal(p2pCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live1'), false);
      assert.equal(p2pCam.isRtspCapable(), false);
      assert.equal(p2pCam.getStationSerial(), 'T8030T0000000000');

      assert.equal(backfillRtspCam.shouldEnableRtspProperty(false), true);
      assert.equal(
        backfillRtspCam.isRtspCapable(),
        true,
        'RTSP-capable camera in backfill mode must be RTSP-capable immediately when rtspStream boolean ' +
          'is present even before rtspStreamUrl is populated'
      );
      backfillRtspCam.setViewUntil(Date.now() + 20000);
      assert.equal(
        backfillRtspCam.wantsRtspWake(Date.now()),
        true,
        'Opening Live View on an RTSP-capable backfill camera must wake via RTSP, never P2P'
      );
      backfillRtspCam.setViewUntil(0);
      assert.equal(backfillRtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://192.168.1.50/live2'), true);
      assert.equal(backfillRtspCam.isRtspCapable(), true);
      assert.equal(backfillRtspCam.shouldBackfillOnlyOnEvent(), true);

      assert.equal(backfillDoorbell.shouldEnableRtspProperty(undefined), false);
      assert.equal(backfillDoorbell.updateDiscoveredRtspConfig('T8030T0000000000', ''), false);
      assert.equal(backfillDoorbell.isRtspCapable(), false);

      // Regression: cameras in "backfill" mode never adopt external RTSP wakes or trigger-paired P2P wakes,
      // but can piggyback on standalone P2P wakes when no trigger/backfill is active (AT-01, AT-02, AT-05)
      const checkNow = Date.now() + 60000;
      assert.equal(backfillRtspCam.adoptExternalRtspWake(checkNow, 3000), false);
      assert.equal(backfillRtspCam.canAdoptExternalWake(checkNow, 3000), true);
      assert.equal(backfillDoorbell.canAdoptExternalWake(checkNow, 3000), true);
      backfillRtspCam.queueEventBackfill(checkNow, 'motion detected', '', 'motion detected', 50, true);
      backfillDoorbell.queueEventBackfill(checkNow, 'rings', '', 'rings', 100, true);
      assert.equal(backfillRtspCam.canAdoptExternalWake(checkNow, 3000), false);
      assert.equal(backfillDoorbell.canAdoptExternalWake(checkNow, 3000), false);
      backfillRtspCam.clearPendingBackfill();
      backfillDoorbell.clearPendingBackfill();
      assert.equal(rtspCam.canAdoptExternalWake(checkNow, 3000), true);
      assert.equal(p2pCam.canAdoptExternalWake(checkNow, 3000), true);

      // Regression: RTSP-capable camera in "backfill" mode emitting "rtsp livestream started" while IDLE
      // recording to HomeBase must not stop RTSP or disable rtspStream
      assert.deepEqual(backfillRtspCam.evaluateUnexpectedRtspStart(), {
        shouldStopRtsp: false,
        shouldDisableRtspProp: false,
        shouldRestartP2p: false,
      });
      assert.equal(backfillRtspCam.isRtspCapable(), true);
    }
  );
});
