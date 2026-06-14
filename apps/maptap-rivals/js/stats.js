'use strict';

// MapTap Rivals — pure scoring / stats helpers.
//
// Extracted from app.js so the computational core (weighted scoring, daily
// totals, side-presence, the paste parser, results, streaks, averages, trend,
// and the rivalry score) can be unit-tested in node without a DOM or Firebase.
//
// Exposed as `window.MapTapStats` in the browser AND `module.exports` for the
// node test runner. app.js binds these names at the top of its IIFE, so every
// existing call site keeps using the bare function names unchanged.
(function (root) {

  // MapTap scoring: 5 locations × 0-100 raw, multipliers [1,1,2,3,3] → 0-1000 daily total.
  const N_LOCS = 5;
  const WEIGHTS = [1, 1, 2, 3, 3];
  const MAX_RAW = 100;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  function weightedTotal(scores) {
    if (!Array.isArray(scores) || scores.length !== N_LOCS) return 0;
    let t = 0;
    for (let i = 0; i < N_LOCS; i++) t += (scores[i] || 0) * WEIGHTS[i];
    return t;
  }

  // Weighted total of a *predicted* round array, for the leaderboard's
  // predicted-score column. Predictions are floats (e.g. 91.4); the per-round
  // chips display Math.round(score), so this rounds each round the same way
  // BEFORE weighting. That guarantees the total always equals the sum of the
  // whole-number chips the user sees (no compound-rounding drift). Returns
  // null for a malformed array so callers can distinguish "no prediction".
  function predTotalFromScores(scores) {
    if (!Array.isArray(scores) || scores.length !== N_LOCS) return null;
    let t = 0;
    for (let i = 0; i < N_LOCS; i++) t += Math.round(scores[i] || 0) * WEIGHTS[i];
    return Math.max(0, Math.min(1000, t));
  }

  function hasLocs(g) { return Array.isArray(g.myScores) && Array.isArray(g.theirScores); }

  // Side presence. A rival-only game (saved by sync when the rival played but
  // the user didn't) has theirScores/theirScore but no myScores/myScore.
  // Old totals-only games have both totals defined but no arrays; bothPlayed
  // still returns true for those so existing stats keep working unchanged.
  function iPlayed(g) {
    return Array.isArray(g.myScores) || Number.isFinite(g.myScore);
  }
  function theyPlayed(g) {
    return Array.isArray(g.theirScores) || Number.isFinite(g.theirScore);
  }
  function bothPlayed(g) { return iPlayed(g) && theyPlayed(g); }

  function arrEq(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function getMyTotal(g) {
    if (Array.isArray(g.myScores)) return weightedTotal(g.myScores);
    return Number.isFinite(g.myScore) ? g.myScore : 0;
  }
  function getTheirTotal(g) {
    if (Array.isArray(g.theirScores)) return weightedTotal(g.theirScores);
    return Number.isFinite(g.theirScore) ? g.theirScore : 0;
  }

  // ---------- paste parser ----------
  // MapTap shareable format looks like:
  //
  //   May 10
  //   95🏅 89✨ 91🎉 9🤢 64🙃
  //   Final score: 585
  //
  // We're tolerant: any line with exactly 5 numbers each in 0-100 is taken
  // as the round line; "Final score: N" anywhere validates the total; a
  // "Month Day" line yields the date. Order doesn't matter.
  function parseMapTapScore(text) {
    if (!text || !text.trim()) return null;
    const lines = text.split(/\r?\n/);
    let rounds = null;
    let finalScore = null;
    let date = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // "Final score: N"  (also accepts "final: N", "total: N")
      const finalMatch = line.match(/(?:final\s*score|final|total)\s*[:=]?\s*(\d{1,4})/i);
      if (finalMatch) { finalScore = Number(finalMatch[1]); continue; }

      // "Month Day" or "Day Month"
      if (!date) {
        const md = line.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\s*\.?\s*(\d{1,2})/i);
        const dm = !md && line.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
        const monthName = md ? md[1] : dm ? dm[2] : null;
        const dayStr = md ? md[2] : dm ? dm[1] : null;
        if (monthName && dayStr) {
          const monthIdx = MONTHS.findIndex(m => monthName.toLowerCase().startsWith(m));
          const day = Number(dayStr);
          if (monthIdx >= 0 && day >= 1 && day <= 31) {
            const year = new Date().getFullYear();
            const d = new Date(year, monthIdx, day);
            const tz = d.getTimezoneOffset();
            date = new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
          }
        }
      }

      // Round line: exactly 5 numbers, each 0–100
      if (!rounds) {
        const nums = (line.match(/-?\d+/g) || []).map(Number);
        if (nums.length === 5 && nums.every(n => n >= 0 && n <= MAX_RAW)) {
          rounds = nums;
        }
      }
    }

    if (!rounds) return null;
    const computedTotal = weightedTotal(rounds);
    const totalMismatch = finalScore != null && Math.abs(finalScore - computedTotal) >= 1;
    return { rounds, finalScore, computedTotal, date, totalMismatch };
  }

  // ---------- MapTap profile history → per-day rounds ----------
  // Convert profile.gameHistory into { "YYYY-MM-DD": { scores: number[5], cities: {lat,lng,name}[5] } }.
  //
  // Prefers `roundData` — the web/legacy shape that carries answer-city
  // coordinates (cityLat/cityLng/cityName) so the continent breakdown can light
  // up. MapTap's newer iOS client (v4.04+) stops writing `roundData` and emits
  // only `rounds`, which still has the per-round score and the answer-city NAME
  // (targetCity) but no coordinates. We fall back to `rounds` ONLY when a clean
  // `roundData` array is absent, so those games still pair on score — their
  // cities are left coordinate-less, which classifyContinent already tolerates
  // (it buckets them as 'Unknown', same as any pre-cities game today).
  //
  // Either source must yield a clean 5-round score breakdown; entries that
  // don't are rejected so we never store partial data — those days just won't
  // pair.
  function mapTapHistoryToRounds(gameHistory) {
    const out = {};
    for (const [date, entry] of Object.entries(gameHistory || {})) {
      if (!entry) continue;
      const parsed = roundsFromRoundData(entry.roundData) || roundsFromRounds(entry.rounds);
      if (parsed) out[date] = parsed;
    }
    return out;
  }

  // Validate a 5-element score array against MapTap's 0-100 raw range.
  function validRawScores(scores) {
    return scores.length === N_LOCS
      && scores.every(s => Number.isFinite(s) && s >= 0 && s <= MAX_RAW);
  }

  // Web/legacy shape: roundData[] carrying answer-city coordinates.
  function roundsFromRoundData(roundData) {
    if (!Array.isArray(roundData) || roundData.length !== N_LOCS) return null;
    const scores = roundData.map(r => Number(r.score));
    if (!validRawScores(scores)) return null;
    const cities = roundData.map(r => ({
      lat: Number(r.cityLat),
      lng: Number(r.cityLng),
      name: typeof r.cityName === 'string' ? r.cityName : '',
    }));
    return { scores, cities };
  }

  // iOS 4.04+ shape: rounds[] with score + answer-city NAME (targetCity) but no
  // coordinates. Used only when roundData is absent. Cities keep the name and
  // get NaN coords, so continent classification falls back to 'Unknown'.
  function roundsFromRounds(rounds) {
    if (!Array.isArray(rounds) || rounds.length !== N_LOCS) return null;
    const scores = rounds.map(r => Number(r.score));
    if (!validRawScores(scores)) return null;
    const cities = rounds.map(r => ({
      lat: NaN,
      lng: NaN,
      name: typeof r.targetCity === 'string' ? r.targetCity : '',
    }));
    return { scores, cities };
  }

  // ---------- results ----------
  function resultOf(g) {
    // Rival-only (or me-only) days have no W/L semantics — neither side beat
    // the other; one of them just didn't show up. Returning null lets the
    // W/L/T filter exclude them naturally and the result-badge render '—'.
    if (!bothPlayed(g)) return null;
    const m = getMyTotal(g);
    const t = getTheirTotal(g);
    if (m > t) return 'W';
    if (m < t) return 'L';
    return 'T';
  }
  function resultLoc(myRaw, theirRaw) {
    if (myRaw > theirRaw) return 'W';
    if (myRaw < theirRaw) return 'L';
    return 'T';
  }

  // ---------- aggregates ----------
  function stdDev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  function average(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  // Streaks over a chronologically-ordered (oldest-first) game list. Ties reset
  // both runs. `cur*` is the active run at the end of the list.
  function streaks(games) {
    let curMine = 0, curTheirs = 0, longestMine = 0, longestTheirs = 0;
    let runMine = 0, runTheirs = 0;

    for (const g of games) {
      const r = resultOf(g);
      if (r === 'W') {
        runMine += 1;
        runTheirs = 0;
      } else if (r === 'L') {
        runTheirs += 1;
        runMine = 0;
      } else {
        runMine = 0;
        runTheirs = 0;
      }
      longestMine = Math.max(longestMine, runMine);
      longestTheirs = Math.max(longestTheirs, runTheirs);
    }
    curMine = runMine;
    curTheirs = runTheirs;
    return { curMine, curTheirs, longestMine, longestTheirs };
  }

  function linearTrend(values) {
    // Returns slope of linear regression (positive = improving).
    const n = values.length;
    if (n < 2) return 0;
    const xs = values.map((_, i) => i);
    const meanX = (n - 1) / 2;
    const meanY = average(values);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (values[i] - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    return den === 0 ? 0 : num / den;
  }

  function projectNext(values) {
    const n = values.length;
    if (n === 0) return 0;
    if (n === 1) return values[0];
    const slope = linearTrend(values);
    const intercept = average(values) - slope * (n - 1) / 2;
    return Math.max(0, Math.min(1000, Math.round(slope * n + intercept)));
  }

  // Composite rivalry score — single number summarising how the rivalry is
  // going. Blends win rate, volume confidence, recency, and average margin.
  // Input `games` should be chronological (oldest-first); only games where
  // both sides played count. Positive = you are winning the rivalry.
  function rivalryScoreFromGames(games) {
    const played = (Array.isArray(games) ? games : []).filter(bothPlayed);
    const n = played.length;
    if (n === 0) return 0;
    const volume = Math.min(1, n / 10);
    let weightSum = 0, winSum = 0, marginSum = 0;
    for (let i = 0; i < n; i++) {
      const rank = n - 1 - i; // rank 0 = newest (played is oldest-first)
      const decay = Math.pow(0.95, rank);
      const g = played[i];
      const my = getMyTotal(g);
      const their = getTheirTotal(g);
      const outcome = my > their ? 1 : my < their ? -1 : 0;
      winSum += outcome * decay;
      marginSum += ((my - their) / 1000) * decay;
      weightSum += decay;
    }
    const recencyWinRate = winSum / weightSum;
    const recencyMarginRate = marginSum / weightSum;
    return volume * 50 * (recencyWinRate + recencyMarginRate);
  }

  const api = {
    // constants
    N_LOCS, WEIGHTS, MAX_RAW, MONTHS,
    // scoring
    weightedTotal, predTotalFromScores, hasLocs, iPlayed, theyPlayed, bothPlayed, arrEq,
    getMyTotal, getTheirTotal,
    // parsing
    parseMapTapScore, mapTapHistoryToRounds,
    // results / aggregates
    resultOf, resultLoc, stdDev, average, streaks, linearTrend, projectNext,
    rivalryScoreFromGames,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.MapTapStats = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
