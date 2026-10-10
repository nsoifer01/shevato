// "Why not this player?", answered by optimizing twice.
//
// THE BUG THIS MODULE REPLACES. The old answer enumerated single swaps out of
// `squadState.picks` and, finding none, said "there is no MID in your squad who
// can be sold to fit him in". Pre-season `picks` is EMPTY - Fantasy Premier
// League publishes no team before the first deadline - so that branch fired for
// every player in the game, one screen below a recommended fifteen the app had
// just built itself. The sentence was not the fault. The comparison was: it
// asked "can this squad afford a sixteenth player", when the question a manager
// is asking is "why did the optimizer not pick him instead of the ones it did".
//
// WHAT IS COMPARED HERE.
//
//   BASELINE        the squad the optimizer already recommended.
//   COUNTERFACTUAL  the best squad the SAME optimizer builds with the requested
//                   player forced in (`buildSquad`'s `lockedIds`), or, in
//                   season, the best legal transfer ROUTE that ends holding him.
//
// Both are scored by `squadTrajectory`, the one squad evaluator the planner,
// the chip evaluator and the explanation layer all share, so the number quoted
// for the recommendation here is the same number the hero card shows.
//
// A FAIR COMPARISON IS TWO RUNS OF THE SAME OPTIMIZER, NOT ONE RUN AND A
// MEMORY. Pre-season the baseline used to be `plan.squad` exactly as stored,
// while the counterfactual was a fresh `buildSquad` with the player locked. A
// constrained search space is a SUBSET of the unconstrained one, so with the
// same data, objective and options the unconstrained answer can never be worse.
// Reading a stored squad against a freshly searched one broke that guarantee in
// both of the ways it can break: the stored squad could have been built under
// different options (the horizon is a setting, and it can change after a plan
// is computed), and even under identical options the two runs were ranked on
// DIFFERENT objectives, so the loser of one was the winner of the other. The
// result on screen was "BUILD THIS OPENING 15, 131.9 xP" directly above "best
// squad containing Haaland, 134.1, Haaland would improve the recommendation".
//
// So the baseline is rebuilt here, unconstrained, in the same call, from the
// same snapshot, with byte-identical options and seed. If that rebuild beats
// the stored plan the difference is reported on the answer as `staleBaseline`
// and the FRESH number is what the manager is shown, because a recommendation
// that is already beaten is not a recommendation.
//
// "CANNOT FIT" IS A CLAIM ABOUT THE GAME, NOT ABOUT THE SEARCH. It is only ever
// said when no legal squad containing the player exists at all, and it always
// names the constraint that actually binds: the player being unavailable, money
// that is genuinely impossible, the three-per-club limit, or a squad the pool
// cannot fill. "You already have fifteen players" is not a reason and is never
// emitted.
//
// EVERY FIGURE CARRIES ITS VALUE. Same discipline as explain.js: sentences are
// produced BY formatting an engine number (`reason()`), never written alongside
// one, so a test can assert that what a human reads is what the model computed.

import { buildSquad } from './squad-builder.js';
import { squadTrajectory, discountWeights, fmtValue } from './chips.js';
import { canCompareSquads } from './readiness.js';
import * as planner from './planner.js';
import { benchBoostDecision, tripleCaptainDecision } from './chips.js';
import { resolveMaxTransfers } from './transfers.js';
import { transferAccounting, transferStateOf, isUnlimited } from './transfer-state.js';
import { planBasis } from './plan-basis.js';

// Statuses the game will not let anyone buy: gone from the league, or not
// registered in a Premier League squad. Mirrors squad-builder.js.
const UNBUYABLE_STATUSES = new Set(['u', 'n']);

export const COUNTERFACTUAL_PARAMS = Object.freeze({
  // Two squads inside this many horizon points are honestly interchangeable.
  tieTolerance: 0.5,
  // Expected minutes over the whole horizon, so roughly a third of a start.
  minutesTolerance: 30,
  // The floor on how deep routes are enumerated. The real depth is the
  // planner's own (transfers.js `resolveMaxTransfers`: the free transfers
  // held, at least 2 and at most 5), so "why not him?" never refuses a route
  // the planner itself would search. See `maxRouteTransfers(ctx)`.
  maxRouteTransfers: 2,
  // Routes of three moves and more are grown from the best this many routes
  // of the depth below, by the same additive proxy as the two-move routes.
  routeBeamWidth: 4,
  // Routes of each depth from three up that get an exact evaluation.
  deepRouteShortlist: 4,
  // Replacements considered per position when a second move is needed, ranked
  // by projected points over the horizon.
  replacementsPerPosition: 6,
  // How many proxy-ranked two-move routes get an exact lineup evaluation.
  exactRouteShortlist: 12,
  // Alternatives offered behind the disclosure. One primary answer, a short
  // list of runners-up, never a dump of every route.
  maxAlternatives: 3,
});

/* ----------------------------------------------------------------- helpers */

function fmt(value, unit) {
  if (value === null || value === undefined) return '';
  if (unit === 'signed') return `${value >= 0 ? '+' : '-'}${(Math.round(Math.abs(value) * 10) / 10).toFixed(1)}`;
  return fmtValue(value, unit);
}

// `template` contains {v}, replaced by the formatted value. Nothing else in a
// sentence may be a number that did not come from `value`.
function reason(code, template, value, unit = 'points') {
  return { code, text: String(template).replace('{v}', fmt(value, unit)), value, unit };
}

function row(code, label, text, value = null, unit = 'points') {
  return { code, label, text, value, unit };
}

const nameOf = (gameState, id) => {
  const p = gameState.players.get(id);
  return p ? p.webName : `player ${id}`;
};

const clubOf = (gameState, id) => {
  const p = gameState.players.get(id);
  if (!p) return '';
  const t = gameState.teams.get(p.teamId);
  return t ? t.shortName : '';
};

const shortPosition = (rules, position) => (
  rules.positions[position] ? rules.positions[position].short : String(position)
);

function projRow(projections, playerId, gw) {
  return projections && typeof projections.get === 'function' ? projections.get(playerId, gw) : null;
}

function listAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* ----------------------------------------------------------------- context */

function makeContext(playerId, { planBundle, gameState, rules, opts = {} }) {
  const plan = planBundle.current;
  const status = planBundle.dataStatus || {};
  const horizon = opts.horizon ?? status.horizon ?? plan.horizon;
  const discount = opts.discount ?? (status.discount === undefined ? 1 : status.discount);
  const seed = opts.seed ?? (status.seed === undefined ? 1 : status.seed);

  return {
    playerId,
    plan,
    planBundle,
    squadState: planBundle.squadState,
    projections: planBundle.projections,
    gameState,
    rules,
    gw: plan.gw,
    horizon,
    discount,
    seed,
    weights: discountWeights(horizon, discount),
    target: gameState.players.get(playerId),
    name: nameOf(gameState, playerId),
  };
}

// The one scorer. Identical call shape to planner.js's, so a baseline recomputed
// here equals the plan's own xPointsHorizon rather than merely resembling it.
function scoreSquad(ctx, squadIds) {
  return squadTrajectory({
    squadIds,
    projections: ctx.projections,
    gameState: ctx.gameState,
    rules: ctx.rules,
    gwFrom: ctx.gw,
    horizon: ctx.horizon,
    discount: ctx.discount,
    opts: { seed: ctx.seed },
  });
}

// One player's own projected points over the horizon, discounted the way the
// squad is. Used for the player-versus-player half of the story; the squad
// deltas always come from scoreSquad.
function horizonXp(ctx, playerId) {
  let sum = 0;
  for (let k = 0; k < ctx.horizon; k++) {
    const r = projRow(ctx.projections, playerId, ctx.gw + k);
    if (r && Number.isFinite(r.xPoints)) sum += ctx.weights[k] * r.xPoints;
  }
  return sum;
}

// Undiscounted: minutes are a question about how likely he is to be on the
// pitch, not about how much a later gameweek is worth.
function horizonMinutes(ctx, playerId) {
  let sum = 0;
  for (let k = 0; k < ctx.horizon; k++) {
    const r = projRow(ctx.projections, playerId, ctx.gw + k);
    if (r && Number.isFinite(r.xMins)) sum += r.xMins;
  }
  return sum;
}

function fixtureProfile(ctx, playerId) {
  let count = 0;
  let fdrSum = 0;
  let blanks = 0;
  let doubles = 0;
  for (let k = 0; k < ctx.horizon; k++) {
    const r = projRow(ctx.projections, playerId, ctx.gw + k);
    const list = (r && r.fixtures) || [];
    if (!list.length) blanks++;
    if (list.length > 1) doubles++;
    for (const f of list) {
      count++;
      if (Number.isFinite(f.fdr)) fdrSum += f.fdr;
    }
  }
  return { count, blanks, doubles, meanFdr: count ? fdrSum / count : 0 };
}

function costOf(ctx, ids) {
  return ids.reduce((sum, id) => {
    const p = ctx.gameState.players.get(id);
    return sum + (p ? p.nowCost : 0);
  }, 0);
}

function clubCounts(ctx, ids) {
  const counts = new Map();
  for (const id of ids) {
    const p = ctx.gameState.players.get(id);
    if (!p) continue;
    counts.set(p.teamId, (counts.get(p.teamId) || 0) + 1);
  }
  return counts;
}

/* ----------------------------------------------------- squad diff and pairs */

// Who actually changes between two squads, paired inside each position.
//
// Pairing rule: within a position the outgoing and incoming players are each
// ranked by their own projected points over the horizon and matched by rank.
// In the ordinary case a position has exactly one of each and the pairing is
// forced; the rule only decides the rare two-for-two, and it decides it the way
// a manager reads it, best replacing best.
function diffPairs(ctx, fromSquad, toSquad) {
  const from = new Set(fromSquad);
  const to = new Set(toSquad);
  const outs = fromSquad.filter(id => !to.has(id));
  const ins = toSquad.filter(id => !from.has(id));

  const byPosition = new Map();
  const bucket = (id, key) => {
    const p = ctx.gameState.players.get(id);
    const pos = p ? p.position : 0;
    if (!byPosition.has(pos)) byPosition.set(pos, { out: [], in: [] });
    byPosition.get(pos)[key].push(id);
  };
  for (const id of outs) bucket(id, 'out');
  for (const id of ins) bucket(id, 'in');

  const pairs = [];
  const rank = (a, b) => horizonXp(ctx, b) - horizonXp(ctx, a) || a - b;
  for (const [position, group] of [...byPosition.entries()].sort((a, b) => a[0] - b[0])) {
    group.out.sort(rank);
    group.in.sort(rank);
    const n = Math.max(group.out.length, group.in.length);
    for (let i = 0; i < n; i++) {
      pairs.push({ position, out: group.out[i] ?? null, in: group.in[i] ?? null });
    }
  }
  return { outs, ins, pairs };
}

function pairText(ctx, pair) {
  if (pair.out === null) return `${nameOf(ctx.gameState, pair.in)} in`;
  if (pair.in === null) return `${nameOf(ctx.gameState, pair.out)} out`;
  return `${nameOf(ctx.gameState, pair.out)} to ${nameOf(ctx.gameState, pair.in)}`;
}

/* --------------------------------------------------------- shared narrative */

// The comparison every mode ends with: two squads, what changes between them,
// what it costs, and which one projects higher.
//
// `pairs` is supplied by the caller because "what changes" means two different
// things. Pre-season it is the difference between two whole squads. In season it
// is the ROUTE's own moves out of the squad the manager holds: comparing end
// squads there would list the recommended transfer as though fitting the player
// had caused it, when what it really means is that the transfer is spent
// elsewhere.
function compareSquads(ctx, {
  baselineTotal, baselineTraj, altSquad, altTotal, altTraj, pairs, hitPoints = 0,
  directSquad = null, directHitPoints = 0, directOverBudget = 0,
}) {
  const direct = pairs.find(p => p.in === ctx.playerId) || null;
  const knockOn = pairs.filter(p => p !== direct);

  const delta = altTotal - baselineTotal;
  const gwDelta = altTraj.gws[0].xPoints - baselineTraj.gws[0].xPoints;

  // THE KNOCK-ON, DECOMPOSED SO IT ADDS UP. The straight swap is scored on its
  // own - even when it is over budget, because "he is better one for one and
  // you still cannot have him" is exactly the case worth naming - and the
  // knock-on is the remainder. Both are rounded to the tenth that is printed
  // BEFORE the remainder is taken, so the three figures a manager reads add up
  // exactly rather than to within a rounding step of each other.
  const round1 = v => Math.round(v * 10) / 10;
  const decomposed = knockOn.length && directSquad
    ? (() => {
      const directDelta = round1(scoreSquad(ctx, directSquad).total - directHitPoints - baselineTotal);
      return { directDelta, knockOnDelta: round1(delta) - directDelta };
    })()
    : null;

  const reasons = [];
  reasons.push(gameweekReason(ctx, gwDelta));
  reasons.push(reason(
    'horizon_delta',
    delta >= 0
      ? 'The squad containing him is {v} xP better over the horizon.'
      : 'The recommended squad is {v} xP better over the horizon.',
    Math.abs(delta),
  ));

  if (direct && direct.out !== null) {
    // The player-versus-player gap is only worth a line when it says something
    // the squad-level swap effect does not already say in the same figure.
    const individual = individualGapReason(ctx, direct.out, direct.in);
    if (!decomposed || Math.abs(Math.abs(individual.value) - Math.abs(decomposed.directDelta)) >= 0.05) {
      reasons.push(individual);
    }
    reasons.push(...swapReasons(ctx, direct.out, direct.in));
  }

  if (decomposed) {
    reasons.push(reason(
      'direct_effect',
      decomposed.directDelta >= 0
        ? `${pairText(ctx, direct)} on its own would be worth {v} points.`
        : `${pairText(ctx, direct)} on its own would cost {v} points.`,
      Math.abs(decomposed.directDelta),
    ));
    if (directOverBudget > 0) {
      reasons.push(reason(
        'direct_unaffordable',
        'That straight swap is {v} over budget, so it is not available on its own.',
        directOverBudget,
        'tenths',
      ));
    }
    // NOT repeated as a bullet. The Knock-on changes row already lists these
    // moves and now carries this figure, so spelling the same list out again
    // underneath made the reader diff two long sentences to learn nothing. The
    // number still exists here as `decomposed.knockOnDelta` and is what that
    // row prints, so the arithmetic a manager checks is unchanged.
  }
  if (hitPoints > 0) {
    reasons.push(reason('hit', 'It costs a {v} point hit on top, because it uses more transfers than you have free.', hitPoints));
  }

  const captaincy = captainReason(ctx, baselineTraj, altTraj);
  if (captaincy) reasons.push(captaincy);
  const shape = shapeReason(ctx, baselineTraj, altTraj, altSquad);
  if (shape) reasons.push(shape);

  return {
    direct,
    knockOn,
    // Exposed so the Knock-on changes row can print the cost on the row itself
    // rather than in a sentence that repeats the whole list of moves.
    decomposed,
    delta,
    gwDelta,
    altCost: costOf(ctx, altSquad),
    reasons,
    preference: preferenceLine(ctx, { direct, delta, gwDelta }),
  };
}

function gameweekReason(ctx, gwDelta) {
  if (Math.abs(gwDelta) < 0.05) {
    return reason('gw_delta', `The two squads project within {v} points of each other in Gameweek ${ctx.gw}.`, Math.abs(gwDelta));
  }
  return reason(
    'gw_delta',
    gwDelta > 0
      ? `The squad containing him is {v} xP better in Gameweek ${ctx.gw}.`
      : `The recommended squad is {v} xP better in Gameweek ${ctx.gw}.`,
    Math.abs(gwDelta),
  );
}

// The head-to-head a manager asked about, before any squad effect: what the two
// players project on their own. This is the number that can point the OTHER way
// from the squad total, which is exactly the case worth naming.
function individualGapReason(ctx, outId, inId) {
  const gap = horizonXp(ctx, inId) - horizonXp(ctx, outId);
  return reason(
    'individual_gap',
    gap >= 0
      ? `On his own ${nameOf(ctx.gameState, inId)} projects {v} points more than ${nameOf(ctx.gameState, outId)} over the horizon.`
      : `On his own ${nameOf(ctx.gameState, inId)} projects {v} points fewer than ${nameOf(ctx.gameState, outId)} over the horizon.`,
    Math.abs(gap),
  );
}

// The one-line summary in the shape a manager reads first: who is preferred and
// the two or three grounds for it.
function preferenceLine(ctx, { direct, delta, gwDelta }) {
  if (!direct || direct.out === null) return null;
  const winner = delta < 0 ? direct.out : ctx.playerId;
  const sign = delta < 0 ? -1 : 1;
  const parts = [];
  if (Math.abs(gwDelta) >= 0.05) parts.push(`${fmt(sign * gwDelta, 'signed')} xP in Gameweek ${ctx.gw}`);
  parts.push(`${fmt(sign * delta, 'signed')} xP over the horizon`);

  const minutesGap = (horizonMinutes(ctx, winner) - horizonMinutes(ctx, winner === ctx.playerId ? direct.out : ctx.playerId));
  if (minutesGap >= COUNTERFACTUAL_PARAMS.minutesTolerance) parts.push('more secure expected minutes');

  const winnerFx = fixtureProfile(ctx, winner);
  const loserFx = fixtureProfile(ctx, winner === ctx.playerId ? direct.out : ctx.playerId);
  if (winnerFx.count > loserFx.count) parts.push('more fixtures in the horizon');
  else if (winnerFx.count === loserFx.count && loserFx.meanFdr - winnerFx.meanFdr >= 0.25) parts.push('kinder fixtures');

  return {
    code: 'preference',
    label: `${nameOf(ctx.gameState, winner)} is preferred because`,
    text: listAnd(parts),
    value: delta,
    unit: 'points',
  };
}

// The two rows every mode opens with.
function totalsRows(ctx, { baselineTotal, altTotal, baselineLabel, altLabelPrefix }) {
  return [
    row(
      'baseline_total',
      baselineLabel,
      `${fmt(baselineTotal)} xP over ${ctx.horizon} ${ctx.horizon === 1 ? 'gameweek' : 'gameweeks'}`,
      baselineTotal,
    ),
    row('alternative_total', `${altLabelPrefix} ${ctx.name}`, `${fmt(altTotal)} xP`, altTotal),
  ];
}

// "a difference of +£0.1m" put a lone "+" at the end of a line on a 390px
// screen, because a browser may break between the sign and the amount. The sign
// is a word here instead, which cannot come apart.
function budgetRow(ctx, altCost, baseCost) {
  const gap = altCost - baseCost;
  const direction = gap === 0 ? 'the same outlay' : `${fmt(Math.abs(gap), 'tenths')} ${gap > 0 ? 'more' : 'less'}`;
  return row(
    'budget',
    'Budget',
    `${fmt(altCost, 'tenths')} against ${fmt(baseCost, 'tenths')}, ${direction}`,
    gap,
    'tenths',
  );
}

// The player-versus-player half: minutes and fixtures, which are the two things
// a points total hides.
function swapReasons(ctx, outId, inId) {
  const out = [];
  const outMins = horizonMinutes(ctx, outId);
  const inMins = horizonMinutes(ctx, inId);
  const minutesGap = outMins - inMins;
  // Always reported, including when it is level: expected minutes is the figure
  // that decides whether a points gap is real or is one injury away.
  // The old wording read "their expected minutes are level, within 15 across
  // the horizon", which printed the MEASURED GAP where a reader expects a
  // threshold, so "within 15" looked like a rule when it was the answer. It was
  // also circular: X is within X. State the two totals and the gap instead, so
  // the sentence carries the evidence rather than a verdict on it.
  const outName = nameOf(ctx.gameState, outId);
  const inName = nameOf(ctx.gameState, inId);
  const level = Math.abs(minutesGap) < COUNTERFACTUAL_PARAMS.minutesTolerance;
  const mins = n => Math.round(n);
  out.push(reason(
    'minutes',
    level
      ? `Expected minutes are level over ${ctx.horizon} gameweeks: ${mins(outMins)} for ${outName} against ${mins(inMins)} for ${inName}, a gap of {v}.`
      : minutesGap > 0
        ? `${outName} has the more secure minutes over ${ctx.horizon} gameweeks: ${mins(outMins)} against ${mins(inMins)}, {v} more.`
        : `${inName} has the more secure minutes over ${ctx.horizon} gameweeks: ${mins(inMins)} against ${mins(outMins)}, {v} more.`,
    Math.abs(minutesGap),
    'count',
  ));

  const outFx = fixtureProfile(ctx, outId);
  const inFx = fixtureProfile(ctx, inId);
  if (inFx.count !== outFx.count) {
    out.push(reason(
      'fixtures_count',
      inFx.count > outFx.count
        ? `${nameOf(ctx.gameState, inId)} has {v} more ${inFx.count - outFx.count === 1 ? 'fixture' : 'fixtures'} in the horizon.`
        : `${nameOf(ctx.gameState, inId)} has {v} fewer ${outFx.count - inFx.count === 1 ? 'fixture' : 'fixtures'} in the horizon.`,
      Math.abs(inFx.count - outFx.count),
      'count',
    ));
  } else if (Math.abs(inFx.meanFdr - outFx.meanFdr) >= 0.25) {
    out.push(reason(
      'fixtures_fdr',
      inFx.meanFdr < outFx.meanFdr
        ? `${nameOf(ctx.gameState, inId)} has the kinder fixtures, {v} lower on average difficulty.`
        : `${nameOf(ctx.gameState, outId)} has the kinder fixtures, {v} lower on average difficulty.`,
      Math.abs(inFx.meanFdr - outFx.meanFdr),
    ));
  }

  const priceGap = ctx.gameState.players.get(inId).nowCost - ctx.gameState.players.get(outId).nowCost;
  if (priceGap !== 0) {
    out.push(reason(
      'price',
      priceGap > 0
        ? `${nameOf(ctx.gameState, inId)} costs {v} more.`
        : `${nameOf(ctx.gameState, inId)} costs {v} less.`,
      Math.abs(priceGap),
      'tenths',
    ));
  }
  return out;
}

function captainReason(ctx, baselineTraj, altTraj) {
  const before = baselineTraj.gws[0].captain;
  const after = altTraj.gws[0].captain;
  if (before === after) return null;
  return reason(
    'captain',
    `The armband moves from ${nameOf(ctx.gameState, before)} to ${nameOf(ctx.gameState, after)}, worth {v} doubled points this gameweek.`,
    altTraj.gws[0].captainExtra,
  );
}

function shapeReason(ctx, baselineTraj, altTraj, altSquad) {
  const first = altTraj.gws[0];
  if (!first.startingXI.includes(ctx.playerId) && altSquad.includes(ctx.playerId)) {
    return reason(
      'benched',
      `He does not make the eleven in Gameweek ${ctx.gw} even in that squad, so his {v} projected points reach your score only through an auto-substitution.`,
      (projRow(ctx.projections, ctx.playerId, ctx.gw) || { xPoints: 0 }).xPoints,
    );
  }
  if (first.formation !== baselineTraj.gws[0].formation) {
    return {
      code: 'formation',
      text: `Fitting him changes the shape from ${baselineTraj.gws[0].formation} to ${first.formation}.`,
      value: null,
      unit: 'text',
    };
  }
  return null;
}

function verdictOf(delta) {
  if (delta > COUNTERFACTUAL_PARAMS.tieTolerance) return 'better';
  if (delta < -COUNTERFACTUAL_PARAMS.tieTolerance) return 'worse';
  return 'level';
}

function resultLine(ctx, verdict, delta) {
  if (verdict === 'better') {
    return reason('result', `Result: the squad containing ${ctx.name} projects {v} points higher.`, Math.abs(delta));
  }
  if (verdict === 'worse') {
    return reason('result', 'Result: the recommended squad projects {v} points higher.', Math.abs(delta));
  }
  return reason('result', 'Result: the two squads are within {v} points, so either is defensible.', Math.abs(delta));
}

function headlineFor(ctx, verdict) {
  if (verdict === 'better') return `${ctx.name} would improve the recommendation.`;
  if (verdict === 'level') return `${ctx.name} is just as good as the recommendation.`;
  return `${ctx.name} is a valid option.`;
}

/* ------------------------------------------------------------- feasibility */

// A legal fifteen containing this player, built cheapest-first: him, then the
// cheapest buyable player for every remaining slot, skipping any club already
// at the limit. If THAT costs more than the budget, no squad containing him
// exists and the money is the real answer.
//
// Cheapest-first per position is not provably the global minimum under the club
// limit, but with twenty clubs and a three-per-club cap it is only ever forced
// to skip when a club's cheap players are stacked in one position, so the
// figure it returns is the honest floor in every real dataset.
function cheapestSquadWith(ctx, playerId) {
  const { gameState, rules } = ctx;
  const forced = gameState.players.get(playerId);
  const byPosition = new Map();
  for (const p of gameState.players.values()) {
    if (p.id === playerId) continue;
    if (UNBUYABLE_STATUSES.has(p.status)) continue;
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }
  for (const list of byPosition.values()) list.sort((a, b) => a.nowCost - b.nowCost || a.id - b.id);

  const counts = new Map([[forced.teamId, 1]]);
  let total = forced.nowCost;
  for (const position of Object.values(rules.positions)) {
    let need = position.squadSelect - (position.id === forced.position ? 1 : 0);
    for (const p of byPosition.get(position.id) || []) {
      if (need === 0) break;
      if ((counts.get(p.teamId) || 0) >= rules.clubLimit) continue;
      counts.set(p.teamId, (counts.get(p.teamId) || 0) + 1);
      total += p.nowCost;
      need--;
    }
    if (need > 0) {
      return {
        ok: false,
        code: 'squad',
        position,
        available: (byPosition.get(position.id) || []).length,
        total: Infinity,
      };
    }
  }
  return { ok: true, total };
}

function unavailableBlocker(ctx) {
  if (!UNBUYABLE_STATUSES.has(ctx.target.status)) return null;
  return reason(
    'unavailable',
    `${ctx.name} cannot be selected in Fantasy Premier League right now: he is not in a Premier League squad. He projects {v} points this gameweek.`,
    (projRow(ctx.projections, ctx.playerId, ctx.gw) || { xPoints: 0 }).xPoints,
  );
}

function impossible(ctx, blockers, { mode }) {
  return {
    playerId: ctx.playerId,
    name: ctx.name,
    mode,
    verdict: 'impossible',
    headline: `${ctx.name} cannot be fitted into any legal squad.`,
    rows: [],
    reasons: [],
    result: null,
    blockers,
    alternatives: [],
    deltaHorizon: null,
    text: `${ctx.name} cannot be fitted into any legal squad. ${blockers.map(b => b.text).join(' ')}`,
  };
}

/* ------------------------------------------------------------ opening squad */

// The unconstrained arm of the comparison, memoized.
//
// Every "why not this player" query on a draft plan needs the same fresh
// unconstrained build, and building it is the expensive half of the answer. The
// cache is keyed by the projection snapshot (a per-plan object, so a recomputed
// plan is a cache miss by construction) and by every option that enters the
// build, so two answers can only ever share a baseline when they would have
// computed the identical one.
const BASELINE_CACHE = new WeakMap();

function unconstrainedBaseline(ctx) {
  const budget = ctx.rules.budgetTenths;
  const key = `${ctx.gw}|${ctx.horizon}|${ctx.discount}|${ctx.seed}|${budget}`;
  let byKey = BASELINE_CACHE.get(ctx.projections);
  if (!byKey) {
    byKey = new Map();
    BASELINE_CACHE.set(ctx.projections, byKey);
  }
  if (byKey.has(key)) return byKey.get(key);

  let built = null;
  try {
    built = buildSquad({
      projections: ctx.projections,
      gameState: ctx.gameState,
      rules: ctx.rules,
      gw: ctx.gw,
      horizon: ctx.horizon,
      budgetTenths: budget,
      opts: { discount: ctx.discount, seed: ctx.seed },
    });
  } catch {
    built = null;
  }
  byKey.set(key, built);
  return built;
}

// One unconstrained descent starting FROM a squad the constrained search found.
//
// This is what makes the contradiction structurally impossible rather than
// merely unlikely. The forced squad is a legal squad with no constraint
// attached to it, so it is a candidate the unconstrained search was entitled to
// return. Handing it back in as a starting point can only go up: the seed is
// scored, the descent keeps the best it sees, and the exact re-score at the end
// ranks the seed against everything the descent produced. So
//
//     polish(forced) >= forced
//
// always, and a baseline taken as the best of the stored plan, a fresh
// unconstrained build and this polish can never read lower than the squad it is
// being compared against. When this path is what wins, the recommendation on
// screen really was beatable and the answer says so through `staleBaseline`
// rather than printing the two numbers side by side and leaving the manager to
// notice.
function polishFrom(ctx, squad) {
  try {
    return buildSquad({
      projections: ctx.projections,
      gameState: ctx.gameState,
      rules: ctx.rules,
      gw: ctx.gw,
      horizon: ctx.horizon,
      budgetTenths: ctx.rules.budgetTenths,
      opts: {
        discount: ctx.discount,
        seed: ctx.seed,
        seedSquads: [squad],
        // The seed is the point of this call. Restarts would re-derive squads
        // the fresh build already has, and a challenge pass on top of a squad
        // that is only being used as a floor is time spent twice.
        restarts: 0,
        challengers: 0,
      },
    });
  } catch {
    return null;
  }
}

// Which squad the answer calls "the recommendation": the stored plan, unless a
// fresh unconstrained run of the same optimizer with the same options beats it,
// in which case the stored plan is stale and the fresh one is the honest
// baseline. `stale` is non-null exactly when that happened, so the UI can offer
// a recompute instead of quoting a number the engine no longer stands behind.
//
// Named for the SQUAD it resolves, not just "the baseline": `engine/baseline.js`
// exports a `resolveBaseline` that decides which season's TOTALS to project
// from, and the two have nothing to do with each other. One name for two
// unrelated ideas in one engine is how the wrong import gets written.
function resolveBaselineSquad(ctx, floorSquad = null) {
  const candidates = [{ squad: ctx.plan.squad, traj: scoreSquad(ctx, ctx.plan.squad), stored: true }];

  const built = unconstrainedBaseline(ctx);
  if (built) candidates.push({ squad: built.squad, traj: scoreSquad(ctx, built.squad), stored: false });

  const stored = candidates[0];
  if (floorSquad) {
    const bestSoFar = candidates.reduce((a, b) => (b.traj.total > a.traj.total ? b : a));
    const floorTraj = scoreSquad(ctx, floorSquad);
    if (floorTraj.total > bestSoFar.traj.total + 1e-9) {
      const polished = polishFrom(ctx, floorSquad);
      const squad = polished ? polished.squad : floorSquad;
      candidates.push({ squad, traj: scoreSquad(ctx, squad), stored: false });
    }
  }

  const winner = candidates.reduce((a, b) => (b.traj.total > a.traj.total + 1e-9 ? b : a));
  if (winner.stored) return { squad: ctx.plan.squad, traj: stored.traj, stale: null };

  return {
    squad: winner.squad,
    traj: winner.traj,
    stale: {
      storedTotal: stored.traj.total,
      freshTotal: winner.traj.total,
      delta: winner.traj.total - stored.traj.total,
      squad: winner.squad.slice(),
      reason: reason(
        'stale_recommendation',
        'The recommendation on screen is beaten by {v} points by a squad this search has now found, so it is being compared against that squad rather than against itself. Recompute the plan to adopt it.',
        winner.traj.total - stored.traj.total,
      ),
    },
  };
}

// Pre-season, and any time the plan is a draft: no squad to transfer from, so
// the counterfactual is a whole rebuild with the player locked in.
function draftAnswer(ctx) {
  const unavailable = unavailableBlocker(ctx);
  if (unavailable) return impossible(ctx, [unavailable], { mode: 'draft' });

  const budget = ctx.rules.budgetTenths;
  const floor = cheapestSquadWith(ctx, ctx.playerId);
  if (!floor.ok) {
    return impossible(ctx, [reason(
      'squad',
      `A legal squad needs more ${shortPosition(ctx.rules, floor.position.id)} than the game currently has selectable: only {v} can be bought at all.`,
      floor.available,
      'count',
    )], { mode: 'draft' });
  }
  if (floor.total > budget) {
    return impossible(ctx, [reason(
      'budget',
      `The cheapest legal fifteen containing ${ctx.name} costs {v} more than the budget, so no squad in the game can hold him.`,
      floor.total - budget,
      'tenths',
    )], { mode: 'draft' });
  }

  let built;
  try {
    built = buildSquad({
      projections: ctx.projections,
      gameState: ctx.gameState,
      rules: ctx.rules,
      gw: ctx.gw,
      horizon: ctx.horizon,
      budgetTenths: budget,
      lockedIds: [ctx.playerId],
      opts: { discount: ctx.discount, seed: ctx.seed },
    });
  } catch {
    return impossible(ctx, [reason(
      'club_limit',
      `No legal fifteen can be assembled around him inside the {v} players per club limit.`,
      ctx.rules.clubLimit,
      'count',
    )], { mode: 'draft' });
  }

  const baseline = resolveBaselineSquad(ctx, built.squad);
  const baselineSquad = baseline.squad;
  const baselineTraj = baseline.traj;

  // The up-to-date best squad already holds him. That is not "he would improve
  // the recommendation", it is "the recommendation on screen is out of date and
  // the current one picks him".
  if (baseline.stale && baselineSquad.includes(ctx.playerId)) {
    const headline = `${ctx.name} is in the best squad on these settings, and the recommendation on screen is out of date.`;
    return {
      playerId: ctx.playerId,
      name: ctx.name,
      mode: 'draft',
      verdict: 'stale',
      headline,
      rows: [
        row('baseline_total', 'Best squad on these settings', `${fmt(baselineTraj.total)} xP over ${ctx.horizon} ${ctx.horizon === 1 ? 'gameweek' : 'gameweeks'}`, baselineTraj.total),
        row('stale_recommendation', 'Recommendation out of date', baseline.stale.reason.text, baseline.stale.delta),
      ],
      reasons: [baseline.stale.reason],
      result: null,
      blockers: [],
      alternatives: [],
      deltaHorizon: 0,
      squad: baselineSquad.slice(),
      baselineSquad: baselineSquad.slice(),
      staleBaseline: baseline.stale,
      bankTenths: budget - costOf(ctx, baselineSquad),
      text: `${headline} ${baseline.stale.reason.text}`,
    };
  }

  const altTraj = scoreSquad(ctx, built.squad);
  const { pairs } = diffPairs(ctx, baselineSquad, built.squad);
  const straight = pairs.find(p => p.in === ctx.playerId) || null;
  const directSquad = straight && straight.out !== null
    ? baselineSquad.filter(id => id !== straight.out).concat(ctx.playerId)
    : null;
  const comparison = compareSquads(ctx, {
    baselineTotal: baselineTraj.total,
    baselineTraj,
    altSquad: built.squad,
    altTotal: altTraj.total,
    altTraj,
    pairs,
    directSquad,
    directOverBudget: directSquad ? Math.max(0, costOf(ctx, directSquad) - budget) : 0,
  });

  const baseCost = costOf(ctx, baselineSquad);
  const rows = totalsRows(ctx, {
    baselineTotal: baselineTraj.total,
    altTotal: altTraj.total,
    baselineLabel: baseline.stale ? 'Best squad on these settings' : 'Best current squad',
    altLabelPrefix: 'Best squad containing',
  });
  if (baseline.stale) {
    rows.push(row(
      'stale_recommendation',
      'Recommendation out of date',
      baseline.stale.reason.text,
      baseline.stale.delta,
    ));
  }
  if (comparison.direct && comparison.direct.out !== null) {
    rows.push(row('direct_change', 'Best direct change', pairText(ctx, comparison.direct), null, 'text'));
  }
  if (comparison.knockOn.length) {
    // The cost rides on this row rather than in a sentence underneath it. The
    // bullet that used to repeat the whole list ("Fitting him also forces A to
    // B, C to D ... which costs 5.8 points") said nothing this row does not,
    // and a reader had to match two long lists to see they were the same moves.
    const cost = comparison.decomposed ? comparison.decomposed.knockOnDelta : null;
    const suffix = Number.isFinite(cost) && Math.abs(cost) >= 0.05
      ? ` (${fmt(cost, 'signed')} xP)`
      : '';
    rows.push(row(
      'knock_on',
      comparison.knockOn.length === 1 ? 'Knock-on change' : 'Knock-on changes',
      `${listAnd(comparison.knockOn.map(p => pairText(ctx, p)))}${suffix}`,
      Number.isFinite(cost) ? cost : null,
      Number.isFinite(cost) ? 'points' : 'text',
    ));
  }
  rows.push(budgetRow(ctx, comparison.altCost, baseCost));
  rows.push(row(
    'bank_after',
    'Bank after',
    `${fmt(budget - comparison.altCost, 'tenths')} left, against ${fmt(budget - baseCost, 'tenths')} in the recommended squad`,
    budget - comparison.altCost,
    'tenths',
  ));
  if (comparison.preference) rows.push(comparison.preference);

  const verdict = verdictOf(comparison.delta);
  return {
    playerId: ctx.playerId,
    name: ctx.name,
    mode: 'draft',
    verdict,
    headline: headlineFor(ctx, verdict),
    rows,
    reasons: comparison.reasons,
    result: resultLine(ctx, verdict, comparison.delta),
    blockers: [],
    alternatives: [],
    deltaHorizon: comparison.delta,
    squad: built.squad,
    baselineSquad: baselineSquad.slice(),
    staleBaseline: baseline.stale,
    bankTenths: budget - comparison.altCost,
    text: `${headlineFor(ctx, verdict)} ${resultLine(ctx, verdict, comparison.delta).text}`,
  };
}

/* -------------------------------------------------------------- in season */

function heldState(ctx) {
  const picks = ctx.squadState.picks || [];
  const ids = picks.map(p => p.playerId);
  const selling = new Map(picks.map(p => [
    p.playerId,
    Number.isFinite(p.sellingTenths) ? p.sellingTenths : (ctx.gameState.players.get(p.playerId) || { nowCost: 0 }).nowCost,
  ]));
  return { ids, selling, bank: ctx.squadState.bankTenths || 0 };
}

function legalSquad(ctx, ids) {
  if (ids.length !== ctx.rules.squadSize) return false;
  for (const [, n] of clubCounts(ctx, ids)) if (n > ctx.rules.clubLimit) return false;
  const counts = new Map();
  for (const id of ids) {
    const p = ctx.gameState.players.get(id);
    if (!p) return false;
    counts.set(p.position, (counts.get(p.position) || 0) + 1);
  }
  for (const position of Object.values(ctx.rules.positions)) {
    if ((counts.get(position.id) || 0) !== position.squadSelect) return false;
  }
  return true;
}

// Candidate replacements for a slot, best projected first, cheap enough to be
// worth evaluating. Held players are excluded because a squad cannot hold a
// player twice.
function replacementPool(ctx, position, exclude, maxCost) {
  const out = [];
  for (const p of ctx.gameState.players.values()) {
    if (p.position !== position) continue;
    if (exclude.has(p.id)) continue;
    if (UNBUYABLE_STATUSES.has(p.status)) continue;
    if (p.nowCost > maxCost) continue;
    out.push(p);
  }
  out.sort((a, b) => horizonXp(ctx, b.id) - horizonXp(ctx, a.id) || a.id - b.id);
  return out.slice(0, COUNTERFACTUAL_PARAMS.replacementsPerPosition);
}

const routeKey = r => `${r.out.slice().sort((a, b) => a - b).join(',')}>${r.in.slice().sort((a, b) => a - b).join(',')}`;

// Every legal way to end this gameweek holding the target, in one move or two,
// and then as many more as the planner's own search would make.
// Two-move routes are shortlisted on an additive proxy before any of them is
// scored properly, because the exact scorer runs a lineup optimization per
// gameweek and there are hundreds of pairs.
function enumerateRoutes(ctx) {
  const { ids, selling, bank } = heldState(ctx);
  const held = new Set(ids);
  const target = ctx.target;
  const routes = [];
  let bestShortfall = Infinity;
  let clubBlocked = false;

  const sameClubHeld = ids.filter(id => {
    const p = ctx.gameState.players.get(id);
    return p && p.teamId === target.teamId;
  });
  const clubRoomNeeded = sameClubHeld.length + 1 > ctx.rules.clubLimit;

  for (const outId of ids) {
    const outPlayer = ctx.gameState.players.get(outId);
    if (!outPlayer || outPlayer.position !== target.position) continue;
    const funds = bank + (selling.get(outId) || 0);
    const shortfall = target.nowCost - funds;
    if (shortfall > 0) {
      bestShortfall = Math.min(bestShortfall, shortfall);
      continue;
    }
    const squad = ids.filter(id => id !== outId).concat(ctx.playerId);
    if (!legalSquad(ctx, squad)) {
      if (clubRoomNeeded) clubBlocked = true;
      continue;
    }
    routes.push({ transfers: 1, out: [outId], in: [ctx.playerId], squad, bank: funds - target.nowCost });
  }

  // A second move is worth enumerating when one move cannot reach him, and also
  // when it can: selling a second player is how a manager funds an upgrade.
  const proxies = [];
  for (const outA of ids) {
    const a = ctx.gameState.players.get(outA);
    if (!a || a.position !== target.position) continue;
    for (const outB of ids) {
      if (outB === outA) continue;
      const b = ctx.gameState.players.get(outB);
      if (!b) continue;
      const funds = bank + (selling.get(outA) || 0) + (selling.get(outB) || 0);
      if (funds < target.nowCost) {
        bestShortfall = Math.min(bestShortfall, target.nowCost - funds);
        continue;
      }
      const exclude = new Set([...held, ctx.playerId]);
      for (const cand of replacementPool(ctx, b.position, exclude, funds - target.nowCost)) {
        const squad = ids.filter(id => id !== outA && id !== outB).concat(ctx.playerId, cand.id);
        if (!legalSquad(ctx, squad)) {
          if (clubRoomNeeded) clubBlocked = true;
          continue;
        }
        const gain = (horizonXp(ctx, ctx.playerId) - horizonXp(ctx, outA))
          + (horizonXp(ctx, cand.id) - horizonXp(ctx, outB));
        proxies.push({
          transfers: 2,
          out: [outA, outB],
          in: [ctx.playerId, cand.id],
          squad,
          bank: funds - target.nowCost - cand.nowCost,
          proxy: gain,
        });
      }
    }
  }
  proxies.sort((a, b) => b.proxy - a.proxy);
  const byProxy = (a, b) => b.proxy - a.proxy || routeKey(a).localeCompare(routeKey(b));
  routes.push(...proxies.slice(0, COUNTERFACTUAL_PARAMS.exactRouteShortlist));

  // Three moves and more, as deep as the planner searches: each depth grows
  // the best routes of the one below by one more upgrade, on the same proxy.
  // A free transfer the manager holds is a move the planner would make, so a
  // route that needs it to fit him in, or to spend the money he frees, is a
  // fair answer to "why not him?".
  const depthMax = maxRouteTransfers(ctx);
  let frontier = proxies;
  const seenRoutes = new Set(proxies.map(routeKey));
  for (let depth = 3; depth <= depthMax && frontier.length; depth++) {
    const next = [];
    for (const r of frontier.slice(0, COUNTERFACTUAL_PARAMS.routeBeamWidth)) {
      const inSquad = new Set([...held, ...r.in]);
      for (const outId of ids) {
        if (r.out.includes(outId)) continue;
        const p = ctx.gameState.players.get(outId);
        if (!p) continue;
        const funds = r.bank + (selling.get(outId) || 0);
        for (const cand of replacementPool(ctx, p.position, inSquad, funds)) {
          const squad = r.squad.filter(id => id !== outId).concat(cand.id);
          if (!legalSquad(ctx, squad)) continue;
          const route = {
            transfers: depth,
            out: r.out.concat(outId),
            in: r.in.concat(cand.id),
            squad,
            bank: funds - cand.nowCost,
            proxy: r.proxy + horizonXp(ctx, cand.id) - horizonXp(ctx, outId),
          };
          const key = routeKey(route);
          if (seenRoutes.has(key)) continue;
          seenRoutes.add(key);
          next.push(route);
        }
      }
    }
    next.sort(byProxy);
    routes.push(...next.slice(0, COUNTERFACTUAL_PARAMS.deepRouteShortlist));
    frontier = next;
  }

  return { routes, bestShortfall, clubBlocked, sameClubHeld };
}

/* ------------------------------------------- in season: one scorer for all */

// Every in-season scenario is scored by the planner's OWN `scoreCandidate`,
// under the options the plan was built with. That is what makes two columns
// comparable: hits, chip points and the value of a rolled transfer are counted
// by the code that chose the recommendation, not re-derived here. Until
// 2026-10-09 the alternative was `squadTrajectory - hit` and the baseline was
// the plan's stored total, which only agreed while nothing else differed.
function planCfg(ctx) {
  if (ctx.cfg) return ctx.cfg;
  const base = (ctx.planBundle && ctx.planBundle.planOptions) || {};
  const cfg = planner.resolveOptions({ ...base, horizon: ctx.horizon, discount: ctx.discount, seed: ctx.seed }, ctx.rules, ctx.gw);
  // `maxHits` is how many hits the planner is willing to TAKE. A question about
  // a route is answered with its price rather than refused, so it is lifted.
  ctx.cfg = { ...cfg, horizon: ctx.horizon, maxHits: Infinity };
  return ctx.cfg;
}

const heldIdsOf = ctx => (ctx.squadState.picks || []).map(p => p.playerId);
const priceNow = (ctx, id) => (ctx.gameState.players.get(id) || { nowCost: 0 }).nowCost;
const squadKey = ids => ids.slice().sort((a, b) => a - b).join(',');

// One way the gameweek could go: these transfers out of the squad held today.
function scenarioOf(ctx, { transfersOut, transfersIn }) {
  const outs = new Set(transfersOut);
  const squad = heldIdsOf(ctx).filter(id => !outs.has(id)).concat(transfersIn);
  const { selling, bank } = heldState(ctx);
  const bankAfter = bank
    + transfersOut.reduce((s, id) => s + (selling.get(id) || 0), 0)
    - transfersIn.reduce((s, id) => s + priceNow(ctx, id), 0);
  const base = {
    transfersOut: transfersOut.slice(),
    transfersIn: transfersIn.slice(),
    squad,
    transfers: transfersIn.length,
    bankAfter,
    legal: legalSquad(ctx, squad),
    affordable: bankAfter >= 0,
    scored: false,
  };
  if (!base.legal || !base.affordable) return base;
  const scored = scoreScenario(ctx, { transfersOut, transfersIn, squad });
  if (!scored) return base;
  return {
    ...base,
    scored: true,
    // The chip this scenario is scored with: the plan's, except a Bench Boost
    // or Triple Captain the planner would not play on this squad.
    chip: scored.chip || null,
    traj: scored.trajectory,
    // What the hero card calls "this gameweek": the canonical expected score.
    gwPoints: scored.xPointsGw,
    // Net of hits, chip points included: the plan's own xPointsHorizon.
    points: scored.xPointsHorizon,
    objective: scored.objective,
    hits: scored.acct.hits,
    hitPoints: scored.acct.hitCostPoints,
    freeTransfersUsed: scored.acct.freeTransfersUsed,
    freeTransfersNextGw: scored.acct.freeTransfersNextGw,
  };
}

// The planner's own scoring of one squad under the plan's chip.
//
// A Wildcard or Free Hit is scored by `scoreCandidate` with the chip, which is
// exactly how the planner scores the chip plan (and so inherits how it scores
// a Free Hit's rented week). A Bench Boost or Triple Captain is NOT: the
// planner scores the squad without the chip, asks the chip's own decision
// (the bench appearance gate, the hold margins) about THAT squad, and credits
// the chip's `netValue`, what it adds now minus what keeping it is worth
// (planner.js `chipCandidates` and `scoreWithTimingChip`). Scoring a scenario
// with the raw chip bonus instead let "why not him?" call better a squad the
// planner ranks lower, or one it would not boost at all. A squad whose
// decision is not to play the chip is scored without it, as the planner would.
function scoreScenario(ctx, candidate) {
  const chip = ctx.plan.chip || null;
  const cfg = planCfg(ctx);
  const common = {
    squadState: ctx.squadState,
    projections: ctx.projections,
    gameState: ctx.gameState,
    rules: ctx.rules,
    cfg,
    gw: ctx.gw,
  };
  if (chip !== 'bboost' && chip !== '3xc') {
    return planner.scoreCandidate({ candidate, chip, ...common });
  }
  const base = planner.scoreCandidate({ candidate, chip: null, ...common });
  if (!base) return null;
  const first = base.trajectory.gws[0];
  const chipsUsed = ctx.squadState.chipsUsed || [];
  const openingSquad = isUnlimited(transferStateOf(ctx.squadState, ctx.rules));
  const decision = chip === 'bboost'
    ? benchBoostDecision({
      benchIds: [first.bench.gk, ...first.bench.order],
      projections: ctx.projections, gameState: ctx.gameState, rules: ctx.rules,
      gw: ctx.gw, horizon: cfg.horizon, chipsUsed, openingSquad,
    })
    : tripleCaptainDecision({
      squadIds: candidate.squad, captainId: first.captain, captainXp: first.captainExtra,
      projections: ctx.projections, gameState: ctx.gameState, rules: ctx.rules,
      gw: ctx.gw, horizon: cfg.horizon, chipsUsed, openingSquad,
    });
  if (!decision || !decision.recommended) return base;
  return (planner.scoreWithTimingChip || scoreWithTimingChip)(base, chip, decision, {
    squadState: ctx.squadState, rules: ctx.rules, cfg,
  });
}

// planner.js `scoreWithTimingChip`, line for line, used until the planner
// exports its own (the namespace import above picks that up the moment it
// does, so the two cannot drift once it is exported).
function scoreWithTimingChip(base, chip, decision, { squadState, rules, cfg }) {
  const acct = transferAccounting({
    state: transferStateOf(squadState, rules), transfersMade: base.transferCount, chipPlayed: chip, rules,
  });
  if (acct.hits > cfg.maxHits) return null;
  const first = base.trajectory.gws[0];
  const chipPoints = chip === 'bboost' ? first.xPointsBench : first.captainExtra;
  return {
    ...base,
    chip,
    acct,
    chipBonus: chipPoints,
    chipDecision: decision,
    ...planner.gameweekPoints(first, chip, acct.hitCostPoints),
    xPointsHorizon: base.trajectory.total + chipPoints - acct.hitCostPoints,
    objective: base.trajectory.total + decision.netValue - acct.hitCostPoints
      + planner.bankedTransferValue(acct, cfg.rollBonus)
      + cfg.variancePreference * first.sd,
  };
}

// How deep a route may go: exactly as deep as the planner's search goes for
// these free transfers, honouring an experiment's `transferOptions`.
function maxRouteTransfers(ctx) {
  const base = (ctx.planBundle && ctx.planBundle.planOptions) || {};
  return Math.max(
    COUNTERFACTUAL_PARAMS.maxRouteTransfers,
    resolveMaxTransfers(ctx.squadState.freeTransfers, base.transferOptions || {}),
  );
}

// Under a Wildcard or Free Hit the recommendation is a rebuild, so the fair
// alternative is the same rebuild with him locked in: the builder the chip
// evaluator used (chips.js `evaluateWildcard` / `evaluateFreeHit`), same
// budget, same horizon, same lineup weights, plus `lockedIds`. A one or two
// move route out of the held squad is not what the planner compared him with.
//
// It is the full build, the same cost a pre-season "why not" already pays
// (`draftAnswer`), about two to three seconds of CPU on a desktop: a polish
// from the routes already found (one descent, no restarts) cost a third of
// that and missed the better squad in one of four sampled questions, which is
// an answer quoting a gap the planner's own builder would not. The best routes
// found so far are handed in as extra seeds, so the rebuild can never read
// below them.
function chipRebuild(ctx, seeds) {
  const chip = ctx.plan.chip;
  if (chip !== 'wildcard' && chip !== 'freehit') return null;
  const seedSquads = seeds.filter(sq => sq && sq.includes(ctx.playerId)).map(sq => sq.slice());
  if (!seedSquads.length) return null;
  const { ids, selling, bank } = heldState(ctx);
  const budgetTenths = ids.reduce((s, id) => s + (selling.get(id) || 0), 0) + bank;
  const lineupOptions = planCfg(ctx).lineupOptions || {};
  const weights = {};
  if (lineupOptions.riskAversion !== undefined) weights.riskAversion = lineupOptions.riskAversion;
  if (lineupOptions.minutesRiskWeight !== undefined) weights.minutesRiskWeight = lineupOptions.minutesRiskWeight;
  let built;
  try {
    built = buildSquad({
      projections: ctx.projections,
      gameState: ctx.gameState,
      rules: ctx.rules,
      gw: ctx.gw,
      horizon: chip === 'freehit' ? 1 : ctx.horizon,
      budgetTenths,
      lockedIds: [ctx.playerId],
      opts: {
        ...(chip === 'freehit' ? { singleGw: true, discount: 1 } : { discount: ctx.discount }),
        ...weights,
        seedSquads,
      },
    });
  } catch {
    return null;
  }
  if (!built || !built.squad || !built.squad.includes(ctx.playerId)) return null;
  const held = new Set(ids);
  const next = new Set(built.squad);
  return scenarioOf(ctx, {
    transfersOut: ids.filter(id => !next.has(id)),
    transfersIn: built.squad.filter(id => !held.has(id)),
  });
}

function movesOf(scen) {
  return scen.transfersOut.map((out, i) => ({ out, in: scen.transfersIn[i] }));
}

function movesText(ctx, scen) {
  const moves = movesOf(scen);
  if (!moves.length) return 'No transfers';
  return listAnd(moves.map(m => `${nameOf(ctx.gameState, m.out)} to ${nameOf(ctx.gameState, m.in)}`));
}

function costText(ctx, scen) {
  const free = ctx.squadState.freeTransfers;
  const freeText = Number.isFinite(free) ? `${free} free` : 'unlimited free';
  const n = `${scen.transfers} ${scen.transfers === 1 ? 'transfer' : 'transfers'}`;
  if (ctx.plan.chip === 'wildcard' || ctx.plan.chip === 'freehit') return `${n}, free under the chip`;
  return scen.hitPoints > 0 ? `${n} with ${freeText}: -${scen.hitPoints} points` : `${n} with ${freeText}: no hit`;
}

function routeSummary(ctx, scen) {
  return {
    moves: movesOf(scen),
    text: movesText(ctx, scen),
    transfers: scen.transfers,
    freeTransfers: ctx.squadState.freeTransfers,
    hits: scen.hits,
    hitPoints: scen.hitPoints,
    costText: costText(ctx, scen),
    bankAfterTenths: scen.bankAfter,
    gwPoints: scen.gwPoints,
    points: scen.points,
    freeTransfersNextGw: scen.freeTransfersNextGw,
    squad: scen.squad,
  };
}

/* ----------------------------------------------------- one player's facts */

function availabilityText(p) {
  const hard = { i: 'Injured', s: 'Suspended', u: 'Unavailable', n: 'Not in squad' };
  if (hard[p.status]) return p.news ? `${hard[p.status]}: ${p.news}` : hard[p.status];
  if (p.status === 'd') {
    const pct = Number.isFinite(p.chanceNext) ? `${Math.round(p.chanceNext * 100)}% to play` : 'a doubt';
    return p.news ? `Doubtful, ${pct}: ${p.news}` : `Doubtful, ${pct}`;
  }
  return 'Available';
}

function playerFacts(ctx, id) {
  const p = ctx.gameState.players.get(id);
  const first = projRow(ctx.projections, id, ctx.gw);
  const fixtures = [];
  let raw = 0;
  for (let k = 0; k < ctx.horizon; k++) {
    const gw = ctx.gw + k;
    const r = projRow(ctx.projections, id, gw);
    if (r && Number.isFinite(r.xPoints)) raw += r.xPoints;
    const list = (r && r.fixtures) || [];
    if (!list.length) fixtures.push({ gw, blank: true });
    for (const f of list) {
      const t = ctx.gameState.teams.get(f.opponentId);
      fixtures.push({ gw, opponent: t ? t.shortName : String(f.opponentId), home: !!f.isHome, fdr: f.fdr });
    }
  }
  const fx = fixtureProfile(ctx, id);
  return {
    id,
    name: nameOf(ctx.gameState, id),
    club: clubOf(ctx.gameState, id),
    priceTenths: p ? p.nowCost : 0,
    availability: p ? availabilityText(p) : 'Unknown',
    gwXp: first && Number.isFinite(first.xPoints) ? first.xPoints : 0,
    gwSd: first && Number.isFinite(first.sd) ? first.sd : null,
    pStart: first && Number.isFinite(first.pStart) ? first.pStart : null,
    // Weighted exactly as the squad totals are, so the player gap and the squad
    // gap are measured in the same unit.
    horizonXp: horizonXp(ctx, id),
    horizonXpRaw: raw,
    minutes: horizonMinutes(ctx, id),
    fixtures,
    meanFdr: fx.meanFdr,
  };
}

function fixturesText(facts) {
  const parts = facts.fixtures.map(f => (f.blank ? `GW${f.gw} blank` : `${f.opponent} (${f.home ? 'H' : 'A'}) ${f.fdr}`));
  return `${parts.join(', ')}; average difficulty ${(Math.round(facts.meanFdr * 10) / 10).toFixed(1)}`;
}

/* ------------------------------------------ A. the direct, like-for-like swap */

// The recommended plan's own moves, paired the way the plan lists them.
function recommendedMoves(ctx) {
  const outs = ctx.plan.transfersOut || [];
  const ins = ctx.plan.transfersIn || [];
  return outs.map((out, i) => ({ out, in: ins[i] }));
}

// "Why not him?" first means: why not him INSTEAD of the player the plan buys
// for that place. So the comparison is the recommended plan with exactly one
// change, the recommended incoming player swapped for the one asked about:
// same seller, same other moves, same number of transfers and so the same hit.
// Whatever separates the two columns is that one swap and nothing else.
//
// When the plan buys nobody in his position, the like-for-like question is
// "the plan as it stands" against "the plan plus selling one of yours for him",
// which costs one more transfer and is priced as such.
function directComparison(ctx, rec) {
  const position = ctx.target.position;
  const recMoves = recommendedMoves(ctx);
  const replace = recMoves.filter(m => {
    const p = ctx.gameState.players.get(m.in);
    return p && p.position === position;
  });

  const options = [];
  if (replace.length) {
    for (const m of replace) {
      const transfersIn = ctx.plan.transfersIn.map(id => (id === m.in ? ctx.playerId : id));
      options.push({
        kind: 'replace',
        outId: m.out,
        comparatorId: m.in,
        alt: scenarioOf(ctx, { transfersOut: ctx.plan.transfersOut.slice(), transfersIn }),
      });
    }
  } else {
    const held = new Set(heldIdsOf(ctx));
    for (const id of ctx.plan.squad) {
      const p = ctx.gameState.players.get(id);
      if (!held.has(id) || !p || p.position !== position) continue;
      options.push({
        kind: 'add',
        outId: id,
        comparatorId: id,
        alt: scenarioOf(ctx, {
          transfersOut: [...(ctx.plan.transfersOut || []), id],
          transfersIn: [...(ctx.plan.transfersIn || []), ctx.playerId],
        }),
      });
    }
  }
  if (!options.length) return null;

  const scored = options.filter(o => o.alt.scored)
    .sort((a, b) => b.alt.points - a.alt.points || a.outId - b.outId);
  // When none is possible, explain the one that comes closest on money.
  const chosen = scored[0] || options.slice().sort((a, b) => b.alt.bankAfter - a.alt.bankAfter)[0];
  const available = chosen.alt.scored;

  const comparator = playerFacts(ctx, chosen.comparatorId);
  const target = playerFacts(ctx, ctx.playerId);
  const out = playerFacts(ctx, chosen.outId);

  const blockers = [];
  if (!available) {
    if (!chosen.alt.affordable) {
      blockers.push(reason(
        'direct_budget',
        chosen.kind === 'replace'
          ? `Buying ${target.name} instead of ${comparator.name} leaves the bank {v} short.`
          : `Selling ${out.name} for ${target.name} leaves the bank {v} short.`,
        -chosen.alt.bankAfter,
        'tenths',
      ));
    }
    if (!chosen.alt.legal) {
      const club = ctx.gameState.players.get(ctx.playerId).teamId;
      const mates = chosen.alt.squad.filter(id => id !== ctx.playerId && ctx.gameState.players.get(id).teamId === club);
      blockers.push(reason(
        'direct_club_limit',
        `It would be ${clubOf(ctx.gameState, ctx.playerId)} player number {v}, over the limit of ${ctx.rules.clubLimit}, alongside ${listAnd(mates.map(id => nameOf(ctx.gameState, id)))}.`,
        mates.length + 1,
        'count',
      ));
    }
  }

  const delta = available ? {
    gwPoints: chosen.alt.gwPoints - rec.gwPoints,
    points: chosen.alt.points - rec.points,
    objective: chosen.alt.objective - rec.objective,
  } : null;
  const playerDelta = {
    gw: target.gwXp - comparator.gwXp,
    horizon: target.horizonXp - comparator.horizonXp,
  };
  // What the squad gap is beyond the two players' own gap: benching, the
  // armband, and any hit the extra move costs. Zero when he would simply play
  // every week in the other man's place.
  const lineupEffect = available
    ? (delta.points + (chosen.alt.hitPoints - rec.hitPoints)) - playerDelta.horizon
    : null;

  return {
    kind: chosen.kind,
    available,
    outId: chosen.outId,
    comparatorId: chosen.comparatorId,
    targetId: ctx.playerId,
    rec,
    alt: chosen.alt,
    players: { comparator, target, out },
    delta,
    playerDelta,
    lineupEffect,
    blockers,
  };
}

// The table a manager reads first. Cells are engine-formatted text; `values`
// carry the numbers they were formatted from so a test can hold them equal.
function directTable(ctx, d) {
  const { comparator, target, out } = d.players;
  const cells = (code, label, a, b, values = null, unit = 'points') => ({ code, label, cells: [a, b], values, unit });
  const xpCell = v => `${fmt(v)} xP`;
  const horizonCell = f => `${fmt(f.horizonXpRaw)} xP (${fmt(f.horizonXp)} weighted)`;
  const minutesCell = f => (f.pStart === null
    ? `${Math.round(f.minutes)}`
    : `${Math.round(f.minutes)}, ${Math.round(f.pStart * 100)}% to start GW${ctx.gw}`);
  const rec = d.rec;
  const alt = d.alt;
  const altMove = `${out.name} to ${target.name}`;
  const rows = [
    cells('move', 'Transfer',
      d.kind === 'replace' ? `${out.name} to ${comparator.name}` : `Keep ${out.name}`,
      altMove, null, 'text'),
    cells('price', 'Price', fmt(comparator.priceTenths, 'tenths'), fmt(target.priceTenths, 'tenths'),
      [comparator.priceTenths, target.priceTenths], 'tenths'),
    cells('availability', 'Availability', comparator.availability, target.availability, null, 'text'),
    cells('gw_xp', `His xP, GW${ctx.gw}`, xpCell(comparator.gwXp), xpCell(target.gwXp), [comparator.gwXp, target.gwXp]),
    cells('horizon_xp', `His xP, next ${ctx.horizon} GWs`, horizonCell(comparator), horizonCell(target),
      [comparator.horizonXp, target.horizonXp]),
    cells('minutes', `Expected minutes, ${ctx.horizon} GWs`, minutesCell(comparator), minutesCell(target),
      [comparator.minutes, target.minutes], 'count'),
    cells('fixtures', 'Fixtures (difficulty)', fixturesText(comparator), fixturesText(target), [comparator.meanFdr, target.meanFdr]),
    cells('bank_after', 'Money left after transfers', fmt(rec.bankAfter, 'tenths'),
      d.available || alt.bankAfter >= 0 ? fmt(alt.bankAfter, 'tenths') : `short by ${fmt(-alt.bankAfter, 'tenths')}`,
      [rec.bankAfter, alt.bankAfter], 'tenths'),
  ];
  if (d.available) {
    rows.push(
      cells('transfer_cost', 'Transfers and points cost', costText(ctx, rec), costText(ctx, alt),
        [rec.hitPoints, alt.hitPoints]),
      cells('squad_gw', `Squad xP, GW${ctx.gw}`, xpCell(rec.gwPoints), xpCell(alt.gwPoints), [rec.gwPoints, alt.gwPoints]),
      cells('squad_horizon', `Squad xP, ${ctx.horizon} GWs after hits`, xpCell(rec.points), xpCell(alt.points),
        [rec.points, alt.points]),
    );
  }
  return {
    columns: [
      { playerId: comparator.id, label: d.kind === 'replace' ? comparator.name : `${out.name} (kept)`, recommended: true },
      { playerId: target.id, label: target.name, recommended: false },
    ],
    rows,
  };
}

// Is the money a cheaper buy leaves worth anything THIS week? Measured, not
// asserted: the best single extra move on top of each column, priced by the
// same scorer, hit included.
function bestExtraMove(ctx, scen) {
  if (!scen || !scen.scored) return null;
  const { selling } = heldState(ctx);
  const bought = new Set(scen.transfersIn);
  const inSquad = new Set(scen.squad);
  let best = null;
  for (const id of scen.squad) {
    if (bought.has(id)) continue;
    const p = ctx.gameState.players.get(id);
    if (!p) continue;
    const budget = scen.bankAfter + (selling.get(id) || 0);
    for (const cand of replacementPool(ctx, p.position, inSquad, budget)) {
      const next = scenarioOf(ctx, {
        transfersOut: [...scen.transfersOut, id],
        transfersIn: [...scen.transfersIn, cand.id],
      });
      if (!next.scored) continue;
      const gain = next.points - scen.points;
      if (!best || gain > best.gain + 1e-12) {
        best = { out: id, in: cand.id, gain, hitPoints: next.hitPoints - scen.hitPoints };
      }
    }
  }
  return best;
}

function flexibilityReason(ctx, d) {
  // Only meaningful like for like: with the same transfers on both sides, the
  // one thing the cheaper buy leaves behind is money.
  if (!d.available || d.kind !== 'replace' || d.alt.bankAfter === d.rec.bankAfter) return null;
  const recRicher = d.rec.bankAfter > d.alt.bankAfter;
  const richName = recRicher ? d.players.comparator.name : d.players.target.name;
  const poorName = recRicher ? d.players.target.name : d.players.comparator.name;
  const rich = bestExtraMove(ctx, recRicher ? d.rec : d.alt);
  const poor = bestExtraMove(ctx, recRicher ? d.alt : d.rec);
  const gap = Math.abs(d.rec.bankAfter - d.alt.bankAfter);
  const describe = m => `${nameOf(ctx.gameState, m.out)} to ${nameOf(ctx.gameState, m.in)}`;
  const margin = planCfg(ctx).hitMarginPoints;
  // What a move is worth to the PLANNER: a hit move below the bar is worth
  // nothing this week, because the planner would not make it.
  const usable = m => !!m && m.gain > 0 && (m.hitPoints === 0 || m.gain >= margin);
  const flex = (usable(rich) ? rich.gain : 0) - (usable(poor) ? poor.gain : 0);

  let text;
  if (!rich || rich.gain <= 0) {
    text = `${richName} leaves {v} more in the bank, but no extra move this week pays with it.`;
  } else if (!usable(rich)) {
    text = `${richName} leaves {v} more in the bank. The best extra move it funds, ${describe(rich)}, is worth ${fmt(rich.gain, 'signed')} after its ${rich.hitPoints}-point hit, short of the ${fmt(margin)}-point bar a hit must clear, so it changes nothing this week; the money is there for later weeks.`;
  } else if (usable(poor) && poor.in === rich.in && poor.out === rich.out) {
    text = `${richName} leaves {v} more in the bank, but the best extra move, ${describe(rich)}, is affordable either way, so the money changes nothing this week.`;
  } else {
    text = `${richName} leaves {v} more in the bank, enough for ${describe(rich)} (${fmt(rich.gain, 'signed')}${rich.hitPoints ? ` after its ${rich.hitPoints}-point hit` : ''})${usable(poor) ? `, against ${describe(poor)} (${fmt(poor.gain, 'signed')}) with ${poorName}'s money` : `, which ${poorName}'s money does not fund`}. That flexibility is worth ${fmt(flex, 'signed')} xP this week.`;
  }
  return { ...reason('money_flexibility', text, gap, 'tenths'), flexibilityPoints: flex };
}

// Reasons that come from the direct comparison, every one about the two
// players who actually trade places: the recommended buy and the one asked
// about. The player both columns SELL is never the comparator.
function directReasons(ctx, d) {
  const { comparator, target } = d.players;
  const out = [];
  const recLabel = d.kind === 'replace' ? `with ${comparator.name}` : `keeping ${comparator.name}`;
  const altLabel = d.kind === 'replace' ? `with ${target.name}` : `with ${target.name} for ${comparator.name}`;
  if (d.available) {
    const gw = d.delta.gwPoints;
    out.push(reason(
      'direct_gw',
      Math.abs(gw) < 0.05
        ? `In Gameweek ${ctx.gw} the squad scores the same either way, within {v} xP.`
        : gw < 0
          ? `In Gameweek ${ctx.gw} the squad ${recLabel} projects {v} xP more than ${altLabel}.`
          : `In Gameweek ${ctx.gw} the squad ${altLabel} projects {v} xP more than ${recLabel}.`,
      Math.abs(gw),
    ));
    const h = d.delta.points;
    out.push(reason(
      'direct_horizon',
      Math.abs(h) < 0.05
        ? `Over ${ctx.horizon} gameweeks the two squads are level, within {v} xP.`
        : h < 0
          ? `Over ${ctx.horizon} gameweeks, after any hits, the squad ${recLabel} projects {v} xP more.`
          : `Over ${ctx.horizon} gameweeks, after any hits, the squad ${altLabel} projects {v} xP more.`,
      Math.abs(h),
    ));
  }

  // The two players on their own, in the same weighted unit as the squads.
  const gap = d.playerDelta.horizon;
  out.push(reason(
    'individual_gap',
    gap >= 0
      ? `On his own ${target.name} projects {v} xP more than ${comparator.name} over the ${ctx.horizon} gameweeks.`
      : `On his own ${target.name} projects {v} xP fewer than ${comparator.name} over the ${ctx.horizon} gameweeks.`,
    Math.abs(gap),
  ));

  if (d.available && Math.abs(d.lineupEffect) >= 0.05) {
    const benched = d.alt.traj.gws.filter(g => !g.startingXI.includes(ctx.playerId)).length;
    // The comparator is in the recommended squad either way: bought there in
    // 'replace', kept there in 'add'. His bench weeks count just as much.
    const recBenched = d.rec.traj.gws.filter(g => !g.startingXI.includes(comparator.id)).length;
    const why = [];
    if (benched) why.push(`${target.name} would start on your bench in ${benched} of the ${ctx.horizon} gameweeks`);
    if (recBenched) why.push(`${comparator.name} would start on your bench in ${recBenched}`);
    out.push(reason(
      'lineup_effect',
      why.length
        ? `The squad gap is {v} xP away from the player gap because ${listAnd(why)}.`
        : 'The squad gap is {v} xP away from the player gap because the best eleven and the armband change around him.',
      Math.abs(d.lineupEffect),
    ));
  }

  if (d.available && d.alt.hitPoints !== d.rec.hitPoints) {
    out.push(reason(
      'direct_hit',
      `Bringing in ${target.name} as well as the recommended moves is one more transfer than you have free, a {v}-point hit, and the squad figures above are after it.`,
      d.alt.hitPoints - d.rec.hitPoints,
      'count',
    ));
  }

  out.push(...swapReasons(ctx, comparator.id, target.id));

  // How much of the gap is minutes? A rough scaling, labelled as one: his
  // projection with the other man's expected minutes. It answers "is this
  // just about whether he starts?" without changing what the model projects.
  // Only when the gap is a matter of degree: scaling a player who barely plays
  // up to a regular's minutes multiplies noise, not evidence.
  if (comparator.minutes - target.minutes >= COUNTERFACTUAL_PARAMS.minutesTolerance
    && target.minutes > 0 && comparator.minutes <= 2 * target.minutes) {
    let scaled = 0;
    for (let k = 0; k < ctx.horizon; k++) {
      const a = projRow(ctx.projections, ctx.playerId, ctx.gw + k);
      const b = projRow(ctx.projections, comparator.id, ctx.gw + k);
      if (!a || !Number.isFinite(a.xPoints) || !(a.xMins > 0)) continue;
      const ratio = b && Number.isFinite(b.xMins) ? b.xMins / a.xMins : 1;
      scaled += ctx.weights[k] * a.xPoints * ratio;
    }
    const after = scaled - comparator.horizonXp;
    out.push(reason(
      'minutes_sensitivity',
      after < 0
        ? `Minutes are not the whole story: given ${comparator.name}'s expected minutes, ${target.name} would project about ${fmt(scaled)} xP, still {v} behind.`
        : `Minutes decide it: given ${comparator.name}'s expected minutes, ${target.name} would project about ${fmt(scaled)} xP, {v} ahead.`,
      Math.abs(after),
    ));
  }

  // Honest about size: a gap smaller than one gameweek's typical swing for
  // either player is a lean, not a certainty.
  if (d.available) {
    const sds = [comparator.gwSd, target.gwSd].filter(Number.isFinite);
    const swing = sds.length ? Math.max(...sds) : null;
    const size = Math.abs(d.delta.points);
    if (swing !== null && size > COUNTERFACTUAL_PARAMS.tieTolerance && size < swing) {
      out.push(reason(
        'close_call',
        `This is a small edge: ${fmt(size)} xP over ${ctx.horizon} gameweeks is less than one gameweek's typical swing for either player (about {v} points), so it is a lean, not a certainty.`,
        swing,
      ));
    }
  }

  const flex = flexibilityReason(ctx, d);
  if (flex) out.push(flex);
  return out;
}

/* -------------------------------- B. the best plan of all that contains him */

function overallComparison(ctx, rec, d) {
  const seen = new Set();
  const candidates = [];
  const add = s => {
    if (!s || !s.scored) return;
    const key = squadKey(s.squad);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(s);
  };
  const { routes, bestShortfall, clubBlocked, sameClubHeld } = enumerateRoutes(ctx);
  for (const r of routes) add(scenarioOf(ctx, { transfersOut: r.out, transfersIn: r.in }));
  if (d && d.available) add(d.alt);
  if (ctx.plan.chip === 'wildcard' || ctx.plan.chip === 'freehit') {
    const seeds = candidates.slice().sort((a, b) => b.points - a.points || a.transfers - b.transfers).slice(0, 2);
    add(chipRebuild(ctx, seeds.map(c => c.squad)));
  }
  candidates.sort((a, b) => b.points - a.points || a.transfers - b.transfers);
  if (!candidates.length) return { best: null, candidates, bestShortfall, clubBlocked, sameClubHeld };

  const best = candidates[0];
  const sameAsDirect = !!(d && d.available && squadKey(best.squad) === squadKey(d.alt.squad));
  const recKey = new Set(rec.squad);
  const bestKey = new Set(best.squad);
  const onlyInBest = best.squad.filter(id => !recKey.has(id));
  const onlyInRec = rec.squad.filter(id => !bestKey.has(id));
  const applesToApples = best.transfers === rec.transfers
    && best.hitPoints === rec.hitPoints
    && onlyInBest.length === 1 && onlyInRec.length === 1;
  const decomposition = d && d.available && !sameAsDirect
    ? { swap: d.alt.points - rec.points, otherMoves: best.points - d.alt.points }
    : null;
  return {
    best,
    candidates,
    sameAsDirect,
    applesToApples,
    onlyInBest,
    onlyInRec,
    decomposition,
    delta: { points: best.points - rec.points, gwPoints: best.gwPoints - rec.gwPoints, objective: best.objective - rec.objective },
  };
}

function overallReasons(ctx, rec, o) {
  const out = [];
  const best = o.best;
  if (o.sameAsDirect) {
    out.push({
      code: 'overall_same',
      text: `The best plan containing ${ctx.name} is the direct swap above, so the whole difference is that one swap.`,
      value: null,
      unit: 'text',
    });
  } else if (o.decomposition) {
    const r1 = v => Math.round(v * 10) / 10;
    const swap = r1(o.decomposition.swap);
    const other = r1(o.delta.points) - swap;
    out.push(reason(
      'overall_decomposition',
      `The best plan containing ${ctx.name} is a different route (${movesText(ctx, best)}). Of its ${fmt(o.delta.points, 'signed')} xP against the recommendation, ${fmt(swap, 'signed')} is the player swap and {v} comes from its other moves.`,
      other,
      'signed',
    ));
  } else {
    out.push({
      code: 'overall_route',
      text: `There is no like-for-like swap, so the comparison is between whole routes: ${movesText(ctx, best)} against ${movesText(ctx, rec)}.`,
      value: null,
      unit: 'text',
    });
  }
  if (best.hitPoints > 0) {
    out.push(reason('hit', 'That route costs a {v}-point hit, because it uses more transfers than you have free.', best.hitPoints, 'count'));
  }
  // The planner ranks on more than points: a free transfer carried into next
  // week has a value under the risk setting. When that, and not points, is
  // what separates the two, say so, so the answer can never contradict the plan.
  //
  // The value quoted is the planner's own value of exactly the transfers that
  // differ (`bankedValueOf`, read after transfer-state.js applied the cap, so
  // a transfer that could not have been banked is worth nothing): the same
  // definition planner.js `rollMarginValue` gives the explanation.
  const pointsAhead = o.delta.points > COUNTERFACTUAL_PARAMS.tieTolerance;
  const objectiveBehind = o.delta.objective < -COUNTERFACTUAL_PARAMS.tieTolerance;
  const rollBonus = planCfg(ctx).rollBonus;
  const rollGap = planner.bankedValueOf(rec.freeTransfersNextGw || 0, rollBonus)
    - planner.bankedValueOf(best.freeTransfersNextGw || 0, rollBonus);
  if (pointsAhead && objectiveBehind && rollGap > 0) {
    out.push(reason(
      'roll_value',
      `It projects more points, but it leaves you ${best.freeTransfersNextGw} free ${best.freeTransfersNextGw === 1 ? 'transfer' : 'transfers'} next week against ${rec.freeTransfersNextGw}, and the planner values the difference at {v} points, which is why it is not the recommendation.`,
      rollGap,
    ));
  }
  return out;
}

/* --------------------------------------------------- the in-season answer */

function transferAnswer(ctx) {
  const unavailable = unavailableBlocker(ctx);
  if (unavailable) return impossible(ctx, [unavailable], { mode: 'transfer' });

  const rec = scenarioOf(ctx, {
    transfersOut: (ctx.plan.transfersOut || []).slice(),
    transfersIn: (ctx.plan.transfersIn || []).slice(),
  });
  // The recommended column is RE-SCORED, not read from storage, so both columns
  // come from one scorer. If that ever disagrees with the plan the page shows,
  // the plan is not the one this answer is about, and saying so beats quietly
  // comparing against a different number.
  const baselineDrift = rec.scored ? rec.points - ctx.plan.xPointsHorizon : null;

  const d = rec.scored ? directComparison(ctx, rec) : null;
  const o = rec.scored ? overallComparison(ctx, rec, d) : { best: null };

  if (!o.best) {
    const blockers = d && d.blockers.length ? d.blockers.slice() : [];
    if (o.clubBlocked || (o.sameClubHeld && o.sameClubHeld.length >= ctx.rules.clubLimit)) {
      blockers.push(reason(
        'club_limit',
        `You already hold {v} players from ${clubOf(ctx.gameState, ctx.playerId)}, which is the limit, and no legal move inside ${maxRouteTransfers(ctx)} transfers frees a place.`,
        o.sameClubHeld.length,
        'count',
      ));
    }
    if (Number.isFinite(o.bestShortfall)) {
      blockers.push(reason(
        'budget',
        `Buying ${ctx.name} needs another {v}, even after selling the two players who raise the most.`,
        o.bestShortfall,
        'tenths',
      ));
    }
    if (!blockers.length) {
      blockers.push(reason(
        'squad',
        `No legal squad inside {v} transfers ends the gameweek holding him.`,
        maxRouteTransfers(ctx),
        'count',
      ));
    }
    return impossible(ctx, blockers, { mode: 'transfer' });
  }

  const best = o.best;
  // The verdict follows the planner's own rule, so "he would improve the
  // recommendation" is only ever said when the planner would agree: on its
  // objective, and, for a route taking more hits than the plan, only past the
  // risk profile's margin a hit must clear (planner.js, `hitMarginPoints`).
  const margin = best.hits > rec.hits ? planCfg(ctx).hitMarginPoints : 0;
  const shortOfHitBar = margin > 0 && o.delta.objective > COUNTERFACTUAL_PARAMS.tieTolerance
    && o.delta.objective < margin;
  const verdict = shortOfHitBar ? 'worse' : verdictOf(o.delta.objective - margin);
  const headline = shortOfHitBar
    ? `${ctx.name}'s best route projects slightly more, but not by enough to justify its hit.`
    : verdict === 'better'
      ? `${ctx.name} would improve the recommendation.`
      : verdict === 'level'
        ? `${ctx.name} is level with the recommendation.`
        : d && d.available && d.kind === 'replace'
          ? `${d.players.comparator.name} is the better buy than ${ctx.name} for ${d.players.out.name}'s place.`
          : `${ctx.name} is a valid option, but the recommended plan projects higher.`;

  const recSummary = routeSummary(ctx, rec);
  const bestSummary = routeSummary(ctx, best);

  const rows = [
    row('baseline_total', 'Recommended plan', `${recSummary.text}: ${fmt(rec.points)} xP over ${ctx.horizon} ${ctx.horizon === 1 ? 'gameweek' : 'gameweeks'}, ${recSummary.costText}`, rec.points),
    row('alternative_total', `Best plan containing ${ctx.name}`, `${bestSummary.text}: ${fmt(best.points)} xP, ${bestSummary.costText}`, best.points),
    row('route', 'Its route', `${best.transfers} ${best.transfers === 1 ? 'transfer' : 'transfers'}, ${bestSummary.text}`, best.transfers, 'count'),
  ];
  if ((ctx.plan.transfersOut || []).length) {
    rows.push(row('instead_of', 'Instead of the recommended move', recSummary.text, null, 'text'));
  }
  rows.push(row(
    'bank_after',
    'Bank after',
    `${fmt(best.bankAfter, 'tenths')} left, against ${fmt(rec.bankAfter, 'tenths')} in the recommended plan`,
    best.bankAfter,
    'tenths',
  ));
  rows.push(row(
    'like_for_like',
    'Like for like?',
    o.applesToApples
      ? 'Yes: same number of transfers, same hit, one player different.'
      : `No: ${best.transfers} ${best.transfers === 1 ? 'transfer' : 'transfers'} against ${rec.transfers}, ${o.onlyInBest.length} ${o.onlyInBest.length === 1 ? 'player' : 'players'} different${best.hitPoints !== rec.hitPoints ? `, hits ${best.hitPoints} against ${rec.hitPoints}` : ''}.`,
    o.applesToApples ? 1 : 0,
    'count',
  ));

  const preference = preferenceFor(ctx, d, o, rec);
  const reasons = [];
  if (shortOfHitBar) {
    reasons.push(reason(
      'hit_margin',
      `It projects ${fmt(o.delta.points)} xP more after its ${best.hitPoints}-point hit, but under the ${planCfg(ctx).risk} risk setting a plan that takes a hit must beat the best plan without one by {v} points before the planner takes it.`,
      margin,
    ));
  }
  if (d) reasons.push(...(d.available ? [] : d.blockers), ...directReasons(ctx, d));
  reasons.push(...overallReasons(ctx, rec, o));
  const later = laterGameweekReason(ctx, rec.traj, best.traj);
  if (later) reasons.push(later);
  if (baselineDrift !== null && Math.abs(baselineDrift) > 1e-6) {
    reasons.push(reason(
      'baseline_drift',
      'Re-scored now, the recommended plan comes to a different total than the one stored with it, by {v} xP; the comparison uses the re-scored figure for both columns.',
      Math.abs(baselineDrift),
    ));
  }

  const result = transferResult(ctx, { verdict, shortOfHitBar, delta: o.delta });
  return {
    playerId: ctx.playerId,
    name: ctx.name,
    mode: 'transfer',
    verdict,
    headline,
    preference,
    direct: d ? {
      kind: d.kind,
      available: d.available,
      outId: d.outId,
      comparatorId: d.comparatorId,
      targetId: d.targetId,
      table: directTable(ctx, d),
      blockers: d.blockers,
      delta: d.delta,
      playerDelta: d.playerDelta,
      lineupEffect: d.lineupEffect,
      recommended: routeSummary(ctx, d.rec),
      alternative: d.available ? routeSummary(ctx, d.alt) : null,
    } : null,
    overall: {
      recommended: recSummary,
      best: bestSummary,
      sameAsDirect: o.sameAsDirect,
      applesToApples: o.applesToApples,
      decomposition: o.decomposition,
      delta: o.delta,
    },
    rows,
    reasons,
    result,
    blockers: [],
    alternatives: alternativeRoutes(ctx, o.candidates, best, rec),
    deltaHorizon: o.delta.points,
    transfers: best.transfers,
    hitPoints: best.hitPoints,
    squad: best.squad,
    bankTenths: best.bankAfter,
    // What this answer was computed against, so the page can refuse to show it
    // under a plan it does not describe.
    text: `${headline} ${result.text}`,
  };
}

// The closing line, which must agree in DIRECTION with the numbers above it.
// The verdict follows the planner's objective, which can disagree with points
// alone when a free transfer is rolled or a hit falls short of its bar; each of
// those cases gets its own sentence rather than a generic one that would state
// the points gap backwards.
function transferResult(ctx, { verdict, shortOfHitBar, delta }) {
  const pts = delta.points;
  if (shortOfHitBar) {
    return reason('result', `Result: the plan containing ${ctx.name} projects {v} points higher only by taking a hit, short of the bar a hit must clear, so the recommendation stands.`, Math.abs(pts));
  }
  if (verdict === 'worse' && pts > 0.05) {
    return reason('result', `Result: the plan containing ${ctx.name} projects {v} points higher but spends a free transfer the planner values more, so the recommendation stands.`, Math.abs(pts));
  }
  if (verdict === 'better' && pts < -0.05) {
    return reason('result', `Result: the plan containing ${ctx.name} projects {v} points fewer but keeps a free transfer the planner values more, so it would be the better plan.`, Math.abs(pts));
  }
  return resultLine(ctx, verdict, pts);
}

// The one-line summary. The winner is always one of the two players who trade
// places in the direct comparison, never the player both columns sell.
function preferenceFor(ctx, d, o, rec) {
  if (d && d.available) {
    // Same rule as the verdict: an extra hit has to clear the margin.
    const margin = d.alt.hits > d.rec.hits ? planCfg(ctx).hitMarginPoints : 0;
    const shortOfBar = margin > 0 && d.delta.objective > COUNTERFACTUAL_PARAMS.tieTolerance && d.delta.objective < margin;
    if (shortOfBar) {
      return {
        code: 'preference',
        label: `Keeping ${d.players.comparator.name} is preferred because`,
        text: `bringing in ${d.players.target.name} nets only ${fmt(d.delta.points, 'signed')} squad xP after its ${d.alt.hitPoints - d.rec.hitPoints}-point hit, short of the ${fmt(margin)}-point bar a hit must clear`,
        value: d.delta.points,
        unit: 'points',
        winnerId: d.players.comparator.id,
      };
    }
    const recWins = d.delta.objective - margin < 0;
    const level = Math.abs(d.delta.objective - margin) <= COUNTERFACTUAL_PARAMS.tieTolerance;
    const winner = recWins ? d.players.comparator : d.players.target;
    const loser = recWins ? d.players.target : d.players.comparator;
    const sign = recWins ? -1 : 1;
    // Only grounds that favour the winner are listed as reasons; a gameweek
    // the loser wins is stated as exactly that, never as a negative "reason".
    const parts = [];
    const gwFor = sign * d.delta.gwPoints;
    if (gwFor >= 0.05) parts.push(`${fmt(gwFor, 'signed')} squad xP in Gameweek ${ctx.gw}`);
    parts.push(`${fmt(sign * d.delta.points, 'signed')} squad xP over ${ctx.horizon} gameweeks${d.alt.hitPoints !== d.rec.hitPoints ? ' after hits' : ''}`);
    if (winner.minutes - loser.minutes >= COUNTERFACTUAL_PARAMS.minutesTolerance) parts.push('more secure expected minutes');
    if (loser.meanFdr - winner.meanFdr >= 0.25) parts.push('kinder fixtures');
    if (winner.priceTenths < loser.priceTenths) parts.push(`${fmt(loser.priceTenths - winner.priceTenths, 'tenths')} cheaper`);
    const despite = gwFor <= -0.05 ? `, although ${loser.name} is ${fmt(-gwFor)} xP ahead in Gameweek ${ctx.gw}` : '';
    const winnerLabel = d.kind === 'add' && recWins ? `Keeping ${winner.name}` : winner.name;
    return {
      code: 'preference',
      label: level
        ? `${d.players.comparator.name} and ${d.players.target.name} are level`
        : `${winnerLabel} is preferred because`,
      text: level ? `within ${fmt(Math.abs(d.delta.points))} squad xP over ${ctx.horizon} gameweeks` : `${listAnd(parts)}${despite}`,
      value: d.delta.points,
      unit: 'points',
      winnerId: level ? null : winner.id,
    };
  }
  const recWins = o.delta.points < 0;
  return {
    code: 'preference',
    label: recWins ? 'The recommended plan is preferred because' : `The plan containing ${ctx.name} is preferred because`,
    text: `${fmt(Math.abs(o.delta.points), 'signed').replace('-', '+')} xP over ${ctx.horizon} gameweeks after hits`,
    value: o.delta.points,
    unit: 'points',
    winnerId: null,
  };
}



// One line about where in the horizon the difference actually sits, because a
// route that loses this week and wins the next two is a different decision from
// one that loses every week.
function laterGameweekReason(ctx, baselineTraj, altTraj) {
  if (ctx.horizon < 2) return null;
  const first = altTraj.gws[0].xPoints - baselineTraj.gws[0].xPoints;
  let rest = 0;
  for (let k = 1; k < altTraj.gws.length; k++) {
    rest += altTraj.gws[k].weight * (altTraj.gws[k].xPoints - baselineTraj.gws[k].xPoints);
  }
  if (first >= 0 === rest >= 0) return null;
  return reason(
    'later_gws',
    first < 0
      ? `He is behind this gameweek and ahead afterwards, by {v} points across the rest of the horizon.`
      : `He is ahead this gameweek and behind afterwards, by {v} points across the rest of the horizon.`,
    Math.abs(rest),
  );
}

// One primary answer, a short list behind a disclosure. The best route at each
// transfer count, never every route the search touched. Scenarios come from
// `scenarioOf`, so each delta is net of its own hit on the plan's own scorer.
function alternativeRoutes(ctx, scored, best, rec) {
  const out = [];
  const seenCounts = new Set([best.transfers]);
  for (const route of scored) {
    if (route === best) continue;
    if (seenCounts.has(route.transfers)) continue;
    seenCounts.add(route.transfers);
    out.push(route);
  }
  for (const route of scored) {
    if (out.length >= COUNTERFACTUAL_PARAMS.maxAlternatives) break;
    if (route === best || out.includes(route)) continue;
    out.push(route);
  }
  return out.slice(0, COUNTERFACTUAL_PARAMS.maxAlternatives).map(route => ({
    transfers: route.transfers,
    hitPoints: route.hitPoints,
    deltaHorizon: route.points - rec.points,
    label: `${route.transfers} ${route.transfers === 1 ? 'transfer' : 'transfers'}: ${movesText(ctx, route)}`,
    text: reason(
      'alternative',
      route.points - rec.points >= 0
        ? 'Projects {v} points above the recommended plan.'
        : 'Projects {v} points below the recommended plan.',
      Math.abs(route.points - rec.points),
    ).text,
  }));
}

/* ------------------------------------------------- already in the reckoning */

// He is held today but the recommendation sells him. The counterfactual is
// keeping him, which is a real question with a real answer, and it is not the
// same question as buying him.
function keepAnswer(ctx) {
  const rec = scenarioOf(ctx, {
    transfersOut: (ctx.plan.transfersOut || []).slice(),
    transfersIn: (ctx.plan.transfersIn || []).slice(),
  });
  if (!rec.scored) return null;

  // Keeping him means the recommended plan WITHOUT the move that sells him (so
  // the player bought for his place never arrives), or keeping the squad as it
  // is. Both are scored by the plan's own scorer, so transfers, hits and the
  // value of a rolled transfer are counted exactly as the plan counts them.
  const outs = ctx.plan.transfersOut || [];
  const ins = ctx.plan.transfersIn || [];
  const candidates = [{ scen: scenarioOf(ctx, { transfersOut: [], transfersIn: [] }), replaced: null }];
  const i = outs.indexOf(ctx.playerId);
  if (i >= 0) {
    candidates.push({
      scen: scenarioOf(ctx, {
        transfersOut: outs.filter((_, k) => k !== i),
        transfersIn: ins.filter((_, k) => k !== i),
      }),
      replaced: ins[i],
    });
  }
  const scored = candidates.filter(c => c.scen.scored)
    .map(c => ({ ...c, squad: c.scen.squad, traj: c.scen.traj, hit: c.scen.hitPoints, total: c.scen.points }));
  if (!scored.length) return null;
  scored.sort((a, b) => b.total - a.total);
  const best = scored[0];
  const baselineTraj = rec.traj;

  const { pairs } = diffPairs(ctx, ctx.plan.squad, best.squad);
  const comparison = compareSquads(ctx, {
    baselineTotal: rec.points,
    baselineTraj,
    altSquad: best.squad,
    altTotal: best.total,
    altTraj: best.traj,
    pairs,
    hitPoints: best.hit,
  });

  const rows = totalsRows(ctx, {
    baselineTotal: rec.points,
    altTotal: best.total,
    baselineLabel: 'Best current plan',
    altLabelPrefix: 'Best plan keeping',
  });
  if (best.replaced !== null) {
    rows.push(row('direct_change', 'What keeping him costs', `${nameOf(ctx.gameState, best.replaced)} never arrives`, null, 'text'));
  }
  rows.push(budgetRow(ctx, comparison.altCost, costOf(ctx, ctx.plan.squad)));
  if (comparison.preference) rows.push(comparison.preference);

  const verdict = verdictOf(comparison.delta);
  return {
    playerId: ctx.playerId,
    name: ctx.name,
    mode: 'keep',
    verdict,
    preference: comparison.preference,
    headline: `${ctx.name} is in your squad today and the recommendation sells him.`,
    rows,
    reasons: comparison.reasons,
    result: resultLine(ctx, verdict, comparison.delta),
    blockers: [],
    alternatives: [],
    deltaHorizon: comparison.delta,
    squad: best.squad,
    text: `${ctx.name} is in your squad today and the recommendation sells him. ${resultLine(ctx, verdict, comparison.delta).text}`,
  };
}

/* -------------------------------------------------------------- entry point */

export function counterfactual(playerId, { planBundle, gameState, rules, opts = {} }) {
  const answer = answerFor(playerId, { planBundle, gameState, rules, opts });
  return { ...answer, basis: planBasis(planBundle) };
}

// One route out of the held squad, scored exactly as every "why not" scenario
// is (`scenarioOf`): the planner's scorer, the plan's options and chip, a
// timing chip credited at its net value only when its own decision plays it.
// Exported so a test can hold that number against the planner's own ranking.
export function scoreRoute({ transfersOut = [], transfersIn = [] }, { planBundle, gameState, rules, opts = {} }) {
  const ctx = makeContext(transfersIn[0] ?? null, { planBundle, gameState, rules: rules || gameState.rules, opts });
  return scenarioOf(ctx, { transfersOut, transfersIn });
}

function answerFor(playerId, { planBundle, gameState, rules, opts = {} }) {
  const R = rules || gameState.rules;

  // A counterfactual is a transfer recommendation wearing a question mark:
  // "you would gain 2.1 points" is the same claim as "make this transfer".
  // Every other surface that publishes a recommendation asks the readiness
  // ladder first; this one re-ran the optimizer straight off the same
  // projections and never asked, so during both live-season incidents a
  // manager could ask "why not Haaland?" and get a confidently worded verdict
  // with a point delta while the rest of the screen said recommendations were
  // paused. Refuse at the same rung transfers are refused at.
  const readiness = planBundle && planBundle.dataStatus && planBundle.dataStatus.readiness;
  if (!canCompareSquads(readiness)) {
    const because = (readiness && readiness.headline) || 'the data behind this plan is incomplete';
    const name = nameOf(gameState, playerId);
    return {
      playerId,
      name,
      mode: 'unavailable',
      verdict: 'unknown',
      headline: 'Comparisons are paused while the data settles.',
      rows: [],
      reasons: [],
      result: null,
      blockers: [reason('data_unusable', because, null, 'count')],
      alternatives: [],
      deltaHorizon: null,
      text: `Comparing ${name} against this squad would mean trusting projections that are not trustworthy right now: ${because}`,
    };
  }

  const ctx = makeContext(playerId, { planBundle, gameState, rules: R, opts });

  if (!ctx.target) {
    return {
      playerId,
      name: `player ${playerId}`,
      mode: 'unknown',
      verdict: 'unknown',
      headline: 'That player is not in the current Fantasy Premier League player list.',
      rows: [],
      reasons: [],
      result: null,
      blockers: [reason('unknown_player', 'No player with that id exists in the data we loaded.', playerId, 'count')],
      alternatives: [],
      deltaHorizon: null,
      text: 'That player is not in the current Fantasy Premier League player list.',
    };
  }

  if (ctx.plan.squad.includes(playerId)) {
    const inXi = ctx.plan.startingXI.includes(playerId);
    const traj = scoreSquad(ctx, ctx.plan.squad);
    const headline = inXi
      ? `${ctx.name} is already in the recommended starting eleven.`
      : `${ctx.name} is already in the recommended squad, on the bench this gameweek.`;
    return {
      playerId,
      name: ctx.name,
      mode: 'owned',
      verdict: 'owned',
      headline,
      rows: [row(
        'baseline_total',
        'Recommended squad',
        `${fmt(traj.total)} xP over ${ctx.horizon} ${ctx.horizon === 1 ? 'gameweek' : 'gameweeks'}`,
        traj.total,
      )],
      reasons: [reason('already_owned', `${ctx.name} projects {v} points this gameweek.`, (projRow(ctx.projections, playerId, ctx.gw) || { xPoints: 0 }).xPoints)],
      result: null,
      blockers: [],
      alternatives: [],
      deltaHorizon: 0,
      text: headline,
    };
  }

  const isDraft = ctx.squadState.source === 'draft' || (ctx.squadState.picks || []).length === 0;
  if (isDraft) return draftAnswer(ctx);

  const heldIds = (ctx.squadState.picks || []).map(p => p.playerId);
  if (heldIds.includes(playerId)) {
    const kept = keepAnswer(ctx);
    if (kept) return kept;
  }

  return transferAnswer(ctx);
}
