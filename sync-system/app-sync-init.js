// App-wide storage sync initialization
// Integrates with existing Firebase Auth in main.js

import { startStorageSync, stopAllSyncs, getSyncStatus, getGlobalSyncStatus } from './storage-sync-robust.js';
import { enablePersistence } from './firebase-persistence.js';
import { db } from '../firebase-config.js';

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
  }
};

/**
 * Initialize sync for all apps based on current page
 * Call this when user signs in
 */
export async function initAppSync() {
  // Enable offline persistence once globally
  try {
    await enablePersistence(db, true);
  } catch (error) {
    console.warn('Firebase persistence failed:', error.message);
  }

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