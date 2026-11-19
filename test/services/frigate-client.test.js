/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for Frigate motion/object mask sync, go2rtc bulk viewer polling, and upstream health
 * (src/services/frigate-client.js).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {log, initLogger} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {
  buildFrigateMaskPayload,
  buildFrigateMaskDeletePayload,
  isFrigateMaskIntact,
  syncFrigateMotionMasks,
  syncSingleFrigateMaskSection,
  pollViewers,
  resolveFrigateEventLabel,
  computeRequiredSnapshotDelay,
  BACKFILL_SNAP_DELAY_MS,
  classifyViewerAction,
} = require('../../src/services/frigate-client');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('Frigate & go2rtc Service Helpers (src/services/frigate-client.js)', () => {
  it('builds and verifies Frigate motion and object mask payloads across string and array coordinate formats', () => {
    // Verify: mask payload builders and isFrigateMaskIntact accept options objects and string/array coordinates.
    const poly = '0.015,0.920,0.220,0.920,0.220,0.985,0.015,0.985';

    const payload = buildFrigateMaskPayload('driveway', 'motion', {enabled: true, coordinates: poly});
    assert.equal(payload.requires_restart, 0);
    assert.equal(payload.update_topic, 'config/cameras/driveway/motion');
    assert.equal(payload.config_data.cameras.driveway.motion.mask.eufy_bridge_card.coordinates, poly);

    const deletePayload = buildFrigateMaskDeletePayload('driveway', 'objects');
    assert.equal(deletePayload.requires_restart, 0);
    assert.equal(deletePayload.update_topic, 'config/cameras/driveway/objects');
    assert.equal(deletePayload.config_data.cameras.driveway.objects.mask.eufy_bridge_card, '');

    assert.equal(isFrigateMaskIntact({enabled: true, coordinates: poly}, poly), true);
    assert.equal(isFrigateMaskIntact({enabled: true, coordinates: [poly]}, poly), true);
    assert.equal(isFrigateMaskIntact({enabled: false, coordinates: poly}, poly), false);
    assert.equal(isFrigateMaskIntact({enabled: true, coordinates: '0.1,0.1'}, poly), false);
    assert.equal(isFrigateMaskIntact(null, poly), false);
  });

  it('Verify deleting only bridge-created eufy_bridge_card masks when card_theme="none"', async () => {
    // Verify: deleting only bridge-created eufy_bridge_card masks when card_theme="none".
    const applyCam = new Camera({
      serial: 'T8161T0000000000',
      name: 'driveway',
      card_theme: 'glance',
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
    const deleteCam = new Camera({
      serial: 'T8214T2222222222',
      name: 'doorbell',
      card_theme: 'none',
      auto_frigate_mask: true,
    });
    const userOnlyCam = new Camera({
      serial: 'T8214T3333333333',
      name: 'patio',
      card_theme: 'none',
      auto_frigate_mask: true,
    });
    const legacyListCam = new Camera({
      serial: 'T8214T4444444444',
      name: 'porch',
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
                  motion: {
                    mask: {
                      eufy_bridge_card: {enabled: true, coordinates: intactPoly},
                      user_trees: {enabled: true, coordinates: '0.1,0.1,0.2,0.2'},
                    },
                  },
                  objects: {
                    mask: {
                      eufy_bridge_card: {enabled: false, coordinates: intactPoly},
                      user_street: {enabled: true, coordinates: '0.3,0.3,0.4,0.4'},
                    },
                  },
                },
                patio: {
                  motion: {mask: {user_hedge: {enabled: true, coordinates: '0.1,0.1,0.2,0.2'}}},
                  objects: {mask: {user_car: {enabled: true, coordinates: '0.3,0.3,0.4,0.4'}}},
                },
                porch: {
                  motion: {mask: ['0.1,0.1,0.2,0.2']},
                  objects: {mask: ['0.3,0.3,0.4,0.4']},
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
      await syncFrigateMotionMasks([applyCam, intactCam, deleteCam, userOnlyCam, legacyListCam], {
        forceResync: true,
        shuttingDown: false,
        frigateUrl: 'http://frigate.local:5000',
      });
    } finally {
      global.fetch = origFetch;
    }

    // driveway: applies motion and objects masks; doorbell: deletes only eufy_bridge_card motion and objects
    // masks (even if disabled); garage, patio (user-only masks), porch (legacy list masks): 0 PUTs
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
    assert.equal(putCalls[2].config_data.cameras.doorbell.motion.mask.eufy_bridge_card, '');
    assert.deepEqual(Object.keys(putCalls[2].config_data.cameras.doorbell.motion.mask), ['eufy_bridge_card']);
    assert.equal(putCalls[3].update_topic, 'config/cameras/doorbell/objects');
    assert.equal(putCalls[3].config_data.cameras.doorbell.objects.mask.eufy_bridge_card, '');
    assert.deepEqual(Object.keys(putCalls[3].config_data.cameras.doorbell.objects.mask), ['eufy_bridge_card']);
  });

  it('Verify syncSingleFrigateMaskSection returns failed on non-2xx or network error during delete', async () => {
    // Verify: syncSingleFrigateMaskSection returns failed on non-2xx or network error during delete.
    const cam = new Camera({
      serial: 'T8214T5555555555',
      name: 'doorbell',
      card_theme: 'none',
      auto_frigate_mask: true,
    });
    const camCfg = {
      motion: {mask: {eufy_bridge_card: {enabled: true, coordinates: '0,0,1,1'}}},
    };
    const origFetch = global.fetch;

    global.fetch = async () => ({
      ok: false,
      status: 500,
      async text() {
        return 'internal error';
      },
    });
    let statusHttpErr;
    try {
      statusHttpErr = await syncSingleFrigateMaskSection(cam, camCfg, {
        section: 'motion',
        poly: '',
        frigateUrl: 'http://frigate.local:5000',
      });
    } finally {
      global.fetch = origFetch;
    }
    assert.equal(statusHttpErr, 'failed');

    global.fetch = async () => {
      throw new Error('network down');
    };
    let statusNetErr;
    try {
      statusNetErr = await syncSingleFrigateMaskSection(cam, camCfg, {
        section: 'motion',
        poly: '',
        frigateUrl: 'http://frigate.local:5000',
      });
    } finally {
      global.fetch = origFetch;
    }
    assert.equal(statusNetErr, 'failed');
  });

  it('polls go2rtc once for all cameras through the bulk streams endpoint and ignores unrelated streams', async () => {
    // Verify: viewer detection costs one go2rtc request per tick regardless of camera count, picks each camera's
    // consumers by stream name, ignores streams the bridge does not own, treats a stream that is not registered yet
    // as having no consumers (not as a go2rtc outage), and still reports an outage when the single request fails.
    const pollCams = [1, 2, 3].map(
      (n) => new Camera({serial: 'T8161T771000000' + n, name: 'poll_bulk_' + n, mode: 'rtsp'})
    );
    const hooks = {
      isShuttingDown: () => false,
      fetchAllCameraTelemetry: () => {},
      stopCam: () => {},
      triggerCam: () => {},
    };
    const requestedUrls = [];
    const origFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        throw new Error('connect ECONNREFUSED');
      };
      await pollViewers(pollCams, hooks);
      assert.equal(requestedUrls.length, 1, 'a failing go2rtc must cost a single request, not one per camera');
      assert.equal(
        pollCams.every((c) => c.isGo2rtcConnected()),
        false,
        'one failed bulk request marks go2rtc down for every camera'
      );

      requestedUrls.length = 0;
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              poll_bulk_1: {producers: [], consumers: []},
              poll_bulk_3: {
                producers: [{url: 'rtsp://user:pw@192.0.2.9:554/live'}],
                consumers: [{id: 'viewer-bulk-3', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
              },
              unrelated_frigate_cam: {
                consumers: [{id: 'viewer-unrelated', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
              },
            };
          },
        };
      };
      await pollViewers(pollCams, hooks);
      assert.equal(requestedUrls.length, 1);
      assert.ok(requestedUrls[0].endsWith('/api/streams'), 'must use the bulk endpoint without a src filter');
      assert.equal(pollCams[2].hasRegisteredViewer('viewer-bulk-3'), true);
      assert.equal(pollCams[0].hasRegisteredViewer('viewer-bulk-3'), false);
      assert.equal(pollCams[1].hasRegisteredViewer('viewer-bulk-3'), false);
      assert.equal(
        pollCams.some((c) => c.hasRegisteredViewer('viewer-unrelated')),
        false,
        'consumers of streams the bridge does not own must be ignored'
      );
      assert.equal(
        pollCams.every((c) => c.isGo2rtcConnected()),
        true,
        'a stream missing from the response (poll_bulk_2) is not a go2rtc outage'
      );
    } finally {
      global.fetch = origFetch;
    }
  });

  it('warns once when go2rtc answers with an unusable stream list so missed viewers are never silent', async () => {
    // Verify: a reachable go2rtc whose reply is not a stream table (wrong shape or unreadable body) must not look
    // like "nobody is watching"; it is logged once per episode and re-armed after a good reply.
    const shapeCam = new Camera({serial: 'T8161T7720000001', name: 'poll_shape_cam', mode: 'rtsp'});
    const hooks = {
      isShuttingDown: () => false,
      fetchAllCameraTelemetry: () => {},
      stopCam: () => {},
      triggerCam: () => {},
    };
    const warnings = [];
    const origWarn = log.warn;
    const origFetch = global.fetch;
    log.warn = (scope, ...args) => {
      warnings.push(String(scope) + ': ' + args.join(' '));
    };
    const replyWith = (body) => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      });
    };
    const unusableWarnings = () => warnings.filter((w) => w.includes('unusable stream list')).length;
    try {
      replyWith([]);
      await pollViewers([shapeCam], hooks);
      await pollViewers([shapeCam], hooks);
      assert.equal(unusableWarnings(), 1, 'repeated unusable replies must warn once');
      assert.equal(shapeCam.isGo2rtcConnected(), true, 'a reachable go2rtc is not an outage');

      replyWith({poll_shape_cam: {consumers: []}});
      await pollViewers([shapeCam], hooks);
      assert.equal(unusableWarnings(), 1);

      replyWith(null);
      await pollViewers([shapeCam], hooks);
      assert.equal(unusableWarnings(), 2, 'a new episode after a good reply must warn again');
    } finally {
      log.warn = origWarn;
      global.fetch = origFetch;
    }
  });

  it('maps Eufy event strings to Frigate detection labels and computes mode-specific snapshot delays', () => {
    // Verify: maps Eufy event strings to Frigate detection labels and computes mode-specific snapshot delays.
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

  it(
    'classifies all 6 go2rtc viewer connection branches (wake, extend, grid, live-join, ' +
      'motion-blocked, eco-blocked, cooldown)',
    () => {
      // Verify: classifies all 6 go2rtc viewer connection branches (wake, extend, grid, live-join, motion-blocked,
      // eco-blocked, cooldown).
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
    }
  );

  it(
    'keeps direct rtsp_url cameras active and connects idle direct rtsp_url cameras in ' +
      'multi-camera dashboard grids',
    async () => {
      // Verify: keeps direct rtsp_url cameras active and connects idle direct rtsp_url cameras in multi-camera
      // dashboard grids.
      // Constant-stream rtsp_url cameras must never log 'ignored, multi-camera dashboard grid view' or
      // 'joined while live, does not extend it', and must connect immediately when IDLE even in a multi-camera grid.
      const batteryGridCam = new Camera({
        serial: 'T8161T4444444444',
        name: 'yard_battery_cam',
        mode: 'p2p',
        station_serial: 'T8030P0000000001',
      });
      const directActiveCam = new Camera({
        name: 'baby_crib_cam',
        rtsp_url: 'rtsp://127.0.0.1:8554/baby_crib',
      });
      const directIdleCam = new Camera({
        name: 'baby_playroom_cam',
        rtsp_url: 'rtsp://127.0.0.1:8554/baby_playroom',
      });
      directActiveCam.beginRtspDirectProbeSession(50000);
      directActiveCam.markRtspFrameReceived(50500);

      const capturedLogs = [];
      const triggeredCams = [];
      const origFetch = global.fetch;
      const origStdoutWrite = process.stdout.write;
      initLogger('info');
      process.stdout.write = (chunk) => {
        capturedLogs.push(String(chunk));
        return true;
      };
      try {
        global.fetch = async () => ({
          ok: true,
          status: 200,
          async json() {
            return {
              yard_battery_cam: {consumers: [{id: 'v-yard', user_agent: 'Mozilla/5.0', format_name: 'mse'}]},
              baby_crib_cam: {consumers: [{id: 'v-crib', user_agent: 'Mozilla/5.0', format_name: 'mse'}]},
              baby_playroom_cam: {consumers: [{id: 'v-play', user_agent: 'Mozilla/5.0', format_name: 'mse'}]},
            };
          },
        });

        await pollViewers([batteryGridCam, directActiveCam, directIdleCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: async () => {},
          stopCam: () => {},
          triggerCam: (cam) => {
            triggeredCams.push(cam.getName());
          },
        });
      } finally {
        process.stdout.write = origStdoutWrite;
        initLogger('error');
        global.fetch = origFetch;
        directActiveCam.endSession(55000, true, false, 'rtsp');
      }

      const logText = capturedLogs.join('');
      assert.equal(
        logText.includes(
          '[yard_battery_cam] [IDLE] viewer connected (mse) - ignored, multi-camera dashboard grid view'
        ),
        true,
        'Sleeping battery camera in mixed dashboard grid must still be ignored'
      );
      assert.equal(
        logText.includes('[baby_crib_cam]') &&
          logText.includes('multi-camera dashboard grid view') &&
          capturedLogs.some((l) => l.includes('[baby_crib_cam]') && l.includes('multi-camera dashboard grid view')),
        false,
        'Active direct rtsp_url camera must never log multi-camera dashboard grid view'
      );
      assert.equal(
        capturedLogs.some((l) => l.includes('[baby_playroom_cam]') && l.includes('multi-camera dashboard grid view')),
        false,
        'Idle direct rtsp_url camera must never log multi-camera dashboard grid view'
      );
      assert.equal(
        capturedLogs.some((l) => l.includes('[baby_crib_cam]') && l.includes('streaming direct RTSP')),
        true,
        'Active direct rtsp_url camera must log streaming direct RTSP'
      );
      assert.equal(
        capturedLogs.some((l) => l.includes('[baby_playroom_cam]') && l.includes('connecting direct RTSP stream')),
        true,
        'Idle direct rtsp_url camera must log connecting direct RTSP stream'
      );
      assert.deepEqual(
        triggeredCams,
        ['baby_playroom_cam'],
        'Only the idle direct rtsp_url camera should be triggered to start pulling RTSP'
      );
    }
  );
});

describe('Frigate and go2rtc Client Modules (src/services/)', () => {
  it('splits mask sync, viewer polling, and upstream helpers while frigate-client.js re-exports them', () => {
    // Verify: mask sync (frigate-masks.js) and go2rtc viewer polling (go2rtc-viewers.js) own their state in separate
    // modules, shared HTTP helpers live in upstream-health.js, and frigate-client.js re-exports the identical
    // functions so every existing import keeps working.
    const client = require('../../src/services/frigate-client');
    const masks = require('../../src/services/frigate-masks');
    const viewers = require('../../src/services/go2rtc-viewers');
    const health = require('../../src/services/upstream-health');
    for (const name of [
      'isFrigateConnected',
      'buildFrigateMaskPayload',
      'buildFrigateMaskDeletePayload',
      'isFrigateMaskIntact',
      'syncSingleFrigateMaskSection',
      'syncFrigateMotionMasks',
      'handleEncoderReconnectMaskSync',
      'checkPeriodicMaskSync',
    ]) {
      assert.equal(typeof masks[name], 'function', name + ' must be exported by frigate-masks.js');
      assert.equal(client[name], masks[name], name + ' must be re-exported unchanged by frigate-client.js');
    }
    for (const name of ['isGo2rtcConnected', 'classifyViewerAction', 'pollViewers']) {
      assert.equal(typeof viewers[name], 'function', name + ' must be exported by go2rtc-viewers.js');
      assert.equal(client[name], viewers[name], name + ' must be re-exported unchanged by frigate-client.js');
    }
    assert.equal(typeof health.syncServiceHealthFlags, 'function');
    assert.equal(typeof health.readHttpErrorSnippet, 'function');
    assert.equal(health.FRIGATE_API_TIMEOUT_MS, 5000);
    assert.equal(health.FRIGATE_FAST_QUERY_TIMEOUT_MS, 2500);
    assert.equal(typeof client.frigateEvent, 'function');
    assert.equal(typeof client.isFrigateCameraIdle, 'function');
    assert.deepEqual(client.FRIGATE_CAMERA_STATES, {
      IDLE: 'idle',
      ACTIVE: 'active',
      UNKNOWN: 'unknown',
    });
  });

  it('returns tri-state idle, active, and unknown from isFrigateCameraIdle across HTTP and JSON failures', async () => {
    // Verify isFrigateCameraIdle distinguishes idle/active event arrays from HTTP 500, timeout, and malformed JSON.
    const {isFrigateCameraIdle, FRIGATE_CAMERA_STATES} = require('../../src/services/frigate-client');
    const cam = new Camera({serial: 'SN0000000470', name: 'idle_tri_state_cam', mode: 'rtsp'});
    const t0 = 1_700_000_000_000;
    const origFetch = global.fetch;

    try {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return [];
        },
      });
      assert.equal(await isFrigateCameraIdle(cam, t0), FRIGATE_CAMERA_STATES.IDLE);

      global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return [{id: 'ev-1', label: 'person', data: {type: 'object'}, start_time: t0 / 1000, end_time: null}];
        },
      });
      assert.equal(await isFrigateCameraIdle(cam, t0), FRIGATE_CAMERA_STATES.ACTIVE);

      global.fetch = async () => ({
        ok: false,
        status: 500,
        async json() {
          return [];
        },
      });
      assert.equal(await isFrigateCameraIdle(cam, t0), FRIGATE_CAMERA_STATES.UNKNOWN);

      global.fetch = async () => {
        const timeoutErr = new Error('The operation was aborted due to timeout');
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      };
      assert.equal(await isFrigateCameraIdle(cam, t0), FRIGATE_CAMERA_STATES.UNKNOWN);

      global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });
      assert.equal(await isFrigateCameraIdle(cam, t0), FRIGATE_CAMERA_STATES.UNKNOWN);

      global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
          return {detail: 'unexpected object'};
        },
      });
      assert.equal(await isFrigateCameraIdle(cam, t0), FRIGATE_CAMERA_STATES.UNKNOWN);
    } finally {
      global.fetch = origFetch;
    }
  });
});
