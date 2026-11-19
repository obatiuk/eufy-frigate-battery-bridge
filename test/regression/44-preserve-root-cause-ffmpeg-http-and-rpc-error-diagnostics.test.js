/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 44. Preserve Root-Cause FFmpeg, HTTP, WebSocket, and RPC Error Diagnostics
 * (docs/regression/44-preserve-root-cause-ffmpeg-http-and-rpc-error-diagnostics.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {createFakeFfmpegProcess, finishFakeFfmpegProcess} = require('../helpers/media-mocks');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {log} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {getCacheFilePath, loadCachedFrame, saveCachedFrame} = require('../../src/overlay/snapshot-cache');
const {configureDecoderHooks, setRtspDropHandler, startRtspDecoder} = require('../../src/media/decoder');
const {FfmpegArgsBuilder} = require('../../src/media/ffmpeg-args');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {syncSingleFrigateMaskSection, pollViewers} = require('../../src/services/frigate-client');
const {notifyHA} = require('../../src/services/ha-notifier');
const {initOrchestrator, onEvent, processBackfillQueue} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 44. Preserve Root-Cause FFmpeg, HTTP, WebSocket, and RPC Error Diagnostics', () => {
  it(
    'Regression 44: distinguishes direct RTSP handshake/protocol failures from network unreachability ' +
      'in evaluateRtspDirectDrop()',
    () => {
      // Regression: evaluateRtspDirectDrop() reported "direct RTSP endpoint unreachable (Error opening input files:
      // Invalid data found when processing input)" even when TCP connected and the camera closed or rejected the RTSP
      // handshake; must explain closed/invalid RTSP replies and distinguish handshake rejections from unreachable IPs.
      const cam = new Camera({
        name: 'kids_room_camera',
        mode: 'rtsp',
        rtsp_url: 'rtsp://viewer:secret@192.0.2.77:554/live0',
      });

      // 1. Bare FFmpeg AVERROR_INVALIDDATA on RTSP open (camera accepted TCP then closed/reset before valid RTSP reply)
      cam.beginRtspDirectProbeSession(1000);
      const eofDrop = cam.evaluateRtspDirectDrop(
        1,
        '[in#0 @ 0x55c2] Error opening input: Invalid data found when processing input'
      );
      assert.equal(eofDrop.isReachableStandby, false);
      assert.equal(eofDrop.disruptionChanged, true);
      assert.equal(eofDrop.statusLog.includes('direct RTSP handshake failed'), true);
      assert.equal(eofDrop.statusLog.includes('RTSP server closed connection or sent invalid reply'), true);
      assert.equal(eofDrop.statusLog.includes('endpoint unreachable'), false);
      assert.equal(eofDrop.statusLog.includes('-> Disconnected'), true);

      // 2. Restore connected health, then test explicit RTSP 453 / 401 protocol rejection
      cam.markRtspFrameReceived(2000);
      cam.endSession(3000, true, false, 'rtsp');
      cam.beginRtspDirectProbeSession(8000);
      const protoDrop = cam.evaluateRtspDirectDrop(
        1,
        '[rtsp @ 0x7f12] method DESCRIBE failed: 453 Not Enough Bandwidth'
      );
      assert.equal(protoDrop.isReachableStandby, false);
      assert.equal(protoDrop.disruptionChanged, true);
      assert.equal(
        protoDrop.statusLog,
        'direct RTSP handshake failed ' +
          '([rtsp @ 0x7f12] method DESCRIBE failed: 453 Not Enough Bandwidth) -> Disconnected'
      );

      // 3. Restore connected health, then test genuine network unreachability (Connection refused / timeout)
      cam.markRtspFrameReceived(9000);
      cam.endSession(10000, true, false, 'rtsp');
      cam.beginRtspDirectProbeSession(15000);
      const netDrop = cam.evaluateRtspDirectDrop(
        1,
        '[tcp @ 0x7f12] Connection to tcp://192.0.2.77:554 failed: Connection refused'
      );
      assert.equal(netDrop.isReachableStandby, false);
      assert.equal(netDrop.disruptionChanged, true);
      assert.equal(
        netDrop.statusLog,
        'direct RTSP endpoint unreachable ([tcp @ 0x7f12] Connection to tcp://192.0.2.77:554 failed: Connection refused) -> Disconnected'
      );

      // 4. Standby 404 Not Found transitions back to Asleep
      const standbyDrop = cam.evaluateRtspDirectDrop(1, '[rtsp @ 0x7f12] method DESCRIBE failed: 404 Not Found');
      assert.equal(standbyDrop.isReachableStandby, true);
      assert.equal(standbyDrop.disruptionChanged, true);
      assert.equal(standbyDrop.statusLog, 'direct RTSP endpoint reachable in standby (404 Not Found) -> Asleep');
    }
  );

  it(
    'Regression 44: preserves underlying fetch causes, AggregateError sub-errors, full HTTP error bodies, ' +
      'and Eufy RPC messages ' +
      'across service logs',
    async () => {
      // Regression: Node 22 fetch TypeError("fetch failed", {cause}) and dual-stack AggregateError("") hid real
      // socket errors, syncSingleFrigateMaskSection truncated >200-char errors and let legacy fallback exceptions
      // override PUT validation errors, pollViewers/notifyHA dropped HTTP failure details, and Eufy RPC failures
      // omitted res.message and overrode start_download stop reasons.
      const EventEmitter = require('node:events');
      const loggerMod = require('../../src/logger');
      assert.equal(typeof loggerMod.formatErrorMessage, 'function', 'logger.js must export formatErrorMessage');

      // 1. formatErrorMessage unwraps fetch cause + dual-stack AggregateError("") with sub-errors
      const dualStackAgg = new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED ::1:5000'), {code: 'ECONNREFUSED'}),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), {code: 'ECONNREFUSED'}),
      ]);
      dualStackAgg.code = 'ECONNREFUSED';
      const fetchErr = new TypeError('fetch failed', {cause: dualStackAgg});
      const formattedFetchErr = loggerMod.formatErrorMessage(fetchErr);
      assert.equal(formattedFetchErr.includes('fetch failed'), true);
      assert.equal(formattedFetchErr.includes('connect ECONNREFUSED ::1:5000'), true);
      assert.equal(formattedFetchErr.includes('connect ECONNREFUSED 127.0.0.1:5000'), true);

      const warnings = [];
      const errors = [];
      const origWarn = log.warn;
      const origError = log.error;
      const origFetch = global.fetch;
      log.warn = (scope, ...args) => {
        warnings.push((typeof scope === 'object' && scope ? scope.name : String(scope)) + ': ' + args.join(' '));
      };
      log.error = (scope, ...args) => {
        errors.push((typeof scope === 'object' && scope ? scope.name : String(scope)) + ': ' + args.join(' '));
      };

      const diagCam = new Camera({
        serial: 'T8214T0000008881',
        name: 'diag_error_cam',
        mode: 'backfill',
        station_serial: 'T8030P0000008880',
        card_theme: 'glance',
        card_position: 'bottom-left',
        auto_frigate_mask: true,
      });

      try {
        // 2. syncSingleFrigateMaskSection preserves >200-char PUT error body even if legacy fallback throws
        const longValidationMsg =
          '{"detail":[{"loc":["body","config_data","cameras","diag_error_cam","motion","mask"],' +
          '"padding":"' +
          'x'.repeat(160) +
          '","msg":"Invalid polygon coordinate count in mask definition"}]}';
        let maskCallIdx = 0;
        global.fetch = async () => {
          maskCallIdx++;
          if (maskCallIdx === 1) {
            return {
              ok: false,
              status: 422,
              async text() {
                return longValidationMsg;
              },
            };
          }
          throw new Error('The operation was aborted due to timeout');
        };
        const maskRes = await syncSingleFrigateMaskSection(
          diagCam,
          {motion: {mask: {}}},
          {
            section: 'motion',
            poly: diagCam.computeMaskPolygon(),
            frigateUrl: 'http://frigate.local:5000',
          }
        );
        assert.equal(maskRes, 'failed');
        assert.equal(
          warnings.some(
            (w) => w.includes('HTTP 422') && w.includes('Invalid polygon coordinate count in mask definition')
          ),
          true,
          'syncSingleFrigateMaskSection must preserve full >200-char PUT HTTP 422 body even when legacy fallback throws'
        );

        // 3. pollViewers surfaces go2rtc HTTP/network failure reason and notifyHA surfaces non-2xx body + fetch cause
        // Reset go2rtcApiDown first with one 200 OK poll
        global.fetch = async () => ({
          ok: true,
          status: 200,
          async json() {
            return {consumers: []};
          },
        });
        await pollViewers([diagCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        warnings.length = 0;

        global.fetch = async () => {
          throw fetchErr;
        };
        await pollViewers([diagCam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        assert.equal(
          warnings.some(
            (w) => w.includes('go2rtc API unreachable') && w.includes('connect ECONNREFUSED 127.0.0.1:5000')
          ),
          true,
          'pollViewers outage warning must surface underlying fetch cause instead of dropping error'
        );

        warnings.length = 0;
        global.fetch = async () => ({
          ok: false,
          status: 400,
          async text() {
            return 'Webhook invalid payload schema';
          },
        });
        const haOk = await notifyHA(diagCam, {}, 'http://homeassistant.local:8123/api/webhook/test');
        assert.equal(haOk, false);
        assert.equal(
          warnings.some((w) => w.includes('HTTP 400') && w.includes('Webhook invalid payload schema')),
          true,
          'notifyHA must include non-2xx response body details'
        );

        // 4. WebSocket dual-stack AggregateError("") on socket error and RPC res.message on start_download failure
        errors.length = 0;
        warnings.length = 0;
        let activeWs = null;
        class MockDiagWs extends EventEmitter {
          constructor() {
            super();
            this.readyState = 1;
            activeWs = this;
          }
          send(raw, cb) {
            if (cb) cb(null);
            const msg = JSON.parse(raw);
            if (msg.command === 'set_api_schema' || msg.command === 'start_listening') {
              setImmediate(() =>
                this.emit(
                  'message',
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: true,
                    result: {state: {driver: {connected: true}, stations: [], devices: []}},
                  })
                )
              );
            } else if (msg.command === 'device.get_properties') {
              setImmediate(() =>
                this.emit(
                  'message',
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: true,
                    result: {properties: {state: 1, battery: 85}},
                  })
                )
              );
            } else if (msg.command === 'device.start_download') {
              setImmediate(() =>
                this.emit(
                  'message',
                  JSON.stringify({
                    type: 'result',
                    messageId: msg.messageId,
                    success: false,
                    errorCode: 'unknown_error',
                    message: 'Station P2P transfer channel busy',
                  })
                )
              );
            }
          }
          close() {}
        }

        const camMap = new Map([[diagCam.getSerial(), diagCam]]);
        initOrchestrator([diagCam], camMap, () => false);
        configureEufyClientHooks({
          cams: [diagCam],
          bySerial: camMap,
          isShuttingDown: () => false,
          onEvent,
          WebSocket: MockDiagWs,
        });
        connectWs();
        assert.ok(activeWs);
        activeWs.emit('error', dualStackAgg);
        assert.equal(
          errors.some(
            (e) => e.includes('eufy-security-ws error:') && e.includes('connect ECONNREFUSED 127.0.0.1:5000')
          ),
          true,
          'eufy-security-ws socket error must render AggregateError sub-errors instead of blank err.message'
        );

        activeWs.emit('message', JSON.stringify({type: 'version', maxSchemaVersion: 21}));
        await flushAsync();

        const nowMs = Date.now();
        diagCam.queueEventBackfill(nowMs - 20000, 'person detected', '', 'person detected', 200, true);
        diagCam.recordMotionCleared(nowMs - 15000, 4000, 10000, 'person detected');
        diagCam.tryMatchBackfillCandidate({
          devSn: diagCam.getSerial(),
          storagePath: '/zx/diag_fail.zxvideo',
          cipherId: 9,
          clipMs: nowMs - 19000,
          eventLabel: 'person detected',
          personName: '',
        });
        errors.length = 0;
        warnings.length = 0;
        await processBackfillQueue(nowMs);
        await flushAsync();

        assert.equal(
          warnings.some(
            (w) => w.includes('device.start_download failed') && w.includes('Station P2P transfer channel busy')
          ),
          true,
          'device.start_download warning must include eufy-security-ws error message'
        );
        assert.equal(
          errors.some(
            (e) =>
              e.includes('initiator=error/download-failed') &&
              e.includes('unknown_error') &&
              e.includes('Station P2P transfer channel busy')
          ),
          true,
          'SLEEP error/download-failed reason must preserve RPC error details instead of bare ' +
            '"start_download RPC failed"'
        );
      } finally {
        log.warn = origWarn;
        log.error = origError;
        global.fetch = origFetch;
        diagCam.clearPendingBackfill();
        configureEufyClientHooks({isShuttingDown: () => true});
      }
    }
  );

  it(
    'Regression 44: preserves root-cause FFmpeg stderr lines instead of overriding with FFmpeg 7/8 exit footers ' +
      'or truncating at 500 chars',
    async (t) => {
      // Regression: FFmpeg 7/8 appends generic "Error opening input file ...", "Error opening input files: ...",
      // and "Conversion failed!" footers after protocol/muxer root-cause lines, STDERR_TAIL_MAX_CHARS=500 truncated
      // multi-line bursts, and snapshot-cache hid decode/save FFmpeg root causes.
      const EventEmitter = require('node:events');
      const childProcess = require('node:child_process');

      // 1. >600-char RTSP DESCRIBE failure burst with FFmpeg 7/8 exit footers and embedded credentials
      const mockProc = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      const collector = FfmpegArgsBuilder.attachStderrTailCollector(mockProc);
      const longPass = 's3cr3t_password_padding_' + 'x'.repeat(220);
      mockProc.stderr.emit(
        'data',
        Buffer.from(
          '[rtsp @ 0x7fcd8729a980] method DESCRIBE failed: 453 Not Enough Bandwidth\r\n' +
            '[in#0 @ 0x7fcd8729a800] Error opening input: ' +
            'Server returned 4XX Client Error, but not one of 40{0,1,3,4}\r\n' +
            'Error opening input file rtsp://admin:' +
            longPass +
            '@192.0.2.50:554/live0.\r\n' +
            'Error opening input files: Server returned 4XX Client Error, but not one of 40{0,1,3,4}\r\n'
        )
      );

      assert.equal(collector.getLastLine().includes('method DESCRIBE failed: 453 Not Enough Bandwidth'), true);
      assert.equal(collector.getLastLine().includes('Error opening input files:'), false);
      assert.equal(collector.getSummary().includes('method DESCRIBE failed: 453 Not Enough Bandwidth'), true);
      assert.equal(collector.getSummary().includes('Error opening input files:'), false);
      assert.equal(collector.getSummary().includes('s3cr3t_password_padding_'), false);

      // 2. Multi-line RTSP handshake failure in startRtspDecoder before gotVideo preserves all root-cause lines
      const directCam = new Camera({
        name: 'nursery_direct_cam',
        mode: 'rtsp',
        rtsp_url: 'rtsp://viewer:pw@192.0.2.55:554/live0',
      });
      directCam.beginRtspDirectProbeSession(10000);
      const spawnedProcs = [];
      const dropEvents = [];
      configureDecoderHooks({
        spawn: /** @type {*} */ (
          () => {
            const p = Object.assign(new EventEmitter(), {
              pid: 4242,
              stdout: new EventEmitter(),
              stderr: new EventEmitter(),
              stdio: [null, new EventEmitter(), new EventEmitter(), null, new EventEmitter()],
              kill() {},
            });
            spawnedProcs.push(p);
            return p;
          }
        ),
      });
      setRtspDropHandler((cam, code, reasonText) => {
        dropEvents.push({cam, code, reasonText});
      });
      try {
        startRtspDecoder(directCam);
        assert.equal(spawnedProcs.length, 1);
        spawnedProcs[0].stderr.emit(
          'data',
          Buffer.from(
            '[rtsp @ 0x7f11] Nonmatching transport in server reply\n' +
              '[rtsp @ 0x7f11] method SETUP failed: 461 Unsupported Transport\n' +
              '[in#0 @ 0x7f00] Error opening input: Invalid data found when processing input\n' +
              'Error opening input file rtsp://viewer:pw@192.0.2.55:554/live0.\n' +
              'Error opening input files: Invalid data found when processing input\n'
          )
        );
        spawnedProcs[0].emit('exit', 1);

        assert.equal(dropEvents.length, 1);
        assert.equal(dropEvents[0].reasonText.includes('Nonmatching transport in server reply'), true);
        assert.equal(dropEvents[0].reasonText.includes('method SETUP failed: 461 Unsupported Transport'), true);
        assert.equal(dropEvents[0].reasonText.includes('Error opening input files:'), false);
      } finally {
        configureDecoderHooks({spawn: null});
        setRtspDropHandler(null);
      }

      // 3. Snapshot cache decode & save failures preserve real FFmpeg / OS error instead of "Conversion failed!"
      const snapCam = new Camera({serial: 'T8161T0000009991', name: 'snap_diag_cam'});
      const snapFile = getCacheFilePath(snapCam);
      fs.writeFileSync(snapFile, Buffer.from('corrupt-jpeg'));
      const capturedWarns = [];
      const origWarn = log.warn;
      log.warn = (scope, ...args) => {
        capturedWarns.push(args.join(' '));
      };
      t.mock.method(childProcess, 'spawn', (_cmd, args) => {
        const isDecode = Array.isArray(args) && args.includes('rawvideo') && args[args.length - 1] === 'pipe:1';
        const proc = createFakeFfmpegProcess();
        const stderrText = isDecode
          ? '[mjpeg @ 0x7f22] No JPEG data found in image\n' +
            '[in#0 @ 0x7f20] Error decodingframes\n' +
            'Conversion failed!\n'
          : "[image2 @ 0x7f33] Could not open file '/config/cache/last_snap_diag_cam.jpg': Read-only file system\n" +
            '[vost#0:0/mjpeg @ 0x7f34] Error submitting a packet to the muxer: Read-only file system\n' +
            '[out#0/image2 @ 0x7f35] Error muxing a packet\n' +
            '[out#0/image2 @ 0x7f35] video:24KiB audio:0KiB subtitle:0KiB other streams:0KiB ' +
            'global headers:0KiB muxing overhead: unknown\n' +
            'Conversion failed!\n';
        setImmediate(() => finishFakeFfmpegProcess(proc, {status: 1, stderr: Buffer.from(stderrText)}));
        return proc;
      });
      try {
        const loaded = await loadCachedFrame(snapCam);
        assert.equal(loaded.frame, null);
        assert.equal(
          capturedWarns.some(
            (w) => w.includes('failed to decode cached snapshot') && w.includes('No JPEG data found in image')
          ),
          true,
          'loadCachedFrame must include the underlying FFmpeg decode error'
        );

        capturedWarns.length = 0;
        snapCam.recordDecodedFrame(Buffer.alloc(FRAME, 0x33), Buffer.alloc(FRAME, 0x33), 20000, '10:00');
        await saveCachedFrame(snapCam);
        assert.equal(
          capturedWarns.some(
            (w) =>
              w.includes('failed to save cached snapshot:') &&
              w.includes('Read-only file system') &&
              !w.endsWith('Conversion failed!')
          ),
          true,
          'saveCachedFrame must preserve the root-cause mux/open error instead of overriding with Conversion failed!'
        );
      } finally {
        log.warn = origWarn;
        fs.rmSync(snapFile, {force: true});
      }
    }
  );
});
