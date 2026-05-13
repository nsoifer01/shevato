#!/usr/bin/env node
'use strict';

// Enriches data.json's series with poster + overview from TMDB. Optional —
// the app works without it. Requires a free TMDB API read access token.
//
//   1. Sign up at https://www.themoviedb.org/signup
//   2. Get a v4 read access token at https://www.themoviedb.org/settings/api
//   3. Run: TMDB_TOKEN=eyJh... npm run enrich:rising-seasons
//
// Results are cached in data/tmdb-cache.json so re-runs only fetch new
// series. Re-run after each `npm run build:rising-seasons` if your dataset's
// list of unique series changed.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'tmdb-cache.json');
const TOKEN = process.env.TMDB_TOKEN || process.env.TMDB_BEARER_TOKEN;

// TMDB rate limit is generous (~50 req/sec) but we go gentle.
const REQUEST_INTERVAL_MS = 100;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tmdbFetch(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

async function findByImdbId(imdbId) {
  const url = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`;
  const body = await tmdbFetch(url);
  // `find` returns separate buckets; we want tv_results for series.
  const tv = body.tv_results && body.tv_results[0];
  if (!tv) return null;
  return {
    id: tv.id,
    poster_path: tv.poster_path || null,
    overview: tv.overview || null,
    original_language: tv.original_language || null,
    name: tv.name,
    via: 'imdb',
  };
}

// Fallback: TMDB's IMDb→TMDB cross-reference is volunteer-maintained and
// stale for older / anime / non-English shows (e.g. Dragon Ball Z's IMDb
// id `tt0214341` returns notFound even though TMDB has the show). Search
// by title and take the top result — TMDB's relevance ranking is solid
// for the kinds of shows this falls back to. Year filter intentionally
// not applied: our `year` comes from IMDb's startYear which routinely
// disagrees with TMDB's first_air_date_year by several years for shows
// with regional release windows.
async function searchByTitle(title) {
  if (!title) return null;
  const url = `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(title)}`;
  const body = await tmdbFetch(url);
  const tv = body.results && body.results[0];
  if (!tv) return null;
  return {
    id: tv.id,
    poster_path: tv.poster_path || null,
    overview: tv.overview || null,
    original_language: tv.original_language || null,
    name: tv.name,
    via: 'search',
    searchQuery: title,
  };
}

async function resolveSeries(imdbId, info) {
  const byId = await findByImdbId(imdbId);
  // Best case: IMDb match with a poster.
  if (byId && byId.poster_path) return byId;
  // Either no match, or match without a poster (e.g. an IMDb id pointing
  // to a fan-cut variant). Try a title search and prefer it if it brings
  // back a real poster. If neither has a poster, keep whichever we got.
  if (!info || !info.title) return byId || { notFound: true };
  await sleep(REQUEST_INTERVAL_MS);
  const bySearch = await searchByTitle(info.title);
  if (bySearch && bySearch.poster_path) return bySearch;
  return byId || bySearch || { notFound: true, triedTitle: info.title };
}

// External-ID lookup so we can link a series to TVDB (in addition to IMDb
// and TMDB) in the UI. The endpoint returns { imdb_id, tvdb_id, ... };
// we only persist tvdb_id since the others are already known or unused.
// Returns null on any failure so the caller can keep going.
async function fetchTvdbId(tmdbId) {
  try {
    const body = await tmdbFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`);
    const v = body && body.tvdb_id;
    return Number.isFinite(v) ? v : null;
  } catch (_) {
    return null;
  }
}

(async () => {
  if (!TOKEN) {
    console.error('Set TMDB_TOKEN env var (a v4 read access token from https://www.themoviedb.org/settings/api)');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing ${DATA_FILE}. Run \`npm run build:rising-seasons\` first.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const uniqueSeries = [...new Set(data.matches.map((m) => m.seriesId))];
  console.log(`${uniqueSeries.length.toLocaleString()} unique series to enrich`);

  // Map series id → { title, year } for the title-search fallback. Use the
  // earliest season's data (most likely the show's pilot season).
  const seriesInfo = {};
  for (const m of data.matches) {
    const cur = seriesInfo[m.seriesId];
    if (!cur || (m.year && (!cur.year || m.year < cur.year))) {
      seriesInfo[m.seriesId] = { title: m.title, year: m.year };
    }
  }

  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log(`Resuming from cache (${Object.keys(cache).length.toLocaleString()} entries)`);
  }

  // Retry anything posterless: notFound entries (no IMDb→TMDB link), and
  // also entries TMDB matched but where poster_path is null (often a
  // wrong-variant match like an IMDb id pointing to "Dragon Ball Recut"
  // instead of the canonical "Dragon Ball"). Title search frequently
  // lands on a better entry. Entries that already have a poster are
  // never re-fetched.
  const todo = uniqueSeries.filter((id) => {
    if (!(id in cache)) return true;
    const e = cache[id];
    if (!e) return true;
    if (e.notFound) return true;
    if (e.error) return true;
    if (!e.poster_path) return true; // matched but no poster — try harder
    // Back-fill: cache entries written before the language field was added
    // lack `original_language`. Force a refetch so the language filter has
    // data for every series, not just newly-added ones.
    if (!('original_language' in e)) return true;
    return false;
  });
  const retrying = todo.filter((id) => id in cache).length;
  console.log(`${todo.length.toLocaleString()} need fetching (${retrying.toLocaleString()} are retries of prior misses)`);

  let done = 0;
  let failed = 0;
  let recoveredViaSearch = 0;
  const t0 = Date.now();

  for (const imdbId of todo) {
    try {
      const result = await resolveSeries(imdbId, seriesInfo[imdbId]);
      const wasNotFound = cache[imdbId] && cache[imdbId].notFound;
      // Capture TVDB id while we already have the TMDB id in hand — saves
      // a second pass later. Costs one extra request per resolved series.
      if (result && result.id && !result.notFound) {
        await sleep(REQUEST_INTERVAL_MS);
        result.tvdbId = await fetchTvdbId(result.id);
      }
      cache[imdbId] = result;
      if (wasNotFound && result && !result.notFound) recoveredViaSearch++;
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

  // Back-fill tvdbId for cache entries that were resolved before the field
  // was added. One request per series; cheap incrementally and only runs
  // once per entry (subsequent runs skip anything with `tvdbId` set).
  const tvdbBackfill = uniqueSeries.filter((id) => {
    const e = cache[id];
    return e && e.id && !e.notFound && !e.error && !('tvdbId' in e);
  });
  if (tvdbBackfill.length > 0) {
    console.log(`\nBack-filling tvdbId for ${tvdbBackfill.length.toLocaleString()} cached entries`);
    let bdone = 0;
    const bt0 = Date.now();
    for (const imdbId of tvdbBackfill) {
      cache[imdbId].tvdbId = await fetchTvdbId(cache[imdbId].id);
      bdone++;
      if (bdone % 50 === 0) {
        const rate = (bdone / ((Date.now() - bt0) / 1000)).toFixed(1);
        const eta = ((tvdbBackfill.length - bdone) / parseFloat(rate)).toFixed(0);
        process.stdout.write(`  ${bdone}/${tvdbBackfill.length}  (${rate}/s, ~${eta}s left)\r`);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      }
      await sleep(REQUEST_INTERVAL_MS);
    }
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  // Tally cache health so it's obvious what the run accomplished.
  let withPoster = 0, noPoster = 0, notFoundFinal = 0, errored = 0, withTvdb = 0;
  for (const e of Object.values(cache)) {
    if (!e || e.error) { errored++; continue; }
    if (e.notFound) { notFoundFinal++; continue; }
    if (e.poster_path) withPoster++;
    else noPoster++;
    if (e.tvdbId) withTvdb++;
  }
  console.log(`\nWrote ${CACHE_FILE} — ${Object.keys(cache).length.toLocaleString()} entries`);
  console.log(`  with poster:    ${withPoster.toLocaleString()}`);
  console.log(`  no poster file: ${noPoster.toLocaleString()}`);
  console.log(`  with tvdbId:    ${withTvdb.toLocaleString()}`);
  console.log(`  notFound:       ${notFoundFinal.toLocaleString()}`);
  console.log(`  errored:        ${errored.toLocaleString()}`);
  if (recoveredViaSearch > 0) {
    console.log(`Recovered ${recoveredViaSearch.toLocaleString()} series via title-search fallback this run.`);
  }
  console.log('Re-run `npm run build:rising-seasons` to merge into data.json.');
})();
