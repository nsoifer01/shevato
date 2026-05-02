/**
 * Gym Tracker Service Worker.
 *
 * Strategy:
 *   - Precache the app shell + JS modules + CSS + the static exercise DB
 *     on install so the entire workout flow keeps working offline.
 *   - Stale-while-revalidate for everything else under our scope, so the
 *     user gets an instant load and the cache refreshes in the background.
 *   - Do NOT intercept Firebase / cross-origin auth + sync requests.
 *   - On every activate, drop old precaches.
 *
 * CACHE_VERSION uses semver (MAJOR.MINOR.PATCH). Bump:
 *   - PATCH when the precache list contents change (file edits / additions).
 *   - MINOR when the precache list shape or runtime cache strategy changes.
 *   - MAJOR for a fundamental SW behavior change that breaks back-compat.
 * Old caches are pruned automatically on activate.
 */

const CACHE_VERSION = '1.5.0';
const PRECACHE = `gym-precache-${CACHE_VERSION}`;
const RUNTIME = `gym-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/gym-tracker.css',
  './data/exercises-db.js',
  './data/exercises-db.json',
  './js/app.js',
  './js/models/Achievement.js',
  './js/models/Exercise.js',
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
  './js/utils/dark-calendar.js',
  './js/utils/dark-select.js',
  './js/utils/event-bus.js',
  './js/utils/helpers.js',
  './js/utils/modal-focus.js',
  './js/utils/plate-calculator.js',
  './js/utils/program-order.js',
  './js/utils/sync-status.js',
  './js/utils/validators.js',
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

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // addAll fails atomically — if any URL is missing the install fails.
    // That's the right behavior here: we want the precache to be coherent.
    await cache.addAll(PRECACHE_URLS);
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
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't intercept anything off-origin (Firebase, gstatic, fontawesome)
  // — those have their own caching/auth lifetimes and a stale-while-
  // revalidate would just race them.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate: serve cached if present, kick off a fresh
  // fetch in the background to update the cache.
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    const cached = await cache.match(req);
    const networkPromise = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || networkPromise;
  })());
});
