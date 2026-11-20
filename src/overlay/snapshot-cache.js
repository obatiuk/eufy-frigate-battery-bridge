// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Persistent timestamped camera snapshot JPEG <-> YUV420p disk cache (/config/cache).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {W, H, FRAME, CACHE_DIR, MAX_FFMPEG_BUFFER_MULTIPLIER, CameraConfig} = require('../config');
const {
  log,
  formatLocalTimestamp,
  formatLocalHm,
  parseFileTimestampMs,
  formatRelativeAge,
  formatErrorMessage,
  extractFfmpegStderrLines,
} = require('../logger');

/** @typedef {import("../domain/camera").Camera} Camera */

/**
 * @typedef {Readonly<{
 *   frame: Uint8Array|null,
 *   lastSeen: string,
 *   fileName: string,
 *   filePath: string,
 *   takenAtMs: number,
 * }>} LoadedSnapshotResult
 */

const JPEG_ENCODER_QUALITY = '2';
const SNAPSHOT_FFMPEG_THREADS = '1';
const SNAPSHOT_FFMPEG_TIMEOUT_MS = 10000;
const SNAPSHOT_FFMPEG_KILL_SIGNAL = 'SIGKILL';
const SNAPSHOT_JPEG_EXT = '.jpg';
const SNAPSHOT_TEMP_SUFFIX = '.tmp.jpg';
const LOADED_SNAPSHOT_PREFIX = 'loaded snapshot ';
const MAX_SNAPSHOT_STDERR_BYTES = 16384;
const ENCODE_MAX_STDOUT_BYTES = 0;

/** Camera cache prefixes with an FFmpeg encode Promise in flight, preventing stacked saves and allowing drain. */
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
 * Lists filenames in dir without throwing when the directory does not exist or is unreadable.
 *
 * @param {string} dir - Directory path.
 * @returns {Promise<string[]>}
 */
async function readDirEntries(dir) {
  try {
    return await fs.promises.readdir(dir);
  } catch (err) {
    // ENOENT / EACCES indicates the candidate cache directory is absent or unreadable.
    return [];
  }
}

/**
 * Returns true when fileName is an orphaned temporary snapshot encode artifact for prefix.
 *
 * @param {string} fileName - Basename inside the cache directory.
 * @param {string} prefix - Camera snapshot filename prefix.
 * @returns {boolean}
 */
function isTempSnapshotForPrefix(fileName, prefix) {
  return prefix && fileName.startsWith(prefix) ? fileName.endsWith(SNAPSHOT_TEMP_SUFFIX) : false;
}

/**
 * Extracts the epoch millisecond timestamp from a snapshot filename matching `<prefix><YYYY-MM-DD_HH-MM-SS>.jpg`,
 * or returns 0 when the filename belongs to another camera, a temp file, or an unrecognized name.
 *
 * @param {string} fileName - Basename inside the cache directory.
 * @param {string} prefix - Expected camera snapshot filename prefix (`<stem>_snapshot_`).
 * @returns {number}
 */
function extractCameraSnapshotTimestampMs(fileName, prefix) {
  if (
    !prefix ||
    !fileName.startsWith(prefix) ||
    !fileName.endsWith(SNAPSHOT_JPEG_EXT) ||
    fileName.endsWith(SNAPSHOT_TEMP_SUFFIX)
  ) {
    return 0;
  }
  const rawStamp = fileName.slice(prefix.length, fileName.length - SNAPSHOT_JPEG_EXT.length);
  return parseFileTimestampMs(rawStamp);
}

/**
 * Returns true when entry is an older snapshot or legacy `last_*.jpg` file for the same camera that was superseded.
 *
 * @param {string} entry - Candidate directory entry basename.
 * @param {{ keepFileName: string, prefix: string, legacySet: ReadonlySet<string> }} ctx - Match context.
 * @returns {boolean}
 */
function isSupersededSnapshotEntry(entry, ctx) {
  return entry !== ctx.keepFileName
    ? ctx.legacySet.has(entry) || extractCameraSnapshotTimestampMs(entry, ctx.prefix) > 0
    : false;
}

/**
 * Sorts snapshot candidates newest-first by capture timestamp, breaking ties lexicographically descending.
 *
 * @param {{ fileName: string, takenAtMs: number }} a - First candidate.
 * @param {{ fileName: string, takenAtMs: number }} b - Second candidate.
 * @returns {number}
 */
function compareSnapshotsNewestFirst(a, b) {
  return b.takenAtMs !== a.takenAtMs ? b.takenAtMs - a.takenAtMs : b.fileName.localeCompare(a.fileName);
}

/**
 * Returns the unique timestamped cache file path in CACHE_DIR for a specific camera's verified live frame
 * (`<name>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when `serial === name`, or
 * `<name>_<serial>_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` when they differ).
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string, rtsp_url?: string }} cam - Camera or config.
 * @param {Date|number|string} [at] - Optional explicit capture timestamp or Date.
 * @returns {string} Filesystem path in CACHE_DIR.
 */
function getCacheFilePath(cam, at = undefined) {
  return path.join(CACHE_DIR, CameraConfig.resolveCacheFileName(cam, at));
}

/**
 * Migrates legacy `last_<name>[_<serial>].jpg` (and `last_<name>_<name>.jpg`) snapshot files to the timestamped
 * `<name>[_<serial>]_snapshot_<YYYY-MM-DD_HH-MM-SS>.jpg` format using the file modification timestamp, or removes
 * leftover legacy files when a timestamped snapshot already exists.
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string, rtsp_url?: string }} cam - Camera or config.
 * @param {string} [cacheDir=CACHE_DIR] - Snapshot cache directory.
 * @returns {Promise<void>}
 */
async function migrateLegacyCacheFile(cam, cacheDir = CACHE_DIR) {
  const legacyNames = CameraConfig.resolveLegacyCacheFileNames(cam);
  if (legacyNames.length === 0) {
    return;
  }
  const entries = await readDirEntries(cacheDir);
  if (entries.length === 0) {
    return;
  }
  const entrySet = new Set(entries);
  const existingLegacy = legacyNames.filter((name) => entrySet.has(name));
  if (existingLegacy.length === 0) {
    return;
  }
  const prefix = CameraConfig.resolveCacheFilePrefix(cam);
  const hasTimestampedSnapshot = entries.some((entry) => extractCameraSnapshotTimestampMs(entry, prefix) > 0);
  try {
    if (hasTimestampedSnapshot) {
      await Promise.all(
        existingLegacy.map((name) => fs.promises.rm(path.join(cacheDir, name), {force: true}).catch(ignoreError))
      );
      return;
    }
    const primaryLegacyPath = path.join(cacheDir, existingLegacy[0]);
    const st = await fs.promises.stat(primaryLegacyPath);
    const migratedPath = path.join(cacheDir, CameraConfig.resolveCacheFileName(cam, st.mtimeMs));
    await fs.promises.rename(primaryLegacyPath, migratedPath);
    if (existingLegacy.length > 1) {
      await Promise.all(
        existingLegacy
          .slice(1)
          .map((name) => fs.promises.rm(path.join(cacheDir, name), {force: true}).catch(ignoreError))
      );
    }
  } catch (err) {
    // Ignore read-only or transient filesystem errors during legacy cache migration.
  }
}

/**
 * Removes older timestamped snapshots and any legacy `last_*.jpg` files for cam in cacheDir once keepFileName
 * has been verified or atomically renamed into place.
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string, rtsp_url?: string }} cam - Camera or config.
 * @param {string} cacheDir - Snapshot cache directory.
 * @param {string} keepFileName - Active snapshot basename to preserve.
 * @returns {Promise<void>}
 */
async function removeSupersededSnapshots(cam, cacheDir, keepFileName) {
  const entries = await readDirEntries(cacheDir);
  if (entries.length === 0) {
    return;
  }
  const matchCtx = {
    keepFileName,
    prefix: CameraConfig.resolveCacheFilePrefix(cam),
    legacySet: new Set(CameraConfig.resolveLegacyCacheFileNames(cam)),
  };
  const staleFiles = entries.filter((entry) => isSupersededSnapshotEntry(entry, matchCtx));
  await Promise.all(
    staleFiles.map((entry) => fs.promises.rm(path.join(cacheDir, entry), {force: true}).catch(ignoreError))
  );
}

/**
 * Lists timestamped snapshot candidates for cam in cacheDir sorted newest-first, removing any orphaned temp files.
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string, rtsp_url?: string }} cam - Camera or config.
 * @param {string} cacheDir - Candidate snapshot cache directory.
 * @returns {Promise<Array<{ fileName: string, filePath: string, takenAtMs: number }>>}
 */
async function listCameraSnapshotCandidates(cam, cacheDir) {
  await migrateLegacyCacheFile(cam, cacheDir);
  const entries = await readDirEntries(cacheDir);
  if (entries.length === 0) {
    return [];
  }
  const prefix = CameraConfig.resolveCacheFilePrefix(cam);
  /** @type {Array<{ fileName: string, filePath: string, takenAtMs: number }>} */
  const candidates = [];
  for (const entry of entries) {
    if (isTempSnapshotForPrefix(entry, prefix)) {
      await fs.promises.rm(path.join(cacheDir, entry), {force: true}).catch(ignoreError);
      continue;
    }
    const takenAtMs = extractCameraSnapshotTimestampMs(entry, prefix);
    if (takenAtMs > 0) {
      candidates.push({fileName: entry, filePath: path.join(cacheDir, entry), takenAtMs});
    }
  }
  candidates.sort(compareSnapshotsNewestFirst);
  return candidates;
}

/**
 * Formats the user-friendly startup INFO message describing a restored snapshot file, its local capture timestamp,
 * and its relative age, or returns an empty string when no cached snapshot was loaded.
 *
 * @param {{ fileName?: string, takenAtMs?: number }|null|undefined} snapshot - Loaded snapshot descriptor.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 * @returns {string}
 */
function formatLoadedSnapshotLog(snapshot, now = Date.now()) {
  const fileName = snapshot && snapshot.fileName ? String(snapshot.fileName) : '';
  if (!fileName) {
    return '';
  }
  const takenAtMs = snapshot && typeof snapshot.takenAtMs === 'number' ? snapshot.takenAtMs : 0;
  if (takenAtMs <= 0) {
    return LOADED_SNAPSHOT_PREFIX + fileName;
  }
  const takenText = formatLocalTimestamp(new Date(takenAtMs));
  const ageText = formatRelativeAge(now - takenAtMs);
  const ageSuffix = ageText ? ', ' + ageText : '';
  return LOADED_SNAPSHOT_PREFIX + fileName + ' (taken ' + takenText + ageSuffix + ')';
}

/**
 * Loads the latest cached live frame for a camera from CACHE_DIR (or fallback temp directory) if one was saved
 * prior to a container restart, cleaning up any superseded older files. FFmpeg runs off the event loop so startup
 * health probes keep answering.
 *
 * @param {CameraConfig|Camera|{ name?: string, serial?: string, rtsp_url?: string }} cam - Camera or config.
 * @returns {Promise<LoadedSnapshotResult>}
 */
async function loadCachedFrame(cam) {
  const candidateDirs = CACHE_DIR === os.tmpdir() ? [CACHE_DIR] : [CACHE_DIR, os.tmpdir()];
  for (const dir of candidateDirs) {
    const candidates = await listCameraSnapshotCandidates(cam, dir);
    for (const cand of candidates) {
      const {frame: decoded, error: decodeErr} = await tryDecodeJpegToYuv(cand.filePath);
      if (decoded) {
        await removeSupersededSnapshots(cam, dir, cand.fileName);
        const lastSeen = formatLocalHm(new Date(cand.takenAtMs));
        log.debug(cam, 'decoded cached snapshot from ' + cand.filePath + ' (lastSeen=' + lastSeen + ')');
        return Object.freeze({
          frame: decoded,
          lastSeen,
          fileName: cand.fileName,
          filePath: cand.filePath,
          takenAtMs: cand.takenAtMs,
        });
      }
      log.warn(cam, 'failed to decode cached snapshot at ' + cand.filePath + (decodeErr ? ': ' + decodeErr : ''));
    }
  }
  log.debug(cam, 'no cached snapshot found in ' + CACHE_DIR);
  return Object.freeze({frame: null, lastSeen: '', fileName: '', filePath: '', takenAtMs: 0});
}

/**
 * Saves the camera's latest verified raw YUV420p live frame to CACHE_DIR as a timestamped JPEG snapshot without
 * blocking the event loop: encodes a private copy of the frame into a temp file, atomically renames it into place,
 * and removes any older snapshot file for that camera so a failed or killed encode never truncates the previous one.
 * Skips the save while one for the same camera is still running. Never rejects.
 *
 * @param {Camera} cam - Camera domain instance.
 * @returns {Promise<void>}
 */
async function saveCachedFrame(cam) {
  if (!cam.hasValidSnapshotFrame()) {
    return;
  }
  const cameraSaveKey = path.join(CACHE_DIR, CameraConfig.resolveCacheFilePrefix(cam));
  if (pendingSaves.has(cameraSaveKey)) {
    log.debug(cam, 'skipping cached snapshot save, previous save still running');
    return;
  }
  const targetFile = getCacheFilePath(cam);
  const tempFile = targetFile + SNAPSHOT_TEMP_SUFFIX;
  const frameCopy = Buffer.from(cam.getLastFrameBuffer());
  const saveTask = (async () => {
    try {
      const r = await runSnapshotFfmpeg(buildEncodeJpegArgs(tempFile), frameCopy, ENCODE_MAX_STDOUT_BYTES);
      if (!r.error && r.status === 0) {
        await fs.promises.rename(tempFile, targetFile);
        await removeSupersededSnapshots(cam, CACHE_DIR, path.basename(targetFile));
        log.debug(cam, 'saved cached snapshot to ' + targetFile);
      } else {
        log.warn(cam, 'failed to save cached snapshot: ' + formatSnapshotFfmpegFailure(r));
      }
    } catch (err) {
      log.warn(cam, 'error saving cached snapshot: ' + formatErrorMessage(err));
    } finally {
      pendingSaves.delete(cameraSaveKey);
      await fs.promises.rm(tempFile, {force: true}).catch(ignoreError);
    }
  })();
  pendingSaves.set(cameraSaveKey, saveTask);
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
  migrateLegacyCacheFile,
  formatLoadedSnapshotLog,
  loadCachedFrame,
  saveCachedFrame,
  waitForPendingSnapshotSaves,
};
