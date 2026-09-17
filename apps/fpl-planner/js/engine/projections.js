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
//   2. RATES. Per-90 underlying rates from this season's totals, with the
//      previous season carried in where it measurably persists
//      (PRIOR_SEASON_CARRY), pulled toward the position's rate by how much
//      football is behind them. Attacking rates come from expected goals and
//      expected assists, NEVER from goals and assists scored, and never from
//      FPL points: two players with the same underlying numbers and different
//      finishing luck must project the same. The one realized outcome read is
//      BONUS, blended with the BPS curve, because a player's own bonus rate
//      measurably predicts his next bonus beyond his BPS (BONUS_OWN_RATE_WEIGHT).
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
import { projectMinutes, evidenceView } from './minutes.js';
import { rateMinutesOf } from './normalize.js';
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
  distQuantileInterpolated,
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


// The minutes in each branch (started and reached the hour, started and did
// not, came on and reached it, came on and did not) and the chance of each are
// decided by minutes.js from measured values; the over-60 start branch and the
// under-60 sub branch are solved here so the branch-weighted mean minutes match
// the minutes model.

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

// Fallback for the bonus curve when too few players carry
// BONUS_MODEL_MIN_MINUTES of rate minutes to fit one. That is small test
// worlds, and also every live season from the day the baseline retires (three
// matches per club) until enough players pass 450 minutes of the new season.
// Measured from the live population: bonus per 90 rises roughly linearly above
// a floor of 7 BPS per 90.
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

// --- The previous season, carried into this one (2026-09-16) ----------------
//
// PRIOR_NINETIES above is the WITHIN-season shrinkage: how far a player's own
// per-90 rate is pulled toward his position's. Until 2026-09-16 it was also the
// only thing between a player and his position average once the season baseline
// retired at three club matches, so from gameweek 4 Saka's goal rate kept about
// half of its own signal and Bruno Fernandes's bonus kept a sixth, and the whole
// league clustered at three to four points.
//
// The previous season now enters every rate that measurably persists, as
// DISCOUNTED EVIDENCE rescaled to this season's level:
//
//   rate = (cur + w * last * s + posNow * k) / (cur90 + w * last90 + k)
//   s    = posNow / posLast
//
// for a player with a previous season, and (cur + posNow * kNew) / (cur90 +
// kNew) for one without. `posNow` is this season's position rate with last
// season's anchored at two gameweeks of that position's minutes, so a league
// whose scoring level moved (FPL rewrote BPS for 2024-25) is followed within a
// few gameweeks. `s` makes a player's previous season RELATIVE to his
// position's level, so that rewrite does not carry either.
//
// Every w, k and kNew below was fitted leave-one-season-out on the archive under
// the production evidence regime (scripts/calibration/calibrate-rates.mjs,
// registry entry 29): minutes-weighted Poisson deviance of each player's next
// five appearances, over 55,557 player-deadlines of 2023-24, 2024-25 and
// 2025-26. Held-out gains against the shipped rule: xG 1.8% / 5.7% / 1.9%
// (DEF/MID/FWD), xA 8.1% / 5.1% / 3.3%, BPS 2.9% to 3.0%, own bonus rate 2.6%
// to 13.3%, yellows 1.9% to 7.3%, larger in gameweeks 2-8.
//
// Rates with no row here keep the within-season rule on this season's evidence
// alone: a goalkeeper's xG and xA (the prior LOST 8% on keeper xA), red cards
// and penalty saves (no measurable between-player signal), a keeper's yellows.
// Defensive contribution exists in one archived season only, so its carry could
// not be measured; it takes the unit weight at the within-season k, which is
// exactly what the pre-season read of last season's totals has always done.
export const PRIOR_SEASON_CARRY = Object.freeze({
  xG: { 2: { w: 1, k: 30, kNew: 12 }, 3: { w: 0.5, k: 3, kNew: 2 }, 4: { w: 0.7, k: 8, kNew: 5 } },
  xA: { 2: { w: 0.7, k: 5, kNew: 2 }, 3: { w: 0.7, k: 5, kNew: 3 }, 4: { w: 0.7, k: 12, kNew: 5 } },
  bps: { 1: { w: 0, k: 200, kNew: 19 }, 2: { w: 1, k: 12, kNew: 8 }, 3: { w: 0.5, k: 12, kNew: 12 }, 4: { w: 1, k: 30, kNew: 200 } },
  bonus: { 1: { w: 0, k: 200, kNew: 80 }, 2: { w: 0.7, k: 50, kNew: 12 }, 3: { w: 0.5, k: 19, kNew: 12 }, 4: { w: 0.7, k: 30, kNew: 400 } },
  saves: { 1: { w: 0.05, k: 12, kNew: 19 } },
  yellow: { 2: { w: 1, k: 30, kNew: 30 }, 3: { w: 1, k: 19, kNew: 12 }, 4: { w: 1, k: 8, kNew: 8 } },
  defCon: { 2: { w: 1, k: 4.6, kNew: 4.6 }, 3: { w: 1, k: 2.7, kNew: 2.7 }, 4: { w: 1, k: 6.9, kNew: 6.9 } },
});

// Two gameweeks of a position's minutes is what last season's position rate is
// worth against this season's pool.
const POOL_ANCHOR_GAMEWEEKS = 2;

// FPL ASSISTS ARE NOT xA. An FPL assist includes rebounds, deflections, a won
// penalty and a forced own goal, and over the four archived seasons FPL
// assists ran 1.23x xA for defenders, 1.36x for midfielders and 2.10x for
// forwards (1.37x overall in 2025/26). A FLAT league multiplier was rejected in
// registry entry 12 because the excess is not flat: elite creators carry the
// least of it (1.32x in the top xA quartile) and shot-heavy players the most
// (1.62x in the top xG quartile), so a flat scale promoted creators over
// finishers and cost captaincy points. The conversion below is the log-linear
// fit that carries that gradient (registry entry 29, held-out deviance of next
// five FPL assists 6.1% better than raw xA in every season, and top-quartile
// creators and finishers both calibrated within 12%):
//
//   assists = xA * exp(b0 + bDEF + bFWD + bXA * ln(xA / posXA) + bXG * ln((xG + 0.01) / (posXG + 0.01)))
//
// Outfield only: the fit had nineteen goalkeeper assists to learn from.
export const ASSIST_CONVERSION = Object.freeze({
  intercept: 0.3032,
  defender: -0.0771,
  forward: 0.4941,
  xaLevel: -0.1894,
  xgLevel: 0.207,
  // The log ratios are clamped so a player with almost no xA or xG cannot turn
  // a rounding error into a multiplier.
  logClamp: 3,
});

// BONUS FROM THE PLAYER'S OWN BONUS RATE AND HIS BPS. The BPS curve alone, fed
// a BPS rate shrunk to a sixth of its own signal, projected Tavernier's eight
// bonus points in four matches as 0.36 a match. A held-out blend of the
// player's own carried bonus rate with the curve on his carried BPS rate is
// 5.4% better on the next five appearances (6.4% in gameweeks 2-8) and moves
// top-decile calibration from 1.53 to 1.02; the weight was 0.65 / 0.70 / 0.80
// across the three held-out seasons. The curve is the one bonusModel fits on
// this season's players; last season's curve was measured and LOSES in a
// season FPL rescored BPS.
export const BONUS_OWN_RATE_WEIGHT = 0.7;

// The ceiling is the 85th percentile of the composed distribution.
const CEILING_QUANTILE = 0.85;

// Count truncation for the component distributions. Beyond mean plus three
// standard deviations the probability mass is worth less than a hundredth of a
// point and only costs convolution time.
const MAX_COUNT_CAP = 8;

export const PROJECTION_PARAMS = Object.freeze({
  priorSeasonCarry: PRIOR_SEASON_CARRY,
  poolAnchorGameweeks: POOL_ANCHOR_GAMEWEEKS,
  assistConversion: ASSIST_CONVERSION,
  bonusOwnRateWeight: BONUS_OWN_RATE_WEIGHT,
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
// analytic-2 since 2026-09-16: the xP calibration repair (registry entry 29)
// replaced the minutes, rates and strength models, so a plan stored under
// analytic-1 was produced by a different model and says so.
export const DEFAULT_MODEL_VERSION = 'analytic-2';

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
// Nothing in here reads total points, form, points per game, event points,
// goals, assists or expected points. That is the point: finishing luck must not
// move a projection, only underlying numbers may. (Bonus collected is read, by
// playerRates below, for the reason given at BONUS_OWN_RATE_WEIGHT.)
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

  const minutes = rateMinutesOf(player);
  if (minutes <= 0) {
    return {
      source: 'none',
      nineties: 0,
      xNineties: 0,
      dcNineties: 0,
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
  const dcMinutes = Number.isFinite(player.dcMinutes) ? player.dcMinutes : minutes;
  return ratesFrom({
    xG: player.xG,
    xA: player.xA,
    bps: player.bps,
    saves: player.saves,
    defCon: defConComposite(player),
    yellow: player.yellowCards,
    red: player.redCards,
    pensSaved: player.penaltiesSaved,
  }, minutes, 'season', { xMinutes, dcMinutes });
}

function ratesFrom(totals, minutes, source, { xMinutes = minutes, dcMinutes = minutes } = {}) {
  const nineties = minutes / 90;
  const xNineties = xMinutes / 90;
  const dcNineties = dcMinutes / 90;
  const per = (v) => (v || 0) / nineties;
  // Zero covered minutes means zero EVIDENCE, not a zero rate: the rate is
  // reported as 0 with its evidence at 0 and the shrinkage layer resolves it
  // to the position prior, exactly as for a player with no minutes at all.
  const perX = (v) => (xNineties > 0 ? (v || 0) / xNineties : 0);
  const perDc = (v) => (dcNineties > 0 ? (v || 0) / dcNineties : 0);
  return {
    source,
    nineties,
    xNineties,
    dcNineties,
    xG: perX(totals.xG),
    xA: perX(totals.xA),
    bps: per(totals.bps),
    saves: per(totals.saves),
    defCon: perDc(totals.defCon),
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
        xNineties: 0,
        dcNineties: 0,
        totals: { xG: 0, xA: 0, bps: 0, saves: 0, defCon: 0, yellow: 0, red: 0, pensSaved: 0 },
      });
    }
    const row = byPosition.get(p.position);
    const rateMinutes = rateMinutesOf(p);
    row.nineties += rateMinutes / 90;
    // The same covered-minutes rule the per-player rates follow: a numerator
    // may only be divided by the minutes its evidence covers, and this map IS
    // the shrinkage target, so a diluted target would drag every shrunk rate
    // down with it. Absent fields (every live payload) fall back to minutes.
    row.xNineties += (Number.isFinite(p.xMinutes) ? p.xMinutes : rateMinutes) / 90;
    row.dcNineties += (Number.isFinite(p.dcMinutes) ? p.dcMinutes : rateMinutes) / 90;
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
    for (const key of SHRUNK_RATES) {
      const denom = key === 'xG' || key === 'xA' ? row.xNineties
        : key === 'defCon' ? row.dcNineties
          : row.nineties;
      out[key] = denom > 0 ? row.totals[key] / denom : 0;
    }
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
      : key === 'defCon' && Number.isFinite(rates.dcNineties)
        ? rates.dcNineties
        : rates.nineties;
    out[key] = (rates[key] * n + prior[key] * k) / (n + k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rates with the previous season carried in
// ---------------------------------------------------------------------------

// The fields each rate reads, and the minutes its numerator covers.
const RATE_SPEC = {
  xG: { field: 'xG', exposure: 'xMinutes' },
  xA: { field: 'xA', exposure: 'xMinutes' },
  bps: { field: 'bps', exposure: 'minutes' },
  bonus: { field: 'bonus', exposure: 'minutes' },
  saves: { field: 'saves', exposure: 'minutes' },
  defCon: { field: 'defCon', exposure: 'dcMinutes' },
  yellow: { field: 'yellowCards', exposure: 'minutes' },
};

function totalFor(totals, key, position) {
  if (!totals) return 0;
  if (key === 'defCon') return totals.defCon === null ? null : defConComposite({ ...totals, position });
  const v = totals[RATE_SPEC[key].field];
  return v === null || v === undefined ? null : v;
}

function exposureFor(totals, key) {
  if (!totals) return 0;
  const spec = RATE_SPEC[key].exposure;
  const own = totals[spec];
  if (Number.isFinite(own)) return own;
  return rateMinutesOf(totals);
}

const carryCache = new WeakMap();

/**
 * The position pools the carried rates are anchored to, per GameState.
 *
 * `last` pools every player's previous season (the attached prior, or the
 * payload's own totals before a ball is kicked); `current` pools this season's.
 * Both are minutes-weighted, like positionRatePriors.
 */
export function carriedRateModel(gameState) {
  const cached = carryCache.get(gameState);
  if (cached) return cached;
  const view = evidenceView(gameState);
  const keys = Object.keys(RATE_SPEC);
  const blank = () => Object.fromEntries(keys.map(k => [k, { total: 0, exposure: 0 }]));
  const last = new Map();
  const current = new Map();
  for (const p of gameState.players.values()) {
    const prior = view.priorOf(p);
    const cur = view.currentOf(p);
    if (!last.has(p.position)) last.set(p.position, blank());
    if (!current.has(p.position)) current.set(p.position, blank());
    for (const key of keys) {
      if (prior && prior.minutes > 0) {
        const t = totalFor(prior, key, p.position);
        if (t !== null) {
          last.get(p.position)[key].total += t;
          last.get(p.position)[key].exposure += exposureFor(prior, key);
        }
      }
      if (cur && cur.minutes > 0) {
        const t = totalFor(cur, key, p.position);
        if (t !== null) {
          current.get(p.position)[key].total += t;
          current.get(p.position)[key].exposure += exposureFor(cur, key);
        }
      }
    }
  }
  const seasonGws = (gameState.priorSeason && gameState.priorSeason.totalEvents) || gameState.rules.totalEvents || 38;
  const levels = new Map();
  for (const position of new Set([...last.keys(), ...current.keys()])) {
    const out = {};
    for (const key of keys) {
      const l = last.get(position) ? last.get(position)[key] : { total: 0, exposure: 0 };
      const c = current.get(position) ? current.get(position)[key] : { total: 0, exposure: 0 };
      const lastN = l.exposure / 90;
      const curN = c.exposure / 90;
      const lastRate = lastN > 0 ? l.total / lastN : null;
      const anchor = (lastN / seasonGws) * POOL_ANCHOR_GAMEWEEKS;
      const posNow = lastRate === null
        ? (curN > 0 ? c.total / curN : 0)
        : (c.total + lastRate * anchor) / (curN + anchor);
      out[key] = { posNow, posLast: lastRate === null ? posNow : lastRate };
    }
    levels.set(position, out);
  }
  const model = {
    view,
    levelFor(position, key) {
      const l = levels.get(position);
      return l ? l[key] : { posNow: 0, posLast: 0 };
    },
  };
  carryCache.set(gameState, model);
  return model;
}

/**
 * One player's per-90 rates, the previous season carried in where it
 * measurably persists (PRIOR_SEASON_CARRY), the within-season rule elsewhere.
 * Returns the shape `underlyingRates` returns, so every consumer reads it the
 * same way, plus `assistConversion`.
 */
export function playerRates(player, { gameState, gw, priors = null }) {
  const model = carriedRateModel(gameState);
  const { view } = model;
  const prior = view.priorOf(player);
  const cur = view.currentOf(player);
  const position = player.position;

  // The within-season rule on the payload's own totals: this season's, or
  // before a ball is kicked the previous season's, which is all there is.
  const within = shrinkRates(underlyingRates(player, { gw }), {
    position,
    priors: priors || positionRatePriors(gameState),
  });

  // A caller that attached per-gameweek history (never the live payload, which
  // has none) gets the recency-weighted within-season rates it asked for; the
  // season-total carry below has nothing to add to them.
  if (within.source === 'history') return { ...within, carried: [], assistConversion: 1 };

  const out = { ...within, carried: [] };
  for (const key of Object.keys(RATE_SPEC)) {
    const carry = PRIOR_SEASON_CARRY[key] && PRIOR_SEASON_CARRY[key][position];
    if (!carry) continue;
    const { posNow, posLast } = model.levelFor(position, key);
    const curT = cur ? (totalFor(cur, key, position) || 0) : 0;
    const curN = cur ? exposureFor(cur, key) / 90 : 0;
    const lastT = prior ? totalFor(prior, key, position) : null;
    const lastN = prior && lastT !== null ? exposureFor(prior, key) / 90 : 0;
    const returner = lastN > 0 && posLast > 0;
    if (returner) {
      const scale = posNow / posLast;
      out[key] = (curT + carry.w * lastT * scale + posNow * carry.k) / (curN + carry.w * lastN + carry.k);
    } else {
      out[key] = (curT + posNow * carry.kNew) / (curN + carry.kNew);
    }
    out.carried.push(key);
  }

  // Assists: xA converted to FPL assists (ASSIST_CONVERSION), outfield only.
  out.assistConversion = 1;
  if (position !== 1) {
    const c = ASSIST_CONVERSION;
    const posXA = model.levelFor(position, 'xA').posNow;
    const posXG = model.levelFor(position, 'xG').posNow;
    const clampLog = (v) => clamp(v, -c.logClamp, c.logClamp);
    const xaTerm = out.xA > 0 && posXA > 0 ? clampLog(Math.log(out.xA / posXA)) : 0;
    const xgTerm = posXG >= 0 ? clampLog(Math.log((out.xG + 0.01) / (posXG + 0.01))) : 0;
    out.assistConversion = Math.exp(
      c.intercept
      + (position === 2 ? c.defender : 0)
      + (position === 4 ? c.forward : 0)
      + c.xaLevel * xaTerm
      + c.xgLevel * xgTerm,
    );
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
    const rateMinutes = rateMinutesOf(p);
    if (rateMinutes < BONUS_MODEL_MIN_MINUTES) continue;
    const nineties = rateMinutes / 90;
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
    const p60 = mins.p60GivenStart;
    const under = mins.startUnder60Minutes;
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
    const p60 = mins.p60GivenSub;
    const over = mins.subOver60Minutes;
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

  // The player's own carried bonus rate, blended with the league's BPS curve
  // on his carried BPS rate (BONUS_OWN_RATE_WEIGHT). A rate object without an
  // own bonus rate (an override, a test) reads the curve alone as before.
  const curveBonus = bonus.predict(rates.bps);
  const bonusBase = Number.isFinite(rates.bonus)
    ? BONUS_OWN_RATE_WEIGHT * rates.bonus + (1 - BONUS_OWN_RATE_WEIGHT) * curveBonus
    : curveBonus;
  const bonusRate90 = Math.min(MAX_BONUS_PER_MATCH, bonusBase * bonusScale);
  const assistConversion = Number.isFinite(rates.assistConversion) ? rates.assistConversion : 1;

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
    const lamAssists = rates.xA * assistConversion * setPiece.assists * attackScale * share;
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

  const rates = playerRates(player, { gameState, gw, priors });
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
    // Interpolated, not the discrete quantile. The ceiling is only ever read as
    // a RANKING signal (captaincy upside, the drawer's "realistic ceiling"), and
    // the discrete quantile of an integer-scored distribution is a step
    // function: it answers 7 for every player until the mass crosses a bucket
    // edge and then answers 8, so a hair of extra threat is worth either nothing
    // or a whole point. See distQuantileInterpolated in ml.js.
    ceiling: distQuantileInterpolated(dist, CEILING_QUANTILE),
    confidence: mins.confidence,
    // The continuous form of the same quantity. The tier is a display and
    // gating device; anything WEIGHTING confidence must read the score, so that
    // a player a hair either side of a tier edge cannot swing a decision.
    confidenceScore: mins.confidenceScore,
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
    // v2 artifact declares nothing today. So these read analytic-2.
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
