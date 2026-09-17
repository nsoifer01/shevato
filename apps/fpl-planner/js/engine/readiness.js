// RECOMMENDATION READINESS: what the data is good enough to say.
//
// WHY THIS FILE EXISTS
//
// On 2026-08-21 the app told a manager to play his Wildcard - eleven changes,
// the single most valuable irreversible decision in the game - off projections
// that had collapsed because FPL cleared the season totals mid-evening. In the
// same card it said "100% of this gameweek's projected points sits on players
// whose minutes are unclear". Both statements were produced by the same
// pipeline, and nothing anywhere asked whether the second should have stopped
// the first.
//
// The mistake was architectural, not arithmetic: `evidence.usable` was a single
// boolean consulted by the UI at render time, so every recommendation carried
// the same bar. Displaying a rough projection and betting a season-defining
// chip on it are not the same claim, and they must not clear the same gate.
//
// So readiness is a LADDER. Each rung adds a requirement, and a recommendation
// may only be produced at the rung its own cost justifies:
//
//   DISPLAY    always available; the squad, live points, fixtures
//   LINEUP     ordering a squad the manager already owns
//   TRANSFERS  spending money and free transfers
//   CHIPS      spending a once-or-twice-a-season asset
//
// Every refusal names a code and says why in words a manager can act on.

import { GW_PHASE } from './lifecycle.js';

export const LEVEL = Object.freeze({
  NONE: 'none',
  DISPLAY: 'display',
  LINEUP: 'lineup',
  TRANSFERS: 'transfers',
  CHIPS: 'chips',
});

const ORDER = [LEVEL.NONE, LEVEL.DISPLAY, LEVEL.LINEUP, LEVEL.TRANSFERS, LEVEL.CHIPS];

/** Is `level` at least `required`? */
export function levelAtLeast(level, required) {
  return ORDER.indexOf(level) >= ORDER.indexOf(required);
}

// A legal eleven scores about fifty in a Premier League gameweek. Thirty and a
// hundred are not thresholds anyone should tune: they are the range outside
// which the number is not describing football at all. Used only as a last-ditch
// catch, because the checks above it are the ones that carry meaning.
export const PLAUSIBLE_GW_MIN = 30;
export const PLAUSIBLE_GW_MAX = 100;

// The pool must keep a spread. When projections collapse toward the appearance
// floor every player converges, and the difference between the best and the
// median is what disappears first.
export const MIN_TOP_MEDIAN_GAP = 1.0;

// The shape checks below describe a LEAGUE: "the best eleven score about fifty",
// "the best player is well clear of the median", "not everyone is a nailed
// starter". None of those is a statement about a hand-built world of a dozen
// players, which is what the engine's own unit tests construct, so they are
// only applied once the pool is big enough for the claims to be about football.
// The real payload carries 600 players and the sample dataset 320.
export const MIN_POOL_FOR_SHAPE_CHECKS = 200;

// THE MINUTES MODEL'S TWO SELF-EVIDENT FACTS (2026-09-16). The audit that week
// found every nailed starter in the league projected to start 64% to 76% of
// the time, and players who had started every match reading LESS likely to
// play at all than squad players who came off the bench, while the best eleven
// (40), the spread and the per-position ordering all looked like football. So
// the pool is also asked two questions about the players whose answer is not in
// doubt, and neither needs an outcome to ask:
//
//   * A player who is available and has started every one of his club's
//     matches is, in the median, a starter. Across three replayed seasons the
//     median such player's start probability never read below 0.87 at any
//     deadline, and the model that shipped read 0.60 to 0.80 through the first
//     eight gameweeks of every one of them.
//   * Such a player is at least as likely to appear as a bench player whose
//     appearances come mostly as a substitute. The share of ever-present
//     starters below the median bench player's appearance probability was 0.00
//     at every replayed deadline, and 0.43 to 1.00 under the shipped model.
//
// The bars sit between the two with room either side, and only apply once
// clubs have played twice (one match makes everybody who started it
// ever-present) and the groups are large enough to have a median.
export const MIN_EVER_PRESENT_START_MEDIAN = 0.8;
export const MAX_APPEARANCE_INVERSION_SHARE = 0.25;
export const MIN_CLUB_MATCHES_FOR_MINUTES_CHECKS = 2;
export const MIN_GROUP_FOR_MINUTES_CHECKS = 30;
// A player whose appearance probability exceeds his start probability by this
// much is read as a bench player: most of his chance to play is off the bench.
const BENCH_APPEARANCE_MARGIN = 0.2;

// FPL position ids. The inversion check below is a statement about the sport:
// the best forward and the best midfielder in a league out-project the best
// defender, because goals outscore clean sheets. When both fall below him the
// attacking rates have collapsed, whatever the best-eleven total reads.
const DEF = 2;
const MID = 3;
const FWD = 4;

const medianOf = (values) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * Summarise a projection pool: the sanity facts, not the projections.
 * `rows` is an iterable of `{ xPoints, pStart, position?, pAppear?, fixtureCount?,
 * clubMatches?, seasonStarts?, available? }`. The minutes facts are only read
 * off rows that carry the club's matches, a single fixture, and availability.
 */
export function projectionVitals(rows) {
  const xps = [];
  const bestByPosition = {};
  let pinnedHigh = 0;
  let pinnedLow = 0;
  let counted = 0;
  const everPresent = [];
  const bench = [];
  for (const r of rows) {
    if (!r || !Number.isFinite(r.xPoints)) continue;
    xps.push(r.xPoints);
    if (Number.isFinite(r.clubMatches) && r.clubMatches >= MIN_CLUB_MATCHES_FOR_MINUTES_CHECKS
        && r.fixtureCount === 1 && Number.isFinite(r.pStart) && Number.isFinite(r.pAppear)) {
      if (r.seasonStarts >= r.clubMatches) {
        if (r.available === true) everPresent.push(r);
      } else if (r.pAppear - r.pStart >= BENCH_APPEARANCE_MARGIN) {
        bench.push(r);
      }
    }
    if (r.position !== undefined && !(bestByPosition[r.position] >= r.xPoints)) {
      bestByPosition[r.position] = r.xPoints;
    }
    if (Number.isFinite(r.pStart)) {
      counted++;
      if (r.pStart >= 0.999) pinnedHigh++;
      if (r.pStart <= 0.001) pinnedLow++;
    }
  }
  if (!xps.length) return { empty: true, count: 0 };
  xps.sort((a, b) => b - a);
  const best11 = xps.slice(0, 11).reduce((a, b) => a + b, 0);
  const median = xps[Math.floor(xps.length / 2)];
  const benchAppearMedian = medianOf(bench.map((r) => r.pAppear));
  return {
    empty: false,
    count: xps.length,
    max: xps[0],
    median,
    best11,
    bestByPosition,
    // Null when the rows carried no positions; otherwise whether the best
    // forward AND the best midfielder both sit below the best defender.
    attackInverted: [DEF, MID, FWD].every((k) => Number.isFinite(bestByPosition[k]))
      ? bestByPosition[FWD] < bestByPosition[DEF] && bestByPosition[MID] < bestByPosition[DEF]
      : null,
    topMedianGap: xps[0] - median,
    pinnedHighShare: counted ? pinnedHigh / counted : 0,
    pinnedLowShare: counted ? pinnedLow / counted : 0,
    // Available players who have started every club match so far, and the
    // median start probability the model gives them. Null without the facts.
    everPresentCount: everPresent.length,
    everPresentStartMedian: medianOf(everPresent.map((r) => r.pStart)),
    // Players whose chance to play is mostly off the bench, and the share of
    // ever-present starters the model thinks less likely to play than the
    // median of them.
    benchCount: bench.length,
    benchAppearMedian,
    appearanceInversionShare: everPresent.length && benchAppearMedian !== null
      ? everPresent.filter((r) => r.pAppear < benchAppearMedian).length / everPresent.length
      : null,
  };
}

/**
 * How far up the ladder this data can carry a recommendation.
 *
 * @param {object} input
 * @param {object} input.evidence   from seasonEvidence()
 * @param {object} input.lifecycle  from gameweekLifecycle()
 * @param {object} [input.vitals]   from projectionVitals(), when projections exist
 * @param {object} [input.baseline] `{ source, rates }` from the GameState
 * @param {object} [input.squad]    `{ historyMissing }` from buildSquadState()
 */
export function assessReadiness({ evidence, lifecycle, vitals = null, baseline = null, squad = null } = {}) {
  const blocked = [];
  const block = (code, message, ceiling) => blocked.push({ code, message, ceiling });

  // --- the evidence itself -------------------------------------------------
  if (!evidence || !evidence.usable) {
    block('evidence_unusable',
      (evidence && evidence.message)
        || 'There is not enough player data to project from yet.',
      LEVEL.DISPLAY);
  }

  // --- the shape of the pool ----------------------------------------------
  if (vitals && !vitals.empty && vitals.count >= MIN_POOL_FOR_SHAPE_CHECKS) {
    if (vitals.best11 < PLAUSIBLE_GW_MIN || vitals.best11 > PLAUSIBLE_GW_MAX) {
      block('projection_implausible',
        `The best eleven in the game projects ${vitals.best11.toFixed(1)} points this gameweek, which is not a `
        + 'football score. The projection inputs are not trustworthy.',
        LEVEL.DISPLAY);
    }
    if (vitals.topMedianGap < MIN_TOP_MEDIAN_GAP) {
      block('projection_collapsed',
        'Every player is projecting almost the same score, which happens when the minutes model has nothing to '
        + 'separate them.',
        LEVEL.DISPLAY);
    }
    if (vitals.pinnedHighShare > 0.5) {
      block('start_rates_pinned',
        'Most players are being read as certain starters, which happens when a season total is measured against '
        + 'too few matches.',
        LEVEL.LINEUP);
    }
    // The 2026-08-22 shape: a football-sized best eleven made of defenders,
    // because the attacking numerators were cleared while their minutes were
    // restored. The best eleven and the spread both looked healthy.
    if (vitals.attackInverted === true) {
      block('projection_inverted',
        'The best forwards and midfielders in the game are projecting below the best defenders, which happens '
        + 'when scoring rates have been cleared while minutes have not. The projection inputs are not trustworthy.',
        LEVEL.DISPLAY);
    }
    // The 2026-09-16 shape: every aggregate above healthy, and the players who
    // had started every match read as rotation risks. Ordering an eleven the
    // manager owns survives that (his starters are compressed together); buying
    // and selling across the league does not.
    if (vitals.everPresentCount >= MIN_GROUP_FOR_MINUTES_CHECKS
        && vitals.everPresentStartMedian < MIN_EVER_PRESENT_START_MEDIAN) {
      block('minutes_compressed',
        `Players who have started every match are being given a ${Math.round(vitals.everPresentStartMedian * 100)}% `
        + 'chance to start, which understates the regulars against everyone else. The projections are not '
        + 'separating players well enough to buy and sell on.',
        LEVEL.LINEUP);
    }
    if (vitals.everPresentCount >= MIN_GROUP_FOR_MINUTES_CHECKS
        && vitals.benchCount >= MIN_GROUP_FOR_MINUTES_CHECKS
        && vitals.appearanceInversionShare >= MAX_APPEARANCE_INVERSION_SHARE) {
      block('appearance_inverted',
        'Players who have started every match are being read as less likely to play than substitutes, which is '
        + 'the wrong way round. The projections are not trustworthy enough to buy and sell on.',
        LEVEL.LINEUP);
    }
  }

  // --- the lifecycle -------------------------------------------------------
  // Planning the NEXT gameweek while this one is still being scored is normal
  // and stays allowed. What is not allowed is betting a chip on a league whose
  // clubs have played different numbers of matches, because the pool is not
  // comparable across clubs until they level up.
  if (lifecycle && !lifecycle.clubsLevel) {
    block('clubs_uneven',
      `Only ${lifecycle.clubsPlayed} of ${lifecycle.clubsTotal} clubs have played, so players are not yet `
      + 'comparable across the league.',
      LEVEL.TRANSFERS);
  }
  if (lifecycle
      && (lifecycle.phase === GW_PHASE.IN_PROGRESS
        || lifecycle.phase === GW_PHASE.PROVISIONAL
        || lifecycle.phase === GW_PHASE.FINALISING)) {
    block('gameweek_unsettled',
      'This gameweek is still being finalised by Fantasy Premier League, so bonus points and stat corrections '
      + 'can still change the numbers a chip decision would rest on.',
      LEVEL.TRANSFERS);
  }

  // --- a baseline standing in ---------------------------------------------
  // Projecting from last season is exactly right in August and it is what the
  // app has always done pre-season. It is not, however, a footing for spending
  // a chip once the new season has started and disagreed with it.
  if (baseline && baseline.source === 'baseline') {
    block('baseline_substituted',
      'Fantasy Premier League has cleared last season\'s totals, so projections are running on the last complete '
      + 'set we recorded.',
      LEVEL.TRANSFERS);
    // A minutes-only snapshot (the version 1 shape) restores every rate's
    // denominator without its numerator. The engine reads those rates over
    // this season's minutes alone and shrinks them to position averages, so
    // players within a position are barely separated: enough to order an
    // eleven the manager owns, not to buy and sell on.
    if (baseline.rates === 'missing') {
      block('baseline_rates_missing',
        'The player totals we recorded before Fantasy Premier League cleared them cover minutes only, so scoring '
        + 'rates are position averages until this season has enough matches of its own.',
        LEVEL.LINEUP);
    }
  }

  // --- the manager's own records -------------------------------------------
  // Without the season history the chips already played and the banked free
  // transfers are unknown, so nothing that spends either may be proposed.
  if (squad && squad.historyMissing) {
    block('history_missing',
      'Your season history could not be read from Fantasy Premier League, so the chips you have used and your '
      + 'free transfers are unknown.',
      LEVEL.LINEUP);
  }

  // The fifteen in hand are a Free Hit team the manager only had for the
  // gameweek he played the chip in, and the squad it reverts to could not be
  // read. Recommending a transfer here means recommending the sale of a player
  // he does not own, so nothing above LINEUP may be offered.
  if (squad && squad.freeHitUnresolved) {
    block('free_hit_squad',
      `The squad Fantasy Premier League returned is your Free Hit team for gameweek ${squad.freeHitGw}. `
      + 'Your own squad comes back at the next deadline and could not be read yet, so no transfers or chips '
      + 'are recommended against a team you do not keep.',
      LEVEL.LINEUP);
  }

  let level = LEVEL.CHIPS;
  for (const b of blocked) {
    if (ORDER.indexOf(b.ceiling) < ORDER.indexOf(level)) level = b.ceiling;
  }

  return {
    level,
    blocked,
    allow: {
      display: true,
      lineup: levelAtLeast(level, LEVEL.LINEUP),
      transfers: levelAtLeast(level, LEVEL.TRANSFERS),
      chips: levelAtLeast(level, LEVEL.CHIPS),
    },
    // The single sentence the UI shows when something is withheld: the most
    // restrictive reason, because that is the one that has to be resolved.
    headline: blocked.length
      ? blocked.slice().sort((a, b) => ORDER.indexOf(a.ceiling) - ORDER.indexOf(b.ceiling))[0].message
      : null,
  };
}

/** Why recommendations are paused, as a short label for a card heading. */
export function pausedHeadline(readiness) {
  if (!readiness || readiness.allow.chips) return null;
  if (!readiness.allow.lineup) return 'Recommendations paused';
  if (!readiness.allow.transfers) return 'Transfer and chip advice paused';
  return 'Chip advice paused';
}

// THE INVARIANT AT THE POINT OF PRODUCTION
// ----------------------------------------
// Both live-season incidents ended the same way: the ladder correctly refused
// to recommend, `assessConfidence` correctly returned the `unusable` band, and
// the dashboard printed "Recommendations paused" NEXT TO "7.5 xP", a captain
// "1.0 xP doubled" and a projected total. The refusal was a caption on the
// numbers, not a refusal to state them, and a number on screen is a claim
// whatever the label beside it says.
//
// The shared root cause under both incidents is not a football question, it is
// a freshness one: every vintage signal is a ratio whose numerator and
// denominator are refreshed by DIFFERENT, independently observable events.
// Season totals roll over at one instant and the finished-fixture count rolls
// over per match, hours later (GW1). Starts are credited at kickoff and the
// played-out count moves at full time, up to two hours later (GW4). The
// bootstrap and fixtures caches expire on different TTLs, so the totals can
// lead the fixture list by half an hour (not yet triggered, held off only by a
// one-match tolerance). Each time the window opens, the ratio inverts and
// every projection downstream is wrong while looking ordinary.
//
// The ladder is the right place to DECIDE that. These two predicates are the
// place to ENFORCE it, so a new surface that forgets to ask cannot quietly
// become the next one that publishes garbage confidently.

/**
 * May a number derived from the projections be shown as a fact?
 *
 * Lineup level is the threshold because that is the first rung that claims the
 * projections describe football at all: below it the ladder has already found
 * the evidence unusable, or the projections collapsed, implausible or
 * inverted, and every xP downstream is an artefact of that.
 */
export function canQuoteProjections(readiness) {
  return !readiness || readiness.allow.lineup === true;
}

/**
 * May one player be compared against another and a verdict published?
 *
 * Transfer level, because a counterfactual IS a transfer recommendation
 * wearing a question mark: "you would gain 2.1 points" is the same claim as
 * "make this transfer", and it must not outrun what the ladder allows.
 */
export function canCompareSquads(readiness) {
  return !readiness || readiness.allow.transfers === true;
}
