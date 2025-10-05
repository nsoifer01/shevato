// Integration script for sync loading modal with Firebase auth and sync events
// This coordinates showing/hiding the modal based on auth and sync states

(function() {
  'use strict';
  
  let userJustSignedIn = false;
  let syncCompleted = false;
  let modalTimeout = null;
  
  // Track if we're in the middle of initial sync after sign-in
  let awaitingInitialSync = false;
  
  // Track user state to prevent infinite refresh loops
  let lastKnownUserId = null;
  let isInitialPageLoad = true;
  
  // Check if we just refreshed due to sync completion
  const SYNC_REFRESH_KEY = 'syncModalJustRefreshed';
  const justRefreshed = sessionStorage.getItem(SYNC_REFRESH_KEY);
  if (justRefreshed) {
    sessionStorage.removeItem(SYNC_REFRESH_KEY);
    isInitialPageLoad = false; // Treat as if modal already handled
  }
  
  function showSyncModal() {
    if (window.SyncLoadingModal) {
      window.SyncLoadingModal.show();
      
      // Auto-hide after 10 seconds as failsafe
      if (modalTimeout) clearTimeout(modalTimeout);
      modalTimeout = setTimeout(() => {
        console.warn('Sync modal auto-hiding after 10s timeout');
        hideSyncModal();
      }, 10000);
    }
  }
  
  function hideSyncModal() {
    if (modalTimeout) {
      clearTimeout(modalTimeout);
      modalTimeout = null;
    }
    
    if (window.SyncLoadingModal) {
      window.SyncLoadingModal.hide();
    }
  }
  
  // Listen for Firebase auth state changes
  function setupAuthListener() {
    // Wait for both Firebase compat and the modern auth system
    if (!window.firebase || !window.firebase.auth) {
      setTimeout(setupAuthListener, 200);
      return;
    }

    // Additional check for Firebase app initialization
    try {
      const auth = window.firebase.auth();

      // Check if Firebase app is properly initialized
      if (!auth.app || !auth.app.options) {
        setTimeout(setupAuthListener, 200);
        return;
      }
      
      auth.onAuthStateChanged((user) => {
        const currentUserId = user ? user.uid : null;
        
        if (user && currentUserId !== lastKnownUserId && !isInitialPageLoad) {
          // This is a genuinely new sign-in (not a page reload with existing auth)
          // Additional check: make sure we haven't shown modal recently
          const lastModalTime = sessionStorage.getItem('lastSyncModalTime');
          const now = Date.now();
          
          if (!lastModalTime || (now - parseInt(lastModalTime)) > 30000) { // 30 second cooldown
            userJustSignedIn = true;
            awaitingInitialSync = true;
            syncCompleted = false;
            lastKnownUserId = currentUserId;
            
            // Store when we last showed the modal
            sessionStorage.setItem('lastSyncModalTime', now.toString());

            showSyncModal();

            // Start checking for sync completion
            checkForSyncCompletion();
          } else {
            lastKnownUserId = currentUserId;
          }

        } else if (user && isInitialPageLoad) {
          // User was already signed in on page load - no modal needed
          lastKnownUserId = currentUserId;
          
        } else if (!user && userJustSignedIn) {
          // User signed out
          userJustSignedIn = false;
          awaitingInitialSync = false;
          lastKnownUserId = null;
          hideSyncModal();
        }
        
        // Mark initial page load as complete after first auth state change
        if (isInitialPageLoad) {
          isInitialPageLoad = false;
        }
      });
      
    } catch (error) {
      console.warn('Firebase auth setup error:', error.message);
      setTimeout(setupAuthListener, 500);
    }
  }
  
  // Check if sync has completed by monitoring localStorage changes
  function checkForSyncCompletion() {
    if (!awaitingInitialSync) return;
    
    let changeCount = 0;
    const maxWaitTime = 8000; // 8 seconds max wait
    const startTime = Date.now();
    
    // Monitor localStorage for sync-related changes
    const originalSetItem = localStorage.setItem;
    
    function monitorChanges(key, value) {
      // Count meaningful changes (not just auth tokens or UI state)
      if (key && !key.includes('firebase:') && !key.includes('Auth') &&
          !key.includes('Welcome') && !key.includes('theme')) {
        changeCount++;

        // If we've seen some changes, consider sync complete
        if (changeCount >= 1) {
          completeSyncProcess();
        }
      }
    }
    
    // Override setItem temporarily
    localStorage.setItem = function(key, value) {
      originalSetItem.call(this, key, value);
      monitorChanges(key, value);
    };
    
    // Also listen for custom sync events if available
    window.addEventListener('localStorageSync', (event) => {
      if (event.detail && event.detail.key) {
        monitorChanges(event.detail.key, event.detail.value);
      }
    });
    
    // Timeout fallback
    setTimeout(() => {
      if (awaitingInitialSync) {
        completeSyncProcess();
      }
    }, maxWaitTime);

    function completeSyncProcess() {
      if (!awaitingInitialSync) return;

      awaitingInitialSync = false;
      syncCompleted = true;

      // Restore original setItem
      localStorage.setItem = originalSetItem;
      
      // Show completion message briefly, then refresh
      if (window.SyncLoadingModal) {
        window.SyncLoadingModal.updateMessage('Sync Complete!', 'Refreshing page...');
        
        setTimeout(() => {
          hideSyncModal();
          // Mark that we're about to refresh due to sync completion
          sessionStorage.setItem(SYNC_REFRESH_KEY, 'true');
          // Refresh the page to show synced data
          window.location.reload();
        }, 1000);
      }
    }
  }
  
  // Initialize when DOM is ready, but wait a bit for Firebase to load
  function delayedInitialization() {
    // Give Firebase scripts time to load and initialize
    setTimeout(() => {
      setupAuthListener();
    }, 1000);
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', delayedInitialization);
  } else {
    delayedInitialization();
  }
  
  // Global API for manual control
  window.SyncModalIntegration = {
    showModal: showSyncModal,
    hideModal: hideSyncModal,
    isAwaitingSync: () => awaitingInitialSync,
    markSyncComplete: () => {
      if (awaitingInitialSync) {
        awaitingInitialSync = false;
        hideSyncModal();
        setTimeout(() => window.location.reload(), 500);
      }
    }
  };
  
})();