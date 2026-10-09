// When the plan rolls, every surface states the same margin.
//
// WHY THIS FILE EXISTS (backend audit B7, 2026-10-09). With one free transfer
// the sample's planner rolled against a best move that projected 0.16 points
// more, and four surfaces told four stories about it:
//
//   - the roll reason said keeping the transfer was worth 1.2 points (1.8 with
//     two banked), the value of EVERY banked transfer, while the decision
//     turned on the one transfer a roll keeps, worth 0.6;
//   - the same sentence appeared twice on "Why this plan?";
//   - the Alternatives card said "none of them scored higher" above three
//     plans that each projected more;
//   - confidence clamped the runner-up's lead to zero and called the two plans
//     tied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan, RISK_PROFILES, rollMarginValue } from '../js/engine/planner.js';
import { assessConfidence } from '../js/engine/confidence.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(APP, p), 'utf8'));

function sampleWorld() {
  const files = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const b = assembleSampleBundle(Object.fromEntries(files.map(n => [n, read(`data/sample/${n}.json`)])));
  const gameState = buildGameState(b.bootstrap, b.fixtures, { fetchedAt: b.fetchedAt });
  const squadState = buildSquadState({
    entry: b.entry, history: b.history, transfers: b.transfers, picks: b.picks, gameState, gw: b.planEvent,
  });
  return { gameState, squadState, fetchedAt: b.fetchedAt };
}

const OPTIONS = { horizon: 5, seed: 7 };
const withBank = (ss, banked) => ({ ...ss, transferState: { phase: 'season', gw: ss.gw, banked }, freeTransfers: banked });

// Apply the planner's own moves until it rolls, so the test sits on a squad the
// planner considers settled: the state where the roll's margin decides.
async function settledWorld() {
  const { gameState, squadState: s0, fetchedAt } = sampleWorld();
  let ss = withBank(s0, 2);
  for (let step = 0; step < 8; step++) {
    const b = await buildPlan({ gameState, squadState: ss, options: OPTIONS });
    if (!b.current.transferCount) return { gameState, squadState: ss, fetchedAt };
    const held = new Map(ss.picks.map(x => [x.playerId, x]));
    const picks = b.current.squad.map((id, i) => held.get(id) || {
      playerId: id, slot: i + 1, purchaseTenths: gameState.players.get(id).nowCost,
      sellingTenths: gameState.players.get(id).nowCost, multiplier: 1, isCaptain: false, isViceCaptain: false,
    });
    ss = { ...ss, picks, bankTenths: b.current.bankAfterTenths };
  }
  throw new Error('the planner never settled on the sample');
}

let settled = null;
const world = async () => (settled ||= await settledWorld());

test('the roll reason quotes the marginal value of the transfer kept, the number the decision used', async () => {
  const { gameState, squadState } = await world();
  for (const banked of [1, 2, 3]) {
    const ss = withBank(squadState, banked);
    const b = await buildPlan({ gameState, squadState: ss, options: OPTIONS });
    if (b.current.transferCount) continue;
    const roll = b.current.explanation.rollReason.reasons.find(r => r.code === 'roll_value');
    assert.ok(roll, `banked ${banked}: the roll is explained`);
    assert.ok(Math.abs(roll.value - RISK_PROFILES.balanced.rollBonus) < 1e-9, `banked ${banked}: ${roll.value}`);
    assert.equal(rollMarginValue(ss, gameState.rules, RISK_PROFILES.balanced.rollBonus), roll.value);
    // The sentence and the summary bullets do not both carry it.
    assert.ok(!b.current.explanation.bullets.some(x => x.code === 'roll_value'), 'not repeated in the summary bullets');
    // "which no move this week beat": no zero-hit alternative's extra points
    // exceed the value the roll was credited with.
    for (const alt of b.current.alternatives.filter(a => !a.hits && !a.chip)) {
      assert.ok(alt.deltaHorizon <= roll.value + 1e-9, `${alt.headline}: +${alt.deltaHorizon} vs ${roll.value}`);
    }
  }
  // At the cap the transfer kept is worth nothing.
  assert.equal(rollMarginValue(withBank(squadState, 5), gameState.rules, RISK_PROFILES.balanced.rollBonus), 0);
});

test('an alternative that projects more and loses on the transfer it spends says so, and confidence does not call it a tie', async () => {
  const { gameState, squadState, fetchedAt } = await world();
  const b = await buildPlan({ gameState, squadState: withBank(squadState, 1), options: OPTIONS });
  assert.equal(b.current.transferCount, 0, 'the settled squad rolls with one free transfer');
  const conf = assessConfidence({
    plan: b.current, projections: b.projections, gameState, dataStatus: b.dataStatus, now: Date.parse(fetchedAt) + 3600000,
  });
  // A lead the card prints as +0.1 or more is a lead, and every surface says
  // so; one that prints as +0.0 is a tie, and every surface says that.
  for (const alt of b.current.alternatives.filter(a => !a.hits && !a.chip)) {
    assert.ok(alt.deltaObjective <= 1e-9, `${alt.headline} ranked below the roll on the planner's own objective`);
    assert.equal(alt.belowRollValue, alt.deltaHorizon >= 0.05, `${alt.headline}: +${alt.deltaHorizon}`);
  }
  const lead = Math.max(...b.current.alternatives.map(a => a.deltaHorizon));
  if (lead >= 0.05) {
    assert.doesNotMatch(conf.reason, /projects the same points/);
    assert.match(conf.reason, /projects [0-9.]+ more points over the horizon and is not chosen because it spends a free transfer/);
  } else if (lead > 0) {
    assert.doesNotMatch(conf.reason, /more points over the horizon and is not chosen/);
  }
});

test('confidence never calls a runner-up that projects more a tie', async () => {
  const { assessConfidence: assess } = await import('../js/engine/confidence.js');
  const plan = {
    gw: 10, squad: [1, 2, 3], transfersIn: [], transfersOut: [], alternatives: [
      { deltaHorizon: 0.4, deltaObjective: -0.2, belowRollValue: true, rollMarginPoints: 0.6, transfersIn: [9], transfersOut: [1] },
    ],
    gwsAhead: 0, certainty: 'current', xPointsGw: 50, startingXI: [1, 2, 3],
  };
  const projections = { get: () => ({ sd: 2, xPoints: 4, pAppear: 1, confidence: 'high', confidenceScore: 1 }) };
  const gameState = { players: new Map(), fetchedAt: new Date().toISOString() };
  const out = assess({ plan, projections, gameState, dataStatus: { stale: false, sources: [] }, now: Date.now() });
  assert.doesNotMatch(out.reason, /same points/);
  assert.match(out.factors.find(f => f.key === 'margin').text, /0\.4 more points/);
});
