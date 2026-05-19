'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeCountry,
    normalizeAsCountry,
    ROUND_TYPES
} = require('../js/globe-drop-locations.js');

function rawCountry(over = {}) {
    return Object.assign({
        name: { common: 'France', official: 'French Republic' },
        capital: ['Paris'],
        capitalInfo: { latlng: [48.87, 2.33] },
        region: 'Europe',
        subregion: 'Western Europe',
        flag: '🇫🇷'
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
    assert.equal(out.flag, '🇫🇷');
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
        flag: '🇫🇷'
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
