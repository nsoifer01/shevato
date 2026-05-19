/*
 * Brain Arena — runtime constants.
 *
 * UMD-style export: CommonJS for node:test, attached to a window namespace
 * (window.BrainArena.Config) for browser classic scripts.
 *
 * STRIPE_CHECKOUT_URL is intentionally a placeholder — flip it to the real
 * Stripe Checkout link post-merge, no other code needs to change.
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
        // Where the "Go Premium" button sends users. Replace with your real
        // Stripe Checkout link or Payment Link URL after merge — no other
        // code references it.
        STRIPE_CHECKOUT_URL: 'https://buy.stripe.com/test_placeholder_trivia_arena_premium',

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

        // XP earned == score (1:1). With the smaller scoring scale above,
        // this gives ~1000–3000 XP per game — feels rewarding without
        // exploding profile totals.
        XP_PER_POINT_DIVISOR: 1,

        // Master switch for the premium tier. When false (default):
        //   - all premium UI is hidden (modal, profile card, "Premium" tags,
        //     admin toggles, the locked detailed-stats panel),
        //   - every gated feature is unlocked for every signed-in user
        //     (isPremium() short-circuits to true in app.js).
        // The pure helpers in premium.js stay enforceable so the trial /
        // paid math is testable, and so flipping this flag to `true` after
        // a Stripe Payment Link is wired up turns the whole flow on cleanly.
        // See apps/brain-arena/PREMIUM_SETUP.md for the full rollout steps.
        PREMIUM_UI_ENABLED: false,

        // Premium tier — keep this list small and load-bearing. The premium
        // boolean lives at users/{uid}.triviaProfile.premium.
        // Private password-protected rooms are NOT in this list — they're
        // a free feature for every signed-in user. Anyone can flip the
        // "Private" toggle in the create-room form and set a password.
        PREMIUM_FEATURES: {
            CUSTOM_PACKS: 'custom-packs',
            DETAILED_STATS: 'detailed-stats'
        },

        // One-time $5 (no recurring subscription). Display string only —
        // the actual amount is configured in the Stripe Product / Payment
        // Link, this constant is just what we surface in the UI.
        PREMIUM_PRICE_DISPLAY: '$5 one-time',

        // 30-day free trial — every signed-up user gets full premium access
        // for the first 30 days from triviaProfile.signedUpAt. After that
        // they need to pay $5 (one-time) to keep the gates open. Measured
        // in ms so the math matches Date.now() / Timestamp.toMillis().
        TRIAL_DURATION_MS: 30 * 24 * 60 * 60 * 1000,

        // Admin uids for the dev-only "toggle premium" / "reset trial"
        // buttons in the profile view. Empty array = no admin controls
        // visible to anyone. Add your own Firebase uid here to test the
        // gates without paying $5 every cycle.
        ADMIN_UIDS: [],

        // Cosmetic limits.
        MAX_DISPLAY_NAME: 20,
        MAX_PLAYERS_PER_ROOM: 16,

        // ---------- GlobeDrop mode ----------
        // Per-location timer. 120s matches your "X minutes" framing — gives
        // players time to study the map before committing.
        GLOBE_DROP_LOCATION_TIME_MS: 120000,
        // 3s glimpse of pins/distances + Wikipedia blurb, then advance.
        GLOBE_DROP_REVEAL_TIME_MS: 5000,

        // Scoring is exponential decay: base * exp(-distance / scaleKm).
        // At 0km you get base * multiplier; at scaleKm you get ~37% of base.
        GLOBE_DROP_BASE_POINTS: 100,
        GLOBE_DROP_DISTANCE_SCALE_KM: 1500,

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

        // Difficulty tiers for GlobeDrop. Each tier overrides the per-location
        // timer, controls which hints render alongside the city name, and
        // multiplies the final score after distance + continent multipliers.
        // hintLevel values:
        //   'country+continent+subregion' — easy: full geographic context
        //   'country+continent'           — medium: country and continent
        //   'country'                     — current default for legacy rooms
        //   'none'                        — hard: city name only, no country
        // scoreMultiplier is exposed in the lobby and end-card so players see
        // the tradeoff before they pick.
        GLOBE_DROP_DIFFICULTY_DEFAULT: 'medium',
        GLOBE_DROP_DIFFICULTIES: {
            easy:   { label: 'Easy',   timerSec: 180, hintLevel: 'country+continent+subregion', scoreMultiplier: 0.75 },
            medium: { label: 'Medium', timerSec: 120, hintLevel: 'country+continent',            scoreMultiplier: 1.00 },
            hard:   { label: 'Hard',   timerSec: 60,  hintLevel: 'none',                          scoreMultiplier: 1.50 }
        }
    };
}));
