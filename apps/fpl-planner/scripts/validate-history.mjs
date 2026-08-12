#!/usr/bin/env node
// Check the downloaded archive against facts about football and about FPL,
// before anything is measured on it.
//
// WHY THIS EXISTS. Two defects found on 2026-08-12 had been in every number this
// project ever published, and both were data problems that every unit test
// passed straight over:
//
//   - the 2022-23 archive has no `starts` column before gameweek 16, which the
//     minutes model read as a league where nobody starts
//   - the 2025-26 archive HAS defensive-contribution columns, which the replay
//     was hardcoding to zero because they did not exist when it was written
//
// Neither is detectable by comparing the system to itself. Both are obvious the
// moment the data is compared to something OUTSIDE it: a club fields eleven
// players, a season contains 11 x 2 x 380 starts, and a row's points are its own
// components under the scoring table. That is what this does.
//
// It is deliberately not a unit test. The archive is gitignored and machine
// local, so a test that needed it would either be skipped in CI or make CI
// depend on a download. Run it after `fetch-history.mjs`, and whenever a season
// rolls over.
//
// Usage:
//   node apps/fpl-planner/scripts/validate-history.mjs
//   node apps/fpl-planner/scripts/validate-history.mjs --season 2025-26
//
// Exits non-zero if any season FAILS. A WARN is a fact worth knowing that is not
// necessarily wrong (a season in progress has fewer fixtures than a full one).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseMergedGw, reconstructStarts } from '../js/engine/backtest.js';
import { defConComposite } from '../js/engine/projections.js';
import { loadRules, KNOWN_SEASONS } from './backtest.mjs';
import { seasonPath } from './fetch-history.mjs';

// A full Premier League season: 20 clubs, 38 rounds, 10 fixtures a round, and
// eleven starters for each of the two sides in every one of them.
const CLUBS = 20;
const ROUNDS = 38;
const FIXTURES = (CLUBS / 2) * ROUNDS;
const STARTERS_PER_SIDE = 11;
const EXPECTED_STARTS = STARTERS_PER_SIDE * 2 * FIXTURES;

// Columns whose absence changes what the engine can model, rather than merely
// making a feature weaker.
const LOAD_BEARING_COLUMNS = [
  'minutes', 'starts', 'total_points', 'value', 'selected', 'bonus', 'bps',
  'goals_scored', 'assists', 'clean_sheets', 'goals_conceded', 'saves',
  'expected_goals', 'expected_assists', 'expected_goals_conceded',
];

// Columns that arrived with a rule change. Their absence is a fact about the
// season, not a defect, but the replay has to know which case it is in.
const ERA_COLUMNS = ['clearances_blocks_interceptions', 'recoveries', 'tackles', 'defensive_contribution'];

function headerOf(csv) {
  const line = csv.slice(0, csv.indexOf('\n'));
  return line.split(',').map(s => s.trim());
}

// Points rebuilt from a row's own components. This is the independent path: it
// reads the rules object and the raw columns, and never goes through
// projections.js or anything that produced the number it is checking.
function rebuildPoints(row, rules) {
  const S = rules.scoring;
  const val = (key) => {
    const v = S[key];
    if (v === undefined || v === null) return 0;
    return typeof v === 'number' ? v : (typeof v[row.position] === 'number' ? v[row.position] : 0);
  };

  let p = 0;
  if (row.minutes > 0) p += row.minutes >= 60 ? (val('long_play') || 2) : (val('short_play') || 1);
  p += row.goalsScored * val('goals_scored');
  p += row.assists * val('assists');
  if (row.minutes >= 60) p += row.cleanSheets * val('clean_sheets');
  p += Math.floor(row.saves / (rules.savesPerPoint || 3)) * val('saves');
  p += row.penaltiesSaved * val('penalties_saved');
  p += row.penaltiesMissed * val('penalties_missed');
  if (row.position === 1 || row.position === 2) {
    p += Math.floor(row.goalsConceded / (rules.concededPerPenalty || 2)) * val('goals_conceded');
  }
  p += row.yellowCards * val('yellow_cards');
  p += row.redCards * val('red_cards');
  p += row.ownGoals * val('own_goals');
  p += row.bonus;

  const threshold = rules.defConThresholds[row.position];
  if (threshold && defConComposite(row) >= threshold) p += val('defensive_contribution');
  return p;
}

export function validateSeason(season, { rules }) {
  const file = seasonPath(season);
  if (!fs.existsSync(file)) return { season, skipped: `not downloaded (${file})` };

  const csv = fs.readFileSync(file, 'utf8');
  const header = headerOf(csv);
  const rows = parseMergedGw(csv);
  const played = rows.filter(r => r.minutes > 0);
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });

  // --- schema -------------------------------------------------------------
  const missing = LOAD_BEARING_COLUMNS.filter(c => !header.includes(c));
  if (missing.length) add('FAIL', 'schema', `missing load-bearing columns: ${missing.join(', ')}`);
  else add('OK', 'schema', `all ${LOAD_BEARING_COLUMNS.length} load-bearing columns present`);

  const era = ERA_COLUMNS.filter(c => header.includes(c));
  add('INFO', 'era columns', era.length ? `carries ${era.join(', ')}` : 'no defensive-contribution columns (predates the rule)');

  // --- coverage -----------------------------------------------------------
  const gws = [...new Set(rows.map(r => r.gw))].sort((a, b) => a - b);
  const fixtures = new Set(rows.map(r => r.fixtureId));
  const gaps = [];
  for (let gw = 1; gw <= Math.max(...gws); gw++) if (!gws.includes(gw)) gaps.push(gw);
  add(fixtures.size === FIXTURES ? 'OK' : 'WARN', 'coverage',
    `${gws.length} gameweeks, ${fixtures.size} fixtures of ${FIXTURES}`
    + (gaps.length ? `, no rows for gameweek ${gaps.join(', ')}` : ''));

  // --- starts -------------------------------------------------------------
  //
  // The arithmetic of football: two elevens start every fixture. A season that
  // reports fewer has a column that is missing rather than a league that fielded
  // fewer players.
  const startsSum = rows.reduce((s, r) => s + r.starts, 0);
  const expected = STARTERS_PER_SIDE * 2 * fixtures.size;
  const shortfall = expected - startsSum;
  if (Math.abs(shortfall) <= fixtures.size * 0.01) {
    add('OK', 'starts', `${startsSum} starts against ${expected} expected`);
  } else {
    const probe = rows.map(r => ({ ...r }));
    const fixed = reconstructStarts(probe);
    add('WARN', 'starts',
      `${startsSum} against ${expected} expected, short by ${shortfall}. `
      + (fixed.gameweeks.length
        ? `Gameweeks ${fixed.gameweeks.join(', ')} carry no starts at all and are reconstructed at load.`
        : 'The shortfall is NOT a whole missing gameweek, so reconstruction will not fix it.'));
  }

  // --- points reconstruct from their own components -----------------------
  let exact = 0;
  const diffs = new Map();
  for (const r of played) {
    const d = rebuildPoints(r, rules) - r.totalPoints;
    if (d === 0) exact++;
    else diffs.set(d, (diffs.get(d) || 0) + 1);
  }
  const rate = played.length ? exact / played.length : 1;
  const worst = [...diffs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([d, n]) => `${d > 0 ? '+' : ''}${d} on ${n}`).join(', ');
  add(rate >= 0.999 ? 'OK' : 'FAIL', 'points',
    `${(100 * rate).toFixed(2)}% of played rows rebuild exactly from the scoring table`
    + (worst ? ` (commonest gaps ${worst})` : ''));

  // --- duplicates ---------------------------------------------------------
  //
  // A player with two rows in one gameweek is a DOUBLE GAMEWEEK when the fixture
  // ids differ, and a duplicated record when they do not. Never deduplicate on
  // the first without checking the second.
  const seen = new Set();
  let doubles = 0;
  let dupes = 0;
  for (const r of rows) {
    const key = `${r.gw}|${r.playerId}|${r.fixtureId}`;
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }
  const perGw = new Map();
  for (const r of rows) {
    const key = `${r.gw}|${r.playerId}`;
    perGw.set(key, (perGw.get(key) || 0) + 1);
  }
  for (const n of perGw.values()) if (n > 1) doubles++;
  add(dupes === 0 ? 'OK' : 'WARN', 'duplicates',
    `${doubles} player-gameweeks with more than one fixture (double gameweeks), ${dupes} byte-duplicate rows`);

  // --- identity -----------------------------------------------------------
  const idFile = seasonPath(season).replace('merged_gw.csv', 'players_raw.csv');
  add(fs.existsSync(idFile) ? 'OK' : 'WARN', 'identity',
    fs.existsSync(idFile)
      ? 'players_raw.csv present, so cross-season joins can key on `code`'
      : 'players_raw.csv MISSING: a cross-season join would fall back to name matching');

  return { season, rows: rows.length, played: played.length, checks };
}

function main(argv) {
  const only = argv.includes('--season') ? argv[argv.indexOf('--season') + 1] : null;
  const seasons = only ? [only] : [...KNOWN_SEASONS, '2025-26'];
  const rules = loadRules();
  let failed = 0;

  for (const season of seasons) {
    const result = validateSeason(season, { rules });
    if (result.skipped) {
      console.log(`\n${season}  SKIPPED: ${result.skipped}`);
      continue;
    }
    console.log(`\n${season}  ${result.rows} rows, ${result.played} with minutes`);
    for (const c of result.checks) {
      if (c.level === 'FAIL') failed++;
      console.log(`  ${c.level.padEnd(5)} ${c.name.padEnd(14)} ${c.detail}`);
    }
  }

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) FAILED. Do not measure anything on this archive until they are explained.`);
    process.exit(1);
  }
  console.log('No failures. WARN lines are facts about the data, not defects: read them before trusting a replay.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
