'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FINDER_DEFAULTS,
  buildShowAgg,
  parseFinderQuery,
  passesFinderFilters,
  passesShapeAnd,
  finderComparator,
  filterAndSortRows,
} = require('../scripts/finder-lib.js');
const { buildFinderCollection } = require('../scripts/integrations-lib.js');

// Deterministic stand-in for match.js detectShapes: a curve is "rising" when
// every point meets or exceeds the previous one. Enough to verify the wiring
// without re-testing the real classifiers (match.test.js owns those).
function stubDetectShapes(eps) {
  const rising = eps.every((e, i, a) => i === 0 || e.rating >= a[i - 1].rating);
  return rising ? ['rising'] : [];
}

// Season-level fixture in data.json `matches` shape.
const MATCHES = [
  // Show X - two seasons trending up. Carries both external IDs (on the
  // second record only, to prove ID pickup isn't first-record-dependent).
  { seriesId: 'tt0000010', title: 'Xray', year: 2018, language: 'en', season: 1,
    genres: ['Drama'], seriesRating: 7, seriesVotes: 100000, avgRuntime: 60,
    episodes: [{ episode: 1, rating: 7, votes: 100 }, { episode: 2, rating: 8, votes: 100 }] },
  { seriesId: 'tt0000010', title: 'Xray', year: 2018, language: 'en', season: 2,
    tmdbId: 11, tvdbId: 21,
    genres: ['Drama', 'Crime'], seriesRating: 7, seriesVotes: 100000, avgRuntime: 60,
    episodes: [{ episode: 1, rating: 8, votes: 100 }, { episode: 2, rating: 9, votes: 100 }] },

  // Show Y - single season, episodes rate below the show. TVDB ID only.
  { seriesId: 'tt0000011', title: 'Yankee', year: 2005, language: 'ja', season: 1,
    tvdbId: 22,
    genres: ['Comedy'], seriesRating: 8, seriesVotes: 5000,
    episodes: [{ episode: 1, rating: 6, votes: 50 }, { episode: 2, rating: 6, votes: 50 }] },

  // Show Z - no rated episodes: dropped from the aggregate.
  { seriesId: 'tt0000012', title: 'Zulu', year: 2020, language: 'en', season: 1,
    genres: [], seriesRating: 7.5, seriesVotes: 900,
    episodes: [{ episode: 1 }] },

  // Show W - missing series rating: dropped from the aggregate.
  { seriesId: 'tt0000013', title: 'Whiskey', year: 2021, language: 'en', season: 1,
    genres: [], seriesVotes: 1200,
    episodes: [{ episode: 1, rating: 7, votes: 10 }] },
];

test('buildShowAgg aggregates seasons into show rows', () => {
  const rows = buildShowAgg(MATCHES, stubDetectShapes);
  assert.equal(rows.length, 2); // Z and W dropped

  const x = rows.find((r) => r.seriesId === 'tt0000010');
  assert.equal(x.seasonsCount, 2);
  assert.equal(x.episodes, 4);
  assert.equal(x.avgEpisode, 8);    // (7+8+8+9)/4
  assert.equal(x.gap, 1);           // 8 - 7
  assert.deepEqual(x.genres, ['Crime', 'Drama']);
  assert.equal(x.tmdbId, 11);       // picked up from the 2nd season record
  assert.equal(x.tvdbId, 21);
  assert.deepEqual(x.shapes, ['rising']);
  assert.equal(x.episodeSeries, undefined); // multi-season → no episode curve

  const y = rows.find((r) => r.seriesId === 'tt0000011');
  assert.equal(y.gap, -2);
  assert.equal(y.tmdbId, null);
  assert.equal(y.tvdbId, 22);
  assert.deepEqual(y.shapes, []);   // single season → no cross-season shape
  assert.equal(y.episodeSeries.length, 2); // single season keeps its curve
});

test('parseFinderQuery: full hash round-trips into a filter object', () => {
  const f = parseFinderQuery(
    '#view=finder&q=foo&fShape=rising,rebound&fMinVotes=50000&fMinEps=10' +
    '&fMinShow=7&fMinAvg=7.5&fGapDir=up&fMinGap=0.5&fMinYear=2010&fMaxYear=2020' +
    '&fg=Drama&fxg=Reality-TV&fl=en,ja&fSort=gap&fDir=asc&fView=list&page=3',
  );
  assert.equal(f.search, 'foo');
  assert.deepEqual([...f.shapes].sort(), ['rebound', 'rising']);
  assert.equal(f.minVotes, 50000);
  assert.equal(f.minEpisodes, 10);
  assert.equal(f.minShowRating, 7);
  assert.equal(f.minAvgEpisode, 7.5);
  assert.equal(f.gapDir, 'up');
  assert.equal(f.minGap, 0.5);
  assert.equal(f.minYear, 2010);
  assert.equal(f.maxYear, 2020);
  assert.deepEqual([...f.genres], ['Drama']);
  assert.deepEqual([...f.genresExclude], ['Reality-TV']);
  assert.deepEqual([...f.languages].sort(), ['en', 'ja']);
  assert.equal(f.sort, 'gap');
  assert.equal(f.sortDir, 'asc');
  assert.equal(f.view, 'list');
  assert.equal(f.page, 3);
});

test('parseFinderQuery: empty/garbage queries fall back to inactive defaults', () => {
  for (const q of ['', 'view=finder', 'fGapDir=sideways&fMinVotes=lots&page=-2']) {
    const f = parseFinderQuery(q);
    for (const [k, v] of Object.entries(FINDER_DEFAULTS)) {
      assert.deepEqual(f[k], v, `default for ${k} on query "${q}"`);
    }
    assert.equal(f.genres.size + f.genresExclude.size + f.languages.size + f.shapes.size, 0);
  }
});

test('passesFinderFilters applies every non-shape filter', () => {
  const rows = buildShowAgg(MATCHES, stubDetectShapes);
  const x = rows.find((r) => r.seriesId === 'tt0000010');
  const y = rows.find((r) => r.seriesId === 'tt0000011');

  assert.ok(passesFinderFilters(x, parseFinderQuery('fMinVotes=50000')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('fMinVotes=50000')));

  assert.ok(passesFinderFilters(x, parseFinderQuery('fMinYear=2010&fMaxYear=2019')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('fMinYear=2010')));

  assert.ok(passesFinderFilters(x, parseFinderQuery('fg=Drama,Crime')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('fg=Drama')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('fxg=Crime')));

  assert.ok(passesFinderFilters(y, parseFinderQuery('fl=ja')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('fl=ja')));

  // Gap direction: X has +1, Y has -2.
  assert.ok(passesFinderFilters(x, parseFinderQuery('fGapDir=up&fMinGap=0.5')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('fGapDir=down')));
  assert.ok(passesFinderFilters(y, parseFinderQuery('fGapDir=down&fMinGap=1')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('fGapDir=down&fMinGap=3')));
  // Directionless magnitude.
  assert.ok(passesFinderFilters(y, parseFinderQuery('fMinGap=1.5')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('fMinGap=1.5')));

  // Search matches title or IMDb id, case-insensitive.
  assert.ok(passesFinderFilters(x, parseFinderQuery('q=xRaY')));
  assert.ok(passesFinderFilters(x, parseFinderQuery('q=tt0000010')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('q=yankee')));
});

test('passesShapeAnd requires every selected shape', () => {
  const row = { shapes: ['rising', 'slow-burn'] };
  assert.ok(passesShapeAnd(row, new Set()));
  assert.ok(passesShapeAnd(row, new Set(['rising'])));
  assert.ok(passesShapeAnd(row, new Set(['rising', 'slow-burn'])));
  assert.ok(!passesShapeAnd(row, new Set(['rising', 'rebound'])));
});

test('finderComparator: direction, title sort, year-null sinking, vote tiebreak', () => {
  const a = { title: 'AAA', votes: 10, year: 2020, gap: 1 };
  const b = { title: 'BBB', votes: 99, year: null, gap: 1 };
  const c = { title: 'CCC', votes: 50, year: 2010, gap: 2 };

  assert.deepEqual([a, b, c].sort(finderComparator('votes', 'desc')).map((r) => r.title), ['BBB', 'CCC', 'AAA']);
  assert.deepEqual([b, c, a].sort(finderComparator('title', 'asc')).map((r) => r.title), ['AAA', 'BBB', 'CCC']);
  // Unknown year sinks regardless of direction.
  assert.equal([a, b, c].sort(finderComparator('year', 'desc')).at(-1).title, 'BBB');
  assert.equal([a, b, c].sort(finderComparator('year', 'asc')).at(-1).title, 'BBB');
  // Equal gap → votes break the tie. The tiebreak inherits the sort
  // direction (matches the browser Finder exactly): on desc, lower-vote
  // rows come first among equals.
  assert.deepEqual([a, b].sort(finderComparator('gap', 'desc')).map((r) => r.title), ['AAA', 'BBB']);
  assert.deepEqual([a, b].sort(finderComparator('gap', 'asc')).map((r) => r.title), ['BBB', 'AAA']);
});

test('filterAndSortRows replays a preset query end to end', () => {
  const rows = buildShowAgg(MATCHES, stubDetectShapes);
  const out = filterAndSortRows(rows, parseFinderQuery('fShape=rising&fMinVotes=1000'));
  assert.deepEqual(out.map((r) => r.seriesId), ['tt0000010']);
});

test('buildFinderCollection renders YAML with ID fallbacks', () => {
  const preset = {
    slug: 'demo',
    name: 'Demo: List',
    summary: 'A "demo" list',
    query: 'fMinVotes=1000',
  };
  const rows = [
    { seriesId: 'tt1', tmdbId: 101, tvdbId: 201 },   // prefers tmdb
    { seriesId: 'tt2', tmdbId: null, tvdbId: 202 },  // falls back to tvdb
    { seriesId: 'tt3', tmdbId: null, tvdbId: null }, // falls back to imdb
  ];
  const col = buildFinderCollection(preset, rows, { matched: 120, limit: 3 });
  assert.equal(col.filename, 'finder-demo.yml');
  assert.equal(col.seriesCount, 3);
  const y = col.contents;
  assert.match(y, /^ {2}"Demo: List":$/m);
  assert.match(y, /^ {4}summary: "A \\"demo\\" list"$/m);
  // `!000_` prefix floats finder collections ahead of everything in Plex.
  assert.match(y, /^ {4}sort_title: "!000_rsf_demo"$/m);
  assert.match(y, /^ {4}sync_mode: sync$/m);
  // A multi-ID builder list = one builder per ID, so `custom` (single-builder
  // only) would make Kometa reject the collection. release is the safe order.
  assert.match(y, /^ {4}collection_order: release$/m);
  assert.doesNotMatch(y, /collection_order: (custom|alpha)/);
  assert.match(y, /^ {4}tmdb_show:\n {6}- 101$/m);
  assert.match(y, /^ {4}tvdb_show:\n {6}- 202$/m);
  assert.match(y, /^ {4}imdb_id:\n {6}- tt3$/m);
  assert.match(y, /# Matched 120 shows; emitting top 3 \(limit 3\)\./);
  // No template declared → no external reference emitted.
  assert.doesNotMatch(y, /external_templates/);
  assert.doesNotMatch(y, /^ {4}template:/m);
});

test('buildFinderCollection emits the local template hook when declared', () => {
  const preset = {
    slug: 'demo',
    name: 'Demo',
    query: 'fMinVotes=1000',
    template: { name: 'rs_local', file: 'config/rising-seasons-local.yml' },
  };
  const y = buildFinderCollection(preset, [{ seriesId: 'tt1', tmdbId: 101 }]).contents;
  assert.match(y, /^external_templates:\n {2}- file: config\/rising-seasons-local\.yml$/m);
  assert.match(y, /^ {4}template: \{name: rs_local\}$/m);
  // Template reference comes before the collection's own attributes.
  assert.ok(y.indexOf('external_templates:') < y.indexOf('collections:'));

  // A template without a usable source (or without a name) is ignored.
  const noSrc = buildFinderCollection(
    { ...preset, template: { name: 'rs_local' } },
    [{ seriesId: 'tt1', tmdbId: 101 }],
  ).contents;
  assert.doesNotMatch(noSrc, /external_templates/);
  const noName = buildFinderCollection(
    { ...preset, template: { file: 'config/x.yml' } },
    [{ seriesId: 'tt1', tmdbId: 101 }],
  ).contents;
  assert.doesNotMatch(noName, /external_templates/);
});

test('buildFinderCollection returns null when no row has a usable ID', () => {
  assert.equal(buildFinderCollection({ slug: 's', name: 'n', query: '' }, []), null);
  assert.equal(buildFinderCollection({ slug: 's', name: 'n', query: '' }, [{ seriesId: null }]), null);
});
