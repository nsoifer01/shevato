// Duplicating a program (GT-38).
//
// Copying "Push Day A" (scheduled Mon, Thu) produced "Push Day A (Copy)" also
// scheduled Mon and Thu. Both then marked the same calendar days and both
// presented themselves as "today's scheduled workout" - a schedule conflict
// the user never asked for. A duplicate copies STRUCTURE; the calendar is a
// separate decision.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';
import { Program } from '../js/models/Program.js';
import { programsScheduledOnWeekday } from '../js/utils/program-schedule.js';

const src = loadSource('js/views/programs-view.js');

const pushDayA = () => Program.fromJSON({
    id: 1,
    name: 'Push Day A',
    description: 'Chest, shoulders, triceps',
    scheduleDays: [1, 4], // Mon, Thu
    restMode: 'uniform',
    uniformRestSeconds: 120,
    exercises: [{
        exerciseId: 3,
        exerciseName: 'Barbell Bench Press',
        sets: [{ repsMin: 8, repsMax: 10 }, { repsMin: 6, repsMax: 8 }],
        restSeconds: 180,
        restAfterSeconds: 180,
        order: 0,
    }],
});

/**
 * Run the REAL duplicateProgram against a stub app and return what landed.
 * `showToast` is a module import, so it is supplied as a dependency rather
 * than reached for through globals.
 */
function duplicateWith(source) {
    const toasts = [];
    const methods = buildMethods(
        src,
        ['duplicateProgram'],
        { Program, showToast: (msg, type) => toasts.push({ msg, type }) },
        'programs-view.js',
    );
    const view = Object.create(methods);
    const programs = [source];
    view.app = {
        programs,
        getProgramById: (id) => programs.find(p => String(p.id) === String(id)),
        savePrograms: () => {},
    };
    view.render = () => {};
    view.duplicateProgram(source.id);
    return { copy: programs[1], programs, toasts };
}

test('the copy starts with NO scheduled days', () => {
    const { copy } = duplicateWith(pushDayA());
    assert.deepEqual(copy.scheduleDays, [],
        'two programs must not silently claim the same weekday');
});

test('the original keeps its schedule', () => {
    const { programs } = duplicateWith(pushDayA());
    assert.deepEqual(programs[0].scheduleDays, [1, 4]);
});

test('no weekday ends up with two programs on it', () => {
    const { programs } = duplicateWith(pushDayA());
    for (let weekday = 0; weekday < 7; weekday++) {
        assert.ok(programsScheduledOnWeekday(programs, weekday).length <= 1,
            `weekday ${weekday} is claimed twice`);
    }
});

test('everything that IS structure is copied', () => {
    const { copy } = duplicateWith(pushDayA());
    assert.equal(copy.name, 'Push Day A (Copy)');
    assert.equal(copy.description, 'Chest, shoulders, triceps');
    assert.equal(copy.restMode, 'uniform');
    assert.equal(copy.uniformRestSeconds, 120);
    assert.equal(copy.exercises.length, 1);
    assert.equal(copy.exercises[0].exerciseId, 3);
    assert.deepEqual(copy.exercises[0].sets.map(s => [s.repsMin, s.repsMax]), [[8, 10], [6, 8]]);
    assert.equal(copy.exercises[0].restSeconds, 180);
});

test('the copy gets its own id', () => {
    const { copy, programs } = duplicateWith(pushDayA());
    assert.notEqual(copy.id, programs[0].id);
});

test('the copy\'s set rows are independent objects', () => {
    const { copy, programs } = duplicateWith(pushDayA());
    copy.exercises[0].sets[0].repsMin = 1;
    assert.equal(programs[0].exercises[0].sets[0].repsMin, 8, 'editing the copy must not touch the original');
});

test('the user is told the copy needs its own days, but only when that applies', () => {
    const scheduled = duplicateWith(pushDayA());
    assert.match(scheduled.toasts[0].msg, /set its days/i);

    const unscheduled = duplicateWith(Program.fromJSON({
        id: 2, name: 'Ad hoc', scheduleDays: [], exercises: [],
    }));
    assert.doesNotMatch(unscheduled.toasts[0].msg, /set its days/i,
        'nothing to say when there was no schedule to drop');
});
