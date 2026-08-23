// Cross-tab coherence for app state kept in localStorage.
//
// Problem this solves (site-wide audit, 2026-08-22): every app keeps its
// state in memory and writes whole arrays/blobs back to localStorage. Two
// tabs on the same origin therefore clobber each other: the later writer
// silently drops whatever the other tab added, and a stale tab can even
// resurrect data the user deleted elsewhere. The sync engine
// (storage-sync-robust.js) listens to the native `storage` event only to
// queue cloud writes; nothing told the APP that its in-memory copy is stale.
//
// Contract:
//   ShevatoTabSync.watch(keys, handler)
//     keys    - array of localStorage key names (or a predicate fn(key))
//     handler - called once per foreign change with { key, newValue, oldValue }
//               AFTER localStorage already holds the other tab's value.
//               The handler must RE-READ storage into memory and re-render.
//               It must NEVER write to localStorage (no "floor"/default
//               writes): a write from inside the handler fires `storage` in
//               the originating tab, which then re-reads and re-renders in
//               turn, and any undo history that tab held is gone. That exact
//               loop is how Trip Planner lost the promised undo of a trip
//               delete. Writes made while a handler runs are blocked and
//               reported to the console.
//   ShevatoTabSync.readBeforeWrite(key, fn)
//     Helper for "read-merge-write": fn receives the CURRENT stored value
//     (parsed JSON, or null) and returns the value to store. Use it for
//     append-style writes so a tab that missed a storage event still merges
//     instead of overwriting.
//
// Classic script (no module syntax) so every app, including the ES-module
// Gym Tracker, can load it with a plain <script> before its own code. No
// dependencies; safe to load on pages that never call it.
(function () {
  'use strict';
  if (window.ShevatoTabSync) return;

  const watchers = [];
  let inHandler = 0;

  function matches(spec, key) {
    if (typeof spec === 'function') return !!spec(key);
    return Array.isArray(spec) && spec.indexOf(key) !== -1;
  }

  window.addEventListener('storage', function (e) {
    // e.key === null means localStorage.clear() in another tab.
    const key = e.key;
    if (key === null) {
      // Treat a clear as a change on every watched explicit key.
      for (const w of watchers) {
        if (Array.isArray(w.keys)) {
          for (const k of w.keys) dispatch(w, { key: k, newValue: null, oldValue: null });
        }
      }
      return;
    }
    if (e.storageArea && e.storageArea !== window.localStorage) return;
    for (const w of watchers) {
      if (matches(w.keys, key)) dispatch(w, { key: key, newValue: e.newValue, oldValue: e.oldValue });
    }
  });

  function dispatch(w, change) {
    reassertGuard();
    inHandler++;
    try { w.handler(change); }
    catch (err) { console.error('ShevatoTabSync handler failed for', change.key, err); }
    finally { inHandler--; }
  }

  // Block localStorage writes from inside a handler (see the contract above).
  // Installed lazily on first watch() so pages that never watch keep the
  // pristine Storage prototype.
  //
  // Two layers on purpose. storage-sync-robust.js installs its own OWN-property
  // `localStorage.setItem` when cloud sync starts, and an own property shadows
  // the prototype. Whichever of us installs first, the guard has to survive:
  //   - we install first  -> sync's `originalMethods.setItem.bind()` captures
  //     our guarded prototype method, so writes still route through us;
  //   - sync installs first -> the prototype patch alone would be dead, so
  //     reassertGuard() wraps the own property too.
  // reassertGuard() re-checks on every watch() and at the top of every
  // dispatch, which covers sync starting later (it starts on sign-in, long
  // after an app's init calls watch()).
  let protoGuarded = false;
  const wrapped = new WeakSet();

  function refuse(op, key) {
    console.error('ShevatoTabSync: refused localStorage.' + op + '(' + key + ') from inside a storage handler (would clobber the other tab)');
  }

  function guardFn(orig, op) {
    const fn = function (key, value) {
      if (inHandler > 0) { refuse(op, key); return; }
      return orig.call(this, key, value);
    };
    wrapped.add(fn);
    return fn;
  }

  function reassertGuard() {
    const ls = window.localStorage;
    if (!protoGuarded) {
      protoGuarded = true;
      const proto = Object.getPrototypeOf(ls);
      proto.setItem = guardFn(proto.setItem, 'setItem');
      proto.removeItem = guardFn(proto.removeItem, 'removeItem');
    }
    // Own properties (another layer's override) shadow the prototype: wrap
    // them too, once each.
    for (const op of ['setItem', 'removeItem']) {
      if (!Object.prototype.hasOwnProperty.call(ls, op)) continue;
      const own = ls[op];
      if (typeof own !== 'function' || wrapped.has(own)) continue;
      try { ls[op] = guardFn(own, op); } catch (_) { /* frozen storage */ }
    }
  }

  window.ShevatoTabSync = {
    watch: function (keys, handler) {
      if (typeof handler !== 'function') throw new TypeError('ShevatoTabSync.watch needs a handler');
      reassertGuard();
      const w = { keys: keys, handler: handler };
      watchers.push(w);
      return function unwatch() {
        const i = watchers.indexOf(w);
        if (i !== -1) watchers.splice(i, 1);
      };
    },
    readBeforeWrite: function (key, fn) {
      let current = null;
      try { const raw = localStorage.getItem(key); current = raw == null ? null : JSON.parse(raw); }
      catch (_) { current = null; }
      const next = fn(current);
      localStorage.setItem(key, JSON.stringify(next));
      return next;
    },
    // True while a foreign-change handler is running; apps can use it to
    // skip their own "ensure defaults" writes.
    get inHandler() { return inHandler > 0; }
  };
})();
