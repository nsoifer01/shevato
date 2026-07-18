# Trip Planner

**A day-by-day itinerary builder: log flights, stays and activities, watch costs and night coverage add up, get warned about date collisions and uncovered nights, see the whole route on a map, and compare ways to get from A to B.**

## How it works

Everything lives in `localStorage` under the `trip-planner:*` keys and works without an account. Signing in on the site (Firebase Auth, shared header) additionally syncs `trip-planner:v1`, `trip-planner:theme` and `trip-planner:timefmt` across devices through the shared `sync-system/` (Firestore namespace `tripPlannerApp`); the geocode cache stays device-local on purpose. A trip is a named list of items (`flight | stay | transport | activity | note`), each with dates, optional times (including overnight arrivals like SHV to HND landing +1d), a status (`Booked / To book / Decide later / Cancelled`), and an optional cost. Every edit re-renders the summary chips, the night-coverage strip, the warnings panel and the totals instantly.

The only network calls are opt-in and key-free: place lookup via OpenStreetMap Nominatim (cached in `localStorage`, 1 request/second) and map tiles via Leaflet + OpenStreetMap, loaded on demand the first time the Map view opens. Offline, the timeline works fully; the map and route lookup degrade with clear messages.

## Features

| Feature | What it does |
| ------- | ------------ |
| Timeline | Chronological board of all items with per-night rates, status pills (quick-change), duplicate/delete with undo, and double-click editing |
| Multiple trips | Create, rename, duplicate and delete trips; per-trip currency (USD, EUR, GBP, ILS, JPY, THB, ...) |
| Validation | Blocks bad input (missing title, check-out before check-in, arrival before departure, negative cost); timezone-aware: a flight may land the same day at an "earlier" local time |
| Warnings | Date collisions (two stays covering the same night), uncovered nights up to the trip's end, past items still "To book"; click-through from the warnings panel to the row |
| Night coverage strip | One cell per night, colored booked / decide later / to book / in transit / no stay; hover for details, click to jump |
| Overnight legs | Flights and transport carry arrival date + time; overnight legs show a +1d badge and count as covered (booked) nights |
| Shift dates | Move one item, everything after it, or the whole trip by N days in one action |
| Route map | Numbered stops in visit order connected by a dashed route line (Leaflet + OSM, dark-mode tiles) |
| How to get there | Between consecutive stays in different places: distance (km/mi), compass heading, international-border flag, per-mode duration estimates, and pre-filled links to Google transit/driving, Google Flights and Rome2Rio |
| Import / export | JSON per trip, full backup of all trips, CSV export; import accepts trip files or full backups |
| Settings | 12/24-hour time format (saved and synced), dark/light theme |
| Cloud sync | Optional: sign in via the site header and trips/preferences sync across devices via Firestore (`sync-system/`), same as the other apps |

## File structure

```
apps/trip-planner/
├── index.html            # App shell (shared site header/footer + app markup)
├── css/styles.css        # All styles, scoped under body.trip-planner-app
├── js/trip-logic.js      # Pure logic: dates, validation, coverage, stats, route math
├── js/app.js             # UI: rendering, modals, storage, geocoding, map
└── tests/trip-logic.test.js
```

## Tests

```
npm run test:trip-planner
```

Pure-logic tests via `node --test` against `js/trip-logic.js` (dual-exposed as `window.TripLogic` and a CommonJS module). No installs, no config.
