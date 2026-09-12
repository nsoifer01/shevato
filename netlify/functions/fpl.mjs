// Fantasy Premier League read proxy for apps/fpl-planner.
//
// fantasy.premierleague.com serves its public API with no CORS headers, so a
// browser on shevato.com cannot read it directly. This function fronts an
// allowlist of read-only endpoints, caches the global ones in Netlify Blobs so
// a thousand visitors cost roughly one upstream fetch per TTL window, and
// reports freshness in headers so the UI can say when its numbers are from.
//
// No key, no account, no credentials: the FPL API is public. Nothing here
// writes to FPL, and no endpoint that requires an FPL login is reachable.
//
//   GET /.netlify/functions/fpl?path=bootstrap-static
//   GET /.netlify/functions/fpl?path=entry/4231987/history
//
// Response headers: x-fpl-cache (hit|miss), x-fpl-fetched-at (ISO),
// x-fpl-stale (true|false), x-fpl-age-seconds (int).
//
// Cache MISSES are metered per network (lib/fpl-quota.mjs); cache hits are
// free. A refused caller gets 429 with Retry-After.

import { originAllowed, json, upstreamSignal } from './lib/tp-http.mjs';
import { canonicalPath, serveFpl, fplStore, ttlSeconds, USER_AGENT } from './lib/fpl-cache.mjs';
import { checkQuota, resetAtFor, QUOTA_KEY } from './lib/fpl-quota.mjs';
import { updateUsage } from './lib/blob-cas.mjs';
import { networkIdFor } from './lib/tp-client-identity.mjs';

// The Blob store pulls in @netlify/blobs (installed only in the Netlify build,
// gitignored locally). fplStore() imports it lazily, and is called only after
// the origin / method / path guards, so those guards stay unit-testable
// without the dependency.

export default async function handler(req) {
  // (1) Origin/Referer guard first: only our own site and local dev.
  if (!originAllowed(req)) return json({ error: 'forbidden' }, 403);

  // (2) Read-only endpoint.
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  // (3) Anchored allowlist. A path that is not on it never reaches upstream.
  const path = canonicalPath(new URL(req.url).searchParams.get('path'));
  if (!path) return json({ error: 'path_not_allowed' }, 400);

  // The cache is an optimisation in front of a public API, so losing it must
  // cost speed and nothing else. Acquiring the store can fail (a Blobs incident,
  // a misconfigured deploy, the package missing) and that used to escape as a
  // platform 500 with the app fully down while upstream was perfectly healthy.
  let store;
  let quotaStore = null;
  try {
    store = await fplStore();
    // The counters live in the same store as the cache. When it is gone they
    // are gone with it, and the request is served unmetered (see below).
    quotaStore = store;
  } catch (err) {
    console.error('fpl blob store unavailable, serving uncached', String(err && err.message));
    store = memoryStore();
  }

  const now = Date.now();
  // (4) QUOTA, CLAIMED AROUND THE UPSTREAM FETCH RATHER THAN UP HERE.
  //
  // serveFpl calls fetchUpstream only when it is actually going upstream, so
  // wrapping it is what makes a cache hit cost exactly nothing - a manager
  // reloading, and a thousand visitors sharing one bootstrap-static, spend no
  // quota at all and never even touch the counter blob. Claiming at the top of
  // the handler would have metered hits too, and would have needed a release
  // path to give the slot back, which is the shape tp-places is stuck with
  // because its cost is decided per query inside a batch rather than by one
  // fetch.
  //
  // A refusal is signalled by THROWING out of the wrapper, which lands in
  // serveFpl's own upstream-failure path. That is deliberate: it means a
  // refused caller is still served whatever the cache can offer (a stale copy,
  // marked stale) and only gets the 429 when there was nothing to serve. A
  // quota must never make availability worse than the cache already makes it.
  //
  // Known residual, bounded and deliberately not chased: serveFpl claims the
  // refresh lease BEFORE calling this, so a caller who is over quota can win
  // the lease for an expired popular key and then be refused, leaving everyone
  // else on the stale copy until the lease lapses. REFRESH_LEASE_SECONDS bounds
  // it to 20 seconds, it is the same window a crashed refresher already costs,
  // and the alternative - claiming before the lease - would meter the path that
  // serves a stale copy, which is a cache hit and must stay free.
  const networkId = networkIdFor(req, now);
  const refusal = { scope: null };
  const meteredFetch = async (url) => {
    const slot = await claimUpstreamSlot(quotaStore, networkId, now);
    if (!slot.allowed) {
      refusal.scope = slot.scope;
      throw new Error('fpl quota exceeded: ' + slot.scope);
    }
    return fetchFpl(url);
  };

  let result;
  try {
    result = await serveFpl({ path, store, fetchUpstream: meteredFetch, now });
    result.path = path;
  } catch (err) {
    // Nothing below is allowed to escape as an unhandled 500 either: the client
    // reads a 503 as "temporarily unavailable" and keeps its own cached copy,
    // while a 500 with no body is just a broken app.
    console.error('fpl serve failed', path, String(err && err.message));
    result = {
      status: 503,
      body: { error: 'upstream_unavailable' },
      cache: 'miss',
      fetchedAt: new Date().toISOString(),
      stale: false,
      ageSeconds: 0,
      path,
    };
  }

  // The refusal only speaks when the cache had nothing to offer. If it did,
  // `result` is that copy at 200 and the caller never learns it was refused,
  // which is the right outcome: the answer cost nothing to produce.
  if (refusal.scope && result.status !== 200) return quotaExceeded(refusal.scope, now);

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      'Content-Type': 'application/json',
      // EDGE CACHE. The response body for a given path is identical for every
      // visitor, so letting Netlify's CDN answer repeats keeps a burst off the
      // function entirely - the layer in front of the blob lease rather than
      // instead of it. The window is the REMAINING life of the copy we just
      // served, so the edge never holds something past the freshness the
      // headers above claim, and a stale answer is never cached at all.
      //
      // Cache-Control stays no-store: the BROWSER has its own cache with its
      // own TTL policy (apps/fpl-planner/js/data/api.js) and a second one in
      // front of it would make "how old is this?" unanswerable. Netlify reads
      // Netlify-CDN-Cache-Control for the edge and does not forward it.
      'Netlify-CDN-Cache-Control': edgeCachePolicy(result),
      'Cache-Control': 'no-store',
      'x-fpl-cache': result.cache,
      'x-fpl-fetched-at': result.fetchedAt,
      'x-fpl-stale': String(result.stale),
      'x-fpl-age-seconds': String(result.ageSeconds),
    },
  });
}

// How long the edge may repeat this exact answer. Only a fresh 200 is
// cacheable: an error, and a stale copy served while somebody refreshes, must
// each be re-asked rather than pinned in front of the function.
export function edgeCachePolicy(result) {
  if (result.status !== 200 || result.stale) return 'no-store';
  const remaining = Math.max(0, ttlSeconds(result.path, { now: Date.now(), nextDeadline: null })
    - (Number(result.ageSeconds) || 0));
  if (remaining < 5) return 'no-store';
  return `public, max-age=${Math.floor(remaining)}`;
}

/**
 * Reserve one cache-miss upstream fetch for this network, atomically.
 *
 * FAILS OPEN, EVERY WAY IT CAN FAIL, and that is the opposite of tp-places on
 * purpose. There, a reservation that cannot be written guards the owner's card,
 * so it fails CLOSED and refuses. Here nothing is billable - the FPL API is
 * public and free - and what is at stake is a manager being able to load their
 * own team. So a Blobs incident, a missing store, sustained CAS contention, or
 * no address to key on all resolve to "serve it". Do not "fix" one of these two
 * to match the other: the difference is the whole reasoning.
 *
 * The cost of failing open is bounded and worth naming: a burst that loses
 * every CAS round overshoots the cap by the number of racing writers, and pays
 * for that in extra upstream fetches and nothing else. Contention is rare by
 * construction anyway, because this blob is written only as often as a cache
 * MISS happens, not as often as a request arrives.
 *
 * Exported for the unit tests.
 */
export async function claimUpstreamSlot(store, networkId, now) {
  if (!store || !networkId) return { allowed: true };
  try {
    const reserved = await updateUsage(store, QUOTA_KEY, usage => {
      const q = checkQuota(usage, networkId, now);
      return { write: q.allowed ? q.usage : null, result: q };
    });
    if (!reserved.ok) {
      console.warn('fpl quota CAS contention, serving unmetered');
      return { allowed: true };
    }
    return reserved.result;
  } catch (err) {
    console.error('fpl quota store unavailable, serving unmetered', String(err && err.message));
    return { allowed: true };
  }
}

// A refusal says WHICH bucket rejected it and WHEN that bucket next refills,
// in a header and in the body, matching the shape tp-places already returns so
// a client has one thing to learn. Without it the only option is a flat guess,
// which is wrong in both directions.
//
// NEVER EDGE-CACHED. Every other response this function emits is identical for
// every visitor, which is what makes the CDN safe in front of it; a 429 is the
// one answer that is specific to the caller's network, and letting the edge
// repeat it would refuse everyone else asking for that path. Exported for the
// unit tests.
export function quotaExceeded(scope, now) {
  const resetAt = resetAtFor(scope, now);
  const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  // Logged because a rejection that writes nothing to the function log leaves
  // "which bucket refused this?" unanswerable from outside, which is the blind
  // spot both sibling functions had to be fixed for. The bucket and the wait,
  // never the address or its digest.
  console.warn('fpl quota_exceeded', scope, 'for', seconds + 's');
  return new Response(JSON.stringify({ error: 'quota_exceeded', scope, resetAt: new Date(resetAt).toISOString() }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(seconds),
      'Cache-Control': 'no-store',
      'Netlify-CDN-Cache-Control': 'no-store',
    },
  });
}

// A store shaped like the Blobs one that remembers nothing. Used only when the
// real store cannot be reached, so every request goes straight upstream: slower
// and more traffic, but working.
function memoryStore() {
  return {
    async get() { return null; },
    async setJSON() { /* deliberately forgotten */ },
  };
}

// A plain identifying User-Agent (verified accepted upstream) and the same
// sub-10s deadline every function in this repo uses, so a hung upstream fails
// inside our own error path rather than as a platform timeout.
function fetchFpl(url) {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: upstreamSignal(),
  });
}
