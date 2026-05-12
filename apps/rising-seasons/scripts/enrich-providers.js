#!/usr/bin/env node
'use strict';

// Adds US watch-provider info (Netflix / Max / Prime / Hulu / ...) to the
// TMDB cache. Separate from enrich-tmdb.js so it can run incrementally and
// only touches the `providers` field of each cache entry.
//
//   TMDB_TOKEN=... npm run enrich:rising-seasons:providers
//
// Reads/writes apps/rising-seasons/data/tmdb-cache.json. Requires that
// enrich-tmdb.js has already populated each entry with a tmdbId.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'tmdb-cache.json');
const REQUEST_INTERVAL_MS = 165;
const TOKEN = process.env.TMDB_TOKEN || process.env.TMDB_BEARER_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdbFetch(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
  });
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

// Pulls US streaming/ads providers. We deliberately ignore `rent` and `buy`
// because the UI's "where can I watch this" filter only makes sense for
// no-extra-cost access.
async function fetchProviders(tmdbId) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/watch/providers`;
  const body = await tmdbFetch(url);
  const us = body.results && body.results.US;
  if (!us) return [];
  const seen = new Set();
  const out = [];
  for (const bucket of ['flatrate', 'ads', 'free']) {
    if (!us[bucket]) continue;
    for (const p of us[bucket]) {
      if (seen.has(p.provider_name)) continue;
      seen.add(p.provider_name);
      out.push({ name: p.provider_name, logo: p.logo_path || null });
    }
  }
  return out;
}

(async () => {
  if (!TOKEN) {
    console.error('Set TMDB_TOKEN env var (a v4 read access token from https://www.themoviedb.org/settings/api)');
    process.exit(1);
  }
  if (!fs.existsSync(CACHE_FILE)) {
    console.error(`Missing ${CACHE_FILE} — run enrich-tmdb.js first.`);
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  // Only fetch providers for entries that have a tmdbId and don't yet
  // carry a `providers` field. Already-fetched entries are skipped even
  // when their `providers` list is empty (no US streaming) — we don't want
  // to refetch on every run for shows that genuinely aren't streamed.
  const todo = [];
  for (const [imdbId, entry] of Object.entries(cache)) {
    if (!entry || entry.notFound || entry.error) continue;
    if (!entry.id) continue;
    if ('providers' in entry) continue;
    todo.push(imdbId);
  }
  console.log(`${todo.length.toLocaleString()} entries need provider data`);
  if (todo.length === 0) return;

  let done = 0;
  let errored = 0;
  const t0 = Date.now();
  for (const imdbId of todo) {
    const entry = cache[imdbId];
    try {
      entry.providers = await fetchProviders(entry.id);
    } catch (err) {
      entry.providersError = err.message;
      errored++;
    }
    done++;
    if (done % 50 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1);
      const eta = ((todo.length - done) / parseFloat(rate)).toFixed(0);
      process.stdout.write(`  ${done}/${todo.length}  (${rate}/s, ~${eta}s left)\r`);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    }
    await sleep(REQUEST_INTERVAL_MS);
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  let withProviders = 0, withoutProviders = 0;
  for (const e of Object.values(cache)) {
    if (!e || !('providers' in e)) continue;
    if (e.providers && e.providers.length) withProviders++;
    else withoutProviders++;
  }
  console.log(`\nWrote ${CACHE_FILE}`);
  console.log(`  with providers: ${withProviders.toLocaleString()}`);
  console.log(`  no US providers: ${withoutProviders.toLocaleString()}`);
  console.log(`  errored: ${errored.toLocaleString()}`);
  console.log('Re-run `npm run build:rising-seasons` to merge into data.json.');
})();
