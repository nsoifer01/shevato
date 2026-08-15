// WorkoutView.shouldStartRestForSet: the superset rest rule.
//
// Why it matters: inside a superset, resting after every individual set
// defeats the point of supersetting - rest may only fire when the whole
// ROUND is done (every exercise in the group has at least as many committed
// sets as the one just logged). Solo exercises always rest.
//
// The method is lifted from the real workout-view.js source text (the class
// is DOM-bound and cannot be imported under node), so a change to the rule
// in the view fails here instead of drifting past a hand-copied mirror.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, buildMethods } from './helpers/source-extract.mjs';

const src = loadSource('js/views/workout-view.js');
const methods = buildMethods(src, ['shouldStartRestForSet'], {}, 'workout-view.js');

function makeView(exercises) {
    const view = Object.create(methods);
    view.currentWorkoutSession = { exercises };
    return view;
}

const ex = (groupId, setsCount) => ({ groupId, sets: Array(setsCount).fill({}) });

test('shouldStartRestForSet: solo exercise always fires rest', () => {
    const list = [ex(null, 1), ex(null, 0)];
    assert.equal(makeView(list).shouldStartRestForSet(0, list[0]), true);
});

test('shouldStartRestForSet: superset, partner has fewer sets suppresses rest', () => {
    // I just committed set 1 on exercise A; B in the same group is empty.
    const list = [ex('g1', 1), ex('g1', 0)];
    assert.equal(makeView(list).shouldStartRestForSet(0, list[0]), false);
});

test('shouldStartRestForSet: superset, partner has equal sets fires rest (round done)', () => {
    const list = [ex('g1', 2), ex('g1', 2)];
    assert.equal(makeView(list).shouldStartRestForSet(0, list[0]), true);
});

test('shouldStartRestForSet: superset, partner has more sets fires rest (caught up)', () => {
    const list = [ex('g1', 1), ex('g1', 2)];
    assert.equal(makeView(list).shouldStartRestForSet(0, list[0]), true);
});

test('shouldStartRestForSet: ignores exercises in other groups', () => {
    // Only my superset partners count; the empty solo exercise is irrelevant.
    const list = [ex('g1', 2), ex('g1', 2), ex(null, 0)];
    assert.equal(makeView(list).shouldStartRestForSet(0, list[0]), true);
});

test('shouldStartRestForSet: 3-exercise superset waits for the slowest partner', () => {
    const list = [ex('g1', 2), ex('g1', 2), ex('g1', 1)];
    assert.equal(makeView(list).shouldStartRestForSet(0, list[0]), false);
});

test('shouldStartRestForSet: missing session falls back safely for grouped exercises', () => {
    // The real method reads this.currentWorkoutSession?.exercises || [];
    // with no session a grouped exercise sees no partners and rests.
    const view = Object.create(methods);
    view.currentWorkoutSession = null;
    assert.equal(view.shouldStartRestForSet(0, ex('g1', 1)), true);
});
