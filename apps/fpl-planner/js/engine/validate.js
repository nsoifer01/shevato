// The single legality gate.
//
// Every plan this app produces, from a one-transfer nudge to a wildcard
// rebuild, passes through validatePlan before it is ranked or rendered. The
// product promise is that an illegal or unaffordable recommendation is
// impossible, so this file trusts nothing the optimizer reports: it re-derives
// every count and every tenth from the squad state and the game state, and
// compares.
//
// EVERY LIMIT COMES FROM `rules`. Nothing here knows that a squad is 15
// players, that a club limit is 3, that eleven play, or that a goalkeeper is
// position 1. rules.js reads all of that from the live bootstrap payload, so a
// rule change upstream needs no edit here.
//
// MONEY LEDGER CONVENTION, stated once and enforced everywhere:
//
//   bankAfterTenths === bankBeforeTenths + moneyInTenths - moneyOutTenths
//   moneyInTenths  = cash INTO the bank  = sum of SELLING prices of players out
//   moneyOutTenths = cash OUT of the bank = sum of now_cost of players in
//
// Selling price is never now_cost. FPL takes half the profit on a player who
// has risen since purchase, so `pick.sellingTenths` is the only number that can
// actually be spent, and `entry_history.value` already includes the bank so it
// is never added twice.
//
// All money is INTEGER TENTHS of a million. There is no floating point money
// anywhere in this file, which is why every comparison here can be exact.

import { chipAvailableAt } from './rules.js';

const EMPTY = [];
const arr = (v) => (Array.isArray(v) ? v : EMPTY);

export class PlanValidationError extends Error {
  constructor(violations) {
    const lines = violations.map(v => `${v.code}: ${v.message}`).join('\n');
    super(`Plan failed validation with ${violations.length} violation(s):\n${lines}`);
    this.name = 'PlanValidationError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Position helpers, derived rather than named
//
// FPL's auto-substitution rules only ever swap a goalkeeper for a goalkeeper,
// and the reason is visible in element_types rather than in a name: a position
// whose squad_min_play equals its squad_max_play starts a FIXED number of
// players, so its squad members split into a fixed set of starters and a fixed
// set of bench players that no other position can cross into. Deriving the
// keeper this way means nothing in the engine reads the string "GKP".
// ---------------------------------------------------------------------------

export function fixedCountPositionIds(rules) {
  return Object.values(rules.positions)
    .filter(p => p.minPlay === p.maxPlay)
    .map(p => p.id)
    .sort((a, b) => a - b);
}

export function goalkeeperPositionId(rules) {
  return fixedCountPositionIds(rules)[0];
}

export function outfieldPositionIds(rules) {
  const fixed = new Set(fixedCountPositionIds(rules));
  return Object.values(rules.positions)
    .map(p => p.id)
    .filter(id => !fixed.has(id))
    .sort((a, b) => a - b);
}

// How many ordered outfield bench slots a squad has: the bench minus the
// players sitting in fixed-count positions (the reserve keeper).
export function benchOutfieldSlots(rules) {
  const fixed = new Set(fixedCountPositionIds(rules));
  let fixedBench = 0;
  for (const p of Object.values(rules.positions)) {
    if (fixed.has(p.id)) fixedBench += p.squadSelect - p.minPlay;
  }
  return rules.squadSize - rules.starters - fixedBench;
}

// The formation label, generated from the actual XI rather than matched against
// a hardcoded list: outfield position counts in ascending position order.
export function formationOf(xiIds, positionOf, rules) {
  const counts = new Map();
  for (const id of xiIds) {
    const pos = positionOf(id);
    counts.set(pos, (counts.get(pos) || 0) + 1);
  }
  return outfieldPositionIds(rules).map(id => counts.get(id) || 0).join('-');
}

// ---------------------------------------------------------------------------

export function validatePlan(plan, squadState, gameState, rules) {
  const violations = [];
  const add = (code, message, detail) => violations.push({ code, message, detail });

  if (!plan || typeof plan !== 'object') {
    add('plan_missing', 'No plan was supplied.', null);
    return { ok: false, violations };
  }
  const R = rules || (gameState && gameState.rules);
  if (!R) {
    add('rules_missing', 'No rules object was supplied and the game state carries none.', null);
    return { ok: false, violations };
  }

  const players = (gameState && gameState.players) || new Map();
  const state = squadState || {};
  const positionOf = (id) => {
    const p = players.get(id);
    return p ? p.position : null;
  };

  const squad = arr(plan.squad);
  const xi = arr(plan.startingXI);
  const bench = plan.bench || {};
  const benchOrder = arr(bench.order);
  const transfersIn = arr(plan.transfersIn);
  const transfersOut = arr(plan.transfersOut);

  // --- the squad itself ----------------------------------------------------

  if (squad.length !== R.squadSize) {
    add('squad_size', `A squad must contain exactly ${R.squadSize} players, this one has ${squad.length}.`,
      { expected: R.squadSize, actual: squad.length });
  }

  const squadSet = new Set(squad);
  if (squadSet.size !== squad.length) {
    add('duplicate_player', 'The same player appears more than once in the squad.',
      { duplicates: duplicatesOf(squad) });
  }

  const unknown = squad.filter(id => !players.has(id));
  if (unknown.length) {
    add('unknown_player', `The squad contains ${unknown.length} player id(s) that are not in the game state.`,
      { playerIds: unknown });
  }

  const known = squad.filter(id => players.has(id));

  const squadByPosition = countBy(known, positionOf);
  for (const pos of Object.values(R.positions)) {
    const actual = squadByPosition.get(pos.id) || 0;
    if (actual !== pos.squadSelect) {
      add('position_count', `A squad must contain exactly ${pos.squadSelect} ${pos.name}s, this one has ${actual}.`,
        { position: pos.id, short: pos.short, expected: pos.squadSelect, actual });
    }
  }

  const byClub = countBy(known, id => players.get(id).teamId);
  for (const [teamId, count] of byClub) {
    if (count > R.clubLimit) {
      add('club_limit', `A squad may hold at most ${R.clubLimit} players from one club, this one holds ${count}.`,
        { teamId, limit: R.clubLimit, actual: count });
    }
  }

  // --- the starting eleven -------------------------------------------------

  if (xi.length !== R.starters) {
    add('xi_size', `A starting eleven must contain exactly ${R.starters} players, this one has ${xi.length}.`,
      { expected: R.starters, actual: xi.length });
  }

  const xiSet = new Set(xi);
  if (xiSet.size !== xi.length) {
    add('xi_duplicate', 'The same player appears more than once in the starting eleven.',
      { duplicates: duplicatesOf(xi) });
  }

  const xiOutsideSquad = xi.filter(id => !squadSet.has(id));
  if (xiOutsideSquad.length) {
    add('xi_not_in_squad', 'The starting eleven contains a player who is not in the squad.',
      { playerIds: xiOutsideSquad });
  }

  const xiByPosition = countBy(xi.filter(id => players.has(id)), positionOf);
  for (const pos of Object.values(R.positions)) {
    const actual = xiByPosition.get(pos.id) || 0;
    if (actual < pos.minPlay || actual > pos.maxPlay) {
      add('xi_position', `A legal formation plays ${pos.minPlay} to ${pos.maxPlay} ${pos.name}s, this one plays ${actual}.`,
        { position: pos.id, short: pos.short, min: pos.minPlay, max: pos.maxPlay, actual });
    }
  }

  if (plan.formation !== undefined && plan.formation !== null && xi.length === R.starters && !xiOutsideSquad.length && !unknown.length) {
    const derived = formationOf(xi, positionOf, R);
    if (derived !== plan.formation) {
      add('formation_mismatch', `The plan reports formation ${plan.formation} but its starting eleven is ${derived}.`,
        { reported: plan.formation, derived });
    }
  }

  // --- the bench -----------------------------------------------------------

  const fixedPositions = new Set(fixedCountPositionIds(R));
  const expectedOutfieldBench = benchOutfieldSlots(R);

  if (bench.gk === undefined || bench.gk === null) {
    add('bench_composition', 'The bench does not name a reserve goalkeeper.', { bench });
  } else {
    if (!squadSet.has(bench.gk)) {
      add('bench_composition', 'The reserve goalkeeper is not in the squad.', { playerId: bench.gk });
    }
    if (xiSet.has(bench.gk)) {
      add('bench_composition', 'The reserve goalkeeper is also in the starting eleven.', { playerId: bench.gk });
    }
    if (players.has(bench.gk) && !fixedPositions.has(positionOf(bench.gk))) {
      add('bench_composition', 'The reserve goalkeeper slot holds an outfield player, and FPL only ever substitutes a goalkeeper for a goalkeeper.',
        { playerId: bench.gk, position: positionOf(bench.gk) });
    }
  }

  if (benchOrder.length !== expectedOutfieldBench) {
    add('bench_composition', `The outfield bench must be ${expectedOutfieldBench} players in order, this one has ${benchOrder.length}.`,
      { expected: expectedOutfieldBench, actual: benchOrder.length });
  }

  for (const id of benchOrder) {
    if (!squadSet.has(id)) {
      add('bench_composition', 'A bench player is not in the squad.', { playerId: id });
    }
    if (xiSet.has(id)) {
      add('bench_composition', 'A bench player is also in the starting eleven.', { playerId: id });
    }
    if (players.has(id) && fixedPositions.has(positionOf(id))) {
      add('bench_composition', 'A goalkeeper is sitting in an outfield bench slot.',
        { playerId: id, position: positionOf(id) });
    }
  }

  const benchAll = bench.gk === undefined || bench.gk === null ? benchOrder : [bench.gk, ...benchOrder];
  const union = new Set([...xi, ...benchAll]);
  if (union.size !== squadSet.size || [...squadSet].some(id => !union.has(id))) {
    add('bench_union', 'The starting eleven plus the bench is not the squad.',
      {
        missing: [...squadSet].filter(id => !union.has(id)),
        extra: [...union].filter(id => !squadSet.has(id)),
      });
  }

  // --- armbands ------------------------------------------------------------

  if (plan.captain === undefined || plan.captain === null) {
    add('captain_missing', 'The plan names no captain.', null);
  } else if (!xiSet.has(plan.captain)) {
    add('captain_not_in_xi', 'The captain is not in the starting eleven.', { playerId: plan.captain });
  }

  if (plan.viceCaptain === undefined || plan.viceCaptain === null) {
    add('vice_missing', 'The plan names no vice-captain.', null);
  } else if (!xiSet.has(plan.viceCaptain)) {
    add('vice_not_in_xi', 'The vice-captain is not in the starting eleven.', { playerId: plan.viceCaptain });
  }

  if (plan.captain !== undefined && plan.captain !== null && plan.captain === plan.viceCaptain) {
    add('captain_vice_same', 'The captain and the vice-captain are the same player.', { playerId: plan.captain });
  }

  // --- chips ---------------------------------------------------------------

  if (plan.chip) {
    if (!chipAvailableAt(R, plan.chip, plan.gw, state.chipsUsed || [])) {
      add('chip_illegal', `The ${plan.chip} chip is not available in gameweek ${plan.gw}, either because it falls outside the chip's event window or because it has already been played.`,
        { chip: plan.chip, gw: plan.gw, chipsUsed: state.chipsUsed || [] });
    }
  }

  // --- transfers, free transfers and hits ----------------------------------
  //
  // A wildcard or a free hit makes the gameweek's transfers unlimited and free,
  // and leaves the banked free transfers untouched. Every other plan spends
  // free transfers first (FPL gives no choice about that) and pays
  // rules.hitCost per transfer beyond them.

  const owned = new Map((state.picks || []).map(p => [p.playerId, p]));
  const isFreshBuild = owned.size === 0;
  const unlimited = plan.chip === 'wildcard' || plan.chip === 'freehit';

  if (plan.transferCount !== transfersIn.length || plan.transferCount !== transfersOut.length) {
    add('transfer_count', `The plan reports ${plan.transferCount} transfer(s) but lists ${transfersIn.length} in and ${transfersOut.length} out.`,
      { transferCount: plan.transferCount, in: transfersIn.length, out: transfersOut.length });
  }

  if (!isFreshBuild) {
    const notOwned = transfersOut.filter(id => !owned.has(id));
    if (notOwned.length) {
      add('transfer_out_not_owned', 'The plan sells a player the manager does not own.', { playerIds: notOwned });
    }
    const alreadyOwned = transfersIn.filter(id => owned.has(id));
    if (alreadyOwned.length) {
      add('transfer_in_already_owned', 'The plan buys a player the manager already owns.', { playerIds: alreadyOwned });
    }

    const expectedSquad = new Set(owned.keys());
    for (const id of transfersOut) expectedSquad.delete(id);
    for (const id of transfersIn) expectedSquad.add(id);
    const mismatch = [...expectedSquad].filter(id => !squadSet.has(id))
      .concat([...squadSet].filter(id => !expectedSquad.has(id)));
    if (mismatch.length) {
      add('squad_transfer_mismatch', 'The resulting squad is not the current squad with the listed transfers applied.',
        { unexpected: mismatch });
    }
  }

  const availableFts = state.freeTransfers ?? 0;
  const used = plan.freeTransfersUsed ?? 0;
  const hits = plan.hits ?? 0;

  if (unlimited) {
    if (used !== 0) {
      add('transfer_count', `A ${plan.chip} does not spend free transfers, but the plan reports ${used} used.`,
        { chip: plan.chip, freeTransfersUsed: used });
    }
    if (hits !== 0) {
      add('transfer_count', `A ${plan.chip} makes every transfer free, but the plan reports ${hits} hit(s).`,
        { chip: plan.chip, hits });
    }
  } else {
    const expectedUsed = Math.min(plan.transferCount ?? 0, availableFts);
    if (used !== expectedUsed) {
      add('transfer_count', `With ${availableFts} free transfer(s) banked and ${plan.transferCount} transfer(s) made, exactly ${expectedUsed} free transfer(s) are spent, not ${used}.`,
        { available: availableFts, transferCount: plan.transferCount, expected: expectedUsed, reported: used });
    }
    const expectedHits = Math.max(0, (plan.transferCount ?? 0) - expectedUsed);
    if (hits !== expectedHits) {
      add('transfer_count', `${plan.transferCount} transfer(s) against ${availableFts} free transfer(s) is ${expectedHits} hit(s), not ${hits}.`,
        { available: availableFts, transferCount: plan.transferCount, expected: expectedHits, reported: hits });
    }
  }

  if (plan.hitCostPoints !== hits * R.hitCost) {
    add('hit_cost', `${hits} hit(s) at ${R.hitCost} points each is ${hits * R.hitCost} points, not ${plan.hitCostPoints}.`,
      { hits, hitCost: R.hitCost, expected: hits * R.hitCost, reported: plan.hitCostPoints });
  }

  // --- money ---------------------------------------------------------------
  //
  // Recomputed from selling prices and now_cost, never taken from the plan.

  const bankBefore = plan.bankBeforeTenths;
  if (!isFreshBuild && state.bankTenths !== undefined && bankBefore !== state.bankTenths) {
    add('bank_before_mismatch', `The plan starts from a bank of ${bankBefore} tenths but the squad state says ${state.bankTenths}.`,
      { reported: bankBefore, actual: state.bankTenths });
  }

  // A fresh build has nothing to sell, so the whole squad is a purchase. When
  // the caller did not bother to list all fifteen as incoming, the squad itself
  // is the incoming set.
  const incoming = isFreshBuild && transfersIn.length === 0 ? squad : transfersIn;
  const outgoing = isFreshBuild ? EMPTY : transfersOut;

  let expectedMoneyOut = 0;
  for (const id of incoming) {
    const p = players.get(id);
    if (p) expectedMoneyOut += p.nowCost;
  }
  let expectedMoneyIn = 0;
  for (const id of outgoing) {
    const pick = owned.get(id);
    if (pick) expectedMoneyIn += pick.sellingTenths;
  }

  if (plan.moneyInTenths !== undefined && plan.moneyInTenths !== expectedMoneyIn) {
    add('money_arithmetic', `moneyInTenths is cash INTO the bank, the sum of the SELLING prices of the players sold, which is ${expectedMoneyIn} tenths and not ${plan.moneyInTenths}.`,
      { expected: expectedMoneyIn, reported: plan.moneyInTenths });
  }
  if (plan.moneyOutTenths !== undefined && plan.moneyOutTenths !== expectedMoneyOut) {
    add('money_arithmetic', `moneyOutTenths is cash OUT of the bank, the sum of the now_cost of the players bought, which is ${expectedMoneyOut} tenths and not ${plan.moneyOutTenths}.`,
      { expected: expectedMoneyOut, reported: plan.moneyOutTenths });
  }

  const expectedBankAfter = (bankBefore ?? 0) + expectedMoneyIn - expectedMoneyOut;
  if (plan.bankAfterTenths !== expectedBankAfter) {
    add('money_arithmetic', `Bank after should be ${bankBefore} + ${expectedMoneyIn} - ${expectedMoneyOut} = ${expectedBankAfter} tenths, not ${plan.bankAfterTenths}.`,
      { expected: expectedBankAfter, reported: plan.bankAfterTenths });
  }
  if (expectedBankAfter < 0) {
    add('affordability', `This plan spends ${expectedMoneyOut} tenths against ${(bankBefore ?? 0) + expectedMoneyIn} tenths available, leaving the bank ${expectedBankAfter} tenths short.`,
      {
        bankBeforeTenths: bankBefore,
        moneyInTenths: expectedMoneyIn,
        moneyOutTenths: expectedMoneyOut,
        shortfallTenths: -expectedBankAfter,
      });
  }

  return { ok: violations.length === 0, violations };
}

export function assertValidPlan(plan, squadState, gameState, rules) {
  const result = validatePlan(plan, squadState, gameState, rules);
  if (!result.ok) throw new PlanValidationError(result.violations);
}

// ---------------------------------------------------------------------------

function countBy(ids, fn) {
  const m = new Map();
  for (const id of ids) {
    const key = fn(id);
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

function duplicatesOf(ids) {
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}
