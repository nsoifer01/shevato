// App-wide storage sync initialization
// Integrates with existing Firebase Auth in main.js
//
// This file also owns site-wide account deletion (bottom of the file). It
// lives here rather than in its own module because APP_SYNC_CONFIG below is
// the only list of app namespaces in the project, and deletion has to walk
// exactly that list: a second copy would silently stop covering the next app
// somebody adds.

import {
  startStorageSync,
  stopSync,
  stopAllSyncs,
  getSyncStatus,
  getGlobalSyncStatus,
  eraseCloudData,
  eraseAccountProfile,
  eraseRivalNetworkIdentity
} from './storage-sync-robust.js';

// Auth SDK, same pinned URL firebase-config.js uses, so this resolves to the
// same module instance and the same initialised auth registry. We import the
// three functions rather than going through window.firebaseAuth because the
// adapter there deliberately exposes only the everyday surface (sign in, sign
// up, reset, sign out); account deletion is not everyday.
import {
  deleteUser,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

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
      'selectedGameVersion'       // Game version (mk8d/mkworld)
      // Not synced: sidebar open/closed is device-local UI state, and the
      // undo/redo stack lives in memory only (never written to storage).
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

  'fpl-planner': {
    namespace: 'fplPlannerApp',
    keys: [
      'fplPlannerTeamId',         // The linked FPL entry (team) id, as a string
      'fplPlannerSettings',       // Planner preferences (horizon, risk profile, last view)
      'fplPlannerPlanHistory',    // Per-gameweek plan versions with timestamps, capped
      'fplPlannerSquadSnapshot'   // Last known squad state, so the app can boot instantly
      // The bulk FPL data cache ('fpl-planner:cache:*' - bootstrap, fixtures,
      // projections) is deliberately NOT synced: it is large, derivable from the
      // public API, and byte-for-byte identical for every user, so syncing it
      // would cost Firestore quota for nothing. Same reasoning as the
      // trip-planner geocode cache below.
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
      'gymTrackerMeasurements',   // Body measurements log
      'gymTrackerMeasurementGoals', // Measurement target values + direction
      'gymTrackerWarmupSettings', // Warm-up ramp preferences (threshold, ramp rows)
      // Which stored-data migrations have run (apps/gym-tracker/js/utils/
      // data-migrations.js). It MUST sync: the unit migration rewrites stored
      // weights once, and a second device that never learned it had already
      // happened would convert the already-converted data again. No user data
      // of its own - a single integer.
      'gymTrackerDataVersion',
      // The user's answer to the one-time "which units were your existing
      // measurements entered in?" question. Syncs so a second device never
      // asks again; it is a single string choice plus a timestamp, no
      // measurement values of its own. (The rollback copy that repair writes,
      // gymTrackerMeasurementsBackup, is deliberately NOT synced.)
      'gymTrackerMeasurementUnits'
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
      'rising-seasons:watched',     // Set of watched (seriesId, season) keys
      'rising-seasons:compare'      // Compare-overlay series ids (insertion order)
    ]
  },

  'maptap-rivals': {
    namespace: 'maptapRivalsApp',
    keys: [
      'maptapRivalsRivals',         // Rival list (id, name, color, icon, maptapUsername, createdAt)
      'maptapRivalsGames',          // All daily games (id, rivalId, date, myScore, theirScore, note)
      'maptapRivalsDays',           // Day-global puzzle geography: { 'YYYY-MM-DD': City[5] }, normalised out of the game log
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
      'trip-planner:timefmt',       // 12 / 24-hour time display preference
      'trip-planner:distunit',      // Miles / kilometers distance display preference
      'trip-planner:tempunit'       // Celsius / Fahrenheit temperature display preference
      // trip-planner:geo:v3 (geocode cache) deliberately NOT synced:
      // large, derivable, and device-local by nature.
    ]
  }
};

// Preferences shared by every app. Kept beside APP_SYNC_CONFIG (rather than
// inline in initAppSync, where it used to live) so that "every namespace this
// account owns" has one definition, which both the sync start-up and the
// account deletion below read.
const GLOBAL_SYNC_CONFIG = {
  namespace: 'globalPrefs',
  keys: ['theme']
};

/**
 * Initialize sync for all apps based on current page
 * Call this when user signs in
 */
export async function initAppSync() {
  // Persistence is configured at initializeFirestore() time in
  // firebase-config.js (persistentLocalCache + persistentMultipleTabManager),
  // so there is nothing to enable here: the import this function used to
  // make has been retired along with the no-op firebase-persistence shim.
  //
  // DO NOT stopAllSyncs() here. This function runs on every delivery of the
  // auth state, and firebase-config.js re-fans its listeners whenever ANY
  // other shevato tab finishes loading a page, so a user with two tabs open
  // re-enters this function constantly. Tearing every namespace down first
  // defeated the same-user shortcut in _startSyncForUser (it can only skip
  // the rebuild when the sync is still there to be kept), and worse,
  // stopSync() clears the debounced write timer and deletes the pending
  // queue: an edit made in the last 500 ms was dropped on the floor, and the
  // older remote copy then overwrote it in localStorage and on screen.
  // Restarting is now idempotent, and only namespaces this page no longer
  // wants are stopped.

  // Determine which app we're in based on URL
  const currentPath = window.location.pathname;
  let currentApp = null;
  
  if (currentPath.includes('/mario-kart/')) {
    currentApp = 'mario-kart';
  } else if (currentPath.includes('/football-h2h/')) {
    currentApp = 'football-h2h';
  } else if (currentPath.includes('/fpl-planner/')) {
    currentApp = 'fpl-planner';
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
  const wanted = [];
  if (currentApp && APP_SYNC_CONFIG[currentApp]) {
    wanted.push({ app: currentApp, config: APP_SYNC_CONFIG[currentApp] });
  }
  // Sync global/shared preferences if on any app page
  if (currentApp) {
    wanted.push({ app: 'global', config: GLOBAL_SYNC_CONFIG });
  }

  // Stop only what this page no longer wants (in practice nothing, since the
  // app is decided by the URL and the URL does not change without a reload;
  // it matters after a sign-out/sign-in as a different user).
  const wantedNamespaces = new Set(wanted.map((w) => w.config.namespace));
  for (const entry of activeSyncs) {
    const ns = entry.sync?.namespace || entry.namespace;
    if (ns && !wantedNamespaces.has(ns)) stopSync(ns);
  }

  activeSyncs = wanted.map(({ app, config }) => ({
    app,
    namespace: config.namespace,
    // Idempotent: _startSyncForUser returns the existing handle untouched
    // when the user, namespace and key set all match, so a repeat call
    // neither re-attaches the listener nor disturbs a pending write.
    sync: startStorageSync({
      namespace: config.namespace,
      keys: config.keys,
      useFirestore: true
    })
  }));

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

/* ==========================================================================
   Account deletion
   ==========================================================================
   What this removes, and what it deliberately cannot:

   IN SCOPE. Everything the account owns under users/{uid}, which the
   recursive `match /users/{userId}/{document=**}` rule scopes to that account
   alone: one document per namespace at users/{uid}/apps/{namespace}, plus the
   users/{uid} document itself (Arena keeps its trivia profile in fields ON
   that document, and deleting a document never deletes its subcollections, so
   both halves are needed). Then the opt-in MapTap Rivals network identity,
   which lives in top-level collections but is keyed to this uid and is
   deletable by its owner under the deployed rules. Then the local copy of
   every synced key on this device. Then the Firebase Auth user.

   OUT OF SCOPE, because the security rules forbid the owner from deleting it:
   the Arena global XP leaderboard row (delete is restricted to leaderboard
   admins), head-to-head pair records and Globe Drop daily scores (no delete
   rule at all), and Arena room chat, which is append-only by design and is
   already described as permanent in privacy.html. Multiplayer room documents
   are shared state that outlives any one player. The UI says all of this
   before asking for confirmation, and privacy.html repeats it.
   ========================================================================== */

export const DELETE_CONFIRMATION_WORD = 'DELETE';

/**
 * Every Firestore namespace this account owns, derived from APP_SYNC_CONFIG
 * so a newly added app is covered by deletion the moment it starts syncing.
 * @returns {string[]}
 */
export function getSyncNamespaces() {
  const namespaces = Object.values(APP_SYNC_CONFIG).map(config => config.namespace);
  namespaces.push(GLOBAL_SYNC_CONFIG.namespace);
  return namespaces;
}

/**
 * Every localStorage key that participates in sync, from the same source.
 * @returns {string[]}
 */
export function getSyncedLocalKeys() {
  const keys = new Set();
  for (const config of Object.values(APP_SYNC_CONFIG)) {
    for (const key of config.keys) keys.add(key);
  }
  for (const key of GLOBAL_SYNC_CONFIG.keys) keys.add(key);
  return Array.from(keys);
}

/**
 * The typed confirmation gate. Exported so the UI and the tests agree on what
 * counts, instead of the UI inventing its own check.
 */
export function isDeletionConfirmed(typed) {
  return typeof typed === 'string' && typed.trim() === DELETE_CONFIRMATION_WORD;
}

/**
 * Remove the local copy of every synced key on this device.
 * @returns {string[]} the keys that were actually present and removed.
 */
export function clearSyncedLocalData() {
  const cleared = [];
  for (const key of getSyncedLocalKeys()) {
    if (localStorage.getItem(key) === null) continue;
    localStorage.removeItem(key);
    cleared.push(key);
  }
  return cleared;
}

// Firebase error codes, turned into something a person can act on. The raw
// codes are useless to a user and `auth/requires-recent-login` in particular
// reads like a bug rather than a security measure.
const REAUTH_MESSAGES = {
  'auth/wrong-password': 'That password is not correct. Nothing has been deleted.',
  'auth/invalid-credential': 'That password is not correct. Nothing has been deleted.',
  'auth/invalid-login-credentials': 'That password is not correct. Nothing has been deleted.',
  'auth/missing-password': 'Enter your password to confirm. Nothing has been deleted.',
  'auth/user-mismatch': 'That password belongs to a different account. Nothing has been deleted.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes, then try again. Nothing has been deleted.',
  'auth/network-request-failed': 'Could not reach the server. Check your connection and try again. Nothing has been deleted.'
};

const AUTH_DELETE_MESSAGES = {
  'auth/requires-recent-login': 'Your session is too old to delete the account. Sign out, sign back in, and try again within a few minutes.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes, then try again.',
  'auth/network-request-failed': 'Could not reach the server. Check your connection and try again.'
};

function messageFor(table, error, fallback) {
  return table[error?.code] || fallback;
}

/**
 * Delete this account and the data it owns.
 *
 * Never throws and never reports a success it did not achieve: the caller
 * gets a result object describing exactly how far it got.
 *
 * Ordering is the safety property here. The password is proven BEFORE
 * anything is deleted, because deleteUser() rejects stale sessions with
 * auth/requires-recent-login and finding that out afterwards would leave a
 * live account with its data already gone. Live sync listeners are stopped
 * next, because an attached onSnapshot treats a vanishing document as "the
 * cloud is empty" and re-uploads the local keys, undoing the delete. Data
 * goes before the credential, so a failure part-way through still leaves an
 * account that can sign in and retry rather than orphaned documents that
 * nobody can ever reach again.
 *
 * @param {object} options
 * @param {string} options.confirmation Must equal DELETE_CONFIRMATION_WORD.
 * @param {string} options.password     Current password, for reauthentication.
 * @param {object} [options.user]       Override the signed-in user (tests).
 * @returns {Promise<{ok: boolean, reason?: string, message?: string, deleted: string[], failed: Array<{target: string, message: string}>, clearedKeys?: string[]}>}
 */
export async function deleteAccount({ confirmation, password, user } = {}) {
  if (!isDeletionConfirmed(confirmation)) {
    return {
      ok: false,
      reason: 'not-confirmed',
      message: `Type ${DELETE_CONFIRMATION_WORD} to confirm. Nothing has been deleted.`,
      deleted: [],
      failed: []
    };
  }

  const account = user || (typeof window !== 'undefined' && window.firebaseAuth?.getCurrentUser?.()) || null;
  if (!account) {
    return {
      ok: false,
      reason: 'not-signed-in',
      message: 'You are not signed in, so there is no account to delete.',
      deleted: [],
      failed: []
    };
  }
  if (account.isAnonymous) {
    return {
      ok: false,
      reason: 'guest-account',
      message: 'Guest play does not create an account. Clear this browser\'s site data to remove guest state.',
      deleted: [],
      failed: []
    };
  }
  if (typeof password !== 'string' || password === '') {
    return {
      ok: false,
      reason: 'password-required',
      message: 'Enter your password to confirm. Nothing has been deleted.',
      deleted: [],
      failed: []
    };
  }

  try {
    await reauthenticateWithCredential(
      account,
      EmailAuthProvider.credential(account.email, password)
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'reauth-failed',
      code: error?.code || null,
      message: messageFor(REAUTH_MESSAGES, error, 'Could not confirm your password. Nothing has been deleted.'),
      deleted: [],
      failed: []
    };
  }

  stopAppSync();

  const deleted = [];
  const failed = [];

  const targets = getSyncNamespaces().map(namespace => ({
    target: namespace,
    run: () => eraseCloudData(namespace)
  }));
  targets.push({ target: 'account profile', run: eraseAccountProfile });
  targets.push({ target: 'rival network entry', run: eraseRivalNetworkIdentity });

  for (const { target, run } of targets) {
    try {
      await run();
      deleted.push(target);
    } catch (error) {
      failed.push({ target, message: error?.message || String(error) });
    }
  }

  if (failed.length > 0) {
    return {
      ok: false,
      reason: 'data-delete-failed',
      // Sync is stopped by this point, so the page is no longer writing to the
      // cloud. Say that rather than leaving the user on a silently dead tab.
      message: `Could not delete: ${failed.map(f => f.target).join(', ')}. Your account is still active and nothing has been stranded, so you can try again. Reload the page to resume syncing.`,
      deleted,
      failed
    };
  }

  const clearedKeys = clearSyncedLocalData();

  try {
    await deleteUser(account);
  } catch (error) {
    return {
      ok: false,
      reason: 'auth-delete-failed',
      code: error?.code || null,
      message: `${messageFor(AUTH_DELETE_MESSAGES, error, 'Your data was deleted but the account itself could not be removed.')} Your synced data has already been deleted, and syncing has stopped on this page.`,
      deleted,
      failed,
      clearedKeys
    };
  }

  return { ok: true, deleted, failed, clearedKeys };
}

// Auto-initialize if we're on an app page and this script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAppSyncIntegration);
} else {
  setupAppSyncIntegration();
}