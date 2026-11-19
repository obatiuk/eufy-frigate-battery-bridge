/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the AudioQueue domain model (src/domain/camera/audio-queue.js): the bounded FIFO of decoded PCM
 * audio that feeds the persistent encoder one fixed-size chunk per tick without per-tick allocations.
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../../helpers/test-env');

const {AudioQueue} = require('../../../src/domain/camera/audio-queue');

const SILENCE = Buffer.alloc(4);

describe('AudioQueue (src/domain/camera/audio-queue.js)', () => {
  it('hands back an exactly matching chunk without copying it', () => {
    // Verify: consuming exactly one queued chunk returns that same buffer (zero copy) and empties the queue.
    const queue = new AudioQueue(4);
    const chunk = Buffer.from([1, 2, 3, 4]);
    queue.push(chunk, 100);
    assert.equal(queue.bytes, 4);

    const out = queue.consume(4, SILENCE, false);
    assert.equal(out, chunk);
    assert.equal(queue.bytes, 0);
    assert.equal(queue.chunks.length, 0);
  });

  it('returns a view of a larger chunk and keeps the remainder queued', () => {
    // Verify: consuming part of the first chunk returns a view of it and leaves the rest for the next tick.
    const queue = new AudioQueue(4);
    queue.push(Buffer.from([1, 2, 3, 4, 5, 6]), 100);

    assert.deepEqual([...queue.consume(4, SILENCE, false)], [1, 2, 3, 4]);
    assert.equal(queue.bytes, 2);
    assert.deepEqual([...queue.chunks[0]], [5, 6]);
  });

  it('joins chunks into one reusable output buffer when a tick spans several chunks', () => {
    // Verify: audio spanning chunk boundaries is copied into a single reused buffer, so steady-state ticks never
    // allocate, and the unused tail of the last chunk stays queued.
    const queue = new AudioQueue(4);
    queue.push(Buffer.from([1, 2]), 100);
    queue.push(Buffer.from([3, 4]), 100);
    queue.push(Buffer.from([5, 6, 7]), 100);

    const first = queue.consume(4, SILENCE, false);
    assert.deepEqual([...first], [1, 2, 3, 4]);
    assert.equal(queue.bytes, 3);
    assert.deepEqual([...queue.chunks[0]], [5, 6, 7]);

    queue.push(Buffer.from([8]), 100);
    const second = queue.consume(4, SILENCE, false);
    assert.deepEqual([...second], [5, 6, 7, 8]);
    assert.equal(second.buffer, first.buffer, 'the same backing buffer is reused across ticks');
  });

  it('grows the output buffer only when a tick needs more bytes than it holds', () => {
    // Verify: the reusable output buffer is enlarged on demand.
    const queue = new AudioQueue(2);
    queue.push(Buffer.from([1, 2, 3]), 100);
    queue.push(Buffer.from([4, 5, 6]), 100);
    assert.deepEqual([...queue.consume(5, SILENCE, false)], [1, 2, 3, 4, 5]);
    assert.ok(queue.outBuf.length >= 5);
  });

  it('returns the silence buffer when too little audio is queued or output is muted', () => {
    // Verify: the encoder gets silence while audio is short or before the first backfill frame is decoded.
    const queue = new AudioQueue(4);
    queue.push(Buffer.from([1, 2, 3]), 100);
    assert.equal(queue.consume(4, SILENCE, false), SILENCE);
    assert.equal(queue.bytes, 3, 'nothing is consumed when audio is short');

    queue.push(Buffer.from([4, 5]), 100);
    assert.equal(queue.consume(4, SILENCE, true), SILENCE, 'muted output returns silence');
    assert.equal(queue.bytes, 5, 'nothing is consumed while muted');
  });

  it('drops the oldest chunks when the byte capacity is exceeded but always keeps the newest chunk', () => {
    // Verify: the queue is bounded; older audio is discarded first, and a single chunk larger than the capacity is
    // kept so a burst never leaves the queue empty.
    const queue = new AudioQueue(4);
    queue.push(Buffer.alloc(4, 1), 8);
    queue.push(Buffer.alloc(4, 2), 8);
    assert.equal(queue.bytes, 8);
    queue.push(Buffer.alloc(4, 3), 8);
    assert.equal(queue.bytes, 8);
    assert.deepEqual(
      queue.chunks.map((c) => c[0]),
      [2, 3]
    );

    queue.push(Buffer.alloc(20, 9), 8);
    assert.equal(queue.chunks.length, 1);
    assert.equal(queue.bytes, 20);
  });

  it('clears all queued audio', () => {
    // Verify: clear() empties the queue for a new session.
    const queue = new AudioQueue(4);
    queue.push(Buffer.alloc(4), 100);
    queue.clear();
    assert.equal(queue.bytes, 0);
    assert.deepEqual(queue.chunks, []);
  });
});
