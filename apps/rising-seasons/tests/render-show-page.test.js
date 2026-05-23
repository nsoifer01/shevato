'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderShowPage, buildDescription } = require('../scripts/render-show-page.js');
const { groupBySeries } = require('../scripts/build-show-pages.js');

const BREAKING_BAD = {
  seriesId: 'tt0903747',
  title: 'Breaking Bad',
  year: 2008,
  type: 'tvSeries',
  genres: ['Crime', 'Drama', 'Thriller'],
  seriesRating: 9.5,
  seriesVotes: 2615545,
  poster: '/poster.jpg',
  overview: 'Walter White becomes a meth cook.',
  language: 'en',
  providers: ['Netflix'],
  tmdbId: 1396,
  seasons: [
    {
      season: 1,
      seasonYear: 2008,
      episodes: [
        { episode: 1, rating: 8.0, votes: 1000, name: 'Pilot' },
        { episode: 2, rating: 8.2, votes: 950, name: "Cat's in the Bag..." },
      ],
      firstRating: 8.0,
      lastRating: 8.2,
      avgRating: 8.1,
      shapes: ['rising'],
    },
  ],
  builtAt: '2026-05-18T00:00:00.000Z',
};

test('renderShowPage produces a valid HTML5 document', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.trim().endsWith('</html>'));
});

test('renderShowPage puts the show name in the title and h1', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('<title>Breaking Bad (2008) — Episode Ratings'));
  assert.ok(html.match(/<h1>Breaking Bad/));
});

test('renderShowPage sets a canonical URL using the slug + tconst', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('<link rel="canonical" href="https://shevato.com/apps/rising-seasons/shows/breaking-bad-tt0903747/">'));
});

test('renderShowPage emits TVSeries JSON-LD with aggregateRating', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('"@type": "TVSeries"'));
  assert.ok(html.includes('"aggregateRating"'));
  assert.ok(html.includes('"ratingValue": 9.5'));
  assert.ok(html.includes('"ratingCount": 2615545'));
});

test('renderShowPage links to the IMDb canonical and the shape-filtered explorer', () => {
  const html = renderShowPage({ ...BREAKING_BAD, dominantShape: 'rising', dominantShapeSlug: 'rising', relatedShows: [] });
  assert.ok(html.includes('https://www.imdb.com/title/tt0903747/'));
  // Primary CTA now deep-links to the shape filter, not a per-show hash
  assert.ok(html.includes('/apps/rising-seasons/#shape=rising'));
});

test('renderShowPage CTA falls back when show has no shape', () => {
  const html = renderShowPage({ ...BREAKING_BAD, dominantShape: null, dominantShapeSlug: null, relatedShows: [] });
  assert.ok(html.includes('Browse seasons by rating shape'));
  assert.ok(html.includes('href="/apps/rising-seasons/"'));
});

test('renderShowPage includes episode rows in a real HTML table', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('<table class="episode-table">'));
  assert.ok(html.includes('Pilot'));
  // Apostrophe escaped — using &#39; per our HTML escaper
  assert.ok(html.includes('Cat&#39;s in the Bag'));
});

test('renderShowPage embeds a server-rendered SVG curve', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('<svg class="season-curve"'));
  assert.ok(html.includes('class="curve-line"'));
});

test('renderShowPage degrades gracefully without TMDB data', () => {
  const noTmdb = { ...BREAKING_BAD, poster: null, overview: null, language: null, providers: null, tmdbId: null };
  const html = renderShowPage(noTmdb);
  // Falls back to the site OG card when the show has no TMDB poster
  assert.ok(html.includes('og:image" content="https://shevato.com/images/og-card.png'));
  // Renders a placeholder, not a broken <img>
  assert.ok(html.includes('poster-placeholder'));
  // Does NOT include the TMDB sameAs reference
  assert.ok(!html.includes('themoviedb.org'));
});

test('renderShowPage XSS-escapes hostile titles', () => {
  const evil = {
    ...BREAKING_BAD,
    title: '<script>alert(1)</script>',
    overview: 'Has "quotes" & <tags>',
  };
  const html = renderShowPage(evil);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('"quotes"'));
});

test('buildDescription stays under 300 chars', () => {
  const d = buildDescription(
    'Some Show',
    2020,
    3,
    8.5,
    100000,
    'A'.repeat(1000),
  );
  assert.ok(d.length <= 300);
});

test('groupBySeries collapses seasons under a single series', () => {
  const matches = [
    { seriesId: 'tt1', title: 'X', year: 2020, type: 'tvSeries', genres: ['Drama'], season: 1, seasonYear: 2020, episodes: [{ episode: 1, rating: 8, votes: 100 }], firstRating: 8, lastRating: 8, avgRating: 8, shapes: ['rising'], seriesRating: 8.5, seriesVotes: 5000 },
    { seriesId: 'tt1', title: 'X', year: 2020, type: 'tvSeries', genres: ['Drama'], season: 2, seasonYear: 2021, episodes: [{ episode: 1, rating: 9, votes: 100 }], firstRating: 9, lastRating: 9, avgRating: 9, shapes: ['consistent'], seriesRating: 8.5, seriesVotes: 5000 },
    { seriesId: 'tt2', title: 'Y', year: 2018, type: 'tvSeries', genres: ['Comedy'], season: 1, seasonYear: 2018, episodes: [{ episode: 1, rating: 7, votes: 100 }], firstRating: 7, lastRating: 7, avgRating: 7, shapes: [], seriesRating: 7, seriesVotes: 1000 },
  ];
  const grouped = groupBySeries(matches);
  assert.equal(grouped.length, 2);
  const x = grouped.find((g) => g.seriesId === 'tt1');
  assert.equal(x.seasons.length, 2);
  // seasons sorted numerically
  assert.deepEqual(x.seasons.map((s) => s.season), [1, 2]);
});

test('renderShowPage header contains brand link and launch-app button pointing to /apps/rising-seasons/', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('class="brand"'));
  assert.ok(html.includes('href="/apps/rising-seasons/" aria-label="Rising Seasons home"'));
  assert.ok(html.includes('class="header-launch-btn"'));
  // header launch button links to the base app URL, no hash fragment
  const headerLaunchIdx = html.indexOf('class="header-launch-btn"');
  const snippet = html.slice(headerLaunchIdx - 60, headerLaunchIdx + 80);
  assert.ok(snippet.includes('href="/apps/rising-seasons/"'));
});

test('renderShowPage hero-actions has three buttons: shape CTA, app-btn, IMDb link', () => {
  const html = renderShowPage({ ...BREAKING_BAD, dominantShape: 'rising', dominantShapeSlug: 'rising', relatedShows: [] });
  // All three must be present
  assert.ok(html.includes('class="primary-btn"'));
  assert.ok(html.includes('class="app-btn"'));
  assert.ok(html.includes('class="secondary-btn"'));
  // app-btn links to the base app URL with no hash
  const appBtnIdx = html.indexOf('class="app-btn"');
  const appBtnSnippet = html.slice(appBtnIdx - 60, appBtnIdx + 80);
  assert.ok(appBtnSnippet.includes('href="/apps/rising-seasons/"'));
  // app-btn does NOT carry the shape hash (that's the primary-btn's job)
  assert.ok(!appBtnSnippet.includes('#shape='));
  // Order: primary-btn appears before app-btn, app-btn before secondary-btn
  assert.ok(html.indexOf('class="primary-btn"') < html.indexOf('class="app-btn"'));
  assert.ok(html.indexOf('class="app-btn"') < html.indexOf('class="secondary-btn"'));
});

test('renderShowPage app-btn is present even when show has no dominant shape', () => {
  const html = renderShowPage({ ...BREAKING_BAD, dominantShape: null, dominantShapeSlug: null, relatedShows: [] });
  assert.ok(html.includes('class="app-btn"'));
  const appBtnIdx = html.indexOf('class="app-btn"');
  const snippet = html.slice(appBtnIdx - 60, appBtnIdx + 80);
  assert.ok(snippet.includes('href="/apps/rising-seasons/"'));
});

test('groupBySeries backfills series-level fields from any season', () => {
  // First season has no enrichment; second season carries the poster.
  // Result should hold the poster regardless of which season holds it.
  const matches = [
    { seriesId: 'tt1', title: 'X', year: 2020, season: 1, episodes: [{ episode: 1, rating: 8, votes: 100 }], firstRating: 8, lastRating: 8, avgRating: 8, shapes: [] },
    { seriesId: 'tt1', title: 'X', year: 2020, season: 2, episodes: [{ episode: 1, rating: 9, votes: 100 }], firstRating: 9, lastRating: 9, avgRating: 9, shapes: [], poster: '/late.jpg', tmdbId: 99 },
  ];
  const grouped = groupBySeries(matches);
  assert.equal(grouped[0].poster, '/late.jpg');
  assert.equal(grouped[0].tmdbId, 99);
});
