#!/usr/bin/env node
'use strict';

// Enriches data.json's series with poster + overview from TMDB. Optional —
// the app works without it. Requires a free TMDB API read access token.
//
//   1. Sign up at https://www.themoviedb.org/signup
//   2. Get a v4 read access token at https://www.themoviedb.org/settings/api
//   3. Run: TMDB_TOKEN=eyJh... npm run enrich:imdb-rising
//
// Results are cached in data/tmdb-cache.json so re-runs only fetch new
// series. Re-run after each `npm run build:imdb-rising` if your dataset's
// list of unique series changed.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'tmdb-cache.json');
const TOKEN = process.env.TMDB_TOKEN || process.env.TMDB_BEARER_TOKEN;

// TMDB rate limit is generous (~50 req/sec) but we go gentle.
const REQUEST_INTERVAL_MS = 100;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function findByImdbId(imdbId) {
  const url = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} for ${imdbId}: ${await res.text()}`);
  }
  const body = await res.json();
  // `find` returns separate buckets; we want tv_results for series.
  const tv = body.tv_results && body.tv_results[0];
  if (!tv) return { notFound: true };
  return {
    id: tv.id,
    poster_path: tv.poster_path || null,
    overview: tv.overview || null,
    name: tv.name,
  };
}

(async () => {
  if (!TOKEN) {
    console.error('Set TMDB_TOKEN env var (a v4 read access token from https://www.themoviedb.org/settings/api)');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing ${DATA_FILE}. Run \`npm run build:imdb-rising\` first.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const uniqueSeries = [...new Set(data.matches.map((m) => m.seriesId))];
  console.log(`${uniqueSeries.length.toLocaleString()} unique series to enrich`);

  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log(`Resuming from cache (${Object.keys(cache).length.toLocaleString()} entries)`);
  }

  const todo = uniqueSeries.filter((id) => !(id in cache));
  console.log(`${todo.length.toLocaleString()} need fetching`);

  let done = 0;
  let failed = 0;
  const t0 = Date.now();

  for (const imdbId of todo) {
    try {
      cache[imdbId] = await findByImdbId(imdbId);
    } catch (err) {
      cache[imdbId] = { error: err.message };
      failed++;
    }
    done++;
    if (done % 50 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1);
      const eta = ((todo.length - done) / parseFloat(rate)).toFixed(0);
      process.stdout.write(`  ${done}/${todo.length}  (${rate}/s, ~${eta}s left)\r`);
      // Periodic checkpoint so a crash doesn't lose progress.
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`\nWrote ${CACHE_FILE} — ${Object.keys(cache).length.toLocaleString()} entries (${failed.toLocaleString()} errors)`);
  console.log('Re-run `npm run build:imdb-rising` to merge into data.json.');
})();
