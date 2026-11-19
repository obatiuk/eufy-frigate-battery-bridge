/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 4. VA-API Hardware Encoding Compatibility & Sleeping Frame Sharpness
 * (docs/regression/04-va-api-hardware-encoding-compatibility-sleeping-frame.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {buildEncodeJpegArgs, buildDecodeJpegArgs} = require('../../src/overlay/snapshot-cache');
const {buildScaleFilter} = require('../../src/media/decoder');
const {buildVideoCodecArgs} = require('../../src/media/encoder');

describe('Regression 4. VA-API Hardware Encoding Compatibility & Sleeping Frame Sharpness', () => {
  it(
    'Regression 4: sets -bf 0 -qp 18 on h264_vaapi, -q:v 2 on cached JPEG snapshots, ' + 'and lanczos scaling filters',
    () => {
      // Regression: VA-API encoders reject B-frames by default on newer Mesa drivers, and -qp 24 with default JPEG
      // quality blurred dark sleeping snapshots.
      const vaapiArgs = buildVideoCodecArgs('vaapi', '15');
      assert.equal(vaapiArgs[vaapiArgs.indexOf('-c:v') + 1], 'h264_vaapi');
      assert.equal(vaapiArgs[vaapiArgs.indexOf('-bf') + 1], '0');
      assert.equal(vaapiArgs[vaapiArgs.indexOf('-qp') + 1], '18');

      const encodeJpegArgs = buildEncodeJpegArgs('/config/cache/last_cam.jpg');
      assert.equal(encodeJpegArgs[encodeJpegArgs.indexOf('-q:v') + 1], '2');

      const decodeJpegArgs = buildDecodeJpegArgs('/config/cache/last_cam.jpg');
      assert.match(decodeJpegArgs[decodeJpegArgs.indexOf('-vf') + 1], /flags=lanczos/);
      assert.match(buildScaleFilter(true), /flags=lanczos/);
      assert.match(buildScaleFilter(false), /flags=lanczos/);
    }
  );
});
