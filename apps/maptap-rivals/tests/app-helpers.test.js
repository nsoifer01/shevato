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
