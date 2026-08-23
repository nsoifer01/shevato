'use strict';

// Producer test for scripts/split-data.js.
//
// split-data.js is the build step that turns the full data.json into what the
// browser downloads: data-index.json (no episodes/overview, plus folded-down
// aggregates) and one data/detail/<seriesId>.json per series. finder-lib.test.js
// pins the CONSUMER side (buildShowAgg accepting split records), but it does so
// against a hand-written `splitOf()` replica of this script. A replica cannot
// catch the producer drifting away from it, which is exactly the failure that
// would ship a Finder full of blank stats. These tests run the real script and
// feed its real output into the real buildShowAgg.
//
// The script hardcodes its paths off __dirname (data.json in, data-index.json
// and data/detail out) and exposes no overrides, so the only hermetic way to
// drive it is to run a verbatim copy inside a throwaway app tree: the bytes
// under test are the production bytes, only the tree around them is a fixture.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function runSplit(data, extras) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-split-test-'));
  tmpDirs.push(dir);
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(SCRIPTS_DIR, path.join(appDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'data.json'), JSON.stringify(data));
  if (extras) {
    fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'data', 'show-modal-extras.json'), JSON.stringify(extras));
  }

  execFileSync(process.execPath, [path.join(appDir, 'scripts', 'split-data.js')], { encoding: 'utf8' });

  const index = JSON.parse(fs.readFileSync(path.join(appDir, 'data-index.json'), 'utf8'));
  const detailDir = path.join(appDir, 'data', 'detail');
  const detail = {};
  for (const file of fs.readdirSync(detailDir)) {
    detail[file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(detailDir, file), 'utf8'));
  }
  return { index, detail, appDir, detailDir };
}

// data.json shape, small but covering every branch the script has: multi- vs
// single-season shows, a season with an unrated episode, float sums that only
// come out clean after the 2dp fold, and both sides of the aboveImdb test.
const DATA = {
  builtAt: '2026-05-14T08:00:00.000Z',
  // Stamped by build-data over everything but builtAt; the refresh workflow
  // compares it to decide whether anything actually changed, so it has to
  // reach the index intact.
  contentHash: '0123456789abcdef',
  minEpisodes: 3,
  minVotes: 5,
  count: 7,
  shapeCounts: { rising: 2 },
  genres: [{ name: 'Drama', count: 2 }],
  languages: [{ code: 'en', count: 3 }],
  providers: [{ name: 'Netflix', count: 1 }],
  matches: [
    // Two seasons, trending up. Episode-mean 8.0 vs a series rating of 7 -> above.
    { seriesId: 'tt0000010', title: 'Xray', year: 2018, language: 'en', season: 1,
      genres: ['Drama'], seriesRating: 7, seriesVotes: 100000, avgRating: 7.5, avgRuntime: 60,
      overview: 'Xray season one blurb',
      episodes: [{ episode: 1, rating: 7, votes: 100 }, { episode: 2, rating: 8, votes: 100 }] },
    { seriesId: 'tt0000010', title: 'Xray', year: 2018, language: 'en', season: 2,
      genres: ['Drama', 'Crime'], seriesRating: 7, seriesVotes: 100000, avgRating: 8.5, avgRuntime: 60,
      episodes: [{ episode: 1, rating: 8, votes: 100 }, { episode: 2, rating: 9, votes: 100 }] },

    // Single season: the only kind of show that gets epRatings, because its
    // card sparkline is drawn from episodes rather than season averages.
    { seriesId: 'tt0000011', title: 'Yankee', year: 2005, language: 'ja', season: 1,
      genres: ['Comedy'], seriesRating: 8, seriesVotes: 5000, avgRating: 6,
      overview: 'Yankee blurb',
      episodes: [{ episode: 1, rating: 6, votes: 50 }, { episode: 2, rating: 6, votes: 50 }] },

    // No rated episodes at all: survives the split, dropped by buildShowAgg.
    { seriesId: 'tt0000012', title: 'Zulu', year: 2020, language: 'en', season: 1,
      genres: [], seriesRating: 7.5, seriesVotes: 900,
      episodes: [{ episode: 1 }] },

    // 8.1 + 8.2 sums to 16.299999999999997 in binary floating point; the fold
    // rounds to 2dp so the shipped number is not 17 digits of noise.
    { seriesId: 'tt0000013', title: 'Whiskey', year: 2021, language: 'en', season: 1,
      genres: ['Drama'], seriesRating: 8, seriesVotes: 1200, avgRating: 8.15,
      episodes: [{ episode: 1, rating: 8.1, votes: 10 }, { episode: 2, rating: 8.2, votes: 10 }] },

    // Episode mean EQUALS the series rating: aboveImdb is a strict >.
    { seriesId: 'tt0000014', title: 'Victor', year: 2019, language: 'en', season: 1,
      genres: [], seriesRating: 8, seriesVotes: 700, avgRating: 8,
      episodes: [{ episode: 1, rating: 8, votes: 10 }, { episode: 2, rating: 8, votes: 10 }] },

    // One rated episode, one unrated: rated-only aggregates, full episodeCount.
    { seriesId: 'tt0000015', title: 'Uniform', year: 2022, language: 'en', season: 1,
      genres: [], seriesRating: 7, seriesVotes: 400, avgRating: 9,
      episodes: [{ episode: 1, rating: 9, votes: 10 }, { episode: 2, votes: 10 }] },
  ],
};

const SPLIT = runSplit(DATA);

// --- the contract buildShowAgg reads ---------------------------------------

test('split-data: index records carry the split fields buildShowAgg needs and none of the stripped ones', () => {
  for (const m of SPLIT.index.matches) {
    assert.equal('episodes' in m, false, `${m.seriesId} S${m.season} still ships episodes`);
    assert.equal('overview' in m, false, `${m.seriesId} S${m.season} still ships overview`);
    assert.equal(typeof m.episodeCount, 'number', `${m.seriesId} S${m.season} episodeCount`);
    assert.equal(typeof m.ratedCount, 'number', `${m.seriesId} S${m.season} ratedCount`);
    assert.equal(typeof m.ratingSum, 'number', `${m.seriesId} S${m.season} ratingSum`);
  }
});

test('split-data: the emitted index aggregates exactly like the unsplit data.json', () => {
  const full = buildShowAgg(DATA.matches, detectShapes);
  const split = buildShowAgg(SPLIT.index.matches, detectShapes);

  // Guard the guard: if episodes ever survived the split, buildShowAgg would
  // take its full-record branch and this comparison would prove nothing.
  assert.ok(SPLIT.index.matches.every((m) => !Array.isArray(m.episodes)), 'split records must have no episodes');

  assert.equal(split.length, full.length);
  const byId = (rows) => new Map(rows.map((r) => [r.seriesId, r]));
  const f = byId(full);
  const s = byId(split);
  for (const [id, fRow] of f) {
    const sRow = s.get(id);
    assert.ok(sRow, `${id} missing from the split aggregate`);
    assert.equal(sRow.episodes, fRow.episodes, `${id} episode count`);
    assert.equal(sRow.avgEpisode, fRow.avgEpisode, `${id} avgEpisode`);
    assert.equal(sRow.gap, fRow.gap, `${id} gap`);
    assert.equal(sRow.seasonsCount, fRow.seasonsCount, `${id} seasonsCount`);
    assert.equal(sRow.runtimeHrs, fRow.runtimeHrs, `${id} runtimeHrs`);
    assert.deepEqual(sRow.seasonAvgs, fRow.seasonAvgs, `${id} seasonAvgs`);
    assert.deepEqual(sRow.shapes, fRow.shapes, `${id} shapes`);
    assert.deepEqual(sRow.genres, fRow.genres, `${id} genres`);
  }
});

test('split-data: epRatings ships for single-season shows only, rated episodes only', () => {
  const bySeason = (id, season) => SPLIT.index.matches
    .find((m) => m.seriesId === id && m.season === season);

  // Single season -> the grid's sparkline source.
  assert.deepEqual(bySeason('tt0000011', 1).epRatings, [6, 6]);
  // Unrated episodes are skipped, so the curve has no holes in it.
  assert.deepEqual(bySeason('tt0000015', 1).epRatings, [9]);
  // Multi-season shows draw from season averages and must not carry it: an
  // empty-or-partial array here would draw a one-season sparkline on the card.
  assert.equal('epRatings' in bySeason('tt0000010', 1), false);
  assert.equal('epRatings' in bySeason('tt0000010', 2), false);
  // A season whose only episode is unrated still gets the (empty) key. Harmless
  // rather than a bug: buildShowAgg drops the row for having no rated episodes,
  // so nothing downstream ever plots it.
  assert.deepEqual(bySeason('tt0000012', 1).epRatings, []);
  assert.equal(buildShowAgg([bySeason('tt0000012', 1)], detectShapes).length, 0);
});

test('split-data: episodeCount counts every episode, ratedCount and ratingSum only rated ones', () => {
  const uniform = SPLIT.index.matches.find((m) => m.seriesId === 'tt0000015');
  assert.equal(uniform.episodeCount, 2);  // the minEpisodes filter counts listed episodes
  assert.equal(uniform.ratedCount, 1);
  assert.equal(uniform.ratingSum, 9);

  const zulu = SPLIT.index.matches.find((m) => m.seriesId === 'tt0000012');
  assert.equal(zulu.episodeCount, 1);
  assert.equal(zulu.ratedCount, 0);
  assert.equal(zulu.ratingSum, 0);
});

test('split-data: ratingSum is folded to 2dp, not raw float noise', () => {
  const whiskey = SPLIT.index.matches.find((m) => m.seriesId === 'tt0000013');
  assert.equal(whiskey.ratingSum, 16.3);
  // And it still divides back into the number the Finder prints.
  const [row] = buildShowAgg([whiskey], detectShapes);
  assert.equal(row.avgEpisode, 8.15);
  assert.equal(row.gap, 0.15);
});

// --- aboveImdb --------------------------------------------------------------

test('split-data: aboveImdb lists exactly the series whose episodes outscore the show, absent means false', () => {
  const above = new Set(SPLIT.index.aboveImdb);
  assert.ok(Array.isArray(SPLIT.index.aboveImdb), 'aboveImdb ships as a list');
  assert.equal(above.has('tt0000010'), true);  // mean 8.0 vs series 7
  assert.equal(above.has('tt0000013'), true);  // mean 8.15 vs series 8
  assert.equal(above.has('tt0000011'), false); // mean 6 vs series 8
  assert.equal(above.has('tt0000014'), false); // mean 8 vs series 8 - strict >, ties are not above
  assert.equal(above.has('tt0000012'), false); // no rated episodes to average
});

test('split-data: aboveImdb averages the rated episodes only', () => {
  // tt0000015 has one rated episode at 9.0 against a series rating of 7.0, so
  // its episodes plainly outscore its IMDb score and the badge shows.
  // Regression pin for the missing numeric guard: the fold used to sum
  // e.rating unconditionally, so the one unrated episode made the mean NaN
  // and silently dropped the series (NaN > x is false). Every rated-episode
  // fold - this one, ratedCount / ratingSum, buildShowAgg - now skips
  // unrated episodes the same way.
  assert.equal(SPLIT.index.aboveImdb.includes('tt0000015'), true);
});

// --- detail files -----------------------------------------------------------

test('split-data: one detail file per series, keyed by season, carrying the stripped fields', () => {
  assert.deepEqual(
    Object.keys(SPLIT.detail).sort(),
    ['tt0000010', 'tt0000011', 'tt0000012', 'tt0000013', 'tt0000014', 'tt0000015'],
  );
  const xray = SPLIT.detail.tt0000010;
  assert.deepEqual(Object.keys(xray.seasons).sort(), ['1', '2']);
  // app.js reads detail.seasons[String(m.season)].episodes / .overview.
  assert.deepEqual(xray.seasons['1'].episodes, DATA.matches[0].episodes);
  assert.equal(xray.seasons['1'].overview, 'Xray season one blurb');
  // Season 2 has no overview in the source, so the key stays off rather than
  // shipping a null the modal would have to special-case.
  assert.equal('overview' in xray.seasons['2'], false);
});

test('split-data: index plus detail rehydrates the original data.json record', () => {
  // The split is a transport optimisation, so it has to be lossless: the modal
  // renders per-episode tables from the rehydrated record.
  const rehydrated = SPLIT.index.matches.map((m) => {
    const { episodeCount, ratedCount, ratingSum, epRatings, ...rest } = m;
    const rec = SPLIT.detail[m.seriesId].seasons[String(m.season)];
    if (rec.episodes) rest.episodes = rec.episodes;
    if (rec.overview) rest.overview = rec.overview;
    return rest;
  });
  assert.deepEqual(rehydrated, DATA.matches);
});

// --- modal extras merged into detail files ----------------------------------
//
// When data/show-modal-extras.json is beside data.json (every deploy:
// fetch-data.js downloads it before split-data runs), each series' slice is
// merged into its detail file and the index announces it via extrasInDetail.
// That is what lets the app skip the ~67 MB monolith entirely: one small
// per-show fetch on modal open carries episodes, overviews, cast, and the
// per-episode id/runtime/title map.

const EXTRAS = {
  tt0000010: {
    cast: [{ id: 1, name: 'Alice Actor', character: 'Lead', profile_path: '/a.jpg' }],
    seasons: {
      1: { ov: 'Xray S1 season overview', eps: { 1: { tt: 'tt9000001', rt: 42, n: 'Pilot' } } },
      2: { eps: { 1: { tt: 'tt9000002' } } },
    },
  },
  // A series that only has cast, no season records.
  tt0000011: { cast: [{ id: 2, name: 'Bob Builder' }] },
  // A series in the extras file but not in data.json: must not create a file.
  tt9999999: { cast: [{ id: 3, name: 'Ghost' }] },
};

const EXTRAS_SPLIT = runSplit(DATA, EXTRAS);

test('split-data: with the extras file present, detail files carry cast, ov and eps', () => {
  const xray = EXTRAS_SPLIT.detail.tt0000010;
  assert.deepEqual(xray.cast, EXTRAS.tt0000010.cast);
  assert.equal(xray.seasons['1'].ov, 'Xray S1 season overview');
  assert.deepEqual(xray.seasons['1'].eps, { 1: { tt: 'tt9000001', rt: 42, n: 'Pilot' } });
  // The split fields still ride along untouched.
  assert.deepEqual(xray.seasons['1'].episodes, DATA.matches[0].episodes);
  assert.equal(xray.seasons['1'].overview, 'Xray season one blurb');
  // Season 2 has eps but no ov in the extras: only what exists is written.
  assert.deepEqual(xray.seasons['2'].eps, { 1: { tt: 'tt9000002' } });
  assert.equal('ov' in xray.seasons['2'], false);

  // Cast-only series: cast lands, seasons keep their plain split shape.
  const yankee = EXTRAS_SPLIT.detail.tt0000011;
  assert.deepEqual(yankee.cast, EXTRAS.tt0000011.cast);
  assert.equal('ov' in yankee.seasons['1'], false);
  assert.equal('eps' in yankee.seasons['1'], false);

  // No extras for this series at all: detail file identical to the plain run.
  assert.deepEqual(EXTRAS_SPLIT.detail.tt0000013, SPLIT.detail.tt0000013);

  // Extras for a series not in data.json never materialise a file.
  assert.equal('tt9999999' in EXTRAS_SPLIT.detail, false);
});

test('split-data: extrasInDetail flags the merge in the index, and only then', () => {
  // The flag is the app's contract: when set, it never fetches the monolith.
  assert.equal(EXTRAS_SPLIT.index.extrasInDetail, true);
  // Without the extras file the key is absent (not false), keeping the
  // no-extras output byte-identical to the pre-merge format.
  assert.equal('extrasInDetail' in SPLIT.index, false);
});

test('split-data: the merge changes nothing else in the index', () => {
  const a = { ...EXTRAS_SPLIT.index };
  const b = { ...SPLIT.index };
  delete a.extrasInDetail;
  delete a.splitAt;
  delete b.splitAt;
  assert.deepEqual(a, b);
});

test('split-data: re-running with extras present is idempotent too', () => {
  const first = fs.readFileSync(path.join(EXTRAS_SPLIT.appDir, 'data-index.json'), 'utf8');
  const firstDetail = fs.readFileSync(path.join(EXTRAS_SPLIT.detailDir, 'tt0000010.json'), 'utf8');
  execFileSync(process.execPath, [path.join(EXTRAS_SPLIT.appDir, 'scripts', 'split-data.js')], { encoding: 'utf8' });
  const second = JSON.parse(fs.readFileSync(path.join(EXTRAS_SPLIT.appDir, 'data-index.json'), 'utf8'));
  const firstParsed = JSON.parse(first);
  delete firstParsed.splitAt;
  const secondCopy = { ...second };
  delete secondCopy.splitAt;
  assert.deepEqual(secondCopy, firstParsed);
  assert.equal(fs.readFileSync(path.join(EXTRAS_SPLIT.detailDir, 'tt0000010.json'), 'utf8'), firstDetail);
});

// --- the file around the matches -------------------------------------------

test('split-data: every non-matches top-level field survives, plus a splitAt stamp', () => {
  const { matches, aboveImdb, splitAt, ...rest } = SPLIT.index;
  const { matches: _srcMatches, ...srcRest } = DATA;
  assert.deepEqual(rest, srcRest);
  assert.ok(!Number.isNaN(Date.parse(splitAt)), `splitAt should be an ISO timestamp, got ${splitAt}`);
});

test('split-data: data.json is left untouched so re-running never degrades its own input', () => {
  const src = fs.readFileSync(path.join(SPLIT.appDir, 'data.json'), 'utf8');
  assert.deepEqual(JSON.parse(src), DATA);
});

test('split-data: a series id that is not filename-safe is skipped, never written outside data/detail', () => {
  const out = runSplit({
    builtAt: '2026-05-14T08:00:00.000Z',
    count: 2,
    matches: [
      { seriesId: '../../escaped', title: 'Nope', season: 1, seriesRating: 7, seriesVotes: 10,
        avgRating: 8, episodes: [{ episode: 1, rating: 8, votes: 10 }] },
      { seriesId: 'tt0000020', title: 'Fine', season: 1, seriesRating: 7, seriesVotes: 10,
        avgRating: 8, episodes: [{ episode: 1, rating: 8, votes: 10 }] },
    ],
  });
  assert.deepEqual(fs.readdirSync(out.detailDir), ['tt0000020.json']);
  assert.equal(fs.existsSync(path.join(out.appDir, 'escaped.json')), false);
  assert.equal(fs.existsSync(path.join(out.appDir, '..', 'escaped.json')), false);
});

test('split-data: re-running over the same tree is idempotent', () => {
  // build:site runs the splitter after the page builders on every deploy; a
  // second pass must not fold the already-folded aggregates again.
  const first = fs.readFileSync(path.join(SPLIT.appDir, 'data-index.json'), 'utf8');
  execFileSync(process.execPath, [path.join(SPLIT.appDir, 'scripts', 'split-data.js')], { encoding: 'utf8' });
  const second = JSON.parse(fs.readFileSync(path.join(SPLIT.appDir, 'data-index.json'), 'utf8'));
  const firstParsed = JSON.parse(first);
  delete firstParsed.splitAt;
  const secondCopy = { ...second };
  delete secondCopy.splitAt;
  assert.deepEqual(secondCopy, firstParsed);
});

// --- in-progress seasons (D1) -----------------------------------------------

const AIRING_SPLIT = runSplit({
  builtAt: '2026-08-22T06:47:41.488Z',
  contentHash: 'fedcba9876543210',
  count: 4,
  matches: [1, 2, 3, 4].map((n) => ({
    seriesId: 'tt0000030',
    title: 'Still Airing',
    year: 2020,
    season: n,
    genres: ['Drama'],
    seriesRating: 7,
    seriesVotes: 50000,
    avgRating: [7.0, 7.1, 7.2, 8.5][n - 1],
    shapes: [],
    // Only the newest season is unfinished, and build-data omits the key
    // entirely on the rest.
    ...(n === 4 ? { inProgress: true } : {}),
    episodes: [
      { episode: 1, rating: [7.0, 7.1, 7.2, 8.5][n - 1], votes: 100 },
      { episode: 2, rating: [7.0, 7.1, 7.2, 8.5][n - 1], votes: 100 },
    ],
  })),
});

test('split-data: contentHash reaches the index so the refresh gate can read it', () => {
  assert.equal(SPLIT.index.contentHash, '0123456789abcdef');
  assert.equal(AIRING_SPLIT.index.contentHash, 'fedcba9876543210');
});

test('split-data: inProgress survives the split and still suppresses the show-level finale shape', () => {
  const seasons = AIRING_SPLIT.index.matches;
  assert.deepEqual(seasons.filter((m) => 'inProgress' in m).map((m) => m.season), [4]);
  assert.equal(seasons.find((m) => m.season === 4).inProgress, true);

  // The whole point of carrying it: 7.0 7.1 7.2 8.5 would read "big finale"
  // off a season that is four episodes deep.
  const [row] = buildShowAgg(seasons, detectShapes);
  assert.equal(row.shapes.includes('big-finale'), false);
  assert.ok(row.shapes.includes('rising'), 'the honest mid-run shapes still apply');
  // Same records with the flag cleared: the label comes back, so the test is
  // measuring the flag and not some other property of the fixture.
  const finished = seasons.map(({ inProgress, ...rest }) => rest);
  assert.ok(buildShowAgg(finished, detectShapes)[0].shapes.includes('big-finale'));

  // Detail files are episodes/overview only; the flag has no business there.
  assert.deepEqual(Object.keys(AIRING_SPLIT.detail.tt0000030.seasons['4']), ['episodes']);
});
