// Mirror of the range-toggle and hint markup from ProgramsView.renderProgramExercises.
// If the template changes in programs-view.js, update this file too.
// These tests assert the discoverability improvements added 2026-06-04:
//   - .pex-range-toggle-label shows "Range" for single sets and "Single" for ranges.
//   - .pex-range-hint caption is rendered once per exercise, below the sets header.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Reproduce the set-row HTML fragment (only the toggle portion) from programs-view.js.
function setRowHTML(setRow) {
    const isSingle = setRow.repsMin === setRow.repsMax;
    return `
        <button type="button" class="pex-range-toggle${isSingle ? '' : ' is-on'}"
            data-action="toggle-rep-range"
            title="${isSingle ? 'Add rep range' : 'Remove rep range'}"
            aria-label="${isSingle ? 'Add rep range' : 'Remove rep range'}">
            <i class="fas ${isSingle ? 'fa-arrows-left-right' : 'fa-minus'}"></i>
            <span class="pex-range-toggle-label">${isSingle ? 'Range' : 'Single'}</span>
        </button>`;
}

// Reproduce the per-exercise sets block wrapper from programs-view.js.
function setsBlockHTML(sets) {
    const setRowsHTML = sets.map(setRow => setRowHTML(setRow)).join('');
    return `
        <div class="pex-sets-block">
            <div class="pex-sets-header">
                <span class="pex-stepper-label">Sets / Reps</span>
                <button type="button" class="pex-add-set-btn" data-action="add-set-row">
                    <i class="fas fa-plus"></i> Add set
                </button>
            </div>
            <p class="pex-range-hint">Each set can be a single target or a range.</p>
            <div class="pex-set-rows">
                ${setRowsHTML}
            </div>
        </div>`;
}

// -------------------------------------------------------
// Range toggle label: single set
// -------------------------------------------------------

test('pex-range-toggle-label: shows "Range" for a single-value set (repsMin === repsMax)', () => {
    const html = setRowHTML({ repsMin: 10, repsMax: 10 });
    assert.ok(html.includes('class="pex-range-toggle-label"'), 'label span is present');
    assert.ok(html.includes('>Range<'), 'label text is "Range"');
    assert.ok(!html.includes('>Single<'), 'label text is not "Single"');
});

test('pex-range-toggle: has no "is-on" class for a single-value set', () => {
    const html = setRowHTML({ repsMin: 8, repsMax: 8 });
    assert.ok(!html.includes('is-on'), 'is-on class absent for single set');
});

// -------------------------------------------------------
// Range toggle label: range set
// -------------------------------------------------------

test('pex-range-toggle-label: shows "Single" for a range set (repsMin !== repsMax)', () => {
    const html = setRowHTML({ repsMin: 8, repsMax: 12 });
    assert.ok(html.includes('class="pex-range-toggle-label"'), 'label span is present');
    assert.ok(html.includes('>Single<'), 'label text is "Single"');
    assert.ok(!html.includes('>Range<'), 'label text is not "Range"');
});

test('pex-range-toggle: has "is-on" class for a range set', () => {
    const html = setRowHTML({ repsMin: 6, repsMax: 10 });
    assert.ok(html.includes('pex-range-toggle is-on'), 'is-on class present for range set');
});

// -------------------------------------------------------
// Per-exercise hint caption
// -------------------------------------------------------

test('pex-range-hint: rendered once per exercise, below the sets header', () => {
    const sets = [
        { repsMin: 10, repsMax: 10 },
        { repsMin: 10, repsMax: 10 },
        { repsMin: 10, repsMax: 10 },
    ];
    const html = setsBlockHTML(sets);

    // Appears exactly once per exercise block
    const matches = [...html.matchAll(/class="pex-range-hint"/g)];
    assert.equal(matches.length, 1, 'hint appears exactly once per exercise');

    // Contains expected text (no em dashes)
    assert.ok(
        html.includes('Each set can be a single target or a range.'),
        'hint text is correct and contains no em dashes'
    );
});

test('pex-range-hint: is inside pex-sets-block, after pex-sets-header', () => {
    const html = setsBlockHTML([{ repsMin: 5, repsMax: 5 }]);
    const headerIdx = html.indexOf('pex-sets-header');
    const hintIdx = html.indexOf('pex-range-hint');
    assert.ok(headerIdx !== -1, 'pex-sets-header present');
    assert.ok(hintIdx !== -1, 'pex-range-hint present');
    assert.ok(hintIdx > headerIdx, 'hint appears after the sets header');
});
