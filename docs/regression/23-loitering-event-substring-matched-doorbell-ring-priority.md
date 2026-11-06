# 23. Loitering Event Substring Matched Doorbell Ring Priority Tier

- **Cause:** `getEventPriority()` in `src/config.js` matched event keywords with plain `normalized.includes(keyword)`
  and evaluated `['ring', 1000]` first in `EVENT_PRIORITIES` (as well as any custom `event_priorities.ring` override
  when `loitering` was not overridden). Because `'someone loitering'` ends with the substring `'ring'`, loitering events
  received doorbell-ring priority `1000` instead of `200` and could preempt higher-priority `P2P` sessions on the same
  `HomeBase` (`AT-13`).
- **Fix:** Added word-start boundary matching (`findKeywordAtWordStart()` and `matchesEventKeyword()`) in
  `getEventPriority()` so keywords match only at index `0` or immediately after a non-alphanumeric delimiter (`'rings'`
  and `'doorbell ring'` match `'ring'`, while `'someone loitering'` matches `'loitering'` at `200`).
- **Tests:** `test/config.test.js` (`expands all 13 documented trigger_events types and resolves built-in and custom
event_priorities tiers`).
