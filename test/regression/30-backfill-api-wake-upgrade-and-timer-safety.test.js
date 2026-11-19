/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 30. Mid-Backfill /api/wake Upgrade, Download Queue Preservation & WS-Drop Wake
 * Safety (docs/regression/30-backfill-api-wake-upgrade-and-timer-safety.md).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {STREAM_MODES} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {initOrchestrator, wakeCameraExternal, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('Regression 30. Mid-Backfill /api/wake Upgrade, Download Queue Preservation & WS-Drop Wake Safety', () => {
  it('Regression 30: clears any existing apiWakeTimer before scheduling a replacement wake', async () => {
    // Regression 30: clears any existing apiWakeTimer before scheduling a replacement wake.
    const cam = new Camera({serial: 'T8161T6666666666', name: 'wake_timer_cam'});
    let firstFired = 0;
    const secondPayloads = [];
    mock.timers.enable({apis: ['setTimeout']});
    const now = Date.now();
    cam.scheduleApiWake({durationMs: 30000, reason: 'first wake', createEvent: false, delayMs: 15, now}, () => {
      firstFired += 1;
    });
    cam.scheduleApiWake({durationMs: 45000, reason: 'second wake', createEvent: true, delayMs: 25, now}, (pending) => {
      secondPayloads.push(pending);
    });
    mock.timers.tick(25);
    mock.timers.reset();
    await flushAsync();
    assert.equal(firstFired, 0, 'Prior apiWakeTimer must be cleared before setting replacement timer');
    assert.deepEqual(secondPayloads, [{durationMs: 45000, reason: 'second wake', createEvent: true}]);
  });

  it('Regression 30: upgrades pendingBackfill priority in place on /api/wake while preserving download queues', () => {
    // Regression: /api/wake on backfill camera upgrades priority/reason in place without
    // clobbering higher-specificity hardware event labels or creating duplicate BackfillJobs,
    // and a view api-wake during DOWNLOAD preserves backfillClipQueue and pendingBackfill.
    const upgradeCam = new Camera({serial: 'T8161T4444444446', name: 'upgrade_cam', mode: 'backfill'});
    const tUpg = 910000;
    upgradeCam.queueEventBackfill(tUpg, 'motion detected', '', 'motion detected', 10, true);
    assert.equal(upgradeCam.queueOrUpgradeApiWakeBackfill(tUpg + 1000, 'garage sensor', 250), true);
    assert.equal(upgradeCam.getPendingBackfillJob().priority, 250);
    assert.equal(upgradeCam.getPendingBackfillJob().reason, 'garage sensor');
    assert.equal(upgradeCam.getPendingBackfillJob().event, 'motion detected');
    assert.equal(upgradeCam.getActiveBackfillJob(), null);

    const personUpgradeCam = new Camera({serial: 'T8161T4444444447', name: 'person_upg_cam', mode: 'backfill'});
    personUpgradeCam.queueEventBackfill(tUpg, 'person detected', '', 'person detected', 200, true);
    assert.equal(personUpgradeCam.queueOrUpgradeApiWakeBackfill(tUpg + 1000, 'driveway beam', 250), true);
    assert.equal(personUpgradeCam.getPendingBackfillJob().priority, 250);
    assert.equal(personUpgradeCam.getPendingBackfillJob().reason, 'driveway beam');
    assert.equal(
      personUpgradeCam.getPendingBackfillJob().event,
      'person detected',
      'API wake upgrade must preserve higher-specificity hardware event label like person detected'
    );

    const ringUpgradeCam = new Camera({serial: 'T8161T4444444448', name: 'ring_upg_cam', mode: 'backfill'});
    ringUpgradeCam.queueEventBackfill(tUpg, 'rings', '', 'rings', 1000, true);
    assert.equal(ringUpgradeCam.queueOrUpgradeApiWakeBackfill(tUpg + 1000, 'porch sensor', 250), false);
    assert.equal(ringUpgradeCam.getPendingBackfillJob().priority, 1000);
    assert.equal(ringUpgradeCam.getPendingBackfillJob().event, 'rings');
    assert.equal(ringUpgradeCam.getPendingBackfillJob().reason, 'rings');

    const dlCam = new Camera({
      serial: 'T8161T4444444449',
      name: 'dl_preserve_cam',
      mode: 'rtsp',
      backfill_downloads: true,
    });
    dlCam.queueEventBackfill(tUpg, 'motion detected', '', 'motion detected', 10, false);
    dlCam.beginSession(STREAM_MODES.DOWNLOAD, tUpg, false);
    dlCam.getBackfillClipQueue().push(
      Object.freeze({
        storagePath: '/zx/dl1.zxvideo',
        cipherId: 0,
        clipMs: tUpg - 5000,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
      })
    );
    const dlViewRes = dlCam.applyViewTrigger(tUpg + 20000, 'api-view-wake', 30000, 'api-wake', [dlCam], 15000);
    assert.equal(dlCam.isRuntimeExtended(), false, 'View api-wake during DOWNLOAD must not set runtimeExtended');
    assert.equal(dlCam.hasPendingBackfill(), true, 'View api-wake during DOWNLOAD must preserve pendingBackfill');
    assert.equal(
      dlCam.getBackfillClipQueue().length,
      1,
      'View api-wake during DOWNLOAD must preserve backfillClipQueue'
    );
    assert.equal(dlViewRes.shouldLog, false);
    assert.equal(dlViewRes.message, '');
  });

  it(
    'Regression 30: upgrades an existing pending or active BackfillJob in ' + 'place when /api/wake fires mid-backfill',
    () => {
      // Regression 30: upgrades an existing pending or active BackfillJob in place when /api/wake fires mid-backfill.
      const bfMotionCam = new Camera({
        serial: 'T8161T9900000001',
        name: 'bf_motion_cam',
        title: 'Backfill Motion Camera',
        mode: 'backfill',
      });
      const bfPersonCam = new Camera({
        serial: 'T8161T9900000002',
        name: 'bf_person_cam',
        title: 'Backfill Person Camera',
        mode: 'backfill',
      });
      const bfRingCam = new Camera({
        serial: 'T8161T9900000003',
        name: 'bf_ring_cam',
        title: 'Backfill Ring Camera',
        mode: 'backfill',
      });
      const bfActiveCam = new Camera({
        serial: 'T8161T9900000004',
        name: 'bf_active_cam',
        title: 'Backfill Active Download Camera',
        mode: 'backfill',
      });

      initOrchestrator(
        [bfMotionCam, bfPersonCam, bfRingCam, bfActiveCam],
        () => false,
        new Set(['motion_detected', 'person_detected', 'doorbell_press'])
      );

      try {
        const now = Date.now();
        bfMotionCam.queueEventBackfill(now, 'motion detected', '', 'motion detected', 10, true);
        const motionWakeRes = wakeCameraExternal(bfMotionCam, {
          durationMs: 30000,
          reason: 'garage sensor',
          createEvent: true,
          delayMs: 0,
        });
        assert.equal(motionWakeRes.status, 'backfill');
        assert.equal(bfMotionCam.getPendingBackfillJob().priority, 250);
        assert.equal(bfMotionCam.getPendingBackfillJob().reason, 'garage sensor');
        assert.equal(bfMotionCam.getPendingBackfillJob().event, 'motion detected');
        assert.equal(bfMotionCam.getActiveBackfillJob(), null);

        bfPersonCam.queueEventBackfill(now, 'person detected', '', 'person detected', 200, true);
        const personWakeRes = wakeCameraExternal(bfPersonCam, {
          durationMs: 30000,
          reason: 'gate beam',
          createEvent: true,
          delayMs: 0,
        });
        assert.equal(personWakeRes.status, 'backfill');
        assert.equal(bfPersonCam.getPendingBackfillJob().priority, 250);
        assert.equal(bfPersonCam.getPendingBackfillJob().reason, 'gate beam');
        assert.equal(
          bfPersonCam.getPendingBackfillJob().event,
          'person detected',
          '/api/wake must not clobber person detected label with motion detected'
        );

        bfRingCam.queueEventBackfill(now, 'rings', '', 'rings', 1000, true);
        const ringWakeRes = wakeCameraExternal(bfRingCam, {
          durationMs: 30000,
          reason: 'porch sensor',
          createEvent: true,
          delayMs: 0,
        });
        assert.equal(ringWakeRes.status, 'backfill');
        assert.equal(bfRingCam.getPendingBackfillJob().priority, 1000);
        assert.equal(bfRingCam.getPendingBackfillJob().event, 'rings');
        assert.equal(bfRingCam.getPendingBackfillJob().reason, 'rings');

        bfActiveCam.queueEventBackfill(now, 'motion detected', '', 'motion detected', 10, true);
        bfActiveCam.beginBackfillDownload({storagePath: '/zx/active.zxvideo', cipherId: 0, clipMs: now - 5000}, now);
        assert.ok(
          bfActiveCam.getActiveBackfillJob(),
          'beginBackfillDownload shifts pendingBackfill into activeBackfillJob'
        );
        assert.equal(bfActiveCam.getPendingBackfillJob(), null);
        const activeWakeRes = wakeCameraExternal(bfActiveCam, {
          durationMs: 30000,
          reason: 'active job api wake',
          createEvent: true,
          delayMs: 0,
        });
        assert.equal(activeWakeRes.status, 'backfill');
        assert.equal(bfActiveCam.getActiveBackfillJob().priority, 250);
        assert.equal(bfActiveCam.getActiveBackfillJob().reason, 'active job api wake');
        assert.equal(
          bfActiveCam.getPendingBackfillJob(),
          null,
          'Upgrading activeBackfillJob in place must not queue a duplicate pendingBackfill'
        );
      } finally {
        for (const c of [bfMotionCam, bfPersonCam, bfRingCam, bfActiveCam]) {
          c.clearApiWakeTimer();
          c.clearPendingBackfill();
          stop(c, 'cleanup', false, 'bridge-test');
        }
      }
    }
  );
});
