/**
 * Trip Planner Service Worker.
 *
 * Strategy:
 *   - Precache the app shell (HTML, CSS, the pure logic + app JS, the shared
 *     site scripts and icons) on install so the planner opens offline.
 *   - NETWORK-FIRST for same-origin requests: an online load always gets the
 *     newest code (a cache-first draft of this worker kept serving stale
 *     app.js during rapid iteration); the caches are only an offline
 *     fallback.
 *   - Never intercept cross-origin requests (Nominatim, map tiles, frankfurter,
 *     Open-Meteo, the visa dataset on raw.githubusercontent, Firebase): those
 *     have their own lifetimes and framing/caching rules.
 *   - On every activate, drop old-version caches UNDER OUR OWN NAME PREFIX.
 *     shevato.com is a single origin for every app on the site, so caches.keys()
 *     also lists the other apps' shells; only their own workers may delete those.
 *   - Tell open tabs when a NEW version took over, so a tab left open for days
 *     can offer a reload instead of quietly running last week's JS.
 *
 * CACHE_VERSION is semver: bump PATCH when the precache contents change,
 * MINOR when the strategy changes, MAJOR for a back-compat break.
 *
 * ESSENTIAL vs OPTIONAL (2026-09-07): the precache used to be one list added
 * with `cache.add(u).catch(() => {})` per URL, so an install in which the
 * stylesheet 404'd still RESOLVED - and `activate` then deleted the previous
 * version's caches, which were the last working shell on the device. That is
 * exactly how a first-visit-then-offline reload produced a white, unstyled
 * page with hidden menus visible. The shell files an offline load cannot do
 * without are now installed with `addAll`, which is atomic: one 404 rejects
 * the install, the new worker never activates, and the device keeps the shell
 * it already had. Everything else (the airport table, Leaflet, icons, the
 * sync scripts) stays best-effort, because a missing one of those degrades a
 * feature rather than the page.
 */

const CACHE_VERSION = '2.7.0';
const PRECACHE = `trip-precache-${CACHE_VERSION}`;
const RUNTIME = `trip-runtime-${CACHE_VERSION}`;

// The shell an offline load is not allowed to lose. `?v=` is part of the
// cache key, so these strings must match index.html EXACTLY; a stale version
// here is a request that misses the cache and fails offline
// (apps/trip-planner/tests/sw-precache-completeness.test.mjs pins the parity,
// because the v=67-vs-v=66 drift shipped and was only found in a live cold
// offline reload).
const ESSENTIAL_URLS = [
  './',
  './index.html',
  './css/styles.css?v=68',
  './js/trip-logic.js?v=53',
  './js/app.js?v=79',
  '../../assets/css/main.css',
  // The shared auth modal's stylesheet. index.html links it unconditionally,
  // so without it an offline load paints an unstyled auth card over the app.
  '../../assets/css/firebase-auth.css',
];

// Everything else the shell references. A miss here costs a feature, not the
// page, so these install best-effort and never block the worker.
const OPTIONAL_URLS = [
  './manifest.webmanifest',
  // The bundled airport table (see scripts/build-airports.mjs). ~260 KB, and
  // precached on purpose: an airport picker that stops working without signal
  // is useless in the one place you most need it.
  './data/airports.json',
  '../../assets/css/sync-status.css',
  '../../assets/css/back-to-top.css',
  '../../assets/js/passive-events-fix.js',
  '../../assets/js/sync-status.js',
  '../../assets/js/back-to-top.js',
  '../../assets/js/analytics.js',
  '../../assets/js/jquery.min.js',
  '../../assets/js/browser.min.js',
  '../../assets/js/breakpoints.min.js',
  '../../assets/js/util.js',
  '../../assets/js/main.js',
  // The sync shell. These were the gap between "the timeline works offline"
  // and the page actually loading clean: index.html requests them, the FIRST
  // visit runs uncontrolled (registration lands after the subresource
  // fetches), so nothing runtime-cached them and a first-visit-then-offline
  // load resolved each to a network error. Sync itself still needs Firebase
  // online; precaching only makes the failure quiet and complete.
  '../../sync-system/sync-immediate.js',
  '../../sync-system/tab-sync.js',
  '../../sync-system/storage-sync-robust.js',
  '../../sync-system/app-sync-init.js',
  '../../sync-system/sync-debug.js',
  '../../sync-system/sync-loading-modal.js',
  '../../sync-system/sync-modal-integration.js',
  '../../firebase-config.js',
  '../../images/icon-192.png',
  '../../images/icon-512.png',
  // self-hosted Leaflet (see ensureLeaflet): precached so the Map view is not
  // hostage to a third-party CDN with no SLA
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  // pdf.js (vendor/pdfjs/) is deliberately NOT precached. It is 1.7 MB, and
  // precaching it would put that on every install for a feature most visits
  // never touch. It is fetched on the first PDF import and the RUNTIME cache
  // keeps it from then on, so it costs nothing until it is used and nothing
  // again afterwards - including offline.
];

// The whole shell, in one list, for the completeness test and for anything
// that wants to know what this worker holds.
const PRECACHE_URLS = [...ESSENTIAL_URLS, ...OPTIONAL_URLS];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // ATOMIC, and deliberately so: if any one of these 404s the whole install
    // rejects, this worker never activates, and the previously installed
    // version keeps serving its own (complete) shell. The alternative -
    // swallowing the failure - installs a shell that is missing its
    // stylesheet and then deletes the good one on activate.
    await cache.addAll(ESSENTIAL_URLS);
    // Best-effort, and only AFTER the shell is safely in: a missing airport
    // table or icon must never cost the user their offline planner.
    await Promise.all(OPTIONAL_URLS.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([PRECACHE, RUNTIME]);
    const names = await caches.keys();
    // Ours and stale. The prefix test is load-bearing: without it this deleted
    // every cache on the origin, so activating here wiped gym-tracker's offline
    // shell (and its worker returned the favour).
    const stale = names.filter((n) => n.startsWith('trip-') && !keep.has(n));
    // Caches under our own prefix from another version are the only durable
    // proof that an EARLIER install of this app already ran on this device,
    // and they are still on disk at this point (the delete below is what
    // removes them). Counting window clients cannot answer the same question:
    // a first-ever install also finds the tab that just registered it open,
    // which is exactly the case that must stay silent.
    const replacedPrevious = stale.length > 0;
    await Promise.all(stale.map((n) => caches.delete(n)));
    await self.clients.claim();
    if (!replacedPrevious) return;
    const windows = await self.clients.matchAll({ type: 'window' });
    // The version rides along so a tab can offer one toast per VERSION rather
    // than one per tab for its lifetime: a tab left open across two deploys
    // used to hear about the first and silently run two versions behind.
    for (const c of windows) c.postMessage({ type: 'tp-update-available', version: CACHE_VERSION });
  })());
});

// How long a network-first read may hold the page before the cache answers
// instead. `fetch` on a dead-but-not-refused connection (captive portal,
// train tunnel, "lie-fi") does not reject: it hangs until the browser's own
// multi-minute timeout, and network-first means the app hangs with it even
// though a perfectly good precached copy is sitting on disk. Generous enough
// that a slow-but-real 3G response still wins and gets runtime-cached.
const NETWORK_FIRST_TIMEOUT_MS = 6000;

// fetch(req) with a deadline. Rejects (rather than resolving to a bad
// response) on timeout so the caller's existing catch runs the cache path.
function fetchWithDeadline(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network-first timeout')), ms);
    fetch(req).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  // Off-origin first: never touch Nominatim / tiles / frankfurter / Open-Meteo
  // / raw.githubusercontent / Firebase.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    try {
      const res = await fetchWithDeadline(req, NETWORK_FIRST_TIMEOUT_MS);
      if (res && res.ok) {
        const cache = await caches.open(RUNTIME);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      // Offline: RUNTIME first, then the precache. caches.match searches
      // caches in creation order, and the precache (created at install) came
      // first, so after a deploy that did not byte-change this worker the
      // install-time snapshot was served over the fresher copy every later
      // online visit had runtime-cached.
      const runtime = await caches.open(RUNTIME);
      const fresh = await runtime.match(req);
      if (fresh) return fresh;
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
