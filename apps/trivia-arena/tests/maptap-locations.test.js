'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCountry } = require('../js/maptap-locations.js');

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
