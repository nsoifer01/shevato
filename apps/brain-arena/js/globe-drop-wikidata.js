/*
 * Brain Arena — GlobeDrop alternate location sources (Wikidata SPARQL).
 *
 * https://query.wikidata.org/sparql — free, no API key, CORS-enabled,
 * accepts JSON via the `format=json` query param.
 *
 * Two round-type sources live here:
 *   - fetchMajorCities  → top N populated cities worldwide (population > 2M)
 *   - fetchLandmarks    → UNESCO World Heritage sites with coordinates
 *
 * `parseWikidataPoint` and the `normalize*` functions are pure (no fetch)
 * so the bulk of the logic can be unit-tested without network. The fetch
 * wrappers cap result counts and apply an injectable shuffle.
 *
 * Note: SPARQL queries are inlined here for review-ability — they're short
 * and don't change often. If they grow, move them to a separate text file.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.GlobeDropWikidata = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

    // Population thresholds — duplicated in the SPARQL queries below for the
    // server-side filter, AND applied as a client-side defensive check after
    // normalization. The defensive check catches the rare case where Wikidata
    // returns a row whose `?pop` value passed the SPARQL filter at one point
    // (e.g. a historic peak population that's now lower) but where the
    // current city population would not qualify. Anything we can't classify
    // (population missing/null) is rejected from the population-gated lists
    // so we never serve a sub-threshold city as "Major".
    const MAJOR_CITY_MIN_POPULATION = 2000000;
    const TOP_CITY_MIN_POPULATION = 100000;

    // Wikidata returns coordinates as `Point(longitude latitude)`. Note the
    // longitude-first order — this is the opposite of every other API in the
    // codebase, so a wrong call site silently puts cities in the wrong
    // hemisphere. The parser asserts numeric finite values; callers should
    // drop locations that come back null.
    function parseWikidataPoint(str) {
        if (typeof str !== 'string') return null;
        const match = /^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/.exec(str.trim());
        if (!match) return null;
        const lng = Number(match[1]);
        const lat = Number(match[2]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        return { lat, lng };
    }

    // SPARQL response shape: { results: { bindings: [{ varname: { value, type } }, ...] } }
    function extractValue(binding, key) {
        if (!binding || !binding[key]) return null;
        const v = binding[key].value;
        return (typeof v === 'string' && v.length) ? v : null;
    }

    /**
     * Normalize a single SPARQL binding from the major-cities query into our
     * standard location shape. Returns null when essential fields are missing
     * (no coordinate, no city label) so callers can filter cleanly.
     */
    function normalizeCityBinding(binding) {
        const cityLabel = extractValue(binding, 'cityLabel');
        const coordStr = extractValue(binding, 'coord');
        const pt = parseWikidataPoint(coordStr);
        if (!cityLabel || !pt) return null;
        const country = extractValue(binding, 'countryLabel') || 'Unknown country';
        const popStr = extractValue(binding, 'pop');
        const pop = popStr ? Number(popStr) : null;
        // Use the Wikidata item URI as an opaque id; falls back to the slugged
        // name so two co-named cities (Springfield, anyone?) don't collide.
        const idSource = extractValue(binding, 'city') || cityLabel;
        return {
            id: 'city-' + slug(idSource),
            name: cityLabel,
            country,
            region: '',       // continent absent here; scoring falls back to 1.0 multiplier
            subregion: '',
            flag: '',
            lat: pt.lat,
            lng: pt.lng,
            population: Number.isFinite(pop) ? pop : null
        };
    }

    /**
     * Normalize a single SPARQL binding from the landmarks query. Same
     * filtering rules as cities, plus we surface the heritage type if
     * Wikidata returned one (e.g. "cultural site") for the recap.
     */
    function normalizeLandmarkBinding(binding) {
        const label = extractValue(binding, 'siteLabel');
        const coordStr = extractValue(binding, 'coord');
        const pt = parseWikidataPoint(coordStr);
        if (!label || !pt) return null;
        const country = extractValue(binding, 'countryLabel') || 'Unknown country';
        const idSource = extractValue(binding, 'site') || label;
        return {
            id: 'lmk-' + slug(idSource),
            name: label,
            country,
            region: '',
            subregion: '',
            flag: '',
            lat: pt.lat,
            lng: pt.lng
        };
    }

    function slug(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    }

    const CITY_QUERY = `
        SELECT DISTINCT ?city ?cityLabel ?countryLabel ?coord ?pop WHERE {
            ?city wdt:P31/wdt:P279* wd:Q515.
            ?city wdt:P1082 ?pop.
            ?city wdt:P625 ?coord.
            ?city wdt:P17 ?country.
            FILTER(?pop > 2000000)
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        }
        ORDER BY DESC(?pop)
        LIMIT 80
    `;

    const LANDMARK_QUERY = `
        SELECT DISTINCT ?site ?siteLabel ?countryLabel ?coord WHERE {
            ?site wdt:P1435 wd:Q9259.
            ?site wdt:P625 ?coord.
            ?site wdt:P17 ?country.
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        }
        LIMIT 250
    `;

    async function runQuery(query) {
        const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query.trim())}&format=json`;
        // force-cache so re-fetches within a session are instant; Wikidata
        // doesn't change minute-to-minute and these are recreational lists.
        const res = await fetch(url, { cache: 'force-cache', headers: { 'Accept': 'application/sparql-results+json' } });
        if (!res.ok) throw new Error(`Wikidata SPARQL HTTP ${res.status}`);
        const data = await res.json();
        const bindings = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
        if (!bindings.length) throw new Error('Wikidata SPARQL returned no rows');
        return bindings;
    }

    async function fetchMajorCities(count, shuffleFn) {
        const bindings = await runQuery(CITY_QUERY);
        const seen = new Set();
        const normalized = [];
        for (const b of bindings) {
            const loc = normalizeCityBinding(b);
            if (!loc) continue;
            // Defensive client-side population gate: reject anything below
            // the major-cities threshold or with unknown population. SPARQL
            // already filters server-side, but historic / multi-statement
            // P1082 quirks have been observed letting sub-threshold cities
            // leak through. Don't trust upstream — verify.
            if (!Number.isFinite(loc.population) || loc.population < MAJOR_CITY_MIN_POPULATION) continue;
            // Wikidata sometimes returns duplicates for cities with multiple
            // qualifying population statements; keep the first occurrence.
            if (seen.has(loc.id)) continue;
            seen.add(loc.id);
            normalized.push(loc);
        }
        if (!normalized.length) throw new Error('Wikidata SPARQL returned no usable cities');
        const shuffled = typeof shuffleFn === 'function' ? shuffleFn(normalized) : normalized.slice();
        const n = Math.max(1, Math.min(shuffled.length, Number(count) || 5));
        return shuffled.slice(0, n);
    }

    /**
     * "Top cities by country" — for each country, take its top-population
     * cities (roughly the 90th-percentile by population: only the top 10%
     * for each country qualify) and pick across countries. This gives
     * variety like Chicago, Lisbon, Haifa, Wuhan, Osaka in one game
     * instead of a US/CN dogpile.
     *
     * Strategy:
     *   1. SPARQL: cities with population > 100k, ordered DESC, large LIMIT
     *   2. Group by country, sort each group DESC by pop, keep top 10%
     *      (min 1 per country)
     *   3. Flatten, shuffle, slice to count.
     */
    async function fetchTopCitiesByCountry(count, shuffleFn) {
        const bindings = await runQuery(TOP_CITIES_QUERY);
        const seen = new Set();
        const byCountry = new Map();
        for (const b of bindings) {
            const loc = normalizeCityBinding(b);
            if (!loc) continue;
            // Same defensive gate as major-cities: drop rows whose current
            // population can't be confirmed to be over the threshold.
            if (!Number.isFinite(loc.population) || loc.population < TOP_CITY_MIN_POPULATION) continue;
            if (seen.has(loc.id)) continue;
            seen.add(loc.id);
            const key = loc.country || '__unknown__';
            const bucket = byCountry.get(key) || [];
            bucket.push(loc);
            byCountry.set(key, bucket);
        }
        const finalists = [];
        byCountry.forEach((bucket) => {
            bucket.sort((a, b) => (b.population || 0) - (a.population || 0));
            const keepCount = Math.max(1, Math.ceil(bucket.length * 0.1));
            for (let i = 0; i < keepCount && i < bucket.length; i++) {
                finalists.push(bucket[i]);
            }
        });
        if (!finalists.length) throw new Error('Wikidata SPARQL returned no usable top-cities');
        const shuffled = typeof shuffleFn === 'function' ? shuffleFn(finalists) : finalists.slice();
        const n = Math.max(1, Math.min(shuffled.length, Number(count) || 5));
        return shuffled.slice(0, n);
    }

    const TOP_CITIES_QUERY = `
        SELECT DISTINCT ?city ?cityLabel ?countryLabel ?coord ?pop WHERE {
            ?city wdt:P31/wdt:P279* wd:Q515.
            ?city wdt:P1082 ?pop.
            ?city wdt:P625 ?coord.
            ?city wdt:P17 ?country.
            FILTER(?pop > 100000)
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        }
        ORDER BY DESC(?pop)
        LIMIT 2000
    `;

    async function fetchLandmarks(count, shuffleFn) {
        const bindings = await runQuery(LANDMARK_QUERY);
        const seen = new Set();
        const normalized = [];
        for (const b of bindings) {
            const loc = normalizeLandmarkBinding(b);
            if (!loc) continue;
            if (seen.has(loc.id)) continue;
            seen.add(loc.id);
            normalized.push(loc);
        }
        if (!normalized.length) throw new Error('Wikidata SPARQL returned no usable landmarks');
        const shuffled = typeof shuffleFn === 'function' ? shuffleFn(normalized) : normalized.slice();
        const n = Math.max(1, Math.min(shuffled.length, Number(count) || 5));
        return shuffled.slice(0, n);
    }

    return {
        SPARQL_ENDPOINT,
        parseWikidataPoint,
        normalizeCityBinding,
        normalizeLandmarkBinding,
        fetchMajorCities,
        fetchTopCitiesByCountry,
        fetchLandmarks
    };
}));
