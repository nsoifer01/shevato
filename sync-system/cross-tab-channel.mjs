// Cross-tab signal layer.
//
// Belt-and-suspenders on top of Firestore's onSnapshot listeners and
// Firebase Auth's IndexedDB-backed cross-tab state. We use this for two
// things:
//
//   1. Auth: when one tab signs in/out, every other tab on the same
//      origin gets an immediate hint to re-check `auth.currentUser`.
//      Firebase eventually propagates this via IndexedDB, but the
//      timing is opaque and on mobile it can take several seconds.
//      A BroadcastChannel post is synchronous between same-origin tabs.
//
//   2. Data: when a sync namespace commits a remote write, the writing
//      tab posts a 'data' message so peer tabs can re-render even if
//      their onSnapshot listener happens to be in a reconnect window
//      (which can stretch out to ~20s on a sleeping tab).
//
// Failure mode: if BroadcastChannel isn't available (older Safari,
// some embedded webviews, JSDOM without a polyfill), we degrade to a
// no-op channel. Sync still works — onSnapshot still does its job —
// we just lose the secondary signal. Callers do not need to check.
//
// This module has no Firebase imports on purpose so it is trivially
// importable from Node tests (the Node 15+ runtime ships a global
// BroadcastChannel; tests that want isolation can pass a fake via the
// `factory` option).

const DEFAULT_CHANNEL_NAME = 'shevato-sync';

/**
 * Create a small wrapper around a BroadcastChannel keyed to this tab.
 *
 * @param {object} [opts]
 * @param {string} [opts.name]      Channel name (defaults to 'shevato-sync').
 * @param {Function} [opts.factory] Optional `(name) => BroadcastChannel`-like
 *                                  factory. Used by tests. When omitted we
 *                                  use the global BroadcastChannel if it
 *                                  exists; otherwise we return a no-op.
 * @returns {{
 *   publish: (type: string, payload?: object) => void,
 *   subscribe: (type: string | '*', listener: (msg: object) => void) => () => void,
 *   close: () => void,
 *   tabId: string,
 *   isLive: boolean
 * }}
 */
export function createCrossTabChannel(opts = {}) {
  const name = opts.name || DEFAULT_CHANNEL_NAME;
  const factory = opts.factory
    || (typeof BroadcastChannel === 'function' ? (n) => new BroadcastChannel(n) : null);

  const tabId = generateTabId();
  const listeners = new Map(); // type -> Set<listener>

  if (!factory) {
    // No BroadcastChannel — return a no-op wrapper. Sync still works via
    // onSnapshot; we just lose the secondary signal.
    return {
      publish() {},
      subscribe() { return () => {}; },
      close() {},
      tabId,
      isLive: false
    };
  }

  let channel;
  try {
    channel = factory(name);
  } catch (err) {
    // BroadcastChannel can throw in some sandboxed environments
    // (chrome-extension://, file://). Degrade to no-op.
    return {
      publish() {},
      subscribe() { return () => {}; },
      close() {},
      tabId,
      isLive: false
    };
  }

  channel.onmessage = (event) => {
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    // Ignore our own posts. BroadcastChannel by spec doesn't echo back,
    // but defence-in-depth in case a polyfill behaves differently.
    if (data.from === tabId) return;
    dispatch(data.type, data);
    dispatch('*', data);
  };

  function dispatch(type, msg) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(msg); }
      catch (err) { /* listener errors must not break the bus */
        // eslint-disable-next-line no-console
        console.error('cross-tab listener error:', err);
      }
    }
  }

  return {
    tabId,
    isLive: true,
    publish(type, payload = {}) {
      const message = {
        type: String(type),
        from: tabId,
        at: Date.now(),
        ...payload
      };
      try { channel.postMessage(message); }
      catch (err) {
        // Channel can throw if the doc is being unloaded; nothing to do.
      }
    },
    subscribe(type, listener) {
      if (typeof listener !== 'function') return () => {};
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return () => {
        const s = listeners.get(type);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) listeners.delete(type);
      };
    },
    close() {
      listeners.clear();
      try { channel.close(); } catch (_) { /* ignore */ }
    }
  };
}

/**
 * Tab-unique identifier. Used so a tab can ignore its own broadcasts
 * (BroadcastChannel per spec doesn't echo, but a polyfill might).
 * Prefers `crypto.randomUUID()`; falls back to a Math.random hex so
 * older browsers still work.
 */
function generateTabId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_) { /* fall through */ }
  return 't_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Message types we use. Exported so consumers don't stringly-type
 * them at call sites.
 */
export const CHANNEL_MESSAGE_TYPES = Object.freeze({
  AUTH_CHANGED: 'auth-changed',
  DATA_UPDATED: 'data-updated',
  PING: 'ping'
});
