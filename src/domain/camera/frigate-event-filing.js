// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * The lifecycle of the external Frigate detection event the bridge files for one camera: queued, waiting for a clean
 * snapshot, filed, and cooling down until the filed window ends.
 */
'use strict';

const {FRIGATE_EVENT_STATES, ALLOWED_FRIGATE_EVENT_TRANSITIONS} = require('./states');

const MOTION_LABEL = 'motion';
const MOTION_EVENT = 'motion detected';
const MS_PER_SECOND = 1000;

/**
 * @typedef {Readonly<{ status: 'upgraded'|'cooldown'|'queued', upgradedLabel: boolean, attachedPerson: boolean }>}
 *   FilingRequestResult
 */

/**
 * Owns the Frigate event state machine plus the label, person, dispatch timer, wait token, and filed window of the
 * event currently being filed for a camera.
 */
class FrigateEventFiling {
  /**
   * @param {(prev: string, next: string, reason: string) => void} [onTransition] - Called after each real state change.
   * @param {(prev: string, next: string, reason: string) => void} [onRefused] - Called when a transition is refused.
   */
  constructor(onTransition = () => {}, onRefused = () => {}) {
    this.onTransition = onTransition;
    this.onRefused = onRefused;
    /** @type {string} */
    this.state = FRIGATE_EVENT_STATES.IDLE;
    /** @type {ReturnType<typeof setTimeout>|null} Scheduled dispatch timer. */
    this.timer = null;
    this.pending = false;
    this.label = '';
    this.person = '';
    /** Epoch ms the filed Frigate event window ends (0 when nothing is filed). */
    this.until = 0;
    this.dispatchedAt = 0;
    /** Monotonic token identifying the current filing attempt, so stale async work can detect it was superseded. */
    this.waitId = 0;
    this.lastCreatedId = '';
  }

  /**
   * Moves the lifecycle to next when permitted, reporting real changes to the transition callback.
   *
   * @param {string} next - Target FRIGATE_EVENT_STATES value.
   * @param {string} [reason=''] - Human-readable transition reason.
   * @returns {string} The resulting state.
   */
  transitionTo(next, reason = '') {
    const prev = this.state;
    const allowed = ALLOWED_FRIGATE_EVENT_TRANSITIONS[prev];
    if (prev && !(allowed && allowed.has(next))) {
      this.onRefused(prev, next, reason);
      return this.state;
    }
    this.state = next;
    if (prev && prev !== next) {
      this.onTransition(prev, next, reason);
    }
    return this.state;
  }

  /**
   * Returns true while a dispatch timer or pending filing exists.
   *
   * @returns {boolean}
   */
  hasPendingDispatch() {
    return Boolean(this.pending || this.timer);
  }

  /**
   * Returns true while an event is queued, waiting for a snapshot, or has a dispatch pending.
   *
   * @returns {boolean}
   */
  isInFlight() {
    return Boolean(
      this.timer ||
      this.pending ||
      this.state === FRIGATE_EVENT_STATES.QUEUED ||
      this.state === FRIGATE_EVENT_STATES.WAITING_SNAPSHOT
    );
  }

  /**
   * Returns the lifecycle state, advancing an elapsed cooldown to idle and forgetting an elapsed window.
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   * @returns {string}
   */
  refresh(now) {
    if (this.state === FRIGATE_EVENT_STATES.COOLDOWN && now >= (this.until || 0)) {
      this.until = 0;
      this.transitionTo(FRIGATE_EVENT_STATES.IDLE, 'cooldown elapsed');
    }
    if (this.until > 0 && now >= this.until && !this.pending && !this.timer) {
      this.until = 0;
    }
    return this.state;
  }

  /**
   * Returns the effective state at now without mutating anything (cooldown elapsed reads as idle).
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   * @returns {string}
   */
  peekEffectiveState(now) {
    return this.state === FRIGATE_EVENT_STATES.COOLDOWN && now >= (this.until || 0)
      ? FRIGATE_EVENT_STATES.IDLE
      : this.state;
  }

  /**
   * Stores the scheduled dispatch timer.
   *
   * @param {ReturnType<typeof setTimeout>|null} timer - Node.js timer handle.
   */
  setTimer(timer) {
    this.timer = timer;
  }

  /**
   * Returns true if waitId is the current attempt and it is waiting for a clean snapshot.
   *
   * @param {number} waitId - Wait token captured when the event was queued.
   * @returns {boolean}
   */
  isSnapshotWaitActive(waitId) {
    return this.waitId === waitId ? this.state === FRIGATE_EVENT_STATES.WAITING_SNAPSHOT : false;
  }

  /**
   * Moves from queued to waiting for a snapshot when the dispatch timer fires for the current attempt.
   *
   * @param {number} [waitId=this.waitId] - Expected wait token.
   * @returns {boolean} True if now waiting for a snapshot.
   */
  beginSnapshotWait(waitId = this.waitId) {
    if (waitId !== this.waitId || !this.pending) {
      return false;
    }
    this.timer = null;
    this.transitionTo(FRIGATE_EVENT_STATES.WAITING_SNAPSHOT, 'dispatch timer fired');
    return this.state === FRIGATE_EVENT_STATES.WAITING_SNAPSHOT;
  }

  /**
   * Aborts a queued or waiting filing: clears the timer, invalidates the wait token, and returns to idle.
   *
   * @param {string} [reason='session ended without video'] - Diagnostic reason.
   */
  abort(reason = 'session ended without video') {
    if (!this.isInFlight()) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.waitId++;
    this.pending = false;
    this.until = 0;
    this.transitionTo(FRIGATE_EVENT_STATES.IDLE, reason);
  }

  /**
   * Evaluates a new filing request against any in-flight or filed event: upgrades the label and person in place when
   * in flight, ignores repeats inside the filed window unless an extension or upgrade is needed, otherwise queues.
   *
   * @param {{ label: string, personName: string, now: number, shouldExtend: () => boolean }} req - Request:
   *   resolved Frigate label, recognized person name ('' when none), epoch ms, and a lazy check of whether the
   *   session now outlasts the filed window.
   * @returns {FilingRequestResult}
   */
  request({label, personName, now, shouldExtend}) {
    const normalizedLabel = label === MOTION_EVENT ? MOTION_LABEL : label;

    this.refresh(now);
    if (this.isInFlight()) {
      let upgradedLabel = false;
      let attachedPerson = false;
      if (this.label === MOTION_LABEL && normalizedLabel !== MOTION_LABEL) {
        this.label = normalizedLabel;
        upgradedLabel = true;
      }
      if (personName && !this.person) {
        this.person = personName;
        attachedPerson = true;
      }
      return Object.freeze({status: 'upgraded', upgradedLabel, attachedPerson});
    }
    if (now < (this.until || 0)) {
      const upgradedLabelInCooldown = Boolean(this.label === MOTION_LABEL && normalizedLabel !== MOTION_LABEL);
      const attachedPersonInCooldown = Boolean(personName && !this.person);
      if (!upgradedLabelInCooldown && !attachedPersonInCooldown && !shouldExtend()) {
        this.transitionTo(FRIGATE_EVENT_STATES.COOLDOWN, 'event in cooldown');
        return Object.freeze({status: 'cooldown', upgradedLabel: false, attachedPerson: false});
      }
      if (upgradedLabelInCooldown) {
        this.label = normalizedLabel;
      }
      if (attachedPersonInCooldown) {
        this.person = personName;
      }
      this.waitId++;
      this.pending = true;
      this.transitionTo(FRIGATE_EVENT_STATES.QUEUED, 'event extended or upgraded');
      return Object.freeze({
        status: 'queued',
        upgradedLabel: upgradedLabelInCooldown,
        attachedPerson: attachedPersonInCooldown,
      });
    }
    this.label = normalizedLabel;
    this.person = personName || '';
    this.waitId++;
    this.pending = true;
    this.transitionTo(FRIGATE_EVENT_STATES.QUEUED, 'event queued');
    return Object.freeze({status: 'queued', upgradedLabel: false, attachedPerson: false});
  }

  /**
   * Marks the pending event as filed and extends the cooldown window to cover durationSecs.
   *
   * @param {number} now - Epoch timestamp in milliseconds.
   * @param {number} durationSecs - Frigate event duration in seconds.
   * @returns {Readonly<{ finalLabel: string, finalPerson: string, subLabel: string|null, durationSecs: number }>}
   */
  complete(now, durationSecs) {
    const finalLabel = this.label;
    const finalPerson = this.person;
    this.pending = false;
    this.dispatchedAt = now;
    this.until = Math.max(this.until || 0, now + durationSecs * MS_PER_SECOND);
    this.transitionTo(FRIGATE_EVENT_STATES.COOLDOWN, 'event filed');
    return Object.freeze({finalLabel, finalPerson, subLabel: finalPerson || null, durationSecs});
  }

  /**
   * Rolls back a completed filing attempt back to idle when the HTTP POST fails, unless a newer
   * companion or extension request has already advanced waitId.
   *
   * @param {number} waitId - Wait token captured when the failed attempt was queued.
   * @param {string} [reason='event filing failed'] - Diagnostic rollback reason.
   * @returns {boolean} True when rolled back; false when superseded by a newer waitId.
   */
  rollback(waitId, reason = 'event filing failed') {
    if (this.waitId !== waitId) {
      return false;
    }
    this.pending = false;
    this.until = 0;
    this.dispatchedAt = 0;
    this.transitionTo(FRIGATE_EVENT_STATES.IDLE, reason);
    return true;
  }

  /**
   * Forgets the filed window so a new event can be filed from scratch (for example for a backfill clip).
   */
  resetWindow() {
    this.until = 0;
    this.dispatchedAt = 0;
  }

  /**
   * Records the Frigate event ID created by the last successful filing.
   *
   * @param {*} eventId - Created Frigate event ID.
   */
  recordCreatedId(eventId) {
    this.lastCreatedId = String(eventId || '');
  }
}

module.exports = {FrigateEventFiling};
