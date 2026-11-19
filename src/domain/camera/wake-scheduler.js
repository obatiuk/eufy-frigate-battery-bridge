// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Wake requests of one camera: the immutable WakeRequest value object, the paced /api/wake timer, and the live wake
 * deferred until active backfill playback finishes.
 */
'use strict';

const {DEFAULT_EVENT_PRIORITY} = require('../../config');

const DEFAULT_DEFERRED_INITIATOR = 'api-wake';

/**
 * Wake trigger kinds distinguishing motion/detection events from human viewer/API requests.
 *
 * @readonly
 * @enum {string}
 */
const WAKE_KINDS = Object.freeze({
  MOTION: 'motion',
  VIEW: 'view',
});

/**
 * Fluent builder producing immutable wake/hold request value objects for Camera.applyWakeRequest().
 */
class WakeRequest {
  /**
   * @param {'motion'|'view'} kind - Wake trigger kind.
   * @param {string} reason - Human-readable trigger description.
   * @param {number} durationMs - Requested hold duration in milliseconds.
   */
  constructor(kind, reason, durationMs) {
    /** @type {'motion'|'view'} */
    this._kind = kind === WAKE_KINDS.MOTION ? WAKE_KINDS.MOTION : WAKE_KINDS.VIEW;
    this._reason = String(reason || '');
    this._durationMs = Number(durationMs) || 0;
    this._initiator = 'bridge';
    this._priority = DEFAULT_EVENT_PRIORITY;
    this._createEvent = false;
    this._delayMs = 0;
  }

  /**
   * Creates a motion/event wake request builder.
   *
   * @param {string} reason - Motion or detection event description.
   * @param {number} durationMs - Hold duration in milliseconds.
   * @returns {WakeRequest}
   */
  static motion(reason, durationMs) {
    return new WakeRequest(WAKE_KINDS.MOTION, reason, durationMs);
  }

  /**
   * Creates a viewer or external API wake request builder.
   *
   * @param {string} reason - Viewer or API wake description.
   * @param {number} durationMs - Hold duration in milliseconds.
   * @returns {WakeRequest}
   */
  static view(reason, durationMs) {
    return new WakeRequest(WAKE_KINDS.VIEW, reason, durationMs);
  }

  /**
   * Sets the structured initiator tag on this wake request.
   *
   * @param {string} initiator - Initiator tag (e.g. 'eufy-event', 'viewer', 'api-wake').
   * @returns {this}
   */
  withInitiator(initiator) {
    this._initiator = String(initiator || 'bridge');
    return this;
  }

  /**
   * Sets the event priority boost score on this wake request.
   *
   * @param {number} priority - Priority score.
   * @returns {this}
   */
  withPriority(priority) {
    this._priority = Number(priority) || 0;
    return this;
  }

  /**
   * Sets whether this wake request should also file a synthetic Frigate event.
   *
   * @param {boolean} createEvent - Whether to create a Frigate event.
   * @returns {this}
   */
  withCreateEvent(createEvent) {
    this._createEvent = Boolean(createEvent);
    return this;
  }

  /**
   * Sets an optional scheduling delay in milliseconds for API wake pacing.
   *
   * @param {number} delayMs - Delay in milliseconds.
   * @returns {this}
   */
  withDelay(delayMs) {
    this._delayMs = Math.max(0, Number(delayMs) || 0);
    return this;
  }

  /**
   * Builds and returns a deeply frozen immutable wake request object.
   *
   * @returns {Readonly<{
   *   kind: 'motion'|'view',
   *   reason: string,
   *   durationMs: number,
   *   initiator: string,
   *   priority: number,
   *   createEvent: boolean,
   *   delayMs: number,
   * }>}
   */
  build() {
    return Object.freeze({
      kind: this._kind,
      reason: this._reason,
      durationMs: this._durationMs,
      initiator: this._initiator,
      priority: this._priority,
      createEvent: this._createEvent,
      delayMs: this._delayMs,
    });
  }
}

/**
 * Owns the paced /api/wake timer (its pending options and schedule time) and the single deferred live wake.
 */
class WakeScheduler {
  constructor() {
    /** @type {ReturnType<typeof setTimeout>|null} Paced /api/wake timer. */
    this.apiTimer = null;
    /** @type {{durationMs: number, reason: string, createEvent: boolean}|null} Options of the pending paced wake. */
    this.apiPendingOpts = null;
    /** Epoch ms at which the paced wake timer fires (0 when none is scheduled). */
    this.apiScheduledAt = 0;
    /** @type {ReturnType<WakeRequest['build']>|null} Live wake queued behind active backfill playback. */
    this.deferred = null;
  }

  /**
   * Returns true if a paced /api/wake timer is currently scheduled.
   *
   * @returns {boolean}
   */
  hasPendingApiTimer() {
    return Boolean(this.apiTimer);
  }

  /**
   * Returns the hold duration (in ms) of the pending paced wake, or 0 when none is pending.
   *
   * @returns {number}
   */
  getScheduledApiDurationMs() {
    return this.apiPendingOpts ? this.apiPendingOpts.durationMs : 0;
  }

  /**
   * Cancels the paced wake timer and forgets its options and schedule time.
   */
  clearApiTimer() {
    if (this.apiTimer) {
      clearTimeout(this.apiTimer);
      this.apiTimer = null;
    }
    this.apiPendingOpts = null;
    this.apiScheduledAt = 0;
  }

  /**
   * Schedules a paced /api/wake timer, replacing any pending one.
   *
   * @param {{
   *   durationMs: number,
   *   reason: string,
   *   createEvent: boolean,
   *   delayMs: number,
   *   now: number,
   * }} spec - Paced wake specification (durationMs: requested wake duration in ms; reason: wake reason string;
   *   createEvent: whether to file a synthetic Frigate event; delayMs: pacing delay in ms; now: current epoch ms).
   * @param {(pending: {durationMs: number, reason: string, createEvent: boolean}) => void} onFire - Timer callback.
   */
  scheduleApi(spec, onFire) {
    const {durationMs, reason, createEvent, delayMs, now} = spec;
    this.clearApiTimer();
    this.apiPendingOpts = {durationMs, reason, createEvent};
    this.apiScheduledAt = now + delayMs;
    this.apiTimer = setTimeout(() => {
      const pending = this.apiPendingOpts || {durationMs, reason, createEvent};
      this.clearApiTimer();
      onFire(pending);
    }, delayMs);
    if (this.apiTimer && typeof this.apiTimer.unref === 'function') {
      this.apiTimer.unref();
    }
  }

  /**
   * Merges a duplicate /api/wake request into the pending options (longest duration, sticky createEvent, latest
   * reason) and returns the remaining delay until the timer fires.
   *
   * @param {{durationMs: number, reason: string, createEvent: boolean}} spec - Duplicate wake request options
   *   (durationMs: requested wake hold duration in ms; reason: wake reason string; createEvent: whether to file a
   *   synthetic Frigate event).
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @returns {number} Remaining scheduled delay in milliseconds (never negative).
   */
  coalesceApi(spec, now) {
    const {durationMs, reason, createEvent} = spec;
    const prevDuration = this.getScheduledApiDurationMs();
    const prevCreateEvent = Boolean(this.apiPendingOpts && this.apiPendingOpts.createEvent);
    this.apiPendingOpts = {
      durationMs: Math.max(prevDuration, durationMs),
      reason,
      createEvent: Boolean(prevCreateEvent || createEvent),
    };
    return Math.max(0, (this.apiScheduledAt || now) - now);
  }

  /**
   * Returns true while a live wake is deferred behind backfill playback.
   *
   * @returns {boolean}
   */
  hasDeferred() {
    return Boolean(this.deferred);
  }

  /**
   * Drops the deferred live wake.
   */
  clearDeferred() {
    this.deferred = null;
  }

  /**
   * Queues a live wake, merging it into an already deferred one: longest duration, highest priority, sticky
   * createEvent, and the previous reason or initiator when the new request has none.
   *
   * @param {ReturnType<WakeRequest['build']>} req - Frozen WakeRequest value object.
   * @returns {number} Merged wake duration in milliseconds (0 when req is not an object).
   */
  defer(req) {
    if (!req || typeof req !== 'object') {
      return 0;
    }
    const prev = this.deferred;
    const mergedCreateEvent = Boolean((prev && prev.createEvent) || req.createEvent);
    const mergedDurationMs = Math.max(prev ? prev.durationMs : 0, req.durationMs);
    const mergedPriority = Math.max(prev ? prev.priority : 0, req.priority);
    const mergedReason = req.reason || (prev ? prev.reason : '');
    const mergedInitiator = req.initiator || (prev ? prev.initiator : DEFAULT_DEFERRED_INITIATOR);
    const builder = mergedCreateEvent
      ? WakeRequest.motion(mergedReason, mergedDurationMs).withPriority(mergedPriority)
      : WakeRequest.view(mergedReason, mergedDurationMs);
    this.deferred = builder.withInitiator(mergedInitiator).withCreateEvent(mergedCreateEvent).build();
    return mergedDurationMs;
  }

  /**
   * Removes and returns the deferred live wake.
   *
   * @returns {ReturnType<WakeRequest['build']>|null}
   */
  takeDeferred() {
    const deferred = this.deferred;
    this.deferred = null;
    return deferred;
  }

  /**
   * Merges the deferred wake priority into an incoming hardware event priority and drops the deferred wake.
   *
   * @param {number} evPriority - Incoming Eufy trigger priority boost.
   * @returns {number} The higher of the two priorities (evPriority when nothing is deferred).
   */
  absorbPriority(evPriority) {
    if (!this.deferred) {
      return evPriority;
    }
    const merged = Math.max(evPriority, this.deferred.priority);
    this.deferred = null;
    return merged;
  }
}

module.exports = {WAKE_KINDS, WakeRequest, WakeScheduler};
