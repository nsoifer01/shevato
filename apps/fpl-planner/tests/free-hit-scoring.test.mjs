// A Free Hit is scored as what FPL pays: one gameweek of the rented squad, then
// the squad the manager keeps.
//
// WHY THIS FILE EXISTS: until 2026-10-09 `scoreCandidate` scored the rented
// fifteen across the whole horizon. The chip's own evaluator (chips.js) and the
// future plan (`projectedSquadState`) both reverted the squad after one week;
// only the plan's own ranking number did not. On the sample with four held
// starters injured and three of the squad's clubs blanked, a Free Hit read
// 178.9 over five gameweeks against a true 125.0 (backend audit B1), and the
// Alternatives card showed the best transfer plan 54 points behind a plan it
// actually trailed by a fraction of a point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { squadTrajectory } from '../js/engine/chips.js';
import { validatePlan } from '../js/engine/validate.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(APP, p), 'utf8'));

function sampleWorld() {
  const files = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const b = assembleSampleBundle(Object.fromEntries(files.map(n => [n, read(`data/sample/${n}.json`)])));
  const gameState = buildGameState(b.bootstrap, b.fixtures, { fetchedAt: b.fetchedAt });
  const squadState = buildSquadState({
    entry: b.entry, history: b.history, transfers: b.transfers, picks: b.picks, gameState, gw: b.planEvent,
  });
  return { gameState, squadState };
}

// The audit's scenario: the four most expensive held outfielders ruled out with
// no return date, and the first three of the squad's clubs blanked this week.
function freeHitWorld({ injured = 4, blanked = 3 } = {}) {
  const { gameState: gs, squadState } = sampleWorld();
  const gw = squadState.gw;
  const held = squadState.picks.map(p => p.playerId);
  const players = new Map(gs.players);
  const outfield = held
    .filter(id => gs.players.get(id).position !== 1)
    .sort((a, b) => gs.players.get(b).nowCost - gs.players.get(a).nowCost);
  for (const id of outfield.slice(0, injured)) {
    players.set(id, { ...players.get(id), status: 'i', chanceNext: 0, news: 'Knee injury - Unknown return date' });
  }
  const clubs = [...new Set(held.map(id => gs.players.get(id).teamId))];
  const blank = new Set(clubs.slice(0, blanked));
  const fixtures = gs.fixtures.filter(f => !(f.event === gw && (blank.has(f.teamH) || blank.has(f.teamA))));
  return { gameState: { ...gs, players, fixtures }, squadState, gw, held };
}

const OPTIONS = { horizon: 5, seed: 7 };

// What FPL pays for a Free Hit over the horizon: the rented squad's week, then
// the kept squad's weeks at the plan's own discount.
function trueFreeHitHorizon({ bundle, gameState, gw, held, rented }) {
  const rules = gameState.rules;
  const discount = bundle.dataStatus.discount;
  const opts = { seed: OPTIONS.seed };
  const rent = squadTrajectory({ squadIds: rented, projections: bundle.projections, gameState, rules, gwFrom: gw, horizon: 1, discount, opts });
  const kept = squadTrajectory({ squadIds: held, projections: bundle.projections, gameState, rules, gwFrom: gw + 1, horizon: OPTIONS.horizon - 1, discount, opts });
  return rent.total + discount * kept.total;
}

test('B1: the recommended Free Hit is scored as one rented week plus the kept squad', async () => {
  const { gameState, squadState, gw, held } = freeHitWorld();
  const bundle = await buildPlan({ gameState, squadState, options: OPTIONS });
  assert.ok(bundle.chipEvaluation, 'chips are evaluated on the sample');
  assert.equal(bundle.chipEvaluation.perChip.freehit.recommended, true, 'the scenario is one where a Free Hit is on the table');
  assert.equal(bundle.current.chip, 'freehit', 'and the planner plays it');

  const rented = bundle.current.squad;
  const truth = trueFreeHitHorizon({ bundle, gameState, gw, held, rented });
  assert.ok(Math.abs(bundle.current.xPointsHorizon - truth) < 1e-9,
    `plan ${bundle.current.xPointsHorizon} vs rent-then-revert ${truth}`);

  // The defect, stated as a number: the rented squad over all five weeks.
  const wholeHorizon = squadTrajectory({
    squadIds: rented, projections: bundle.projections, gameState, rules: gameState.rules,
    gwFrom: gw, horizon: OPTIONS.horizon, discount: bundle.dataStatus.discount, opts: { seed: OPTIONS.seed },
  }).total;
  assert.ok(wholeHorizon > truth + 20, `the old number (${wholeHorizon}) overstated it by more than 20 points`);

  // Every alternative is measured against the honest number, so none of them
  // trails it by the phantom 54 points the defect produced.
  for (const alt of bundle.current.alternatives) {
    assert.ok(alt.deltaHorizon > -20, `${alt.headline}: ${alt.deltaHorizon}`);
  }
});

test('B1: the week after a Free Hit is planned from the squad the manager keeps', async () => {
  const { gameState, squadState, held } = freeHitWorld();
  const bundle = await buildPlan({ gameState, squadState, options: OPTIONS });
  assert.equal(bundle.current.chip, 'freehit');
  const next = bundle.future[0];
  assert.ok(next, 'a projected plan exists for the following gameweek');
  const keptAfterNextMoves = held.filter(id => !next.transfersOut.includes(id)).concat(next.transfersIn);
  assert.deepEqual([...next.squad].sort((a, b) => a - b), keptAfterNextMoves.sort((a, b) => a - b));
  assert.ok(!bundle.current.squad.every(id => next.squad.includes(id)), 'the rented squad is not carried forward');
});

test('B1: a Free Hit on a horizon of one is unchanged, and every other plan is scored as before', async () => {
  const { gameState, squadState, gw } = freeHitWorld();
  const bundle = await buildPlan({ gameState, squadState, options: { ...OPTIONS, horizon: 1 } });
  if (bundle.current.chip === 'freehit') {
    const one = squadTrajectory({
      squadIds: bundle.current.squad, projections: bundle.projections, gameState, rules: gameState.rules,
      gwFrom: gw, horizon: 1, discount: bundle.dataStatus.discount, opts: { seed: OPTIONS.seed },
    }).total;
    assert.ok(Math.abs(bundle.current.xPointsHorizon - one) < 1e-9);
  }
  // A plan with no Free Hit is its own squad's trajectory, untouched by the
  // Free Hit branch.
  const plainWorld = sampleWorld();
  const plain = await buildPlan({ gameState: plainWorld.gameState, squadState: plainWorld.squadState, options: OPTIONS });
  assert.notEqual(plain.current.chip, 'freehit');
  const t = squadTrajectory({
    squadIds: plain.current.squad, projections: plain.projections, gameState: plainWorld.gameState,
    rules: plainWorld.gameState.rules, gwFrom: plain.current.gw, horizon: OPTIONS.horizon,
    discount: plain.dataStatus.discount, opts: { seed: OPTIONS.seed },
  });
  const chipBonus = plain.current.chip === 'bboost' ? t.gws[0].xPointsBench : plain.current.chip === '3xc' ? t.gws[0].captainExtra : 0;
  assert.ok(Math.abs(plain.current.xPointsHorizon - (t.total + chipBonus - plain.current.hitCostPoints)) < 1e-9);
});

test('B1: the Free Hit plan and its revert both pass the legality gate', async () => {
  const { gameState, squadState } = freeHitWorld();
  const bundle = await buildPlan({ gameState, squadState, options: OPTIONS });
  const check = validatePlan(bundle.current, bundle.squadState, gameState, gameState.rules);
  assert.ok(check.ok, JSON.stringify(check.violations));
  assert.equal(bundle.current.hitCostPoints, 0, 'a Free Hit makes its transfers free');
});
