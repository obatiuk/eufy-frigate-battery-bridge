// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Persistent camera snapshot JPEG <-> YUV420p disk cache (/config/cache).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {W, H, FRAME, CACHE_DIR} = require('../config');
const {log, formatLocalHm} = require('../logger');

/**
 * Builds the FFmpeg CLI arguments to decode a JPEG file into a scaled raw YUV420p frame.
 *
 * @param {string} filePath - Source JPEG path.
 * @returns {string[]}
 */
function buildDecodeJpegArgs(filePath) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
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
  ];
}

/**
 * Builds the FFmpeg CLI arguments to encode a raw YUV420p buffer to a high-quality JPEG file.
 *
 * @param {string} targetFile - Destination JPEG path.
 * @returns {string[]}
 */
function buildEncodeJpegArgs(targetFile) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    '-s',
    W + 'x' + H,
    '-i',
    'pipe:0',
    '-frames:v',
    '1',
    '-q:v',
    '2',
    targetFile,
  ];
}

/**
 * Decodes a JPEG file into a raw WxH YUV420p frame Buffer.
 *
 * @param {string} filePath - Filesystem path to a JPEG image.
 * @returns {Uint8Array|null} Decoded YUV420p Buffer of length FRAME, or null if decoding fails.
 */
function decodeJpegToYuv(filePath) {
  const r = spawnSync('ffmpeg', buildDecodeJpegArgs(filePath), {maxBuffer: FRAME * 2});
  if (r.status === 0 && Buffer.isBuffer(r.stdout) && r.stdout.length === FRAME) {
    return r.stdout;
  }
  return null;
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
 * Returns the unique cache file path in CACHE_DIR for a specific camera's last verified live frame,
 * keyed by both camera name and hardware serial number so frames can never collide across cameras.
 *
 * @param {Record<string, *>} cam - Camera configuration or state object.
 * @returns {string} Filesystem path in CACHE_DIR.
 */
const getCacheFilePath = (cam) => path.join(CACHE_DIR, 'last_' + cam.name + '_' + cam.serial + '.jpg');

/**
 * Loads the last cached live frame for a camera from CACHE_DIR (or legacy /tmp) if one was saved
 * prior to a container restart.
 *
 * @param {Record<string, *>} cam - Camera configuration object.
 * @returns {{ frame: Uint8Array|null, lastSeen: string }} YUV420p frame buffer and formatted mtime.
 */
function loadCachedFrame(cam) {
  const candidates = [getCacheFilePath(cam), '/tmp/last_' + cam.name + '_' + cam.serial + '.jpg'];
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const decoded = decodeJpegToYuv(file);
    if (decoded) {
      const lastSeen = readFileLastSeenHm(file);
      const seenSuffix = lastSeen ? ' (lastSeen=' + lastSeen + ')' : '';
      log.debug(cam, 'loaded cached snapshot from ' + file + seenSuffix);
      return {frame: decoded, lastSeen};
    }
    log.warn(cam, 'failed to decode cached snapshot at ' + file);
  }
  return {frame: null, lastSeen: ''};
}

/**
 * Saves the camera's latest verified raw YUV420p live frame to CACHE_DIR as a JPEG snapshot.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function saveCachedFrame(cam) {
  if (!Buffer.isBuffer(cam.lastFrame) || cam.lastFrame.length !== FRAME) {
    return;
  }
  const targetFile = getCacheFilePath(cam);
  try {
    const r = spawnSync('ffmpeg', buildEncodeJpegArgs(targetFile), {input: cam.lastFrame});
    if (r.status === 0) {
      log.debug(cam, 'saved cached snapshot to ' + targetFile);
    } else {
      const lastErr = String(r.stderr || '').trim().split('\n').pop();
      log.warn(cam, 'failed to save cached snapshot: ' + lastErr);
    }
  } catch (err) {
    log.warn(cam, 'error saving cached snapshot: ' + err.message);
  }
}

module.exports = {
  buildDecodeJpegArgs,
  buildEncodeJpegArgs,
  decodeJpegToYuv,
  readFileLastSeenHm,
  getCacheFilePath,
  loadCachedFrame,
  saveCachedFrame,
};
