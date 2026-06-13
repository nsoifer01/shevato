'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    normalizeCountry,
    normalizeAsCountry,
    isSmallIslandLocation,
    capSmallIslands,
    capByCountry,
    capByContinent,
    pickWithMultiplierVariety,
    ensureMinContinents,
    capHardLocations,
    ROUND_TYPES
} = require('../js/globe-drop-locations.js');

function rawCountry(over = {}) {
    return Object.assign({
        name: { common: 'France', official: 'French Republic' },
        capital: ['Paris'],
        capitalInfo: { latlng: [48.87, 2.33] },
        region: 'Europe',
        subregion: 'Western Europe',
        ccn3: '250'  // France ISO 3166-1 numeric
    }, over);
}

// --- happy path -------------------------------------------------------

test('normalizeCountry: well-formed record => internal location shape', () => {
    const out = normalizeCountry(rawCountry());
    assert.equal(out.id, 'france');
    assert.equal(out.name, 'Paris');
    assert.equal(out.country, 'France');
    assert.equal(out.region, 'Europe');
    assert.equal(out.subregion, 'Western Europe');
    assert.equal(out.countryCode, '250');
    assert.equal(out.lat, 48.87);
    assert.equal(out.lng, 2.33);
});

test('normalizeCountry: id slugifies multi-word country names', () => {
    const out = normalizeCountry(rawCountry({
        name: { common: 'United States' }
    }));
    assert.equal(out.id, 'united-states');
});

test('normalizeCountry: id strips weird punctuation', () => {
    const out = normalizeCountry(rawCountry({
        name: { common: "Côte d'Ivoire" }
    }));
    // Punctuation collapsed to single dashes, no leading/trailing dashes.
    assert.match(out.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

// --- bad data => null --------------------------------------------------

test('normalizeCountry: missing capital => null', () => {
    assert.equal(normalizeCountry(rawCountry({ capital: [] })), null);
    assert.equal(normalizeCountry(rawCountry({ capital: undefined })), null);
});

test('normalizeCountry: capital with only empty strings => null', () => {
    assert.equal(normalizeCountry(rawCountry({ capital: ['', '   '] })), null);
});

test('normalizeCountry: missing capitalInfo.latlng => falls back to country latlng', () => {
    const out = normalizeCountry(rawCountry({
        capitalInfo: {},
        latlng: [31.5, 34.75] // country centroid
    }));
    assert.equal(out.lat, 31.5);
    assert.equal(out.lng, 34.75);
});

test('normalizeCountry: no coords anywhere => null', () => {
    assert.equal(normalizeCountry(rawCountry({ capitalInfo: {}, latlng: undefined })), null);
});

test('normalizeCountry: malformed latlng arrays => null', () => {
    assert.equal(normalizeCountry(rawCountry({ capitalInfo: { latlng: [48.87] } })), null);
    assert.equal(normalizeCountry(rawCountry({ capitalInfo: { latlng: ['a', 'b'] } })), null);
});

test('normalizeCountry: missing region => defaults to "Unknown"', () => {
    const out = normalizeCountry(rawCountry({ region: undefined }));
    assert.equal(out.region, 'Unknown');
});

test('normalizeCountry: missing common name => "Unknown country"', () => {
    const out = normalizeCountry(rawCountry({ name: { official: 'Foo Republic' } }));
    assert.equal(out.country, 'Unknown country');
    assert.equal(out.id, 'unknown-country');
});

test('normalizeCountry: malformed root => null', () => {
    assert.equal(normalizeCountry(null), null);
    assert.equal(normalizeCountry('string'), null);
    assert.equal(normalizeCountry(42), null);
});

// --- normalizeAsCountry (countries-flip mode) --------------------------

function rawCountryWithCentroid(over = {}) {
    return Object.assign({
        name: { common: 'France', official: 'French Republic' },
        latlng: [46, 2],
        region: 'Europe',
        subregion: 'Western Europe',
        ccn3: '250'
    }, over);
}

test('normalizeAsCountry: well-formed record => country-centred location', () => {
    const out = normalizeAsCountry(rawCountryWithCentroid());
    assert.equal(out.id, 'country-france');
    assert.equal(out.name, 'France');
    assert.equal(out.country, '');         // the prompt IS the country, no extra line
    assert.equal(out.region, 'Europe');
    assert.equal(out.subregion, 'Western Europe');
    assert.equal(out.lat, 46);
    assert.equal(out.lng, 2);
});

test('normalizeAsCountry: missing latlng => null', () => {
    assert.equal(normalizeAsCountry(rawCountryWithCentroid({ latlng: undefined })), null);
    assert.equal(normalizeAsCountry(rawCountryWithCentroid({ latlng: [46] })), null);
});

test('normalizeAsCountry: missing common name => null', () => {
    assert.equal(normalizeAsCountry(rawCountryWithCentroid({ name: { official: 'Foo' } })), null);
});

test('normalizeAsCountry: id prefix distinguishes countries from capitals', () => {
    const cap = normalizeCountry({
        name: { common: 'France' }, capital: ['Paris'],
        capitalInfo: { latlng: [48.87, 2.33] }, region: 'Europe'
    });
    const cou = normalizeAsCountry(rawCountryWithCentroid());
    assert.notEqual(cap.id, cou.id, 'capitals and countries must have distinct ids');
    assert.ok(cou.id.startsWith('country-'));
});

// --- ROUND_TYPES registry ---------------------------------------------

test('ROUND_TYPES: all four round types are registered', () => {
    assert.ok(ROUND_TYPES.capitals);
    assert.ok(ROUND_TYPES.countries);
    assert.ok(ROUND_TYPES['major-cities']);
    assert.ok(ROUND_TYPES.landmarks);
});

test('ROUND_TYPES: every type has a label, packId, and packName', () => {
    for (const [key, meta] of Object.entries(ROUND_TYPES)) {
        assert.ok(meta.label, `${key} missing label`);
        assert.ok(meta.packId, `${key} missing packId`);
        assert.ok(meta.packName, `${key} missing packName`);
    }
});

test('ROUND_TYPES: includes top-cities-by-country mode', () => {
    assert.ok(ROUND_TYPES['top-cities-by-country']);
});

// --- isSmallIslandLocation -------------------------------------------

function loc(over) {
    return Object.assign({
        countryAreaSqKm: 100000,
        subregion: 'Western Europe'
    }, over || {});
}

test('isSmallIslandLocation: false when area is large', () => {
    assert.equal(isSmallIslandLocation(loc({ countryAreaSqKm: 600000, subregion: 'Caribbean' })), false);
});

test('isSmallIslandLocation: false when subregion is not an island cluster', () => {
    assert.equal(isSmallIslandLocation(loc({ countryAreaSqKm: 300, subregion: 'Western Europe' })), false);
});

test('isSmallIslandLocation: true for small Caribbean nation', () => {
    assert.equal(isSmallIslandLocation(loc({ countryAreaSqKm: 442, subregion: 'Caribbean' })), true);
});

test('isSmallIslandLocation: true for small Polynesian nation', () => {
    assert.equal(isSmallIslandLocation(loc({ countryAreaSqKm: 26, subregion: 'Polynesia' })), true);
});

test('isSmallIslandLocation: missing area treated as non-island', () => {
    assert.equal(isSmallIslandLocation(loc({ countryAreaSqKm: null, subregion: 'Caribbean' })), false);
});

// --- capSmallIslands -------------------------------------------------

test('capSmallIslands: keeps everything when nothing is an island', () => {
    const list = [loc({}), loc({}), loc({})];
    const out = capSmallIslands(list, 2);
    assert.equal(out.length, 3);
});

test('capSmallIslands: keeps up to N islands at the head; pushes extras to tail', () => {
    const big = loc({ name: 'big' });
    const island1 = loc({ name: 'island1', countryAreaSqKm: 300, subregion: 'Caribbean' });
    const island2 = loc({ name: 'island2', countryAreaSqKm: 300, subregion: 'Caribbean' });
    const island3 = loc({ name: 'island3', countryAreaSqKm: 300, subregion: 'Caribbean' });
    const out = capSmallIslands([island1, big, island2, island3], 2);
    // First three slots should be the two kept islands + the non-island,
    // in original order; the third island gets pushed to the end.
    assert.equal(out[0].name, 'island1');
    assert.equal(out[1].name, 'big');
    assert.equal(out[2].name, 'island2');
    assert.equal(out[3].name, 'island3');
});

test('capSmallIslands: zero cap pushes ALL islands to the tail', () => {
    const big = loc({ name: 'big' });
    const islandA = loc({ name: 'islandA', countryAreaSqKm: 300, subregion: 'Caribbean' });
    const islandB = loc({ name: 'islandB', countryAreaSqKm: 300, subregion: 'Polynesia' });
    const out = capSmallIslands([islandA, islandB, big], 0);
    assert.equal(out[0].name, 'big');
});

test('capSmallIslands: with a 5-slot game playlist, at most 2 islands reach the head', () => {
    const arr = [];
    for (let i = 0; i < 10; i++) arr.push(loc({ name: 'island' + i, countryAreaSqKm: 300, subregion: 'Caribbean' }));
    for (let i = 0; i < 10; i++) arr.push(loc({ name: 'big' + i }));
    const out = capSmallIslands(arr, Config.GLOBE_DROP_SMALL_ISLAND_MAX_PER_GAME);
    const headIslands = out.slice(0, 5).filter(isSmallIslandLocation);
    assert.ok(headIslands.length <= Config.GLOBE_DROP_SMALL_ISLAND_MAX_PER_GAME);
});

// --- capByCountry ------------------------------------------------------

test('capByCountry: keeps first N per country, drops the excess', () => {
    const arr = [
        { id: '1', name: 'Wuhan',    country: 'China' },
        { id: '2', name: 'Shanghai', country: 'China' },
        { id: '3', name: 'Changsha', country: 'China' },
        { id: '4', name: 'Mumbai',   country: 'India' },
        { id: '5', name: 'Beijing',  country: 'China' }
    ];
    const out = capByCountry(arr, 2);
    // First two Chinese + Mumbai survive; the rest are filtered out.
    assert.deepEqual(out.map((l) => l.id), ['1', '2', '4']);
});

test('capByCountry: cap of 1 dedupes one per country', () => {
    const arr = [
        { country: 'A' }, { country: 'A' }, { country: 'B' }, { country: 'A' }
    ];
    const out = capByCountry(arr, 1);
    assert.deepEqual(out.map((l) => l.country), ['A', 'B']);
});

test('capByCountry: empty-country entries are exempt from the cap', () => {
    // The 'countries' round sets country: '' on every location (the
    // location IS the country). Bucketing those under '' used to
    // collapse the whole pool to the first N entries.
    const arr = [
        { id: 'c1', name: 'France',  country: '' },
        { id: 'c2', name: 'Brazil',  country: '' },
        { id: 'c3', name: 'Japan',   country: '' },
        { id: 'c4', name: 'Kenya',   country: '' },
        { id: 'x1', name: 'Wuhan',   country: 'China' },
        { id: 'x2', name: 'Beijing', country: 'China' },
        { id: 'x3', name: 'Changsha', country: 'China' }
    ];
    const out = capByCountry(arr, 2);
    // All four countries survive; China still capped at 2.
    assert.deepEqual(out.map((l) => l.id), ['c1', 'c2', 'c3', 'c4', 'x1', 'x2']);
});

// --- capByContinent ----------------------------------------------------

test('capByContinent: 30% cap on a 5-slot game keeps max 2 per continent', () => {
    // 5 × 0.3 = 1.5 → ceil = 2 → max 2 per continent.
    const arr = [
        { id: '1', region: 'Asia' },   { id: '2', region: 'Asia' },
        { id: '3', region: 'Asia' },   { id: '4', region: 'Asia' },
        { id: '5', region: 'Europe' }, { id: '6', region: 'Africa' }
    ];
    const out = capByContinent(arr, 0.3, 5);
    // First two Asia survive, then Europe, then Africa — excess Asia dropped.
    assert.deepEqual(out.map((l) => l.id), ['1', '2', '5', '6']);
});

test('capByContinent: 10-slot 30% cap drops 4th+ of any continent', () => {
    // Hard cap — over-fetched callers feed the filtered pool into a
    // variety pick. With 6 Asia + 4 Europe, only the first 3 Asia +
    // 3 Europe survive (cap = ceil(10 × 0.3) = 3).
    const arr = [];
    for (let i = 0; i < 6; i++) arr.push({ id: 'a' + i, region: 'Asia' });
    for (let i = 0; i < 4; i++) arr.push({ id: 'e' + i, region: 'Europe' });
    const out = capByContinent(arr, 0.3, 10);
    assert.deepEqual(out.map((l) => l.id),
                     ['a0', 'a1', 'a2', 'e0', 'e1', 'e2']);
});

test('capByContinent: empty / non-array => []', () => {
    assert.deepEqual(capByContinent([], 0.3, 5), []);
    assert.deepEqual(capByContinent(null, 0.3, 5), []);
});

// --- pickWithMultiplierVariety -----------------------------------------

test('pickWithMultiplierVariety: 1 from each tier, ladder ascending', () => {
    const pool = [
        { id: 'a', multiplier: 1.0 }, { id: 'b', multiplier: 1.0 },
        { id: 'c', multiplier: 1.5 }, { id: 'd', multiplier: 2.0 },
        { id: 'e', multiplier: 2.5 }, { id: 'f', multiplier: 3.0 },
        { id: 'g', multiplier: 1.0 }
    ];
    const out = pickWithMultiplierVariety(pool, 5);
    assert.deepEqual(out.map((l) => l.id), ['a', 'c', 'd', 'e', 'f']);
});

test('pickWithMultiplierVariety: fills by round-robin when one tier dominates', () => {
    // 4 × ×1 + 1 × ×3 → target 5 → take ×1, ×3, then keep pulling ×1.
    const pool = [
        { id: 'a', multiplier: 1.0 }, { id: 'b', multiplier: 1.0 },
        { id: 'c', multiplier: 1.0 }, { id: 'd', multiplier: 1.0 },
        { id: 'e', multiplier: 3.0 }
    ];
    const out = pickWithMultiplierVariety(pool, 5);
    // First a (×1), then e (×3), then b/c/d.
    assert.deepEqual(out.map((l) => l.id), ['a', 'e', 'b', 'c', 'd']);
});

test('pickWithMultiplierVariety: gracefully takes only what is available', () => {
    const pool = [{ id: '1', multiplier: 1.5 }, { id: '2', multiplier: 1.5 }];
    const out = pickWithMultiplierVariety(pool, 5);
    assert.equal(out.length, 2);
});

test('pickWithMultiplierVariety: unknown multipliers fall into the ×1 bucket', () => {
    const pool = [
        { id: 'x' },                          // no multiplier
        { id: 'y', multiplier: 1.7 },         // off-ladder
        { id: 'a', multiplier: 1.5 }
    ];
    const out = pickWithMultiplierVariety(pool, 3);
    // ×1 bucket gets x + y (off-ladder fallback). Order: x (×1), a (×1.5), y (×1).
    assert.deepEqual(out.map((l) => l.id), ['x', 'a', 'y']);
});

// --- ensureMinContinents -----------------------------------------------

function distinctRegions(arr) {
    return new Set(arr.map((l) => String(l && l.region || 'Unknown'))).size;
}

test('ensureMinContinents: a 2-region pick rises to 3 when the pool has a 3rd', () => {
    const picked = [
        { id: 'a1', region: 'Asia' },
        { id: 'a2', region: 'Asia' },
        { id: 'e1', region: 'Europe' }
    ];
    const pool = picked.concat([{ id: 'f1', region: 'Africa' }]);
    const out = ensureMinContinents(picked, pool, 3, 3);
    assert.equal(out.length, 3);
    assert.equal(distinctRegions(out), 3);
    // The over-represented Asia bucket is what got trimmed, not Europe.
    assert.ok(out.some((l) => l.region === 'Europe'));
    assert.ok(out.some((l) => l.region === 'Africa'));
});

test('ensureMinContinents: target=4 pick with a >=3-region pool spans >=3 regions', () => {
    // The specific gap this fixes: capByContinent(cap=2) allows a 2+2
    // split into only 2 continents for a 4-location game.
    const picked = [
        { id: 'a1', region: 'Asia' },
        { id: 'a2', region: 'Asia' },
        { id: 'e1', region: 'Europe' },
        { id: 'e2', region: 'Europe' }
    ];
    const pool = picked.concat([
        { id: 'f1', region: 'Africa' },
        { id: 'o1', region: 'Oceania' }
    ]);
    const out = ensureMinContinents(picked, pool, 4, 3);
    assert.equal(out.length, 4);
    assert.ok(distinctRegions(out) >= 3, `expected >=3 regions, got ${distinctRegions(out)}`);
});

test('ensureMinContinents: degenerate pool with only 2 regions returns target items', () => {
    const picked = [
        { id: 'a1', region: 'Asia' },
        { id: 'a2', region: 'Asia' },
        { id: 'e1', region: 'Europe' }
    ];
    const pool = picked.concat([{ id: 'e2', region: 'Europe' }]);
    const out = ensureMinContinents(picked, pool, 3, 3);
    assert.equal(out.length, 3);
    // Only 2 regions exist anywhere; it spans exactly those 2, no throw.
    assert.equal(distinctRegions(out), 2);
});

test('ensureMinContinents: never introduces duplicates and keeps length == target', () => {
    const picked = [
        { id: 'a1', region: 'Asia' },
        { id: 'a2', region: 'Asia' },
        { id: 'a3', region: 'Asia' }
    ];
    const pool = picked.concat([
        { id: 'e1', region: 'Europe' },
        { id: 'f1', region: 'Africa' }
    ]);
    const out = ensureMinContinents(picked, pool, 3, 3);
    assert.equal(out.length, 3);
    assert.equal(new Set(out).size, 3, 'no duplicate location references');
    assert.equal(distinctRegions(out), 3);
});

test('ensureMinContinents: prefers KNOWN regions over Unknown when swapping in', () => {
    const picked = [
        { id: 'a1', region: 'Asia' },
        { id: 'a2', region: 'Asia' },
        { id: 'e1', region: 'Europe' }
    ];
    // Pool offers both an Unknown and a known Africa for the 3rd slot.
    const pool = picked.concat([
        { id: 'u1', region: 'Unknown' },
        { id: 'f1', region: 'Africa' }
    ]);
    const out = ensureMinContinents(picked, pool, 3, 3);
    assert.ok(out.some((l) => l.region === 'Africa'), 'should pull the known region in');
    assert.ok(!out.some((l) => l.region === 'Unknown'), 'should not pull Unknown when a known region is available');
});

test('ensureMinContinents: already-diverse pick is returned unchanged', () => {
    const picked = [
        { id: 'a1', region: 'Asia' },
        { id: 'e1', region: 'Europe' },
        { id: 'f1', region: 'Africa' }
    ];
    const out = ensureMinContinents(picked, picked.slice(), 3, 3);
    assert.deepEqual(out.map((l) => l.id), ['a1', 'e1', 'f1']);
});

test('ensureMinContinents: degenerate inputs do not throw', () => {
    assert.deepEqual(ensureMinContinents(null, null, 3, 3), []);
    assert.deepEqual(ensureMinContinents([], [], 3, 3), []);
});

// --- capHardLocations --------------------------------------------------

const hardCount = (arr, thresh = 2.5) => arr.filter((l) => (Number(l.multiplier) || 1) >= thresh).length;

test('capHardLocations: trims a bimodal 5-pick from 3 hard down to the 40% cap of 2', () => {
    // The real-world failure: 2 famous capitals + 3 obscure island specks.
    const picked = [
        { id: 'easy1',  region: 'Africa',   multiplier: 1.0 },
        { id: 'easy2',  region: 'Africa',   multiplier: 1.0 },
        { id: 'hard25a', region: 'Americas', multiplier: 2.5 },
        { id: 'hard25b', region: 'Europe',   multiplier: 2.5 },
        { id: 'hard30',  region: 'Oceania',  multiplier: 3.0 }
    ];
    // Pool has easier spares to swap in.
    const pool = picked.concat([
        { id: 'spare15', region: 'Asia',     multiplier: 1.5 },
        { id: 'spare20', region: 'Americas', multiplier: 2.0 }
    ]);
    const out = capHardLocations(picked, pool, 5, 0.4, 2.5);
    assert.equal(out.length, 5, 'length stays == target');
    assert.ok(hardCount(out) <= 2, `expected <=2 hard, got ${hardCount(out)}`);
    // The single hardest (x3.0) is preserved for the finale; a x2.5 is dropped.
    assert.ok(out.some((l) => l.id === 'hard30'), 'keeps the x3.0 for the climactic round');
});

test('capHardLocations: relaxes when the pool has no easier locations to swap in', () => {
    // Everything is hard; the cap cannot be met without dropping below target.
    const picked = [
        { id: 'h1', region: 'Asia',    multiplier: 2.5 },
        { id: 'h2', region: 'Europe',  multiplier: 3.0 },
        { id: 'h3', region: 'Africa',  multiplier: 2.5 }
    ];
    const out = capHardLocations(picked, picked.slice(), 3, 0.4, 2.5);
    assert.equal(out.length, 3, 'filling the game to target wins over the cap');
    assert.equal(new Set(out).size, 3, 'no duplicates introduced');
});

test('capHardLocations: a pick already within the cap is returned unchanged', () => {
    const picked = [
        { id: 'e1', region: 'Asia',    multiplier: 1.0 },
        { id: 'e2', region: 'Europe',  multiplier: 1.5 },
        { id: 'h1', region: 'Africa',  multiplier: 3.0 }
    ];
    const pool = picked.concat([{ id: 'e3', region: 'Americas', multiplier: 1.0 }]);
    const out = capHardLocations(picked, pool, 3, 0.4, 2.5);
    assert.deepEqual(out.map((l) => l.id), ['e1', 'e2', 'h1']);
});

test('capHardLocations: no duplicates and length stable after a swap', () => {
    const picked = [
        { id: 'h1', region: 'Asia',     multiplier: 2.5 },
        { id: 'h2', region: 'Europe',   multiplier: 2.5 },
        { id: 'h3', region: 'Africa',   multiplier: 3.0 }
    ];
    const pool = picked.concat([
        { id: 'e1', region: 'Americas', multiplier: 1.0 },
        { id: 'e2', region: 'Oceania',  multiplier: 1.0 }
    ]);
    const out = capHardLocations(picked, pool, 3, 0.4, 2.5);
    assert.equal(out.length, 3);
    assert.equal(new Set(out).size, 3, 'no duplicate references');
    // 3-game cap = ceil(3*0.4) = 2; 3 hard picked -> trimmed to 2.
    assert.equal(hardCount(out), 2, `expected 2 hard after trim, got ${hardCount(out)}`);
});

test('capHardLocations: cap is ceil(target*0.4) -> 2 for a 5-game, 4 for a 10-game', () => {
    const mk = (n, mult) => Array.from({ length: n }, (_, i) => ({ id: `${mult}_${i}`, region: 'Asia', multiplier: mult }));
    // 5-game: 5 hard picked, plenty of easy spares -> trimmed to 2 hard.
    const picked5 = mk(5, 3.0);
    const pool5 = picked5.concat(mk(10, 1.0));
    assert.equal(hardCount(capHardLocations(picked5, pool5, 5, 0.4, 2.5)), 2);
    // 10-game: 10 hard picked, easy spares -> trimmed to 4 hard.
    const picked10 = mk(10, 3.0);
    const pool10 = picked10.concat(mk(20, 1.0));
    assert.equal(hardCount(capHardLocations(picked10, pool10, 10, 0.4, 2.5)), 4);
});

test('capHardLocations: no-op when multipliers are absent (no Scoring module)', () => {
    const picked = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = capHardLocations(picked, picked.slice(), 3, 0.4, 2.5);
    assert.deepEqual(out.map((l) => l.id), ['a', 'b', 'c']);
});

test('capHardLocations: degenerate inputs do not throw', () => {
    assert.deepEqual(capHardLocations(null, null, 5, 0.4, 2.5), []);
    assert.deepEqual(capHardLocations([], [], 5, 0.4, 2.5), []);
});
