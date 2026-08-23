'use strict';

// assets/js/pagination.js (shared with mario-kart) had no tests. The page
// index is clamped to the item count in getPaginatedItems: a filter or
// late-page deletes used to leave currentPage past the end, rendering zero
// rows under "Showing 201-6 of 6".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const { makeContext, PAGINATION_PATH } = require('./vm-harness.js');

function paginationCtx() {
    const ctx = makeContext();
    vm.runInContext(fs.readFileSync(PAGINATION_PATH, 'utf8'), ctx, { filename: 'pagination.js' });
    return ctx.GlobalPaginationManager;
}

const items = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('pagination: the current page is clamped when the item count shrinks', () => {
    const pm = paginationCtx();
    pm.createInstance('t', { rowsPerPage: 50 });
    pm.getPaginatedItems('t', items(250));
    pm.goToPage('t', 5);
    assert.equal(pm.getState('t').currentPage, 5);

    const page = pm.getPaginatedItems('t', items(6));
    assert.equal(pm.getState('t').currentPage, 1, 'page 5 of 250 must become the last valid page of 6');
    assert.deepEqual(page, items(6), 'the rows must be rendered, not an empty slice');
    assert.ok(pm.createPaginationControls('t').includes('Showing 1-6 of 6'));
});

test('pagination: shrinking to a later but still valid page keeps the last page', () => {
    const pm = paginationCtx();
    pm.createInstance('t', { rowsPerPage: 10 });
    pm.getPaginatedItems('t', items(100));
    pm.goToPage('t', 10);
    const page = pm.getPaginatedItems('t', items(35));
    assert.equal(pm.getState('t').currentPage, 4);
    assert.deepEqual(page, [31, 32, 33, 34, 35]);
});

test('pagination: an empty list leaves page 1 and no controls', () => {
    const pm = paginationCtx();
    pm.createInstance('t', { rowsPerPage: 10 });
    pm.getPaginatedItems('t', items(30));
    pm.goToPage('t', 3);
    assert.deepEqual(pm.getPaginatedItems('t', []), []);
    assert.equal(pm.getState('t').currentPage, 1);
    assert.equal(pm.createPaginationControls('t'), '');
});
