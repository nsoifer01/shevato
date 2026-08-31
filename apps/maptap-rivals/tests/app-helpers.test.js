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
const MapTapWhatsApp = require('../js/whatsapp.js');

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
  sandbox.window.MapTapWhatsApp = MapTapWhatsApp;
  sandbox.MutationObserver = function () { return { observe() {}, disconnect() {} }; };
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
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
    'rivalNameHint', 'storedDayCities', 'splitGameCities', 'joinGameCities',
    'persistGames', 'loadGamesFromStorage', 'storedGamesAreInline',
    'migrateInlineCities',
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
// crash every view (and every later page load). The sanitiser keeps what it
// can make safe, drops the rest with a reason, and discloses every repair.
//
// The surviving sanitiser is the one in js/stats.js (see tests/stats.test.js),
// which rebuilds every row from a known field list instead of spreading the
// file's own keys through. Two rules differ from the audit round's own draft
// and this fixture pins the stricter of each pair:
//   - a rival with no id is DROPPED, not given a generated one: the id is what
//     that rival's games point at, so an invented one only makes orphans.
//   - a rival with no name is KEPT as "Rival" (a missing label costs nothing),
//     and a game whose scores are junk on one side survives as a rival-only
//     day instead of taking the whole day down with it.
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
  assert.deepEqual(r.data.rivals.map(x => x.id), ['q', 'q2']);
  assert.deepEqual(r.data.rivals.map(x => x.name), ['Rival', 'Dup']);
  assert.deepEqual(r.data.games.map(g => g.date), ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.ok(r.data.games[0].id, 'a missing game id is assigned');
  assert.equal(r.data.games[0].myScore, 36, 'the total is derived from the rounds');
  assert.equal(r.data.games[1].myScores, undefined, 'the unreadable side is dropped; the day survives as rival-only');
  assert.equal(r.data.games[1].theirScore, 36);
  assert.equal(r.data.games[2].myScore, 36, 'a junk myScore is recomputed from the rounds it contradicts');
  assert.equal(r.rejected.length, 8, r.rejected.join(' | '));
  assert.ok(r.rejected.some(x => /not-a-date/.test(x)));
  assert.ok(r.rejected.some(x => /2026-02-30/.test(x)), 'Feb 30 is not a date');
  assert.ok(r.rejected.some(x => /duplicate id/.test(x)));
  assert.ok(r.rejected.some(x => /missing id/.test(x)), 'a rival id is never invented');
  assert.ok(r.repaired.some(x => /round scores/.test(x)));
  assert.ok(r.repaired.some(x => /myScore is not a number/.test(x)));
  assert.ok(r.repaired.some(x => /assigned an id/.test(x)));
  assert.equal(r.dropped.rivals + r.dropped.games, r.rejected.length, 'every drop is counted and explained');
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

// D7: every header shape WhatsApp writes. The fixtures are the audit's, run
// against the parser that survived the merge: js/whatsapp.js, reached through
// the bindings app.js itself uses. tests/whatsapp.test.js owns that module's
// own edge cases; this block pins that the app still reads each real-world
// export shape end to end, ambiguity included.
const waShareParts = (body) => {
  const p = MapTapStats.parseMapTapScore(body);
  return p && p.dateParts;
};
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
    const { messages } = helpers.parseWhatsAppText(waFile(h1, h2));
    assert.equal(messages.length, 2, 'two messages');
    const detected = helpers.detectDateOrder(messages, waShareParts);
    assert.equal(detected.order, dayFirst ? 'DMY' : 'MDY');
    assert.equal(detected.certain, true, 'this file settles its own day/month order');
    const msgs = helpers.applyDateOrder(messages, detected.order);
    assert.deepEqual([msgs[0].year, msgs[0].monthIdx, msgs[0].day, msgs[0].hour, msgs[0].minute, msgs[0].sender],
      [2026, 7, 20, 21, 5, 'Bob']);
    assert.equal(msgs[0].dateISO, '2026-08-20');
    assert.equal(msgs[1].sender, 'Nik');
    assert.match(msgs[0].body, /Final score: 585/);
  });
}

test('parseWhatsAppText (D7): 12h edge hours (12:xx AM is 0, 12:xx PM is 12)', () => {
  const { messages } = helpers.parseWhatsAppText('8/20/26, 12:05 AM - Bob: hi\n8/20/26, 12:05 PM - Bob: hi\n');
  assert.deepEqual(messages.map(m => m.hour), [0, 12]);
});

test('parseWhatsAppText (D7): an ambiguous file is reported uncertain (US order offered first); the user can flip it, and one number above 12 settles it outright', () => {
  const file = '3/8/26, 21:05 - Bob: MapTap #400\n95 89 91 9 64\nFinal score: 585\n';
  const { messages } = helpers.parseWhatsAppText(file);
  const us = helpers.detectDateOrder(messages, waShareParts);
  assert.equal(us.certain, false, 'nothing in the file settles day vs month, so the modal must ask');
  assert.equal(us.order, 'MDY', 'US order is what it offers first');
  const asUS = helpers.applyDateOrder(messages, 'MDY');
  assert.deepEqual([asUS[0].monthIdx, asUS[0].day], [2, 8], 'March 8 by default');
  const asDM = helpers.applyDateOrder(messages, 'DMY');
  assert.deepEqual([asDM[0].monthIdx, asDM[0].day], [7, 3], '3 August when told day-first');
  // One day above 12 anywhere in the file settles it for every message.
  const settled = helpers.parseWhatsAppText(file + '25/8/26, 21:05 - Bob: later\n');
  const order = helpers.detectDateOrder(settled.messages, waShareParts);
  assert.equal(order.certain, true);
  assert.equal(order.order, 'DMY');
  const resolved = helpers.applyDateOrder(settled.messages, order.order);
  assert.deepEqual([resolved[0].monthIdx, resolved[0].day], [7, 3]);
});

test('parseWhatsAppText (D7): empty or non-chat text yields no messages, never throws', () => {
  assert.equal(helpers.parseWhatsAppText('').messages.length, 0);
  assert.equal(helpers.parseWhatsAppText('hello\nworld').messages.length, 0);
  assert.equal(helpers.parseWhatsAppText('hello\nworld').skippedLeadingLines, 2);
});

test('dayBucketDate (D7): the body date wins; a DD/MM header no longer dates the game a year out', () => {
  const { messages } = helpers.parseWhatsAppText(waFile('20/08/2026, 21:05 -', '20/08/2026, 21:07 -'));
  const [msg] = helpers.applyDateOrder(messages, 'DMY');
  assert.equal(helpers.dayBucketDate(msg, MapTapStats.parseMapTapScore(msg.body)), '2026-08-20');
  // "Dec 30" share delivered on Jan 2 belongs to the previous year.
  const janFile = helpers.parseWhatsAppText('1/2/27, 09:00 - Bob: MapTap #532\nDec 30\n10 20 30 40 50\nFinal score: 300\n');
  const [jan] = helpers.applyDateOrder(janFile.messages, 'MDY');
  assert.equal(helpers.dayBucketDate(jan, MapTapStats.parseMapTapScore(jan.body)), '2026-12-30');
  // No body date: the header's own day.
  assert.equal(helpers.dayBucketDate(msg, {}), '2026-08-20');
});

// D13: hints, not blocks. Ids keep the data right; the copy warns about the UI.
test('rivalNameHint (D13): duplicate (case-insensitive) and me-equal names get a hint, others none', () => {
  const c = loadApp({ maptapRivalsRivals: [goodRival({ id: 'r1', name: 'Alice' })], maptapRivalsMe: '"Nik"' });
  const hint = c._testExports.rivalNameHint;
  assert.match(hint('alice', null), /already have a rival named "Alice"/);
  assert.equal(hint('Alice', 'r1'), '', 'editing Alice herself is not a duplicate');
  assert.match(hint('nik', null), /your own name/);
  assert.equal(hint('Carol', null), '');
  assert.equal(hint('   ', null), '');
});

// ---------------------------------------------------------------------------
// 2026-08-22 quality pass: helpers added or fixed by the audit round.
// ---------------------------------------------------------------------------

test('swingLines: reads totals through the canonical helpers (array-only games used to print undefined)', () => {
  const c = loadApp({
    maptapRivalsRivals: [{ id: 'r1', name: 'Ari', color: '#fff', icon: 'x' }],
    maptapRivalsGames: [
      { id: 'a', rivalId: 'r1', date: '2026-08-10', myScores: [100, 100, 100, 100, 100], theirScores: [0, 0, 0, 0, 0], createdAt: 1 },
      { id: 'b', rivalId: 'r1', date: '2026-08-11', myScore: 500, theirScore: 650, createdAt: 2 },
    ],
  });
  const s = c._testExports.rivalSummary({ id: 'r1', name: 'Ari' });
  assert.deepEqual(plain(c._testExports.swingLines(s)), [
    'Best win +1000 (1000–0 on Aug 10, 2026)',
    'Worst loss −150 (500–650 on Aug 11, 2026)',
  ]);
  assert.ok(!JSON.stringify(c._testExports.swingLines(s)).includes('undefined'));
});

test('swingLines: a rival you only ever beat has one line', () => {
  const c = loadApp({
    maptapRivalsRivals: [{ id: 'r1', name: 'Ari', color: '#fff', icon: 'x' }],
    maptapRivalsGames: [{ id: 'a', rivalId: 'r1', date: '2026-08-10', myScores: [90, 90, 90, 90, 90], theirScores: [10, 10, 10, 10, 10], createdAt: 1 }],
  });
  const s = c._testExports.rivalSummary({ id: 'r1', name: 'Ari' });
  assert.equal(c._testExports.swingLines(s).length, 1);
});

test('consistencyLabel: bands are on the 0-1000 daily-total scale', () => {
  const f = helpers.consistencyLabel;
  assert.equal(f(0), 'Very steady scorer');
  assert.equal(f(59.9), 'Very steady scorer');
  assert.equal(f(60), 'Fairly consistent scorer');
  assert.equal(f(109.9), 'Fairly consistent scorer');
  assert.equal(f(110), 'Streaky, high-variance scorer');
  assert.equal(f(NaN), 'Not enough games yet');
});

test('continentSubText: singular and plural forms read correctly', () => {
  const f = helpers.continentSubText;
  assert.equal(f(15, 6, 1), '15 rounds across 6 continents · 1 game without geo data (re-sync to backfill)');
  assert.equal(f(5, 1, 2), '5 rounds across 1 continent · 2 games without geo data (re-sync to backfill)');
  assert.equal(f(1, 1, 0), '1 round across 1 continent');
});

test('pasteDateHintText: today is silent, past and future days are spelled out', () => {
  const f = helpers.pasteDateHintText;
  assert.equal(f('2026-08-22', '2026-08-22'), '');
  assert.equal(f('2026-08-21', '2026-08-22'), 'Logging for Fri, Aug 21, 2026 (yesterday).');
  assert.equal(f('2026-08-01', '2026-08-22'), 'Logging for Sat, Aug 1, 2026 (21 days ago).');
  assert.equal(f('2026-12-31', '2026-08-22'), 'Logging for Thu, Dec 31, 2026, which is in the future.');
  assert.equal(f('', '2026-08-22'), 'No date set: games will be saved under today.');
  assert.equal(f('2026-02-30', '2026-08-22'), 'That date is invalid.');
});

test('leaveNetworkMessage: never claims a remote deletion that did not happen', () => {
  const f = helpers.leaveNetworkMessage;
  assert.match(f(false, false), /this device only/);
  assert.match(f(false, false), /Sign in/);
  assert.doesNotMatch(f(false, false), /are removed/);
  assert.match(f(true, true), /failed/);
  assert.match(f(true, false), /are removed/);
});

test('rivalNameClash: case-insensitive, trimmed, excludes the rival being edited', () => {
  const c = loadApp({ maptapRivalsRivals: [{ id: 'r1', name: 'Ari', color: '#fff', icon: 'x' }, { id: 'r2', name: 'Bex', color: '#fff', icon: 'x' }] });
  const f = c._testExports.rivalNameClash;
  assert.equal(f(' ari ', null).id, 'r1');
  assert.equal(f('Ari', 'r1'), null);
  assert.equal(f('Cy', null), null);
  assert.equal(f('', null), null);
});

// Drama copy (audit #10): a streak LEVEL with the record is one win short of
// breaking it, so the line must say so instead of "match your record".
function dramaFor(results) {
  const games = results.map((r, i) => ({
    id: 'g' + i, rivalId: 'r1', date: `2026-07-${String(i + 1).padStart(2, '0')}`, createdAt: i,
    myScore: r === 'W' ? 700 : r === 'L' ? 500 : 600, theirScore: 600,
  }));
  const c = loadApp({ maptapRivalsRivals: [{ id: 'r1', name: 'Ari', color: '#fff', icon: 'x' }], maptapRivalsGames: games });
  return c._testExports.streakDrama('r1');
}
test('streakDrama: a win streak equal to the previous best reads "level with your record: win today to break it"', () => {
  const d = dramaFor(['W', 'W', 'L', 'W', 'W']);
  assert.equal(d.kind, 'win');
  assert.match(d.text, /level with your record: win today to break it/);
  assert.doesNotMatch(d.text, /match your record/);
});
test('streakDrama: a win streak past the previous best reads "New record!"', () => {
  assert.match(dramaFor(['W', 'L', 'W', 'W']).text, /New record! 2-game win streak/);
});
test('streakDrama: a losing streak equal to the previous worst reads "level with your worst slump"', () => {
  const d = dramaFor(['L', 'L', 'W', 'L', 'L']);
  assert.equal(d.kind, 'loss');
  assert.match(d.text, /Level with your worst slump/);
});

// ---------------------------------------------------------------------------
// "Sync all rivals" run summary. The per-rival pills speak for one rivalry
// each and fade after a few seconds, so this line is the only thing that
// reports what a whole run did.
// ---------------------------------------------------------------------------

const okRun = (o = {}) => ({ ok: true, added: 0, updated: 0, backfilled: 0, ...o });
const summary = (results) => helpers.syncAllSummary(results);

test('syncAllSummary: names how many rivals were already up to date beside the new games', () => {
  const s = summary([okRun({ added: 4 }), okRun({ added: 3 }), okRun(), okRun()]);
  assert.equal(s.kind, 'ok');
  assert.equal(s.msg, '4 rivals synced · 7 new games · 2 already up to date');
});

test('syncAllSummary: a run that changed nothing says so instead of going quiet', () => {
  assert.equal(summary([okRun(), okRun(), okRun()]).msg, '3 rivals synced · all already up to date');
  assert.equal(summary([okRun()]).msg, '1 rival synced · already up to date');
});

test('syncAllSummary: updates and backfills are reported separately from new games', () => {
  const s = summary([okRun({ added: 1, updated: 2, backfilled: 3 })]);
  assert.equal(s.msg, '1 rival synced · 1 new game · 2 games updated · 3 backfilled');
});

// The counts describe what SYNCED, not what was attempted: a run where every
// rival failed must not open with "2 rivals synced".
test('syncAllSummary: a partial failure warns, a total failure errors', () => {
  const partial = summary([okRun({ added: 2 }), { ok: false, error: 'HTTP 500' }]);
  assert.equal(partial.kind, 'warn');
  assert.equal(partial.msg, '1 rival synced · 2 new games · 1 rival failed');

  // "all already up to date" would read as a clean bill of health, so a run
  // with a failure in it always spells the count out instead.
  const mixed = summary([okRun(), okRun(), { ok: false, error: 'HTTP 500' }]);
  assert.equal(mixed.msg, '2 rivals synced · 2 already up to date · 1 rival failed');

  const total = summary([{ ok: false, error: 'HTTP 500' }, { ok: false, error: 'HTTP 500' }]);
  assert.equal(total.kind, 'err');
  assert.equal(total.msg, '2 rivals failed');
});

test('syncAllSummary: a rival already mid-sync from its own button is not counted', () => {
  const s = summary([okRun({ added: 1 }), { skipped: true }]);
  assert.equal(s.msg, '1 rival synced · 1 new game');
  assert.equal(summary([{ skipped: true }]), null);
  assert.equal(summary([]), null);
  assert.equal(summary(null), null);
});

// ---------------------------------------------------------------------------
// Storage normalisation: the day-global puzzle geography (KEY.DAYS)
//
// MapTap plays the same 5 cities for everyone on a given day, but the game
// log stores one row per (date, rival), so keeping that array inline stored
// it once per rival. At 9 rivals it was 57% of everything the app persisted
// and it grew as days x rivals, which is what pushed the synced document
// past the sync layer's flush ceiling on 2026-08-31. These tests pin that
// the normalised form is lossless, smaller, backward-compatible, and does
// not grow when the same MapTap data is synced again.
// ---------------------------------------------------------------------------

const { splitGameCities, joinGameCities, storedDayCities } = helpers;

// Long, non-ASCII names on purpose: they are what MapTap actually returns
// and what makes the inline duplication expensive.
const CITY_NAMES = [
  'Knoxville, Tennessee', 'Châtellerault, France', 'Schleswig, Germany',
  'Bingen, Germany', 'Ostashkov, Russia', 'Ulaanbaatar, Mongolia',
  'São Paulo, Brazil', 'Wagga Wagga, Australia', 'Trondheim, Norway',
  'Kanchipuram, India',
];

function isoDay(i) {
  return new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
}

function citiesForDay(i) {
  return Array.from({ length: 5 }, (_, r) => ({
    lat: Number((((i * 7 + r * 13) % 140) - 60).toFixed(2)),
    lng: Number((((i * 11 + r * 29) % 360) - 180).toFixed(2)),
    name: CITY_NAMES[(i + r) % CITY_NAMES.length],
  }));
}

// A MapTap profile history in the web/roundData shape the app parses.
function history(days, seed) {
  const out = {};
  for (let i = 0; i < days; i++) {
    out[isoDay(i)] = {
      roundData: citiesForDay(i).map((c, r) => ({
        round: r + 1,
        score: (seed * 17 + i * 3 + r * 11) % 101,
        cityLat: c.lat, cityLng: c.lng, cityName: c.name,
      })),
    };
  }
  return out;
}

// Build a full synced log through the REAL merge, one rival at a time, the
// way "Sync all rivals" does.
function buildSyncedLog(rivalCount, days, { mine = null } = {}) {
  const mineByDate = mine || MapTapStats.mapTapHistoryToRounds(history(days, 1));
  const games = [];
  let n = 0;
  for (let r = 0; r < rivalCount; r++) {
    const theirsByDate = MapTapStats.mapTapHistoryToRounds(history(days, r + 2));
    const { newGames } = MapTapStats.mergeMapTapSync({
      rivalId: `rival-${r}`,
      mineByDate,
      theirsByDate,
      existingGames: games,
      makeId: () => `g${n++}`,
      now: 1756000000000,
    });
    for (const g of newGames) games.push(g);
  }
  return { games, mineByDate };
}

const bytes = (v) => JSON.stringify(v).length;
const FLUSH_CEILING = 700 * 1024;

test('splitGameCities/joinGameCities: the round trip is lossless', () => {
  const cities = citiesForDay(3);
  const games = [
    { id: 'a', rivalId: 'r1', date: '2026-08-10', myScore: 700, cities, note: 'x' },
    { id: 'b', rivalId: 'r2', date: '2026-08-10', myScore: 700, cities: cities.map(c => ({ ...c })) },
    { id: 'c', rivalId: 'r1', date: '2026-08-11', myScore: 500 }, // pasted: no geo
  ];
  const { rows, days } = splitGameCities(games);

  assert.deepEqual(Object.keys(days), ['2026-08-10'], 'one entry per date that has geo');
  assert.equal(rows.filter(r => 'cities' in r).length, 0, 'no row keeps an inline copy');

  const back = joinGameCities(plain(rows), storedDayCities(plain(days)));
  assert.deepEqual(plain(back[0].cities), plain(cities));
  assert.deepEqual(plain(back[1].cities), plain(cities));
  assert.equal(back[2].cities, undefined, 'a day with no geo stays without');
  assert.deepEqual(plain(back), plain(games).map(g => (g.cities ? g : g)));
});

test('splitGameCities: a row whose geography disagrees with the day keeps its own copy', () => {
  // Not reachable today (both sides of a sync read the same puzzle file),
  // but normalising over a disagreement would silently rewrite one of them.
  const dayCities = citiesForDay(1);
  const odd = citiesForDay(2);
  const { rows, days } = splitGameCities([
    { id: 'a', rivalId: 'r1', date: '2026-08-10', cities: dayCities },
    { id: 'b', rivalId: 'r2', date: '2026-08-10', cities: odd },
  ]);
  assert.deepEqual(plain(days['2026-08-10']), plain(dayCities));
  assert.equal(rows[0].cities, undefined);
  assert.deepEqual(plain(rows[1].cities), plain(odd), 'the odd row is left inline, not rewritten');

  const back = joinGameCities(plain(rows), storedDayCities(plain(days)));
  assert.deepEqual(plain(back[0].cities), plain(dayCities));
  assert.deepEqual(plain(back[1].cities), plain(odd));
});

test('storedDayCities: a hostile or malformed stored map cannot poison lookups', () => {
  // Built through JSON.parse, which is how the value actually arrives (a
  // stored string, or a synced payload): only there does '__proto__' become
  // an OWN property rather than setting the object's prototype.
  const map = storedDayCities(JSON.parse(JSON.stringify({
    '2026-08-10': citiesForDay(0),
    '2026-08-11': [{ lat: 1, lng: 2 }], // short array: not a usable day
    '2026-08-12': 'nonsense',
  }).replace('{', '{"__proto__":' + JSON.stringify(citiesForDay(1)) + ',')));
  assert.equal(map.size, 2);
  assert.ok(map.has('__proto__'), 'a __proto__ date is stored as an ordinary key');
  assert.equal(map.get('2026-08-11'), undefined);
  assert.equal(map.get('2026-08-12'), undefined);
  assert.equal(storedDayCities(null).size, 0);
  assert.equal(storedDayCities([]).size, 0);
});

test('a large rival network no longer persists over the sync flush ceiling', () => {
  // The reported incident: 9 rivals, ~172 days each. Reproduced here at 200
  // days so the legacy form is comfortably over the ceiling it hit.
  const { games } = buildSyncedLog(9, 200);
  assert.equal(games.length, 9 * 200, 'one row per rival per day, as the model requires');

  const legacyBytes = bytes(games);
  assert.ok(legacyBytes > FLUSH_CEILING,
    `the old inline format must reproduce the failure, got ${legacyBytes}B`);

  const { rows, days } = splitGameCities(games);
  const normalisedBytes = bytes(rows) + bytes(days);
  assert.ok(normalisedBytes < FLUSH_CEILING,
    `the normalised format must fit, got ${normalisedBytes}B`);
  // The duplication removed is the dominant term, not a rounding win.
  assert.ok(normalisedBytes < legacyBytes * 0.55,
    `expected well under half the bytes, got ${normalisedBytes} vs ${legacyBytes}`);

  // And the marginal cost of one more rival is now the rival's own scores
  // rather than another full copy of the puzzle geography.
  const ten = splitGameCities(buildSyncedLog(10, 200).games);
  const perRival = (bytes(ten.rows) + bytes(ten.days)) - normalisedBytes;
  const legacyPerRival = bytes(buildSyncedLog(10, 200).games) - legacyBytes;
  assert.ok(perRival < legacyPerRival * 0.5,
    `per-rival growth must shrink: ${perRival}B vs ${legacyPerRival}B`);
});

test('a boot from the legacy inline format hydrates, flags migration, and rewrites normalised', () => {
  const { games } = buildSyncedLog(3, 40);
  const rivals = Array.from({ length: 3 }, (_, r) => ({
    id: `rival-${r}`, name: `R${r}`, color: '#6366f1', icon: '🦊', createdAt: 1,
  }));

  const app = loadApp({ maptapRivalsRivals: rivals, maptapRivalsGames: games });
  assert.equal(app._testExports.storedGamesAreInline(), true,
    'a stored row carrying inline cities must be recognised as the old format');

  assert.equal(app._testExports.migrateInlineCities(), true, 'the rewrite runs');
  assert.equal(app._testExports.migrateInlineCities(), false,
    'and is idempotent - a second pass finds nothing to do');

  const storedRows = JSON.parse(app.localStorage.getItem('maptapRivalsGames'));
  const storedDays = JSON.parse(app.localStorage.getItem('maptapRivalsDays'));
  assert.equal(storedRows.length, games.length, 'every game survives the rewrite');
  assert.equal(storedRows.filter(r => 'cities' in r).length, 0, 'nothing is stored inline any more');
  assert.equal(Object.keys(storedDays).length, 40, 'one day entry per date');

  const reloaded = plain(app._testExports.loadGamesFromStorage());
  assert.equal(reloaded.length, games.length);
  for (const g of reloaded) {
    assert.equal(g.cities.length, 5, 'every synced row still has its geography after a reload');
  }
  const byId = new Map(reloaded.map(g => [g.id, g]));
  for (const original of plain(games)) {
    const back = byId.get(original.id);
    assert.deepEqual(back.cities, original.cities, `geo preserved for ${original.id}`);
    assert.deepEqual(back.myScores, original.myScores);
    assert.deepEqual(back.theirScores, original.theirScores);
    assert.equal(back.date, original.date);
    assert.equal(back.rivalId, original.rivalId);
  }
});

test('a boot from the normalised format hydrates without flagging a migration', () => {
  const { games } = buildSyncedLog(2, 12);
  const { rows, days } = splitGameCities(games);

  const app = loadApp({
    maptapRivalsRivals: [
      { id: 'rival-0', name: 'A', color: '#6366f1', icon: '🦊', createdAt: 1 },
      { id: 'rival-1', name: 'B', color: '#22d3ee', icon: '🐺', createdAt: 2 },
    ],
    maptapRivalsGames: rows,
    maptapRivalsDays: days,
  });

  assert.equal(app._testExports.storedGamesAreInline(), false, 'nothing stored inline');
  assert.equal(app._testExports.migrateInlineCities(), false,
    'already-normalised storage must not be rewritten on every boot');

  const summary = app._testExports.rivalSummary({ id: 'rival-0', name: 'A' });
  assert.equal(summary.allGames.length, 12, 'the hydrated log reaches the dashboard');
  assert.equal(summary.allGames.every(g => Array.isArray(g.cities) && g.cities.length === 5), true,
    'and every row got its geography back from the day map');
});

test('games stored without their day map still load, just without geography', () => {
  // The two keys sync independently, so a device can legitimately see one
  // before the other. That must degrade to "no continent breakdown yet",
  // never to a crash or to lost games.
  const { games } = buildSyncedLog(2, 5);
  const { rows } = splitGameCities(games);
  const app = loadApp({
    maptapRivalsRivals: [{ id: 'rival-0', name: 'A', color: '#6366f1', icon: '🦊', createdAt: 1 }],
    maptapRivalsGames: rows,
  });
  const summary = app._testExports.rivalSummary({ id: 'rival-0', name: 'A' });
  assert.equal(summary.allGames.length, 5, 'every game is still there');
  assert.equal(summary.allGames.some(g => g.cities), false, 'geo is simply absent');
});

test('re-syncing the same MapTap data adds nothing and does not grow storage', () => {
  const { games, mineByDate } = buildSyncedLog(9, 120);
  const first = splitGameCities(games);
  const firstBytes = bytes(first.rows) + bytes(first.days);

  // Second run over byte-identical MapTap payloads, exactly what pressing
  // "Sync all rivals" again does.
  let added = 0, updated = 0, backfilled = 0;
  for (let r = 0; r < 9; r++) {
    const res = MapTapStats.mergeMapTapSync({
      rivalId: `rival-${r}`,
      mineByDate,
      theirsByDate: MapTapStats.mapTapHistoryToRounds(history(120, r + 2)),
      existingGames: games,
      makeId: () => 'must-not-be-used',
      now: 1756000100000,
    });
    added += res.added; updated += res.updated; backfilled += res.backfilled;
    for (const g of res.newGames) games.push(g);
  }

  assert.deepEqual({ added, updated, backfilled }, { added: 0, updated: 0, backfilled: 0 },
    'a second sync with no new MapTap data must be a no-op');
  assert.equal(games.length, 9 * 120, 'no duplicate rows');

  const second = splitGameCities(games);
  assert.equal(bytes(second.rows) + bytes(second.days), firstBytes,
    'and the persisted bytes must be identical, not merely similar');
  assert.deepEqual(plain(second.days), plain(first.days));
});

test('a changed day updates the existing row on every rival instead of appending', () => {
  const days = 30;
  const { games, mineByDate } = buildSyncedLog(4, days);
  const before = games.length;
  const target = isoDay(7);
  const targetIds = games.filter(g => g.date === target).map(g => g.id);
  assert.equal(targetIds.length, 4);

  // MapTap re-published one day with different scores for rival-1 only.
  const revised = MapTapStats.mapTapHistoryToRounds(history(days, 3));
  revised[target] = {
    scores: [99, 98, 97, 96, 95],
    cities: revised[target].cities,
  };

  const res = MapTapStats.mergeMapTapSync({
    rivalId: 'rival-1',
    mineByDate,
    theirsByDate: revised,
    existingGames: games,
    makeId: () => 'must-not-be-used',
    now: 1756000200000,
  });

  assert.equal(res.added, 0, 'a corrected day is not a new day');
  assert.equal(res.updated, 1);
  assert.equal(res.newGames.length, 0);
  assert.equal(games.length, before, 'no row was appended');

  const row = games.find(g => g.rivalId === 'rival-1' && g.date === target);
  assert.deepEqual(row.theirScores, [99, 98, 97, 96, 95], 'the right record was updated in place');
  assert.equal(row.theirScore, MapTapStats.weightedTotal([99, 98, 97, 96, 95]));
  assert.ok(targetIds.includes(row.id), 'and it kept its id');

  // The other rivals' rows for that day are untouched.
  for (const other of games.filter(g => g.date === target && g.rivalId !== 'rival-1')) {
    assert.notDeepEqual(other.theirScores, [99, 98, 97, 96, 95]);
  }

  // The day map still holds exactly one entry for that date after the edit.
  const { days: dayMap } = splitGameCities(games);
  assert.equal(Object.keys(dayMap).length, days);
  assert.equal(dayMap[target].length, 5);
});

test('a remote push of the legacy format is re-normalised on arrival', () => {
  // The pre-migration Firestore document wins the first snapshot of a
  // session, and a device still running the old code can push it back at
  // any time. Either way the fat copy must not become what this device
  // syncs onward.
  const { games } = buildSyncedLog(3, 25);
  const { rows, days } = splitGameCities(games);
  const app = loadApp({
    maptapRivalsRivals: [{ id: 'rival-0', name: 'A', color: '#6366f1', icon: '🦊', createdAt: 1 }],
    maptapRivalsGames: rows,
    maptapRivalsDays: days,
  });

  // The sync layer writes the remote value straight into localStorage.
  app.localStorage.setItem('maptapRivalsGames', JSON.stringify(games));
  assert.equal(app._testExports.storedGamesAreInline(), true);

  assert.equal(app._testExports.migrateInlineCities(), true);
  const rewritten = JSON.parse(app.localStorage.getItem('maptapRivalsGames'));
  assert.equal(rewritten.length, games.length, 'no game is lost re-normalising');
  assert.equal(rewritten.filter(r => 'cities' in r).length, 0);
  assert.equal(
    JSON.parse(app.localStorage.getItem('maptapRivalsGames')).length
      + Object.keys(JSON.parse(app.localStorage.getItem('maptapRivalsDays'))).length,
    games.length + 25,
  );
});

test('a synced day map that goes missing costs geography, never games', () => {
  // The two keys are independent revisions under per-key last-write-wins,
  // so one can be lost. The log itself must survive intact, and the next
  // MapTap sync backfills the geography (mergeMapTapSync counts it).
  const { games, mineByDate } = buildSyncedLog(2, 10);
  const { rows } = splitGameCities(games);
  const survivors = joinGameCities(plain(rows), storedDayCities(null));
  assert.equal(survivors.length, games.length);
  assert.equal(survivors.some(g => g.cities), false);

  const res = MapTapStats.mergeMapTapSync({
    rivalId: 'rival-0',
    mineByDate,
    theirsByDate: MapTapStats.mapTapHistoryToRounds(history(10, 2)),
    existingGames: survivors,
    makeId: () => 'must-not-be-used',
    now: 1756000300000,
  });
  assert.equal(res.added, 0, 'no games are re-created');
  assert.equal(res.backfilled, 10, 'every day gets its geography back');
  assert.equal(survivors.filter(g => g.rivalId === 'rival-0').every(g => g.cities.length === 5), true);
});

test('splitGameCities: iOS-shaped days (NaN coordinates) still normalise to one entry', () => {
  // The iOS 4.04 payload has city NAMES but no lat/lng, so mergeMapTapSync
  // writes NaN coords into the freshly synced rows. NaN !== NaN, so a naive
  // comparison would call two identical days different and leave every row
  // after the first carrying its own inline copy - exactly the duplication
  // this change exists to remove.
  const ios = Array.from({ length: 5 }, (_, i) => ({ lat: NaN, lng: NaN, name: `City${i}` }));
  const { rows, days } = splitGameCities([
    { id: 'a', rivalId: 'r1', date: '2026-08-10', cities: ios },
    { id: 'b', rivalId: 'r2', date: '2026-08-10', cities: ios.map(c => ({ ...c })) },
    { id: 'c', rivalId: 'r3', date: '2026-08-10', cities: ios.map(c => ({ ...c })) },
  ]);
  assert.equal(rows.filter(r => 'cities' in r).length, 0, 'no row keeps an inline copy');
  assert.equal(Object.keys(days).length, 1);

  // And the round trip through storage matches what the app always stored:
  // JSON writes NaN as null, which is what cleanCities normalises to anyway.
  const stored = JSON.parse(JSON.stringify({ rows, days }));
  const back = joinGameCities(stored.rows, storedDayCities(stored.days));
  assert.equal(back.length, 3);
  for (const g of back) {
    assert.equal(g.cities.length, 5);
    assert.deepEqual(g.cities.map(c => c.name), ['City0', 'City1', 'City2', 'City3', 'City4']);
    assert.deepEqual(g.cities.map(c => c.lat), [null, null, null, null, null]);
  }
});
