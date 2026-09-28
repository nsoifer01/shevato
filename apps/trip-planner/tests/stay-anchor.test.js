'use strict';

// Which stays are resolved on load, whatever the itinerary's ratings switch
// says (trip-logic.js stayNeedsAnchor, owner decision 2026-09-28).
//
// Ratings on Timeline and Days are opt-in, but a stay's point anchors every
// distance on its days, and the free geocoders can put a typed hotel on a
// province centroid. So a stay with no usable saved point is looked up on
// load. This pins the "no usable saved point" half: anything else asked here
// is a billed Place Details call on every page load of every trip.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

const NOW = 1790000000000;
const KO_PHI_PHI = { lat: 7.7407, lon: 98.7784 };
const stay = (over = {}) => ({ id: 's1', type: 'stay', title: 'ChaoKoh Hotel', location: 'Ko Phi Phi', status: 'booked', ...over });
const rec = (over = {}) => ({ id: 'PID_CHAOKOH', at: NOW - 86400000, lat: 7.7431, lon: 98.7722, ...over });

test('a typed stay with no saved place needs an anchor', () => {
  assert.equal(L.stayNeedsAnchor(stay(), { now: NOW }), true);
});

test('a stay whose saved place carries a fresh point does not: no billed call on load', () => {
  assert.equal(L.stayNeedsAnchor(stay({ place: rec() }), { now: NOW }), false);
  assert.equal(L.stayNeedsAnchor(stay({ place: rec() }), { now: NOW, cityPoint: KO_PHI_PHI }), false,
    'a point inside its own city is kept');
});

test('a saved point past the 29-day coordinate window needs re-anchoring (the ID alone places nothing)', () => {
  const aged = rec({ at: NOW - L.PLACE_RECORD_TTL_MS - 1000 });
  assert.equal(L.stayNeedsAnchor(stay({ place: aged }), { now: NOW }), true);
  const young = rec({ at: NOW - L.PLACE_RECORD_TTL_MS + 3600000 });
  assert.equal(L.stayNeedsAnchor(stay({ place: young }), { now: NOW }), false);
});

test('a saved place with an identity but no point needs an anchor', () => {
  assert.equal(L.stayNeedsAnchor(stay({ place: { id: 'PID_CHAOKOH', at: NOW } }), { now: NOW }), true);
});

test('a saved point its own city refuses is treated as no point, exactly as every read treats it', () => {
  const hokkaido = rec({ lat: 42.78, lon: 141.68 });
  assert.equal(L.stayNeedsAnchor(stay({ place: hokkaido }), { now: NOW, cityPoint: KO_PHI_PHI }), true);
});

test('only stays: activities, meals, legs and notes are never anchored on load', () => {
  for (const type of ['activity', 'food', 'flight', 'transport', 'local', 'note']) {
    assert.equal(L.stayNeedsAnchor({ id: 'x', type, title: 'Mango Garden', location: 'Ko Phi Phi' }, { now: NOW }), false, type);
  }
});

test('a cancelled stay is never anchored: nobody is sleeping there', () => {
  assert.equal(L.stayNeedsAnchor(stay({ status: 'cancelled' }), { now: NOW }), false);
});

test('junk in, false out', () => {
  for (const v of [null, undefined, 0, '', 'stay', []]) assert.equal(L.stayNeedsAnchor(v, { now: NOW }), false);
  assert.equal(L.stayNeedsAnchor(stay({ place: 'garbage' }), { now: NOW }), true, 'an unreadable record is no point');
});
