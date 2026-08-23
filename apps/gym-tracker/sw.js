/**
 * Gym Tracker Service Worker.
 *
 * Strategy:
 *   - Precache the app shell + JS modules + CSS + the static exercise DB
 *     on install so the entire workout flow keeps working offline.
 *   - Stale-while-revalidate for everything else under our scope, so the
 *     user gets an instant load and the cache refreshes in the background.
 *   - Do NOT intercept Firebase / cross-origin auth + sync requests.
 *   - On every activate, drop old precaches UNDER OUR OWN NAME PREFIX.
 *     shevato.com is a single origin for every app on the site, so caches.keys()
 *     also lists the other apps' shells; only their own workers may delete those.
 *
 * CACHE_VERSION uses semver (MAJOR.MINOR.PATCH). Bump:
 *   - PATCH when the precache list contents change (file edits / additions).
 *   - MINOR when the precache list shape or runtime cache strategy changes.
 *   - MAJOR for a fundamental SW behavior change that breaks back-compat.
 * Old caches are pruned automatically on activate.
 */

const CACHE_VERSION = '1.15.0';
const PRECACHE = `gym-precache-${CACHE_VERSION}`;
const RUNTIME = `gym-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './offline/index.html',
  './css/gym-tracker.css',
  './css/refresh.css',
  './data/exercises-db.js',
  './data/exercises-db.json',
  './js/app.js',
  './js/models/Achievement.js',
  './js/models/Measurement.js',
  './js/models/Program.js',
  './js/models/Set.js',
  './js/models/Settings.js',
  './js/models/WorkoutDay.js',
  './js/models/WorkoutExercise.js',
  './js/models/WorkoutSession.js',
  './js/services/AchievementService.js',
  './js/services/AnalyticsService.js',
  './js/services/StorageService.js',
  './js/services/TimerService.js',
  './js/utils/analytics.js',
  './js/utils/dark-calendar.js',
  './js/utils/dark-select.js',
  './js/utils/event-bus.js',
  './js/utils/exercise-feel.js',
  './js/utils/helpers.js',
  './js/utils/id-utils.js',
  './js/utils/modal-focus.js',
  './js/utils/plate-calculator.js',
  './js/utils/pr-session.js',
  
  './js/utils/warmup.js',
  './js/utils/program-order.js',
  './js/utils/program-schedule.js',
  './js/utils/rest-cues.js',
  './js/utils/session-merge.js',
  './js/utils/paginator.js',
  './js/utils/sync-status.js',
  './js/utils/active-workout.js',
  './js/utils/data-migrations.js',
  './js/utils/exercise-search.js',
  './js/utils/exercise-taxonomy.js',
  './js/utils/import-merge.js',
  './js/utils/import-sanitize.js',
  './js/utils/session-metrics.js',
  './js/utils/units.js',
  './js/utils/week.js',
  './js/views/achievements-view.js',
  './js/views/calendar-view.js',
  './js/views/exercises-view.js',
  './js/views/history-view.js',
  './js/views/home-view.js',
  './js/views/insights-view.js',
  './js/views/measurements-view.js',
  './js/views/paused-banner.js',
  './js/views/programs-view.js',
  './js/views/settings-view.js',
  './js/views/workout-view.js',
];

// Every request the worker makes on its own behalf bypasses the HTTP cache.
// netlify.toml gives js/, css/ and data/ a max-age while HTML and sw.js are
// max-age=0, so with the default cache mode a deploy used to refresh the
// runtime cache with NEW index.html and OLD modules for up to five minutes
// (and a CACHE_VERSION bump inside that window precached the stale modules
// under the new name). `no-cache` revalidates with the origin every time,
// so what lands in OUR caches is always what the server has now.
const FRESH = { cache: 'no-cache' };
// `new Request(navigationRequest, init)` throws a TypeError (a request whose
// mode is 'navigate' cannot be constructed with a non-empty init), which used
// to reject the whole fetch handler for every navigation. Rebuild those from
// the URL instead; same-origin GET is all this worker ever handles.
function freshRequest(req) {
  try {
    return new Request(req, FRESH);
  } catch (_) {
    return new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // addAll fails atomically — if any URL is missing the install fails.
    // That's the right behavior here: we want the precache to be coherent.
    await cache.addAll(PRECACHE_URLS.map((u) => new Request(u, FRESH)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([PRECACHE, RUNTIME]);
    const names = await caches.keys();
    // Ours and stale. The prefix test is load-bearing: without it this deleted
    // every cache on the origin, so activating here wiped trip-planner's offline
    // shell (and its worker returned the favour).
    const stale = names.filter((n) => n.startsWith('gym-') && !keep.has(n));
    await Promise.all(stale.map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't intercept anything off-origin (Firebase, gstatic, fontawesome)
  // — those have their own caching/auth lifetimes and a stale-while-
  // revalidate would just race them.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate: serve cached if present, kick off a fresh
  // fetch in the background to update the cache. The runtime cache is
  // consulted first (it holds the freshest copy), then OUR OWN precache:
  // without that fallback, a precached URL the page had never fetched
  // online produced respondWith(undefined) offline, so the install-time
  // precache was dead weight and a cold offline start failed. Only the
  // gym precache is searched, never other apps' caches on this shared
  // origin.
  //
  // Navigations match with ignoreSearch so a launch URL carrying a query
  // string (`/?utm_source=x`) still finds the cached shell offline, and a
  // navigation that is in no cache at all (a generated /exercises/ page
  // never visited) gets the precached offline page instead of the browser's
  // error screen.
  const isNavigation = req.mode === 'navigate';
  const matchOpts = isNavigation ? { ignoreSearch: true } : undefined;
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    const precache = await caches.open(PRECACHE);
    const cached = (await cache.match(req, matchOpts))
      || (await precache.match(req, matchOpts));
    const networkPromise = fetch(freshRequest(req)).then((res) => {
      if (res && res.ok) return cache.put(req, res.clone()).catch(() => {}).then(() => res);
      return res;
    }).catch(async () => cached || (isNavigation ? precache.match('./offline/index.html') : undefined));
    // Keep the worker alive until the background refresh has landed. Without
    // this the refresh is cancelled whenever the worker goes idle after
    // respondWith settles, which is why a module could stay stale for loads
    // on end even with a fresh cache mode (2026-08-22 audit D5).
    try { event.waitUntil(networkPromise); } catch (_) { /* event already settled */ }
    return cached || networkPromise;
  })());
});
