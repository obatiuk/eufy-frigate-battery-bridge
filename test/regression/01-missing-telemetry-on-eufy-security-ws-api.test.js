/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 1. Missing Telemetry on `eufy-security-ws` API Schema 13-21
 * (docs/regression/01-missing-telemetry-on-eufy-security-ws-api.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {flushAsync} = require('../helpers/async');
const {installDefaultFetchStub} = require('../helpers/service-mocks');
const {Camera} = require('../../src/domain/camera');
const {configureEufyClientHooks, connectWs} = require('../../src/services/eufy-client');

installDefaultFetchStub();

describe('Regression 1. Missing Telemetry on `eufy-security-ws` API Schema 13-21', () => {
  it(
    'Regression 1: fetches telemetry via device.get_properties when start_listening returns schema 13-21 ' +
      'serial string arrays',
    async () => {
      // Regression: in API schema 13+, start_listening returns result.state.devices as string serials rather than
      // device objects, so fetchAllCameraTelemetry must explicitly query device.get_properties per camera.
      const cam = new Camera({serial: 'T8161T0000010001', name: 'schema21_cam', mode: 'rtsp'});
      const cams = [cam];
      const bySerial = new Map([[cam.getSerial(), cam]]);
      const sentCommands = [];
      let wsInstance = null;

      class Schema21Ws {
        constructor() {
          this.readyState = 1;
          this.handlers = new Map();
        }
        on(ev, fn) {
          this.handlers.set(ev, fn);
        }
        send(raw, cb) {
          const msg = JSON.parse(raw);
          sentCommands.push(msg.command);
          if (cb) cb();
          const onMsg = this.handlers.get('message');
          if (!onMsg) return;
          queueMicrotask(() => {
            if (msg.command === 'start_listening') {
              onMsg(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {state: {devices: ['T8161T0000010001'], stations: ['T8030P0000010000']}},
                })
              );
            } else if (msg.command === 'device.get_properties') {
              onMsg(
                JSON.stringify({
                  type: 'result',
                  messageId: msg.messageId,
                  success: true,
                  result: {properties: {battery: {value: 87}, wifiRssi: -64, state: 1}},
                })
              );
            } else {
              onMsg(JSON.stringify({type: 'result', messageId: msg.messageId, success: true, result: {}}));
            }
          });
        }
      }

      configureEufyClientHooks({
        cams,
        bySerial,
        isShuttingDown: () => false,
        WebSocket: function MockSchema21Ws() {
          wsInstance = new Schema21Ws();
          return wsInstance;
        },
      });
      connectWs();
      configureEufyClientHooks({isShuttingDown: () => true});
      await wsInstance.handlers.get('message')(JSON.stringify({type: 'version', maxSchemaVersion: 21}));
      await flushAsync();

      assert.equal(sentCommands.includes('device.get_properties'), true);
      const summary = cam.toStatusSummary();
      assert.equal(summary.telemetry.battery_pct, 87);
      assert.equal(summary.telemetry.rssi_dbm, -64);
      if (wsInstance.handlers.get('close')) {
        wsInstance.handlers.get('close')();
      }
    }
  );
});
