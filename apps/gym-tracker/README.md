# Gym Tracker App

A comprehensive, mobile-first workout tracking application built with vanilla JavaScript, featuring program creation, workout execution, analytics, and achievements.

## Features

### 🏋️ Core Functionality

- **Program Builder**: Create workout programs with custom exercises and reorderable exercise lists; each set row has a labeled toggle for a single rep target or a rep range (e.g. set 1: 11-12, set 2: 8-10); a program-level rest mode (one uniform between-exercises duration set with an M:SS stepper, or custom per-exercise rest); the exercise picker opens as a child modal ON TOP of the editor (the plan being edited stays open and untouched underneath: committing returns the picks to it, cancelling the picker returns to it with all unsaved edits intact, and closing the editor by any route also closes the picker); removing an exercise asks for confirmation
- **Program List Sorting**: Sort the program cards by name or exercise count, or keep a custom order created by dragging cards around; the chosen sort and the custom order both persist (dragging a card switches the list to custom automatically)
- **Supersets**: Link consecutive exercises into a superset so they are grouped together in both the program builder and the workout view
- **Workout Execution**: Mobile-optimized interface for tracking sets, reps, and weight during workouts. Every change to the live workout - a set completed, edited, deleted, an exercise note, a swap, a unit switch - is written to storage as it happens, so a refresh, a locked phone or an evicted tab loses nothing and the app offers the workout back on the next load whether or not you pressed Pause; per-set rep range labels (shown once per exercise when all sets match); rest is shown by a compact floating circular timer dial, color-coded (green between sets, blue between exercises), with the countdown centered and +30s / Skip controls inside it; the dial is translucent and only its two buttons take taps, and the exercise list reserves room for it, so it never blocks the controls underneath; and for uniform programs the between-exercise rest also shows in the sticky workout header; after-exercise rest is read-only during a workout (it is set in the program); a pencil button on each exercise opens an inline notes field saved as you type, and a "same as last time" chip restores the previous session's weight and reps on a row; weight and reps are each a single control with the number as the focus and flat -/+ inside it, under WEIGHT / REPS column captions so it is obvious which side is which; tapping the exercise name or its metadata line collapses and expands the card, the same as the chevron; auto-collapsing completed exercises carry a green success tint (stronger while collapsed) and re-collapse after un-marking, staying collapsed across a pause/resume (the edit and plate-hint buttons hide while a card is collapsed); an identical plate breakdown is shown once per run of sets at the same weight rather than under every set; a final-5-seconds red pulse countdown with audio pings and haptics; the finish summary shows total volume with a percentage delta versus your previous session of the same program; and a plate calculator for all plate-loaded equipment (barbell, trap-bar, and plate-loaded machines such as the leg press) with per-exercise and global toggles whose state persists once a workout is saved
- **Timed Exercises**: Exercises marked as duration-based in the database are planned and logged in time, not reps: the program editor gives each set an M:SS target hold, the workout header shows "Target 1:00", and the set is logged with min:sec inputs. Their seconds are reported as TIME (a "Held" total on the finish summary, the history card and the session detail) and never counted as weight volume; rep ranges, plate hints, feel marking, and Strength PRs are skipped for them
- **"How did it feel"**: When every target set of a reps-based exercise reaches the top of its rep range, a compact inline row appears once on that exercise's card - a smiley, "Felt good?", and **Yes** / **Not now**. Non-blocking, dismissable and self-clearing, so it never interrupts the workout. The chosen mark shows as a smiley on the exercise header (tap to remove it). Next to the exercise NAME, a smiley means exactly one thing: **the immediately previous session that performed this exercise was explicitly marked good.** It lasts for exactly one following workout and must be renewed - it is never inferred from heavier weight, more reps or a new PR, and it never searches further back for an older marking
- **Workout Notes**: A free-text note captured in the finish-workout dialog, shown on the history card and in the session detail view
- **Exercise Database**: 500+ exercises categorized by muscle group and equipment, with persistent sorting (name, most recently used, most logged), numbered pagination, and the ability to remove a specific exercise's logged history. Search is relevance-ranked and separator-insensitive, so "pull up", "pullup" and "Pull-Ups" all find the same exercise and an exact name always comes first. Every surface that offers a category or equipment choice (browse filters, the create-custom form, the program picker, the in-workout swap picker) is filled from one taxonomy in `js/utils/exercise-taxonomy.js`, so a custom exercise can always be filed under the same category its catalog neighbours use
- **Back to top**: A floating button appears on long pages and tall modals, and on the public exercise directory pages, to jump back to the top
- **Custom Exercises**: Create and manage your own custom exercises
- **Workout History**: Complete history of all workouts with detailed stats, numbered pagination, and clickable workout details; each exercise in the session detail shows a small inline strength-trend chart of its top-set weight over recent sessions, plus any per-exercise notes you logged
- **Progress Tracking**: View previous workout data (all sets) during the current workout
- **Your edits are session state**: Typing a weight, reps or hold into an unfinished set records it on the active workout immediately. Prefill and carry-down only ever INITIALIZE an untouched row; once you have edited one, no later re-render (completing or un-completing another set, adding a set, collapsing the card, the feel prompt appearing) rebuilds it from defaults, and it survives an unexpected reload and Resume
- **Previous-session prefill**: A planned set starts from the lifter's OWN last session, set for set - set 1 from set 1, set 2 from set 2, falling back to the most recent set when the count differs. The app does not decide what you should lift: the automatic next-weight recommendation ("+X suggested" / deload badges, "Use last weight", the per-set "Repeat weight" warning) was removed on 2026-08-20 at the owner's request. Historical analytics are unaffected - Best Set, Top weight, e1RM, the 90-day e1RM sparkline and the "N sessions - +X% vs N ago" progression figure all remain
- **Weight/Rep Steppers**: One-tap minus/plus buttons flank every planned row's weight and reps inputs; weight steps by the exercise's increment, reps by 1 (floored at 0), without raising the phone keyboard, and plate hints plus the "same as last time" chip stay live
- **In-Workout Exercise Swap**: A swap button on each exercise header substitutes a different exercise for THIS session only (searchable picker pre-filtered to the same category); the saved program is never touched, swapping with logged sets asks for confirmation, and the substitute's sets count toward its own history and PRs
- **Warm-Up Ramp**: Barbell and trap-bar exercises whose working weight meets a configurable threshold show a collapsed warm-up strip above set 1 (empty bar, then percentage steps rounded to loadable plates) with one-tap ticks; warm-ups never count toward set completion, volume, or PRs
- **Body Measurements**: A dedicated Measurements view (its own nav entry) to log body measurements over time via an add-measurement modal, with a trends grid showing one tile per tracked metric (latest value, 30-day delta, and an inline sparkline) above the editable history list; included in the welcome tour
- **Measurement Goals**: Each trend tile takes an optional target value and direction (increase or decrease); a tile with a goal shows a progress bar and "N% to goal" under its sparkline, measured from the earliest logged value, and clearing the goal removes the bar without touching history
- **Calendar View**: Visual representation of workout days with progress indicators (first day of week is configurable, Sunday or Monday)
- **Program Scheduling**: Assign weekdays to a program; the days show on the program tiles, as markers on the calendar, and as a compact day-pill week strip at the top of the workout screen where tapping a day shows that day's scheduled workout below the pills and highlights the matching program card
- **Welcome Tour**: A single scrollable onboarding modal that explains the core features, with quick links into Programs, Workout, Calendar, and Settings; replayable any time from Settings
- **Workout Recovery**: An unfinished workout is always recoverable. Pausing is still explicit, but an interrupted session (refresh, crash, tab eviction) is offered back too, labelled as interrupted, with its logged sets and elapsed time intact. A finished or discarded workout is never offered again
- **Quick Start**: A floating "Start workout" button on desktop (visible across views; hidden on the active-workout screen) that starts or resumes a workout from anywhere
- **Achievements**: Unlock achievements for reaching milestones (daily, weekly, monthly, lifetime), plus per-exercise personal-record achievements shown in a dedicated "Strength PRs" section when you beat your all-time best on an exercise. Achievement wording, targets and rules live in code and are refreshed onto existing installs on boot, so a corrected definition reaches everybody - and an unlock earned under a rule that has since been corrected is withdrawn rather than left standing against its own description

### 📊 Analytics & Stats

- Weekly workout tracking. Home, the weekly volume/time tiles, the week-over-week deltas and the weekly achievements all use ONE week-boundary definition (`js/utils/week.js`), the same one the Calendar, the workout week strip and the program-editor day chips use, and it honours the configured first day of week
- Exercise frequency analysis
- Personal records tracking (max weight, reps, volume per exercise)
- Workout history with filtering and sorting, including a program filter (All Programs plus each saved program) that combines with the sort and date-range controls
- Clickable workout cards for detailed views
- Exercise history with best set tracking
- Insights view: a 4-week volume-by-muscle-group breakdown, a "Not trained recently" list (muscle groups in your programs with no volume for 14 days, never-trained first), and a 12-month consistency heatmap

### ⚙️ Settings & Customization

- Weight unit selection (kg/lb). This is a DISPLAY preference: every stored weight is canonical kilograms and every length canonical centimetres, so switching units converts what you see (60 kg reads as 132.3 lb, an 86.5 cm waist as 34.1 in) and never rewrites what is stored. Body measurements, the CSV export, PR cards, trends and analytics all follow the same preference
- Time format (12-hour or 24-hour; defaults to 24-hour)
- First day of week (Sunday or Monday; defaults to Monday)
- Show program schedule toggle (adds scheduled days to the calendar and workout screen)
- Configurable rest timer. It renders as a compact ~146px circular dial floating above the bottom nav: countdown and "Next set in" / "Next exercise in" centred, with **+30s** and **Skip** side by side INSIDE the circle. Only those two buttons take pointer events - the ring, the glow and the disc are passive, so the dial never intercepts a tap meant for the workout controls it floats over
- Separate sound and vibration toggles, plus the seconds-left thresholds for the first warning sound and the countdown
- Plate calculator configuration, kept as INDEPENDENT per-unit equipment profiles: a kg rack and an lb rack are different physical objects, so each unit has its own bar weight, plate list and per-exercise bar overrides, and switching the display unit swaps profiles rather than reinterpreting one as the other. The kg stack defaults to 25, 20, 15, 10, 5, 2.5, 1.25 and the lb stack to 45, 35, 25, 10, 5, 2.5, each with a live preview
- Per-exercise bar/base weight: bar-based exercises show the bar their plate hints are solved against and let you override it (an EZ or trap bar is not the olympic bar), with one tap to return to the profile default
- Changed defaults reach existing installs once, through a versioned upgrade that leaves a customised plate stack alone and never overrides a setting you have since chosen yourself
- Warm-up ramp configuration (enable toggle, kg and lb thresholds, and the three ramp rows' percentages and reps; saved as you change them)
- Post-workout metrics (heart rate, calories)
- Dark theme optimized for gym use with improved text contrast
- Custom styled confirmation modals throughout app
- Data import in two explicit modes: **Merge** (the default - adds what is in the file and keeps everything you already have) and **Replace** (restores a full backup; says plainly that anything not in the file is deleted, asks for a stronger confirmation, and downloads a rollback file first). Export is JSON, plus a per-set CSV for spreadsheets
- Cloud sync via Firebase with SSO authentication
- Destructive actions, each behind a confirmation modal: "Clear All Data" (wipes every local program, workout, achievement, custom exercise, and setting) and "Delete cloud data" (removes the synced copy)

## Architecture

### File Structure

```
gym-tracker/
├── index.html                  # Main app entry point
├── manifest.webmanifest        # PWA manifest
├── sw.js                       # Service worker (offline support + update freshness)
├── offline/index.html          # Offline fallback page for uncached navigations
├── package.json                # npm test script + metadata
├── sitemap-exercises.xml       # Generated sitemap for the exercise directory pages
├── css/
│   ├── gym-tracker.css         # Main dark theme styles
│   ├── exercise-page.css       # Public exercise-directory page styles
│   └── refresh.css             # Shared refresh/polish styles
├── js/
│   ├── app.js                  # Main application controller
│   ├── models/                 # Program, WorkoutDay, WorkoutSession, WorkoutExercise,
│   │                           #   Set, Achievement, Measurement, Settings
│   ├── services/               # Storage, Timer, Analytics, Achievement
│   ├── utils/                  # plate-calculator, program-schedule, pr-session, rest-cues,
│   │                           #   session-merge, import-sanitize, paginator, event-bus,
│   │                           #   dark-select, helpers, active-workout (recovery + tab lock),
│   │                           #   analytics (bridge to the site-wide GA4 helper — distinct
│   │                           #   from services/Analytics, which computes workout stats), ...
│   └── views/                  # home, programs, workout, history, exercises, calendar,
│                               #   achievements, insights, measurements, settings, paused-banner
├── data/
│   ├── exercises-db.js         # 500+ exercise database (JS module)
│   └── exercises-db.json       # Same data as JSON (for the page generator)
├── exercises/                  # Generated static exercise-directory pages (gitignored)
├── scripts/                    # Static-page + sitemap generators (build-exercise-pages.cjs, ...)
├── e2e/                        # Browser regression suites driven over CDP
└── tests/                      # node:test unit suites
```

### Indexability of the generated pages

`npm run build:gym-tracker:pages` writes three kinds of page, and they are
treated differently on purpose:

| Pages | Count | Robots | In `sitemap-exercises.xml` |
|---|---:|---|---|
| Individual exercises | 514 | `noindex, follow` | no |
| Muscle + equipment taxonomy | 51 | `index, follow` | yes |
| `/exercises/` directory index | 1 | `index, follow` | yes |

The individual pages are templated, roughly 2,500 characters each, and compete
against sites with real editorial depth on the same query. They are the same
thin-pages-at-scale shape that put ~60k Rising Shows pages into Google's
"Crawled - currently not indexed" bucket and dragged the whole domain, which is
why that long tail carries the same directive (see
`apps/rising-shows/scripts/render-show-page.js`).

The `follow` half matters: these pages link to the app, the taxonomy pages and
the index, all of which stay indexable, so their internal link equity keeps
flowing to pages that can realistically rank. They are also kept OUT of the
sitemap, because a sitemap is a request to index and listing a page you have
told the crawler to skip is a contradiction that wastes crawl budget. That took
the exercise sitemap from 565 URLs to 52.

The taxonomy and index pages are deliberately exempt: they are list/hub pages
that aggregate content, the same role the Rising Shows shape hubs play. The
split is pinned by tests in `tests/build-exercise-pages.test.cjs`, because the
robots directive and the sitemap live in different files and could otherwise
drift apart silently.

### Units: one canonical form, converted at the edges

Every stored weight is in **kilograms**, every stored length in
**centimetres**, every duration in **seconds**. `settings.weightUnit` is a
DISPLAY and ENTRY preference only, and conversion happens at exactly two
boundaries: reading a value out of an input, and writing one into the DOM.
`js/utils/units.js` owns both, and the input side is deliberately EXACT (no
rounding) so 135 lb → kg → lb comes back as 135 rather than 134.9.

Everything in between - volume sums, PR comparisons, progression, achievement
thresholds, the lift milestones - is plain kilogram arithmetic that needs no
unit awareness at all. Two consequences worth knowing:

- Switching kg ↔ lb never writes to storage. It cannot drift, and it cannot
  corrupt history, because it changes nothing but what is rendered.
- The one place a unit IS part of the data is the plate/bar configuration: a
  kg rack and an lb rack are different physical objects, so
  `settings.plateProfiles` keeps an independent profile per unit.

Data written before this model existed is converted once, on first boot after
the upgrade, by `js/utils/data-migrations.js` (see FINDINGS for what that
migration does and does not touch).

### Data Models

#### Program
- Workout program with exercises
- Contains a list of exercises, each with a `sets[]` array of
  `{ repsMin, repsMax, targetSeconds }`. `targetSeconds` is the planned hold
  for a DURATION exercise and is null on a reps exercise; the editor and the
  workout header render whichever one the catalog says applies
- Supports exercise reordering

#### WorkoutDay
- Template for a day's workout
- Contains list of exercises with target sets/reps
- Part of a Program

#### WorkoutSession
- Actual workout execution record
- Contains WorkoutExercise objects with completed sets
- Tracks duration, weight-volume (`totalVolume`, kg·reps), time under tension
  (`totalTimedSeconds`), and post-workout metrics
- `performedExerciseCount` counts exercises with at least one completed set;
  the raw `exercises` array lists every PLANNED exercise, including ones that
  were never touched
- `sessionUnit` records the unit the lifter was ENTERING in, as metadata. It
  is not a hint about what the stored numbers mean: those are always kilograms

#### WorkoutExercise
- Exercise within a workout session
- Contains array of Set objects
- Tracks completion status

#### Set
- Single set of an exercise
- Records weight (canonical KILOGRAMS), reps, and completion status
- Also records `duration` in seconds for time-based exercises
- `volume` is weight × reps, and is ZERO for a timed set. Seconds are a
  different physical quantity and are reported separately by `timedSeconds`;
  adding them to a kilogram total is what once made a 60-second plank read as
  "60 kg" on six surfaces and in the CSV export

#### Achievement
- Unlockable objectives
- Types: daily, weekly, monthly, global
- Tracks progress and unlock status

### Services

#### StorageService
- Manages localStorage and Firebase sync
- CRUD operations for all data types
- Import/export functionality
- Backup/restore capabilities

#### TimerService
- Workout duration tracking
- Rest timer between sets
- Background timer support

#### AnalyticsService
- Calculates statistics and trends
- Personal records tracking
- Exercise progression analysis
- Volume calculations

#### AchievementService
- Achievement definition and tracking
- Progress calculation
- Unlock detection

## Mobile-First Design

The app is optimized for mobile use during workouts:

### Mobile Features
- Large touch targets: every control in the live workout is at least 44px tall and at least 36px wide, most of them 44×44. Where a visible control is compact (the weight/reps steppers, the header icon buttons) the TAP AREA is grown past it with a transparent expander, so the box you can hit is the large one. The steppers cannot also be 44px wide on a phone - four of them plus two readable number fields do not fit one line at 390px while the row still holds "102.5" - so below 360px the reps field takes its own line and they reach a full 44×44 there
- Bottom navigation for one-handed use
- Quick data entry (weight/reps only)
- Previous workout data visible during entry
- Minimal scrolling required
- Rest timer cues via audio pings and vibration (no push notifications)

### Desktop Features
- Side navigation for easy access
- Comprehensive analytics dashboard
- Program builder with drag-drop reordering
- Multi-column layouts
- Detailed history views
- Advanced filtering and sorting

## Dark Theme

Designed for gym environments with low lighting:
- Deep dark backgrounds (#0a0c14)
- High contrast text in the Inter typeface
- Azure-blue accent colors (#5b9bff / #2563eb), with emerald reserved for success/PR cues
- Reduced eye strain
- OLED-friendly (true blacks)

## Data Persistence

### Local Storage
- Primary data store for instant access
- Works offline
- Syncs automatically when online
- `gymTrackerActiveWorkout` holds the in-progress workout and is rewritten on
  every meaningful change, synchronously (see `persistActiveWorkout` in
  `js/views/workout-view.js`). Only the per-keystroke notes field is
  debounced, and every lifecycle exit flushes it. It also carries `restState`
  ({ endsAt, exerciseIndex, restType }), so resuming after a reload restores
  the running rest countdown instead of dropping it
- `gymTrackerActiveWorkoutLock` ({ tabId, at }) records which tab is driving
  the live workout, refreshed on a 5 s heartbeat and released on pause,
  finish and discard. A second tab with a fresh foreign lock is told the
  workout is running elsewhere instead of being offered Resume, and a stale
  tab's Finish checks storage by session id before writing, so it can no
  longer overwrite a session another tab already saved. The lock is
  local-only coordination state and is never synced
- Other tabs' writes are picked up live: `sync-system/tab-sync.js` watches the
  program, session, settings, achievement, custom-exercise and measurement
  keys and re-reads them into memory (never writes from the handler), so a
  program added or deleted in one tab is not resurrected by the next write
  from another
- `gymTrackerDataVersion` records which stored-data migrations have run
- Every session and measurement carries `unitsCanonical: true`, the per-record
  proof that its numbers are canonical kg/cm. No migration or repair pass ever
  touches a stamped record, which is what makes the unit reconciler safe to run
  on every boot and after every remote sync. A version marker alone was not
  enough: sync writes straight into `localStorage` after `init()` has already
  migrated, so pre-canonical numbers could arrive behind an "already migrated"
  flag and be read as kilograms. See "Unit provenance" in `FINDINGS.md`
- `gymTrackerMeasurementUnits` records the user's answer to the one-time
  "which units were your existing measurements entered in?" question (synced,
  so a second device never re-asks); `gymTrackerMeasurementsBackup` is the
  local-only rollback copy taken immediately before that answer is applied.
  Measurements carry no evidence of their original units, so the app asks
  rather than inferring from whether a value "looks like" inches or centimetres
- **Settings → Data → Re-check stored units** rescans every unit-bearing
  record on demand, repairs only what can be proven legacy, reports anything
  ambiguous, and changes nothing on a healthy profile however often it is run
  or whichever display unit is selected

### Firebase Integration
- Real-time database sync
- User authentication
- Cross-device synchronization
- Automatic conflict resolution
- Sync status UI: on phones a banner pinned directly below the site header while offline (and briefly on the offline → synced transition), dismissible with its close button and stacked under the header so the logo, Menu and Sign In stay clickable; on desktop a state pill in the side-nav footer instead; plus a sync dot on the "More" nav item

### Export/Import
- JSON format
- Complete data backup
- Transfer between devices
- Every import and restore passes through one field-level sanitiser
  (`js/utils/import-sanitize.js`) before anything is persisted: settings whose
  value is outside its vocabulary are dropped (`weightUnit: "stone"`,
  `timeFormat: 13`), dates are normalised to `YYYY-MM-DD` (or the record is
  skipped), set weight/reps/duration are clamped to finite, non-negative,
  physically possible numbers, and records with a missing or unusable id
  (including `__proto__`) get a fresh one. Whatever it repaired is disclosed
  in a toast rather than applied silently; a legitimate older export passes
  through untouched
- Import has two explicit modes. **Merge** (the default) unions the file into
  your data by record id (`sameId`, so a string id from an export matches the
  numeric one it came from), keeps everything the file does not mention, and
  never lets an empty array in the file empty a populated store. Collisions
  resolve deterministically: newer `updatedAt` / `timestamp` / `createdAt`
  wins, an unlocked achievement always beats a locked one, and settings merge
  key by key. **Replace** restores a full backup, says plainly that anything
  not in the file is deleted, and downloads a rollback file first
- Export downloads a dated JSON file (`gym-tracker-data-YYYY-MM-DD.json`); import reads a JSON file you pick and asks whether to merge it with your data or replace everything (a Replace downloads `gym-tracker-rollback-<timestamp>.json` first)
- CSV export: one row per completed set (date, program, exercise, set number, weight, reps, duration, volume, unit) as `gym-tracker-sets-YYYY-MM-DD.csv`, RFC-4180 escaped; exporting with no workouts shows a toast instead of an empty file

## User Workflow

### Desktop/Mobile (Program Creation)
1. Create program with exercises
2. Add exercises from 500+ exercise database or create custom
3. Reorder exercises as needed
4. Set target sets/reps for each exercise
5. Sync to Firebase or export JSON

### Mobile (Workout Execution)
1. Open app → Select program to start workout
2. For each exercise:
   - View all previous sets from last workout
   - Weight and reps inputs pre-filled from last time
   - Enter weight and reps for current set
   - Add sets as completed
3. Finish workout (validates at least one completed set)
4. Add post-workout metrics (optional - heart rate, calories)
5. View progress and unlocked achievements

### Analysis (Desktop or Mobile)
1. View calendar with workout history
2. Check analytics dashboard
3. Review exercise progression
4. Track achievements
5. Export data for backup

## Exercise Database

500+ exercises across categories:
- **Chest**: Barbell, dumbbell, machine, cable, and bodyweight variations
- **Back**: Pull-ups, rows, deadlifts, machine, and cable exercises
- **Shoulders**: Pressing, raises, machine, and cable variations
- **Quads**: Squats, leg press, extensions, and machine exercises
- **Hamstrings**: Romanian deadlifts, leg curls, glute work
- **Calves**: Raises, machine variations, and tibialis exercises
- **Biceps**: Curls, cable, machine, and barbell variations
- **Triceps**: Extensions, dips, pushdowns, and overhead variations
- **Core**: Crunches, planks, and ab machine exercises
- **Full Body**: Compound movements and functional exercises

Each exercise includes:
- Stable numeric `id` - the identity everything joins on (history, PRs,
  progression, program rows). Ids are literals in `data/exercises-db.json`,
  never derived from array position, and are never reused or renumbered.
- Name - a display property. Programs and sessions store a name snapshot, but
  every surface resolves the current catalog name by id at render time
  (`app.getExerciseDisplayName`), so renaming an exercise in the catalog
  retroactively updates old programs, history, achievements and exports
  without touching stored user data. See `FINDINGS.md` for the rename
  checklist.
- Category (muscle group based)
- Primary muscle group
- Secondary muscles
- Equipment required
- Exercise type (`reps` or `duration`); `duration` exercises are logged as min:sec durations instead of weight and reps

### Custom Exercises
Users can create custom exercises with:
- Custom name
- Category selection
- Muscle group selection
- Equipment specification
- Full integration with workout tracking and history

## Achievements System

### Daily Achievements
- Complete a workout today
- Reach volume milestones

### Weekly Achievements
- Workout frequency goals (3, 4, 5, 6 workouts in the configured week)
- Consistency: "Perfect Week" counts DISTINCT TRAINING DAYS, not sessions, because that is what its description promises

### Monthly Achievements
- Total workouts per month
- Volume milestones

### Lifetime Achievements
- Total workout count milestones
- Exercise variety goals
- Workout streaks
- Personal records

### Strength PRs
- Per-exercise personal-record achievements, awarded when a finished session's top set beats your all-time best for that exercise (requires 2+ prior sessions with that exercise; reps-based exercises only)
- Shown in a dedicated "Strength PRs" section on the Achievements screen with the exercise name, PR weight, and date

## Browser Compatibility

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- PWA support (installable)
- Offline functionality

## Future Enhancements

- [ ] Workout templates/presets
- [ ] Exercise form videos/GIFs
- [ ] Social features (share workouts)
- [x] Advanced analytics (Insights charts, per-exercise strength-trend charts, measurement sparklines)
- [ ] Workout notes with voice input
- [ ] Integration with fitness trackers
- [ ] Nutrition logging
- [ ] Workout reminders/notifications

## Development

### Prerequisites
- Node.js (for development server)
- Firebase account (for cloud sync)
- Modern web browser

### Setup
1. Clone repository
2. Configure Firebase credentials
3. Open `index.html` in browser or serve with local server
4. Create account and start tracking!

### Testing

Unit suites live in `tests/` and run with `node --test apps/gym-tracker/tests/`
from the repo root (they are part of the root `npm test`). No browser, no
build step; `todo` entries in the output are known product defects pinned to
their CORRECT behavior (see `FINDINGS.md`), not failures.

Five loading patterns are in use; pick the first that fits:

1. **Direct import** for pure modules (models, utils, `TimerService`,
   `AnalyticsService` statics).
2. **Global stubs then `await import()`** when a module reads globals at call
   time (`StorageService` + a `localStorage` stub, the analytics bridge + a
   `window` stub).
3. **Source extraction** for DOM-bound view methods and module-private
   functions: `tests/helpers/source-extract.mjs` lifts the real method or
   function text out of the source file and evaluates it against stubs
   (`buildMethods` / `buildFunctions`). Never hand-copy ("mirror") view logic
   into a test; mirrors drift silently and one already had (see FINDINGS).
4. **Static asset text assertions** for structural invariants
   (`modal-dom-order`, `sw-precache-completeness`).
5. **`node:vm` harnesses** for classic scripts like `sw.js`
   (`sw-offline-behavior`, plus the cross-app activate pins in
   `apps/trip-planner/tests/sw-activate.test.mjs`).

Browser regressions that no node layer can reach live in
`e2e/audit-2026-08.mjs` (registered in `tests/browser/run.mjs`, run with
`npm run test:browser`): live set-row validation, measurement ranges and the
double-submit guard, tablet geometry at 768/820, seeded axe scans of
Exercises / History / the finish modal / Measurements at 1280 and 390, the
rest dial versus the current exercise's "Add set" at 390, two-tab coherence
and the active-workout lock, and a service-worker deploy simulation that
serves the real `netlify.toml` cache headers through a local proxy.

Timer tests use `node:test` mock timers; timezone-sensitive helpers are tested
in child processes with `TZ=America/New_York` (`date-timezone.test.mjs`).

Manual/device checks that node cannot reach (touch, keyboards, real offline,
Firebase sync) live in the `.features/` human test plan.

## Credits

Built with:
- Vanilla JavaScript (ES6 modules)
- CSS3 (Grid, Flexbox)
- Firebase (Authentication, Realtime Database)
- Font Awesome (Icons)

## License

Copyright © 2024 Shevato LLC
