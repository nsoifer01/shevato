/*
 * Brain Arena — GlobeDrop mode scoring.
 *
 * Pure, no DOM/Firebase. Exported CommonJS + window.BrainArena.GlobeDropScoring.
 *
 * Distance: standard Haversine great-circle formula in km.
 * Score:    base * exp(-distance / scaleKm) * continentMultiplier
 *           (0km → base * multiplier; scaleKm → ~37% of base; far → ~0)
 *
 * Continent multiplier comes from Config.GLOBE_DROP_CONTINENT_MULTIPLIERS,
 * keyed by lowercased REST Countries `region` string (Africa, Americas,
 * Asia, Europe, Oceania, Antarctic). Missing keys fall back to 1.0.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        const Config = require('./config.js');
        module.exports = factory(Config);
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.GlobeDropScoring = factory(ns.Config);
    }
}(typeof self !== 'undefined' ? self : this, function (Config) {
    'use strict';

    const EARTH_RADIUS_KM = 6371;

    /**
     * Great-circle distance in km between two (lat, lng) points.
     * Returns 0 for the same point, ~20015 km for antipodes.
     */
    function haversineDistanceKm(lat1, lng1, lat2, lng2) {
        const toRad = (deg) => deg * Math.PI / 180;
        const dLat = toRad(Number(lat2) - Number(lat1));
        const dLng = toRad(Number(lng2) - Number(lng1));
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2)))
            * Math.sin(dLng / 2) ** 2;
        return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Look up the continent multiplier for a REST Countries `region`
     * string (case-insensitive). Defaults to 1.0 for anything we don't
     * recognize so a malformed location can never zero-out scoring.
     */
    function continentMultiplier(region) {
        const table = Config.GLOBE_DROP_CONTINENT_MULTIPLIERS || {};
        const key = String(region || '').trim().toLowerCase();
        const mult = table[key];
        return (typeof mult === 'number' && Number.isFinite(mult)) ? mult : 1;
    }

    /**
     * Score a single guess.
     * @param {object} args
     * @param {number} args.distanceKm
     * @param {string} args.region — continent / region label
     * @returns {{ points:number, distanceKm:number, multiplier:number, basePoints:number }}
     */
    function scoreGuess({ distanceKm, region }) {
        const max = Config.GLOBE_DROP_BASE_POINTS;
        const scale = Config.GLOBE_DROP_DISTANCE_SCALE_KM;
        const d = Math.max(0, Number(distanceKm) || 0);
        const base = max * Math.exp(-d / scale);
        const mult = continentMultiplier(region);
        const points = Math.max(0, Math.round(base * mult));
        return {
            points,
            distanceKm: d,
            multiplier: mult,
            basePoints: Math.round(base)
        };
    }

    return { haversineDistanceKm, continentMultiplier, scoreGuess };
}));
