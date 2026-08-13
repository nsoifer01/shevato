// Explanations, derived from the plan the optimizer actually produced.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: every sentence carries the engine
// number it was built from. Nothing here inspects a plan and then writes a
// plausible story about it. Each reason is `{ code, text, value, unit }` and the
// text is produced BY formatting the value, through `makeReason`, so a test can
// assert that the figure a human reads is the figure the model computed. A
// narrative generator would pass a "does it read well" review and fail that
// test, which is the point.
//
// LANGUAGE. The manager is never blamed. If their squad no longer matches a
// previous recommendation, that is information, not a mistake: the plan is
// rebuilt from what they actually own and the wording says so neutrally. There
// is no copy in this file that tells anyone they were wrong.

import { makeReason, fmtValue, squadTrajectory, chipLabel, xpOf, discountWeights } from './chips.js';
import { hitCost, transferStateOf, isUnlimited } from './transfer-state.js';

// The exact neutral wording used whenever the squad on file differs from what
// was recommended last time. Exported so the UI cannot reinvent it in a less
// neutral form.
export const REBUILD_NOTICE = "Team updated. We've rebuilt your plan based on your current squad.";

// Two plans inside this many horizon points are honestly interchangeable, and
// `whyNot` says so rather than manufacturing an objection.
const ALTERNATIVE_TOLERANCE = 0.5;

export const EXPLAIN_PARAMS = Object.freeze({
  alternativeTolerance: ALTERNATIVE_TOLERANCE,
});

function nameOf(gameState, playerId) {
  const p = gameState.players.get(playerId);
  return p ? p.webName : `player ${playerId}`;
}

function clubOf(gameState, playerId) {
  const p = gameState.players.get(playerId);
  if (!p) return '';
  const t = gameState.teams.get(p.teamId);
  return t ? t.shortName : '';
}

function projRow(projections, playerId, gw) {
  return projections && typeof projections.get === 'function' ? projections.get(playerId, gw) : null;
}

// What this one player raises, which is his selling price and not the plan's
// total. A plan that sells two players has one moneyInTenths and two sentences,
// and attaching the total to each of them states a price the manager will not
// see in the game.
function sellingOf(ctx, playerId) {
  const pick = ((ctx.squadState && ctx.squadState.picks) || []).find(p => p.playerId === playerId);
  if (pick && Number.isFinite(pick.sellingTenths)) return pick.sellingTenths;
  const player = ctx.gameState.players.get(playerId);
  return player ? player.nowCost : 0;
}

function horizonGap(projections, inId, outId, gw, horizon, discount) {
  const weights = discountWeights(horizon, discount);
  let sum = 0;
  for (let k = 0; k < horizon; k++) {
    sum += weights[k] * (xpOf(projections, inId, gw + k) - xpOf(projections, outId, gw + k));
  }
  return sum;
}

const STATUS_WORDS = {
  i: 'injured',
  s: 'suspended',
  u: 'unavailable',
  n: 'not in the squad',
  d: 'a doubt',
};

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

export function planHeadline(plan, { isDraft } = {}) {
  if (isDraft) return 'Build this opening 15';
  if (plan.chip) return `Play your ${chipLabel(plan.chip)}`;
  if (plan.transferCount === 0) {
    return plan.freeTransfersAfter > 0 ? 'Roll your transfer' : 'Make no transfers';
  }
  const noun = plan.transferCount === 1 ? 'transfer' : 'transfers';
  return plan.hits
    ? `Make ${plan.transferCount} ${noun} and take a ${plan.hitCostPoints} point hit`
    : `Make ${plan.transferCount} ${noun}`;
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

function transferReasons(plan, ctx) {
  const { projections, gameState, horizon, discount, rules } = ctx;
  const gw = plan.gw;
  const rows = [];

  for (let i = 0; i < plan.transfersIn.length; i++) {
    const inId = plan.transfersIn[i];
    const outId = plan.transfersOut[i];
    if (outId === undefined) continue;

    const inRow = projRow(projections, inId, gw);
    const outRow = projRow(projections, outId, gw);
    const gwGain = xpOf(projections, inId, gw) - xpOf(projections, outId, gw);
    const hGain = horizonGap(projections, inId, outId, gw, horizon, discount);
    const reasons = [];

    reasons.push(makeReason(
      'transfer_gw_gain',
      `${nameOf(gameState, inId)} projects {v} points more than ${nameOf(gameState, outId)} this gameweek.`,
      gwGain,
    ));
    reasons.push(makeReason(
      'transfer_horizon_gain',
      `Over the next ${horizon} gameweeks the gap is {v} points, after discounting the later ones for uncertainty.`,
      hGain,
    ));

    const outPlayer = gameState.players.get(outId);
    if (outPlayer && STATUS_WORDS[outPlayer.status]) {
      reasons.push(makeReason(
        'transfer_out_availability',
        `${nameOf(gameState, outId)} is ${STATUS_WORDS[outPlayer.status]} and projects {v} points this gameweek.`,
        xpOf(projections, outId, gw),
      ));
    }
    if (inRow) {
      reasons.push(makeReason(
        'transfer_in_minutes',
        `${nameOf(gameState, inId)} is {v} to start.`,
        inRow.pStart,
        'percent',
      ));
      if (inRow.fixtures && inRow.fixtures.length !== 1) {
        reasons.push(makeReason(
          'transfer_in_fixtures',
          `${nameOf(gameState, inId)} has {v} fixtures this gameweek.`,
          inRow.fixtures.length,
          'count',
        ));
      }
    }
    if (outRow && outRow.fixtures && outRow.fixtures.length === 0) {
      reasons.push(makeReason(
        'transfer_out_blank',
        `${nameOf(gameState, outId)} has {v} fixtures this gameweek.`,
        0,
        'count',
      ));
    }
    reasons.push(makeReason(
      'transfer_money',
      `${nameOf(gameState, outId)} sells for {v}.`,
      sellingOf(ctx, outId),
      'tenths',
    ));

    rows.push({
      out: outId,
      in: inId,
      outName: nameOf(gameState, outId),
      inName: nameOf(gameState, inId),
      outClub: clubOf(gameState, outId),
      inClub: clubOf(gameState, inId),
      outPriceTenths: gameState.players.has(outId) ? gameState.players.get(outId).nowCost : 0,
      inPriceTenths: gameState.players.has(inId) ? gameState.players.get(inId).nowCost : 0,
      gwGain,
      horizonGain: hGain,
      reasons,
    });
  }

  // A multi transfer plan pairs players by index, which is arbitrary beyond the
  // first pair, so the money line is reported once at plan level too.
  if (rows.length && rules) {
    rows[rows.length - 1].reasons.push(makeReason(
      'transfer_bank_after',
      'You are left with {v} in the bank.',
      plan.bankAfterTenths,
      'tenths',
    ));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Captain
// ---------------------------------------------------------------------------

function captainReason(plan, ctx) {
  const { projections, gameState, trajectory } = ctx;
  const gw = plan.gw;
  const row = projRow(projections, plan.captain, gw);
  const first = trajectory && trajectory.gws ? trajectory.gws[0] : null;
  const reasons = [];

  reasons.push(makeReason(
    'captain_points',
    `${nameOf(gameState, plan.captain)} projects {v} points, doubled as captain.`,
    row ? row.xPoints : 0,
  ));
  if (row) {
    reasons.push(makeReason(
      'captain_ceiling',
      `His realistic ceiling this gameweek is {v} points before the armband.`,
      row.ceiling,
    ));
    reasons.push(makeReason(
      'captain_minutes',
      `He is {v} to start.`,
      row.pStart,
      'percent',
    ));
    if (row.fixtures && row.fixtures.length !== 1) {
      reasons.push(makeReason(
        'captain_fixtures',
        `He has {v} fixtures this gameweek.`,
        row.fixtures.length,
        'count',
      ));
    }
  }
  const viceRow = projRow(projections, plan.viceCaptain, gw);
  if (viceRow) {
    reasons.push(makeReason(
      'vice_cover',
      `${nameOf(gameState, plan.viceCaptain)} takes over if he does not play, projecting {v} points.`,
      viceRow.xPoints,
    ));
  }

  return {
    playerId: plan.captain,
    playerName: nameOf(gameState, plan.captain),
    viceCaptain: plan.viceCaptain,
    viceCaptainName: nameOf(gameState, plan.viceCaptain),
    captainScore: first ? first.captainScore : (row ? row.xPoints : 0),
    xPoints: row ? row.xPoints : 0,
    ceiling: row ? row.ceiling : 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

function chipReason(plan, ctx) {
  const evaluation = ctx.chipEvaluation;
  if (!evaluation) {
    return {
      decision: plan.chip ? 'play' : 'hold',
      chip: plan.chip,
      value: 0,
      alternativeGw: null,
      // Deliberately says nothing about how many chips are left: this branch
      // runs when no chip evaluation was passed in, so the chip ledger is
      // exactly what it does not know.
      reasons: [makeReason('chip_not_evaluated', 'No chip is part of the plan for gameweek {v}, and the chip decision is taken again against your live squad each week.', plan.gw, 'gw')],
    };
  }
  const rec = evaluation.recommendation;
  const entry = rec.chip ? evaluation.perChip[rec.chip] : null;
  return {
    decision: rec.decision,
    chip: rec.chip,
    value: rec.value,
    alternativeGw: entry ? entry.bestGw : bestHoldGw(evaluation),
    perChip: evaluation.perChip,
    reasons: rec.reasons,
  };
}

function bestHoldGw(evaluation) {
  let best = null;
  let bestValue = -Infinity;
  for (const entry of Object.values(evaluation.perChip || {})) {
    if (!entry.available || entry.bestGw === null) continue;
    const value = entry.bestValue === null ? 0 : entry.bestValue;
    if (value > bestValue) {
      bestValue = value;
      best = entry.bestGw;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Roll
// ---------------------------------------------------------------------------

function rollReason(plan, ctx) {
  if (plan.transferCount !== 0 || plan.chip) return null;
  const { scoredList, rollValue, hitMarginPoints } = ctx;
  const reasons = [];

  // Before the first deadline there is no transfer to keep and no count to
  // report: changes are unlimited until it passes, and the weekly allowance
  // starts at one afterwards. Saying "you go into next gameweek with 5" here was
  // the cap talking, and it was wrong by four.
  const preSeason = isUnlimited(transferStateOf(ctx.squadState, ctx.rules));
  if (preSeason) {
    reasons.push(makeReason(
      'roll_preseason',
      'Transfers are unlimited until the Gameweek {v} deadline, so this squad costs you nothing to assemble.',
      plan.gw,
      'gw',
    ));
  } else {
    reasons.push(makeReason(
      'roll_value',
      'Keeping the transfer is worth {v} points of future flexibility, which no move this week beat.',
      rollValue || 0,
    ));
  }
  reasons.push(makeReason(
    'roll_banked',
    'You go into next gameweek with {v} free transfers.',
    plan.freeTransfersNextGw,
    'count',
  ));

  const best = (scoredList || []).find(s => s.transferCount > 0);
  if (best) {
    reasons.push(makeReason(
      'roll_best_alternative',
      'The best move available gained only {v} points over the horizon.',
      best.xPointsHorizon - plan.xPointsHorizon,
    ));
    if (best.acct && best.acct.hits) {
      reasons.push(makeReason(
        'roll_hit_bar',
        'A hit has to beat doing nothing by {v} points on top of its cost before it is worth taking.',
        hitMarginPoints || 0,
      ));
    }
  }

  return { value: rollValue || 0, reasons };
}

// ---------------------------------------------------------------------------

export function explainPlan(plan, context = {}) {
  const ctx = {
    projections: context.projections,
    gameState: context.gameState,
    rules: context.rules,
    squadState: context.squadState,
    horizon: context.horizon || plan.horizon || 1,
    discount: context.discount === undefined ? 1 : context.discount,
    trajectory: context.trajectory,
    chipEvaluation: context.chipEvaluation,
    scoredList: context.scoredList,
    rollValue: context.rollValue,
    hitMarginPoints: context.hitMarginPoints,
    isDraft: !!context.isDraft,
    projected: !!context.projected,
    squadChanged: !!context.squadChanged,
  };

  const bullets = [];
  const headline = planHeadline(plan, { isDraft: ctx.isDraft });

  if (ctx.squadChanged) {
    bullets.push(makeReason('squad_changed', `${REBUILD_NOTICE} It now holds {v} of your players.`, plan.squad.length, 'count'));
  }
  if (ctx.projected) {
    bullets.push(makeReason(
      'projected_plan',
      'This is a projection for a later gameweek, so it is {v} as certain as this week and will be recomputed nearer the deadline.',
      plan.confidence === undefined ? 1 : plan.confidence,
      'percent',
    ));
  }

  bullets.push(makeReason(
    'plan_gw_points',
    'This plan projects {v} points this gameweek, captain included.',
    plan.xPointsGw,
  ));
  if (plan.hitCostPoints) {
    bullets.push(makeReason(
      'plan_hit_cost',
      'That is {v} points after the hit is paid for.',
      plan.xPointsNet,
    ));
  }
  bullets.push(makeReason(
    'plan_horizon_points',
    `Across ${ctx.horizon} gameweeks it projects {v} points, with later gameweeks discounted for uncertainty.`,
    plan.xPointsHorizon,
  ));
  bullets.push(makeReason(
    'plan_formation',
    `The eleven lines up as ${plan.formation}, projecting {v} points before the armband.`,
    ctx.trajectory && ctx.trajectory.gws ? ctx.trajectory.gws[0].xPointsXi : plan.xPointsGw,
  ));
  if (ctx.isDraft) {
    bullets.push(makeReason(
      'draft_spend',
      'The 15 costs {v} of your budget.',
      plan.moneyOutTenths,
      'tenths',
    ));
  }

  const transfers = ctx.isDraft ? [] : transferReasons(plan, ctx);
  const captain = captainReason(plan, ctx);
  const chip = chipReason(plan, ctx);
  const roll = rollReason(plan, ctx);

  bullets.push(...captain.reasons.slice(0, 1));
  if (chip.decision === 'hold' && chip.reasons.length) bullets.push(chip.reasons[0]);
  if (roll) bullets.push(roll.reasons[0]);

  return {
    headline,
    bullets: bullets.map(b => ({ code: b.code, text: b.text, value: b.value, unit: b.unit })),
    transferReasons: transfers,
    captainReason: captain,
    chipReason: chip,
    rollReason: roll,
  };
}

// ---------------------------------------------------------------------------
// "Why not this player?"
//
// Answered by running the same optimization the recommendation came from, with
// the player forced in. Not by looking him up in a table of adjectives: the
// answer is what it would actually cost to own him and what the horizon says
// about owning him, including the honest answer that he is just as good.
// ---------------------------------------------------------------------------

export function whyNot(playerId, { planBundle, gameState, rules }) {
  const plan = planBundle.current;
  const squadState = planBundle.squadState;
  const projections = planBundle.projections;
  const horizon = planBundle.dataStatus ? planBundle.dataStatus.horizon : plan.horizon;
  const discount = planBundle.dataStatus && planBundle.dataStatus.discount !== undefined
    ? planBundle.dataStatus.discount
    : 1;
  const gw = plan.gw;
  const target = gameState.players.get(playerId);

  if (!target) {
    return {
      playerId,
      text: 'That player is not in the current Fantasy Premier League player list.',
      deltaHorizon: 0,
      alternative: false,
      blockers: [{ code: 'unknown_player', text: 'No player with that id exists in the data we loaded.', value: playerId, unit: 'count' }],
      reasons: [],
    };
  }

  const name = nameOf(gameState, playerId);

  if (plan.squad.includes(playerId)) {
    const inXi = plan.startingXI.includes(playerId);
    return {
      playerId,
      text: inXi
        ? `${name} is already in the recommended starting eleven.`
        : `${name} is already in the recommended squad, on the bench this gameweek.`,
      deltaHorizon: 0,
      alternative: true,
      blockers: [],
      reasons: [makeReason('already_owned', `${name} projects {v} points this gameweek.`, xpOf(projections, playerId, gw))],
    };
  }

  const held = squadState.picks.map(p => p.playerId);
  const selling = new Map(squadState.picks.map(p => [p.playerId, p.sellingTenths]));
  const blockers = [];
  const reasons = [];

  const statusWord = STATUS_WORDS[target.status];
  if (statusWord) {
    blockers.push(makeReason('availability', `${name} is ${statusWord} and projects {v} points this gameweek.`, xpOf(projections, playerId, gw)));
  }

  // Club limit. Counted on the squad the recommendation ends with, because that
  // is the squad the manager would be adding him to.
  const clubCount = plan.squad.filter(id => {
    const p = gameState.players.get(id);
    return p && p.teamId === target.teamId;
  }).length;

  // Every legal single swap: same position, affordable at selling prices, and
  // inside the club limit once the outgoing player is gone.
  const options = [];
  let bestShortfall = Infinity;
  for (const outId of held) {
    const outPlayer = gameState.players.get(outId);
    if (!outPlayer) continue;
    if (outPlayer.position !== target.position) continue;

    const funds = squadState.bankTenths + (selling.get(outId) || 0);
    const shortfall = target.nowCost - funds;
    if (shortfall > 0) {
      if (shortfall < bestShortfall) bestShortfall = shortfall;
      continue;
    }
    const sameClubAfter = clubCount + (outPlayer.teamId === target.teamId ? 0 : 1);
    if (sameClubAfter > rules.clubLimit) continue;

    const squad = held.filter(id => id !== outId).concat(playerId);
    const trajectory = squadTrajectory({
      squadIds: squad, projections, gameState, rules, gwFrom: gw, horizon, discount,
    });
    const cost = hitCost(transferStateOf(squadState, rules), 1, rules);
    const hits = cost / rules.hitCost;
    const xPointsHorizon = trajectory.total - cost;
    options.push({ outId, xPointsHorizon, hits, trajectory });
  }

  if (!options.length) {
    if (Number.isFinite(bestShortfall)) {
      blockers.push(makeReason(
        'budget',
        `Bringing ${name} in needs another {v}, even after selling your most expensive ${rules.positions[target.position].short}.`,
        bestShortfall,
        'tenths',
      ));
    }
    if (clubCount >= rules.clubLimit) {
      blockers.push(makeReason(
        'club_limit',
        `You already hold {v} players from ${clubOf(gameState, playerId)}, which is the limit.`,
        clubCount,
        'count',
      ));
    }
    if (!blockers.length) {
      blockers.push(makeReason(
        'no_slot',
        `There is no ${rules.positions[target.position].short} in your squad who can be sold to fit ${name} in.`,
        0,
        'count',
      ));
    }
    return {
      playerId,
      text: `${name} cannot be brought in this gameweek: ${blockers.map(b => b.text).join(' ')}`,
      deltaHorizon: null,
      alternative: false,
      blockers,
      reasons,
    };
  }

  options.sort((a, b) => b.xPointsHorizon - a.xPointsHorizon);
  const best = options[0];
  const deltaHorizon = best.xPointsHorizon - plan.xPointsHorizon;

  reasons.push(makeReason(
    'whynot_best_swap',
    `The best route to ${name} is selling ${nameOf(gameState, best.outId)}, which projects {v} points over the horizon.`,
    best.xPointsHorizon,
  ));
  reasons.push(makeReason(
    'whynot_delta',
    `That is {v} points against the recommended plan.`,
    deltaHorizon,
  ));
  reasons.push(makeReason(
    'whynot_gw_points',
    `${name} projects {v} points this gameweek.`,
    xpOf(projections, playerId, gw),
  ));
  if (best.hits) {
    reasons.push(makeReason(
      'whynot_hit',
      `It would also cost a {v} point hit, because your free transfer is already committed.`,
      best.hits * rules.hitCost,
    ));
  }

  const alternative = deltaHorizon >= -ALTERNATIVE_TOLERANCE;
  const text = alternative
    ? `${name} is a fine alternative. Bringing him in for ${nameOf(gameState, best.outId)} projects ${fmtValue(Math.abs(deltaHorizon), 'points')} points ${deltaHorizon >= 0 ? 'more than' : 'inside'} the recommended plan over ${horizon} gameweeks, so either is defensible.`
    : `${name} projects ${fmtValue(Math.abs(deltaHorizon), 'points')} points fewer than the recommended plan over ${horizon} gameweeks, taking ${nameOf(gameState, best.outId)} out to fit him in.`;

  return {
    playerId,
    text,
    deltaHorizon,
    alternative,
    bestSwapOut: best.outId,
    hits: best.hits,
    blockers,
    reasons,
  };
}
