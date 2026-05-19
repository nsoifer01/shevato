/*
 * Brain Arena — GlobeDrop daily-challenge helpers.
 *
 * Deterministic, pure utilities for the daily challenge:
 *   - dailyDateKey(now) → 'YYYY-MM-DD' in UTC (so everyone, regardless of
 *     timezone, plays the same locations on the same calendar day)
 *   - mulberry32(seed) → seeded RNG, returns a [0,1) function
 *   - seededShuffle(arr, seedString) → Fisher–Yates driven by mulberry32
 *
 * The challenge is: "given the live Wikidata/REST Countries result for
 * round type X today, deterministically pick the same N locations for
 * every player who plays today." Live data drift between morning and
 * evening is acceptable — Wikidata doesn't churn meaningfully — but
 * within a single day every player gets identical input.
 *
 * UMD: CommonJS for node:test + window.BrainArena.GlobeDropDaily.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.GlobeDropDaily = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Date key in UTC, format YYYY-MM-DD. We deliberately use UTC rather
     * than the player's local timezone so the daily challenge boundary
     * is the same worldwide — otherwise a player in Tokyo would see
     * "today" hours before a player in Los Angeles, and the leaderboard
     * would race in their favour.
     */
    function dailyDateKey(now) {
        const d = (now instanceof Date) ? now : new Date(now || Date.now());
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    /**
     * mulberry32 — small, fast, well-distributed seeded PRNG. We don't
     * need crypto here, just reproducibility across browsers given the
     * same seed. https://github.com/bryc/code/blob/master/jshash/PRNGs.md
     */
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function rand() {
            a = (a + 0x6D2B79F5) | 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /**
     * Hash a string to a 32-bit integer (FNV-1a). Used to turn the date
     * string (or any other label) into a mulberry32 seed.
     */
    function hashStringToSeed(str) {
        let h = 0x811c9dc5;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    /**
     * Deterministic Fisher–Yates shuffle. Same `seedString` always
     * produces the same ordering for the same input array.
     */
    function seededShuffle(arr, seedString) {
        const seed = hashStringToSeed(seedString);
        const rand = mulberry32(seed);
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    /**
     * Pick the daily playlist out of a candidate pool. Same date +
     * same pool order ⇒ same N locations. Pool ordering must be stable
     * across the day for this to hold; the live data sources are stable
     * within practical use.
     */
    function pickDailyLocations(pool, count, dateKey) {
        if (!Array.isArray(pool) || !pool.length) return [];
        const shuffled = seededShuffle(pool, `globe-drop-daily-${dateKey}`);
        const n = Math.max(1, Math.min(shuffled.length, Number(count) || 5));
        return shuffled.slice(0, n);
    }

    return {
        dailyDateKey,
        mulberry32,
        hashStringToSeed,
        seededShuffle,
        pickDailyLocations
    };
}));
