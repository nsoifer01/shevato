// Entry reads that disagree with each other, on five real GW7 managers.
//
// The history, the transfer list and the picks are three cache keys at the
// proxy, the edge and the browser, and api.js serves a stored copy of any age
// when a refresh fails. PR #611 filled ONE missing week from the picks; the
// 2026-10-16 follow-up audit showed a history two weeks behind still read the
// owner's 1 free transfer as 2 and offered back the Bench Boost he played in
// GW5, and a transfer list behind the history priced recent buys at their
// season-start price, both silently. These hold the whole path, from the raw
// payloads to the plan a visitor is shown.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENTRIES, GAME_STATE, PLAN_GW, APP_OPTIONS } from './helpers/gw7-fixture.mjs';
import { buildSquadState, historyGaps, transfersBehind } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

const LABELS = Object.keys(ENTRIES);
const read = (e, over = {}) => buildSquadState({ ...e, ...over, gameState: GAME_STATE, gw: PLAN_GW });
const withoutWeeks = (history, weeks) => ({
  ...history,
  current: history.current.filter(r => !weeks.includes(r.event)),
  chips: history.chips.filter(c => !weeks.includes(c.event)),
});

test('the real payloads raise neither check (the control)', () => {
  for (const label of LABELS) {
    const e = ENTRIES[label];
    assert.deepEqual(historyGaps(e.history), [], `${label}: a real history has no gap`);
    assert.deepEqual(transfersBehind(e.history, e.transfers), [], `${label}: a real transfer list is not behind`);
    const s = read(e);
    assert.ok(!s.warnings.some(w => w.code === 'history_missing' || w.code === 'transfers_behind'), label);
    assert.equal(s.historyMissing, false, label);
    assert.equal(s.transfersLagging, false, label);
  }
});

test('a history two weeks behind the picks is not replayed as two quiet weeks', async () => {
  for (const label of LABELS) {
    const e = ENTRIES[label];
    const lagged = read(e, { history: withoutWeeks(e.history, [5, 6]) });
    // The picks fill GW6; GW5 cannot be filled from anything public.
    assert.equal(lagged.historyMissing, true, `${label}: GW5 is unknown, so the history is incomplete`);
    const w = lagged.warnings.find(x => x.code === 'history_missing');
    assert.match(w.message, /missing gameweek 5\b/, label);
    assert.deepEqual(lagged.chipsAvailable, [], `${label}: no chip is offered on a history with a hole`);
  }
  // The plan a visitor would be shown: no transfer and no chip on it.
  const bundle = await buildPlan({
    gameState: GAME_STATE,
    squadState: read(ENTRIES.owner, { history: withoutWeeks(ENTRIES.owner.history, [5, 6]) }),
    options: APP_OPTIONS,
  });
  assert.equal(bundle.current.chip, null, 'the Bench Boost played in GW5 is not offered back');
  assert.equal(bundle.current.transferCount, 0, 'no transfer is built on an unknown free-transfer count');
});

test('one week behind is still caught up from the picks, not withheld', () => {
  for (const label of LABELS) {
    const e = ENTRIES[label];
    const truth = read(e);
    const lagged = read(e, { history: withoutWeeks(e.history, [6]) });
    assert.equal(lagged.historyMissing, false, label);
    assert.equal(lagged.freeTransfers, truth.freeTransfers, label);
    assert.deepEqual([...lagged.chipsAvailable].sort(), [...truth.chipsAvailable].sort(), label);
  }
});

test('a transfer list behind the history withholds transfers instead of mispricing them', async () => {
  // The owner made two transfers in GW5 (a Bench Boost week, which still counts
  // them) and one in GW6.
  const e = ENTRIES.owner;
  const short = e.transfers.filter(t => t.event < 5);
  assert.deepEqual(transfersBehind(e.history, short), [5, 6]);
  const s = read(e, { transfers: short });
  assert.equal(s.transfersLagging, true);
  assert.ok(s.warnings.some(w => w.code === 'transfers_behind' && /gameweeks 5, 6/.test(w.message)));
  const bundle = await buildPlan({ gameState: GAME_STATE, squadState: s, options: APP_OPTIONS });
  assert.equal(bundle.current.transferCount, 0, 'no transfer is built on unknown selling prices');
  assert.equal(bundle.current.chip, null);
});

test('Wildcard and Free Hit weeks are never read as a lagging list', () => {
  // FPL reports event_transfers 0 for a rebuild week whatever was made, so an
  // empty list for such a week says nothing; every manager below played one.
  for (const label of LABELS) {
    const e = ENTRIES[label];
    const rebuild = e.history.chips.filter(c => c.name === 'wildcard' || c.name === 'freehit').map(c => c.event);
    assert.ok(rebuild.length > 0, `${label} played a Wildcard or Free Hit`);
    const short = e.transfers.filter(t => !rebuild.includes(t.event));
    assert.deepEqual(transfersBehind(e.history, short), [], label);
  }
});

// The demo (`?demo=1`) is a synthetic team, and until 2026-10-16 its history
// counted transfers in GW2, GW11 and GW12 that its transfer list did not carry,
// so the check above withheld every transfer on the demo. Real FPL payloads
// never disagree like that; the demo must not either.
test('the committed demo dataset is as consistent as a real team', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { assembleSampleBundle } = await import('../js/data/sample.js');
  const { buildGameState } = await import('../js/engine/normalize.js');
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sample');
  const files = Object.fromEntries(['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks']
    .map(n => [n, JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8'))]));
  const b = assembleSampleBundle(files);
  assert.deepEqual(historyGaps(b.history), []);
  assert.deepEqual(transfersBehind(b.history, b.transfers), []);
  const gameState = buildGameState(b.bootstrap, b.fixtures, { fetchedAt: b.fetchedAt });
  const s = buildSquadState({ entry: b.entry, history: b.history, transfers: b.transfers, picks: b.picks, gameState, gw: b.planEvent });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.freeTransfers, 2, 'the demo plan the UI tests describe');
});
