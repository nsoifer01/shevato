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
//   bboost     the bench now: played once all four are likely to play and it
//              projects the bar, unless a week inside the projection horizon
//              is clearly better; never compared with weeks the projections do
//              not cover, whose estimates run high.
//   3xc        the extra captain copy now, against the best later week of the
//              same window, by a margin measured from how far such an estimate
//              moves before its week arrives.
//
// OPPORTUNITY COST (2026-09-17, registry entry 30). A one-time chip played now
// is worth what it adds now MINUS what keeping it is worth, and that net value,
// not the raw bench or captain points, is what planner.js adds to a chip plan's
// objective. Keeping a triple captain is worth its best later week; keeping a
// bench boost is worth at least its bar and at least the best near week less
// the margin a bench estimate moves by. Either way the net value is positive
// exactly when the chip's own decision says play, so a plan and its chip card
// cannot disagree.
// Until then a chip plan was credited with the whole bench (9.5 points) while a
// transfer plan was credited with nothing for keeping the chip, so no transfer
// could beat a bench boost and a suspended player stayed on the boosted bench.
//
// NOT BEFORE THE FIRST DEADLINE. While transfers are unlimited the fifteen is
// still being chosen at no cost, so a bench boost or triple captain plan would
// shape the opening squad around one week's bench or armband, on projections
// with no football of this season behind them; and the timing rules were
// measured from gameweek 2 (the replays build their opening squad as a draft,
// which plays no chip). Both hold with a reason until the squad is set.
//
// ONE WINDOW AT A TIME. Seasons from 2025-26 carry two of each chip, one per
// half. A first-half chip is compared only with first-half weeks: the second
// half has its own chip, so waiting for a second-half double is not an option
// the first-half chip has. And in the last week a bench boost or a triple
// captain can be played it is played rather than lost, because an expired chip
// is worth nothing and neither can be worth less than nothing; when both share a
// window's end, each is played early enough that neither is left without a week
// (dueChipsAt). A wildcard and a free hit are NOT forced: a rebuild on its last
// legal week can lose points, and in the chips-on replays of entry 30 forced
// ones realized from -55 to +47.

import { chipAvailableAt } from './rules.js';
import { isUnlimited, transferStateOf } from './transfer-state.js';
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
// Kept at 12 by entry 30: the bar is priced in hits (4 points each), which the
// projection scale does not move, and under analytic-2 the rebuild gain the
// evaluator reports is smaller, not larger (mean 4.8 against 7.1, at or above
// 12 at 9% of replay deadlines against 20%), so the recalibration made the bar
// harder to reach rather than easier. It is not played just because its window
// is ending (header).
const WILDCARD_HORIZON_THRESHOLD = 12;

// A free hit rents a squad for one gameweek. It has to beat both doing nothing
// and taking the hits, so the bar is one gameweek's worth of a badly broken
// squad: roughly two blanking players plus an unavailable one. Kept at 12 by
// entry 30 for the same reason: a one-week rental reaches it at 1.5% of replay
// deadlines under analytic-2 against 1.8% before, the blank weeks it exists for.
const FREE_HIT_THRESHOLD = 12;

// THE BENCH BOOST, measured (scripts/calibration/calibrate-chips.mjs, registry
// entries 30 and 33). Every deadline of nine chips-off planner replays (three
// seasons, three seeds, production regime, on the calendar as it was known at
// each deadline, entry 31) was recorded with what a boost would have added over
// auto-substitutions, and timing rules were scored on 108 chip windows with
// every fitted quantity held out by season, under analytic-2 and again under
// analytic-1.
//
//   BAR 8. What a bench projects predicts what a boost adds (r = 0.48), and
//   the bench is the one place the projection scale barely moved: the median
//   projected bench is 8.8 points under analytic-1 and 9.7 under analytic-2,
//   where the mean captain projection rose 16%. Bars from 6 to 11 decide
//   almost alike (5.9 to 6.1 points a window under analytic-2); 12 reads 6.8
//   there and 4.5 under analytic-1, and 13 collapses in both, so the bar was
//   not moved.
//
//   NO COMPARISON WITH WEEKS THE PROJECTIONS DO NOT COVER. The pre-entry-30 rule
//   played only when this week beat the best estimated week left in the
//   season; estimates that far out run high, the best of up to 30 of them
//   almost always beats a real week, and the chip slid to gameweek 38, where
//   auto-substitutions already recover most of a bench (3.3 points a window
//   under analytic-2, against 6.2 for playing the first legal week).
//
//   A LATER WEEK HAS TO BE CLEARLY BETTER. Inside the horizon a later week's
//   estimate is 1.7 points high on average and moves by 3.2 before the week
//   arrives (1,248 revisions), so waiting is chosen only for a week that beats
//   this one by more than both, 5.0 points: a double gameweek does, an
//   ordinary week does not. On the final fixture list, which knew every double
//   from the first deadline, the same measurement read 1.7 and 3.0 (4.7).
//   Requiring THIS week to beat later ones by a margin instead ("save on a tie")
//   drove the chip to the season's end in both models, so a tie is played.
const BENCH_BOOST_BAR = 8;
const BENCH_BOOST_HOLD_MARGIN = 5.0;

// THE TRIPLE CAPTAIN MARGIN, measured the same way. A captain's estimate for a
// week five to eight gameweeks away moves by 1.6 points (standard deviation,
// 1,056 revisions) before that week arrives, and by 1.9 for a week further out,
// the distance most of a window's weeks are at. This week has to beat the best
// week left in the window by 2.0 to be measurably better; inside that the two
// weeks are a tie and the chip is saved. Swept on the calendar as it was known:
// 1.5 and 2.0 realize 11.0 and 11.1 extra armband points a window under
// analytic-2 and 12.2 and 12.9 under analytic-1, where 1.0 realizes 9.6 and
// 10.3, and the margin chosen on the other seasons is 1.5, 2 and 2 under
// analytic-2 and 2, 2.5 and 2.5 under analytic-1. Entry 30 set 1.0 on the final
// fixture list, where later-week estimates moved by only 1.0: a list that knows
// every reschedule in advance never revises a captain's week for one.
const TRIPLE_CAPTAIN_MARGIN = 2.0;

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

// A bench player this unlikely to appear makes the bench not ready to boost
// (unchanged in value from the shipped BENCH_WEAK_P_APPEAR, now applied to the
// week being decided rather than charged only against later weeks). In the
// replays a boost added 3.9 points on a bench with such a player against 8.5
// once all four were likely to play. Playing the chip with him in a slot spends
// a whole chip on three players, while a transfer that sells him (planner.js,
// "THE BENCH REPAIR") or a later week keeps the fourth slot's value. General
// availability, not a rule about suspensions: injured, suspended, unavailable
// and unused players all fall under it through their projected appearance
// probability. The chips-off replays cannot sell the player, which is the
// point of the rule, so they read no threshold from 0.05 to 0.5 as better than
// none; the chips-on replays of entry 30 are its measurement.
const BENCH_USABLE_P_APPEAR = 0.5;

// WHICH bench players the availability condition applies to: 'all' four, or
// the three 'outfield' players, leaving a keeper who will not play to cost what
// he projects (nothing) rather than hold the chip. Set by registry entry 33.
const BENCH_BOOST_GATE = 'all';

export const CHIP_PARAMS = Object.freeze({
  wildcardHorizonThreshold: WILDCARD_HORIZON_THRESHOLD,
  freeHitThreshold: FREE_HIT_THRESHOLD,
  benchBoostBar: BENCH_BOOST_BAR,
  benchBoostHoldMargin: BENCH_BOOST_HOLD_MARGIN,
  tripleCaptainMargin: TRIPLE_CAPTAIN_MARGIN,
  chipPatiencePerGw: CHIP_PATIENCE_PER_GW,
  fdrSensitivity: FDR_SENSITIVITY,
  benchUsablePAppear: BENCH_USABLE_P_APPEAR,
  benchBoostGate: BENCH_BOOST_GATE,
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
    // TWO ARMBAND NUMBERS, AND THEY ARE NOT THE SAME.
    //
    // `captainExtra` is the captain's own expected points counted again. It is
    // what the OBJECTIVE below is built from, and it is deliberately left
    // alone: `squadObjective` in lineup.js is asserted bit-identical to this
    // total, and moving it moves every ranking.
    //
    // `xPointsCaptaincy` is what the armband is actually EXPECTED TO PAY: the
    // captain's points when he plays, and the vice's when he does not, which
    // is FPL's rule (scoreGameweek in backtest.js applies it). captain.js has
    // computed it, with a club-correlation factor, since it was written; the
    // reported gameweek total simply never used it.
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
      // The two components the REPORTED gameweek total needs and the objective
      // does not. Chip-agnostic on purpose: only the caller knows the chip, and
      // bench boost pays the bench INSTEAD of auto-substitutions rather than as
      // well as them.
      xPointsAutosubs: Number.isFinite(lineup.autosubValue) ? lineup.autosubValue : 0,
      xPointsCaptaincy: Number.isFinite(captaincy.xPointsCaptaincy)
        ? captaincy.xPointsCaptaincy
        : captainExtra,
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
export function estimateXp(projections, gameState, player, gw, gwFrom, horizon) {
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

// The unspent instance of a chip that `gw` falls in, as its gameweek range.
// Null when the chip cannot be played at `gw`.
export function chipWindowAt(rules, chipName, gw, chipsUsed = []) {
  const used = chipsUsed
    .map(c => (typeof c === 'string' ? { name: c, event: null } : c))
    .filter(c => c && c.name === chipName);
  for (const w of rules.chips.filter(c => c.name === chipName)) {
    if (gw < w.startEvent || gw > w.stopEvent) continue;
    const spent = used.some(u => u.event === null || (u.event >= w.startEvent && u.event <= w.stopEvent));
    if (!spent) return { from: w.startEvent, to: Math.min(w.stopEvent, rules.totalEvents) };
  }
  return null;
}

// The timing chips that have to be played now or be lost. Only one chip can be
// played a gameweek, so when as many unspent bench boosts and triple captains
// share a window's last gameweek as that window has weeks left (this one
// included), waiting a week loses one of them for certain, and each is due. In
// the first chips-on replays of entry 30 both reached the last week of 2025-26's
// first window unspent, and the triple captain expired behind the bench boost.
// The wildcard and the free hit do not count: they are never forced (header),
// and counting them pulled both timing chips into weeks worth 2 to 8 points.
const FORCED_CHIPS = ['bboost', '3xc'];

export function dueChipsAt(rules, gw, chipsUsed = []) {
  const byEnd = new Map();
  for (const name of FORCED_CHIPS) {
    const window = chipWindowAt(rules, name, gw, chipsUsed);
    if (!window) continue;
    if (!byEnd.has(window.to)) byEnd.set(window.to, []);
    byEnd.get(window.to).push(name);
  }
  const due = new Set();
  for (const [to, names] of byEnd) {
    if (names.length >= to - gw + 1) for (const name of names) due.add(name);
  }
  return due;
}

// No week left to wait for: the window ends this week, or the chips in hand
// need every week that is left.
function mustPlayNow(rules, chipName, window, gw, chipsUsed) {
  return laterWeeksInWindow(window, gw).length === 0 || dueChipsAt(rules, gw, chipsUsed).has(chipName);
}

// A Bench Boost held for a double gameweek (planner option `benchDoubleHold`,
// registry entry 34): in a window reaching this late in the season, where the
// cup clashes that make doubles fall, it waits for a week at least two clubs
// play twice. A seasonal pattern, not knowledge of any season's calendar.
const DOUBLES_FROM_GW = 30;

function doubledClubs(gameState, gw) {
  const matches = new Map();
  for (const f of (gameState && gameState.fixtures) || []) {
    if (f.event !== gw) continue;
    for (const club of [f.teamH, f.teamA]) matches.set(club, (matches.get(club) || 0) + 1);
  }
  let doubled = 0;
  for (const n of matches.values()) if (n >= 2) doubled++;
  return doubled;
}

// The later weeks the SAME chip instance can still be played in.
function laterWeeksInWindow(window, gw) {
  const out = [];
  if (!window) return out;
  for (let g = gw + 1; g <= window.to; g++) out.push(g);
  return out;
}

// Why a timing chip is played in a week it would otherwise wait past: its window
// ends now, or the timing chips still in hand need every week that is left of it.
function lastWeekReason(code, label, window, gw, consequence) {
  if (window.to === gw) {
    return makeReason(`${code}_last_week`, `Gameweek {v} is the last week this ${label} can be played, so ${consequence}.`, window.to, 'gw');
  }
  return makeReason(
    `${code}_last_week`,
    `Your Bench Boost and Triple Captain need every week left before this ${label}'s window closes after gameweek {v}, and only one chip can be played a week, so ${consequence}.`,
    window.to,
    'gw',
  );
}

function patience(gw, gwFrom) {
  return Math.pow(CHIP_PATIENCE_PER_GW, Math.max(0, gw - gwFrom));
}

// ---------------------------------------------------------------------------

// The lineup risk weights an evaluation was asked to score with, and nothing
// else, so a rebuilt or rented squad is played by the same rules as the squad
// it is compared with. Empty (the lineup defaults) unless a caller set them.
function lineupWeights(opts = {}) {
  const out = {};
  if (opts.riskAversion !== undefined) out.riskAversion = opts.riskAversion;
  if (opts.minutesRiskWeight !== undefined) out.minutesRiskWeight = opts.minutesRiskWeight;
  return out;
}

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
  const window = chipWindowAt(rules, 'wildcard', gw, chipsUsed);

  const budget = spendableTenths(squadState);
  const built = buildSquad({
    projections, gameState, rules, gw, horizon,
    budgetTenths: budget,
    opts: { discount, ...lineupWeights(ctx.opts) },
  });
  const rebuilt = squadTrajectory({
    squadIds: built.squad, projections, gameState, rules,
    gwFrom: gw, horizon, discount, opts: lineupWeights(ctx.opts),
  });
  const gain = rebuilt.total - baseline.total;
  const changes = built.squad.filter(id => !squadState.picks.some(p => p.playerId === id)).length;

  // The week the current squad is most broken, from the calendar alone: players
  // with no fixture, plus players who are already unavailable. Only weeks this
  // wildcard can still be played in.
  const structure = wildcardStructureScan(ctx, legalGws.filter(g => g <= window.to));
  const recommended = gain >= WILDCARD_HORIZON_THRESHOLD;

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
    recommended,
    excess: gain - WILDCARD_HORIZON_THRESHOLD,
    netValue: 0,
    window,
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
  const window = chipWindowAt(rules, 'freehit', gw, chipsUsed);

  const budget = spendableTenths(squadState);
  // A free hit is a one week rental, so it is optimized for one gameweek only.
  // Nothing about the horizon applies: the squad comes straight back afterwards.
  const built = buildSquad({
    projections, gameState, rules, gw,
    horizon: 1,
    budgetTenths: budget,
    opts: { singleGw: true, discount: 1, ...lineupWeights(ctx.opts) },
  });
  const rented = squadTrajectory({
    squadIds: built.squad, projections, gameState, rules, gwFrom: gw, horizon: 1, discount: 1, opts: lineupWeights(ctx.opts),
  });
  const gain = rented.total - baseline.gws[0].xPoints;

  // Where the free hit is classically worth most: the week the squad has the
  // fewest players with a fixture.
  const scan = freeHitScan(ctx, legalGws.filter(g => g <= window.to));
  const recommended = gain >= FREE_HIT_THRESHOLD;

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
    recommended,
    excess: gain - FREE_HIT_THRESHOLD,
    netValue: 0,
    window,
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

// The decision for one bench, exported because planner.js asks it of every
// squad it scores, not only the squad already owned: a bench boost on a squad
// that sells an unavailable bench player first is a different, and often
// better, plan than a bench boost on the squad as it stands.
//
//   valueNow        the bench's projected points this gameweek
//   bestGw/Value    the best later week of the same window INSIDE the
//                   projection horizon, with the same bench
//   status          opening    transfers are unlimited: the squad is not set yet
//                   last_week  the window ends this week: play rather than lose it
//                   unusable   a bench player is unlikely to play
//                   below_bar  the bench projects under BENCH_BOOST_BAR
//                   later      a week inside the horizon beats this one by
//                              more than BENCH_BOOST_HOLD_MARGIN
//                   play       otherwise
//   netValue        what the chip adds to a plan's objective: this week's bench
//                   less the least keeping the chip is worth, the larger of
//                   the bar and the best near week less the hold margin. It
//                   is above zero exactly when the status is play (and the
//                   whole bench in the last week), so the planner cannot play
//                   a boost its own rule holds, or hold one it plays by a tie
//                   of objectives; zero when not recommended
export function benchBoostDecision({
  benchIds, projections, gameState, rules, gw, horizon, chipsUsed = [], openingSquad = false, gate = BENCH_BOOST_GATE,
  holdForDoubles = false,
}) {
  const window = chipWindowAt(rules, 'bboost', gw, chipsUsed);
  if (!window) return null;
  const valueNow = benchIds.reduce((s, id) => s + xpOf(projections, id, gw), 0);
  const unusable = benchIds.filter((id) => {
    if (gate === 'outfield') {
      const player = gameState && gameState.players ? gameState.players.get(id) : null;
      if (player && player.position === 1) return false;
    }
    const row = projOf(projections, id, gw);
    return !row || !(row.pAppear >= BENCH_USABLE_P_APPEAR);
  });

  const later = laterWeeksInWindow(window, gw);
  const perGw = [];
  let bestGw = null;
  let bestValue = null;
  for (const g of later) {
    if (g >= gw + Math.max(1, horizon)) break;
    let value = 0;
    for (const id of benchIds) value += xpOf(projections, id, g);
    perGw.push({ gw: g, value });
    if (bestValue === null || value > bestValue) {
      bestValue = value;
      bestGw = g;
    }
  }

  const lastWeek = !openingSquad && mustPlayNow(rules, 'bboost', window, gw, chipsUsed);
  let status;
  if (openingSquad) status = 'opening';
  else if (lastWeek) status = valueNow > 0 ? 'last_week' : 'empty';
  else if (holdForDoubles && window.to >= DOUBLES_FROM_GW && doubledClubs(gameState, gw) < 2) status = 'awaiting_double';
  else if (unusable.length) status = 'unusable';
  // Both edges are drawn so that `play` is exactly the case where the net value
  // below is above zero: at the bar, or a later week exactly the margin better,
  // the chip is held rather than credited with nothing.
  else if (valueNow <= BENCH_BOOST_BAR) status = 'below_bar';
  else if (bestValue !== null && bestValue - valueNow >= BENCH_BOOST_HOLD_MARGIN) status = 'later';
  else status = 'play';
  const recommended = status === 'play' || status === 'last_week';
  const keepValue = lastWeek ? 0 : Math.max(BENCH_BOOST_BAR, bestValue === null ? 0 : bestValue - BENCH_BOOST_HOLD_MARGIN);
  const advantage = valueNow - keepValue;

  return {
    gw, window, gate, bench: benchIds.slice(), valueNow, unusable, perGw, bestGw, bestValue,
    lastWeek, keepValue, advantage, bar: BENCH_BOOST_BAR, margin: BENCH_BOOST_HOLD_MARGIN,
    status, recommended,
    netValue: recommended ? Math.max(0, advantage) : 0,
  };
}

export function benchBoostReasons(d, gameState) {
  const reasons = [makeReason('bboost_value_now', 'Your bench projects {v} points this gameweek.', d.valueNow)];
  if (d.lastWeek) {
    reasons.push(lastWeekReason('bboost', 'Bench Boost', d.window, d.gw, 'it is played rather than lost'));
    return reasons;
  }
  reasons.push(makeReason(
    'bboost_threshold',
    `A Bench Boost is played once the bench projects more than {v} points with ${d.gate === 'outfield' ? 'its three outfield players' : 'all four players'} likely to play.`,
    d.bar,
  ));
  if (d.status === 'unusable') {
    reasons.push(makeReason(
      'bboost_unusable',
      `{v} of your bench ${d.unusable.length === 1 ? 'players is' : 'players are'} unlikely to play (${d.unusable.map(id => playerName(gameState, id)).join(', ')}), so the bench is not ready to boost.`,
      d.unusable.length,
      'count',
    ));
  }
  if (d.bestGw !== null) {
    reasons.push(makeReason(
      'bboost_best_future',
      `The best of the next few gameweeks for it is gameweek ${d.bestGw}, worth {v} points.`,
      d.bestValue,
    ));
    if (d.status === 'play') {
      reasons.push(makeReason(
        'bboost_margin',
        `A later week has to beat this one by {v} points or more before waiting pays, because a bench estimate moves that much before its week arrives, so this week is played.`,
        d.margin,
      ));
    } else if (d.status === 'later') {
      reasons.push(makeReason(
        'bboost_later',
        `Gameweek ${d.bestGw} beats this week by at least the {v} points a bench estimate moves, so the chip waits for it.`,
        d.margin,
      ));
    }
  }
  return reasons;
}

function benchBoostHoldReason(d) {
  if (d.status === 'opening') return openingHoldReason('hold_bboost', 'Bench Boost', d.gw);
  if (d.status === 'awaiting_double') {
    return makeReason('hold_bboost', 'No double gameweek is on the calendar this week, so the Bench Boost is kept for one before gameweek {v}.', d.window.to, 'gw');
  }
  if (d.status === 'unusable') {
    return makeReason('hold_bboost', 'Your bench has {v} player unlikely to play, so a Bench Boost waits until the bench is repaired.', d.unusable.length, 'count');
  }
  if (d.status === 'below_bar') {
    return makeReason(
      'hold_bboost',
      `Your bench projects {v} points this gameweek, not above the ${fmtValue(d.bar, 'points')} a Bench Boost needs.`,
      d.valueNow,
    );
  }
  return makeReason(
    'hold_bboost',
    `Your bench projects {v} points this gameweek, and gameweek ${d.bestGw} projects ${fmtValue(d.bestValue, 'points')}, so the chip is worth more then.`,
    d.valueNow,
  );
}

function evaluateBenchBoost(ctx) {
  const { projections, gameState, rules, gw, horizon, baseline, chipsUsed } = ctx;
  const legalGws = legalGwsForChip(rules, 'bboost', gw, chipsUsed);
  if (!chipAvailableAt(rules, 'bboost', gw, chipsUsed)) {
    return notAvailable('bboost', legalGws, gw, []);
  }
  const now = baseline.gws[0];
  const benchIds = [now.bench.gk, ...now.bench.order];
  const d = benchBoostDecision({
    benchIds, projections, gameState, rules, gw, horizon, chipsUsed, openingSquad: ctx.openingSquad,
    ...(ctx.opts && ctx.opts.benchGate ? { gate: ctx.opts.benchGate } : {}),
    ...(ctx.opts && ctx.opts.benchDoubleHold ? { holdForDoubles: true } : {}),
  });
  return chipEntry('bboost', d, legalGws, benchBoostReasons(d, gameState), benchBoostHoldReason(d), {
    bench: benchIds, unusable: d.unusable, perGw: d.perGw,
  });
}

// The per-chip entry for a decision planner.js took on a squad other than the
// one the evaluation was run for, so the card and the explanation describe the
// chip the plan actually plays.
export function timingChipEntry(chip, decision, { rules, gw, chipsUsed = [], gameState }) {
  const legalGws = legalGwsForChip(rules, chip, gw, chipsUsed);
  if (chip === 'bboost') {
    return chipEntry('bboost', decision, legalGws, benchBoostReasons(decision, gameState), benchBoostHoldReason(decision), {
      bench: decision.bench, unusable: decision.unusable, perGw: decision.perGw,
    });
  }
  return chipEntry('3xc', decision, legalGws, tripleCaptainReasons(decision, gameState), null, {
    captain: decision.captain, bestPlayer: decision.bestPlayer, perGw: decision.perGw,
  });
}

// One shape for every timing chip, so planner.js and the explanation layer read
// bench boost and triple captain the same way.
function chipEntry(chip, d, legalGws, reasons, holdReason, detail) {
  return {
    chip,
    available: true,
    valueNow: d.valueNow,
    // The bar a reader compares valueNow with: the bench boost's absolute bar,
    // the triple captain's margin over the best week left.
    threshold: chip === 'bboost' ? d.bar : d.margin,
    margin: d.margin,
    advantage: d.advantage,
    status: d.status,
    lastWeek: d.lastWeek,
    window: d.window,
    recommended: d.recommended,
    excess: d.lastWeek ? d.valueNow : (chip === 'bboost' ? d.advantage : d.advantage - d.margin),
    netValue: d.netValue,
    holdReason,
    bestGw: d.bestGw,
    bestValue: d.bestValue,
    nextLegalGw: legalGws.length ? legalGws[0] : null,
    detail,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Triple captain
// ---------------------------------------------------------------------------

// The same timing decision for the armband. valueNow is one more copy of the
// captain's projection; a later week's value is the best projection in the
// squad that week, over the same window.
//
// KNOWN UNDER-STATEMENT, left alone on purpose (registry entry 25). The extra
// copy is really worth `xPointsCaptaincy`, the captain when he plays and the
// VICE when he does not. Entry 25 measured the correction as inert under the
// old margin; entry 30 re-measured it under the new one (see there).
export function tripleCaptainDecision({ squadIds, captainId, captainXp, projections, gameState, rules, gw, horizon, chipsUsed = [], openingSquad = false }) {
  const window = chipWindowAt(rules, '3xc', gw, chipsUsed);
  if (!window) return null;
  const valueNow = captainXp;
  const perGw = [];
  let bestGw = null;
  let bestValue = null;
  let bestPlayer = null;
  for (const g of laterWeeksInWindow(window, gw)) {
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
    if (bestValue === null || discounted > bestValue) {
      bestValue = discounted;
      bestGw = g;
      bestPlayer = topId;
    }
  }
  const lastWeek = !openingSquad && mustPlayNow(rules, '3xc', window, gw, chipsUsed);
  const advantage = valueNow - (lastWeek || bestValue === null ? 0 : bestValue);
  let status;
  if (openingSquad) status = 'opening';
  else if (lastWeek) status = valueNow > 0 ? 'last_week' : 'empty';
  else if (advantage >= TRIPLE_CAPTAIN_MARGIN) status = 'play';
  else if (advantage > -TRIPLE_CAPTAIN_MARGIN) status = 'tied';
  else status = 'later';
  const recommended = status === 'play' || status === 'last_week';
  return {
    gw, window, captain: captainId, valueNow, perGw, bestGw, bestValue, bestPlayer,
    lastWeek, advantage, margin: TRIPLE_CAPTAIN_MARGIN, status, recommended,
    netValue: recommended ? advantage : 0,
  };
}

export function tripleCaptainReasons(d, gameState) {
  const captainName = playerName(gameState, d.captain);
  const reasons = [makeReason('3xc_value_now', `Tripling ${captainName} this gameweek adds {v} points.`, d.valueNow)];
  if (d.lastWeek) {
    reasons.push(lastWeekReason('3xc', 'Triple Captain', d.window, d.gw, 'it is played rather than lost'));
    return reasons;
  }
  reasons.push(makeReason('3xc_margin', 'The chip is only spent when this week beats the best week left by {v} points, because it cannot be won back.', d.margin));
  reasons.push(makeReason(
    '3xc_best_future',
    `Your best remaining triple captain week looks like gameweek ${d.bestGw}${d.bestPlayer ? ` with ${playerName(gameState, d.bestPlayer)}` : ''}, worth {v} points.`,
    d.bestValue,
  ));
  if (d.status === 'tied') {
    reasons.push(makeReason(
      '3xc_tied',
      `This week and gameweek ${d.bestGw} are {v} points apart, inside the margin, so the chip is saved rather than spent on a coin flip.`,
      Math.abs(d.advantage),
    ));
  }
  return reasons;
}

function evaluateTripleCaptain(ctx) {
  const { squadState, projections, gameState, rules, gw, horizon, baseline, chipsUsed } = ctx;
  const legalGws = legalGwsForChip(rules, '3xc', gw, chipsUsed);
  if (!chipAvailableAt(rules, '3xc', gw, chipsUsed)) {
    return notAvailable('3xc', legalGws, gw, []);
  }
  const now = baseline.gws[0];
  const d = tripleCaptainDecision({
    squadIds: squadState.picks.map(p => p.playerId), captainId: now.captain, captainXp: now.captainExtra,
    projections, gameState, rules, gw, horizon, chipsUsed, openingSquad: ctx.openingSquad,
  });
  const captainName = playerName(gameState, now.captain);
  // The triple captain's bar is a MARGIN over the best week left, not an
  // absolute number of points, so the hold sentence names the week it is kept
  // for.
  const holdReason = d.status === 'opening' ? openingHoldReason('hold_3xc', 'Triple Captain', gw) : makeReason(
    'hold_3xc',
    `Tripling ${captainName} adds {v} points this gameweek, and the best week left is worth ${fmtValue(d.bestValue, 'points')}, so it does not clear it by the ${fmtValue(d.margin, 'points')} the chip needs.`,
    d.valueNow,
  );
  return chipEntry('3xc', d, legalGws, tripleCaptainReasons(d, gameState), holdReason, {
    captain: now.captain, bestPlayer: d.bestPlayer, perGw: d.perGw,
  });
}

// A timing chip held because the squad it would be played on is not set yet.
export function openingHoldReason(code, label, gw) {
  return makeReason(
    code,
    `Transfers are unlimited until the gameweek {v} deadline, so your fifteen is still being chosen; a ${label} is judged once it is set.`,
    gw,
    'gw',
  );
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
    excess: null,
    netValue: 0,
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

  const openingSquad = isUnlimited(transferStateOf(squadState, rules));
  const ctx = { squadState, projections, gameState, rules, gw, horizon, discount, baseline, chipsUsed, opts, openingSquad };

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
    const margin = entry.excess;
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
export function holdReasons(perChip, gw) {
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
    // absolute gain for the wildcard and the free hit, a margin over the best
    // later week of the window for the bench boost and the triple captain. One
    // shared sentence for all four would have to state at least one wrongly.
    if (entry.holdReason) reasons.push(entry.holdReason);
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
