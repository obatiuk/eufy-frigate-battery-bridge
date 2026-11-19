/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-01`: `"backfill"` Mode on `RTSP`-Capable Cameras - Motion, `/api/wake` &
 * Hardware Events While `IDLE` (docs/acceptance/AT-01.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-01.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {selectEncoderFrame} = require('../../src/media/encoder');
const {applyDeviceProperties} = require('../../src/services/eufy-client');
const {onEvent} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-01 (docs/acceptance/AT-01.md)', () => {
  it(
    'AT-01: "backfill" mode on RTSP-capable camera (T8161) never wakes live on Eufy motion or idle ' +
      '"rtsp livestream started" (showing Yellow Waiting), and piggybacks on standalone Eufy app ' +
      '"livestream started"',
    async () => {
      const garageRtspBf = new Camera(
        {
          serial: 'T8161T0000000001',
          name: 'garage',
          mode: 'backfill',
          station_serial: 'T8030P0000000001',
        },
        {frame: Buffer.alloc(1382400, 0x22), lastSeen: '12:00'},
        renderCameraCards
      );
      const {sentCommands, setPropCalls} = await setupAcceptanceHarness([garageRtspBf]);

      applyDeviceProperties(
        garageRtspBf,
        {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: true},
          battery: {value: 90},
          state: {value: 1},
        },
        false
      );
      await new Promise((r) => setTimeout(r, 20));
      sentCommands.length = 0;
      setPropCalls.length = 0;

      // 1. Eufy motion/person trigger events queue BackfillJob, keep camera IDLE, and select Yellow Waiting (card.busy)
      onEvent({
        source: 'device',
        event: 'motion detected',
        serialNumber: garageRtspBf.getSerial(),
        state: true,
      });
      onEvent({
        source: 'device',
        event: 'person detected',
        serialNumber: garageRtspBf.getSerial(),
        state: true,
      });

      assert.equal(garageRtspBf.getStoredSessionState(), 'idle');
      assert.equal(garageRtspBf.isSessionActive(), false);
      assert.equal(garageRtspBf.hasPendingBackfill(), true);
      assert.equal(
        selectEncoderFrame(garageRtspBf, Date.now()).frame,
        garageRtspBf.getBusyCardBuffer(),
        'AT-01: IDLE camera with pending BackfillJob must select Yellow Waiting (card.busy) frame'
      );
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), false);
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      // 2. Hardware "rtsp livestream started" while IDLE never adopts a live stream,
      //    never stops RTSP or disables rtspStream, and queues/extends the BackfillJob window
      garageRtspBf.clearPendingBackfill();
      garageRtspBf.clearActiveTriggerEvents();
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(garageRtspBf.getStoredSessionState(), 'idle');
      assert.equal(garageRtspBf.isSessionActive(), false);
      assert.equal(garageRtspBf.isRtspCapable(), true);
      assert.equal(
        garageRtspBf.hasPendingBackfill(),
        true,
        'AT-01: "rtsp livestream started" while IDLE in backfill mode must queue/extend BackfillJob'
      );
      assert.equal(sentCommands.includes('device.stop_rtsp_livestream'), false);
      assert.equal(setPropCalls.includes('rtspStream=false'), false);

      onEvent({
        source: 'device',
        event: 'rtsp livestream stopped',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(
        garageRtspBf.isBackfillRecordingCleared(),
        true,
        'AT-01: "rtsp livestream stopped" must mark the backfill trigger cleared so settling begins'
      );

      // 3. Standalone "livestream started" with no active trigger/backfill (Eufy mobile app) piggybacks on P2P
      //    without sending start_livestream and stops immediately on "livestream stopped"
      garageRtspBf.clearPendingBackfill();
      garageRtspBf.clearActiveTriggerEvents();
      sentCommands.length = 0;
      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(garageRtspBf.getStoredSessionState(), 'waking_p2p');
      assert.equal(garageRtspBf.getActiveMode(), 'p2p');
      assert.equal(garageRtspBf.isP2pReady(), true);
      assert.equal(sentCommands.includes('device.start_livestream'), false);
      assert.equal(sentCommands.includes('device.start_rtsp_livestream'), false);

      onEvent({
        source: 'device',
        event: 'livestream stopped',
        serialNumber: garageRtspBf.getSerial(),
      });
      assert.equal(
        garageRtspBf.isSessionActive(),
        false,
        'AT-01: Piggybacked Eufy app stream in backfill mode must stop immediately on "livestream stopped"'
      );

      // 4. Stale hardware trigger without state=false expires after 130s or station/WS disconnect
      const tStale = 500000;
      garageRtspBf.setLastMotionAt(tStale);
      garageRtspBf.setMotionClearedAt(0);
      garageRtspBf.queueEventBackfill(tStale, 'motion detected', '', 'motion detected', 10, true);
      garageRtspBf.setPendingBackfillJob(null);
      assert.equal(
        garageRtspBf.shouldBackfillOnlyOnApiWake(tStale + 130000),
        true,
        'AT-01: Unexpired hardware trigger (<= 130s) keeps /api/wake in backfill-only mode'
      );
      assert.equal(
        garageRtspBf.shouldBackfillOnlyOnApiWake(tStale + 130001),
        false,
        'AT-01: Stale hardware trigger (> 130s without state=false) expires so /api/wake is not stuck in backfill'
      );
      garageRtspBf.setLastMotionAt(tStale + 200000);
      garageRtspBf.queueEventBackfill(tStale + 200000, 'person detected', '', 'person detected', 200, true);
      garageRtspBf.setPendingBackfillJob(null);
      garageRtspBf.handleStationDisconnected('ws_closed');
      assert.equal(
        garageRtspBf.shouldBackfillOnlyOnApiWake(tStale + 201000),
        false,
        'AT-01: Station/WebSocket disconnect clears active hardware triggers'
      );
    }
  );
});
