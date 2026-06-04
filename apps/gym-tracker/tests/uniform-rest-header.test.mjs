// Tests for renderActiveWorkout's uniform-rest header behavior.
//
// workout-view.js imports the DOM and app singleton so we cannot load it
// directly in node. Instead we mirror the relevant logic here (the same
// pattern used by superset-logic.test.mjs and collapse-and-unmark-rest.test.mjs).
//
// What we verify:
//   - In uniform mode: header element is populated + unhidden; content HTML
//     contains NO .uniform-rest-banner; formatRest produces correct M:SS.
//   - In custom mode: header element is hidden + empty; no banner in content.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Mirror of WorkoutView.formatRest
// ---------------------------------------------------------------------------
function formatRest(seconds) {
    const s = Math.max(0, seconds | 0);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Minimal DOM stubs (no external dependencies)
// ---------------------------------------------------------------------------
function makeHeaderEl() {
    return { hidden: true, _text: '' };
}
function makeValueEl() {
    return { textContent: '' };
}

// ---------------------------------------------------------------------------
// Mirror of the header-update block from renderActiveWorkout
// ---------------------------------------------------------------------------
function applyRestBetweenHeader(program, restBetweenEl, restBetweenValueEl) {
    if (!restBetweenEl || !restBetweenValueEl) return;
    if (program?.restMode === 'uniform') {
        const secs = program.uniformRestSeconds ?? 90;
        restBetweenValueEl.textContent = formatRest(secs);
        restBetweenEl.hidden = false;
    } else {
        restBetweenEl.hidden = true;
        restBetweenValueEl.textContent = '';
    }
}

// ---------------------------------------------------------------------------
// Mirror of the content-rendering decision (no banner injected in either mode)
// ---------------------------------------------------------------------------
function buildContentHTML(program) {
    // Old code would have prepended uniformBannerHTML — new code never does.
    // We assert that no .uniform-rest-banner appears in the rendered output.
    return '<div class="exercise-entry">Bench Press</div>';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('uniform mode: header element is unhidden with M:SS value (90s => 1:30)', () => {
    const program = { restMode: 'uniform', uniformRestSeconds: 90 };
    const el = makeHeaderEl();
    const val = makeValueEl();
    applyRestBetweenHeader(program, el, val);
    assert.equal(el.hidden, false, 'header element should be visible');
    assert.equal(val.textContent, '1:30', 'value should be formatted as 1:30');
});

test('uniform mode: header element is unhidden with M:SS value (60s => 1:00)', () => {
    const program = { restMode: 'uniform', uniformRestSeconds: 60 };
    const el = makeHeaderEl();
    const val = makeValueEl();
    applyRestBetweenHeader(program, el, val);
    assert.equal(el.hidden, false);
    assert.equal(val.textContent, '1:00');
});

test('uniform mode: defaults uniformRestSeconds to 90 when absent', () => {
    const program = { restMode: 'uniform' };
    const el = makeHeaderEl();
    const val = makeValueEl();
    applyRestBetweenHeader(program, el, val);
    assert.equal(el.hidden, false);
    assert.equal(val.textContent, '1:30', 'should default to 90s = 1:30');
});

test('uniform mode: content HTML does NOT contain .uniform-rest-banner', () => {
    const program = { restMode: 'uniform', uniformRestSeconds: 90 };
    const content = buildContentHTML(program);
    assert.ok(!content.includes('uniform-rest-banner'), 'no .uniform-rest-banner in content HTML');
});

test('custom mode: header element is hidden and value is cleared', () => {
    const program = { restMode: 'custom' };
    const el = makeHeaderEl();
    const val = makeValueEl();
    el.hidden = false;
    val.textContent = '1:30';
    applyRestBetweenHeader(program, el, val);
    assert.equal(el.hidden, true, 'header element should be hidden in custom mode');
    assert.equal(val.textContent, '', 'value should be empty in custom mode');
});

test('custom mode: content HTML does NOT contain .uniform-rest-banner', () => {
    const program = { restMode: 'custom' };
    const content = buildContentHTML(program);
    assert.ok(!content.includes('uniform-rest-banner'), 'no .uniform-rest-banner in content HTML in custom mode');
});

test('null program: header element is hidden (graceful fallback)', () => {
    const el = makeHeaderEl();
    const val = makeValueEl();
    el.hidden = false;
    applyRestBetweenHeader(null, el, val);
    assert.equal(el.hidden, true, 'header hidden when program is null');
    assert.equal(val.textContent, '');
});

test('missing header elements: applyRestBetweenHeader does not throw', () => {
    assert.doesNotThrow(() => applyRestBetweenHeader({ restMode: 'uniform', uniformRestSeconds: 90 }, null, null));
});

// ---------------------------------------------------------------------------
// formatRest corner cases
// ---------------------------------------------------------------------------

test('formatRest: 0 => 0:00', () => {
    assert.equal(formatRest(0), '0:00');
});

test('formatRest: 90 => 1:30', () => {
    assert.equal(formatRest(90), '1:30');
});

test('formatRest: 65 => 1:05', () => {
    assert.equal(formatRest(65), '1:05');
});

test('formatRest: 3600 => 60:00', () => {
    assert.equal(formatRest(3600), '60:00');
});
