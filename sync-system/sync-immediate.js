// Immediate sync system - loads synchronously before any localStorage calls
// This should catch ALL localStorage changes including edits

(function() {
  'use strict';
  
  console.log('🚀 Immediate sync system loading...');
  
  // Install localStorage override immediately
  const originalSetItem = localStorage.setItem;
  const originalRemoveItem = localStorage.removeItem;
  const originalGetItem = localStorage.getItem;
  
  // Track changes for later processing
  let pendingChanges = new Map();
  let syncReady = false;
  
  // Immediate override - captures ALL changes
  localStorage.setItem = function(key, value) {
    // Call original first
    originalSetItem.call(this, key, value);
    
    // Queue for sync processing
    pendingChanges.set(key, {
      action: 'set',
      value: value,
      timestamp: Date.now()
    });
    
    // If sync system is ready, process immediately
    if (syncReady && window.syncManager) {
      window.syncManager.processChange(key, value);
    }
  };
  
  localStorage.removeItem = function(key) {
    originalRemoveItem.call(this, key);
    
    pendingChanges.set(key, {
      action: 'remove',
      value: null,
      timestamp: Date.now()
    });
    
    if (syncReady && window.syncManager) {
      window.syncManager.processChange(key, null);
    }
  };
  
  // When sync system is ready, process pending changes
  window.addEventListener('syncSystemReady', function() {
    console.log('✅ Sync system ready - processing pending changes');
    syncReady = true;
    
    // Process all pending changes
    for (const [key, change] of pendingChanges) {
      if (window.syncManager) {
        window.syncManager.processChange(key, change.action === 'set' ? change.value : null);
      }
    }
    
    pendingChanges.clear();
  });
  
  // Debug utilities
  window.immediateDebug = {
    getPendingChanges() {
      return Array.from(pendingChanges.entries());
    },
    
    isSyncReady() {
      return syncReady;
    },
    
    testOverride() {
      console.log('🧪 Testing immediate override...');
      localStorage.setItem('immediateTest', 'test-' + Date.now());
      localStorage.removeItem('immediateTest');
      console.log('✅ Override test complete');
    }
  };
  
  console.log('✅ Immediate localStorage override installed');
  
})();