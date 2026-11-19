/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-09`: Post-Viewer Linger Clean Termination & Trigger-Bypassed Viewer Cooldown
 * (docs/acceptance/AT-09.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-09.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {classifyViewerAction} = require('../../src/services/frigate-client');

installDefaultFetchStub();

describe('Locked Acceptance Criterion AT-09 (docs/acceptance/AT-09.md)', () => {
  it('AT-09: Post-viewer linger terminates cleanly on stream drop without re-waking in a loop', () => {
    const rtspCam = new Camera({
      serial: 'T8161T0000000011',
      name: 'storage',
      mode: 'rtsp',
    });
    rtspCam.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');
    const p2pCam = new Camera({
      serial: 'T8214T0000000012',
      name: 'doorbell',
      mode: 'backfill',
    });

    const t0 = 500000;
    rtspCam.beginSession('rtsp', t0, false);
    rtspCam.setViewUntil(t0 + 20000);
    rtspCam.setViewerWakingStatus('v1', true);
    assert.equal(rtspCam.shouldRewakeRtspOnDrop(t0 + 5000), true);

    rtspCam.pruneDisconnectedViewers(new Set(), 0);
    assert.equal(rtspCam.hasWakingViewer(), false);
    assert.equal(
      rtspCam.shouldRewakeRtspOnDrop(t0 + 10000),
      false,
      'RTSP camera must not re-wake on drop after viewer disconnected'
    );

    p2pCam.beginSession('p2p', t0, false);
    p2pCam.setViewUntil(t0 + 20000);
    p2pCam.markP2pVideoPacketReceived(t0 + 2000);
    assert.equal(p2pCam.hasWakingViewer(), false);
    assert.equal(
      p2pCam.evaluateExternalLivestreamStop(t0 + 10000, 3000).action,
      'expired',
      'P2P camera must expire cleanly on stop after viewer disconnected'
    );
    assert.equal(
      p2pCam.evaluateP2pHealth(t0 + 12000, t0 + 2000).action,
      'expired',
      'P2P watchdog must expire cleanly on video stop after viewer disconnected'
    );

    // Verify post-viewer cooldown blocks pure viewer re-wakes, and never blocks wakes when Eufy hardware
    // triggers are active
    p2pCam.endSession(t0 + 12000, true, false, 'p2p');
    assert.equal(p2pCam.isInViewerCooldown(t0 + 13000), true);
    assert.equal(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByOffline: false,
        blockedByBackfill: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: p2pCam.isInViewerCooldown(t0 + 13000),
      }).asked,
      false,
      'AT-09: Post-viewer cooldown must guard pure viewer re-wakes when no hardware trigger is active'
    );
    p2pCam.addActiveTriggerEvent('person');
    p2pCam.setLastMotionAt(t0 + 13500);
    p2pCam.setMotionUntil(t0 + 33500);
    p2pCam.setMotionClearedAt(0);
    assert.equal(
      p2pCam.isInViewerCooldown(t0 + 13500),
      false,
      'AT-09: Post-viewer cooldown must be bypassed while an Eufy hardware trigger is active'
    );
    assert.equal(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByOffline: false,
        blockedByBackfill: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: p2pCam.isInViewerCooldown(t0 + 13500),
      }).asked,
      true,
      'AT-09: Viewer wake must proceed immediately during cooldown when an Eufy hardware trigger is active'
    );

    const tStale = t0 + 50000;
    p2pCam.clearActiveTriggerEvents();
    p2pCam.setLastMotionAt(tStale);
    p2pCam.setMotionClearedAt(0);
    p2pCam.queueEventBackfill(tStale, 'person detected', '', 'person detected', 200, true);
    p2pCam.setSleptAt(tStale + 128000);
    assert.equal(
      p2pCam.isInViewerCooldown(tStale + 130000),
      false,
      'AT-09: Unexpired hardware trigger (<= 130s) bypasses post-viewer cooldown'
    );
    assert.equal(
      p2pCam.isInViewerCooldown(tStale + 130001),
      true,
      'AT-09: Stale hardware trigger (> 130s) expires so post-viewer cooldown guards pure viewer wakes again'
    );
    const tDisc = tStale + 200000;
    p2pCam.setLastMotionAt(tDisc);
    p2pCam.setMotionClearedAt(0);
    p2pCam.queueEventBackfill(tDisc, 'person detected', '', 'person detected', 200, true);
    p2pCam.setSleptAt(tDisc - 2000);
    assert.equal(p2pCam.isInViewerCooldown(tDisc), false);
    p2pCam.handleStationDisconnected('ws_closed');
    assert.equal(
      p2pCam.isInViewerCooldown(tDisc),
      true,
      'AT-09: Station/WebSocket disconnect clears hardware triggers and restores post-viewer cooldown'
    );
  });
});
