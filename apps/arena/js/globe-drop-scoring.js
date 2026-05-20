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
     * Round multiplier ladder. Every round in a game draws its
     * multiplier from this fixed pool — first round always 1.0×,
     * last round always 3.0×, intermediate rounds interpolate.
     * One impactful scaling per round instead of compounding
     * continent × difficulty × obscurity multipliers.
     */
    const ROUND_MULTIPLIERS = [1.0, 1.5, 2.0, 2.5, 3.0];

    /**
     * Pick the multiplier for round `i` (0-indexed) out of `n` total
     * rounds. Linearly interpolates an index into ROUND_MULTIPLIERS:
     *
     *   n=5  → [1.0, 1.5, 2.0, 2.5, 3.0]            (every step used)
     *   n=10 → [1.0, 1.0, 1.5, 1.5, 2.0, 2.0,        (each step x2)
     *           2.5, 2.5, 3.0, 3.0]
     *   n=3  → [1.0, 2.0, 3.0]                       (subset spread evenly)
     *   n=1  → [1.0]                                 (always start easy)
     *
     * Guaranteed monotonic non-decreasing: round i+1 always has
     * multiplier ≥ round i.
     */
    function roundMultiplierForIndex(i, n) {
        if (!Number.isFinite(i) || i < 0) return ROUND_MULTIPLIERS[0];
        if (!Number.isFinite(n) || n <= 1) return ROUND_MULTIPLIERS[0];
        const lastIdx = ROUND_MULTIPLIERS.length - 1;
        const idx = Math.round(i * lastIdx / (n - 1));
        return ROUND_MULTIPLIERS[Math.max(0, Math.min(lastIdx, idx))];
    }

    /**
     * Stamp `multiplier` onto each location in order. The input order
     * is preserved — callers should shuffle for variety BEFORE
     * passing the array in. Returns a new array; doesn't mutate input.
     */
    function assignRoundMultipliers(locations) {
        if (!Array.isArray(locations)) return [];
        const n = locations.length;
        return locations.map((loc, i) => Object.assign({}, loc, {
            multiplier: roundMultiplierForIndex(i, n)
        }));
    }

    /**
     * Clamp a raw difficulty score to the nearest step in the
     * ROUND_MULTIPLIERS ladder [1.0, 1.5, 2.0, 2.5, 3.0]. Anything
     * below 1.0 becomes 1.0; anything above 3.0 becomes 3.0; in
     * between we snap to the nearest 0.5 step so a continuous score
     * collapses to one of the five tiers.
     */
    function quantizeToLadder(raw) {
        if (!Number.isFinite(raw)) return ROUND_MULTIPLIERS[0];
        const snapped = Math.round(raw * 2) / 2;
        const lo = ROUND_MULTIPLIERS[0];
        const hi = ROUND_MULTIPLIERS[ROUND_MULTIPLIERS.length - 1];
        return Math.max(lo, Math.min(hi, snapped));
    }

    /**
     * Subregions whose capitals are systematically less-recognizable
     * than their continent average — island clusters and politically
     * isolated regions where the capital city isn't household-name.
     * Used as an additive boost on top of the continent baseline.
     */
    const OBSCURE_SUBREGIONS = [
        'Caribbean',
        'Polynesia',
        'Micronesia',
        'Melanesia',
        'Middle Africa',
        'Central Asia'
    ];

    /**
     * Per-location difficulty score combining the actual signals we
     * persist on every location: continent, subregion, country land
     * area, landlocked status. The REST Countries fetch doesn't
     * include city-level population, so we infer obscurity from
     * country-level data the location does carry.
     *
     *   base       = continentMultiplier(region)   // 1.0 – 1.5
     *   + 0.5      if subregion ∈ OBSCURE_SUBREGIONS (island/isolated clusters)
     *   + 1.0      if countryAreaSqKm < 100   (specks: Vatican, Tuvalu, Nauru, Anguilla)
     *   + 0.7      else if countryAreaSqKm < 5000   (small: Luxembourg, Malta, Grenada)
     *   + 0.3      else if countryAreaSqKm < 20000  (mid-small: Eswatini, Brunei)
     *
     * Examples (with current OBSCURE list + thresholds):
     *   London      (Europe / North. Europe / 242k)        → 1.0
     *   Brussels    (Europe / West. Europe / 30k)          → 1.0
     *   Luxembourg  (Europe / West. Europe / 2.6k)         → 1.5
     *   Pretoria    (Africa / South. Africa / 1.22M)       → 1.5
     *   Maputo      (Africa / East. Africa / 801k)         → 1.5
     *   Ciudad de la Paz (Africa / Middle Africa / 28k)    → 2.0
     *   St. George's (Americas / Caribbean / 344)          → 2.5
     *   The Valley   (Americas / Caribbean / 91)           → 2.5
     *   Funafuti    (Oceania / Polynesia / 26)             → 3.0
     */
    function locationDifficultyScore(loc) {
        if (!loc) return 1;
        let score = continentMultiplier(loc.region);
        const sub = String(loc.subregion || '');
        if (OBSCURE_SUBREGIONS.indexOf(sub) !== -1) score += 0.5;
        const area = Number(loc.countryAreaSqKm);
        if (Number.isFinite(area) && area > 0) {
            if (area < 100)        score += 1.0;
            else if (area < 5000)  score += 0.7;
            else if (area < 20000) score += 0.3;
        }
        return score;
    }

    /**
     * Stamp each location with a multiplier derived from its own
     * attributes (continent + population), not its position in the
     * playlist. Same input order is preserved — but the multipliers
     * are no longer monotonic. Returns a new array; doesn't mutate
     * input.
     *
     * This replaces assignRoundMultipliers as the production path:
     *   - assignRoundMultipliers — position-based ladder (legacy)
     *   - assignDifficultyMultipliers — per-location difficulty (current)
     */
    function assignDifficultyMultipliers(locations) {
        if (!Array.isArray(locations)) return [];
        return locations.map((loc) => Object.assign({}, loc, {
            multiplier: quantizeToLadder(locationDifficultyScore(loc))
        }));
    }

    /**
     * Score a single guess.
     *
     * New model (preferred): pass `multiplier` directly. Score is
     *   round(base × exp(-distance / scaleKm) × multiplier)
     * floored at GLOBE_DROP_MIN_POINTS.
     *
     * Legacy model (only when `multiplier` is not provided): falls
     * back to compounding continent × difficulty × population
     * multipliers, so callers that haven't migrated yet keep working.
     *
     * @param {object} args
     * @param {number} args.distanceKm
     * @param {number} [args.multiplier] — preferred round multiplier
     * @param {string} [args.region] — legacy: continent label
     * @param {string} [args.difficulty] — legacy: easy/medium/hard
     * @param {number} [args.population] — legacy: city population
     */
    function scoreGuess(args) {
        const distanceKm = args && args.distanceKm;
        const max = Config.GLOBE_DROP_BASE_POINTS;
        const scale = Config.GLOBE_DROP_DISTANCE_SCALE_KM;
        const floor = typeof Config.GLOBE_DROP_MIN_POINTS === 'number' ? Config.GLOBE_DROP_MIN_POINTS : 0;
        const d = Math.max(0, Number(distanceKm) || 0);
        const base = max * Math.exp(-d / scale);

        // New model: single round multiplier.
        if (args && typeof args.multiplier === 'number' && Number.isFinite(args.multiplier)) {
            const mult = args.multiplier;
            const points = Math.max(floor, Math.round(base * mult));
            return {
                points,
                distanceKm: d,
                multiplier: mult,
                basePoints: Math.round(base)
            };
        }

        // Legacy model: compound multipliers.
        const region = args && args.region;
        const difficulty = args && args.difficulty;
        const population = args && args.population;
        const mult = continentMultiplier(region);
        const diff = difficultySettings(difficulty);
        const diffMult = diff.scoreMultiplier;
        const popMult = populationWeight(population);
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
        scoreGuess,
        ROUND_MULTIPLIERS,
        roundMultiplierForIndex,
        assignRoundMultipliers,
        quantizeToLadder,
        locationDifficultyScore,
        assignDifficultyMultipliers
    };
}));
