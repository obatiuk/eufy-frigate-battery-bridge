/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-10`: Hardware Power Manager Sync & Stuck Spotlight (`light`) Conservation
 * (docs/acceptance/AT-10.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-10.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs, applyDeviceProperties} = require('../../src/services/eufy-client');
const {initOrchestrator} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Locked Acceptance Criterion AT-10 (docs/acceptance/AT-10.md)', () => {
  it(
    'AT-10: Serializes device.set_property calls on startup, defaults experimental track_stuck_spotlight ' +
      'to false, and detects a stuck spotlight (light=true) via the 1s idle watchdog (>130s after the light ' +
      'turned on or the last session/motion ended, never during a trigger or BackfillJob) when ' +
      'track_stuck_spotlight=true',
    async () => {
      // Verify startup property serialization, default track_stuck_spotlight=false opt-out, and >130s idle
      // spotlight recovery when track_stuck_spotlight=true
      const cam = new Camera({
        serial: 'T8161T0000000013',
        name: 'garage',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });

      let inFlight = 0;
      let maxConcurrent = 0;
      const setOrder = [];
      const bySerial = new Map([[cam.getSerial(), cam]]);
      let wsInstance = null;

      class SerializedWs {
        constructor() {
          this.readyState = 1;
          this.handlers = new Map();
        }
        on(ev, fn) {
          this.handlers.set(ev, fn);
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          if (msg.command === 'device.set_property') {
            inFlight++;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            setOrder.push(msg.name + '=' + msg.value);
            if (cb) cb();
            setTimeout(() => {
              inFlight--;
              this.handlers.get('message')(
                JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
              );
            }, 5);
            return;
          }
          if (cb) cb();
          queueMicrotask(() => {
            this.handlers.get('message')(
              JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
            );
          });
        }
      }

      initOrchestrator([cam], bySerial, () => false);
      configureEufyClientHooks({
        cams: [cam],
        bySerial,
        isShuttingDown: () => false,
        onDeviceOnlineResume: () => {},
        WebSocket: function MockSerializedWs() {
          wsInstance = new SerializedWs();
          return wsInstance;
        },
      });
      connectWs();
      configureEufyClientHooks({isShuttingDown: () => true});
      await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));

      // 1. Startup property sync serializes all set_property calls and never touches light=true
      //    (it may be a live recording light)
      applyDeviceProperties(
        cam,
        {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: false},
          light: {value: true},
          powerWorkingMode: {value: 2},
          recordingClipLength: {value: 60},
          recordingEndClipMotionStops: {value: false},
          recordingRetriggerInterval: {value: 5},
          battery: {value: 85},
        },
        false
      );
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(maxConcurrent, 1, 'device.set_property calls must never run concurrently');
      assert.deepEqual(setOrder, ['recordingClipLength=30', 'recordingEndClipMotionStops=true', 'rtspStream=true']);

      // 2. Experimental stuck-spotlight tracking defaults to false: omitted track_stuck_spotlight never
      //    turns off light=true
      const tEvent = 200000;
      cam.applyTelemetryProperties({light: false}, false, tEvent - 1000);
      cam.applyTelemetryProperties({light: true}, false, tEvent);
      cam.setSleptAt(tEvent + 5000);
      cam.setMotionClearedAt(tEvent + 5000);
      assert.equal(
        cam.shouldTurnOffStuckIdleLight(tEvent + 136000),
        false,
        'AT-10: Default track_stuck_spotlight=false must never send light=false even past 130s idle'
      );

      // 3. When track_stuck_spotlight=true is configured, post-startup stuck spotlight detection runs without
      //    requiring wifiRssi changes:
      //    Before the 130s grace -> false; after >130s while IDLE with no active triggers -> returns true!
      const trackedCam = new Camera({
        serial: 'T8161T0000000093',
        name: 'garage_spotlight',
        mode: 'backfill',
        track_stuck_spotlight: true,
        station_serial: 'T8030P0000000001',
      });
      trackedCam.applyTelemetryProperties({light: false}, false, tEvent - 1000);
      trackedCam.applyTelemetryProperties({light: true}, false, tEvent);
      trackedCam.setSleptAt(tEvent + 5000);
      trackedCam.setMotionClearedAt(tEvent + 5000);
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tEvent + 60000),
        false,
        'AT-10: Must wait the 130s grace (longer than a hardware clip) before turning off spotlight'
      );
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tEvent + 136000),
        true,
        'AT-10: Must detect stuck spotlight after >130s idle without requiring wifiRssi changes when ' +
          'track_stuck_spotlight=true'
      );
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tEvent + 137000),
        false,
        'AT-10: Must not repeatedly fire once stuck spotlight has been turned off'
      );

      // 4. A light that motion has just switched on after a long idle period is never judged
      // stuck (dark clip regression)
      const tLater = tEvent + 500000;
      trackedCam.applyTelemetryProperties({light: true}, false, tLater);
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tLater + 1000),
        false,
        'AT-10: A freshly lit spotlight must not be switched off just because earlier activity was long ago'
      );
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 120000), false);
      trackedCam.queueEventBackfill(tLater, 'motion detected', '', 'motion detected', 10, false);
      assert.equal(
        trackedCam.shouldTurnOffStuckIdleLight(tLater + 200000),
        false,
        'AT-10: Must never switch the spotlight off while a BackfillJob is pending'
      );
      trackedCam.clearPendingBackfill();
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 131000), true);
    }
  );
});
