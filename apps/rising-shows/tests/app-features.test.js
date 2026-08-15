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

  // Web Storage stand-in. Values are stringified on the way in, exactly as the
  // real thing does, so `getItem` returning "640" rather than 640 is faithful.
  const makeStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
    };
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
    // Scroll restoration measures the reachable offset as
    // documentElement.scrollHeight - innerHeight, so both have to exist.
    innerHeight: 768,
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
      documentElement: { style: {}, scrollHeight: 0, scrollTop: 0 },
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: makeStorage(),
    // Per-tab storage: where the saved scroll offset lives.
    sessionStorage: makeStorage(),
    location: { hash: '', href: 'http://localhost/', origin: 'http://localhost' },
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
let loadError = null;
try {
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
} catch (e) {
  // Synchronous errors from load() (skeleton/DOM stubs) are expected AFTER the
  // export block runs. One thrown earlier - a missing browser global, a parse
  // error - leaves _rsTestExports undefined, and every assertion below would
  // then read a property of `{}` and pass on undefined. Fail loudly instead.
  loadError = e;
}

const helpers = ctx._rsTestExports || {};

assert.ok(
  Object.keys(helpers).length > 0,
  'app.js did not expose window._rsTestExports, so nothing in this file is actually under test. '
  + (loadError
    ? `app.js threw while loading: ${loadError.stack}`
    : 'app.js loaded without throwing; check the export block at the bottom of js/app.js.'),
);

// The vm harness can only reach helpers app.js explicitly exports. If one is
// dropped from that block, say so by name rather than failing later with
// "helpers.X is not a function".
test('vm harness: app.js exports every helper these tests drive', () => {
  const expected = [
    'ScrollMemory', 'buildSeasonShareText', 'clampScrollY', 'computeShowRelated',
    'computeStdDev', 'languagesCompatible', 'parseCompareParam',
  ];
  const missing = expected.filter((name) => helpers[name] == null);
  assert.deepEqual(missing, [], `js/app.js stopped exporting: ${missing.join(', ')}`);
});

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
  // Stored deep (4800) but the rendered page only reaches 3000 - land at 3000,
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
// Scroll restoration: ScrollMemory
// The saved offset is per tab (sessionStorage) and restored by hand, because
// the browser's own restoration runs while the page is still skeletons and
// clamps a bottom-of-page offset to that short height.
//
// These drive the real object against the sandbox globals it reads, so each
// test sets up the page it needs and puts the stubs back afterwards.
// ---------------------------------------------------------------------------

const SCROLL_KEY = 'rising-seasons:scroll';

function withPage({ hash = '', anchorFound = false, scrollHeight = 6000, scrollY = 0, scrollTop = 0, grow = null }, fn) {
  const saved = {
    hash: ctx.location.hash,
    getElementById: ctx.document.getElementById,
    scrollHeight: ctx.document.documentElement.scrollHeight,
    scrollTop: ctx.document.documentElement.scrollTop,
    scrollY: ctx.scrollY,
    scrollTo: ctx.scrollTo,
    raf: ctx.requestAnimationFrame,
  };
  const scrolledTo = [];
  const frames = [];
  ctx.location.hash = hash;
  ctx.document.getElementById = () => (anchorFound ? { id: 'real-anchor' } : null);
  ctx.document.documentElement.scrollHeight = scrollHeight;
  ctx.document.documentElement.scrollTop = scrollTop;
  ctx.scrollY = scrollY;
  ctx.scrollTo = (x, y) => scrolledTo.push(y);
  // Synchronous frames: restore()'s retry loop is bounded, so running it to
  // completion in-line keeps the assertions deterministic.
  ctx.requestAnimationFrame = (cb) => {
    frames.push(cb);
    if (grow) ctx.document.documentElement.scrollHeight = grow;
    cb();
    return frames.length;
  };
  try {
    return fn({ scrolledTo, frames });
  } finally {
    ctx.location.hash = saved.hash;
    ctx.document.getElementById = saved.getElementById;
    ctx.document.documentElement.scrollHeight = saved.scrollHeight;
    ctx.document.documentElement.scrollTop = saved.scrollTop;
    ctx.scrollY = saved.scrollY;
    ctx.scrollTo = saved.scrollTo;
    ctx.requestAnimationFrame = saved.raf;
    ctx.sessionStorage.clear();
  }
}

test('ScrollMemory: save stores the current offset under the app key', () => {
  withPage({ scrollY: 1240 }, () => {
    helpers.ScrollMemory.save();
    assert.equal(ctx.sessionStorage.getItem(SCROLL_KEY), '1240');
    assert.equal(helpers.ScrollMemory.read(), 1240);
  });
});

test('ScrollMemory: saving at the top clears the stored offset', () => {
  withPage({ scrollY: 0 }, () => {
    ctx.sessionStorage.setItem(SCROLL_KEY, '900');
    helpers.ScrollMemory.save();
    // Leaving 900 behind would yank a deliberate scroll-to-top back down.
    assert.equal(ctx.sessionStorage.getItem(SCROLL_KEY), null);
    assert.equal(helpers.ScrollMemory.read(), null);
  });
});

test('ScrollMemory: save falls back to documentElement.scrollTop', () => {
  withPage({ scrollY: 0, scrollTop: 640 }, () => {
    helpers.ScrollMemory.save();
    assert.equal(helpers.ScrollMemory.read(), 640);
  });
});

test('ScrollMemory: read returns null for nothing stored or a garbage value', () => {
  withPage({}, () => {
    assert.equal(helpers.ScrollMemory.read(), null);
    ctx.sessionStorage.setItem(SCROLL_KEY, 'not-a-number');
    assert.equal(helpers.ScrollMemory.read(), null);
  });
});

test('ScrollMemory: restore scrolls to the saved offset once the grid is tall enough', () => {
  // 6000 tall page, 768 viewport -> 5232 reachable, so 4800 is reachable.
  withPage({ scrollHeight: 6000 }, ({ scrolledTo, frames }) => {
    ctx.sessionStorage.setItem(SCROLL_KEY, '4800');
    helpers.ScrollMemory.restore();
    assert.deepEqual(scrolledTo, [4800]);
    assert.equal(frames.length, 0, 'no retry needed when the page already reaches the offset');
  });
});

test('ScrollMemory: restore clamps to a page that renders shorter than it did', () => {
  // Fewer results this time: 3000 tall, so the deepest reachable point is 2232.
  withPage({ scrollHeight: 3000 }, ({ scrolledTo }) => {
    ctx.sessionStorage.setItem(SCROLL_KEY, '4800');
    helpers.ScrollMemory.restore();
    assert.equal(scrolledTo[0], 2232);
  });
});

test('ScrollMemory: restore re-applies until the page finishes growing', () => {
  // The cards, fonts and SVG curves settle over a few frames after
  // replaceChildren, so the document is still short on the first attempt.
  withPage({ scrollHeight: 3000, grow: 9000 }, ({ scrolledTo }) => {
    ctx.sessionStorage.setItem(SCROLL_KEY, '4800');
    helpers.ScrollMemory.restore();
    assert.deepEqual(scrolledTo, [2232, 4800]);
  });
});

test('ScrollMemory: restore gives up after a bounded number of frames', () => {
  // A genuinely short result set can never reach the stored offset; retrying
  // forever would fight the user for the rest of the session.
  withPage({ scrollHeight: 3000 }, ({ scrolledTo, frames }) => {
    ctx.sessionStorage.setItem(SCROLL_KEY, '4800');
    helpers.ScrollMemory.restore();
    assert.equal(frames.length, 19);
    assert.equal(scrolledTo.length, 20);
    assert.ok(scrolledTo.every((y) => y === 2232));
  });
});

test('ScrollMemory: a real anchor in the hash wins over the saved offset', () => {
  withPage({ hash: '#season-3', anchorFound: true }, ({ scrolledTo }) => {
    ctx.sessionStorage.setItem(SCROLL_KEY, '4800');
    helpers.ScrollMemory.restore();
    assert.deepEqual(scrolledTo, [], 'deep link to an element must not be overridden');
  });
});

test('ScrollMemory: a filter hash is not an anchor, so the offset still restores', () => {
  // `#shape=rising&sort=gap` is the Finder's own state, not an element id.
  withPage({ hash: '#shape=rising&sort=gap', anchorFound: false }, ({ scrolledTo }) => {
    ctx.sessionStorage.setItem(SCROLL_KEY, '4800');
    helpers.ScrollMemory.restore();
    assert.deepEqual(scrolledTo, [4800]);
  });
});

test('ScrollMemory: restore does nothing when nothing was saved', () => {
  withPage({}, ({ scrolledTo }) => {
    helpers.ScrollMemory.restore();
    assert.deepEqual(scrolledTo, []);
  });
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
    { ...mkShowMatch('tt002', 1, 8.5, 8.0, ['Drama']), language: 'fr' }, // European - included
    { ...mkShowMatch('tt003', 1, 8.5, 8.0, ['Drama']), language: 'en' }, // not European - excluded
  ];
  const result = helpers.computeShowRelated('tt001', matches);
  assert.equal(result.map((r) => r.seriesId).join(','), 'tt002');
});

// ---------------------------------------------------------------------------
// Feature 1: buildSeasonShareText
// What "Share card" puts on the clipboard: a four-line summary ending in the
// season's static page URL, so the chat app that receives it can unfurl a
// poster. The whole point is the shape of those lines, not that a string came
// back, so pin them.
// ---------------------------------------------------------------------------

const SHARE_SEASON = {
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

test('buildSeasonShareText: title, shapes, stats, permalink - one per line', () => {
  const lines = helpers.buildSeasonShareText(SHARE_SEASON).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Breaking Bad - Season 5 (2013)');
  assert.equal(lines[1], 'Rising · Big finale');
  assert.equal(lines[2], 'Avg 9.0 · Climb 8.1 → 9.9 (+1.8) · 2 eps');
  // The static page, not the SPA hash: only that URL carries og:image.
  assert.equal(lines[3], 'http://localhost/apps/rising-shows/shows/breaking-bad-tt0903747/');
});

test('buildSeasonShareText: seasonYear beats the show year, and a missing one drops the parens', () => {
  const noSeasonYear = { ...SHARE_SEASON, seasonYear: null };
  assert.equal(helpers.buildSeasonShareText(noSeasonYear).split('\n')[0], 'Breaking Bad - Season 5 (2008)');
  const noYearAtAll = { ...SHARE_SEASON, seasonYear: null, year: null };
  assert.equal(helpers.buildSeasonShareText(noYearAtAll).split('\n')[0], 'Breaking Bad - Season 5');
});

test('buildSeasonShareText: a falling season prints a signed negative climb', () => {
  const falling = { ...SHARE_SEASON, firstRating: 9.0, lastRating: 7.5, avgRating: 8.25, shapes: [] };
  const lines = helpers.buildSeasonShareText(falling).split('\n');
  // No shape line at all when the season matched nothing, so the stats line
  // moves up rather than leaving a blank line in the pasted card.
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'Avg 8.3 · Climb 9.0 → 7.5 (-1.5) · 2 eps');
});

test('buildSeasonShareText: the series-level tag is not printed as a season shape', () => {
  // saved-best-for-last is a whole-show tag; naming it on a single season's
  // card reads as a claim about that season.
  const tagged = { ...SHARE_SEASON, shapes: ['saved-best-for-last', 'rising'] };
  assert.equal(helpers.buildSeasonShareText(tagged).split('\n')[1], 'Rising');
});

// ---------------------------------------------------------------------------
// Shared compare sets: the `compare=` hash param
// A shared link is untrusted input, so parsing must never hand the compare
// modal more shows than Compare.add would have allowed, and never the same
// show twice.
// ---------------------------------------------------------------------------

test('parseCompareParam: keeps the hash order', () => {
  assert.equal(
    helpers.parseCompareParam('tt0903747,tt0944947,tt4574334').join(','),
    'tt0903747,tt0944947,tt4574334',
  );
});

test('parseCompareParam: caps a hand-edited link at the compare limit of 5', () => {
  const ids = helpers.parseCompareParam('tt1,tt2,tt3,tt4,tt5,tt6,tt7');
  assert.equal(ids.length, 5);
  assert.equal(ids.join(','), 'tt1,tt2,tt3,tt4,tt5');
});

test('parseCompareParam: drops duplicates and blanks, trims whitespace', () => {
  assert.equal(helpers.parseCompareParam('tt1, tt2 ,,tt1,').join(','), 'tt1,tt2');
});

test('parseCompareParam: empty or non-string input yields an empty set', () => {
  assert.equal(helpers.parseCompareParam('').length, 0);
  assert.equal(helpers.parseCompareParam(null).length, 0);
  assert.equal(helpers.parseCompareParam(undefined).length, 0);
});

