const CACHE_VERSION = 'v1';
const PAGES_CACHE = `pages-${CACHE_VERSION}`;
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const SCRIPTS_CACHE = `scripts-${CACHE_VERSION}`;
const IMAGES_CACHE = `images-${CACHE_VERSION}`;
const CDN_CACHE = `cdn-${CACHE_VERSION}`;
const PARTIALS_CACHE = `partials-${CACHE_VERSION}`;

const ALL_CACHES = [
  PAGES_CACHE,
  STATIC_CACHE,
  SCRIPTS_CACHE,
  IMAGES_CACHE,
  CDN_CACHE,
  PARTIALS_CACHE,
];

// Pages to precache so the app works offline immediately after install
const PRECACHE_PAGES = [
  '/apps.html',
  '/apps/mario-kart/tracker.html',
  '/apps/gym-tracker/index.html',
  '/apps/football-h2h/index.html',
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGES_CACHE).then((cache) => cache.addAll(PRECACHE_PAGES)));
  self.skipWaiting();
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

// ─── Fetch strategies ───────────────────────────────────────────────────────

function networkFirst(request, cacheName) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(cacheName).then((cache) => cache.put(request, clone));
      }
      return response;
    })
    .catch(() => caches.match(request));
}

function cacheFirst(request, cacheName, maxAgeDays) {
  return caches.match(request).then((cached) => {
    if (cached) {
      if (maxAgeDays) {
        const dateHeader = cached.headers.get('date');
        if (dateHeader) {
          const age = (Date.now() - new Date(dateHeader).getTime()) / 86400000;
          if (age > maxAgeDays) {
            return fetchAndCache(request, cacheName);
          }
        }
      }
      return cached;
    }
    return fetchAndCache(request, cacheName);
  });
}

function staleWhileRevalidate(request, cacheName) {
  return caches.match(request).then((cached) => {
    const fetchPromise = fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(cacheName).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => cached);

    return cached || fetchPromise;
  });
}

function fetchAndCache(request, cacheName) {
  return fetch(request).then((response) => {
    if (response.ok) {
      const clone = response.clone();
      caches.open(cacheName).then((cache) => cache.put(request, clone));
    }
    return response;
  });
}

// ─── Routing ────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip Netlify functions and analytics
  if (url.pathname.startsWith('/.netlify/') || url.hostname === 'www.googletagmanager.com') {
    return;
  }

  // 1. Vite-hashed assets: cache-first (immutable)
  if (url.pathname.startsWith('/assets/') && /\.[a-f0-9]{8,}\.(js|css)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // 2. HTML pages: network-first
  if (request.destination === 'document' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(request, PAGES_CACHE));
    return;
  }

  // 3. Partials: stale-while-revalidate
  if (url.pathname.startsWith('/partials/')) {
    event.respondWith(staleWhileRevalidate(request, PARTIALS_CACHE));
    return;
  }

  // 4. Non-hashed JS (sync-system, app JS): stale-while-revalidate
  if (
    url.origin === location.origin &&
    (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
  ) {
    event.respondWith(staleWhileRevalidate(request, SCRIPTS_CACHE));
    return;
  }

  // 5. Images on same origin: cache-first, 30 days
  if (url.origin === location.origin && /\.(png|jpg|jpeg|svg|gif|webp|ico)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, IMAGES_CACHE, 30));
    return;
  }

  // 6. External CDN (Firebase, Font Awesome, Chart.js, Google Fonts): cache-first, 7 days
  if (url.origin !== location.origin) {
    event.respondWith(cacheFirst(request, CDN_CACHE, 7));
    return;
  }
});
