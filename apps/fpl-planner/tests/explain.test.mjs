// explain.js - SPEC 15.4 and the brief's sections 51 to 53.
//
// THE TEST THIS FILE EXISTS FOR: every number a human reads in an explanation
// must be a number the engine computed. The sweep below parses the figures back
// out of `text`, checks each one against the reason's own `value` and against
// the plan field it claims to describe, and then checks that NOTHING ELSE
// numeric is in the sentence unless it is an engine quantity too.
//
// A narrative generator would pass a "does it read well" review and fail this,
// which is the point: the failure mode being guarded against is plausible
// reasoning invented after the decision was taken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { chooseCaptain } from '../js/engine/captain.js';
import { fmtValue, discountWeights, xpOf, CHIP_PARAMS } from '../js/engine/chips.js';
import { explainPlan, whyNot, planHeadline, REBUILD_NOTICE, EXPLAIN_PARAMS } from '../js/engine/explain.js';
import { manualSquadState } from '../js/ui/preseason.js';
import { assembleSampleBundle } from '../js/data/sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const RULES = buildRules(read('fixtures', 'bootstrap.json'));

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

// Names and club codes are spelled out in letters on purpose: the number sweep
// treats any digit in a sentence as a claim, and a player called "P310" would
// smuggle a 310 into every sentence he appears in.
const letters = n => String(n).split('').map(d => 'ABCDEFGHIJ'[Number(d)]).join('');

function makePlayer(id, position, teamId, nowCost, over = {}) {
  return {
    id,
    code: id,
    webName: `Pl${letters(id)}`,
    firstName: '',
    secondName: `Pl${letters(id)}`,
    teamId,
    position,
    nowCost,
    status: 'a',
    chanceNext: null,
    news: '',
    newsAdded: null,
    selectedByPercent: 5,
    minutes: 2000,
    starts: 25,
    totalPoints: 100,
    bonus: 5,
    bps: 300,
    saves: 0,
    goalsScored: 5,
    assists: 5,
    cleanSheets: 5,
    goalsConceded: 20,
    yellowCards: 2,
    redCards: 0,
    ownGoals: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    cbit: 50,
    recoveries: 100,
    tackles: 30,
    defCon: 180,
    xG: 5,
    xA: 5,
    xGI: 10,
    xGC: 20,
    per90: { xG: 0.2, xA: 0.2, xGI: 0.4, xGC: 1, saves: 0, goalsConceded: 1, starts: 1, cleanSheets: 0.2, defCon: 8 },
    setPieces: { penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null },
    ...over,
  };
}

const GW = 10;
const SQUAD_IDS = [101, 102, 201, 202, 203, 204, 205, 301, 302, 303, 304, 305, 401, 402, 403];
const NO_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];

function roster(over = new Map()) {
  const list = [
    makePlayer(101, 1, 1, 45), makePlayer(102, 1, 2, 40),
    makePlayer(201, 2, 3, 50), makePlayer(202, 2, 4, 50), makePlayer(203, 2, 5, 50),
    makePlayer(204, 2, 6, 50), makePlayer(205, 2, 7, 50),
    makePlayer(301, 3, 8, 60), makePlayer(302, 3, 9, 60), makePlayer(303, 3, 10, 60),
    makePlayer(304, 3, 11, 60), makePlayer(305, 3, 12, 55),
    makePlayer(401, 4, 13, 70), makePlayer(402, 4, 14, 70), makePlayer(403, 4, 15, 70),
    makePlayer(310, 3, 16, 55), makePlayer(311, 3, 17, 55), makePlayer(312, 3, 18, 40),
    makePlayer(210, 2, 19, 40), makePlayer(410, 4, 20, 40), makePlayer(110, 1, 20, 40),
  ];
  return list.map(p => (over.has(p.id) ? { ...p, ...over.get(p.id) } : p));
}

function makeGameState(players, gw) {
  const teamIds = [...new Set(players.map(p => p.teamId))].sort((a, b) => a - b);
  const fixtures = [];
  let id = 1;
  for (let g = 1; g <= RULES.totalEvents; g++) {
    for (let i = 0; i + 1 < teamIds.length; i += 2) {
      fixtures.push({
        id: id++, code: id, event: g, kickoff: '2026-01-03T15:00:00Z',
        teamH: teamIds[i], teamA: teamIds[i + 1], teamHDifficulty: 3, teamADifficulty: 3,
        finished: false, started: false, teamHScore: null, teamAScore: null,
      });
    }
  }
  const events = [];
  for (let i = 1; i <= RULES.totalEvents; i++) {
    events.push({
      id: i, name: `Gameweek ${i}`, deadline: null, deadlineEpoch: null,
      finished: i < gw, dataChecked: i < gw, isCurrent: i === gw - 1, isNext: i === gw, isPrevious: i === gw - 2,
      averageEntryScore: null, highestScore: null,
    });
  }
  return {
    rules: RULES,
    teams: new Map(teamIds.map(t => [t, {
      id: t, code: t, name: `Club ${letters(t)}`, shortName: `C${letters(t)}`, strengthOverallHome: 3, strengthOverallAway: 3,
    }])),
    players: new Map(players.map(p => [p.id, p])),
    fixtures,
    events,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    currentEvent: gw - 1,
    nextEvent: gw,
    seasonStarted: true,
  };
}

function makeProjections(gameState, gwFrom, gwTo, xp) {
  const byPlayer = new Map();
  for (const p of gameState.players.values()) {
    const rows = [];
    for (let gw = gwFrom; gw <= gwTo; gw++) {
      const fixtures = gameState.fixtures.filter(f => f.event === gw && (f.teamH === p.teamId || f.teamA === p.teamId));
      const available = p.status === 'a' || p.status === 'd';
      const pAppear = fixtures.length && available ? 1 : 0;
      const points = fixtures.length ? xp(p.id, gw) * pAppear : 0;
      rows.push({
        playerId: p.id,
        gw,
        fixtures: fixtures.map(f => ({
          fixtureId: f.id,
          opponentId: f.teamH === p.teamId ? f.teamA : f.teamH,
          isHome: f.teamH === p.teamId,
          fdr: 3,
          kickoff: f.kickoff,
        })),
        pAppear,
        pStart: pAppear,
        xMins: pAppear * 90,
        components: {
          xGoals: 0, xAssists: 0, xCleanSheet: 0, xSaves: 0, xBonus: 0,
          xCards: 0, xDefCon: 0, xConceded: 0, xPensSaved: 0,
        },
        xPoints: points,
        sd: 1,
        ceiling: Math.round(points + 3),
        confidence: 'high',
      });
    }
    byPlayer.set(p.id, rows);
  }
  return {
    gwFrom,
    gwTo,
    byPlayer,
    modelVersion: 'synthetic-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    dataFetchedAt: '2026-01-01T00:00:00.000Z',
    get(playerId, gw) {
      const rows = byPlayer.get(playerId);
      if (!rows) return null;
      const i = gw - gwFrom;
      return i >= 0 && i < rows.length ? rows[i] : null;
    },
  };
}

function makeSquadState(playerIds, gameState, { gw = GW, bankTenths = 5, freeTransfers = 1, chipsUsed = NO_CHIPS } = {}) {
  const priceOf = id => gameState.players.get(id).nowCost;
  return {
    entryId: 42,
    entryName: 'Test XI',
    managerName: 'Test Manager',
    gw,
    picks: playerIds.map((playerId, i) => ({
      playerId,
      slot: i + 1,
      isCaptain: false,
      isViceCaptain: false,
      multiplier: i < RULES.starters ? 1 : 0,
      purchaseTenths: priceOf(playerId),
      // A selling price that is NOT now_cost, so a sentence that quotes the
      // wrong one is visible.
      sellingTenths: priceOf(playerId) - 2,
    })),
    bankTenths,
    squadValueTenths: playerIds.reduce((s, id) => s + priceOf(id) - 2, 0) + bankTenths,
    freeTransfers,
    chipsUsed,
    chipsAvailable: [],
    overallRank: 250000,
    totalPoints: 500,
    source: 'picks',
    asOf: '2026-01-01T00:00:00.000Z',
    warnings: [],
  };
}

function baseXp(id) {
  if (id === 305) return 1;
  if (id === 101) return 4;
  if (id === 102) return 3;
  if (id >= 201 && id <= 205) return 4.5 - (id - 201) * 0.1;
  if (id >= 301 && id <= 304) return 5 - (id - 301) * 0.1;
  if (id === 401) return 5.5;
  if (id === 402) return 5;
  if (id === 403) return 2;
  return 0.5;
}

async function scenario({ xp = baseXp, over = new Map(), horizon = 5, squad = {}, options = {} } = {}) {
  const players = roster(over);
  const gameState = makeGameState(players, GW);
  const projections = makeProjections(gameState, GW, GW + horizon + 4, xp);
  const squadState = makeSquadState(SQUAD_IDS, gameState, { ...squad });
  const bundle = await buildPlan({
    gameState,
    squadState,
    options: { horizon, seed: 11, projections, strength: {}, ...options },
  });
  return { gameState, projections, squadState, bundle, horizon };
}

// ---------------------------------------------------------------------------
// The number sweep
// ---------------------------------------------------------------------------

// Every reason object anywhere in an explanation.
function allReasons(explanation) {
  const out = [...explanation.bullets];
  for (const row of explanation.transferReasons) out.push(...row.reasons);
  out.push(...explanation.captainReason.reasons);
  out.push(...explanation.chipReason.reasons);
  if (explanation.rollReason) out.push(...explanation.rollReason.reasons);
  return out;
}

const NUMBER = /-?\d+(?:\.\d+)?/g;
// A formation is written "3-5-2", so a hyphen between two digits is a separator
// and not a minus sign. Everything else keeps its sign, because "-16.2 points
// against the recommended plan" is a real negative number.
const numbersIn = text => (String(text).replace(/(\d)-(?=\d)/g, '$1 ').match(NUMBER) || []).map(Number);

// Numbers that are allowed to appear in a sentence alongside the reason's own
// formatted value: the model's own parameters and the plan's own counts. A
// figure that is in neither is an invented one.
function engineNumbers(bundle, plan, horizon) {
  const allowed = new Set([
    horizon,
    plan.gw,
    plan.transferCount,
    plan.hits,
    plan.hitCostPoints,
    plan.squad.length,
    plan.freeTransfersAfter,
    Math.min(plan.freeTransfersAfter + 1, RULES.maxFreeTransfers),
    RULES.hitCost,
    RULES.maxFreeTransfers,
    RULES.squadSize,
    CHIP_PARAMS.wildcardHorizonThreshold,
    CHIP_PARAMS.freeHitThreshold,
    CHIP_PARAMS.benchBoostThreshold,
    CHIP_PARAMS.tripleCaptainMargin,
  ]);
  // Gameweek references, and only the ones the engine actually produced: the
  // gameweeks inside the horizon, and the weeks the chip evaluator named. A
  // blanket "any gameweek from 1 to 38" would let almost any small integer
  // through, which would make this sweep decorative.
  for (let k = 0; k < horizon; k++) allowed.add(plan.gw + k);
  for (const entry of Object.values((bundle.chipEvaluation && bundle.chipEvaluation.perChip) || {})) {
    allowed.add(Number(fmtValue(entry.valueNow, 'points')));
    if (entry.bestValue !== null && entry.bestValue !== undefined) allowed.add(Number(fmtValue(entry.bestValue, 'points')));
    if (entry.threshold !== null && entry.threshold !== undefined) allowed.add(entry.threshold);
    if (entry.bestGw !== null && entry.bestGw !== undefined) allowed.add(entry.bestGw);
    if (entry.nextLegalGw !== null && entry.nextLegalGw !== undefined) allowed.add(entry.nextLegalGw);
  }
  // The formation, which is written into a sentence as "3-4-3".
  for (const part of String(plan.formation).split('-')) allowed.add(Number(part));
  return allowed;
}

function assertReasonHonest(reason, allowed, label) {
  const formatted = fmtValue(reason.value, reason.unit);
  assert.ok(
    reason.text.includes(formatted),
    `${label} ${reason.code}: the text must carry its own value ${formatted}: ${reason.text}`,
  );

  // Remove the formatted value once, then everything numeric that is left has
  // to be an engine quantity.
  const rest = reason.text.replace(formatted, ' ');
  for (const n of numbersIn(rest)) {
    assert.ok(
      allowed.has(n),
      `${label} ${reason.code}: ${n} is in the sentence but is not an engine number: ${reason.text}`,
    );
  }
  assert.equal(typeof reason.code, 'string');
  assert.ok(reason.value === null || Number.isFinite(reason.value), `${label} ${reason.code}: value must be a number`);
}

function sweep(bundle, plan, explanation, horizon, label) {
  const allowed = engineNumbers(bundle, plan, horizon);
  const reasons = allReasons(explanation);
  assert.ok(reasons.length > 0, `${label}: an explanation with no reasons explains nothing`);
  for (const reason of reasons) assertReasonHonest(reason, allowed, label);
  return reasons;
}

// ---------------------------------------------------------------------------

test('every number in every sentence of a transfer plan is an engine number', async () => {
  const xp = (id, gw) => (id === 310 ? 9 : id === 311 ? 8.6 : baseXp(id));
  const { bundle, horizon } = await scenario({ xp });
  const plan = bundle.current;

  assert.ok(plan.transferCount > 0, 'the scenario has to produce a transfer or it proves nothing');
  const reasons = sweep(bundle, plan, plan.explanation, horizon, 'current');
  assert.ok(reasons.some(r => r.code === 'transfer_gw_gain'));

  for (const future of bundle.future) {
    sweep(bundle, future, future.explanation, future.horizon, `gw${future.gw}`);
  }
});

test('every number in every sentence of a roll, a chip and a draft is an engine number', async () => {
  // Roll: nothing on the market is worth the transfer.
  const roll = await scenario({ xp: id => (id === 305 ? 5 : baseXp(id)) });
  assert.equal(roll.bundle.current.transferCount, 0);
  sweep(roll.bundle, roll.bundle.current, roll.bundle.current.explanation, roll.horizon, 'roll');
  assert.ok(roll.bundle.current.explanation.rollReason);

  // Chip: a bench worth boosting, with the chip in hand.
  const players = roster();
  const gameState = makeGameState(players, GW);
  const projections = makeProjections(gameState, GW, GW + 8, () => 6);
  const squadState = makeSquadState(SQUAD_IDS, gameState, { chipsUsed: [] });
  const chipBundle = await buildPlan({
    gameState, squadState, options: { horizon: 5, seed: 3, projections, strength: {} },
  });
  sweep(chipBundle, chipBundle.current, chipBundle.current.explanation, 5, 'chip');

  // Draft: the opening 15.
  const draftState = { ...makeSquadState(SQUAD_IDS, gameState), picks: [], source: 'draft' };
  const draft = await buildPlan({
    gameState, squadState: draftState, options: { horizon: 5, seed: 3, projections, strength: {} },
  });
  assert.equal(draft.current.explanation.headline, 'Build this opening 15');
  sweep(draft, draft.current, draft.current.explanation, 5, 'draft');
});

test('a manual pre-season squad is explained as an opening 15, never as an in-season roll', async () => {
  // The squad exactly as the app builds it when a fifteen is typed in or
  // restored from a snapshot before GW1: the real manualSquadState, planned
  // for gameweek one. This is the second encoding of the pre-season squad
  // (the fifteen held as picks, the remaining budget in the bank), and its
  // explanation must tell the same story the draft encoding tells.
  const players = roster();
  const gameState = makeGameState(players, 1);
  const projections = makeProjections(gameState, 1, 9, () => 6);
  // Chips withheld: flat projections make a bench boost look enormous, and a
  // chip headline outranks the opening-squad one by design. This test is
  // about the no-chip, no-transfer shape, the one every restored squad hits.
  const squadState = { ...manualSquadState({ ids: SQUAD_IDS, gameState, gw: 1 }), chipsUsed: NO_CHIPS, chipsAvailable: [] };
  const bundle = await buildPlan({
    gameState, squadState, options: { horizon: 5, seed: 3, projections, strength: {} },
  });
  const plan = bundle.current;

  assert.equal(plan.transferCount, 0, 'flat projections leave no gain to transfer for');
  assert.equal(plan.explanation.headline, 'Build this opening 15',
    'the headline is the opening-squad one, not "Roll your transfer"');

  const spend = plan.explanation.bullets.find(b => b.code === 'draft_spend');
  assert.ok(spend, 'the spend bullet is present for the manual encoding too');
  assert.equal(spend.value, RULES.budgetTenths - plan.bankAfterTenths,
    'and it prices the fifteen against the real budget, not against the empty bank');

  const roll = plan.explanation.rollReason;
  assert.ok(roll && roll.reasons.some(r => r.code === 'roll_preseason'),
    'the roll reasoning is the pre-season sentence, not banked-transfer value');
  sweep(bundle, plan, plan.explanation, 5, 'manual-preseason');
});

test('the plan-level bullets carry the plan-level numbers, to the digit', async () => {
  const xp = (id, gw) => (id === 310 ? 9 : baseXp(id));
  const { bundle, projections, horizon } = await scenario({ xp });
  const plan = bundle.current;
  const bullet = code => plan.explanation.bullets.find(b => b.code === code);

  assert.equal(bullet('plan_gw_points').value, plan.xPointsGw);
  assert.ok(bullet('plan_gw_points').text.includes(fmtValue(plan.xPointsGw, 'points')));

  assert.equal(bullet('plan_horizon_points').value, plan.xPointsHorizon);
  assert.ok(bullet('plan_horizon_points').text.includes(`Across ${horizon} gameweeks`));

  // The formation line quotes the eleven's points before the armband, which is
  // strictly less than the gameweek total that includes it.
  const formation = bullet('plan_formation');
  assert.ok(formation.text.includes(plan.formation));
  assert.ok(formation.value < plan.xPointsGw);
  assert.ok(Math.abs((formation.value + xpOf(projections, plan.captain, plan.gw)) - plan.xPointsGw) < 1e-9,
    'eleven plus one more copy of the captain is the gameweek total');

  const captain = bullet('captain_points');
  assert.equal(captain.value, xpOf(projections, plan.captain, plan.gw));
});

test('a hit is quoted at its net value, and only when there is a hit', async () => {
  const xp = (id, gw) => {
    if (id === 310 || id === 311) return 9;
    if (id === 305 || id === 403) return 0.2;
    return baseXp(id);
  };
  const { bundle } = await scenario({ xp, squad: { bankTenths: 40 }, options: { risk: 'aggressive' } });
  const plan = bundle.current;
  assert.equal(plan.hits, 1);

  const cost = plan.explanation.bullets.find(b => b.code === 'plan_hit_cost');
  assert.equal(cost.value, plan.xPointsNet);
  assert.equal(plan.xPointsNet, plan.xPointsGw - plan.hitCostPoints);
  assert.match(plan.explanation.headline, /take a 4 point hit/);

  const noHit = await scenario({ xp: id => (id === 310 ? 9 : baseXp(id)) });
  assert.equal(noHit.bundle.current.hits, 0);
  assert.equal(noHit.bundle.current.explanation.bullets.find(b => b.code === 'plan_hit_cost'), undefined);
});

test('each transfer reason is computed from the two players it names', async () => {
  const xp = (id, gw) => (id === 310 ? 9 : id === 311 ? 8.6 : baseXp(id));
  const { bundle, projections, squadState, gameState, horizon } = await scenario({ xp, squad: { freeTransfers: 2 } });
  const plan = bundle.current;
  const rows = plan.explanation.transferReasons;

  assert.equal(rows.length, plan.transfersIn.length);
  const weights = discountWeights(horizon, bundle.dataStatus.discount);

  for (const row of rows) {
    assert.ok(plan.transfersIn.includes(row.in));
    assert.ok(plan.transfersOut.includes(row.out));

    const gwGain = xpOf(projections, row.in, plan.gw) - xpOf(projections, row.out, plan.gw);
    assert.ok(Math.abs(row.gwGain - gwGain) < 1e-12);

    let horizonGain = 0;
    for (let k = 0; k < horizon; k++) {
      horizonGain += weights[k] * (xpOf(projections, row.in, plan.gw + k) - xpOf(projections, row.out, plan.gw + k));
    }
    assert.ok(Math.abs(row.horizonGain - horizonGain) < 1e-9, `${row.horizonGain} vs ${horizonGain}`);

    const reason = code => row.reasons.find(r => r.code === code);
    assert.equal(reason('transfer_gw_gain').value, row.gwGain);
    assert.equal(reason('transfer_horizon_gain').value, row.horizonGain);
    assert.equal(reason('transfer_in_minutes').value, projections.get(row.in, plan.gw).pStart);

    // The money line is this player's selling price, not the plan's total.
    const pick = squadState.picks.find(p => p.playerId === row.out);
    assert.equal(reason('transfer_money').value, pick.sellingTenths);
    assert.notEqual(pick.sellingTenths, gameState.players.get(row.out).nowCost, 'selling price is never now_cost here');
    assert.ok(reason('transfer_money').text.includes(fmtValue(pick.sellingTenths, 'tenths')));

    assert.equal(row.outPriceTenths, gameState.players.get(row.out).nowCost);
    assert.equal(row.inPriceTenths, gameState.players.get(row.in).nowCost);
  }

  // The plan's total money in is the sum of what the individual sentences said.
  const quoted = rows.map(r => r.reasons.find(x => x.code === 'transfer_money').value);
  assert.equal(quoted.reduce((s, v) => s + v, 0), plan.moneyInTenths);

  const bank = rows[rows.length - 1].reasons.find(r => r.code === 'transfer_bank_after');
  assert.equal(bank.value, plan.bankAfterTenths);
});

test('an unavailable player being sold is named as unavailable, from his status', async () => {
  const over = new Map([[305, { status: 'i', news: 'Knee injury' }]]);
  const xp = (id, gw) => (id === 310 ? 6 : baseXp(id));
  const { bundle, projections } = await scenario({ xp, over });
  const plan = bundle.current;

  assert.deepEqual(plan.transfersOut, [305]);
  const row = plan.explanation.transferReasons[0];
  const availability = row.reasons.find(r => r.code === 'transfer_out_availability');
  assert.ok(availability, 'an injured player sold is explained by his injury');
  assert.ok(availability.text.includes('injured'));
  assert.equal(availability.value, xpOf(projections, 305, plan.gw));
  assert.equal(availability.value, 0, 'and an unavailable player projects nothing');
});

test('the captain reason is the captain optimizer own numbers', async () => {
  const { bundle, projections } = await scenario({ xp: id => (id === 310 ? 9 : baseXp(id)) });
  const plan = bundle.current;
  const captain = plan.explanation.captainReason;
  const row = projections.get(plan.captain, plan.gw);

  assert.equal(captain.playerId, plan.captain);
  assert.equal(captain.viceCaptain, plan.viceCaptain);
  assert.equal(captain.xPoints, row.xPoints);
  assert.equal(captain.ceiling, row.ceiling);

  const byCode = code => captain.reasons.find(r => r.code === code);
  assert.equal(byCode('captain_points').value, row.xPoints);
  assert.equal(byCode('captain_ceiling').value, row.ceiling);
  assert.equal(byCode('captain_minutes').value, row.pStart);
  assert.equal(byCode('vice_cover').value, projections.get(plan.viceCaptain, plan.gw).xPoints);
  assert.ok(byCode('vice_cover').text.includes(fmtValue(projections.get(plan.viceCaptain, plan.gw).xPoints, 'points')));
});

test('the roll reason quotes the best move it turned down', async () => {
  const { bundle } = await scenario({ xp: id => (id === 305 ? 5 : baseXp(id)) });
  const plan = bundle.current;
  const roll = plan.explanation.rollReason;

  assert.equal(plan.transferCount, 0);
  assert.equal(roll.value, roll.reasons[0].value);
  assert.ok(roll.value > 0);
  assert.equal(
    roll.reasons.find(r => r.code === 'roll_banked').value,
    Math.min(plan.freeTransfersAfter + 1, RULES.maxFreeTransfers),
  );
  const best = roll.reasons.find(r => r.code === 'roll_best_alternative');
  if (best) {
    assert.ok(best.value <= 0 + 1e-9, 'the move that was turned down did not beat the roll');
  }
});

test('the headline is the plan, in words', () => {
  const plan = { gw: 10, chip: null, transferCount: 0, freeTransfersAfter: 1, hits: 0, hitCostPoints: 0 };
  assert.equal(planHeadline(plan), 'Roll your transfer');
  assert.equal(planHeadline({ ...plan, freeTransfersAfter: 0 }), 'Make no transfers');
  assert.equal(planHeadline({ ...plan, transferCount: 1 }), 'Make 1 transfer');
  assert.equal(planHeadline({ ...plan, transferCount: 2 }), 'Make 2 transfers');
  assert.equal(planHeadline({ ...plan, transferCount: 2, hits: 1, hitCostPoints: 4 }), 'Make 2 transfers and take a 4 point hit');
  assert.equal(planHeadline({ ...plan, chip: 'wildcard' }), 'Play your Wildcard');
  assert.equal(planHeadline({ ...plan, chip: 'freehit' }), 'Play your Free Hit');
  assert.equal(planHeadline({ ...plan, chip: 'bboost' }), 'Play your Bench Boost');
  assert.equal(planHeadline({ ...plan, chip: '3xc' }), 'Play your Triple Captain');
  assert.equal(planHeadline(plan, { isDraft: true }), 'Build this opening 15');
});

// ---------------------------------------------------------------------------
// Why not this player
// ---------------------------------------------------------------------------

test('whyNot answers with a real horizon delta and the swap it would take', async () => {
  const xp = (id, gw) => (id === 310 ? 9 : id === 311 ? 3 : baseXp(id));
  const { bundle, gameState } = await scenario({ xp });
  const answer = whyNot(311, { planBundle: bundle, gameState, rules: RULES });

  assert.equal(answer.playerId, 311);
  assert.ok(Number.isFinite(answer.deltaHorizon));
  assert.ok(answer.deltaHorizon < 0, 'a worse player is worse, and by a number');
  assert.equal(answer.alternative, false);
  assert.ok(answer.bestSwapOut !== undefined);
  assert.deepEqual(answer.blockers, [], 'nothing blocks him, he is simply worse');

  const swap = answer.reasons.find(r => r.code === 'whynot_best_swap');
  const delta = answer.reasons.find(r => r.code === 'whynot_delta');
  assert.equal(delta.value, answer.deltaHorizon);
  assert.ok(Math.abs((swap.value - bundle.current.xPointsHorizon) - answer.deltaHorizon) < 1e-9,
    'the delta is the swap total minus the recommended plan total');
  assert.ok(answer.text.includes(fmtValue(Math.abs(answer.deltaHorizon), 'points')));
  assert.ok(answer.text.includes(String(bundle.dataStatus.horizon)));
});

test('whyNot says a player is a fine alternative when he is one, instead of manufacturing an objection', async () => {
  // 311 is the same player as the recommended 310 in everything the model can
  // see. The honest answer is that either is defensible.
  const xp = (id, gw) => ((id === 310 || id === 311) ? 9 : baseXp(id));
  const { bundle, gameState } = await scenario({ xp, options: { maxHits: 0 } });
  assert.equal(bundle.current.transfersIn.length, 1);
  const other = bundle.current.transfersIn[0] === 310 ? 311 : 310;

  const answer = whyNot(other, { planBundle: bundle, gameState, rules: RULES });
  assert.equal(answer.alternative, true);
  assert.ok(Math.abs(answer.deltaHorizon) <= EXPLAIN_PARAMS.alternativeTolerance);
  assert.match(answer.text, /is a fine alternative/);
  assert.match(answer.text, /either is defensible/);
  assert.deepEqual(answer.blockers, []);
});

test('whyNot reports the real blocker when money or the club limit is the answer', async () => {
  // Priced out: a 15.0m midfielder against a squad whose most expensive
  // midfielder sells for 5.8m and a 0.5m bank.
  const over = new Map([[311, { nowCost: 150 }]]);
  const { bundle, gameState } = await scenario({ xp: baseXp, over });
  const priced = whyNot(311, { planBundle: bundle, gameState, rules: RULES });

  assert.equal(priced.deltaHorizon, null, 'there is no horizon delta for a player who cannot be bought');
  assert.equal(priced.alternative, false);
  const budget = priced.blockers.find(b => b.code === 'budget');
  assert.ok(budget, 'the blocker is the budget');
  const best = Math.max(...bundle.squadState.picks
    .filter(p => gameState.players.get(p.playerId).position === 3)
    .map(p => p.sellingTenths));
  assert.equal(budget.value, 150 - (bundle.squadState.bankTenths + best), 'and it says exactly how much is missing');
  assert.ok(budget.text.includes(fmtValue(budget.value, 'tenths')));
  assert.ok(priced.text.includes('cannot be brought in'));

  // Club limit: three of the recommended squad already come from the club the
  // player plays for, and none of them plays his position, so there is no legal
  // single swap at any price.
  const clubbed = new Map([[311, { teamId: 8 }], [201, { teamId: 8 }], [202, { teamId: 8 }], [203, { teamId: 8 }], [301, { teamId: 3 }]]);
  const clubWorld = await scenario({ xp: baseXp, over: clubbed });
  const blocked = whyNot(311, { planBundle: clubWorld.bundle, gameState: clubWorld.gameState, rules: RULES });
  const clubLimit = blocked.blockers.find(b => b.code === 'club_limit');
  assert.ok(clubLimit, `expected a club limit blocker, got ${JSON.stringify(blocked.blockers)}`);
  assert.equal(clubLimit.value, RULES.clubLimit);
});

test('whyNot answers honestly about a player who is already in the plan, and about one who does not exist', async () => {
  const { bundle, gameState } = await scenario({ xp: id => (id === 310 ? 9 : baseXp(id)) });
  const owned = whyNot(bundle.current.startingXI[0], { planBundle: bundle, gameState, rules: RULES });
  assert.equal(owned.alternative, true);
  assert.equal(owned.deltaHorizon, 0);
  assert.match(owned.text, /already in the recommended starting eleven/);

  const benched = whyNot(bundle.current.bench.order[0], { planBundle: bundle, gameState, rules: RULES });
  assert.match(benched.text, /already in the recommended squad, on the bench/);

  const missing = whyNot(999999, { planBundle: bundle, gameState, rules: RULES });
  assert.equal(missing.blockers[0].code, 'unknown_player');
  assert.equal(missing.deltaHorizon, 0);
});

test('whyNot names an injury when the player is unavailable', async () => {
  const over = new Map([[311, { status: 'i' }]]);
  const { bundle, gameState } = await scenario({ xp: id => (id === 310 ? 9 : baseXp(id)), over });
  const answer = whyNot(311, { planBundle: bundle, gameState, rules: RULES });
  const availability = answer.blockers.find(b => b.code === 'availability');
  assert.ok(availability);
  assert.ok(availability.text.includes('injured'));
  assert.equal(availability.value, 0);
});

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

const BLAMING = [
  /you should have/i, /you failed/i, /your mistake/i, /you were wrong/i,
  /you ignored/i, /unfortunately you/i, /bad decision/i, /you shouldn't have/i,
];

test('the rebuild notice is neutral and never blames the manager', async () => {
  assert.equal(REBUILD_NOTICE, "Team updated. We've rebuilt your plan based on your current squad.");
  for (const pattern of BLAMING) assert.ok(!pattern.test(REBUILD_NOTICE), `${pattern} appears in the rebuild notice`);
  assert.ok(!/ignored|instead of|failed|should/i.test(REBUILD_NOTICE));

  // It is only used through the explanation layer, where it carries the number
  // of players the rebuilt plan actually holds.
  const { bundle, gameState, projections, squadState } = await scenario({ xp: baseXp });
  const explanation = explainPlan(bundle.current, {
    projections,
    gameState,
    rules: RULES,
    squadState,
    horizon: 5,
    discount: bundle.dataStatus.discount,
    trajectory: null,
    squadChanged: true,
  });
  const notice = explanation.bullets.find(b => b.code === 'squad_changed');
  assert.ok(notice.text.startsWith(REBUILD_NOTICE));
  assert.equal(notice.value, bundle.current.squad.length);
  assert.equal(notice.value, RULES.squadSize);
});

test('no explanation anywhere blames the manager or invents a rationale', async () => {
  const { bundle } = await scenario({ xp: id => (id === 310 ? 9 : baseXp(id)) });
  const texts = [
    bundle.current.explanation.headline,
    ...allReasons(bundle.current.explanation).map(r => r.text),
    ...bundle.future.flatMap(f => [f.explanation.headline, ...allReasons(f.explanation).map(r => r.text)]),
  ];
  for (const text of texts) {
    for (const pattern of BLAMING) {
      assert.ok(!pattern.test(text), `blaming language in: ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The sample dataset, through the real projection model
// ---------------------------------------------------------------------------

test('the sample plan explanation survives the same number sweep', async () => {
  const SAMPLE_FILES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const sample = assembleSampleBundle(Object.fromEntries(
    SAMPLE_FILES.map(name => [name, read('..', 'data', 'sample', `${name}.json`)]),
  ));
  const gameState = buildGameState(sample.bootstrap, sample.fixtures, { fetchedAt: sample.fetchedAt });
  const squadState = buildSquadState({
    entry: sample.entry, history: sample.history, transfers: sample.transfers, picks: sample.picks,
    gameState, gw: sample.planEvent,
  });
  const bundle = await buildPlan({ gameState, squadState, options: { horizon: 5, seed: 7 } });
  const plan = bundle.current;

  // The sweep needs the live rules object, which is the sample payload's own.
  const allowed = engineNumbers(bundle, plan, 5);
  for (const reason of allReasons(plan.explanation)) assertReasonHonest(reason, allowed, 'sample');

  // And the values still trace to the plan.
  const bullet = code => plan.explanation.bullets.find(b => b.code === code);
  assert.equal(bullet('plan_gw_points').value, plan.xPointsGw);
  assert.equal(bullet('plan_horizon_points').value, plan.xPointsHorizon);
  assert.equal(plan.explanation.captainReason.xPoints, bundle.projections.get(plan.captain, plan.gw).xPoints);

  for (const row of plan.explanation.transferReasons) {
    const pick = squadState.picks.find(p => p.playerId === row.out);
    assert.equal(row.reasons.find(r => r.code === 'transfer_money').value, pick.sellingTenths);
  }

  // whyNot on a real player the plan did not pick.
  const unowned = [...gameState.players.values()].find(p => !plan.squad.includes(p.id) && p.position === 3 && p.status === 'a');
  const answer = whyNot(unowned.id, { planBundle: bundle, gameState, rules: gameState.rules });
  assert.ok(answer.text.length > 0);
  assert.ok(answer.deltaHorizon === null || Number.isFinite(answer.deltaHorizon));
  for (const reason of answer.reasons) assertReasonHonest(reason, allowed, 'sample whyNot');
  for (const blocker of answer.blockers) assertReasonHonest(blocker, allowed, 'sample whyNot blocker');
});

// ---------------------------------------------------------------------------
// The armband the pitch cannot explain (the gameweek 3 case)
// ---------------------------------------------------------------------------
//
// captain.js maximises a certainty equivalent, not expected points, so the
// recommended captain is regularly NOT the highest-xP name in the eleven. The
// pitch prints xP and nothing else, so on 2026-09-01 it showed a captain on
// 4.9 standing beside his own vice on 5.0, with no reason given anywhere.
//
// The selection is correct and is not what these tests guard. What they guard
// is that the explanation says WHICH term paid for the difference, so the
// recommendation can never contradict the numbers on screen without answering
// for it.

function armbandWorld(specs) {
  const players = new Map();
  const rows = new Map();
  for (const s of specs) {
    players.set(s.id, {
      id: s.id,
      webName: `Pl${letters(s.id)}`,
      position: s.position ?? 3,
      teamId: s.teamId,
      nowCost: 60,
      status: 'a',
      setPieces: {
        penaltiesOrder: s.penaltiesOrder ?? null,
        directFreekicksOrder: s.freekicksOrder ?? null,
        cornersOrder: s.cornersOrder ?? null,
      },
    });
    rows.set(s.id, {
      playerId: s.id,
      gw: 1,
      fixtures: s.fixtures ?? [{ fixtureId: 1, opponentId: 99, isHome: true, fdr: 3 }],
      pAppear: s.pAppear ?? 1,
      pStart: s.pStart ?? s.pAppear ?? 1,
      xMins: 85,
      xPoints: s.xPoints,
      sd: s.sd ?? 3,
      ceiling: s.ceiling ?? s.xPoints * 1.8,
      confidence: s.confidence ?? 'high',
    });
  }
  const projections = {
    gwFrom: 1,
    gwTo: 1,
    byPlayer: new Map([...rows].map(([id, r]) => [id, [r]])),
    get(id, gw) { return gw === 1 ? rows.get(id) || null : null; },
  };
  return { projections, gameState: { players, teams: new Map(), fixtures: [], events: [] }, xi: specs.map(s => s.id) };
}

// The explanation is driven off the trajectory row squadTrajectory builds, so
// the candidates here come out of the real engine rather than being written by
// hand: a change to the component names must break this, not slip past it.
function armbandExplanation(specs) {
  const world = armbandWorld(specs);
  const armband = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  const plan = {
    gw: 1,
    squad: world.xi.slice(),
    startingXI: world.xi.slice(),
    formation: '3-4-3',
    captain: armband.captain,
    viceCaptain: armband.viceCaptain,
    transfersIn: [],
    transfersOut: [],
    transferCount: 0,
    hits: 0,
    hitCostPoints: 0,
    chip: null,
    xPointsGw: 50,
    xPointsNet: 50,
    xPointsHorizon: 50,
    horizon: 1,
    bench: { gk: null, order: [] },
  };
  const explanation = explainPlan(plan, {
    projections: world.projections,
    gameState: world.gameState,
    rules: RULES,
    squadState: { picks: [], gw: 1, chipsUsed: [], bankTenths: 0, freeTransfers: 1 },
    horizon: 1,
    trajectory: {
      gws: [{
        gw: 1,
        xPointsXi: 50,
        captain: armband.captain,
        viceCaptain: armband.viceCaptain,
        captainScore: armband.captainScore,
        captainCandidates: armband.candidates,
      }],
    },
    isDraft: true,
  });
  return { world, armband, explanation, reasons: explanation.captainReason.reasons };
}

// The live gameweek 3 numbers, unrounded.
const GW3_SPECS = [
  {
    id: 106, position: 4, teamId: 4,
    xPoints: 4.8868768368893285, ceiling: 9, sd: 3.585760511524807,
    pAppear: 1, pStart: 0.8842316855270995, confidence: 'high',
    penaltiesOrder: 1,
    fixtures: [{ fixtureId: 22, opponentId: 20, isHome: true, fdr: 2 }],
  },
  {
    id: 426, position: 3, teamId: 16,
    xPoints: 4.952746603840873, ceiling: 9, sd: 3.6427082050419957,
    pAppear: 1, pStart: 0.8486080361769278, confidence: 'high',
    penaltiesOrder: 1, freekicksOrder: 1, cornersOrder: 1,
    fixtures: [{ fixtureId: 30, opponentId: 9, isHome: false, fdr: 3 }],
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: 200 + i, teamId: 50 + i, xPoints: 2, ceiling: 4, pAppear: 0.9,
  })),
];

test('a captain projecting less than a team mate says which term bought the armband', () => {
  const { armband, reasons } = armbandExplanation(GW3_SPECS);
  assert.equal(armband.captain, 106);
  assert.equal(armband.viceCaptain, 426);

  const over = reasons.find(r => r.code === 'captain_over_alternative');
  assert.ok(over, 'the explanation must answer for a captain the pitch shows behind a team mate');

  // It names the player a manager is comparing against, and the term that won.
  assert.match(over.text, /Pl\w+ projects 0\.1 more points this gameweek/);
  assert.match(over.text, /takes the armband on a kinder fixture/);

  // The printed figure is the engine's own gap, not a written-in number.
  assert.equal(fmtValue(over.value, 'points'), '0.1');
  assert.ok(Math.abs(over.value - (4.952746603840873 - 4.8868768368893285)) < 1e-12);

  // Nothing that did not actually favour the captain may be claimed: Bruno held
  // the set pieces and the higher mean, and both ceilings were identical.
  assert.doesNotMatch(over.text, /set-piece duty/);
  assert.doesNotMatch(over.text, /higher ceiling/);
  assert.doesNotMatch(over.text, /penalty duty/);

  // A margin of six ten-thousandths must not read as a confident preference.
  const close = reasons.find(r => r.code === 'captain_close');
  assert.ok(close, 'a near-tie must be declared');
  assert.ok(close.value > 0 && close.value < 0.001);
});

test('the highest projected captain is never made to explain himself', () => {
  const { armband, reasons } = armbandExplanation([
    { id: 1, teamId: 1, xPoints: 8, ceiling: 16, pAppear: 1, confidence: 'high', penaltiesOrder: 1, fixtures: [{ fdr: 2 }] },
    { id: 2, teamId: 2, xPoints: 5, ceiling: 9, pAppear: 1, confidence: 'high', fixtures: [{ fdr: 4 }] },
    ...Array.from({ length: 9 }, (_, i) => ({ id: 200 + i, teamId: 50 + i, xPoints: 2, ceiling: 4, pAppear: 0.9 })),
  ]);
  assert.equal(armband.captain, 1);
  assert.equal(reasons.find(r => r.code === 'captain_over_alternative'), undefined);
  assert.equal(reasons.find(r => r.code === 'captain_close'), undefined);
});

test('a gap too small to print is worded, never rendered as "0.0 more points"', () => {
  // The rival leads by 0.02: real, strictly greater, and invisible at one
  // decimal. The sentence must not claim a quantity the reader would read as
  // zero, and must not silently drop the comparison either.
  const { armband, reasons } = armbandExplanation([
    { id: 1, teamId: 1, xPoints: 4.90, ceiling: 9, pAppear: 1, confidence: 'high', fixtures: [{ fdr: 2 }] },
    { id: 2, teamId: 2, xPoints: 4.92, ceiling: 9, pAppear: 1, confidence: 'high', fixtures: [{ fdr: 3 }] },
    ...Array.from({ length: 9 }, (_, i) => ({ id: 200 + i, teamId: 50 + i, xPoints: 2, ceiling: 4, pAppear: 0.9 })),
  ]);
  assert.equal(armband.captain, 1);

  const over = reasons.find(r => r.code === 'captain_over_alternative');
  assert.ok(over);
  assert.match(over.text, /projects fractionally more this gameweek/);
  assert.doesNotMatch(over.text, /0\.0 more points/);
  assert.ok(over.value > 0);
  assert.equal(fmtValue(over.value, 'points'), '0.0');
});

test('the ceiling and the evidence are named when they are what won the armband', () => {
  // Same mean, a bigger ceiling: the upside term is the edge and must be the
  // term reported. The fixture is level so it must NOT be claimed.
  const ceilingCase = armbandExplanation([
    { id: 1, teamId: 1, xPoints: 6.0, ceiling: 16, pAppear: 1, confidence: 'high', fixtures: [{ fdr: 3 }] },
    { id: 2, teamId: 2, xPoints: 6.4, ceiling: 9, pAppear: 1, confidence: 'high', fixtures: [{ fdr: 3 }] },
    ...Array.from({ length: 9 }, (_, i) => ({ id: 200 + i, teamId: 50 + i, xPoints: 2, ceiling: 4, pAppear: 0.9 })),
  ]);
  assert.equal(ceilingCase.armband.captain, 1);
  const over = ceilingCase.reasons.find(r => r.code === 'captain_over_alternative');
  assert.match(over.text, /a higher ceiling/);
  assert.doesNotMatch(over.text, /kinder fixture/);

  // Model confidence is a subtracted penalty, so the better-evidenced player
  // has the edge and the sentence must say so in those words.
  const confidenceCase = armbandExplanation([
    { id: 1, teamId: 1, xPoints: 6.0, ceiling: 12, pAppear: 1, confidence: 'high', fixtures: [{ fdr: 3 }] },
    { id: 2, teamId: 2, xPoints: 6.3, ceiling: 12, pAppear: 1, confidence: 'low', fixtures: [{ fdr: 3 }] },
    ...Array.from({ length: 9 }, (_, i) => ({ id: 200 + i, teamId: 50 + i, xPoints: 2, ceiling: 4, pAppear: 0.9 })),
  ]);
  assert.equal(confidenceCase.armband.captain, 1);
  assert.match(
    confidenceCase.reasons.find(r => r.code === 'captain_over_alternative').text,
    /a better-evidenced projection/,
  );
});

test('the armband sentences survive the same number sweep as the rest', () => {
  // Every digit in an explanation must be an engine quantity. The new sentences
  // carry one number between them, and it is the reason's own value.
  const { reasons } = armbandExplanation(GW3_SPECS);
  for (const code of ['captain_over_alternative', 'captain_close']) {
    const r = reasons.find(x => x.code === code);
    const digits = r.text.match(/\d+(?:\.\d+)?/g) || [];
    for (const d of digits) assert.equal(d, fmtValue(r.value, r.unit), `${code}: "${d}" is not the reason's value`);
  }
});
