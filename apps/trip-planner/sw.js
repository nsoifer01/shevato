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
 *   - On every activate, drop old-version caches.
 *
 * CACHE_VERSION is semver: bump PATCH when the precache contents change,
 * MINOR when the strategy changes, MAJOR for a back-compat break.
 */

const CACHE_VERSION = '2.1.4';
const PRECACHE = `trip-precache-${CACHE_VERSION}`;
const RUNTIME = `trip-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css?v=27',
  './js/trip-logic.js?v=15',
  './js/app.js?v=31',
  '../../assets/css/main.css',
  '../../assets/css/sync-status.css',
  '../../assets/js/passive-events-fix.js',
  '../../assets/js/jquery.min.js',
  '../../assets/js/browser.min.js',
  '../../assets/js/breakpoints.min.js',
  '../../assets/js/util.js',
  '../../assets/js/main.js',
  '../../images/icon-192.png',
  '../../images/icon-512.png',
  // self-hosted Leaflet (see ensureLeaflet): precached so the Map view is not
  // hostage to a third-party CDN with no SLA
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
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
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
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
      // offline: fall back to anything cached (runtime or precache)
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
