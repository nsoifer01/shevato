// Team attack and defence ratings.
//
// The model is multiplicative and centred on 1.0:
//
//   xG(home) = mu * attack(home) * defence(away) * homeAdvantage
//   xG(away) = mu * attack(away) * defence(home)
//
// `attack` is "goals scored relative to an average club", `defence` is "goals
// CONCEDED relative to an average club", so a low defence number is a good
// defence. `mu` is league mean goals per team per match.
//
// Why not just use FPL's own FDR: it is a 1-5 integer per fixture and cannot
// separate "hard because they score a lot" from "hard because they concede
// nothing". A defender's clean-sheet points depend on exactly that distinction.
//
// Two regimes, one code path:
//
//   PRE-SEASON / EARLY SEASON. No results to fit, so the rating comes from the
//   squads themselves: aggregate every player's expected goals and expected
//   goals conceded from bootstrap-static. Pre-season those totals are last
//   season's; in-season they are this season's, and the same code improves as
//   the season runs. Confidence in that aggregate is a function of how many
//   Premier League minutes the squad actually has, so promoted clubs (which
//   have almost none) fall back to a prior instead of being read as either
//   average or as zero-strength.
//
//   IN-SEASON. Once results exist the ratings are fitted from them by weighted
//   Poisson maximum likelihood, with the squad-derived rating entering as a
//   fixed number of pseudo-matches so the transition is smooth rather than a
//   step change after gameweek 1, and with exponential recency weighting.
//
// Every tunable is a named constant in the PARAMS block below and is reported
// on the Strength object so the model-status panel can show what was used.

import { fixtureIsPlayed } from './lifecycle.js';
import { ridge } from './ml.js';

// --- Model parameters ------------------------------------------------------

// League mean goals per team per match, used only when there is neither a
// result nor a usable squad aggregate to derive it from.
const LEAGUE_MEAN_GOALS_FALLBACK = 1.45;

// Squad-minutes at which the squad xG aggregate carries half the weight of the
// strength-implied prior. Roughly a third of a full season of Premier League
// minutes for one club (a club plays 11 * 90 = 990 player-minutes per match).
const MINUTES_SHRINK_K = 12000;

// A club whose entire squad has fewer than this many Premier League minutes is
// treated as promoted: its aggregate says nothing, so the prior does the work.
const PROMOTED_MINUTES_THRESHOLD = 10000;

// Promoted clubs score about a fifth less and concede about a fifth more than
// the league average in their first season back. Applied in log space, blended
// half and half with whatever the published overall strength implies for them.
const PROMOTED_ATTACK_PRIOR = 0.82;
const PROMOTED_DEFENCE_PRIOR = 1.22;
const PROMOTED_PRIOR_WEIGHT = 0.5;

// Home advantage. Fitted from results once there are enough of them, held near
// the prior before that, and clamped because a 6-match sample can produce
// nonsense at either end.
const HOME_ADVANTAGE_PRIOR = 1.15;
const HOME_ADVANTAGE_PRIOR_MATCHES = 40;
const HOME_ADVANTAGE_MIN = 1.0;
const HOME_ADVANTAGE_MAX = 1.4;

// Exponential recency: a match this many gameweeks ago counts half as much as
// one played in the most recent gameweek.
const RECENCY_HALF_LIFE_GWS = 10;

// How many matches of evidence the squad-derived league scoring LEVEL is worth.
// Without this a single early 0-0 would set league mean goals to zero and take
// every rating with it; with it, the level moves off the squad aggregate only
// once a few gameweeks of real scoring exist.
const MU_PRIOR_MATCHES = 40;

// How many matches of evidence the squad-derived prior is worth. After this
// many real matches the fit and the prior carry equal weight.
const PRIOR_STRENGTH_MATCHES = 6;

// Iterative proportional fitting converges in well under this many passes for
// a 20-team league; the cap only exists so a pathological input terminates.
const FIT_ITERATIONS = 60;

// No club is four times better than another at either end. Bounds stop a
// 2-match sample from producing a rating that breaks every downstream model.
const RATING_MIN = 0.35;
const RATING_MAX = 2.2;

// Ridge penalty for the small regression that relates published overall
// strength to the measured ratings. There are at most 20 points, so a little
// regularization keeps the slope stable when the spread is narrow.
const OVERALL_FIT_LAMBDA = 0.25;

export const STRENGTH_PARAMS = Object.freeze({
  leagueMeanGoalsFallback: LEAGUE_MEAN_GOALS_FALLBACK,
  minutesShrinkK: MINUTES_SHRINK_K,
  promotedMinutesThreshold: PROMOTED_MINUTES_THRESHOLD,
  promotedAttackPrior: PROMOTED_ATTACK_PRIOR,
  promotedDefencePrior: PROMOTED_DEFENCE_PRIOR,
  promotedPriorWeight: PROMOTED_PRIOR_WEIGHT,
  homeAdvantagePrior: HOME_ADVANTAGE_PRIOR,
  recencyHalfLifeGws: RECENCY_HALF_LIFE_GWS,
  priorStrengthMatches: PRIOR_STRENGTH_MATCHES,
  muPriorMatches: MU_PRIOR_MATCHES,
  ratingMin: RATING_MIN,
  ratingMax: RATING_MAX,
});

const clampRating = (v) => Math.min(RATING_MAX, Math.max(RATING_MIN, v));
const geoMean = (values) => Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length);

// ---------------------------------------------------------------------------
// Squad aggregation
//
// The two denominators are different and the difference is the whole trick.
//
// Expected goals are PLAYER events: summing every player's xG over a match
// gives the team's xG once. Divide by (squad minutes / minutes-per-team-match)
// to get xG per match.
//
// Expected goals CONCEDED is a TEAM event credited to every player on the
// pitch: summing gives roughly 11 times the team's xGC. The minutes-weighted
// mean of the per-90 rate is the team rate, so the denominator is
// (squad minutes / 90).
// ---------------------------------------------------------------------------

export function aggregateSquadXg(gameState) {
  const minutesPerTeamMatch = gameState.rules.starters * 90;
  const agg = new Map();
  for (const team of gameState.teams.keys()) {
    agg.set(team, { minutes: 0, xg: 0, xgcMinuteWeighted: 0 });
  }
  for (const p of gameState.players.values()) {
    const row = agg.get(p.teamId);
    if (!row) continue;
    row.minutes += p.minutes;
    row.xg += p.xG;
    row.xgcMinuteWeighted += p.xGC;
  }
  const out = new Map();
  for (const [teamId, row] of agg) {
    const teamMatches = row.minutes / minutesPerTeamMatch;
    const playerNineties = row.minutes / 90;
    out.set(teamId, {
      minutes: row.minutes,
      xgPerMatch: teamMatches > 0 ? row.xg / teamMatches : null,
      xgcPerMatch: playerNineties > 0 ? row.xgcMinuteWeighted / playerNineties : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The squad-derived prior.
//
// Step 1 measure each club from its squad. Step 2 fit, across the clubs we CAN
// measure, how published overall strength maps onto those measurements. Step 3
// use that fitted relationship to give the clubs we cannot measure (promoted
// sides, whose squads have no Premier League minutes) a rating on the same
// scale, then pull them further toward the promoted prior. This is why the
// published 1-5 strength matters: it is the only signal that exists for a club
// with no history, and calibrating it against measurable clubs is better than
// inventing a mapping.
// ---------------------------------------------------------------------------

function buildPrior(gameState) {
  const squad = aggregateSquadXg(gameState);
  const teamIds = [...gameState.teams.keys()];

  const measurable = teamIds.filter(id => {
    const s = squad.get(id);
    return s && s.minutes >= PROMOTED_MINUTES_THRESHOLD && s.xgPerMatch > 0 && s.xgcPerMatch > 0;
  });

  const baseAttack = measurable.length
    ? geoMean(measurable.map(id => squad.get(id).xgPerMatch))
    : LEAGUE_MEAN_GOALS_FALLBACK;
  const baseDefence = measurable.length
    ? geoMean(measurable.map(id => squad.get(id).xgcPerMatch))
    : LEAGUE_MEAN_GOALS_FALLBACK;

  const overallOf = (id) => {
    const t = gameState.teams.get(id);
    return (t.strengthOverallHome + t.strengthOverallAway) / 2;
  };
  const overallMean = teamIds.reduce((s, id) => s + overallOf(id), 0) / teamIds.length;

  // Regress log(rating) on centred overall strength across measurable clubs.
  let attackFit = { intercept: 0, weights: [0] };
  let defenceFit = { intercept: 0, weights: [0] };
  if (measurable.length >= 4) {
    const X = measurable.map(id => [overallOf(id) - overallMean]);
    attackFit = ridge(X, measurable.map(id => Math.log(squad.get(id).xgPerMatch / baseAttack)), OVERALL_FIT_LAMBDA);
    defenceFit = ridge(X, measurable.map(id => Math.log(squad.get(id).xgcPerMatch / baseDefence)), OVERALL_FIT_LAMBDA);
  }

  const priors = new Map();
  for (const id of teamIds) {
    const s = squad.get(id);
    const centred = overallOf(id) - overallMean;
    const impliedAttack = Math.exp(attackFit.intercept + attackFit.weights[0] * centred);
    const impliedDefence = Math.exp(defenceFit.intercept + defenceFit.weights[0] * centred);

    const promoted = !s || s.minutes < PROMOTED_MINUTES_THRESHOLD;
    let priorAttack = impliedAttack;
    let priorDefence = impliedDefence;
    if (promoted) {
      priorAttack = Math.exp(
        (1 - PROMOTED_PRIOR_WEIGHT) * Math.log(impliedAttack) + PROMOTED_PRIOR_WEIGHT * Math.log(PROMOTED_ATTACK_PRIOR),
      );
      priorDefence = Math.exp(
        (1 - PROMOTED_PRIOR_WEIGHT) * Math.log(impliedDefence) + PROMOTED_PRIOR_WEIGHT * Math.log(PROMOTED_DEFENCE_PRIOR),
      );
    }

    // Blend the club's own measurement with the prior by how much evidence the
    // measurement has. A promoted club with no minutes gets weight 0 and lands
    // entirely on the prior.
    const minutes = s ? s.minutes : 0;
    const w = minutes / (minutes + MINUTES_SHRINK_K);
    const measuredAttack = s && s.xgPerMatch > 0 ? s.xgPerMatch / baseAttack : priorAttack;
    const measuredDefence = s && s.xgcPerMatch > 0 ? s.xgcPerMatch / baseDefence : priorDefence;

    priors.set(id, {
      attack: clampRating(Math.exp(w * Math.log(measuredAttack) + (1 - w) * Math.log(priorAttack))),
      defence: clampRating(Math.exp(w * Math.log(measuredDefence) + (1 - w) * Math.log(priorDefence))),
      minutes,
      minutesWeight: w,
      promoted,
      overallStrength: overallOf(id),
      xgPerMatch: s ? s.xgPerMatch : null,
      xgcPerMatch: s ? s.xgcPerMatch : null,
    });
  }

  // Centre both scales on 1.0 so `mu` carries the level and the ratings carry
  // only the relative differences.
  const ga = geoMean([...priors.values()].map(p => p.attack));
  const gd = geoMean([...priors.values()].map(p => p.defence));
  for (const p of priors.values()) {
    p.attack = clampRating(p.attack / ga);
    p.defence = clampRating(p.defence / gd);
  }

  // The scoring LEVEL the league sits at, as opposed to the relative ratings.
  // Attack and defence aggregates should agree in a closed league and differ
  // only through squad churn and own goals, so the mean of the two is the
  // steadier estimate.
  const priorMu = measurable.length
    ? (baseAttack + baseDefence) / 2
    : LEAGUE_MEAN_GOALS_FALLBACK;

  return { priors, baseAttack, baseDefence, priorMu, measurableCount: measurable.length };
}

// ---------------------------------------------------------------------------
// Fitting from results
// ---------------------------------------------------------------------------

function collectMatches(gameState, asOfGw, opts) {
  const teamXg = opts.teamXg || null;
  const out = [];
  for (const f of gameState.fixtures) {
    if (f.event === null || f.event === undefined) continue;
    // Strictly before the gameweek being planned: a fixture in the gameweek we
    // are projecting has not been played at the deadline, so reading it would
    // be leakage.
    if (f.event >= asOfGw) continue;
    // A match that has been PLAYED, whether or not FPL has signed it off. The
    // score is settled at the final whistle; what `finished` waits for is bonus
    // and stat corrections, which do not change who scored. Reading only
    // `finished` meant a club's opening result was invisible to its own rating
    // for as long as FPL took to confirm bonus - on 2026-08-21, over eleven hours.
    if (!fixtureIsPlayed(f)) continue;
    if (f.teamHScore === null || f.teamAScore === null) continue;
    const xg = teamXg ? teamXg.get(f.id) : null;
    out.push({
      event: f.event,
      home: f.teamH,
      away: f.teamA,
      // Team xG is the better estimator of underlying strength when a caller
      // can supply it (element-summary aggregation, or a historical dataset);
      // goals are the fallback and the default.
      goalsHome: xg ? xg.home : f.teamHScore,
      goalsAway: xg ? xg.away : f.teamAScore,
    });
  }
  return out;
}

function fitRatings(matches, priors, asOfGw, priorMu) {
  const teamIds = [...priors.keys()];
  const weightOf = (event) => Math.pow(0.5, Math.max(0, asOfGw - 1 - event) / RECENCY_HALF_LIFE_GWS);

  let totalWeight = 0;
  let weightedGoals = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  for (const m of matches) {
    const w = weightOf(m.event);
    totalWeight += w;
    weightedGoals += w * (m.goalsHome + m.goalsAway);
    homeGoals += w * m.goalsHome;
    awayGoals += w * m.goalsAway;
  }

  const mu = (weightedGoals + 2 * MU_PRIOR_MATCHES * priorMu) / (2 * (totalWeight + MU_PRIOR_MATCHES));

  // Home advantage as a ratio of home to away scoring, pulled toward the prior
  // by a fixed number of pseudo-matches and then clamped.
  const pseudo = HOME_ADVANTAGE_PRIOR_MATCHES;
  const rawHome = (homeGoals + pseudo * mu * HOME_ADVANTAGE_PRIOR) / (awayGoals + pseudo * mu);
  const homeAdvantage = Math.min(HOME_ADVANTAGE_MAX, Math.max(HOME_ADVANTAGE_MIN, rawHome));

  const attack = new Map();
  const defence = new Map();
  for (const id of teamIds) {
    attack.set(id, priors.get(id).attack);
    defence.set(id, priors.get(id).defence);
  }

  const perTeam = new Map(teamIds.map(id => [id, { scored: 0, conceded: 0, weight: 0 }]));
  for (const m of matches) {
    const w = weightOf(m.event);
    const h = perTeam.get(m.home);
    const a = perTeam.get(m.away);
    if (!h || !a) continue;
    h.scored += w * m.goalsHome;
    h.conceded += w * m.goalsAway;
    h.weight += w;
    a.scored += w * m.goalsAway;
    a.conceded += w * m.goalsHome;
    a.weight += w;
  }

  // Iterative proportional fitting: each pass sets a club's attack to the ratio
  // of what it scored to what an average attack would have scored against the
  // same opponents at the same venues, and likewise for defence. The prior
  // enters as PRIOR_STRENGTH_MATCHES pseudo-matches against an average
  // opponent at a neutral venue.
  const pw = PRIOR_STRENGTH_MATCHES;
  for (let iter = 0; iter < FIT_ITERATIONS; iter++) {
    let maxDelta = 0;
    for (const id of teamIds) {
      let expFor = 0;
      let expAgainst = 0;
      for (const m of matches) {
        const w = weightOf(m.event);
        if (m.home === id) {
          expFor += w * mu * defence.get(m.away) * homeAdvantage;
          expAgainst += w * mu * attack.get(m.away);
        } else if (m.away === id) {
          expFor += w * mu * defence.get(m.home);
          expAgainst += w * mu * attack.get(m.home) * homeAdvantage;
        }
      }
      const t = perTeam.get(id);
      const prior = priors.get(id);
      const nextAttack = clampRating(
        (t.scored + pw * mu * prior.attack) / Math.max(1e-9, expFor + pw * mu),
      );
      const nextDefence = clampRating(
        (t.conceded + pw * mu * prior.defence) / Math.max(1e-9, expAgainst + pw * mu),
      );
      maxDelta = Math.max(maxDelta, Math.abs(nextAttack - attack.get(id)), Math.abs(nextDefence - defence.get(id)));
      attack.set(id, nextAttack);
      defence.set(id, nextDefence);
    }
    if (maxDelta < 1e-9) break;
  }

  // Re-centre. Folding the normalizers into mu keeps every fitted expectation
  // identical while putting the ratings back on a mean-1 scale.
  const ga = geoMean([...attack.values()]);
  const gd = geoMean([...defence.values()]);
  for (const id of teamIds) {
    attack.set(id, clampRating(attack.get(id) / ga));
    defence.set(id, clampRating(defence.get(id) / gd));
  }

  return { attack, defence, mu: mu * ga * gd, homeAdvantage, perTeam };
}

// ---------------------------------------------------------------------------

export function buildStrength(gameState, opts = {}) {
  const gw = opts.asOfGw || gameState.nextEvent || gameState.currentEvent || 1;
  const { priors, priorMu, measurableCount } = buildPrior(gameState);
  const matches = collectMatches(gameState, gw, opts);
  const fit = fitRatings(matches, priors, gw, priorMu);

  const teams = new Map();
  for (const [id, prior] of priors) {
    const played = fit.perTeam.get(id);
    const matchesUsed = matches.filter(m => m.home === id || m.away === id).length;
    teams.set(id, {
      teamId: id,
      attack: fit.attack.get(id),
      defence: fit.defence.get(id),
      priorAttack: prior.attack,
      priorDefence: prior.defence,
      minutes: prior.minutes,
      minutesWeight: prior.minutesWeight,
      promoted: prior.promoted,
      overallStrength: prior.overallStrength,
      xgPerMatch: prior.xgPerMatch,
      xgcPerMatch: prior.xgcPerMatch,
      matchesUsed,
      weightedMatches: played ? played.weight : 0,
      confidence: matchesUsed >= 8 ? 'high' : (prior.promoted && matchesUsed < 4 ? 'low' : 'medium'),
    });
  }

  return {
    asOfGw: gw,
    source: matches.length ? 'fitted' : 'prior',
    leagueMeanGoals: fit.mu,
    homeAdvantage: fit.homeAdvantage,
    matchesUsed: matches.length,
    measurableTeams: measurableCount,
    teams,
    params: STRENGTH_PARAMS,
  };
}

export function ratingFor(strength, teamId) {
  const t = strength.teams.get(teamId);
  if (!t) throw new Error(`strength: unknown team ${teamId}`);
  return { attack: t.attack, defence: t.defence, homeAdv: strength.homeAdvantage };
}
