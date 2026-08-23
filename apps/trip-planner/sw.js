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
 */

const CACHE_VERSION = '2.5.1';
const PRECACHE = `trip-precache-${CACHE_VERSION}`;
const RUNTIME = `trip-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css?v=64',
  './js/trip-logic.js?v=44',
  './js/app.js?v=70',
  // The bundled airport table (see scripts/build-airports.mjs). ~260 KB, and
  // precached on purpose: an airport picker that stops working without signal
  // is useless in the one place you most need it.
  './data/airports.json',
  '../../assets/css/main.css',
  '../../assets/css/sync-status.css',
  '../../assets/css/back-to-top.css',
  '../../assets/js/passive-events-fix.js',
  '../../assets/js/sync-status.js',
  '../../assets/js/back-to-top.js',
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

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // addAll would fail atomically on a single 404; add each URL on its own so
    // one missing asset never blocks the whole install.
    await Promise.all(PRECACHE_URLS.map((u) => cache.add(u).catch(() => {})));
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
    for (const c of windows) c.postMessage({ type: 'tp-update-available' });
  })());
});

self.addEventListener('fetch', (event) => {
  // Off-origin first: never touch Nominatim / tiles / frankfurter / Open-Meteo
  // / raw.githubusercontent / Firebase.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
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
