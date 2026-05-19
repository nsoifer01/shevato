'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    haversineDistanceKm,
    continentMultiplier,
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

test('scoreGuess: far-side-of-the-world guess approaches 0', () => {
    const r = scoreGuess({ distanceKm: 20000, region: 'Europe' });
    assert.ok(r.points < 5, `expected <5, got ${r.points}`);
    assert.ok(r.points >= 0, 'never negative');
});

test('scoreGuess: negative / missing distance treated as 0', () => {
    assert.equal(scoreGuess({ distanceKm: -100, region: 'Europe' }).points, Config.GLOBE_DROP_BASE_POINTS);
    assert.equal(scoreGuess({ distanceKm: null, region: 'Europe' }).points, Config.GLOBE_DROP_BASE_POINTS);
});
