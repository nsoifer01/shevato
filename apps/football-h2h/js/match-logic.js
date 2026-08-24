// Pure helpers for match list manipulation: sorting, ID assignment, goal
// parsing, draw detection, and validating / normalizing an imported export
// payload. Extracted from football-h2h.js so they can be unit-tested
// without a DOM or browser globals.
//
// UMD-style wrapper (matches playerStats.js): exposes
// window.FootballMatchLogic in the browser AND module.exports for
// node:test, with no build step.

(function (root) {
    'use strict';

    // Shared limits. The form inputs carry matching max / maxlength
    // attributes, but those are browser hints only; every write path
    // (add, edit, import, load-time heal) enforces these in JS.
    const MAX_GOALS = 99;
    const MAX_NAME_LENGTH = 30;
    const MAX_TEAM_LENGTH = 40;
    const MAX_NOTE_LENGTH = 80;

    // Sort key for the "Game #" column: the displayed gameNumber, falling
    // back to the id for rows that never received one. Sorting by id alone
    // only matched the displayed number for games added live; imported or
    // undo-restored rows sorted in an order the user could not see.
    function gameSortKey(game) {
        const n = Number(game && game.gameNumber);
        if (Number.isFinite(n)) return n;
        const id = Number(game && game.id);
        return Number.isFinite(id) ? id : 0;
    }

    /**
     * Pure sort comparator for the games table. `column` is one of:
     *   'game'    - by displayed gameNumber (id as fallback)
     *   'date'    - by ISO dateTime; missing dateTime sorts as epoch
     *   'player1' - by player1Goals
     *   'player2' - by player2Goals
     * `direction` is 'asc' or 'desc'. Unknown columns return 0 (stable).
     */
    function compareGames(a, b, column, direction) {
        let valueA;
        let valueB;
        switch (column) {
            case 'game':
                valueA = gameSortKey(a);
                valueB = gameSortKey(b);
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
     * existing games array. Empty array -> 1.
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

    // A goal count is valid when it is a non-negative integer no greater
    // than MAX_GOALS, written as plain digits. Returns the number, or null
    // when invalid. Strings must be digits only: `1e2` and `2.0` coerce
    // through Number() but are not scores a user meant to enter, and a
    // 21-digit value rendered as `1e+21` in the table. `02` is accepted
    // (it is the number 2). Only numbers and non-blank strings are
    // considered: [] and null also coerce to 0 via Number() and must not
    // slip through.
    function parseGoals(value) {
        if (typeof value === 'number') {
            return (Number.isInteger(value) && value >= 0 && value <= MAX_GOALS) ? value : null;
        }
        if (typeof value !== 'string') return null;
        const s = value.trim();
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return n <= MAX_GOALS ? n : null;
    }

    // Draw detection shared by the penalty-field visibility checks (sidebar
    // and edit modal) and the submit rules. Compares the PARSED numbers, so
    // `02` vs `2` is a draw everywhere; raw string comparison used to show
    // no penalty field while submit demanded one.
    function isDraw(a, b) {
        const x = parseGoals(a);
        const y = parseGoals(b);
        return x !== null && y !== null && x === y;
    }

    // Trim a free-text value and cap its length. Non-strings become ''.
    function cleanText(value, maxLength) {
        if (typeof value !== 'string') return '';
        return value.trim().slice(0, maxLength);
    }

    // A player name, trimmed and capped; blank falls back to the default.
    function cleanPlayerName(value, fallback) {
        return cleanText(value, MAX_NAME_LENGTH) || fallback;
    }

    function cleanTeamName(value, fallback) {
        return cleanText(value, MAX_TEAM_LENGTH) || fallback;
    }

    // Note: trimmed and capped; undefined when blank (the stored row omits
    // the key rather than carrying an empty string).
    function cleanNote(value) {
        return cleanText(value, MAX_NOTE_LENGTH) || undefined;
    }

    function isValidDateTime(value) {
        return typeof value === 'string' && value !== '' && Number.isFinite(new Date(value).getTime());
    }

    // Validate and normalize one imported game row. Returns a normalized
    // copy (numeric goals, canonical penaltyWinner, trimmed text) or null
    // when the row is not usable (non-object, or either score missing /
    // negative / non-integer / over MAX_GOALS). An unparseable dateTime is
    // dropped (the load-path migration then stamps one) and reported via
    // `repairs.dates` on the second argument when given. Other fields on
    // the row are carried across verbatim.
    function normalizeImportedGame(row, repairs) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
        const player1Goals = parseGoals(row.player1Goals);
        const player2Goals = parseGoals(row.player2Goals);
        if (player1Goals === null || player2Goals === null) return null;
        const out = Object.assign({}, row, {
            player1Goals,
            player2Goals,
            penaltyWinner: normalizePenaltyWinner(row.penaltyWinner),
        });
        if (row.dateTime !== undefined && row.dateTime !== null && !isValidDateTime(row.dateTime)) {
            delete out.dateTime;
            if (repairs) repairs.dates += 1;
        }
        if (row.player1Team !== undefined) out.player1Team = cleanTeamName(row.player1Team, 'Ultimate Team');
        if (row.player2Team !== undefined) out.player2Team = cleanTeamName(row.player2Team, 'Ultimate Team');
        const note = cleanNote(row.note);
        if (note) out.note = note; else delete out.note;
        return out;
    }

    // Give every row a stable numeric id and a gameNumber. Rows that
    // already carry a finite numeric id keep it; a repeated id is reported
    // (the caller decides whether to reject). Returns the number of rows
    // that were healed. Mutates the rows in place: this is the load-time
    // heal for legacy data and the last step of an import.
    //
    // Why: a row without an id rendered `editGame(undefined)` and
    // `games.filter(m => m.id !== undefined)` deleted EVERY id-less row at
    // once while the confirm named the first of them.
    function assignIds(games) {
        let healed = 0;
        const seen = new Set();
        let nextId = nextGameId(games);
        for (const g of games) {
            const id = Number(g.id);
            if (!Number.isFinite(id) || seen.has(id)) {
                g.id = nextId;
                nextId += 1;
                healed += 1;
            } else {
                g.id = id;
            }
            seen.add(g.id);
        }
        // gameNumber: rows without one used to render their 1-based position.
        // Issue numbers in array order above the current max so the displayed
        // numbers stay unique and stable across reloads (a fully numberless
        // legacy list gets 1..n, its old positional numbers).
        let nextNumber = nextSequential(games, 'gameNumber', 0);
        for (const g of games) {
            const n = Number(g.gameNumber);
            if (!Number.isFinite(n)) {
                g.gameNumber = nextNumber;
                nextNumber += 1;
                healed += 1;
            } else {
                g.gameNumber = n;
            }
        }
        return healed;
    }

    /**
     * Validate the shape of an imported JSON payload from the export
     * button. Returns one of:
     *   { ok: true, games: [...], players: { player1, player2 },
     *     rejected: n, repairs: { dates, ids, duplicates } }
     *   { ok: false, error: '...' }
     *
     * The schema we accept (matches what exportData writes):
     *   {
     *     games: Array,                        // required
     *     players?: { player1?: string, player2?: string }
     *   }
     *
     * `players` is optional: older exports may not have it.
     *
     * Per-game validation: each row must be an object with non-negative
     * integer scores (0..99, numeric strings coerced) for both players.
     * Valid rows come back normalized (numeric goals, canonical
     * penaltyWinner, trimmed team/note text, a stable numeric id and a
     * gameNumber); invalid rows and rows whose id repeats an earlier row's
     * are dropped and counted in `rejected` so the import UI can report
     * them instead of storing rows that would NaN-poison the aggregates or
     * collide on edit/delete.
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
        const repairs = { dates: 0, ids: 0, duplicates: 0 };
        let rejected = 0;
        const seenIds = new Set();
        for (const row of payload.games) {
            const normalized = normalizeImportedGame(row, repairs);
            if (!normalized) { rejected += 1; continue; }
            const id = Number(normalized.id);
            if (Number.isFinite(id) && seenIds.has(id)) {
                repairs.duplicates += 1;
                rejected += 1;
                continue;
            }
            if (Number.isFinite(id)) seenIds.add(id);
            games.push(normalized);
        }
        repairs.ids = assignIds(games);
        const players = (payload.players && typeof payload.players === 'object')
            ? {
                player1: cleanPlayerName(payload.players.player1, 'Player 1'),
                player2: cleanPlayerName(payload.players.player2, 'Player 2'),
            }
            : { player1: 'Player 1', player2: 'Player 2' };
        return { ok: true, games, players, rejected, repairs };
    }

    const api = {
        MAX_GOALS,
        MAX_NAME_LENGTH,
        MAX_TEAM_LENGTH,
        MAX_NOTE_LENGTH,
        compareGames,
        sortGames,
        nextGameId,
        nextGameNumber,
        normalizePenaltyWinner,
        parseGoals,
        isDraw,
        cleanPlayerName,
        cleanTeamName,
        cleanNote,
        assignIds,
        parseImportPayload,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.FootballMatchLogic = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
