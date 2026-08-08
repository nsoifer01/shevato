'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderShapeHub,
  renderGapHub,
  selectHubShows,
  selectGapHubShows,
  hubPath,
  SHAPE_SLUGS,
  HUB_SLUGS,
  HUB_LIMIT,
  GAP_HUB_SLUG,
  GAP_MIN_VOTES,
} = require('../scripts/render-shape-hub.js');

function makeShow(seriesId, title, seriesVotes, shapes, avgRating = 8.0, seriesRating = null) {
  return {
    seriesId,
    title,
    year: 2010,
    seriesVotes,
    seriesRating,
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

test('renderShapeHub navigates to the other 12 hubs, the gap hub and the A-Z index', () => {
  const html = renderShapeHub('slow-burn', selectHubShows(SERIES, 'slow-burn'), '2026-05-18T00:00:00.000Z');
  const hubLinks = new Set([...html.matchAll(/href="(\/apps\/rising-shows\/shows\/shape\/[a-z-]+\/)"/g)].map((m) => m[1]));
  assert.equal(hubLinks.size, 13);
  assert.ok(!hubLinks.has('/apps/rising-shows/shows/shape/slow-burn/'));
  assert.ok(hubLinks.has(hubPath(GAP_HUB_SLUG)));
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

// --- Gap hub (/shows/shape/outshines-reputation/) ---

const OVER_FLOOR = GAP_MIN_VOTES * 2;

// avgRating, then seriesRating: the gap is the difference between them.
const GAP_SERIES = [
  makeShow('tt1001', 'Modest Gap', OVER_FLOOR, ['rising'], 8.6, 7.9),
  makeShow('tt1002', 'Wide Gap', GAP_MIN_VOTES, ['rebound'], 9.0, 6.0),
  // Would top the ranking on gap alone, but nobody voted on it.
  makeShow('tt1003', 'Vote Noise', 451, ['rising'], 9.9, 1.3),
  makeShow('tt1004', 'Overrated', OVER_FLOOR, ['declining'], 7.0, 7.5),
  makeShow('tt1005', 'Dead Even', OVER_FLOOR, ['consistent'], 8.0, 8.0),
  makeShow('tt1006', 'No Series Rating', OVER_FLOOR, ['rising'], 9.5, null),
];

test('selectGapHubShows keeps only positive gaps above the vote floor', () => {
  const picked = selectGapHubShows(GAP_SERIES);
  assert.deepEqual(picked.map((s) => s.seriesId), ['tt1002', 'tt1001']);
  // A 451-vote show with a 8.6 gap must not be able to win the page.
  assert.ok(!picked.some((s) => s.seriesId === 'tt1003'));
  // Shows rated at or above their episodes have nothing to say here.
  assert.ok(!picked.some((s) => s.seriesId === 'tt1004' || s.seriesId === 'tt1005'));
  // No series rating means no gap to compute.
  assert.ok(!picked.some((s) => s.seriesId === 'tt1006'));
});

test('selectGapHubShows honours a caller-supplied vote floor', () => {
  const picked = selectGapHubShows(GAP_SERIES, 100, 400);
  assert.equal(picked[0].seriesId, 'tt1003');
  assert.equal(picked[0].gap, 8.6);
});

test('selectGapHubShows ranks strictly by descending gap and caps at 100', () => {
  // Gaps run 0.1 to 5.0 in input order, so a list that came back in input
  // order (or reversed) would fail the ordering assertion.
  const many = Array.from({ length: 150 }, (_, i) => makeShow(
    `tt2${i}`,
    `Show ${i}`,
    OVER_FLOOR,
    ['rising'],
    9.0,
    Math.round((9.0 - ((i % 50) + 1) / 10) * 10) / 10,
  ));
  const picked = selectGapHubShows(many);
  assert.equal(picked.length, HUB_LIMIT);
  const gaps = picked.map((s) => s.gap);
  assert.deepEqual(gaps, [...gaps].sort((a, b) => b - a));
  assert.equal(gaps[0], 5);
  // The cap drops the narrowest gaps, never a wider one.
  const keptIds = new Set(picked.map((s) => s.seriesId));
  const minKept = Math.min(...gaps);
  for (const s of many.filter((x) => !keptIds.has(x.seriesId))) {
    assert.ok(Math.round((9.0 - s.seriesRating) * 10) / 10 <= minKept, s.seriesId);
  }
});

test('selectGapHubShows breaks gap ties by votes then title', () => {
  const tied = [
    makeShow('tt3001', 'Zeta', 20000, ['rising'], 8.5, 8.0),
    makeShow('tt3002', 'Alpha', 20000, ['rising'], 8.5, 8.0),
    makeShow('tt3003', 'Popular', 90000, ['rising'], 8.5, 8.0),
  ];
  assert.deepEqual(selectGapHubShows(tied).map((s) => s.title), ['Popular', 'Alpha', 'Zeta']);
});

test('selectGapHubShows does not mutate the input series', () => {
  const input = [makeShow('tt4001', 'Once', OVER_FLOOR, ['rising'], 8.5, 8.0)];
  selectGapHubShows(input);
  assert.equal('gap' in input[0], false);
  assert.equal('avgEpisode' in input[0], false);
});

test('renderGapHub prints the gap itself in every rank-stats cell', () => {
  const html = renderGapHub(selectGapHubShows(GAP_SERIES), '2026-05-18T00:00:00.000Z');
  assert.ok(html.includes('<span class="rank-stats">avg episode 8.6 · IMDb 7.9 · +0.7 above IMDb</span>'));
  assert.ok(html.includes('<span class="rank-stats">avg episode 9.0 · IMDb 6.0 · +3.0 above IMDb</span>'));
  // The printed gap is the number that ranked the row, so it never disagrees
  // with the two ratings printed beside it.
  for (const m of html.matchAll(/avg episode ([\d.]+) · IMDb ([\d.]+) · \+([\d.]+) above IMDb/g)) {
    assert.equal((Number(m[1]) - Number(m[2])).toFixed(1), Number(m[3]).toFixed(1));
  }
});

test('renderGapHub states the vote floor in its own lede', () => {
  const html = renderGapHub(selectGapHubShows(GAP_SERIES), '2026-05-18T00:00:00.000Z');
  const lede = html.match(/<p class="lede">([\s\S]*?)<\/p>/)[1];
  assert.ok(lede.includes('at least 15,000 IMDb votes'), lede);
  assert.ok(lede.includes('The 2 biggest gaps'), lede);
});

test('renderGapHub is a valid HTML5 document with one canonical', () => {
  const html = renderGapHub(selectGapHubShows(GAP_SERIES), '2026-05-18T00:00:00.000Z');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.trim().endsWith('</html>'));
  assert.ok(html.includes('<h1>TV shows that outshine their reputation</h1>'));
  const canonicals = html.match(/<link rel="canonical"[^>]*>/g) || [];
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0], `<link rel="canonical" href="https://shevato.com${hubPath(GAP_HUB_SLUG)}">`);
  assert.ok(html.includes('Refreshed 2026-05-18'));
  assert.equal(html.includes('—'), false);
});

test('renderGapHub JSON-LD matches the shape hubs block for block', () => {
  const html = renderGapHub(selectGapHubShows(GAP_SERIES), '2026-05-18T00:00:00.000Z');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 2);
  const [crumbs, collection] = blocks.map((m) => JSON.parse(m[1]));
  assert.equal(crumbs['@type'], 'BreadcrumbList');
  assert.equal(crumbs.itemListElement.length, 5);
  assert.equal(crumbs.itemListElement.at(-1).name, 'Outshines its reputation');
  assert.equal(crumbs.itemListElement.at(-1).item, `https://shevato.com${hubPath(GAP_HUB_SLUG)}`);
  assert.equal(collection['@type'], 'CollectionPage');
  assert.equal(collection.name, 'TV shows that outshine their reputation');
  assert.equal(collection.mainEntity['@type'], 'ItemList');
  assert.equal(collection.mainEntity.numberOfItems, 2);
  assert.equal(collection.mainEntity.itemListElement[0].url, 'https://shevato.com/apps/rising-shows/shows/wide-gap-tt1002/');
});

test('renderGapHub keeps the JSON-LD ItemList at 25 while listing all 100', () => {
  const many = Array.from({ length: 150 }, (_, i) => makeShow(`tt5${i}`, `Show ${i}`, OVER_FLOOR, ['rising'], 9.0, 8.0));
  const shows = selectGapHubShows(many);
  const html = renderGapHub(shows, '2026-05-18T00:00:00.000Z');
  const collection = JSON.parse([...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)][1][1]);
  assert.equal(collection.mainEntity.numberOfItems, 100);
  assert.equal(collection.mainEntity.itemListElement.length, 25);
  assert.equal((html.match(/class="rank-row"/g) || []).length, 100);
});

test('renderGapHub cross-links the 13 shape hubs and the A-Z index', () => {
  const html = renderGapHub(selectGapHubShows(GAP_SERIES), '2026-05-18T00:00:00.000Z');
  const hubLinks = new Set([...html.matchAll(/href="(\/apps\/rising-shows\/shows\/shape\/[a-z-]+\/)"/g)].map((m) => m[1]));
  assert.equal(hubLinks.size, SHAPE_SLUGS.length);
  assert.ok(!hubLinks.has(hubPath(GAP_HUB_SLUG)));
  assert.ok(html.includes('<span class="shape-nav-current" aria-current="page">Outshines its reputation</span>'));
  assert.ok(html.includes('<a class="shape-nav-all" href="/apps/rising-shows/shows/">'));
  // The explorer CTA reproduces the same ranking in the app.
  assert.ok(html.includes('href="/apps/rising-shows/#sort=gap&amp;gapDir=up&amp;minVotes=15000"'));
});

test('HUB_SLUGS is the 13 shapes plus the gap hub', () => {
  assert.equal(HUB_SLUGS.length, SHAPE_SLUGS.length + 1);
  assert.deepEqual(HUB_SLUGS.slice(0, SHAPE_SLUGS.length), SHAPE_SLUGS);
  assert.equal(HUB_SLUGS.at(-1), GAP_HUB_SLUG);
  assert.equal(GAP_HUB_SLUG, 'outshines-reputation');
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
