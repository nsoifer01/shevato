/*
 * Brain Arena — room state helpers.
 *
 * Pure functions for generating room codes, deciding game phase, picking the
 * next host on disconnect, and aggregating end-of-game stats. No DOM, no
 * Firestore. Exported as CommonJS + window.BrainArena.RoomState.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        const Config = require('./config.js');
        module.exports = factory(Config);
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.RoomState = factory(ns.Config);
    }
}(typeof self !== 'undefined' ? self : this, function (Config) {
    'use strict';

    /**
     * Generate a fresh room code from the unambiguous alphabet. The optional
     * `rand` argument lets tests pin the output. Returns a string of length
     * Config.ROOM_CODE_LENGTH.
     * @param {() => number} [rand] — defaults to Math.random
     * @returns {string}
     */
    function generateRoomCode(rand) {
        const r = typeof rand === 'function' ? rand : Math.random;
        const alpha = Config.ROOM_CODE_ALPHABET;
        let out = '';
        for (let i = 0; i < Config.ROOM_CODE_LENGTH; i++) {
            out += alpha.charAt(Math.floor(r() * alpha.length));
        }
        return out;
    }

    /**
     * Normalize an inbound code: uppercase, trim, strip non-alphanumeric.
     * Returns '' if invalid length so the caller can show an error.
     * @param {string} input
     * @returns {string}
     */
    function normalizeRoomCode(input) {
        const cleaned = String(input || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
        if (cleaned.length !== Config.ROOM_CODE_LENGTH) return '';
        return cleaned;
    }

    /**
     * Decide the current "phase" of an active question.
     *   - 'idle'    : no question started yet (lobby/picking)
     *   - 'asking'  : within QUESTION_TIME_MS of questionStartedAt
     *   - 'reveal'  : within REVEAL_TIME_MS after the asking window closes
     *                 (OR triggered early when everyone has answered)
     *   - 'ended'   : reveal window has elapsed, host should advance
     *
     * If `revealStartedAtMs` is set, the asking window is considered over
     * regardless of elapsed time — this is the early-advance signal the
     * host writes once all players' answers are in.
     *
     * Pure: takes ms timestamps so callers can sub in server time.
     * @param {number|null} questionStartedAtMs
     * @param {number} nowMs
     * @param {number|null} [revealStartedAtMs]
     * @returns {string}
     */
    function questionPhase(questionStartedAtMs, nowMs, revealStartedAtMs, askingDurationMs) {
        if (!questionStartedAtMs) return 'idle';
        const asking = (typeof askingDurationMs === 'number' && askingDurationMs > 0)
            ? askingDurationMs
            : Config.QUESTION_TIME_MS;
        if (revealStartedAtMs) {
            const revealElapsed = nowMs - revealStartedAtMs;
            if (revealElapsed < 0) return 'asking';
            if (revealElapsed < Config.REVEAL_TIME_MS) return 'reveal';
            return 'ended';
        }
        const elapsed = nowMs - questionStartedAtMs;
        if (elapsed < 0) return 'idle';
        if (elapsed < asking) return 'asking';
        if (elapsed < asking + Config.REVEAL_TIME_MS) return 'reveal';
        return 'ended';
    }

    /**
     * Time left in the asking window, clamped to [0, QUESTION_TIME_MS].
     * When the early-reveal flag is set, time-left collapses to 0 (the
     * timer ring snaps to empty across all clients in lockstep).
     * @param {number|null} questionStartedAtMs
     * @param {number} nowMs
     * @param {number|null} [revealStartedAtMs]
     * @returns {number} ms remaining
     */
    function timeLeftMs(questionStartedAtMs, nowMs, revealStartedAtMs, askingDurationMs) {
        const asking = (typeof askingDurationMs === 'number' && askingDurationMs > 0)
            ? askingDurationMs
            : Config.QUESTION_TIME_MS;
        if (!questionStartedAtMs) return asking;
        if (revealStartedAtMs) return 0;
        const elapsed = nowMs - questionStartedAtMs;
        return Math.max(0, Math.min(asking, asking - elapsed));
    }

    /**
     * Pick who chooses the category for question N. The decider rotates
     * by question index, so player A picks Q1, player B picks Q2, etc.
     * playerOrder is snapshotted at game start so late-joiners don't shift
     * the rotation mid-game.
     * @param {string[]} playerOrder
     * @param {number} questionIndex — 0-based
     * @returns {string|null}
     */
    function pickDecider(playerOrder, questionIndex) {
        if (!Array.isArray(playerOrder) || !playerOrder.length) return null;
        const idx = ((Number(questionIndex) || 0) % playerOrder.length + playerOrder.length) % playerOrder.length;
        return playerOrder[idx];
    }

    /**
     * Given a question pool and a set of already-played question ids,
     * return the categories that still have at least one question
     * available, with remaining counts. Sorted alphabetically for stable
     * UI ordering.
     * @param {Array<{id:string, category:string}>} pool
     * @param {string[]} playedIds
     * @returns {Array<{category:string, remaining:number}>}
     */
    function availableCategoriesFromPool(pool, playedIds) {
        const played = new Set(playedIds || []);
        const counts = {};
        for (const q of (pool || [])) {
            if (!q || played.has(q.id)) continue;
            const cat = q.category || 'general';
            counts[cat] = (counts[cat] || 0) + 1;
        }
        return Object.keys(counts)
            .sort()
            .map((cat) => ({ category: cat, remaining: counts[cat] }));
    }

    /**
     * Pick a single question from the pool matching `category`, avoiding
     * any id in playedIds. Falls back to any unplayed question if the
     * chosen category is exhausted. Returns null if the pool is completely
     * spent. `rand` is injectable for deterministic tests.
     * @param {Array} pool
     * @param {string[]} playedIds
     * @param {string|null} category — null / '__any__' picks any unplayed
     * @param {() => number} [rand]
     * @returns {object|null}
     */
    function pickQuestionFromPool(pool, playedIds, category, rand) {
        const r = typeof rand === 'function' ? rand : Math.random;
        const played = new Set(playedIds || []);
        const available = (pool || []).filter((q) => q && !played.has(q.id));
        if (!available.length) return null;
        const wantsAny = !category || category === '__any__';
        const matching = wantsAny
            ? available
            : available.filter((q) => (q.category || 'general') === category);
        const pickFrom = matching.length ? matching : available;
        return pickFrom[Math.floor(r() * pickFrom.length)];
    }

    /**
     * Pick the next host when the current one disconnects. We pick the
     * earliest joiner among remaining players (stable, deterministic).
     * Returns null if the room is empty.
     * @param {Array<{uid:string, joinedAt:number}>} players — survivors only
     * @returns {string|null}
     */
    function pickNextHost(players) {
        if (!Array.isArray(players) || !players.length) return null;
        const sorted = players.slice().sort((a, b) => {
            const ja = Number(a.joinedAt) || 0;
            const jb = Number(b.joinedAt) || 0;
            if (ja !== jb) return ja - jb;
            return String(a.uid).localeCompare(String(b.uid));
        });
        return sorted[0].uid;
    }

    /**
     * Aggregate per-player end-of-game stats from a list of per-question
     * answer records. Used to compute the detailed-stats card (premium).
     * Each record: { questionId, correct, timeLeftMs, totalMs, category }
     * @param {Array} records
     * @returns {{ accuracy:number, avgResponseMs:number, byCategory: object }}
     */
    function aggregateAnswerStats(records) {
        const list = Array.isArray(records) ? records : [];
        if (!list.length) {
            return { accuracy: 0, avgResponseMs: 0, byCategory: {} };
        }
        let correctCount = 0;
        let totalResponseMs = 0;
        const byCategory = {};
        for (const r of list) {
            const cat = r.category || 'general';
            if (!byCategory[cat]) byCategory[cat] = { correct: 0, total: 0 };
            byCategory[cat].total++;
            if (r.correct) {
                correctCount++;
                byCategory[cat].correct++;
            }
            const responseMs = Math.max(0, (Number(r.totalMs) || 0) - (Number(r.timeLeftMs) || 0));
            totalResponseMs += responseMs;
        }
        return {
            accuracy: correctCount / list.length,
            avgResponseMs: Math.round(totalResponseMs / list.length),
            byCategory
        };
    }

    /**
     * Aggregate per-player end-of-game stats from a list of Globe Drop
     * answer records. Each record:
     *   { locationId, locationName, country, region,
     *     distanceKm, basePoints, multiplier, points }
     *
     * Trivia stats (aggregateAnswerStats) keys on `correct` / `category`
     * which Globe Drop doesn't carry, so we need a separate aggregator.
     * Returns null when no answers — caller can swap in the upsell card.
     *
     * @param {Array} records
     * @returns {{
     *   roundsPlayed:    number,
     *   totalPoints:     number,
     *   avgBaseScore:    number,        // 0..100
     *   avgDistanceKm:   number,
     *   closestKm:       number|null,
     *   closestLocation: string|null,
     *   farthestKm:      number|null,
     *   farthestLocation:string|null,
     *   bullseyeCount:   number,        // base ≥ 90
     *   byRegion: { [region]: { rounds:number, avgBase:number } }
     * } | null}
     */
    function aggregateGlobeDropStats(records, totalRounds) {
        const list = Array.isArray(records) ? records.filter((r) => r && typeof r === 'object') : [];
        if (!list.length) return null; // no guesses → no stats, regardless of round count
        // Total rounds in the GAME (from room.playedQuestionIds), not just
        // the rounds the player actually guessed on. When omitted, fall
        // back to the records length so legacy callers keep working.
        const total = (typeof totalRounds === 'number' && totalRounds > 0)
            ? totalRounds
            : list.length;
        let totalPoints = 0;
        let totalBase = 0;
        let totalDistanceKm = 0;
        let closestKm = Infinity;
        let closestLocation = null;
        let farthestKm = -Infinity;
        let farthestLocation = null;
        let bullseyeCount = 0;
        const byRegion = {};
        for (const r of list) {
            const pts = Number(r.points) || 0;
            const mult = (typeof r.multiplier === 'number' && r.multiplier > 0) ? r.multiplier : 1;
            // Reconstruct basePoints when older records didn't persist it.
            const base = (typeof r.basePoints === 'number')
                ? Math.max(0, Math.round(r.basePoints))
                : Math.max(0, Math.round(pts / mult));
            const dist = Number(r.distanceKm);
            totalPoints += pts;
            totalBase += base;
            if (Number.isFinite(dist)) {
                totalDistanceKm += dist;
                if (dist < closestKm)  { closestKm = dist;  closestLocation = r.locationName || r.country || null; }
                if (dist > farthestKm) { farthestKm = dist; farthestLocation = r.locationName || r.country || null; }
            }
            if (base >= 90) bullseyeCount++;
            const region = String(r.region || 'Unknown');
            if (!byRegion[region]) byRegion[region] = { rounds: 0, totalBase: 0 };
            byRegion[region].rounds++;
            byRegion[region].totalBase += base;
        }
        const regionOut = {};
        for (const [k, v] of Object.entries(byRegion)) {
            regionOut[k] = { rounds: v.rounds, avgBase: Math.round(v.totalBase / v.rounds) };
        }
        // Score-based averages divide by TOTAL rounds — a skipped round
        // counts as 0, otherwise the avg silently inflates for players
        // who timed out on the hard ones. Distance avg uses the record
        // count because "infinite distance" for a non-guess isn't a
        // meaningful number to fold into a mean.
        return {
            roundsPlayed:     total,
            roundsGuessed:    list.length,
            totalPoints,
            avgBaseScore:     Math.round(totalBase / total),
            avgDistanceKm:    list.length ? Math.round(totalDistanceKm / list.length) : null,
            closestKm:        Number.isFinite(closestKm)  ? Math.round(closestKm)  : null,
            closestLocation,
            farthestKm:       Number.isFinite(farthestKm) ? Math.round(farthestKm) : null,
            farthestLocation,
            bullseyeCount,
            byRegion: regionOut
        };
    }

    return {
        generateRoomCode,
        normalizeRoomCode,
        questionPhase,
        timeLeftMs,
        pickNextHost,
        aggregateAnswerStats,
        aggregateGlobeDropStats,
        pickDecider,
        availableCategoriesFromPool,
        pickQuestionFromPool
    };
}));
