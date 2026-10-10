// "Why not this player?" against the planner as it now searches: routes as
// deep as the planner's own transfer search, and timing chips valued the way
// the planner values them.
//
// WHY THIS EXISTS. Until 2026-10-09 the comparison enumerated routes of at most
// two moves while the planner (from the same date) plays up to five free
// transfers, so with three free transfers "the best plan containing him" was a
// two-move route set against a three-move recommendation, and the gap it quoted
// was the third free move, not the player. And under a Bench Boost plan every
// scenario was credited the chip's RAW bench points, while the planner credits
// its NET value (what it adds now minus what keeping it is worth) and only on a
// squad its own decision would boost, so the two could rank squads differently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan, scoreCandidate, resolveOptions } from '../js/engine/planner.js';
import { counterfactual, scoreRoute } from '../js/engine/counterfactual.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (n) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${n}.json`), 'utf8'));
const NAMES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const B = assembleSampleBundle(Object.fromEntries(NAMES.map(n => [n, sample(n)])));
const gameState = buildGameState(B.bootstrap, B.fixtures, { fetchedAt: B.fetchedAt });
const rules = gameState.rules;
const squadState = buildSquadState({
  entry: B.entry, history: B.history, transfers: B.transfers, picks: B.picks, gameState, gw: B.planEvent,
});
const withFt = (state, ft, extra = {}) => ({
  ...state, ...extra, transferState: { phase: 'season', gw: state.gw, banked: ft }, freeTransfers: ft,
});

function legal(squad, state) {
  const counts = new Map();
  const clubs = new Map();
  for (const id of squad) {
    const p = gameState.players.get(id);
    counts.set(p.position, (counts.get(p.position) || 0) + 1);
    clubs.set(p.teamId, (clubs.get(p.teamId) || 0) + 1);
  }
  if (new Set(squad).size !== rules.squadSize) return false;
  if ([...clubs.values()].some(n => n > rules.clubLimit)) return false;
  return Object.values(rules.positions).every(pos => counts.get(pos.id) === pos.squadSelect) && !!state;
}

test('with three free transfers a route of three moves is offered, legal, and beats the two-move cap', async () => {
  const bundle = await buildPlan({ gameState, squadState: withFt(squadState, 3), options: { horizon: 5, seed: 7 } });
  assert.equal(bundle.current.transferCount, 3, 'the planner itself spends all three');
  // The same plan, asked as if routes stopped at two (the pre-2026-10-09 cap).
  const capped = { ...bundle, planOptions: { ...bundle.planOptions, transferOptions: { maxTransfers: 2 } } };

  const asked = [...gameState.players.values()]
    .filter(p => p.status === 'a' && !bundle.current.squad.includes(p.id))
    .sort((a, b) => (b.nowCost - a.nowCost) || (a.id - b.id))
    .filter((_, i) => i % 9 === 0)
    .slice(0, 8);
  let deeper = 0;
  for (const p of asked) {
    const now = counterfactual(p.id, { planBundle: bundle, gameState, rules });
    const old = counterfactual(p.id, { planBundle: capped, gameState, rules });
    if (now.mode !== 'transfer' || old.mode !== 'transfer') continue;
    // More routes can only find a better one for him, never a worse one.
    assert.ok(now.overall.best.points >= old.overall.best.points - 1e-9, p.webName);
    if (now.transfers >= 3 && now.overall.best.points > old.overall.best.points + 1e-6) {
      deeper++;
      assert.ok(now.squad.includes(p.id));
      assert.ok(legal(now.squad, bundle.squadState), `${p.webName}: a legal fifteen`);
      assert.ok(now.bankTenths >= 0, `${p.webName}: affordable`);
      assert.equal(now.hitPoints, 0, 'inside the free transfers');
    }
  }
  assert.ok(deeper >= 1, 'at least one answer is a route the two-move cap could not reach');
});

// A Bench Boost the planner plays on its own decision ("play", not the last
// week of the window), so the chip's net value is well below its raw bench.
// The sample's bench carries players unlikely to appear, so their projections
// are raised to a playing bench; the plan is built ON those projections.
async function benchBoostBundle() {
  const used = [{ name: 'wildcard', event: 7 }, { name: '3xc', event: 5 }, { name: 'freehit', event: 3 }];
  const state = withFt(squadState, 1, { chipsUsed: used });
  const first = await buildPlan({ gameState, squadState: state, options: { horizon: 5, seed: 7 } });
  const projections = first.projections;
  const unusable = first.chipEvaluation.perChip.bboost.detail.unusable;
  for (const id of unusable) {
    for (let g = state.gw; g < state.gw + 5; g++) {
      const row = projections.get(id, g);
      if (row) {
        row.pAppear = 0.95;
        row.xPoints = 2.5;
      }
    }
  }
  return buildPlan({ gameState, squadState: state, options: { horizon: 5, seed: 7, projections } });
}

test('under a Bench Boost plan every scenario is valued exactly as the planner ranked it', async () => {
  const bundle = await benchBoostBundle();
  const plan = bundle.current;
  assert.equal(plan.chip, 'bboost', 'the fixture really plays the chip');
  const entry = bundle.chipEvaluation.perChip.bboost;
  assert.ok(entry.netValue < entry.valueNow - 1, 'net well below raw, or the test proves nothing');

  // The recommended plan: the planner's no-chip objective plus the chip's NET
  // value, not its raw bench.
  const cfg = resolveOptions(bundle.planOptions, rules, plan.gw);
  const noChip = scoreCandidate({
    candidate: { transfersOut: plan.transfersOut, transfersIn: plan.transfersIn, squad: plan.squad },
    chip: null, squadState: bundle.squadState, projections: bundle.projections, gameState, rules, cfg, gw: plan.gw,
  });
  const rec = scoreRoute(plan, { planBundle: bundle, gameState, rules });
  assert.equal(rec.chip, 'bboost');
  assert.ok(Math.abs(rec.objective - (noChip.objective + entry.netValue)) < 1e-9,
    `${rec.objective} against ${noChip.objective} + ${entry.netValue}`);
  assert.ok(Math.abs(rec.points - plan.xPointsHorizon) < 1e-9, 'points still carry the bench the chip pays');

  // Every alternative the planner ranked, on the planner's own margin.
  let compared = 0;
  for (const alt of plan.alternatives) {
    const s = scoreRoute(alt, { planBundle: bundle, gameState, rules });
    if (!s.scored || (s.chip || null) !== (alt.chip || null)) continue;
    compared++;
    assert.ok(Math.abs((s.objective - rec.objective) - alt.deltaObjective) < 1e-9,
      `${alt.headline}: ${s.objective - rec.objective} against the planner's ${alt.deltaObjective}`);
  }
  assert.ok(compared >= 1, 'at least one alternative compared');
});
