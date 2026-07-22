// Trip Planner Google-ratings lookup: a rate-limited, cached, shared-key proxy
// in front of the Places API (New), so assistant candidate cards can show a
// real rating instead of asking the traveller to trust the model. The browser
// sends the `mapsQuery` strings already attached to its candidates; this
// function resolves each one to a place, returns only rating / count / name /
// Maps link, and never returns the key or upstream detail.
//
// COST MODEL (checked against developers.google.com/maps/billing-and-pricing/
// pricing on 2026-07-19), and why the lookup is two calls rather than one:
//   Text Search Essentials (IDs Only), SKU 635D-A9DD-C520: unlimited, $0.00
//   Place Details Enterprise,          SKU 2D9A-3DE0-3766: 1,000 free/month,
//                                                          then $20.00 / 1000
//   Text Search Enterprise,            SKU E967-44BC-B44D: 1,000 free/month,
//                                                          then $35.00 / 1000
// Places API (New) bills per request at the HIGHEST SKU any requested field
// belongs to, and `rating` / `userRatingCount` are Enterprise fields. So doing
// it in one Text Search costs $0.035 per venue, while resolving the ID for free
// and then paying for one Place Details costs $0.020: a 43% saving, and the
// free search leaves the whole Enterprise allowance for ratings. The price of
// that saving is a second round trip on a cache miss.
//
// OWNER SETUP (one-time, out-of-band; env vars are NOT injected into functions
// on this site, so the key lives in a Blob):
//   1. Enable "Places API (New)" in the Google Cloud project, create an API key
//      restricted to that single API.
//   2. netlify blobs:set trip-planner-places config '{"placesKey":"<key>"}'
//   3. Disable again with: netlify blobs:set trip-planner-places config '{}'
// With no key set the endpoint returns 503 not_configured and the client simply
// renders candidate cards without ratings.
//
// OWNER TIER (optional): add "ownerToken":"<64+ random chars>" to that same
// config JSON, then on your own browsers run
//   localStorage.setItem('trip-planner:places:ownerToken', '<the token>')
// in the devtools console once. Requests carrying the matching token are
// governed by OWNER_LIMITS (10x public, separate buckets) instead of
// DEFAULT_LIMITS; see the isOwner block below. Rotate or revoke by rewriting
// the blob.
//
// The CLI must be linked to the site that actually serves shevato.com before
// running those commands; the blob store is per-site, so writing it while
// linked to any other project leaves this endpoint on 503.
//
// ATTRIBUTION: Google requires that content sourced from Google Maps be
// identified as such. The response carries the attribution the client must
// render next to any rating it shows; see ATTRIBUTION below.

import { createHash, timingSafeEqual } from 'node:crypto';
import { checkQuota, releaseQuota, DEFAULT_LIMITS, OWNER_LIMITS } from './lib/tp-places-quota.mjs';
import { updateUsage } from './lib/tp-places-usage.mjs';
import { resolveQueries } from './lib/tp-places-lookup.mjs';
import { isGenericQuery } from './lib/tp-places-match.mjs';

// The Blob store pulls in @netlify/blobs (installed only in the Netlify build,
// gitignored locally). It is imported lazily below, after the origin/method/
// body guards, so those guards stay unit-testable without the dependency.

// 12 venues is a full day of assistant candidates (3 meal slots + drinks, with
// 2-3 alternatives each) and bounds one request at 12 x $0.02 = $0.24 worst
// case. A longer itinerary is several batches, which the quota then governs.
const MAX_QUERIES = 12;
// Matches the 200-char clamp trip-logic.js already applies to mapsQuery, so a
// query that survived the client cannot be rejected here.
const MAX_QUERY_LEN = 200;

// Google Maps Platform attribution requirements ("Google Maps logo and text
// attribution"): content must be visibly identified as Google Maps content,
// via the logo where possible or the text "Google Maps" where space is tight,
// and visually distinguished from non-Google content. Shipped in the response
// so there is exactly one definition of what the client owes Google.
export const ATTRIBUTION = { text: 'Google Maps', url: 'https://www.google.com/maps' };

const PLACES_HOST = 'https://places.googleapis.com/v1';
// ID only: this is what keeps the search step on the free Essentials SKU. Adding
// any other field here silently promotes the request to Pro or Enterprise.
const SEARCH_FIELD_MASK = 'places.id';
// displayName and googleMapsUri are Pro fields, rating and userRatingCount are
// Enterprise; billed once at Enterprise. displayName is not decoration, it is
// the input to the match check that stops a wrong rating being shown.
const DETAILS_FIELD_MASK = 'displayName,googleMapsUri,rating,userRatingCount';

export default async function handler(req) {
  // (1) Origin/Referer guard first: only our own site and local dev.
  if (!originAllowed(req)) return json({ error: 'origin_rejected' }, 403);

  // (2) POST only.
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // (3) Parse + clamp the body.
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'bad_request' }, 400); }
  const clamped = clampBody(body);
  if (!clamped.ok) return json({ error: 'bad_request' }, 400);

  // (4) Shared key from the config blob; absent -> not configured.
  const { placesStore, blobCache, CONFIG_KEY, USAGE_KEY } = await import('./lib/tp-places-store.mjs');
  const store = placesStore();
  const cfg = (await store.get(CONFIG_KEY, { type: 'json' })) || {};
  // LOCAL DEVELOPMENT AFFORDANCE, not the production path: `netlify dev` serves
  // functions against a LOCAL blob store, which is empty, so ratings would 503
  // on localhost. Deployed functions on this site get no env vars injected
  // (verified), so this fallback is inert in production and the blob remains
  // the only way the key is ever set there.
  const placesKey = cfg.placesKey || process.env.TP_PLACES_KEY;
  if (!placesKey) return json({ error: 'not_configured' }, 503);

  // Owner tier: a request carrying the ownerToken secret from the config blob
  // is quota-checked against OWNER_LIMITS and its spend lands in separate
  // owner buckets, so the owner's own use can never exhaust the public
  // allowance. A wrong or missing token is NOT an error: it silently gets the
  // public limits, so a prober can never learn from a response that an owner
  // tier exists at all. The token is a bearer secret with no user identity
  // behind it, which is why OWNER_LIMITS is still a hard ceiling.
  const isOwner = ownerTokenMatches(clamped.ownerToken, cfg.ownerToken);
  const limits = isOwner ? OWNER_LIMITS : DEFAULT_LIMITS;
  const tier = isOwner ? 'owner' : 'public';

  // (5) Quota. Reserve an upper bound BEFORE any upstream call so parallel
  // batches cannot overrun the cap, then release what the caches saved. Only
  // non-generic queries can ever spend, so they are the only ones reserved.
  // The reservation is an etag-conditional write (tp-places-usage.mjs): a
  // plain read-modify-write would let concurrent requests overwrite each
  // other's counters, and the monthly cap is the one control standing between
  // a concurrent abuser and real money.
  const now = Date.now();
  const billableMax = clamped.queries.filter(q => !isGenericQuery(q)).length;
  let granted = 0;
  if (billableMax > 0) {
    const reserved = await updateUsage(store, USAGE_KEY, usage => {
      const q = checkQuota(usage, clamped.clientId, now, billableMax, limits, tier);
      // A partial grant still serves: the cards it covers get ratings and the
      // rest come back `unavailable`. Only a zero grant is a 429; a rejection
      // reads the counters but writes nothing.
      return { write: q.allowed ? q.usage : null, result: q };
    });
    // Sustained CAS contention fails closed: many writers fighting over the
    // counters is exactly the load the quota exists to stop, and reserving
    // without a landed write would be the original race back again.
    if (!reserved.ok) return json({ error: 'quota_exceeded', scope: 'contention' }, 429);
    const q = reserved.result;
    if (!q.allowed) return json({ error: 'quota_exceeded', scope: q.scope }, 429);
    granted = q.granted;
  }

  // (6) Resolve the batch against the caches, spending at most `granted`.
  const { results, spent } = await resolveQueries({
    queries: clamped.queries,
    cache: blobCache(store),
    findPlaceId: q => findPlaceId(placesKey, q),
    fetchDetails: id => fetchDetails(placesKey, id),
    now,
    budget: granted,
  });

  // (7) Give back the reservations the caches made unnecessary. The CAS loop
  // re-reads before every attempt, so the release only ever subtracts its own
  // unspent slots from the latest counters. If it stays contended past the
  // retry cap the slots simply remain reserved until the bucket rolls over,
  // which can never mint free calls, so the failure is ignored.
  const unspent = granted - spent;
  if (unspent > 0) {
    await updateUsage(store, USAGE_KEY, latest =>
      ({ write: releaseQuota(latest, clamped.clientId, now, unspent, tier) }));
  }

  return json({ results, attribution: ATTRIBUTION }, 200);
}

function originAllowed(req) {
  const src = req.headers.get('origin') || req.headers.get('referer') || '';
  if (!src) return false;
  try {
    const u = new URL(src);
    if (u.protocol === 'https:' && u.hostname === 'shevato.com') return true;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return false;
  } catch { return false; }
}

// Exported for the unit tests. Duplicate queries collapse to one entry: a day
// plan often proposes the same konbini or hotel bar twice, and every duplicate
// would otherwise be a second billed lookup within the same request.
export function clampBody(body) {
  if (!body || typeof body !== 'object') return { ok: false };
  const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100).trim() : '';
  if (!clientId) return { ok: false };
  // Optional owner secret; absent for everyone but the owner's own browsers.
  // Clamped like everything else so a hostile body cannot smuggle in a
  // megabyte for the comparison to chew on.
  const ownerToken = typeof body.ownerToken === 'string' ? body.ownerToken.slice(0, 200).trim() : '';

  const raw = Array.isArray(body.queries) ? body.queries : [];
  const seen = new Set();
  const queries = [];
  for (const q of raw) {
    if (typeof q !== 'string') continue;
    const s = q.slice(0, MAX_QUERY_LEN).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    queries.push(s);
    if (queries.length >= MAX_QUERIES) break;
  }
  if (!queries.length) return { ok: false };

  return { ok: true, clientId, queries, ownerToken };
}

// Constant-time comparison via fixed-length digests, so neither the length
// nor the bytes of the real token leak through response timing. False when
// either side is empty: no configured token means no owner tier, and an
// empty submission must never match anything. Exported for the unit tests.
export function ownerTokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// Text Search restricted to the ID field: the free Essentials (IDs Only) SKU.
// pageSize 1 because we only ever consider Google's top hit; a second candidate
// that the query does not name is not a better answer, it is a wrong one.
async function findPlaceId(key, query) {
  const res = await fetch(PLACES_HOST + '/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, pageSize: 1, languageCode: 'en' }),
  });
  if (!res.ok) {
    // function logs only; body helps diagnose, key never logged
    const body = await res.text().catch(() => '');
    console.error('tp-places search error', res.status, body.slice(0, 300));
    throw new Error('places search ' + res.status);
  }
  const data = await res.json();
  const first = data && Array.isArray(data.places) ? data.places[0] : null;
  return (first && first.id) || null;
}

// Place Details, Enterprise SKU. This is the only billed call in the pipeline.
async function fetchDetails(key, placeId) {
  const res = await fetch(PLACES_HOST + '/places/' + encodeURIComponent(placeId) + '?languageCode=en', {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_FIELD_MASK },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('tp-places details error', res.status, body.slice(0, 300));
    throw new Error('places details ' + res.status);
  }
  const data = await res.json();
  // Flattened here so the cached blob holds our shape, not Google's: a schema
  // change upstream then cannot silently poison a month of cache entries.
  return {
    name: (data.displayName && data.displayName.text) || '',
    rating: typeof data.rating === 'number' ? data.rating : null,
    userRatingCount: typeof data.userRatingCount === 'number' ? data.userRatingCount : 0,
    mapsUri: typeof data.googleMapsUri === 'string' ? data.googleMapsUri : '',
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
