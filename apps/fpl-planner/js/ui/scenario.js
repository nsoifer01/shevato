// The scenario: an editable copy of a squad, and the one place the sandbox
// keeps its state.
//
// WHY THIS EXISTS AS A SEPARATE VALUE
//
// The imported squad is a fact about the manager's FPL account. A scenario is a
// question about it ("what if I sold him?"), and the two must never be the same
// object: an experiment that mutated the imported state would make the app
// claim the manager owns a squad he does not. So the flow is
//
//   imported SquadState  ->  Scenario (edits)  ->  SquadState  ->  buildPlan
//
// and the first arrow is the only one that copies. `scenarioSquadState` hands
// the planner exactly the shape `buildSquadState` produces, which is why asking
// "what do you recommend from HERE" needs no new engine path at all.
//
// WHAT THIS FILE IS NOT ALLOWED TO DO
//
// It owns no rules. Free transfers and hits come from transfer-state.js, the
// single owner of that arithmetic. Selling prices come from the imported pick
// or from rules.js, never from a fresh formula. Legality comes from
// validate.js, the same gate every recommendation passes, so an edited squad is
// held to the identical standard as an optimized one and a violation arrives
// already carrying the sentence that explains it.
//
// Every operation returns a NEW scenario and pushes the previous one onto an
// undo stack, so undo is a pop rather than an inverse operation. Inverse
// operations are where sandboxes rot: "undo a transfer" has to know about
// captaincy that moved because the captain was sold, and a snapshot does not.

import { sellingPrice } from '../engine/rules.js';
import { picksCarryLineup } from '../engine/squad.js';
import { transferAccounting, transferStateOf } from '../engine/transfer-state.js';
import { validatePlan, formationOf, goalkeeperPositionId, benchOutfieldSlots } from '../engine/validate.js';
import { squadHorizonValue } from '../engine/lineup.js';
import { chooseCaptain } from '../engine/captain.js';
import { getProjection } from './plan-model.js';
import { formatMoney } from './format.js';

// How many edits back the sandbox can step. Deep enough that a session of
// experimenting is reversible, bounded so a long session cannot grow without
// limit.
export const UNDO_LIMIT = 40;

/* ------------------------------------------------------------------ helpers */

const playerOf = (gameState, id) => (gameState.players instanceof Map ? gameState.players.get(id) : null);
const positionOfIn = (gameState) => (id) => {
  const p = playerOf(gameState, id);
  return p ? p.position : 0;
};

// squadHorizonValue and optimizeLineup call projections.get(). The bundle that
// arrives from the worker has been through a structured clone, which drops
// methods, so this puts one back without copying the rows.
export function withProjectionGet(projections) {
  if (!projections) return null;
  if (typeof projections.get === 'function') return projections;
  return {
    ...projections,
    get: (playerId, gw) => getProjection(projections, playerId, gw),
  };
}

/* ------------------------------------------------------------------- create */

// Seed a scenario from the manager's actual squad. `picks` carries the slots
// FPL itself assigned (1-11 start, 12-15 bench in auto-sub order), so the
// scenario opens as the team the manager really has, not as a reinterpretation
// of it.
export function createScenario({ squadState, gameState, plan = null, origin = 'current' }) {
  const picks = (squadState && Array.isArray(squadState.picks) ? squadState.picks : []).slice();
  // Only picks that really encode a lineup may be copied as one. A manual
  // squad's picks are a roster (position-ordered slots, no captain flags), so
  // it falls through to the plan seed below, exactly like a draft.
  if (picks.length && origin === 'current' && picksCarryLineup(squadState)) {
    const sorted = picks.slice().sort((a, b) => a.slot - b.slot);
    const gkId = goalkeeperPositionId(gameState.rules);
    const xi = sorted.filter(p => p.slot <= 11).map(p => p.playerId);
    const benchPicks = sorted.filter(p => p.slot > 11);
    const benchGkPick = benchPicks.find(p => {
      const player = playerOf(gameState, p.playerId);
      return player && player.position === gkId;
    });
    const captain = sorted.find(p => p.isCaptain);
    const vice = sorted.find(p => p.isViceCaptain);
    return freshScenario({
      gw: squadState.gw,
      origin: 'current',
      squad: sorted.map(p => p.playerId),
      xi,
      benchGk: benchGkPick ? benchGkPick.playerId : null,
      benchOrder: benchPicks.filter(p => !benchGkPick || p.playerId !== benchGkPick.playerId).map(p => p.playerId),
      captain: captain ? captain.playerId : (xi[0] ?? null),
      viceCaptain: vice ? vice.playerId : (xi[1] ?? null),
    });
  }

  // No picks to copy (pre-season, or a deliberate "start from the
  // recommendation"), so the plan is the seed.
  if (plan) {
    return freshScenario({
      gw: plan.gw,
      origin: origin === 'current' ? 'recommended' : origin,
      squad: (plan.squad || []).slice(),
      xi: (plan.startingXI || []).slice(),
      benchGk: plan.bench ? plan.bench.gk : null,
      benchOrder: plan.bench && Array.isArray(plan.bench.order) ? plan.bench.order.slice() : [],
      captain: plan.captain ?? null,
      viceCaptain: plan.viceCaptain ?? null,
    });
  }

  return freshScenario({
    gw: squadState ? squadState.gw : null,
    origin,
    squad: [], xi: [], benchGk: null, benchOrder: [], captain: null, viceCaptain: null,
  });
}

// The squad this scenario STARTED from, kept alongside it.
//
// "Has the user changed anything" cannot be answered against the imported squad
// alone: pre-season there is no imported squad, so a scenario seeded from the
// built fifteen would compare itself against nothing and report itself
// unedited however many players were swapped. Comparing against the seed is the
// same answer in season (where the seed IS the imported squad) and the right
// one before it.
function freshScenario(fields) {
  const { past, seed, ...state } = fields;
  return { ...state, seed: seed || snapshotOf(state), past: [] };
}

const snapshotOf = (sc) => ({
  squad: sc.squad.slice(),
  xi: sc.xi.slice(),
  benchGk: sc.benchGk,
  benchOrder: sc.benchOrder.slice(),
  captain: sc.captain,
  viceCaptain: sc.viceCaptain,
});

// What changed against the seed, which is what a user means by "my changes".
// Distinct from scenarioDiff, which is the TRANSFER ledger and is deliberately
// empty for a pre-season build.
export function seedDiff(sc) {
  if (!sc || !sc.seed) return { out: [], in: [] };
  const seedSet = new Set(sc.seed.squad);
  const nowSet = new Set(sc.squad);
  return {
    out: sc.seed.squad.filter(id => !nowSet.has(id)),
    in: sc.squad.filter(id => !seedSet.has(id)),
  };
}

// Every edit goes through this, so undo is uniform and nothing can mutate a
// scenario in place by accident.
function step(sc, changes) {
  const { past, ...current } = sc;
  const nextPast = past.concat([current]).slice(-UNDO_LIMIT);
  return { ...current, ...changes, past: nextPast };
}

export const canUndo = (sc) => !!sc && sc.past.length > 0;

export function undo(sc) {
  if (!canUndo(sc)) return sc;
  const past = sc.past.slice();
  const previous = past.pop();
  return { ...previous, past };
}

// Back to the squad this scenario was seeded from, in one action, keeping the
// undo stack so even a reset is reversible.
export function reset(sc, { squadState, gameState, plan }) {
  const seed = createScenario({ squadState, gameState, plan, origin: sc.origin });
  return step(sc, { ...seed, past: undefined });
}

/* ------------------------------------------------------- derived quantities */

export function baseSquadIds(squadState) {
  return (squadState && Array.isArray(squadState.picks) ? squadState.picks : []).map(p => p.playerId);
}

// Transfers are the DIFFERENCE between the scenario squad and the imported one,
// never a log of clicks. Selling a player and buying him back leaves the squad
// where it started and therefore costs nothing, which is what FPL does with a
// transfer reversed before the deadline, and it keeps the ledger honest through
// any chain of edits (A for B, then B for C, is one transfer of A for C).
export function scenarioDiff(sc, squadState) {
  const base = baseSquadIds(squadState);
  // A squad built from nothing is a BUILD, not fifteen transfers. validate.js
  // draws the same distinction (`isFreshBuild`) and the planner's own
  // pre-season plan reports zero transfers, so reporting fifteen here would
  // charge a manager eleven hits for picking an opening team.
  if (!base.length) return { transfersOut: [], transfersIn: [] };
  const baseSet = new Set(base);
  const nowSet = new Set(sc.squad);
  return {
    transfersOut: base.filter(id => !nowSet.has(id)),
    transfersIn: sc.squad.filter(id => !baseSet.has(id)),
  };
}

export const isFreshBuild = (squadState) => baseSquadIds(squadState).length === 0;

// Everything is measured against the seed, so this answers the same question
// in season and before it. `squadState` is accepted and ignored so existing
// callers keep working.
export const isDirty = (sc, _squadState) => {
  if (!sc || !sc.seed) return false;
  const d = seedDiff(sc);
  if (d.in.length || d.out.length) return true;
  if (!sameSet(sc.seed.xi, sc.xi)) return true;
  if (sc.seed.captain !== sc.captain) return true;
  if (sc.seed.viceCaptain !== sc.viceCaptain) return true;
  if (sc.seed.benchGk !== sc.benchGk) return true;
  if (sc.seed.benchOrder.join(',') !== sc.benchOrder.join(',')) return true;
  return false;
};

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(id => s.has(id));
}

// What a player is worth to the bank if the scenario sells him.
//
// An originally owned player sells at the price squad.js already reconstructed,
// which is purchase price plus half the rise. A player the scenario itself
// bought has made no profit yet, so he sells at what this scenario paid, which
// is what sellingPrice returns for equal purchase and current price. Neither
// branch invents arithmetic.
export function sellTenthsFor(sc, { squadState, gameState }, id) {
  const pick = (squadState.picks || []).find(p => p.playerId === id);
  if (pick && Number.isFinite(pick.sellingTenths)) return pick.sellingTenths;
  const player = playerOf(gameState, id);
  const now = player ? player.nowCost : 0;
  return sellingPrice(now, now, gameState.rules);
}

export const buyTenthsFor = ({ gameState }, id) => {
  const player = playerOf(gameState, id);
  return player ? player.nowCost : 0;
};

export function scenarioMoney(sc, ctx) {
  const { squadState } = ctx;
  // Pre-season: nothing is owned, so the whole squad is bought out of the
  // budget and the bank is what is left of it. Running this through the
  // transfer ledger instead would report a bank of the full budget while
  // fifteen players sat in the team.
  if (isFreshBuild(squadState)) {
    const budget = squadState.bankTenths ?? ctx.gameState.rules.budgetTenths;
    const cost = sc.squad.reduce((sum, id) => sum + buyTenthsFor(ctx, id), 0);
    return {
      bankBeforeTenths: budget,
      moneyInTenths: 0,
      moneyOutTenths: cost,
      bankAfterTenths: budget - cost,
    };
  }
  const { transfersIn, transfersOut } = scenarioDiff(sc, squadState);
  const bankBeforeTenths = squadState.bankTenths ?? 0;
  const moneyInTenths = transfersOut.reduce((sum, id) => sum + sellTenthsFor(sc, ctx, id), 0);
  const moneyOutTenths = transfersIn.reduce((sum, id) => sum + buyTenthsFor(ctx, id), 0);
  return {
    bankBeforeTenths,
    moneyInTenths,
    moneyOutTenths,
    bankAfterTenths: bankBeforeTenths + moneyInTenths - moneyOutTenths,
  };
}

// Free transfers and hits, from the module that owns them. The scenario never
// counts a hit itself.
export function scenarioAccounting(sc, ctx) {
  const rules = ctx.gameState.rules;
  const state = transferStateOf(ctx.squadState, rules);
  const { transfersIn } = scenarioDiff(sc, ctx.squadState);
  return transferAccounting({ state, transfersMade: transfersIn.length, chipPlayed: null, rules });
}

/* -------------------------------------------------------------------- plan */

// The scenario expressed in the shape validate.js and the render layer already
// understand. Building this is what lets an edited squad reuse the plan
// vocabulary end to end rather than growing a parallel one.
export function scenarioPlan(sc, ctx) {
  const { gameState, squadState } = ctx;
  const rules = gameState.rules;
  const { transfersIn, transfersOut } = scenarioDiff(sc, squadState);
  const money = scenarioMoney(sc, ctx);
  const acct = scenarioAccounting(sc, ctx);
  const positionOf = positionOfIn(gameState);

  const squadValueAfterTenths = sc.squad.reduce((sum, id) => sum + sellTenthsFor(sc, ctx, id), 0)
    + money.bankAfterTenths;

  return {
    gw: sc.gw,
    chip: null,
    transfersOut,
    transfersIn,
    transferCount: transfersIn.length,
    freeTransfersUsed: acct.freeTransfersUsed,
    freeTransfersAfter: acct.freeTransfersAfter,
    freeTransfersNextGw: acct.freeTransfersNextGw,
    hits: acct.hits,
    hitCostPoints: acct.hitCostPoints,
    bankBeforeTenths: money.bankBeforeTenths,
    moneyInTenths: money.moneyInTenths,
    moneyOutTenths: money.moneyOutTenths,
    bankAfterTenths: money.bankAfterTenths,
    squadValueAfterTenths,
    squad: sc.squad.slice(),
    startingXI: sc.xi.slice(),
    formation: sc.xi.length === rules.starters ? formationOf(sc.xi, positionOf, rules) : null,
    bench: { gk: sc.benchGk, order: sc.benchOrder.slice() },
    captain: sc.captain,
    viceCaptain: sc.viceCaptain,
  };
}

// The same gate every recommendation passes. Violations arrive with their own
// sentences, so the UI explains a refusal instead of silently disabling a
// control.
export function validateScenario(sc, ctx) {
  return validatePlan(scenarioPlan(sc, ctx), ctx.squadState, ctx.gameState, ctx.gameState.rules);
}

// A SquadState the planner accepts, so "recommend from THIS team" is the
// existing buildPlan on a different input rather than a second code path.
//
// The scenario's transfers have already happened as far as this state is
// concerned: the picks ARE the scenario squad, the bank is the bank after, and
// the free-transfer state is what remains once those transfers are paid for.
// Handing the planner the pre-edit state instead would let it recommend selling
// a player the manager just bought here, and charge nothing for the round trip.
export function scenarioSquadState(sc, ctx) {
  const { squadState, gameState } = ctx;
  const money = scenarioMoney(sc, ctx);
  const acct = scenarioAccounting(sc, ctx);

  const slotOf = (id) => {
    const xiIndex = sc.xi.indexOf(id);
    if (xiIndex >= 0) return xiIndex + 1;
    if (id === sc.benchGk) return 12;
    const benchIndex = sc.benchOrder.indexOf(id);
    return benchIndex >= 0 ? 13 + benchIndex : 15;
  };

  const picks = sc.squad.map((playerId) => {
    const purchase = (squadState.picks || []).find(p => p.playerId === playerId);
    const bought = !purchase;
    const nowCost = buyTenthsFor(ctx, playerId);
    return {
      playerId,
      slot: slotOf(playerId),
      isCaptain: playerId === sc.captain,
      isViceCaptain: playerId === sc.viceCaptain,
      multiplier: sc.xi.includes(playerId) ? (playerId === sc.captain ? 2 : 1) : 0,
      purchaseTenths: bought ? nowCost : purchase.purchaseTenths,
      sellingTenths: sellTenthsFor(sc, ctx, playerId),
    };
  }).sort((a, b) => a.slot - b.slot);

  return {
    ...squadState,
    picks,
    bankTenths: money.bankAfterTenths,
    squadValueTenths: picks.reduce((s, p) => s + p.sellingTenths, 0) + money.bankAfterTenths,
    // The free transfers that survive this scenario's transfers. Passing the
    // untouched count would let the planner spend them twice.
    transferState: null,
    freeTransfers: acct.freeTransfersAfter,
    // Where the squad came from, so nothing downstream mistakes it for an
    // imported one. `source` is read by app.js to pick the draft path, and a
    // scenario is never a draft: it is a full 15 with a real bank.
    source: 'scenario',
    scenarioOf: squadState.source,
  };
}

/* ------------------------------------------------------------------ points */

// What the manager's OWN eleven projects this gameweek: the eleven he chose and
// the armband he chose, not an optimized one. Comparing a chosen eleven against
// an optimized number would flatter or punish the user for a choice the number
// did not actually reflect.
export function xiPoints(xi, captain, projections, gw) {
  let total = 0;
  for (const id of xi) {
    const row = getProjection(projections, id, gw);
    if (row && Number.isFinite(row.xPoints)) total += row.xPoints;
  }
  const cap = getProjection(projections, captain, gw);
  if (cap && Number.isFinite(cap.xPoints)) total += cap.xPoints;
  return total;
}

// Horizon value of a squad, through the planner's own function so the number
// means what the rest of the app means by it. Future gameweeks field their best
// eleven because today's lineup choice does not bind them.
export function horizonPoints(squadIds, ctx, { projections, gw, horizon, discount }) {
  const withGet = withProjectionGet(projections);
  if (!withGet) return 0;
  // optimizeLineup resolves positions from opts, so the game state has to
  // travel with the call: without it every future eleven is unbuildable.
  const value = squadHorizonValue(squadIds, withGet, gw, ctx.gameState.rules, {
    horizon, discount, mode: 'fast', gameState: ctx.gameState,
  });
  return value.total;
}

// What the armband is actually judged on.
//
// `xiPoints` scores an eleven in expected points, which is the right quantity
// for an eleven and the WRONG one for the armband: captain.js does not choose a
// captain on xP, it maximises a certainty equivalent that also weighs ceiling,
// fixture difficulty, penalty and set-piece duty, model confidence and the vice
// who covers him. So a manager who moved the armband to the higher-xP name used
// to be told "your eleven projects +0.1 points this gameweek" - the app
// congratulating him for overruling its own recommendation on a number that
// recommendation was never made with.
//
// This returns the captaincy score of a NAMED captain inside a given eleven,
// read off the same ranked candidate list chooseCaptain builds when it picks
// one. Null when the eleven or the captain is unknown, or when the named player
// is not in that eleven, so a caller can tell "no armband judgment available"
// from "level".
// Returns `{ score, eligible, pAppear }`, or null when there is nothing to
// judge (no eleven, no named captain, or a captain who is not in that eleven).
//
// ELIGIBILITY TRAVELS WITH THE SCORE, and it has to. captain.js gives every
// candidate a finite `captainScore` and then sorts every INELIGIBLE one below
// every eligible one, because a player under the minutes floor is not a
// captaincy option at all - his score is mostly the fallback term, the value of
// his vice playing instead of him. In the sample squad Diop scores 4.87 on a
// pAppear of 0.461, of which 3.47 is that fallback, which beats five players
// who will actually start. Comparing that number against an eligible captain's
// would tell a manager that captaining someone who probably will not play is an
// upgrade. So callers get the flag and must refuse the comparison, exactly as
// the ranking does.
export function captaincyScoreOf(xi, captainId, ctx, { projections, gw, opts = {} }) {
  const withGet = withProjectionGet(projections);
  if (!withGet || !Array.isArray(xi) || !xi.length || captainId === null || captainId === undefined) return null;
  if (!xi.includes(captainId)) return null;
  const armband = chooseCaptain(xi, withGet, gw, ctx.gameState, opts);
  const row = (armband.candidates || []).find(c => c.playerId === captainId);
  if (!row || !Number.isFinite(row.captainScore)) return null;
  return { score: row.captainScore, eligible: !!row.eligible, pAppear: row.pAppear };
}

// Before and after, computed by the SAME functions on both sides so the delta
// is a difference rather than a comparison of two conventions.
export function comparison(sc, ctx, { projections, gw, horizon, discount }) {
  const { squadState } = ctx;
  const baseIds = baseSquadIds(squadState);
  // The "before" eleven exists only when the picks encode a real lineup. A
  // manual squad's picks are a roster (position-ordered slots, no captain),
  // and reading them as a lineup scored a two-goalkeeper, captainless eleven
  // as the baseline, so an untouched restored squad reported a phantom xP
  // gain. For those squads the baseline is the seed the scenario opened from
  // (the plan's arrangement of the same fifteen), which makes an untouched
  // scenario read level, and an edit read as the edit's own effect.
  let baseXi = [];
  let baseCaptain = null;
  if (picksCarryLineup(squadState)) {
    const basePicks = squadState.picks.slice().sort((a, b) => a.slot - b.slot);
    baseXi = basePicks.filter(p => p.slot <= 11).map(p => p.playerId);
    baseCaptain = (basePicks.find(p => p.isCaptain) || {}).playerId ?? null;
  } else if (baseIds.length && sc.seed) {
    baseXi = sc.seed.xi.slice();
    baseCaptain = sc.seed.captain;
  }

  const money = scenarioMoney(sc, ctx);
  const acct = scenarioAccounting(sc, ctx);
  const diff = scenarioDiff(sc, squadState);

  const beforeGw = baseXi.length ? xiPoints(baseXi, baseCaptain, projections, gw) : 0;
  const afterGw = xiPoints(sc.xi, sc.captain, projections, gw);
  const beforeHorizon = baseIds.length ? horizonPoints(baseIds, ctx, { projections, gw, horizon, discount }) : 0;
  const afterHorizon = horizonPoints(sc.squad, ctx, { projections, gw, horizon, discount });

  // Scored on each side's OWN eleven, because that is the eleven the armband
  // sits in. Either side can be null (a manual squad has no baseline armband),
  // and a null delta means "not comparable", never "level".
  const beforeCaptaincy = captaincyScoreOf(baseXi, baseCaptain, ctx, { projections, gw });
  const afterCaptaincy = captaincyScoreOf(sc.xi, sc.captain, ctx, { projections, gw });

  return {
    gw: { before: beforeGw, after: afterGw, delta: afterGw - beforeGw },
    horizon: { before: beforeHorizon, after: afterHorizon, delta: afterHorizon - beforeHorizon },
    bank: { before: money.bankBeforeTenths, after: money.bankAfterTenths },
    transfers: diff.transfersIn.length,
    freeTransfersUsed: acct.freeTransfersUsed,
    hits: acct.hits,
    hitCostPoints: acct.hitCostPoints,
    // The only number that answers "is this worth doing": the horizon gain the
    // planner would weigh, minus what the hits cost.
    netHorizon: (afterHorizon - beforeHorizon) - acct.hitCostPoints,
    captainChanged: sc.captain !== baseCaptain,
    // Whether the ELEVEN differs from the baseline too. The armband verdict is
    // only allowed to lead when the armband is the ONLY thing that moved, and
    // "no transfer" is not enough to establish that: "copy recommended" seeds a
    // scenario whose eleven and armband both differ from the picks this
    // comparison baselines against, with no transfer in sight. False when there
    // is no baseline eleven to differ from.
    xiChanged: baseXi.length > 0 && !sameSet(baseXi, sc.xi),
    // The armband's own verdict, on the score the armband was chosen with. The
    // delta exists ONLY when both sides are genuine captaincy options; across
    // the eligibility floor the two scores do not measure the same thing, and a
    // null there means "not comparable", never "level".
    captaincy: {
      before: beforeCaptaincy,
      after: afterCaptaincy,
      delta: beforeCaptaincy && afterCaptaincy && beforeCaptaincy.eligible && afterCaptaincy.eligible
        ? afterCaptaincy.score - beforeCaptaincy.score
        : null,
    },
  };
}

/* ------------------------------------------------------------------- edits */

// Replace one player with another. The incoming player inherits the outgoing
// player's place in the eleven or on the bench, because a manager swapping a
// midfielder for a midfielder expects the new one to be where the old one was.
// Captaincy follows too: selling your captain should not silently leave the
// scenario without one.
export function applyTransfer(sc, ctx, outId, inId) {
  if (!sc.squad.includes(outId)) return { scenario: sc, error: 'That player is not in this squad.' };
  if (sc.squad.includes(inId)) return { scenario: sc, error: 'That player is already in this squad.' };
  // A missing or unknown incoming id would otherwise reach the validator and
  // come back as "the squad contains a player id that is not in the game
  // state", which describes the bug rather than the situation.
  if (!playerOf(ctx.gameState, inId)) return { scenario: sc, error: 'That player is not in this season\'s player list.' };

  const swapIn = (list) => list.map(id => (id === outId ? inId : id));
  const changes = {
    squad: swapIn(sc.squad),
    xi: swapIn(sc.xi),
    benchGk: sc.benchGk === outId ? inId : sc.benchGk,
    benchOrder: swapIn(sc.benchOrder),
    captain: sc.captain === outId ? inId : sc.captain,
    viceCaptain: sc.viceCaptain === outId ? inId : sc.viceCaptain,
  };

  const next = step(sc, changes);
  const check = validateScenario(next, ctx);
  if (!check.ok) return { scenario: sc, error: explainViolations(check.violations, ctx) };
  return { scenario: next, error: null };
}

// Move a player between the eleven and the bench, or reorder the bench.
//
// Legality is decided by applying the swap and asking validate.js, rather than
// by a second copy of the formation rules living here. That is why benching
// your last playable goalkeeper comes back with FPL's own reason instead of a
// disabled button.
export function swapPlayers(sc, ctx, aId, bId) {
  if (aId === bId) return { scenario: sc, error: null };
  if (!sc.squad.includes(aId) || !sc.squad.includes(bId)) {
    return { scenario: sc, error: 'Both players have to be in this squad.' };
  }

  const aStarting = sc.xi.includes(aId);
  const bStarting = sc.xi.includes(bId);

  let changes;
  if (aStarting && bStarting) {
    return { scenario: sc, error: 'Both players are already starting.' };
  } else if (!aStarting && !bStarting) {
    // Two bench players: this is a reorder, and the reserve goalkeeper slot is
    // not part of the order because only a goalkeeper can occupy it.
    if (aId === sc.benchGk || bId === sc.benchGk) {
      return { scenario: sc, error: 'The reserve goalkeeper has his own slot and cannot change places with an outfield substitute.' };
    }
    const order = sc.benchOrder.slice();
    const i = order.indexOf(aId);
    const j = order.indexOf(bId);
    if (i < 0 || j < 0) return { scenario: sc, error: 'Those players are not both on the bench.' };
    order[i] = bId;
    order[j] = aId;
    changes = { benchOrder: order };
  } else {
    const starter = aStarting ? aId : bId;
    const sub = aStarting ? bId : aId;
    const xi = sc.xi.map(id => (id === starter ? sub : id));
    const benchGk = sc.benchGk === sub ? starter : sc.benchGk;
    const benchOrder = sc.benchOrder.map(id => (id === sub ? starter : id));
    changes = { xi, benchGk, benchOrder, ...reassignArmbands(xi, sc.captain, sc.viceCaptain) };
  }

  const next = step(sc, changes);
  const check = validateScenario(next, ctx);
  if (!check.ok) return { scenario: sc, error: explainViolations(check.violations, ctx) };
  return { scenario: next, error: null };
}

// An armband cannot sit on the bench, and the two armbands cannot sit on one
// player. Benching the captain therefore promotes the vice exactly as the game
// does, and then refills the vacated vice slot, because a squad with one player
// wearing both is not a legal team sheet.
function reassignArmbands(xi, captain, viceCaptain) {
  let c = xi.includes(captain) ? captain : null;
  let v = xi.includes(viceCaptain) ? viceCaptain : null;
  if (c === null) c = v !== null ? v : (xi[0] ?? null);
  if (v === c) v = null;
  if (v === null) v = xi.find(id => id !== c) ?? null;
  return { captain: c, viceCaptain: v };
}

export function setCaptain(sc, ctx, playerId) {
  if (!sc.xi.includes(playerId)) {
    return { scenario: sc, error: 'Only a player in the starting eleven can wear the armband.' };
  }
  // Naming the current vice as captain swaps the two rather than leaving the
  // squad with the same player in both roles.
  const viceCaptain = playerId === sc.viceCaptain ? sc.captain : sc.viceCaptain;
  const next = step(sc, { captain: playerId, viceCaptain });
  const check = validateScenario(next, ctx);
  if (!check.ok) return { scenario: sc, error: explainViolations(check.violations, ctx) };
  return { scenario: next, error: null };
}

export function setViceCaptain(sc, ctx, playerId) {
  if (!sc.xi.includes(playerId)) {
    return { scenario: sc, error: 'Only a player in the starting eleven can be vice-captain.' };
  }
  const captain = playerId === sc.captain ? sc.viceCaptain : sc.captain;
  const next = step(sc, { viceCaptain: playerId, captain });
  const check = validateScenario(next, ctx);
  if (!check.ok) return { scenario: sc, error: explainViolations(check.violations, ctx) };
  return { scenario: next, error: null };
}

// Bench order is the auto-substitution order, so moving a substitute up is a
// real decision and not cosmetic.
export function moveBench(sc, ctx, playerId, direction) {
  const order = sc.benchOrder.slice();
  const i = order.indexOf(playerId);
  if (i < 0) return { scenario: sc, error: 'That player is not an outfield substitute.' };
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return { scenario: sc, error: null };
  order[i] = order[j];
  order[j] = playerId;
  const next = step(sc, { benchOrder: order });
  const check = validateScenario(next, ctx);
  if (!check.ok) return { scenario: sc, error: explainViolations(check.violations, ctx) };
  return { scenario: next, error: null };
}

/* -------------------------------------------------------- transfer candidates */

// Why this player cannot come in for that one, or null when he can.
//
// These are the cheap checks a picker needs on every keystroke: the same four
// limits validate.js enforces, read from the same rules object, phrased for
// someone choosing rather than for a log. The commit path still runs the full
// gate, so this list can never be the only thing standing between a user and an
// illegal squad.
export function transferBlockedReason(sc, ctx, outId, inId) {
  const { gameState } = ctx;
  const rules = gameState.rules;
  const incoming = playerOf(gameState, inId);
  const outgoing = playerOf(gameState, outId);
  if (!incoming) return 'Unknown player.';
  if (sc.squad.includes(inId)) return 'Already in your squad.';
  if (!outgoing) return 'Unknown player to replace.';

  if (incoming.position !== outgoing.position) {
    const want = rules.positions[outgoing.position];
    return `A squad has to keep the same shape, so ${want ? want.name.toLowerCase() : 'that position'} has to be replaced like for like.`;
  }

  const clubCount = sc.squad
    .filter(id => id !== outId)
    .filter(id => {
      const p = playerOf(gameState, id);
      return p && p.teamId === incoming.teamId;
    }).length;
  if (clubCount >= rules.clubLimit) {
    const team = gameState.teams.get(incoming.teamId);
    return `You would have ${clubCount + 1} players from ${team ? team.name : 'that club'}, and the limit is ${rules.clubLimit}.`;
  }

  const money = scenarioMoney(sc, ctx);
  const funds = money.bankAfterTenths + sellTenthsFor(sc, ctx, outId);
  if (incoming.nowCost > funds) {
    return `He costs ${formatMoney(incoming.nowCost)} and you would have ${formatMoney(funds)} to spend.`;
  }
  return null;
}

// The replacement list for one outgoing player, annotated so the picker can
// show why an option is unavailable rather than hiding it. Hiding an
// unaffordable player answers "why can I not see him" with silence.
export function transferCandidates(sc, ctx, outId, { projections, gw, limit = 200 } = {}) {
  const { gameState } = ctx;
  const outgoing = playerOf(gameState, outId);
  if (!outgoing) return [];
  const funds = scenarioMoney(sc, ctx).bankAfterTenths + sellTenthsFor(sc, ctx, outId);

  const rows = [];
  for (const player of gameState.players.values()) {
    if (player.position !== outgoing.position) continue;
    if (sc.squad.includes(player.id) && player.id !== outId) continue;
    if (player.id === outId) continue;
    const row = getProjection(projections, player.id, gw);
    const blocked = transferBlockedReason(sc, ctx, outId, player.id);
    const team = gameState.teams.get(player.teamId);
    rows.push({
      id: player.id,
      name: player.webName,
      club: team ? team.shortName : '',
      clubName: team ? team.name : '',
      priceTenths: player.nowCost,
      affordable: player.nowCost <= funds,
      status: player.status,
      xPoints: row && Number.isFinite(row.xPoints) ? row.xPoints : null,
      blocked,
    });
  }

  rows.sort((a, b) => {
    if (!!a.blocked !== !!b.blocked) return a.blocked ? 1 : -1;
    return (b.xPoints ?? -1) - (a.xPoints ?? -1);
  });
  return rows.slice(0, limit);
}

/* -------------------------------------------------------------- explanation */

// One sentence a person can act on, out of the validator's own messages.
// validate.js already phrases each violation, so this picks rather than writes.
export function explainViolations(violations, ctx) {
  if (!violations || !violations.length) return null;
  const first = violations[0];
  const nameOf = (id) => {
    const p = playerOf(ctx.gameState, id);
    return p ? p.webName : `player ${id}`;
  };
  if (first.code === 'xi_position' && first.detail) {
    const d = first.detail;
    return `That would field ${d.actual} ${d.short}, and a legal eleven plays ${d.min} to ${d.max}.`;
  }
  if (first.code === 'bench_composition' && first.detail && first.detail.playerId) {
    return `${first.message} (${nameOf(first.detail.playerId)})`;
  }
  return first.message;
}

// Everything the summary strip needs, in one call, so the render layer holds no
// arithmetic of its own.
export function scenarioSummary(sc, ctx, { projections, gw, horizon, discount }) {
  const check = validateScenario(sc, ctx);
  const compare = comparison(sc, ctx, { projections, gw, horizon, discount });
  const plan = scenarioPlan(sc, ctx);
  return {
    ok: check.ok,
    violations: check.violations,
    reason: check.ok ? null : explainViolations(check.violations, ctx),
    plan,
    compare,
    dirty: isDirty(sc, ctx.squadState),
  };
}
