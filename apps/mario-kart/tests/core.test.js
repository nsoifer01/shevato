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

// --- importData: duplicate-position validation (Bug 20c) -------------------

function makeImportContext() {
  // FileReader stub that fires onload synchronously with the provided text.
  function FakeFileReader() {}
  FakeFileReader.prototype.readAsText = function (file) {
    this.onload({ target: { result: file._content } });
  };

  const messages = [];
  const ctx = makeContext({
    races: [],
    players: ['player1', 'player2', 'player3'],
    playerCount: 3,
    playerNames: { player1: 'P1', player2: 'P2', player3: 'P3', player4: 'P4' },
    MIN_POSITIONS: 1,
    MAX_POSITIONS: 24,
    FileReader: FakeFileReader,
    updatePlayerCount: () => {},
    updateDisplay: () => {},
    updateAchievements: () => {},
    updateClearButtonState: () => {},
    showMessage: (msg, isError) => messages.push({ msg, isError }),
  });
  // Expose messages via a property added after context creation.
  ctx._messages = messages;
  // Patch showMessage after loading so we can capture messages from the file too.
  ctx._patchMessages = () => { ctx.showMessage = (msg, isError) => messages.push({ msg, isError }); };
  return ctx;
}

function fakeFile(obj) {
  return { _content: JSON.stringify(obj) };
}

test('importData: accepts race with distinct positions', () => {
  const ctx = makeImportContext();
  loadInto(ctx, 'dataManager.js');
  ctx._patchMessages();
  const goodData = {
    races: [{ date: '2026-01-01', player1: 1, player2: 2, player3: 3, player4: null }],
    version: '1.4',
  };
  ctx.importData({ target: { files: [fakeFile(goodData)], value: '' } });
  const errors = ctx._messages.filter(m => m.isError);
  assert.equal(errors.length, 0, 'no error expected for distinct positions');
  // `races` is a module-level `let` inside the vm, not directly on ctx.
  // Check persistence via localStorage which importData writes on success.
  const stored = ctx.localStorage.getItem('marioKartRaces');
  assert.ok(stored !== null, 'races should be persisted on success');
  assert.equal(JSON.parse(stored).length, 1);
});

test('importData: rejects race where two players share a position', () => {
  const ctx = makeImportContext();
  loadInto(ctx, 'dataManager.js');
  ctx._patchMessages();
  const badData = {
    races: [{ date: '2026-01-01', player1: 1, player2: 1, player3: 3, player4: null }],
    version: '1.4',
  };
  ctx.importData({ target: { files: [fakeFile(badData)], value: '' } });
  const errors = ctx._messages.filter(m => m.isError);
  assert.equal(errors.length, 1, 'expected one error message');
  assert.ok(
    errors[0].msg.includes('same position'),
    `error should mention same position, got: ${errors[0].msg}`,
  );
  // On failure, localStorage should not be written (no marioKartRaces key set).
  const stored = ctx.localStorage.getItem('marioKartRaces');
  assert.equal(stored, null, 'races must not be persisted on failure');
});

// --- backup/restore: version-aware storage keys (Bug 20e) ------------------

function makeBackupContext(version) {
  const prefixes = { mk8d: 'marioKart', mkworld: 'marioKartWorld' };
  const versionAwareKey = function (key) {
    const prefix = prefixes[version];
    if (key.startsWith('marioKart')) key = key.replace(/^marioKart(World)?/, '');
    return prefix + key;
  };

  // Stub PlayerNameManager so backup.js skips the fallback branch that
  // calls updatePlayerLabels (which lives in playerManager.js, not loaded here).
  const stubNameManager = {
    getAll: () => ({ player1: 'P1', player2: 'P2', player3: 'P3', player4: 'P4' }),
    setAll: () => {},
    get: (k) => 'P',
    set: () => {},
    subscribe: () => {},
  };

  const ctx = makeContext({
    races: [{ date: '2026-01-01', player1: 1, player2: 2, player3: null, player4: null }],
    actionHistory: [],
    playerNames: { player1: 'P1', player2: 'P2', player3: 'P3', player4: 'P4' },
    updateDisplay: () => {},
    updateAchievements: () => {},
    updateClearButtonState: () => {},
  });
  ctx.window.PlayerNameManager = stubNameManager;
  ctx.window.getStorageKey = versionAwareKey;
  loadInto(ctx, 'backup.js');
  return ctx;
}

test('autoBackupToLocalStorage: MK8D writes to marioKartAutoBackup', () => {
  const ctx = makeBackupContext('mk8d');
  ctx.autoBackupToLocalStorage();
  const stored = ctx.localStorage.getItem('marioKartAutoBackup');
  assert.ok(stored !== null, 'expected marioKartAutoBackup to be set');
  const parsed = JSON.parse(stored);
  assert.equal(parsed.races.length, 1);
});

test('autoBackupToLocalStorage: MK World writes to marioKartWorldAutoBackup, not marioKartAutoBackup', () => {
  const ctx = makeBackupContext('mkworld');
  ctx.autoBackupToLocalStorage();
  assert.equal(
    ctx.localStorage.getItem('marioKartAutoBackup'),
    null,
    'MK8D key must be untouched in MK World mode',
  );
  const stored = ctx.localStorage.getItem('marioKartWorldAutoBackup');
  assert.ok(stored !== null, 'expected marioKartWorldAutoBackup to be set');
});

test('restoreFromBackup (confirm path): MK World restores to marioKartWorldRaces, leaves marioKartRaces untouched', () => {
  const ctx = makeBackupContext('mkworld');
  // Pre-seed an MK8D race to verify isolation.
  ctx.localStorage.setItem('marioKartRaces', JSON.stringify([{ date: '2025-01-01', player1: 5 }]));

  // Write a World backup into the World-keyed slot.
  const backupPayload = {
    races: [{ date: '2026-06-01', player1: 1, player2: 2, player3: null, player4: null }],
    playerNames: { player1: 'P1', player2: 'P2', player3: 'P3', player4: 'P4' },
    backupDate: new Date().toISOString(),
    version: '2.2',
  };
  ctx.localStorage.setItem('marioKartWorldAutoBackup', JSON.stringify(backupPayload));

  // restoreFromBackup shows a confirm modal; intercept the onclick directly.
  // We need getElementById to return a stub element so the modal flow works.
  const buttons = {};
  ctx.document.getElementById = (id) => {
    if (!buttons[id]) buttons[id] = { onclick: null };
    return buttons[id];
  };
  ctx.document.body.appendChild = () => {};
  ctx.document.body.removeChild = () => {};
  ctx.document.querySelector = () => null;

  ctx.restoreFromBackup();

  // Simulate user clicking "Confirm restore".
  assert.ok(buttons['confirm-restore'], 'confirm-restore button should be registered');
  buttons['confirm-restore'].onclick();

  // World key should have the restored races.
  const worldRaces = JSON.parse(ctx.localStorage.getItem('marioKartWorldRaces'));
  assert.ok(Array.isArray(worldRaces), 'marioKartWorldRaces should be set');
  assert.equal(worldRaces.length, 1);
  assert.equal(worldRaces[0].date, '2026-06-01');

  // MK8D key must be untouched.
  const mk8dRaces = JSON.parse(ctx.localStorage.getItem('marioKartRaces'));
  assert.equal(mk8dRaces[0].date, '2025-01-01', 'marioKartRaces must not be overwritten');
});
