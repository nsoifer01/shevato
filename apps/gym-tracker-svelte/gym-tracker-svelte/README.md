# Gym Tracker (Svelte Version) 💪

Modern workout tracking app built with Svelte. This is a complete refactor of the original vanilla JS gym tracker using modern web technologies.

## Features

- ✅ **Dashboard** - View workout stats, current streak, and recent activity
- ✅ **Programs** - Create and manage workout programs
- ✅ **Workout** - Start workout sessions with built-in timer
- ✅ **History** - Track all past workouts
- ✅ **Settings** - Customize preferences and manage data
- ✅ **Responsive Design** - Works on desktop and mobile
- ✅ **Local Storage** - All data persists in browser
- ✅ **Firebase Ready** - Configured for Firebase sync (to be implemented)

## Tech Stack

- **Svelte** - Reactive UI framework
- **Vite** - Build tool
- **Firebase** - Backend/sync (configured, not yet implemented)
- **LocalStorage** - Data persistence

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment to Netlify

### Option 1: Deploy from Git

1. Push this code to your GitHub repo
2. Go to [Netlify](https://netlify.com)
3. Click "Add new site" → "Import an existing project"
4. Connect your GitHub repo
5. Configure build settings:
   - **Base directory**: `apps/gym-tracker-svelte`
   - **Build command**: `npm run build`
   - **Publish directory**: `apps/gym-tracker-svelte/dist`
6. Click "Deploy"

### Option 2: Deploy from Terminal

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Deploy
cd apps/gym-tracker-svelte
netlify deploy --prod
```

## Comparison with Original

**Original Vanilla JS Version:**
- 20,000+ lines of code
- Multiple files (models/, services/, views/, utils/)
- Manual DOM manipulation
- Complex state management
- Larger bundle size

**Svelte Version:**
- ~1,500 lines of code
- Built-in reactivity
- Component-based architecture
- Automatic state updates
- **56 KB total bundle** (vs hundreds of KB)
- Faster load times
- Better maintainability

## File Structure

```
gym-tracker-svelte/
├── src/
│   ├── lib/
│   │   ├── firebase.js        # Firebase configuration
│   │   └── models.js          # Data models
│   ├── stores/
│   │   └── gymStore.js        # Svelte stores (state management)
│   ├── components/
│   │   └── Navigation.svelte  # Navigation component
│   ├── views/
│   │   ├── Home.svelte        # Dashboard view
│   │   ├── Programs.svelte    # Programs management
│   │   ├── History.svelte     # Workout history
│   │   ├── Workout.svelte     # Active workout session
│   │   └── Settings.svelte    # App settings
│   └── App.svelte             # Main app component
├── netlify.toml               # Netlify configuration
└── package.json               # Dependencies
```

## License

MIT

## Author

Built with ❤️ for shevato.com
