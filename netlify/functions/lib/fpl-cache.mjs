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
export async function serveFpl({ path, store, fetchUpstream, now }) {
  const cached = await readCache(store, cacheKey(path));

  if (cached) {
    const nextDeadline = await readDeadline(store);
    const age = ageSeconds(cached.fetchedAt, now);
    if (age < ttlSeconds(path, { now, nextDeadline })) {
      return { status: 200, body: cached.body, cache: 'hit', fetchedAt: cached.fetchedAt, stale: false, ageSeconds: age };
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
      await store.setJSON(cacheKey(path), { fetchedAt, body });
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
