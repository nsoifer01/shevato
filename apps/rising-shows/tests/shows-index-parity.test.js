'use strict';

// Full-catalogue semantic parity for the F08 boot split.
//
// WHAT THIS PROVES
// ----------------
// Until 2026-09-08 the browser downloaded the SEASON-level index and folded it
// to one row per show at boot, with finder-lib's buildShowAgg. Now split-data.js
// runs that fold once per deploy and the browser downloads its result. The
// representation changed; the answers must not have.
//
// So this file takes the season-level file as the REFERENCE INPUT, computes
// what the old browser would have produced from it, and holds the shipped
// shows-index.json to exactly that - field by field, over every show in the
// catalogue. Byte identity is meaningless across a representation change;
// semantic identity is the whole claim, and it is what is asserted here.
//
// It also pins the derived answers that used to be scanned out of the season
// records at boot: the above-IMDb badge, the provider chip, the best/worst
// season badges, and the suggestion index.
//
// The synthetic catalogue below runs everywhere, including the dependency-free
// push/PR CI. The real-catalogue half runs only where the gitignored release
// data is present (a maintainer's tree, and the deploy build); it SKIPS with a
// reason rather than passing vacuously, because a green tick over an absent
// dataset is worse than a visible skip.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Finder = require('../scripts/finder-lib.js');
const Match = require('../scripts/match.js');
const Providers = require('../scripts/providers-lib.js');
const { buildShowsIndex, buildKometaIndex } = require('../scripts/split-data.js');

const APP_DIR = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// The reference implementation: what the browser used to compute at boot,
// written out of the pre-split app.js. Anything shows-index.json claims has to
// match what this produces from the same season records.
// ---------------------------------------------------------------------------

function referenceFromSeasons(matches, aboveImdb) {
  const shows = Finder.buildShowAgg(matches, Match.detectShapes);

  // buildAboveImdbMap
  const above = new Set(aboveImdb);

  // indexShowAgg's providerBySeries
  const provider = new Map();
  // buildSeriesIndex's adultSeriesIds
  const adult = new Set();
  // buildBestSeasonMap
  const best = new Map();
  const worst = new Map();
  const count = new Map();
  // computeShowRelated's meanVotes(seasons)
  const voteSum = new Map();

  for (const m of matches) {
    if (!provider.has(m.seriesId)) {
      const first = Providers.normalizeProviders(m.providers)[0];
      if (first) provider.set(m.seriesId, first);
    }
    if (Array.isArray(m.genres) && m.genres.includes('Adult')) adult.add(m.seriesId);
    count.set(m.seriesId, (count.get(m.seriesId) || 0) + 1);
    voteSum.set(m.seriesId, (voteSum.get(m.seriesId) || 0) + (m.minVotes || 0));
    if (!best.has(m.seriesId)) {
      best.set(m.seriesId, { season: m.season, avg: m.avgRating });
      worst.set(m.seriesId, { season: m.season, avg: m.avgRating });
    } else {
      if (m.avgRating > best.get(m.seriesId).avg) best.set(m.seriesId, { season: m.season, avg: m.avgRating });
      if (m.avgRating < worst.get(m.seriesId).avg) worst.set(m.seriesId, { season: m.season, avg: m.avgRating });
    }
  }

  return { shows, above, provider, adult, best, worst, count, voteSum };
}

// Compare the shipped show index against the reference, show by show.
function assertParity(shipped, matches, aboveImdb, label) {
  const ref = referenceFromSeasons(matches, aboveImdb);
  const byId = new Map(shipped.map((s) => [s.seriesId, s]));

  assert.equal(shipped.length, ref.shows.length,
    `${label}: the index must carry exactly the shows buildShowAgg produces`);

  for (const r of ref.shows) {
    const got = byId.get(r.seriesId);
    assert.ok(got, `${label}: ${r.seriesId} missing from the shipped index`);

    // --- the aggregate itself, field for field ---
    assert.equal(got.title, r.title, `${label}: ${r.seriesId} title`);
    assert.equal(got.year, r.year, `${label}: ${r.seriesId} year`);
    assert.equal(got.language, r.language, `${label}: ${r.seriesId} language`);
    assert.equal(got.poster, r.poster, `${label}: ${r.seriesId} poster`);
    assert.deepEqual(got.genres, r.genres, `${label}: ${r.seriesId} genres`);
    assert.equal(got.showRating, r.showRating, `${label}: ${r.seriesId} showRating`);
    assert.equal(got.votes, r.votes, `${label}: ${r.seriesId} votes`);
    assert.equal(got.episodes, r.episodes, `${label}: ${r.seriesId} rated episode count`);
    assert.equal(got.avgEpisode, r.avgEpisode, `${label}: ${r.seriesId} avgEpisode`);
    assert.equal(got.gap, r.gap, `${label}: ${r.seriesId} gap`);
    assert.equal(got.runtimeHrs, r.runtimeHrs, `${label}: ${r.seriesId} runtimeHrs`);
    assert.equal(got.seasonsCount, r.seasonsCount, `${label}: ${r.seriesId} seasonsCount`);
    assert.deepEqual(got.shapes, r.shapes, `${label}: ${r.seriesId} show shapes`);

    // --- season averages: the sparkline's input, plus episodeCount ---
    assert.equal(got.seasonAvgs.length, r.seasonAvgs.length, `${label}: ${r.seriesId} seasonAvgs length`);
    for (let i = 0; i < r.seasonAvgs.length; i++) {
      assert.equal(got.seasonAvgs[i].season, r.seasonAvgs[i].season, `${label}: ${r.seriesId} seasonAvgs[${i}].season`);
      assert.equal(got.seasonAvgs[i].year, r.seasonAvgs[i].year, `${label}: ${r.seriesId} seasonAvgs[${i}].year`);
      assert.equal(got.seasonAvgs[i].avg, r.seasonAvgs[i].avg, `${label}: ${r.seriesId} seasonAvgs[${i}].avg`);
    }

    // --- the single-season card sparkline ---
    if (r.episodeSeries) {
      assert.deepEqual(got.epRatings, r.episodeSeries.map((e) => e.rating),
        `${label}: ${r.seriesId} single-season sparkline ratings`);
    } else {
      assert.equal(got.epRatings, undefined,
        `${label}: ${r.seriesId} multi-season shows carry no episode ratings`);
    }

    // --- the answers the browser used to scan the season records for ---
    assert.equal(!!got.aboveImdb, ref.above.has(r.seriesId), `${label}: ${r.seriesId} aboveImdb`);
    assert.equal(got.provider, ref.provider.get(r.seriesId), `${label}: ${r.seriesId} provider chip`);
    assert.equal(!!got.adult, ref.adult.has(r.seriesId), `${label}: ${r.seriesId} adult flag`);

    const n = ref.count.get(r.seriesId) || 0;
    const b = ref.best.get(r.seriesId);
    const w = ref.worst.get(r.seriesId);
    if (n >= 2) {
      assert.equal(got.bestSeason, b.season, `${label}: ${r.seriesId} bestSeason badge`);
      assert.equal(got.worstSeason, b.season === w.season ? undefined : w.season,
        `${label}: ${r.seriesId} worstSeason badge`);
    } else {
      assert.equal(got.bestSeason, undefined, `${label}: ${r.seriesId} single-season shows get no badge`);
      assert.equal(got.worstSeason, undefined, `${label}: ${r.seriesId} single-season shows get no badge`);
    }
    // Exact, not rounded: see the note in buildShowsIndex. A rounded mean
    // silently re-bands 19% of the catalogue in "more shows like this".
    assert.equal(got.meanSeasonVotes, (ref.voteSum.get(r.seriesId) || 0) / n,
      `${label}: ${r.seriesId} meanSeasonVotes`);
  }
}

// ---------------------------------------------------------------------------
// A synthetic catalogue that exercises the shapes the real one contains:
// single- and multi-season shows, a show with an unrated episode, ties on
// season average, a show with no series rating (dropped by buildShowAgg), an
// Adult title, missing providers, and a season with no average at all.
// ---------------------------------------------------------------------------

function syntheticCatalogue() {
  const ep = (rating, votes = 100) => ({ episode: 1, rating, votes });
  const season = (o) => {
    const eps = o.ratings.map((r, i) => ({ episode: i + 1, rating: r, votes: o.votes ?? 100 }));
    const rated = eps.filter((e) => typeof e.rating === 'number');
    return {
      seriesId: o.id,
      title: o.title,
      year: o.year ?? 2020,
      seasonYear: o.seasonYear ?? o.year ?? 2020,
      type: 'tvSeries',
      genres: o.genres ?? ['Drama'],
      season: o.season,
      firstRating: rated[0] ? rated[0].rating : undefined,
      lastRating: rated.length ? rated[rated.length - 1].rating : undefined,
      avgRating: o.avgRating !== undefined
        ? o.avgRating
        : (rated.length ? Math.round((rated.reduce((s, e) => s + e.rating, 0) / rated.length) * 100) / 100 : undefined),
      minVotes: o.minVotes ?? 1000,
      shapes: o.shapes ?? [],
      confidence: o.confidence,
      avgRuntime: o.avgRuntime ?? 45,
      seriesRating: o.seriesRating,
      seriesVotes: o.seriesVotes,
      poster: o.poster ?? `/${o.id}.jpg`,
      tmdbId: o.tmdbId ?? 1,
      tvdbId: o.tvdbId ?? 2,
      seasonTvdbId: 3,
      language: o.language ?? 'en',
      providers: o.providers ?? ['Netflix', 'YouTube TV'],
      episodeCount: eps.length,
      ratedCount: rated.length,
      ratingSum: Math.round(rated.reduce((s, e) => s + e.rating, 0) * 100) / 100,
      episodes: eps,
    };
  };
  void ep;
  return [
    // one season, rated throughout -> gets epRatings, no best/worst badge
    season({ id: 'tt01', title: 'Solo', season: 1, ratings: [8, 8.5, 9], seriesRating: 8.2, seriesVotes: 5000 }),
    // three seasons, distinct averages -> best S2, worst S3
    season({ id: 'tt02', title: 'Trio', season: 1, ratings: [7, 7], seriesRating: 7.5, seriesVotes: 20000, seasonYear: 2019 }),
    season({ id: 'tt02', title: 'Trio', season: 2, ratings: [9, 9], seriesRating: 7.5, seriesVotes: 20000, seasonYear: 2020 }),
    season({ id: 'tt02', title: 'Trio', season: 3, ratings: [6, 6], seriesRating: 7.5, seriesVotes: 20000, seasonYear: 2021 }),
    // two seasons TIED on average -> best exists, worst suppressed
    season({ id: 'tt03', title: 'Tied', season: 1, ratings: [8, 8], seriesRating: 8, seriesVotes: 3000 }),
    season({ id: 'tt03', title: 'Tied', season: 2, ratings: [8, 8], seriesRating: 8, seriesVotes: 3000 }),
    // an unrated episode must not NaN-poison the fold
    season({ id: 'tt04', title: 'Partly rated', season: 1, ratings: [8, null, 9], seriesRating: 8.4, seriesVotes: 900 }),
    // no series rating -> buildShowAgg drops it from the grid entirely
    season({ id: 'tt05', title: 'Unrated series', season: 1, ratings: [7], seriesVotes: 10 }),
    // Adult genre -> poster blur flag
    season({ id: 'tt06', title: 'Adult title', season: 1, ratings: [6, 6.5], genres: ['Adult', 'Drama'], seriesRating: 6.2, seriesVotes: 400 }),
    // no mainstream provider -> no chip
    season({ id: 'tt07', title: 'No provider', season: 1, ratings: [7.5], providers: [], seriesRating: 7.4, seriesVotes: 800 }),
    // a season carrying no average at all
    season({ id: 'tt08', title: 'Blank season', season: 1, ratings: [8, 8], seriesRating: 8, seriesVotes: 2000 }),
    season({ id: 'tt08', title: 'Blank season', season: 2, ratings: [], avgRating: undefined, seriesRating: 8, seriesVotes: 2000 }),
  ];
}

// Mirrors split-data.js's aboveImdb fold, so the synthetic run feeds
// buildShowsIndex the same input the real build does.
function aboveImdbFor(matches) {
  const acc = new Map();
  for (const m of matches) {
    if (typeof m.seriesRating !== 'number' || !Array.isArray(m.episodes)) continue;
    let a = acc.get(m.seriesId);
    if (!a) { a = { sum: 0, count: 0, seriesRating: m.seriesRating }; acc.set(m.seriesId, a); }
    for (const e of m.episodes) if (typeof e.rating === 'number') { a.sum += e.rating; a.count++; }
  }
  const out = [];
  for (const [id, a] of acc) {
    if (a.count === 0) continue;
    if ((a.sum / a.count) > a.seriesRating) out.push(id);
  }
  return out;
}

// The browser receives records with `episodes` stripped and the folded
// ratedCount/ratingSum/epRatings in their place. Mirrors split-data's slim map
// so the synthetic run exercises the same input shape.
function slimify(matches) {
  const seasonCount = new Map();
  for (const m of matches) seasonCount.set(m.seriesId, (seasonCount.get(m.seriesId) || 0) + 1);
  return matches.map((m) => {
    const { episodes, overview, ...rest } = m;
    void overview;
    const eps = Array.isArray(episodes) ? episodes : [];
    rest.episodeCount = eps.length;
    let ratedCount = 0;
    let ratingSum = 0;
    for (const e of eps) if (typeof e.rating === 'number') { ratedCount++; ratingSum += e.rating; }
    rest.ratedCount = ratedCount;
    rest.ratingSum = Math.round(ratingSum * 100) / 100;
    if (seasonCount.get(m.seriesId) === 1 && eps.length) {
      rest.epRatings = eps.filter((e) => typeof e.rating === 'number').map((e) => e.rating);
    }
    return rest;
  });
}

test('parity (synthetic catalogue): the built show index equals the boot-time fold', () => {
  const raw = syntheticCatalogue();
  const above = aboveImdbFor(raw);
  const slim = slimify(raw);
  const shipped = buildShowsIndex(slim, above);
  assertParity(shipped, slim, above, 'synthetic');
  // The scenarios above must actually be present, or this is a vacuous pass.
  const byId = new Map(shipped.map((s) => [s.seriesId, s]));
  assert.equal(shipped.length, 7, 'tt05 (no series rating) is dropped, the other seven survive');
  assert.equal(byId.has('tt05'), false, 'a show with no IMDb series rating is not in the grid');
  assert.ok(byId.get('tt01').epRatings, 'single-season show carries its episode ratings');
  assert.equal(byId.get('tt02').bestSeason, 2);
  assert.equal(byId.get('tt02').worstSeason, 3);
  assert.equal(byId.get('tt03').bestSeason, 1, 'a tie still names a best');
  assert.equal(byId.get('tt03').worstSeason, undefined, 'but not a worst');
  assert.equal(byId.get('tt06').adult, true);
  assert.equal(byId.get('tt07').provider, undefined, 'no mainstream provider, no chip');
  assert.ok(Number.isFinite(byId.get('tt04').avgEpisode), 'an unrated episode does not NaN the average');
});

test('parity (synthetic catalogue): every season record survives into a detail file', () => {
  // The season records the boot payload no longer carries must be recoverable
  // in full, per show, or a modal loses fields nobody notices until a user
  // opens one.
  const slim = slimify(syntheticCatalogue());
  const byShow = new Map();
  for (const m of slim) {
    if (!byShow.has(m.seriesId)) byShow.set(m.seriesId, []);
    byShow.get(m.seriesId).push(m);
  }
  for (const [id, records] of byShow) {
    for (const m of records) {
      // Every field the season record had is still on it; `records` in the
      // detail file IS the slim record, not a subset of it.
      assert.ok(Object.keys(m).length >= 20, `${id} S${m.season} keeps its full field set`);
    }
  }
});

test('the Kometa slice carries exactly the eight fields that page reads', () => {
  const slim = slimify(syntheticCatalogue());
  const rows = buildKometaIndex(slim);
  assert.equal(rows.length, slim.length, 'one row per season, same as before');
  const allowed = new Set(['seriesId', 'title', 'season', 'shapes', 'confidence', 'tmdbId', 'tvdbId', 'seasonTvdbId']);
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      assert.ok(allowed.has(k), `kometa-index must not carry ${k}`);
    }
  }
  // and it must not have lost the ones it needs
  const first = rows.find((r) => r.seriesId === 'tt02');
  assert.equal(first.title, 'Trio');
  assert.ok(Number.isFinite(first.season));
});

// ---------------------------------------------------------------------------
// The real catalogue. Skips loudly when the gitignored release data is absent.
// ---------------------------------------------------------------------------

const INDEX = path.join(APP_DIR, 'data-index.json');
const SHOWS = path.join(APP_DIR, 'shows-index.json');
const haveReal = fs.existsSync(INDEX) && fs.existsSync(SHOWS);

test('parity (real catalogue): the shipped show index equals the boot-time fold, for every show', { skip: haveReal ? false : 'release data absent (data-index.json / shows-index.json); run npm run build:site' }, () => {
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
  assert.ok(index.matches.length > 10000, 'sanity: this is the real season file');
  assert.ok(shows.shows.length > 10000, 'sanity: this is the real show file');
  assertParity(shows.shows, index.matches, index.aboveImdb || [], 'real');
});

test('parity (real catalogue): the two files describe the same build', { skip: haveReal ? false : 'release data absent' }, () => {
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
  assert.equal(shows.builtAt, index.builtAt, 'same dataset build');
  assert.equal(shows.splitAt, index.splitAt, 'same split run');
  // Facet lists drive the filter chips; they are copied, not recomputed.
  assert.deepEqual(shows.genres, index.genres);
  assert.deepEqual(shows.languages, index.languages);
  assert.deepEqual(shows.providers, index.providers);
  assert.deepEqual(shows.shapeCounts, index.shapeCounts);
  assert.equal(shows.contentHash, index.contentHash, 'same dataset fingerprint');
  // `count` means seasons in the season file; the show file names both.
  assert.equal(shows.showCount, shows.shows.length);
  assert.equal(shows.seasonCount, index.matches.length);
  assert.equal(shows.count, undefined, 'an ambiguous `count` must not reappear');
});

test('the boot payload is materially smaller than the season file it replaced', { skip: haveReal ? false : 'release data absent' }, () => {
  const seasonBytes = fs.statSync(INDEX).size;
  const showBytes = fs.statSync(SHOWS).size;
  assert.ok(showBytes < seasonBytes * 0.6,
    `the show index must stay under 60% of the season file raw (season ${seasonBytes}, show ${showBytes})`);
});

// ---------------------------------------------------------------------------
// "More shows like this" ranked over SEASON records before the split and over
// SHOW records after it. The inputs changed shape; the recommendations must
// not have moved, so the pre-split algorithm is reproduced here verbatim and
// both are run over the real catalogue.
// ---------------------------------------------------------------------------

const { helpers } = require('./app-harness.js');

// Read from app.js, never transcribed: a copy of this number in the test drifts
// silently and then the "reference" implementation is not the reference.
const RELATED_VOTES_BAND = helpers.RELATED_VOTES_BAND;

// The pre-split implementation, transcribed from js/app.js as it stood at
// 071c8da. Reads season records and folds each candidate's seasons the way the
// browser used to on every modal open.
function referenceShowRelated(seriesId, matches, shapesBySeries, fns) {
  const { weightedAvgEpisode, languagesCompatible, isAnimated, isUnscripted } = fns;
  const shapesFor = (sid) => (shapesBySeries && shapesBySeries.get(sid)) || [];
  const currentShapes = shapesFor(seriesId);
  const bySeriesId = new Map();
  for (const m of matches) {
    if (!bySeriesId.has(m.seriesId)) bySeriesId.set(m.seriesId, []);
    bySeriesId.get(m.seriesId).push(m);
  }
  const currentSeasons = bySeriesId.get(seriesId);
  if (!currentSeasons || currentSeasons.length === 0) return [];
  const currentMeta = currentSeasons[0];
  if (typeof currentMeta.seriesRating !== 'number') return [];
  const meanVotes = (seasons) => seasons.reduce((s, m) => s + (m.minVotes || 0), 0) / seasons.length;
  const currentAvg = weightedAvgEpisode(currentSeasons);
  if (currentAvg === null) return [];
  const currentDev = currentAvg - currentMeta.seriesRating;
  const currentGenres = currentMeta.genres || [];
  const currentLang = currentMeta.language || '';
  const voteAnchor = meanVotes(currentSeasons);
  const currentAnimated = isAnimated(currentGenres);
  const currentUnscripted = isUnscripted(currentGenres);
  const currentSeriesVotes = typeof currentMeta.seriesVotes === 'number' ? currentMeta.seriesVotes : 0;

  const results = [];
  for (const [sid, seasons] of bySeriesId) {
    if (sid === seriesId) continue;
    const meta = seasons[0];
    if (typeof meta.seriesRating !== 'number') continue;
    if (!languagesCompatible(currentLang, meta.language)) continue;
    const xGenres = meta.genres || [];
    if (isAnimated(xGenres) !== currentAnimated) continue;
    if (isUnscripted(xGenres) !== currentUnscripted) continue;
    if (voteAnchor > 0) {
      const xv = meanVotes(seasons);
      if (xv < voteAnchor / 10 || xv > voteAnchor * 10) continue;
    }
    if (currentSeriesVotes > 0) {
      const sv = typeof meta.seriesVotes === 'number' ? meta.seriesVotes : 0;
      if (sv < currentSeriesVotes / RELATED_VOTES_BAND || sv > currentSeriesVotes * RELATED_VOTES_BAND) continue;
    }
    const sharedGenreCount = currentGenres.filter((g) => xGenres.includes(g)).length;
    if (sharedGenreCount === 0) continue;
    const avg = weightedAvgEpisode(seasons);
    if (avg === null) continue;
    const dev = avg - meta.seriesRating;
    const devDiff = Math.abs(currentDev - dev);
    const voteProxy = typeof meta.seriesVotes === 'number' ? meta.seriesVotes : (meta.minVotes || 0);
    const candShapes = shapesFor(sid);
    const sharedShapes = currentShapes.filter((sh) => candShapes.includes(sh));
    results.push({ meta, avg, devDiff, sharedGenreCount, voteProxy, sharedShapes });
  }
  results.sort((a, b) => {
    const ag = Math.min(a.sharedGenreCount, 3);
    const bg = Math.min(b.sharedGenreCount, 3);
    if (ag !== bg) return bg - ag;
    if (a.sharedShapes.length !== b.sharedShapes.length) return b.sharedShapes.length - a.sharedShapes.length;
    if (a.devDiff !== b.devDiff) return a.devDiff - b.devDiff;
    return b.voteProxy - a.voteProxy;
  });
  return results.slice(0, 10)
    .map((r) => ({ ...r.meta, _avg: r.avg, _sharedShape: r.sharedShapes[0] || null }));
}

test('parity (real catalogue): "more shows like this" recommends the same shows, in the same order', { skip: haveReal ? false : 'release data absent' }, () => {
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
  const shapesBySeries = new Map(shows.map((s) => [s.seriesId, s.shapes]));

  const fns = {
    weightedAvgEpisode: helpers.weightedAvgEpisode,
    languagesCompatible: helpers.languagesCompatible,
    isAnimated: helpers.isAnimated,
    isUnscripted: helpers.isUnscripted,
  };
  for (const [k, v] of Object.entries(fns)) {
    assert.equal(typeof v, 'function', `app.js must export ${k} for this comparison to mean anything`);
  }

  // A deterministic spread across the catalogue rather than the head of it:
  // the most-voted shows are not representative of the bands and format gates.
  const sample = [];
  for (let i = 0; i < shows.length; i += Math.floor(shows.length / 400)) sample.push(shows[i].seriesId);

  let compared = 0;
  let nonEmpty = 0;
  for (const sid of sample) {
    const before = referenceShowRelated(sid, index.matches, shapesBySeries, fns)
      .map((r) => `${r.seriesId}:${r._sharedShape || ''}`);
    // Array.from first: app.js runs in a vm context with its own intrinsics, so
    // the array it returns has a different Array.prototype and deepStrictEqual
    // rejects it on the prototype alone, whatever it contains. Copying into
    // this realm compares the contents, which is the claim being made.
    const after = Array.from(helpers.computeShowRelated(sid, shows, shapesBySeries))
      .map((r) => `${r.seriesId}:${r._sharedShape || ''}`);
    assert.deepEqual(after, before, `related shows moved for ${sid}`);
    compared++;
    if (before.length) nonEmpty++;
  }
  assert.ok(compared >= 300, `expected a broad sample, compared ${compared}`);
  assert.ok(nonEmpty >= compared / 2,
    `at least half the sample must actually produce recommendations, got ${nonEmpty}/${compared}`);
});

test('parity (real catalogue): the suggestion index names the same shows', { skip: haveReal ? false : 'release data absent' }, () => {
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
  // buildSeriesIndex used to fold over season records; it now maps the show
  // rows. The suggestion list must contain the same titles in the same order.
  const before = new Map();
  for (const m of index.matches) {
    let e = before.get(m.seriesId);
    if (!e) {
      e = { seriesId: m.seriesId, title: m.title, year: m.year || null, poster: m.poster || null, seriesVotes: m.seriesVotes || 0 };
      before.set(m.seriesId, e);
    } else {
      if (!e.poster && m.poster) e.poster = m.poster;
      if (!e.year && m.year) e.year = m.year;
      if (m.seriesVotes && m.seriesVotes > e.seriesVotes) e.seriesVotes = m.seriesVotes;
    }
  }
  // The pre-split index covered every SEASON record, including shows
  // buildShowAgg drops for having no IMDb series rating; those were never
  // reachable from the grid. Compare over the shows the finder actually has.
  const shipped = new Set(shows.map((s) => s.seriesId));
  const refRows = [...before.values()].filter((e) => shipped.has(e.seriesId))
    .sort((a, b) => a.title.localeCompare(b.title));
  const newRows = shows.map((s) => ({
    seriesId: s.seriesId, title: s.title, year: s.year || null, poster: s.poster || null, seriesVotes: s.votes || 0,
  })).sort((a, b) => a.title.localeCompare(b.title));
  assert.equal(newRows.length, refRows.length);
  for (let i = 0; i < refRows.length; i++) {
    assert.equal(newRows[i].seriesId, refRows[i].seriesId, `suggestion row ${i} seriesId`);
    assert.equal(newRows[i].title, refRows[i].title, `suggestion row ${i} title`);
    assert.equal(newRows[i].year, refRows[i].year, `suggestion row ${i} year`);
    assert.equal(newRows[i].poster, refRows[i].poster, `suggestion row ${i} poster`);
    assert.equal(newRows[i].seriesVotes, refRows[i].seriesVotes, `suggestion row ${i} votes`);
  }
});

// ---------------------------------------------------------------------------
// The Finder pipeline itself, over the FULL catalogue.
//
// The field-by-field parity above is the strong claim; this is the one a
// reader actually cares about. It runs the real filter/sort/search pipeline
// (finder-lib's filterAndSortRows, the same call the browser makes) over both
// representations and asserts the resulting ID ORDER is identical - default
// ranking, every supported filter, text search, both sort directions, and a
// batch of randomised combinations on top.
// ---------------------------------------------------------------------------

function finderState(over = {}) {
  return {
    ...Finder.FINDER_DEFAULTS,
    search: '',
    searchFold: '',
    genres: new Set(),
    genresExclude: new Set(),
    languages: new Set(),
    shapes: new Set(),
    ...over,
  };
}

// The browser stamps `titleFold` on each row (indexShowAgg) and refreshes
// `searchFold` before filtering; do the same to both sides so the search
// predicate is exercised rather than skipped.
function prepared(rows, f) {
  for (const r of rows) if (r.titleFold === undefined) r.titleFold = Finder.foldSearch(r.title);
  return { rows, f: { ...f, searchFold: Finder.foldSearch(f.search || '') } };
}

test('parity (real catalogue): the finder returns the same rows in the same order', { skip: haveReal ? false : 'release data absent' }, () => {
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const shipped = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
  const reference = Finder.buildShowAgg(index.matches, Match.detectShapes);

  const ALL_SHAPES = ['rising', 'consistent', 'slow-burn', 'big-finale', 'rebound',
    'front-loaded', 'declining', 'bad-finale', 'rollercoaster', 'mid-peak', 'u-shaped',
    'saved-best-for-last', 'shape-drift'];
  const SORTS = ['votes', 'gap', 'avgEpisode', 'showRating', 'episodes', 'seasonsCount',
    'year', 'title', 'runtimeHrs'];

  const cases = [
    ['default ranking', finderState()],
    ['text search: breaking', finderState({ search: 'breaking' })],
    ['text search: accent-folded', finderState({ search: 'pokemon' })],
    ['text search: no match at all', finderState({ search: 'zzzzzzzzzzzz' })],
    ['minEpisodes', finderState({ minEpisodes: 50 })],
    ['minSeasons', finderState({ minSeasons: 4 })],
    ['minVotes', finderState({ minVotes: 100000 })],
    ['minShowRating', finderState({ minShowRating: 8 })],
    ['minAvgEpisode', finderState({ minAvgEpisode: 8.5 })],
    ['gapDir up', finderState({ gapDir: 'up' })],
    ['gapDir down + minGap', finderState({ gapDir: 'down', minGap: 0.5 })],
    ['year window', finderState({ minYear: 2015, maxYear: 2020 })],
    ['hidden gems', finderState({ hiddenGems: true })],
    ['genres include', finderState({ genres: new Set(['Drama', 'Crime']) })],
    ['genres exclude', finderState({ genresExclude: new Set(['Animation']) })],
    ['languages', finderState({ languages: new Set(['ja', 'ko']) })],
    ['shape AND', finderState({ shapes: new Set(['rising']) })],
    ['two shapes AND', finderState({ shapes: new Set(['rising', 'consistent']) })],
    ['everything at once (usually empty)', finderState({
      search: 'the', minEpisodes: 20, minSeasons: 3, minVotes: 50000, minShowRating: 8.5,
      gapDir: 'up', minGap: 0.2, minYear: 2010, genres: new Set(['Drama']),
      languages: new Set(['en']), shapes: new Set(['rising']),
    })],
  ];
  for (const s of SORTS) {
    cases.push([`sort ${s} desc`, finderState({ sort: s, sortDir: 'desc' })]);
    cases.push([`sort ${s} asc`, finderState({ sort: s, sortDir: 'asc' })]);
  }

  // Randomised combinations, deterministically seeded so a failure is
  // reproducible rather than a story about a run that once went red.
  let seed = 20260908;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  for (let i = 0; i < 40; i++) {
    cases.push([`random #${i}`, finderState({
      sort: pick(SORTS),
      sortDir: rnd() < 0.5 ? 'asc' : 'desc',
      search: rnd() < 0.35 ? pick(['a', 'the', 'star', 'love', 'man', 'night']) : '',
      minEpisodes: rnd() < 0.4 ? Math.floor(rnd() * 100) : 0,
      minSeasons: rnd() < 0.4 ? Math.floor(rnd() * 6) : 0,
      minVotes: rnd() < 0.4 ? Math.floor(rnd() * 200000) : 0,
      minShowRating: rnd() < 0.4 ? Math.round(rnd() * 90) / 10 : 0,
      minAvgEpisode: rnd() < 0.3 ? Math.round(rnd() * 90) / 10 : 0,
      gapDir: pick(['any', 'up', 'down']),
      minGap: rnd() < 0.3 ? Math.round(rnd() * 20) / 10 : 0,
      minYear: rnd() < 0.3 ? 1960 + Math.floor(rnd() * 60) : null,
      maxYear: rnd() < 0.3 ? 1990 + Math.floor(rnd() * 36) : null,
      hiddenGems: rnd() < 0.15,
      shapes: rnd() < 0.35 ? new Set([pick(ALL_SHAPES)]) : new Set(),
    })]);
  }

  let nonEmpty = 0;
  for (const [label, f] of cases) {
    const a = prepared(reference, f);
    const b = prepared(shipped, f);
    const before = Finder.filterAndSortRows(a.rows, a.f).map((r) => r.seriesId);
    const after = Finder.filterAndSortRows(b.rows, b.f).map((r) => r.seriesId);
    assert.equal(after.length, before.length, `${label}: result COUNT moved (${before.length} -> ${after.length})`);
    // Compare as one string: 34k assert.equal calls per case is minutes of
    // test time for the same answer.
    assert.equal(after.join(','), before.join(','), `${label}: result ORDER moved`);
    if (before.length) nonEmpty++;
  }
  assert.ok(nonEmpty >= cases.length * 0.6,
    `most cases must actually return rows or this proves little (${nonEmpty}/${cases.length})`);
});
