/*
 * Brain Arena — runtime constants.
 *
 * UMD-style export: CommonJS for node:test, attached to a window namespace
 * (window.BrainArena.Config) for browser classic scripts.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.Config = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    return {
        // Room codes are 5 uppercase letters/digits, excluding visually
        // ambiguous characters (0/O, 1/I/L) to keep verbal sharing painless.
        ROOM_CODE_LENGTH: 5,
        ROOM_CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',

        // Question pacing.
        QUESTION_TIME_MS: 15000,       // 15s to answer each question
        REVEAL_TIME_MS: 2500,          // 2.5s to read the correct-answer text, then next picker
        MAX_QUESTIONS_PER_GAME: 10,

        // Scoring — base for correctness + a speed bonus that decays linearly
        // with time remaining. Streaks add a multiplier capped at +50%.
        // Per-question max = (100 + 100) * 1.5 = 300, so a 10-question
        // round tops out around 3000 and typical play lands ~1000–2000.
        // Small enough to read at a glance, big enough to feel like points.
        SCORE_BASE_CORRECT: 100,
        SCORE_SPEED_BONUS_MAX: 100,
        STREAK_MULTIPLIER_STEP: 0.1,   // +10% per consecutive correct
        STREAK_MULTIPLIER_CAP: 5,      // capped at 5 in a row (=> 1.5x)

        // Cosmetic limits.
        MAX_DISPLAY_NAME: 20,
        MAX_PLAYERS_PER_ROOM: 16,

        // ---------- GlobeDrop mode ----------
        // Per-location timer. 120s matches your "X minutes" framing — gives
        // players time to study the map before committing.
        GLOBE_DROP_LOCATION_TIME_MS: 120000,
        // Post-round reveal window — pins, distances, Wikipedia blurb,
        // and the Ready bar so players who want to skip the wait can.
        GLOBE_DROP_REVEAL_TIME_MS: 10000,

        // Scoring is exponential decay: base * exp(-distance / scaleKm).
        // At 0km you get base * multiplier; at scaleKm you get ~37% of base.
        GLOBE_DROP_BASE_POINTS: 100,
        GLOBE_DROP_DISTANCE_SCALE_KM: 1500,

        // Hard floor so even an antipodal guess still earns 1-10 points
        // (no "you got 0" frustration). Tunable; lifts the worst possible
        // result enough to feel like effort was rewarded.
        GLOBE_DROP_MIN_POINTS: 5,

        // Population obscurity weight. Smaller, less globally-famous places
        // are worth more so the game rewards real geographic knowledge
        // instead of guessing famous capitals. Formula in globe-drop-scoring.js:
        //   weight = clamp((REFERENCE_LOG10 - log10(pop)) * SLOPE + 1, MIN, MAX)
        // tuned so pop=1M ≈ 1.0×, pop=10M ≈ 0.65×, pop=100k ≈ 1.4×,
        // pop=10k ≈ 1.8×. Missing population (legacy capitals) gets 1.0×.
        GLOBE_DROP_POPULATION_WEIGHT: {
            REFERENCE_LOG10: 6,   // log10(1,000,000) — typical "city" benchmark
            SLOPE: 0.35,
            MIN: 0.55,
            MAX: 2.0
        },

        // Continent multipliers per your spec — harder/lesser-known
        // continents (Africa, Asia, Oceania, Antarctic) score more than
        // Europe (the baseline) so the points reflect difficulty, not just
        // geographic luck. Keys are lowercased REST Countries `region`
        // strings; missing keys fall back to 1.0.
        GLOBE_DROP_CONTINENT_MULTIPLIERS: {
            africa: 1.3,
            asia: 1.3,
            europe: 1.0,
            americas: 1.1,
            oceania: 1.4,
            antarctic: 1.5
        },

        // Default round size dropdown for GlobeDrop (locations per game).
        GLOBE_DROP_LOCATIONS_DEFAULT: 5,

        // Globe Drop bullseye streak. A streak increments when a player earns
        // base score >= 98 (near-perfect guess). Consecutive bullseyes add a
        // multiplier capped at GLOBE_DROP_STREAK_MULTIPLIER_CAP consecutive
        // bullseyes. The multiplier is applied on top of the distance/continent
        // score so a hot streak can meaningfully swing the leaderboard.
        GLOBE_DROP_STREAK_MULTIPLIER_STEP: 0.1,   // +10% per consecutive bullseye
        GLOBE_DROP_STREAK_MULTIPLIER_CAP: 5,       // capped at 5 in a row (=> 1.5x)

        // Cap on small-island-nation entries per playlist. Without this,
        // luck-of-the-shuffle can pack three Maldives-class capitals into
        // a 5-location game and turn it into "name the Caribbean specks".
        // Heuristic: country.area <= GLOBE_DROP_SMALL_ISLAND_MAX_AREA AND
        // country.subregion matches a known island-cluster subregion.
        GLOBE_DROP_SMALL_ISLAND_MAX_PER_GAME: 2,
        GLOBE_DROP_SMALL_ISLAND_MAX_AREA: 50000,    // sq km
        GLOBE_DROP_SMALL_ISLAND_SUBREGIONS: [
            'Caribbean', 'Polynesia', 'Micronesia', 'Melanesia'
        ],

        // Difficulty tiers for GlobeDrop. Each tier overrides the per-location
        // timer, controls which hints render alongside the city name, and
        // multiplies the final score after distance + continent multipliers.
        // hintLevel values:
        //   'country+continent+subregion' — easy: full geographic context
        //   'country+continent'           — medium: country and continent
        //   'country'                     — hard: city + country
        // Per-difficulty timers were removed — every room defaults to
        // GLOBE_DROP_DEFAULT_TIMER_SEC and the host can override via the
        // "Time per location" field in the lobby form. Keeping a `timerSec`
        // alias on each tier for older code paths that still read it; the
        // value is identical regardless of tier so changing difficulty
        // mid-lobby no longer rewrites the timer.
        GLOBE_DROP_DEFAULT_TIMER_SEC: 60,
        GLOBE_DROP_DIFFICULTY_DEFAULT: 'medium',
        GLOBE_DROP_DIFFICULTIES: {
            easy:   { label: 'Easy',   timerSec: 60, hintLevel: 'country+continent+subregion', scoreMultiplier: 0.75 },
            medium: { label: 'Medium', timerSec: 60, hintLevel: 'country+continent',            scoreMultiplier: 1.00 },
            hard:   { label: 'Hard',   timerSec: 60, hintLevel: 'country',                       scoreMultiplier: 1.50 }
        }
    };
}));
