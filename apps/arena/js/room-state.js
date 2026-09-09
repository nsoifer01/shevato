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
     * Normalize an inbound code: uppercase, strip separators/punctuation,
     * then validate. Returns '' when the result has the wrong length OR
     * contains any character outside ROOM_CODE_ALPHABET - the generator
     * can never emit 0/O/1/I/L, so a code carrying one cannot exist and
     * must be rejected rather than looked up (defect 24). This is the
     * single validity notion for room codes; parseUrlState in app.js
     * routes through it too.
     * @param {string} input
     * @returns {string}
     */
    function normalizeRoomCode(input) {
        const cleaned = String(input || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
        if (cleaned.length !== Config.ROOM_CODE_LENGTH) return '';
        for (const ch of cleaned) {
            if (Config.ROOM_CODE_ALPHABET.indexOf(ch) === -1) return '';
        }
        return cleaned;
    }

    /**
     * Default display name for a player who hasn't picked one yet.
     *
     * NEVER derive this from the account email: the name is denormalized
     * into triviaLeaderboard, which every signed-in user can read, and
     * email local parts routinely carry a real first + last name. The
     * suffix is a stable hash of the uid — the leaderboard row already
     * stores the uid in the clear, so it leaks nothing new, and it keeps
     * two defaults in the same room distinguishable.
     * @param {string} uid
     * @returns {string}
     */
    function defaultDisplayName(uid) {
        const key = String(uid || '');
        if (!key) return 'Player';
        const alpha = Config.ROOM_CODE_ALPHABET;
        let h = 0x811c9dc5; // FNV-1a
        for (let i = 0; i < key.length; i++) {
            h ^= key.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        let suffix = '';
        for (let i = 0; i < 4; i++) {
            suffix += alpha.charAt(h % alpha.length);
            h = Math.floor(h / alpha.length);
        }
        return `Player ${suffix}`;
    }

    /**
     * True when `name` is exactly what the retired email-derived default
     * would have produced for `email`. Used to avoid re-suggesting a
     * leaked name back to a user who never chose it.
     * @param {string} name
     * @param {string} email
     * @returns {boolean}
     */
    function isEmailDerivedName(name, email) {
        const addr = String(email || '');
        const at = addr.indexOf('@');
        if (at <= 0) return false;
        const legacy = addr.slice(0, at).slice(0, Config.MAX_DISPLAY_NAME);
        return String(name || '').trim() === legacy;
    }

    /**
     * Decide whether to ask the player to confirm the name they are about
     * to publish, and what to pre-fill the field with.
     *
     * `needed` is true until the player has explicitly saved a name
     * (profile.displayNameChosen). Profiles created before that flag
     * existed count as un-chosen, which is deliberate: those are exactly
     * the accounts carrying an email-derived name they never approved.
     * @param {{displayName?:string, displayNameChosen?:boolean}|null} profile
     * @param {string} email
     * @param {string} uid
     * @returns {{ needed:boolean, suggested:string }}
     */
    function displayNamePrompt(profile, email, uid) {
        const p = profile || {};
        const current = String(p.displayName || '').trim();
        const keepCurrent = current && !isEmailDerivedName(current, email);
        return {
            needed: !p.displayNameChosen,
            suggested: keepCurrent ? current : defaultDisplayName(uid)
        };
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
     * answer records. Used to compute the detailed-stats card.
     * Each record: { questionId, correct, timeLeftMs, totalMs, category }
     *
     * `totalRounds` is the number of questions in the GAME. Accuracy
     * divides by it, so a skipped/unanswered question counts as a miss -
     * the same denominator rule aggregateGlobeDropStats deliberately uses
     * (defect 25 decision, 2026-08-15: 3 correct answers in a 10-question
     * game are 30%, never 100%). When omitted, falls back to the answered
     * count so legacy callers keep working. Response-time and by-category
     * stats stay answered-only: an unanswered question has no response
     * time or category to fold in (mirrors Globe Drop's distance average).
     * @param {Array} records
     * @param {number} [totalRounds]
     * @returns {{ accuracy:number, avgResponseMs:number, byCategory: object }}
     */
    function aggregateAnswerStats(records, totalRounds) {
        const list = Array.isArray(records) ? records : [];
        if (!list.length) {
            return { accuracy: 0, avgResponseMs: 0, byCategory: {} };
        }
        const total = (typeof totalRounds === 'number' && totalRounds > 0)
            ? totalRounds
            : list.length;
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
            accuracy: correctCount / total,
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
     *   bullseyeCount:   number,        // base ≥ 98 (near-perfect)
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
            if (base >= 98) bullseyeCount++;
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

    /**
     * Deterministic category-free question pick for the picking-stage
     * deadline. Every client seeds the same PRNG from the room code, round
     * and question index, so the auto-pick needs no coordination: whoever
     * writes first writes the SAME question the others would have.
     * @returns {object|null} a question from the unplayed pool
     */
    function autoPickQuestion(pool, playedIds, { code, round, index } = {}) {
        const key = `${code || ''}:${round || 1}:${index || 0}`;
        let h = 0x811c9dc5; // FNV-1a
        for (let i = 0; i < key.length; i++) {
            h ^= key.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        // mulberry32, same generator family as the daily challenge seed.
        const rand = () => {
            h = (h + 0x6D2B79F5) >>> 0;
            let t = h;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        return pickQuestionFromPool(pool, playedIds, '__any__', rand);
    }

    /**
     * Liveness of a player doc. A player is live unless they announced a
     * disconnect (beforeunload writes `disconnectedAt`, epoch ms) more than
     * DISCONNECT_GRACE_MS ago, or their lastSeen heartbeat (Firestore
     * Timestamp or epoch ms) is older than PRESENCE_STALE_MS. A doc with no
     * timestamps at all is treated as live (pending serverTimestamp on a
     * just-created doc). Mirrors isStalePlayerData in firestore.rules.
     * @param {object} p - player doc data
     * @param {number} nowMs
     * @returns {boolean}
     */
    function isPlayerLive(p, nowMs) {
        if (!p) return false;
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (typeof p.disconnectedAt === 'number'
            && now - p.disconnectedAt > Config.DISCONNECT_GRACE_MS) return false;
        const seen = p.lastSeen;
        const seenMs = seen && typeof seen.toMillis === 'function'
            ? seen.toMillis()
            : (typeof seen === 'number' ? seen : null);
        if (seenMs != null && now - seenMs > Config.PRESENCE_STALE_MS) return false;
        return true;
    }

    /** Players from `players` that isPlayerLive at `nowMs`. */
    function livePlayers(players, nowMs) {
        return (Array.isArray(players) ? players : []).filter((p) => isPlayerLive(p, nowMs));
    }

    /**
     * Compact, ordered final-ranking snapshot for the room doc when a game
     * finishes ({ uid, displayName, score, streak }, best first). `scoreOf`
     * lets Globe Drop rank by its recomputed-from-distance total. Ties keep
     * the higher streak first, then name, so every client derives the same
     * order. Written once on status=finished so the end screen no longer
     * rewrites itself when a player leaves (audit D5).
     */
    function finalRankingSnapshot(players, scoreOf) {
        const score = typeof scoreOf === 'function' ? scoreOf : (p) => (p && p.score) || 0;
        return (Array.isArray(players) ? players : [])
            .filter((p) => p && typeof p.uid === 'string')
            .map((p) => ({
                uid: p.uid,
                displayName: String(p.displayName == null ? '' : p.displayName),
                score: Math.max(0, Math.round(Number(score(p)) || 0)),
                streak: Math.max(0, Math.round(Number(p.streak) || 0))
            }))
            .sort((a, b) => (b.score - a.score) || (b.streak - a.streak) || a.displayName.localeCompare(b.displayName));
    }

    /**
     * End-of-game profile delta for one player. Pure so the leaderboard and
     * users/{uid} writes derive from ONE computation (audit D8: the two
     * surfaces disagreed). A win needs an opponent: solo runs and daily runs
     * (always one player) never count as wins, whatever the ranking says.
     * @returns {{ scoreDelta, gamesDelta, winsDelta, bullseyes, bestRound }}
     */
    function endOfGameStatsDelta({ playMode, didWin, playerCount, score, answers }) {
        const mode = playMode || 'multi';
        const opponents = mode === 'multi' && (Number(playerCount) || 0) >= 2;
        let bullseyes = 0;
        let bestRound = 0;
        for (const r of (Array.isArray(answers) ? answers : [])) {
            if (!r) continue;
            const base = (typeof r.basePoints === 'number')
                ? Math.max(0, Math.round(r.basePoints))
                : (typeof r.points === 'number' && typeof r.multiplier === 'number' && r.multiplier > 0
                    ? Math.round(r.points / r.multiplier) : 0);
            if (base >= 98) bullseyes++;
            const pts = Number(r.points) || 0;
            if (pts > bestRound) bestRound = pts;
        }
        return {
            scoreDelta: Math.max(0, Math.round(Number(score) || 0)),
            gamesDelta: 1,
            winsDelta: (opponents && didWin) ? 1 : 0,
            bullseyes,
            bestRound
        };
    }

    return {
        generateRoomCode,
        normalizeRoomCode,
        defaultDisplayName,
        isEmailDerivedName,
        displayNamePrompt,
        questionPhase,
        timeLeftMs,
        pickNextHost,
        aggregateAnswerStats,
        aggregateGlobeDropStats,
        pickDecider,
        availableCategoriesFromPool,
        pickQuestionFromPool,
        autoPickQuestion,
        isPlayerLive,
        livePlayers,
        finalRankingSnapshot,
        endOfGameStatsDelta
    };
}));
