/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for StatusCard configuration keys, corner bounding boxes, and Frigate polygon masks
 * (src/domain/status-card.js).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {Camera} = require('../../src/domain/camera');
const {StatusCard} = require('../../src/domain/status-card');

describe('StatusCard configuration keys', () => {
  it('reads the resolved camelCase keys', () => {
    // Verify: reads the resolved camelCase keys.
    const card = new StatusCard({autoFrigateMask: false, cardShowOnLive: false});
    assert.equal(card.autoFrigateMask, false);
    assert.equal(card.showOnLive, false);
  });

  it('ignores raw snake_case config.yaml keys because the camera resolves them before building the card', () => {
    // Verify: only resolveCameraConfig() output reaches StatusCard, so a snake_case fallback is dead code.
    const card = new StatusCard({auto_frigate_mask: false, card_show_on_live: false});
    assert.equal(card.autoFrigateMask, true);
    assert.equal(card.showOnLive, true);
  });
});

describe('StatusCard Bounding Boxes & Frigate Polygon Masks', () => {
  it(
    'computes corner bounding boxes and worst-case invariant Frigate polygon masks across glance, minimal, ' +
      'pebbles, and hud themes',
    () => {
      // Verify: computes corner bounding boxes and worst-case invariant Frigate polygon masks across glance, minimal,
      // pebbles, and hud themes.
      const glanceCam = new Camera({serial: 'T8161T0000000000', card_theme: 'glance', card_position: 'top-left'});
      const pebblesCam = new Camera({serial: 'T8161T0101010101', card_theme: 'pebbles', card_position: 'bottom-left'});
      const minimalCam = new Camera({
        serial: 'T8161T1111111111',
        title: 'Front Patio',
        card_theme: 'minimal',
        card_position: 'bottom-right',
      });
      const centerCam = new Camera({serial: 'T8161T2222222222', card_theme: 'glance', card_position: 'center'});

      assert.equal(glanceCam.shouldOverlayCardOnLive(), true);
      assert.equal(pebblesCam.shouldOverlayCardOnLive(), true);
      assert.equal(minimalCam.shouldOverlayCardOnLive(), true);
      assert.equal(centerCam.shouldOverlayCardOnLive(), false);

      // Verify worst-case Frigate mask invariance when chargingStatus toggles Solar <-> Unplugged or lastSeen arrives
      const glancePolyInitial = glanceCam.computeMaskPolygon();
      const pebblesPolyInitial = pebblesCam.computeMaskPolygon();
      const minimalPolyInitial = minimalCam.computeMaskPolygon();
      assert.match(glancePolyInitial, /^0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3},0\.\d{3}$/);

      for (const c of [glanceCam, pebblesCam, minimalCam]) {
        c.applyTelemetryProperties({battery: 85, chargingStatus: 4, wifiRssi: -61, batteryTemperature: 23}, false);
        c.updateLastSeen('14:30');
      }
      assert.equal(
        glanceCam.computeMaskPolygon(),
        glancePolyInitial,
        'Glance mask polygon must remain invariant across Solar and lastSeen telemetry changes'
      );
      assert.equal(
        pebblesCam.computeMaskPolygon(),
        pebblesPolyInitial,
        'Pebbles mask polygon must remain invariant across Solar and lastSeen telemetry changes'
      );
      assert.equal(
        minimalCam.computeMaskPolygon(),
        minimalPolyInitial,
        'Minimal corner mask polygon must remain invariant across Solar and lastSeen telemetry changes'
      );

      for (const c of [glanceCam, pebblesCam, minimalCam]) {
        c.applyTelemetryProperties({battery: 84, chargingStatus: 2}, false);
      }
      assert.equal(glanceCam.computeMaskPolygon(), glancePolyInitial);
      assert.equal(pebblesCam.computeMaskPolygon(), pebblesPolyInitial);
      assert.equal(minimalCam.computeMaskPolygon(), minimalPolyInitial);

      const glanceBounds = glanceCam.getCardBounds();
      assert.deepEqual(
        glanceBounds,
        {boxX: 24, boxY: 24, boxW: 138, boxH: 44},
        'Default Glance card (Status + merged Battery + Wi-Fi, with temperature and last_seen false by default) ' +
          'must be 138x44'
      );
      const pebblesBounds = pebblesCam.getCardBounds();
      assert.deepEqual(
        pebblesBounds,
        {boxX: 24, boxY: 652, boxW: 148, boxH: 44},
        'Default Pebbles card (three 44x44 circles for Status, merged Battery, and Wi-Fi + two 8px gaps) must be 148x44'
      );
      assert.equal(centerCam.computeMaskPolygon(), '');
    }
  );
});
