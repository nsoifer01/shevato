// The FPL proxy's allowlist, TTL policy and cache pipeline.
//
// Everything here is pure or store-injected so node:test can drive the whole
// serve path with an in-memory store and a fake fetch, exactly like
// tp-places-lookup.mjs does for the Places pipeline. @netlify/blobs is imported
// lazily inside fplStore() and nowhere else, so importing this module does not
// require the dependency to be installed.
//
// WHY A PROXY AT ALL: fantasy.premierleague.com sends no CORS headers, so a
// browser on shevato.com cannot call it. And bootstrap-static is 1.3 MB that is
// IDENTICAL for every visitor, so caching it centrally turns a thousand users
// into roughly one upstream fetch per TTL window.

export const UPSTREAM_BASE = 'https://fantasy.premierleague.com/api/';
export const STORE_NAME = 'fpl-planner';
export const DEADLINE_KEY = 'meta:next-deadline';
export const USER_AGENT = 'shevato-fpl-planner/1.0 (+https://shevato.com)';

// Anchored so `entry/1/history/../../admin` or `bootstrap-static?x` can never
// match. Order matters only for readability; each pattern is exclusive.
export const ALLOWED_PATHS = [
  { re: /^bootstrap-static$/, kind: 'bootstrap' },
  { re: /^fixtures$/, kind: 'fixtures' },
  { re: /^entry\/\d+$/, kind: 'entry' },
  { re: /^entry\/\d+\/history$/, kind: 'entry' },
  { re: /^entry\/\d+\/transfers$/, kind: 'entry' },
  { re: /^entry\/\d+\/event\/\d+\/picks$/, kind: 'entry' },
  { re: /^element-summary\/\d+$/, kind: 'element-summary' },
  { re: /^event\/\d+\/live$/, kind: 'live' },
];

// Seconds. bootstrap carries prices and injury news (10 min), fixtures move
// rarely (30 min), an entry changes only when its owner acts (5 min), a player
// summary is history (15 min), and live scores move every minute during a match.
export const TTL = {
  bootstrap: 600,
  fixtures: 1800,
  entry: 300,
  'element-summary': 900,
  live: 60,
};

// Inside this window before a deadline, prices, injury news and free-transfer
// counts all matter to the minute, so every TTL collapses.
export const DEADLINE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const DEADLINE_TTL_SECONDS = 120;

// How far past its TTL a cached copy may still be SERVED while one caller
// refreshes it. Deliberately short: long enough to absorb the burst that
// arrives the moment a popular key expires, short enough that nobody reads a
// plan built on numbers from another gameweek. Past this window every caller
// goes upstream, so a permanently failing refresh degrades into the old
// behaviour rather than serving something stale forever.
export const STALE_SERVE_SECONDS = 60;

// How long one caller may hold the right to refresh a key. Sized above the
// function's own 9s upstream deadline plus a cold start, so a legitimate slow
// refresh is not preempted, and far below any TTL, so a crashed owner costs
// one short window rather than a wedged key.
export const REFRESH_LEASE_SECONDS = 20;
export const leaseKey = (key) => `lease:${key}`;

// Strips a leading/trailing slash and rejects anything not on the allowlist.
// Returns the canonical path, or null.
export function canonicalPath(raw) {
  if (typeof raw !== 'string') return null;
  const path = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path) return null;
  return ALLOWED_PATHS.some(p => p.re.test(path)) ? path : null;
}

export function pathKind(path) {
  const match = ALLOWED_PATHS.find(p => p.re.test(path));
  return match ? match.kind : null;
}

export function ttlSeconds(path, { now, nextDeadline } = {}) {
  const base = TTL[pathKind(path)] ?? TTL.entry;
  if (!nextDeadline) return base;
  const deadlineMs = Date.parse(nextDeadline);
  if (!Number.isFinite(deadlineMs)) return base;
  const untilDeadline = deadlineMs - now;
  if (untilDeadline <= 0 || untilDeadline > DEADLINE_WINDOW_MS) return base;
  return Math.min(base, DEADLINE_TTL_SECONDS);
}

// Blob keys cannot carry the path separators verbatim without reading like a
// directory tree, so they are flattened. The mapping is injective because the
// allowlist admits no ':' or '__'.
export function cacheKey(path) {
  return 'v1:' + path.replace(/\//g, '__');
}

// The next deadline in the future, used to shorten every TTL as it approaches.
export function nextDeadlineFrom(bootstrapBody, now) {
  const events = (bootstrapBody && bootstrapBody.events) || [];
  let best = null;
  for (const e of events) {
    const ms = Date.parse(e.deadline_time);
    if (!Number.isFinite(ms) || ms <= now) continue;
    if (best === null || ms < best) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

export async function fplStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore(STORE_NAME);
}

// The whole serve path: cache read, freshness decision, upstream fetch, cache
// write, and the degraded fallbacks.
//
// Returns { status, body, cache, fetchedAt, stale, ageSeconds }. The caller
// turns that into a Response, so this stays testable without a Request.
export async function serveFpl({ path, store, fetchUpstream, now, leaseId }) {
  const key = cacheKey(path);
  const cached = await readCache(store, key);

  if (cached) {
    const nextDeadline = await readDeadline(store);
    const age = ageSeconds(cached.fetchedAt, now);
    if (age < ttlSeconds(path, { now, nextDeadline })) {
      return { status: 200, body: cached.body, cache: 'hit', fetchedAt: cached.fetchedAt, stale: false, ageSeconds: age };
    }

    // EXPIRED, BUT WE STILL HAVE IT. One refresh is enough; the rest of a
    // burst can be answered from the copy in hand.
    //
    // Netlify runs one function instance per request, so twenty browsers
    // asking for `fixtures` the second its TTL lapses used to make twenty
    // identical upstream calls - measured, 20/20 - and every one of them paid
    // 1.3 MB of latency for an answer nineteen of them did not need. The
    // lease is an etag-conditional claim on a tiny blob: exactly one caller
    // wins it and goes upstream, and everyone else is served the stale copy,
    // clearly marked, for at most STALE_SERVE_SECONDS past the TTL.
    //
    // An owner that crashes or times out cannot wedge the key: the lease
    // carries an expiry, and once it lapses the next caller claims it. And
    // once the copy is older than the stale window, every caller goes
    // upstream again rather than serving something too old to be useful.
    if (age < ttlSeconds(path, { now, nextDeadline }) + STALE_SERVE_SECONDS) {
      const owner = await claimRefreshLease(store, key, now, leaseId);
      if (!owner) {
        return {
          status: 200, body: cached.body, cache: 'hit', fetchedAt: cached.fetchedAt,
          stale: true, ageSeconds: age, coalesced: true,
        };
      }
    }
  }

  try {
    const res = await fetchUpstream(UPSTREAM_BASE + path + '/');
    // A 404 means two different things and they need different answers.
    //
    // With NO cached copy it is the real one: an unknown team id, which the
    // onboarding screen has to be able to say out loud, and which is never
    // cached.
    //
    // With a cached copy in hand it is almost certainly not: FPL returns 404s
    // and 503s for entry endpoints while it processes a gameweek, and treating
    // those as "this team does not exist" threw a manager back to the landing
    // page mid-season with a perfectly good squad sitting in the store. Serving
    // the copy, marked stale, is both true and useful.
    if (res.status === 404) {
      if (cached) {
        return {
          status: 200, body: cached.body, cache: 'hit', fetchedAt: cached.fetchedAt,
          stale: true, ageSeconds: ageSeconds(cached.fetchedAt, now),
        };
      }
      return { status: 404, body: { error: 'not_found' }, cache: 'miss', fetchedAt: new Date(now).toISOString(), stale: false, ageSeconds: 0 };
    }
    if (!res.ok) throw new Error('upstream ' + res.status);
    const body = await res.json();
    const fetchedAt = new Date(now).toISOString();
    // The cache is an optimisation, so a failure to WRITE it must not lose the
    // body that was successfully fetched. Inside the outer try this threw the
    // fresh response away and answered 503, or served a day-old copy instead of
    // the one already in hand.
    try {
      await store.setJSON(key, { fetchedAt, body });
      if (path === 'bootstrap-static') {
        await store.setJSON(DEADLINE_KEY, { nextDeadline: nextDeadlineFrom(body, now) });
      }
    } catch (writeErr) {
      console.error('fpl cache write failed', path, String(writeErr && writeErr.message));
    }
    return { status: 200, body, cache: 'miss', fetchedAt, stale: false, ageSeconds: 0 };
  } catch (err) {
    console.error('fpl upstream error', path, String(err && err.message));
    // Stale beats nothing, but it must SAY it is stale: a plan built on
    // yesterday's injury news presented as current is worse than no plan.
    if (cached) {
      return {
        status: 200, body: cached.body, cache: 'hit', fetchedAt: cached.fetchedAt,
        stale: true, ageSeconds: ageSeconds(cached.fetchedAt, now),
      };
    }
    return { status: 503, body: { error: 'upstream_unavailable' }, cache: 'miss', fetchedAt: new Date(now).toISOString(), stale: false, ageSeconds: 0 };
  }
}

/**
 * Try to become the one caller that refreshes `key`.
 *
 * Etag-conditional, so this is a genuine claim and not a read-then-hope: two
 * instances that read the same absent/expired lease both try to write it, and
 * Blobs admits exactly one. The loser is told to serve stale.
 *
 * Fails OPEN. If the store cannot be read or written the answer is "yes, you
 * refresh" - a cache is an optimisation in front of a public API, and losing
 * the coalescing must cost extra upstream calls, never an error.
 *
 * @returns {Promise<boolean>} true when this caller owns the refresh.
 */
export async function claimRefreshLease(store, key, now, leaseId) {
  const id = leaseId || `${now}-${Math.random().toString(36).slice(2, 10)}`;
  let current;
  try {
    current = await store.getWithMetadata(leaseKey(key), { type: 'json' });
  } catch (err) {
    console.error('fpl lease read failed', key, String(err && err.message));
    return true;
  }
  const held = current && current.data && typeof current.data === 'object' ? current.data : null;
  if (held && Number(held.expiresAt) > now) return false;   // somebody else is on it

  const condition = (current && current.etag) ? { onlyIfMatch: current.etag } : { onlyIfNew: true };
  try {
    const res = await store.setJSON(
      leaseKey(key), { owner: id, expiresAt: now + REFRESH_LEASE_SECONDS * 1000 }, condition
    );
    // A client that ignores the condition returns undefined rather than
    // { modified }. Treat that as "won" - the same fail-open reasoning as
    // above, and blobs-version.test.mjs is the layer that catches the pin.
    return !res || res.modified !== false;
  } catch (err) {
    console.error('fpl lease write failed', key, String(err && err.message));
    return true;
  }
}

function ageSeconds(fetchedAt, now) {
  const ms = Date.parse(fetchedAt);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now - ms) / 1000));
}

// A cache read that throws is a cache miss, not an outage. The store is a
// speed-up in front of a public API; if it is unreachable the right answer is
// to go and ask upstream, not to fail the request.
async function readCache(store, key) {
  let entry;
  try {
    entry = await store.get(key, { type: 'json' });
  } catch (err) {
    console.error('fpl cache read failed', key, String(err && err.message));
    return null;
  }
  if (!entry || typeof entry !== 'object' || entry.body === undefined) return null;
  // An entry whose timestamp cannot be parsed would otherwise be served as
  // age-zero fresh forever, because ageSeconds() treats an unparseable date as
  // zero. Refusing it here sends the request upstream instead.
  if (!Number.isFinite(Date.parse(entry.fetchedAt))) return null;
  return entry;
}

async function readDeadline(store) {
  try {
    const meta = await store.get(DEADLINE_KEY, { type: 'json' });
    return (meta && meta.nextDeadline) || null;
  } catch (err) {
    console.error('fpl deadline meta read failed', String(err && err.message));
    return null;
  }
}
