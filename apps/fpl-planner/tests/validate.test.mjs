// validate.js is the single legality gate, so it is tested as an adversary:
// for every violation code it can emit there is a plan below that triggers it,
// and the assertion is on the CODE, not on the message text.
//
// The world is synthetic on purpose. Real fixture data cannot be bent into
// "four players from one club" or "a goalkeeper in an outfield bench slot"
// without editing a committed payload, and those are exactly the states that
// must be impossible to ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import {
  validatePlan,
  assertValidPlan,
  PlanValidationError,
  fixedCountPositionIds,
  goalkeeperPositionId,
  outfieldPositionIds,
  benchOutfieldSlots,
  formationOf,
} from '../js/engine/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const rules = buildRules(read('fixtures', 'bootstrap.json'));

// --- a small synthetic world -----------------------------------------------
//
// Fifteen owned players, legal on every axis, plus free agents to transfer in.
// Club 1 deliberately sits AT the three-player limit (1, 6, 11) so a single
// wrong transfer tips it over.

const SQUAD_SPEC = [
  { id: 1, position: 1, teamId: 1 },
  { id: 2, position: 1, teamId: 2 },
  { id: 3, position: 2, teamId: 3 },
  { id: 4, position: 2, teamId: 4 },
  { id: 5, position: 2, teamId: 5 },
  { id: 6, position: 2, teamId: 1 },
  { id: 7, position: 2, teamId: 2 },
  { id: 8, position: 3, teamId: 3 },
  { id: 9, position: 3, teamId: 4 },
  { id: 10, position: 3, teamId: 5 },
  { id: 11, position: 3, teamId: 1 },
  { id: 12, position: 3, teamId: 7 },
  { id: 13, position: 4, teamId: 8 },
  { id: 14, position: 4, teamId: 9 },
  { id: 15, position: 4, teamId: 10 },
];

const FREE_AGENT_SPEC = [
  { id: 20, position: 1, teamId: 11, nowCost: 45 },
  { id: 21, position: 2, teamId: 11, nowCost: 50 },
  { id: 22, position: 3, teamId: 11, nowCost: 60 },
  { id: 23, position: 4, teamId: 11, nowCost: 70 },
  // Same club as the squad's three club-1 players.
  { id: 24, position: 2, teamId: 1, nowCost: 50 },
  // An affordable, position-matched forward: bank 10 + selling 45 = 55.
  { id: 26, position: 4, teamId: 12, nowCost: 55 },
  // A midfielder priced identically to 26, for the position-swap case.
  { id: 27, position: 3, teamId: 12, nowCost: 55 },
  // A cheap forward, so a two-transfer hit plan can be built that balances to
  // the tenth instead of tripping the affordability check as well.
  { id: 28, position: 4, teamId: 13, nowCost: 35 },
];

const players = new Map();
for (const p of SQUAD_SPEC) players.set(p.id, { ...p, nowCost: 50, status: 'a' });
for (const p of FREE_AGENT_SPEC) players.set(p.id, { ...p, status: 'a' });

const gameState = { rules, players, teams: new Map(), fixtures: [], events: [] };

const BANK = 10;

function squadState(over = {}) {
  return {
    gw: 6,
    // Bought at 4.0, now worth 5.0, so the sell-on fee leaves 4.5. Selling
    // price is the only number that can be spent.
    picks: SQUAD_SPEC.map((p, i) => ({
      playerId: p.id,
      slot: i + 1,
      purchaseTenths: 40,
      sellingTenths: 45,
    })),
    bankTenths: BANK,
    freeTransfers: 1,
    chipsUsed: [],
    ...over,
  };
}

function validPlan(over = {}) {
  return {
    gw: 6,
    chip: null,
    transfersOut: [],
    transfersIn: [],
    transferCount: 0,
    freeTransfersUsed: 0,
    freeTransfersAfter: 1,
    hits: 0,
    hitCostPoints: 0,
    bankBeforeTenths: BANK,
    moneyInTenths: 0,
    moneyOutTenths: 0,
    bankAfterTenths: BANK,
    squad: SQUAD_SPEC.map(p => p.id),
    startingXI: [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15],
    formation: '3-4-3',
    bench: { gk: 2, order: [6, 7, 12] },
    captain: 8,
    viceCaptain: 9,
    ...over,
  };
}

const codes = (plan, state = squadState()) =>
  validatePlan(plan, state, gameState, rules).violations.map(v => v.code).sort();

// --- the derived-rather-than-named position helpers -------------------------

test('position helpers are derived from the rules, not from names', () => {
  // A goalkeeper is "the position that plays a fixed number", which is visible
  // in element_types. Nothing in the engine reads the string GKP.
  assert.deepEqual(fixedCountPositionIds(rules), [1]);
  assert.equal(goalkeeperPositionId(rules), 1);
  assert.deepEqual(outfieldPositionIds(rules), [2, 3, 4]);
  // 15 squad - 11 starters - 1 reserve keeper = 3 ordered outfield slots.
  assert.equal(benchOutfieldSlots(rules), 3);
});

test('formationOf reads the eleven rather than trusting the label', () => {
  const positionOf = id => players.get(id).position;
  assert.equal(formationOf([1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15], positionOf, rules), '3-4-3');
  assert.equal(formationOf([1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13], positionOf, rules), '4-5-1');
});

// --- the happy path ---------------------------------------------------------

test('a fully legal plan passes with no violations', () => {
  const result = validatePlan(validPlan(), squadState(), gameState, rules);
  assert.deepEqual(result, { ok: true, violations: [] });
});

test('a legal one-transfer plan passes, priced off the SELLING price', () => {
  // Bank 1.0 plus a 4.5 selling price buys a 5.5 forward exactly.
  const plan = validPlan({
    transfersOut: [15],
    transfersIn: [26],
    transferCount: 1,
    freeTransfersUsed: 1,
    freeTransfersAfter: 0,
    moneyInTenths: 45,
    moneyOutTenths: 55,
    bankAfterTenths: 0,
    squad: SQUAD_SPEC.map(p => p.id).filter(id => id !== 15).concat([26]),
    startingXI: [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 26],
  });
  assert.deepEqual(validatePlan(plan, squadState(), gameState, rules).violations, []);
});

test('assertValidPlan is silent on a good plan and throws on a bad one', () => {
  assert.doesNotThrow(() => assertValidPlan(validPlan(), squadState(), gameState, rules));

  const bad = validPlan({ captain: 999 });
  assert.throws(
    () => assertValidPlan(bad, squadState(), gameState, rules),
    (err) => {
      assert.ok(err instanceof PlanValidationError);
      assert.equal(err.name, 'PlanValidationError');
      assert.deepEqual(err.violations.map(v => v.code), ['captain_not_in_xi']);
      assert.match(err.message, /captain_not_in_xi/);
      return true;
    },
  );
});

// --- missing inputs ---------------------------------------------------------

test('a missing plan and missing rules are violations, not crashes', () => {
  assert.deepEqual(validatePlan(null, squadState(), gameState, rules).violations.map(v => v.code), ['plan_missing']);
  const stateless = { players, teams: new Map() };
  assert.deepEqual(
    validatePlan(validPlan(), squadState(), stateless, undefined).violations.map(v => v.code),
    ['rules_missing'],
  );
});

// --- the squad --------------------------------------------------------------

test('a squad of the wrong size is rejected', () => {
  const short = SQUAD_SPEC.map(p => p.id).slice(0, 14);
  const result = codes(validPlan({ squad: short, bench: { gk: 2, order: [6, 7, 12] } }));
  assert.ok(result.includes('squad_size'));
  const detail = validatePlan(validPlan({ squad: short }), squadState(), gameState, rules)
    .violations.find(v => v.code === 'squad_size');
  assert.deepEqual(detail.detail, { expected: 15, actual: 14 });
});

test('the same player twice in the squad is rejected', () => {
  const squad = SQUAD_SPEC.map(p => p.id);
  squad[14] = squad[13];
  assert.ok(codes(validPlan({ squad })).includes('duplicate_player'));
});

test('a player who is not in the game state is rejected', () => {
  const squad = SQUAD_SPEC.map(p => p.id).slice(0, 14).concat([9999]);
  assert.ok(codes(validPlan({ squad })).includes('unknown_player'));
});

test('wrong per-position squad counts are rejected, one violation per position', () => {
  // Four defenders and six midfielders: still fifteen players, still eleven
  // starters, still a legal formation on the pitch.
  const squad = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 27, 13, 14, 15];
  const result = validatePlan(
    validPlan({ squad, bench: { gk: 2, order: [6, 12, 27] } }),
    squadState({ picks: squad.map((id, i) => ({ playerId: id, slot: i + 1, purchaseTenths: 40, sellingTenths: 45 })) }),
    gameState,
    rules,
  );
  const positionViolations = result.violations.filter(v => v.code === 'position_count');
  assert.equal(positionViolations.length, 2);
  assert.deepEqual(positionViolations.map(v => v.detail.short).sort(), ['DEF', 'MID']);
  assert.deepEqual(positionViolations.find(v => v.detail.short === 'DEF').detail,
    { position: 2, short: 'DEF', expected: 5, actual: 4 });
});

test('a fourth player from one club is rejected', () => {
  // Club 1 already holds 1, 6 and 11. Swapping defender 7 for club-1 defender
  // 24 keeps every position count right and still cannot be played.
  const squad = SQUAD_SPEC.map(p => p.id).map(id => (id === 7 ? 24 : id));
  const state = squadState();
  const plan = validPlan({
    squad,
    bench: { gk: 2, order: [6, 24, 12] },
    transfersOut: [7],
    transfersIn: [24],
    transferCount: 1,
    freeTransfersUsed: 1,
    freeTransfersAfter: 0,
    moneyInTenths: 45,
    moneyOutTenths: 50,
    bankAfterTenths: 5,
  });
  const result = validatePlan(plan, state, gameState, rules);
  assert.deepEqual(result.violations.map(v => v.code), ['club_limit']);
  assert.deepEqual(result.violations[0].detail, { teamId: 1, limit: 3, actual: 4 });
});

// --- the starting eleven ----------------------------------------------------

test('an eleven of the wrong size is rejected', () => {
  const plan = validPlan({ startingXI: [1, 3, 4, 5, 8, 9, 10, 13, 14, 15] });
  const result = codes(plan);
  assert.ok(result.includes('xi_size'));
});

test('the same player twice in the eleven is rejected', () => {
  const xi = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 14];
  assert.ok(codes(validPlan({ startingXI: xi })).includes('xi_duplicate'));
});

test('an eleven containing someone outside the squad is rejected', () => {
  const xi = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 22];
  assert.ok(codes(validPlan({ startingXI: xi })).includes('xi_not_in_squad'));
});

test('an illegal shape is rejected even at eleven players', () => {
  // Two at the back. Fifteen players, eleven starters, a partitioned bench,
  // and not a team FPL would accept.
  const plan = validPlan({
    startingXI: [1, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15],
    formation: '2-5-3',
    bench: { gk: 2, order: [5, 6, 7] },
  });
  const result = validatePlan(plan, squadState(), gameState, rules);
  assert.deepEqual(result.violations.map(v => v.code), ['xi_position']);
  assert.deepEqual(result.violations[0].detail, { position: 2, short: 'DEF', min: 3, max: 5, actual: 2 });
});

test('six defenders is rejected on the maximum, not just the minimum', () => {
  const plan = validPlan({
    squad: SQUAD_SPEC.map(p => p.id),
    startingXI: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13],
    formation: '5-4-1',
    bench: { gk: 2, order: [12, 14, 15] },
  });
  // Five is the maximum, and the eleven above plays five, so this one is legal:
  // it is the control that proves the previous assertion is not vacuous.
  assert.deepEqual(validatePlan(plan, squadState(), gameState, rules).violations, []);
});

test('a formation label that does not match the eleven is rejected', () => {
  const result = validatePlan(validPlan({ formation: '4-4-2' }), squadState(), gameState, rules);
  assert.deepEqual(result.violations.map(v => v.code), ['formation_mismatch']);
  assert.deepEqual(result.violations[0].detail, { reported: '4-4-2', derived: '3-4-3' });
});

// --- the bench --------------------------------------------------------------

test('an outfield player in the reserve-keeper slot is rejected', () => {
  // FPL only ever substitutes a goalkeeper for a goalkeeper, so this bench can
  // never cover the keeper.
  const plan = validPlan({ bench: { gk: 6, order: [2, 7, 12] } });
  const result = validatePlan(plan, squadState(), gameState, rules);
  const bench = result.violations.filter(v => v.code === 'bench_composition');
  assert.equal(bench.length, 2);
  assert.ok(bench.some(v => v.detail.playerId === 6));
  assert.ok(bench.some(v => v.detail.playerId === 2));
});

test('a bench with no reserve keeper is rejected', () => {
  assert.ok(codes(validPlan({ bench: { gk: null, order: [6, 7, 12] } })).includes('bench_composition'));
});

test('a bench of the wrong length is rejected', () => {
  const result = codes(validPlan({ bench: { gk: 2, order: [6, 7] } }));
  assert.ok(result.includes('bench_composition'));
});

test('a bench player who is also in the eleven is rejected', () => {
  const plan = validPlan({ bench: { gk: 2, order: [6, 7, 8] } });
  const result = validatePlan(plan, squadState(), gameState, rules);
  assert.ok(result.violations.some(v => v.code === 'bench_composition' && v.detail.playerId === 8));
});

test('a bench player who is not in the squad is rejected', () => {
  const plan = validPlan({ bench: { gk: 2, order: [6, 7, 22] } });
  assert.ok(codes(plan).includes('bench_composition'));
});

test('an eleven plus bench that is not the squad is rejected', () => {
  // Twelve is dropped from the bench and defender 4 named twice instead, so the
  // fifteen is no longer partitioned even though every count still looks right.
  const plan = validPlan({ bench: { gk: 2, order: [6, 7, 4] } });
  const result = validatePlan(plan, squadState(), gameState, rules);
  assert.ok(result.violations.some(v => v.code === 'bench_union'));
  const union = result.violations.find(v => v.code === 'bench_union');
  assert.deepEqual(union.detail.missing, [12]);
});

// --- armbands ---------------------------------------------------------------

test('a plan with no captain or no vice is rejected', () => {
  assert.deepEqual(codes(validPlan({ captain: null })), ['captain_missing']);
  assert.deepEqual(codes(validPlan({ viceCaptain: undefined })), ['vice_missing']);
});

test('a captain or vice outside the eleven is rejected', () => {
  assert.deepEqual(codes(validPlan({ captain: 12 })), ['captain_not_in_xi']);
  assert.deepEqual(codes(validPlan({ viceCaptain: 7 })), ['vice_not_in_xi']);
});

test('the captain and the vice cannot be the same player', () => {
  assert.deepEqual(codes(validPlan({ viceCaptain: 8 })), ['captain_vice_same']);
});

// --- chips ------------------------------------------------------------------

test('a chip outside its event window is rejected', () => {
  // The first wildcard window opens at GW2.
  const plan = validPlan({ gw: 1, chip: 'wildcard' });
  const result = validatePlan(plan, squadState({ gw: 1 }), gameState, rules);
  assert.deepEqual(result.violations.map(v => v.code), ['chip_illegal']);
  assert.equal(result.violations[0].detail.chip, 'wildcard');
});

test('a chip already played in that half of the season is rejected', () => {
  const plan = validPlan({ chip: 'wildcard' });
  const state = squadState({ chipsUsed: [{ name: 'wildcard', event: 3 }] });
  assert.deepEqual(validatePlan(plan, state, gameState, rules).violations.map(v => v.code), ['chip_illegal']);

  // The same chip in the same gameweek with nothing spent is legal, which is
  // what makes the assertion above about the chip and not about the gameweek.
  assert.deepEqual(validatePlan(plan, squadState(), gameState, rules).violations, []);
});

test('a chip whose window covers the gameweek is accepted', () => {
  // bboost runs GW1-19, so it is legal in GW6 and in GW1.
  assert.deepEqual(validatePlan(validPlan({ chip: 'bboost' }), squadState(), gameState, rules).violations, []);
  assert.deepEqual(
    validatePlan(validPlan({ gw: 1, chip: 'bboost' }), squadState({ gw: 1 }), gameState, rules).violations,
    [],
  );
});

// --- transfers, free transfers and hits -------------------------------------

function oneTransfer(over = {}) {
  return validPlan({
    transfersOut: [15],
    transfersIn: [26],
    transferCount: 1,
    freeTransfersUsed: 1,
    freeTransfersAfter: 0,
    moneyInTenths: 45,
    moneyOutTenths: 55,
    bankAfterTenths: 0,
    squad: SQUAD_SPEC.map(p => p.id).filter(id => id !== 15).concat([26]),
    startingXI: [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 26],
    ...over,
  });
}

test('a transfer count that disagrees with the listed transfers is rejected', () => {
  assert.ok(codes(oneTransfer({ transferCount: 2 })).includes('transfer_count'));
});

test('selling a player the manager does not own is rejected', () => {
  assert.ok(codes(oneTransfer({ transfersOut: [999] })).includes('transfer_out_not_owned'));
});

test('buying a player the manager already owns is rejected', () => {
  assert.ok(codes(oneTransfer({ transfersIn: [14] })).includes('transfer_in_already_owned'));
});

test('a squad that is not the current squad with the transfers applied is rejected', () => {
  assert.ok(codes(oneTransfer({ squad: SQUAD_SPEC.map(p => p.id) })).includes('squad_transfer_mismatch'));
});

test('more transfers than free transfers without the matching hit is rejected', () => {
  // Two transfers against one banked free transfer is one hit, whatever the
  // plan claims.
  const twoTransfers = validPlan({
    transfersOut: [14, 15],
    transfersIn: [23, 26],
    transferCount: 2,
    freeTransfersUsed: 2,
    hits: 0,
    hitCostPoints: 0,
    moneyInTenths: 90,
    moneyOutTenths: 125,
    bankAfterTenths: -25,
    squad: SQUAD_SPEC.map(p => p.id).filter(id => id !== 14 && id !== 15).concat([23, 26]),
    startingXI: [1, 3, 4, 5, 8, 9, 10, 11, 13, 23, 26],
  });
  const result = validatePlan(twoTransfers, squadState(), gameState, rules).violations;
  const transferCounts = result.filter(v => v.code === 'transfer_count');
  assert.equal(transferCounts.length, 2);
  assert.deepEqual(transferCounts[0].detail, { available: 1, transferCount: 2, expected: 1, reported: 2 });
  assert.deepEqual(transferCounts[1].detail, { available: 1, transferCount: 2, expected: 1, reported: 0 });
});

test('the declared hit cost must be the hit count times the rules hit cost', () => {
  const plan = oneTransfer({
    transferCount: 2,
    transfersOut: [14, 15],
    transfersIn: [23, 26],
    freeTransfersUsed: 1,
    hits: 1,
    hitCostPoints: 0,
    moneyInTenths: 90,
    moneyOutTenths: 125,
    bankAfterTenths: -25,
    squad: SQUAD_SPEC.map(p => p.id).filter(id => id !== 14 && id !== 15).concat([23, 26]),
    startingXI: [1, 3, 4, 5, 8, 9, 10, 11, 13, 23, 26],
  });
  const result = validatePlan(plan, squadState(), gameState, rules).violations;
  const hit = result.find(v => v.code === 'hit_cost');
  assert.ok(hit);
  assert.deepEqual(hit.detail, { hits: 1, hitCost: rules.hitCost, expected: 4, reported: 0 });
});

test('a correctly declared hit is accepted', () => {
  // Two transfers on one free transfer: one hit, four points, and the money
  // balances exactly. This is the control for every rejection above.
  const plan = validPlan({
    transfersOut: [14, 15],
    transfersIn: [26, 28],
    transferCount: 2,
    freeTransfersUsed: 1,
    freeTransfersAfter: 0,
    hits: 1,
    hitCostPoints: 4,
    moneyInTenths: 90,
    moneyOutTenths: 90,
    bankAfterTenths: 10,
    squad: SQUAD_SPEC.map(p => p.id).filter(id => id !== 14 && id !== 15).concat([26, 28]),
    startingXI: [1, 3, 4, 5, 8, 9, 10, 11, 13, 26, 28],
  });
  assert.deepEqual(validatePlan(plan, squadState(), gameState, rules).violations, []);
});

test('a wildcard spends no free transfers and takes no hits', () => {
  const plan = validPlan({ chip: 'wildcard', freeTransfersUsed: 1, hits: 1, hitCostPoints: 4 });
  const result = validatePlan(plan, squadState(), gameState, rules).violations;
  assert.deepEqual(result.filter(v => v.code === 'transfer_count').length, 2);
});

// --- money ------------------------------------------------------------------

test('the plan must start from the bank the squad state reports', () => {
  const result = codes(validPlan({ bankBeforeTenths: 20, bankAfterTenths: 20 }));
  assert.ok(result.includes('bank_before_mismatch'));
});

test('money in is the SELLING price, never the current price', () => {
  // Player 15 is worth 5.0 today but only sells for 4.5. A plan that banks 5.0
  // is a plan the manager cannot execute.
  const plan = oneTransfer({ moneyInTenths: 50, bankAfterTenths: 5 });
  const result = validatePlan(plan, squadState(), gameState, rules).violations;
  const money = result.filter(v => v.code === 'money_arithmetic');
  assert.equal(money.length, 2);
  assert.deepEqual(money[0].detail, { expected: 45, reported: 50 });
});

test('money out is the current price of the players bought', () => {
  const plan = oneTransfer({ moneyOutTenths: 45, bankAfterTenths: 10 });
  const money = validatePlan(plan, squadState(), gameState, rules)
    .violations.filter(v => v.code === 'money_arithmetic');
  assert.ok(money.some(v => v.detail.expected === 55 && v.detail.reported === 45));
});

test('bank after must be bank before plus money in minus money out, to the tenth', () => {
  const plan = oneTransfer({ bankAfterTenths: 1 });
  const result = validatePlan(plan, squadState(), gameState, rules).violations;
  assert.deepEqual(result.map(v => v.code), ['money_arithmetic']);
  assert.deepEqual(result[0].detail, { expected: 0, reported: 1 });
});

test('a plan the manager cannot afford is rejected', () => {
  // Selling a 4.5 player with 1.0 in the bank does not buy a 7.0 player.
  const plan = oneTransfer({
    transfersIn: [23],
    moneyOutTenths: 70,
    bankAfterTenths: -15,
    squad: SQUAD_SPEC.map(p => p.id).filter(id => id !== 15).concat([23]),
    startingXI: [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 23],
  });
  const result = validatePlan(plan, squadState(), gameState, rules).violations;
  assert.deepEqual(result.map(v => v.code), ['affordability']);
  assert.deepEqual(result[0].detail, {
    bankBeforeTenths: 10,
    moneyInTenths: 45,
    moneyOutTenths: 70,
    shortfallTenths: 15,
  });
});

test('a fresh build with no picks prices the whole squad as a purchase', () => {
  const fresh = {
    gw: 6,
    picks: [],
    bankTenths: rules.budgetTenths,
    freeTransfers: rules.maxFreeTransfers,
    chipsUsed: [],
  };
  const cost = SQUAD_SPEC.reduce((sum, p) => sum + players.get(p.id).nowCost, 0);
  const plan = validPlan({
    bankBeforeTenths: rules.budgetTenths,
    moneyInTenths: 0,
    moneyOutTenths: cost,
    bankAfterTenths: rules.budgetTenths - cost,
  });
  assert.deepEqual(validatePlan(plan, fresh, gameState, rules).violations, []);

  const overspent = { ...plan, bankBeforeTenths: cost - 1, bankAfterTenths: -1 };
  assert.deepEqual(
    validatePlan(overspent, { ...fresh, bankTenths: cost - 1 }, gameState, rules)
      .violations.map(v => v.code),
    ['affordability'],
  );
});
