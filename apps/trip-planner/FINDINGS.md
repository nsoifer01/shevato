# Trip Planner - engineering findings

Living document. State the best current understanding; rewrite rather than
append. Read together with `README.md` (what the app is) - this file is the
why, the traps, and the invariants.

## Architecture facts that bite

- **Two files, one contract.** `js/trip-logic.js` is pure and DOM-free
  (`window.TripLogic` + CommonJS for `node --test`); `js/app.js` owns DOM,
  storage, network. Anything computable belongs in trip-logic so it can be
  pinned by tests. app.js destructures ~120 names from TripLogic at the top;
  a new export must be added there to be usable.
- **`save()` is the single write choke point.** It writes localStorage FIRST,
  then books undo history, keyed on `JSON.stringify(db.trips)` (not the whole
  db) so trip switches are navigation, not undo steps. `outsideHistory` saves
  (repairs, `ensureTrip`, packing seed) move the baseline without an undo
  step. Every new mutation path must go through `save()` or it is invisible
  to undo, sync and the quota banner.
- **Versioned asset pins are load-bearing.** `TP_BUILD` in app.js must equal
  the `?v=` on `js/app.js` in BOTH `index.html` and `sw.js` PRECACHE, and any
  change to sw.js's precache list needs a `CACHE_VERSION` bump or old entries
  are never evicted. `styles.css?v=` and `trip-logic.js?v=` follow the same
  rule (index.html + sw.js in step).
- **The trip db schema has no version migrations** - `repairDb()` normalizes
  on load instead (types, statuses, money via `parseMoney`, `order` bounds,
  currency stamps). New fields must be tolerated absent forever; never write
  a migration that rewrites items destructively.
- **Share links are code**: the whole trip rides deflate+base64url in the URL
  fragment. `slimTripForShare` is an explicit field allowlist; essentials,
  packing, documents and passport data stay out BY that allowlist, so adding
  a trip-level field means deciding its share/export story at the same time
  (see the table in README's import/export rows).
- **Provider split is deliberate**: Nominatim = one-shot geocode only (policy
  forbids autocomplete; 1 req/1.1s serialized queue in `pumpGeo`, now with
  in-flight dedup), Open-Meteo geocoding = city typeahead, Photon = hotel,
  venue and activity typeahead plus venue coordinates, bundled OurAirports
  table = airports (offline). Never move a lookup between providers without
  re-reading their usage policies. The quotes that decide it, so a future
  session does not re-derive them (all re-verified 2026-08-18):
  - **Photon** (github.com/komoot/photon, and photon.komoot.io itself): "You
    are welcome to use the API for your project as long as the number of
    requests stay in a reasonable limit. Extensive usage will be throttled or
    completely banned. We do not give guarantees for availability and reserve
    the right to implement changes without notice." Plus: "If you have a larger
    number of requests to make, please consider setting up your own private
    instance." No key, no stated commercial restriction, `Access-Control-Allow-Origin: *`
    observed on the live service, and `Cache-Control: max-age=3600` on its own
    answers. There is NO published request-per-second number, which is exactly
    why every Photon caller in this app is bounded by construction rather than
    by a limit to aim at: 3-character minimum, 320ms debounce, abort-in-flight,
    a per-query+city memo cache, and the distance top-up's separate ceilings
    (2 concurrent, 6 per repaint, 40 per session).
  - **Nominatim** (operations.osmfoundation.org/policies/nominatim/): auto-complete
    search "is not yet supported by Nominatim and you must not implement such a
    service on the client side using the API", it is listed under "The following
    uses are strictly forbidden and will get you banned", and the absolute
    maximum is "1 request per second". That is the whole reason two other
    providers exist here.
  - **Overpass** (dev.overpass-api.de/overpass-doc/en/preface/commons.html):
    lists "Setting up an app for more than just OSM mappers and relying on the
    public instances as backend" among the things not to do. So the one thing
    Photon cannot answer - "find me a museum NEAR here", a category search
    rather than a name search - stays unanswered rather than answered against a
    service that has asked us not to. Rejected on policy, not on capability.
  - The OSM data itself is ODbL and is credited on the page (the attribution
    block names OpenStreetMap, the licence, Nominatim and Photon); the Photon
    software is Apache-2.0, which is irrelevant to using the hosted instance.
- **Every provider origin has to be in the site CSP** (`connect-src` in
  `netlify.toml`, the only place a CSP is defined - no `_headers` file, no
  `<meta http-equiv>`, no generated copy). The policy ships as
  `Content-Security-Policy-Report-Only`, so a missing origin does not break
  the app: it logs a console violation and works anyway. That silence is why
  three of this app's own origins - `photon.komoot.io` (hotel picker),
  `api.open-meteo.com` (near-term forecast) and
  `geocoding-api.open-meteo.com` (city typeahead) - were still missing on
  2026-08-18, the second time this list drifted after the 2026-07-20 audit.
  `tests/static/csp-connect-src.test.mjs` now parses that header and fails
  when a browser fetch origin is not covered, in both directions (header
  trimmed, or a new fetch origin added without the header). The three
  Open-Meteo products are three separate HOSTS behind one brand and are listed
  one by one; `*.open-meteo.com` is explicitly rejected by the test.
- **A repeated CSP console warning is not a repeated request.** Chromium fires
  `securitypolicyviolation` (and logs the console line) TWICE per blocked
  request under a report-only policy - measured at exactly 2:1 on 2026-08-18,
  1 request -> 2 reports, 4 requests -> 8 reports. On top of that, the place
  combobox legitimately queries once per keystroke that survives its 220ms
  debounce, so typing "Kyoto" is four DIFFERENT queries (`Ky`, `Kyo`, `Kyot`,
  `Kyoto`), each aborting the one before. Before "fixing" a duplicate-looking
  warning, count `Network.requestWillBeSent` URLs: the app already caches per
  query key and aborts in flight, and there is nothing to dedupe.
- **Google Places legal lines** (re-verified against the live terms
  2026-08-17): place IDs cacheable indefinitely, lat/lon cacheable 30d
  (`trip-planner:venuegeo:v1`, cap 300), names/ratings/opening hours NEVER
  stored (no hours field has a caching exception; they follow the exact
  session-only rule ratings do - see "Opening hours" below). The
  server's rating layer was found still persisting `pd:` details blobs (unread,
  unbounded); the CODE was removed 2026-08-13 but 201 stale `pd:` blobs were
  still sitting in the production store on 2026-08-17 and had to be purged
  separately. Removing a cache is two jobs: the writer and the data.
  The sources, quoted, so a future session does not have to re-derive them:
  - Maps Platform ToS 3.2.3(b): "Customer will not cache Google Maps Content
    except as expressly permitted under the Maps Service Specific Terms."
  - Service Specific Terms 14.3 (Places API, Legacy and New): "Customer may
    temporarily cache latitude and longitude values from the Places API for up
    to 30 consecutive calendar days, after which Customer must delete the
    cached latitude and longitude values." That is the ONLY Places field with
    an express caching permission.
  - General Service Terms A.3 (Google ID Caching): place_id may be cached; the
    Places policies page says so too ("You can therefore store place ID values
    indefinitely").
  So `RATING_TTL_MS` is 0 and stays 0. Holding a response in memory to paint
  the elements that asked for it is not caching (the DOM holds the same rating);
  writing it anywhere that outlives the page is.

## Sync model (and its sharp edges)

- One synced key for the whole planner (`trip-planner:v1`) plus
  `trip-planner:timefmt`, per-key last-writer-wins via `sync-system/`. There
  is NO structural merge: two devices editing different trips concurrently
  lose one device's whole edit set. Softening on the receive side: db reload,
  undo-history reset, dialogs stay open but their SAVE paths re-check the
  target still exists (`ui.editingId` for items, `ui.tripEditId` for the trip
  dialog - both added guards, keep them when adding dialogs).
- Same-device multi-tab (esp. signed out) is covered by a native `storage`
  listener (added 2026-08-13) that mirrors remote-merge handling. The
  `localStorageSync` event only fires signed-in after a Firestore flush.
- A remote merge can orphan per-trip side stores. Chat threads are pruned by
  `pruneOrphanChats()` on remote merges; the collapse store prunes via
  `dropCollapse` on local delete and skips persistence entirely in shared
  mode (a shared trip's id is fresh per visit).
- Known remaining edge (documented, not fixed): a repair write during remote
  apply is swallowed by the sync echo lock, and the next reconcile can fire a
  spurious `remote` event that clears undo history. Rare, self-heals.

## Money invariants

- `cost` is typed by the traveller; `estCost` is a model/import guess and is
  displayed with a tilde, never summed. Transcribed document prices count as
  real cost (provenance: `action.source === 'document'`).
- Negative cost = refund, deliberately legal everywhere; display always says
  "Refund" with magnitude (`refundParts`), storage keeps the sign.
- `roundMoney` is symmetric half-away-from-zero; every entry point rounds to
  cents so displayed rows always sum to displayed totals.
- Unconvertible amounts are NEVER silently dropped from a claim: every block
  (Confirmed, per-traveler, cost-by-type, budget verdict) carries an
  `unconverted` side channel and flags amber.
- Roster edits clean money fields ON the items: `paidBy` respelled/dropped,
  `travelers` assignments respelled/dropped, invalid `splitAmounts` dropped
  (back to even divide), all counted in the Trip-settings warning BEFORE
  save. Read paths (`assignedTravelers`, `customSplitShares`) still tolerate
  stale names because imports/share links can carry them.

## Booking parser (trip-logic 5231-6300)

- Built originally against US-format documents; the 2026-08-13 round added
  European formats: comma-decimal money ("EUR 148,00", "1.234,56 EUR"),
  dot-date/time disambiguation (a dotted date or a price is never a clock
  time), and a `+1` overnight marker that no longer matches phone numbers.
- PNR detection requires the letter inside the TOKEN, iterates tokens past
  stopwords, and bare "Reservation"/"Confirmation" need a qualifier or colon.
- Uppercase day/month abbreviations (SAT, SUN, AUG...) are real IATA codes;
  they are stopworded in EVERY bare-code pass, explicit "A to SAT" separators
  included (a shouty ticket writes "DEPARTS SAT 21:30" as readily as a real
  route names San Antonio). Only the parenthesised "(SAT)" form is exempt,
  which is how a genuine San Antonio flight still gets its route.
- ICS import skips nested VALARM components, counts truncated files as
  unreadable (not empty), tolerates unquoted TZID-with-colon, and derives
  DTEND from DURATION.
- Date-order inference: document evidence > plausibility tiebreak > default
  month-first; the chosen order and its source are always printed in the
  dialog. Keep `dateOrderNotes` in step with any inference change.

## Server functions

- Quota counter maps are null-prototype objects (`bareMap`): clientId is
  attacker-minted and `"__proto__"` on a plain object bypassed every
  per-client cap (read coerces NaN, increment no-ops). Regression tests pin
  this in both quota suites.
- **Netlify's synchronous function limit is 60s, not 10s.** The 10s belief
  (which sized every upstream deadline at 9s) is stale: current Netlify docs
  (build/functions/configuration, "Synchronous execution limit", verified
  2026-08-16) say 60s, streamed responses also 60s. The 9s deadline stays the
  `upstreamSignal()` DEFAULT because tp-places' lookups run well under a
  second; tp-assist passes its own 45s budget (`ASSIST_UPSTREAM_TIMEOUT_MS`).
- **The Free assistant "plan my day" 502 (fixed 2026-08-16, PR #403, merged
  b9631ec) was that 9s deadline, not Gemini.** Verified on production
  2026-08-17 after the deploy: API-level plan turns completed in 8.6-24.5s
  with full tripActions blocks (17-22 parsed actions), and the real UI flow
  (Free assistant -> Send to the assistant) rendered proposal cards with no
  error. A plan-mode turn produces ~3,000-4,000 output
  tokens and measured 8.3-14.1s against live `gemini-3.1-flash-lite` (5
  runs), so the abort fired on most plan turns while short chat turns
  (2-5s) kept working, which is why the endpoint looked "sometimes fine".
  Triage note: the timeout path used to log NOTHING (only HTTP-error
  responses were logged), which made the 502 undiagnosable from function
  logs; the handler's catch now logs the error name/message. When timing an
  assistant change, measure a PLAN turn, not a chat turn.
- tp-places: reservation-before-spend via etag CAS; resolve step is wrapped
  so a Blobs I/O failure returns the JSON contract (batch `unavailable`) and
  keeps the reservation (never under-count spend). Known accepted edges: two
  sequential 9s upstream deadlines sit inside the (60s) platform limit but a
  slow pair still burns the reservation until rollover; a failed Place
  Details call counts as spent;
  per-client caps are advisory (clientId rotation) - the global/monthly pools
  are the real cost control.
- **A 429 from tp-places is ALWAYS ours, never Google's.** An upstream
  rejection is caught in `resolveOne` and returned as HTTP **200** carrying
  `{ status: 'unavailable', reason: 'upstream' }`, so a Google throttle cannot
  reach the browser wearing a 429. When a 429 shows up in the console, read its
  `scope`: it names one of our own buckets and nothing else can produce it.
- **The public $10/month and owner $40/month ceilings are NOT additive with two
  free allowances.** Google's 1,000 complimentary Place Details Enterprise
  calls are per SKU per PROJECT, and both pools (globalMonth 1500 + ownerMonth
  3000) draw on that one allowance. Draining both is 4,500 lookups = 1,000 free
  + 3,500 paid = **$70/month**, not $50. The $10 figure remains correct for
  what the PUBLIC tier alone can cost, which is what it was always about.
- tp-assist deliberately does NOT refund quota on upstream failure (fails
  closed); Google's own free-tier limits bind before ours anyway. Pinned by
  tests/tp-assist-handler.test.mjs.
- The origin check is defense-in-depth only (no CORS enforcement, header is
  forgeable); quotas are the actual control.
- The whole tp-assist handler (config blob -> quota CAS -> Gemini -> reply
  guards) IS locally testable despite `@netlify/blobs` not being installed:
  the store import is lazy (inside the handler), so a `node:module`
  register() hook in the test process redirects that one specifier to an
  in-memory CAS stub (tests/tp-assist-blobs-stub.mjs + -hooks.mjs) and global
  fetch stands in for Gemini. The older belief that steps past the body clamp
  "need a live Netlify Blobs context" is obsolete.

## PWA / offline

- Network-first; offline fallback checks RUNTIME cache before precache (the
  precache is older by construction after any deploy that didn't byte-change
  sw.js). Precache now includes the sync shell (sync-system/*, firebase
  config, sync-status.js, back-to-top) because the FIRST visit runs
  uncontrolled and can't runtime-cache them.
- pdf.js (1.7MB) is runtime-cached on first use, deliberately not precached.
- The update toast needs the worker to activate over a PREVIOUS install;
  stale own-prefix caches are the proof. One offer per tab, suppressed in the
  first 10s after load.

## Headless-probe traps specific to this app

- App state is closure-scoped: seed `trip-planner:v1` in localStorage and
  reload; you cannot poke internal state from outside.
- The trip menu's shared-mode disabling is applied when the menu OPENS
  (`syncTripMenuShared`), so probing button state without opening reads 0
  disabled; the click handler's `SHARED_MENU_ACTS` allowlist is the backstop.
- `getComputedStyle` lies after class swaps; trust pixels (screenshots) and
  DOM facts. Serve on 8082+ (8080 owner, 8081 schwabbot).

## Assistant: send modes (UI)

- The Step 2 "Send it" segmented control lists Free assistant, Copy & paste,
  My API key, in that order (Free assistant first since 2026-08-16). The
  order is presentation only: every handler, CSS rule and test keys off the
  radio VALUE (`site`/`copy`/`byok`), and the default tier is an explicit
  `'copy'` where `assistTier` is initialised, never derived from position.
- "Tier 1/2/3" is internal shorthand and must never reach the traveller:
  user-facing fallback copy names the segmented labels themselves ("use
  Copy & paste"), pinned by the e2e assistant suite (block 6b).
- restoreChat() re-collapses the setup block whenever a thread has history,
  so any probe clicking the tier radios mid-conversation must reopen setup
  via `#assistSetupChange` first or the click lands on a zero-rect input and
  silently no-ops.

## One day, one route chain (2026-08-17 pass)

Shipped as PR #407 (merge 173e284), verified on production 2026-08-17 with
live probes: per-stop Directions endpoints and modes, the return-to-hotel
chip ("~10 min by taxi · ~3.5 mi from Dinner: Kyubey", stay-name rung
confirmed live), all three pick-one badges from real Places ratings, Change
choice replacing by id, the unit preference persisting, the Day route modal
rendering real OSM tiles over its pins, and Google Maps resolving the full
waypoint day-route URL with every stop in order in driving mode.

The invariant this round exists for: `previous stop -> current stop` has ONE
implementation. `dayCardChain` (app.js) reads a day card's anchor + rows and
runs `dayDistanceChain`; every Days-view route surface consumes THAT chain -
the per-row chips, each place row's Directions link, the day totals strip
(`dayTravelTotals`), the Day route modal and the external Google Maps route
(`directionsRouteUrl` + `routeUrlChunks`). The assistant side consumes the
same builder through `paintAssistDistances`/`suggestionOrigins`. Do not add a
new surface that re-derives a leg; read the chain.

- **Day origin** = `dayAnchor` (arrival leg that day, else host stay, else
  morning city), resolved by `readPoint(cardEl, 'anchor')` against the
  caches. The first row's leg starts there, arrival airport included, and the
  first stop's Directions link inherits it via `leg.fromQuery`.
- **Per-row Directions**: place rows render destination-only (`dc-dir`,
  `data-dir-type="place"`); `writeDistChip` upgrades origin + travelmode from
  the row's own chain leg. `place` maps to `legTravelMode('local', km)`
  (walk/transit by the hop judgement); item-type modes are for LEGS only, so
  a place must never inherit a flight's `driving`.
- **Return-to-hotel** is not special-cased: it is the last chain leg (its
  destination rides on the action's mapsQuery). Its earlier failure mode was
  RESOLUTION, not chaining: a leg proposal's destination only had the venue
  and city rungs, while a picker-chosen hotel's coordinates live in the
  geocode cache under its NAME. `legDestStayName` now stamps the stay's title
  as the name rung when a leg's destination matches a stay - the same offer
  `itemDistAttrs` makes for the stay's own row.
- **Totals** (`dayTravelTotals`) sum the chain legs by the same `hopTravel`
  walk/ride split the chips print. "Partial" means a stop resolved NOWHERE:
  a city-centroid fallback counts as located (the chips already print such
  legs), so a genuinely unplaced stop needs BOTH rungs empty - probes must
  clear `location` too, not just the venue entry.
- **External day route**: Google's URL API takes one travelmode for the whole
  waypoint route and transit supports no waypoints at all, so `dayRouteMode`
  is walking only when EVERY leg is walkable, else driving, and the link's
  tooltip says so. `routeUrlChunks` splits past 9 waypoints into consecutive
  parts (each starting where the previous ended); stops are never dropped.
- **Distance unit** is `trip-planner:distunit` ('mi' default | 'km'), the
  exact TIMEFMT architecture: device key, synced (app-sync-init.js allowlist,
  privacy.html names it), reconciled in the same storage/tp-sync:applied
  listeners, applied via `TripLogic.setDistanceUnit` so `fmtDist` - the ONLY
  distance formatter - flips every surface at once. The `fmtKmMi` dual
  "km / mi" form is deleted; never reintroduce a second formatter.
- **Pick-one badges** (`candidateBadges`, same discipline as routeBadges):
  '⚡ Shortest route' = smallest chip leg km (labelled shortest, not fastest:
  it is a distance comparison and no duration is computed; the internal id
  stays `fastest`), rated = highest rating, popular = highest
  review count; one winner each, ties keep rendered order, fewer than two
  resolved entrants = no badge (a single resolved candidate is missing data
  wearing a badge, not a comparison). Since the 2026-08-21 hours round a
  verified-closed candidate is not an entrant at all (the `closed` input;
  see "Opening hours" above) - exclusion can therefore also drop a badge to
  fewer than two entrants and omit it. Painted idempotently from chip
  `dataset.km` + placesCache by BOTH the distance pass and paintPlaces, so
  whichever data lands last completes them.
- **Change choice** maps set -> added item through `assistChoice` (WeakMap:
  card -> { addedId, fingerprint, title, restore }). Replacement is by
  recorded id in the SAME save as the new add (one undo step). Fingerprint
  mismatch (traveller edited the item) KEEPS the item and adds alongside
  with a toast; a deleted item is simply gone. After reopening, the skip
  button becomes Cancel (back to the stub, or removes the card if the item
  no longer exists - a stub may not claim "Added" over a deleted item).

Probe traps this round minted:
- `/~([\d.]+) mi/` matches "~9 **mi**n walk" - a chip regex needs `mi\b`.
- The rates/weather failures re-render the day list a beat after a view
  switch. Wait for the COMPLETE end state (last leg's Directions upgraded AND
  the strip present), then take every fact in ONE atomic evaluate; reads
  spread over several evaluates straddle rebuilds and produce impossible-
  looking mixed states.
- A stay STARTING mid-trip inserts a check-in row at the assumed 15:00, which
  is a chain stop: an evening suggestion then measures from the hotel, not
  from lunch. Correct behaviour; fixtures that want a pure
  anchor->stops chain start the stay the night before.

## Places billing: the free allowance is the real ceiling (2026-08-18)

**Google's billing, not our counters, is the source of truth, and they did not
agree.** Verified in Cloud Billing for project `shevato-site`, SKU
`Places API Place Details Enterprise` (`2D9A-3DE0-3766`):

| | |
|---|---|
| August 2026 usage | **2,915 calls**, $38.30 gross, -$38.30 promotional credit, **$0.00 net** |
| July 2026 | $9.24 gross, -$9.24 credit, $0.00 net |
| `GCP Free Credit` | $300 original, **$251.24 remaining**, one-time, **expires 2026-10-18** |
| `Text Search Essentials (IDs Only)` | 705 calls, **$0.00** (unlimited free; not the expensive one) |

These are HISTORICAL OBSERVATIONS, not constants to build on. **The net $0 is a
temporary promotional credit, not a free tier.** After 2026-10-18 the same
2,915 calls would be a $38.30 invoice. Everything below is designed as if the
credit does not exist.

**Pricing, re-verified:** 1,000 Place Details Enterprise calls free per calendar
month, per SKU, **per project**; $20/1,000 (i.e. $0.02) past that.

### Why 2,915 when our counter said 1,521

Traced, not assumed. Cloud Monitoring
(`serviceruntime.googleapis.com/api/request_count`, service
`places.googleapis.com`) gives the authoritative shape:

- **August 1-18: 2,987 `GetPlace` + `SearchText` split as 2,987 / 1,059**, and
  5,556 Places requests overall since July. 11 of those were answered **429 by
  Google itself** - a reminder that an upstream 429 exists and is invisible to
  the browser, because `resolveOne` turns it into a 200 `unavailable`.
- **Aug 17 alone was 1,651 `GetPlace` and 651 `SearchText`**, over half the
  month. The 07:00-08:00Z hour was 753 details + **555 searches**, and a search
  only fires on a cold place-ID cache, so that hour was ~555 venues nobody had
  ever looked up. That is the day the 30-day `usa` sample template shipped -
  **141 rating-eligible items in one trip, 422 distinct venues across all 13
  templates** - and under the old architecture every page load re-billed every
  venue in view.

Confirmed channels that spend real money and are INVISIBLE to the production
counter:

1. **Local `netlify dev`.** `.env` carries a real `TP_PLACES_KEY`, localhost
   passes the origin guard, and functions run against `.netlify/blobs-serve` -
   a LOCAL store with its own counters. Its August total was **129 owner
   lookups** that production had never seen, and the directory is wiped with
   the checkout, so its historical total is unknowable. Now gated behind
   `TP_PLACES_ALLOW_LOCAL_SPEND=1`: a key alone can no longer bill the card
   from a laptop.
2. **Anything sharing the key outside this deployment.** Only one Places key
   exists (`tp-places-ratings`), and only one Netlify site is on this account,
   but a second Netlify project (`shevato-site`, on the other account) builds
   the same repo and would have its own blob store.

**~1,265 calls could not be reconciled from data that still exists**, because
the usage blob keeps only the current hour/day/month with no history. That is
precisely why the budget carries a buffer instead of trusting the counter.

### The guard

`MONTHLY_BUDGET = 850` in `tp-places-quota.mjs`, checked for **every** billable
lookup in **every** tier via the `billedMonth` counter and reported as scope
`free_month`.

- **One pot.** The old design had two independent monthly pools (public 1,500 +
  owner 3,000) against ONE 1,000-call allowance: 4,500 authorised calls where
  1,000 were free. `billedMonth` is the sum both tiers move, and no tier limit
  may exceed it (pinned by a test). Owner traffic cannot bypass it.
- **850, not 1,000**, because our counter is not provably equal to Google's
  (see the 1,265 above). The 150-call buffer also absorbs the month-boundary
  skew, manual/dev calls, and the deliberate over-count of a failed Place
  Details request. At 850 the worst case is **$0.00**: 850 < 1,000 free.
- **Owner month sub-cap 600**, which protects VISITORS rather than the card:
  the owner was 1,202 of 1,521 lookups in August, so without it one heavy
  planning day would leave the site's real visitors with no ratings for the
  rest of the month. At least 250 always stays for the public.
- **The month boundary is shifted 8 hours later than UTC** (`BILLING_SHIFT_MS`),
  so the budget rolls over at 08:00Z on the 1st: 00:00 PST exactly, 01:00 PDT
  (an hour late), and 8 hours late if the account's zone were UTC. The rule:
  **never reset before Google does**, because resetting early hands out a fresh
  850 while Google is still counting the old month. A naive UTC month would
  have reset 7-8 hours early every single month.
- **Atomic.** The reservation runs inside the existing etag CAS
  (`updateUsage`), so 50 concurrent batches arriving with 10 calls left
  authorise 10, not 600. Pinned by a barrier test that makes every writer read
  the same counters and etag before any of them writes.
- **Persistent.** Counters live in the Blob store, so a restart, a redeploy or
  a cold start reads the same month. Pinned by a test.
- **Exhausted behaviour:** 429 `free_month` with `Retry-After` and `resetAt`
  pointing at the next boundary. The client parks the queue for the rest of the
  month rather than retrying, rows keep their plain `Google Maps` search links,
  the app is otherwise untouched, and the traveller is told once.

### Credential isolation: what may use the Places key (2026-08-18)

The 850 guard only governs calls that pass THROUGH the guarded function. Audited
what else could use the same credential, and two paths were live:

| caller | could spend outside the guard? | how it was closed |
|---|---|---|
| current production (`shevato`, fe5f021f) | no, it IS the guarded path | - |
| **any old deploy permalink** | **yes** - Netlify keeps every deploy alive forever, and old code reads the LIVE config blob | field rename (below) |
| **this laptop's `.env`** | **yes** - held the SAME key as production, verified by sha256 | key removed from `.env`, credential rotated |
| deploy previews | yes, but they run current code, so guarded | - |
| second Netlify project `shevato-site` (other account) | **no** - probed live, answers `not_configured`, it has no key | - |
| any other copy ever pasted anywhere | unknown | credential rotated |

**The field name is a version gate.** `resolvePlacesKey` reads
`cfg.placesKeyV2`, with NO fallback to `cfg.placesKey`. Every function version
ever deployed before that change looks up `placesKey`, so once that field is
removed from the blob they all resolve nothing and answer 503 `not_configured`
forever, spending nothing. A fallback would reopen exactly the hole this
closes; a test asserts the old field can never configure the endpoint.

**Rotation.** A new key (`tp-places-ratings-v2`, restricted to
`places.googleapis.com`) replaced the old one. Rotation is what kills copies
that live OUTSIDE the blob - a laptop, a note, an old paste - because those hit
Google directly and never read a field name.

**A Google-enforced backstop.** The project's `GetPlaceRequest` daily quota was
lowered from the default **100,000/day to 500/day**. This is enforced by Google
for every credential and every path, so it cannot be bypassed by anything. 500
sits just above the app's own maximum guarded draw (owner 300 + public 150 =
450/day) and cuts a runaway from roughly $2,000/day to $10/day. It is a
blast-radius cap, NOT a monthly bound: a daily quota tight enough to bound a
month under 1,000 would be about 32/day, far below what one legitimate day
needs. Do not mistake it for the monthly guarantee - `MONTHLY_BUDGET` is that.

**What this cannot do.** A Google API key used for server-to-server REST calls
cannot be bound to a particular deployment: there is no application restriction
that fits (referrer restrictions are for browser keys and are not sent on
server calls; an IP allowlist needs stable egress IPs, which Netlify Functions
do not have on this plan). So the control is POSSESSION plus the daily quota:
the credential exists only in the production config blob, and anyone who
extracted it from there could use it elsewhere, bounded at 500 calls/day.

### August 2026 is a TRANSITION month - do not reconcile against it

The guard shipped mid-month, so August's numbers cannot be used to validate our
accounting against Google Billing, in either direction:

- `billedMonth` deliberately started at **0** on deploy rather than being
  seeded with the 2,915 calls Google had already billed. Seeding it would have
  switched ratings off until September for no saving, because August's Places
  charges are absorbed by the promotional credit either way.
- `ownerMonth` was reset from **1,234 to 0** once, on 2026-08-18, as migration
  cleanup: it had accumulated under the old two-pool architecture and would
  otherwise have held the owner's own browser against the new 600 sub-cap for
  no reason. This is a ONE-TIME action; nothing about the design needs a
  recurring or manual reset, and the shared `billedMonth` ceiling governed all
  production traffic throughout regardless. Public `globalMonth` (319) was
  deliberately left alone - it is real public usage and leaving it is the
  conservative choice.
- Therefore August's Google total will exceed our `billedMonth` by design.

**September 2026 is the first clean month**: it opens at 08:00Z on 2026-09-01
with `billedMonth`, `ownerMonth` and `globalMonth` all at 0, entirely governed
by the 850 ceiling. That is the month to compare our counter against Google's
Place Details Enterprise usage, and the comparison is what would justify
raising `MONTHLY_BUDGET` closer to 1,000 later.

**Inspecting it without opening Cloud Billing** (whose figures lag a day):

```
curl -s -H "X-TP-Owner-Token: <token>" -H "Origin: https://shevato.com" \
  "https://shevato.com/.netlify/functions/tp-places?status=1"
```

Returns month, budget, `billedMonth`, remaining, `exhausted`, `resetsAt` and
the per-tier day/month split. Owner-gated, and it carries no key, no token and
no client ids. To change the ceiling, edit `MONTHLY_BUDGET` - and read the
paragraph above it first, because the number is an argument, not a preference.

## Places ratings: the 2026-08-17 429 round

Reported as "POST /.netlify/functions/tp-places 429" on trips of every size,
including a 2-item test trip. Written up in full because almost every intuition
about it was wrong.

**The 429 was ours, and it was PER-CLIENT.** Read straight off the production
counters blob (`netlify blobs:get trip-planner-places usage`) while the fault
was live: `globalDay` 103/200 and `globalMonth` 313/1500, i.e. the site was at
7% of the pools that exist to protect the card - while `clientHour` for one
browser sat at exactly 30/30 (the public hourly cap) and `clientDay` for the
owner's browser sat at exactly 600/600 (the owner daily cap). A zero-cost
production probe confirmed the branch: POSTing with an over-cap clientId
returns `{"error":"quota_exceeded","scope":"client_day"}` and never reaches
Google at all. **Nobody was near the cost ceiling; individual travellers were
being cut off by a limiter that had been sized for a much smaller feature.**

**Why a 2-item trip could fail.** `clientId` is a persistent localStorage value
(`trip-planner:assist:clientId`), so the hour and day counters follow the
BROWSER, not the trip. Open a 40-venue trip, spend the 30/hour, then open a
2-item trip in the same hour and the very first batch is refused. The trip size
in front of you has nothing to do with it; the trip size an hour ago does.

**Why the demand was so large in the first place.** Ratings may not be cached
(see the legal lines above), so every rating shown is a billed Place Details
call, and the client asked for EVERY rating-eligible item in the whole trip on
every page load. Measured on master with a 250ms round trip: a 40-venue trip
issued 4 POSTs and 40 billed lookups on load; a 55-venue trip issued 48 and
then took a 429 with 7 venues never asked about at all. The limiter was written
when ratings appeared on assistant candidate cards alone; they now paint across
Timeline, Days, stays and candidate sets, and the quota was never revisited.

**A second, measured amplifier: the in-flight dedup gap.** `fetchRatings`
marked a batch in flight only when its turn came, so batches 2..N were
invisible to a planner running in between. Forcing a re-render mid-lookup on a
41-venue trip produced **7 POSTs, 70 lookups for 41 venues - 29 duplicates**,
every one of them billed. This is the likeliest explanation for the owner's
600-lookup day.

**And the failure was self-amplifying in the UI.** One 429 abandoned every
remaining batch AND set a flat 3,600,000ms pause, so a partial set of ratings
looked permanent for the session - and because a `client_hour` rejection at
10:59 waited until 11:59, most of the hour it was waiting for was thrown away.

What changed:

- **One queue owns every billed request** (`createPlacesQueue`, trip-logic.js,
  pure and injectable). A key is reserved when it is PLANNED, which is what
  closes the duplicate hole; `planPlacesLookup` still does the normalization
  and the queue's `known` predicate spans cache + queued + in-flight + deferred.
- **Demand follows the eye.** Itinerary rows register with an
  IntersectionObserver (600px lookahead); assistant candidate sets are still
  fetched eagerly, because a half-resolved set makes the winner badges a lie.
  There is deliberately NO background sweep of the rest of the trip: that is
  precisely the pattern that produced the 429s, and it buys nothing visible.
- **Two priority lanes, and they mean something.** `urgent` is a comparison the
  traveller is actively waiting on (an assistant candidate set, a hotel just
  picked from the picker) and `normal` is an itinerary row that scrolled into
  view. Both are on screen; the difference is that an unrated row is just a
  plain link while a half-resolved candidate set renders WRONG badges. An
  urgent request also `promote()`s any key a row already queued, so overtaking
  never costs a second lookup. A batch already on the wire cannot be un-sent,
  so the overtaking is of the waiting queue only - the test says so explicitly,
  because the first version of it asserted the impossible.
- **Concurrency 2, batch 12.** Two in flight is enough to halve the wall clock
  on a long trip without bursting; the batch cap is the server's.
- **A 429 parks the queue, it does not empty it.** The server now returns
  `scope` + `resetAt` + a `Retry-After` header (`resetAtFor`), and the client
  waits for the bucket that actually refills. Retries are bounded
  (`PLACES_MAX_ATTEMPTS`), `unavailable` results are parked for 10 minutes
  rather than re-asked by the next repaint, and `global_month` parks until the
  month turns instead of being retried all day.
- **Server-side coalescing of concurrent identical lookups was investigated and
  deliberately NOT built.** Netlify runs one instance per request, so an
  in-process map would only dedup within one instance and anything real would
  need distributed locking over the Blobs store. With the client now coalescing
  by key, a single browser can no longer produce concurrent identical lookups
  at all; what remains is two DIFFERENT visitors asking for the same venue in
  the same second, which costs one extra $0.02 Details call. That is not worth
  a lock.
- **Per-client caps were raised; the POOLS were not.** Public 30/60 became
  60/120, owner 300/600 became 500/1200, while `globalDay` 200, `globalMonth`
  1500, `ownerDay` 1000 and `ownerMonth` 3000 are untouched. That keeps the
  public tier's $10/month worst case exactly where it was. Raising a per-client
  cap cannot raise spend - clientId is client-minted, so those caps were only
  ever advisory smoothing.
- **The owner's per-client day cap is now ABOVE the owner pool**, so it can
  never be the limit that speaks. A per-client cap is no defence for a bearer
  token anyway (a thief rotates clientId); the pool is the ceiling that means
  something. Pinned by a test.

Measured after, same harness, 250ms round trip, 1280x900:

| venues | POSTs on load | billed on load | after a full read | 429s |
|--------|---------------|----------------|-------------------|------|
| 2      | 1             | 2              | 2                 | 0    |
| 10     | 1             | 10             | 10                | 0    |
| 40     | 1             | 11             | 28                | 0    |
| 55     | 1             | 11             | 28                | 0    |

Zero duplicates in every case, and zero 429s even when the fake server is held
at the OLD 30/hour cap - the architecture, not the raised limit, is what fixed
it. Time to the first rating is ~350ms regardless of trip size.

**The owner tier works, and it is per-BROWSER, not per-person.** Audited end to
end this round: `ownerToken` lives in the config blob, the owner pastes it into
`localStorage['trip-planner:places:ownerToken']` once per ORIGIN, and
`placesRequestBody` attaches it to every request. It has nothing to do with
being signed in - the site's Firebase auth and this bearer secret never meet.
Production counters confirm it is live (`ownerDay`/`ownerMonth` were moving
while `globalDay`/`globalMonth` stayed put), and the bucket separation holds in
both directions (pinned by tests: a maxed owner cannot lock visitors out, and a
maxed public pool does not throttle the owner). The ergonomic consequence is
worth knowing before diagnosing a "why am I rate-limited" report: the owner's
phone, a second browser, a private window and shevato.com-vs-localhost each
need their own paste, and any of them without it is an ordinary public visitor
on 60/hour. Binding that to real auth instead of a pasted bearer secret is the
obvious improvement and was deliberately NOT done here - it is an auth change,
not a rate-limit change. (The configured token is also 43 characters against
the 64+ the setup note asks for; harmless, but rotate it longer next time.)

**Quota rejections now log.** A 429 used to write nothing to the function log,
so "which bucket refused this?" could only be answered by reading the counters
blob by hand - the same blind spot that made the tp-assist 502 undiagnosable.
`quotaExceeded` now `console.warn`s the scope and the shut duration. No
clientId: it is attacker-minted and not ours to record.

Traps this round minted:

- **A Netlify deploy preview CANNOT exercise ratings through its own UI.**
  `originAllowed` accepts `shevato.com` and localhost only, so a page served
  from `deploy-preview-N--shevato.netlify.app` gets 403, which the client reads
  as "not configured" and switches ratings off for the session - silently, and
  indistinguishably from having no key. To verify a preview end to end: serve
  the repo on localhost and proxy `/.netlify/functions/*` to the preview with
  `Origin: https://shevato.com`. The real app then runs against the deployed
  function (the guard is defence-in-depth and forgeable by design; the quotas
  are the actual control). Note the preview shares the SITE's blob store, so a
  preview lookup spends real money and moves the production counters.
- **Zero-cost ways to probe tp-places in production**, worth knowing before
  anyone spends to reproduce a bug: a query that `isGenericQuery` rejects never
  reaches Google, and a clientId already over its cap returns 429 from the
  quota branch without an upstream call or a blob write. Both exercise the real
  deployed path for $0.00.
- **`netlify blobs:delete` rate-limits bursts.** A first pass deleted 112 keys
  in a row and then failed every remaining call until left alone for a minute;
  running it under `xargs -P` made every invocation hang instead. Purging a
  store means serial calls with a pause and a retry. (`while read` also drops a
  final line with no trailing newline - 85 of 86 keys went, and the survivor
  looked like a failure that was not.)
- **The E2E profile leaks localStorage between blocks**, so `openApp`'s first
  navigation boots the app on the PREVIOUS block's trip and legitimately looks
  its venues up before the clear-and-seed. Counting those as the current
  block's requests invented "duplicates" the app never made. Every count in
  `e2e/places.mjs` is scoped to that block's own venue-name prefix.
- **`clickSel` on a wrong selector is swallowed by `.catch(() => {})`**, which
  is how two early probe runs "proved" that view switching was free: the view
  never switched. The view controls are `#viewTimeline` / `#viewDays` /
  `#viewMap`, not `[data-view=...]`.
- A jump straight to the bottom of a long board does NOT fetch the rows it flew
  past; IntersectionObserver only fires for what actually intersects. That is
  correct (nobody read them) but it makes "after scroll" counts depend on how
  the scroll was performed.
- The unit tests and the browser disagreed on duplicate counts for a while, and
  the unit tests were right. When they diverge, print the actual POST bodies
  before changing the implementation.

## Opening hours: the closed-venue gate (2026-08-21)

The reported failure: the assistant scheduled `Drinks: Above The Grid` at
23:00 on a day the bar CLOSES at 23:00, and the app presented it as an
ordinary recommendation. Root cause is a combination: the model was never
given hours information (and could not be trusted with it if it were), and
the app accepted a timed venue action with no deterministic check - the
Places pipeline was already resolving every candidate for ratings, so the
venue identity existed; hours were simply never requested. The fix requests
them on the SAME lookup and validates deterministically. The invariant:

> A venue with verified hours must never be accepted as a normal timed
> assistant recommendation when the proposed time falls outside those hours,
> and absence of hours data is never read as proof of being open: unknown
> means UNVERIFIED, and the app never claims a venue was checked when Places
> data is unavailable.

- **Where hours truth comes from.** `regularOpeningHours` (weekly pattern) +
  `currentOpeningHours` (dated periods for the next ~7 days, holiday-aware)
  on the EXISTING Place Details call. Both are "Place Details Enterprise"
  fields (verified against the data-fields doc 2026-08-21) - the tier
  `rating` already bills - so the field-mask addition changes neither the SKU
  nor the price nor the request count. Zero new requests by construction:
  every surface paints from the session cache entry the ratings lookup
  already creates, and `tests/tp-places-hours.test.mjs` pins the mask, the
  single billed call and the id-only blob cache. Do NOT add any
  "Enterprise + Atmosphere" field (reviews etc.); that WOULD raise the SKU.
- **One normalized shape, one validator.** The server normalizes Google's
  shape through `TripLogic.normalizeGoogleHours` (trip-logic is dual-exposed;
  tp-assist already imports it the same way) and the client re-validates the
  wire payload with `sanitizeHours`, so the two cannot drift and malformed
  network data collapses to null = unknown. Times are minutes past midnight
  in the VENUE'S OWN local time, which is also what every itinerary time is
  (floating local times, venue in that day's city), so no timezone math
  exists anywhere in the feature.
- **The boundary rule** (`hoursVerdict`): open <= t < close. A start AT the
  closing minute is CLOSED (the reported case: 23:00 at a 23:00 close);
  22:59 is open. Overnight periods (18:00-02:00) cover past midnight into
  the next calendar day - the dd/dl walk in `weeklyCovering` handles
  overnight, week-wrap (Sat->Sun) and multi-day periods with no special
  cases. Google's no-close convention = open 24 hours. Dated periods beat
  the weekly pattern for the dates they name; a date they name with no
  covering period is closed BY them; a date they never mention falls back to
  weekly (absence from a 7-day window is not evidence).
- **closingSoon: "technically open" is not "worth recommending" (2026-08-21
  refinement).** `hoursVerdict` takes an optional fourth argument, the
  minimum recommendation window in minutes: a covered time whose interval
  closes in LESS than that window answers `closingSoon` instead of `open`.
  The verdict states are open / closingSoon / closed / unknown, and
  closingSoon is a recommendation-quality state, never another definition of
  closed - the hard closed rule above is untouched. The boundary is
  INCLUSIVE (remaining == window is open: a 30-window restaurant closing
  23:00 is open at 22:30, closingSoon at 22:31), and the remaining time is
  measured to the close of the interval CONTAINING the proposed time - the
  covering hit's own `closesMin` - so split hours measure to the current
  sitting (13:31 in an 11:00-14:00 sitting is closingSoon even though the
  venue reopens 17:00-23:00) and overnight intervals measure through
  midnight (`closesMin` is relative to the queried date, 02:00 next day =
  1560). Without the argument (or 0) the verdict is exactly the pre-window
  one, which is what every Days-view slot passes: manual rows keep the
  purely advisory `Closes at X` line and are never demoted or blocked.
- **The category -> window mapping** lives in `RECOMMEND_HOURS_WINDOWS` +
  `recommendWindowMin` (trip-logic): meals 30 (the published close is an
  ARRIVAL constraint, not a finish-the-meal deadline - deliberate), drinks
  45, museum 60, gallery 45, cafe/bakery 30, shop/market 30, and a
  45-minute default for any other visitable activity. Classification is
  STRUCTURED first - the meal/drinks title prefixes of the assistant
  contract, read through the same `mealKind` every surface uses - and only
  then unambiguous category words in the title/maps query ("museum",
  "gallery", "cafe", "market"...); a name that says neither ("Louvre",
  "Tokyo Tower") gets the default rather than a guess, which at worst
  under-buffers an unnamed museum by 15 minutes and never invents a
  category. Activities only: travel legs and notes are not visits, and a
  stay keeps closed-only verdicts (`recommendWindowMin` returns null).
- **Unknown is a first-class verdict and it means SILENCE, worded as
  UNVERIFIED.** No key, spent quota, offline, a failed request, an
  unresolved place, or a place Google has no hours for: all paint nothing
  and block nothing. Blocking on unknown would switch the assistant off
  whenever the ratings budget runs out, and painting "open" would be a lie;
  the absence of the hours line IS the unverified state, and no wording
  anywhere may imply that every venue was checked. Decided and deliberate:
  only VERIFIED-closed demotes, refuses or excludes.
- **Three enforcement points, all deterministic, and both demoted states go
  through all three.** (1) Paint: `paintHoursSlot` stamps the verdict on
  the `.ap-hours` slot and demotes the card/option - closed in red
  (`is-closed` / `is-closed-time`), closingSoon in amber (`is-closing` /
  `is-closing-time`) with the reason on the card ("Closes at 11:00 PM ·
  only 20 min remaining") - so neither reads as a normal recommendation;
  the radio stays clickable for transparency only. The two states demote in
  different colours on purpose: "shut" and "too tight to recommend" are
  different claims. (2) Badges: `candidateBadges` takes a per-candidate
  `closed` array (fed from the painted verdicts, closingSoon included) and
  drops demoted candidates from EVERY winner contention - a demoted card
  must never simultaneously be promoted as `Highest rated`/`Most popular`/
  `Shortest route`; exclusion that leaves fewer than two open entrants
  omits the badge, exactly as unresolved data does, and unknown-hours
  candidates still compete (they are unverified, not closed). (3) Write:
  `acceptProposal` runs `closedHoursFor` at accept time (so a verdict
  landing after the cards painted still gates; it re-derives the same
  category window) and REFUSES - there is no "add anyway" for an assistant
  recommendation. The refusal names its state ("Closed at that time" /
  "Too close to closing", the latter saying how many minutes remain and
  what the category needs) and its one action hands off to the item form
  (prefilled via `openItemModal`'s preset, now carrying
  `startTime`/`details`), where the time sits in front of the traveller to
  change and whatever they save is a MANUAL traveller item. The manual
  boundary is deliberate and sharp: the item form never gates on hours in
  any state - a person scheduling against a listing is a deliberate act the
  app only flags (Days-view line), never blocks - so traveller-created
  items are entirely unaffected by the restriction. Updates are gated like
  adds (a refused update hands off to editing the target item); existing
  traveller items are never auto-moved. The PROMPT also tells the model to
  respect hours (`ASSIST_HOURS`), but that is defence-in-depth only - model
  knowledge of hours is not evidence.
- **Why no automatic replacement of a closed candidate.** Tier 1
  (copy/paste) has no model round trip to make, and for tiers 2/3 a
  constrained retry would double latency and spend for a case the demotion
  already communicates; the traveller can ask the open panel for a
  replacement in one message. Revisit only if closed candidates turn out to
  be common in practice.
- **Display.** Days view: activity rows only (travel legs, notes, stays,
  cancelled rows get nothing - a leg's hours are a category error and a
  hotel's "Open 24 hours" is noise), always against the row's SCHEDULED
  date, never the real-world clock, and never a green "open" badge. Formats
  through `fmtTime` via injected-formatter `hoursLineText`, so the 12/24
  preference applies and no second time formatter exists. `Closes at X`
  warns when the start sits within `HOURS_CLOSING_SOON_MIN` (60) of closing.
  Timeline deliberately carries no hours line (Days is where a day is read);
  the chips sit beside the visible `Google Maps` wordmark element, which is
  what visually groups them with the rest of the Google-sourced content.
- **What this still cannot guarantee.** Provider hours can themselves be
  stale or incomplete. Beyond that: holiday/special closures outside
  Google's ~7-day dated window; a full-day special closure INSIDE that
  window (a closed date simply has no dated period, which is
  indistinguishable from "not covered", so the weekly pattern is trusted
  instead - conservative in the direction of never wrongly demoting);
  last-entry times, kitchen-closing times, reservation-only seatings and
  other venue-specific restrictions that no hours field represents (a
  museum whose doors close at 17:00 may refuse entry from 16:15, and the
  data cannot say so); venues the confidence gate refuses to match
  (unverified, silent); and anything proposed while hours are unverifiable.
  The traveller-facing mitigation is the same one ratings use: the card's
  own Google Maps link for self-verification.

## Food & Drink is a FIELD, not a seventh type (2026-08-21)

The reported problem: `Dinner: Saba` stored its CATEGORY inside free-form
title text. That duplicated the icon on every card, made `activity` mean both
"museum" and "restaurant", and - the sharpest edge - fought the venue
autocomplete: the picker searches `#inTitle`, so every keystroke of the
`Dinner: ` prefix fired another Photon query for a string no venue is named,
and the traveller had to type the classification *through* the place search.

**The decision that shapes everything else: storage keeps six types and gains
a `meal` FIELD; `food` exists only in the form and in display groupings.** A
seventh storage type looks obviously right and is a data-loss bug:

- `repairTrips` coerces an unknown `type` to `'note'` - in EVERY already
  deployed copy of app.js, including the one in a tab someone left open.
- Sync is whole-key last-writer-wins over the entire db (see "Sync model").

So one stale client seeing `type: 'food'` would rewrite the item to a note,
losing the type AND the category, and LWW would push that back over the good
copy. An unknown FIELD survives all of it: old `repairTrips` never looks at
`meal`, old saves round-trip it, old sync carries it. The cost is one
indirection (`storageTypeOf`, `MODAL_TYPE_META`) and it is worth it.

- **`itemMealKind(item)` is the ONE question every surface asks.** Structured
  field first, legacy title prefix second. The fallback is not belt-and-braces:
  a read-only SHARED trip is rendered without ever passing through repairDb,
  so its items reach the renderer un-migrated and the prefix is the only thing
  that can answer.
- **The migration is deterministic and narrow.** `normalizeMealItem` runs in
  `repairTrips` (boot, sync merge, undo reload), in `sanitizeItem` (file
  import + share import) and in `expandSampleItem` (the template library), so
  the three cannot drift. It splits ONLY the four literal assistant-contract
  prefixes, colon required - `Sunset dinner cruise` and `Dinnerware shopping`
  are the tests that stop it becoming a fuzzy match on the word "dinner". A
  title that is nothing but the prefix keeps the kind word as its name, or
  `validateItem` would reject the row and the next save would destroy it.
- **`meal` is validated as an OWN property** (`isMealKind`, not `in`), the
  same `__proto__` discipline the quota counters needed: `meal` arrives from
  imports and share links, which are attacker-authored strings.
- **The assistant contract is deliberately UNCHANGED.** The prompt still
  mandates `"Dinner: "` and the model still writes it; `proposalToItem` and
  `applyProposalUpdate` convert at the boundary. Changing a prompt contract is
  a different risk (re-tuning every reply shape) from changing storage, and
  a test asserts the prompt still states the prefixes so the two cannot drift
  into each other by accident.
- **The category is displayed ONCE.** Icon + accent on cards (`rowLook` reads
  `itemMealKind`), and the icon's `aria-label` carries the word, so an
  icon-only category is still spoken. The two deliberate exceptions, both
  because the surface has no icon to carry it: the `.ics` `SUMMARY` (a
  calendar entry is read in another app) and the CSV `category` column
  (appended last, the running column-order contract).
- **`costsByType` emits a `food` row** - a display grouping, not a stored
  type - because dinners and museums are different money. Same reason the
  toolbar filter splits: `Activities` now means "activity WITHOUT a meal
  kind", or picking it would hand back every dinner on the trip.
- **The type picker is 4 columns, not 7.** Seven across a 600px modal leaves
  78px a cell, where "Local travel" and "Food & Drink" each wrap to two lines
  while "Note" sits alone on one. Four columns give every label its own line
  and cost exactly two rows (4 + 3) at BOTH widths - the phone override that
  used to drop to 3 columns was removed, because 3 columns and 7 types is
  three rows with an orphan, i.e. the tallest picker on the smallest screen.
  Measured: desktop cells 130x58, phone 79x62, no clipping or overflow at 390.

Probe traps this round minted:
- **The toolbar filter selects listen for `input`, not `change`.** A probe
  dispatching `change` on `#filterType` changes nothing and the board renders
  exactly as before - which reads as "the filter is broken" rather than "the
  probe is". Two of the first three probe failures this round were that.
- The venue dropdown's option class is `.cb-opt` (with `role="option"` on the
  same element); there is no `.cb-list` wrapper to query through.

## Day-card presentation contract (2026-08-21 polish round)

A pure presentation round (no trip logic touched): the day/stop cards were
carrying five button-shaped elements per stop and five equal header icons per
day. The rule the round settled on, keep it when adding anything to a card:
**actions look like actions, information looks like information.** A stop is
title (strongest), one quiet fact line, optional two-line description; the
only bordered chips on a row are genuine actions (Directions; edit/delete).

- **The fact line is text, not pills.** `.dc-cost` (bold text), `.dc-dist`
  (dim text), the combined Maps+rating link and the hours line sit on one
  wrapping flex line. The ONLY generated separator is the middot between
  price and distance (inside `.dc-dist::before`, so an absent price takes the
  dot with it). Dots in front of the Maps link and the hours were tried and
  reverted: both elements carry their own internal middots, and a generated
  dot LED THE LINE whenever the facts wrapped - which element wraps is not
  knowable from CSS, so the only wrap-proof dot is one glued inside an
  element that never starts the line.
- **The Google attribution constraint shapes the restyle, not the other way
  round.** The rating may only appear inside the combined element with the
  verbatim "Google Maps" wordmark linking to the place (see the Places legal
  lines above). So the element was requieted (no border, no fill, hover
  underline), never split into a bare "⭐ 4.6" chip; the wordmark keeps its
  never-wrap/never-truncate rules. Clicking the rating IS the Maps link,
  which is also why a separate big "Google Maps" button could go.
- **Facts sit under the title at EVERY width now.** The old container query
  (>520px card: facts beside the title) was removed rather than retuned: with
  hours on the line it squeezed the title into wrapping, ellipsized the
  review count and clipped the Directions chip at exactly the widths with the
  most room. One anatomy per row everywhere is also what the phone always did.
- **Edit/delete hide until row hover/focus-within - but ONLY under
  `(hover: hover) and (pointer: fine)`;** touch keeps them visible at 0.55.
  Two headless traps: this chromium's `--headless=new` reports hover:none
  (so every harness screenshot shows the TOUCH state, buttons visible), and
  CDP `Emulation.setEmulatedMedia` does NOT support the hover/pointer
  features - verified live, `matchMedia` stays false after the call. To see
  what a desktop sees, inject the media block's rules verbatim minus the
  wrapper (the shots harness does this); to trust the real thing, check in a
  headed browser. e2e clicks on the hidden buttons still work: opacity:0
  keeps layout and hit-testing, and clickAt's mouseMoved hovers first anyway.
- **The day header is two visible actions (🤖 ask, + add) plus a `⋯` menu**
  (copy day as text / copy to another date / delete day's items, same
  data-acts, same disabled reasons; shared mode renders neither the edit
  actions nor the menu, exactly as before). Menu state is DOM-held only - a
  re-render simply comes back closed. Two structural traps its CSS handles:
  `.day-card` is `overflow: hidden` AND a stacking context (container-type
  sets layout containment), so an open menu would be clipped by its own card
  and painted over by the next card - `.day-card.has-open-menu` lifts both
  for exactly as long as the menu is open. Escape is integrated at the TOP of
  the one global keydown chain (menus are mutually exclusive with every layer
  below it, since opening any of them closes the menu). The outside-click
  closer skips clicks inside `.dc-menu-wrap`, which is what lets "Copy day as
  text" keep its menu open for the ✅ flash on the item's own `.dm-ico` (the
  flash targets that span now - the old code swapped the BUTTON's
  textContent, which would wipe a labelled menu item).
- **e2e consequence:** anything driving duplicate-day/clear-day/share-day
  must click `[data-act="day-menu"]` first - a hidden menu item is a
  zero-rect and `clickSel` refuses it (core.mjs E does this).
- The icon tile is 24px (was 28) and the rail geometry derives from it: rail
  height 38px centres the dot on the tile (7px card padding + 12), connector
  top 28 / lead-in 14. Change the tile size and these three move with it.
- Days-view descriptions clamp at TWO lines (`.dc-details` overrides the
  shared `.det-body` clamp of 3); the timeline keeps 3.

## Assistant: modes, and where a suggestion is measured from

Two failures reported together on 2026-08-14, with one shape between them:
something that belongs to the GUIDED picker had been written into the shared
layer, and something the app already knew had not been given to the layer that
needed it.

- **Two different things get called "the option count", and only one is the
  traveller's to choose.** How many SLOTS a day gets (Activities 1-2 / 2-3 /
  3-4, Drinks Skip / 1-2 / 2-3, which meals) is picked in the UI and carried by
  `buildPlanRequest`, which prints it back verbatim ("I would like 3-4
  activities", "Do not suggest breakfast, lunch or drinks"). How many
  CANDIDATES each slot offers (3 for a meal or drinks slot, 2 for anything
  else) is fixed, is not exposed anywhere in the picker, and is what the
  pick-one card is built around. `ASSIST_OPTIONS_PLAN` states only the second
  and scopes itself to "the slots the traveller asked for", so it cannot
  override the first; pinned by tests, because "guided respects the controls"
  and "guided counts stay 3 and 2" are both true and easy to conflate.
- **A cap on free-form chat is a product rule wearing a technical costume.**
  The first cut of this replaced "exactly 3" with "up to 8 per slot", which is
  the same unexplained refusal with a bigger number in it - a traveller asking
  for ten restaurants is not asking for anything the app cannot render. The
  chat rule now carries NO number. The real ceiling is reply SIZE, not count:
  `GENERATION_CONFIG.maxOutputTokens` bounds a Gemini turn and the fenced JSON
  sits at the END of the answer, so an overrun truncates exactly the part that
  becomes the cards. That is handled where it lives (the server appends
  `TRUNCATION_NOTE` on `MAX_TOKENS`) and stated in the prompt as the
  degradation to prefer: cover what fits, say how much, offer to continue.
- **A travel leg is not a venue, and it was dressed as one.** The reported
  "Return to hotel" card carried the hotel's own 4.8 (958) star rating, because
  `proposalCard` and `mapsHtmlFor` both keyed off "does this have a mapsQuery"
  rather than "what is this". A leg HAS a real mapsQuery on purpose (see
  ASSIST_MAPSQUERY: the return action carries the hotel's actual name so the
  distance chip has something to measure to), which is exactly why the TYPE has
  to be what decides. `isPlaceType` / `isTravelLeg` own that split now: a place
  gets the rating and the listing, a leg gets `Directions` from where it starts
  in the mode its distance implies, and no rating anywhere. A leg's estimated
  COST stays, because a taxi fare describes the leg; a rating describes a
  choice nobody is making. Side benefit: a leg makes no billed Places call.
- **`dayDistanceChain` legs carry `fromQuery`/`toQuery`** alongside the labels,
  because a label is an item title ("Return to hotel") and routes nowhere. That
  is what lets a Days-view leg row open directions from the previous stop;
  Timeline has no chain and stays destination-only, which is honest rather than
  guessed.
- **The picker's option counts are the picker's, not the assistant's.**
  "EXACTLY 3 candidates per meal or drinks slot" lived in
  `buildAssistSystemPrompt`, which every tier and every turn builds, so a
  free-form "give me 5 options, not 3" was answered with "my instructions
  require exactly 3". The prompt now splits into `ASSIST_GROUPS_MECHANIC` (how
  a set is expressed - permanent contract, the pick-one card is built on the
  shared group id) and `assistOptionRules(mode)` (how many - `plan` keeps the
  fixed counts, `chat` honours the traveller's number up to
  `ASSIST_MAX_OPTIONS`). **The default is `chat` everywhere**, client and
  server: an unknown or missing mode must never inherit the bounded counts.
  Mode is per REQUEST, not per conversation, so a follow-up typed into the
  composer is free-form mid-thread. `runPlanRequest` is the ONLY caller that
  passes `'plan'`. Nothing downstream ever capped the count - `groupProposals`
  and the set card render N candidates - so this was a prompt bug alone.
- **`dayAnchor` and `proposalOrigin` answer different questions.** dayAnchor is
  "where does this DAY open" and the Days-view chain needs it to be the airport
  on an arrival day (the first chip is "gate to hotel"). A SUGGESTION lands at
  an hour: `proposalOrigin(items, date, time, isResolved)` walks the day's own
  plans for the last one placed before that hour, and a leg is ordered by when
  it LANDS, never when it leaves (at 10:00 on a flight that departs 09:00 and
  lands 13:30 the traveller is in the air). Once the day has a bed, a leg that
  arrived earlier stops being the origin. `dayBaseOrigin` is a third question -
  "where is the traveller BASED that day" - and exists only for the prompt,
  which needs one place to reason about a whole day from.
- **Why the reported card had no distance at all.** All three of: the anchor
  came from the focus day rather than the card's own day and time, so an
  arrival-day evening measured from an airport whose table
  `paintAssistDistances` never loaded; the anchor's own venue query was never
  queued for a lookup (paintDayDistances does queue it, the assistant path did
  not); and the airport then fell back to the city centroid the suggestion also
  fell back to, which `sameSpot` correctly drops as a fake 0.0 km. Cache-cold
  plus same-centroid renders NOTHING, which is right, and was indistinguishable
  from broken.
- **The model has to be told the app measures distance.** Without
  `ASSIST_DISTANCE` it volunteered "I do not have access to live GPS or
  real-time traffic data, so I cannot calculate the travel distance" - true of
  the model, false of the product, and it talked the traveller out of a figure
  already on screen. The same paragraph forbids inventing one in prose, which
  is the failure mode the first half invites.
- The pre-add and post-add figures agree BY CONSTRUCTION, not by a second
  implementation: an accepted proposal is an ordinary itinerary item and
  `proposalOrigin` finds it like any other plan for that hour. The old
  `assistAcceptedPoint` (a "last accepted place" the panel carried alongside
  the trip) was deleted for exactly that reason - it was a parallel copy of
  state that had to be kept in step with the day, the clock and the focus.
- A route line is the order to visit a day's PLACES in, so only `activity`
  proposals are stops. Routing a `local` "Return to hotel" put a numbered "1"
  on the ride home and walked home first.
- Distance wording is NOT split like the weather chips, and that was a
  correction: the first cut left the travel estimate in the tooltip, which is
  invisible on a phone and needs a hover on a desktop, so in practice the
  traveller saw a distance and no time. The chip now carries the time, the
  distance and the origin (`🚶 ~20 min walk · ~1.3 km / 0.8 mi from Hotel
  Borg`); only the straight-line caveat and the mode it did not name stay in
  the tooltip. Minutes are spelled out because `fmtDur`'s "20m" reads as
  twenty METRES beside a distance - `fmtMins` exists for exactly that, and
  `fmtDur` is left alone for the route dialog, where there is no distance next
  to it.
- Which mode gets named is a judgement, not a threshold for its own sake:
  under `WALKABLE_KM` the walk is the useful answer for an evening out, above
  it the walk is computable and useless ("1 hr 3 min on foot" is not how anyone
  crosses a city) so the ride is named instead. The directions link uses the
  SAME judgement, so a card cannot promise a walk and hand over driving.

## The automation round (2026-08-18): what a form may answer for itself

The whole round is one product rule with a hard edge: **derive, prefill, never
overwrite.** Everything below is a consequence of it.

### Where the inference lives

`newItemCity` / `newItemDate` / `newItemType` / `newItemDefaults` /
`stayDatesFrom` / `flightOriginCode` / `routeSuggestion` /
`transportPrefillForGap` are pure and in trip-logic, with `tests/smart-defaults.test.js` over them. app.js contributes
exactly three things and no logic: the DOM reads, the rule that a derived value
only ever lands in an EMPTY field, and `iataCity`, the injected
airports-table probe (the same injection style `dayMorningCity` and
`suggestedPassport` already use to stay pure).

- **`openItemModal` precedence is: the item being edited > the preset > the
  derived default.** An edit passes `auto = null` and every field short-circuits
  on the item's own value, so an edit can never be handed a guess. This matters
  more than it looks: the form REBUILDS the item from its fields on save, so a
  default leaking into an edit would silently rewrite stored data.
- **A trip with no dated item derives no date at all.** Today is a guess about
  intent rather than a reading of the itinerary, and a first item silently dated
  today defines the trip's whole span - which is then wrong on the night strip,
  the day cards, the coverage warnings and the totals. The field opens blank, as
  it did before any of this existed. The same reasoning stops "choose Stay" from
  inventing a stay on today's date on an empty plan.
- **The type default is measured, not guessed.** Across the 13 sample
  templates: 382 of 529 items (72%) are activities, and 13 of 13 open with a
  flight. Hence flight on an empty plan, activity thereafter, and a test over
  the library pins both halves so the rule fails loudly if that corpus ever
  changes shape. **Re-measured on 2026-08-21**, when Food & Drink split off
  what had been counted inside that 72%: excluding the boilerplate note, the
  516 sample items are 41.3% activity (213), 32.8% food & drink (169) and
  25.9% everything else. Activity is still the plurality, so the default is
  unchanged - but it is now a 8-point lead rather than a landslide, and a
  future library that leans further into meals should move it.
- **`applyTypeDefaults` is deliberately NOT inside `setModalType`.**
  `openItemModal` calls setModalType BEFORE it writes the date fields, so a
  default applied there is overwritten by the very open that asked for it. The
  type picker's click handler is the only place a type changes under a form
  already on screen, so that is where it runs.
- **A flight and a between-cities transport never get a `location`**
  (`PLACE_DEFAULT_TYPES` = stay, activity, local). Their route lives in the
  TITLE, which is what `parseTravelOrigin` / `parseTravelArrival` read; giving a
  flight a city would make `dayMorningCity` read a departure day as its
  destination. The sample library has always stored them this way and the
  prefill follows it rather than inventing a second convention.
- **A bare IATA code is never offered as a city.** `stripPlaceCode` only removes
  a PARENTHESISED code, so an imported or hand-typed "SHV to HND" leaves "HND"
  sitting in the arrival-city slot. `BARE_IATA_RE` catches it and either
  translates it through the airports table or skips the rung. Found while
  smoke-testing the rung, not in review: it looked completely correct against
  every title the app writes itself.
- **With no stays yet, the first bed is needed the night you LAND.** An
  overnight flight is that night's bed - `tripStats` has always counted it as
  one - so opening a stay on the departure date was a day early on every
  red-eye, which is the commonest two-item sequence in the app (log the flight,
  book the hotel). `stayDatesFrom` answers that case before it looks at
  coverage, because `coverageGaps` returns [] for an empty stay list and the
  gap branches are dead there anyway. It LOOPS over overnight legs rather than
  skipping one, because a long-haul through an overnight layover is two stacked
  red-eyes and skipping one still books a night spent in the air.
- **`stayDatesFrom` and `stayCheckoutFor` answer different questions and are
  not interchangeable.** The first is "where does the next hole START" and is
  right only when the form has no date the app must respect; the second is "how
  long is the hole that begins HERE" and is what a check-in already on screen
  needs. Using the first for both wrote a four-night stay straddling two
  existing bookings (trip covered the 5th-8th and the 10th-12th, form opened on
  the 6th). Which one runs is decided by field OWNERSHIP, below.
- **`stayDatesFrom` must always return a range `validateItem` accepts**, or
  choosing Stay would open a form that cannot be saved. A trip with full
  coverage (or no stays at all) therefore falls back to one night from the day
  in hand rather than to null. Pinned by a test that runs every branch through
  `validateItem`.
- **Field ownership is the invariant, not "only write into an empty field".**
  `autoFilled` (a Set on the item form) records which fields the APP filled on
  this open; `appOwns(key, el)` is true for those and for anything still empty,
  and an `input` on the field deletes its key for good. A pick from a dropdown
  counts as HUMAN and hands the field over too. The blunt earlier rule ("write
  only into an empty field") failed in both directions and both failures were
  found by walking a real journey rather than by reading the code:
  - a derived date BLOCKED a better derived date, which is how the red-eye fix
    became unreachable from the UI - the date field was already populated by
    the opening default, so choosing Stay took the typed branch and booked the
    night on the plane after all;
  - a derived city was STRANDED on the wrong day, because the toolbar's Add
    opens on the trip's first day and nothing re-derived the city when the
    traveller moved the date to the one they meant.
  `syncDerivedCity` is the single implementation of "what city belongs in this
  form now", called both when the type changes and when the date changes, so
  the two paths cannot drift. It also CLEARS an app-written city on a day that
  cannot justify one, which is the honest half of the same rule.
- **The venue coordinate is keyed BY CONSTRUCTION, not by convention.** A picked
  venue's lat/lon is not stored on the pick; it is held in `venuePick` and
  written on SAVE under `placeCacheKey(itemMapsQuery(it))`, computed from the
  item that was actually saved. Every read path derives the same key from the
  same function, so the two cannot drift. The `wrote` guard (the same one
  `flightPick` uses) means a retyped title drops the coordinates rather than
  stamping them onto a different place.
- **privacy.html is part of the diff, not a follow-up.** Its Photon paragraph
  made a NARROW, checkable promise ("what you type into a stay's name field"),
  and the venue picker widens it to activity titles. The prose now names both
  fields, what each is answered with, that nothing is sent before the third
  character, and that the other four types send nothing at all. Widening what a
  provider receives without touching that page would have left the policy
  stating something false.
- **Prefilling the city has a downstream consequence worth knowing.** A
  hand-added activity used to carry no `location` unless the traveller typed
  one, so it was not a Map-view stop and nothing geocoded it. It now usually
  carries the day's city, which is the shape the sample library has always used
  (every sample activity has one) and is what puts it on the map. The added
  geocoding load is ~zero because the string comes FROM another item on the same
  trip and `geoCache` is keyed by that string; the one case that can introduce a
  new string is the arrival rung reading a city out of a leg title before any
  stay exists, which costs one cached Nominatim call the first time the Map is
  opened.
- **A prefill must not spend a request.** `openRouteModal` grew an
  `autoCheck` opt-out for exactly this: clicking a specific leg is a question
  and still gets answered immediately, but the toolbar's prefilled pair leaves
  `checkRoute` un-run with focus on the Check button. The general rule for this
  round: deriving a value is free, acting on it is the traveller's call.
- The coordinate goes in `trip-planner:venuegeo:v1`, sharing that store's
  30-day TTL. An OSM coordinate is under no such obligation - the TTL exists for
  Google's terms - but sharing one store is worth more than a second one, and
  expiry just means the row is looked up again later.

### The venue picker, and what it is not

Photon is a **name** search. Measured against the live service on 2026-08-18:
`teamLab` biased to Tokyo answers teamLab Planets then teamLab Borderless;
`Louvre` answers the museum; `Eiffel` answers the tower; `Central Park` answers
the park - the best answer was first in every case. But `pizza` answers eight
places literally NAMED "Pizza" and `museum` answers Museum Square. So the
feature completes a venue the traveller can already name and is described that
way in the UI hint; "find me a museum nearby" is a category search, needs
Overpass, and is refused on Overpass's own policy (quoted above).

- **Exclusions on the wire, an allowlist in the code, and the exclusions must be
  a SUBSET of what the allowlist rejects.** Photon's `osm_tag` include filter
  hard-filters, so an include list that misses one class answers an EMPTY list
  for a real place - the same trap the hotel picker's rejected bbox fell into.
  `osm_tag=!highway` and friends are safe because they only remove classes
  `VENUE_CLASSES` would have dropped anyway; a test asserts that, because
  Photon answers 200 with a shorter list and nothing would ever look broken.
  Measured: a bare "Eiffel" returns six bus stops in its top eight; with the
  exclusions it returns the tower, a cafe and a station.
- **Two ranking bugs found by running the ranker over LIVE payloads rather
  than over fixtures, and both were invisible in a fixture.** Fixed together;
  "Sagrada Familia" near Barcelona is the case that shows both.
  1. **The dedup key has to include the CLASS.** The hotel picker collapses on
     name+town+country, which is right there (within lodging, one name in one
     town is one hotel). Barcelona holds a basilica, an ice cream shop, a
     supermarket, a hotel and six railway stops all called "Sagrada Família",
     so on that triple the whole lot collapsed into whichever Photon returned
     first - the ice cream shop - and the basilica was never offered at all.
  2. **`extent` is the landmark signal.** Photon returns one for a mapped AREA
     (an OSM way or relation) and nothing for a point, and that is the only
     field in the response that separates a landmark from the things named
     after it: the basilica, the Eiffel Tower and the Louvre all carry one
     while the shops and bus stops sharing their names do not. Worth 80 points,
     as a BONUS and never a filter, because teamLab Planets is a bare node.
- **The position weight had to come DOWN from the hotel picker's.** This picker
  asks for 15 rows against 12 and spans many classes, so at 25 a position the
  positional spread swamped city, class and area alike (three Sagrada
  candidates tied on 440). Swept over nine cached live payloads: 20 puts an ice
  cream shop above the basilica, 6 and 10 let a same-named different restaurant
  overtake the real second Kyubey, and **14** puts the right answer first in all
  nine while still letting Photon break same-class ties. Re-run that sweep
  before touching any of these constants.
- **The class list is evidence-driven, and two omissions were product bugs.**
  Swept over 24 realistic live queries and counted every class the allowlist
  dropped: `railway:stop` led at 43 occurrences and made "Amsterdam Centraal"
  answer an EMPTY dropdown, because all fifteen rows Photon returned were the
  track node rather than the station; `water:lake` was next and dropped Lake
  Bled, Lake Como and Loch Ness, each of which the service returned at position
  0. Both are now named. Everything else the sweep dropped is correctly dropped
  (lodging, subway entrances and platforms, villages and suburbs, parking,
  dentists, police stations).
- **Dedup on the LABEL, not the raw tag.** `station`, `halt` and `stop` all
  render "Station", so keying the dedup on the tag put two rows reading exactly
  "Tsukiji  Station" side by side. Two rows a traveller cannot tell apart are
  one row; two rows they can (the basilica and the ice cream shop) are two.
- **A pill may generalise but never upgrade.** `beach_resort` reads "Beach
  resort" rather than "Beach" and `aerialway:station` reads "Cable car station"
  rather than "Cable car", because the pill is our wording for somebody else's
  tag and a traveller reading "Beach" would expect sand.
- **City context is load-bearing, and it works two different ways.** Measured
  on live payloads: the lat/lon bias (sent only when the geocode cache knows the
  typed city) is the dominant lever - "Hard Rock Cafe" biased to Rome answers
  Rome, biased to Amsterdam answers Amsterdam. When the cache is cold no bias is
  sent and only the city-name bonus can reorder what came back; that still moved
  6 of 8 test queries, each to the right answer. It cannot promote a row Photon
  did not return at all, which is the honest ceiling.
- **15 asked for, 8 shown.** Rows are dropped AFTER the response, so the fetch
  limit has to exceed the display cap or a noisy query returns two rows.
- **Lodging is excluded from the venue picker on purpose** - it has its own field
  and its own type - and so are cities, towns and villages, which belong in the
  Place field. A `place:square` or `place:island` IS a stop and is allowed.
- **One combobox on `#inTitle`, not two.** Two would bind two sets of listeners
  to one input and open two popups. Which list it offers is decided per search
  (the type switches under an open form), and each row carries `src` so a pick
  landing after a type switch is still handled by the code that fetched it.
- **A venue pick fires NO Google Places call**, unlike a hotel pick. Activities
  outnumber stays several to one, so the hotel pick's one-rating-on-commit does
  not generalise; the row gets its rating from the itinerary's own
  IntersectionObserver queue like every other row. This round adds zero billable
  requests. Filling `location` more often does not add demand either, because
  `itemMapsQuery` already derived a query from the title alone.

### Rejected this round, with the reason

- **Destination currency for a new trip.** The trip currency is the one the
  traveller THINKS in, which is normally home, not destination; per-item
  currencies with conversion already handle spending abroad. Inferring it would
  be wrong more often than right and would silently relabel money.
- **Per-item timezones (the TripIt mechanic).** Genuinely the biggest missing
  convenience a competitor has, and bundleable offline from timezone polygons.
  Rejected as a data-model change wearing an automation costume: this app's
  times are deliberately floating local times (the ICS builder writes them that
  way, and "a flight may land the same day at an earlier local time" is a
  documented feature). Worth doing on purpose, not as a side effect.
- **One-click "optimize this day's route".** Wanderlog and Roadtrippers both
  have it and `shortestRoute` already exists here. It does not fit the data
  model: rows are ordered by their own clock times and the manual `order` field
  only breaks TIES, so reordering geographically would mean rewriting times the
  traveller chose. Deferred, not dismissed.
- **Writing `mapsQuery` on a venue pick.** `itemMapsQuery` already derives
  "<title> <city>", which is the same string; writing it would freeze a field
  the form does not own and add a share/export decision for no gain.
- **A category label stored on the item.** The pill is useful while choosing and
  useless afterwards; storing it would mean a new field in export, share, CSV,
  ICS and repairDb for a word the title usually already says.
- **Prefilling the To airport on a new flight** (only From is filled). Guessing
  the destination would compose a whole title from a guess; guessing the origin
  only fills a field and writes nothing.
- **Overpass, Foursquare, Geoapify, LocationIQ and friends** for POI search: the
  first on its own usage policy, the rest because a key that can be exhausted
  or billed is a bill waiting to happen. Photon was already approved, already in
  the CSP and already this app's venue-coordinate source, so the strongest
  option was also the one that adds no new dependency at all.

## Dialogs reopen at the top (2026-08-18)

Reported against Add item: scroll down inside it, close it, open it again and it
came back exactly where it was left, halfway down a form that is supposed to be
fresh.

- **Root cause is DOM reuse, not the dialog.** Every overlay is markup that
  already exists and is toggled with a class (`.overlay` display:none,
  `.overlay.open` display:flex). Nothing is recreated, and a scroll container
  keeps its offset across that toggle, so the browser hands the old position
  back on the next open. It applies to all twelve overlays equally, which is why
  the fix is one call in `openOverlay` and not twelve.
- **TWO containers hold an offset per dialog, not one.** `.m-body` is the
  modal's own scroller AND `.overlay` itself scrolls when the modal is taller
  than the viewport (measured: 1043px on `.m-body` and 32px on the overlay for
  Add item at 900x620). A fix that reset only `.m-body` would have left every
  tall dialog ~30px down. Nested ones exist too (`#importBookingResult`), so
  `resetScrollWithin` resets whatever is ACTUALLY scrolled rather than a list of
  selectors that would have to be kept in step with the CSS.
- **Reset AFTER `.open` is added.** A display:none element has no layout: the
  write is dropped and the retained offset comes back with the paint.
- **Read all offsets, then write.** Reading `scrollTop` flushes layout, so
  interleaving reads and writes would flush once per element.
- **No frame is ever painted at the old offset**, verified rather than assumed:
  the value reads 0 in the same task that opens the dialog and 0 again on the
  next animation frame. Nothing in this app's CSS sets `scroll-behavior`, so
  there is no smooth-scroll to animate either.
- **The trip menu is a popover, not a modal, and needed its own call.** Below
  560px the panel is capped and scrollable (see the media query) and it is
  toggled rather than rebuilt, so it had the identical defect: scrolled to 260,
  reopened at 260.
- **Two scroll positions are intentional and are deliberately NOT touched**,
  both verified from the code rather than assumed: the assistant thread pins
  itself to the bottom (`scrollMessages`) and lives in an `<aside>` panel, not
  an overlay, so `resetScrollWithin` cannot reach it; and the trip SEARCH panel
  keeps its query on purpose ("the query survives a close so you can pick a
  second result"), with results rebuilt through `innerHTML`, which resets that
  scroller by construction.
- **The page behind does not move**, checked because a body-scroll lock is the
  classic way to break it: 300 before, 300 while open, 300 after. `body.tp-modal-open`
  sets `overflow: hidden` on the BODY while `html` is the scrolling element, and
  measured in isolation that combination preserves the offset.

Probe traps this round minted, both of which produced convincing false results:
- **A hidden overlay reports every scrollTop as 0.** Two draft checks "passed"
  or "failed" for that reason alone: one clicked a toolbar button while a dialog
  covered it, so the click hit the backdrop and dismissed the dialog being
  measured. Any assertion about a dialog's scroll must also assert it is OPEN.
- **`clickSel` calls `scrollIntoView` before clicking**, which moves the PAGE.
  An early reading of "opening a modal scrolls the page to the top" was entirely
  that: driving the same flow with the `n` shortcut, which scrolls nothing,
  showed the page never moves.
- **Keyboard shortcuts are dead while a dialog is open** (the keydown handler
  returns early once `topOverlay()` is truthy), and the app has no
  overlay-over-overlay path at all today: every `confirmDialog` call comes from
  the board or the assistant panel, never from inside an open dialog. A test
  that stacks two overlays is testing something the product cannot do.

## Decisions from the 2026-08-13 audit round

- Assistant replies land only in the thread of the trip that asked
  (`handleAssistantReply` guards on trip id; history is keyed by trip id so
  nothing is lost).
- Rejected feature ideas, on purpose: a "trip readiness" dashboard (the
  warnings panel + Progress chip already answer it; a second surface would
  dilute both), a today-view (trip-in-progress mode + Up next chip cover it),
  a light theme (site rule), calendar-grid visualization (Days view is that).
  The app is feature-saturated; additions need a traveler problem the
  existing surfaces demonstrably fail.
- The geocode cache (`trip-planner:geo:v3`) is capped at 500 entries,
  oldest-inserted evicted first (entries carry no timestamp; do not add one
  without bumping the key version).

## The example library is the app's shop window AND its fixture

- `SAMPLE_TRIPS` in trip-logic.js is not decoration. Every template is
  asserted over in `trip-logic.test.js`: no uncovered nights, no collisions,
  no continuity gaps, no rotting into the past, a mapsQuery on every venue,
  and the six fixture features (estimate, foreign currency, long details,
  untimed row, cancelled row, `local` leg) present in each one. A template
  that renders a warning is a bug in the first thing a new visitor sees.
- **The library used to assume every example was a TWO-city trip.** The
  30-day `usa` template (added 2026-08-17) broke that assumption and the two
  places it was written down were both in the tests, not the app:
  `assert.equal(stays.length, 2)` in the intercity-leg test, and
  `Math.max(...lengths) === 14` in the shape test. Both were generalised
  (per-hop connectivity, 7 to 30 days) rather than special-cased. **The app
  code needed no change at all** - `coverageGaps`, `transportGaps`,
  `tripStats`, the Days grid and the Timeline stay-grouping all handled 18
  stays, 17 legs and 161 items on the first run. `MAX_TRIP_DAYS` is 400, so
  nothing near a month is capped.
- Each template also declares a DENSITY the suite measures day by day
  (`sparse | moderate | relaxed | packed | split | road`). `road` is the
  road-trip shape: no blank days (the driving is the day), more driving days
  than not, and a dedicated test asserting that a leg scheduled for six hours
  or more carries at most five other things AND at least one stop located in
  neither endpoint city. That last assertion is the one worth keeping: "drive
  eight hours, then do six attractions" is the failure mode an itinerary
  falls into, and it reads as a bug rather than an ambitious day.
- **Ambiguous US place names must carry their state in `location`, not just
  in `mapsQuery`.** `location` is what `geocode()` hands raw to Nominatim, so
  `Clarksdale`, `Lafayette` and `Cambria` are stored as `Clarksdale,
  Mississippi` and so on. The stay-to-stay connectivity test compares leg
  titles to stay locations verbatim, so the legs read `Memphis to Clarksdale,
  Mississippi` - clunky, and correct.
- **Map-view cost scales with DISTINCT locations, not items.** The USA
  example names 40 of them, and `pumpGeo` is a serialized 1.1s queue, so the
  first Map render takes about 45 seconds behind its "Locating places: n of
  40" progress line (cached thereafter, and the Map is not the default view).
  Every other template names roughly a dozen. This is the honest cost of a
  road trip that stops in Luling, Yermo and Oro Grande; do not "fix" it by
  stripping the roadside stops of their `location`, which is what puts them
  on the map at all.
- **A 30-day example lands between the two share-link thresholds**, which is
  the useful thing about it: `slimTripForShare` + deflate + base64url puts it
  at roughly 20,000 URL characters, under the 30,000 hard stop that refuses
  and points at JSON export, over the 8,000 advisory that warns the link may
  be truncated by a chat app. So the library now contains a trip that
  exercises the warning path, which nothing under 14 days did (Japan, the
  next biggest, is about 3,300).
- Screenshot harness caveat: the iframe probe runs under
  `--virtual-time-budget`, which collapses timers but does NOT advance real
  network time, so the Map view stalls partway through the geocode queue no
  matter how large `--wait-ms` is. Verify the Map with the CDP browser suite
  (`npm run test:trip-planner:e2e`), not with screenshot.sh.

## WCAG AA contrast decisions (2026-08-15 round, was defect 28)

- Days view had 32 axe `color-contrast` serious violations, all traced to
  four causes; the fixes are token-level, so keep them in mind before
  re-darkening anything:
  - `--accent` is `#5d95ff` (was `#4f8cff`, which measured 4.41:1 on the
    accent-soft chip surface). `--accent-soft` carries the matching rgb.
  - `--purple` is `#b8a3fc` (was `#a78bfa`, 4.09:1 as `.dc-tag` text on
    purple-soft over `--bg-raised`). `--purple-soft` matches.
  - `.dc-daynum small` carries NO opacity (0.75 pulled the accent under
    4.5:1), and `.dc-daynum b` pins `color: inherit` because main.css paints
    every `strong, b` `#555555` (1.9:1 here) - the same class of counter-pin
    the leaflet popup and assistant prose already carry.
  - `.dc-event.is-cancelled .dc-item` carries NO blanket opacity (0.82
    multiplied into every text colour inside: title 4.44:1, description
    3.79:1, Maps label 3.9:1, CANCELLED tag 3.65:1). The faded reading now
    comes only from the explicit colour steps (line-through --text-dim
    title, 0.62 `.dc-facts` fade whose base is bright --text, gray tag).
- The a11y browser suite scans the Days view with the example trip loaded
  and FAILS on any serious/critical violation (its quarantine entry was
  removed); a new sub-4.5:1 token combination will fail CI-adjacent runs,
  not just look dim.

## The 2026-08-19 exploratory QA round (TP-01..TP-23)

A black-box pass: the app was used as a first-time traveller would, and the
source only opened once something had been reproduced. Twenty-one findings
reached implementation. What is worth keeping from it:

**Three findings were the SAME root cause, and it was not the obvious one.**
TP-02 (a day labelled with the wrong city), TP-03 (hotel search offering
Sarajevo for a Rome trip) and TP-21 (a GPX export that needed the Map view
opened first) all came from one thing: **the geocode cache was only ever filled
as a side effect of rendering the Map**. Every consumer that wanted coordinates
either got them by luck or silently degraded:

- `pickerCityBias()` already passed `lat`/`lon` to Photon. The bias was never
  broken; the cache it read was empty, so it passed nothing. It now warms the
  ONE city the form is about (debounced, skipped when cached or already missed),
  which is a single request on a deliberate action.
- The GPX export read `geoCache` directly and shipped whatever happened to be
  in it. It now resolves what it needs through the same shared, rate-limited
  queue, with a progress toast.
- `dayMorningCity` gated its travel-origin rung on a cache-only probe, so on a
  cold cache it fell through to whatever activity sat on the day. See below.

The lesson for the next round: when a feature "works sometimes", check whether
it depends on a cache another view happens to fill. Nominatim's 1 req/sec
policy is why nothing warms speculatively, and that constraint is what pushed
the geocoding into one view in the first place.

**TP-02: the gate was load-bearing and had to survive the fix.** The obvious
fix - trust any parsed travel origin - breaks a real, tested safeguard:
`transport` items titled "Return to hotel" and "Travel to Shibuya" are
assistant-contract phrasings, and a naive split names the day "Return", then
fetches that non-place's weather. The gate stays. What was added is a SECOND
way to say yes: a parenthesised place code ("New York (JFK) to Paris (CDG)")
is proof the half is a place, available offline and before any geocode. Junk
titles carry no code, so they are still refused, and the day label no longer
depends on cache warmth. An `arrival` rung was also added between
travel-origin and location: before it, the day you actually LAND had no city,
no weather and no assistant context at all.

**TP-01: "Set currency" was a relabel, and that is a data-loss bug.** It wrote
`costCurrency` and left the number alone, so $480 became €480, a trip total
moved by hundreds with no confirmation, and the source currency of every
mixed-currency item was overwritten. It is now a CONVERSION through the same
`convertAmount` every total uses, planned in full before anything is written
(a half-converted selection is the same bug in a new shape) and confirmed with
the count, the target and anything that cannot be converted. Worth knowing:
**the undo stack is memory-only and is empty after a reload**, which is what
turned this from recoverable into permanent. Any future unconfirmed bulk write
inherits that same exposure.

**TP-04 / TP-07: currency has to have ONE meaning per number.** Sample costs
took the trip's currency, so the same literal `310` meant dollars in a USD trip
and yen in a JPY one (a ¥310 international flight next to a ¥3,800 museum
ticket that really was yen). Samples now carry `SAMPLE_BASE_CURRENCY` and the
app's own conversion does the rest. Separately, the hardcoded picker list had
drifted from the provider: BGN sat there after the ECB stopped publishing it,
so a 100 BGN cost added exactly nothing to every total. The selectable set is
now read from the live rate payload, with the checked-in list as the floor, and
three sample pins in currencies the provider does not quote (MAD, PEN, VND)
were re-authored. `tests/qa-2026-08-19.test.js` asserts every example stays
inside the provider's set - that is the test that stops this drifting again.

**TP-05: do not replace one fake certainty with another.** London to Dublin
offered a 5h 31m train across the Irish Sea because "is this an island leg" was
a regex over the PLACE NAME (`koh`, `samui`, `beach`), which never fires for
Dublin. It is now decided from the endpoints' country codes, which the geocoder
already records. Two things were deliberately NOT done: no routing service was
added (there is no free one that fits the app's constraints), and no country
adjacency dataset either. `NO_LAND_LINK` lists only countries with no land
border AND no fixed link, which is why GB is absent (Channel Tunnel) and
Singapore is absent (Johor causeway) - a naive "island nation" rule would have
deleted the Eurostar. Unknown country codes change nothing, because
unverifiable is not the same as "crosses water". Where availability still
cannot be established the CARD says so, since that is what gets read before any
footnote.

**The bias fix needed a second round, and the PROD smoke is what caught it.**
Warming the city (above) made `pickerCityBias` able to send coordinates, and
the e2e passed - because in that suite the geocoder answers instantly, so the
city was already cached by the time a hotel name was typed and the very first
lookup carried the bias. Against a real network the order is the other way
round: the first keystrokes go out unbiased while the city is still resolving,
and both suggestion caches keyed on `query|city` alone. The cold answer was
therefore stored under the key a later biased lookup would hit, and Rome kept
being offered Sarajevo no matter how warm the cache got. The key now carries
the bias itself (`biasKey`), so a cold answer can never satisfy a warm lookup.
The lesson: a cache keyed on the INPUTS a request is built from has to include
every input, and an async-warmed one is an input that changes under you.

**Two of the report's own findings were partly wrong, and the probes were why.**
Worth repeating because both are easy to make again:

- TP-10 claimed overlapping stays produced "no warning sentence". They always
  had one - `computeIssues` gives every issue a `text` - but the panel is a
  `<details>`, collapsed by default, and the probe read `document.body.innerText`,
  which skips collapsed `<details>` content. The real defect was narrower: the
  ROW carried colour only. It now carries a marker whose accessible name IS the
  warning sentence.
- TP-14 claimed the weather chip had no tooltip. It has one, on the chip
  CONTAINER; the probe checked `.dc-chip-temp`. The real defect was that a
  tooltip is hover-only and a phone cannot show one, so the chip now wears a
  visible `Typical` pill, the twin of the existing `Forecast` pill.

**TP-13's root cause was cancelled items, not notes.** The Items chip excludes
cancelled rows (`tripStats` filters them) while selection includes them, so a
trip could read "41 items" and "42 selected" at once, and then offer to delete
42. The chip now discloses what it leaves out.

**Reproductions that came back clean, and were dropped rather than "fixed":**
the `setItem`/`removeItem` keys visible in `Object.keys(localStorage)` are the
sync layer's own monkeypatch, not stored data (`localStorage.length` is
correct); the venue coordinate cache is properly qualified (`"colosseum rome"`,
not `"colosseum"`); assistant-added items keep `estCost` through an edit; and
missing ratings on localhost are the unconfigured Places key (503), not a
product defect - production returns them correctly.

## Testing

- Three layers, keep each test at the lowest one that can catch its bug:
  `npm run test:trip-planner` (node:test against trip-logic.js - all math,
  parsing, validation, history semantics), the function suites (from
  `netlify/functions` or root `npm test`), and `npm run test:trip-planner:e2e`
  (browser E2E under `e2e/`, below). Never move a pure-logic assertion into
  E2E just because E2E exists.
- When touching an item field, walk the full pathway list: render (both
  views), edit modal round-trip, duplicate, undo, JSON/CSV/ICS export,
  share link, sync, filters, search, AI proposals, templates, repairDb.

## Browser E2E suite (e2e/, added 2026-08-13)

- **Framework: the repo's own zero-dependency CDP harness** (`tests/browser/`),
  NOT Playwright/Cypress. Deliberate: the repo rule is zero npm deps and no
  build step, the harness already runs in CI on every PR
  (`.github/workflows/browser-tests.yml` -> `npm run test:browser`), and one
  browser-testing stack is enough to maintain. The runner gained repo-relative
  suite paths, `--only=<substring>` and `--headed`; the driver gained
  `evalAsync`, `waitForExpr`, key modifiers, `interceptNetwork` (CDP Fetch),
  `setOffline`, and service-worker target attachment. Suites live with the app
  (`e2e/core|trips-sync|share|views|ui|assistant|pwa.mjs` + `helpers.mjs`) and
  are registered in `tests/browser/run.mjs` SUITES. The assistant suite drives
  the Tier 1 paste flow, which reaches the same extract -> validate ->
  renderProposals -> refreshDistances path a live reply takes with no network
  and no key, and reads guided-vs-free-form mode off the intercepted POST body.
- **State seeding**: app state is closure-scoped, so `openApp()` seeds
  `trip-planner:v1` and reloads (never pokes internal state). Fixtures build
  deterministic dbs with dates relative to today (`iso(offset)`), ids
  `e2e-NNN` (call `freshIds()` per block). Every mutation assertion reads
  BOTH the DOM and `localStorage` back.
- **Network rules**: every external provider is refused per-page by default
  (`EXTERNAL_HOSTS` in cdp.mjs) so runs are deterministic and offline-safe;
  the app is expected to degrade cleanly. A test needing a canned success /
  failure / timeout passes its own `net` rules to `openApp`. Do not mock
  same-origin requests except through the offline path.
- **Share links** are built in-page with the app's own primitives
  (`TripLogic.slimTripForShare` + CompressionStream('deflate') +
  `TripLogic.bytesToBase64url`) - headless Chrome cannot grant clipboard, so
  never drive `shareTrip()` itself.
- **Waiting discipline**: suites wait on the real observable condition
  (`waitForExpr` over DOM or localStorage) rather than fixed sleeps. The only
  legitimate fixed waits are on NEGATIVE claims (a shortcut that must stay
  inert, a dropdown that must not open, a request that must not fire), where
  there is nothing to wait for; each carries a comment saying so. When a wait
  cannot key on the asserted thing itself (e.g. "the chip does NOT change"),
  key it on a sibling effect that proves the action landed (the filtered
  board), then read the claim.
- **Traps that produced convincing false failures while building this** (all
  are handled in helpers - keep them handled):
  - **`closePage` takes `(cdpPort, session)`; called with one argument it is
    a SILENT no-op** (both internal statements throw and are swallowed). The
    assistant suite did exactly that at every call site, leaking all of its
    tabs; the leaked pages' storage listeners then reacted to later blocks'
    seeds, which surfaced as two intermittent "distance chip is empty"
    failures in the 2b origin checks (diagnosed 2026-08-15: harness bug, not
    a product bug - three consecutive green runs after the fix). Close every
    page in a `finally`, with the port.
  - `Page.navigate` from the app to the same URL with a different fragment is
    a HASH CHANGE, not a reload: share-link entry and deep-link boots silently
    do not run. Use `gotoHard()` (bounces through about:blank).
  - A leaked tab poisons later blocks: same profile = same localStorage, and
    its `storage` listener reacts to (and its `ensureTrip` can even write
    over) the next block's seeds. Always close pages in `finally`.
  - Timeline rows inside a stay are collapsed by default and unreachable;
    `expandTimeline()` first. While a FILTER is on, groups force-open, and a
    stay whose child matches keeps a wrapper row - assert on which items are
    visible, not on bare row counts.
  - Chrome's `innerText` applies `text-transform`: "Check in" reads back as
    "CHECK IN". Match case-insensitively.
  - Double-submit is reproduced with two synchronous `form.requestSubmit()`
    calls - same handler a double-click reaches, but deterministic.
  - **`openApp`'s seed can be clobbered by the app it is seeding.** The seed
    must be written on the app's origin, so a page is already running while we
    clear and re-write under it, and `ensureTrip` then creates an empty default
    trip and saves it AFTER our `setItem`. A suite whose first assertion needs
    an ITEM fails; one that only counts rendered cards passes, which is what
    made it intermittent and very hard to read. `openApp` now verifies the item
    count the rebooted app actually holds and re-seeds up to three times.
  - **`waitReady` cannot tell a reloaded page from the one already open**:
    `__TP_BUILD` and `#board` are equally true of both. Anything that must be
    read AT BOOT (the geocode and venue caches are read into closure state
    exactly once) therefore cannot be warmed by write-then-reload and verified
    by reading localStorage back - the read-back passes on the stale page too.
    Pass it through `openApp`'s `stores` option instead, which lands before the
    app's first load; compute cache keys in Node with the app's own
    `placeCacheKey` so a fixture key can never drift from what the app writes.
  - Offline must be emulated on the page target AND the service-worker
    target(s); page-only lets the worker fetch from the network.
- **`e2e/places.mjs`** covers the ratings subsystem: fanout on a 50-venue trip,
  duplicate-freedom across renders/scrolls/view switches, a free view switch,
  travel legs never billed, a 429 that does not storm, partial responses, and
  trip switching. It mocks tp-places at the network layer, so a green run costs
  $0.00 and never touches the real endpoint. Counts are scoped per block (see
  the leaked-storage trap in the Places section).
- **What stays out of E2E**: activate-event cache eviction and update-toast
  messaging (tests/sw-activate.test.mjs, driving a real redeploy is flaky),
  cross-DEVICE sync (whole-key LWW via Firestore is a structural limit, see
  "Sync model"; E2E covers the same-browser two-tab reconciliation and the
  stale-dialog guards, which are the parts testable locally), and anything
  computable (trip-logic tests own it).
- Failure artifacts: one screenshot per failing check in
  `.screenshots/e2e-trip-planner/` (gitignored), path printed in the result
  detail. Green runs write nothing.
- **Rate-fetch failure sequencing (fixed 2026-08-15, was defect 19)**: a
  failed exchange-rate fetch used to leave the stale "Fetching exchange
  rates..." note on screen because `ensureRates()` rendered from `.catch()`
  while `ratesFetching` was still true (the `.finally()` that cleared the
  flag ran after that render). The flag now clears via a `settle()` helper
  BEFORE every render in both the success and failure paths, so the failed
  fetch itself repaints the honest "Could not fetch..." note + Retry. A
  shaped-but-invalid response (no `base`/`rates`) now also flips
  `ratesFailed` and renders instead of silently doing nothing. `tp-views T:
  ... unprompted` is a plain assertion on this; if it fails again, the flag
  ordering regressed.
- The booking-import dialog's proposal cards carry the EMPTY `.ap-dist`
  scaffold span every card gets (`proposalDistHtml`); the paint pass only
  fills chips under `#assistMessages`. Assertions about "no chips in the
  dialog" must therefore check painted TEXT, not element existence.
