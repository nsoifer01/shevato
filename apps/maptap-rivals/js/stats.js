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

  // Coerce a raw coordinate field to a number without the Number(null) = 0
  // trap: Number(null), Number('') and Number([]) are all 0, which turns a
  // coordinate-less round into the valid point (0, 0) in the Gulf of Guinea
  // and (before 2026-08-15) bucketed it as Africa. Only actual numbers and
  // non-empty numeric strings survive; everything else is NaN, which every
  // continent caller drops before classifying. Shared by myAvgByContinent
  // here and continentBreakdown in app.js so the two views cannot drift.
  function coordNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }

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
  // (targetCity) but no coordinates.
  //
  // The `rounds` fallback is consulted ONLY when `roundData` is entirely absent
  // from the entry. Any entry that carries a `roundData` field at all — which
  // the web/legacy client always does — is handled exactly as before, including
  // being dropped when malformed. That makes this byte-for-byte unchanged for
  // non-iOS players; only entries that omit roundData (iOS) take the fallback.
  // Fallback games still pair on score; their cities are left coordinate-less,
  // and both continent aggregates drop coordinate-less rounds before
  // classifying, so those rounds never appear in any continent figure.
  //
  // Either source must yield a clean 5-round score breakdown; entries that
  // don't are rejected so we never store partial data — those days just won't
  // pair.
  function mapTapHistoryToRounds(gameHistory) {
    // Accumulated in a Map (dates come verbatim from a remote payload, so a
    // '__proto__' key must land as data, never as the object's prototype);
    // Object.fromEntries defines own properties, so the plain-object return
    // shape callers index by date is preserved.
    const out = new Map();
    for (const [date, entry] of Object.entries(gameHistory || {})) {
      if (!entry) continue;
      const parsed = entry.roundData != null
        ? roundsFromRoundData(entry.roundData)
        : roundsFromRounds(entry.rounds);
      if (parsed) out.set(date, parsed);
    }
    return Object.fromEntries(out);
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

  // ---------- calendar period bucketing ----------
  // Every helper below works off the 'YYYY-MM-DD' string through Date.UTC so
  // the bucket never depends on the browser's timezone. `new Date('2026-08-02')`
  // parses as UTC midnight and then reports the *previous* day from getDate()
  // west of Greenwich, which would misfile a Monday game into the prior week.

  const DAY_MS = 86400000;

  function parseDateISO(iso) {
    if (typeof iso !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const ms = Date.UTC(year, month - 1, day);
    const back = new Date(ms);
    // Rejects impossible dates that Date.UTC silently rolls over (2026-02-30).
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 ||
        back.getUTCDate() !== day) return null;
    return { year, month, day, ms };
  }

  function isoFromMs(ms) { return new Date(ms).toISOString().slice(0, 10); }

  // Monday of the ISO week containing `iso`.
  function isoWeekStart(iso) {
    const p = parseDateISO(iso);
    if (!p) return null;
    const back = (new Date(p.ms).getUTCDay() + 6) % 7; // Mon = 0 ... Sun = 6
    return isoFromMs(p.ms - back * DAY_MS);
  }

  // Sunday of the ISO week containing `iso`.
  function isoWeekEnd(iso) {
    const start = isoWeekStart(iso);
    return start ? isoFromMs(parseDateISO(start).ms + 6 * DAY_MS) : null;
  }

  // ISO-8601 week id, 'YYYY-Www'. The week-numbering year is the year of that
  // week's Thursday, so 2021-01-01 (a Friday) belongs to '2020-W53'.
  function isoWeekId(iso) {
    const start = isoWeekStart(iso);
    if (!start) return null;
    const thursdayMs = parseDateISO(start).ms + 3 * DAY_MS;
    const year = new Date(thursdayMs).getUTCFullYear();
    const week = Math.floor((thursdayMs - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  function monthId(iso) {
    const p = parseDateISO(iso);
    return p ? iso.slice(0, 7) : null;
  }

  function monthStart(iso) {
    const p = parseDateISO(iso);
    return p ? isoFromMs(Date.UTC(p.year, p.month - 1, 1)) : null;
  }

  // Day 0 of the following month is the last day of this one.
  function monthEnd(iso) {
    const p = parseDateISO(iso);
    return p ? isoFromMs(Date.UTC(p.year, p.month, 0)) : null;
  }

  // { id, start, end } for the calendar week or month holding `iso`.
  function periodBounds(iso, unit) {
    if (unit === 'month') {
      const id = monthId(iso);
      return id ? { id, start: monthStart(iso), end: monthEnd(iso) } : null;
    }
    const id = isoWeekId(iso);
    return id ? { id, start: isoWeekStart(iso), end: isoWeekEnd(iso) } : null;
  }

  function blankRecord() {
    return { games: 0, wins: 0, losses: 0, ties: 0, decided: 0, winPct: 0 };
  }

  function tallyRecord(rec, result) {
    rec.games += 1;
    if (result === 'W') rec.wins += 1;
    else if (result === 'L') rec.losses += 1;
    else rec.ties += 1;
  }

  // Win % counts decided games only, matching how the app has always read a
  // W/L record: a week of nothing but ties is "no decided games", not 0%.
  function finishRecord(rec) {
    rec.decided = rec.wins + rec.losses;
    rec.winPct = rec.decided > 0 ? (rec.wins / rec.decided) * 100 : 0;
    return rec;
  }

  // Bucket the game log into calendar weeks ('week') or months ('month').
  // Only head-to-head days count: rival-only and solo days carry no W/L
  // semantics, exactly like resultOf treats them. Returns newest period
  // first; `byRival` is each rival's record inside that period, biggest
  // sample first with the rival id as a stable tie-break.
  //
  // `knownRivalIds` (a Set or array of the rival ids that still exist) drops
  // games pointing at a rival who is gone from the list. Cross-device sync
  // writes the rival list and the game log under separate keys, so a rival
  // deleted on one device can have their games pushed back by another,
  // leaving games nobody owns. Every other view already reads the game log
  // through the rival list and ignores those; without this the records view
  // was the one place they surfaced, as an "Unknown rival" row that also
  // inflated the period's own W-L-T. Omit the argument to bucket everything.
  function periodRecords(games, unit, knownRivalIds) {
    const known = knownRivalIds instanceof Set ? knownRivalIds
      : Array.isArray(knownRivalIds) ? new Set(knownRivalIds)
      : null;
    const byPeriod = new Map();
    for (const g of Array.isArray(games) ? games : []) {
      if (!g || !bothPlayed(g)) continue;
      if (known && !known.has(g.rivalId)) continue;
      const bounds = periodBounds(g.date, unit);
      if (!bounds) continue;
      let period = byPeriod.get(bounds.id);
      if (!period) {
        period = Object.assign({ id: bounds.id, unit: unit === 'month' ? 'month' : 'week',
                                 start: bounds.start, end: bounds.end,
                                 rivals: new Map() }, blankRecord());
        byPeriod.set(bounds.id, period);
      }
      const result = resultOf(g);
      tallyRecord(period, result);
      let rival = period.rivals.get(g.rivalId);
      if (!rival) {
        rival = Object.assign({ rivalId: g.rivalId }, blankRecord());
        period.rivals.set(g.rivalId, rival);
      }
      tallyRecord(rival, result);
    }

    return Array.from(byPeriod.values())
      .map(period => {
        const byRival = Array.from(period.rivals.values())
          .map(finishRecord)
          .sort((a, b) => b.games - a.games ||
                          String(a.rivalId).localeCompare(String(b.rivalId)));
        delete period.rivals;
        period.byRival = byRival;
        return finishRecord(period);
      })
      .sort((a, b) => b.start.localeCompare(a.start));
  }

  // ---------- running period record vs one rival ----------

  // Which way one period went against one rival: you out-won them, they
  // out-won you, or you split it. Ties inside the period never decide it, so
  // a period of nothing but ties is a tied period. A period you never played
  // that rival in is not a period at all, and returns null.
  function periodOutcomeVsRival(rivalRecord) {
    if (!rivalRecord || !rivalRecord.games) return null;
    if (rivalRecord.wins > rivalRecord.losses) return 'won';
    if (rivalRecord.wins < rivalRecord.losses) return 'lost';
    return 'tied';
  }

  // Periods won / lost / tied against each rival, replayed oldest period
  // first and snapshotted at every period, so a card can show the record as
  // it stood at the end of its own period ("Gal (63-54-1)"). Takes the
  // periodRecords() output in any order and returns
  // { [periodId]: { [rivalId]: { won, lost, tied } } }; a rival absent from a
  // period keeps the tally it already had, it does not reset or disappear.
  function runningRivalPeriodRecords(periods) {
    const ordered = (Array.isArray(periods) ? periods : [])
      .filter(p => p && p.id)
      .slice()
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const running = new Map();
    const out = {};
    for (const period of ordered) {
      for (const rivalRecord of period.byRival || []) {
        const outcome = periodOutcomeVsRival(rivalRecord);
        if (!outcome) continue;
        let tally = running.get(rivalRecord.rivalId);
        if (!tally) {
          tally = { won: 0, lost: 0, tied: 0 };
          running.set(rivalRecord.rivalId, tally);
        }
        tally[outcome] += 1;
      }
      // fromEntries defines own properties, so a '__proto__' rival id (
      // reachable via backup import) lands as data instead of setting the
      // snapshot's prototype.
      out[period.id] = Object.fromEntries(
        Array.from(running, ([rivalId, tally]) => [rivalId, Object.assign({}, tally)]));
    }
    return out;
  }

  // "9-8" until a period is drawn, "63-54-1" after: the tied component only
  // shows up once there is one to show.
  function periodTallyText(tally) {
    if (!tally) return '';
    return tally.tied
      ? `${tally.won}-${tally.lost}-${tally.tied}`
      : `${tally.won}-${tally.lost}`;
  }

  // ---------- predicted-position accuracy ----------
  // Entries are one day's players: { key, name, predictedTotal, actualTotal }.
  // `key` identifies the player (rival id, or a sentinel for the user) and
  // `actualTotal` is null when that player did not play the day.

  // Player keys ordered by `scoreKey` descending, name as the tie-break, so
  // the index in the returned array is the player's rank for that day. This
  // mirrors the Today's-predictions leaderboard sort.
  function rankByScore(entries, scoreKey) {
    return (Array.isArray(entries) ? entries : [])
      .filter(e => e && Number.isFinite(e[scoreKey]))
      .slice()
      .sort((a, b) => b[scoreKey] - a[scoreKey] ||
                      String(a.name || '').localeCompare(String(b.name || '')))
      .map(e => e.key);
  }

  // Which players hit their predicted finishing position on this day.
  // Both rankings are taken over the same set: players with a computable
  // prediction who actually played. A predicted player who sat the day out
  // holds no predicted slot, so he cannot make the players ranked below him
  // structurally unable to hit.
  // Players without a prediction, or who sat the day out, are absent from
  // the result and so count toward nobody's eligible days.
  //
  // Every per-player accumulator below builds in a Map and returns through
  // Object.fromEntries: player keys are rival ids straight from storage, and
  // backup import accepts ids verbatim, so a '__proto__' id must become an
  // own data property (which fromEntries guarantees) rather than hitting the
  // Object.prototype setter and vanishing or corrupting the accumulator.
  function positionHitsForDay(entries) {
    const played = (Array.isArray(entries) ? entries : [])
      .filter(e => e && Number.isFinite(e.predictedTotal) && Number.isFinite(e.actualTotal));
    const predictedOrder = rankByScore(played, 'predictedTotal');
    const actualOrder = rankByScore(played, 'actualTotal');
    const out = new Map();
    for (const entry of played) {
      out.set(entry.key, predictedOrder.indexOf(entry.key) === actualOrder.indexOf(entry.key));
    }
    return Object.fromEntries(out);
  }

  // Accumulate per-player { hits, eligible } over a list of days, each day
  // being its own entries array. Players with no eligible day are absent
  // from the result, which is what lets the UI skip the badge entirely
  // instead of rendering a meaningless "0/0".
  function accumulatePositionHits(days) {
    const out = new Map();
    for (const entries of Array.isArray(days) ? days : []) {
      const hits = positionHitsForDay(entries);
      for (const key of Object.keys(hits)) {
        let rec = out.get(key);
        if (!rec) { rec = { hits: 0, eligible: 0 }; out.set(key, rec); }
        rec.eligible += 1;
        if (hits[key]) rec.hits += 1;
      }
    }
    return Object.fromEntries(out);
  }

  // ---------- daily finishing positions ----------
  // Entries are one day's players: { key, total }, where a non-finite total
  // means that player did not play. Position is 1-based over the players who
  // did play, ranked by actual daily total, so paste-imported days (no cities,
  // no prediction) count exactly like synced ones.
  //
  // Equal totals share the mean of the ranks they span: two players tied for
  // first are both 1.5, never an arbitrary first and second decided by name.
  // A day with fewer than two players yields nothing at all - finishing first
  // out of one is not a position, it is just showing up.
  function finishPositionsForDay(entries) {
    const played = (Array.isArray(entries) ? entries : [])
      .filter(e => e && Number.isFinite(e.total));
    if (played.length < 2) return {};
    const ordered = played.slice().sort((a, b) => b.total - a.total);
    const out = new Map();
    let i = 0;
    while (i < ordered.length) {
      let j = i;
      while (j + 1 < ordered.length && ordered[j + 1].total === ordered[i].total) j++;
      const shared = ((i + 1) + (j + 1)) / 2;
      for (let k = i; k <= j; k++) out.set(ordered[k].key, shared);
      i = j + 1;
    }
    return Object.fromEntries(out);
  }

  // Share of the field a player beat on a day: (N - R) / (N - 1) for their
  // fractional rank R among the N players who played. First is always 1 and
  // last is always 0 whatever N is, so being last of three reads exactly as
  // badly as being last of ten - which raw positions cannot express, since
  // "3rd" flatters a small field and punishes a big one. A day where everyone
  // ties lands the whole field on 0.5.
  function fieldSharesForDay(entries) {
    const positions = finishPositionsForDay(entries);
    const keys = Object.keys(positions);
    const n = keys.length;
    const out = new Map();
    for (const key of keys) out.set(key, (n - positions[key]) / (n - 1));
    return Object.fromEntries(out);
  }

  // Integer competition ranks ("1224" style) for the day: tied players all
  // take the best rank of the span they tie across, and the next distinct
  // total resumes below the whole group. This is the bucketing the finish
  // distribution wants - two players tied for the top total both *finished
  // 1st* - whereas the fractional mean rank above would smear a tie into a
  // position 1.5 that nobody can actually finish in. Same solo-day and
  // did-not-play rules as finishPositionsForDay.
  function competitionRanksForDay(entries) {
    const played = (Array.isArray(entries) ? entries : [])
      .filter(e => e && Number.isFinite(e.total));
    if (played.length < 2) return {};
    const ordered = played.slice().sort((a, b) => b.total - a.total);
    const out = new Map();
    let i = 0;
    while (i < ordered.length) {
      let j = i;
      while (j + 1 < ordered.length && ordered[j + 1].total === ordered[i].total) j++;
      for (let k = i; k <= j; k++) out.set(ordered[k].key, i + 1);
      i = j + 1;
    }
    return Object.fromEntries(out);
  }

  // Accumulate per-player { days, sum, avg, shareSum, share, counts, dates,
  // maxField } over a list of days, each day being its own entries array.
  // `share` is the headline figure (mean daily share of the field beaten,
  // 0..1); `avg` is the mean raw finishing position, kept for the tooltip.
  // `counts` maps integer finishing position (competition-ranked, so ties
  // bucket at the top of their span) to the number of days the player
  // finished there, and `maxField` is the biggest field the player has
  // competed in - together they let the UI draw a full 1..N distribution
  // where a zero-count row still means something. `dayISOs`, when given, is
  // a parallel array of each day's ISO date; `dates` then maps each position
  // to the (unsorted) list of ISO dates the player finished there, so the UI
  // can name the exact days behind a sparse bucket. Players with no
  // qualifying day are absent from the result, which is what lets the UI
  // skip the figure instead of rendering a meaningless "avg 0%".
  function accumulateFinishPositions(days, dayISOs) {
    const out = new Map();
    const list = Array.isArray(days) ? days : [];
    const isos = Array.isArray(dayISOs) ? dayISOs : [];
    for (let i = 0; i < list.length; i++) {
      const entries = list[i];
      const iso = typeof isos[i] === 'string' ? isos[i] : null;
      const positions = finishPositionsForDay(entries);
      const shares = fieldSharesForDay(entries);
      const ranks = competitionRanksForDay(entries);
      const field = Object.keys(positions).length;
      for (const key of Object.keys(positions)) {
        let rec = out.get(key);
        if (!rec) {
          rec = { days: 0, sum: 0, avg: 0, shareSum: 0, share: 0, counts: {}, dates: {}, maxField: 0 };
          out.set(key, rec);
        }
        rec.days += 1;
        rec.sum += positions[key];
        rec.shareSum += shares[key];
        rec.counts[ranks[key]] = (rec.counts[ranks[key]] || 0) + 1;
        if (iso) (rec.dates[ranks[key]] = rec.dates[ranks[key]] || []).push(iso);
        if (field > rec.maxField) rec.maxField = field;
      }
    }
    out.forEach(rec => {
      rec.avg = rec.sum / rec.days;
      rec.share = rec.shareSum / rec.days;
    });
    return Object.fromEntries(out);
  }

  // Comparative color for a set of figures shown side by side. The lowest
  // value anchors green, the highest anchors red, so a caller whose metric is
  // better-when-higher (the field-share percentage) negates its values before
  // passing them in; everything between is a linear RGB blend through a yellow
  // midpoint: the lower half of the range walks green -> yellow, the upper
  // half yellow -> red. Fewer than two averages, or a set where every average
  // is identical, has nothing to compare against and yields null throughout so
  // the caller keeps its neutral color instead of inventing a ranking.
  const AVG_POS_RAMP = [[74, 222, 128], [250, 204, 21], [248, 113, 113]];

  function avgPositionColor(t) {
    const c = Math.min(1, Math.max(0, t));
    const leg = c <= 0.5 ? 0 : 1;
    const from = AVG_POS_RAMP[leg];
    const to = AVG_POS_RAMP[leg + 1];
    const local = (c - leg * 0.5) / 0.5;
    const ch = i => Math.round(from[i] + (to[i] - from[i]) * local);
    return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
  }

  function avgPositionColors(values) {
    const list = Array.isArray(values) ? values : [];
    const nums = list.filter(v => Number.isFinite(v));
    if (nums.length < 2) return list.map(() => null);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (max === min) return list.map(() => null);
    return list.map(v => Number.isFinite(v) ? avgPositionColor((v - min) / (max - min)) : null);
  }

  // ---------- continents ----------
  // My own per-round average bucketed by continent, across every rival at
  // once (the per-rival version lives in app.js as continentBreakdown).
  //
  // `classify(lat, lng) -> continent name` is injected: the bounding-box table
  // stays in app.js, this module stays free of geography.
  //
  // Two traps this guards against:
  //   1. A day played against 3 rivals is stored as 3 game records carrying
  //      the SAME myScores and the SAME cities. Counting every record would
  //      triple-count my rounds, so one qualifying game per date wins.
  //   2. Only MapTap-synced games have a `cities` array; pasted games have no
  //      coordinates at all and contribute nothing.
  //
  // Rounds without a finite numeric lat AND lng are dropped from the buckets
  // and from the round counts BEFORE the classifier is called: coordNum keeps
  // Number(null) / Number('') from smuggling a coordinate-less round in as
  // the valid point (0, 0), which the real bounding-box table would bucket
  // as Africa. A round the classifier itself answers 'Unknown' for is
  // dropped the same way.
  function myAvgByContinent(games, classify) {
    const list = Array.isArray(games) ? games : [];
    const seenDates = new Set();
    const buckets = new Map();
    let totalRounds = 0;
    let days = 0;

    for (const g of list) {
      if (!g || !Array.isArray(g.cities) || g.cities.length !== N_LOCS) continue;
      if (!iPlayed(g) || !Array.isArray(g.myScores) || g.myScores.length !== N_LOCS) continue;
      const dateKey = String(g.date);
      if (seenDates.has(dateKey)) continue;
      seenDates.add(dateKey);
      days++;
      for (let i = 0; i < N_LOCS; i++) {
        const c = g.cities[i] || {};
        const lat = coordNum(c.lat);
        const lng = coordNum(c.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const continent = classify(lat, lng);
        if (continent === 'Unknown') continue;
        if (!buckets.has(continent)) buckets.set(continent, { continent, rounds: 0, mySum: 0 });
        const b = buckets.get(continent);
        b.rounds++;
        b.mySum += Number(g.myScores[i]) || 0;
        totalRounds++;
      }
    }

    const rows = Array.from(buckets.values()).map(b => ({
      continent: b.continent,
      rounds: b.rounds,
      myAvg: b.mySum / b.rounds,
    }));
    // Round count first, name A-Z as the tie-break so the chip order never
    // flaps between renders.
    rows.sort((a, b) => b.rounds - a.rounds || a.continent.localeCompare(b.continent));
    return { rows, totalRounds, days };
  }

  // ---------- ordering ----------
  // Case-insensitive name order, used by every rival list outside the Records
  // view. Names differing only in case fall back to the raw comparison so the
  // order stays stable instead of flipping between renders.
  function compareNamesCI(a, b) {
    const as = String(a == null ? '' : a);
    const bs = String(b == null ? '' : b);
    return as.toLowerCase().localeCompare(bs.toLowerCase()) || as.localeCompare(bs);
  }

  // Best win % first, for the Records per-rival split. A record with nothing
  // decided (all ties, or no games) has no win % to rank on and sorts below a
  // genuine 0% rather than sharing the bottom with it.
  function compareWinPctDesc(a, b) {
    const av = a && a.decided > 0 ? a.winPct : -1;
    const bv = b && b.decided > 0 ? b.winPct : -1;
    return bv - av;
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
    // calendar periods
    parseDateISO, isoWeekStart, isoWeekEnd, isoWeekId,
    monthId, monthStart, monthEnd, periodBounds, periodRecords,
    periodOutcomeVsRival, runningRivalPeriodRecords, periodTallyText,
    // predicted-position accuracy
    rankByScore, positionHitsForDay, accumulatePositionHits,
    // finishing positions
    finishPositionsForDay, fieldSharesForDay, competitionRanksForDay,
    accumulateFinishPositions,
    avgPositionColor, avgPositionColors,
    // continents
    coordNum, myAvgByContinent,
    // ordering
    compareNamesCI, compareWinPctDesc,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.MapTapStats = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
