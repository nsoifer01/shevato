/*
 * Brain Arena — Emoji Chain helpers (Item #9).
 *
 * Pure helpers for the emoji-relay party game:
 *   - PHRASES: shipped phrase pool (movies / shows). Static so the
 *     game works offline + per-round creation doesn't depend on a
 *     third-party API.
 *   - pickPhrases(count, rand?) -> [{ id, phrase }]: random sample
 *     without replacement, with an injectable RNG for tests.
 *   - normalizeGuess(s): lowercase + strip non-alphanum so common
 *     punctuation / capitalization variants ("the lion king",
 *     "TheLionKing!") all match the canonical phrase.
 *   - guessMatches(typed, truth): boolean equality after normalize.
 *   - scoreRound(args): pure tally of per-player point deltas
 *     given the truth, guesses map, and votes map.
 *
 * UMD: CommonJS for node:test + window.BrainArena.EmojiChain.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.EmojiChain = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PHRASES = [
        'The Lion King', 'Harry Potter', 'Frozen', 'Star Wars',
        'Pirates of the Caribbean', 'Spider-Man', 'Toy Story', 'Finding Nemo',
        'Jurassic Park', 'The Matrix', 'Titanic', 'Avatar',
        'Inside Out', 'Despicable Me', 'Shrek', 'Beauty and the Beast',
        'Ice Age', 'The Avengers', 'Back to the Future', 'Home Alone',
        'Forrest Gump', 'Mary Poppins', 'Cinderella', 'Aladdin',
        'Game of Thrones', 'Breaking Bad', 'Stranger Things', 'The Office',
        'Friends', 'Squid Game', 'The Crown', 'Black Mirror'
    ];

    // Per-round scoring constants. Kept here (not in Config) so the
    // pure scoring helper has no implicit dependency.
    const POINTS_CORRECT_GUESS = 50;
    const POINTS_FUNNIEST_VOTE = 30;
    const POINTS_PROMPTER_HIT  = 10;

    function normalizeGuess(s) {
        return String(s == null ? '' : s)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    function guessMatches(typed, truth) {
        const a = normalizeGuess(typed);
        const b = normalizeGuess(truth);
        return !!a && !!b && a === b;
    }

    /**
     * Pick `count` phrases from PHRASES without replacement. `rand` is
     * an injectable [0,1) RNG so tests can pin the output.
     * @param {number} count
     * @param {() => number} [rand]
     * @returns {Array<{ id:string, phrase:string }>}
     */
    function pickPhrases(count, rand) {
        const r = typeof rand === 'function' ? rand : Math.random;
        const n = Math.max(1, Math.min(PHRASES.length, Number(count) || 3));
        const pool = PHRASES.slice();
        for (let i = 0; i < n; i++) {
            const j = i + Math.floor(r() * (pool.length - i));
            const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
        return pool.slice(0, n).map((phrase, idx) => ({
            id: `ec-${idx}-${phrase.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16)}`,
            phrase
        }));
    }

    /**
     * Score one Emoji Chain round.
     *
     * @param {object} args
     * @param {string} args.truth          — the secret phrase
     * @param {string} args.prompterUid    — uid of the player who
     *                                       sent the emoji
     * @param {object} args.guesses        — { [uid]: string }
     * @param {object} args.votes          — { [voterUid]: targetUid }
     * @returns {{ deltas: object, voteTotals: object, correctGuessers: string[], topUids: string[], topVotes: number }}
     */
    function scoreRound(args) {
        const truth = args && args.truth;
        const prompterUid = args && args.prompterUid;
        const guesses = (args && args.guesses && typeof args.guesses === 'object') ? args.guesses : {};
        const votes   = (args && args.votes   && typeof args.votes   === 'object') ? args.votes   : {};

        // Tally funniest-guess votes (excluding self-votes).
        const voteTotals = {};
        for (const [voter, target] of Object.entries(votes)) {
            if (!target || target === voter) continue;
            voteTotals[target] = (voteTotals[target] || 0) + 1;
        }
        let topVotes = 0;
        let topUids = [];
        for (const [uid, count] of Object.entries(voteTotals)) {
            if (count > topVotes) { topVotes = count; topUids = [uid]; }
            else if (count === topVotes) topUids.push(uid);
        }

        const correctGuessers = Object.entries(guesses)
            .filter(([, g]) => guessMatches(g, truth))
            .map(([uid]) => uid);
        const promptBonus = correctGuessers.length > 0 ? POINTS_PROMPTER_HIT : 0;

        const deltas = {};
        for (const uid of correctGuessers) deltas[uid] = (deltas[uid] || 0) + POINTS_CORRECT_GUESS;
        if (topVotes > 0) {
            for (const uid of topUids) deltas[uid] = (deltas[uid] || 0) + POINTS_FUNNIEST_VOTE;
        }
        if (prompterUid && promptBonus) deltas[prompterUid] = (deltas[prompterUid] || 0) + promptBonus;

        return { deltas, voteTotals, correctGuessers, topUids, topVotes };
    }

    return {
        PHRASES,
        POINTS_CORRECT_GUESS,
        POINTS_FUNNIEST_VOTE,
        POINTS_PROMPTER_HIT,
        normalizeGuess,
        guessMatches,
        pickPhrases,
        scoreRound
    };
}));
