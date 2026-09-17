// The 2026/27 gameweek 3 and 4 deadlines, rebuilt from the payloads captured on
// 2026-09-16 (tests/fixtures/xp-calibration-2026, derived by
// scripts/derive-calibration-fixtures.mjs), and the scoring of a projection
// against what those gameweeks produced. Engine-agnostic on purpose: the rows it
// scores come from whatever engine the caller ran, so the same bands can be
// shown to fail on the model that shipped.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'xp-calibration-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

export const BASE = J('base.json');
const TOTALS = J('totals-after-gw4.json');
const LIVE = { 3: J('live-gw3.json'), 4: J('live-gw4.json') };
const SIGNED_OFF_GW = 4;
export const DEADLINES = Object.freeze([3, 4]);

const table = ({ fields, rows }) => new Map(rows.map((r) => [r[0], Object.fromEntries(fields.map((f, i) => [f, r[i]]))]));

/** What each player actually did in a gameweek, by element id. */
export function liveStats(gw) {
  if (!LIVE[gw]) throw new Error(`no live stats captured for gameweek ${gw}`);
  return table(LIVE[gw]);
}

/**
 * The raw bootstrap-static and fixtures payloads FPL served at the gameweek
 * `gw` deadline: the totals after gameweek 4 with gameweeks gw..4 taken back
 * out, those gameweeks' fixtures unplayed, and the event flags of the week
 * before. Injury flags are the one thing that cannot be rebuilt (the capture
 * carries gameweek 5's), so every player is read as available, which is how
 * the audit's backchecks read them too.
 */
export function deadlinePayload(gw) {
  const totals = table(TOTALS);
  const rewind = [];
  for (let g = gw; g <= SIGNED_OFF_GW; g++) rewind.push(liveStats(g));
  const elements = BASE.elements.map((e) => {
    const out = { ...e, ...(totals.get(e.id) || {}) };
    for (const live of rewind) {
      const s = live.get(e.id);
      if (!s) continue;
      for (const [k, v] of Object.entries(s)) {
        if (k === 'id') continue;
        const left = Number(out[k]) - Number(v);
        // Expected goals travel as strings; everything else is a count.
        out[k] = typeof out[k] === 'string' ? left.toFixed(2) : left;
      }
    }
    out.status = 'a';
    out.chance_of_playing_next_round = null;
    out.news = '';
    out.news_added = null;
    return out;
  });
  const events = BASE.events.map((ev) => ({
    ...ev,
    is_previous: ev.id === gw - 2,
    is_current: ev.id === gw - 1,
    is_next: ev.id === gw,
    finished: ev.id < gw ? ev.finished : false,
    data_checked: ev.id < gw ? ev.data_checked : false,
  }));
  const fixtures = BASE.fixtures.map((f) => (f.event >= gw
    ? { ...f, started: false, finished: false, finished_provisional: false, team_h_score: null, team_a_score: null }
    : { ...f }));
  const bootstrap = {
    events,
    game_settings: BASE.game_settings,
    game_config: BASE.game_config,
    phases: BASE.phases,
    teams: BASE.teams,
    element_types: BASE.element_types,
    total_players: BASE.total_players,
    elements,
  };
  const deadline = events.find((ev) => ev.id === gw).deadline_time;
  // The payload is read an hour before the deadline.
  const fetchedAt = new Date(Date.parse(deadline) - 3600e3).toISOString();
  return { bootstrap, fixtures, fetchedAt };
}

/**
 * One row per player with a fixture in `gw`, in the shape
 * scripts/lib/calibration-guard.mjs reads. `clubMatches` maps a club to the
 * matches it has kicked off this season.
 */
export function scoreDeadline({ gameState, projections, gw, clubMatches }) {
  const actual = liveStats(gw);
  const rows = [];
  for (const [id, list] of projections.byPlayer) {
    const r = list.find((x) => x.gw === gw);
    if (!r || !r.fixtures.length) continue;
    const p = gameState.players.get(id);
    const a = actual.get(id);
    const m = clubMatches.get(p.teamId) || 0;
    rows.push({
      id,
      name: p.webName,
      teamId: p.teamId,
      position: p.position,
      fixtures: r.fixtures.length,
      xPoints: r.xPoints,
      pStart: r.pStart,
      pAppear: r.pAppear,
      xMins: r.xMins,
      points: a ? a.total_points : 0,
      minutes: a ? a.minutes : 0,
      started: a && a.starts > 0 ? 1 : 0,
      appeared: a && a.minutes > 0 ? 1 : 0,
      everPresent: m > 0 && (p.seasonStarts || 0) >= m,
      clubMatches: m,
    });
  }
  return rows;
}
