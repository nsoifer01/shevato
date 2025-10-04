// Debug utilities for initial sync when signing in on new devices
// This will help us track the initial merge process

(function() {
  'use strict';
  
  console.log('🔍 Initial Sync Debug loaded');
  
  // Track the initial sync process
  let initialSyncData = {
    authEvents: [],
    syncEvents: [],
    mergeAttempts: [],
    firestoreReads: [],
    localStorageState: {}
  };
  
  // Monitor auth state changes
  if (window.firebaseAuth) {
    const originalOnAuthStateChange = window.firebaseAuth.onAuthStateChange.bind(window.firebaseAuth);
    window.firebaseAuth.onAuthStateChange = function(callback) {
      return originalOnAuthStateChange(function(user) {
        initialSyncData.authEvents.push({
          timestamp: Date.now(),
          user: user ? { uid: user.uid, email: user.email } : null,
          event: user ? 'sign-in' : 'sign-out'
        });
        
        console.log('🔐 Auth State Change:', user ? `✅ Signed in: ${user.email}` : '❌ Signed out');
        
        if (user) {
          // Capture localStorage state before sync
          initialSyncData.localStorageState.beforeSync = captureLocalStorageState();
          console.log('📊 LocalStorage before sync:', Object.keys(initialSyncData.localStorageState.beforeSync));
          
          // Set up monitoring for initial merge
          setTimeout(() => {
            initialSyncData.localStorageState.afterSync = captureLocalStorageState();
            console.log('📊 LocalStorage after sync:', Object.keys(initialSyncData.localStorageState.afterSync));
            
            // Check what changed
            const changes = compareLocalStorageStates(
              initialSyncData.localStorageState.beforeSync,
              initialSyncData.localStorageState.afterSync
            );
            
            if (changes.length > 0) {
              console.log('✅ Initial sync brought down data:', changes);
            } else {
              console.log('⚠️  No data synced from Firebase on initial sign-in');
            }
          }, 3000); // Wait 3 seconds for initial merge
        }
        
        return callback(user);
      });
    };
  }
  
  // Capture current localStorage state
  function captureLocalStorageState() {
    const state = {};
    const importantKeys = [
      'marioKartRaces', 'marioKartPlayerNames', 'marioKartPlayerCount',
      'marioKartWorldRaces', 'marioKartWorldPlayerNames', 
      'footballH2HGames', 'footballH2HPlayers',
      'gymTrackerData', 'gymTrainingPlan'
    ];
    
    importantKeys.forEach(key => {
      const value = localStorage.getItem(key);
      if (value) {
        try {
          const parsed = JSON.parse(value);
          state[key] = {
            type: Array.isArray(parsed) ? 'array' : typeof parsed,
            length: Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length,
            preview: JSON.stringify(parsed).slice(0, 100) + '...'
          };
        } catch {
          state[key] = { type: 'string', length: value.length, preview: value.slice(0, 100) + '...' };
        }
      }
    });
    
    return state;
  }
  
  // Compare localStorage states
  function compareLocalStorageStates(before, after) {
    const changes = [];
    
    // Check for new keys
    for (const key in after) {
      if (!(key in before)) {
        changes.push({ key, action: 'added', data: after[key] });
      } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes.push({ key, action: 'updated', before: before[key], after: after[key] });
      }
    }
    
    // Check for removed keys
    for (const key in before) {
      if (!(key in after)) {
        changes.push({ key, action: 'removed', data: before[key] });
      }
    }
    
    return changes;
  }
  
  // Enhanced debug utilities
  window.initialSyncDebug = {
    
    // Get full sync history
    getHistory() {
      return initialSyncData;
    },
    
    // Check Firebase data manually
    async checkFirebaseData() {
      console.log('🔍 Checking Firebase data...');
      
      const user = window.firebaseAuth?.getCurrentUser();
      if (!user) {
        console.log('❌ No authenticated user');
        return;
      }
      
      console.log('👤 Checking data for user:', user.email);
      console.log('🔥 Manual Firebase check:');
      console.log('1. Open Firebase Console → Firestore');
      console.log(`2. Navigate to: users → ${user.uid} → apps`);
      console.log('3. Check if marioKartApp, footballH2HApp, gymTrackerApp exist');
      console.log('4. Verify data structure matches what you expect');
      
      // Try to access Firestore directly if available
      if (window.firebase?.firestore) {
        try {
          const db = window.firebase.firestore();
          const doc = await db.collection('users').doc(user.uid).collection('apps').doc('marioKartApp').get();
          
          if (doc.exists) {
            const data = doc.data();
            console.log('✅ Found marioKartApp data:', {
              hasData: !!data.data,
              keyCount: data.data ? Object.keys(data.data).length : 0,
              keys: data.data ? Object.keys(data.data) : []
            });
          } else {
            console.log('❌ No marioKartApp document found in Firebase');
          }
        } catch (error) {
          console.log('❌ Error checking Firestore:', error.message);
        }
      }
    },
    
    // Test initial sync manually
    async testInitialSync() {
      console.log('🧪 Testing initial sync...');
      
      const user = window.firebaseAuth?.getCurrentUser();
      if (!user) {
        console.log('❌ No authenticated user');
        return;
      }
      
      // Clear localStorage
      console.log('🗑️  Clearing localStorage...');
      const importantKeys = [
        'marioKartRaces', 'marioKartPlayerNames', 'marioKartPlayerCount',
        'marioKartWorldRaces', 'marioKartWorldPlayerNames', 
        'footballH2HGames', 'footballH2HPlayers',
        'gymTrackerData', 'gymTrainingPlan'
      ];
      
      importantKeys.forEach(key => localStorage.removeItem(key));
      
      console.log('🔄 Triggering manual sync...');
      
      // Try to trigger sync manually
      if (window._debugSync && window._debugSync.triggerInitialMerge) {
        const namespaces = window._debugSync.getAvailableNamespaces();
        console.log('📋 Available namespaces:', namespaces);
        
        for (const namespace of namespaces) {
          console.log(`🚀 Calling manual initial merge for ${namespace}...`);
          await window._debugSync.triggerInitialMerge(namespace);
        }
        
        // Check results
        setTimeout(() => {
          const finalState = captureLocalStorageState();
          console.log('📊 Final localStorage state:', finalState);
          
          if (Object.keys(finalState).length > 0) {
            console.log('✅ Initial sync successful!');
          } else {
            console.log('❌ Initial sync failed - no data downloaded');
          }
        }, 2000);
        
      } else {
        console.log('⚠️  Manual sync trigger not available');
        console.log('💡 Try refreshing the page to trigger initial sync');
      }
    },
    
    // Check sync system status
    checkSyncStatus() {
      console.log('🔍 === SYNC SYSTEM STATUS ===');
      
      // Check auth
      const user = window.firebaseAuth?.getCurrentUser();
      console.log('👤 User:', user ? user.email : 'Not authenticated');
      
      // Check sync system
      if (window._debugSync) {
        const status = window._debugSync.status();
        console.log('📊 Sync Status:', status);
        
        if (status.activeNamespaces === 0) {
          console.log('❌ No active sync namespaces - sync not running');
        }
      } else {
        console.log('❌ Debug sync system not available');
      }
      
      // Check sync initialization
      if (window.getAppSyncStatus) {
        const appStatus = window.getAppSyncStatus();
        console.log('📱 App Sync Status:', appStatus);
      }
      
      console.log('=== END STATUS ===');
    },
    
    // Comprehensive new device test
    newDeviceTest() {
      console.log('🚀 === NEW DEVICE SYNC TEST ===');
      
      console.log('1️⃣ Checking authentication...');
      this.checkSyncStatus();
      
      console.log('2️⃣ Checking localStorage...');
      const currentState = captureLocalStorageState();
      console.log('📊 Current localStorage data:', currentState);
      
      if (Object.keys(currentState).length === 0) {
        console.log('❌ No data in localStorage');
        console.log('💡 This might be the issue - initial sync didn\'t download data');
      }
      
      console.log('3️⃣ Firebase data check needed...');
      this.checkFirebaseData();
      
      console.log('=== END TEST ===');
    }
  };
  
  // Auto-run diagnostic if this looks like a fresh sign-in
  setTimeout(() => {
    const user = window.firebaseAuth?.getCurrentUser();
    if (user) {
      const localData = captureLocalStorageState();
      if (Object.keys(localData).length === 0) {
        console.log('⚠️  Fresh sign-in detected with no local data');
        console.log('💡 Run: initialSyncDebug.newDeviceTest()');
      }
    }
  }, 2000);
  
})();