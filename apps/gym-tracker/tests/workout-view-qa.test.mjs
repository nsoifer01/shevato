// Live-workout behaviour fixed in the 2026-08-19 QA round.
//
//   GT-06  "Use last weight" reverted only set 1, leaving 60/62.5/62.5/62.5
//   GT-07  the finish dialog carried the previous workout's notes and heart rate
//   GT-12  a timed exercise was planned in reps ("Set 1: 10 reps" for a plank)
//   GT-13  swapping an exercise dropped the rep target from its header
//   GT-18  the PR badge rendered a set-volume delta as "+50 kg"
//   GT-22  the feel prompt blocked the screen after most exercises
//   GT-32  a first-ever session needed the weight typed on every set
//   GT-40  one global bar weight computed an EZ-bar curl against the olympic bar
//
// The methods are lifted from workout-view.js source text (the class is
// DOM-bound and cannot be imported under node) and run against DOM stubs, so
// these move with the real implementation instead of mirroring it.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, extractClassMethod, loadSource } from './helpers/source-extract.mjs';
import { Settings } from '../js/models/Settings.js';
import { DEFAULT_TARGET_SECONDS } from '../js/models/Program.js';
import {
    displayWeight, formatDuration, normalizeWeightUnit, roundForDisplay, volumeIn,
} from '../js/utils/units.js';
import { sameId } from '../js/utils/id-utils.js';

const src = loadSource('js/views/workout-view.js');

// ---------------------------------------------------------------------------
// A DOM stub good enough for the row-level methods
// ---------------------------------------------------------------------------

function makeInput(id, value = '') {
    return {
        id,
        value,
        classes: new Set(['set-weight']),
        classList: { contains(c) { return this._set.has(c); } },
        dataset: {},
        events: [],
        dispatchEvent(e) { this.events.push(e.type ?? 'input'); return true; },
        closest() { return this._row; },
    };
}

/**
 * Build one exercise card's worth of planned rows.
 * `weights` is the value in each row's weight input ('' = empty).
 */
function makeCard(exerciseIndex, weights, { priorWeight } = {}) {
    const rows = weights.map((value, slot) => {
        const weightInput = makeInput(`weight-${exerciseIndex}-${slot}`, String(value));
        weightInput.classList._set = weightInput.classes;
        const row = {
            dataset: { slot: String(slot) },
            classes: new Set(['set-row', 'set-row-planned']),
            querySelector(sel) {
                if (sel === '.set-weight') return weightInput;
                if (sel === '.set-reps') return null;
                if (sel === '.set-row-notes') return null;
                return null;
            },
        };
        if (priorWeight !== undefined) row.dataset.priorWeight = String(priorWeight);
        weightInput._row = row;
        return { row, weightInput, slot };
    });

    const badge = { removed: false, remove() { this.removed = true; } };
    const host = {
        id: `exercise-${exerciseIndex}`,
        querySelectorAll(sel) {
            if (sel === '.set-row-planned') return rows.map(r => r.row);
            return [];
        },
        querySelector(sel) {
            if (sel === '.gt-progress-badge') return badge;
            return null;
        },
    };
    return { rows, host, badge };
}

function makeView(card, exerciseIndex, { lastWeight = '60' } = {}) {
    const detail = {
        removed: false,
        remove() { this.removed = true; },
        querySelector: () => ({ dataset: { lastWeight } }),
    };
    const byId = new Map();
    card.rows.forEach(({ weightInput }) => byId.set(weightInput.id, weightInput));
    byId.set(`exercise-${exerciseIndex}`, card.host);
    byId.set(`progression-detail-${exerciseIndex}-0`, detail);

    const document = {
        getElementById: (id) => byId.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
    };

    const methods = buildMethods(
        src,
        ['useLastWeight', 'carryWeightDown', '_setPlannedInputValue'],
        { document },
        'workout-view.js',
    );
    const view = Object.create(methods);
    view.app = { settings: { vibrationAlerts: false } };
    view.refreshPlateHint = () => {};
    view.maybeToggleRestoreChip = () => {};
    view.dedupePlateHints = () => {};
    return { view, detail, document };
}

// ---------------------------------------------------------------------------
// GT-06: "Use last weight" is an EXERCISE-level decision
// ---------------------------------------------------------------------------

test('useLastWeight reverts every row still showing the suggestion', () => {
    // The audit's exact plan: four rows pre-filled at the suggested 62.5.
    const card = makeCard(0, ['62.5', '62.5', '62.5', '62.5'], { priorWeight: 62.5 });
    const { view } = makeView(card, 0, { lastWeight: '60' });
    view.useLastWeight(0, 0);
    assert.deepEqual(card.rows.map(r => r.weightInput.value), ['60', '60', '60', '60'],
        'not 60 / 62.5 / 62.5 / 62.5');
});

test('useLastWeight leaves a row the lifter typed their own number into', () => {
    // Rejecting the app's suggestion is not licence to overwrite the lifter's.
    const card = makeCard(0, ['62.5', '62.5', '70', '62.5']);
    const { view } = makeView(card, 0, { lastWeight: '60' });
    view.useLastWeight(0, 0);
    assert.deepEqual(card.rows.map(r => r.weightInput.value), ['60', '60', '70', '60']);
});

test('useLastWeight fills rows that are still empty', () => {
    const card = makeCard(0, ['62.5', '', '']);
    const { view } = makeView(card, 0, { lastWeight: '60' });
    view.useLastWeight(0, 0);
    assert.deepEqual(card.rows.map(r => r.weightInput.value), ['60', '60', '60']);
});

test('useLastWeight moves the restore baseline with the value', () => {
    const card = makeCard(0, ['62.5', '62.5'], { priorWeight: 62.5 });
    const { view } = makeView(card, 0, { lastWeight: '60' });
    view.useLastWeight(0, 0);
    card.rows.forEach(({ row }) => assert.equal(row.dataset.priorWeight, '60',
        'the "same as last time" chip must stay truthful'));
});

test('useLastWeight removes the badge and its panel once the exercise is reverted', () => {
    const card = makeCard(0, ['62.5', '62.5']);
    const { view, detail } = makeView(card, 0, { lastWeight: '60' });
    view.useLastWeight(0, 0);
    assert.equal(card.badge.removed, true, 'the badge explained a prefill that is gone');
    assert.equal(detail.removed, true);
});

// ---------------------------------------------------------------------------
// GT-32: carry the first weight down an untouched exercise
// ---------------------------------------------------------------------------

test('typing set 1\'s weight seeds the empty rows below it', () => {
    const card = makeCard(0, ['60', '', '', '']);
    const { view } = makeView(card, 0);
    view.carryWeightDown(0, 0);
    assert.deepEqual(card.rows.map(r => r.weightInput.value), ['60', '60', '60', '60'],
        '27 manual entries on day one is the single most tedious moment in the app');
});

test('carry-down never overwrites a row that already has a value', () => {
    const card = makeCard(0, ['60', '50', '', '40']);
    const { view } = makeView(card, 0);
    view.carryWeightDown(0, 0);
    assert.deepEqual(card.rows.map(r => r.weightInput.value), ['60', '50', '60', '40'],
        'a deliberate back-off set is the lifter\'s choice');
});

test('carry-down only flows DOWNWARD, never back up', () => {
    const card = makeCard(0, ['', '', '80', '']);
    const { view } = makeView(card, 0);
    view.carryWeightDown(0, 2);
    assert.deepEqual(card.rows.map(r => r.weightInput.value), ['', '', '80', '80']);
});

test('carry-down does nothing from an empty source row', () => {
    const card = makeCard(0, ['', '', '']);
    const { view } = makeView(card, 0);
    view.carryWeightDown(0, 0);
    assert.deepEqual(card.rows.map(r => r.weightInput.value), ['', '', '']);
});

// ---------------------------------------------------------------------------
// GT-18: the PR badge names the record it actually broke
// ---------------------------------------------------------------------------

function prView(unit = 'kg') {
    const methods = buildMethods(
        src,
        ['formatPrDelta', 'prDeltaAriaLabel'],
        { formatDuration, displayWeight, roundForDisplay, volumeIn, normalizeWeightUnit },
        'workout-view.js',
    );
    const view = Object.create(methods);
    view.app = { settings: { weightUnit: unit } };
    return view;
}

test('a weight PR reads as a weight', () => {
    // 60 kg x 10 -> 65 kg x 10. The audit saw "PR +50 kg" for +5 kg on the bar.
    const view = prView();
    const pr = { kind: 'weight', delta: 50, weightDelta: 5, weight: 65, previousWeight: 60 };
    assert.equal(view.formatPrDelta(pr, 'kg'), '+5kg');
    assert.match(view.prDeltaAriaLabel(pr, 'kg'), /5 kg heavier/);
});

test('a set-volume PR is labelled as volume, never as raw kilograms', () => {
    const view = prView();
    const pr = { kind: 'volume', delta: 120, weightDelta: 0 };
    const label = view.formatPrDelta(pr, 'kg');
    assert.match(label, /kg·reps/, `expected a volume unit, got ${label}`);
    assert.doesNotMatch(label, /^\+\d+ kg$/, 'that reads as "you added N kg to the bar"');
});

test('a duration PR reads as time', () => {
    const view = prView();
    assert.equal(view.formatPrDelta({ kind: 'duration', delta: 15 }, 'kg'), '+0:15');
});

test('the PR delta converts into the display unit', () => {
    // 5 kg heavier reads as ~11 lb, not as "5 lb".
    const view = prView('lb');
    const pr = { kind: 'weight', delta: 50, weightDelta: 5 };
    assert.equal(view.formatPrDelta(pr, 'lb'), '+11lb');
    assert.equal(displayWeight(5, 'lb'), 11);
});

test('the visible label and the accessible name say the same thing', () => {
    const view = prView();
    for (const pr of [
        { kind: 'weight', delta: 50, weightDelta: 5 },
        { kind: 'volume', delta: 120 },
        { kind: 'duration', delta: 15 },
    ]) {
        const visible = view.formatPrDelta(pr, 'kg').replace('+', '');
        const spoken = view.prDeltaAriaLabel(pr, 'kg');
        const number = visible.match(/[\d.:]+/)[0];
        assert.ok(spoken.includes(number), `"${spoken}" must contain ${number}`);
    }
});

// ---------------------------------------------------------------------------
// GT-13: a swap keeps the planned slot's guidance
// ---------------------------------------------------------------------------

function programRowView(sessionExercise, programExercises) {
    const methods = buildMethods(src, ['programRowFor'], { sameId }, 'workout-view.js');
    const view = Object.create(methods);
    view.currentWorkoutSession = { programId: 1, exercises: [sessionExercise] };
    view.app = { getProgramById: () => ({ id: 1, exercises: programExercises }) };
    return view;
}

test('a swapped exercise still resolves its PLANNED program row', () => {
    // Cable Lat Pulldown (id 10, 10-12 reps) swapped for Neutral-Grip (id 11).
    const planRow = { exerciseId: 10, sets: [{ repsMin: 10, repsMax: 12 }], restSeconds: 75 };
    const view = programRowView({ exerciseId: 11, plannedExerciseId: 10 }, [planRow]);
    assert.equal(view.programRowFor(view.currentWorkoutSession.exercises[0]), planRow,
        'losing this is what dropped the rep target from the header');
});

test('an unswapped exercise resolves the same row it always did', () => {
    const planRow = { exerciseId: 10, sets: [{ repsMin: 6, repsMax: 8 }] };
    const view = programRowView({ exerciseId: 10, plannedExerciseId: 10 }, [planRow]);
    assert.equal(view.programRowFor(view.currentWorkoutSession.exercises[0]), planRow);
});

test('a legacy session with no plannedExerciseId still resolves', () => {
    const planRow = { exerciseId: 10, sets: [{ repsMin: 6, repsMax: 8 }] };
    const view = programRowView({ exerciseId: 10 }, [planRow]);
    assert.equal(view.programRowFor(view.currentWorkoutSession.exercises[0]), planRow);
});

test('program-row lookup tolerates a string/number id mismatch', () => {
    const planRow = { exerciseId: '10', sets: [{ repsMin: 6, repsMax: 8 }] };
    const view = programRowView({ exerciseId: 10, plannedExerciseId: 10 }, [planRow]);
    assert.equal(view.programRowFor(view.currentWorkoutSession.exercises[0]), planRow);
});

test('a swap does not rewrite plannedExerciseId', () => {
    // The substitute owns the sets, the history and the PRs; the PLAN row it
    // stands in for still owns the target, the rep ranges and the rest values.
    const body = extractClassMethod(src, 'pickSwapExercise', 'workout-view.js');
    assert.match(body, /exercise\.exerciseId = replacement\.id/);
    assert.doesNotMatch(body, /plannedExerciseId\s*=/);
});

// ---------------------------------------------------------------------------
// GT-12: timed exercises are planned in seconds
// ---------------------------------------------------------------------------

test('plannedSecondsFor reads the row\'s target hold', () => {
    const methods = buildMethods(src, ['plannedSecondsFor'], { DEFAULT_TARGET_SECONDS }, 'workout-view.js');
    const view = Object.create(methods);
    assert.equal(view.plannedSecondsFor([{ targetSeconds: 90 }], 0), 90);
});

test('plannedSecondsFor falls back for a legacy row rather than reading its reps', () => {
    const methods = buildMethods(src, ['plannedSecondsFor'], { DEFAULT_TARGET_SECONDS }, 'workout-view.js');
    const view = Object.create(methods);
    // A legacy plank row is `{repsMin: 10, repsMax: 10}`. "10" is not a target.
    assert.equal(view.plannedSecondsFor([{ repsMin: 10, repsMax: 10, targetSeconds: null }], 0),
        DEFAULT_TARGET_SECONDS);
    assert.equal(view.plannedSecondsFor(null, 0), DEFAULT_TARGET_SECONDS);
    assert.equal(view.plannedSecondsFor([], 3), DEFAULT_TARGET_SECONDS);
});

test('the workout header renders a timed target as a duration, not as reps', () => {
    const body = extractClassMethod(src, 'renderExerciseEntry', 'workout-view.js');
    assert.match(body, /Target \$\{formatDuration\(/, 'a plank must not advertise "10 reps"');
});

test('a timed planned row pre-fills from the plan when there is no history', () => {
    const body = extractClassMethod(src, 'renderPlannedRow', 'workout-view.js');
    assert.match(body, /prior && prior\.duration > 0.*?\n?.*?targetSeconds/s,
        'the first-ever plank should not start at 0:00');
});

// ---------------------------------------------------------------------------
// GT-07: the finish dialog belongs to ONE session
// ---------------------------------------------------------------------------

test('resetFinishWorkoutForm clears every session-specific field', () => {
    const body = extractClassMethod(src, 'resetFinishWorkoutForm', 'workout-view.js');
    for (const id of ['workout-notes', 'avg-heart-rate', 'max-heart-rate', 'calories-burned']) {
        assert.match(body, new RegExp(id), `${id} leaked into the next workout`);
    }
});

test('starting a NEW workout clears the finish form', () => {
    const body = extractClassMethod(src, 'startWorkout', 'workout-view.js');
    assert.match(body, /resetFinishWorkoutForm\(\)/);
});

test('reopening the SAME session\'s dialog keeps what was typed', () => {
    // Stepping out of the dialog to log one more set must not wipe the note.
    const body = extractClassMethod(src, 'openFinishWorkoutModal', 'workout-view.js');
    assert.match(body, /_finishFormSessionId/);
    assert.match(body, /sameId\(this\._finishFormSessionId/);
});

test('finishing and discarding both leave a clean form behind', () => {
    for (const name of ['finishWorkout', 'discardWorkout']) {
        const body = extractClassMethod(src, name, 'workout-view.js');
        assert.match(body, /resetFinishWorkoutForm\(\)/, `${name} must reset the dialog`);
    }
});

// ---------------------------------------------------------------------------
// GT-22: the feel prompt no longer blocks the workout
// ---------------------------------------------------------------------------

test('the feel prompt is rendered inline, not as a modal', () => {
    const body = extractClassMethod(src, 'showFeelPrompt', 'workout-view.js');
    assert.match(body, /gt-feel-prompt/);
    assert.doesNotMatch(body, /classList\.add\('active'\)/, 'no modal is opened');
    assert.doesNotMatch(body, /trapModalFocus/, 'and no focus trap steals the screen');
});

test('the feel prompt sits outside the collapsible body so a complete card still shows it', () => {
    const body = extractClassMethod(src, 'showFeelPrompt', 'workout-view.js');
    assert.match(body, /host\.insertBefore\(prompt, body\)/);
});

test('the feel prompt still fires at most once per exercise per session', () => {
    const body = extractClassMethod(src, 'maybeShowFeelModal', 'workout-view.js');
    assert.match(body, /shouldShowFeelModal\(this\._feelModalShown/);
    assert.match(body, /this\._feelModalShown\[exerciseIndex\] = true/);
});

test('timed exercises are still excluded from the feel prompt', () => {
    const body = extractClassMethod(src, '_exerciseReachesMax', 'workout-view.js');
    assert.match(body, /exerciseType === 'duration'\) return false/);
});

// ---------------------------------------------------------------------------
// GT-40: per-exercise bar weight
// ---------------------------------------------------------------------------

function barView(settings, unit = 'kg') {
    const methods = buildMethods(
        src,
        ['sessionUnit', 'sessionPlateConfig', 'sessionBarWeight'],
        { normalizeWeightUnit },
        'workout-view.js',
    );
    const view = Object.create(methods);
    view.app = { settings };
    view.currentWorkoutSession = { sessionUnit: unit };
    return view;
}

test('an exercise with no override uses the profile bar', () => {
    const view = barView(Settings.getDefault());
    assert.equal(view.sessionBarWeight(3), 20);
});

test('an EZ-bar override wins for that exercise only', () => {
    const settings = Settings.getDefault();
    settings.setBarWeightForExercise(70, 7, 'kg'); // Barbell Curl on an EZ bar
    const view = barView(settings);
    assert.equal(view.sessionBarWeight(70), 7);
    assert.equal(view.sessionBarWeight(3), 20, 'the bench press is unaffected');
});

test('the bar override follows the SESSION\'s unit, like the plates do', () => {
    const settings = Settings.getDefault();
    settings.setBarWeightForExercise(70, 7, 'kg');
    settings.setBarWeightForExercise(70, 15, 'lb');
    assert.equal(barView(settings, 'kg').sessionBarWeight(70), 7);
    assert.equal(barView(settings, 'lb').sessionBarWeight(70), 15);
});

test('the plate profile is read for the session unit, not the account unit', () => {
    const settings = Settings.getDefault(); // account displays kg
    const view = barView(settings, 'lb');   // but this workout is entered in lb
    assert.deepEqual(view.sessionPlateConfig().plates, [45, 35, 25, 10, 5, 2.5]);
});

test('setting an empty override returns the exercise to the default', () => {
    const body = extractClassMethod(src, 'setExerciseBarWeight', 'workout-view.js');
    assert.match(body, /setBarWeightForExercise\(/);
    assert.match(body, /saveSettings\(\)/, 'the override outlives this workout');
});
