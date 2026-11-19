/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Regression test for post-mortem 23. Loitering Event Substring Matched Doorbell Ring Priority Tier
 * (docs/regression/23-loitering-event-substring-matched-doorbell-ring-priority.md).
 */
'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/test-env');
const {resolveCameraTriggers, getEventPriority} = require('../../src/config');

describe('Regression 23. Loitering Event Substring Matched Doorbell Ring Priority Tier', () => {
  it(
    'Regression 23: expands all 13 documented trigger_events types and ' +
      'resolves built-in and custom event_priorities tiers',
    () => {
      // Regression: verify all 13 documented trigger_events expand cleanly and 'someone loitering' never
      // substring-matches 'ring'.
      const allTriggerTypes = resolveCameraTriggers({
        serial: 'T8214T2222222222',
        trigger_events: [
          'motion',
          'radar',
          'person',
          'identity person',
          'stranger',
          'loitering',
          'package',
          'pet',
          'dog',
          'vehicle',
          'sound',
          'crying',
          'ring',
        ],
      });
      assert.equal(allTriggerTypes.has('motion detected'), true);
      assert.equal(allTriggerTypes.has('radar motion detected'), true);
      assert.equal(allTriggerTypes.has('person detected'), true);
      assert.equal(allTriggerTypes.has('identity person detected'), true);
      assert.equal(allTriggerTypes.has('stranger person detected'), true);
      assert.equal(allTriggerTypes.has('someone loitering'), true);
      assert.equal(allTriggerTypes.has('package delivered'), true);
      assert.equal(allTriggerTypes.has('pet detected'), true);
      assert.equal(allTriggerTypes.has('dog detected'), true);
      assert.equal(allTriggerTypes.has('vehicle detected'), true);
      assert.equal(allTriggerTypes.has('sound detected'), true);
      assert.equal(allTriggerTypes.has('crying detected'), true);
      assert.equal(allTriggerTypes.has('rings'), true);

      const cryingOnly = resolveCameraTriggers({
        serial: 'T8161T0000000000',
        trigger_events: ['crying'],
      });
      assert.equal(cryingOnly.has('crying detected'), true);
      assert.equal(cryingOnly.has('motion detected'), false);

      // Built-in priority tiers documented in README.md
      assert.equal(getEventPriority('rings'), 1000);
      assert.equal(getEventPriority('identity person detected'), 300);
      assert.equal(getEventPriority('person detected'), 200);
      assert.equal(getEventPriority('stranger person detected'), 200);
      assert.equal(getEventPriority('someone loitering'), 200);
      assert.equal(getEventPriority('package delivered'), 150);
      assert.equal(getEventPriority('vehicle detected'), 100);
      assert.equal(getEventPriority('pet detected'), 100);
      assert.equal(getEventPriority('dog detected'), 100);
      assert.equal(getEventPriority('crying detected'), 50);
      assert.equal(getEventPriority('sound detected'), 50);
      assert.equal(getEventPriority('radar motion detected'), 10);
      assert.equal(getEventPriority('motion detected'), 10);

      // Custom event_priorities override object
      const customTiers = {
        ring: 2000,
        'identity person': 500,
        person: 250,
        motion: 25,
      };
      assert.equal(getEventPriority('rings', customTiers), 2000);
      assert.equal(getEventPriority('someone loitering', customTiers), 200);
      assert.equal(getEventPriority('identity person detected', customTiers), 500);
      assert.equal(getEventPriority('person detected', customTiers), 250);
      assert.equal(getEventPriority('motion detected', customTiers), 25);
    }
  );
});
