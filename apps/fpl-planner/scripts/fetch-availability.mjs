#!/usr/bin/env node
// Download historical Premier League availability (injuries and doubts) for the
// replayed seasons.
//
// WHY THIS EXISTS
//
// The FPL per-gameweek archive that fetch-history.mjs downloads has no
// availability columns at all. It records what a player DID (minutes, starts,
// points) and never what was KNOWN about him beforehand, so a replay built from
// it believes every player in the league is fit every week. The live app knows
// far more than that: bootstrap-static publishes `status` and
// `chance_of_playing_next_round`, and minutes.js leans on both. Without a
// historical equivalent, no availability improvement can be measured.
//
// Source: API-Football v3 (api-sports.io), league 39 (Premier League). Its
// coverage table reports `injuries: true` for seasons 2021 to 2025, which spans
// every season this project replays.
//
// SEASON NUMBERING. API-Football names a season by the calendar year it starts
// in, so FPL's 2022-23 is season 2022, 2023-24 is 2023 and 2024-25 is 2024.
//
// REQUEST BUDGET. The key on file is a free plan: 100 requests per day. The
// injuries endpoint returns a whole season in ONE response (roughly 3,900
// records for 2023, `paging {current: 1, total: 1}`), so a full backfill costs
// THREE requests. This script refuses to spend more than that, and it never
// re-downloads a season that is already on disk unless --force says so.
//
// THE KEY. It is read from the environment and never printed, never written to
// a file and never committed. It lives in Netlify project settings:
//
//   export APIFOOTBALL_KEY="$(netlify env:get APIFOOTBALL_KEY)"
//   node apps/fpl-planner/scripts/fetch-availability.mjs
//
// The download directory is GITIGNORED and must stay that way, for the same
// reasons as the training data: reproducible from a URL, not source.
//
// Usage:
//   node apps/fpl-planner/scripts/fetch-availability.mjs
//   node apps/fpl-planner/scripts/fetch-availability.mjs 2023
//   node apps/fpl-planner/scripts/fetch-availability.mjs --force
//   node apps/fpl-planner/scripts/fetch-availability.mjs --report

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DATA_DIR } from './fetch-history.mjs';

const API_BASE = 'https://v3.football.api-sports.io';
const PREMIER_LEAGUE = 39;

export const AVAILABILITY_DIR = path.join(DATA_DIR, 'availability');

// FPL season label to API-Football season number, for the three replayed
// seasons. 2025-26 is absent on purpose: the replay harness holds it as the
// live-shaped season and no backtest runs it.
export const SEASON_NUMBERS = Object.freeze({
  '2022-23': 2022,
  '2023-24': 2023,
  '2024-25': 2024,
});

const DEFAULT_SEASONS = [2022, 2023, 2024];

// Three seasons, one request each. A higher number here would be a decision to
// spend more of a 100-per-day budget, so it is a constant rather than a flag.
const MAX_REQUESTS = 3;

export function availabilityPath(season) {
  return path.join(AVAILABILITY_DIR, `${apiSeason(season)}.json`);
}

export function apiSeason(season) {
  if (typeof season === 'number') return season;
  if (SEASON_NUMBERS[season]) return SEASON_NUMBERS[season];
  const n = Number(season);
  if (Number.isInteger(n) && n >= 2010 && n <= 2100) return n;
  throw new Error(`Unknown season "${season}". Known: ${Object.keys(SEASON_NUMBERS).join(', ')} or a year such as 2023.`);
}

function requireKey() {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) {
    throw new Error(
      'APIFOOTBALL_KEY is not set.\n\n'
      + 'The key lives in the Netlify project settings, not in this repository. Load it into\n'
      + 'the environment for this shell only:\n\n'
      + '  export APIFOOTBALL_KEY="$(netlify env:get APIFOOTBALL_KEY)"\n'
      + '  node apps/fpl-planner/scripts/fetch-availability.mjs\n\n'
      + 'Do not paste the key into a file. Nothing in this repository may contain it.',
    );
  }
  return key;
}

async function exists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.size > 0;
  } catch {
    return false;
  }
}

// One season of injury and doubt records, trimmed to the fields the join and
// the leakage rule need. `fixture.date` is the KICKOFF the record was attached
// to, which is after the gameweek deadline: availability.js in the replay is
// what turns that into a pre-deadline signal, and it must stay that way.
export function normalizeResponse(season, response) {
  const records = [];
  for (const row of response) {
    const player = row.player || {};
    const fixture = row.fixture || {};
    const team = row.team || {};
    if (!player.name || !fixture.date) continue;
    records.push({
      playerName: player.name,
      playerId: player.id ?? null,
      type: player.type || '',
      reason: player.reason || '',
      teamName: team.name || '',
      teamId: team.id ?? null,
      fixtureId: fixture.id ?? null,
      fixtureDate: fixture.date,
    });
  }
  records.sort((a, b) => (
    a.fixtureDate < b.fixtureDate ? -1
      : a.fixtureDate > b.fixtureDate ? 1
        : a.playerName < b.playerName ? -1 : a.playerName > b.playerName ? 1 : 0
  ));
  return {
    source: 'api-football-v3',
    league: PREMIER_LEAGUE,
    season: apiSeason(season),
    fetchedAt: new Date().toISOString(),
    count: records.length,
    records,
  };
}

export async function fetchSeason(season, { force = false } = {}) {
  const year = apiSeason(season);
  const target = availabilityPath(year);
  if (!force && (await exists(target))) {
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    return { season: year, file: target, count: parsed.count, cached: true };
  }

  const key = requireKey();
  const url = `${API_BASE}/injuries?league=${PREMIER_LEAGUE}&season=${year}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'x-apisports-key': key, accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Could not reach ${url}\n${err.message}\n\nCheck your network connection and re-run.`);
  }
  if (!res.ok) {
    throw new Error(
      `Availability download failed for season ${year}: HTTP ${res.status}\n\n`
      + 'A 401 or 403 means the key is wrong or expired; a 429 means the daily budget is spent.\n'
      + 'Re-read it with: export APIFOOTBALL_KEY="$(netlify env:get APIFOOTBALL_KEY)"',
    );
  }

  const body = await res.json();
  // API-Football answers 200 with a populated `errors` object for a bad key or
  // an exhausted quota, so a status check alone would write an empty season.
  const errors = body.errors;
  const errorText = Array.isArray(errors) ? errors.join('; ') : Object.values(errors || {}).join('; ');
  if (errorText) {
    throw new Error(`API-Football refused the request for season ${year}: ${errorText}`);
  }
  const paging = body.paging || { current: 1, total: 1 };
  if ((paging.total || 1) > 1) {
    throw new Error(
      `Season ${year} came back paginated (${paging.total} pages), which this script does not spend budget on.\n`
      + 'Fetching it fully would cost more than the three requests budgeted here.',
    );
  }
  if (!Array.isArray(body.response) || body.response.length === 0) {
    throw new Error(`Season ${year} returned no injury records at all, which is not a season of data.`);
  }

  const parsed = normalizeResponse(year, body.response);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`);
  return { season: year, file: target, count: parsed.count, cached: false };
}

export async function loadAvailability(season) {
  const file = availabilityPath(season);
  if (!(await exists(file))) return null;
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Join report. The API gives a player NAME and a club NAME; the FPL archive
// gives an element id and its own spelling. That join is the single largest
// source of error in this dataset, so it gets measured rather than assumed.
// ---------------------------------------------------------------------------

async function report(seasons) {
  const { buildDataset, joinAvailability } = await import('../js/engine/backtest.js');

  for (const label of seasons) {
    const csv = path.join(DATA_DIR, label, 'merged_gw.csv');
    if (!(await exists(csv))) {
      console.log(`${label}: no archive at ${csv}, run fetch-history.mjs first`);
      continue;
    }
    const data = await loadAvailability(label);
    if (!data) {
      console.log(`${label}: no availability file, run this script without --report first`);
      continue;
    }
    const dataset = buildDataset({ csv: await fs.readFile(csv, 'utf8'), season: label });
    const joined = joinAvailability(dataset, data.records);

    const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0');
    console.log(`\n${label} (API season ${data.season})`);
    console.log(`  records            ${data.count}`);
    console.log(`  matched records    ${joined.stats.matchedRecords}  (${pct(joined.stats.matchedRecords, data.count)}%)`);
    console.log(`  distinct names     ${joined.stats.names}`);
    console.log(`  matched names      ${joined.stats.matchedNames}  (${pct(joined.stats.matchedNames, joined.stats.names)}%)`);
    const m = joined.stats.byMethod;
    console.log(`  by rung            exact ${m.exact}, initials ${m.initials}, tokens ${m.tokens}, surname ${m.surname}, token ${m.token}`);
    console.log(`  ambiguous (left unmatched)     ${joined.stats.ambiguous}`);
    console.log(`  players with a signal          ${joined.byPlayer.size}`);
    console.log('  unmatched sample:');
    for (const u of joined.stats.unmatchedSample) {
      console.log(`    ${u.name.padEnd(28)} ${u.team.padEnd(18)} ${u.records} record(s)`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const force = argv.includes('--force');
  const wantReport = argv.includes('--report');
  const args = argv.filter(a => !a.startsWith('--'));

  if (wantReport) {
    const labels = args.length ? args : Object.keys(SEASON_NUMBERS);
    await report(labels);
    return;
  }

  const seasons = (args.length ? args : DEFAULT_SEASONS).map(apiSeason);
  const toFetch = [];
  for (const season of seasons) {
    if (force || !(await exists(availabilityPath(season)))) toFetch.push(season);
  }
  if (toFetch.length > MAX_REQUESTS) {
    throw new Error(
      `Refusing to spend ${toFetch.length} requests. The free plan allows 100 per day and this script budgets ${MAX_REQUESTS}.\n`
      + 'Fetch fewer seasons per run: node apps/fpl-planner/scripts/fetch-availability.mjs 2023',
    );
  }

  console.log(`Availability for ${seasons.length} season(s) into ${AVAILABILITY_DIR}`);
  console.log(`Requests to spend: ${toFetch.length} of a ${MAX_REQUESTS} budget (100 per day on the free plan)`);
  for (const season of seasons) {
    const r = await fetchSeason(season, { force });
    console.log(`  ${r.season}  ${r.count} records${r.cached ? '  (cached)' : ''}`);
  }
  console.log('\nNext: node apps/fpl-planner/scripts/fetch-availability.mjs --report');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
