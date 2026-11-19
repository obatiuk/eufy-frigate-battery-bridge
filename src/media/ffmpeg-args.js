// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Fluent FFmpeg CLI argument builder and stderr tail collector shared by the encoder and decoder modules.
 */
'use strict';

const {STDERR_TAIL_MAX_CHARS} = require('../config');
const {extractFfmpegStderrLines} = require('../logger');

const FFMPEG_SINGLE_FILTER_THREAD = '1';
const DEC_PCM_PTS_FILTER = 'asetpts=N/(SR*10)/TB';

/**
 * Fluent builder for constructing immutable FFmpeg CLI argument arrays across the encoder and decoder modules.
 */
class FfmpegArgsBuilder {
  constructor() {
    /** @type {string[]} */
    this._args = [];
  }

  /**
   * Prepends -hide_banner and -loglevel <level>.
   *
   * @param {string} [logLevel='error'] - FFmpeg log level.
   * @returns {this}
   */
  hideBanner(logLevel = 'error') {
    return this.flag('-hide_banner').option('-loglevel', String(logLevel));
  }

  /**
   * Caps FFmpeg simple and complex filtergraph worker pools to a single thread so multi-core hosts
   * do not spawn dozens of idle filter threads per persistent camera process.
   *
   * @returns {this}
   */
  withSingleFilterThreads() {
    this._args.push(
      '-filter_threads',
      FFMPEG_SINGLE_FILTER_THREAD,
      '-filter_complex_threads',
      FFMPEG_SINGLE_FILTER_THREAD
    );
    return this;
  }

  /**
   * Appends low-latency stream demuxing flags (-fflags +genpts -flags low_delay).
   * Avoids +nobuffer so avformat_find_stream_info retains initial probed keyframe packets (Frame 0).
   *
   * @returns {this}
   */
  withLowLatencyFlags() {
    this._args.push('-fflags', '+genpts', '-flags', 'low_delay');
    return this;
  }

  /**
   * Appends raw YUV420p stdout video output flags (-pix_fmt yuv420p -fps_mode passthrough -f rawvideo pipe:1).
   *
   * @returns {this}
   */
  withRawYuvOutput() {
    this._args.push('-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1');
    return this;
  }

  /**
   * Appends s16le mono PCM audio output pipe arguments when audio is enabled.
   * Uses asetpts=N/(SR*10)/TB so s16le output receives strictly monotonic sample-counted
   * timestamps without aresample=async=1 dropping burst-transferred backfill samples and
   * without FFmpeg's muxer scheduler stalling pipe:3 -> pipe:4 audio when pipe:1 rawvideo
   * is paused at the backpressure high watermark.
   *
   * @param {boolean} enabled - Whether audio output is enabled.
   * @param {string} mapSpec - Input audio stream map specifier ('1:a' or '0:a:0?').
   * @param {number} sampleRate - Output sample rate in Hz.
   * @returns {this}
   */
  withS16leAudioOutput(enabled, mapSpec, sampleRate) {
    if (enabled) {
      this._args.push(
        '-map',
        mapSpec,
        '-af',
        DEC_PCM_PTS_FILTER,
        '-ar',
        String(sampleRate),
        '-ac',
        '1',
        '-f',
        's16le',
        'pipe:4'
      );
    }
    return this;
  }

  /**
   * Appends a single CLI flag without value (e.g. '-an' or '-y').
   *
   * @param {string} flagName - CLI flag.
   * @returns {this}
   */
  flag(flagName) {
    this._args.push(String(flagName));
    return this;
  }

  /**
   * Appends a CLI key-value option pair.
   *
   * @param {string} key - Option flag (e.g. '-f').
   * @param {string|number} value - Option value.
   * @returns {this}
   */
  option(key, value) {
    this._args.push(String(key), String(value));
    return this;
  }

  /**
   * Appends one or more raw CLI tokens.
   *
   * @param {...(string|number)} items - Tokens to append.
   * @returns {this}
   */
  append(...items) {
    for (const item of items) {
      this._args.push(String(item));
    }
    return this;
  }

  /**
   * Appends the final output target URI or pipe specifier.
   *
   * @param {string} target - Output path, URL, or pipe.
   * @returns {this}
   */
  output(target) {
    this._args.push(String(target));
    return this;
  }

  /**
   * Returns a frozen copy of the constructed FFmpeg CLI argument array.
   *
   * @returns {ReadonlyArray<string>}
   */
  build() {
    return Object.freeze([...this._args]);
  }

  /**
   * Attaches a bounded rolling stderr tail listener to an FFmpeg child process.
   *
   * @param {import("child_process").ChildProcess} proc - Spawned FFmpeg child process.
   * @param {number} [maxChars=STDERR_TAIL_MAX_CHARS] - Maximum tail buffer characters.
   * @returns {{ getRaw: () => string, getSummary: () => string, getLastLine: () => string }}
   */
  static attachStderrTailCollector(proc, maxChars = STDERR_TAIL_MAX_CHARS) {
    let stderrWindow = '';
    if (proc && proc.stderr) {
      proc.stderr.on('data', (stderrChunk) => {
        const combined = stderrWindow + String(stderrChunk);
        stderrWindow = combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
      });
    }
    return Object.freeze({
      getRaw: () => stderrWindow,
      getSummary: () => extractFfmpegStderrLines(stderrWindow).join(' | '),
      getLastLine: () => extractFfmpegStderrLines(stderrWindow).pop() || 'no stderr output',
    });
  }
}

module.exports = {FfmpegArgsBuilder};
