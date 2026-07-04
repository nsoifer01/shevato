'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Load app.js into a vm context that stubs the browser globals it touches
// at parse + init time. We stop execution before load() does anything real
// by making fetch() reject immediately.
// ---------------------------------------------------------------------------

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

function makeContext(extra = {}) {
  const noopEl = () => {
    const el = {
      querySelector() { return noopEl(); },
      querySelectorAll() { return []; },
      getAttribute() { return null; },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      replaceChildren() {},
      appendChild() {},
      insertBefore() {},
      insertAdjacentElement() {},
      closest() { return null; },
      cloneNode() { return noopEl(); },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      style: {},
      dataset: {},
      hidden: true,
      textContent: '',
      value: '',
      disabled: false,
      children: [],
      firstChild: null,
      childElementCount: 0,
      // Template element content stub
      get content() {
        return {
          firstElementChild: { cloneNode() { return noopEl(); } },
        };
      },
    };
    return el;
  };

  const sandbox = {
    // Core JS globals
    console,
    Date, Math, JSON, Array, Object, Number, String, Boolean,
    Symbol, Map, Set, Promise, Error, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    parseInt, parseFloat, isFinite, isNaN,
    encodeURIComponent, decodeURIComponent,

    // Browser globals that app.js accesses at top level
    window: {},
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1024,
    document: {
      getElementById: () => noopEl(),
      querySelector: () => noopEl(),
      querySelectorAll: () => [],
      createElement: () => noopEl(),
      createElementNS: () => noopEl(),
      createTextNode: (t) => ({ textContent: t }),
      createDocumentFragment: () => {
        const frag = { childNodes: [], children: [], childElementCount: 0 };
        frag.appendChild = () => {};
        frag.replaceChildren = () => {};
        return frag;
      },
      body: {
        appendChild() {}, children: [], classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, style: {},
      },
      documentElement: { style: {} },
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
      };
    })(),
    location: { hash: '', href: 'http://localhost/', origin: 'http://localhost/' },
    history: { replaceState() {} },
    navigator: { clipboard: null, share: undefined, canShare: undefined },
    CSS: { escape: (s) => s },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    // Never-settling fetch so load()'s async chain never throws an unhandled rejection.
    fetch: () => new Promise(() => {}),
    ...extra,
  };
  // window self-reference
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

let ctx;
ctx = makeContext();
try {
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
} catch (e) {
  // Synchronous errors from load() (skeleton/DOM stubs) are expected.
}

const helpers = ctx._rsTestExports || {};

// ---------------------------------------------------------------------------
// Scroll restoration: clampScrollY
// The grid renders after data.json loads, so a restored offset must be clamped
// to the document height that actually exists once cards are appended.
// ---------------------------------------------------------------------------

test('clampScrollY: bottom-of-page offset survives when the page is tall enough', () => {
  // Stored at the bottom (4800) of a page whose max reachable scroll is 5000.
  assert.equal(helpers.clampScrollY(4800, 5000), 4800);
});

test('clampScrollY: offset is clamped down to a shorter rendered page', () => {
  // Stored deep (4800) but the rendered page only reaches 3000 — land at 3000,
  // not somewhere it can never reach.
  assert.equal(helpers.clampScrollY(4800, 3000), 3000);
});

test('clampScrollY: no stored offset (0 / non-finite) restores to top', () => {
  assert.equal(helpers.clampScrollY(0, 5000), 0);
  assert.equal(helpers.clampScrollY(NaN, 5000), 0);
});

test('clampScrollY: a non-scrollable page (maxScrollY <= 0) restores to top', () => {
  assert.equal(helpers.clampScrollY(800, 0), 0);
  assert.equal(helpers.clampScrollY(800, -50), 0);
});

// ---------------------------------------------------------------------------
// Feature 7: computeStdDev
// ---------------------------------------------------------------------------

test('computeStdDev: empty array returns 0', () => {
  assert.equal(helpers.computeStdDev([]), 0);
});

test('computeStdDev: single episode returns 0', () => {
  assert.equal(helpers.computeStdDev([{ rating: 8.0 }]), 0);
});

test('computeStdDev: [7.0,9.5,6.5,9.0] approx 1.27 (population std dev)', () => {
  const eps = [7.0, 9.5, 6.5, 9.0].map((r, i) => ({ episode: i + 1, rating: r }));
  const sd = helpers.computeStdDev(eps);
  // mean=8, sum_sq=(1+2.25+2.25+1)/4=1.625, sqrt(1.625)=1.2748
  assert.ok(Math.abs(sd - 1.27) < 0.02, `expected ~1.27, got ${sd}`);
});

test('computeStdDev: perfectly flat season returns 0', () => {
  const eps = [8.0, 8.0, 8.0].map((r) => ({ rating: r }));
  assert.equal(helpers.computeStdDev(eps), 0);
});

// ---------------------------------------------------------------------------
// computeShowRelated
// ---------------------------------------------------------------------------

const mkShowMatch = (seriesId, season, avgRating, seriesRating, genres = [], seriesVotes = 10000) => ({
  seriesId, season, avgRating, seriesRating, genres, seriesVotes,
  shapes: ['rising'], minVotes: 1000, episodes: [],
});

test('computeShowRelated: excludes self', () => {
  const matches = [
    mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']),
    mkShowMatch('tt002', 1, 8.5, 8.0, ['Drama']),
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.ok(!result.some((r) => r.seriesId === 'tt001'), 'should not include self');
});

test('computeShowRelated: excludes shows without seriesRating', () => {
  const matches = [
    mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']),
    { seriesId: 'tt002', season: 1, avgRating: 8.5, genres: ['Drama'], shapes: [], episodes: [], minVotes: 1000 },
    mkShowMatch('tt003', 1, 8.5, 8.0, ['Drama']),
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.ok(!result.some((r) => r.seriesId === 'tt002'), 'no seriesRating excluded');
  assert.equal(result.length, 1);
  assert.equal(result[0].seriesId, 'tt003');
});

test('computeShowRelated: excludes shows with no shared genre', () => {
  const matches = [
    mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']),
    mkShowMatch('tt002', 1, 8.5, 8.0, ['Comedy']),  // no shared genre
    mkShowMatch('tt003', 1, 8.5, 8.0, ['Drama']),
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.ok(!result.some((r) => r.seriesId === 'tt002'));
  assert.equal(result[0].seriesId, 'tt003');
});

test('computeShowRelated: returns empty when current show has no seriesRating', () => {
  const matches = [
    { seriesId: 'tt001', season: 1, avgRating: 8.5, genres: ['Drama'], shapes: [], episodes: [], minVotes: 1000 },
    mkShowMatch('tt002', 1, 8.5, 8.0, ['Drama']),
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.equal(result.length, 0);
});

test('computeShowRelated: requires the same language', () => {
  const matches = [
    { ...mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']), language: 'en' },
    { ...mkShowMatch('tt002', 1, 8.5, 8.0, ['Drama']), language: 'ja' }, // different
    { ...mkShowMatch('tt003', 1, 8.5, 8.0, ['Drama']), language: 'en' }, // same
    mkShowMatch('tt004', 1, 8.5, 8.0, ['Drama']),                        // missing != 'en'
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.equal(result.map((r) => r.seriesId).join(','), 'tt003');
});

test('computeShowRelated: mean votes/episode must be within 10x either way', () => {
  // Current show: mean minVotes = 1000 (mkShowMatch default) -> window 100..10000.
  const matches = [
    mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']),
    { ...mkShowMatch('tt002', 1, 8.5, 8.0, ['Drama']), minVotes: 99 },     // below window
    { ...mkShowMatch('tt003', 1, 8.5, 8.0, ['Drama']), minVotes: 100 },    // at lo edge
    { ...mkShowMatch('tt004', 1, 8.5, 8.0, ['Drama']), minVotes: 10000 },  // at hi edge
    { ...mkShowMatch('tt005', 1, 8.5, 8.0, ['Drama']), minVotes: 10001 },  // above window
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.equal(result.map((r) => r.seriesId).sort().join(','), 'tt003,tt004');
});

test('computeShowRelated: returns up to 10 results', () => {
  const matches = [
    mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']),
    ...Array.from({ length: 15 }, (_, i) =>
      mkShowMatch(`tt${100 + i}`, 1, 8.5, 8.0, ['Drama'], 10000 - i)),
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.ok(result.length <= 10, `got ${result.length}, expected <= 10`);
});

test('computeShowRelated: orders by deviation similarity (asc devDiff)', () => {
  // current: avg=8.5, seriesRating=8.0 => d=0.5
  // tt002: avg=8.6, seriesRating=8.0 => d=0.6, devDiff=0.1  (closer)
  // tt003: avg=9.0, seriesRating=8.0 => d=1.0, devDiff=0.5  (farther)
  const matches = [
    mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']),
    mkShowMatch('tt002', 1, 8.6, 8.0, ['Drama']),
    mkShowMatch('tt003', 1, 9.0, 8.0, ['Drama']),
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.equal(result[0].seriesId, 'tt002', 'closer deviation ranks first');
  assert.equal(result[1].seriesId, 'tt003');
});

test('computeShowRelated: tiebreak on shared genre count (desc)', () => {
  // current: d=0.5 (avg=8.5, seriesRating=8.0), genres=['Drama','Crime']
  // both candidates same devDiff
  const current = { seriesId: 'tt001', season: 1, avgRating: 8.5, seriesRating: 8.0, genres: ['Drama', 'Crime'], shapes: [], episodes: [], minVotes: 1000, seriesVotes: 10000 };
  const cand1 = { seriesId: 'tt002', season: 1, avgRating: 8.5, seriesRating: 8.0, genres: ['Drama'], shapes: [], episodes: [], minVotes: 1000, seriesVotes: 9000 };        // 1 shared genre
  const cand2 = { seriesId: 'tt003', season: 1, avgRating: 8.5, seriesRating: 8.0, genres: ['Drama', 'Crime'], shapes: [], episodes: [], minVotes: 1000, seriesVotes: 8000 }; // 2 shared genres
  const result = helpers.computeShowRelated('tt001', [current, cand1, cand2]);
  assert.equal(result[0].seriesId, 'tt003', 'more shared genres ranks first on tie');
});

test('computeShowRelated: _avg is set on results', () => {
  const matches = [
    mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']),
    mkShowMatch('tt002', 1, 8.0, 7.5, ['Drama']),
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.equal(result.length, 1);
  assert.ok(typeof result[0]._avg === 'number', '_avg should be set');
  assert.ok(Math.abs(result[0]._avg - 8.0) < 0.001);
});

// ---------------------------------------------------------------------------
// languagesCompatible: broadened language-group matching
// ---------------------------------------------------------------------------

test('languagesCompatible: ko and ja are compatible (Asian group)', () => {
  assert.equal(helpers.languagesCompatible('ko', 'ja'), true);
});

test('languagesCompatible: ko and en are NOT compatible', () => {
  assert.equal(helpers.languagesCompatible('ko', 'en'), false);
});

test('languagesCompatible: de and fr are compatible (European group)', () => {
  assert.equal(helpers.languagesCompatible('de', 'fr'), true);
});

test('languagesCompatible: es and pt are compatible (Romance group)', () => {
  assert.equal(helpers.languagesCompatible('es', 'pt'), true);
});

test('languagesCompatible: en matches en (English stays strict)', () => {
  assert.equal(helpers.languagesCompatible('en', 'en'), true);
});

test('languagesCompatible: en does NOT match fr (English stays strict)', () => {
  assert.equal(helpers.languagesCompatible('en', 'fr'), false);
});

test('languagesCompatible: unmapped language requires exact match', () => {
  // 'xx' is not in any group -> exact-match fallback.
  assert.equal(helpers.languagesCompatible('xx', 'xx'), true);
  assert.equal(helpers.languagesCompatible('xx', 'ja'), false);
  assert.equal(helpers.languagesCompatible('xx', 'en'), false);
});

test('languagesCompatible: two empty-string languages are compatible', () => {
  assert.equal(helpers.languagesCompatible('', ''), true);
  assert.equal(helpers.languagesCompatible(undefined, undefined), true);
});

test('languagesCompatible: mapped anchor does not match unmapped/empty candidate', () => {
  assert.equal(helpers.languagesCompatible('ko', ''), false);
  assert.equal(helpers.languagesCompatible('ko', 'xx'), false);
});

test('languagesCompatible: ar matches he (Middle Eastern group)', () => {
  assert.equal(helpers.languagesCompatible('ar', 'he'), true);
});

test('computeShowRelated: German anchor surfaces European-language candidates', () => {
  const matches = [
    { ...mkShowMatch('tt001', 1, 8.5, 8.0, ['Drama']), language: 'de' },
    { ...mkShowMatch('tt002', 1, 8.5, 8.0, ['Drama']), language: 'fr' }, // European — included
    { ...mkShowMatch('tt003', 1, 8.5, 8.0, ['Drama']), language: 'en' }, // not European — excluded
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.equal(result.map((r) => r.seriesId).join(','), 'tt002');
});

// ---------------------------------------------------------------------------
// Feature 1: buildSeasonShareText still returns a string
// ---------------------------------------------------------------------------

test('buildSeasonShareText: returns a non-empty string', () => {
  const m = {
    title: 'Breaking Bad',
    season: 5,
    seasonYear: 2013,
    year: 2008,
    seriesId: 'tt0903747',
    shapes: ['rising', 'big-finale'],
    firstRating: 8.1,
    lastRating: 9.9,
    avgRating: 9.0,
    episodes: [{ rating: 8.1 }, { rating: 9.9 }],
  };
  const text = helpers.buildSeasonShareText(m);
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(text.includes('Breaking Bad'));
  assert.ok(text.includes('Season 5'));
});

