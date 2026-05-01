// Immediate sync system — installs a synchronous localStorage override
// before any other script runs so writes that happen during the boot
// window (before storage-sync-robust.js finishes loading) are captured
// and queued for the real sync layer.
//
// The robust manager actually checks for `window.immediateDebug` and,
// when found, takes the "useImmediateOverride" branch INSTEAD of
// installing its own override. That means *this* module is the only
// localStorage override on the page; all writes go:
//
//     localStorage.setItem
//        → THIS override (customA)
//             → native setter (so the value lands in storage)
//             → window.syncManager.processChange(key, value)
//                  (set up by storage-sync-robust → notifyLocalChange
//                   → queueWrite → debounced Firestore flush)
//
// Pre-handoff (before syncSystemReady), the syncManager doesn't exist
// yet, so we buffer writes in `pendingChanges` and replay them on
// handoff. After handoff, every write must continue to forward to
// processChange — otherwise Firestore never sees subsequent writes
// and a refresh pulls stale remote state down on top of local changes.

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

  // Forward a write to the robust sync layer if it's listening, swallowing
  // any error so a failing forward never breaks the actual localStorage
  // write that just succeeded.
  function forward(key, value) {
    const sm = window.syncManager;
    if (sm && typeof sm.processChange === 'function') {
      try { sm.processChange(key, value); }
      catch (e) { console.error('sync forward failed for', key, e); }
    }
  }

  localStorage.setItem = function (key, value) {
    originalSetItem.call(this, key, value);
    if (handedOff) {
      // Post-handoff: this override is the only one on the page. Forward
      // every write to the robust layer so Firestore stays in sync.
      forward(key, value);
      return;
    }
    // Pre-handoff: buffer; replay on syncSystemReady.
    pendingChanges.set(key, { action: 'set', value, timestamp: Date.now() });
  };

  localStorage.removeItem = function (key) {
    originalRemoveItem.call(this, key);
    if (handedOff) {
      forward(key, null);
      return;
    }
    pendingChanges.set(key, { action: 'remove', value: null, timestamp: Date.now() });
  };

  window.addEventListener('syncSystemReady', function onReady() {
    log('✅ Sync system ready — replaying buffered writes and switching to forward mode');

    // Replay anything that landed before the handoff so the robust layer
    // sees those writes too.
    for (const [key, change] of pendingChanges) {
      forward(key, change.action === 'set' ? change.value : null);
    }
    pendingChanges.clear();

    // Flip last so any forward() above takes the pre-handoff path's
    // buffered behavior (we already drained pendingChanges, so the
    // distinction doesn't matter, but the order is intentional).
    handedOff = true;
  }, { once: true });

  // Debug utilities — kept for back-compat with the dev console.
  window.immediateDebug = {
    getPendingChanges() { return Array.from(pendingChanges.entries()); },
    isHandedOff() { return handedOff; },
  };

  log('✅ Immediate localStorage override installed');
})();
