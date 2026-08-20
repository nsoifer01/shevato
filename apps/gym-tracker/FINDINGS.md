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
scroll position it overlaps nothing at all. The disc is also translucent, so
tapping "through" it is comprehensible rather than uncanny.

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
  phone, use the progression controls, let a rest timer run, swap, note,
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
