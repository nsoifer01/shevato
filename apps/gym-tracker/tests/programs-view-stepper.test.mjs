// Rest steppers in the Edit Program modal.
//
// What these tests pin: a +/- click updates ONE stepper in place. It used to
// call renderProgramExercises(), which reassigns the whole
// #program-exercises-list innerHTML, so a single click on one card's rest "+"
// destroyed all seven cards and every control in them, and focus fell from the
// clicked button to <body>, so a user could not press "+" twice without
// re-aiming. So:
//   - the model still does the clamping (Program.updateExercise -> 0..900),
//     the view only reads the normalized value back and displays it;
//   - repeated clicks must accumulate (five * +15 from 3m lands on 4:15, which
//     is only true if each click reads the CURRENT model value);
//   - the only DOM writes allowed are the value text and the disabled state of
//     the two buttons at the bounds. The value text node is mutated, never
//     replaced, so nothing under the pointer is torn down.
//
// stepperHTML / syncStepperUI / formatRestLabel / adjustExerciseTarget are all
// the REAL implementations lifted from programs-view.js source text, and the
// fake stepper elements are built by parsing the markup the real stepperHTML()
// emits. If production renames a class or reshapes the selector, the fakes
// return null and the value assertions fail loudly instead of an old
// hand-mirrored copy silently keeping the test green.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, buildFunctions, buildMethods } from './helpers/source-extract.mjs';

const { Program, DEFAULT_TARGET_SECONDS } = await import('../js/models/Program.js');
const { formatDuration } = await import('../js/utils/units.js');

const src = loadSource('js/views/programs-view.js');
// formatRestLabel delegates to the shared M:SS formatter (GT-34), so the real
// one is handed in rather than re-implemented.
const { stepperHTML, syncStepperUI, formatRestLabel } = buildFunctions(
    src,
    ['stepperHTML', 'syncStepperUI', 'formatRestLabel'],
    { formatDuration },
    'programs-view.js',
);

// ---- fake elements derived from the REAL stepperHTML() markup ------------

function fakeStepper(field, index, value) {
    const html = stepperHTML(field, index, value, 0, 900, `Rest ${field}`, 15, formatRestLabel(value));

    // The value display is a single text node inside .pex-stepper-value.
    const valueText = />([^<>]*)<\/span>/.exec(html.match(/<span class="pex-stepper-value">[^<]*<\/span>/)[0]);
    const textNode = { data: valueText ? valueText[1] : '' };
    const valueSpan = { firstChild: textNode, get textContent() { return textNode.data; } };

    // One fake button per <button ... data-stepper ...> tag in the markup.
    const buttons = [...html.matchAll(/<button[^>]*\bdata-stepper\b[^>]*>/g)].map(([tag]) => ({
        dataset: {
            stepper: '',
            index: /data-index="([^"]*)"/.exec(tag)?.[1],
            field: /data-field="([^"]*)"/.exec(tag)?.[1],
            delta: /data-delta="([^"]*)"/.exec(tag)?.[1],
        },
        disabled: /\bdisabled\b/.test(tag),
    }));

    return {
        field,
        index,
        textNode,
        buttons,
        minus: buttons.find(b => Number(b.dataset.delta) < 0),
        plus: buttons.find(b => Number(b.dataset.delta) > 0),
        shown: () => valueSpan.textContent,
        // Selector support is derived from the real markup: querying a class
        // that stepperHTML no longer emits returns null (loud downstream).
        querySelector: (sel) => (sel.startsWith('.') && html.includes(`class="${sel.slice(1)}"`) ? valueSpan : null),
        querySelectorAll: (sel) => (sel === '[data-stepper]' && html.includes('data-stepper') ? buttons : []),
    };
}

// ---- the editor: real Program + real adjustExerciseTarget ---------------

function makeEditor(exercises) {
    const program = new Program({ name: 'Push', exercises });
    const steppers = program.exercises.flatMap((ex, i) => [
        fakeStepper('rest', i, ex.restSeconds),
        fakeStepper('restAfter', i, ex.restAfterSeconds),
    ]);
    const stepperFor = (index, field) => steppers.find(s => s.index === index && s.field === field) || null;

    // adjustExerciseTarget locates its stepper with one compound selector;
    // parse the index/field back out of it. An unrecognized selector shape
    // returns null, which the real syncStepperUI treats as "nothing to sync",
    // and the label assertions below then fail.
    const document = {
        querySelector: (sel) => {
            const m = /\.program-exercise-row\[data-exercise-index="(\d+)"\] \.pex-stepper\[data-field="(\w+)"\]/.exec(sel);
            return m ? stepperFor(Number(m[1]), m[2]) : null;
        },
    };
    const methods = buildMethods(
        src,
        ['adjustExerciseTarget'],
        { document, syncStepperUI, formatRestLabel, formatDuration, DEFAULT_TARGET_SECONDS },
        'programs-view.js',
    );
    const view = Object.create(methods);
    view.currentProgram = program;

    // What a user click does: read the delta off the button that was pressed.
    const click = (index, field, sign, times = 1) => {
        for (let i = 0; i < times; i++) {
            const st = stepperFor(index, field);
            const btn = sign === '-' ? st.minus : st.plus;
            if (btn.disabled) continue; // a disabled button eats the click
            view.adjustExerciseTarget(index, field, Number(btn.dataset.delta));
        }
    };

    return {
        click,
        adjust: (index, field, delta) => view.adjustExerciseTarget(index, field, delta),
        stepper: stepperFor,
        shown: (index, field) => stepperFor(index, field).shown(),
        model: (index, field) => program.exercises[index][field === 'rest' ? 'restSeconds' : 'restAfterSeconds'],
    };
}

const oneExercise = [{ exerciseId: 'e1', exerciseName: 'Bench', restSeconds: 180, restAfterSeconds: 180, sets: [{ repsMin: 6, repsMax: 8 }] }];

// -------------------------------------------------------
// The value moves, and it accumulates across clicks
// -------------------------------------------------------

test('rest stepper: one "+" advances the model and the label together', () => {
    const ed = makeEditor(oneExercise);
    assert.equal(ed.shown(0, 'rest'), '3:00');
    ed.click(0, 'rest', '+');
    assert.equal(ed.model(0, 'rest'), 195);
    assert.equal(ed.shown(0, 'rest'), '3:15', 'the displayed label is refreshed from the model');
});

test('rest stepper: five "+" clicks accumulate to 4:15, not 3:15', () => {
    // The regression this guards: each click must read the CURRENT model value.
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 5);
    assert.equal(ed.model(0, 'rest'), 255);
    assert.equal(ed.shown(0, 'rest'), '4:15');
});

test('rest stepper: "-" walks back down through the same values', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 2);
    ed.click(0, 'rest', '-', 3);
    assert.equal(ed.model(0, 'rest'), 165);
    assert.equal(ed.shown(0, 'rest'), '2:45');
});

// -------------------------------------------------------
// Bounds: clamped by the model, reflected by the buttons
// -------------------------------------------------------

test('rest stepper: the floor is the model\'s 0, and "-" disables there', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '-', 40); // 180 / 15 = 12 clicks reach 0, the rest are eaten
    assert.equal(ed.model(0, 'rest'), 0, 'Program.updateExercise clamps at 0');
    assert.equal(ed.shown(0, 'rest'), '0:00');
    assert.equal(ed.stepper(0, 'rest').minus.disabled, true, 'cannot go lower');
    assert.equal(ed.stepper(0, 'rest').plus.disabled, false, 'can still go up');
});

test('rest stepper: the ceiling is the model\'s 900, and "+" disables there', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 70);
    assert.equal(ed.model(0, 'rest'), 900, 'Program.updateExercise clamps at 900');
    assert.equal(ed.shown(0, 'rest'), '15:00');
    assert.equal(ed.stepper(0, 'rest').plus.disabled, true, 'cannot go higher');
    assert.equal(ed.stepper(0, 'rest').minus.disabled, false);
});

test('rest stepper: stepping back off a bound re-enables the button', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 70);
    ed.click(0, 'rest', '-');
    assert.equal(ed.model(0, 'rest'), 885);
    assert.equal(ed.shown(0, 'rest'), '14:45');
    assert.equal(ed.stepper(0, 'rest').plus.disabled, false, '"+" comes back as soon as there is room');
});

// -------------------------------------------------------
// Nothing beyond the one stepper is touched
// -------------------------------------------------------

test('rest stepper: the value text node is mutated, never replaced', () => {
    // Replacing it is what re-rendering did, and that is what dropped focus.
    const ed = makeEditor(oneExercise);
    const node = ed.stepper(0, 'rest').textNode;
    ed.click(0, 'rest', '+', 3);
    assert.equal(ed.stepper(0, 'rest').textNode, node, 'same text node instance');
    assert.equal(node.data, '3:45', 'and it carries the new label');
});

test('rest stepper: "Rest between sets" and "Rest after exercise" move independently', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 2);
    ed.click(0, 'restAfter', '-', 2);
    assert.equal(ed.model(0, 'rest'), 210);
    assert.equal(ed.shown(0, 'rest'), '3:30');
    assert.equal(ed.model(0, 'restAfter'), 150);
    assert.equal(ed.shown(0, 'restAfter'), '2:30');
});

test('rest stepper: a click on one exercise leaves the other exercises alone', () => {
    const ed = makeEditor([
        ...oneExercise,
        { exerciseId: 'e2', exerciseName: 'Fly', restSeconds: 90, restAfterSeconds: 90, sets: [{ repsMin: 10, repsMax: 10 }] },
    ]);
    ed.click(1, 'rest', '+', 2);
    assert.equal(ed.model(1, 'rest'), 120);
    assert.equal(ed.shown(1, 'rest'), '2:00');
    assert.equal(ed.model(0, 'rest'), 180, 'exercise 1 is untouched');
    assert.equal(ed.shown(0, 'rest'), '3:00', 'and its stepper was never rewritten');
});

test('rest stepper: only the two rest fields are writable, and only real rows', () => {
    // The handler is delegated off data-field, so it must ignore anything that
    // is not one of the two rest fields instead of writing a junk key.
    const ed = makeEditor(oneExercise);
    ed.adjust(0, 'targetSets', 15);
    ed.adjust(9, 'rest', 15);
    assert.equal(ed.model(0, 'rest'), 180);
    assert.equal(ed.model(0, 'restAfter'), 180);
    assert.equal(ed.shown(0, 'rest'), '3:00');
});

// -------------------------------------------------------
// Label formatting the stepper depends on (real formatRestLabel)
// -------------------------------------------------------

// GT-34: ONE rest format. The editor used to render round minutes as "3m",
// sub-minute values as "45s" and everything else as "M:SS", so a single
// program list stacked "3m / 1:30 / 1m / 1:15" and the reader had to work out
// that those were the same kind of number.
test('formatRestLabel: every rest value renders as M:SS', () => {
    assert.equal(formatRestLabel(0), '0:00');
    assert.equal(formatRestLabel(45), '0:45');
    assert.equal(formatRestLabel(60), '1:00');
    assert.equal(formatRestLabel(90), '1:30');
    assert.equal(formatRestLabel(180), '3:00');
    assert.equal(formatRestLabel(900), '15:00');
});

test('formatRestLabel: no value in a program list can render in two formats', () => {
    // The concrete list from the audit: 3m / 1:30 / 1m / 1:15.
    const rendered = [180, 90, 60, 75].map(formatRestLabel);
    assert.deepEqual(rendered, ['3:00', '1:30', '1:00', '1:15']);
    assert.ok(rendered.every(v => /^\d+:\d{2}$/.test(v)), 'all one shape');
});
