'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  COLLECTION_SHAPES,
  SHAPE_META,
  buildKometaCollections,
  buildSeasonOverlays,
  buildIdLists,
  yamlString,
  bestConfidenceForShape,
} = require('../scripts/integrations-lib.js');

// Tiny fixture covering: high/low confidence, missing ID variants, dedupe of
// the same series across multiple shapes, and shapes the export should drop
// entirely when no series clear the floor.
const FIXTURE = [
  // Show A — strong slow-burn S1, strong big-finale S2. Has both IDs.
  { seriesId: 'tt0000001', title: 'Alpha', season: 1, tmdbId: 1001, tvdbId: 2001, seasonTvdbId: 9001,
    shapes: ['slow-burn'], confidence: { 'slow-burn': 0.9 }, avgRating: 8.5 },
  { seriesId: 'tt0000001', title: 'Alpha', season: 2, tmdbId: 1001, tvdbId: 2001, seasonTvdbId: 9002,
    shapes: ['big-finale'], confidence: { 'big-finale': 0.7 }, avgRating: 8.9 },

  // Show B — strong rebound, only TMDB ID. seasonTvdbId missing — should
  // appear in collection (tmdb_show) but NOT in overlay output.
  { seriesId: 'tt0000002', title: 'Beta', season: 1, tmdbId: 1002, tvdbId: null,
    shapes: ['rebound'], confidence: { 'rebound': 0.8 }, avgRating: 8.1 },

  // Show C — weak slow-burn, below floor. Should be dropped everywhere.
  { seriesId: 'tt0000003', title: 'Gamma', season: 1, tmdbId: 1003, tvdbId: 2003, seasonTvdbId: 9003,
    shapes: ['slow-burn'], confidence: { 'slow-burn': 0.10 }, avgRating: 7.0 },

  // Show D — strong big-finale, only TVDB ID. Tests tvdb_show fallback.
  { seriesId: 'tt0000004', title: 'Delta', season: 1, tmdbId: null, tvdbId: 2004, seasonTvdbId: 9004,
    shapes: ['big-finale'], confidence: { 'big-finale': 0.85 }, avgRating: 9.0 },

  // Show E — strong big-finale, gives big-finale 3 series total (meets minSeries=3).
  { seriesId: 'tt0000005', title: 'Epsilon', season: 1, tmdbId: 1005, tvdbId: 2005, seasonTvdbId: 9005,
    shapes: ['big-finale'], confidence: { 'big-finale': 0.55 }, avgRating: 8.3 },

  // Show F — declining, only 1 series for this shape so collection should drop.
  { seriesId: 'tt0000006', title: 'Zeta', season: 1, tmdbId: 1006, tvdbId: 2006, seasonTvdbId: 9006,
    shapes: ['declining'], confidence: { 'declining': 0.9 }, avgRating: 6.0 },

  // Show G — no IDs at all (TMDB enrichment didn't run for it). Should be
  // dropped from every export.
  { seriesId: 'tt0000007', title: 'Eta', season: 1, tmdbId: null, tvdbId: null,
    shapes: ['rising'], confidence: { 'rising': 0.9 }, avgRating: 9.5 },
];

test('SHAPE_META has metadata for every collection shape', () => {
  for (const s of COLLECTION_SHAPES) {
    assert.ok(SHAPE_META[s], `missing SHAPE_META for ${s}`);
    assert.ok(SHAPE_META[s].title.length > 0);
    assert.ok(SHAPE_META[s].badge.length > 0);
    assert.ok(SHAPE_META[s].blurb.length > 10);
  }
});

test('yamlString escapes quotes and backslashes', () => {
  assert.equal(yamlString('plain'), '"plain"');
  assert.equal(yamlString('with "quote"'), '"with \\"quote\\""');
  assert.equal(yamlString('back\\slash'), '"back\\\\slash"');
});

test('bestConfidenceForShape dedupes by series, keeping max confidence', () => {
  const fixture = [
    { seriesId: 'tt1', title: 'X', tmdbId: 1, season: 1, shapes: ['slow-burn'], confidence: { 'slow-burn': 0.4 } },
    { seriesId: 'tt1', title: 'X', tmdbId: 1, season: 2, shapes: ['slow-burn'], confidence: { 'slow-burn': 0.9 } },
    { seriesId: 'tt2', title: 'Y', tmdbId: 2, season: 1, shapes: ['slow-burn'], confidence: { 'slow-burn': 0.5 } },
  ];
  const got = bestConfidenceForShape(fixture, 'slow-burn');
  assert.equal(got.length, 2);
  const x = got.find((g) => g.seriesId === 'tt1');
  assert.equal(x.conf, 0.9);
});

// --- Kometa collections ---

test('buildKometaCollections drops shapes below minSeries', () => {
  const collections = buildKometaCollections(FIXTURE, {
    confidenceFloor: 0.35, minSeries: 3,
  });
  const shapes = collections.map((c) => c.shape).sort();
  // Only big-finale has 3 qualifying series in the fixture.
  assert.deepEqual(shapes, ['big-finale']);
});

test('buildKometaCollections applies confidence floor', () => {
  const collections = buildKometaCollections(FIXTURE, {
    confidenceFloor: 0.35, minSeries: 1,
  });
  const slowBurn = collections.find((c) => c.shape === 'slow-burn');
  // Alpha qualifies (0.9). Gamma (0.1) is below floor.
  assert.ok(slowBurn, 'expected slow-burn collection');
  assert.equal(slowBurn.seriesCount, 1);
  assert.ok(slowBurn.contents.includes('1001'), 'should include Alpha tmdbId');
  assert.ok(!slowBurn.contents.includes('1003'), 'should NOT include Gamma');
});

test('buildKometaCollections uses tvdb_show when tmdbId is missing', () => {
  const collections = buildKometaCollections(FIXTURE, {
    confidenceFloor: 0.35, minSeries: 1,
  });
  const bigFinale = collections.find((c) => c.shape === 'big-finale');
  assert.ok(bigFinale);
  assert.ok(bigFinale.contents.includes('tmdb_show:'));
  assert.ok(bigFinale.contents.includes('tvdb_show:'));
  assert.ok(bigFinale.contents.includes('2004'), 'Delta tvdbId should appear');
  assert.ok(bigFinale.contents.includes('1001') && bigFinale.contents.includes('1005'), 'Alpha and Epsilon tmdbIds should appear');
});

test('buildKometaCollections drops series with no TMDB/TVDB IDs', () => {
  const collections = buildKometaCollections(FIXTURE, {
    confidenceFloor: 0.35, minSeries: 1,
  });
  for (const c of collections) {
    assert.ok(!c.contents.includes('tt0000007'), 'Eta should not appear (no IDs)');
  }
});

test('buildKometaCollections output parses as valid YAML structure', () => {
  const collections = buildKometaCollections(FIXTURE, {
    confidenceFloor: 0.35, minSeries: 1,
  });
  for (const c of collections) {
    const lines = c.contents.split('\n');
    // Header comments, then 'collections:'.
    const collectionsLine = lines.findIndex((l) => l === 'collections:');
    assert.ok(collectionsLine >= 0, `${c.filename} missing 'collections:'`);
    // Title line should be indented two spaces and end with colon.
    const titleLine = lines[collectionsLine + 1];
    assert.match(titleLine, /^ {2}[^ ].*:$/);
    // Should reference exactly one of tmdb_show or tvdb_show (or both).
    assert.ok(c.contents.includes('tmdb_show:') || c.contents.includes('tvdb_show:'));
  }
});

// --- season overlays ---

test('buildSeasonOverlays emits seasonTvdbIds above the confidence floor', () => {
  const overlays = buildSeasonOverlays(FIXTURE, { confidenceFloor: 0.35 });
  // Gamma is below floor.
  assert.ok(!overlays.contents.includes('9003'), 'Gamma seasonTvdbId should not appear');
  // Alpha S1 and S2 should appear.
  assert.ok(overlays.contents.includes('9001'), 'Alpha S1 seasonTvdbId');
  assert.ok(overlays.contents.includes('9002'), 'Alpha S2 seasonTvdbId');
});

test('buildSeasonOverlays groups by shape and uses text() badge', () => {
  const overlays = buildSeasonOverlays(FIXTURE, { confidenceFloor: 0.35 });
  assert.ok(overlays.contents.includes('text(BURN)'), 'slow-burn badge');
  assert.ok(overlays.contents.includes('text(FINALE)'), 'big-finale badge');
  assert.ok(overlays.contents.includes('builder_level: season'));
  assert.ok(overlays.contents.includes('tvdb_season:'));
});

test('buildSeasonOverlays skips records without seasonTvdbId', () => {
  // Beta has no seasonTvdbId in fixture, so its rebound shouldn't appear.
  const fx = FIXTURE.map((m) => ({ ...m }));
  const beta = fx.find((m) => m.title === 'Beta');
  delete beta.seasonTvdbId;
  const overlays = buildSeasonOverlays(fx, { confidenceFloor: 0.35 });
  // Beta is the only rebound — so the rebound block should be skipped entirely.
  assert.ok(!overlays.contents.includes('RS Rebound Seasons:'), 'no rebound block when no IDs');
});

// --- ID lists ---

test('buildIdLists writes one IMDb ID per qualifying series per shape', () => {
  const lists = buildIdLists(FIXTURE, { confidenceFloor: 0.35 });
  const slowBurn = lists.find((l) => l.shape === 'slow-burn');
  assert.ok(slowBurn);
  const lines = slowBurn.contents.trim().split('\n');
  assert.deepEqual(lines, ['tt0000001']);
  const bigFinale = lists.find((l) => l.shape === 'big-finale');
  const bfLines = bigFinale.contents.trim().split('\n').sort();
  assert.deepEqual(bfLines, ['tt0000001', 'tt0000004', 'tt0000005']);
});

test('buildIdLists omits shapes with no qualifying series', () => {
  const lists = buildIdLists(FIXTURE, { confidenceFloor: 0.99 });
  // At 0.99 floor, only Alpha S1 (0.9 slow-burn) and 0.9 declining/Eta clear it.
  // Actually 0.9 < 0.99, so no shape should clear → empty array.
  assert.deepEqual(lists, []);
});

test('buildIdLists dedupes a series that has multiple seasons of the same shape', () => {
  const fx = [
    { seriesId: 'tt9', title: 'X', tmdbId: 9, tvdbId: 9, season: 1,
      shapes: ['slow-burn'], confidence: { 'slow-burn': 0.9 } },
    { seriesId: 'tt9', title: 'X', tmdbId: 9, tvdbId: 9, season: 2,
      shapes: ['slow-burn'], confidence: { 'slow-burn': 0.6 } },
  ];
  const lists = buildIdLists(fx, { confidenceFloor: 0.35 });
  const sb = lists.find((l) => l.shape === 'slow-burn');
  assert.equal(sb.contents.trim(), 'tt9');
});
