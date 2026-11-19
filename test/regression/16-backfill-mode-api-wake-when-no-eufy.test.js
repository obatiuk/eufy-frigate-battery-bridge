/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 16. `"backfill"` Mode `/api/wake` With No Eufy Clip, Viewer Block & Download
 * Isolation (docs/regression/16-backfill-mode-api-wake-when-no-eufy.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');
const {initOrchestrator, wakeCameraExternal, onEvent, stop} = require('../../src/services/stream-orchestrator');

installDefaultFetchStub();

describe('Regression 16. `"backfill"` Mode `/api/wake` With No Eufy Clip, Viewer Block & Download Isolation', () => {
  it(
    'Regression 16: wakes idle backfill cameras live on /api/wake when no clip is recording, blocks Live View ' +
      'while a BackfillJob is pending, isolates DOWNLOAD from live P2P stops, and retries incomplete clips',
    () => {
      // Regression: /api/wake on an idle backfill camera queued a BackfillJob when HomeBase never recorded a clip,
      // Live View canceled pending BackfillJobs, mobile app livestream stopped killed DOWNLOAD playback, and
      // interrupted downloads before download finished did not retry.
      const bfCam = new Camera({
        serial: 'T8214T0000160001',
        name: 'bf_iso_doorbell',
        mode: 'backfill',
        station_serial: 'T8030P0000160000',
      });
      initOrchestrator([bfCam], new Map([[bfCam.getSerial(), bfCam]]), () => false);
      configureEufyClientHooks({
        cams: [bfCam],
        bySerial: new Map([[bfCam.getSerial(), bfCam]]),
        isShuttingDown: () => false,
        WebSocket: function MockIsoWs() {
          const handlers = new Map();
          return {
            readyState: 1,
            on(ev, fn) {
              handlers.set(ev, fn);
            },
            send(raw, cb) {
              const msg = JSON.parse(raw);
              if (cb) cb();
              const onMsg = handlers.get('message');
              if (onMsg) {
                queueMicrotask(() => {
                  onMsg(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
                });
              }
            },
          };
        },
      });
      connectWs();
      configureEufyClientHooks({isShuttingDown: () => true});

      const liveWake = wakeCameraExternal(bfCam, {
        durationMs: 25000,
        reason: 'garage sensor',
        createEvent: false,
        delayMs: 5000,
      });
      assert.equal(liveWake.status, 'scheduled');
      bfCam.clearApiWakeTimer();

      const t0 = Date.now();
      bfCam.queueEventBackfill(t0, 'person detected', '', 'person detected', 200, true);
      assert.equal(bfCam.isWaitingForBackfill(t0), true);
      assert.equal(bfCam.isViewerBlockedByBackfill(), true);
      const activeBfWake = wakeCameraExternal(bfCam, {durationMs: 25000, reason: 'garage sensor', createEvent: false});
      assert.equal(activeBfWake.status, 'backfill');
      bfCam.clearPendingBackfill();

      bfCam.beginBackfillDownload(
        {
          storagePath: '/zx/retry_clip.zxvideo',
          cipherId: 0,
          clipMs: t0 - 5000,
          event: 'person detected',
          personName: '',
          reason: 'person detected',
        },
        false,
        t0 + 1000
      );
      onEvent({source: 'device', event: 'livestream stopped', serialNumber: bfCam.getSerial()});
      assert.equal(bfCam.isBackfillPlayback(), true);

      stop(bfCam, 'station dropped mid-transfer', false, 'error/station-disconnect');
      assert.equal(bfCam.canStartBackfillDownloadNow([bfCam], t0 + 20000, 0), true);
      bfCam.clearPendingBackfill();
    }
  );
});
