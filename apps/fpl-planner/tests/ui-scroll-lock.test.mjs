// The reference-counted page scroll lock behind every modal overlay.
//
// The counting is the safety property: two overlays (or a re-entrant open)
// must not unlock each other early, and a balanced release must restore the
// body's inline styles and the scroll offset EXACTLY, because the offset the
// user left at is part of the drawer's contract (FINDINGS, "Modal overlays
// lock the page through ui/scroll-lock.js").
//
// The module keeps its count in module scope, so each test imports a FRESH
// copy via a query-string dynamic import: state cannot leak from one test
// into the next, and a test failure cannot cascade.

import { test } from 'node:test';
import assert from 'node:assert/strict';

let fresh = 0;
async function freshLock() {
  fresh += 1;
  return import(`../js/ui/scroll-lock.js?fresh=${fresh}`);
}

// The few DOM facts the lock reads and writes, in place of a layout engine:
// a scrolled window, a body with inline styles, and a scrollbar 15px wide
// (innerWidth minus documentElement.clientWidth).
function installPage({ scrollY = 480, scrollbar = 15 } = {}) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const scrolls = [];
  globalThis.window = {
    scrollY,
    pageYOffset: scrollY,
    innerWidth: 1280,
    scrollTo: (x, y) => scrolls.push([x, y]),
  };
  globalThis.document = {
    documentElement: { clientWidth: 1280 - scrollbar },
    body: { style: {} },
  };
  return {
    scrolls,
    style: () => globalThis.document.body.style,
    restore: () => {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
    },
  };
}

test('locking pins the body at the current offset and compensates the scrollbar', async () => {
  const page = installPage({ scrollY: 480, scrollbar: 15 });
  try {
    const { lockScroll, isScrollLocked } = await freshLock();
    assert.equal(isScrollLocked(), false);
    lockScroll();
    assert.equal(isScrollLocked(), true);
    const s = page.style();
    assert.equal(s.position, 'fixed');
    assert.equal(s.top, '-480px', 'pinned at the offset the user was at');
    assert.equal(s.width, '100%');
    assert.equal(s.paddingRight, '15px', 'the vanished scrollbar must not shift the page');
  } finally { page.restore(); }
});

test('a balanced lock/unlock restores the inline styles and the scroll position', async () => {
  const page = installPage({ scrollY: 731 });
  try {
    const { lockScroll, unlockScroll, isScrollLocked } = await freshLock();
    // Pre-existing inline styles are the app's, not the lock's: they come back.
    page.style().position = 'relative';
    page.style().top = '1px';
    lockScroll();
    unlockScroll();
    assert.equal(isScrollLocked(), false);
    assert.equal(page.style().position, 'relative');
    assert.equal(page.style().top, '1px');
    assert.deepEqual(page.scrolls, [[0, 731]], 'the user lands where they left');
  } finally { page.restore(); }
});

test('lock, lock, unlock leaves the page locked: the count is the contract', async () => {
  const page = installPage();
  try {
    const { lockScroll, unlockScroll, isScrollLocked } = await freshLock();
    lockScroll();
    lockScroll();
    unlockScroll();
    assert.equal(isScrollLocked(), true, 'the first holder is still holding');
    assert.equal(page.style().position, 'fixed', 'and the body is still pinned');
    assert.equal(page.scrolls.length, 0, 'no scroll restoration before the last release');
    unlockScroll();
    assert.equal(isScrollLocked(), false);
    assert.equal(page.scrolls.length, 1, 'restored exactly once');
  } finally { page.restore(); }
});

test('the second lock does not re-read the pinned page as scroll position zero', async () => {
  const page = installPage({ scrollY: 300 });
  try {
    const { lockScroll, unlockScroll } = await freshLock();
    lockScroll();
    // While pinned, a real browser reports scrollY 0; a re-entrant lock that
    // saved state again would restore to 0 and dump the user at the top.
    globalThis.window.scrollY = 0;
    globalThis.window.pageYOffset = 0;
    lockScroll();
    unlockScroll();
    unlockScroll();
    assert.deepEqual(page.scrolls, [[0, 300]], 'the offset saved is the first lock\'s');
  } finally { page.restore(); }
});

test('unlocking an unlocked page is a no-op, and cannot bank a negative count', async () => {
  const page = installPage();
  try {
    const { lockScroll, unlockScroll, isScrollLocked } = await freshLock();
    unlockScroll();
    unlockScroll();
    assert.equal(isScrollLocked(), false);
    assert.equal(page.scrolls.length, 0);
    // The stray unlocks above must not have pre-paid a later release.
    lockScroll();
    assert.equal(isScrollLocked(), true, 'a fresh lock still locks');
    unlockScroll();
    assert.equal(isScrollLocked(), false);
  } finally { page.restore(); }
});

test('no scrollbar means no padding compensation', async () => {
  const page = installPage({ scrollbar: 0 });
  try {
    const { lockScroll } = await freshLock();
    page.style().paddingRight = '';
    lockScroll();
    assert.equal(page.style().paddingRight, '', 'nothing vanished, nothing to compensate');
  } finally { page.restore(); }
});
