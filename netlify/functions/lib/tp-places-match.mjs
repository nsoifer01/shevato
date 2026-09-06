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

// The words an AREA contributes to a query, which are search hints rather than
// part of the venue's name. "Kata Beach" in a mapsQuery says WHERE to look; it
// does not claim the business is called that.
function areaWords(area) {
  const out = new Set();
  if (!area || typeof area !== 'object') return out;
  for (const v of [area.city, area.country]) {
    for (const w of tokens(v)) out.add(w);
  }
  return out;
}

// True when each name carries an identifying word the other lacks. See the
// note in matchConfidence: this is the chain-sibling signal.
export function hasCompetingDiscriminator(query, placeName, area) {
  const skip = areaWords(area);
  const qTok = distinctiveTokens(query).filter(t => !skip.has(t));
  const pTok = distinctiveTokens(placeName).filter(t => !skip.has(t));
  if (!qTok.length || !pTok.length) return false;
  const qSet = new Set(qTok), pSet = new Set(pTok);
  const placeAdds = pTok.some(t => !qSet.has(t));
  const queryAdds = qTok.some(t => !pSet.has(t));
  return placeAdds && queryAdds;
}

// How much of the place Google returned is actually accounted for by the query.
// Scored over the PLACE's distinctive tokens, not the query's: the query is
// usually longer (it carries city, cuisine and neighbourhood as search hints),
// so scoring over the query would punish a perfect match. A returned place
// whose own name is mostly absent from the query is a different business.
export function matchConfidence(query, placeName, area) {
  const q = normalizeQuery(query);
  const p = normalizeQuery(placeName);
  if (!q || !p) return { score: 0, confident: false };

  // Whole-name containment covers scripts we cannot tokenize on whitespace
  // (Japanese, Chinese, Korean) and exact hits like "teamLab Planets TOKYO".
  if (q.includes(p) || p.includes(q)) return { score: 1, confident: true };

  const pTokens = distinctiveTokens(placeName);
  if (!pTokens.length) return { score: 0, confident: false };
  const qSet = new Set(tokens(query));

  // COMPETING DISCRIMINATORS (owner report, 2026-09-05, found while verifying
  // the fix above against production).
  //
  //   asked for  "Sugar Marina Hotel -FASHION- Kata Beach"
  //   got back   "Sugar Marina Hotel -POP- Kata Beach"
  //
  // A different hotel of the same chain, 350 m up the same beach. It scored
  // 0.80 and walked through, because four of the place's five distinctive
  // words ("sugar", "marina", "kata", "beach") really are in the query. Chains
  // name their properties exactly like this - one word apart, and that word is
  // the whole identity: -POP- / -FASHION- / -SURF- / -ART-.
  //
  // The signal is MUTUAL disagreement. When the place carries a distinctive
  // word the query never asked for AND the query carries one the place does
  // not have, the two names are not a longer and a shorter form of one
  // business - they are two businesses whose discriminators contradict. One
  // sided extras stay fine, and that is what keeps the ordinary cases working:
  // "Nabezo Shinjuku" -> "Nabezo Shinjuku Sanchome" (only the place adds a
  // word) and "Ichiran (Shibuya branch)" -> "Ichiran Shibuya" (only the query
  // does) both still pass.
  //
  // The query's own AREA words are excluded before this is judged, because a
  // mapsQuery legitimately carries the city as a search hint rather than as a
  // discriminator - that is what stops "Royce' Chocolate Tokyo Station" being
  // read as contradicting "ROYCE' Chocolate World" over the word "Tokyo". That
  // one is a WRONG BRANCH, and the geographic gate is what answers it.
  if (hasCompetingDiscriminator(query, placeName, area)) {
    return { score: 0, confident: false, reason: 'competing_discriminator' };
  }

  const hits = pTokens.filter(t => qSet.has(t)).length;
  const score = hits / pTokens.length;
  // Strictly MORE than half the name, which is what separates the two cases
  // that matter: "dinner in Shibuya" -> "Gonpachi Shibuya" scores exactly 0.5
  // on the district alone and must be rejected, while "Nabezo Shinjuku" ->
  // "Nabezo Shinjuku Sanchome" scores 0.67 on the real name and must pass.
  return { score: Math.round(score * 100) / 100, confident: score > 0.5 };
}

// ---------- entity-type verification ----------
// THE FAILURE THIS SECTION EXISTS FOR (owner report, 2026-09-05).
//
//   asked for  "Maya Bay Ko Phi Phi"   - a beach, boat access, 7 km offshore
//   got back   "Maya Bay Tours"        - a tour desk, 100 m from the hotel
//
// matchConfidence scored it 0.67 and waved it through: two of the place's three
// distinctive words ("maya", "bay") really are in the query, and the extra one
// is one-sided, which the chain-sibling rule deliberately permits. The area
// gate then agreed enthusiastically, because the tour desk is nearer than the
// beach. Every gate said yes and the traveller got a shop instead of a lagoon.
//
// Proximity must never decide identity. What separates these two is not where
// they are, it is WHAT THEY ARE, and the name says so: a business that sells
// access to a landmark advertises itself with the landmark's name plus a word
// naming the trade. Those words are a closed list here, because the cost of a
// false positive is deleting a real venue whose name happens to contain one.

// Words that name the TRADE rather than the thing. A place whose name is the
// query plus one of these is a broker for the thing the query asked about, not
// the thing itself. Kept deliberately small and unambiguous: every entry is a
// word that no beach, temple, museum or restaurant is called on its own.
const BROKER_WORDS = new Set([
  'tour', 'tours', 'tour', 'tourism', 'excursion', 'excursions', 'trip', 'trips',
  'ticket', 'tickets', 'booking', 'bookings', 'reservation', 'reservations',
  'agency', 'agent', 'agents', 'travel', 'traveland', 'operator', 'operators',
  'rental', 'rentals', 'rent', 'hire', 'charter', 'charters',
  'transfer', 'transfers', 'shuttle', 'taxi', 'transport', 'transportation',
  'guide', 'guides', 'guiding', 'office', 'desk', 'counter', 'center', 'centre',
]);

// True when the PLACE advertises a trade the QUERY never asked for. One-sided
// on purpose and only in that direction: asking for "Maya Bay Tours" and
// getting "Maya Bay Tours" is a perfect match, and asking for "Phi Phi Tour
// Center" must still find it. Area words are stripped first for the same
// reason matchConfidence strips them - a city in a mapsQuery is a search hint.
export function addsBrokerWord(query, placeName, area) {
  const skip = areaWords(area);
  const qTok = new Set(distinctiveTokens(query).filter(t => !skip.has(t)));
  const pTok = distinctiveTokens(placeName).filter(t => !skip.has(t));
  if (!pTok.length) return '';
  for (const t of pTok) {
    if (BROKER_WORDS.has(t) && !qTok.has(t)) return t;
  }
  return '';
}

// ---------- coarse entity kinds, from Google's own place types ----------
// The `types` and `primaryType` fields ride the SAME billed Place Details call
// (Essentials and Pro respectively, both below the Enterprise tier the request
// already pays for), so this evidence is free. It is collapsed to a handful of
// coarse kinds because that is all the decision needs: a temple is not a cafe,
// a beach is not a booking office, and no finer distinction is worth the risk
// of refusing a real venue.
const KIND_BY_TYPE = new Map(Object.entries({
  // natural features and open-air landmarks
  beach: 'nature', natural_feature: 'nature', national_park: 'nature',
  hiking_area: 'nature', park: 'nature', state_park: 'nature', garden: 'nature',
  botanical_garden: 'nature', wildlife_park: 'nature', wildlife_refuge: 'nature',
  marina: 'nature', campground: 'nature', rv_park: 'nature',
  // places of worship
  church: 'worship', hindu_temple: 'worship', mosque: 'worship',
  synagogue: 'worship', place_of_worship: 'worship',
  // culture and sights
  museum: 'culture', art_gallery: 'culture', historical_landmark: 'culture',
  historical_place: 'culture', monument: 'culture', cultural_landmark: 'culture',
  observation_deck: 'culture', aquarium: 'culture', zoo: 'culture',
  amusement_park: 'culture', water_park: 'culture',
  // food and drink
  restaurant: 'food', cafe: 'food', coffee_shop: 'food', bar: 'food',
  bakery: 'food', meal_takeaway: 'food', meal_delivery: 'food',
  fast_food_restaurant: 'food', ice_cream_shop: 'food', dessert_shop: 'food',
  pub: 'food', wine_bar: 'food', bar_and_grill: 'food', food_court: 'food',
  // lodging
  hotel: 'lodging', lodging: 'lodging', resort_hotel: 'lodging',
  motel: 'lodging', hostel: 'lodging', guest_house: 'lodging',
  bed_and_breakfast: 'lodging', campground_lodging: 'lodging',
  // brokers: they sell access to the things above
  travel_agency: 'broker', car_rental: 'broker', car_dealer: 'broker',
  real_estate_agency: 'broker', insurance_agency: 'broker',
  taxi_stand: 'broker', tour_agency: 'broker', ticket_agency: 'broker',
}));

/**
 * The coarse kind of a Places result, or '' when its types say nothing this
 * function has an opinion about. `primaryType` wins when it maps, because it is
 * Google's own answer to "what IS this"; otherwise the first mappable entry of
 * `types` is used. An empty answer is the normal case for the long tail and
 * must never be read as a mismatch.
 */
export function placeKind(place) {
  const primary = place && typeof place.primaryType === 'string' ? place.primaryType : '';
  if (primary && KIND_BY_TYPE.has(primary)) return KIND_BY_TYPE.get(primary);
  const list = place && Array.isArray(place.types) ? place.types : [];
  for (const t of list) {
    if (typeof t === 'string' && KIND_BY_TYPE.has(t)) return KIND_BY_TYPE.get(t);
  }
  return '';
}

// Which kinds a query is asking for. THE ONLY SOURCE IS THE ITINERARY'S OWN
// MEAL SLOT, and that restraint is the whole design.
//
// The obvious implementation - read kind words out of the query text ("bay",
// "temple", "park") - was written, measured against real fixtures, and thrown
// away. Those words are not categories, they are parts of names:
//
//   "The Mango Garden"        garden -> nature, so a restaurant is a mismatch
//   "Phi Phi Island Village"  island -> nature, so a hotel is a mismatch
//   "Temple Bar, Dublin"      temple -> worship, so a pub is a mismatch
//   "Long Beach Resort"       beach  -> nature, so lodging is a mismatch
//
// Every one of those is a correct answer this gate would have deleted, and
// deleting a real venue is the exact failure the whole round is about. A meal
// slot is different in kind: it is STRUCTURED metadata the itinerary assigned,
// not a word guessed out of prose, so it cannot be a coincidence of naming.
//
// What covers the rest is the broker rule above plus `broker` as a KIND, which
// need no guess about what the traveller meant: a booking desk is essentially
// never the right answer to a query that did not ask for one, whatever the
// thing being booked happens to be.
export function expectedKinds(query, meal) {
  const out = new Set();
  if (meal) out.add('food');
  return out;
}

// Does the query itself ask for the trade? "Maya Bay Tours" and "Phi Phi Dive
// Center" do; "Maya Bay" does not.
export function queryWantsBroker(query) {
  return distinctiveTokens(query).some(t => BROKER_WORDS.has(t));
}

// Kinds that can never be the same thing as the kind expected.
const INCOMPATIBLE = new Map(Object.entries({
  // `lodging` is deliberately absent from food's row: hotel restaurants and
  // resort breakfast rooms are real answers to a meal slot, and a gate that
  // refused them would delete correct recommendations to fix nothing.
  food: new Set(['nature', 'worship', 'broker']),
}));

/**
 * THE TYPE GATE. Returns '' when the candidate may stand, or the reason it may
 * not. Three checks, and any of them can refuse - but every one of them needs
 * POSITIVE evidence, so an absent `types` field, a query with no trade word
 * and an item with no meal slot all leave this silent. That also means a
 * deploy whose field mask predates `types` behaves exactly as it did before.
 *
 *   1. the place's NAME advertises a trade the query never asked for
 *      ("Maya Bay" -> "Maya Bay Tours"). Needs no provider types at all.
 *   2. Google says the place IS a broker and the query never asked for one
 *      ("Maya Bay" -> a travel agency that calls itself just "Maya Bay").
 *   3. the place's kind contradicts the itinerary's own meal slot (a beach
 *      offered as the 08:00 breakfast).
 */
export function typeMismatch(query, place, area, meal) {
  const broker = addsBrokerWord(query, (place && place.name) || '', area);
  if (broker) return 'broker_name';
  const kind = placeKind(place);
  if (!kind) return '';
  if (kind === 'broker' && !queryWantsBroker(query)) return 'broker_kind';
  const want = expectedKinds(query, meal);
  if (!want.size || want.has(kind)) return '';
  for (const w of want) {
    const bad = INCOMPATIBLE.get(w);
    if (bad && bad.has(kind)) return 'kind_mismatch';
  }
  return '';
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
      // WHY THIS IS NOT A REJECTION (fixed 2026-09-05, reported by the owner).
      // It used to be, and that is what made the assistant unusable across most
      // of the world's resort and island destinations.
      //
      // The expected city is a name a HUMAN wrote on an itinerary - "Railay
      // Beach", "Kata Beach", "Ao Nang", "Phi Phi". Google addresses that place
      // by its ADMINISTRATIVE chain - "Ao Nang, Mueang Krabi District, Krabi",
      // "Karon, Mueang Phuket District, Phuket". The two agree only when the
      // traveller happens to have typed the name of an administrative unit, so
      // for a beach, a resort strip, an island or any sub-locality they never
      // agree, and every real venue in the area was refused as `wrong_area`
      // with a name score of 1.00.
      //
      // A locality name that does not appear in an address is not EVIDENCE of
      // anything. It is the absence of evidence, and the module's own contract
      // (see addressMentions) says this check may only ever CONFIRM. So the
      // honest verdict is "could not check", which is a real state this
      // function already has: the caller gets an unverified resolution, which
      // carries no coordinate, draws no distance chip and links as "Verify on
      // Google Maps" rather than "Open". A wrong BRANCH is caught by the point
      // basis above, which is the branch that runs whenever a chip could
      // actually be drawn - and by the second look the caller now takes.
      return area.city
        ? { ok: true, checked: false, basis: 'address', reason: 'city_unconfirmed' }
        : { ok: true, checked: true, basis: 'address', reason: 'country_match' };
    }
    // A country that was expected and is genuinely absent from the address IS
    // evidence, and it is the wrong-continent case this gate exists for.
    if (area.country) {
      return { ok: false, checked: true, basis: 'address', reason: 'country_mismatch' };
    }
    // Only a city was expected and the address does not name it. Nothing
    // corroborates and nothing contradicts; see the note above.
    return { ok: true, checked: false, basis: 'address', reason: 'city_unconfirmed' };
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
