// THE INVARIANTS THAT WOULD HAVE CAUGHT 2026-09-05, and why they are stated as
// invariants rather than as six venue names.
//
// Three separate production failures reached a traveller past a green suite of
// ~180 places tests, and all three slipped through the same blind spot: every
// existing test varies the CANDIDATE and treats the itinerary's own area as
// ground truth. The failures inverted that. So does this file.
//
//   1. A WRONG AREA POINT EMPTIES A HEALTHY BATCH. The client geocoded
//      "Ko Phi Phi" through Nominatim, got Ko Phi in Trat Province 570 km away,
//      and every real Phi Phi venue was correctly measured against it and
//      correctly refused. Ten good candidates, zero survivors, no bug anywhere
//      in the resolver.
//   2. PROXIMITY DECIDED IDENTITY. "Maya Bay" resolved to "Maya Bay Tours", a
//      tour desk near the hotel, because the desk's name CONTAINS the query
//      (matchConfidence scores containment 1.00) and the desk really is closer
//      than the beach. Every gate said yes.
//   3. A PROVIDER FAILURE LOOKED LIKE AN EMPTY NEIGHBOURHOOD. Discovery
//      answered `[]` for a timeout, a 500 and a genuinely empty area alike.
//
// The fixtures below are captured from real Google responses (see the browser
// verification in the PR) but nothing here depends on a live rating staying
// what it is today: every assertion is about the RELATIONSHIP between what the
// provider returned and what the pipeline did with it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveQueries, discoverPlaces } from '../lib/tp-places-lookup.mjs';
import {
  typeMismatch, addsBrokerWord, placeKind, expectedKinds, verifyArea, normalizeArea,
} from '../lib/tp-places-match.mjs';

const NOW = Date.UTC(2027, 0, 27);

// ---------- fixtures ----------
// Ko Phi Phi Don, the real thing.
const PHI_PHI = { lat: 7.7390, lon: 98.7714 };
// What Nominatim actually answers for the string "Ko Phi Phi": Ko Phi, an
// islet in Ko Kut District, Trat Province. 570 km away, on the Cambodian side.
const TRAT_ISLET = { lat: 11.8237522, lon: 102.4463456 };

// A believable page of Phi Phi venues. Names, addresses and coordinates are
// shaped like Google's real answers for this island: the administrative chain
// says "Ao Nang, Mueang Krabi District, Krabi", which is not a word any
// traveller uses for the place they are standing on.
// This is the real shape, verbatim from the address the owner quoted for
// Anna's Restaurant: Google files Phi Phi under Ao Nang, and the traveller's
// own word for the island appears NOWHERE in it. Thai script included on
// purpose - an address the app cannot tokenize is the normal case outside the
// English-speaking world, not an edge case.
const PHI_PHI_ADDR = '111 \u0e2b\u0e21\u0e39\u0e48\u0e17\u0e35\u0e48 7 Moo 7, Ao Nang, Mueang Krabi District, Krabi 81000, Thailand';
const venue = (name, over = {}) => ({
  name,
  address: PHI_PHI_ADDR,
  addressComponents: [
    { longText: 'Ao Nang', shortText: 'Ao Nang' },
    { longText: 'Krabi', shortText: 'Krabi' },
    { longText: 'Thailand', shortText: 'TH' },
  ],
  rating: 4.5,
  userRatingCount: 900,
  mapsUri: 'https://maps.google.com/?cid=1',
  lat: PHI_PHI.lat + (over.dLat || 0),
  lon: PHI_PHI.lon + (over.dLon || 0),
  types: over.types || ['restaurant', 'food'],
  primaryType: over.primaryType === undefined ? 'restaurant' : over.primaryType,
  ...('rating' in over ? { rating: over.rating } : {}),
});

const MEAL_VENUES = [
  'The Mango Garden', "Anna's Restaurant", 'Garlic 1992', 'Acqua Restaurant',
  'P.P. Wang Ta Fu', 'DMC Restaurant', 'Efe Mediterranean Cuisine', 'Papaya Restaurant',
];

// A provider stub that answers every query with the venue of that name.
function healthyProvider(names) {
  const byId = new Map();
  names.forEach((n, i) => byId.set('pid-' + i, venue(n)));
  const idOf = q => {
    for (const [id, p] of byId) {
      if (q.toLowerCase().includes(p.name.toLowerCase())) return id;
    }
    return null;
  };
  return {
    calls: { search: 0, details: 0 },
    byId,
    async findPlaceId(q) { this.calls.search += 1; return idOf(q); },
    async fetchDetails(id) { this.calls.details += 1; return byId.get(id) || null; },
  };
}

const memCache = () => {
  const m = new Map();
  return { get: async k => m.get(k), set: async (k, v) => { m.set(k, v); }, raw: m };
};

// ---------- INVARIANT 11: a healthy provider response cannot become an empty slot ----------

test('INVARIANT: a correct area point keeps every venue a healthy provider returned', async () => {
  const s = healthyProvider(MEAL_VENUES);
  const queries = MEAL_VENUES.map((n, i) => ({
    q: `${n} Ko Phi Phi`, id: 'k' + i,
    city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon,
  }));
  const { results } = await resolveQueries({
    queries, cache: memCache(), findPlaceId: (q, b) => s.findPlaceId(q, b),
    fetchDetails: id => s.fetchDetails(id), now: NOW, budget: 40,
  });
  const ok = results.filter(r => r.status === 'ok');
  assert.equal(ok.length, MEAL_VENUES.length, 'every real venue survives');
  for (const r of ok) {
    assert.ok(r.rating > 0, `${r.query} kept the rating the provider returned`);
    assert.ok(r.placeId, `${r.query} kept its canonical identity`);
    assert.equal(r.verified, true, 'and the point check confirmed the area');
  }
});

test('INVARIANT: a WRONG area point cannot silently empty a batch of real venues', async () => {
  // THE PRODUCTION REPRO, exactly. Same eight real venues, same healthy
  // provider - only the itinerary's own idea of where "Ko Phi Phi" is has been
  // replaced by the answer Nominatim really gives for that string.
  //
  // The resolver is not wrong to refuse these: measured against Trat they ARE
  // 570 km away. What must never happen is that the failure is invisible. The
  // reason has to say `wrong_area` on every one of them, so a wholesale
  // rejection is diagnosable as "the anchor is wrong" rather than looking like
  // "this island has no restaurants".
  const s = healthyProvider(MEAL_VENUES);
  const queries = MEAL_VENUES.map((n, i) => ({
    q: `${n} Ko Phi Phi`, id: 'k' + i,
    city: 'Ko Phi Phi', country: 'Thailand', lat: TRAT_ISLET.lat, lon: TRAT_ISLET.lon,
  }));
  const { results } = await resolveQueries({
    queries, cache: memCache(), findPlaceId: (q, b) => s.findPlaceId(q, b),
    fetchDetails: id => s.fetchDetails(id), now: NOW, budget: 40,
  });
  assert.equal(results.filter(r => r.status === 'ok').length, 0);
  for (const r of results) {
    assert.equal(r.reason, 'wrong_area',
      'a whole-batch wipeout must name the anchor, not look like an empty island');
  }
  // And the counterpart the client now guarantees (see areaAnchorFor): with NO
  // point at all, the same batch resolves. An unverifiable anchor must degrade
  // to "could not check", never to "checked and wrong".
  const s2 = healthyProvider(MEAL_VENUES);
  const { results: unchecked } = await resolveQueries({
    queries: MEAL_VENUES.map((n, i) => ({ q: `${n} Ko Phi Phi`, id: 'u' + i, city: 'Ko Phi Phi', country: 'Thailand' })),
    cache: memCache(), findPlaceId: (q, b) => s2.findPlaceId(q, b),
    fetchDetails: id => s2.fetchDetails(id), now: NOW, budget: 40,
  });
  assert.equal(unchecked.filter(r => r.status === 'ok').length, MEAL_VENUES.length,
    'no anchor is better than a wrong one: every venue resolves and shows its rating');
  assert.equal(unchecked.every(r => r.verified === false), true,
    'and honestly reports that the branch was never confirmed');
});

// ---------- INVARIANT 7: one bad candidate cannot delete the good ones ----------

test('INVARIANT: one invented venue and one far-away namesake cannot take the other eight with them', async () => {
  const s = healthyProvider(MEAL_VENUES);
  // a same-named venue on the wrong side of the country
  s.byId.set('far', { ...venue('Papaya Restaurant'), lat: 18.79, lon: 98.98, address: 'Chiang Mai, Thailand' });
  const findPlaceId = async q => {
    if (/invented/i.test(q)) return null;               // the model made it up
    if (/far papaya/i.test(q)) return 'far';
    return s.findPlaceId(q);
  };
  const queries = [
    ...MEAL_VENUES.map((n, i) => ({ q: `${n} Ko Phi Phi`, id: 'k' + i, city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon })),
    { q: 'The Invented Grill Ko Phi Phi', id: 'bad1', city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon },
    { q: 'Far Papaya Restaurant Ko Phi Phi', id: 'bad2', city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon },
  ];
  const { results } = await resolveQueries({
    queries, cache: memCache(), findPlaceId, fetchDetails: id => s.fetchDetails(id), now: NOW, budget: 40,
  });
  assert.equal(results.filter(r => r.status === 'ok').length, 8, 'the eight good ones are untouched');
  assert.equal(results.find(r => r.id === 'bad1').reason, 'not_found');
  assert.equal(results.find(r => r.id === 'bad2').reason, 'wrong_area');
});

// ---------- INVARIANT 9: proximity cannot override entity type ----------

test('INVARIANT: a venue that sells access to a landmark is not that landmark', () => {
  // The general rule, stated over the shape rather than the name: the place
  // adds a word naming a TRADE that the query never asked for.
  assert.equal(addsBrokerWord('Maya Bay Ko Phi Phi', 'Maya Bay Tours', { city: 'Ko Phi Phi' }), 'tours');
  assert.equal(addsBrokerWord('Blue Lagoon Iceland', 'Blue Lagoon Booking Office', { city: 'Iceland' }), 'booking');
  assert.equal(addsBrokerWord('Sagrada Familia Barcelona', 'Sagrada Familia Tickets & Tours', { city: 'Barcelona' }), 'tickets');
  // and the two ways it must stay silent
  assert.equal(addsBrokerWord('Maya Bay Tours Ko Phi Phi', 'Maya Bay Tours', { city: 'Ko Phi Phi' }), '',
    'a traveller who asked for the tour operator gets the tour operator');
  assert.equal(addsBrokerWord('Nabezo Shinjuku', 'Nabezo Shinjuku Sanchome', { city: 'Tokyo' }), '',
    'an ordinary one-sided extra word is not a trade and must still pass');
});

test('INVARIANT: proximity does not rescue a type-incompatible match', () => {
  // The tour desk is 100 m from the hotel and the beach is 7 km offshore, so
  // every geographic signal favours the wrong answer. The type gate is what
  // has to be the deciding vote, and it runs before geography is consulted.
  const desk = venue('Maya Bay Tours', { dLat: 0.001, types: ['travel_agency', 'point_of_interest'], primaryType: 'travel_agency' });
  assert.equal(typeMismatch('Maya Bay Ko Phi Phi', desk, { city: 'Ko Phi Phi' }, ''), 'broker_name');
  // And a desk that calls itself exactly "Maya Bay" leaves no name signal at
  // all - there Google's own type is the only evidence, and it is enough.
  const namelessDesk = { ...desk, name: 'Maya Bay' };
  assert.equal(typeMismatch('Maya Bay Ko Phi Phi', namelessDesk, { city: 'Ko Phi Phi' }, ''), 'broker_kind');
  // A traveller who asked for the operator still gets it.
  assert.equal(typeMismatch('Maya Bay Tours Ko Phi Phi', desk, { city: 'Ko Phi Phi' }, ''), '');
});

test('INVARIANT: the type gate refuses only on evidence, never on silence', () => {
  const noTypes = { name: 'Maya Bay', types: [], primaryType: '' };
  assert.equal(typeMismatch('Maya Bay Ko Phi Phi', noTypes, { city: 'Ko Phi Phi' }, ''), '',
    'a provider that sent no types has said nothing, and silence is not a mismatch');
  const beach = venue('Loh Dalum Beach', { types: ['beach', 'natural_feature'], primaryType: 'beach' });
  assert.equal(typeMismatch('Loh Dalum Beach Ko Phi Phi', beach, { city: 'Ko Phi Phi' }, ''), '');
  // A query with no kind word in it has no expectation to contradict.
  assert.equal(typeMismatch("Anna's Restaurant Ko Phi Phi", beach, { city: 'Ko Phi Phi' }, ''), '');
});

test('the itinerary\'s meal slot is the one expectation the query cannot state for itself', () => {
  const beach = venue('Loh Dalum Beach', { types: ['beach'], primaryType: 'beach' });
  assert.equal(typeMismatch("Anna's Ko Phi Phi", beach, { city: 'Ko Phi Phi' }, 'breakfast'), 'kind_mismatch');
  assert.equal(typeMismatch("Anna's Ko Phi Phi", beach, { city: 'Ko Phi Phi' }, ''), '',
    'and with no slot there is no expectation, so nothing is refused');
  // A hotel is NOT refused for a meal slot: hotel restaurants and resort
  // breakfast rooms are real answers to "where shall I eat".
  const hotelResto = venue('Phi Phi Island Village', { types: ['hotel', 'lodging'], primaryType: 'hotel' });
  assert.equal(typeMismatch('Phi Phi Island Village Ko Phi Phi', hotelResto, { city: 'Ko Phi Phi' }, 'breakfast'), '');
});

test('REFUSED BY DESIGN: kind words in a venue NAME are not category expectations', () => {
  // Every one of these is a correct answer that a text-derived expectation
  // would have deleted. They are the reason expectedKinds reads only the meal
  // slot; see its note. If someone reintroduces a KIND_WORDS table, this fails.
  const cases = [
    ['The Mango Garden Ko Phi Phi', 'The Mango Garden', 'restaurant'],
    ['Phi Phi Island Village Ko Phi Phi', 'Phi Phi Island Village', 'hotel'],
    ['Temple Bar Dublin', 'The Temple Bar', 'bar'],
    ['Long Beach Resort Ko Phi Phi', 'Long Beach Resort', 'resort_hotel'],
    ['Central Park Hotel New York', 'Central Park Hotel', 'hotel'],
  ];
  for (const [query, name, primaryType] of cases) {
    assert.equal(typeMismatch(query, { name, primaryType, types: [primaryType] }, { city: '' }, ''), '',
      `${name} is a real venue and must not be refused for the words in its own name`);
  }
});

test('placeKind reads primaryType first and falls back through types', () => {
  assert.equal(placeKind({ primaryType: 'beach', types: ['establishment'] }), 'nature');
  assert.equal(placeKind({ primaryType: 'nonsense_type', types: ['museum'] }), 'culture');
  assert.equal(placeKind({ types: ['point_of_interest', 'establishment'] }), '', 'no opinion, not a wrong one');
  assert.equal(placeKind(null), '');
});

test('expectedKinds reads the itinerary slot and nothing else', () => {
  assert.deepEqual([...expectedKinds("Anna's Restaurant", 'dinner')], ['food']);
  assert.deepEqual([...expectedKinds('Maya Bay Ko Phi Phi', '')], [], 'no slot, no opinion');
  assert.deepEqual([...expectedKinds('Wat Chalong Phuket', '')], []);
});

test('the type gate is wired into resolveQueries, not just available to it', async () => {
  const desk = venue('Maya Bay Tours', { types: ['travel_agency'], primaryType: 'travel_agency' });
  const { results } = await resolveQueries({
    queries: [{ q: 'Maya Bay Ko Phi Phi', id: 'maya', city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon }],
    cache: memCache(),
    findPlaceId: async () => 'desk',
    fetchDetails: async () => desk,
    now: NOW, budget: 4,
  });
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'type_mismatch');
  assert.equal(results[0].rating, undefined, 'and the tour desk\'s rating never reaches the card');
});

// ---------- INVARIANT 8: administrative wording alone cannot reject ----------

test('INVARIANT: a locality the traveller uses and Google does not is never evidence of the wrong place', () => {
  // Google addresses Phi Phi as "Ao Nang, Mueang Krabi District, Krabi". The
  // traveller wrote "Ko Phi Phi". Those never agree, and the disagreement is
  // about vocabulary, not geography.
  const v = venue("Anna's Restaurant");
  const verdict = verifyArea(v, normalizeArea({ city: 'Ko Phi Phi', country: 'Thailand' }));
  assert.equal(verdict.ok, true, 'not rejected');
  assert.equal(verdict.checked, false, 'and not pretended to be verified either');
  assert.equal(verdict.reason, 'city_unconfirmed');
  // The country genuinely missing IS evidence, and still rejects.
  const elsewhere = { ...v, address: 'Kyoto, Japan', addressComponents: [{ longText: 'Japan', shortText: 'JP' }] };
  assert.equal(verifyArea(elsewhere, normalizeArea({ city: 'Ko Phi Phi', country: 'Thailand' })).ok, false);
});

// ---------- INVARIANT 6: a provider failure is not zero results ----------

test('INVARIANT: discovery reports a failed search as a failure, not as an empty area', async () => {
  const boom = await discoverPlaces({
    query: 'seafood Ko Phi Phi', area: normalizeArea({ city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon }),
    limit: 3, exclude: [],
    findPlaceIds: async () => { throw new Error('upstream 503'); },
    fetchDetails: async () => null, now: NOW, claim: () => true,
  });
  assert.deepEqual(boom.results, []);
  assert.equal(boom.reason, 'upstream', 'the caller must be able to tell this from an empty island');

  const empty = await discoverPlaces({
    query: 'seafood Ko Phi Phi', area: normalizeArea({ city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon }),
    limit: 3, exclude: [],
    findPlaceIds: async () => [],
    fetchDetails: async () => null, now: NOW, claim: () => true,
  });
  assert.deepEqual(empty.results, []);
  assert.equal(empty.reason, 'no_candidates', 'and a genuinely empty answer says so in its own word');
});

test('discovery applies the same type gate: a dive-booking desk is not seafood', async () => {
  const desk = venue('Phi Phi Dive Tours', { types: ['travel_agency'], primaryType: 'travel_agency' });
  const real = venue('Papaya Restaurant');
  const found = await discoverPlaces({
    query: 'seafood Ko Phi Phi',
    area: normalizeArea({ city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon }),
    limit: 3, exclude: [], meal: 'dinner',
    findPlaceIds: async () => ['desk', 'real'],
    fetchDetails: async id => (id === 'desk' ? desk : real),
    now: NOW, claim: () => true,
  });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].name, 'Papaya Restaurant');
});

// ---------- INVARIANT 3/4: the metadata belongs to the identity that carries it ----------

test('INVARIANT: rating, name, coordinates, Maps link and place ID all describe one entity', async () => {
  const s = healthyProvider(['The Mango Garden']);
  // captured shape, not a live figure: the assertion is that whatever the
  // provider said travels together, unaltered, keyed to one place ID.
  s.byId.set('pid-0', {
    ...venue('The Mango Garden'),
    rating: 4.8, userRatingCount: 3770,
    mapsUri: 'https://maps.google.com/?cid=1751281051042218790',
  });
  const { results } = await resolveQueries({
    queries: [{ q: 'The Mango Garden Ko Phi Phi', id: 'mg', city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon }],
    cache: memCache(), findPlaceId: (q, b) => s.findPlaceId(q, b), fetchDetails: id => s.fetchDetails(id),
    now: NOW, budget: 4,
  });
  const r = results[0];
  assert.equal(r.status, 'ok');
  assert.equal(r.name, 'The Mango Garden');
  assert.equal(r.rating, 4.8);
  assert.equal(r.userRatingCount, 3770);
  assert.equal(r.placeId, 'pid-0');
  assert.equal(r.mapsUri, 'https://maps.google.com/?cid=1751281051042218790');
  assert.equal(r.lat, PHI_PHI.lat);
  assert.equal(r.lon, PHI_PHI.lon);
  assert.equal(r.verified, true);
});

test('an attraction gets its rating exactly as a restaurant does', async () => {
  // Ratings were never restaurant-only, and this is the test that keeps it so:
  // the same pipeline, a beach fixture, the same fields out.
  const beach = { ...venue('Loh Dalum Beach', { types: ['beach'], primaryType: 'beach' }), rating: 4.1, userRatingCount: 1077 };
  const { results } = await resolveQueries({
    queries: [{ q: 'Loh Dalum Beach Ko Phi Phi', id: 'ldb', city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon }],
    cache: memCache(), findPlaceId: async () => 'b', fetchDetails: async () => beach, now: NOW, budget: 4,
  });
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].rating, 4.1);
  assert.equal(results[0].userRatingCount, 1077);
});

test('a resolved place with no rating keeps its identity and says only the star is missing', async () => {
  const unrated = { ...venue('Somtam Stall'), rating: null };
  const { results } = await resolveQueries({
    queries: [{ q: 'Somtam Stall Ko Phi Phi', id: 's', city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon }],
    cache: memCache(), findPlaceId: async () => 'u', fetchDetails: async () => unrated, now: NOW, budget: 4,
  });
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'unrated');
  assert.equal(results[0].placeId, 'u', 'the identity survives: this is not "we could not find it"');
  assert.equal(results[0].verified, true);
});

// ---------- cost: the fix must not multiply provider calls ----------

test('the type gate costs no extra provider calls', async () => {
  const s = healthyProvider(MEAL_VENUES);
  await resolveQueries({
    queries: MEAL_VENUES.map((n, i) => ({ q: `${n} Ko Phi Phi`, id: 'c' + i, city: 'Ko Phi Phi', country: 'Thailand', lat: PHI_PHI.lat, lon: PHI_PHI.lon })),
    cache: memCache(), findPlaceId: (q, b) => s.findPlaceId(q, b), fetchDetails: id => s.fetchDetails(id),
    now: NOW, budget: 40,
  });
  assert.equal(s.calls.details, MEAL_VENUES.length, 'exactly one billed Place Details per venue, as before');
  assert.equal(s.calls.search, MEAL_VENUES.length, 'and one free search each');
});
