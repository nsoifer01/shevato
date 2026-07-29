'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderShapeHub, selectHubShows, hubPath, SHAPE_SLUGS, HUB_LIMIT } = require('../scripts/render-shape-hub.js');

function makeShow(seriesId, title, seriesVotes, shapes, avgRating = 8.0) {
  return {
    seriesId,
    title,
    year: 2010,
    seriesVotes,
    seasons: [
      {
        season: 1,
        avgRating,
        shapes,
        episodes: [
          { episode: 1, rating: avgRating, votes: 100 },
          { episode: 2, rating: avgRating, votes: 100 },
        ],
      },
    ],
  };
}

const SERIES = [
  makeShow('tt0001', 'Slow One', 5000, ['slow-burn'], 8.4),
  makeShow('tt0002', 'Slow Two', 90000, ['slow-burn'], 8.1),
  makeShow('tt0003', 'Riser', 40000, ['rising'], 9.0),
  makeShow('tt0004', 'Shapeless', 70000, [], 7.0),
  // Dominant shape is shapes[0] of the highest-rated season, so this show
  // belongs to the rising hub only, never to slow-burn.
  makeShow('tt0005', 'Multi Shape', 60000, ['rising', 'slow-burn'], 8.8),
];

test('SHAPE_SLUGS covers the 13 shapes exactly once', () => {
  assert.equal(SHAPE_SLUGS.length, 13);
  assert.equal(new Set(SHAPE_SLUGS).size, 13);
});

test('hubPath builds the /shows/shape/<slug>/ URL', () => {
  assert.equal(hubPath('slow-burn'), '/apps/rising-shows/shows/shape/slow-burn/');
});

test('selectHubShows keeps only shows whose dominant shape matches', () => {
  const picked = selectHubShows(SERIES, 'slow-burn');
  assert.deepEqual(picked.map((s) => s.seriesId), ['tt0002', 'tt0001']);
  // A secondary shape must not pull a show onto a second hub.
  assert.ok(!picked.some((s) => s.seriesId === 'tt0005'));
  assert.deepEqual(selectHubShows(SERIES, 'rising').map((s) => s.seriesId), ['tt0005', 'tt0003']);
});

test('selectHubShows orders by IMDb votes descending', () => {
  const votes = selectHubShows(SERIES, 'slow-burn').map((s) => s.seriesVotes);
  assert.deepEqual(votes, [...votes].sort((a, b) => b - a));
});

test('selectHubShows caps the list at 100 shows', () => {
  const many = Array.from({ length: 250 }, (_, i) => makeShow(`tt9${i}`, `Show ${i}`, i, ['rebound']));
  const picked = selectHubShows(many, 'rebound');
  assert.equal(picked.length, HUB_LIMIT);
  assert.equal(picked.length, 100);
  assert.equal(picked[0].seriesVotes, 249);
});

test('renderShapeHub produces a valid HTML5 document', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.trim().endsWith('</html>'));
  assert.ok(html.includes('<title>Best Slow burn TV shows - Rising Shows</title>'));
  assert.ok(html.includes('<h1>Best Slow burn TV shows</h1>'));
});

test('renderShapeHub sets exactly one canonical matching its own URL', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  const canonicals = html.match(/<link rel="canonical"[^>]*>/g) || [];
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0], '<link rel="canonical" href="https://shevato.com/apps/rising-shows/shows/shape/slow-burn/">');
});

test('renderShapeHub links every member show and nothing else', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  const links = [...html.matchAll(/href="(\/apps\/rising-shows\/shows\/[a-z0-9-]+-tt\d+\/)"/g)].map((m) => m[1]);
  assert.deepEqual(links, [
    '/apps/rising-shows/shows/slow-two-tt0002/',
    '/apps/rising-shows/shows/slow-one-tt0001/',
  ]);
  assert.ok(html.includes('<span class="rank-num">1</span>'));
  assert.ok(html.includes('90,000 votes'));
});

test('renderShapeHub describes the shape and its count', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  assert.ok(html.includes('second half lifts off'));
  assert.ok(html.includes('These are the 2 most-voted shows'));
  assert.ok(/<meta name="description" content="The 2 best slow burn TV shows/.test(html));
});

test('renderShapeHub JSON-LD blocks all parse', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 2);
  const parsed = blocks.map((m) => JSON.parse(m[1]));
  assert.equal(parsed[0]['@type'], 'BreadcrumbList');
  assert.equal(parsed[0].itemListElement.at(-1).name, 'Slow burn');
  assert.equal(parsed[1]['@type'], 'CollectionPage');
  assert.equal(parsed[1].mainEntity.itemListElement.length, 2);
  assert.equal(parsed[1].mainEntity.itemListElement[0].url, 'https://shevato.com/apps/rising-shows/shows/slow-two-tt0002/');
});

test('renderShapeHub caps the JSON-LD ItemList at 25 while listing all 100', () => {
  const many = Array.from({ length: 250 }, (_, i) => makeShow(`tt9${i}`, `Show ${i}`, i, ['rebound']));
  const shows = selectHubShows(many, 'rebound');
  const html = renderShapeHub('rebound', shows, '2026-05-18T00:00:00.000Z');
  const collection = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)[1]
    .replace(/<\/?script[^>]*>/g, ''));
  assert.equal(collection.mainEntity.numberOfItems, 100);
  assert.equal(collection.mainEntity.itemListElement.length, 25);
  assert.equal((html.match(/class="rank-row"/g) || []).length, 100);
});

test('renderShapeHub navigates to the other 12 hubs and the A-Z index', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  const hubLinks = new Set([...html.matchAll(/href="(\/apps\/rising-shows\/shows\/shape\/[a-z-]+\/)"/g)].map((m) => m[1]));
  assert.equal(hubLinks.size, 12);
  assert.ok(!hubLinks.has('/apps/rising-shows/shows/shape/slow-burn/'));
  assert.ok(html.includes('<a class="shape-nav-all" href="/apps/rising-shows/shows/">'));
  // The explorer CTA stays on the app's conversion path.
  assert.ok(html.includes('href="/apps/rising-shows/#shape=slow-burn"'));
});

test('renderShapeHub links the homepage as /home, never bare /', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  assert.ok(html.includes('<a href="/home">Shevato</a>'));
  assert.equal((html.match(/href="\/"/g) || []).length, 0);
});

test('renderShapeHub stamps the build date and uses no em dashes', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T12:34:56.000Z');
  assert.ok(html.includes('Refreshed 2026-05-18'));
  assert.equal(html.includes('—'), false);
});

test('renderShapeHub renders every shape slug with real labels', () => {
  for (const slug of SHAPE_SLUGS) {
    const html = renderShapeHub(slug, [makeShow('tt1', 'Only One', 10, [slug])], null);
    assert.ok(html.includes(`href="/apps/rising-shows/#shape=${slug}"`), slug);
    // A missing label would leak the raw slug into the h1.
    assert.ok(!new RegExp(`<h1>Best ${slug} TV shows</h1>`).test(html), slug);
    assert.ok(/<h1>Best [A-Z]/.test(html), slug);
  }
});
