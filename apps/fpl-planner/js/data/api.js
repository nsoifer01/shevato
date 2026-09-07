// Browser-side FPL client.
//
// Talks to the Netlify proxy (netlify/functions/fpl.mjs), because
// fantasy.premierleague.com sends no CORS headers and cannot be read directly
// from a page on shevato.com. Adds a memory + localStorage cache with
// per-endpoint TTLs, single-flight de-duplication per path, and the freshness
// metadata the UI needs to say how old its numbers are.
//
// The cache keys live under `fpl-planner:cache:` and are deliberately NOT in
// the app's sync namespace: they are large, identical for every user and fully
// derivable, so syncing them would burn quota to move public data around.

export const CACHE_PREFIX = 'fpl-planner:cache:';
export const PROXY_URL = '/.netlify/functions/fpl';
export const DIRECT_BASE = 'https://fantasy.premierleague.com/api/';

// Seconds, mirroring the server policy in netlify/functions/lib/fpl-cache.mjs.
// The client cache sits in front of the shared one, so these only govern how
// often a single browser re-asks.
export const CLIENT_TTL = {
  bootstrap: 600,
  fixtures: 1800,
  entry: 300,
  'element-summary': 900,
  live: 60,
};

// Inside this window before a deadline, every client TTL collapses to
// DEADLINE_TTL_SECONDS.
//
// The proxy already does this (netlify/functions/lib/fpl-cache.mjs) because
// that is when prices, injury news and team news move. The BROWSER cache sits in
// front of the proxy and short-circuits before it is ever asked, so leaving this
// out meant a manager in the final hour was reading ten-minute-old prices while
// the shared cache behind them was two minutes fresh. Same intent, same numbers,
// both sides.
export const DEADLINE_WINDOW_SECONDS = 6 * 3600;
export const DEADLINE_TTL_SECONDS = 120;

// One retry, for the failures that are worth retrying.
//
// Deadline day is when FPL is least reliable and when a cold cache key (nobody
// has ever fetched this manager's GW1 picks) has no copy to fall back on. A
// single retry with a little jitter turns a one-off blip into a slower success;
// anything more would be a client hammering an upstream that is already
// struggling.
export const RETRY_STATUSES = [500, 502, 503, 504, 408, 429];
export const RETRY_DELAY_MS = 300;
export const RETRY_JITTER_MS = 200;

// Deadlines, because a request that never settles is not a failure any of the
// code above can see.
//
// Retry and stale-fallback both live in a `catch`, so they only run once a
// request FAILS. A connection that is opened and then simply never answers
// (captive portal, a dead middlebox, a mobile handover) rejects nothing: the
// planner sat on its loading state, and because fetchPath de-duplicates by
// path, a second refresh - including a FORCED one - joined the same stuck
// promise instead of starting a live request. The server's own upstream
// timeout bounds function-to-FPL, not browser-to-function.
//
// ATTEMPT_TIMEOUT_MS bounds one network attempt. It is deliberately larger
// than the function's own 9s upstream budget plus a cold start, so a slow but
// working request is never killed for being slow.
//
// TOTAL_DEADLINE_MS bounds the whole operation (attempt + retry delay +
// retry). Past it the operation gives up rather than starting work it cannot
// finish, and fetchPath's existing handler serves the stale cached copy.
export const ATTEMPT_TIMEOUT_MS = 15000;
export const TOTAL_DEADLINE_MS = 32000;

/** A request that ran out of time rather than being refused. */
export class RequestTimeoutError extends Error {
  constructor(path) {
    super(`timed out fetching ${path}`);
    this.name = 'RequestTimeoutError';
    this.path = path;
  }
}

const SOURCE_LABELS = [
  [/^bootstrap-static$/, 'Players, prices and news'],
  [/^fixtures$/, 'Fixtures'],
  [/^entry\/\d+$/, 'Your team'],
  [/^entry\/\d+\/history$/, 'Your season history'],
  [/^entry\/\d+\/transfers$/, 'Your transfer history'],
  [/^entry\/\d+\/event\/\d+\/picks$/, 'Your squad'],
  [/^element-summary\/\d+$/, 'Player match history'],
  [/^event\/\d+\/live$/, 'Live scores'],
];

export function labelFor(path) {
  const hit = SOURCE_LABELS.find(([re]) => re.test(path));
  return hit ? hit[1] : path;
}

function kindOf(path) {
  if (path === 'bootstrap-static') return 'bootstrap';
  if (path === 'fixtures') return 'fixtures';
  if (path.startsWith('entry/')) return 'entry';
  if (path.startsWith('element-summary/')) return 'element-summary';
  return 'live';
}

// A team id or gameweek reaching a URL must be a plain positive integer. This
// is the only place user input becomes part of a request path.
function id(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid ${what}: ${value}`);
  return n;
}

export class NotFoundError extends Error {
  constructor(path) {
    super(`not found: ${path}`);
    this.name = 'NotFoundError';
    this.path = path;
  }
}

// Raised when the proxy function is not being served AND the direct fallback is
// blocked, which is what happens on a plain static server and, less obviously,
// on `netlify dev`'s INTERNAL static port. netlify dev listens twice: a file
// server (commonly 3999) and the Netlify proxy (commonly 8888). Only the proxy
// routes /.netlify/functions/*, so opening the file server port gives a 404 on
// every function call followed by a CORS failure on the fallback. Without this,
// the user sees a generic network error and no hint about which port to use.
export class ProxyUnavailableError extends Error {
  constructor({ localDev, cause }) {
    super(localDev
      ? 'The FPL data service is not reachable on this address, and the browser blocked the direct fallback '
        + '(Fantasy Premier League sends no CORS header). If you are running "netlify dev", open the Netlify '
        + 'port, usually 8888, rather than its internal static server port. A plain static file server cannot '
        + 'load live FPL data at all.'
      : 'The FPL data service did not respond, so live data could not be loaded. Please try again shortly.');
    this.name = 'ProxyUnavailableError';
    this.localDev = localDev;
    this.cause = cause;
  }
}

// Only meaningful in a browser. In node (tests, scripts) there is no origin and
// no CORS, so the local-dev advice would be nonsense.
function isLocalDevOrigin() {
  if (typeof location === 'undefined' || !location || !location.hostname) return false;
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
}

export function createFplApi({
  fetchImpl,
  storage,
  now = () => Date.now(),
  proxyUrl = PROXY_URL,
  directBase = DIRECT_BASE,
  // Injectable so tests can exercise a real timeout in milliseconds rather
  // than waiting fifteen seconds for the production budget.
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  totalDeadlineMs = TOTAL_DEADLINE_MS,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
  const store = storage !== undefined ? storage : safeLocalStorage();

  const memory = new Map();   // path -> { fetchedAt, stale, data }
  const inflight = new Map(); // path -> Promise
  const status = new Map();   // path -> { name, ok, fetchedAt, ageSeconds, error }
  let proxyAvailable = true;
  let sampleBundle = null;

  // How old a cached copy is.
  //
  // NOT `now() - fetchedAt`: `fetchedAt` is the SERVER's clock and `now()` is
  // the device's, and subtracting one from the other measures the skew between
  // them as much as the age. A device an hour slow produced a negative age,
  // clamped to zero, and therefore a cache entry that never expired: the app
  // stayed on a pre-season bootstrap after the deadline with no way out but
  // clearing storage. A device an hour fast reported fresh data as stale.
  //
  // So age is measured from the LOCAL receipt time, which shares a clock with
  // now() by construction, and falls back to the server timestamp only for
  // entries written before this existed.
  // TWO different ages, and conflating them is what made this wrong.
  //
  // `localAgeOf` is how long THIS BROWSER has held the copy. It shares a clock
  // with now() by construction, so it is immune to device clock skew, and it is
  // the only thing a cache expiry may be decided on. A device an hour slow used
  // to produce a negative age, clamped to zero, and an entry that never expired.
  //
  // `ageOf` is how old the DATA is, which is what the user is told. It is the
  // server's own age at the moment the copy arrived plus the time held since.
  function localAgeOf(entry) {
    const receipt = entry && Number.isFinite(entry.receivedAt) ? entry.receivedAt : null;
    if (receipt === null) return Infinity;   // written before receipts existed: refetch
    return Math.max(0, Math.floor((now() - receipt) / 1000));
  }

  function ageOf(fetchedAt, entry) {
    const held = entry && Number.isFinite(entry.receivedAt)
      ? Math.max(0, Math.floor((now() - entry.receivedAt) / 1000))
      : 0;
    if (entry && Number.isFinite(entry.serverAgeSeconds)) return entry.serverAgeSeconds + held;
    const ms = Date.parse(fetchedAt);
    if (!Number.isFinite(ms)) return held;
    return Math.max(0, Math.floor((now() - ms) / 1000));
  }

  // The TTL for a path right now, collapsed near a deadline exactly as the proxy
  // does. The deadline comes from the bootstrap this client already holds, so
  // this costs no extra request.
  function ttlFor(path) {
    const base = CLIENT_TTL[kindOf(path)];
    const deadline = nextDeadlineMs();
    if (deadline === null) return base;
    const untilDeadline = (deadline - now()) / 1000;
    if (untilDeadline <= 0 || untilDeadline > DEADLINE_WINDOW_SECONDS) return base;
    return Math.min(base, DEADLINE_TTL_SECONDS);
  }

  // The next deadline in the future, read out of the cached bootstrap.
  function nextDeadlineMs() {
    const entry = memory.get('bootstrap-static') || null;
    const events = entry && entry.data && Array.isArray(entry.data.events) ? entry.data.events : null;
    if (!events) return null;
    let best = null;
    for (const e of events) {
      const t = Date.parse(e.deadline_time);
      if (!Number.isFinite(t) || t <= now()) continue;
      if (best === null || t < best) best = t;
    }
    return best;
  }

  function readCache(path) {
    if (memory.has(path)) return memory.get(path);
    if (!store) return null;
    const raw = store.getItem(CACHE_PREFIX + path);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw);
      if (!entry || entry.data === undefined) return null;
      memory.set(path, entry);
      return entry;
    } catch {
      store.removeItem(CACHE_PREFIX + path);
      return null;
    }
  }

  function writeCache(path, entry) {
    memory.set(path, entry);
    if (!store) return;

    // The bootstrap is 2.6 MiB of a roughly 5 MiB per-origin budget shared with
    // every other app on the domain, and it is re-fetched on every boot anyway
    // because its TTL is ten minutes. Persisting it bought almost nothing and
    // cost more than half the quota, so it lives in memory for the session only.
    if (kindOf(path) === 'bootstrap') return;

    const key = CACHE_PREFIX + path;
    const payload = JSON.stringify(entry);
    try {
      store.setItem(key, payload);
    } catch {
      // shevato.com's apps share one localStorage quota, so a write can
      // genuinely fail. Evict the OLDEST entries of this app's cache rather
      // than all of them: wiping everything threw away the copies that were
      // still useful and left the session with no persisted cache at all.
      if (evictOldest() && tryWrite(key, payload)) return;
      if (evictOldest() && tryWrite(key, payload)) return;
      clearStoredCache();
      tryWrite(key, payload);
    }
  }

  function tryWrite(key, payload) {
    try { store.setItem(key, payload); return true; } catch { return false; }
  }

  // Drop the least recently received entry this app owns. Returns false when
  // there is nothing left to drop, so the caller stops rather than looping.
  function evictOldest() {
    if (!store) return false;
    let oldestKey = null;
    let oldestAt = Infinity;
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k || !k.startsWith(CACHE_PREFIX)) continue;
      let at = 0;
      try {
        const parsed = JSON.parse(store.getItem(k));
        at = Number.isFinite(parsed && parsed.receivedAt) ? parsed.receivedAt : Date.parse(parsed && parsed.fetchedAt) || 0;
      } catch { at = 0; }
      if (at < oldestAt) { oldestAt = at; oldestKey = k; }
    }
    if (!oldestKey) return false;
    store.removeItem(oldestKey);
    return true;
  }

  function clearStoredCache(prefix = '') {
    if (!store) return;
    const keys = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(CACHE_PREFIX + prefix)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  }

  function record(path, entry, error) {
    status.set(path, {
      name: labelFor(path),
      path,
      ok: !error,
      fetchedAt: entry ? entry.fetchedAt : null,
      ageSeconds: entry ? ageOf(entry.fetchedAt, entry) : null,
      stale: entry ? !!entry.stale : false,
      error: error ? String(error.message || error) : null,
    });
  }

  // One retry, and only for the failures a retry can fix.
  //
  // A cold key has no cached copy to fall back on (nobody has ever fetched this
  // manager's GW1 picks before the GW1 deadline), and deadline day is exactly
  // when a transient 5xx is most likely. A 404 is a real answer and is never
  // retried; neither is a 403 or a 400.
  // A retryable STATUS is decided by the consumer (it holds the response);
  // this decides retryable ERRORS. A timeout is one: the attempt budget is
  // deliberately smaller than the operation budget so a single stall gets a
  // second chance rather than costing the whole request.
  const retryable = (err) => !!err
    && (err.name === 'AbortError' || err.name === 'TypeError'
        || err instanceof RequestTimeoutError);

  // One attempt, with its own abort deadline, and the BODY READ INSIDE IT.
  //
  // AbortController rather than AbortSignal.timeout so the timer is ours to
  // clear: leaving a 15s timer armed after a fast response keeps the event
  // loop alive for no reason.
  //
  // `consume` reads the response while the signal is still armed. That is the
  // whole reason this takes a callback: headers can arrive promptly and the
  // BODY then stall forever (a proxy that opens a response and never fills
  // it), and a deadline that is cleared the moment the Response object exists
  // bounds nothing that matters. `res.json()` has to happen under the same
  // abort as the connection that produced it.
  //
  // `deadline` is the wall-clock moment the WHOLE operation must be done by;
  // the attempt gets the smaller of its own budget and what is left of that,
  // so a retry can never run past the operation deadline.
  async function attempt(url, init, deadline, consume) {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError(url);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const budget = Math.min(attemptTimeoutMs, remaining);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (controller) controller.abort();
    }, budget);
    try {
      const res = await doFetch(url, controller ? { ...init, signal: controller.signal } : init);
      return await consume(res);
    } catch (err) {
      // An abort we caused is a timeout, not "the user navigated away", and
      // it must carry that meaning into the stale-fallback path.
      if (timedOut) throw timeoutError(url);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function timeoutError(url) {
    return new RequestTimeoutError(url);
  }

  // A consumed result may ask for a retry instead of being an answer, because
  // the retry decision is made on the status line while the body is still
  // unread. `{ retryStatus }` is that marker and never escapes this file.
  const retryMarker = (status) => ({ retryStatus: status });

  async function fetchWithRetry(url, init, deadline, consume) {
    let firstErr = null;
    try {
      const out = await attempt(url, init, deadline, consume);
      if (!out || out.retryStatus === undefined) return out;
      firstErr = new Error(`upstream ${out.retryStatus} for ${url}`);
    } catch (err) {
      firstErr = err;
      if (!retryable(err, 0)) throw err;
    }
    const delay = RETRY_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
    // No point sleeping through a deadline that has already passed, and no
    // point starting a retry there is no time left to finish.
    if (now() + delay >= deadline) throw firstErr;
    await new Promise(r => setTimeout(r, delay));
    let out;
    try {
      out = await attempt(url, init, deadline, consume);
    } catch (err) {
      throw firstErr || err;
    }
    if (out && out.retryStatus !== undefined) throw firstErr;
    return out;
  }

  async function requestProxy(path, deadline) {
    return fetchWithRetry(
      `${proxyUrl}?path=${encodeURIComponent(path)}`,
      { headers: { Accept: 'application/json' } },
      deadline,
      async (res) => {
        if (RETRY_STATUSES.includes(res.status)) return retryMarker(res.status);
        // Our function always stamps x-fpl-cache. A 404 without it is the
        // static dev server saying the function does not exist here, not FPL
        // saying the team id is unknown, and the two must not be confused.
        const isOurs = !!res.headers.get('x-fpl-cache');
        if (!isOurs && (res.status === 404 || res.status === 405)) return { absent: true };
        if (res.status === 404) throw new NotFoundError(path);
        if (!res.ok) throw new Error(`proxy ${res.status} for ${path}`);
        return {
          data: await res.json(),
          fetchedAt: res.headers.get('x-fpl-fetched-at') || new Date(now()).toISOString(),
          stale: res.headers.get('x-fpl-stale') === 'true',
          // The proxy computes this on its own clock, which is the only clock
          // that can say how old the DATA is. Carried through so freshness
          // never has to be inferred by subtracting a server timestamp from a
          // device clock.
          serverAgeSeconds: Number.parseInt(res.headers.get('x-fpl-age-seconds') || '', 10),
        };
      }
    );
  }

  // Direct upstream. Only reachable where CORS is not in the way (a
  // `netlify dev` session serves the proxy instead, and a plain static server
  // on localhost will be blocked by FPL's missing CORS headers). Kept because
  // it costs nothing and makes the client work anywhere the browser allows it.
  async function requestDirect(path, deadline) {
    return attempt(
      `${directBase}${path}/`,
      { headers: { Accept: 'application/json' } },
      deadline,
      async (res) => {
        if (res.status === 404) throw new NotFoundError(path);
        if (!res.ok) throw new Error(`upstream ${res.status} for ${path}`);
        return { data: await res.json(), fetchedAt: new Date(now()).toISOString(), stale: false };
      }
    );
  }

  async function load(path, deadline) {
    let proxyWasAbsent = false;
    if (proxyAvailable) {
      const out = await requestProxy(path, deadline);
      if (!out.absent) return out;
      proxyAvailable = false;
      proxyWasAbsent = true;
    }
    try {
      return await requestDirect(path, deadline);
    } catch (err) {
      // A NotFoundError is a real answer from FPL (unknown team id) and must
      // keep its meaning. Anything else, once we already know the proxy is not
      // being served, is the environment being wrong rather than the data.
      if (err instanceof NotFoundError) throw err;
      if (proxyWasAbsent || !proxyAvailable) {
        throw new ProxyUnavailableError({ localDev: isLocalDevOrigin(), cause: err });
      }
      throw err;
    }
  }

  async function fetchPath(path, { force = false } = {}) {
    if (sampleBundle) return sampleRead(path);

    const cached = readCache(path);
    if (cached && !force && localAgeOf(cached) < ttlFor(path)) {
      record(path, cached, null);
      return { data: cached.data, fetchedAt: cached.fetchedAt, stale: !!cached.stale, ageSeconds: ageOf(cached.fetchedAt, cached) };
    }

    // One in-flight request per path. Without this, a dashboard that asks four
    // components for the bootstrap at once downloads it four times.
    if (inflight.has(path)) return inflight.get(path);

    const deadline = now() + totalDeadlineMs;
    const job = (async () => {
      try {
        const fresh = await load(path, deadline);
        // `receivedAt` is this device's clock at the moment the copy arrived, so
        // freshness is later measured against the same clock that recorded it.
        const entry = {
          fetchedAt: fresh.fetchedAt,
          stale: fresh.stale,
          data: fresh.data,
          receivedAt: now(),
          serverAgeSeconds: Number.isFinite(fresh.serverAgeSeconds) ? fresh.serverAgeSeconds : undefined,
        };
        writeCache(path, entry);
        record(path, entry, null);
        return { data: entry.data, fetchedAt: entry.fetchedAt, stale: entry.stale, ageSeconds: ageOf(entry.fetchedAt, entry) };
      } catch (err) {
        record(path, cached, err);
        // A cached copy is better than a dead screen, but it must be flagged
        // stale so the UI can say the plan rests on old numbers.
        if (cached && !(err instanceof NotFoundError)) {
          return { data: cached.data, fetchedAt: cached.fetchedAt, stale: true, ageSeconds: ageOf(cached.fetchedAt, cached) };
        }
        throw err;
      } finally {
        inflight.delete(path);
      }
    })();

    inflight.set(path, job);
    return job;
  }

  function sampleRead(path) {
    const data = sampleBundle.byPath[path];
    if (data === undefined) throw new NotFoundError(path);
    const entry = { fetchedAt: sampleBundle.fetchedAt, stale: false, data };
    record(path, entry, null);
    return { data, fetchedAt: entry.fetchedAt, stale: false, ageSeconds: 0, sample: true };
  }

  return {
    fetchPath,

    getBootstrap: (opts) => fetchPath('bootstrap-static', opts),
    getFixtures: (opts) => fetchPath('fixtures', opts),
    getEntry: (entryId, opts) => fetchPath(`entry/${id(entryId, 'team id')}`, opts),
    getEntryHistory: (entryId, opts) => fetchPath(`entry/${id(entryId, 'team id')}/history`, opts),
    getEntryTransfers: (entryId, opts) => fetchPath(`entry/${id(entryId, 'team id')}/transfers`, opts),
    getEntryPicks: (entryId, gw, opts) => fetchPath(`entry/${id(entryId, 'team id')}/event/${id(gw, 'gameweek')}/picks`, opts),
    getElementSummary: (playerId, opts) => fetchPath(`element-summary/${id(playerId, 'player id')}`, opts),
    getEventLive: (gw, opts) => fetchPath(`event/${id(gw, 'gameweek')}/live`, opts),

    // The deadlines this instance is running with, so the UI (and a test) can
    // say how long a request is allowed to take before it becomes an error.
    deadlines: () => ({ attemptTimeoutMs, totalDeadlineMs }),

    // DataStatus.sources, in the order the paths were first requested.
    getDataStatus() {
      return {
        sample: !!sampleBundle,
        sources: [...status.values()],
      };
    },

    // SAMPLE DATA IS NEVER A FALLBACK. This is called only from an explicit
    // `?demo=1` check in app.js, never from an error path, and once set every
    // read is served from the bundle and reported with sample: true.
    useSampleData(bundle) {
      if (!bundle || !bundle.sample || !bundle.byPath) throw new Error('refusing a bundle that is not labelled sample data');
      sampleBundle = bundle;
      status.clear();
    },
    isSampleMode: () => !!sampleBundle,

    // `prefix` scopes the clear to one family of paths ('entry/' drops every
    // cached copy of the manager's own data and leaves the public bulk data).
    clearCache({ prefix = '' } = {}) {
      for (const path of [...memory.keys()]) if (path.startsWith(prefix)) memory.delete(path);
      for (const path of [...status.keys()]) if (path.startsWith(prefix)) status.delete(path);
      clearStoredCache(prefix);
    },
  };
}

function safeLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// The instance the app uses. Engine modules never import this; only app.js,
// the worker and the UI layer do.
export const fplApi = createFplApi();
