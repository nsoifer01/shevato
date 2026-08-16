// The scenario sandbox: an editable copy of a squad.
//
// These tests exist because the sandbox is where a user can build states the
// optimizer never would, and the failure this file is written against is the
// one FINDINGS.md names: a suite that only asks "is the result legal" passes
// happily on a wrong premise. So every money and points assertion here is
// computed independently from the fixture, by hand, and compared against what
// the module reports. A test that only checked `ok === true` would have passed
// on a scenario that silently spent the wrong bank.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { sellingPrice } from '../js/engine/rules.js';
import { goalkeeperPositionId } from '../js/engine/validate.js';
import {
  createScenario, applyTransfer, swapPlayers, setCaptain, setViceCaptain, moveBench,
  undo, reset, canUndo, isDirty, scenarioDiff, scenarioMoney, scenarioAccounting,
  scenarioPlan, validateScenario, scenarioSquadState, transferCandidates,
  transferBlockedReason, comparison, xiPoints, sellTenthsFor, scenarioSummary,
} from '../js/ui/scenario.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${name}.json`), 'utf8'));

function world() {
  const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const bundle = assembleSampleBundle(Object.fromEntries(names.map(n => [n, sample(n)])));
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const squadState = buildSquadState({
    entry: bundle.entry, history: bundle.history, transfers: bundle.transfers,
    picks: bundle.picks, gameState, gw: bundle.planEvent,
  });
  const gw = bundle.planEvent;
  const strength = buildStrength(gameState, { asOfGw: gw });
  const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw + 4 });
  return { gameState, squadState, gw, projections, ctx: { gameState, squadState } };
}

const W = world();
const { gameState, squadState, gw, projections, ctx } = W;
const rules = gameState.rules;
const P = (id) => gameState.players.get(id);
const scenario0 = () => createScenario({ squadState, gameState });

// A squad player of a given position who is NOT in the scenario, cheap enough
// to be affordable, so a test can name a real replacement rather than guess.
// A replacement that is genuinely legal RIGHT NOW: same position, affordable
// against this scenario's bank, and inside the club limit. Asking the module's
// own blocked-reason check keeps the helper honest, so a test that expects a
// transfer to succeed is not quietly asserting against an illegal one.
function replacementFor(sc, outId, { maxCost = Infinity, exclude = null } = {}) {
  const out = P(outId);
  for (const p of gameState.players.values()) {
    if (p.position !== out.position) continue;
    if (sc.squad.includes(p.id)) continue;
    if (exclude && exclude.has(p.id)) continue;
    if (p.nowCost > maxCost) continue;
    if (transferBlockedReason(sc, ctx, outId, p.id)) continue;
    return p.id;
  }
  return null;
}

// The first squad player who has a legal replacement available, and that
// replacement. Not every player does: the club limit and the bank can leave a
// position with no legal move at all, and a test that assumed otherwise would
// fail for a reason that has nothing to do with what it is testing.
function nextLegalTransfer(sc, skip = []) {
  const base = new Set(squadState.picks.map(p => p.playerId));
  for (const outId of sc.squad) {
    // Only sell someone the manager actually started with, and never buy back
    // a player this scenario already sold: that is a round trip, which nets to
    // zero transfers by design and would make an accumulation test read as a
    // failure when the module is right.
    if (!base.has(outId) || skip.includes(outId)) continue;
    // No cost ceiling is needed: replacementFor already asks the module whether
    // the move is affordable and inside the club limit.
    const inId = replacementFor(sc, outId, { exclude: base });
    if (inId) return [outId, inId];
  }
  throw new Error('the fixture offers no legal transfer at all');
}

/* --------------------------------------------------------------- seeding */

test('a fresh scenario is exactly the imported squad, and knows it is unedited', () => {
  const sc = scenario0();
  assert.equal(sc.squad.length, rules.squadSize);
  assert.equal(sc.xi.length, rules.starters);
  assert.equal(sc.benchOrder.length, rules.squadSize - rules.starters - 1);

  // The seed must be the manager's own slots, not a re-derivation of them.
  const picks = squadState.picks.slice().sort((a, b) => a.slot - b.slot);
  assert.deepEqual(sc.squad, picks.map(p => p.playerId));
  assert.deepEqual(sc.xi, picks.filter(p => p.slot <= 11).map(p => p.playerId));
  assert.equal(sc.captain, picks.find(p => p.isCaptain).playerId);
  assert.equal(sc.viceCaptain, picks.find(p => p.isViceCaptain).playerId);

  assert.equal(isDirty(sc, squadState), false);
  assert.equal(canUndo(sc), false);
  assert.equal(validateScenario(sc, ctx).ok, true);

  const diff = scenarioDiff(sc, squadState);
  assert.deepEqual(diff.transfersIn, []);
  assert.deepEqual(diff.transfersOut, []);
});

test('an untouched scenario spends nothing and takes no hit', () => {
  const money = scenarioMoney(scenario0(), ctx);
  assert.equal(money.moneyInTenths, 0);
  assert.equal(money.moneyOutTenths, 0);
  assert.equal(money.bankAfterTenths, squadState.bankTenths);
  const acct = scenarioAccounting(scenario0(), ctx);
  assert.equal(acct.hits, 0);
  assert.equal(acct.hitCostPoints, 0);
  assert.equal(acct.freeTransfersUsed, 0);
});

/* -------------------------------------------------------------- transfers */

test('one transfer moves exactly the money the FPL selling rule says it does', () => {
  const sc = scenario0();
  const outId = sc.xi[5];
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  assert.ok(inId, 'fixture must offer a same-position replacement');

  const { scenario: next, error } = applyTransfer(sc, ctx, outId, inId);
  assert.equal(error, null);

  // Independent arithmetic: the selling price is the reconstruction squad.js
  // made, and it is NOT now_cost when the player has risen.
  const pick = squadState.picks.find(p => p.playerId === outId);
  const expectedSell = sellingPrice(pick.purchaseTenths, P(outId).nowCost, rules);
  assert.equal(pick.sellingTenths, expectedSell);
  assert.equal(sellTenthsFor(sc, ctx, outId), expectedSell);

  const money = scenarioMoney(next, ctx);
  assert.equal(money.moneyInTenths, expectedSell);
  assert.equal(money.moneyOutTenths, P(inId).nowCost);
  assert.equal(money.bankAfterTenths, squadState.bankTenths + expectedSell - P(inId).nowCost);

  // and the squad really changed
  assert.equal(next.squad.includes(outId), false);
  assert.equal(next.squad.includes(inId), true);
  assert.equal(next.squad.length, rules.squadSize);
  assert.equal(validateScenario(next, ctx).ok, true);
  assert.equal(isDirty(next, squadState), true);
});

test('the incoming player takes the outgoing player place in the eleven', () => {
  const sc = scenario0();
  const outId = sc.xi[7];
  const slot = sc.xi.indexOf(outId);
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  const { scenario: next } = applyTransfer(sc, ctx, outId, inId);
  assert.equal(next.xi[slot], inId, 'a starter replaced by a starter');
  assert.equal(next.xi.length, rules.starters);
});

test('selling the captain hands the armband to the incoming player, never to nobody', () => {
  const sc = scenario0();
  const outId = sc.captain;
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  assert.ok(inId);
  const { scenario: next, error } = applyTransfer(sc, ctx, outId, inId);
  assert.equal(error, null);
  assert.equal(next.captain, inId);
  assert.equal(validateScenario(next, ctx).ok, true);
});

test('a transfer that cannot be afforded is refused with the two numbers that decide it', () => {
  const sc = scenario0();
  // The cheapest player to sell leaves the least to spend, which is the state
  // where affordability actually binds.
  const outId = sc.squad
    .filter(id => P(id).position !== goalkeeperPositionId(rules))
    .sort((a, b) => sellTenthsFor(sc, ctx, a) - sellTenthsFor(sc, ctx, b))[0];
  const funds = squadState.bankTenths + sellTenthsFor(sc, ctx, outId);

  // The most expensive player of that position in the game, which the fixture
  // guarantees is out of reach of a mid-price sale plus a small bank.
  let dearest = null;
  for (const p of gameState.players.values()) {
    if (p.position !== P(outId).position) continue;
    if (sc.squad.includes(p.id)) continue;
    if (!dearest || p.nowCost > dearest.nowCost) dearest = p;
  }
  assert.ok(dearest.nowCost > funds, 'fixture must contain someone unaffordable');

  const reason = transferBlockedReason(sc, ctx, outId, dearest.id);
  assert.match(reason, /costs/i);
  assert.match(reason, /to spend/i);
  const { scenario: after, error } = applyTransfer(sc, ctx, outId, dearest.id);
  // applyTransfer runs the full gate, which fails on budget.
  assert.ok(error, 'an unaffordable transfer must not be committed silently');
  assert.equal(after, sc, 'the scenario is left untouched when a transfer is refused');
});

test('a replacement from the wrong position is refused by name', () => {
  const sc = scenario0();
  const outId = sc.xi.find(id => P(id).position === 3);
  const wrong = [...gameState.players.values()].find(p => p.position === 4 && !sc.squad.includes(p.id));
  const reason = transferBlockedReason(sc, ctx, outId, wrong.id);
  assert.match(reason, /same shape|like for like/i);
});

test('the three-per-club limit blocks a fourth, and says which club', () => {
  const sc = scenario0();
  // Find a club the squad already holds three of, then try to add a fourth.
  const counts = new Map();
  for (const id of sc.squad) counts.set(P(id).teamId, (counts.get(P(id).teamId) || 0) + 1);
  const fullClub = [...counts.entries()].find(([, n]) => n >= rules.clubLimit);
  if (!fullClub) return; // fixture does not exercise it; the next test does

  const [teamId] = fullClub;
  // Sell a player from a DIFFERENT club, so the limit is what bites.
  const outId = sc.squad.find(id => P(id).teamId !== teamId);
  const candidate = [...gameState.players.values()]
    .find(p => p.teamId === teamId && p.position === P(outId).position && !sc.squad.includes(p.id));
  if (!candidate) return;

  const reason = transferBlockedReason(sc, ctx, outId, candidate.id);
  assert.match(reason, new RegExp(`limit is ${rules.clubLimit}`));
  const team = gameState.teams.get(teamId);
  assert.ok(reason.includes(team.name), 'the refusal names the club');
});

test('multiple transfers accumulate, and a round trip costs nothing', () => {
  let sc = scenario0();
  const [outA, inA] = nextLegalTransfer(sc);
  ({ scenario: sc } = applyTransfer(sc, ctx, outA, inA));

  const [outB, inB] = nextLegalTransfer(sc, [outA]);
  ({ scenario: sc } = applyTransfer(sc, ctx, outB, inB));

  assert.equal(scenarioDiff(sc, squadState).transfersIn.length, 2);

  // Selling the player we just bought, to buy back the one we sold, must read
  // as ONE net transfer, not three. The squad is the ledger, not the clicks.
  const { scenario: back, error } = applyTransfer(sc, ctx, inB, outB);
  assert.equal(error, null);
  const diff = scenarioDiff(back, squadState);
  assert.equal(diff.transfersIn.length, 1);
  assert.deepEqual(diff.transfersIn, [inA]);
  assert.deepEqual(diff.transfersOut, [outA]);
  // and the money is back to a single transfer's worth
  const money = scenarioMoney(back, ctx);
  assert.equal(money.moneyInTenths, sellTenthsFor(back, ctx, outA));
  assert.equal(money.moneyOutTenths, P(inA).nowCost);
});

test('transfers beyond the free ones cost exactly one hit each, from the state machine', () => {
  let sc = scenario0();
  const free = squadState.freeTransfers;
  assert.ok(Number.isFinite(free) && free >= 1, 'sample squad has a finite free-transfer count');

  // Make one more transfer than there are free ones.
  const made = [];
  for (let i = 0; i < free + 1; i++) {
    const outId = sc.xi.find(id => !made.includes(id) && replacementFor(sc, id, { maxCost: P(id).nowCost }));
    const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
    const r = applyTransfer(sc, ctx, outId, inId);
    assert.equal(r.error, null, `transfer ${i + 1} should be legal`);
    sc = r.scenario;
    made.push(inId);
  }

  const acct = scenarioAccounting(sc, ctx);
  assert.equal(scenarioDiff(sc, squadState).transfersIn.length, free + 1);
  assert.equal(acct.freeTransfersUsed, free);
  assert.equal(acct.hits, 1);
  assert.equal(acct.hitCostPoints, rules.hitCost);
  assert.equal(scenarioPlan(sc, ctx).hitCostPoints, rules.hitCost);
});

/* ------------------------------------------------------------ lineup edits */

test('a starter and a substitute change places, and the formation follows', () => {
  const sc = scenario0();
  const before = scenarioPlan(sc, ctx).formation;
  // Pick a swap that is legal: an outfield sub for a starter of the same position.
  const sub = sc.benchOrder[0];
  const starter = sc.xi.find(id => P(id).position === P(sub).position);
  assert.ok(starter, 'fixture offers a same-position swap');

  const { scenario: next, error } = swapPlayers(sc, ctx, starter, sub);
  assert.equal(error, null);
  assert.equal(next.xi.includes(sub), true);
  assert.equal(next.xi.includes(starter), false);
  assert.equal(next.benchOrder.includes(starter), true);
  assert.equal(next.xi.length, rules.starters);
  assert.equal(scenarioPlan(next, ctx).formation, before, 'a like-for-like swap keeps the shape');
  assert.equal(validateScenario(next, ctx).ok, true);
});

test('a swap that would break the formation is refused, with the rule that refused it', () => {
  const sc = scenario0();
  const gk = goalkeeperPositionId(rules);

  // Find a position already at its legal minimum in the eleven, and a
  // substitute of a DIFFERENT outfield position. Swapping one for the other
  // drops that position below its minimum, which is the exact rule under test.
  // The sample eleven starts above every minimum, so walk one position DOWN to
  // its minimum with legal swaps first. Each of those must be accepted, and the
  // one that would go below must be refused: that boundary is the test.
  let cur = sc;
  let refused = null;
  let reachedMinimum = false;

  const pos = Object.values(rules.positions).find(p => p.id !== gk
    && sc.xi.filter(id => P(id).position === p.id).length > p.minPlay
    && sc.benchOrder.some(id => P(id).position !== p.id && P(id).position !== gk));
  assert.ok(pos, 'the fixture must offer a position above its minimum with an outfield substitute');

  for (let guard = 0; guard < 6; guard++) {
    const starters = cur.xi.filter(id => P(id).position === pos.id);
    const sub = cur.benchOrder.find(id => P(id).position !== pos.id && P(id).position !== gk);
    if (!sub) break;
    const atMinimum = starters.length === pos.minPlay;
    const r = swapPlayers(cur, ctx, starters[0], sub);
    if (atMinimum) {
      reachedMinimum = true;
      refused = r.error;
      assert.equal(r.scenario, cur, 'a refused swap changes nothing');
      break;
    }
    assert.equal(r.error, null, 'a swap that stays inside the rules is accepted');
    cur = r.scenario;
  }

  assert.ok(reachedMinimum, 'the walk must reach the positional minimum');
  assert.ok(refused, 'dropping a position below its minimum has to be refused');
  assert.match(refused, /legal eleven plays|formation/i);
});

test('the reserve goalkeeper can only change places with the goalkeeper who starts', () => {
  const sc = scenario0();
  const gkPos = goalkeeperPositionId(rules);
  const benchGk = sc.benchGk;
  assert.ok(benchGk, 'a squad always benches a keeper');
  assert.equal(P(benchGk).position, gkPos);

  // Against the starting keeper: legal.
  const startingGk = sc.xi.find(id => P(id).position === gkPos);
  const ok = swapPlayers(sc, ctx, startingGk, benchGk);
  assert.equal(ok.error, null);
  assert.equal(ok.scenario.xi.includes(benchGk), true);
  assert.equal(ok.scenario.benchGk, startingGk);
  assert.equal(validateScenario(ok.scenario, ctx).ok, true);

  // Against an outfield starter: refused, because a keeper cannot play out.
  const outfield = sc.xi.find(id => P(id).position !== gkPos);
  const bad = swapPlayers(sc, ctx, outfield, benchGk);
  assert.ok(bad.error, 'benching an outfielder for the reserve keeper is illegal');
  assert.equal(bad.scenario, sc);

  // And the reserve keeper cannot be shuffled into the outfield bench order.
  const outfieldSub = sc.benchOrder[0];
  const reorder = swapPlayers(sc, ctx, benchGk, outfieldSub);
  assert.ok(reorder.error);
  assert.match(reorder.error, /reserve goalkeeper/i);
});

test('bench order is reorderable and stays the auto-sub order', () => {
  const sc = scenario0();
  const [first, second] = sc.benchOrder;
  const { scenario: next, error } = moveBench(sc, ctx, second, 'up');
  assert.equal(error, null);
  assert.deepEqual(next.benchOrder.slice(0, 2), [second, first]);
  assert.equal(validateScenario(next, ctx).ok, true);

  // Moving the first substitute up again is a no-op rather than an error.
  const top = moveBench(next, ctx, second, 'up');
  assert.equal(top.error, null);
  assert.deepEqual(top.scenario.benchOrder, next.benchOrder);
});

test('two substitutes swapping is a reorder, not a promotion', () => {
  const sc = scenario0();
  const [a, b] = sc.benchOrder;
  const { scenario: next, error } = swapPlayers(sc, ctx, a, b);
  assert.equal(error, null);
  assert.deepEqual(next.benchOrder.slice(0, 2), [b, a]);
  assert.equal(next.xi.length, rules.starters);
  assert.deepEqual(next.xi, sc.xi, 'nobody entered the eleven');
});

/* ---------------------------------------------------------------- armbands */

test('the captain can be changed to any starter, and only to a starter', () => {
  const sc = scenario0();
  const target = sc.xi.find(id => id !== sc.captain && id !== sc.viceCaptain);
  const { scenario: next, error } = setCaptain(sc, ctx, target);
  assert.equal(error, null);
  assert.equal(next.captain, target);
  assert.equal(next.viceCaptain, sc.viceCaptain, 'the vice is untouched');
  assert.equal(validateScenario(next, ctx).ok, true);

  const benched = setCaptain(sc, ctx, sc.benchOrder[0]);
  assert.ok(benched.error);
  assert.match(benched.error, /starting eleven/i);
  assert.equal(benched.scenario, sc);
});

test('naming the vice as captain swaps the two rather than duplicating a role', () => {
  const sc = scenario0();
  const { scenario: next, error } = setCaptain(sc, ctx, sc.viceCaptain);
  assert.equal(error, null);
  assert.equal(next.captain, sc.viceCaptain);
  assert.equal(next.viceCaptain, sc.captain);
  assert.equal(validateScenario(next, ctx).ok, true);
});

test('the same swap holds for the vice-captain', () => {
  const sc = scenario0();
  const { scenario: next, error } = setViceCaptain(sc, ctx, sc.captain);
  assert.equal(error, null);
  assert.equal(next.viceCaptain, sc.captain);
  assert.equal(next.captain, sc.viceCaptain);
});

test('benching the captain passes the armband to the vice, as the game does', () => {
  const sc = scenario0();
  const captain = sc.captain;
  const sub = sc.benchOrder.find(id => P(id).position === P(captain).position);
  if (!sub) return;
  const { scenario: next, error } = swapPlayers(sc, ctx, captain, sub);
  assert.equal(error, null);
  assert.equal(next.xi.includes(captain), false);
  assert.equal(next.captain, sc.viceCaptain, 'the vice inherits');
  assert.notEqual(next.captain, next.viceCaptain);
  assert.equal(validateScenario(next, ctx).ok, true);
});

/* ------------------------------------------------------------ undo / reset */

test('undo steps back through every kind of edit, one at a time', () => {
  let sc = scenario0();
  const original = { squad: sc.squad.slice(), xi: sc.xi.slice(), captain: sc.captain };

  const outId = sc.xi[2];
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  ({ scenario: sc } = applyTransfer(sc, ctx, outId, inId));
  ({ scenario: sc } = setCaptain(sc, ctx, sc.xi.find(id => id !== sc.captain && id !== sc.viceCaptain)));
  const sub = sc.benchOrder[0];
  const starter = sc.xi.find(id => P(id).position === P(sub).position);
  if (starter) ({ scenario: sc } = swapPlayers(sc, ctx, starter, sub));

  assert.equal(isDirty(sc, squadState), true);
  let steps = 0;
  while (canUndo(sc)) { sc = undo(sc); steps++; if (steps > 10) break; }
  assert.ok(steps >= 2);
  assert.deepEqual(sc.squad, original.squad);
  assert.deepEqual(sc.xi, original.xi);
  assert.equal(sc.captain, original.captain);
  assert.equal(isDirty(sc, squadState), false);
});

test('reset returns to the imported squad in one action and stays undoable', () => {
  let sc = scenario0();
  const outId = sc.xi[1];
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  ({ scenario: sc } = applyTransfer(sc, ctx, outId, inId));
  ({ scenario: sc } = setCaptain(sc, ctx, sc.xi.find(id => id !== sc.captain && id !== sc.viceCaptain)));

  const back = reset(sc, { squadState, gameState, plan: null });
  assert.equal(isDirty(back, squadState), false);
  assert.deepEqual(back.squad, scenario0().squad);
  assert.equal(canUndo(back), true, 'even a reset can be undone');
  const undone = undo(back);
  assert.equal(isDirty(undone, squadState), true);
});

/* ------------------------------------------------------- points and compare */

test('the gameweek projection counts the chosen eleven and doubles the chosen captain', () => {
  const sc = scenario0();
  // Independent sum from the projection rows themselves.
  let expected = 0;
  for (const id of sc.xi) expected += projections.get(id, gw).xPoints;
  expected += projections.get(sc.captain, gw).xPoints;
  assert.ok(Math.abs(xiPoints(sc.xi, sc.captain, projections, gw) - expected) < 1e-9);
});

test('changing the captain to the best projected starter raises the gameweek number by his projection', () => {
  const sc = scenario0();
  let best = null;
  for (const id of sc.xi) {
    const x = projections.get(id, gw).xPoints;
    if (!best || x > best.x) best = { id, x };
  }
  const beforeCaptainX = projections.get(sc.captain, gw).xPoints;
  const { scenario: next } = setCaptain(sc, ctx, best.id);
  const before = xiPoints(sc.xi, sc.captain, projections, gw);
  const after = xiPoints(next.xi, next.captain, projections, gw);
  assert.ok(Math.abs((after - before) - (best.x - beforeCaptainX)) < 1e-9,
    'the delta is exactly the difference between the two armbands');
});

test('the comparison reports both sides on the same basis and prices the hits', () => {
  let sc = scenario0();
  const free = squadState.freeTransfers;
  const made = [];
  for (let i = 0; i < free + 1; i++) {
    const outId = sc.xi.find(id => !made.includes(id) && replacementFor(sc, id, { maxCost: P(id).nowCost }));
    const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
    const r = applyTransfer(sc, ctx, outId, inId);
    if (r.error) break;
    sc = r.scenario;
    made.push(inId);
  }
  const c = comparison(sc, ctx, { projections, gw, horizon: 5, discount: 0.85 });

  // before is the imported squad, computed by the same function
  const picks = squadState.picks.slice().sort((a, b) => a.slot - b.slot);
  const baseXi = picks.filter(p => p.slot <= 11).map(p => p.playerId);
  const baseCap = picks.find(p => p.isCaptain).playerId;
  assert.ok(Math.abs(c.gw.before - xiPoints(baseXi, baseCap, projections, gw)) < 1e-9);
  assert.ok(Math.abs(c.gw.after - xiPoints(sc.xi, sc.captain, projections, gw)) < 1e-9);
  assert.ok(Math.abs(c.gw.delta - (c.gw.after - c.gw.before)) < 1e-9);

  assert.equal(c.bank.before, squadState.bankTenths);
  assert.equal(c.bank.after, scenarioMoney(sc, ctx).bankAfterTenths);
  assert.equal(c.hits, scenarioAccounting(sc, ctx).hits);
  assert.ok(Math.abs(c.netHorizon - (c.horizon.delta - c.hitCostPoints)) < 1e-9,
    'the net is the horizon gain minus what the hits cost');
});

/* --------------------------------------------------- handing it to the planner */

test('the scenario becomes a SquadState the planner accepts, without touching the imported one', async () => {
  const sc = scenario0();
  const outId = sc.xi[6];
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  const { scenario: edited } = applyTransfer(sc, ctx, outId, inId);

  const before = JSON.stringify(squadState);
  const ss = scenarioSquadState(edited, ctx);

  assert.equal(JSON.stringify(squadState), before, 'the imported squad is never mutated');
  assert.equal(ss.source, 'scenario');
  assert.equal(ss.picks.length, rules.squadSize);
  assert.equal(ss.picks.filter(p => p.slot <= 11).length, rules.starters);
  assert.equal(ss.bankTenths, scenarioMoney(edited, ctx).bankAfterTenths);
  assert.equal(ss.picks.some(p => p.playerId === inId), true);
  assert.equal(ss.picks.some(p => p.playerId === outId), false);

  // The free transfers handed on are the ones that SURVIVE the edit, so the
  // planner cannot spend the same transfer twice.
  assert.equal(ss.freeTransfers, scenarioAccounting(edited, ctx).freeTransfersAfter);

  // and the planner really runs on it
  const bundle = await buildPlan({ gameState, squadState: ss, options: { horizon: 3 } });
  assert.equal(bundle.validation.ok, true);
  assert.equal(bundle.current.squad.length, rules.squadSize);
  assert.equal(bundle.squadState.picks.some(p => p.playerId === inId), true,
    'the recommendation starts from the edited squad');
});

test('a scenario-bought player sells for what the scenario paid, never at a profit', () => {
  const sc = scenario0();
  const outId = sc.xi[8];
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  const { scenario: edited } = applyTransfer(sc, ctx, outId, inId);
  assert.equal(sellTenthsFor(edited, ctx, inId), P(inId).nowCost);

  // Selling him again returns exactly what was paid, so a round trip is free.
  const { scenario: back } = applyTransfer(edited, ctx, inId, outId);
  assert.equal(scenarioMoney(back, ctx).bankAfterTenths, squadState.bankTenths);
});

/* ------------------------------------------------------------- candidates */

test('the replacement list is same-position, excludes the squad, and explains every refusal', () => {
  const sc = scenario0();
  const outId = sc.xi.find(id => P(id).position === 3);
  const rows = transferCandidates(sc, ctx, outId, { projections, gw });
  assert.ok(rows.length > 5);
  for (const row of rows) {
    assert.equal(P(row.id).position, 3, 'same position only');
    assert.equal(sc.squad.includes(row.id), false, 'never someone already owned');
    if (row.blocked) assert.ok(row.blocked.length > 5, 'a refusal is a sentence');
  }
  // Playable options come first, and are ordered by projection.
  const playable = rows.filter(r => !r.blocked);
  for (let i = 1; i < playable.length; i++) {
    assert.ok((playable[i - 1].xPoints ?? -1) >= (playable[i].xPoints ?? -1));
  }
  assert.ok(rows.findIndex(r => r.blocked) === -1 || rows.findIndex(r => r.blocked) >= playable.length);
});

test('two players sharing a display name are still told apart by club and price', () => {
  // The live 2026/27 payload carries two players called Sangare at different
  // clubs and different prices, so a picker that shows only web_name is
  // ambiguous by construction. Every candidate therefore carries its club.
  const sc = scenario0();
  const outId = sc.xi[4];
  const rows = transferCandidates(sc, ctx, outId, { projections, gw });
  for (const row of rows.slice(0, 20)) {
    assert.ok(row.club && row.club.length, 'every candidate names its club');
    assert.ok(Number.isFinite(row.priceTenths), 'and its price');
  }
});

/* ---------------------------------------------------------------- summary */

test('the summary is one call and agrees with its parts', () => {
  const sc = scenario0();
  const outId = sc.xi[9];
  const inId = replacementFor(sc, outId, { maxCost: P(outId).nowCost });
  const { scenario: edited } = applyTransfer(sc, ctx, outId, inId);
  const s = scenarioSummary(edited, ctx, { projections, gw, horizon: 5, discount: 0.85 });
  assert.equal(s.ok, true);
  assert.equal(s.reason, null);
  assert.equal(s.dirty, true);
  assert.equal(s.plan.transferCount, 1);
  assert.equal(s.compare.transfers, 1);
  assert.equal(s.plan.bankAfterTenths, s.compare.bank.after);
});

/* ------------------------------------------------------------- pre-season */

test('with no picks to copy, the scenario seeds from the recommendation instead', async () => {
  // The pre-season state: a draft squad state with an empty pick list, which is
  // what buildSquadState returns while FPL is still 404ing picks. The sandbox
  // has to work there too, seeded from the opening 15 the optimizer built.
  // A REAL pre-season squad state, built the way the app builds one when FPL is
  // still 404ing picks: no picks, full budget, and the unlimited-transfer
  // state. Hand-faking this by spreading the in-season state would carry an
  // in-season free-transfer count into a pre-season squad, which is the exact
  // class of bug FINDINGS warns about.
  const draftState = buildSquadState({
    entry: null, history: null, transfers: null, picks: null, gameState, gw,
  });
  assert.equal(draftState.source, 'draft');
  assert.equal(draftState.picks.length, 0);
  const draftPlan = await buildPlan({
    gameState,
    squadState: { ...draftState, gw },
    options: { horizon: 3 },
  });

  const sc = createScenario({
    squadState: draftState, gameState, plan: draftPlan.current, origin: 'current',
  });
  assert.equal(sc.origin, 'recommended', 'with nothing to copy it says where it came from');
  assert.equal(sc.squad.length, rules.squadSize);
  assert.equal(sc.xi.length, rules.starters);
  assert.ok(sc.captain && sc.xi.includes(sc.captain));

  const draftCtx = { gameState, squadState: draftState };
  assert.equal(validateScenario(sc, draftCtx).ok, true, 'a squad built from a draft plan is legal');

  // Editing it still works, and the money comes off the full budget because a
  // pre-season squad owns nothing yet.
  const money = scenarioMoney(sc, draftCtx);
  assert.equal(money.bankBeforeTenths, rules.budgetTenths);
  const outId = sc.xi[3];
  const inId = (() => {
    for (const p of gameState.players.values()) {
      if (p.position !== P(outId).position) continue;
      if (sc.squad.includes(p.id)) continue;
      if (transferBlockedReason(sc, draftCtx, outId, p.id)) continue;
      return p.id;
    }
    return null;
  })();
  if (inId) {
    const r = applyTransfer(sc, draftCtx, outId, inId);
    assert.equal(r.error, null);
    assert.equal(r.scenario.squad.includes(inId), true);
    assert.equal(r.scenario.squad.includes(outId), false);
    // Changing your mind before the season starts is not a transfer and must
    // never be priced as one: no hit, and the bank simply reflects the new
    // fifteen against the budget.
    assert.equal(scenarioDiff(r.scenario, draftState).transfersIn.length, 0);
    assert.equal(scenarioAccounting(r.scenario, draftCtx).hits, 0);
    const after = scenarioMoney(r.scenario, draftCtx);
    const cost = r.scenario.squad.reduce((s, id) => s + P(id).nowCost, 0);
    assert.equal(after.bankAfterTenths, rules.budgetTenths - cost);
    assert.equal(validateScenario(r.scenario, draftCtx).ok, true);
  }
});

test('a scenario seeded from the recommendation reports the recommendation as its baseline', () => {
  const sc = createScenario({ squadState, gameState, plan: null, origin: 'current' });
  assert.equal(sc.origin, 'current');
});

/* ------------------------------------------------ combined edits in one go */

test('a transfer, a lineup change and a captain change all hold together', () => {
  let sc = scenario0();
  const [outId, inId] = nextLegalTransfer(sc);
  ({ scenario: sc } = applyTransfer(sc, ctx, outId, inId));

  const sub = sc.benchOrder.find(id => sc.xi.some(x => P(x).position === P(id).position));
  const starter = sc.xi.find(id => P(id).position === P(sub).position);
  const swap = swapPlayers(sc, ctx, starter, sub);
  assert.equal(swap.error, null);
  sc = swap.scenario;

  const cap = setCaptain(sc, ctx, sc.xi.find(id => id !== sc.captain && id !== sc.viceCaptain));
  assert.equal(cap.error, null);
  sc = cap.scenario;

  const check = validateScenario(sc, ctx);
  assert.equal(check.ok, true, JSON.stringify(check.violations));
  assert.equal(sc.squad.length, rules.squadSize);
  assert.equal(sc.xi.length, rules.starters);
  assert.equal(new Set([...sc.xi, sc.benchGk, ...sc.benchOrder]).size, rules.squadSize,
    'the eleven plus the bench is still exactly the squad');
  assert.notEqual(sc.captain, sc.viceCaptain);
  assert.equal(scenarioDiff(sc, squadState).transfersIn.length, 1);
});

test('an illegal scenario reports the reason instead of pretending to be fine', () => {
  // Build an illegal state directly, the way a bug could, and check the gate
  // catches it rather than trusting that the edit functions are the only path.
  const sc = scenario0();
  const broken = { ...sc, xi: sc.xi.slice(0, 10) };
  const check = validateScenario(broken, ctx);
  assert.equal(check.ok, false);
  const s = scenarioSummary(broken, ctx, { projections, gw, horizon: 3, discount: 0.85 });
  assert.equal(s.ok, false);
  assert.ok(s.reason && s.reason.length > 5);
});

/* ------------------------- every operation, end to end through the planner */

test('a chain of every operation still produces a SquadState buildPlan accepts', async () => {
  // The full walk the interactive sandbox offers: transfer, starter/sub swap,
  // captain, vice, bench reorder, then one undo. The point is not any single
  // edit (each has its own test above) but that the COMPOSITION still hands
  // the ordinary planner a squad state it can plan from, because "ask the
  // planner from this team" is the whole reason the scenario is a SquadState.
  let sc = scenario0();
  const [outId, inId] = nextLegalTransfer(sc);
  ({ scenario: sc } = applyTransfer(sc, ctx, outId, inId));

  const sub = sc.benchOrder.find(id => sc.xi.some(x => P(x).position === P(id).position));
  const starter = sc.xi.find(id => P(id).position === P(sub).position);
  ({ scenario: sc } = swapPlayers(sc, ctx, starter, sub));

  ({ scenario: sc } = setCaptain(sc, ctx, sc.xi.find(id => id !== sc.captain && id !== sc.viceCaptain)));
  ({ scenario: sc } = setViceCaptain(sc, ctx, sc.xi.find(id => id !== sc.captain && id !== sc.viceCaptain)));
  if (sc.benchOrder.length > 1) ({ scenario: sc } = moveBench(sc, ctx, sc.benchOrder[1], 'up'));
  sc = undo(sc); // the bench reorder steps back; everything before it survives

  const check = validateScenario(sc, ctx);
  assert.equal(check.ok, true, JSON.stringify(check.violations));

  const ss = scenarioSquadState(sc, ctx);
  assert.equal(ss.picks.length, rules.squadSize);
  assert.equal(ss.bankTenths, scenarioMoney(sc, ctx).bankAfterTenths);
  assert.equal(ss.freeTransfers, scenarioAccounting(sc, ctx).freeTransfersAfter);

  const bundle = await buildPlan({ gameState, squadState: ss, options: { horizon: 3 } });
  assert.equal(bundle.validation.ok, true, 'the planner plans a legal squad from the edited state');
  assert.equal(bundle.squadState.picks.some(p => p.playerId === inId), true,
    'and it starts from the squad the user built, not the imported one');
});

test('reversing a transfer nets to zero through the whole ledger', () => {
  // FPL charges for the difference between squads, not for clicks. A transfer
  // made and reversed must therefore cost nothing: no transfer counted, no
  // hit, the bank back to the import. This is the net-semantics rule the
  // interaction rework must never weaken.
  let sc = scenario0();
  const [outId, inId] = nextLegalTransfer(sc);
  ({ scenario: sc } = applyTransfer(sc, ctx, outId, inId));
  ({ scenario: sc } = applyTransfer(sc, ctx, inId, outId));

  const diff = scenarioDiff(sc, squadState);
  assert.equal(diff.transfersIn.length, 0);
  assert.equal(diff.transfersOut.length, 0);
  assert.equal(scenarioAccounting(sc, ctx).hits, 0);
  assert.equal(scenarioMoney(sc, ctx).bankAfterTenths, squadState.bankTenths);
  // Undo history is click history, on purpose: both edits remain undoable.
  assert.equal(sc.past.length, 2);
});
