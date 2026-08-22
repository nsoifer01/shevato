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
// NO MINUTES AT ALL. A player with nothing on the board is priced off his price
// percentile, which is the only pre-season signal there is. That prior expires:
// it is worth NO_HISTORY_PRIOR_MATCHES matches of evidence and is then read
// against the matches his club has played without him. See the constant for the
// measurement behind it. A player who has not appeared in ten gameweeks is not
// the same bet as a new signing before the season starts, and until this decay
// existed the model priced them identically.

import { assessBaseline, baselineIsSuperseded } from './baseline.js';

const UNAVAILABLE_STATUSES = new Set(['i', 's', 'u', 'n']);
const DOUBTFUL_STATUS = 'd';

// FPL flags a player doubtful without a percentage often enough that this needs
// a value. Half is deliberately blunt: the honest answer is "we do not know",
// and the projection is flagged low confidence so the UI can say so.
const DOUBTFUL_DEFAULT_AVAILABILITY = 0.5;

// Shrinkage. A start rate measured over 3 team matches is nearly worthless and
// one measured over 38 is nearly exact, so the observed rate is pulled toward
// the position prior with a weight of matches / (matches + K).
const START_RATE_SHRINK_MATCHES = 6;
const STARTER_MINUTES_SHRINK_STARTS = 5;
const SUB_MINUTES_SHRINK_APPS = 4;

// Fallback position priors, used only when the payload cannot supply them
// (which happens only in tests with a handful of players). The real priors are
// measured from the league in `positionPriors`.
const FALLBACK_PRIORS = {
  startRate: 0.35,
  starterMinutes: 80,
  subMinutes: 20,
  subOnRate: 0.25,
};

// A player with no minutes at all is either a promoted-club regular, a new
// signing or a youth player. Price is the only signal available: FPL prices a
// first-choice striker at a promoted club well above a third-choice keeper.
// The prior interpolates between these two by the player's price percentile
// within their own position, and always reports low confidence.
const NO_HISTORY_MIN_START = 0.08;
const NO_HISTORY_MAX_START = 0.78;
const NO_HISTORY_SUB_ON_RATE = 0.22;

// HOW LONG THE PRICE SIGNAL SURVIVES CONTACT WITH THE SEASON.
//
// Price is a PRE-SEASON prior and it is a good one: before a ball is kicked, a
// player with no minutes starts about as often as his price percentile says he
// will. The moment his club plays a match he is not in, that stops being true,
// because "still on zero minutes after m matches" is itself evidence and the
// price cannot see it.
//
// So the price prior is credited with NO_HISTORY_PRIOR_MATCHES matches of
// evidence and then read against the player's own record of zero starts in the
// m matches his club has actually played:
//
//   baseStart = priceStart * NO_HISTORY_PRIOR_MATCHES / (m + NO_HISTORY_PRIOR_MATCHES)
//
// which is the Beta posterior mean for 0 successes in m trials under a prior of
// that strength, and is the same shrinkage every other estimate in this file
// uses. At m = 0, which is every pre-season payload and every gameweek 1, the
// weight is exactly 1 and nothing changes.
//
// The strength is ONE MATCH, and it is measured rather than chosen. Fitting it
// by maximum likelihood over the archive's zero-minute player-gameweeks, one fit
// per season per outcome so the spread can be read rather than asserted:
//
//   starts,      2023-24                 0.67
//   starts,      2024-25                 0.78
//   appearances, 2022-23                 0.93
//   appearances, 2023-24                 0.77
//   appearances, 2024-25                 0.85
//
// Five independent fits between 0.67 and 0.93, and restricting the fit to the
// first five or twelve matches moves them to 0.35 and 0.65. One match sits at
// the top of that range, which is the conservative end: a larger strength means
// LESS decay and a smaller departure from the shipped behaviour. Starts in the
// 2022-23 archive are only partly populated, which is why that season is fitted
// on appearances only.
//
// What this cannot do: tell a January signing from a youth player. Both arrive
// with zero minutes at a club that has played twenty matches, and both are
// pushed to almost no chance of starting. The pooled evidence for that group is
// a 0.9 per cent start rate, so the pooled answer is right and the individual
// answer for a marquee mid-season arrival is wrong until he plays.
const NO_HISTORY_PRIOR_MATCHES = 1;

// Rotation in a double gameweek. Two matches in one week measurably lowers the
// chance of starting any individual one of them.
const CONGESTION_START_FACTOR = 0.9;

// Minutes at which a start becomes a 60-minute appearance. Modelled with a
// logistic on the player's mean starter minutes: at a mean of 60 the player is
// a coin flip to reach the hour, and the scale controls how fast that changes.
const P60_MIDPOINT = 60;
const P60_SCALE = 12;

// How much of an availability doubt survives one more gameweek of distance.
// Measured, not chosen: see the header. It is applied only to gameweeks beyond
// the one being decided, and needs `gameState.nextEvent` to know which that is.
const HORIZON_DOUBT_DECAY = 0.92;

export const MINUTES_PARAMS = Object.freeze({
  horizonDoubtDecay: HORIZON_DOUBT_DECAY,
  doubtfulDefaultAvailability: DOUBTFUL_DEFAULT_AVAILABILITY,
  startRateShrinkMatches: START_RATE_SHRINK_MATCHES,
  starterMinutesShrinkStarts: STARTER_MINUTES_SHRINK_STARTS,
  subMinutesShrinkApps: SUB_MINUTES_SHRINK_APPS,
  noHistoryMinStart: NO_HISTORY_MIN_START,
  noHistoryMaxStart: NO_HISTORY_MAX_START,
  noHistorySubOnRate: NO_HISTORY_SUB_ON_RATE,
  noHistoryPriorMatches: NO_HISTORY_PRIOR_MATCHES,
  congestionStartFactor: CONGESTION_START_FACTOR,
  p60Midpoint: P60_MIDPOINT,
  p60Scale: P60_SCALE,
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const logistic = (x) => 1 / (1 + Math.exp(-x));

// P(a player who starts is still on after 60 minutes), from their typical
// starter minutes.
export function p60FromMeanMinutes(meanMinutes) {
  return clamp01(logistic((meanMinutes - P60_MIDPOINT) / P60_SCALE));
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

  const teamMatches = teamMatchesPlayed(gameState);
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
      row.matches += evidenceMatchesFor(p, teamMatches);
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
    teamMatches,
    matchesByTeam: matchesPlayedByTeam(gameState),
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

// Matches each club has PLAYED OUT this season. Zero for every club pre-season,
// which is the whole point: it is the count of chances a player has had to
// appear, so it can only start once the season has.
//
// It counts a provisional full-time as played. Reading only `finished` meant
// that between the final whistle and FPL signing the match off - still unsigned
// eleven hours later on 2026-08-21 - twenty-two players carried ninety minutes each against
// a denominator of zero, and the payload was mistaken for last season's.
function matchesPlayedByTeam(gameState) {
  const counts = new Map();
  for (const f of gameState.fixtures) {
    if (!(f.finished || f.finishedProvisional)) continue;
    for (const t of [f.teamH, f.teamA]) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
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
export function seasonEvidence(gameState) {
  const perTeam = matchesPlayedByTeam(gameState);
  let maxPlayed = 0;
  for (const n of perTeam.values()) if (n > maxPlayed) maxPlayed = n;

  let impossible = 0;
  let withMinutes = 0;
  let starts = 0;
  for (const p of gameState.players.values()) {
    if (p.minutes > 0) withMinutes++;
    starts += p.starts || 0;
    const played = perTeam.get(p.teamId) || 0;
    // The claim only means anything once his club has actually played, and one
    // player over the line is noise: a squad's worth of them is a season
    // boundary. `starts` is the cleanest signal because it is bounded by
    // matches by construction; minutes are bounded by 90 per match, so they
    // catch the same thing when a payload omits starts.
    if (played > 0 && ((p.starts || 0) > played || p.minutes > played * 90 + 30)) impossible++;
  }

  const totalEvents = gameState.rules.totalEvents;

  // Nothing has been played AND nobody carries a minute: there is no evidence in
  // this payload at all, from either season.
  if (maxPlayed === 0 && withMinutes === 0) {
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
    if (!assessment.complete && !baselineIsSuperseded(gameState)) {
      return {
        kind: 'partial-season',
        usable: false,
        teamMatches: maxPlayed,
        finishedMatches: maxPlayed,
        impossible,
        assessment,
        message: 'This season is only a few matches old and the clubs have not played the same number of games, '
          + 'so the player totals are not yet comparable across the league.',
      };
    }
  }

  return {
    kind: 'current-season',
    usable: true,
    teamMatches: maxPlayed,
    finishedMatches: maxPlayed,
    impossible,
    message: null,
  };
}

// How many players have to claim more starts than their club has played before
// the payload is called a previous season's. One is a data quirk; a quorum is a
// season boundary. Deliberately small: at a real rollover essentially the whole
// pool trips it at once.
const IMPOSSIBLE_STARTS_QUORUM = 12;

// The denominator for a start rate, which is now whatever the evidence says it
// is rather than a count of fixtures read in isolation.
function teamMatchesPlayed(gameState) {
  return seasonEvidence(gameState).teamMatches;
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

export function projectMinutes(player, { gameState, gw, fixtureCount } = {}) {
  const { priors, teamMatches, matchesByTeam, priceBands: bands } = positionPriors(gameState);
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

  if (nFixtures === 0) return { ...zero, confidence: 'high', reason: 'blank-gameweek' };
  if (UNAVAILABLE_STATUSES.has(player.status)) {
    return { ...zero, confidence: 'high', reason: `status-${player.status}` };
  }

  // Availability ceiling. An explicit percentage wins over everything; a
  // doubtful flag with no percentage falls back to the documented default; and
  // a doubt about a gameweek further out is a smaller doubt.
  const ceiling = availabilityCeiling(player, { steps: horizonSteps(gameState, gw) });
  const availability = ceiling.availability;
  let reason = ceiling.reason;
  if (availability === 0) return { ...zero, confidence: 'high', reason };

  const hasHistory = player.minutes > 0 && teamMatches > 0;
  let baseStart;
  let meanStarterMinutes;
  let meanSubMinutes;
  let subOnRate;
  let confidence;

  if (hasHistory) {
    // Every rate below is read against the matches the totals actually cover,
    // which on a live payload is the league's match count and in a replay
    // includes whatever previous season was seeded into them.
    const evidence = evidenceMatchesFor(player, teamMatches);
    const observedStartRate = clamp01(player.starts / evidence);
    const wRate = evidence / (evidence + START_RATE_SHRINK_MATCHES);
    baseStart = wRate * observedStartRate + (1 - wRate) * prior.startRate;

    // Split total minutes into starter minutes and bench minutes. Sub
    // appearances are not published, so they are inferred as whatever minutes
    // the player's starts cannot account for, capped by the matches they did
    // not start.
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

    const benchMatches = Math.max(1, evidence - player.starts);
    subOnRate = clamp01(inferredSubApps / benchMatches);
    confidence = player.minutes >= 900 ? 'high' : player.minutes >= 270 ? 'medium' : 'low';
  } else {
    // No Premier League minutes: promoted-club players, new signings, youth.
    // The price prior is the pre-season answer, and it decays against the
    // matches his own club has already played without him.
    const pct = pricePercentile(bands, player.position, player.nowCost);
    const missed = matchesByTeam.get(player.teamId) || 0;
    const priceWeight = NO_HISTORY_PRIOR_MATCHES / (missed + NO_HISTORY_PRIOR_MATCHES);
    baseStart = priceWeight * (NO_HISTORY_MIN_START + pct * (NO_HISTORY_MAX_START - NO_HISTORY_MIN_START));
    meanStarterMinutes = prior.starterMinutes;
    meanSubMinutes = prior.subMinutes;
    subOnRate = priceWeight * NO_HISTORY_SUB_ON_RATE;
    confidence = 'low';
    if (reason === 'historical') reason = missed > 0 ? 'no-history-unplayed' : 'no-history-prior';
  }

  // Two fixtures in one gameweek means each individual one is slightly more
  // likely to be a rotation.
  if (nFixtures > 1) baseStart *= CONGESTION_START_FACTOR;

  // pAppear is BUILT from pStart, which is what makes pStart <= pAppear <= 1
  // structurally true rather than a clamp applied afterwards. Availability then
  // scales the whole profile, so it is a genuine ceiling: a player with a 25%
  // chance of playing can never come out above 0.25 to appear.
  const baseStart01 = clamp01(baseStart);
  const baseAppear = clamp01(baseStart01 + (1 - baseStart01) * clamp01(subOnRate));
  const pStart = availability * baseStart01;
  const pAppear = availability * baseAppear;

  // The three outcomes, named. pBench cannot go negative because pAppear was
  // built from pStart by the same availability factor, and the three sum to one
  // by construction rather than by normalising.
  const pBench = Math.max(0, pAppear - pStart);
  const pNone = Math.max(0, 1 - pStart - pBench);

  const p60 = clamp01(
    pStart * p60FromMeanMinutes(meanStarterMinutes)
    + pBench * p60FromMeanMinutes(meanSubMinutes),
  );
  const xMins = pStart * meanStarterMinutes + pBench * meanSubMinutes;

  if (availability < 1 && confidence === 'high') confidence = 'medium';

  return {
    pStart,
    pBench,
    pAppear,
    pNone,
    p60,
    xMins,
    // Expected minutes CONDITIONAL on each outcome. The unconditional xMins
    // above is the mixture of these two, weighted by the probabilities.
    xMinsIfStart: meanStarterMinutes,
    xMinsIfBench: meanSubMinutes,
    meanStarterMinutes,
    meanSubMinutes,
    availability,
    fixtureCount: nFixtures,
    confidence,
    reason,
  };
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
