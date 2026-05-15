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
  
  // Listen for Firebase auth state changes via the modular adapter
  // exposed by firebase-config.js. The compat SDK and `window.firebase`
  // are gone (they caused the mobile `__iframefcb` race); this path
  // now waits on the `firebaseAuthReady` event or polls the global.
  function setupAuthListener() {
    if (!window.firebaseAuth?.onAuthStateChange) {
      window.addEventListener('firebaseAuthReady', setupAuthListener, { once: true });
      // Also poll as a safety net in case the event fired before this
      // script was registered. Bounded by the auth-ready resolve so it
      // doesn't loop forever.
      setTimeout(() => {
        if (window.firebaseAuth?.onAuthStateChange) setupAuthListener();
      }, 500);
      return;
    }

    window.firebaseAuth.onAuthStateChange((user) => {
      const currentUserId = user ? user.uid : null;

      if (user && currentUserId !== lastKnownUserId && !isInitialPageLoad) {
        const lastModalTime = sessionStorage.getItem('lastSyncModalTime');
        const now = Date.now();

        if (!lastModalTime || (now - parseInt(lastModalTime)) > 30000) {
          userJustSignedIn = true;
          awaitingInitialSync = true;
          syncCompleted = false;
          lastKnownUserId = currentUserId;
          sessionStorage.setItem('lastSyncModalTime', now.toString());

          showSyncModal();
          checkForSyncCompletion();
        } else {
          lastKnownUserId = currentUserId;
        }
      } else if (user && isInitialPageLoad) {
        lastKnownUserId = currentUserId;
      } else if (!user && userJustSignedIn) {
        userJustSignedIn = false;
        awaitingInitialSync = false;
        lastKnownUserId = null;
        tearDownSyncWatch();
        hideSyncModal();
      }

      if (isInitialPageLoad) {
        isInitialPageLoad = false;
      }
    });
  }
  
  // Single owner of the in-flight sync watch. Holding it on the IIFE
  // scope (not inside checkForSyncCompletion) lets every exit path —
  // first-change, timeout, sign-out, manual mark-complete — share one
  // teardown so we never leak the setItem override or the
  // localStorageSync listener across sign-in cycles.
  let activeSyncWatch = null;

  function tearDownSyncWatch() {
    const watch = activeSyncWatch;
    if (!watch) return;
    activeSyncWatch = null;

    // Restore setItem only if no other code has wrapped it in the
    // meantime; otherwise leave the chain intact so we don't clobber a
    // newer override.
    if (watch.installedSetItem && localStorage.setItem === watch.installedSetItem) {
      localStorage.setItem = watch.originalSetItem;
    }
    window.removeEventListener('localStorageSync', watch.eventListener);
    if (watch.timeoutId) clearTimeout(watch.timeoutId);
  }

  // Check if sync has completed by monitoring localStorage changes
  function checkForSyncCompletion() {
    if (!awaitingInitialSync) return;
    if (activeSyncWatch) tearDownSyncWatch();

    const maxWaitTime = 8000; // 8 seconds max wait
    let changeCount = 0;

    const watch = {
      originalSetItem: localStorage.setItem,
      installedSetItem: null,
      eventListener: null,
      timeoutId: null
    };

    function monitorChanges(key) {
      if (!awaitingInitialSync) return;
      if (key && !key.includes('firebase:') && !key.includes('Auth') &&
          !key.includes('Welcome') && !key.includes('theme')) {
        changeCount++;
        if (changeCount >= 1) completeSyncProcess();
      }
    }

    watch.installedSetItem = function(key, value) {
      watch.originalSetItem.call(this, key, value);
      try { monitorChanges(key); } catch (_) { /* never break the write */ }
    };
    localStorage.setItem = watch.installedSetItem;

    watch.eventListener = (event) => {
      if (event.detail && event.detail.key) monitorChanges(event.detail.key);
    };
    window.addEventListener('localStorageSync', watch.eventListener);

    watch.timeoutId = setTimeout(() => {
      if (awaitingInitialSync) completeSyncProcess();
    }, maxWaitTime);

    activeSyncWatch = watch;

    function completeSyncProcess() {
      if (!awaitingInitialSync) return;

      awaitingInitialSync = false;
      syncCompleted = true;
      tearDownSyncWatch();

      if (window.SyncLoadingModal) {
        window.SyncLoadingModal.updateMessage('Sync Complete!', 'Refreshing page...');

        setTimeout(() => {
          hideSyncModal();
          sessionStorage.setItem(SYNC_REFRESH_KEY, 'true');
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
        tearDownSyncWatch();
        hideSyncModal();
        setTimeout(() => window.location.reload(), 500);
      }
    }
  };
  
})();