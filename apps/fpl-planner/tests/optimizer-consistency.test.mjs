// The optimizer must not contradict itself.
//
// THE BUG THIS FILE EXISTS FOR. Pre-season the app showed a manager:
//
//     BUILD THIS OPENING 15 ......... 132.1 xP over 3 gameweeks
//     best squad containing Saka .... 132.7   "Saka would improve the recommendation"
//     best squad containing Haaland . 134.2   "Haaland would improve the recommendation"
//
// A squad containing a forced player is a squad. The set of legal squads
// containing him is a SUBSET of the set of all legal squads. So on one data
// snapshot, with one objective and one set of options,
//
//     value(best unconstrained squad) >= value(best squad containing X)
//
// must hold for every X, and it held for none of them. Nothing in a suite of
// several hundred passing assertions could see it, because every one of those
// assertions checked a single output in isolation: legal squad, inside budget,
// reproducible from a seed, better than random. All of those stayed true while
// the app told a manager its own recommendation was beatable.
//
// So this file tests a RELATION between two outputs rather than any one output.
//
// WHAT A FAILURE HERE MEANS. Either the two arms are not being measured on the
// same objective (the original cause: the builder maximized
// `squadHorizonValue`, which adds bench auto-substitution value and captains
// the highest projected starter, while everything the manager reads is
// `squadTrajectory`, which does neither), or the unconstrained search has
// missed a squad that a constrained search found, which means the search is
// weaker than the answer it prints.
//
// TOLERANCE. The builder is a heuristic, not a solver, so the invariant is
// asserted with an explicit numeric tolerance rather than exactly. It is stated
// in points of expected score over the horizon, it is small enough that no
// manager could act on it, and it is not a knob to be widened when a build
// regresses: a violation above it is a real defect in the search.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { buildSquad, SQUAD_BUILDER_DEFAULTS } from '../js/engine/squad-builder.js';
import { squadObjective } from '../js/engine/lineup.js';
import { squadTrajectory } from '../js/engine/chips.js';
import { counterfactual } from '../js/engine/counterfactual.js';
import { makeRng } from '../js/engine/ml.js';

// Discounted horizon points. A tenth of a point over three gameweeks is a
// hundredth of a gameweek's score for one player and is invisible in every
// number the app rounds to one decimal place.
const TOLERANCE = 0.1;

const here = dirname(fileURLToPath(import.meta.url));
const sampleFile = (name) => JSON.parse(readFileSync(join(here, '..', 'data', 'sample', `${name}.json`), 'utf8'));
const SAMPLE_NAMES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];

const bundle = assembleSampleBundle(Object.fromEntries(SAMPLE_NAMES.map(n => [n, sampleFile(n)])));
const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
const rules = gameState.rules;

const GW = bundle.planEvent;
const HORIZON = 3;
const DISCOUNT = 0.85;
const SEED = 1;

const strength = buildStrength(gameState, { asOfGw: GW - 1 });
const projections = buildProjections({ gameState, strength, gwFrom: GW, gwTo: GW + HORIZON - 1 });

const player = id => gameState.players.get(id);
const buyable = p => p.status !== 'u' && p.status !== 'n';

const BUILD = {
  projections, gameState, rules, gw: GW, horizon: HORIZON,
  budgetTenths: rules.budgetTenths,
  opts: { discount: DISCOUNT, seed: SEED },
};

// The objective, on the exact lineup model: what the app reports.
const value = squad => squadObjective(squad, projections, GW, rules, {
  gameState, horizon: HORIZON, discount: DISCOUNT, mode: 'exact',
}).total;

const unconstrained = buildSquad(BUILD);
const unconstrainedValue = value(unconstrained.squad);

const horizonXp = (id) => {
  let sum = 0;
  for (let k = 0; k < HORIZON; k++) {
    const row = projections.get(id, GW + k);
    if (row) sum += Math.pow(DISCOUNT, k) * row.xPoints;
  }
  return sum;
};

const excluded = [...gameState.players.values()]
  .filter(p => buyable(p) && !unconstrained.squad.includes(p.id))
  .sort((a, b) => horizonXp(b.id) - horizonXp(a.id) || a.id - b.id);

const clubCounts = new Map();
for (const id of unconstrained.squad) {
  const p = player(id);
  clubCounts.set(p.teamId, (clubCounts.get(p.teamId) || 0) + 1);
}

const byCost = (a, b) => b.nowCost - a.nowCost || a.id - b.id;
const take = (list, n) => list.slice(0, n).map(p => p.id);

// The classes a manager actually clicks on, each one a different reason the
// search could fail. A premium needs several coordinated downgrades to fit, a
// cheap enabler needs none, a player from a club already at three needs a
// player of a DIFFERENT position sold to make room, and a same-price
// alternative needs no money moved at all, so a failure to find it is a failure
// of the swap neighbourhood rather than of the budget repair.
const CLASSES = [
  ['premium forwards', take(excluded.filter(p => p.position === 4).sort(byCost), 2)],
  ['premium midfielders', take(excluded.filter(p => p.position === 3).sort(byCost), 2)],
  ['premium defenders', take(excluded.filter(p => p.position === 2).sort(byCost), 2)],
  ['goalkeepers', take(excluded.filter(p => p.position === 1), 2)],
  ['cheap enablers', take(excluded.slice().sort((a, b) => a.nowCost - b.nowCost || a.id - b.id), 2)],
  ['a club already at the limit', take(excluded.filter(p => (clubCounts.get(p.teamId) || 0) >= rules.clubLimit), 2)],
  ['same price as a player already picked', take(
    excluded.filter(p => unconstrained.squad.some(id => player(id).position === p.position && player(id).nowCost === p.nowCost)),
    2,
  )],
  // One change: he is affordable in place of a squad member of his position out
  // of the bank alone, so a single swap reaches him.
  ['reachable in one change', take(
    excluded.filter(p => unconstrained.squad.some(id => (
      player(id).position === p.position && p.nowCost - player(id).nowCost <= unconstrained.bankTenths
    ))),
    2,
  )],
  // Several coordinated changes: no single swap can pay for him, so the search
  // has to downgrade two or more other players before he fits. This is the case
  // a neighbourhood of single swaps provably cannot cross, because every
  // intermediate squad on the way is worse than the one it started from.
  ['needing several coordinated changes', take(
    excluded.filter(p => unconstrained.squad.every(id => (
      player(id).position !== p.position || p.nowCost - player(id).nowCost > unconstrained.bankTenths
    ))).sort(byCost),
    3,
  )],
];

/* --------------------------------------------------- one objective, not two */

test('the builder optimizes exactly the number the app reports', () => {
  // squadObjective (lineup.js) and squadTrajectory (chips.js) have to be the
  // same function of a squad. If they ever drift, the builder is back to
  // maximizing something nothing displays and the invariant below becomes
  // unprovable rather than merely false.
  const rng = makeRng(4242);
  const squads = [unconstrained.squad];
  for (let i = 0; i < 12; i++) {
    const squad = randomLegalSquad(rng);
    if (squad) squads.push(squad);
  }
  assert.ok(squads.length >= 8, 'the random baseline should produce squads to compare');

  for (const squad of squads) {
    for (const [horizon, discount] of [[3, 0.85], [1, 1], [5, 0.9]]) {
      const objective = squadObjective(squad, projections, GW, rules, {
        gameState, horizon, discount, mode: 'exact',
      }).total;
      const trajectory = squadTrajectory({
        squadIds: squad, projections, gameState, rules,
        gwFrom: GW, horizon, discount, opts: { seed: SEED },
      }).total;
      assert.equal(objective, trajectory, `objective ${objective} but the app reports ${trajectory}`);
    }
  }
});

test('buildSquad reports the exact objective of the squad it returns', () => {
  assert.ok(Math.abs(unconstrained.xPointsHorizon - unconstrainedValue) < 1e-9);
  const trajectory = squadTrajectory({
    squadIds: unconstrained.squad, projections, gameState, rules,
    gwFrom: GW, horizon: HORIZON, discount: DISCOUNT, opts: { seed: SEED },
  }).total;
  assert.ok(Math.abs(unconstrained.xPointsHorizon - trajectory) < 1e-9);
});

/* ------------------------------------------------- the invariant, by class */

for (const [label, ids] of CLASSES) {
  test(`forcing in ${label} never beats the unconstrained build`, (t) => {
    // Every class is a property of the squad the optimizer actually builds, so
    // a class can legitimately empty out when projections change (the club
    // limit only binds if the built squad holds three from one club). Skipping
    // visibly is honest; asserting would fail for a reason that has nothing to
    // do with the invariant under test.
    if (!ids.length) {
      t.skip(`the sample dataset offers no ${label} outside the built squad`);
      return;
    }
    for (const id of ids) {
      const forced = buildSquad({ ...BUILD, lockedIds: [id] });
      assert.ok(forced.squad.includes(id), `${player(id).webName} was not actually forced in`);
      const forcedValue = value(forced.squad);
      assert.ok(
        unconstrainedValue >= forcedValue - TOLERANCE,
        `forcing ${player(id).webName} in scored ${forcedValue.toFixed(4)} against an unconstrained ${unconstrainedValue.toFixed(4)}: `
        + `the unconstrained search missed a squad worth ${(forcedValue - unconstrainedValue).toFixed(4)} more`,
      );
    }
  });
}

test('the invariant holds for every one of the twenty best excluded players', () => {
  for (const p of excluded.slice(0, 20)) {
    const forced = buildSquad({ ...BUILD, lockedIds: [p.id] });
    const forcedValue = value(forced.squad);
    assert.ok(
      unconstrainedValue >= forcedValue - TOLERANCE,
      `forcing ${p.webName} in scored ${forcedValue.toFixed(4)} against an unconstrained ${unconstrainedValue.toFixed(4)}`,
    );
  }
});

/* ------------------------------------------------------ what a manager sees */

test('the counterfactual never says a squad beats the recommendation it is quoting', async () => {
  // End to end, through the module the manager's question actually reaches, on
  // a pre-season plan with no picks at all. Zero tolerance here, not TOLERANCE:
  // the numbers on the two rows are computed in one call from one snapshot, so
  // a contradiction between them is a bug in the presentation and not search
  // noise, whatever the search did.
  const squadState = buildSquadState({
    entry: null, history: null, transfers: null, picks: null, gameState, gw: GW, source: 'draft',
  });
  const planBundle = await buildPlan({ gameState, squadState, options: {} });
  const plan = planBundle.current;
  assert.equal(plan.squad.length, rules.squadSize);

  const targets = [...gameState.players.values()]
    .filter(p => buyable(p) && !plan.squad.includes(p.id))
    .sort((a, b) => horizonXp(b.id) - horizonXp(a.id) || a.id - b.id)
    .slice(0, 12);

  for (const p of targets) {
    const answer = counterfactual(p.id, { planBundle, gameState, rules, opts: {} });
    if (answer.verdict === 'impossible' || answer.verdict === 'stale') continue;

    const baselineRow = answer.rows.find(r => r.code === 'baseline_total');
    const altRow = answer.rows.find(r => r.code === 'alternative_total');
    assert.ok(baselineRow && altRow, `${p.webName} produced no comparison rows`);
    assert.ok(
      baselineRow.value >= altRow.value - 1e-9,
      `${p.webName}: the answer quotes a recommendation of ${baselineRow.value.toFixed(2)} beside a legal squad worth ${altRow.value.toFixed(2)}`,
    );
    assert.ok(
      answer.deltaHorizon <= 1e-9,
      `${p.webName}: deltaHorizon ${answer.deltaHorizon} says the recommendation is beatable`,
    );
    assert.notEqual(answer.headline, `${answer.name} would improve the recommendation.`);
  }
});

test('a stale recommendation is surfaced rather than quoted', async () => {
  // A plan built on a DIFFERENT horizon to the one the answer is asked for is
  // exactly how a stored recommendation goes stale in the app: the horizon is a
  // setting, and it can change after a plan is computed. The answer must not
  // present the old squad's number as the current best.
  const squadState = buildSquadState({
    entry: null, history: null, transfers: null, picks: null, gameState, gw: GW, source: 'draft',
  });
  const planBundle = await buildPlan({ gameState, squadState, options: {} });
  // Weak by CONSTRUCTION rather than by search budget: two of the cheapest
  // players in the game are locked in, so the result is worse than the free
  // build whatever the projections happen to be. Relying on a reduced search to
  // land somewhere worse made this test depend on the projection scale.
  const ballast = excluded.slice().sort((a, b) => a.nowCost - b.nowCost || a.id - b.id).slice(0, 2).map(p => p.id);
  const stale = buildSquad({
    ...BUILD,
    lockedIds: ballast,
    opts: { discount: DISCOUNT, seed: SEED, restarts: 1, perturbRounds: 0, challengers: 0, descentRounds: 1 },
  });
  assert.ok(value(stale.squad) < unconstrainedValue - TOLERANCE, 'the deliberately weak build should be beatable');

  const staleBundle = {
    ...planBundle,
    current: { ...planBundle.current, squad: stale.squad.slice(), xPointsHorizon: value(stale.squad) },
  };
  const target = excluded.find(p => !stale.squad.includes(p.id));
  assert.ok(target, 'the stale squad should not hold every good player');
  const answer = counterfactual(target.id, { planBundle: staleBundle, gameState, rules, opts: {} });

  assert.ok(answer.staleBaseline, 'a beaten recommendation must be flagged');
  assert.ok(answer.staleBaseline.delta > 0);
  assert.ok(
    answer.rows.some(r => r.code === 'stale_recommendation'),
    'the answer must carry a row saying the recommendation is out of date',
  );
  const baselineRow = answer.rows.find(r => r.code === 'baseline_total');
  assert.ok(
    baselineRow.value > answer.staleBaseline.storedTotal,
    'the quoted baseline must be the better squad, never the stale one',
  );
});

/* ---------------------------------------------------------------- and still */

test('the strengthened search is still deterministic from its seed', () => {
  const a = buildSquad({ ...BUILD, opts: { discount: DISCOUNT, seed: 4242 } });
  const b = buildSquad({ ...BUILD, opts: { discount: DISCOUNT, seed: 4242 } });
  assert.deepEqual(a.squad, b.squad);
  assert.equal(a.xPointsHorizon, b.xPointsHorizon);
  assert.equal(a.evaluations, b.evaluations);
});

test('the strengthened search still returns a legal, affordable fifteen', () => {
  const counts = new Map();
  const clubs = new Map();
  let cost = 0;
  for (const id of unconstrained.squad) {
    const p = player(id);
    counts.set(p.position, (counts.get(p.position) || 0) + 1);
    clubs.set(p.teamId, (clubs.get(p.teamId) || 0) + 1);
    cost += p.nowCost;
  }
  for (const position of Object.values(rules.positions)) {
    assert.equal(counts.get(position.id) || 0, position.squadSelect, `${position.short} count`);
  }
  for (const [teamId, n] of clubs) assert.ok(n <= rules.clubLimit, `club ${teamId} has ${n}`);
  assert.ok(cost <= rules.budgetTenths);
  assert.equal(unconstrained.costTenths, cost);
  assert.equal(new Set(unconstrained.squad).size, rules.squadSize);
  assert.ok(SQUAD_BUILDER_DEFAULTS.challengers > 0, 'the challenge pass is what closes the invariant');
});

// --- helpers ----------------------------------------------------------------

function randomLegalSquad(rng) {
  const clubs = new Map();
  const squad = [];
  let cost = 0;
  for (const position of Object.values(rules.positions)) {
    const pool = [...gameState.players.values()].filter(p => p.position === position.id && p.status === 'a');
    let taken = 0;
    let guard = 0;
    while (taken < position.squadSelect) {
      if (guard++ > 800) return null;
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
