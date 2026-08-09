import assert from 'node:assert/strict';
import { likelyFxOpen } from '../update-data.mjs';

// Summer EDT: 17:00 New York = 21:00 UTC.
assert.equal(likelyFxOpen(new Date('2026-08-09T20:59:00Z')), false);
assert.equal(likelyFxOpen(new Date('2026-08-09T21:00:00Z')), true);
// Winter EST: 17:00 New York = 22:00 UTC.
assert.equal(likelyFxOpen(new Date('2026-01-04T21:59:00Z')), false);
assert.equal(likelyFxOpen(new Date('2026-01-04T22:00:00Z')), true);
// Friday close follows the same DST-aware New York boundary.
assert.equal(likelyFxOpen(new Date('2026-08-07T20:59:00Z')), true);
assert.equal(likelyFxOpen(new Date('2026-08-07T21:00:00Z')), false);
console.log('market-hours-dst-v43: all tests passed');
