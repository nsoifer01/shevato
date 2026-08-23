# 🏁 Mario Kart Race Tracker

A comprehensive web application for tracking Mario Kart race results, analyzing performance statistics, and competing for achievements with friends.

## 🎮 Overview

Mario Kart Race Tracker is a feature-rich web application that allows you to:
- Record race results for 1-4 players
- Track detailed statistics and performance metrics
- Compete for achievements and milestones
- Analyze head-to-head matchups
- View trends and patterns over time
- Export/import data for backup and sharing

## 🚀 Features

### Core Functionality
- **Game Version Switcher**: Toggle the whole app between Mario Kart 8 Deluxe (1-12) and Mario Kart World (1-24) from the buttons under the page title. Each game keeps a fully independent dataset (its own races, stats, achievements, player names, icons, player count, recent searches, and favorites) under separate localStorage namespaces (`marioKart*` vs `marioKartWorld*`); the first time MK World is opened it shows the MK8D player settings until you change them there
- **Race Recording**: Quick and easy race result entry with multiple input methods
- **Course Selection**: Tag each race with the course/map you played on, via a searchable picker (an inline dropdown on mobile, a command-palette overlay on desktop) with favorites, recent searches, and game-version / new-course filters. Course data is data-driven and easy to update (see "Updating Course Data" below)
- **Player Management**: Customizable player names (up to 40 characters) and emoji/icons, per game version
- **Date Filtering**: View stats for specific time periods; "Last 7 Days" and "Last 30 Days" are local calendar windows (today plus the previous 6 or 29 days)
- **Undo/Redo**: Covers adding, editing, deleting and Clear All (a clear is undone from a snapshot). Import, Restore and a game-version switch start a fresh history
- **Data Persistence**: Automatic saving to browser localStorage, with account sync across devices when signed in
- **Export/Import**: JSON file support for data backup and transfer. Every import and restore runs through one validator: unambiguous repairs (legacy player keys, `24:MM` stamps, empty entries, unreadable times/course tags) are applied and listed in the toast; a bad date or a non-integer, out-of-range or duplicate position rejects the file with a message naming the race
- **Restore**: One-click recovery from the rolling auto-backup snapshot (taken every 10 minutes, and refreshed right before a Clear All)
- **Edit Races**: Every race in the history (table row or mobile card) has an edit button that opens the race in a modal to correct positions, date, and time
- **Safe Deletes**: Deleting a race asks for confirmation first; undo/redo still covers every action
- **Clear All Data**: The 🗑️ button in the sidebar header wipes the races and stats for the current game behind a "Delete Everything" confirmation modal (disabled when there is nothing to clear). Player names and icons stay; Undo brings the races straight back, and Restore brings them back later from the auto-backup taken just before the clear
- **Sortable History**: Newest race first by default; sort by date or by any player's finishing position (first click ascending, the arrow and `aria-sort` say which)
- **Multi-tab safe**: Two tabs on the same browser re-read each other's writes (`sync-system/tab-sync.js`), so races added or deleted in one tab show up in the other instead of being overwritten
- **Stored XSS hardened**: Every renderer escapes player names, symbols, timestamps, dates and course names; imported strings are validated and capped
- **Sync Status**: An offline banner appears at the top of the page when the connection drops, and the sidebar footer shows a live sync-status pill

### Statistics & Analytics
- **Comprehensive Stats**: Win rates, average positions, streaks, and more
- **Achievement System**: 5 achievement categories with progress tracking; records show the live active streak count alongside the best, e.g. "10 (3)"
- **Head-to-Head Analysis**: Detailed matchup statistics between players, including when each longest win streak ended (or that it is still active)
- **Performance Trends**: Visual charts showing improvement over time
- **Activity Heatmaps**: Calendar view of racing activity and performance
- **Position Analysis**: Heat maps and sweet spot visualizations

### User Interface
- **Theme**: Single cohesive dark theme
- **Responsive Design**: Works on desktop, tablet, and mobile devices
- **Modern UI**: Card-based layouts with smooth animations
- **Multiple Views**: 8 tabs - six statistics/analysis views plus Help and Guide. With no races yet, Help and every empty panel show an "Add your first race" button that opens the sidebar form
- **Accessible dialogs**: Edit, delete, clear and restore modals use `role="dialog"`, trap Tab, open on a sensible control and return focus to the button that opened them; the tab strip handles Left/Right/Home/End

## 📱 Browser Compatibility

The tracker works best on modern browsers:
- Chrome (recommended)
- Firefox
- Safari
- Edge

## ⚠️ Important Notes

### Mobile Support
- Fully responsive: desktop table views switch to card layouts on smaller screens
- Charts (Trends, Activity) render at all screen sizes
- Touch targets: sidebar close/trash and pagination buttons are 40px; the course clear buttons inside the 40px-tall course field are 28-32px
- H2H renders as stacked per-player cards on phones (no sideways scrolling); the sidebar toggle slides away while scrolling down so it never covers content

### Player System
- Players are tracked by their slot position (Player 1, 2, 3, 4)
- Changing a player's name doesn't affect their historical data
- Statistics are tied to the player slot, not the name
- This design choice simplifies data management but may be improved in future versions

### Data Storage
- All data is stored locally in your browser's localStorage
- Data persists between sessions on the same device/browser
- Clearing browser data will delete all local race history
- Sign in to sync your data to your account across devices
- A rolling auto-backup snapshot is taken every 10 minutes (recoverable via Restore)
- Regular backups via Export are still recommended

### Optimal Configuration
- **Players**: Supports 1-4 players; layouts verified at all player counts
- **Browser**: Chrome or Firefox on desktop for best experience

### Race timestamps
Each race stores a `date` (YYYY-MM-DD, validated as a real calendar day on import/restore) plus an optional `timestamp`
("HH:MM:SS TZ", hand-formatted on the 00-23 clock; an older formatter wrote
midnight as "24:MM:SS", which some engines refuse to parse). Everything that
orders races chronologically (streaks, trends, achievements, the sortable
history table) goes through one tolerant parser in `js/utils.js`
(`raceDateTimeValue` / `compareRacesChronologically`): it reads the wall-clock
part, ignores the timezone abbreviation, maps a legacy hour of 24 to 00, and
falls back to midnight of the date when the timestamp is absent or
unparseable, so a bad stamp can never silently disable the sort. On load and
on import, `migrateRaceData` also rewrites any stored "24:MM:SS" stamp to
"00:MM:SS" (preserving every other field on the race, course tags included),
so old data heals forward.

### Player count vs the race log
The player-count selector sets how wide the race-entry form is: how many
people are playing now. It is stored under its own key per game version
(`marioKartPlayerCount` / `marioKartWorldPlayerCount`), separate from the
race log (`marioKartRaces`), and cross-device sync carries the two
independently, so they can disagree without anyone touching the app.

Because of that, the history table, the per-player cards and every statistic
read from a roster that unions the two: the entry width plus whoever
actually has results in the race log. Narrowing the entry form therefore
stops you entering a fourth score, but never hides a fourth player's
recorded races, and their positions stay editable from the race-edit dialog.
When no count has ever been stored, it is taken from the race log rather
than from the built-in default of 3, so a device that receives the races
without the count key does not silently drop a player.

## 🛠️ Technical Details

### Technologies Used
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Charts**: Chart.js for data visualization
- **Icons**: Font Awesome for UI icons
- **Storage**: Browser localStorage, synced to the account when signed in (Firebase sync system)
- **Backup**: Rolling auto-backup snapshot in localStorage every 10 minutes, plus JSON export/import

### File Structure
```
mario-kart/
├── index.html            # Main application file
├── css/                  # All styling files
│   ├── base.css         # Base styles and resets
│   ├── theme.css        # Theme variables and dark theme
│   ├── charts.css       # Chart and visualization styles
│   └── ...              # Other component-specific styles
├── js/                   # JavaScript modules
│   ├── main.js          # Main application logic
│   ├── dataManager.js   # Data handling and storage
│   ├── statistics.js    # Statistics calculations
│   ├── courseData.js    # Course data source abstraction + ranked search
│   ├── coursePicker.js  # Course picker UI (inline dropdown + desktop palette)
│   ├── gameVersionManager.js # MK8D / MK World switching + storage namespacing
│   └── ...              # Other feature modules
├── data/
│   └── courses.json     # Vendored course/map data (cups, courses, aliases)
├── scripts/
│   └── sync-courses.mjs # Validate / normalize / regenerate courses.json
├── tests/                # node:test suites (run via `npm test` from the repo root)
│   ├── harness.js       # Shared vm harness (not a test file)
│   ├── core.test.js     # Roster, date filters, undo/redo, stats, import, backup
│   ├── audit-2026-08.test.js # Regressions from the 2026-08 audit (clear+undo, XSS, validator, per-version names, sort, integers)
│   ├── dataManager.test.js # addRace / editRace / migrateRaceData
│   ├── statistics.test.js  # calculateStats edge cases + chronological ordering
│   ├── dateFilter.test.js  # Rolling week/month window semantics
│   ├── charts.test.js      # Chart aggregation helpers
│   ├── utils.test.js       # Shared position guard + race-datetime parser
│   └── courses.test.js  # Course dataset integrity + search ranking
├── e2e/
│   └── audit-2026-08.mjs # Browser regressions (run by tests/browser/run.mjs): XSS through the DOM, modal focus, two tabs, phone geometry, seeded axe scans
├── FINDINGS.md           # Engineering knowledge: root causes, decisions, regression risks
└── README.md            # This file
```

## 🧪 Tests

Run from the repo root:

```bash
npm test                 # every app
npm run test:mario-kart  # this app only
npm run test:browser     # browser estate, including apps/mario-kart/e2e/audit-2026-08.mjs
```

### What is covered

- **audit-2026-08.test.js** - the 2026-08 audit regressions through the real functions: clear -> undo -> add -> reload, player-count decrease, escaping in every renderer (H2H tables, history table/cards, headers, stat cards, edit/delete modals), the shared import/restore validator with a real legacy export, widened-roster cells, per-version names/count, default order and sort direction, whole-number positions.
- **core.test.js** - roster union (`rosterForCount`, `highestPlayerWithRaces`), date-filter plumbing, undo/redo including the `MAX_HISTORY` bound, H2H statistics, import validation, and version-scoped backup/restore keys.
- **dataManager.test.js** - `addRace` (min-player rule, position range, duplicate positions, course tagging, timestamp build, localStorage write, undo entry), `editRace` (revalidation, timestamp preserve/rebuild/clear, undo and redo, untouched fields), `migrateRaceData` (legacy `slav`/`mike`/`nikita` keys).
- **statistics.test.js** - `calculateStats` when a player key is absent rather than null (roster widening) and chronological ordering across every timestamp shape, including legacy "24:MM:SS" stamps.
- **utils.test.js** - the shared helpers in `js/utils.js`: `isFinitePosition` (the guard every stat/chart/achievement uses to decide whether a player raced) and `raceDateTimeValue` / `compareRacesChronologically` (the tolerant race-datetime parser behind every chronological sort).
- **dateFilter.test.js** - the week/month filters as local calendar windows (today plus 6 / 29 days), pinned with a frozen clock under `TZ=America/Chicago` so the old UTC-midnight bug cannot hide.
- **charts.test.js** - the pure aggregation helpers in `charts.js`: weekly activity buckets, comeback analysis, best/worst racing day, pattern analysis.
- **courses.test.js** - course dataset integrity and search ranking.

### How the harness works

The app's scripts are classic scripts with globals, not modules, so tests load
them into a `node:vm` context with the runtime globals they expect stubbed
(`window`, `document`, `localStorage`, `players`, `races`). `tests/harness.js`
exports that setup:

- `makeContext(extra)` - fresh context with DOM/localStorage stubs plus any globals a test needs.
- `loadInto(ctx, 'dataManager.js')` - evaluate an app file in that context.
- `freezeDate(iso)` - a `Date` replacement whose `new Date()` always returns the same instant (needed for the rolling filters and race timestamps).
- `evalIn(ctx, expr)` - read a top-level `let`/`const` such as `races` or `MAX_HISTORY`, which `vm` does not mirror onto the context object.

Two recurring traps: assigning `ctx.currentDateFilter` is inert (drive the app's
own setters instead), and values built inside the vm come from the vm's
intrinsics, so compare joined strings or copied values rather than
`assert.deepEqual` against a host array. `MK_JS_DIR=<dir>` points the harness
at another copy of `js/` (used to prove a new regression fails against the
pre-fix sources: `git show HEAD:apps/mario-kart/js/x.js > <dir>/x.js`).

Known product defects are covered by a regression test that asserts the
**correct** behaviour and carries `{ todo: 'KNOWN DEFECT: ...' }`, so the run
stays green while the bug stays documented. Fixing one of those bugs means
deleting its `todo` option, not rewriting the assertions. As of 2026-08-15
this app carries no todos: its four audit defects (missing-player-key stats,
24:MM:SS midnight stamps, chronological-sort no-ops, the lossy migration)
are all fixed and their tests run as plain regressions.

## 🗺️ Updating Course Data

Courses are vendored in `data/courses.json` and read through a swappable source (`js/courseData.js` → `CourseDataConfig`). There is no live API to break, so the list stays stable. Run all commands from the repo root.

### Option A - add or edit a course by hand (most common)

1. Open `apps/mario-kart/data/courses.json`.
2. Pick the game under `games`: `mk8d` (Mario Kart 8 Deluxe) or `mkworld` (Mario Kart World).
3. In that game's `cups` array, find the cup - or add a new one: `{ "id": "leaf", "name": "Leaf Cup", "courses": [] }`.
4. Add the course to that cup's `courses` array:
   ```json
   { "id": "dry-bones-burnout", "name": "Dry Bones Burnout", "origin": "new", "aliases": ["dbb"] }
   ```
   - **id** - unique, kebab-case, stable. Never reuse an id for a different course. A course that appears in two cups must use the **same id and name** in both (that is how variants like Crown City merge into a single entry).
   - **name** - exactly as shown in-game.
   - **origin** - `"new"` if the track debuts in this game, otherwise the source game (e.g. `"Mario Kart 64"`). Drives the "New" filter and the preview's status.
   - **aliases** - optional search shortcuts. Search already handles punctuation and word-initials (so "dk", "mk8", "rr" work without aliases); only add genuinely different spellings.
5. (Optional) update that game's `source.lastSynced` date, and set `source.complete` to `true` once a game is fully entered.
6. **Validate**: `npm run sync:mario-kart-courses -- --check` → must print `Validation passed.`
7. **Test**: `npm test` (dataset-integrity checks live in `tests/courses.test.js`).
8. **Verify in the app**: open Add Race → Course and confirm the course appears and is searchable.

### Option B - regenerate with the sync script

- Validate only (CI-friendly, non-zero exit on error): `npm run sync:mario-kart-courses -- --check`
- Normalize the file and restamp every game's `lastSynced` to today: `node apps/mario-kart/scripts/sync-courses.mjs --write`
- From a remote source (future): implement the mapping in `SOURCES.remote` inside `scripts/sync-courses.mjs`, then `MK_COURSES_URL=<url> node apps/mario-kart/scripts/sync-courses.mjs --source=remote --write`.

### Pointing the app at a different data source

Edit `js/courseData.js` → `CourseDataConfig`. Nothing else (picker, search, recents, favorites) needs to change:

```js
const CourseDataConfig = {
  active: 'static', // 'static' reads the bundled data/courses.json
  sources: {
    static: { type: 'json', url: 'data/courses.json' }
    // remote: { type: 'json', url: 'https://.../courses.json' }  // then set active: 'remote'
  }
};
```

> Note: MK8 Deluxe is currently `source.complete: false` - the 48 Booster Course Pass tracks are not vendored yet. Add them as new cups the same way.

## 🚀 Getting Started

1. **Access the Tracker**: Navigate to `https://www.shevato.com/apps/mario-kart/`
2. **Set Up Players**: Open the sidebar and use "Manage Players" to configure player names and icons
3. **Record a Race**: Click "Add your first race" (or sidebar -> 🏁 Add Race), enter finishing positions and click "🏆 Save"
4. **View Statistics**: Explore different tabs to see various analyses
5. **Backup Your Data**: Use the Export button regularly to save your data

## 💡 Tips & Tricks

- Star your most-played courses, then use the course picker's **Favorites** filter chip (desktop palette) to pull up just those tracks
- Click on achievements to see detailed progress
- Use date filters to analyze specific time periods
- Export your data regularly as backup
- Try different player icons for better visual distinction
- Stay on the keyboard while entering a race: Enter moves to the next position input and submits from the last one, Esc closes the sidebar form or any modal, and ↑/↓ plus Enter pick a course inside the course picker

## 🔮 Future Improvements

Planned enhancements include:
- Player profiles independent of slot positions
- More achievement categories
- Additional chart types
- Custom race configurations
- Tournament mode

## 🤝 Feedback

This is a personal project created to track Mario Kart races with friends. Feedback and suggestions are welcome! The tracker will continue to evolve based on usage patterns and user input.

## 📄 License

This project is for personal use. Feel free to use it for tracking your own Mario Kart races!

---

*Happy Racing! 🏎️*
