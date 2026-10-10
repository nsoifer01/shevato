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
  { re: /^event-status$/, kind: 'event-status' },
];

// Seconds. bootstrap carries prices and injury news (10 min), fixtures move
// rarely (30 min), an entry changes only when its owner acts (5 min), a player
// summary is history (15 min), and live scores move every minute during a match.
// event-status is FPL's own "points / bonus / leagues processed" board, which
// flips during the hours after a deadline, so it is as short as live scores.
export const TTL = {
  bootstrap: 600,
  fixtures: 1800,
  entry: 300,
  'element-summary': 900,
  live: 60,
  'event-status': 60,
};

// A manager's picks for a gameweek BEFORE the current one never change again:
// they locked at that gameweek's deadline and the gameweek has been played. The
// History tab asks for the last eight of them on every visit, so a short TTL
// only re-downloaded fixed history. Deliberately not collapsed by either
// deadline window, because nothing about a finished gameweek moves at one.
export const FINISHED_PICKS_TTL_SECONDS = 24 * 3600;
const PICKS_RE = /^entry\/\d+\/event\/(\d+)\/picks$/;

// Inside this window before a deadline, prices, injury news and free-transfer
// counts all matter to the minute, so every TTL collapses.
export const DEADLINE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const DEADLINE_TTL_SECONDS = 120;

// And for this long AFTER one (2026-10-09 audit B4). The collapse used to end
// at the deadline itself, so the minutes when the gameweek flips were the ones
// with the LONGEST cache life: at deadline + 30 s a bootstrap fetched just
// before it was served as fresh with eight minutes to run, still naming the
// locked gameweek as next. FPL itself takes a while to move on (is_next flips,
// prices settle, picks for the new gameweek appear), so the short TTL is held
// for an hour past the most recent deadline.
export const POST_DEADLINE_WINDOW_MS = 60 * 60 * 1000;

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

// `nextDeadline` and `lastDeadline` are what the stored meta says (ISO strings
// or null); `currentEvent` is the gameweek FPL called current when it was
// written. A `nextDeadline` that has since passed IS the most recent deadline:
// the meta is only rewritten when a bootstrap is fetched, so in the minutes
// after a deadline it still names the one that just went by.
export function ttlSeconds(path, { now, nextDeadline, lastDeadline, currentEvent } = {}) {
  if (isFinishedPicks(path, currentEvent)) return FINISHED_PICKS_TTL_SECONDS;
  const base = TTL[pathKind(path)] ?? TTL.entry;
  return inDeadlineWindow({ now, nextDeadline, lastDeadline }) ? Math.min(base, DEADLINE_TTL_SECONDS) : base;
}

// Whether `now` is inside either collapse window: the six hours before the
// next deadline, or the hour after the most recent one.
export function inDeadlineWindow({ now, nextDeadline, lastDeadline } = {}) {
  const next = Date.parse(nextDeadline);
  if (Number.isFinite(next)) {
    const untilDeadline = next - now;
    if (untilDeadline > 0 && untilDeadline <= DEADLINE_WINDOW_MS) return true;
  }
  for (const passed of [next, Date.parse(lastDeadline)]) {
    if (!Number.isFinite(passed)) continue;
    const since = now - passed;
    if (since >= 0 && since < POST_DEADLINE_WINDOW_MS) return true;
  }
  return false;
}

function isFinishedPicks(path, currentEvent) {
  const m = PICKS_RE.exec(path);
  return !!m && Number.isInteger(currentEvent) && Number(m[1]) < currentEvent;
}

// Blob keys cannot carry the path separators verbatim without reading like a
// directory tree, so they are flattened. The mapping is injective because the
// allowlist admits no ':' or '__'.
export function cacheKey(path) {
  return 'v1:' + path.replace(/\//g, '__');
}

// The most recent deadline that has passed, which holds the collapse on for
// POST_DEADLINE_WINDOW_MS after it.
export function lastDeadlineFrom(bootstrapBody, now) {
  const events = (bootstrapBody && bootstrapBody.events) || [];
  let best = null;
  for (const e of events) {
    const ms = Date.parse(e && e.deadline_time);
    if (!Number.isFinite(ms) || ms > now) continue;
    if (best === null || ms > best) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

// The gameweek FPL calls current, or null before the season starts. Picks for
// any gameweek before it are finished history (FINISHED_PICKS_TTL_SECONDS).
export function currentEventFrom(bootstrapBody) {
  const events = (bootstrapBody && bootstrapBody.events) || [];
  const current = events.find(e => e && e.is_current);
  return current && Number.isInteger(current.id) ? current.id : null;
}

// The deadline facts every TTL is judged against, read out of one bootstrap.
export function deadlineMetaFrom(bootstrapBody, now) {
  return {
    nextDeadline: nextDeadlineFrom(bootstrapBody, now),
    lastDeadline: lastDeadlineFrom(bootstrapBody, now),
    currentEvent: currentEventFrom(bootstrapBody),
  };
}

// WHAT A 200 MUST LOOK LIKE BEFORE IT IS CACHED.
//
// FPL answers some failures with a 200: a maintenance string while a gameweek
// is processed, an empty object, a truncated payload. Cached, that is served to
// every visitor as fresh for a whole TTL and the planner fails on it with an
// error that names our code rather than FPL's. Each check is the minimum the
// app reads from that endpoint, nothing stricter, so a field FPL adds or drops
// elsewhere never makes a good payload look bad.
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const SHAPES = [
  [/^bootstrap-static$/, b => isObject(b) && Array.isArray(b.elements) && Array.isArray(b.events) && Array.isArray(b.teams)],
  [/^fixtures$/, b => Array.isArray(b)],
  [/^entry\/\d+$/, b => isObject(b) && b.id !== undefined && b.id !== null],
  [/^entry\/\d+\/history$/, b => isObject(b) && Array.isArray(b.current)],
  [/^entry\/\d+\/transfers$/, b => Array.isArray(b)],
  [PICKS_RE, b => isObject(b) && Array.isArray(b.picks)],
  [/^element-summary\/\d+$/, b => isObject(b) && Array.isArray(b.history)],
  [/^event\/\d+\/live$/, b => isObject(b) && Array.isArray(b.elements)],
  [/^event-status$/, b => isObject(b) && Array.isArray(b.status)],
];

export function hasExpectedShape(path, body) {
  const shape = SHAPES.find(([re]) => re.test(path));
  return !!shape && shape[1](body);
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
// Returns { status, body, cache, fetchedAt, stale, ageSeconds }, plus the
// deadline meta (`nextDeadline`, `lastDeadline`, `currentEvent`) on a fresh
// 200: what this answer's TTL was judged against, so the edge-cache header can
// be held to the same windows (fpl.mjs edgeCachePolicy). The caller turns that
// into a Response, so this stays testable without a Request.
export async function serveFpl({ path, store, fetchUpstream, now, leaseId }) {
  const key = cacheKey(path);
  const cached = await readCache(store, key);

  if (cached) {
    const meta = await readDeadline(store);
    const age = ageSeconds(cached.fetchedAt, now);
    if (age < ttlSeconds(path, { now, ...meta })) {
      return { status: 200, body: cached.body, cache: 'hit', fetchedAt: cached.fetchedAt, stale: false, ageSeconds: age, ...meta };
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
    if (age < ttlSeconds(path, { now, ...meta }) + STALE_SERVE_SECONDS) {
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
    // A 200 that is not the payload is an outage that happens to say 200. It
    // takes the outage path below (the cached copy, marked stale) and is never
    // written over a good copy; with nothing cached it is a 502 that says why.
    if (!hasExpectedShape(path, body)) throw new MalformedUpstreamError(path);
    const fetchedAt = new Date(now).toISOString();
    // The deadlines the edge window must respect. A bootstrap carries them in
    // the body just fetched (fresher than the stored meta); any other path
    // reads the meta the last bootstrap wrote. One small read on a MISS only,
    // and a failed read is "no deadline known", the same answer the hit path
    // gives.
    const meta = path === 'bootstrap-static' ? deadlineMetaFrom(body, now) : await readDeadline(store);
    // The cache is an optimisation, so a failure to WRITE it must not lose the
    // body that was successfully fetched. Inside the outer try this threw the
    // fresh response away and answered 503, or served a day-old copy instead of
    // the one already in hand.
    try {
      await store.setJSON(key, { fetchedAt, body });
      if (path === 'bootstrap-static') {
        await store.setJSON(DEADLINE_KEY, meta);
      }
    } catch (writeErr) {
      console.error('fpl cache write failed', path, String(writeErr && writeErr.message));
    }
    return { status: 200, body, cache: 'miss', fetchedAt, stale: false, ageSeconds: 0, ...meta };
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
    if (err instanceof MalformedUpstreamError) {
      return { status: 502, body: { error: 'upstream_malformed' }, cache: 'miss', fetchedAt: new Date(now).toISOString(), stale: false, ageSeconds: 0 };
    }
    return { status: 503, body: { error: 'upstream_unavailable' }, cache: 'miss', fetchedAt: new Date(now).toISOString(), stale: false, ageSeconds: 0 };
  }
}

class MalformedUpstreamError extends Error {
  constructor(path) {
    super('upstream returned a malformed ' + path);
    this.name = 'MalformedUpstreamError';
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

// Always the same three keys, null when unknown. A meta written before
// lastDeadline/currentEvent existed reads as "not known", which is the base
// behaviour: no post-deadline collapse and no long-lived picks until the next
// bootstrap fetch rewrites it.
async function readDeadline(store) {
  const none = { nextDeadline: null, lastDeadline: null, currentEvent: null };
  try {
    const meta = await store.get(DEADLINE_KEY, { type: 'json' });
    if (!meta || typeof meta !== 'object') return none;
    return {
      nextDeadline: meta.nextDeadline || null,
      lastDeadline: meta.lastDeadline || null,
      currentEvent: Number.isInteger(meta.currentEvent) ? meta.currentEvent : null,
    };
  } catch (err) {
    console.error('fpl deadline meta read failed', String(err && err.message));
    return none;
  }
}
