'use strict';

// MapTap Rivals - pure helpers for the opt-in rival network.
//
// The network connects two MapTap Rivals users through three Firestore
// collections: handle claims (maptapRivalsHandles), published profiles
// (maptapRivalsNetwork) and pair links (maptapRivalsLinks). Everything that
// can be decided without Firebase lives here so it can be unit-tested in
// node: doc-id shaping, the published payload, the auto-add merge, and the
// discovery list.
//
// Exposed as `window.MapTapNetwork` in the browser AND `module.exports` for
// the node test runner, exactly like js/stats.js. app.js binds these names at
// the top of its IIFE, so call sites there read as bare function names.
(function (root) {

  // Published strings are capped so a buggy or hostile client can't push a
  // wall of text into a doc that every connected member reads back.
  const MAX_NAME_LEN = 40;
  const MAX_HANDLE_LEN = 64;
  const MAX_ICON_LEN = 8;
  const MAX_PUBLISHED_RIVALS = 60;

  // Same canonicalization as app.js normalizeMapTapUsername: accept a full
  // maptap.gg profile URL or a bare handle, strip a leading @. Deliberately
  // duplicated instead of imported so this module has zero dependencies; the
  // two must stay in step.
  function normalizeHandle(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    if (!s) return '';
    const m = s.match(/maptap\.gg\/u\/([^/?#\s]+)/i);
    return (m ? m[1] : s).replace(/^@/, '').trim().slice(0, MAX_HANDLE_LEN);
  }

  function clampText(raw, max) {
    if (raw == null) return '';
    return String(raw).trim().slice(0, max);
  }

  // Canonical doc-id form of a handle: normalized, lowercased. Returns '' for
  // anything that cannot be a Firestore document id (slashes, the reserved
  // "." / ".." ids), which callers treat the same as "no handle".
  function handleKey(raw) {
    const h = normalizeHandle(raw).toLowerCase();
    if (!h) return '';
    if (h.indexOf('/') !== -1 || h.indexOf('\\') !== -1) return '';
    if (h === '.' || h === '..') return '';
    return h;
  }

  // Doc id for a connected pair: the two uids sorted lexicographically and
  // joined by '__', so both sides derive the same key without coordinating
  // (the Arena triviaH2H pattern). Null when the pair is not a real pair.
  function pairKey(uidA, uidB) {
    const a = uidA == null ? '' : String(uidA).trim();
    const b = uidB == null ? '' : String(uidB).trim();
    if (!a || !b || a === b) return null;
    return a < b ? a + '__' + b : b + '__' + a;
  }

  // Payload for maptapRivalsNetwork/{uid}: who I am plus the handles of the
  // rivals I track, which is what powers discovery on the other side. Local
  // ids, colors, scores and games are never included. Rivals without a handle
  // are dropped (nothing to discover), duplicates collapse by handleKey, and
  // my own handle can never appear in my own rival list.
  //
  // Doubles as the read-side sanitizer for a peer's doc: it accepts either
  // `handle` or `maptapUsername` on each rival and caps every string.
  // `updatedAt` is added by the caller at write time (serverTimestamp) so this
  // stays pure. Returns null when there is no usable handle.
  function buildNetworkDoc(me) {
    if (!me) return null;
    const handle = normalizeHandle(me.handle);
    const selfKey = handleKey(handle);
    if (!selfKey) return null;

    const seen = new Set([selfKey]);
    const rivals = [];
    const src = Array.isArray(me.rivals) ? me.rivals : [];
    for (const r of src) {
      if (!r) continue;
      const h = normalizeHandle(r.handle != null ? r.handle : r.maptapUsername);
      const k = handleKey(h);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      rivals.push({
        handle: h,
        name: clampText(r.name, MAX_NAME_LEN) || h,
        icon: clampText(r.icon, MAX_ICON_LEN),
      });
      if (rivals.length >= MAX_PUBLISHED_RIVALS) break;
    }

    return {
      handle,
      name: clampText(me.name, MAX_NAME_LEN) || handle,
      icon: clampText(me.icon, MAX_ICON_LEN),
      rivals,
    };
  }

  // Reconcile the pair links Firestore returned for my uid against my local
  // rival list.
  //
  //   toAdd          - peers with no local rival for their handle, as rival
  //                    drafts ready to be materialized locally.
  //   linkedRivalIds - Map<localRivalId, pairKey> for the rivals that are
  //                    already connected (drives the Connected indicator).
  //
  // Matching is by handleKey of the local rival's maptapUsername, which is
  // what makes auto-add idempotent: once a draft is materialized the same
  // link resolves to an existing rival on every later pass. `options
  // .skipPairKeys` additionally suppresses pairs that were already
  // materialized once, so deleting an auto-added rival doesn't resurrect it
  // on the next load.
  function mergeIncomingLinks(localRivals, links, myUid, directoryByUid, options) {
    const out = { toAdd: [], linkedRivalIds: new Map() };
    const me = myUid == null ? '' : String(myUid).trim();
    if (!me) return out;

    const skip = new Set((options && options.skipPairKeys) || []);
    const byHandle = new Map();
    for (const r of (Array.isArray(localRivals) ? localRivals : [])) {
      if (!r) continue;
      const k = handleKey(r.maptapUsername != null ? r.maptapUsername : r.handle);
      if (k && !byHandle.has(k)) byHandle.set(k, r);
    }

    const dir = directoryByUid || {};
    const queued = new Set();
    for (const link of (Array.isArray(links) ? links : [])) {
      if (!link) continue;
      const uids = Array.isArray(link.uids) ? link.uids : [];
      if (uids.indexOf(me) === -1) continue;
      const peerUid = uids.find(u => u && u !== me);
      if (!peerUid) continue;
      const key = link.pairKey || pairKey(me, peerUid);
      if (!key) continue;

      const entry = dir[peerUid] || {};
      const handles = link.handles || {};
      const names = link.names || {};
      const handle = normalizeHandle(entry.handle || handles[peerUid]);
      const hk = handleKey(handle);
      if (!hk) continue;

      const existing = byHandle.get(hk);
      if (existing) {
        out.linkedRivalIds.set(existing.id, key);
        continue;
      }
      if (skip.has(key) || queued.has(hk)) continue;
      queued.add(hk);
      out.toAdd.push({
        pairKey: key,
        peerUid,
        handle,
        name: clampText(entry.name || names[peerUid], MAX_NAME_LEN) || handle,
        icon: clampText(entry.icon, MAX_ICON_LEN),
      });
    }
    return out;
  }

  // The "Their rivals" list for a connected peer: their published rivals
  // minus me, minus handles already in my own rival list, deduped, order
  // preserved so the peer's list reads the way they built it.
  function buildDiscoveryList(theirPublishedRivals, myHandle, myRivals) {
    const mine = new Set();
    const myKey = handleKey(myHandle);
    if (myKey) mine.add(myKey);
    for (const r of (Array.isArray(myRivals) ? myRivals : [])) {
      if (!r) continue;
      const k = handleKey(r.maptapUsername != null ? r.maptapUsername : r.handle);
      if (k) mine.add(k);
    }

    const seen = new Set();
    const out = [];
    for (const p of (Array.isArray(theirPublishedRivals) ? theirPublishedRivals : [])) {
      if (!p) continue;
      const handle = normalizeHandle(p.handle != null ? p.handle : p.maptapUsername);
      const k = handleKey(handle);
      if (!k || mine.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push({
        handle,
        name: clampText(p.name, MAX_NAME_LEN) || handle,
        icon: clampText(p.icon, MAX_ICON_LEN),
      });
    }
    return out;
  }

  const api = {
    // limits
    MAX_NAME_LEN, MAX_HANDLE_LEN, MAX_ICON_LEN, MAX_PUBLISHED_RIVALS,
    // identity
    normalizeHandle, handleKey, pairKey,
    // payloads
    buildNetworkDoc, mergeIncomingLinks, buildDiscoveryList,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.MapTapNetwork = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
