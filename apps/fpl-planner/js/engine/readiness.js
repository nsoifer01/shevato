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

/**
 * Summarise a projection pool: the sanity facts, not the projections.
 * `rows` is an iterable of `{ xPoints, pStart }`.
 */
export function projectionVitals(rows) {
  const xps = [];
  let pinnedHigh = 0;
  let pinnedLow = 0;
  let counted = 0;
  for (const r of rows) {
    if (!r || !Number.isFinite(r.xPoints)) continue;
    xps.push(r.xPoints);
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
  return {
    empty: false,
    count: xps.length,
    max: xps[0],
    median,
    best11,
    topMedianGap: xps[0] - median,
    pinnedHighShare: counted ? pinnedHigh / counted : 0,
    pinnedLowShare: counted ? pinnedLow / counted : 0,
  };
}

/**
 * How far up the ladder this data can carry a recommendation.
 *
 * @param {object} input
 * @param {object} input.evidence   from seasonEvidence()
 * @param {object} input.lifecycle  from gameweekLifecycle()
 * @param {object} [input.vitals]   from projectionVitals(), when projections exist
 * @param {object} [input.baseline] from assessBaseline()
 */
export function assessReadiness({ evidence, lifecycle, vitals = null, baseline = null } = {}) {
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
