/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 5. Center Overlay False Motion & Black Screens on Rapid Camera Switching
 * (docs/regression/05-center-overlay-false-motion-black-screens-on.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');

describe('Regression 5. Center Overlay False Motion & Black Screens on Rapid Camera Switching', () => {
  it(
    'Regression 5: omits Frigate masks on centered cards, preserves viewer cooldown across card rebuilds, ' +
      'and triggers keyframe bursts on viewer attach',
    () => {
      // Regression: centered cards blinded center-frame motion if masked, card rebuilds reset sleptAt causing false
      // cooldowns on rapid switching, and new viewers needed immediate keyframe bursts.
      const centerCam = new Camera({
        serial: 'T8161T0000050001',
        card_theme: 'glance',
        card_position: 'center',
      });
      const cornerCam = new Camera({
        serial: 'T8161T0000050002',
        card_theme: 'glance',
        card_position: 'bottom-left',
      });

      assert.equal(centerCam.computeMaskPolygon(), '');
      assert.equal(cornerCam.computeMaskPolygon().split(',').length, 8);

      cornerCam.beginSession('rtsp', 10000, false);
      cornerCam.endSession(20000, true, false, 'rtsp');
      assert.equal(cornerCam.isInViewerCooldown(21000, 5000), true);
      cornerCam.applyTelemetryProperties({battery: 75, wifiRssi: -62}, false, 24000);
      assert.equal(cornerCam.isInViewerCooldown(26000, 5000), false);

      cornerCam.registerNewViewer('viewer-1', 30000);
      cornerCam.triggerKeyframeBurst(30000);
      assert.equal(cornerCam.isInKeyframeBurst(30500), true);
    }
  );
});
