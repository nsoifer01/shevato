// football-data.co.uk Premier League odds, for the OFFLINE odds experiment only.
//
// SOURCE AND TERMS (verified 2026-10-09)
//
//   https://www.football-data.co.uk/mmz4281/<YYZZ>/E0.csv, one file a season,
//   updated at least twice a week. The data page states, verbatim: "What's
//   more, it's all FREE , however its use is intended for private individuals
//   only, NOT commerical or data training products using automated
//   bots/scrapers/AI." This module and scripts/fetch-odds.mjs therefore serve a
//   private, offline research replay only: five files downloaded once by hand,
//   never fetched by the app, never redistributed, never committed (.data/ is
//   gitignored). A runtime feed on the public site would be a different
//   question and is not what this is.
//
// WHICH COLUMNS, AND WHY (the leakage argument)
//
// Every file carries two sets of prices. notes.txt: "These are for pre-closing
// odds. For the closing odds, as below but with an additional "C" character".
// Closing prices are taken at kickoff, which is AFTER the FPL deadline (the
// first kickoff of the gameweek minus 90 minutes) for every fixture, so reading
// any `...C...` column in a replay is a leak and this module never does.
//
// Pre-closing prices: notes.txt says "Betting odds for weekend games are
// collected Friday afternoons, and on Tuesday afternoons for midweek games",
// and matches.php is more precise: "collected for the downloadable weekend
// fixtures on Fridays afternoons generally not later than 17:00 British
// Standard Time. Odds for midweek fixtures are collected Tuesdays not later
// than 13:00 British Standard Time." No row carries its own collection
// timestamp, so each row's `fetchedAt` is the LATEST moment the schedule allows
// (collectedBy below), and the replay's gate (odds.js fixtureOddsAtDeadline)
// withholds any row whose bound is after the deadline. The residual risk is
// the word "generally": a collection that ran late on an irregular week
// (holiday rounds, a Friday lunchtime kickoff, a rescheduled midweek match)
// is not detectable from the file.
//
// Market average (Avg*) is preferred over any single book. Pinnacle is NOT
// used: the data page says "Since 23/07/2025 Pinnacle's public API for odds
// delivery has become unreliable meaning their odds are systematically out of
// date relative to odds for other bookmakers, including both the pre-closing
// and closing odds", and 2026-27 files carry no Pinnacle columns at all. Bet365
// is the fallback when an average is missing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../../js/engine/backtest.js';
import { normalizeFixtureOdds, deriveFromOdds } from '../../js/engine/odds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ODDS_DIR = path.join(HERE, '..', '..', '.data', 'odds');

export const FOOTBALL_DATA_SEASONS = Object.freeze({
  '2022-23': '2223',
  '2023-24': '2324',
  '2024-25': '2425',
  '2025-26': '2526',
  '2026-27': '2627',
});

export function footballDataUrl(season) {
  const code = FOOTBALL_DATA_SEASONS[season];
  if (!code) throw new Error(`odds: no football-data season code for ${season}`);
  return `https://www.football-data.co.uk/mmz4281/${code}/E0.csv`;
}

export function oddsPath(season) {
  return path.join(ODDS_DIR, `${season}.csv`);
}

// ---------------------------------------------------------------------------
// Team names
//
// football-data name -> FPL team `name` (the field bootstrap-static and the
// archive's merged_gw.csv `team` column carry) and FPL `short_name`. Most clubs
// are spelled identically; the exceptions are Man United, Tottenham and
// Sheffield United, plus FPL renaming three promoted clubs to their long names
// in 2026-27 (the committed bootstrap fixture) while the archive's 2024-25
// file calls Ipswich "Ipswich". Matching is by `name` because that is the key
// the archive can verify; `short` is reported for readability. An unmapped
// name throws: a silent wrong match corrupts a projection invisibly.
// ---------------------------------------------------------------------------

const BASE_TEAMS = Object.freeze({
  'Arsenal': { name: 'Arsenal', short: 'ARS' },
  'Aston Villa': { name: 'Aston Villa', short: 'AVL' },
  'Bournemouth': { name: 'Bournemouth', short: 'BOU' },
  'Brentford': { name: 'Brentford', short: 'BRE' },
  'Brighton': { name: 'Brighton', short: 'BHA' },
  'Burnley': { name: 'Burnley', short: 'BUR' },
  'Chelsea': { name: 'Chelsea', short: 'CHE' },
  'Coventry': { name: 'Coventry', short: 'COV' },
  'Crystal Palace': { name: 'Crystal Palace', short: 'CRY' },
  'Everton': { name: 'Everton', short: 'EVE' },
  'Fulham': { name: 'Fulham', short: 'FUL' },
  'Hull': { name: 'Hull', short: 'HUL' },
  'Ipswich': { name: 'Ipswich', short: 'IPS' },
  'Leeds': { name: 'Leeds', short: 'LEE' },
  'Leicester': { name: 'Leicester', short: 'LEI' },
  'Liverpool': { name: 'Liverpool', short: 'LIV' },
  'Luton': { name: 'Luton', short: 'LUT' },
  'Man City': { name: 'Man City', short: 'MCI' },
  'Man United': { name: 'Man Utd', short: 'MUN' },
  'Newcastle': { name: 'Newcastle', short: 'NEW' },
  "Nott'm Forest": { name: "Nott'm Forest", short: 'NFO' },
  'Sheffield United': { name: 'Sheffield Utd', short: 'SHU' },
  'Southampton': { name: 'Southampton', short: 'SOU' },
  'Sunderland': { name: 'Sunderland', short: 'SUN' },
  'Tottenham': { name: 'Spurs', short: 'TOT' },
  'West Ham': { name: 'West Ham', short: 'WHU' },
  'Wolves': { name: 'Wolves', short: 'WOL' },
});

const SEASON_TEAM_OVERRIDES = Object.freeze({
  '2026-27': {
    'Coventry': { name: 'Coventry City', short: 'COV' },
    'Hull': { name: 'Hull City', short: 'HUL' },
    'Ipswich': { name: 'Ipswich Town', short: 'IPS' },
  },
});

export function fplTeamFor(footballDataName, season) {
  const override = SEASON_TEAM_OVERRIDES[season] && SEASON_TEAM_OVERRIDES[season][footballDataName];
  const team = override || BASE_TEAMS[footballDataName];
  if (!team) {
    throw new Error(`odds: football-data team "${footballDataName}" (${season}) has no FPL mapping; add it to BASE_TEAMS`);
  }
  return team;
}

// ---------------------------------------------------------------------------
// UK local time
// ---------------------------------------------------------------------------

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

function londonParts(ms) {
  const o = {};
  for (const p of LONDON.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute };
}

/** UTC ms of a wall-clock time in London (BST/GMT aware). */
export function londonToUtcMs(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = londonParts(guess);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess += wall - seen;
  }
  return guess;
}

/** The London calendar date of an instant, as YYYY-MM-DD. */
export function londonDate(ms) {
  const p = londonParts(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// The latest moment football-data's schedule allows a fixture's pre-closing
// prices to have been collected. Friday to Monday fixtures are "weekend"
// fixtures (Friday 17:00 on or before the match day); Tuesday to Thursday are
// "midweek" (Tuesday 13:00 of that week). A fixture that kicks off before its
// own collection slot (a Friday lunchtime match) gets the slot anyway, which
// lands after the deadline and so is withheld rather than trusted.
export function collectedBy(y, m, d) {
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const back = { 5: 0, 6: 1, 0: 2, 1: 3, 2: 0, 3: 1, 4: 2 }[weekday];
  const midweek = weekday >= 2 && weekday <= 4;
  const day = new Date(Date.UTC(y, m - 1, d - back));
  return londonToUtcMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), midweek ? 13 : 17, 0);
}

function parseFootballDataDate(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text || '');
  if (!m) throw new Error(`odds: unreadable football-data date "${text}"`);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return { y, m: Number(m[2]), d: Number(m[1]) };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const price = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 1 ? n : null;
};

// Pre-closing prices only. Never a column with the closing "C".
const MARKETS = [
  { book: 'Avg', h: 'AvgH', d: 'AvgD', a: 'AvgA', over: 'Avg>2.5', under: 'Avg<2.5' },
  { book: 'B365', h: 'B365H', d: 'B365D', a: 'B365A', over: 'B365>2.5', under: 'B365<2.5' },
];

export function parseFootballDataCsv(text, season) {
  const { header, rows } = parseCsv(text.replace(/^﻿/, ''));
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (const col of ['Div', 'Date', 'Time', 'HomeTeam', 'AwayTeam']) {
    if (idx[col] === undefined) throw new Error(`odds: ${season} file has no ${col} column`);
  }
  const get = (r, col) => (idx[col] === undefined ? '' : (r[idx[col]] || '').trim());
  const out = [];
  for (const r of rows) {
    if (get(r, 'Div') !== 'E0') continue;
    const date = parseFootballDataDate(get(r, 'Date'));
    const [hh, mm] = (get(r, 'Time') || '15:00').split(':').map(Number);
    let h2h = null;
    let totals = [];
    let book = null;
    for (const mk of MARKETS) {
      const H = price(get(r, mk.h));
      const D = price(get(r, mk.d));
      const A = price(get(r, mk.a));
      if (!H || !D || !A) continue;
      h2h = { home: H, draw: D, away: A };
      book = mk.book;
      const over = price(get(r, mk.over));
      const under = price(get(r, mk.under));
      totals = over && under ? [{ line: 2.5, over, under }] : [];
      break;
    }
    const fthg = get(r, 'FTHG');
    const ftag = get(r, 'FTAG');
    out.push({
      date: `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`,
      kickoffMs: londonToUtcMs(date.y, date.m, date.d, hh, mm),
      collectedByMs: collectedBy(date.y, date.m, date.d),
      homeName: get(r, 'HomeTeam'),
      awayName: get(r, 'AwayTeam'),
      home: fplTeamFor(get(r, 'HomeTeam'), season),
      away: fplTeamFor(get(r, 'AwayTeam'), season),
      goalsHome: fthg === '' ? null : Number(fthg),
      goalsAway: ftag === '' ? null : Number(ftag),
      book,
      h2h,
      totals,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching to the archive's fixtures
// ---------------------------------------------------------------------------

/**
 * Derived market rows keyed by the archive's fixture id. Every odds row must
 * map onto exactly one archive fixture with the same home and away club, on
 * the same London calendar date, with the same score; any disagreement throws.
 */
export function matchToDataset(parsed, dataset) {
  const idByName = new Map([...dataset.teams.values()].map(t => [t.name, t.id]));
  const byPair = new Map(dataset.fixtures.map(f => [`${f.teamH}|${f.teamA}`, f]));
  const rows = new Map();
  const stats = { oddsRows: parsed.length, matched: 0, noPrices: 0, noTotals: 0, datasetFixtures: dataset.fixtures.length, books: {} };
  const names = new Set([...idByName.keys()]);
  for (const o of parsed) {
    for (const t of [o.home, o.away]) {
      if (!idByName.has(t.name)) {
        throw new Error(`odds: mapped team "${t.name}" is not a club in the ${dataset.season} archive (${[...names].sort().join(', ')})`);
      }
    }
    const homeId = idByName.get(o.home.name);
    const awayId = idByName.get(o.away.name);
    const f = byPair.get(`${homeId}|${awayId}`);
    if (!f) throw new Error(`odds: no ${dataset.season} archive fixture ${o.homeName} v ${o.awayName}`);
    if (f.kickoff && londonDate(Date.parse(f.kickoff)) !== o.date) {
      throw new Error(`odds: ${o.homeName} v ${o.awayName} is dated ${o.date} by football-data and ${f.kickoff} by the archive`);
    }
    if (o.goalsHome !== null && f.teamHScore !== null && (o.goalsHome !== f.teamHScore || o.goalsAway !== f.teamAScore)) {
      throw new Error(`odds: ${o.homeName} v ${o.awayName} scored ${o.goalsHome}-${o.goalsAway} by football-data and ${f.teamHScore}-${f.teamAScore} by the archive`);
    }
    stats.matched++;
    if (!o.h2h) { stats.noPrices++; continue; }
    if (!o.totals.length) stats.noTotals++;
    stats.books[o.book] = (stats.books[o.book] || 0) + 1;
    const normalized = normalizeFixtureOdds({
      source: `football-data:${o.book}`,
      fetchedAt: new Date(o.collectedByMs).toISOString(),
      fixtureId: f.id,
      homeTeamId: homeId,
      awayTeamId: awayId,
      commenceTime: new Date(o.kickoffMs).toISOString(),
      h2h: o.h2h,
      totals: o.totals,
    });
    rows.set(f.id, { ...deriveFromOdds(normalized), fixtureId: f.id, pHomeMarket: normalized.pHome, pDrawMarket: normalized.pDraw, pAwayMarket: normalized.pAway });
  }
  return { rows, stats };
}

// ---------------------------------------------------------------------------
// The replay's loader
// ---------------------------------------------------------------------------

const replayCache = new Map();

/**
 * Derived odds rows for a replayed season, from .data/odds/<season>.csv. Throws
 * when the file is missing: an arm that asked for odds and silently ran
 * without them would report a clean null.
 */
export function loadReplayOdds(dataset, season = dataset.season) {
  if (replayCache.has(season)) return replayCache.get(season);
  const file = oddsPath(season);
  if (!fs.existsSync(file)) {
    throw new Error(`odds: ${file} is missing. Run: node apps/fpl-planner/scripts/fetch-odds.mjs --season ${season}`);
  }
  const parsed = parseFootballDataCsv(fs.readFileSync(file, 'utf8'), season);
  const { rows } = matchToDataset(parsed, dataset);
  replayCache.set(season, rows);
  return rows;
}
