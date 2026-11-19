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
const SNAPSHOT_FFMPEG_TIMEOUT_MS = 10000;
const SNAPSHOT_FFMPEG_KILL_SIGNAL = 'SIGKILL';
const SNAPSHOT_TEMP_SUFFIX = '.tmp.jpg';
const MAX_SNAPSHOT_STDERR_BYTES = 16384;
const ENCODE_MAX_STDOUT_BYTES = 0;

/** Cache files with an FFmpeg encode Promise in flight, preventing stacked saves and allowing shutdown drain. */
/** @type {Map<string, Promise<void>>} */
const pendingSaves = new Map();

const ignoreError = () => {};

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
 * @typedef {{
 *   status: number|null,
 *   signal: string|null,
 *   error: Error|undefined,
 *   stdout: Buffer,
 *   stderr: Buffer,
 * }} SnapshotFfmpegResult
 */

/**
 * Formats a concise diagnostic reason from a failed snapshot FFmpeg run.
 *
 * @param {SnapshotFfmpegResult} res - Settled FFmpeg result.
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
 * Runs FFmpeg asynchronously (never blocking the event loop) with a hard kill timeout, capturing bounded stdout and
 * stderr. Always resolves, reporting spawn failures and kills through the result instead of rejecting.
 *
 * @param {readonly string[]} args - FFmpeg CLI arguments.
 * @param {Buffer|undefined} input - Bytes piped to FFmpeg stdin, if any.
 * @param {number} maxStdoutBytes - Stdout size after which FFmpeg is killed.
 * @returns {Promise<SnapshotFfmpegResult>}
 */
function runSnapshotFfmpeg(args, input, maxStdoutBytes) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const settle = (status, signal, error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        status,
        signal,
        error,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    };

    let child;
    try {
      child = childProcess.spawn('ffmpeg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: SNAPSHOT_FFMPEG_TIMEOUT_MS,
        killSignal: SNAPSHOT_FFMPEG_KILL_SIGNAL,
      });
    } catch (err) {
      settle(null, null, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.on('error', (err) => settle(null, null, err));
    child.on('close', (code, signal) => settle(code, signal, undefined));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill(SNAPSHOT_FFMPEG_KILL_SIGNAL);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_SNAPSHOT_STDERR_BYTES) {
        stderrChunks.push(chunk);
      }
    });
    // FFmpeg may exit before consuming stdin (EPIPE); its exit status and stderr already report the cause.
    child.stdin.on('error', ignoreError);
    child.stdin.end(input);
  });
}

/**
 * Decodes a JPEG file into a raw WxH YUV420p frame Buffer, returning the decoded frame or a
 * diagnostic error string when FFmpeg fails, times out, or produces a truncated buffer.
 *
 * @param {string} filePath - Filesystem path to a JPEG image.
 * @returns {Promise<{ frame: Uint8Array|null, error: string }>}
 */
async function tryDecodeJpegToYuv(filePath) {
  const r = await runSnapshotFfmpeg(buildDecodeJpegArgs(filePath), undefined, FRAME * MAX_FFMPEG_BUFFER_MULTIPLIER);
  if (!r.error && r.status === 0 && r.stdout.length === FRAME) {
    return {frame: r.stdout, error: ''};
  }
  if (!r.error && r.status === 0) {
    return {frame: null, error: 'unexpected output size (' + r.stdout.length + ' bytes, expected ' + FRAME + ')'};
  }
  return {frame: null, error: formatSnapshotFfmpegFailure(r)};
}

/**
 * Reads the file modification time of a cached snapshot as a local 'HH:MM' string.
 *
 * @param {string} filePath - Snapshot file path.
 * @returns {Promise<string>}
 */
async function readFileLastSeenHm(filePath) {
  try {
    const st = await fs.promises.stat(filePath);
    return formatLocalHm(new Date(st.mtimeMs));
  } catch (err) {
    // Missing or unreadable snapshot cache file has no lastSeen timestamp yet.
    return '';
  }
}

/**
 * Returns true if a file exists at the path.
 *
 * @param {string} filePath - Filesystem path.
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (err) {
    // ENOENT / EACCES indicates the candidate cache path is not accessible.
    return false;
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
 * prior to a container restart. FFmpeg runs off the event loop so startup health probes keep answering.
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string }} cam - Camera configuration or domain instance.
 * @returns {Promise<{ frame: Uint8Array|null, lastSeen: string }>} YUV420p frame buffer and formatted mtime.
 */
async function loadCachedFrame(cam) {
  migrateLegacyDuplicateCacheFile(cam, CACHE_DIR);
  migrateLegacyDuplicateCacheFile(cam, os.tmpdir());
  const fileName = CameraConfig.resolveCacheFileName(cam);
  const candidates = [getCacheFilePath(cam), path.join(os.tmpdir(), fileName)];
  for (const file of candidates) {
    if (!(await fileExists(file))) {
      continue;
    }
    const {frame: decoded, error: decodeErr} = await tryDecodeJpegToYuv(file);
    if (decoded) {
      const lastSeen = await readFileLastSeenHm(file);
      const seenSuffix = lastSeen ? ' (lastSeen=' + lastSeen + ')' : '';
      log.debug(cam, 'loaded cached snapshot from ' + file + seenSuffix);
      return Object.freeze({frame: decoded, lastSeen});
    }
    log.warn(cam, 'failed to decode cached snapshot at ' + file + (decodeErr ? ': ' + decodeErr : ''));
  }
  return Object.freeze({frame: null, lastSeen: ''});
}

/**
 * Saves the camera's latest verified raw YUV420p live frame to CACHE_DIR as a JPEG snapshot without blocking the
 * event loop: encodes a private copy of the frame into a temp file, then renames it over the snapshot so a failed
 * or killed encode never truncates the previous one. Skips the save while one for the same file is still running.
 * Never rejects.
 *
 * @param {Camera} cam - Camera domain instance.
 * @returns {Promise<void>}
 */
async function saveCachedFrame(cam) {
  if (!cam.hasValidSnapshotFrame()) {
    return;
  }
  const targetFile = getCacheFilePath(cam);
  if (pendingSaves.has(targetFile)) {
    log.debug(cam, 'skipping cached snapshot save, previous save still running');
    return;
  }
  const tempFile = targetFile + SNAPSHOT_TEMP_SUFFIX;
  const frameCopy = Buffer.from(cam.getLastFrameBuffer());
  const saveTask = (async () => {
    try {
      const r = await runSnapshotFfmpeg(buildEncodeJpegArgs(tempFile), frameCopy, ENCODE_MAX_STDOUT_BYTES);
      if (!r.error && r.status === 0) {
        await fs.promises.rename(tempFile, targetFile);
        migrateLegacyDuplicateCacheFile(cam, CACHE_DIR);
        log.debug(cam, 'saved cached snapshot to ' + targetFile);
      } else {
        log.warn(cam, 'failed to save cached snapshot: ' + formatSnapshotFfmpegFailure(r));
      }
    } catch (err) {
      log.warn(cam, 'error saving cached snapshot: ' + formatErrorMessage(err));
    } finally {
      pendingSaves.delete(targetFile);
      await fs.promises.rm(tempFile, {force: true}).catch(ignoreError);
    }
  })();
  pendingSaves.set(targetFile, saveTask);
  await saveTask;
}

/**
 * Resolves once every currently in-flight snapshot FFmpeg encode and atomic file rename settles.
 *
 * @returns {Promise<void>}
 */
async function waitForPendingSnapshotSaves() {
  if (pendingSaves.size === 0) {
    return;
  }
  await Promise.allSettled([...pendingSaves.values()]);
}

module.exports = {
  buildDecodeJpegArgs,
  buildEncodeJpegArgs,
  getCacheFilePath,
  migrateLegacyDuplicateCacheFile,
  loadCachedFrame,
  saveCachedFrame,
  waitForPendingSnapshotSaves,
};
