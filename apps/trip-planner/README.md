# Trip Planner

**A day-by-day itinerary builder: log flights, stays and activities, watch costs and night coverage add up, get warned about date collisions and uncovered nights, see the whole route on a map, and compare ways to get from A to B.**

## How it works

Everything lives in `localStorage` under the `trip-planner:*` keys and works without an account. Signing in on the site (Firebase Auth, shared header) additionally syncs `trip-planner:v1` and `trip-planner:timefmt` across devices through the shared `sync-system/` (Firestore namespace `tripPlannerApp`); the geocode cache stays device-local on purpose. A trip is a named list of items (`flight | stay | transport | local | activity | note`, where `local` is travel within a city), each with dates, optional times (including overnight arrivals like SHV to HND landing +1d), a status (`Booked / To book / Decide later / Cancelled`), and an optional cost (which may be negative to record a refund or credit). Every edit re-renders the summary chips, the night-coverage strip, the warnings panel and the totals instantly.

Most network calls are opt-in and key-free: place lookup via OpenStreetMap Nominatim (cached in `localStorage`, 1 request/second), typical weather from Open-Meteo, daily exchange rates from Frankfurter, the visa dataset from GitHub, and map tiles via OpenStreetMap. Leaflet itself is self-hosted under `vendor/leaflet/` (no CDN), loaded on demand the first time the Map view opens. The one keyed, billed call is Google venue ratings. On assistant suggestion cards they appear as a separate star-rating chip; on itinerary items with a Maps place (Timeline and Days views) the score and review count are merged into the item's own Google Maps link, so one element reads `Google Maps · ⭐ 4.7 (1,800)` and opens the resolved place. Every place a traveller can walk into qualifies, not just the ones the assistant tagged: an item with no `mapsQuery` of its own derives one from its title and location, for stays and activities only (a flight, a between-cities leg, a local hop and a note are not places, so they derive nothing). It stays dormant until the owner configures a Places key (see below); with no key the assistant chips stay empty and invisible while the itinerary link simply reads `Google Maps` with no rating, at zero cost. Offline, the timeline works fully; the map, route lookup, weather and ratings degrade with clear messages. Data sources are credited on the page, with a note that none of them are official sources for entry requirements.

## Features

| Feature | What it does |
| ------- | ------------ |
| Timeline | Chronological board of all items with per-night rates, status pills (quick-change), duplicate/delete, an edit action, and a collapsible stay/day/item hierarchy; filters and search apply here and in Days view. Items with a Maps place show a single Google Maps link that carries the star rating and review count inline (`Google Maps · ⭐ 4.7 (1,800)`, upgrading its href to the resolved place) once ratings are configured, and a plain `Google Maps` link otherwise; the same combined link appears in Days view |
| Undo / redo | Every data change (add, edit, delete, duplicate, shift, status, import, trip ops) is undoable 50 steps deep: toolbar buttons or Ctrl+Z / Ctrl+Y; history resets when a remote sync merge lands |
| Multiple trips | Create, rename, duplicate and delete trips; per-trip currency (USD, EUR, GBP, ILS, JPY, THB, ...) switchable from the totals footer picker, with the symbol shown in the Cost column header and as a prefix inside the Cost input |
| Validation | Blocks bad input (missing title, check-out before check-in, arrival before departure, calendar-impossible or out-of-range dates); negative costs are accepted deliberately as refunds; timezone-aware: a flight may land the same day at an "earlier" local time. A single far-future date can no longer hang the app: day walks stop at a cap and the offending item is named as an error |
| Warnings | Date collisions (two stays covering the same night), uncovered nights up to the trip's end, past items still "To book"; click-through from the warnings panel to the row |
| Night coverage strip | One cell per night, colored booked / decide later / to book / in transit / no stay; hover for details, click to jump |
| Overnight legs | Flights and transport carry arrival date + time; overnight legs show a +1d badge and count as covered (booked) nights |
| Shift dates | Move one item, everything after it, or the whole trip by N days in one action |
| Route map | Numbered stops in visit order connected by a dashed route line (Leaflet + OSM, dark-mode tiles) |
| How to get there | Between consecutive stays in different places: distance (km/mi), compass heading, international-border flag, per-mode duration estimates, and pre-filled links to Google transit/driving, Google Flights and Rome2Rio |
| Import / export | JSON per trip, full backup of all trips, CSV export (includes per-item currency + converted columns); import accepts trip files or full backups. Attached documents are never included in exports |
| Calendar export | Export trip (.ics) in the trip menu: stays as all-day ranges, flights/transport as floating local-time events (overnight arrivals land on the right day), cancelled items excluded; imports into Google/Apple Calendar |
| Installable PWA | manifest.webmanifest + sw.js (network-first: online loads always get the newest code; caches are an offline fallback only); timeline works offline after one visit, external APIs are never intercepted |
| Days view | Third view tab: one card per trip day with check-ins, check-outs, timed events, a "Nothing planned, staying at {hotel}" line on days covered only by a stay, and honest "No plans yet" days with no bed; today highlighted; print-friendly (printing in Days view outputs just the cards). Every row is the same shape - type tile, title and location, then price + Google Maps, then edit and delete - and the row asks its own CARD width (a container query, not the viewport) whether the price and Maps sit beside the title or wrap to their own line, so every card on a page wraps the same way. Cancelled rows carry a `Cancelled` badge and dim the two controls that are no longer actionable, keeping edit and delete at full strength |
| Budget | Optional per-trip budget in the trip dialog; summary chip shows confirmed-vs-budget and turns amber when exceeded. It never reads green over a total that silently excluded unconvertible money, and it reports a net refund honestly rather than painting green over a negative |
| Example trips | An empty plan offers a dozen ready-made trips (7 to 14 days, varying densities), listed A to Z; a trip name that matches a destination preselects it; the loader routes to the base app URL, not a stale hash |
| Deep-linkable views | `#timeline`, `#days` and `#map` boot straight into that view and survive a refresh; a share fragment is never overwritten |
| Route options | Opening a leg shows distance, per-mode duration, cost and CO2 estimates, badges, curated corridor facts and operator links, with a match-confidence note under each end and an explicit estimates-not-quotes caveat |
| Multi-currency costs | Each item's cost can be entered in its own currency and converts into the trip's display currency using daily rates (api.frankfurter.dev, cached 24h); switching the display currency converts, never relabels; failed rate fetches show a note + Retry instead of fake 1:1 rates |
| Share link | Share itinerary produces a URL with the whole trip compressed into the fragment (no server, payload slimmed of empty fields); opens read-only with a banner and "Import as my trip". Links over ~8k chars copy with a truncation warning; a 30k hard cap points to JSON export |
| Continuity warnings | Consecutive stays in different (geocoded) cities with no flight/transport between them raise a warning naming both cities |
| Typical weather | Day cards show a typical temperature range for {place} that month, averaged over the last 5 years of Open-Meteo history (cached per place+month), with a visible caveat that it is historical climate, not a forecast |
| Visa reminders | Visa rows marked e-Visa/visa required offer "Add reminder", creating an "Apply for {country} visa" to-book item dated 30 days before the trip |
| Documents pocket | Attach images/PDFs (booking confirmations, QR codes) to saved items; stored on-device in IndexedDB (2MB/file, 10/item), paperclip indicators, purged with the item, excluded from exports and sync |
| Trip-in-progress | During the trip the countdown chip becomes "Day X of Y", past rows dim, and the page opens scrolled to today; afterwards it reads "Trip completed" |
| Visa requirements | 🛂 Visas: your passport is auto-guessed from the departure flight (and overridable, saved), and every country on the itinerary shows its requirement (visa-free with days, visa on arrival, e-Visa/eTA, visa required), derived from the maintained Passport Index dataset whose publication date is shown on the dialog (not implied to be live). A country is only named when its place geocodes confidently; an ambiguous match is said out loud as "country not confirmed" rather than guessed, so the dialog never states a requirement for the wrong country. Per-country Wikipedia verify links and an always-verify-officially caveat; countries can also be added manually (layovers, border crossings, road trips), stored per trip and removable |
| Settings | 12/24-hour time format (saved and synced); a small "build N" tag at the bottom of the trip menu identifies the loaded code version (staleness diagnostics for the PWA cache) |
| Cloud sync | Optional: sign in via the site header and trips/preferences sync across devices via Firestore (`sync-system/`), same as the other apps |
| AI assistant | 🤖 A picker builds the request (slot types and counts, style, wake/return times, repeats, budget, free text) instead of the traveller typing prose, and the same request feeds all three tiers. Replies come back as separate timed items rather than one blob, with alternatives per slot the traveller picks between before anything is added. Edits arrive as accept/reject proposal cards (never auto-applied, never marked Booked or Cancelled, an update never un-books a real reservation, and every accept flows through undo). Three tiers chosen from a privacy-labelled picker: (1) copy/paste a ready-made package into any AI and paste its reply back, no key and nothing sent; (2) bring your own OpenAI or Gemini key, stored only in this browser, calling the provider directly; (3) the site's free shared assistant (Google Gemini, rate-limited per day). The assistant refuses to state visa, passport, vaccination or customs rules and points at the destination government instead. Replies render Markdown; chat history is kept per trip in `localStorage` (capped at 40 messages) and can be cleared; suggestions always include a Google Maps verify link and, when an owner Places key is configured, a Google star rating |

## Site assistant setup (owner)

Tier 3 (the free shared assistant) is served by the Netlify function
`netlify/functions/tp-assist.mjs`, which proxies Google Gemini behind per-client
and global daily rate limits. Env vars are not injected into functions on this
site, so the shared key lives in a Blob, written once out-of-band:

```
# 1. Get a free Gemini API key at https://aistudio.google.com/apikey
# 2. Point the CLI at the project that serves shevato.com (blob stores are
#    per-project, so writing this while linked elsewhere silently does nothing):
netlify status
# 3. Store it (the key never travels over HTTP; it is set via the CLI):
netlify blobs:set trip-planner-assist config '{"geminiKey":"<key>"}'
# Disable the shared assistant again:
netlify blobs:set trip-planner-assist config '{}'
```

With no key set the endpoint returns `503 not_configured` and the UI tells the
traveller to use Tier 1 or bring their own key. Tiers 1 and 2 need no setup.

Two failure modes look alike from the browser but are not: `503 not_configured`
means the key is missing from *this* project's store, while `502 upstream` means
the key was found and Gemini itself rejected the call (most often a retired
`GEMINI_MODEL` pin, see the note in `tp-assist.mjs`). A `429` means a quota was
hit, either this function's own daily limits or Google's. The function logs the
upstream status and body; the key is never logged.

**Google's free tier is the real ceiling, not our limiter.** Measured
2026-07-19 on a free key: `gemini-3.5-flash` allows 5 requests/minute and
250K tokens/minute, and the API refuses further calls once a
`generate_content_free_tier_requests` allowance of about 20 (apparently daily)
is spent. This function's own caps (10/client/hour, 30/client/day, 400/day
global, in `lib/tp-assist-quota.mjs`) are far above that, so on the free tier
travellers hit Google's wall first and see "at capacity". Check the real numbers
at https://aistudio.google.com/rate-limit; enabling billing on the Google Cloud
project raises the limits and costs fractions of a cent per turn.

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

netlify/functions/            # Server-side (unversioned): Tier 3 assistant + venue ratings
├── tp-assist.mjs             # Rate-limited Gemini proxy (origin guard, quota, no key leak,
│                             #   oversized-trip trimming, shared prompt imported from trip-logic)
├── lib/tp-assist-store.mjs   # Blob store handles (config + usage)
├── lib/tp-assist-quota.mjs   # Pure per-client / global daily quota math
├── tp-places.mjs             # Google Places ratings proxy (two-call strategy, owner-token tier)
├── lib/tp-places-lookup.mjs  # Resolve query -> place ID -> rating; place-ID cache 30d, ratings never cached
├── lib/tp-places-match.mjs   # No-match classification before anything is billed
├── lib/tp-places-quota.mjs   # Compare-and-swap quota (public + separate owner buckets)
├── lib/tp-places-store.mjs   # Blob store handles (config + usage)
├── lib/tp-places-usage.mjs   # CAS usage accounting
└── tests/                    # node:test for the quota math, matching, and handler guards
```

The Places ratings proxy is dormant until an owner writes a `placesKey` (and,
optionally, an `ownerToken` for a higher personal rate tier) into the
`trip-planner-places` Blob, the same out-of-band way the assistant key is set
above. Place IDs are cached 30 days; names and ratings are never cached, because
no Google caching exception covers those fields.

## Tests

```
npm run test:trip-planner
```

Pure-logic tests via `node --test` against `js/trip-logic.js` (dual-exposed as `window.TripLogic` and a CommonJS module). No installs, no config.

The Tier 3 function's quota math and request guards have their own suite (run by the root `npm test`, or on their own with `npm run test:tp-assist-quota`).
