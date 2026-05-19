/*
 * Brain Arena — GlobeDrop location source (REST Countries API).
 *
 * https://restcountries.com — free, no API key, CORS-enabled.
 * GET /v3.1/all?fields=name,capital,capitalInfo,region,subregion,flag
 * returns ~250 country records. We map each one's capital + lat/lng into
 * the in-app location shape used by the GlobeDrop game stage.
 *
 * normalizeCountry is pure (no fetch) so it's testable; fetchLocations
 * does the network call + normalization + random shuffle in one shot.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.GlobeDropLocations = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
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
     * Fetch up to `count` random capital-city locations.
     * @param {number} count
     * @param {(arr:Array)=>Array} shuffleFn — injectable shuffle (pure)
     * @returns {Promise<Array>}
     */
    async function fetchLocations(count, shuffleFn) {
        const res = await fetch(REST_COUNTRIES_URL, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`REST Countries HTTP ${res.status}`);
        const raw = await res.json();
        if (!Array.isArray(raw) || !raw.length) throw new Error('REST Countries empty response');
        const normalized = raw.map(normalizeCountry).filter((q) => q !== null);
        if (!normalized.length) throw new Error('REST Countries returned no usable locations');
        const shuffled = typeof shuffleFn === 'function' ? shuffleFn(normalized) : normalized.slice();
        const n = Math.max(1, Math.min(shuffled.length, Number(count) || 5));
        return shuffled.slice(0, n);
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

    return { REST_COUNTRIES_URL, normalizeCountry, fetchLocations, fetchCityTrivia };
}));
