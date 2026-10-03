'use strict';

// The Finder's card/row sparkline, driven end to end: split-data.js builds the
// boot index the browser fetches, and app.js's own drawFinderSpark draws each
// row of it exactly as buildFinderCard and the list view call it.
//
// WHY THIS FILE EXISTS
// --------------------
// From PR #509 (2026-09-07, the F08 boot split) to 2026-10-03 every one-season
// show drew a single centered dot instead of its episode curve. The build
// renamed the single-season series to a flat `epRatings` array, the app kept
// reading the old `episodeSeries`, and no test ever connected the two halves:
// the parity suite pinned that the build wrote `epRatings`, finder-lib.test.js
// pinned that buildShowAgg (which the browser no longer runs) produced
// `episodeSeries`, and nothing ever called drawFinderSpark. Every assertion
// here counts plotted points, so a series that goes missing again fails it.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { helpers } = require('./app-harness.js');
const { buildShowsIndex } = require('../scripts/split-data.js');

const { drawFinderSpark, finderSparkSeries } = helpers;

// Records the svg operations drawFinderSpark performs. The card template has
// .curve-area, .curve-line and .finder-spark-dot and no .curve-dots, the same
// as index.html's finderCardTpl and the list view's row spark.
function fakeSpark() {
  const line = {};
  const area = {};
  const dots = [];
  const classes = new Set();
  return {
    line, area, dots, classes,
    parentElement: null,
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    querySelector(sel) {
      if (sel === '.curve-line') return { setAttribute(k, v) { line[k] = v; } };
      if (sel === '.curve-area') return { setAttribute(k, v) { area[k] = v; } };
      if (sel === '.finder-spark-dot') {
        return { replaceChildren() { dots.length = 0; }, appendChild(c) { dots.push(c); } };
      }
      return null;
    },
  };
}

// What the card shows: the number of points on the drawn line (M/L commands)
// and the number of fallback dots.
function draw(row) {
  const svg = fakeSpark();
  drawFinderSpark(svg, row.seasonAvgs, finderSparkSeries(row));
  const pts = (svg.line.d || '').split(' ').filter((c) => /^[ML]/.test(c));
  return {
    points: pts.length,
    ys: pts.map((c) => Number(c.slice(1).split(',')[1])),
    dots: svg.dots.length,
    single: svg.classes.has('finder-spark--single'),
  };
}

// Season records in the shape the build hands buildShowsIndex: episodes
// already stripped, rated count/sum folded, and epRatings on single-season
// shows only (split-data.js's slim map).
function slimSeason({ id, title, season, ratings, single }) {
  const rec = {
    seriesId: id, title, year: 2019, seasonYear: 2018 + season, type: 'tvSeries',
    genres: ['Drama'], season,
    avgRating: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100,
    minVotes: 1000, shapes: [], avgRuntime: 60, seriesRating: 9, seriesVotes: 100000,
    poster: `/${id}.jpg`, language: 'en', providers: ['Netflix'],
    episodeCount: ratings.length, ratedCount: ratings.length,
    ratingSum: Math.round(ratings.reduce((a, b) => a + b, 0) * 100) / 100,
  };
  if (single) rec.epRatings = ratings.slice();
  return rec;
}

// Through JSON, because the browser gets the index from shows-index.json.
function bootRows(slim) {
  const rows = JSON.parse(JSON.stringify(buildShowsIndex(slim, [])));
  return new Map(rows.map((r) => [r.seriesId, r]));
}

const CHERNOBYL = [9.4, 9.6, 9.5, 9.3, 9.8];

test('finder spark: a one-season show draws its episode curve, one point per rated episode', () => {
  const rows = bootRows([
    slimSeason({ id: 'tt7366338', title: 'Chernobyl', season: 1, ratings: CHERNOBYL, single: true }),
  ]);
  const got = draw(rows.get('tt7366338'));
  assert.equal(got.points, 5, 'five episodes, five points on the line');
  assert.equal(got.dots, 0, 'not the single-dot fallback');
  assert.equal(got.single, true, 'drawn in the single-season (episode curve) style');
  // The highest episode (E5, 9.8) sits highest; the lowest (E4, 9.3) lowest.
  // SVG y grows downward, so that is the min and max y.
  assert.equal(got.ys.indexOf(Math.min(...got.ys)), 4);
  assert.equal(got.ys.indexOf(Math.max(...got.ys)), 3);
});

test('finder spark: the series it plots is the shipped epRatings, in episode order', () => {
  const series = finderSparkSeries({ epRatings: CHERNOBYL });
  assert.deepEqual(series.map((e) => e.rating), CHERNOBYL);
  assert.deepEqual(series.map((e) => e.episode), [1, 2, 3, 4, 5]);
  assert.equal(finderSparkSeries({ seasonAvgs: [] }), undefined, 'multi-season rows carry no series');
});

test('finder spark: a multi-season show draws one point per season average', () => {
  const rows = bootRows([1, 2, 3, 4, 5].map((n) => slimSeason({
    id: 'tt0903747', title: 'Breaking Bad', season: n, ratings: [8 + n * 0.2, 8.1 + n * 0.2],
  })));
  const row = rows.get('tt0903747');
  assert.equal(row.epRatings, undefined, 'the build ships no episode ratings for it');
  const got = draw(row);
  assert.equal(got.points, 5, 'five seasons, five points');
  assert.equal(got.dots, 0);
  assert.equal(got.single, false);
  // Rising averages: each point higher on screen than the last.
  for (let i = 1; i < got.ys.length; i++) assert.ok(got.ys[i] < got.ys[i - 1], `season ${i + 1} above season ${i}`);
});

test('finder spark: a one-season show with a single rated episode still falls back to one dot', () => {
  const rows = bootRows([
    slimSeason({ id: 'tt0000001', title: 'Pilot only', season: 1, ratings: [7.7], single: true }),
  ]);
  const got = draw(rows.get('tt0000001'));
  assert.equal(got.points, 0, 'one point is not a line');
  assert.equal(got.dots, 1, 'the centered fallback dot');
});

// The real catalogue, when the gitignored release data is present.
const SHOWS = path.join(__dirname, '..', 'shows-index.json');
const haveReal = fs.existsSync(SHOWS);

test('finder spark (real catalogue): every one-season show with 2+ rated episodes draws a line of that many points', { skip: haveReal ? false : 'release data absent (shows-index.json); run npm run fetch:rising-shows-data' }, () => {
  const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
  const byTitle = new Map(shows.map((s) => [s.title, s]));
  for (const [title, n] of [['Chernobyl', 5], ["The Queen's Gambit", 7]]) {
    const got = draw(byTitle.get(title));
    assert.equal(got.points, n, `${title}: ${n} episode points`);
    assert.equal(got.dots, 0, `${title}: not a dot`);
  }
  const bb = byTitle.get('Breaking Bad');
  assert.equal(draw(bb).points, bb.seasonAvgs.length, 'Breaking Bad: one point per season');

  let checked = 0;
  const wrong = [];
  for (const s of shows) {
    if (s.seasonAvgs.length !== 1 || !s.epRatings || s.epRatings.length < 2) continue;
    checked++;
    const got = draw(s);
    if (got.points !== s.epRatings.length || got.dots !== 0) wrong.push(`${s.seriesId} ${s.title}`);
  }
  assert.ok(checked > 1000, `sanity: ${checked} one-season shows checked`);
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} one-season shows did not draw their episode curve`);
});
