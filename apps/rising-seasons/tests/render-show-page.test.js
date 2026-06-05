'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderShowPage, buildDescription, buildTvSeasonSchema, renderSeasonNav } = require('../scripts/render-show-page.js');
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
  // Does NOT include the TMDB sameAs reference (the footer's required
  // TMDB attribution link is unconditional, so match the /tv/ URL shape,
  // not the bare domain)
  assert.ok(!html.includes('themoviedb.org/tv/'));
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
  // app-btn deep-links into the app, opening this show's modal via #show=
  const appBtnIdx = html.indexOf('class="app-btn"');
  const appBtnSnippet = html.slice(appBtnIdx - 60, appBtnIdx + 120);
  assert.ok(appBtnSnippet.includes(`href="/apps/rising-seasons/#show=${BREAKING_BAD.seriesId}"`));
  assert.ok(appBtnSnippet.includes('Open in Rising Seasons app'));
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
  const snippet = html.slice(appBtnIdx - 60, appBtnIdx + 120);
  assert.ok(snippet.includes(`href="/apps/rising-seasons/#show=${BREAKING_BAD.seriesId}"`));
});

test('renderShowPage renders a cast strip when cast is provided', () => {
  const cast = [
    { id: 17419, name: 'Bryan Cranston', character: 'Walter White', profile_path: '/bran.jpg' },
    { id: 134531, name: 'Aaron Paul', character: 'Jesse Pinkman', profile_path: null },
  ];
  const html = renderShowPage({ ...BREAKING_BAD, cast, dominantShape: 'rising', dominantShapeSlug: 'rising', relatedShows: [] });
  assert.ok(html.includes('<h2 id="cast-heading">Cast</h2>'));
  assert.ok(html.includes('class="cast-name">Bryan Cranston'));
  assert.ok(html.includes('class="cast-character">Walter White'));
  // Member with a TMDB id links out to their person page.
  assert.ok(html.includes('https://www.themoviedb.org/person/17419'));
  // Member without a profile_path gets the initial fallback, not a broken img.
  assert.ok(html.includes('class="cast-photo-fallback"'));
  // Cast feeds the TVSeries JSON-LD actor list for SEO.
  assert.ok(html.includes('"actor"'));
  assert.ok(html.includes('"name": "Bryan Cranston"'));
});

test('renderShowPage omits the cast section when there is no cast', () => {
  const html = renderShowPage({ ...BREAKING_BAD, cast: null, dominantShape: 'rising', dominantShapeSlug: 'rising', relatedShows: [] });
  assert.ok(!html.includes('id="cast-heading"'));
  assert.ok(!html.includes('"actor"'));
});

// --- Feature 4: TVSeason JSON-LD per-season aggregateRating ---

test('buildTvSeasonSchema emits correct ratingValue and ratingCount', () => {
  const season = {
    season: 4,
    seasonYear: 2011,
    avgRating: 8.44,
    episodes: [
      { episode: 1, rating: 8.4, votes: 60000 },
      { episode: 2, rating: 8.5, votes: 40000 },
    ],
    shapes: ['rising'],
  };
  const canonical = 'https://shevato.com/apps/rising-seasons/shows/breaking-bad-tt0903747/';
  const block = buildTvSeasonSchema(season, 'Breaking Bad', canonical);
  assert.ok(block.includes('"@type": "TVSeason"'));
  assert.ok(block.includes('"ratingValue": "8.4"'));
  assert.ok(block.includes('"ratingCount": 100000'));
  assert.ok(block.includes(`"url": "${canonical}#season-4"`));
  assert.ok(block.includes('"partOfSeries"'));
});

test('renderShowPage emits TVSeason JSON-LD blocks for each season', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('"@type": "TVSeason"'));
  assert.ok(html.includes('"seasonNumber": 1'));
  assert.ok(html.includes('#season-1'));
});

// --- Feature 8: Season jump nav ---

test('renderSeasonNav returns a string with correct href for 4-season fixture', () => {
  const seasons = [
    { season: 1, episodes: [] },
    { season: 2, episodes: [] },
    { season: 3, episodes: [] },
    { season: 4, episodes: [] },
  ];
  const nav = renderSeasonNav(seasons);
  assert.ok(nav.includes('href="#season-3"'));
  assert.ok(nav.includes('href="#season-4"'));
  assert.ok(nav.includes('class="season-jump-nav"'));
});

test('renderSeasonNav returns empty string for a 3-season fixture', () => {
  const seasons = [
    { season: 1, episodes: [] },
    { season: 2, episodes: [] },
    { season: 3, episodes: [] },
  ];
  const nav = renderSeasonNav(seasons);
  assert.ok(!nav);
});

test('renderShowPage includes season-jump-nav for a 4+ season show', () => {
  const show = {
    ...BREAKING_BAD,
    seasons: [
      { season: 1, seasonYear: 2008, episodes: [{ episode: 1, rating: 8.0, votes: 1000, name: 'Ep1' }], firstRating: 8.0, lastRating: 8.0, avgRating: 8.0, shapes: ['rising'] },
      { season: 2, seasonYear: 2009, episodes: [{ episode: 1, rating: 8.1, votes: 900, name: 'Ep1' }], firstRating: 8.1, lastRating: 8.1, avgRating: 8.1, shapes: ['rising'] },
      { season: 3, seasonYear: 2010, episodes: [{ episode: 1, rating: 8.2, votes: 800, name: 'Ep1' }], firstRating: 8.2, lastRating: 8.2, avgRating: 8.2, shapes: ['rising'] },
      { season: 4, seasonYear: 2011, episodes: [{ episode: 1, rating: 8.5, votes: 700, name: 'Ep1' }], firstRating: 8.5, lastRating: 8.5, avgRating: 8.5, shapes: ['rising'] },
    ],
  };
  const html = renderShowPage(show);
  assert.ok(html.includes('class="season-jump-nav"'));
  assert.ok(html.includes('href="#season-3"'));
});

test('renderShowPage omits season-jump-nav for a 1-season show', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(!html.includes('class="season-jump-nav"'));
});

// --- Feature 10: Richer OG/Twitter meta ---

test('renderShowPage emits og:image:width, og:image:height, and richer og:image:alt when poster exists', () => {
  const html = renderShowPage({ ...BREAKING_BAD, dominantShape: 'rebound', dominantShapeSlug: 'rebound', relatedShows: [] });
  assert.ok(html.includes('og:image:width" content="500"'));
  assert.ok(html.includes('og:image:height" content="750"'));
  assert.ok(html.includes('og:image:alt" content="'));
  // alt must contain parentheses (not em dashes) and the shape label
  const altMatch = html.match(/og:image:alt" content="([^"]+)"/);
  assert.ok(altMatch, 'og:image:alt meta tag missing');
  assert.ok(altMatch[1].includes('('), 'alt text must use parentheses, not em dashes');
  assert.ok(!altMatch[1].includes('—'), 'alt text must not contain em dashes');
});

test('renderShowPage does not emit og:image:width when no poster', () => {
  const html = renderShowPage({ ...BREAKING_BAD, poster: null });
  assert.ok(!html.includes('og:image:width'));
});

test('renderShowPage emits twitter:label1=Shape and twitter:data1 with shape label when dominantShape is set', () => {
  const html = renderShowPage({ ...BREAKING_BAD, dominantShape: 'rebound', dominantShapeSlug: 'rebound', relatedShows: [] });
  assert.ok(html.includes('name="twitter:label1" content="Shape"'));
  assert.ok(html.includes('name="twitter:data1" content="Rebound"'));
  assert.ok(html.includes('name="twitter:label2" content="Avg episode rating"'));
  assert.ok(html.includes('name="twitter:data2"'));
});

test('renderShowPage omits twitter label/data cards when no dominantShape', () => {
  const html = renderShowPage({ ...BREAKING_BAD, dominantShape: null, dominantShapeSlug: null });
  assert.ok(!html.includes('twitter:label1'));
  assert.ok(!html.includes('twitter:data1'));
});

// --- Scroll-to-top button ---

test('renderShowPage includes scroll-to-top button with aria-label', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('class="page-scroll-top"'));
  assert.ok(html.includes('aria-label="Scroll back to top"'));
  assert.ok(html.includes('id="pageScrollTop"'));
});

test('renderShowPage includes inline scroll script for the scroll-to-top button', () => {
  const html = renderShowPage(BREAKING_BAD);
  assert.ok(html.includes('pageScrollTop'));
  assert.ok(html.includes('page-scroll-top--visible'));
  assert.ok(html.includes("window.scrollTo"));
});

test('renderShowPage includes scroll-to-top button regardless of season count', () => {
  const singleSeason = renderShowPage(BREAKING_BAD);
  const multiSeason = renderShowPage({
    ...BREAKING_BAD,
    seasons: [
      { season: 1, seasonYear: 2008, episodes: [{ episode: 1, rating: 8.0, votes: 1000, name: 'Ep1' }], firstRating: 8.0, lastRating: 8.0, avgRating: 8.0, shapes: ['rising'] },
      { season: 2, seasonYear: 2009, episodes: [{ episode: 1, rating: 8.1, votes: 900, name: 'Ep1' }], firstRating: 8.1, lastRating: 8.1, avgRating: 8.1, shapes: ['rising'] },
      { season: 3, seasonYear: 2010, episodes: [{ episode: 1, rating: 8.2, votes: 800, name: 'Ep1' }], firstRating: 8.2, lastRating: 8.2, avgRating: 8.2, shapes: ['rising'] },
      { season: 4, seasonYear: 2011, episodes: [{ episode: 1, rating: 8.5, votes: 700, name: 'Ep1' }], firstRating: 8.5, lastRating: 8.5, avgRating: 8.5, shapes: ['rising'] },
    ],
  });
  assert.ok(singleSeason.includes('class="page-scroll-top"'));
  assert.ok(multiSeason.includes('class="page-scroll-top"'));
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
