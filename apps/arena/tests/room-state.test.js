'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    generateRoomCode,
    normalizeRoomCode,
    questionPhase,
    timeLeftMs,
    pickNextHost,
    aggregateAnswerStats,
    aggregateGlobeDropStats,
    pickDecider,
    availableCategoriesFromPool,
    pickQuestionFromPool
} = require('../js/room-state.js');

// --- generateRoomCode --------------------------------------------------

test('generateRoomCode: yields configured length of alphabet chars', () => {
    const code = generateRoomCode();
    assert.equal(code.length, Config.ROOM_CODE_LENGTH);
    for (const ch of code) {
        assert.ok(Config.ROOM_CODE_ALPHABET.includes(ch), `unexpected char ${ch}`);
    }
});

test('generateRoomCode: alphabet excludes visually ambiguous characters', () => {
    // We exclude 0/O/1/I/L so phone-shared codes are unambiguous.
    for (const banned of ['0', 'O', '1', 'I', 'L']) {
        assert.ok(!Config.ROOM_CODE_ALPHABET.includes(banned),
            `alphabet must not include ${banned}`);
    }
});

test('generateRoomCode: deterministic with seeded rand', () => {
    let i = 0;
    const seq = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    const r = () => seq[i++ % seq.length];
    const a = generateRoomCode(r);
    i = 0;
    const b = generateRoomCode(r);
    assert.equal(a, b);
});

// --- normalizeRoomCode -------------------------------------------------

test('normalizeRoomCode: uppercases and strips punctuation', () => {
    // Build a valid 5-char code, then lowercase + sprinkle junk.
    const valid = Config.ROOM_CODE_ALPHABET.slice(0, Config.ROOM_CODE_LENGTH);
    const messy = valid.toLowerCase().split('').join(' - ');
    assert.equal(normalizeRoomCode(messy), valid);
});

test('normalizeRoomCode: returns "" for wrong-length input', () => {
    assert.equal(normalizeRoomCode(''), '');
    assert.equal(normalizeRoomCode('ABC'), '');
    assert.equal(normalizeRoomCode('ABCDEFGHIJK'), '');
});

// --- questionPhase + timeLeftMs ---------------------------------------

test('questionPhase: null start time => idle', () => {
    assert.equal(questionPhase(null, 12345), 'idle');
});

test('questionPhase: progression through asking / reveal / ended', () => {
    const start = 1_000_000;
    assert.equal(questionPhase(start, start), 'asking');
    assert.equal(questionPhase(start, start + Config.QUESTION_TIME_MS - 1), 'asking');
    assert.equal(questionPhase(start, start + Config.QUESTION_TIME_MS), 'reveal');
    assert.equal(questionPhase(start, start + Config.QUESTION_TIME_MS + Config.REVEAL_TIME_MS - 1), 'reveal');
    assert.equal(questionPhase(start, start + Config.QUESTION_TIME_MS + Config.REVEAL_TIME_MS), 'ended');
});

test('timeLeftMs: counts down from total to zero, then clamps', () => {
    const start = 1_000_000;
    assert.equal(timeLeftMs(start, start), Config.QUESTION_TIME_MS);
    assert.equal(timeLeftMs(start, start + 5000), Config.QUESTION_TIME_MS - 5000);
    assert.equal(timeLeftMs(start, start + Config.QUESTION_TIME_MS), 0);
    assert.equal(timeLeftMs(start, start + Config.QUESTION_TIME_MS + 9999), 0);
});

test('timeLeftMs: null start => full time (lobby case)', () => {
    assert.equal(timeLeftMs(null, 12345), Config.QUESTION_TIME_MS);
});

// --- pickNextHost ------------------------------------------------------

test('pickNextHost: empty list => null', () => {
    assert.equal(pickNextHost([]), null);
    assert.equal(pickNextHost(null), null);
});

test('pickNextHost: earliest joiner wins', () => {
    const next = pickNextHost([
        { uid: 'c', joinedAt: 300 },
        { uid: 'a', joinedAt: 100 },
        { uid: 'b', joinedAt: 200 }
    ]);
    assert.equal(next, 'a');
});

test('pickNextHost: same joinedAt => uid lex order', () => {
    const next = pickNextHost([
        { uid: 'b', joinedAt: 100 },
        { uid: 'a', joinedAt: 100 }
    ]);
    assert.equal(next, 'a');
});

// --- aggregateAnswerStats ---------------------------------------------

test('aggregateAnswerStats: empty list => zeroed stats', () => {
    const s = aggregateAnswerStats([]);
    assert.equal(s.accuracy, 0);
    assert.equal(s.avgResponseMs, 0);
    assert.deepEqual(s.byCategory, {});
});

test('aggregateAnswerStats: counts accuracy + per-category + avg response', () => {
    const s = aggregateAnswerStats([
        { correct: true,  timeLeftMs: 14000, totalMs: 15000, category: 'science' },     // 1000ms
        { correct: false, timeLeftMs: 5000,  totalMs: 15000, category: 'science' },     // 10000ms
        { correct: true,  timeLeftMs: 0,     totalMs: 15000, category: 'history' }      // 15000ms
    ]);
    assert.equal(s.accuracy, 2 / 3);
    assert.equal(s.avgResponseMs, Math.round((1000 + 10000 + 15000) / 3));
    assert.deepEqual(s.byCategory.science, { correct: 1, total: 2 });
    assert.deepEqual(s.byCategory.history, { correct: 1, total: 1 });
});

// --- custom asking duration (host-configurable timer) -------------------

test('questionPhase: custom duration overrides Config default', () => {
    const start = 1_000_000;
    // 30s custom duration. At t+25s we should still be asking.
    assert.equal(questionPhase(start, start + 25000, null, 30000), 'asking');
    // At t+30s asking ends, reveal begins.
    assert.equal(questionPhase(start, start + 30000, null, 30000), 'reveal');
});

test('questionPhase: omitted / non-positive duration falls back to Config', () => {
    const start = 1_000_000;
    const expected = questionPhase(start, start + 100, null, undefined);
    assert.equal(questionPhase(start, start + 100, null, 0), expected);
    assert.equal(questionPhase(start, start + 100, null, -5), expected);
});

test('timeLeftMs: custom duration scales countdown linearly', () => {
    const start = 1_000_000;
    assert.equal(timeLeftMs(start, start, null, 30000), 30000);
    assert.equal(timeLeftMs(start, start + 10000, null, 30000), 20000);
    assert.equal(timeLeftMs(start, start + 30000, null, 30000), 0);
});

// --- early reveal (questionPhase + timeLeftMs with revealStartedAt) ---

test('questionPhase: revealStartedAt collapses asking window immediately', () => {
    const start = 1_000_000;
    // 100ms into asking, but host has signaled reveal at start+100
    assert.equal(questionPhase(start, start + 100, start + 100), 'reveal');
});

test('questionPhase: reveal window from revealStartedAt elapses to ended', () => {
    const start = 1_000_000;
    const reveal = start + 500;
    assert.equal(questionPhase(start, reveal + Config.REVEAL_TIME_MS - 1, reveal), 'reveal');
    assert.equal(questionPhase(start, reveal + Config.REVEAL_TIME_MS, reveal), 'ended');
});

test('timeLeftMs: revealStartedAt forces 0', () => {
    const start = 1_000_000;
    assert.equal(timeLeftMs(start, start + 200, start + 200), 0);
});

// --- pickDecider ------------------------------------------------------

test('pickDecider: rotates by question index, wraps at end', () => {
    const order = ['a', 'b', 'c'];
    assert.equal(pickDecider(order, 0), 'a');
    assert.equal(pickDecider(order, 1), 'b');
    assert.equal(pickDecider(order, 2), 'c');
    assert.equal(pickDecider(order, 3), 'a'); // wraps
    assert.equal(pickDecider(order, 7), 'b');
});

test('pickDecider: empty / non-array returns null', () => {
    assert.equal(pickDecider([], 0), null);
    assert.equal(pickDecider(null, 0), null);
});

test('pickDecider: negative index normalized', () => {
    assert.equal(pickDecider(['a', 'b', 'c'], -1), 'c');
});

// --- availableCategoriesFromPool -------------------------------------

const POOL = [
    { id: 'q1', category: 'science' },
    { id: 'q2', category: 'science' },
    { id: 'q3', category: 'history' },
    { id: 'q4', category: 'history' },
    { id: 'q5', category: 'sports'  }
];

test('availableCategoriesFromPool: counts per category, sorted', () => {
    const result = availableCategoriesFromPool(POOL, []);
    assert.deepEqual(result, [
        { category: 'history', remaining: 2 },
        { category: 'science', remaining: 2 },
        { category: 'sports',  remaining: 1 }
    ]);
});

test('availableCategoriesFromPool: played ids reduce remaining; categories vanish when empty', () => {
    const result = availableCategoriesFromPool(POOL, ['q5', 'q3']);
    assert.deepEqual(result, [
        { category: 'history', remaining: 1 },
        { category: 'science', remaining: 2 }
    ]);
});

test('availableCategoriesFromPool: missing category falls under "general"', () => {
    const r = availableCategoriesFromPool([{ id: 'x' }, { id: 'y', category: '' }], []);
    assert.deepEqual(r, [{ category: 'general', remaining: 2 }]);
});

// --- pickQuestionFromPool --------------------------------------------

test('pickQuestionFromPool: picks within chosen category', () => {
    const got = pickQuestionFromPool(POOL, [], 'history', () => 0);
    assert.equal(got.category, 'history');
    assert.equal(got.id, 'q3');
});

test('pickQuestionFromPool: skips already-played ids', () => {
    const got = pickQuestionFromPool(POOL, ['q3'], 'history', () => 0);
    assert.equal(got.id, 'q4');
});

test('pickQuestionFromPool: __any__ / null picks across all unplayed', () => {
    const got = pickQuestionFromPool(POOL, ['q1', 'q2', 'q3', 'q4'], '__any__', () => 0);
    assert.equal(got.id, 'q5');
});

test('pickQuestionFromPool: exhausted category falls back to any unplayed', () => {
    const got = pickQuestionFromPool(POOL, ['q5'], 'sports', () => 0);
    assert.ok(got);
    assert.notEqual(got.id, 'q5');
});

test('pickQuestionFromPool: fully exhausted pool returns null', () => {
    assert.equal(pickQuestionFromPool(POOL, POOL.map((q) => q.id), 'science'), null);
});

// --- aggregateGlobeDropStats ------------------------------------------

test('aggregateGlobeDropStats: empty / non-array => null', () => {
    assert.equal(aggregateGlobeDropStats([]), null);
    assert.equal(aggregateGlobeDropStats(null), null);
    assert.equal(aggregateGlobeDropStats(undefined), null);
});

test('aggregateGlobeDropStats: derives avg/closest/farthest/bullseye from records', () => {
    const recs = [
        { locationName: 'Pretoria',  region: 'Africa',   distanceKm: 42,   basePoints: 95, multiplier: 1.5, points: 143 },
        { locationName: 'Brussels',  region: 'Europe',   distanceKm: 412,  basePoints: 80, multiplier: 1,   points: 80 },
        { locationName: 'Valley',    region: 'Americas', distanceKm: 4201, basePoints: 0,  multiplier: 3,   points: 0 }
    ];
    const s = aggregateGlobeDropStats(recs);
    assert.equal(s.roundsPlayed, 3);
    assert.equal(s.totalPoints, 223);
    assert.equal(s.avgBaseScore, Math.round((95 + 80 + 0) / 3));
    assert.equal(s.avgDistanceKm, Math.round((42 + 412 + 4201) / 3));
    assert.equal(s.closestKm, 42);
    assert.equal(s.closestLocation, 'Pretoria');
    assert.equal(s.farthestKm, 4201);
    assert.equal(s.farthestLocation, 'Valley');
    assert.equal(s.bullseyeCount, 0);  // bullseye is base ≥ 98 — Pretoria's 95 misses
});

test('aggregateGlobeDropStats: groups by region', () => {
    const recs = [
        { region: 'Europe', basePoints: 90, distanceKm: 100 },
        { region: 'Europe', basePoints: 70, distanceKm: 200 },
        { region: 'Africa', basePoints: 50, distanceKm: 500 }
    ];
    const s = aggregateGlobeDropStats(recs);
    assert.equal(s.byRegion.Europe.rounds, 2);
    assert.equal(s.byRegion.Europe.avgBase, 80);
    assert.equal(s.byRegion.Africa.rounds, 1);
    assert.equal(s.byRegion.Africa.avgBase, 50);
});

test('aggregateGlobeDropStats: reconstructs basePoints from points/multiplier when missing', () => {
    // Legacy records (pre-basePoints field) — should still produce
    // a usable avg by dividing points back out by the multiplier.
    const recs = [
        { region: 'Europe', distanceKm: 100, points: 160, multiplier: 2 }, // base 80
        { region: 'Europe', distanceKm: 200, points: 90,  multiplier: 1 }  // base 90
    ];
    const s = aggregateGlobeDropStats(recs);
    assert.equal(s.avgBaseScore, 85);
});

test('aggregateGlobeDropStats: skips non-numeric distanceKm without crashing', () => {
    const recs = [
        { region: 'Europe', basePoints: 80, distanceKm: 100 },
        { region: 'Europe', basePoints: 50, distanceKm: undefined }, // missing
        { region: 'Europe', basePoints: 70, distanceKm: 'oops' }     // bad
    ];
    const s = aggregateGlobeDropStats(recs);
    assert.equal(s.roundsPlayed, 3);
    // Only the valid record counts toward distance metrics.
    assert.equal(s.closestKm, 100);
    assert.equal(s.farthestKm, 100);
});

test('aggregateGlobeDropStats: totalRounds drives roundsPlayed + avg denominator', () => {
    // Player guessed on 3 of 5 rounds — totalRounds should be 5 and
    // averages should treat the missing rounds as 0 so a player who
    // skipped the hard ones doesn't get an inflated mean.
    const recs = [
        { basePoints: 90, distanceKm: 100, region: 'Europe' },
        { basePoints: 60, distanceKm: 800, region: 'Europe' },
        { basePoints: 30, distanceKm: 3000, region: 'Africa' }
    ];
    const s = aggregateGlobeDropStats(recs, 5);
    assert.equal(s.roundsPlayed, 5);
    assert.equal(s.roundsGuessed, 3);
    // (90+60+30+0+0)/5 = 36
    assert.equal(s.avgBaseScore, 36);
    // Distance avg still uses guess count — "infinite distance" for
    // a non-guess isn't a meaningful number to average.
    assert.equal(s.avgDistanceKm, Math.round((100 + 800 + 3000) / 3));
});

test('aggregateGlobeDropStats: missing totalRounds falls back to records length', () => {
    const recs = [
        { basePoints: 80, distanceKm: 200, region: 'Europe' },
        { basePoints: 40, distanceKm: 500, region: 'Africa' }
    ];
    const s = aggregateGlobeDropStats(recs);
    assert.equal(s.roundsPlayed, 2);
    assert.equal(s.roundsGuessed, 2);
});

test('aggregateGlobeDropStats: empty records + totalRounds=5 still returns null', () => {
    // Player has zero guesses; nothing to aggregate even though the
    // game ran 5 rounds. Caller (renderDetailedStats) shows a "no
    // guesses recorded" hint in this case rather than divide-by-zero.
    assert.equal(aggregateGlobeDropStats([], 5), null);
});
