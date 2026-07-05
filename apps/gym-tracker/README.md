# Gym Tracker App

A comprehensive, mobile-first workout tracking application built with vanilla JavaScript, featuring program creation, workout execution, analytics, and achievements.

## Features

### 🏋️ Core Functionality

- **Program Builder**: Create workout programs with custom exercises and reorderable exercise lists; each set row has a labeled toggle for a single rep target or a rep range (e.g. set 1: 11-12, set 2: 8-10); a program-level rest mode (one uniform between-exercises duration set with an M:SS stepper, or custom per-exercise rest); the exercise picker adds your picks as simple rows you then refine per set; removing an exercise asks for confirmation
- **Supersets**: Link consecutive exercises into a superset so they are grouped together in both the program builder and the workout view
- **Workout Execution**: Mobile-optimized interface for tracking sets, reps, and weight during workouts; per-set rep range labels (shown once per exercise when all sets match); rest is shown by a compact floating circular timer dial, color-coded (green between sets, blue between exercises), with the countdown centered and +30s / Skip controls inside it, and for uniform programs the between-exercise rest also shows in the sticky workout header; after-exercise rest is read-only during a workout (it is set in the program); a pencil button on each exercise opens an inline notes field saved as you type, and a "same as last time" chip restores the previous session's weight and reps on a row; auto-collapsing completed exercises that re-collapse after un-marking and stay collapsed across a pause/resume (the edit and plate-hint buttons hide while a card is collapsed); a final-5-seconds red pulse countdown with audio pings and haptics; the finish summary shows total volume with a percentage delta versus your previous session of the same program; and a plate calculator for all plate-loaded equipment (barbell, trap-bar, and plate-loaded machines such as the leg press) with per-exercise and global toggles whose state persists once a workout is saved
- **Exercise Database**: 500+ exercises categorized by muscle group and equipment, with persistent sorting (name, most recently used, most logged), numbered pagination, and the ability to remove a specific exercise's logged history
- **Back to top**: A floating button appears on long pages and tall modals, and on the public exercise directory pages, to jump back to the top
- **Custom Exercises**: Create and manage your own custom exercises
- **Workout History**: Complete history of all workouts with detailed stats, numbered pagination, and clickable workout details; each exercise in the session detail shows a small inline strength-trend chart of its top-set weight over recent sessions, plus any per-exercise notes you logged
- **Progress Tracking**: View previous workout data (all sets) during current workout for progression
- **Body Measurements**: A dedicated Measurements view (its own nav entry) to log body measurements over time via an add-measurement modal; included in the welcome tour
- **Calendar View**: Visual representation of workout days with progress indicators (first day of week is configurable, Sunday or Monday)
- **Program Scheduling**: Assign weekdays to a program; the days show on the program tiles, as markers on the calendar, and as a compact day-pill week strip at the top of the workout screen where tapping a day shows that day's scheduled workout below the pills and highlights the matching program card
- **Welcome Tour**: A single scrollable onboarding modal that explains the core features, with quick links into Programs, Workout, Calendar, and Settings; replayable any time from Settings
- **Quick Start**: A floating "Start workout" button on desktop (visible across views; hidden on the active-workout screen) that starts or resumes a workout from anywhere
- **Achievements**: Unlock achievements for reaching milestones (daily, weekly, monthly, lifetime), plus per-exercise personal-record achievements shown in a dedicated "Strength PRs" section when you beat your all-time best on an exercise

### 📊 Analytics & Stats

- Weekly workout tracking (respects the configured first day of week)
- Exercise frequency analysis
- Personal records tracking (max weight, reps, volume per exercise)
- Workout history with filtering and sorting
- Clickable workout cards for detailed views
- Exercise history with best set tracking
- Insights view: a 4-week volume-by-muscle-group breakdown and a 12-month consistency heatmap

### ⚙️ Settings & Customization

- Weight unit selection (kg/lb)
- First day of week (Sunday or Monday)
- Configurable rest timer
- Post-workout metrics (heart rate, calories)
- Dark theme optimized for gym use with improved text contrast
- Custom styled confirmation modals throughout app
- Data export/import (JSON)
- Cloud sync via Firebase with SSO authentication

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
│   │                           #   session-merge, paginator, event-bus, dark-select, helpers, ...
│   └── views/                  # home, programs, workout, history, exercises, calendar,
│                               #   achievements, insights, measurements, settings, paused-banner
├── data/
│   ├── exercises-db.js         # 500+ exercise database (JS module)
│   └── exercises-db.json       # Same data as JSON (for the page generator)
├── exercises/                  # Generated static exercise-directory pages (gitignored)
├── scripts/                    # Static-page + sitemap generators (build-exercise-pages.cjs, ...)
└── tests/                      # node:test unit suites
```

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
- Calculates volume (weight × reps)

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
- Rest timer with notifications

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

### Export/Import
- JSON format
- Complete data backup
- Transfer between devices
- Email or file sharing

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
- Name
- Category (muscle group based)
- Primary muscle group
- Secondary muscles
- Equipment required

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
- [ ] Advanced analytics (charts, graphs)
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
- Test on actual mobile devices for best experience
- Use Chrome DevTools device emulation
- Test offline functionality
- Verify Firebase sync

## Credits

Built with:
- Vanilla JavaScript (ES6 modules)
- CSS3 (Grid, Flexbox)
- Firebase (Authentication, Realtime Database)
- Font Awesome (Icons)

## License

Copyright © 2024 Shevato LLC
