import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import { sellingPrice } from '../js/engine/rules.js';
import {
  buildSquadState, reconstructPurchasePrices, computeFreeTransfers, chipsRemaining,
} from '../js/engine/squad.js';
import { UNLIMITED, isUnlimited } from '../js/engine/transfer-state.js';
import { assembleSampleBundle } from '../js/data/sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const bootstrap = read('fixtures', 'bootstrap.json');
const fixtures = read('fixtures', 'fixtures.json');
const eventsInSeason = read('fixtures', 'events-in-season.json');
const entry = read('fixtures', 'entry.json');
const history = read('fixtures', 'entry-history.json');
const transfers = read('fixtures', 'entry-transfers.json');
const picks = read('fixtures', 'entry-picks.json');

const gameState = buildGameState({ ...bootstrap, events: eventsInSeason }, fixtures, { fetchedAt: '2026-09-24T10:00:00Z' });
const rules = gameState.rules;
const PLAN_GW = 6;

const squadState = buildSquadState({ entry, history, transfers, picks, gameState, gw: PLAN_GW });

// -------------------------------------------------------- purchase prices ---

test('purchase price comes from the most recent transfer in', () => {
  const prices = reconstructPurchasePrices({ picks, transfers, gameState });
  assert.equal(prices.size, 15);
  for (const t of transfers) {
    if (!picks.picks.some(p => p.element === t.element_in)) continue;
    assert.equal(prices.get(t.element_in), t.element_in_cost, `paid price for element ${t.element_in}`);
  }
  const traded = transfers.filter(t => picks.picks.some(p => p.element === t.element_in));
  assert.ok(traded.length >= 4, 'the fixture must contain transfers into the current squad');
  assert.ok(
    traded.some(t => t.element_in_cost !== gameState.players.get(t.element_in).nowCost),
    'and at least one of them must have moved in price since, or this proves nothing',
  );
});

test('a player bought, sold and re-bought is priced at the LAST purchase', () => {
  // The bug this guards: taking the first (or the newest-listed) transfer
  // instead of the chronologically latest one silently prices a player at what
  // he cost months ago.
  const target = picks.picks[3].element;
  const now = gameState.players.get(target).nowCost;
  const log = [
    { element_in: target, element_in_cost: now - 10, element_out: 999, element_out_cost: 50, event: 2, time: '2026-08-28T11:00:00Z' },
    { element_in: 999, element_in_cost: 50, element_out: target, element_out_cost: now - 8, event: 3, time: '2026-09-04T11:00:00Z' },
    { element_in: target, element_in_cost: now - 3, element_out: 999, element_out_cost: 50, event: 4, time: '2026-09-11T11:00:00Z' },
  ];
  assert.equal(reconstructPurchasePrices({ picks, transfers: log, gameState }).get(target), now - 3);
  // Newest-first ordering (which is how FPL actually serves it) must not change the answer.
  assert.equal(reconstructPurchasePrices({ picks, transfers: log.slice().reverse(), gameState }).get(target), now - 3);
});

test('a player never transferred in falls back to his price when the squad was created', () => {
  const neverIn = picks.picks
    .map(p => p.element)
    .filter(id => !transfers.some(t => t.element_in === id));
  assert.ok(neverIn.length >= 3, 'the fixture squad must contain original picks');

  const prices = reconstructPurchasePrices({ picks, transfers, gameState });
  const moved = neverIn.filter(id => gameState.players.get(id).costChangeStart !== 0);
  assert.ok(moved.length >= 3, 'and some of them must have moved in price, or the fallback is untested');
  for (const id of neverIn) {
    const player = gameState.players.get(id);
    assert.equal(prices.get(id), player.nowCost - player.costChangeStart);
  }
});

// -------------------------------------------------------- selling prices ----

test('selling prices apply the sell-on fee to every held player', () => {
  for (const pick of squadState.picks) {
    const now = gameState.players.get(pick.playerId).nowCost;
    assert.equal(pick.sellingTenths, sellingPrice(pick.purchaseTenths, now, rules));
    assert.ok(pick.sellingTenths <= now);
  }
  // The whole point: a rising player is worth LESS than his listed price.
  const risen = squadState.picks.filter(p => gameState.players.get(p.playerId).nowCost > p.purchaseTenths);
  assert.ok(risen.length >= 3, 'fixture must contain players who have risen');
  assert.ok(
    risen.some(p => p.sellingTenths < gameState.players.get(p.playerId).nowCost),
    'and selling at now_cost would over-state the budget',
  );
  const fallen = squadState.picks.filter(p => gameState.players.get(p.playerId).nowCost < p.purchaseTenths);
  assert.ok(fallen.length >= 1, 'fixture must contain a player who has fallen');
  assert.ok(fallen.every(p => p.sellingTenths === gameState.players.get(p.playerId).nowCost));
});

test('the squad value invariant holds and no warning is raised', () => {
  const total = squadState.picks.reduce((s, p) => s + p.sellingTenths, 0);
  assert.equal(total + squadState.bankTenths, squadState.squadValueTenths);
  assert.deepEqual(squadState.warnings, []);
  assert.equal(squadState.bankTenths, picks.entry_history.bank);
  assert.equal(squadState.squadValueTenths, picks.entry_history.value);
});

test('a value mismatch surfaces as a warning instead of being absorbed', () => {
  // If the reconstruction is wrong the app would recommend transfers the
  // manager cannot afford. That has to be visible, and it must not throw.
  const broken = { ...picks, entry_history: { ...picks.entry_history, value: picks.entry_history.value + 5 } };
  const out = buildSquadState({ entry, history, transfers, picks: broken, gameState, gw: PLAN_GW });
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].code, 'value_mismatch');
  assert.match(out.warnings[0].message, /does not match/);
  assert.equal(out.picks.length, 15, 'the squad is still returned, just flagged');
});

// -------------------------------------------------------- free transfers ----

test('free transfers are replayed from history, never assumed', () => {
  // GW1 0 transfers (unlimited, before the first deadline), GW2 1, GW3 wildcard
  // (4 transfers, none charged against the bank), GW4 2, GW5 0.
  //
  //   into GW2 1, into GW3 1, into GW4 2, into GW5 1, into GW6 2
  //
  // The old answer here was 3, one too many, because the replay seeded a free
  // transfer BEFORE gameweek 1 and then handed out another for gameweek 2.
  assert.equal(computeFreeTransfers({ history, rules, upToGw: 6 }), 2);
  assert.equal(squadState.freeTransfers, 2);
  assert.notEqual(squadState.freeTransfers, 1, 'the naive answer would be wrong here');
});

test('unused transfers roll over and stop at the cap', () => {
  const quiet = { current: [], chips: [] };
  for (let gw = 1; gw <= 12; gw++) {
    quiet.current.push({ event: gw, event_transfers: 0, event_transfers_cost: 0 });
  }
  // One after the first deadline, then one more per gameweek left unspent.
  assert.equal(computeFreeTransfers({ history: quiet, rules, upToGw: 2 }), 1);
  assert.equal(computeFreeTransfers({ history: quiet, rules, upToGw: 5 }), 4);
  assert.equal(computeFreeTransfers({ history: quiet, rules, upToGw: 6 }), rules.maxFreeTransfers);
  assert.equal(computeFreeTransfers({ history: quiet, rules, upToGw: 13 }), rules.maxFreeTransfers);
});

test('a wildcard or free hit week does not spend banked transfers', () => {
  const base = [
    { event: 1, event_transfers: 0 },
    { event: 2, event_transfers: 0 },
    { event: 3, event_transfers: 7 },
  ];
  const withWildcard = { current: base, chips: [{ name: 'wildcard', event: 3 }] };
  const withFreeHit = { current: base, chips: [{ name: 'freehit', event: 3 }] };
  const withBenchBoost = { current: base, chips: [{ name: 'bboost', event: 3 }] };
  const noChip = { current: base, chips: [] };
  // 1 into GW2, 2 into GW3, and the chip week keeps those 2 and adds one.
  assert.equal(computeFreeTransfers({ history: withWildcard, rules, upToGw: 4 }), 3);
  assert.equal(computeFreeTransfers({ history: withFreeHit, rules, upToGw: 4 }), 3);
  // Bench boost is a team chip: it does not make transfers free.
  assert.equal(computeFreeTransfers({ history: withBenchBoost, rules, upToGw: 4 }), 1);
  assert.equal(computeFreeTransfers({ history: noChip, rules, upToGw: 4 }), 1);
});

test('taking hits cannot drive the free transfer count negative', () => {
  const hits = { current: [{ event: 1, event_transfers: 6, event_transfers_cost: 20 }], chips: [] };
  assert.equal(computeFreeTransfers({ history: hits, rules, upToGw: 2 }), 1);
});

test('a manager with no history is pre-season before GW1 and has one after it', () => {
  // Before the first deadline the answer is unlimited, and unlimited is not a
  // number the UI may print as a count.
  assert.equal(computeFreeTransfers({ history: { current: [], chips: [] }, rules, upToGw: 1 }), UNLIMITED);
  assert.ok(!Number.isFinite(computeFreeTransfers({ history: { current: [] }, rules, upToGw: 1 })));
  // Past it, with nothing to prove anything was banked, one is the floor.
  assert.equal(computeFreeTransfers({ history: {}, rules, upToGw: 4 }), 1);
});

test('a manager who joined late is replayed from his first gameweek', () => {
  // His first deadline is GW5's, so GW6 is his first single free transfer.
  const late = { current: [{ event: 5, event_transfers: 0 }, { event: 6, event_transfers: 0 }], chips: [] };
  assert.equal(computeFreeTransfers({ history: late, rules, upToGw: 6 }), 1);
  assert.equal(computeFreeTransfers({ history: late, rules, upToGw: 7 }), 2);
});

// -------------------------------------------------------- chips ------------

test('chips remaining respects both what was used and the half-season windows', () => {
  // The fixture manager played his wildcard in GW3.
  assert.deepEqual(chipsRemaining({ history, rules, gw: 6 }).sort(), ['3xc', 'bboost', 'freehit']);
  // The second-half wildcard is a different chip and becomes available at GW20.
  assert.deepEqual(chipsRemaining({ history, rules, gw: 20 }).sort(), ['3xc', 'bboost', 'freehit', 'wildcard']);
  // Neither wildcard nor free hit is playable in GW1 at all.
  assert.deepEqual(chipsRemaining({ history: { chips: [] }, rules, gw: 1 }).sort(), ['3xc', 'bboost']);
});

test('the squad state reports used and available chips together', () => {
  assert.deepEqual(squadState.chipsUsed, [{ name: 'wildcard', event: 3 }]);
  assert.deepEqual(squadState.chipsAvailable.sort(), ['3xc', 'bboost', 'freehit']);
});

// -------------------------------------------------------- squad state ------

test('the squad state carries the manager, the picks and the armbands', () => {
  assert.equal(squadState.entryId, entry.id);
  assert.equal(squadState.entryName, entry.name);
  assert.equal(squadState.managerName, 'Sam Whitfield');
  assert.equal(squadState.overallRank, entry.summary_overall_rank);
  assert.equal(squadState.totalPoints, entry.summary_overall_points);
  assert.equal(squadState.gw, PLAN_GW);
  assert.equal(squadState.source, 'picks');
  assert.equal(squadState.asOf, gameState.fetchedAt);

  assert.equal(squadState.picks.length, 15);
  assert.deepEqual(squadState.picks.map(p => p.slot), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(squadState.picks.filter(p => p.isCaptain).length, 1);
  assert.equal(squadState.picks.filter(p => p.isViceCaptain).length, 1);
  assert.equal(squadState.picks.filter(p => p.multiplier > 0).length, 11);
});

test('the squad is legal by the rules the squad state was built with', () => {
  const counts = {};
  const clubs = new Map();
  for (const pick of squadState.picks) {
    const player = gameState.players.get(pick.playerId);
    counts[player.position] = (counts[player.position] || 0) + 1;
    clubs.set(player.teamId, (clubs.get(player.teamId) || 0) + 1);
  }
  for (const pos of Object.values(rules.positions)) {
    assert.equal(counts[pos.id], pos.squadSelect, `${pos.short} count`);
  }
  assert.ok(Math.max(...clubs.values()) <= rules.clubLimit);
});

test('the bare picks array is accepted as well as the full payload', () => {
  const a = reconstructPurchasePrices({ picks, transfers, gameState });
  const b = reconstructPurchasePrices({ picks: picks.picks, transfers, gameState });
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

// -------------------------------------------------------- pre-season -------

test('pre-season with no picks produces a draft, not an error', () => {
  // Today `entry/{id}/event/{gw}/picks` 404s for every gameweek. That is the
  // normal state before GW1, and the app must route to a squad build.
  const preSeason = buildGameState(bootstrap, fixtures, { fetchedAt: '2026-08-10T12:00:00Z' });
  const draft = buildSquadState({
    entry, history: { current: [], chips: [] }, transfers: [], picks: null,
    gameState: preSeason,
  });
  assert.equal(draft.source, 'draft');
  assert.deepEqual(draft.picks, []);
  assert.equal(draft.gw, 1, 'it plans for the next gameweek');
  assert.equal(draft.bankTenths, rules.budgetTenths, 'the whole budget is unspent');
  // Unlimited, which is a state and not a number, and emphatically not the cap:
  // reporting `maxFreeTransfers` here told every pre-season manager he had five.
  assert.ok(isUnlimited(draft.transferState));
  assert.equal(draft.freeTransfers, UNLIMITED);
  assert.notEqual(draft.freeTransfers, rules.maxFreeTransfers);
  assert.deepEqual(draft.warnings, []);
  assert.deepEqual(draft.chipsAvailable.sort(), ['3xc', 'bboost']);
});

test('an explicit source label survives (sample and manual squads)', () => {
  const out = buildSquadState({ entry, history, transfers, picks, gameState, gw: PLAN_GW, source: 'sample' });
  assert.equal(out.source, 'sample');
});

// -------------------------------------------------------- sample data ------

test('the sample squad reconstructs cleanly through the same code path', () => {
  const sample = assembleSampleBundle({
    meta: read('..', 'data', 'sample', 'meta.json'),
    bootstrap: read('..', 'data', 'sample', 'bootstrap.json'),
    fixtures: read('..', 'data', 'sample', 'fixtures.json'),
    entry: read('..', 'data', 'sample', 'entry.json'),
    'entry-history': read('..', 'data', 'sample', 'entry-history.json'),
    'entry-transfers': read('..', 'data', 'sample', 'entry-transfers.json'),
    'entry-picks': read('..', 'data', 'sample', 'entry-picks.json'),
  });
  const s = buildGameState(sample.bootstrap, sample.fixtures, { fetchedAt: sample.fetchedAt });
  const state = buildSquadState({
    entry: sample.entry, history: sample.history, transfers: sample.transfers,
    picks: sample.picks, gameState: s, gw: sample.planEvent, source: 'sample',
  });

  assert.equal(state.source, 'sample');
  assert.deepEqual(state.warnings, [], 'the sample dataset must satisfy the value invariant');
  assert.equal(state.picks.length, 15);
  assert.equal(state.gw, 13);
  assert.equal(state.bankTenths, 7);
  assert.equal(state.freeTransfers, 2, 'rolled free transfers, not the trivial 1');
  assert.deepEqual(state.chipsUsed.map(c => c.name).sort(), ['bboost', 'wildcard']);
  assert.deepEqual(state.chipsAvailable.sort(), ['3xc', 'freehit']);

  const differing = state.picks.filter(p => p.purchaseTenths !== s.players.get(p.playerId).nowCost);
  assert.ok(differing.length >= 10, 'most of a GW12 squad was bought at a different price');
  assert.ok(state.picks.some(p => s.players.get(p.playerId).status !== 'a'), 'and someone is unavailable');
});
