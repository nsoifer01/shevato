'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FINDER_DEFAULTS,
  buildShowAgg,
  CATEGORICAL_SHAPES,
  parseFinderQuery,
  passesFinderFilters,
  passesShapeAnd,
  finderComparator,
  filterAndSortRows,
} = require('../scripts/finder-lib.js');
const {
  buildFinderCollection,
  describeFinderFilters,
  finderShareUrl,
} = require('../scripts/integrations-lib.js');

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

test('buildShowAgg carries categorical season tags up to the show', () => {
  assert.deepEqual(CATEGORICAL_SHAPES, ['saved-best-for-last', 'shape-drift']);
  const matches = [
    // Two-season riser whose finale season is tagged saved-best-for-last:
    // the tag must append after the trajectory shapes.
    { seriesId: 'tt0000030', title: 'Tagged', year: 2020, language: 'en', season: 1,
      genres: [], seriesRating: 7, seriesVotes: 1000, avgRuntime: 60, shapes: ['rising'],
      episodes: [{ episode: 1, rating: 7, votes: 100 }] },
    { seriesId: 'tt0000030', title: 'Tagged', year: 2020, language: 'en', season: 2,
      genres: [], seriesRating: 7, seriesVotes: 1000, avgRuntime: 60,
      shapes: ['big-finale', 'saved-best-for-last'],
      episodes: [{ episode: 1, rating: 8, votes: 100 }] },
    // Single-season show: no cross-season trajectory, but the categorical
    // tag still applies at the show level.
    { seriesId: 'tt0000031', title: 'Drifter', year: 2021, language: 'en', season: 1,
      genres: [], seriesRating: 7, seriesVotes: 1000, avgRuntime: 60, shapes: ['shape-drift'],
      episodes: [{ episode: 1, rating: 7, votes: 100 }] },
  ];
  const rows = buildShowAgg(matches, stubDetectShapes);
  const tagged = rows.find((r) => r.seriesId === 'tt0000030');
  assert.deepEqual(tagged.shapes, ['rising', 'saved-best-for-last']);
  const drifter = rows.find((r) => r.seriesId === 'tt0000031');
  assert.deepEqual(drifter.shapes, ['shape-drift']);
  // The #shape= filter path used by the hub CTAs matches on the carried tag.
  assert.equal(passesShapeAnd(tagged, new Set(['saved-best-for-last'])), true);
  assert.equal(passesShapeAnd(drifter, new Set(['shape-drift'])), true);
  assert.equal(passesShapeAnd(tagged, new Set(['shape-drift'])), false);
});

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
    '#q=foo&shape=rising,rebound&minVotes=50000&minEps=10' +
    '&minShow=7&minAvg=7.5&gapDir=up&minGap=0.5&minYear=2010&maxYear=2020' +
    '&genres=Drama&xgenres=Reality-TV&langs=en,ja&sort=gap&dir=asc&view=list&page=3',
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

test('parseFinderQuery: legacy f-prefixed hash parses identically to the clean one', () => {
  // A pre-rename shared link, verbatim: every param in its old spelling.
  const legacy = parseFinderQuery(
    '#q=foo&fShape=rising,rebound&fMinVotes=50000&fMinEps=10' +
    '&fMinShow=7&fMinAvg=7.5&fGapDir=up&fMinGap=0.5&fMinYear=2010&fMaxYear=2020' +
    '&fg=Drama&fxg=Reality-TV&fl=en,ja&fSort=gap&fDir=asc&fView=list&page=3',
  );
  const clean = parseFinderQuery(
    '#q=foo&shape=rising,rebound&minVotes=50000&minEps=10' +
    '&minShow=7&minAvg=7.5&gapDir=up&minGap=0.5&minYear=2010&maxYear=2020' +
    '&genres=Drama&xgenres=Reality-TV&langs=en,ja&sort=gap&dir=asc&view=list&page=3',
  );
  assert.deepEqual(legacy, clean);
});

test('parseFinderQuery: clean name wins when both spellings are present', () => {
  const f = parseFinderQuery('minVotes=100&fMinVotes=999&sort=gap&fSort=title');
  assert.equal(f.minVotes, 100);
  assert.equal(f.sort, 'gap');
});

test('parseFinderQuery: legacy view=finder does not shadow fView', () => {
  // Pre-rename links carried BOTH view=finder (the retired view selector) and
  // fView=list (the layout). The retired selector must not eat the layout.
  assert.equal(parseFinderQuery('view=finder&fView=list').view, 'list');
  assert.equal(parseFinderQuery('view=list').view, 'list');
  assert.equal(parseFinderQuery('view=finder').view, 'grid');
});

test('parseFinderQuery: empty/garbage/legacy queries fall back to inactive defaults', () => {
  // 'view=finder' is the legacy always-on hash key: old bookmarks that still
  // carry it must parse as a plain default finder.
  for (const q of ['', 'view=finder', 'gapDir=sideways&minVotes=lots&page=-2']) {
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

  assert.ok(passesFinderFilters(x, parseFinderQuery('minVotes=50000')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('minVotes=50000')));

  assert.ok(passesFinderFilters(x, parseFinderQuery('minYear=2010&maxYear=2019')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('minYear=2010')));

  assert.ok(passesFinderFilters(x, parseFinderQuery('genres=Drama,Crime')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('genres=Drama')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('xgenres=Crime')));

  assert.ok(passesFinderFilters(y, parseFinderQuery('langs=ja')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('langs=ja')));

  // Gap direction: X has +1, Y has -2.
  assert.ok(passesFinderFilters(x, parseFinderQuery('gapDir=up&minGap=0.5')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('gapDir=down')));
  assert.ok(passesFinderFilters(y, parseFinderQuery('gapDir=down&minGap=1')));
  assert.ok(!passesFinderFilters(y, parseFinderQuery('gapDir=down&minGap=3')));
  // Directionless magnitude.
  assert.ok(passesFinderFilters(y, parseFinderQuery('minGap=1.5')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('minGap=1.5')));

  // Search matches title or IMDb id, case-insensitive.
  assert.ok(passesFinderFilters(x, parseFinderQuery('q=xRaY')));
  assert.ok(passesFinderFilters(x, parseFinderQuery('q=tt0000010')));
  assert.ok(!passesFinderFilters(x, parseFinderQuery('q=yankee')));
});

test('parseFinderQuery reads the hidden-gems flag', () => {
  assert.equal(parseFinderQuery('gems=on').hiddenGems, true);
  assert.equal(parseFinderQuery('gems=off').hiddenGems, false);
  assert.equal(parseFinderQuery('').hiddenGems, false);
});

test('passesFinderFilters hidden gems: high rating AND low votes-per-episode', () => {
  const base = {
    title: 'x', seriesId: 'tt', genres: [], shapes: [], gap: 0,
    showRating: 8, year: 2020, language: 'en',
  };
  const on = parseFinderQuery('gems=on');

  // Qualifies: avg 8.6 (>= 8.5), 4000/10 = 400 votes/ep (< 500).
  assert.ok(passesFinderFilters({ ...base, avgEpisode: 8.6, episodes: 10, votes: 4000 }, on));
  // Fails the rating condition: avg 8.4 < 8.5.
  assert.ok(!passesFinderFilters({ ...base, avgEpisode: 8.4, episodes: 10, votes: 4000 }, on));
  // Fails the popularity condition: 6000/10 = 600 votes/ep >= 500.
  assert.ok(!passesFinderFilters({ ...base, avgEpisode: 8.6, episodes: 10, votes: 6000 }, on));
  // Boundaries: exactly 8.5 avg passes; exactly 500 votes/ep is excluded.
  assert.ok(passesFinderFilters({ ...base, avgEpisode: 8.5, episodes: 10, votes: 4990 }, on));
  assert.ok(!passesFinderFilters({ ...base, avgEpisode: 8.5, episodes: 10, votes: 5000 }, on));
  // Flag off: an over-watched popular show passes.
  assert.ok(passesFinderFilters({ ...base, avgEpisode: 8.6, episodes: 10, votes: 6000 }, parseFinderQuery('')));
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
  const out = filterAndSortRows(rows, parseFinderQuery('shape=rising&minVotes=1000'));
  assert.deepEqual(out.map((r) => r.seriesId), ['tt0000010']);
});

test('buildFinderCollection renders YAML with ID fallbacks', () => {
  const preset = {
    slug: 'demo',
    name: 'Demo: List',
    summary: 'A "demo" list',
    query: 'minVotes=1000',
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
  // Summary = curated blurb, then the filter digest, then a Finder link, joined
  // by \n escapes (yamlString renders real newlines as a literal \n).
  assert.match(y, /^ {4}summary: "A \\"demo\\" list\\nFilters: /m);
  assert.match(y, /\\nFilters: 1,000\+ votes\\n/);
  assert.match(y, /\\nExplore on Rising Shows: https:\/\/shevato\.com\/apps\/rising-shows\/#minVotes=1000"$/m);
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

test('describeFinderFilters renders thresholds and omits genre + language', () => {
  // genre (xgenres) and language (langs) are present in the query but must NOT appear.
  const q = 'sort=showRating&minEps=12&minVotes=25000'
    + '&minShow=7.5&minYear=1980&xgenres=Animation%2CNews&langs=en&shape=consistent';
  assert.equal(
    describeFinderFilters(q),
    '12+ episodes · 25,000+ votes · show IMDb 7.5+ · since 1980 · shape: Consistent · sorted by show rating',
  );
  // Legacy f-prefixed spellings (a user preset copied from a pre-rename Finder
  // URL) must produce the same digest.
  const legacy = 'fSort=showRating&fMinEps=12&fMinVotes=25000'
    + '&fMinShow=7.5&fMinYear=1980&fxg=Animation%2CNews&fl=en&fShape=consistent';
  assert.equal(describeFinderFilters(legacy), describeFinderFilters(q));
});

test('describeFinderFilters handles gap direction, episode avg, and a year range', () => {
  const q = 'sort=gap&minAvg=8&gapDir=up&minGap=0.3&minYear=2000&maxYear=2010';
  assert.equal(
    describeFinderFilters(q),
    'episode avg 8+ · episodes beat the show by 0.3+ · 2000-2010 · sorted by gap size',
  );
});

test('describeFinderFilters is empty when only genre/language (or nothing) is set', () => {
  assert.equal(describeFinderFilters(''), '');
  assert.equal(describeFinderFilters('xgenres=Animation&langs=en'), '');
});

test('finderShareUrl builds a Finder hash link and tolerates a leading #', () => {
  assert.equal(
    finderShareUrl('shape=consistent'),
    'https://shevato.com/apps/rising-shows/#shape=consistent',
  );
  assert.equal(finderShareUrl('#minVotes=25000'), 'https://shevato.com/apps/rising-shows/#minVotes=25000');
});

test('buildFinderCollection emits the local template hook when declared', () => {
  const preset = {
    slug: 'demo',
    name: 'Demo',
    query: 'minVotes=1000',
    template: { name: 'rs_local', file: 'config/rising-shows-local.yml' },
  };
  const y = buildFinderCollection(preset, [{ seriesId: 'tt1', tmdbId: 101 }]).contents;
  assert.match(y, /^external_templates:\n {2}- file: config\/rising-shows-local\.yml$/m);
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

// ---------------------------------------------------------------------------
// Split-payload support.
//
// The browser no longer receives per-episode arrays: scripts/split-data.js
// strips them (40% of data.json) into per-show detail files fetched when a
// modal opens, and folds the aggregates buildShowAgg needs into ratedCount /
// ratingSum, plus epRatings for single-season shows whose card sparkline is
// drawn from episodes rather than season averages.
//
// The Node side (build-show-pages.js, export-integrations.js, these tests)
// still reads the unsplit data.json, so buildShowAgg has to accept BOTH shapes
// and produce the same answer. These pin exactly that.
// ---------------------------------------------------------------------------

/** Mirrors what split-data.js emits for one season record. */
function splitOf(m, seasonsInSeries) {
  const { episodes, overview, ...rest } = m;
  const eps = episodes || [];
  let ratedCount = 0;
  let ratingSum = 0;
  for (const e of eps) {
    if (typeof e.rating === 'number') { ratedCount++; ratingSum += e.rating; }
  }
  rest.episodeCount = eps.length;
  rest.ratedCount = ratedCount;
  rest.ratingSum = Math.round(ratingSum * 100) / 100;
  if (seasonsInSeries === 1 && eps.length) {
    rest.epRatings = eps.filter((e) => typeof e.rating === 'number').map((e) => e.rating);
  }
  return rest;
}

const MULTI = [
  { seriesId: 'ttA', title: 'Multi', year: 2010, season: 1, seriesRating: 8.0, seriesVotes: 5000,
    avgRating: 7.0, genres: ['Drama'], language: 'en', shapes: [],
    episodes: [{ episode: 1, rating: 6.8, votes: 10 }, { episode: 2, rating: 7.2, votes: 12 }] },
  { seriesId: 'ttA', title: 'Multi', year: 2010, season: 2, seriesRating: 8.0, seriesVotes: 5000,
    avgRating: 9.0, genres: ['Drama'], language: 'en', shapes: [],
    episodes: [{ episode: 1, rating: 8.9, votes: 11 }, { episode: 2, rating: 9.1, votes: 13 }] },
];

const SINGLE = [
  { seriesId: 'ttB', title: 'Single', year: 2012, season: 1, seriesRating: 7.5, seriesVotes: 900,
    avgRating: 8.0, genres: ['Comedy'], language: 'en', shapes: [],
    episodes: [{ episode: 1, rating: 7.5, votes: 5 }, { episode: 2, rating: 8.5, votes: 6 }] },
];

test('buildShowAgg: split records produce the same aggregates as full records', () => {
  const full = buildShowAgg([...MULTI, ...SINGLE], null);
  const split = buildShowAgg(
    [...MULTI.map((m) => splitOf(m, 2)), ...SINGLE.map((m) => splitOf(m, 1))],
    null,
  );
  assert.equal(split.length, full.length);
  const byId = (rows) => new Map(rows.map((r) => [r.seriesId, r]));
  const f = byId(full);
  const s = byId(split);
  for (const id of f.keys()) {
    assert.equal(s.get(id).episodes, f.get(id).episodes, `${id} episode count`);
    assert.equal(s.get(id).avgEpisode, f.get(id).avgEpisode, `${id} avgEpisode`);
    assert.equal(s.get(id).gap, f.get(id).gap, `${id} gap`);
    assert.deepEqual(s.get(id).seasonAvgs, f.get(id).seasonAvgs, `${id} seasonAvgs`);
  }
});

test('buildShowAgg: epRatings rebuilds the sparkline series for single-season shows', () => {
  const [row] = buildShowAgg(SINGLE.map((m) => splitOf(m, 1)), null);
  // episodeSeries is what drawFinderSpark plots when a show has one season.
  assert.equal(row.episodeSeries.length, 2);
  assert.deepEqual(row.episodeSeries.map((e) => e.rating), [7.5, 8.5]);
  // Episode numbers are positional in the split form; votes are not carried
  // because the sparkline never reads them.
  assert.deepEqual(row.episodeSeries.map((e) => e.episode), [1, 2]);
});

test('buildShowAgg: multi-season split rows carry no episodeSeries', () => {
  const [row] = buildShowAgg(MULTI.map((m) => splitOf(m, 2)), null);
  // Only single-season shows get epRatings, so this must stay undefined
  // rather than becoming an empty array that draws a blank sparkline.
  assert.equal(row.episodeSeries, undefined);
});

test('buildShowAgg: a split row with no rated episodes is dropped, as before', () => {
  const empty = splitOf(
    { seriesId: 'ttC', title: 'Empty', year: 2000, season: 1, seriesRating: 5, seriesVotes: 10,
      genres: [], language: 'en', shapes: [], episodes: [] }, 1,
  );
  assert.equal(buildShowAgg([empty], null).length, 0);
});

// ---------------------------------------------------------------------------
// Whole-show trajectory when the newest season has not finished airing (D1).
//
// deriveShowShapes feeds per-season AVERAGES to the same detectors match.js
// runs per episode. If the newest season is four episodes deep, its average is
// not the show's last word, so the three finale-dependent shapes must not be
// derived from it. The season stays in seasonAvgs (the card sparkline and the
// season list still draw it); only the finale claim is withheld.
// ---------------------------------------------------------------------------

const { deriveShowShapes } = require('../scripts/finder-lib.js');
const { detectShapes: realDetectShapes } = require('../scripts/match.js');

test('deriveShowShapes keeps its 3-argument call signature working', () => {
  // render-show-page.js calls it with three arguments; an omitted options
  // object must mean "the show has finished", the pre-2026 behaviour.
  const shapes = deriveShowShapes([7.0, 7.1, 7.2, 8.5], new Set(), realDetectShapes);
  assert.ok(shapes.includes('big-finale'));
});

test('deriveShowShapes withholds the finale shapes when the newest season is airing', () => {
  const avgs = [7.0, 7.1, 7.2, 8.5];
  const airing = deriveShowShapes(avgs, new Set(), realDetectShapes, { inProgress: true });
  assert.equal(airing.includes('big-finale'), false);
  assert.ok(airing.includes('rising'), 'the honest cross-season shapes still apply');

  const badFinale = [8.6, 8.7, 8.5, 7.4];
  assert.ok(deriveShowShapes(badFinale, new Set(), realDetectShapes).includes('bad-finale'));
  assert.equal(
    deriveShowShapes(badFinale, new Set(), realDetectShapes, { inProgress: true }).includes('bad-finale'),
    false,
  );
});

test('buildShowAgg reads inProgress off the highest-numbered season, whatever order rows arrive in', () => {
  const seasonRow = (season, avg, extra = {}) => ({
    seriesId: 'ttAir', title: 'Airer', year: 2020, language: 'en', season,
    genres: ['Drama'], seriesRating: 7, seriesVotes: 50000, avgRating: avg, shapes: [],
    episodes: [{ episode: 1, rating: avg, votes: 100 }, { episode: 2, rating: avg, votes: 100 }],
    ...extra,
  });
  // Season 4 last in the array would be the easy case; data.json is sorted by
  // vote count, so it arrives anywhere.
  const rows = [
    seasonRow(4, 8.5, { inProgress: true }),
    seasonRow(1, 7.0),
    seasonRow(3, 7.2),
    seasonRow(2, 7.1),
  ];
  const [row] = buildShowAgg(rows, realDetectShapes);
  assert.equal(row.shapes.includes('big-finale'), false);
  // The partial season is still in the data the card draws.
  assert.deepEqual(row.seasonAvgs.map((s) => s.avg), [7.0, 7.1, 7.2, 8.5]);

  // A flag on an EARLIER season says nothing about the show's trajectory.
  const staleFlag = [seasonRow(1, 7.0, { inProgress: true }), seasonRow(2, 7.1), seasonRow(3, 7.2), seasonRow(4, 8.5)];
  assert.ok(buildShowAgg(staleFlag, realDetectShapes)[0].shapes.includes('big-finale'));
});

// --- defensive folds --------------------------------------------------------

test('buildShowAgg ignores a non-numeric ratingSum instead of poisoning the series fold', () => {
  // `ratingSum || 0` accepted a string, and one string turns every downstream
  // += into concatenation: the show's avgEpisode and gap become garbage for
  // the whole series, not just that season.
  const rows = [
    { seriesId: 'ttNum', title: 'Numbers', year: 2015, season: 1, seriesRating: 7, seriesVotes: 900,
      genres: [], shapes: [], avgRating: 8, ratedCount: 2, ratingSum: 16 },
    { seriesId: 'ttNum', title: 'Numbers', year: 2015, season: 2, seriesRating: 7, seriesVotes: 900,
      genres: [], shapes: [], avgRating: 8, ratedCount: '2', ratingSum: '16' },
  ];
  const [row] = buildShowAgg(rows, null);
  assert.equal(row.episodes, 2);
  assert.equal(row.avgEpisode, 8);
  assert.equal(Number.isFinite(row.gap), true);
});

test('finderComparator falls back to votes when the sort key is not numeric on the rows', () => {
  // `sort` comes straight out of the URL hash, so any string can reach this.
  const rows = [
    { title: 'A', votes: 10, year: 2000 },
    { title: 'B', votes: 30, year: 2001 },
    { title: 'C', votes: 20, year: 2002 },
  ];
  // Without the guard the comparator returns NaN for every pair and the order
  // is whatever the engine happens to do. With it, every pair falls through to
  // the votes tie-break, whose direction follows sortDir exactly as it does
  // for any other tie.
  assert.deepEqual(
    rows.slice().sort(finderComparator('nonsense', 'asc')).map((r) => r.title),
    ['B', 'C', 'A'],
  );
  assert.deepEqual(
    rows.slice().sort(finderComparator('nonsense', 'desc')).map((r) => r.title),
    ['A', 'C', 'B'],
  );
});

test('passesFinderFilters folds diacritics when the caller precomputes the folded strings', () => {
  const base = { ...FINDER_DEFAULTS, genres: new Set(), genresExclude: new Set(), languages: new Set(), shapes: new Set() };
  const row = {
    seriesId: 'tt0000040', title: 'Pokémon', titleFold: 'pokemon',
    episodes: 100, seasonsCount: 5, votes: 1000, showRating: 8, avgEpisode: 8, gap: 0,
    year: 1997, genres: [], language: 'ja',
  };
  // Browser path: app.js hands over the folded query and the folded title.
  assert.equal(passesFinderFilters(row, { ...base, search: 'pokemon', searchFold: 'pokemon' }), true);
  // Node path (export pipeline, these tests): no folded fields, plain compare,
  // exactly as before - an ASCII query does not reach an accented title.
  const plain = { ...row };
  delete plain.titleFold;
  assert.equal(passesFinderFilters(plain, { ...base, search: 'pokemon' }), false);
  assert.equal(passesFinderFilters(plain, { ...base, search: 'pokémon' }), true);
  // The IMDb id stays an unfolded, plain-lowercase match either way.
  assert.equal(passesFinderFilters(row, { ...base, search: 'TT0000040', searchFold: 'tt0000040' }), true);
});
