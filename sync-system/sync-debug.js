// Debug utilities for Firebase storage sync
// Add this to any app page to monitor sync behavior

// Enhanced debug tools for sync monitoring
window.syncDebug = {
  
  // Monitor all localStorage changes in real-time
  startMonitoring() {
    console.log('🔍 Starting localStorage sync monitoring...');
    
    // Listen for sync events
    window.addEventListener('localStorageSync', (e) => {
      console.log(`📡 SYNC EVENT:`, {
        key: e.detail.key,
        value: typeof e.detail.value === 'object' ? JSON.stringify(e.detail.value).slice(0, 100) + '...' : e.detail.value,
        source: e.detail.source,
        timestamp: new Date().toISOString()
      });
    });
    
    // Override localStorage to track all changes
    const originalSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(key, value) {
      console.log(`💾 localStorage.setItem("${key}", ...)`);
      originalSetItem(key, value);
    };
    
    console.log('✅ Monitoring active - check console for sync events');
  },
  
  // Check if a key is being synced
  isKeySynced(key) {
    const global = window._debugSync.status();
    let revisions = {};
    try {
      const revisionsData = window._debugSync.revisions();
      if (revisionsData && typeof revisionsData === 'object') {
        if (revisionsData instanceof Map) {
          revisions = Object.fromEntries(revisionsData);
        } else if (Array.isArray(revisionsData)) {
          revisions = Object.fromEntries(revisionsData);
        } else {
          revisions = revisionsData;
        }
      }
    } catch (error) {
      console.log('⚠️  Error getting revisions:', error.message);
    }
    
    const synced = global.totalKeys > 0 && key in revisions;
    console.log(`🔍 Key "${key}" sync status: ${synced ? '✅ SYNCED' : '❌ NOT SYNCED'}`);
    return synced;
  },
  
  // Force sync a specific key
  forceSyncKey(key) {
    const value = localStorage.getItem(key);
    if (value === null) {
      console.log(`❌ Key "${key}" not found in localStorage`);
      return;
    }
    
    console.log(`🚀 Force syncing key "${key}"`);
    // Trigger change by setting the same value
    localStorage.setItem(key, value);
    
    setTimeout(() => {
      console.log(`✅ Force sync completed for "${key}"`);
    }, 1000);
  },
  
  // Test edit functionality
  testEditSync(appName = 'mario-kart') {
    console.log(`🧪 Testing edit sync for ${appName}...`);
    
    if (appName === 'mario-kart') {
      const racesKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
      const races = JSON.parse(localStorage.getItem(racesKey) || '[]');
      
      console.log(`📊 Found ${races.length} races using key: ${racesKey}`);
      console.log(`🔍 Is key synced?`, this.isKeySynced(racesKey));
      
      if (races.length > 0) {
        // Modify the first race
        const originalFirst = { ...races[0] };
        races[0].testSync = Date.now();
        
        console.log(`✏️ Modifying first race...`);
        localStorage.setItem(racesKey, JSON.stringify(races));
        
        // Check if sync triggered
        setTimeout(() => {
          const newRaces = JSON.parse(localStorage.getItem(racesKey) || '[]');
          const synced = newRaces[0].testSync === races[0].testSync;
          console.log(`${synced ? '✅' : '❌'} Edit sync test result: ${synced ? 'WORKING' : 'FAILED'}`);
        }, 2000);
      } else {
        console.log('❌ No races found to test edit sync');
      }
    }
  },
  
  // Get all active storage keys
  getAllStorageKeys() {
    const keys = Object.keys(localStorage);
    let syncedKeys = [];
    
    try {
      const revisionsData = window._debugSync.revisions();
      if (revisionsData && typeof revisionsData === 'object') {
        if (revisionsData instanceof Map) {
          syncedKeys = Object.keys(Object.fromEntries(revisionsData));
        } else if (Array.isArray(revisionsData)) {
          syncedKeys = Object.keys(Object.fromEntries(revisionsData));
        } else {
          syncedKeys = Object.keys(revisionsData);
        }
      }
    } catch (error) {
      console.log('⚠️  Error getting synced keys:', error.message);
    }
    
    console.log('📋 All localStorage keys:');
    keys.forEach(key => {
      const isSynced = syncedKeys.includes(key);
      console.log(`  ${isSynced ? '✅' : '❌'} ${key}`);
    });
    
    return { all: keys, synced: syncedKeys };
  },
  
  // Compare localStorage with Firebase (requires manual check)
  async compareWithFirebase() {
    console.log('🔍 To manually compare with Firebase:');
    console.log('1. Open Firebase Console → Firestore');
    console.log('2. Navigate to users → [your-uid] → apps → [namespace]');
    console.log('3. Compare the data values with localStorage');
    
    // Show local data structure
    const status = window._debugSync.status();
    console.log('📊 Current sync status:', status);
    
    let revisions = {};
    try {
      const revisionsData = window._debugSync.revisions();
      if (revisionsData && typeof revisionsData === 'object') {
        if (revisionsData instanceof Map) {
          revisions = Object.fromEntries(revisionsData);
        } else if (Array.isArray(revisionsData)) {
          revisions = Object.fromEntries(revisionsData);
        } else {
          revisions = revisionsData;
        }
      }
    } catch (error) {
      console.log('⚠️  Error getting revisions for comparison:', error.message);
    }
    
    console.log('📈 Local revisions:', revisions);
  },
  
  // Full diagnostic
  fullDiagnostic() {
    console.log('🩺 === FULL SYNC DIAGNOSTIC ===');
    
    // 1. Check sync status
    const globalStatus = window._debugSync.status();
    console.log('1️⃣ Global Status:', globalStatus);
    
    // 2. Check app status
    if (window.getAppSyncStatus) {
      const appStatus = window.getAppSyncStatus();
      console.log('2️⃣ App Status:', appStatus);
    }
    
    // 3. Check storage keys
    this.getAllStorageKeys();
    
    // 4. Check for Mario Kart version issues
    if (window.getStorageKey && window.currentGameVersion) {
      const gameVersion = window.currentGameVersion;
      const racesKey = window.getStorageKey('Races');
      console.log(`3️⃣ Game Version: ${gameVersion}, Races Key: ${racesKey}`);
      this.isKeySynced(racesKey);
    }
    
    console.log('✅ Diagnostic complete - check outputs above');
  }
};

