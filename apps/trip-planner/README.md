# Trip Planner

**A day-by-day itinerary builder: log flights, stays and activities, watch costs and night coverage add up, get warned about date collisions and uncovered nights, see the whole route on a map, and compare ways to get from A to B.**

## How it works

Everything lives in `localStorage` under the `trip-planner:*` keys and works without an account. Signing in on the site (Firebase Auth, shared header) additionally syncs `trip-planner:v1`, `trip-planner:theme` and `trip-planner:timefmt` across devices through the shared `sync-system/` (Firestore namespace `tripPlannerApp`); the geocode cache stays device-local on purpose. A trip is a named list of items (`flight | stay | transport | activity | note`), each with dates, optional times (including overnight arrivals like SHV to HND landing +1d), a status (`Booked / To book / Decide later / Cancelled`), and an optional cost. Every edit re-renders the summary chips, the night-coverage strip, the warnings panel and the totals instantly.

The only network calls are opt-in and key-free: place lookup via OpenStreetMap Nominatim (cached in `localStorage`, 1 request/second) and map tiles via Leaflet + OpenStreetMap, loaded on demand the first time the Map view opens. Offline, the timeline works fully; the map and route lookup degrade with clear messages.

## Features

| Feature | What it does |
| ------- | ------------ |
| Timeline | Chronological board of all items with per-night rates, status pills (quick-change), duplicate/delete, and double-click editing |
| Undo / redo | Every data change (add, edit, delete, duplicate, shift, status, import, trip ops) is undoable 50 steps deep: toolbar buttons or Ctrl+Z / Ctrl+Y; history resets when a remote sync merge lands |
| Multiple trips | Create, rename, duplicate and delete trips; per-trip currency (USD, EUR, GBP, ILS, JPY, THB, ...) switchable from the totals footer picker, with the symbol shown in the Cost column header and as a prefix inside the Cost input |
| Validation | Blocks bad input (missing title, check-out before check-in, arrival before departure, negative cost); timezone-aware: a flight may land the same day at an "earlier" local time |
| Warnings | Date collisions (two stays covering the same night), uncovered nights up to the trip's end, past items still "To book"; click-through from the warnings panel to the row |
| Night coverage strip | One cell per night, colored booked / decide later / to book / in transit / no stay; hover for details, click to jump |
| Overnight legs | Flights and transport carry arrival date + time; overnight legs show a +1d badge and count as covered (booked) nights |
| Shift dates | Move one item, everything after it, or the whole trip by N days in one action |
| Route map | Numbered stops in visit order connected by a dashed route line (Leaflet + OSM, dark-mode tiles) |
| How to get there | Between consecutive stays in different places: distance (km/mi), compass heading, international-border flag, per-mode duration estimates, and pre-filled links to Google transit/driving, Google Flights and Rome2Rio |
| Import / export | JSON per trip, full backup of all trips, CSV export (includes per-item currency + converted columns); import accepts trip files or full backups. Attached documents are never included in exports |
| Calendar export | Export trip (.ics) in the trip menu: stays as all-day ranges, flights/transport as floating local-time events (overnight arrivals land on the right day), cancelled items excluded; imports into Google/Apple Calendar |
| Installable PWA | manifest.webmanifest + sw.js (network-first: online loads always get the newest code; caches are an offline fallback only); timeline works offline after one visit, external APIs are never intercepted |
| Days view | Third view tab: one card per trip day with check-ins, check-outs, timed events, "Staying in X" and honest "No plans yet" days; today highlighted; print-friendly (printing in Days view outputs just the cards) |
| Budget | Optional per-trip budget in the trip dialog; summary chip shows confirmed-vs-budget and turns amber when exceeded |
| Multi-currency costs | Each item's cost can be entered in its own currency and converts into the trip's display currency using daily rates (api.frankfurter.dev, cached 24h); switching the display currency converts, never relabels; failed rate fetches show a note + Retry instead of fake 1:1 rates |
| Share link | Share itinerary produces a URL with the whole trip compressed into the fragment (no server, payload slimmed of empty fields); opens read-only with a banner and "Import as my trip". Links over ~8k chars copy with a truncation warning; a 30k hard cap points to JSON export |
| Continuity warnings | Consecutive stays in different (geocoded) cities with no flight/transport between them raise a warning naming both cities |
| Typical weather | Day cards show "Typically X-Y°C in {place} this time of year" from Open-Meteo history (cached per place+month); always "typically", never a forecast |
| Visa reminders | Visa rows marked e-Visa/visa required offer "Add reminder", creating an "Apply for {country} visa" to-book item dated 30 days before the trip |
| Documents pocket | Attach images/PDFs (booking confirmations, QR codes) to saved items; stored on-device in IndexedDB (2MB/file, 10/item), paperclip indicators, purged with the item, excluded from exports and sync |
| Trip-in-progress | During the trip the countdown chip becomes "Day X of Y", past rows dim, and the page opens scrolled to today; afterwards it reads "Trip completed" |
| Visa requirements | 🛂 Visas: pick your passport once (saved) and every country on the itinerary shows its requirement (visa-free with days, visa on arrival, e-Visa/eTA, visa required), derived live from the geocoded places via the community Passport Index dataset (cached monthly), with per-country Wikipedia verify links and an always-verify-officially caveat; countries can also be added manually (layovers, border crossings, road trips), stored per trip and removable |
| Settings | 12/24-hour time format (saved and synced), dark/light theme; a small "build N" tag at the bottom of the trip menu identifies the loaded code version (staleness diagnostics for the PWA cache) |
| Cloud sync | Optional: sign in via the site header and trips/preferences sync across devices via Firestore (`sync-system/`), same as the other apps |
| AI assistant | 🤖 Assistant proposes itinerary edits as accept/reject proposal cards (never auto-applied, never marked Booked, and every accept flows through undo). Three tiers you choose from a privacy-labelled picker: (1) copy/paste a ready-made package into any AI and paste its reply back, no key and nothing sent; (2) bring your own OpenAI or Gemini key, stored only in this browser, calling the provider directly; (3) the site's free shared assistant (Google Gemini, rate-limited per day). Chat history is kept per trip in `localStorage` (capped at 40 messages) and can be cleared; suggestions always include a Google Maps verify link |

## Site assistant setup (owner)

Tier 3 (the free shared assistant) is served by the Netlify function
`netlify/functions/tp-assist.mjs`, which proxies Google Gemini behind per-client
and global daily rate limits. Env vars are not injected into functions on this
site, so the shared key lives in a Blob, written once out-of-band:

```
# 1. Get a free Gemini API key at https://aistudio.google.com/apikey
# 2. Store it (the key never travels over HTTP; it is set via the CLI):
netlify blobs:set trip-planner-assist config '{"geminiKey":"<key>"}' --json
# Disable the shared assistant again:
netlify blobs:set trip-planner-assist config '{}' --json
```

With no key set the endpoint returns `503 not_configured` and the UI tells the
traveller to use Tier 1 or bring their own key. Tiers 1 and 2 need no setup.

## File structure

```
apps/trip-planner/
├── index.html            # App shell (shared site header/footer + app markup)
├── manifest.webmanifest  # PWA manifest (installable, standalone)
├── sw.js                 # Service worker: network-first, offline fallback caches
├── css/styles.css        # All styles, scoped under body.trip-planner-app
├── js/trip-logic.js      # Pure logic: dates, validation, coverage, stats, route,
│                         #   ICS builder, currency math, day cards, visa + doc guards,
│                         #   assistant reply parsing, action validation, prompt builders
├── js/app.js             # UI: rendering, modals, storage, geocoding, map, sync,
│                         #   share links, IndexedDB documents, weather, rates, assistant
└── tests/trip-logic.test.js

netlify/functions/            # Tier 3 site assistant (server-side, unversioned)
├── tp-assist.mjs             # Rate-limited Gemini proxy (origin guard, quota, no key leak)
├── lib/tp-assist-store.mjs   # Blob store handles (config + usage)
├── lib/tp-assist-quota.mjs   # Pure per-client / global daily quota math
└── tests/                    # node:test for the quota math + handler guards
```

## Tests

```
npm run test:trip-planner
```

Pure-logic tests via `node --test` against `js/trip-logic.js` (dual-exposed as `window.TripLogic` and a CommonJS module). No installs, no config.

The Tier 3 function's quota math and request guards have their own suite (run by the root `npm test`, or on their own with `npm run test:tp-assist-quota`).
