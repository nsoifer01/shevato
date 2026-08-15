'use strict';

// Producer test for scripts/build-data.js, the head of the pipeline: three
// gzipped IMDb TSVs in, data.json + data/show-modal-extras.json out.
//
// The script is a top-level async IIFE with hardcoded paths and no exports, so
// requiring it would run a real build and unit-testing its internals is not
// reachable without changing production code. What IS reachable, and what these
// tests cover, is the whole script end to end against tiny TSV fixtures: rating
// aggregation, the vote/episode floors, unrated episodes, malformed season and
// episode numbers, and the side-file split. A verbatim copy of the script runs
// inside a throwaway app tree, so the bytes under test are the production bytes
// and the app's real 78 MB data.json is never touched.
//
// Not reachable this way, for the record: the loadRatings / loadSeries /
// loadEpisodes / normalizeProvider helpers cannot be exercised in isolation
// (nothing is exported), and the GitHub 100 MiB file-cap guard would need a
// ~100 MiB fixture. The changelog sub-run is switched off with SKIP_CHANGELOG,
// the env var the script already provides for exactly this case.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { buildShowAgg } = require('../scripts/finder-lib.js');
const { detectShapes } = require('../scripts/match.js');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// --- IMDb TSV fixtures ------------------------------------------------------
//
// title.ratings has no row for tt100104 (an episode IMDb lists but nobody has
// rated) or for tt400 (a series with no rating of its own).

const RATINGS = [
  ['tconst', 'averageRating', 'numVotes'],
  // Alpha, a two-season series.
  ['tt100', '8.4', '90000'],
  ['tt100101', '7.0', '100'], ['tt100102', '8.0', '200'], ['tt100103', '9.0', '300'],
  ['tt100201', '6.0', '50'], ['tt100202', '5.0', '60'], ['tt100203', '4.0', '70'],
  // Beta, a mini-series with one barely-rated episode.
  ['tt200', '6.0', '500'],
  ['tt200001', '6.0', '4'], ['tt200002', '6.5', '50'], ['tt200003', '7.0', '60'],
  // Gamma, three seasons, the last one the best.
  ['tt300', '8.8', '20000'],
  ['tt300101', '8.0', '1000'], ['tt300102', '8.1', '1000'],
  ['tt300103', '8.2', '1000'], ['tt300104', '8.3', '1000'],
  ['tt300105', '8.9', '1000'], ['tt300106', '8.9', '1000'],
  ['tt300201', '7.0', '900'], ['tt300202', '7.0', '900'], ['tt300203', '7.0', '900'],
  ['tt300301', '9.0', '800'], ['tt300302', '9.0', '800'], ['tt300303', '9.0', '800'],
  // Delta, rated episodes but no series rating row.
  ['tt400101', '7.0', '20'], ['tt400102', '7.0', '20'], ['tt400103', '7.0', '20'],
  ['tt400201', '7.5', '20'], ['tt400202', '7.5', '20'],
  // An episode of a tvSpecial, and an episode whose parent is not in basics.
  ['tt500001', '9.9', '5000'],
  ['tt600001', '8.0', '100'],
];

const BASICS = [
  ['tconst', 'titleType', 'primaryTitle', 'originalTitle', 'isAdult', 'startYear', 'endYear', 'runtimeMinutes', 'genres'],
  ['tt100', 'tvSeries', 'Alpha', 'Alpha', '0', '2015', '\\N', '\\N', 'Drama,Crime'],
  ['tt100101', 'tvEpisode', 'Pilot', 'Pilot', '0', '2015', '\\N', '42', '\\N'],
  ['tt100102', 'tvEpisode', 'Second', 'Second', '0', '2015', '\\N', '\\N', '\\N'],
  ['tt100103', 'tvEpisode', 'Third', 'Third', '0', '2016', '\\N', '48', '\\N'],
  ['tt100104', 'tvEpisode', 'Unrated', 'Unrated', '0', '2016', '\\N', '50', '\\N'],
  ['tt100201', 'tvEpisode', 'S2E1', 'S2E1', '0', '2017', '\\N', '\\N', '\\N'],
  ['tt100202', 'tvEpisode', 'S2E2', 'S2E2', '0', '2017', '\\N', '\\N', '\\N'],
  ['tt100203', 'tvEpisode', 'S2E3', 'S2E3', '0', '2017', '\\N', '\\N', '\\N'],
  ['tt200', 'tvMiniSeries', 'Beta', 'Beta', '0', '\\N', '\\N', '\\N', '\\N'],
  ['tt200001', 'tvEpisode', 'B1', 'B1', '0', '2019', '\\N', '\\N', '\\N'],
  ['tt200002', 'tvEpisode', 'B2', 'B2', '0', '2019', '\\N', '\\N', '\\N'],
  ['tt200003', 'tvEpisode', 'B3', 'B3', '0', '2019', '\\N', '\\N', '\\N'],
  ['tt300', 'tvSeries', 'Gamma', 'Gamma', '0', '2018', '\\N', '\\N', 'Comedy'],
  ['tt300101', 'tvEpisode', 'G1', 'G1', '0', '2018', '\\N', '\\N', '\\N'],
  ['tt300102', 'tvEpisode', 'G2', 'G2', '0', '2018', '\\N', '\\N', '\\N'],
  ['tt300103', 'tvEpisode', 'G3', 'G3', '0', '2018', '\\N', '\\N', '\\N'],
  ['tt300104', 'tvEpisode', 'G4', 'G4', '0', '2018', '\\N', '\\N', '\\N'],
  ['tt300105', 'tvEpisode', 'G-no-season', 'G-no-season', '0', '2018', '\\N', '\\N', '\\N'],
  ['tt300106', 'tvEpisode', 'G-no-number', 'G-no-number', '0', '2018', '\\N', '\\N', '\\N'],
  ['tt300201', 'tvEpisode', 'G S2E1', 'G S2E1', '0', '2019', '\\N', '\\N', '\\N'],
  ['tt300202', 'tvEpisode', 'G S2E2', 'G S2E2', '0', '2019', '\\N', '\\N', '\\N'],
  ['tt300203', 'tvEpisode', 'G S2E3', 'G S2E3', '0', '2019', '\\N', '\\N', '\\N'],
  ['tt300301', 'tvEpisode', 'G S3E1', 'G S3E1', '0', '2020', '\\N', '\\N', '\\N'],
  ['tt300302', 'tvEpisode', 'G S3E2', 'G S3E2', '0', '2020', '\\N', '\\N', '\\N'],
  ['tt300303', 'tvEpisode', 'G S3E3', 'G S3E3', '0', '2020', '\\N', '\\N', '\\N'],
  ['tt400', 'tvSeries', 'Delta', 'Delta', '0', '\\N', '\\N', '\\N', '\\N'],
  ['tt400101', 'tvEpisode', 'D1', 'D1', '0', '2021', '\\N', '\\N', '\\N'],
  ['tt400102', 'tvEpisode', 'D2', 'D2', '0', '2021', '\\N', '\\N', '\\N'],
  ['tt400103', 'tvEpisode', 'D3', 'D3', '0', '2021', '\\N', '\\N', '\\N'],
  ['tt400201', 'tvEpisode', 'D S2E1', 'D S2E1', '0', '2022', '\\N', '\\N', '\\N'],
  ['tt400202', 'tvEpisode', 'D S2E2', 'D S2E2', '0', '2022', '\\N', '\\N', '\\N'],
  ['tt500', 'tvSpecial', 'Special', 'Special', '0', '2020', '\\N', '\\N', 'Documentary'],
  ['tt500001', 'tvEpisode', 'Sp1', 'Sp1', '0', '2020', '\\N', '\\N', '\\N'],
  ['tt600001', 'tvEpisode', 'Orphan', 'Orphan', '0', '2020', '\\N', '\\N', '\\N'],
];

const EPISODES = [
  ['tconst', 'parentTconst', 'seasonNumber', 'episodeNumber'],
  // Deliberately out of file order: the season has to come out sorted.
  ['tt100103', 'tt100', '1', '3'],
  ['tt100101', 'tt100', '1', '1'],
  ['tt100102', 'tt100', '1', '2'],
  ['tt100104', 'tt100', '1', '4'],
  ['tt100201', 'tt100', '2', '1'],
  ['tt100202', 'tt100', '2', '2'],
  ['tt100203', 'tt100', '2', '3'],
  ['tt200001', 'tt200', '1', '1'],
  ['tt200002', 'tt200', '1', '2'],
  ['tt200003', 'tt200', '1', '3'],
  ['tt300101', 'tt300', '1', '1'],
  ['tt300102', 'tt300', '1', '2'],
  ['tt300103', 'tt300', '1', '3'],
  ['tt300104', 'tt300', '1', '4'],
  // Specials and unnumbered entries: IMDb writes \N and these must not land
  // in a season (a \N season would become NaN and bucket everything together).
  ['tt300105', 'tt300', '\\N', '5'],
  ['tt300106', 'tt300', '1', '\\N'],
  ['tt300201', 'tt300', '2', '1'],
  ['tt300202', 'tt300', '2', '2'],
  ['tt300203', 'tt300', '2', '3'],
  ['tt300301', 'tt300', '3', '1'],
  ['tt300302', 'tt300', '3', '2'],
  ['tt300303', 'tt300', '3', '3'],
  ['tt400101', 'tt400', '1', '1'],
  ['tt400102', 'tt400', '1', '2'],
  ['tt400103', 'tt400', '1', '3'],
  ['tt400201', 'tt400', '2', '1'],
  ['tt400202', 'tt400', '2', '2'],
  ['tt500001', 'tt500', '1', '1'],
  ['tt600001', 'tt600', '1', '1'],
];

function runBuild({ env = {}, tmdbCache = null, seasonOverviews = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-build-test-'));
  tmpDirs.push(dir);
  const appDir = path.join(dir, 'app');
  const dataDir = path.join(appDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(SCRIPTS_DIR, path.join(appDir, 'scripts'), { recursive: true });

  const writeTsv = (name, rows) => fs.writeFileSync(
    path.join(dataDir, name),
    zlib.gzipSync(rows.map((r) => r.join('\t')).join('\n') + '\n'),
  );
  writeTsv('title.ratings.tsv.gz', RATINGS);
  writeTsv('title.basics.tsv.gz', BASICS);
  writeTsv('title.episode.tsv.gz', EPISODES);
  if (tmdbCache) fs.writeFileSync(path.join(dataDir, 'tmdb-cache.json'), JSON.stringify(tmdbCache));
  if (seasonOverviews) fs.writeFileSync(path.join(dataDir, 'season-overviews.json'), JSON.stringify(seasonOverviews));

  // Strip any MIN_* the outer shell happens to carry so the defaults under
  // test are the script's own, not the developer's environment.
  const childEnv = { ...process.env, SKIP_CHANGELOG: '1', ...env };
  delete childEnv.MIN_EPISODES;
  delete childEnv.MIN_VOTES;
  Object.assign(childEnv, env);

  const stdout = execFileSync(process.execPath, [path.join(appDir, 'scripts', 'build-data.js')], {
    encoding: 'utf8',
    env: childEnv,
  });

  return {
    stdout,
    appDir,
    data: JSON.parse(fs.readFileSync(path.join(appDir, 'data.json'), 'utf8')),
    extras: JSON.parse(fs.readFileSync(path.join(dataDir, 'show-modal-extras.json'), 'utf8')),
  };
}

const BUILD = runBuild();
const seasonOf = (data, seriesId, season) => data.matches
  .find((m) => m.seriesId === seriesId && m.season === season);

// --- the file the rest of the pipeline reads --------------------------------

test('build-data: data.json carries the documented header plus one record per surviving season', () => {
  assert.deepEqual(
    Object.keys(BUILD.data).sort(),
    ['builtAt', 'count', 'genres', 'languages', 'matches', 'minEpisodes', 'minVotes', 'providers', 'shapeCounts'],
  );
  assert.ok(!Number.isNaN(Date.parse(BUILD.data.builtAt)), `builtAt should be ISO, got ${BUILD.data.builtAt}`);
  // README documents 3 and 5 as the defaults; they are also stamped into the
  // file so a consumer can tell which floors produced it.
  assert.equal(BUILD.data.minEpisodes, 3);
  assert.equal(BUILD.data.minVotes, 5);
  assert.equal(BUILD.data.count, BUILD.data.matches.length);
});

test('build-data: seasons come out sorted by minimum vote count, most-watched first', () => {
  assert.deepEqual(
    BUILD.data.matches.map((m) => `${m.seriesId}:${m.season}`),
    ['tt300:1', 'tt300:2', 'tt300:3', 'tt100:1', 'tt100:2', 'tt400:1'],
  );
  const votes = BUILD.data.matches.map((m) => m.minVotes);
  assert.deepEqual(votes, [...votes].sort((a, b) => b - a));
});

// --- rating aggregation -----------------------------------------------------

test('build-data: a season aggregates into ordered episodes, first/last/avg and a vote floor', () => {
  const s1 = seasonOf(BUILD.data, 'tt100', 1);
  // Episode rows arrive out of order in the TSV; the season is sorted before
  // anything reads first/last or runs a shape detector over it.
  assert.deepEqual(s1.episodes, [
    { episode: 1, rating: 7, votes: 100 },
    { episode: 2, rating: 8, votes: 200 },
    { episode: 3, rating: 9, votes: 300 },
  ]);
  assert.equal(s1.firstRating, 7);
  assert.equal(s1.lastRating, 9);
  assert.equal(s1.avgRating, 8);
  assert.equal(s1.minVotes, 100);   // the season's WEAKEST episode, not the mean
  assert.equal(s1.seriesRating, 8.4);
  assert.equal(s1.seriesVotes, 90000);
});

test('build-data: avgRating is the mean of the season, rounded to 2dp', () => {
  // (8.0 + 8.1 + 8.2 + 8.3) / 4 sums to 32.599999999999994 in floating point.
  assert.equal(seasonOf(BUILD.data, 'tt300', 1).avgRating, 8.15);
  assert.equal(seasonOf(BUILD.data, 'tt300', 2).avgRating, 7);
  assert.equal(seasonOf(BUILD.data, 'tt100', 2).avgRating, 5);
});

test('build-data: shapeCounts tallies exactly the shapes on the emitted matches', () => {
  const expected = {};
  for (const m of BUILD.data.matches) {
    for (const s of m.shapes) expected[s] = (expected[s] || 0) + 1;
  }
  assert.deepEqual(BUILD.data.shapeCounts, expected);
  assert.equal(BUILD.data.shapeCounts.declining, 1);
  // Tallied after the series-level post-pass, so its tags are counted too.
  assert.equal(BUILD.data.shapeCounts['saved-best-for-last'], 1);
  // The detectors themselves are match.test.js's job; this pins that the
  // pipeline actually runs them over each season, in episode order.
  assert.ok(seasonOf(BUILD.data, 'tt100', 1).shapes.includes('rising'), 'ascending season should be rising');
  assert.ok(seasonOf(BUILD.data, 'tt100', 2).shapes.includes('declining'), 'descending season should be declining');
  // And that the series-level post-pass runs after them: Gamma has 3 seasons
  // and its last is strictly its best.
  assert.ok(
    seasonOf(BUILD.data, 'tt300', 3).shapes.includes('saved-best-for-last'),
    'final, highest-rated season of a 3-season show should be tagged',
  );
  assert.ok(!seasonOf(BUILD.data, 'tt300', 1).shapes.includes('saved-best-for-last'));
});

test('build-data: every emitted season feeds buildShowAgg without a re-walk', () => {
  const rows = buildShowAgg(BUILD.data.matches, detectShapes);
  // Delta has no series rating, so the Finder drops it: Alpha and Gamma remain.
  assert.deepEqual(rows.map((r) => r.seriesId).sort(), ['tt100', 'tt300']);
  const alpha = rows.find((r) => r.seriesId === 'tt100');
  assert.equal(alpha.episodes, 6);
  assert.equal(alpha.avgEpisode, 6.5);       // (7+8+9+6+5+4)/6
  assert.equal(alpha.gap, -1.9);             // 6.5 - 8.4
  assert.equal(alpha.seasonsCount, 2);
  assert.deepEqual(alpha.genres, ['Crime', 'Drama']);
});

// --- missing ratings --------------------------------------------------------

test('build-data: an episode with no ratings row is dropped from its season entirely', () => {
  const s1 = seasonOf(BUILD.data, 'tt100', 1);
  // IMDb lists 4 episodes for Alpha season 1; tt100104 has no rating.
  assert.equal(s1.episodes.length, 3);
  assert.ok(!s1.episodes.some((e) => e.episode === 4), 'unrated episode must not appear');
  // It is gone from the modal side-file too, so no episode row renders blank.
  assert.deepEqual(Object.keys(BUILD.extras.tt100.seasons['1'].eps), ['1', '2', '3']);
});

test('build-data: a series with no ratings row of its own emits seasons without seriesRating', () => {
  const delta = seasonOf(BUILD.data, 'tt400', 1);
  assert.equal('seriesRating' in delta, false);
  assert.equal('seriesVotes' in delta, false);
  // Which is precisely what makes the Finder skip it (buildShowAgg requires
  // both), while the static page builder can still read the season.
  assert.equal(buildShowAgg([delta], detectShapes).length, 0);
});

test('build-data: a series with no start year or genres emits null / empty, not \\N', () => {
  const delta = seasonOf(BUILD.data, 'tt400', 1);
  assert.equal(delta.year, null);
  assert.deepEqual(delta.genres, []);
  assert.equal(delta.seasonYear, 2021);  // recovered from the episodes' air years
});

// --- episode and season oddities -------------------------------------------

test('build-data: seasons below the episode floor are dropped', () => {
  // Delta season 2 has 2 rated episodes against MIN_EPISODES=3.
  assert.equal(seasonOf(BUILD.data, 'tt400', 2), undefined);
});

test('build-data: one under-voted episode drops the whole season', () => {
  // Beta season 1 has a 4-vote episode against MIN_VOTES=5. The floor is a
  // per-episode minimum, not a season average, so the season goes.
  assert.equal(BUILD.data.matches.some((m) => m.seriesId === 'tt200'), false);
});

test('build-data: \\N season or episode numbers are skipped, not parsed into NaN buckets', () => {
  const s1 = seasonOf(BUILD.data, 'tt300', 1);
  assert.equal(s1.episodes.length, 4);
  assert.ok(!s1.episodes.some((e) => !Number.isFinite(e.episode)), 'no NaN episode numbers');
  assert.ok(!s1.episodes.some((e) => e.rating === 8.9), 'the \\N-numbered rows must not land in season 1');
  assert.deepEqual(BUILD.data.matches.filter((m) => m.seriesId === 'tt300').map((m) => m.season), [1, 2, 3]);
});

test('build-data: episodes of non-series parents and of unknown parents are ignored', () => {
  assert.equal(BUILD.data.matches.some((m) => m.seriesId === 'tt500'), false, 'tvSpecial is not a series type');
  assert.equal(BUILD.data.matches.some((m) => m.seriesId === 'tt600'), false, 'parent missing from basics');
});

test('build-data: seasonYear is the earliest episode air year, independent of the show year', () => {
  // Alpha started in 2015; its season 1 spans 2015-2016 and its season 2 aired
  // in 2017. The UI shows seasonYear wherever a single season is displayed.
  assert.equal(seasonOf(BUILD.data, 'tt100', 1).year, 2015);
  assert.equal(seasonOf(BUILD.data, 'tt100', 1).seasonYear, 2015);
  assert.equal(seasonOf(BUILD.data, 'tt100', 2).seasonYear, 2017);
});

test('build-data: avgRuntime averages only episodes that carry one, and is omitted when none do', () => {
  // Alpha S1: 42 and 48 minutes, plus one episode IMDb has no runtime for.
  assert.equal(seasonOf(BUILD.data, 'tt100', 1).avgRuntime, 45);
  assert.equal('avgRuntime' in seasonOf(BUILD.data, 'tt100', 2), false);
});

test('build-data: genres are tallied per season and languages per unique series', () => {
  // Per season on purpose for genres (a long-running show weights its genres),
  // per series for languages (so it does not).
  assert.deepEqual(BUILD.data.genres, [
    { name: 'Comedy', count: 3 },
    { name: 'Drama', count: 2 },
    { name: 'Crime', count: 2 },
  ]);
  assert.deepEqual(BUILD.data.languages, []);   // no TMDB cache in this run
  assert.deepEqual(BUILD.data.providers, []);
});

// --- the modal side-file ----------------------------------------------------

test('build-data: episode ids, runtimes and titles move to show-modal-extras.json', () => {
  const s1 = seasonOf(BUILD.data, 'tt100', 1);
  // data.json keeps only what the grid and the curves read.
  for (const ep of s1.episodes) {
    assert.deepEqual(Object.keys(ep).sort(), ['episode', 'rating', 'votes']);
  }
  assert.deepEqual(BUILD.extras.tt100.seasons['1'].eps, {
    1: { tt: 'tt100101', rt: 42, n: 'Pilot' },
    2: { tt: 'tt100102', n: 'Second' },      // no runtime in the TSV, no rt key
    3: { tt: 'tt100103', rt: 48, n: 'Third' },
  });
  assert.equal(BUILD.extras.tt100.cast, null);   // no TMDB cache in this run
  assert.equal(BUILD.extras.tt100.seasons['1'].ov, null);
});

// --- build tunables ---------------------------------------------------------

test('build-data: MIN_EPISODES counts RATED episodes and MIN_VOTES gates every episode', () => {
  const strict = runBuild({ env: { MIN_EPISODES: '4', MIN_VOTES: '200' } });
  assert.equal(strict.data.minEpisodes, 4);
  assert.equal(strict.data.minVotes, 200);
  // Alpha season 1 lists 4 episodes but only 3 are rated, so a floor of 4 drops
  // it. Gamma season 1 has 4 rated episodes, all at 1000 votes, and survives.
  assert.deepEqual(strict.data.matches.map((m) => `${m.seriesId}:${m.season}`), ['tt300:1']);
  assert.equal(strict.data.count, 1);
});

// --- optional TMDB enrichment ----------------------------------------------

const TMDB_CACHE = {
  tt100: {
    id: 555,
    poster_path: '/alpha.jpg',
    overview: 'Alpha show overview',
    original_language: 'de',
    tvdbId: 777,
    seasonTvdbIds: { 1: 9001 },
    seasonOverviews: { 1: 'cache season one', 2: 'cache season two' },
    cast: [{ name: 'Ada' }, { name: 'Bo' }],
    providers: [
      { name: 'Netflix Standard with Ads' },
      { name: 'Netflix' },
      { name: 'Max' },
      { name: 'HBO Max Amazon Channel' },
      { name: 'Some Indie Channel' },
    ],
  },
};

const ENRICHED = runBuild({
  tmdbCache: TMDB_CACHE,
  seasonOverviews: { tt100: { 1: 'side-file season one' } },
});

test('build-data: TMDB metadata lands on every season of the enriched series only', () => {
  const s1 = seasonOf(ENRICHED.data, 'tt100', 1);
  const s2 = seasonOf(ENRICHED.data, 'tt100', 2);
  assert.equal(s1.poster, '/alpha.jpg');
  assert.equal(s1.overview, 'Alpha show overview');
  assert.equal(s1.tmdbId, 555);
  assert.equal(s1.tvdbId, 777);
  assert.equal(s1.language, 'de');
  assert.equal(s2.language, 'de');
  // Season-level TVDB ids are per season, so only the one in the map gets it.
  assert.equal(s1.seasonTvdbId, 9001);
  assert.equal('seasonTvdbId' in s2, false);
  // Unenriched series carry no empty placeholders.
  assert.equal('poster' in seasonOf(ENRICHED.data, 'tt300', 1), false);
  assert.equal('language' in seasonOf(ENRICHED.data, 'tt300', 1), false);
});

test('build-data: streaming plans collapse to the parent brand and dedupe, order preserved', () => {
  // "Netflix Standard with Ads" and "Netflix" are one service to a viewer, and
  // so are "Max" and "HBO Max Amazon Channel". Unknown names pass through.
  assert.deepEqual(seasonOf(ENRICHED.data, 'tt100', 1).providers, ['Netflix', 'HBO Max', 'Some Indie Channel']);
  assert.deepEqual(ENRICHED.data.providers, [
    { name: 'Netflix', count: 1 },
    { name: 'HBO Max', count: 1 },
    { name: 'Some Indie Channel', count: 1 },
  ]);
  // Counted once per series even though Alpha contributes two seasons.
  assert.deepEqual(ENRICHED.data.languages, [{ code: 'de', count: 1 }]);
});

test('build-data: cast and per-season overviews move to the side-file, side-file overviews win', () => {
  const s1 = seasonOf(ENRICHED.data, 'tt100', 1);
  assert.equal('cast' in s1, false);
  assert.equal('seasonOverview' in s1, false);
  assert.deepEqual(ENRICHED.extras.tt100.cast, [{ name: 'Ada' }, { name: 'Bo' }]);
  // season-overviews.json is the fresher source, so it beats the copy baked
  // into tmdb-cache.json for season 1; season 2 falls back to the cache.
  assert.equal(ENRICHED.extras.tt100.seasons['1'].ov, 'side-file season one');
  assert.equal(ENRICHED.extras.tt100.seasons['2'].ov, 'cache season two');
});
