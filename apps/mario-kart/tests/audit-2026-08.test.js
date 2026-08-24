'use strict';

// Regressions from the 2026-08-22 site audit (apps/mario-kart/FINDINGS.md).
// Each block names the defect it pins. They all run through the REAL app
// functions loaded into the vm harness; DOM is stubbed only as far as the
// function under test needs to produce its HTML string.

process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, evalIn } = require('./harness');

const ESCAPE_HTML = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'assets', 'js', 'escape-html.js'), 'utf8');

// A stub element that records innerHTML and answers the few DOM calls the
// renderers make on it.
function el(id) {
  return {
    id, value: '', innerHTML: '', style: {}, onclick: null, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    insertAdjacentHTML() {}, appendChild() {}, focus() {}, setAttribute() {}, remove() {},
  };
}

// The whole app's data layer in one context: dataManager + undoRedo +
// playerManager + statistics + the renderers in main.js. main.js registers
// DOMContentLoaded work that never fires here.
function appContext({ races = [], playerCount = 3, names = {}, maxPositions = 12 } = {}) {
  const elements = {};
  const messages = [];
  const byId = (id) => { if (!elements[id]) elements[id] = el(id); return elements[id]; };
  const ctx = makeContext({
    MIN_POSITIONS: 1,
    MAX_POSITIONS: maxPositions,
    playerCount,
    showMessage: (msg, isError) => messages.push({ msg, isError: Boolean(isError) }),
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
  ctx.window.MAX_POSITIONS = maxPositions;
  ctx.window.addEventListener = () => {};
  ctx.window.location = ctx.location;
  vm.runInContext(ESCAPE_HTML, ctx);
  ctx.escapeHtml = ctx.window.escapeHtml;
  const allNames = { player1: 'Player 1', player2: 'Player 2', player3: 'Player 3', player4: 'Player 4', ...names };
  ctx.window.PlayerNameManager = {
    get: (k) => allNames[k], getAll: () => ({ ...allNames }), set() {}, setAll() {}, subscribe() {}, initialize() {},
  };
  ctx.presentModal = ({ html }) => { elements.__modal = { html }; return { close() {} }; };
  for (const f of ['utils.js', 'dataManager.js', 'undoRedo.js', 'playerManager.js', 'dateFilter.js', 'statistics.js', 'main.js']) {
    loadInto(ctx, f);
  }
  evalIn(ctx, `races = ${JSON.stringify(races)}`);
  evalIn(ctx, `playerCount = ${playerCount}; players = rosterForCount(playerCount)`);
  // main.js declares its own showMessage (the toast); route it to the log.
  const capture = (msg, isError) => messages.push({ msg, isError: Boolean(isError) });
  ctx.showMessage = capture;
  ctx.window.showMessage = capture;
  return {
    ctx, elements, messages, el: byId,
    races: () => JSON.parse(evalIn(ctx, 'JSON.stringify(races)')),
    stored: (key = 'marioKartRaces') => { const r = ctx.localStorage.getItem(key); return r === null ? null : JSON.parse(r); },
    errors: () => messages.filter((m) => m.isError).map((m) => m.msg),
  };
}

const RACES = [
  { date: '2026-08-01', timestamp: '10:00:00 CDT', player1: 1, player2: 2, player3: 3, player4: null },
  { date: '2026-08-02', timestamp: '11:00:00 CDT', player1: 2, player2: 1, player3: 3, player4: null },
  { date: '2026-08-03', timestamp: '12:00:00 CDT', player1: 3, player2: 2, player3: 1, player4: null },
];

// --- D1: clear all + undo ----------------------------------------------------

test('D1 clear -> undo restores the snapshot; a following add and reload keep a dense log', () => {
  const app = appContext({ races: RACES });
  // An EDIT is the latest undo entry, the shape that used to replay a stale
  // index into the emptied array and persist [null, null, ..., {race}].
  evalIn(app.ctx, `races[1] = { ...races[1], player1: 4 }; saveAction('EDIT_RACE', { originalRace: ${JSON.stringify(RACES[1])}, newRace: races[1], index: 1 })`);
  app.ctx.clearData();
  assert.equal(app.races().length, 0);
  assert.deepEqual(app.stored(), []);

  app.ctx.undoLastAction();
  assert.equal(app.races().length, 3, 'undo after clear brings the races back');
  assert.equal(app.races()[1].player1, 4, 'the edited row comes back edited');
  assert.ok(app.stored().every((r) => r && typeof r === 'object'), 'no null rows persisted');

  // The older EDIT entry must still apply to the same row.
  app.ctx.undoLastAction();
  assert.equal(app.races()[1].player1, 2, 'the edit before the clear undoes against the restored rows');
  assert.ok(app.stored().every((r) => r && typeof r === 'object'));

  // Write after undo, then "reload" from storage through the real loader.
  evalIn(app.ctx, `races.push({ date: '2026-08-04', player1: 1, player2: 2, player3: null, player4: null }); localStorage.setItem('marioKartRaces', JSON.stringify(races))`);
  app.ctx.loadSavedData();
  const reloaded = app.races();
  assert.equal(reloaded.length, 4);
  assert.ok(reloaded.every((r) => r && typeof r.date === 'string'), 'reload sees only real rows');
  assert.doesNotThrow(() => app.ctx.calculateStats(reloaded));
});

test('D1 clear refreshes the auto-backup so Restore can bring the races back after a reload', () => {
  const app = appContext({ races: RACES });
  let backedUp = null;
  app.ctx.autoBackupToLocalStorage = () => { backedUp = app.races().length; };
  app.ctx.clearData();
  assert.equal(backedUp, 3, 'the backup is taken before the log is emptied');
});

test('D1 redo after undoing a clear empties the log again', () => {
  const app = appContext({ races: RACES });
  app.ctx.clearData();
  app.ctx.undoLastAction();
  app.ctx.redoLastAction();
  assert.equal(app.races().length, 0);
  assert.deepEqual(app.stored(), []);
});

test('D1 a sparse log left by the old bug is healed on load', () => {
  const app = appContext();
  app.ctx.localStorage.setItem('marioKartRaces', JSON.stringify([null, null, RACES[0]]));
  app.ctx.loadSavedData();
  assert.equal(app.races().length, 1);
  assert.equal(app.stored().length, 1, 'the healed log is written back');
});

// --- D2: player-count decrease ------------------------------------------------

test('D2 decreasing the player count no longer throws and narrows the entry form', () => {
  const fourWide = RACES.map((r) => ({ ...r, player4: 4 }));
  const app = appContext({ races: fourWide, playerCount: 4 });
  app.el('player3').value = '3';
  app.el('player4').value = '4';
  let refreshed = 0;
  app.ctx.window.refreshSidebarRaceForm = () => { refreshed++; };

  assert.doesNotThrow(() => app.ctx.updatePlayerCount(2));
  assert.equal(evalIn(app.ctx, 'playerCount'), 2);
  assert.equal(app.ctx.localStorage.getItem('marioKartPlayerCount'), '2');
  assert.equal(app.elements.player3.value, '', 'removed slots are cleared from the form');
  assert.equal(app.elements.player4.value, '');
  assert.equal(refreshed, 1, 'the sidebar race form is regenerated');
  assert.match(app.messages.at(-1).msg, /Updated to 2 players/);
  // Recorded results of the removed players are kept (roster union), so the
  // history and stats still read four columns.
  assert.equal(evalIn(app.ctx, 'players.join(",")'), 'player1,player2,player3,player4');
  assert.equal(app.ctx.calculateStats(fourWide).racesPlayed.player4, 3);

  // Back up and down again.
  app.ctx.updatePlayerCount(3);
  app.ctx.updatePlayerCount(1);
  assert.equal(evalIn(app.ctx, 'playerCount'), 1);
  assert.equal(app.ctx.localStorage.getItem('marioKartPlayerCount'), '1');
});

// --- D3: stored XSS through every renderer --------------------------------------

const HOSTILE = `<img src=x onerror="window.__pwn=1"> "Bob" & 'Cara'`;
const hostileRaces = [
  { date: '2026-08-01', timestamp: HOSTILE, player1: 1, player2: 2, player3: null, player4: null, course: HOSTILE },
  { date: '2026-08-02', timestamp: '11:00:00 CDT', player1: 2, player2: 1, player3: null, player4: null },
];
const escaped = '&lt;img src=x onerror=&quot;window.__pwn=1&quot;&gt; &quot;Bob&quot; &amp; &#39;Cara&#39;';

function assertEscaped(html, where) {
  assert.ok(!/<img\b/i.test(html), `${where}: a raw <img> tag reached the HTML`);
  assert.ok(!/onerror="/i.test(html), `${where}: a live onerror attribute reached the HTML`);
  assert.ok(html.includes(escaped), `${where}: the hostile text does not round-trip escaped`);
}

test('D3 H2H tables escape player names and symbols', () => {
  const app = appContext({ races: hostileRaces, playerCount: 2, names: { player1: HOSTILE } });
  app.ctx.window.PlayerSymbolManager = { getSymbol: (k) => (k === 'player2' ? '<b>x</b>' : null) };
  const stats = app.ctx.calculateStats(hostileRaces);
  const global = app.ctx.generateH2HTable(stats);
  const daily = app.ctx.generateDailyH2HTable(stats);
  assertEscaped(global, 'global H2H');
  assertEscaped(daily, 'daily H2H');
  assert.ok(!global.includes('<b>x</b>'), 'symbol is escaped');
  assert.ok(global.includes('data-vs="vs ' + escaped + '"'), 'the phone card label carries the escaped name');
});

test('D3 history table and mobile cards escape timestamps, course names and player names', () => {
  const app = appContext({ races: hostileRaces, playerCount: 2, names: { player2: HOSTILE } });
  app.ctx.updateRaceHistoryTable(hostileRaces);
  const table = app.elements['history-body'].innerHTML;
  const cards = app.elements['mobile-history'].innerHTML;
  assertEscaped(table, 'history table');
  assertEscaped(cards, 'mobile cards');
  assert.ok(!table.includes(`🗺️ ${HOSTILE}`), 'course label escaped in the table');
  assert.ok(cards.includes('<span class="player-label">' + escaped + ':</span>'), 'card player label escaped');
});

test('D3 history headers and stat cards escape player names', () => {
  const app = appContext({ races: hostileRaces, playerCount: 2, names: { player1: HOSTILE } });
  evalIn(app.ctx, "currentView = 'stats'");
  app.ctx.updateDisplay();
  assertEscaped(app.elements['thead-row'].innerHTML, 'history headers');
  assertEscaped(app.elements['stats-display'].innerHTML, 'stats cards');
});

test('D3 the edit modal escapes names, the timestamp meta line and the date attribute', () => {
  const app = appContext({ races: [{ ...hostileRaces[0], date: '2026-08-01" onfocus="window.__pwn=1' }], playerCount: 2, names: { player1: HOSTILE } });
  app.ctx.editRace(0);
  const html = app.elements.__modal.html;
  assertEscaped(html, 'edit modal');
  assert.ok(!html.includes('value="2026-08-01" onfocus='), 'date attribute cannot break out of its quotes');
});

test('D3 the delete modal escapes the race date', () => {
  const app = appContext({ races: [{ ...RACES[0], date: HOSTILE }], playerCount: 2 });
  app.ctx.deleteRace(0);
  assert.ok(!/<img\b/i.test(app.elements.__modal.html));
});

// --- D5 / D14: one validator for import and restore ---------------------------------

function importFile(app, payload) {
  function FakeFileReader() {}
  FakeFileReader.prototype.readAsText = function (file) { this.onload({ target: { result: file.text } }); };
  app.ctx.FileReader = FakeFileReader;
  app.ctx.updatePlayerCount = () => {};
  app.ctx.importData({ target: { files: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], value: '' } });
}

test('D14 import: a non-JSON file and a null entry get plain-language messages, never internals', () => {
  const app = appContext();
  importFile(app, '{not json');
  assert.equal(app.errors().at(-1), 'Import failed: that file is not valid JSON');
  assert.equal(app.stored(), null);

  const app2 = appContext();
  importFile(app2, { races: [null, RACES[0]] });
  assert.equal(app2.errors().length, 0, 'an empty entry is dropped, not fatal');
  assert.match(app2.messages.at(-1).msg, /Imported 1 races \(repaired: dropped an empty entry\)/);
  assert.equal(app2.stored().length, 1);
  assert.ok(!app2.messages.some((m) => /hasOwnProperty|TypeError/.test(m.msg)));
});

test('D14 import: garbage dates are rejected with the offending race named', () => {
  const app = appContext();
  importFile(app, { races: [RACES[0], { ...RACES[1], date: '2026-13-45' }] });
  assert.equal(app.errors().at(-1), 'Import failed: race #2 has an invalid date (2026-13-45); dates must be YYYY-MM-DD');
  assert.equal(app.stored(), null, 'nothing persisted on failure');

  const app2 = appContext();
  importFile(app2, { races: [{ ...RACES[0], date: 'garbage' }] });
  assert.match(app2.errors().at(-1), /race #1 has an invalid date \(garbage\)/);
});

test('D14 import: numeric player names fall back to defaults instead of crashing', () => {
  const app = appContext();
  let setAllWith = null;
  app.ctx.window.PlayerNameManager.setAll = (names) => { setAllWith = names; };
  importFile(app, { races: [RACES[0]], playerNames: { player1: 12, player2: '  Zed  ', player3: 'x'.repeat(80) } });
  assert.equal(app.errors().length, 0);
  assert.equal(JSON.stringify(setAllWith), JSON.stringify({ player2: 'Zed', player3: 'x'.repeat(40) }));
});

test('D3 import: hostile timestamps and course tags are dropped, not stored', () => {
  const app = appContext();
  importFile(app, { races: [{ ...RACES[0], timestamp: HOSTILE, course: 42 }] });
  assert.equal(app.errors().length, 0);
  const [race] = app.stored();
  assert.equal(race.timestamp, undefined);
  assert.equal(race.course, undefined);
  assert.match(app.messages.at(-1).msg, /dropped an unreadable time.*dropped an unreadable course tag/);
});

test('D5 import: decimal, out-of-range and duplicate positions are rejected; whole-number text is converted', () => {
  for (const [race, re] of [
    [{ ...RACES[0], player1: 2.5 }, /race #1 has an invalid player 1 position \(2\.5\)/],
    [{ ...RACES[0], player1: 13 }, /race #1 has an invalid player 1 position \(13\)/],
    [{ ...RACES[0], player1: 0 }, /position \(0\)/],
    [{ ...RACES[0], player1: -1 }, /position \(-1\)/],
    [{ ...RACES[0], player2: 1 }, /race #1: players cannot have the same position \(1\)/],
  ]) {
    const app = appContext();
    importFile(app, { races: [race] });
    assert.match(app.errors().at(-1), re);
    assert.equal(app.stored(), null);
  }
  const app = appContext();
  importFile(app, { races: [{ ...RACES[0], player1: '1' }] });
  assert.equal(app.errors().length, 0);
  assert.equal(app.stored()[0].player1, 1);
});

test('D5 import: a real older-shape export (slav/mike/nikita keys, 24:MM stamp) still imports', () => {
  const legacy = {
    version: '1.0',
    exportDate: '2024-11-02T05:12:00.000Z',
    races: [
      { date: '2024-11-01', timestamp: '24:05:12 CDT', slav: 1, mike: 3, nikita: 2 },
      { date: '2024-11-01', timestamp: '23:40:00 CDT', slav: 2, mike: 1, nikita: null },
    ],
    playerNames: { player1: 'Slav', player2: 'Mike', player3: 'Nikita' },
  };
  const app = appContext();
  importFile(app, legacy);
  assert.equal(app.errors().length, 0, app.errors().join(' | '));
  const stored = app.stored();
  assert.equal(stored.length, 2);
  assert.deepEqual([stored[0].player1, stored[0].player2, stored[0].player3, stored[0].player4], [1, 3, 2, null]);
  assert.equal(stored[0].timestamp, '00:05:12 CDT');
  assert.equal(stored[0].slav, undefined);
  assert.match(app.messages.at(-1).msg, /migrated legacy player keys x2, healed a 24:MM midnight time/);
});

test('D5 restore: a tampered backup (24:MM, duplicate positions, 99) is refused and nothing changes', () => {
  const app = appContext({ races: RACES });
  app.ctx.localStorage.setItem('marioKartRaces', JSON.stringify(RACES));
  app.ctx.localStorage.setItem('marioKartAutoBackup', JSON.stringify({
    races: [{ date: '2026-08-01', timestamp: '24:10:00 CDT', player1: 5, player2: 5, player3: 99, player4: null }],
    backupDate: '2026-08-22T10:00:00Z', version: '2.2',
  }));
  loadInto(app.ctx, 'backup.js');
  app.ctx.restoreFromBackup();
  assert.equal(app.elements.__modal, undefined, 'no confirm modal for an invalid backup');
  assert.match(app.errors().at(-1), /^Backup cannot be restored: race #1: players cannot have the same position \(5\)/);
  assert.equal(app.stored().length, 3, 'current log untouched');
});

test('D5 restore: a valid backup is healed through the same validator and resets the undo stack', () => {
  const app = appContext({ races: RACES });
  evalIn(app.ctx, `saveAction('EDIT_RACE', { originalRace: races[0], newRace: races[0], index: 0 })`);
  app.ctx.localStorage.setItem('marioKartAutoBackup', JSON.stringify({
    races: [{ date: '2026-07-01', timestamp: '24:10:00 CDT', player1: 1, player2: 2, player3: null, player4: null }],
    playerNames: { player1: 'A', player2: 7 },
    backupDate: '2026-08-22T10:00:00Z', version: '2.2',
  }));
  loadInto(app.ctx, 'backup.js');
  app.ctx.restoreFromBackup();
  assert.ok(app.elements.__modal, 'confirm modal shown');
  app.elements['confirm-restore'].onclick();
  assert.equal(app.races().length, 1);
  assert.equal(app.races()[0].timestamp, '00:10:00 CDT');
  assert.equal(evalIn(app.ctx, 'historyPosition'), -1, 'undo stack reset (it indexed the old log)');
  assert.match(app.messages.at(-1).msg, /restored from backup \(repaired: healed a 24:MM midnight time\)/);
});

// --- D7 is pinned in dateFilter.test.js -------------------------------------------

// --- D9: widened roster --------------------------------------------------------------

test('D9 a race without a player4 key renders "-" in the history table and no card line, never "undefined"', () => {
  const app = appContext({ races: [{ date: '2026-08-01', player1: 1, player2: 2, player3: 3 }], playerCount: 4 });
  app.ctx.updateRaceHistoryTable(app.races());
  const table = app.elements['history-body'].innerHTML;
  const cards = app.elements['mobile-history'].innerHTML;
  assert.ok(!table.includes('undefined'), table);
  assert.ok(!cards.includes('undefined'), cards);
  assert.equal((table.match(/position-absent/g) || []).length, 1);
});

// --- D10: per-version names and count --------------------------------------------------

function namesContext(version, seed = {}) {
  const prefixes = { mk8d: 'marioKart', mkworld: 'marioKartWorld' };
  const ctx = makeContext();
  for (const [k, v] of Object.entries(seed)) ctx.localStorage.setItem(k, JSON.stringify(v));
  ctx.window.getStorageKey = (key) => prefixes[version] + key.replace(/^marioKart(World)?/, '');
  loadInto(ctx, 'playerNameManager.js');
  return ctx;
}

test('D10 player names are read and written under the game version key', () => {
  const ctx = namesContext('mkworld', { marioKartPlayerNames: { player1: 'Alice' } });
  // First visit to MK World: falls back to the MK8D names (read only).
  assert.equal(ctx.window.PlayerNameManager.get('player1'), 'Alice');
  assert.equal(ctx.localStorage.getItem('marioKartWorldPlayerNames'), null);
  // A rename in MK World writes the World key and leaves MK8D alone.
  ctx.window.PlayerNameManager.set('player1', 'Zed');
  assert.equal(JSON.parse(ctx.localStorage.getItem('marioKartWorldPlayerNames')).player1, 'Zed');
  assert.equal(JSON.parse(ctx.localStorage.getItem('marioKartPlayerNames')).player1, 'Alice');
});

test('D10 names longer than 40 characters are trimmed and non-strings fall back to defaults', () => {
  const ctx = namesContext('mk8d', { marioKartPlayerNames: { player1: 12, player2: ' Bo ' } });
  assert.equal(ctx.window.PlayerNameManager.get('player1'), 'Player 1');
  assert.equal(ctx.window.PlayerNameManager.get('player2'), 'Bo');
  ctx.window.PlayerNameManager.set('player3', 'y'.repeat(90));
  assert.equal(ctx.window.PlayerNameManager.get('player3').length, 40);
});

test('D10 the player count is loaded per version, with the MK8D count as a one-time fallback', () => {
  const world = appContext({ playerCount: 4 });
  world.ctx.window.getStorageKey = (key) => 'marioKartWorld' + key.replace(/^marioKart(World)?/, '');
  world.ctx.localStorage.setItem('marioKartPlayerCount', '2');
  world.ctx.loadSavedData();
  assert.equal(evalIn(world.ctx, 'playerCount'), 2, 'falls back to the MK8D count when World has none');
  world.ctx.localStorage.setItem('marioKartWorldPlayerCount', '4');
  world.ctx.loadSavedData();
  assert.equal(evalIn(world.ctx, 'playerCount'), 4, 'the World count wins once stored');
  world.ctx.localStorage.removeItem('marioKartWorldPlayerCount');
  world.ctx.localStorage.removeItem('marioKartPlayerCount');
  world.ctx.loadSavedData();
  assert.equal(evalIn(world.ctx, 'playerCount'), 3, 'no count anywhere: the default, not the previous in-memory value');
});

// --- D11: history order and sort direction --------------------------------------------------

test('D11 default history order is chronological newest first, and "asc" really ascends', () => {
  const out = [
    { date: '2026-08-02', timestamp: '09:00:00 CDT', player1: 3, player2: 1, player3: null, player4: null },
    { date: '2026-08-01', timestamp: '09:00:00 CDT', player1: 1, player2: 2, player3: null, player4: null },
    { date: '2026-08-03', timestamp: '09:00:00 CDT', player1: 2, player2: 3, player3: null, player4: null },
  ];
  const app = appContext({ races: out, playerCount: 2 });
  const numbers = () => [...app.elements['history-body'].innerHTML.matchAll(/<tr>\s*<td>(\d+)<\/td>/g)].map((m) => Number(m[1]));
  app.ctx.updateRaceHistoryTable(out);
  assert.deepEqual(numbers(), [3, 1, 2], 'newest date first; Race # still follows insertion order');

  evalIn(app.ctx, "currentView = 'stats'");
  app.ctx.sortTable('player1'); // first click: ascending
  assert.deepEqual(numbers(), [2, 3, 1], 'positions 1, 2, 3 top to bottom');
  assert.ok(app.elements['thead-row'].innerHTML.includes('data-sort="player1" onclick'), 'header carries data-sort for focus restore');
  assert.match(app.elements['thead-row'].innerHTML, /aria-sort="ascending" data-sort="player1"/);
  app.ctx.sortTable('player1'); // second click: descending
  assert.deepEqual(numbers(), [1, 3, 2]);
});

// --- D13: decimal / exponent positions in the sidebar form -------------------------------------

test('D13 the sidebar form rejects "1.5" and "1e1" with a message instead of storing 1', () => {
  const app = appContext({ playerCount: 2 });
  app.el('sidebar-date-input').value = '2026-08-01';
  app.el('date').value = '2026-08-01';
  app.el('sidebar-player1').value = '1.5';
  app.el('sidebar-player2').value = '2';
  app.ctx.submitSidebarRace();
  assert.equal(app.races().length, 0);
  assert.equal(app.el('sidebar-race-error').textContent, 'Positions must be whole numbers (no decimals)');
  app.el('sidebar-player1').value = '1e1';
  app.ctx.submitSidebarRace();
  assert.equal(app.races().length, 0);
});

test('D13 addRace itself refuses a non-integer position', () => {
  const app = appContext({ playerCount: 2 });
  app.el('date').value = '2026-08-01';
  app.el('player1').value = '2.5';
  app.el('player2').value = '1';
  app.ctx.addRace();
  assert.equal(app.races().length, 0);
  assert.equal(app.errors().at(-1), 'Positions must be whole numbers');
});
