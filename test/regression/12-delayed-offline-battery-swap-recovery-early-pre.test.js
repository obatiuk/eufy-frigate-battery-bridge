/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 12. Delayed Offline Battery-Swap Recovery & Early Pre-Decoder Audio Drop
 * (docs/regression/12-delayed-offline-battery-swap-recovery-early-pre.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub, createOfflineRecoveryHarness} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, fetchAllCameraTelemetry} = require('../../src/services/eufy-client');
const {wakeCameraExternal} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 12. Delayed Offline Battery-Swap Recovery & Early Pre-Decoder Audio Drop', () => {
  it(
    'Regression 12: triggers 15 fps keyframe bursts on consumer reconnect, coalesces duplicate triggers, ' +
      'and reports download completion',
    () => {
      // Regression 12: triggers 15 fps keyframe bursts on consumer reconnect, coalesces duplicate triggers, and
      // reports download completion.
      const doorbell = new Camera({serial: 'T8214T2222222222', name: 'doorbell', mode: 'backfill'});
      // 7. Consumer (re-)connection triggers an immediate 15 fps keyframe burst so Frigate
      // attaches without waiting for 1 fps GOP
      const tAttach = 300000;
      doorbell.attachEncoder({stdin: {writable: true, write() {}}, kill() {}}, tAttach);
      assert.equal(doorbell.isInKeyframeBurst(tAttach + 5000), false);
      assert.equal(doorbell.notifyEncoderConsumersObserved(1, 6000, tAttach + 5000), true);
      assert.equal(doorbell.isInKeyframeBurst(tAttach + 5500), true);
      assert.equal(
        doorbell.notifyEncoderConsumersObserved(1, 6000, tAttach + 6000),
        false,
        'Does not re-trigger burst while consumer remains connected'
      );
      assert.equal(doorbell.notifyEncoderConsumersObserved(0, 6000, tAttach + 9000), false);
      assert.equal(
        doorbell.notifyEncoderConsumersObserved(1, 6000, tAttach + 10000),
        true,
        'Re-triggers keyframe burst when go2rtc consumer disconnects and reconnects'
      );

      // 8. Deduplicates simultaneous property changed + native trigger start/clear pairs within 1s burst
      const tBurst = 900000;
      assert.equal(doorbell.isDuplicateTriggerEvent('person detected', true, '', tBurst), false);
      doorbell.queueEventBackfill(tBurst, 'person detected', '', 'person detected', 200, true);
      assert.equal(
        doorbell.isDuplicateTriggerEvent('person detected', true, '', tBurst + 5),
        true,
        'Duplicate person detected start within 1s burst must be coalesced'
      );
      assert.equal(
        doorbell.isDuplicateTriggerEvent('person detected', true, 'Alice', tBurst + 10),
        false,
        'Must allow companion face name upgrade on the same trigger event'
      );
      assert.equal(doorbell.isDuplicateTriggerEvent('person detected', false, '', tBurst + 10000), false);
      doorbell.recordMotionCleared(tBurst + 10000, 5000, 10000, 'person detected');
      assert.equal(
        doorbell.isDuplicateTriggerEvent('person detected', false, '', tBurst + 10005),
        true,
        'Duplicate person detected clear within 1s burst must be coalesced'
      );

      // 9. terminateSession reports hadDownloadFinished so stop() skips redundant
      // device.cancel_download after normal completion
      doorbell.beginBackfillDownload(
        {
          storagePath: '/zx/clip_done.zxvideo',
          cipherId: 0,
          cipher_id: 0,
          clipMs: tBurst - 10000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        tBurst + 20000
      );
      doorbell.markDownloadFinished(tBurst + 25000);
      const termDone = doorbell.terminateSession(
        tBurst + 55000,
        'post-event clip download stream completed',
        false,
        'eufy/download-finished'
      );
      assert.equal(termDone.hadDownloadFinished, true);
    }
  );

  it('Regression 12: polls HomeBase immediately when /api/wake targets an offline camera', async () => {
    // Verify: /api/wake on an offline camera returns status "offline" and triggers driver.poll_refresh.
    const {offlineDoorbell, sentCommands} = await createOfflineRecoveryHarness();
    const wakeResp = wakeCameraExternal(offlineDoorbell, {
      durationMs: 30000,
      reason: 'battery swap hook',
      createEvent: false,
    });
    assert.equal(wakeResp.status, 'offline');
    assert.equal(
      sentCommands.includes('driver.poll_refresh'),
      true,
      '/api/wake on an offline camera must immediately trigger driver.poll_refresh'
    );
    await flushAsync();
    configureEufyClientHooks({onDeviceOnlineResume: () => {}});
  });

  it(
    'Regression 12: upgrades background fetchAllCameraTelemetry(false) to driver.poll_refresh when any camera is ' +
      'offline',
    async () => {
      // Verify: background telemetry poll forces driver.poll_refresh to detect battery swaps on offline cameras.
      const {offlineDoorbell, sentCommands, resumedCams} = await createOfflineRecoveryHarness();
      await fetchAllCameraTelemetry(false);
      assert.equal(
        sentCommands.includes('driver.poll_refresh'),
        true,
        'fetchAllCameraTelemetry(false) must invoke driver.poll_refresh when a camera is ' +
          'genuinely offline to detect battery replacement'
      );
      assert.equal(offlineDoorbell.isDeviceOffline(), false);
      assert.equal(resumedCams.includes('doorbell'), true);
      configureEufyClientHooks({onDeviceOnlineResume: () => {}});
    }
  );
});
