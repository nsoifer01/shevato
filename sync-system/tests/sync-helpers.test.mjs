// Unit tests for the pure helpers used by storage-sync-robust.js.
//
// These are the algorithmic core of the sync layer — every hot-path
// decision (apply remote? dedupe? overflow?) routes through one of
// these functions. We test them directly because the storage manager
// itself imports Firebase from gstatic.com URLs that Node can't load.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashValue,
  parseValue,
  getTimestamp,
  sanitiseForFirestore,
  estimatePayloadBytes,
  sameKeySet,
  decideRemoteChange,
  remoteToken,
  requeueFailedWrites,
  isPermanentWriteError,
  splitIntoChunks,
  planFlushBatches,
  mapIndex,
  valueIndex,
  mergeMaps,
  mergeValues,
  normaliseBaseIndex
} from '../sync-helpers.mjs';

/* -------------------- hashValue -------------------- */

test('hashValue: null and undefined collapse to the sentinel string', () => {
    assert.equal(hashValue(null), 'null');
    assert.equal(hashValue(undefined), 'null');
});

test('hashValue: identical inputs produce identical hashes', () => {
    const a = hashValue({ score: 12, name: 'Alice' });
    const b = hashValue({ score: 12, name: 'Alice' });
    assert.equal(a, b);
});

test('hashValue: different inputs produce different hashes', () => {
    assert.notEqual(hashValue({ score: 12 }), hashValue({ score: 13 }));
    assert.notEqual(hashValue('a'), hashValue('b'));
});

test('hashValue: handles Unicode payloads without throwing', () => {
    // The btoa fast-path rejects characters > U+00FF; this exercises the
    // fall-through hash path that needed to exist to keep emoji-containing
    // player names from blowing up the sync write queue.
    const out = hashValue({ name: '🎮 Player', tag: 'שלום' });
    assert.equal(typeof out, 'string');
    assert.ok(out.length <= 16);
});

test('hashValue: produces stable output length cap of 16 chars', () => {
    const big = { a: 'x'.repeat(10_000) };
    const h = hashValue(big);
    assert.ok(h.length <= 16);
});

// Regression: the previous btoa(...).slice(0,16) implementation only
// reflected the first 12 bytes of the JSON, so any field whose value
// lived past byte 12 (e.g. player1 in {"player1":"X","player2":...})
// produced the same hash regardless of value. queueWrite then dropped
// every subsequent name change as a no-op, silently breaking
// cross-browser sync for mario-kart and football-h2h.
test('hashValue: distinguishes values past byte 12 of the JSON', () => {
    const a = { player1: 'Alice', player2: 'M', player3: 'N', player4: 'P4' };
    const b = { player1: 'Bob',   player2: 'M', player3: 'N', player4: 'P4' };
    assert.notEqual(hashValue(a), hashValue(b));
});

// Same regression, string form — queueWrite hashes the raw setItem
// string, where the same byte-12 bug also bit because JSON.stringify
// of a string adds a leading quote and pushes the value even further
// out.
test('hashValue: distinguishes values past byte 12 in the string-JSON form', () => {
    const a = '{"player1":"Alice","player2":"M","player3":"N","player4":"P4"}';
    const b = '{"player1":"Bob","player2":"M","player3":"N","player4":"P4"}';
    assert.notEqual(hashValue(a), hashValue(b));
});

// Regression: Firestore returns Map fields with keys in a different order
// than the writer inserted them. If hashValue cared about key order, every
// `app.refreshFromStorage()` writeback after a remote delivery would hash
// differently from the just-stored value, queueWrite would not dedupe it,
// and the apps re-saved on remote-update (gym tracker's updateAchievements,
// football's updatePlayerNames) entered a per-RTT ping-pong loop.
test('hashValue: same content with different key order hashes the same', () => {
    const a = { player1: 'Alice', player2: 'Bob' };
    const b = { player2: 'Bob',   player1: 'Alice' };
    assert.equal(hashValue(a), hashValue(b));
});

test('hashValue: nested key reorderings also collapse to the same hash', () => {
    const a = { games: [{ id: 1, score: 5 }, { id: 2, score: 3 }] };
    const b = { games: [{ score: 5, id: 1 }, { score: 3, id: 2 }] };
    assert.equal(hashValue(a), hashValue(b));
});

// Arrays are semantic ordering — must NOT be sorted away.
test('hashValue: array order is preserved (not sorted)', () => {
    assert.notEqual(hashValue([1, 2, 3]), hashValue([3, 2, 1]));
});

/* -------------------- parseValue -------------------- */

test('parseValue: null and undefined return null', () => {
    assert.equal(parseValue(null), null);
    assert.equal(parseValue(undefined), null);
});

test('parseValue: valid JSON strings are parsed', () => {
    assert.deepEqual(parseValue('{"a":1}'), { a: 1 });
    assert.deepEqual(parseValue('[1,2,3]'), [1, 2, 3]);
});

test('parseValue: non-JSON strings pass through unchanged', () => {
    assert.equal(parseValue('hello'), 'hello');
    assert.equal(parseValue('1234abc'), '1234abc');
});

test('parseValue: non-string inputs pass through unchanged', () => {
    assert.equal(parseValue(42), 42);
    assert.deepEqual(parseValue({ already: 'parsed' }), { already: 'parsed' });
});

/* -------------------- getTimestamp -------------------- */

test('getTimestamp: numeric epoch passes through', () => {
    assert.equal(getTimestamp(1700000000000), 1700000000000);
});

test('getTimestamp: Firestore Timestamp via toMillis()', () => {
    const ts = { toMillis: () => 1700000000000 };
    assert.equal(getTimestamp(ts), 1700000000000);
});

test('getTimestamp: { seconds } shape returns seconds × 1000', () => {
    assert.equal(getTimestamp({ seconds: 1700000000 }), 1700000000 * 1000);
});

test('getTimestamp: nullish and unknown shapes return 0', () => {
    assert.equal(getTimestamp(null), 0);
    assert.equal(getTimestamp(undefined), 0);
    assert.equal(getTimestamp({}), 0);
    assert.equal(getTimestamp('not-a-timestamp'), 0);
});

/* -------------------- sanitiseForFirestore -------------------- */

test('sanitiseForFirestore: undefined → null', () => {
    assert.equal(sanitiseForFirestore(undefined), null);
});

test('sanitiseForFirestore: primitives pass through', () => {
    assert.equal(sanitiseForFirestore('abc'), 'abc');
    assert.equal(sanitiseForFirestore(42), 42);
    assert.equal(sanitiseForFirestore(false), false);
});

test('sanitiseForFirestore: drops undefined fields from objects', () => {
    const input = { a: 1, b: undefined, c: 'x' };
    const out = sanitiseForFirestore(input);
    assert.deepEqual(out, { a: 1, c: 'x' });
    assert.ok(!('b' in out));
});

test('sanitiseForFirestore: drops undefined deep inside arrays/objects', () => {
    const out = sanitiseForFirestore({ list: [1, undefined, 3], nested: { x: undefined, y: 'ok' } });
    // JSON round-trip replaces array undefineds with null per spec.
    assert.deepEqual(out.list, [1, null, 3]);
    assert.deepEqual(out.nested, { y: 'ok' });
});

/* -------------------- estimatePayloadBytes -------------------- */

test('estimatePayloadBytes: returns 0 for unserialisable input', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.equal(estimatePayloadBytes(cyclic), 0);
});

test('estimatePayloadBytes: scales with payload size', () => {
    const small = estimatePayloadBytes({ a: 'x' });
    const big = estimatePayloadBytes({ a: 'x'.repeat(10_000) });
    assert.ok(big > small);
    assert.ok(big >= 10_000);
});

test('estimatePayloadBytes: substitutes Firestore FieldValue sentinels', () => {
    class FieldValueSentinel { constructor() { this.tag = 'serverTimestamp'; } }
    const payload = { ts: new FieldValueSentinel() };
    const bytes = estimatePayloadBytes(payload);
    // The sentinel should be replaced with '__SENTINEL__' (12 chars + quotes).
    assert.ok(bytes > 0);
    assert.ok(bytes < 100);
});

/* -------------------- sameKeySet -------------------- */

test('sameKeySet: identical sets return true', () => {
    assert.equal(sameKeySet(new Set(['a', 'b', 'c']), ['a', 'b', 'c']), true);
});

test('sameKeySet: order does not matter', () => {
    assert.equal(sameKeySet(new Set(['a', 'b', 'c']), ['c', 'a', 'b']), true);
});

test('sameKeySet: size mismatch returns false', () => {
    assert.equal(sameKeySet(new Set(['a', 'b']), ['a', 'b', 'c']), false);
    assert.equal(sameKeySet(new Set(['a', 'b', 'c']), ['a', 'b']), false);
});

test('sameKeySet: same size but different members returns false', () => {
    assert.equal(sameKeySet(new Set(['a', 'b']), ['a', 'c']), false);
});

/* -------------------- decideRemoteChange -------------------- */

test('decideRemoteChange: stale remote (timestamp <= lastRemoteUpdate) → skip-stale', () => {
    const verdict = decideRemoteChange(
        { rev: 1, updatedAt: 1000, hash: 'h1' },
        { rev: 1, updatedAt: 999, hash: 'h2' },
        1000
    );
    assert.equal(verdict, 'skip-stale');
});

test('decideRemoteChange: same hash → skip-deduped (the hover-flicker guard)', () => {
    const verdict = decideRemoteChange(
        { rev: 1, updatedAt: 1000, hash: 'same' },
        { rev: 2, updatedAt: 2000, hash: 'same' },
        500
    );
    assert.equal(verdict, 'skip-deduped');
});

test('decideRemoteChange: no local revision yet → apply', () => {
    const verdict = decideRemoteChange(
        undefined,
        { rev: 1, updatedAt: 1000, hash: 'h1' },
        0
    );
    assert.equal(verdict, 'apply');
});

test('decideRemoteChange: newer remote timestamp → apply', () => {
    const verdict = decideRemoteChange(
        { rev: 1, updatedAt: 1000, hash: 'h1' },
        { rev: 1, updatedAt: 2000, hash: 'h2' },
        500
    );
    assert.equal(verdict, 'apply');
});

test('decideRemoteChange: the wall clock has no vote, the revision decides', () => {
    // This test used to assert skip-older for a remote at rev 3 with an
    // older TIMESTAMP than a local at rev 2, which is the defect F05 names:
    // localRev.updatedAt is this device's Date.now() and remoteInfo.updatedAt
    // is a Firestore server timestamp, so the verdict depended on how well
    // two clocks agreed. A device an hour fast rejected an hour of
    // legitimate updates as skip-older.
    const laterVersionOlderClock = decideRemoteChange(
        { rev: 2, updatedAt: 2000, hash: 'h1' },
        { rev: 3, updatedAt: 1000, hash: 'h2' },
        500
    );
    assert.equal(laterVersionOlderClock, 'apply',
        'rev 3 has seen more than rev 2, whatever the clocks say');

    const earlierVersionNewerClock = decideRemoteChange(
        { rev: 3, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: 9999, hash: 'h2' },
        500
    );
    assert.equal(earlierVersionNewerClock, 'skip-older',
        'and rev 2 has seen less, whatever the clocks say');
});

test('decideRemoteChange: unflushed local work makes it a conflict, not a loss', () => {
    // `dirty` means this device holds an edit the cloud has not accepted, so
    // both sides have moved since they last agreed. Answering that with a
    // winner and no copy is exactly how "device A adds a workout, device B
    // adds a workout" used to lose one of them.
    const verdict = decideRemoteChange(
        { rev: 2, updatedAt: 1000, hash: 'h1', dirty: true },
        { rev: 5, updatedAt: 2000, hash: 'h2' },
        500
    );
    assert.equal(verdict, 'conflict');

    // Even when the remote is at a LOWER revision: both moved, so both have
    // something the other has not seen.
    assert.equal(decideRemoteChange(
        { rev: 9, updatedAt: 1000, hash: 'h1', dirty: true },
        { rev: 2, updatedAt: 2000, hash: 'h2' },
        500
    ), 'conflict');

    // A dedupe still wins over a conflict: identical content is not one.
    assert.equal(decideRemoteChange(
        { rev: 2, updatedAt: 1000, hash: 'same', dirty: true },
        { rev: 5, updatedAt: 2000, hash: 'same' },
        500
    ), 'skip-deduped');
});

test('decideRemoteChange: same timestamp, higher remote rev → apply', () => {
    const verdict = decideRemoteChange(
        { rev: 1, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: 1000, hash: 'h2' },
        500
    );
    assert.equal(verdict, 'apply');
});

test('decideRemoteChange: an equal revision on a clean local copy applies', () => {
    // Equal rev and different content, with nothing unflushed here: our copy
    // came from the cloud and has not been touched, so there is nothing of
    // ours to lose and the cloud is the authority. (When there IS something
    // unflushed, `dirty` makes the same pair a conflict - see above.)
    assert.equal(decideRemoteChange(
        { rev: 2, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: 1000, hash: 'h2' },
        500
    ), 'apply');
    assert.equal(decideRemoteChange(
        { rev: 3, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: 1000, hash: 'h2' },
        500
    ), 'skip-older');
});

test('decideRemoteChange: Firestore-shaped timestamp inputs are honored', () => {
    // Mix Firestore Timestamp-shaped remote with epoch-ms local.
    const verdict = decideRemoteChange(
        { rev: 1, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: { toMillis: () => 2000 }, hash: 'h2' },
        500
    );
    assert.equal(verdict, 'apply');
});

test('decideRemoteChange: missing remote.hash skips the dedupe path', () => {
    // If the remote document was written by an older client without hashes,
    // we must fall through to timestamp comparison rather than deduping
    // against a possibly-stale local hash.
    const verdict = decideRemoteChange(
        { rev: 1, updatedAt: 1000, hash: 'whatever' },
        { rev: 1, updatedAt: 2000 /* no hash */ },
        500
    );
    assert.equal(verdict, 'apply');
});

// ---------------------------------------------------------------------------
// requeueFailedWrites: the failed-flush data-loss race
// ---------------------------------------------------------------------------

test('requeueFailedWrites restores failed writes into an empty queue', () => {
    const queue = new Map();
    const failed = new Map([
        ['k1', { rev: 3, value: 'a' }],
        ['k2', { rev: 1, value: 'b' }],
    ]);
    const restored = requeueFailedWrites(queue, failed);
    assert.equal(restored, 2);
    assert.equal(queue.get('k1').rev, 3);
    assert.equal(queue.get('k2').rev, 1);
});

test('requeueFailedWrites never clobbers a NEWER write made during the flush', () => {
    // THE RACE: flushWrites copied rev 3 and cleared the queue; while the
    // network call was failing, the user edited the same key again and
    // queueWrite stored rev 4. The old code re-queued rev 3 over it, and
    // since localRevisions already held rev 4's hash, rev 4 was never sent.
    const queue = new Map([['k1', { rev: 4, value: 'newer' }]]);
    const failed = new Map([['k1', { rev: 3, value: 'older' }]]);
    const restored = requeueFailedWrites(queue, failed);
    assert.equal(restored, 0);
    assert.equal(queue.get('k1').rev, 4);
    assert.equal(queue.get('k1').value, 'newer');
});

test('requeueFailedWrites replaces an older queued entry and tolerates missing revs', () => {
    const queue = new Map([['k1', { rev: 2, value: 'stale' }], ['k2', { value: 'no-rev' }]]);
    const failed = new Map([['k1', { rev: 5, value: 'fresh' }], ['k2', { rev: 1, value: 'revved' }]]);
    const restored = requeueFailedWrites(queue, failed);
    assert.equal(restored, 2);
    assert.equal(queue.get('k1').value, 'fresh');
    // A queued entry with no rev counts as rev 0 and yields to any revved one.
    assert.equal(queue.get('k2').value, 'revved');
});

// ---------------------------------------------------------------------------
// isPermanentWriteError
// ---------------------------------------------------------------------------

test('isPermanentWriteError: deterministic rejections are permanent', () => {
  assert.equal(isPermanentWriteError({ code: 'payload-too-large' }), true);
  assert.equal(isPermanentWriteError({ code: 'invalid-argument' }), true);
  assert.equal(isPermanentWriteError({ permanent: true }), true);
});

test('isPermanentWriteError: transient and unknown failures stay retryable', () => {
  // Anything not positively known to be deterministic keeps the retry
  // ladder it had before, so this change cannot make a recoverable blip
  // unrecoverable.
  assert.equal(isPermanentWriteError({ code: 'unavailable' }), false);
  assert.equal(isPermanentWriteError({ code: 'deadline-exceeded' }), false);
  assert.equal(isPermanentWriteError({ code: 'permission-denied' }), false);
  assert.equal(isPermanentWriteError(new Error('network down')), false);
  assert.equal(isPermanentWriteError(null), false);
  assert.equal(isPermanentWriteError(undefined), false);
  assert.equal(isPermanentWriteError('payload-too-large'), false);
});

// ---------------------------------------------------------------------------
// splitIntoChunks
// ---------------------------------------------------------------------------

test('splitIntoChunks: parts rejoin to the exact input', () => {
  const s = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(40) })) });
  const parts = splitIntoChunks(s, 1000);
  assert.ok(parts.length > 10);
  assert.ok(parts.every(p => p.length <= 1000));
  assert.equal(parts.join(''), s);
});

test('splitIntoChunks: never splits a surrogate pair', () => {
  // Firestore stores UTF-8; a lone surrogate does not survive the round
  // trip, and every app in this repo stores emoji (rival icons, avatars).
  const s = '😀'.repeat(50);
  const parts = splitIntoChunks(s, 3);
  assert.equal(parts.join(''), s);
  for (const part of parts) {
    assert.equal(part.length % 2, 0, 'a part must not end mid-pair');
    assert.equal(JSON.parse(JSON.stringify(part)), part);
  }
});

test('splitIntoChunks: a value smaller than the chunk size is one part', () => {
  assert.deepEqual(splitIntoChunks('abc', 1000), ['abc']);
  assert.deepEqual(splitIntoChunks('', 1000), ['']);
});

// ---------------------------------------------------------------------------
// planFlushBatches
// ---------------------------------------------------------------------------

test('planFlushBatches: packs entries into as few commits as fit', () => {
  const { batches, oversized } = planFlushBatches([
    { key: 'a', entry: 1, bytes: 300 },
    { key: 'b', entry: 2, bytes: 300 },
    { key: 'c', entry: 3, bytes: 300 },
  ], 700);
  assert.deepEqual(oversized, []);
  assert.deepEqual(batches, [{ a: 1, b: 2 }, { c: 3 }]);
});

test('planFlushBatches: one batch when everything fits', () => {
  const { batches } = planFlushBatches([
    { key: 'a', entry: 1, bytes: 10 },
    { key: 'b', entry: 2, bytes: 10 },
  ], 700);
  assert.equal(batches.length, 1);
});

test('planFlushBatches: an entry that cannot fit alone is reported, not silently dropped into a batch', () => {
  const { batches, oversized } = planFlushBatches([
    { key: 'ok', entry: 1, bytes: 100 },
    { key: 'huge', entry: 2, bytes: 900 },
  ], 700);
  assert.deepEqual(oversized, ['huge']);
  assert.deepEqual(batches, [{ ok: 1 }]);
});

test('planFlushBatches: no entries means no commits', () => {
  assert.deepEqual(planFlushBatches([], 700), { batches: [], oversized: [] });
});

/* -------------------- decideRemoteChange: the three-way condition --------------------
 *
 * `dirty` proves only that WE moved. Treating that alone as a conflict is
 * what made a single device argue with its own Firestore echo, so these
 * cover the context that establishes whether the CLOUD moved too.
 */

const DIRTY = { rev: 5, hash: 'localhash', updatedAt: 1000, dirty: true };
const REMOTE = { rev: 4, hash: 'remotehash', updatedAt: 5000 };

test('decideRemoteChange: dirty alone is still a conflict when nothing else is known', () => {
  // The pre-existing three-argument behaviour, unchanged: with no context
  // the function cannot tell an own echo from a peer, and errs toward
  // reporting rather than toward silently dropping a side.
  assert.equal(decideRemoteChange(DIRTY, REMOTE, 0), 'conflict');
});

test('decideRemoteChange: a body this client published itself is never a conflict', () => {
  assert.equal(decideRemoteChange(DIRTY, REMOTE, 0, { ownEcho: true }), 'skip-own');
});

test('decideRemoteChange: a cloud still holding the agreed base has not moved', () => {
  assert.equal(
    decideRemoteChange(DIRTY, REMOTE, 0, { baseHash: 'remotehash' }),
    'skip-agreed',
    'the cloud is exactly where we left it, however far we have moved'
  );
  assert.equal(
    decideRemoteChange(DIRTY, REMOTE, 0, { baseHash: 'something-else' }),
    'conflict',
    'a cloud that has moved away from the base IS a conflict'
  );
});

test('decideRemoteChange: a body already resolved is not resolved twice', () => {
  const seenToken = remoteToken(REMOTE);
  assert.equal(decideRemoteChange(DIRTY, REMOTE, 0, { seenToken }), 'skip-seen');
  assert.equal(
    decideRemoteChange(DIRTY, { ...REMOTE, hash: 'moved-on' }, 0, { seenToken }),
    'conflict',
    'a different body under the same revision is still news'
  );
});

test('decideRemoteChange: an unresolved serverTimestamp on a pending write is not news', () => {
  const pending = { rev: 6, hash: 'x', updatedAt: null };
  assert.equal(decideRemoteChange(DIRTY, pending, 0, { pendingWrites: true }), 'skip-pending');
});

test('decideRemoteChange: hasPendingWrites does not suppress a genuine committed edit', () => {
  // A snapshot can carry this client's pending writes AND a peer's committed
  // change at the same time. Metadata alone must never silence the latter,
  // which is why it is one signal of three rather than the fix on its own.
  const committed = { rev: 9, hash: 'theirs', updatedAt: 9000 };
  assert.equal(decideRemoteChange(DIRTY, committed, 0, { pendingWrites: true }), 'conflict');
});

test('decideRemoteChange: dedupe still beats every other consideration', () => {
  const same = { rev: 9, hash: 'localhash', updatedAt: 9000 };
  assert.equal(decideRemoteChange(DIRTY, same, 0, { ownEcho: false }), 'skip-deduped');
});

test('remoteToken: identity is revision AND content, never one of them', () => {
  assert.equal(remoteToken({ rev: 3, hash: 'abc' }), '3:abc');
  assert.notEqual(remoteToken({ rev: 3, hash: 'abc' }), remoteToken({ rev: 3, hash: 'abd' }));
  assert.notEqual(remoteToken({ rev: 3, hash: 'abc' }), remoteToken({ rev: 4, hash: 'abc' }));
  assert.equal(remoteToken(null), '0:null');
});

/* -------------------- mapIndex / valueIndex -------------------- */

test('mapIndex: a plain object indexes by its own keys', () => {
  const index = mapIndex({ mon: 1, tue: [2, 3] });
  assert.deepEqual(Object.keys(index).sort(), ['mon', 'tue']);
  assert.equal(index.mon, hashValue(1));
  assert.equal(index.tue, hashValue([2, 3]));
});

test('mapIndex: an empty object is a legitimate map', () => {
  assert.deepEqual({ ...mapIndex({}) }, {});
});

test('mapIndex: arrays and primitives are not maps', () => {
  assert.equal(mapIndex([{ id: 'a' }]), null);
  assert.equal(mapIndex('a string'), null);
  assert.equal(mapIndex(7), null);
  assert.equal(mapIndex(null), null);
});

test('mapIndex: the index cannot be poisoned through __proto__', () => {
  const index = mapIndex(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(Object.getPrototypeOf(index), null);
  assert.equal(({}).polluted, undefined);
});

test('valueIndex: tags the shape so an array is never merged against an object', () => {
  assert.equal(valueIndex([{ id: 'a' }]).kind, 'records');
  assert.equal(valueIndex({ mon: 1 }).kind, 'map');
  assert.equal(valueIndex('a string'), null);
});

test('valueIndex: an EMPTY list is mergeable, unlike a shapeless value', () => {
  // Clearing a collection is a real state. Treating [] as "not a record
  // collection" made a cleared list arrive on the other device as an
  // unmergeable conflict rather than as the deletion it is.
  const index = valueIndex([]);
  assert.equal(index.kind, 'records');
  assert.deepEqual({ ...index.entries }, {});
});

/* -------------------- mergeMaps -------------------- */

test('mergeMaps: two devices adding two different dates keep both', () => {
  const base = mapIndex({ mon: 1 });
  const merged = mergeMaps(base, { mon: 1, tue: 2 }, { mon: 1, wed: 3 });
  assert.deepEqual(merged.merged, { mon: 1, wed: 3, tue: 2 });
  assert.deepEqual(merged.conflicts, []);
});

test('mergeMaps: the side that changed a key wins that key', () => {
  const base = mapIndex({ units: 'kg', theme: 'dark' });
  const merged = mergeMaps(base, { units: 'lb', theme: 'dark' }, { units: 'kg', theme: 'light' });
  assert.deepEqual(merged.merged, { units: 'lb', theme: 'light' });
  assert.deepEqual(merged.conflicts, []);
});

test('mergeMaps: a key both sides changed is reported, and resolved the same way everywhere', () => {
  const base = mapIndex({ units: 'kg' });
  const a = mergeMaps(base, { units: 'lb' }, { units: 'st' });
  const b = mergeMaps(base, { units: 'st' }, { units: 'lb' });
  assert.deepEqual(a.conflicts, ['units']);
  assert.deepEqual(b.conflicts, ['units']);
  assert.deepEqual(a.merged, b.merged, 'both devices reach the same answer, or they ping-pong');
});

test('mergeMaps: a deletion is honoured rather than resurrected', () => {
  const base = mapIndex({ mon: 1, tue: 2 });
  const merged = mergeMaps(base, { mon: 1, tue: 2, wed: 3 }, { mon: 1 });
  assert.deepEqual(merged.merged, { mon: 1, wed: 3 }, 'their delete sticks, our addition survives');
});

test('mergeMaps: with no base at all, nothing is deleted', () => {
  const merged = mergeMaps(null, { mon: 1 }, { tue: 2 });
  assert.deepEqual(merged.merged, { tue: 2, mon: 1 });
});

/* -------------------- mergeValues -------------------- */

test('mergeValues: dispatches on shape and refuses a shape change', () => {
  assert.ok(mergeValues(null, [{ id: 'a' }], [{ id: 'b' }]), 'two record collections merge');
  assert.ok(mergeValues(null, { a: 1 }, { b: 2 }), 'two maps merge');
  assert.equal(mergeValues(null, [{ id: 'a' }], { b: 2 }), null, 'an array is not a map');
  assert.equal(mergeValues(null, 'a string', 'another'), null, 'primitives have nothing to merge');
  assert.equal(mergeValues(null, null, { a: 1 }), null, 'a missing side cannot be merged');
});

test('mergeValues: a base recorded for the other shape is ignored, not misread', () => {
  // Reading a records base as a map index would label every existing entry
  // an addition, which is the one thing a base exists to prevent.
  const recordsBase = { kind: 'records', entries: { mon: 'somehash' } };
  const merged = mergeValues(recordsBase, { mon: 1 }, {});
  assert.deepEqual(merged.merged, { mon: 1 }, 'without a usable base, nothing is treated as deleted');
});

test('normaliseBaseIndex: the legacy bare id->hash base still merges', () => {
  // Devices upgrading in place hold a base written before maps were
  // mergeable: a bare object of id -> hash with no shape tag.
  assert.deepEqual(normaliseBaseIndex({ a: 'h1' }), { kind: 'records', entries: { a: 'h1' } });
  assert.deepEqual(
    normaliseBaseIndex({ kind: 'map', entries: { mon: 'h' }, hash: 'whole' }),
    { kind: 'map', entries: { mon: 'h' } }
  );
  assert.equal(normaliseBaseIndex(null), null);
});

test('mergeValues: a legacy base is honoured, so an upgrade does not resurrect deletions', () => {
  const legacyBase = { a: hashValue({ id: 'a', v: 1 }), b: hashValue({ id: 'b', v: 1 }) };
  const merged = mergeValues(legacyBase, [{ id: 'a', v: 1 }, { id: 'c', v: 1 }], [{ id: 'a', v: 1 }]);
  assert.deepEqual(
    merged.merged.map((r) => r.id).sort(),
    ['a', 'c'],
    'b was deleted remotely and stays deleted'
  );
});
