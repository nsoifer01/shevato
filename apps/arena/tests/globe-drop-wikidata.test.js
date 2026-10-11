'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseWikidataPoint,
    normalizeCityBinding,
    normalizeLandmarkBinding
} = require('../js/globe-drop-wikidata.js');

// --- parseWikidataPoint ------------------------------------------------

test('parseWikidataPoint: well-formed Point(lng lat) is parsed in correct order', () => {
    // Paris on Wikidata: Point(2.349014 48.864716) → lng first, lat second
    const r = parseWikidataPoint('Point(2.349014 48.864716)');
    assert.ok(r);
    assert.equal(r.lat, 48.864716);
    assert.equal(r.lng, 2.349014);
});

test('parseWikidataPoint: negative coords parse correctly', () => {
    const r = parseWikidataPoint('Point(-58.381944 -34.603333)'); // Buenos Aires
    assert.equal(r.lat, -34.603333);
    assert.equal(r.lng, -58.381944);
});

test('parseWikidataPoint: rejects malformed input', () => {
    assert.equal(parseWikidataPoint(null), null);
    assert.equal(parseWikidataPoint(''), null);
    assert.equal(parseWikidataPoint('48.86, 2.34'), null);
    assert.equal(parseWikidataPoint('Point(notanumber 1.0)'), null);
    assert.equal(parseWikidataPoint('Point()'), null);
});

test('parseWikidataPoint: rejects out-of-range coords (sanity)', () => {
    assert.equal(parseWikidataPoint('Point(0 100)'), null);   // lat > 90
    assert.equal(parseWikidataPoint('Point(200 0)'), null);   // lng > 180
    assert.equal(parseWikidataPoint('Point(-181 0)'), null);
});

// --- normalizeCityBinding ---------------------------------------------

function cityBinding(over) {
    return Object.assign({
        city: { value: 'http://www.wikidata.org/entity/Q90', type: 'uri' },
        cityLabel: { value: 'Paris', type: 'literal' },
        countryLabel: { value: 'France', type: 'literal' },
        coord: { value: 'Point(2.349014 48.864716)', type: 'literal' },
        pop: { value: '2102650', type: 'literal' }
    }, over || {});
}

test('normalizeCityBinding: happy path returns full location shape', () => {
    const r = normalizeCityBinding(cityBinding());
    assert.equal(r.name, 'Paris');
    assert.equal(r.country, 'France');
    assert.equal(r.lat, 48.864716);
    assert.equal(r.lng, 2.349014);
    assert.equal(r.population, 2102650);
    assert.ok(r.id.startsWith('city-'));
});

test('normalizeCityBinding: missing coord → null', () => {
    const b = cityBinding();
    delete b.coord;
    assert.equal(normalizeCityBinding(b), null);
});

test('normalizeCityBinding: missing label → null', () => {
    const b = cityBinding();
    delete b.cityLabel;
    assert.equal(normalizeCityBinding(b), null);
});

test('normalizeCityBinding: missing country becomes "Unknown country"', () => {
    const b = cityBinding();
    delete b.countryLabel;
    const r = normalizeCityBinding(b);
    assert.equal(r.country, 'Unknown country');
});

test('normalizeCityBinding: id is slugged from city URI when present', () => {
    const r = normalizeCityBinding(cityBinding({
        city: { value: 'http://www.wikidata.org/entity/Q1492', type: 'uri' },
        cityLabel: { value: 'São Paulo', type: 'literal' }
    }));
    // URI slug — punctuation collapses to dashes
    assert.ok(r.id.startsWith('city-'));
    assert.match(r.id, /q1492/);
});

// --- normalizeLandmarkBinding ----------------------------------------

function landmarkBinding(over) {
    return Object.assign({
        site: { value: 'http://www.wikidata.org/entity/Q43473', type: 'uri' },
        siteLabel: { value: 'Machu Picchu', type: 'literal' },
        countryLabel: { value: 'Peru', type: 'literal' },
        coord: { value: 'Point(-72.545556 -13.163333)', type: 'literal' }
    }, over || {});
}

test('normalizeLandmarkBinding: happy path returns full location shape', () => {
    const r = normalizeLandmarkBinding(landmarkBinding());
    assert.equal(r.name, 'Machu Picchu');
    assert.equal(r.country, 'Peru');
    assert.equal(Math.round(r.lat * 1000), -13163);
    assert.equal(Math.round(r.lng * 1000), -72546);
    assert.ok(r.id.startsWith('lmk-'));
});

test('normalizeLandmarkBinding: missing coord → null (cannot place pin)', () => {
    const b = landmarkBinding();
    delete b.coord;
    assert.equal(normalizeLandmarkBinding(b), null);
});

test('normalizeLandmarkBinding: missing siteLabel → null (cannot show prompt)', () => {
    const b = landmarkBinding();
    delete b.siteLabel;
    assert.equal(normalizeLandmarkBinding(b), null);
});

// --- runQuery timeout --------------------------------------------------

// The top-cities query takes about a minute on the query service and
// sometimes 504s after it, so room creation waited a minute for an error.
// The fetch must be abandoned, and the message is what the host's
// "Could not fetch locations" alert shows.
test('fetchTopCitiesByCountry: a query the service never answers is abandoned after 45s', async (t) => {
    const { fetchTopCitiesByCountry } = require('../js/globe-drop-wikidata.js');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    let sawSignal = false;
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
        sawSignal = !!(opts && opts.signal);
        opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const pending = fetchTopCitiesByCountry(5);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(44999);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'a slow but healthy query must be allowed to finish');
    t.mock.timers.tick(1);
    await assert.rejects(pending, /did not answer within 45 seconds/);
    assert.equal(sawSignal, true);
});
