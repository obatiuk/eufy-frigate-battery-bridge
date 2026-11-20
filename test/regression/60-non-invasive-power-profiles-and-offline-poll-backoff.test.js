/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 60:
 * Non-Invasive `power_mode` & `streaming_quality` Profiles, Rejection Latch & `60m` Offline Poll
 * (docs/regression/60-non-invasive-power-profiles-and-offline-poll-backoff.md).
 */
'use strict';

const {describe, it, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {
  configureEufyClientHooks,
  connectWs,
  stopWsClient,
  applyDeviceProperties,
  fetchAllCameraTelemetry,
  isTrackedPropertyEvent,
} = require('../../src/services/eufy-client');
const {initOrchestrator, onEvent} = require('../../src/services/stream-orchestrator');
const {stations} = require('../../src/domain/station');

installDefaultFetchStub();

/**
 * Deterministic WebSocket fake for verifying power_mode, streaming_quality metadata, latches, and poll_refresh.
 */
class Reg60Ws extends EventEmitter {
  /**
   * @param {string} url - Target WebSocket URL.
   */
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    /** @type {Array<Record<string, *>>} */
    this.sent = [];
    Reg60Ws.lastInstance = this;
  }

  /**
   * @param {string} raw - Outbound JSON-RPC payload.
   * @param {(err?: Error|null) => void} [cb] - Optional send callback.
   */
  send(raw, cb) {
    const parsed = JSON.parse(raw);
    this.sent.push(parsed);
    if (cb) {
      cb(null);
    }
    if (Reg60Ws.onSend) {
      Reg60Ws.onSend(this, parsed);
    }
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
/** @type {Reg60Ws|null} */
Reg60Ws.lastInstance = null;
/** @type {((sock: Reg60Ws, msg: Record<string, *>) => void)|null} */
Reg60Ws.onSend = null;

/**
 * Completes handshake on Reg60Ws for cams.
 *
 * @param {Camera[]} cams - Configured Camera instances.
 * @param {(sock: Reg60Ws, msg: Record<string, *>) => void} rpcHandler - Per-command handler after handshake.
 * @returns {Promise<Reg60Ws>}
 */
async function setupReg60Ws(cams, rpcHandler) {
  const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
  initOrchestrator(cams, bySerial, () => false);
  Reg60Ws.onSend = (sock, msg) => {
    if (msg.command === 'set_api_schema') {
      queueMicrotask(() => {
        sock.emit('message', JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
      });
      return;
    }
    if (msg.command === 'start_listening') {
      queueMicrotask(() => {
        sock.emit(
          'message',
          JSON.stringify({
            type: 'result',
            messageId: msg.messageId,
            success: true,
            result: {state: {driver: {connected: true}, stations: [], devices: []}},
          })
        );
      });
      return;
    }
    rpcHandler(sock, msg);
  };

  configureEufyClientHooks({
    cams,
    bySerial,
    onEvent,
    WebSocket: Reg60Ws,
    isShuttingDown: () => false,
    onDeviceOnlineResume: () => {},
  });
  connectWs();
  const sock = Reg60Ws.lastInstance;
  assert.ok(sock);
  sock.emit('message', JSON.stringify({type: 'version', serverVersion: '1.9.9', maxSchemaVersion: 21}));
  await flushAsync(6);
  sock.sent.length = 0;
  return sock;
}

describe(
  'Regression 60: Non-Invasive power_mode & streaming_quality Profiles, ' + 'Rejection Latch & 60m Offline Poll',
  () => {
    afterEach(() => {
      configureEufyClientHooks({isShuttingDown: () => true});
      stopWsClient();
      Reg60Ws.lastInstance = null;
      Reg60Ws.onSend = null;
      configureEufyClientHooks({cams: [], bySerial: new Map(), isShuttingDown: () => false});
      stations.resetRecovery();
      stations.resetOrchestration();
    });

    it(
      'Regression 60: defaults to non-invasive keep, maps streaming_quality tiers via metadata states, ' +
        'and latches permanently rejected set_property writes without retrying',
      async () => {
        // Regression: default keep must emit zero Power Manager or streaming_quality writes, metadata states must map
        // both 0..3 and 0/5/7/10 hardware scales, and permanent rejection errorCodes must latch instead of looping.
        const keepCam = new Camera({
          serial: 'T8161T0000000060',
          name: 'storage',
          mode: 'rtsp',
          station_serial: 'T8030P0000000060',
        });
        const survCam = new Camera({
          serial: 'T8161T0000000061',
          name: 'driveway',
          mode: 'rtsp',
          power_mode: 'surveillance',
          streaming_quality: 'ultra',
          station_serial: 'T8030P0000000060',
        });
        const customRejectCam = new Camera({
          serial: 'T8161T0000000062',
          name: 'patio',
          mode: 'custom',
          use_rtsp: false,
          power_mode: 'custom',
          recording_clip_length: 40,
          recording_retrigger_interval: 15,
          station_serial: 'T8030P0000000060',
        });

        const sock = await setupReg60Ws([keepCam, survCam, customRejectCam], (wsSock, msg) => {
          queueMicrotask(() => {
            if (msg.command === 'device.get_properties_metadata') {
              wsSock.emit(
                'message',
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {
                    properties: {
                      videoStreamingQuality: {
                        states: {0: 'Auto', 1: 'Low', 2: 'Medium', 3: 'High'},
                      },
                    },
                  },
                })
              );
              return;
            }
            if (
              msg.command === 'device.set_property' &&
              msg.serialNumber === customRejectCam.getSerial() &&
              msg.name === 'recordingRetriggerInterval'
            ) {
              wsSock.emit(
                'message',
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: false,
                  errorCode: 'device_invalid_property_value',
                })
              );
              return;
            }
            wsSock.emit(
              'message',
              JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
            );
          });
        });

        // 1. keepCam: zero set_property writes when rtspStream is already true, mirrors Optimal Battery Life (0 -> 20s)
        applyDeviceProperties(
          keepCam,
          {
            stationSerialNumber: {value: 'T8030P0000000060'},
            rtspStream: {value: true},
            powerWorkingMode: {value: 0},
            recordingClipLength: {value: 20},
            recordingEndClipMotionStops: {value: true},
            recordingRetriggerInterval: {value: 5},
            videoStreamingQuality: {value: 10},
            battery: {value: 92},
          },
          false
        );
        await flushAsync(6);
        assert.equal(sock.sent.filter((m) => m.command === 'device.set_property').length, 0);
        assert.equal(keepCam.getEventHoldMs(), 20000);

        // 2. survCam: power_mode="surveillance" -> 60s hold + powerWorkingMode=1, "ultra" falls back to max 3 ("High")
        //    and emits WARN logs printing existing settings before overriding
        const {log} = require('../../src/logger');
        const survWarns = [];
        const origWarn = log.warn;
        log.warn = (_scope, msg) => {
          survWarns.push(String(msg));
        };
        try {
          assert.equal(survCam.getEventHoldMs(), 60000);
          applyDeviceProperties(
            survCam,
            {
              stationSerialNumber: {value: 'T8030P0000000060'},
              rtspStream: {value: true},
              powerWorkingMode: {value: 0},
              recordingClipLength: {value: 20},
              recordingEndClipMotionStops: {value: true},
              recordingRetriggerInterval: {value: 5},
              videoStreamingQuality: {value: 1},
              battery: {value: 80},
            },
            false
          );
          await flushAsync(8);
        } finally {
          log.warn = origWarn;
        }
        assert.deepEqual(
          sock.sent
            .filter((m) => m.command === 'device.set_property' && m.serialNumber === survCam.getSerial())
            .map((m) => m.name + '=' + m.value),
          ['powerWorkingMode=1', 'videoStreamingQuality=3']
        );
        assert.equal(
          survWarns.some(
            (m) =>
              m.includes('overriding existing Eufy power settings with configured power_mode="surveillance"') &&
              m.includes(
                'existing: powerWorkingMode=0 ("Optimal Battery Life"), recordingClipLength=20, ' +
                  'recordingEndClipMotionStops=true, recordingRetriggerInterval=5'
              ) &&
              m.includes('applying: powerWorkingMode=1 ("Optimal Surveillance")')
          ),
          true,
          'Must emit WARN with all reported existing power settings when overriding'
        );
        assert.equal(
          survWarns.some(
            (m) =>
              m.includes('overriding existing Eufy streaming quality with configured streaming_quality="ultra"') &&
              m.includes('existing: videoStreamingQuality=1 ("Low") -> applying: videoStreamingQuality=3 ("High")')
          ),
          true,
          'Must emit WARN with existing and target quality labels when overriding'
        );
        assert.ok(
          survCam.buildDebugHudLines(1_000_000)[1].includes('HW:M1/060s/EE:Y/Q3/RTSP:Y'),
          'HUD must immediately reflect confirmed set_property overrides without waiting for next 5m poll'
        );
        assert.deepEqual(survCam.toStatusSummary(1_000_000).telemetry.hardware_settings, {
          power_working_mode: 1,
          recording_clip_length: 60,
          recording_end_early: true,
          streaming_quality: 3,
        });

        // 3. customRejectCam: recordingRetriggerInterval returns device_invalid_property_value -> latches without retry
        sock.sent.length = 0;
        const customProps = {
          stationSerialNumber: {value: 'T8030P0000000060'},
          rtspStream: {value: false},
          powerWorkingMode: {value: 0},
          recordingClipLength: {value: 20},
          recordingEndClipMotionStops: {value: true},
          recordingRetriggerInterval: {value: 5},
          battery: {value: 75},
        };
        applyDeviceProperties(customRejectCam, customProps, false);
        await flushAsync(8);
        assert.equal(customRejectCam.hasRecordingModeChecked(), true);

        sock.sent.length = 0;
        applyDeviceProperties(customRejectCam, customProps, false);
        await flushAsync(6);
        assert.equal(
          sock.sent.filter((m) => m.command === 'device.set_property').length,
          0,
          'Latched recordingModeChecked must never re-send rejected recordingRetriggerInterval on subsequent polls'
        );

        // 4. Tracked Eufy motionDetection* properties emit a deduplicated WARN when active trigger_events
        //    are disabled in the Eufy app, and clear/re-warn dynamically when toggled
        assert.equal(isTrackedPropertyEvent('motionDetection'), true);
        assert.equal(isTrackedPropertyEvent('motionDetectionTypeVehicle'), true);
        const detWarns = [];
        log.warn = (_scope, msg) => {
          detWarns.push(String(msg));
        };
        try {
          applyDeviceProperties(
            keepCam,
            {
              motionDetection: {value: true},
              motionDetectionTypeHuman: {value: true},
              motionDetectionTypeHumanRecognition: {value: true},
              motionDetectionTypeVehicle: {value: false},
              motionDetectionTypePet: {value: false},
              motionDetectionTypeAllOtherMotions: {value: false},
            },
            {fullSync: false}
          );
          assert.equal(
            detWarns.some(
              (m) =>
                m.includes('default trigger_events includes detection types disabled in the Eufy app') &&
                m.includes('motion (motionDetectionTypeAllOtherMotions=false)') &&
                m.includes('vehicle (motionDetectionTypeVehicle=false)') &&
                m.includes('pet (motionDetectionTypePet=false)') &&
                m.includes('enabled on camera: human, face')
            ),
            true
          );
        } finally {
          log.warn = origWarn;
        }
      }
    );

    it(
      'Regression 60: skips background driver.poll_refresh for state=2/4/5 and ' +
        'enforces 60-minute offline cooldown',
      async (t) => {
        // Regression: manually disabled cameras (state=2) must never wake healthy siblings via driver.poll_refresh,
        // and genuine depleted-battery offline polls must wait 60 minutes between unforced refreshes.
        t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 2_000_000});
        const disabledCam = new Camera({
          serial: 'T8161T0000000063',
          name: 'disabled_cam',
          mode: 'rtsp',
          station_serial: 'T8030P0000000060',
        });
        const healthyCam = new Camera({
          serial: 'T8161T0000000064',
          name: 'healthy_cam',
          mode: 'backfill',
          station_serial: 'T8030P0000000060',
        });

        let disabledState = 2;
        const sock = await setupReg60Ws([disabledCam, healthyCam], (wsSock, msg) => {
          queueMicrotask(() => {
            if (msg.command === 'driver.poll_refresh') {
              wsSock.emit(
                'message',
                JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
              );
              return;
            }
            if (msg.command === 'device.get_properties') {
              const isDisabledTarget = msg.serialNumber === disabledCam.getSerial();
              wsSock.emit(
                'message',
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {
                    properties: isDisabledTarget
                      ? {state: {value: disabledState}, battery: {value: disabledState === 3 ? 0 : 85}}
                      : {state: {value: 1}, battery: {value: 90}},
                  },
                })
              );
            }
          });
        });

        disabledCam.applyTelemetryProperties({state: 2, battery: 85, chargingStatus: 2, wifiRssi: -68}, false);
        healthyCam.applyTelemetryProperties({state: 1, battery: 90, chargingStatus: 2, wifiRssi: -65}, false);
        assert.equal(disabledCam.isDeviceOffline(), true);
        assert.equal(disabledCam.shouldPollRefreshWhileOffline(), false);

        await fetchAllCameraTelemetry(false);
        assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 0);

        // Now simulate genuine dead battery (state=3, 0%): runs once, then waits 60m (3_600_000ms)
        disabledState = 3;
        disabledCam.applyTelemetryProperties({state: 3, battery: 0, chargingStatus: 2, wifiRssi: -100}, false);
        assert.equal(disabledCam.shouldPollRefreshWhileOffline(), true);

        const poll1 = fetchAllCameraTelemetry(false);
        await flushAsync(3);
        t.mock.timers.tick(2000);
        await flushAsync(4);
        await poll1;
        assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 1);

        t.mock.timers.tick(3_500_000);
        await fetchAllCameraTelemetry(false);
        assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 1);

        t.mock.timers.tick(100_000);
        const poll2 = fetchAllCameraTelemetry(false);
        await flushAsync(3);
        t.mock.timers.tick(2000);
        await flushAsync(4);
        await poll2;
        assert.equal(sock.sent.filter((m) => m.command === 'driver.poll_refresh').length, 2);
      }
    );
  }
);
