// Mirror of the rep-mode segmented control from ProgramsView.renderProgramExercises.
// If the template changes in programs-view.js, update this file too.
// These tests pin the 2026-08-10 editor round's discoverability contract:
//   - the control shows BOTH modes at once and marks the CURRENT one selected,
//     replacing the old single button whose label was the mode you'd switch TO
//     ("Range" while the set was single), which read as a value, not a mode;
//   - re-picking the already-selected mode is a no-op, so both options carry
//     data-mode and the handler compares it against the set's state;
//   - the per-card "Each set can be a single target or a range." caption is
//     gone: the two visible options say the same thing without costing a line
//     of height in every exercise card.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Reproduce the mode-toggle fragment from programs-view.js.
function modeSegHTML(setRow, si = 0, index = 0) {
    const isSingle = setRow.repsMin === setRow.repsMax;
    const modeOpt = (mode, label, on) => `
                        <button type="button" class="pex-mode-opt${on ? ' is-on' : ''}"
                            data-action="toggle-rep-range"
                            data-mode="${mode}"
                            data-exercise-index="${index}"
                            data-set-index="${si}"
                            aria-pressed="${on ? 'true' : 'false'}"
                            aria-label="Set ${si + 1}: ${mode === 'single' ? 'single rep target' : 'rep range'}"
                            title="Set ${si + 1}: ${mode === 'single' ? 'single rep target' : 'rep range'}">${label}</button>`;
    return `
                    <span class="pex-mode-seg" role="group" aria-label="Set ${si + 1} rep mode">
                        ${modeOpt('single', 'Single', isSingle)}
                        ${modeOpt('range', 'Range', !isSingle)}
                    </span>`;
}

// Reproduce the per-exercise sets block wrapper from programs-view.js.
function setsBlockHTML(sets) {
    const rows = sets.map((setRow, si) => `
                <div class="pex-set-row" data-set-index="${si}">
                    <span class="pex-set-label">Set ${si + 1}</span>
                    ${modeSegHTML(setRow, si)}
                </div>`).join('');
    return `
        <div class="pex-sets-block">
            ${rows}
        </div>
        <button type="button" class="pex-add-set-btn" data-action="add-set-row">
            <i class="fas fa-plus" aria-hidden="true"></i> Add set
        </button>`;
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

// -------------------------------------------------------
// The per-card helper caption is gone
// -------------------------------------------------------

test('sets block: no per-exercise range hint caption is rendered', () => {
    const html = setsBlockHTML([
        { repsMin: 10, repsMax: 10 },
        { repsMin: 10, repsMax: 10 },
        { repsMin: 10, repsMax: 10 },
    ]);
    assert.ok(!html.includes('pex-range-hint'), 'the hint element is gone');
    assert.ok(
        !html.includes('Each set can be a single target or a range.'),
        'the hint sentence is gone; the segmented control states both options'
    );
});

test('sets block: "+ Add set" follows the set rows instead of sitting in a header', () => {
    const html = setsBlockHTML([{ repsMin: 5, repsMax: 5 }, { repsMin: 5, repsMax: 5 }]);
    const lastRowIdx = html.lastIndexOf('pex-set-row');
    const addSetIdx = html.indexOf('pex-add-set-btn');
    assert.ok(lastRowIdx !== -1, 'set rows are present');
    assert.ok(addSetIdx !== -1, 'add-set button is present');
    assert.ok(addSetIdx > lastRowIdx, 'add-set comes after the last set row');
    assert.ok(!html.includes('pex-sets-header'), 'the old sets header no longer exists');
});
