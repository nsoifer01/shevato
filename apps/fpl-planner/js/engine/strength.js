// Team attack and defence ratings.
//
// The model is multiplicative and centred on 1.0:
//
//   xG(home) = mu * attack(home) * defence(away) * homeAdvantage
//   xG(away) = mu * attack(away) * defence(home)
//
// `attack` is "scoring relative to an average club", `defence` is "conceding
// relative to an average club", so a low defence number is a good defence.
// `mu` is the league's away-side goals per match; the home side scores
// `mu * homeAdvantage`.
//
// Why not just use FPL's own FDR: it is a 1-5 integer per fixture and cannot
// separate "hard because they score a lot" from "hard because they concede
// nothing". A defender's clean-sheet points depend on exactly that distinction.
//
// THE CONSTRUCTION (2026-09-16, registry entry 29)
//
// Until then a club was "measurable" only once its squad had 10,000 minutes of
// THIS season (about ten matches), so from gameweek 1 to gameweek 10 every club
// was flagged promoted, FPL's strength tiers were never read, the squad xG
// prior kept a quarter of its weight, and the ratings were fitted to actual
// GOALS with six pseudo-matches of prior. Four matches of finishing variance
// decided the fixtures: at GW5 of 2026/27 Hull's defence was the fourth best in
// the league on two goals conceded against 1.49 expected a match, and Leeds v
// Palace projected more goals than Man City at home to Sunderland.
//
// It is now built in four steps, every weight fitted leave-one-season-out on
// the archive (scripts/calibration/calibrate-strength.mjs, Poisson
// log-likelihood of every fixture's goals from each deadline, 2023-24 to
// 2025-26), and it beats the old ratings in every held-out season, by about a
// third over the opening ten gameweeks:
//
//   1. LAST SEASON'S SQUAD. Every current player's previous-season xG and xGC,
//      summed by the club he plays for NOW, so a summer's transfers move a
//      club's rating before a ball is kicked. Read relative to the league and
//      damped in log space (attack 0.7, defence 1.2: aggregated xGC
//      under-disperses because transferred players carry their old club's),
//      then weighted by how many Premier League minutes the squad actually has,
//      so a promoted squad falls to a low default instead of to its few
//      loanees.
//   2. THIS SEASON'S SQUAD. The same aggregate over this season's totals,
//      blended in log space with the previous season's worth 16 matches for
//      attack and 12 for defence.
//   3. GOALS, and only a little. Iterative proportional fitting on actual
//      results, recency weighted, with 160 pseudo-matches of step 2 behind
//      every club. Goals carry about 2% of a rating by gameweek 5 and a fifth
//      by the end of a season. Goals alone were far worse than any xG
//      construction.
//   4. THE LEAGUE LEVEL AND HOME ADVANTAGE, each carried from last season (or
//      the prior) as 40 matches and updated by this season's goals.
//
// FPL's `strength_overall_*` tiers are NOT an input: the archived tables are
// end-of-season snapshots on a different scale, so no weight for them can be
// measured, and the live 2026/27 tiers rate the three promoted clubs the same
// as Fulham and Sunderland at home.
//
// Every tunable is a named constant below and is reported on the Strength
// object so the model-status panel can show what was used.

import { fixtureIsPlayed } from './lifecycle.js';
import { rateMinutesOf } from './normalize.js';
import { evidenceView } from './minutes.js';

// --- Model parameters ------------------------------------------------------

// Goals per team match when neither last season nor this one says otherwise.
const LEAGUE_MEAN_GOALS_FALLBACK = 1.45;

// A club match is eleven players for ninety minutes.
const PLAYER_MINUTES_PER_TEAM_MATCH = 990;

// Step 1. Relative squad ratings are clamped before the log so one tiny sample
// cannot produce an unbounded term.
const SQUAD_RELATIVE_MIN = 0.2;
const SQUAD_RELATIVE_MAX = 5;
// Log-space damping of last season's squad aggregate (fitted).
const PRIOR_SQUAD_ATTACK_SCALE = 0.7;
const PRIOR_SQUAD_DEFENCE_SCALE = 1.2;
// Previous-season squad minutes at which the aggregate and the no-history
// default carry equal weight (fitted).
const PRIOR_COVERAGE_MINUTES = 16000;
// Where a squad with no Premier League history lands before normalisation
// (fitted; a promoted club nets about 0.6-0.7 attack and 1.3-1.4 defence).
const NO_HISTORY_ATTACK = 0.4;
const NO_HISTORY_DEFENCE = 2.0;

// Step 2. What step 1 is worth, in this season's matches (fitted).
const PRIOR_ATTACK_MATCHES = 16;
const PRIOR_DEFENCE_MATCHES = 12;

// Step 3. Pseudo-matches of step 2 behind every club when goals are fitted
// (fitted), and the recency half life of a result.
const GOALS_PRIOR_MATCHES = 160;
const RECENCY_HALF_LIFE_GWS = 10;
const FIT_ITERATIONS = 25;

// Step 4. Last season's level and the home-advantage prior, as matches.
const LEVEL_PRIOR_MATCHES = 40;
const HOME_ADVANTAGE_PRIOR = 1.15;
const HOME_ADVANTAGE_PRIOR_MATCHES = 40;
const HOME_ADVANTAGE_MIN = 1.0;
const HOME_ADVANTAGE_MAX = 1.4;

// No club is four times better than another at either end.
const RATING_MIN = 0.35;
const RATING_MAX = 2.2;

// A squad whose previous-season minutes leave it mostly on the no-history
// default is flagged, for the status panel and the tests.
const LOW_HISTORY_COVERAGE = 0.25;

export const STRENGTH_PARAMS = Object.freeze({
  leagueMeanGoalsFallback: LEAGUE_MEAN_GOALS_FALLBACK,
  priorSquadAttackScale: PRIOR_SQUAD_ATTACK_SCALE,
  priorSquadDefenceScale: PRIOR_SQUAD_DEFENCE_SCALE,
  priorCoverageMinutes: PRIOR_COVERAGE_MINUTES,
  noHistoryAttack: NO_HISTORY_ATTACK,
  noHistoryDefence: NO_HISTORY_DEFENCE,
  priorAttackMatches: PRIOR_ATTACK_MATCHES,
  priorDefenceMatches: PRIOR_DEFENCE_MATCHES,
  goalsPriorMatches: GOALS_PRIOR_MATCHES,
  recencyHalfLifeGws: RECENCY_HALF_LIFE_GWS,
  levelPriorMatches: LEVEL_PRIOR_MATCHES,
  homeAdvantagePrior: HOME_ADVANTAGE_PRIOR,
  homeAdvantagePriorMatches: HOME_ADVANTAGE_PRIOR_MATCHES,
  ratingMin: RATING_MIN,
  ratingMax: RATING_MAX,
});

const clampRating = (v) => Math.min(RATING_MAX, Math.max(RATING_MIN, v));
const clampedLog = (v) => Math.log(Math.min(SQUAD_RELATIVE_MAX, Math.max(SQUAD_RELATIVE_MIN, v)));

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

function squadTotals(gameState, totalsOf) {
  const agg = new Map();
  for (const team of gameState.teams.keys()) agg.set(team, { minutes: 0, xg: 0, xgc: 0 });
  for (const p of gameState.players.values()) {
    const row = agg.get(p.teamId);
    const t = totalsOf(p);
    if (!row || !t || !(t.minutes > 0) || t.xG === null || t.xGC === null) continue;
    row.minutes += t.minutes;
    row.xg += t.xG || 0;
    row.xgc += t.xGC || 0;
  }
  return agg;
}

// Each club's rate relative to the league, or null for a club with nothing to
// measure.
function relativeTo(agg) {
  let xg = 0;
  let xgc = 0;
  let minutes = 0;
  for (const v of agg.values()) { xg += v.xg; xgc += v.xgc; minutes += v.minutes; }
  if (minutes <= 0 || xg <= 0 || xgc <= 0) return () => null;
  const refAttack = xg / (minutes / PLAYER_MINUTES_PER_TEAM_MATCH);
  const refDefence = xgc / (minutes / 90);
  return (teamId) => {
    const v = agg.get(teamId);
    if (!v || v.minutes <= 0) return null;
    return {
      attack: (v.xg / (v.minutes / PLAYER_MINUTES_PER_TEAM_MATCH)) / refAttack,
      defence: (v.xgc / (v.minutes / 90)) / refDefence,
      minutes: v.minutes,
    };
  };
}

/** Per club: minutes, xG per match and xGC per match of the payload's own totals. */
export function aggregateSquadXg(gameState) {
  const agg = squadTotals(gameState, (p) => ({ minutes: rateMinutesOf(p), xG: p.xG, xGC: p.xGC }));
  const out = new Map();
  for (const [teamId, row] of agg) {
    const teamMatches = row.minutes / PLAYER_MINUTES_PER_TEAM_MATCH;
    const playerNineties = row.minutes / 90;
    out.set(teamId, {
      minutes: row.minutes,
      xgPerMatch: teamMatches > 0 ? row.xg / teamMatches : null,
      xgcPerMatch: playerNineties > 0 ? row.xgc / playerNineties : null,
    });
  }
  return out;
}

function arithmeticNormalise(ratings) {
  let sa = 0;
  let sd = 0;
  for (const r of ratings.values()) { sa += r.attack; sd += r.defence; }
  const n = ratings.size || 1;
  const out = new Map();
  for (const [id, r] of ratings) {
    out.set(id, { attack: clampRating(r.attack / (sa / n)), defence: clampRating(r.defence / (sd / n)) });
  }
  return out;
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
    // and stat corrections, which do not change who scored.
    if (!fixtureIsPlayed(f)) continue;
    if (f.teamHScore === null || f.teamAScore === null) continue;
    const xg = teamXg ? teamXg.get(f.id) : null;
    out.push({
      event: f.event,
      home: f.teamH,
      away: f.teamA,
      // A caller that can supply per-fixture team xG (a historical dataset)
      // may fit on it; production fits on goals.
      goalsHome: xg ? xg.home : f.teamHScore,
      goalsAway: xg ? xg.away : f.teamAScore,
    });
  }
  return out;
}

function fitOnResults(matches, prior, { awayLevel, homeAdvantage, asOfGw }) {
  const ids = [...prior.keys()];
  const attack = new Map(ids.map(id => [id, prior.get(id).attack]));
  const defence = new Map(ids.map(id => [id, prior.get(id).defence]));
  const byTeam = new Map(ids.map(id => [id, []]));
  for (const m of matches) {
    const w = Math.pow(0.5, Math.max(0, asOfGw - 1 - m.event) / RECENCY_HALF_LIFE_GWS);
    if (byTeam.has(m.home)) byTeam.get(m.home).push({ opp: m.away, home: true, w, scored: m.goalsHome, conceded: m.goalsAway });
    if (byTeam.has(m.away)) byTeam.get(m.away).push({ opp: m.home, home: false, w, scored: m.goalsAway, conceded: m.goalsHome });
  }
  // A pseudo-match against an average opponent at a neutral venue.
  const averageLevel = awayLevel * (1 + homeAdvantage) / 2;
  const pw = GOALS_PRIOR_MATCHES;
  for (let iter = 0; iter < FIT_ITERATIONS; iter++) {
    for (const id of ids) {
      let scored = 0;
      let conceded = 0;
      let expectedFor = 0;
      let expectedAgainst = 0;
      for (const e of byTeam.get(id)) {
        if (!attack.has(e.opp)) continue;
        scored += e.w * e.scored;
        conceded += e.w * e.conceded;
        expectedFor += e.w * awayLevel * defence.get(e.opp) * (e.home ? homeAdvantage : 1);
        expectedAgainst += e.w * awayLevel * attack.get(e.opp) * (e.home ? 1 : homeAdvantage);
      }
      const p = prior.get(id);
      attack.set(id, clampRating((scored + pw * averageLevel * p.attack) / Math.max(1e-9, expectedFor + pw * averageLevel)));
      defence.set(id, clampRating((conceded + pw * averageLevel * p.defence) / Math.max(1e-9, expectedAgainst + pw * averageLevel)));
    }
  }
  const out = new Map();
  for (const id of ids) out.set(id, { attack: attack.get(id), defence: defence.get(id) });
  return out;
}

// ---------------------------------------------------------------------------

export function buildStrength(gameState, opts = {}) {
  const gw = opts.asOfGw || gameState.nextEvent || gameState.currentEvent || 1;
  const view = evidenceView(gameState);
  const teamIds = [...gameState.teams.keys()];

  // Step 1: last season's squad, by current club.
  const priorAgg = squadTotals(gameState, (p) => view.priorOf(p));
  const priorRel = relativeTo(priorAgg);
  // Step 2: this season's squad.
  const currentAgg = squadTotals(gameState, (p) => view.currentOf(p));
  const currentRel = relativeTo(currentAgg);

  const matches = collectMatches(gameState, gw, opts);
  const matchesByTeam = new Map(teamIds.map(id => [id, 0]));
  for (const m of matches) {
    if (matchesByTeam.has(m.home)) matchesByTeam.set(m.home, matchesByTeam.get(m.home) + 1);
    if (matchesByTeam.has(m.away)) matchesByTeam.set(m.away, matchesByTeam.get(m.away) + 1);
  }

  const detail = new Map();
  const squadRatings = new Map();
  for (const id of teamIds) {
    const r = priorRel(id);
    const coverage = r ? r.minutes / (r.minutes + PRIOR_COVERAGE_MINUTES) : 0;
    let logAttack = (r ? coverage * PRIOR_SQUAD_ATTACK_SCALE * clampedLog(r.attack) : 0)
      + (1 - coverage) * Math.log(NO_HISTORY_ATTACK);
    let logDefence = (r ? coverage * PRIOR_SQUAD_DEFENCE_SCALE * clampedLog(r.defence) : 0)
      + (1 - coverage) * Math.log(NO_HISTORY_DEFENCE);
    const priorAttack = Math.exp(logAttack);
    const priorDefence = Math.exp(logDefence);
    const c = currentRel(id);
    const n = view.preseason ? 0 : matchesByTeam.get(id);
    if (c && n > 0) {
      logAttack = (PRIOR_ATTACK_MATCHES * logAttack + n * clampedLog(c.attack)) / (PRIOR_ATTACK_MATCHES + n);
      logDefence = (PRIOR_DEFENCE_MATCHES * logDefence + n * clampedLog(c.defence)) / (PRIOR_DEFENCE_MATCHES + n);
    }
    squadRatings.set(id, { attack: Math.exp(logAttack), defence: Math.exp(logDefence) });
    detail.set(id, {
      priorAttack,
      priorDefence,
      priorMinutes: r ? r.minutes : 0,
      coverage,
      currentAttack: c ? c.attack : null,
      currentDefence: c ? c.defence : null,
      currentMinutes: c ? c.minutes : 0,
    });
  }
  const squad = arithmeticNormalise(squadRatings);

  // Step 4 first, because the fit reads it: the league level and home
  // advantage, last season's level carried as LEVEL_PRIOR_MATCHES matches.
  const priorLevel = (gameState.priorSeason && gameState.priorSeason.goalsPerTeamMatch)
    || previousSeasonGoalLevel(gameState, view)
    || LEAGUE_MEAN_GOALS_FALLBACK;
  let goals = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  for (const m of matches) {
    goals += m.goalsHome + m.goalsAway;
    homeGoals += m.goalsHome;
    awayGoals += m.goalsAway;
  }
  const level = (goals + 2 * LEVEL_PRIOR_MATCHES * priorLevel) / (2 * (matches.length + LEVEL_PRIOR_MATCHES));
  const priorAwayLevel = 2 * priorLevel / (1 + HOME_ADVANTAGE_PRIOR);
  const rawHome = (homeGoals + HOME_ADVANTAGE_PRIOR_MATCHES * priorAwayLevel * HOME_ADVANTAGE_PRIOR)
    / (awayGoals + HOME_ADVANTAGE_PRIOR_MATCHES * priorAwayLevel);
  const homeAdvantage = Math.min(HOME_ADVANTAGE_MAX, Math.max(HOME_ADVANTAGE_MIN, rawHome));
  const awayLevel = 2 * level / (1 + homeAdvantage);

  // Step 3: goals, with step 2 behind every club.
  const fitted = matches.length
    ? arithmeticNormalise(fitOnResults(matches, squad, { awayLevel, homeAdvantage, asOfGw: gw }))
    : squad;

  const teams = new Map();
  for (const id of teamIds) {
    const d = detail.get(id);
    const matchesUsed = matchesByTeam.get(id);
    const lowHistory = d.coverage < LOW_HISTORY_COVERAGE;
    teams.set(id, {
      teamId: id,
      attack: fitted.get(id).attack,
      defence: fitted.get(id).defence,
      squadAttack: squad.get(id).attack,
      squadDefence: squad.get(id).defence,
      priorAttack: d.priorAttack,
      priorDefence: d.priorDefence,
      priorMinutes: d.priorMinutes,
      priorCoverage: d.coverage,
      currentAttack: d.currentAttack,
      currentDefence: d.currentDefence,
      minutes: d.currentMinutes,
      // "Promoted" in the only sense the model can see: a squad with too few
      // Premier League minutes last season to rate from them.
      promoted: lowHistory,
      matchesUsed,
      confidence: matchesUsed >= 8 ? 'high' : (lowHistory && matchesUsed < 4 ? 'low' : 'medium'),
    });
  }

  return {
    asOfGw: gw,
    source: matches.length ? 'fitted' : 'prior',
    leagueMeanGoals: awayLevel,
    homeAdvantage,
    matchesUsed: matches.length,
    teams,
    params: STRENGTH_PARAMS,
  };
}

// Before a ball is kicked the payload's own totals are last season's, so the
// league level can be read off them the same way the snapshot's is.
function previousSeasonGoalLevel(gameState, view) {
  let goals = 0;
  let minutes = 0;
  for (const p of gameState.players.values()) {
    const t = view.priorOf(p);
    if (!t || !(t.minutes > 0) || t.goalsScored === null || t.goalsScored === undefined) continue;
    goals += (t.goalsScored || 0) + (t.ownGoals || 0);
    minutes += t.minutes;
  }
  return minutes > 0 && goals > 0 ? goals / (minutes / PLAYER_MINUTES_PER_TEAM_MATCH) : null;
}

export function ratingFor(strength, teamId) {
  const t = strength.teams.get(teamId);
  if (!t) throw new Error(`strength: unknown team ${teamId}`);
  return { attack: t.attack, defence: t.defence, homeAdv: strength.homeAdvantage };
}
