'use strict';

// The modal action row, pinned in both directions.
//
// The utility buttons (share / permalink / IMDb / TVDB) have moved twice: out
// of the heading on 2026-08-23, back into it on 2026-09-07. The move out also
// broke something nothing noticed for two weeks - the accent rules that make
// the primary action look primary were scoped to a `.modal-actions` wrapper
// that the same change deleted, so `+ Add to compare` silently rendered as one
// more plain button. Both halves are asserted here: where the buttons live in
// the markup, and that the CSS hierarchy rules are scoped to the class that
// actually wraps them. A screenshot catches this only if someone looks.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const APP_DIR = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(APP_DIR, 'css', 'styles.css'), 'utf8');

const ACTIONS_CLASS = 'modal-primary-actions';

// The `<div class="modal-primary-actions">…</div>` block for a given modal:
// found by locating the modal's wrapper id, then the first action row after it.
function actionRowFor(modalId) {
  const modalAt = HTML.indexOf(`id="${modalId}"`);
  assert.notEqual(modalAt, -1, `index.html has no #${modalId}`);
  const rowAt = HTML.indexOf(`class="${ACTIONS_CLASS}"`, modalAt);
  assert.notEqual(rowAt, -1, `#${modalId} has no .${ACTIONS_CLASS} row`);
  const end = HTML.indexOf('</div>', rowAt);
  assert.notEqual(end, -1, `.${ACTIONS_CLASS} in #${modalId} is unterminated`);
  return HTML.slice(rowAt, end);
}

test('show modal: every action sits in the one row beside the heading', () => {
  const row = actionRowFor('showModal');
  for (const id of [
    'showModalCompare', 'showModalShareCard', 'showModalShareChart',
    'showModalPermalink', 'showModalImdb', 'showModalTvdb',
  ]) {
    assert.ok(row.includes(`id="${id}"`), `${id} is not in the show modal's action row`);
  }
});

test('season modal: every action sits in the one row beside the heading', () => {
  const row = actionRowFor('detailModal');
  for (const id of ['modalViewShow', 'modalWatchBtn', 'modalShareCard', 'modalImdb', 'modalTvdb']) {
    assert.ok(row.includes(`id="${id}"`), `${id} is not in the season modal's action row`);
  }
});

test('the primary action leads its row: accent rules are scoped to the live wrapper', () => {
  // Not "the rules exist" - they existed while doing nothing. They have to name
  // the class the buttons are actually inside.
  for (const btn of ['compare-btn', 'watch-btn']) {
    assert.ok(
      CSS.includes(`.${ACTIONS_CLASS} .${btn}`),
      `.${btn} has no accent rule scoped to .${ACTIONS_CLASS}, so the primary action renders as a plain button`,
    );
  }
});

test('the group is a local variant: the shared .btn-ghost primitive is untouched', () => {
  // The modal group is restyled entirely through `.modal-primary-actions ...`
  // rules. If someone ever "fixes" it by editing the shared primitive instead,
  // every ghost button on the site changes with it - the toolbar, the pager,
  // the compare overlay. The shared rule's own declaration is the tripwire.
  const shared = CSS.slice(CSS.indexOf('\n.btn-ghost,'));
  const block = shared.slice(0, shared.indexOf('}'));
  assert.match(block, /background:\s*transparent/,
    'shared .btn-ghost is no longer transparent, so the modal restyle leaked out of its scope');
});

test('the permalink arrow is decorative, so the accessible name stays "Permalink"', () => {
  const row = actionRowFor('showModal');
  const link = row.slice(row.indexOf('id="showModalPermalink"'));
  assert.match(link.slice(0, link.indexOf('</a>')), /class="btn-arrow"[^>]*aria-hidden="true"/,
    'the arrow must be aria-hidden, or screen readers read "Permalink right arrow"');
});

test('the retired action-row classes are gone from both files', () => {
  // `modal-actions-top` outlived its markup by two weeks; these are the names
  // that would quietly resurrect a second row.
  for (const dead of ['modal-actions-top', 'modal-actions-bottom', 'modal-imdb']) {
    assert.ok(!HTML.includes(dead), `index.html still references the retired class ${dead}`);
    assert.ok(!CSS.includes(`.${dead}`), `styles.css still defines the retired class .${dead}`);
  }
});
