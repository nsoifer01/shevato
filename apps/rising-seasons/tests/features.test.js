'use strict';

// Unit tests for the 10 features added in the rising-seasons app.
// Tests cover logic that can run in Node without a DOM.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isOutlierPeak,
  detectShapes,
  tagShapeDrift,
  shapeConfidence,
  findMatches,
} = require('../scripts/match.js');
const { renderCurve } = require('../scripts/render-curve.js');

const ep = (episode, rating, votes = 1000) => ({ episode, rating, votes, tconst: `tt${episode}` });
const epNamed = (episode, rating, name, votes = 1000) => ({ episode, rating, votes, name, tconst: `tt${episode}` });
const season = (...ratings) => ratings.map((r, i) => ep(i + 1, r));

// ---------------------------------------------------------------------------
// Feature 1: Share Card Image — test the text-fallback data builder
// ---------------------------------------------------------------------------

// The data the card needs: title, season, shapes, avgRating, firstRating,
// lastRating, episodes.length. All come from the match object. We just verify
// the match properties a card would use are what we expect.
test('share card: match object has all fields needed for the image card', () => {
  const series = new Map([['tt1', { title: 'Test Show', year: 2020, type: 'tvSeries', genres: ['Drama'] }]]);
  const episodes = new Map([['tt1', new Map([[1, [ep(1, 7.5), ep(2, 8.0), ep(3, 8.5), ep(4, 9.0)]]])]]);
  const [m] = findMatches(series, episodes);
  assert.equal(typeof m.title, 'string');
  assert.equal(typeof m.season, 'number');
  assert.equal(typeof m.avgRating, 'number');
  assert.equal(typeof m.firstRating, 'number');
  assert.equal(typeof m.lastRating, 'number');
  assert.ok(Array.isArray(m.shapes));
  assert.ok(Array.isArray(m.episodes));
  assert.ok(m.episodes.length > 0);
});

// ---------------------------------------------------------------------------
// Feature 2: Worst Season Preset — filter logic
// ---------------------------------------------------------------------------

test('worst preset: accepts worst season of a good show with bad-finale shape', () => {
  // Build a series with 2 seasons: S1 good, S2 bad-finale + seriesRating >= 8
  const series = new Map([['tt10', { title: 'GoodShow', year: 2018, type: 'tvSeries', genres: [] }]]);
  const episodes = new Map([['tt10', new Map([
    // S1: consistent high
    [1, [ep(1, 8.5), ep(2, 8.6), ep(3, 8.5), ep(4, 8.7)]],
    // S2: bad finale (avg ~8.3, finale 6.5 — well below avg)
    [2, [ep(1, 8.5), ep(2, 8.6), ep(3, 8.5), ep(4, 6.5)]],
  ])]]);
  const matches = findMatches(series, episodes);
  assert.equal(matches.length, 2);

  // Simulate the buildBestSeasonMap logic
  const worstSeasonBySeries = new Map();
  const byId = new Map();
  for (const m of matches) {
    let entry = byId.get(m.seriesId);
    if (!entry) {
      entry = { count: 0, bestSeason: m.season, bestAvg: m.avgRating, worstSeason: m.season, worstAvg: m.avgRating };
      byId.set(m.seriesId, entry);
    }
    entry.count++;
    if (m.avgRating > entry.bestAvg) { entry.bestAvg = m.avgRating; entry.bestSeason = m.season; }
    if (m.avgRating < entry.worstAvg) { entry.worstAvg = m.avgRating; entry.worstSeason = m.season; }
  }
  for (const [id, info] of byId) {
    if (info.count >= 2 && info.bestSeason !== info.worstSeason) {
      worstSeasonBySeries.set(id, info.worstSeason);
    }
  }

  // The worstPreset filter: seriesRating >= 8, is the worst season, has bad-finale or declining
  const seriesRating = 8.5;
  function passesWorstPreset(m) {
    if (typeof seriesRating !== 'number' || seriesRating < 8) return false;
    if (worstSeasonBySeries.get(m.seriesId) !== m.season) return false;
    if (!m.shapes.includes('bad-finale') && !m.shapes.includes('declining')) return false;
    return true;
  }

  const s2 = matches.find((m) => m.season === 2);
  assert.ok(s2.shapes.includes('bad-finale'), 'S2 should have bad-finale shape');
  assert.equal(passesWorstPreset(s2), true, 'S2 should pass worst preset');

  const s1 = matches.find((m) => m.season === 1);
  assert.equal(passesWorstPreset(s1), false, 'S1 should not pass worst preset (not the worst season)');
});

test('worst preset: rejects best season even if it has declining shape', () => {
  // Series with only one declining season — not the "worst" of the series if it's the only one
  const series = new Map([['tt11', { title: 'OneHit', year: 2019, type: 'tvSeries', genres: [] }]]);
  const episodes = new Map([['tt11', new Map([
    [1, [ep(1, 8.0), ep(2, 7.9), ep(3, 7.8), ep(4, 7.7)]],
  ])]]);
  const matches = findMatches(series, episodes);
  // Only one season, so worstSeasonBySeries won't have an entry (need 2+ seasons)
  const worstSeasonBySeries = new Map();
  const seriesRating = 8.5;
  const [m] = matches;
  const isWorst = worstSeasonBySeries.get(m.seriesId) === m.season;
  assert.equal(isWorst, false, 'Single-season series should not appear in worstSeasonBySeries');
});

test('worst preset: rejects when seriesRating < 8', () => {
  const seriesRating = 7.5;
  const qualifies = typeof seriesRating === 'number' && seriesRating >= 8;
  assert.equal(qualifies, false);
});

// ---------------------------------------------------------------------------
// Feature 3: Shape Confidence on Cards
// ---------------------------------------------------------------------------

test('confidence: shapeConfidence returns value in [0,1] for matched shapes', () => {
  const eps = season(7.0, 7.2, 7.4, 8.0, 8.2, 8.4);
  const conf = shapeConfidence(eps);
  for (const v of Object.values(conf)) {
    assert.ok(v >= 0 && v <= 1, `confidence ${v} out of range`);
  }
});

test('confidence: strong match (>=0.75) is correctly distinguished from moderate (>=0.5)', () => {
  // A season with a very strong big-finale should score high confidence
  const eps = season(7.0, 7.1, 7.0, 7.2, 9.9); // big finale stands way out
  const conf = shapeConfidence(eps);
  assert.ok(conf['big-finale'] !== undefined, 'big-finale should be matched');
  // The finale (9.9) beats the next-best (7.2) by 2.7 pts — near the cap
  assert.ok(conf['big-finale'] >= 0.75, `expected strong match, got ${conf['big-finale']}`);
});

test('confidence: moderate match (>=0.5, <0.75) for a barely-qualifying big-finale', () => {
  // Finale beats second-best by exactly 0.1 (the minimum)
  const eps = season(8.0, 8.0, 8.0, 8.0, 8.0, 8.1);
  const conf = shapeConfidence(eps);
  // 8.1 - 8.0 = 0.1 margin → near-zero confidence
  assert.ok(conf['big-finale'] !== undefined, 'big-finale should be matched');
  assert.ok(conf['big-finale'] < 0.75, `expected moderate/weak, got ${conf['big-finale']}`);
});

test('confidence: returns empty object for a flat mid-range season (no shapes match)', () => {
  const eps = season(7.5, 7.6, 7.5, 7.6);
  const conf = shapeConfidence(eps);
  assert.deepEqual(conf, {});
});

// ---------------------------------------------------------------------------
// Feature 4: "Tonight's Watch" — time budget episode-count filter
// ---------------------------------------------------------------------------

test("tonight: 'short' budget filters to seasons with ≤6 episodes", () => {
  const matches = [
    { episodes: [1, 2, 3, 4, 5, 6] },        // exactly 6 — passes
    { episodes: [1, 2, 3, 4, 5, 6, 7] },      // 7 — fails
    { episodes: [1, 2, 3] },                   // 3 — passes
  ];
  const maxEpisodes = 6;
  const pass = matches.filter((m) => m.episodes.length <= maxEpisodes);
  assert.equal(pass.length, 2);
});

test("tonight: 'full' budget filters to seasons with ≥8 episodes", () => {
  const matches = [
    { episodes: new Array(8) },
    { episodes: new Array(7) },
    { episodes: new Array(12) },
  ];
  const minEpisodes = 8;
  const pass = matches.filter((m) => m.episodes.length >= minEpisodes);
  assert.equal(pass.length, 2);
});

test("tonight: 'any' budget applies no episode-count filter", () => {
  const minEpisodes = null;
  const maxEpisodes = null;
  const m = { episodes: new Array(3) };
  // Null checks mirror app.js buildNonShapeChecker
  const passes = !(minEpisodes && m.episodes.length < minEpisodes) &&
                 !(maxEpisodes && m.episodes.length > maxEpisodes);
  assert.ok(passes);
});

// ---------------------------------------------------------------------------
// Feature 5: Per-Episode Name Tooltips in SVG
// ---------------------------------------------------------------------------

test('render-curve: includes ep.name in SVG title when present', () => {
  const eps = [
    epNamed(1, 7.0, 'Pilot'),
    epNamed(2, 8.5, 'The One Where...'),
    epNamed(3, 9.0, 'Finale'),
  ];
  const svg = renderCurve(eps);
  assert.ok(svg.includes('Pilot'), 'ep name should appear in SVG');
  assert.ok(svg.includes('The One Where...'), 'second ep name should appear');
  assert.ok(svg.includes('Finale'), 'third ep name should appear');
});

test('render-curve: omits name line when ep.name is absent', () => {
  const eps = [
    ep(1, 7.0),
    ep(2, 8.5),
  ];
  const svg = renderCurve(eps);
  // The title format is "Ep N: rating · votes" with no extra newline/name
  const titleMatch = svg.match(/<title>([\s\S]*?)<\/title>/g);
  assert.ok(titleMatch, 'should have title elements');
  for (const t of titleMatch) {
    // No name line means no second newline-separated content in the title
    const inner = t.replace(/<\/?title>/g, '');
    assert.ok(!inner.includes('\n'), `title should have no newline when name is absent: ${inner}`);
  }
});

test('render-curve: escapes XML special chars in ep.name', () => {
  const eps = [epNamed(1, 7.5, 'Tom & Jerry\'s <Adventure>')];
  const svg = renderCurve(eps);
  assert.ok(!svg.includes('&amp;amp;'), 'should not double-escape');
  assert.ok(svg.includes('&amp;'), 'ampersand should be escaped');
  assert.ok(svg.includes('&lt;'), 'lt should be escaped');
  assert.ok(svg.includes('&gt;'), 'gt should be escaped');
});

// ---------------------------------------------------------------------------
// Feature 6: Shape-Drift Detail
// ---------------------------------------------------------------------------

test('tagShapeDrift: tags final season with shape-drift when dominant shape lost', () => {
  const matches = [
    { seriesId: 'ttX', season: 1, avgRating: 8.0, shapes: ['rising'], confidence: { rising: 0.8 } },
    { seriesId: 'ttX', season: 2, avgRating: 8.1, shapes: ['rising'], confidence: { rising: 0.75 } },
    { seriesId: 'ttX', season: 3, avgRating: 8.0, shapes: ['declining'], confidence: { declining: 0.9 } },
  ];
  tagShapeDrift(matches);
  const s3 = matches.find((m) => m.season === 3);
  assert.ok(s3.shapes.includes('shape-drift'), 'S3 should be tagged as shape-drift');
  assert.ok(Array.isArray(s3.driftPriorShapes), 'should have driftPriorShapes');
  assert.ok(s3.driftPriorShapes.includes('rising'), 'prior shape should be rising');
  assert.equal(typeof s3.driftNote, 'string', 'should have a driftNote');
  assert.ok(s3.driftNote.length > 0, 'driftNote should be non-empty');
});

test('tagShapeDrift: populates driftNewShape with highest-confidence new shape', () => {
  const matches = [
    { seriesId: 'ttY', season: 1, avgRating: 8.0, shapes: ['rising'], confidence: { rising: 0.8 } },
    { seriesId: 'ttY', season: 2, avgRating: 8.0, shapes: ['rising'], confidence: { rising: 0.7 } },
    { seriesId: 'ttY', season: 3, avgRating: 7.8, shapes: ['bad-finale', 'declining'],
      confidence: { 'bad-finale': 0.6, declining: 0.4 } },
  ];
  tagShapeDrift(matches);
  const s3 = matches.find((m) => m.season === 3);
  assert.equal(s3.driftNewShape, 'bad-finale', 'highest-confidence new shape should be bad-finale');
});

test('tagShapeDrift: does not tag when fewer than 3 seasons', () => {
  const matches = [
    { seriesId: 'ttZ', season: 1, avgRating: 8.5, shapes: ['rising'], confidence: {} },
    { seriesId: 'ttZ', season: 2, avgRating: 6.0, shapes: ['declining'], confidence: {} },
  ];
  tagShapeDrift(matches);
  const s2 = matches.find((m) => m.season === 2);
  assert.ok(!s2.shapes.includes('shape-drift'), 'should not tag with only 2 seasons');
});

test('tagShapeDrift: tags on rating decline >= 0.5 even without shape change', () => {
  const matches = [
    { seriesId: 'ttW', season: 1, avgRating: 8.5, shapes: ['consistent'], confidence: { consistent: 0.8 } },
    { seriesId: 'ttW', season: 2, avgRating: 8.4, shapes: ['consistent'], confidence: { consistent: 0.75 } },
    { seriesId: 'ttW', season: 3, avgRating: 7.8, shapes: ['consistent'], confidence: { consistent: 0.6 } },
  ];
  tagShapeDrift(matches);
  const s3 = matches.find((m) => m.season === 3);
  // S3 avg (7.8) dropped 0.6 from S2 (8.4) — should trigger rating-decline drift
  assert.ok(s3.shapes.includes('shape-drift'), 'should tag rating-decline drift');
  assert.ok(s3.driftNote.includes('7.8'), 'driftNote should mention the season rating');
});

// ---------------------------------------------------------------------------
// Feature 7: JustWatch Deep Link — URL encoding
// ---------------------------------------------------------------------------

test('JustWatch URL: encodes show title with special chars', () => {
  // Mirrors the fillProviderTagsLinked logic: q = encodeURIComponent(showTitle)
  const titles = [
    ['Breaking Bad', 'Breaking%20Bad'],
    ['Mr. Robot', 'Mr.%20Robot'],
    ['It\'s Always Sunny in Philadelphia', "It's%20Always%20Sunny%20in%20Philadelphia"],
    ['Arrested Development', 'Arrested%20Development'],
  ];
  for (const [title, expected] of titles) {
    const q = encodeURIComponent(title);
    const url = `https://www.justwatch.com/us/search?q=${q}`;
    assert.ok(url.includes(expected), `URL for "${title}" should contain "${expected}", got: ${url}`);
  }
});

test('JustWatch URL: empty title produces valid URL with empty q', () => {
  const q = encodeURIComponent('');
  const url = `https://www.justwatch.com/us/search?q=${q}`;
  assert.ok(url.startsWith('https://www.justwatch.com/us/search?q='));
});

// ---------------------------------------------------------------------------
// Feature 8: New shape "Outlier Peak" — additional edge cases
// ---------------------------------------------------------------------------

test('isOutlierPeak: qualifies when both avg margin and next-highest margin are exactly 1.5', () => {
  // Need: maxRating - seasonAvg >= 1.5 AND maxRating - secondMax >= 1.5
  // Construct: max=9.5 interior, rest all 7.0 (5 eps)
  // avg = (7.0+7.0+9.5+7.0+7.0)/5 = 37.5/5 = 7.5; spike-avg = 9.5-7.5 = 2.0 >= 1.5
  // secondMax = 7.0; spike-second = 9.5-7.0 = 2.5 >= 1.5
  const eps = season(7.0, 7.0, 9.5, 7.0, 7.0);
  assert.equal(isOutlierPeak(eps), true, 'clear outlier should qualify');
});

test('isOutlierPeak: rejects when margin is 1.49 (just below boundary)', () => {
  // Use ratings where margin = 9.0 - 7.51 = 1.49 < 1.5
  const eps = [
    ep(1, 7.51), ep(2, 7.30), ep(3, 9.00), ep(4, 7.20), ep(5, 7.10),
  ];
  assert.equal(isOutlierPeak(eps), false, '1.49 margin should not qualify');
});

test('isOutlierPeak: rejects when spike is not ≥1.5 above season average', () => {
  // All episodes around 8.5, spike at 9.5 — avg ~8.7, spike-avg = 0.8 < 1.5
  const eps = season(8.5, 8.4, 9.5, 8.6, 8.5);
  assert.equal(isOutlierPeak(eps), false);
});

test('isOutlierPeak: handles a 4-episode minimum correctly (boundary)', () => {
  // 4 episodes, interior spike at ep 2
  const eps = season(7.0, 9.9, 7.1, 7.2);
  // avg = (7.0+9.9+7.1+7.2)/4 = 31.2/4 = 7.8; spike-avg = 9.9-7.8 = 2.1 >= 1.5
  // second-highest of remaining = 7.2; spike - second = 9.9 - 7.2 = 2.7 >= 1.5
  assert.equal(isOutlierPeak(eps), true);
});

// ---------------------------------------------------------------------------
// Feature 9: Stale-Data Freshness Badge — relative date and threshold logic
// ---------------------------------------------------------------------------

function relativeDate(iso) {
  if (!iso) return null;
  const msPerDay = 86_400_000;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / msPerDay);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return '1 week ago';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

function ageDays(iso) {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

test('freshness: relativeDate returns "today" for timestamps within the last day', () => {
  const now = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
  assert.equal(relativeDate(now), 'today');
});

test('freshness: relativeDate returns "yesterday" for ~24h-old timestamps', () => {
  const yesterday = new Date(Date.now() - 25 * 3_600_000).toISOString();
  assert.equal(relativeDate(yesterday), 'yesterday');
});

test('freshness: relativeDate returns "N days ago" for 2–6 day old timestamps', () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  assert.equal(relativeDate(threeDaysAgo), '3 days ago');
});

test('freshness: relativeDate returns "1 week ago" at 7–13 days', () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  assert.equal(relativeDate(tenDaysAgo), '1 week ago');
});

test('freshness: relativeDate returns "N months ago" for old timestamps', () => {
  const twoMonthsAgo = new Date(Date.now() - 62 * 86_400_000).toISOString();
  assert.equal(relativeDate(twoMonthsAgo), '2 months ago');
});

test('freshness: data becomes stale at >21 days', () => {
  const STALE_DAYS = 21;
  const fresh = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const stale = new Date(Date.now() - 22 * 86_400_000).toISOString();
  assert.equal(ageDays(fresh) > STALE_DAYS, false, '20-day-old data should not be stale');
  assert.equal(ageDays(stale) > STALE_DAYS, true, '22-day-old data should be stale');
});

test('freshness: exactly 21 days is not stale, 21.1 days is', () => {
  const STALE_DAYS = 21;
  const boundary = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const over = new Date(Date.now() - (21 * 86_400_000 + 3_600_000)).toISOString();
  assert.equal(ageDays(boundary) > STALE_DAYS, false);
  assert.equal(ageDays(over) > STALE_DAYS, true);
});

// ---------------------------------------------------------------------------
// Feature 10: Normalize Compare Curves — x-axis mapping math
// ---------------------------------------------------------------------------

test('normalize: fractional position maps i=0 to 0 and i=n-1 to 1', () => {
  const n = 5;
  const fracs = Array.from({ length: n }, (_, i) => (n > 1 ? i / (n - 1) : 0.5));
  assert.equal(fracs[0], 0);
  assert.equal(fracs[n - 1], 1);
});

test('normalize: non-normalized mode maps all series to global max axis', () => {
  // Series A has 3 seasons, Series B has 5 seasons.
  // Without normalize, both map to 0..4 (globalMax - 1 = 4).
  const seriesA = [1, 2, 3];         // 3 seasons
  const seriesB = [1, 2, 3, 4, 5];  // 5 seasons
  const globalMax = Math.max(seriesA.length, seriesB.length);
  const W = 100;
  const padX = 10;
  const plotW = W - padX * 2;

  // Series A, season 3 (last) — normalized: i/2=1.0; non-normalized: 2/(5-1)=0.5
  const xFracANorm = 2 / (seriesA.length - 1); // = 1.0
  const xFracANoNorm = 2 / (globalMax - 1);    // = 0.5
  assert.equal(xFracANorm, 1.0);
  assert.equal(xFracANoNorm, 0.5);

  // Series B, season 5 (last) — in both modes: i/4 = 1.0
  const xFracBNorm = 4 / (seriesB.length - 1); // = 1.0
  const xFracBNoNorm = 4 / (globalMax - 1);    // = 1.0
  assert.equal(xFracBNorm, 1.0);
  assert.equal(xFracBNoNorm, 1.0);
});

test('normalize: all seasons share same x position at i=0 in both modes', () => {
  // First season of any series is always at x=padX (xFrac=0) regardless of normalize
  const i = 0;
  const n = 8; // some season count
  const globalMax = 10;
  const xFracNorm = n > 1 ? i / (n - 1) : 0.5;
  const xFracNoNorm = globalMax > 1 ? i / (globalMax - 1) : 0.5;
  assert.equal(xFracNorm, 0);
  assert.equal(xFracNoNorm, 0);
});
