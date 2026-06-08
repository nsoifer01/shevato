// Tests for Item 9: program day-of-week schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Program } from '../js/models/Program.js';
import { Settings } from '../js/models/Settings.js';
import { programsScheduledOnWeekday, weekdayOrder, weekStrip } from '../js/utils/program-schedule.js';

// -------------------------------------------------------
// Program.scheduleDays model
// -------------------------------------------------------

test('Program: scheduleDays defaults to [] for legacy data', () => {
    const p = new Program({ name: 'Legacy' });
    assert.deepEqual(p.scheduleDays, []);
});

test('Program: scheduleDays round-trips and is deduped/sorted', () => {
    const p = new Program({ name: 'Split', scheduleDays: [4, 1, 1, 4] });
    assert.deepEqual(p.scheduleDays, [1, 4]);
    const back = Program.fromJSON(p.toJSON());
    assert.deepEqual(back.scheduleDays, [1, 4]);
});

test('Program: invalid scheduleDays entries are dropped', () => {
    const p = new Program({ name: 'Bad', scheduleDays: [0, 7, -1, 'x', 6] });
    assert.deepEqual(p.scheduleDays, [0, 6]);
});

test('Program: non-array scheduleDays becomes []', () => {
    const p = new Program({ name: 'X', scheduleDays: 'mon' });
    assert.deepEqual(p.scheduleDays, []);
});

// -------------------------------------------------------
// Settings.showProgramSchedule
// -------------------------------------------------------

test('Settings: showProgramSchedule defaults to true', () => {
    assert.equal(Settings.getDefault().showProgramSchedule, true);
});

test('Settings: showProgramSchedule false round-trips', () => {
    const s = new Settings({ showProgramSchedule: false });
    assert.equal(s.showProgramSchedule, false);
    assert.equal(Settings.fromJSON(s.toJSON()).showProgramSchedule, false);
});

test('Settings: legacy data without the key defaults on', () => {
    const s = Settings.fromJSON({ weightUnit: 'kg' });
    assert.equal(s.showProgramSchedule, true);
});

// -------------------------------------------------------
// programsScheduledOnWeekday
// -------------------------------------------------------

test('programsScheduledOnWeekday: matches programs on the weekday', () => {
    const programs = [
        { name: 'Push', scheduleDays: [1, 4] },
        { name: 'Legs', scheduleDays: [2, 5] },
        { name: 'Unscheduled', scheduleDays: [] },
    ];
    assert.deepEqual(programsScheduledOnWeekday(programs, 1).map(p => p.name), ['Push']);
    assert.deepEqual(programsScheduledOnWeekday(programs, 2).map(p => p.name), ['Legs']);
    assert.deepEqual(programsScheduledOnWeekday(programs, 3).map(p => p.name), []);
});

test('programsScheduledOnWeekday: programs without scheduleDays never match', () => {
    const programs = [{ name: 'X' }];
    assert.deepEqual(programsScheduledOnWeekday(programs, 0), []);
});

// -------------------------------------------------------
// weekdayOrder
// -------------------------------------------------------

test('weekdayOrder: Monday-first', () => {
    assert.deepEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0]);
});

test('weekdayOrder: Sunday-first', () => {
    assert.deepEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6]);
});

// -------------------------------------------------------
// Item R2-5: Settings.firstDayOfWeek user-facing setting
// -------------------------------------------------------

test('R2-5: firstDayOfWeek defaults to 0 (Sunday)', () => {
    assert.equal(Settings.getDefault().firstDayOfWeek, 0);
});

test('R2-5: firstDayOfWeek = 1 (Monday) round-trips', () => {
    const s = new Settings({ firstDayOfWeek: 1 });
    assert.equal(s.firstDayOfWeek, 1);
    assert.equal(Settings.fromJSON(s.toJSON()).firstDayOfWeek, 1);
});

test('R2-5: legacy data without firstDayOfWeek defaults to Sunday', () => {
    assert.equal(Settings.fromJSON({ weightUnit: 'kg' }).firstDayOfWeek, 0);
});

// Calendar grid leading-blank offset is a pure formula shared by both column
// orders: how far the month's first weekday sits from the configured first
// column. Encodes WHY: blanks before day 1 must align day 1 under its header.
test('R2-5: calendar leading-blank offset honors firstDayOfWeek', () => {
    const offset = (firstDayOfMonth, firstDay) => (firstDayOfMonth - firstDay + 7) % 7;
    // Month starting on a Wednesday (3).
    assert.equal(offset(3, 0), 3); // Sunday-first: Sun,Mon,Tue blank -> 3
    assert.equal(offset(3, 1), 2); // Monday-first: Mon,Tue blank -> 2
    // Month starting on a Sunday (0).
    assert.equal(offset(0, 0), 0); // Sunday-first: no blanks
    assert.equal(offset(0, 1), 6); // Monday-first: six blanks before Sunday
});

// -------------------------------------------------------
// Item R2-6: weekStrip for the workout selection screen
// -------------------------------------------------------

test('R2-6: weekStrip returns 7 cells ordered per firstDayOfWeek', () => {
    const programs = [{ name: 'Push', scheduleDays: [1, 4] }];
    const sun = weekStrip(programs, 0, new Date(2026, 5, 7)); // a Sunday
    assert.deepEqual(sun.map(c => c.weekday), [0, 1, 2, 3, 4, 5, 6]);
    const mon = weekStrip(programs, 1, new Date(2026, 5, 7));
    assert.deepEqual(mon.map(c => c.weekday), [1, 2, 3, 4, 5, 6, 0]);
});

test('R2-6: weekStrip flags today and attaches scheduled programs per weekday', () => {
    const programs = [
        { id: 'a', name: 'Push', scheduleDays: [1, 4] },
        { id: 'b', name: 'Legs', scheduleDays: [3] },
    ];
    // 2026-06-08 is a Monday (weekday 1).
    const strip = weekStrip(programs, 0, new Date(2026, 5, 8));
    const monday = strip.find(c => c.weekday === 1);
    assert.equal(monday.isToday, true);
    assert.deepEqual(monday.programs.map(p => p.name), ['Push']);
    const wednesday = strip.find(c => c.weekday === 3);
    assert.equal(wednesday.isToday, false);
    assert.deepEqual(wednesday.programs.map(p => p.name), ['Legs']);
    const tuesday = strip.find(c => c.weekday === 2);
    assert.deepEqual(tuesday.programs, []);
});

test('R2-6: weekStrip with no scheduled programs yields empty program lists', () => {
    const strip = weekStrip([{ name: 'X', scheduleDays: [] }], 0, new Date(2026, 5, 7));
    assert.equal(strip.length, 7);
    assert.ok(strip.every(c => c.programs.length === 0));
});
