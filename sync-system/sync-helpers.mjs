// Pure helpers used by storage-sync-robust.js.
//
// Extracted into a standalone module so they can be unit-tested without
// loading the Firebase SDK (the SDK imports from `https://www.gstatic.com/…`,
// which Node's loader can't resolve). Every function here is referentially
// transparent — no this-binding, no Firebase types, no globals.

/**
 * Compact deterministic hash of a JSON-serialisable value. Used by
 * `queueWrite` to drop no-op writes and by `applyRemoteChange` to
 * short-circuit when Firestore re-emits the same document body on
 * listener re-attach.
 *
 * Must hash EVERY input byte AND ignore object key ordering.
 *
 * Previous bug 1: truncating `btoa(jsonString)` to 16 chars only encoded
 * the first 12 bytes, so any value living past byte 12 of the JSON could
 * not change the hash. Fixed by switching to 32-bit djb2 over all bytes.
 *
 * Previous bug 2 (this one): even with full-byte djb2, `JSON.stringify`
 * preserves the in-memory key order of objects, and Firestore's Map
 * deserialisation returns keys in a different order than the writer used.
 * So after a remote delivery, the receiver's local object had a different
 * key ordering than what its own `saveX()` would produce, the resulting
 * JSON differed byte-for-byte, the hash differed, `queueWrite` did not
 * recognise the writeback as a no-op, and every app that re-saved on the
 * remote-update path (gym tracker's `updateAchievements`, football's
 * `updatePlayerNames`) entered a per-RTT ping-pong loop. Fixed by
 * sorting keys recursively before serialising — the hash becomes a
 * property of the value's *content*, not its memory layout.
 *
 * @param {*} value
 * @returns {string} hex hash, up to 8 chars
 */
export function hashValue(value) {
  if (value === null || value === undefined) return 'null';

  const jsonString = canonicalStringify(value);

  let hash = 5381;
  for (let i = 0; i < jsonString.length; i++) {
    hash = (((hash << 5) + hash) + jsonString.charCodeAt(i)) | 0;
  }
  // >>> 0 forces unsigned 32-bit so toString(16) never includes a sign.
  return (hash >>> 0).toString(16);
}

/**
 * `JSON.stringify` with object keys sorted alphabetically at every depth.
 * Arrays preserve order (semantic). `undefined` values and functions drop
 * just like the built-in stringify. Non-finite numbers (`NaN`, `±Infinity`)
 * become `null` to stay JSON-valid.
 */
function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return 'null'; // function / undefined / symbol

  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      const v = value[i];
      out += v === undefined ? 'null' : canonicalStringify(v);
    }
    return out + ']';
  }

  const keys = Object.keys(value).sort();
  let out = '{';
  let first = true;
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue; // match JSON.stringify behaviour for objects
    if (!first) out += ',';
    first = false;
    out += JSON.stringify(k) + ':' + canonicalStringify(v);
  }
  return out + '}';
}

/**
 * Best-effort parse: returns the parsed JSON value or the original string
 * if parsing fails. null/undefined pass through.
 *
 * @param {*} value
 * @returns {*}
 */
export function parseValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { return value; }
}

/**
 * Convert a Firebase timestamp (Firestore Timestamp, RTDB number,
 * or a plain epoch number) to milliseconds-since-epoch.
 *
 * @param {*} timestamp
 * @returns {number}
 */
export function getTimestamp(timestamp) {
  if (!timestamp) return 0;
  if (typeof timestamp === 'number') return timestamp;
  if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
  if (typeof timestamp.seconds === 'number') return timestamp.seconds * 1000;
  return 0;
}

/**
 * Strip `undefined` values from a payload so Firestore accepts it.
 * Primitives pass through; objects/arrays go through a JSON round-trip
 * which drops undefined fields.
 *
 * @param {*} value
 * @returns {*}
 */
export function sanitiseForFirestore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Cheap upper-bound estimate of a payload's serialised size, used by
 * the 700 KB flush guard. Firestore sentinels (serverTimestamp,
 * deleteField) are not JSON-serialisable; we substitute a fixed stand-in
 * before measuring so JSON.stringify doesn't throw.
 *
 * @param {*} payload
 * @returns {number}
 */
export function estimatePayloadBytes(payload) {
  try {
    const probe = JSON.stringify(payload, (_, v) => {
      if (
        v
        && typeof v === 'object'
        && typeof v.toJSON !== 'function'
        && v.constructor
        && v.constructor.name
        && v.constructor.name.includes('FieldValue')
      ) {
        return '__SENTINEL__';
      }
      return v;
    });
    return probe ? probe.length : 0;
  } catch {
    return 0;
  }
}

/**
 * True iff the existing key set matches the incoming list exactly.
 * Used by `_startSyncForUser` to short-circuit when an auth-state
 * change re-invokes initAppSync with the same namespace+keys.
 *
 * @param {Set<string>} existingSet
 * @param {string[]} incomingKeys
 * @returns {boolean}
 */
export function sameKeySet(existingSet, incomingKeys) {
  if (existingSet.size !== incomingKeys.length) return false;
  for (const k of incomingKeys) if (!existingSet.has(k)) return false;
  return true;
}

/**
 * Decide whether a remote document fragment should overwrite the local
 * copy. Returns one of:
 *
 *   - 'skip-stale':    remote timestamp is at or before the last remote
 *                      we already processed; ignore.
 *   - 'skip-deduped':  remote body is byte-identical to our local copy
 *                      (Firestore re-emits on listener re-attach).
 *   - 'skip-older':    local is newer than remote.
 *   - 'apply':         remote should be written into localStorage.
 *
 * Local-wins on equal timestamps with lower remote rev; tie at same
 * rev and timestamp resolves to skip-older (defensive: identical
 * content has the same hash and would have been deduped already).
 *
 * @param {{rev?: number, updatedAt?: number, hash?: string} | undefined} localRev
 * @param {{rev?: number, updatedAt?: any, hash?: string, value?: any}} remoteInfo
 * @param {number} lastRemoteUpdate ms-epoch of the most recent remote we processed.
 * @returns {'skip-stale'|'skip-deduped'|'skip-older'|'apply'}
 */
export function decideRemoteChange(localRev, remoteInfo, lastRemoteUpdate) {
  const remoteTimestamp = getTimestamp(remoteInfo?.updatedAt);

  if (remoteTimestamp <= (lastRemoteUpdate || 0)) return 'skip-stale';

  if (localRev && remoteInfo?.hash && remoteInfo.hash === localRev.hash) {
    return 'skip-deduped';
  }

  if (!localRev) return 'apply';

  if (remoteTimestamp < localRev.updatedAt) return 'skip-older';
  if (remoteTimestamp > localRev.updatedAt) return 'apply';

  // Equal timestamps — compare revisions.
  if ((remoteInfo?.rev || 0) > (localRev.rev || 0)) return 'apply';
  return 'skip-older';
}
