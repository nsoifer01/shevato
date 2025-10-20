# Gym Tracker App

A comprehensive, mobile-first workout tracking application built with vanilla JavaScript, featuring program creation, workout execution, analytics, and achievements.

## Features

### 🏋️ Core Functionality

- **Program Builder**: Create workout programs with custom exercises and reorderable exercise lists
- **Workout Execution**: Mobile-optimized interface for tracking sets, reps, and weight during workouts
- **Exercise Database**: 500+ exercises categorized by muscle group and equipment
- **Custom Exercises**: Create and manage your own custom exercises
- **Workout History**: Complete history of all workouts with detailed stats and clickable workout details
- **Progress Tracking**: View previous workout data (all sets) during current workout for progression
- **Calendar View**: Visual representation of workout days with progress indicators (week starts Monday)
- **Achievements**: Unlock achievements for reaching milestones (daily, weekly, monthly, lifetime)

### 📊 Analytics & Stats

- Weekly workout tracking (Monday-Sunday)
- Exercise frequency analysis
- Personal records tracking (max weight, reps, volume per exercise)
- Workout history with filtering and sorting
- Clickable workout cards for detailed views
- Exercise history with best set tracking

### ⚙️ Settings & Customization

- Weight unit selection (kg/lb)
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
├── css/
│   ├── gym-tracker.css        # Main dark theme styles
│   └── gym-tracker-old.css    # Backup of original styles
├── js/
│   ├── app.js                 # Main application controller
│   ├── models/                # Data models
│   │   ├── Program.js
│   │   ├── WorkoutDay.js
│   │   ├── WorkoutSession.js
│   │   ├── WorkoutExercise.js
│   │   ├── Set.js
│   │   ├── Exercise.js
│   │   ├── Achievement.js
│   │   └── Settings.js
│   ├── services/              # Business logic
│   │   ├── StorageService.js
│   │   ├── TimerService.js
│   │   ├── AnalyticsService.js
│   │   └── AchievementService.js
│   ├── utils/                 # Helper functions
│   │   ├── helpers.js
│   │   └── validators.js
│   └── views/                 # View controllers
│       ├── home-view.js
│       ├── programs-view.js
│       ├── workout-view.js
│       ├── history-view.js
│       ├── exercises-view.js
│       ├── calendar-view.js
│       ├── achievements-view.js
│       └── settings-view.js
└── data/
    └── exercises-db.js        # 500+ exercise database
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
- Program builder with drag-drop (planned)
- Multi-column layouts
- Detailed history views
- Advanced filtering and sorting

## Dark Theme

Designed for gym environments with low lighting:
- Deep dark backgrounds (#0f0f23)
- High contrast text
- Purple accent colors (#6c63ff)
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

## Browser Compatibility

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- PWA support (installable)
- Offline functionality

## Future Enhancements

- [ ] Plate calculator for barbell exercises
- [ ] Workout templates/presets
- [ ] Exercise form videos/GIFs
- [ ] Social features (share workouts)
- [ ] Advanced analytics (charts, graphs)
- [ ] Workout notes with voice input
- [ ] Integration with fitness trackers
- [ ] Progressive overload suggestions
- [ ] Deload week tracking
- [ ] Body measurements tracking
- [ ] Nutrition logging
- [ ] Workout reminders/notifications
- [ ] Exercise superset grouping
- [ ] Rest timer auto-start between sets

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

---

**Version**: 2.1.0
**Last Updated**: 2025-01-20
**Author**: Nikita Soifer

## Recent Updates (v2.1.0)

- Expanded exercise database from 210 to 500+ exercises
- Split categories: Arms → Biceps/Triceps, Legs → Quads/Hamstrings/Calves
- Added custom exercise creation with full integration
- Implemented exercise reordering in program builder
- Added previous workout data display (all sets) during workouts
- Improved text contrast and readability throughout app
- Replaced browser confirm dialogs with custom styled modals
- Made workout tiles clickable for detailed views
- Changed week start to Monday throughout the app
- Removed difficulty field from exercises
- Enhanced dashboard with cleaner layout
- Added workout validation (requires at least one completed set)
