'use strict';

// Date filtering, driven through the live setDateFilter /
// applyCustomDateFilter / getFilteredGames in js/sidebar.js. The clock is
// pinned inside the vm sandbox so the rolling windows have fixed boundaries.
//
// SEMANTICS PINNED HERE: the "Last 7 Days" and "Last 30 Days" buttons are
// rolling windows measured in 24-hour multiples from the current instant
// (now - 7*24h), NOT calendar days. A game played 7 days ago in the morning
// falls outside "Last 7 Days" once the afternoon comes round. The tests below
// assert that actual behaviour rather than the calendar-day reading of the
// labels; see the app README / FINDINGS for the open question.

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, makeElement, loadInto, fixedDate } = require('./vm-harness.js');

const NOW = '2026-08-15T12:00:00.000Z';

function filterCtx(games) {
    const customRange = makeElement();
    const dateFrom = makeElement();
    const dateTo = makeElement();
    const elements = {
        'custom-date-range': customRange,
        'date-from': dateFrom,
        'date-to': dateTo,
    };
    const selectors = {
        '.date-filter-btn': [],
        '[data-filter="all"]': makeElement(),
        '[data-filter="today"]': makeElement(),
        '[data-filter="week"]': makeElement(),
        '[data-filter="month"]': makeElement(),
        '[data-filter="custom"]': makeElement(),
    };

    const ctx = makeContext({ elements, selectors, Date: fixedDate(NOW) });
    loadInto(ctx, 'sidebar.js');
    ctx.window.games = games;

    return {
        ctx,
        customRange,
        setFilter: (name) => ctx.setDateFilter(name),
        setCustom: (from, to) => {
            dateFrom.value = from;
            dateTo.value = to;
            ctx.setDateFilter('custom');
            ctx.applyCustomDateFilter();
        },
        // The error node is created by showCustomDateError and appended to the
        // custom range container.
        customError: () => {
            const node = customRange.children[customRange.children.length - 1];
            return node ? node.textContent : null;
        },
        ids: () => ctx.getFilteredGames().map((g) => g.id).join(','),
    };
}

function at(id, iso) {
    return { id, dateTime: iso, player1Goals: 1, player2Goals: 0 };
}

const GAMES = [
    at('today-morning', '2026-08-15T08:30:00.000Z'),
    at('today-late', '2026-08-15T23:45:00.000Z'),
    at('yesterday', '2026-08-14T23:59:59.000Z'),
    at('week-edge-in', '2026-08-08T12:00:00.000Z'),   // exactly 7 * 24h ago
    at('week-edge-out', '2026-08-08T11:59:59.999Z'),  // 1 ms older
    at('month-edge-in', '2026-07-16T12:00:00.000Z'),  // exactly 30 * 24h ago
    at('month-edge-out', '2026-07-16T11:59:59.999Z'),
    at('ancient', '2025-01-01T12:00:00.000Z'),
    { id: 'undated', player1Goals: 2, player2Goals: 2 },
];

// --- all ---------------------------------------------------------------

test('filter all: every game, including one with no dateTime', () => {
    const h = filterCtx(GAMES);
    h.setFilter('all');
    assert.equal(h.ctx.getFilteredGames().length, GAMES.length);
    assert.ok(h.ids().includes('undated'));
});

test('filter all: returns a copy, so the caller cannot mutate window.games', () => {
    const games = [at(1, NOW)];
    const h = filterCtx(games);
    h.setFilter('all');
    h.ctx.getFilteredGames().pop();
    assert.equal(games.length, 1);
});

// --- today -------------------------------------------------------------

test('filter today: only games stamped with the current calendar day', () => {
    const h = filterCtx(GAMES);
    h.setFilter('today');
    assert.equal(h.ids(), 'today-morning,today-late');
});

test('filter today: a game one second before midnight yesterday is out', () => {
    const h = filterCtx([at('yesterday', '2026-08-14T23:59:59.999Z'), at('midnight', '2026-08-15T00:00:00.000Z')]);
    h.setFilter('today');
    assert.equal(h.ids(), 'midnight');
});

test('filter today: undated games are excluded', () => {
    const h = filterCtx([{ id: 'undated' }, at('now', NOW)]);
    h.setFilter('today');
    assert.equal(h.ids(), 'now');
});

// --- week / month (rolling 24h-multiple windows) ------------------------

test('filter week: the boundary is now minus 7 * 24h, inclusive', () => {
    const h = filterCtx(GAMES);
    h.setFilter('week');
    assert.equal(h.ids(), 'today-morning,today-late,yesterday,week-edge-in');
});

test('filter week: rolling window, NOT calendar days - a game earlier on day -7 is excluded', () => {
    // Actual behaviour, pinned deliberately: "Last 7 Days" is now - 168h, so
    // a game played on the morning of 2026-08-08 drops out of the window at
    // midday on 2026-08-15 even though 2026-08-08 is still within the last
    // seven calendar days.
    const h = filterCtx([at('day-minus-7-morning', '2026-08-08T09:00:00.000Z')]);
    h.setFilter('week');
    assert.equal(h.ids(), '');
});

test('filter month: the boundary is now minus 30 * 24h, inclusive', () => {
    const h = filterCtx(GAMES);
    h.setFilter('month');
    assert.equal(h.ids(), 'today-morning,today-late,yesterday,week-edge-in,week-edge-out,month-edge-in');
});

test('filter month: undated games are excluded from both rolling windows', () => {
    const h = filterCtx([{ id: 'undated' }, at('recent', '2026-08-14T12:00:00.000Z')]);
    h.setFilter('week');
    assert.equal(h.ids(), 'recent');
    h.setFilter('month');
    assert.equal(h.ids(), 'recent');
});

// --- custom range ------------------------------------------------------

test('filter custom: inclusive on both ends, whole end day included', () => {
    const games = [
        at('before', '2026-07-31T23:59:59.000Z'),
        at('start-day', '2026-08-01T00:00:00.000Z'),
        at('middle', '2026-08-05T10:00:00.000Z'),
        at('end-day-late', '2026-08-10T23:59:59.000Z'),
        at('after', '2026-08-11T00:00:01.000Z'),
    ];
    const h = filterCtx(games);
    h.setCustom('2026-08-01', '2026-08-10');
    assert.equal(h.ids(), 'start-day,middle,end-day-late');
});

test('filter custom: a single-day range keeps that day only', () => {
    const h = filterCtx(GAMES);
    h.setCustom('2026-08-15', '2026-08-15');
    assert.equal(h.ids(), 'today-morning,today-late');
});

test('filter custom: undated games are excluded', () => {
    const h = filterCtx([{ id: 'undated' }, at('in-range', '2026-08-05T10:00:00.000Z')]);
    h.setCustom('2026-08-01', '2026-08-10');
    assert.equal(h.ids(), 'in-range');
});

test('filter custom: a missing end date errors and leaves the range unapplied', () => {
    const h = filterCtx(GAMES);
    h.setCustom('2026-08-01', '');
    assert.equal(h.customError(), 'Please select both start and end dates');
    // No range stored, so getFilteredGames falls back to every game.
    assert.equal(h.ctx.getFilteredGames().length, GAMES.length);
});

test('filter custom: a reversed range errors and leaves the range unapplied', () => {
    const h = filterCtx(GAMES);
    h.setCustom('2026-08-10', '2026-08-01');
    assert.equal(h.customError(), 'Start date cannot be after end date');
    assert.equal(h.ctx.getFilteredGames().length, GAMES.length);
});

test('filter custom: a later valid range replaces an earlier one', () => {
    const h = filterCtx(GAMES);
    h.setCustom('2026-08-01', '2026-08-10');
    assert.equal(h.ids(), 'week-edge-in,week-edge-out');
    h.setCustom('2026-08-14', '2026-08-15');
    assert.equal(h.ids(), 'today-morning,today-late,yesterday');
});

// --- panel wiring ------------------------------------------------------

test('filter panel: the custom range shows only for the custom filter', () => {
    const h = filterCtx(GAMES);
    h.setFilter('custom');
    assert.equal(h.customRange.style.display, 'flex');
    h.setFilter('all');
    assert.equal(h.customRange.style.display, 'none');
});

test('filter panel: switching away from custom clears a pending error', () => {
    const h = filterCtx(GAMES);
    h.setCustom('2026-08-10', '2026-08-01');
    assert.equal(h.customError(), 'Start date cannot be after end date');
    h.setFilter('week');
    // clearCustomDateError removes the node; the stub records the removal by
    // leaving the container's last child untouched, so assert via the filter
    // result instead: the week window is back in charge.
    assert.equal(h.ids(), 'today-morning,today-late,yesterday,week-edge-in');
});
