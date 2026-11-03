// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * BackfillJob domain model encapsulating missed-event clip requests, HomeBase
 * database record parsing (.zxvideo / crop_local_path), and time-window matching.
 */
'use strict';

const {DEFAULT_EVENT_PRIORITY} = require('../config');
const DEFAULT_BACKFILL_MAX_AGE_MS = 300000;
const BACKFILL_MATCH_LOOKBACK_MS = 45000;
const BACKFILL_MATCH_LOOKAHEAD_MS = 180000;
const TEST_BACKFILL_OFFSET_MS = 10000;
const TEST_BACKFILL_PRIORITY = 9999;

/**
 * Parses the recording timestamp (ms) from a HomeBase database record's start_time or storage_path.
 *
 * @param {string} startStr - ISO or timestamp string from the database record.
 * @param {string} storagePath - HomeBase internal storage path containing YYYYMMDDHHMMSS.
 * @returns {number}
 */
function parseClipTimestampMs(startStr, storagePath) {
  const parsedDirect = startStr ? new Date(startStr).getTime() : 0;
  if (parsedDirect && !Number.isNaN(parsedDirect)) {
    return parsedDirect;
  }
  const tm = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(storagePath || ''));
  if (!tm) {
    return 0;
  }
  return new Date(
      Number(tm[1]),
      Number(tm[2]) - 1,
      Number(tm[3]),
      Number(tm[4]),
      Number(tm[5]),
      Number(tm[6])
  ).getTime();
}

/**
 * Extracts a normalized clip candidate { devSn, storagePath, cipherId, clipMs } from a raw
 * HomeBase database query row, or returns null if the row is incomplete.
 *
 * @param {*} item - Raw row from station database query response.
 * @returns {{ devSn: string, storagePath: string, cipherId: number, clipMs: number }|null}
 */
function extractDatabaseRecordCandidate(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const rec = item.record && typeof item.record === 'object' ? item.record : item;
  const devSn = rec.device_sn || rec.deviceSN || rec.deviceSerial || rec.serialNumber || '';
  if (!devSn) {
    return null;
  }

  let storagePath = rec.storage_path || rec.storagePath || rec.local_path || rec.localPath || '';
  const cropPath = rec.crop_local_path || rec.cropLocalPath || rec.thumb_path || '';
  if (!storagePath && cropPath) {
    const m = /^(.*\/(\d{14}))\/[^/]+$/.exec(String(cropPath));
    if (m) {
      storagePath = m[1] + '/' + m[2] + '.zxvideo';
    }
  }
  if (!storagePath) {
    return null;
  }

  const cipherId = Number(rec.cipher_id ?? rec.cipherId ?? 0);
  const startStr = rec.start_time || rec.startTime || rec.create_time || rec.createTime || '';
  const clipMs = parseClipTimestampMs(startStr, storagePath);

  return {devSn, storagePath, cipherId, clipMs};
}

/**
 * Domain model representing a pending missed-event clip backfill request on a HomeBase camera.
 */
class BackfillJob {
  /**
   * @param {Record<string, *>} opts - Backfill job parameters.
   */
  constructor(opts = {}) {
    this.at = opts.at ?? Date.now();
    this.event = opts.event || 'motion detected';
    this.personName = opts.personName || '';
    this.reason = opts.reason || this.event;
    this.priority = opts.priority ?? DEFAULT_EVENT_PRIORITY;
    this.attempts = opts.attempts ?? 0;
    this.ignoreTimeWindow = Boolean(opts.ignoreTimeWindow);
  }

  /**
   * Returns true if this backfill request is older than maxAgeMs (default 5 minutes).
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @param {number} [maxAgeMs=300000] - Maximum age in milliseconds.
   * @returns {boolean}
   */
  isExpired(now = Date.now(), maxAgeMs = DEFAULT_BACKFILL_MAX_AGE_MS) {
    return now - this.at > maxAgeMs;
  }

  /**
   * Checks whether a parsed HomeBase clip candidate falls within this job's trigger time window.
   *
   * @param {{ storagePath: string, clipMs: number }} candidate - Parsed clip candidate.
   * @param {Set<string>} downloadedPaths - Set of already downloaded storage paths.
   * @returns {boolean}
   */
  matchesCandidate(candidate, downloadedPaths) {
    if (!candidate || downloadedPaths.has(candidate.storagePath)) {
      return false;
    }
    if (this.ignoreTimeWindow || !candidate.clipMs) {
      return true;
    }
    return candidate.clipMs >= this.at - BACKFILL_MATCH_LOOKBACK_MS && candidate.clipMs <= this.at + BACKFILL_MATCH_LOOKAHEAD_MS;
  }

  /**
   * Creates a matched clip descriptor ready for device.start_download.
   *
   * @param {{ storagePath: string, cipherId: number }} candidate - Matched database candidate.
   * @returns {{ storagePath: string, cipherId: number, event: string, personName: string, reason: string }}
   */
  toMatchedClip(candidate) {
    return {
      storagePath: candidate.storagePath,
      cipherId: candidate.cipherId,
      event: this.event,
      personName: this.personName,
      reason: this.reason,
    };
  }

  /**
   * Creates a high-priority synthetic BackfillJob for the SIGUSR1 test hook.
   *
   * @param {number} [now=Date.now()] - Current epoch timestamp.
   * @returns {BackfillJob}
   */
  static createSigUsr1TestJob(now = Date.now()) {
    return new BackfillJob({
      at: now - TEST_BACKFILL_OFFSET_MS,
      ignoreTimeWindow: true,
      event: 'motion detected',
      personName: '',
      reason: 'SIGUSR1 backfill test',
      priority: TEST_BACKFILL_PRIORITY,
      attempts: 0,
    });
  }
}

module.exports = {
  DEFAULT_BACKFILL_MAX_AGE_MS,
  BackfillJob,
  parseClipTimestampMs,
  extractDatabaseRecordCandidate,
};
