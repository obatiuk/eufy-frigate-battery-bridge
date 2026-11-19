// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Bounded FIFO of decoded PCM audio that feeds the persistent encoder one fixed-size chunk per tick.
 */
'use strict';

/**
 * Queues decoded PCM chunks and serves exact-size chunks in O(1) without concatenating, reusing one output buffer
 * when a tick spans several chunks so steady-state ticks never allocate.
 */
class AudioQueue {
  /**
   * @param {number} initialOutBytes - Initial size of the reusable multi-chunk output buffer (one tick of audio).
   */
  constructor(initialOutBytes) {
    /** @type {Uint8Array[]} Queued PCM chunks, oldest first. */
    this.chunks = [];
    /** Total queued bytes across all chunks. */
    this.bytes = 0;
    /** @type {Buffer} Reusable output buffer for ticks that span several chunks. */
    this.outBuf = Buffer.allocUnsafe(initialOutBytes);
  }

  /**
   * Appends a PCM chunk and drops the oldest chunks while the queue exceeds byteCapacity, always keeping the newest.
   *
   * @param {Uint8Array} chunk - Decoded s16le PCM chunk.
   * @param {number} byteCapacity - Maximum queued bytes.
   */
  push(chunk, byteCapacity) {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.chunks.length > 1 && this.bytes > byteCapacity) {
      const oldest = this.chunks.shift();
      if (oldest) {
        this.bytes -= oldest.length;
      }
    }
  }

  /**
   * Consumes the next chunkBytes of audio, or returns silenceBuf when muted or too little audio is queued.
   *
   * @param {number} chunkBytes - Number of bytes per audio tick.
   * @param {Uint8Array} silenceBuf - Pre-allocated silence buffer.
   * @param {boolean} muted - True to return silence without consuming (for example before the first backfill frame).
   * @returns {Uint8Array}
   */
  consume(chunkBytes, silenceBuf, muted) {
    if (muted || this.bytes < chunkBytes) {
      return silenceBuf;
    }
    const first = this.chunks[0];
    if (first.length >= chunkBytes) {
      let out = first;
      if (first.length === chunkBytes) {
        this.chunks.shift();
      } else {
        out = first.subarray(0, chunkBytes);
        this.chunks[0] = first.subarray(chunkBytes);
      }
      this.bytes -= chunkBytes;
      return out;
    }

    if (this.outBuf.length < chunkBytes) {
      this.outBuf = Buffer.allocUnsafe(chunkBytes);
    }
    const out = this.outBuf.subarray(0, chunkBytes);
    let copied = 0;
    while (copied < chunkBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const need = chunkBytes - copied;
      if (head.length <= need) {
        out.set(head, copied);
        copied += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), copied);
        this.chunks[0] = head.subarray(need);
        copied += need;
      }
    }
    this.bytes -= copied;
    return out;
  }

  /**
   * Returns the total bytes of decoded PCM audio currently buffered in the queue.
   *
   * @returns {number}
   */
  getBufferedBytes() {
    return this.bytes;
  }

  /**
   * Drops all queued audio.
   */
  clear() {
    this.chunks = [];
    this.bytes = 0;
  }
}

module.exports = {AudioQueue};
