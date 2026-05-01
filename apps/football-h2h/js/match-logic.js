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

    /**
     * Compute the next sequential numeric ID for a new game given the
     * existing games array. Empty array → 1. Non-numeric or missing IDs
     * are skipped so a partial / corrupt import can't yield NaN.
     */
    function nextGameId(games) {
        if (!Array.isArray(games) || games.length === 0) return 1;
        let max = 0;
        for (const g of games) {
            const n = Number(g && g.id);
            if (Number.isFinite(n) && n > max) max = n;
        }
        return max + 1;
    }

    /**
     * Validate the shape of an imported JSON payload from the export
     * button. Returns one of:
     *   { ok: true, games: [...], players: { player1, player2 } }
     *   { ok: false, error: '...' }
     *
     * The schema we accept (matches what exportData writes):
     *   {
     *     games: Array,                        // required
     *     players?: { player1?: string, player2?: string }
     *   }
     *
     * `players` is optional — older exports may not have it.
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
        const players = (payload.players && typeof payload.players === 'object')
            ? {
                player1: typeof payload.players.player1 === 'string' ? payload.players.player1 : 'Player 1',
                player2: typeof payload.players.player2 === 'string' ? payload.players.player2 : 'Player 2',
            }
            : { player1: 'Player 1', player2: 'Player 2' };
        return { ok: true, games: payload.games, players };
    }

    const api = {
        compareGames,
        sortGames,
        nextGameId,
        parseImportPayload,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.FootballMatchLogic = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
