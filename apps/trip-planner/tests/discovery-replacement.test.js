'use strict';

// DISCOVERY: a "find me places" answer may contain only VERIFIED places.
//
// The 2026-08-27 place-resolution round made an unverifiable recommendation
// SAFE - no rating, no distance, no hours, no exact-place link. This round
// makes it ABSENT: the traveller asked for three places, and a card for a venue
// the model may have invented is not one of the three. It is rejected, replaced
// from the provider, and only what survives is shown - prose included.
//
// The distinction that governs all of it:
//   DISCOVERY       "find me 3 chocolate shops" - they named nothing, so an
//                   unverifiable candidate is the model's invention. Replace it.
//   EXPLICIT PLACE  "add Royce Tokyo Station"  - they named it. Their words are
//                   the answer; keep them, marked unverified.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

// ---------- the intent split ----------

test('DISCOVERY is recognised from the traveller\'s own words', () => {
  const yes = [
    'Find me 3 good places to get Nama chocolate during my trip in Japan',
    'find me some good ramen spots',
    'Recommend two nice bars near the hotel',
    'suggest a few places for coffee',
    'where can I get good sushi',
    "what's the best museum here",
    'any good cafes around Shibuya?',
    'ideas for a rainy afternoon',
  ];
  for (const t of yes) assert.equal(L.assistDiscoveryIntent(t).discovery, true, t);
});

test('EXPLICIT PLACE requests are NOT discovery, so the words survive', () => {
  // Every one of these names a venue. Replacing it with a different business
  // would be answering a question nobody asked - which is why this list is the
  // more important half of the test.
  const no = [
    'Add Royce Tokyo Station at 2pm',
    'add Gyukatsu Motomura Shibuya on Tuesday',
    'move dinner to 8pm',
    'is Narisawa open on Monday?',
    'book the Park Hyatt for two nights',
    'what time should I leave for the airport',
  ];
  for (const t of no) assert.equal(L.assistDiscoveryIntent(t).discovery, false, t);
});

test('the requested count is read when they say one, and null when they do not', () => {
  assert.equal(L.assistDiscoveryIntent('Find me 3 good places for chocolate').count, 3);
  assert.equal(L.assistDiscoveryIntent('find me three good places for chocolate').count, 3);
  assert.equal(L.assistDiscoveryIntent('Recommend two nice bars').count, 2);
  assert.equal(L.assistDiscoveryIntent('find me some good ramen spots').count, null);
  assert.equal(L.assistDiscoveryIntent('find me 99 places').count, null, 'an absurd count is not a count');
});

test('the model may also declare the intent, and hand over the search words', () => {
  assert.deepEqual(
    L.discoveryHintFrom([{ op: 'add', discovery: { query: 'nama chocolate', count: 3 }, item: {} }]),
    { query: 'nama chocolate', count: 3 });
  assert.equal(L.discoveryHintFrom([{ op: 'add', item: {} }]), null);
  assert.equal(L.discoveryHintFrom([{ op: 'add', discovery: { query: '   ' } }]), null);
});

test('a replacement search term is derived when the model gives none', () => {
  assert.equal(
    L.discoveryQueryFrom('Find me 3 good places to get Nama chocolate during my trip in Japan', 'Tokyo'),
    'Nama chocolate Tokyo');
  assert.equal(L.discoveryQueryFrom('where can I get good ramen', 'Kyoto'), 'good ramen Kyoto');
  // the city is not doubled when the request already names it
  assert.match(L.discoveryQueryFrom('find me some ramen in Kyoto', 'Kyoto'), /^ramen/);
  // and nothing usable means no deterministic replacement is attempted
  assert.equal(L.discoveryQueryFrom('find me places', 'Tokyo'), '');
  assert.equal(L.discoveryQueryFrom('', 'Tokyo'), '');
});

// ---------- dedupe by IDENTITY ----------

const entryOf = (placeId, over = {}) => ({
  status: 'ok', placeId, verified: true, rating: 4.2, userRatingCount: 100, ...over,
});

test('DEDUPE: the same place under two names is one place', () => {
  // The exact shape this round is about: a replacement that resolves to a place
  // already recommended must be discarded, however differently it is spelled.
  const seen = new Set();
  const items = [
    { name: 'Takashimaya Kyoto Store', identity: L.placeIdentityOf(entryOf('ChIJ_kyoto'), null) },
    { name: 'Kyoto Takashimaya', identity: L.placeIdentityOf(entryOf('ChIJ_kyoto'), null) },
    { name: 'Musee Du Chocolat', identity: L.placeIdentityOf(entryOf('ChIJ_musee'), null) },
  ];
  const out = L.dedupeByIdentity(items, seen);
  assert.deepEqual(out.map(x => x.name), ['Takashimaya Kyoto Store', 'Musee Du Chocolat']);
});

test('dedupe falls back to the area-aware key when there is no place ID', () => {
  assert.equal(L.placeIdentityOf(null, { key: 'ramen nagi@tokyo' }), 'key:ramen nagi@tokyo');
  assert.equal(L.placeIdentityOf(entryOf('ChIJ_x'), { key: 'whatever@tokyo' }), 'id:ChIJ_x',
    'the resolved ID always wins: it is the identity, the key is only a question');
  assert.equal(L.placeIdentityOf(null, null), '');
});

test('a rejected candidate stays in the seen set, so it cannot come back', () => {
  const seen = new Set();
  L.dedupeByIdentity([{ name: 'rejected', identity: 'id:ChIJ_bad' }], seen);
  const again = L.dedupeByIdentity([{ name: 'replacement', identity: 'id:ChIJ_bad' }], seen);
  assert.equal(again.length, 0, 'a place we already refused is not a replacement');
});

// ---------- ranking ----------

test('RANKING: a replacement does not lead just because it resolved', () => {
  // A 4.9 from six people is not a better recommendation than a 4.4 from three
  // thousand, and the score has to say so or every obscure new cafe wins.
  const strong = L.placeQualityScore({ rating: 4.4, userRatingCount: 3000 }, 1);
  const thin = L.placeQualityScore({ rating: 4.9, userRatingCount: 6 }, 1);
  assert.ok(strong > thin, `${strong} should beat ${thin}`);
  // proximity breaks ties between comparable places
  const near = L.placeQualityScore({ rating: 4.4, userRatingCount: 500 }, 0.5);
  const far = L.placeQualityScore({ rating: 4.4, userRatingCount: 500 }, 20);
  assert.ok(near > far);
});

test('a real SCHEDULE keeps its clock order; quality only breaks ties', () => {
  // Reordering timed items by quality would scramble the day - a different bug.
  const ranked = L.rankVerifiedPlaces([
    { name: 'weak breakfast', time: '09:00', score: 1 },
    { name: 'great dinner', time: '19:00', score: 9 },
  ]);
  assert.deepEqual(ranked.map(r => r.name), ['weak breakfast', 'great dinner']);
});

test('an untimed comparison set IS ranked by quality', () => {
  const ranked = L.rankVerifiedPlaces([
    { name: 'ok', time: '', score: 2 },
    { name: 'best', time: '', score: 8 },
    { name: 'mid', time: '', score: 5 },
  ]);
  assert.deepEqual(ranked.map(r => r.name), ['best', 'mid', 'ok']);
});

// ---------- prose ----------

const PROSE = `Here are three excellent options for nama chocolate.

- Royce' Chocolate at Tokyo Station is a must-visit for the classic bars.
- Musee Du Chocolat Theobroma in Shibuya is superb.
- Pierre Marcolini Ginza has a beautiful selection.

Enjoy!`;

test('PROSE: a rejected venue does not survive in the text', () => {
  // The important one. A card silently missing while the paragraph still
  // recommends the place is WORSE than showing the card: the traveller reads a
  // confident recommendation and cannot find the thing it refers to.
  const out = L.rebuildAssistProse(PROSE, {
    kept: ['Musee Du Chocolat Theobroma', 'Pierre Marcolini Ginza'],
    rejected: ["Royce' Chocolate (Tokyo Station)"],
    requested: 3,
  });
  assert.equal(/royce/i.test(out.text), false, 'the invented venue is gone from the prose');
  assert.match(out.text, /Theobroma/);
  assert.match(out.text, /Marcolini/);
  assert.match(out.text, /Enjoy/, 'the rest of the answer is left alone');
});

test('a count claim is corrected to what actually verified', () => {
  const out = L.rebuildAssistProse(PROSE, {
    kept: ['Musee Du Chocolat Theobroma', 'Pierre Marcolini Ginza'],
    rejected: ["Royce' Chocolate (Tokyo Station)"],
    requested: 3,
  });
  assert.match(out.text, /two excellent options/, 'the answer no longer promises three');
  assert.equal(/three excellent/.test(out.text), false);
  assert.match(out.note, /verify two good matches/);
});

test('a complete answer gets no note and no rewriting', () => {
  const out = L.rebuildAssistProse(PROSE, {
    kept: ["Royce' Chocolate (Tokyo Station)", 'Musee Du Chocolat Theobroma', 'Pierre Marcolini Ginza'],
    rejected: [],
    requested: 3,
  });
  assert.equal(out.note, '');
  assert.match(out.text, /three excellent options/);
  assert.match(out.text, /Royce/);
});

test('a block naming BOTH a kept and a rejected venue is kept', () => {
  // Cutting it would take a good recommendation with it. The corrected count
  // is what stops the answer over-claiming.
  const out = L.rebuildAssistProse(
    'Try Royce at Tokyo Station, though Pierre Marcolini Ginza is better.',
    { kept: ['Pierre Marcolini Ginza'], rejected: ["Royce' Chocolate (Tokyo Station)"], requested: 2 });
  assert.match(out.text, /Marcolini/);
});

test('a shared word alone never deletes a paragraph', () => {
  // "Chocolate" is in both names. Requiring two distinctive tokens is what
  // stops the cleaner eating the recommendation it was meant to keep.
  const out = L.rebuildAssistProse(
    'Musee Du Chocolat Theobroma in Shibuya is superb.',
    { kept: ['Musee Du Chocolat Theobroma'], rejected: ["Royce' Chocolate World"], requested: 1 });
  assert.match(out.text, /Theobroma/);
});

test('verifying nothing at all is said plainly', () => {
  const out = L.rebuildAssistProse(PROSE, {
    kept: [], rejected: ["Royce' Chocolate (Tokyo Station)", 'Musee Du Chocolat Theobroma', 'Pierre Marcolini Ginza'],
    requested: 3,
  });
  assert.match(out.note, /could not verify any places/);
});

// ---------- the budget is bounded ----------

test('the replacement loop is bounded three ways, and every bound is documented', () => {
  assert.equal(L.DISCOVERY_REPLACEMENT_ROUNDS, 1, 'one pass: a second asks the same box the same question');
  assert.ok(L.DISCOVERY_REPLACEMENTS_PER_ROUND <= 4, 'billed Place Details per pass');
  assert.ok(L.DISCOVERY_CANDIDATE_MAX <= 12, 'total places one answer may look at');
  assert.ok(L.DISCOVERY_REPLACEMENTS_PER_ROUND < L.DISCOVERY_CANDIDATE_MAX);
});

// ---------- the queue accepts an already-resolved place ----------

test('a discovered place is SEEDED, never looked up again', () => {
  // The discovery search WAS the resolution. Re-asking by name would be a
  // second billed call - and one the name gate could refuse, because the model
  // never named this place.
  let sends = 0;
  const q = L.createPlacesQueue({ send: async () => { sends++; return { ok: true, results: [] }; } });
  assert.equal(q.seed('musee du chocolat theobroma tokyo@tokyo', entryOf('ChIJ_musee')), true);
  assert.equal(q.get('musee du chocolat theobroma tokyo@tokyo').placeId, 'ChIJ_musee');
  // and the queue now considers it known, so nothing plans it
  const planned = q.request([{ key: 'musee du chocolat theobroma tokyo@tokyo', query: 'x', area: null }]);
  assert.equal(planned, 0, 'a seeded place is never re-requested');
  assert.equal(sends, 0);
});

test('seeding never overwrites a real answer', () => {
  const q = L.createPlacesQueue({ send: async () => ({ ok: true, results: [] }) });
  q.seed('k@tokyo', entryOf('ChIJ_first'));
  assert.equal(q.seed('k@tokyo', entryOf('ChIJ_second')), false);
  assert.equal(q.get('k@tokyo').placeId, 'ChIJ_first');
});

// ---------- a missing import must not be able to hide again ----------

test('every TripLogic name app.js CALLS is destructured from window.TripLogic', () => {
  // Found the hard way (2026-08-27): `placesCacheUpdates` was used by the
  // discovery path and never imported, so every discovery answer threw a
  // ReferenceError into a silent fallback and the feature simply did not
  // happen. app.js pulls ~120 names off window.TripLogic and a missing one is a
  // RUNTIME error in ONE branch - node --check passes, every node:test passes,
  // and only that branch executing catches it. This test executes it cheaply.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const m = /\}\s*=\s*window\.TripLogic;/.exec(src);
  assert.ok(m, 'the destructuring block moved; this guard needs updating');
  const head = src.slice(0, m.index);
  const names = new Set(head.slice(head.lastIndexOf('const {') + 7)
    .split(/[,\n]/).map(x => x.trim()).filter(x => x && !x.startsWith('//')));
  const body = src.slice(m.index);
  const missing = Object.keys(L).filter(k =>
    !names.has(k) && new RegExp('(?<![.\\w$])' + k + '\\s*\\(').test(body));
  assert.deepEqual(missing, [], 'called in app.js but not destructured from TripLogic');
});

test('a replacement proposal is acceptable, like any other card', () => {
  // The second live-pass defect: validateTripAction does not assign `pid`
  // (validProposalsFrom does), so a proposal built from a DISCOVERED place
  // rendered with data-proposal-id="undefined" and no entry in assistActions.
  // Its "Add to trip" button did nothing - on the one card the traveller is
  // most likely to press, because it is the one we went and found for them.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const fn = src.slice(src.indexOf('function proposalFromDiscovered'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.match(body, /p\.pid\s*=/, 'a discovered proposal must be given a pid');
  assert.match(body, /assistActions\.set\(p\.pid/, 'and its action must be registered for accept');
});
