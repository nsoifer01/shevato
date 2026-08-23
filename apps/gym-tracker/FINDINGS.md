# FINDINGS - Gym Tracker

Accumulated engineering knowledge for this app: discoveries, root causes,
quirks, constraints, decisions and regression risks a future session would
otherwise rediscover the hard way. This is a LIVING document, not a diary:
rewrite sections when the truth changes, merge duplicates, delete what stops
being true. `README.md` (beside this file) says what the app is and how it
works; this file says what we learned building it.

---

## Modal architecture: stacking is DOM order, and the picker is a child

Every `.modal` overlay shares `z-index: 2000`, so **document order is the
stacking order**. `#confirm-modal` sits last so confirmations paint over
everything; `#exercise-picker-modal` sits between `#program-modal` and
`#confirm-modal` so it paints over the editor it serves. Do not "fix" a
stacking problem with a z-index bump - move the element to the right place in
`index.html` and update `tests/modal-dom-order.test.mjs`, which pins this.

Two placement rules learned the hard way:

1. **Overlays must live at document level, never inside a `.view`.** Views
   animate `fadeIn` with a transform, and a transformed ancestor becomes the
   containing block for `position: fixed`. `#program-modal` was moved out for
   this reason long ago; the exercise picker stayed behind.
2. **An overlay inside a view also loses the stacking race.** The picker,
   inside `#programs-view` (early in the document), painted UNDERNEATH the
   document-level editor. This produced the 2026-08 "added exercise silently
   lost" bug: clicking *Add Exercise* activated the picker below the editor,
   the user's only visible way forward was the editor's Cancel, and the
   picker's commit then wrote into the discarded staged clone
   (`this.currentProgram`, a `Program.clone()` only `saveProgram()` commits).
   In-memory and stored programs never changed; the exercise vanished.

The fix is ownership, not just placement. The picker is now an explicit
**child of the program editor** (`programs-view.js`):

- `openExercisePicker()` refuses to open unless the editor is active and a
  staged program exists, and resets search/filters/selection per open.
- Every editor-close path - `closeProgramModal()`, `cancelWorkoutEdit()`,
  `beforeLeave()` - also runs `closeExercisePicker()` and releases the staged
  clone (`currentProgram = null`). The picker cannot outlive its owner.
- `commitExercisePickerSelection()` guards on an active editor + staged
  program; if the invariant is ever broken it closes the orphan picker and
  toasts instead of silently writing into a dead clone.

Regression pins: `tests/modal-dom-order.test.mjs` (placement),
`tests/programs-view-before-leave.test.mjs` (lifecycle, extracts real method
source), and the gym section of `tests/browser/suites/apps.mjs` (full driven
flow, hit-tested with `elementsFromPoint`).

Related fix in the same round: the picker's search/filter listeners were
re-added on every open (a fresh closure defeated `removeEventListener`), so
N opens meant N full list re-renders per keystroke. They are now wired once
behind a dataset guard and read live control values.

Contrast (2026-08-15, was defect 28): the program-modal Save button
(`#program-modal .btn-save-program`) fills with `--accent-secondary`
(#2563eb, the "strong fills" token), NOT `--accent-primary` - white on the
bright azure is 2.77:1 (axe serious fail); on the deep blue it is ~5.2:1.
The a11y browser suite scans this exact modal state and fails on any
serious violation, so do not swap the fill back for looks.

## Exercise identity: stable ids, snapshot names, display-time resolution

- The catalog (`data/exercises-db.json`, 514 entries) stores **literal numeric
  ids**. They are identity: history, PRs, progression, charts and program rows
  all join on `exerciseId`. Never reuse or renumber an id; array position is
  meaningless (id 514 sits inside the glutes block). Pinned by
  `tests/exercise-db-identity.test.mjs` + uniqueness in
  `tests/exercise-db-loader.test.mjs`.
- Programs and sessions store an `exerciseName` **snapshot** from creation
  time. Since 2026-08, every display surface resolves the name from the
  catalog by id via `app.getExerciseDisplayName(id, fallbackSnapshot)`
  (programs builder, workout cards, history detail, achievements PR cards,
  CSV export via a resolver param on `buildSetsCsv`). New sessions snapshot
  the resolved current name at start. **A rename is therefore a one-line edit
  to the JSON `name`** - stored user data is never rewritten, which also
  means no sync churn and no migration risk. The snapshot remains the
  fallback for deleted custom exercises.
- Renames done this way: id 173 `Seated Dumbbell Press` → `Dumbbell Shoulder
  Press`, id 350 `Glute Ham Raise` → `Glute-Ham Raise` (both 2026-08-12).
- **Rename checklist for next time**: edit the JSON name; bump `sw.js`
  `CACHE_VERSION` (the JSON is precached); update the identity test's
  expectations; regenerate the exercise pages (`npm run
  build:gym-tracker:pages`, output gitignored); grep for the old name in
  tests/docs. Two name-based heuristics read SESSION snapshots, not the
  catalog: `AchievementService.checkLiftMilestones` (`exerciseMatch`
  substrings like "bench press") and
  `AnalyticsService.isBodyweightExercise`. Renaming an exercise in those
  families changes how OLD sessions are classified - check both before
  renaming anything matching their term lists.
- `Hip Thrust Machine` (id 514, added 2026-08-12) arguably overlaps `Glute
  Drive Machine` (id 379, a brand name for the same movement). The catalog
  already tolerates such variants ("Machine Shoulder Press" / "Shoulder Press
  Machine"), so both stay; do not merge them without migrating history.
- Custom exercises get `generateNumericId()` ids (~10^15), far above catalog
  range - no collision. Their `muscleGroup` values are Title Case ("Obliques")
  while the catalog uses lowercase-hyphenated; `formatMuscleGroup` normalizes
  display, but don't compare the two raw.
- Deletion safety: deleting a program never touches sessions; deleting a
  custom exercise is refused while it has history; per-exercise history
  removal is explicit and confirmed. There is no cascade path from catalog or
  plan changes into workout history.

**Generated pages carry TWO vocabularies, and both need directories.**
A leaf page links its breadcrumb to `/exercises/muscle/<muscleGroup>/` and its
Category fact to `/exercises/muscle/<category>/`. The generator used to emit
muscle directories from `muscleGroup || category` alone, so categories that
never equal a muscleGroup (`back`, `chest`, `cardio`) had no page and 155 leaf
pages carried a 404 link on production. `collectMuscleTaxonomy()` now adds a
directory for every category the muscle map does not already cover (the muscle
grouping still wins when a key serves both), and those pages are in the
sitemap like any other taxonomy page. Pinned by `build-exercise-pages.test.cjs`
("every internal exercises/ link on every built page resolves to an emitted
page"), which builds the REAL catalog into a temp dir and walks every
`/apps/gym-tracker/exercises/` href of all 514 pages against the emitted
directory set - it fails on any dangling link, not just the three known ones.
`main()` takes `{ outDir, sitemapFile, log }` so the test never writes into
the repo.

## Testing DOM-bound view logic: source extraction, never mirrors

The view classes import the DOM and the app singleton, so they cannot be
loaded under node. The estate's answer is `tests/helpers/source-extract.mjs`:
lift the REAL method/function text out of the source file (brace-matched,
default-params-safe) and evaluate it against stubs (`buildMethods` /
`buildFunctions`). Hand-copied "mirror" logic in tests is banned - the 2026-08
audit found the collapse-state mirror had ALREADY drifted: the real commit
path re-arms auto-collapse unconditionally on complete (#23), while the
mirror still guarded on `!== false`, and the tests kept passing. All former
mirrors (superset rest rule, collapse machine, steppers, rep clamp, rep-mode
templates, picker defaults, PLATE_LOADED_EQUIPMENT, calendar offset, plate
hints precedence) now extract from source; each behavior has exactly ONE test
home. When stubbing DOM lookups for an extracted method, derive the fake from
the real markup or parse the real selector, so a rename fails loudly instead
of the stub silently matching an old string.

Node 20 MockTimers gotchas (hit while testing TimerService, they fake app
bugs if unknown): `tick(N)` advances the mocked `Date` to the target BEFORE
draining callbacks (tick in interval-sized steps for real-world semantics);
`clearInterval` issued inside the interval's own callback is not honored for
subsequent ticks; `setTime` moves the clock without firing timers but the
missed fires are delivered as a backlog on the next `tick`.

`tests/firebase-sdk-singleton.test.mjs` walks the repo's HTML but EXCLUDES the
generated trees (`apps/gym-tracker/exercises/`, `apps/rising-shows/shows/`,
~35k files, ~3s/run); protection is kept by scanning the generator source
directories plus a 3-page canary sample of built output.

## Known defects pinned by todo tests (2026-08-15 audit)

All gym known defects from the 2026-08-15 audit are now FIXED and their
quarantines are plain regression tests (see the sameId section below for the
storage/import group; the SW precache fix is in the service-worker section).
The last three closed on 2026-08-15 (fix/gym-timers-format):

- TimerService rest-timer ids are a monotonic counter (were `Date.now()`,
  so two starts in one ms collided and orphaned the first interval);
  regression in `timer-service.test.mjs`.
- `stopWorkoutTimer` recomputes final elapsed from the wall clock at stop
  (used to return the creation-time snapshot); same file.
- Time-format default unified on 24-hour: `helpers.getTimeFormat` pre-boot
  fallback now agrees with the Settings model default (owner-consistent
  call: Settings default, its v1 upgrade, and the README all said 24), so
  early boot no longer flashes 12-hour and flips. An explicit stored '12'
  remains respected. Regression in `time-format.test.mjs`; the DST-window
  formatting expectations in `date-timezone.test.mjs` updated to 24-hour.

The 2026-08-19 exploratory QA round (41 findings, GT-01..GT-41) is closed the
same way: every one is fixed with a plain regression test, and no `todo`
quarantines were opened. Its report is kept verbatim at
`.reports/gym-tracker-session-report-2026-08-19-1648.md` - the sections below
record what the fixes actually are.

If a NEW product defect is found, quarantine it here with a
`{ todo: 'KNOWN DEFECT: ...' }` test asserting the correct behavior.

## The sameId rule: never compare ids with ===

Ids arrive as numbers (models), strings (dataset attributes, imports), and
sometimes stringified numbers (a Firestore sync round-trip did this to
measurements once). `utils/id-utils.js` `sameId()` is the comparison; strict
`===` on ids is a bug pattern. Found and fixed 2026-08-12: history cards were
unclickable/undeletable for non-numeric session ids (`Number(dataset)` → NaN,
then `s.id === NaN`), and `StorageService.saveWorkoutSession` would have
**appended a duplicate session** instead of updating on a type mismatch. Now
sameId-tolerant: history/calendar/home session lookups, `getExerciseById`,
`getWorkoutSessionById` (app + storage), exercises-view history joins and the
delete-guard. The last four holdouts (`saveProgram`, `deleteProgram`,
`deleteCustomExercise`, `getWorkoutSessionsByExercise`) were converted on
2026-08-15 (TESTING-AUDIT.md defect 12), with regression tests in
`storage-service.test.mjs`, so every StorageService id comparison now goes
through `sameId`. `AnalyticsService` was converted on 2026-08-19: its
exercise lookups compare a CALLER-supplied id (which can come from the DOM or
an import) against stored records, so `getPersonalRecords`,
`getLastWorkoutData`, `getExerciseProgression` and - the one the audit caught
(GT-18) - `isSetPR` all use `sameId` now. A session whose ids arrived as
strings from an import was invisible to the PR baseline, so a record the
lifter had already beaten could be celebrated again.
`AchievementService.checkExercisePRs` and the workout view's program-row
lookup went the same way. Any NEW code path that mixes a DOM-sourced or
imported id with stored data must go through `sameId`.

Import hardening landed the same day: `validateImportData` now type-checks
every present store (arrays for the list stores, object for settings) so a
mistyped payload can no longer overwrite a real store with junk
(TESTING-AUDIT.md defect 13), and `migrateImport` clones its input before the
in-place migrators run, making its documented purity real (defect 14). Both
pinned in `import-validation.test.mjs`.

## Supersets

`groupId` links consecutive program rows. Unlinking clears the row's groupId
AND dissolves any group left with fewer than two members - a dangling
singleton previously kept `is-grouped` styling in the builder and would wrap a
lone exercise in superset chrome during a workout (fixed 2026-08-12,
`toggleSupersetLink`).

## Driving the app headlessly (probe gotchas)

- **Hidden duplicates break `querySelectorAll(...)[0]` clicking.** Home view
  renders its own `.workout-card[data-action="show-session"]` and
  `[data-paused-action="resume"]` copies; when another view is active those
  are display:none with zero rects. Always scope selectors to the visible
  container (`#history-list ...`, `#workout-view ...`).
- **The completion burst swallows the first tap by design.** After finishing a
  workout a full-screen "Workout Complete!" overlay covers everything for up
  to 4 s ("Tap anywhere to close"). Wait for `.completion-burst` to leave the
  DOM before clicking anything.
- **The swap picker opens pre-filtered to the current exercise's category**
  (by design). Clear `#swap-exercise-category-filter` before searching
  cross-category.
- **The workout view arms a `beforeunload` guard**; navigating with a live
  workout hangs CDP `Page.navigate` unless you auto-accept dialogs
  (`Page.javascriptDialogOpening` → `handleJavaScriptDialog`).
- **snap chromium survives `child.kill()`** (the wrapper forks). Kill by
  profile dir (`pkill -f <user-data-dir>`), or the next run silently attaches
  to the stale instance - with its stale localStorage - via the still-open
  CDP port. This produced a whole phantom-failure round on 2026-08-12.
- Custom-exercise form muscle options are Title Case values; setting
  lowercase values silently fails validation.

- Toasts are appended to `document.body`, not a `#toast-container`; a probe
  that reads the container sees '' for every toast.
- `pkill -f '<pattern>'` from a Claude Bash call matches the calling shell's
  own command line and kills it (exit 144); use a bracketed pattern such as
  `remote-debugging-por[t]=9304`.
- Clicking a control that opens a `beforeunload` prompt (resume, then
  navigate) looks like a `Runtime.evaluate` timeout unless
  `Page.javascriptDialogOpening` is auto-accepted.

## Two console "errors" that are Chrome policy, not app defects

A headless smoke of the live workout logs these at error level:

    Blocked call to navigator.vibrate because user hasn't tapped on the frame
    Blocked attempt to show a 'beforeunload' confirmation panel for a frame
    that never had a user gesture since its load

Both are Chrome refusing a gesture-gated API, because a synthetic `.click()`
is not a user gesture. The app is doing the right thing in both cases (haptics
on a set toggle, an unsaved-workout guard on unload) and neither is a JS
exception - filtering them out of a real run leaves **zero**.

So a "no console errors" assertion in a headless probe has to exclude
`navigator.vibrate`, `beforeunload` and `chromestatus.com` notices, or it fails
on behaviour that is correct. Same family as the other synthetic-gesture traps
in the probe-hazards section.

## Running the browser suite while ALSO driving your own headless browsers

The full `npm run test:browser` run during the 2026-08-20 round reported 5
`tp-assist` failures (venue distance chips empty). They were not real:

- the same suite passes 63/63 when run alone on the same working tree,
- it passes 63/63 on the pre-change tree,
- the diff touched no trip-planner file at all,
- and photon.komoot.io was up (HTTP 200 in 0.7s) the whole time.

The cause was CPU contention: several of my own headless Chromium instances
were driving gym-tracker journeys concurrently. The distance chips geocode with
a **7 second abort**, and under that load the requests did not land in time, so
the chips rendered empty exactly as they do during a real photon outage.

So: a timing-sensitive suite must be run with nothing else driving a browser,
and "it failed in the big run" is not evidence until it fails alone. This is
the same class of hazard as two runs sharing CDP 9222, but it does not need a
port collision to bite - raw CPU contention is enough.

## Production and a feature branch share one Firestore document

Established 2026-08-20, after the owner saw "weird numbers" on shevato.com.

Facts, verified rather than assumed:

- Deployed production does NOT ship the canonical unit model. `units.js` and
  `data-migrations.js` are **404 on shevato.com**, and its `history-view.js`
  contains zero `displayWeight` calls. It reads a stored number as being in
  `settings.weightUnit`.
- Local development runs against **production Firebase by default**. The
  emulator seam (`sync-system/firebase-emulator-flag.mjs`) requires BOTH a
  loopback host AND an explicit `localStorage['shevato:firebase-emulators']
  = '1'`; without the opt-in, `localhost` uses project `shevato-site`.

So opening this branch's build while signed in converts the shared document to
canonical kilograms, and deployed production then renders those kilograms with
a pound label. That is **not data corruption** - the stored values are correct
and stamped - it is an old reader meeting a new representation.

**There is no client-side fix.** Deferring the migration does not help: the
canonical renderers would then read un-migrated numbers and be wrong in the
other direction. You cannot run half of a storage-format change. A guard that
blocks the conversion just moves the breakage.

The controls that actually work, in order:

1. Do local work against the emulator, or signed out, whenever the branch
   changes a storage format.
2. Deploy the READER before anything writes the new format - i.e. merge, let
   production build, and only then open the new client on a synced account.
3. After production understands canonical, every device converges: the
   per-record reconciler repairs anything still legacy on boot, and
   Settings > Data > Re-check stored units is the manual lever.

The durable rule: **in this repo a feature branch and production share one
per-user Firestore document, so any storage-format migration is a deployment
ordering problem, not just a code problem.**

## Service worker

- `data/exercises-db.json` is precached; **any catalog edit needs a
  `CACHE_VERSION` PATCH bump in `sw.js`** or existing installs keep serving
  the old catalog until the next unrelated bump.
- **The fetch handler falls back to the gym precache on a runtime miss**
  (fixed 2026-08-15, `CACHE_VERSION` 1.9.0; was TESTING-AUDIT.md defect 16:
  it used to open only the RUNTIME cache, so a URL precached at install but
  never fetched online in that SW generation got `respondWith(undefined)`
  offline, and the install-time precaching bought nothing). Semantics since
  the fix: stale-while-revalidate treats "cached" as runtime-first then OWN
  precache, so a precached URL is served from the precache even online while
  the background refresh updates RUNTIME. Only `gym-precache-*` is searched,
  never other apps' caches on this shared origin. Regression tests:
  `tests/sw-offline-behavior.test.mjs` (vm) and the pwa-gym browser suite.
- Same-origin assets OUTSIDE the app dir (`../../assets/*`, sync-system, the
  two shared mario-kart CSS files) are intercepted but deliberately NOT
  precached; they ride the runtime cache only, so a fully cold offline first
  visit still lacks them. Widening the precache to cross-app paths is a
  product decision, not part of the fallback fix.
- Two failure modes are pinned by `tests/sw-precache-completeness.test.mjs`:
  a new `js/` module missing from `PRECACHE_URLS` breaks OFFLINE ONLY, and a
  listed-but-deleted file fails the whole install (cache.addAll is atomic),
  silently freezing existing users on the previous version. That test also
  pins the semver `CACHE_VERSION` and the `gym-` prefix scoping of the
  activate cleanup (shared origin; an unscoped delete once wiped
  trip-planner's shell).
- `css/exercise-page.css` is intentionally NOT precached: it styles only the
  generated `/exercises/` pages, which are not part of the offline app shell.
- **Freshness after a deploy needs THREE things, and two of them are not in
  `sw.js`** (2026-08-22 audit D5, fixed; `CACHE_VERSION` 1.15.0):
  1. `cache: 'no-cache'` on every request the worker makes for itself - the
     stale-while-revalidate refresh and `cache.addAll(PRECACHE_URLS)`. With the
     default mode those reads came out of the browser's HTTP cache, so a
     version bump could precache stale modules under the new name.
  2. `event.waitUntil(networkPromise)` around the background refresh. Without
     it the revalidation is cancelled whenever the worker is terminated after
     `respondWith` settles, and the cached copy simply never updates.
  3. **`max-age=0` on `js/*`, `css/*` and `data/*` in `netlify.toml`.** This is
     the non-obvious one: Chrome answers a still-fresh subresource from its
     memory cache WITHOUT firing the worker's fetch event, so any positive
     max-age hides the request from the worker entirely - its cache is never
     revalidated and the page keeps running the old module against new HTML
     for the whole window. Measured against a local proxy serving the real
     headers: with `max-age=300` the load after a deploy was new HTML + old JS
     three loads running; with `max-age=0` the load after the deploy is
     coherent. The worker is the performance layer (CacheStorage answers
     instantly); the HTTP layer only has to be correct.
  There is now a visible update path too: `index.html` watches `updatefound` /
  `controllerchange` and reloads on a controller change when no workout is
  live, or shows an "Update available / Reload now" toast when one is (a
  reload mid-workout loses nothing, but it is still the lifter's call).
  Regressions: `tests/sw-offline-behavior.test.mjs` (cache mode of both fetch
  paths, the waitUntil hold) and `e2e/audit-2026-08.mjs` block K, which serves
  the app through a proxy that reads its Cache-Control straight out of
  `netlify.toml`, so re-introducing a positive max-age fails the suite.
- **A navigation request cannot be re-constructed with an init.**
  `new Request(navigationRequest, { cache: 'no-cache' })` throws a TypeError
  ("mode is 'navigate' and a non-empty RequestInit"), which rejected the whole
  fetch handler for every navigation the moment the no-cache clone was added -
  every page load silently fell back to the network and offline navigation
  died. The worker catches that and rebuilds the request from its URL.
- Offline navigations match with `ignoreSearch`, so a launch URL carrying a
  query string (`/?utm_source=x`) finds the cached shell, and a navigation
  that is in no cache at all (a generated `/exercises/` page never visited)
  gets the precached `offline/index.html` instead of the browser error page.
  The fallback page lives in a subdirectory because
  `sync-system/tests/app-naming-consistency.test.mjs` forbids a second
  top-level `*.html` beside an app's `index.html`.
- **Emulating offline on the page target alone proves nothing.** The worker
  does its own fetches on its own target, so `Network.emulateNetworkConditions`
  has to be sent to every `service_worker` target as well or the "offline"
  assertions pass by quietly reaching the network (cost an hour here; the same
  note exists in `tests/browser/suites/pwa-gym.mjs`).
- Testing approach: `sw.js` is a classic script, so behavior tests load it
  into a `node:vm` sandbox with a Map-backed fake Cache Storage and a
  controllable `fetch` (`tests/sw-offline-behavior.test.mjs`); list/structure
  invariants are plain source-text checks.

## Units: canonical storage, converted at the edges

`settings.weightUnit` used to be BOTH the display preference and the implicit
meaning of every stored number, so switching kg → lb relabelled without
converting: a 60 kg bench rendered "60 lb", a 13,345 kg session "13,345 lb",
an 86.5 cm waist "86.5 in", and the CSV export shipped those numbers to a
spreadsheet. The Strength PR card, which stored a canonical `prWeightKg`, was
the one surface that did not move - so it showed kg while History next to it
showed lb, in the same moment (2026-08-19 audit, GT-03).

The model now:

- **Storage is canonical.** Weights in kilograms, lengths in centimetres,
  durations in seconds. Nothing in localStorage, in an export, or in a sync
  payload is ever in pounds or inches.
- **`settings.weightUnit` is a display/entry preference.** Changing it does
  not write to storage at all, which is the structural reason it cannot drift
  or corrupt history.
- **Conversion happens at exactly two boundaries**, both in
  `js/utils/units.js`: `toCanonicalWeight` on the way in and
  `displayWeight` / `formatWeight` / `formatVolume` / `volumeIn` on the way
  out. Views must not interpolate a raw stored number next to a unit string;
  that is the bug pattern.
- **The input side is EXACT.** `toCanonicalWeight` / `fromCanonicalWeight` do
  no rounding; only the display helpers round. Rounding on the way in is what
  makes 135 lb come back as 134.9.
- **`WorkoutSession.sessionUnit` is metadata**, not a hint about what the
  numbers mean: it records the unit the lifter was entering in.

Two things are deliberately NOT canonical kg:

- **Plate/bar configuration.** A kg rack and an lb rack are different physical
  objects, so `settings.plateProfiles` keeps an independent `{ barWeight,
  plates, exerciseBarWeights }` per unit. `settings.barWeight` / `.plates` are
  accessors onto the profile for the CURRENT unit, so every existing reader
  keeps working. Switching the display unit SWAPS profiles; it never converts
  or overwrites one with the other (GT-21).
- **Warm-up thresholds**, which already carried separate kg and lb fields.

`Achievement.prWeightKg` was already canonical kg and must NOT be converted
again - `checkExercisePRs` used to divide by 2.205 for lb accounts, which is
correct only while a stored number means "whatever the setting says". Doing it
now would halve every PR an lb user set.

### The migration (js/utils/data-migrations.js)

Pre-canonical data is converted ONCE, on the first boot after the upgrade,
guarded by `gymTrackerDataVersion`:

- **v1** reads the numbers exactly the way the user has been reading them:
  whatever unit the account is set to AT MIGRATION TIME is the unit they were
  in. A kg account is a strict no-op - not one number changes. An lb account
  has session set weights, paused-workout sticky values, measurements and
  measurement goals converted once, and every screen keeps showing the same
  pounds it showed before.
- **v2** drops sessions with zero completed sets (see below).

It is pure (`migrateStoredData(snapshot, fromVersion)` takes and returns plain
data), idempotent, and never mutates its input. `gymTrackerDataVersion` starts
with `gymTracker`, so the sync layer carries it between a user's devices and a
second device does not re-run a migration the first one already did.

## Unit provenance: why a version marker was not enough (the 143.3 lb bug)

The canonical-units migration above was correct as a pure function and still
corrupted real data. A real 65 lb dumbbell bench press started rendering as
**143.3 lb**. This is the most important thing in this file.

**What happened.** `migrateStoredData()` converts an lb account's numbers once
and records `gymTrackerDataVersion`. That is right for data already in
localStorage when the app boots, and only for that data. But:

- `app.init()` runs on `DOMContentLoaded`. It does not wait for sync.
- `storage-sync-robust.js` rebuilds `localRevisions` **empty on every page
  load**, so `decideRemoteChange()` takes its `if (!localRev) return 'apply'`
  branch and writes the remote document over localStorage unconditionally.
- `applyRemoteChange()` writes through `originalMethods.setItem` - straight
  past the app.
- `refreshFromStorage()` calls `loadAllData()` and **never re-ran migrations**.

So on a device whose Firestore document still held pre-canonical numbers:

```
boot      -> 65 lb becomes 29.4835 kg, version := 2
snapshot  -> localStorage.gymTrackerSessions := the legacy doc (65 again)
reload    -> version is 2, so the migration is skipped; 65 is read as 65 KG
display   -> 65 kg rendered in pounds = 143.3 lb
```

Worse, `gymTrackerDataVersion` is itself synced, so the bogus "already
migrated" marker propagates and permanently blesses un-migrated data on every
device.

**The rule this produced.** A per-INSTALL marker cannot describe records that
arrive from a channel the marker knows nothing about. Canonical-ness is now a
property of the RECORD:

- Every session and measurement the app writes carries `unitsCanonical: true`
  (`CANONICAL_FLAG` in `js/utils/data-migrations.js`).
- **No conversion step ever touches a stamped record.** Idempotency,
  re-entrancy and ordering-independence are therefore structural, not guarded.
- `reconcileUnits()` is safe to run on every boot, after every remote sync and
  from Settings, because a healthy profile is a pure no-op.
- `app.js` calls `reconcileStoredUnits()` on `syncSystemReady` AND on every
  debounced `localStorageSync` remote burst, **before** `refreshFromStorage()`.

**What can and cannot be proven.** This is the part that matters when writing
any future repair:

- **Sessions have a discriminator, by luck.** The v1 migration stamps
  `sessionUnit` on everything it converts, and every session created since the
  remediation sets it at creation. So in an install claiming v>=1, a session
  with NO `sessionUnit` provably never went through v1 - it is legacy, and
  repairing it is deterministic. A session that HAS one in a damaged install is
  genuinely ambiguous (pre-remediation in-workout toggle vs logged-after-the-
  clobber) and is reported, never converted.
- **Measurements have nothing.** v1 rewrote `weight` / `waist` / ... in place
  and left no trace, so a stored `34` is either legacy inches or migrated
  centimetres and the record cannot tell you which. We DO NOT guess. A
  plausibility test on body dimensions ("a 34 cm adult waist is impossible")
  was considered and rejected: it is another silent heuristic, and the owner's
  standing instruction is to be asked once rather than be quietly wrong.
  `#measurement-units-modal` asks, the answer is recorded in
  `gymTrackerMeasurementUnits` (synced, so a second device never re-asks), and
  `gymTrackerMeasurementsBackup` holds a rollback copy written before the
  rewrite. A kg account is never asked: for kg, v1 was a no-op on measurements,
  so the numbers are correct either way.

**Settings > Data > Re-check stored units** is the permanent escape hatch. It
is a diagnostic, NOT "run all migrations again": it repairs only provable
cases, reports ambiguous ones, and changes nothing on a healthy profile no
matter how many times it is pressed or which display unit is selected.

Regression coverage lives in `tests/unit-provenance.test.mjs` (pure, with
expected kilograms hard-coded from an INDEPENDENT calculation) and
`e2e/units-migration.mjs` (boots the real app on pre-remediation localStorage).
The original migration shipped with a passing suite precisely because every
test called `migrateStoredData()` directly and none booted the app.

## The display boundary is not optional, and one screen skipped it

Found 2026-08-20, by the owner, on real data.

`#history` rendered a 140 lb pulldown as **140lb**. `#exercises` - the exercise
detail, two taps away, reading the SAME record - rendered it as **63.503 lb**:
the stored kilograms with a pound label stapled on. Same for 130 -> 58.967,
110 -> 49.895, 60 -> 27.216, 10 -> 4.536.

The cause was not the migration and not the data. Storage was correct
(63.5029318 kg, stamped canonical). `history-view.js` passed every number
through `displayWeight()` / `volumeIn()`; `exercises-view.js` never imported
`utils/units.js` at all and interpolated raw stored weights beside
`settings.weightUnit`:

```js
${bestSet.weight.toLocaleString()} ${unit}   // 63.503 lb
```

Six sites in that one file: Best Set weight and volume, the per-set history
chips, the up/down comparison tooltips, the Top weight / Best e1RM tiles, the
progression chart axis and the 90-day e1RM sparkline (which is why the
sparkline read "87 lb" for a 192 lb e1RM).

**Why no test caught it.** Every screen was only ever asserted against itself,
so a screen that was consistently wrong looked consistently right. The unit
suite proved `displayWeight()` converts; nothing proved that each renderer
CALLS it.

**The rule, now enforced at the source level** by
`tests/unit-display-boundary.test.mjs`:

- A stored weight interpolated next to a unit token is a defect. The test
  greps every file in `js/views/` for that shape and fails on it.
- Two ways to satisfy it, both of which make the unit legible at the call
  site: call a conversion (`displayWeight` / `volumeIn` / `formatWeight` /
  `formatVolume` / `toSessionWeight` / `toDisplay`), or name the local with a
  **`Shown` suffix** meaning "already through the display boundary, in
  `unit`" - `bestWeightShown`, `loadShown`.
- No view may hard-code `2.20462` or `0.45359237`.

Verified to fail against the pre-fix `exercises-view.js` and pass after, so it
is a real tripwire rather than a restatement of the current code.

The generalisable lesson: when a codebase migrates to canonical storage,
"the conversion helper is correct" and "every consumer uses it" are different
claims, and only the second one is what the user sees.

## Automatic weight suggestions: removed, and why the number was wrong anyway

Removed 2026-08-20 at the owner's request. `js/utils/progression.js`, the
bump/deload badges, the tap-to-reveal panel, "Use last weight", the per-set
"Repeat weight" warning and all their CSS and tests are gone. A planned row
now prefills from the lifter's own last session, set for set.

It is worth recording WHY the removal was also a bugfix, because the defect is
the same shape as the one above:

    _overloadIncrement(exerciseId, unit)   // 'lb' -> 5, meaning FIVE POUNDS
    evaluateProgression({ lastSets, increment })
        suggestedWeight = lastWeight + increment

`lastWeight` is canonical KILOGRAMS. So the 5 that meant 5 lb was added as
5 kg:

    60 lb  = 27.2155 kg  + 5  = 32.2155 kg = 71.02 lb  -> prefilled "71"
    delta shown = 71 - 60 = 11               -> "+11lb suggested"

Reproduced exactly on a 10 lb Decline Crunch: 4.5359 + 5 = 9.5359 kg = 21 lb,
badge "+11lb suggested". A display-unit increment crossing into canonical
arithmetic - the mirror image of the render bug.

The prefill was DOM-only: `gymTrackerActiveWorkout` holds no set until one is
committed, so a suggested number only reached storage if the lifter actually
ticked that row. Once committed it is indistinguishable from a deliberate
entry, which is precisely why nothing may rewrite history on suspicion.

The +/- stepper increment survives as `_stepIncrement`, renamed so the unit is
legible: it is applied to the DISPLAY-unit value in the input, in that same
unit, which is why it was always correct.

## Two rules the live workout now keeps

### A user edit to an unfinished row is active-session state

Pre-existing defect, found by the owner 2026-08-20. Type 65x8 into set 2, tick
set 1, and set 2 snapped back to the prefilled 60x12.

The delegated `input` handler in `wireWorkoutActions` updated everything EXCEPT
the number: notes went to `exercise.notes`, the bar weight went through
`setExerciseBarWeight`, but `.set-weight` / `.set-reps` only refreshed the
plate hint and the restore chip. The typed value lived in the DOM alone, so
`commitPlannedSet` -> `renderExerciseEntry` rebuilt the row from
`stickyValues[i] || previousSets[i] || ...` and the edit was gone.

`stickyValues` was already the right store - `unmarkSet` and `setSessionUnit`
both write it and the renderer already prefers it over the previous workout.
It simply was never written while the lifter was TYPING. `recordPlannedRowEdit`
now writes it on every input into a planned row, CANONICAL like every other
writer, and debounces through `persistActiveWorkoutSoon`, so the edit also
survives a reload and Resume.

The shape of the rule: **prefill and carry-down INITIALIZE an untouched row;
once a row is edited, active state owns it.** Verified against every re-render
trigger - completing another set, un-completing one, adding a set,
collapse/reopen, the feel prompt on a DIFFERENT exercise appearing and being
dismissed, and reload + Resume.

An emptied field is recorded as `''` on purpose. Clearing a row is an edit too
and must not silently repopulate from last time.

### An input's `min` attribute validates nothing here

The commit is a button click, not a form submit, so the `min="1"` on the reps
field was decorative: `commitPlannedSet` and `saveSetEdit` guarded with
`!reps`, which `-3` passes. A negative rep count stored happily and produced
`VOLUME -240kg` in the session detail, "0kg" on the history card and weekly
tile, and a negative row in the CSV. `parseInt` also read `1e3` as 1 and `8.7`
as 8 without a word.

Both paths now share `parseSetEntry(weight, reps)`: reps is digits only and
>= 1 (a `1e3` on a rep counter is a typo, never 1000), weight is finite and
>= 0 (0 is legitimate bodyweight work). A rejection marks the row
(`.set-row--invalid`, `aria-invalid`, a `role="alert"` message under the
inputs, focus on the offending field) instead of firing a toast that did not
say which field was wrong; typing in the row clears it. Pinned by
`tests/set-entry-validation.test.mjs`, which runs the REAL extracted methods
against a DOM stub, so a future `!reps` fails immediately.

The same family, fixed in the same round:
- The measurement form is `novalidate` and never checked its own `min`/`max`,
  so `-5 kg`, `150 %` body fat, `1e7 kg` and dates in 2030 were stored and
  drove every trend tile ("-132 % vs 30d"), and two taps on Save before the
  modal closed stored two records. `validateMeasurementEntry` now enforces
  canonical ranges and a real, non-future calendar date (`2026-02-29` is
  rejected by round-tripping the parts; `new Date('2026-02-29')` silently
  becomes March 1), the date input carries `max=today`, and `saveFromForm`
  holds an in-flight guard for 500 ms after a successful save, like the
  program form. `tests/measurement-entry-validation.test.mjs`.
- The finish modal's heart-rate and calorie fields were guarded by native
  validation only (a browser bubble on an otherwise inline-validated form).
  `validatePostWorkoutMetrics` checks them and the modal shows the same inline
  copy as everything else.
- The workout timer rendered `-1:-52` after a backwards clock change
  (`Date.now() - startTime` with no clamp, `formatTime` with no negative
  case). `TimerService` keeps a monotonic `_clampedElapsed()` - elapsed time
  never runs backwards, it holds until the wall clock catches up - and both
  formatters clamp at 0. `tests/timer-service.test.mjs` drives it with
  `mock.timers.setTime` going backwards.

### The feel smiley lasts exactly one workout

`latestFeelForExercise` scanned the WHOLE history and returned the most recent
`'good'` wherever it sat, skipping over every later session that had no
marking. Mark an exercise good once and the icon was permanent.

`previousSessionFeelForExercise` asks a single question instead: did the
IMMEDIATELY PREVIOUS session that performed this exercise carry an explicit
`feel === 'good'`? It lasts one following workout and must be renewed.

Deliberately not coupled to performance - a heavier session, more reps or a new
PR since the marking changes nothing. A legacy `'bad'` expires it exactly like
an unmarked session. "Previous session" means the last one in which the
exercise was actually PERFORMED (at least one completed set), because skipping
an exercise is not evidence about it. Identity goes through `sameId`, since ids
arrive as strings from an export round trip and numbers from the catalog.

The old tests encoded the old rule (one was literally "a newer bad does not
override an older good"), so they were replaced rather than adjusted. The new
suite fails 8 checks when run against the old implementation.

## Timed work is time, not weight (GT-04)

`Set.volume` returned `this.duration` for a timed set and
`WorkoutSession.totalVolume` summed all set volumes, so a 60-second plank
contributed "60 kg" to the finish summary, the completion burst, the History
card, the session detail, the Home weekly tile, the Insights muscle chart
("Core 300 kg" for five minutes of planks) and the CSV `volume` column under
`unit=kg`. The CSV column sum matched the app's all-time figure, so the error
was systemic, not display-only.

`Set.volume` is now `weight × reps` and ZERO for a timed set; seconds are
reported by `Set.timedSeconds` / `WorkoutExercise.totalTimedSeconds` /
`WorkoutSession.totalTimedSeconds`, and surfaced as a separate "Held" figure.
`js/utils/session-metrics.js` carries the same rules for the plain objects
that come straight out of storage.

One place still counts time deliberately: `getLastTrainedByCategory` asks "was
this muscle trained?", which is a yes/no, and a plank IS core work. That is
the ONLY place seconds and weight-volume are treated alike, and it never
produces a number with a unit.

## Active workouts are always recoverable (GT-01, was a BLOCKER)

Two independent failures made an in-progress workout disposable:

1. **Nothing wrote.** `workout-view.js` had six `saveActiveWorkout` call sites
   (start, unit switch, pause, resync, feel, swap) and `commitPlannedSet`,
   `saveSetEdit` and `deleteSet` were not among them. The stored blob read
   `sets: []` while the screen read "2 / 4 sets".
2. **Nothing restored.** Every recovery path gated on `paused === true`
   (`paused-banner.js`, `app.updateGlobalFab`, `app.handleGlobalFabClick`,
   `home-view`), and an interrupted workout is stored with `paused: false`. It
   was unreachable forever, and the stale record lingered invisibly.

The write side is now ONE path: `persistActiveWorkout()`. It writes
synchronously (a set commit is exactly the moment a tab kill must not cost
anything) and refreshes `elapsedBeforePause` without touching `paused`, so an
interrupted workout resumes with its real elapsed time. Only the
per-keystroke notes field is debounced, via `persistActiveWorkoutSoon()`, and
`flushPendingPersist()` is called from the notes collapse, from pause, and
from `pagehide` / `visibilitychange` - the two moments a mobile browser is
most likely to kill the page. **A new mutation path must call
`persistActiveWorkout()`**; `tests/active-workout-persistence.test.mjs`
enumerates them and fails on one that does not.

The read side is `js/utils/active-workout.js`. `readableActiveWorkout()` is
the single predicate for "may this be offered?": structurally sound, not
completed, at least one exercise. It deliberately refuses a COMPLETED session,
so a crash between "save session" and "clear active" cannot resurrect a
workout the lifter already finished. Paused and interrupted workouts are both
recoverable and are labelled differently, because one the lifter chose and the
other happened to them.

**One workout, one owning tab.** Every writer serialises the whole in-memory
session, so two tabs logging at once used to lose each other's sets on every
commit, and the second Finish overwrote the first session by id - the first
tab's work was gone from history for good.

The fix is an ownership lock, not another persist call:
`gymTrackerActiveWorkoutLock` holds `{ tabId, at }`, claimed on start and
resume, refreshed every 5 s while the workout is live, and considered stale
after 20 s (`lockedByOtherTab` in `js/utils/active-workout.js`). While another
tab's lock is fresh, this tab renders "Workout in progress in another tab"
instead of a Resume banner, hides the FAB, and refuses both `startWorkout` and
`resumeWorkout`; `persistActiveWorkout` returns early rather than writing a
stale copy, and a tab whose lock was taken over stands down on its next
heartbeat. Pause releases the lock on purpose (a paused workout is meant to be
picked up anywhere), as do finish and discard.

`finishWorkout` additionally reads before writing: if a completed session with
this id is already in storage, another tab finished it and this tab says so
and leaves the live screen rather than saving over it.

The tab id lives in `sessionStorage`, so a reload keeps it and a duplicated
tab gets its own. Everything else (programs, sessions, settings, achievements,
custom exercises, measurements) is kept coherent by
`sync-system/tab-sync.js`: the app re-reads those keys and re-renders on a
foreign change, so a program added in one tab appears in the other and a
program deleted there is not resurrected by the next write here. The handler
only ever reads - writing from inside it is what cost Trip Planner its undo.
Pinned by `tests/active-workout-lock.test.mjs` (lock semantics, storage
accessors, `restState` round trip) and `e2e/audit-2026-08.mjs` block G (two
real tabs).

## What counts as a workout (GT-14, GT-23)

- A session with **zero completed sets is not a workout**. It holds no logged
  information: finishing requires at least one completed set, so the only way
  to reach that state is removing an exercise's history out from under it.
  `deleteExerciseHistory` prunes such sessions at the source (and says so in
  its confirmation), and migration v2 cleans up any that already exist. Before
  this, a `0 kg / 8 exercises / 0 sets` husk still counted toward the weekly
  tile, the streak, the calendar marker and the monthly total.
- **Exercise counts mean exercises PERFORMED.** A session lists every planned
  exercise, so `exercises.length` said "8 exercises" over seven rendered
  blocks. `performedExerciseCount` (model + `session-metrics.js`) is the
  count every surface uses.

## "Trained recently" is about work, not tonnage

Found while re-auditing the 2026-08-19 remediation, not in the original audit.

Making volume weight-only (GT-04) was correct, but `getStaleProgramCategories`
derived "trained recently" from `getVolumeByCategoryInRange`. A category
trained only with timed work - core, via planks - produces zero weight volume,
so Insights listed **Core as "not trained recently" while the same row said "7
days since last trained"**. Pre-remediation this could not happen, because
volume included duration.

`getLastTrainedByCategory` already had the right rule ("a plank IS core work"),
so staleness now tests that date against the window and never consults volume.
The caption reads "Not trained in the last 14 days" rather than "No volume in".

The general shape: when a metric is deliberately narrowed, every consumer that
used it as a proxy for something BROADER has to be re-derived. Grep the
narrowed function's callers, not just its own tests.

## Weeks have ONE definition (GT-10, GT-11)

`js/utils/week.js` owns `startOfWeek(date, firstDay)` and `weekKey`. The
Calendar, the workout week strip and the program-editor day chips honoured the
first-day-of-week setting; Home, the weekly volume/time tiles and the weekly
achievements were hard-coded to ISO Monday, so a Sunday-first user's Sunday
session vanished from their own weekly count. `AnalyticsService.startOfWeek`
and `AchievementService.sessionsThisWeek` both delegate here;
`startOfIsoWeek` survives as the Monday-pinned alias its callers already used,
which is what keeps the audit-verified Monday arithmetic identical.

"Perfect Week" now uses a `weekly-distinct-days` requirement, because
"Complete a workout every day this week" is a claim about DAYS and it was
counting sessions (seven sessions over two days unlocked it). Achievement
definitions are code, so `AchievementService.syncDefinitions` refreshes
wording, targets and requirement types onto stored records on boot - and when
a requirement TYPE changes it re-evaluates the unlock, withdrawing a badge
earned under the old rule unless the lifter genuinely satisfied the new one.
Leaving a badge standing that its own description contradicts is just a
quieter version of the same bug.

## Import: merge and replace are different operations (GT-02)

The dialog promised "It will be merged with your existing programs, workouts,
and settings" and `importAllData` did `if (data.programs)
this.savePrograms(data.programs)` for each store. Importing a sessions-only
file destroyed a program and 17 unlocked achievements, with no undo and no
backup.

`js/utils/import-merge.js` now owns the semantics and `importAllData(data, {
mode })` takes an explicit mode:

- **Merge** (the default) unions by record id using `sameId`, so a string id
  from an export matches the numeric one it came from instead of duplicating
  the record. An EMPTY imported array is "nothing to add", never "delete
  everything" - that exact shape is what did the damage. Collisions resolve
  deterministically: newer `updatedAt` / `timestamp` / `createdAt` wins,
  ties go to the imported record, an unlocked achievement always beats a
  locked one (an unlock is a fact that happened), and settings merge key by
  key so a file that omits a setting cannot reset it.
- **Replace** restores a full backup, says plainly that anything not in the
  file is deleted, asks for a stronger confirmation, and downloads a rollback
  file first. Even then it only touches stores the file actually carries, so a
  "programs only" backup cannot erase a history it says nothing about.

The malformed-payload validation in `settings-view.js` is unchanged and still
runs first.

## Touch targets and the rest dial (GT-05, GT-19)

The audit measured every control in the live workout below the 44×44 the
README claimed: steppers 26×38, rest-timer buttons 24px tall, icon buttons
34×34, Finish 85×34.

What is true now, measured by hit-area probing (`elementsFromPoint` walked
outward from each centre, not `getBoundingClientRect`, because a 34px box can
own a 44px tap area and only the probe can tell):

- Everything is **≥44px tall** and **≥36px wide**; most are 44×44.
- Compact controls get their tap area from a transparent `::after` expander.
  For the steppers it reaches 7px outward and 7px over their OWN input's edge
  - never into another control, and the number field keeps its whole centre.
- The steppers cannot ALSO be 44px wide on a phone: four of them plus two
  readable number fields do not fit one line at 390px while the row still
  holds "102.5" (measured - the weight field has ~60px and zero slack). Below
  360px the reps field takes its own line and they reach a full 44×44 there.
- Hit-area expanders need room: the header icons were 34px on a 2.4px gap, so
  adjacent 44px expanders overlapped and each button really owned ~36px. The
  gap is 0.62rem for that reason, and `.set-row-actions` likewise.
- `.gt-stepper-group` is 46px so its 1px border leaves a 44px INNER box, and
  it must keep `overflow: visible` or the expanders are clipped for
  hit-testing too.

**The visual regression this caused, and the rule from it.** Making the dial
non-blocking was right; making it SMALLER was not. The first attempt shrank the
dial to 128px on phones and grew the buttons to 34x62 for the 44px target. Two
62px buttons plus the gap are ~129px inside a 128px circle, so `+30s` and
`Skip` were pushed 11px through the ring on both sides at 390px and 320px - the
component looked broken. The dial keeps its **146px production diameter** and
the buttons keep their **24x46 production size**; the 44px target comes from
the transparent `::after` expander, which is the whole point of that technique.
A hit-area fix must never move the artwork. Verified by measuring each button's
four corners against the circle's radius, not by eye.

The rest dial was worse than a small target: its 146px SVG ring intercepted
taps across a far larger area than the dial looked, and hit-testing found 9
controls of the next exercise unusable for the whole rest period. Two changes,
both needed: nothing in the dial except its two buttons takes pointer events,
and the exercise list reserves bottom padding while the dial is visible
(`body.gt-rest-bar-visible #workout-exercises-list`), so in the ordinary
scroll position it overlaps nothing of the NEXT exercise. The disc is also
translucent, so tapping "through" it is comprehensible rather than uncanny.
Correction from the 2026-08-22 audit (D11, fixed): the reserved 172 px sits
below the list, not between exercise 1 and the dial, so at 390x844 after
committing set 1 the centre of `#exercise-0 .btn-add-set--extra` hit-tested to
`#rest-skip-btn` - the CURRENT exercise's own "Add set" was blocked for the
whole rest period. Padding cannot fix that (the dial is fixed to the
viewport), and the artwork must not move, so `keepAddSetClearOfDial()` scrolls
the set-row footer above the dial when the dial would cover it, and only when
that row is on screen. `e2e/audit-2026-08.mjs` asserts the hit test at 390.

## The sitewide button height, which min-height cannot beat

`assets/css/main.css` gives EVERY button `height: 3.25rem; line-height: 3.25rem`
(47.67px at this app's root size). A plain `height` beats any `min-height`, so
an app rule that sets `min-height: 28px` still renders 48px tall and the
control silently comes out nearly twice its intended size. The inline feel
prompt's buttons measured 48px for exactly this reason.

The pin is the one `button.gt-note` already uses:

    height: auto !important;
    min-height: <n>px !important;

Worth checking with a computed-style probe whenever a compact button "ignores"
its CSS - it is the same family as the `button { color:#555 !important }` trap
already documented below.

## Theme collisions found in this round

- `assets/css/main.css` `button { line-height: 3.25rem }` inflated the
  week-strip pill's label line box to 47.67px inside a 48px column-flex pill;
  with both children `flex-shrink: 1` the label won and the scheduled-day dot
  rendered 5px wide by **0px tall**, so program scheduling looked broken
  (GT-09). Fixed by pinning the pill's line-height and giving the dot
  `flex: 0 0 6px`. This is the same class of bug the repo CLAUDE.md warns
  about; a computed-style check on the DOT, not the pill, is what catches it.
- `.set-col-head` at 0.56rem of `--gt-muted-2` measured 8.21px at 3.92:1 - 16
  axe "serious" nodes on the only element telling a lifter which field is
  which. The app's root font-size is ~14.7px, so rem-based sizes read smaller
  than they look in the stylesheet; 0.85rem lands at ~12.5px. #8b94a6 clears
  4.5:1 on every surface the caption sits on.

## Exercise search (GT-24)

`js/utils/exercise-search.js` is shared by the Exercise Database, the program
picker and the in-workout swap picker. Normalisation folds case, hyphens,
apostrophes and a trailing plural "s", so "Pull-Ups", "pull up" and "pullup"
all reach the same tokens; a term may also be a run of consecutive name words
written without separators (`matchesTokenRun`), which is anchored at token
boundaries on purpose - a bare `squashedName.includes(term)` gives "row" a
full-strength match inside "Nar-row- Chest Press Machine", which is the exact
mis-ranking the module exists to remove. EVERY query term must match
something, which is what lets "triceps pushdown" combine a name word with a
category word. A mid-word substring scores almost nothing, so it can only ever
break a tie.

## One exercise taxonomy, four surfaces (GT-26)

The category and equipment lists were written out four times in `index.html`:
the Exercise Database browse filters, the create-custom form, the program
picker and the in-workout swap picker. Three had drifted. The create form
offered 10 categories where browse offered 17, so a custom exercise could not
be filed under forearms, glutes, abs, obliques, traps, neck or cardio, and one
filed elsewhere then failed to appear under the filter its catalog neighbours
used.

`js/utils/exercise-taxonomy.js` is now the single definition, and every one of
the four selects is filled from it by `populateSelect()` at open time. The
markup still carries a static list so the page is usable before the module
runs, but it is no longer the source of truth: the view overwrites it. The
picker filters preserve their behaviour across repopulation (the swap picker
still pre-selects the current exercise's category), and
`tests/exercise-search.test.mjs` asserts both that the taxonomy covers every
value the real 514-exercise catalog uses and that all three view files still
populate from it, so a fifth hand-written copy cannot creep back in.

## The estate's own gotchas, extended

- **Escape closes a modal by clicking its `.modal-close`**
  (`modal-focus.js` `closeModal`), so wiring that button to a guarded close
  gives Escape the same guard for free. That is how the program editor's
  discard confirmation covers Cancel, X and Escape with one change (GT-08).
- **`extractClassMethod` now finds `async` and `get` methods too.** The marker
  used to be `\n    name(` only, so an `async` method was invisible to the
  test estate.
- **A docstring quoting old code can satisfy a `doesNotMatch` assertion.**
  `tests/active-workout-persistence.test.mjs` strips comments before asserting
  that the `paused`-only gate is gone, because the fix's own comment quotes it.
- **Driving the app headlessly: navigate by `[data-view=...]`, not by label.**
  The app renders BOTH the mobile bottom nav and the desktop side nav, so a
  text match lands on a zero-height duplicate and the click silently does
  nothing.
- **Measure touch targets by probing, not by `getBoundingClientRect`.** A
  control half under the sticky header also measures short for a reason that
  is not its target size, so scroll it into view first.

## Other decisions from the 2026-08-19 round

- **The shared auth modal is white BY DESIGN** (GT-41). `assets/css/firebase-auth.css`
  pins `color-scheme: light` on `.auth-modal` / `.signout-modal` and neutralises
  Chrome's autofill paint with the inset box-shadow technique, because these
  overlays are appended to `<body>` and inherited the app page's dark scheme,
  flipping UA autofill/native-widget rendering to grey inside the white card.
  `sync-system/tests/shared-ui-consistency.test.mjs` enforces both. This round
  therefore re-points only the ACCENT (the #667eea → #764ba2 gradient CTA, the
  active tab, the links) at the app's azure, scoped
  `body.gym-tracker #auth-modal ...` - the id is required to outrank that
  stylesheet's own `body #auth-modal ...` rules. Do not fork the surface per
  app without re-solving the autofill problem it closed.
- **The picker's search + filters are the other half of GT-17.** Collapsing the
  selection tray was necessary but not sufficient: the stacked search box and
  two filter selects took ~230px of a 717px sheet and each result card was
  ~140px tall, so barely one card was readable while multi-selecting. Phone
  breakpoints put the filters on one row and compact the cards, which is what
  takes "cards fully visible with 8 selected" from 0 to 5.
- **The onboarding tour's scroller is `.onboarding-body`, not `.modal-content`.**
  The header and footer sit outside the scroll on purpose. Anything that
  watches the tour's scroll position - the back-to-top opt-in, the footer
  label - has to hang off the body, or it reads a 2,100px tour as already
  finished the moment it opens (GT-35).
- **`getWeekStats` etc. take the first day of week as a PARAMETER** rather than
  reading settings, so `AnalyticsService` stays free of app state and the
  Monday-pinned callers keep their exact previous behaviour by passing 1.
- **Program set rows gained `targetSeconds`** (null on a reps exercise). The
  model cannot know whether a row is timed - only the catalog does - so the
  VIEW decides which control to render and falls back to
  `DEFAULT_TARGET_SECONDS` when a legacy timed row has none. Nothing rewrites
  the meaningless `repsMin/repsMax` those rows carry.
- **`WorkoutExercise.plannedExerciseId`** records the PROGRAM row a session
  slot came from. An in-workout swap changes `exerciseId` (so sets, history
  and PRs follow the substitute) and leaves `plannedExerciseId` alone (so the
  rep target, per-slot ranges and rest values survive) - GT-13.

## Running the app's own E2E suite (e2e/audit-2026-08.mjs)

- `GYM_E2E_TRACE=1` prints each check as it lands. A CDP command timeout
  ("timeout: Runtime.evaluate" / "Input.dispatchMouseEvent") surfaces as a
  THROWN error with no failing assertion, so without the trace there is no way
  to tell WHERE the run died.
- Three things were needed to stop those timeouts, all of them load, not
  product: inject axe ONCE per page (re-parsing the ~500 KB vendor bundle
  before each of a dozen scans was the biggest offender), take a fresh page for
  each viewport leg instead of flipping device metrics on a page that has
  already driven a live workout, and wait for `.completion-burst` to clear
  after finishing a workout (it animates over the page for ~4 s and swallows
  input). The finish-modal scan is scoped to the dialog for the same reason.
- Honest status: the last six consecutive runs were clean (84/84); before those
  changes roughly one run in four ended in a CDP timeout at a different heavy
  step each time, never in an assertion failure. If it reappears, run with the
  trace flag before assuming the product broke.
- Teardown between blocks goes through the app: a live workout arms a
  `beforeunload` listener, and `window.onbeforeunload = null` does NOT remove a
  listener, so the dialog opens mid-navigation and whatever CDP command is in
  flight can hang. `discardWorkout()` stops the timers, clears the blob and its
  lock, and disarms the guard.
- Offline in the deploy block is simulated by making the ORIGIN unreachable
  (the suite's own proxy destroys the socket), not only by CDP emulation:
  emulation has to be re-applied to every `service_worker` target, and a worker
  Chrome restarted mid-run comes back online behind the test's back.

## Gym Tracker forks two pieces of shared UI, so shared fixes skip it

`js/utils/sync-status.js` and the `.sync-banner` / `.sync-status-pill` rules in
`css/gym-tracker.css` are gym-local COPIES of `assets/js/sync-status.js` and
`assets/css/sync-status.css` (gym adds a side-nav pill, a bottom-nav dot, and
hides the banner on desktop, and its index.html never links the shared
stylesheet). A fix to the shared pair therefore does nothing here.

That is exactly what happened on 2026-08-23: the shared banner was moved below
the fixed site header (`top` follows `#header`'s bottom edge, z-index 10000
under the header's 10001, plus a close button) so it stopped covering the
logo, Menu and Sign In. Gym kept `top: 0; z-index: 1100`, and since the header
is 10001 the offline banner was drawn ENTIRELY BEHIND the header on phones:
not "slightly covered" but invisible, so an offline user got no notice at all
(screenshot pair in `.screenshots/audit/gym-banner/`). Gym now mirrors the
shared contract: `placeBanner()` on show, on resize and on
`shevato:include-loaded` (the header is an injected partial, so its height is
unknown at mount), z-index 10000, and the same dismiss button. Desktop still
shows the side-nav pill instead of a banner, which is deliberate.

Two things to keep in mind when either copy changes: the geometry assertion is
what catches the "hidden under the header" failure (the hit-tests pass in that
state, because the header is above the banner either way), and the hit-tests
are what catch the opposite failure (a banner raised above the header, which
is the bug the shared move was fixing). `e2e/audit-2026-08.mjs` block M pins
both at 390, plus the desktop-pill behaviour at 1280.

## What the 2026-08-22 remediation round changed (and what it taught)

- **Tablet widths 768 to 820 px are their own layout.** The 250 px side nav
  switches on at 768 while the content column is still narrow, and the only
  narrowing breakpoint for `.view-header` and the Settings data row was
  639 px, so `#create-custom-exercise-btn` and `#clear-data-btn` pushed
  `scrollWidth` to 855 / 897. `.view-header` now wraps at that width and
  `.setting-actions` is `repeat(auto-fit, minmax(190px, 1fr))` instead of a
  fixed three columns. `e2e/audit-2026-08.mjs` asserts `scrollWidth <=
  innerWidth` and each button's right edge at 768 AND 820.
- **Import validation is now per field, not per store.** See "Import: merge
  and replace are different operations" and the README; the sanitiser is
  `js/utils/import-sanitize.js`, applied inside `importAllData` so the file
  import and the backup restore cannot diverge, and its repairs are disclosed
  in a toast. The replace-import confirm no longer over-promises: replace only
  touches the kinds of data the file carries, and the copy now says exactly
  that.
- **`getCurrentStreak` normalises dates.** It used to put raw `s.date` strings
  in a Set and look up `YYYY-MM-DD` keys, so an imported or synced session
  carrying a full ISO timestamp never counted (the app itself always writes
  `YYYY-MM-DD`, which is why nobody saw it). It now goes through
  `toLocalDate` / `toLocalDateKey` like every other date surface, and an
  unparseable date is skipped rather than thrown on.
- **The custom-exercise modal resets on open.** It kept the previous name in
  the field; the program and measurement modals already reset.
- **a11y, fixed and pinned.** Accessible names on the four Exercise Database
  selects and the two program-picker filters; history cards are no longer
  clickable containers wrapping a delete button (the card title is the button
  now, which is also what `nested-interactive` wanted); `aria-current` on the
  nav; `#insights-heatmap` is a focusable scroll region with a "scroll left
  for earlier months" hint that disappears once you scroll; visible focus
  rings pinned for `.btn` and the set-row number inputs.
  Two colour lessons worth keeping:
  `main.css` sets `button { color: #555 !important }`, which `all: unset` does
  NOT beat - the history card title needed `color: inherit !important`; and
  `refresh.css` loads AFTER `gym-tracker.css` and pins
  `body.gym-tracker .btn-primary { color: #fff !important }` at (0,2,1), so
  the dark-on-green finish button had to out-specify it with the modal id.
  Fixing a colour in the wrong file looks right in source and changes nothing
  on screen.
- **`rem` here is not 16 px.** `main.css` sets the root font-size in points
  (11pt = 14.67 px at these widths), so `0.58rem` on `.rest-timer-caption`
  computed to 8.5 px and `0.72rem` still only reaches 10.56 px. Any "is this
  text big enough" judgement has to be made in computed pixels, not in rem.
- **Programmatic `.focus()` does not arm `:focus-visible`.** A probe that
  focuses a button and reads `outline` will report "no focus ring" on
  perfectly good CSS. Use `el.focus({ focusVisible: true })` (Chromium honours
  it) or real key events.

## 2026-08-19 verification round (what was actually run)

Everything below was driven against the real app over CDP (coordinate clicks
and `elementsFromPoint`, never bare `element.click()` for anything
hit-sensitive), at 390x844, 320x700 and 1280x900:

- **GT-01 end to end**: start -> log sets -> confirm storage matches the screen
  -> reload WITHOUT pausing -> the recovery banner -> resume -> every set,
  note and swap restored; then un-mark, edit and note, each re-checked in
  storage; then finish and confirm the workout is not offered again.
- **GT-03 across surfaces**: history card, session-detail set rows, exercise
  trend, measurement tiles and the CSV, read in kg, then in lb, then back in
  kg, with the raw localStorage value asserted unchanged throughout.
- **Touch targets by hit-area PROBING** (`elementsFromPoint` walked outward
  from each centre after scrolling the control into view), not
  `getBoundingClientRect`, at both phone widths, alongside a
  no-horizontal-overflow check.
- **The rest dial hit-tested**: every control overlapping its box, before and
  after, plus +30s and Skip still working.
- **axe-core (wcag2a + wcag2aa)** on the live workout: zero serious/critical.
- A full **human-like journey** from a clean profile: first run, build a
  program by searching the way a person types, schedule it, train it on a
  phone, let a rest timer run, swap, note,
  interrupt mid-workout, resume, finish, review History and Insights, add a
  measurement, switch units, export, reload.

## 2026-08-12 verification round (what was actually run)

- Repro + fix verified with coordinate clicks and `elementsFromPoint` hit
  tests (never `element.click()`), desktop 1280 and mobile 390, before and
  after: the stacked-modal bug, commit-to-plan, both cancel paths, unsaved
  edits surviving the picker, multi-add, reload persistence.
- Rename/history: seeded pre-rename programs, sessions and a strength-PR
  achievement carrying the old snapshot; verified every surface shows the new
  name while sets/dates/weights/notes/volumes and per-exercise history counts
  (by id) stayed intact.
- Full functional audit: 45 driven checks across plans (validation, set rows,
  reorder, supersets, uniform rest, duplicate/delete), workout (log/edit/
  delete set, swap, pause/resume, finish, discard), history (detail, Escape,
  program-delete independence), catalog (custom exercise lifecycle),
  resilience (corrupt-blob boot, export/import round-trip), mobile spot
  checks. All passing at the end of the round; `npm test` (2430) and
  `npm run test:browser` (190) green.
