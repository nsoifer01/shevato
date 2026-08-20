// Custom exercises: validation, duplicate names, deletion (GT-15, GT-16,
// GT-26, GT-27, GT-28, GT-39) and the history cleanup that goes with them
// (GT-14).
//
//   GT-15  the three required <select>s are hidden behind dark-select, so the
//          browser could not focus or render its own validation UI. It just
//          refused to submit, logged "An invalid form control with name='' is
//          not focusable" three times, and showed the user nothing at all.
//   GT-16  a custom exercise could take a catalog name exactly, and the
//          program picker then showed two identical rows.
//   GT-27  deleting an exercise a live program still used was allowed with no
//          warning, leaving the program row with a name and nothing else.
//   GT-28  a custom exercise with history simply had no delete button and no
//          explanation of how to get one.
//   GT-39  a 120-character name was accepted.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, extractClassMethod, loadSource } from './helpers/source-extract.mjs';
import { CUSTOM_EXERCISE_NAME_MAX } from '../js/utils/exercise-taxonomy.js';
import { normalizeSearchText } from '../js/utils/exercise-search.js';
import { sameId } from '../js/utils/id-utils.js';
import { isLoggedSession } from '../js/utils/session-metrics.js';

const src = loadSource('js/views/exercises-view.js');

// ---------------------------------------------------------------------------
// GT-15: validation the user can actually perceive
// ---------------------------------------------------------------------------

/** Minimal stand-in for HTMLElement so `instanceof` guards behave. */
class FakeElement {
    constructor() {
        this.attrs = {};
        this.focused = false;
    }

    focus() { this.focused = true; }

    scrollIntoView() {}

    setAttribute(k, v) { this.attrs[k] = v; }

    removeAttribute(k) { delete this.attrs[k]; }
}

function makeForm({ name = '', category = '', muscleGroup = '', equipment = '' } = {}) {
    const groups = new Map();
    const make = (id, value) => {
        const group = {
            classes: new Set(),
            classList: {
                add(c) { this._set.add(c); },
                remove(c) { this._set.delete(c); },
                contains(c) { return this._set.has(c); },
            },
            children: [],
            querySelector(sel) {
                if (sel === '.gt-field-error') return this.errorEl || null;
                return this.trigger || null;
            },
            appendChild(el) { this.errorEl = el; this.children.push(el); },
        };
        group.classList._set = group.classes;
        // The visible proxy the user can actually focus.
        group.trigger = new FakeElement();
        const el = {
            id,
            value,
            tagName: id === 'custom-exercise-name' ? 'INPUT' : 'SELECT',
            closest: () => group,
            setAttribute() {},
            removeAttribute() {},
        };
        groups.set(id, { el, group });
        return el;
    };

    make('custom-exercise-name', name);
    make('custom-exercise-category', category);
    make('custom-exercise-muscle', muscleGroup);
    make('custom-exercise-equipment', equipment);

    const modalErrors = [];
    const modal = {
        querySelectorAll(sel) {
            if (sel === '.has-error') {
                return [...groups.values()].filter(g => g.group.classes.has('has-error')).map(g => g.group);
            }
            if (sel === '.gt-field-error') {
                return [...groups.values()].map(g => g.group.errorEl).filter(Boolean);
            }
            return [];
        },
    };

    const document = {
        getElementById: (id) => (id === 'custom-exercise-modal' ? modal : groups.get(id)?.el || null),
        createElement: () => ({ className: '', id: '', textContent: '', hidden: true, setAttribute() {} }),
    };

    const toasts = [];
    const methods = buildMethods(
        src,
        ['validateCustomExerciseForm', 'showFieldError', 'visibleControlFor', 'focusFieldControl', 'clearFieldError'],
        {
            document,
            CUSTOM_EXERCISE_NAME_MAX,
            showToast: (message, type) => toasts.push({ message, type }),
            // The methods guard with `instanceof HTMLElement` before focusing;
            // node has no DOM, so the stub trigger has to satisfy that check.
            HTMLElement: FakeElement,
        },
        'exercises-view.js',
    );
    const view = Object.create(methods);
    return { view, groups, toasts, modalErrors };
}

test('an empty form is rejected with a VISIBLE message, not silence', () => {
    const { view, groups, toasts } = makeForm();
    assert.equal(view.validateCustomExerciseForm({ name: '', category: '', muscleGroup: '', equipment: '' }), false);
    assert.ok(toasts.length > 0, 'the user is told something');
    assert.equal(groups.get('custom-exercise-name').group.classes.has('has-error'), true);
    assert.ok(groups.get('custom-exercise-name').group.errorEl.textContent.length > 0,
        'and an inline message is rendered');
});

test('every missing field is flagged at once, not one round-trip at a time', () => {
    const { view, groups } = makeForm({ name: 'Gym A Row' });
    view.validateCustomExerciseForm({ name: 'Gym A Row', category: '', muscleGroup: '', equipment: '' });
    for (const id of ['custom-exercise-category', 'custom-exercise-muscle', 'custom-exercise-equipment']) {
        assert.equal(groups.get(id).group.classes.has('has-error'), true, `${id} not flagged`);
    }
});

test('focus goes to the VISIBLE control, since the native select is hidden', () => {
    const { view, groups } = makeForm({ name: 'Gym A Row' });
    view.validateCustomExerciseForm({ name: 'Gym A Row', category: '', muscleGroup: 'Chest', equipment: 'barbell' });
    assert.equal(groups.get('custom-exercise-category').group.trigger.focused, true);
});

test('the error is announced: aria-invalid plus a described-by message', () => {
    const { view, groups } = makeForm();
    view.validateCustomExerciseForm({ name: '', category: '', muscleGroup: '', equipment: '' });
    const trigger = groups.get('custom-exercise-category').group.trigger;
    assert.equal(trigger.attrs['aria-invalid'], 'true');
    assert.ok(trigger.attrs['aria-describedby'], 'the message is linked to the control');
});

test('a complete form validates', () => {
    const { view, toasts } = makeForm();
    assert.equal(view.validateCustomExerciseForm({
        name: 'Hammer Strength Row', category: 'back', muscleGroup: 'Lats', equipment: 'machine',
    }), true);
    assert.deepEqual(toasts, []);
});

test('GT-39: an over-long name is rejected with a message that states the limit', () => {
    const { view, groups } = makeForm();
    const long = 'x'.repeat(120);
    assert.equal(view.validateCustomExerciseForm({
        name: long, category: 'back', muscleGroup: 'Lats', equipment: 'machine',
    }), false);
    assert.match(groups.get('custom-exercise-name').group.errorEl.textContent,
        new RegExp(String(CUSTOM_EXERCISE_NAME_MAX)));
});

test('clearing a field removes its error state', () => {
    const { view, groups } = makeForm();
    view.validateCustomExerciseForm({ name: '', category: '', muscleGroup: '', equipment: '' });
    view.clearFieldError('custom-exercise-name');
    assert.equal(groups.get('custom-exercise-name').group.classes.has('has-error'), false);
    assert.equal(groups.get('custom-exercise-name').group.trigger.attrs['aria-invalid'], undefined);
});

test('the form is submitted through our validation, never the browser\'s', () => {
    // `novalidate` is what stops Chrome silently refusing to submit because a
    // display:none required control cannot be focused.
    const wiring = extractClassMethod(src, 'setupEventListeners', 'exercises-view.js');
    assert.match(wiring, /noValidate = true/);
});

test('the name input carries the cap so the limit is felt while typing', () => {
    const wiring = extractClassMethod(src, 'setupEventListeners', 'exercises-view.js');
    assert.match(wiring, /maxLength = CUSTOM_EXERCISE_NAME_MAX/);
});

test('both category selects are populated from the ONE taxonomy', () => {
    const wiring = extractClassMethod(src, 'setupEventListeners', 'exercises-view.js');
    assert.match(wiring, /populateSelect\(categoryFilter, EXERCISE_CATEGORIES/);
    assert.match(wiring, /populateSelect\(document\.getElementById\('custom-exercise-category'\)/);
});

// ---------------------------------------------------------------------------
// GT-16: duplicate names
// ---------------------------------------------------------------------------

test('an exact normalized clash is detected however it is spelled', () => {
    const catalog = [{ id: 3, name: 'Barbell Bench Press' }];
    const clash = (typed) => catalog.find(ex => normalizeSearchText(ex.name) === normalizeSearchText(typed));
    assert.ok(clash('Barbell Bench Press'));
    assert.ok(clash('barbell bench press'), 'case is not a distinction');
    assert.ok(clash('Barbell  Bench  Press'), 'nor is spacing');
});

test('a legitimate variant is NOT treated as a duplicate', () => {
    const catalog = [{ id: 3, name: 'Barbell Bench Press' }];
    const clash = (typed) => catalog.find(ex => normalizeSearchText(ex.name) === normalizeSearchText(typed));
    assert.equal(clash('Barbell Bench Press (Gym A)'), undefined);
    assert.equal(clash('Close-Grip Bench Press'), undefined);
});

test('creating a clashing name asks before proceeding', () => {
    const body = extractClassMethod(src, 'createCustomExercise', 'exercises-view.js');
    assert.match(body, /normalizeSearchText\(ex\.name\) === normalizeSearchText\(name\)/);
    assert.match(body, /showConfirmModal/);
    assert.match(body, /splits your history/i, 'the warning says WHY it matters');
});

test('a custom exercise is marked as such in BOTH pickers, not just the database', () => {
    // Picking the wrong one of two identical rows silently splits history, PRs
    // and progression with no visible symptom.
    const programs = loadSource('js/views/programs-view.js');
    const workout = loadSource('js/views/workout-view.js');
    const badge = /isCustom[\s\S]{0,80}badge badge-custom">Custom/;
    assert.match(programs, badge, 'the program picker must distinguish them');
    assert.match(workout, badge, 'and so must the in-workout swap picker');
});

// ---------------------------------------------------------------------------
// GT-27 / GT-28: deletion
// ---------------------------------------------------------------------------

test('programsUsingExercise finds every program that still references it', () => {
    const methods = buildMethods(src, ['programsUsingExercise'], { sameId }, 'exercises-view.js');
    const view = Object.create(methods);
    view.app = {
        programs: [
            { name: 'Push', exercises: [{ exerciseId: 5 }, { exerciseId: 6 }] },
            { name: 'Pull', exercises: [{ exerciseId: '5' }] },  // string id from an import
            { name: 'Legs', exercises: [{ exerciseId: 9 }] },
        ],
    };
    assert.deepEqual(view.programsUsingExercise(5).map(p => p.name), ['Push', 'Pull']);
    assert.deepEqual(view.programsUsingExercise(99), []);
});

test('deleting a referenced exercise warns and names the programs', () => {
    const body = extractClassMethod(src, 'deleteCustomExercise', 'exercises-view.js');
    assert.match(body, /programsUsingExercise\(/);
    assert.match(body, /Still used by a program/);
    assert.match(body, /escapeHtml\(p\.name\)/, 'the user is told WHICH programs');
});

test('deletion is still refused while the exercise has history', () => {
    // The safety rule was right; only its discoverability was not.
    const body = extractClassMethod(src, 'deleteCustomExercise', 'exercises-view.js');
    assert.match(body, /hasHistory/);
    assert.match(body, /logged history before deleting/i);
});

test('a history-blocked exercise shows a disabled delete that explains itself', () => {
    const body = extractClassMethod(src, 'renderExerciseList', 'exercises-view.js');
    assert.match(body, /blockedDelete/);
    assert.match(body, /explain-delete-blocked/);
    assert.match(body, /Remove its logged history before deleting it/);
});

test('the explanation offers the path out of it', () => {
    const body = extractClassMethod(src, 'explainDeleteBlocked', 'exercises-view.js');
    assert.match(body, /showExerciseHistory\(exerciseId\)/, 'not just "no"; here is how');
});

// ---------------------------------------------------------------------------
// GT-14: removing history prunes the sessions it empties
// ---------------------------------------------------------------------------

test('removing an exercise\'s history drops sessions it leaves with nothing', () => {
    const body = extractClassMethod(src, 'deleteExerciseHistory', 'exercises-view.js');
    assert.match(body, /filter\(isLoggedSession\)/);
    assert.match(body, /updateAchievements\(\)/, 'counts derived from it must be recomputed');
});

test('the confirmation says how many workouts would be removed', () => {
    const body = extractClassMethod(src, 'deleteExerciseHistory', 'exercises-view.js');
    assert.match(body, /wouldEmpty/);
});

test('the pruning rule itself: only sessions with nothing left', () => {
    const sessions = [
        // One exercise removed, another still logged: kept.
        { id: 1, exercises: [{ exerciseId: 9, sets: [{ completed: true }] }] },
        // Everything gone: dropped.
        { id: 2, exercises: [{ exerciseId: 9, sets: [] }] },
    ];
    assert.deepEqual(sessions.filter(isLoggedSession).map(s => s.id), [1]);
});
