// The transfer search past two moves, and the enablers in the pair pool.
//
// WHY THIS EXISTS. Until 2026-10-09 `searchTransfers` stopped at two moves, so
// a manager holding three to five free transfers could never be told to use
// them: on this sample squad the planner's OWN objective gained +5.8, +7.4 and
// +8.2 from the third to fifth free moves that were never generated (session
// report 2026-10-09-1638, B3). And the pair pool was cut from a value-sorted
// list, so the cheap "enabler" players the header promises to the pair search
// sorted to the bottom and never reached it.
//
// The pins, in order: at two free transfers or fewer nothing changes; at three
// to five the planner plays the deeper plan and it really scores higher on the
// planner's own scorer, legally; a downgrade-to-fund pair the old pool missed is
// found, against an exhaustive screen as ground truth; the search is
// deterministic; and the experiment switches do what they say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan, scoreCandidate, resolveOptions } from '../js/engine/planner.js';
import { searchTransfers, resolveMaxTransfers, TRANSFER_DEFAULTS } from '../js/engine/transfers.js';
import { validatePlan } from '../js/engine/validate.js';

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

// One plan build supplies the projections and the normalized squad every
// search below runs on, so all of them see identical inputs.
const base = await buildPlan({ gameState, squadState, options: { horizon: 5, seed: 7 } });
const projections = base.projections;
const working = base.squadState;
const cfgFor = (state) => resolveOptions({ horizon: 5, seed: 7 }, rules, state.gw);

const search = (state, opts = {}) => searchTransfers({
  squadState: state, projections, gameState, rules, horizon: 5,
  opts: { discount: 0.85, maxHits: 1, maxCandidates: 40, ...opts },
});

const objectiveOf = (state, transfersOut, transfersIn) => {
  const held = state.picks.map(p => p.playerId);
  const squad = held.filter(id => !transfersOut.includes(id)).concat(transfersIn);
  return scoreCandidate({
    candidate: { transfersOut, transfersIn, squad }, chip: null, squadState: state,
    projections, gameState, rules, cfg: cfgFor(state), gw: state.gw,
  });
};

test('the depth is the free transfers held, at least two and at most five, unless pinned', () => {
  assert.equal(TRANSFER_DEFAULTS.maxTransfers, null);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(ft => resolveMaxTransfers(ft)), [2, 2, 2, 3, 4, 5]);
  // Unlimited is a rebuild, which squad-builder.js owns.
  assert.equal(resolveMaxTransfers(Infinity), 2);
  assert.equal(resolveMaxTransfers(5, { maxTransfers: 2 }), 2);
  assert.equal(resolveMaxTransfers(1, { maxTransfers: 1 }), 1);
});

test('at two free transfers or fewer the search is exactly the two-move search it was', () => {
  for (const ft of [0, 1, 2]) {
    for (const bank of [working.bankTenths, 0]) {
      const state = withFt(working, ft, { bankTenths: bank });
      const auto = search(state);
      assert.ok(auto.every(c => c.transferCount <= 2), `ft ${ft}: nothing deeper than two`);
      assert.deepStrictEqual(auto, search(state, { maxTransfers: 2 }), `ft ${ft}, bank ${bank}`);
    }
  }
});

for (const [ft, floor] of [[3, 3], [4, 4], [5, 5]]) {
  test(`with ${ft} free transfers the planner plays the deeper plan, legally, and it scores higher`, async () => {
    const state = withFt(squadState, ft);
    const deep = await buildPlan({ gameState, squadState: state, options: { horizon: 5, seed: 7 } });
    const capped = await buildPlan({
      gameState, squadState: state, options: { horizon: 5, seed: 7, transferOptions: { maxTransfers: 2, pairEnablers: false } },
    });
    const ws = deep.squadState;
    assert.equal(deep.current.chip, null);
    assert.equal(capped.current.transferCount, 2, 'the old search spends two and rolls the rest');
    assert.ok(deep.current.transferCount >= floor, `${deep.current.transferCount} moves`);
    assert.equal(deep.current.hits, 0, 'every move is free');

    const validation = validatePlan(deep.current, ws, gameState, rules);
    assert.ok(validation.ok, JSON.stringify(validation.violations));

    // The planner's OWN scorer, both plans, same options: the probe found
    // +5.8 / +7.4 / +8.2; anything clearly positive pins the mechanism.
    const gain = objectiveOf(ws, deep.current.transfersOut, deep.current.transfersIn).objective
      - objectiveOf(ws, capped.current.transfersOut, capped.current.transfersIn).objective;
    assert.ok(gain > 2, `objective gain ${gain.toFixed(2)}`);
  });
}

test('every depth keeps a candidate, so the planner can still choose fewer moves', () => {
  const plans = search(withFt(working, 5));
  for (const depth of [0, 1, 2, 3, 4, 5]) {
    assert.ok(plans.some(p => p.transferCount === depth), `depth ${depth} returned`);
  }
  for (const p of plans) assert.ok(p.validation.ok);
});

test('the search is deterministic: identical inputs, identical output', () => {
  const state = withFt(working, 5);
  assert.deepStrictEqual(search(state), search(state));
});

test('the experiment switches: maxTransfers pins the depth and beamWidth narrows the beam', () => {
  const state = withFt(working, 5);
  assert.equal(Math.max(...search(state, { maxTransfers: 3 }).map(p => p.transferCount)), 3);
  const narrow = search(state, { beamWidth: 1 });
  assert.equal(Math.max(...narrow.map(p => p.transferCount)), 5, 'a beam of one still reaches the depth');
  assert.ok(narrow.every(p => p.validation.ok));
});

// A tight budget: no money in the bank and selling prices cut, so the best
// pair can be a DOWNGRADE to a cheap player funding an upgrade elsewhere.
// Three cuts are screened rather than one because which cut exercises the
// enabler moves whenever the projection model does; the claims are that the
// enabler pool never does worse than the old pool, and that in at least one
// cut it finds a pair the old pool missed, matching the exhaustive screen.
function tightCase(scale) {
  const state = withFt(working, 2, {
    bankTenths: 0,
    picks: working.picks.map(p => ({ ...p, sellingTenths: Math.round(p.sellingTenths * scale) })),
  });
  const held = state.picks.map(p => p.playerId);
  const selling = new Map(state.picks.map(p => [p.playerId, p.sellingTenths]));
  const value = new Map();
  for (const id of projections.byPlayer.keys()) {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const row = projections.get(id, state.gw + k);
      if (row) v += Math.pow(0.85, k) * row.xPoints;
    }
    value.set(id, v);
  }
  const buyable = [...gameState.players.values()]
    .filter(p => !held.includes(p.id) && p.status !== 'u' && p.status !== 'n');

  // Ground truth: every affordable pair, ranked on the additive proxy, the top
  // 600 scored by the planner itself.
  const pairs = [];
  for (let a = 0; a < held.length; a++) {
    for (let b = a + 1; b < held.length; b++) {
      const [oA, oB] = [held[a], held[b]];
      const budget = selling.get(oA) + selling.get(oB);
      const inA = buyable.filter(p => p.position === gameState.players.get(oA).position);
      const inB = buyable.filter(p => p.position === gameState.players.get(oB).position);
      for (const x of inA) {
        for (const y of inB) {
          if (x.id === y.id || x.nowCost + y.nowCost > budget) continue;
          pairs.push({ outs: [oA, oB], ins: [x.id, y.id], proxy: value.get(x.id) + value.get(y.id) - value.get(oA) - value.get(oB) });
        }
      }
    }
  }
  pairs.sort((x, y) => (y.proxy - x.proxy) || `${x.outs}>${x.ins}`.localeCompare(`${y.outs}>${y.ins}`));
  const clubOk = (outs, ins) => {
    const counts = new Map();
    for (const id of held.filter(i => !outs.includes(i)).concat(ins)) {
      const t = gameState.players.get(id).teamId;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.values()].every(n => n <= rules.clubLimit);
  };
  let truth = -Infinity;
  for (const p of pairs.slice(0, 600)) {
    if (!clubOk(p.outs, p.ins)) continue;
    const s = objectiveOf(state, p.outs, p.ins);
    if (s) truth = Math.max(truth, s.objective);
  }
  const best = (plans) => plans.filter(p => p.transferCount === 2)
    .map(p => ({ p, objective: objectiveOf(state, p.transfersOut, p.transfersIn).objective }))
    .reduce((a, b) => (!a || b.objective > a.objective ? b : a), null);
  return { state, value, buyable, truth, found: best(search(state)), old: best(search(state, { pairEnablers: false })) };
}

test('a downgrade that funds an upgrade is found on a tight budget, against an exhaustive screen', () => {
  let exercised = 0;
  for (const scale of [0.75, 0.8, 0.85]) {
    const c = tightCase(scale);
    assert.ok(c.found.objective >= c.old.objective - 1e-9, `x${scale}: enablers never lose to the old pool`);
    if (c.old.objective < c.truth - 0.1 && Math.abs(c.found.objective - c.truth) < 1e-9) {
      exercised++;
      // The winning pair buys somebody the old pair pool (top 8 by value in
      // the affordable band) could not reach.
      const outOfOldPool = (id) => {
        const pos = gameState.players.get(id).position;
        return !c.buyable.filter(p => p.position === pos)
          .sort((x, y) => (c.value.get(y.id) - c.value.get(x.id)) || (x.id - y.id))
          .slice(0, TRANSFER_DEFAULTS.pairPoolPerPosition)
          .some(p => p.id === id);
      };
      assert.ok(c.found.p.transfersIn.some(outOfOldPool), `x${scale}: the winner needs an enabler`);
    }
  }
  assert.ok(exercised >= 1, 'at least one tight cut is a pair the old pool missed and the new one finds');
});
