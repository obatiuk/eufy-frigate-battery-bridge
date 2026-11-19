// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * The go2rtc consumers connected to one camera and which of them are allowed to wake or hold it.
 */
'use strict';

/**
 * Tracks connected go2rtc viewer consumers for a single camera. A consumer is tracked as non-waking when it connects
 * and only wakes the camera after the viewer poll explicitly allows it.
 */
class ViewerSet {
  constructor() {
    /** @type {Map<string|number, boolean>} Consumer ID -> whether it is allowed to wake or hold the camera. */
    this.ids = new Map();
    /** Latest polled count of non-recorder viewers (may exceed the tracked consumer IDs). */
    this.total = 0;
  }

  /**
   * Starts tracking a newly connected consumer as non-waking.
   *
   * @param {string|number} id - go2rtc consumer ID.
   */
  register(id) {
    this.ids.set(id, false);
  }

  /**
   * Returns true if the consumer ID is already tracked.
   *
   * @param {string|number} id - go2rtc consumer ID.
   * @returns {boolean}
   */
  has(id) {
    return this.ids.has(id);
  }

  /**
   * Sets whether a consumer may wake or hold the camera.
   *
   * @param {string|number} id - go2rtc consumer ID.
   * @param {*} asked - Truthy to allow the consumer to wake or hold the camera.
   */
  setWaking(id, asked) {
    this.ids.set(id, Boolean(asked));
  }

  /**
   * Returns true if at least one tracked consumer may wake or hold the camera.
   *
   * @returns {boolean}
   */
  hasWaking() {
    for (const isWaking of this.ids.values()) {
      if (isWaking) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns the number of tracked consumers that may wake or hold the camera.
   *
   * @returns {number}
   */
  wakingCount() {
    let waking = 0;
    for (const isWaking of this.ids.values()) {
      if (isWaking) {
        waking++;
      }
    }
    return waking;
  }

  /**
   * Returns the latest polled count of non-recorder viewers.
   *
   * @returns {number}
   */
  count() {
    return this.total || 0;
  }

  /**
   * Returns true if at least one non-recorder viewer is connected.
   *
   * @returns {boolean}
   */
  hasAny() {
    return this.total > 0;
  }

  /**
   * Clears all tracked consumer IDs completely.
   */
  clearAll() {
    this.ids.clear();
  }

  /**
   * Stops every tracked consumer from waking the camera until it disconnects and reconnects.
   */
  clearWaking() {
    for (const id of this.ids.keys()) {
      this.ids.set(id, false);
    }
  }

  /**
   * Drops consumers missing from the latest poll and stores the polled viewer total.
   *
   * @param {Set<string|number>} seenIds - Consumer IDs present in the latest poll.
   * @param {number} totalViewers - Polled non-recorder viewer count.
   * @returns {Array<{ id: string|number, wasActiveViewer: boolean }>} Disconnected consumers.
   */
  prune(seenIds, totalViewers) {
    const disconnected = [];
    for (const [id, wasActiveViewer] of [...this.ids.entries()]) {
      if (!seenIds.has(id)) {
        this.ids.delete(id);
        disconnected.push({id, wasActiveViewer});
      }
    }
    this.total = totalViewers;
    return disconnected;
  }
}

module.exports = {ViewerSet};
