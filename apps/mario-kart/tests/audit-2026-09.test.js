'use strict';

// Regressions from the 2026-09-12 site audit, items M-1 to M-4
// (apps/mario-kart/FINDINGS.md). Everything runs through the REAL app files
// in the vm harness. Dialogs are opened the way a click opens them: the
// history table is rendered from the live log and the row's own onclick is
// executed, so whatever the button identifies a race by is what is tested.

process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, evalIn } = require('./harness');

const ESCAPE_HTML = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'assets', 'js', 'escape-html.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// A refused write logs; keep the test output readable.
const QUIET = { log() {}, info() {}, warn() {}, error() {} };

function el(id) {
  return {
    id, value: '', innerHTML: '', style: {}, onclick: null, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    insertAdjacentHTML() {}, appendChild() {}, focus() {}, setAttribute() {}, remove() {},
  };
}

// The data layer, the renderers and backup.js in one context, seeded the way
// a real page is: the log is put in storage and read by loadSavedData().
function appContext({ stored = null, playerCount = 3 } = {}) {
  const elements = {};
  const messages = [];
  const byId = (id) => { if (!elements[id]) elements[id] = el(id); return elements[id]; };
  const ctx = makeContext({
    console: QUIET,
    MIN_POSITIONS: 1,
    MAX_POSITIONS: 12,
    playerCount,
    updateAchievements: () => {},
    createAllBars: () => {},
    clearAllVisualizationBars: () => {},
    history: { replaceState() {} },
    location: { hash: '' },
    document: {
      getElementById: byId,
      querySelector: (sel) => (sel === '#history-table thead tr' ? byId('thead-row') : null),
      querySelectorAll: () => [],
      createElement: () => el('x'),
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  ctx.window.MIN_POSITIONS = 1;
  ctx.window.MAX_POSITIONS = 12;
  ctx.window.addEventListener = () => {};
  ctx.window.location = ctx.location;
  vm.runInContext(ESCAPE_HTML, ctx);
  ctx.escapeHtml = ctx.window.escapeHtml;
  const names = { player1: 'Player 1', player2: 'Player 2', player3: 'Player 3', player4: 'Player 4' };
  ctx.window.PlayerNameManager = {
    get: (k) => names[k], getAll: () => ({ ...names }), set() {}, setAll() {}, subscribe() {}, initialize() {},
  };
  ctx.presentModal = ({ html }) => {
    elements.__modal = { html, open: true };
    return { close() { elements.__modal.open = false; } };
  };
  for (const f of ['utils.js', 'dataManager.js', 'undoRedo.js', 'playerManager.js', 'dateFilter.js', 'statistics.js', 'main.js', 'backup.js']) {
    loadInto(ctx, f);
  }
  evalIn(ctx, `playerCount = ${playerCount}; players = rosterForCount(playerCount)`);
  // main.js declares its own showMessage (the toast); route it to the log.
  const capture = (msg, isError) => messages.push({ msg, isError: Boolean(isError) });
  ctx.showMessage = capture;
  ctx.window.showMessage = capture;
  if (stored) {
    ctx.localStorage.setItem('marioKartRaces', JSON.stringify(stored));
    ctx.loadSavedData();
  }
  return {
    ctx, elements, messages, el: byId,
    races: () => JSON.parse(evalIn(ctx, 'JSON.stringify(races)')),
    stored: (key = 'marioKartRaces') => { const r = ctx.localStorage.getItem(key); return r === null ? null : JSON.parse(r); },
    errors: () => messages.filter((m) => m.isError).map((m) => m.msg),
  };
}

// Three races as they exist in storage today: no ids.
const LEGACY = [
  { date: '2026-08-01', timestamp: '10:00:00 CDT', player1: 1, player2: 2, player3: 3, player4: null },
  { date: '2026-08-02', timestamp: '11:00:00 CDT', player1: 2, player2: 1, player3: 3, player4: null },
  { date: '2026-08-03', timestamp: '12:00:00 CDT', player1: 3, player2: 2, player3: 1, player4: null },
];
const dates = (rows) => rows.map((r) => r && r.date);
const noNullRows = (rows) => rows.every((r) => r && typeof r === 'object');

// Render the history table from the live log, find the row for `date`, and
// run the exact onclick its `action` button carries.
function clickRow(app, date, action) {
  evalIn(app.ctx, 'updateRaceHistoryTable(races)');
  const shown = evalIn(app.ctx, `formatDateForDisplay(${JSON.stringify(date)})`);
  const row = app.elements['history-body'].innerHTML.split('<tr>').find((chunk) => chunk.includes(shown));
  assert.ok(row, `no history row for ${date}`);
  const call = row.match(new RegExp(`${action}\\(([^)]*)\\)`));
  assert.ok(call, `the row for ${date} has no ${action} button`);
  evalIn(app.ctx, `${action}(${call[1]})`);
}

// The edit dialog's inputs, as the user leaves them before pressing Save.
function fillEditDialog(app, race, positions) {
  app.el('edit-date').value = race.date;
  app.el('edit-time').value = race.timestamp.split(' ')[0];
  for (const [player, value] of Object.entries(positions)) app.el(`edit-${player}`).value = String(value);
}

function fillAddForm(app, date, positions) {
  app.el('date').value = date;
  for (const [player, value] of Object.entries(positions)) app.el(player).value = String(value);
}

// Another tab (or a cloud delivery) rewrites the stored log and this tab
// re-reads it, which is what both refresh handlers in main.js do.
function foreignWrite(app, mutate) {
  app.ctx.localStorage.setItem('marioKartRaces', JSON.stringify(mutate(app.stored())));
  app.ctx.loadSavedData();
}

// Storage refuses every write until the returned function is called.
function refuseWrites(app) {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  const real = app.ctx.localStorage.setItem;
  app.ctx.localStorage.setItem = () => { throw error; };
  return () => { app.ctx.localStorage.setItem = real; };
}

// --- M-1: the dialog must commit to the race it showed ------------------------

test('M-1 edit: a foreign delete while the dialog is open still edits the intended race, no duplicate, no null', () => {
  const app = appContext({ stored: LEGACY });
  clickRow(app, '2026-08-03', 'editRace');
  foreignWrite(app, (rows) => rows.slice(1)); // another tab deleted 2026-08-01
  fillEditDialog(app, LEGACY[2], { player1: 1, player2: 2, player3: 3 });
  app.elements['save-edit'].onclick();

  const rows = app.races();
  assert.deepEqual(dates(rows), ['2026-08-02', '2026-08-03'], 'no race duplicated or lost');
  assert.equal([rows[1].player1, rows[1].player2, rows[1].player3].join(','), '1,2,3', 'the race the dialog showed was edited');
  assert.equal(rows[0].player1, 2, 'the other race is untouched');
  assert.ok(noNullRows(app.stored()));
  assert.deepEqual(app.stored(), rows, 'storage matches memory');
});

test('M-1 edit: saving a race another tab deleted is refused and overwrites nothing', () => {
  const app = appContext({ stored: LEGACY });
  clickRow(app, '2026-08-01', 'editRace');
  foreignWrite(app, (rows) => rows.slice(1));
  fillEditDialog(app, LEGACY[0], { player1: 3, player2: 2, player3: 1 });
  app.elements['save-edit'].onclick();

  const rows = app.races();
  assert.deepEqual(dates(rows), ['2026-08-02', '2026-08-03']);
  assert.equal(rows[0].player1, 2, 'the race that is now first was not overwritten');
  assert.ok(app.errors().some((m) => /no longer/i.test(m)), 'the user is told the race is gone');
  assert.ok(!app.messages.some((m) => /updated successfully/i.test(m.msg)), 'no success message');
  assert.deepEqual(app.stored(), rows);
});

test('M-1 delete: a foreign delete while the confirm is open deletes the intended race, not its neighbour', () => {
  const app = appContext({ stored: LEGACY });
  clickRow(app, '2026-08-02', 'deleteRace');
  foreignWrite(app, (rows) => rows.slice(1));
  app.elements['confirm-delete-race'].onclick();

  assert.deepEqual(dates(app.races()), ['2026-08-03'], 'the race the dialog named is the one deleted');
  assert.deepEqual(app.stored(), app.races());
});

test('M-1 delete: confirming a race that no longer exists is refused, with no success message and no undo entry', () => {
  const app = appContext({ stored: LEGACY });
  clickRow(app, '2026-08-01', 'deleteRace');
  foreignWrite(app, (rows) => rows.slice(1));
  app.elements['confirm-delete-race'].onclick();

  assert.deepEqual(dates(app.races()), ['2026-08-02', '2026-08-03'], 'nothing else is deleted in its place');
  assert.equal(app.stored().length, 2);
  assert.ok(app.errors().some((m) => /no longer/i.test(m)), 'the user is told the race is gone');
  assert.ok(!app.messages.some((m) => /removed successfully/i.test(m.msg)), 'no no-op success message');
  assert.equal(evalIn(app.ctx, 'historyPosition'), -1, 'no undo entry for a delete that did not happen');
});

test('M-1 undo: undoing a delete made after a foreign write never persists a null row', () => {
  const app = appContext({ stored: LEGACY });
  clickRow(app, '2026-08-03', 'deleteRace');
  foreignWrite(app, (rows) => rows.slice(1));
  app.elements['confirm-delete-race'].onclick();
  assert.deepEqual(dates(app.races()), ['2026-08-02'], 'the last race was deleted even though its index moved');

  app.ctx.undoLastAction();
  assert.ok(noNullRows(app.stored()), `no null row is persisted: ${JSON.stringify(app.stored())}`);
  assert.deepEqual(dates(app.stored()).sort(), ['2026-08-02', '2026-08-03']);
  assert.deepEqual(app.stored(), app.races());
});

test('M-1 undo: an edit undone after a foreign delete restores the edited race and overwrites no other', () => {
  const app = appContext({ stored: LEGACY });
  clickRow(app, '2026-08-02', 'editRace');
  fillEditDialog(app, LEGACY[1], { player1: 3, player2: 1, player3: 2 });
  app.elements['save-edit'].onclick();
  // Another tab deletes 2026-08-01 and this tab re-reads before anything
  // drops its undo stack.
  foreignWrite(app, (rows) => rows.slice(1));

  app.ctx.undoLastAction();
  const rows = app.races();
  assert.deepEqual(dates(rows), ['2026-08-02', '2026-08-03'], 'nothing duplicated, nothing overwritten');
  assert.equal(rows[0].player1, 2, 'the edit is undone on the race it was made to');
  assert.equal(rows[1].player1, 3, 'the 2026-08-03 race is untouched');
  assert.ok(noNullRows(app.stored()));
  assert.deepEqual(app.stored(), rows);
});

test('M-1 ids: legacy races get the same ids on every device, unique even for identical races, stable across reloads', () => {
  const twin = { date: '2026-08-04', timestamp: '09:00:00 CDT', player1: 1, player2: 2, player3: 3, player4: null };
  const legacy = [...LEGACY, twin, { ...twin }];
  const deviceA = appContext({ stored: legacy });
  const deviceB = appContext({ stored: legacy });
  // Same races with their keys in another order.
  const deviceC = appContext({ stored: legacy.map((r) => Object.fromEntries(Object.entries(r).reverse())) });

  const idsA = deviceA.races().map((r) => r.id);
  assert.ok(idsA.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)), `every race has an id: ${idsA}`);
  assert.equal(new Set(idsA).size, idsA.length, 'ids are unique, including the two identical races');
  assert.deepEqual(deviceB.races().map((r) => r.id), idsA, 'a second device derives exactly the same ids');
  assert.deepEqual(deviceC.races().map((r) => r.id), idsA, 'key order does not change an id');
  assert.deepEqual(deviceA.stored().map((r) => r.id), idsA, 'the ids are written back');
  deviceA.ctx.loadSavedData();
  assert.deepEqual(deviceA.races().map((r) => r.id), idsA, 'a reload keeps them');
});

test('M-1 ids: a newly added race gets its own id, distinct even from an identical race', () => {
  const app = appContext({ stored: LEGACY });
  for (let i = 0; i < 2; i++) {
    fillAddForm(app, '2026-08-05', { player1: 1, player2: 2, player3: 3 });
    app.ctx.addRace();
  }
  const rows = app.races();
  assert.equal(rows.length, 5);
  const [a, b] = rows.slice(-2);
  assert.ok(typeof a.id === 'string' && a.id && typeof b.id === 'string' && b.id, 'both new races carry an id');
  assert.notEqual(a.id, b.id, 'two identical races are still two races');
  assert.equal(new Set(rows.map((r) => r.id)).size, 5);
});

// --- M-2: a failed write is never reported as saved ---------------------------

test('M-2 add: a refused write shows no success, keeps memory equal to storage, and a reload has no phantom race', () => {
  const app = appContext({ stored: LEGACY });
  fillAddForm(app, '2026-08-05', { player1: 1, player2: 2, player3: 3 });
  const restore = refuseWrites(app);
  assert.doesNotThrow(() => app.ctx.addRace());
  restore();

  assert.ok(!app.messages.some((m) => /added successfully/i.test(m.msg)), 'no success message for a race that was not saved');
  assert.ok(app.errors().some((m) => /^Not saved/.test(m)), 'the user is told it was not saved');
  assert.deepEqual(app.races(), app.stored(), 'memory matches storage');
  assert.equal(app.races().length, 3);
  assert.equal(evalIn(app.ctx, 'historyPosition'), -1, 'nothing to undo');
  assert.equal(app.el('player1').value, '1', 'the form keeps the entry so it can be retried');

  app.ctx.loadSavedData();
  assert.ok(!app.races().some((r) => r.date === '2026-08-05'), 'a reload does not present the unsaved race');
});

test('M-2 edit, delete and clear: a refused write rolls the change back and says so', () => {
  const app = appContext({ stored: LEGACY });

  clickRow(app, '2026-08-02', 'editRace');
  fillEditDialog(app, LEGACY[1], { player1: 3, player2: 1, player3: 2 });
  let restore = refuseWrites(app);
  app.elements['save-edit'].onclick();
  restore();
  assert.deepEqual(app.races(), app.stored(), 'edit: memory matches storage');
  assert.equal(app.races()[1].player1, 2, 'edit: the change is rolled back');

  clickRow(app, '2026-08-02', 'deleteRace');
  restore = refuseWrites(app);
  app.elements['confirm-delete-race'].onclick();
  restore();
  assert.deepEqual(app.races(), app.stored(), 'delete: memory matches storage');
  assert.equal(app.races().length, 3, 'delete: the race is back');

  restore = refuseWrites(app);
  app.ctx.clearData();
  restore();
  assert.deepEqual(app.races(), app.stored(), 'clear: memory matches storage');
  assert.equal(app.races().length, 3, 'clear: the races are back');

  assert.ok(!app.messages.some((m) => /successfully|All races cleared/.test(m.msg)), 'no success message for any of them');
  assert.equal(app.errors().filter((m) => /^Not saved/.test(m)).length, 3);
  assert.equal(evalIn(app.ctx, 'historyPosition'), -1, 'no undo entry for changes that were not saved');
});

test('M-2 undo/redo: a refused write does not throw, and memory stays equal to storage', () => {
  const app = appContext({ stored: LEGACY });
  fillAddForm(app, '2026-08-05', { player1: 1, player2: 2, player3: 3 });
  app.ctx.addRace();
  assert.equal(app.stored().length, 4);

  let restore = refuseWrites(app);
  assert.doesNotThrow(() => app.ctx.undoLastAction(), 'undo must not throw out of the click handler');
  restore();
  assert.deepEqual(app.races(), app.stored(), 'undo: memory matches storage');
  assert.equal(app.races().length, 4);
  assert.equal(evalIn(app.ctx, 'historyPosition'), 0, 'the undo did not happen, so it is still available');

  app.ctx.undoLastAction();
  assert.equal(app.stored().length, 3);

  restore = refuseWrites(app);
  assert.doesNotThrow(() => app.ctx.redoLastAction(), 'redo must not throw out of the click handler');
  restore();
  assert.deepEqual(app.races(), app.stored(), 'redo: memory matches storage');
  assert.equal(app.races().length, 3);
  assert.equal(evalIn(app.ctx, 'historyPosition'), -1);
  assert.equal(app.errors().filter((m) => /^Not saved/.test(m)).length, 2);
});

test('M-2 restore: a refused write changes nothing, does not throw, and shows no success', () => {
  const app = appContext({ stored: LEGACY });
  const before = app.stored();
  app.ctx.localStorage.setItem('marioKartAutoBackup', JSON.stringify({
    races: [{ date: '2026-07-01', timestamp: '10:00:00 CDT', player1: 1, player2: 2, player3: null, player4: null }],
    backupDate: '2026-08-22T10:00:00Z', version: '2.2',
  }));
  app.ctx.restoreFromBackup();
  assert.ok(app.elements['confirm-restore'] && app.elements['confirm-restore'].onclick, 'the restore confirmation is shown');

  const restore = refuseWrites(app);
  assert.doesNotThrow(() => app.elements['confirm-restore'].onclick(), 'the confirm handler must not throw');
  restore();
  assert.deepEqual(app.races(), before, 'memory still holds the current races');
  assert.deepEqual(app.stored(), before, 'storage untouched');
  assert.ok(!app.messages.some((m) => /restored from backup/i.test(m.msg)), 'no success message');
  assert.ok(app.errors().some((m) => /^Not saved/.test(m)), 'the user is told it was not saved');
});

// --- M-3: import asks before it replaces the log -------------------------------

function importFile(app, payload) {
  function FakeFileReader() {}
  FakeFileReader.prototype.readAsText = function (file) { this.onload({ target: { result: file.text } }); };
  app.ctx.FileReader = FakeFileReader;
  app.ctx.updatePlayerCount = () => {};
  delete app.elements.__modal;
  delete app.elements['confirm-import'];
  delete app.elements['cancel-import'];
  app.ctx.importData({ target: { files: [{ text: JSON.stringify(payload) }], value: '' } });
}

const FILE_RACES = [
  { id: 'mk-from-file', date: '2026-09-01', timestamp: '08:00:00 CDT', player1: 1, player2: 2, player3: null, player4: null },
  { date: '2026-09-02', timestamp: '09:00:00 CDT', player1: 2, player2: 1, player3: null, player4: null },
];

test('M-3 import: a file with no valid races is refused and storage is untouched', () => {
  for (const payload of [{ races: [] }, { races: [null] }]) {
    const app = appContext({ stored: LEGACY });
    const before = app.stored();
    importFile(app, payload);
    assert.equal(app.elements.__modal, undefined, `no confirmation offered for ${JSON.stringify(payload)}`);
    assert.match(app.errors().at(-1) || '', /no races/i, 'a clear message says why');
    assert.deepEqual(app.stored(), before, 'storage untouched');
    assert.equal(app.races().length, 3);
  }
});

test('M-3 import: the confirmation names both counts, and Cancel leaves storage untouched', () => {
  const app = appContext({ stored: LEGACY });
  const before = app.stored();
  importFile(app, { races: FILE_RACES.slice(0, 1) });

  assert.ok(app.elements.__modal, 'a replacement confirmation is shown');
  const text = app.elements.__modal.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.match(text, /replace your 3 races with 1 race from the file/i, text);
  assert.deepEqual(app.stored(), before, 'nothing is written before the user confirms');

  app.elements['cancel-import'].onclick();
  assert.deepEqual(app.stored(), before, 'Cancel writes nothing');
  assert.equal(app.races().length, 3);
  assert.ok(!app.messages.some((m) => /imported/i.test(m.msg)), 'no import message');
});

test('M-3 import: confirming replaces the log, keeps file ids, and the auto-backup holds the replaced races', () => {
  const app = appContext({ stored: LEGACY });
  const previousIds = app.races().map((r) => r.id);
  importFile(app, { races: FILE_RACES });
  app.elements['confirm-import'].onclick();

  const stored = app.stored();
  assert.deepEqual(dates(stored), ['2026-09-01', '2026-09-02']);
  assert.equal(stored[0].id, 'mk-from-file', 'a valid id from the file is kept');
  assert.ok(typeof stored[1].id === 'string' && stored[1].id, 'a race without an id gets one');
  const backup = app.stored('marioKartAutoBackup');
  assert.ok(backup, 'the auto-backup was written');
  assert.deepEqual(dates(backup.races), ['2026-08-01', '2026-08-02', '2026-08-03'], 'Restore can bring back the replaced races');
  assert.deepEqual(backup.races.map((r) => r.id), previousIds);
  assert.ok(app.messages.some((m) => /imported 2 races/i.test(m.msg)));
  assert.equal(evalIn(app.ctx, 'historyPosition'), -1, 'the undo stack described the old log and is dropped');
});

// --- M-4: the closed sidebar is out of the Tab order ---------------------------

function sidebarContext() {
  const log = [];
  const doc = { activeElement: null };
  const node = (id) => {
    const attrs = new Map();
    const classes = new Set();
    const n = {
      id, style: {}, inert: false, offsetParent: {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      setAttribute: (k, v) => { attrs.set(k, String(v)); if (k === 'inert') log.push(`${id}:inert`); },
      removeAttribute: (k) => { attrs.delete(k); },
      hasAttribute: (k) => attrs.has(k),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      focus: () => { doc.activeElement = n; log.push(`${id}:focus`); },
      contains: () => false,
      querySelectorAll: () => [],
      addEventListener() {},
    };
    return n;
  };
  const sidebar = node('sidebar');
  // As shipped in index.html.
  sidebar.setAttribute('inert', '');
  sidebar.inert = true;
  log.length = 0;
  const toggle = node('sidebar-toggle');
  const elements = { sidebar, 'sidebar-overlay': node('sidebar-overlay'), 'sidebar-toggle': toggle };
  const ctx = makeContext({
    document: {
      get activeElement() { return doc.activeElement; },
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { classList: node('body').classList, appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  ctx.window.addEventListener = () => {};
  loadInto(ctx, 'sidebar.js');
  return { ctx, log, doc, node, sidebar, toggle };
}

test('M-4 the sidebar ships inert in the markup', () => {
  const aside = INDEX_HTML.match(/<aside\b[^>]*\bid="sidebar"[^>]*>/);
  assert.ok(aside, 'the sidebar <aside> is in index.html');
  assert.match(aside[0], /\sinert(?=[\s>=])/, 'the closed sidebar must be inert until it is opened');
});

test('M-4 open removes inert; close restores it and hands focus to the toggle first', () => {
  const sb = sidebarContext();
  sb.ctx.openSidebar();
  assert.equal(sb.sidebar.inert, false, 'open: inert property cleared');
  assert.equal(sb.sidebar.hasAttribute('inert'), false, 'open: inert attribute removed');

  sb.log.length = 0;
  sb.ctx.closeSidebar();
  assert.equal(sb.sidebar.inert, true, 'close: inert property set');
  assert.equal(sb.sidebar.hasAttribute('inert'), true, 'close: inert attribute set');
  assert.equal(sb.doc.activeElement, sb.toggle, 'close: focus returns to the toggle');
  const focusAt = sb.log.indexOf('sidebar-toggle:focus');
  const inertAt = sb.log.indexOf('sidebar:inert');
  assert.ok(focusAt !== -1 && focusAt < inertAt, `focus leaves the panel before it goes inert: ${sb.log}`);
});

test('M-4 the open sidebar Tab trap wraps between VISIBLE controls only', () => {
  const sb = sidebarContext();
  const first = sb.node('first');
  const lastVisible = sb.node('last-visible');
  const hiddenInput = sb.node('importFile-sidebar');
  hiddenInput.offsetParent = null; // display:none
  sb.sidebar.querySelectorAll = () => [first, lastVisible, hiddenInput];
  sb.ctx.openSidebar();

  lastVisible.focus();
  let prevented = false;
  sb.ctx.handleSidebarKeyboard({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(sb.doc.activeElement, first, 'Tab from the last visible control wraps to the first');
  assert.ok(prevented);

  prevented = false;
  sb.ctx.handleSidebarKeyboard({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; } });
  assert.equal(sb.doc.activeElement, lastVisible, 'Shift+Tab from the first wraps to the last visible, never a hidden input');
  assert.ok(prevented);
});
