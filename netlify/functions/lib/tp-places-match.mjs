// Pure matching logic for tp-places. No I/O, so node:test can pin every
// decision that keeps a rating off the wrong restaurant.
//
// The assistant attaches a `mapsQuery` to every venue it proposes, and those
// strings are written for a human opening Google Maps, not for an exact-match
// API. They come in two flavours:
//   "Ichiran Ramen Shibuya Tokyo"          -> a real, findable venue
//   "Convenience Store (Konbini) Breakfast" -> a category, not a place
// Text Search will happily return SOME place for the second one. Showing
// "4.1 (2,318)" next to a generic breakfast suggestion is worse than showing
// nothing, because the traveller reads it as a fact about a specific shop, so
// both a pre-filter (cheap, saves a billed call) and a post-filter (correct)
// exist here.

// Words that describe a KIND of place or a meal slot rather than a specific
// venue. A query made only of these can never identify one business, so it is
// rejected before any upstream call is made.
const GENERIC_TOKENS = new Set([
  'a', 'an', 'and', 'at', 'for', 'in', 'near', 'nearby', 'of', 'on', 'or', 'the', 'to', 'with',
  'breakfast', 'brunch', 'lunch', 'dinner', 'supper', 'snack', 'snacks', 'drinks', 'drink',
  'coffee', 'tea', 'dessert', 'desserts', 'street', 'food', 'meal', 'takeaway', 'takeout',
  'restaurant', 'restaurants', 'cafe', 'cafes', 'coffeeshop', 'bar', 'bars', 'pub', 'pubs',
  'izakaya', 'bistro', 'diner', 'eatery', 'shop', 'shops', 'store', 'stores', 'market',
  'convenience', 'konbini', 'supermarket', 'bakery', 'stall', 'stand', 'kiosk', 'chain',
  'local', 'best', 'top', 'good', 'cheap', 'popular', 'traditional', 'authentic', 'famous',
  'area', 'district', 'neighborhood', 'neighbourhood', 'station', 'hotel', 'place', 'places',
  'spot', 'spots', 'venue', 'option', 'options', 'any', 'some', 'your', 'my',
  // Cuisines and dishes. A venue is often named after what it serves ("Ramen
  // Nagi", "Sushi Zanmai"), but the dish word alone never identifies it, and
  // "local ramen restaurant" must not buy a lookup.
  'ramen', 'sushi', 'sashimi', 'yakitori', 'udon', 'soba', 'tempura', 'curry', 'noodle',
  'noodles', 'dumplings', 'pizza', 'pasta', 'burger', 'burgers', 'sandwich', 'sandwiches',
  'bbq', 'barbecue', 'seafood', 'steak', 'steakhouse', 'tapas', 'kebab', 'falafel',
  'pastry', 'pastries', 'gelato', 'wine', 'beer', 'cocktail', 'cocktails', 'sake',
  'vegan', 'vegetarian', 'halal', 'kosher', 'gluten', 'free',
]);

// Normalize for comparison: strip diacritics and punctuation, collapse space.
// Punctuation goes because the assistant writes "Ichiran (Shibuya branch)" and
// Google returns "Ichiran Shibuya".
export function normalizeQuery(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s) {
  const n = normalizeQuery(s);
  return n ? n.split(' ') : [];
}

// Tokens that could actually name a business. Single characters are dropped:
// they carry no identifying signal in latin text, and CJK strings survive as a
// whole run anyway (see the substring check in matchConfidence).
function distinctiveTokens(s) {
  return tokens(s).filter(t => t.length > 1 && !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t));
}

// True when the query names no specific business, only a category and/or a meal
// slot. Callers must skip the upstream lookup entirely for these: it costs
// money and can only produce a wrong answer.
export function isGenericQuery(s) {
  return distinctiveTokens(s).length === 0;
}

// How much of the place Google returned is actually accounted for by the query.
// Scored over the PLACE's distinctive tokens, not the query's: the query is
// usually longer (it carries city, cuisine and neighbourhood as search hints),
// so scoring over the query would punish a perfect match. A returned place
// whose own name is mostly absent from the query is a different business.
export function matchConfidence(query, placeName) {
  const q = normalizeQuery(query);
  const p = normalizeQuery(placeName);
  if (!q || !p) return { score: 0, confident: false };

  // Whole-name containment covers scripts we cannot tokenize on whitespace
  // (Japanese, Chinese, Korean) and exact hits like "teamLab Planets TOKYO".
  if (q.includes(p) || p.includes(q)) return { score: 1, confident: true };

  const pTokens = distinctiveTokens(placeName);
  if (!pTokens.length) return { score: 0, confident: false };
  const qSet = new Set(tokens(query));

  const hits = pTokens.filter(t => qSet.has(t)).length;
  const score = hits / pTokens.length;
  // Strictly MORE than half the name, which is what separates the two cases
  // that matter: "dinner in Shibuya" -> "Gonpachi Shibuya" scores exactly 0.5
  // on the district alone and must be rejected, while "Nabezo Shinjuku" ->
  // "Nabezo Shinjuku Sanchome" scores 0.67 on the real name and must pass.
  return { score: Math.round(score * 100) / 100, confident: score > 0.5 };
}

// ---------- geographic verification ----------
// THE FAILURE THIS SECTION EXISTS FOR. On 2026-08-27 the assistant proposed
// "Royce' Chocolate (Tokyo Station)" for a Tokyo day. Text Search, asked
// globally with pageSize 1, answered with ROYCE' Chocolate World at New Chitose
// Airport in Hokkaido - the chain's flagship, 809 km away. matchConfidence
// scored it 0.67 ("royce" and "chocolate" of "royce chocolate world") and
// waved it through, so the card wore Hokkaido's rating, Hokkaido's cid link and
// Hokkaido's coordinates, and the distance chip printed 809 km from Tsukiji.
//
// The name gate was never wrong about names. It simply has no opinion about
// WHERE, and a chain is precisely the case where the name cannot decide: every
// Royce', every Starbucks, every Takashimaya and every Hilton shares a name
// with dozens of businesses on other continents. So the name gate keeps its
// job (is this the same BUSINESS?) and this one answers the other half (is it
// the same BRANCH, in the area the itinerary is actually about?).
//
// Both gates must pass. A candidate that fails this one is rejected outright
// rather than shown with a caveat: a rating, a distance and an opening-hours
// line about the wrong branch are three confident-looking lies, and the
// traveller has no way to tell.

// How far from the expected point a candidate may sit and still be "in the
// area". Deliberately generous: it has to hold every metropolitan area on
// earth (Tokyo's 23 wards span ~40 km, Greater London ~45 km, Los Angeles
// County ~120 km) plus the ordinary case of a city centroid that is a few tens
// of km off whatever suburb the venue is in. It is a WRONG-CONTINENT gate, not
// a walking-distance gate: 809 km, 4,000 km and 12,000 km are what it is here
// to stop, and every one of those is an order of magnitude past this.
export const AREA_MAX_KM = 150;
// The tighter radius used to BIAS the upstream search (not to judge the
// answer). Biasing is a hint, so it can be tight without excluding anything.
export const AREA_BIAS_KM = 30;

const EARTH_KM = 6371;
const rad = d => (d * Math.PI) / 180;

// Straight-line distance, the same haversine the client draws its chips with.
// Nothing here needs more precision than "is this the same metropolitan area".
export function areaDistanceKm(a, b) {
  if (!isPoint(a) || !isPoint(b)) return null;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function isPoint(p) {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

// The area a query is expected to resolve inside, normalized from whatever the
// client could supply. Every field is optional and the object is only as strong
// as its strongest field, which is the point: a trip that has geocoded its
// city gets a coordinate check, one that has not still gets the address check,
// and a query with no context at all is reported as unchecked rather than
// quietly treated as verified.
export function normalizeArea(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n).trim() : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const lat = num(a.lat), lon = num(a.lon);
  const point = isPoint({ lat, lon }) ? { lat, lon } : null;
  const radiusKm = Number.isFinite(a.radiusKm) && a.radiusKm > 0
    ? Math.min(AREA_MAX_KM * 4, a.radiusKm) : AREA_MAX_KM;
  const city = str(a.city, 80);
  const country = str(a.country, 80);
  if (!point && !city && !country) return null;
  return { city, country, point, radiusKm };
}

// Does this address text account for the expected city (or, failing that, the
// expected country)? Both sides are folded through normalizeQuery, so
// "Chūō City, Tokyo 104-0045, Japan" and "tokyo" meet on the same ground.
//
// Substring rather than token equality on purpose: administrative naming is
// not consistent enough for anything stricter ("Kyoto" appears as "Kyoto",
// "Kyoto City" and "Kyoto Prefecture"; "New York" is two tokens). The check is
// only ever used to CONFIRM, never on its own to reject a place that a
// coordinate already vouched for.
export function addressMentions(address, term) {
  const hay = normalizeQuery(address);
  const needle = normalizeQuery(term);
  if (!hay || !needle) return false;
  if (hay.includes(needle)) return true;
  // A multi-word expectation counts when its distinctive words are all present
  // ("Chuo City Tokyo" contains the "Tokyo" of "Tokyo Station Tokyo").
  const words = needle.split(' ').filter(w => w.length > 2 && !GENERIC_TOKENS.has(w));
  return words.length > 0 && words.every(w => hay.includes(w));
}

// The address text a Places result offers, in one string: the formatted
// address plus every administrative component's long and short name. Google
// localises formattedAddress but keeps the components, so a Japanese-language
// address still yields "Tokyo" through the components.
export function addressTextOf(place) {
  const parts = [];
  if (place && typeof place.address === 'string') parts.push(place.address);
  const comps = place && Array.isArray(place.addressComponents) ? place.addressComponents : [];
  for (const c of comps) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.longText === 'string') parts.push(c.longText);
    if (typeof c.shortText === 'string') parts.push(c.shortText);
  }
  return parts.filter(Boolean).join(', ');
}

// THE GATE. Returns the verdict plus the evidence behind it, because the
// evidence is what makes a rejection debuggable in a function log six weeks
// from now ("rejected: 809 km from the expected point" reads; "rejected" does
// not).
//
//   basis 'point'   - a coordinate was compared, the strongest answer
//   basis 'address' - the city/country was looked for in the address
//   basis 'none'    - no usable context was supplied; nothing was checked
//
// `ok` is false ONLY when something was actually checked and disagreed. An
// unchecked candidate comes back ok:true with checked:false, so the caller can
// decide what an unverifiable place is worth without this function pretending
// to have verified it.
export function verifyArea(place, area) {
  if (!area) return { ok: true, checked: false, basis: 'none', reason: 'no_area' };
  const at = isPoint(place) ? { lat: place.lat, lon: place.lon } : null;

  if (area.point && at) {
    const km = areaDistanceKm(area.point, at);
    const ok = km != null && km <= area.radiusKm;
    return {
      ok, checked: true, basis: 'point', km: km == null ? null : Math.round(km),
      reason: ok ? 'in_area' : 'outside_radius',
    };
  }

  const text = addressTextOf(place);
  if (text && (area.city || area.country)) {
    if (area.city && addressMentions(text, area.city)) {
      return { ok: true, checked: true, basis: 'address', reason: 'city_match' };
    }
    if (area.country && addressMentions(text, area.country)) {
      // The country agreeing while the city does not is the weakest pass this
      // gate gives: it stops a Tokyo query resolving to Hokkaido only when the
      // city name is genuinely absent from the address, which it is here. It
      // is reported as a distinct reason so the confidence score can mark it
      // down and the log can show why a card looked shaky.
      return {
        ok: !area.city, checked: true, basis: 'address',
        reason: area.city ? 'city_missing' : 'country_match',
      };
    }
    return { ok: false, checked: true, basis: 'address', reason: 'address_mismatch' };
  }

  // Context existed but the place carried nothing to compare it against
  // (no coordinates, no address). Unverifiable, not wrong.
  return { ok: true, checked: false, basis: 'none', reason: 'no_evidence' };
}

// One number for "how sure are we that this Maps entity is the place the
// recommendation meant". The name score is the base; the area verdict scales
// it.
//
// UNCHECKED_MAX is the ceiling on a candidate nothing could verify, and it sits
// deliberately below any score a CHECKED candidate can reach (the weakest
// passing name score is just over 0.5, scaled by 0.8 at worst, so a checked
// result lands at 0.4+ - and every checked result also carries verified:true,
// which is the field callers actually gate on). The cap is what stops a
// confident-looking 1.0 being attached to a resolution nobody could confirm.
export const UNCHECKED_MAX_CONFIDENCE = 0.5;
export function resolutionConfidence(nameScore, area) {
  const base = Math.max(0, Math.min(1, Number(nameScore) || 0));
  if (!area || !area.checked) return Math.round(Math.min(base, UNCHECKED_MAX_CONFIDENCE) * 100) / 100;
  if (!area.ok) return 0;
  // A point check is worth more than an address mention, and an address
  // mention of the country alone is worth less than one of the city.
  const weight = area.basis === 'point' ? 1 : (area.reason === 'city_match' ? 0.95 : 0.8);
  return Math.round(base * weight * 100) / 100;
}
