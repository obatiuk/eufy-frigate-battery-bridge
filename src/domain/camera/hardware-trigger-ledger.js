// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * The Eufy hardware detection events (motion, person, ring) currently reported as active for one camera.
 */
'use strict';

// Longest hardware clip (124s recording wait) plus margin: an uncleared trigger older than this is considered lost.
const HARDWARE_TRIGGER_MAX_AGE_MS = 130000;
// Window in which eufy-security-ws repeats one detection as both a property change and a native event.
const COMPANION_EVENT_BURST_MS = 1000;

/**
 * Normalizes a Eufy trigger event name to its ledger key.
 *
 * @param {string} eventName - Raw Eufy event name.
 * @returns {string}
 */
function toKey(eventName) {
  return String(eventName || '').toLowerCase();
}

/**
 * Tracks active hardware trigger events with their start times, expires lost clears, and detects the duplicate
 * companion events eufy-security-ws emits for a single detection.
 */
class HardwareTriggerLedger {
  constructor() {
    /** @type {Set<string>} Lowercase names of events currently reported active. */
    this.events = new Set();
    /** @type {Map<string, number>} Event name -> epoch ms the active event started. */
    this.startedAt = new Map();
    this.lastStart = '';
    this.lastStartTime = 0;
    this.lastClear = '';
    this.lastClearTime = 0;
  }

  /**
   * Records a started event.
   *
   * @param {string} eventName - Eufy event name.
   * @param {number} now - Epoch timestamp in milliseconds.
   */
  start(eventName, now) {
    const key = toKey(eventName);
    this.events.add(key);
    this.startedAt.set(key, now);
    this.lastStart = key;
    this.lastStartTime = now;
  }

  /**
   * Records a cleared event.
   *
   * @param {string} eventName - Eufy event name.
   * @param {number} now - Epoch timestamp in milliseconds.
   */
  clear(eventName, now) {
    const key = toKey(eventName);
    this.events.delete(key);
    this.startedAt.delete(key);
    this.lastClear = key;
    this.lastClearTime = now;
  }

  /**
   * Marks an event name as currently active without updating start timestamps (used for state setup).
   *
   * @param {string} eventName - Raw or normalized Eufy event name.
   */
  addActive(eventName) {
    this.events.add(toKey(eventName));
  }

  /**
   * Forgets every active event without recording a clear.
   */
  clearAll() {
    this.events.clear();
    this.startedAt.clear();
  }

  /**
   * Returns true when no event is active.
   *
   * @returns {boolean}
   */
  isEmpty() {
    return this.events.size === 0;
  }

  /**
   * Returns a copy of the active event names.
   *
   * @returns {string[]}
   */
  activeEvents() {
    return [...this.events];
  }

  /**
   * Returns the most recently started event name ('' when none started yet).
   *
   * @returns {string}
   */
  lastStartEvent() {
    return this.lastStart;
  }

  /**
   * Drops events whose start is strictly older than maxAgeMs, and start times of events no longer active. Events
   * without a recorded start time are kept.
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   * @param {number} [maxAgeMs=HARDWARE_TRIGGER_MAX_AGE_MS] - Maximum event age in milliseconds.
   */
  expireStale(now, maxAgeMs = HARDWARE_TRIGGER_MAX_AGE_MS) {
    if (this.events.size === 0) {
      this.startedAt.clear();
      return;
    }
    for (const trackedKey of [...this.startedAt.keys()]) {
      if (!this.events.has(trackedKey)) {
        this.startedAt.delete(trackedKey);
      }
    }
    for (const key of [...this.events]) {
      const startedAt = this.startedAt.get(key) || 0;
      if (startedAt > 0 && now - startedAt > maxAgeMs) {
        this.events.delete(key);
        this.startedAt.delete(key);
      }
    }
  }

  /**
   * Returns true if at least one active event is within maxAgeMs or has no recorded start time.
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   * @param {number} [maxAgeMs=HARDWARE_TRIGGER_MAX_AGE_MS] - Maximum event age in milliseconds.
   * @returns {boolean}
   */
  hasUnexpired(now, maxAgeMs = HARDWARE_TRIGGER_MAX_AGE_MS) {
    for (const key of this.events) {
      const startedAt = this.startedAt.get(key) || 0;
      if (startedAt <= 0 || now - startedAt <= maxAgeMs) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if a start event repeats the active event started less than one second ago.
   *
   * @param {string} eventName - Eufy event name.
   * @param {number} now - Epoch timestamp in milliseconds.
   * @param {boolean} personMatches - True when the event carries no new person name or the same one.
   * @returns {boolean}
   */
  isDuplicateStart(eventName, now, personMatches) {
    const key = toKey(eventName);
    return Boolean(
      this.events.has(key) &&
      this.lastStart === key &&
      now - this.lastStartTime < COMPANION_EVENT_BURST_MS &&
      personMatches
    );
  }

  /**
   * Returns true if a clear event repeats the event cleared less than one second ago.
   *
   * @param {string} eventName - Eufy event name.
   * @param {number} now - Epoch timestamp in milliseconds.
   * @returns {boolean}
   */
  isDuplicateClear(eventName, now) {
    const key = toKey(eventName);
    return Boolean(
      !this.events.has(key) && this.lastClear === key && now - this.lastClearTime < COMPANION_EVENT_BURST_MS
    );
  }
}

module.exports = {HardwareTriggerLedger, COMPANION_EVENT_BURST_MS};
