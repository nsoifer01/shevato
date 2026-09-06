import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeArea, verifyArea, resolutionConfidence, matchConfidence, isGenericQuery,
  areaDistanceKm, UNCHECKED_MAX_CONFIDENCE, AREA_MAX_KM,
} from '../lib/tp-places-match.mjs';
import { resolveQueries, discoverPlaces } from '../lib/tp-places-lookup.mjs';

// THE ROUND THIS FILE PINS (2026-09-05).
//
// After the 2026-08-27 geographic gate landed, the assistant answered whole
// tourist destinations with "I could not verify any places for this on Google
// Maps, so I have not added any."
//
// The cause was one line in verifyArea. With no coordinate for the expected
// city, the gate compared the itinerary's HUMAN name for a place against
// Google's ADMINISTRATIVE address, and treated a mismatch as proof the venue
// was somewhere else:
//
//   itinerary says          Google's address says
//   ----------------------  ------------------------------------------------
//   "Railay Beach"          Ao Nang, Mueang Krabi District, Krabi, Thailand
//   "Kata Beach"            Karon, Mueang Phuket District, Phuket, Thailand
//   "Ko Phi Phi"            Ao Nang, Mueang Krabi District, Krabi, Thailand
//
// None of those addresses contain the traveller's word for the place, because
// beaches, resort strips and islands are not administrative units. So every
// real restaurant in the area was refused as `wrong_area` while scoring a
// PERFECT 1.00 on the name gate, and because the replacement search applied
// the same rule to its own candidates, the replacement loop could not rescue
// the answer either. Zero places, everywhere, for a whole class of destination.
//
// The fix is a separation, and these tests pin both halves of it:
//   RESOLVED - Google returned a real entity whose name the query accounts for.
//              This is the anti-hallucination gate and it decides whether a
//              place may be RECOMMENDED.
//   VERIFIED - the area was actually CHECKED and agreed. This decides whether a
//              coordinate, a distance or a persisted record may be drawn, and
//              it is exactly as strict as it was.
//
// Nothing here is tuned to Thailand: the fixtures below are Thai, Greek,
// Indonesian and Japanese, and every assertion is about the SHAPE of the
// disagreement (a sub-locality Google does not print), never about a country.

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

// ---------- real places, with the addresses Google actually returns ----------

// The venue from the owner's report. The Thai script is deliberate: the
// normalizer has to fold it without destroying the latin half.
const ANNAS = {
  name: "Anna's Restaurant",
  rating: 4.4, userRatingCount: 812, mapsUri: 'https://maps.google.com/?cid=11',
  lat: 8.0320, lon: 98.8250,
  address: '111 หมู่ที่ 7 Moo 7, Ao Nang, Mueang Krabi District, Krabi 81000, Thailand',
  addressComponents: [
    { longText: 'Ao Nang', shortText: 'Ao Nang' },
    { longText: 'Mueang Krabi District', shortText: 'Mueang Krabi District' },
    { longText: 'Krabi', shortText: 'Krabi' },
    { longText: 'Thailand', shortText: 'TH' },
  ],
};
const KATA_ON_FIRE = {
  name: 'Kata On Fire Bar and Grill',
  rating: 4.6, userRatingCount: 430, mapsUri: 'https://maps.google.com/?cid=12',
  lat: 7.8180, lon: 98.2980,
  address: '100/10 Kata Rd, Karon, Mueang Phuket District, Phuket 83100, Thailand',
  addressComponents: [
    { longText: 'Karon', shortText: 'Karon' },
    { longText: 'Phuket', shortText: 'Phuket' },
    { longText: 'Thailand', shortText: 'TH' },
  ],
};
// Same shape, three other countries, so nothing here can be a Thailand patch.
const OIA_TAVERNA = {
  name: 'Taverna Katina',
  rating: 4.5, userRatingCount: 2100, mapsUri: 'https://maps.google.com/?cid=13',
  lat: 36.4618, lon: 25.3753,
  address: 'Ammoudi Bay, Thira 847 02, Greece',
  addressComponents: [
    { longText: 'Thira', shortText: 'Thira' },
    { longText: 'Greece', shortText: 'GR' },
  ],
};
const UBUD_WARUNG = {
  name: 'Warung Biah Biah',
  rating: 4.6, userRatingCount: 3400, mapsUri: 'https://maps.google.com/?cid=14',
  lat: -8.5069, lon: 115.2625,
  address: 'Jl. Goutama No.13, Ubud, Kecamatan Ubud, Kabupaten Gianyar, Bali 80571, Indonesia',
  addressComponents: [
    { longText: 'Ubud', shortText: 'Ubud' },
    { longText: 'Kabupaten Gianyar', shortText: 'Kabupaten Gianyar' },
    { longText: 'Bali', shortText: 'Bali' },
    { longText: 'Indonesia', shortText: 'ID' },
  ],
};
// The wrong-branch case the gate exists for, kept here so the relaxation
// above can be shown NOT to have reopened it.
const ROYCE_HOKKAIDO = {
  name: "ROYCE' Chocolate World",
  rating: 4.4, userRatingCount: 3200, mapsUri: 'https://maps.google.com/?cid=15',
  lat: 42.7752, lon: 141.6926,
  address: 'New Chitose Airport Terminal 3F, 987-22 Bibi, Chitose, Hokkaido 066-0012, Japan',
  addressComponents: [
    { longText: 'Chitose', shortText: 'Chitose' },
    { longText: 'Hokkaido', shortText: 'Hokkaido' },
    { longText: 'Japan', shortText: 'JP' },
  ],
};

function memCache(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; }, async set(k, v) { map.set(k, v); } };
}

// A provider that answers a query with whichever fixture the query names, the
// way Text Search does: two distinctive words of the venue's own name is a hit.
function provider(places) {
  const byId = new Map(places.map((p, i) => ['pid_' + i, p]));
  return {
    ids: [...byId.keys()],
    findPlaceId: async (q) => {
      const ql = String(q).toLowerCase();
      for (const [id, p] of byId) {
        const words = p.name.toLowerCase().split(/\W+/).filter(w => w.length > 2);
        if (words.filter(w => ql.includes(w)).length >= 2) return id;
      }
      return null;
    },
    findPlaceIds: async () => [...byId.keys()],
    fetchDetails: async id => byId.get(id) || null,
  };
}

const resolve = (query, rawArea, places, budget = 8) => resolveQueries({
  queries: [{ q: query, id: 'k', ...rawArea }],
  cache: memCache(), now: NOW, budget,
  ...provider(places),
}).then(r => r.results[0]);

// The two client gates, mirrored here so the server tests can state what the
// UI will actually do with each verdict. They are one-liners in app.js
// (isResolvedEntry / isVerifiedEntry) and the whole point is the difference.
const RESOLVED = e => !!e && (e.status === 'ok' || (e.status === 'no_match' && e.reason === 'unrated'));
const VERIFIED = e => RESOLVED(e) && e.verified === true;

// ---------- A. a real place resolves from the shapes an itinerary produces ----------

test('A. a real venue resolves from name alone, name + destination, and name + address', async () => {
  const area = { city: 'Ao Nang', country: 'Thailand' };
  for (const q of [
    "Anna's Restaurant",
    "Anna's Restaurant Ao Nang",
    "Anna's Restaurant, 111 Moo 7, Ao Nang, Mueang Krabi District, Krabi 81000",
  ]) {
    const r = await resolve(q, area, [ANNAS]);
    assert.equal(r.status, 'ok', `should resolve: ${q}`);
    assert.ok(RESOLVED(r), `should be recommendable: ${q}`);
    assert.equal(r.rating, 4.4);
  }
});

// ---------- B. the regression itself ----------

test('B. THE REGRESSION: a sub-locality destination does not refuse a real venue', async () => {
  // Each row is a real place whose Google address names a DIFFERENT
  // administrative unit from the one the traveller wrote on the itinerary.
  // Before the fix every one of these came back `no_match / wrong_area`.
  const cases = [
    { city: 'Railay Beach', country: 'Thailand', place: ANNAS, q: "Anna's Restaurant Railay Beach" },
    { city: 'Ko Phi Phi', country: 'Thailand', place: ANNAS, q: "Anna's Restaurant Ko Phi Phi" },
    { city: 'Kata Beach', country: 'Thailand', place: KATA_ON_FIRE, q: 'Kata On Fire Bar and Grill Kata Beach' },
    { city: 'Oia', country: 'Greece', place: OIA_TAVERNA, q: 'Taverna Katina Oia' },
    { city: 'Ubud', country: 'Indonesia', place: UBUD_WARUNG, q: 'Warung Biah Biah Ubud' },
  ];
  for (const c of cases) {
    const r = await resolve(c.q, { city: c.city, country: c.country }, [c.place]);
    assert.notEqual(r.reason, 'wrong_area', `${c.city}: a real venue must not be refused on geography`);
    assert.ok(RESOLVED(r), `${c.city}: must be recommendable`);
  }
});

test('B2. an unconfirmed resolution is honest: recommendable, but never verified', async () => {
  // The other half of the separation. Nothing could check the branch, so the
  // place carries no verification, which is what stops a coordinate being
  // stored, a distance being drawn or a place record being persisted.
  const r = await resolve("Anna's Restaurant Railay Beach",
    { city: 'Railay Beach', country: 'Thailand' }, [ANNAS]);
  assert.ok(RESOLVED(r));
  assert.equal(VERIFIED(r), false, 'unchecked is not verified');
  assert.ok(r.confidence <= UNCHECKED_MAX_CONFIDENCE,
    'and it can never score as high as something that WAS checked');
});

test('B3. the same venue IS verified once the destination has a coordinate', async () => {
  // Which is the normal case: the client geocodes the day's city before it
  // verifies (warmAreaPoints), so the coordinate gate is what usually answers,
  // and it answers correctly for a beach 3 km from the venue.
  const r = await resolve("Anna's Restaurant Railay Beach",
    { city: 'Railay Beach', country: 'Thailand', lat: 8.0115, lon: 98.8378 }, [ANNAS]);
  assert.equal(VERIFIED(r), true);
  assert.equal(r.areaBasis, 'point');
  assert.equal(r.lat, ANNAS.lat);
  assert.equal(r.lon, ANNAS.lon);
});

// ---------- the reported venue, stage by stage ----------

test('THE REPORTED VENUE: Anna\'s Restaurant survives every stage of the pipeline', async () => {
  // The failure the owner hit, walked one stage at a time so a future break
  // says WHICH stage. The address is the real one, Thai script included.
  const query = "Anna's Restaurant Railay Beach";
  const area = normalizeArea({ city: 'Railay Beach', country: 'Thailand' });

  // 1. it is a nameable venue, so a lookup is worth paying for
  assert.equal(isGenericQuery(query), false, 'stage 1: not a category query');

  // 2. Google returns the venue (the provider double stands in for that)
  const p = provider([ANNAS]);
  assert.equal(await p.findPlaceId(query), 'pid_0', 'stage 2: the search finds it');
  const place = await p.fetchDetails('pid_0');
  assert.equal(place.name, "Anna's Restaurant", 'stage 3: details come back');

  // 4. the NAME gate is satisfied, and emphatically so
  const m = matchConfidence(query, place.name);
  assert.equal(m.confident, true, 'stage 4: name match');
  assert.equal(m.score, 1, 'and it is perfect, not marginal');

  // 5. the AREA gate does not refuse it over the locality wording. Google says
  //    "Ao Nang, Mueang Krabi District, Krabi"; the itinerary says "Railay
  //    Beach". Before the fix this returned ok:false and the whole day emptied.
  const v = verifyArea(place, area);
  assert.equal(v.ok, true, 'stage 5: an unfamiliar locality is not a rejection');
  assert.equal(v.reason, 'city_unconfirmed');

  // 6. so the candidate survives the resolver
  const r = await resolve(query, { city: 'Railay Beach', country: 'Thailand' }, [ANNAS]);
  assert.equal(r.status, 'ok', 'stage 6: it resolves');

  // 7. and reaches the traveller as a usable option: a name, a rating, a Maps
  //    link and the canonical place ID the itinerary row will reuse
  assert.ok(RESOLVED(r), 'stage 7: recommendable');
  assert.equal(r.name, "Anna's Restaurant");
  assert.equal(r.rating, 4.4);
  assert.ok(r.mapsUri);
  assert.ok(r.placeId);

  // 8. and once the destination has a coordinate it is fully VERIFIED, which
  //    is what unlocks its distance chip and a persisted place record
  const withPoint = await resolve(query,
    { city: 'Railay Beach', country: 'Thailand', lat: 8.0115, lon: 98.8378 }, [ANNAS]);
  assert.equal(VERIFIED(withPoint), true, 'stage 8: verified against the coordinate');
  assert.equal(withPoint.areaBasis, 'point');
});

test('THE COUNTERPART: a same-named venue in the wrong place is still refused', async () => {
  // Same name, same country, 700 km away. This is what the area gate is FOR,
  // and relaxing the locality wording must not have touched it.
  const ANNAS_BANGKOK = {
    ...ANNAS,
    address: '9 Sukhumvit Rd, Khlong Toei, Bangkok 10110, Thailand',
    addressComponents: [{ longText: 'Bangkok', shortText: 'Bangkok' },
      { longText: 'Thailand', shortText: 'TH' }],
    lat: 13.7563, lon: 100.5018,
  };
  const r = await resolve("Anna's Restaurant Railay Beach",
    { city: 'Railay Beach', country: 'Thailand', lat: 8.0115, lon: 98.8378 }, [ANNAS_BANGKOK]);
  assert.equal(r.status, 'no_match');
  assert.equal(r.reason, 'wrong_area');
  assert.equal(RESOLVED(r), false);
  // the distance the gate actually measured, for the record
  assert.ok(areaDistanceKm({ lat: 8.0115, lon: 98.8378 }, ANNAS_BANGKOK) > 600);
});

test('THE CHAIN SIBLING: a neighbouring property of the same chain is not "the same place"', async () => {
  // Found by verifying the locality fix against production: the query named
  // the -FASHION- property, Google answered with the chain's -POP- property
  // 350 m up the same beach, and the old name gate scored it 0.80. Geography
  // cannot separate two hotels on one beach; only the name can, and the
  // discriminating word is the one the two names disagree about.
  const SUGAR_POP = {
    name: 'Sugar Marina Hotel -POP- Kata Beach',
    address: '10 Kata Rd, Karon, Mueang Phuket District, Phuket 83100, Thailand',
    addressComponents: [{ longText: 'Karon', shortText: 'Karon' },
      { longText: 'Phuket', shortText: 'Phuket' }, { longText: 'Thailand', shortText: 'TH' }],
    rating: 4.3, userRatingCount: 1500, mapsUri: 'https://maps.google.com/?cid=31',
    lat: 7.8233, lon: 98.2990,
  };
  const r = await resolveQueries({
    queries: [{ q: 'Sugar Marina Hotel -FASHION- Kata Beach', id: 'k',
      city: 'Kata Beach', country: 'Thailand' }],
    cache: memCache(), now: NOW, budget: 4, ...alwaysProvider(SUGAR_POP),
  });
  assert.equal(r.results[0].status, 'no_match');
  assert.equal(r.results[0].reason, 'low_confidence');
  assert.equal(r.results[0].name, undefined, 'the sibling must not ride back under this query');
  assert.equal(RESOLVED(r.results[0]), false);
});

test('THE CHAIN SIBLING: the property that WAS asked for still resolves', async () => {
  const SUGAR_FASHION = {
    name: 'Sugar Marina Hotel -FASHION- Kata Beach',
    address: '4/70 Karon Rd, Karon, Mueang Phuket District, Phuket 83100, Thailand',
    addressComponents: [{ longText: 'Karon', shortText: 'Karon' },
      { longText: 'Phuket', shortText: 'Phuket' }, { longText: 'Thailand', shortText: 'TH' }],
    rating: 4.4, userRatingCount: 1200, mapsUri: 'https://maps.google.com/?cid=32',
    lat: 7.8203, lon: 98.2988,
  };
  const r = await resolveQueries({
    queries: [{ q: 'Sugar Marina Hotel -FASHION- Kata Beach', id: 'k',
      city: 'Kata Beach', country: 'Thailand' }],
    cache: memCache(), now: NOW, budget: 4, ...alwaysProvider(SUGAR_FASHION),
  });
  assert.equal(r.results[0].status, 'ok');
  assert.ok(RESOLVED(r.results[0]));
});

// ---------- the wrong-branch gate is intact ----------

test('the 809 km branch is STILL refused whenever a coordinate can say so', async () => {
  const r = await resolve("Royce' Chocolate Tokyo Station",
    { city: 'Tokyo', country: 'Japan', lat: 35.6812, lon: 139.7671 }, [ROYCE_HOKKAIDO]);
  assert.equal(r.status, 'no_match');
  assert.equal(r.reason, 'wrong_area');
  assert.equal(RESOLVED(r), false);
});

test('and a wrong COUNTRY is refused even with no coordinate at all', () => {
  const v = verifyArea(ROYCE_HOKKAIDO, normalizeArea({ city: 'Bangkok', country: 'Thailand' }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'country_mismatch');
  assert.equal(resolutionConfidence(1, v), 0);
});

test('the relaxation is bounded: only the LOCALITY may go unconfirmed', () => {
  // A locality name is allowed to be absent; a country is not. This is the
  // line between "we cannot check" and "we checked and it disagreed".
  const thai = normalizeArea({ city: 'Railay Beach', country: 'Thailand' });
  assert.equal(verifyArea(ANNAS, thai).ok, true, 'right country, unfamiliar locality');
  assert.equal(verifyArea(ANNAS, thai).checked, false);
  assert.equal(verifyArea(OIA_TAVERNA, thai).ok, false, 'a Greek address on a Thai day');
  assert.equal(verifyArea(OIA_TAVERNA, thai).reason, 'country_mismatch');
});

test('a coordinate always outranks the address text, in both directions', () => {
  // Same place, same expected city, opposite verdicts - decided by the point.
  const near = normalizeArea({ city: 'Railay Beach', country: 'Thailand', lat: 8.0115, lon: 98.8378 });
  const far = normalizeArea({ city: 'Railay Beach', country: 'Thailand', lat: 13.7563, lon: 100.5018 });
  assert.equal(verifyArea(ANNAS, near).ok, true);
  assert.equal(verifyArea(ANNAS, near).basis, 'point');
  assert.equal(verifyArea(ANNAS, far).ok, false, 'Bangkok is 700 km from Krabi');
  assert.ok(verifyArea(ANNAS, far).km > AREA_MAX_KM);
});

// ---------- E. a fake venue stays unresolved, and is never substituted ----------

test('E. an invented venue stays unresolved and is NOT swapped for a real one', async () => {
  // The provider holds a perfectly good restaurant. The model asked for one
  // that does not exist. The answer must be "not found", never Anna's.
  const r = await resolve('Moonlight Lagoon Bistro Railay Beach',
    { city: 'Railay Beach', country: 'Thailand' }, [ANNAS]);
  assert.equal(r.status, 'no_match');
  assert.ok(r.reason === 'not_found' || r.reason === 'low_confidence');
  assert.equal(r.name, undefined, 'no other business may ride back under this query');
  assert.equal(RESOLVED(r), false);
});

// Text Search answers almost anything with SOMETHING, which is the behaviour
// the name gate exists to survive: this provider always returns one fixed
// place, whatever it was asked.
const alwaysProvider = place => ({
  findPlaceId: async () => 'pid_only',
  findPlaceIds: async () => ['pid_only'],
  fetchDetails: async () => place,
});

test('E2. a venue whose NAME the query does not account for is refused, area or no area', async () => {
  // The anti-hallucination gate is untouched by this round: it is about the
  // BUSINESS, and it rejects on its own with no geography involved. Here the
  // provider hands back a real Kata restaurant for a query naming a different
  // one, in the right city - so ONLY the name gate can catch it.
  const m = matchConfidence('Moonlight Lagoon Bistro', KATA_ON_FIRE.name);
  assert.equal(m.confident, false);
  const { results } = await resolveQueries({
    queries: [{ q: 'Moonlight Lagoon Bistro', id: 'k', city: 'Kata Beach', country: 'Thailand' }],
    cache: memCache(), now: NOW, budget: 4, ...alwaysProvider(KATA_ON_FIRE),
  });
  assert.equal(results[0].reason, 'low_confidence');
  assert.equal(results[0].name, undefined, 'and the other business does not ride back');
});

// ---------- K. failure reasons stay distinguishable ----------

test('K. every failure mode reports its OWN reason, never one generic miss', async () => {
  const seen = new Map();
  const add = r => seen.set(r.reason, (seen.get(r.reason) || 0) + 1);

  // a category, not a venue: refused before anything is billed
  add(await resolve('best seafood restaurant', { city: 'Kata Beach', country: 'Thailand' }, [KATA_ON_FIRE]));
  // a name nothing matches
  add(await resolve('Moonlight Lagoon Bistro', { city: 'Kata Beach', country: 'Thailand' }, [KATA_ON_FIRE]));
  // a query answered by a different business entirely
  add((await resolveQueries({
    queries: [{ q: 'Moonlight Lagoon Bistro', id: 'k', city: 'Kata Beach', country: 'Thailand' }],
    cache: memCache(), now: NOW, budget: 4, ...alwaysProvider(KATA_ON_FIRE),
  })).results[0]);
  // a real name, answered in the wrong hemisphere
  add(await resolve("Royce' Chocolate Tokyo Station",
    { city: 'Tokyo', country: 'Japan', lat: 35.6812, lon: 139.7671 }, [ROYCE_HOKKAIDO]));
  // the budget is gone before the call can be made
  add(await resolve('Kata On Fire Bar and Grill', { city: 'Kata Beach', country: 'Thailand' }, [KATA_ON_FIRE], 0));

  assert.deepEqual([...seen.keys()].sort(),
    ['generic_query', 'low_confidence', 'not_found', 'quota', 'wrong_area']);
  // and the upstream failure is its own state too, distinct from "not found"
  const upstream = await resolveQueries({
    queries: [{ q: 'Kata On Fire Bar and Grill', id: 'k', city: 'Kata Beach', country: 'Thailand' }],
    cache: memCache(), now: NOW, budget: 4,
    findPlaceId: async () => { throw new Error('502'); },
    fetchDetails: async () => null,
  });
  assert.equal(upstream.results[0].status, 'unavailable');
  assert.equal(upstream.results[0].reason, 'upstream');
});

test('K2. an unresolvable candidate never costs the batch its other answers', async () => {
  // One query in a batch failing must not touch the rest. This is the batch
  // level of acceptance criterion C.
  const p = provider([ANNAS, KATA_ON_FIRE]);
  const { results } = await resolveQueries({
    queries: [
      { q: 'Moonlight Lagoon Bistro', id: 'fake', city: 'Ao Nang', country: 'Thailand' },
      { q: "Anna's Restaurant", id: 'annas', city: 'Ao Nang', country: 'Thailand' },
      { q: 'lunch somewhere nice', id: 'generic', city: 'Ao Nang', country: 'Thailand' },
      { q: 'Kata On Fire Bar and Grill', id: 'kof', city: 'Kata Beach', country: 'Thailand' },
    ],
    cache: memCache(), now: NOW, budget: 8, ...p,
  });
  const by = Object.fromEntries(results.map(r => [r.id, r]));
  assert.equal(RESOLVED(by.fake), false);
  assert.equal(RESOLVED(by.generic), false);
  assert.equal(RESOLVED(by.annas), true, 'a real place survives its neighbours failing');
  assert.equal(RESOLVED(by.kof), true);
});

// ---------- C/D. graceful degradation over a whole day's batch ----------

test('C/D. ten candidates, eight real: the answer is the eight, not an apology', async () => {
  // A full day of assistant candidates in one batch - three meal slots with
  // options plus activities - where one venue is invented and one is a
  // same-named business on the other side of the country. Neither may cost the
  // other eight their answer.
  const area = { city: 'Railay Beach', country: 'Thailand' };
  const real = Array.from({ length: 8 }, (_, i) => ({
    name: `Real Venue ${i}`,
    address: `${i} Beach Rd, Ao Nang, Mueang Krabi District, Krabi 81000, Thailand`,
    addressComponents: [{ longText: 'Ao Nang', shortText: 'Ao Nang' },
      { longText: 'Krabi', shortText: 'Krabi' }, { longText: 'Thailand', shortText: 'TH' }],
    rating: 4.0 + i / 10, userRatingCount: 100 + i, mapsUri: 'https://maps.google.com/?cid=' + i,
    lat: 8.03 + i / 1000, lon: 98.82 + i / 1000,
  }));
  // Same NAME as a real one, 700 km away in Bangkok: the wrong-branch case.
  const farAway = {
    name: 'Real Venue 0',
    address: '9 Sukhumvit Rd, Khlong Toei, Bangkok 10110, Thailand',
    addressComponents: [{ longText: 'Bangkok', shortText: 'Bangkok' }, { longText: 'Thailand', shortText: 'TH' }],
    rating: 4.9, userRatingCount: 9000, mapsUri: 'https://maps.google.com/?cid=99',
    lat: 13.7563, lon: 100.5018,
  };

  const byId = new Map([...real.map((p, i) => ['real_' + i, p]), ['far', farAway]]);
  const provider = {
    findPlaceId: async (q) => {
      if (/Moonlight Lagoon/i.test(q)) return null;             // invented: nothing to find
      if (/Far Branch/i.test(q)) return 'far';                  // resolves to Bangkok
      const m = /Real Venue (\d)/.exec(q);
      return m ? 'real_' + m[1] : null;
    },
    fetchDetails: async id => byId.get(id) || null,
  };

  const queries = [
    ...real.map((p, i) => ({ q: `${p.name} Railay Beach`, id: 'ok' + i, ...area })),
    { q: 'Moonlight Lagoon Bistro Railay Beach', id: 'fake', ...area },
    // named with the itinerary's coordinate present, so the point gate decides
    { q: 'Far Branch Real Venue 0', id: 'far', ...area, lat: 8.0115, lon: 98.8378 },
  ];
  const { results } = await resolveQueries({
    queries, cache: memCache(), now: NOW, budget: 24, ...provider,
  });
  const by = Object.fromEntries(results.map(r => [r.id, r]));

  const survived = results.filter(r => RESOLVED(r));
  assert.equal(survived.length, 8, 'the eight real venues are the answer');
  for (let i = 0; i < 8; i++) assert.ok(RESOLVED(by['ok' + i]), `ok${i} must survive`);

  assert.equal(RESOLVED(by.fake), false, 'the invented one does not resolve');
  assert.equal(by.fake.reason, 'not_found');
  assert.equal(by.fake.name, undefined, 'and is not silently replaced by a real venue');

  assert.equal(RESOLVED(by.far), false, 'the 700 km namesake is refused');
  assert.equal(by.far.reason, 'wrong_area');

  // and the client's own "how many did we get" logic must not say zero
  assert.ok(survived.length > 0,
    'a batch with survivors can never produce "could not verify any places"');
});

// ---------- discovery: the replacement half of the same bug ----------

test('L. discovery returns real candidates for a sub-locality destination', async () => {
  // The replacement loop applied the same locality rule to its own candidates,
  // so when the model's picks failed there was nothing to replace them with.
  const p = provider([ANNAS, KATA_ON_FIRE]);
  let left = 6;
  const { results } = await discoverPlaces({
    query: 'seafood restaurants Railay Beach',
    area: normalizeArea({ city: 'Railay Beach', country: 'Thailand' }),
    limit: 4, exclude: [], now: NOW, claim: () => (left > 0 ? (left -= 1, true) : false),
    findPlaceIds: p.findPlaceIds, fetchDetails: p.fetchDetails,
  });
  assert.ok(results.length > 0, 'a restricted-by-name search must be able to answer');
  assert.ok(results.every(r => r.status === 'ok'));
});

test('discovery still refuses candidates it CANNOT constrain', async () => {
  // The city is not in the query and there is no coordinate to build a box
  // from, so the search was global and an unchecked verdict is not good enough.
  const p = provider([OIA_TAVERNA]);
  let left = 6;
  const { results } = await discoverPlaces({
    query: 'seafood restaurants',
    area: normalizeArea({ city: 'Railay Beach', country: 'Thailand' }),
    limit: 4, exclude: [], now: NOW, claim: () => (left > 0 ? (left -= 1, true) : false),
    findPlaceIds: p.findPlaceIds, fetchDetails: p.fetchDetails,
  });
  assert.equal(results.length, 0, 'a Greek taverna is not a Railay replacement');
});

test('discovery honours the exclusion list, so a replacement is never a duplicate', async () => {
  const p = provider([ANNAS, KATA_ON_FIRE]);
  let left = 6;
  const { results } = await discoverPlaces({
    query: 'seafood restaurants Railay Beach',
    area: normalizeArea({ city: 'Railay Beach', country: 'Thailand' }),
    limit: 4, exclude: p.ids, now: NOW, claim: () => (left > 0 ? (left -= 1, true) : false),
    findPlaceIds: p.findPlaceIds, fetchDetails: p.fetchDetails,
  });
  assert.equal(results.length, 0);
});
