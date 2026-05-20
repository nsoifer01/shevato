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

test('capByCountry: keeps up to N from same country in head order', () => {
    const arr = [
        { id: '1', name: 'Wuhan',    country: 'China' },
        { id: '2', name: 'Shanghai', country: 'China' },
        { id: '3', name: 'Changsha', country: 'China' },
        { id: '4', name: 'Mumbai',   country: 'India' },
        { id: '5', name: 'Beijing',  country: 'China' }
    ];
    const out = capByCountry(arr, 2);
    // First 2 China entries kept, plus Mumbai, with Changsha + Beijing pushed.
    assert.deepEqual(out.slice(0, 3).map((l) => l.id), ['1', '2', '4']);
    // Tail has the rest, original order preserved.
    assert.deepEqual(out.slice(3).map((l) => l.id), ['3', '5']);
});

test('capByCountry: cap of 1 dedupes per country entirely in head', () => {
    const arr = [
        { country: 'A' }, { country: 'A' }, { country: 'B' }, { country: 'A' }
    ];
    const out = capByCountry(arr, 1);
    assert.equal(out[0].country, 'A');
    assert.equal(out[1].country, 'B');
    // Rest of A entries get tail-pushed.
    assert.equal(out[2].country, 'A');
    assert.equal(out[3].country, 'A');
});

// --- capByContinent ----------------------------------------------------

test('capByContinent: 30% cap on a 5-slot game allows max 2 per continent', () => {
    const arr = [
        { id: '1', region: 'Asia' },   { id: '2', region: 'Asia' },
        { id: '3', region: 'Asia' },   { id: '4', region: 'Asia' },
        { id: '5', region: 'Europe' }, { id: '6', region: 'Africa' }
    ];
    const out = capByContinent(arr, 0.3, 5);
    // First 2 Asia + Europe + Africa make it to the head.
    assert.deepEqual(out.slice(0, 4).map((l) => l.id), ['1', '2', '5', '6']);
    // The remaining Asia entries push to the tail.
    assert.deepEqual(out.slice(4).map((l) => l.id), ['3', '4']);
});

test('capByContinent: 10-slot 30% cap pushes 4th+ of any continent to the tail', () => {
    // Soft cap — over-fetched callers slice to the target and only the
    // head (= cap × continents) is guaranteed diverse. With 6 Asia +
    // 4 Europe, the first 4 Asia are tail-pushed because the cap is 3.
    const arr = [];
    for (let i = 0; i < 6; i++) arr.push({ id: 'a' + i, region: 'Asia' });
    for (let i = 0; i < 4; i++) arr.push({ id: 'e' + i, region: 'Europe' });
    const out = capByContinent(arr, 0.3, 10);
    // Head order: first 3 Asia, then 3 Europe (Europe also caps at 3),
    // tail: a3..a5, e3.
    assert.deepEqual(out.slice(0, 6).map((l) => l.id),
                     ['a0', 'a1', 'a2', 'e0', 'e1', 'e2']);
    // 4th and later Asia entries land in the tail.
    const tailAsia = out.slice(6).filter((l) => l.region === 'Asia');
    assert.deepEqual(tailAsia.map((l) => l.id), ['a3', 'a4', 'a5']);
});

test('capByContinent: empty / non-array => []', () => {
    assert.deepEqual(capByContinent([], 0.3, 5), []);
    assert.deepEqual(capByContinent(null, 0.3, 5), []);
});
