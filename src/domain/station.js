// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * HomeBase (and standalone camera) station domain model and registry unifying P2P slot transition locks, wake pacing,
 * serialized backfill drains, database query pacing, health/recycle cooldowns, reconnect timers, and status summaries.
 */
'use strict';

/**
 * Represents one HomeBase (or standalone device) station and its P2P channel coordination and recovery state.
 */
class Station {
  /**
   * @param {string} serial - Station serial number or canonical station key.
   */
  constructor(serial) {
    this.serial = String(serial || '');
    this.known = false;
    this.disconnected = false;
    this.recycling = false;
    this.unresponsiveTimeouts = 0;
    this.lastRecoveryAt = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.reconnectTimer = null;

    /** @type {Promise<void>|null} */
    this.transitionPromise = null;
    this.nextWakeAt = 0;
    /** @type {Promise<void>|null} */
    this.backfillPromise = null;
    /** @type {number|null} */
    this.backfillPendingAt = null;
    this.lastBackfillQueryAt = 0;
  }

  /**
   * Returns the canonical serial number or station key of this station.
   *
   * @returns {string}
   */
  getSerial() {
    return this.serial;
  }

  /**
   * Returns true if this station has been registered as known for P2P health tracking.
   *
   * @returns {boolean}
   */
  isKnown() {
    return Boolean(this.known);
  }

  /**
   * Marks this station as known for P2P health tracking and recovery.
   */
  markKnown() {
    this.known = true;
  }

  /**
   * Returns true while a station.disconnect -> station.connect recycle is in progress.
   *
   * @returns {boolean}
   */
  isRecycling() {
    return Boolean(this.recycling);
  }

  /**
   * Returns the epoch timestamp (ms) of the last HomeBase backfill database query on this station.
   *
   * @returns {number}
   */
  getLastBackfillQueryAt() {
    return this.lastBackfillQueryAt;
  }

  /**
   * Returns the active teardown transition promise for this station (or an already-resolved promise when idle).
   *
   * @returns {Promise<void>}
   */
  getTransition() {
    return this.transitionPromise || Promise.resolve();
  }

  /**
   * Returns true while an asynchronous stop/teardown transition promise is active on this station.
   *
   * @returns {boolean}
   */
  hasActiveTransition() {
    return Boolean(this.transitionPromise);
  }

  /**
   * Stores a teardown promise on this station and clears it once settled.
   *
   * @param {Promise<*>} promise - In-flight teardown promise.
   */
  trackTransition(promise) {
    const tracked = promise.finally(() => {
      if (this.transitionPromise === tracked) {
        this.transitionPromise = null;
      }
    });
    this.transitionPromise = tracked;
  }

  /**
   * Reserves the next paced wake slot on this station and returns `{ delayMs, scheduledSlotAt }`.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number|undefined} explicitDelayMs - Optional explicit caller delay override in ms.
   * @param {number} pacingMs - Station wake spacing interval in milliseconds.
   * @returns {{ delayMs: number, scheduledSlotAt: number }}
   */
  reserveWakeSlot(now, explicitDelayMs, pacingMs) {
    const nextSlotAt = Math.max(now, this.nextWakeAt || 0);
    const delayMs =
      explicitDelayMs !== undefined && explicitDelayMs > 0 ? explicitDelayMs : Math.max(0, nextSlotAt - now);
    const scheduledSlotAt = now + delayMs + pacingMs;
    this.nextWakeAt = scheduledSlotAt;
    return {delayMs, scheduledSlotAt};
  }

  /**
   * Advances nextWakeAt by pacingMs from now when starting an immediate RTSP or P2P wake.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {number} pacingMs - Station wake spacing interval in milliseconds.
   */
  paceDirectWake(now, pacingMs) {
    this.nextWakeAt = Math.max(this.nextWakeAt || 0, now + pacingMs);
  }

  /**
   * Clears wake pacing so back-to-back P2P handover starts immediately after a session ends.
   */
  releaseWakeSlot() {
    this.nextWakeAt = 0;
  }

  /**
   * Releases nextWakeAt only if it still equals scheduledSlotAt (e.g., when a paced /api/wake aborts on WS close).
   *
   * @param {number} scheduledSlotAt - Slot timestamp reserved when the timer was scheduled.
   */
  releaseWakeSlotIfMatches(scheduledSlotAt) {
    if (this.nextWakeAt === scheduledSlotAt) {
      this.nextWakeAt = 0;
    }
  }

  /**
   * Serializes backfill queue steps on this station, coalescing re-entrant ticks onto the latest timestamp.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {(stepNow: number) => Promise<void>} runStepFn - Async single-step backfill callback.
   * @param {(err: *) => void} onErrorFn - Error logger callback.
   * @returns {Promise<void>}
   */
  scheduleBackfill(now, runStepFn, onErrorFn) {
    if (this.backfillPromise) {
      const prevNow = this.backfillPendingAt || 0;
      this.backfillPendingAt = Math.max(prevNow, now);
      return this.backfillPromise;
    }
    const runDrain = Promise.resolve().then(async () => {
      let stepNow = now;
      try {
        for (;;) {
          await runStepFn(stepNow);
          if (this.backfillPendingAt === null) {
            break;
          }
          stepNow = this.backfillPendingAt;
          this.backfillPendingAt = null;
        }
      } catch (err) {
        onErrorFn(err);
      } finally {
        this.backfillPendingAt = null;
        if (this.backfillPromise === runDrain) {
          this.backfillPromise = null;
        }
      }
    });
    this.backfillPromise = runDrain;
    return runDrain;
  }

  /**
   * Records that a HomeBase backfill database query was dispatched at now.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  markBackfillQueried(now) {
    this.lastBackfillQueryAt = now;
  }

  /**
   * Clears the station-level backfill database query cooldown (for immediate split-clip follow-ups).
   */
  clearBackfillQueryCooldown() {
    this.lastBackfillQueryAt = 0;
  }

  /**
   * Updates whether this station has explicitly reported a disconnected P2P link.
   *
   * @param {boolean} disconnected - True when disconnected.
   */
  markDisconnected(disconnected) {
    this.disconnected = Boolean(disconnected);
  }

  /**
   * Increments and returns the consecutive unresponsive camera wake timeout count on this station.
   *
   * @returns {number}
   */
  recordWakeTimeout() {
    this.unresponsiveTimeouts += 1;
    return this.unresponsiveTimeouts;
  }

  /**
   * Returns true when this station is eligible for a forced disconnect -> connect recycle.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   * @param {boolean} hasActiveVideo - True if any camera on this station is actively receiving video.
   * @param {number} cooldownMs - Minimum interval between recycles in milliseconds.
   * @returns {boolean}
   */
  canRecycle(now, hasActiveVideo, cooldownMs) {
    return !hasActiveVideo && !(this.lastRecoveryAt > 0 && now - this.lastRecoveryAt < cooldownMs);
  }

  /**
   * Marks the start of a station.disconnect -> station.connect recycle at now.
   *
   * @param {number} now - Current epoch timestamp in milliseconds.
   */
  markRecycleStarted(now) {
    this.lastRecoveryAt = now;
    this.unresponsiveTimeouts = 0;
    this.recycling = true;
  }

  /**
   * Clears the recycling flag after station.disconnect -> station.connect finishes.
   */
  markRecycleFinished() {
    this.recycling = false;
  }

  /**
   * Returns true when a periodic station.connect retry timer is scheduled.
   *
   * @returns {boolean}
   */
  isReconnecting() {
    return Boolean(this.reconnectTimer);
  }

  /**
   * Cancels any scheduled station.connect retry timer.
   */
  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Schedules a periodic station.connect retry timer if none is already pending.
   *
   * @param {number} delayMs - Delay before retry in milliseconds.
   * @param {() => void} onFire - Callback invoked when the retry timer fires.
   */
  scheduleReconnect(delayMs, onFire) {
    if (!this.serial || this.reconnectTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      onFire();
    }, delayMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.reconnectTimer = timer;
  }

  /**
   * Records live activity on this station, clearing timeout counters, reconnect timers, and disconnected state.
   */
  noteActivity() {
    this.known = true;
    this.unresponsiveTimeouts = 0;
    this.clearReconnectTimer();
    this.disconnected = false;
  }

  /**
   * Resets WebSocket recovery flags, counters, and reconnect timers on WS reset/close.
   */
  resetRecovery() {
    this.known = false;
    this.disconnected = false;
    this.recycling = false;
    this.unresponsiveTimeouts = 0;
    this.lastRecoveryAt = 0;
    this.clearReconnectTimer();
  }

  /**
   * Resets orchestrator transition locks, wake pacing, and backfill scheduling state.
   */
  resetOrchestration() {
    this.transitionPromise = null;
    this.nextWakeAt = 0;
    this.backfillPromise = null;
    this.backfillPendingAt = null;
    this.lastBackfillQueryAt = 0;
  }

  /**
   * Builds an immutable GET /api/status summary entry for this station.
   *
   * @param {Array<{
   *   getName: () => string,
   *   isOccupyingStationP2pChannel: () => boolean,
   *   isStationConnected: () => boolean,
   * }>} stationCams - Cameras attached to this station.
   * @param {boolean} wsConnected - Whether eufy-security-ws is connected.
   * @returns {Readonly<Record<string, *>>}
   */
  toStatusSummary(stationCams, wsConnected) {
    const activeP2pCam = stationCams.find((c) => c.isOccupyingStationP2pChannel()) || null;
    const allCamsStationOk = stationCams.length === 0 || stationCams.every((c) => c.isStationConnected());
    return Object.freeze({
      serial: this.serial,
      connected: Boolean(wsConnected && !this.disconnected && allCamsStationOk),
      recycling: this.recycling,
      reconnecting: this.isReconnecting(),
      p2p_busy: Boolean(activeP2pCam),
      active_p2p_camera: activeP2pCam ? activeP2pCam.getName() : null,
      cameras: Object.freeze(stationCams.map((c) => c.getName())),
    });
  }
}

/**
 * Keyed registry of Station instances shared across the Eufy client, stream orchestrator, and status API.
 */
class StationRegistry {
  constructor() {
    /** @type {Map<string, Station>} */
    this._byKey = new Map();
    /** @type {ReadonlyArray<*>|null} */
    this._boundCams = null;
  }

  /**
   * Binds the active runtime camera list so discovered station serials only apply to that collection.
   *
   * @param {ReadonlyArray<*>} cams - Active Camera instances.
   */
  bindCameras(cams) {
    this._boundCams = cams;
  }

  /**
   * Returns (creating on demand) the Station instance for key.
   *
   * @param {string} key - Station serial or canonical station key.
   * @returns {Station}
   */
  get(key) {
    const normalized = String(key || '');
    let st = this._byKey.get(normalized);
    if (!st) {
      st = new Station(normalized);
      this._byKey.set(normalized, st);
    }
    return st;
  }

  /**
   * Registers a discovered HomeBase or standalone station serial for P2P health tracking.
   *
   * @param {*} stationSn - Candidate station serial number.
   */
  registerKnown(stationSn) {
    if (stationSn && typeof stationSn === 'string') {
      this.get(stationSn).markKnown();
    }
  }

  /**
   * Registers any station serials present on cams and returns all known station serials.
   *
   * @param {ReadonlyArray<{ getStationSerial: () => string }>} cams - Camera collection.
   * @returns {string[]}
   */
  collectKnownSerials(cams) {
    for (const cam of cams) {
      const sn = cam.getStationSerial();
      if (sn) {
        this.registerKnown(sn);
      }
    }
    const out = [];
    for (const st of this._byKey.values()) {
      if (st.isKnown() && st.getSerial()) {
        out.push(st.getSerial());
      }
    }
    return out;
  }

  /**
   * Returns frozen discovered station serials when cams is the bound runtime camera collection.
   *
   * @param {ReadonlyArray<unknown>} cams - Camera collection being inspected.
   * @returns {readonly string[]}
   */
  getKnownSerials(cams) {
    if (cams !== this._boundCams) {
      return Object.freeze([]);
    }
    const out = [];
    for (const st of this._byKey.values()) {
      if (st.isKnown() && st.getSerial()) {
        out.push(st.getSerial());
      }
    }
    return Object.freeze(out);
  }

  /**
   * Returns the number of stations with an active in-flight stop/teardown transition lock.
   *
   * @returns {number}
   */
  activeTransitionCount() {
    let count = 0;
    for (const st of this._byKey.values()) {
      if (st.hasActiveTransition()) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Resets WebSocket recovery flags and reconnect timers across all stations.
   */
  resetRecovery() {
    for (const st of this._byKey.values()) {
      st.resetRecovery();
    }
  }

  /**
   * Resets orchestrator transition locks, wake pacing, and backfill queues across all stations.
   */
  resetOrchestration() {
    for (const st of this._byKey.values()) {
      st.resetOrchestration();
    }
  }

  /**
   * Builds per-station P2P connectivity and slot summaries for GET /api/status.
   *
   * @param {Array<{
   *   getName: () => string,
   *   getStationSerial: () => string,
   *   isOccupyingStationP2pChannel: () => boolean,
   *   isStationConnected: () => boolean,
   * }>} cams - Configured Camera instances.
   * @param {boolean} wsConnected - Whether eufy-security-ws is connected.
   * @returns {ReadonlyArray<Readonly<Record<string, *>>>}
   */
  buildSummaries(cams, wsConnected) {
    /** @type {Set<string>} */
    const serials = new Set();
    for (const cam of cams) {
      const stSn = cam.getStationSerial();
      if (stSn) {
        serials.add(stSn);
      }
    }
    for (const discoveredSn of this.getKnownSerials(cams)) {
      if (discoveredSn) {
        serials.add(discoveredSn);
      }
    }
    const summaries = [];
    for (const stationSn of serials) {
      const stationCams = cams.filter((c) => c.getStationSerial() === stationSn);
      summaries.push(this.get(stationSn).toStatusSummary(stationCams, wsConnected));
    }
    return Object.freeze(summaries);
  }
}

const stations = new StationRegistry();

module.exports = {Station, StationRegistry, stations};
