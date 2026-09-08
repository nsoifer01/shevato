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
 *   shows-index.json         THE BOOT PAYLOAD. One record per show, already
 *                            folded (see buildShowsIndex). This is the only
 *                            data file the Finder fetches on load.
 *   data-index.json          slim SEASON-level file. Same shape as data.json
 *                            minus episodes/overview, plus an aboveImdb map
 *                            (see below). No longer fetched at boot; kept
 *                            because it is the published dataset artifact and
 *                            the input this script's own outputs are checked
 *                            against.
 *   data/kometa-index.json   the eight season fields the Kometa collection
 *                            builder page needs, and nothing else.
 *   data/detail/<id>.json    per series: { cast?, records: [ <season record>,
 *                            ... ], seasons: { "<n>": { episodes, overview,
 *                            ov?, eps? } } }, fetched when a modal opens.
 *                            `records` is what the browser used to hold for
 *                            all 34,692 shows at once.
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
const Finder = require('./finder-lib.js');
const Match = require('./match.js');
const Providers = require('./providers-lib.js');

const APP_DIR = path.join(__dirname, '..');

// Every path main() touches, derived from an app directory.
//
// main() takes that directory as an argument (defaulting to this script's own
// app) so a test can run the REAL build against a temp tree in-process. It used
// to resolve everything from __dirname, so the only way to exercise it was to
// copy the whole scripts/ directory somewhere and spawn a child - which works,
// and which no coverage run can see: main() was 190 uncovered lines of the
// thing that actually produces the deploy artifacts.
function paths(appDir) {
  return {
    SRC: path.join(appDir, 'data.json'),
    EXTRAS_SRC: path.join(appDir, 'data', 'show-modal-extras.json'),
    INDEX_OUT: path.join(appDir, 'data-index.json'),
    SHOWS_OUT: path.join(appDir, 'shows-index.json'),
    KOMETA_OUT: path.join(appDir, 'data', 'kometa-index.json'),
    DETAIL_DIR: path.join(appDir, 'data', 'detail'),
  };
}

/**
 * The BOOT payload: one record per SHOW, not one per season.
 *
 * WHY THIS EXISTS (2026-09-05 audit F08, finished 2026-09-08)
 * ----------------------------------------------------------
 * data-index.json is a SEASON-level file: 66,648 records for 34,692 shows, so
 * every series-level field (title, poster, genres, providers, the IMDb series
 * rating and vote count, the external ids) is repeated once per season. The
 * Finder does not render seasons. It renders SHOWS, and it got them by folding
 * the whole season file down in the browser - `buildShowAgg` over 66k records
 * at boot, on the main thread, before a single card could paint, on top of
 * parsing 33 MB of JSON to feed it.
 *
 * The fold is deterministic: the same input produces the same shows for every
 * visitor, every time. So it happens HERE, once per deploy, and the browser
 * downloads its result. The season records it folded are still needed - by the
 * season modal, by Compare, by the share cards - but only ever for ONE show at
 * a time, which is exactly the granularity data/detail/<seriesId>.json already
 * has. They move there (see `records` below) and arrive with the modal that
 * wants them.
 *
 * The two compact encodings are the ones that paid:
 *   - `epRatings` (flat ratings) instead of buildShowAgg's `episodeSeries`
 *     ({episode, rating, votes} objects). Only the ratings are ever drawn;
 *     the objects cost 9.3 MB raw to carry two fields nothing reads.
 *   - flags (`aboveImdb`, `adult`) emitted only when true.
 * Short keys were measured and REJECTED: `t`/`y`/`p` instead of
 * `title`/`year`/`poster` saved 0.06 MB brotli and 1 ms of parse, which does
 * not buy an unreadable build artifact.
 */
function buildShowsIndex(slimMatches, aboveImdb) {
  const shows = Finder.buildShowAgg(slimMatches, Match.detectShapes);

  // The handful of show-level facts the browser used to derive by scanning
  // every season record at boot. Each is folded here in one pass.
  const above = new Set(aboveImdb);
  const acc = new Map();
  const epCount = new Map();
  for (const m of slimMatches) {
    if (Number.isFinite(m.episodeCount)) {
      epCount.set(m.seriesId + '\u0000' + m.season, m.episodeCount);
    }
    let e = acc.get(m.seriesId);
    if (!e) {
      e = { voteSum: 0, seasons: 0, provider: null, adult: false, best: null, worst: null };
      acc.set(m.seriesId, e);
    }
    e.voteSum += (m.minVotes || 0);
    e.seasons++;
    // First mainstream streaming service, for the single provider chip on the
    // card. Providers ride on season records; the chip is per show.
    if (e.provider === null) {
      const first = Providers.normalizeProviders(m.providers)[0];
      if (first) e.provider = first;
    }
    if (Array.isArray(m.genres) && m.genres.includes('Adult')) e.adult = true;
    // Best/worst season badges. Deliberately the SAME comparison the browser's
    // buildBestSeasonMap ran, including its treatment of a season with no
    // avgRating (a `>` against undefined is false, so such a season never wins
    // and never loses), rather than a tidier one derived from seasonAvgs: the
    // badge has to land on the same season it always did.
    if (e.best === null) {
      e.best = { season: m.season, avg: m.avgRating };
      e.worst = { season: m.season, avg: m.avgRating };
    } else {
      if (m.avgRating > e.best.avg) e.best = { season: m.season, avg: m.avgRating };
      if (m.avgRating < e.worst.avg) e.worst = { season: m.season, avg: m.avgRating };
    }
  }

  return shows.map((s) => {
    const e = acc.get(s.seriesId);
    const o = {
      seriesId: s.seriesId,
      title: s.title,
      year: s.year,
      language: s.language,
      poster: s.poster,
      genres: s.genres,
      showRating: s.showRating,
      votes: s.votes,
      episodes: s.episodes,
      avgEpisode: s.avgEpisode,
      gap: s.gap,
      runtimeHrs: s.runtimeHrs,
      seasonsCount: s.seasonsCount,
      // {season, year, avg, episodeCount}. The first three are what the card
      // sparkline plots. `episodeCount` is there for one reason: when a show's
      // detail file cannot be fetched, the modal still has to state the true
      // number of episodes per season rather than "0 eps" for a season it can
      // count (2026-08-22 audit D7). It costs ~0.15 MB encoded and is the only
      // season-level number kept in the boot payload.
      seasonAvgs: s.seasonAvgs.map((a) => {
        const n = epCount.get(s.seriesId + '\u0000' + a.season);
        return n == null ? a : { ...a, episodeCount: n };
      }),
      shapes: s.shapes,
      // Mean of the seasons' own vote floors. computeShowRelated bands
      // candidates against it, and it was the last thing that needed a scan
      // over another show's season records.
      //
      // NOT rounded. The band test is `xv < anchor / 10 || xv > anchor * 10`,
      // so a half-vote of rounding flips membership for any candidate sitting
      // on an edge - measured at 19% of the catalogue against the exact mean,
      // and it moved real recommendations. A double round-trips through JSON
      // exactly, so the exact quotient is what ships.
      meanSeasonVotes: e && e.seasons ? e.voteSum / e.seasons : 0,
    };
    // Card sparkline for single-season shows: ratings only, in episode order.
    if (s.episodeSeries) o.epRatings = s.episodeSeries.map((x) => x.rating);
    if (e && e.provider) o.provider = e.provider;
    if (above.has(s.seriesId)) o.aboveImdb = true;
    if (e && e.adult) o.adult = true;
    // Only a show with a genuine contest gets the badges - two seasons, and a
    // best that is not also the worst. Same gate as buildBestSeasonMap.
    if (e && e.seasons >= 2 && e.best && e.worst) {
      o.bestSeason = e.best.season;
      if (e.best.season !== e.worst.season) o.worstSeason = e.worst.season;
    }
    return o;
  });
}

/**
 * The Kometa collection builder (apps/rising-shows/kometa/) is the one browser
 * surface that genuinely wants SEASON-level shape data: it counts qualifying
 * seasons per shape at a confidence floor the user moves. It used to read
 * data-index.json - the same 5.9 MB the Finder fetched, which was defensible
 * only while the Finder fetched it too and warmed the cache. Once the Finder
 * stopped, that page would have been left paying the whole season file alone,
 * for eight fields out of twenty-seven.
 */
function buildKometaIndex(slimMatches) {
  return slimMatches.map((m) => {
    const o = { seriesId: m.seriesId, title: m.title, season: m.season };
    if (m.shapes) o.shapes = m.shapes;
    if (m.confidence) o.confidence = m.confidence;
    if (m.tmdbId != null) o.tmdbId = m.tmdbId;
    if (m.tvdbId != null) o.tvdbId = m.tvdbId;
    if (m.seasonTvdbId != null) o.seasonTvdbId = m.seasonTvdbId;
    return o;
  });
}

function main(appDir = APP_DIR) {
  const { SRC, EXTRAS_SRC, INDEX_OUT, SHOWS_OUT, KOMETA_OUT, DETAIL_DIR } = paths(appDir);
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

  // The season records the browser no longer boots with. Each show's own
  // records ride in that show's detail file, which is the file the modal,
  // Compare and the share cards already fetch - so the data arrives with the
  // feature that wants it and never before. Stored as the EXACT slim record,
  // not a subset: a season record has 27 fields read across the modal, the
  // season table, the share text and the Kometa export, and shipping "the
  // ones we think are needed" is how a field goes missing on one surface.
  for (const m of slim.matches) {
    const d = detail.get(m.seriesId);
    if (!d) continue;
    if (!d.records) d.records = [];
    d.records.push(m);
  }
  for (const d of detail.values()) {
    if (d.records) d.records.sort((a, b) => a.season - b.season);
  }
  // Tells the app the detail files already carry the modal extras, so it must
  // never fetch the show-modal-extras.json monolith. Omitted (not false) when
  // the extras file was absent, keeping the no-extras output byte-identical
  // to the pre-merge format.
  if (extras) slim.extrasInDetail = true;
  slim.splitAt = new Date().toISOString();

  fs.writeFileSync(INDEX_OUT, JSON.stringify(slim));

  // --- boot index (shows) + the Kometa builder's season slice ---
  const shows = buildShowsIndex(slim.matches, aboveImdb);
  const showsIndex = {
    builtAt: raw.builtAt,
    // Same dataset fingerprint data-index.json carries, so either artifact can
    // be compared against the other or against a release without parsing 16 MB
    // of records to find out whether anything changed.
    contentHash: raw.contentHash,
    minEpisodes: raw.minEpisodes,
    minVotes: raw.minVotes,
    // `count` in data.json / data-index.json is the number of SEASON records,
    // which would be a quiet lie in a show-level file. Both numbers, named.
    showCount: shows.length,
    seasonCount: slim.matches.length,
    shapeCounts: raw.shapeCounts,
    genres: raw.genres,
    languages: raw.languages,
    providers: raw.providers,
    splitAt: slim.splitAt,
    shows,
  };
  if (extras) showsIndex.extrasInDetail = true;
  fs.writeFileSync(SHOWS_OUT, JSON.stringify(showsIndex));

  const kometaIndex = {
    builtAt: raw.builtAt,
    splitAt: slim.splitAt,
    matches: buildKometaIndex(slim.matches),
  };
  fs.mkdirSync(path.dirname(KOMETA_OUT), { recursive: true });
  fs.writeFileSync(KOMETA_OUT, JSON.stringify(kometaIndex));

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
  const showsSize = fs.statSync(SHOWS_OUT).size;
  const kometaSize = fs.statSync(KOMETA_OUT).size;
  console.log(
    `[split-data] shows-index.json ${mb(showsSize)} MB (${shows.length} shows, the boot payload) `
    + `+ data-index.json ${mb(outSize)} MB (${slim.matches.length} seasons, from ${mb(srcSize)} MB) `
    + `+ data/kometa-index.json ${mb(kometaSize)} MB + ${written} detail files `
    + `(${extras ? 'modal extras merged in' : 'no extras file, plain split'}), `
    + `${aboveImdb.length} above-IMDb series, in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

// `--help` (and any unknown argument) prints usage and exits BEFORE touching
// anything. This script takes no options, but it used to run its full job on
// any argument: `split-data.js --help` rewrote data-index.json and 34k detail
// files (2026-08-22 audit, D6).
const USAGE = `Usage: node split-data.js

Splits ../data.json into ../shows-index.json (the browser's boot payload),\n../data-index.json, ../data/kometa-index.json and ../data/detail/<seriesId>.json.
Merges ../data/show-modal-extras.json into the detail files when present.
Takes no options. Run via \`npm run build:rising-shows:split\`.
`;

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.length) {
    process.stderr.write(`Unknown argument: ${args[0]}\n${USAGE}`);
    process.exit(2);
  }
  main();
}

module.exports = { main, buildShowsIndex, buildKometaIndex };
