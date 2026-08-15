'use strict';

// Pin timezone so millisecond expectations stay deterministic.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto } = require('./harness');

function loadUtils() {
  const ctx = makeContext();
  loadInto(ctx, 'utils.js');
  return ctx;
}

const u = loadUtils();

// --- isFinitePosition --------------------------------------------------------

test('isFinitePosition: accepts only real finite numbers', () => {
  assert.equal(u.isFinitePosition(1), true);
  assert.equal(u.isFinitePosition(24), true);
  assert.equal(u.isFinitePosition(null), false, 'explicit "sat out" marker');
  assert.equal(u.isFinitePosition(undefined), false, 'absent key after roster widening');
  assert.equal(u.isFinitePosition(NaN), false);
  assert.equal(u.isFinitePosition(Infinity), false);
  assert.equal(u.isFinitePosition('3'), false, 'stringly-typed positions never sneak into stats');
  assert.equal(u.isFinitePosition({}), false);
});

// --- raceDateTimeValue: every timestamp shape the app has ever written -------

const MID_MARCH_1 = new Date(2026, 2, 1, 0, 0, 0).getTime();

test('raceDateTimeValue: current "HH:MM:SS TZ" shape', () => {
  assert.equal(
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '10:30:09 EDT' }),
    new Date(2026, 2, 1, 10, 30, 9).getTime(),
  );
});

test('raceDateTimeValue: non-US timezone abbreviations parse too', () => {
  // The old inline `new Date(date + ' ' + timestamp)` pattern went Invalid
  // Date on abbreviations V8 does not know (IDT, CEST, ...). The parser
  // reads the wall clock and ignores the zone entirely.
  assert.equal(
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '10:30:09 IDT' }),
    new Date(2026, 2, 1, 10, 30, 9).getTime(),
  );
});

test('raceDateTimeValue: legacy "24:MM:SS" midnight stamps map to hour 00', () => {
  assert.equal(
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '24:30:00 EDT' }),
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '00:30:00 EDT' }),
  );
  assert.equal(
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '24:30:00 EDT' }),
    new Date(2026, 2, 1, 0, 30, 0).getTime(),
  );
});

test('raceDateTimeValue: bare "HH:MM:SS" and "HH:MM" (edit-dialog values)', () => {
  assert.equal(
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '09:15:30' }),
    new Date(2026, 2, 1, 9, 15, 30).getTime(),
  );
  assert.equal(
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '09:15' }),
    new Date(2026, 2, 1, 9, 15, 0).getTime(),
  );
});

test('raceDateTimeValue: absent, null, or unparseable timestamp falls back to the date', () => {
  assert.equal(u.raceDateTimeValue({ date: '2026-03-01' }), MID_MARCH_1);
  assert.equal(u.raceDateTimeValue({ date: '2026-03-01', timestamp: null }), MID_MARCH_1);
  assert.equal(u.raceDateTimeValue({ date: '2026-03-01', timestamp: 'soon' }), MID_MARCH_1);
  assert.equal(
    u.raceDateTimeValue({ date: '2026-03-01', timestamp: '99:99:99' }),
    MID_MARCH_1,
    'out-of-range digits are ignored rather than trusted',
  );
});

test('raceDateTimeValue: never returns NaN', () => {
  const shapes = [
    null,
    {},
    { date: null },
    { date: 42 },
    { date: 'banana' },
    { date: '2026-03-01', timestamp: '24:30:00 EDT' },
    { date: 'March 1, 2026', timestamp: '10:00:00' },
  ];
  for (const race of shapes) {
    const value = u.raceDateTimeValue(race);
    assert.ok(Number.isFinite(value), `finite for ${JSON.stringify(race)}, got ${value}`);
  }
});

test('raceDateTimeValue: a non-ISO but parseable date still orders after the fallback', () => {
  // Not a shape the app writes, but sync/import could deliver one; it must
  // land somewhere sane instead of poisoning the sort.
  assert.ok(u.raceDateTimeValue({ date: '2026-03-01T10:00:00Z' }) > 0);
  assert.equal(u.raceDateTimeValue({ date: 'banana' }), 0, 'unparseable dates pin to 0, deterministically first');
});

// --- compareRacesChronologically ---------------------------------------------

test('compareRacesChronologically: orders across dates, then by time within a day', () => {
  const races = [
    { date: '2026-03-02', timestamp: '09:00:00 EDT', id: 'c' },
    { date: '2026-03-01', timestamp: '23:59:59 EDT', id: 'b' },
    { date: '2026-03-01', timestamp: '24:15:00 EDT', id: 'a' }, // legacy 00:15
    { date: '2026-03-03', id: 'd' },
  ];
  const order = [...races].sort(u.compareRacesChronologically).map(r => r.id).join(',');
  assert.equal(order, 'a,b,c,d');
});

test('compareRacesChronologically: identical stamps compare equal (stable sort keeps insertion order)', () => {
  const first = { date: '2026-03-01', timestamp: '10:00:00 EDT', id: 1 };
  const second = { date: '2026-03-01', timestamp: '10:00:00 EDT', id: 2 };
  assert.equal(u.compareRacesChronologically(first, second), 0);
  const order = [second, first].sort(u.compareRacesChronologically).map(r => r.id).join(',');
  assert.equal(order, '2,1');
});
