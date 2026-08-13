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
  in-flight dedup), Open-Meteo geocoding = city typeahead, Photon = hotel and
  venue typeahead, bundled OurAirports table = airports (offline). Never move
  a lookup between providers without re-reading their usage policies.
- **Google Places legal lines** (2026-07-20 review): place IDs cacheable 30d,
  lat/lon cacheable 30d (`trip-planner:venuegeo:v1`, cap 300), names/ratings
  NEVER stored. The server's rating layer was found still persisting `pd:`
  details blobs (unread, unbounded); removed 2026-08-13. Keep it removed.

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
- tp-places: reservation-before-spend via etag CAS; resolve step is wrapped
  so a Blobs I/O failure returns the JSON contract (batch `unavailable`) and
  keeps the reservation (never under-count spend). Known accepted edges: two
  sequential 9s upstream deadlines can exceed Netlify's 10s ceiling (burned
  reservation until rollover); a failed Place Details call counts as spent;
  per-client caps are advisory (clientId rotation) - the global/monthly pools
  are the real cost control ($10/month worst case public tier).
- tp-assist deliberately does NOT refund quota on upstream failure (fails
  closed); Google's own free-tier limits bind before ours anyway.
- The origin check is defense-in-depth only (no CORS enforcement, header is
  forgeable); quotas are the actual control.

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

## Decisions from the 2026-08-13 audit round

- Assistant replies land only in the thread of the trip that asked
  (`handleAssistantReply` guards on trip id; history is keyed by trip id so
  nothing is lost). Accepting a proposal moves the distance anchor only when
  the added item is on the focus day.
- Rejected feature ideas, on purpose: a "trip readiness" dashboard (the
  warnings panel + Progress chip already answer it; a second surface would
  dilute both), a today-view (trip-in-progress mode + Up next chip cover it),
  a light theme (site rule), calendar-grid visualization (Days view is that).
  The app is feature-saturated; additions need a traveler problem the
  existing surfaces demonstrably fail.
- The geocode cache (`trip-planner:geo:v3`) is capped at 500 entries,
  oldest-inserted evicted first (entries carry no timestamp; do not add one
  without bumping the key version).

## Testing

- `npm run test:trip-planner` - pure-logic suites under `tests/` (node:test,
  no installs). Function suites run from `netlify/functions` or via root
  `npm test`. Browser-level checks are ad-hoc headless-Chromium probes via
  `~/.claude/projects/-home-nikita-projects-shevato/tools/screenshot.sh`
  (see traps above); screenshots land in `.screenshots/` (gitignored).
- When touching an item field, walk the full pathway list: render (both
  views), edit modal round-trip, duplicate, undo, JSON/CSV/ICS export,
  share link, sync, filters, search, AI proposals, templates, repairDb.
