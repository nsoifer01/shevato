'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderShowsSitemap, selectSitemapSeries } = require('../scripts/render-sitemap.js');
const { renderShowsIndex, sortTitle, firstLetter } = require('../scripts/render-shows-index.js');

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

test('renderShowsSitemap URLs use the slug + tconst path scheme', () => {
  const xml = renderShowsSitemap(SERIES, '2026-05-18T00:00:00.000Z');
  assert.ok(xml.includes('https://shevato.com/apps/rising-shows/shows/breaking-bad-tt0903747/'));
  assert.ok(xml.includes('https://shevato.com/apps/rising-shows/shows/game-of-thrones-tt0944947/'));
  assert.ok(xml.includes('https://shevato.com/apps/rising-shows/shows/the-office-tt0386676/'));
});

test('renderShowsSitemap stamps lastmod from builtAt', () => {
  const xml = renderShowsSitemap(SERIES, '2026-05-18T12:34:56.000Z');
  assert.ok(xml.includes('<lastmod>2026-05-18</lastmod>'));
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

test('renderShowsIndex emits the count and links to every series', () => {
  const html = renderShowsIndex(SERIES, '2026-05-18T00:00:00.000Z');
  assert.ok(html.includes('3 shows'));
  assert.ok(html.includes('/apps/rising-shows/shows/breaking-bad-tt0903747/'));
  assert.ok(html.includes('/apps/rising-shows/shows/game-of-thrones-tt0944947/'));
  // "The Office" is alphabetized under O, not T
  assert.ok(html.includes('id="letter-O"'));
  assert.ok(html.includes('/apps/rising-shows/shows/the-office-tt0386676/'));
});
