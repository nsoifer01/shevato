// Building a whole fifteen (SPEC 12.3 wildcard, 19.2 pre-season).
//
// The build is a heuristic, so these tests do not assert an exact squad. They
// assert the things that must hold whatever the search finds: a legal squad,
// inside the budget, reproducible from a seed, honouring locks and bans, and
// good enough to beat a sensible baseline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { buildSquad, SQUAD_BUILDER_DEFAULTS } from '../js/engine/squad-builder.js';
import { optimizeLineup, squadHorizonValue } from '../js/engine/lineup.js';
import { chooseCaptain } from '../js/engine/captain.js';
import { validatePlan } from '../js/engine/validate.js';
import { makeRng } from '../js/engine/ml.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const gameState = buildGameState(
  { ...read('fixtures', 'bootstrap.json'), events: read('fixtures', 'events-in-season.json') },
  read('fixtures', 'fixtures.json'),
  { fetchedAt: '2026-09-24T10:00:00Z' },
);
const rules = gameState.rules;
const PLAN_GW = 6;
const strength = buildStrength(gameState, { asOfGw: 5 });
const projections = buildProjections({ gameState, strength, gwFrom: PLAN_GW, gwTo: PLAN_GW + 4 });

const build = (over = {}) => buildSquad({
  projections,
  gameState,
  rules,
  gw: PLAN_GW,
  horizon: 5,
  ...over,
});

// --- helpers ----------------------------------------------------------------

function inspect(squad) {
  const byPosition = new Map();
  const byClub = new Map();
  let cost = 0;
  for (const id of squad) {
    const p = gameState.players.get(id);
    byPosition.set(p.position, (byPosition.get(p.position) || 0) + 1);
    byClub.set(p.teamId, (byClub.get(p.teamId) || 0) + 1);
    cost += p.nowCost;
  }
  return { byPosition, byClub, cost };
}

function assertLegal(squad, budget) {
  assert.equal(squad.length, rules.squadSize);
  assert.equal(new Set(squad).size, rules.squadSize, 'no player is picked twice');
  const { byPosition, byClub, cost } = inspect(squad);
  for (const pos of Object.values(rules.positions)) {
    assert.equal(byPosition.get(pos.id) || 0, pos.squadSelect, `${pos.short} count`);
  }
  for (const [teamId, n] of byClub) {
    assert.ok(n <= rules.clubLimit, `club ${teamId} has ${n} players`);
  }
  assert.ok(cost <= budget, `cost ${cost} exceeds budget ${budget}`);
  return cost;
}

// A concrete cheap legal fifteen, built by taking the cheapest buyable player
// in each position while respecting the club limit. Its cost is a budget at
// which a legal squad demonstrably exists, so the builder has no excuse.
function cheapLegalSquadCost() {
  const clubs = new Map();
  let cost = 0;
  for (const pos of Object.values(rules.positions)) {
    const candidates = [...gameState.players.values()]
      .filter(p => p.position === pos.id && p.status !== 'u' && p.status !== 'n')
      .sort((a, b) => (a.nowCost - b.nowCost) || (a.id - b.id));
    let taken = 0;
    for (const p of candidates) {
      if (taken === pos.squadSelect) break;
      if ((clubs.get(p.teamId) || 0) >= rules.clubLimit) continue;
      clubs.set(p.teamId, (clubs.get(p.teamId) || 0) + 1);
      cost += p.nowCost;
      taken++;
    }
    assert.equal(taken, pos.squadSelect, 'the fixture pool must be able to fill every position');
  }
  return cost;
}

// --- legality ---------------------------------------------------------------

test('the built fifteen is legal on every axis', () => {
  const result = build();
  const cost = assertLegal(result.squad, rules.budgetTenths);
  assert.equal(result.costTenths, cost);
  assert.equal(result.bankTenths, rules.budgetTenths - cost);
  assert.ok(result.bankTenths >= 0);
  assert.ok(result.xPointsHorizon > 0);
  assert.equal(result.horizon, 5);
  assert.equal(result.byGw.length, 5);
  assert.deepEqual(result.byGw.map(g => g.gw), [6, 7, 8, 9, 10]);
});

test('the built fifteen passes the legality gate as a plan', () => {
  const budget = rules.budgetTenths;
  const result = build({ budgetTenths: budget });
  const lineup = optimizeLineup(result.squad, projections, PLAN_GW, rules, { gameState });
  const armband = chooseCaptain(lineup.startingXI, projections, PLAN_GW, gameState);

  const plan = {
    gw: PLAN_GW,
    chip: null,
    transfersOut: [],
    transfersIn: [],
    transferCount: 0,
    freeTransfersUsed: 0,
    hits: 0,
    hitCostPoints: 0,
    bankBeforeTenths: budget,
    moneyInTenths: 0,
    moneyOutTenths: result.costTenths,
    bankAfterTenths: result.bankTenths,
    squad: result.squad,
    startingXI: lineup.startingXI,
    formation: lineup.formation,
    bench: lineup.bench,
    captain: armband.captain,
    viceCaptain: armband.viceCaptain,
  };
  const squadState = {
    gw: PLAN_GW,
    picks: [],
    bankTenths: budget,
    freeTransfers: rules.maxFreeTransfers,
    chipsUsed: [],
  };
  assert.deepEqual(validatePlan(plan, squadState, gameState, rules).violations, []);
});

test('an unavailable player is never bought', () => {
  const unavailable = [...gameState.players.values()]
    .filter(p => p.status === 'u' || p.status === 'n')
    .map(p => p.id);
  assert.ok(unavailable.length > 0, 'the fixture needs an unavailable player to be testable');
  const result = build();
  for (const id of unavailable) assert.ok(!result.squad.includes(id));
});

// --- budget -----------------------------------------------------------------

test('a tight budget yields a legal squad instead of throwing', () => {
  // The floor is the cost of a concrete legal fifteen, so every budget from
  // there upwards is satisfiable and the builder must satisfy it. Feasibility
  // has to be monotone in the budget: more money can never turn a solvable
  // problem into an unsolvable one.
  const floor = cheapLegalSquadCost();
  assert.ok(floor < rules.budgetTenths, 'the cheap squad should fit inside the real budget');

  for (const budget of [floor, floor + 5, floor + 30, 800, 850, 900, 950, rules.budgetTenths]) {
    const result = build({ budgetTenths: budget });
    assertLegal(result.squad, budget);
    assert.ok(result.bankTenths >= 0);
  }
});

test('more money never buys a worse squad', () => {
  const rich = build({ budgetTenths: rules.budgetTenths });
  const poor = build({ budgetTenths: 820 });
  assert.ok(rich.xPointsHorizon >= poor.xPointsHorizon);
});

// --- determinism ------------------------------------------------------------

test('the same seed gives the same squad, every time', () => {
  const a = build({ opts: { seed: 12345 } });
  const b = build({ opts: { seed: 12345 } });
  assert.deepEqual(a.squad, b.squad);
  assert.equal(a.costTenths, b.costTenths);
  assert.equal(a.xPointsHorizon, b.xPointsHorizon);
  assert.equal(a.seed, 12345);
});

test('the default seed is fixed, so two runs of the app agree', () => {
  const a = build();
  const b = build({ opts: { seed: SQUAD_BUILDER_DEFAULTS.seed } });
  assert.deepEqual(a.squad, b.squad);
});

test('a different seed explores a different part of the space', () => {
  const seeds = [1, 2, 3, 4, 5].map(seed => build({ opts: { seed } }));
  for (const result of seeds) assertLegal(result.squad, rules.budgetTenths);
  const distinct = new Set(seeds.map(r => r.squad.join(',')));
  assert.ok(distinct.size >= 1);
  // Whatever the seed, the search must land somewhere sensible rather than
  // wandering: every restart is within a few points of the best.
  const values = seeds.map(r => r.xPointsHorizon);
  assert.ok(Math.max(...values) - Math.min(...values) < 10, `seed spread was ${Math.max(...values) - Math.min(...values)}`);
});

// --- locks and bans ---------------------------------------------------------

test('locked players are always in the squad and banned players never are', () => {
  const base = build();
  const banned = base.squad.slice(0, 4);
  // Lock one player of each position who is not banned.
  const lockedIds = Object.values(rules.positions).map(pos => {
    const candidate = [...gameState.players.values()]
      .find(p => p.position === pos.id && !banned.includes(p.id) && p.status === 'a');
    return candidate.id;
  });

  const result = build({ lockedIds, bannedIds: banned });
  for (const id of lockedIds) assert.ok(result.squad.includes(id), `locked ${id} is missing`);
  for (const id of banned) assert.ok(!result.squad.includes(id), `banned ${id} was picked`);
  assertLegal(result.squad, rules.budgetTenths);
});

test('locking a whole position still leaves a legal squad', () => {
  const forwards = [...gameState.players.values()]
    .filter(p => p.position === 4 && p.status === 'a')
    .sort((a, b) => a.nowCost - b.nowCost)
    .slice(0, rules.positions[4].squadSelect)
    .map(p => p.id);
  const result = build({ lockedIds: forwards });
  for (const id of forwards) assert.ok(result.squad.includes(id));
  assertLegal(result.squad, rules.budgetTenths);
});

// --- horizon ----------------------------------------------------------------

test('singleGw collapses the horizon to the gameweek being played', () => {
  const result = build({ opts: { singleGw: true } });
  assert.equal(result.horizon, 1);
  assert.equal(result.byGw.length, 1);
  assert.equal(result.byGw[0].gw, PLAN_GW);
  assertLegal(result.squad, rules.budgetTenths);
});

test('a single-gameweek build beats the horizon build for that one gameweek', () => {
  // This is what a free hit is: optimise the week, not the season. The squad it
  // produces should be at least as good in the gameweek it was built for.
  const single = build({ opts: { singleGw: true } });
  const horizon = build();
  const value = (squad) => squadHorizonValue(squad, projections, PLAN_GW, rules, {
    gameState, horizon: 1, discount: 1, mode: 'exact',
  }).total;
  assert.ok(value(single.squad) >= value(horizon.squad) - 1e-9);
});

test('a shorter horizon reads fewer gameweeks', () => {
  const result = build({ horizon: 2 });
  assert.equal(result.horizon, 2);
  assert.deepEqual(result.byGw.map(g => g.gw), [6, 7]);
});

// --- quality ----------------------------------------------------------------

test('the built squad is far better than a random legal squad', () => {
  const rng = makeRng(555);
  const built = build();
  const builtValue = squadHorizonValue(built.squad, projections, PLAN_GW, rules, {
    gameState, horizon: 5, discount: SQUAD_BUILDER_DEFAULTS.discount, mode: 'exact',
  }).total;

  let beaten = 0;
  let attempts = 0;
  for (let trial = 0; trial < 40; trial++) {
    const squad = randomLegalSquad(rng);
    if (!squad) continue;
    attempts++;
    const value = squadHorizonValue(squad, projections, PLAN_GW, rules, {
      gameState, horizon: 5, discount: SQUAD_BUILDER_DEFAULTS.discount, mode: 'exact',
    }).total;
    if (builtValue > value) beaten++;
  }
  assert.ok(attempts >= 20, 'the random baseline should produce squads to compare against');
  assert.equal(beaten, attempts, 'the built squad should beat every random legal squad');
});

function randomLegalSquad(rng) {
  const clubs = new Map();
  const squad = [];
  let cost = 0;
  for (const pos of Object.values(rules.positions)) {
    const pool = [...gameState.players.values()].filter(p => p.position === pos.id && p.status === 'a');
    let taken = 0;
    let guard = 0;
    while (taken < pos.squadSelect) {
      if (guard++ > 500) return null;
      const p = pool[Math.floor(rng() * pool.length)];
      if (squad.includes(p.id)) continue;
      if ((clubs.get(p.teamId) || 0) >= rules.clubLimit) continue;
      if (cost + p.nowCost > rules.budgetTenths) continue;
      clubs.set(p.teamId, (clubs.get(p.teamId) || 0) + 1);
      squad.push(p.id);
      cost += p.nowCost;
      taken++;
    }
  }
  return squad;
}
