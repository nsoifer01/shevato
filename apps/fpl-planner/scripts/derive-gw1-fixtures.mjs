// Derives the compact, sanitized GW1-2026 lifecycle fixtures used by
// tests/season-lifecycle.test.mjs from raw payloads captured off the live
// proxy on 2026-08-21.
//
// The raw captures are 1.5 MB each and the entry payloads carry a real
// manager's name and team id, so nothing raw is committed. What the tests need
// is the SHAPE of each lifecycle state, and the states differ from each other
// in very little: the same players, the same fixture list, and a handful of
// flags and totals. So one base is written once and each state is stored as a
// delta against it, which is the difference between two megabytes and eighty
// kilobytes.
//
//   node apps/fpl-planner/scripts/derive-gw1-fixtures.mjs [raw-dir] [out-dir]
//
// Defaults to ~/fpl-gw1-evidence/raw and apps/fpl-planner/tests/fixtures/gw1-2026.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2] || join(homedir(), 'fpl-gw1-evidence', 'raw');
const OUT = process.argv[3] || join(HERE, '..', 'tests', 'fixtures', 'gw1-2026');

const ENTRY_ID = 1234567;                       // fictional: no real identity ships
const ENTRY_NAME = 'Test Entry';

const J = (f) => JSON.parse(readFileSync(join(RAW, f), 'utf8'));
const has = (f) => existsSync(join(RAW, f));
const write = (f, v) => writeFileSync(join(OUT, f), JSON.stringify(v));

// Element metadata that does NOT change between lifecycle states.
const META = [
  'id', 'code', 'web_name', 'first_name', 'second_name', 'team', 'element_type',
  'now_cost', 'cost_change_start', 'status', 'chance_of_playing_next_round',
  'news', 'news_added', 'selected_by_percent',
  'penalties_order', 'direct_freekicks_order', 'corners_and_indirect_freekicks_order',
];
// Totals that DO change: these are what FPL rewrote at the rollover.
const TOTALS = [
  'minutes', 'starts', 'total_points', 'bonus', 'bps', 'saves', 'goals_scored',
  'assists', 'clean_sheets', 'goals_conceded', 'yellow_cards', 'red_cards',
  'own_goals', 'penalties_saved', 'penalties_missed',
  'clearances_blocks_interceptions', 'recoveries', 'tackles', 'defensive_contribution',
  'expected_goals', 'expected_assists', 'expected_goal_involvements', 'expected_goals_conceded',
  'expected_goals_per_90', 'expected_assists_per_90', 'expected_goal_involvements_per_90',
  'expected_goals_conceded_per_90', 'saves_per_90', 'goals_conceded_per_90',
  'starts_per_90', 'clean_sheets_per_90', 'defensive_contribution_per_90',
];

const pick = (o, keys) => { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; };

function main() {
  mkdirSync(OUT, { recursive: true });

  const before = J('bootstrap-before.json');

  // Sixteen players per club: enough pool for the league-shape invariants to
  // be about a league, small enough to commit.
  const byTeam = new Map();
  for (const e of before.elements) {
    const arr = byTeam.get(e.team) || []; arr.push(e); byTeam.set(e.team, arr);
  }
  const keep = new Set();
  for (const [, arr] of byTeam) {
    arr.sort((a, b) => b.now_cost - a.now_cost);
    for (const e of arr.slice(0, 16)) keep.add(e.id);
  }
  const kept = before.elements.filter((e) => keep.has(e.id));

  // ---- the base: metadata, rules, clubs, and the fixture list ------------
  const baseFixtures = J('fixtures-before.json').map((f) => pick(f, [
    'id', 'code', 'event', 'kickoff_time', 'team_h', 'team_a',
    'team_h_difficulty', 'team_a_difficulty',
  ]));
  write('base.json', {
    note: 'Derived from the live FPL proxy on 2026-08-21. Sanitized: no real entry identity.',
    game_settings: before.game_settings,
    game_config: before.game_config,
    phases: before.phases,
    teams: before.teams,
    element_types: before.element_types,
    total_players: before.total_players,
    elements: kept.map((e) => pick(e, META)),
    fixtures: baseFixtures,
  });

  // ---- one delta per lifecycle state -------------------------------------
  const STATES = [
    ['preseason', 'bootstrap-before.json', 'fixtures-before.json'],
    ['rollover-cleared', 'bootstrap-rollover.json', 'fixtures-rollover.json'],
    ['match-in-play', 'bs-now.json', 'fx-now.json'],
    ['ft-provisional', 'bootstrap-ftprov.json', 'fixtures-ftprov.json'],
  ];

  const manifest = { source: 'live FPL proxy, 2026-08-21', entryId: ENTRY_ID, states: [] };

  for (const [name, bs, fx] of STATES) {
    if (!has(bs) || !has(fx)) { console.warn(`skip ${name}`); continue; }
    const b = J(bs);
    const byId = new Map(b.elements.map((e) => [e.id, e]));
    // Column-oriented, the same shape data/sample.js already uses for its own
    // element table: one field list and a row of values per player, rather than
    // repeating thirty-two key names six thousand times.
    const totals = { fields: ['id', ...TOTALS], rows: [] };
    for (const e of kept) {
      const live = byId.get(e.id);
      if (!live) continue;
      totals.rows.push([e.id, ...TOTALS.map((k) => (k in live ? live[k] : 0))]);
    }
    // Only the fixture flags move between states.
    const phases = {};
    for (const f of J(fx)) {
      if (f.started || f.finished || f.finished_provisional) {
        phases[f.id] = { s: !!f.started, f: !!f.finished, p: !!f.finished_provisional };
      }
    }
    write(`${name}.json`, { events: b.events, totals, fixturePhases: phases });
    const minutesAt = totals.fields.indexOf('minutes');
    const active = totals.rows.filter((r) => (r[minutesAt] || 0) > 0).length;
    manifest.states.push({ name, withMinutes: active, startedFixtures: Object.keys(phases).length });
    console.log(`${name}: ${active}/${kept.length} with minutes, ${Object.keys(phases).length} fixtures started`);
  }

  // ---- the squad, its live scores, and the manager anonymised ------------
  if (has('picks-ftprov.json')) {
    const picks = J('picks-ftprov.json');
    write('ft-provisional.picks.json', picks);
    console.log(`picks: ${picks.picks.length} players, official ${picks.entry_history.points} pts`);
  }
  if (has('live-gw1-ftprov.json')) {
    const live = J('live-gw1-ftprov.json');
    const squad = has('picks-ftprov.json')
      ? new Set(J('picks-ftprov.json').picks.map((p) => p.element))
      : new Set();
    const want = (id) => squad.has(id) || keep.has(id);
    write('ft-provisional.live.json', {
      elements: live.elements
        .filter((e) => want(e.id) && e.stats && (e.stats.minutes > 0 || squad.has(e.id)))
        .map((e) => ({ id: e.id, stats: e.stats })),
    });
  }
  if (has('entry-ftprov.json')) {
    const e = J('entry-ftprov.json');
    write('ft-provisional.entry.json', {
      ...e, id: ENTRY_ID, name: ENTRY_NAME,
      player_first_name: 'Test', player_last_name: 'Manager',
    });
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${OUT}`);
}

main();
