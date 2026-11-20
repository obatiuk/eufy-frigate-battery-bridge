/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for Eufy WebSocket property synchronization, face recognition, and low-battery polling
 * (src/services/eufy-client.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {
  extractRecognizedPerson,
  isTrackedPropertyEvent,
  call,
  applyDeviceProperties,
  configureEufyClientHooks,
  connectWs,
  fetchAllCameraTelemetry,
} = require('../../src/services/eufy-client');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('Eufy WebSocket Client, Telemetry Sync & Station Recovery (src/services/eufy-client.js)', () => {
  it(
    'extracts recognized face names while filtering Unknown/Stranger placeholders and tracks ' +
      'telemetry property events',
    async () => {
      // Verify: extracts recognized face names while filtering Unknown/Stranger placeholders and tracks telemetry
      // property events.
      assert.equal(extractRecognizedPerson({person: 'Alice'}, true), 'Alice');
      assert.equal(extractRecognizedPerson({personName: '  Bob  '}, true), 'Bob');
      assert.equal(extractRecognizedPerson({person: 'Unknown'}, true), '');
      assert.equal(extractRecognizedPerson({person: 'stranger'}, true), '');
      assert.equal(extractRecognizedPerson({person: 'Alice'}, false), '');

      assert.equal(isTrackedPropertyEvent('battery'), true);
      assert.equal(isTrackedPropertyEvent('wifiRssi'), true);
      assert.equal(isTrackedPropertyEvent('state'), true);
      assert.equal(isTrackedPropertyEvent('untrackedProp'), false);
      const {resolvePropertyTriggerEvent} = require('../../src/services/eufy-client');
      assert.equal(resolvePropertyTriggerEvent('motionDetected'), 'motion detected');
      assert.equal(resolvePropertyTriggerEvent('personDetected'), 'person detected');
      assert.equal(resolvePropertyTriggerEvent('ringing'), 'rings');
      assert.equal(resolvePropertyTriggerEvent('radarMotionDetected'), 'radar motion detected');
      assert.equal(resolvePropertyTriggerEvent('packageDelivered'), 'package delivered');
      assert.equal(resolvePropertyTriggerEvent('battery'), '');

      const closedRes = await call({command: 'device.get_properties', serialNumber: 'T8161T0000000000'});
      assert.deepEqual(closedRes, {success: false, errorCode: 'ws_closed'});
    }
  );

  it(
    'synchronizes initial device properties (RTSP URL discovery, Power Manager, streaming ' +
      'quality, and Eufy device name)',
    () => {
      // Verify: synchronizes initial device properties (RTSP URL discovery, Power Manager, streaming quality, and
      // Eufy device name).
      const autoCam = new Camera({
        serial: 'T8161T0000000000',
        name: 'garage',
        mode: 'auto',
        power_mode: 'surveillance',
        streaming_quality: 'medium',
      });
      const doorbellCam = new Camera({serial: 'T8214T2222222222', mode: 'backfill'});

      applyDeviceProperties(
        autoCam,
        {
          name: {value: 'Garage S350'},
          model: {value: 'T8161'},
          softwareVersion: {value: '3.2.1'},
          stationSerialNumber: {value: 'T8030T0000000000'},
          rtspStreamUrl: {value: 'rtsp://user:pass@192.168.1.50/live0'},
          rtspStream: {value: false},
          videoStreamingQuality: {value: 0},
          powerWorkingMode: {value: 0},
          recordingClipLength: {value: 20},
          recordingEndClipMotionStops: {value: true},
          recordingRetriggerInterval: {value: 5},
          battery: {value: 88},
          chargingStatus: {value: 4},
          wifiSignalLevel: {value: 4},
          wifiRssi: {value: -58},
          batteryTemperature: {value: 21},
        },
        false
      );

      assert.equal(autoCam.isRtspCapable(), true);
      assert.equal(autoCam.getStationSerial(), 'T8030T0000000000');
      assert.equal(autoCam.getDisplayTitle(), 'Garage S350');
      assert.equal(autoCam.getBatteryPct(), 88);
      assert.equal(autoCam.isCharging(), true);
      assert.equal(autoCam.getPowerLabel(), 'Solar');
      assert.equal(autoCam.hasQualityChecked(), false, 'Unconfirmed writes with closed WS must not latch quality flag');
      assert.equal(
        autoCam.hasRecordingModeChecked(),
        false,
        'Unconfirmed writes with closed WS must not latch Power Manager flag'
      );
      assert.equal(
        autoCam.hasRtspPropertyChecked(),
        false,
        'Unconfirmed writes with closed WS must not latch rtspStream flag'
      );

      applyDeviceProperties(
        doorbellCam,
        {
          name: {value: 'Front Doorbell E340'},
          model: {value: 'T8214'},
          stationSerialNumber: {value: 'T8030T0000000000'},
          battery: {value: 64},
        },
        false
      );

      assert.equal(doorbellCam.isRtspCapable(), false, 'Non-RTSP doorbell in backfill mode uses P2P for Live View');
      assert.equal(doorbellCam.hasRtspPropertyChecked(), false);
      assert.equal(doorbellCam.getStationSerial(), 'T8030T0000000000');
      assert.equal(doorbellCam.getDisplayTitle(), 'Front Doorbell E340');

      // Offline transition while sleeping stops attached encoder immediately so Frigate shows device offline
      let encKilled = false;
      doorbellCam.attachEncoder({
        kill() {
          encKilled = true;
        },
      });
      applyDeviceProperties(
        doorbellCam,
        {
          state: {value: 3},
          battery: {value: 0},
          chargingStatus: {value: 2},
        },
        false
      );
      assert.equal(doorbellCam.isDeviceOffline(), true);
      assert.equal(encKilled, true);
      assert.equal(doorbellCam.hasEncoderProcess(), false);

      // Online recovery clears offline state and marks encoder ready to resume
      applyDeviceProperties(
        doorbellCam,
        {
          state: {value: 1},
          battery: {value: 85},
        },
        true
      );
      assert.equal(doorbellCam.isDeviceOffline(), false);
      assert.equal(doorbellCam.shouldResumeOfflineEncoder(), true);

      // Camera already offline on startup with no cached snapshot (or sleep_screen !== 'snapshot')
      // never starts encoder or streams anything
      const startupOfflineNoSnapCam = new Camera({
        serial: 'T8214T8888888888',
        name: 'offline_no_snap',
        sleep_screen: 'snapshot',
      });
      let resumedCams = [];
      configureEufyClientHooks({
        onDeviceOnlineResume: (cam) => resumedCams.push(cam.getName()),
      });
      applyDeviceProperties(
        startupOfflineNoSnapCam,
        {state: {value: 3}, battery: {value: 0}, chargingStatus: {value: 2}},
        true
      );
      assert.equal(startupOfflineNoSnapCam.isDeviceOffline(), true);
      assert.equal(startupOfflineNoSnapCam.isSeedingOfflineSnapshot(), false);
      assert.equal(startupOfflineNoSnapCam.hasEncoderProcess(), false);
      assert.deepEqual(resumedCams, []);

      // Camera already offline on startup seeds cached snapshot before stopping encoder when sleep_screen="snapshot"
      const startupOfflineSnapCam = new Camera(
        {serial: 'T8214T9999999999', name: 'offline_doorbell', sleep_screen: 'snapshot'},
        {frame: Buffer.alloc(FRAME, 0x22), lastSeen: '09:30'}
      );
      let startupSnapWritten = 0;
      startupOfflineSnapCam.attachEncoder({
        stdin: {
          writable: true,
          writableNeedDrain: false,
          write() {
            startupSnapWritten++;
          },
        },
        kill() {},
      });
      applyDeviceProperties(
        startupOfflineSnapCam,
        {state: {value: 3}, battery: {value: 0}, chargingStatus: {value: 2}},
        true
      );
      assert.equal(startupOfflineSnapCam.isDeviceOffline(), true);
      assert.equal(startupOfflineSnapCam.isSeedingOfflineSnapshot(), true);
      assert.equal(startupSnapWritten > 0, true);
      assert.deepEqual(resumedCams, []);
      startupOfflineSnapCam.clearOfflineSeedTimer();

      // Online camera on startup triggers onDeviceOnlineResume to start its encoder
      const startupOnlineCam = new Camera({serial: 'T8161T7777777777', name: 'online_cam'});
      applyDeviceProperties(startupOnlineCam, {state: {value: 1}, battery: {value: 95}, wifiRssi: {value: -65}}, true);
      assert.equal(startupOnlineCam.isDeviceOffline(), false);
      assert.deepEqual(resumedCams, ['online_cam']);
      configureEufyClientHooks({onDeviceOnlineResume: () => {}});
    }
  );

  it(
    'does not invoke driver.poll_refresh during background fetchAllCameraTelemetry(false) ' +
      'polls when a camera is in low-battery mode',
    async () => {
      // Verify: does not invoke driver.poll_refresh during background fetchAllCameraTelemetry(false) polls when a
      // camera is in low-battery mode.
      const lowBatDoorbell = new Camera({
        serial: 'T8214T2222222222',
        title: 'Front Doorbell',
        mode: 'backfill',
      });
      lowBatDoorbell.applyTelemetryProperties({battery: 9, wifiRssi: -26}, false);
      assert.equal(lowBatDoorbell.isLowBattery(), true);

      const sentCommands = [];
      class FakeWs {
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
          if (cb) cb();
          const msgHandler = this.handlers.get('message');
          if (msgHandler) {
            queueMicrotask(() => {
              if (msg.command === 'start_listening') {
                msgHandler(
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: true,
                    result: {state: {devices: []}},
                  })
                );
              } else {
                msgHandler(
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: true,
                    result: {properties: {battery: {value: 9}, wifiRssi: {value: -26}}},
                  })
                );
              }
            });
          }
        }
      }

      let wsInstance = null;
      configureEufyClientHooks({
        cams: [lowBatDoorbell],
        bySerial: new Map([[lowBatDoorbell.getSerial(), lowBatDoorbell]]),
        isShuttingDown: () => true,
        WebSocket: function MockWs() {
          wsInstance = new FakeWs();
          return wsInstance;
        },
      });

      // Temporarily allow connectWs to run once
      configureEufyClientHooks({isShuttingDown: () => false});
      connectWs();
      configureEufyClientHooks({isShuttingDown: () => true});

      await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));

      sentCommands.length = 0;
      await fetchAllCameraTelemetry(false);

      assert.equal(
        sentCommands.includes('driver.poll_refresh'),
        false,
        'Background fetchAllCameraTelemetry(false) must not wake cameras via driver.poll_refresh when low battery'
      );
      assert.deepEqual(sentCommands, ['device.get_properties']);
    }
  );
});
