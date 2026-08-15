// The rep-mode segmented control in the program editor, rendered from the
// REAL template fragments inside ProgramsView.renderProgramExercises.
//
// These tests pin the 2026-08-10 editor round's discoverability contract:
//   - the control shows BOTH modes at once and marks the CURRENT one selected,
//     replacing the old single button whose label was the mode you'd switch TO
//     ("Range" while the set was single), which read as a value, not a mode;
//   - re-picking the already-selected mode is a no-op, so both options carry
//     data-mode and the handler compares it against the set's state;
//   - the per-card "Each set can be a single target or a range." caption is
//     gone: the two visible options say the same thing without costing a line
//     of height in every exercise card.
//
// The modeOpt arrow and the .pex-mode-seg wrapper are extracted from
// programs-view.js source text and re-evaluated, so a template change there
// fails here instead of drifting past a copy written inside the test.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, extractClassMethod } from './helpers/source-extract.mjs';

const src = loadSource('js/views/programs-view.js');
const renderSrc = extractClassMethod(src, 'renderProgramExercises', 'programs-view.js');

// The per-set-row mode-option builder (an arrow closing over si/index).
const modeOptMatch = /const modeOpt = (\(mode, label, on\) => `[\s\S]*?`);/.exec(renderSrc);
assert.ok(modeOptMatch, 'modeOpt arrow found in renderProgramExercises');

// The segmented-control wrapper that invokes modeOpt for both modes.
const segMatch = /<span class="pex-mode-seg"[\s\S]*?<\/span>/.exec(renderSrc);
assert.ok(segMatch, '.pex-mode-seg template fragment found in renderProgramExercises');

/** Render the real segmented control for one set row. */
function modeSegHTML(setRow, si = 0, index = 0) {
    const isSingle = setRow.repsMin === setRow.repsMax;
    const modeOpt = new Function('si', 'index', `"use strict"; return ${modeOptMatch[1]};`)(si, index);
    return new Function('modeOpt', 'si', 'isSingle', `"use strict"; return \`${segMatch[0]}\`;`)(modeOpt, si, isSingle);
}

const pressed = (html) => [...html.matchAll(/aria-pressed="(true|false)"/g)].map(m => m[1]);

// -------------------------------------------------------
// Both modes are always on screen
// -------------------------------------------------------

test('mode control: renders exactly two options, labelled Single and Range', () => {
    const html = modeSegHTML({ repsMin: 10, repsMax: 10 });
    const options = [...html.matchAll(/class="pex-mode-opt/g)];
    assert.equal(options.length, 2, 'exactly two mode options per set row');
    assert.ok(html.includes('>Single<'), '"Single" option is present');
    assert.ok(html.includes('>Range<'), '"Range" option is present');
});

test('mode control: a single-value set marks Single selected, Range unselected', () => {
    const html = modeSegHTML({ repsMin: 8, repsMax: 8 });
    assert.deepEqual(pressed(html), ['true', 'false'], 'Single is pressed, Range is not');
    assert.ok(html.includes('pex-mode-opt is-on'), 'the selected option carries is-on');
    assert.equal([...html.matchAll(/is-on/g)].length, 1, 'only one option is selected');
});

test('mode control: a range set marks Range selected, Single unselected', () => {
    const html = modeSegHTML({ repsMin: 8, repsMax: 12 });
    assert.deepEqual(pressed(html), ['false', 'true'], 'Range is pressed, Single is not');
    assert.equal([...html.matchAll(/is-on/g)].length, 1, 'only one option is selected');
});

// -------------------------------------------------------
// The handler can tell "switch mode" from "re-pick current mode"
// -------------------------------------------------------

test('mode control: both options carry data-mode so re-picking the current one is a no-op', () => {
    const html = modeSegHTML({ repsMin: 10, repsMax: 10 });
    assert.ok(html.includes('data-mode="single"'), 'Single option declares its mode');
    assert.ok(html.includes('data-mode="range"'), 'Range option declares its mode');
    const actions = [...html.matchAll(/data-action="toggle-rep-range"/g)];
    assert.equal(actions.length, 2, 'both options reuse the existing toggle-rep-range action');
});

test('mode control: every option names its set number for screen readers', () => {
    const html = modeSegHTML({ repsMin: 6, repsMax: 10 }, 2);
    assert.ok(html.includes('aria-label="Set 3: single rep target"'), 'Single names its set');
    assert.ok(html.includes('aria-label="Set 3: rep range"'), 'Range names its set');
    assert.ok(html.includes('aria-label="Set 3 rep mode"'), 'the group names its set');
});

test('mode control: options carry the exercise and set indices the handler reads', () => {
    const html = modeSegHTML({ repsMin: 6, repsMax: 10 }, 1, 4);
    assert.equal([...html.matchAll(/data-exercise-index="4"/g)].length, 2);
    assert.equal([...html.matchAll(/data-set-index="1"/g)].length, 2);
});

// -------------------------------------------------------
// The per-card helper caption is gone, and layout order holds
// -------------------------------------------------------

test('sets block: no per-exercise range hint caption is rendered anywhere', () => {
    assert.ok(!src.includes('pex-range-hint'), 'the hint element is gone from programs-view.js');
    assert.ok(
        !src.includes('Each set can be a single target or a range.'),
        'the hint sentence is gone; the segmented control states both options'
    );
});

test('sets block: "+ Add set" follows the set rows instead of sitting in a header', () => {
    const setsBlockIdx = renderSrc.indexOf('pex-sets-block');
    const addSetIdx = renderSrc.indexOf('pex-add-set-btn');
    assert.notEqual(setsBlockIdx, -1, 'set rows block is present');
    assert.notEqual(addSetIdx, -1, 'add-set button is present');
    assert.ok(addSetIdx > setsBlockIdx, 'add-set comes after the sets block in the card template');
    assert.ok(!src.includes('pex-sets-header'), 'the old sets header no longer exists');
});
