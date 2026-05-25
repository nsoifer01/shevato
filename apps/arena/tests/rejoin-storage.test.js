/*
 * Brain Arena — rejoin-storage helpers (Item #8).
 * Tests cover the round-trip save/get, TTL boundary, code/uid validation,
 * malformed entries, and storage-throwing edge cases.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RejoinStorage = require('../js/rejoin-storage.js');

// Minimal in-memory localStorage stub. Implements just the API the
// helper touches; tests construct a fresh one per case.
function makeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get length() { return map.size; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(String(k), String(v)); },
        removeItem(k) { map.delete(k); },
        // Test-only inspector
        _raw: () => map
    };
}
function makeThrowingStorage() {
    return {
        getItem() { throw new Error('boom'); },
        setItem() { throw new Error('boom'); },
        removeItem() { throw new Error('boom'); }
    };
}

test('saveRecentRoom round-trips through getRecentRoom', () => {
    const s = makeStorage();
    const now = 1700000000000;
    assert.equal(RejoinStorage.saveRecentRoom(s, now, 'ABCDE', 'uid-1'), true);
    const got = RejoinStorage.getRecentRoom(s, now);
    assert.deepEqual(got, { code: 'ABCDE', uid: 'uid-1', savedAt: now });
});

test('saveRecentRoom rejects invalid codes (lowercase, punctuation)', () => {
    const s = makeStorage();
    assert.equal(RejoinStorage.saveRecentRoom(s, 0, 'abcde', 'u'), false);
    assert.equal(RejoinStorage.saveRecentRoom(s, 0, 'ABC-DE', 'u'), false);
    assert.equal(RejoinStorage.saveRecentRoom(s, 0, '', 'u'), false);
    assert.equal(RejoinStorage.saveRecentRoom(s, 0, 12345, 'u'), false);
    assert.equal(s._raw().size, 0, 'nothing should have been stored');
});

test('saveRecentRoom rejects when uid is missing', () => {
    const s = makeStorage();
    assert.equal(RejoinStorage.saveRecentRoom(s, 0, 'ABCDE', null), false);
    assert.equal(RejoinStorage.saveRecentRoom(s, 0, 'ABCDE', ''), false);
    assert.equal(s._raw().size, 0);
});

test('saveRecentRoom no-ops when storage is unavailable', () => {
    assert.equal(RejoinStorage.saveRecentRoom(null, 0, 'ABCDE', 'u'), false);
    assert.equal(RejoinStorage.saveRecentRoom({}, 0, 'ABCDE', 'u'), false);
});

test('saveRecentRoom swallows storage throws (private mode / quota)', () => {
    const s = makeThrowingStorage();
    assert.equal(RejoinStorage.saveRecentRoom(s, 0, 'ABCDE', 'u'), false);
});

test('getRecentRoom returns null past the TTL window', () => {
    const s = makeStorage();
    const t0 = 1700000000000;
    RejoinStorage.saveRecentRoom(s, t0, 'ABCDE', 'u');
    // Inside the 2h window — still valid.
    assert.ok(RejoinStorage.getRecentRoom(s, t0 + RejoinStorage.REJOIN_TTL_MS - 1));
    // At the boundary — boundary exclusive; > TTL is null.
    assert.equal(RejoinStorage.getRecentRoom(s, t0 + RejoinStorage.REJOIN_TTL_MS + 1), null);
    // Clock skew backwards — savedAt > now means age is negative; null.
    assert.equal(RejoinStorage.getRecentRoom(s, t0 - 1000), null);
});

test('getRecentRoom returns null for malformed entries', () => {
    assert.equal(RejoinStorage.getRecentRoom(makeStorage({ arenaRecentRoom: 'not json' }), 0), null);
    assert.equal(RejoinStorage.getRecentRoom(makeStorage({ arenaRecentRoom: 'null' }), 0), null);
    assert.equal(RejoinStorage.getRecentRoom(makeStorage({ arenaRecentRoom: '{"code":"abc","savedAt":1}' }), 1), null,
        'lowercase code rejected');
    assert.equal(RejoinStorage.getRecentRoom(makeStorage({ arenaRecentRoom: '{"savedAt":1}' }), 1), null,
        'missing code rejected');
    assert.equal(RejoinStorage.getRecentRoom(makeStorage({ arenaRecentRoom: '{"code":"ABCDE"}' }), 0), null,
        'missing savedAt rejected');
});

test('getRecentRoom returns null on empty / no entry', () => {
    assert.equal(RejoinStorage.getRecentRoom(makeStorage(), 0), null);
    assert.equal(RejoinStorage.getRecentRoom(null, 0), null);
});

test('clearRecentRoom removes the entry', () => {
    const s = makeStorage();
    RejoinStorage.saveRecentRoom(s, 0, 'ABCDE', 'u');
    assert.equal(s._raw().size, 1);
    RejoinStorage.clearRecentRoom(s);
    assert.equal(s._raw().size, 0);
});

test('clearRecentRoom is safe when storage throws', () => {
    assert.doesNotThrow(() => RejoinStorage.clearRecentRoom(makeThrowingStorage()));
});

test('clearRecentRoom is safe when storage is missing', () => {
    assert.doesNotThrow(() => RejoinStorage.clearRecentRoom(null));
    assert.doesNotThrow(() => RejoinStorage.clearRecentRoom({}));
});
