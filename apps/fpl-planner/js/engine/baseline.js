// THE SEASON BASELINE, and refusing to let a mutating payload destroy it.
//
// WHY THIS FILE EXISTS
//
// A start rate is `starts / matches`. The numerator lives on
// bootstrap-static.elements and FPL rewrites it without warning: at 18:04 UTC
// on 2026-08-21 every element total went to zero, mid-evening, while the app
// was running. Before that moment Raya read `starts: 37, minutes: 3330`; after
// it, `starts: 1, minutes: 90`.
//
// The old code had no way to notice, because a payload was whatever the last
// fetch said it was. So the wipe was consumed as fact, 578 of 600 players
// became non-starters against a 38 gameweek denominator, and the planner
// recommended selling the only players who had actually kicked a ball.
//
// The fix is to stop treating "the newest payload" and "the best evidence"
// as the same thing:
//
//   1. every payload is SCORED for completeness before it is believed;
//   2. the last payload that scored well is KEPT as a baseline;
//   3. a payload that scores badly does not replace the baseline, and the
//      baseline is used for the season totals until this season has enough
//      matches of its own to stand on.
//
// A legitimate rollover still works: once clubs have actually played, the
// current season's totals are read against the matches they cover and the
// stale baseline is retired by `baselineIsSuperseded`. Nothing is frozen
// forever because one bad payload arrived.

import { matchesPlayedByClub } from './lifecycle.js';

/** localStorage key. Versioned so a shape change cannot be misread. */
export const BASELINE_KEY = 'fplPlannerSeasonBaseline.v1';

// A payload is a credible full-season baseline when a real share of the pool
// carries minutes. Measured either side of the 2026-08-21 wipe: 400 of 600
// (66.7%) before, 22 of 600 (3.7%) after. A quarter sits nowhere near either.
export const MIN_ACTIVE_SHARE = 0.25;

// ...and when the players who DID play carry a season's worth of appearances
// between them. Expressed per active player rather than as a league aggregate,
// because an aggregate silently encodes how many players the pool holds and
// then fails on any pool smaller than a real league.
//
// Measured: last season's totals ran 6724 starts over 400 active players, 16.8
// each against a 38 gameweek season - 44%. After the wipe, 22 starts over 22
// active players, 1.0 each - 2.6%. A tenth of a season separates them by a
// factor of four in both directions.
export const MIN_STARTS_PER_ACTIVE_SHARE = 0.10;

/**
 * Score a payload's element totals for use as a season baseline.
 *
 * Deliberately expressed as shares and ratios rather than fixed counts, so it
 * keeps working when the pool size or the league size changes.
 */
export function assessBaseline(gameState) {
  const players = [...gameState.players.values()];
  const pool = players.length;
  const totalEvents = gameState.rules.totalEvents || 38;
  const clubs = gameState.teams.size || 20;

  let active = 0;
  let starts = 0;
  let minutes = 0;
  for (const p of players) {
    if (p.minutes > 0) active++;
    starts += p.starts || 0;
    minutes += p.minutes || 0;
  }

  const activeShare = pool > 0 ? active / pool : 0;
  // How much of a season each player who actually played carries.
  const startsPerActive = active > 0 ? starts / active : 0;
  const seasonShare = totalEvents > 0 ? startsPerActive / totalEvents : 0;

  const reasons = [];
  if (pool === 0) reasons.push('empty_pool');
  if (activeShare < MIN_ACTIVE_SHARE) reasons.push('too_few_players_with_minutes');
  if (seasonShare < MIN_STARTS_PER_ACTIVE_SHARE) reasons.push('appearances_too_few_to_be_a_season');

  return {
    complete: reasons.length === 0,
    reasons,
    pool,
    active,
    activeShare,
    starts,
    minutes,
    startsPerActive,
    seasonShare,
    clubs,
    totalEvents,
  };
}

/**
 * The durable form of a good payload: per-player totals plus the aggregate that
 * proves it was worth keeping. Only the fields the minutes model reads, so the
 * snapshot stays small enough for localStorage and carries nothing personal.
 */
export function snapshotFrom(gameState, { capturedAt = new Date().toISOString(), seasonLabel = null } = {}) {
  const assessment = assessBaseline(gameState);
  if (!assessment.complete) return null;
  const totals = {};
  for (const p of gameState.players.values()) {
    if (!p.starts && !p.minutes) continue;   // nothing to remember
    totals[p.id] = { s: p.starts || 0, m: p.minutes || 0, c: p.code ?? null };
  }
  return {
    version: 1,
    capturedAt,
    seasonLabel: seasonLabel || gameState.seasonLabel || null,
    totalEvents: gameState.rules.totalEvents || 38,
    aggregate: {
      pool: assessment.pool,
      active: assessment.active,
      starts: assessment.starts,
      minutes: assessment.minutes,
    },
    totals,
  };
}

/**
 * Has this season overtaken the baseline?
 *
 * The baseline describes a COMPLETED season. Once every club has played enough
 * of the new one, the new totals are the better evidence and the baseline must
 * step aside - otherwise one bad August payload would pin the app to last
 * season for good.
 */
export function baselineIsSuperseded(gameState, { minMatches = 3 } = {}) {
  const played = matchesPlayedByClub(gameState);
  if (!played.size) return false;
  let min = Infinity;
  for (const n of played.values()) min = Math.min(min, n);
  return Number.isFinite(min) && min >= minMatches;
}

/**
 * Decide which totals the minutes model should read, and say so out loud.
 *
 * Returns `{ source, totals, matchesFor, message, assessment }` where `source`
 * is one of:
 *   'current'   - this payload is a credible season in its own right
 *   'baseline'  - this payload is not, and a kept snapshot is standing in
 *   'none'      - neither is usable; nothing may be projected
 */
export function resolveBaseline(gameState, snapshot, { now = Date.now() } = {}) {
  const assessment = assessBaseline(gameState);

  if (assessment.complete) {
    return {
      source: 'current',
      totals: null,                 // read the payload directly
      assessment,
      message: null,
    };
  }

  // This season has genuinely started and accumulated real matches: the thin
  // totals are correct, they are simply early, and the caller measures them
  // against matches played rather than a full season.
  if (baselineIsSuperseded(gameState)) {
    return {
      source: 'current',
      totals: null,
      assessment,
      message: null,
    };
  }

  if (snapshot && snapshot.totals && Object.keys(snapshot.totals).length) {
    return {
      source: 'baseline',
      totals: snapshot.totals,
      snapshot,
      assessment,
      message: 'Fantasy Premier League has cleared last season\'s player totals for the new season. '
        + 'Projections are using the last complete set we recorded until this season has enough matches of its own.',
    };
  }

  return {
    source: 'none',
    totals: null,
    assessment,
    message: 'Fantasy Premier League has cleared last season\'s player totals and this season has not been played yet, '
      + 'so there is nothing to project from.',
  };
}

/** Read a snapshot from a storage-like object, tolerating every failure. */
export function loadSnapshot(storage) {
  try {
    const raw = storage && storage.getItem(BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !parsed.totals) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Keep a snapshot if this payload deserves to be one.
 *
 * Returns the snapshot now in force. Never throws: a full or unavailable
 * localStorage must degrade to "no baseline", never to a broken app.
 */
export function saveSnapshotIfBetter(storage, gameState, { capturedAt, seasonLabel } = {}) {
  const existing = loadSnapshot(storage);
  const candidate = snapshotFrom(gameState, { capturedAt, seasonLabel });
  if (!candidate) return existing;
  // A newer complete payload of the same or a later season replaces the old
  // one; anything else leaves the kept baseline alone.
  if (existing && existing.seasonLabel && candidate.seasonLabel
      && existing.seasonLabel > candidate.seasonLabel) {
    return existing;
  }
  try {
    storage.setItem(BASELINE_KEY, JSON.stringify(candidate));
  } catch {
    return existing;                 // quota or private mode: not fatal
  }
  return candidate;
}
