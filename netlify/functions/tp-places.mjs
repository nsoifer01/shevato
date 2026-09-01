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
// in the devtools console once (per origin: shevato.com and localhost each
// keep their own localStorage). Requests carrying the matching token are
// governed by OWNER_LIMITS (faster draw, separate buckets) instead of
// DEFAULT_LIMITS; see the isOwner block below. Both tiers still share ONE
// monthly ceiling (MONTHLY_BUDGET) - the owner draws faster, never more.
// Rotate or revoke by rewriting the blob. For `netlify dev`, whose local blob
// store is empty, put the same token in .env as TP_PLACES_OWNER_TOKEN, and note
// that spending from localhost ALSO needs TP_PLACES_ALLOW_LOCAL_SPEND=1.
//
// OWNER STATUS READ: how much of the month's free allowance is left, without
// opening Google Billing (which lags a day):
//   curl -H "X-TP-Owner-Token: <token>" -H "Origin: https://shevato.com" \
//     "https://shevato.com/.netlify/functions/tp-places?status=1"
//
// The CLI must be linked to the site that actually serves shevato.com before
// running those commands; the blob store is per-site, so writing it while
// linked to any other project leaves this endpoint on 503.
//
// ATTRIBUTION: Google requires that content sourced from Google Maps be
// identified as such. The response carries the attribution the client must
// render next to any rating it shows; see ATTRIBUTION below.

import { createHash, timingSafeEqual } from 'node:crypto';
import { checkQuota, releaseQuota, resetAtFor, budgetStatus, MONTHLY_BUDGET, DEFAULT_LIMITS, OWNER_LIMITS } from './lib/tp-places-quota.mjs';
import { updateUsage } from './lib/blob-cas.mjs';
import { originAllowed, json, upstreamSignal } from './lib/tp-http.mjs';
import { resolveQueries, discoverPlaces, DISCOVERY_DETAILS_MAX } from './lib/tp-places-lookup.mjs';
import { isGenericQuery, normalizeArea } from './lib/tp-places-match.mjs';
// The hours normalizer is shared with the client (trip-logic.js is dual-exposed
// exactly for this, the same way tp-assist imports the shared prompt), so the
// shape the server emits and the shape the client validates can never drift.
import TripLogic from '../../apps/trip-planner/js/trip-logic.js';

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
// `location` is an Essentials field, i.e. BELOW every other field already in
// this mask, so the request stays billed at Enterprise and the price of a
// lookup does not move. It is what lets the client show how far a venue is
// from the hotel without a second, separately-billed geocode.
// regularOpeningHours and currentOpeningHours are BOTH "Place Details
// Enterprise" fields (checked against developers.google.com/maps/documentation/
// places/web-service/data-fields on 2026-08-21), the exact tier this request
// already bills at for `rating`, so requesting them changes neither the SKU nor
// the price nor the request count: the closed-venue check and the hours line
// ride the lookup the ratings already pay for. Do NOT add any field from the
// "Enterprise + Atmosphere" tier (reviews, allowsDogs, ...) - that WOULD
// promote every lookup to a more expensive SKU. Exported so a test pins the
// exact mask. No hours field has a caching exception in Google's terms, so
// hours are normalized and passed through but never stored (see fromDetails
// and the id-only blob cache in tp-places-lookup.mjs).
// `formattedAddress` and `addressComponents` are "Place Details Essentials"
// fields - two tiers BELOW the Enterprise tier this request already bills at -
// so they ride the same billed call for exactly $0.00 extra, the same way
// `location` does. They are what lets the wrong-branch gate answer at all when
// the trip has not geocoded its city yet: without an address there is nothing
// to compare "Tokyo" against, and the Hokkaido flagship walks straight through.
export const DETAILS_FIELD_MASK = 'displayName,googleMapsUri,rating,userRatingCount,location,formattedAddress,addressComponents,regularOpeningHours,currentOpeningHours';

export default async function handler(req) {
  // (1) Origin/Referer guard first: only our own site and local dev.
  if (!originAllowed(req)) return json({ error: 'origin_rejected' }, 403);

  // (2) POST only, with one exception: an owner-authenticated GET returns the
  // budget status. This exists so "how much of the free allowance is left?" can
  // be answered without opening Google Billing (whose figures lag by a day
  // anyway) or hand-reading the blob. It is gated on the same ownerToken as the
  // owner tier, returns no key and no client identifiers, and a wrong or absent
  // token is indistinguishable from the endpoint not offering it at all.
  const wantsStatus = req.method === 'GET' && new URL(req.url).searchParams.get('status') === '1';
  if (req.method !== 'POST' && !wantsStatus) return json({ error: 'method_not_allowed' }, 405);

  // (3) Parse + clamp the body. A status GET carries none, so it skips ahead.
  let clamped = { ok: true, clientId: '', queries: [], ownerToken: '' };
  if (!wantsStatus) {
    let body;
    try { body = await req.json(); }
    catch { return json({ error: 'bad_request' }, 400); }
    clamped = clampBody(body);
    if (!clamped.ok) return json({ error: 'bad_request' }, 400);
  }

  // (4) Shared key from the config blob; absent -> not configured.
  const { placesStore, blobCache, CONFIG_KEY, USAGE_KEY } = await import('./lib/tp-places-store.mjs');
  const store = placesStore();
  const cfg = (await store.get(CONFIG_KEY, { type: 'json' })) || {};
  // Which credential, and from where, is decided by resolvePlacesKey below:
  // the blob's placesKeyV2 (production), or an explicitly opted-in local key.
  const placesKey = resolvePlacesKey(cfg, process.env);
  if (!placesKey) return json({ error: 'not_configured' }, 503);

  // Owner tier: a request carrying the ownerToken secret from the config blob
  // is quota-checked against OWNER_LIMITS and its spend lands in separate
  // owner buckets, so the owner's own use can never exhaust the public
  // allowance. A wrong or missing token is NOT an error: it silently gets the
  // public limits, so a prober can never learn from a response that an owner
  // tier exists at all. The token is a bearer secret with no user identity
  // behind it, which is why OWNER_LIMITS is still a hard ceiling.
  // The env fallback is the same LOCAL DEVELOPMENT AFFORDANCE as TP_PLACES_KEY
  // above: `netlify dev`'s empty local blob store left the owner tier
  // unreachable on localhost, dropping the owner into the public 30/hour
  // bucket after two example trips. Inert in production for the same reason.
  const expectedOwner = cfg.ownerToken || process.env.TP_PLACES_OWNER_TOKEN;
  const headerToken = req.headers.get('x-tp-owner-token') || '';
  const isOwner = ownerTokenMatches(wantsStatus ? headerToken : clamped.ownerToken, expectedOwner);
  const limits = isOwner ? OWNER_LIMITS : DEFAULT_LIMITS;
  const tier = isOwner ? 'owner' : 'public';

  // Owner status read: counters only, never a key, never a clientId.
  if (wantsStatus) {
    if (!isOwner) return json({ error: 'method_not_allowed' }, 405);
    const usage = (await store.get(USAGE_KEY, { type: 'json' })) || {};
    return json(budgetStatus(usage, Date.now()), 200);
  }

  // (5) Quota. Reserve an upper bound BEFORE any upstream call so parallel
  // batches cannot overrun the cap, then release what the caches saved. Only
  // non-generic queries can ever spend, so they are the only ones reserved.
  // The reservation is an etag-conditional write (lib/blob-cas.mjs): a
  // plain read-modify-write would let concurrent requests overwrite each
  // other's counters, and the monthly cap is the one control standing between
  // a concurrent abuser and real money.
  const now = Date.now();
  // ONE SLOT PER QUERY IS NOT ENOUGH, and that is not a rounding error: a
  // candidate rejected on geography earns one retry, the retry is a second
  // billed Place Details call, and reserving exactly one slot per query meant
  // the query's own first lookup had already taken it. The retry's claim()
  // then always failed - so the rescue was dead code in the commonest batch of
  // all, a single recommendation. Found on 2026-08-27 by reading a real
  // handler's upstream call log; the pipeline tests missed it because they
  // inject their own budget.
  //
  // The headroom is an UPPER BOUND, never a charge: step (7) releases every
  // slot the batch did not spend, so a clean batch still costs exactly what it
  // used. It is bounded so a full 12-query batch cannot reserve 24 against the
  // monthly ceiling while it is held.
  // A discovery request bills per candidate it looks at, up to its own hard
  // ceiling, and never retries: the search is already restricted to the area,
  // so a second attempt would ask the same question of the same box.
  const billable = clamped.discover
    ? clamped.discover.limit
    : clamped.queries.filter(q => !isGenericQuery(q.q)).length;
  const billableMax = clamped.discover ? billable : billable + retryHeadroom(billable);
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
    if (!reserved.ok) return quotaExceeded('contention', now);
    const q = reserved.result;
    if (!q.allowed) return quotaExceeded(q.scope, now);
    granted = q.granted;
  }

  // (5b) A discovery request takes its own path: there are no named venues to
  // resolve and no cache to consult (the query is a category, and a category's
  // answer changes with the world), so it goes straight to a restricted search
  // and verifies whatever comes back.
  if (clamped.discover) {
    let left = granted;
    const claim = () => (left > 0 ? (left -= 1, true) : false);
    let found;
    try {
      found = await discoverPlaces({
        query: clamped.discover.q,
        area: normalizeArea(clamped.discover),
        limit: clamped.discover.limit,
        exclude: clamped.discover.exclude,
        findPlaceIds: (q, bias, pageSize) => findPlaceIds(placesKey, q, bias, pageSize),
        fetchDetails: id => fetchDetails(placesKey, id),
        now,
        claim,
        log: resolutionLogger(),
      });
    } catch (err) {
      console.error('tp-places discover failed', err && err.message);
      found = { results: [], spent: granted };
    }
    const unspentD = granted - found.spent;
    if (unspentD > 0) {
      await updateUsage(store, USAGE_KEY, latest =>
        ({ write: releaseQuota(latest, clamped.clientId, now, unspentD, tier) }));
    }
    return json({ results: found.results, discovered: true, attribution: ATTRIBUTION }, 200);
  }

  // (6) Resolve the batch against the caches, spending at most `granted`.
  // Wrapped because the blob cache reads/writes inside resolveQueries are I/O
  // that can reject (a transient Blobs error): unwrapped, that surfaced as a
  // platform 500 with no JSON contract AND left the whole reservation burned.
  // Failing the batch as `unavailable` keeps the client's quiet-degrade path
  // (it treats the response like any other transient miss) and step (7) then
  // hands every reserved slot back.
  let results, spent;
  try {
    ({ results, spent } = await resolveQueries({
      queries: clamped.queries,
      cache: blobCache(store),
      findPlaceId: (q, bias) => findPlaceId(placesKey, q, bias),
      fetchDetails: id => fetchDetails(placesKey, id),
      now,
      budget: granted,
      log: resolutionLogger(),
    }));
  } catch (err) {
    console.error('tp-places resolve failed', err && err.message);
    results = clamped.queries.map(q => ({ id: q.id, query: q.q, status: 'unavailable', reason: 'upstream' }));
    // Some lookups may have been billed before the failure; there is no way to
    // know how many, so the conservative answer is to keep the reservation
    // (never under-count spend against the monthly cap that protects the card).
    spent = granted;
  }

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

// WHICH CREDENTIAL MAY BE USED, and from where. Exported so the rule is pinned
// by tests rather than living inside the handler.
//
// THE FIELD NAME IS A VERSION GATE, and that is its whole point. Netlify keeps
// every deploy permalink alive forever, and an old deploy runs OLD CODE against
// the LIVE config blob. Verified on 2026-08-18: a production permalink from
// before the monthly budget shipped still answered tp-places and still resolved
// the key, which is a live path to billable Place Details calls that never
// touch the 850-call guard, reachable by anyone who knows a deploy URL (the
// origin check is forgeable and is documented as defence-in-depth only).
//
// Reading `placesKeyV2` closes it in one move: every function version ever
// deployed before this line looks up `placesKey`, so once that field is removed
// from the blob they all get undefined and answer 503, spending nothing,
// permanently. There is deliberately NO fallback to `cfg.placesKey` - a
// fallback would reopen exactly the hole this closes.
//
// The env key stays a LOCAL DEVELOPMENT AFFORDANCE and needs a second explicit
// opt-in: `netlify dev` runs against a LOCAL blob store, so a localhost lookup
// would spend real money while its counters landed somewhere the budget cannot
// see (measured: 129 such lookups in August 2026). A key alone must not be
// enough to bill the card from a laptop.
export function resolvePlacesKey(cfg, env) {
  const c = cfg || {};
  const e = env || {};
  if (typeof c.placesKeyV2 === 'string' && c.placesKeyV2) return c.placesKeyV2;
  if (e.TP_PLACES_ALLOW_LOCAL_SPEND === '1' && typeof e.TP_PLACES_KEY === 'string' && e.TP_PLACES_KEY) {
    return e.TP_PLACES_KEY;
  }
  return '';
}

// Every 429 this function emits says WHICH bucket rejected the batch and WHEN
// that bucket next refills, in a header and in the body. Without it the client
// can only guess, and its guess (a flat hour) was wrong in both directions:
// too long after an hourly rejection, absurdly short against a monthly one.
//
// Worth stating plainly because the browser console cannot: a 429 from this
// endpoint is ALWAYS ours. A rejection by Google is caught in resolveOne and
// comes back as HTTP 200 carrying `{ status: 'unavailable', reason: 'upstream' }`,
// so an upstream throttle can never reach the browser wearing a 429.
// Exported for the unit tests.
export function quotaExceeded(scope, now) {
  const resetAt = resetAtFor(scope, now);
  const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  // Logged because the 2026-08-17 round had to be diagnosed by reading the
  // counters blob by hand: a rejection wrote NOTHING to the function log, so
  // "which bucket refused this?" was unanswerable from the logs alone - the
  // same blind spot the tp-assist timeout had. No clientId (attacker-minted
  // and not ours to record), just the bucket and how long it is shut.
  console.warn('tp-places quota_exceeded', scope, 'for', seconds + 's');
  return new Response(JSON.stringify({ error: 'quota_exceeded', scope, resetAt }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(seconds) },
  });
}

// How many rescues a batch may reserve for on top of its first lookups. Small
// and capped: a wrong-area rejection should be rare once the search is biased,
// so most batches release this untouched, and the cap keeps the transient
// reservation well clear of the monthly budget. Exported so a test can pin it.
export const RETRY_HEADROOM_MAX = 4;
export function retryHeadroom(billable) {
  return Math.min(Math.max(0, billable), RETRY_HEADROOM_MAX);
}

// Exported for the unit tests. Duplicate queries collapse to one entry: a day
// plan often proposes the same konbini or hotel bar twice, and every duplicate
// would otherwise be a second billed lookup within the same request.
//
// A query may be a bare string (the shape this endpoint has always accepted,
// and still the right shape for a caller with no itinerary context) or an
// object carrying that context:
//   { q, id, city, country, lat, lon, radiusKm }
// `id` is the caller's own cache key and is echoed back untouched, so a
// response can never be re-keyed onto the wrong card. Deduplication is on the
// ID, not on the text: "Takashimaya" for a Kyoto day and "Takashimaya" for a
// Tokyo day are two different questions and must stay two entries.
export function clampBody(body) {
  if (!body || typeof body !== 'object') return { ok: false };
  const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100).trim() : '';
  if (!clientId) return { ok: false };
  // Optional owner secret; absent for everyone but the owner's own browsers.
  // Clamped like everything else so a hostile body cannot smuggle in a
  // megabyte for the comparison to chew on.
  const ownerToken = typeof body.ownerToken === 'string' ? body.ownerToken.slice(0, 200).trim() : '';

  // A DISCOVERY request is the other shape this endpoint answers: not "resolve
  // these named venues" but "find me candidates for this category, here". It
  // exists so a recommendation that fails verification can be replaced with a
  // real place deterministically, instead of asking a model to invent another
  // name that might not exist either.
  const discover = clampDiscover(body.discover);
  if (discover) return { ok: true, clientId, queries: [], discover, ownerToken };

  const raw = Array.isArray(body.queries) ? body.queries : [];
  const seen = new Set();
  const queries = [];
  for (const item of raw) {
    const q = clampQuery(item);
    if (!q) continue;
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    queries.push(q);
    if (queries.length >= MAX_QUERIES) break;
  }
  if (!queries.length) return { ok: false };

  return { ok: true, clientId, queries, discover: null, ownerToken };
}

// One discovery request, clamped. `exclude` is the list of place IDs already
// spoken for (kept recommendations AND rejected candidates), so a replacement
// can never duplicate either; it is bounded like everything else because the
// body is attacker-controlled.
export function clampDiscover(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n).trim() : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const q = str(raw.q, MAX_QUERY_LEN);
  if (!q) return null;
  const out = { q, limit: Math.max(1, Math.min(DISCOVERY_DETAILS_MAX, Number(raw.limit) || 1)) };
  const city = str(raw.city, 80);
  const country = str(raw.country, 80);
  if (city) out.city = city;
  if (country) out.country = country;
  const lat = num(raw.lat), lon = num(raw.lon);
  if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.lat = lat;
    out.lon = lon;
  }
  const ex = Array.isArray(raw.exclude) ? raw.exclude : [];
  out.exclude = ex.filter(x => typeof x === 'string' && x).slice(0, 24).map(x => x.slice(0, 200));
  return out;
}

// One entry, clamped field by field. Everything that reaches an upstream
// request or a log line is bounded here rather than trusted: the body is
// attacker-controlled, and `city` in particular is interpolated into a text
// query.
function clampQuery(item) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n).trim() : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  if (typeof item === 'string') {
    const q = str(item, MAX_QUERY_LEN);
    return q ? { q, id: q } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const q = str(item.q, MAX_QUERY_LEN);
  if (!q) return null;
  const out = { q, id: str(item.id, MAX_QUERY_LEN + 120) || q };
  const city = str(item.city, 80);
  const country = str(item.country, 80);
  if (city) out.city = city;
  if (country) out.country = country;
  const lat = num(item.lat), lon = num(item.lon);
  if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.lat = lat;
    out.lon = lon;
  }
  const radiusKm = num(item.radiusKm);
  if (radiusKm !== undefined && radiusKm > 0) out.radiusKm = radiusKm;
  return out;
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
//
// `bias` is the itinerary's own area, and it is what stops Google answering a
// question about a Tokyo branch with a chain's Hokkaido flagship. It travels as
// `locationBias` (a hint: the top hit is steered towards the area but a venue
// just outside it is still findable) or, on the one retry a rejected candidate
// earns, as `locationRestriction` (a hard box: by then an unrestricted search
// has already proved it returns the wrong region). Both are REQUEST parameters,
// not field-mask entries, so neither changes the SKU or the price.
async function findPlaceId(key, query, bias) {
  const ids = await findPlaceIds(key, query, bias, 1);
  return ids[0] || null;
}

// The same free Essentials (IDs Only) search, returning the whole page. One
// candidate is what a NAMED lookup wants (a second hit the query does not name
// is not a better answer, it is a wrong one); a DISCOVERY request wants the
// page, because it is choosing among candidates rather than confirming one.
async function findPlaceIds(key, query, bias, pageSize) {
  const body = { textQuery: query, pageSize: Math.max(1, Math.min(20, pageSize || 1)), languageCode: 'en' };
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lon)) {
    if (bias.restrict) {
      body.locationRestriction = { rectangle: rectangleAround(bias) };
    } else {
      body.locationBias = {
        circle: {
          center: { latitude: bias.lat, longitude: bias.lon },
          // Google caps the bias circle at 50,000 m.
          radius: Math.max(1, Math.min(50000, Math.round(bias.radiusM || 30000))),
        },
      };
    }
  }
  const res = await fetch(PLACES_HOST + '/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': SEARCH_FIELD_MASK,
    },
    body: JSON.stringify(body),

    // Deadline under Netlify's 10s ceiling; see lib/tp-http.mjs. One hung
    // lookup in a batch then costs 9s, not the whole invocation.
    signal: upstreamSignal(),
  });
  if (!res.ok) {
    // function logs only; body helps diagnose, key never logged
    const errBody = await res.text().catch(() => '');
    console.error('tp-places search error', res.status, errBody.slice(0, 300));
    throw new Error('places search ' + res.status);
  }
  const data = await res.json();
  const places = data && Array.isArray(data.places) ? data.places : [];
  return places.map(p => (p && p.id) || '').filter(Boolean);
}

// searchText takes a rectangle for locationRestriction, not a circle. A degree
// of latitude is ~111 km everywhere; a degree of longitude shrinks with the
// cosine of the latitude, and the clamp keeps the maths sane at the poles.
// Exported for the unit tests.
export function rectangleAround({ lat, lon, radiusM }) {
  const km = Math.max(1, (radiusM || 30000) / 1000);
  const dLat = km / 111;
  const dLon = km / Math.max(1, 111 * Math.cos((lat * Math.PI) / 180));
  return {
    low: { latitude: Math.max(-90, lat - dLat), longitude: Math.max(-180, lon - dLon) },
    high: { latitude: Math.min(90, lat + dLat), longitude: Math.min(180, lon + dLon) },
  };
}

// DEVELOPMENT VISIBILITY. Every kept-or-dropped decision the resolver makes
// lands in the FUNCTION log (never in a response, never in front of a
// traveller) so "why did this card say no rating match / why did that chip say
// 809 km" is answerable after the fact. Off unless TP_PLACES_DEBUG is set, so
// a normal production invocation logs nothing new. No API key, no clientId.
function resolutionLogger() {
  if (process.env.TP_PLACES_DEBUG !== '1') return null;
  return rec => console.log('tp-places resolve', JSON.stringify(rec));
}

// Place Details, Enterprise SKU. This is the only billed call in the pipeline.
async function fetchDetails(key, placeId) {
  const res = await fetch(PLACES_HOST + '/places/' + encodeURIComponent(placeId) + '?languageCode=en', {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_FIELD_MASK },
    signal: upstreamSignal(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('tp-places details error', res.status, body.slice(0, 300));
    throw new Error('places details ' + res.status);
  }
  const data = await res.json();
  // Flattened here so the cached blob holds our shape, not Google's: a schema
  // change upstream then cannot silently poison a month of cache entries.
  // lat/lon rather than Google's lat/lng, because lat/lon is what every
  // coordinate in this app is called, all the way down to the haversine.
  const loc = data.location || {};
  return {
    name: (data.displayName && data.displayName.text) || '',
    // The address half of the identity, and the only thing the wrong-branch
    // gate can read when the trip has no coordinate for its city yet. Passed
    // through to the gate and never returned to the client: it is Google Maps
    // content, so it is used and dropped, never stored and never rendered.
    address: typeof data.formattedAddress === 'string' ? data.formattedAddress : '',
    addressComponents: Array.isArray(data.addressComponents) ? data.addressComponents : [],
    rating: typeof data.rating === 'number' ? data.rating : null,
    userRatingCount: typeof data.userRatingCount === 'number' ? data.userRatingCount : 0,
    mapsUri: typeof data.googleMapsUri === 'string' ? data.googleMapsUri : '',
    lat: typeof loc.latitude === 'number' ? loc.latitude : null,
    lon: typeof loc.longitude === 'number' ? loc.longitude : null,
    // Normalized weekly + dated opening hours, or null when Google has none.
    // Null MATTERS downstream: it is the "hours unknown" state, and no layer
    // may ever read it as "open". Passed through, never stored.
    hours: TripLogic.normalizeGoogleHours(data.regularOpeningHours, data.currentOpeningHours),
  };
}
