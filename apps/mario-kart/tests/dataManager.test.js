'use strict';

// Pin timezone so timestamp assertions stay deterministic.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, freezeDate, evalIn } = require('./harness');

const ALL_PLAYERS = ['player1', 'player2', 'player3', 'player4'];

// A stand-in for the race-entry form: one stub element per input id, plus a
// catch-all so the undo/redo buttons dataManager/undoRedo poke at exist.
function makeElements(seed) {
  const elements = {};
  for (const [id, value] of Object.entries(seed)) {
    elements[id] = { value, style: {}, classList: { add() {}, remove() {}, contains: () => true } };
  }
  return {
    elements,
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = { value: '', style: {}, classList: { add() {}, remove() {}, contains: () => true } };
      }
      return elements[id];
    },
  };
}

// dataManager.js + undoRedo.js loaded together so the real saveAction runs and
// the undo path is exercised end to end. `races` is a top-level `let` inside
// the vm, so it is read back with JSON, never off ctx.
function makeDataContext({
  playerCount = 3,
  maxPositions = 12,
  now = '2026-03-01T14:05:09Z',
  seedRaces = [],
  storagePrefix = null,
  elementSeed = {},
  course = null,
} = {}) {
  const players = ALL_PLAYERS.slice(0, playerCount);
  const messages = [];
  const pickerCalls = [];
  const dom = makeElements(elementSeed);

  const ctx = makeContext({
    Date: freezeDate(now),
    players,
    playerCount,
    playerNames: { player1: 'P1', player2: 'P2', player3: 'P3', player4: 'P4' },
    MIN_POSITIONS: 1,
    MAX_POSITIONS: maxPositions,
    showMessage: (msg, isError) => messages.push({ msg, isError: Boolean(isError) }),
    updateDisplay: () => {},
    updateAchievements: () => {},
    updateClearButtonState: () => {},
    getFilteredRaces: () => [],
    formatDateForDisplay: (d) => d,
    document: {
      getElementById: (id) => dom.getElementById(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
      }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  });

  ctx.window.MAX_POSITIONS = maxPositions;
  ctx.window.PlayerNameManager = { get: (key) => key.toUpperCase(), getAll: () => ({}) };
  if (storagePrefix) {
    ctx.window.getStorageKey = (key) => storagePrefix + key;
  }
  if (course) {
    ctx.window.CoursePicker = {
      getSelected: () => course,
      commit: () => pickerCalls.push('commit'),
      clear: () => pickerCalls.push('clear'),
    };
  }

  loadInto(ctx, 'dataManager.js');
  loadInto(ctx, 'undoRedo.js');
  if (seedRaces.length) {
    evalIn(ctx, `races = ${JSON.stringify(seedRaces)}`);
  }

  return {
    ctx,
    messages,
    pickerCalls,
    elements: dom.elements,
    setValue: (id, value) => { dom.getElementById(id).value = value; },
    races: () => JSON.parse(evalIn(ctx, 'JSON.stringify(races)')),
    errors: () => messages.filter((m) => m.isError),
    stored: (key = 'marioKartRaces') => {
      const raw = ctx.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    },
  };
}

// Seeds the entry form the way the UI would: a date plus one input per slot.
function formSeed({ date = '2026-03-01', positions = {} } = {}) {
  const seed = { date };
  for (const player of ALL_PLAYERS) {
    seed[player] = positions[player] === undefined ? '' : String(positions[player]);
  }
  return seed;
}

// --- addRace ---------------------------------------------------------------

test('addRace: records the race, stamps it, and persists it', () => {
  const app = makeDataContext({
    elementSeed: formSeed({ positions: { player1: 1, player2: 2, player3: 3 } }),
  });
  app.ctx.addRace();

  const races = app.races();
  assert.equal(races.length, 1);
  assert.equal(races[0].date, '2026-03-01');
  assert.equal(races[0].player1, 1);
  assert.equal(races[0].player2, 2);
  assert.equal(races[0].player3, 3);
  assert.equal(races[0].player4, null, 'an unplayed slot is stored as null, not omitted');
  // Timestamp is "<local HH:MM:SS> <tz abbreviation>", built from "now".
  assert.equal(races[0].timestamp, '14:05:09 UTC');

  assert.deepEqual(app.stored(), races, 'localStorage mirrors the in-memory log');
  assert.equal(app.errors().length, 0);
  assert.equal(app.elements.player1.value, '', 'inputs are cleared after a successful add');
  assert.equal(app.elements.player2.value, '');
});

test('addRace: refuses to record without a date', () => {
  const app = makeDataContext({
    elementSeed: formSeed({ date: '', positions: { player1: 1, player2: 2 } }),
  });
  app.ctx.addRace();

  assert.equal(app.races().length, 0);
  assert.equal(app.stored(), null, 'nothing is persisted on a validation failure');
  assert.match(app.errors()[0].msg, /select a date/i);
});

test('addRace: needs two positions when more than one player is set up', () => {
  const app = makeDataContext({
    playerCount: 3,
    elementSeed: formSeed({ positions: { player1: 1 } }),
  });
  app.ctx.addRace();

  assert.equal(app.races().length, 0);
  assert.equal(app.stored(), null);
  assert.match(app.errors()[0].msg, /At least 2 players must have positions/);
});

test('addRace: single-player mode accepts a lone position', () => {
  const app = makeDataContext({
    playerCount: 1,
    elementSeed: formSeed({ positions: { player1: 4 } }),
  });
  app.ctx.addRace();

  assert.equal(app.errors().length, 0);
  const races = app.races();
  assert.equal(races.length, 1);
  assert.equal(races[0].player1, 4);
  assert.equal(races[0].player2, null);
});

test('addRace: rejects positions outside MIN_POSITIONS..MAX_POSITIONS', () => {
  const tooHigh = makeDataContext({
    maxPositions: 12,
    elementSeed: formSeed({ positions: { player1: 1, player2: 13 } }),
  });
  tooHigh.ctx.addRace();
  assert.equal(tooHigh.races().length, 0);
  assert.match(tooHigh.errors()[0].msg, /between 1 and 12/);

  const tooLow = makeDataContext({
    maxPositions: 12,
    elementSeed: formSeed({ positions: { player1: 0, player2: 2 } }),
  });
  tooLow.ctx.addRace();
  assert.equal(tooLow.races().length, 0);
  assert.match(tooLow.errors()[0].msg, /between 1 and 12/);

  // The game-version bump to 24 positions widens the same check.
  const world = makeDataContext({
    maxPositions: 24,
    elementSeed: formSeed({ positions: { player1: 1, player2: 13 } }),
  });
  world.ctx.addRace();
  assert.equal(world.errors().length, 0);
  assert.equal(world.races()[0].player2, 13);
});

test('addRace: rejects two players sharing a position', () => {
  const app = makeDataContext({
    elementSeed: formSeed({ positions: { player1: 2, player2: 2, player3: 5 } }),
  });
  app.ctx.addRace();

  assert.equal(app.races().length, 0);
  assert.equal(app.stored(), null);
  assert.match(app.errors()[0].msg, /same position/);
});

test('addRace: tags the race with the picked course, then commits and clears the picker', () => {
  const app = makeDataContext({
    elementSeed: formSeed({ positions: { player1: 1, player2: 2 } }),
    course: { id: 'rainbow-road-world', name: 'Rainbow Road' },
  });
  app.ctx.addRace();

  const race = app.races()[0];
  assert.equal(race.courseId, 'rainbow-road-world');
  assert.equal(race.course, 'Rainbow Road');
  // Committing pushes the course into "recents"; clearing resets the picker
  // for the next race. Both must happen, and only after validation passed.
  assert.deepEqual(app.pickerCalls, ['commit', 'clear']);
});

test('addRace: a race with no course carries no course fields at all', () => {
  const app = makeDataContext({
    elementSeed: formSeed({ positions: { player1: 1, player2: 2 } }),
  });
  app.ctx.addRace();

  const race = app.races()[0];
  assert.equal('course' in race, false);
  assert.equal('courseId' in race, false);
});

test('addRace: a rejected race never reaches the course picker', () => {
  const app = makeDataContext({
    elementSeed: formSeed({ positions: { player1: 2, player2: 2 } }),
    course: { id: 'rainbow-road-world', name: 'Rainbow Road' },
  });
  app.ctx.addRace();

  assert.equal(app.races().length, 0);
  assert.deepEqual(app.pickerCalls, [], 'no recent-course entry for a race that was not saved');
});

test('addRace: writes to the version-scoped storage key', () => {
  const app = makeDataContext({
    storagePrefix: 'marioKartWorld',
    elementSeed: formSeed({ positions: { player1: 1, player2: 2 } }),
  });
  app.ctx.addRace();

  assert.equal(app.stored('marioKartRaces'), null, 'the MK8D key must stay untouched');
  assert.equal(app.stored('marioKartWorldRaces').length, 1);
});

test('addRace: appends to an existing log and stays undoable', () => {
  const app = makeDataContext({
    seedRaces: [{ date: '2026-02-01', timestamp: '09:00:00 UTC', player1: 1, player2: 2, player3: null, player4: null }],
    elementSeed: formSeed({ positions: { player1: 2, player2: 1 } }),
  });
  app.ctx.addRace();
  assert.equal(app.races().length, 2);

  app.ctx.undoLastAction();
  const afterUndo = app.races();
  assert.equal(afterUndo.length, 1, 'ADD_RACE undo pops the race just added');
  assert.equal(afterUndo[0].date, '2026-02-01');
  assert.deepEqual(app.stored(), afterUndo, 'the undo is persisted too');
});

test('addRace: a race logged just after midnight gets a 24:MM:SS timestamp', { todo: 'KNOWN DEFECT: hour12:false + hour "2-digit" formats midnight on the h24 clock, so 00:30 is stamped "24:30:09" - an unparseable time that also breaks the chronological sorts and the edit dialog time input' }, () => {
  const app = makeDataContext({
    now: '2026-03-01T00:30:09Z',
    elementSeed: formSeed({ positions: { player1: 1, player2: 2 } }),
  });
  app.ctx.addRace();

  const race = app.races()[0];
  assert.match(race.timestamp, /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d /, `midnight hour should be 00, got ${race.timestamp}`);
  assert.ok(
    !Number.isNaN(new Date(`${race.date} ${race.timestamp}`).getTime()),
    `"${race.date} ${race.timestamp}" should parse as a date`,
  );
});

// --- editRace --------------------------------------------------------------

// editRace renders a modal and hangs the real work off #save-edit's onclick.
// The helper seeds the edit inputs with exactly the values the dialog renders
// into its markup, applies the caller's edits, then fires Save.
function editRace({ race, edits = {}, playerCount = 3, maxPositions = 12, now = '2026-03-01T14:05:09Z' }) {
  const players = ALL_PLAYERS.slice(0, playerCount);
  const seed = {
    'edit-date': race.date,
    'edit-time': race.timestamp && race.timestamp.includes(':') ? race.timestamp.split(' ')[0] : '',
  };
  for (const player of players) {
    seed[`edit-${player}`] = race[player] === null || race[player] === undefined ? '' : String(race[player]);
  }
  for (const [key, value] of Object.entries(edits)) {
    seed[`edit-${key}`] = value;
  }

  const app = makeDataContext({ playerCount, maxPositions, now, seedRaces: [race], elementSeed: seed });
  app.ctx.editRace(0);
  app.elements['save-edit'].onclick();
  return app;
}

const BASE_RACE = {
  date: '2026-03-01',
  timestamp: '10:00:00 EDT',
  player1: 1,
  player2: 2,
  player3: 3,
  player4: null,
};

test('editRace: saves new positions and keeps the timestamp when the time is untouched', () => {
  const app = editRace({ race: BASE_RACE, edits: { player1: '3', player3: '1' } });

  const race = app.races()[0];
  assert.equal(race.player1, 3);
  assert.equal(race.player2, 2);
  assert.equal(race.player3, 1);
  assert.equal(race.timestamp, '10:00:00 EDT', 'an unchanged time leaves the original stamp alone');
  assert.deepEqual(app.stored(), app.races());
  assert.equal(app.errors().length, 0);
});

test('editRace: revalidates the position range', () => {
  const app = editRace({ race: BASE_RACE, edits: { player1: '13' } });

  assert.match(app.errors()[0].msg, /between 1 and 12/);
  assert.equal(app.races()[0].player1, 1, 'the race is left as it was');
  assert.equal(app.stored(), null, 'a rejected edit is not persisted');
});

test('editRace: revalidates duplicate positions', () => {
  const app = editRace({ race: BASE_RACE, edits: { player1: '2' } });

  assert.match(app.errors()[0].msg, /same position/);
  assert.equal(app.races()[0].player1, 1);
  assert.equal(app.stored(), null);
});

test('editRace: revalidates the minimum player count', () => {
  const app = editRace({ race: BASE_RACE, edits: { player2: '', player3: '' } });

  assert.match(app.errors()[0].msg, /At least 2 players must have positions/);
  assert.equal(app.races()[0].player2, 2);
  assert.equal(app.stored(), null);
});

test('editRace: revalidates the date', () => {
  const app = editRace({ race: BASE_RACE, edits: { date: '' } });

  assert.match(app.errors()[0].msg, /select a date/i);
  assert.equal(app.races()[0].date, '2026-03-01');
  assert.equal(app.stored(), null);
});

test('editRace: a changed time reuses the original timezone suffix', () => {
  const app = editRace({ race: BASE_RACE, edits: { time: '11:30:00' } });

  assert.equal(app.races()[0].timestamp, '11:30:00 EDT');
});

test('editRace: clearing the time drops the timestamp entirely', () => {
  const app = editRace({ race: BASE_RACE, edits: { time: '' } });

  const race = app.races()[0];
  assert.equal('timestamp' in race, false, 'the key is deleted, not set to null');
  assert.equal(app.errors().length, 0);
});

test('editRace: a race with no timestamp gets one stamped in the current zone', () => {
  const untimed = { date: '2026-03-01', player1: 1, player2: 2, player3: 3, player4: null };
  const app = editRace({ race: untimed, edits: { time: '09:15:00' } });

  assert.equal(app.races()[0].timestamp, '09:15:00 UTC');
});

test('editRace: changing only the date keeps positions and timestamp', () => {
  const app = editRace({ race: BASE_RACE, edits: { date: '2026-03-05' } });

  const race = app.races()[0];
  assert.equal(race.date, '2026-03-05');
  assert.equal(race.timestamp, '10:00:00 EDT');
  assert.equal(race.player1, 1);
});

test('editRace: preserves fields the dialog does not manage (course tagging)', () => {
  const tagged = { ...BASE_RACE, course: 'Rainbow Road', courseId: 'rainbow-road-world' };
  const app = editRace({ race: tagged, edits: { player1: '3', player3: '1' } });

  const race = app.races()[0];
  assert.equal(race.course, 'Rainbow Road');
  assert.equal(race.courseId, 'rainbow-road-world');
});

test('editRace: records an undoable EDIT_RACE action', () => {
  const app = editRace({ race: BASE_RACE, edits: { player1: '3', player3: '1' } });
  assert.equal(app.races()[0].player1, 3);

  app.ctx.undoLastAction();
  const restored = app.races()[0];
  assert.equal(restored.player1, 1, 'undo puts the original positions back');
  assert.equal(restored.player3, 3);
  assert.equal(restored.timestamp, '10:00:00 EDT');
  assert.deepEqual(app.stored(), app.races());

  app.ctx.redoLastAction();
  assert.equal(app.races()[0].player1, 3, 'redo re-applies the edit');
});

// --- migrateRaceData -------------------------------------------------------

test('migrateRaceData: new-format races pass through untouched and nothing is written', () => {
  const app = makeDataContext();
  const input = [{ date: '2026-03-01', timestamp: '10:00:00 UTC', player1: 1, player2: 2, player3: null, player4: null }];
  const migrated = app.ctx.migrateRaceData(input);

  assert.equal(JSON.stringify(migrated), JSON.stringify(input));
  assert.equal(app.stored(), null, 'no migration means no localStorage write');
});

test('migrateRaceData: maps the legacy slav/mike/nikita keys onto slots and persists', () => {
  const app = makeDataContext();
  const migrated = app.ctx.migrateRaceData([
    { date: '2026-03-01', timestamp: '10:00:00 EDT', slav: 1, mike: 2, nikita: 3 },
  ]);

  assert.equal(migrated[0].player1, 1);
  assert.equal(migrated[0].player2, 2);
  assert.equal(migrated[0].player3, 3);
  assert.equal(migrated[0].player4, null);
  assert.equal('slav' in migrated[0], false, 'legacy keys are gone');
  assert.deepEqual(app.stored(), JSON.parse(JSON.stringify(migrated)), 'the migrated log is written back');
});

test('migrateRaceData: a partially legacy log migrates only the legacy rows', () => {
  const app = makeDataContext();
  const migrated = app.ctx.migrateRaceData([
    { date: '2026-03-01', timestamp: '10:00:00 EDT', slav: 1, mike: 2 },
    { date: '2026-03-02', timestamp: '11:00:00 EDT', player1: 2, player2: 1, player3: null, player4: null },
  ]);

  assert.equal(migrated[0].player1, 1);
  assert.equal(migrated[0].player3, null, 'an absent legacy key becomes null');
  assert.equal(migrated[1].player1, 2);
});

test('migrateRaceData: keeps course tagging on a migrated race', { todo: 'KNOWN DEFECT: the migration rebuilds the race from date/timestamp/player1-4 only, so course, courseId and any other field on a legacy-keyed race are silently dropped on load and on import' }, () => {
  const app = makeDataContext();
  const migrated = app.ctx.migrateRaceData([
    {
      date: '2026-03-01',
      timestamp: '10:00:00 EDT',
      slav: 1,
      mike: 2,
      nikita: 3,
      course: 'Rainbow Road',
      courseId: 'rainbow-road-world',
    },
  ]);

  assert.equal(migrated[0].course, 'Rainbow Road');
  assert.equal(migrated[0].courseId, 'rainbow-road-world');
});
