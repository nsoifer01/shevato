// Immediate sync system — buffers any localStorage writes that happen
// BEFORE the real sync layer (storage-sync-robust.js) finishes loading,
// then steps out of the way once that layer takes over.
//
// Previously this module also kept its setItem override active after the
// robust sync was installed, which meant every write fired through both
// pipelines (buffer + processChange in this file, AND the queueWrite path
// in storage-sync). That doubled the Firestore work and racing the UI.
// Now we install our override once, hand off the buffered writes when
// syncSystemReady fires, and restore the original setItem so only the
// robust sync layer is active going forward.

(function () {
  'use strict';

  // Idempotency guard — the page might import this file twice via cached
  // and uncached service-worker paths.
  if (window.__gymTrackerImmediateSyncInstalled) return;
  window.__gymTrackerImmediateSyncInstalled = true;

  const debugOn = (() => {
    try { return localStorage.getItem('gymTrackerDebug') === 'true'; } catch (_) { return false; }
  })();
  const log = (...a) => { if (debugOn) console.log(...a); };

  log('🚀 Immediate sync system loading...');

  const originalSetItem = localStorage.setItem;
  const originalRemoveItem = localStorage.removeItem;

  const pendingChanges = new Map();
  let handedOff = false;

  localStorage.setItem = function (key, value) {
    originalSetItem.call(this, key, value);
    if (handedOff) return; // robust layer's override is now in charge
    pendingChanges.set(key, { action: 'set', value, timestamp: Date.now() });
  };

  localStorage.removeItem = function (key) {
    originalRemoveItem.call(this, key);
    if (handedOff) return;
    pendingChanges.set(key, { action: 'remove', value: null, timestamp: Date.now() });
  };

  window.addEventListener('syncSystemReady', function onReady() {
    log('✅ Sync system ready — handing off to robust sync layer');

    // Step out of the way: restore the real native methods. The robust
    // sync layer captured these as its "original" when it installed its
    // own override, so writes will continue to be intercepted by it.
    localStorage.setItem = originalSetItem;
    localStorage.removeItem = originalRemoveItem;
    handedOff = true;

    // Replay anything that landed before the handoff so the robust layer
    // sees those writes too.
    if (window.syncManager && typeof window.syncManager.processChange === 'function') {
      for (const [key, change] of pendingChanges) {
        try {
          window.syncManager.processChange(key, change.action === 'set' ? change.value : null);
        } catch (e) {
          console.error('Failed to replay buffered change for', key, e);
        }
      }
    }
    pendingChanges.clear();
  }, { once: true });

  // Debug utilities — kept for back-compat with the dev console.
  window.immediateDebug = {
    getPendingChanges() { return Array.from(pendingChanges.entries()); },
    isHandedOff() { return handedOff; },
  };

  log('✅ Immediate localStorage override installed');
})();
