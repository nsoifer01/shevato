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
     * Continent obscurity weights. Europe gets 0 because European
     * capitals dominate global media; Antarctic gets the highest
     * because the few research-station "capitals" are basically
     * unknown trivia. Designed to be additive (not multiplicative)
     * so combining with other signals stays predictable.
     */
    const CONTINENT_OBSCURITY = {
        europe:    0.0,
        americas:  0.1,
        asia:      0.2,
        africa:    0.3,
        oceania:   0.4,
        antarctic: 0.5
    };

    /**
     * Country-population obscurity tiers. The strongest single
     * signal: large-population countries (China, India, USA) have
     * household-name capitals; micro-states (Tuvalu, Nauru) have
     * capitals almost nobody can name. Step function rather than
     * a continuous log curve so the cutoffs are explicit and
     * tunable.
     */
    function populationObscurity(pop) {
        if (!Number.isFinite(pop) || pop <= 0) return 0.4; // missing → neutral mid
        if (pop >= 100_000_000) return 0.0;
        if (pop >=  30_000_000) return 0.1;
        if (pop >=  10_000_000) return 0.3;
        if (pop >=   3_000_000) return 0.6;
        if (pop >=     500_000) return 0.9;
        if (pop >=      50_000) return 1.2;
        if (pop >=       5_000) return 1.5;
        return 1.7;
    }

    /**
     * Country-area obscurity tiers. Smaller area weakly correlates
     * with lower geopolitical prominence; the strongest signal in
     * the tail is the < 1 000 sq km micro-state cluster where you're
     * dealing with city-states and island specks.
     */
    function areaObscurity(area) {
        if (!Number.isFinite(area) || area <= 0) return 0.1;
        if (area >=   500_000) return 0.0;
        if (area >=   100_000) return 0.0;
        if (area >=    20_000) return 0.2;
        if (area >=     5_000) return 0.4;
        if (area >=     1_000) return 0.6;
        if (area >=       100) return 0.7;
        return 0.9;
    }

    /**
     * City-population obscurity tiers, used for city-target rounds
     * (major-cities, top-cities-by-country) where the guess target is
     * a CITY rather than a capital/country. Here the city's OWN size is
     * the difficulty signal: a 200k city is far harder to place than an
     * 8M megacity even in the same famous country, so a smaller city
     * yields a higher obscurity weight. Step function mirroring
     * populationObscurity / areaObscurity for explicit, tunable cutoffs.
     */
    function cityPopulationObscurity(pop) {
        if (!Number.isFinite(pop) || pop <= 0) return 1.8; // missing / invalid -> hardest
        if (pop >= 8_000_000) return 0.0;
        if (pop >= 4_000_000) return 0.3;
        if (pop >= 2_000_000) return 0.6;
        if (pop >= 1_000_000) return 0.9;
        if (pop >=   500_000) return 1.2;
        if (pop >=   250_000) return 1.5;
        return 1.8;
    }

    /**
     * Per-location difficulty score combining every signal we have:
     *
     *   continent   0.0 – 0.5  (Europe easiest, Antarctic hardest)
     *   + pop tier  0.0 – 1.7  (>100M → 0; <5k → 1.7) — dominant signal
     *   + area tier 0.0 – 0.9  (huge → 0; <100 sq km → 0.9)
     *   + 0.5       if subregion ∈ OBSCURE_SUBREGIONS
     *   + 0.3       if independent === false (dependency / overseas territory)
     *
     * Continuous output (typically 0 – 3.5+); quantizeToLadder snaps
     * it onto the [1.0, 1.5, 2.0, 2.5, 3.0] ladder.
     *
     * Expected behavior on real capitals:
     *   London / Paris / Berlin / Tokyo / Beijing / Moscow / Cairo  → ×1.0
     *   Brussels / Vienna / Copenhagen / Helsinki / Reykjavik        → ×1.5
     *   Bangui / Bishkek / Niamey / Ouagadougou                      → ×1.5
     *   Ciudad de la Paz (Eq. Guinea) / Vatican / Monaco             → ×1.5–2.0
     *   St. George's / Castries / Roseau (Caribbean capitals)        → ×2.0–2.5
     *   The Valley (Anguilla, dependent)                             → ×3.0
     *   Funafuti (Tuvalu) / Yaren (Nauru) / Palikir (FSM)            → ×3.0
     *
     * City-target rounds (major-cities, top-cities-by-country) carry a
     * finite positive `population` (the city's own size). For those we
     * swap the country population+area terms for cityPopulationObscurity
     * keyed on the city's population, so a small top-city in a famous
     * big country no longer collapses to ×1 purely from country size.
     */
    function locationDifficultyScore(loc) {
        if (!loc) return 1;
        const region = String(loc.region || '').toLowerCase();
        const cont = (region in CONTINENT_OBSCURITY) ? CONTINENT_OBSCURITY[region] : 0.2;
        const subBoost = OBSCURE_SUBREGIONS.indexOf(String(loc.subregion || '')) !== -1 ? 0.5 : 0;
        const depBoost = loc.independent === false ? 0.3 : 0;
        const cityPop = Number(loc.population);
        if (Number.isFinite(cityPop) && cityPop > 0) {
            return cont + cityPopulationObscurity(cityPop) + subBoost + depBoost;
        }
        const pop  = populationObscurity(Number(loc.countryPopulation));
        const area = areaObscurity(Number(loc.countryAreaSqKm));
        return cont + pop + area + subBoost + depBoost;
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
     *
     * `roundType` (optional): for 'major-cities' the multiplier is keyed off
     * the city's CONTINENT instead of the per-location difficulty score,
     * because every city in that pack is a big famous metropolis and
     * population barely separates them. All other round types use the
     * per-location difficulty model.
     */
    function majorCitiesContinentMultiplier(region) {
        const table = Config.GLOBE_DROP_MAJOR_CITIES_CONTINENT_MULT || {};
        const key = String(region || '').trim().toLowerCase();
        const m = table[key];
        return (typeof m === 'number' && Number.isFinite(m)) ? m : 1.0;
    }

    function assignDifficultyMultipliers(locations, roundType) {
        if (!Array.isArray(locations)) return [];
        const continentMode = roundType === 'major-cities';
        return locations.map((loc) => Object.assign({}, loc, {
            multiplier: continentMode
                ? quantizeToLadder(majorCitiesContinentMultiplier(loc && loc.region))
                : quantizeToLadder(locationDifficultyScore(loc))
        }));
    }

    /**
     * Score a single guess.
     *
     * New model (preferred): pass `multiplier` directly. Score is
     *   basePoints × multiplier
     * where basePoints maps a blended shape onto [floor, max]:
     *   shape = EXP_WEIGHT·exp(-d/scale) + (1-EXP_WEIGHT)·max(0, 1 - d/maxDist)
     *   basePoints = round(floor + (max - floor)·shape)
     * (floor = GLOBE_DROP_MIN_BASE_POINTS). The exponential term is sharp near
     * the target; the linear-to-antipode term keeps a real slope through the
     * whole tail so two far guesses still differ. basePoints is strictly
     * decreasing in distance — a closer guess always scores more, with no flat
     * floor plateau. Flooring the BASE (not the total) keeps basePoints ×
     * multiplier = points exact (no hidden floor/streak) and the base never
     * reaches 0.
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
            // Base curve = EXPONENTIAL (sharp near the target) blended with a
            // LINEAR ramp to the antipode (keeps a real slope through the whole
            // tail, so two far-but-different guesses still differ instead of
            // both pinning to the floor), mapped onto [baseFloor, max]. The
            // floor is the ASYMPTOTIC bottom, not a hard max(), so the base is
            // STRICTLY decreasing in distance — a closer guess always scores
            // more. Flooring the BASE (not the total) keeps basePoints ×
            // multiplier = points exact, and the base never reaches 0.
            const baseFloor = typeof Config.GLOBE_DROP_MIN_BASE_POINTS === 'number'
                ? Config.GLOBE_DROP_MIN_BASE_POINTS : 0;
            const span = Math.max(0, max - baseFloor);
            const w = typeof Config.GLOBE_DROP_DISTANCE_EXP_WEIGHT === 'number'
                ? Config.GLOBE_DROP_DISTANCE_EXP_WEIGHT : 1;
            const maxDist = typeof Config.GLOBE_DROP_MAX_DISTANCE_KM === 'number' && Config.GLOBE_DROP_MAX_DISTANCE_KM > 0
                ? Config.GLOBE_DROP_MAX_DISTANCE_KM : 20015;
            const expPart = Math.exp(-d / scale);
            const linPart = Math.max(0, 1 - d / maxDist);
            const shape = w * expPart + (1 - w) * linPart;
            const basePoints = Math.round(baseFloor + span * shape);
            const points = Math.round(basePoints * mult);
            return {
                points,
                distanceKm: d,
                multiplier: mult,
                basePoints
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
        cityPopulationObscurity,
        majorCitiesContinentMultiplier,
        locationDifficultyScore,
        assignDifficultyMultipliers
    };
}));
