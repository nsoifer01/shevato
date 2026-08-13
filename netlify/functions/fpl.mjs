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

  const store = await fplStore();
  const result = await serveFpl({
    path,
    store,
    fetchUpstream: fetchFpl,
    now: Date.now(),
  });

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

// A plain identifying User-Agent (verified accepted upstream) and the same
// sub-10s deadline every function in this repo uses, so a hung upstream fails
// inside our own error path rather than as a platform timeout.
function fetchFpl(url) {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: upstreamSignal(),
  });
}
