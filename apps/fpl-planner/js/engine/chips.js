// Chip strategy, evaluated across the REMAINING SEASON rather than this week.
//
// Chips are season-level assets. A wildcard spent on a 6-point upgrade is not a
// 6-point gain, it is a 6-point gain minus whatever the same chip would have
// been worth in the week the squad actually breaks. So every chip here is scored
// against two alternatives: doing nothing, and doing the same thing later.
//
// The default answer is HOLD, and it should be: over a 38 gameweek season each
// chip is playable in one specific half, so on any given week the probability
// that this is the right week is small. `{ decision:'hold', chip:null }` comes
// back with real numbers attached, never as an empty state.
//
// Every value on the output is a points number produced by the projection model
// or by an optimizer call, never a label. The explanation layer copies these
// numbers straight through, so a reason that says "8.4" is carrying the same
// 8.4 the optimizer computed.
//
// WHAT EACH CHIP IS COMPARED AGAINST
//
//   wildcard   the horizon trajectory of the current squad, against a full
//              15 player rebuild under the same budget, club and position
//              constraints. Threshold in discounted horizon points.
//   freehit    a single gameweek only, because the squad returns afterwards.
//              That makes it far more aggressive than a wildcard: it can empty
//              the squad into one week's best eleven and pay nothing later.
//   bboost     the bench, valued at this gameweek and at every later gameweek
//              the current bench could be boosted in, with the transfer cost of
//              repairing a weak bench charged against the later option.
//   3xc        the extra captain multiplier now, against the best remaining
//              week in the season, including doubles beyond the projection
//              horizon estimated from fixture counts and difficulty.

import { chipAvailableAt } from './rules.js';
import { hitCost, transferStateOf } from './transfer-state.js';
import { optimizeLineup } from './lineup.js';
import { chooseCaptain } from './captain.js';
import { buildSquad } from './squad-builder.js';
import { fixturesForTeam } from './fixtures.js';

// ---------------------------------------------------------------------------
// Thresholds. Every one of these is a points quantity with a stated reason, and
// they are exported so the model status panel can show what the engine used.
// ---------------------------------------------------------------------------

// A wildcard rebuild is worth playing only when it beats the trajectory the
// current squad is already on by more than the hits it saves. Rebuilding a
// squad normally means 4 to 6 transfers, which is 12 to 20 points of hits, and
// anything below that is reachable with the weekly free transfers instead.
const WILDCARD_HORIZON_THRESHOLD = 12;

// A free hit rents a squad for one gameweek. It has to beat both doing nothing
// and taking the hits, so the bar is one gameweek's worth of a badly broken
// squad: roughly two blanking players plus an unavailable one.
const FREE_HIT_THRESHOLD = 12;

// A normal bench delivers about 4 to 6 points, so a bench boost that returns
// less than this is a chip spent on an average week.
const BENCH_BOOST_THRESHOLD = 8;

// The triple captain has to beat the best remaining week by a clear margin,
// because the chip is gone forever afterwards and the estimate of a later week
// is a maximum over many weeks and therefore optimistic already.
const TRIPLE_CAPTAIN_MARGIN = 2.5;

// Patience discount per gameweek when comparing a chip played now against the
// same chip played later. Waiting is not free: injuries, price changes and
// fixture reschedules erode a planned chip week. Deliberately mild, because the
// "best remaining week" estimate is a max over weeks and already optimistic.
const CHIP_PATIENCE_PER_GW = 0.99;

// Beyond the projection horizon there are no player projections, only the
// fixture list. A player's points are extrapolated as their per fixture rate
// inside the horizon, scaled by how many fixtures they have that week and by
// fixture difficulty. FDR runs 1 to 5 with 3 as the average fixture, and this
// is how much one step of difficulty is worth.
const FDR_SENSITIVITY = 0.12;

// A bench player who is this unlikely to appear is not boostable: the bench
// would have to be rebuilt first, and that costs transfers.
const BENCH_WEAK_P_APPEAR = 0.5;

export const CHIP_PARAMS = Object.freeze({
  wildcardHorizonThreshold: WILDCARD_HORIZON_THRESHOLD,
  freeHitThreshold: FREE_HIT_THRESHOLD,
  benchBoostThreshold: BENCH_BOOST_THRESHOLD,
  tripleCaptainMargin: TRIPLE_CAPTAIN_MARGIN,
  chipPatiencePerGw: CHIP_PATIENCE_PER_GW,
  fdrSensitivity: FDR_SENSITIVITY,
  benchWeakPAppear: BENCH_WEAK_P_APPEAR,
});

// ---------------------------------------------------------------------------
// Reason helper.
//
// The rule the explanation layer depends on: the number a human reads in `text`
// is the number in `value`, because the text is built FROM the value. There is
// no path here that writes a sentence and a figure separately, which is what
// makes the "every number is engine derived" test able to fail.
// ---------------------------------------------------------------------------

export function fmtValue(value, unit) {
  if (value === null || value === undefined) return '';
  if (unit === 'tenths') return `£${(value / 10).toFixed(1)}m`;
  if (unit === 'count' || unit === 'gw') return String(Math.round(value));
  if (unit === 'percent') return `${Math.round(value * 100)}%`;
  return (Math.round(value * 10) / 10).toFixed(1);
}

// `template` contains {v}, which is replaced by the formatted value. Nothing
// else may contain a number that came from anywhere but `value`.
export function makeReason(code, template, value, unit = 'points') {
  return {
    code,
    text: String(template).replace('{v}', fmtValue(value, unit)),
    value,
    unit,
  };
}

// ---------------------------------------------------------------------------
// Squad trajectory: the shared "what is this squad worth over the horizon"
// evaluator.
//
// It lives here rather than in planner.js because planner.js imports this
// module, and a cycle between the two would be resolvable but pointless. The
// chip evaluator, the planner and the explanation layer all measure squads the
// same way as a result, which is what makes a chip gain comparable to a
// transfer gain.
// ---------------------------------------------------------------------------

export function xpOf(projections, playerId, gw) {
  const row = projections && typeof projections.get === 'function' ? projections.get(playerId, gw) : null;
  return row && Number.isFinite(row.xPoints) ? row.xPoints : 0;
}

function projOf(projections, playerId, gw) {
  return projections && typeof projections.get === 'function' ? projections.get(playerId, gw) : null;
}

export function discountWeights(horizon, discount) {
  const w = [];
  for (let k = 0; k < horizon; k++) w.push(Math.pow(discount, k));
  return w;
}

export function squadTrajectory({
  squadIds, projections, gameState, rules, gwFrom, horizon = 1, discount = 1, opts = {},
}) {
  const weights = discountWeights(horizon, discount);
  const gws = [];
  let total = 0;

  for (let k = 0; k < horizon; k++) {
    const gw = gwFrom + k;
    // gameState is threaded explicitly: optimizeLineup resolves player
    // positions through it, and callers of squadTrajectory pass chip-level
    // opts that do not carry it.
    const lineup = optimizeLineup(squadIds, projections, gw, rules, { ...opts, gameState });
    const captaincy = chooseCaptain(lineup.startingXI, projections, gw, gameState, opts);
    const captainExtra = xpOf(projections, captaincy.captain, gw);
    const benchIds = [lineup.bench.gk, ...lineup.bench.order];
    const xPointsBench = benchIds.reduce((s, id) => s + xpOf(projections, id, gw), 0);
    const xPointsXi = Number.isFinite(lineup.xPoints)
      ? lineup.xPoints
      : lineup.startingXI.reduce((s, id) => s + xpOf(projections, id, gw), 0);

    const row = {
      gw,
      weight: weights[k],
      startingXI: lineup.startingXI,
      formation: lineup.formation,
      bench: lineup.bench,
      captain: captaincy.captain,
      viceCaptain: captaincy.viceCaptain,
      captainScore: captaincy.captainScore,
      captainCandidates: captaincy.candidates || [],
      xPointsXi,
      xPointsBench,
      captainExtra,
      xPoints: xPointsXi + captainExtra,
      sd: Number.isFinite(lineup.sd) ? lineup.sd : 0,
    };
    gws.push(row);
    total += weights[k] * row.xPoints;
  }

  return { total, gws, discount, horizon };
}

// ---------------------------------------------------------------------------
// Season-wide structure, from the fixture list alone.
//
// The projection set only covers the horizon. Everything past it is read off
// the fixture calendar, which IS known for the whole season: how many fixtures
// each club has in each gameweek (a zero is a blank, a two is a double) and the
// published difficulty of each one. That is enough to find the weeks worth
// waiting for without projecting 30 gameweeks of players.
// ---------------------------------------------------------------------------

function fdrFactor(fixtures, teamId) {
  if (!fixtures.length) return 0;
  let sum = 0;
  for (const f of fixtures) {
    const fdr = f.teamH === teamId ? f.teamHDifficulty : f.teamADifficulty;
    const d = Number.isFinite(fdr) ? fdr : 3;
    sum += 1 + FDR_SENSITIVITY * (3 - d);
  }
  return sum / fixtures.length;
}

// A player's points per fixture measured inside the horizon, which is the only
// place real projections exist. Used to extrapolate later gameweeks.
function perFixtureRate(projections, playerId, gwFrom, horizon) {
  let points = 0;
  let fixtures = 0;
  for (let gw = gwFrom; gw < gwFrom + horizon; gw++) {
    const row = projOf(projections, playerId, gw);
    if (!row) continue;
    const n = row.fixtures ? row.fixtures.length : 0;
    if (!n) continue;
    points += row.xPoints;
    fixtures += n;
  }
  return fixtures > 0 ? points / fixtures : 0;
}

// Estimated points for a player in a gameweek that may be outside the horizon.
// Inside the horizon this returns the projection itself, so the two regimes
// agree at the boundary.
function estimateXp(projections, gameState, player, gw, gwFrom, horizon) {
  if (gw >= gwFrom && gw < gwFrom + horizon) {
    const row = projOf(projections, player.id, gw);
    if (row) return row.xPoints;
  }
  const fixtures = fixturesForTeam(gameState, player.teamId, gw);
  if (!fixtures.length) return 0;
  const rate = perFixtureRate(projections, player.id, gwFrom, horizon);
  return rate * fixtures.length * fdrFactor(fixtures, player.teamId);
}

function legalGwsForChip(rules, chipName, gw, chipsUsed) {
  const out = [];
  for (let g = gw; g <= rules.totalEvents; g++) {
    if (chipAvailableAt(rules, chipName, g, chipsUsed)) out.push(g);
  }
  return out;
}

function patience(gw, gwFrom) {
  return Math.pow(CHIP_PATIENCE_PER_GW, Math.max(0, gw - gwFrom));
}

// ---------------------------------------------------------------------------

function spendableTenths(squadState) {
  return squadState.picks.reduce((s, p) => s + p.sellingTenths, 0) + squadState.bankTenths;
}

function unavailable(gameState, playerId) {
  const p = gameState.players.get(playerId);
  return !!p && (p.status === 'i' || p.status === 's' || p.status === 'u' || p.status === 'n');
}

// ---------------------------------------------------------------------------
// Wildcard
// ---------------------------------------------------------------------------

function evaluateWildcard(ctx) {
  const { squadState, projections, gameState, rules, horizon, gw, discount, baseline, chipsUsed } = ctx;
  const legal = chipAvailableAt(rules, 'wildcard', gw, chipsUsed);
  const legalGws = legalGwsForChip(rules, 'wildcard', gw, chipsUsed);
  const reasons = [];

  if (!legal) {
    return notAvailable('wildcard', legalGws, gw, reasons);
  }

  const budget = spendableTenths(squadState);
  const built = buildSquad({
    projections, gameState, rules, gw, horizon,
    budgetTenths: budget,
    opts: { discount },
  });
  const rebuilt = squadTrajectory({
    squadIds: built.squad, projections, gameState, rules,
    gwFrom: gw, horizon, discount,
  });
  const gain = rebuilt.total - baseline.total;
  const changes = built.squad.filter(id => !squadState.picks.some(p => p.playerId === id)).length;

  // The week the current squad is most broken, from the calendar alone: players
  // with no fixture, plus players who are already unavailable.
  const structure = wildcardStructureScan(ctx, legalGws);

  reasons.push(makeReason(
    'wildcard_gain',
    'A full rebuild projects {v} more points than your current squad over the horizon.',
    gain,
  ));
  reasons.push(makeReason(
    'wildcard_threshold',
    'A wildcard needs to beat your current squad by {v} points to be worth spending, because the same moves cost that much in hits.',
    WILDCARD_HORIZON_THRESHOLD,
  ));
  reasons.push(makeReason('wildcard_changes', 'The rebuild changes {v} of your 15 players.', changes, 'count'));
  if (structure.bestGw !== null && structure.bestGw !== gw) {
    reasons.push(makeReason(
      'wildcard_future_structure',
      `Gameweek ${structure.bestGw} is where your squad breaks hardest, with {v} of your players blank or unavailable.`,
      structure.bestCount,
      'count',
    ));
  }

  return {
    chip: 'wildcard',
    available: true,
    valueNow: gain,
    threshold: WILDCARD_HORIZON_THRESHOLD,
    recommended: gain >= WILDCARD_HORIZON_THRESHOLD,
    holdReason: makeReason(
      'hold_wildcard',
      `A wildcard rebuild gains {v} points over the horizon, short of the ${fmtValue(WILDCARD_HORIZON_THRESHOLD, 'points')} it has to beat.`,
      gain,
    ),
    bestGw: structure.bestGw,
    bestValue: null,
    nextLegalGw: legalGws.length ? legalGws[0] : null,
    detail: {
      budgetTenths: budget,
      costTenths: built.costTenths,
      squad: built.squad,
      changes,
      rebuiltHorizon: rebuilt.total,
      currentHorizon: baseline.total,
      structure: structure.perGw,
    },
    reasons,
  };
}

function wildcardStructureScan(ctx, legalGws) {
  const { squadState, gameState } = ctx;
  const ids = squadState.picks.map(p => p.playerId);
  const perGw = [];
  let bestGw = null;
  let bestCount = 0;

  for (const g of legalGws) {
    let broken = 0;
    for (const id of ids) {
      const player = gameState.players.get(id);
      if (!player) continue;
      if (unavailable(gameState, id)) broken++;
      else if (fixturesForTeam(gameState, player.teamId, g).length === 0) broken++;
    }
    perGw.push({ gw: g, broken });
    if (broken > bestCount) {
      bestCount = broken;
      bestGw = g;
    }
  }
  return { perGw, bestGw, bestCount };
}

// ---------------------------------------------------------------------------
// Free hit
// ---------------------------------------------------------------------------

function evaluateFreeHit(ctx) {
  const { squadState, projections, gameState, rules, gw, discount, baseline, chipsUsed } = ctx;
  const legalGws = legalGwsForChip(rules, 'freehit', gw, chipsUsed);
  if (!chipAvailableAt(rules, 'freehit', gw, chipsUsed)) {
    return notAvailable('freehit', legalGws, gw, []);
  }

  const budget = spendableTenths(squadState);
  // A free hit is a one week rental, so it is optimized for one gameweek only.
  // Nothing about the horizon applies: the squad comes straight back afterwards.
  const built = buildSquad({
    projections, gameState, rules, gw,
    horizon: 1,
    budgetTenths: budget,
    opts: { singleGw: true, discount: 1 },
  });
  const rented = squadTrajectory({
    squadIds: built.squad, projections, gameState, rules, gwFrom: gw, horizon: 1, discount: 1,
  });
  const gain = rented.total - baseline.gws[0].xPoints;

  // Where the free hit is classically worth most: the week the squad has the
  // fewest players with a fixture.
  const scan = freeHitScan(ctx, legalGws);

  const reasons = [
    makeReason('freehit_gain', 'A one week rental squad projects {v} more points than your own team this gameweek.', gain),
    makeReason('freehit_threshold', 'A free hit needs to be worth {v} points in the single gameweek it covers.', FREE_HIT_THRESHOLD),
    makeReason('freehit_playable', 'You have {v} players with a fixture this gameweek.', scan.playableNow, 'count'),
  ];
  if (scan.bestGw !== null && scan.bestGw !== gw) {
    reasons.push(makeReason(
      'freehit_future_blank',
      `Gameweek ${scan.bestGw} leaves you with only {v} players with a fixture, which is the week a free hit usually covers.`,
      scan.bestPlayable,
      'count',
    ));
  }

  return {
    chip: 'freehit',
    available: true,
    valueNow: gain,
    threshold: FREE_HIT_THRESHOLD,
    recommended: gain >= FREE_HIT_THRESHOLD,
    holdReason: makeReason(
      'hold_freehit',
      `A one week rental gains {v} points this gameweek, short of the ${fmtValue(FREE_HIT_THRESHOLD, 'points')} a free hit needs to be worth.`,
      gain,
    ),
    bestGw: scan.bestGw,
    bestValue: null,
    nextLegalGw: legalGws.length ? legalGws[0] : null,
    detail: {
      budgetTenths: budget,
      costTenths: built.costTenths,
      squad: built.squad,
      rentedGwPoints: rented.total,
      currentGwPoints: baseline.gws[0].xPoints,
      playableNow: scan.playableNow,
      perGw: scan.perGw,
    },
    reasons,
  };
}

function freeHitScan(ctx, legalGws) {
  const { squadState, gameState, gw } = ctx;
  const ids = squadState.picks.map(p => p.playerId);
  const perGw = [];
  let bestGw = null;
  let bestPlayable = Infinity;
  let playableNow = 0;

  for (const g of legalGws) {
    let playable = 0;
    for (const id of ids) {
      const player = gameState.players.get(id);
      if (!player) continue;
      if (unavailable(gameState, id)) continue;
      if (fixturesForTeam(gameState, player.teamId, g).length > 0) playable++;
    }
    perGw.push({ gw: g, playable });
    if (g === gw) playableNow = playable;
    if (playable < bestPlayable) {
      bestPlayable = playable;
      bestGw = g;
    }
  }
  return { perGw, bestGw, bestPlayable: Number.isFinite(bestPlayable) ? bestPlayable : 0, playableNow };
}

// ---------------------------------------------------------------------------
// Bench boost
// ---------------------------------------------------------------------------

function evaluateBenchBoost(ctx) {
  const { squadState, projections, gameState, rules, gw, horizon, baseline, chipsUsed } = ctx;
  const legalGws = legalGwsForChip(rules, 'bboost', gw, chipsUsed);
  if (!chipAvailableAt(rules, 'bboost', gw, chipsUsed)) {
    return notAvailable('bboost', legalGws, gw, []);
  }

  const now = baseline.gws[0];
  const valueNow = now.xPointsBench;
  const benchIds = [now.bench.gk, ...now.bench.order];

  // Team structure cost. A bench worth boosting is a bench with four players who
  // actually start, and money spent on a fourth defender who plays is money not
  // spent on the eleven. Rather than assert that in prose, it is charged as what
  // it would actually cost to get there: one transfer per bench player who is
  // unlikely to appear, at the hit rate once free transfers run out.
  const weakBench = benchIds.filter(id => {
    const row = projOf(projections, id, gw);
    return !row || row.pAppear < BENCH_WEAK_P_APPEAR;
  });
  const structureCost = hitCost(transferStateOf(squadState, rules), weakBench.length, rules);
  const benchSpendTenths = squadState.picks
    .filter(p => benchIds.includes(p.playerId))
    .reduce((s, p) => s + p.sellingTenths, 0);

  // Later weeks, with the bench you actually own. Inside the horizon these are
  // real projections; past it they are fixture count and difficulty scaled.
  let bestGw = null;
  let bestValue = -Infinity;
  const perGw = [];
  for (const g of legalGws) {
    if (g === gw) continue;
    let value = 0;
    for (const id of benchIds) {
      const player = gameState.players.get(id);
      if (!player) continue;
      value += estimateXp(projections, gameState, player, g, gw, horizon);
    }
    const discounted = value * patience(g, gw) - structureCost;
    perGw.push({ gw: g, value, discounted });
    if (discounted > bestValue) {
      bestValue = discounted;
      bestGw = g;
    }
  }
  if (!Number.isFinite(bestValue)) bestValue = 0;

  const recommended = valueNow >= BENCH_BOOST_THRESHOLD && valueNow >= bestValue;
  const reasons = [
    makeReason('bboost_value_now', 'Your bench projects {v} points this gameweek.', valueNow),
    makeReason('bboost_threshold', 'A bench boost is worth spending at {v} points or more, because an average bench returns less than that.', BENCH_BOOST_THRESHOLD),
  ];
  if (bestGw !== null) {
    reasons.push(makeReason(
      'bboost_best_future',
      `Your best remaining bench week looks like gameweek ${bestGw}, worth {v} points.`,
      bestValue,
    ));
  }
  if (weakBench.length) {
    reasons.push(makeReason(
      'bboost_weak_bench',
      '{v} of your four bench players are unlikely to play, so the bench would need rebuilding first.',
      weakBench.length,
      'count',
    ));
  }

  return {
    chip: 'bboost',
    available: true,
    valueNow,
    threshold: BENCH_BOOST_THRESHOLD,
    recommended,
    // Two ways to fall short, and they are different sentences: a bench that is
    // not worth boosting at all, and a bench that is worth boosting in a better
    // week than this one.
    holdReason: valueNow < BENCH_BOOST_THRESHOLD
      ? makeReason(
        'hold_bboost',
        `Your bench projects {v} points this gameweek, short of the ${fmtValue(BENCH_BOOST_THRESHOLD, 'points')} a bench boost needs.`,
        valueNow,
      )
      : makeReason(
        'hold_bboost',
        `Your bench projects {v} points this gameweek, and gameweek ${bestGw} projects ${fmtValue(bestValue, 'points')}, so the chip is worth more later.`,
        valueNow,
      ),
    bestGw,
    bestValue,
    nextLegalGw: legalGws.length ? legalGws[0] : null,
    detail: {
      bench: benchIds,
      weakBench,
      structureCost,
      benchSpendTenths,
      perGw,
    },
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Triple captain
// ---------------------------------------------------------------------------

function evaluateTripleCaptain(ctx) {
  const { squadState, projections, gameState, rules, gw, horizon, baseline, chipsUsed } = ctx;
  const legalGws = legalGwsForChip(rules, '3xc', gw, chipsUsed);
  if (!chipAvailableAt(rules, '3xc', gw, chipsUsed)) {
    return notAvailable('3xc', legalGws, gw, []);
  }

  const now = baseline.gws[0];
  // Triple captain adds one further copy of the captain's points on top of the
  // normal double, so its value is exactly the captain's projection.
  const valueNow = now.captainExtra;
  const squadIds = squadState.picks.map(p => p.playerId);

  let bestGw = null;
  let bestValue = -Infinity;
  let bestPlayer = null;
  const perGw = [];
  for (const g of legalGws) {
    if (g === gw) continue;
    let top = 0;
    let topId = null;
    for (const id of squadIds) {
      const player = gameState.players.get(id);
      if (!player) continue;
      const xp = estimateXp(projections, gameState, player, g, gw, horizon);
      if (xp > top) {
        top = xp;
        topId = id;
      }
    }
    const discounted = top * patience(g, gw);
    perGw.push({ gw: g, value: top, discounted, playerId: topId });
    if (discounted > bestValue) {
      bestValue = discounted;
      bestGw = g;
      bestPlayer = topId;
    }
  }
  if (!Number.isFinite(bestValue)) bestValue = 0;

  const recommended = valueNow - bestValue >= TRIPLE_CAPTAIN_MARGIN;
  const captainName = playerName(gameState, now.captain);
  const reasons = [
    makeReason('3xc_value_now', `Tripling ${captainName} this gameweek adds {v} points.`, valueNow),
    makeReason('3xc_margin', 'The chip is only spent when this week beats the best week left by {v} points, because it cannot be won back.', TRIPLE_CAPTAIN_MARGIN),
  ];
  if (bestGw !== null) {
    reasons.push(makeReason(
      '3xc_best_future',
      `Your best remaining triple captain week looks like gameweek ${bestGw}${bestPlayer ? ` with ${playerName(gameState, bestPlayer)}` : ''}, worth {v} points.`,
      bestValue,
    ));
  }

  return {
    chip: '3xc',
    available: true,
    valueNow,
    threshold: TRIPLE_CAPTAIN_MARGIN,
    recommended,
    // The triple captain's bar is a MARGIN over the best week left, not an
    // absolute number of points, so saying "worth 6.0, short of the 2.5 it
    // needs" would be false. What it is short of is the week it is being kept
    // for.
    holdReason: makeReason(
      'hold_3xc',
      `Tripling ${captainName} adds {v} points this gameweek, and the best week left is worth ${fmtValue(bestValue, 'points')}, so it does not clear it by the ${fmtValue(TRIPLE_CAPTAIN_MARGIN, 'points')} the chip needs.`,
      valueNow,
    ),
    bestGw,
    bestValue,
    nextLegalGw: legalGws.length ? legalGws[0] : null,
    detail: {
      captain: now.captain,
      bestPlayer,
      perGw,
    },
    reasons,
  };
}

function playerName(gameState, playerId) {
  const p = gameState.players.get(playerId);
  return p ? p.webName : `player ${playerId}`;
}

// ---------------------------------------------------------------------------

function notAvailable(chip, legalGws, gw, reasons) {
  const next = legalGws.length ? legalGws[0] : null;
  const out = reasons.slice();
  if (next !== null) {
    out.push(makeReason('chip_window', 'This chip is not playable this gameweek. The next gameweek it can be used is {v}.', next, 'gw'));
  } else {
    out.push(makeReason('chip_spent', 'This chip is no longer available for the rest of the season.', 0, 'count'));
  }
  return {
    chip,
    available: false,
    valueNow: 0,
    threshold: null,
    recommended: false,
    bestGw: null,
    bestValue: null,
    nextLegalGw: next,
    detail: {},
    reasons: out,
  };
}

// ---------------------------------------------------------------------------

export function evaluateChips({ squadState, projections, gameState, rules, horizon = 5, discount = 1, opts = {} }) {
  const gw = squadState.gw;
  const chipsUsed = squadState.chipsUsed || [];
  const squadIds = squadState.picks.map(p => p.playerId);

  // Nothing to evaluate without a squad: a draft has no bench to boost and no
  // trajectory to wildcard away from.
  if (squadIds.length === 0) {
    return {
      recommendation: {
        decision: 'hold',
        chip: null,
        value: 0,
        reasons: [makeReason('no_squad', 'There is no squad to play a chip with yet, so all {v} chips stay in hand.', new Set(rules.chips.map(c => c.name)).size, 'count')],
      },
      perChip: {},
      baseline: null,
      params: CHIP_PARAMS,
    };
  }

  const baseline = squadTrajectory({
    squadIds, projections, gameState, rules, gwFrom: gw, horizon, discount, opts,
  });

  const ctx = { squadState, projections, gameState, rules, gw, horizon, discount, baseline, chipsUsed, opts };

  const perChip = {
    wildcard: evaluateWildcard(ctx),
    freehit: evaluateFreeHit(ctx),
    bboost: evaluateBenchBoost(ctx),
    '3xc': evaluateTripleCaptain(ctx),
  };

  // Only one chip can be played in a gameweek, so the recommendation is the
  // best chip that cleared its own bar, measured by how far past the bar it is.
  let best = null;
  for (const entry of Object.values(perChip)) {
    if (!entry.recommended) continue;
    const margin = entry.valueNow - (entry.threshold || 0);
    if (!best || margin > best.margin) best = { entry, margin };
  }

  if (best) {
    return {
      recommendation: {
        decision: 'play',
        chip: best.entry.chip,
        value: best.entry.valueNow,
        reasons: best.entry.reasons,
      },
      perChip,
      baseline,
      params: CHIP_PARAMS,
    };
  }

  return {
    recommendation: {
      decision: 'hold',
      chip: null,
      value: 0,
      reasons: holdReasons(perChip, gw),
    },
    perChip,
    baseline,
    params: CHIP_PARAMS,
  };
}

// Holding is the normal answer, so it gets real content: for each chip in hand,
// what it is worth this week and what it needs to be worth.
function holdReasons(perChip, gw) {
  const reasons = [];
  const inHand = Object.values(perChip).filter(c => c.available);
  reasons.push(makeReason(
    'chips_in_hand',
    'You have {v} chips playable this gameweek, and none of them clears its bar.',
    inHand.length,
    'count',
  ));
  for (const entry of inHand) {
    // Each chip writes its own sentence, because each chip has its own bar: an
    // absolute points total for the wildcard, the free hit and the bench boost,
    // a margin over the best week left for the triple captain. One shared
    // sentence for all four would have to state at least one of them wrongly.
    reasons.push(entry.holdReason);
    if (entry.bestGw !== null && entry.bestGw !== gw) {
      reasons.push(makeReason(
        `hold_${entry.chip}_better`,
        `${chipLabel(entry.chip)} looks better around gameweek {v}.`,
        entry.bestGw,
        'gw',
      ));
    }
  }
  if (!inHand.length) {
    reasons.push(makeReason('no_chips', 'You have {v} chips available this gameweek.', 0, 'count'));
  }
  return reasons;
}

export function chipLabel(chip) {
  if (chip === 'wildcard') return 'Wildcard';
  if (chip === 'freehit') return 'Free Hit';
  if (chip === 'bboost') return 'Bench Boost';
  if (chip === '3xc') return 'Triple Captain';
  return 'No chip';
}
