/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Shared fake FFmpeg child-process helpers for media and snapshot-cache tests.
 */
'use strict';

const EventEmitter = require('node:events');

/**
 * Creates a fake FFmpeg child process driven manually by the test (stdin chunks are kept by reference).
 *
 * @returns {*} EventEmitter child with stdout, stderr, stdin, and stdinChunks.
 */
function createFakeFfmpegProcess() {
  const proc = /** @type {*} */ (new EventEmitter());
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdinChunks = [];
  proc.stdin = Object.assign(new EventEmitter(), {
    /**
     * @param {Buffer} [chunk] - Optional trailing payload written on close.
     */
    end(chunk) {
      if (chunk) {
        proc.stdinChunks.push(chunk);
      }
    },
  });
  proc.kill = () => true;
  return proc;
}

/**
 * Settles a fake FFmpeg child process with optional stdout and stderr output, then emits close.
 *
 * @param {*} proc - Fake process from createFakeFfmpegProcess().
 * @param {{status: number, stdout?: Buffer, stderr?: Buffer}} outcome - Exit status and captured output.
 */
function finishFakeFfmpegProcess(proc, outcome) {
  if (outcome.stdout) {
    proc.stdout.emit('data', outcome.stdout);
  }
  if (outcome.stderr) {
    proc.stderr.emit('data', outcome.stderr);
  }
  proc.emit('close', outcome.status, null);
}

module.exports = {
  createFakeFfmpegProcess,
  finishFakeFfmpegProcess,
};
