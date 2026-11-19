/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 18. Viewer Cooldown Must Not Block Wakes During Active Eufy Hardware Triggers
 * (docs/regression/18-cooldown-blocked-viewer-wake-during-active-trigger.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {SESSION_STATES, Camera} = require('../../src/domain/camera');
const {classifyViewerAction} = require('../../src/services/frigate-client');

installDefaultFetchStub();

describe('Regression 18. Viewer Cooldown Must Not Block Wakes During Active Eufy Hardware Triggers', () => {
  it(
    'Regression 18: transitions Camera.sessionState deterministically ' +
      'across RTSP, P2P, and Backfill FSM lifecycle states',
    () => {
      // Regression 18: transitions Camera.sessionState deterministically across RTSP, P2P, and Backfill FSM lifecycle
      // states.
      assert.ok(SESSION_STATES);
      const rtspCam = new Camera({
        serial: 'T8161T0000000000',
        mode: 'rtsp',
      });
      rtspCam.updateDiscoveredRtspConfig('T8030T0000000000', 'rtsp://10.0.0.1/live0');
      const p2pCam = new Camera({serial: 'T8161T1111111111', mode: 'p2p'});
      const backfillCam = new Camera({serial: 'T8214T2222222222', mode: 'backfill'});

      const t0 = 500000;
      // 1. RTSP lifecycle: IDLE -> WAKING_RTSP -> STREAMING_LIVE -> WAKING_RTSP (rewake) -> STREAMING_LIVE -> IDLE
      assert.equal(rtspCam.getStoredSessionState(), SESSION_STATES.IDLE);
      rtspCam.beginSession('rtsp', t0, false);
      assert.equal(rtspCam.getStoredSessionState(), SESSION_STATES.WAKING_RTSP);
      rtspCam.markRtspFrameReceived(t0 + 1000);
      assert.equal(rtspCam.getStoredSessionState(), SESSION_STATES.STREAMING_LIVE);
      rtspCam.beginRtspRewake(t0 + 5000, 10000);
      assert.equal(rtspCam.getStoredSessionState(), SESSION_STATES.WAKING_RTSP);
      rtspCam.markRtspFrameReceived(t0 + 6000);
      assert.equal(rtspCam.getStoredSessionState(), SESSION_STATES.STREAMING_LIVE);
      rtspCam.endSession(t0 + 10000);
      assert.equal(rtspCam.getStoredSessionState(), SESSION_STATES.IDLE);

      // 2. P2P lifecycle: IDLE -> WAKING_P2P -> STREAMING_LIVE -> COOLDOWN -> IDLE
      assert.equal(p2pCam.getStoredSessionState(), SESSION_STATES.IDLE);
      assert.equal(p2pCam.transitionTo(SESSION_STATES.WAKING_P2P, t0), SESSION_STATES.WAKING_P2P);
      p2pCam.beginSession('p2p', t0, false);
      assert.equal(p2pCam.getStoredSessionState(), SESSION_STATES.WAKING_P2P);
      const p2pFrame = Buffer.alloc(FRAME, 0x44);
      p2pCam.markP2pVideoPacketReceived(t0 + 700);
      p2pCam.recordDecodedFrame(p2pFrame, p2pFrame, t0 + 800, '12:00', 5000);
      assert.equal(p2pCam.getStoredSessionState(), SESSION_STATES.STREAMING_LIVE);
      p2pCam.endSession(t0 + 10000, true, false, 'p2p');
      assert.equal(p2pCam.getStoredSessionState(), SESSION_STATES.COOLDOWN);
      assert.equal(p2pCam.isInViewerCooldown(t0 + 10500), true);

      // Regression #18: isInViewerCooldown bypassed when hardware triggers active
      p2pCam.addActiveTriggerEvent('motion');
      p2pCam.setLastMotionAt(t0 + 12000);
      p2pCam.setMotionUntil(t0 + 12000 + 20000);
      p2pCam.setMotionClearedAt(0);
      assert.equal(p2pCam.hasActiveHardwareTriggers(), true);
      assert.equal(p2pCam.isInViewerCooldown(t0 + 12000), false);

      // Regression #18: hasActiveHardwareTriggers returns false after motion clears
      p2pCam.setMotionClearedAt(t0 + 35000);
      assert.equal(p2pCam.hasActiveHardwareTriggers(), false);

      assert.equal(p2pCam.getSessionState(t0 + 30000), SESSION_STATES.IDLE);
      assert.equal(p2pCam.getStoredSessionState(), SESSION_STATES.IDLE);

      // 3. Backfill lifecycle: IDLE -> HANDSHAKING_BACKFILL -> PLAYING_BACKFILL -> DRAINING_BACKFILL_TAIL -> IDLE
      assert.equal(backfillCam.getStoredSessionState(), SESSION_STATES.IDLE);
      backfillCam.beginBackfillDownload(
        {
          storagePath: '/zx/hdd_data0/Camera02/202611/20261105200709/20261105200709.zxvideo',
          cipherId: 0,
          clipMs: t0 - 30000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0
      );
      assert.equal(backfillCam.getStoredSessionState(), SESSION_STATES.HANDSHAKING_BACKFILL);

      const bfFrame0 = Buffer.alloc(FRAME, 0x55);
      backfillCam.recordDecodedFrame(bfFrame0, bfFrame0, t0 + 300, '12:01', 5000);
      assert.equal(backfillCam.getStoredSessionState(), SESSION_STATES.PLAYING_BACKFILL);

      backfillCam.markDownloadFinished(t0 + 4000);
      assert.equal(backfillCam.getStoredSessionState(), SESSION_STATES.DRAINING_BACKFILL_TAIL);

      backfillCam.endSession(t0 + 30000);
      assert.equal(backfillCam.getStoredSessionState(), SESSION_STATES.IDLE);
    }
  );

  it('Regression 18: allows viewer wake during cooldown when hardware triggers active', () => {
    // Regression 18: allows viewer wake during cooldown when hardware triggers active.
    const cam = new Camera({
      serial: 'T8161T2222222222',
      name: 'doorbell',
      mode: 'p2p',
    });
    const t0 = 300000;

    // Camera enters cooldown after session ends
    cam.beginSession('p2p', t0, false);
    cam.markP2pVideoPacketReceived(t0 + 700);
    cam.endSession(t0 + 10000, true, false, 'p2p');

    // Simulate hardware trigger arriving during cooldown
    cam.setLastMotionAt(t0 + 11000);
    cam.setMotionUntil(t0 + 11000 + 20000);
    cam.setMotionClearedAt(0);
    cam.addActiveTriggerEvent('person');

    // classifyViewerAction should allow wake because hardware trigger is active
    const result = classifyViewerAction({
      camActive: false,
      alreadyViewing: false,
      isDashboardGrid: false,
      blockedByOffline: false,
      blockedByBackfill: false,
      blockedByP2pMotion: false,
      activeMotionCamName: '',
      blockedByEco: false,
      batteryPct: 80,
      inCooldown: cam.isInViewerCooldown(t0 + 11000), // Should be false now
    });

    assert.equal(result.asked, true);
    assert.equal(result.actionDesc, 'waking the camera');
  });

  it('Regression 18: still blocks cooldown wake without hardware triggers', () => {
    // Regression 18: still blocks cooldown wake without hardware triggers.
    const cam = new Camera({
      serial: 'T8161T3333333333',
      name: 'garage',
      mode: 'rtsp',
    });
    const t0 = 400000;

    // Camera enters cooldown after session ends
    cam.beginSession('rtsp', t0, false);
    cam.markRtspFrameReceived(t0 + 1000);
    cam.endSession(t0 + 10000, true, false, 'rtsp');

    // No hardware trigger, camera is in cooldown
    assert.equal(cam.hasActiveHardwareTriggers(), false);
    assert.equal(cam.isInViewerCooldown(t0 + 11000), true);

    // classifyViewerAction should block wake because in cooldown with no triggers
    const result = classifyViewerAction({
      camActive: false,
      alreadyViewing: false,
      isDashboardGrid: false,
      blockedByOffline: false,
      blockedByBackfill: false,
      blockedByP2pMotion: false,
      activeMotionCamName: '',
      blockedByEco: false,
      batteryPct: 80,
      inCooldown: cam.isInViewerCooldown(t0 + 11000), // true
    });

    assert.equal(result.asked, false);
    assert.equal(result.actionDesc, 'ignored, camera just went to sleep (cooldown)');
  });
});
