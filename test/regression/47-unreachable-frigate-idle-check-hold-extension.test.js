/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 47. Unreachable Frigate Treated as Active Object During Hold & Early-Sleep Checks
 * (docs/regression/47-unreachable-frigate-idle-check-hold-extension.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {Camera} = require('../../src/domain/camera');
const {runHousekeepingTick, initOrchestrator} = require('../../src/services/stream-orchestrator');

describe('Regression 47. Unreachable Frigate Treated as Active Object During Hold & Early-Sleep Checks', () => {
  it(
    'Regression 47: skips Frigate hold extension and early-sleep confirmation on 500, timeout, and bad JSON ' +
      'while preserving hardware-trigger extensions',
    async () => {
      // Regression: isFrigateCameraIdle returned false on HTTP 500, timeout, or invalid JSON, causing
      // evaluateActiveHoldExtension to treat Frigate outages as active objects and hold cameras to stream_max_secs.
      const t0 = 1_794_600_000_000;
      const origFetch = global.fetch;
      const origDateNow = Date.now;
      let nowMs = t0;
      Date.now = () => nowMs;

      const buildActiveRtspCam = (serial, name, extra = {}) => {
        const cam = new Camera({
          serial,
          name,
          mode: 'rtsp',
          hold_secs: 30,
          stream_max_secs: 900,
          startup_snapshot: false,
          ...extra,
        });
        cam.updateDiscoveredRtspConfig('T8030P0000000047', 'rtsp://127.0.0.1:8554/' + name);
        cam.setMotionUntil(t0 + 30_000);
        cam.setLastMotionAt(t0);
        cam.setEventActive(true);
        cam.setReason('motion detected');
        cam.beginSession('rtsp', t0, true);
        cam.setGotVideo(true);
        cam.setFirstVideoAt(t0 + 1_000);
        cam.setLastVideoAt(t0 + 29_500);
        cam.setFrigateEventUntil(t0 + 30_000);
        cam.setStoredFrigateEventState('cooldown');
        return cam;
      };

      try {
        for (const failureKind of ['http500', 'timeout', 'badJson']) {
          const cam = buildActiveRtspCam('SN0000000471', 'outage_' + failureKind, {
            mode: 'backfill',
          });
          cam.queueEventBackfill(t0 + 25_000, 'person detected', '', 'person detected', 100, false);
          initOrchestrator([cam], new Map([[cam.getSerial(), cam]]), () => false);
          global.fetch = async (url) => {
            if (String(url).includes('/api/events')) {
              if (failureKind === 'http500') {
                return {
                  ok: false,
                  status: 500,
                  async json() {
                    return [];
                  },
                };
              }
              if (failureKind === 'timeout') {
                throw new Error('fetch failed: timeout');
              }
              return {
                ok: true,
                status: 200,
                async json() {
                  throw new SyntaxError('invalid json');
                },
              };
            }
            return {
              ok: true,
              status: 200,
              async json() {
                return [];
              },
              async text() {
                return '';
              },
            };
          };

          nowMs = t0 + 27_000;
          cam.setLastVideoAt(nowMs);
          runHousekeepingTick(nowMs);
          await flushAsync();

          assert.equal(
            cam.getMotionUntil(),
            t0 + 30_000,
            failureKind + ': unknown Frigate state before expiry must leave motionUntil unchanged'
          );
          assert.equal(
            cam.hasPendingBackfill(),
            true,
            failureKind + ': unknown Frigate state must not falsely confirm Frigate object detection'
          );

          nowMs = t0 + 30_000;
          cam.setLastVideoAt(nowMs);
          runHousekeepingTick(nowMs);
          await flushAsync();

          assert.equal(
            cam.isSessionActive(),
            false,
            failureKind + ': expired hold must stop cleanly once unknown Frigate check finishes'
          );
          assert.equal(cam.getMotionUntil(), 0);
        }

        // Early sleep (idle_timeout_secs) must skip confirmation when Frigate is unknown rather than sleeping early.
        const earlyCam = buildActiveRtspCam('SN0000000472', 'early_unknown_cam', {
          idle_timeout_secs: 15,
          end_early: false,
        });
        earlyCam.recordMotionCleared(t0 + 5_000, 5_000, 10_000, 'motion detected');
        initOrchestrator([earlyCam], new Map([[earlyCam.getSerial(), earlyCam]]), () => false);
        global.fetch = async () => ({
          ok: false,
          status: 503,
          async json() {
            return [];
          },
        });

        nowMs = t0 + 20_000;
        earlyCam.setLastVideoAt(nowMs);
        runHousekeepingTick(nowMs);
        await flushAsync();
        assert.equal(earlyCam.isSessionActive(), true, 'unknown Frigate state must not confirm early sleep');

        // Active Eufy hardware trigger must still extend the hold even when Frigate returns 500.
        const hwCam = buildActiveRtspCam('SN0000000473', 'hw_active_outage_cam');
        hwCam.queueEventBackfill(t0 + 25_000, 'person detected', '', 'person detected', 100, true);
        initOrchestrator([hwCam], new Map([[hwCam.getSerial(), hwCam]]), () => false);
        nowMs = t0 + 30_000;
        hwCam.setLastVideoAt(nowMs);
        runHousekeepingTick(nowMs);
        await flushAsync();
        assert.equal(hwCam.isSessionActive(), true);
        assert.equal(hwCam.getMotionUntil(), t0 + 45_000);
        hwCam.endSession(t0 + 45_000, true, false, 'rtsp');
      } finally {
        initOrchestrator([], new Map(), () => true);
        Date.now = origDateNow;
        global.fetch = origFetch;
      }
    }
  );
});
