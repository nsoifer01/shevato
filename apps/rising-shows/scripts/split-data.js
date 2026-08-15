#!/usr/bin/env node
'use strict';
/**
 * Splits data.json into what the browser actually needs up front, and what it
 * only needs once a modal opens.
 *
 * WHY
 * ---
 * The Finder grid fetched the whole of data.json before it could paint a
 * single card. Measured against the real file, two fields dominate it:
 *
 *   episodes   31.3 MB   40.4%   per-episode ratings/votes arrays
 *   overview   18.2 MB   23.5%   per-season plot summaries
 *
 * That is 64% of the payload, and neither is read by the grid, the filters or
 * the sort. Both are modal-only. Stripping them takes the file the browser
 * blocks on from 77.6 MB raw / ~12 MB brotli down to 28.1 MB raw / ~3.5 MB
 * brotli, which on a typical 10 Mbps mobile connection is the difference
 * between roughly 9.6s and 2.8s before anything appears on screen.
 *
 * WHAT IT WRITES
 * --------------
 *   data-index.json          slim, fetched on load. Same shape as data.json
 *                            minus episodes/overview, plus an aboveImdb map
 *                            (see below).
 *   data/detail/<id>.json    per series: { cast?, seasons: { "<n>": { episodes,
 *                            overview, ov?, eps? } } }, fetched when a modal
 *                            opens.
 *
 * When data/show-modal-extras.json is present (fetch-data.js downloads it
 * right before this runs in build:site), each series' slice of it - cast,
 * per-season plot overview (`ov`), per-episode IMDb ids / runtimes / titles
 * (`eps`) - is merged into that series' detail file, and the index gets
 * `extrasInDetail: true`. The app then never fetches the 67 MB extras
 * monolith at all: one small per-show detail file carries everything a modal
 * needs. Without the extras file the detail files keep their original shape,
 * the flag stays off, and the app falls back to fetching the monolith on
 * first modal open (never at boot).
 *
 * data.json itself is deliberately NOT modified. build-show-pages.js renders
 * per-episode tables and curves into the static SEO pages and needs the full
 * file, and leaving it untouched keeps this script idempotent: re-running it
 * never degrades its own input. show-modal-extras.json is likewise only read.
 *
 * ABOVE-IMDB
 * ----------
 * buildAboveImdbMap() in app.js was the only load-time reader of `episodes`
 * that was not dead or modal-only. It sums every episode rating per series to
 * decide whether a show's episodes average above its IMDb score. That answer
 * is identical every time for a given dataset, so it is computed here once and
 * shipped as a plain map, rather than recomputed in every visitor's browser
 * over 31 MB of arrays.
 *
 * Run order matters: this must come AFTER build-show-pages.js in build:site.
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const SRC = path.join(APP_DIR, 'data.json');
const EXTRAS_SRC = path.join(APP_DIR, 'data', 'show-modal-extras.json');
const INDEX_OUT = path.join(APP_DIR, 'data-index.json');
const DETAIL_DIR = path.join(APP_DIR, 'data', 'detail');

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[split-data] data.json not found; run fetch-data.js first');
    process.exit(1);
  }

  const started = Date.now();
  const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const matches = raw.matches || [];

  // Modal extras, optional. Present on every deploy (fetch-data.js downloads
  // it first in build:site); may be absent on a local tree that only built
  // data.json. Merged per series into the detail files below so a modal open
  // costs one small fetch instead of the whole side-file.
  let extras = null;
  if (fs.existsSync(EXTRAS_SRC)) {
    extras = JSON.parse(fs.readFileSync(EXTRAS_SRC, 'utf8'));
  }

  // --- per-series detail + above-IMDb, in one pass over the matches ---
  const detail = new Map();          // seriesId -> { seasons: {} }
  const imdbAcc = new Map();         // seriesId -> { sum, count, seriesRating }

  for (const m of matches) {
    let d = detail.get(m.seriesId);
    if (!d) {
      d = { seasons: {} };
      // Cast is series-level in the extras file; carry it once per detail file.
      const ex = extras && extras[m.seriesId];
      if (ex && ex.cast) d.cast = ex.cast;
      detail.set(m.seriesId, d);
    }
    const season = {};
    if (Array.isArray(m.episodes)) season.episodes = m.episodes;
    if (m.overview) season.overview = m.overview;
    // Season-level extras: `ov` (season plot overview) and `eps` (per-episode
    // IMDb id / runtime / title map), same keys the monolith uses so app.js
    // consumes either source through one code path.
    const exSeason = extras && extras[m.seriesId] && extras[m.seriesId].seasons
      && extras[m.seriesId].seasons[String(m.season)];
    if (exSeason) {
      if (exSeason.ov) season.ov = exSeason.ov;
      if (exSeason.eps) season.eps = exSeason.eps;
    }
    d.seasons[String(m.season)] = season;

    if (typeof m.seriesRating === 'number' && Array.isArray(m.episodes)) {
      let acc = imdbAcc.get(m.seriesId);
      if (!acc) { acc = { sum: 0, count: 0, seriesRating: m.seriesRating }; imdbAcc.set(m.seriesId, acc); }
      // Rated episodes only, like the ratedCount/ratingSum fold below and
      // buildShowAgg: one unrated episode used to make the sum NaN, which
      // silently dropped the series from aboveImdb (NaN > x is false).
      for (const e of m.episodes) {
        if (typeof e.rating === 'number') { acc.sum += e.rating; acc.count++; }
      }
    }
  }

  // Only the true entries are shipped. The map is consulted with a plain
  // lookup, so absent means false and we halve the size for nothing lost.
  const aboveImdb = [];
  for (const [seriesId, acc] of imdbAcc) {
    if (acc.count === 0) continue;
    if ((acc.sum / acc.count) > acc.seriesRating) aboveImdb.push(seriesId);
  }

  // How many seasons each series has, so single-season shows can be given the
  // one piece of episode data the GRID genuinely needs (see epRatings below).
  const seasonCount = new Map();
  for (const m of matches) seasonCount.set(m.seriesId, (seasonCount.get(m.seriesId) || 0) + 1);

  // --- slim index ---
  const slim = { ...raw };
  slim.matches = matches.map((m) => {
    const { episodes, overview, ...rest } = m;
    const eps = Array.isArray(episodes) ? episodes : [];

    // Episode COUNT is still needed by the grid (the minEpisodes filter, the
    // card stats), and used to come from the array length.
    rest.episodeCount = eps.length;

    // buildShowAgg sums every episode rating to derive avgEpisode and the gap.
    // Those two numbers are the same for everyone, so they are folded down
    // here instead of being recomputed in each visitor's browser. ratingSum is
    // rounded to 2dp: it is only ever divided by ratedCount and re-rounded to
    // 2dp downstream, so full float precision buys nothing and costs bytes.
    let ratedCount = 0;
    let ratingSum = 0;
    for (const e of eps) {
      if (typeof e.rating === 'number') { ratedCount++; ratingSum += e.rating; }
    }
    rest.ratedCount = ratedCount;
    rest.ratingSum = Math.round(ratingSum * 100) / 100;

    // The ONE episode-level thing the grid still needs. A single-season show
    // has no cross-season trajectory, so its card sparkline is drawn from its
    // episode ratings instead (drawFinderSpark via showAgg.episodeSeries).
    // Multi-season shows draw from season averages and need none of this.
    // Ratings only: the sparkline reads nothing else, and carrying votes,
    // names or episode numbers here would undo the point of the split.
    if (seasonCount.get(m.seriesId) === 1 && eps.length) {
      rest.epRatings = eps.filter((e) => typeof e.rating === 'number').map((e) => e.rating);
    }
    return rest;
  });
  slim.aboveImdb = aboveImdb;
  // Tells the app the detail files already carry the modal extras, so it must
  // never fetch the show-modal-extras.json monolith. Omitted (not false) when
  // the extras file was absent, keeping the no-extras output byte-identical
  // to the pre-merge format.
  if (extras) slim.extrasInDetail = true;
  slim.splitAt = new Date().toISOString();

  fs.writeFileSync(INDEX_OUT, JSON.stringify(slim));

  // --- detail files ---
  fs.rmSync(DETAIL_DIR, { recursive: true, force: true });
  fs.mkdirSync(DETAIL_DIR, { recursive: true });
  let written = 0;
  for (const [seriesId, d] of detail) {
    // seriesId is an IMDb tt-id, so it is already filename-safe. Guard anyway
    // rather than trust it: a stray separator would escape the directory.
    if (!/^[A-Za-z0-9_-]+$/.test(seriesId)) continue;
    fs.writeFileSync(path.join(DETAIL_DIR, `${seriesId}.json`), JSON.stringify(d));
    written++;
  }

  const mb = (n) => (n / 1048576).toFixed(1);
  const srcSize = fs.statSync(SRC).size;
  const outSize = fs.statSync(INDEX_OUT).size;
  console.log(
    `[split-data] data-index.json ${mb(outSize)} MB (from ${mb(srcSize)} MB, `
    + `${(100 - (outSize / srcSize) * 100).toFixed(0)}% smaller) + ${written} detail files `
    + `(${extras ? 'modal extras merged in' : 'no extras file, plain split'}), `
    + `${aboveImdb.length} above-IMDb series, in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

if (require.main === module) main();

module.exports = { main };
