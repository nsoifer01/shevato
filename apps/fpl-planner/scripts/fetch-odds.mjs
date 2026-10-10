#!/usr/bin/env node
// Download football-data.co.uk Premier League odds for the OFFLINE odds
// experiment (experiments/configs/odds-blend.mjs) and verify them against the
// FPL archive.
//
//   node apps/fpl-planner/scripts/fetch-odds.mjs                 all seasons
//   node apps/fpl-planner/scripts/fetch-odds.mjs --season 2024-25 [--force]
//
// Writes apps/fpl-planner/.data/odds/<season>.csv (gitignored). Terms, column
// choice and the leakage argument are in scripts/lib/odds-football-data.mjs:
// private, offline research use only; the app never fetches odds.
//
// VERIFICATION, every run, cached file or not:
//   - every football-data team name maps to an FPL team name (throws if not);
//   - for a season with a downloaded archive (.data/<season>/merged_gw.csv),
//     every odds row matches exactly one archive fixture on clubs, London date
//     and score, and the mapped club set equals the archive's;
//   - for 2026-27 (no archive), the mapped names are checked against the
//     committed bootstrap fixture's clubs;
//   - how many fixtures' collection bound falls after their gameweek's FPL
//     deadline, which the replay's gate will withhold.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FOOTBALL_DATA_SEASONS, ODDS_DIR, footballDataUrl, oddsPath, parseFootballDataCsv, matchToDataset,
} from './lib/odds-football-data.mjs';
import { loadSeason } from './backtest.mjs';
import { seasonPath } from './fetch-history.mjs';
import { FPL_DEADLINE_LEAD_MINUTES } from '../js/engine/odds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_FIXTURE = path.join(HERE, '..', 'tests', 'fixtures', 'bootstrap.json');
const MIN_PLAUSIBLE_BYTES = 10_000;

function argValues(flag) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === flag && process.argv[i + 1]) out.push(...process.argv[i + 1].split(',')); });
  return out;
}

async function download(season, force) {
  const file = oddsPath(season);
  if (!force && fs.existsSync(file) && fs.statSync(file).size > MIN_PLAUSIBLE_BYTES) return { file, cached: true };
  const res = await fetch(footballDataUrl(season), { redirect: 'follow' });
  if (!res.ok) throw new Error(`odds: ${footballDataUrl(season)} returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('HomeTeam')) throw new Error(`odds: ${footballDataUrl(season)} did not return a football-data CSV`);
  fs.mkdirSync(ODDS_DIR, { recursive: true });
  fs.writeFileSync(file, text);
  return { file, cached: false };
}

function verifyAgainstArchive(season, parsed) {
  const dataset = loadSeason(season);
  const { stats } = matchToDataset(parsed, dataset);
  const archiveClubs = new Set([...dataset.teams.values()].map(t => t.name));
  const mappedClubs = new Set(parsed.flatMap(o => [o.home.name, o.away.name]));
  const missing = [...archiveClubs].filter(n => !mappedClubs.has(n));
  if (parsed.length === dataset.fixtures.length && missing.length) {
    throw new Error(`odds: ${season} clubs never mapped onto: ${missing.join(', ')}`);
  }
  // Collection bound against each gameweek's deadline, and kickoff agreement.
  const firstKickoff = new Map();
  for (const f of dataset.fixtures) {
    const t = Date.parse(f.kickoff);
    if (!firstKickoff.has(f.event) || t < firstKickoff.get(f.event)) firstKickoff.set(f.event, t);
  }
  const fixtureByPair = new Map(dataset.fixtures.map(f => [`${f.teamH}|${f.teamA}`, f]));
  const idByName = new Map([...dataset.teams.values()].map(t => [t.name, t.id]));
  let late = 0;
  let kickoffExact = 0;
  const lateGws = new Set();
  for (const o of parsed) {
    const f = fixtureByPair.get(`${idByName.get(o.home.name)}|${idByName.get(o.away.name)}`);
    if (Date.parse(f.kickoff) === o.kickoffMs) kickoffExact++;
    const deadline = firstKickoff.get(f.event) - FPL_DEADLINE_LEAD_MINUTES * 60_000;
    if (o.collectedByMs > deadline) { late++; lateGws.add(f.event); }
  }
  return { ...stats, kickoffExact, collectedAfterDeadline: late, gameweeksWithLateRows: [...lateGws].sort((a, b) => a - b) };
}

function verifyAgainstBootstrap(parsed) {
  const bootstrap = JSON.parse(fs.readFileSync(BOOTSTRAP_FIXTURE, 'utf8'));
  const names = new Set(bootstrap.teams.map(t => t.name));
  const unknown = [...new Set(parsed.flatMap(o => [o.home.name, o.away.name]))].filter(n => !names.has(n));
  if (unknown.length) throw new Error(`odds: mapped names not in the committed bootstrap: ${unknown.join(', ')}`);
  return { oddsRows: parsed.length, clubsVerifiedAgainst: 'tests/fixtures/bootstrap.json' };
}

async function main() {
  const seasons = argValues('--season');
  const list = seasons.length ? seasons : Object.keys(FOOTBALL_DATA_SEASONS);
  const force = process.argv.includes('--force');
  for (const season of list) {
    const { file, cached } = await download(season, force);
    const parsed = parseFootballDataCsv(fs.readFileSync(file, 'utf8'), season);
    const report = fs.existsSync(seasonPath(season))
      ? verifyAgainstArchive(season, parsed)
      : (season === '2026-27' ? verifyAgainstBootstrap(parsed) : { oddsRows: parsed.length, verified: false });
    console.log(`${season} ${cached ? 'cached' : 'downloaded'} ${path.relative(process.cwd(), file)} ${JSON.stringify(report)}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
