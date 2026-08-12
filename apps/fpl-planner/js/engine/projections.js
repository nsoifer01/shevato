// Position-specific expected points.
//
// A single regression over every player cannot represent a goalkeeper's saves
// and a forward's expected goals at the same time, so this builds points from
// components and lets the position decide which components exist. Every points
// coefficient comes from `rules.scoring`, which is read from the live payload,
// so a scoring change upstream needs no edit here.
//
// The shape of a projection:
//
//   1. MINUTES. minutes.js gives pStart, pAppear and the typical starter and
//      substitute minutes. Those become four mutually exclusive branches
//      (start and reach the hour, start and do not, come on and reach the hour,
//      come on and do not) plus the fifth case of not playing at all.
//   2. RATES. Per-90 underlying rates, recency weighted when per-gameweek
//      history is attached and taken from season totals otherwise, then shrunk
//      toward the position's league rate by how much football is behind them.
//      Attacking rates come from expected goals and expected assists, NEVER
//      from goals and assists scored, and never from FPL points: two players
//      with the same underlying numbers and different recent luck must project
//      the same.
//   3. FIXTURE. The Poisson fixture model scales those rates. A club expected
//      to score 2.4 in this fixture against a baseline of 1.6 lifts its
//      attackers by 1.5x; the same club's keeper faces the opponent expectation
//      instead.
//   4. DISTRIBUTION. Inside each branch every component is turned into an exact
//      discrete distribution over integer points and convolved together. The
//      branches are then mixed, and the fixtures of a double gameweek are
//      convolved. `xPoints`, `sd` and `ceiling` are the mean, standard
//      deviation and 85th percentile of THAT distribution, not a mean with
//      invented multipliers hung off it.
//
// A blank gameweek has no fixtures, so the mixture is empty and xPoints is 0. A
// double gameweek convolves both fixtures, so xPoints is their sum. Neither is
// a special case in the code.

import { fixtureContext, baselineTeamGoals, baselineOpponentGoals } from './fixtures.js';
import { projectMinutes, p60FromMeanMinutes } from './minutes.js';
import {
  poissonVector,
  poissonTail,
  calibrate,
  calibratorFromJSON,
  distPoint,
  distConvolve,
  distMix,
  distMean,
  distVariance,
  distQuantile,
} from './ml.js';

// --- Scoring divisors the API does not publish -----------------------------
//
// `game_config.scoring` gives `saves: 1` and `goals_conceded: -1` but not the
// counts those apply to. The official rules are 1 point per 3 saves and -1 per
// 2 goals conceded. They are read off the Rules object when it carries them and
// fall back to these documented constants otherwise, exactly like the
// defensive-contribution thresholds rules.js owns.
const SAVES_PER_POINT = 3;
const CONCEDED_PER_PENALTY = 2;

// --- Model parameters ------------------------------------------------------

// Recency half life in gameweeks for underlying rates, used when a caller has
// attached per-gameweek history to the player. Shorter than the strength
// model's half life because form in underlying numbers moves faster than club
// quality does.
const RECENCY_HALF_LIFE_GWS = 6;


// Minutes assigned to the "started but did not reach the hour" branch. The
// over-60 branch is then solved so that the branch-weighted mean minutes match
// the minutes model, which keeps the distribution and xMins consistent.
const START_UNDER_60_MINUTES = 40;
const SUB_OVER_60_MINUTES = 68;

// Set-piece and penalty duty premium, applied multiplicatively to the expected
// goal and expected assist rates by duty order (first, second, third choice).
// Deliberately modest: an incumbent taker's last-season expected goals ALREADY
// contain their penalties, so a large additive term would double count. The
// premium exists to separate a newly appointed taker from the player who lost
// the job, and to break ties between otherwise identical players.
const PENALTY_ORDER_BOOST = [0.10, 0.05, 0.02];
const FREEKICK_ORDER_BOOST = [0.06, 0.03, 0.01];
const CORNER_ORDER_BOOST = [0.08, 0.04, 0.015];

// Bonus points track team performance, but only about half as strongly as goals
// do, because bonus is a within-match ranking and a whole team playing well
// raises everyone's basis for comparison.
const BONUS_FIXTURE_SENSITIVITY = 0.5;

// Fallback for the bonus curve when the payload has too few players with real
// minutes to fit one (which happens only in tests). Measured from the live
// population: bonus per 90 rises roughly linearly above a floor of 7 BPS per 90.
const BONUS_BPS_FLOOR = 7;
const BONUS_PER_BPS = 0.035;
const BONUS_MODEL_MIN_MINUTES = 450;
const BONUS_MODEL_BINS = 12;
const MAX_BONUS_PER_MATCH = 3;

// --- Small-sample shrinkage of the per-90 rates -----------------------------
//
// A per-90 rate is a total divided by nineties, and with two minutes on the
// board that division is not an estimate, it is an extrapolation. Every rate is
// therefore an empirical-Bayes posterior rather than a raw ratio:
//
//   shrunk = (own total + prior rate * k) / (own nineties + k)
//
// which is "credit the player with k nineties of league-average play before
// reading his own". A player with 2000 minutes is untouched. A player with two
// is the prior. There is no threshold anywhere, and no special case for a player
// with no minutes: he has zero nineties, so he IS the prior.
//
// The prior is the POSITION'S league rate, measured from the same payload
// bonusModel and positionPriors are measured from, so it re-fits itself every
// season and needs no constant. It is minutes-weighted (the position's summed
// totals over its summed nineties) rather than a mean of per-player rates, and
// that matters exactly where the noise is: a cameo contributes its two minutes
// to both sides of a minutes-weighted ratio, so it cannot distort the population
// the way it distorts its own rate. On a live payload the two definitions agree
// on expected goals and differ by a factor of two on BPS, and the factor of two
// is the cameos.
//
// k is the sample size, in nineties, at which a player's own evidence and the
// prior deserve equal weight. It is DERIVED, not chosen. Model a count with n
// nineties behind it as quasi-Poisson (mean mu*n, variance phi*mu*n) with the
// true rates spread across players with mean m and variance tau^2; the posterior
// mean is the expression above with
//
//   k = phi * m / tau^2
//
// phi is the within-player dispersion of a player's gameweeks around his own
// season rate, m is the pooled rate, and tau^2 is the minutes-weighted spread of
// observed season rates minus the sampling variance phi implies. All three were
// measured over 2022-23, 2023-24 and 2024-25 (1686 player-seasons with minutes;
// defensive contribution over 2025-26, the only archive carrying it), minimum
// sample 10 nineties. The table below is that measurement.
//
// Three things it says. Position matters and not in the obvious direction: a
// defender's expected goals gets k = 17.7 because defenders are nearly identical
// to each other, while a midfielder's gets 3.7 because midfielders genuinely
// differ. BPS is the noisiest quantity in the projection, with a forward's
// dispersion at 21.2. And cards and penalty saves have NO measurable
// between-player signal at all: tau^2 comes out at or below zero for every red
// card row, for penalty saves and for a forward's yellows, so on this evidence
// no player's card rate is distinguishable from his position's.
//
// PRIOR_NINETIES_MAX is both the cap and the default. Any (rate, position) pair
// with no measurable between-player variance gets it, which is the prior in all
// but name, and it is what a goalkeeper's expected goals (k = 1122) collapses to.
const PRIOR_NINETIES_MAX = 200;
const PRIOR_NINETIES = {
  xG: { 2: 17.7, 3: 3.7, 4: 8.0 },
  xA: { 1: 10.4, 2: 4.9, 3: 5.3, 4: 9.7 },
  bps: { 1: 9.9, 2: 11.7, 3: 19.0, 4: 23.9 },
  saves: { 1: 10.0 },
  defCon: { 2: 4.6, 3: 2.7, 4: 6.9 },
  yellow: { 2: 148.8, 3: 53.8 },
  red: {},
  pensSaved: {},
};
const SHRUNK_RATES = Object.keys(PRIOR_NINETIES);

// The ceiling is the 85th percentile of the composed distribution.
const CEILING_QUANTILE = 0.85;

// Count truncation for the component distributions. Beyond mean plus three
// standard deviations the probability mass is worth less than a hundredth of a
// point and only costs convolution time.
const MAX_COUNT_CAP = 8;

export const PROJECTION_PARAMS = Object.freeze({
  savesPerPoint: SAVES_PER_POINT,
  concededPerPenalty: CONCEDED_PER_PENALTY,
  recencyHalfLifeGws: RECENCY_HALF_LIFE_GWS,
  penaltyOrderBoost: PENALTY_ORDER_BOOST,
  freekickOrderBoost: FREEKICK_ORDER_BOOST,
  cornerOrderBoost: CORNER_ORDER_BOOST,
  bonusFixtureSensitivity: BONUS_FIXTURE_SENSITIVITY,
  ceilingQuantile: CEILING_QUANTILE,
  priorNinetiesMax: PRIOR_NINETIES_MAX,
  priorNineties: PRIOR_NINETIES,
});

// What a ProjectionSet reports when no trained artifact was passed in. Exported
// so the fallback has one name, and so a test can tell "the trained model ran"
// from "it did not" without matching a string in two places.
export const DEFAULT_MODEL_VERSION = 'analytic-1';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Scoring access
// ---------------------------------------------------------------------------

// rules.js keys per-position scoring maps by BOTH short name and numeric
// position id, and leaves scalars alone. This reads either.
function scoreValue(rules, key, position) {
  const v = rules.scoring[key];
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v;
  const byId = v[position];
  return typeof byId === 'number' ? byId : 0;
}

function savesPerPoint(rules) {
  return rules.savesPerPoint || SAVES_PER_POINT;
}

function concededPerPenalty(rules) {
  return rules.concededPerPenalty || CONCEDED_PER_PENALTY;
}

// ---------------------------------------------------------------------------
// Defensive contribution
//
// The per-position stat definition, verified against live payloads: a defender
// needs clearances, blocks, interceptions and tackles; a midfielder or forward
// adds ball recoveries; a goalkeeper cannot earn it at all. The threshold comes
// from rules.defConThresholds and is never written here.
// ---------------------------------------------------------------------------

export function defConComposite(player) {
  const cbit = player.cbit || 0;
  const tackles = player.tackles || 0;
  const recoveries = player.recoveries || 0;
  if (player.position === 2) return cbit + tackles;
  if (player.position === 3 || player.position === 4) return cbit + recoveries + tackles;
  return 0;
}

// ---------------------------------------------------------------------------
// Underlying rates
//
// Per-90 rates for everything the point components need. When a caller has
// attached `player.history` (per-gameweek rows from element-summary) the rates
// are exponentially recency weighted over gameweeks strictly BEFORE the one
// being projected. Otherwise they come from season totals.
//
// Nothing in here reads total points, form, points per game, event points or
// expected points. That is the point: recent scoring luck must not move a
// projection, only recent underlying numbers may.
// ---------------------------------------------------------------------------

export function underlyingRates(player, { gw, halfLife = RECENCY_HALF_LIFE_GWS } = {}) {
  const history = Array.isArray(player.history) ? player.history : null;
  if (history && history.length) {
    const rows = history.filter(h => gw === undefined || h.gw === undefined || h.gw < gw);
    if (rows.length) {
      const latest = rows.reduce((m, r) => Math.max(m, r.gw === undefined ? 0 : r.gw), 0);
      const acc = {
        minutes: 0, xG: 0, xA: 0, bps: 0, saves: 0, defCon: 0,
        yellow: 0, red: 0, pensSaved: 0,
      };
      for (const r of rows) {
        const age = r.gw === undefined ? 0 : latest - r.gw;
        const w = Math.pow(0.5, age / halfLife);
        acc.minutes += w * (r.minutes || 0);
        acc.xG += w * (r.xG || 0);
        acc.xA += w * (r.xA || 0);
        acc.bps += w * (r.bps || 0);
        acc.saves += w * (r.saves || 0);
        acc.defCon += w * defConComposite({ ...r, position: player.position });
        acc.yellow += w * (r.yellowCards || 0);
        acc.red += w * (r.redCards || 0);
        acc.pensSaved += w * (r.penaltiesSaved || 0);
      }
      if (acc.minutes > 0) return ratesFrom(acc, acc.minutes, 'history');
    }
  }

  const minutes = player.minutes || 0;
  if (minutes <= 0) {
    return {
      source: 'none',
      nineties: 0,
      xNineties: 0,
      xG: 0, xA: 0, bps: 0, saves: 0, defCon: 0, yellow: 0, red: 0, pensSaved: 0,
    };
  }
  // xG and xA may cover fewer minutes than the rest of the totals: the archive
  // introduced the expected_* columns mid-2022-23, so a replay of that season
  // accumulates xG only from gameweek 16 while minutes run from gameweek 1. A
  // caller in that position declares `xMinutes` (see gameStateAt), and the two
  // attacking rates are read over it, with their own evidence weight. A live
  // payload never sets the field: FPL's totals and minutes always cover the
  // same rows, so the fallback is the identity.
  const xMinutes = Number.isFinite(player.xMinutes) ? player.xMinutes : minutes;
  return ratesFrom({
    xG: player.xG,
    xA: player.xA,
    bps: player.bps,
    saves: player.saves,
    defCon: defConComposite(player),
    yellow: player.yellowCards,
    red: player.redCards,
    pensSaved: player.penaltiesSaved,
  }, minutes, 'season', { xMinutes });
}

function ratesFrom(totals, minutes, source, { xMinutes = minutes } = {}) {
  const nineties = minutes / 90;
  const xNineties = xMinutes / 90;
  const per = (v) => (v || 0) / nineties;
  // Zero covered minutes means zero xG EVIDENCE, not a zero xG rate: the rate
  // is reported as 0 with xNineties 0 and the shrinkage layer resolves it to
  // the position prior, exactly as it does for a player with no minutes at all.
  const perX = (v) => (xNineties > 0 ? (v || 0) / xNineties : 0);
  return {
    source,
    nineties,
    xNineties,
    xG: perX(totals.xG),
    xA: perX(totals.xA),
    bps: per(totals.bps),
    saves: per(totals.saves),
    defCon: per(totals.defCon),
    yellow: per(totals.yellow),
    red: per(totals.red),
    pensSaved: per(totals.pensSaved),
  };
}

// ---------------------------------------------------------------------------
// The population every rate is shrunk toward.
//
// Minutes-weighted per-position league rates, read off the same payload as the
// bonus curve and the start-rate priors, and cached per GameState because the
// projection loop asks for it once per player per gameweek.
// ---------------------------------------------------------------------------

const ratePriorCache = new WeakMap();

export function positionRatePriors(gameState) {
  const cached = ratePriorCache.get(gameState);
  if (cached) return cached;

  const byPosition = new Map();
  for (const p of gameState.players.values()) {
    if (!(p.minutes > 0)) continue;
    if (!byPosition.has(p.position)) {
      byPosition.set(p.position, {
        nineties: 0,
        totals: { xG: 0, xA: 0, bps: 0, saves: 0, defCon: 0, yellow: 0, red: 0, pensSaved: 0 },
      });
    }
    const row = byPosition.get(p.position);
    row.nineties += p.minutes / 90;
    row.totals.xG += p.xG || 0;
    row.totals.xA += p.xA || 0;
    row.totals.bps += p.bps || 0;
    row.totals.saves += p.saves || 0;
    row.totals.defCon += defConComposite(p);
    row.totals.yellow += p.yellowCards || 0;
    row.totals.red += p.redCards || 0;
    row.totals.pensSaved += p.penaltiesSaved || 0;
  }

  const rates = new Map();
  for (const [position, row] of byPosition) {
    const out = {};
    for (const key of SHRUNK_RATES) out[key] = row.nineties > 0 ? row.totals[key] / row.nineties : 0;
    rates.set(position, out);
  }

  // A position with nobody who has played has no measurable rate, and zero is
  // the honest prior for it rather than an invented one. This happens only on a
  // payload with a handful of players, which means tests.
  const empty = Object.fromEntries(SHRUNK_RATES.map(k => [k, 0]));
  const model = {
    rateFor(position) { return rates.get(position) || empty; },
    positions: rates,
  };
  ratePriorCache.set(gameState, model);
  return model;
}

export function priorNinetiesFor(rate, position) {
  const byPosition = PRIOR_NINETIES[rate];
  const k = byPosition && byPosition[position];
  return Math.min(PRIOR_NINETIES_MAX, k === undefined ? PRIOR_NINETIES_MAX : k);
}

// The empirical-Bayes step, as its own function so the raw per-90 division and
// the posterior stay separately readable and separately testable. `rates` is
// whatever underlyingRates returned, so `nineties` is the same n the rate was
// divided by, and the identity total = rate * n recovers the numerator.
export function shrinkRates(rates, { position, priors }) {
  const prior = priors.rateFor(position);
  const out = { ...rates, shrunk: true };
  for (const key of SHRUNK_RATES) {
    const k = priorNinetiesFor(key, position);
    // The evidence behind a rate is the nineties its own numerator covers,
    // which for xG and xA can be fewer than the player's total nineties (the
    // archive's expected_* columns arrive mid-2022-23). Everywhere else the
    // two are the same number.
    const n = (key === 'xG' || key === 'xA') && Number.isFinite(rates.xNineties)
      ? rates.xNineties
      : rates.nineties;
    out[key] = (rates[key] * n + prior[key] * k) / (n + k);
  }
  return out;
}

function setPieceMultipliers(player) {
  const sp = player.setPieces || {};
  const boost = (order, table) => {
    if (order === null || order === undefined) return 0;
    const idx = Math.round(order) - 1;
    return idx >= 0 && idx < table.length ? table[idx] : 0;
  };
  const pen = boost(sp.penaltiesOrder, PENALTY_ORDER_BOOST);
  const fk = boost(sp.directFreekicksOrder, FREEKICK_ORDER_BOOST);
  const corner = boost(sp.cornersOrder, CORNER_ORDER_BOOST);
  return {
    goals: 1 + pen + fk,
    // A free-kick taker creates from the same dead balls a corner taker does,
    // so half of the free-kick premium lands on assists too.
    assists: 1 + corner + fk / 2,
  };
}

// ---------------------------------------------------------------------------
// Bonus model
//
// Bonus is driven by the BPS ranking inside a match, so it is projected from a
// player's BPS rate rather than from the bonus they happened to collect. The
// mapping from BPS per 90 to bonus per 90 is FITTED FROM THE LEAGUE by isotonic
// binning, which means it needs no invented constants and re-fits itself every
// season from whatever the payload says.
// ---------------------------------------------------------------------------

const bonusCache = new WeakMap();

// CLOSED, DO NOT REOPEN WITH MORE REPLAYS: fitting this curve on shrunk
// inputs (so fit and query share one space) was measured twice on the deciding
// instrument - +6.6 a window on 15 windows (entry 13, inconclusive), then
// -0.7 a window with 2025-26 held out voting -17.3 (entry 16, REJECT under a
// pre-registered standard). The raw-x fit's regression dilution and the
// query's shrinkage genuinely offset, by season-dependent amounts, and the
// held-out season showed the raw fit already over-reading its top. Only a NEW
// mechanism may reopen bonus; registry entries 13 and 16 are the record.
export function bonusModel(gameState) {
  const cached = bonusCache.get(gameState);
  if (cached) return cached;

  const bps = [];
  const bonus = [];
  for (const p of gameState.players.values()) {
    if (p.minutes < BONUS_MODEL_MIN_MINUTES) continue;
    const nineties = p.minutes / 90;
    bps.push(p.bps / nineties);
    bonus.push(p.bonus / nineties);
  }

  let predict;
  if (bps.length >= BONUS_MODEL_BINS * 3) {
    const fitted = calibrate(bps, bonus, 'bins', { bins: BONUS_MODEL_BINS });
    predict = (rate) => Math.max(0, fitted.predict(rate));
  } else {
    predict = (rate) => Math.max(0, (rate - BONUS_BPS_FLOOR) * BONUS_PER_BPS);
  }

  const model = { predict, fitted: bps.length >= BONUS_MODEL_BINS * 3, n: bps.length };
  bonusCache.set(gameState, model);
  return model;
}

// ---------------------------------------------------------------------------
// Discrete component distributions
// ---------------------------------------------------------------------------

function adaptiveMaxK(lambda) {
  if (!(lambda > 0)) return 0;
  return Math.min(MAX_COUNT_CAP, Math.max(1, Math.ceil(lambda + 3 * Math.sqrt(lambda) + 1)));
}

// Build a dense distribution from (integer value, probability) pairs.
function distFromValues(pairs) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [value] of pairs) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (!Number.isFinite(lo)) return distPoint(0);
  const p = new Array(hi - lo + 1).fill(0);
  for (const [value, prob] of pairs) p[value - lo] += prob;
  return { offset: lo, p };
}

// A Poisson count worth `pointsPer` points each.
function countPointsDist(lambda, pointsPer) {
  if (!pointsPer || !(lambda > 0)) return distPoint(0);
  const maxK = adaptiveMaxK(lambda);
  const pmf = poissonVector(lambda, maxK);
  return distFromValues(pmf.map((prob, k) => [k * pointsPer, prob]));
}

// A Poisson count worth `pointsPer` points per completed group of `divisor`.
function groupedCountPointsDist(lambda, pointsPer, divisor) {
  if (!pointsPer || !(lambda > 0)) return distPoint(0);
  const maxK = adaptiveMaxK(lambda);
  const pmf = poissonVector(lambda, maxK);
  return distFromValues(pmf.map((prob, k) => [Math.floor(k / divisor) * pointsPer, prob]));
}

// Clean sheet and the concession penalty come from the SAME goals-conceded
// count, so they are built together rather than as two independent draws. A
// keeper cannot both keep a clean sheet and lose two points for conceding.
function concessionDist(lambda, { csPoints, concededPoints, divisor, over60 }) {
  if (!csPoints && !concededPoints) return distPoint(0);
  const maxK = adaptiveMaxK(lambda) || 1;
  const pmf = poissonVector(lambda, maxK);
  return distFromValues(pmf.map((prob, k) => {
    const cs = k === 0 && over60 ? csPoints : 0;
    const conceded = concededPoints ? Math.floor(k / divisor) * concededPoints : 0;
    return [cs + conceded, prob];
  }));
}

function bernoulliPointsDist(prob, points) {
  if (!points || prob <= 0) return distPoint(0);
  const p = clamp(prob, 0, 1);
  return distFromValues([[0, 1 - p], [points, p]]);
}

// ---------------------------------------------------------------------------
// Minutes branches
// ---------------------------------------------------------------------------

function minuteBranches(mins) {
  const branches = [];
  const pSub = Math.max(0, mins.pAppear - mins.pStart);

  if (mins.pStart > 0) {
    const p60 = p60FromMeanMinutes(mins.meanStarterMinutes);
    const under = START_UNDER_60_MINUTES;
    // Solve the over-60 minutes so the branch mean matches the minutes model.
    const over = clamp(
      p60 > 1e-9 ? (mins.meanStarterMinutes - (1 - p60) * under) / p60 : 90,
      60,
      90,
    );
    if (p60 > 0) branches.push({ weight: mins.pStart * p60, minutes: over, over60: true });
    if (p60 < 1) branches.push({ weight: mins.pStart * (1 - p60), minutes: under, over60: false });
  }

  if (pSub > 0) {
    const p60 = p60FromMeanMinutes(mins.meanSubMinutes);
    const over = SUB_OVER_60_MINUTES;
    const under = clamp(
      p60 < 1 - 1e-9 ? (mins.meanSubMinutes - p60 * over) / (1 - p60) : 1,
      1,
      59,
    );
    if (p60 > 0) branches.push({ weight: pSub * p60, minutes: over, over60: true });
    if (p60 < 1) branches.push({ weight: pSub * (1 - p60), minutes: under, over60: false });
  }

  return branches;
}

// ---------------------------------------------------------------------------
// One player, one fixture
// ---------------------------------------------------------------------------

function projectFixtureForPlayer({ player, rules, rates, mins, fx, strength, bonus, setPiece }) {
  const position = player.position;
  const goalPoints = scoreValue(rules, 'goals_scored', position);
  const assistPoints = scoreValue(rules, 'assists', position);
  const csPoints = scoreValue(rules, 'clean_sheets', position);
  const concededPoints = scoreValue(rules, 'goals_conceded', position);
  const savePoints = scoreValue(rules, 'saves', position);
  const penSavePoints = scoreValue(rules, 'penalties_saved', position);
  const defConPoints = scoreValue(rules, 'defensive_contribution', position);
  const bonusPoints = scoreValue(rules, 'bonus', position);
  const yellowPoints = scoreValue(rules, 'yellow_cards', position);
  const redPoints = scoreValue(rules, 'red_cards', position);
  const longPlay = scoreValue(rules, 'long_play', position);
  const shortPlay = scoreValue(rules, 'short_play', position);
  const defConThreshold = rules.defConThresholds ? rules.defConThresholds[position] : undefined;

  // Fixture scaling. The player's per-90 rates were accumulated at their club's
  // usual level, so dividing the fixture expectation by that level converts
  // "his rate" into "his rate in this fixture" without counting club quality
  // twice.
  const teamBaseline = baselineTeamGoals(strength, player.teamId);
  const oppBaseline = baselineOpponentGoals(strength, player.teamId);
  const attackScale = teamBaseline > 0 ? fx.teamXg / teamBaseline : 1;
  const defenceScale = oppBaseline > 0 ? fx.opponentXg / oppBaseline : 1;
  const bonusScale = 1 + BONUS_FIXTURE_SENSITIVITY * (attackScale - 1);

  const bonusRate90 = Math.min(MAX_BONUS_PER_MATCH, bonus.predict(rates.bps) * bonusScale);

  const branches = minuteBranches(mins);
  const parts = [];
  const expected = {
    goals: 0, assists: 0, cleanSheet: 0, saves: 0, bonus: 0, cards: 0,
    defCon: 0, conceded: 0, pensSaved: 0, appearance: 0, minutes: 0, p60: 0,
  };
  const points = {
    appearance: 0, goals: 0, assists: 0, cleanSheets: 0, conceded: 0,
    saves: 0, penaltySaves: 0, defcon: 0, bonus: 0, cards: 0,
  };

  for (const branch of branches) {
    const share = branch.minutes / 90;
    const lamGoals = rates.xG * setPiece.goals * attackScale * share;
    const lamAssists = rates.xA * setPiece.assists * attackScale * share;
    const lamConceded = fx.opponentXg * share;
    const lamSaves = rates.saves * defenceScale * share;
    const lamPensSaved = rates.pensSaved * defenceScale * share;
    const lamDefCon = rates.defCon * share;
    const expBonus = bonusRate90 * share;
    const pYellow = clamp(rates.yellow * share, 0, 1);
    const pRed = clamp(rates.red * share, 0, 1);
    const pDefCon = defConThreshold && defConPoints ? poissonTail(defConThreshold, lamDefCon) : 0;

    const appearancePoints = branch.over60 ? longPlay : shortPlay;
    let d = distPoint(appearancePoints);
    d = distConvolve(d, countPointsDist(lamGoals, goalPoints));
    d = distConvolve(d, countPointsDist(lamAssists, assistPoints));
    d = distConvolve(d, concessionDist(lamConceded, {
      csPoints,
      concededPoints,
      divisor: concededPerPenalty(rules),
      over60: branch.over60,
    }));
    d = distConvolve(d, groupedCountPointsDist(lamSaves, savePoints, savesPerPoint(rules)));
    d = distConvolve(d, countPointsDist(lamPensSaved, penSavePoints));
    d = distConvolve(d, bernoulliPointsDist(pDefCon, defConPoints));
    d = distConvolve(d, countPointsDist(expBonus, bonusPoints));
    d = distConvolve(d, bernoulliPointsDist(pYellow, yellowPoints));
    d = distConvolve(d, bernoulliPointsDist(pRed, redPoints));

    parts.push({ weight: branch.weight, dist: d });

    const w = branch.weight;
    expected.goals += w * lamGoals;
    expected.assists += w * lamAssists;
    expected.cleanSheet += w * (branch.over60 ? Math.exp(-lamConceded) : 0);
    expected.saves += w * lamSaves;
    expected.pensSaved += w * lamPensSaved;
    expected.defCon += w * pDefCon;
    expected.conceded += w * lamConceded;
    expected.bonus += w * expBonus * bonusPoints;
    expected.cards += w * (pYellow * yellowPoints + pRed * redPoints);
    expected.appearance += w * appearancePoints;
    expected.minutes += w * branch.minutes;
    expected.p60 += branch.over60 ? w : 0;

    points.appearance += w * appearancePoints;
    points.goals += w * lamGoals * goalPoints;
    points.assists += w * lamAssists * assistPoints;
    points.cleanSheets += w * (branch.over60 ? Math.exp(-lamConceded) * csPoints : 0);
    points.conceded += w * concededExpectedPoints(lamConceded, concededPoints, concededPerPenalty(rules));
    points.saves += w * groupedExpectedPoints(lamSaves, savePoints, savesPerPoint(rules));
    points.penaltySaves += w * lamPensSaved * penSavePoints;
    points.defcon += w * pDefCon * defConPoints;
    points.bonus += w * expBonus * bonusPoints;
    points.cards += w * (pYellow * yellowPoints + pRed * redPoints);
  }

  // The fifth case: the player does not appear and scores nothing.
  const pNoPlay = Math.max(0, 1 - branches.reduce((s, b) => s + b.weight, 0));
  if (pNoPlay > 0) parts.push({ weight: pNoPlay, dist: distPoint(0) });

  return { dist: distMix(parts), expected, points, attackScale, defenceScale };
}

function groupedExpectedPoints(lambda, pointsPer, divisor) {
  if (!pointsPer || !(lambda > 0)) return 0;
  const maxK = adaptiveMaxK(lambda);
  const pmf = poissonVector(lambda, maxK);
  let s = 0;
  for (let k = 0; k <= maxK; k++) s += pmf[k] * Math.floor(k / divisor) * pointsPer;
  return s;
}

function concededExpectedPoints(lambda, concededPoints, divisor) {
  return groupedExpectedPoints(lambda, concededPoints, divisor);
}

// ---------------------------------------------------------------------------
// One player, one gameweek
// ---------------------------------------------------------------------------

export function projectPlayerGw(player, { gameState, strength, gw, model = null, bonus = null, ratePriors = null }) {
  const rules = gameState.rules;
  const bonusM = bonus || bonusModel(gameState);
  const priors = ratePriors || positionRatePriors(gameState);
  const contexts = fixtureContext(gameState, strength, player.teamId, gw);

  let mins = projectMinutes(player, { gameState, gw, fixtureCount: contexts.length });
  if (model && model.startCalibrator && mins.pStart > 0) {
    // A calibrator trained on real start outcomes can only move pStart. Keeping
    // the correction here, upstream of everything else, means the whole
    // distribution stays internally consistent instead of a mean being patched
    // after the fact.
    const calibrated = clamp(model.startCalibrator.predict(mins.pStart), 0, mins.pAppear);
    mins = { ...mins, pStart: calibrated };
  }

  const rates = shrinkRates(underlyingRates(player, { gw }), { position: player.position, priors });
  const setPiece = setPieceMultipliers(player);

  const fixtures = contexts.map(c => ({
    fixtureId: c.fixtureId,
    opponentId: c.opponentId,
    isHome: c.isHome,
    fdr: c.fdr,
    kickoff: c.kickoff,
  }));

  const components = {
    xGoals: 0, xAssists: 0, xCleanSheet: 0, xSaves: 0, xBonus: 0,
    xCards: 0, xDefCon: 0, xConceded: 0, xPensSaved: 0, xAppearance: 0,
  };
  const pointsBreakdown = {
    appearance: 0, goals: 0, assists: 0, cleanSheets: 0, conceded: 0,
    saves: 0, penaltySaves: 0, defcon: 0, bonus: 0, cards: 0,
  };

  let dist = distPoint(0);
  let xMins = 0;
  let p60 = 0;
  let pAppearGw = 0;

  for (const fx of contexts) {
    const r = projectFixtureForPlayer({ player, rules, rates, mins, fx, strength, bonus: bonusM, setPiece });
    dist = distConvolve(dist, r.dist);
    components.xGoals += r.expected.goals;
    components.xAssists += r.expected.assists;
    components.xCleanSheet += r.expected.cleanSheet;
    components.xSaves += r.expected.saves;
    components.xBonus += r.expected.bonus;
    components.xCards += r.expected.cards;
    components.xDefCon += r.expected.defCon;
    components.xConceded += r.expected.conceded;
    components.xPensSaved += r.expected.pensSaved;
    components.xAppearance += r.expected.appearance;
    for (const key of Object.keys(pointsBreakdown)) pointsBreakdown[key] += r.points[key];
    xMins += r.expected.minutes;
    p60 += r.expected.p60;
    // Playing in at least one fixture of a double.
    pAppearGw = 1 - (1 - pAppearGw) * (1 - mins.pAppear);
  }

  const xPoints = distMean(dist);
  const variance = distVariance(dist);

  return {
    playerId: player.id,
    gw,
    fixtures,
    pAppear: contexts.length ? pAppearGw : 0,
    pStart: contexts.length ? mins.pStart : 0,
    p60,
    xMins,
    components,
    pointsBreakdown,
    xPoints,
    sd: Math.sqrt(Math.max(0, variance)),
    ceiling: distQuantile(dist, CEILING_QUANTILE),
    confidence: mins.confidence,
    ratesSource: rates.source,
  };
}

// ---------------------------------------------------------------------------

export function buildProjections({ gameState, strength, gwFrom, gwTo, model = null, playerIds = null }) {
  const from = gwFrom;
  const to = gwTo === undefined || gwTo === null ? gwFrom : gwTo;
  const bonus = bonusModel(gameState);
  const ratePriors = positionRatePriors(gameState);

  const resolved = model && model.startCalibratorJSON
    ? { ...model, startCalibrator: calibratorFromJSON(model.startCalibratorJSON) }
    : model;

  const byPlayer = new Map();
  const ids = playerIds || [...gameState.players.keys()];
  for (const id of ids) {
    const player = gameState.players.get(id);
    if (!player) continue;
    const rows = [];
    for (let gw = from; gw <= to; gw++) {
      rows.push(projectPlayerGw(player, { gameState, strength, gw, model: resolved, bonus, ratePriors }));
    }
    byPlayer.set(id, rows);
  }

  return {
    gwFrom: from,
    gwTo: to,
    byPlayer,
    // Naming the trained artifact here is a claim that it produced these
    // numbers, so it holds only while a model object means a model was actually
    // applied. js/data/model.js keeps that true: it hands over null, not a bare
    // { modelVersion }, when the artifact declares nothing to consume, and the
    // v2 artifact declares nothing today. So these read analytic-1.
    modelVersion: (resolved && resolved.modelVersion) || DEFAULT_MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    dataFetchedAt: gameState.fetchedAt || null,
    get(playerId, gw) {
      const rows = byPlayer.get(playerId);
      if (!rows) return null;
      const idx = gw - from;
      return idx >= 0 && idx < rows.length ? rows[idx] : null;
    },
  };
}
