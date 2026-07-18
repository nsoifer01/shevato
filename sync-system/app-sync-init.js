// App-wide storage sync initialization
// Integrates with existing Firebase Auth in main.js

import { startStorageSync, stopAllSyncs, getSyncStatus, getGlobalSyncStatus } from './storage-sync-robust.js';

// Track active syncs
let activeSyncs = [];

// App namespace and localStorage key mappings
const APP_SYNC_CONFIG = {
  'mario-kart': {
    namespace: 'marioKartApp',
    keys: [
      // Base keys (MK8 Deluxe)
      'marioKartRaces',           // Main race data (mk8d)
      'marioKartPlayerNames',     // Player names (mk8d)
      'marioKartPlayerSymbols',   // Player symbols (mk8d) 
      'marioKartPlayerIcons',     // Player icons (mk8d)
      'marioKartPlayerCount',     // Number of players (mk8d)
      'marioKartAutoBackup',      // Backup data (mk8d)
      
      // Mario Kart World keys (mkworld)
      'marioKartWorldRaces',      // Main race data (mkworld)
      'marioKartWorldPlayerNames', // Player names (mkworld)
      'marioKartWorldPlayerSymbols', // Player symbols (mkworld)
      'marioKartWorldPlayerIcons', // Player icons (mkworld)
      'marioKartWorldPlayerCount', // Number of players (mkworld)
      'marioKartWorldAutoBackup', // Backup data (mkworld)
      
      // Shared keys
      'selectedGameVersion',      // Game version (mk8d/mkworld)
      'sidebarOpen',              // UI state (shared)
      'marioKartActionHistory'    // Undo/redo history
      // Note: Including all keys to ensure complete sync
    ]
  },
  
  'football-h2h': {
    namespace: 'footballH2HApp',
    keys: [
      'footballH2HGames',         // Main game data
      'footballH2HPlayers',       // Player data
      'footballH2HPlayerIcons',   // Player icons
      'footballH2HAutoBackup'     // Backup data
    ]
  },

  'gym-tracker': {
    namespace: 'gymTrackerApp',
    keys: [
      'gymTrackerPrograms',       // Workout programs
      'gymTrackerProgramOrder',   // User's custom program ordering
      'gymTrackerProgramSort',    // Program sort preference (custom / name / etc.)
      'gymTrackerSessions',       // Workout sessions/history
      'gymTrackerSettings',       // User settings
      'gymTrackerAchievements',   // Unlocked achievements
      'gymTrackerActiveProgram',  // Currently active program ID
      'gymTrackerCustomExercises', // User-created custom exercises
      'gymTrackerMeasurements'    // Body measurements log
    ]
  },

  // App key + URL path are 'rising-shows' (rebranded from 'rising-seasons').
  // The Firestore namespace and the 'rising-seasons:*' localStorage keys are
  // deliberately kept at their legacy values so signed-in users' already-synced
  // data (watched shows, grid/list preference) carries over the rename instead
  // of being orphaned under a fresh namespace. app.js keeps STORAGE_NS the same
  // for the same reason.
  'rising-shows': {
    namespace: 'risingSeasonsApp',
    keys: [
      'rising-seasons:watched'      // Set of watched (seriesId, season) keys
    ]
  },

  'maptap-rivals': {
    namespace: 'maptapRivalsApp',
    keys: [
      'maptapRivalsRivals',         // Rival list (id, name, color, icon, maptapUsername, createdAt)
      'maptapRivalsGames',          // All daily games (id, rivalId, date, myScore, theirScore, note)
      'maptapRivalsMe',             // Owner display name
      'maptapRivalsMyIcon',         // Owner avatar icon (emoji from ICONS palette)
      'maptapRivalsMyMapTap',       // Your maptap.gg username (for syncing)
      'maptapRivalsMyProfile',      // Verified profile snapshot (nickname/joinDate/avg/best)
      'maptapRivalsSettings',       // UI prefs (last-selected rival, etc.)
      'maptapRivalsSelectedRivalId' // Currently focused rival on detail view
    ]
  },

  'trip-planner': {
    namespace: 'tripPlannerApp',
    keys: [
      'trip-planner:v1',            // All trips + items (the entire planner state)
      'trip-planner:theme',         // dark / light preference
      'trip-planner:timefmt'        // 12 / 24-hour time display preference
      // trip-planner:geo:v2 (geocode cache) deliberately NOT synced:
      // large, derivable, and device-local by nature.
    ]
  }
};

/**
 * Initialize sync for all apps based on current page
 * Call this when user signs in
 */
export async function initAppSync() {
  // Persistence is configured at initializeFirestore() time in
  // firebase-config.js (persistentLocalCache + persistentMultipleTabManager),
  // so there is nothing to enable here — the import this function used to
  // make has been retired along with the no-op firebase-persistence shim.

  // Stop any existing syncs
  stopAllSyncs();
  activeSyncs = [];

  // Determine which app we're in based on URL
  const currentPath = window.location.pathname;
  let currentApp = null;
  
  if (currentPath.includes('/mario-kart/')) {
    currentApp = 'mario-kart';
  } else if (currentPath.includes('/football-h2h/')) {
    currentApp = 'football-h2h';
  } else if (currentPath.includes('/gym-tracker/')) {
    currentApp = 'gym-tracker';
  } else if (currentPath.includes('/maptap-rivals/')) {
    currentApp = 'maptap-rivals';
  } else if (currentPath.includes('/rising-shows/')) {
    currentApp = 'rising-shows';
  } else if (currentPath.includes('/trip-planner/')) {
    currentApp = 'trip-planner';
  }

  // Only sync the current app's namespace plus shared global prefs.
  //
  // Previously every app page also opened Firestore listeners + ran initial
  // merges for the other two apps "so they're ready when user navigates."
  // Navigation between apps is a full page load (each app is a separate
  // static HTML), so the warm-cache argument doesn't hold — those listeners
  // were just extra Firestore reads, extra bandwidth, and an extra race
  // against the UI on every gym/football/mario-kart page load.
  if (currentApp && APP_SYNC_CONFIG[currentApp]) {
    const config = APP_SYNC_CONFIG[currentApp];

    const sync = startStorageSync({
      namespace: config.namespace,
      keys: config.keys,
      useFirestore: true
    });

    activeSyncs.push({ app: currentApp, sync });
  }

  // Sync global/shared preferences if on any app page
  if (currentApp) {
    const globalSync = startStorageSync({
      namespace: 'globalPrefs',
      keys: ['theme'], // Theme is used across apps
      useFirestore: true
    });

    activeSyncs.push({ app: 'global', sync: globalSync });
  }

  return activeSyncs.length;
}

/**
 * Stop all app syncs (call on sign out)
 */
export function stopAppSync() {
  stopAllSyncs();
  activeSyncs = [];
}

/**
 * Get sync status for debugging
 */
export function getAppSyncStatus() {
  return {
    activeCount: activeSyncs.length,
    activeSyncs: activeSyncs.map(s => ({ 
      app: s.app, 
      status: getSyncStatus(s.sync?.namespace || s.app + 'App') 
    })),
    global: getGlobalSyncStatus()
  };
}

/**
 * Integration hook - call this from main.js auth state handler
 * This integrates with your existing Firebase Auth system
 */
export function setupAppSyncIntegration() {
  // Wait for Firebase Auth to be available
  const waitForAuth = () => {
    if (window.firebaseAuth && window.firebaseAuth.isAvailable()) {
      // Hook into existing auth state changes
      window.firebaseAuth.onAuthStateChange((user) => {
        if (user) {
          initAppSync().catch(error => {
            console.error('❌ App sync initialization failed:', error);
            // Broadcast so per-app UI (sync-status pill, banner) can show
            // "sync offline" instead of silently letting writes accumulate
            // in localStorage with no path to Firestore.
            window.dispatchEvent(new CustomEvent('appSyncFailed', {
              detail: { message: error?.message || String(error) }
            }));
          });
        } else {
          stopAppSync();
        }
      });
    } else {
      // Retry if Firebase Auth not ready yet
      setTimeout(waitForAuth, 100);
    }
  };
  
  waitForAuth();
}

// Auto-initialize if we're on an app page and this script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAppSyncIntegration);
} else {
  setupAppSyncIntegration();
}