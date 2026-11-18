// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Persistent camera snapshot JPEG <-> YUV420p disk cache (/config/cache).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {W, H, FRAME, CACHE_DIR, MAX_FFMPEG_BUFFER_MULTIPLIER, CameraConfig} = require('../config');
const {log, formatLocalHm, formatErrorMessage, extractFfmpegStderrLines} = require('../logger');

/** @typedef {import("../domain/camera").Camera} Camera */

const JPEG_ENCODER_QUALITY = '2';
const SNAPSHOT_FFMPEG_THREADS = '1';

/**
 * Builds the FFmpeg CLI arguments to decode a JPEG file into a scaled raw YUV420p frame.
 *
 * @param {string} filePath - Source JPEG path.
 * @returns {readonly string[]}
 */
function buildDecodeJpegArgs(filePath) {
  return Object.freeze([
    '-hide_banner',
    '-loglevel',
    'error',
    '-filter_threads',
    SNAPSHOT_FFMPEG_THREADS,
    '-threads',
    SNAPSHOT_FFMPEG_THREADS,
    '-i',
    filePath,
    '-vf',
    'scale=' + W + ':' + H + ':flags=lanczos',
    '-pix_fmt',
    'yuv420p',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
}

/**
 * Builds the FFmpeg CLI arguments to encode a raw YUV420p buffer to a high-quality JPEG file.
 *
 * @param {string} targetFile - Destination JPEG path.
 * @returns {readonly string[]}
 */
function buildEncodeJpegArgs(targetFile) {
  return Object.freeze([
    '-hide_banner',
    '-loglevel',
    'error',
    '-filter_threads',
    SNAPSHOT_FFMPEG_THREADS,
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    '-s',
    W + 'x' + H,
    '-i',
    'pipe:0',
    '-threads',
    SNAPSHOT_FFMPEG_THREADS,
    '-frames:v',
    '1',
    '-q:v',
    JPEG_ENCODER_QUALITY,
    targetFile,
  ]);
}

/**
 * Formats a concise diagnostic reason from a failed spawnSync('ffmpeg', ...) result.
 *
 * @param {import("node:child_process").SpawnSyncReturns<Buffer|string>} res - spawnSync result.
 * @returns {string}
 */
function formatSnapshotFfmpegFailure(res) {
  if (res.error) {
    return formatErrorMessage(res.error);
  }
  const lines = extractFfmpegStderrLines(res.stderr);
  if (lines.length > 0) {
    return lines.join(' | ');
  }
  if (res.signal) {
    return 'terminated by ' + res.signal;
  }
  return 'exit code ' + String(res.status ?? 'unknown');
}

/**
 * Decodes a JPEG file into a raw WxH YUV420p frame Buffer, returning the decoded frame or a
 * diagnostic error string when FFmpeg fails or produces a truncated buffer.
 *
 * @param {string} filePath - Filesystem path to a JPEG image.
 * @returns {{ frame: Uint8Array|null, error: string }}
 */
function tryDecodeJpegToYuv(filePath) {
  const r = childProcess.spawnSync('ffmpeg', buildDecodeJpegArgs(filePath), {
    maxBuffer: FRAME * MAX_FFMPEG_BUFFER_MULTIPLIER,
  });
  if (!r.error && r.status === 0 && Buffer.isBuffer(r.stdout) && r.stdout.length === FRAME) {
    return {frame: r.stdout, error: ''};
  }
  if (!r.error && r.status === 0) {
    const byteLen = Buffer.isBuffer(r.stdout) ? r.stdout.length : 0;
    return {frame: null, error: 'unexpected output size (' + byteLen + ' bytes, expected ' + FRAME + ')'};
  }
  return {frame: null, error: formatSnapshotFfmpegFailure(r)};
}

/**
 * Reads the file modification time of a cached snapshot as a local 'HH:MM' string.
 *
 * @param {string} filePath - Snapshot file path.
 * @returns {string}
 */
function readFileLastSeenHm(filePath) {
  try {
    const st = fs.statSync(filePath);
    return formatLocalHm(new Date(st.mtimeMs));
  } catch (err) {
    return '';
  }
}

/**
 * Returns the unique cache file path in CACHE_DIR for a specific camera's last verified live frame
 * (`last_<name>.jpg` when `serial === name`, or `last_<name>_<serial>.jpg` when they differ).
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string }} cam - Camera configuration or domain instance.
 * @returns {string} Filesystem path in CACHE_DIR.
 */
function getCacheFilePath(cam) {
  return path.join(CACHE_DIR, CameraConfig.resolveCacheFileName(cam));
}

/**
 * Migrates a legacy duplicated cache file (`last_<name>_<name>.jpg`) to `last_<name>.jpg`
 * in place when `serial === name`, or removes the stale duplicate if `last_<name>.jpg` already exists.
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string }} cam - Camera configuration or domain instance.
 * @param {string} [cacheDir=CACHE_DIR] - Snapshot cache directory.
 */
function migrateLegacyDuplicateCacheFile(cam, cacheDir = CACHE_DIR) {
  const legacyName = CameraConfig.resolveLegacyDuplicateCacheFileName(cam);
  if (!legacyName) {
    return;
  }
  const legacyPath = path.join(cacheDir, legacyName);
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  const primaryPath = path.join(cacheDir, CameraConfig.resolveCacheFileName(cam));
  try {
    if (fs.existsSync(primaryPath)) {
      fs.rmSync(legacyPath, {force: true});
    } else {
      fs.renameSync(legacyPath, primaryPath);
    }
  } catch (err) {
    // Ignore read-only or transient filesystem errors during cache cleanup.
  }
}

/**
 * Loads the last cached live frame for a camera from CACHE_DIR (or fallback temp directory) if one was saved
 * prior to a container restart.
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string }} cam - Camera configuration or domain instance.
 * @returns {{ frame: Uint8Array|null, lastSeen: string }} YUV420p frame buffer and formatted mtime.
 */
function loadCachedFrame(cam) {
  migrateLegacyDuplicateCacheFile(cam, CACHE_DIR);
  migrateLegacyDuplicateCacheFile(cam, os.tmpdir());
  const fileName = CameraConfig.resolveCacheFileName(cam);
  const candidates = [getCacheFilePath(cam), path.join(os.tmpdir(), fileName)];
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const {frame: decoded, error: decodeErr} = tryDecodeJpegToYuv(file);
    if (decoded) {
      const lastSeen = readFileLastSeenHm(file);
      const seenSuffix = lastSeen ? ' (lastSeen=' + lastSeen + ')' : '';
      log.debug(cam, 'loaded cached snapshot from ' + file + seenSuffix);
      return Object.freeze({frame: decoded, lastSeen});
    }
    log.warn(cam, 'failed to decode cached snapshot at ' + file + (decodeErr ? ': ' + decodeErr : ''));
  }
  return Object.freeze({frame: null, lastSeen: ''});
}

/**
 * Saves the camera's latest verified raw YUV420p live frame to CACHE_DIR as a JPEG snapshot.
 *
 * @param {Camera} cam - Camera domain instance.
 */
function saveCachedFrame(cam) {
  if (!cam.hasValidSnapshotFrame()) {
    return;
  }
  const targetFile = getCacheFilePath(cam);
  try {
    const r = childProcess.spawnSync('ffmpeg', buildEncodeJpegArgs(targetFile), {input: cam.getLastFrameBuffer()});
    if (!r.error && r.status === 0) {
      migrateLegacyDuplicateCacheFile(cam, CACHE_DIR);
      log.debug(cam, 'saved cached snapshot to ' + targetFile);
    } else {
      log.warn(cam, 'failed to save cached snapshot: ' + formatSnapshotFfmpegFailure(r));
    }
  } catch (err) {
    log.warn(cam, 'error saving cached snapshot: ' + formatErrorMessage(err));
  }
}

module.exports = {
  buildDecodeJpegArgs,
  buildEncodeJpegArgs,
  getCacheFilePath,
  migrateLegacyDuplicateCacheFile,
  loadCachedFrame,
  saveCachedFrame,
};
