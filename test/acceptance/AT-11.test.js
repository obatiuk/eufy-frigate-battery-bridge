/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-11`: Mid-Stream Hold Extensions Across All Modes & Signal Sources
 * (docs/acceptance/AT-11.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-11.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {onEvent, wakeCameraExternal, stop} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-11 (docs/acceptance/AT-11.md)', () => {
  it(
    'AT-11: Extends active live streams across all modes (including "backfill" cameras streaming Live View ' +
      'or /api/wake) on new triggers, /api/wake, mid-stream stream-started events, and active Frigate/Eufy ' +
      'detections up to configured stream_max_secs',
    async () => {
      const garageBf = new Camera({
        serial: 'T8161T0000000014',
        name: 'garage_bf',
        mode: 'backfill',
        hold_secs: 30,
        stream_max_secs: 90,
        station_serial: 'T8030P0000000001',
      });
      garageBf.setRtspSupported(true);
      await setupAcceptanceHarness([garageBf]);

      // Start an active live RTSP stream on the "backfill" camera (e.g. via /api/wake or Live View)
      const t0 = Date.now() - 20000;
      garageBf.beginSession('rtsp', t0, true);
      garageBf.setGotVideo(true);
      garageBf.setFirstFrameAt(t0 + 1000);
      garageBf.setFirstVideoAt(t0 + 1000);
      garageBf.setLastStartAt(t0);
      garageBf.setMotionUntil(t0 + 30000);

      // 1. Eufy motion/person trigger arriving while the "backfill" camera is ALREADY streaming live
      //    must extend the live hold!
      const holdBeforeTrigger = garageBf.getMotionUntil();
      onEvent({
        source: 'device',
        event: 'person detected',
        serialNumber: garageBf.getSerial(),
        state: true,
      });
      assert.ok(
        garageBf.getMotionUntil() > holdBeforeTrigger,
        'AT-11: Motion/person trigger arriving while a "backfill" camera is already streaming live must ' +
          'extend the active stream'
      );
      assert.equal(garageBf.isEventActive(), true);

      // 2. Mid-stream "rtsp livestream started" re-trigger (>5s after lastStartAt) extends the active RTSP stream
      const nowRetrigger = Date.now();
      garageBf.setMotionUntil(nowRetrigger + 15000);
      garageBf.setLastStartAt(nowRetrigger - 10000);
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: garageBf.getSerial(),
      });
      assert.ok(
        garageBf.getMotionUntil() >= nowRetrigger + 30000,
        'AT-11: Mid-stream "rtsp livestream started" must extend the active RTSP hold'
      );

      // 3. POST /api/wake on an already-active stream extends hold, clamped to configured max_secs (90s from startedAt)
      const wakeExt = wakeCameraExternal(garageBf, {
        durationMs: 500000,
        reason: 'extend-api',
        createEvent: true,
      });
      assert.equal(wakeExt.status, 'extended');
      assert.equal(
        garageBf.getMotionUntil(),
        garageBf.getSessionStartedAt() + 90000,
        'AT-11: Hold extensions must clamp to the camera configured max_secs (90s)'
      );
      stop(garageBf, 'test stop', false, 'bridge-test');
      if (garageBf.getFrigateEventTimer()) {
        clearTimeout(garageBf.getFrigateEventTimer());
        garageBf.setFrigateEventTimer(null);
      }
    }
  );
});
