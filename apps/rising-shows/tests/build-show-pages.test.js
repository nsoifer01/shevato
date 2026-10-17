'use strict';

// The static-page build itself (scripts/build-show-pages.js main), run end to
// end against a fixture catalogue in a temporary app root. Every renderer it
// calls has its own tests; what had none until 2026-10-17 is the build that
// wires them together: which shows get a page, that the tail gets none (its
// URLs answer 410, netlify.toml), that the A-Z lists every show exactly once,
// that the hubs and the sitemap are written, and that --only touches nothing
// but the one page. That orchestration had grown (#582, #609) with no test,
// which is what took the Rising Shows area under its coverage floor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('../scripts/build-show-pages.js');
const { showPath } = require('../scripts/slugify.js');
const { SHAPE_SLUGS, GAP_HUB_SLUG } = require('../scripts/render-shape-hub.js');

// Three shows in the real per-season shape (as tests/browser/suites/perf.mjs
// builds its fixture). seriesVotes decides which are curated.
function season(seriesId, title, votes, i, eps) {
  return {
    seriesId, title, year: 2015 + i, seasonYear: 2015 + i, type: 'tvSeries',
    genres: ['Drama'], season: i + 1,
    episodes: eps.map((rating, k) => ({ episode: k + 1, rating, votes: 1200 + k })),
    firstRating: eps[0], lastRating: eps[eps.length - 1],
    avgRating: eps.reduce((a, b) => a + b, 0) / eps.length,
    minVotes: 1200, shapes: i === 0 ? ['rising'] : ['big-finale'],
    confidence: i === 0 ? { rising: 0.8 } : { 'big-finale': 0.6 },
    avgRuntime: 45, seriesRating: 8.4, seriesVotes: votes,
    poster: null, overview: `${title} season ${i + 1}.`, language: 'en', providers: ['Netflix'],
  };
}
const SHOWS = [
  ['tt9000001', 'Fixture Alpha', 90000],
  ['tt9000002', 'Fixture Beta', 70000],
  ['tt9000003', 'Fixture Gamma', 10000],
];
const MATCHES = SHOWS.flatMap(([id, title, votes]) => [
  season(id, title, votes, 0, [7.1, 7.4, 7.8, 8.2]),
  season(id, title, votes, 1, [8.0, 8.1, 9.4]),
]);

function fixtureRoot({ extras = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-build-pages-'));
  fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({ builtAt: '2026-01-01T00:00:00.000Z', matches: MATCHES }));
  if (extras) {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'show-modal-extras.json'), JSON.stringify({
      tt9000001: { cast: [{ name: 'Fixture Actor', character: 'Lead' }], seasons: { 1: { eps: { 1: { n: 'Pilot' } } } } },
    }));
  }
  return root;
}
const page = (root, id, title) => path.join(root, 'shows', showPath(title, id), 'index.html');
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

test('a full build writes a page for each curated show and none for the tail', () => {
  const root = fixtureRoot();
  try {
    quiet(() => main({ root, showPageLimit: 2 }));
    assert.ok(fs.existsSync(page(root, 'tt9000001', 'Fixture Alpha')), 'most-voted show has a page');
    assert.ok(fs.existsSync(page(root, 'tt9000002', 'Fixture Beta')));
    assert.equal(fs.existsSync(page(root, 'tt9000003', 'Fixture Gamma')), false, 'the tail is not written (410)');

    const alpha = fs.readFileSync(page(root, 'tt9000001', 'Fixture Alpha'), 'utf8');
    assert.match(alpha, /Fixture Actor/, 'cast is merged from the extras file');
    assert.match(alpha, /Pilot/, 'episode names are merged back onto the season rows');

    // The A-Z lists every show, curated or not (the build throws otherwise).
    const letters = fs.readdirSync(path.join(root, 'shows', 'letter'), { recursive: true }).filter((f) => f.endsWith('index.html'));
    const listed = letters.map((f) => fs.readFileSync(path.join(root, 'shows', 'letter', f), 'utf8')).join('\n');
    for (const [, title] of SHOWS) assert.match(listed, new RegExp(title), `${title} is reachable from the A-Z`);
    assert.ok(fs.existsSync(path.join(root, 'shows', 'index.html')));

    for (const slug of [...SHAPE_SLUGS, GAP_HUB_SLUG]) {
      assert.ok(fs.existsSync(path.join(root, 'shows', 'shape', slug, 'index.html')), `hub ${slug}`);
    }
    const sitemap = fs.readFileSync(path.join(root, 'sitemap-shows.xml'), 'utf8');
    assert.match(sitemap, /fixture-alpha-tt9000001/);
    assert.doesNotMatch(sitemap, /tt9000003/, 'a show with no page is never in the sitemap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rebuild replaces the shows directory, so a show that left the curated set loses its page', () => {
  const root = fixtureRoot();
  try {
    quiet(() => main({ root, showPageLimit: 3 }));
    assert.ok(fs.existsSync(page(root, 'tt9000003', 'Fixture Gamma')));
    quiet(() => main({ root, showPageLimit: 2 }));
    assert.equal(fs.existsSync(page(root, 'tt9000003', 'Fixture Gamma')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--only writes that one page, byte-identical to the full build, and nothing else', () => {
  const full = fixtureRoot();
  const one = fixtureRoot();
  try {
    quiet(() => main({ root: full, showPageLimit: 2 }));
    quiet(() => main({ root: one, only: 'tt9000001', showPageLimit: 2 }));
    assert.equal(fs.readFileSync(page(one, 'tt9000001', 'Fixture Alpha'), 'utf8'),
      fs.readFileSync(page(full, 'tt9000001', 'Fixture Alpha'), 'utf8'));
    assert.deepEqual(fs.readdirSync(path.join(one, 'shows')), [showPath('Fixture Alpha', 'tt9000001')]);
    assert.equal(fs.existsSync(path.join(one, 'sitemap-shows.xml')), false);
    assert.throws(() => quiet(() => main({ root: one, only: 'tt0000000' })), /no series with that id/);
  } finally {
    fs.rmSync(full, { recursive: true, force: true });
    fs.rmSync(one, { recursive: true, force: true });
  }
});

test('a missing or shapeless data.json fails loudly, and a missing extras file is not fatal', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-build-pages-'));
  const bare = fixtureRoot({ extras: false });
  try {
    assert.throws(() => main({ root: empty }), /data\.json not found/);
    fs.writeFileSync(path.join(empty, 'data.json'), JSON.stringify({ builtAt: 'x' }));
    assert.throws(() => main({ root: empty }), /no `matches` array/);
    quiet(() => main({ root: bare, showPageLimit: 1 }));
    assert.doesNotMatch(fs.readFileSync(page(bare, 'tt9000001', 'Fixture Alpha'), 'utf8'), /Fixture Actor/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
