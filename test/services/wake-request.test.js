/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for wake request parsing and dispatch (src/services/wake-request.js): target selection, JSON body
 * reading, parameter validation, and per-camera dispatch for GET/POST /api/wake/:cameras.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

require('../helpers/test-env');

const {
  parseWakeParams,
  readJsonBody,
  resolveTargetSelection,
  normalizeLookupKey,
  dispatchWakeTargets,
  isWakeSuccessResult,
  canServeWakeRequest,
} = require('../../src/services/wake-request');
const wakeRequestModule = require('../../src/services/wake-request');
const httpServer = require('../../src/services/http-server');
const {Camera} = require('../../src/domain/camera');

const BASE_URL = 'http://127.0.0.1:8080';

/**
 * Parses wake params from a JSON body object and a query string.
 *
 * @param {Record<string, *>} body - Parsed JSON body.
 * @param {string} [query=''] - Query string without the question mark.
 * @returns {*}
 */
function parse(body, query = '') {
  return parseWakeParams(body, new URL(BASE_URL + '/api/wake/all' + (query ? '?' + query : '')));
}

/**
 * Builds a minimal request that emits the given body chunks, then ends (or errors).
 *
 * @param {Array<string|Buffer>} chunks - Body chunks.
 * @param {boolean} [fail=false] - Emit an error instead of end.
 * @returns {Promise<*>}
 */
function readBody(chunks, fail = false) {
  const req = new EventEmitter();
  const pending = readJsonBody(req);
  for (const chunk of chunks) {
    req.emit('data', chunk);
  }
  req.emit(fail ? 'error' : 'end', new Error('socket hang up'));
  return pending;
}

/**
 * Builds a fake camera that matches one slug.
 *
 * @param {string} name - Camera name and slug.
 * @returns {{name: string, matchesTargetToken: Function}}
 */
function fakeCam(name) {
  return {name, matchesTargetToken: (lower, slug) => slug === name};
}

describe('parseWakeParams', () => {
  it('defaults to no duration, event creation on, and the external api wake reason', () => {
    // Verify: defaults to no duration, event creation on, and the external api wake reason.
    assert.deepEqual(parse({}), {
      ok: true,
      params: {rawDuration: null, reason: 'external api wake', createEvent: true},
    });
  });

  it('reads duration, create_event, and reason from the body before the query string', () => {
    // Verify: reads duration, create_event, and reason from the body before the query string.
    const fromBody = parse({duration: 30, create_event: false, reason: ' doorbell '}, 'duration=45&reason=query');
    assert.deepEqual(fromBody, {ok: true, params: {rawDuration: 30, reason: 'doorbell', createEvent: false}});
    const fromQuery = parse({}, 'duration=45&create_event=TRUE&reason=garage%20door');
    assert.deepEqual(fromQuery, {ok: true, params: {rawDuration: '45', reason: 'garage door', createEvent: true}});
  });

  it('rejects a duration that is not a positive number of seconds', () => {
    // Verify: rejects a duration that is not a positive number of seconds.
    for (const bad of [-1, 0, true, {}, '', '  ', 'abc']) {
      assert.deepEqual(parse({duration: bad}), {ok: false, error: 'duration must be a positive number of seconds'});
    }
  });

  it('rejects a create_event that is not a boolean or a true/false string', () => {
    // Verify: rejects a create_event that is not a boolean or a true/false string.
    assert.deepEqual(parse({create_event: 'maybe'}), {ok: false, error: 'create_event must be a boolean'});
    assert.deepEqual(parse({create_event: 1}), {ok: false, error: 'create_event must be a boolean'});
    assert.equal(parse({create_event: ' False '}).params.createEvent, false);
  });

  it('rejects a reason that is not a string and falls back to the default for a blank one', () => {
    // Verify: rejects a reason that is not a string and falls back to the default for a blank one.
    assert.deepEqual(parse({reason: 5}), {ok: false, error: 'reason must be a string'});
    assert.equal(parse({reason: '   '}).params.reason, 'external api wake');
  });
});

describe('resolveTargetSelection', () => {
  const cams = [fakeCam('garage'), fakeCam('porch')];

  it('selects every camera for "all", matches by slug, and de-duplicates', () => {
    // Verify: selects every camera for "all", matches by slug, and de-duplicates.
    assert.deepEqual(resolveTargetSelection('all', cams).targets, cams);
    assert.deepEqual(resolveTargetSelection('garage,garage', cams).targets, [cams[0]]);
  });

  it('reports unknown tokens next to the matched cameras', () => {
    // Verify: reports unknown tokens next to the matched cameras.
    assert.deepEqual(resolveTargetSelection('garage,missing', cams), {
      invalidEncoding: false,
      targets: [cams[0]],
      unknown: ['missing'],
    });
  });

  it('flags malformed percent encoding and treats an empty spec as no targets', () => {
    // Verify: flags malformed percent encoding and treats an empty spec as no targets.
    assert.deepEqual(resolveTargetSelection('%', cams), {invalidEncoding: true, targets: [], unknown: []});
    assert.deepEqual(resolveTargetSelection('', cams), {invalidEncoding: false, targets: [], unknown: []});
  });

  it('normalizes lookup keys to lowercase slugs', () => {
    // Verify: normalizes lookup keys to lowercase slugs.
    assert.equal(normalizeLookupKey('  Front Door #1 '), 'front_door_1');
    assert.equal(normalizeLookupKey(null), '');
  });
});

describe('readJsonBody', () => {
  it('treats an empty body as an empty object and parses a JSON object', async () => {
    // Verify: treats an empty body as an empty object and parses a JSON object.
    assert.deepEqual(await readBody([]), {ok: true, body: {}});
    assert.deepEqual(await readBody(['{"duration":', '30}']), {ok: true, body: {duration: 30}});
  });

  it('rejects invalid JSON and non-object JSON with 400', async () => {
    // Verify: rejects invalid JSON and non-object JSON with 400.
    const invalid = await readBody(['{nope']);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.errorCode, 'INVALID_REQUEST');
    assert.equal(invalid.error, 'Invalid JSON request body');
    const array = await readBody(['[1]']);
    assert.equal(array.statusCode, 400);
    assert.equal(array.error, 'JSON request body must be an object');
  });

  it('rejects a body over 16384 bytes with 413 and reports a read error with 400', async () => {
    // Verify: rejects a body over 16384 bytes with 413 and reports a read error with 400.
    const tooLarge = await readBody([Buffer.alloc(16385, 0x61)]);
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.errorCode, 'PAYLOAD_TOO_LARGE');
    const failed = await readBody([], true);
    assert.equal(failed.statusCode, 400);
    assert.equal(failed.error, 'Failed to read request body');
  });
});

describe('dispatchWakeTargets and result classification', () => {
  it('marks direct rtsp_url cameras unsupported and Eufy cameras unavailable while eufy-security-ws is down', () => {
    // Verify: marks direct rtsp_url cameras unsupported and Eufy cameras unavailable while eufy-security-ws is down.
    const direct = new Camera({serial: 'SN0000000201', name: 'direct_cam', rtsp_url: 'rtsp://127.0.0.1:8554/direct'});
    const eufy = new Camera({serial: 'SN0000000202', name: 'eufy_cam', mode: 'p2p'});
    const results = dispatchWakeTargets([eufy, direct], {
      rawDuration: null,
      reason: 'test',
      createEvent: true,
      wakeCameraExternal: () => assert.fail('must not wake while eufy-security-ws is down'),
    });
    const byCamera = Object.fromEntries(results.map((r) => [r.camera, r.status]));
    assert.deepEqual(byCamera, {direct_cam: 'unsupported', eufy_cam: 'unavailable'});
    assert.equal(
      isWakeSuccessResult({status: 'unsupported'}) ||
        isWakeSuccessResult({status: 'offline'}) ||
        isWakeSuccessResult({status: 'unavailable'}),
      false
    );
    assert.equal(isWakeSuccessResult({status: 'waking'}), true);
    assert.equal(isWakeSuccessResult({status: 'scheduled'}), true);
  });

  it('serves a wake request only when eufy-security-ws is connected and a target can be woken', () => {
    // Verify: serves a wake request only when eufy-security-ws is connected and a target can be woken.
    const direct = new Camera({serial: 'SN0000000203', name: 'direct_only', rtsp_url: 'rtsp://127.0.0.1:8554/direct'});
    const eufy = new Camera({serial: 'SN0000000204', name: 'eufy_only', mode: 'p2p'});
    assert.equal(canServeWakeRequest([eufy], true), true);
    assert.equal(canServeWakeRequest([eufy], false), false);
    assert.equal(canServeWakeRequest([direct], true), false);
  });
});

describe('http-server.js re-exports', () => {
  it('keeps exporting the target helpers that existing imports use, unchanged', () => {
    // Verify: locked tests import these names from http-server.js, so it must re-export the moved functions.
    for (const name of [
      'normalizeLookupKey',
      'resolveTargetSelection',
      'resolveTargetCameras',
      'canServeWakeRequest',
    ]) {
      assert.equal(typeof wakeRequestModule[name], 'function', name + ' must be exported by wake-request.js');
      assert.equal(
        httpServer[name],
        wakeRequestModule[name],
        name + ' must be re-exported unchanged by http-server.js'
      );
    }
  });
});
