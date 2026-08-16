# Testing audit and hardening, 2026-08-15

Repository-wide audit and rebuild of the testing strategy for shevato.com and
every app under `apps/`. Constraint honored throughout the AUDIT phase:
**zero production code was modified**; every change was in tests, test
infrastructure, test configuration, CI configuration, or documentation.
Product bugs discovered by the new tests were catalogued below and left
unfixed by design.

> **STATUS 2026-08-16: fully remediated.** A follow-up round (PRs #386-#395)
> fixed every catalogued defect, made the two pending product decisions,
> built the Arena emulator/rules/security architecture, and redesigned
> Rising Shows' boot loading. Each defect entry below keeps its original
> finding with a RESOLVED stamp; see "Remediation round" near the end for
> the beyond-defects work. Zero known-defect quarantines remain active.

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
| Arena | FULL | FULL | FULL | FULL | FULL | FULL | Extracted modules deep; since 2026-08-16: 23 emulator rules tests + 27-check two-client multiplayer e2e (separate commands, weekly CI) |
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
| Before the audit (master 2026-08-15) | 88.76% | 85.45% | 87.55% | 117 |
| After the testing overhaul (PR #385) | 90.05% | 85.03% | 88.11% | 130 |
| After the remediation round (2026-08-16) | **90.10%** | **85.07%** | **88.17%** | **132** |

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
disaster threshold (measured 93-212 ms). rising-shows' budget originally
excluded the gitignored release dataset as a workaround; since the loading
redesign (PR #391) the exclusion is gone and the budget (52 MB, measured
36.0 MB) guards the intentional architecture: code plus the deliberate boot
index, with the 67.5 MB extras monolith never fetched at boot. Lighthouse
CI was evaluated and rejected (heavy, CI-flaky); these budgets catch the
static-site regression class that matters.

## Accessibility

`tests/browser/suites/a11y.mjs`, 33 checks: axe-core 4.10.3 (WCAG 2.0/2.1
A + AA) over all 8 site pages, all 8 app roots (Arena with Firebase
intercepted, no production writes), and two deep app states (gym program
modal open, trip-planner Days view with the example trip), plus 15
behavioral keyboard checks driven by real key events (home tab order +
visible focus, apps-hub filter operability via Enter/Space with
`aria-pressed`, mobile menu, auth-modal focus behavior, gym modal focus
trap). Serious/critical violations fail; the ones found at audit time were
quarantined, and since the 2026-08-16 remediation (PR #392) the suite scans
**fully clean: 33/33 checks, zero skips, empty quarantine baseline**. The
shared header/footer carried zero serious violations even before the round,
and gym-tracker's own modal focus trap was verified correct from the start.
This is automated scanning plus targeted behavioral checks, not WCAG
certification (see limitations).

## PWA / offline

- Gym Tracker: unit-level precache completeness (both directions against the
  file tree) and vm-level fetch-handler behavior, plus browser-level
  registration, cache creation, offline reload of visited pages, and the
  quarantined precache-fallback defect. Suites unregister the SW and delete
  caches afterward so the shared profile cannot poison later suites.
- Trip Planner: pre-existing `apps/trip-planner/e2e/pwa.mjs` (SW controller,
  cache keys, offline) retained; `sw-activate` unit tests cover both apps'
  workers' activate scoping.

## Known product defects (audit 2026-08-15; ALL RESOLVED 2026-08-15/16)

Historical record. The audit's original constraint was to discover defects
without changing production code; the remediation round that followed
(PRs #386-#394, one to two days later) fixed every entry below. Each entry
keeps its original finding text for history, with a RESOLVED line stating
the fix and PR; every former quarantine is now a plain passing regression
test. The quarantine MECHANISM remains the convention for future finds:
`{ todo: 'KNOWN DEFECT...' }` unit tests asserting correct behavior (they
execute every run and report without failing; the fixing PR removes the
marker), and browser expected-failure checks (execute the defect every run,
skip while it reproduces, FAIL loudly when it stops reproducing).

Two findings were product decisions rather than plain bugs; both were
decided during remediation and are recorded at their entries: 21 (24-hour
default) and 25 (total-rounds accuracy denominator).

Severity: H high, M medium, L low.

### Data integrity / correctness

1. **[RESOLVED] [M] MapTap Rivals: repeat paste double-counts.** `saveDay()`
   (apps/maptap-rivals/js/app.js ~2408) has no per-rival/per-date guard; the
   same pasted day saved twice creates two game records, inflating W/L
   records, streaks and averages. Confirmed at browser level.
    RESOLVED 2026-08-16 (PR #390): saveDay now upserts one record per (rival, date); repeat paste updates in place; regression at unit + browser layers.

2. **[RESOLVED] [M] MapTap Rivals: null coordinates classify as Africa.**
   `Number(null)` is 0, so a round with null lat/lng lands in the Africa
   bounding box and is averaged (js/stats.js:726 + app.js:6153/6168).
    RESOLVED 2026-08-16 (PR #390): rounds without finite coordinates are excluded from continent stats at both call sites (new coordNum contract). Bonus fix: the Iceland rule was dead code shadowed by Greenland and is reordered.

3. **[RESOLVED] [L] MapTap Rivals: a `__proto__` rival id breaks plain-object
   accumulators** (js/stats.js:533-535, 648); reachable via backup import;
   the player vanishes and others' shares go to -Infinity.
    RESOLVED 2026-08-16 (PR #390): all accumulators keyed by untrusted ids build in Maps / null-prototype objects.

4. **[RESOLVED] [M] Football H2H: negative goals accepted.** The live add path
   validates only blank fields; `-3` is stored and flows into every
   aggregate (js/sidebar.js:817-919; the `min="0"` attribute never enforces
   because there is no form submit).
    RESOLVED 2026-08-16 (PR #388): both write paths reject non-integer and negative goals with the existing feedback style.

5. **[RESOLVED] [M] Football H2H: Goals/Game renders literal NaN** when an imported
   game row lacks a score (js/football-h2h.js:1747, 1776; import validates
   the envelope only).
    RESOLVED 2026-08-16 (PR #388): import validates every row (rejects bad rows with disclosure) and the aggregate defensively skips legacy bad rows.

6. **[RESOLVED] [L-M] Football H2H: `gameNumber` collides after a delete**
   (`games.length + 1`, js/sidebar.js:924).
    RESOLVED 2026-08-16 (PR #388): gameNumber derives from max+1 via the shared tested helper.

7. **[RESOLVED] [L] Football H2H: penalty-winner rule drift.** A string `"1"` counts as
   a player-2 win on one tab and a draw on another (football-h2h.js:1756-1765
   vs playerStats.js:244-245). Latent today (live writers store numbers).
    RESOLVED 2026-08-16 (PR #388): penaltyWinner normalized to a numeric canon at every write path, healed at load, readers tolerant; the dead saveGame path carrying the latent bug is deleted.

8. **[RESOLVED] [M] Mario Kart: races missing a player key inflate stats.** The
   `!== null` guard passes `undefined`, over-counting racesPlayed and making
   averageFinish NaN; reachable via roster widening (js/statistics.js:61).
    RESOLVED 2026-08-16 (PR #389): a shared isFinitePosition guard replaces the !== null pattern across statistics, achievements and charts.

9. **[RESOLVED] [M] Mario Kart: midnight races stamped "24:MM:SS"** (`hour12:false`
   rendering 00:30 as 24:30, js/dataManager.js:74-87), and consequently:
    RESOLVED 2026-08-16 (PR #389): timestamps are hand-formatted 00-23; legacy 24: stamps are healed by the load migration.

10. **[RESOLVED] [M] Mario Kart: chronological sorts no-op on those timestamps**
    (NaN comparator leaves insertion order; wrong streak credit;
    statistics.js:163-167 and charts.js:582-586).
    RESOLVED 2026-08-16 (PR #389): every chronological sort uses one shared tolerant parser (never NaN, legacy shapes handled).

11. **[RESOLVED] [L-M] Mario Kart: `migrateRaceData` silently drops course/courseId and
    writes the lossy version back on every load** (js/dataManager.js:437-444).
    RESOLVED 2026-08-16 (PR #389): the migration preserves course/courseId and unknown fields, and only writes back on real change.

12. **[M] Gym Tracker: StorageService still compares ids with `===`.**
    **RESOLVED 2026-08-15** (fix/gym-data-integrity): saveProgram,
    deleteProgram, deleteCustomExercise and getWorkoutSessionsByExercise now
    go through sameId(); the quarantines are plain regression tests in
    storage-service.test.mjs. Original finding: a stringified id from a sync
    round trip duplicated on save, no-opped deletes, and returned empty
    exercise histories.
13. **[M] Gym Tracker: import validation is type-blind.**
    **RESOLVED 2026-08-15** (same branch): validateImportData now requires
    every present store to carry its expected shape (arrays for
    programs/sessions/customExercises/measurements/achievements, object for
    settings). Original finding: `{"programs":"pwned"}` passed and
    importAllData overwrote the program store with a string.
14. **[L] Gym Tracker: `migrateImport` mutates the caller's payload.**
    **RESOLVED 2026-08-15** (same branch): the payload is cloned before the
    in-place migrators run, so the documented pure contract holds.
15. **[RESOLVED] [L] Rising Shows: one unrated episode NaN-poisons `aboveImdb`**
    (scripts/split-data.js:79 folds ratings with no numeric guard); latent
    until an unrated episode enters the dataset.
    RESOLVED 2026-08-16 (PR #391): the rating fold guards non-numeric episodes like its sibling folds.

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
17. **[RESOLVED] [L] Gym Tracker: rest-timer ids collide** when two timers start in the
    same millisecond (TimerService.js:21); first interval becomes
    unclearable.
    RESOLVED 2026-08-16 (PR #394): timer handles come from a monotonic counter.

18. **[RESOLVED] [L] Gym Tracker: stopWorkoutTimer returns the initial elapsed value**
    instead of the final one (TimerService.js:110/127); no current caller
    reads it.
    RESOLVED 2026-08-16 (PR #394): final elapsed is recomputed from the wall clock at stop.

### UI honesty / UX

19. **[RESOLVED] [L] Trip Planner: a failed exchange-rate fetch leaves a stale
    "Fetching exchange rates..." note**; the promised failure note + Retry
    appears only after some later unrelated re-render (js/app.js ~558-569:
    render fires before the fetching flag clears).
    RESOLVED 2026-08-16 (PR #392): the fetching flag clears before every render, so the failed fetch itself repaints the honest note + Retry.

20. **[RESOLVED] [L] Site: apps.html zero-match search is silent.** All cards hide with
    no empty-state message and no live-region announcement (apps.html inline
    script ~389-426).
    RESOLVED 2026-08-16 (PR #392): apps.html gained a visible empty state and a polite live region driven by the filter script.

21. **[RESOLVED] [L] Gym Tracker: 12h/24h time-format default divergence.** Pre-boot
    surfaces render 12-hour then flip to the Settings default of 24-hour
    (js/utils/helpers.js:133 vs js/models/Settings.js:72,136). Documented by
    a side-by-side test; the owner should pick one.
    RESOLVED 2026-08-16 (PR #394): decision made for 24-hour (the Settings default, its v1 upgrade, and the README already agreed); the pre-boot fallback now matches, and an explicit stored 12 stays respected.

### Accessibility (axe serious/critical + behavioral, quarantined in a11y.mjs)

26. **[RESOLVED] [M] Shared auth modal: the focus trap does not trap.** `trapFocus()`
    in assets/js/main.js (~169) computes its first/last boundaries over ALL
    focusable elements including the hidden signup form, so the wrap never
    fires and Tab escapes the open `aria-modal` dialog to the page body.
    Open-focus and Escape-with-focus-restore work.
    RESOLVED 2026-08-16 (PR #392): trapFocus filters to visible enabled focusables per Tab and recaptures leaks; verified with real keys in both modal states.

27. **[RESOLVED] [M] Mario Kart: `role="grid"` on a CSS card layout** (index.html:337,
    Help view) triggers critical `aria-required-children` /
    `aria-required-parent` violations; the children are articles, not
    rows/gridcells. Fix is removing the role.
    RESOLVED 2026-08-16 (PR #392): the layout roles are removed; the scan is clean.

28. **[RESOLVED] [L-M] Color-contrast failures (axe serious):** trip-planner Days view
    x32 (day-number labels, weather chips, tags, the "more" button);
    gym-tracker program-modal save button; moadon-alef active language
    button; maptap-rivals paste-panel hint.
    RESOLVED 2026-08-16 (PR #392): all four surfaces fixed at token level to WCAG AA, including two root causes beyond the scan (the main.css b/strong #555 collision on day numbers, and the cancelled-row opacity fade rebuilt as explicit colors).

29. **[RESOLVED] [L] Mobile menu ignores Escape.** The HTML5UP panel plugin supports
    `hideOnEscape` but `initializeMenu()` in assets/js/main.js never sets
    it. The labelled close control works.
    RESOLVED 2026-08-16 (PR #392): initializeMenu passes hideOnEscape to the panel plugin.

### Performance observation (documented only, deliberately not asserted)

30. **[RESOLVED] Rising Shows eagerly fetches ~102 MB of dataset at boot** when the
    release data is present (data-index.json 34.3 MB + show-modal-extras
    67.5 MB, uncompressed sizes over a local no-gzip server; production
    serves compressed). Worth an owner look; the perf budgets deliberately
    exclude it.
    RESOLVED 2026-08-16 (PR #391): the boot fetch of the 67.5 MB extras monolith is gone; extras merge into the per-show detail files the modal already fetches. Boot transfer measured 103.5 MB before, 36.0 MB after (65% down); the perf budget now covers the intentional architecture.

### Arena correctness (pinned in apps/arena/tests/known-defects.test.js)

24. **[RESOLVED] [L-M] Arena `normalizeRoomCode` accepts characters outside the
    room-code alphabet** (room-state.js filters only `[^A-Z0-9]`;
    `parseUrlState` uses a third, different validity notion), so codes that
    can never exist are looked up instead of rejected. Pinned by todo, along
    with two NaN-hardening gaps in scoring (`speedBonus(NaN)` and
    `scoreAnswer` with a missing `timeLeftMs` propagate NaN toward a
    Firestore increment; unreachable in production today).
    RESOLVED 2026-08-16 (PR #393): normalizeRoomCode enforces the alphabet and parseUrlState routes through it.

### Security-adjacent observations (documented only; no executable pin)

22. **[RESOLVED] Arena room passwords are stored in cleartext in a world-readable
    Firestore document and compared client-side** (app.js:1630,
    firestore.rules:59-62). Anyone with the room code can read the password
    from the console. Needs a product decision (rules + hashing or a
    server-side gate). Not automatable without an emulator harness.
    RESOLVED 2026-08-16 (PR #393): joins are rules-gated against a SHA-256 hash in an unreadable private/gate subdocument; new rooms can never carry a password field (rules-enforced); legacy rooms keep working; boundary documented in apps/arena/README.md.

23. **[RESOLVED] No Firestore security-rules tests exist**; player-doc ownership, chat
    caps, guest exclusions and admin deletes are enforced only by rules that
    nothing verifies. The emulator ports are configured in firebase.json but
    unused. Top recommended next step.
    RESOLVED 2026-08-16 (PR #393): a 23-test Firestore-emulator rules suite (apps/arena/tests-rules/, plain REST, deny-all negative control) covers every rules-only invariant plus non-arena no-regression pins; weekly CI via arena-rules.yml.

### Product decision pending (pinned as current-behavior, not judged)

25. **[RESOLVED] Arena trivia accuracy divides by answered rather than total rounds**
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
    RESOLVED 2026-08-16 (PR #393): decision made for total-rounds accuracy (consistent with Globe Drop); the aggregator takes the denominator from the room question count and the old semantics are asserted against.

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

## Remediation round (2026-08-15/16)

The constraint of the original audit (no production changes) was lifted the
next day and every finding was worked through. What changed beyond the
defect fixes stamped above:

- **Arena is now behaviorally testable.** A Firestore-emulator harness
  (plain REST, pinned npx firebase-tools, deny-all negative control, Java
  21) runs 23 security-rules tests, and a 27-check two-client multiplayer
  e2e drives create/join/start/answer/reveal/scoreboard/rematch/host-handoff
  and both password paths against local emulators (`npm run
  test:arena:rules`, `npm run test:arena:emulator`; weekly CI via
  arena-rules.yml). The emulator seam in firebase-config.js is
  double-gated (loopback host AND an explicit localStorage opt-in) and
  unit-tested; no test can reach production Firebase.
- **Room passwords** moved from cleartext-in-a-readable-doc to a rules-gated
  hash in an unreadable subdocument (defect 22 above).
- **Export seams** landed for the maptap IIFE (`window._testExports`, 18 new
  unit tests incl. the continent tables, which promptly caught the Iceland
  bug) and rising-shows' Watched/Compare stores.
- **Rising Shows boot loading was redesigned** (defect 30 above): 103.5 MB
  to 36.0 MB measured, extras lazy via the per-show detail files, perf
  budget now guards the intentional architecture.
- **pressKey text support** landed in cdp.mjs (Enter/Space default actions).
- The a11y suite scans **fully clean: 33/33, zero skips** after the fixes.

## Remaining limitations (candid, post-remediation)

- **WebKit runs only on CI** (host libraries); Firefox runs everywhere.
- **axe + keyboard checks are not WCAG certification**; manual screen-reader
  passes remain in the owner's human test plans (`.features/*-human.md`).
- **Pixel-perfect visual regression is deliberately absent** (cross-machine
  font nondeterminism); the geometry/computed-style suite catches layout and
  theme regressions but not, e.g., a wrong border-radius.
- **True mobile devices are not tested** (viewport + touch emulation only).
- **tp-assist's `callGemini` upstream behavior** is tested via stubs, not a
  live contract check (a deliberate CI-determinism choice; the fpl proxy has
  the same property and verifies its header contract producer-side).
- **The RTDB path of the sync engine** stays untested (production pins
  Firestore; documented in the sync behavioral suite header).
- **The arena rules/emulator suites need Java plus a one-time
  firebase-tools download**, so they are separate commands + weekly CI, not
  part of `npm test`; they skip cleanly (and loudly) where Java is absent.
- Some browser checks depend on the gitignored rising-shows dataset and skip
  cleanly on a fresh clone (6 checks, reported, with the fetch command).

## Recommended next steps (all optional polish; nothing load-bearing open)

1. Collapse football-h2h's two games-table renderers (the legacy one is
   reachable via sortable headers and drifts cosmetically; FINDINGS has the
   detail).
2. Arena owner items surfaced during the emulator work (apps/arena/
   FINDINGS.md): the dead `#end-again-btn` rematch-strip UI path, and the
   shared sync modal's open+reload behavior likely hitting real first-time
   guests in production.
3. Mario-kart cosmetic sibling of defect 8: a widened roster can render
   "undefined" in a history cell (render-path guards were deliberately left
   alone).
4. Decide whether the sync engine's oversize-payload drop (silent beyond
   console after the retry ladder) deserves a user-visible surface.
5. Consider registering the arena emulator e2e in a CI job with Java the
   way arena-rules.yml runs the rules suite, if its runtime stays stable.

## Files changed

By the original testing-hardening PR (#385), test infrastructure and suites
only (verified against `git diff master` at the time). The remediation round
that followed (production fixes included, each PR body enumerating its own
complete diff): #386 gym service worker, #387 gym data integrity, #388
football-h2h correctness, #389 mario-kart correctness, #390 maptap-rivals
correctness + seam, #391 rising-shows data + loading redesign, #392
site-wide a11y/UX, #393 arena emulator + rules + password security, #394
gym timers/format, #395 the CPU-time budget conversion, plus the closeout
PR carrying this document update. Original #385 scope:
`tests/browser/` (cdp.mjs, run.mjs, all suites, vendor/axe.min.js, README),
`tests/static/` (new), `tests/coverage/` (new), `tests/cross-browser/` (new),
`apps/*/tests/` (all eight apps), `apps/{trip-planner,fpl-planner}/e2e/`,
`sync-system/tests/`, `netlify/functions/tests/`, `.github/workflows/`
(browser-tests trigger, cross-browser new), `package.json` (scripts + the
Playwright dev dependency), `package-lock.json` (new), `.gitignore`
(node_modules, .coverage), `README.md` (Testing section), per-app
`README.md`/`FINDINGS.md` testing documentation, and this file.
