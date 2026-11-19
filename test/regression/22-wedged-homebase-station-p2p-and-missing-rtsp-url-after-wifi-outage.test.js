/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 22. Wedged HomeBase Station P2P Session & Missing `rtspStreamUrl` After Wi-Fi
 * Outage (docs/regression/22-wedged-homebase-station-p2p-and-missing-rtsp-url-after-wifi-outage.md).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs, fetchAllCameraTelemetry} = require('../../src/services/eufy-client');
const {
  initOrchestrator,
  onEvent,
  trigger,
  runHousekeepingTick,
  stop,
} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('Regression 22. Wedged HomeBase Station P2P Session & Missing `rtspStreamUrl` After Wi-Fi Outage', () => {
  it(
    'Regression 22: recovers disconnected or wedged eufy-security-ws driver/station sessions and ' +
      'missing rtspStreamUrl after Wi-Fi outages',
    async () => {
      // Regression 22: recovers disconnected or wedged eufy-security-ws driver/station sessions and missing
      // rtspStreamUrl after Wi-Fi outages.
      const origDateNow = Date.now;
      let fakeNow = 1_760_000_000_000;
      Date.now = () => fakeNow;

      const rtspBfCam = new Camera({
        serial: 'T8161T0000000081',
        name: 'patio',
        mode: 'backfill',
        station_serial: 'T8030P0000000080',
      });
      const doorbellP2p = new Camera({
        serial: 'T8214T0000000082',
        name: 'frontdoor',
        mode: 'backfill',
        station_serial: 'T8030P0000000080',
      });
      const cams = [rtspBfCam, doorbellP2p];
      const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));

      const sentCommands = [];
      const setPropCalls = [];
      let pollRefreshFails = false;
      let stationConnectedFlag = false;
      let populatedRtspUrl = '';
      let sawRtspToggleFalse = false;
      let wsInstance = null;

      class OutageRecoveryWs {
        constructor() {
          this.readyState = 1;
          this.handlers = new Map();
        }
        on(ev, fn) {
          this.handlers.set(ev, fn);
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          sentCommands.push(msg.command);
          if (msg.command === 'device.set_property') {
            setPropCalls.push(msg.serialNumber + ':' + msg.name + '=' + msg.value);
            if (msg.name === 'rtspStream' && msg.value === false) {
              sawRtspToggleFalse = true;
            } else if (msg.name === 'rtspStream' && msg.value === true && sawRtspToggleFalse) {
              populatedRtspUrl = 'rtsp://127.0.0.1:1/live0';
            }
          }
          if (msg.command === 'station.disconnect') {
            const h = this.handlers.get('message');
            if (h) {
              h(
                JSON.stringify({
                  type: 'event',
                  event: {
                    source: 'station',
                    event: 'connection error',
                    serialNumber: msg.serialNumber,
                  },
                })
              );
            }
          }
          if (msg.command === 'station.connect') {
            stationConnectedFlag = true;
          }
          if (cb) cb();
          const msgHandler = this.handlers.get('message');
          if (!msgHandler) return;

          queueMicrotask(() => {
            if (msg.command === 'start_listening') {
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {
                    state: {
                      driver: {connected: false},
                      stations: [{serialNumber: 'T8030P0000000080', connected: false}],
                      devices: [],
                    },
                  },
                })
              );
              return;
            }
            if (msg.command === 'driver.poll_refresh' && pollRefreshFails) {
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: false,
                  errorCode: 'no_reply',
                })
              );
              return;
            }
            if (msg.command === 'station.is_connected') {
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {serialNumber: msg.serialNumber, connected: stationConnectedFlag},
                })
              );
              return;
            }
            if (msg.command === 'device.get_properties') {
              const isRtspCam = msg.serialNumber === rtspBfCam.getSerial();
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {
                    properties: isRtspCam
                      ? {
                          stationSerialNumber: {value: 'T8030P0000000080'},
                          rtspStream: {value: true},
                          rtspStreamUrl: {value: populatedRtspUrl},
                          recordingEndClipMotionStops: {value: false},
                          battery: {value: 44},
                          state: {value: 0},
                          wifiRssi: {value: -76},
                        }
                      : {
                          stationSerialNumber: {value: 'T8030P0000000080'},
                          battery: {value: 56},
                          state: {value: 0},
                          wifiRssi: {value: -27},
                        },
                  },
                })
              );
              return;
            }
            msgHandler(
              JSON.stringify({
                type: 'result',
                messageId: msg.messageId,
                success: true,
                result: {},
              })
            );
          });
        }
      }

      try {
        initOrchestrator(cams, bySerial, () => false);
        configureEufyClientHooks({
          cams,
          bySerial,
          isShuttingDown: () => false,
          onEvent,
          onDeviceOnlineResume: () => {},
          WebSocket: function MockOutageWs() {
            wsInstance = new OutageRecoveryWs();
            return wsInstance;
          },
        });
        connectWs();
        await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        configureEufyClientHooks({isShuttingDown: () => true, wsReadyAt: fakeNow - 10000});
        await flushAsync();

        // 1. Startup must reconnect disconnected driver and station before reading properties
        const driverConnectIdx = sentCommands.indexOf('driver.connect');
        const stationConnectIdx = sentCommands.indexOf('station.connect');
        const getPropsIdx = sentCommands.indexOf('device.get_properties');
        assert.ok(
          driverConnectIdx >= 0,
          'Must send driver.connect when start_listening reports driver.connected=false'
        );
        assert.ok(
          stationConnectIdx >= 0,
          'Must send station.connect when start_listening reports station.connected=false'
        );
        assert.ok(stationConnectIdx < getPropsIdx, 'Must reconnect station before querying device.get_properties');

        // 2. Failed driver.poll_refresh (no_reply) must NOT falsely clear wakeTimedOutOffline
        // and must recycle wedged driver/station
        doorbellP2p.markWakeTimedOut();
        doorbellP2p.pauseEncoderForOffline();
        assert.equal(doorbellP2p.isDeviceOffline(), true);
        pollRefreshFails = true;
        stationConnectedFlag = true;
        sentCommands.length = 0;

        await fetchAllCameraTelemetry(true);
        assert.equal(
          doorbellP2p.isDeviceOffline(),
          true,
          'Failed driver.poll_refresh must not clear wakeTimedOutOffline from stale cached properties'
        );
        assert.equal(sentCommands.includes('driver.connect'), true);
        assert.equal(sentCommands.includes('station.disconnect'), true);
        assert.equal(sentCommands.includes('station.connect'), true);
        pollRefreshFails = false;

        // 3. Station "close" marks HB:DN / service disruption; station "connect" restores HB:OK
        // and resets hardware sync flags
        onEvent({source: 'station', event: 'close', serialNumber: 'T8030P0000000080'});
        assert.equal(rtspBfCam.hasServiceDisruption(), true);
        assert.equal(rtspBfCam.buildDebugHudLines(fakeNow)[0].includes('HB:DN'), true);

        setPropCalls.length = 0;
        onEvent({source: 'station', event: 'connect', serialNumber: 'T8030P0000000080'});
        assert.equal(rtspBfCam.hasServiceDisruption(), false);
        assert.equal(rtspBfCam.buildDebugHudLines(fakeNow)[0].includes('HB:OK'), true);
        assert.equal(
          rtspBfCam.hasRecordingModeChecked(),
          false,
          'Station connect must reset one-time sync flags so dropped property writes are re-applied'
        );
        await fetchAllCameraTelemetry(false);
        await flushAsync();
        assert.equal(
          setPropCalls.includes('T8161T0000000081:recordingEndClipMotionStops=true'),
          true,
          'Reconnected station must re-sync dropped recordingEndClipMotionStops property'
        );

        // 4. RTSP wake retry when rtspStream=true but rtspStreamUrl="" reconnects disconnected
        // station and toggles rtspStream false->true
        stationConnectedFlag = false;
        populatedRtspUrl = '';
        sawRtspToggleFalse = false;
        sentCommands.length = 0;
        setPropCalls.length = 0;

        trigger(rtspBfCam, 'live view opened', 30000, 'view', 'viewer');
        runHousekeepingTick(fakeNow);
        await flushAsync();
        assert.equal(rtspBfCam.getRtspUrl(), '');

        fakeNow += 10500;
        runHousekeepingTick(fakeNow);
        await flushAsync();
        assert.equal(sentCommands.includes('station.connect'), true, 'RTSP retry must reconnect disconnected station');
        assert.equal(
          setPropCalls.includes('T8161T0000000081:rtspStream=false') &&
            setPropCalls.includes('T8161T0000000081:rtspStream=true'),
          true,
          'RTSP retry with empty rtspStreamUrl must toggle rtspStream false->true to regenerate URL'
        );
        assert.equal(rtspBfCam.getRtspUrl(), 'rtsp://127.0.0.1:1/live0');
        mock.timers.enable({apis: ['setTimeout']});
        stop(rtspBfCam, 'test cleanup', false, 'bridge');
        await flushAsync();
        mock.timers.tick(250);
        await flushAsync();

        // 5. Immediate rtspStream toggle on 'rtsp livestream started' when rtspStreamUrl is still empty,
        // and mid-wake zombie station recycle on retry 2/3 without aborting a concurrently waking
        // camera on the same station
        fakeNow += 70000;
        stationConnectedFlag = true;
        rtspBfCam.setRtspUrl('');
        populatedRtspUrl = '';
        sawRtspToggleFalse = false;
        setPropCalls.length = 0;

        trigger(rtspBfCam, 'live view opened', 30000, 'view', 'viewer');
        runHousekeepingTick(fakeNow);
        await flushAsync();
        assert.equal(rtspBfCam.getRtspUrl(), '');

        onEvent({
          source: 'device',
          event: 'rtsp livestream started',
          serialNumber: rtspBfCam.getSerial(),
        });
        await flushAsync();
        assert.equal(
          rtspBfCam.getRtspUrl(),
          'rtsp://127.0.0.1:1/live0',
          'rtsp livestream started with empty rtspStreamUrl must immediately toggle rtspStream ' +
            'false->true without waiting 10s'
        );

        // Keep rtspBfCam in WAKING_RTSP (gotVideo=false) past RTSP_HANDSHAKE_WINDOW_MS while
        // doorbellP2p wakes and hits retry 2/3
        fakeNow += 6000;
        doorbellP2p.markDeviceOnline();
        sentCommands.length = 0;

        trigger(doorbellP2p, 'live view opened', 35000, 'view', 'viewer');
        runHousekeepingTick(fakeNow);
        await flushAsync();
        fakeNow += 6000;
        runHousekeepingTick(fakeNow);
        await flushAsync();
        assert.equal(
          sentCommands.includes('station.disconnect'),
          false,
          'First P2P retry (restarts=1) must check station.is_connected before recycling'
        );

        fakeNow += 8500;
        runHousekeepingTick(fakeNow);
        await flushAsync();
        mock.timers.tick(250);
        await flushAsync();
        mock.timers.reset();
        assert.equal(
          sentCommands.includes('station.disconnect') && sentCommands.includes('station.connect'),
          true,
          'Second P2P retry (restarts=2) with zero device reply must recycle zombie station P2P session mid-wake'
        );
        assert.equal(
          rtspBfCam.isSessionActive(),
          true,
          'Self-inflicted station connection error during recoverUnresponsiveStation must not ' +
            'abort concurrently waking cameras'
        );

        // Regression: restarting eufy-security-ws or bridge while Frigate is running must not mark
        // deep-standby cameras (state=0, battery=null) offline or leave RTSP encoders stopped when
        // poll_refresh or initial WS connection fails
        const restartStationSn = 'T8030P0000000081';
        const restartCam = new Camera({
          serial: 'T8161T9000000099',
          name: 'restart_cam',
          mode: 'rtsp',
          station_serial: restartStationSn,
        });
        const restartCams = [restartCam];
        const restartBySerial = new Map([[restartCam.getSerial(), restartCam]]);
        const resumedRestartCams = [];
        let failPollRefreshOnce = true;
        class RestartWs {
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
                    success: true,
                    result: {
                      state: {
                        driver: {connected: false},
                        stations: [{serialNumber: restartStationSn, connected: false}],
                        devices: [{serialNumber: restartCam.getSerial(), state: 0}],
                      },
                    },
                  })
                );
              } else if (msg.command === 'driver.poll_refresh' && failPollRefreshOnce) {
                failPollRefreshOnce = false;
                msgHandler(
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: false,
                    errorCode: 'driver_not_connected',
                  })
                );
              } else if (msg.command === 'device.get_properties') {
                msgHandler(
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: true,
                    result: {
                      properties: {
                        state: {value: 0},
                        wifiRssi: {value: -68},
                      },
                    },
                  })
                );
              } else {
                msgHandler(
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: true,
                    result: {connected: true},
                  })
                );
              }
            });
          }
        }
        let restartWsInst = null;
        initOrchestrator(restartCams, restartBySerial, () => false);
        configureEufyClientHooks({
          cams: restartCams,
          bySerial: restartBySerial,
          isShuttingDown: () => false,
          onDeviceOnlineResume: (cam) => resumedRestartCams.push(cam.getName()),
          WebSocket: function MockRestartWs() {
            restartWsInst = new RestartWs();
            return restartWsInst;
          },
        });
        connectWs();
        configureEufyClientHooks({isShuttingDown: () => true});
        // Simulate WS closing before initial telemetry finishes when eufy-security-ws is restarting
        restartWsInst.handlers.get('close')();
        assert.equal(
          resumedRestartCams.includes('restart_cam'),
          true,
          'WS close before initial telemetry must still start encoder with Disconnected card so ' +
            'Frigate never marks camera unavailable'
        );
        resumedRestartCams.length = 0;

        // Simulate eufy-security-ws coming back up with state=0 and unpopulated battery
        await restartWsInst.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        await flushAsync();
        assert.equal(
          restartCam.isDeviceOffline(),
          false,
          'Deep-standby state=0 without battery property on service restart must not mark camera offline'
        );
        assert.equal(
          resumedRestartCams.includes('restart_cam'),
          true,
          'Service restart must resume RTSP encoder even when initial battery property is unpopulated'
        );

        // Even if a force refresh fails driver.poll_refresh while driver is reconnecting,
        // non-offline camera without encoder must still start encoder
        resumedRestartCams.length = 0;
        await fetchAllCameraTelemetry(true);
        assert.equal(
          resumedRestartCams.includes('restart_cam'),
          true,
          'Failed driver.poll_refresh during service restart must still ensure non-offline camera encoder is started'
        );
      } finally {
        stop(rtspBfCam, 'cleanup', false, 'bridge');
        stop(doorbellP2p, 'cleanup', false, 'bridge');
        Date.now = origDateNow;
      }
    }
  );
});
