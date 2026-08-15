// renderActiveWorkout's uniform-rest header behavior.
//
// Why it matters: for uniform-rest programs, the between-exercise rest shows
// once in the sticky workout header (visible while scrolling) instead of as a
// repeated banner in the exercise stream. Custom-rest programs have no single
// value to show, so the header slot must be hidden AND emptied, or a stale
// value from a previous uniform workout would linger.
//
// The real renderActiveWorkout and formatRest are lifted from workout-view.js
// source text and run against a stub document (the class is DOM-bound), so a
// change to the header rule or the M:SS formatting fails here.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, buildMethods } from './helpers/source-extract.mjs';

const src = loadSource('js/views/workout-view.js');

function makeHarness({ program } = {}) {
    const els = {
        'workout-title': { textContent: '' },
        'workout-exercises-list': { innerHTML: '' },
        'workout-rest-between': { hidden: true },
        'workout-rest-between-value': { textContent: '' },
    };
    const document = { getElementById: (id) => els[id] || null };
    const methods = buildMethods(src, ['renderActiveWorkout', 'formatRest'], { document }, 'workout-view.js');
    const view = Object.create(methods);
    view.currentWorkoutSession = { programId: 7, workoutDayName: 'Push Day', exercises: [{}, {}] };
    view.app = { getProgramById: (id) => (id === 7 ? program ?? null : null) };
    // Out-of-scope collaborators renderActiveWorkout calls along the way.
    view.adjustWorkoutTitleSize = () => {};
    view.syncPlateHintsButton = () => {};
    view.syncSessionUnitToggle = () => {};
    view.dedupePlateHints = () => {};
    view.renderExerciseList = () => '<div class="exercise-entry">Bench Press</div>';
    return { view, els };
}

test('uniform mode: header slot is unhidden with the M:SS value (90s => 1:30)', () => {
    const { view, els } = makeHarness({ program: { restMode: 'uniform', uniformRestSeconds: 90 } });
    view.renderActiveWorkout();
    assert.equal(els['workout-rest-between'].hidden, false, 'header element visible');
    assert.equal(els['workout-rest-between-value'].textContent, '1:30');
});

test('uniform mode: 60s renders as 1:00', () => {
    const { view, els } = makeHarness({ program: { restMode: 'uniform', uniformRestSeconds: 60 } });
    view.renderActiveWorkout();
    assert.equal(els['workout-rest-between-value'].textContent, '1:00');
});

test('uniform mode: uniformRestSeconds defaults to 90 when absent', () => {
    const { view, els } = makeHarness({ program: { restMode: 'uniform' } });
    view.renderActiveWorkout();
    assert.equal(els['workout-rest-between'].hidden, false);
    assert.equal(els['workout-rest-between-value'].textContent, '1:30');
});

test('custom mode: header slot is hidden and its value cleared', () => {
    const { view, els } = makeHarness({ program: { restMode: 'custom' } });
    els['workout-rest-between'].hidden = false;
    els['workout-rest-between-value'].textContent = '1:30'; // stale from a uniform run
    view.renderActiveWorkout();
    assert.equal(els['workout-rest-between'].hidden, true, 'hidden in custom mode');
    assert.equal(els['workout-rest-between-value'].textContent, '', 'stale value cleared');
});

test('program not found: header slot is hidden (graceful fallback)', () => {
    const { view, els } = makeHarness({ program: null });
    els['workout-rest-between'].hidden = false;
    view.renderActiveWorkout();
    assert.equal(els['workout-rest-between'].hidden, true);
    assert.equal(els['workout-rest-between-value'].textContent, '');
});

test('no uniform-rest banner is injected into the exercise stream in either mode', () => {
    // The header replaced the old in-stream banner; the exercise container
    // must hold exactly what renderExerciseList produced, nothing prepended.
    for (const program of [{ restMode: 'uniform', uniformRestSeconds: 90 }, { restMode: 'custom' }]) {
        const { view, els } = makeHarness({ program });
        view.renderActiveWorkout();
        assert.equal(els['workout-exercises-list'].innerHTML,
            '<div class="exercise-entry">Bench Press</div>',
            'container content is the exercise list verbatim');
    }
    assert.ok(!src.includes('uniform-rest-banner'),
        'workout-view.js no longer references the old .uniform-rest-banner at all');
});

// ---------------------------------------------------------------------------
// formatRest corner cases (the real method)
// ---------------------------------------------------------------------------

const { view: fmtView } = makeHarness({});

test('formatRest: 0 => 0:00', () => {
    assert.equal(fmtView.formatRest(0), '0:00');
});

test('formatRest: 90 => 1:30', () => {
    assert.equal(fmtView.formatRest(90), '1:30');
});

test('formatRest: 65 => 1:05', () => {
    assert.equal(fmtView.formatRest(65), '1:05');
});

test('formatRest: 3600 => 60:00 (minutes never roll into hours)', () => {
    assert.equal(fmtView.formatRest(3600), '60:00');
});

test('formatRest: negative input clamps to 0:00', () => {
    assert.equal(fmtView.formatRest(-5), '0:00');
});
