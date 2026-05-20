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

    // NOTE: REST Countries /all caps the `fields` list at 10 entries
    // and returns HTTP 400 over that — adding population means we had
    // to drop `landlocked` (which we set but never read anywhere).
    const REST_COUNTRIES_URL = 'https://restcountries.com/v3.1/all?fields=name,capital,capitalInfo,region,subregion,flag,latlng,area,independent,population';

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

        const areaNum = Number(raw.area);
        const popNum  = Number(raw.population);
        return {
            id: country.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown',
            name: capital,
            country,
            region,
            subregion: String(raw.subregion || ''),
            flag: String(raw.flag || ''),
            lat: latlng[0],
            lng: latlng[1],
            // Country-level metrics surfaced on the location so the
            // difficulty scorer can rank without re-fetching the REST
            // Countries payload. Population is country-wide (not city),
            // but it's the strongest proxy we have for "how often does
            // this place show up in international news / education".
            countryAreaSqKm:   Number.isFinite(areaNum) ? areaNum : null,
            countryPopulation: Number.isFinite(popNum)  ? popNum  : null,
            independent: raw.independent !== false
        };
    }

    /**
     * Heuristic: is this location's country a "small island nation" the
     * cap should limit to ≤2 per game? Two conditions, both must be true:
     *   1. Country land area below Config.GLOBE_DROP_SMALL_ISLAND_MAX_AREA
     *   2. Country subregion is in Config.GLOBE_DROP_SMALL_ISLAND_SUBREGIONS
     * The subregion filter avoids penalising small landlocked European
     * states (Liechtenstein, San Marino) that happen to be tiny but
     * aren't ocean dots.
     */
    function isSmallIslandLocation(loc) {
        if (!loc) return false;
        // Missing / null area means we can't classify reliably — treat as
        // non-island. Number(null) is 0 (finite), so the explicit guard
        // here matters; without it every legacy location would be flagged.
        if (loc.countryAreaSqKm == null) return false;
        const Config = (typeof module === 'object' && module.exports)
            ? require('./config.js')
            : (typeof window !== 'undefined' && window.BrainArena && window.BrainArena.Config) || {};
        const maxArea = Number(Config.GLOBE_DROP_SMALL_ISLAND_MAX_AREA);
        const subregions = Array.isArray(Config.GLOBE_DROP_SMALL_ISLAND_SUBREGIONS)
            ? Config.GLOBE_DROP_SMALL_ISLAND_SUBREGIONS
            : [];
        const area = Number(loc.countryAreaSqKm);
        if (!Number.isFinite(area) || area > maxArea) return false;
        const sub = String(loc.subregion || '');
        return subregions.indexOf(sub) !== -1;
    }

    /**
     * Cap small-island-nation locations to N per playlist. Walks the
     * (already-shuffled) list in order, keeping non-islands as-is and
     * keeping up to N islands; once the island budget is spent, further
     * islands are pushed to the END of the list so the head-of-list
     * slicing produces a balanced game. Pure; injectable for tests.
     */
    function capSmallIslands(locations, maxIslands) {
        if (!Array.isArray(locations)) return [];
        const cap = Math.max(0, Number(maxIslands) || 0);
        const head = [];
        const tail = [];
        let islandsKept = 0;
        for (const loc of locations) {
            if (isSmallIslandLocation(loc)) {
                if (islandsKept < cap) {
                    head.push(loc);
                    islandsKept++;
                } else {
                    tail.push(loc);
                }
            } else {
                head.push(loc);
            }
        }
        return head.concat(tail);
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
        const areaNum = Number(raw.area);
        const popNum  = Number(raw.population);
        return {
            id: 'country-' + (country.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'),
            name: country,           // the prompt shows this
            country: '',             // no extra country line — it IS the country
            region,
            subregion: String(raw.subregion || ''),
            flag: String(raw.flag || ''),
            lat: latlng[0],
            lng: latlng[1],
            countryAreaSqKm:   Number.isFinite(areaNum) ? areaNum : null,
            countryPopulation: Number.isFinite(popNum)  ? popNum  : null,
            independent: raw.independent !== false
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
        // Apply small-island cap BEFORE the take-N slice so the head of
        // the playlist gets at most GLOBE_DROP_SMALL_ISLAND_MAX_PER_GAME
        // tiny island capitals. capSmallIslands keeps the rest of the
        // playlist intact (any extra islands fall to the tail).
        const Config = (typeof require === 'function')
            ? require('./config.js')
            : (typeof window !== 'undefined' && window.BrainArena && window.BrainArena.Config) || {};
        const capped = capSmallIslands(shuffled, Config.GLOBE_DROP_SMALL_ISLAND_MAX_PER_GAME);
        const n = Math.max(1, Math.min(capped.length, Number(count) || 5));
        return capped.slice(0, n);
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
        'capitals':              { label: 'World capitals',          packId: 'world-capitals',         packName: 'World capitals',                       promptVerb: 'Where is' },
        'countries':             { label: 'Countries',               packId: 'world-countries',        packName: 'Countries',                            promptVerb: 'Where is' },
        'major-cities':          { label: 'Major cities',            packId: 'major-cities',           packName: 'Major cities (Wikidata)',              promptVerb: 'Where is' },
        'top-cities-by-country': { label: 'Top cities by country',   packId: 'top-cities-by-country',  packName: 'Top cities by country (Wikidata)',     promptVerb: 'Where is' },
        'landmarks':             { label: 'World landmarks',         packId: 'world-landmarks',        packName: 'UNESCO World Heritage sites (Wikidata)', promptVerb: 'Where is' }
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
            case 'countries':              return fetchCountryLocations(count, shuffleFn);
            case 'major-cities':           return Wikidata.fetchMajorCities(count, shuffleFn);
            case 'top-cities-by-country':  return Wikidata.fetchTopCitiesByCountry(count, shuffleFn);
            case 'landmarks':              return Wikidata.fetchLandmarks(count, shuffleFn);
            case 'capitals':
            default:                       return fetchCapitalLocations(count, shuffleFn);
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
        isSmallIslandLocation,
        capSmallIslands,
        fetchLocations,
        fetchCapitalLocations,
        fetchCountryLocations,
        fetchCityTrivia
    };
}));
