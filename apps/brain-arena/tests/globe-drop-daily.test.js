'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    dailyDateKey,
    mulberry32,
    hashStringToSeed,
    seededShuffle,
    pickDailyLocations
} = require('../js/globe-drop-daily.js');

// --- dailyDateKey -----------------------------------------------------

test('dailyDateKey: returns YYYY-MM-DD in UTC', () => {
    // 2026-05-19 12:00:00 UTC
    const key = dailyDateKey(new Date(Date.UTC(2026, 4, 19, 12)));
    assert.equal(key, '2026-05-19');
});

test('dailyDateKey: pads single-digit month and day', () => {
    assert.equal(dailyDateKey(new Date(Date.UTC(2026, 0, 5, 12))), '2026-01-05');
});

test('dailyDateKey: timezones do not flip the date (UTC anchoring)', () => {
    // 2026-05-19 23:30 UTC and 2026-05-20 00:30 UTC must produce different keys
    const a = dailyDateKey(new Date(Date.UTC(2026, 4, 19, 23, 30)));
    const b = dailyDateKey(new Date(Date.UTC(2026, 4, 20, 0, 30)));
    assert.equal(a, '2026-05-19');
    assert.equal(b, '2026-05-20');
});

// --- mulberry32 -------------------------------------------------------

test('mulberry32: same seed → same first value', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    assert.equal(a(), b());
});

test('mulberry32: different seeds → different first value', () => {
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('mulberry32: output is in [0, 1)', () => {
    const rand = mulberry32(2026);
    for (let i = 0; i < 100; i++) {
        const v = rand();
        assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
    }
});

// --- hashStringToSeed -------------------------------------------------

test('hashStringToSeed: same string → same hash', () => {
    assert.equal(hashStringToSeed('hello'), hashStringToSeed('hello'));
});

test('hashStringToSeed: empty / null / undefined are stable', () => {
    assert.equal(hashStringToSeed(''), hashStringToSeed(undefined));
    assert.equal(hashStringToSeed(''), hashStringToSeed(null));
});

test('hashStringToSeed: trivially different strings produce different seeds', () => {
    assert.notEqual(hashStringToSeed('2026-05-19'), hashStringToSeed('2026-05-20'));
});

// --- seededShuffle ----------------------------------------------------

test('seededShuffle: same seed → same order', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = seededShuffle(arr, 'today');
    const b = seededShuffle(arr, 'today');
    assert.deepEqual(a, b);
});

test('seededShuffle: different seeds → different order (usually)', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = seededShuffle(arr, 'today');
    const b = seededShuffle(arr, 'tomorrow');
    assert.notDeepEqual(a, b);
});

test('seededShuffle: does not mutate input', () => {
    const arr = [1, 2, 3, 4, 5];
    const before = arr.slice();
    seededShuffle(arr, 'seed');
    assert.deepEqual(arr, before);
});

// --- pickDailyLocations -----------------------------------------------

test('pickDailyLocations: deterministic across calls within a day', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({ id: 'loc-' + i }));
    const a = pickDailyLocations(pool, 5, '2026-05-19');
    const b = pickDailyLocations(pool, 5, '2026-05-19');
    assert.deepEqual(a, b);
});

test('pickDailyLocations: different days pick different sets', () => {
    const pool = Array.from({ length: 30 }, (_, i) => ({ id: 'loc-' + i }));
    const a = pickDailyLocations(pool, 5, '2026-05-19').map((x) => x.id);
    const b = pickDailyLocations(pool, 5, '2026-05-20').map((x) => x.id);
    assert.notDeepEqual(a, b);
});

test('pickDailyLocations: count is clamped to pool size', () => {
    const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = pickDailyLocations(pool, 10, '2026-05-19');
    assert.equal(out.length, 3);
});

test('pickDailyLocations: empty pool → empty playlist', () => {
    assert.deepEqual(pickDailyLocations([], 5, '2026-05-19'), []);
});
