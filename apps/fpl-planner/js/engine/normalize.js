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
import { fixtureIsPlayed } from './lifecycle.js';
import { RATE_FIELDS, snapshotCarriesRates } from './baseline.js';

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

  const normalizedFixtures = (fixtures || []).map(normalizeFixture);

  // A kept baseline stands in for season totals FPL has cleared. Price, status,
  // news and this season's own cumulative totals stay exactly as the live
  // payload reported them, because those are current facts and the baseline is
  // not.
  //
  // THE BLEND. The evidence totals become baseline + this season, over a
  // denominator of baseline matches + this season's matches (`evidenceMatches`
  // for start rates, `minutes` for every per-90 rate). Numerators and
  // denominators therefore grow together and the baseline fades out of every
  // rate at the same pace, until `baselineIsSuperseded` retires it outright.
  //
  // A version 1 snapshot carries minutes only. Its minutes still serve the
  // minutes model, but every rate is then read over THIS season's minutes
  // alone (`rateMinutes`), so a cleared numerator is never divided by a
  // restored denominator; with one match of evidence the shrinkage layer
  // resolves those rates to the position priors, and readiness says so.
  //
  // Matched on `code`, FPL's permanent per-player id, because `id` is
  // reassigned between seasons (see FINDINGS, cross-season player identity).
  let baselineSource = 'current';
  let baselineRates = null;
  if (baseline && baseline.totals) {
    const carriesRates = snapshotCarriesRates(baseline);
    const byCode = new Map();
    for (const [pid, row] of Object.entries(baseline.totals)) {
      if (row && row.c != null) byCode.set(row.c, row);
      else byCode.set(Number(pid), row);
    }
    const playedByClub = new Map();
    for (const f of normalizedFixtures) {
      if (!fixtureIsPlayed(f)) continue;
      for (const t of [f.teamH, f.teamA]) playedByClub.set(t, (playedByClub.get(t) || 0) + 1);
    }
    const baselineMatches = baseline.totalEvents || null;
    let overlaid = 0;
    for (const p of players.values()) {
      const row = byCode.get(p.code) ?? baseline.totals[p.id];
      if (!row) continue;
      p.starts = (row.s || 0) + (p.seasonStarts || 0);
      p.minutes = (row.m || 0) + (p.seasonMinutes || 0);
      // The denominator these totals were accumulated against: the baseline's
      // season plus whatever this club has played of the new one.
      p.evidenceMatches = baselineMatches
        ? baselineMatches + (playedByClub.get(p.teamId) || 0)
        : null;
      if (carriesRates) {
        for (const [key, field] of Object.entries(RATE_FIELDS)) {
          p[field] = (row[key] || 0) + (p[field] || 0);
        }
      } else {
        p.rateMinutes = p.seasonMinutes || 0;
      }
      overlaid++;
    }
    if (overlaid > 0) {
      baselineSource = 'baseline';
      baselineRates = carriesRates ? 'carried' : 'missing';
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
    baselineCapturedAt: baselineSource === 'baseline' ? (baseline.capturedAt || null) : null,
    baselineSeasonLabel: baselineSource === 'baseline' ? (baseline.seasonLabel || null) : null,
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

// The minutes a player's rate numerators cover. Normally his evidence minutes;
// when a minutes-only baseline is standing in (`rateMinutes`, set above) only
// this season's minutes cover the cleared numerators. Every per-90 division in
// the engine reads its denominator through here.
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
