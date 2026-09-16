// A `?v=` pin must MOVE when the file it names changes.
//
// The pin is part of the service worker's cache key, so an unchanged pin over
// changed content means an installed worker keeps serving the old file from a
// key that still matches. Nothing is red while that happens: index.html and
// sw.js still agree with each other, which is all the existing parity test
// (sw-precache-completeness.test.mjs) was ever asking.
//
// It shipped. PR #550 (2026-09-15) edited app.js and trip-logic.js and left
// every pin alone; PR #551, half an hour later, was a pure pin bump with no
// logic in it. FINDINGS.md wrote the gap down at the time: "Nothing checks
// that a pin MOVED when its file changed... an edit to app.js or
// trip-logic.js with every pin left alone is green everywhere."
//
// When this fails: bump the pin in index.html AND sw.js for the file it names,
// bump TP_BUILD if it was app.js, then run
//   node apps/trip-planner/scripts/update-asset-pins.mjs
// in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePins, readManifest, tpBuild, pinInIndex, PINNED } from './helpers/asset-pins.mjs';

const UPDATE = 'node apps/trip-planner/scripts/update-asset-pins.mjs';
const now = computePins();
const recorded = readManifest();

test('the fixture still describes the files it claims to', () => {
  assert.deepEqual(Object.keys(recorded).sort(), PINNED.slice().sort(),
    `asset-pins.json and PINNED disagree about which files carry a pin. Run: ${UPDATE}`);
  for (const rel of PINNED) {
    assert.ok(Number.isInteger(now[rel].pin), `index.html declares no numeric ?v= pin for ${rel}`);
  }
});

for (const rel of PINNED) {
  test(`${rel}: its pin moved if its content did`, () => {
    const was = recorded[rel];
    const is = now[rel];
    if (is.sha256 === was.sha256) {
      // Content unchanged. The pin must not have moved either, or the fixture
      // is stale and this guard is comparing against nothing.
      assert.equal(is.pin, was.pin,
        `${rel} is byte-identical but its pin moved ${was.pin} -> ${is.pin}. Run: ${UPDATE}`);
      return;
    }
    assert.notEqual(is.pin, was.pin,
      `${rel} changed (${was.sha256} -> ${is.sha256}) but its pin is still v=${is.pin}.`
      + ` Installed service workers will keep serving the old file from a cache key that still matches.`
      + ` Bump it in index.html AND sw.js${rel === 'js/app.js' ? ' (and TP_BUILD)' : ''}, then run: ${UPDATE}`);
  });
}

test('TP_BUILD equals the pin app.js is served under', () => {
  // app.js:22 states this as THE RULE in a comment, and the UI prints it as
  // "build N" on the status panel, so a mismatch misreports which build a
  // bug report is about. Nothing enforced it until now.
  assert.equal(tpBuild(), pinInIndex('js/app.js'),
    'TP_BUILD and the ?v= on js/app.js must be the same number');
});
