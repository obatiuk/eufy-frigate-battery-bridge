/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-08`: Post-Sleep `3s` Guard, Idle Wedged `P2P` Radio Recovery & Service
 * Disruption Resilience (docs/acceptance/AT-08.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-08.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {buildHealthPayload} = require('../../src/services/http-server');
const {onEvent} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-08 (docs/acceptance/AT-08.md)', () => {
  it(
    'AT-08: Enforces 3s post-sleep guard, sends only device.stop_livestream for wedged idle radios, ' +
      'and handles service disruptions cleanly',
    async () => {
      const cam = new Camera({
        serial: 'T8214T0000000010',
        name: 'doorbell',
        mode: 'p2p',
        station_serial: 'T8030P0000000010',
      });
      const {sentCommands, wsInstance} = await setupAcceptanceHarness([cam]);

      const t0 = Date.now();
      cam.beginSession('p2p', t0 - 20000, true);
      cam.setGotVideo(true);
      cam.terminateSession(t0 - 500, 'hold expired', false, 'bridge-timer');
      cam.clearP2pStopInFlight();
      sentCommands.length = 0;

      // 1. Within 3s post-sleep window: trailing video data or livestream started is ignored
      assert.equal(cam.canAdoptExternalWake(t0, 3000), false);
      onEvent({
        event: 'livestream video data',
        serialNumber: cam.getSerial(),
        buffer: {data: [0, 0, 0, 1, 0x65]},
      });
      assert.equal(cam.isSessionActive(), false);
      assert.equal(sentCommands.includes('device.stop_livestream'), false);

      // 2. Past 3s post-sleep window: unsolicited video data sends device.stop_livestream without adopting a wake
      cam.setSleptAt(t0 - 5000);
      cam.setLastStoppedAt(t0 - 5000);
      cam.unsolicitedStopAt = 0;
      onEvent({
        event: 'livestream video data',
        serialNumber: cam.getSerial(),
        buffer: {data: [0, 0, 0, 1, 0x65]},
      });
      assert.equal(cam.isSessionActive(), false);
      assert.equal(sentCommands.includes('device.stop_livestream'), true);

      // 3. 4 idle wifiRssi changes > 15s after sleep sends only device.stop_livestream (never station.disconnect)
      sentCommands.length = 0;
      cam.setSleptAt(t0 - 30000);
      cam.setLastStoppedAt(t0 - 30000);
      cam.setLastWedgedRadioStopAt(0);
      for (const rssi of [-65, -66, -65, -66]) {
        onEvent({
          event: 'property changed',
          serialNumber: cam.getSerial(),
          name: 'wifiRssi',
          value: rssi,
        });
      }
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sentCommands.includes('device.stop_livestream'), true);
      assert.equal(sentCommands.includes('station.disconnect'), false);
      assert.equal(sentCommands.includes('device.cancel_download'), false);

      // 4. Service disruption resilience: ws_closed terminates active sessions, keeps /healthz strictly {ok: true}
      //    (omitting ws_connected and all external service fields) during external outages, returns {ok: false} only
      //    on shutdown, and marks camera serviceDisrupted until reconnected
      cam.beginSession('p2p', t0, true);
      assert.equal(cam.isSessionActive(), true);
      wsInstance.handlers.get('close')();
      assert.equal(cam.isSessionActive(), false);
      const degradedHealth = buildHealthPayload(false);
      assert.deepEqual(degradedHealth, {ok: true});
      assert.equal('ws_connected' in degradedHealth, false);
      assert.deepEqual(buildHealthPayload(true), {ok: false});
      assert.equal(cam.hasServiceDisruption(), true);
      cam.updateServiceHealth({wsConnected: true});
      assert.equal(cam.hasServiceDisruption(), false);
    }
  );
});
