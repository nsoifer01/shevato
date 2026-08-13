// Transfer search, hits and rolling (SPEC 11).
//
// This is the decision the product exists to make, so the assertions are about
// what an illegal or unaffordable suggestion would look like and about the two
// judgement calls the engine has to get right: refusing a marginal upgrade, and
// valuing a banked free transfer.
//
// The world is synthetic and flat (every gameweek looks the same for every
// player) so the horizon arithmetic is predictable to the tenth of a point and
// a rejection can be attributed to one specific rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { searchTransfers, TRANSFER_DEFAULTS } from '../js/engine/transfers.js';
import { validatePlan } from '../js/engine/validate.js';
import { squadHorizonValue } from '../js/engine/lineup.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));
const rules = buildRules(read('fixtures', 'bootstrap.json'));

const GW = 6;
const HORIZON = 5;
// The per-gameweek discount the engine uses, so a "gain per gameweek" can be
// turned into a horizon gain in the test as well as in the code.
const DISCOUNT_SUM = [0, 1, 2, 3, 4].reduce((s, k) => s + Math.pow(TRANSFER_DEFAULTS.discount, k), 0);

// --- a flat synthetic world -------------------------------------------------

// The owned fifteen. Values are chosen so the best eleven is 3-4-3 and every
// forward starts, which keeps a forward upgrade a starting-eleven upgrade.
const OWNED = [
  { id: 1, position: 1, teamId: 1, xPoints: 4.0 },
  { id: 2, position: 1, teamId: 2, xPoints: 2.0 },
  { id: 3, position: 2, teamId: 9, xPoints: 4.5 },
  { id: 4, position: 2, teamId: 9, xPoints: 4.0 },
  { id: 5, position: 2, teamId: 9, xPoints: 3.5 },
  { id: 6, position: 2, teamId: 3, xPoints: 2.0 },
  { id: 7, position: 2, teamId: 4, xPoints: 1.5 },
  { id: 8, position: 3, teamId: 5, xPoints: 6.0 },
  { id: 9, position: 3, teamId: 6, xPoints: 5.5 },
  { id: 10, position: 3, teamId: 7, xPoints: 5.0 },
  { id: 11, position: 3, teamId: 8, xPoints: 4.5 },
  { id: 12, position: 3, teamId: 10, xPoints: 2.0 },
  { id: 13, position: 4, teamId: 11, xPoints: 5.0 },
  { id: 14, position: 4, teamId: 12, xPoints: 4.0 },
  { id: 15, position: 4, teamId: 13, xPoints: 3.0 },
];

function buildWorld({ agents = [], bank = 10, freeTransfers = 1, ownedOverrides = {} } = {}) {
  const players = new Map();
  const projRows = new Map();

  const add = (spec) => {
    players.set(spec.id, {
      id: spec.id,
      position: spec.position,
      teamId: spec.teamId,
      nowCost: spec.nowCost ?? 50,
      status: spec.status ?? 'a',
      chanceNext: spec.chanceNext ?? null,
      webName: `P${spec.id}`,
      setPieces: { penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null },
    });
    projRows.set(spec.id, Array.from({ length: HORIZON }, (_, k) => ({
      playerId: spec.id,
      gw: GW + k,
      fixtures: [{ fixtureId: 1, opponentId: 99, isHome: true, fdr: 3 }],
      pAppear: spec.pAppear ?? 1,
      pStart: spec.pAppear ?? 1,
      xMins: 90,
      xPoints: spec.xPoints,
      sd: 2,
      ceiling: spec.xPoints * 1.8,
      confidence: 'high',
    })));
  };

  const owned = OWNED.map(o => ({ ...o, ...(ownedOverrides[o.id] || {}) }));
  for (const spec of owned) add(spec);
  for (const spec of agents) add(spec);

  const projections = {
    gwFrom: GW,
    gwTo: GW + HORIZON - 1,
    byPlayer: projRows,
    get(id, gw) {
      const rows = projRows.get(id);
      const i = gw - GW;
      return rows && i >= 0 && i < rows.length ? rows[i] : null;
    },
  };

  const gameState = { rules, players, teams: new Map(), fixtures: [], events: [] };

  const squadState = {
    entryId: 1,
    gw: GW,
    picks: owned.map((o, i) => ({
      playerId: o.id,
      slot: i + 1,
      purchaseTenths: (o.selling ?? 45) - 5,
      sellingTenths: o.selling ?? 45,
    })),
    bankTenths: bank,
    squadValueTenths: owned.reduce((s, o) => s + (o.selling ?? 45), 0) + bank,
    freeTransfers,
    chipsUsed: [],
    chipsAvailable: [],
    source: 'picks',
  };

  return { players, projections, gameState, squadState };
}

function search(world, opts = {}) {
  return searchTransfers({
    squadState: world.squadState,
    projections: world.projections,
    gameState: world.gameState,
    rules,
    horizon: HORIZON,
    opts,
  });
}

const positionsOf = (world, ids) => ids.map(id => world.players.get(id).position).sort();

// --- every returned plan is legal and affordable ----------------------------

test('every returned plan passes the legality gate on its own', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 6.5, nowCost: 55 },
      { id: 21, position: 3, teamId: 15, xPoints: 7.0, nowCost: 55 },
      { id: 22, position: 2, teamId: 16, xPoints: 5.5, nowCost: 52 },
      { id: 23, position: 1, teamId: 17, xPoints: 4.5, nowCost: 45 },
      { id: 24, position: 4, teamId: 18, xPoints: 2.0, nowCost: 40 },
    ],
    freeTransfers: 2,
  });
  const plans = search(world);
  assert.ok(plans.length > 1);
  for (const plan of plans) {
    const result = validatePlan(plan, world.squadState, world.gameState, rules);
    assert.deepEqual(result.violations, [], `plan ${plan.key}: ${JSON.stringify(result.violations)}`);
    assert.ok(plan.bankAfterTenths >= 0);
  }
});

test('bank arithmetic is exact to the tenth on every plan', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 6.5, nowCost: 53 },
      { id: 21, position: 3, teamId: 15, xPoints: 7.0, nowCost: 47 },
      { id: 22, position: 2, teamId: 16, xPoints: 5.5, nowCost: 41 },
    ],
    bank: 7,
    freeTransfers: 2,
  });
  for (const plan of search(world)) {
    const moneyIn = plan.transfersOut.reduce(
      (s, id) => s + world.squadState.picks.find(p => p.playerId === id).sellingTenths, 0);
    const moneyOut = plan.transfersIn.reduce((s, id) => s + world.players.get(id).nowCost, 0);
    assert.equal(plan.moneyInTenths, moneyIn);
    assert.equal(plan.moneyOutTenths, moneyOut);
    assert.equal(plan.bankBeforeTenths, 7);
    assert.equal(plan.bankAfterTenths, plan.bankBeforeTenths + moneyIn - moneyOut);
    assert.ok(Number.isInteger(plan.bankAfterTenths), 'money is integer tenths, never a float');
    assert.equal(plan.squadValueAfterTenths, plan.squad.reduce((s, id) => {
      const pick = world.squadState.picks.find(p => p.playerId === id);
      return s + (pick ? pick.sellingTenths : world.players.get(id).nowCost);
    }, 0) + plan.bankAfterTenths);
  }
});

test('affordability is judged on the selling price, not the current price', () => {
  // Forward 15 is worth 6.0 today but only sells for 4.5, because FPL takes
  // half the profit. With 1.0 in the bank that is 5.5 of spending power, so the
  // 6.0 forward below is out of reach even though a naive "sell at now_cost"
  // reading would make him affordable with 0.1 to spare.
  const world = buildWorld({
    ownedOverrides: { 15: { nowCost: 60, selling: 45 } },
    agents: [
      { id: 25, position: 4, teamId: 14, xPoints: 9.0, nowCost: 60 },
      { id: 26, position: 4, teamId: 15, xPoints: 8.0, nowCost: 55 },
    ],
    bank: 10,
  });
  const plans = search(world, { maxTransfers: 1 });
  assert.ok(plans.every(p => !p.transfersIn.includes(25)), 'the 6.0 forward is not affordable');
  // The control: one tenth cheaper and the same search takes him.
  assert.ok(plans.some(p => p.transfersIn.includes(26)), 'the 5.5 forward is affordable and is taken');
  const taken = plans.find(p => p.transfersIn.includes(26));
  assert.deepEqual(taken.transfersOut, [15]);
  assert.equal(taken.bankAfterTenths, 0);
});

test('the club limit is enforced inside the search, not left to the caller', () => {
  // The squad already holds three defenders from club 9. Player 30 is the best
  // player in the game by a distance, and he is a midfielder at club 9, so any
  // single transfer that brings him in sells a midfielder from somewhere else
  // and leaves four club-9 players in the squad.
  const world = buildWorld({
    agents: [{ id: 30, position: 3, teamId: 9, xPoints: 12.0, nowCost: 55 }],
  });
  const plans = search(world, { maxTransfers: 1 });
  assert.ok(plans.every(p => !p.transfersIn.includes(30)), 'a fourth club-9 player is never offered');

  // The control: the same player at a club the squad does not hold is taken
  // immediately, which proves the club limit is what blocked him.
  const elsewhere = buildWorld({
    agents: [{ id: 30, position: 3, teamId: 19, xPoints: 12.0, nowCost: 55 }],
  });
  const better = search(elsewhere, { maxTransfers: 1 });
  assert.deepEqual(better[0].transfersIn, [30]);
});

test('position identity is preserved, so squad counts survive every transfer', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 7.5, nowCost: 55 },
      { id: 21, position: 3, teamId: 15, xPoints: 7.0, nowCost: 50 },
      { id: 22, position: 2, teamId: 16, xPoints: 6.5, nowCost: 50 },
      { id: 23, position: 1, teamId: 17, xPoints: 5.0, nowCost: 45 },
    ],
    freeTransfers: 2,
    bank: 20,
  });
  const plans = search(world);
  assert.ok(plans.some(p => p.transferCount === 2), 'the two-transfer search should produce something');
  for (const plan of plans) {
    assert.deepEqual(positionsOf(world, plan.transfersIn), positionsOf(world, plan.transfersOut));
    const counts = new Map();
    for (const id of plan.squad) {
      const pos = world.players.get(id).position;
      counts.set(pos, (counts.get(pos) || 0) + 1);
    }
    for (const pos of Object.values(rules.positions)) {
      assert.equal(counts.get(pos.id), pos.squadSelect, `${pos.short} count`);
    }
  }
});

test('an unavailable player is never bought', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 12.0, nowCost: 50, status: 'u' },
      { id: 21, position: 4, teamId: 15, xPoints: 11.0, nowCost: 50, status: 'n' },
      { id: 22, position: 4, teamId: 16, xPoints: 6.0, nowCost: 50, status: 'd' },
    ],
  });
  const plans = search(world);
  assert.ok(plans.every(p => !p.transfersIn.includes(20) && !p.transfersIn.includes(21)));
  // A doubtful player is a judgement call, not a ban, so he stays in the pool.
  assert.ok(plans.some(p => p.transfersIn.includes(22)));
});

// --- the two judgement calls ------------------------------------------------

test('a marginal upgrade is rejected in favour of keeping the transfer', () => {
  // Forward 15 scores 3.0 a week. The replacement scores 3.13, which is a
  // 0.53-point gain across the five-gameweek horizon, well inside the model's
  // own error. A banked free transfer is worth more than that.
  const world = buildWorld({
    agents: [{ id: 20, position: 4, teamId: 14, xPoints: 3.13, nowCost: 55 }],
    freeTransfers: 1,
  });
  const plans = search(world);
  const roll = plans.find(p => p.transferCount === 0);
  const move = plans.find(p => p.transfersIn.includes(20));

  assert.ok(move, 'the marginal move should still be generated and ranked');
  const gain = move.horizonRaw - roll.horizonRaw;
  assert.ok(gain > 0.4 && gain < 0.7, `the horizon gain should be about half a point, was ${gain}`);
  assert.ok(Math.abs(gain - 0.13 * DISCOUNT_SUM) < 0.05);

  assert.equal(plans[0].transferCount, 0, 'rolling should win');
  assert.equal(plans[0].isRoll, true);
  assert.ok(roll.score > move.score);
  // Rolling one free transfer into two is worth the documented option value.
  assert.ok(Math.abs(roll.rollValue - TRANSFER_DEFAULTS.ftValuePoints) < 1e-9);
  assert.equal(move.rollValue, 0);
});

test('the same marginal upgrade is rejected even harder as a hit', () => {
  // With no free transfer banked the move costs four points plus the documented
  // margin, so a half-point gain is not close.
  const world = buildWorld({
    agents: [{ id: 20, position: 4, teamId: 14, xPoints: 3.13, nowCost: 55 }],
    freeTransfers: 0,
  });
  const plans = search(world);
  assert.equal(plans[0].transferCount, 0);
  const move = plans.find(p => p.transfersIn.includes(20));
  assert.equal(move.hits, 1);
  assert.equal(move.hitCostPoints, rules.hitCost);
  assert.equal(move.xPointsHorizon, move.horizonRaw - rules.hitCost);
  assert.ok(plans[0].score - move.score > rules.hitCost);
});

test('a hit is taken when the gain genuinely clears its cost and margin', () => {
  // Six points a week better, which is far beyond four points plus the margin.
  const world = buildWorld({
    agents: [{ id: 20, position: 4, teamId: 14, xPoints: 9.0, nowCost: 55 }],
    freeTransfers: 0,
  });
  const plans = search(world);
  assert.equal(plans[0].transferCount, 1);
  assert.deepEqual(plans[0].transfersIn, [20]);
  assert.equal(plans[0].hits, 1);
  assert.equal(plans[0].hitCostPoints, 4);
  assert.ok(plans[0].horizonGainVsHold > rules.hitCost + TRANSFER_DEFAULTS.hitMargin);
});

test('rolling wins when nothing in the pool clears the bar', () => {
  // Every available replacement is worse than what the manager already owns.
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 2.0, nowCost: 45 },
      { id: 21, position: 3, teamId: 15, xPoints: 1.5, nowCost: 45 },
      { id: 22, position: 2, teamId: 16, xPoints: 1.0, nowCost: 45 },
      { id: 23, position: 1, teamId: 17, xPoints: 1.0, nowCost: 45 },
    ],
    freeTransfers: 1,
  });
  const plans = search(world);
  assert.equal(plans[0].transferCount, 0);
  assert.equal(plans[0].isRoll, true);
  assert.equal(plans[0].rank, 1);
  assert.equal(plans[0].transfersIn.length, 0);
  assert.equal(plans[0].transfersOut.length, 0);
  assert.equal(plans[0].hitCostPoints, 0);
  assert.equal(plans[0].freeTransfersAfter, 1);
  assert.equal(plans[0].freeTransfersNextGw, 2);
});

test('rolling is worth nothing extra to a manager already at the free-transfer cap', () => {
  // The value that matters is the DIFFERENCE between holding and moving. With
  // one free transfer banked, spending it costs the option on next week's move.
  // With five banked, the sixth cannot exist, so spending one costs nothing and
  // the roll term must not tilt the decision.
  const agents = [
    { id: 20, position: 4, teamId: 14, xPoints: 3.13, nowCost: 55 },
    // A second marginal upgrade, so two-transfer plans exist to compare.
    { id: 21, position: 3, teamId: 15, xPoints: 2.13, nowCost: 45 },
  ];

  const one = search(buildWorld({ agents, freeTransfers: 1 }));
  const oneRoll = one.find(p => p.transferCount === 0);
  const oneMove = one.find(p => p.transferCount === 1);
  assert.ok(Math.abs((oneRoll.rollValue - oneMove.rollValue) - TRANSFER_DEFAULTS.ftValuePoints) < 1e-9);

  const capped = search(buildWorld({ agents, freeTransfers: rules.maxFreeTransfers }));
  const cappedRoll = capped.find(p => p.transferCount === 0);
  const cappedMove = capped.find(p => p.transferCount === 1);
  assert.equal(cappedRoll.rollValue - cappedMove.rollValue, 0);
  // Two transfers do cost a banked one, even at the cap.
  const cappedTwo = capped.find(p => p.transferCount === 2);
  assert.ok(Math.abs((cappedRoll.rollValue - cappedTwo.rollValue) - TRANSFER_DEFAULTS.ftValuePoints) < 1e-9);

  // And with the roll term neutral, the same marginal upgrade that was rejected
  // on one free transfer is now taken, because it costs the manager nothing.
  assert.equal(capped[0].transferCount, 1);
  assert.deepEqual(capped[0].transfersIn, [20]);
});

test('the transfer accounting a plan reports walks correctly across every bank level', () => {
  // The search reimplemented `min(count, free)`, `max(0, count - free)` and
  // `min(cap, kept + 1)` itself. Walking every bank level is what says the one
  // implementation left is applied consistently rather than being right at 1 and
  // wrong at 0 or at the cap.
  const agents = [
    { id: 20, position: 4, teamId: 14, xPoints: 9, nowCost: 45 },
    { id: 21, position: 3, teamId: 15, xPoints: 9, nowCost: 45 },
  ];

  for (let freeTransfers = 0; freeTransfers <= rules.maxFreeTransfers; freeTransfers++) {
    const plans = search(buildWorld({ agents, freeTransfers }));
    for (const plan of plans) {
      const used = Math.min(plan.transferCount, freeTransfers);
      assert.equal(plan.freeTransfersUsed, used, `${freeTransfers} banked, ${plan.transferCount} made`);
      assert.equal(plan.freeTransfersAfter, freeTransfers - used);
      assert.equal(plan.hits, plan.transferCount - used);
      assert.equal(plan.hitCostPoints, plan.hits * rules.hitCost);
      assert.equal(
        plan.freeTransfersNextGw,
        Math.min(rules.maxFreeTransfers, plan.freeTransfersAfter + 1),
        'next gameweek is what survives plus the arriving one, capped',
      );
      assert.ok(plan.freeTransfersNextGw >= 1, 'and one always arrives');
    }
  }
});

// --- selling a doubt: the retention credit -----------------------------------
//
// The horizon is three gameweeks and a squad is not. A doubt that clears in two
// weeks still collapses a player's horizon value, and the search can read that
// collapse as a permanent decline, sell him, and buy him back when he is fit.
// `retentionCredit` is the charge that prices the round trip. It ships at zero
// because it lost points on replay (experiments/transfer-churn.md), so these
// tests pass the credit explicitly: they pin the mechanism so the number stays
// reproducible, and they pin that the shipped default changes nothing.

// One agent, one position, so every candidate the search can build is returned
// and a specific swap can be named.
const CREDIT = 0.5;
const doubtWorld = ({ chanceNext, credit = CREDIT }) => ({
  world: buildWorld({
    agents: [{ id: 20, position: 4, teamId: 14, xPoints: 6.5, nowCost: 50 }],
    ownedOverrides: { 14: { xPoints: 3.1 }, 15: { xPoints: 3.0, chanceNext } },
    freeTransfers: 1,
  }),
  opts: { retentionCredit: credit },
});

test('a priced doubt moves the sale onto a fit team-mate', () => {
  // Forwards 14 and 15 are worth 3.1 and 3.0 a week, so on the horizon alone the
  // weaker one goes. Player 15 carries a 25% chance of playing. Selling him
  // banks a gain that a fit version of him would never have handed over, so the
  // 0.1-a-week difference stops being the whole story and the fit player goes
  // instead. The transfer still happens: this is a charge on churn, not a brake
  // on transfers.
  const unpriced = doubtWorld({ chanceNext: 0.25, credit: 0 });
  assert.deepEqual(search(unpriced.world, unpriced.opts)[0].transfersOut, [15]);

  const priced = doubtWorld({ chanceNext: 0.25 });
  const best = search(priced.world, priced.opts)[0];
  assert.deepEqual(best.transfersOut, [14]);
  assert.deepEqual(best.transfersIn, [20]);
  assert.equal(best.churnCost, 0, 'selling the fit player is not churn');
});

test('the charge is the doubt times the gain times the credit, and never more than the gain', () => {
  const { world, opts } = doubtWorld({ chanceNext: 0.25 });
  const sellDoubt = search(world, opts)
    .find(p => p.transfersOut.length === 1 && p.transfersOut[0] === 15);

  const gain = (6.5 - 3.0) * DISCOUNT_SUM;
  const expected = CREDIT * 0.75 * gain;
  assert.ok(Math.abs(sellDoubt.churnCost - expected) < 1e-9, `charge was ${sellDoubt.churnCost}, expected ${expected}`);

  // Bounded by the gain, so it can never make a losing transfer look sensible.
  assert.ok(sellDoubt.churnCost <= gain);

  // A shallower doubt costs less, in proportion.
  const shallower = doubtWorld({ chanceNext: 0.5 });
  const half = search(shallower.world, shallower.opts)
    .find(p => p.transfersOut.length === 1 && p.transfersOut[0] === 15);
  assert.ok(Math.abs(half.churnCost - sellDoubt.churnCost * (0.5 / 0.75)) < 1e-9);
});

test('the charge is zero when no owned player is doubtful', () => {
  const { world, opts } = doubtWorld({ chanceNext: null });
  const plans = search(world, opts);
  assert.ok(plans.length > 1);
  assert.ok(plans.every(p => p.churnCost === 0));
  assert.deepEqual(plans[0].transfersOut, [15], 'the weaker forward goes, as he always did');
});

test('a player who cannot play at all is sold without a charge', () => {
  // Availability zero is the game saying he is out, not that he might be. There
  // is no doubt to be wrong about, and protecting him would be the engine
  // refusing to move on from a season-ending injury.
  const { world, opts } = doubtWorld({ chanceNext: 0 });
  const plans = search(world, opts);
  assert.ok(plans.every(p => p.churnCost === 0));
  assert.deepEqual(plans[0].transfersOut, [15]);
});

test('rolling is never charged for churn', () => {
  const { world, opts } = doubtWorld({ chanceNext: 0.25 });
  const roll = search(world, opts).find(p => p.transferCount === 0);
  assert.equal(roll.churnCost, 0);
  assert.equal(roll.score, roll.xPointsHorizon + roll.rollValue);
});

test('the shipped default prices no doubt at all, so a rejected experiment cannot leak into a plan', () => {
  // The credit lost points on replay and is off. Turning it off has to mean
  // exactly nothing happens, not "a smaller version of it happens".
  assert.equal(TRANSFER_DEFAULTS.retentionCredit, 0);

  const doubtful = buildWorld({
    agents: [{ id: 20, position: 4, teamId: 14, xPoints: 6.5, nowCost: 50 }],
    ownedOverrides: { 14: { xPoints: 3.1 }, 15: { xPoints: 3.0, chanceNext: 0.25 } },
    freeTransfers: 1,
  });
  const shipped = search(doubtful);
  assert.ok(shipped.every(p => p.churnCost === 0));
  assert.deepEqual(shipped[0].transfersOut, [15]);

  const zeroed = search(doubtful, { retentionCredit: 0 });
  assert.deepEqual(shipped.map(p => p.key), zeroed.map(p => p.key));
  assert.deepEqual(shipped.map(p => p.score), zeroed.map(p => p.score));
});

test('a clear upgrade is taken rather than rolled', () => {
  const world = buildWorld({
    agents: [{ id: 20, position: 4, teamId: 14, xPoints: 8.0, nowCost: 55 }],
    freeTransfers: 1,
  });
  const plans = search(world);
  assert.equal(plans[0].transferCount, 1);
  assert.deepEqual(plans[0].transfersOut, [15]);
  assert.deepEqual(plans[0].transfersIn, [20]);
  assert.equal(plans[0].hits, 0);
  assert.equal(plans[0].freeTransfersUsed, 1);
  assert.equal(plans[0].freeTransfersAfter, 0);
});

// --- the objective the decision is made under -------------------------------

test('the recommendation is decided under the objective the squad is played with', () => {
  // The wide search ranks squads with the fast lineup model, which cannot
  // represent starting a doubtful player because a same-position substitute
  // covers him. The squad is then PLAYED with the exact model, which can. Here
  // that difference is the whole decision:
  //
  //   owned keeper 1: 4.0 a week, nailed
  //   owned keeper 2: 1.0 a week, nailed, the reserve
  //   for sale, 4.5m each: keeper 20, 3.0 a week nailed
  //                        keeper 21, 2.9 a week but a coin flip to play
  //
  // Under the fast objective both signings are worth exactly what holding is
  // worth, because the reserve keeper never comes on behind a nailed starter.
  // Under the exact objective signing 21 is worth two points a gameweek: he
  // starts, and keeper 1 becomes real cover behind him.
  const world = buildWorld({
    ownedOverrides: { 2: { xPoints: 1.0 } },
    agents: [
      { id: 20, position: 1, teamId: 14, xPoints: 3.0, nowCost: 45 },
      { id: 21, position: 1, teamId: 15, xPoints: 2.9, pAppear: 0.5, nowCost: 45 },
    ],
    freeTransfers: 1,
  });

  // Deciding on the fast objective alone (no exact re-rank) cannot separate
  // the two signings from doing nothing, so it rolls the transfer.
  const fastOnly = search(world, { rerankCandidates: 0 });
  assert.equal(fastOnly[0].transferCount, 0, 'the fast objective sees no gain worth taking');

  const reranked = search(world);
  assert.equal(reranked[0].transferCount, 1);
  assert.deepEqual(reranked[0].transfersIn, [21], 'the doubtful keeper with cover behind him is the better squad');
  assert.deepEqual(reranked[0].transfersOut, [2]);
  assert.ok(reranked[0].horizonRaw > fastOnly[0].horizonRaw);

  // And the signing the fast objective would have preferred on paper, the
  // nailed keeper who never gets on the pitch, is ranked below it.
  const nailed = reranked.find(p => p.transfersIn.includes(20));
  assert.ok(nailed);
  assert.ok(nailed.score < reranked[0].score);
});

test('every returned plan is scored under the exact lineup objective', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 6.5, nowCost: 55 },
      { id: 21, position: 3, teamId: 15, xPoints: 7.0, nowCost: 50 },
      { id: 22, position: 2, teamId: 16, xPoints: 5.5, nowCost: 50, pAppear: 0.6 },
      { id: 23, position: 1, teamId: 17, xPoints: 4.5, nowCost: 45, pAppear: 0.7 },
      { id: 24, position: 4, teamId: 18, xPoints: 5.0, nowCost: 40, pAppear: 0.8 },
    ],
    freeTransfers: 2,
    bank: 15,
  });
  const plans = search(world);
  assert.ok(plans.length > 5);

  for (const plan of plans) {
    const exact = squadHorizonValue(plan.squad, world.projections, GW, rules, {
      gameState: world.gameState,
      risk: TRANSFER_DEFAULTS.risk,
      horizon: HORIZON,
      discount: TRANSFER_DEFAULTS.discount,
      mode: 'exact',
    }).total;
    assert.ok(
      Math.abs(plan.horizonRaw - exact) < 1e-9,
      `plan ${plan.key} was ranked on ${plan.horizonRaw} but is played for ${exact}`,
    );
    assert.equal(plan.xPointsHorizon, plan.horizonRaw - plan.hitCostPoints);
  }

  // The gain over holding is exact against exact, not exact against fast.
  const roll = plans.find(p => p.isRoll);
  for (const plan of plans) {
    assert.ok(Math.abs(plan.horizonGainVsHold - (plan.horizonRaw - roll.horizonRaw)) < 1e-9);
  }
});

test('the exact shortlist is wider than the list it returns', () => {
  // The re-rank exists to change the order, so it has to look at more
  // candidates than it reports, or a candidate can never be promoted into the
  // set the user sees.
  assert.ok(TRANSFER_DEFAULTS.rerankCandidates > TRANSFER_DEFAULTS.maxCandidates);
});

// --- ranking and reporting --------------------------------------------------

test('alternatives are ranked best first and the roll is always among them', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 8.0, nowCost: 55 },
      { id: 21, position: 3, teamId: 15, xPoints: 7.5, nowCost: 50 },
      { id: 22, position: 2, teamId: 16, xPoints: 7.0, nowCost: 50 },
      { id: 23, position: 1, teamId: 17, xPoints: 6.0, nowCost: 45 },
      { id: 24, position: 4, teamId: 18, xPoints: 6.5, nowCost: 45 },
    ],
    freeTransfers: 2,
    bank: 15,
  });
  const plans = search(world);
  for (let i = 1; i < plans.length; i++) {
    assert.ok(plans[i - 1].score >= plans[i].score - 1e-12, `plan ${i} out of order`);
    assert.equal(plans[i].rank, i + 1);
  }
  assert.equal(plans[0].rank, 1);
  assert.ok(plans.some(p => p.isRoll), 'holding is always an option the user can see');
  // The primary recommendation is distinct from the alternatives.
  assert.equal(new Set(plans.map(p => p.key)).size, plans.length);
  assert.ok(plans.length <= TRANSFER_DEFAULTS.maxCandidates + 1);
});

test('each plan reports the whole ledger the UI has to render', () => {
  const world = buildWorld({
    agents: [{ id: 20, position: 4, teamId: 14, xPoints: 8.0, nowCost: 55 }],
    freeTransfers: 1,
  });
  const plan = search(world)[0];
  for (const key of [
    'gw', 'transfersOut', 'transfersIn', 'transferCount', 'freeTransfersUsed', 'freeTransfersAfter',
    'hits', 'hitCostPoints', 'bankBeforeTenths', 'moneyInTenths', 'moneyOutTenths', 'bankAfterTenths',
    'squad', 'startingXI', 'formation', 'bench', 'captain', 'viceCaptain',
    'xPointsGw', 'xPointsNet', 'xPointsHorizon', 'sd',
  ]) {
    assert.ok(plan[key] !== undefined, `plan is missing ${key}`);
  }
  assert.equal(plan.xPointsNet, plan.xPointsGw - plan.hitCostPoints);
  assert.equal(plan.squad.length, rules.squadSize);
  assert.equal(plan.startingXI.length, rules.starters);
  assert.ok(plan.startingXI.includes(plan.captain));
  assert.ok(plan.startingXI.includes(plan.viceCaptain));
  assert.notEqual(plan.captain, plan.viceCaptain);
  assert.ok(plan.sd > 0);
  assert.equal(plan.chip, null);
});

test('the search is deterministic', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 8.0, nowCost: 55 },
      { id: 21, position: 3, teamId: 15, xPoints: 7.5, nowCost: 50 },
    ],
    freeTransfers: 2,
  });
  const a = search(world).map(p => `${p.key}:${p.score.toFixed(9)}`);
  const b = search(world).map(p => `${p.key}:${p.score.toFixed(9)}`);
  assert.deepEqual(a, b);
});

test('hits beyond the configured maximum are never generated', () => {
  const world = buildWorld({
    agents: [
      { id: 20, position: 4, teamId: 14, xPoints: 12.0, nowCost: 50 },
      { id: 21, position: 3, teamId: 15, xPoints: 12.0, nowCost: 50 },
    ],
    freeTransfers: 0,
  });
  const plans = search(world, { maxHits: 1 });
  assert.ok(plans.every(p => p.hits <= 1));
  assert.ok(plans.every(p => p.transferCount <= 1));
});

test('searchTransfers refuses a squad that is not a full squad', () => {
  const world = buildWorld({});
  world.squadState.picks = world.squadState.picks.slice(0, 14);
  assert.throws(() => search(world), /full squad of 15/);
});
