# Trip Planner - engineering findings

Living document. State the best current understanding; rewrite rather than
append. Read together with `README.md` (what the app is) - this file is the
why, the traps, and the invariants.

## The page carries its own explanation now (`.app-about`)

Measured on production before 2026-09-04, this page rendered almost nothing but
interface labels to a crawler, because the differentiators that make someone choose this over Wanderlog or TripIt - no account, nothing uploaded, night coverage, collision and gap warnings - all existed only inside `hidden` modals, which Google discounts and a first-time visitor never opens. Nothing on it said what the app was for,
so nothing could match a search for one. It now carries a 289-word
`.app-about` block below the app UI: shared styling lives in
`assets/css/main.css` and inherits colour from the app, so the block picks up
this app's palette rather than imposing one.

The block belongs on the app page itself, not on a separate "about" URL beside
it - that shape is a doorway page and it splits link equity across two URLs.
A first draft of that copy over-promised against `privacy.html`, which is binding: it implied nothing ever leaves the device. The assistant and the venue-ratings lookup DO send trip contents to Google, and the block now says so. Check new marketing copy against privacy.html the way code is checked against it.

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
  currency stamps, and since 2026-08-22 every string/clock/enum field a
  renderer reads without checking: see `repairItemFields`). New fields must be tolerated absent forever; never write
  a migration that rewrites items destructively.
- **A shared view owns the screen, not the data.** Entering shared mode
  replaces `db` with the stranger's trip and `save()` returns false, and both
  reconcile listeners stand down so a remote change cannot overwrite what the
  visitor is reading. It therefore holds NO copy of the visitor's own db:
  `importSharedTrip` re-reads storage (`loadDb` + `repairDb` + history reset,
  the same handling a remote merge gets) and pushes the imported trip onto
  THAT. The old `realDb` snapshot was taken on entry and written back on
  import, so anything saved meanwhile - another tab, or this device's own sync
  applying a merge - was published over and gone, with nothing to undo from in
  the tab that made the edit. Never reintroduce a parked copy of the db;
  storage is the owner for exactly as long as the view is not.
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
- **Google Places legal lines** (re-derived field by field against the LIVE
  terms 2026-09-06; earlier checks 2026-07-20 and 2026-08-17 agreed). Place IDs
  cacheable indefinitely, lat/lon cacheable for 30 consecutive CALENDAR days -
  held as **29 x 24h** (`trip-planner:venuegeo:v2` cap 300, and the item's own
  `place` record), because a full 30 x 24h from any start time after midnight
  spans thirty-ONE dates and is over the line; see "The two 30s" below - and
  **nothing else at all**: names, ratings, review counts,
  addresses, opening hours, types and the Maps URI are never stored. The
  server's rating layer was found still persisting `pd:` details blobs (unread,
  unbounded); the CODE was removed 2026-08-13 but 201 stale `pd:` blobs were
  still sitting in the production store on 2026-08-17 and had to be purged
  separately. Removing a cache is two jobs: the writer and the data.
  The sources, quoted, so a future session does not have to re-derive them:
  - Maps Platform ToS 3.2.3(b): "Customer will not cache Google Maps Content
    except as expressly permitted under the Maps Service Specific Terms."
  - Maps Platform ToS 3.2.3(a): "Customer will not: (i) pre-fetch, index,
    store, reshare, or rehost Google Maps Content outside the services; ...
    (iii) copy and save business names, addresses, or user reviews". Names and
    addresses are named OUTRIGHT here, not merely left out of an exception.
  - Service Specific Terms 14.3 (Places API, Legacy and New): "Customer may
    temporarily cache latitude and longitude values from the Places API for up
    to 30 consecutive calendar days, after which Customer must delete the
    cached latitude and longitude values." Section 14 grants no other caching
    permission of any kind.
  - General Service Terms A.3 (Google ID Caching): place_id may be cached; the
    Places policies page says so too ("You can therefore store place ID values
    indefinitely").
  **The omission is deliberate, and SST 16.2 is the proof.** One section past
  Places, the Pollen API gets a TABLE of per-content caching periods (365 days
  for today's forecast, 24 hours for forecasts and heatmaps). Google writes
  field-level caching grants when it means them; for Places it wrote one, and
  it covers lat/lng. So do not re-litigate this as a product trade-off - the
  answer is not a TTL, and the sweet spot people reach for (days) does not
  exist. `RATING_TTL_MS` is 0 and stays 0. Holding a response in memory to
  paint the elements that asked for it is not caching (the DOM holds the same
  rating); writing it anywhere that outlives the request is.
  **What this leaves free to optimise** is everything that is NOT Google Maps
  Content: our own query string, our own verdict about it, and the place ID.
  That is exactly what the rejection tombstone stores (below), and it is why
  its TTL is an engineering choice while the two above are not.

## The billed call: one per PLACE, and never twice for the same refusal

Two measured defects, both found on 2026-09-06 by driving the real pipeline
(`resolveQueries` with injected spies) rather than by reading it. Both were pure
waste: neither changed a single answer, both charged for it.

**1. One venue, one place, three bills.** A day plan names the same venue in
more than one voice - "The Mango Garden", "Mango Garden restaurant", "The Mango
Garden, Ko Phi Phi". The client dedupes on ITS key before sending, which catches
the same string twice and misses this entirely: three keys, three free ID
searches, all three resolving to one place ID, and then **three** Place Details
calls at the Enterprise SKU. $0.06 for one rating.

`resolveQueries` now shares one in-flight Details promise per place ID for the
length of the request. The joiners still run their own gates over the shared
response - two queries can resolve to one place and be judged differently,
because the gates read the query text and the meal slot, not just the place. It
caches nothing and stores nothing: it lives exactly as long as the response
object it feeds.

**The claim moved with it.** The budget slot used to be taken before the free ID
search, i.e. before anyone knew whether the query would need one. Two spellings
took two slots to make one call, and in a partially granted batch the second
slot came out of a DIFFERENT venue that then had to answer `unavailable`. The
claim now sits against the billed call, so a slot means exactly one Place
Details request. The price is that a batch which runs out of budget mid-way
still finishes its free searches - the unlimited $0.00 Essentials SKU - and a
batch granted nothing never reaches the pipeline at all (the handler 429s first).

**2. A refused candidate was re-bought on every request, forever.** This is the
worse one. When a candidate was rejected by a gate, the pipeline cached the
REJECTED place ID and nothing else. So the next request skipped the free search,
went straight to Place Details for a candidate we already knew we would refuse,
paid $0.02, and answered `no_match` again - once per page load, for the thirty
days of the ID TTL. Measured: one wrong-area venue, one billed call per request,
with no expiry that would ever stop it.

The entry now also carries the verdict: `{ placeId, at, rejected: [...] }`, where
each rejection is `{ reason, sig, at }`. Nothing in that is Google Maps Content -
the key is our own query, the reason is our own word, and the place ID is the one
value SST A.3 lets us keep indefinitely - so **the TTL here is an engineering
choice, not a legal one**, which is the opposite of the two TTLs above it.

Three things make a seven-day window safe rather than merely cheap:

- **The signature.** `idCacheKey` carries the query and a COARSE area (city, or
  the point to ~11 km). The gates also read the meal slot and the exact
  point/radius, which it does not. A verdict is only replayed when those match,
  so a venue refused as the wrong KIND for breakfast does not answer for a
  traveller who named no meal, and a re-anchored day is re-judged.
- **`JUDGE_VERSION`, and a test that will not let you forget it.** The version
  rides in the signature, so changing a gate (`matchConfidence`, `verifyArea`,
  `typeMismatch`, `judge`) retires every stored verdict on deploy. **Bump it
  whenever a gate changes its mind.** Without it the choice would be between
  paying to re-learn the same refusal every day and shipping a gate fix that
  takes a week to reach a traveller - and the Ko Phi Phi round is exactly the
  case that matters, where a bad anchor made the gates refuse every correct
  venue in a region.
  That used to rest on one human remembering, and a forgotten bump is SILENT:
  no test fails, nothing looks wrong, and travellers keep seeing a refusal the
  current code would not reach. `tests/tp-places-judge-version.test.mjs` now
  hashes `tp-places-match.mjs` plus `judge()` (comment-only lines stripped, so
  prose churn is free) and fails with instructions if either moves. Verified
  2026-09-07 to fail on a real gate change (`AREA_MAX_KM` 150 -> 200, and a
  reason string inside `judge`) and to pass on pure comment edits. Scope is
  deliberately narrow: the rest of the lookup module is caching and budget work
  that changes for reasons a verdict does not care about, and including it would
  make the check fail so often that people would learn to ignore it.
- **Three signatures per entry, newest first.** One slot thrashed: the same
  restaurant arrives as a food candidate carrying a meal slot and as a plain row
  carrying none, and the two overwrote each other turn by turn, so every other
  request paid to reach a refusal it had already reached.

`unrated` is deliberately NOT tombstoned. It is a successful resolution that
happens to have no star, it carries the identity, coordinates and hours the
client needs, and replaying it as a bare tombstone would blind the rows that
depend on them. It is also the one negative result whose content is genuinely
Google's ("this place has no rating") rather than ours, so the compliance
argument for storing it is weaker than for a gate verdict, and the saving is
small.

**What did NOT change, having been checked:** the field mask is already optimal
(every field in it below the Enterprise tier the rating forces rides free, so
trimming `displayName` or `types` would save exactly $0.00); the client's session
cache is already correct on stale-on-error (an `unavailable` result is never
written, so a previously painted rating survives a later Google failure, and a
failed first lookup fabricates nothing); and no cross-request rating reuse is
available at any price, because the terms forbid the storage it would need.

## The two 30s, and why only one of them is 30

Two numbers in this app were both "30 days" and they answer completely different
questions. Conflating them is how the wrong one gets changed.

**The query -> place ID mapping (`PLACE_ID_TTL_MS`, 30 days, unchanged).** Not a
storage limit - SST A.3 permits a place ID indefinitely, and the ID stamped on an
itinerary item genuinely never expires. What expires here is our INFERENCE that
a piece of free text, in an area, means that place. That stops being true in
ways a stored ID cannot notice: a different business takes the same address with
a NEW place ID, a second branch opens and the query now names it better, a venue
closes while Google keeps serving the entity, a name changes, an ambiguous query
becomes resolvable. Re-searching is the only fix for any of them.

Why not lengthen it, given Google would allow it? **Because it buys nothing.**
Measured 2026-09-06: a hot mapping and a cold one both bill exactly ONE Place
Details call on the next request. This TTL moves only the Text Search, which is
the free unlimited Essentials (IDs Only) SKU; the billed call happens either way
because a rating may not be cached. Lengthening it is a pure loss - no money
saved, a strictly wider stale-inference window. It is also 12x more often than
Google's own guidance asks (place-id docs: "Place IDs may change over time",
refresh those older than 12 months, free), so there is no compliance pressure in
the other direction either. Pinned by a test that asserts billed spend is
identical hot and cold.

**The coordinate window (`VENUE_TTL_MS` and `PLACE_RECORD_TTL_MS`, now 29 days).**
This one IS a legal limit, and it was quietly one day over. SST 14.3 grants "up
to 30 consecutive calendar DAYS". A calendar day is a date, not a 24-hour
period, and the two are not the same measurement: an entry written at 23:00 on
1 January and held a full 30 x 24h is still served at 22:59 on 31 January, by
which time it has existed on **thirty-one distinct dates**. Only an entry
written exactly at midnight stayed inside the grant. 29 x 24h is the largest
window that cannot exceed it from any start time - 1 January to 30 January is
exactly thirty dates, the whole allowance and not one date more.

The day costs nothing: these coordinates arrive free on the Places call the
ratings already pay for, so an entry expiring a day earlier is re-seeded by a
lookup that was going to happen anyway. Both stores take the same boundary, and
`tests/trip-logic.test.js` now enumerates the actual dates a window can touch
rather than trusting the arithmetic.

**The split to keep in mind:** an item's saved place keeps its `id` for ever and
loses only its `lat`/`lon` on that schedule (`normalizePlaceRecord`). Identifier
and coordinate have different rules and must never be given one lifetime.

## Sync model (and its sharp edges)

- One synced key for the whole planner (`trip-planner:v1`) plus
  `trip-planner:timefmt`, per-key last-writer-wins via `sync-system/`. There
  is NO structural merge: two devices editing different trips concurrently
  lose one device's whole edit set. Softening on the receive side: db reload,
  undo-history reset, dialogs stay open but their SAVE paths re-check the
  target still exists (`ui.editingId` for items, `ui.tripEditId` for the trip
  dialog - both added guards, keep them when adding dialogs).
- Same-device multi-tab (esp. signed out) is covered by a foreign-change
  handler (added 2026-08-13 as a raw `storage` listener) that mirrors
  remote-merge handling. The `localStorageSync` event only fires signed-in
  after a Firestore flush.
- **A foreign-change handler MUST NOT WRITE.** Since 2026-08-22 the handler
  is registered through `ShevatoTabSync.watch` (`sync-system/tab-sync.js`,
  loaded before app.js and precached by sw.js), whose contract is exactly
  that, and whose guard blocks and logs any write that slips through. The
  raw listener is kept only as the fallback when the helper did not load.
  What it cost before: tab A deleted its last trip, tab B's handler ran
  `ensureTrip()` and SAVED a fresh "My trip", that write fired `storage`
  back into A, and A's handler wiped the undo history holding the deleted
  trip. The confirm promised an undo the app could not keep whenever a second
  tab was open. `ensureTrip(persist)` now takes a flag: the observing tab
  calls `ensureTrip(false)` and renders its floor trip in memory only (the
  first real edit there saves it like any other), and `repairDb(true)` skips
  its write-back for the same reason. Pinned by `e2e/audit-2026-08.mjs`
  block A (two pages: delete the only trip in A, storage still holds exactly
  one empty floor trip, Undo in A restores it, B renders it back).
- **Trip delete keeps its documents for the undo window.** The delete no
  longer calls `deleteDocsForItem` (that made Undo hand back a trip with no
  attachments while the confirm promised a full undo). The confirm says what
  actually happens - undoable until you reload, documents included - and
  `purgeOrphanDocs()` sweeps every document whose item is in no saved trip at
  the next boot, which is the moment the undo window closes anyway. Undo also
  now SWITCHES to a trip the step brought back (`restoreSnapshot` detects the
  restored id), instead of leaving the picker on a bystander trip. Pinned by
  `e2e/audit-2026-08.mjs` block B (IndexedDB-seeded).
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
- **The owner tier reports `owner_day` / `owner_month`, not the public names.**
  Fixed 2026-09-06 after a live console 429 on shevato.com. `poolKeys` sent the
  owner tier's counters to `ownerDay`/`ownerMonth` but left the SCOPE strings
  as `global_day`/`global_month`, so the one line a rejection logs named a
  bucket that was 44 of 150 full while `ownerDay` sat at exactly 300 of 300.
  Diagnosis meant reading the usage blob by hand (`netlify blobs:get
  trip-planner-places usage`) - the same blind spot `quotaExceeded` was written
  to close. `resetAtFor` and the client's `placesRetryDelay` both learned the
  two new names; either falling through to its default would have turned a
  day-pool pause into a 15-minute retry loop.
  **Reading the blob is the fastest diagnosis** for any live 429: the counters
  are current-bucket only, so the exhausted row is visible directly.
- **The quota toast used to name the wrong allowance.** Every pause said "the
  free lookup allowance is used up" whatever refused it; on the 2026-09-06
  daily cap that was false, with 411 of the 850 monthly lookups unspent and
  ratings back the same evening. `placesPauseReason` now keys the wording on
  `status().scope`, which the queue already tracked.
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
- Snap chromium ignores `child.kill()`; a second `launch()` on the same
  debugging port silently attaches to the OLD browser with its app tabs still
  open, and those same-origin tabs write back on every storage event (which
  fakes the two-tab scenario above). Kill by port before and after every
  run: `pkill -f 'remote-debugging-port=930[2]'` (the bracket keeps the
  pattern from matching the shell that runs it), and CHECK the port is free
  (`ss -ltn | grep :<port>`) before trusting a run: a launcher that finds the
  port already bound quietly drives the stale browser instead, which shows up
  as "the seeded trip did not survive boot".
- **Chromium flags change results, so run the suites with the repo's own.**
  `--hide-scrollbars` (which the ad-hoc audit launcher passes) moves the
  backdrop-click coordinate in `tp-ui M` and made three checks fail on
  UNMODIFIED sources. When a suite fails only under a private runner, re-run
  it with `tests/browser/run.mjs`'s exact flags before believing it.
- One browser, one heavy suite at a time. Chaining two or three of the big
  suites (`views` + `ui` + `assistant`) into a single chromium reliably
  stalls it mid-run (`timeout: Runtime.evaluate`, then `ECONNREFUSED`); the
  repo runner restarts nothing, so a local sweep should relaunch the browser
  between suites.

## The 2026-08-22 site-wide audit round (fixed)

Cross-tab undo and trip-delete documents are in "Sync model" above. The rest:

- **The rendered span is the CLUSTER, never the earliest date.** `tripStats`
  used to anchor `renderEnd` on the earliest dated item, so one activity
  typed a year early became the trip: every CORRECT item was flagged "far
  outside the rest of the trip", the typo was the one item never named, and
  Days/strip rendered 400 days from it ("735 days / 734 nights"). It now
  returns `renderStart` as well, computed by `dateCluster()` (the largest run
  of items whose consecutive start dates are within `MAX_TRIP_DAYS` of each
  other; ties go to the earlier run, which is the old behaviour for two lone
  items). `start`/`end` stay honest so the issues list can still name the
  outlier, and `computeIssues` now names anything outside the cluster on
  EITHER side. Every per-day surface walks `renderStart..renderEnd`
  (`dayCards`, the night strip, the summary chips, `newItemDate`), so a lone
  typo no longer pads the view to the cap - the cap only bites when the
  cluster itself is longer than `MAX_TRIP_DAYS`. Pinned by
  `tests/audit-2026-08.test.js` (early outlier, far-future outlier, genuinely
  long trip, two-item tie) and by the two updated cap tests in
  `tests/trip-logic.test.js`.
- **`repairTrips` normalises every field a renderer calls a string method
  on.** Was: title, startDate, endDate, endTime, cost, currencies, order,
  meal, mapsQuery. A non-string `startTime` took the Timeline down with
  `t.split is not a function`, `confirmation` the same via `.trim`, and
  `location` threw uncaught out of `dayMorningCity` and left the Days view
  blank. `startTime`, `confirmation`, `location`, `details`, `costNote` and
  `bookBy` are now coerced to `''` when present and non-string (absent stays
  absent). Pinned by `e2e/audit-2026-08.mjs` block C (repairTrips lives in
  app.js, so this is a browser check by construction).
- **Island detection reads the geocoder, and the ferry has a ceiling.**
  `ISLANDISH` (Thai resort names) is joined by `ISLAND_NAMES` (islands with
  no fixed link: Santorini/Mykonos/Crete class) and by `isIslandPlace(text,
  kind)`, which also believes Nominatim's own `place=island` (`kind` is now
  recorded on each geocode hit; older cache entries lack it and fall back to
  the name lists). `FERRY_MAX_KM = 600` gates the ferry card, the ferry flag
  and the last-sailing tip, so Tokyo to Sydney (7,800 km) no longer offers a
  boat; an island leg is also flown from 150 km rather than 250 km, since
  there is no road to compete with. A rail card on a pair with no confirmed
  through line carries `unverified: true` and `routeBadges` never calls it
  Recommended (it still competes for Fastest/Cheapest on its estimate).
  `modeOptions` returns `[]` under 0.1 km, so two geocodes on the same point
  no longer produce "0.0 mi, heading north, Walk 0m"; `checkRoute` says "the
  same place" instead. Pinned by `tests/audit-2026-08.test.js`.
- **Smaller honesty fixes from the same round**, each pinned in
  `e2e/audit-2026-08.mjs`: a duplicate trip name gets a hint with a suffix
  suggestion (D); the trip dialog focuses the field it refused, like the item
  form (D); axe over the open trip menu, the assistant panel and the Route
  and Visa dialogs at 1280 and 390 is clean (E: the three preference rows
  needed a `role=menu` wrapper, `#buildTag` moved to `--text-dim`, the meal
  chips to `--text`/`--seg-on-fg`, `#summary` became a focusable labelled
  region); an unreachable geocoder on the Map view says so instead of blaming
  the traveller's place names (F); the Shift dialog clears its error on
  reopen (I); focus lands on the saved row after an Enter-save instead of
  `<body>` (J); a non-JSON 200 from the assistant reads "sent back something
  unreadable" rather than "check your connection" (K); a Frankfurter body
  whose `base` is not the currency asked for fails like a 500 with a Retry,
  instead of being stored and reported as unconvertible items (L).
- **Phone layout (same round).** At 390 the toolbar folded to one action row
  (Add item, undo/redo, More) plus the view tabs: `#selectBtn`, the four trip
  tools, the shortcuts button and the filter row live behind `#tbMoreBtn`,
  whose rows PROXY clicks to the real (hidden) controls so there is still one
  handler per action. The filter row also unfolds by itself whenever a filter
  is active, so nothing can be filtered invisibly. The toolbar is sticky
  under the 44px site header. Opening a stay on a phone opens the day groups
  inside it (one tap to a row, not two). Each is pinned in block G, which
  also asserts the first itinerary row is above the fold at 390.
- **Per-day spend.** The Days card header carries the day's confirmed
  (booked) spend in the trip currency, under Cost by type's honesty rule: an
  amount the rates cannot convert is counted out loud ("+ 1 not converted",
  amber) rather than silently dropped, and a day with no money shows nothing.
  A stay counts on its check-in day. Pinned in block H.

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

## A place is an ENTITY, not a string (2026-08-27 round)

The owner asked the assistant for three Nama-chocolate shops in Japan. What
came back:

| card | what was wrong |
| --- | --- |
| "Shopping: Royce' Chocolate (Tokyo Station)" | resolved to ROYCE' Chocolate World, New Chitose Airport, **Hokkaido**; the chip read **809 km** from Tsukiji, and the wrong POI's rating and cid link were rendered as fact |
| "Shopping: Royce' Chocolate (Kyoto Takashimaya)" | **"No rating match"** on the card, a rating on the agenda row for the same recommendation |
| "Shopping: Mary's Chocolate (Shinjuku)" | `Shopping` is not one of this app's categories; the model invented the prefix and the app rendered and stored it verbatim |

Four symptoms, **one cause with two halves**.

### Half one: the identity had no geography

`matchConfidence(query, placeName)` was the whole gate, and it is a gate about
NAMES. Run it on the actual failure:

```
matchConfidence("Royce' Chocolate Tokyo Station", "Royce' Chocolate World")
  -> { score: 0.67, confident: true }
```

That is not a bug in the function - "royce" and "chocolate" genuinely are two of
the three distinctive tokens of "Royce' Chocolate World". It is a **category
error**: a chain's name cannot answer a question about WHICH BRANCH, and every
chain on earth is this case. `findPlaceId` made it worse by asking Text Search
globally with `pageSize: 1`, so Google's answer to a chain name is its most
famous location. The client cache key was the bare query lowercased, so the
Hokkaido answer was then stored under `royce chocolate ...` for **30 days** and
served to every city.

Fixed by making the AREA part of the identity, end to end:

- `verifyArea` (lib/tp-places-match.mjs) is a SECOND mandatory gate. Coordinate
  check first (`AREA_MAX_KM` = 150 km), address/administrative-component check
  as the fallback when the trip has not geocoded its city. Both gates must pass;
  a failure is `no_match / wrong_area` and carries **no** rating, coordinates,
  hours, place ID or Maps URI.
- `AREA_MAX_KM` is deliberately generous. It is a wrong-continent gate, not a
  walking gate: Tokyo's wards span ~40 km, Greater London ~45, LA County ~120,
  and Yokohama must still count as Tokyo-area. The failures it exists for are
  809 km, 4,000 km and 12,000 km.
- The search is BIASED (`locationBias` circle) towards the expected point. That
  is a request parameter, not a field-mask entry, so the SKU and the price are
  unchanged.
- A rejected candidate earns **exactly one** retry: the city spelled into the
  query and `locationRestriction` (a rectangle Google cannot answer outside).
  The retry costs one more Place Details call and takes its own budget slot, so
  a quota-exhausted batch simply refuses instead of retrying. Two wrong answers
  end the question - unresolved beats resolved-wrongly.
- `formattedAddress` + `addressComponents` were added to `DETAILS_FIELD_MASK`.
  Both are **Place Details Essentials** fields, two tiers below the Enterprise
  tier the call already bills at, so the address rides the existing billed call
  for $0.00 - the same way `location` does. Do not add anything from
  Enterprise+Atmosphere; that WOULD move the SKU.
- Cache keys carry the area on both sides: `idCacheKey(query, area)` server-side
  (`id:<query>@<city>`), `placeCacheKey(query, area)` client-side
  (`<query>@<city>`). Same business name, two cities, two entries, two answers.

### Half two: three derivations of "which place is this"

This is what produced the Kyoto contradiction, and it is worth being precise
about because it looked like a caching bug and was not:

| surface | key it used, before |
| --- | --- |
| card rating chip + Maps link | `placeCacheKey(p.display.mapsQuery)` - the model's RAW string |
| card hours slot + distance chip | `placeCacheKey(itemMapsQuery({type,title,location,mapsQuery}))` - a DERIVED string |
| itinerary row (Timeline + Days) | `placeCacheKey(itemMapsQuery(it))` - derived again, after the accept path had rewritten the title |

Whenever those strings differed - a model that omitted `mapsQuery` on a
place-type add, a title carrying a prefix `stripTitlePrefixes` did not know
about, a `note` carrying a mapsQuery - the card and the row asked DIFFERENT
questions and got different answers. Neither was lying about the string it held.

`placeLookupFor(itemLike, ctx)` is now the only answer. It takes an item or a
proposal's fields (identical shape) plus injected, cache-only geography, and
returns `{ query, area, key }`. Every surface reads it. **Never re-derive a
place query at a call site** - that is the bug, in its general form.

### Add to trip HANDS OVER the resolution; it does not repeat it

`item.place = { id, lat, lon, at, city }`, written by `attachResolvedPlace` from
the session entry the CARD resolved. Rules that keep it honest:

- Only a **verified** entry is ever persisted (`placeRecordFrom` returns null
  otherwise). An unverified guess must not become a durable fact.
- `normalizePlaceRecord` is the persistence boundary and runs on every write,
  every read and every import (`repairDb`, the share/import sanitizer,
  `itemPlaceRecord`). It drops a record with no ID, drops coordinates past the
  29 days we hold them for (Google allows up to 30 consecutive calendar days;
  we stop a day early - see "The two 30s") while keeping the ID, which may be
  kept indefinitely, and drops a point that disagrees with the item's own city.
  **`title: "Royce Tokyo Station"` + Hokkaido coordinates is now unstorable.**
- What is NOT persisted: display name, rating, review count, opening hours,
  Google's `mapsUri`. No caching exception covers any of them. The Maps URL is
  rebuilt from the ID (`/maps/place/?q=place_id:<id>`), which also means it can
  never point at a branch other than the resolved one.
- An edit that does not move the venue keeps the record byte for byte; an edit
  that changes the title or the city drops it, because it is no longer this
  row's place.
- `placesLocationUpdates` only stores a coordinate when `verified === true`, and
  `placePoint` re-checks every venue point against the row's own city before it
  can reach a chip. The Photon fallback goes through the SAME check - a free
  answer is not a licence to store an unchecked point.
- **A `wrong_area` refusal suppresses the city-centroid fallback too.** Normally
  a row with no venue point falls back to its city's centroid, which is the
  honest "roughly here" answer for anything nobody looked up. `wrong_area` is
  different: it is positive evidence that the only candidate for this name was
  somewhere else entirely, so we do not know that the venue is in this city at
  all, and a confident "2.1 km away" on top of that is the same lie in smaller
  numbers. The other no-match reasons (`low_confidence`, `not_found`,
  `generic_query`) keep the centroid - they mean we never learned the position,
  which is exactly what that rung has always been for, and suppressing them
  would strip chips from every landmark whose official name nobody types.

### Categories are structured metadata, never title text

`ASSIST_KINDS` mandates four literal title prefixes ("Dinner: "). A model
generalises from four examples, invented "Shopping: ", and `stripTitlePrefixes`
only knew the four - so the fake category was rendered on the card, stored on
the item, AND folded into the derived Maps query, where "shopping" is a word no
business is named after.

`cleanAssistTitle` runs at `sanitizeActionFields`, the single boundary where
model text becomes app data:

- a prefix the app HAS a category for -> `item.meal` (the full `MEAL_META`
  vocabulary, so `Snack: `, `Dessert: `, `Cafe: `, `Coffee: `, `Brunch: ` all
  land somewhere real), title cleaned;
- a prefix on the closed `DROPPED_TITLE_PREFIXES` list -> dropped;
- **anything else -> untouched.** The list is closed for exactly this reason:
  "teamLab: Borderless" and "Tokyo: A Walking Day" are names, and eating half
  of one would be a worse bug than the one being fixed.

The card's own rendering follows: the title is the venue's name, and the KIND
moved to the meta line beside the date and time ("Drinks · Fri 31 Dec · 8:00
PM"), which is where the itinerary row already carries it as an icon. Before
this the card said "Drinks: Above Eleven" and the row it became said "Above
Eleven" - the two surfaces disagreed cosmetically about the same item, and
`data-dist-label` (which names the origin on the NEXT card's chip) inherited the
prefix, so a chip read "from Drinks: Above Eleven".

`mealTitlePrefixes()` is now read from a data constant that ASSIST_KINDS is
BUILT from, not from a regex over the prompt text. The old regex
(`/"[A-Z][a-z]+: "/g`) scanned prose, and the prompt now also NAMES the prefixes
a model must not invent - a scanner cannot tell a mandate from a prohibition.

### What the model may assert

`ASSIST_PLACE_FACTS` (shipped in both modes) forbids the model producing a
rating, a review count, opening hours as fact, a Google Maps URL, a place ID or
coordinates, and requires `location` to be the CITY and `mapsQuery` to name the
branch plus neighbourhood plus city. The model chooses WHICH place; every fact
about it is resolved deterministically. This is the same split `ASSIST_DISTANCE`
already made for distances.

### Three states, three honest labels

The reported contradiction was "Verify on Google Maps" sitting beside
information the app had already verified. Fixing the link exposed a second one
in the rating slot, and both come from the same habit of collapsing distinct
answers into one string:

| what happened | slot | link |
| --- | --- | --- |
| resolved, Google has a rating | the rating chip (which IS the link; CSS hides the separate one) | - |
| resolved, Google has no rating | "No rating yet" | "Open on Google Maps" |
| name matched nothing close enough | "No rating match" | "Verify on Google Maps" |
| matched, but in the wrong city | "No rating match" (tooltip says which) | "Verify on Google Maps" |

"No rating match" against a place we had resolved, whose position we were
drawing a chip from and whose listing the link opened, read as "we could not
find this". No new UI: the same one-line slot, the same styles, different words
and a reason-aware tooltip.

### The edit modal stopped hunting for a venue (same round)

`focusFirstField(isEdit)` had said "only for a NEW item" in its own comment
since it was written, and focused `#inTitle` either way. `#inTitle` is a place
combobox whose `focus` listener searches whenever the field already holds text,
so opening "Edit item" on a saved venue opened the autocomplete over the form,
under a name the traveller had no intention of changing - the dialog read as
though it were replacing the venue.

Two fixes, because either alone leaves a hole:

- an EDIT focuses no field. `openOverlay` has already focused the `.modal`
  itself, which is what the Tab trap and the screen-reader announcement need,
  so the first Tab lands on the first field and nothing searches. A NEW item
  still focuses its first useful field (the airport pair on a flight, Title
  otherwise), because there the traveller is about to type.
- `focusQuiet()` marks a focus as PROGRAMMATIC and the combobox skips its search
  for those. A human focusing a filled field is asking to see the matches; the
  app moving the cursor is not. This also covers the blocked-save path, which
  focuses the first invalid field and could land on `#inTitle`.

An unrelated edit also keeps the resolved place byte for byte (the item-form
save carries `prev.place` when the title and city are unchanged); changing
either drops it, because the old place ID is no longer that row's.

### Traps found while fixing this

- **app.js destructures ~120 names from TripLogic.** A new export is invisible
  until it is added there, and the failure is a `ReferenceError` at RENDER time,
  not at load - `node --check` and the whole node:test suite pass, and only the
  browser E2E catches it. (`dayMorningCity` was already in that list; adding it
  twice is a `SyntaxError`, which at least fails loudly.)
- **`placeContextFor` calls `dayMorningCity` per row per render.** That walks and
  sorts the whole trip, so it is memoized per (trip, date) and the memo is
  cleared at the top of `render()`. A memo that outlived a render would serve a
  stale city after an edit.
- **Every E2E fixture that seeds `trip-planner:venuegeo:v2` had to change.** The
  store is area-keyed now, so a fixture seeded under a bare query is simply never
  found and the suite reads as a distance regression rather than a stale
  fixture. Seed through `placeCacheKey(q, { city })`.
- **The retry condition is not "the query changed".** The commonest real
  `mapsQuery` already names the city ("Royce' Chocolate Tokyo Station"), so
  gating the retry on a changed query skipped the exact case that failed. It is
  gated on "the query changed OR we now have a restriction to apply".
- **A mock that ignores `locationRestriction` proves nothing.** The Places
  double in the geo tests filters candidates by the box, because the whole
  mechanism the retry leans on is that a restricted search cannot return the
  wrong region.
- **Every tp-places mock in the E2E suites had to echo `id`.** A mock that
  returns a fixed result list keyed only by query text no longer lands at all,
  because the client re-keys responses on the id it sent. The symptom is silent:
  no ratings, no badges, and a duplicate lookup on the next render (the cache
  never filled, so the reservation never held).
- **`#assistBtn` is inside the overflow menu at 390px**, so a selector click on
  the hidden original does nothing and the panel never opens. Drive it with a
  programmatic `.click()` on the real button, or go through the menu proxy.

### privacy.html moved with the code (it always has to)

Two promises changed, and both are checked by
`tests/static/trip-planner-assistant-privacy.test.mjs`:

- **The Places paragraph** said the function "receives the venue search text
  ... not the whole trip". It now also receives the item's CITY, the trip's
  country when known, and that city's cached centre point - the geography the
  whole wrong-branch fix turns on - so the paragraph says so, says why (without
  it the rating and hours shown belong to a place you were never told about),
  and says what is still not sent. It also now discloses that the resolved
  place ID and coordinates are STORED with the item, and therefore synced and
  included in a share link.
- **The logging paragraph** gained the `TP_PLACES_DEBUG` diagnostic mode: off by
  default, records the query, the expected city and the candidate's name,
  address and coordinates, and never records who asked.

And `place` joined `ASSIST_OMITTED_FIELDS`, because `slimTripForShare` is also
the assistant's projection: a place ID and a coordinate are useless to a model
(it cannot look either up), they compete for the trip's size budget, and
shipping them would have quietly widened what "the trip contents" means in the
paragraph about what reaches Gemini. The model's cue that an item already has a
place is its `mapsQuery`, which still travels.

### Two bugs the live validation found that the tests had not

Both were found on 2026-08-27 by driving the REAL handler and the REAL app
against provider data instead of fixtures, and both are the same lesson: a test
that injects its own value cannot see a bug in how that value is produced.

**1. The retry was dead code.** The handler reserves quota with
`billableMax = <number of non-generic queries>` - one slot per query. A query's
own first Place Details call took that slot, so the retry's `claim()` always
failed and the geographically constrained second look never happened. The
pipeline tests all passed because they call `resolveQueries` directly with
`budget: 10`. It was invisible in every mock and obvious the moment a real
handler's upstream call log was read: search, details, and then nothing.

It mattered most in the commonest batch of all - ONE recommendation - which is
exactly the shape of the report the retry was written for. Fixed by reserving
bounded headroom (`retryHeadroom`, capped at `RETRY_HEADROOM_MAX` = 4) on top of
the first lookups. The headroom is an upper bound, never a charge: step (7)
already releases every unspent slot, so a clean batch still costs exactly what
it used, and the cap keeps a 12-query batch from reserving 24 against the
monthly ceiling while it is held. Pinned by
`netlify/functions/tests/tp-places-retry-budget.test.mjs`, which drives the
whole handler so the budget is the real one.

**2. Three surfaces, two URLs.** The rating chip on a card rendered Google's own
`googleMapsUri`, while the card's Maps link and the itinerary row both preferred
the place ID. Both forms are valid Google Maps URLs pointing at the same entity,
so nothing was WRONG - but one recommendation showed two different URLs for one
place, and the Maps URL was supposed to survive from card to itinerary
unchanged. That is the same "two surfaces, two answers" shape the whole round is
about, surviving in the one spot nobody had unified.

`placeEntryUrl(entry)` is now the single definition and all three read it. The
place ID wins because it is the form we can ALWAYS produce: a row rendering from
its saved record has the ID and, by Google's caching terms, may not have kept
`mapsUri` at all - so preferring `mapsUri` anywhere makes that row the odd one
out by construction.

### The follow-up round: discovery answers hold only verified places

The round above made an unverifiable recommendation SAFE. The owner's next ask
was that it also be ABSENT from a "find me places" answer: three requested
places should be three real places, not two real ones and a card for something
the model made up.

**The distinction is drawn from the TRAVELLER'S words.** `assistDiscoveryIntent`
reads their message, not the model's output - it is our own text, it exists
before the reply arrives, and it cannot be hallucinated. "Find me 3 chocolate
shops" is discovery (they named nothing, so an unverifiable candidate is an
invention); "add Royce Tokyo Station" is not (they named it, so their words ARE
the answer and swapping in a different business would answer a question nobody
asked). The model may also declare it, but that is the weaker signal and it
only ever ADDS discovery, never removes it.

The verb pattern is a closed list on purpose: a false positive here silently
deletes a venue the traveller typed. It cost one iteration to get right -
"find me some good ramen spots" has three filler words between the verb and
the noun, and a fixed adjective slot could not reach past them.

**Render order inverts for discovery.** Ordinary turns render cards and paint
ratings in as they land; a discovery turn cannot, because the unverifiable card
would already be on screen as a normal actionable recommendation. So it holds
the answer behind one muted line, resolves, replaces, and renders once. The
cost is a wait; the trade is right for a question whose entire value is that
the answers are real. `DISCOVERY_WAIT_MS` (12s) bounds it, and anything
unresolved when it expires counts as unverified - the honest reading.

**Replacement is deterministic, and that was the important design call.** The
obvious implementation is another model turn ("that one was not real, suggest
another"). It was rejected: it spends a request from the traveller's 30/day
allowance, adds 8-14s to an answer that has already been waiting, needs its own
loop guard, and produces another invented name at the same rate as the first.
Instead `tp-places` gained a `discover` mode - one free `locationRestriction`
search returns a page of candidate IDs and each is verified through the same
`verifyArea` gate. We already know the category and the city; the provider can
answer that directly with real places.

**The name gate does not apply to discovery, and could not.** A named lookup
asks "is this the same business the model named?"; discovery asks "which places
are these?" and nobody named one, so `matchConfidence("nama chocolate Tokyo",
"Musee Du Chocolat Theobroma")` is 0 by construction and would reject every
correct answer. What replaces it is that the SEARCH is restricted rather than
biased - a biased discovery search is the original bug with a wider net.

**An unrated place is not offered as a replacement**, though a named lookup
keeps one. The traveller asked for GOOD places and this candidate is only being
offered because another failed; "we found you something, we just cannot say if
it is any good" is not a recommendation.

**Prose is sanitized, not regenerated.** Regenerating needs another model turn
to rewrite text that is mostly correct, and the sentences about the surviving
places are worth keeping as written. `rebuildAssistProse` drops blocks naming a
rejected venue and no surviving one, corrects the count claim, and adds an
honest note. Two rules keep it from eating good text: a block naming BOTH a
kept and a rejected venue is kept (the corrected count is what stops the answer
over-claiming), and a name must share TWO distinctive tokens before it matches -
"chocolate" alone must never delete a paragraph about a different shop, which is
why PROSE_STOPWORDS exists.

**Seeding is how a replacement reaches its card.** The discovery response IS
the resolution, so `createPlacesQueue.seed(key, entry)` files it under the key
the card will ask for. Without it the card would re-resolve by name: a second
billed call, and one the name gate could refuse, because the model never named
this place.

**Dedupe is by identity, never display text** (`placeIdentityOf`: place ID
first, area-aware key as fallback), and the `exclude` list sent to the provider
carries the rejected candidates as well as the kept ones - so a place we just
refused cannot come back as its own replacement, and an excluded candidate is
never even fetched, because looking costs $0.02.

### Two defects the live pass caught in this round too

Both were invisible to the unit tests and to the E2E, and both were found by
looking at what the real app actually rendered.

**1. A silent fallback hid a missing import for a whole E2E run.**
`placesCacheUpdates` is used by `proposalFromDiscovery` but was never added to
app.js's `window.TripLogic` destructuring, so every discovery answer threw a
ReferenceError - straight into the `.catch` that falls back to the ordinary
render. The only symptom was that discovery quietly did not happen: cards
appeared instantly, the invented venue among them, exactly as before the round.
The fallback now `console.error`s as well as debug-logging, because a fallback
that hides its own cause is how a feature silently stops existing. app.js
destructures ~120 names from TripLogic and a missing one is a RUNTIME error in
one branch - `node --check` and the whole node:test suite pass. There is now a
sweep for it in the round's notes; run it after adding any TripLogic export.

**2. A replacement card could not be accepted.** `validateTripAction` does not
assign `pid` - `validProposalsFrom` does - so a proposal built from a discovered
place rendered with `data-proposal-id="undefined"` and no entry in
`assistActions`. Its "Add to trip" button did nothing at all, on the one card
the traveller is most likely to press, because it is the one we went and found
for them. Replacements now take a pid and register their action exactly as
model-authored proposals do.

### What these rounds deliberately did NOT do

**Replacement never spends a model turn.** The obvious way to replace an
unverifiable recommendation is to ask the model for another one. It is not what
happens, and the reasons are worth keeping: a second Gemini turn spends a
request from the traveller's 30/day allowance silently, adds 8-14s to an answer
that has already been waiting behind verification, needs its own loop guard, and
invents names at the same rate the first turn did - so the replacement can fail
verification too and the loop earns nothing. The provider already knows which
real places match a category in a city, which is the actual question.

**Only DISCOVERY answers replace.** A place the traveller NAMED is never swapped
for a different business, however unverifiable it is. Their words are the
answer; substituting a shop we happened to find would be answering a question
nobody asked. Those keep the honest unresolved state - "No rating match", a
plain search link, no rating, no distance, no hours.

**Unrated places are still recommendable in a named lookup** (unrated is not
unverified), and still excluded from every pick-one badge, because
`candidateBadges` counts only resolved entrants.

## The 2026-09-05 round: the gate that emptied the assistant, and the hotel with two locations

Three symptoms, reported together with screenshots. Two of them share a cause;
the third is independent.

### 1. "I could not verify any places for this on Google Maps"

Whole days in Krabi and Phuket came back with zero places, including turns where
the traveller named a real restaurant outright.

**Cause: `verifyArea` treated an absent locality name as proof of a wrong
branch.** With no coordinate for the expected city, the gate fell to comparing
the itinerary's HUMAN name for a place against Google's ADMINISTRATIVE address,
and a miss returned `ok: false` -> `no_match / wrong_area`:

| the itinerary says | Google's address says                            |
| ------------------ | ------------------------------------------------ |
| `Railay Beach`     | Ao Nang, Mueang Krabi District, Krabi, Thailand   |
| `Kata Beach`       | Karon, Mueang Phuket District, Phuket, Thailand   |
| `Ko Phi Phi`       | Ao Nang, Mueang Krabi District, Krabi, Thailand   |

Beaches, resort strips and islands are not administrative units, so the two
never agree, and every real venue in the area was refused **while scoring 1.00
on the name gate**. The replacement loop applied the same rule to its own
candidates, so it could not rescue the answer either: zero places, deterministically, for a
whole class of destination.

Why it was intermittent rather than constant: the coordinate branch is the one
that normally answers, and `cityPoint` is **cache-only**. On the first assistant
turn of a session the day's city has not been geocoded, so there was no point
and the brittle text branch decided.

**Fix, in three parts.**

- `verifyArea`: a locality miss with the country agreeing is now
  `{ ok: true, checked: false, reason: 'city_unconfirmed' }` - "could not
  check", not "wrong". A country that is genuinely absent IS evidence and still
  refuses (`country_mismatch`). The coordinate branch is unchanged and still
  rejects at 150 km, which is what catches the 809 km case.
- The client separates two questions that had been conflated into one flag:
  **`isResolvedEntry`** (Google returned a real entity whose name the query
  accounts for - the anti-hallucination gate, and what decides whether a place
  may be RECOMMENDED) from **`isVerifiedEntry`** (the area was checked and
  agreed - what decides whether a coordinate, a distance chip or a persisted
  place record may be drawn). Discovery now gates on the former. A hallucinated
  venue still comes back `not_found` / `low_confidence` and is never substituted.
- `warmAreaPoints` geocodes the day's city **before** a discovery batch is
  verified, so `basis: 'point'` is the normal case rather than the exception.
  Safe because `placeAreaKey` is city-first: a coordinate arriving later cannot
  re-key a lookup.

`discoverPlaces` additionally tracks whether its search was actually
constrained (a rectangle, or the city spelled into the query text). An unchecked
verdict is accepted only when it was; a genuinely global search still refuses.
Note the old `biasFor(area, true)` returned **null** with no point, so the
search documented as "RESTRICTED, not biased" was in fact unrestricted.

**THE DECISION HIERARCHY**, strongest evidence first. Only rungs 1 and 4 may
ever REJECT, and both of them reject on real evidence rather than on wording:

| # | evidence | verdict | effect |
| - | -------- | ------- | ------ |
| 1 | a coordinate for the expected area | `point`, ≤150 km | **verified**; >150 km **rejected** (`wrong_area`) |
| 2 | no coordinate, address names the expected city | `city_match` | **verified** |
| 3 | no coordinate, address names the country but not the city | `city_unconfirmed` | **resolved, NOT verified** |
| 4 | no coordinate, address names neither, a country was expected | `country_mismatch` | **rejected** |
| 5 | no usable context at all | `no_area` / `no_evidence` | unchecked, never verified |

The name gate is orthogonal and untouched: `matchConfidence` must account for
more than half of the returned place's own distinctive tokens or the candidate
is `low_confidence`, whatever its geography.

This is what separates the two cases that were being conflated. "Railay Beach"
against an Ao Nang address is rung 3 at worst and rung 1 (5 km, verified) as
soon as the day's city is geocoded - which `warmAreaPoints` now makes the normal
case. A same-named restaurant 700 km away is rung 1 (rejected on distance), or
rung 4 if it is in another country. Rung 3 is the only relaxation, and what it
buys is a *recommendation without a coordinate*: the venue is shown, but it
draws no distance, persists no place record, and links as "Verify on Google
Maps" rather than "Open".

### 2. "~27 min by taxi, ~14 km" for a 450 m walk

The Day Route map for the reported day drew stop 1 (the hotel) and stop 2
(dinner) together on Kata Beach, and stop 3 - labelled "Return to hotel",
meaning **the same hotel** - about 14 km NORTH of both.

**Cause: the hotel had two independently resolved locations, and the leg got the
worse one.** `itemDistAttrs` and `resolveOriginPoint` offered the hotel-picker
rung (`cityPoint(displayTitle(item))`, a doorstep the traveller chose, seeded
locally by `rememberPickedHotel`, needing no network) only when
`isStay(item)`. A "Return to hotel" is type `local`, so it was denied that rung,
its own Places lookup had stored no coordinate, and it fell all the way to the
city anchor - and Nominatim answers **"Phuket" with the PROVINCE**, centroid
7.9366, 98.3529, which is 14.2 km north of Kata Beach. Traced values:

| stop                | point                | identity                          | source                       |
| ------------------- | -------------------- | --------------------------------- | ---------------------------- |
| 1 Sugar Marina      | 7.8203, 98.2988      | `c:sugar marina hotel -fashion...`| hotel-picker rung            |
| 2 Kata On Fire      | 7.8180, 98.2980      | `v:kata on fire...@phuket`        | Google Place Details         |
| 3 Return to hotel   | **7.9366, 98.3529**  | **`c:phuket`**                    | **city anchor (province)**   |

The two rows did not even share a place key: the stay's `itemMapsQuery` appends
its location (`...kata beach phuket@phuket`) while the leg uses the model's raw
`mapsQuery` (`...kata beach@phuket`), so they were two separate Google lookups
of the same building. Everything that measured the day - the card chip, the day
footer total and the route line - inherited the wrong point, which is why the
modal and the day card agreed with each other and both were wrong.

**Fix.** `legDestinationStay` / `distanceTargetFor` (trip-logic, exported and
shared) make a travel leg that ends at a stay resolve **as that stay**: same
key, same place ID, same coordinates. A leg is not an independent place and is
never geocoded, looked up or centroid-ed on its own. `itemDistAttrs`,
`resolveOriginPoint`, `primeOrigin` AND `proposalDistAttrs` all route through
it - the last one matters most, because the pre-add card and the row it became
used to derive a leg's location by different rules (the card had a hotel rung of
its own, `legDestStayName`, and the row had none), which is precisely why the
number was right until the traveller pressed Add. That helper is now deleted;
there is one rule and both sides read it.

**And a derived row refuses the centroid.** `distAttrs` stamps `data-dist-strict`
on a row whose place comes from another item, and `placePoint` returns **null**
rather than the city anchor for such a row. A city centroid is a fair answer for
a row nobody looked up; it must never fabricate a *hotel's* position. So an
unlocatable stay now yields no pin, no chip and no leg - an explicit unknown -
instead of a confident wrong number. Everything that measures a day reads this
one ladder (`readPoint` -> `placePoint`), so the card chips, the day footer
totals, the Day Route list and its map pins all move together.

**Defence in depth: `unmeasurableLeg`.** Points now carry `precision`
(`venue` | `city`) and a `cityKey`, and `dayDistanceChain` drops a leg whose
DESTINATION is a city centroid in the same city as its origin. Only the
destination is judged, and the asymmetry is deliberate: an origin that is openly
the city ("~4 mi from Tokyo") is a long-standing honest answer to a coarse
question, and suppressing it strips the chip from every trip whose hotel was
typed rather than picked - the trip-planner E2E `MV-01` block catches exactly
that over-reach, and did. A coarse DESTINATION is different: "Return to hotel -
14 km" is a claim about one named building.

### 3. An unasked-for paragraph about entry requirements

A day-planning answer opened with "Regarding your question about entry
requirements, I cannot confirm visa, passport, or health-related entry rules for
Thailand..." when no such question was asked.

**Cause: `ASSIST_HONESTY` is in every system prompt, and its entry-requirements
clause read as an instruction to DELIVER a paragraph** ("If the traveller asks
about any of them, say plainly that...") rather than as a limit on what may be
asserted. The model discharged it unprompted. The clause now says explicitly
that it is a limit on assertions, not a disclaimer to volunteer, that the
subject must not be raised unless the CURRENT message raises it, and that
earlier turns are context for the current request rather than a topic to
continue.

### 4. The chain sibling (found by verifying the fix on production)

Verifying the round against the live site turned up a fourth defect of the same
family. Asked for the hotel from the owner's own screenshots:

    query   "Sugar Marina Hotel -FASHION- Kata Beach"
    got     "Sugar Marina Hotel -POP- Kata Beach"     score 0.80, accepted

A DIFFERENT hotel, of the same chain, 350 m up the same beach. Four of the
place's five distinctive words really are in the query, so the name gate was
not being unreasonable - and geography cannot help at all here, because the two
buildings are neighbours. Chains name properties exactly like this: `-POP-`,
`-FASHION-`, `-SURF-`, `-ART-`, one word apart, and that word is the whole
identity.

**The signal is MUTUAL disagreement.** When the place carries a distinctive word
the query never asked for AND the query carries one the place does not have, the
names are not a longer and a shorter form of one business; they are two
businesses whose discriminators contradict. `hasCompetingDiscriminator` returns
true only for that shape, so one-sided extras keep working, which is what
protects the ordinary cases:

| query | place | verdict |
| ----- | ----- | ------- |
| `Nabezo Shinjuku` | `Nabezo Shinjuku Sanchome` | pass - only the PLACE adds |
| `Ichiran (Shibuya branch)` | `Ichiran Shibuya` | pass - only the QUERY adds |
| `Hilton Tokyo` | `Hilton Tokyo Bay` | pass - one-sided |
| `Sugar Marina ... -FASHION- ...` | `Sugar Marina ... -POP- ...` | **refused** - mutual |

**The area is excluded before judging, and that is load-bearing.** A mapsQuery
legitimately carries the city as a search HINT ("Anna's Restaurant Ao Nang"),
not as part of the name. Without excluding it, `Royce' Chocolate Tokyo Station`
would read as contradicting `ROYCE' Chocolate World` over the word "Tokyo" and
be refused on the NAME - which would be the right answer for the wrong reason,
and would stop the geographic gate ever being reached. `judge` therefore passes
its `area` into `matchConfidence`, and the 809 km case still resolves the way it
is documented to: name says yes, geography says no.

### What the tests had missed

Every address-basis fixture in `tp-places-geo.test.mjs` used a city Google
actually prints ("Tokyo", "Paris", "Kyoto"), so the address branch's **rejection
power was never exercised against a legitimate place**. One assertion there
(`verifyArea(ROYCE_HOKKAIDO, {city:'Tokyo'}).ok === false`) encoded the bug and
had to be revised; it now pins the protection it was reaching for - that an
unconfirmed candidate is not VERIFIED - instead of the over-rejection.

New coverage: `netlify/functions/tests/tp-places-locality.test.mjs` (the gate,
the discovery constraint, distinguishable failure reasons, a batch surviving one
bad candidate) and `apps/trip-planner/tests/assistant-geo-regression.test.js`
(the return-to-hotel invariant, precision-tagged legs, coordinate transposition,
hotel-by-date, prompt contract). The locality fixtures are Thai, Greek,
Indonesian and Japanese on purpose: nothing about the fix is country-specific.

## The 2026-09-05 follow-up: the anchor was wrong, not the gate

The round above relaxed `verifyArea` and the assistant got visibly better - a
realistic Ko Phi Phi day, real venues, correct Google Maps links. It still said
**"No rating match"** on The Mango Garden, a restaurant Google rates 4.8 from
3,770 reviews, next to a link that opens exactly that restaurant.

The gate was not the problem this time. **The app was telling it the wrong place
to look.**

### The measurement that ended the argument

The production endpoint, asked the way the browser asks it:

```
POST /.netlify/functions/tp-places
  { q: "The Mango Garden Ko Phi Phi", city: "Ko Phi Phi",
    country: "Thailand", lat: 11.8237522, lon: 102.4463456 }   <- what the app sent
  -> { status: "no_match", reason: "wrong_area" }

  { q: "The Mango Garden Ko Phi Phi", city: "Ko Phi Phi", country: "Thailand" }
  -> { status: "ok", name: "The Mango Garden", rating: 4.8,
       userRatingCount: 3770, placeId: "ChIJvb7PGeDeUTARJoM-VdbMTRg",
       lat: 7.7387722, lon: 98.7714123, hours: {...} }
```

Same query, same key, same field mask. Google had already returned the rating,
the review count, the Maps URI, the coordinates and the opening hours **in
full**, on the first attempt. The app threw all of it away because of the two
numbers it had attached to the question.

`11.8237522, 102.4463456` is **Ko Phi, an islet in Ko Kut District, Trat
Province** - Nominatim's top hit for the string "Ko Phi Phi", 570 km away on the
Cambodian side of the country. Measured against it, every real venue on Phi Phi
Don genuinely is outside the 150 km radius, so the gate refused all of them,
correctly, one after another.

**A wrong anchor does not reject the wrong venues. It rejects the right ones,
and it rejects every single one**, which is why the failure looked like a dense
tourist island with no restaurants in it rather than like a bad coordinate.

### The app already knew the geocode was untrustworthy

`classifyGeoMatch` scored that answer `low` when it was written to the cache
(addresstype `islet`, importance 0.127). Nothing read the score. Measured
against the live geocoder on 2026-09-05:

| the itinerary says | Nominatim's top hit | conf | coordinate |
| ------------------ | ------------------- | ---- | ---------- |
| `Ko Phi Phi`   | Ko Phi, Trat Province      | `low`       | **570 km wrong** |
| `Phi Phi Don`  | Ban Phai Lom, Don Thong    | `ambiguous` | **750 km wrong** |
| `Kata Beach`   | Kata Beach, Karon          | `low`       | correct |
| `Railay Beach` | Ao Rai Le, Railay          | `low`       | correct |
| `Ao Nang`      | Ao Nang, Krabi             | `confident` | correct |
| `Phuket`       | Phuket **Province**        | `confident` | 14 km off (the centroid bug) |
| `Tokyo`        | Tokyo                      | `confident` | correct |

**This is why islands and beaches were hit and cities were not**, and it is not
about islands: settlements come back `confident`, sub-localities come back as
`islet` / `beach` / `hamlet` kinds with importance under `GEO_WEAK_IMPORTANCE`,
which is the definition of `low`. Islands are simply where "the geocoder is
unsure" is the norm rather than the exception.

### The rule: a centroid may only REJECT when the app vouched for it

`cityPoint` was doing two jobs with one answer, and they have opposite risk
profiles:

- as a **fallback**, to draw a row roughly where it probably is. A guess is
  fine: the alternative is no pin at all.
- as **evidence**, to refuse a resolved place. A guess here is catastrophic.

They are now two functions. `cityAnchor` (app.js) returns the point only when
`classifyGeoMatch` called it `confident`; `cityPoint` is unchanged and still
feeds the "roughly here" rung, so **Kata Beach and Railay Beach keep their
chips** - both score `low` and both have correct coordinates, and gating the
display rung on confidence would have stripped them to fix an unrelated bug.

Everything that REJECTS now reads `cityAnchor`: the area gate's own anchor, the
Photon venue-point plausibility check (which was also refusing every correct
Phi Phi coordinate for being 570 km from the "city"), and the persisted-record
sanity check.

### The ladder, and why the hotel is now first

`areaAnchorFor` (moved into trip-logic; see the testability note below):

1. **the day's host stay's own doorstep**, from the geocode cache under the
   hotel's name (the picker seeds it and marks it confident, because a human
   chose that row) or from the venue cache. Offered only when the item named no
   city of its own - "Nikko" on a Tokyo day is a claim about Nikko.
2. **the named city**, and only if it was vouched for.
3. **the host stay's city**, same condition.
4. **nothing**, which downstream is "could not check" - the place still
   resolves and still shows its rating.

The stay was previously rung 3 and unreachable: the city rung won outright
whenever the geocoder had an answer *of any quality*. The traveller's own hotel
is the better anchor in every case - a building rather than a polygon's middle,
chosen by hand, and where the day actually starts.

### Two more failures the same investigation surfaced

**Maya Bay became Maya Bay Tours, and every gate agreed.** Confirmed against
master: `resolveQueries` answered `"Maya Bay Ko Phi Phi"` with a tour desk,
`status: ok`, `verified: true`, wearing the desk's 4.6 rating and its pin.
`matchConfidence` scores whole-name containment 1.00 (`"maya bay tours"`
contains `"maya bay"`), and the desk is 100 m from the hotel while the beach is
7 km offshore, so proximity *favoured* the wrong answer. **Proximity must never
decide identity.** A third gate now runs before geography:

- the place's NAME advertises a trade the query never asked for (`tours`,
  `tickets`, `booking`, `agency`, `charter`, ...) -> `broker_name`
- Google's own `primaryType` says it IS a broker and the query never asked for
  one -> `broker_kind`
- the place's kind contradicts the itinerary's own meal slot -> `kind_mismatch`

`types` and `primaryType` joined the details field mask to make this possible.
Both sit **below** the Enterprise tier the request already bills at (`types` is
Essentials, `primaryType` is Pro), exactly like `location` and
`formattedAddress`, so the SKU, the price and the request count are unchanged.

**REFUSED, with the measurement:** deriving the expected kind from words in the
query. It was written and thrown away, because those words are parts of names,
not categories - `The Mango Garden` (garden -> nature), `Phi Phi Island Village`
(island -> nature), `Temple Bar, Dublin` (temple -> worship), `Long Beach
Resort` (beach -> nature). Every one is a correct answer the gate would have
deleted, which is the exact failure this whole round is about. The only
expectation source is the itinerary's own **meal slot**, which is structured
metadata rather than a word guessed out of prose. `expectedKinds` carries the
list; a test named `REFUSED BY DESIGN` fails if anyone reintroduces the table.

**A provider that never answered was reported as an empty neighbourhood.**
`discoverPlaces` had always distinguished `upstream` from `no_candidates`; the
handler dropped the reason on the way out and the client's
`fetchDiscoveryCandidates` collapsed network errors, HTTP errors, malformed
bodies and genuine emptiness into one `[]`. Worse, `verifyDiscoveryProposals`
never asked whether the lookup queue was **switched off**: with no Places key
configured (the *default* state of this feature) it polled a cache that could
never fill for the full 12 s, rejected 100% of the candidates, and told the
traveller nothing could be verified. That turn now degrades to an ordinary one -
every candidate shown, honestly unverified. `rebuildAssistProse` takes a
`providerFailure` and says "I could not check", never "there is nothing here".

### Identity and position are separate claims

`placeRecordFrom` demanded `verified === true` or persisted **nothing**, so a
place that resolved perfectly - one Maps entity, name gate agreed - was stored
as nothing at all whenever the locality could not be confirmed. On every island
and beach that is the normal case, so Add to trip silently dropped the place ID
of a correctly identified venue, and the row re-resolved itself by name on every
reload.

They are now stored on their own evidence: **the ID whenever the place
RESOLVED** (a place ID cannot be off by 809 km - it is an identity, not a
position, and Google's terms single it out as the one value that may be kept
indefinitely), **lat/lon only when the area was VERIFIED**.

### Everything else this round changed

| symptom | cause | fix |
| ------- | ----- | --- |
| "No rating match" on four different answers at once | one string for "unresolved", "wrong city", "wrong kind" and "no star" | `placeStateLabel`, a pure function with one sentence per state; a place with a `placeId` never reads as "not found" |
| a stale answer rendering under a newer one | `assistSending` guards the request, but a discovery turn returns as soon as it has *started* verifying | a per-turn number taken before the request; both the `.then` and the `.catch` refuse to write unless it is still current |
| trip A's cards rendered into trip B's thread | the `.catch` fallback had no trip guard at all | same guard on both arms |
| a wedged endpoint lost the turn silently | `fetchDiscoveryCandidates` had no `AbortController` and no timeout | 12 s deadline, and a hang now surfaces as `timeout` prose |
| candidates rejected as unverified, then re-bought | `request()` skips a key the queue already holds, so an urgent candidate stayed in the slow lane | `promote()` before `request()`, and a final re-read that rescues late resolutions |
| a "Return to hotel" copied to another date pinned the old city | `legDestinationStay` matched by NAME across the whole trip, first hit in storage order | the day's host stay is consulted first; a named match prefers one whose own dates cover the leg |
| the 14 km phantom, roles swapped | `unmeasurableLeg` judged only the destination, so an unresolved activity became a confident-looking ORIGIN | a centroid **standing in for a named venue** cannot start a leg either; an openly-coarse day anchor still can |
| a hotel named after its own beach got the centroid tagged `venue` | `geoCache` is one flat namespace for cities, picked cities and picked hotels | a "doorstep" that is the same point as the city's own is not a doorstep |
| "try again" advised for a revoked key | every upstream failure was one `{error:'upstream'}` | `upstreamReason` classifies timeout / network / auth / model / upstream / empty; the UI stops telling people to retry what cannot succeed |
| 12:30 lunch, 12:40 at a museum 8 km away | nothing compared the printed distance with the printed times | `impossibleHops` - **travel time only**, never a guess about how long a meal takes, so it flags a day that cannot work rather than a day that looks busy |
| a day route that measured a doorstep opened Maps on a centroid | leg queries degrade to the bare city name | `data-dist-place` carries the canonical ID; `directionsUrl` takes `origin_place_id` / `destination_place_id` |

### Why the tests missed all of it

**Every existing test treated the itinerary's own area as ground truth and
varied the candidate.** All three production failures inverted that premise.
`tp-places-geo.test.mjs` has 30 tests and every one of them supplies the
*correct* point for the destination; the one whole-batch survival test
(`tp-places-locality.test.mjs`) deliberately withholds the point from its eight
survivors, so it exercised the address branch and never the point branch. Adding
a wrong `lat`/`lon` to those eight queries reproduces production exactly.

The second reason is structural: **the decision lived somewhere node could not
load.** `cityPoint` -> `areaPointFor` -> `placeContextFor` are all in `app.js`,
which is not a module, and the E2E suites that *can* load it seed `geoCache` by
hand with known-good coordinates and block the network. So the one harness able
to exercise the real geocode path explicitly stubbed it out with the right
answer. That is why `areaAnchorFor` moved into trip-logic with injected cache
readers: the boundary that failed is now the boundary that is tested.

New coverage: `netlify/functions/tests/tp-places-identity.test.mjs` (the wrong-anchor
repro, the type gate, provider failure vs zero results, one bad candidate among
eight good ones, metadata belonging to one identity, and a call-count pin so the
gate cannot get expensive), `apps/trip-planner/tests/assistant-canonical-identity.test.js`
(the anchor ladder, hotel-by-date, the standin-centroid leg, identity through
add and reload, the model-supplied-rating allowlist, the four honest labels,
schedule feasibility) and `apps/trip-planner/e2e/assistant-identity.mjs` (the
whole traveller lifecycle on Phi Phi, Kata, Maya Bay, Tokyo, a partial failure
and a 390 px phone, against a double that implements the real server's gates).

Every new test was **proven to fail against master** before being kept.

## The anchor was there and arrived too late (2026-09-06, pre-merge)

A companion to the round below, found by running the real Ko Phi Phi flow
against production. A breakfast card offered **Phi Phi Bakery** at 08:00 with a
chip reading **~94 mi from the hotel**: the hours were right, the rating real,
the Maps link opened that exact entity, and the venue was not on the island.
`PLACE_AREA_MAX_KM` is 150 km, which is **93.2 mi**, so it sat just outside the
radius the coordinate branch exists to enforce - and that branch never ran,
because the day had no anchor.

**The loop that caused it is fixed below, not here.** The round below keeps a
resolved place's own coordinate instead of withholding it until the area is
verified, which is what lets the venue cache fill on an island at all; once it
fills, `areaAnchorFor`'s existing hotel rung reads it. An earlier version of
this round added a THIRD source to that rung, reading the same coordinate out
of the places session cache directly. It was removed on reconciliation: two
mechanisms for one fact is how a ladder rots, and the surviving one is the one
that also fixes the row's own position.

**What is left is ordering, and it is not redundant.** A candidate lookup bakes
the anchor into its own `area` at the moment it is built, so an anchor that
lands a second later is an anchor nobody used - and on the first assistant turn
of a session the hotel's row lookup (normal priority, IntersectionObserver) is
racing the candidate batch (urgent). `warmStayAnchors` resolves the day's host
stay FIRST, bounded at 4 seconds, free whenever the row already resolved it,
and then the existing rebuild pass re-derives every candidate lookup. Pinned in
the browser (`e2e/schedule-slots.mjs`): the hotel is looked up before the
candidates, and the candidates then go out carrying its coordinate rather than
city and country alone.


### The other thing that live run found: a plan that never arrived

A guided plan answered with a paragraph - "Here is a plan for your day on
October 6th" - and no fenced block. No cards, nothing to add. The panel renders
the promise and falls silent, which is worse than an error, because the
sentence says the work was done.

> **THE PROVENANCE OF THIS SECTION WAS WRONG, AND THE CORRECTION IS THE MORE
> USEFUL FINDING.** It was written up as "seen twice in three live production
> runs". It was not seen at all. The live harness leaked a headless Chrome on a
> fixed CDP port; every later run attached to that same browser, and the app
> was faithfully restoring the FIRST run's chat history - which persists the
> assistant's prose and deliberately does NOT persist the proposal cards. Those
> runs made zero model calls. The identical byte-for-byte prose across "three
> runs" was the tell and it was read past twice, including once while
> explicitly hunting for the cause.
>
> **The lesson that generalises: a replayed chat thread is indistinguishable
> from a model that answered with prose and no actions.** Anything driving this
> app against a live model must use a fresh profile AND a fresh trip id per
> run, or it will manufacture exactly this bug. `e2e/helpers.mjs` gets this
> right by construction (one profile per suite, seeded db); a hand-rolled probe
> does not.

It is also **not reply-size truncation**, which is the other thing it looks
like and the first thing assumed. `maxOutputTokens` is 12,000 and tp-assist
appends `TRUNCATION_NOTE` on a `MAX_TOKENS` finish; neither was present.

**What is kept, and why.** The defence stands on its own merits rather than on
that story: a guided plan whose reply carries nothing to add IS a failed turn
from the traveller's side, the picker had already supplied everything the model
needed, and the response is proportionate. The fenced block sits at the END of
the answer, which is the reason `TRUNCATION_NOTE` and a 12,000-token cap exist
at all, so the shape is reachable. What must not be claimed is that anyone has
measured it happening.

Three layers, cheapest first:

- **The prompt.** The plan-mode rules now say the block is not optional and
  that a paragraph promising a plan with nothing behind it is a failed answer.
  Plan mode only: a free-form "what time should I leave for the airport" is
  legitimately prose with no actions.
- **One repair turn** (`sendMessage`). A plan turn whose reply carries no `add`
  action is asked once, with `PLAN_REPAIR_REQUEST`, for the fenced block alone
  and explicitly no second paragraph. The typing indicator stays up; nothing
  appears in the traveller's transcript, because this is the app fixing its own
  turn rather than a question anyone asked. The repair's block is appended to
  the original prose, so `extractTripActions` reads the combined text and what
  renders is the single answer the turn should have been. Bounded to one, and
  never attempted on the copy/paste tier, which has no model to ask.
- **The honest note** (`renderAssistAnswer`). If the repair also comes back
  empty - or could not run - the answer says so: "That answer described a plan
  but did not send any items, so nothing was added." A promise with nothing
  behind it is the one thing that must not be rendered silently.

The certainty comes from the picker's contract travelling as data
(`planReplyIncomplete(actions, plan)`), which is the same threading the
schedule round added for a different reason. Without it the app could not tell
a broken plan from an ordinary conversational answer, and would have to guess
from the prose.

## The 2026-09-06 round: identity without position is still a guess

**The report.** Jan 27 2027, Ko Phi Phi. ChaoKoh Hotel Phi Phi Island -> The
Mango Garden is a 258 m walk; Google's own directions say 210 m and three
minutes. The row printed `~344 km`, the day footer printed `🚕 344 km`, and the
Day route map plotted the two pins on opposite sides of the Gulf of Thailand -
beside a Maps link that opened the correct restaurant on the correct island.

**The two coordinates, both wrong, both from a different hole.** Reproduced
exactly (344.4 km) from live provider captures:

| endpoint | what the app used | where it came from | error |
| --- | --- | --- | --- |
| ChaoKoh Hotel (origin) | 11.823752, 102.446346 | `cityPoint('Ko Phi Phi')` - Nominatim's first answer is เกาะผี, an islet in **Trat Province** | 606 km |
| The Mango Garden (destination) | 10.0941684, 99.8293127 | Photon's first answer for `The Mango Garden Ko Phi Phi` - a cafe named **exactly** that on **Ko Tao** | 286 km |

**Why the links were right and the map was wrong.** They read different things.
Identity came from `item.place.id` (`canonicalPlaceId` -> `placeMapsUrl`), which
is the Google place ID Add to trip accepted. Position came from `placePoint`,
a ladder of cache lookups keyed by a **text query** that never once read
`item.place`. One row, two location models, and nothing compared them. That is
the split identity in its purest form: the app HELD the right answer and did not
look at it.

**Three defects, in the order they compound.**

1. **`placeRecordFrom` withheld the coordinate unless the area was VERIFIED.**
   The 2026-09-05 round separated identity from position, which was right, and
   then made the position wait for a second opinion, which was not. `verified`
   does not mean "Google returned a point" - it means the locality could be
   CHECKED, and on any island, beach or resort strip nothing can check it (the
   only anchor is a geocode the app itself scores `low`). So the coordinate of a
   place that resolved perfectly - one Maps entity, name gate agreed, 4.8 from
   3,769 reviews - was thrown away for want of corroboration nobody could give.
   **Discarding evidence does not produce silence. It produces a guess**, and
   the guess that filled the hole was a free global name search.

2. **The Photon gate was open exactly where it mattered.** #484 changed
   `plausiblePlacePoint(hit, cityPoint(job.city))` to `cityAnchor(job.city)` -
   correctly, because a wrong centroid must not reject a right venue - but
   `plausiblePlacePoint` returns **true** for a null anchor ("silence is not
   evidence"). Combined, that means: where no centroid can be trusted, *nothing
   is checked at all*. Photon answers every query with something, so the Ko Tao
   cafe was stored in the venue cache (30 days at the time; 29 since 2026-09-06)
   and repeated on every render.

3. **`standin` and `placeId` never survived `distancePoint`.** Both were added
   by #484 - `standin` so `unmeasurableLeg` could refuse a leg STARTING on a
   centroid handed out in place of a named building, `placeId` so a leg could
   carry canonical endpoints - and `distancePoint` rebuilds a point field by
   field. Neither field was in the list. **The guard shipped dead and had never
   fired in production**, and every leg's `fromPlaceId`/`toPlaceId` was `''`.
   A guard that is not carried is a guard that does not exist; anything a
   consumer of that shape reads MUST be named in it.

**#485 neither caused nor exposed this.** `git log -S` puts `standin`,
`fromPlaceId` and the `cityAnchor` gate swap all in `35d4dc4` (#484), the commit
BEFORE it. Before #484 the Ko Tao point was rejected - by the wrong centroid,
for the wrong reason, but rejected. #484 removed the accidental protection and
added the intended one dead.

**The fix, structurally.**

- **The canonical rung is the FIRST rung.** `placePoint` takes a `canon` point
  and returns it above every fallback. A resolved place's own coordinate
  outranks a name search, a picker doorstep and a centroid; none of them may
  stand in for it. The point rides on the row in `data-dist-plat`/`plon` beside
  `data-dist-place`, so the surfaces that read the DOM reach the same place.
- **Position follows identity.** `placeRecordFrom` and `placesLocationUpdates`
  keep the coordinate whenever the place RESOLVED. `verified` stays, as what it
  actually is: a note on corroboration, not a licence to exist.
- **The defence moved to where evidence lives.** `normalizePlaceRecord` still
  measures every point against a VOUCHED-FOR anchor on read and drops it beyond
  `PLACE_AREA_MAX_KM`. A confident Tokyo anchor still refuses a Hokkaido branch
  (the 809 km chip is exactly as impossible); an untrusted one refuses nothing,
  which is the rule the rest of the file already follows.
- **`canonicalPointFor` mirrors `canonicalPlaceId`.** A HAND-ADDED stay never
  gets `attachResolvedPlace` (it runs only on the assistant's accept path), so
  the saved record is consulted first and this session's resolution second -
  through the same two boundaries. Stamping the ID but not the point is what let
  the links and the map disagree in the first place.
- **The Photon gate demands evidence, and refuses without it.** `venueGateAnchor`
  tries the vouched-for centroid, then the itinerary's own `areaAnchorFor`
  ladder (the day's stay is a building the traveller chose). With neither, the
  hit is refused. This does NOT restore #484's empty island: a place that
  resolved now carries Google's own point, and this rung only ever answered for
  rows nothing resolved.
- **`trip-planner:venuegeo:v1` -> `v2`.** Points that entered through the open
  gate lived 30 days (the store's TTL at the time; 29 since 2026-09-06), so a
  traveller already carrying one would keep seeing
  344 km after the fix. Renaming the store is the only way to be sure. Cost: one
  re-lookup per venue on screen. Every E2E fixture seeding the old key moved.
- **Impossible geography is said out loud, never hidden.** `contradictoryPair`
  stamps `suspect: 'same-city-far'` on a leg whose two ends the app itself puts
  in ONE city and then measures past `PLACE_AREA_MAX_KM`; `paintDayDistances`
  logs it through `placesLog` with both endpoints. The number still renders -
  suppressing it would hide the fault from the next session too.

**What made this findable, and what nearly hid it.** The 344 km was reproducible
from two `curl`s: Photon for the venue, Nominatim for the city, then the app's
own `distKm` over the two answers - 344.4 km on the first try, against a reported
"344 km". Provider captures beat reasoning about provider behaviour. What nearly
hid it: `e2e/assistant-identity.mjs` block A is the SAME island, the same
restaurant and the same day, and it passes - because it seeds the hotel into the
geocode cache as a confident doorstep. The owner typed their hotel instead of
picking it, so nothing on the day had a trustworthy coordinate. **A fixture that
seeds the good case is a fixture that cannot see the bug**;
`e2e/canonical-coordinates.mjs` removes exactly that one seed and reproduces the
failure byte for byte (chip `~214 mi` = 344.39876 km, footer `🚕 214 mi`).

**What reviving the standin guard flushed out.** `e2e/audit-fixes.mjs` MV-01
seeded its two hotels under `'<title> <city>'`, and `itemMapsQuery` does not
repeat a city already spelled inside the title ("Hotel Ryumeikan Tokyo" in
Tokyo), so both entries were keyed `hotel ryumeikan tokyo tokyo@tokyo` and no
read path ever asked for them. The day therefore anchored on the Tokyo centroid
while the chip was LABELLED with the hotel's name - the same false statement
about a specific building that the guard exists to refuse, sitting green in the
suite for as long as the guard was dead. Seeding the key the app actually
derives makes MV-01 measure ~1.1 mi from the hotel's own doorstep, which is what
it always meant to assert.

**And the cost #484 feared did not arrive.** That round worried that judging a
coarse ORIGIN would "strip the chip from every row of a trip whose hotel was
typed rather than picked". That was true when the only rungs were a picker
doorstep and a centroid. It is not true now: a typed hotel that Google resolves
carries its own canonical point, so what loses its chip is only a stay nothing
can locate at all - which genuinely has no position, and whose first leg was
never a measurement.

### The follow-up: a row the traveller TYPED keeps its resolution too

Read off the owner's own synced trip on 2026-09-06, which is the only reason it
was found: every activity on the Ko Phi Phi day carried a canonical record, and
`ChaoKoh Hotel Phi Phi Island` - the stay they had typed, and the ANCHOR of the
whole day - carried `place: NONE`.

`attachResolvedPlace` runs on the assistant's accept path and nowhere else, so
anything added through the form never kept the identity the app had already paid
Google for. Nothing looked wrong, because the session lookup feeds
`canonicalPointFor` and the row resolves correctly while the tab is open. It
simply re-resolved from a text query on every load, and until that landed the
day had no anchor at all.

`persistResolvedPlaces(results)` now runs when a Places batch lands. Three
guards keep it from becoming write churn: it only considers items whose lookup
is IN THAT RESPONSE (a warm repaint writes nothing), it saves once for the whole
batch, and it saves `outsideHistory` so a background resolution never becomes an
Undo step. `save()` already refuses in shared mode.

**IT FILLS A HOLE. IT NEVER OVERWRITES AN IDENTITY, and the first draft did.**
That draft compared the whole record and wrote on any difference, so a lookup
landing on boot quietly replaced a stored place ID with whatever the batch
answered - the "the app changed the place under me" failure of this very round,
reintroduced from the other end. `e2e/places.mjs` P13 caught all three symptoms
(a saved record not surviving boot, an unrelated time edit rewriting it, a
rename re-pointing it). The rule now is:

  - no record at all -> write it. This is the case the report was about.
  - a record with a DIFFERENT id -> never touched. A saved identity is the
    traveller's; a background re-resolution is not a licence to replace it.
  - a record with the SAME id but no usable coordinates, or coordinates aged
    past the 29 days we hold them -> position refreshed, identity untouched.

**One existing assertion changed, deliberately.** P13's third check asserted
`!place` after a rename. That tested ABSENCE as a proxy for "the old identity
did not follow the new name", which was the only way to express it while records
could arrive solely through the assistant. A renamed row now legitimately
re-resolves under its new name, so the check asserts the invariant directly
(`place.id !== 'PID_KEEPME'`) and a second one requires any record present to
belong to the new name. Strictly more specific than what it replaced.

**`privacy.html` was already wrong before this round touched it.** It still
described the pre-2026-09-06 rule ("coordinates only when the lookup could
confirm the city"), which the canonical-coordinate round had already replaced
and had failed to update - a binding document left stating something false for
the length of one PR. It now describes what actually happens: the coordinates
are kept whenever Google returns them, dropped on read when a TRUSTED city
position says they are far outside it, expiring at twenty-nine days, and applying to
a row whether it was typed or accepted. `Last reviewed` moved with it. Checking
that page is part of the diff, not a follow-up, and this is the second time this
codebase has learned it.

**Coverage.** `tests/canonical-coordinates.test.js` (18 pure tests: the carried
fields, the revived standin guard, resolution-keeps-its-point, the 809 km
refusal, the reported day, the contradiction detector, a **generic** small-island
lifecycle with no Thai place names at all, and return-to-hotel) - 11 of the 18
fail against master. `e2e/canonical-coordinates.mjs` (19 checks over the real
flow: Add to trip, reload, chip, footer, Day route pins, both links, cache
hygiene) - 9 fail against master. Two older tests that pinned "an unverified
resolution loses its coordinate" were REWRITTEN rather than deleted: they now
pin the rule that replaced it, and the 809 km case they were protecting is
asserted directly.

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
- **~~Why no automatic replacement of a closed candidate.~~ REVERSED
  2026-09-06, and the reversal is the point of the round below.** The
  original reasoning was: a constrained retry would double latency and spend
  "for a case the demotion already communicates", and the traveller can ask
  for a replacement in one message. It ended with "revisit only if closed
  candidates turn out to be common in practice". They turned out to be
  common in practice - see the section that follows - so the demotion is no
  longer the end of the story.
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

## Schedule validity: a verified place is not a usable one (2026-09-06)

The reported failure: a guided **"I want to be at my first planned stop at
8:00 AM"** day came back offering breakfast at 08:00 at **Only Noodles**,
which Google lists as opening at **10:30**, next to a second restaurant that
opened at 12:00. Nothing was wrong with the venues: right business, right
branch, right island, 4.7 stars from 1,481 real reviews. They were simply
unusable at the hour they were proposed for, and the app had no way to act on
that during SELECTION - it painted the cards red afterwards, dropped them from
the winner badges, refused the add, and left the traveller holding a breakfast
slot with nothing in it and no alternative offered. **Zero searches were ever
made for a place open at 08:00.**

This section supersedes the "why no automatic replacement" decision recorded in
the 2026-08-21 round above. That decision was explicitly conditional ("revisit
only if closed candidates turn out to be common in practice") and the condition
has now been met by real usage.

### The distinction the pipeline was missing

> **IDENTITY VALIDITY** "is this the real Google place?" (resolutionConfidence,
> verifyArea, typeMismatch)
> **SCHEDULE VALIDITY** "can it be used at the hour proposed for it?"
> (`scheduleEligibility` / `candidateScheduleTier`)
>
> Both are asked before a candidate may occupy a slot. A candidate that fails
> the second one is REPLACED, not decorated.

Only identity was ever a selection criterion. `REJECTION_STAGES` had nine
stages and none of them was about time; `placeQualityScore` and
`rankVerifiedPlaces` scored rating, review count and distance; `hoursVerdict`
had exactly two call sites in the whole client, `paintHoursSlot` (after render)
and `closedHoursFor` (at accept). Hours were post-render decoration and a
write-time veto, which together mean "we will tell you our recommendation is
useless, twice".

### Three tiers, and the middle one is why it is not a boolean

| tier | means | what happens |
| --- | --- | --- |
| `open` | verified hours cover the time **with the slot's whole planned duration left** | a normal recommendation |
| `unknown` | real place, no usable hours (or no lookup) | admissible only BEHIND every open candidate, and the card says the hours are unconfirmed |
| `invalid` | verified hours refuse the time | ineligible for that slot; replaced, never shown |

`unknown` is what keeps a beach, a viewpoint or a trailhead alive: Google
returns no hours for natural features, and a boolean gate would have deleted
every one of them. Absence of hours is never evidence, in either direction.
The reasons are named (`opens_after_slot`, `closes_before_slot`,
`closed_at_requested_time`, `hours_unknown`) and roll up per slot in the
rejection tally, so "breakfast: 0 accepted, 2 opens_after_slot" is one line in
the places debug log.

### The pipeline now

```
enforce the traveller's own first-stop hour   (no hours are read yet, deliberately)
-> verify IDENTITY
-> validate SCHEDULE against the proposed date/time/duration
-> group survivors by SLOT
-> for every slot a verdict emptied: ask the provider for more real places of
   that CATEGORY that are open then, and put those through both gates too
-> rank inside the slot (open ahead of hours-unknown, then quality)
-> trim to what was asked for, and say honestly what could not be filled
```

- **A SLOT is the unit**, not the reply. "Three breakfast options" is a promise
  about a slot. Slots are the model's own `group` id (`proposalSlotKey`); an
  ungrouped proposal is a slot of one, which is what keeps a single "Return to
  hotel" card single and stops a lone museum suggestion growing a second option
  nobody asked for.
- **A GUIDED PLAN IS A DISCOVERY REQUEST**, whatever words it used. This was
  the load-bearing bug: `assistDiscoveryIntent` is a regex over what the
  traveller TYPED, the picker's own wording contains no "find"/"recommend"/
  "suggest", so `discovery` was false and the guided path skipped verification
  entirely - cards first, hours later, no replacement path in reach. The regex
  is deliberately NOT widened (a false positive there silently deletes a venue
  the traveller typed). Instead the picker's constraints travel as DATA:
  `planConstraintsFrom(prefs)` -> `sendMessage(text, 'plan', plan)` ->
  `renderAssistAnswer({ plan })`, and `discovery = intent.discovery || !!hint
  || !!plan`. The copy/paste tier remembers the same object in
  `assistLastPlan`, because the reply comes back through someone else's chat
  window and this side never sees the request again.
- **The replacement search is CATEGORY-first** (`slotDiscoveryQuery`:
  "breakfast restaurant Ao Nang", "bar Tokyo", "tourist attraction Krabi"). The
  model has already proved it cannot be relied on to name a venue that is open,
  and a category is what Text Search is good at. The traveller's own words
  (`discoveryQueryFrom`) remain the fallback for a free-form turn.
- **The hours question travels with the search.** `discover.schedule =
  { date, time, windowMin }` reaches `discoverPlaces`, which runs the SAME
  `TripLogic.hoursVerdict` on the hours already inside the Place Details
  response it is paying for, and walks further down the free ID page instead of
  handing back another shut restaurant. The client re-runs the identical check
  on the identical normalized hours when the answer lands: the server filter is
  a saving, never a source of truth.
- **`no_open_candidates`** is a third answer beside `no_candidates` (the area
  really is empty) and `upstream` (nothing was checked). "This street has
  nothing" and "this street has plenty and none of it opens at eight" are
  different sentences.

### The bounds, and why each one exists

| bound | value | what it protects |
| --- | --- | --- |
| `DISCOVERY_REPLACEMENT_ROUNDS` | 1 | a second pass asks the same box the same question |
| `DISCOVERY_REPLACEMENTS_PER_ROUND` | 4 | per slot, per round |
| `DISCOVERY_CANDIDATE_MAX` | 12 | total candidates one slot may examine |
| `SLOT_REPLACEMENT_BUDGET` | 6 | **replacement candidates the whole reply shares** |
| `SLOT_REPLACEMENT_SEARCHES` | 3 | **slots per reply that may go shopping** |
| `DISCOVERY_SCAN_MAX` / `DISCOVERY_SCAN_HEADROOM` | 6 / +3 | Place Details a SCHEDULED search may spend looking past closed venues |

The last one is the non-obvious one. A venue is only discovered to be shut by
paying for its Details call, so a search for two open breakfast places that
stops after two closed ones reports an empty street. The reservation is an
upper bound that step (7) of the handler releases unspent, so a search whose
first candidates are open costs exactly what it used.

The whole-reply bounds matter because a guided day has five or six slots. Four
replacements each would be twenty-four extra billed calls for one press of
"Plan my day"; six shared, across at most three searches, is the ceiling.
Slots are served in the order the day runs, so the morning the traveller asked
about is filled before the evening.

### What triggers a search, and what deliberately does not

`slotReplacementNeed` adds two independent reasons rather than conflating them:
the slot is SHORT of cards (whatever the cause), and/or hours REFUSED one of
the cards it has. **A slot whose candidates are merely hours-unknown asks for
nothing**: nothing was learned against them, and buying a replacement for a
venue we have no complaint about is exactly the cost the old design was right
to avoid.

### The first stop is a constraint now, not a hope

`firstStopShiftPlan` is deterministic and runs BEFORE any lookup, which is the
whole design: hours cannot reach it, so "the restaurant opens at 10:30" can
never become a reason to call the traveller's 08:00 negotiable. When a venue
cannot serve the hour the answer is a different venue. It pulls the day's
earliest timed ACTIVITY to the requested hour (travel legs are exempt by type -
the request says "with any travel to it before that time"), refuses to move
anything if the second stop would collide, and re-validates the action rather
than patching display strings, so a card can never say 09:00 while the item it
would create says 08:00.

### The sitting length, corrected

`RECOMMEND_HOURS_WINDOWS` used a flat `meal: 30` on the reasoning that a
published closing time is an ARRIVAL constraint. That is true of a coffee and
false of a dinner, and it stopped being harmless the moment the window decided
whether a venue is REPLACED rather than merely coloured red: an under-tight
window keeps an unusable venue in a slot that had alternatives. Now per kind:
breakfast 45, brunch 60, lunch 45, dinner 60, generic meal 45, drinks 45,
museum 60, gallery 45, cafe/snack 30 (grab-and-go genuinely IS an arrival
constraint), shop 30, default 45.

Two related bugs found while auditing it: `proposalHoursHtml` and
`closedHoursFor` each built their own probe object and BOTH dropped `meal`, so
every Food & Drink proposal was judged by the generic default instead of its
own sitting - `sanitizeActionFields` lifts "Dinner:" out of the title, which
leaves the title-prefix fallback nothing to read. One derivation now:
`recommendWindowForFields`.

### Timezones: audited, and the answer is that there is no timezone math

Every itinerary time is a floating local time for the destination, and every
hours period is minutes past midnight in the venue's own local time. They are
therefore directly comparable and nothing converts anything. The one place a
machine's clock could have leaked in is the weekday, and `hoursDow` parses the
ISO date at UTC midnight (`new Date(date + 'T00:00:00Z').getUTCDay()`), so
"2027-01-27" is a Wednesday in Louisiana, in Bangkok and on a Frankfurt build
server alike. Pinned by a test that runs the same fixture under five values of
`process.env.TZ` either side of the date line. **"Open now" is never asked and
would be the wrong question**: these itineraries are for future dates, and the
weekly pattern for the requested weekday is what decides.

### What the traveller sees

- A verified-closed candidate is **not among the choices at all**. The
  demotion, the badge exclusion and the accept refusal all remain, unchanged,
  as defence in depth for anything that reaches a card by another route (an
  explicit-place turn, a late verdict, a provider that answered after render).
- An hours-unknown candidate that survives into a schedule-checked slot paints
  **"Hours unavailable · verify before going"** in amber. Everywhere else
  unknown hours stay silent, which is still right: nobody claimed anything
  either way there. The state rides on `data-hours-unconfirmed`, set only by
  the pipeline.
- The shortfall sentence is separate from the identity one:
  `scheduleShortfallNote` says "I could confirm one breakfast place open at
  8:00 AM, not three", where `rebuildAssistProse` would have said "I could
  verify one good match for this area" - a claim about existence, which is the
  wrong explanation when three real restaurants were found and two were shut.
  A provider failure still outranks both: nothing was learned, so no count may
  be claimed. Nothing is said about a slot that went fine.

### A prose bug found by the new e2e

`proseMentions` tested `hay.includes(word)`, a SUBSTRING match. "Morning Star
Kitchen" (a surviving replacement) matched the word "start" in "Only Noodles is
a great start to the morning", which made the block count as naming a kept
venue and kept a REJECTED venue's recommendation in the answer with no card
under it. The same shape gives "Anna" a hit inside "banana". Now a word-set
membership test, which `foldWords` already makes trivial.

### Meal fitness: open is not the same as appropriate (2026-09-06, pre-merge QA)

Schedule validity answers "is it open at eight". It has no opinion about
whether a steakhouse that happens to open at eight is a BREAKFAST
recommendation, and with rating as the only other term it led a lower-rated
brunch place - while the category search that went looking for "breakfast
restaurant" had its own relevance ordering discarded on arrival.

- **The evidence is Google's Places TYPE, never a word from the venue's name.**
  `DETAILS_FIELD_MASK` already fetched `types,primaryType` for the mismatch
  gate; `fromDetails` simply never passed them on. `foodTypeOf` now picks the
  most specific allowlisted food type (`breakfast_restaurant`, `bakery`,
  `steak_house`, `wine_bar`...) and it travels as one short word, passed
  through and never stored, exactly like hours.
- **The type travels, the VERDICT does not, and that is a bug avoided rather
  than a preference.** A session cache entry is keyed by venue and area with
  the meal slot deliberately left out, so one entry serves a breakfast slot and
  a dinner slot; a fitness verdict baked in server-side would be whichever slot
  looked it up first. `TripLogic.mealFitness(foodType, meal)` maps per slot.
- **Only positive evidence moves anything.** `restaurant` and an absent type
  are the same answer - no opinion - so a trattoria with a broad menu is never
  demoted. A candidate is promoted only when Google says it IS a place of that
  daypart, and demoted only on outright contradiction (a night club at 08:00).
  Cuisine types are deliberately absent: a `thai_restaurant` is not a daypart.
- **It is a score, not a gate**, and sizing it needs BOTH axes. The first
  attempt (0.35) was calibrated against the star rating alone and the
  review-count weight ate it: 4.6-from-640 sits 0.40 below 4.8-from-2,000, not
  0.16. The browser block caught it. At 0.5 the measured boundaries are:

  | comparison | score gap | outcome |
  | --- | --- | --- |
  | 4.8/2,000 steakhouse vs 4.6/640 bakery | 0.40 | the bakery takes the slot |
  | 4.9/1,000 restaurant vs 4.3/1,000 breakfast place | 0.48 | the breakfast place takes it |
  | 4.9/1,000 restaurant vs 4.0/1,000 breakfast place | 0.72 | quality wins |
  | 4.5/3,000 restaurant vs 4.4/150 cafe | 1.04 | quality wins |
  | 4.9/5,000 institution vs 3.9/200 bakery | 1.53 | quality wins |

- **Nothing is excluded and the badges do not move.** The steakhouse is still
  offered, and it still wears `Highest rated` if that is what it objectively
  is: the badge is a fact about the set, not a recommendation. Only the ORDER
  of the slot changes.

### Cost, measured

For the reported shape (three breakfast candidates, two shut, replacements
found) the turn costs **the three named lookups it always cost, plus one free
ID search, plus 2-4 Place Details for the replacement scan**. The scan stops
the moment the slot is full. A day where nothing is refused costs exactly what
it did before this round: no search is issued at all.

### What this still cannot guarantee

Everything the 2026-08-21 section already lists (stale provider hours, holiday
closures outside the dated window, last-entry and kitchen-closing times,
reservation-only seatings) plus: a category search is only as good as Google's
Text Search ranking for that category in that area, and a slot in a genuinely
empty area still ends up short - honestly labelled, which is the point.

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
- The coordinate goes in `trip-planner:venuegeo:v2`, sharing that store's
  29-day TTL. An OSM coordinate is under no such obligation - the TTL exists for
  Google's terms, and is 29 rather than 30 because the grant counts calendar
  days (see "The two 30s") - but sharing one store is worth more than a second
  one, and expiry just means the row is looked up again later.

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

## The 2026-08-22 audit round: what the fixes actually settled

A full black-box audit (AUDIT-2026-08-22.md, kept beside this file) produced two
High and eleven Medium findings. The first round of fixes covers the core
correctness set; what is worth keeping from it:

**A connection is between two LEGS, and a test said otherwise for months.**
`connectionWarnings` walked the whole sorted item list and skipped any pair
whose ends were not both travel, so ONE note, meal or activity between two legs
broke the pair and the warning vanished - on exactly the trips that have things
planned in them. The unit test that should have caught it instead pinned the
bug, with the reasoning "an activity between the two legs means they are not
back to back". That premise is wrong (a 30-minute change is 30 minutes whether
or not you also planned a coffee in it) and it is the reason the defect
survived. The walk now filters to legs first; every suppression rule that
SHOULD fire - a timeless leg, a stopover bed, a cancelled leg, more than 24
hours apart - is unchanged and separately pinned.

**"No stays" is not "every night is covered".** `coverageGaps` measures from the
first check-in and answered `[]` with no stay to measure from, so a trip with no
booking at all showed no warning and no strip while the summary chip counted "0
of 4 nights booked". It takes an optional `tripStart` for that case only (the
two stay-prefill callers deliberately pass nothing and keep the old answer), and
`renderStrip` lost its `!stays.length` gate - which mattered twice, because the
warning's own "show" action rings strip cells that were never drawn.

**repairTrips now covers every field a renderer trusts, and only the ones
present.** `location: 123` threw inside `dayMorningCity` and emptied the whole
Days view; `startTime: 5` emptied the Timeline too. The caps and the rules match
`sanitizeItem` so the import/share path and the storage/sync path normalize
identically, and `CLOCK_RE` is now a real clock (`99:99` matched the old
shape-only test). Deliberate: absent keys stay absent. Adding a field to every
legacy item would rewrite the whole db on the first boot after a deploy, and a
repair write landing during a remote apply is the one thing the sync model asks
us not to make more common (see the known edge above).

**One owner for "which trip am I looking at".** `setActiveTrip` sets the id and
drops the selection, because a selection is made from the rows of the board it
was made on. Only the trip picker used to do that, so a cross-trip search jump,
the overlap warning's link, a duplicate, a template, an import or a restore
landing elsewhere left the bulk bar over another trip's board reading "0
selected". Filters are deliberately NOT reset by it.

**A dialog belongs to the trip it was opened for.** The packing dialog read
`activeTrip()` on every write, so after another tab deleted that trip it either
edited a stranger's list or threw on `undefined.push` and saved nothing in
silence. It now records `ui.packingTripId` and re-checks it on every write, the
same contract `ui.editingId` and `ui.tripEditId` already follow: the dialog stays
open, the WRITE re-checks its target.

**A promise an undo cannot keep.** Deleting a trip purges its attached documents
immediately (they live in IndexedDB against the item ids), while the confirm
said only "You can undo this until you reload the page". The item and bulk
deletes had always named that cost; the trip delete now does too.

**Two failures wearing one symptom.** "No exchange rate for JPY ... re-enter it
in a currency the rates cover" was printed when the rate table had simply never
arrived, sending travellers off to retype money that was fine. The line now
branches on `ratesFailed` and points at the Retry the totals already offer.

**Harness trap this round minted, and it nearly invalidated the round.** A
server that is already listening on `BROWSER_TEST_PORT` is not ours: our python
server fails to bind, `httpOk` answers from the stranger, and every suite runs
against whatever THAT serves. A stale server on 8099 pointed at another checkout
made a full trip-planner run report 512/512 green against code that did not
contain the change under test. `run.mjs` now bind-tests the static and CDP ports
first and refuses to start. If a suite ever looks impossibly green, check which
tree the port is serving before believing it.

The CDP half of that guard has to test BOTH stacks. A leftover headless Chrome
listens on `::1` while `127.0.0.1` still binds, so an IPv4-only probe calls the
port free, the runner attaches to a browser it does not own, and the estate dies
mid-run when that process finally exits (`timeout: Runtime.evaluate`, then
ECONNREFUSED for every suite after it). Measured while chasing exactly that:
with a listener on `::1` alone, an IPv4 bind test answers "free" and an IPv6 one
answers "taken". A related hazard worth knowing: snap chromium orphans survive a
killed runner, so `ps -eo pid,args | grep headless=new` before blaming a suite -
four of them, one four hours old, were what made two full-estate runs collapse
at different points while master ran clean.

## The 2026-08-22 fix round, part two

Everything below shipped in the same PR as the core round above. What is worth
keeping:

**A model may not touch what the traveller has booked.** `validateTripAction`
ran a model-supplied status through `forceProposalStatus`, which can never
return 'booked', so an `update` that so much as mentioned status demoted a
Booked flight - and its money - to "To book" over a change of address. An update
now carries the TARGET's status, full stop, and `applyProposalUpdate` writes no
status at all: the field is a fact about the world, and the model can neither
observe nor change it. `forceProposalStatus` stays for adds, where it stops a
model claiming a booking it invented (a document transcription keeps its
provenance). The old unit test asserted the demotion as correct behaviour; that
is why the bug survived a full audit round.

**The assistant needs its own projection, and always did.** It was handed
`slimTripForShare`, which renumbers ids to `i1..iN` because a share link becomes
a new trip - while the prompt tells the model it may "update with a match (by id
or exact title)". Every id-matched edit therefore failed with "No matching item
found". `slimTripForAssistant` keeps the real id and drops the booking facts a
model has no use for (confirmation, paidBy, splitAmounts, payment, bookBy).
Resolving `iN` by POSITION was considered and rejected: validate runs again at
ACCEPT time, so a row deleted in between would have moved the edit onto whatever
slid into that position. A real id resolves to one row or to none.

**"Not open yet" is not "closed" (HR-01).** `hoursVerdict` collapsed both into
'closed', so a 17:30 row at a bar open 18:00-02:00 read "Closed at 5:30 PM".
There is a fourth verdict now, `beforeOpen`, carrying `opensMin`, and
`nextOpeningMin` is the one place that answers "does it open again later today"
(dated hours authoritative for the dates they name). Every consumer reads that
one verdict: the Days row, the assistant card, the badge exclusion and the
accept refusal, which has its own heading and sentence because the way forward
is a later hour, not another venue. Both demoted states still demote; only the
sentence differs. Boundaries: exactly at opening is open, exactly at closing is
closed, between two sittings names the next sitting, an overnight range is open
past midnight and `beforeOpen` again after it closes if the venue reopens that
day, `closed` if it does not.

**A day has two beds and they are two questions.** `dayHostStay` answers "which
bed is this NIGHT booked in" (night coverage, the staying-at line, the day's
city). `dayAnchor` was using it for "where does this DAY START", which is the
same hotel on every day except a handover: check out of Tokyo, train at 10:30,
check into Kyoto, and an 8:00 Ginza breakfast was measured from the Kyoto hotel
(~232 mi, with Directions from the wrong end of the country). `dayMorningStay`
answers the morning; the chain hands over by itself because the intercity leg is
a stop on it. One filter, two orders of preference, so they cannot drift.

**A budget is a number in a currency.** Switching the trip currency converted
every cost and RELABELLED the budget. `budgetCurrency` is stamped when the
currency moves, exactly as `stampCostCurrencies` stamps items, absent means the
trip's own so nothing migrates, and `tripBudgetIn` converts through the same
`convertAmount` the totals use. Unreachable rates print the ceiling in its own
currency and force the amber "partial" verdict rather than a green tick over a
number nothing could compare.

**A pre-trip task is a deadline, not a trip day.** The visa reminder was a note
DATED thirty days before the trip, and `tripStats.start` is the minimum over all
items, so the trip grew a month of empty day cards and counted down to the
reminder. `bookBy` already models "do this before" and the warnings panel
already counts it down.

**Hidden-until-hover is a mouse affordance.** Timeline row actions had no
pointer gate, so on a touch device WIDER than the 900px fold there was no way to
reveal them at all. The Days view had always gated its own pair; both do now.
Related: `@media print` redefines the colour tokens rather than trusting
backgrounds the printer will not lay down (measured 18.9:1 on titles with
background graphics off), and the assistant panel makes room above 1200px
instead of covering Undo, the trip picker and the menu.

**Failures deserve a memo too.** Successes were cached and misses were
remembered, but a 500 or a timeout was not, so during an outage every consumer
re-asked and every render re-fired: 11 geocode requests for 4 places in one Map
render, 6 weather requests per Days render. Both now hold a 60-second per-key
memo, and a valid-but-empty weather answer counts as a failure for it.

**Where the docs sat two rounds behind.** privacy.html still said the assistant
defaulted to copy-and-paste after the 2026-08-19 round deliberately moved it to
the free tier. The page is binding, so it was the page that was wrong, and
`tests/static/trip-planner-assistant-privacy.test.mjs` now pins the default
literal and the omitted-field list against the prose so neither can drift alone.

**Two audit findings did not reproduce.** MV-B3's "full-width bar at 0" is the
empty track behind a zero-width fill (`typeBarShares` already returns 0 when
every row is 0), and DM-12's single-bar spend chart is the documented
two-calendar-week gate doing what it says.

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

## Exports carry text a stranger chose

A share link is a URL fragment anyone can send, and its titles, places, details
and notes reach the CSV and ICS exports unchanged.

- **CSV formula injection.** `csvCell` quoted and doubled quotes, which does
  not stop a cell whose text begins with `=`, `+`, `-` or `@` being evaluated
  by Excel, Sheets and LibreOffice. There are now two escapers: `csvCell` for
  machine-written columns (dates, numbers, enum labels) and `csvTextCell`,
  which prefixes an apostrophe, for the columns a person can put words in.
  The split matters: a refund is a real negative number and the
  "spreadsheet SUM equals the app total" property depends on the cost columns
  staying bare.
- **ICS bare carriage return.** `icsEscapeText` folded `\r\n` and `\n` but
  not a lone `\r`, which is a line break inside a VEVENT, so a title could
  inject a calendar property (ATTENDEE, URL) into the exported file. The regex
  is now `/\r\n?|\n/g`.

## CORRECTION: the tp-places / tp-assist quota CAS was NOT atomic

This file said, of the reservation: "Atomic. The reservation runs inside the
existing etag CAS ... 50 concurrent batches arriving with 10 calls left
authorise 10, not 600. Pinned by a barrier test." That was false in production
for the 25 days after the CAS landed, and the barrier test could not see it
because it stubs the store with conditional-write semantics the shipped client
did not have. `@netlify/blobs` was pinned `^8.1.0`, whose `setJSON` has no
conditional write at all. Against the real 8.2.0 client, 50 barrier writers
were ALL told "reserved" and 49 reservations were lost. See the root
`FINDINGS.md` entry and `netlify/functions/tests/blobs-version.test.mjs`; the
package is now `^10.7.13`, the first version whose `setJSON` puts the condition
on the wire, and the claim above is true as of that bump.
