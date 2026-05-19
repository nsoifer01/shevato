/*
 * Brain Arena — GlobeDrop location dispatcher.
 *
 * Four round types, each with its own data source:
 *
 *   'capitals'    → REST Countries API   (in this file)
 *   'countries'   → REST Countries API   (in this file, country-centroid flip)
 *   'major-cities'→ Wikidata SPARQL      (globe-drop-wikidata.js)
 *   'landmarks'   → Wikidata SPARQL      (globe-drop-wikidata.js)
 *
 * `fetchLocations(roundType, count, shuffleFn)` is the public entry point;
 * everything else here is the capitals/countries implementation +
 * normalization (kept pure so it's directly testable).
 *
 * REST Countries: https://restcountries.com (free, no key, CORS-enabled).
 * Wikidata SPARQL: lives in globe-drop-wikidata.js so the queries can be
 * unit-tested without dragging the network fetch through this module.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        const Wikidata = require('./globe-drop-wikidata.js');
        module.exports = factory(Wikidata);
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.GlobeDropLocations = factory(ns.GlobeDropWikidata);
    }
}(typeof self !== 'undefined' ? self : this, function (Wikidata) {
    'use strict';

    const REST_COUNTRIES_URL = 'https://restcountries.com/v3.1/all?fields=name,capital,capitalInfo,region,subregion,flag,latlng';

    /**
     * Convert one REST Countries record into our location shape, or null
     * if it lacks the data we need (no capital name or no usable
     * coordinates). Filtering at this layer means downstream code can
     * assume every location is well-formed.
     * @param {object} raw — one element of the API's array response
     * @returns {object|null}
     */
    function normalizeCountry(raw) {
        if (!raw || typeof raw !== 'object') return null;

        const capitals = Array.isArray(raw.capital) ? raw.capital : [];
        const capital = capitals.find((c) => typeof c === 'string' && c.trim());
        if (!capital) return null;

        // Prefer capitalInfo.latlng (capital city coords) over latlng
        // (country centroid). Fall back to country centroid for the few
        // entries (Israel, Palestine, etc.) that omit capitalInfo.
        let latlng = (raw.capitalInfo && Array.isArray(raw.capitalInfo.latlng))
            ? raw.capitalInfo.latlng
            : null;
        if (!latlng || latlng.length < 2 || !Number.isFinite(latlng[0]) || !Number.isFinite(latlng[1])) {
            latlng = Array.isArray(raw.latlng) ? raw.latlng : null;
        }
        if (!latlng || latlng.length < 2 || !Number.isFinite(latlng[0]) || !Number.isFinite(latlng[1])) {
            return null;
        }

        const country = (raw.name && typeof raw.name.common === 'string')
            ? raw.name.common
            : 'Unknown country';
        const region = String(raw.region || 'Unknown');

        return {
            id: country.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown',
            name: capital,
            country,
            region,
            subregion: String(raw.subregion || ''),
            flag: String(raw.flag || ''),
            lat: latlng[0],
            lng: latlng[1]
        };
    }

    /**
     * Variant of normalizeCountry that turns each REST Countries record into
     * a "guess the country" prompt: name = the country itself, no city, and
     * coordinates point at the country's geographic centroid (latlng), not
     * its capital. The recap can still reference the country meta as usual.
     */
    function normalizeAsCountry(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const country = (raw.name && typeof raw.name.common === 'string')
            ? raw.name.common
            : null;
        if (!country) return null;
        const latlng = Array.isArray(raw.latlng) ? raw.latlng : null;
        if (!latlng || latlng.length < 2 || !Number.isFinite(latlng[0]) || !Number.isFinite(latlng[1])) {
            return null;
        }
        const region = String(raw.region || 'Unknown');
        return {
            id: 'country-' + (country.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'),
            name: country,           // the prompt shows this
            country: '',             // no extra country line — it IS the country
            region,
            subregion: String(raw.subregion || ''),
            flag: String(raw.flag || ''),
            lat: latlng[0],
            lng: latlng[1]
        };
    }

    async function fetchRestCountries(normalizer, count, shuffleFn) {
        const res = await fetch(REST_COUNTRIES_URL, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`REST Countries HTTP ${res.status}`);
        const raw = await res.json();
        if (!Array.isArray(raw) || !raw.length) throw new Error('REST Countries empty response');
        const normalized = raw.map(normalizer).filter((q) => q !== null);
        if (!normalized.length) throw new Error('REST Countries returned no usable locations');
        const shuffled = typeof shuffleFn === 'function' ? shuffleFn(normalized) : normalized.slice();
        const n = Math.max(1, Math.min(shuffled.length, Number(count) || 5));
        return shuffled.slice(0, n);
    }

    /**
     * Default capital-cities fetch — kept named the same as before for any
     * existing call sites that still ask for the legacy behaviour directly.
     */
    async function fetchCapitalLocations(count, shuffleFn) {
        return fetchRestCountries(normalizeCountry, count, shuffleFn);
    }

    async function fetchCountryLocations(count, shuffleFn) {
        return fetchRestCountries(normalizeAsCountry, count, shuffleFn);
    }

    const ROUND_TYPES = {
        'capitals':    { label: 'World capitals',      packId: 'world-capitals',  packName: 'World capitals',  promptVerb: 'Where is' },
        'countries':   { label: 'Countries',           packId: 'world-countries', packName: 'Countries',        promptVerb: 'Where is' },
        'major-cities':{ label: 'Major cities',         packId: 'major-cities',    packName: 'Major cities (Wikidata)', promptVerb: 'Where is' },
        'landmarks':   { label: 'World landmarks',     packId: 'world-landmarks', packName: 'UNESCO World Heritage sites (Wikidata)', promptVerb: 'Where is' }
    };

    /**
     * Dispatcher — picks the right fetch for the host-selected round type.
     * Falls back to 'capitals' for unknown / missing values so legacy rooms
     * persisted before this feature shipped still play exactly as before.
     */
    async function fetchLocations(roundType, count, shuffleFn) {
        // Back-compat: callers that haven't migrated yet pass (count, shuffleFn).
        if (typeof roundType !== 'string') {
            return fetchCapitalLocations(roundType, count);
        }
        switch (roundType) {
            case 'countries':    return fetchCountryLocations(count, shuffleFn);
            case 'major-cities': return Wikidata.fetchMajorCities(count, shuffleFn);
            case 'landmarks':    return Wikidata.fetchLandmarks(count, shuffleFn);
            case 'capitals':
            default:             return fetchCapitalLocations(count, shuffleFn);
        }
    }

    /**
     * Fetch a one-paragraph Wikipedia summary for a city. Best-effort:
     * any failure (no article, network, malformed JSON) resolves null
     * so callers can show "no trivia available" rather than throwing.
     * @param {string} cityName
     * @returns {Promise<string|null>}
     */
    async function fetchCityTrivia(cityName) {
        const title = encodeURIComponent(String(cityName || '').trim());
        if (!title) return null;
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            const extract = data && typeof data.extract === 'string' ? data.extract : null;
            if (!extract || !extract.trim()) return null;
            // Trim to first ~280 chars at sentence boundary for compact display.
            const max = 280;
            if (extract.length <= max) return extract;
            const cut = extract.slice(0, max);
            const lastDot = cut.lastIndexOf('. ');
            return lastDot > 100 ? cut.slice(0, lastDot + 1) : cut + '…';
        } catch (e) {
            return null;
        }
    }

    return {
        REST_COUNTRIES_URL,
        ROUND_TYPES,
        normalizeCountry,
        normalizeAsCountry,
        fetchLocations,
        fetchCapitalLocations,
        fetchCountryLocations,
        fetchCityTrivia
    };
}));
