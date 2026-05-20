'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    haversineDistanceKm,
    continentMultiplier,
    difficultySettings,
    populationWeight,
    scoreGuess,
    ROUND_MULTIPLIERS,
    roundMultiplierForIndex,
    assignRoundMultipliers,
    quantizeToLadder,
    locationDifficultyScore,
    assignDifficultyMultipliers
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

// --- round-multiplier ladder ------------------------------------------

test('ROUND_MULTIPLIERS: fixed 5-step ladder 1.0 → 3.0', () => {
    assert.deepEqual(ROUND_MULTIPLIERS, [1.0, 1.5, 2.0, 2.5, 3.0]);
});

test('roundMultiplierForIndex: 5 rounds uses every step in order', () => {
    const got = [0, 1, 2, 3, 4].map((i) => roundMultiplierForIndex(i, 5));
    assert.deepEqual(got, [1.0, 1.5, 2.0, 2.5, 3.0]);
});

test('roundMultiplierForIndex: 10 rounds doubles each step', () => {
    const got = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => roundMultiplierForIndex(i, 10));
    assert.deepEqual(got, [1.0, 1.0, 1.5, 1.5, 2.0, 2.0, 2.5, 2.5, 3.0, 3.0]);
});

test('roundMultiplierForIndex: 3 rounds picks 1.0 / 2.0 / 3.0', () => {
    const got = [0, 1, 2].map((i) => roundMultiplierForIndex(i, 3));
    assert.deepEqual(got, [1.0, 2.0, 3.0]);
});

test('roundMultiplierForIndex: 1 round always 1.0', () => {
    assert.equal(roundMultiplierForIndex(0, 1), 1.0);
});

test('roundMultiplierForIndex: monotonic non-decreasing across any N', () => {
    for (let n = 1; n <= 20; n++) {
        let prev = 0;
        for (let i = 0; i < n; i++) {
            const m = roundMultiplierForIndex(i, n);
            assert.ok(m >= prev, `n=${n} i=${i} mult=${m} prev=${prev}`);
            prev = m;
        }
    }
});

test('roundMultiplierForIndex: first round always 1.0, last always 3.0', () => {
    for (let n = 2; n <= 12; n++) {
        assert.equal(roundMultiplierForIndex(0, n),     1.0, `n=${n} first`);
        assert.equal(roundMultiplierForIndex(n - 1, n), 3.0, `n=${n} last`);
    }
});

test('assignRoundMultipliers: stamps multiplier onto each location in order', () => {
    const locs = [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' }
    ];
    const out = assignRoundMultipliers(locs);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((l) => l.multiplier), [1.0, 2.0, 3.0]);
    // Input not mutated:
    assert.equal(locs[0].multiplier, undefined);
});

test('assignRoundMultipliers: preserves location order (no internal sort)', () => {
    const locs = [
        { id: 'first',  name: 'First' },
        { id: 'second', name: 'Second' },
        { id: 'third',  name: 'Third' },
        { id: 'fourth', name: 'Fourth' },
        { id: 'fifth',  name: 'Fifth' }
    ];
    const out = assignRoundMultipliers(locs);
    assert.deepEqual(out.map((l) => l.id), ['first', 'second', 'third', 'fourth', 'fifth']);
});

test('assignRoundMultipliers: empty / non-array inputs => []', () => {
    assert.deepEqual(assignRoundMultipliers([]), []);
    assert.deepEqual(assignRoundMultipliers(null), []);
    assert.deepEqual(assignRoundMultipliers(undefined), []);
});

// --- scoreGuess new model (single round multiplier) -------------------

test('scoreGuess(new): bullseye × 1.0 => base points exactly', () => {
    const r = scoreGuess({ distanceKm: 0, multiplier: 1.0 });
    assert.equal(r.points, Config.GLOBE_DROP_BASE_POINTS);
    assert.equal(r.multiplier, 1.0);
});

test('scoreGuess(new): bullseye × 2.0 => double base', () => {
    const r = scoreGuess({ distanceKm: 0, multiplier: 2.0 });
    assert.equal(r.points, Config.GLOBE_DROP_BASE_POINTS * 2);
});

test('scoreGuess(new): bullseye × 3.0 => triple base', () => {
    const r = scoreGuess({ distanceKm: 0, multiplier: 3.0 });
    assert.equal(r.points, Config.GLOBE_DROP_BASE_POINTS * 3);
});

test('scoreGuess(new): explicit multiplier overrides legacy region / pop / difficulty', () => {
    // Even with rich legacy inputs, when `multiplier` is supplied
    // it should be the SOLE multiplier applied to base × decay.
    const r = scoreGuess({
        distanceKm: 0,
        multiplier: 1.5,
        region: 'Africa',
        difficulty: 'hard',
        population: 10_000
    });
    assert.equal(r.points, Math.round(Config.GLOBE_DROP_BASE_POINTS * 1.5));
});

test('scoreGuess(new): distance decay scales with multiplier', () => {
    // At scaleKm, base * exp(-1) ≈ 37 points. ×3.0 ≈ 110-111.
    // Each result is rounded independently after its own multiplication,
    // so allow ±1 instead of strict equality (same convention as the
    // continent-multiplier compounding test above).
    const r1 = scoreGuess({ distanceKm: Config.GLOBE_DROP_DISTANCE_SCALE_KM, multiplier: 1.0 });
    const r3 = scoreGuess({ distanceKm: Config.GLOBE_DROP_DISTANCE_SCALE_KM, multiplier: 3.0 });
    assert.ok(Math.abs(r3.points - r1.points * 3) <= 1,
        `expected ~${r1.points * 3}, got ${r3.points}`);
});

test('scoreGuess(new): falls back to legacy compound math when multiplier omitted', () => {
    // No `multiplier` field — should keep using region/diff/pop chain
    // so callers that haven't migrated stay working.
    const r = scoreGuess({ distanceKm: 0, region: 'Africa' });
    assert.ok('difficultyMultiplier' in r);
    assert.ok('populationMultiplier' in r);
});

// --- difficulty-driven multiplier assignment --------------------------

test('quantizeToLadder: snaps to nearest 0.5 step', () => {
    assert.equal(quantizeToLadder(1.0), 1.0);
    assert.equal(quantizeToLadder(1.2), 1.0);
    assert.equal(quantizeToLadder(1.3), 1.5);
    assert.equal(quantizeToLadder(1.7), 1.5);
    assert.equal(quantizeToLadder(1.8), 2.0);
    assert.equal(quantizeToLadder(2.5), 2.5);
    assert.equal(quantizeToLadder(2.74), 2.5);
    assert.equal(quantizeToLadder(2.76), 3.0);
});

test('quantizeToLadder: clamps below 1.0 and above 3.0', () => {
    assert.equal(quantizeToLadder(0.3), 1.0);
    assert.equal(quantizeToLadder(0.99), 1.0);
    assert.equal(quantizeToLadder(3.5), 3.0);
    assert.equal(quantizeToLadder(10), 3.0);
});

test('quantizeToLadder: non-finite => 1.0 (safe floor)', () => {
    assert.equal(quantizeToLadder(NaN), 1.0);
    assert.equal(quantizeToLadder(Infinity), 1.0);
});

test('locationDifficultyScore: famous European capital easier than obscure island capital', () => {
    const london    = { region: 'Europe',  subregion: 'Northern Europe', countryAreaSqKm: 242495 };
    const stGeorges = { region: 'Americas', subregion: 'Caribbean',       countryAreaSqKm: 344 };
    assert.ok(
        locationDifficultyScore(stGeorges) > locationDifficultyScore(london),
        "expected St. George's > London on difficulty"
    );
});

test('locationDifficultyScore: missing fields fall back to neutral (1.0)', () => {
    assert.equal(locationDifficultyScore({}), 1);
    assert.equal(locationDifficultyScore(null), 1);
});

test('locationDifficultyScore: obscure subregion adds boost', () => {
    const eastAfrica  = { region: 'Africa', subregion: 'Eastern Africa', countryAreaSqKm: 800000 };
    const middleAfrica = { region: 'Africa', subregion: 'Middle Africa', countryAreaSqKm: 800000 };
    assert.ok(
        locationDifficultyScore(middleAfrica) > locationDifficultyScore(eastAfrica),
        'Middle Africa is in OBSCURE_SUBREGIONS, should outrank Eastern Africa'
    );
});

test('locationDifficultyScore: small country area adds graduated boost', () => {
    const big   = { region: 'Europe', subregion: 'Western Europe', countryAreaSqKm: 500000 };
    const mid   = { region: 'Europe', subregion: 'Western Europe', countryAreaSqKm: 15000 };
    const tiny  = { region: 'Europe', subregion: 'Western Europe', countryAreaSqKm: 100 };
    assert.ok(locationDifficultyScore(mid)  > locationDifficultyScore(big),  'mid > big');
    assert.ok(locationDifficultyScore(tiny) > locationDifficultyScore(mid),  'tiny > mid');
});

test('assignDifficultyMultipliers: real-world capitals match expected tiers', () => {
    const cities = [
        { id: 'london',     region: 'Europe',    subregion: 'Northern Europe', countryAreaSqKm: 242495, expect: 1.0 },
        { id: 'brussels',   region: 'Europe',    subregion: 'Western Europe',  countryAreaSqKm: 30528,  expect: 1.0 },
        { id: 'pretoria',   region: 'Africa',    subregion: 'Southern Africa', countryAreaSqKm: 1221037, expect: 1.5 },
        { id: 'maputo',     region: 'Africa',    subregion: 'Eastern Africa',  countryAreaSqKm: 801590, expect: 1.5 },
        { id: 'cdlp',       region: 'Africa',    subregion: 'Middle Africa',   countryAreaSqKm: 28051,  expect: 2.0 },
        { id: 'stgeorges',  region: 'Americas',  subregion: 'Caribbean',       countryAreaSqKm: 344,    expect: 2.5 },
        { id: 'thevalley',  region: 'Americas',  subregion: 'Caribbean',       countryAreaSqKm: 91,     expect: 2.5 },
        { id: 'funafuti',   region: 'Oceania',   subregion: 'Polynesia',       countryAreaSqKm: 26,     expect: 3.0 }
    ];
    const out = assignDifficultyMultipliers(cities);
    out.forEach((loc, i) => {
        assert.equal(loc.multiplier, cities[i].expect,
            `${cities[i].id}: expected ×${cities[i].expect}, got ×${loc.multiplier}`);
    });
});

test('assignDifficultyMultipliers: every stamp is a valid ladder value', () => {
    const locs = [
        { region: 'Europe',    subregion: 'Northern Europe', countryAreaSqKm: 9_000_000 },
        { region: 'Americas',  subregion: 'Caribbean',       countryAreaSqKm: 100 },
        { region: 'Africa',    subregion: 'Middle Africa',   countryAreaSqKm: 28051 },
        { region: 'Asia',      subregion: 'Western Asia',    countryAreaSqKm: 86600 },
        { region: 'Oceania',   subregion: 'Polynesia',       countryAreaSqKm: 26 },
        { region: 'Antarctic', subregion: '',                countryAreaSqKm: null },
        { region: 'Unknown',   subregion: '',                countryAreaSqKm: null }
    ];
    const out = assignDifficultyMultipliers(locs);
    out.forEach((loc) => {
        assert.ok(ROUND_MULTIPLIERS.includes(loc.multiplier),
            `multiplier ${loc.multiplier} not in ${JSON.stringify(ROUND_MULTIPLIERS)}`);
    });
});

test('assignDifficultyMultipliers: preserves input order (no internal sort)', () => {
    const locs = [
        { id: 'a', region: 'Europe',   subregion: 'Western Europe',  countryAreaSqKm: 200000 },
        { id: 'b', region: 'Oceania',  subregion: 'Polynesia',       countryAreaSqKm: 26 },
        { id: 'c', region: 'Asia',     subregion: 'Eastern Asia',    countryAreaSqKm: 100000 }
    ];
    const out = assignDifficultyMultipliers(locs);
    assert.deepEqual(out.map((l) => l.id), ['a', 'b', 'c']);
});

test('assignDifficultyMultipliers: empty / non-array => []', () => {
    assert.deepEqual(assignDifficultyMultipliers([]), []);
    assert.deepEqual(assignDifficultyMultipliers(null), []);
    assert.deepEqual(assignDifficultyMultipliers(undefined), []);
});

test('assignDifficultyMultipliers: same location ALWAYS gets same multiplier', () => {
    // Position-independence is the whole point of the new model —
    // Baku should be Baku regardless of when it's played.
    const baku = { id: 'baku', name: 'Baku', region: 'Asia', subregion: 'Western Asia', countryAreaSqKm: 86600 };
    const m1 = assignDifficultyMultipliers([baku])[0].multiplier;
    const m2 = assignDifficultyMultipliers([baku, baku, baku])[2].multiplier;
    const m3 = assignDifficultyMultipliers([{}, baku])[1].multiplier;
    assert.equal(m1, m2);
    assert.equal(m1, m3);
});
