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
