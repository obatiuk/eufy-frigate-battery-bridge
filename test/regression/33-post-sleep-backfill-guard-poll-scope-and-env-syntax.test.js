/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 33. Post-Sleep Backfill Guard, Scoped Viewer Refresh, Queue State & Env Syntax
 * (docs/regression/33-post-sleep-backfill-guard-poll-scope-and-env-syntax.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {expandConfigEnvVars} = require('../../src/config');
const {initLogger} = require('../../src/logger');
const {
  BACKFILL_STATES,
  ALLOWED_BACKFILL_TRANSITIONS,
  canTransitionBackfill,
  BackfillJob,
  BACKFILL_POST_CLEAR_SETTLE_MS,
  DEFAULT_BACKFILL_MAX_AGE_MS,
} = require('../../src/domain/backfill-job');
const {
  SESSION_STATES,
  ALLOWED_SESSION_TRANSITIONS,
  canTransitionSession,
  Camera,
  FRIGATE_EVENT_STATES,
  DECODER_STATES,
  WakeRequest,
} = require('../../src/domain/camera');
const {pollViewers} = require('../../src/services/frigate-client');
const {stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 33. Post-Sleep Backfill Guard, Scoped Viewer Refresh, Queue State & Env Syntax', () => {
  it(
    'Regression 33: enforces strict FSM transition validation across Session, BackfillJob, FrigateEvent, and ' +
      'Decoder state machines, plus WakeRequest builder',
    () => {
      // Regression 33: enforces strict FSM transition validation across Session, BackfillJob, FrigateEvent, and
      // Decoder state machines, plus WakeRequest builder.
      // 1. Session FSM transition table validation
      assert.ok(Object.isFrozen(SESSION_STATES));
      assert.ok(Object.isFrozen(ALLOWED_SESSION_TRANSITIONS));
      assert.equal(canTransitionSession(SESSION_STATES.IDLE, SESSION_STATES.WAKING_P2P), true);
      assert.equal(canTransitionSession(SESSION_STATES.IDLE, SESSION_STATES.PLAYING_BACKFILL), false);
      assert.equal(canTransitionSession(SESSION_STATES.IDLE, SESSION_STATES.DRAINING_BACKFILL_TAIL), false);

      const cam = new Camera({serial: 'T8161T0000000000', mode: 'p2p', hold_secs: 60});
      assert.equal(
        cam.transitionTo(SESSION_STATES.PLAYING_BACKFILL, 1000, 'illegal jump'),
        SESSION_STATES.IDLE,
        'Must reject illegal transition from IDLE directly to PLAYING_BACKFILL'
      );

      // 2. BackfillJob strict FSM transitions: RECORDING -> SETTLING -> RECORDING -> SETTLING ->
      // READY_TO_QUERY -> MATCHED -> DOWNLOADING -> COMPLETED | EXPIRED
      // Verify tightened transition map, refused-transition debug logs, monomorphic upgradeEvent(opts),
      // pure isReadyToQuery/isExpired predicates vs explicit commands, and isUrgentBackfillProtectedFrom on IDLE.
      assert.ok(Object.isFrozen(BACKFILL_STATES));
      assert.ok(Object.isFrozen(ALLOWED_BACKFILL_TRANSITIONS));
      assert.equal(canTransitionBackfill(BACKFILL_STATES.RECORDING, BACKFILL_STATES.SETTLING), true);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.RECORDING, BACKFILL_STATES.DOWNLOADING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.READY_TO_QUERY, BACKFILL_STATES.RECORDING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.READY_TO_QUERY, BACKFILL_STATES.SETTLING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.MATCHED, BACKFILL_STATES.RECORDING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.MATCHED, BACKFILL_STATES.SETTLING), false);
      assert.equal(canTransitionBackfill(BACKFILL_STATES.MATCHED, BACKFILL_STATES.READY_TO_QUERY), false);

      const viewerCandidate = new Camera({serial: 'SN0000000099', name: 'viewer_only', mode: 'p2p'});
      viewerCandidate.setViewUntil(50000);
      assert.equal(
        cam.isUrgentBackfillProtectedFrom(viewerCandidate, 1000),
        false,
        'Idle camera must not report urgent backfill protection against viewer wakes'
      );

      const t0 = 100000;
      const job = new BackfillJob({
        name: 'doorbell',
        at: t0,
        event: 'motion detected',
        personName: '',
        reason: 'motion detected',
        priority: 100,
      });
      assert.equal(job.state, BACKFILL_STATES.RECORDING);
      assert.throws(
        () => job.upgradeEvent(/** @type {*} */ ('person detected')),
        TypeError,
        'upgradeEvent must require a monomorphic options object'
      );

      const refusedDebugLines = [];
      const prevLog = console.log;
      initLogger('debug');
      console.log = (line) => refusedDebugLines.push(line);
      try {
        assert.equal(job.transitionTo(BACKFILL_STATES.DOWNLOADING, 'illegal skip'), BACKFILL_STATES.RECORDING);
      } finally {
        console.log = prevLog;
        initLogger('error');
      }
      assert.equal(
        refusedDebugLines.some((line) =>
          line.includes('refused backfill state: recording -> downloading (illegal skip)')
        ),
        true,
        'Disallowed BackfillJob transition must log a refused debug message'
      );

      job.markRecordingCleared(t0 + 10000, 'motion detected');
      assert.equal(job.state, BACKFILL_STATES.SETTLING);

      // Companion event re-activates recording from SETTLING
      job.upgradeEvent({
        at: t0 + 11000,
        event: 'person detected',
        personName: 'Alice',
        reason: 'person detected (Alice)',
        priority: 250,
      });
      assert.equal(job.state, BACKFILL_STATES.RECORDING);
      job.markRecordingCleared(t0 + 20000, 'person detected');
      assert.equal(job.state, BACKFILL_STATES.SETTLING);

      // Pure predicate isReadyToQuery must not mutate state; markReadyToQueryIfSettled performs transition
      assert.equal(job.isReadyToQuery(t0 + 20000 + BACKFILL_POST_CLEAR_SETTLE_MS, 65000), true);
      assert.equal(job.state, BACKFILL_STATES.SETTLING, 'Pure isReadyToQuery must not mutate BackfillJob state');
      assert.equal(job.markReadyToQueryIfSettled(t0 + 20000 + BACKFILL_POST_CLEAR_SETTLE_MS, 65000), true);
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY);

      // Once READY_TO_QUERY, upgradeEvent with recordingActive=true upgrades metadata without regressing to RECORDING
      job.upgradeEvent({
        at: t0 + 24500,
        event: 'rings',
        personName: 'Alice',
        reason: 'rings',
        priority: 1000,
        recordingActive: true,
      });
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY);
      assert.equal(job.recordingActive, false);
      assert.equal(job.event, 'rings');

      const candidate = {
        devSn: 'T8161T0000000000',
        storagePath: '/zx/clip1.zxvideo',
        cipherId: 0,
        clipMs: t0 + 1000,
      };
      assert.equal(job.enqueueMatchedCandidate(candidate, new Set()), true);
      assert.equal(job.state, BACKFILL_STATES.MATCHED);

      const nextClip = job.shiftNextClipForDownload();
      assert.ok(nextClip);
      assert.equal(job.state, BACKFILL_STATES.DOWNLOADING);

      // Regression: matching a second clip while Clip 1 is DOWNLOADING must keep DOWNLOADING state
      const candidate2 = {
        devSn: 'T8161T0000000000',
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 0,
        clipMs: t0 + 2000,
      };
      assert.equal(job.enqueueMatchedCandidate(candidate2, new Set()), true);
      assert.equal(job.state, BACKFILL_STATES.DOWNLOADING);
      assert.equal(job.completeCurrentDownload(), BACKFILL_STATES.MATCHED);
      assert.ok(job.shiftNextClipForDownload());
      assert.equal(job.state, BACKFILL_STATES.DOWNLOADING);

      // Follow-up query transitions DOWNLOADING -> READY_TO_QUERY
      assert.equal(job.prepareFollowUpQuery(t0 + 25000), true);
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY);

      // Pure predicate isExpired must not mutate state; expireIfNeeded transitions to EXPIRED
      const expiredAt = t0 + 25000 + DEFAULT_BACKFILL_MAX_AGE_MS + 1000;
      assert.equal(job.isExpired(expiredAt), true);
      assert.equal(job.state, BACKFILL_STATES.READY_TO_QUERY, 'Pure isExpired must not mutate BackfillJob state');
      assert.equal(job.expireIfNeeded(expiredAt), true);
      assert.equal(job.state, BACKFILL_STATES.EXPIRED);

      // Terminal EXPIRED job ignores subsequent upgradeEvent mutations
      assert.equal(
        job.upgradeEvent({
          at: expiredAt + 1000,
          event: 'identity person detected',
          personName: 'Bob',
          reason: 'identity person detected (Bob)',
          priority: 5000,
          recordingActive: true,
        }),
        false
      );
      assert.equal(job.personName, 'Alice');
      assert.equal(job.recordingActive, false);

      // 3. Frigate Event Lifecycle FSM: IDLE -> QUEUED -> WAITING_SNAPSHOT -> COOLDOWN -> IDLE
      assert.ok(Object.isFrozen(FRIGATE_EVENT_STATES));
      assert.equal(cam.getFrigateEventState(t0), FRIGATE_EVENT_STATES.IDLE);
      assert.equal(cam.tryUpgradeOrQueueFrigateEvent('motion detected', '', t0).status, 'queued');
      assert.equal(cam.getFrigateEventState(t0), FRIGATE_EVENT_STATES.QUEUED);
      assert.equal(cam.beginFrigateSnapshotWait(), true);
      assert.equal(cam.getFrigateEventState(t0 + 600), FRIGATE_EVENT_STATES.WAITING_SNAPSHOT);
      cam.completeFrigateEventFiling(t0 + 2000, 15);
      assert.equal(cam.getFrigateEventState(t0 + 2500), FRIGATE_EVENT_STATES.COOLDOWN);
      assert.equal(cam.getFrigateEventState(t0 + 120000), FRIGATE_EVENT_STATES.IDLE);

      // 4. Decoder Backpressure FSM: DETACHED -> HANDSHAKING -> DECODING -> PAUSED_BACKPRESSURE ->
      // FLUSHING_EOF -> DETACHED
      assert.ok(Object.isFrozen(DECODER_STATES));
      assert.equal(cam.getDecoderState(), DECODER_STATES.DETACHED);
      cam.attachDecoder({stdin: {writable: true, write() {}, end() {}}, stdout: {pause() {}, resume() {}}});
      assert.equal(cam.getDecoderState(), DECODER_STATES.HANDSHAKING);
      cam.markDecoderDecoding();
      assert.equal(cam.getDecoderState(), DECODER_STATES.DECODING);
      cam.pauseDecoderStdout();
      assert.equal(cam.getDecoderState(), DECODER_STATES.PAUSED_BACKPRESSURE);
      cam.resumeDecoderStdout();
      assert.equal(cam.getDecoderState(), DECODER_STATES.DECODING);
      cam.markDecoderInputEnded();
      assert.equal(cam.getDecoderState(), DECODER_STATES.FLUSHING_EOF);
      cam.detachDecoder();
      assert.equal(cam.getDecoderState(), DECODER_STATES.DETACHED);

      // 5. Immutable WakeRequest Builder & default health policy methods
      const req = WakeRequest.motion('person detected (Alice)', 45000)
        .withInitiator('eufy-ws/event')
        .withPriority(250)
        .withCreateEvent(true)
        .build();
      assert.ok(Object.isFrozen(req));
      assert.equal(req.kind, 'motion');
      assert.equal(req.reason, 'person detected (Alice)');
      assert.equal(req.durationMs, 45000);
      assert.equal(req.initiator, 'eufy-ws/event');
      assert.equal(req.priority, 250);

      const applied = cam.applyWakeRequest(req, t0, [cam]);
      assert.equal(applied.accepted, true);
      assert.equal(cam.getMotionUntil(), t0 + 45000);
      assert.equal(cam.getWakeInitiator(), 'eufy-ws/event');

      cam.beginSession('p2p', t0, false);
      // Default thresholds on evaluateP2pHealth & shouldPollFrigateForHoldOrBackfill work without magic numbers
      assert.equal(cam.evaluateP2pHealth(t0 + 1000, t0).action, 'none');
      assert.equal(cam.shouldPollFrigateForHoldOrBackfill(t0 + 1000).shouldPoll, false);

      // 6. State transition logging for BackfillJob, FrigateEvent, and Decoder state machines
      const loggedLines = [];
      const origConsoleLog = console.log;
      initLogger('debug');
      console.log = (line) => loggedLines.push(line);
      try {
        const logCam = new Camera({serial: 'T8214T2222222222', name: 'doorbell', mode: 'backfill'});
        logCam.queueEventBackfill(t0, 'person detected', 'Alice', 'person detected (Alice)', 200, true);
        logCam.recordMotionCleared(t0 + 5000, 5000, 10000, 'person detected');
        assert.equal(logCam.canQueryBackfill(t0 + 10000, 8000, 12000), true);
        logCam.beginBackfillDatabaseQuery(t0 + 10000);
        logCam.tryMatchBackfillCandidate({
          devSn: 'T8214T2222222222',
          storagePath: '/zx/clip_log.zxvideo',
          cipherId: 0,
          clipMs: t0 + 1000,
        });
        logCam.beginBackfillDownload(logCam.getBackfillClip(), false, t0 + 11000);

        logCam.tryUpgradeOrQueueFrigateEvent('person', 'Alice', t0);
        logCam.beginFrigateSnapshotWait();
        logCam.completeFrigateEventFiling(t0 + 2000, 15);
        logCam.getFrigateEventState(t0 + 120000);

        logCam.attachDecoder({stdin: {writable: true, write() {}, end() {}}, stdout: {pause() {}, resume() {}}});
        logCam.markDecoderDecoding();
        logCam.pauseDecoderStdout();
        logCam.resumeDecoderStdout();
        logCam.markDecoderInputEnded();
        logCam.detachDecoder();
      } finally {
        console.log = origConsoleLog;
        initLogger('error');
      }

      const strippedLogs = loggedLines.map((line) =>
        line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[DEBUG\] - /, '')
      );
      assert.deepEqual(
        strippedLogs.filter((l) => l.includes('backfill state:')),
        [
          '[doorbell] [SETTLING] backfill state: recording -> settling (all triggers cleared)',
          '[doorbell] [READY_TO_QUERY] backfill state: settling -> ready_to_query (settle window elapsed)',
          '[doorbell] [MATCHED] backfill state: ready_to_query -> matched (candidate clip matched)',
          '[doorbell] [DOWNLOADING] backfill state: matched -> downloading (clip dequeued for download)',
        ]
      );
      assert.deepEqual(
        strippedLogs.filter((l) => l.includes('frigate event state:')),
        [
          '[doorbell] [QUEUED] frigate event state: idle -> queued (event queued)',
          '[doorbell] [WAITING_SNAPSHOT] frigate event state: queued -> waiting_snapshot (dispatch timer fired)',
          '[doorbell] [COOLDOWN] frigate event state: waiting_snapshot -> cooldown (event filed)',
          '[doorbell] [IDLE] frigate event state: cooldown -> idle (cooldown elapsed)',
        ]
      );
      assert.deepEqual(
        strippedLogs.filter((l) => l.includes('decoder state:')),
        [
          '[doorbell] [HANDSHAKING] decoder state: detached -> handshaking (decoder attached)',
          '[doorbell] [DECODING] decoder state: handshaking -> decoding (first frame decoded)',
          '[doorbell] [PAUSED_BACKPRESSURE] decoder state: decoding -> paused_backpressure (high watermark reached)',
          '[doorbell] [DECODING] decoder state: paused_backpressure -> decoding (low watermark resumed)',
          '[doorbell] [FLUSHING_EOF] decoder state: decoding -> flushing_eof (input pipe ended)',
          '[doorbell] [DETACHED] decoder state: flushing_eof -> detached (decoder detached)',
        ]
      );
    }
  );

  it(
    'Regression 33: rejects malformed or unclosed ${...} placeholders in ' +
      'expandConfigEnvVars() without leaking secrets',
    () => {
      // Regression: typos like ${RTSP_PASS, ${123}, ${}, or ${VAR:default} must fail in one pass
      const malformedCases = [
        'rtsp://user:${RTSP_PASS@192.0.2.10:554/live0',
        'rtsp://${123}:pass@192.0.2.10:554/live0',
        'rtsp://${}:pass@192.0.2.10:554/live0',
        'rtsp://${RTSP_USER:default}@192.0.2.10:554/live0',
        'rtsp://${FOO ${BAR}@192.0.2.10:554/live0',
      ];
      for (const badUrl of malformedCases) {
        assert.throws(
          () =>
            expandConfigEnvVars(
              {
                cameras: [
                  {name: 'secret_cam', mode: 'rtsp', rtsp_url: 'rtsp://${OK_SECRET}@192.0.2.11:554/live0'},
                  {name: 'bad_cam', mode: 'rtsp', rtsp_url: badUrl},
                ],
              },
              {OK_SECRET: 'DO_NOT_LEAK_SECRET', BAR: 'bar'}
            ),
          (err) => {
            assert.match(
              err.message,
              /config\.yaml:.*malformed environment variable placeholder.*cameras\[1\]\.rtsp_url/
            );
            assert.equal(err.message.includes('DO_NOT_LEAK_SECRET'), false);
            return true;
          }
        );
      }

      // Escaped $${...} sequences remain literal without failing malformed checks
      const escaped = expandConfigEnvVars({
        cameras: [{name: 'esc_cam', title: 'Tag $${123} $${LITERAL_ONLY}', serial: 'T8161T0000000099'}],
      });
      assert.equal(escaped.cameras[0].title, 'Tag ${123} ${LITERAL_ONLY}');
    }
  );

  it(
    'Regression 33: refreshes HomeBase via pollViewers only when single-camera Live View opens on an offline ' +
      'camera',
    async () => {
      // Verify: viewing unrelated online/direct cameras or dashboard grids never refreshes an offline camera.
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
      onlineCam1.applyTelemetryProperties({state: 1, battery: 100, wifiRssi: -70}, false);
      onlineCam2.applyTelemetryProperties({state: 1, battery: 95, wifiRssi: -71}, false);
      offlineDoorbell.applyTelemetryProperties({state: 3, battery: 1, chargingStatus: 2, wifiRssi: -100}, false);
      offlineDoorbell.pauseEncoderForOffline();
      assert.equal(offlineDoorbell.isDeviceOffline(), true);

      const directLiveCam = new Camera({
        name: 'nursery_direct_poll',
        rtsp_url: 'rtsp://127.0.0.1:8554/nursery_direct_poll',
      });
      const pollScopeCams = [onlineCam1, onlineCam2, directLiveCam, offlineDoorbell];
      const origFetch = global.fetch;
      let telemetryForceRefreshes = 0;
      let viewerMode = 'online_single';
      const viewerStreamsByMode = {
        online_single: {
          driveway: {
            consumers: [
              {id: 'frigate-rec-1', user_agent: 'FFmpeg Frigate'},
              {id: 'browser-1', user_agent: 'Mozilla/5.0', format_name: 'mse'},
            ],
          },
        },
        direct_single: {
          nursery_direct_poll: {
            consumers: [{id: 'direct-v1', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
          },
        },
        grid: {
          backyard: {consumers: [{id: 'grid-backyard', user_agent: 'Mozilla/5.0', format_name: 'mse'}]},
          doorbell: {consumers: [{id: 'grid-doorbell', user_agent: 'Mozilla/5.0', format_name: 'mse'}]},
        },
        offline_single: {
          doorbell: {consumers: [{id: 'offline-v1', user_agent: 'Mozilla/5.0', format_name: 'mse'}]},
        },
      };
      global.fetch = async () => ({
        ok: true,
        async json() {
          return viewerStreamsByMode[viewerMode] || {};
        },
      });

      try {
        for (const mode of ['online_single', 'direct_single', 'grid']) {
          viewerMode = mode;
          await pollViewers(pollScopeCams, {
            isShuttingDown: () => false,
            fetchAllCameraTelemetry: (force) => {
              if (force) telemetryForceRefreshes++;
            },
            stopCam: () => {},
            triggerCam: () => {},
          });
        }
        assert.equal(
          telemetryForceRefreshes,
          0,
          'Viewing unrelated online/direct cameras or dashboard grids must not trigger HomeBase poll_refresh'
        );

        viewerMode = 'offline_single';
        await pollViewers(pollScopeCams, {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: (force) => {
            if (force) telemetryForceRefreshes++;
          },
          stopCam: () => {},
          triggerCam: () => {},
        });
      } finally {
        global.fetch = origFetch;
        stop(directLiveCam, 'cleanup', false, 'rtsp-direct-probe');
      }

      assert.equal(
        telemetryForceRefreshes,
        1,
        'Single-camera Live View on the offline camera must trigger HomeBase poll_refresh once'
      );
    }
  );
});
