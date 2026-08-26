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

// Statuses the game will not let anyone buy: gone from the league, or not
// registered in a Premier League squad. Mirrors squad-builder.js.
const UNBUYABLE_STATUSES = new Set(['u', 'n']);

export const COUNTERFACTUAL_PARAMS = Object.freeze({
  // Two squads inside this many horizon points are honestly interchangeable.
  tieTolerance: 0.5,
  // Expected minutes over the whole horizon, so roughly a third of a start.
  minutesTolerance: 30,
  // Routes are enumerated up to two moves. Beyond that a manager is rebuilding,
  // which is a wildcard question and not this one.
  maxRouteTransfers: 2,
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

function hitPointsFor(ctx, transfers) {
  const free = ctx.squadState.freeTransfers || 0;
  return Math.max(0, transfers - free) * ctx.rules.hitCost;
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

// Every legal way to end this gameweek holding the target, in one move or two.
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
  routes.push(...proxies.slice(0, COUNTERFACTUAL_PARAMS.exactRouteShortlist));

  return { routes, bestShortfall, clubBlocked, sameClubHeld };
}

function routeAnswer(ctx) {
  const unavailable = unavailableBlocker(ctx);
  if (unavailable) return impossible(ctx, [unavailable], { mode: 'transfer' });

  const { routes, bestShortfall, clubBlocked, sameClubHeld } = enumerateRoutes(ctx);

  if (!routes.length) {
    const blockers = [];
    if (clubBlocked || sameClubHeld.length >= ctx.rules.clubLimit) {
      blockers.push(reason(
        'club_limit',
        `You already hold {v} players from ${clubOf(ctx.gameState, ctx.playerId)}, which is the limit, and no legal move inside ${COUNTERFACTUAL_PARAMS.maxRouteTransfers} transfers frees a place.`,
        sameClubHeld.length,
        'count',
      ));
    }
    if (Number.isFinite(bestShortfall)) {
      blockers.push(reason(
        'budget',
        `Buying ${ctx.name} needs another {v}, even after selling the two players who raise the most.`,
        bestShortfall,
        'tenths',
      ));
    }
    if (!blockers.length) {
      blockers.push(reason(
        'squad',
        `No legal squad inside {v} transfers ends the gameweek holding him.`,
        COUNTERFACTUAL_PARAMS.maxRouteTransfers,
        'count',
      ));
    }
    return impossible(ctx, blockers, { mode: 'transfer' });
  }

  const baselineTraj = scoreSquad(ctx, ctx.plan.squad);
  const baselineTotal = ctx.plan.xPointsHorizon;

  const scored = routes.map(route => {
    const traj = scoreSquad(ctx, route.squad);
    const hit = hitPointsFor(ctx, route.transfers);
    return { ...route, traj, hit, total: traj.total - hit };
  });
  scored.sort((a, b) => b.total - a.total || a.transfers - b.transfers);

  const best = scored[0];
  // The route's OWN moves, not the difference between two end squads. See
  // compareSquads.
  const routePairs = best.out.map((outId, i) => ({
    position: ctx.gameState.players.get(outId).position,
    out: outId,
    in: best.in[i],
  }));
  // The one-move version of this route: sell only the player he replaces. It is
  // scored even when the money does not reach, because that is the case the
  // knock-on exists to explain.
  const heldIds = (ctx.squadState.picks || []).map(p => p.playerId);
  const directSquad = heldIds.filter(id => id !== best.out[0]).concat(ctx.playerId);
  const comparison = compareSquads(ctx, {
    baselineTotal,
    baselineTraj,
    altSquad: best.squad,
    altTotal: best.total,
    altTraj: best.traj,
    pairs: routePairs,
    hitPoints: best.hit,
    directSquad,
    directHitPoints: hitPointsFor(ctx, 1),
    directOverBudget: Math.max(0, ctx.target.nowCost - (heldState(ctx).bank + (heldState(ctx).selling.get(best.out[0]) || 0))),
  });

  const rows = totalsRows(ctx, {
    baselineTotal,
    altTotal: best.total,
    baselineLabel: 'Best current plan',
    altLabelPrefix: 'Best plan containing',
  });
  rows.push(row(
    'route',
    'Best route',
    `${best.transfers} ${best.transfers === 1 ? 'transfer' : 'transfers'}, ${listAnd(routePairs.map(p => pairText(ctx, p)))}`,
    best.transfers,
    'count',
  ));
  const recommended = (ctx.plan.transfersOut || []).map((outId, i) => ({
    position: ctx.gameState.players.get(outId).position,
    out: outId,
    in: (ctx.plan.transfersIn || [])[i],
  }));
  if (recommended.length) {
    rows.push(row(
      'instead_of',
      'Instead of the recommended move',
      listAnd(recommended.map(p => pairText(ctx, p))),
      null,
      'text',
    ));
  }
  rows.push(budgetRow(ctx, comparison.altCost, costOf(ctx, ctx.plan.squad)));
  rows.push(row(
    'bank_after',
    'Bank after',
    `${fmt(best.bank, 'tenths')} left, against ${fmt(ctx.plan.bankAfterTenths, 'tenths')} in the recommended plan`,
    best.bank,
    'tenths',
  ));
  if (comparison.preference) rows.push(comparison.preference);

  const reasons = comparison.reasons.slice();
  const later = laterGameweekReason(ctx, baselineTraj, best.traj);
  if (later) reasons.push(later);

  const verdict = verdictOf(comparison.delta);
  const alternatives = alternativeRoutes(ctx, scored, best, baselineTotal);

  return {
    playerId: ctx.playerId,
    name: ctx.name,
    mode: 'transfer',
    verdict,
    headline: headlineFor(ctx, verdict),
    rows,
    reasons,
    result: resultLine(ctx, verdict, comparison.delta),
    blockers: [],
    alternatives,
    deltaHorizon: comparison.delta,
    transfers: best.transfers,
    hitPoints: best.hit,
    squad: best.squad,
    bankTenths: best.bank,
    text: `${headlineFor(ctx, verdict)} ${resultLine(ctx, verdict, comparison.delta).text}`,
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
// transfer count, never every route the search touched.
function alternativeRoutes(ctx, scored, best, baselineTotal) {
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
    hitPoints: route.hit,
    deltaHorizon: route.total - baselineTotal,
    label: `${route.transfers} ${route.transfers === 1 ? 'transfer' : 'transfers'}: ${route.out.map((id, i) => `${nameOf(ctx.gameState, id)} to ${nameOf(ctx.gameState, route.in[i])}`).join(', ')}`,
    text: reason(
      'alternative',
      route.total - baselineTotal >= 0
        ? 'Projects {v} points above the recommended plan.'
        : 'Projects {v} points below the recommended plan.',
      Math.abs(route.total - baselineTotal),
    ).text,
  }));
}

/* ------------------------------------------------- already in the reckoning */

// He is held today but the recommendation sells him. The counterfactual is
// keeping him, which is a real question with a real answer, and it is not the
// same question as buying him.
function keepAnswer(ctx) {
  const held = (ctx.squadState.picks || []).map(p => p.playerId);
  const incoming = (ctx.plan.transfersIn || []).filter(id => {
    const p = ctx.gameState.players.get(id);
    return p && p.position === ctx.target.position;
  });

  const candidates = [{ squad: held.slice(), transfers: 0, replaced: null }];
  for (const inId of incoming) {
    candidates.push({
      squad: ctx.plan.squad.filter(id => id !== inId).concat(ctx.playerId),
      transfers: Math.max(0, ctx.plan.transferCount - 1),
      replaced: inId,
    });
  }

  const baselineTraj = scoreSquad(ctx, ctx.plan.squad);
  const scored = candidates
    .filter(c => legalSquad(ctx, c.squad))
    .map(c => {
      const traj = scoreSquad(ctx, c.squad);
      const hit = hitPointsFor(ctx, c.transfers);
      return { ...c, traj, hit, total: traj.total - hit };
    });
  if (!scored.length) return null;
  scored.sort((a, b) => b.total - a.total);
  const best = scored[0];

  const { pairs } = diffPairs(ctx, ctx.plan.squad, best.squad);
  const comparison = compareSquads(ctx, {
    baselineTotal: ctx.plan.xPointsHorizon,
    baselineTraj,
    altSquad: best.squad,
    altTotal: best.total,
    altTraj: best.traj,
    pairs,
    hitPoints: best.hit,
  });

  const rows = totalsRows(ctx, {
    baselineTotal: ctx.plan.xPointsHorizon,
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
  const R = rules || gameState.rules;
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

  return routeAnswer(ctx);
}
