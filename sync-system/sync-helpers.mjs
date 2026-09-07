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

  // DIRTY = this device holds edits the cloud has not accepted yet, so both
  // sides have moved since they last agreed. That is a conflict, and the
  // caller resolves it by merging or by preserving the loser - never by
  // silently dropping one of them.
  if (localRev.dirty) return 'conflict';

  // Clean copy: whatever is here came FROM the cloud and has not been
  // touched since, so the only question left is which logical version is
  // later. `rev` is a Lamport counter - applyRemoteChange advances it to
  // max(local, remote) - so a higher rev is strictly later in the causal
  // order, on every device, with no clock involved.
  if ((remoteInfo?.rev || 0) < (localRev.rev || 0)) return 'skip-older';
  return 'apply';
}

/**
 * Which side of a conflict wins, when the values cannot be merged.
 *
 * DETERMINISTIC, and that is the whole requirement: both devices see the
 * same two versions and must reach the same answer, or they ping-pong
 * forever. Higher revision wins (it is later in the causal order); an exact
 * tie is broken on the content hash, which is arbitrary but identical
 * everywhere. The loser is never discarded - the caller keeps it as a
 * recoverable copy - so "wins" decides what is live, not what survives.
 *
 * @returns {'local'|'remote'}
 */
export function pickConflictWinner(localRev, remoteInfo) {
  const localRevNum = (localRev && localRev.rev) || 0;
  const remoteRevNum = (remoteInfo && remoteInfo.rev) || 0;
  if (remoteRevNum > localRevNum) return 'remote';
  if (remoteRevNum < localRevNum) return 'local';
  const localHash = String((localRev && localRev.hash) || '');
  const remoteHash = String((remoteInfo && remoteInfo.hash) || '');
  return remoteHash > localHash ? 'remote' : 'local';
}

/**
 * Re-queues the writes of a FAILED flush without clobbering newer work.
 *
 * flushWrites copies the queue and clears it before the network call, so a
 * user edit made while the flush is in flight lands in the (now empty) queue
 * as a higher revision of the same key. Blindly re-queuing the failed copy
 * replaced that newer entry with the older one, and because localRevisions
 * already records the newer hash, the newer value was never re-sent: silent
 * data loss on the next successful flush. The failed copy is therefore only
 * restored where no entry exists, or where the queued entry is OLDER (a rev
 * the failed batch itself superseded, which cannot happen today but costs
 * nothing to defend against).
 *
 * Pure so it is unit-testable outside the browser module.
 *
 * @param {Map<string, {rev?: number}>} queue live queue (mutated in place)
 * @param {Map<string, {rev?: number}>} failedWrites the batch that failed
 * @returns {number} how many entries were restored
 */
export function requeueFailedWrites(queue, failedWrites) {
  let restored = 0;
  for (const [key, value] of failedWrites) {
    const queued = queue.get(key);
    if (!queued || (queued.rev || 0) < (value.rev || 0)) {
      queue.set(key, value);
      restored++;
    }
  }
  return restored;
}

/**
 * Firestore write errors that are DETERMINISTIC: the identical batch will
 * fail the identical way however many times it is resent.
 *
 *   - `payload-too-large` is ours (the MAX_FLUSH_BYTES guard).
 *   - `invalid-argument` is Firestore rejecting the document shape itself
 *     (an unsupported value, a field path it will not accept, a document
 *     over the 1 MiB ceiling).
 *
 * Retrying either one is pure waste, and worse than waste when the app is
 * still appending to the same key between attempts: the 2026-08-31 MapTap
 * Rivals incident retried a 760 KB refusal three times and shipped ~890 KB
 * on the last one, because the rival sync kept adding games while the
 * ladder ran. `flushWrites` drops a permanently-rejected batch instead.
 *
 * Everything else (network blips, `unavailable`, `deadline-exceeded`, an
 * unrecognised code) stays on the retry ladder, which is the behaviour
 * every transient failure had before.
 *
 * @param {{code?: string, permanent?: boolean} | null | undefined} error
 * @returns {boolean}
 */
export function isPermanentWriteError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.permanent === true) return true;
  return error.code === 'payload-too-large' || error.code === 'invalid-argument';
}

/**
 * Split an already-serialised value into chunk-sized pieces.
 *
 * Never splits inside a UTF-16 surrogate pair. Firestore stores strings as
 * UTF-8, and a lone surrogate does not survive that round trip; the two
 * halves come back as replacement characters and `JSON.parse` of the
 * rejoined string then throws. Any emoji in an app's data (every one of
 * this repo's apps stores icons as emoji) sits exactly on that hazard.
 *
 * @param {string} serialised
 * @param {number} chunkChars maximum UTF-16 code units per part
 * @returns {string[]} at least one part; joining them reproduces the input
 */
export function splitIntoChunks(serialised, chunkChars) {
  const size = Math.max(1, Math.floor(chunkChars));
  const parts = [];
  let i = 0;
  while (i < serialised.length) {
    let end = Math.min(i + size, serialised.length);
    if (end < serialised.length) {
      const code = serialised.charCodeAt(end - 1);
      // High surrogate at the boundary: its low half is the next character.
      if (code >= 0xd800 && code <= 0xdbff && end - 1 > i) end -= 1;
    }
    parts.push(serialised.slice(i, end));
    i = end;
  }
  return parts.length ? parts : [''];
}

/**
 * Group measured payload entries into as few flush batches as possible
 * without any batch crossing `maxBytes`.
 *
 * A flush can carry several keys, and `uploadLocalOnlyKeys` carries every
 * key an app owns at once. Per-key chunking bounds each individual entry,
 * but nothing bounds their sum, so the batch is what actually has to fit
 * inside one Firestore commit. Splitting is safe here precisely because the
 * write is a `merge: true` of independently revisioned keys: two commits
 * land the same state as one, and a failure between them leaves the keys
 * that did land correct rather than half-applied.
 *
 * @param {Array<{key: string, entry: *, bytes: number}>} entries
 * @param {number} maxBytes
 * @returns {{batches: Array<Object<string, *>>, oversized: string[]}}
 *   `oversized` names any single entry that cannot fit in a batch on its
 *   own. The caller turns that into a permanent rejection.
 */
export function planFlushBatches(entries, maxBytes) {
  const batches = [];
  const oversized = [];
  let current = null;
  let currentBytes = 0;

  for (const { key, entry, bytes } of entries) {
    if (bytes > maxBytes) {
      oversized.push(key);
      continue;
    }
    if (!current || currentBytes + bytes > maxBytes) {
      current = {};
      currentBytes = 0;
      batches.push(current);
    }
    current[key] = entry;
    currentBytes += bytes;
  }

  return { batches, oversized };
}

/* -------------------------------------------------------------------------
 * Record-level reconciliation (2026-09-05 audit F05).
 *
 * Every app in this repo syncs whole localStorage VALUES, so two devices
 * adding two different games to `maptapRivalsGames` do not edit two records -
 * they edit one string, and last-writer-wins throws one of the two away. The
 * value is usually an array of records with a stable `id`, and that is
 * enough to do better: a three-way merge against the last state the two
 * sides agreed on tells added apart from deleted, which a two-way union
 * cannot (a union resurrects every deletion).
 *
 * The base is not the values themselves - storing a second copy of an 800 KB
 * game log would be a real cost on a 5 MB budget - but an id -> content-hash
 * index of them, which is all the merge needs and is ~18 bytes a record.
 * ---------------------------------------------------------------------- */

/**
 * An id -> hash index of a record collection, or null when the value is not
 * one. "Is one" is deliberately strict: a non-empty array whose every entry
 * is a plain object carrying a unique string/number `id`. Anything else -
 * an object, an array of primitives, records without ids, duplicate ids -
 * falls back to whole-value handling, because a merge that guessed at the
 * identity of a record would be worse than an honest conflict copy.
 *
 * @param {*} value
 * @returns {Record<string, string> | null}
 */
export function recordIndex(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  // Null prototype: record ids come from stored user data, and '__proto__'
  // as an id would otherwise write through to Object.prototype.
  const index = Object.create(null);
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const id = entry.id;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const key = String(id);
    if (!key || index[key] !== undefined) return null;   // missing or duplicate
    index[key] = hashValue(entry);
  }
  return index;
}

/**
 * Three-way merge of two record collections against the state they last
 * agreed on.
 *
 * Per id:
 *   - in both, same content            -> keep it
 *   - in both, one side matches base   -> the other side changed it, take that
 *   - in both, both changed            -> conflict; deterministic winner kept,
 *                                          and the id is reported
 *   - in one side only, NOT in base    -> that side added it, keep it
 *   - in one side only, IS in base     -> the other side deleted it, drop it
 *
 * Order is taken from the remote collection (which both devices can see),
 * with each side's own additions appended in its own order. The result is
 * therefore not byte-identical on the two devices in the same round, but it
 * IS monotone: each round the two record sets move toward their union and
 * then stop changing, at which point the hashes match and the exchange ends.
 *
 * @param {Record<string,string>|null} baseIndex id -> hash they last agreed on
 * @param {*} localValue
 * @param {*} remoteValue
 * @returns {{merged: Array, conflicts: string[]} | null} null when the shapes
 *          do not qualify for a record merge.
 */
export function mergeRecordCollections(baseIndex, localValue, remoteValue) {
  const localIndex = recordIndex(localValue);
  const remoteIndex = recordIndex(remoteValue);
  if (!localIndex || !remoteIndex) return null;

  const base = baseIndex && typeof baseIndex === 'object' ? baseIndex : Object.create(null);
  const localById = new Map(localValue.map((r) => [String(r.id), r]));
  const remoteById = new Map(remoteValue.map((r) => [String(r.id), r]));
  const conflicts = [];
  const keep = new Map();   // id -> record

  const decide = (id) => {
    const inLocal = localById.has(id);
    const inRemote = remoteById.has(id);
    const inBase = Object.prototype.hasOwnProperty.call(base, id);

    if (inLocal && inRemote) {
      const lh = localIndex[id];
      const rh = remoteIndex[id];
      if (lh === rh) return remoteById.get(id);
      const bh = inBase ? base[id] : undefined;
      if (bh !== undefined && lh === bh) return remoteById.get(id);   // remote edited
      if (bh !== undefined && rh === bh) return localById.get(id);    // local edited
      // Both edited, or no base to tell. Deterministic on the content hash
      // so both devices choose the same record.
      conflicts.push(id);
      return rh > lh ? remoteById.get(id) : localById.get(id);
    }
    if (inLocal) return inBase ? null : localById.get(id);            // deleted remotely / added locally
    return inBase ? null : remoteById.get(id);                        // deleted locally / added remotely
  };

  for (const record of remoteValue) {
    const id = String(record.id);
    const chosen = decide(id);
    if (chosen) keep.set(id, chosen);
  }
  for (const record of localValue) {
    const id = String(record.id);
    if (keep.has(id) || remoteById.has(id)) continue;
    const chosen = decide(id);
    if (chosen) keep.set(id, chosen);
  }

  return { merged: [...keep.values()], conflicts };
}
