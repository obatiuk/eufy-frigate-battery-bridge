/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Locked 1:1 acceptance test for `AT-10`: Non-Invasive `power_mode` & `streaming_quality` Profiles, Metadata Sync &
 * Stuck Spotlight (`light`) Conservation (docs/acceptance/AT-10.md).
 * Never weaken or delete this test without an explicit user update to docs/acceptance/AT-10.md.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs, applyDeviceProperties} = require('../../src/services/eufy-client');
const {initOrchestrator} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Locked Acceptance Criterion AT-10 (docs/acceptance/AT-10.md)', () => {
  it(
    'AT-10: Defaults power_mode and streaming_quality to non-invasive "keep" (mirroring Eufy telemetry), ' +
      'serializes opted-in grouped/custom set_property writes and metadata quality states, latches permanent ' +
      'rejections, and enforces opt-in >130s idle stuck-spotlight conservation',
    async () => {
      const keepLiveCam = new Camera({
        serial: 'T8161T0000000010',
        name: 'keep_live',
        mode: 'rtsp',
        station_serial: 'T8030P0000000001',
      });
      const keepBackfillCam = new Camera({
        serial: 'T8214T0000000011',
        name: 'keep_bf',
        mode: 'backfill',
        station_serial: 'T8030P0000000001',
      });
      const batteryCam = new Camera({
        serial: 'T8161T0000000012',
        name: 'bat_cam',
        mode: 'backfill',
        power_mode: 'battery',
        streaming_quality: 'medium',
        station_serial: 'T8030P0000000001',
      });
      const customCam = new Camera({
        serial: 'T8161T0000000013',
        name: 'custom_cam',
        mode: 'custom',
        power_mode: 'custom',
        streaming_quality: 'medium',
        station_serial: 'T8030P0000000001',
      });
      const rejectCam = new Camera({
        serial: 'T8214T0000000014',
        name: 'reject_cam',
        mode: 'custom',
        use_rtsp: false,
        power_mode: 'battery',
        streaming_quality: 9,
        station_serial: 'T8030P0000000001',
      });

      // Pre-telemetry defaults under "keep": 30s live, 20s backfill, end_early=true
      assert.equal(keepLiveCam.getEventHoldMs(), 30000);
      assert.equal(keepBackfillCam.getEventHoldMs(), 20000);
      assert.equal(keepLiveCam.shouldLetEufyDecideEnd(), true);

      let inFlight = 0;
      let maxConcurrent = 0;
      /** @type {Array<{serial: string, expr: string}>} */
      const setOrder = [];
      /** @type {Array<{scope: string, msg: string}>} */
      const warnLogs = [];
      const origLogWarn = log.warn;
      log.warn = (scope, msg) => {
        const name =
          scope && typeof scope === 'object' && typeof scope.getName === 'function'
            ? scope.getName()
            : String(scope || '');
        warnLogs.push({scope: name, msg: String(msg)});
      };
      const cams = [keepLiveCam, keepBackfillCam, batteryCam, customCam, rejectCam];
      const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
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
          if (msg.command === 'device.get_properties_metadata') {
            if (cb) cb();
            const states =
              msg.serialNumber === batteryCam.getSerial()
                ? {0: 'Auto', 1: 'Low', 2: 'Medium', 3: 'High'}
                : {0: 'Auto', 5: 'Low', 7: 'Medium', 10: 'Ultra'};
            queueMicrotask(() => {
              this.handlers.get('message')(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {properties: {videoStreamingQuality: {states}}},
                })
              );
            });
            return;
          }
          if (msg.command === 'device.set_property') {
            inFlight++;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            setOrder.push({serial: msg.serialNumber, expr: msg.name + '=' + msg.value});
            if (cb) cb();
            setTimeout(() => {
              inFlight--;
              const rejected = msg.serialNumber === rejectCam.getSerial() && msg.name === 'videoStreamingQuality';
              this.handlers.get('message')(
                JSON.stringify(
                  rejected
                    ? {type: 'result', messageId: msg.messageId, success: false, errorCode: 'device_invalid_property'}
                    : {type: 'result', messageId: msg.messageId, success: true, result: {}}
                )
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

      initOrchestrator(cams, bySerial, () => false);
      configureEufyClientHooks({
        cams,
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

      try {
        // 1. Default "keep" sends zero Power Manager / streaming_quality writes and mirrors reported Eufy telemetry
        applyDeviceProperties(
          keepLiveCam,
          {
            stationSerialNumber: {value: 'T8030P0000000001'},
            rtspStream: {value: true},
            light: {value: true},
            powerWorkingMode: {value: 1},
            recordingClipLength: {value: 60},
            recordingEndClipMotionStops: {value: true},
            recordingRetriggerInterval: {value: 5},
            videoStreamingQuality: {value: 10},
            battery: {value: 85},
          },
          false
        );
        applyDeviceProperties(
          keepBackfillCam,
          {
            stationSerialNumber: {value: 'T8030P0000000001'},
            rtspStream: {value: false},
            powerWorkingMode: {value: 2},
            recordingClipLength: {value: 45},
            recordingEndClipMotionStops: {value: false},
            recordingRetriggerInterval: {value: 5},
            videoStreamingQuality: {value: 0},
            battery: {value: 90},
          },
          false
        );
        await new Promise((r) => setTimeout(r, 30));
        assert.deepEqual(
          setOrder.filter((x) => x.serial === keepLiveCam.getSerial() || x.serial === keepBackfillCam.getSerial()),
          [],
          'AT-10: Default power_mode="keep" and streaming_quality="keep" must send zero set_property writes'
        );
        assert.deepEqual(
          warnLogs.filter((w) => w.msg.includes('overriding existing Eufy')),
          [],
          'AT-10: Default "keep" must emit zero override warnings'
        );
        assert.equal(keepLiveCam.getEventHoldMs(), 60000, 'Mirrors Optimal Surveillance (1 -> 60s)');
        assert.equal(keepLiveCam.shouldLetEufyDecideEnd(), true);
        assert.equal(keepBackfillCam.getEventHoldMs(), 45000, 'Mirrors Customize Recording clip length (45s)');
        assert.equal(keepBackfillCam.shouldLetEufyDecideEnd(), false, 'Mirrors Customize Recording end_early=false');

        // 2. Opted-in grouped ("battery" + "medium" on 0..3 scale) and custom ("custom" + "medium" on S3 scale)
        //    execute sequentially, emit clear WARN logs printing existing settings, and never touch light=true
        setOrder.length = 0;
        warnLogs.length = 0;
        applyDeviceProperties(
          batteryCam,
          {
            stationSerialNumber: {value: 'T8030P0000000001'},
            rtspStream: {value: true},
            powerWorkingMode: {value: 2},
            videoStreamingQuality: {value: 0},
            battery: {value: 85},
          },
          false
        );
        await new Promise((r) => setTimeout(r, 40));
        assert.deepEqual(
          setOrder.filter((x) => x.serial === batteryCam.getSerial()).map((x) => x.expr),
          ['powerWorkingMode=0', 'videoStreamingQuality=2'],
          'AT-10: power_mode="battery" syncs only powerWorkingMode=0 and resolves "medium"->2 from 0..3 states metadata'
        );
        const batWarns = warnLogs.filter((w) => w.scope === 'bat_cam').map((w) => w.msg);
        assert.equal(
          batWarns.some(
            (m) =>
              m.includes('overriding existing Eufy power settings with configured power_mode="battery"') &&
              m.includes('existing: powerWorkingMode=2 ("Customize Recording")') &&
              m.includes('applying: powerWorkingMode=0 ("Optimal Battery Life")')
          ),
          true,
          'AT-10: Must warn with existing power settings when overriding via power_mode="battery"'
        );
        assert.equal(
          batWarns.some(
            (m) =>
              m.includes('overriding existing Eufy streaming quality with configured streaming_quality="medium"') &&
              m.includes('existing: videoStreamingQuality=0 ("Auto")') &&
              m.includes('applying: videoStreamingQuality=2 ("Medium")')
          ),
          true,
          'AT-10: Must warn with existing quality setting and label when overriding via streaming_quality="medium"'
        );

        setOrder.length = 0;
        warnLogs.length = 0;
        maxConcurrent = 0;
        applyDeviceProperties(
          customCam,
          {
            stationSerialNumber: {value: 'T8030P0000000001'},
            rtspStream: {value: false},
            light: {value: true},
            powerWorkingMode: {value: 0},
            recordingClipLength: {value: 60},
            recordingEndClipMotionStops: {value: false},
            recordingRetriggerInterval: {value: 15},
            videoStreamingQuality: {value: 10},
            battery: {value: 85},
          },
          false
        );
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(maxConcurrent, 1, 'device.set_property calls must never run concurrently');
        assert.deepEqual(
          setOrder.filter((x) => x.serial === customCam.getSerial()).map((x) => x.expr),
          [
            'powerWorkingMode=2',
            'recordingClipLength=30',
            'recordingEndClipMotionStops=true',
            'recordingRetriggerInterval=5',
            'rtspStream=true',
            'videoStreamingQuality=7',
          ]
        );
        const customWarns = warnLogs.filter((w) => w.scope === 'custom_cam').map((w) => w.msg);
        assert.equal(
          customWarns.some(
            (m) =>
              m.includes('overriding existing Eufy power settings with configured power_mode="custom"') &&
              m.includes(
                'existing: powerWorkingMode=0 ("Optimal Battery Life"), recordingClipLength=60, ' +
                  'recordingEndClipMotionStops=false, recordingRetriggerInterval=15'
              ) &&
              m.includes(
                'applying: powerWorkingMode=2 ("Customize Recording"), recordingClipLength=30, ' +
                  'recordingEndClipMotionStops=true, recordingRetriggerInterval=5'
              )
          ),
          true,
          'AT-10: Must warn with all existing Power Manager settings when overriding via power_mode="custom"'
        );

        // 2b. Matching power_mode emits no power override warning; permanent rejection latches qualityChecked
        setOrder.length = 0;
        warnLogs.length = 0;
        const rejectProps = {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: false},
          powerWorkingMode: {value: 0},
          videoStreamingQuality: {value: 0},
          battery: {value: 80},
        };
        applyDeviceProperties(rejectCam, rejectProps, false);
        await new Promise((r) => setTimeout(r, 30));
        assert.deepEqual(
          setOrder.filter((x) => x.serial === rejectCam.getSerial()).map((x) => x.expr),
          ['videoStreamingQuality=9']
        );
        const rejectWarns = warnLogs.filter((w) => w.scope === 'reject_cam').map((w) => w.msg);
        assert.equal(
          rejectWarns.some((m) => m.includes('overriding existing Eufy power settings')),
          false,
          'AT-10: Must not emit power override warning when existing powerWorkingMode already matches target'
        );
        assert.equal(
          rejectWarns.some(
            (m) =>
              m.includes('overriding existing Eufy streaming quality with configured streaming_quality=9') &&
              m.includes('existing: videoStreamingQuality=0 -> applying: videoStreamingQuality=9')
          ),
          true,
          'AT-10: Must warn with existing numeric quality when overriding via custom integer streaming_quality'
        );
        assert.equal(rejectCam.hasQualityChecked(), true, 'Permanent rejection must latch qualityChecked');
        setOrder.length = 0;
        warnLogs.length = 0;
        applyDeviceProperties(rejectCam, rejectProps, false);
        await new Promise((r) => setTimeout(r, 30));
        assert.deepEqual(
          setOrder.filter((x) => x.serial === rejectCam.getSerial()),
          [],
          'AT-10: Permanently rejected property must not retry on subsequent polls'
        );
        assert.deepEqual(
          warnLogs.filter((w) => w.scope === 'reject_cam' && w.msg.includes('overriding existing Eufy')),
          [],
          'AT-10: Latched property check must not re-emit override warnings on subsequent polls'
        );

        // 2c. Read-only Eufy Motion Detection inspection warns when trigger_events includes camera-disabled types,
        //     stays silent when trigger_events matches enabled types, and never writes motionDetection* properties
        const matchedFilterCam = new Camera({
          serial: 'T8214T0000000015',
          name: 'matched_doorbell',
          mode: 'backfill',
          trigger_events: ['person', 'ring'],
          station_serial: 'T8030P0000000001',
        });
        const mismatchedFilterCam = new Camera({
          serial: 'T8161T0000000016',
          name: 'mismatched_driveway',
          mode: 'rtsp',
          trigger_events: ['person', 'vehicle', 'pet'],
          station_serial: 'T8030P0000000001',
        });
        setOrder.length = 0;
        warnLogs.length = 0;
        const humanOnlyDetectionProps = {
          stationSerialNumber: {value: 'T8030P0000000001'},
          rtspStream: {value: false},
          motionDetection: {value: true},
          motionDetectionTypeHuman: {value: true},
          motionDetectionTypeHumanRecognition: {value: false},
          motionDetectionTypeVehicle: {value: false},
          motionDetectionTypePet: {value: false},
          motionDetectionTypeAllOtherMotions: {value: false},
          loiteringDetection: {value: false},
          battery: {value: 90},
        };
        applyDeviceProperties(matchedFilterCam, humanOnlyDetectionProps, false);
        applyDeviceProperties(mismatchedFilterCam, {...humanOnlyDetectionProps, rtspStream: {value: true}}, false);
        await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(
          setOrder.filter((x) => x.expr.startsWith('motionDetection') || x.expr.startsWith('loiteringDetection')),
          [],
          'AT-10: Bridge must never write motionDetection* properties to the camera'
        );
        assert.deepEqual(
          warnLogs.filter((w) => w.scope === 'matched_doorbell'),
          [],
          'AT-10: Matching trigger_events=[person, ring] with motionDetectionTypeHuman=true must emit zero warnings'
        );
        const mismatchWarns = warnLogs.filter((w) => w.scope === 'mismatched_driveway').map((w) => w.msg);
        assert.equal(
          mismatchWarns.some(
            (m) =>
              m.includes('configured trigger_events includes detection types disabled in the Eufy app') &&
              m.includes('vehicle (motionDetectionTypeVehicle=false)') &&
              m.includes('pet (motionDetectionTypePet=false)') &&
              m.includes('enabled on camera: human')
          ),
          true,
          'AT-10: Must warn when configured trigger_events includes detection types disabled on the Eufy camera'
        );
        warnLogs.length = 0;
        applyDeviceProperties(mismatchedFilterCam, {...humanOnlyDetectionProps, rtspStream: {value: true}}, false);
        assert.deepEqual(
          warnLogs.filter((w) => w.scope === 'mismatched_driveway'),
          [],
          'AT-10: Identical detection mismatch must be deduplicated across subsequent telemetry polls'
        );
      } finally {
        log.warn = origLogWarn;
      }

      // 3 & 4. Experimental stuck-spotlight tracking defaults to false; >130s idle turns off light when opted in
      const tEvent = 200000;
      customCam.applyTelemetryProperties({light: false}, false, tEvent - 1000);
      customCam.applyTelemetryProperties({light: true}, false, tEvent);
      customCam.setSleptAt(tEvent + 5000);
      customCam.setMotionClearedAt(tEvent + 5000);
      assert.equal(
        customCam.shouldTurnOffStuckIdleLight(tEvent + 136000),
        false,
        'AT-10: Default track_stuck_spotlight=false must never send light=false even past 130s idle'
      );

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
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tEvent + 60000), false);
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tEvent + 136000), true);
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tEvent + 137000), false);

      const tLater = tEvent + 500000;
      trackedCam.applyTelemetryProperties({light: true}, false, tLater);
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 1000), false);
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 120000), false);
      trackedCam.queueEventBackfill(tLater, 'motion detected', '', 'motion detected', 10, false);
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 200000), false);
      trackedCam.clearPendingBackfill();
      assert.equal(trackedCam.shouldTurnOffStuckIdleLight(tLater + 131000), true);
    }
  );
});
