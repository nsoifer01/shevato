// bootstrap-static + fixtures -> the normalized world every other engine module
// reads (GameState). Two jobs: rename FPL's snake_case into the shapes in
// CONTRACTS, and parse the numeric fields FPL ships as strings
// (expected_goals, expected_assists, selected_by_percent, ...) into floats
// exactly once, here, so no downstream module ever does arithmetic on "0.07".
//
// PRE-SEASON NOTE, and it is not an error state: before GW1 no event carries
// is_current, so `currentEvent` is null and `seasonStarted` is false, while
// every player's season totals are LAST season's. Callers branch on
// seasonStarted; nothing throws.

import { buildRules } from './rules.js';
import { snapshotCarriesRates, OPENING_BASELINE_KIND } from './baseline.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function buildGameState(bootstrap, fixtures, { fetchedAt, baseline = null, standIn = true } = {}) {
  const rules = buildRules(bootstrap);

  const teams = new Map();
  for (const t of bootstrap.teams) teams.set(t.id, normalizeTeam(t));

  const players = new Map();
  for (const e of bootstrap.elements) players.set(e.id, normalizePlayer(e));

  const normalizedFixtures = (fixtures || []).map(normalizeFixture);

  // THE PREVIOUS SEASON, attached as a PRIOR rather than added to the totals.
  //
  // Until 2026-09-16 a baseline snapshot was OVERLAID: every player's totals
  // became last season + this season, over last season's 38 matches + this
  // season's, and the whole snapshot was discarded the moment every club had
  // played three matches. Two things were wrong with that. Last season entered
  // at full weight (a starter who missed ten matches injured read as a rotation
  // player all through August), and then it vanished overnight: from gameweek 4
  // a nailed starter was a player with three matches of evidence, shrunk toward
  // the average of every player with a minute to his name, and projected to
  // play 64% to 76% of the time. The xP audit of that date found it.
  //
  // So a snapshot is now evidence of a different KIND, kept apart from this
  // season's totals for the whole season: `player.prior` carries his previous
  // season, `player.starts`/`minutes`/... carry this one, and each model
  // (minutes.js, projections.js, strength.js) decides how much the previous
  // season is worth against this one, with weights measured on the replay
  // (experiments/registry.md, entry 29). Nothing here divides anything.
  //
  // `standIn` says whether the snapshot is also STANDING IN for a season too
  // young to project from on its own (the opening weeks), which is what
  // `baselineSource: 'baseline'` has always meant to readiness and the UI.
  //
  // Matched on `code`, FPL's permanent per-player id, because `id` is
  // reassigned between seasons (see FINDINGS, cross-season player identity).
  let baselineSource = 'current';
  let baselineRates = null;
  let baselineOrigin = null;
  let priorSeason = null;
  if (baseline && baseline.totals) {
    const carriesRates = snapshotCarriesRates(baseline);
    const byCode = new Map();
    let goals = 0;
    let squadMinutes = 0;
    for (const [pid, row] of Object.entries(baseline.totals)) {
      if (!row) continue;
      if (row.c != null) byCode.set(row.c, row);
      else byCode.set(Number(pid), row);
      goals += (row.gs || 0) + (row.og || 0);
      squadMinutes += row.m || 0;
    }
    let attached = 0;
    for (const p of players.values()) {
      const row = byCode.get(p.code) ?? baseline.totals[p.id];
      p.prior = row ? priorFromRow(row, { matches: baseline.totalEvents || null, carriesRates }) : null;
      if (row) attached++;
    }
    if (attached > 0) {
      baselineSource = standIn ? 'baseline' : 'current';
      baselineRates = carriesRates ? 'carried' : 'missing';
      // 'shipped' for the baseline committed with the app, 'kept' for one this
      // browser recorded itself. The two are read identically.
      baselineOrigin = baseline.kind === OPENING_BASELINE_KIND ? 'shipped' : 'kept';
      priorSeason = {
        origin: baselineOrigin,
        rates: baselineRates,
        capturedAt: baseline.capturedAt || null,
        seasonLabel: baseline.coversSeason || null,
        totalEvents: baseline.totalEvents || null,
        players: attached,
        // Goals per team match last season, read over the squads' own minutes
        // (990 player-minutes make one team match) so a snapshot that only
        // holds the players still registered this season is not biased low.
        goalsPerTeamMatch: squadMinutes > 0 && carriesRates ? goals / (squadMinutes / 990) : null,
      };
    }
  }

  const events = bootstrap.events.map(normalizeEvent);
  const current = events.find(e => e.isCurrent) || null;
  const next = events.find(e => e.isNext) || null;

  return {
    rules,
    teams,
    players,
    // Which season the evidence totals came from. 'current' means the payload's
    // own; 'baseline' means a kept snapshot is standing in for cleared totals.
    baselineSource,
    // 'carried' when the baseline restored the rate numerators with the
    // minutes; 'missing' when a minutes-only snapshot is in force and rates
    // are read over this season's minutes alone; null without a baseline.
    baselineRates,
    baselineOrigin,
    baselineCapturedAt: priorSeason ? (baseline.capturedAt || null) : null,
    baselineSeasonLabel: priorSeason ? (baseline.seasonLabel || null) : null,
    // The previous-season record in force as a prior (see above), or null.
    priorSeason,
    // The season this payload itself belongs to, read from the static content
    // path in `rules`. `snapshotFrom` stamps it onto every snapshot it writes,
    // which is what lets a later season refuse an older browser's baseline.
    // The field was READ here before it was ever SET, so every snapshot
    // written before 2026-08-25 carries `seasonLabel: null`.
    seasonLabel: rules.season || null,
    fixtures: normalizedFixtures,
    events,
    fetchedAt: fetchedAt || new Date().toISOString(),
    currentEvent: current ? current.id : null,
    nextEvent: next ? next.id : null,
    // "Has a ball been kicked yet." Any played, current or past event counts,
    // because a finished final gameweek leaves nothing marked current either.
    seasonStarted: events.some(e => e.isCurrent || e.isPrevious || e.finished),
    // The ?demo=1 dataset stamps `sample: true` on the bootstrap it assembles.
    // Carrying it here is what lets every consumer (dataStatus, the UI, the
    // persistence layer) tell sample data from live data without asking how the
    // payload was loaded.
    sample: !!(bootstrap && bootstrap.sample),
  };
}

// One snapshot row as a player's previous season, in GameState field names.
// A version 1 row carries minutes and starts only, so every rate numerator is
// null rather than a zero it never measured. `xm` and `dm` are the replay's
// coverage annotations (minutes the xG/xA and defensive-contribution columns
// actually cover); a shipped asset never carries them and they default to the
// minutes.
function priorFromRow(row, { matches, carriesRates }) {
  const rate = (key) => (carriesRates ? (row[key] || 0) : null);
  const minutes = row.m || 0;
  return {
    starts: row.s || 0,
    minutes,
    matches,
    rates: !!carriesRates,
    xG: rate('xg'),
    xA: rate('xa'),
    xGC: rate('xgc'),
    bps: rate('bps'),
    bonus: rate('bo'),
    saves: rate('sv'),
    goalsScored: rate('gs'),
    assists: rate('as'),
    cleanSheets: rate('cs'),
    goalsConceded: rate('gc'),
    yellowCards: rate('yc'),
    redCards: rate('rc'),
    penaltiesSaved: rate('ps'),
    ownGoals: rate('og'),
    penaltiesMissed: rate('pm'),
    cbit: rate('cbit'),
    recoveries: rate('rec'),
    tackles: rate('tck'),
    defCon: rate('dc'),
    xMinutes: Number.isFinite(row.xm) ? row.xm : minutes,
    dcMinutes: Number.isFinite(row.dm) ? row.dm : minutes,
  };
}

// The minutes a player's rate numerators cover: his minutes, unless a caller
// (the historical replay) has declared a narrower denominator. Every per-90
// division in the engine reads its denominator through here.
export function rateMinutesOf(player) {
  return Number.isFinite(player.rateMinutes) ? player.rateMinutes : (player.minutes || 0);
}

export function normalizeTeam(t) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    shortName: t.short_name,
    strengthOverallHome: t.strength_overall_home,
    strengthOverallAway: t.strength_overall_away,
  };
}

export function normalizePlayer(e) {
  return {
    id: e.id,
    code: e.code,
    webName: e.web_name,
    firstName: e.first_name,
    secondName: e.second_name,
    teamId: e.team,
    position: e.element_type,
    nowCost: e.now_cost,
    // Price movement since the season opened, in tenths. squad.js needs it to
    // recover the start-of-season price of a player who was never transferred
    // in (nowCost - costChangeStart), which is the only purchase price the
    // public API can reconstruct for an original pick.
    costChangeStart: e.cost_change_start ?? 0,
    // Price movement since the CURRENT gameweek's deadline, in tenths. It is
    // what lets squad.js roll a price back to the moment FPL froze
    // `entry_history.value`, and so tell an ordinary overnight move apart from
    // a reconstruction that genuinely does not add up.
    costChangeEvent: e.cost_change_event ?? 0,
    // FPL's OWN short-term price-change prediction, or null when the payload
    // does not carry one (it did not exist before 2026/27, and every fixture
    // recorded before then is missing it). engine/price-change.js is the only
    // module allowed to interpret this; see its header for what is inferred.
    priceChange: normalizePriceChange(e),
    status: e.status,
    // FPL gives a percentage, the engine works in probabilities.
    chanceNext: e.chance_of_playing_next_round === null || e.chance_of_playing_next_round === undefined
      ? null
      : e.chance_of_playing_next_round / 100,
    news: e.news || '',
    newsAdded: e.news_added || null,
    selectedByPercent: num(e.selected_by_percent),

    // THE EVIDENCE TOTALS the minutes model reads. Normally these ARE the
    // payload's season totals, but when FPL has cleared them mid-season they
    // are overlaid from the kept baseline (see engine/baseline.js), because a
    // wiped total is not a measurement of anything.
    //
    // Every count below goes through `num` too, although FPL sends them as
    // integers today. It already sends the expected_* totals as strings, and a
    // count that arrived as "4" is not a harmless difference: `positionPriors`
    // SUMS starts across a position, so "4" + "3" concatenates, the prior start
    // rate clamps to 1, and on the 2026-09-13 payload the best eleven inflated
    // from 39.8 to 65.9 while every readiness check still passed.
    minutes: num(e.minutes),
    starts: num(e.starts),

    // THIS SEASON'S CUMULATIVE TOTALS, always straight off the payload and
    // never overlaid. Separated from the fields above because the two answer
    // different questions and conflating them is what let a modal label one
    // match of this season "Last season". A cleared total is a real zero here.
    seasonMinutes: num(e.minutes),
    seasonStarts: num(e.starts),
    seasonPoints: num(e.total_points),

    totalPoints: num(e.total_points),
    bonus: num(e.bonus),
    bps: num(e.bps),
    saves: num(e.saves),
    goalsScored: num(e.goals_scored),
    assists: num(e.assists),
    cleanSheets: num(e.clean_sheets),
    goalsConceded: num(e.goals_conceded),
    yellowCards: num(e.yellow_cards),
    redCards: num(e.red_cards),
    ownGoals: num(e.own_goals),
    penaltiesSaved: num(e.penalties_saved),
    penaltiesMissed: num(e.penalties_missed),

    cbit: num(e.clearances_blocks_interceptions),
    recoveries: num(e.recoveries),
    tackles: num(e.tackles),
    defCon: num(e.defensive_contribution),

    xG: num(e.expected_goals),
    xA: num(e.expected_assists),
    xGI: num(e.expected_goal_involvements),
    xGC: num(e.expected_goals_conceded),

    per90: {
      xG: num(e.expected_goals_per_90),
      xA: num(e.expected_assists_per_90),
      xGI: num(e.expected_goal_involvements_per_90),
      xGC: num(e.expected_goals_conceded_per_90),
      saves: num(e.saves_per_90),
      goalsConceded: num(e.goals_conceded_per_90),
      starts: num(e.starts_per_90),
      cleanSheets: num(e.clean_sheets_per_90),
      defCon: num(e.defensive_contribution_per_90),
    },

    setPieces: {
      penaltiesOrder: e.penalties_order ?? null,
      directFreekicksOrder: e.direct_freekicks_order ?? null,
      cornersOrder: e.corners_and_indirect_freekicks_order ?? null,
    },
  };
}

// bootstrap-static's price-change fields -> one object, or null.
//
// DEFENSIVE ON PURPOSE. These fields are new, undocumented, and ship their
// numbers as strings ("116.5"), so every one of them is parsed and range
// checked here and nothing downstream ever sees a raw payload value. Returning
// null for "no usable data" rather than an object full of nulls is what lets
// every caller ask one question instead of five.
//
// `price_change_hourly_rate` is READ AND DROPPED. See the price-change module
// header: its units do not reconcile with the projections, so carrying it would
// only invite something to extrapolate from it.
export function normalizePriceChange(e) {
  if (!e || typeof e !== 'object') return null;

  const progress = finiteOrNull(e.price_change_percent);
  const projections = normalizePriceProjections(e.price_change_projections);
  const lockedUntil = isoOrNull(e.price_change_locked_until);
  const calibrating = e.price_change_calibrating === true;

  // A payload that carries none of it is a payload from before the feature
  // existed, and that is not an error state: the app simply shows no prices.
  if (progress === null && !projections.length && !lockedUntil && !calibrating) return null;

  return { progressPercent: progress, projections, lockedUntil, calibrating };
}

// Malformed entries are DROPPED rather than defaulted. A projection with an
// unreadable percent is not a projection of zero, and treating it as one would
// invent a "no movement" claim the API never made.
function normalizePriceProjections(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const offset = finiteOrNull(p.offset);
    const projectedPercent = finiteOrNull(p.projected_percent);
    if (offset === null || projectedPercent === null) continue;
    if (!Number.isInteger(offset) || offset < 0) continue;
    if (seen.has(offset)) continue;         // first wins; a duplicate offset is not two windows
    seen.add(offset);

    // Clamped, not rejected: an out-of-range likelihood from a future API is a
    // tier we do not know, and losing the projection over it would be worse
    // than reading its confidence conservatively.
    const rawLikelihood = finiteOrNull(p.likelihood);
    const likelihood = rawLikelihood === null
      ? null
      : Math.max(-5, Math.min(5, Math.trunc(rawLikelihood)));

    out.push({ offset, projectedPercent, likelihood });
  }
  // Sorted so index order is time order regardless of how the payload arrived.
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

// Unlike `num()` above, these two answer "was this present and readable?" and
// so must be able to say no. `num()` folds every failure to 0, which is right
// for a rate and wrong for a prediction.
function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(v) {
  if (!v) return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function normalizeFixture(f) {
  return {
    id: f.id,
    code: f.code,
    // null for a fixture not yet assigned to a gameweek (postponements land
    // here); consumers treat that as "no fixture this gameweek".
    event: f.event ?? null,
    kickoff: f.kickoff_time || null,
    teamH: f.team_h,
    teamA: f.team_a,
    teamHDifficulty: f.team_h_difficulty,
    teamADifficulty: f.team_a_difficulty,
    finished: !!f.finished,
    // FPL sets this at full time and clears `finished` until bonus and stat
    // corrections are applied, which on 2026-08-21 was still the case five
    // hours after the whistle. Dropping it made the app structurally unable to
    // tell "the match is being played" from "the match is over but not signed
    // off", so every consumer had to pretend `finished` was the only truth.
    finishedProvisional: !!f.finished_provisional,
    started: !!f.started,
    teamHScore: f.team_h_score ?? null,
    teamAScore: f.team_a_score ?? null,
  };
}

export function normalizeEvent(e) {
  return {
    id: e.id,
    name: e.name,
    deadline: e.deadline_time,
    deadlineEpoch: e.deadline_time_epoch,
    finished: !!e.finished,
    dataChecked: !!e.data_checked,
    isCurrent: !!e.is_current,
    isNext: !!e.is_next,
    isPrevious: !!e.is_previous,
    averageEntryScore: e.average_entry_score ?? null,
    highestScore: e.highest_score ?? null,
  };
}
