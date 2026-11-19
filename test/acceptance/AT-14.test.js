/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-14`: Human Frigate Live View - Dashboard Grid Ignore, Same-Station Switching &
 * Blocks (docs/acceptance/AT-14.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-14.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {selectEncoderFrame} = require('../../src/media/encoder');
const {classifyViewerAction, pollViewers} = require('../../src/services/frigate-client');
const {initOrchestrator, stop, trigger} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Locked Acceptance Criterion AT-14 (docs/acceptance/AT-14.md)', () => {
  it(
    'AT-14: Ignores multi-camera dashboard grids on battery/HomeBase cameras while keeping direct rtsp_url ' +
      'streams active, only stops another Live View camera on the same HomeBase when BOTH use the P2P slot, ' +
      'and enforces all 5 viewer blocks',
    async () => {
      const rtspCam1 = new Camera({
        serial: 'T8161T0000000020',
        name: 'storage',
        mode: 'rtsp',
        station_serial: 'T8030P0000000001',
      });
      rtspCam1.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live0');
      const rtspCam2 = new Camera({
        serial: 'T8161T0000000021',
        name: 'garage',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      rtspCam2.updateDiscoveredRtspConfig('T8030P0000000001', 'rtsp://192.168.1.50/live1');
      const p2pCam1 = new Camera({
        serial: 'T8214T0000000022',
        name: 'doorbell_1',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      const p2pCam2 = new Camera({
        serial: 'T8214T0000000023',
        name: 'doorbell_2',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });

      const t0 = 800000;
      rtspCam1.beginSession('rtsp', t0, false);
      rtspCam1.setViewUntil(t0 + 20000);
      p2pCam1.beginSession('p2p', t0, false);
      p2pCam1.setViewUntil(t0 + 20000);

      // 1. RTSP Live View never yields to another RTSP or P2P Live View (even during 0-viewer linger),
      //    and P2P Live View never yields to an RTSP Live View! Only P2P <-> P2P yields!
      assert.equal(
        rtspCam1.shouldYieldToNewStationViewer(rtspCam2, t0 + 5000),
        false,
        'AT-14: RTSP Live View must stay open in parallel when another RTSP camera opens Live View'
      );
      assert.equal(
        rtspCam1.shouldYieldToNewStationViewer(p2pCam1, t0 + 5000),
        false,
        'AT-14: RTSP Live View must stay open in parallel when a P2P camera opens Live View'
      );
      assert.equal(
        p2pCam1.shouldYieldToNewStationViewer(rtspCam2, t0 + 5000),
        false,
        'AT-14: P2P Live View must not stop when an RTSP camera opens Live View'
      );
      assert.equal(
        p2pCam1.shouldYieldToNewStationViewer(p2pCam2, t0 + 5000),
        true,
        'AT-14: P2P Live View must yield when a second P2P camera on the same HomeBase opens Live View'
      );
      p2pCam1.beginSession('download', t0 + 6000, true);
      assert.equal(
        p2pCam1.shouldYieldToNewStationViewer(p2pCam2, t0 + 7000),
        false,
        'AT-14: Active backfill download/playback must never yield to a viewer on another camera'
      );

      // 2. Dashboard grid ignore + 4 viewer blocks (offline, eco, cooldown, P2P motion)
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: false,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByOffline: true,
          offlineReason: 'device offline',
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 0,
          inCooldown: false,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: true,
          batteryPct: 15,
          inCooldown: false,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: true,
        }).asked,
        false
      );
      assert.equal(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByP2pMotion: true,
          activeMotionCamName: 'doorbell_1',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: false,
        }).asked,
        false
      );
      assert.deepEqual(
        classifyViewerAction({
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: false,
          blockedByBackfill: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: 80,
          inCooldown: false,
        }),
        {asked: false, actionDesc: 'ignored, waiting for HomeBase clip backfill'}
      );

      // 3. Direct rtsp_url cameras are never ignored or logged as dashboard grid: they connect immediately when IDLE
      //    (keeping sleeping card until Frame 0 decodes) while sleeping battery cameras in the same grid stay asleep,
      //    and report 'streaming direct RTSP' when already active.
      assert.deepEqual(
        classifyViewerAction({
          rtspDirect: true,
          camActive: false,
          alreadyViewing: false,
          isDashboardGrid: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: null,
          inCooldown: false,
        }),
        {asked: true, actionDesc: 'connecting direct RTSP stream'}
      );
      assert.deepEqual(
        classifyViewerAction({
          rtspDirect: true,
          camActive: true,
          alreadyViewing: false,
          isDashboardGrid: true,
          blockedByP2pMotion: false,
          activeMotionCamName: '',
          blockedByEco: false,
          batteryPct: null,
          inCooldown: false,
        }),
        {asked: false, actionDesc: 'streaming direct RTSP'}
      );

      const directGridCam = new Camera(
        {
          name: 'nursery_direct',
          rtsp_url: 'rtsp://127.0.0.1:8554/nursery_direct',
        },
        {frame: Buffer.alloc(1382400, 0x34), lastSeen: '12:15'},
        renderCameraCards
      );
      const gridBatteryCam = new Camera({
        serial: 'T8214T0000000094',
        name: 'porch_grid_cam',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });
      const origFetch = global.fetch;
      initOrchestrator(
        [gridBatteryCam, directGridCam],
        new Map([[gridBatteryCam.getSerial(), gridBatteryCam]]),
        () => false
      );
      try {
        global.fetch = async () => ({
          ok: true,
          status: 200,
          async json() {
            return {
              porch_grid_cam: {
                consumers: [{id: 'grid-v1', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
              },
              nursery_direct: {
                consumers: [{id: 'grid-v2', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
              },
            };
          },
        });
        await pollViewers([gridBatteryCam, directGridCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: async () => {},
          stopCam: stop,
          triggerCam: trigger,
        });
        assert.equal(
          gridBatteryCam.getStoredSessionState(),
          'idle',
          'AT-14: Sleeping battery camera in a mixed multi-camera grid must remain idle'
        );
        assert.equal(
          directGridCam.getStoredSessionState(),
          'waking_rtsp',
          'AT-14: Idle direct rtsp_url camera in a multi-camera grid must immediately start pulling RTSP'
        );
        assert.equal(directGridCam.getWakeInitiator(), 'viewer');
        assert.equal(
          selectEncoderFrame(directGridCam, Date.now()).frame,
          directGridCam.getAsleepCardBuffer(),
          'AT-14: Direct rtsp_url camera woken by viewer must keep sleeping card until Frame 0 decodes'
        );
      } finally {
        global.fetch = origFetch;
        stop(directGridCam, 'cleanup', false, 'rtsp-direct-probe');
        stop(gridBatteryCam, 'cleanup', false, 'bridge-test');
      }
    }
  );
});
