/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 29. Low-Battery Swap Offline Latch, Eager Boot Encoders & Service Health Split
 * (docs/regression/29-low-battery-swap-boot-encoders-and-health-split.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {EUFY_DEVICE_STATES} = require('../../src/domain/telemetry');
const {
  configureEufyClientHooks,
  ensureCameraEncodersStarted,
  connectWs,
  isWsReady,
} = require('../../src/services/eufy-client');
const {syncFrigateMotionMasks, pollViewers} = require('../../src/services/frigate-client');
const {initOrchestrator, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 29. Low-Battery Swap Offline Latch, Eager Boot Encoders & Service Health Split', () => {
  it(
    'Regression 29: clears stale OFFLINE_LOWBAT and OFFLINE states on >= 10% battery swaps ' +
      'within low-battery range',
    () => {
      // Regression 29: clears stale OFFLINE_LOWBAT and OFFLINE states on >= 10% battery swaps within low-battery
      // range.
      const doorbell = new Camera({serial: 'T8214T2222222222', name: 'doorbell', mode: 'backfill'});
      // 6. Battery swap recovery when device.get_properties still carries stale state=3
      // (OFFLINE_LOWBAT) or state=0 + dead RSSI
      doorbell.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 2,
          chargingStatus: 2,
          wifiRssi: -100,
          wifiSignalLevel: 1,
        },
        false
      );
      assert.equal(doorbell.isDeviceOffline(), true);
      doorbell.applyTelemetryProperties({battery: 1}, false);
      assert.equal(
        doorbell.isDeviceOffline(),
        true,
        'A 2% -> 1% property changed event without state must not clear OFFLINE_LOWBAT while still in low battery'
      );
      assert.equal(doorbell.shouldRefreshOfflineOnView(400000), true);
      assert.equal(
        doorbell.shouldRefreshOfflineOnView(500000),
        false,
        'Respects 5m (300s) refresh cooldown while offline so MSE reconnects do not spam driver.poll_refresh'
      );

      const swappedWithStaleState3 = doorbell.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 100,
          chargingStatus: 2,
          wifiRssi: -100,
          wifiSignalLevel: 1,
        },
        false
      );
      assert.equal(
        doorbell.isDeviceOffline(),
        false,
        'Must clear stale OFFLINE_LOWBAT (state=3) when battery is swapped to 100% even if ' +
          'state=3 is present in device.get_properties'
      );
      assert.equal(swappedWithStaleState3.offlineChanged, true);
      assert.equal(swappedWithStaleState3.stateChanged, true);
      assert.equal(swappedWithStaleState3.shouldRebuildCard, true);
      assert.equal(doorbell.shouldRefreshOfflineOnView(800000), false);

      // Regression: a >= 10% battery swap must also clear OFFLINE_LOWBAT / OFFLINE when the
      // replacement battery is still at or below low_battery_threshold (e.g., 2% -> 15% <= 30%),
      // while smaller fluctuations (< 10%) and initial stale state=3 at 15% remain offline.
      const lowSwapCam = new Camera({serial: 'T8161T2222222222', low_battery_threshold: 30});
      lowSwapCam.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 15,
          chargingStatus: 2,
        },
        false
      );
      assert.equal(
        lowSwapCam.isDeviceOffline(),
        true,
        'Initial state=3 at 15% with no prior battery must remain OFFLINE_LOWBAT'
      );

      const minorRiseCam = new Camera({serial: 'T8161T3333333333', low_battery_threshold: 30});
      minorRiseCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT, battery: 2, chargingStatus: 2},
        false
      );
      minorRiseCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT, battery: 5, chargingStatus: 2},
        false
      );
      assert.equal(
        minorRiseCam.isDeviceOffline(),
        true,
        'A 2% -> 5% (< 10%) rise must not clear OFFLINE_LOWBAT while still in low battery'
      );

      const partialSwapOutcome = minorRiseCam.applyTelemetryProperties(
        {
          state: EUFY_DEVICE_STATES.OFFLINE_LOWBAT,
          battery: 15,
          chargingStatus: 2,
          wifiRssi: -100,
          wifiSignalLevel: 1,
        },
        false
      );
      assert.equal(
        minorRiseCam.isDeviceOffline(),
        false,
        'A 5% -> 15% (>= 10%) battery swap must clear OFFLINE_LOWBAT even while <= 30% threshold'
      );
      assert.equal(minorRiseCam.isLowBattery(), true);
      assert.equal(partialSwapOutcome.offlineChanged, true);

      const standbySwapCam = new Camera({serial: 'T8161T4444444444', low_battery_threshold: 30});
      standbySwapCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 2, chargingStatus: 2},
        false
      );
      standbySwapCam.applyTelemetryProperties(
        {state: EUFY_DEVICE_STATES.OFFLINE, battery: 12, chargingStatus: 2},
        false
      );
      assert.equal(
        standbySwapCam.isDeviceOffline(),
        false,
        'A 2% -> 12% (>= 10%) battery swap must clear OFFLINE even while <= 30% threshold'
      );
    }
  );

  it(
    'Regression 29: starts non-offline Eufy encoders eagerly with wsConnected=false at boot and on ' +
      'start_listening failure',
    async () => {
      // Regression 29: starts non-offline Eufy encoders eagerly with wsConnected=false at boot and on start_listening
      // failure.
      const bootCam = new Camera({serial: 'T8161T9100000001', name: 'eufy_boot_cam', mode: 'rtsp'});
      const offlineCam = new Camera({serial: 'T8161T9100000002', name: 'eufy_offline_boot_cam', mode: 'rtsp'});
      offlineCam.applyTelemetryProperties({state: 3, battery: 0, chargingStatus: 2}, false);
      const alreadyRunningCam = new Camera({serial: 'T8161T9100000003', name: 'eufy_running_cam', mode: 'rtsp'});
      alreadyRunningCam.attachEncoder({stdin: {writable: true, write() {}}, kill() {}});

      const testCams = [bootCam, offlineCam, alreadyRunningCam];
      const testBySerial = new Map(testCams.map((c) => [c.getSerial(), c]));
      const resumed = [];
      let wsInst = null;

      class FailListeningWs {
        constructor() {
          this.readyState = 1;
          this.handlers = new Map();
        }
        on(ev, fn) {
          this.handlers.set(ev, fn);
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          if (cb) cb();
          const msgHandler = this.handlers.get('message');
          if (!msgHandler) return;
          queueMicrotask(() => {
            if (msg.command === 'start_listening') {
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: false,
                  errorCode: 'start_listening_failed',
                })
              );
            } else {
              msgHandler(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
            }
          });
        }
      }

      try {
        initOrchestrator(testCams, testBySerial, () => false);
        configureEufyClientHooks({
          cams: testCams,
          bySerial: testBySerial,
          isShuttingDown: () => false,
          onDeviceOnlineResume: (cam) => resumed.push(cam.getName()),
          onWsClosedStop: () => {},
          WebSocket: function MockFailListeningWs() {
            wsInst = new FailListeningWs();
            return wsInst;
          },
        });

        // 1. Eager boot helper starts non-offline Eufy encoder immediately with wsConnected=false
        ensureCameraEncodersStarted({wsConnected: false});
        assert.deepEqual(resumed, ['eufy_boot_cam']);
        assert.equal(bootCam.isWsConnected(), false);
        assert.equal(bootCam.hasServiceDisruption(), true);
        assert.equal(bootCam.prepareCardRenderContext().asleepTitle, 'Disconnected');

        // 2. When WS opens but start_listening fails while socket stays open, non-offline Eufy
        //    encoders still start with wsConnected=false
        resumed.length = 0;
        connectWs();
        configureEufyClientHooks({isShuttingDown: () => true});
        await wsInst.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        assert.equal(isWsReady(), false);
        assert.equal(bootCam.isWsConnected(), false);
        assert.deepEqual(resumed, ['eufy_boot_cam']);
      } finally {
        alreadyRunningCam.attachEncoder(null);
        configureEufyClientHooks({isShuttingDown: () => true});
        if (wsInst && wsInst.handlers.get('close')) {
          wsInst.handlers.get('close')();
        }
        configureEufyClientHooks({
          isShuttingDown: () => false,
          onDeviceOnlineResume: () => {},
          onWsClosedStop: () => {},
        });
        for (const c of testCams) {
          stop(c, 'cleanup', false, 'bridge-test');
        }
      }
    }
  );

  it(
    'Regression 29: tracks go2rtc health separately from Frigate API health during pollViewers and ' +
      'syncFrigateMotionMasks',
    async () => {
      // Regression 29: tracks go2rtc health separately from Frigate API health during pollViewers and
      // syncFrigateMotionMasks.
      const maskCam = new Camera({
        serial: 'T8161T7700000001',
        name: 'health_sep_cam',
        mode: 'rtsp',
        auto_frigate_mask: true,
        card_position: 'bottom-left',
      });
      const requestedUrls = [];
      const origFetch = global.fetch;
      const warnings = [];
      const infos = [];
      const origWarn = log.warn;
      const origInfo = log.info;
      log.warn = (scope, ...args) => {
        warnings.push(String(scope) + ': ' + args.join(' '));
      };
      log.info = (scope, ...args) => {
        infos.push(String(scope) + ': ' + args.join(' '));
      };

      try {
        // 1. Frigate /api/config returns 500 -> frigateConnected becomes false and warns once
        global.fetch = async (url) => {
          requestedUrls.push(String(url));
          return {
            ok: false,
            status: 500,
            async json() {
              return {};
            },
          };
        };
        await syncFrigateMotionMasks([maskCam], false, false, 'http://frigate.local:5000');
        await syncFrigateMotionMasks([maskCam], false, false, 'http://frigate.local:5000');
        assert.equal(maskCam.isFrigateConnected(), false);
        assert.equal(
          warnings.filter((w) => w.includes('Frigate API unreachable')).length,
          1,
          'Frigate API outage must log one edge-triggered warning until recovered'
        );

        // 2. While Frigate is still down, go2rtc responds 200 OK to pollViewers ->
        //    go2rtcConnected stays true, but frigateConnected MUST stay false and NOT trigger Frigate recovery
        requestedUrls.length = 0;
        global.fetch = async (url) => {
          requestedUrls.push(String(url));
          return {
            ok: true,
            status: 200,
            async json() {
              return {consumers: []};
            },
          };
        };
        await pollViewers([maskCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        assert.equal(maskCam.isGo2rtcConnected(), true);
        assert.equal(
          maskCam.isFrigateConnected(),
          false,
          'go2rtc answering 200 OK during pollViewers must not clear frigateConnected=false'
        );
        assert.equal(
          requestedUrls.every((u) => !u.includes('/api/config')),
          true,
          'go2rtc pollViewers must not trigger Frigate /api/config mask resync when go2rtc responds'
        );

        // 3. go2rtc outage marks go2rtcConnected=false and warns once; Frigate recovery logs info
        const maskPoly = maskCam.computeMaskPolygon();
        global.fetch = async (url) => ({
          ok: true,
          status: 200,
          async json() {
            if (String(url).includes('/api/config')) {
              return {
                cameras: {
                  health_sep_cam: {
                    motion: {mask: {eufy_bridge_card: maskPoly}},
                    objects: {mask: {eufy_bridge_card: maskPoly}},
                  },
                },
              };
            }
            return {consumers: []};
          },
        });
        await syncFrigateMotionMasks([maskCam], false, false, 'http://frigate.local:5000');
        assert.equal(
          maskCam.isFrigateConnected(),
          true,
          'Frigate /api/config recovery via syncFrigateMotionMasks must restore frigateConnected=true'
        );
        assert.equal(
          infos.some((m) => m.includes('Frigate API recovered after restart/outage')),
          true,
          'Frigate recovery must log recovery message'
        );

        global.fetch = async () => ({
          ok: false,
          status: 503,
          async json() {
            return {};
          },
        });
        await pollViewers([maskCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        await pollViewers([maskCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        assert.equal(maskCam.isGo2rtcConnected(), false);
        assert.equal(maskCam.isFrigateConnected(), true);
        assert.equal(
          warnings.filter((w) => w.includes('go2rtc API unreachable')).length,
          1,
          'go2rtc outage must log one edge-triggered warning until recovered'
        );

        global.fetch = async () => ({
          ok: true,
          status: 200,
          async json() {
            return {consumers: []};
          },
        });
        await pollViewers([maskCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        assert.equal(maskCam.isGo2rtcConnected(), true);
        assert.equal(
          infos.some((m) => m.includes('go2rtc API recovered after restart/outage')),
          true,
          'go2rtc recovery must log recovery message'
        );
      } finally {
        log.warn = origWarn;
        log.info = origInfo;
        global.fetch = async () => ({
          ok: true,
          status: 200,
          async json() {
            return {consumers: [], cameras: {}};
          },
        });
        await pollViewers([maskCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        await syncFrigateMotionMasks([maskCam], false, false, 'http://frigate.local:5000');
        global.fetch = origFetch;
      }
    }
  );
});
