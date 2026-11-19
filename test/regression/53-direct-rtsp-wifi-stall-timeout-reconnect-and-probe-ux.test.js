/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 53. Direct RTSP Wi-Fi Stall Tolerance, Fast Live Reconnect & Passive Probe Handling
 * (docs/regression/53-direct-rtsp-wifi-stall-timeout-reconnect-and-probe-ux.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');

require('../helpers/test-env');
const {initLogger} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {
  configureDecoderHooks,
  buildScaleFilter,
  buildRtspDecoderArgs,
  startRtspDecoder,
  stopDecoder,
  handleDecodedRtspFrame,
} = require('../../src/media/decoder');
const {pollViewers} = require('../../src/services/go2rtc-viewers');
const {initOrchestrator, handleRtspStreamDropped, stop, trigger} = require('../../src/services/stream-orchestrator');
const {handleSigUsr2SyntheticEventTest} = require('../../src/app');

describe('Regression 53. Direct RTSP Wi-Fi Stall Tolerance, Fast Live Reconnect & Passive Probe Handling', () => {
  it(
    'Regression 53: uses 15s TCP/mid-stall tolerance on direct rtsp_url streams, skips COOLDOWN with 1s ' +
      'post-live reconnect, reports connecting on passive probes, and skips rtsp_url cameras on SIGUSR2',
    async () => {
      // Regression: (1) direct rtsp_url cameras used the 5s HomeBase RTSP socket and mid-stall timeouts, dropping
      // 24/7 Wi-Fi streams during 6s-12s TCP retransmission stalls; (2) live drops entered 5s COOLDOWN and waited 5s
      // before reconnecting; (3) pollViewers logged "streaming direct RTSP" when a viewer joined an un-decoded 5s
      // passive probe; and (4) SIGUSR2 targeted cams[0] even when it was a direct rtsp_url camera.
      const t0 = 1_800_000_000_000;
      const frameBytes = 1280 * 720 + (1280 * 720) / 2;
      const scale = buildScaleFilter(true);

      // 1. HomeBase RTSP keeps 5s (-timeout 5000000); direct rtsp_url uses 15s (-timeout 15000000)
      const hbArgs = buildRtspDecoderArgs('rtsp://192.0.2.10/live0', scale);
      const hbTimeoutIdx = hbArgs.indexOf('-timeout');
      assert.equal(hbArgs[hbTimeoutIdx + 1], '5000000');

      const directArgs = buildRtspDecoderArgs('rtsp://192.0.2.20/live0', scale, {directRtsp: true});
      const directTimeoutIdx = directArgs.indexOf('-timeout');
      assert.equal(directArgs[directTimeoutIdx + 1], '15000000');

      const kidsCam = new Camera({
        name: 'kids_room_camera',
        title: 'Kids Room Camera',
        mode: 'rtsp',
        rtsp_url: 'rtsp://viewer:secret@192.0.2.52:554/live0',
      });
      const spawnedArgs = [];
      configureDecoderHooks({
        spawn: (_bin, args) => {
          spawnedArgs.push([...args]);
          const proc = new EventEmitter();
          proc.stdout = new PassThrough();
          proc.stderr = new PassThrough();
          proc.stdio = [null, proc.stdout, proc.stderr, null, new PassThrough()];
          proc.kill = () => true;
          return proc;
        },
      });

      try {
        kidsCam.beginRtspDirectProbeSession(t0);
        startRtspDecoder(kidsCam);
        assert.equal(spawnedArgs.length, 1);
        const spawnedTimeoutIdx = spawnedArgs[0].indexOf('-timeout');
        assert.equal(
          spawnedArgs[0][spawnedTimeoutIdx + 1],
          '15000000',
          'startRtspDecoder must pass 15s (-timeout 15000000) for direct rtsp_url cameras'
        );

        // Initial un-decoded probe still times out promptly after 8s so powered-off cameras fail fast.
        assert.equal(kidsCam.evaluateRtspHealth(t0 + 7_500).action, 'none');
        assert.equal(kidsCam.evaluateRtspHealth(t0 + 8_500).action, 'dropped');
        stopDecoder(kidsCam);
        kidsCam.endSession(t0 + 8_500, false, false, 'rtsp');

        // Once Frame 0 decodes, an 11s Wi-Fi TCP retransmission stall must NOT drop the direct RTSP session,
        // whereas > 15s without frames triggers a drop.
        const tLive = t0 + 20_000;
        kidsCam.beginRtspDirectProbeSession(tLive);
        handleDecodedRtspFrame(kidsCam, Buffer.alloc(frameBytes, 0x42), tLive + 500, kidsCam.getSessionId());
        assert.equal(kidsCam.getStoredSessionState(), 'streaming_live');
        assert.equal(
          kidsCam.evaluateRtspHealth(tLive + 11_500).action,
          'none',
          'Established direct rtsp_url stream must ride through an 11s Wi-Fi TCP stall without dropping'
        );
        assert.equal(
          kidsCam.evaluateRtspHealth(tLive + 15_600).action,
          'dropped',
          'Established direct rtsp_url stream must still detect stalls exceeding 15s'
        );

        // 2. When an established direct rtsp_url stream ends/drops, it skips 5s COOLDOWN (goes straight to IDLE)
        //    and reconnects after 1s; if that follow-up probe fails without video, subsequent probes pace at 5s.
        initOrchestrator([kidsCam], new Map(), () => false);
        const origNow = Date.now;
        let fakeNow = tLive + 16_000;
        Date.now = () => fakeNow;
        try {
          handleRtspStreamDropped(kidsCam, 0, 'Server closed stream');
          assert.equal(kidsCam.isSessionActive(), false);
          assert.equal(
            kidsCam.getStoredSessionState(),
            'idle',
            'Direct rtsp_url camera must transition straight to idle instead of entering viewer cooldown'
          );
          assert.equal(kidsCam.shouldStartRtspDirectSession(fakeNow + 500), false);
          assert.equal(
            kidsCam.shouldStartRtspDirectSession(fakeNow + 1_000),
            true,
            'Direct rtsp_url camera must reconnect 1s after an established live stream drops'
          );

          // Follow-up probe exits without video (camera turned off) -> reverts to standard 5s probe pacing.
          fakeNow += 1_000;
          kidsCam.beginRtspDirectProbeSession(fakeNow);
          fakeNow += 200;
          handleRtspStreamDropped(kidsCam, 1, 'Server returned 404 Not Found');
          assert.equal(kidsCam.shouldStartRtspDirectSession(fakeNow + 1_500), false);
          assert.equal(kidsCam.shouldStartRtspDirectSession(fakeNow + 4_900), false);
          assert.equal(
            kidsCam.shouldStartRtspDirectSession(fakeNow + 5_000),
            true,
            'After a probe without video, direct rtsp_url camera must resume 5s passive probe pacing'
          );
        } finally {
          Date.now = origNow;
        }

        // 3. Viewer joining during an un-decoded 5s passive probe must log "connecting direct RTSP stream"
        //    and promote the passive probe in-place without double-triggering or restarting the active decoder.
        const probeViewCam = new Camera({
          name: 'crib_camera',
          title: 'Crib Camera',
          mode: 'rtsp',
          rtsp_url: 'rtsp://192.0.2.53:554/live0',
        });
        const tProbe = t0 + 60_000;
        probeViewCam.beginRtspDirectProbeSession(tProbe);
        startRtspDecoder(probeViewCam);
        const spawnsBeforeViewer = spawnedArgs.length;
        assert.equal(probeViewCam.isPassiveRtspDirectProbe(), true);

        const capturedLogs = [];
        const triggeredNames = [];
        const origFetch = global.fetch;
        const origWrite = process.stdout.write;
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
                crib_camera: {
                  consumers: [{id: 'viewer-probe-1', user_agent: 'Mozilla/5.0', format_name: 'mse'}],
                },
              };
            },
          });
          await pollViewers([probeViewCam], {
            isShuttingDown: () => false,
            fetchAllCameraTelemetry: async () => {},
            stopCam: stop,
            triggerCam: (cam, opts) => {
              triggeredNames.push(cam.getName());
              trigger(cam, opts);
            },
          });
        } finally {
          process.stdout.write = origWrite;
          initLogger('error');
          global.fetch = origFetch;
        }

        const joinedLogs = capturedLogs.join('');
        assert.equal(
          joinedLogs.includes('connecting direct RTSP stream'),
          true,
          'Viewer joining an un-decoded passive rtsp_url probe must log connecting direct RTSP stream'
        );
        assert.equal(
          joinedLogs.includes('streaming direct RTSP'),
          false,
          'Viewer joining before Frame 0 decodes must not log streaming direct RTSP'
        );
        assert.equal(probeViewCam.hasWakingViewer(), true);
        assert.equal(probeViewCam.isPassiveRtspDirectProbe(), false);
        assert.equal(probeViewCam.getWakeInitiator(), 'viewer');
        assert.deepEqual(triggeredNames, [], 'In-place passive probe promotion must not re-trigger or respawn decoder');
        assert.equal(spawnedArgs.length, spawnsBeforeViewer);
        stopDecoder(probeViewCam);
        probeViewCam.endSession(tProbe + 2_000, false, false, 'rtsp');

        // 4. SIGUSR2 synthetic test event skips direct rtsp_url cameras and safely handles empty/direct-only lists.
        assert.equal(typeof handleSigUsr2SyntheticEventTest, 'function');
        const eufyStorageCam = new Camera({
          serial: 'SN0000000531',
          name: 'storage_cam',
          title: 'Storage Camera',
          mode: 'rtsp',
        });
        const postedUrls = [];
        const origFetchSig = global.fetch;
        global.fetch = async (url) => {
          postedUrls.push(String(url));
          return {
            ok: true,
            status: 200,
            async json() {
              return {success: true, event_id: 'evt-sigusr2-53'};
            },
          };
        };
        try {
          assert.doesNotThrow(() => handleSigUsr2SyntheticEventTest([]));
          assert.doesNotThrow(() => handleSigUsr2SyntheticEventTest([kidsCam]));
          assert.deepEqual(postedUrls, [], 'SIGUSR2 must not file Frigate events when only direct rtsp_url cams exist');

          const target = handleSigUsr2SyntheticEventTest([kidsCam, eufyStorageCam]);
          assert.equal(target, eufyStorageCam, 'SIGUSR2 must select the first non-direct Eufy camera');
        } finally {
          eufyStorageCam.abortPendingFrigateEvent('test cleanup');
          global.fetch = origFetchSig;
        }
      } finally {
        configureDecoderHooks({spawn: null});
        stopDecoder(kidsCam);
        initOrchestrator([], new Map(), () => true);
      }
    }
  );
});
