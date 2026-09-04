// Free Hit: the squad reverts, and the planner must revert with it.
//
// WHY THIS FILE EXISTS: a Free Hit team exists for ONE gameweek. At the next
// deadline Fantasy Premier League hands back the squad the manager had at the
// start of the gameweek he played the chip in, and the transfers made under it
// are discarded with it. `entry/{id}/event/{fhGw}/picks/` therefore returns a
// RENTED fifteen, and until this round the planner read those picks as the
// squad the manager owns and planned the NEXT gameweek from them. Reproduced
// against the live payloads: the plan sold two players the manager did not own,
// kept six more, and validatePlan against his real squad returned eight
// violations. Nothing in the suite could see it, because no test in
// apps/fpl-planner/tests mentioned `active_chip` at all.
//
// The chip is detected from the picks payload's own `active_chip` OR from
// `history.chips`, because a stored or re-imported squad may carry one and not
// the other, and the revert has to behave identically on a fresh load, a forced
// refresh and a restored session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import {
  buildSquadState, reconstructPurchasePrices, freeHitGameweeks, freeHitPicksInfo,
} from '../js/engine/squad.js';
import { assessReadiness } from '../js/engine/readiness.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const bootstrap = read('fixtures', 'bootstrap.json');
const fixtures = read('fixtures', 'fixtures.json');
const eventsInSeason = read('fixtures', 'events-in-season.json');
const entry = read('fixtures', 'entry.json');
const baseHistory = read('fixtures', 'entry-history.json');
const transfers = read('fixtures', 'entry-transfers.json');
const basePicks = read('fixtures', 'entry-picks.json');

const gameState = buildGameState({ ...bootstrap, events: eventsInSeason }, fixtures, { fetchedAt: '2026-09-24T10:00:00Z' });

// The fixture's frozen gameweek is 5; the manager plans 6.
const FH_GW = 5;
const PLAN_GW = 6;

/**
 * The rented fifteen: the frozen picks with six players swapped for others the
 * manager never owned, keeping the squad legal (a real Free Hit team always
 * respects the 3-per-club limit, and an illegal one makes the planner refuse
 * for an unrelated reason).
 */
function rentedPicks() {
  const fh = clone(basePicks);
  fh.active_chip = 'freehit';
  const owned = new Set(fh.picks.map(p => p.element));
  const clubs = new Map();
  for (const p of fh.picks) {
    const t = gameState.players.get(p.element).teamId;
    clubs.set(t, (clubs.get(t) || 0) + 1);
  }
  const pool = [...gameState.players.values()].filter(p => !owned.has(p.id));
  let swapped = 0;
  for (const pick of fh.picks) {
    if (swapped >= 6) break;
    const me = gameState.players.get(pick.element);
    const alt = pool.find(p => p.position === me.position
      && p.teamId !== me.teamId && !owned.has(p.id) && (clubs.get(p.teamId) || 0) < 3);
    if (!alt) continue;
    clubs.set(me.teamId, clubs.get(me.teamId) - 1);
    clubs.set(alt.teamId, (clubs.get(alt.teamId) || 0) + 1);
    owned.add(alt.id);
    pick.element = alt.id;
    swapped++;
  }
  assert.equal(swapped, 6, 'the fixture must actually rent six players');
  return fh;
}

/** The squad the chip reverts TO: the gameweek before the Free Hit. */
function priorPicks() {
  const prior = clone(basePicks);
  prior.active_chip = null;
  prior.entry_history = { ...prior.entry_history, event: FH_GW - 1 };
  return prior;
}

const historyWithFreeHit = (() => {
  const h = clone(baseHistory);
  h.chips = [...(h.chips || []), { name: 'freehit', time: '2026-09-19T10:00:00Z', event: FH_GW }];
  return h;
})();

const ids = (state) => state.picks.map(p => p.playerId).sort((a, b) => a - b);

// ---------------------------------------------------------------- detection

test('a Free Hit is detected from the picks payload and from the history alike', () => {
  const fh = rentedPicks();
  // Payload only: a squad snapshot restored from storage may have kept
  // `active_chip` while its history was refetched without the chip row yet.
  assert.deepEqual(freeHitPicksInfo({ picks: fh, history: baseHistory }),
    { isFreeHit: true, event: FH_GW });
  // History only: the durable record, which is what survives a re-import.
  const noChipOnPayload = clone(fh);
  noChipOnPayload.active_chip = null;
  assert.deepEqual(freeHitPicksInfo({ picks: noChipOnPayload, history: historyWithFreeHit }),
    { isFreeHit: true, event: FH_GW });
  // Neither: an ordinary gameweek.
  assert.deepEqual(freeHitPicksInfo({ picks: basePicks, history: baseHistory }),
    { isFreeHit: false, event: FH_GW });
  assert.deepEqual([...freeHitGameweeks({ history: historyWithFreeHit })], [FH_GW]);
  assert.deepEqual([...freeHitGameweeks({ history: baseHistory })], [],
    'a wildcard is not a free hit');
});

// ------------------------------------------------------------- the revert

test('planning after a Free Hit uses the squad the chip reverts to, not the rented one', () => {
  const fh = rentedPicks();
  const prior = priorPicks();

  const reverted = buildSquadState({
    entry, history: historyWithFreeHit, transfers,
    picks: fh, revertPicks: prior, gameState, gw: PLAN_GW,
  });

  assert.deepEqual(ids(reverted), ids(buildSquadState({
    entry, history: baseHistory, transfers, picks: prior, gameState, gw: PLAN_GW,
  })), 'the fifteen must be the persistent squad');

  const rentedIds = new Set(fh.picks.map(p => p.element));
  const priorIds = new Set(prior.picks.map(p => p.element));
  const held = new Set(ids(reverted));
  const rentedOnly = [...rentedIds].filter(id => !priorIds.has(id));
  assert.equal(rentedOnly.length, 6, 'sanity: the rented team really does differ');
  for (const id of rentedOnly) {
    assert.ok(!held.has(id), `player ${id} was only rented and must not be planned with`);
  }

  assert.equal(reverted.freeHitGw, FH_GW);
  assert.equal(reverted.freeHitUnresolved, false);
  assert.ok(reverted.warnings.some(w => w.code === 'free_hit_reverted'),
    'the manager must be told which fifteen he is looking at');
  assert.ok(!reverted.warnings.some(w => w.code === 'free_hit_squad'));
});

test('the money reverts with the squad', () => {
  // Bank and squad value must come from the picks the FIFTEEN came from.
  // Pairing the rented team's money with the real team's players is a wrong
  // number in every affordability figure downstream.
  const fh = rentedPicks();
  fh.entry_history = { ...fh.entry_history, bank: 7, value: 871 };
  const prior = priorPicks();
  prior.entry_history = { ...prior.entry_history, bank: 12, value: 999 };

  const reverted = buildSquadState({
    entry, history: historyWithFreeHit, transfers,
    picks: fh, revertPicks: prior, gameState, gw: PLAN_GW,
  });
  const straight = buildSquadState({
    entry, history: baseHistory, transfers, picks: prior, gameState, gw: PLAN_GW,
  });

  assert.equal(reverted.bankTenths, straight.bankTenths);
  assert.equal(reverted.squadValueTenths, straight.squadValueTenths);
  assert.notEqual(reverted.bankTenths, 7, 'the rented bank must not survive the revert');
});

test('transfers made under the Free Hit do not re-price the persistent squad', () => {
  // A Free Hit transfer is undone with the team, so its `element_in_cost` says
  // nothing about what the manager paid for a player he actually owns. It bites
  // when the same player is both owned and rented.
  const held = basePicks.picks[3].element;
  const fhTransfer = {
    element_in: held, element_in_cost: 999, element_out: 1, element_out_cost: 50,
    event: FH_GW, time: '2026-09-19T11:00:00Z',
  };
  const withFh = [...transfers, fhTransfer];

  const naive = reconstructPurchasePrices({ picks: basePicks, transfers: withFh, gameState });
  assert.equal(naive.get(held), 999, 'sanity: without the filter the rented price wins');

  const correct = reconstructPurchasePrices({
    picks: basePicks, transfers: withFh, gameState,
    ignoreGws: freeHitGameweeks({ history: historyWithFreeHit }),
  });
  assert.notEqual(correct.get(held), 999,
    'a price paid under a Free Hit must not become the purchase price of an owned player');

  const baseline = reconstructPurchasePrices({ picks: basePicks, transfers, gameState });
  assert.equal(correct.get(held), baseline.get(held),
    'and the reconstruction must otherwise be unchanged');
});

// ------------------------------------------------- when the revert is missing

test('without the reverted squad the state says so and no advice is given', () => {
  const fh = rentedPicks();
  const unresolved = buildSquadState({
    entry, history: historyWithFreeHit, transfers,
    picks: fh, revertPicks: null, gameState, gw: PLAN_GW,
  });

  assert.equal(unresolved.freeHitUnresolved, true);
  assert.equal(unresolved.freeHitGw, FH_GW);
  assert.ok(unresolved.warnings.some(w => w.code === 'free_hit_squad'));

  const readiness = assessReadiness({
    evidence: { usable: true },
    lifecycle: { phase: 'season' },
    squad: { historyMissing: false, freeHitUnresolved: true, freeHitGw: FH_GW },
  });
  assert.equal(readiness.allow.transfers, false,
    'a squad the manager does not keep must not be transferred from');
  assert.equal(readiness.allow.chips, false);
  assert.equal(readiness.allow.lineup, true, 'the eleven can still be ordered for the week');
  assert.ok(readiness.blocked.some(b => b.code === 'free_hit_squad'));
});

test('readiness is unaffected when there is no unresolved Free Hit', () => {
  // The control: a guard that always blocked would pass the test above.
  const readiness = assessReadiness({
    evidence: { usable: true },
    lifecycle: { phase: 'season' },
    squad: { historyMissing: false, freeHitUnresolved: false, freeHitGw: null },
  });
  assert.equal(readiness.allow.transfers, true);
  assert.ok(!readiness.blocked.some(b => b.code === 'free_hit_squad'));
});

// ----------------------------------------------------------- the boundaries

test('the Free Hit gameweek ITSELF still plans with the team that plays in it', () => {
  // The chip has not expired while its own gameweek is the one being planned
  // (the season-over case, where there is no next event). Reverting there would
  // show the wrong team for the week actually being played.
  const fh = rentedPicks();
  const sameGw = buildSquadState({
    entry, history: historyWithFreeHit, transfers,
    picks: fh, revertPicks: priorPicks(), gameState, gw: FH_GW,
  });
  assert.equal(sameGw.freeHitGw, null, 'nothing to revert yet');
  assert.equal(sameGw.freeHitUnresolved, false);
  assert.ok(!sameGw.warnings.some(w => w.code.startsWith('free_hit')));

  const rentedIds = new Set(fh.picks.map(p => p.element));
  const heldFromRented = ids(sameGw).filter(id => rentedIds.has(id)).length;
  assert.ok(heldFromRented >= 13,
    `the rented fifteen is the right squad for its own gameweek, held ${heldFromRented}`);
});

test('a Free Hit in an older gameweek does not touch a later ordinary squad', () => {
  // FH in GW5, and the frozen picks now being read are GW7's own, ordinary
  // team. Nothing should revert.
  const later = clone(basePicks);
  later.entry_history = { ...later.entry_history, event: 7 };
  const state = buildSquadState({
    entry, history: historyWithFreeHit, transfers,
    picks: later, revertPicks: null, gameState, gw: 8,
  });
  assert.equal(state.freeHitGw, null);
  assert.equal(state.freeHitUnresolved, false);
  assert.ok(!state.warnings.some(w => w.code.startsWith('free_hit')));
});

test('a wildcard is not reverted: that squad is the one the manager keeps', () => {
  // The fixture's own history holds a wildcard at GW3. A wildcard rebuilds the
  // PERMANENT squad, so nothing about it may trigger the Free Hit path; this is
  // the regression guard for the other chips.
  const wc = clone(basePicks);
  wc.active_chip = 'wildcard';
  const state = buildSquadState({
    entry, history: baseHistory, transfers, picks: wc, revertPicks: priorPicks(),
    gameState, gw: PLAN_GW,
  });
  assert.equal(state.freeHitGw, null);
  assert.equal(state.freeHitUnresolved, false);
  assert.ok(!state.warnings.some(w => w.code.startsWith('free_hit')));
  assert.deepEqual(ids(state), ids(buildSquadState({
    entry, history: baseHistory, transfers, picks: basePicks, gameState, gw: PLAN_GW,
  })), 'a wildcard week keeps its own fifteen');
});

test('the free-transfer arithmetic still treats the Free Hit week as free', () => {
  // replayTransferState already reads history.chips, so the revert must not
  // disturb it: a Free Hit consumes no free transfer and the manager arrives at
  // the next gameweek with what he banked.
  const fh = rentedPicks();
  const reverted = buildSquadState({
    entry, history: historyWithFreeHit, transfers,
    picks: fh, revertPicks: priorPicks(), gameState, gw: PLAN_GW,
  });
  const withoutChip = buildSquadState({
    entry, history: baseHistory, transfers, picks: priorPicks(), gameState, gw: PLAN_GW,
  });
  assert.equal(
    reverted.freeTransfers, withoutChip.freeTransfers,
    'playing a Free Hit must not cost a free transfer'
  );
  assert.ok(reverted.chipsUsed.some(c => c.name === 'freehit' && c.event === FH_GW));
  assert.ok(!reverted.chipsAvailable.includes('freehit'),
    'and the chip is spent, so it may not be offered again');
});
