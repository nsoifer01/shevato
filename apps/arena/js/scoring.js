/*
 * Brain Arena — scoring math.
 *
 * Pure functions, no DOM/Firebase. Exported as CommonJS (for node:test) and
 * window.BrainArena.Scoring (for the browser app, loaded as a classic script).
 *
 * The full point award for a correct answer is:
 *   (SCORE_BASE_CORRECT + speedBonus) * streakMultiplier
 * where speedBonus = SCORE_SPEED_BONUS_MAX * fractionOfTimeRemaining,
 * and streakMultiplier = 1 + STREAK_MULTIPLIER_STEP * min(streakAfter, STREAK_MULTIPLIER_CAP).
 * Wrong / no answer earns 0 and resets the streak to 0.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        const Config = require('./config.js');
        module.exports = factory(Config);
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.Scoring = factory(ns.Config);
    }
}(typeof self !== 'undefined' ? self : this, function (Config) {
    'use strict';

    /**
     * Compute the streak multiplier for the streak count *after* the
     * current correct answer is applied. Wrong answers don't call this —
     * they just reset the streak to 0.
     * @param {number} streakAfter — streak count including this answer
     * @returns {number} multiplier (1.0 for streak<=1, capped per config)
     */
    function streakMultiplier(streakAfter) {
        if (!Number.isFinite(streakAfter) || streakAfter <= 1) return 1;
        const capped = Math.min(streakAfter - 1, Config.STREAK_MULTIPLIER_CAP);
        return 1 + Config.STREAK_MULTIPLIER_STEP * capped;
    }

    /**
     * Calculate the speed bonus for an answer submitted with `timeLeftMs`
     * remaining out of `totalMs`. Linear decay: full bonus at t=0, zero at
     * the buzzer. Clamps to [0, max] so a late-arriving write past the
     * server cutoff still scores nonnegative.
     * @param {number} timeLeftMs
     * @param {number} totalMs
     * @returns {number} integer bonus
     */
    function speedBonus(timeLeftMs, totalMs) {
        if (!totalMs || totalMs <= 0) return 0;
        const fraction = Math.max(0, Math.min(1, timeLeftMs / totalMs));
        return Math.round(Config.SCORE_SPEED_BONUS_MAX * fraction);
    }

    /**
     * Score a single answer.
     * @param {object} args
     * @param {boolean} args.correct — whether the player picked the right option
     * @param {number} args.timeLeftMs — time remaining when submitted
     * @param {number} args.totalMs — full question duration
     * @param {number} args.streakBefore — streak going into this question
     * @returns {{ pointsEarned: number, streakAfter: number, breakdown: object }}
     */
    function scoreAnswer({ correct, timeLeftMs, totalMs, streakBefore }) {
        const streakIn = Math.max(0, Number(streakBefore) || 0);
        if (!correct) {
            return {
                pointsEarned: 0,
                streakAfter: 0,
                breakdown: { base: 0, speed: 0, multiplier: 1, correct: false }
            };
        }
        const streakAfter = streakIn + 1;
        const mult = streakMultiplier(streakAfter);
        const speed = speedBonus(timeLeftMs, totalMs);
        const base = Config.SCORE_BASE_CORRECT;
        const points = Math.round((base + speed) * mult);
        return {
            pointsEarned: points,
            streakAfter,
            breakdown: { base, speed, multiplier: mult, correct: true }
        };
    }

    /**
     * Sort scoreboard entries (highest score first; ties broken by streak,
     * then by displayName for stability).
     * @param {Array<{ score:number, streak:number, displayName:string }>} players
     * @returns {Array} new sorted array (does not mutate input)
     */
    function rankPlayers(players) {
        if (!Array.isArray(players)) return [];
        return players.slice().sort((a, b) => {
            const sa = Number(a.score) || 0;
            const sb = Number(b.score) || 0;
            if (sb !== sa) return sb - sa;
            const ka = Number(a.streak) || 0;
            const kb = Number(b.streak) || 0;
            if (kb !== ka) return kb - ka;
            const na = String(a.displayName || '');
            const nb = String(b.displayName || '');
            return na.localeCompare(nb);
        });
    }

    return { streakMultiplier, speedBonus, scoreAnswer, rankPlayers };
}));
