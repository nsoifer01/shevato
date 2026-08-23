'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  COLLECTION_SHAPES,
  SHAPE_META,
  buildKometaCollections,
  buildCompareCollection,
  buildSeasonOverlays,
  buildIdLists,
  yamlString,
  bestConfidenceForShape,
  compareCollectionName,
  shapeConfidence,
} = require('../scripts/integrations-lib.js');

// Tiny fixture covering: high/low confidence, missing ID variants, dedupe of
// the same series across multiple shapes, and shapes the export should drop
// entirely when no series clear the floor.
const FIXTURE = [
  // Show A - strong slow-burn S1, strong big-finale S2. Has both IDs.
  { seriesId: 'tt0000001', title: 'Alpha', season: 1, tmdbId: 1001, tvdbId: 2001, seasonTvdbId: 9001,
    shapes: ['slow-burn'], confidence: { 'slow-burn': 0.9 }, avgRating: 8.5 },
  { seriesId: 'tt0000001', title: 'Alpha', season: 2, tmdbId: 1001, tvdbId: 2001, seasonTvdbId: 9002,
    shapes: ['big-finale'], confidence: { 'big-finale': 0.7 }, avgRating: 8.9 },

  // Show B - strong rebound, only TMDB ID. seasonTvdbId missing - should
  // appear in collection (tmdb_show) but NOT in overlay output.
  { seriesId: 'tt0000002', title: 'Beta', season: 1, tmdbId: 1002, tvdbId: null,
    shapes: ['rebound'], confidence: { 'rebound': 0.8 }, avgRating: 8.1 },

  // Show C - weak slow-burn, below floor. Should be dropped everywhere.
  { seriesId: 'tt0000003', title: 'Gamma', season: 1, tmdbId: 1003, tvdbId: 2003, seasonTvdbId: 9003,
    shapes: ['slow-burn'], confidence: { 'slow-burn': 0.10 }, avgRating: 7.0 },

  // Show D - strong big-finale, only TVDB ID. Tests tvdb_show fallback.
  { seriesId: 'tt0000004', title: 'Delta', season: 1, tmdbId: null, tvdbId: 2004, seasonTvdbId: 9004,
    shapes: ['big-finale'], confidence: { 'big-finale': 0.85 }, avgRating: 9.0 },

  // Show E - strong big-finale, gives big-finale 3 series total (meets minSeries=3).
  { seriesId: 'tt0000005', title: 'Epsilon', season: 1, tmdbId: 1005, tvdbId: 2005, seasonTvdbId: 9005,
    shapes: ['big-finale'], confidence: { 'big-finale': 0.55 }, avgRating: 8.3 },

  // Show F - declining, only 1 series for this shape so collection should drop.
  { seriesId: 'tt0000006', title: 'Zeta', season: 1, tmdbId: 1006, tvdbId: 2006, seasonTvdbId: 9006,
    shapes: ['declining'], confidence: { 'declining': 0.9 }, avgRating: 6.0 },

  // Show G - no IDs at all (TMDB enrichment didn't run for it). Should be
  // dropped from every export.
  { seriesId: 'tt0000007', title: 'Eta', season: 1, tmdbId: null, tvdbId: null,
    shapes: ['rising'], confidence: { 'rising': 0.9 }, avgRating: 9.5 },
];

test('SHAPE_META has metadata for every collection shape', () => {
  // These three strings are not decoration: `title` is emitted as a YAML
  // mapping key (`  ${title}:` in a collection file, `  RS ${title}:` in the
  // overlay file), `badge` goes inside Kometa's `text(...)` overlay call, and
  // `blurb` becomes the collection summary. A stray colon or paren silently
  // produces a YAML file Kometa rejects, and a duplicate title or badge merges
  // two collections into one.
  const titles = new Set();
  const badges = new Set();
  for (const s of COLLECTION_SHAPES) {
    assert.ok(SHAPE_META[s], `missing SHAPE_META for ${s}`);
    const { title, badge, blurb } = SHAPE_META[s];

    assert.equal(title, title.trim(), `${s}: title must not be padded, it is a YAML key`);
    assert.ok(!/[:#\n]/.test(title), `${s}: title "${title}" needs quoting as a YAML key`);
    assert.equal(titles.has(title), false, `${s}: duplicate collection title "${title}"`);
    titles.add(title);

    // Rendered onto a season poster, so it has to be short as well as safe.
    assert.ok(/^[A-Z][A-Z+]{0,7}$/.test(badge), `${s}: badge "${badge}" should be a short upper-case tag`);
    assert.equal(badges.has(badge), false, `${s}: duplicate overlay badge "${badge}"`);
    badges.add(badge);

    assert.ok(blurb.length > 10 && blurb.endsWith('.'), `${s}: blurb should be a sentence, got "${blurb}"`);
    assert.ok(!blurb.includes('\n'), `${s}: blurb must stay on one YAML line`);
  }
});

test('SHAPE_META strings are what actually lands in the generated YAML', () => {
  const matches = COLLECTION_SHAPES.flatMap((shape, i) => [1, 2, 3].map((n) => ({
    seriesId: `tt${i}${n}`, title: `Show ${i}${n}`, season: 1,
    tmdbId: 1000 + i * 10 + n, tvdbId: 2000 + i * 10 + n, seasonTvdbId: 9000 + i * 10 + n,
    shapes: [shape], confidence: { [shape]: 0.9 }, avgRating: 8,
  })));
  const collections = buildKometaCollections(matches, { minSeries: 3 });
  const overlays = buildSeasonOverlays(matches);
  assert.equal(collections.length, COLLECTION_SHAPES.length);
  for (const shape of COLLECTION_SHAPES) {
    const meta = SHAPE_META[shape];
    const file = collections.find((c) => c.shape === shape);
    assert.ok(file.contents.includes(`\n  ${meta.title}:\n`), `${shape}: collection key`);
    assert.ok(file.contents.includes(`    summary: ${yamlString(meta.blurb)}\n`), `${shape}: summary`);
    assert.ok(overlays.contents.includes(`\n  RS ${meta.title}:\n`), `${shape}: overlay key`);
    assert.ok(overlays.contents.includes(`      name: text(${meta.badge})\n`), `${shape}: overlay badge`);
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
  // Beta is the only rebound - so the rebound block should be skipped entirely.
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

// --- compare-set collection ---
// The compare modal hands this whatever the user hand-picked, so it has to
// tolerate shows that never got enriched with external IDs and still name the
// collection after something a Plex user recognises.

const COMPARE_SET = [
  { seriesId: 'tt0000001', title: 'Alpha', tmdbId: 1001, tvdbId: 2001 },
  { seriesId: 'tt0000004', title: 'Delta', tmdbId: null, tvdbId: 2004 },
  { seriesId: 'tt0000009', title: 'Iota', tmdbId: null, tvdbId: null },
];

test('buildCompareCollection emits exactly the compared shows that have IDs', () => {
  const file = buildCompareCollection(COMPARE_SET);
  assert.equal(file.seriesCount, 2, 'the ID-less show is not counted');
  assert.match(file.contents, /tmdb_show:\n {6}- 1001\n/);
  assert.match(file.contents, /tvdb_show:\n {6}- 2004\n/);
  assert.ok(!/null|undefined/.test(file.contents), 'never emits a null/undefined list entry');
  assert.equal(file.filename, 'rising-shows-compare.yml');
});

test('buildCompareCollection prefers tmdb_show and never lists a show twice', () => {
  const file = buildCompareCollection([
    { seriesId: 'tt1', title: 'A', tmdbId: 11, tvdbId: 21 },
    { seriesId: 'tt2', title: 'B', tmdbId: 12, tvdbId: 22 },
  ]);
  assert.ok(file.contents.includes('    tmdb_show:\n      - 11\n      - 12\n'));
  assert.ok(!file.contents.includes('tvdb_show'), 'tvdb is the fallback, not a duplicate');
});

test('buildCompareCollection returns null when no compared show has an ID', () => {
  assert.equal(buildCompareCollection([{ seriesId: 'tt9', title: 'Solo' }]), null);
  assert.equal(buildCompareCollection([]), null);
});

test('buildCompareCollection links back to the full compare set, including ID-less shows', () => {
  const file = buildCompareCollection(COMPARE_SET);
  assert.ok(
    file.contents.includes('#compare=tt0000001,tt0000004,tt0000009'),
    'the on-site permalink covers everything the user compared',
  );
});

test('buildCompareCollection quotes a name containing YAML punctuation', () => {
  const file = buildCompareCollection([
    { seriesId: 'tt1', title: 'Star Wars: Andor', tmdbId: 1 },
    { seriesId: 'tt2', title: 'Fargo', tmdbId: 2 },
  ]);
  assert.ok(file.contents.includes('  "Star Wars: Andor vs Fargo":'));
});

test('compareCollectionName stays identifiable at every set size', () => {
  assert.equal(compareCollectionName(['Alpha']), 'Alpha');
  assert.equal(compareCollectionName(['Alpha', 'Beta']), 'Alpha vs Beta');
  assert.equal(
    compareCollectionName(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']),
    'Alpha, Beta + 3 more',
  );
});

test('compareCollectionName clips a very long title instead of running on', () => {
  const long = 'The Extremely Long Television Programme Title';
  const name = compareCollectionName([long, 'Beta']);
  assert.ok(name.length < long.length + 10, `expected a clipped name, got ${name}`);
  assert.ok(name.endsWith(' vs Beta'));
  assert.ok(name.startsWith('The Extremely Long Televisi…'));
});

// --- Header count vs emitted IDs (D26) ---
//
// The header, the exports/README table and the file itself all read the same
// number, so a reader can trust it. They used to disagree: rebound's header
// claimed 4,225 series while the file listed 3,985 IDs, because candidates with
// no usable ID were dropped after the count was taken and 458 TMDB ids are
// shared by more than one IMDb series.

function idsIn(contents) {
  return contents
    .split('\n')
    .filter((l) => /^ {6}- \d+$/.test(l))
    .map((l) => l.trim().slice(2));
}

test('the Series count header equals the number of IDs the file lists', () => {
  const collections = buildKometaCollections(FIXTURE, { confidenceFloor: 0.35, minSeries: 1 });
  assert.ok(collections.length > 0);
  for (const c of collections) {
    const ids = idsIn(c.contents);
    const header = c.contents.match(/Series count: (\d+)\./);
    assert.ok(header, `${c.filename} has no Series count header`);
    assert.equal(Number(header[1]), ids.length, `${c.filename} header vs listed IDs`);
    assert.equal(c.seriesCount, ids.length, `${c.filename} seriesCount vs listed IDs`);
  }
});

test('the count excludes qualifying series that carry no usable ID', () => {
  // Eta (tt0000007) is a 0.9-confidence rising series with neither ID, and it
  // is the only other rising entry, so rising must count 1, not 2.
  const withIdless = FIXTURE.concat([{
    seriesId: 'tt0000008', title: 'Theta', season: 1, tmdbId: 1008, tvdbId: 2008,
    shapes: ['rising'], confidence: { rising: 0.9 }, avgRating: 8.0,
  }]);
  const rising = buildKometaCollections(withIdless, { confidenceFloor: 0.35, minSeries: 1 })
    .find((c) => c.shape === 'rising');
  assert.ok(rising);
  assert.equal(rising.qualifyingCount, 2, 'both series qualify on confidence');
  assert.equal(rising.seriesCount, 1, 'only one of them can be emitted');
  assert.deepEqual(idsIn(rising.contents), ['1008']);
});

test('a TMDB id shared by two IMDb series is listed once', () => {
  // tmdb 1920 belongs to both Twin Peaks entries in the live dataset; 458 ids
  // are shared this way, which put 27 duplicate tmdb_show lines in rebound.yml.
  const shared = [
    { seriesId: 'tt1000001', title: 'Twin Peaks', season: 1, tmdbId: 1920, tvdbId: null,
      shapes: ['rising'], confidence: { rising: 0.9 }, avgRating: 9.0 },
    { seriesId: 'tt1000002', title: 'Twin Peaks (2017)', season: 1, tmdbId: 1920, tvdbId: null,
      shapes: ['rising'], confidence: { rising: 0.8 }, avgRating: 8.5 },
    { seriesId: 'tt1000003', title: 'Other', season: 1, tmdbId: 1921, tvdbId: null,
      shapes: ['rising'], confidence: { rising: 0.7 }, avgRating: 8.0 },
  ];
  const rising = buildKometaCollections(shared, { confidenceFloor: 0.35, minSeries: 1 })
    .find((c) => c.shape === 'rising');
  assert.deepEqual(idsIn(rising.contents), ['1920', '1921']);
  assert.equal(rising.seriesCount, 2);
  assert.equal(rising.qualifyingCount, 3);
});

// --- shapeConfidence is the shared definition (D26) ---
//
// scripts/watch-next.js used to read m.confidence[shape] directly, which is 0
// for the two categorical tags because their detector is a yes/no with no
// margin to record. Both sat permanently under the default 0.35 floor, so
// `--shape saved-best-for-last` and `--shape shape-drift` could never return a
// row no matter what was in the Plex library.
test('shapeConfidence scores categorical tags 1.0, not 0', () => {
  const tagged = { shapes: ['saved-best-for-last', 'shape-drift'], confidence: {} };
  assert.equal(shapeConfidence(tagged, 'saved-best-for-last'), 1.0);
  assert.equal(shapeConfidence(tagged, 'shape-drift'), 1.0);
  // A season with no confidence object at all still scores the tag.
  assert.equal(shapeConfidence({ shapes: ['shape-drift'] }, 'shape-drift'), 1.0);
  // ...and the tag still has to be present.
  assert.equal(shapeConfidence({ shapes: ['rising'], confidence: {} }, 'shape-drift'), 0);
  // Graded shapes keep their measured value.
  assert.equal(shapeConfidence({ shapes: ['rising'], confidence: { rising: 0.42 } }, 'rising'), 0.42);
});
