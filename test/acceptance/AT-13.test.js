/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-13`: Per-Station `P2P` Priority Preemption, Preempted Event Backfill & Instant
 * Back-to-Back Switching (docs/acceptance/AT-13.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-13.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {setupAcceptanceHarness} = require('../helpers/acceptance-harness');
const {Camera, WakeRequest} = require('../../src/domain/camera');
const {configureEufyClientHooks} = require('../../src/services/eufy-client');
const {wakeCameraExternal, stop, trigger, onEvent} = require('../../src/services/stream-orchestrator');

describe('Locked Acceptance Criterion AT-13 (docs/acceptance/AT-13.md)', () => {
  it(
    'AT-13: Enforces per-station P2P priority preemption, backfills preempted event streams even if >= 20% ' +
      'of hold was streamed live, and switches back-to-back same-station P2P sessions without pacing delay',
    async () => {
      const lowCam = new Camera({
        serial: 'T8214T0000000017',
        name: 'side_gate',
        mode: 'p2p',
        priority: 50,
        hold_secs: 60,
        station_serial: 'T8030P0000000001',
      });
      const equalCam = new Camera({
        serial: 'T8214T0000000018',
        name: 'back_gate',
        mode: 'p2p',
        priority: 50,
        hold_secs: 60,
        station_serial: 'T8030P0000000001',
      });
      const highDoorbell = new Camera({
        serial: 'T8214T0000000019',
        name: 'front_doorbell',
        mode: 'p2p',
        priority: 100,
        hold_secs: 60,
        station_serial: 'T8030P0000000001',
      });

      const t0 = 500000;
      // 1. lowCam triggers on person (50 + 200 = 250) and streams live for 20s (>= 20% of 60s = 12s),
      //    which cancels its safety-net pendingBackfill during normal streaming
      lowCam.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
      lowCam.applyMotionTrigger(t0, 'person detected', 60000, 'eufy-event', 200);
      lowCam.beginSession('p2p', t0, true);
      lowCam.markP2pVideoPacketReceived(t0 + 1000);
      const frameBuf = Buffer.alloc(1382400, 0x40);
      lowCam.recordDecodedFrame(frameBuf, frameBuf, t0 + 1000, '12:00');
      lowCam.recordDecodedFrame(frameBuf, frameBuf, t0 + 20000, '12:00');
      assert.equal(
        lowCam.getPendingBackfillJob(),
        null,
        'Safety-net BackfillJob is cleared once >= 20% (12s) of live video is decoded'
      );

      // 2. Equal-priority newer event (50 + 200 = 250) preempts when preempt_event_streams=true
      equalCam.applyMotionTrigger(t0 + 21000, 'person detected', 60000, 'eufy-event', 200);
      assert.equal(equalCam.canPreempt(lowCam, t0 + 21000, 8000, true), true);
      assert.equal(equalCam.canPreempt(lowCam, t0 + 21000, 8000, false), false);

      // 3. Higher-priority doorbell ring (100 + 1000 = 1100) preempts lowCam at t0 + 22s while lowCam's event
      //    is still active:
      //    lowCam MUST re-queue its BackfillJob on preemption even though it already streamed 20s (>= 20%)!
      highDoorbell.applyMotionTrigger(t0 + 22000, 'rings', 60000, 'eufy-event', 1000);
      assert.equal(highDoorbell.canPreempt(lowCam, t0 + 22000, 8000, false), true);
      const preemptInitiator = highDoorbell.resolvePreemptInitiator(lowCam, t0 + 22000);
      assert.equal(preemptInitiator, 'bridge-arbitrator/higher-priority-event');

      lowCam.terminateSession(t0 + 22000, 'preempted by higher-priority camera front_doorbell', true, preemptInitiator);
      assert.equal(
        lowCam.hasPendingBackfill(),
        true,
        'AT-13: Preempted event-driven P2P stream must retain/re-queue BackfillJob even after streaming >= 20% live'
      );
      assert.equal(lowCam.getPendingBackfillJob().event, 'person detected');

      // 4. Active Backfill download ('download') is protected from viewer-only preemption,
      //    and once downloadFinished=true (draining from RAM), releases the HomeBase P2P slot (usesP2pSlot() === false)
      lowCam.beginBackfillDownload(
        {
          storagePath: '/zx/lowcam_clip.zxvideo',
          cipherId: 1,
          clipMs: t0,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0 + 30000
      );
      assert.equal(
        lowCam.isOccupyingStationP2pChannel(),
        true,
        'AT-13: In-transfer backfill download occupies station P2P channel'
      );
      const viewerCandidate = new Camera({
        serial: 'T8214T0000000099',
        name: 'viewer_only_cam',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });
      viewerCandidate.setViewUntil(t0 + 50000);
      assert.equal(
        lowCam.isUrgentBackfillProtectedFrom(viewerCandidate, t0 + 31000),
        true,
        'AT-13: Active backfill download must be protected from viewer-only preemption'
      );
      assert.equal(
        lowCam.isUrgentBackfillProtectedFrom(highDoorbell, t0 + 31000),
        false,
        'AT-13: Motion/event wake can still preempt an in-transfer backfill download'
      );
      const siblingBfCam = new Camera({
        serial: 'T8214T0000000098',
        name: 'sibling_backfill_cam',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      siblingBfCam.queueEventBackfill(t0 + 10000, 'person detected', '', 'person detected', 200, true);
      siblingBfCam.recordMotionCleared(t0 + 15000, 4000, 10000, 'person detected');
      assert.equal(
        siblingBfCam.canQueryBackfillNow([lowCam, siblingBfCam], t0 + 31000, 4000, 12000, 2000),
        false,
        'AT-13: Sibling HomeBase backfill query must wait while lowCam is actively transferring over P2P'
      );
      lowCam.markP2pVideoPacketReceived(t0 + 31500);
      lowCam.recordDecodedFrame(frameBuf, frameBuf, t0 + 31500, '12:01');
      lowCam.bufferDownloadFrame(frameBuf, 1800);
      lowCam.markDownloadFinished(t0 + 32000);
      assert.equal(lowCam.getStoredSessionState(), 'draining_backfill_tail');
      assert.equal(
        lowCam.isOccupyingStationP2pChannel(),
        false,
        'AT-13: Once HomeBase clip transfer finishes (downloadFinished=true, draining from RAM), station P2P ' +
          'channel is released'
      );
      assert.equal(
        siblingBfCam.canQueryBackfillNow([lowCam, siblingBfCam], t0 + 32500, 4000, 12000, 2000),
        true,
        'AT-13: Sibling camera on same HomeBase can query backfill while lowCam drains buffered frames in RAM'
      );
      assert.equal(
        siblingBfCam.tryMatchBackfillCandidate({
          devSn: 'T8214T0000000098',
          storagePath: '/zx/sibling_clip.zxvideo',
          cipherId: 2,
          clipMs: t0 + 11000,
        }),
        true
      );
      assert.equal(
        siblingBfCam.canStartBackfillDownloadNow([lowCam, siblingBfCam], t0 + 32600, 2000),
        true,
        'AT-13: Sibling camera on same HomeBase can start backfill download while lowCam drains tail frames in RAM'
      );
      lowCam.endSession(t0 + 33000, true, false, 'download');

      // 5. Verify back-to-back same-station P2P switching starts immediately after a session ends,
      //    while consecutive START commands without an intervening stop remain paced by 2500ms
      const switchCamA = new Camera({
        serial: 'T8214T0000000117',
        name: 'switch_gate',
        mode: 'p2p',
        priority: 10,
        station_serial: 'T8030P0000000099',
      });
      const switchCamB = new Camera({
        serial: 'T8214T0000000118',
        name: 'switch_drive',
        mode: 'p2p',
        priority: 100,
        station_serial: 'T8030P0000000099',
      });
      const switchCamC = new Camera({
        serial: 'T8214T0000000119',
        name: 'switch_yard',
        mode: 'p2p',
        priority: 5,
        station_serial: 'T8030P0000000099',
      });
      await setupAcceptanceHarness([switchCamA, switchCamB, switchCamC]);
      try {
        const wakeReqA = WakeRequest.motion('gate motion', 30000)
          .withInitiator('api-wake')
          .withCreateEvent(true)
          .build();
        const wakeReqB = WakeRequest.motion('drive motion', 30000)
          .withInitiator('api-wake')
          .withCreateEvent(true)
          .build();
        const wakeReqC = WakeRequest.motion('yard motion', 30000)
          .withInitiator('api-wake')
          .withCreateEvent(true)
          .build();

        const firstWake = wakeCameraExternal(switchCamA, wakeReqA);
        assert.equal(firstWake.status, 'waking');
        assert.equal(firstWake.delay_ms, 0);

        const consecutiveWake = wakeCameraExternal(switchCamB, wakeReqB);
        assert.equal(
          consecutiveWake.status,
          'scheduled',
          'AT-13: Consecutive /api/wake without an intervening session end must be paced by 2500ms'
        );
        assert.ok(consecutiveWake.delay_ms > 0);
        switchCamB.clearApiWakeTimer();

        stop(switchCamA, 'session ended', false, 'bridge-timer');
        switchCamA.clearP2pStopInFlight();

        const backToBackWake = wakeCameraExternal(switchCamB, wakeReqB);
        assert.equal(
          backToBackWake.status,
          'waking',
          'AT-13: Waiting/next camera after same-station P2P session end must switch immediately'
        );
        assert.equal(backToBackWake.delay_ms, 0);

        // Preempting start command (after initial pacing window expired) must still pace a subsequent /api/wake
        stop(switchCamB, 'reset', false, 'bridge-timer');
        switchCamB.clearP2pStopInFlight();
        await setupAcceptanceHarness([switchCamA, switchCamB, switchCamC]);
        switchCamA.beginSession('p2p', Date.now() - 10000, true);
        switchCamA.setMotionUntil(Date.now() + 20000);
        trigger(switchCamB, 'driveway person', 30000, 'motion', 'eufy-event', 200);
        assert.equal(switchCamB.isSessionActive(), true);
        const wakeAfterPreempt = wakeCameraExternal(switchCamC, wakeReqC);
        assert.equal(
          wakeAfterPreempt.status,
          'scheduled',
          'AT-13: Fresh preemption START command must still pace subsequent external /api/wake'
        );
        assert.ok(wakeAfterPreempt.delay_ms > 0);

        // Verify same-camera Eufy triggers during STREAM_MODES.DOWNLOAD never self-preempt Event 1
        switchCamC.clearApiWakeTimer();
        stop(switchCamB, 'reset before same-cam download check', false, 'bridge-timer');
        switchCamB.clearP2pStopInFlight();
        const tDl = Date.now();
        switchCamA.setReason('clip1 motion');
        switchCamA.beginBackfillDownload(
          {
            storagePath: '/zx/camA_ev1.zxvideo',
            cipherId: 11,
            clipMs: tDl - 20000,
            event: 'motion detected',
            personName: '',
            reason: 'clip1 motion',
          },
          false,
          tDl
        );
        onEvent({
          source: 'device',
          event: 'person detected',
          serialNumber: switchCamA.getSerial(),
          state: true,
        });
        assert.equal(
          switchCamA.getActiveMode(),
          'download',
          'AT-13: Same-camera motion must never self-preempt an active backfill download'
        );
        assert.equal(
          switchCamA.getReason(),
          'backfill: clip1 motion',
          'AT-13: Same-camera motion during backfill download must keep Event 1 reason intact'
        );
        assert.equal(
          switchCamA.hasPendingBackfill(),
          true,
          'AT-13: Same-camera motion during backfill download queues Event 2 BackfillJob behind Event 1'
        );
        switchCamA.clearPendingBackfill();
      } finally {
        switchCamB.clearApiWakeTimer();
        switchCamC.clearApiWakeTimer();
        stop(switchCamA, 'cleanup', false, 'bridge-test');
        stop(switchCamB, 'cleanup', false, 'bridge-test');
        stop(switchCamC, 'cleanup', false, 'bridge-test');
        configureEufyClientHooks({isShuttingDown: () => true});
      }
    }
  );
});
