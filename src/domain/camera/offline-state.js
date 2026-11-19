// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * The offline encoder pause of one camera and the temporary snapshot seed window that lets Frigate pick up the last
 * cached snapshot of an offline camera before its persistent encoder is stopped.
 */
'use strict';

const MIN_SEED_WAIT_MS = 1;

/**
 * Owns the offline encoder pause flag and the seed window timer, its callback, and the consumer-seen latch.
 */
class OfflineState {
  constructor() {
    /** True while the persistent encoder is intentionally stopped because the camera is offline. */
    this.encoderStopped = false;
    /** @type {ReturnType<typeof setTimeout>|null} Seed window timer, set while a snapshot is being seeded. */
    this.seedTimer = null;
    /** True once the first go2rtc consumer connected during the active seed window. */
    this.seedConsumerSeen = false;
    /** @type {(() => void)|null} Callback that stops the encoder when the seed window ends. */
    this.seedExpireFn = null;
  }

  /**
   * Returns true while the persistent encoder is intentionally stopped for an offline camera.
   *
   * @returns {boolean}
   */
  isEncoderStopped() {
    return this.encoderStopped;
  }

  /**
   * Marks the persistent encoder as intentionally stopped for an offline camera.
   */
  markEncoderStopped() {
    this.encoderStopped = true;
  }

  /**
   * Marks the persistent encoder as running again (a new encoder was attached). An active seed window continues.
   */
  markEncoderStarted() {
    this.encoderStopped = false;
  }

  /**
   * Records an offline pause and cancels any seed window.
   *
   * @param {boolean} hadEncoder - Whether an encoder process was still attached before the pause.
   * @returns {boolean} True if the encoder was already paused with no process, so the pause changed nothing.
   */
  pause(hadEncoder) {
    this.clearSeedTimer();
    const wasAlreadyPaused = this.encoderStopped && !hadEncoder;
    this.encoderStopped = true;
    return wasAlreadyPaused;
  }

  /**
   * Clears the offline pause and any seed window when the encoder restarts.
   *
   * @returns {boolean} True if the encoder had been paused for offline.
   */
  clearEncoderPause() {
    this.clearSeedTimer();
    const wasPaused = this.encoderStopped;
    this.encoderStopped = false;
    return wasPaused;
  }

  /**
   * Returns true while a seed window timer is active.
   *
   * @returns {boolean}
   */
  isSeeding() {
    return Boolean(this.seedTimer);
  }

  /**
   * Cancels the seed window timer and forgets its callback and consumer-seen latch.
   */
  clearSeedTimer() {
    if (this.seedTimer) {
      clearTimeout(this.seedTimer);
      this.seedTimer = null;
    }
    this.seedConsumerSeen = false;
    this.seedExpireFn = null;
  }

  /**
   * Starts (or restarts) the seed window: runs onExpire after seedDurationMs, then ends the window.
   *
   * @param {number} seedDurationMs - Window duration in milliseconds (at least 1).
   * @param {() => void} onExpire - Callback invoked when the window expires.
   */
  scheduleSeedStop(seedDurationMs, onExpire) {
    this.clearSeedTimer();
    this.seedExpireFn = onExpire;
    const waitMs = Math.max(MIN_SEED_WAIT_MS, Number(seedDurationMs) || MIN_SEED_WAIT_MS);
    const timer = setTimeout(() => {
      this.seedTimer = null;
      this.seedConsumerSeen = false;
      this.seedExpireFn = null;
      onExpire();
    }, waitMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.seedTimer = timer;
  }

  /**
   * Shortens the active seed window to the post-consumer hold the first time a consumer connects during it.
   *
   * @param {number} postConsumerHoldMs - Milliseconds to keep streaming after the consumer connected.
   * @returns {number} The hold applied in milliseconds, or 0 when no window is active or a consumer was already seen.
   */
  beginConsumerHold(postConsumerHoldMs) {
    if (!this.seedTimer || this.seedConsumerSeen || !this.seedExpireFn) {
      return 0;
    }
    const expireFn = this.seedExpireFn;
    const holdMs = Math.max(MIN_SEED_WAIT_MS, Number(postConsumerHoldMs) || MIN_SEED_WAIT_MS);
    this.scheduleSeedStop(holdMs, expireFn);
    this.seedConsumerSeen = true;
    return holdMs;
  }
}

module.exports = {OfflineState};
