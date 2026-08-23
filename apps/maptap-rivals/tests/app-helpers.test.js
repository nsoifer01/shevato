'use strict';

// Unit tests for pure helpers that live inside js/app.js's IIFE, reached
// through the window._testExports seam at the bottom of that file (same
// pattern as rising-shows' _rsTestExports). node:vm loads app.js into a
// sandbox that stubs the browser globals it touches at parse time:
// document.readyState stays 'loading' so init() is deferred onto a
// DOMContentLoaded listener that never fires, fetch never settles, and
// localStorage is a Map-backed stand-in seeded per context so state-reading
// helpers (rivalSummary) see a known game log.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const MapTapStats = require('../js/stats.js');
const MapTapNetwork = require('../js/network.js');

// Objects built inside the vm context carry that realm's prototypes, which
// assert.deepEqual (strict) rejects as "same structure but not
// reference-equal". Project them onto host-realm plain data first.
const plain = (x) => JSON.parse(JSON.stringify(x));

function noopEl() {
  const el = {
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { el.attrs = el.attrs || {}; el.attrs[k] = v; },
    getAttribute(k) { return (el.attrs || {})[k] ?? null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    replaceChildren() { el.children.length = 0; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
  };
  return el;
}

const makeStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
};

// `seed` maps localStorage keys to values (objects are stringified), applied
// BEFORE app.js runs so its module-level `state` loads them.
function loadApp(seed = {}) {
  const localStorage = makeStorage();
  for (const [k, v] of Object.entries(seed)) {
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const sandbox = {
    console,
    Date, Math, JSON, Array, Object, Number, String, Boolean,
    Symbol, Map, Set, Promise, Error, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    parseInt, parseFloat, isFinite, isNaN,
    encodeURIComponent, decodeURIComponent,
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    document: {
      readyState: 'loading', // defers init() onto a listener that never fires
      // FIREBASE_CONFIG_URL resolves against the script URL or the page base
      // at parse time, so both have to exist.
      currentScript: null,
      baseURI: 'http://localhost/apps/maptap-rivals/',
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => noopEl(),
      createTextNode: (t) => ({ textContent: t }),
      body: noopEl(),
      documentElement: noopEl(),
    },
    localStorage,
    location: { hash: '', href: 'http://localhost/', origin: 'http://localhost' },
    history: { replaceState() {} },
    navigator: { clipboard: null },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: () => new Promise(() => {}), // never settles
  };
  sandbox.window = sandbox;
  sandbox.window.MapTapStats = MapTapStats;
  sandbox.window.MapTapNetwork = MapTapNetwork;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
  return ctx;
}

let loadError = null;
let ctx;
try {
  ctx = loadApp();
} catch (e) {
  loadError = e;
}
const helpers = (ctx && ctx._testExports) || {};

// If app.js throws before the export block at the bottom runs, every helper
// below would be undefined and the assertions would fail confusingly - fail
// loudly at the harness level instead.
assert.ok(
  Object.keys(helpers).length > 0,
  'app.js did not expose window._testExports, so nothing in this file is actually under test. '
  + (loadError
    ? `app.js threw while loading: ${loadError.stack}`
    : 'app.js loaded without throwing; check the export block at the bottom of js/app.js.'),
);

test('vm harness: app.js exports every helper these tests drive', () => {
  const expected = [
    'classifyContinent', 'continentBreakdown', 'computeMatrixCell',
    'mergeMatrixCells', 'matrixCellViewModel', 'rivalSummary', 'upsertPastedGame',
    'sanitizeBackup', 'liveGames', 'orphanGames', 'isValidISODate', 'localISO',
    'addDaysISO', 'buildHeatmapWeeks', 'parseWhatsAppText', 'dayBucketDate',
    'rivalNameHint',
  ];
  const missing = expected.filter((name) => helpers[name] == null);
  assert.deepEqual(missing, [], `js/app.js stopped exporting: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// classifyContinent: the real bounding-box table, previously unreachable from
// node. The tricky cases below are the FINDINGS-documented ones.
// ---------------------------------------------------------------------------

test('classifyContinent: Hawaii is Oceania, Mexican Baja stays North America', () => {
  // The strict lng < -140 cutoff separates the two: Honolulu (-157.8) is a
  // Pacific island, Cabo San Lucas (-109.9) is the continent.
  assert.equal(helpers.classifyContinent(21.3, -157.8), 'Oceania');
  assert.equal(helpers.classifyContinent(22.9, -109.9), 'North America');
});

test('classifyContinent: Greenland is North America, Iceland is Europe', () => {
  assert.equal(helpers.classifyContinent(72, -40), 'North America');
  assert.equal(helpers.classifyContinent(64.1, -21.9), 'Europe'); // Reykjavik
});

test('classifyContinent: non-finite input classifies as Unknown, never a continent', () => {
  assert.equal(helpers.classifyContinent(NaN, NaN), 'Unknown');
  assert.equal(helpers.classifyContinent(48, NaN), 'Unknown');
  assert.equal(helpers.classifyContinent(NaN, 2), 'Unknown');
  assert.equal(helpers.classifyContinent(Infinity, 0), 'Unknown');
});

test('classifyContinent: a genuine (0, 0) is Africa (Gulf of Guinea box)', () => {
  assert.equal(helpers.classifyContinent(0, 0), 'Africa');
});

test('classifyContinent: below 60S falls through to Other (no Antarctica bucket)', () => {
  // Owner call 2026-08-15: sub-polar rounds fold into "Other".
  assert.equal(helpers.classifyContinent(-70, 0), 'Other');
  assert.equal(helpers.classifyContinent(-70, 170), 'Other');
  assert.equal(helpers.classifyContinent(-89, -60), 'Other');
});

// ---------------------------------------------------------------------------
// continentBreakdown: the per-rival aggregate shares the coordNum contract
// with stats.js's myAvgByContinent - coordinate-less rounds are excluded,
// never bucketed (the null-coords-becomes-Africa defect, fixed 2026-08-15).
// ---------------------------------------------------------------------------

test('continentBreakdown: null / empty-string coordinates are excluded, not Africa', () => {
  const game = {
    id: 'a', rivalId: 'r1', date: '2026-08-01',
    myScores: [90, 60, 90, 0, 0], theirScores: [10, 10, 10, 10, 10],
    cities: [
      { lat: 48.9, lng: 2.4 }, { lat: 52.5, lng: 13.4 }, { lat: 41.9, lng: 12.5 },
      { lat: null, lng: null }, { lat: '', lng: '' },
    ],
  };
  const { rows, totalRounds } = helpers.continentBreakdown([game]);
  assert.equal(totalRounds, 3);
  assert.deepEqual(plain(rows.map(r => [r.continent, r.rounds])), [['Europe', 3]]);
  assert.equal(rows.some(r => r.continent === 'Africa' || r.continent === 'Unknown'), false);
});

test('continentBreakdown: aggregates per continent over finite-coordinate rounds', () => {
  const game = {
    id: 'a', rivalId: 'r1', date: '2026-08-01',
    myScores: [90, 80, 60, 40, 100], theirScores: [50, 90, 60, 20, 10],
    cities: [
      { lat: 48.9, lng: 2.4 }, { lat: 52.5, lng: 13.4 },   // Europe
      { lat: 40.7, lng: -74 }, { lat: 34.1, lng: -118.2 }, // North America
      { lat: 35.7, lng: 139.7 },                           // Asia
    ],
  };
  const { rows, totalRounds } = helpers.continentBreakdown([game]);
  assert.equal(totalRounds, 5);
  const europe = rows.find(r => r.continent === 'Europe');
  assert.equal(europe.rounds, 2);
  assert.equal(europe.myAvg, 85);
  assert.equal(europe.myWins, 1);   // 90 > 50
  assert.equal(europe.theirWins, 1); // 80 < 90
});

// ---------------------------------------------------------------------------
// computeMatrixCell / mergeMatrixCells: the confusion-matrix joins.
// byRival: Map(rivalId -> Map(date -> { mine, theirs })).
// ---------------------------------------------------------------------------

const byRivalFixture = () => new Map([
  ['r1', new Map([
    ['2026-08-01', { mine: 700, theirs: 500 }],
    ['2026-08-02', { mine: 400, theirs: 600 }],
    ['2026-08-03', { mine: 500, theirs: 500 }],
  ])],
  ['r2', new Map([
    ['2026-08-02', { mine: 400, theirs: 300 }],
    ['2026-08-04', { mine: 800, theirs: 900 }],
  ])],
]);

test('computeMatrixCell: you vs a rival covers every meeting with that rival', () => {
  const cell = helpers.computeMatrixCell({ type: 'you' }, { type: 'rival', id: 'r1' }, byRivalFixture());
  assert.equal(cell.games, 3);
  assert.deepEqual([cell.wins, cell.losses, cell.ties], [1, 1, 1]);
  assert.equal(cell.rowTotal, 700 + 400 + 500);
  assert.equal(cell.colTotal, 500 + 600 + 500);
  assert.equal(cell.bestMargin, 200);
  assert.equal(cell.worstMargin, -200);
  // Meetings come out sorted by date whatever the map iteration order.
  assert.deepEqual(plain(cell.meetings.map(m => m.date)), ['2026-08-01', '2026-08-02', '2026-08-03']);
});

test('computeMatrixCell: rival vs rival joins on shared dates only', () => {
  // r1 and r2 both logged only 2026-08-02; the other three dates have no
  // counterpart and must not fabricate a meeting.
  const cell = helpers.computeMatrixCell({ type: 'rival', id: 'r1' }, { type: 'rival', id: 'r2' }, byRivalFixture());
  assert.equal(cell.games, 1);
  assert.deepEqual(plain(cell.meetings), [{ date: '2026-08-02', rowScore: 600, colScore: 300 }]);
  assert.deepEqual([cell.wins, cell.losses, cell.ties], [1, 0, 0]);
});

test('computeMatrixCell: a rival with no games yields an empty cell, you-vs-you yields null', () => {
  const empty = helpers.computeMatrixCell({ type: 'rival', id: 'r1' }, { type: 'rival', id: 'ghost' }, byRivalFixture());
  assert.equal(empty.games, 0);
  assert.equal(empty.bestMargin, null);
  assert.equal(helpers.computeMatrixCell({ type: 'you' }, { type: 'you' }, byRivalFixture()), null);
});

test('mergeMatrixCells: sums records, keeps extreme margins, re-sorts meetings by date', () => {
  const byRival = byRivalFixture();
  const c1 = helpers.computeMatrixCell({ type: 'you' }, { type: 'rival', id: 'r1' }, byRival);
  const c2 = helpers.computeMatrixCell({ type: 'you' }, { type: 'rival', id: 'r2' }, byRival);
  const merged = helpers.mergeMatrixCells([c1, null, c2]); // null cells are skipped
  assert.equal(merged.games, 5);
  assert.deepEqual([merged.wins, merged.losses, merged.ties], [2, 2, 1]);
  assert.equal(merged.bestMargin, 200);
  assert.equal(merged.worstMargin, -200);
  assert.deepEqual(plain(merged.meetings.map(m => m.date)),
    ['2026-08-01', '2026-08-02', '2026-08-02', '2026-08-03', '2026-08-04']);
});

test('matrixCellViewModel: margin sub-tab tones by average margin and titles the extremes', () => {
  const cell = helpers.computeMatrixCell({ type: 'you' }, { type: 'rival', id: 'r1' }, byRivalFixture());
  const vm_ = helpers.matrixCellViewModel(cell, 'margin', { label: 'You' }, { label: 'Ann' });
  assert.equal(vm_.tone, 'tie'); // margins +200, -200, 0 average to exactly 0
  assert.match(vm_.title, /You vs Ann/);
  assert.match(vm_.title, /best \+200/);
  assert.match(vm_.title, /worst -200/);
  assert.equal(vm_.content.length, 2);
});

// ---------------------------------------------------------------------------
// rivalSummary: reads the module-level state, so seed localStorage before the
// vm loads app.js. Only date-independent fields are asserted (last7/last30
// depend on the wall clock).
// ---------------------------------------------------------------------------

test('rivalSummary: counts only H2H games of that rival; rival-only days tracked separately', () => {
  const rival = { id: 'r1', name: 'Ann', color: '#fff', icon: 'A', createdAt: 1 };
  const seeded = loadApp({
    maptapRivalsRivals: [rival, { id: 'r2', name: 'Bea', color: '#fff', icon: 'B', createdAt: 2 }],
    maptapRivalsGames: [
      // r1: a win, a loss, and a rival-only day (no my side - carries no W/L).
      { id: 'g1', rivalId: 'r1', date: '2026-08-01', myScore: 700, theirScore: 500, createdAt: 1 },
      { id: 'g2', rivalId: 'r1', date: '2026-08-02', myScore: 400, theirScore: 600, createdAt: 2 },
      { id: 'g3', rivalId: 'r1', date: '2026-08-03', theirScore: 800, createdAt: 3 },
      // r2's game must not leak into r1's summary.
      { id: 'g4', rivalId: 'r2', date: '2026-08-01', myScore: 100, theirScore: 900, createdAt: 4 },
    ],
    maptapRivalsMe: JSON.stringify('Me'),
  });
  const s = seeded._testExports.rivalSummary(rival);
  assert.equal(s.total, 2);                 // H2H games only
  assert.deepEqual([s.wins, s.losses, s.ties], [1, 1, 0]);
  assert.equal(s.allGames.length, 3);       // every day the rival appears in
  assert.equal(s.rivalOnlyGames.length, 1);
  assert.equal(s.rivalOnlyGames[0].id, 'g3');
  assert.equal(s.winPct, 0.5);
  assert.equal(s.bestMine, 700);
  assert.equal(s.worstMine, 400);
  assert.equal(s.biggestWinMargin, 200);
  assert.equal(s.biggestLossMargin, 200);
  assert.equal(s.cumDiff, (700 + 400) - (500 + 600));
});

test('rivalSummary: a rival with no games reports zeros, not NaN', () => {
  const rival = { id: 'r9', name: 'Nobody', color: '#fff', icon: 'N', createdAt: 1 };
  const seeded = loadApp({ maptapRivalsRivals: [rival], maptapRivalsGames: [] });
  const s = seeded._testExports.rivalSummary(rival);
  assert.equal(s.total, 0);
  assert.equal(s.winPct, 0);
  assert.equal(s.bestMine, 0);
  assert.equal(s.myAvgAll, 0);
});

// ---------------------------------------------------------------------------
// upsertPastedGame: the saveDay dedupe (defect 1, fixed 2026-08-15). One
// record per (rivalId, date): a repeat paste updates in place.
// ---------------------------------------------------------------------------

const pastedGame = (over = {}) => ({
  id: 'new-id', rivalId: 'r1', date: '2026-08-01',
  myScores: [80, 90, 70, 60, 50], theirScores: [70, 80, 60, 50, 40],
  myScore: 700, theirScore: 600, note: '', createdAt: 2000,
  ...over,
});

test('upsertPastedGame: first save of a (rival, date) appends', () => {
  const games = [];
  const res = helpers.upsertPastedGame(games, pastedGame());
  assert.equal(res.updated, false);
  assert.equal(games.length, 1);
  assert.equal(res.game, games[0]);
});

test('upsertPastedGame: re-pasting the same (rival, date) updates in place, never duplicates', () => {
  const existing = {
    id: 'old-id', rivalId: 'r1', date: '2026-08-01',
    myScores: [10, 10, 10, 10, 10], theirScores: [20, 20, 20, 20, 20],
    myScore: 100, theirScore: 200, note: 'synced from MapTap', createdAt: 1000,
    cities: [{ lat: 48, lng: 2 }, { lat: 52, lng: 13 }, { lat: 41, lng: 12 },
             { lat: 35, lng: 139 }, { lat: 40, lng: -74 }],
  };
  const games = [existing];
  const res = helpers.upsertPastedGame(games, pastedGame());
  assert.equal(res.updated, true);
  assert.equal(games.length, 1);            // no second record
  assert.equal(res.game, existing);         // the stored object was corrected
  assert.deepEqual(existing.myScores, [80, 90, 70, 60, 50]);
  assert.equal(existing.myScore, 700);
  assert.equal(existing.theirScore, 600);
  assert.equal(existing.id, 'old-id');      // identity survives
  assert.equal(existing.createdAt, 1000);
  assert.equal(existing.cities.length, 5);  // synced geo data survives
  // The origin marker is shed: profile sync only overwrites games noted
  // 'synced from MapTap', so a manual correction must not keep that note or
  // the next sync would clobber it back.
  assert.equal(existing.note, '');
});

test('upsertPastedGame: a different date or rival is a new record, not an update', () => {
  const games = [pastedGame({ id: 'a' })];
  helpers.upsertPastedGame(games, pastedGame({ id: 'b', date: '2026-08-02' }));
  helpers.upsertPastedGame(games, pastedGame({ id: 'c', rivalId: 'r2' }));
  assert.equal(games.length, 3);
});

// ---------------------------------------------------------------------------
// 2026-08-22 site-wide audit regressions. Each block names the defect it pins.
// ---------------------------------------------------------------------------

const H = (name) => (...a) => plain(helpers[name](...a));
const goodRival = (o = {}) => ({ id: 'r1', name: 'Bob', color: '#e74c3c', icon: '🦊', createdAt: 1, maptapUsername: '', ...o });
const goodGame = (o = {}) => ({ id: 'g1', rivalId: 'r1', date: '2026-08-01', note: '', myScores: [1, 2, 3, 4, 5], theirScores: [5, 4, 3, 2, 1], myScore: 36, theirScore: 24, createdAt: 1, ...o });

// D1: the junk file from the audit used to be persisted verbatim and then
// crash every view (and every later page load). The sanitiser keeps the two
// readable entries, rejects the rest with reasons, and assigns the missing id.
test('sanitizeBackup (D1): junk entries are rejected with reasons, readable ones survive, nothing throws', () => {
  const parsed = {
    rivals: [null, 1, { id: 'q' }, { id: 'q2', name: 'Dup' }, { id: 'q2', name: 'Dup again' }, { name: 'NoId' }],
    games: [null, {}, { rivalId: 'q2', date: '2026-08-01', myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5] },
      { rivalId: 'q2', date: 'not-a-date', myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5] },
      { rivalId: 'q2', date: '2026-02-30', myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5] },
      { rivalId: 'q2', date: '2026-08-02', myScores: [null, 'x', 50, 50, 50], theirScores: [1, 2, 3, 4, 5] },
      { rivalId: 'q2', date: '2026-08-03', myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5], myScore: 'abc' }],
    me: { evil: 1 },
  };
  const r = H('sanitizeBackup')(parsed);
  assert.deepEqual(r.data.rivals.map(x => x.name), ['Dup', 'NoId']);
  assert.ok(r.data.rivals[1].id, 'a missing rival id is assigned');
  assert.equal(r.data.games.length, 1);
  assert.equal(r.data.games[0].date, '2026-08-01');
  assert.ok(r.data.games[0].id, 'a missing game id is assigned');
  assert.equal(r.data.games[0].myScore, 36, 'the total is derived from the rounds');
  assert.equal(r.rejected.length, 10, r.rejected.join(' | '));
  assert.ok(r.rejected.some(x => /not-a-date/.test(x)));
  assert.ok(r.rejected.some(x => /2026-02-30/.test(x)), 'Feb 30 is not a date');
  assert.ok(r.rejected.some(x => /duplicate id/.test(x)));
  assert.ok(r.rejected.some(x => /round scores/.test(x)));
  assert.ok(r.rejected.some(x => /myScore is not a number/.test(x)));
  assert.ok(r.repaired.some(x => /assigned an id/.test(x)));
});

test('sanitizeBackup (D1): a __proto__ rival id / date / top-level key cannot pollute anything', () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":1},"rivals":[{"id":"__proto__","name":"P"}],"games":[{"rivalId":"__proto__","date":"2026-08-01","myScores":[1,2,3,4,5],"theirScores":[1,2,3,4,5]}]}');
  const r = H('sanitizeBackup')(parsed);
  assert.equal(r.data.rivals[0].id, '__proto__');
  assert.equal(r.data.games[0].rivalId, '__proto__');
  assert.equal(({}).polluted, undefined);
  assert.equal(r.rejected.length, 0);
});

test('sanitizeBackup (D1): a legacy totals-only game and a rival-only synced day survive unchanged', () => {
  const legacy = { id: 'legacy1', rivalId: 'r1', date: '2026-02-14', note: '', myScore: 700, theirScore: 650, createdAt: 1 };
  const rivalOnly = { id: 'dnp', rivalId: 'r1', date: '2026-08-20', note: 'synced from MapTap', theirScores: [90, 90, 90, 90, 90], theirScore: 900, createdAt: 1 };
  const r = H('sanitizeBackup')({ rivals: [goodRival()], games: [legacy, rivalOnly] });
  assert.deepEqual(r.data.games, [legacy, rivalOnly]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.repaired, []);
});

test('sanitizeBackup (D1): a real export round-trips byte-for-byte (nothing "repaired" on clean data)', () => {
  const exportFile = { version: 1, exportedAt: '2026-08-23T00:41:00.418Z', me: 'Nik', myIcon: '🐸',
    rivals: [goodRival(), goodRival({ id: 'r2', name: 'Carol', icon: '🐻' })],
    games: [goodGame(), goodGame({ id: 'g2', rivalId: 'r2', date: '2026-08-02', cities: [{ lat: 1, lng: 2 }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 }] })] };
  const r = H('sanitizeBackup')(exportFile);
  assert.deepEqual(r.data.rivals, exportFile.rivals);
  assert.deepEqual(r.data.games, exportFile.games);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.repaired, []);
});

test('sanitizeBackup (D1): stringy numbers are repaired with a disclosure, not rejected', () => {
  const r = H('sanitizeBackup')({ rivals: [goodRival()], games: [goodGame({ myScores: ['1', '2', '3', '4', '5'], myScore: '36' })] });
  assert.deepEqual(r.data.games[0].myScores, [1, 2, 3, 4, 5]);
  assert.equal(r.data.games[0].myScore, 36);
  assert.ok(r.repaired.length >= 1);
  assert.deepEqual(r.rejected, []);
});

// D16: a corrupted stored array (an object, null entries) used to crash
// rendering; boot now runs the same sanitiser, so state holds what survives.
test('boot (D16): corrupted maptapRivalsGames / maptapRivalsRivals fall back to what survives', () => {
  const c = loadApp({
    maptapRivalsRivals: [goodRival(), null, 'str', 5],
    maptapRivalsGames: '{"a":1}',
  });
  const s = plain(c._testExports.rivalSummary(goodRival()));
  assert.equal(s.total, 0, 'the object-shaped game log reads as empty, not as a crash');
  const c2 = loadApp({ maptapRivalsGames: [null, 'x', goodGame()], maptapRivalsRivals: [goodRival()] });
  assert.equal(plain(c2._testExports.rivalSummary(goodRival())).total, 1);
});

// D2: one selector decides which games count anywhere outside a rival's own view.
test('liveGames / orphanGames (D2): a game whose rival is gone counts nowhere', () => {
  const rivals = [goodRival(), goodRival({ id: 'r2', name: 'Carol' })];
  const games = [goodGame(), goodGame({ id: 'g2', rivalId: 'r2' }), goodGame({ id: 'g3', rivalId: 'ghost' }), goodGame({ id: 'g4', rivalId: 'ghost' })];
  assert.deepEqual(H('liveGames')(games, rivals).map(g => g.id), ['g1', 'g2']);
  assert.deepEqual(H('orphanGames')(games, rivals).map(g => g.id), ['g3', 'g4']);
  assert.deepEqual(H('liveGames')(games, []), []);
});

// D6 / D15: the heatmap walk. Dates are validated before the walk, and every
// ISO string in it comes from the local calendar, so UTC+ zones neither gain
// a blank leading week nor stop at yesterday.
test('isValidISODate (D6): only real calendar dates pass', () => {
  const v = helpers.isValidISODate;
  assert.equal(v('2026-08-22'), true);
  assert.equal(v('2024-02-29'), true);
  assert.equal(v('2026-02-30'), false);
  assert.equal(v('not-a-date'), false);
  assert.equal(v('__proto__'), false);
  assert.equal(v('2026-8-2'), false);
  assert.equal(v(20260822), false);
  assert.equal(v(null), false);
});

for (const tz of ['America/Chicago', 'Asia/Jerusalem', 'Pacific/Kiritimati']) {
  test(`buildHeatmapWeeks / addDaysISO (D15) under TZ=${tz}: starts on a Sunday, ends on today, no UTC drift`, () => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      // Re-evaluate app.js under this zone: the vm context shares the host
      // Date, and Node re-reads TZ on change.
      const c = loadApp();
      const h = c._testExports;
      assert.equal(h.addDaysISO('2026-08-22', 1), '2026-08-23');
      assert.equal(h.addDaysISO('2026-08-22', -1), '2026-08-21');
      assert.equal(h.addDaysISO('2026-01-01', -1), '2025-12-31');
      assert.equal(h.localISO(new Date('2026-08-22T00:00:00')), '2026-08-22');
      const { weeks, startISO } = plain(h.buildHeatmapWeeks('2026-07-15', '2026-08-23'));
      assert.equal(startISO, '2026-07-12', 'snapped back to the Sunday before the first game');
      assert.equal(weeks[0][0], '2026-07-12');
      assert.equal(weeks[0].length, 7, 'the first column is a full week (no blank leading week)');
      const last = weeks[weeks.length - 1];
      assert.equal(last[last.length - 1], '2026-08-23', 'the walk reaches today');
      assert.equal(weeks.length, 7);
      assert.equal(weeks.flat().length, 43);
      assert.equal(new Set(weeks.flat()).size, 43, 'no duplicated or skipped day');
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  });
}

// D7: every header shape WhatsApp writes. The six fixtures are the audit's.
const WA_BODY = 'MapTap #400\nAug 20\n95 89 91 9 64\nFinal score: 585\nmaptap.gg';
function waFile(header1, header2) {
  return `${header1} Bob: ${WA_BODY}\n${header2} Nik: ${WA_BODY.replace('95 89', '90 80')}\n`;
}
const WA_FORMATS = [
  ['Android US 24h',            '8/20/26, 21:05 -',            '8/20/26, 21:07 -',            false],
  ['Android 12h',               '8/20/26, 9:05 PM -',          '8/20/26, 9:07 PM -',          false],
  ['Android 12h U+202F',        '8/20/26, 9:05 PM -',     '8/20/26, 9:07 PM -',     false],
  ['iOS bracketed with seconds','[20/08/2026, 21:05:10]',      '[20/08/2026, 21:07:00]',      true],
  ['Android DD/MM 24h',         '20/08/2026, 21:05 -',         '20/08/2026, 21:07 -',         true],
];
for (const [label, h1, h2, dayFirst] of WA_FORMATS) {
  test(`parseWhatsAppText (D7): ${label} header parses to 2026-08-20 21:05 for Bob`, () => {
    const msgs = plain(helpers.parseWhatsAppText(waFile(h1, h2)));
    assert.equal(msgs.length, 2, 'two messages');
    assert.deepEqual([msgs[0].year, msgs[0].monthIdx, msgs[0].day, msgs[0].hour, msgs[0].minute, msgs[0].sender],
      [2026, 7, 20, 21, 5, 'Bob']);
    assert.equal(msgs[1].sender, 'Nik');
    assert.match(msgs[0].body, /Final score: 585/);
    assert.equal(helpers.parseWhatsAppText(waFile(h1, h2)).dayFirst, dayFirst);
  });
}

test('parseWhatsAppText (D7): 12h edge hours (12:xx AM is 0, 12:xx PM is 12)', () => {
  const msgs = plain(helpers.parseWhatsAppText('8/20/26, 12:05 AM - Bob: hi\n8/20/26, 12:05 PM - Bob: hi\n'));
  assert.deepEqual(msgs.map(m => m.hour), [0, 12]);
});

test('parseWhatsAppText (D7): an ambiguous file (no number above 12) defaults to US order and says so; dayFirst=true flips it', () => {
  const file = '3/8/26, 21:05 - Bob: MapTap #400\n95 89 91 9 64\nFinal score: 585\n';
  const us = helpers.parseWhatsAppText(file);
  assert.equal(us.ambiguousOrder, true);
  assert.equal(us.dayFirst, false);
  assert.deepEqual([plain(us)[0].monthIdx, plain(us)[0].day], [2, 8], 'March 8 by default');
  const dm = helpers.parseWhatsAppText(file, true);
  assert.deepEqual([plain(dm)[0].monthIdx, plain(dm)[0].day], [7, 3], '3 August when told day-first');
  assert.equal(dm.ambiguousOrder, false);
  // One day above 12 anywhere in the file settles it for every message.
  const settled = helpers.parseWhatsAppText(file + '25/8/26, 21:05 - Bob: later\n');
  assert.equal(settled.ambiguousOrder, false);
  assert.deepEqual([plain(settled)[0].monthIdx, plain(settled)[0].day], [7, 3]);
});

test('parseWhatsAppText (D7): empty or non-chat text yields no messages, never throws', () => {
  assert.equal(helpers.parseWhatsAppText('').length, 0);
  assert.equal(helpers.parseWhatsAppText('hello\nworld').length, 0);
});

test('dayBucketDate (D7): the body date wins; a DD/MM header no longer dates the game a year out', () => {
  const [msg] = plain(helpers.parseWhatsAppText(waFile('20/08/2026, 21:05 -', '20/08/2026, 21:07 -')));
  const parsed = { date: '2026-08-20' };
  assert.equal(helpers.dayBucketDate(msg, parsed), '2026-08-20');
  // "Dec 30" share delivered on Jan 2 belongs to the previous year.
  const jan = plain(helpers.parseWhatsAppText('1/2/27, 09:00 - Bob: x\n'))[0];
  assert.equal(helpers.dayBucketDate(jan, { date: '2027-12-30' }), '2026-12-30');
  // No body date: the header's own day.
  assert.equal(helpers.dayBucketDate(msg, {}), '2026-08-20');
});

// D13: hints, not blocks. Ids keep the data right; the copy warns about the UI.
test('rivalNameHint (D13): duplicate (case-insensitive) and me-equal names get a hint, others none', () => {
  const c = loadApp({ maptapRivalsRivals: [goodRival({ id: 'r1', name: 'Alice' })], maptapRivalsMe: '"Nik"' });
  const hint = c._testExports.rivalNameHint;
  assert.match(hint('alice', null), /already have a rival called "Alice"/);
  assert.equal(hint('Alice', 'r1'), '', 'editing Alice herself is not a duplicate');
  assert.match(hint('nik', null), /your own name/);
  assert.equal(hint('Carol', null), '');
  assert.equal(hint('   ', null), '');
});
