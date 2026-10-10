// The plan's data age reads the data layer's skew-safe receipt age, not the
// server's timestamp against this device's clock.
//
// WHY (backend audit B14, 2026-10-09): planner.js buildDataStatus subtracted
// the server's `fetchedAt` from `Date.now()`, the clock-skew bug js/data/api.js
// had already fixed for its own cache, so a device six hours fast flagged
// freshly fetched data as stale (`data_age`) and confidence.js marked the plan
// down for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(APP, p), 'utf8'));

async function planWith(buildOpts) {
  const files = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const b = assembleSampleBundle(Object.fromEntries(files.map(n => [n, read(`data/sample/${n}.json`)])));
  const gameState = buildGameState(b.bootstrap, b.fixtures, buildOpts);
  const squadState = buildSquadState({
    entry: b.entry, history: b.history, transfers: b.transfers, picks: b.picks, gameState, gw: b.planEvent,
  });
  return buildPlan({ gameState, squadState, options: { seed: 7, horizon: 1 } });
}

test('a device clock hours away from the server does not make fresh data stale', async () => {
  // The server stamped the copy seven hours before this device's clock reads,
  // which is what a device seven hours fast sees for data fetched seconds ago.
  const skewed = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  const withReceipt = await planWith({ fetchedAt: skewed, ageSeconds: 30 });
  assert.equal(withReceipt.dataStatus.stale, false);
  assert.ok(withReceipt.dataStatus.sources[0].ageSeconds < 120, `${withReceipt.dataStatus.sources[0].ageSeconds}s`);

  // Without a receipt age the old reading is the fallback (a replay, a test).
  const without = await planWith({ fetchedAt: skewed });
  assert.equal(without.dataStatus.stale, true);
  assert.deepEqual(without.dataStatus.staleReasonCodes, ['data_age']);
});

test('genuinely old data is still stale when the receipt age says so', async () => {
  const old = await planWith({ fetchedAt: new Date().toISOString(), ageSeconds: 7 * 3600 });
  assert.equal(old.dataStatus.stale, true);
});
