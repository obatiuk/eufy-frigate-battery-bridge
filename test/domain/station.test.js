/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the Station and StationRegistry domain models (src/domain/station.js): per-station transition
 * serialization, wake pacing and instant slot handover, serialized backfill drains, query pacing, recovery cooldowns,
 * reconnect timers, and /api/status station summaries.
 */
'use strict';

const {describe, it, mock, afterEach} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');

const {Station, StationRegistry} = require('../../src/domain/station');

afterEach(() => {
  mock.timers.reset();
});

describe('Station wake pacing, transition locks, and backfill serialization', () => {
  it('paces consecutive wakes by 2500ms and clears pacing on P2P slot release', () => {
    // Verify: reserveWakeSlot spaces consecutive wakes while releaseWakeSlot enables instant back-to-back switching
    // (AT-13.5, AT-17.1).
    const st = new Station('SN_HB1');
    const first = st.reserveWakeSlot(1000, undefined, 2500);
    assert.deepEqual(first, {delayMs: 0, scheduledSlotAt: 3500});

    const second = st.reserveWakeSlot(2000, undefined, 2500);
    assert.deepEqual(second, {delayMs: 1500, scheduledSlotAt: 6000});

    st.releaseWakeSlotIfMatches(9999);
    assert.equal(st.nextWakeAt, 6000, 'mismatched slot timestamp leaves pacing intact');
    st.releaseWakeSlotIfMatches(6000);
    assert.equal(st.nextWakeAt, 0);

    st.paceDirectWake(5000, 2500);
    assert.equal(st.nextWakeAt, 7500);
    st.releaseWakeSlot();
    assert.equal(st.nextWakeAt, 0);
  });

  it('tracks transition promises and cleans up settled locks', async () => {
    // Verify: trackTransition serializes teardown promises and removes itself from active count once settled.
    const reg = new StationRegistry();
    assert.equal(reg.activeTransitionCount(), 0);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const st = reg.get('SN_HB1');
    st.trackTransition(gate);
    assert.equal(reg.activeTransitionCount(), 1);
    release();
    await st.getTransition();
    assert.equal(reg.activeTransitionCount(), 0);
  });

  it('serializes backfill steps per station, coalesces re-entrant ticks, and tracks query cooldown', async () => {
    // Verify: scheduleBackfill runs steps sequentially with the latest coalesced timestamp (Regression 42).
    const st = new Station('SN_HB1');
    const seen = [];
    let releaseFirst;
    const firstBlock = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = st.scheduleBackfill(
      1000,
      async (stepNow) => {
        seen.push(stepNow);
        if (seen.length === 1) {
          await firstBlock;
        }
      },
      () => {}
    );
    const p2 = st.scheduleBackfill(
      1500,
      async () => {},
      () => {}
    );
    const p3 = st.scheduleBackfill(
      2200,
      async () => {},
      () => {}
    );
    assert.equal(p1, p2);
    assert.equal(p1, p3);
    releaseFirst();
    await p1;
    assert.deepEqual(seen, [1000, 2200]);

    st.markBackfillQueried(5000);
    assert.equal(st.getLastBackfillQueryAt(), 5000);
    st.clearBackfillQueryCooldown();
    assert.equal(st.getLastBackfillQueryAt(), 0);
  });
});

describe('Station recovery state, reconnect timer, and status summary', () => {
  it('enforces 60s recycle cooldown, suppresses disconnect during recycle, and schedules reconnects', () => {
    // Verify: beginRecycle enforces cooldown, sets recycling flag, and noteActivity clears timeouts and timers.
    mock.timers.enable({apis: ['setTimeout']});
    const st = new Station('SN_HB1');
    assert.equal(st.getSerial(), 'SN_HB1');
    assert.equal(st.isKnown(), false);
    st.markKnown();
    assert.equal(st.isKnown(), true);
    st.markDisconnected(true);
    assert.equal(st.disconnected, true);

    assert.equal(st.recordWakeTimeout(), 1);
    assert.equal(st.canRecycle(10000, false, 60000), true);
    assert.equal(st.canRecycle(10000, true, 60000), false, 'active video blocks station recycle');

    st.markRecycleStarted(10000);
    assert.equal(st.isRecycling(), true);
    assert.equal(st.unresponsiveTimeouts, 0);
    assert.equal(st.canRecycle(30000, false, 60000), false, '60s cooldown blocks back-to-back recycle');
    st.markRecycleFinished();
    assert.equal(st.isRecycling(), false);

    let fired = 0;
    st.scheduleReconnect(10000, () => {
      fired++;
    });
    assert.equal(st.isReconnecting(), true);
    st.scheduleReconnect(10000, () => {
      fired += 10;
    });
    mock.timers.tick(10000);
    assert.equal(fired, 1);
    assert.equal(st.isReconnecting(), false);

    st.scheduleReconnect(10000, () => {
      fired++;
    });
    st.noteActivity();
    assert.equal(st.disconnected, false);
    assert.equal(st.isReconnecting(), false);
  });

  it('builds frozen /api/status summaries across configured and discovered stations', () => {
    // Verify: StationRegistry.buildSummaries merges camera and known station serials and reports P2P slot occupancy.
    const reg = new StationRegistry();
    const cam1 = {
      getName: () => 'front',
      getStationSerial: () => 'SN_HB1',
      isOccupyingStationP2pChannel: () => true,
      isStationConnected: () => true,
    };
    const cam2 = {
      getName: () => 'back',
      getStationSerial: () => 'SN_HB1',
      isOccupyingStationP2pChannel: () => false,
      isStationConnected: () => true,
    };
    const cams = [cam1, cam2];
    reg.bindCameras(cams);
    reg.registerKnown('SN_HB2');

    const summaries = reg.buildSummaries(cams, true);
    assert.deepEqual(summaries, [
      {
        serial: 'SN_HB1',
        connected: true,
        recycling: false,
        reconnecting: false,
        p2p_busy: true,
        active_p2p_camera: 'front',
        cameras: ['front', 'back'],
      },
      {
        serial: 'SN_HB2',
        connected: true,
        recycling: false,
        reconnecting: false,
        p2p_busy: false,
        active_p2p_camera: null,
        cameras: [],
      },
    ]);
  });
});
