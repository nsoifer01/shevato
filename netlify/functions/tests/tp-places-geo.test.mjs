import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeArea, verifyArea, addressMentions, addressTextOf, areaDistanceKm,
  resolutionConfidence, matchConfidence, AREA_MAX_KM, UNCHECKED_MAX_CONFIDENCE,
} from '../lib/tp-places-match.mjs';
import { resolveQueries, idCacheKey, areaCacheKey, toEntry } from '../lib/tp-places-lookup.mjs';
import { rectangleAround, clampBody } from '../tp-places.mjs';

// THE ROUND THIS FILE PINS (2026-08-27). The assistant proposed "Royce'
// Chocolate (Tokyo Station)" for a Tokyo day. Text Search, asked globally,
// answered with the chain's Hokkaido flagship; the name gate scored it 0.67
// and let it through; the card wore Hokkaido's rating, Hokkaido's Maps link
// and Hokkaido's coordinates, and the distance chip printed 809 km.
//
// Every test here is about one half of the fix: the name gate can no longer
// answer the geographic question on its own, and the geographic gate answers
// it the same way for every city on earth (no Tokyo, no thresholds tuned to
// one failure, nothing about chocolate).

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

// The real coordinates and addresses of the two Royce' locations, which is
// what makes this a regression test rather than a fixture.
const ROYCE_HOKKAIDO = {
  name: "ROYCE' Chocolate World",
  rating: 4.4, userRatingCount: 3200, mapsUri: 'https://maps.google.com/?cid=1',
  lat: 42.7752, lon: 141.6926,
  address: 'New Chitose Airport Terminal 3F, 987-22 Bibi, Chitose, Hokkaido 066-0012, Japan',
  addressComponents: [
    { longText: 'Chitose', shortText: 'Chitose' },
    { longText: 'Hokkaido', shortText: 'Hokkaido' },
    { longText: 'Japan', shortText: 'JP' },
  ],
};
const ROYCE_TOKYO = {
  name: "ROYCE' Tokyo Station",
  rating: 4.1, userRatingCount: 210, mapsUri: 'https://maps.google.com/?cid=2',
  lat: 35.6812, lon: 139.7671,
  address: '1 Chome-9-1 Marunouchi, Chiyoda City, Tokyo 100-0005, Japan',
  addressComponents: [
    { longText: 'Chiyoda City', shortText: 'Chiyoda City' },
    { longText: 'Tokyo', shortText: 'Tokyo' },
    { longText: 'Japan', shortText: 'JP' },
  ],
};

const TOKYO = { city: 'Tokyo', country: 'Japan', lat: 35.6812, lon: 139.7671 };

function memCache(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; }, async set(k, v) { map.set(k, v); } };
}

// ---------- the gate itself ----------

test('the NAME gate alone still accepts the wrong branch, which is why the geo gate exists', () => {
  // Not a bug being pinned, a limit being documented: "royce" and "chocolate"
  // genuinely are two thirds of "Royce' Chocolate World". A name can never
  // answer a question about WHERE, and this is what that looks like.
  const m = matchConfidence("Royce' Chocolate Tokyo Station", ROYCE_HOKKAIDO.name);
  assert.equal(m.confident, true);
  assert.ok(m.score > 0.5);
});

test('a candidate 800 km from the expected point is rejected', () => {
  const area = normalizeArea(TOKYO);
  const v = verifyArea(ROYCE_HOKKAIDO, area);
  assert.equal(v.ok, false);
  assert.equal(v.basis, 'point');
  assert.equal(v.reason, 'outside_radius');
  assert.ok(v.km > AREA_MAX_KM);
});

test('the same-city candidate passes the same gate', () => {
  const v = verifyArea(ROYCE_TOKYO, normalizeArea(TOKYO));
  assert.equal(v.ok, true);
  assert.equal(v.basis, 'point');
});

test('with no coordinate for the city, the ADDRESS answers instead', () => {
  const area = normalizeArea({ city: 'Tokyo', country: 'Japan' });
  assert.equal(verifyArea(ROYCE_HOKKAIDO, area).ok, false, 'Hokkaido address does not mention Tokyo');
  assert.equal(verifyArea(ROYCE_TOKYO, area).ok, true);
  assert.equal(verifyArea(ROYCE_TOKYO, area).basis, 'address');
});

test('the gate is generic: it rejects a wrong-city branch anywhere on earth', () => {
  // Same shape, no Japan involved: a Paris day, a London Ritz.
  const paris = normalizeArea({ city: 'Paris', country: 'France', lat: 48.8566, lon: 2.3522 });
  const ritzLondon = { name: 'The Ritz London', lat: 51.5074, lon: -0.1419, address: '150 Piccadilly, London W1J 9BR, UK' };
  const ritzParis = { name: 'Ritz Paris', lat: 48.8682, lon: 2.3287, address: '15 Place Vendôme, 75001 Paris, France' };
  assert.equal(verifyArea(ritzLondon, paris).ok, false);
  assert.equal(verifyArea(ritzParis, paris).ok, true);
  // and the other direction, so nothing here is tuned to one hemisphere
  const sydney = normalizeArea({ city: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093 });
  assert.equal(verifyArea({ name: 'x', lat: -37.8136, lon: 144.9631 }, sydney).ok, false, 'Melbourne is not Sydney');
});

test('a nearby suburb is NOT rejected: this is a wrong-continent gate, not a walking gate', () => {
  const area = normalizeArea(TOKYO);
  // Yokohama, ~30 km from Tokyo Station, is a legitimate resolution for a
  // Tokyo-area recommendation and must survive.
  assert.equal(verifyArea({ name: 'x', lat: 35.4437, lon: 139.638 }, area).ok, true);
  assert.ok(areaDistanceKm({ lat: 35.6812, lon: 139.7671 }, { lat: 35.4437, lon: 139.638 }) < AREA_MAX_KM);
});

test('no context means UNCHECKED, never verified', () => {
  const v = verifyArea(ROYCE_HOKKAIDO, null);
  assert.equal(v.ok, true, 'nothing was checked, so nothing is rejected');
  assert.equal(v.checked, false);
  // and the confidence is CAPPED, so no caller can mistake "we could not check"
  // for "we checked and it passed" - a perfect name match on an unverifiable
  // place still scores no better than the cap
  assert.equal(resolutionConfidence(1, v), UNCHECKED_MAX_CONFIDENCE);
});

test('a checked-and-failed candidate scores zero confidence', () => {
  assert.equal(resolutionConfidence(0.67, verifyArea(ROYCE_HOKKAIDO, normalizeArea(TOKYO))), 0);
});

test('addressMentions folds case, accents and administrative wording', () => {
  assert.equal(addressMentions('Chūō City, Tokyo 104-0045, Japan', 'tokyo'), true);
  assert.equal(addressMentions('Shimogyo Ward, Kyoto, 600-8001, Japan', 'Kyoto'), true);
  assert.equal(addressMentions('Chitose, Hokkaido, Japan', 'Tokyo'), false);
  assert.equal(addressMentions('', 'Tokyo'), false);
  assert.equal(addressMentions('Tokyo', ''), false);
});

test('addressTextOf reads the components too, so a localised address still resolves', () => {
  const text = addressTextOf({ address: '日本、〒100-0005 東京都千代田区丸の内１丁目', addressComponents: ROYCE_TOKYO.addressComponents });
  assert.equal(addressMentions(text, 'Tokyo'), true, 'the English component carries the city');
});

// ---------- the resolution pipeline ----------

// A faithful-enough Places double. The important fidelity is that a RESTRICTED
// search cannot return a place outside its box - that is the whole mechanism
// the retry leans on, and a mock that ignored the restriction would let a test
// pass for the wrong reason.
function spies(byQuery) {
  const calls = { search: [], details: [] };
  const inBox = (place, bias) => {
    if (!bias || !bias.restrict) return true;
    if (!place || !Number.isFinite(place.lat)) return true;
    return areaDistanceKm({ lat: bias.lat, lon: bias.lon }, { lat: place.lat, lon: place.lon })
      <= (bias.radiusM / 1000) * 1.5;
  };
  return {
    calls,
    findPlaceId: async (q, bias) => {
      calls.search.push({ q, bias });
      const hit = byQuery[q];
      if (!hit) return null;
      if (inBox(hit, bias)) return hit.id;
      // Restricted and outside the box: Google would answer with the nearest
      // thing that IS inside it, or with nothing.
      const inside = Object.values(byQuery).find(v => v !== hit && inBox(v, bias) && Number.isFinite(v.lat));
      return inside ? inside.id : null;
    },
    fetchDetails: async id => {
      calls.details.push(id);
      return Object.values(byQuery).find(v => v.id === id) || null;
    },
  };
}

const run = (queries, cache, s, budget = 10) =>
  resolveQueries({ queries, cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget });

test('THE REGRESSION: a Tokyo query that resolves to Hokkaido is refused, not rated', async () => {
  const s = spies({ "Royce' Chocolate Tokyo Station": { id: 'hokkaido', ...ROYCE_HOKKAIDO } });
  const { results } = await run(
    [{ id: 'k1', q: "Royce' Chocolate Tokyo Station", ...TOKYO }], memCache(), s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'wrong_area');
  // and NONE of the things that made the wrong answer look authoritative
  assert.equal(results[0].rating, undefined);
  assert.equal(results[0].lat, undefined);
  assert.equal(results[0].mapsUri, undefined);
  assert.equal(results[0].placeId, undefined);
});

test('the search is BIASED towards the expected area before anything is billed', async () => {
  const s = spies({ "Royce' Chocolate Tokyo Station": { id: 'tokyo', ...ROYCE_TOKYO } });
  await run([{ id: 'k1', q: "Royce' Chocolate Tokyo Station", ...TOKYO }], memCache(), s);
  const bias = s.calls.search[0].bias;
  assert.ok(bias, 'the itinerary point rides the free ID-only search');
  assert.equal(bias.lat, TOKYO.lat);
  assert.equal(bias.restrict, false, 'the first attempt hints, it does not exclude');
});

test('THE FIX: a rejected candidate earns one RESTRICTED retry, which finds the right branch', async () => {
  // The exact production shape. The first search is unrestricted, so Google
  // answers the chain name with its flagship; the retry is boxed to the
  // itinerary's own area, where the flagship cannot be returned at all.
  const s = spies({
    "Royce' Chocolate Tokyo Station": { id: 'hokkaido', ...ROYCE_HOKKAIDO },
    'other-in-tokyo': { id: 'tokyo', ...ROYCE_TOKYO },
  });
  const { results, spent } = await run([{ id: 'k1', q: "Royce' Chocolate Tokyo Station", ...TOKYO }], memCache(), s);
  assert.equal(results[0].status, 'ok', 'the retry found the branch that was actually meant');
  assert.equal(results[0].rating, ROYCE_TOKYO.rating);
  assert.equal(results[0].placeId, 'tokyo');
  assert.equal(results[0].verified, true);
  assert.equal(spent, 2, 'two billed Place Details calls: the wrong one and the right one');
  assert.equal(s.calls.search.length, 2);
  assert.equal(s.calls.search[0].bias.restrict, false);
  assert.equal(s.calls.search[1].bias.restrict, true, 'the retry RESTRICTS rather than hints');
});

test('the retry also spells the city into the query when the query does not name it', async () => {
  const s = spies({
    'Takashimaya': { id: 'nihonbashi', name: 'Takashimaya', rating: 4.2, userRatingCount: 9, mapsUri: 'https://maps.google.com/?cid=1', lat: 35.6813, lon: 139.7745, address: 'Nihonbashi, Chuo City, Tokyo, Japan' },
    'Takashimaya, Kyoto': { id: 'kyoto', name: 'Takashimaya Kyoto Store', rating: 4.1, userRatingCount: 8, mapsUri: 'https://maps.google.com/?cid=2', lat: 34.9987, lon: 135.7686, address: 'Shimogyo Ward, Kyoto, Japan' },
  });
  const { results } = await run([{ id: 'k', q: 'Takashimaya', city: 'Kyoto', country: 'Japan', lat: 35.0116, lon: 135.7681 }], memCache(), s);
  assert.equal(s.calls.search[1].q, 'Takashimaya, Kyoto');
  assert.equal(results[0].placeId, 'kyoto');
});

test('the retry is bounded: a second wrong answer ends the question', async () => {
  // Nothing inside the box, so the restricted search finds nothing and the
  // question is closed rather than paid for a third time.
  const s = spies({ "Royce' Chocolate Tokyo Station": { id: 'hokkaido', ...ROYCE_HOKKAIDO } });
  const { results, spent } = await run([{ id: 'k1', q: "Royce' Chocolate Tokyo Station", ...TOKYO }], memCache(), s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'wrong_area');
  assert.equal(spent, 1, 'the retry search found nothing, so nothing more was billed');
  assert.equal(s.calls.search.length, 2, 'searching is free; only Place Details is billed');
});

test('the retry never happens without a budget slot for it', async () => {
  const s = spies({
    "Royce' Chocolate Tokyo Station": { id: 'hokkaido', ...ROYCE_HOKKAIDO },
    "Royce' Chocolate Tokyo Station, Tokyo": { id: 'tokyo', ...ROYCE_TOKYO },
  });
  const { results, spent } = await run([{ id: 'k1', q: "Royce' Chocolate Tokyo Station", ...TOKYO }], memCache(), s, 1);
  assert.equal(spent, 1);
  assert.equal(results[0].status, 'no_match', 'refused rather than guessed');
});

test('an accepted result carries the canonical identity the client persists', async () => {
  const s = spies({ 'Takashimaya Kyoto Store': { id: 'kyoto-takashimaya', name: 'Takashimaya Kyoto Store', rating: 4.1, userRatingCount: 5400, mapsUri: 'https://maps.google.com/?cid=3', lat: 34.9987, lon: 135.7686, address: '52 Shincho, Shimogyo Ward, Kyoto, 600-8001, Japan' } });
  const { results } = await run(
    [{ id: 'k2', q: 'Takashimaya Kyoto Store', city: 'Kyoto', country: 'Japan', lat: 35.0116, lon: 135.7681 }], memCache(), s);
  assert.equal(results[0].id, 'k2', 'the client key is echoed untouched');
  assert.equal(results[0].placeId, 'kyoto-takashimaya');
  assert.equal(results[0].verified, true);
  assert.equal(results[0].areaBasis, 'point');
  assert.ok(results[0].confidence > 0.6);
  assert.equal(results[0].lat, 34.9987);
});

test('an UNRATED place still resolves to an identity, a point and its hours', async () => {
  const s = spies({ 'Tiny Counter Kyoto': { id: 'tiny', name: 'Tiny Counter', rating: null, lat: 35.0, lon: 135.77, address: 'Kyoto, Japan', hours: { always: true, periods: [], special: [] } } });
  const { results } = await run([{ id: 'k3', q: 'Tiny Counter Kyoto', city: 'Kyoto', lat: 35.0116, lon: 135.7681 }], memCache(), s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'unrated');
  assert.equal(results[0].placeId, 'tiny', 'no stars is not no place');
  assert.equal(results[0].verified, true);
  assert.equal(results[0].lat, 35.0);
});

// ---------- cache isolation ----------

test('CACHE ISOLATION: one business name in two cities is two entries', () => {
  const tokyo = normalizeArea({ city: 'Tokyo' });
  const kyoto = normalizeArea({ city: 'Kyoto' });
  assert.notEqual(idCacheKey('Takashimaya', tokyo), idCacheKey('Takashimaya', kyoto));
  assert.equal(areaCacheKey(tokyo), 'tokyo');
  // and a context-free lookup keeps the old global key, so nothing that never
  // had geography silently changes shape
  assert.equal(idCacheKey('Takashimaya'), 'id:takashimaya');
});

test('two cities asking the same name in ONE batch get their own answers', async () => {
  const cache = memCache();
  const s = spies({
    'Takashimaya': { id: 'nihonbashi', name: 'Takashimaya', rating: 4.2, userRatingCount: 9, mapsUri: 'https://maps.google.com/?cid=1', lat: 35.6813, lon: 139.7745, address: 'Nihonbashi, Chuo City, Tokyo, Japan' },
    'Takashimaya, Kyoto': { id: 'kyoto', name: 'Takashimaya Kyoto Store', rating: 4.1, userRatingCount: 8, mapsUri: 'https://maps.google.com/?cid=2', lat: 34.9987, lon: 135.7686, address: 'Shimogyo Ward, Kyoto, Japan' },
  });
  const { results } = await run([
    { id: 'takashimaya@tokyo', q: 'Takashimaya', city: 'Tokyo', lat: 35.6812, lon: 139.7671 },
    { id: 'takashimaya@kyoto', q: 'Takashimaya', city: 'Kyoto', lat: 35.0116, lon: 135.7681 },
  ], cache, s);
  const byId = Object.fromEntries(results.map(r => [r.id, r]));
  assert.equal(byId['takashimaya@tokyo'].placeId, 'nihonbashi');
  assert.equal(byId['takashimaya@kyoto'].placeId, 'kyoto', 'the Kyoto card did NOT get the Tokyo flagship');
  assert.equal(cache.map.size, 2, 'two cache entries, never one shared');
});

test('a cached place ID from one city is never served to another', async () => {
  // The 30-day place-ID cache is the layer that would have made the 809 km
  // answer permanent: one entry named "royce chocolate", read by every city.
  const cache = memCache({
    [idCacheKey('Takashimaya', normalizeArea({ city: 'Tokyo', lat: 35.6812, lon: 139.7671 }))]:
      { placeId: 'nihonbashi', at: NOW - 1000 },
  });
  const s = spies({ 'Takashimaya': { id: 'kyoto', name: 'Takashimaya Kyoto Store', rating: 4.1, userRatingCount: 8, mapsUri: 'https://maps.google.com/?cid=2', lat: 34.9987, lon: 135.7686, address: 'Shimogyo Ward, Kyoto, Japan' } });
  const { results } = await run([{ id: 'k', q: 'Takashimaya', city: 'Kyoto', country: 'Japan', lat: 35.0116, lon: 135.7681 }], cache, s);
  assert.equal(results[0].placeId, 'kyoto', 'the Kyoto question got a Kyoto answer');
  assert.equal(s.calls.details.includes('nihonbashi'), false, 'the Tokyo entry was never even fetched');
  assert.equal(cache.map.size, 2, 'the Tokyo entry survives beside its own, un-poisoned');
});

// ---------- the wire contract ----------

test('a bare string still resolves, and reports itself as unverified', async () => {
  const s = spies({ 'Ichiran Shibuya': { id: 'i', name: 'Ichiran Shibuya', rating: 4.2, userRatingCount: 5, mapsUri: 'https://maps.google.com/?cid=1', lat: 35.66, lon: 139.7 } });
  const { results } = await run(['Ichiran Shibuya'], memCache(), s);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].verified, false, 'no context supplied, so nothing was checked');
  assert.equal(results[0].id, 'Ichiran Shibuya');
  assert.equal(s.calls.search[0].bias, null);
});

test('toEntry normalizes both accepted shapes and drops junk', () => {
  assert.deepEqual(toEntry('  x  '), { id: 'x', query: 'x', area: null });
  const e = toEntry({ q: 'x', id: 'k', city: 'Tokyo', lat: 35.6, lon: 139.7 });
  assert.equal(e.id, 'k');
  assert.equal(e.area.city, 'Tokyo');
  assert.deepEqual(e.area.point, { lat: 35.6, lon: 139.7 });
  assert.equal(toEntry(null), null);
  assert.equal(toEntry({ q: '' }), null);
});

test('clampBody bounds every field of a structured query and dedupes on the ID', () => {
  const out = clampBody({
    clientId: 'c1',
    queries: [
      { q: 'A', id: 'a@tokyo', city: 'Tokyo', country: 'Japan', lat: 35.6, lon: 139.7 },
      { q: 'A', id: 'a@tokyo' },                       // same id -> collapsed
      { q: 'A', id: 'a@kyoto', city: 'Kyoto' },        // same TEXT, different area -> kept
      { q: 'B', city: 'x'.repeat(500), lat: 999, lon: 0 },
      'plain string',
      { q: '' }, null, 42,
    ],
  });
  assert.deepEqual(out.queries.map(q => q.id), ['a@tokyo', 'a@kyoto', 'B', 'plain string']);
  assert.equal(out.queries[2].city.length, 80, 'the city is clamped before it reaches a text query');
  assert.equal(out.queries[2].lat, undefined, 'an out-of-range coordinate never travels');
});

test('rectangleAround builds a sane box at any latitude', () => {
  const eq = rectangleAround({ lat: 0, lon: 0, radiusM: 111000 });
  assert.ok(Math.abs(eq.high.latitude - 1) < 0.01);
  const arctic = rectangleAround({ lat: 78, lon: 15, radiusM: 30000 });
  assert.ok(arctic.high.longitude > arctic.low.longitude);
  assert.ok(arctic.high.latitude <= 90 && arctic.low.latitude >= -90);
});

test('the resolution log records the decision without any secret', async () => {
  const seen = [];
  const s = spies({ "Royce' Chocolate Tokyo Station": { id: 'hokkaido', ...ROYCE_HOKKAIDO } });
  await resolveQueries({
    queries: [{ id: 'k', q: "Royce' Chocolate Tokyo Station", ...TOKYO }],
    cache: memCache(), findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails,
    now: NOW, budget: 5, log: rec => seen.push(rec),
  });
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].verdict.kept, false);
  assert.equal(seen[0].verdict.reason, 'wrong_area');
  assert.equal(seen[0].expected.city, 'Tokyo');
  assert.ok(seen[0].candidate.address.includes('Hokkaido'));
  assert.equal(seen[0].area.km > 800, true);
  const dump = JSON.stringify(seen);
  assert.ok(!/apiKey|X-Goog|clientId/i.test(dump), 'no credential and no client identifier is ever logged');
});
