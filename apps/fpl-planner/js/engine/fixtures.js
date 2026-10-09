// The fixture model: two team ratings in, a full match outcome distribution out.
//
// Goals are modelled as independent Poisson counts with means taken from the
// strength model:
//
//   xGH = mu * attack(home) * defence(away) * homeAdvantage
//   xGA = mu * attack(away) * defence(home)
//
// Independence is an approximation (real scorelines are mildly correlated, the
// Dixon-Coles low-score correction exists for exactly that reason) but the
// quantities this app consumes are the marginals: expected team goals feeding
// player attacking rates, and P(opponent scores zero) feeding clean sheets.
// Both are unaffected by the dependence correction, so the extra parameter
// would buy nothing here.
//
// Truncation: the goal vectors run 0..MAX_GOALS with all remaining mass folded
// into the last cell, so the marginals sum to exactly 1 and therefore the
// win/draw/win probabilities do as well. That is asserted in the tests to 1e-9.
//
// TWO EXPERIMENT SWITCHES, both read off `strength.modelOptions` (see
// resolveModelOptions in strength.js) and both inert unless an arm sets them:
//
//   goalDispersion  the goal COUNT becomes Conway-Maxwell-Poisson with the
//                   same mean, so only the shape moves (P(0) and the tail).
//   odds            the decided gameweek's expected goals blend toward the
//                   bookmaker-implied ones the offline replay attached to the
//                   GameState. Per fixture, so it changes ORDER, not just level.

import { poissonVector } from './ml.js';
import { ratingFor } from './strength.js';

// Ten goals for one side in one match. The folded tail beyond it is worth about
// 1e-5 at the highest expectation this model produces.
const MAX_GOALS = 10;

export { MAX_GOALS };

// ---------------------------------------------------------------------------
// Conway-Maxwell-Poisson goal counts
//
//   P(k) proportional to rate^k / (k!)^nu
//
// nu = 1 is Poisson; nu > 1 is underdispersed (variance below the mean), which
// is what team goals in the Premier League look like once the expectation is
// known: AIrsenal fitted nu about 1.17 and gained points MAE and rank
// correlation. The model hands us a MEAN (expected goals), not a rate, so the
// rate is solved so that the CMP mean equals that expectation exactly. The
// expected-goals level is therefore untouched and only the shape changes.
//
// The mean is matched on the full distribution (CMP_SUPPORT terms, far past any
// mass that matters) and the returned vector is truncated at maxK with the tail
// folded into the last cell, exactly as poissonVector does. At nu = 1 the
// function returns poissonVector itself, bit for bit, so the shipped path
// cannot drift.
// ---------------------------------------------------------------------------

const CMP_SUPPORT = 80;
const CMP_SOLVER_ITERATIONS = 200;
const CMP_MEAN_TOLERANCE = 1e-12;
const LOG_FACTORIALS = (() => {
  const out = [0];
  for (let k = 1; k <= CMP_SUPPORT; k++) out[k] = out[k - 1] + Math.log(k);
  return out;
})();

// Normalised CMP probabilities over 0..CMP_SUPPORT for log(rate) = t.
function cmpProbabilities(t, nu) {
  const logs = new Array(CMP_SUPPORT + 1);
  let max = -Infinity;
  for (let k = 0; k <= CMP_SUPPORT; k++) {
    logs[k] = k * t - nu * LOG_FACTORIALS[k];
    if (logs[k] > max) max = logs[k];
  }
  let z = 0;
  for (let k = 0; k <= CMP_SUPPORT; k++) {
    logs[k] = Math.exp(logs[k] - max);
    z += logs[k];
  }
  for (let k = 0; k <= CMP_SUPPORT; k++) logs[k] /= z;
  return logs;
}

function meanOf(p) {
  let m = 0;
  for (let k = 1; k < p.length; k++) m += k * p[k];
  return m;
}

const cmpCache = new Map();
const CMP_CACHE_LIMIT = 20000;

// The full CMP distribution (0..CMP_SUPPORT) whose mean is `mean`. The mean is
// strictly increasing in the log rate, so bisection is safe.
function cmpForMean(mean, nu) {
  const key = `${mean}|${nu}`;
  const hit = cmpCache.get(key);
  if (hit) return hit;
  let lo = -60;
  let hi = 60;
  let p = null;
  for (let i = 0; i < CMP_SOLVER_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    p = cmpProbabilities(mid, nu);
    const m = meanOf(p);
    if (Math.abs(m - mean) < CMP_MEAN_TOLERANCE) { lo = mid; hi = mid; break; }
    if (m < mean) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  const out = { logRate: t, probs: cmpProbabilities(t, nu) };
  if (cmpCache.size >= CMP_CACHE_LIMIT) cmpCache.clear();
  cmpCache.set(key, out);
  return out;
}

/** The CMP rate whose distribution has mean `mean` (equals `mean` at nu = 1). */
export function cmpRateForMean(mean, nu) {
  if (!(mean > 0)) return 0;
  if (nu === 1) return mean;
  return Math.exp(cmpForMean(mean, nu).logRate);
}

/**
 * Goal-count probabilities 0..maxK (tail folded into maxK) for a count with
 * mean `mean` and dispersion `nu`. nu = 1 (or absent) is poissonVector exactly.
 */
export function goalCountVector(mean, nu = 1, maxK = MAX_GOALS) {
  if (nu === 1 || nu === undefined || nu === null) return poissonVector(mean, maxK);
  if (!(typeof nu === 'number' && Number.isFinite(nu) && nu > 0)) {
    throw new Error(`fixtures: goal dispersion must be a positive number, got ${JSON.stringify(nu)}`);
  }
  const out = new Array(maxK + 1).fill(0);
  if (!(mean > 0)) {
    out[0] = 1;
    return out;
  }
  const { probs } = cmpForMean(mean, nu);
  let cum = 0;
  for (let k = 0; k < maxK; k++) {
    out[k] = probs[k];
    cum += probs[k];
  }
  out[maxK] = Math.max(0, 1 - cum);
  return out;
}

/** P(zero goals) for a count with mean `mean`: exp(-mean) at nu = 1. */
export function pZeroGoals(mean, nu = 1) {
  if (nu === 1 || nu === undefined || nu === null) return Math.exp(-mean);
  return goalCountVector(mean, nu, 1)[0];
}

/** The dispersion an experiment arm set on this Strength, 1 when none. */
export function goalDispersionOf(strength) {
  const o = strength && strength.modelOptions;
  return o && o.goalDispersion ? o.goalDispersion : 1;
}

// ---------------------------------------------------------------------------
// Bookmaker odds, offline experiment only
//
// `gameState.fixtureOdds` is a Map of FPL fixture id to the derived market
// expectation ({ xGH, xGA, fetchedAt, ... } from odds.js deriveFromOdds). Only
// the offline replay attaches it, and only for the fixtures of the gameweek
// being decided whose odds were collected before that deadline
// (fixtureOddsAtDeadline in odds.js). The check on `nextEvent` below is the
// second, structural half of that rule: odds can never reach a later week of
// the horizon even if a caller attached them.
// ---------------------------------------------------------------------------

function oddsFor(gameState, strength, fixture) {
  const o = strength && strength.modelOptions && strength.modelOptions.odds;
  if (!o || !gameState || !gameState.fixtureOdds) return null;
  if (fixture.event !== gameState.nextEvent) return null;
  const row = gameState.fixtureOdds.get(fixture.id);
  if (!row || !(row.xGH > 0) || !(row.xGA > 0)) return null;
  return { weight: o.weight, xGH: row.xGH, xGA: row.xGA };
}

/**
 * The expected goals the fixture model uses for one fixture: the ratings
 * model's, blended with the market's when the odds switch is on and the
 * GameState carries odds for this fixture.
 */
export function fixtureExpectedGoals(gameState, strength, fixture) {
  const model = expectedGoals(strength, fixture.teamH, fixture.teamA);
  const odds = oddsFor(gameState, strength, fixture);
  if (!odds) return model;
  const w = odds.weight;
  return {
    xGH: w * odds.xGH + (1 - w) * model.xGH,
    xGA: w * odds.xGA + (1 - w) * model.xGA,
    oddsWeight: w,
  };
}

export function expectedGoals(strength, homeTeamId, awayTeamId) {
  const home = ratingFor(strength, homeTeamId);
  const away = ratingFor(strength, awayTeamId);
  const mu = strength.leagueMeanGoals;
  return {
    xGH: mu * home.attack * away.defence * strength.homeAdvantage,
    xGA: mu * away.attack * home.defence,
  };
}

// `expected` overrides the ratings model's expected goals for this fixture
// (the odds blend passes it); the goal distributions are built with the
// Strength's goal dispersion, which is Poisson unless an arm set it.
export function projectFixture(strength, homeTeamId, awayTeamId, expected = null) {
  const { xGH, xGA } = expected || expectedGoals(strength, homeTeamId, awayTeamId);
  const nu = goalDispersionOf(strength);
  const goalsDistH = goalCountVector(xGH, nu, MAX_GOALS);
  const goalsDistA = goalCountVector(xGA, nu, MAX_GOALS);

  let pWinHome = 0;
  let pDraw = 0;
  let pWinAway = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = goalsDistH[h];
    if (ph === 0) continue;
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = ph * goalsDistA[a];
      if (h > a) pWinHome += joint;
      else if (h === a) pDraw += joint;
      else pWinAway += joint;
    }
  }

  return {
    xGH,
    xGA,
    // A clean sheet for the home team is the away team failing to score, which
    // in a Poisson model is exactly exp(-xGA) (and the CMP P(0) otherwise).
    pCSHome: goalsDistA[0],
    pCSAway: goalsDistH[0],
    pWinHome,
    pDraw,
    pWinAway,
    goalsDistH,
    goalsDistA,
  };
}

// Every fixture a club plays in a gameweek, straight from the fixture list.
// Zero entries is a blank gameweek and two or more is a double; neither is a
// special case anywhere in this app, they are just the length of this array.
export function fixturesForTeam(gameState, teamId, gw) {
  // A postponed fixture carries a null event. Asking for "gameweek null" (which
  // is what `gameState.nextEvent` is once the season is over) must not match
  // those, so the null case is answered before the comparison.
  if (gw === null || gw === undefined) return [];
  return gameState.fixtures.filter(
    f => f.event === gw && (f.teamH === teamId || f.teamA === teamId),
  );
}

// The per-fixture view a player projection needs: which side the player's club
// is on, who they face, and the model's expectations for both.
export function fixtureContext(gameState, strength, teamId, gw) {
  return fixturesForTeam(gameState, teamId, gw).map(f => {
    const isHome = f.teamH === teamId;
    const p = projectFixture(strength, f.teamH, f.teamA, fixtureExpectedGoals(gameState, strength, f));
    return {
      fixtureId: f.id,
      opponentId: isHome ? f.teamA : f.teamH,
      isHome,
      fdr: isHome ? f.teamHDifficulty : f.teamADifficulty,
      kickoff: f.kickoff,
      teamXg: isHome ? p.xGH : p.xGA,
      opponentXg: isHome ? p.xGA : p.xGH,
      pCleanSheet: isHome ? p.pCSHome : p.pCSAway,
      opponentGoalsDist: isHome ? p.goalsDistA : p.goalsDistH,
      fixture: p,
    };
  });
}

// The club's own scoring level against an average opponent, AVERAGED OVER THE
// VENUES a season is played at. Player attacking rates are per-90 numbers
// earned over roughly half home and half away matches, so they already carry
// the average venue factor (1 + homeAdvantage) / 2. Dividing a fixture's
// expectation by this level turns "his rate" into "his rate in THIS fixture"
// without counting club quality or the venue twice.
//
// Until 2026-09-16 the level was read at a NEUTRAL venue (no venue factor), so
// every attacking and save rate was scaled up by the average venue factor, about
// 4.8% (1.10 to 1.13 over a season). Projecting the second half of each
// archived season's player xG from first-half rates read 1.089 / 1.127 / 1.113
// against what happened with the neutral level, and 0.947 / 1.065 / 0.998 with
// this one (scripts/calibration/calibrate-strength.mjs).
function averageVenueFactor(strength) {
  const ha = Number.isFinite(strength.homeAdvantage) ? strength.homeAdvantage : 1;
  return (1 + ha) / 2;
}

export function baselineTeamGoals(strength, teamId) {
  const r = ratingFor(strength, teamId);
  return strength.leagueMeanGoals * r.attack * averageVenueFactor(strength);
}

export function baselineOpponentGoals(strength, teamId) {
  const r = ratingFor(strength, teamId);
  return strength.leagueMeanGoals * r.defence * averageVenueFactor(strength);
}
