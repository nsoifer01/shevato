# Testing audit and hardening, 2026-08-15

Repository-wide audit and rebuild of the testing strategy for shevato.com and
every app under `apps/`. Constraint honored throughout: **zero production code
was modified**; every change is in tests, test infrastructure, test
configuration, CI configuration, or documentation. Product bugs discovered by
new tests are catalogued below and left unfixed by design.

## Executive summary

- **Before: Good foundations, uneven and blind in specific ways.** A genuinely
  strong zero-dependency stack (Node's built-in test runner + a hand-rolled
  Chrome DevTools Protocol browser harness) with 3,433 unit tests and a
  516-check browser suite, but: whole app cores untested (the four largest
  files in the repo, 7,300 to 9,200 lines each, had zero coverage at any
  layer), a browser harness that could not detect a broken local asset, about
  150 gym-tracker assertions testing hand-copied mirrors of app logic rather
  than the app (one mirror had already drifted), Arena browser checks writing
  to production Firebase on every run, no accessibility, visual, performance,
  PWA (gym), cross-browser, or coverage tooling at all, and two silently
  flaky browser checks.
- **After: Strong.** 3,942 unit/static tests (0 failures) plus a 785-check
  browser estate across eight suites, accessibility scans + keyboard checks,
  deterministic visual geometry checks, performance budgets, offline/PWA
  coverage for both service-worker apps, a Firefox/WebKit cross-browser
  smoke, per-area coverage floors, a documented known-defect quarantine
  holding **30 catalogued product defects and observations** found by the
  new tests, and a README contract for future changes. No test depends on
  live third-party services or production Firebase anymore.

Rating before: **Needs Work** (excellent core logic testing, dangerous blind
spots). Rating after: **Good, verging on Excellent** within the limits
documented in "Remaining limitations".

## Previous state (measured baseline, before any change)

- Frameworks: `node --test` (Node 20) for unit; custom CDP harness
  (`tests/browser/`) for browser E2E. No other frameworks. Zero installed npm
  packages (no node_modules, no lockfile; CI never ran npm install).
- `npm test`: 3,433 tests, 3,432 pass, 1 skip, ~140 s.
- Browser suite: 516 checks, **514 pass, 2 fail** (trip-planner assistant
  distance-chip checks; root-caused during this work to a harness bug, see
  below). Chromium only.
- Coverage (measured on master, source files only, line-weighted, test files
  excluded): **88.76% line / 85.45% branch / 87.55% functions** across the
  117 source files that tests loaded. The number flattered reality: files
  nothing loaded (including the four largest app cores) were invisible to it.
- CI: unit tests + partial syntax checks on every push/PR; browser suite on
  PRs only. No lint, coverage, a11y, visual, perf, or cross-browser jobs.

### What was wrong or missing (top findings from the audit)

1. **Untested cores.** `apps/arena/js/app.js` (7,447 lines: the entire room
   lifecycle), `apps/maptap-rivals/js/app.js` (7,343), the live add-game path
   in football-h2h, mario-kart's addRace/editRace/achievements, gym-tracker's
   TimerService/StorageService CRUD/service worker, the 1,080-line sync
   engine (protected only by 14 regex "source shape" assertions).
2. **Tests that could not fail.** Gym-tracker "mirror" tests asserting
   hand-copied logic (about 150 assertions across ~10 files; the collapse
   state-machine mirror had already drifted from the shipped code);
   tautologies (tests asserting their own constants, a JS-semantics test, an
   FPL check pinning "3 seasons" as a literal after the fourth season landed,
   an e2e ternary with identical branches, a literal `true` assertion).
3. **A blind error gate.** The browser harness collected network failures but
   never asserted them, and its console noise filter swallowed
   `Failed to load resource` and `firebase`, so a 404 on a local stylesheet
   or a sync-layer exception could not turn any suite red.
4. **Production side effects.** The Arena browser checks signed in and wrote
   room documents to production Firebase on every run.
5. **Silent flake.** All 8 `closePage` calls in the trip-planner assistant
   e2e suite passed one argument instead of two, making page closing a
   silent no-op; the leaked tabs' storage listeners raced later blocks'
   seeds. This was the root cause of the two baseline failures.
6. **Missing layers.** No a11y, visual, perf, PWA (gym), cross-browser, or
   coverage tooling; apps.html search/filters and the moadon-alef language
   switcher completely untested; fpl-planner absent from the desktop browser
   suite.

## Changes made

### Framework decisions (Phase 10)

- **Kept:** `node --test` and the custom CDP harness. Both are deliberate,
  documented, high quality, and aligned with the repo's zero-runtime-
  dependency rule. Migrating to Vitest/Jest/Cypress/Playwright-for-everything
  would have solved no concrete problem here and was rejected.
- **Added:** `playwright` as the repo's only dev dependency, used solely by
  the cross-browser smoke (`tests/cross-browser/`), driven by `node --test`
  rather than Playwright's own runner so the repo keeps one test idiom. It
  answers the one question the CDP harness architecturally cannot: does the
  site work in Gecko and WebKit? Main CI remains zero-install; only the
  weekly cross-browser workflow runs `npm ci`.
- **Added (vendored, not an npm dependency):** axe-core 4.10.3 at
  `tests/browser/vendor/axe.min.js`, injected by the a11y suite; same
  vendoring convention as the site's jQuery.
- **Rejected:** Lighthouse CI (heavy, flaky in CI; replaced by deterministic
  byte/request/DOM budgets measured from baseline), pixel-snapshot visual
  baselines (font rendering differs across machines; replaced by
  deterministic geometry and computed-style assertions), a Firebase emulator
  harness for Arena (right answer eventually, but it requires production
  refactors this task was forbidden to make; documented as the top
  recommended next step).

### Test infrastructure fixed

- CDP driver: navigation handler leak fixed; navigation timeouts surfaced;
  network failures now carry URLs and `firstPartyFailures()` is asserted on
  every page and app (closes the local-404 hole); touch emulation on mobile
  viewports; `api.openai.com` added to the blocked external hosts.
- Runner: one crashing suite no longer aborts the rest; expected check counts
  pinned for the site and apps suites so a mid-suite crash cannot silently
  shrink the denominator; teardown waits for real process exit.
- Trip-planner e2e: the `closePage` no-op bug fixed everywhere (this alone
  removed both baseline failures; 6+ consecutive green runs since); 27 of 33
  fixed sleeps replaced with condition waits; a midnight-sensitive assertion
  made deterministic; weak and vacuous assertions replaced.
- FPL: the stale "45 trajectories" pin now derives from `KNOWN_SEASONS`; the
  one wall-clock perf assertion converted to CPU time; archive-dependent
  skips now have pinned counts so they cannot silently vanish in CI.
- Gym: every mirror test replaced with real extracted source (shared helper
  `apps/gym-tracker/tests/helpers/source-extract.mjs`); tautologies deleted;
  the repo-walking singleton test scoped away from 35k generated pages.
- Arena browser checks now intercept and fail all Firebase hosts: **no test
  writes to production services anymore.**

### Test coverage added (by area)

- **Site:** apps.html search/category filters/?q= deep link, moadon-alef
  trilingual switcher (incl. RTL and per-language mobile overflow), apex
  shell, robots metas, header dropdown, per-page first-party network gating.
  New static layer `tests/static/` (114 checks): internal-link integrity
  (clean-clone aware), duplicate ids, web manifests, JSON-LD validity,
  complete first-party syntax sweep.
- **Sync engine:** new behavioral harness (in-memory Firestore stub) driving
  the real `storage-sync-robust.js`: debounced batched flushes, requeue
  without clobbering newer writes, remote apply through the LWW decision,
  drift reconcile on visibilitychange, initial-merge gating, oversize
  rejection, stopSync/queueSize. 164 sync tests total.
- **Gym-tracker:** 509 to 571 tests: service-worker precache completeness +
  offline fetch behavior (vm harness), TimerService under mock timers,
  StorageService CRUD + id-type round trips, import validation, non-UTC/DST
  date behavior, analytics shim.
- **Football-h2h:** 112 to 189: the LIVE add-game path, H2H aggregates with a
  drift guard against playerStats, undo/redo, date filters, import/migration
  (new vm harness).
- **Mario-kart:** 44 to 104: addRace/editRace validation, stats edge cases,
  week/month filters, chart aggregations, migration behavior.
- **MapTap Rivals:** 186 to 207: honest continent-classifier seam tests,
  duplicate-day semantics at the stats layer, network payload clamps.
- **Rising Shows:** 252 to 302: data-pipeline producer tests (split-data,
  build-data) tied to the real consumer, ScrollMemory persistence, harness
  load failures made loud.
- **Trip-planner:** 890 to 917 unit (travel-mode/directions-link agreement
  invariant, leap-day spans, template/hotel ranking exports); e2e 223 to 257
  (repairDb boot repair, canned-Photon hotel picker, degraded exchange-rate
  UI, map-view offline states, booking-import dialog).
- **FPL:** 870 to 936 unit (12 previously untested dashboard exports incl.
  the season-rollover withheld view, charts, squad table, scroll lock,
  availability env gate); netlify fpl proxy 29 to 33 (x-fpl-* headers,
  memoryStore fallback, labeled 503).
- **Netlify tp-assist:** the "unreachable" handler steps were reached via a
  module-resolution hook on the lazy blobs import: 9 new tests (quota
  wiring, 429/502/503 mapping, fails-closed no-refund rule).
- **New browser suites:** a11y (axe + keyboard/focus), visual (deterministic
  geometry/theme/collision pins at 3 viewports), perf (measured budgets),
  pwa-gym (registration, caches, offline reload, cleanup). See the sections
  below for what they hold.
- **Cross-browser:** `tests/cross-browser/smoke.test.mjs`: Firefox + WebKit
  boot every page and app clean, apps-hub search works, gym-tracker
  interaction responds.

## Final testing architecture

See README.md "Testing" for the layer table, commands, and the future-change
contract. One-line summary: static checks + unit/integration in `node --test`
(the fast merge gate), a Chromium CDP estate for E2E/a11y/visual/perf/PWA,
Playwright smoke for Firefox/WebKit, and a coverage wrapper with per-area
floors.

## Coverage by application

Legend: U unit/integration, E browser E2E, A accessibility (axe + keyboard on
its root page and key states), V visual geometry, M mobile viewport, Err
error-path coverage. FULL/part/none describe behavior coverage, not file
coverage.

| Area | U | E | A | V | M | Err | Notes |
|---|---|---|---|---|---|---|---|
| Marketing site + hub | part | FULL | FULL | FULL | FULL | part | Search/filters/switcher/nav/forms E2E; main.js auth modal has keyboard checks only |
| Arena | part | part | FULL | FULL | FULL | part | Extracted modules deep; room lifecycle still browser-smoke only (no emulator; see limitations) |
| Football H2H | FULL | FULL | FULL | FULL | FULL | FULL | Live add path now vm-tested; correctness asserted in browser |
| FPL Planner | FULL | FULL | FULL | FULL | FULL | FULL | Deepest estate; engine + UI + proxy + e2e lifecycle |
| Gym Tracker | FULL | FULL | FULL | FULL | FULL | FULL | Views via source extraction; SW at unit + browser layers |
| MapTap Rivals | part | FULL | FULL | FULL | FULL | part | stats/network deep; app.js IIFE reachable only via browser |
| Mario Kart | FULL | FULL | FULL | FULL | FULL | part | Achievements engine still uncovered (large, low risk) |
| Rising Shows | FULL | FULL | FULL | FULL | FULL | FULL | Producers + consumers tied; finder E2E data-gated |
| Trip Planner | FULL | FULL | FULL | FULL | FULL | FULL | Reference estate |
| sync-system | FULL | part | n/a | n/a | n/a | FULL | Behavioral harness on the real engine; RTDB path out of scope |
| Netlify functions | FULL | n/a | n/a | n/a | n/a | FULL | fpl/tp-assist/tp-places incl. degradation paths |

## Final counts

- Unit/static (`npm test`): 3,942 tests, 3,917 pass, 0 fail, 1 deliberate
  data-gated skip, 24 known-defect todos, ~2 minutes.
- Browser (`npm run test:browser`): 785 checks, 774 pass, 11 known-defect
  expected-failure skips, 0 failures; two consecutive full runs identical.
- Cross-browser (`npm run test:cross-browser`): Firefox 4/4 locally; WebKit
  4 checks CI-only (clean skips locally with the reason printed).

## Coverage metrics

Unit/integration layer, source files only, test files excluded, line-weighted
(tests/coverage/run.mjs; report in `.coverage/summary.md`):

| | Line | Branch | Functions | Files |
|---|---|---|---|---|
| Before (master) | 88.76% | 85.45% | 87.55% | 117 |
| After | **90.05%** | **85.03%** | **88.11%** | **130** |

Read these numbers with care, in both directions:

- Files that only browser tests exercise never appear in V8 coverage, and
  neither do files loaded via `node:vm` or tested by source extraction
  (mario-kart's core files, football-h2h's sidebar, analytics.js, both
  service workers all have real tests but are invisible here).
- The branch figure dipping 0.4pt while 13 more files are measured is the
  honest trade: the new sync harness pulled the real 1,080-line engine into
  measurement for the first time (sync-system went from 3 measured files at
  90% to 4 files at 85% covering far more real surface).
- The large remaining unmeasured surface is the app-core IIFEs
  (trip-planner/arena/maptap/rising-shows app.js, 5,600 to 9,200 lines each)
  plus gym views: those are covered behaviorally by the browser estate, not
  by unit tests, and that is a deliberate layering decision, not an
  accident. Nothing was excluded to inflate a percentage.

Floors (tests/coverage/floors.json, enforced by `npm run test:coverage`):
arena 85, football-h2h 96, fpl-planner 87, gym-tracker 73, maptap-rivals 96,
rising-shows 88, trip-planner 96, netlify-functions 87, sync-system 82 (line
%). Set from measured values minus a working margin; lowering one requires a
written justification here.

## Browser matrix

| Engine | Depth | Where | When |
|---|---|---|---|
| Chromium | Full estate (E2E, a11y, visual, perf, PWA) | `npm run test:browser` | Every PR + master pushes (CI), locally on demand |
| Firefox | Smoke: every page + app boots clean, hub search, gym interaction | `npm run test:cross-browser` | Weekly CI + dispatch; runs locally |
| WebKit | Same smoke | same | Weekly CI + dispatch; **CI only** (needs system libraries this dev machine cannot install; verified skipping cleanly with the reason printed) |
| Mobile viewports | 390x844 with touch emulation across site + all apps; tablet 768x1024 for site pages and app roots | site/apps/visual suites | With the browser estate |

## Visual regression testing

`tests/browser/suites/visual.mjs`, 86 checks, output byte-identical across
three consecutive runs: horizontal overflow on every page and app at
1280/390 (+768x1024 for apps, their first tablet coverage), dark-theme
integrity per app (background/text luminance on each app's real paint
surface), `main.css` collision pins (two stable controls per app must never
compute to the `#555` gray that main.css forces with `!important`), shared
chrome geometry incl. real hit-testing of the header, apps-hub column
behavior at both widths, gym/trip modals fully in-viewport at 390 with
covering overlays, and an inner-overflow-leak detector at 390. Zero
collisions and zero leaks exist today, so there is no allowlist: any future
hit is a genuine regression.

## Performance testing

Deterministic budgets in `tests/browser/suites/perf.mjs` (41 checks):
first-party transfer bytes, same-origin request count, and DOM node count
for home, apps, and all eight app roots, plus a home-page JS-weight guard.
Budgets are set at roughly 45-50% headroom over the measured 2026-08-15
baseline (measured values recorded beside each budget in the suite; e.g.
home 1.04 MB / 24 requests / 313 nodes against budgets of 1.55 MB / 36 /
470). Byte, request, and DOM numbers were exactly identical across three
runs; the only timing check is a deliberately loose 8s DOMContentLoaded
disaster threshold (measured 93-212 ms). rising-shows' budget excludes the
gitignored ~102 MB release dataset so it governs code weight and holds on
clean clones. Lighthouse CI was evaluated and rejected (heavy, CI-flaky);
these budgets catch the static-site regression class that matters.

## Accessibility

`tests/browser/suites/a11y.mjs`, 33 checks: axe-core 4.10.3 (WCAG 2.0/2.1
A + AA) over all 8 site pages, all 8 app roots (Arena with Firebase
intercepted, no production writes), and two deep app states (gym program
modal open, trip-planner Days view with the example trip), plus 15
behavioral keyboard checks driven by real key events (home tab order +
visible focus, apps-hub filter operability via Enter/Space with
`aria-pressed`, mobile menu, auth-modal focus behavior, gym modal focus
trap). Serious/critical violations fail; the ones present today are
quarantined as named KNOWN DEFECT skips and listed below. Results worth
stating positively: the shared header/footer carry zero serious violations,
7 of 8 site pages and 6 of 8 app roots scan completely clean, and
gym-tracker's own modal focus trap is verified correct (20 tabs contained,
Escape closes, focus restored). This is automated scanning plus targeted
behavioral checks, not WCAG certification (see limitations).

## PWA / offline

- Gym Tracker: unit-level precache completeness (both directions against the
  file tree) and vm-level fetch-handler behavior, plus browser-level
  registration, cache creation, offline reload of visited pages, and the
  quarantined precache-fallback defect. Suites unregister the SW and delete
  caches afterward so the shared profile cannot poison later suites.
- Trip Planner: pre-existing `apps/trip-planner/e2e/pwa.mjs` (SW controller,
  cache keys, offline) retained; `sw-activate` unit tests cover both apps'
  workers' activate scoping.

## Known product defects (found by tests; NOT fixed, by design)

Two enforcement classes, stated per entry group below; none blocks CI.
Severity: H high, M medium, L low.

- **Pinned by executable quarantined tests** (defects 1-21, 24, 26-29): a
  `{ todo: 'KNOWN DEFECT...' }` unit test asserting the correct behavior, or
  a browser expected-failure check. The browser checks EXECUTE the defective
  behavior every run: while it reproduces they report as a `KNOWN DEFECT:`
  skip, and when it stops reproducing they FAIL with an "unexpectedly
  passes - remove the quarantine" message, so a stale quarantine cannot rot
  silently. Node `todo` tests also execute every run, but a fixed one shows
  as a passing TODO without failing the run; the fixing PR must remove the
  todo marker itself.
- **Documented, deliberately not asserted** (22, 23, 25, 30): security and
  architecture findings that need infrastructure this task could not add
  without production changes (22, 23), a behavior whose correct answer is a
  pending product decision so a test pins current semantics without judging
  them (25), and a performance observation explicitly excluded from the
  budgets (30). The documentation below is their only enforcement; do not
  read them as test-protected.

### Data integrity / correctness

1. **[M] MapTap Rivals: repeat paste double-counts.** `saveDay()`
   (apps/maptap-rivals/js/app.js ~2408) has no per-rival/per-date guard; the
   same pasted day saved twice creates two game records, inflating W/L
   records, streaks and averages. Confirmed at browser level.
2. **[M] MapTap Rivals: null coordinates classify as Africa.**
   `Number(null)` is 0, so a round with null lat/lng lands in the Africa
   bounding box and is averaged (js/stats.js:726 + app.js:6153/6168).
3. **[L] MapTap Rivals: a `__proto__` rival id breaks plain-object
   accumulators** (js/stats.js:533-535, 648); reachable via backup import;
   the player vanishes and others' shares go to -Infinity.
4. **[M] Football H2H: negative goals accepted.** The live add path
   validates only blank fields; `-3` is stored and flows into every
   aggregate (js/sidebar.js:817-919; the `min="0"` attribute never enforces
   because there is no form submit).
5. **[M] Football H2H: Goals/Game renders literal NaN** when an imported
   game row lacks a score (js/football-h2h.js:1747, 1776; import validates
   the envelope only).
6. **[L-M] Football H2H: `gameNumber` collides after a delete**
   (`games.length + 1`, js/sidebar.js:924).
7. **[L] Football H2H: penalty-winner rule drift.** A string `"1"` counts as
   a player-2 win on one tab and a draw on another (football-h2h.js:1756-1765
   vs playerStats.js:244-245). Latent today (live writers store numbers).
8. **[M] Mario Kart: races missing a player key inflate stats.** The
   `!== null` guard passes `undefined`, over-counting racesPlayed and making
   averageFinish NaN; reachable via roster widening (js/statistics.js:61).
9. **[M] Mario Kart: midnight races stamped "24:MM:SS"** (`hour12:false`
   rendering 00:30 as 24:30, js/dataManager.js:74-87), and consequently:
10. **[M] Mario Kart: chronological sorts no-op on those timestamps**
    (NaN comparator leaves insertion order; wrong streak credit;
    statistics.js:163-167 and charts.js:582-586).
11. **[L-M] Mario Kart: `migrateRaceData` silently drops course/courseId and
    writes the lossy version back on every load** (js/dataManager.js:437-444).
12. **[M] Gym Tracker: StorageService still compares ids with `===`** in
    saveProgram (:99, appends a duplicate), deleteProgram (:112, no-ops),
    deleteCustomExercise (:222), getWorkoutSessionsByExercise (:174),
    violating the app's own documented sameId rule; string ids arrive from
    sync round trips.
13. **[M] Gym Tracker: import validation is type-blind.**
    `{"programs":"pwned"}` passes `validateImportData` and overwrites the
    program store with a string (js/views/settings-view.js:52-71 +
    StorageService.js:319-334).
14. **[L] Gym Tracker: `migrateImport` mutates the caller's payload** despite
    its "pure migrators" docstring.
15. **[L] Rising Shows: one unrated episode NaN-poisons `aboveImdb`**
    (scripts/split-data.js:79 folds ratings with no numeric guard); latent
    until an unrated episode enters the dataset.

### Offline / platform

16. **[H] Gym Tracker: the service worker never consults its precache.**
    **RESOLVED 2026-08-15** (fix/gym-sw-precache-fallback): the fetch handler
    now falls back to the gym precache on a runtime-cache miss and
    `CACHE_VERSION` moved to 1.9.0; the former quarantines are plain
    regression tests (`sw-offline-behavior.test.mjs`, pwa-gym browser
    suite). Original finding: the handler matched only the RUNTIME cache
    (sw.js:113-121), so an offline request for a precached-but-never-visited
    URL got `respondWith(undefined)` and failed, making all install-time
    precaching dead weight.
17. **[L] Gym Tracker: rest-timer ids collide** when two timers start in the
    same millisecond (TimerService.js:21); first interval becomes
    unclearable.
18. **[L] Gym Tracker: stopWorkoutTimer returns the initial elapsed value**
    instead of the final one (TimerService.js:110/127); no current caller
    reads it.

### UI honesty / UX

19. **[L] Trip Planner: a failed exchange-rate fetch leaves a stale
    "Fetching exchange rates..." note**; the promised failure note + Retry
    appears only after some later unrelated re-render (js/app.js ~558-569:
    render fires before the fetching flag clears).
20. **[L] Site: apps.html zero-match search is silent.** All cards hide with
    no empty-state message and no live-region announcement (apps.html inline
    script ~389-426).
21. **[L] Gym Tracker: 12h/24h time-format default divergence.** Pre-boot
    surfaces render 12-hour then flip to the Settings default of 24-hour
    (js/utils/helpers.js:133 vs js/models/Settings.js:72,136). Documented by
    a side-by-side test; the owner should pick one.

### Accessibility (axe serious/critical + behavioral, quarantined in a11y.mjs)

26. **[M] Shared auth modal: the focus trap does not trap.** `trapFocus()`
    in assets/js/main.js (~169) computes its first/last boundaries over ALL
    focusable elements including the hidden signup form, so the wrap never
    fires and Tab escapes the open `aria-modal` dialog to the page body.
    Open-focus and Escape-with-focus-restore work.
27. **[M] Mario Kart: `role="grid"` on a CSS card layout** (index.html:337,
    Help view) triggers critical `aria-required-children` /
    `aria-required-parent` violations; the children are articles, not
    rows/gridcells. Fix is removing the role.
28. **[L-M] Color-contrast failures (axe serious):** trip-planner Days view
    x32 (day-number labels, weather chips, tags, the "more" button);
    gym-tracker program-modal save button; moadon-alef active language
    button; maptap-rivals paste-panel hint.
29. **[L] Mobile menu ignores Escape.** The HTML5UP panel plugin supports
    `hideOnEscape` but `initializeMenu()` in assets/js/main.js never sets
    it. The labelled close control works.

### Performance observation (documented only, deliberately not asserted)

30. **Rising Shows eagerly fetches ~102 MB of dataset at boot** when the
    release data is present (data-index.json 34.3 MB + show-modal-extras
    67.5 MB, uncompressed sizes over a local no-gzip server; production
    serves compressed). Worth an owner look; the perf budgets deliberately
    exclude it.

### Arena correctness (pinned in apps/arena/tests/known-defects.test.js)

24. **[L-M] Arena `normalizeRoomCode` accepts characters outside the
    room-code alphabet** (room-state.js filters only `[^A-Z0-9]`;
    `parseUrlState` uses a third, different validity notion), so codes that
    can never exist are looked up instead of rejected. Pinned by todo, along
    with two NaN-hardening gaps in scoring (`speedBonus(NaN)` and
    `scoreAnswer` with a missing `timeLeftMs` propagate NaN toward a
    Firestore increment; unreachable in production today).

### Security-adjacent observations (documented only; no executable pin)

22. **Arena room passwords are stored in cleartext in a world-readable
    Firestore document and compared client-side** (app.js:1630,
    firestore.rules:59-62). Anyone with the room code can read the password
    from the console. Needs a product decision (rules + hashing or a
    server-side gate). Not automatable without an emulator harness.
23. **No Firestore security-rules tests exist**; player-doc ownership, chat
    caps, guest exclusions and admin deletes are enforced only by rules that
    nothing verifies. The emulator ports are configured in firebase.json but
    unused. Top recommended next step.

### Product decision pending (pinned as current-behavior, not judged)

25. **Arena trivia accuracy divides by answered rather than total rounds**
    (room-state.js:279), inconsistent with the deliberately-fixed Globe Drop
    aggregator; 3 correct answers in a 10-question game report 100%. A test
    in known-defects.test.js pins today's semantics so the choice is made
    consciously; it is not a todo because asserting either denominator would
    presume the decision.

Also documented (dead code, latent only): football-h2h's unreachable
`saveGame` path with its string penalty-winner bug; arena's `scoreAnswer`
NaN propagation (unreachable in production today, would flow into a
Firestore increment if reached); fpl `validate-history.mjs` validating
2025-26 twice per default run.

None of these blocks CI. The quarantine reports them on every run.

## Flaky tests discovered and their causes

1. **The two baseline browser failures** (trip-planner assistant distance
   chips): leaked tabs from the `closePage(s)` single-argument no-op bug
   raced later blocks' storage seeds. Fixed in the harness call sites;
   assertions untouched; 6+ consecutive green runs.
2. **FPL plan-generation budget** measured wall-clock time in
   `invariants.test.mjs` while the perf files deliberately used CPU time;
   under a loaded machine (exactly the concurrent-agent situation) wall time
   is noise. Converted to CPU time.
3. **Node 20 test-runner IPC desync** ("Unable to deserialize cloned data")
   when a child's raw console output interleaves with the runner protocol;
   triggered by the sync engine's own logging. Fixed by capturing console
   output inside the sync tests before the engine loads; 20/20 stress runs
   clean.
4. **A date-boundary assertion** (trip-planner bookBy "3 days left") that
   flipped across local midnight; recomputed from the same clock the app
   uses.
5. Classes removed preemptively: ~56 fixed sleeps replaced with condition
   waits across the browser estate (the remaining handful sit on negative
   claims and are commented); wall-clock fixture timestamps pinned; DST-safe
   date arithmetic in gym streak tests.

No retry mechanisms were added anywhere; nothing hides a deterministic
failure.

## Remaining limitations (candid)

- **Arena's multiplayer core is still not behaviorally testable.** Room
  create/join/start/rematch, two-client sync, host handoff and reconnect run
  only against real Firebase, and tests must not touch production. The right
  fix is a Firebase-emulator harness plus extracting pure logic from app.js;
  both need production-code changes this task was forbidden to make. Current
  browser checks assert truthful blocked-backend behavior only.
- **Firestore/RTDB security rules remain untested** (same constraint).
- **The app-core IIFEs** (trip-planner, maptap, rising-shows app.js) are
  covered behaviorally through the browser, not by unit tests; internals
  like maptap's `classifyContinent` tables cannot be unit-tested without an
  export seam (a one-line production change, recommended).
- **WebKit runs only on CI** (host libraries); Firefox runs everywhere.
- **axe + keyboard checks are not WCAG certification**; manual screen-reader
  passes remain in the owner's human test plans (`.features/*-human.md`).
- **Pixel-perfect visual regression is deliberately absent** (cross-machine
  font nondeterminism); the geometry/computed-style suite catches layout and
  theme regressions but not, e.g., a wrong border-radius.
- **True mobile devices are not tested** (viewport + touch emulation only).
- **tp-assist's `callGemini` upstream behavior** is tested via stubs, not a
  live contract check (a deliberate CI-determinism choice; the fpl proxy has
  the same property and now verifies its header contract producer-side).
- Some browser checks depend on the gitignored rising-shows dataset and skip
  cleanly on a fresh clone (6 checks, reported, with the fetch command).

## Recommended next steps (each is a product-code decision, not a test gap)

1. ~~Fix the HIGH defect: make the gym service worker consult its
   precache.~~ Done 2026-08-15 (see defect 16).
2. Stand up the Firebase emulator harness for Arena + rules tests
   (`firebase.json` already declares the ports); then delete the
   blocked-backend compromise checks.
3. Fix the MEDIUM data-integrity defects (maptap duplicate-day guard,
   football negative goals/NaN, mario-kart missing-key stats + 24:MM:SS
   timestamps, gym `===` id comparisons and import validation).
4. Add tiny export seams (`window._testExports`) to the maptap and
   rising-shows IIFEs so their pure helpers can move to the unit layer.
5. Fix the auth-modal focus trap and the mario-kart `role="grid"`; sweep the
   four contrast findings (all are token-level color changes).
6. Decide the gym 12h/24h default and the Arena accuracy denominator.
7. Consider hashing or server-gating Arena room passwords.
8. Look at Rising Shows' eager ~102 MB dataset fetch at boot.
9. Harness nicety: give `pressKey()` in cdp.mjs a `text` field variant so
   Enter/Space trigger button default actions (the a11y suite carries a
   local helper for this today).

## Files changed

Test infrastructure and suites only (verified against `git diff master`):
`tests/browser/` (cdp.mjs, run.mjs, all suites, vendor/axe.min.js, README),
`tests/static/` (new), `tests/coverage/` (new), `tests/cross-browser/` (new),
`apps/*/tests/` (all eight apps), `apps/{trip-planner,fpl-planner}/e2e/`,
`sync-system/tests/`, `netlify/functions/tests/`, `.github/workflows/`
(browser-tests trigger, cross-browser new), `package.json` (scripts + the
Playwright dev dependency), `package-lock.json` (new), `.gitignore`
(node_modules, .coverage), `README.md` (Testing section), per-app
`README.md`/`FINDINGS.md` testing documentation, and this file.
