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
     * Look up the difficulty settings for a tier key (easy / medium / hard).
     * Unknown / missing keys fall back to medium so legacy rooms persisted
     * before this feature shipped score exactly the same as they always have.
     */
    function difficultySettings(key) {
        const table = Config.GLOBE_DROP_DIFFICULTIES || {};
        const fallback = table[Config.GLOBE_DROP_DIFFICULTY_DEFAULT] || { scoreMultiplier: 1, timerSec: 120, hintLevel: 'country+continent', label: 'Medium' };
        if (typeof key !== 'string') return fallback;
        return table[key] || fallback;
    }

    /**
     * Obscurity weight from population. The smaller (less-famous) the
     * place, the higher the multiplier — so guessing a 200k-person
     * Polish city is worth meaningfully more than a 10M-person megacity
     * at the same distance.
     *
     * Formula: weight = clamp((REFERENCE_LOG10 - log10(pop)) * SLOPE + 1, MIN, MAX)
     *
     * Tuning examples with current config (REFERENCE_LOG10=6, SLOPE=0.35):
     *   pop=10,000     → log10=4   → (6-4)*0.35 + 1 = 1.70
     *   pop=100,000    → log10=5   → (6-5)*0.35 + 1 = 1.35
     *   pop=1,000,000  → log10=6   → 1.00
     *   pop=10,000,000 → log10=7   → (6-7)*0.35 + 1 = 0.65
     *   pop=missing    → 1.00 (legacy capitals where we don't have data)
     */
    function populationWeight(pop) {
        if (pop == null || !Number.isFinite(pop) || pop <= 0) return 1;
        const cfg = Config.GLOBE_DROP_POPULATION_WEIGHT || {};
        const ref = typeof cfg.REFERENCE_LOG10 === 'number' ? cfg.REFERENCE_LOG10 : 6;
        const slope = typeof cfg.SLOPE === 'number' ? cfg.SLOPE : 0.35;
        const minW = typeof cfg.MIN === 'number' ? cfg.MIN : 0.55;
        const maxW = typeof cfg.MAX === 'number' ? cfg.MAX : 2.0;
        const w = (ref - Math.log10(pop)) * slope + 1;
        return Math.max(minW, Math.min(maxW, w));
    }

    /**
     * Score a single guess.
     * @param {object} args
     * @param {number} args.distanceKm
     * @param {string} args.region — continent / region label
     * @param {string} [args.difficulty] — easy/medium/hard; omitted = legacy = medium (1x)
     * @param {number} [args.population] — population of the place being guessed.
     *                                     Smaller pop = higher obscurity weight.
     * @returns {{ points:number, distanceKm:number, multiplier:number, basePoints:number,
     *            difficultyMultiplier:number, populationMultiplier:number }}
     */
    function scoreGuess({ distanceKm, region, difficulty, population }) {
        const max = Config.GLOBE_DROP_BASE_POINTS;
        const scale = Config.GLOBE_DROP_DISTANCE_SCALE_KM;
        const floor = typeof Config.GLOBE_DROP_MIN_POINTS === 'number' ? Config.GLOBE_DROP_MIN_POINTS : 0;
        const d = Math.max(0, Number(distanceKm) || 0);
        const base = max * Math.exp(-d / scale);
        const mult = continentMultiplier(region);
        const diff = difficultySettings(difficulty);
        const diffMult = diff.scoreMultiplier;
        const popMult = populationWeight(population);
        // Distance-decay points × continent × difficulty × obscurity, then
        // floor at GLOBE_DROP_MIN_POINTS so an antipodal guess still scores
        // something instead of a flat 0.
        const raw = base * mult * diffMult * popMult;
        const points = Math.max(floor, Math.round(raw));
        return {
            points,
            distanceKm: d,
            multiplier: mult,
            basePoints: Math.round(base),
            difficultyMultiplier: diffMult,
            populationMultiplier: popMult
        };
    }

    return {
        haversineDistanceKm,
        continentMultiplier,
        difficultySettings,
        populationWeight,
        scoreGuess
    };
}));
