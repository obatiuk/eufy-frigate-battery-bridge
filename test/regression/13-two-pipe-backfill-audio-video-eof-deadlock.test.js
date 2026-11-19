/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 13. Two-Pipe Backfill Audio/Video EOF Deadlock & `RTSP` Re-Wake Loops
 * (docs/regression/13-two-pipe-backfill-audio-video-eof-deadlock.md).
 */
'use strict';

const {afterEach, mock, describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub, createOfflineRecoveryHarness} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera, SESSION_STATES} = require('../../src/domain/camera');
const {applyDeviceProperties, configureEufyClientHooks} = require('../../src/services/eufy-client');
const {
  onEvent,
  stop,
  processBackfillQueue,
  initOrchestrator,
  wakeCameraExternal,
} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

afterEach(() => {
  mock.timers.reset();
});

describe('Regression 13. Two-Pipe Backfill Audio/Video EOF Deadlock & `RTSP` Re-Wake Loops', () => {
  it(
    'Regression 13: expires post-viewer linger P2P streams cleanly, guards P2P restarts, ' +
      'and queries during tail drain',
    () => {
      // Regression 13: expires post-viewer linger P2P streams cleanly, guards P2P restarts, and queries during tail
      // drain.
      // 10. P2P viewer linger disconnect, mid-session starting guard, and lastStartAt refresh in backfill mode
      const garageCam = new Camera({serial: 'T8161T1111111111', name: 'garage', mode: 'backfill'});
      const tView = 1000000;
      garageCam.applyViewTrigger(tView, 'live view opened', 20000, 'viewer');
      garageCam.beginSession('p2p', tView, true);
      garageCam.markP2pVideoPacketReceived(tView + 4000);
      garageCam.recordDecodedFrame(Buffer.alloc(FRAME, 0x20), Buffer.alloc(FRAME, 0x20), tView + 4000, '22:22');
      const liveOverlaySpec = garageCam.prepareLiveCardOverlay(Buffer.alloc(FRAME, 0x20));
      assert.equal('frameMarker' in liveOverlaySpec, false);

      // When all viewers disconnect (viewerIds empty) and stream stops during post-viewer linger,
      // end cleanly ('expired') instead of re-waking
      assert.equal(garageCam.hasWakingViewer(), false);
      assert.equal(
        garageCam.evaluateExternalLivestreamStop(tView + 12000, 3000).action,
        'expired',
        'Must not re-request P2P livestream during post-viewer linger after all viewers disconnected'
      );
      assert.equal(
        garageCam.evaluateP2pHealth(tView + 12000, tView + 4000).action,
        'expired',
        'Watchdog must expire viewer-only P2P stream cleanly when camera stops sending video after viewer disconnected'
      );

      // While an active viewer is connected, markP2pStreamReady updates lastStartAt and
      // starting=true suppresses self-stop events
      garageCam.registerNewViewer('v1', tView + 5000);
      garageCam.setViewerWakingStatus('v1', true);
      garageCam.beginP2pStartAttempt();
      assert.equal(
        garageCam.evaluateExternalLivestreamStop(tView + 13000, 3000).action,
        'inactive',
        'Must ignore livestream stopped events while startLivestream (starting=true) is restarting the stream'
      );
      garageCam.markP2pStreamReady(tView + 14000);
      garageCam.finishP2pStartAttempt(garageCam.getSessionId());
      assert.equal(
        garageCam.isMidStreamRetrigger(tView + 15000, 5000),
        false,
        'markP2pStreamReady must refresh lastStartAt so watchdog retries do not trigger false ' +
          '+15s mid-stream hold extensions'
      );
      const termP2p = garageCam.terminateSession(tView + 16000, 'viewer closed', false, 'eufy/camera');
      assert.equal(termP2p.hadUnexpectedRtsp, false);
      assert.deepEqual(
        garageCam.evaluateQualityChange({videoStreamingQuality: {value: 10}}),
        {shouldUpdate: true, currentQuality: 10, targetQuality: 7},
        'evaluateQualityChange must clamp High/Ultra/4K (>7) streaming quality down to Medium (7) ' +
          'to prevent 4K bandwidth stalls over weak Wi-Fi'
      );

      // 11. Back-to-back backfill during DRAINING_BACKFILL_TAIL: needsLatestInfoBackfillQuery
      // returns true whenever pendingBackfill has no matched clip
      const backToBackCam = new Camera({serial: 'T8161T4444444444', name: 'garage_b2b', mode: 'backfill'});
      const tClip1 = 2000000;
      backToBackCam.beginBackfillDownload(
        {
          storagePath: '/zx/clip1.zxvideo',
          cipherId: 0,
          clipMs: tClip1 - 15000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        tClip1
      );
      const tailFrame = Buffer.alloc(FRAME, 0x33);
      backToBackCam.recordDecodedFrame(tailFrame, tailFrame, tClip1 + 500, '20:40', 5000);
      backToBackCam.markDownloadFinished(tClip1 + 3000);
      assert.equal(backToBackCam.getStoredSessionState(), SESSION_STATES.DRAINING_BACKFILL_TAIL);
      assert.equal(backToBackCam.needsLatestInfoBackfillQuery(), false);
      backToBackCam.queueEventBackfill(tClip1 + 4000, 'person detected', '', 'person detected', 250, true);
      backToBackCam.recordMotionCleared(tClip1 + 14000, 4000, 30000, 'person detected');
      assert.equal(
        backToBackCam.needsLatestInfoBackfillQuery(),
        true,
        'Must query station.database_query_latest_info even while Clip 1 is in ' +
          'DRAINING_BACKFILL_TAIL so Clip 2 is matched before Clip 1 finishes'
      );
      backToBackCam.tryMatchBackfillCandidate({
        devSn: 'T8161T4444444444',
        storagePath: '/zx/clip2.zxvideo',
        cipherId: 0,
        clipMs: tClip1 + 4500,
      });
      assert.equal(
        backToBackCam.needsLatestInfoBackfillQuery(),
        false,
        'Once Clip 2 is matched into backfillClip, needsLatestInfoBackfillQuery returns false'
      );
    }
  );

  it(
    'Regression 13: guards post-sleep video packets, wedged P2P radios, sequential set_property sync, ' +
      'spotlight tracking, stream adoption, and station wake pacing',
    async () => {
      // Regression 13: guards post-sleep video packets, wedged P2P radios, sequential set_property sync, spotlight
      // tracking, stream adoption, and station wake pacing.
      const {onlineCam1, offlineDoorbell, cams, bySerial, sentCommands, wsInstance, armStopNotRunningOnce} =
        await createOfflineRecoveryHarness();
      offlineDoorbell.applyTelemetryProperties({state: 1, battery: 3, wifiRssi: -24, temperature: 30}, false);

      // 4. Trailing or unsolicited 'livestream video data' while inactive must never self-adopt
      // as an external P2P wake; past 3s it must send device.stop_livestream
      const stopNow = Date.now();
      offlineDoorbell.clearEncoderOfflinePause();
      offlineDoorbell.beginSession('p2p', stopNow - 30000, true);
      offlineDoorbell.setGotVideo(true);
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

      offlineDoorbell.setSleptAt(stopNow - 4000);
      offlineDoorbell.setLastStoppedAt(stopNow - 4000);
      offlineDoorbell.setLastUnsolicitedStopAt(0);
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

      offlineDoorbell.setSleptAt(Date.now() - 30000);
      offlineDoorbell.setLastStoppedAt(Date.now() - 30000);
      offlineDoorbell.setLastWedgedRadioStopAt(0);
      armStopNotRunningOnce();
      sentCommands.length = 0;

      mock.timers.enable({apis: ['setTimeout']});
      for (const rssi of [-25, -24, -25, -24]) {
        onEvent({
          event: 'property changed',
          serialNumber: offlineDoorbell.getSerial(),
          name: 'wifiRssi',
          value: rssi,
        });
      }
      await flushAsync();
      mock.timers.tick(500);
      await flushAsync();
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
        'Wedged idle radio stop must only send device.stop_livestream and never ' +
          'station.disconnect or device.cancel_download (which trigger HomeBase reconnect wake loops)'
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
          setImmediate(() => {
            inFlightSetProps--;
            wsInstance.handlers.get('message')(
              JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}})
            );
          });
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
      await flushAsync();
      assert.deepEqual(setPropOrder, ['recordingClipLength=30', 'recordingEndClipMotionStops=true', 'rtspStream=true']);
      assert.equal(
        maxConcurrentSetProps,
        1,
        'Multiple device.set_property calls on startup mode switch and stuck spotlight reset must ' +
          'execute sequentially so HomeBase does not drop concurrent writes'
      );

      // Default track_stuck_spotlight=false must NOT send light=false on idle wifiRssi drain recovery
      setPropOrder.length = 0;
      offlineDoorbell.applyTelemetryProperties({light: true}, false, Date.now() - 200000);
      offlineDoorbell.setSleptAt(Date.now() - 200000);
      offlineDoorbell.setLastStoppedAt(Date.now() - 200000);
      offlineDoorbell.setLastWedgedRadioStopAt(0);
      for (const rssi of [-25, -24, -25, -24]) {
        onEvent({
          event: 'property changed',
          serialNumber: offlineDoorbell.getSerial(),
          name: 'wifiRssi',
          value: rssi,
        });
      }
      await flushAsync();
      mock.timers.tick(500);
      await flushAsync();
      assert.deepEqual(
        setPropOrder,
        [],
        'Default track_stuck_spotlight=false must not send light=false during idle wifiRssi drain recovery'
      );

      // When track_stuck_spotlight=true is configured on a camera, idle wifiRssi spam when
      // spotlight is stuck on turns off light=false
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
      trackedSpotlightCam.setSleptAt(Date.now() - 200000);
      trackedSpotlightCam.setLastStoppedAt(Date.now() - 200000);
      trackedSpotlightCam.setLastWedgedRadioStopAt(0);
      for (const rssi of [-25, -24, -25, -24]) {
        onEvent({
          event: 'property changed',
          serialNumber: trackedSpotlightCam.getSerial(),
          name: 'wifiRssi',
          value: rssi,
        });
      }
      await flushAsync();
      mock.timers.tick(500);
      await flushAsync();
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
      await flushAsync();
      assert.equal(
        sentCommands.includes('device.get_properties'),
        false,
        'stop() after STREAM_MODES.DOWNLOAD must not poll device.get_properties on a sleeping backfill camera'
      );

      // 7. Genuine wake timeout stop() must mark an unresponsive camera offline and must not poll
      //    cached device.get_properties, whereas external "rtsp livestream started" on an IDLE
      //    RTSP-capable camera (e.g. Home Assistant button.press) is adopted as an active RTSP event session
      sentCommands.length = 0;
      setPropOrder.length = 0;
      offlineDoorbell.beginSession('p2p', Date.now(), true);
      stop(offlineDoorbell, 'stream stalled without video', true, 'error/watchdog-timeout');
      await flushAsync();
      assert.equal(
        offlineDoorbell.isDeviceOffline(),
        true,
        'Wake timeout without video must keep camera marked wakeTimedOutOffline'
      );
      assert.equal(
        sentCommands.includes('device.get_properties'),
        false,
        'stop() after a wake timeout must not call device.get_properties and clear ' +
          'wakeTimedOutOffline from cached properties'
      );
      offlineDoorbell.applyTelemetryProperties({state: 1, battery: 90}, false);
      offlineDoorbell.clearEncoderOfflinePause();
      offlineDoorbell.clearP2pStopInFlight();

      // Regression: "backfill" cameras (both P2P T8214 and RTSP T8161) and IDLE RTSP cameras must
      // never adopt "rtsp livestream started" or "livestream started" as live sessions
      offlineDoorbell.setSleptAt(Date.now() - 15000);
      offlineDoorbell.setLastStoppedAt(Date.now() - 15000);
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
      onlineCam1.setSleptAt(Date.now() - 15000);
      onlineCam1.setLastStoppedAt(Date.now() - 15000);
      onEvent({
        event: 'rtsp livestream started',
        serialNumber: onlineCam1.getSerial(),
      });
      assert.equal(
        onlineCam1.isSessionActive(),
        true,
        'IDLE RTSP camera in mode="rtsp" must adopt external rtsp livestream started outside ' +
          '3s post-sleep guard (AT-05)'
      );
      assert.equal(onlineCam1.getActiveMode(), 'rtsp');
      stop(onlineCam1, 'test cleanup', false, 'bridge-test');

      // 8. processBackfillQueue queries station.database_query_latest_info even while camera is
      // in DRAINING_BACKFILL_TAIL
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
        'processBackfillQueue must send station.database_query_latest_info while draining Clip 1 ' +
          'tail so back-to-back Clip 2 is matched without waiting for IDLE'
      );
      stop(offlineDoorbell, 'test cleanup', false, 'bridge-test');

      // Unexpected 'rtsp livestream started' during WAKING_P2P disables rtspStream, stops RTSP
      // livestream, restarts P2P livestream, and prevents false offline state
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
      await flushAsync();

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

      // Regression: a second 'rtsp livestream started' in the same WAKING_P2P session must be
      // ignored (no infinite stop/start loop)
      sentCommands.length = 0;
      setPropOrder.length = 0;
      onEvent({
        source: 'device',
        event: 'rtsp livestream started',
        serialNumber: p2pDoorbell.getSerial(),
      });
      await flushAsync();
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

      // Regression: multi-camera /api/wake using WakeRequest.build() (without explicit
      // .withDelay()) must still pace wakes on the same station by 2500ms
      const {WakeRequest} = require('../../src/domain/camera');
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
          'Second camera on the same station woken via WakeRequest.build() must be paced by ' +
            'STATION_WAKE_PACING_MS (~2500ms)'
        );
      } finally {
        paceCam2.clearApiWakeTimer();
        for (const c of [paceCam1, paceCam2]) {
          if (c.getFrigateEventTimer()) {
            clearTimeout(c.getFrigateEventTimer());
            c.setFrigateEventTimer(null);
          }
        }
        stop(paceCam1, 'cleanup', false, 'bridge-test');
        stop(paceCam2, 'cleanup', false, 'bridge-test');
      }
      configureEufyClientHooks({onDeviceOnlineResume: () => {}});
    }
  );
});
