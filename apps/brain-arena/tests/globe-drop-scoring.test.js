'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    haversineDistanceKm,
    continentMultiplier,
    difficultySettings,
    populationWeight,
    scoreGuess
} = require('../js/globe-drop-scoring.js');

// --- haversineDistanceKm ----------------------------------------------

test('haversineDistanceKm: same point => 0', () => {
    assert.equal(haversineDistanceKm(40.7128, -74.006, 40.7128, -74.006), 0);
});

test('haversineDistanceKm: NYC to LA ~3935km (±50)', () => {
    // 40.7128 N, 74.006 W → 34.0522 N, 118.2437 W
    const d = haversineDistanceKm(40.7128, -74.006, 34.0522, -118.2437);
    assert.ok(Math.abs(d - 3935) < 50, `expected ~3935, got ${d}`);
});

test('haversineDistanceKm: London to Tokyo ~9560km (±100)', () => {
    const d = haversineDistanceKm(51.5074, -0.1278, 35.6762, 139.6503);
    assert.ok(Math.abs(d - 9560) < 100, `expected ~9560, got ${d}`);
});

test('haversineDistanceKm: antipodes ≈ half earth circumference (~20015 km)', () => {
    const d = haversineDistanceKm(0, 0, 0, 180);
    assert.ok(Math.abs(d - 20015) < 50, `expected ~20015, got ${d}`);
});

test('haversineDistanceKm: string inputs are coerced', () => {
    const d = haversineDistanceKm('0', '0', '0', '90');
    assert.ok(Math.abs(d - 10007.5) < 10);
});

// --- continentMultiplier ----------------------------------------------

test('continentMultiplier: Africa / Asia bonus over Europe baseline', () => {
    const europe = continentMultiplier('Europe');
    const africa = continentMultiplier('Africa');
    const asia = continentMultiplier('Asia');
    assert.equal(europe, 1.0);
    assert.ok(africa > europe, 'Africa should reward more than Europe');
    assert.ok(asia > europe, 'Asia should reward more than Europe');
});

test('continentMultiplier: Oceania > Africa/Asia (rarer answers)', () => {
    assert.ok(continentMultiplier('Oceania') >= continentMultiplier('Africa'));
});

test('continentMultiplier: case-insensitive', () => {
    assert.equal(continentMultiplier('africa'), continentMultiplier('Africa'));
    assert.equal(continentMultiplier('  EUROPE  '), continentMultiplier('Europe'));
});

test('continentMultiplier: unknown / empty / null => 1.0', () => {
    assert.equal(continentMultiplier('Atlantis'), 1);
    assert.equal(continentMultiplier(''), 1);
    assert.equal(continentMultiplier(null), 1);
    assert.equal(continentMultiplier(undefined), 1);
});

// --- scoreGuess --------------------------------------------------------

test('scoreGuess: bullseye in Europe => base points exactly', () => {
    const r = scoreGuess({ distanceKm: 0, region: 'Europe' });
    assert.equal(r.points, Config.GLOBE_DROP_BASE_POINTS);
    assert.equal(r.multiplier, 1);
});

test('scoreGuess: bullseye in Africa picks up the bonus', () => {
    const r = scoreGuess({ distanceKm: 0, region: 'Africa' });
    assert.equal(r.points, Math.round(Config.GLOBE_DROP_BASE_POINTS * 1.3));
});

test('scoreGuess: at scaleKm distance => ~37% of base (1/e)', () => {
    const r = scoreGuess({ distanceKm: Config.GLOBE_DROP_DISTANCE_SCALE_KM, region: 'Europe' });
    const expected = Math.round(Config.GLOBE_DROP_BASE_POINTS * Math.exp(-1));
    assert.equal(r.points, expected);
});

test('scoreGuess: continent multiplier compounds with distance score', () => {
    const europe = scoreGuess({ distanceKm: 500, region: 'Europe' });
    const africa = scoreGuess({ distanceKm: 500, region: 'Africa' });
    // Africa is ~1.3x of Europe, but each is rounded independently after
    // its own multiplication — assert within ±1 rather than exact equality.
    assert.ok(Math.abs(africa.points - europe.points * 1.3) <= 1,
        `expected ~${europe.points * 1.3}, got ${africa.points}`);
});

test('scoreGuess: far-side-of-the-world guess lands at the score floor (never 0)', () => {
    const r = scoreGuess({ distanceKm: 20000, region: 'Europe' });
    // The exp-decay value at 20,000 km is well below MIN_POINTS, so the
    // floor takes over — never 0, never negative, never above the floor.
    assert.equal(r.points, Config.GLOBE_DROP_MIN_POINTS);
});

test('scoreGuess: negative / missing distance treated as 0', () => {
    assert.equal(scoreGuess({ distanceKm: -100, region: 'Europe' }).points, Config.GLOBE_DROP_BASE_POINTS);
    assert.equal(scoreGuess({ distanceKm: null, region: 'Europe' }).points, Config.GLOBE_DROP_BASE_POINTS);
});

// --- difficultySettings ------------------------------------------------

test('difficultySettings: known keys return the configured tier', () => {
    assert.equal(difficultySettings('easy').label, 'Easy');
    assert.equal(difficultySettings('medium').label, 'Medium');
    assert.equal(difficultySettings('hard').label, 'Hard');
});

test('difficultySettings: unknown / missing key falls back to medium', () => {
    const fb = difficultySettings(undefined);
    assert.equal(fb.scoreMultiplier, 1);
    const fb2 = difficultySettings('legendary');
    assert.equal(fb2.scoreMultiplier, 1);
});

// --- scoreGuess with difficulty ---------------------------------------

test('scoreGuess: difficulty=medium == no difficulty (legacy parity)', () => {
    const legacy = scoreGuess({ distanceKm: 500, region: 'Europe' });
    const medium = scoreGuess({ distanceKm: 500, region: 'Europe', difficulty: 'medium' });
    assert.equal(legacy.points, medium.points);
    assert.equal(medium.difficultyMultiplier, 1);
});

test('scoreGuess: difficulty=hard multiplies by 1.5x', () => {
    const medium = scoreGuess({ distanceKm: 0, region: 'Europe', difficulty: 'medium' });
    const hard = scoreGuess({ distanceKm: 0, region: 'Europe', difficulty: 'hard' });
    assert.equal(hard.difficultyMultiplier, 1.5);
    assert.equal(hard.points, Math.round(medium.points * 1.5));
});

test('scoreGuess: difficulty=easy multiplies by 0.75x', () => {
    const medium = scoreGuess({ distanceKm: 0, region: 'Europe', difficulty: 'medium' });
    const easy = scoreGuess({ distanceKm: 0, region: 'Europe', difficulty: 'easy' });
    assert.equal(easy.difficultyMultiplier, 0.75);
    assert.equal(easy.points, Math.round(medium.points * 0.75));
});

test('scoreGuess: difficulty compounds with continent multiplier', () => {
    const r = scoreGuess({ distanceKm: 0, region: 'Africa', difficulty: 'hard' });
    // 100 base * 1.3 Africa * 1.5 hard = 195
    assert.equal(r.points, 195);
});

test('scoreGuess: unknown difficulty falls back silently (legacy room safety)', () => {
    const r = scoreGuess({ distanceKm: 0, region: 'Europe', difficulty: 'made-up' });
    assert.equal(r.difficultyMultiplier, 1);
});

// --- populationWeight -------------------------------------------------

test('populationWeight: missing / invalid input returns 1 (no boost, no penalty)', () => {
    assert.equal(populationWeight(undefined), 1);
    assert.equal(populationWeight(null), 1);
    assert.equal(populationWeight(0), 1);
    assert.equal(populationWeight(-100), 1);
    assert.equal(populationWeight('huge'), 1);
});

test('populationWeight: 1 million ≈ 1.0× (reference point)', () => {
    assert.equal(Math.round(populationWeight(1_000_000) * 100), 100);
});

test('populationWeight: megacity (10M) is penalised relative to 1M', () => {
    const ten = populationWeight(10_000_000);
    const one = populationWeight(1_000_000);
    assert.ok(ten < one, 'megacities should be worth less');
    assert.ok(ten >= 0.55, `should not drop below MIN clamp, got ${ten}`);
});

test('populationWeight: small city (100k) earns >1.0× obscurity boost', () => {
    const small = populationWeight(100_000);
    assert.ok(small > 1, `expected >1, got ${small}`);
    assert.ok(small < 2.0, `expected <MAX clamp, got ${small}`);
});

test('populationWeight: clamps to MAX for tiny populations (no infinite reward)', () => {
    const tiny = populationWeight(100);
    assert.equal(tiny, 2.0);
});

// --- scoreGuess with population --------------------------------------

test('scoreGuess: smaller-city guess scores more than big-city at same distance', () => {
    const big = scoreGuess({ distanceKm: 200, region: 'Europe', population: 10_000_000 });
    const small = scoreGuess({ distanceKm: 200, region: 'Europe', population: 100_000 });
    assert.ok(small.points > big.points, `small ${small.points} should beat big ${big.points}`);
});

test('scoreGuess: missing population leaves the score unchanged (legacy capitals)', () => {
    const a = scoreGuess({ distanceKm: 500, region: 'Europe' });
    const b = scoreGuess({ distanceKm: 500, region: 'Europe', population: null });
    assert.equal(a.points, b.points);
    assert.equal(a.populationMultiplier, 1);
});

test('scoreGuess: populationMultiplier surfaces in the result for UI', () => {
    const r = scoreGuess({ distanceKm: 0, region: 'Europe', population: 100_000 });
    assert.ok(r.populationMultiplier > 1);
});

// --- score floor (never 0) -------------------------------------------

test('scoreGuess: antipodal guess earns at least GLOBE_DROP_MIN_POINTS, never 0', () => {
    const r = scoreGuess({ distanceKm: 20000, region: 'Europe' });
    assert.ok(r.points >= Config.GLOBE_DROP_MIN_POINTS, `expected >= floor, got ${r.points}`);
});

test('scoreGuess: floor applies even with hard difficulty 1.5× and obscurity 1.8×', () => {
    const r = scoreGuess({
        distanceKm: 20000,
        region: 'Europe',
        difficulty: 'hard',
        population: 10_000
    });
    assert.ok(r.points >= Config.GLOBE_DROP_MIN_POINTS);
});
