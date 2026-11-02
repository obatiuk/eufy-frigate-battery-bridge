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
 * Decodes a JPEG file into a raw WxH YUV420p frame Buffer.
 *
 * @param {string} filePath - Filesystem path to a JPEG image.
 * @returns {Uint8Array|null} Decoded YUV420p Buffer of length FRAME, or null if decoding fails.
 */
function decodeJpegToYuv(filePath) {
  const r = spawnSync(
      'ffmpeg',
      [
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
      ],
      {maxBuffer: FRAME * 2}
  );
  return r.status === 0 && Buffer.isBuffer(r.stdout) && r.stdout.length === FRAME ? r.stdout : null;
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
    if (fs.existsSync(file)) {
      const decoded = decodeJpegToYuv(file);
      if (decoded) {
        let lastSeen = '';
        try {
          const st = fs.statSync(file);
          lastSeen = formatLocalHm(new Date(st.mtimeMs));
        } catch (err) {
          // Ignore stat errors on cached snapshot.
        }
        log.debug(cam, 'loaded cached snapshot from ' + file + (lastSeen ? ' (lastSeen=' + lastSeen + ')' : ''));
        return {frame: decoded, lastSeen};
      }
      log.warn(cam, 'failed to decode cached snapshot at ' + file);
    }
  }
  return {frame: null, lastSeen: ''};
}

/**
 * Saves the camera's latest verified raw YUV420p live frame to CACHE_DIR as a JPEG snapshot.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function saveCachedFrame(cam) {
  if (!Buffer.isBuffer(cam.lastFrame) || cam.lastFrame.length !== FRAME) return;
  const targetFile = getCacheFilePath(cam);
  try {
    const r = spawnSync(
        'ffmpeg',
        [
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
        ],
        {input: cam.lastFrame}
    );
    if (r.status === 0) {
      log.debug(cam, 'saved cached snapshot to ' + targetFile);
    } else {
      log.warn(
          cam,
          'failed to save cached snapshot: ' + String(r.stderr || '').trim().split('\n').pop()
      );
    }
  } catch (err) {
    log.warn(cam, 'error saving cached snapshot: ' + err.message);
  }
}

module.exports = {
  decodeJpegToYuv,
  getCacheFilePath,
  loadCachedFrame,
  saveCachedFrame,
};
