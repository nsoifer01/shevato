/*
 * Brain Arena — profile stats helpers (Item #7 + #2 leaderboard gate).
 *
 * Pure helpers that own the small arithmetic decisions baked into the
 * end-of-game write path, so they're testable without Firestore:
 *   - accumulateByGameType(prev, game): merge one game's totals into
 *     a per-game-type bucket; returns the next bucket state.
 *   - isDailyPersonalBest(newScore, prevScore): the gate the daily
 *     leaderboard write uses to skip non-personal-bests.
 *
 * UMD: CommonJS for node:test + window.BrainArena.ProfileStats.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.ProfileStats = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Merge one game's outcome into a per-game-type stat bucket.
     * Treats every numeric field as additive except `bestRoundScore`,
     * which is the max of prev + this game.
     *
     * @param {object} prev — the existing bucket (may be undefined).
     * @param {object} game — { scoreEarned, winsDelta, bullseyesDelta, bestRoundThisGame }
     * @returns {object} the next bucket (new object, doesn't mutate prev)
     */
    function accumulateByGameType(prev, game) {
        const base = (prev && typeof prev === 'object') ? prev : {};
        const g = game || {};
        const scoreEarned       = Math.max(0, Number(g.scoreEarned)       || 0);
        const winsDelta         = Math.max(0, Number(g.winsDelta)         || 0);
        const bullseyesDelta    = Math.max(0, Number(g.bullseyesDelta)    || 0);
        const bestRoundThisGame = Math.max(0, Number(g.bestRoundThisGame) || 0);
        return {
            xp:             (Number(base.xp)             || 0) + scoreEarned,
            gamesPlayed:    (Number(base.gamesPlayed)    || 0) + 1,
            wins:           (Number(base.wins)           || 0) + winsDelta,
            bullseyes:      (Number(base.bullseyes)      || 0) + bullseyesDelta,
            bestRoundScore: Math.max(Number(base.bestRoundScore) || 0, bestRoundThisGame)
        };
    }

    /**
     * Does the new score qualify as today's personal best?
     * Used by maybeWriteDailyLeaderboard to skip writes that wouldn't
     * change the displayed row. `prevScore` of -1 (or null/undefined)
     * means "no existing entry today" — any score wins.
     *
     * @param {number} newScore
     * @param {number|null|undefined} prevScore
     * @returns {boolean}
     */
    function isDailyPersonalBest(newScore, prevScore) {
        const n = Number(newScore);
        if (!Number.isFinite(n)) return false;
        if (prevScore == null) return true;
        const p = Number(prevScore);
        if (!Number.isFinite(p) || p < 0) return true;
        return n > p;
    }

    return {
        accumulateByGameType,
        isDailyPersonalBest
    };
}));
