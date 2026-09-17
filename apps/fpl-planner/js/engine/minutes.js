// Expected minutes.
//
// Minutes dominate FPL scoring. Every other component of a projection is
// multiplied by them, so a 6.0 expected-points player who starts 60% of the
// time is not a 6.0 expected-points player, and a model that quietly assumes 90
// minutes for everyone will recommend transfers for players who are on the
// bench.
//
// THE SHAPE OF THE MODEL. A player's gameweek is one of three mutually
// exclusive outcomes, and expected minutes is the mixture over them:
//
//   pStart   he is in the starting eleven, and then plays xMinsIfStart
//   pBench   he starts on the bench and gets on, and then plays xMinsIfBench
//   pNone    he does not appear at all, and then plays nothing
//
//   pStart + pBench + pNone = 1
//   xMins = pStart * xMinsIfStart + pBench * xMinsIfBench
//
// The output is a per-FIXTURE profile:
//
//   pStart   probability the player is in the starting eleven
//   pAppear  pStart + pBench, the probability he plays at all
//   p60      probability the player reaches 60 minutes, which is the threshold
//            for the second appearance point and for clean-sheet points
//   xMins    as above, and identically
//            pStart * meanStarterMinutes + (pAppear - pStart) * meanSubMinutes
//
// THE INVARIANT: 0 <= pStart <= pAppear <= 1. It holds by construction rather
// than by clamping. The base appearance chance is assembled as
// `baseStart + (1 - baseStart) * pSubOn`, which cannot fall below baseStart or
// rise above 1 for any pair in [0,1], and availability then scales BOTH by the
// same factor, which preserves the ordering and keeps pAppear under the
// published chance of playing. The property test hammers this with randomized
// inputs, including payloads whose minutes and starts contradict each other.
//
// AVAILABILITY. `status` i/s/u/n means injured, suspended, unavailable and not
// in the squad. Any of those forces pAppear to 0. `d` (doubtful) does not: it
// scales availability, either by `chance_of_playing_next_round` when FPL has
// published one or by DOUBTFUL_DEFAULT_AVAILABILITY when it has not.
// `chance_of_playing_next_round` is treated as a hard ceiling on pAppear for
// THE GAMEWEEK IT DESCRIBES, so a 25% chance overrides a 95% historical start
// rate rather than averaging with it.
//
// AVAILABILITY OVER A HORIZON. The published number is, by its own name, the
// chance of playing in the NEXT round. Carrying it unchanged to the gameweek
// after that asserts the injury never heals, which is measurably false: across
// 2022-23, 2023-24 and 2024-25 the doubt attached to a player who missed his
// club's last match shrinks by a factor of 0.92 per gameweek (the ratio of
// remaining doubt was 0.916, 0.927 and 0.918 one gameweek out, and 0.855,
// 0.860 and 0.856 two gameweeks out, against 0.92 squared = 0.846). So the
// ceiling recovers geometrically with distance, and only with distance: the
// gameweek being decided is never relaxed. Injuries are stubborn, and this
// number says so, it does not wave them away.
//
// THE START MODEL (2026-09-16, registry entry 29). A player's chance of
// starting is a Beta-style posterior: his club matches this season (m) and his
// starts in them (s), against a prior mean (mu) worth K matches:
//
//   pStart = (s + K * mu) / (m + K)
//
// With a previous season, mu is last season's start rate (shrunk toward that
// season's position rate by START_PRIOR_SEASON_SHRINK matches) mapped through a
// calibration measured on opening gameweeks, and K = 0.5 + 0.15 * m. Without
// one, mu comes from his price percentile within his position and
// K = 0.75 + 0.05 * m. K GROWS with the season: the per-bucket optimum rose in
// every archived season (0.5-0.75 over gameweeks 1-3, 1.5 over 4-8, 2-3 over
// 9-19, 2.5-5 after), because a prior that describes the player keeps earning
// weight while a few matches of this season are noise.
//
// THE MODEL IT REPLACED shrank the observed rate toward the POSITION's league
// start rate with a fixed six matches, the league rate being measured over
// every player with a minute to his name, substitutes and cameos included. With
// three or four matches of evidence that put 60% of every player's probability
// on a pool that starts 40-60% of the time, so from gameweek 4 of 2026/27 an
// ever-present was a 0.64 (forward) to 0.76 (defender) start, against 0.88 to
// 0.93 measured. Held out over three seasons the new model's log loss is 0.3464
// against 0.3507 (0.3566 against 0.4462 in gameweeks 1-3), and ever-presents
// read 0.908 / 0.877 / 0.873 / 0.874 (GK/DEF/MID/FWD) against 0.948 / 0.881 /
// 0.846 / 0.894 actual (scripts/calibration/calibrate-minutes.mjs).
//
// NO MINUTES AT ALL. A player with no previous season is priced off his price
// percentile, which is the only pre-season signal there is, and the same K
// decides how fast "still on zero after m matches" overtakes it.

import { assessBaseline, baselineIsSuperseded } from './baseline.js';
import { matchesPlayedByClub, matchesKickedOffByClub } from './lifecycle.js';

const UNAVAILABLE_STATUSES = new Set(['i', 's', 'u', 'n']);
const DOUBTFUL_STATUS = 'd';

// FPL flags a player doubtful without a percentage often enough that this needs
// a value. Half is deliberately blunt: the honest answer is "we do not know",
// and the projection is flagged low confidence so the UI can say so.
const DOUBTFUL_DEFAULT_AVAILABILITY = 0.5;

// The starter- and substitute-minutes estimators shrink toward the position
// prior by these many starts and appearances.
const STARTER_MINUTES_SHRINK_STARTS = 5;
const SUB_MINUTES_SHRINK_APPS = 4;

// --- The start model (see the header), every value fitted leave-one-season-out.
// Last season's start rate is shrunk toward that season's position rate by
// this many matches before it becomes a prior.
const START_PRIOR_SEASON_SHRINK = 2;
// ...and mapped through logit(mu) = a + b * logit(raw), fitted on gameweek 1
// rows, where the prior is the whole prediction. b < 1 because last season
// overstates both ends: 30-38 starts read 0.63 raw against 0.774 started.
const START_PRIOR_CALIBRATION = Object.freeze({ a: -0.1, b: 0.7 });
// K = base + perMatch * m, with and without a previous season.
const START_CARRY = Object.freeze({ base: 0.5, perMatch: 0.15 });
const NO_HISTORY_CARRY = Object.freeze({ base: 0.75, perMatch: 0.05 });

// --- Appearing from the bench.
//
// THE DEFECT THIS REPLACES. The rate a player comes on in the matches he does
// not start was inferred as inferredSubApps / max(1, m - s). For a player who
// has started every match m - s is ZERO, so the rate was 0 and pAppear equalled
// pStart: from gameweek 4 of 2026/27 Saka (four starts in four) could not come
// off the bench at all while Mac Allister (two starts, two appearances as a
// substitute) was a certain appearance, pAppear 1.000. No opportunities is no
// evidence, not evidence of never.
//
// NOW. The inferred appearances are shrunk toward a measured prior worth
// SUB_ON_PRIOR_OPPORTUNITIES opportunities, with last season's inferred
// appearances counted at SUB_ON_LAST_SEASON_WEIGHT:
//
//   subOn = (apps + 0.05 * appsLast + 40 * q) / (n + 0.05 * nLast + 40)
//
// q is P(appears | did not start) by position and start probability, measured
// on the archive and forced non-decreasing in the start probability, which is
// what makes the inversion structurally impossible: a likelier starter never
// gets a lower prior. A player with NO minutes this season after at least one
// club match takes SUB_ON_UNUSED instead, because not being used at all is
// evidence the bins cannot see. Held out: sub-on log loss 0.7088 to 0.3230,
// ever-present pAppear 0.811 to 0.951 (0.932 actual), and the cells in which
// rotation players out-appeared ever-presents by more than two points fell from
// 18 of 267 to none.
const SUB_ON_PRIOR_OPPORTUNITIES = 40;
const SUB_ON_LAST_SEASON_WEIGHT = 0.05;
// A substitute appearance is 18.18 minutes long on average (fitted).
const SUB_SPELL_MINUTES = 18.18;
const SUB_ON_START_BINS = Object.freeze([0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85]);
const SUB_ON_PRIOR = Object.freeze({
  1: [0.0026, 0.0090, 0.0090, 0.0090, 0.0090, 0.0090, 0.0108],
  2: [0.0322, 0.1178, 0.2174, 0.2174, 0.2337, 0.2337, 0.2337],
  3: [0.0559, 0.2367, 0.3893, 0.4444, 0.4444, 0.4444, 0.4444],
  4: [0.0859, 0.2527, 0.4690, 0.5046, 0.5046, 0.5046, 0.5046],
});
// By club matches played: 1-2, 3-5, 6-10, 11 or more.
const SUB_ON_UNUSED_BUCKETS = Object.freeze([[1, 2], [3, 5], [6, 10], [11, Infinity]]);
const SUB_ON_UNUSED = Object.freeze({
  1: [0.0031, 0.0020, 0.0025, 0.0026],
  2: [0.0793, 0.0389, 0.0171, 0.0118],
  3: [0.1036, 0.0577, 0.0216, 0.0112],
  4: [0.0731, 0.0480, 0.0226, 0.0159],
});

// --- Reaching the hour.
//
// P(60+ minutes | started) was logistic((meanStarterMinutes - 60) / 12) for
// every position, about 0.87-0.90 for a regular. Measured on the archive it is
// 0.991 for a goalkeeper, 0.946 for a defender, 0.910 for a midfielder and
// 0.919 for a forward, and for the two outfield lines where the starter's
// usual minutes separate players a steeper curve fits (held-out log loss DEF
// 0.2346 to 0.2073, MID 0.3079 to 0.2973, GK 0.1337 to 0.0531). A forward's
// logistic was unstable across folds and no better than the constant.
const P60_GIVEN_START = Object.freeze({
  1: { constant: 0.99 },
  2: { midpoint: 66, scale: 6 },
  3: { midpoint: 68, scale: 6 },
  4: { constant: 0.92 },
});
// And a substitute almost never reaches it (goalkeepers from 33 appearances).
const P60_GIVEN_SUB = Object.freeze({ 1: 0.09, 2: 0.024, 3: 0.010, 4: 0.007 });
// Measured minutes in the branches the projection mixes over.
const START_UNDER_60_MINUTES = Object.freeze({ 1: 40.5, 2: 44.4, 3: 48.0, 4: 49.0 });
const SUB_OVER_60_MINUTES = 70;

// Fallback position priors, used only when the payload cannot supply them
// (which happens only in tests with a handful of players). The real priors are
// measured from the league in `positionPriors`.
const FALLBACK_PRIORS = {
  startRate: 0.35,
  starterMinutes: 80,
  subMinutes: SUB_SPELL_MINUTES,
  subOnRate: 0.25,
};

// A player with no previous season is either a promoted-club regular, a new
// signing or a youth player. Price is the signal available: FPL prices a
// first-choice striker at a promoted club well above a third-choice keeper.
// The prior mean interpolates between these two by the player's price
// percentile within his position (fitted; a regular/fringe mixture and a
// position constant were both worse held out).
const NO_HISTORY_MIN_START = 0.08;
const NO_HISTORY_MAX_START = 0.60;

// Rotation in a double gameweek. Two matches in one week measurably lowers the
// chance of starting any individual one of them.
const CONGESTION_START_FACTOR = 0.9;

// How much of an availability doubt survives one more gameweek of distance.
// Measured, not chosen: see the header. It is applied only to gameweeks beyond
// the one being decided, and needs `gameState.nextEvent` to know which that is.
const HORIZON_DOUBT_DECAY = 0.92;

export const MINUTES_PARAMS = Object.freeze({
  horizonDoubtDecay: HORIZON_DOUBT_DECAY,
  doubtfulDefaultAvailability: DOUBTFUL_DEFAULT_AVAILABILITY,
  starterMinutesShrinkStarts: STARTER_MINUTES_SHRINK_STARTS,
  subMinutesShrinkApps: SUB_MINUTES_SHRINK_APPS,
  startPriorSeasonShrink: START_PRIOR_SEASON_SHRINK,
  startPriorCalibration: START_PRIOR_CALIBRATION,
  startCarry: START_CARRY,
  noHistoryCarry: NO_HISTORY_CARRY,
  noHistoryMinStart: NO_HISTORY_MIN_START,
  noHistoryMaxStart: NO_HISTORY_MAX_START,
  subOnPriorOpportunities: SUB_ON_PRIOR_OPPORTUNITIES,
  subOnLastSeasonWeight: SUB_ON_LAST_SEASON_WEIGHT,
  subSpellMinutes: SUB_SPELL_MINUTES,
  subOnPrior: SUB_ON_PRIOR,
  subOnStartBins: SUB_ON_START_BINS,
  subOnUnused: SUB_ON_UNUSED,
  subOnUnusedBuckets: SUB_ON_UNUSED_BUCKETS,
  p60GivenStart: P60_GIVEN_START,
  p60GivenSub: P60_GIVEN_SUB,
  startUnder60Minutes: START_UNDER_60_MINUTES,
  subOver60Minutes: SUB_OVER_60_MINUTES,
  congestionStartFactor: CONGESTION_START_FACTOR,
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const logistic = (x) => 1 / (1 + Math.exp(-x));

const logit = (p) => Math.log(p / (1 - p));

// P(a player who starts is still on after 60 minutes), by position and from his
// typical starter minutes (P60_GIVEN_START). A caller with no position gets the
// midfield curve, the middle of the measured range.
export function p60GivenStart(position, meanStarterMinutes) {
  const rule = P60_GIVEN_START[position] || P60_GIVEN_START[3];
  if (rule.constant !== undefined) return rule.constant;
  return clamp01(logistic((meanStarterMinutes - rule.midpoint) / rule.scale));
}

// P(a substitute plays 60 minutes or more), by position.
export function p60GivenSub(position) {
  return P60_GIVEN_SUB[position] !== undefined ? P60_GIVEN_SUB[position] : P60_GIVEN_SUB[3];
}

// ---------------------------------------------------------------------------
// Position priors, measured from the league itself rather than assumed.
//
// Cached per GameState because the calculation walks every player and the
// projection loop asks for it once per player per gameweek.
// ---------------------------------------------------------------------------

const priorCache = new WeakMap();

export function positionPriors(gameState) {
  const cached = priorCache.get(gameState);
  if (cached) return cached;

  const evidence = seasonEvidence(gameState);
  const byPosition = new Map();
  for (const p of gameState.players.values()) {
    if (!byPosition.has(p.position)) {
      byPosition.set(p.position, { starts: 0, minutes: 0, players: 0, active: 0, matches: 0 });
    }
    const row = byPosition.get(p.position);
    row.players++;
    if (p.minutes > 0) {
      row.active++;
      row.starts += p.starts;
      row.minutes += p.minutes;
      // The same denominator each player's own rate is read against, so the
      // position prior cannot drift away from the players it is a prior for.
      row.matches += evidenceMatchesFor(p, defaultEvidenceMatches(evidence, p.teamId));
    }
  }

  const priors = new Map();
  for (const [position, row] of byPosition) {
    if (!row.active || !row.matches) {
      priors.set(position, { ...FALLBACK_PRIORS });
      continue;
    }
    const startRate = row.starts / row.matches;
    // Minutes not accounted for by starts are bench minutes. Splitting the
    // total this way avoids needing an appearance count the API does not give.
    const starterMinutes = row.starts > 0
      ? Math.min(90, (row.minutes * 0.92) / row.starts)
      : FALLBACK_PRIORS.starterMinutes;
    const subMinutes = FALLBACK_PRIORS.subMinutes;
    priors.set(position, {
      startRate: clamp01(startRate),
      starterMinutes,
      subMinutes,
      subOnRate: FALLBACK_PRIORS.subOnRate,
    });
  }

  const result = {
    priors,
    teamMatches: evidence.teamMatches,
    evidence,
    matchesByTeam: matchesPlayedByClub(gameState),
    priceBands: priceBands(gameState),
  };
  priorCache.set(gameState, result);
  return result;
}

// How many matches a player's season totals actually cover.
//
// On a live payload this is the number of matches his league has played, and
// there is nothing else it could be: FPL resets every element's totals in
// August, so `starts` and `minutes` describe this season and only this season.
//
// A caller that assembles a player's totals from more than one season MUST say
// how many matches went into them, by setting `evidenceMatches`. The historical
// replay does exactly that: it seeds half of the previous season into the
// totals, so a returning player carries 19 matches of evidence before a ball is
// kicked. Reading those totals against this season's match count instead is how
// a start rate of 5.5 became a pStart of 1.000 for 89% of the owned pool at
// gameweek 3, which is the state this replay was in until 2026-08-12.
//
// The rule, in one line: whoever builds the numerator owns the denominator.
export function evidenceMatchesFor(player, teamMatches) {
  const declared = player && player.evidenceMatches;
  return Number.isFinite(declared) && declared > 0 ? declared : teamMatches;
}

// The denominator for a player who does not declare his own. In a season of
// its own it is the matches HIS CLUB's totals cover (`matchesByClub` from
// `seasonEvidence`: every match the club has kicked off, a provisional full
// time and a match in play included), not the league's most: clubs do not move through a gameweek together, so a single league-wide
// count reads every club that has not kicked off yet, or has a blank, against a
// match it never played. Last season's totals, and a payload with no evidence,
// are read over a full season as before.
function defaultEvidenceMatches(evidence, teamId) {
  if (!evidence.matchesByClub) return evidence.teamMatches;
  return evidence.matchesByClub.get(teamId) || 0;
}

// WHICH SEASON THE ELEMENT TOTALS BELONG TO, decided from the payload itself.
//
// A start rate is `starts / matches`. The numerator is a season total on the
// bootstrap; the denominator is the count of finished fixtures. FPL rolls those
// two over at different moments, so around the first gameweek they routinely
// describe DIFFERENT seasons, and reading them together is silently wrong in
// both directions:
//
//   totals still last season's, one fixture finished -> 34 starts over 1 match,
//     which clamps to a start probability of 1.000 for most of the owned pool
//     and inflates every projection built on it.
//   totals already rolled to zero, nothing finished  -> every rate is 0 over a
//     full season, the per-90 priors collapse with them, and the planner
//     confidently recommends a squad projecting about a third of a real
//     gameweek, captaining whoever is likeliest to appear (a goalkeeper).
//
// Neither is detectable from legality: both keep every probability inside [0,1]
// and every projection finite. What separates them is an arithmetic fact about
// the sport - a player cannot have started more matches than his club has
// played - so that is what this checks, rather than a date or a gameweek number.
//
// WHICH MATCHES THAT FACT IS CHECKED AGAINST (found 2026-09-13). The bound is
// the matches his club has KICKED OFF, not the matches it has played out,
// because FPL credits a start at kickoff. Checked against played-out matches,
// every live match put its ever-present starters one start over the line,
// twelve of them were enough, and the whole pool was read as last season's:
// every start rate was divided by 38 instead of 4 and the best eleven in the
// game projected 6.4. That happened in every GW4 match window from the first
// kickoff after the baseline retired (2026-09-12 14:00 UTC). It could not
// happen in GW2 or GW3 because the baseline overlay had already put the payload
// in the previous-season shape on purpose, with every player declaring his own
// denominator.
export function seasonEvidence(gameState) {
  // Two counts, because two different questions are asked of the fixture list.
  // `played` is the lifecycle question (has a match been played out) and
  // chooses the branch exactly as before. `covered` is the arithmetic one
  // (which matches do the totals already include) and is the only count a
  // season total is ever compared with or divided by.
  const played = matchesPlayedByClub(gameState);
  const covered = matchesKickedOffByClub(gameState);
  let maxPlayed = 0;
  for (const n of played.values()) if (n > maxPlayed) maxPlayed = n;

  let impossible = 0;
  let withMinutes = 0;
  const mostStarts = new Map();
  for (const p of gameState.players.values()) {
    if (p.minutes > 0) withMinutes++;
    mostStarts.set(p.teamId, Math.max(mostStarts.get(p.teamId) || 0, p.starts || 0));
    const kickedOff = covered.get(p.teamId) || 0;
    // The claim only means anything once his club has actually kicked off, and
    // one player over the line is noise: a squad's worth of them is a season
    // boundary. `starts` is the cleanest signal because it is bounded by
    // matches by construction; minutes are bounded by 90 per match, so they
    // catch the same thing when a payload omits starts.
    const ceiling = kickedOff + TOTALS_LEAD_TOLERANCE_MATCHES;
    if (kickedOff > 0 && ((p.starts || 0) > ceiling || p.minutes > ceiling * 90 + 30)) impossible++;
  }

  // The matches each club's totals cover, which is what its players are read
  // over. Normally that is the kicked-off count. When the fixture list is behind
  // the totals by the one match the tolerance allows - a club's starters already
  // credited with a match its fixture list still calls upcoming - the totals are
  // the fresher of the two, and the club is read over that match as well, so a
  // stale cache changes nobody's rate and nobody's position prior. Never more
  // than one match, so a single corrupt total cannot drag its club along.
  const clubMatches = new Map();
  for (const [team, kickedOff] of covered) {
    const lead = Math.max(0, (mostStarts.get(team) || 0) - kickedOff);
    clubMatches.set(team, kickedOff + Math.min(lead, TOTALS_LEAD_TOLERANCE_MATCHES));
  }
  let maxCovered = 0;
  for (const n of clubMatches.values()) if (n > maxCovered) maxCovered = n;

  const totalEvents = gameState.rules.totalEvents;

  // A PREVIOUS SEASON ATTACHED AS A PRIOR (normalize.js, 2026-09-16) makes a
  // thin current season usable: every player is read as his previous season
  // updated by whatever this season has shown, so a club that has not played
  // yet is not an inversion but a prior with nothing added to it, and a player
  // who has just played has one match of evidence rather than one match of
  // everything. Totals that outrun the fixtures (a payload that is itself last
  // season's) never carry a prior, which the resolver guarantees, so that
  // branch below is unchanged.
  const priorInForce = !!gameState.priorSeason;
  const withPrior = (extra) => ({
    kind: 'current-season',
    usable: true,
    teamMatches: maxCovered,
    matchesByClub: clubMatches,
    finishedMatches: maxPlayed,
    impossible,
    prior: true,
    message: null,
    ...extra,
  });

  // Nothing has been played AND nobody carries a minute: there is no evidence in
  // this payload at all, from either season.
  if (maxPlayed === 0 && withMinutes === 0) {
    if (priorInForce && impossible < IMPOSSIBLE_STARTS_QUORUM) return withPrior();
    return {
      kind: 'none',
      usable: false,
      teamMatches: totalEvents,
      finishedMatches: 0,
      message: 'This payload carries no played minutes and no finished fixtures, so there is nothing to project from yet.',
    };
  }

  // Totals that outrun the fixtures played are last season's. Measure them over
  // a full season, which is the denominator they were accumulated against.
  if (impossible >= IMPOSSIBLE_STARTS_QUORUM) {
    return {
      kind: 'previous-season',
      usable: true,
      teamMatches: totalEvents,
      finishedMatches: maxPlayed,
      impossible,
      message: 'Player totals still describe last season, so they are read against a full season rather than the fixtures played so far.',
    };
  }

  if (maxPlayed === 0) {
    // Totals exist and nothing has been played out, which has two causes that
    // look alike from the fixture list alone and mean opposite things.
    //
    // Pre-season the totals are LAST season's and most of the pool carries
    // minutes (400 of 600 on the morning of 2026-08-21). Read against a full
    // season they are the best evidence available and the plan is sound.
    //
    // Once FPL clears the totals at the rollover, almost nobody carries a
    // minute (22 of 600 that same evening). Reading THAT against a full season
    // makes the pool non-starters, collapses every projection, and inverts the
    // advice: a player who has just started a match measures one start in
    // thirty-eight while one who has never played keeps an untouched price
    // prior. Having played must never be evidence against a player.
    //
    // `assessBaseline` is the shared judgement of whether a payload is a
    // season at all, so the classifier, the snapshot layer and the health
    // probe cannot disagree about it.
    const assessment = assessBaseline(gameState);
    if (!assessment.complete) {
      if (priorInForce) return withPrior({ assessment });
      return {
        kind: 'none',
        usable: false,
        teamMatches: totalEvents,
        finishedMatches: 0,
        impossible,
        assessment,
        message: 'Fantasy Premier League has cleared last season\'s player totals for the new season, '
          + 'so there is not yet enough of this season to project from.',
      };
    }
    // Totals exist but nothing has been played: the ordinary pre-season shape.
    return {
      kind: 'previous-season',
      usable: true,
      teamMatches: totalEvents,
      finishedMatches: 0,
      impossible,
      assessment,
      message: 'No fixture has been played yet, so last season\'s totals are read against a full season.',
    };
  }

  // Some clubs have played. If the totals are still too thin to be a season in
  // their own right AND the clubs are not level, the pool is not comparable:
  // one club's players carry observed rates while eighteen clubs carry priors.
  // That is the same inversion measured against a smaller denominator, so it is
  // refused for the same reason.
  {
    const assessment = assessBaseline(gameState);
    // Have all the clubs played the same number of matches? Until they have,
    // players are being measured against different denominators.
    let minPlayed = Infinity;
    for (const team of gameState.teams.keys()) minPlayed = Math.min(minPlayed, played.get(team) || 0);
    const levelClubs = Number.isFinite(minPlayed) && minPlayed === maxPlayed;
    if (!assessment.complete && !baselineIsSuperseded(gameState)) {
      if (priorInForce) return withPrior({ assessment });
      return {
        kind: 'partial-season',
        usable: false,
        teamMatches: maxCovered,
        matchesByClub: clubMatches,
        finishedMatches: maxPlayed,
        impossible,
        assessment,
        // Two different situations reach here and the sentence has to match the
        // one in front of the reader. Early in a gameweek the clubs are uneven,
        // which is the inversion risk; once a gameweek completes they are level
        // and the problem is simply that one or two matches is not enough to
        // project from. Saying "the clubs have not played the same number" to
        // someone whose gameweek has finished is just wrong.
        message: levelClubs
          ? `This season is only ${maxPlayed} ${maxPlayed === 1 ? 'match' : 'matches'} old, which is not yet `
            + 'enough of it to project from.'
          : 'This season is only a few matches old and the clubs have not played the same number of games, '
            + 'so the player totals are not yet comparable across the league.',
      };
    }
  }

  return {
    kind: 'current-season',
    usable: true,
    // The league's most, for display; every player is read against his own
    // club's count through `matchesByClub`.
    teamMatches: maxCovered,
    matchesByClub: clubMatches,
    finishedMatches: maxPlayed,
    impossible,
    prior: priorInForce,
    message: null,
  };
}

// How many players have to claim more starts than their club has played before
// the payload is called a previous season's. One is a data quirk; a quorum is a
// season boundary. Deliberately small: at a real rollover essentially the whole
// pool trips it at once.
const IMPOSSIBLE_STARTS_QUORUM = 12;

// How far a club's element totals may run ahead of the fixture list before a
// player counts towards that quorum: one match. `bootstrap-static` and
// `fixtures` are separate endpoints, cached for ten and thirty minutes by the
// proxy and again by the browser, and FPL updates them independently, so for up
// to half an hour after a kickoff the totals can already include a match the
// fixture list still calls upcoming. On the 2026-09-13 payload that lag alone
// reproduces the whole collapse. A club plays one match at a time, so one is
// the most the lag can be, while a real season boundary is off by tens.
const TOTALS_LEAD_TOLERANCE_MATCHES = 1;

// ---------------------------------------------------------------------------
// THE TWO SEASONS A PROJECTION READS, told apart once.
//
// Since 2026-09-16 a player carries two kinds of evidence: this season's totals
// (the payload) and his previous season (`player.prior`, attached by
// normalize.js from the shipped or kept snapshot). Before a ball is kicked there
// is no attached prior, because the payload's own totals ARE the previous
// season. Every model that weighs one season against the other (the start
// model here, the carried rates in projections.js, the team ratings in
// strength.js) reads both through this view, so "which numbers are last
// season's" has one answer:
//
//   priorOf(player)    his previous season, or null for a player without one
//   currentOf(player)  this season's totals, or null before the season starts
//   matchesOf(player)  the club matches those current totals cover
//
// The replay's legacy seeded regime declares `evidenceMatches` on blended
// totals and attaches no prior; read here it is a pre-season-shaped payload
// whose single season of evidence covers the declared matches, which is what
// that regime always meant.
// ---------------------------------------------------------------------------

const viewCache = new WeakMap();

export function evidenceView(gameState) {
  const cached = viewCache.get(gameState);
  if (cached) return cached;
  const evidence = seasonEvidence(gameState);
  const preseason = evidence.kind === 'previous-season' && !gameState.priorSeason;
  const view = {
    evidence,
    preseason,
    priorOf(player) {
      if (preseason) {
        if (!(player.minutes > 0) && !(player.starts > 0)) return null;
        return {
          starts: player.starts || 0,
          minutes: player.minutes || 0,
          matches: evidenceMatchesFor(player, evidence.teamMatches),
          rates: true,
          xG: player.xG,
          xA: player.xA,
          xGC: player.xGC,
          bps: player.bps,
          bonus: player.bonus,
          saves: player.saves,
          goalsScored: player.goalsScored,
          assists: player.assists,
          yellowCards: player.yellowCards,
          redCards: player.redCards,
          penaltiesSaved: player.penaltiesSaved,
          cbit: player.cbit,
          recoveries: player.recoveries,
          tackles: player.tackles,
          defCon: player.defCon,
          xMinutes: Number.isFinite(player.xMinutes) ? player.xMinutes : (player.minutes || 0),
          dcMinutes: Number.isFinite(player.dcMinutes) ? player.dcMinutes : (player.minutes || 0),
        };
      }
      return player.prior || null;
    },
    currentOf(player) {
      return preseason ? null : player;
    },
    matchesOf(player) {
      return preseason ? 0 : evidenceMatchesFor(player, defaultEvidenceMatches(evidence, player.teamId));
    },
  };
  viewCache.set(gameState, view);
  return view;
}

// Price percentile within position, used only for players with no minutes.
function priceBands(gameState) {
  const byPosition = new Map();
  for (const p of gameState.players.values()) {
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p.nowCost);
  }
  for (const arr of byPosition.values()) arr.sort((a, b) => a - b);
  return byPosition;
}

function pricePercentile(bands, position, nowCost) {
  const arr = bands.get(position);
  if (!arr || arr.length < 2) return 0.5;
  let below = 0;
  for (const v of arr) {
    if (v < nowCost) below++;
    else break;
  }
  return below / (arr.length - 1);
}

// ---------------------------------------------------------------------------

// How many gameweeks past the one being decided this projection is. Zero for
// the live gameweek and for any caller that does not say, which is what keeps a
// published chance of playing a hard ceiling exactly where it is published.
export function horizonSteps(gameState, gw) {
  const from = gameState && gameState.nextEvent;
  if (!Number.isFinite(from) || !Number.isFinite(gw)) return 0;
  return Math.max(0, gw - from);
}

// The availability ceiling for one gameweek: what fraction of a fully fit
// player's chances this player keeps.
export function availabilityCeiling(player, { steps = 0 } = {}) {
  let availability = 1;
  let reason = 'historical';
  if (player.chanceNext !== null && player.chanceNext !== undefined) {
    availability = clamp01(player.chanceNext);
    reason = 'chance-of-playing';
  } else if (player.status === DOUBTFUL_STATUS) {
    availability = DOUBTFUL_DEFAULT_AVAILABILITY;
    reason = 'doubtful-no-percentage';
  }
  if (availability < 1 && steps > 0) {
    availability = 1 - (1 - availability) * (HORIZON_DOUBT_DECAY ** steps);
    reason = `${reason}-recovering`;
  }
  return { availability, reason };
}

// --- How well the minutes are KNOWN, not how high they are -----------------
//
// THE DEFECT THIS REPLACES. Confidence used to be three cumulative-minute
// thresholds: 900 for high, 270 for medium, low below. Those are late-season
// numbers wearing no season label, and before roughly gameweek 10 they do not
// describe evidence at all. At gameweek 4 a club has played three matches, so
// 270 is every minute there was: `high` is arithmetically unreachable by
// anybody, `medium` means "never once substituted" and everyone else is `low`.
// The tier stopped being a statement about sample size and became a statement
// about whether a player gets taken off, which is a fact about his manager.
//
// It also contradicted the rest of the model. Foden at gameweek 4 of 2026/27
// carried 195 minutes across all three matches, so `pAppear` was 1.000, the
// highest appearance certainty in the eleven, while this function called him
// `low` and captain.js charged him the largest confidence penalty available.
// A player cannot simultaneously be the surest to play and the least known.
//
// WHAT IT IS NOW. Confidence is the PRECISION of the start-rate estimate, which
// is what the word should have meant all along, and it is read off the sample
// that produced that estimate rather than off a raw minute count:
//
//   posterior = Beta(1 + p*n, 1 + (1-p)*n)   n = evidence matches, p = start rate
//   score     = 1 - sd(posterior) / sd(Beta(1,1))
//
// A uniform Beta(1,1) prior is the honest no-evidence state, and its standard
// deviation, sqrt(1/12), is therefore the worst any player can score. Every
// property the old thresholds lacked falls out of this rather than being
// legislated:
//
// - It is season-aware by construction. n is the matches the evidence actually
//   covers, so the same 195 minutes means one thing after three matches and
//   another after fifteen, and no tier is unreachable merely because the season
//   is young.
// - It carries prior seasons. `evidenceMatchesFor` already counts the baseline
//   matches blended into the totals, so an established starter arrives at
//   gameweek 1 with a season of evidence behind him and a new signing does not.
// - Extremes are known better than coin flips. p(1-p) is largest at 0.5, so a
//   nailed starter and a settled non-starter both score above a rotation risk
//   on the same sample, which is the true state of knowledge.
// - Small samples cannot reach certainty. One start from one match is
//   Beta(2,1), sd 0.2357, score 0.18, not the 1.0 a raw ratio would report.
//
// It reads the START rate, not the appearance rate, deliberately: `subOnRate`
// is the one rate in this module with a known saturation defect (registry
// entries 23 and 24), and confidence must not inherit it.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not fold in how MUCH a player
// plays, only how well that is known. A settled fringe player - five starts in
// thirty-eight matches - scores high here, because his start rate is one of the
// best known numbers in the model, and that reads oddly until you remember what
// consumes it: the level lives in `pStart` and `pAppear`, which every consumer
// already reads beside this, and captain.js floors on `pAppear` before
// confidence is ever consulted. Folding the level in as well would charge the
// same fact twice, which is precisely the incoherence this replaced - Foden on
// a `pAppear` of 1.000 being handed the largest uncertainty penalty in the
// eleven. Confidence answers "how well do we know this player's minutes"; it is
// not a second opinion on whether they are good.
//
// The tier survives because other modules read it (`confidence.js` treats `low`
// as shaky, the drawer prints it), but it is now DERIVED from the score at even
// thirds rather than being the primary quantity. captain.js reads the score.
export const NO_EVIDENCE_START_SD = Math.sqrt(1 / 12);
export const CONFIDENCE_TIER_BOUNDS = Object.freeze({ high: 2 / 3, medium: 1 / 3 });

export function confidenceTierFor(score) {
  if (score >= CONFIDENCE_TIER_BOUNDS.high) return 'high';
  if (score >= CONFIDENCE_TIER_BOUNDS.medium) return 'medium';
  return 'low';
}

export function minutesConfidence({ startRate, evidenceMatches, availability = 1 } = {}) {
  const n = Math.max(0, Number.isFinite(evidenceMatches) ? evidenceMatches : 0);
  const p = clamp01(Number.isFinite(startRate) ? startRate : 0.5);
  const a = 1 + p * n;
  const b = 1 + (1 - p) * n;
  const total = a + b;
  const sd = Math.sqrt((a * b) / (total * total * (total + 1)));
  // A published doubt is uncertainty the appearance record cannot see, so it
  // costs confidence directly rather than only capping the level.
  const avail = clamp01(Number.isFinite(availability) ? availability : 1);
  const score = clamp01(1 - sd / NO_EVIDENCE_START_SD) * avail;
  return { score, tier: confidenceTierFor(score), sd, evidenceMatches: n };
}

export function projectMinutes(player, { gameState, gw, fixtureCount } = {}) {
  const { priors, evidence: season, matchesByTeam, priceBands: bands } = positionPriors(gameState);
  const prior = priors.get(player.position) || { ...FALLBACK_PRIORS };
  const nFixtures = fixtureCount === undefined
    ? (gw === undefined ? 1 : countFixtures(gameState, player.teamId, gw))
    : fixtureCount;

  const zero = {
    pStart: 0, pBench: 0, pAppear: 0, pNone: 1, p60: 0, xMins: 0,
    xMinsIfStart: prior.starterMinutes, xMinsIfBench: prior.subMinutes,
    meanStarterMinutes: prior.starterMinutes, meanSubMinutes: prior.subMinutes,
    availability: 0,
    fixtureCount: nFixtures,
  };

  // Certainty that he does NOT play is still certainty, so these three score 1.
  if (nFixtures === 0) return { ...zero, confidence: 'high', confidenceScore: 1, reason: 'blank-gameweek' };
  if (UNAVAILABLE_STATUSES.has(player.status)) {
    return { ...zero, confidence: 'high', confidenceScore: 1, reason: `status-${player.status}` };
  }

  // Availability ceiling. An explicit percentage wins over everything; a
  // doubtful flag with no percentage falls back to the documented default; and
  // a doubt about a gameweek further out is a smaller doubt.
  const ceiling = availabilityCeiling(player, { steps: horizonSteps(gameState, gw) });
  const availability = ceiling.availability;
  let reason = ceiling.reason;
  if (availability === 0) return { ...zero, confidence: 'high', confidenceScore: 1, reason };

  // THE TWO SEASONS (evidenceView): this season's starts over his club's
  // matches, and his previous season, which is the whole of the evidence
  // before a ball is kicked.
  const view = evidenceView(gameState);
  const lastSeason = view.priorOf(player);
  const current = view.currentOf(player);
  const m = view.matchesOf(player);
  const s = current ? Math.min(Math.max(0, current.starts || 0), m) : 0;
  const minutesNow = current ? Math.max(0, current.minutes || 0) : 0;
  const model = startModelFor(gameState);
  const position = player.position;

  const hasPrior = !!lastSeason && (lastSeason.starts > 0 || lastSeason.minutes > 0);
  let mu;
  let K;
  if (hasPrior) {
    const priorMatches = Number.isFinite(lastSeason.matches) && lastSeason.matches > 0
      ? lastSeason.matches
      : (gameState.rules.totalEvents || 38);
    const lastRate = model.lastStartRate(position);
    const raw = clamp01((lastSeason.starts + START_PRIOR_SEASON_SHRINK * lastRate) / (priorMatches + START_PRIOR_SEASON_SHRINK));
    mu = clamp01(logistic(START_PRIOR_CALIBRATION.a + START_PRIOR_CALIBRATION.b * logit(Math.min(1 - 1e-6, Math.max(1e-6, raw)))));
    K = START_CARRY.base + START_CARRY.perMatch * m;
  } else {
    const pct = pricePercentile(bands, position, player.nowCost);
    mu = NO_HISTORY_MIN_START + pct * (NO_HISTORY_MAX_START - NO_HISTORY_MIN_START);
    K = NO_HISTORY_CARRY.base + NO_HISTORY_CARRY.perMatch * m;
    if (reason === 'historical' && minutesNow <= 0) reason = m > 0 ? 'no-history-unplayed' : 'no-history-prior';
  }
  let baseStart = (s + K * mu) / (m + K);

  // Starter and substitute minutes, from the payload's own totals (this
  // season's, or last season's before it starts): the estimator the hour
  // curves above were fitted on. Sub appearances are not published, so they
  // are inferred as the minutes the starts cannot account for.
  const evidence = evidenceMatchesFor(player, defaultEvidenceMatches(season, player.teamId));
  let meanStarterMinutes = prior.starterMinutes;
  let meanSubMinutes = prior.subMinutes;
  if (player.minutes > 0 && evidence > 0) {
    const startMinutes = Math.min(player.minutes, player.starts * prior.starterMinutes);
    const benchMinutes = Math.max(0, player.minutes - startMinutes);
    const inferredSubApps = Math.min(
      Math.max(0, evidence - player.starts),
      benchMinutes / Math.max(1, prior.subMinutes),
    );
    const rawStarterMinutes = player.starts > 0
      ? Math.min(90, (player.minutes - inferredSubApps * prior.subMinutes) / player.starts)
      : prior.starterMinutes;
    const wStart = player.starts / (player.starts + STARTER_MINUTES_SHRINK_STARTS);
    meanStarterMinutes = Math.max(1, wStart * rawStarterMinutes + (1 - wStart) * prior.starterMinutes);

    const rawSubMinutes = inferredSubApps > 0 ? benchMinutes / inferredSubApps : prior.subMinutes;
    const wSub = inferredSubApps / (inferredSubApps + SUB_MINUTES_SHRINK_APPS);
    // 90 is a physical bound on both means, not a modelling choice. It matters
    // because minutes and starts can disagree in a mid-update payload, and the
    // inferred bench split would otherwise hand back more than a full match.
    meanSubMinutes = Math.min(90, Math.max(1, wSub * rawSubMinutes + (1 - wSub) * prior.subMinutes));
  }

  // Two fixtures in one gameweek means each individual one is slightly more
  // likely to be a rotation.
  if (nFixtures > 1) baseStart *= CONGESTION_START_FACTOR;
  const baseStart01 = clamp01(baseStart);

  // The bench (SUB_ON_PRIOR and the note above it).
  let subOnRate;
  if (current && minutesNow === 0 && m >= 1) {
    subOnRate = unusedSubOnRate(position, m);
  } else {
    const q = subOnPrior(position, baseStart01);
    const nowApps = inferredSubAppearances(minutesNow, s, m, model.currentStarterMinutes(position));
    const lastApps = hasPrior
      ? inferredSubAppearances(
        lastSeason.minutes || 0,
        lastSeason.starts || 0,
        Number.isFinite(lastSeason.matches) && lastSeason.matches > 0 ? lastSeason.matches : (gameState.rules.totalEvents || 38),
        model.lastStarterMinutes(position),
      )
      : { apps: 0, opportunities: 0 };
    const num = nowApps.apps + SUB_ON_LAST_SEASON_WEIGHT * lastApps.apps + SUB_ON_PRIOR_OPPORTUNITIES * q;
    const den = nowApps.opportunities + SUB_ON_LAST_SEASON_WEIGHT * lastApps.opportunities + SUB_ON_PRIOR_OPPORTUNITIES;
    subOnRate = den > 0 ? clamp01(num / den) : q;
  }

  // pAppear is BUILT from pStart, which is what makes pStart <= pAppear <= 1
  // structurally true rather than a clamp applied afterwards. Availability then
  // scales the whole profile, so it is a genuine ceiling: a player with a 25%
  // chance of playing can never come out above 0.25 to appear.
  const baseAppear = clamp01(baseStart01 + (1 - baseStart01) * clamp01(subOnRate));
  const pStart = availability * baseStart01;
  const pAppear = availability * baseAppear;

  // The three outcomes, named. pBench cannot go negative because pAppear was
  // built from pStart by the same availability factor, and the three sum to one
  // by construction rather than by normalising.
  const pBench = Math.max(0, pAppear - pStart);
  const pNone = Math.max(0, 1 - pStart - pBench);

  const p60Start = p60GivenStart(position, meanStarterMinutes);
  const p60Sub = p60GivenSub(position);
  const p60 = clamp01(pStart * p60Start + pBench * p60Sub);
  const xMins = pStart * meanStarterMinutes + pBench * meanSubMinutes;

  // How well the start probability is KNOWN (see minutesConfidence): the
  // matches behind it, which for a returning player include his previous
  // season, the evidence the prior mean was measured on.
  const confidenceEvidence = m + (hasPrior
    ? (Number.isFinite(lastSeason.matches) && lastSeason.matches > 0 ? lastSeason.matches : (gameState.rules.totalEvents || 38))
    : 0);
  const { score: confidenceScore, tier: confidence } = minutesConfidence({
    startRate: baseStart01,
    evidenceMatches: confidenceEvidence,
    availability,
  });

  return {
    pStart,
    pBench,
    pAppear,
    pNone,
    p60,
    xMins,
    // The pieces the projection's minute branches are built from, so they are
    // decided once, here.
    p60GivenStart: p60Start,
    p60GivenSub: p60Sub,
    startUnder60Minutes: START_UNDER_60_MINUTES[position] || START_UNDER_60_MINUTES[3],
    subOver60Minutes: SUB_OVER_60_MINUTES,
    subOnRate,
    // Expected minutes CONDITIONAL on each outcome. The unconditional xMins
    // above is the mixture of these two, weighted by the probabilities.
    xMinsIfStart: meanStarterMinutes,
    xMinsIfBench: meanSubMinutes,
    meanStarterMinutes,
    meanSubMinutes,
    availability,
    fixtureCount: nFixtures,
    confidence,
    confidenceScore,
    reason,
  };
}

// The pooled start rate and starter minutes of each position, last season and
// this one, which the start and bench priors are read against. Cached per
// GameState.
const startModelCache = new WeakMap();

function startModelFor(gameState) {
  const cached = startModelCache.get(gameState);
  if (cached) return cached;
  const view = evidenceView(gameState);
  const pool = () => ({ starts: 0, matches: 0, minutes: 0 });
  const last = new Map();
  const now = new Map();
  for (const p of gameState.players.values()) {
    const prior = view.priorOf(p);
    if (prior && prior.minutes > 0) {
      if (!last.has(p.position)) last.set(p.position, pool());
      const row = last.get(p.position);
      row.starts += prior.starts || 0;
      row.matches += Number.isFinite(prior.matches) && prior.matches > 0 ? prior.matches : (gameState.rules.totalEvents || 38);
      row.minutes += prior.minutes;
    }
    const current = view.currentOf(p);
    if (current && current.minutes > 0) {
      if (!now.has(p.position)) now.set(p.position, pool());
      const row = now.get(p.position);
      row.starts += current.starts || 0;
      row.minutes += current.minutes;
    }
  }
  const starterMinutes = (row) => (row && row.starts > 0 ? Math.min(90, (row.minutes * 0.92) / row.starts) : null);
  const model = {
    lastStartRate(position) {
      const row = last.get(position);
      return row && row.matches > 0 ? row.starts / row.matches : FALLBACK_PRIORS.startRate;
    },
    lastStarterMinutes(position) {
      return starterMinutes(last.get(position)) || FALLBACK_PRIORS.starterMinutes;
    },
    currentStarterMinutes(position) {
      return starterMinutes(now.get(position)) || starterMinutes(last.get(position)) || FALLBACK_PRIORS.starterMinutes;
    },
  };
  startModelCache.set(gameState, model);
  return model;
}

// Substitute appearances inferred from totals: the minutes a player's starts
// cannot account for, in spells of SUB_SPELL_MINUTES, capped by the matches he
// did not start (his opportunities).
function inferredSubAppearances(minutes, starts, matches, starterMinutes) {
  const opportunities = Math.max(0, matches - starts);
  if (opportunities <= 0) return { apps: 0, opportunities: 0 };
  const bench = Math.max(0, minutes - Math.min(minutes, starts * starterMinutes));
  return { apps: Math.min(opportunities, bench / SUB_SPELL_MINUTES), opportunities };
}

function subOnPrior(position, startProbability) {
  const table = SUB_ON_PRIOR[position] || SUB_ON_PRIOR[3];
  let bin = 0;
  for (let i = SUB_ON_START_BINS.length - 1; i >= 0; i--) {
    if (startProbability >= SUB_ON_START_BINS[i]) { bin = i; break; }
  }
  return table[bin];
}

function unusedSubOnRate(position, matches) {
  const table = SUB_ON_UNUSED[position] || SUB_ON_UNUSED[3];
  const i = SUB_ON_UNUSED_BUCKETS.findIndex(([lo, hi]) => matches >= lo && matches <= hi);
  return table[i < 0 ? table.length - 1 : i];
}

function countFixtures(gameState, teamId, gw) {
  if (gw === null || gw === undefined) return 0;
  let n = 0;
  for (const f of gameState.fixtures) {
    if (f.event === gw && (f.teamH === teamId || f.teamA === teamId)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Calibration report.
//
// Takes rows of `{ pStart, started }` from held-out data and reports the
// observed start rate per predicted-probability bin. A model that says 80% and
// is right 55% of the time is not a minutes model, it is a bias, and this is
// the report that shows it.
// ---------------------------------------------------------------------------

export function calibration(rows, { bins = 10 } = {}) {
  const buckets = [];
  for (let i = 0; i < bins; i++) {
    buckets.push({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumPredicted: 0, started: 0 });
  }
  for (const r of rows) {
    const p = clamp01(r.pStart);
    const b = Math.min(bins - 1, Math.floor(p * bins));
    buckets[b].n++;
    buckets[b].sumPredicted += p;
    buckets[b].started += r.started ? 1 : 0;
  }

  let ece = 0;
  let maxGap = 0;
  let totalPredicted = 0;
  let totalObserved = 0;
  const out = buckets.map(b => {
    const meanPredicted = b.n ? b.sumPredicted / b.n : 0;
    const observedRate = b.n ? b.started / b.n : 0;
    if (b.n) {
      const gap = Math.abs(meanPredicted - observedRate);
      ece += (b.n / rows.length) * gap;
      maxGap = Math.max(maxGap, gap);
      totalPredicted += b.sumPredicted;
      totalObserved += b.started;
    }
    return { lo: b.lo, hi: b.hi, n: b.n, meanPredicted, observedRate };
  });

  return {
    bins: out,
    n: rows.length,
    ece: rows.length ? ece : 0,
    maxGap,
    meanPredicted: rows.length ? totalPredicted / rows.length : 0,
    observedRate: rows.length ? totalObserved / rows.length : 0,
  };
}
