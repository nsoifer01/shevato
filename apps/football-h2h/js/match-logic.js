// Pure helpers for match list manipulation: sorting, ID assignment, and
// validating an imported export payload. Extracted from football-h2h.js
// so they can be unit-tested without a DOM or browser globals.
//
// UMD-style wrapper (matches playerStats.js): exposes
// window.FootballMatchLogic in the browser AND module.exports for
// node:test, with no build step.

(function (root) {
    'use strict';

    /**
     * Pure sort comparator for the games table. `column` is one of:
     *   'game'    — by numeric game id
     *   'date'    — by ISO dateTime; missing dateTime sorts as epoch
     *   'player1' — by player1Goals
     *   'player2' — by player2Goals
     * `direction` is 'asc' or 'desc'. Unknown columns return 0 (stable).
     */
    function compareGames(a, b, column, direction) {
        let valueA;
        let valueB;
        switch (column) {
            case 'game':
                valueA = a.id;
                valueB = b.id;
                break;
            case 'date':
                valueA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
                valueB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
                break;
            case 'player1':
                valueA = a.player1Goals;
                valueB = b.player1Goals;
                break;
            case 'player2':
                valueA = a.player2Goals;
                valueB = b.player2Goals;
                break;
            default:
                return 0;
        }
        if (valueA < valueB) return direction === 'asc' ? -1 : 1;
        if (valueA > valueB) return direction === 'asc' ? 1 : -1;
        return 0;
    }

    /**
     * Return a new array of games sorted by the given column / direction.
     * Does not mutate the input.
     */
    function sortGames(games, column, direction) {
        if (!Array.isArray(games)) return [];
        return [...games].sort((a, b) => compareGames(a, b, column, direction));
    }

    // max(numeric values of `key` across games) + 1, skipping non-numeric or
    // missing values so a partial / corrupt import can't yield NaN.
    // `floor` is the minimum the max is allowed to start from.
    function nextSequential(games, key, floor) {
        let max = floor;
        for (const g of games) {
            const n = Number(g && g[key]);
            if (Number.isFinite(n) && n > max) max = n;
        }
        return max + 1;
    }

    /**
     * Compute the next sequential numeric ID for a new game given the
     * existing games array. Empty array → 1.
     */
    function nextGameId(games) {
        if (!Array.isArray(games) || games.length === 0) return 1;
        return nextSequential(games, 'id', 0);
    }

    /**
     * Compute the next display gameNumber: max(existing gameNumber) + 1,
     * never games.length + 1, so deleting a game can't re-issue a number
     * already in use. The floor is games.length because rows WITHOUT a
     * gameNumber render their 1-based position instead, so a fresh number
     * must clear the positional range too.
     */
    function nextGameNumber(games) {
        if (!Array.isArray(games) || games.length === 0) return 1;
        return nextSequential(games, 'gameNumber', games.length);
    }

    /**
     * Canonical penaltyWinner values are the NUMBER 1, the NUMBER 2, the
     * string 'draw', or null. Legacy string '1' / '2' (written by a removed
     * modal path or hand-edited imports) are coerced to numbers; anything
     * else collapses to null (no shootout).
     */
    function normalizePenaltyWinner(value) {
        if (value === 1 || value === 2 || value === 'draw') return value;
        if (value === '1' || value === '2') return Number(value);
        return null;
    }

    // A goal count is valid when it is (or parses as) a non-negative
    // integer. Returns the coerced number, or null when invalid. Only
    // numbers and non-blank strings are considered: [] and null also
    // coerce to 0 via Number() and must not slip through.
    function toValidGoals(value) {
        if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
            return null;
        }
        const n = Number(value);
        return (Number.isInteger(n) && n >= 0) ? n : null;
    }

    // Validate and normalize one imported game row. Returns a normalized
    // copy (numeric goals, canonical penaltyWinner) or null when the row
    // is not usable (non-object, or either score missing / negative /
    // non-integer). Everything else on the row is carried across verbatim.
    function normalizeImportedGame(row) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
        const player1Goals = toValidGoals(row.player1Goals);
        const player2Goals = toValidGoals(row.player2Goals);
        if (player1Goals === null || player2Goals === null) return null;
        return Object.assign({}, row, {
            player1Goals,
            player2Goals,
            penaltyWinner: normalizePenaltyWinner(row.penaltyWinner),
        });
    }

    /**
     * Validate the shape of an imported JSON payload from the export
     * button. Returns one of:
     *   { ok: true, games: [...], players: { player1, player2 }, rejected: n }
     *   { ok: false, error: '...' }
     *
     * The schema we accept (matches what exportData writes):
     *   {
     *     games: Array,                        // required
     *     players?: { player1?: string, player2?: string }
     *   }
     *
     * `players` is optional — older exports may not have it.
     *
     * Per-game validation: each row must be an object with non-negative
     * integer scores for both players (numeric strings are coerced).
     * Valid rows come back normalized (numeric goals, canonical
     * penaltyWinner: 1 / 2 / 'draw' / null); invalid rows are dropped and
     * counted in `rejected` so the import UI can report them instead of
     * storing rows that would NaN-poison the aggregates.
     *
     * The function never throws on malformed input; non-object payloads,
     * missing games array, etc. all return ok: false with a short reason.
     */
    function parseImportPayload(payload) {
        if (!payload || typeof payload !== 'object') {
            return { ok: false, error: 'Payload is not an object' };
        }
        if (!Array.isArray(payload.games)) {
            return { ok: false, error: 'Missing games array' };
        }
        const games = [];
        let rejected = 0;
        for (const row of payload.games) {
            const normalized = normalizeImportedGame(row);
            if (normalized) games.push(normalized);
            else rejected += 1;
        }
        const players = (payload.players && typeof payload.players === 'object')
            ? {
                player1: typeof payload.players.player1 === 'string' ? payload.players.player1 : 'Player 1',
                player2: typeof payload.players.player2 === 'string' ? payload.players.player2 : 'Player 2',
            }
            : { player1: 'Player 1', player2: 'Player 2' };
        return { ok: true, games, players, rejected };
    }

    const api = {
        compareGames,
        sortGames,
        nextGameId,
        nextGameNumber,
        normalizePenaltyWinner,
        parseImportPayload,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.FootballMatchLogic = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
