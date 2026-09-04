'use strict';

// Integrity of the VENDORED answer key, apps/arena/data/countries.json.
//
// WHY THIS FILE EXISTS: globe-drop-locations.test.js builds its country
// records by hand (`rawCountry({...})`), so it proves the normaliser is
// correct and says nothing about the 250 real records the game actually
// scores. Three of them were wrong, and a wrong record is invisible: the
// player places the pin correctly, the app scores them thousands of
// kilometres out and reveals a pin on another continent.
//
//   French Southern and Antarctic Lands: Port-aux-Francais at [48.81,-1.4],
//     which is Normandy (the mainland commune the territory is administered
//     from), 12,756 km from Kerguelen.
//   Western Sahara: El Aaiun at [-13.28,27.14], latitude and longitude
//     swapped, landing in Zambia, 5,826 km out.
//   United States Minor Outlying Islands: capital "Washington DC" with no
//     coordinates, so the country-centroid fallback pinned Washington DC at
//     Wake Island.
//
// The check is geometric, not a list of expected values: every capital must
// lie inside, or close to, its own country's polygon in the world-110m
// topology the globe already renders. That catches the next bad record too.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const countries = require('../data/countries.json');
const topology = require('../data/world-110m.json');
const { normalizeCountry } = require('../js/globe-drop-locations.js');

// --- minimal TopoJSON decode (arcs -> rings), enough for point-in-polygon ---
function decodeArcs(topo) {
    const { scale = [1, 1], translate = [0, 0] } = topo.transform || {};
    return topo.arcs.map((arc) => {
        let x = 0, y = 0;
        return arc.map(([dx, dy]) => {
            x += dx; y += dy;
            return topo.transform ? [x * scale[0] + translate[0], y * scale[1] + translate[1]] : [dx, dy];
        });
    });
}

function ringFor(arcIndexes, arcs) {
    const points = [];
    for (const idx of arcIndexes) {
        const arc = idx < 0 ? arcs[~idx].slice().reverse() : arcs[idx];
        for (let i = points.length ? 1 : 0; i < arc.length; i++) points.push(arc[i]);
    }
    return points;
}

function polygonsFor(geometry, arcs) {
    if (geometry.type === 'Polygon') return [geometry.arcs.map((r) => ringFor(r, arcs))];
    if (geometry.type === 'MultiPolygon') {
        return geometry.arcs.map((poly) => poly.map((r) => ringFor(r, arcs)));
    }
    return [];
}

function pointInRing([lng, lat], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function pointInPolygons(point, polygons) {
    return polygons.some((rings) => rings.length > 0 && pointInRing(point, rings[0])
        && !rings.slice(1).some((hole) => pointInRing(point, hole)));
}

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
function haversineKm([lat1, lng1], [lat2, lng2]) {
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nearestVertexKm(point, polygons) {
    let best = Infinity;
    for (const rings of polygons) {
        for (const ring of rings) {
            for (const [lng, lat] of ring) {
                best = Math.min(best, haversineKm(point, [lat, lng]));
                if (best === 0) return 0;
            }
        }
    }
    return best;
}

const arcs = decodeArcs(topology);
const byName = new Map();
for (const g of topology.objects.countries.geometries) {
    const name = g.properties && g.properties.name;
    if (name) byName.set(name, polygonsFor(g, arcs));
}

// world-110m and the country dump disagree on a handful of display names.
const TOPOLOGY_ALIASES = {
    'United States': 'United States of America',
    'Czechia': 'Czech Republic',
    'Myanmar': 'Myanmar',
    'North Macedonia': 'Macedonia',
    'Eswatini': 'Swaziland',
    'Republic of the Congo': 'Republic of the Congo',
    'DR Congo': 'Democratic Republic of the Congo',
    'Ivory Coast': 'Ivory Coast',
    'Cape Verde': 'Cape Verde',
    'East Timor': 'East Timor',
    'Serbia': 'Republic of Serbia',
    'Tanzania': 'United Republic of Tanzania',
    'The Bahamas': 'The Bahamas',
    'Bahamas': 'The Bahamas',
    'Guinea-Bissau': 'Guinea Bissau',
    'Western Sahara': 'W. Sahara',
    'French Southern and Antarctic Lands': 'Fr. S. Antarctic Lands',
    'Central African Republic': 'Central African Rep.',
    'Dominican Republic': 'Dominican Rep.',
    'Equatorial Guinea': 'Eq. Guinea',
    'Falkland Islands': 'Falkland Is.',
    'Solomon Islands': 'Solomon Is.',
    'South Korea': 'South Korea',
    'North Korea': 'North Korea',
};

// The names above are the ones that differ. If a mapping goes stale (a
// re-vendored topology renaming a country), the entry silently stops matching
// and that country is no longer checked, so the count of matched countries is
// asserted below as well as the placement itself.


// A 110m outline is coarse and small islands are missing from it entirely, so
// the assertion is "not on the wrong continent", not "pixel accurate".
const TOLERANCE_KM = 400;

test('every vendored capital sits on or near its own country', () => {
    const wrong = [];
    let checked = 0;

    for (const raw of countries) {
        const norm = normalizeCountry(raw);
        if (!norm) continue;                       // no capital: not asked about
        const common = raw.name && raw.name.common;
        const polygons = byName.get(TOPOLOGY_ALIASES[common] || common);
        if (!polygons || !polygons.length) continue;  // not in the 110m outline

        checked++;
        const point = [norm.lng, norm.lat];
        if (pointInPolygons(point, polygons)) continue;
        const km = Math.round(nearestVertexKm([norm.lat, norm.lng], polygons));
        if (km > TOLERANCE_KM) wrong.push(`${common}: ${norm.name} at [${norm.lat},${norm.lng}] is ${km}km away`);
    }

    assert.ok(checked > 130, `sanity: expected to check most countries, checked ${checked}`);
    assert.deepEqual(wrong, [], `capitals plotted outside their own country:\n  ${wrong.join('\n  ')}`);
});

test('a country with no usable capital is excluded rather than mis-placed', () => {
    // United States Minor Outlying Islands has no capital of its own. It used
    // to name "Washington DC" with no coordinates, and the country-centroid
    // fallback then placed that name at Wake Island.
    const usmoi = countries.find((c) => c.name && c.name.common === 'United States Minor Outlying Islands');
    assert.ok(usmoi, 'the record must still exist');
    assert.equal(normalizeCountry(usmoi), null,
        'a record with no real capital must not become a capitals question');
});

test('the two repaired capitals are on the right side of the planet', () => {
    // Explicit anchors for the two coordinates that were wrong, so a future
    // re-vendor of the upstream dump cannot quietly reintroduce them.
    const find = (name) => normalizeCountry(countries.find((c) => c.name && c.name.common === name));

    const kerguelen = find('French Southern and Antarctic Lands');
    assert.ok(kerguelen.lat < -40 && kerguelen.lng > 60,
        `Port-aux-Francais must be in the southern Indian Ocean, got [${kerguelen.lat},${kerguelen.lng}]`);

    const elAaiun = find('Western Sahara');
    assert.ok(elAaiun.lat > 20 && elAaiun.lng < 0,
        `El Aaiun must be in north-west Africa, got [${elAaiun.lat},${elAaiun.lng}]`);
});
