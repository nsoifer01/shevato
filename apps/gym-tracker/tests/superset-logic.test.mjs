// The shouldStartRestForSet rule is small and pure-ish; reproduce it
// here so we can assert behavior without spinning up the full view.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of WorkoutView.shouldStartRestForSet — kept in sync by hand
// since the real method is on a class that depends on the DOM. If the
// rule changes in the view, update this file too.
function shouldStartRestForSet(exercises, exerciseIndex) {
    const exercise = exercises[exerciseIndex];
    if (!exercise.groupId) return true;
    const me = exercise.sets.length;
    for (let i = 0; i < exercises.length; i++) {
        if (i === exerciseIndex) continue;
        const other = exercises[i];
        if (!other || other.groupId !== exercise.groupId) continue;
        if ((other.sets?.length || 0) < me) return false;
    }
    return true;
}

const ex = (groupId, setsCount) => ({ groupId, sets: Array(setsCount).fill({}) });

test('shouldStartRestForSet: solo exercise always fires rest', () => {
    const list = [ex(null, 1), ex(null, 0)];
    assert.equal(shouldStartRestForSet(list, 0), true);
});

test('shouldStartRestForSet: superset, partner has fewer sets → suppress rest', () => {
    // I just committed set 1 on exercise A; B in the same group is empty.
    const list = [ex('g1', 1), ex('g1', 0)];
    assert.equal(shouldStartRestForSet(list, 0), false);
});

test('shouldStartRestForSet: superset, partner has equal sets → fire rest (round done)', () => {
    const list = [ex('g1', 2), ex('g1', 2)];
    assert.equal(shouldStartRestForSet(list, 0), true);
});

test('shouldStartRestForSet: superset, partner has more sets → fire rest (caught up)', () => {
    const list = [ex('g1', 1), ex('g1', 2)];
    assert.equal(shouldStartRestForSet(list, 0), true);
});

test('shouldStartRestForSet: ignores exercises in other groups', () => {
    // I just hit set 2 on group g1 and the lone exercise is solo, so
    // only my partner counts.
    const list = [ex('g1', 2), ex('g1', 2), ex(null, 0)];
    assert.equal(shouldStartRestForSet(list, 0), true);
});

test('shouldStartRestForSet: 3-exercise superset waits for the slowest partner', () => {
    const list = [ex('g1', 2), ex('g1', 2), ex('g1', 1)];
    assert.equal(shouldStartRestForSet(list, 0), false);
});
