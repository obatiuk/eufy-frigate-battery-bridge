/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-02`: `"backfill"` Mode on `P2P`-Only Cameras & Doorbells - Motion, `/api/wake` &
 * Hardware Events While `IDLE` (docs/acceptance/AT-02.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-02.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {selectEncoderFrame} = require('../../src/media/encoder');
const {onEvent} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-02 (docs/acceptance/AT-02.md)', () => {
  it(
    'AT-02: "backfill" mode on P2P camera/doorbell (T8214) never wakes live on motion/ring or trigger-paired ' +
      '"livestream started" (showing Yellow Waiting), and piggybacks on standalone Eufy app "livestream started"',
    async () => {
      const doorbellBf = new Camera(
        {
          serial: 'T8214T0000000002',
          name: 'doorbell',
          mode: 'backfill',
          station_serial: 'T8030P0000000001',
        },
        {frame: Buffer.alloc(1382400, 0x22), lastSeen: '12:00'},
        renderCameraCards
      );
      const {sentCommands} = await setupAcceptanceHarness([doorbellBf]);

      // 1. Trigger event + paired "livestream started" queues/extends BackfillJob, stays IDLE,
      //    and selects Yellow Waiting (card.busy)
      onEvent({
        source: 'device',
        event: 'rings',
        serialNumber: doorbellBf.getSerial(),
        state: true,
      });
      assert.equal(doorbellBf.getStoredSessionState(), 'idle');
      assert.equal(doorbellBf.isSessionActive(), false);
      assert.equal(doorbellBf.hasPendingBackfill(), true);
      assert.equal(
        selectEncoderFrame(doorbellBf, Date.now()).frame,
        doorbellBf.getBusyCardBuffer(),
        'AT-02: IDLE doorbell with pending BackfillJob must select Yellow Waiting (card.busy) frame'
      );
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(doorbellBf.getStoredSessionState(), 'idle');
      assert.equal(doorbellBf.isSessionActive(), false);
      assert.equal(
        doorbellBf.hasPendingBackfill(),
        true,
        'AT-02: Trigger-paired "livestream started" while IDLE in backfill mode must queue/extend BackfillJob'
      );

      onEvent({
        source: 'device',
        event: 'rings',
        serialNumber: doorbellBf.getSerial(),
        state: false,
      });
      onEvent({
        source: 'device',
        event: 'livestream stopped',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(
        doorbellBf.isBackfillRecordingCleared(),
        true,
        'AT-02: "livestream stopped" must mark the backfill trigger cleared so settling begins'
      );

      // 2. Standalone "livestream started" with no active trigger/backfill (Eufy mobile app) piggybacks on P2P
      //    and stops immediately on "livestream stopped"
      doorbellBf.clearPendingBackfill();
      doorbellBf.clearActiveTriggerEvents();
      sentCommands.length = 0;
      onEvent({
        source: 'device',
        event: 'livestream started',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(doorbellBf.getStoredSessionState(), 'waking_p2p');
      assert.equal(doorbellBf.getActiveMode(), 'p2p');
      assert.equal(doorbellBf.isP2pReady(), true);
      assert.equal(sentCommands.includes('device.start_livestream'), false);

      onEvent({
        source: 'device',
        event: 'livestream stopped',
        serialNumber: doorbellBf.getSerial(),
      });
      assert.equal(
        doorbellBf.isSessionActive(),
        false,
        'AT-02: Piggybacked Eufy app stream on doorbell in backfill mode must stop immediately on "livestream stopped"'
      );

      // 3. Stale hardware trigger without state=false expires after 130s or device offline transition
      const tStale = 600000;
      doorbellBf.setLastMotionAt(tStale);
      doorbellBf.setMotionClearedAt(0);
      doorbellBf.queueEventBackfill(tStale, 'rings', '', 'rings', 1000, true);
      doorbellBf.setPendingBackfillJob(null);
      assert.equal(doorbellBf.shouldBackfillOnlyOnApiWake(tStale + 130000), true);
      assert.equal(doorbellBf.shouldBackfillOnlyOnApiWake(tStale + 130001), false);
      doorbellBf.setLastMotionAt(tStale + 200000);
      doorbellBf.queueEventBackfill(tStale + 200000, 'rings', '', 'rings', 1000, true);
      doorbellBf.setPendingBackfillJob(null);
      doorbellBf.applyTelemetryProperties({state: 3, battery: 2, chargingStatus: 2, wifiRssi: -100}, false);
      assert.equal(
        doorbellBf.shouldBackfillOnlyOnApiWake(tStale + 201000),
        false,
        'AT-02: Device offline transition clears active hardware triggers'
      );
    }
  );
});
