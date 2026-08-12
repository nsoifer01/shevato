#!/usr/bin/env node
// Download historical per-gameweek FPL data for model training.
//
// Source: the vaastav/Fantasy-Premier-League archive, which mirrors the
// official API's per-gameweek player rows season by season. One CSV per season
// (`merged_gw.csv`), a few megabytes each.
//
// The download directory is GITIGNORED and must stay that way. Training data
// does not belong in this repository: it is large, it is reproducible from a
// URL, and committed datasets have bloated this repo before.
//
// Usage:
//   node apps/fpl-planner/scripts/fetch-history.mjs
//   node apps/fpl-planner/scripts/fetch-history.mjs 2023-24 2024-25
//   node apps/fpl-planner/scripts/fetch-history.mjs --force
//
// Exits non-zero with instructions if a season cannot be downloaded. The
// training pipeline refuses to run on a partial download rather than quietly
// training on less data than it reports.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(HERE, '..', '.data');

const BASE_URL = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';

// WHY THESE FOUR SEASONS, AND WHY 2022-23 IS THE FLOOR
//
// The archive goes back to 2016-17 and every one of those seasons downloads
// fine, so this list is a decision, not a limit. It is short on purpose.
//
// 2022-23 is a HARD floor. The columns `expected_goals`, `expected_assists`,
// `expected_goals_conceded` and `starts` do not exist in merged_gw.csv before
// it (33 columns in 2019-20, 36 in 2020-21 and 2021-22, 41 from 2022-23). Those
// four columns are the primary inputs to both the points model and the minutes
// model. Adding 2021-22 or earlier would not add information, it would add rows
// whose most important features are missing, and a missing column parses to the
// number 0, which the model would read as "this player generated no expected
// goals" rather than "nobody measured expected goals that year". Older seasons
// are excluded deliberately, not forgotten. loadSeasonRows() in train-model.mjs
// enforces this by refusing to load a season whose header lacks a column the
// feature builder reads, so adding '2021-22' here fails loudly rather than
// quietly poisoning the training set.
//
// 2025-26 is the most recent completed season, it is the season whose totals
// bootstrap-static currently serves (so it is what live projections are built
// from), and it is the only season ever played under defensive-contribution
// scoring. It is the held-out test block for exactly that reason.
const DEFAULT_SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];

const MIN_PLAUSIBLE_BYTES = 100_000;

export function seasonPath(season) {
  return path.join(DATA_DIR, season, 'merged_gw.csv');
}

export function seasonUrl(season) {
  return `${BASE_URL}/${season}/gws/merged_gw.csv`;
}

// THE IDENTITY TABLE, AND WHY IT IS A SEPARATE FILE
//
// merged_gw.csv identifies a player by `element`, which FPL REASSIGNS every
// season. Measured on the four seasons here, an element id shared by two
// consecutive seasons is the same footballer 0.0% to 0.13% of the time, so any
// join across a season boundary keyed on it matches different players and
// returns noise. merged_gw.csv carries no permanent id: its identity columns are
// `element`, `name`, `team` and `position` in every season, checked against the
// real headers rather than a list.
//
// players_raw.csv, from the same archive and the same season directory, carries
// `id` (equal to merged_gw's `element`) alongside `code`, which IS permanent.
// It is small (a few hundred rows), so downloading it costs almost nothing and
// buys an exact cross-season join. js/engine/player-identity.js consumes it.
export function identityPath(season) {
  return path.join(DATA_DIR, season, 'players_raw.csv');
}

export function identityUrl(season) {
  return `${BASE_URL}/${season}/players_raw.csv`;
}

async function exists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.size > MIN_PLAUSIBLE_BYTES;
  } catch {
    return false;
  }
}

export async function fetchSeason(season, { force = false } = {}) {
  const target = seasonPath(season);
  if (!force && (await exists(target))) {
    const stat = await fs.stat(target);
    return { season, file: target, bytes: stat.size, cached: true };
  }

  const url = seasonUrl(season);
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'shevato-fpl-planner/1.0' } });
  } catch (err) {
    throw new Error(
      `Could not reach ${url}\n${err.message}\n\n`
      + 'Check your network connection, then re-run:\n'
      + '  node apps/fpl-planner/scripts/fetch-history.mjs',
    );
  }
  if (!res.ok) {
    throw new Error(
      `Download failed for season ${season}: HTTP ${res.status} from ${url}\n\n`
      + 'That season may not exist in the archive yet. Pick seasons explicitly:\n'
      + '  node apps/fpl-planner/scripts/fetch-history.mjs 2023-24 2024-25',
    );
  }

  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < MIN_PLAUSIBLE_BYTES) {
    throw new Error(
      `Download for season ${season} was only ${body.length} bytes, which is not a season of data.\n`
      + `Inspect ${url} by hand before re-running.`,
    );
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return { season, file: target, bytes: body.length, cached: false };
}

// A few hundred rows rather than a few megabytes, so it has its own much lower
// plausibility floor.
const MIN_PLAUSIBLE_IDENTITY_BYTES = 10_000;

export async function fetchIdentity(season, { force = false } = {}) {
  const target = identityPath(season);
  if (!force) {
    try {
      const stat = await fs.stat(target);
      if (stat.size > MIN_PLAUSIBLE_IDENTITY_BYTES) {
        return { season, file: target, bytes: stat.size, cached: true };
      }
    } catch {
      // Not downloaded yet.
    }
  }

  const url = identityUrl(season);
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'shevato-fpl-planner/1.0' } });
  } catch (err) {
    throw new Error(
      `Could not reach ${url}\n${err.message}\n\n`
      + 'Check your network connection, then re-run:\n'
      + '  node apps/fpl-planner/scripts/fetch-history.mjs',
    );
  }
  if (!res.ok) {
    throw new Error(
      `Identity download failed for season ${season}: HTTP ${res.status} from ${url}\n\n`
      + 'Without players_raw.csv there is no permanent `code` for this season, and a cross-season\n'
      + 'join would have to fall back to matching names.',
    );
  }

  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < MIN_PLAUSIBLE_IDENTITY_BYTES) {
    throw new Error(
      `The identity table for ${season} was only ${body.length} bytes, which is not a squad list.\n`
      + `Inspect ${url} by hand before re-running.`,
    );
  }
  if (!/(^|,)code(,|\r?\n)/.test(body.toString('utf8').split('\n', 1)[0])) {
    throw new Error(
      `The identity table for ${season} has no \`code\` column, which is the only reason it is downloaded.\n`
      + `Inspect ${url} by hand before re-running.`,
    );
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return { season, file: target, bytes: body.length, cached: false };
}

export async function ensureSeasons(seasons) {
  const missing = [];
  for (const season of seasons) {
    if (!(await exists(seasonPath(season)))) missing.push(season);
  }
  if (missing.length) {
    throw new Error(
      `Missing historical data for: ${missing.join(', ')}\n\n`
      + 'Download it first:\n'
      + `  node apps/fpl-planner/scripts/fetch-history.mjs ${missing.join(' ')}\n\n`
      + `Files are written to ${DATA_DIR} which is gitignored on purpose.`,
    );
  }
  return seasons.map(season => seasonPath(season));
}

async function main(argv) {
  const force = argv.includes('--force');
  const seasons = argv.filter(a => !a.startsWith('--'));
  const wanted = seasons.length ? seasons : DEFAULT_SEASONS;

  console.log(`Downloading ${wanted.length} season(s) into ${DATA_DIR}`);
  let total = 0;
  for (const season of wanted) {
    const r = await fetchSeason(season, { force });
    const identity = await fetchIdentity(season, { force });
    total += r.bytes + identity.bytes;
    console.log(
      `  ${r.season}  ${(r.bytes / 1024 / 1024).toFixed(1)} MB${r.cached ? '  (cached)' : ''}`
      + `  + identity table ${(identity.bytes / 1024).toFixed(0)} kB${identity.cached ? '  (cached)' : ''}`,
    );
  }
  console.log(`Done. ${(total / 1024 / 1024).toFixed(1)} MB total.`);
  console.log('Next: node apps/fpl-planner/scripts/train-model.mjs');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
