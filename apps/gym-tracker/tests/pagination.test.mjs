import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makePaginatorState,
    paginatorInfo,
    paginatorHTML,
    pageWindowSequence,
} from '../js/utils/paginator.js';

// ── makePaginatorState ────────────────────────────────────────────────────────

test('makePaginatorState: starts at page 1 with given page size', () => {
    const state = makePaginatorState(15);
    assert.equal(state.page, 1);
    assert.equal(state.pageSize, 15);
});

// ── paginatorInfo: zero items ─────────────────────────────────────────────────

test('paginatorInfo: 0 items yields pageCount 1, empty slice', () => {
    const state = makePaginatorState(15);
    const info = paginatorInfo(state, 0);
    assert.equal(info.pageCount, 1);
    assert.equal(info.page, 1);
    assert.equal(info.start, 0);
    assert.equal(info.end, 0);
});

// ── paginatorInfo: exactly page-size items ────────────────────────────────────

test('paginatorInfo: exactly page-size items fills one page', () => {
    const state = makePaginatorState(15);
    const info = paginatorInfo(state, 15);
    assert.equal(info.pageCount, 1);
    assert.equal(info.page, 1);
    assert.equal(info.start, 0);
    assert.equal(info.end, 15);
});

// ── paginatorInfo: page-size + 1 items spills to page 2 ──────────────────────

test('paginatorInfo: page-size+1 items creates 2 pages', () => {
    const state = makePaginatorState(15);
    const info = paginatorInfo(state, 16);
    assert.equal(info.pageCount, 2);
    assert.equal(info.page, 1);
    assert.equal(info.start, 0);
    assert.equal(info.end, 15);
});

test('paginatorInfo: page 2 of 16 items yields the one remaining item', () => {
    const state = makePaginatorState(15);
    state.page = 2;
    const info = paginatorInfo(state, 16);
    assert.equal(info.pageCount, 2);
    assert.equal(info.page, 2);
    assert.equal(info.start, 15);
    assert.equal(info.end, 16);
});

// ── paginatorInfo: page math for larger sets ──────────────────────────────────

test('paginatorInfo: 513 exercises at page size 15 yields 35 pages', () => {
    const state = makePaginatorState(15);
    const info = paginatorInfo(state, 513);
    assert.equal(info.pageCount, 35);
    assert.equal(info.start, 0);
    assert.equal(info.end, 15);
});

test('paginatorInfo: last page of 513 exercises has 3 items', () => {
    const state = makePaginatorState(15);
    state.page = 35;
    const info = paginatorInfo(state, 513);
    assert.equal(info.page, 35);
    assert.equal(info.start, 510);
    assert.equal(info.end, 513);
});

// ── paginatorInfo: boundary clamping ─────────────────────────────────────────

test('paginatorInfo: page beyond last is clamped to last page', () => {
    const state = makePaginatorState(15);
    state.page = 999;
    const info = paginatorInfo(state, 30);
    assert.equal(info.page, 2);
    assert.equal(info.pageCount, 2);
});

test('paginatorInfo: page 0 is clamped to 1', () => {
    const state = makePaginatorState(15);
    state.page = 0;
    const info = paginatorInfo(state, 30);
    assert.equal(info.page, 1);
});

// ── filter-reset behavior ─────────────────────────────────────────────────────

test('filter-reset: resetting page to 1 after filtering returns correct first slice', () => {
    const state = makePaginatorState(15);
    // User was on page 3
    state.page = 3;
    // Filter changes, total shrinks to 18 items, caller resets page
    state.page = 1;
    const info = paginatorInfo(state, 18);
    assert.equal(info.page, 1);
    assert.equal(info.pageCount, 2);
    assert.equal(info.start, 0);
    assert.equal(info.end, 15);
});

// ── paginatorHTML: single page hides controls ─────────────────────────────────

test('paginatorHTML: returns empty string when pageCount is 1', () => {
    const info = { page: 1, pageCount: 1 };
    assert.equal(paginatorHTML(info, 'prev', 'next', 'lbl'), '');
});

test('paginatorHTML: returns empty string when pageCount is 0', () => {
    const info = { page: 1, pageCount: 0 };
    assert.equal(paginatorHTML(info, 'prev', 'next', 'lbl'), '');
});

// ── paginatorHTML: multi-page controls ───────────────────────────────────────

test('paginatorHTML: Prev is disabled on first page', () => {
    const info = { page: 1, pageCount: 3 };
    const html = paginatorHTML(info, 'prev', 'next', 'lbl');
    assert.ok(html.includes('id="prev"'));
    assert.ok(html.includes('disabled'));
    // Next should NOT be disabled
    assert.ok(!html.includes('id="next"') || !html.match(/id="next"[^>]*disabled/));
});

test('paginatorHTML: Next is disabled on last page', () => {
    const info = { page: 3, pageCount: 3 };
    const html = paginatorHTML(info, 'prev', 'next', 'lbl');
    assert.ok(html.includes('id="next"'));
    // The next button string should contain disabled
    const nextMatch = html.match(/id="next"[^>]*>/)?.[0] || '';
    assert.ok(nextMatch.includes('disabled') || html.includes('aria-disabled="true"'));
});

test('paginatorHTML: middle page has neither Prev nor Next disabled', () => {
    const info = { page: 2, pageCount: 3 };
    const html = paginatorHTML(info, 'prev', 'next', 'lbl');
    // Split on button boundaries to check each independently
    const prevIdx = html.indexOf('id="prev"');
    const nextIdx = html.indexOf('id="next"');
    const prevChunk = html.slice(prevIdx, prevIdx + 80);
    const nextChunk = html.slice(nextIdx, nextIdx + 80);
    assert.ok(!prevChunk.includes('disabled'));
    assert.ok(!nextChunk.includes('disabled'));
});

test('paginatorHTML: label contains correct page numbers', () => {
    const info = { page: 2, pageCount: 5 };
    const html = paginatorHTML(info, 'prev', 'next', 'lbl');
    assert.ok(html.includes('Page 2 of 5'));
});

// ── pageWindowSequence ────────────────────────────────────────────────────────

test('pageWindowSequence: 1 page returns empty array', () => {
    assert.deepEqual(pageWindowSequence(1, 1), []);
});

test('pageWindowSequence: 0 pages returns empty array', () => {
    assert.deepEqual(pageWindowSequence(1, 0), []);
});

test('pageWindowSequence: 2 pages, no ellipsis', () => {
    assert.deepEqual(pageWindowSequence(1, 2), [1, 2]);
});

test('pageWindowSequence: 7 pages shows all without ellipsis', () => {
    assert.deepEqual(pageWindowSequence(4, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test('pageWindowSequence: 8 pages on page 1 — trailing ellipsis only', () => {
    const seq = pageWindowSequence(1, 8);
    // page 1 neighbors: 1,2 — last: 8 — gap between 2 and 8
    assert.deepEqual(seq, [1, 2, '...', 8]);
});

test('pageWindowSequence: 12 pages on page 1 — trailing ellipsis', () => {
    const seq = pageWindowSequence(1, 12);
    assert.deepEqual(seq, [1, 2, '...', 12]);
});

test('pageWindowSequence: 12 pages on page 12 — leading ellipsis', () => {
    const seq = pageWindowSequence(12, 12);
    assert.deepEqual(seq, [1, '...', 11, 12]);
});

test('pageWindowSequence: 12 pages on page 6 — both ellipses', () => {
    const seq = pageWindowSequence(6, 12);
    assert.deepEqual(seq, [1, '...', 5, 6, 7, '...', 12]);
});

test('pageWindowSequence: 12 pages on page 2 — no leading ellipsis needed', () => {
    const seq = pageWindowSequence(2, 12);
    // neighbors of 2: 1,2,3 — last: 12 — gap between 3 and 12
    assert.deepEqual(seq, [1, 2, 3, '...', 12]);
});

test('pageWindowSequence: 12 pages on page 3 — no leading ellipsis (1 gap away)', () => {
    const seq = pageWindowSequence(3, 12);
    // neighbors of 3: 2,3,4 plus 1 and 12 — 1 and 2 are adjacent, no gap
    assert.deepEqual(seq, [1, 2, 3, 4, '...', 12]);
});

test('pageWindowSequence: 12 pages on page 11 — no trailing ellipsis', () => {
    const seq = pageWindowSequence(11, 12);
    assert.deepEqual(seq, [1, '...', 10, 11, 12]);
});

test('pageWindowSequence: first and last always present for large page count', () => {
    const seq = pageWindowSequence(50, 100);
    assert.equal(seq[0], 1);
    assert.equal(seq[seq.length - 1], 100);
    assert.ok(seq.includes(49));
    assert.ok(seq.includes(50));
    assert.ok(seq.includes(51));
});

test('pageWindowSequence: current page always present', () => {
    for (const pg of [1, 5, 10, 15, 20]) {
        const seq = pageWindowSequence(pg, 20);
        assert.ok(seq.includes(pg), `page ${pg} missing from sequence`);
    }
});
