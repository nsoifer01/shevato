'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderShowsSitemap, selectSitemapSeries } = require('../scripts/render-sitemap.js');
const {
  renderShowsIndex, renderShowsLetterPage, groupByLetter, letterPages, letterPath,
  sortTitle, firstLetter, PER_PAGE,
} = require('../scripts/render-shows-index.js');
const { SHAPE_SLUGS, HUB_SLUGS, GAP_HUB_SLUG, hubPath } = require('../scripts/render-shape-hub.js');

const SERIES = [
  { seriesId: 'tt0903747', title: 'Breaking Bad', year: 2008 },
  { seriesId: 'tt0944947', title: 'Game of Thrones', year: 2011 },
  { seriesId: 'tt0386676', title: 'The Office', year: 2005 },
];

test('renderShowsSitemap emits a well-formed XML document', () => {
  const xml = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.trim().endsWith('</urlset>'));
});

test('renderShowsSitemap includes one URL per series plus the index', () => {
  const xml = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z');
  const locs = xml.match(/<loc>/g) || [];
  assert.equal(locs.length, SERIES.length + 1);
});

test('renderShowsSitemap adds one URL per shape hub when given the slugs', () => {
  const xml = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z', SHAPE_SLUGS);
  const locs = xml.match(/<loc>/g) || [];
  assert.equal(locs.length, SERIES.length + 1 + SHAPE_SLUGS.length);
  for (const slug of SHAPE_SLUGS) {
    assert.ok(xml.includes(`<loc>https://shevato.com/apps/rising-shows/shows/shape/${slug}/</loc>`), slug);
  }
  // Hubs sit between the /shows/ index and the individual show pages.
  assert.ok(xml.indexOf('/shows/shape/rising/') > xml.indexOf('<loc>https://shevato.com/apps/rising-shows/shows/</loc>'));
  assert.ok(xml.indexOf('/shows/shape/shape-drift/') < xml.indexOf('/shows/breaking-bad-tt0903747/'));
  assert.equal((xml.match(/<priority>0\.6<\/priority>/g) || []).length, SHAPE_SLUGS.length);
});

test('renderShowsSitemap adds exactly one URL for the gap hub, at the hub priority', () => {
  const withShapes = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z', SHAPE_SLUGS);
  const withGap = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z', HUB_SLUGS);
  const count = (xml) => (xml.match(/<loc>/g) || []).length;
  assert.equal(count(withGap) - count(withShapes), 1);
  assert.ok(!withShapes.includes(GAP_HUB_SLUG));
  assert.ok(withGap.includes(`<loc>https://shevato.com${hubPath(GAP_HUB_SLUG)}</loc>`));
  assert.equal((withGap.match(/<priority>0\.6<\/priority>/g) || []).length, HUB_SLUGS.length);
});

test('renderShowsSitemap URLs use the slug + tconst path scheme', () => {
  const xml = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z');
  assert.ok(xml.includes('https://shevato.com/apps/rising-shows/shows/breaking-bad-tt0903747/'));
  assert.ok(xml.includes('https://shevato.com/apps/rising-shows/shows/game-of-thrones-tt0944947/'));
  assert.ok(xml.includes('https://shevato.com/apps/rising-shows/shows/the-office-tt0386676/'));
});

test('renderShowsSitemap carries no lastmod (the build date is not a content date)', () => {
  const xml = renderShowsSitemap(SERIES, '2026-05-18T12:34:56.000Z');
  assert.ok(!xml.includes('<lastmod>'));
});

test('selectSitemapSeries keeps the top-voted shows up to the limit', () => {
  const series = [
    { seriesId: 'tt1', title: 'Low', seriesVotes: 100 },
    { seriesId: 'tt2', title: 'High', seriesVotes: 90000 },
    { seriesId: 'tt3', title: 'Mid', seriesVotes: 5000 },
  ];
  const picked = selectSitemapSeries(series, 2);
  assert.deepEqual(picked.map((s) => s.seriesId), ['tt2', 'tt3']);
});

test('selectSitemapSeries sorts missing vote counts last and breaks ties by title', () => {
  const series = [
    { seriesId: 'tt1', title: 'Zeta', seriesVotes: 500 },
    { seriesId: 'tt2', title: 'No Votes' },
    { seriesId: 'tt3', title: 'Alpha', seriesVotes: 500 },
  ];
  const picked = selectSitemapSeries(series, 3);
  assert.deepEqual(picked.map((s) => s.title), ['Alpha', 'Zeta', 'No Votes']);
});

test('selectSitemapSeries does not mutate the input order', () => {
  const series = [
    { seriesId: 'tt1', title: 'B', seriesVotes: 1 },
    { seriesId: 'tt2', title: 'A', seriesVotes: 2 },
  ];
  selectSitemapSeries(series, 1);
  assert.deepEqual(series.map((s) => s.seriesId), ['tt1', 'tt2']);
});

test('sortTitle drops leading articles for alphabetization', () => {
  assert.equal(sortTitle('The Office'), 'office');
  assert.equal(sortTitle('A Series of Unfortunate Events'), 'series of unfortunate events');
  assert.equal(sortTitle('An American Family'), 'american family');
});

test('firstLetter buckets non-letters into "#"', () => {
  assert.equal(firstLetter('breaking bad'), 'B');
  assert.equal(firstLetter('1899'), '#');
  assert.equal(firstLetter(''), '#');
});

// Regression (U12): a title starting with a Latin letter that carries a
// diacritic used to fail the bare /[A-Z]/ test and land in "#" next to
// "!Mucha Lucha!" and 574 digit-initial titles - even though its own slug
// already folds ("Cilgin Dersane at the University" -> cilgin-...). 31 series
// were mis-filed. Folding is for BUCKETING only; the row still prints the
// real title.
test('firstLetter folds Latin diacritics so accented titles file under their letter', () => {
  assert.equal(firstLetter('cilgin dersane at the university'.replace('c', '\u00e7')), 'C');
  assert.equal(firstLetter('\u00c5re murders'), 'A');
  assert.equal(firstLetter('\u00c9toile'), 'E');
  assert.equal(firstLetter('\u00d6lene kadar'), 'O');
  assert.equal(firstLetter('\u00dcber die grenze'), 'U');
});

// Anything with no Latin base stays in "#": transliterating a non-Latin script
// would be a guess about a romanisation the reader may not share, and IMDb's
// primaryTitle is already romanised across this catalogue, so it is rare.
test('firstLetter leaves non-Latin scripts and symbols in "#"', () => {
  assert.equal(firstLetter('\u65e5\u672c\u306e\u756a\u7d44'), '#'); // Japanese
  assert.equal(firstLetter('\u0414\u0440\u0443\u0437\u044c\u044f'), '#'); // Cyrillic
  assert.equal(firstLetter('\u0645\u0633\u0644\u0633\u0644'), '#'); // Arabic
  assert.equal(firstLetter('\u00a1mucha lucha!'), '#');
  assert.equal(firstLetter('#blackaf'), '#');
});

test('groupByLetter files an accented title under its folded letter without changing it', () => {
  const accented = { seriesId: 'tt9000001', title: '\u00c7ilgin Dersane at the University', year: 2013 };
  const groups = groupByLetter([...SERIES, accented]);
  assert.ok(!groups.has('#'), 'nothing should be left in the # bucket here');
  assert.ok(groups.get('C').some((s) => s.seriesId === 'tt9000001'));
  // Display is untouched: the letter page prints the real title.
  const pages = letterPages(groups);
  const cPage = pages.find((pg) => pg.letter === 'C');
  const html = renderShowsLetterPage({ ...cPage, groups, builtAt: null });
  assert.ok(html.includes('\u00c7ilgin Dersane at the University'), 'accented title must render verbatim');
});

test('renderShowsIndex is a letter hub, not a list of every show', () => {
  const html = renderShowsIndex(SERIES, '2026-05-18T00:00:00.000Z');
  assert.ok(html.includes('3 shows'));
  // The hub links to letter pages...
  assert.ok(html.includes('href="/apps/rising-shows/shows/letter/b/"'));
  assert.ok(html.includes('href="/apps/rising-shows/shows/letter/g/"'));
  // ..."The Office" is alphabetized under O, not T...
  assert.ok(html.includes('href="/apps/rising-shows/shows/letter/o/"'));
  // ...and it must NOT carry the show links itself. All 34,586 on one page is
  // what made this 4.79 MB and 535,383px tall.
  assert.ok(!html.includes('/apps/rising-shows/shows/breaking-bad-tt0903747/'));
  assert.ok(!html.includes('/apps/rising-shows/shows/the-office-tt0386676/'));
});

test('letter pages carry the shows, and every show lands on exactly one', () => {
  const groups = groupByLetter(SERIES);
  const pages = letterPages(groups);
  const seen = [];
  for (const page of pages) {
    const html = renderShowsLetterPage({ ...page, groups, builtAt: '2026-05-18T00:00:00.000Z' });
    for (const s of page.items) seen.push(s.seriesId);
    assert.ok(html.includes(`<h1>Shows starting with ${page.letter}`));
    // Self-canonical: pointing later pages at page 1 would tell Google the shows
    // listed there need no crawling, which is the opposite of the point.
    assert.ok(html.includes(`<link rel="canonical" href="https://shevato.com${page.path}">`));
  }
  assert.deepEqual(seen.sort(), SERIES.map((s) => s.seriesId).sort());
});

test('a letter longer than PER_PAGE splits into linked pages', () => {
  const many = Array.from({ length: PER_PAGE + 5 }, (_, i) => ({
    seriesId: `tt${String(i).padStart(7, '0')}`,
    title: `Zulu Show ${String(i).padStart(4, '0')}`,
    year: 2020,
  }));
  const groups = groupByLetter(many);
  const pages = letterPages(groups);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].items.length, PER_PAGE);
  assert.equal(pages[1].items.length, 5);
  assert.equal(pages[0].path, '/apps/rising-shows/shows/letter/z/');
  assert.equal(pages[1].path, '/apps/rising-shows/shows/letter/z/2/');

  const first = renderShowsLetterPage({ ...pages[0], groups, builtAt: null });
  const second = renderShowsLetterPage({ ...pages[1], groups, builtAt: null });
  assert.ok(first.includes(`<link rel="next" href="https://shevato.com${pages[1].path}">`));
  assert.ok(!first.includes('rel="prev"'));
  assert.ok(second.includes(`<link rel="prev" href="https://shevato.com${pages[0].path}">`));
  assert.ok(!second.includes('rel="next"'));
});

test('non-letter titles get a URL-safe "other" slug rather than a bare #', () => {
  assert.equal(letterPath('#'), '/apps/rising-shows/shows/letter/other/');
  assert.equal(letterPath('#', 3), '/apps/rising-shows/shows/letter/other/3/');
});

test('the sitemap lists the browse pages, not just the curated shows', () => {
  const browsePaths = ['/apps/rising-shows/shows/letter/b/', '/apps/rising-shows/shows/letter/b/2/'];
  const xml = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z', [], browsePaths);
  for (const p of browsePaths) {
    assert.ok(xml.includes(`<loc>https://shevato.com${p}</loc>`));
  }
  // Omitting them would leave every page past a letter's first sitting two hops
  // from anything the sitemap mentions.
  assert.ok(xml.includes('<loc>https://shevato.com/apps/rising-shows/shows/</loc>'));
});

test('renderShowsIndex carries a browse strip to all 13 shape hubs plus the gap hub', () => {
  const html = renderShowsIndex(SERIES, '2026-05-18T00:00:00.000Z');
  const hubLinks = new Set([...html.matchAll(/href="(\/apps\/rising-shows\/shows\/shape\/[a-z-]+\/)"/g)].map((m) => m[1]));
  assert.equal(hubLinks.size, HUB_SLUGS.length);
  assert.ok(hubLinks.has('/apps/rising-shows/shows/shape/slow-burn/'));
  assert.ok(hubLinks.has(hubPath(GAP_HUB_SLUG)));
  assert.ok(html.includes('>Saved best for last<'));
  assert.ok(html.includes('>Outshines its reputation<'));
  // The A-Z index is nobody's current page, so no chip is marked as such.
  assert.ok(!html.includes('shape-nav-current'));
});

// --- A-Z surface metadata (D27) ---
//
// The index and the 83 letter pages share one shell, and it was the only
// surface in the app still carrying an em dash in a <title>, .html breadcrumb
// URLs the canonical pages never use, an SVG og:image (social scrapers do not
// render SVG, so the preview was blank), and no twitter card at all.

test('the A-Z index title carries no em dash and leads with the topic', () => {
  const html = renderShowsIndex(SERIES, '2026-05-18T00:00:00.000Z');
  const title = html.match(/<title>([^<]*)<\/title>/)[1];
  assert.equal(title.includes('\u2014'), false, title);
  assert.equal(title, 'All Shows - Browse Every TV Series by Episode Ratings | Rising Shows');
});

test('A-Z breadcrumb JSON-LD uses the extensionless URLs the show pages use', () => {
  const groups = groupByLetter(SERIES);
  const pages = letterPages(groups);
  const docs = [
    renderShowsIndex(SERIES, '2026-05-18T00:00:00.000Z'),
    renderShowsLetterPage({ ...pages[0], groups, builtAt: null }),
  ];
  for (const html of docs) {
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    const crumbs = JSON.parse(block);
    assert.equal(crumbs['@type'], 'BreadcrumbList');
    assert.equal(crumbs.itemListElement[0].item, 'https://shevato.com/home');
    assert.equal(crumbs.itemListElement[1].item, 'https://shevato.com/apps');
    assert.equal(html.includes('/home.html'), false);
    assert.equal(html.includes('/apps.html'), false);
  }
});

test('A-Z pages share the show pages og-card and a twitter card', () => {
  const groups = groupByLetter(SERIES);
  const pages = letterPages(groups);
  for (const html of [
    renderShowsIndex(SERIES, '2026-05-18T00:00:00.000Z'),
    renderShowsLetterPage({ ...pages[0], groups, builtAt: null }),
  ]) {
    assert.ok(html.includes('<meta property="og:image" content="https://shevato.com/images/og-card.png">'));
    assert.equal(html.includes('full-logo.svg'), false);
    assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
    assert.ok(html.includes('<meta property="og:image:height" content="630">'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(html.includes('<meta name="twitter:image" content="https://shevato.com/images/og-card.png">'));
    assert.ok(/<meta property="og:image:alt" content="[^"]+"/.test(html));
  }
});
