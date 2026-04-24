// Pure functions for per-player derived stats based only on scores-per-game.
// Works both as a browser <script> (exposes window.FootballPlayerStats) and as
// a CommonJS module (so node --test can require it directly, no build step).

(function (root) {
    'use strict';

    function toScore(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function cleanScores(arr) {
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const v of arr) {
            const n = toScore(v);
            if (n !== null) out.push(n);
        }
        return out;
    }

    // scores must be chronological (oldest first) for streaks and recent form.
    function computePlayerStats(scoresChronological) {
        const scores = cleanScores(scoresChronological);
        const games = scores.length;

        if (games === 0) {
            return {
                games: 0,
                totalGoals: 0,
                goalsPerGame: 0,
                highestScore: 0,
                lowestScore: 0,
                scoringRate: 0,
                multiGoalRate: 0,
                currentScoringStreak: 0,
                currentScorelessStreak: 0,
                longestScoringStreak: 0,
                longestScorelessStreak: 0,
                median: 0,
                stddev: 0,
                recentFormLast3: 0,
                recentFormLast5: 0
            };
        }

        let totalGoals = 0;
        let highestScore = scores[0];
        let lowestScore = scores[0];
        let scoringCount = 0;
        let multiGoalCount = 0;

        for (const s of scores) {
            totalGoals += s;
            if (s > highestScore) highestScore = s;
            if (s < lowestScore) lowestScore = s;
            if (s > 0) scoringCount++;
            if (s >= 2) multiGoalCount++;
        }

        const goalsPerGame = totalGoals / games;
        const scoringRate = scoringCount / games;
        const multiGoalRate = multiGoalCount / games;

        // Current streak walks the RAW chronological input (not cleaned scores)
        // so a missing/null game breaks the streak — matches the explicit spec
        // "stop counting when the opposite condition occurs or the game has
        // missing/null data". Behavior is identical to the cleaned-input
        // version for null-free histories.
        function currentStreak(pred) {
            if (!Array.isArray(scoresChronological)) return 0;
            let n = 0;
            for (let i = scoresChronological.length - 1; i >= 0; i--) {
                const s = toScore(scoresChronological[i]);
                if (s === null) break;
                if (pred(s)) n++;
                else break;
            }
            return n;
        }

        function longestStreak(pred) {
            let best = 0;
            let cur = 0;
            for (const s of scores) {
                if (pred(s)) {
                    cur++;
                    if (cur > best) best = cur;
                } else {
                    cur = 0;
                }
            }
            return best;
        }

        const isScoring = (s) => s > 0;
        const isScoreless = (s) => s === 0;

        const sorted = scores.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];

        let stddev = 0;
        if (games >= 2) {
            let variance = 0;
            for (const s of scores) {
                const d = s - goalsPerGame;
                variance += d * d;
            }
            variance /= games;
            stddev = Math.sqrt(variance);
        }

        function recentAverage(window) {
            const slice = scores.slice(-window);
            if (slice.length === 0) return 0;
            let sum = 0;
            for (const s of slice) sum += s;
            return sum / slice.length;
        }

        return {
            games,
            totalGoals,
            goalsPerGame,
            highestScore,
            lowestScore,
            scoringRate,
            multiGoalRate,
            currentScoringStreak: currentStreak(isScoring),
            currentScorelessStreak: currentStreak(isScoreless),
            longestScoringStreak: longestStreak(isScoring),
            longestScorelessStreak: longestStreak(isScoreless),
            median,
            stddev,
            recentFormLast3: recentAverage(3),
            recentFormLast5: recentAverage(5)
        };
    }

    // Returns scores for the given key (e.g. 'player1Goals') ordered oldest first
    // by dateTime, with id as a stable tiebreaker. Games without a parseable
    // score are skipped so byes/partial rows don't poison streaks.
    function scoresInOrder(gamesArr, key) {
        if (!Array.isArray(gamesArr)) return [];
        const copy = gamesArr.slice().sort((a, b) => {
            const ta = new Date(a && a.dateTime ? a.dateTime : 0).getTime() || 0;
            const tb = new Date(b && b.dateTime ? b.dateTime : 0).getTime() || 0;
            if (ta !== tb) return ta - tb;
            const ia = (a && typeof a.id === 'number') ? a.id : 0;
            const ib = (b && typeof b.id === 'number') ? b.id : 0;
            return ia - ib;
        });
        const out = [];
        for (const g of copy) {
            const n = toScore(g ? g[key] : null);
            if (n !== null) out.push(n);
        }
        return out;
    }

    // Longest matching run across a games array, with date range of the run.
    // games is the raw (unsorted) games array; it's sorted chronologically
    // internally. scoreKey is the per-game field to evaluate (e.g.
    // 'player1Goals'). predicate receives the coerced numeric score.
    //
    // Returns { length, startDate, endDate }. startDate/endDate are the
    // original ISO strings from the first and last game in the winning run,
    // or null when length is 0 or a game in the run has no dateTime.
    //
    // Tie-breaking: when multiple runs share the longest length, the MOST
    // RECENT run wins (later runs overwrite earlier ones during the scan).
    // Missing/null scores are skipped — they neither extend nor break a run.
    function longestRun(games, scoreKey, predicate) {
        if (!Array.isArray(games) || games.length === 0 || typeof predicate !== 'function') {
            return { length: 0, startDate: null, endDate: null };
        }
        const sorted = games.slice().sort((a, b) => {
            const ta = new Date(a && a.dateTime ? a.dateTime : 0).getTime() || 0;
            const tb = new Date(b && b.dateTime ? b.dateTime : 0).getTime() || 0;
            if (ta !== tb) return ta - tb;
            const ia = (a && typeof a.id === 'number') ? a.id : 0;
            const ib = (b && typeof b.id === 'number') ? b.id : 0;
            return ia - ib;
        });

        let bestLen = 0;
        let bestStart = -1;
        let bestEnd = -1;
        let curLen = 0;
        let curStart = -1;

        for (let i = 0; i < sorted.length; i++) {
            const game = sorted[i];
            const score = toScore(game ? game[scoreKey] : null);
            if (score === null) continue;
            if (predicate(score)) {
                if (curLen === 0) curStart = i;
                curLen++;
                if (curLen >= bestLen) {
                    bestLen = curLen;
                    bestStart = curStart;
                    bestEnd = i;
                }
            } else {
                curLen = 0;
                curStart = -1;
            }
        }

        if (bestLen === 0) {
            return { length: 0, startDate: null, endDate: null };
        }
        const startGame = sorted[bestStart];
        const endGame = sorted[bestEnd];
        return {
            length: bestLen,
            startDate: (startGame && startGame.dateTime) ? startGame.dateTime : null,
            endDate: (endGame && endGame.dateTime) ? endGame.dateTime : null
        };
    }

    // Penalty-aware single-match outcome from "me's" perspective.
    //   'W' — me beat opp in regulation, OR regulation tied AND me won pens
    //   'L' — opp beat me in regulation, OR regulation tied AND opp won pens
    //   'D' — regulation tied AND no penalty winner (null / 'draw' / undefined)
    //   null — either side's score is missing; caller can skip the game
    //
    // mySide is 1 or 2 to match the raw penaltyWinner values stored on games
    // (penaltyWinner === 1 means player1 won the shootout). 'draw' as a
    // penaltyWinner is treated the same as null — the shootout itself was a
    // draw, so the match stays a draw.
    function matchResult(me, opp, penaltyWinner, mySide) {
        const m = toScore(me);
        const o = toScore(opp);
        if (m === null || o === null) return null;
        if (m > o) return 'W';
        if (m < o) return 'L';
        // Regulation tied — penalty decides if there was a winner.
        if (penaltyWinner === mySide) return 'W';
        if (penaltyWinner === 1 || penaltyWinner === 2) return 'L';
        return 'D';
    }

    // Chronological array of per-game results from "me's" perspective. Nulls
    // are preserved so callers can decide whether to skip or break on missing
    // data. Sorts games internally by dateTime then id (same rule as elsewhere).
    function matchResultsInOrder(games, meKey, oppKey, mySide) {
        if (!Array.isArray(games)) return [];
        const sorted = games.slice().sort((a, b) => {
            const ta = new Date(a && a.dateTime ? a.dateTime : 0).getTime() || 0;
            const tb = new Date(b && b.dateTime ? b.dateTime : 0).getTime() || 0;
            if (ta !== tb) return ta - tb;
            const ia = (a && typeof a.id === 'number') ? a.id : 0;
            const ib = (b && typeof b.id === 'number') ? b.id : 0;
            return ia - ib;
        });
        return sorted.map((g) => matchResult(
            g ? g[meKey] : null,
            g ? g[oppKey] : null,
            g ? g.penaltyWinner : null,
            mySide
        ));
    }

    // Match-based current streaks: consecutive wins or losses working backward
    // from the most recent game. Input is a chronological results array (use
    // matchResultsInOrder to get one). Draws break both streaks at the tail.
    // null entries are skipped — missing data doesn't count as a streak break.
    function computeMatchStreaks(results) {
        if (!Array.isArray(results)) {
            return { currentWinningStreak: 0, currentLosingStreak: 0 };
        }
        let winning = 0;
        let losing = 0;
        let activeType = null; // 'W' | 'L' | null

        for (let i = results.length - 1; i >= 0; i--) {
            const r = results[i];
            if (r === null || r === undefined) continue;

            if (activeType === null) {
                if (r === 'D') break; // draw at the tail kills both streaks
                activeType = r;
                if (r === 'W') winning = 1;
                else if (r === 'L') losing = 1;
                else break; // unknown value
            } else if (r === activeType) {
                if (activeType === 'W') winning++;
                else losing++;
            } else {
                break;
            }
        }

        return { currentWinningStreak: winning, currentLosingStreak: losing };
    }

    // Longest match-result run with date span. Mirrors longestRun but operates
    // on per-game results (penalty-aware) rather than raw scores. predicate
    // takes a result string ('W'|'L'|'D') and returns true if the game extends
    // the run; null results are skipped without breaking. Tie-break: most
    // recent run wins (>= comparison during forward scan).
    function longestMatchRun(games, meKey, oppKey, mySide, predicate) {
        if (!Array.isArray(games) || games.length === 0 || typeof predicate !== 'function') {
            return { length: 0, startDate: null, endDate: null };
        }
        const sorted = games.slice().sort((a, b) => {
            const ta = new Date(a && a.dateTime ? a.dateTime : 0).getTime() || 0;
            const tb = new Date(b && b.dateTime ? b.dateTime : 0).getTime() || 0;
            if (ta !== tb) return ta - tb;
            const ia = (a && typeof a.id === 'number') ? a.id : 0;
            const ib = (b && typeof b.id === 'number') ? b.id : 0;
            return ia - ib;
        });

        let bestLen = 0;
        let bestStart = -1;
        let bestEnd = -1;
        let curLen = 0;
        let curStart = -1;

        for (let i = 0; i < sorted.length; i++) {
            const g = sorted[i];
            const result = matchResult(
                g ? g[meKey] : null,
                g ? g[oppKey] : null,
                g ? g.penaltyWinner : null,
                mySide
            );
            if (result === null) continue;
            if (predicate(result)) {
                if (curLen === 0) curStart = i;
                curLen++;
                if (curLen >= bestLen) {
                    bestLen = curLen;
                    bestStart = curStart;
                    bestEnd = i;
                }
            } else {
                curLen = 0;
                curStart = -1;
            }
        }

        if (bestLen === 0) {
            return { length: 0, startDate: null, endDate: null };
        }
        const startGame = sorted[bestStart];
        const endGame = sorted[bestEnd];
        return {
            length: bestLen,
            startDate: (startGame && startGame.dateTime) ? startGame.dateTime : null,
            endDate: (endGame && endGame.dateTime) ? endGame.dateTime : null
        };
    }

    function formatNumber(n, decimals) {
        if (!Number.isFinite(n)) return '0';
        const d = typeof decimals === 'number' ? decimals : 1;
        if (n % 1 === 0) return n.toFixed(0);
        return n.toFixed(d);
    }

    function formatPercent(ratio) {
        if (!Number.isFinite(ratio)) return '0%';
        return Math.round(ratio * 100) + '%';
    }

    // Compact date matching the Game History convention: M/D/YYYY with no
    // leading zeros and no month names (e.g. 4/24/2026). Returns null when the
    // input can't be parsed so callers can fall back to bare values.
    function formatDateShort(iso) {
        if (!iso) return null;
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        return d.toLocaleDateString('en-US', {
            month: 'numeric',
            day: 'numeric',
            year: 'numeric'
        });
    }

    // Best single game for a player: highest score with its date and the
    // opponent's score in that same game. Sorts chronologically internally.
    // Ties (e.g. multiple 5-goal games) resolve to the MOST RECENT one by
    // using `>=` during a forward scan. Null scores are skipped so missing
    // data can't claim the highest. Returns a fully-null shape when nothing
    // qualifies so callers can render a safe fallback.
    function highestScoreGame(games, meKey, oppKey) {
        const empty = { score: 0, opponentScore: null, date: null };
        if (!Array.isArray(games) || games.length === 0) return empty;

        const sorted = games.slice().sort((a, b) => {
            const ta = new Date(a && a.dateTime ? a.dateTime : 0).getTime() || 0;
            const tb = new Date(b && b.dateTime ? b.dateTime : 0).getTime() || 0;
            if (ta !== tb) return ta - tb;
            const ia = (a && typeof a.id === 'number') ? a.id : 0;
            const ib = (b && typeof b.id === 'number') ? b.id : 0;
            return ia - ib;
        });

        let bestScore = -Infinity;
        let bestOpp = null;
        let bestDate = null;
        let found = false;
        for (const g of sorted) {
            const me = toScore(g ? g[meKey] : null);
            if (me === null) continue;
            if (me >= bestScore) {
                bestScore = me;
                bestOpp = toScore(g[oppKey]);
                bestDate = (g && g.dateTime) ? g.dateTime : null;
                found = true;
            }
        }
        if (!found) return empty;
        return { score: bestScore, opponentScore: bestOpp, date: bestDate };
    }

    // Parenthesised match detail for a highestScoreGame-style detail object.
    //   "(M/D/YYYY, me–opp)" when date + both scores present
    //   null when date missing OR opponent score missing (UI falls back to
    //     the bare stat value so the display stays clean)
    function formatMatchText(detail) {
        if (!detail) return null;
        // Explicit null/undefined checks first — Number(null) is 0 which is
        // finite, so a missing opponentScore would otherwise slip through and
        // render as "me–0". A real 0 (genuine shutout) is still accepted below.
        if (detail.score === null || detail.score === undefined) return null;
        if (detail.opponentScore === null || detail.opponentScore === undefined) return null;
        const score = Number(detail.score);
        const opp = Number(detail.opponentScore);
        if (!Number.isFinite(score) || score < 0) return null;
        if (!Number.isFinite(opp)) return null;
        const date = formatDateShort(detail.date);
        if (!date) return null;
        return '(' + date + ', ' + score + '–' + opp + ')';
    }

    // Parenthesised date range for a longestRun-style { length, startDate,
    // endDate } object.
    //   multi-game run → "(M/D/YYYY – M/D/YYYY)"
    //   single-game run → "(M/D/YYYY)"
    //   missing/invalid dates or length 0 → null
    // Defensively swaps start/end if they arrive reversed so the display never
    // shows a backwards range.
    function formatRangeText(range) {
        if (!range || !Number.isFinite(range.length) || range.length <= 0) return null;
        let startIso = range.startDate;
        let endIso = range.endDate;
        if (!startIso || !endIso) return null;
        const startMs = new Date(startIso).getTime();
        const endMs = new Date(endIso).getTime();
        if (isNaN(startMs) || isNaN(endMs)) return null;
        if (endMs < startMs) {
            const tmp = startIso;
            startIso = endIso;
            endIso = tmp;
        }
        const start = formatDateShort(startIso);
        const end = formatDateShort(endIso);
        if (!start || !end) return null;
        if (start === end) return '(' + start + ')';
        return '(' + start + ' – ' + end + ')';
    }

    // Comparison primitive used by the player-stats comparison table. Direction
    // can be 'higher' (bigger is better), 'lower' (smaller is better), or
    // 'neutral' (no winner, shown without tint). Non-finite inputs collapse to
    // neutral so the UI never renders NaN tints.
    function compareStat(direction, p1, p2) {
        const a = Number(p1);
        const b = Number(p2);
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
            return { winner: 'neutral', diff: 0 };
        }
        const diff = a - b;
        if (direction === 'neutral') {
            return { winner: 'neutral', diff };
        }
        if (a === b) {
            return { winner: 'tie', diff: 0 };
        }
        if (direction === 'higher') {
            return { winner: a > b ? 'p1' : 'p2', diff };
        }
        if (direction === 'lower') {
            return { winner: a < b ? 'p1' : 'p2', diff };
        }
        return { winner: 'neutral', diff };
    }

    const api = {
        computePlayerStats,
        scoresInOrder,
        matchResult,
        matchResultsInOrder,
        computeMatchStreaks,
        longestRun,
        longestMatchRun,
        highestScoreGame,
        cleanScores,
        formatNumber,
        formatPercent,
        formatDateShort,
        formatRangeText,
        formatMatchText,
        compareStat
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.FootballPlayerStats = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
