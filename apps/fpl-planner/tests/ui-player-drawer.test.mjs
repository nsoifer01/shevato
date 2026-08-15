// The drawer's season-totals heading.
//
// Which season a player's totals describe is decided by seasonEvidence() in
// js/engine/minutes.js, never assumed from the date: before FPL clears the
// element totals they are LAST season's, and a drawer captioned "Season so
// far" over last season's numbers in August is the app stating something
// untrue. seasonTotalsLabel() is the one place that classification is worded
// for the drawer, so its mapping over the whole evidence enum is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seasonTotalsLabel } from '../js/ui/player-drawer.js';

// The three kinds seasonEvidence() can return (see js/engine/minutes.js and
// tests/season-rollover.test.mjs, which drives all three out of real payload
// states). If a fourth kind ever appears, the exhaustiveness test below is the
// one that must be extended WITH a wording decision, not around one.
const EVIDENCE_KINDS = ['previous-season', 'current-season', 'none'];

test('totals still carrying last season are captioned as last season', () => {
  assert.equal(seasonTotalsLabel({ kind: 'previous-season' }), 'Last season');
});

test('totals belonging to the running season are the season so far', () => {
  assert.equal(seasonTotalsLabel({ kind: 'current-season' }), 'Season so far');
});

test('a payload with no evidence says the totals are not published, not zero', () => {
  // Zeroed totals rendered under "Season so far" would read as "this player
  // has done nothing", which is the collapse the rollover guard exists for.
  assert.equal(seasonTotalsLabel({ kind: 'none' }), 'Season totals (not published yet)');
});

test('absent evidence falls back to the in-season wording rather than crashing', () => {
  // Callers that predate the evidence field pass nothing; the drawer keeps
  // its pre-rollover behaviour for them.
  assert.equal(seasonTotalsLabel(null), 'Season so far');
  assert.equal(seasonTotalsLabel(undefined), 'Season so far');
});

test('every evidence kind produces a caption, and the three are distinct', () => {
  const labels = EVIDENCE_KINDS.map(kind => seasonTotalsLabel({ kind }));
  for (const label of labels) {
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0);
  }
  assert.equal(new Set(labels).size, EVIDENCE_KINDS.length,
    'two evidence states sharing one caption would hide the classification from the reader');
});

test('an unknown kind degrades to the default caption instead of throwing', () => {
  assert.equal(seasonTotalsLabel({ kind: 'something-new' }), 'Season so far');
});
