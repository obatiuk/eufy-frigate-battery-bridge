// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * The streaming session state machine of one camera plus the cooldown that follows a finished live session.
 */
'use strict';

const {SESSION_STATES, canTransitionSession} = require('./states');

/**
 * @typedef {{
 *   onTransition?: (prev: string, next: string, reason: string) => void,
 *   onRefused?: (prev: string, next: string, reason: string) => void,
 *   createdAt?: number,
 * }} SessionLifecycleOptions
 */

/**
 * Owns the session state, the previous state and its change time, and the time the camera last went to sleep,
 * which drives the cooldown that blocks immediate viewer re-wakes.
 */
class SessionLifecycle {
  /**
   * @param {number} cooldownMs - How long the camera stays in cooldown after a live session ends.
   * @param {((prev: string, next: string, reason: string) => void)|SessionLifecycleOptions} [callbacks] - Callbacks.
   * @param {number} [createdAt=Date.now()] - Epoch ms the lifecycle starts at.
   */
  constructor(cooldownMs, callbacks = {}, createdAt = Date.now()) {
    const isFn = typeof callbacks === 'function';
    const opts = isFn ? {} : callbacks || {};
    this.cooldownMs = cooldownMs;
    this.onTransition = isFn ? callbacks : typeof opts.onTransition === 'function' ? opts.onTransition : () => {};
    this.onRefused = typeof opts.onRefused === 'function' ? opts.onRefused : () => {};
    /** @type {string} */
    this.state = SESSION_STATES.IDLE;
    /** @type {string} */
    this.prevState = SESSION_STATES.IDLE;
    /** Epoch ms of the last real state change. */
    this.changedAt = typeof opts.createdAt === 'number' ? opts.createdAt : createdAt;
    /** Epoch ms the camera last finished a live session (0 when it never slept). */
    this.sleptAt = 0;
  }

  /**
   * Moves to next when the state machine permits it, recording the previous state and change time.
   *
   * @param {string} next - Target SESSION_STATES value.
   * @param {number} now - Epoch timestamp in milliseconds.
   * @param {string} [reason=''] - Human-readable transition reason.
   * @returns {string} The resulting state.
   */
  transitionTo(next, now, reason = '') {
    const prev = this.state;
    if (prev && !canTransitionSession(prev, next)) {
      this.onRefused(prev, next, reason);
      return this.state;
    }
    this.state = next;
    if (next === SESSION_STATES.COOLDOWN && !this.sleptAt) {
      this.sleptAt = now;
    }
    if (prev && prev !== next) {
      this.prevState = prev;
      this.changedAt = now;
      this.onTransition(prev, next, reason);
    }
    return this.state;
  }

  /**
   * Returns the stored session state without mutating an elapsed cooldown.
   *
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Returns the previous session state recorded before the last state change.
   *
   * @returns {string}
   */
  getPrevState() {
    return this.prevState;
  }

  /**
   * Returns the epoch timestamp (ms) of the last real state change.
   *
   * @returns {number}
   */
  getChangedAt() {
    return this.changedAt;
  }

  /**
   * Returns the epoch timestamp (ms) when the camera last finished a live session (0 when never).
   *
   * @returns {number}
   */
  getSleptAt() {
    return this.sleptAt;
  }

  /**
   * Records that the camera finished a live session at now.
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   */
  markSlept(now) {
    this.sleptAt = now;
  }

  /**
   * Returns the state, advancing an elapsed cooldown to idle.
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   * @returns {string}
   */
  refresh(now) {
    if (this.state === SESSION_STATES.COOLDOWN && now - this.sleptAt >= this.cooldownMs) {
      this.transitionTo(SESSION_STATES.IDLE, now, 'cooldown elapsed');
    }
    return this.state;
  }

  /**
   * Returns the effective state at now without mutating anything (an elapsed cooldown reads as idle).
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   * @returns {string}
   */
  peekEffective(now) {
    return this.state === SESSION_STATES.COOLDOWN && now - this.sleptAt >= this.cooldownMs
      ? SESSION_STATES.IDLE
      : this.state;
  }
}

module.exports = {SessionLifecycle};
