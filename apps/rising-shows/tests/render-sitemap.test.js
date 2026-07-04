'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderShowsSitemap } = require('../scripts/render-sitemap.js');
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
