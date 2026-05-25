/*
 * Brain Arena — Word Blitz helpers (Item #6).
 *
 * Fastest-finger typing race. Pure helpers in this module:
 *   - normalizeWord(s): lowercase + strip non-letters so "Lighthouse "
 *     and "lighthouse" both match the target.
 *   - wordsMatch(a, b): boolean equality after normalize.
 *   - buildWordList(pool, count, rand): pick N words from the pool
 *     without replacement (deterministic given `rand`).
 *
 * The Firestore-touching write/scoring code lives in app.js so all
 * network concerns stay in one place; this file is the
 * deterministically-testable core.
 *
 * UMD: CommonJS for node:test + window.BrainArena.WordBlitz.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.WordBlitz = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function normalizeWord(s) {
        return String(s == null ? '' : s)
            .toLowerCase()
            .replace(/[^a-z]/g, '');
    }

    function wordsMatch(a, b) {
        const na = normalizeWord(a);
        const nb = normalizeWord(b);
        return !!na && na === nb;
    }

    /**
     * Pick `count` words from `pool` without replacement. `rand` is an
     * optional injectable RNG so tests can pin the output; defaults to
     * Math.random.
     * @param {Array<string|object>} pool — strings or `{word:string}`
     * @param {number} count
     * @param {() => number} [rand]
     * @returns {Array<{ id:string, word:string }>}
     */
    function buildWordList(pool, count, rand) {
        const r = typeof rand === 'function' ? rand : Math.random;
        const flat = (Array.isArray(pool) ? pool : [])
            .map((entry) => {
                if (typeof entry === 'string') return entry;
                if (entry && typeof entry === 'object') return entry.word;
                return null;
            })
            .map((w) => String(w || '').trim())
            .filter((w) => w.length > 0);
        if (!flat.length) return [];
        // Fisher-Yates partial shuffle so we only sort what we'll take.
        const n = Math.max(1, Math.min(flat.length, Number(count) || 10));
        const out = flat.slice();
        for (let i = 0; i < n; i++) {
            const j = i + Math.floor(r() * (out.length - i));
            const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
        }
        return out.slice(0, n).map((word, idx) => ({
            // Stable per-round id; doesn't have to be unique across games,
            // just within a single game (the picker keys against it).
            id: `wb-${idx}-${normalizeWord(word).slice(0, 12)}`,
            word
        }));
    }

    return {
        normalizeWord,
        wordsMatch,
        buildWordList
    };
}));
