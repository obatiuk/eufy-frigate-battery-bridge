/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 56:
 * Smooth Multi-Camera Grid View Attaches & h264_qsv Zero-B-Frame Latency
 * (docs/regression/56-grid-view-burst-pacing-and-qsv-zero-bframes.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {FRAME} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {handleDecodedRtspFrame} = require('../../src/media/decoder');
const {buildVideoCodecArgs, pushFrameToEncoder, shouldWriteEncoderFrame} = require('../../src/media/encoder');
const {pollViewers} = require('../../src/services/go2rtc-viewers');

installDefaultFetchStub();

describe('Regression 56: Smooth Multi-Camera Grid View Attaches & h264_qsv Zero-B-Frame Latency', () => {
  it(
    'Regression 56: sets -bf 0 on h264_qsv and paces sleeping and live keyframe bursts without preempting 15 fps ' +
      'live decodes',
    () => {
      // Regression: h264_qsv omitted -bf 0, sleeping inBurst bypassed livePaceMs, and live inBurst at 62ms wrote a
      // duplicate frame 4.7ms ahead of steady 66.7ms decodes.
      const qsvArgs = buildVideoCodecArgs('qsv', '15');
      const bfIdx = qsvArgs.indexOf('-bf');
      assert.notEqual(bfIdx, -1);
      assert.equal(qsvArgs[bfIdx + 1], '0');

      const cam = new Camera(
        {serial: 'T8161T0000000056', name: 'courtyard', mode: 'rtsp', card_show_on_live: false},
        {frame: Buffer.alloc(FRAME, 0x24), lastSeen: '14:00'},
        renderCameraCards
      );
      const t0 = 300_000;
      cam.setLastWriteAt(t0);
      cam.setFrameNew(false);

      // 1. Sleeping keyframe burst paces at livePaceMs (62ms) instead of writing on back-to-back calls
      assert.equal(shouldWriteEncoderFrame(cam, false, false, true, t0 + 5), false);
      assert.equal(shouldWriteEncoderFrame(cam, false, false, true, t0 + 62), true);

      // 2. Live keyframe burst waits 67ms so a ticker firing at +65ms/+66ms never duplicates ahead of real decode
      assert.equal(shouldWriteEncoderFrame(cam, true, false, true, t0 + 65), false);
      assert.equal(shouldWriteEncoderFrame(cam, true, false, true, t0 + 66), false);
      assert.equal(shouldWriteEncoderFrame(cam, true, false, true, t0 + 67), true);

      /** @type {number[]} */
      const writtenFirstBytes = [];
      cam.attachEncoder(
        {
          stdin: {
            writable: true,
            writableNeedDrain: false,
            write(buf) {
              writtenFirstBytes.push(buf[0]);
              return true;
            },
          },
        },
        t0
      );
      cam.beginSession('rtsp', t0, true);
      cam.triggerKeyframeBurst(t0, 5000);
      const sid = cam.getSessionId();
      const decodedBuf = Buffer.alloc(FRAME, 0x70);

      let now = t0 + 100;
      handleDecodedRtspFrame(cam, decodedBuf, now, sid);
      assert.deepEqual(writtenFirstBytes, [0x70]);

      for (let i = 1; i <= 5; i++) {
        // Ticker fires 65ms after last write (1ms before next 15 fps decoded frame arrives)
        pushFrameToEncoder(cam, now + 65);
        assert.equal(writtenFirstBytes.length, i, 'Ticker at +65ms during inBurst must not write a duplicate frame');

        now += 66;
        decodedBuf.fill(0x70 + i);
        handleDecodedRtspFrame(cam, decodedBuf, now, sid);
        assert.equal(writtenFirstBytes.length, i + 1);
        assert.equal(cam.getBufferedLiveFrameCount(), 0, 'Real 66ms live frame must encode directly without queuing');
      }
      cam.endSession(now + 100, true, false, 'rtsp');
    }
  );

  it(
    'Regression 56: avoids synchronous multi-camera encoder write spikes on simultaneous dashboard grid attaches ' +
      'while pushing once on single-camera Live View attach',
    async (t) => {
      // Regression: applyStreamConsumers pushed frames inside the consumer loop across every sleeping tile on Grid
      // View attach.
      t.mock.timers.enable({apis: ['Date'], now: 600_000});
      const makeGridCam = (idx) => {
        const cam = new Camera(
          {serial: 'T8161T000000056' + idx, name: 'grid_cam_' + idx, mode: 'backfill'},
          {frame: Buffer.alloc(FRAME, 0x30 + idx), lastSeen: '15:00'},
          renderCameraCards
        );
        let writes = 0;
        cam.attachEncoder(
          {
            stdin: {
              writable: true,
              writableNeedDrain: false,
              write() {
                writes += 1;
                return true;
              },
            },
          },
          600_000 - 5000
        );
        // Prime steady-state sleeping card + existing recorder consumer
        pushFrameToEncoder(cam, 600_000 - 150);
        cam.notifyEncoderConsumersObserved(1, 6000, 600_000 - 150);
        writes = 0;
        return {cam, getWrites: () => writes};
      };

      const tiles = [makeGridCam(1), makeGridCam(2), makeGridCam(3)];
      const origFetch = global.fetch;
      try {
        // 1. Simultaneous multi-camera Grid View attach across 3 sleeping cameras -> 0 synchronous writes in poll
        global.fetch = /** @type {*} */ (
          async () => ({
            ok: true,
            status: 200,
            async json() {
              return {
                grid_cam_1: {
                  consumers: [
                    {id: 'rec-1', user_agent: 'FFmpeg Frigate'},
                    {id: 'mse-1', user_agent: 'Mozilla/5.0', format_name: 'mse'},
                    {id: 'rtc-1', user_agent: 'Mozilla/5.0', format_name: 'webrtc'},
                  ],
                },
                grid_cam_2: {
                  consumers: [
                    {id: 'rec-2', user_agent: 'FFmpeg Frigate'},
                    {id: 'mse-2', user_agent: 'Mozilla/5.0', format_name: 'mse'},
                  ],
                },
                grid_cam_3: {
                  consumers: [
                    {id: 'rec-3', user_agent: 'FFmpeg Frigate'},
                    {id: 'mse-3', user_agent: 'Mozilla/5.0', format_name: 'mse'},
                  ],
                },
              };
            },
          })
        );
        await pollViewers(
          tiles.map((x) => x.cam),
          {
            isShuttingDown: () => false,
            fetchAllCameraTelemetry: async () => {},
            stopCam: () => {},
            triggerCam: () => {},
          }
        );
        assert.deepEqual(
          tiles.map((x) => x.getWrites()),
          [0, 0, 0],
          'Dashboard Grid View poll must defer sleeping tile bursts to the media ticker instead of spiking writes'
        );

        // 2. Single-camera attach with 2 simultaneous consumers writes once (never twice back-to-back)
        const single = makeGridCam(4);
        global.fetch = /** @type {*} */ (
          async () => ({
            ok: true,
            status: 200,
            async json() {
              return {
                grid_cam_4: {
                  consumers: [
                    {id: 'rec-4', user_agent: 'FFmpeg Frigate'},
                    {id: 'mse-4', user_agent: 'Mozilla/5.0', format_name: 'mse'},
                    {id: 'rtc-4', user_agent: 'Mozilla/5.0', format_name: 'webrtc'},
                  ],
                },
              };
            },
          })
        );
        await pollViewers([single.cam], {
          isShuttingDown: () => false,
          fetchAllCameraTelemetry: async () => {},
          stopCam: () => {},
          triggerCam: () => {},
        });
        assert.equal(single.getWrites(), 1);
      } finally {
        global.fetch = origFetch;
      }
    }
  );
});
