#!/usr/bin/env node
'use strict';

// One-shot side-fetcher for per-season TMDB plot summaries. Reads
// tmdb-cache.json (read-only) to get the seriesId → tmdbId map, walks
// every (seriesId, season) pair in data.json, and writes results to a
// parallel file `data/season-overviews.json` so it doesn't race with
// `enrich-tmdb.js` writing to tmdb-cache.json.
//
// build-data.js loads this file and merges per-season overviews onto
// each match, falling back to the show-level overview when empty.
//
//   TMDB_TOKEN=… node scripts/fetch-season-overviews.js
//
// Tunables: TMDB_INTERVAL_MS (default 60), TMDB_FLUSH_EVERY (default 100).

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'tmdb-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'season-overviews.json');
const TOKEN = process.env.TMDB_TOKEN || process.env.TMDB_BEARER_TOKEN;
const INTERVAL_MS = parseInt(process.env.TMDB_INTERVAL_MS, 10) || 60;
const FLUSH_EVERY = parseInt(process.env.TMDB_FLUSH_EVERY, 10) || 100;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tmdbFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function fetchSeasonOverview(tmdbId, seasonNumber) {
  try {
    const body = await tmdbFetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}`,
    );
    return (body && typeof body.overview === 'string') ? body.overview.trim() : '';
  } catch (_) {
    return null; // null = "we asked and it errored"; '' = "fetched, empty"
  }
}

(async () => {
  if (!TOKEN) {
    console.error('Set TMDB_TOKEN env var');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_FILE) || !fs.existsSync(CACHE_FILE)) {
    console.error('Missing data.json or tmdb-cache.json — run build + enrich first.');
    process.exit(1);
  }

  // Snapshot-read tmdb-cache.json so we don't hold the file open while
  // enrich-tmdb.js writes to it. We only need the tmdbId per series.
  const cacheRaw = fs.readFileSync(CACHE_FILE, 'utf8');
  const cache = JSON.parse(cacheRaw);
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  // Resume from any existing side-file.
  let out = {};
  if (fs.existsSync(OUT_FILE)) {
    try { out = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); }
    catch { out = {}; }
  }

  // Build the work list: (seriesId, tmdbId, season) for pairs we haven't
  // already fetched. Skip series with no tmdbId mapping.
  const work = [];
  let skippedNoTmdb = 0;
  for (const m of data.matches) {
    const e = cache[m.seriesId];
    if (!e || !e.id || e.notFound || e.error) { skippedNoTmdb++; continue; }
    const ovMap = out[m.seriesId] || {};
    const key = String(m.season);
    if (key in ovMap) continue; // already attempted
    work.push({ seriesId: m.seriesId, tmdbId: e.id, season: m.season });
  }

  console.log(`${data.matches.length.toLocaleString()} total seasons in data.json`);
  console.log(`${skippedNoTmdb.toLocaleString()} skipped — series has no tmdbId in cache`);
  console.log(`${work.length.toLocaleString()} seasons to fetch this run`);
  if (work.length === 0) {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out));
    console.log('Nothing to do.');
    return;
  }

  function flush() {
    fs.writeFileSync(OUT_FILE + '.tmp', JSON.stringify(out));
    fs.renameSync(OUT_FILE + '.tmp', OUT_FILE);
  }

  const t0 = Date.now();
  let done = 0;
  for (const job of work) {
    const ov = await fetchSeasonOverview(job.tmdbId, job.season);
    if (!out[job.seriesId]) out[job.seriesId] = {};
    // Store '' for fetched-but-empty, null for fetched-but-errored —
    // both are sentinel values so we don't retry. Build-data.js only
    // promotes non-empty strings to m.seasonOverview.
    out[job.seriesId][String(job.season)] = ov;
    done++;
    if (done % FLUSH_EVERY === 0) {
      flush();
      const rate = done / ((Date.now() - t0) / 1000);
      const eta = ((work.length - done) / Math.max(rate, 0.1)).toFixed(0);
      process.stdout.write(`  ${done}/${work.length}  (${rate.toFixed(1)}/s, ~${eta}s left)\r`);
    }
    await sleep(INTERVAL_MS);
  }
  flush();

  let withOverview = 0, empty = 0, errored = 0;
  for (const m of Object.values(out)) {
    for (const v of Object.values(m)) {
      if (v === null) errored++;
      else if (typeof v === 'string' && v.length > 0) withOverview++;
      else empty++;
    }
  }
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`  seasons w/ overview:  ${withOverview.toLocaleString()}`);
  console.log(`  fetched but empty:    ${empty.toLocaleString()}`);
  console.log(`  errored:              ${errored.toLocaleString()}`);
  console.log('Re-run `npm run build:rising-shows` to merge into data.json.');
})();
