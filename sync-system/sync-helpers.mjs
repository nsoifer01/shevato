// Pure helpers used by storage-sync-robust.js.
//
// Extracted into a standalone module so they can be unit-tested without
// loading the Firebase SDK (the SDK imports from `https://www.gstatic.com/…`,
// which Node's loader can't resolve). Every function here is referentially
// transparent — no this-binding, no Firebase types, no globals.

/**
 * Compact deterministic hash of a JSON-serialisable value. Used to
 * short-circuit `applyRemoteChange` when Firestore re-emits the same
 * document body on listener re-attach.
 *
 * Two implementations: btoa for Latin1 strings (fast), and a
 * 32-bit djb2-ish hash for anything containing characters outside
 * Latin1 (emoji, non-ASCII). The exact algorithm doesn't matter
 * provided it's deterministic across reloads.
 *
 * @param {*} value
 * @returns {string} 16-char hash
 */
export function hashValue(value) {
  if (value === null || value === undefined) return 'null';

  const jsonString = JSON.stringify(value);

  try {
    // btoa rejects characters > U+00FF; we catch and fall through.
    if (typeof btoa === 'function') {
      return btoa(jsonString).slice(0, 16);
    }
    // Node has Buffer; equivalent base64 path.
    if (typeof Buffer !== 'undefined') {
      // eslint-disable-next-line no-undef
      return Buffer.from(jsonString, 'latin1').toString('base64').slice(0, 16);
    }
  } catch (_) {
    /* fall through to manual hash */
  }

  let hash = 0;
  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(16, '0').slice(0, 16);
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
