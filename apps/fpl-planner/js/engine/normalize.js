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

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function buildGameState(bootstrap, fixtures, { fetchedAt, baseline = null } = {}) {
  const rules = buildRules(bootstrap);

  const teams = new Map();
  for (const t of bootstrap.teams) teams.set(t.id, normalizeTeam(t));

  const players = new Map();
  for (const e of bootstrap.elements) players.set(e.id, normalizePlayer(e));

  // A kept baseline stands in for season totals FPL has cleared. Only the two
  // evidence fields are overlaid: price, status, news and this season's own
  // cumulative totals stay exactly as the live payload reported them, because
  // those are current facts and the baseline is not.
  //
  // Matched on `code`, FPL's permanent per-player id, because `id` is
  // reassigned between seasons (see FINDINGS, cross-season player identity).
  let baselineSource = 'current';
  if (baseline && baseline.totals) {
    const byCode = new Map();
    for (const [pid, row] of Object.entries(baseline.totals)) {
      if (row && row.c != null) byCode.set(row.c, row);
      else byCode.set(Number(pid), row);
    }
    let overlaid = 0;
    for (const p of players.values()) {
      const row = byCode.get(p.code) ?? baseline.totals[p.id];
      if (!row) continue;
      p.starts = row.s;
      p.minutes = row.m;
      // The denominator these totals were accumulated against, so a start rate
      // reads them over the season they belong to rather than this one.
      p.evidenceMatches = baseline.totalEvents || null;
      overlaid++;
    }
    if (overlaid > 0) baselineSource = 'baseline';
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
    baselineCapturedAt: baselineSource === 'baseline' ? (baseline.capturedAt || null) : null,
    baselineSeasonLabel: baselineSource === 'baseline' ? (baseline.seasonLabel || null) : null,
    fixtures: (fixtures || []).map(normalizeFixture),
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
    minutes: e.minutes,
    starts: e.starts,

    // THIS SEASON'S CUMULATIVE TOTALS, always straight off the payload and
    // never overlaid. Separated from the fields above because the two answer
    // different questions and conflating them is what let a modal label one
    // match of this season "Last season". A cleared total is a real zero here.
    seasonMinutes: e.minutes,
    seasonStarts: e.starts,
    seasonPoints: e.total_points,

    totalPoints: e.total_points,
    bonus: e.bonus,
    bps: e.bps,
    saves: e.saves,
    goalsScored: e.goals_scored,
    assists: e.assists,
    cleanSheets: e.clean_sheets,
    goalsConceded: e.goals_conceded,
    yellowCards: e.yellow_cards,
    redCards: e.red_cards,
    ownGoals: e.own_goals,
    penaltiesSaved: e.penalties_saved,
    penaltiesMissed: e.penalties_missed,

    cbit: e.clearances_blocks_interceptions,
    recoveries: e.recoveries,
    tackles: e.tackles,
    defCon: e.defensive_contribution,

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
