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
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
  const store = storage !== undefined ? storage : safeLocalStorage();

  const memory = new Map();   // path -> { fetchedAt, stale, data }
  const inflight = new Map(); // path -> Promise
  const status = new Map();   // path -> { name, ok, fetchedAt, ageSeconds, error }
  let proxyAvailable = true;
  let sampleBundle = null;

  function ageOf(fetchedAt) {
    const ms = Date.parse(fetchedAt);
    if (!Number.isFinite(ms)) return 0;
    return Math.max(0, Math.floor((now() - ms) / 1000));
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
    const key = CACHE_PREFIX + path;
    const payload = JSON.stringify(entry);
    try {
      store.setItem(key, payload);
    } catch {
      // shevato.com's apps share one localStorage quota and bootstrap-static is
      // over a megabyte, so a write can genuinely fail. Drop this app's cache
      // and try once; if it still fails the memory cache carries the session.
      clearStoredCache();
      try { store.setItem(key, payload); } catch { /* memory cache only */ }
    }
  }

  function clearStoredCache() {
    if (!store) return;
    const keys = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  }

  function record(path, entry, error) {
    status.set(path, {
      name: labelFor(path),
      path,
      ok: !error,
      fetchedAt: entry ? entry.fetchedAt : null,
      ageSeconds: entry ? ageOf(entry.fetchedAt) : null,
      stale: entry ? !!entry.stale : false,
      error: error ? String(error.message || error) : null,
    });
  }

  async function requestProxy(path) {
    const res = await doFetch(`${proxyUrl}?path=${encodeURIComponent(path)}`, {
      headers: { Accept: 'application/json' },
    });
    // Our function always stamps x-fpl-cache. A 404 without it is the static
    // dev server saying the function does not exist here, not FPL saying the
    // team id is unknown, and the two must not be confused.
    const isOurs = !!res.headers.get('x-fpl-cache');
    if (!isOurs && (res.status === 404 || res.status === 405)) return { absent: true };
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new Error(`proxy ${res.status} for ${path}`);
    return {
      data: await res.json(),
      fetchedAt: res.headers.get('x-fpl-fetched-at') || new Date(now()).toISOString(),
      stale: res.headers.get('x-fpl-stale') === 'true',
    };
  }

  // Direct upstream. Only reachable where CORS is not in the way (a
  // `netlify dev` session serves the proxy instead, and a plain static server
  // on localhost will be blocked by FPL's missing CORS headers). Kept because
  // it costs nothing and makes the client work anywhere the browser allows it.
  async function requestDirect(path) {
    const res = await doFetch(`${directBase}${path}/`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new Error(`upstream ${res.status} for ${path}`);
    return { data: await res.json(), fetchedAt: new Date(now()).toISOString(), stale: false };
  }

  async function load(path) {
    let proxyWasAbsent = false;
    if (proxyAvailable) {
      const out = await requestProxy(path);
      if (!out.absent) return out;
      proxyAvailable = false;
      proxyWasAbsent = true;
    }
    try {
      return await requestDirect(path);
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
    if (cached && !force && ageOf(cached.fetchedAt) < CLIENT_TTL[kindOf(path)]) {
      record(path, cached, null);
      return { data: cached.data, fetchedAt: cached.fetchedAt, stale: !!cached.stale, ageSeconds: ageOf(cached.fetchedAt) };
    }

    // One in-flight request per path. Without this, a dashboard that asks four
    // components for the bootstrap at once downloads it four times.
    if (inflight.has(path)) return inflight.get(path);

    const job = (async () => {
      try {
        const fresh = await load(path);
        const entry = { fetchedAt: fresh.fetchedAt, stale: fresh.stale, data: fresh.data };
        writeCache(path, entry);
        record(path, entry, null);
        return { data: entry.data, fetchedAt: entry.fetchedAt, stale: entry.stale, ageSeconds: ageOf(entry.fetchedAt) };
      } catch (err) {
        record(path, cached, err);
        // A cached copy is better than a dead screen, but it must be flagged
        // stale so the UI can say the plan rests on old numbers.
        if (cached && !(err instanceof NotFoundError)) {
          return { data: cached.data, fetchedAt: cached.fetchedAt, stale: true, ageSeconds: ageOf(cached.fetchedAt) };
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

    clearCache() {
      memory.clear();
      status.clear();
      clearStoredCache();
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
