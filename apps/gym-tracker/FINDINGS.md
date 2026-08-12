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
delete-guard. `AnalyticsService` internals still use `===` - both sides come
from the same session records there, so it holds, but any NEW code path that
mixes a DOM-sourced id with stored data must go through `sameId`.

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

## Service worker

`data/exercises-db.json` is precached; **any catalog edit needs a
`CACHE_VERSION` PATCH bump in `sw.js`** or existing installs keep serving the
old catalog until the next unrelated bump.

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
