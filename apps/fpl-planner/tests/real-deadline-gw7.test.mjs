// Five REAL managers at the 2026/27 GW7 deadline (tests/fixtures/gw7-2026),
// planned exactly as the app plans them, held to FPL's own witnesses and to the
// plan's own numbers, and each pinned to the defect the 2026-10-16 pre-deadline
// audit found on that path. Until this file, CI planned no real manager at all
// (FINDINGS, "Why every pre-gameweek audit found something").

import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreCandidate, resolveOptions } from '../js/engine/planner.js';
import { searchTransfers } from '../js/engine/transfers.js';
import {
  freeTransferWitnessFailures, chipLedgerFailures, squadReadFailures, planConsistencyFailures,
} from '../scripts/lib/plan-audit.mjs';
import { BOOTSTRAP, ENTRIES, GAME_STATE, PLAN_GW, APP_OPTIONS, squadFor, planFor } from './helpers/gw7-fixture.mjs';

const rules = GAME_STATE.rules;
const name = (id) => GAME_STATE.players.get(id).webName;
const idOf = (webName) => [...GAME_STATE.players.values()].find(p => p.webName === webName).id;

for (const label of Object.keys(ENTRIES)) {
  test(`${label}: squad state and plan hold against FPL and against themselves`, async () => {
    const { bundle, squadState } = await planFor(label);
    const e = ENTRIES[label];
    assert.deepEqual(freeTransferWitnessFailures({ history: e.history, rules }), []);
    assert.deepEqual(chipLedgerFailures({ bootstrap: BOOTSTRAP, history: e.history, offered: squadState.chipsAvailable, gw: PLAN_GW }), []);
    assert.deepEqual(squadReadFailures({ squadState, picks: squadState.freeHitGw ? e.revertPicks : e.picks, rules }), []);
    assert.deepEqual(planConsistencyFailures({ bundle, squadState, rules }), []);
    assert.deepEqual(bundle.validation, { ok: true, violations: [] });
  });
}

test('owner (entry 3855835): what FPL holds for GW7, read exactly', () => {
  const s = squadFor('owner');
  assert.equal(s.freeTransfers, 1, 'GW2 1, GW3 1, GW4 2, GW5 2 (Wildcard), GW6 1 (two spent), GW7 1 (one spent)');
  assert.equal(s.bankTenths, 32);
  assert.equal(s.squadValueTenths, 993, 'the fifteen at selling prices plus the bank');
  assert.deepEqual([...s.chipsAvailable].sort(), ['3xc', 'freehit']);
  assert.deepEqual(s.warnings, []);
  const selling = Object.fromEntries(s.picks.map(p => [name(p.playerId), p.sellingTenths]));
  // Half the profit on a riser is FPL's; a faller is sold at today's price.
  assert.equal(selling.Hall, 52, 'bought 5.1, now 5.3');
  assert.equal(selling.Saka, 95, 'bought 9.5, now 9.6');
  assert.equal(selling['B.Fernandes'], 119, 'bought 12.0, now 11.9');
});

// Free transfers for GW7, derived by hand from each manager's FPL history
// (one per gameweek from GW2, banked to five, a Wildcard or Free Hit week keeps
// the bank and earns nothing, FPL's charged hits name the transfers that were
// not free), independently of transfer-state.js. Until 2026-10-16 only the
// owner's count was pinned, so a wrong count for any of the other paths (three
// banked, a Free Hit just played) would have passed.
test('every manager: the GW7 free-transfer count is what FPL holds', () => {
  const expected = { 'bench-boost': 2, 'deep-search': 3, 'free-hit': 1, owner: 1, 'triple-captain-tie': 1 };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(ENTRIES).sort());
  for (const [label, ft] of Object.entries(expected)) assert.equal(squadFor(label).freeTransfers, ft, label);
});

test('owner: the recommended move is the best of every legal single transfer, on the planner\'s own score', async () => {
  const { bundle, squadState } = await planFor('owner');
  const cfg = resolveOptions(APP_OPTIONS, rules, PLAN_GW);
  const held = squadState.picks.map(p => p.playerId);
  const bank = squadState.bankTenths;
  const club = (ids) => { const n = new Map(); for (const id of ids) n.set(GAME_STATE.players.get(id).teamId, (n.get(GAME_STATE.players.get(id).teamId) || 0) + 1); return n; };
  const score = (out, inn) => scoreCandidate({
    candidate: { transfersOut: out, transfersIn: inn, squad: held.filter(x => !out.includes(x)).concat(inn) },
    chip: null, squadState: bundle.squadState, projections: bundle.projections, gameState: GAME_STATE, rules, cfg, gw: PLAN_GW,
  });
  let best = { objective: score([], []).objective, out: null, inn: null };
  let legal = 0;
  for (const pick of squadState.picks) {
    const out = GAME_STATE.players.get(pick.playerId);
    for (const p of GAME_STATE.players.values()) {
      if (p.position !== out.position || held.includes(p.id)) continue;
      // FPL will not sell a player who has left the league or the squad list.
      if (p.status === 'u' || p.status === 'n') continue;
      if (p.nowCost > bank + pick.sellingTenths) continue;
      const after = held.filter(x => x !== out.id).concat(p.id);
      // `clubLimit`, the field rules carries. Until 2026-10-16 this read
      // `rules.maxPerClub`, which is undefined, so no club limit applied and
      // 543 illegal or unbuyable transfers were counted as legal.
      if ([...club(after).values()].some(n => n > rules.clubLimit)) continue;
      legal++;
      const s = score([out.id], [p.id]);
      if (s && s.objective > best.objective) best = { objective: s.objective, out: out.id, inn: p.id };
    }
  }
  assert.ok(Number.isInteger(rules.clubLimit) && rules.clubLimit === 3);
  assert.equal(legal, 2346, 'every legal single transfer the owner can make');
  assert.deepEqual([name(best.out), name(best.inn)], ['Hall', 'Gabriel']);
  assert.deepEqual(bundle.current.transfersOut.map(name), ['Hall']);
  assert.deepEqual(bundle.current.transfersIn.map(name), ['Gabriel']);
  assert.equal(bundle.current.bankAfterTenths, 5);
});

test('owner: the captain is the top projection in the eleven, so no explanation is owed', async () => {
  const { bundle } = await planFor('owner');
  const xp = (id) => bundle.projections.get(id, PLAN_GW).xPoints;
  const top = [...bundle.current.startingXI].sort((a, b) => xp(b) - xp(a))[0];
  assert.equal(name(bundle.current.captain), 'Gonzalo');
  assert.equal(bundle.current.captain, top);
});

// Registry 47: at a shortlist of 16 the better plan was generated and cut.
test('deep-search (3 free transfers): the better legal three-move plan reaches the planner', async () => {
  const { bundle } = await planFor('deep-search');
  const plan = bundle.current;
  assert.ok(plan.transfersOut.map(name).includes('Konsa'), plan.transfersOut.map(name).join(', '));
  assert.ok(!plan.transfersOut.map(name).includes('Dedić'));
  // The plan that sells Dedić instead is legal and ranks below it, scored the
  // way the planner ranks.
  const cfg = resolveOptions(APP_OPTIONS, rules, PLAN_GW);
  const held = bundle.squadState.picks.map(p => p.playerId);
  const scoreOf = (o, i) => scoreCandidate({
    candidate: { transfersOut: o, transfersIn: i, squad: held.filter(x => !o.includes(x)).concat(i) },
    chip: null, squadState: bundle.squadState, projections: bundle.projections, gameState: GAME_STATE, rules, cfg, gw: PLAN_GW,
  });
  const out = plan.transfersOut.map(id => (name(id) === 'Konsa' ? idOf('Dedić') : id));
  const mine = scoreOf(plan.transfersOut, plan.transfersIn);
  const other = scoreOf(out, plan.transfersIn);
  assert.ok(other && mine.objective - other.objective > 0.2, `${mine.objective} against ${other && other.objective}`);
  const raw = searchTransfers({
    squadState: bundle.squadState, projections: bundle.projections, gameState: GAME_STATE, rules, horizon: cfg.horizon,
    opts: { discount: cfg.discount, maxHits: cfg.maxHits, maxCandidates: cfg.maxCandidates, seed: cfg.seed, ...cfg.lineupOptions, rerankCandidates: 16 },
  });
  const key = (o, i) => `${[...o].sort()}>${[...i].sort()}`;
  const scored = raw.map(r => scoreOf(r.transfersOut, r.transfersIn)).filter(Boolean);
  const bestAt16 = scored.sort((a, b) => b.objective - a.objective)[0];
  assert.notEqual(key(bestAt16.candidate.transfersOut, bestAt16.candidate.transfersIn), key(plan.transfersOut, plan.transfersIn),
    'at the old width of 16 the search does not return the plan the planner now makes');
});

test('bench-boost: same-chip alternatives print their ranking gap and their own moves', async () => {
  const { bundle } = await planFor('bench-boost');
  const plan = bundle.current;
  assert.equal(plan.chip, 'bboost');
  const same = plan.alternatives.filter(a => a.chip === 'bboost');
  assert.ok(same.length >= 2);
  for (const a of same) {
    assert.equal(a.deltaWithChipValue, a.deltaObjective, `${a.headline}: the card prints the gap the planner ranked on`);
    assert.ok(a.deltaWithChipValue <= 0, `${a.headline}: never above the plan`);
    assert.match(a.headline, /^Play your Bench Boost: .+ to .+/);
  }
  assert.equal(new Set(plan.alternatives.map(a => a.headline)).size, plan.alternatives.length);
});

test('triple-captain-tie: a Triple Captain held on a tie names no "better" later week', async () => {
  const { bundle } = await planFor('triple-captain-tie');
  const tc = bundle.chipEvaluation.perChip['3xc'];
  assert.ok(tc.available && tc.valueNow > tc.bestValue, `this week ${tc.valueNow} against GW${tc.bestGw} ${tc.bestValue}`);
  assert.ok(!bundle.chipEvaluation.recommendation.reasons.some(r => r.code === 'hold_3xc_better'));
  assert.equal(bundle.current.explanation.chipReason.alternativeGw, null);
  // The owner's is genuinely better later, and still says so.
  const owner = (await planFor('owner')).bundle;
  assert.ok(owner.chipEvaluation.recommendation.reasons.some(r => r.code === 'hold_3xc_better' && r.value === 10));
});

test('free-hit: a GW6 Free Hit plans GW7 from the GW5 squad it reverts to', async () => {
  const s = squadFor('free-hit');
  const revert = ENTRIES['free-hit'].revertPicks;
  assert.deepEqual(s.picks.map(p => p.playerId).sort((a, b) => a - b), revert.picks.map(p => p.element).sort((a, b) => a - b));
  assert.equal(s.bankTenths, revert.entry_history.bank);
  assert.deepEqual(s.warnings.map(w => w.code), ['free_hit_reverted']);
  assert.ok(!s.chipsAvailable.includes('freehit'));
  const { bundle } = await planFor('free-hit');
  assert.ok(!bundle.chipEvaluation.recommendation.reasons.some(r => /0 chips playable/.test(r.text)), 'no "0 chips playable ... none of them"');
});
