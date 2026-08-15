// In-memory stand-in for `@netlify/blobs`, loaded ONLY when a test file has
// registered tp-assist-blobs-hooks.mjs. Not a test file itself (node --test
// ignores it: no .test. in the name).
//
// State lives on globalThis because this module is evaluated in the main
// realm, same as the test file that seeds and inspects it - the loader hook
// only redirects RESOLUTION; evaluation stays on the main thread.
//
// Implements exactly the surface the handler path uses (lib/blob-cas.mjs and
// tp-assist.mjs step 4): get(json), getWithMetadata(json + etag), and
// conditional setJSON with onlyIfNew / onlyIfMatch CAS semantics.

export function getStore(name) {
  const root = globalThis.__tpAssistBlobStub;
  if (!root) throw new Error('tp-assist blob stub: seed globalThis.__tpAssistBlobStub before calling the handler');
  if (!root.stores[name]) root.stores[name] = new Map();
  const blobs = root.stores[name];
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(key) {
      const e = blobs.get(key);
      return e ? clone(e.data) : null;
    },
    async getWithMetadata(key) {
      const e = blobs.get(key);
      return e ? { data: clone(e.data), etag: e.etag } : null;
    },
    async setJSON(key, value, cond = {}) {
      const cur = blobs.get(key);
      if (cond.onlyIfNew && cur) return { modified: false };
      if (cond.onlyIfMatch && (!cur || cur.etag !== cond.onlyIfMatch)) return { modified: false };
      blobs.set(key, { data: clone(value), etag: 'etag-' + (++root.seq) });
      return { modified: true };
    },
  };
}
