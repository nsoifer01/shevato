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
  requeueFailedWrites,
  isPermanentWriteError,
  splitIntoChunks,
  planFlushBatches
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

test('decideRemoteChange: older remote timestamp → skip-older', () => {
    const verdict = decideRemoteChange(
        { rev: 2, updatedAt: 2000, hash: 'h1' },
        { rev: 3, updatedAt: 1000, hash: 'h2' },
        500
    );
    assert.equal(verdict, 'skip-older');
});

test('decideRemoteChange: same timestamp, higher remote rev → apply', () => {
    const verdict = decideRemoteChange(
        { rev: 1, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: 1000, hash: 'h2' },
        500
    );
    assert.equal(verdict, 'apply');
});

test('decideRemoteChange: same timestamp, lower-or-equal remote rev → skip-older', () => {
    const equal = decideRemoteChange(
        { rev: 2, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: 1000, hash: 'h2' },
        500
    );
    const lower = decideRemoteChange(
        { rev: 3, updatedAt: 1000, hash: 'h1' },
        { rev: 2, updatedAt: 1000, hash: 'h2' },
        500
    );
    assert.equal(equal, 'skip-older');
    assert.equal(lower, 'skip-older');
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
