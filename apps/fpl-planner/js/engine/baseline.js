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

/**
 * The `kind` stamped on the baseline shipped with the app.
 *
 * WHY A SHIPPED BASELINE EXISTS AT ALL. Keeping the last good payload only
 * helps a browser that was already running this code when the last good
 * payload arrived. In 2026 it was not: FPL cleared the totals at 18:04 UTC on
 * 2026-08-21 and this module reached production at 16:04 UTC on 2026-08-22, so
 * `snapshotFrom` - which only ever returns a snapshot of a COMPLETE payload -
 * had nothing left to snapshot. Every real visitor, first-time or returning,
 * fell to `source: 'none'` and was refused a plan until three matches per club.
 * The kept snapshot is the right mechanism and it stays first; the shipped
 * asset is what a browser falls back to when it never got the chance to keep
 * one of its own.
 */
export const OPENING_BASELINE_KIND = 'opening-season-baseline';

// How far either side of a season's opening deadline a snapshot with no season
// label may have been captured and still be believed. Snapshots written before
// 2026-08-25 carry `seasonLabel: null` (`buildGameState` never set the field it
// read), so they cannot be matched by label and are dated instead: a season
// runs roughly ten months from its opening deadline, and pre-season traffic
// starts a couple of months before it.
export const UNLABELLED_SNAPSHOT_WINDOW_MS = {
  before: 120 * 24 * 60 * 60 * 1000,
  after: 330 * 24 * 60 * 60 * 1000,
};

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
 * Snapshot shape version. Version 1 (shipped 2026-08-21) kept only `{s, m, c}`
 * per player: the DENOMINATORS of every rate. FPL clears the numerators
 * (expected_goals, expected_assists, bps, saves, ...) in the same wipe, so a
 * version 1 snapshot applied to a wiped payload read one match of attacking
 * output over a season of minutes: on the 2026-08-22 production payload the
 * best forward in the pool projected 1.9, the top defenders 5, and the plan
 * was 5-4-1 captained by a defender. Version 2 carries every numerator whose
 * denominator it restores, so restored rates are internally consistent.
 */
export const SNAPSHOT_VERSION = 2;

// Per-player numerators the snapshot carries, keyed by the short name stored
// and the GameState field it comes from. Every field here is divided by
// `minutes` (or `starts`) somewhere in the engine; a snapshot that restores the
// divisor must restore the dividend with it.
export const RATE_FIELDS = Object.freeze({
  xg: 'xG', xa: 'xA', xgc: 'xGC', bps: 'bps', bo: 'bonus', sv: 'saves',
  gs: 'goalsScored', as: 'assists', cs: 'cleanSheets', gc: 'goalsConceded',
  yc: 'yellowCards', rc: 'redCards', ps: 'penaltiesSaved', og: 'ownGoals',
  pm: 'penaltiesMissed', cbit: 'cbit', rec: 'recoveries', tck: 'tackles', dc: 'defCon',
});

/** Does this snapshot carry the rate numerators, or only the minutes? */
export function snapshotCarriesRates(snapshot) {
  return !!snapshot && Number(snapshot.version) >= 2;
}

/**
 * The durable form of a good payload: per-player totals plus the aggregate that
 * proves it was worth keeping. Only the fields the engine divides, so the
 * snapshot stays small enough for localStorage and carries nothing personal.
 */
export function snapshotFrom(gameState, { capturedAt = new Date().toISOString(), seasonLabel = null } = {}) {
  const assessment = assessBaseline(gameState);
  if (!assessment.complete) return null;
  const totals = {};
  for (const p of gameState.players.values()) {
    if (!p.starts && !p.minutes) continue;   // nothing to remember
    const row = { s: p.starts || 0, m: p.minutes || 0, c: p.code ?? null };
    for (const [key, field] of Object.entries(RATE_FIELDS)) {
      const v = p[field];
      if (Number.isFinite(v) && v !== 0) row[key] = Math.round(v * 100) / 100;
    }
    totals[p.id] = row;
  }
  return {
    version: SNAPSHOT_VERSION,
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
 * Returns `{ source, origin, totals, message, assessment, rejected }` where
 * `source` is one of:
 *   'current'   - this payload is a credible season in its own right
 *   'baseline'  - this payload is not, and a baseline is standing in
 *   'none'      - neither is usable; nothing may be projected
 *
 * and `origin` says WHICH baseline is standing in: 'kept' for this browser's
 * own snapshot, 'shipped' for the one committed with the app. Downstream code
 * reads `source`, so a shipped baseline travels through readiness, the status
 * panel and the player drawer exactly as a kept one does.
 */
export function resolveBaseline(gameState, snapshot, { now = Date.now(), shipped = null } = {}) {
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

  // THE LADDER. A kept snapshot that carries its rate numerators is the best
  // evidence available: it is this browser's own record of the last complete
  // payload. The shipped baseline comes next, because it is the same kind of
  // record captured once, centrally, from a payload we can name. A version 1
  // kept snapshot comes LAST despite being the user's own, because it restores
  // every rate's denominator without its numerator and the engine then has to
  // fall back to position averages - strictly less than the shipped asset can
  // say. Below all three, nothing may be projected.
  const kept = validateKeptSnapshot(snapshot, gameState, { now });
  const canned = validateOpeningBaseline(shipped, gameState);

  const chosen = (kept.ok && snapshotCarriesRates(snapshot) && { snapshot, origin: 'kept' })
    || (canned.ok && { snapshot: shipped, origin: 'shipped' })
    || (kept.ok && { snapshot, origin: 'kept' })
    || null;

  if (chosen) {
    const rates = snapshotCarriesRates(chosen.snapshot) ? 'carried' : 'missing';
    return {
      source: 'baseline',
      origin: chosen.origin,
      totals: chosen.snapshot.totals,
      snapshot: chosen.snapshot,
      rates,
      assessment,
      rejected: [...kept.reasons, ...canned.reasons],
      message: rates === 'carried'
        ? (chosen.origin === 'shipped'
          ? 'Fantasy Premier League has cleared last season\'s player totals for the new season. Projections are '
            + 'using the complete set this app ships until this season has enough matches of its own.'
          : 'Fantasy Premier League has cleared last season\'s player totals for the new season. '
            + 'Projections are using the last complete set we recorded until this season has enough matches of its own.')
        : 'Fantasy Premier League has cleared last season\'s player totals for the new season. The set we recorded '
          + 'earlier covers minutes only, so scoring rates fall back to position averages until this season has '
          + 'enough matches of its own.',
    };
  }

  // The sentence has to match the state in front of the reader. "This season
  // has not been played yet" is false once a gameweek has finished, and saying
  // it anyway is the same defect the withheld view carried: an explanation
  // that contradicts the screen it appears on.
  const started = !!(gameState && gameState.seasonStarted);
  return {
    source: 'none',
    totals: null,
    assessment,
    rejected: [...kept.reasons, ...canned.reasons],
    message: started
      ? 'Fantasy Premier League has cleared last season\'s player totals and this season is not yet long enough '
        + 'to project from on its own.'
      : 'Fantasy Premier League has cleared last season\'s player totals and this season has not been played yet, '
        + 'so there is nothing to project from.',
  };
}

/**
 * May this browser-kept snapshot be applied to this payload?
 *
 * The shape check is `loadSnapshot`'s job. This is the SEASON check, and it
 * exists because a baseline is last season's evidence: applied to the season
 * after the one it was captured in it is not a prior, it is a two-year-old
 * fiction that would survive every completeness test in this file.
 */
export function validateKeptSnapshot(snapshot, gameState, { now = Date.now() } = {}) {
  const reasons = [];
  if (!snapshot || !snapshot.totals || !Object.keys(snapshot.totals).length) {
    return { ok: false, reasons: snapshot ? ['kept_snapshot_empty'] : [] };
  }

  const season = gameState && gameState.rules ? gameState.rules.season : null;
  if (snapshot.seasonLabel && season) {
    // HOW FAR BACK A LABEL MAY POINT, and why it is not an equality test.
    //
    // `seasonLabel` has meant two things over the life of this field. A
    // snapshot written by `snapshotFrom` is stamped with the season of the
    // PAYLOAD it came from (2026/27 for a payload carrying 2025/26 totals),
    // while callers that pass `seasonLabel` explicitly have used it for the
    // season the TOTALS describe (2025/26 for the same data). Both readings
    // are one season apart by construction, so an equality test would refuse
    // half of the snapshots it was meant to accept - which is exactly what it
    // did to the legacy version 1 snapshot the moment it was written.
    //
    // What actually has to be refused is a baseline from a season that is over
    // and gone: last season's totals are a legitimate prior for this one, the
    // season before that is a two-year-old fiction. So the test is distance,
    // and the tolerance is one.
    const behind = seasonsBehind(snapshot.seasonLabel, season);
    if (behind === null) reasons.push('kept_snapshot_unreadable_season');
    else if (behind < 0) reasons.push('kept_snapshot_from_the_future');
    else if (behind > 1) reasons.push('kept_snapshot_wrong_season');
  } else if (!snapshot.seasonLabel) {
    // Unlabelled: every snapshot written before 2026-08-25. Date it against
    // this season's opening deadline instead of trusting it forever.
    const anchor = firstDeadlineEpoch(gameState);
    const captured = Date.parse(snapshot.capturedAt || '');
    if (Number.isFinite(anchor) && Number.isFinite(captured)) {
      if (captured < anchor - UNLABELLED_SNAPSHOT_WINDOW_MS.before
        || captured > anchor + UNLABELLED_SNAPSHOT_WINDOW_MS.after) {
        reasons.push('kept_snapshot_outside_season');
      }
    } else if (!Number.isFinite(captured)) {
      // No label and no capture date is a snapshot that cannot be placed in
      // time at all. `now` is not evidence about the payload.
      reasons.push('kept_snapshot_undateable');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * May the shipped opening-season baseline be applied to this payload?
 *
 * Two independent pins on the calendar, because this asset is committed to the
 * repository and will still be sitting there in 2027: the season label the
 * payload publishes, and the opening deadline of that season. A future season
 * matches neither, so the 2026/27 asset cannot silently become its prior. The
 * shape and completeness checks are here too, so a truncated or hand-edited
 * asset is refused rather than projected from.
 */
export function validateOpeningBaseline(asset, gameState) {
  const reasons = [];
  if (!asset) return { ok: false, reasons: [] };

  if (asset.kind !== OPENING_BASELINE_KIND) reasons.push('shipped_wrong_kind');
  if (Number(asset.version) < SNAPSHOT_VERSION) reasons.push('shipped_version_too_old');
  if (!asset.totals || typeof asset.totals !== 'object' || !Object.keys(asset.totals).length) {
    reasons.push('shipped_no_totals');
  }

  const season = gameState && gameState.rules ? gameState.rules.season : null;
  if (!asset.appliesToSeason) reasons.push('shipped_no_season');
  else if (!season) reasons.push('payload_season_unknown');
  else if (asset.appliesToSeason !== season) reasons.push('shipped_wrong_season');

  const anchor = firstDeadline(gameState);
  if (!asset.firstDeadline) reasons.push('shipped_no_deadline');
  else if (anchor && Date.parse(asset.firstDeadline) !== Date.parse(anchor)) reasons.push('shipped_wrong_calendar');

  const events = gameState && gameState.rules ? gameState.rules.totalEvents : null;
  if (events && asset.totalEvents && Number(asset.totalEvents) !== Number(events)) {
    reasons.push('shipped_wrong_season_length');
  }

  // The asset has to be the thing it claims to be: a season's worth of
  // appearances, by the same measure every payload is judged by.
  const agg = asset.aggregate || {};
  const active = Number(agg.active) || 0;
  const pool = Number(agg.pool) || 0;
  const starts = Number(agg.starts) || 0;
  const perActive = active > 0 ? starts / active : 0;
  const totalEvents = Number(asset.totalEvents) || 38;
  if (!(pool > 0 && active / pool >= MIN_ACTIVE_SHARE)) reasons.push('shipped_too_few_active');
  if (!(perActive / totalEvents >= MIN_STARTS_PER_ACTIVE_SHARE)) reasons.push('shipped_not_a_season');
  // The aggregate is a claim ABOUT the totals; a file whose rows do not back it
  // up has been truncated or edited.
  if (asset.totals && Object.keys(asset.totals).length < active) reasons.push('shipped_totals_truncated');

  return { ok: reasons.length === 0, reasons };
}

/**
 * How many seasons before `current` the label `label` is. 0 for the same
 * season, 1 for the one before, negative for a label from the future, null
 * when either side cannot be parsed.
 */
export function seasonsBehind(label, current) {
  const start = (v) => {
    const m = /^(\d{4})\/(\d{2})$/.exec(String(v || '').trim());
    return m ? Number(m[1]) : null;
  };
  const a = start(label);
  const b = start(current);
  if (a === null || b === null) return null;
  return b - a;
}

function firstDeadline(gameState) {
  const events = gameState && gameState.events ? gameState.events : [];
  const first = events.find(e => e.id === 1) || events[0];
  return first ? first.deadline || null : null;
}

function firstDeadlineEpoch(gameState) {
  return Date.parse(firstDeadline(gameState) || '');
}

/** Read a snapshot from a storage-like object, tolerating every failure. */
export function loadSnapshot(storage) {
  try {
    const raw = storage && storage.getItem(BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Version 1 (minutes only) is still read: it is worth keeping for the
    // minutes model, and normalize.js marks its rates as missing so they are
    // never divided one-match-over-a-season again. It is replaced by the next
    // complete payload (saveSnapshotIfBetter), which is the upgrade path.
    if (!parsed || !(parsed.version === 1 || parsed.version === SNAPSHOT_VERSION) || !parsed.totals) return null;
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
  // one; anything else leaves the kept baseline alone. A minutes-only snapshot
  // is always worth replacing by one that carries its numerators.
  if (existing && snapshotCarriesRates(existing) && existing.seasonLabel && candidate.seasonLabel
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
