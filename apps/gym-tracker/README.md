# Gym Tracker App

A comprehensive, mobile-first workout tracking application built with vanilla JavaScript, featuring program creation, workout execution, analytics, and achievements.

## Features

### 🏋️ Core Functionality

- **Program Builder**: Create workout programs with custom exercises and reorderable exercise lists; each set row has a labeled toggle for a single rep target or a rep range (e.g. set 1: 11-12, set 2: 8-10); a program-level rest mode (one uniform between-exercises duration set with an M:SS stepper, or custom per-exercise rest); the exercise picker opens as a child modal ON TOP of the editor (the plan being edited stays open and untouched underneath: committing returns the picks to it, cancelling the picker returns to it with all unsaved edits intact, and closing the editor by any route also closes the picker); removing an exercise asks for confirmation
- **Program List Sorting**: Sort the program cards by name or exercise count, or keep a custom order created by dragging cards around; the chosen sort and the custom order both persist (dragging a card switches the list to custom automatically)
- **Supersets**: Link consecutive exercises into a superset so they are grouped together in both the program builder and the workout view
- **Workout Execution**: Mobile-optimized interface for tracking sets, reps, and weight during workouts; per-set rep range labels (shown once per exercise when all sets match); rest is shown by a compact floating circular timer dial, color-coded (green between sets, blue between exercises), with the countdown centered and +30s / Skip controls inside it, and for uniform programs the between-exercise rest also shows in the sticky workout header; after-exercise rest is read-only during a workout (it is set in the program); a pencil button on each exercise opens an inline notes field saved as you type, and a "same as last time" chip restores the previous session's weight and reps on a row; weight and reps are each a single control with the number as the focus and flat -/+ inside it, under WEIGHT / REPS column captions so it is obvious which side is which; tapping the exercise name or its metadata line collapses and expands the card, the same as the chevron; auto-collapsing completed exercises carry a green success tint (stronger while collapsed) and re-collapse after un-marking, staying collapsed across a pause/resume (the edit and plate-hint buttons hide while a card is collapsed); an identical plate breakdown is shown once per run of sets at the same weight rather than under every set; a final-5-seconds red pulse countdown with audio pings and haptics; the finish summary shows total volume with a percentage delta versus your previous session of the same program; and a plate calculator for all plate-loaded equipment (barbell, trap-bar, and plate-loaded machines such as the leg press) with per-exercise and global toggles whose state persists once a workout is saved
- **Timed Exercises**: Exercises marked as duration-based in the database are logged with min:sec inputs instead of weight and reps, and their volume counts the seconds held; rep ranges, plate hints, feel marking, and Strength PRs are skipped for them
- **"How did it feel"**: When every target set of a reps-based exercise reaches the top of its rep range, a feel picker appears once for that exercise; the chosen mark shows as a smiley on the exercise header (tap to remove it) and the most recent marking from previous sessions shows next to the exercise name as progression context
- **Workout Notes**: A free-text note captured in the finish-workout dialog, shown on the history card and in the session detail view
- **Exercise Database**: 500+ exercises categorized by muscle group and equipment, with persistent sorting (name, most recently used, most logged), numbered pagination, and the ability to remove a specific exercise's logged history
- **Back to top**: A floating button appears on long pages and tall modals, and on the public exercise directory pages, to jump back to the top
- **Custom Exercises**: Create and manage your own custom exercises
- **Workout History**: Complete history of all workouts with detailed stats, numbered pagination, and clickable workout details; each exercise in the session detail shows a small inline strength-trend chart of its top-set weight over recent sessions, plus any per-exercise notes you logged
- **Progress Tracking**: View previous workout data (all sets) during current workout for progression
- **Progression Suggestions**: Each set is judged against its own rep range, giving three outcomes. Land **below** the bottom of a set's range and that set gets a compact amber "Repeat weight" warning (the full reasoning, with the reps you got and the target, is in its tooltip); the warning is per set, so missing set 2 never flags sets 1 or 3, and two short sets get two warnings. Land **inside** the range and nothing is shown - the weight simply holds, because finishing 7 of a 7-8 target is a good working set, not a failure. Reach the **top** of every set's range twice in a row at the same weight and the next workout pre-fills a bumped weight (equipment-appropriate increment) with a "+X suggested" badge on the first planned row; tapping it reveals the two sessions behind the call and a "Use last weight" control. Two consecutive sessions that fall *under* the range at the same weight suggest a 5-10% deload instead, and that badge supersedes the per-set warnings
- **Weight/Rep Steppers**: One-tap minus/plus buttons flank every planned row's weight and reps inputs; weight steps by the exercise's increment, reps by 1 (floored at 0), without raising the phone keyboard, and plate hints plus the "same as last time" chip stay live
- **In-Workout Exercise Swap**: A swap button on each exercise header substitutes a different exercise for THIS session only (searchable picker pre-filtered to the same category); the saved program is never touched, swapping with logged sets asks for confirmation, and the substitute's sets count toward its own history and PRs
- **Warm-Up Ramp**: Barbell and trap-bar exercises whose working weight meets a configurable threshold show a collapsed warm-up strip above set 1 (empty bar, then percentage steps rounded to loadable plates) with one-tap ticks; warm-ups never count toward set completion, volume, or PRs
- **Body Measurements**: A dedicated Measurements view (its own nav entry) to log body measurements over time via an add-measurement modal, with a trends grid showing one tile per tracked metric (latest value, 30-day delta, and an inline sparkline) above the editable history list; included in the welcome tour
- **Measurement Goals**: Each trend tile takes an optional target value and direction (increase or decrease); a tile with a goal shows a progress bar and "N% to goal" under its sparkline, measured from the earliest logged value, and clearing the goal removes the bar without touching history
- **Calendar View**: Visual representation of workout days with progress indicators (first day of week is configurable, Sunday or Monday)
- **Program Scheduling**: Assign weekdays to a program; the days show on the program tiles, as markers on the calendar, and as a compact day-pill week strip at the top of the workout screen where tapping a day shows that day's scheduled workout below the pills and highlights the matching program card
- **Welcome Tour**: A single scrollable onboarding modal that explains the core features, with quick links into Programs, Workout, Calendar, and Settings; replayable any time from Settings
- **Quick Start**: A floating "Start workout" button on desktop (visible across views; hidden on the active-workout screen) that starts or resumes a workout from anywhere
- **Achievements**: Unlock achievements for reaching milestones (daily, weekly, monthly, lifetime), plus per-exercise personal-record achievements shown in a dedicated "Strength PRs" section when you beat your all-time best on an exercise

### 📊 Analytics & Stats

- Weekly workout tracking (respects the configured first day of week)
- Exercise frequency analysis
- Personal records tracking (max weight, reps, volume per exercise)
- Workout history with filtering and sorting, including a program filter (All Programs plus each saved program) that combines with the sort and date-range controls
- Clickable workout cards for detailed views
- Exercise history with best set tracking
- Insights view: a 4-week volume-by-muscle-group breakdown, a "Not trained recently" list (muscle groups in your programs with no volume for 14 days, never-trained first), and a 12-month consistency heatmap

### ⚙️ Settings & Customization

- Weight unit selection (kg/lb)
- Time format (12-hour or 24-hour; defaults to 24-hour)
- First day of week (Sunday or Monday; defaults to Monday)
- Show program schedule toggle (adds scheduled days to the calendar and workout screen)
- Configurable rest timer
- Separate sound and vibration toggles, plus the seconds-left thresholds for the first warning sound and the countdown
- Plate calculator configuration (bar weight and the comma-separated list of available plate sizes, with a live preview; the kg stack defaults to 45, 35, 25, 20, 15, 10, 5, 2.5, 1.25)
- Changed defaults reach existing installs once, through a versioned upgrade that leaves a customised plate stack alone and never overrides a setting you have since chosen yourself
- Warm-up ramp configuration (enable toggle, kg and lb thresholds, and the three ramp rows' percentages and reps; saved as you change them)
- Post-workout metrics (heart rate, calories)
- Dark theme optimized for gym use with improved text contrast
- Custom styled confirmation modals throughout app
- Data export/import (JSON), plus a per-set CSV export for spreadsheets
- Cloud sync via Firebase with SSO authentication
- Destructive actions, each behind a confirmation modal: "Clear All Data" (wipes every local program, workout, achievement, custom exercise, and setting) and "Delete cloud data" (removes the synced copy)

## Architecture

### File Structure

```
gym-tracker/
├── index.html                  # Main app entry point
├── manifest.webmanifest        # PWA manifest
├── sw.js                       # Service worker (offline support)
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
│   │                           #   session-merge, paginator, event-bus, dark-select, helpers,
│   │                           #   analytics (bridge to the site-wide GA4 helper — distinct
│   │                           #   from services/Analytics, which computes workout stats), ...
│   └── views/                  # home, programs, workout, history, exercises, calendar,
│                               #   achievements, insights, measurements, settings, paused-banner
├── data/
│   ├── exercises-db.js         # 500+ exercise database (JS module)
│   └── exercises-db.json       # Same data as JSON (for the page generator)
├── exercises/                  # Generated static exercise-directory pages (gitignored)
├── scripts/                    # Static-page + sitemap generators (build-exercise-pages.cjs, ...)
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

### Data Models

#### Program
- Workout program with exercises
- Contains list of exercises with target sets/reps
- Supports exercise reordering

#### WorkoutDay
- Template for a day's workout
- Contains list of exercises with target sets/reps
- Part of a Program

#### WorkoutSession
- Actual workout execution record
- Contains WorkoutExercise objects with completed sets
- Tracks duration, volume, and post-workout metrics

#### WorkoutExercise
- Exercise within a workout session
- Contains array of Set objects
- Tracks completion status

#### Set
- Single set of an exercise
- Records weight, reps, and completion status
- Also records `duration` in seconds for time-based exercises
- Calculates volume (weight × reps, or the duration itself for time-based sets)

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
- Large touch targets (44×44px minimum)
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

### Firebase Integration
- Real-time database sync
- User authentication
- Cross-device synchronization
- Automatic conflict resolution
- Sync status UI: a banner at the top of the app while offline (and briefly on the offline → synced transition), plus a sync dot on the "More" nav item

### Export/Import
- JSON format
- Complete data backup
- Transfer between devices
- Export downloads a dated JSON file (`gym-tracker-data-YYYY-MM-DD.json`); import reads a JSON file you pick
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
- Workout frequency goals
- Consistency tracking

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
- [ ] Progressive overload suggestions
- [ ] Deload week tracking
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
