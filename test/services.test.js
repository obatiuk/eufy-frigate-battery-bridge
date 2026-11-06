/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Enterprise unit test suite for services & logging: frigate-client, http-server, eufy-client, and logger.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';
process.env.CACHE_DIR = '/tmp';

const {FRAME} = require('../src/config');
const {Camera} = require('../src/domain/camera');
const {
  BACKFILL_SNAP_DELAY_MS,
  buildFrigateMaskPayload,
  isFrigateMaskIntact,
  resolveFrigateEventLabel,
  computeRequiredSnapshotDelay,
  classifyViewerAction,
  syncFrigateMotionMasks,
  pollViewers,
} = require('../src/services/frigate-client');
const {notifyHA} = require('../src/services/ha-notifier');
const {
  normalizeLookupKey,
  resolveTargetCameras,
  buildHealthPayload,
  buildConfigPayload,
} = require('../src/services/http-server');
const {
  configureEufyClientHooks,
  connectWs,
  fetchAllCameraTelemetry,
  isTrackedPropertyEvent,
  extractRecognizedPerson,
  applyDeviceProperties,
  call,
} = require('../src/services/eufy-client');
const {
  initOrchestrator,
  wakeCameraExternal,
  processBackfillQueue,
  runHousekeepingTick,
  trigger,
  stop,
  onEvent,
} = require('../src/services/stream-orchestrator');
const {
  log,
  formatLocalTimestamp,
  formatLocalHm,
  normalizeLevelName,
  formatLogLine,
  initLogger,
} = require('../src/logger');

describe('Frigate & go2rtc Service Helpers (src/services/frigate-client.js)', () => {
  it('builds and verifies Frigate motion and object mask payloads across string and array coordinate formats', () => {
    const poly = '0.015,0.920,0.220,0.920,0.220,0.985,0.015,0.985';

    const payload = buildFrigateMaskPayload('driveway', 'motion', true, poly);
    assert.equal(payload.requires_restart, 0);
    assert.equal(payload.update_topic, 'config/cameras/driveway/motion');
    assert.equal(
      payload.config_data.cameras.driveway.motion.mask.eufy_bridge_card.coordinates,
      poly
    );

    assert.equal(isFrigateMaskIntact({enabled: true, coordinates: poly}, poly), true);
    assert.equal(isFrigateMaskIntact({enabled: true, coordinates: [poly]}, poly), true);
    assert.equal(isFrigateMaskIntact({enabled: false, coordinates: poly}, poly), false);
    assert.equal(isFrigateMaskIntact({enabled: true, coordinates: '0.1,0.1'}, poly), false);
    assert.equal(isFrigateMaskIntact(null, poly), false);
  });

  it('auto-syncs Frigate motion.mask and objects.mask via GET /api/config and PUT /api/config/set', async () => {
    const applyCam = new Camera({
      serial: 'T8161T0000000000',
      name: 'driveway',
      card_theme: 'icons',
      card_position: 'bottom-left',
      auto_frigate_mask: true,
    });
    const intactCam = new Camera({
      serial: 'T8161T1111111111',
      name: 'garage',
      card_theme: 'minimal',
      card_position: 'top-right',
      auto_frigate_mask: true,
    });
    const disableCam = new Camera({
      serial: 'T8214T2222222222',
      name: 'doorbell',
      card_theme: 'none',
      auto_frigate_mask: true,
    });

    const intactPoly = intactCam.computeMaskPolygon();
    const putCalls = [];
    const origFetch = global.fetch;

    global.fetch = async (url, opts = {}) => {
      if (String(url).endsWith('/api/config')) {
        return {
          ok: true,
          async json() {
            return {
              cameras: {
                driveway: {
                  motion: {mask: {}},
                  objects: {mask: {}},
                },
                garage: {
                  motion: {mask: {eufy_bridge_card: {enabled: true, coordinates: intactPoly}}},
                  objects: {mask: {eufy_bridge_card: {enabled: true, coordinates: [intactPoly]}}},
                },
                doorbell: {
                  motion: {mask: {eufy_bridge_card: {enabled: true, coordinates: intactPoly}}},
                  objects: {mask: {eufy_bridge_card: {enabled: true, coordinates: intactPoly}}},
                },
              },
            };
          },
        };
      }
      if (String(url).includes('/api/config/set')) {
        putCalls.push(JSON.parse(opts.body));
        return {
          ok: true,
          async text() {
            return '';
          },
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    try {
      await syncFrigateMotionMasks([applyCam, intactCam, disableCam], true, false, 'http://frigate.local:5000');
    } finally {
      global.fetch = origFetch;
    }

    // driveway: applies motion and objects masks; doorbell: disables stale motion and objects masks; garage: already intact (0 PUTs)
    assert.equal(putCalls.length, 4);
    assert.equal(putCalls[0].update_topic, 'config/cameras/driveway/motion');
    assert.equal(putCalls[0].config_data.cameras.driveway.motion.mask.eufy_bridge_card.enabled, true);
    assert.equal(
      putCalls[0].config_data.cameras.driveway.motion.mask.eufy_bridge_card.coordinates,
      applyCam.computeMaskPolygon()
    );
    assert.equal(putCalls[1].update_topic, 'config/cameras/driveway/objects');
    assert.equal(putCalls[1].config_data.cameras.driveway.objects.mask.eufy_bridge_card.enabled, true);

    assert.equal(putCalls[2].update_topic, 'config/cameras/doorbell/motion');
    assert.equal(putCalls[2].config_data.cameras.doorbell.motion.mask.eufy_bridge_card.enabled, false);
    assert.equal(putCalls[3].update_topic, 'config/cameras/doorbell/objects');
    assert.equal(putCalls[3].config_data.cameras.doorbell.objects.mask.eufy_bridge_card.enabled, false);
  });

  it('maps Eufy event strings to Frigate detection labels and computes mode-specific snapshot delays', () => {
    assert.equal(resolveFrigateEventLabel('person detected'), 'person');
    assert.equal(resolveFrigateEventLabel('identity person detected'), 'person');
    assert.equal(resolveFrigateEventLabel('stranger person detected'), 'person');
    assert.equal(resolveFrigateEventLabel('pet detected'), 'dog');
    assert.equal(resolveFrigateEventLabel('vehicle detected'), 'car');
    assert.equal(resolveFrigateEventLabel('rings'), 'person');
    assert.equal(resolveFrigateEventLabel('test signal'), 'test');
    assert.equal(resolveFrigateEventLabel('motion detected'), 'motion');

    assert.equal(computeRequiredSnapshotDelay('download'), BACKFILL_SNAP_DELAY_MS);
    assert.ok(computeRequiredSnapshotDelay('p2p') >= 1000);
  });

  it('classifies all 6 go2rtc viewer connection branches (wake, extend, grid, live-join, motion-blocked, eco-blocked, cooldown)', () => {
    // 1. Sleeping camera + single viewer -> wakes the camera
    assert.deepEqual(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: false,
      }),
      {asked: true, actionDesc: 'waking the camera'}
    );

    // 2. Active live-view session -> extends active live view
    assert.deepEqual(
      classifyViewerAction({
        camActive: true,
        alreadyViewing: true,
        isDashboardGrid: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: false,
      }),
      {asked: true, actionDesc: 'extending active live view'}
    );

    // 3. Multi-camera dashboard grid view -> ignored
    assert.deepEqual(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: true,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: false,
      }),
      {asked: false, actionDesc: 'ignored, multi-camera dashboard grid view'}
    );

    // 4. Camera active on motion or backfill download (!alreadyViewing) -> joined while live, does not extend it
    assert.deepEqual(
      classifyViewerAction({
        camActive: true,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: false,
      }),
      {asked: false, actionDesc: 'joined while live, does not extend it'}
    );

    // 5. Blocked by another P2P camera with active motion on the same station
    assert.deepEqual(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByP2pMotion: true,
        activeMotionCamName: 'front_doorbell',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: false,
      }),
      {asked: false, actionDesc: 'ignored, front_doorbell is active with P2P motion/event'}
    );

    // 6. Blocked by Low-Battery Economy Mode
    assert.deepEqual(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: true,
        batteryPct: 12,
        inCooldown: false,
      }),
      {asked: false, actionDesc: 'ignored, camera is in low-battery economy mode (12%)'}
    );

    // 7. Blocked by post-sleep viewer cooldown
    assert.deepEqual(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 80,
        inCooldown: true,
      }),
      {asked: false, actionDesc: 'ignored, camera just went to sleep (cooldown)'}
    );

    // 8. Blocked because camera is offline / battery depleted
    assert.deepEqual(
      classifyViewerAction({
        camActive: false,
        alreadyViewing: false,
        isDashboardGrid: false,
        blockedByOffline: true,
        offlineReason: 'battery depleted (0%)',
        blockedByP2pMotion: false,
        activeMotionCamName: '',
        blockedByEco: false,
        batteryPct: 0,
        inCooldown: false,
      }),
      {asked: false, actionDesc: 'ignored, camera is offline (battery depleted (0%))'}
    );

    // 9. Blocked while IDLE with a pending HomeBase BackfillJob
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
  });

  it('allows viewer wake during cooldown when hardware triggers active (Regression #18)', () => {
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
    cam.lastMotionAt = t0 + 11000;
    cam.motionUntil = t0 + 11000 + 20000;
    cam.motionClearedAt = 0;
    cam.activeTriggerEvents.add('person');

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

  it('still blocks cooldown wake without hardware triggers (Regression #18)', () => {
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

describe('HTTP Wake Target Resolution & Eufy RPC Helpers (src/services/http-server.js & eufy-client.js)', () => {
  it('resolves "all", comma-separated names, hardware serials, and slugified titles without duplicates', () => {
    const cam1 = new Camera({serial: 'T8161T0000000000', name: 'driveway', title: 'Front Driveway'});
    const cam2 = new Camera({serial: 'T8214T2222222222', name: 'doorbell', title: 'Main Entrance Doorbell'});
    const cams = [cam1, cam2];

    assert.equal(normalizeLookupKey('Front Driveway'), 'front_driveway');
    assert.deepEqual(resolveTargetCameras('all', cams), [cam1, cam2]);
    assert.deepEqual(resolveTargetCameras('T8214T2222222222', cams), [cam2]);
    assert.deepEqual(resolveTargetCameras('front-driveway,doorbell,driveway', cams), [cam1, cam2]);
    assert.deepEqual(resolveTargetCameras('nonexistent_cam', cams), []);

    const health = buildHealthPayload(cams, false, 1000, 5000);
    assert.equal('version' in health, false);
    assert.equal('commit' in health, false);
    assert.equal(health.uptime_secs, 4);

    cam1.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://admin:secret@192.168.1.50/live0');
    const cfgPayload = buildConfigPayload(cams);
    assert.equal(typeof cfgPayload.version, 'string');
    assert.ok(cfgPayload.version.length > 0);
    assert.equal(typeof cfgPayload.commit, 'string');
    assert.ok(cfgPayload.commit.length > 0);
    assert.equal(typeof cfgPayload.log_level, 'string');
    assert.equal(typeof cfgPayload.live_fps, 'number');
    assert.equal(typeof cfgPayload.idle_fps, 'number');
    assert.equal(typeof cfgPayload.backfill_enabled, 'boolean');
    assert.equal(cfgPayload.track_stuck_spotlight, false);
    assert.equal(typeof cfgPayload.view_has_priority, 'boolean');
    assert.equal(typeof cfgPayload.snapshot_capture_delay_secs, 'number');
    assert.equal(typeof cfgPayload.view_cooldown_secs, 'number');
    assert.equal(Array.isArray(cfgPayload.cameras), true);
    assert.equal(cfgPayload.cameras.length, 2);
    assert.equal(cfgPayload.cameras[0].name, 'driveway');
    assert.equal(cfgPayload.cameras[0].track_stuck_spotlight, false);
    assert.equal(cfgPayload.cameras[0].homebase_rtsp_url, 'rtsp://***@192.168.1.50/live0');
    assert.equal(cfgPayload.cameras[0].hold_secs, 60);
    assert.equal(cfgPayload.cameras[1].name, 'doorbell');
  });

  it('extracts recognized face names while filtering Unknown/Stranger placeholders and tracks telemetry property events', async () => {
    assert.equal(extractRecognizedPerson({person: 'Alice'}, true), 'Alice');
    assert.equal(extractRecognizedPerson({personName: '  Bob  '}, true), 'Bob');
    assert.equal(extractRecognizedPerson({person: 'Unknown'}, true), '');
    assert.equal(extractRecognizedPerson({person: 'stranger'}, true), '');
    assert.equal(extractRecognizedPerson({person: 'Alice'}, false), '');

    assert.equal(isTrackedPropertyEvent('battery'), true);
    assert.equal(isTrackedPropertyEvent('wifiRssi'), true);
    assert.equal(isTrackedPropertyEvent('state'), true);
    assert.equal(isTrackedPropertyEvent('untrackedProp'), false);
    const {resolvePropertyTriggerEvent} = require('../src/services/eufy-client');
    assert.equal(resolvePropertyTriggerEvent('motionDetected'), 'motion detected');
    assert.equal(resolvePropertyTriggerEvent('personDetected'), 'person detected');
    assert.equal(resolvePropertyTriggerEvent('ringing'), 'rings');
    assert.equal(resolvePropertyTriggerEvent('radarMotionDetected'), 'radar motion detected');
    assert.equal(resolvePropertyTriggerEvent('packageDelivered'), 'package delivered');
    assert.equal(resolvePropertyTriggerEvent('battery'), '');

    const closedRes = await call({command: 'device.get_properties', serialNumber: 'T8161T0000000000'});
    assert.deepEqual(closedRes, {success: false, errorCode: 'ws_closed'});
  });

  it('synchronizes initial device properties (RTSP URL discovery, Power Manager, streaming quality, and Eufy device name)', () => {
    const autoCam = new Camera({serial: 'T8161T0000000000', name: 'garage', mode: 'auto'});
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
    assert.equal(autoCam.stationSerial, 'T8030T0000000000');
    assert.equal(autoCam.getDisplayTitle(), 'Garage S350');
    assert.equal(autoCam.telemetry.battery, 88);
    assert.equal(autoCam.telemetry.charging, true);
    assert.equal(autoCam.telemetry.powerLabel, 'Solar');
    assert.equal(autoCam.telemetry.qualityChecked, true);
    assert.equal(autoCam.telemetry.recordingModeChecked, true);
    assert.equal(autoCam.rtspEnabledChecked, true);

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
    assert.equal(doorbellCam.rtspEnabledChecked, false);
    assert.equal(doorbellCam.stationSerial, 'T8030T0000000000');
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

    // Camera already offline on startup with no cached snapshot (or sleep_screen !== 'snapshot') never starts encoder or streams anything
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
    applyDeviceProperties(
      startupOnlineCam,
      {state: {value: 1}, battery: {value: 95}, wifiRssi: {value: -65}},
      true
    );
    assert.equal(startupOnlineCam.isDeviceOffline(), false);
    assert.deepEqual(resumedCams, ['online_cam']);
    configureEufyClientHooks({onDeviceOnlineResume: () => {}});
  });

  it('does not invoke driver.poll_refresh during background fetchAllCameraTelemetry(false) polls when a camera is in low-battery mode', async () => {
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

    await wsInstance.handlers.get('message')(
      JSON.stringify({type: 'version', maxSchemaVersion: 21})
    );

    sentCommands.length = 0;
    await fetchAllCameraTelemetry(false);

    assert.equal(
      sentCommands.includes('driver.poll_refresh'),
      false,
      'Background fetchAllCameraTelemetry(false) must not wake cameras via driver.poll_refresh when low battery'
    );
    assert.deepEqual(sentCommands, ['device.get_properties']);
  });

  it('automatically polls HomeBase for battery swap recovery when any camera is offline via pollViewers, /api/wake, or background telemetry poll', async () => {
    const onlineCam1 = new Camera({
      serial: 'T8161T0000000000',
      name: 'driveway',
      mode: 'rtsp',
      station_serial: 'T8030P0000000000',
    });
    const onlineCam2 = new Camera({
      serial: 'T8161T1111111111',
      name: 'backyard',
      mode: 'rtsp',
      station_serial: 'T8030P0000000000',
    });
    const offlineDoorbell = new Camera({
      serial: 'T8214T2222222222',
      name: 'doorbell',
      mode: 'backfill',
      station_serial: 'T8030P0000000000',
    });
    const cams = [onlineCam1, onlineCam2, offlineDoorbell];
    const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));

    onlineCam1.applyTelemetryProperties({state: 1, battery: 100, wifiRssi: -70}, false);
    onlineCam2.applyTelemetryProperties({state: 1, battery: 95, wifiRssi: -71}, false);
    offlineDoorbell.applyTelemetryProperties(
      {state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100},
      false
    );
    offlineDoorbell.pauseEncoderForOffline();
    assert.equal(offlineDoorbell.isDeviceOffline(), true);

    // 1. pollViewers: opening Frigate multi-camera dashboard grid (viewers on onlineCam1 & onlineCam2, 0 consumers on offlineDoorbell)
    // must still detect that offlineDoorbell is offline and trigger fetchAllCameraTelemetry(true)
    const origFetch = global.fetch;
    let telemetryForceRefreshes = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('src=driveway')) {
        return {
          ok: true,
          async json() {
            return {
              consumers: [
                {id: 'frigate-rec-1', user_agent: 'FFmpeg Frigate'},
                {id: 'browser-1', user_agent: 'Mozilla/5.0', format_name: 'mse'},
              ],
            };
          },
        };
      }
      if (u.endsWith('src=backyard')) {
        return {
          ok: true,
          async json() {
            return {
              consumers: [{id: 'browser-2', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {consumers: []};
        },
      };
    };

    try {
      await pollViewers(cams, {
        isShuttingDown: () => false,
        fetchAllCameraTelemetry: (force) => {
          if (force) telemetryForceRefreshes++;
        },
        stopCam: () => {},
        triggerCam: () => {},
      });
    } finally {
      global.fetch = origFetch;
    }

    assert.equal(
      telemetryForceRefreshes,
      1,
      'Opening Frigate dashboard grid on online cameras must trigger HomeBase poll_refresh when another camera is offline'
    );

    // 2. /api/wake/:cameras hook on an offline camera triggers an immediate HomeBase poll_refresh and recovers encoder
    const sentCommands = [];
    const resumedCams = [];
    let stopNotRunningOnce = false;
    class RecoveryWs {
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
            } else if (msg.command === 'device.get_properties') {
              const isDoorbell = msg.serialNumber === offlineDoorbell.getSerial();
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {
                    properties: isDoorbell
                      ? {state: {value: 3}, battery: {value: 100}, wifiRssi: {value: -100}}
                      : {state: {value: 1}, battery: {value: 100}, wifiRssi: {value: -70}},
                  },
                })
              );
            } else if (msg.command === 'device.stop_livestream' && stopNotRunningOnce) {
              stopNotRunningOnce = false;
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: false,
                  errorCode: 'device_livestream_not_running',
                })
              );
            } else {
              msgHandler(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {},
                })
              );
            }
          });
        }
      }
    }

    let wsInstance = null;
    initOrchestrator(cams, bySerial, () => false);
    configureEufyClientHooks({
      cams,
      bySerial,
      isShuttingDown: () => false,
      onDeviceOnlineResume: (cam) => resumedCams.push(cam.getName()),
      WebSocket: function MockRecoveryWs() {
        wsInstance = new RecoveryWs();
        return wsInstance;
      },
    });
    connectWs();
    configureEufyClientHooks({isShuttingDown: () => true});

    // Reset offline state after initial connectWs so we test wakeCameraExternal / fetchAllCameraTelemetry(false) while offline
    await wsInstance.handlers.get('message')(
      JSON.stringify({type: 'version', maxSchemaVersion: 21})
    );

    offlineDoorbell.applyTelemetryProperties(
      {state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100},
      false
    );
    offlineDoorbell.pauseEncoderForOffline();
    offlineDoorbell.telemetry.lastLowBatRefreshAt = 0;
    sentCommands.length = 0;
    resumedCams.length = 0;

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

    // 3. Background fetchAllCameraTelemetry(false) when a camera is genuinely offline (state=3 / dead battery) auto-upgrades to driver.poll_refresh to detect battery swaps
    offlineDoorbell.applyTelemetryProperties(
      {state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100},
      false
    );
    offlineDoorbell.pauseEncoderForOffline();
    offlineDoorbell.telemetry.lastLowBatRefreshAt = 0;
    sentCommands.length = 0;
    resumedCams.length = 0;

    await fetchAllCameraTelemetry(false);
    assert.equal(
      sentCommands.includes('driver.poll_refresh'),
      true,
      'fetchAllCameraTelemetry(false) must invoke driver.poll_refresh when a camera is genuinely offline to detect battery replacement'
    );
    assert.equal(offlineDoorbell.isDeviceOffline(), false);
    assert.equal(resumedCams.includes('doorbell'), true);

    // 4. Trailing or unsolicited 'livestream video data' while inactive must never self-adopt as an external P2P wake; past 3s it must send device.stop_livestream
    const stopNow = Date.now();
    offlineDoorbell.encoderStoppedForOffline = false;
    offlineDoorbell.beginSession('p2p', stopNow - 30000, true);
    offlineDoorbell.gotVideo = true;
    offlineDoorbell.terminateSession(stopNow - 100, 'hold/view timer expired', false, 'bridge-timer');
    if (typeof offlineDoorbell.clearP2pStopInFlight === 'function') {
      offlineDoorbell.clearP2pStopInFlight();
    }
    sentCommands.length = 0;

    onEvent({
      event: 'livestream video data',
      serialNumber: offlineDoorbell.getSerial(),
      buffer: {data: [0, 0, 0, 1, 0x65]},
    });
    assert.equal(
      offlineDoorbell.isSessionActive(),
      false,
      'Trailing livestream video data 100ms after bridge-timer stop must not re-wake camera'
    );

    offlineDoorbell.sleptAt = stopNow - 4000;
    offlineDoorbell.lastStoppedAt = stopNow - 4000;
    offlineDoorbell.unsolicitedStopAt = 0;
    sentCommands.length = 0;
    onEvent({
      event: 'livestream video data',
      serialNumber: offlineDoorbell.getSerial(),
      buffer: {data: [0, 0, 0, 1, 0x65]},
    });
    assert.equal(
      offlineDoorbell.isSessionActive(),
      false,
      'Unsolicited livestream video data 4s after stop must not self-adopt as an external wake'
    );
    assert.equal(
      sentCommands.includes('device.stop_livestream'),
      true,
      'Unsolicited livestream video data 4s after stop must send device.stop_livestream to stop the camera'
    );

    // 5. Idle wedged P2P radio at 3% low-battery economy mode:
    //    - Viewer connecting in low-battery economy mode (online) must NOT call fetchAllCameraTelemetry(true) / driver.poll_refresh
    //    - 4 rapid wifiRssi property changes >15s after stop sends only device.stop_livestream (never device.start_livestream)
    await new Promise((r) => setTimeout(r, 20));
    offlineDoorbell.applyTelemetryProperties({state: 1, battery: 3, wifiRssi: -24, temperature: 30}, false);
    offlineDoorbell.telemetry.lastLowBatRefreshAt = 0;
    let lowBatViewerForceRefreshes = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('src=doorbell')) {
        return {
          ok: true,
          async json() {
            return {
              consumers: [{id: 'mse-probe-1', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {consumers: []};
        },
      };
    };
    try {
      await pollViewers(cams, {
        isShuttingDown: () => false,
        fetchAllCameraTelemetry: (force) => {
          if (force) lowBatViewerForceRefreshes++;
        },
        stopCam: () => {},
        triggerCam: () => {},
      });
    } finally {
      global.fetch = origFetch;
    }
    assert.equal(
      lowBatViewerForceRefreshes,
      0,
      'MSE viewer connecting to an online camera in low-battery economy mode (3%) must not call driver.poll_refresh'
    );

    offlineDoorbell.sleptAt = Date.now() - 30000;
    offlineDoorbell.lastStoppedAt = Date.now() - 30000;
    offlineDoorbell.lastWedgedRadioStopAt = 0;
    stopNotRunningOnce = true;
    sentCommands.length = 0;

    for (const rssi of [-25, -24, -25, -24]) {
      onEvent({
        event: 'property changed',
        serialNumber: offlineDoorbell.getSerial(),
        name: 'wifiRssi',
        value: rssi,
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      offlineDoorbell.isSessionActive(),
      false,
      'Un-wedging an idle P2P radio must not leave the camera session active'
    );
    assert.deepEqual(
      sentCommands.filter(
        (c) =>
          c === 'device.stop_livestream' ||
          c === 'device.cancel_download' ||
          c === 'station.disconnect' ||
          c === 'device.start_livestream'
      ),
      ['device.stop_livestream'],
      'Wedged idle radio stop must only send device.stop_livestream and never station.disconnect or device.cancel_download (which trigger HomeBase reconnect wake loops)'
    );
    let inFlightSetProps = 0;
    let maxConcurrentSetProps = 0;
    const setPropOrder = [];
    const origSend = wsInstance.send.bind(wsInstance);
    wsInstance.send = (raw, cb) => {
      const msg = JSON.parse(raw);
      if (msg.command === 'device.set_property') {
        inFlightSetProps++;
        maxConcurrentSetProps = Math.max(maxConcurrentSetProps, inFlightSetProps);
        setPropOrder.push(msg.name + '=' + msg.value);
        if (cb) cb();
        setTimeout(() => {
          inFlightSetProps--;
          wsInstance.handlers.get('message')(
            JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
          );
        }, 5);
        return;
      }
      origSend(raw, cb);
    };
    const modeSwitchCam = new Camera({serial: 'T8161T3333333333', name: 'garage', mode: 'backfill'});
    applyDeviceProperties(
      modeSwitchCam,
      {
        stationSerialNumber: {value: 'T8030P0000000000'},
        rtspStreamUrl: {value: ''},
        rtspStream: {value: false},
        light: {value: true},
        powerWorkingMode: {value: 2},
        recordingClipLength: {value: 60},
        recordingEndClipMotionStops: {value: false},
        recordingRetriggerInterval: {value: 5},
        battery: {value: 83},
      },
      false
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(setPropOrder, [
      'recordingClipLength=30',
      'recordingEndClipMotionStops=true',
      'rtspStream=true',
    ]);
    assert.equal(
      maxConcurrentSetProps,
      1,
      'Multiple device.set_property calls on startup mode switch and stuck spotlight reset must execute sequentially so HomeBase does not drop concurrent writes'
    );

    // Default track_stuck_spotlight=false must NOT send light=false on idle wifiRssi drain recovery
    setPropOrder.length = 0;
    offlineDoorbell.applyTelemetryProperties({light: true}, false, Date.now() - 200000);
    offlineDoorbell.sleptAt = Date.now() - 200000;
    offlineDoorbell.lastStoppedAt = Date.now() - 200000;
    offlineDoorbell.lastWedgedRadioStopAt = 0;
    for (const rssi of [-25, -24, -25, -24]) {
      onEvent({
        event: 'property changed',
        serialNumber: offlineDoorbell.getSerial(),
        name: 'wifiRssi',
        value: rssi,
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(
      setPropOrder,
      [],
      'Default track_stuck_spotlight=false must not send light=false during idle wifiRssi drain recovery'
    );

    // When track_stuck_spotlight=true is configured on a camera, idle wifiRssi spam when spotlight is stuck on turns off light=false
    const trackedSpotlightCam = new Camera({
      serial: 'T8161T4444444444',
      name: 'spotlight_cam',
      mode: 'p2p',
      track_stuck_spotlight: true,
      station_serial: 'T8030P0000000000',
    });
    cams.push(trackedSpotlightCam);
    bySerial.set(trackedSpotlightCam.getSerial(), trackedSpotlightCam);
    setPropOrder.length = 0;
    trackedSpotlightCam.applyTelemetryProperties({state: 1, battery: 80, light: true}, false, Date.now() - 200000);
    trackedSpotlightCam.sleptAt = Date.now() - 200000;
    trackedSpotlightCam.lastStoppedAt = Date.now() - 200000;
    trackedSpotlightCam.lastWedgedRadioStopAt = 0;
    for (const rssi of [-25, -24, -25, -24]) {
      onEvent({
        event: 'property changed',
        serialNumber: trackedSpotlightCam.getSerial(),
        name: 'wifiRssi',
        value: rssi,
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(
      setPropOrder,
      ['light=false'],
      'Idle wifiRssi drain recovery must turn off stuck spotlight (light=false) when track_stuck_spotlight=true'
    );

    // 6. stop() after a backfill download (STREAM_MODES.DOWNLOAD) skips redundant post-session device.get_properties
    sentCommands.length = 0;
    offlineDoorbell.beginBackfillDownload(
      {
        storagePath: '/zx/clip_stop.zxvideo',
        cipherId: 0,
        clipMs: Date.now() - 15000,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      },
      false,
      Date.now()
    );
    offlineDoorbell.markDownloadFinished(Date.now());
    stop(offlineDoorbell, 'post-event clip download stream completed', false, 'eufy/download-finished');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      sentCommands.includes('device.get_properties'),
      false,
      'stop() after STREAM_MODES.DOWNLOAD must not poll device.get_properties on a sleeping backfill camera'
    );

    // 7. Genuine wake timeout stop() must mark an unresponsive camera offline and must not poll cached device.get_properties,
    //    whereas external "rtsp livestream started" on an IDLE RTSP-capable camera (e.g. Home Assistant button.press)
    //    is adopted as an active RTSP event session
    sentCommands.length = 0;
    setPropOrder.length = 0;
    offlineDoorbell.beginSession('p2p', Date.now(), true);
    stop(offlineDoorbell, 'stream stalled without video', true, 'error/watchdog-timeout');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      offlineDoorbell.isDeviceOffline(),
      true,
      'Wake timeout without video must keep camera marked wakeTimedOutOffline'
    );
    assert.equal(
      sentCommands.includes('device.get_properties'),
      false,
      'stop() after a wake timeout must not call device.get_properties and clear wakeTimedOutOffline from cached properties'
    );
    offlineDoorbell.applyTelemetryProperties({state: 1, battery: 90}, false);
    offlineDoorbell.clearEncoderOfflinePause();
    offlineDoorbell.clearP2pStopInFlight();

    // Regression: "backfill" cameras (both P2P T8214 and RTSP T8161) and IDLE RTSP cameras must never adopt "rtsp livestream started" or "livestream started" as live sessions
    offlineDoorbell.sleptAt = Date.now() - 15000;
    offlineDoorbell.lastStoppedAt = Date.now() - 15000;
    onEvent({
      event: 'rtsp livestream started',
      serialNumber: offlineDoorbell.getSerial(),
    });
    assert.equal(
      offlineDoorbell.isSessionActive(),
      false,
      'Non-RTSP doorbell in backfill mode must ignore rtsp livestream started while IDLE'
    );
    onEvent({
      event: 'livestream started',
      serialNumber: offlineDoorbell.getSerial(),
    });
    assert.equal(
      offlineDoorbell.isSessionActive(),
      false,
      'Camera in backfill mode must never adopt livestream started while IDLE as a live stream'
    );
    offlineDoorbell.clearPendingBackfill();

    onlineCam1.shouldEnableRtspProperty(true);
    onlineCam1.sleptAt = Date.now() - 15000;
    onlineCam1.lastStoppedAt = Date.now() - 15000;
    onEvent({
      event: 'rtsp livestream started',
      serialNumber: onlineCam1.getSerial(),
    });
    assert.equal(
      onlineCam1.isSessionActive(),
      true,
      'IDLE RTSP camera in mode="rtsp" must adopt external rtsp livestream started outside 3s post-sleep guard (AT-05)'
    );
    assert.equal(onlineCam1.activeMode, 'rtsp');
    stop(onlineCam1, 'test cleanup', false, 'bridge-test');

    // 8. processBackfillQueue queries station.database_query_latest_info even while camera is in DRAINING_BACKFILL_TAIL
    const b2bNow = Date.now();
    offlineDoorbell.beginBackfillDownload(
      {
        storagePath: '/zx/clip1_tail.zxvideo',
        cipherId: 0,
        clipMs: b2bNow - 35000,
        event: 'person detected',
        personName: '',
        reason: 'person detected',
      },
      false,
      b2bNow - 25000
    );
    const b2bFrame = Buffer.alloc(FRAME, 0x44);
    offlineDoorbell.recordDecodedFrame(b2bFrame, b2bFrame, b2bNow - 24000, '20:40', 5000);
    offlineDoorbell.markDownloadFinished(b2bNow - 10000);
    offlineDoorbell.queueEventBackfill(b2bNow - 20000, 'person detected', '', 'person detected', 250, true);
    offlineDoorbell.recordMotionCleared(b2bNow - 10000, 0, 30000, 'person detected');
    sentCommands.length = 0;

    await processBackfillQueue(b2bNow);
    assert.equal(
      sentCommands.includes('station.database_query_latest_info'),
      true,
      'processBackfillQueue must send station.database_query_latest_info while draining Clip 1 tail so back-to-back Clip 2 is matched without waiting for IDLE'
    );
    stop(offlineDoorbell, 'test cleanup', false, 'bridge-test');

    // Unexpected 'rtsp livestream started' during WAKING_P2P disables rtspStream, stops RTSP livestream, restarts P2P livestream, and prevents false offline state
    const p2pDoorbell = new Camera({
      serial: 'T8214T5555555555',
      name: 'front_doorbell',
      mode: 'backfill',
      station_serial: 'T8030P1111111111',
    });
    initOrchestrator([p2pDoorbell], new Map([[p2pDoorbell.getSerial(), p2pDoorbell]]), () => false);
    p2pDoorbell.beginP2pWakeSession(b2bNow);
    sentCommands.length = 0;
    setPropOrder.length = 0;

    onEvent({
      source: 'device',
      event: 'rtsp livestream started',
      serialNumber: p2pDoorbell.getSerial(),
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
      setPropOrder.includes('rtspStream=false'),
      true,
      'Unexpected RTSP livestream start during P2P wake must disable rtspStream property'
    );
    assert.equal(
      sentCommands.includes('device.stop_rtsp_livestream'),
      true,
      'Unexpected RTSP livestream start during P2P wake must stop hardware RTSP stream'
    );
    assert.equal(
      sentCommands.includes('device.start_livestream'),
      true,
      'Unexpected RTSP livestream start during P2P wake must re-request P2P livestream after stopping RTSP'
    );

    // Regression: a second 'rtsp livestream started' in the same WAKING_P2P session must be ignored (no infinite stop/start loop)
    sentCommands.length = 0;
    setPropOrder.length = 0;
    onEvent({
      source: 'device',
      event: 'rtsp livestream started',
      serialNumber: p2pDoorbell.getSerial(),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      sentCommands.includes('device.stop_rtsp_livestream'),
      false,
      'Second unexpected RTSP livestream start in same session must not trigger a restart loop'
    );
    assert.equal(
      sentCommands.includes('device.start_livestream'),
      false,
      'Second unexpected RTSP livestream start in same session must not re-invoke start_livestream'
    );
    stop(p2pDoorbell, 'watchdog timeout test', false, 'error/watchdog-timeout');
    assert.equal(
      p2pDoorbell.isDeviceOffline(),
      false,
      'Doorbell that emitted events during wake session must not be marked offline on watchdog timeout'
    );

    // Regression: multi-camera /api/wake using WakeRequest.build() (without explicit .withDelay()) must still pace wakes on the same station by 2500ms
    const {WakeRequest} = require('../src/domain/camera');
    const paceCam1 = new Camera({
      serial: 'T8161T6000000001',
      name: 'pace_cam_1',
      mode: 'rtsp',
      station_serial: 'T8030P2222222222',
    });
    const paceCam2 = new Camera({
      serial: 'T8161T6000000002',
      name: 'pace_cam_2',
      mode: 'rtsp',
      station_serial: 'T8030P2222222222',
    });
    initOrchestrator(
      [paceCam1, paceCam2],
      new Map([
        [paceCam1.getSerial(), paceCam1],
        [paceCam2.getSerial(), paceCam2],
      ]),
      () => false
    );
    const req1 = WakeRequest.motion('garage door opening', 30000)
      .withInitiator('api-wake')
      .withCreateEvent(true)
      .build();
    const req2 = WakeRequest.motion('garage door opening', 30000)
      .withInitiator('api-wake')
      .withCreateEvent(true)
      .build();
    try {
      const res1 = wakeCameraExternal(paceCam1, req1);
      const res2 = wakeCameraExternal(paceCam2, req2);
      assert.equal(res1.status, 'waking');
      assert.equal(res1.delay_ms, 0);
      assert.equal(res2.status, 'scheduled');
      assert.ok(
        res2.delay_ms >= 2000 && res2.delay_ms <= 2500,
        'Second camera on the same station woken via WakeRequest.build() must be paced by STATION_WAKE_PACING_MS (~2500ms)'
      );
    } finally {
      paceCam2.clearApiWakeTimer();
      stop(paceCam1, 'cleanup', false, 'bridge-test');
      stop(paceCam2, 'cleanup', false, 'bridge-test');
    }
    configureEufyClientHooks({onDeviceOnlineResume: () => {}});
  });

  it('Back-to-back same-station P2P switching: after camera A stops, waiting camera B starts immediately without 2500ms pacing delay', () => {
    // Regression: back-to-back switching skips pacing only right after a P2P/download slot stops, never leaking across RTSP wakes or preemptions
    const {WakeRequest} = require('../src/domain/camera');
    const camA = new Camera({
      serial: 'T8161T7000000001',
      name: 'gate_camera',
      mode: 'p2p',
      priority: 10,
      station_serial: 'T8030P3333333333',
    });
    const camB = new Camera({
      serial: 'T8161T7000000002',
      name: 'driveway_camera',
      mode: 'p2p',
      priority: 100,
      station_serial: 'T8030P3333333333',
    });
    const camC = new Camera({
      serial: 'T8161T7000000003',
      name: 'yard_camera',
      mode: 'p2p',
      priority: 5,
      station_serial: 'T8030P3333333333',
    });
    const rtspCam = new Camera({
      serial: 'T8161T7000000004',
      name: 'porch_rtsp',
      mode: 'rtsp',
      homebase_rtsp_url: 'rtsp://192.168.1.50/live0',
      station_serial: 'T8030P3333333333',
    });
    initOrchestrator(
      [camA, camB, camC, rtspCam],
      new Map([
        [camA.getSerial(), camA],
        [camB.getSerial(), camB],
        [camC.getSerial(), camC],
        [rtspCam.getSerial(), rtspCam],
      ]),
      () => false
    );
    const reqA = WakeRequest.motion('gate motion', 30000)
      .withInitiator('api-wake')
      .withCreateEvent(true)
      .build();
    const reqB = WakeRequest.motion('driveway motion', 30000)
      .withInitiator('api-wake')
      .withCreateEvent(true)
      .build();
    const reqC = WakeRequest.motion('yard motion', 30000)
      .withInitiator('api-wake')
      .withCreateEvent(true)
      .build();
    try {
      // 1. Start camera A's session (this sets stationNextWakeAt with pacing)
      const resA = wakeCameraExternal(camA, reqA);
      assert.equal(resA.status, 'waking', 'First camera on station should start immediately');
      assert.equal(resA.delay_ms, 0);
      assert.equal(camA.isSessionActive(), true);

      // 2. Stop camera A (releases the station P2P slot)
      stop(camA, 'test stop', false, 'bridge-test');
      camA.clearP2pStopInFlight();

      // 3. Trigger camera B immediately after camera A stops
      // With the fix, camera B should start immediately (delay_ms = 0) because the slot was just released
      const resB = wakeCameraExternal(camB, reqB);
      assert.equal(
        resB.status,
        'waking',
        'Camera B should start immediately after camera A stops (back-to-back same-station switching)'
      );
      assert.equal(
        resB.delay_ms,
        0,
        'Back-to-back same-station wake after slot release must have zero pacing delay'
      );
      assert.equal(camB.isSessionActive(), true, 'Camera B session should be active');

      // 4. Stale release check: stop camera B while idle (no waiting camera), then wake RTSP camera on same station;
      //    a subsequent /api/wake on camera C must still be paced behind the fresh RTSP start command.
      stop(camB, 'idle stop', false, 'bridge-test');
      camB.clearP2pStopInFlight();
      trigger(rtspCam, 'porch motion', 30000, 'motion', 'eufy-event', 100);
      assert.equal(rtspCam.isActiveRtspSession(), true);
      const resAfterRtsp = wakeCameraExternal(camC, reqC);
      assert.equal(
        resAfterRtsp.status,
        'scheduled',
        'Previous P2P stop must not leak past a newer RTSP wake on the same station'
      );
      assert.ok(resAfterRtsp.delay_ms > 0);
      camC.clearApiWakeTimer();
      stop(rtspCam, 'rtsp stop', false, 'bridge-test');

      // 5. Preemption check: camera A has been streaming past its initial pacing window, then higher-priority camera B preempts A;
      //    an immediate /api/wake on camera C must be paced behind B's fresh start command.
      initOrchestrator(
        [camA, camB, camC, rtspCam],
        new Map([
          [camA.getSerial(), camA],
          [camB.getSerial(), camB],
          [camC.getSerial(), camC],
          [rtspCam.getSerial(), rtspCam],
        ]),
        () => false
      );
      camA.beginSession('p2p', Date.now() - 10000, true);
      camA.motionUntil = Date.now() + 20000;
      trigger(camB, 'driveway person', 30000, 'motion', 'eufy-event', 200);
      assert.equal(camB.isSessionActive(), true, 'Higher-priority camera B should preempt camera A');
      const resAfterPreempt = wakeCameraExternal(camC, reqC);
      assert.equal(
        resAfterPreempt.status,
        'scheduled',
        'Preempting P2P start must still pace a subsequent /api/wake on the same station'
      );
      assert.ok(resAfterPreempt.delay_ms > 0);
    } finally {
      camC.clearApiWakeTimer();
      stop(camA, 'cleanup', false, 'bridge-test');
      stop(camB, 'cleanup', false, 'bridge-test');
      stop(camC, 'cleanup', false, 'bridge-test');
      stop(rtspCam, 'cleanup', false, 'bridge-test');
    }
    configureEufyClientHooks({onDeviceOnlineResume: () => {}});
  });

  it('posts Home Assistant webhook payloads on event trigger and after Frigate event creation when ha_webhook is configured', async () => {
    const cam = new Camera({serial: 'T8214T2222222222', name: 'doorbell', title: 'Front Doorbell'});
    cam.evLabel = 'person';
    cam.evPerson = 'Alice';

    const postedBodies = [];
    const origFetch = global.fetch;

    global.fetch = async (url, opts = {}) => {
      postedBodies.push({url, body: JSON.parse(opts.body)});
      return {ok: true, status: 200};
    };

    try {
      notifyHA(cam, {}, '');
      assert.equal(postedBodies.length, 0, 'Must not send webhook when ha_webhook is empty');

      const webhookUrl = 'http://homeassistant.local:8123/api/webhook/eufy_bridge';
      notifyHA(cam, {}, webhookUrl);
      notifyHA(cam, {event_id: '1793927229.123-abc', review_id: 'rev-999'}, webhookUrl);
    } finally {
      global.fetch = origFetch;
    }

    assert.equal(postedBodies.length, 2);
    assert.deepEqual(postedBodies[0], {
      url: 'http://homeassistant.local:8123/api/webhook/eufy_bridge',
      body: {
        camera: 'doorbell',
        title: 'Front Doorbell',
        label: 'person',
        person: 'Alice',
      },
    });
    assert.deepEqual(postedBodies[1], {
      url: 'http://homeassistant.local:8123/api/webhook/eufy_bridge',
      body: {
        camera: 'doorbell',
        title: 'Front Doorbell',
        label: 'person',
        person: 'Alice',
        event_id: '1793927229.123-abc',
        review_id: 'rev-999',
      },
    });
  });

  it(
    'defers bridge-timer stop for a final Frigate check on hold expiry and suppresses no-op hold extension logs',
    async () => {
      // Regression: startHousekeepingLoop ran arbitrate() before evaluateActiveHoldExtension() and skipped Frigate
      // polls within 4s of the previous poll, killing active RTSP streams when a person entered in the final <4s.
      assert.equal(
        typeof runHousekeepingTick,
        'function',
        'runHousekeepingTick must be exported for deterministic tick testing'
      );

    const t0 = 1794513168000;
    const storageCam = new Camera({
      serial: 'T8161T0000000093',
      name: 'storage_room',
      mode: 'rtsp',
      startup_snapshot: false,
    });
    const garageCam = new Camera({
      serial: 'T8161T0000000094',
      name: 'garage_cam',
      mode: 'backfill',
      startup_snapshot: false,
    });
    storageCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://127.0.0.1:8554/storage');
    garageCam.updateDiscoveredRtspConfig('T8030P0000000000', 'rtsp://127.0.0.1:8554/garage');

    const cams = [storageCam, garageCam];
    const bySerial = new Map(cams.map((c) => [c.getSerial(), c]));
    initOrchestrator(cams, bySerial, () => false);

    // Start both sessions at t0 with 60s hold (e.g. external /api/wake door-open trigger).
    storageCam.motionUntil = t0 + 60000;
    storageCam.lastMotionAt = t0;
    storageCam.eventActive = true;
    storageCam.reason = 'door opening';
    storageCam.beginSession('rtsp', t0, true);
    storageCam.gotVideo = true;
    storageCam.firstVideoAt = t0 + 2000;
    storageCam.lastVideoAt = t0 + 57000;
    storageCam.evUntil = t0 + 60000;
    storageCam.evState = 'cooldown';

    garageCam.motionUntil = t0 + 60000;
    garageCam.lastMotionAt = t0;
    garageCam.eventActive = true;
    garageCam.reason = 'door opening';
    garageCam.beginSession('rtsp', t0, true);
    garageCam.gotVideo = true;
    garageCam.firstVideoAt = t0 + 2000;
    garageCam.lastVideoAt = t0 + 6000;
    garageCam.queueEventBackfill(t0, 'person detected', '', 'person detected', 100, false);

    /** @type {Record<string, Array<Record<string, *>>>} */
    const activeEventsByCam = {
      storage_room: [],
      garage_cam: [
        {
          id: '1794513173.0-garage-person',
          label: 'person',
          data: {type: 'object'},
          start_time: (t0 + 5000) / 1000,
          end_time: null,
        },
      ],
    };
    const infoLogs = [];
    const origFetch = global.fetch;
    const origLogInfo = log.info;
    const origDateNow = Date.now;
    let mockWallNow = 1700000000000;
    Date.now = () => mockWallNow;

    global.fetch = async (url) => {
      mockWallNow += 25;
      const u = String(url);
      if (u.includes('/api/events?cameras=storage_room')) {
        return {
          ok: true,
          async json() {
            return activeEventsByCam.storage_room;
          },
        };
      }
      if (u.includes('/api/events?cameras=garage_cam')) {
        return {
          ok: true,
          async json() {
            return activeEventsByCam.garage_cam;
          },
        };
      }
      return {
        ok: true,
        async json() {
          return [];
        },
        async text() {
          return '';
        },
      };
    };
    log.info = (scope, msg) => {
      infoLogs.push({scope: scope && scope.name ? scope.name : String(scope || ''), msg: String(msg)});
    };

    const isGarageHoldExtendedLog = (entry) =>
      entry.scope === 'garage_cam' && entry.msg.includes('extended stream hold by +');

    try {
      // 1. At t0 + 6000 (54s left on garageCam's 60s /api/wake hold, > 30s base hold), backfill object check polls
      //    Frigate: must confirm object detection without logging a bogus "+15s (holdExtendedTo=54s)" hold extension.
      garageCam.evUntil = t0 + 12000;
      runHousekeepingTick(t0 + 6000);
      await new Promise((r) => setImmediate(r));
      assert.equal(garageCam.motionUntil, t0 + 60000);
      assert.equal(
        infoLogs.some(isGarageHoldExtendedLog),
        false,
        'No-op hold extension when 54s already remain on a 30s-hold camera must not log extended stream hold'
      );

      // 2. At t0 + 57000 (3s before storageCam's 60s hold expires), Frigate has no person yet.
      runHousekeepingTick(t0 + 57000);
      await new Promise((r) => setImmediate(r));
      assert.equal(storageCam.isSessionActive(), true);
      assert.equal(storageCam.lastExtendCheckAt, t0 + 57000);

      // 3. Person enters storage_room at t0 + 58500 (1.5s before hold expiry).
      activeEventsByCam.storage_room = [
        {
          id: '1794513226.5-storage-person',
          label: 'person',
          data: {type: 'object'},
          start_time: (t0 + 58500) / 1000,
          end_time: null,
        },
      ];
      storageCam.lastVideoAt = t0 + 60000;
      garageCam.lastVideoAt = t0 + 60000;

      // At t0 + 60000 (hold expiry, only 3s after t0 + 57000 poll), runHousekeepingTick must defer bridge-timer stop
      // while the final Frigate check is in flight, then extend motionUntil to t0 + 90000.
      runHousekeepingTick(t0 + 60000);
      assert.equal(
        storageCam.isSessionActive(),
        true,
        'arbitrate() must not kill storageCam synchronously before the final expiry Frigate check resolves'
      );
      assert.equal(storageCam.isExtendCheckInFlight(), true);

      await new Promise((r) => setImmediate(r));
      assert.equal(storageCam.isExtendCheckInFlight(), false);
      assert.equal(storageCam.isSessionActive(), true, 'Active person in Frigate must keep storageCam streaming');
      assert.equal(storageCam.motionUntil, t0 + 90000, 'storageCam motionUntil must extend by +30s to t0 + 90000');
      assert.equal(storageCam.viewUntil, 0, 'Expiry extension on motion session must not set viewUntil');

      // 4. At t0 + 90000, person has left (Frigate idle); final expiry check resolves idle and stops via bridge-timer.
      activeEventsByCam.storage_room = [];
      storageCam.lastVideoAt = t0 + 90000;
      runHousekeepingTick(t0 + 90000);
      await new Promise((r) => setImmediate(r));
      assert.equal(
        storageCam.isSessionActive(),
        false,
        'Once Frigate confirms idle at t0 + 90000, storageCam must stop cleanly via bridge-timer'
      );
    } finally {
      if (storageCam.evTimer) {
        clearTimeout(storageCam.evTimer);
        storageCam.evTimer = null;
      }
      if (garageCam.evTimer) {
        clearTimeout(garageCam.evTimer);
        garageCam.evTimer = null;
      }
      if (storageCam.isSessionActive()) {
        storageCam.endSession(t0 + 91000, true, false, 'rtsp');
      }
      if (garageCam.isSessionActive()) {
        garageCam.endSession(t0 + 91000, true, false, 'rtsp');
      }
      initOrchestrator([], new Map(), () => true);
      Date.now = origDateNow;
      global.fetch = origFetch;
      log.info = origLogInfo;
    }
  });

  it('Regression: recovers disconnected or wedged eufy-security-ws driver/station sessions and missing rtspStreamUrl after Wi-Fi outages', async () => {
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
      await wsInstance.handlers.get('message')(
        JSON.stringify({type: 'version', maxSchemaVersion: 21})
      );
      configureEufyClientHooks({isShuttingDown: () => true, wsReadyAt: fakeNow - 10000});
      await new Promise((r) => setTimeout(r, 30));

      // 1. Startup must reconnect disconnected driver and station before reading properties
      const driverConnectIdx = sentCommands.indexOf('driver.connect');
      const stationConnectIdx = sentCommands.indexOf('station.connect');
      const getPropsIdx = sentCommands.indexOf('device.get_properties');
      assert.ok(driverConnectIdx >= 0, 'Must send driver.connect when start_listening reports driver.connected=false');
      assert.ok(stationConnectIdx >= 0, 'Must send station.connect when start_listening reports station.connected=false');
      assert.ok(stationConnectIdx < getPropsIdx, 'Must reconnect station before querying device.get_properties');

      // 2. Failed driver.poll_refresh (no_reply) must NOT falsely clear wakeTimedOutOffline and must recycle wedged driver/station
      doorbellP2p.telemetry.markWakeTimedOut();
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

      // 3. Station "close" marks HB:DN / service disruption; station "connect" restores HB:OK and resets hardware sync flags
      onEvent({source: 'station', event: 'close', serialNumber: 'T8030P0000000080'});
      assert.equal(rtspBfCam.hasServiceDisruption(), true);
      assert.equal(rtspBfCam.buildDebugHudLines(fakeNow)[0].includes('HB:DN'), true);

      setPropCalls.length = 0;
      onEvent({source: 'station', event: 'connect', serialNumber: 'T8030P0000000080'});
      assert.equal(rtspBfCam.hasServiceDisruption(), false);
      assert.equal(rtspBfCam.buildDebugHudLines(fakeNow)[0].includes('HB:OK'), true);
      assert.equal(
        rtspBfCam.telemetry.recordingModeChecked,
        false,
        'Station connect must reset one-time sync flags so dropped property writes are re-applied'
      );
      await fetchAllCameraTelemetry(false);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(
        setPropCalls.includes('T8161T0000000081:recordingEndClipMotionStops=true'),
        true,
        'Reconnected station must re-sync dropped recordingEndClipMotionStops property'
      );

      // 4. RTSP wake retry when rtspStream=true but rtspStreamUrl="" reconnects disconnected station and toggles rtspStream false->true
      stationConnectedFlag = false;
      populatedRtspUrl = '';
      sawRtspToggleFalse = false;
      sentCommands.length = 0;
      setPropCalls.length = 0;

      trigger(rtspBfCam, 'live view opened', 30000, 'view', 'viewer');
      runHousekeepingTick(fakeNow);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(rtspBfCam.getRtspUrl(), '');

      fakeNow += 10500;
      runHousekeepingTick(fakeNow);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(sentCommands.includes('station.connect'), true, 'RTSP retry must reconnect disconnected station');
      assert.equal(
        setPropCalls.includes('T8161T0000000081:rtspStream=false') &&
          setPropCalls.includes('T8161T0000000081:rtspStream=true'),
        true,
        'RTSP retry with empty rtspStreamUrl must toggle rtspStream false->true to regenerate URL'
      );
      assert.equal(rtspBfCam.getRtspUrl(), 'rtsp://127.0.0.1:1/live0');
      stop(rtspBfCam, 'test cleanup', false, 'bridge');
      await new Promise((r) => setTimeout(r, 280));

      // 5. Immediate rtspStream toggle on 'rtsp livestream started' when rtspStreamUrl is still empty,
      // and mid-wake zombie station recycle on retry 2/3 without aborting a concurrently waking camera on the same station
      fakeNow += 70000;
      stationConnectedFlag = true;
      rtspBfCam.rtspUrl = '';
      populatedRtspUrl = '';
      sawRtspToggleFalse = false;
      setPropCalls.length = 0;

      trigger(rtspBfCam, 'live view opened', 30000, 'view', 'viewer');
      runHousekeepingTick(fakeNow);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(rtspBfCam.getRtspUrl(), '');

      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: rtspBfCam.getSerial(),
      });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(
        rtspBfCam.getRtspUrl(),
        'rtsp://127.0.0.1:1/live0',
        'rtsp livestream started with empty rtspStreamUrl must immediately toggle rtspStream false->true without waiting 10s'
      );

      // Keep rtspBfCam in WAKING_RTSP (gotVideo=false) past RTSP_HANDSHAKE_WINDOW_MS while doorbellP2p wakes and hits retry 2/3
      fakeNow += 6000;
      doorbellP2p.telemetry.markDeviceOnline();
      sentCommands.length = 0;

      trigger(doorbellP2p, 'live view opened', 35000, 'view', 'viewer');
      runHousekeepingTick(fakeNow);
      await new Promise((r) => setTimeout(r, 15));
      fakeNow += 6000;
      runHousekeepingTick(fakeNow);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(
        sentCommands.includes('station.disconnect'),
        false,
        'First P2P retry (restarts=1) must check station.is_connected before recycling'
      );

      fakeNow += 8500;
      runHousekeepingTick(fakeNow);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(
        sentCommands.includes('station.disconnect') && sentCommands.includes('station.connect'),
        true,
        'Second P2P retry (restarts=2) with zero device reply must recycle zombie station P2P session mid-wake'
      );
      assert.equal(
        rtspBfCam.isSessionActive(),
        true,
        'Self-inflicted station connection error during recoverUnresponsiveStation must not abort concurrently waking cameras'
      );
    } finally {
      stop(rtspBfCam, 'cleanup', false, 'bridge');
      stop(doorbellP2p, 'cleanup', false, 'bridge');
      Date.now = origDateNow;
    }
  });
});

describe('Structured Alloy/Loki Logger & ICU-Free Timestamps (src/logger.js)', () => {
  it('formats local timestamps, normalizes log severity levels, and formats scoped log lines', () => {
    const fixedDate = new Date(2026, 10, 5, 8, 4, 9);
    assert.equal(formatLocalTimestamp(fixedDate), '2026-11-05 08:04:09');
    assert.equal(formatLocalHm(fixedDate), '08:04');

    assert.equal(normalizeLevelName('WARNING'), 'warn');
    assert.equal(normalizeLevelName('DEBUG'), 'debug');
    assert.equal(normalizeLevelName('invalid_level'), 'info');

    const camScope = {name: 'T8214T2222222222', sessionState: 'handshaking_backfill'};
    const warnLine = formatLogLine('warn', camScope, ['stream stalled', 'retrying'], fixedDate);
    const infoLine = formatLogLine('info', camScope, ['WAKE'], fixedDate);
    const debugLine = formatLogLine('debug', camScope, ['started FFmpeg decoder'], fixedDate);
    const errorLine = formatLogLine('error', camScope, ['socket closed'], fixedDate);
    assert.equal(
      warnLine,
      '2026-11-05 08:04:09 - [WARN ] - [T8214T2222222222] [HANDSHAKING_BACKFILL] stream stalled retrying'
    );
    assert.equal(
      infoLine,
      '2026-11-05 08:04:09 - [INFO ] - [T8214T2222222222] [HANDSHAKING_BACKFILL] WAKE'
    );
    assert.equal(
      debugLine,
      '2026-11-05 08:04:09 - [DEBUG] - [T8214T2222222222] [HANDSHAKING_BACKFILL] started FFmpeg decoder'
    );
    assert.equal(
      errorLine,
      '2026-11-05 08:04:09 - [ERROR] - [T8214T2222222222] [HANDSHAKING_BACKFILL] socket closed'
    );
    assert.equal(warnLine.indexOf('[T8214T2222222222]'), debugLine.indexOf('[T8214T2222222222]'));
    assert.equal(infoLine.indexOf('[T8214T2222222222]'), errorLine.indexOf('[T8214T2222222222]'));
    const backfillScope = {name: 'doorbell', state: 'ready_to_query'};
    assert.equal(
      formatLogLine('info', backfillScope, ['querying HomeBase'], fixedDate),
      '2026-11-05 08:04:09 - [INFO ] - [doorbell] [READY_TO_QUERY] querying HomeBase'
    );
    const decoderScope = {name: 'doorbell', decoderState: 'paused_backpressure'};
    assert.equal(
      formatLogLine('debug', decoderScope, ['decoder paused'], fixedDate),
      '2026-11-05 08:04:09 - [DEBUG] - [doorbell] [PAUSED_BACKPRESSURE] decoder paused'
    );
    const eventScope = {name: 'doorbell', evState: 'waiting_snapshot'};
    assert.equal(
      formatLogLine('debug', eventScope, ['waiting for clean snapshot'], fixedDate),
      '2026-11-05 08:04:09 - [DEBUG] - [doorbell] [WAITING_SNAPSHOT] waiting for clean snapshot'
    );
    assert.equal(
      formatLogLine('debug', 'bridge', ['polling HomeBase'], fixedDate),
      '2026-11-05 08:04:09 - [DEBUG] - [bridge] polling HomeBase'
    );
    assert.equal(
      formatLogLine('info', null, ['listening'], fixedDate),
      '2026-11-05 08:04:09 - [INFO ] - [bridge] listening'
    );

    assert.equal(initLogger('debug'), 'debug');
    assert.equal(initLogger('error'), 'error');
  });
});
