/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 31. Credential Redaction With '@' Passwords, Newline Escaping & Strict Port
 * Validation (docs/regression/31-secret-redaction-log-escaping-and-port-validation.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {resolveServiceEndpoints, BridgeConfigBuilder, clampNum, validateConfig} = require('../../src/config');
const {maskSecrets, formatLogLine} = require('../../src/logger');
const {Camera} = require('../../src/domain/camera');
const {FfmpegArgsBuilder} = require('../../src/media/ffmpeg-args');

installDefaultFetchStub();

describe("Regression 31. Credential Redaction With '@' Passwords, Newline Escaping & Strict Port Validation", () => {
  it('Regression 31: masks RTSP URL credentials even when the password contains @ characters', () => {
    // Regression 31: masks RTSP URL credentials even when the password contains @ characters.
    const cam = new Camera({serial: 'T8161T6666666667', name: 'masked_rtsp_cam'});
    cam.setRtspUrl('rtsp://admin:p@ss:123@192.168.1.50:554/live0');
    assert.equal(cam.getMaskedRtspUrl(), 'rtsp://***@192.168.1.50:554/live0');
  });

  it(
    'Regression 31: rejects non-integer or out-of-range port environment variables, bad endpoint schemes, ' +
      'and invalid YAML option value types',
    () => {
      // Regression 31: rejects non-integer or out-of-range port environment variables, bad endpoint schemes, and
      // invalid YAML option value types.
      const invalidServiceCases = [
        {EUFY_WS_PORT: '3000abc'},
        {FRIGATE_PORT: '5000.5'},
        {GO2RTC_API_PORT: '0'},
        {GO2RTC_RTSP_PORT: '65536'},
        {EUFY_WS_PORT: '-1'},
      ];
      for (const envCase of invalidServiceCases) {
        assert.throws(() => resolveServiceEndpoints(envCase), /must be an integer/);
      }

      const baseRaw = {cameras: [{serial: 'T8161T0000000000', mode: 'rtsp'}]};
      assert.equal(new BridgeConfigBuilder(baseRaw, {BRIDGE_HTTP_PORT: '0'}).withEndpoints().build().http_port, 0);
      for (const badHttpPort of ['8080abc', '80.5', '-1', '65536', '1e3']) {
        assert.throws(
          () => new BridgeConfigBuilder(baseRaw, {BRIDGE_HTTP_PORT: badHttpPort}).withEndpoints(),
          /BRIDGE_HTTP_PORT must be an integer/
        );
      }

      assert.equal(clampNum('', 5, 60, 15), 15);
      assert.equal(clampNum('   ', 5, 60, 15), 15);
      assert.equal(clampNum([], 5, 60, 15), 15);
      assert.equal(clampNum(true, 5, 60, 15), 15);
      assert.equal(clampNum(Infinity, 5, 60, 15), 15);

      // Direct unit checks for invalid YAML value types, non-integers, duplicates, unsafe names, and URLs
      for (const badYamlCfg of [
        {cameras: [{serial: 'SN0000000001'}, {serial: 'SN0000000001', name: 'cam_two'}]},
        {cameras: [{serial: 'SN0000000001', name: '../escape'}]},
        {cameras: [{serial: 'SN0000000001', name: 'bad/name'}]},
        {cameras: [{name: 'rtsp_no_host', rtsp_url: 'rtsp://   '}]},
        {hold_secs: 'sixty', cameras: [{serial: 'SN0000000001'}]},
        {live_fps: 15.5, cameras: [{serial: 'SN0000000001'}]},
        {cameras: [{serial: 'SN0000000001', priority: 1.5}]},
        {audio: 'yes', cameras: [{serial: 'SN0000000001'}]},
        {startup_snapshot: 'sometimes', cameras: [{serial: 'SN0000000001'}]},
        {enforce_streaming_quality: 99, cameras: [{serial: 'SN0000000001'}]},
        {telemetry: 'invalid', cameras: [{serial: 'SN0000000001'}]},
        {telemetry: {unknown_toggle: true}, cameras: [{serial: 'SN0000000001'}]},
        {trigger_events: [], cameras: [{serial: 'SN0000000001'}]},
        {event_priorities: {ring: 'high'}, cameras: [{serial: 'SN0000000001'}]},
        {ring_label: '', cameras: [{serial: 'SN0000000001'}]},
      ]) {
        assert.throws(() => validateConfig(badYamlCfg), /config\.yaml:/);
      }

      for (const badEndpointEnv of [
        {EUFY_WS_URL: 'http://wrong:3000'},
        {EUFY_WS_URL: 'ws://'},
        {FRIGATE_URL: 'ws://wrong:5000'},
        {GO2RTC_URL: 'rtsp://wrong:1984'},
        {GO2RTC_RTSP_URL: 'http://wrong:8554'},
        {HA_WEBHOOK_URL: 'ftp://wrong:8123/hook'},
      ]) {
        assert.throws(() => resolveServiceEndpoints(badEndpointEnv));
      }
    }
  );

  it('Regression 31: masks URL credentials with @ passwords and escapes CR/LF newlines in formatted log lines', () => {
    // Regression 31: masks URL credentials with @ passwords and escapes CR/LF newlines in formatted log lines.
    assert.equal(maskSecrets('rtsp://user:p@ss@host:554/live0'), 'rtsp://***@host:554/live0');
    assert.equal(
      maskSecrets('in rtsp://a:b@cam1/1 out rtsps://c:p@2@go2rtc:8555/2'),
      'in rtsp://***@cam1/1 out rtsps://***@go2rtc:8555/2'
    );
    assert.equal(
      maskSecrets('http://example.com/users/alice@example.com'),
      'http://example.com/users/alice@example.com',
      'Email addresses after URL path slash must not be redacted'
    );

    const fixedDate = new Date(2026, 10, 5, 8, 4, 9);
    const line = formatLogLine(
      'warn',
      {name: 'cam\nspoof'},
      ['opening rtsp://admin:s3cr@t@192.168.1.50:554/live0\r\nFAKE [ERROR]'],
      fixedDate
    );
    assert.equal(line.includes('s3cr@t'), false);
    assert.equal(line.includes('rtsp://***@192.168.1.50:554/live0'), true);
    assert.equal(line.includes('\r'), false);
    assert.equal(line.includes('\n'), false);
    assert.equal(
      line,
      '2026-11-05 08:04:09 - [WARN ] - [cam\\nspoof] opening rtsp://***@192.168.1.50:554/live0\\r\\nFAKE [ERROR]'
    );
  });

  it('Regression 31: redacts URL credentials in FFmpeg stderr tail summaries for decoder and encoder logs', () => {
    // Regression 31: redacts URL credentials in FFmpeg stderr tail summaries for decoder and encoder logs.
    const EventEmitter = require('node:events');
    const mockProc = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    const collector = FfmpegArgsBuilder.attachStderrTailCollector(mockProc);
    mockProc.stderr.emit('data', Buffer.from('Opening rtsp://admin:s3cr@t@192.168.1.50:554/live0\r\n'));
    mockProc.stderr.emit('data', Buffer.from('Connection refused from rtsp://u:pw@10.0.0.5:8554/cam'));

    const summary = collector.getSummary();
    const lastLine = collector.getLastLine();
    assert.equal(summary.includes('s3cr@t'), false);
    assert.equal(summary.includes('pw@10'), false);
    assert.equal(summary.includes('rtsp://***@192.168.1.50:554/live0'), true);
    assert.equal(summary.includes('rtsp://***@10.0.0.5:8554/cam'), true);
    assert.equal(lastLine, 'Connection refused from rtsp://***@10.0.0.5:8554/cam');
  });
});
