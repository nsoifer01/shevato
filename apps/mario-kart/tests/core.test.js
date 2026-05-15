'use strict';

// Pin timezone so date-based filter assertions stay deterministic.
process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const JS_DIR = path.join(__dirname, '..', 'js');

// Mario-kart's scripts use the classic globals pattern (no module.exports).
// Each test loads the relevant file into a fresh vm context with the
// runtime globals it expects (window, document, races, players, etc.) stubbed.
function makeContext(extra = {}) {
  const noopFn = () => null;
  const sandbox = {
    console,
    Date,
    Intl,
    JSON,
    Math,
    Array,
    Object,
    Number,
    String,
    Boolean,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: {},
    document: {
      getElementById: noopFn,
      querySelector: noopFn,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: (() => {
      const map = new Map();
      return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
      };
    })(),
    showMessage: () => {},
    updateDisplay: () => {},
    updateAchievements: () => {},
    ...extra,
  };
  sandbox.window = sandbox.window || {};
  sandbox.window.localStorage = sandbox.localStorage;
  return vm.createContext(sandbox);
}

function loadInto(ctx, file) {
  const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
  vm.runInContext(src, ctx, { filename: file });
}

// --- detectActivePlayersFromRaces -----------------------------------------

test('detectActivePlayersFromRaces: empty/missing input defaults to 3', () => {
  const ctx = makeContext();
  loadInto(ctx, 'dataManager.js');
  const fn = ctx.detectActivePlayersFromRaces;
  assert.equal(fn([]), 3);
  assert.equal(fn(null), 3);
  assert.equal(fn(undefined), 3);
});

test('detectActivePlayersFromRaces: returns highest active player number', () => {
  const ctx = makeContext();
  loadInto(ctx, 'dataManager.js');
  const fn = ctx.detectActivePlayersFromRaces;
  assert.equal(fn([{ player1: 1, player2: 2, player3: null, player4: null }]), 2);
  assert.equal(fn([{ player1: 1, player2: null, player3: 3, player4: null }]), 3);
  assert.equal(fn([{ player1: 1, player2: 2, player3: 3, player4: 4 }]), 4);
});

test('detectActivePlayersFromRaces: clamps between 1 and 4', () => {
  const ctx = makeContext();
  loadInto(ctx, 'dataManager.js');
  const fn = ctx.detectActivePlayersFromRaces;
  assert.equal(fn([{ player1: null, player2: null, player3: null, player4: null }]), 1);
});

// --- getFilteredRaces ------------------------------------------------------

test('getFilteredRaces: "all" returns every race', () => {
  const today = new Date().toISOString().slice(0, 10);
  const races = [
    { date: '2020-01-01' },
    { date: today },
  ];
  const ctx = makeContext({ races, currentView: 'stats' });
  loadInto(ctx, 'dateFilter.js');
  ctx.currentDateFilter = 'all';
  assert.equal(ctx.getFilteredRaces().length, 2);
});

test('getFilteredRaces: "today" returns only races dated today', () => {
  const today = new Date().toLocaleDateString('en-CA');
  const races = [
    { date: '2020-01-01' },
    { date: today },
    { date: today },
  ];
  const ctx = makeContext({ races, currentView: 'stats' });
  loadInto(ctx, 'dateFilter.js');
  // Top-level `let` bindings in dateFilter.js aren't exposed on the
  // vm context (vm only exposes `var`/function/class), so flip the
  // filter through the public API instead of touching ctx.* directly.
  ctx.setDateFilter('today');
  assert.equal(ctx.getFilteredRaces().length, 2);
});

test('getFilteredRaces: "custom" range filters inclusively', () => {
  const races = [
    { date: '2026-01-01' },
    { date: '2026-02-15' },
    { date: '2026-03-30' },
  ];
  // Stub the two inputs applyCustomDateFilter() reads so we can drive
  // it through the public API rather than poking module-local `let` vars.
  const inputs = {
    'filter-start-date': { value: '2026-02-01' },
    'filter-end-date': { value: '2026-03-01' },
  };
  const ctx = makeContext({
    races,
    currentView: 'stats',
    document: {
      getElementById: (id) => inputs[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, insertAdjacentElement() {}, remove() {} }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  loadInto(ctx, 'dateFilter.js');
  ctx.setDateFilter('custom');
  ctx.applyCustomDateFilter();
  const filtered = ctx.getFilteredRaces();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].date, '2026-02-15');
});

// --- saveAction / undoLastAction / redoLastAction -------------------------

test('undoRedo: ADD_RACE then undo pops the last race', () => {
  const ctx = makeContext({
    races: [{ player1: 1, player2: 2, date: '2026-01-01' }],
  });
  loadInto(ctx, 'undoRedo.js');
  ctx.saveAction('ADD_RACE', { race: ctx.races[0] });
  ctx.undoLastAction();
  assert.equal(ctx.races.length, 0);
});

test('undoRedo: DELETE_RACE then undo restores at original index', () => {
  const original = { player1: 3, player2: 4, date: '2026-01-02' };
  const ctx = makeContext({
    races: [{ player1: 1, player2: 2, date: '2026-01-01' }],
  });
  loadInto(ctx, 'undoRedo.js');
  ctx.saveAction('DELETE_RACE', { race: original, index: 1 });
  ctx.undoLastAction();
  assert.equal(ctx.races.length, 2);
  assert.deepEqual(ctx.races[1], original);
});

test('undoRedo: history is bounded by MAX_HISTORY (oldest evicted)', () => {
  // actionHistory and historyPosition are module-local `let` bindings, so
  // we observe boundedness via behaviour: push 60 ADD_RACE actions, undo
  // them all, then verify only 50 races were popped (the buffer evicted
  // the first 10).
  const ctx = makeContext({ races: [] });
  loadInto(ctx, 'undoRedo.js');
  for (let i = 0; i < 60; i++) {
    ctx.races.push({ player1: i, date: '2026-01-01' });
    ctx.saveAction('ADD_RACE', { race: { player1: i, date: '2026-01-01' } });
  }
  let undoCount = 0;
  // Undo until no further effect; cap iterations to avoid runaway loops
  // if MAX_HISTORY ever changes upward.
  for (let i = 0; i < 200; i++) {
    const before = ctx.races.length;
    ctx.undoLastAction();
    if (ctx.races.length === before) break;
    undoCount++;
  }
  assert.equal(undoCount, 50);
});

test('undoRedo: redo after undo replays the action', () => {
  const ctx = makeContext({
    races: [{ player1: 1, player2: 2, date: '2026-01-01' }],
  });
  loadInto(ctx, 'undoRedo.js');
  const newRace = { player1: 5, player2: 6, date: '2026-01-02' };
  ctx.races.push(newRace);
  ctx.saveAction('ADD_RACE', { race: newRace });
  ctx.undoLastAction();
  assert.equal(ctx.races.length, 1);
  ctx.redoLastAction();
  assert.equal(ctx.races.length, 2);
  assert.deepEqual(ctx.races[1], newRace);
});

// --- calculateStats: H2H winner determination -----------------------------
// Loaded against a stubbed `players` global so the dynamic loops over
// player pairs see the fixture set instead of whatever the production
// code would have configured at runtime.

function loadStats(players, races) {
  const ctx = makeContext({
    players,
    races,
    getFilteredRaces: () => races,
  });
  // statistics.js calls formatDecimal from utils.js — load it first.
  loadInto(ctx, 'utils.js');
  loadInto(ctx, 'statistics.js');
  return ctx;
}

test('calculateStats: empty race data returns zeroed structure', () => {
  const ctx = loadStats(['player1', 'player2'], []);
  const stats = ctx.calculateStats([]);
  assert.equal(stats.totalRaces, 0);
  assert.equal(stats.firstPlace.player1, 0);
  assert.equal(stats.h2h.player1.player2, 0);
});

test('calculateStats: H2H increments only for the lower (better) position', () => {
  const races = [
    { date: '2026-01-01', player1: 1, player2: 2 },
    { date: '2026-01-01', player1: 3, player2: 1 },
    { date: '2026-01-01', player1: 2, player2: 4 },
  ];
  const ctx = loadStats(['player1', 'player2'], races);
  const stats = ctx.calculateStats(races);
  // player1 beat player2 on race 1 and 3 => 2; player2 beat player1 on race 2 => 1
  assert.equal(stats.h2h.player1.player2, 2);
  assert.equal(stats.h2h.player2.player1, 1);
});

test('calculateStats: skips races where one player did not finish', () => {
  const races = [
    { date: '2026-01-01', player1: 1, player2: 2 },
    { date: '2026-01-01', player1: null, player2: 1 },
    { date: '2026-01-01', player1: 3, player2: null },
  ];
  const ctx = loadStats(['player1', 'player2'], races);
  const stats = ctx.calculateStats(races);
  // Only race 1 contributes; player1 wins.
  assert.equal(stats.h2h.player1.player2, 1);
  assert.equal(stats.h2h.player2.player1, 0);
});

test('calculateStats: tracks first-place and podium finishes', () => {
  const races = [
    { date: '2026-01-01', player1: 1, player2: 4 },
    { date: '2026-01-02', player1: 3, player2: 1 },
    { date: '2026-01-03', player1: 2, player2: 5 },
  ];
  const ctx = loadStats(['player1', 'player2'], races);
  const stats = ctx.calculateStats(races);
  assert.equal(stats.firstPlace.player1, 1);
  assert.equal(stats.firstPlace.player2, 1);
  assert.equal(stats.podiumFinish.player1, 3); // 1, 3, 2 — all <= 3
  assert.equal(stats.podiumFinish.player2, 1); // only the 1
  assert.equal(stats.racesPlayed.player1, 3);
  assert.equal(stats.racesPlayed.player2, 3);
});

test('calculateStats: equal positions count as no win for either', () => {
  const races = [
    { date: '2026-01-01', player1: 2, player2: 2 },
  ];
  const ctx = loadStats(['player1', 'player2'], races);
  const stats = ctx.calculateStats(races);
  assert.equal(stats.h2h.player1.player2, 0);
  assert.equal(stats.h2h.player2.player1, 0);
});

test('calculateStats: 4-player H2H pairs are tracked independently', () => {
  const races = [
    { date: '2026-01-01', player1: 1, player2: 2, player3: 3, player4: 4 },
    { date: '2026-01-01', player1: 4, player2: 3, player3: 2, player4: 1 },
  ];
  const ctx = loadStats(['player1', 'player2', 'player3', 'player4'], races);
  const stats = ctx.calculateStats(races);
  // Race 1: p1 < p2,p3,p4 ; p2 < p3,p4 ; p3 < p4
  // Race 2: p4 < p3,p2,p1 ; p3 < p2,p1 ; p2 < p1
  // Net: each pair wins once.
  assert.equal(stats.h2h.player1.player2, 1);
  assert.equal(stats.h2h.player2.player1, 1);
  assert.equal(stats.h2h.player3.player4, 1);
  assert.equal(stats.h2h.player4.player3, 1);
});

test('calculateStats: h2hByDay buckets by date', () => {
  const races = [
    { date: '2026-01-01', player1: 1, player2: 2 },
    { date: '2026-01-01', player1: 1, player2: 2 },
    { date: '2026-01-02', player1: 3, player2: 1 },
  ];
  const ctx = loadStats(['player1', 'player2'], races);
  const stats = ctx.calculateStats(races);
  assert.equal(stats.h2hByDay['2026-01-01'].player1.player2, 2);
  assert.equal(stats.h2hByDay['2026-01-02'].player2.player1, 1);
});
