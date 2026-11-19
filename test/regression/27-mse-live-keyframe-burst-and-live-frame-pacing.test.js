/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 27. MSE Live Keyframe Burst, Live Frame Drain Drift & High-FPS RTSP Overflow
 * (docs/regression/27-mse-live-keyframe-burst-and-live-frame-pacing.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {FRAME, LIVE_FPS} = require('../../src/config');
const {Camera} = require('../../src/domain/camera');
const {renderCameraCards} = require('../../src/overlay/card-renderer');
const {handleDecodedRtspFrame, buildScaleFilter, buildRtspDecoderArgs} = require('../../src/media/decoder');
const {shouldWriteEncoderFrame} = require('../../src/media/encoder');

describe('Regression 27. MSE Live Keyframe Burst, Live Frame Drain Drift & High-FPS RTSP Overflow', () => {
  it(
    'Regression 27: paces live keyframe bursts at 15 fps for fast MSE attach, drains due liveFrames on decode ' +
      'without drift lag, and caps >15 fps RTSP inputs',
    () => {
      // Regression: (1) shouldWriteEncoderFrame ignored inBurst when isLive=true, delaying
      // H.264 -g 15 keyframes up to 7.5s on VFR/night streams when Frigate Grid View attached
      // MSE; (2) handleDecodedRtspFrame/handleDecodedP2pFrame did not flush due frames when
      // buffering into liveFrames, causing 66.67ms (15 fps) streams to drift behind
      // setInterval(67ms) up to 12 frames (800ms lag + head drops); (3) buildRtspDecoderArgs
      // lacked a non-duplicating VFR 15 fps cap for 20-30 fps cameras.
      const burstCam = new Camera(
        {serial: 'T8161T9900000027', name: 'nursery_grid', mode: 'rtsp', card_show_on_live: false},
        {frame: Buffer.alloc(FRAME, 0x22), lastSeen: '21:00'},
        renderCameraCards
      );
      const t0 = 500000;
      burstCam.setLastWriteAt(t0);
      burstCam.setFrameNew(false);

      assert.equal(
        shouldWriteEncoderFrame(burstCam, true, false, true, t0 + 10),
        false,
        'Live keyframe burst must still block sub-frame duplicate floods 10ms after lastWrite'
      );
      assert.equal(
        shouldWriteEncoderFrame(burstCam, true, false, true, t0 + 67),
        true,
        'Live keyframe burst must write at 15 fps cadence (>=62ms) even when frameNew is false ' +
          'so MSE receives an IDR keyframe within 1s'
      );
      assert.equal(
        shouldWriteEncoderFrame(burstCam, true, false, false, t0 + 67),
        false,
        'Outside keyframe burst, static/VFR live streams with frameNew=false must remain ' +
          'throttled to heartbeat interval'
      );

      // Continuous 15.00 fps (66ms) RTSP decode after a 2-frame Wi-Fi jitter pair must drain due frames immediately
      // on frame arrival instead of accumulating a 12-frame (800ms) backlog behind setInterval(67ms).
      const encodedFirstBytes = [];
      const mockStdin = {
        writable: true,
        writableNeedDrain: false,
        write(buf) {
          encodedFirstBytes.push(buf[0]);
          return true;
        },
      };
      burstCam.attachEncoder({stdin: mockStdin}, t0);
      burstCam.beginSession('rtsp', t0, true);
      const scratch = Buffer.alloc(FRAME, 0x51);
      const sid = burstCam.getSessionId();

      // Frame A and Frame B arrive 2ms apart -> A encodes immediately, B queues in liveFrames (length=1)
      handleDecodedRtspFrame(burstCam, scratch, t0 + 100, sid);
      scratch.fill(0x52);
      handleDecodedRtspFrame(burstCam, scratch, t0 + 102, sid);
      assert.deepEqual(encodedFirstBytes, [0x51]);
      assert.equal(burstCam.getBufferedLiveFrameCount(), 1);

      // Steady 15 fps frames arrive every 66ms before setInterval(67ms) ticks -> each arrival
      // drains the due frame so queue stays at 1!
      let now = t0 + 100;
      for (let i = 0; i < 20; i++) {
        now += 66;
        scratch.fill(0x60 + i);
        handleDecodedRtspFrame(burstCam, scratch, now, sid);
        assert.equal(
          burstCam.getBufferedLiveFrameCount(),
          1,
          'Continuous 15 fps RTSP stream must drain due frame on decode instead of drifting ' +
            'up to MAX_LIVE_BURST_FRAMES (12)'
        );
      }
      assert.equal(encodedFirstBytes.length, 21);
      burstCam.endSession(now + 100, true, false, 'rtsp');

      // Verify RTSP decoder -vf prepends a non-duplicating select= VFR cap at LIVE_FPS (15 fps) ahead of scale=
      const scale = buildScaleFilter(false);
      const rtspArgs = buildRtspDecoderArgs('rtsp://127.0.0.1:8554/nursery', scale);
      const vfIdx = rtspArgs.indexOf('-vf');
      assert.notEqual(vfIdx, -1);
      const vfVal = rtspArgs[vfIdx + 1];
      assert.equal(
        vfVal.startsWith("select='if(isnan(t),1,") && vfVal.includes('1/' + LIVE_FPS) && vfVal.endsWith(',' + scale),
        true,
        'RTSP decoder -vf must prepend non-duplicating select VFR framerate cap ahead of scale filter'
      );
      assert.equal(
        vfVal.includes('fps='),
        false,
        'RTSP decoder must not use duplicating fps= filter that adds 1-frame lookahead ' +
          'latency and duplicates 10 fps IR night frames'
      );
    }
  );
});
