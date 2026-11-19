// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Finite-state enums and validated transition maps for the Camera streaming session, Frigate event filing, and
 * FFmpeg decoder backpressure lifecycles.
 */
'use strict';

/**
 * Enumerates the finite states of a Camera streaming session.
 *
 * @readonly
 * @enum {string}
 */
const SESSION_STATES = Object.freeze({
  IDLE: 'idle',
  WAKING_RTSP: 'waking_rtsp',
  WAKING_P2P: 'waking_p2p',
  HANDSHAKING_BACKFILL: 'handshaking_backfill',
  STREAMING_LIVE: 'streaming_live',
  PLAYING_BACKFILL: 'playing_backfill',
  DRAINING_BACKFILL_TAIL: 'draining_backfill_tail',
  COOLDOWN: 'cooldown',
});

/**
 * Validated transition map for the Camera session finite state machine.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const ALLOWED_SESSION_TRANSITIONS = Object.freeze({
  [SESSION_STATES.IDLE]: Object.freeze(
    new Set([
      SESSION_STATES.IDLE,
      SESSION_STATES.WAKING_RTSP,
      SESSION_STATES.WAKING_P2P,
      SESSION_STATES.HANDSHAKING_BACKFILL,
    ])
  ),
  [SESSION_STATES.WAKING_RTSP]: Object.freeze(
    new Set([SESSION_STATES.WAKING_RTSP, SESSION_STATES.STREAMING_LIVE, SESSION_STATES.IDLE])
  ),
  [SESSION_STATES.WAKING_P2P]: Object.freeze(
    new Set([SESSION_STATES.WAKING_P2P, SESSION_STATES.STREAMING_LIVE, SESSION_STATES.IDLE])
  ),
  [SESSION_STATES.HANDSHAKING_BACKFILL]: Object.freeze(
    new Set([
      SESSION_STATES.HANDSHAKING_BACKFILL,
      SESSION_STATES.PLAYING_BACKFILL,
      SESSION_STATES.DRAINING_BACKFILL_TAIL,
      SESSION_STATES.IDLE,
    ])
  ),
  [SESSION_STATES.STREAMING_LIVE]: Object.freeze(
    new Set([SESSION_STATES.STREAMING_LIVE, SESSION_STATES.WAKING_RTSP, SESSION_STATES.COOLDOWN, SESSION_STATES.IDLE])
  ),
  [SESSION_STATES.PLAYING_BACKFILL]: Object.freeze(
    new Set([SESSION_STATES.PLAYING_BACKFILL, SESSION_STATES.DRAINING_BACKFILL_TAIL, SESSION_STATES.IDLE])
  ),
  [SESSION_STATES.DRAINING_BACKFILL_TAIL]: Object.freeze(
    new Set([SESSION_STATES.DRAINING_BACKFILL_TAIL, SESSION_STATES.IDLE])
  ),
  [SESSION_STATES.COOLDOWN]: Object.freeze(
    new Set([
      SESSION_STATES.COOLDOWN,
      SESSION_STATES.WAKING_RTSP,
      SESSION_STATES.WAKING_P2P,
      SESSION_STATES.HANDSHAKING_BACKFILL,
      SESSION_STATES.IDLE,
    ])
  ),
});

/**
 * Returns true if transitioning a Camera session from fromState to toState is permitted by the FSM.
 *
 * @param {string} fromState - Current session state.
 * @param {string} toState - Target session state.
 * @returns {boolean}
 */
function canTransitionSession(fromState, toState) {
  const allowed = ALLOWED_SESSION_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.has(toState));
}

/**
 * Enumerates the finite states of a Camera's Frigate detection event filing lifecycle.
 *
 * @readonly
 * @enum {string}
 */
const FRIGATE_EVENT_STATES = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  WAITING_SNAPSHOT: 'waiting_snapshot',
  COOLDOWN: 'cooldown',
});

/**
 * Validated transition map for the Frigate event lifecycle finite state machine.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const ALLOWED_FRIGATE_EVENT_TRANSITIONS = Object.freeze({
  [FRIGATE_EVENT_STATES.IDLE]: Object.freeze(new Set([FRIGATE_EVENT_STATES.IDLE, FRIGATE_EVENT_STATES.QUEUED])),
  [FRIGATE_EVENT_STATES.QUEUED]: Object.freeze(
    new Set([
      FRIGATE_EVENT_STATES.QUEUED,
      FRIGATE_EVENT_STATES.WAITING_SNAPSHOT,
      FRIGATE_EVENT_STATES.COOLDOWN,
      FRIGATE_EVENT_STATES.IDLE,
    ])
  ),
  [FRIGATE_EVENT_STATES.WAITING_SNAPSHOT]: Object.freeze(
    new Set([FRIGATE_EVENT_STATES.WAITING_SNAPSHOT, FRIGATE_EVENT_STATES.COOLDOWN, FRIGATE_EVENT_STATES.IDLE])
  ),
  [FRIGATE_EVENT_STATES.COOLDOWN]: Object.freeze(
    new Set([FRIGATE_EVENT_STATES.COOLDOWN, FRIGATE_EVENT_STATES.QUEUED, FRIGATE_EVENT_STATES.IDLE])
  ),
});

/**
 * Enumerates the finite states of a Camera's FFmpeg decoder backpressure and EOF flush pipeline.
 *
 * @readonly
 * @enum {string}
 */
const DECODER_STATES = Object.freeze({
  DETACHED: 'detached',
  HANDSHAKING: 'handshaking',
  DECODING: 'decoding',
  PAUSED_BACKPRESSURE: 'paused_backpressure',
  FLUSHING_EOF: 'flushing_eof',
});

/**
 * Validated transition map for the decoder backpressure finite state machine.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const ALLOWED_DECODER_TRANSITIONS = Object.freeze({
  [DECODER_STATES.DETACHED]: Object.freeze(new Set([DECODER_STATES.DETACHED, DECODER_STATES.HANDSHAKING])),
  [DECODER_STATES.HANDSHAKING]: Object.freeze(
    new Set([
      DECODER_STATES.HANDSHAKING,
      DECODER_STATES.DECODING,
      DECODER_STATES.PAUSED_BACKPRESSURE,
      DECODER_STATES.FLUSHING_EOF,
      DECODER_STATES.DETACHED,
    ])
  ),
  [DECODER_STATES.DECODING]: Object.freeze(
    new Set([
      DECODER_STATES.DECODING,
      DECODER_STATES.PAUSED_BACKPRESSURE,
      DECODER_STATES.FLUSHING_EOF,
      DECODER_STATES.DETACHED,
    ])
  ),
  [DECODER_STATES.PAUSED_BACKPRESSURE]: Object.freeze(
    new Set([
      DECODER_STATES.PAUSED_BACKPRESSURE,
      DECODER_STATES.DECODING,
      DECODER_STATES.FLUSHING_EOF,
      DECODER_STATES.DETACHED,
    ])
  ),
  [DECODER_STATES.FLUSHING_EOF]: Object.freeze(
    new Set([DECODER_STATES.FLUSHING_EOF, DECODER_STATES.PAUSED_BACKPRESSURE, DECODER_STATES.DETACHED])
  ),
});

module.exports = {
  SESSION_STATES,
  ALLOWED_SESSION_TRANSITIONS,
  canTransitionSession,
  FRIGATE_EVENT_STATES,
  ALLOWED_FRIGATE_EVENT_TRANSITIONS,
  DECODER_STATES,
  ALLOWED_DECODER_TRANSITIONS,
};
