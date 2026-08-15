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

import { originAllowed, json, upstreamSignal } from './lib/tp-http.mjs';
import { canonicalPath, serveFpl, fplStore, USER_AGENT } from './lib/fpl-cache.mjs';

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
  try {
    store = await fplStore();
  } catch (err) {
    console.error('fpl blob store unavailable, serving uncached', String(err && err.message));
    store = memoryStore();
  }

  let result;
  try {
    result = await serveFpl({ path, store, fetchUpstream: fetchFpl, now: Date.now() });
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
    };
  }

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      'Content-Type': 'application/json',
      'x-fpl-cache': result.cache,
      'x-fpl-fetched-at': result.fetchedAt,
      'x-fpl-stale': String(result.stale),
      'x-fpl-age-seconds': String(result.ageSeconds),
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
