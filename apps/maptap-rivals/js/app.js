/* MapTap Rivals — daily MapTap.gg head-to-head tracker.
 *
 * Data model (all JSON-stringified into localStorage so the storage-sync
 * module mirrors it to Firestore the same way the other apps do):
 *
 *   maptapRivalsRivals  : Rival[] = { id, name, color, icon, createdAt }
 *   maptapRivalsGames   : Game[]  = {
 *     id, rivalId, date (YYYY-MM-DD), note, createdAt,
 *     myScores:    number[5]  // raw 0-100 per location (new games)
 *     theirScores: number[5]  // raw 0-100 per location (new games)
 *     myScore, theirScore     // weighted totals; for old games these are
 *                             // the only scores present (myScores absent).
 *   }
 *   maptapRivalsMe      : string (display name for "you")
 *   maptapRivalsSettings: { lastRivalId?: string }
 *   maptapRivalsSelectedRivalId : string (currently focused rival)
 *
 * Scoring: each location is 0-100 raw. Round weights are [1, 1, 2, 3, 3]
 * so the daily total is 0-1000. Helpers compute totals on demand and treat
 * older games (no myScores array) as totals-only — they're included in
 * total/streak metrics but skipped from per-location breakdowns.
 */

(function () {
  'use strict';

  // ---------- storage helpers ----------
  const KEY = {
    RIVALS: 'maptapRivalsRivals',
    GAMES: 'maptapRivalsGames',
    ME: 'maptapRivalsMe',
    MY_MAPTAP: 'maptapRivalsMyMapTap',
    MY_ICON: 'maptapRivalsMyIcon',
    MY_PROFILE: 'maptapRivalsMyProfile',
    SETTINGS: 'maptapRivalsSettings',
    SELECTED: 'maptapRivalsSelectedRivalId',
    MATRIX_SEL: 'maptapRivalsMatrixSelection',
    // Per-ISO-date cache of the day's 5 puzzle lat/lng pairs. Values are
    // stored under `KEY.DAILY_CITIES_PREFIX + isoDate`. Only coordinates
    // are persisted — never names or trivia from the daily file.
    DAILY_CITIES_PREFIX: 'maptapRivalsDailyCities/',
  };

  // Public MapTap Cloud Function — returns gameHistory keyed by YYYY-MM-DD.
  // CORS allows https://shevato.com so we can call this directly from the
  // browser without a proxy.
  const MAPTAP_PROFILE_URL =
    'https://us-central1-jjexperiment-12af6.cloudfunctions.net/getPublicProfile';

  // Daily puzzle locations. MapTap publishes each day's content as a static
  // JS file at `data/this_day_in_history/<MonthDay>.js`. The file is CORS-
  // open and contains the same 5 cities every player will play that day
  // (it lists more for editorial flexibility, but MapTap only plays the
  // first N_LOCS in file order — verified empirically across 5+ days). We
  // fetch the text and pull only lat/lng — names and trivia are dropped
  // before anything reaches the predictor or the UI.
  const MAPTAP_DAILY_URL_BASE = 'https://maptap.gg/data/this_day_in_history/';

  const COLORS = [
    '#6366f1', '#22d3ee', '#4ade80', '#f97316', '#f43f5e',
    '#a855f7', '#facc15', '#10b981', '#ec4899', '#0ea5e9',
  ];
  const ICONS = ['🦊','🐺','🐻','🦁','🐯','🐲','🦅','🐙','🦈','🚀','⚡','🔥','🎯','🗺️','💀'];

  // Inline stroke SVGs for compact icon buttons. Single visual weight,
  // currentColor for theming, no platform-specific emoji rendering quirks.
  const ICON_SYNC =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>' +
    '<path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>' +
    '<path d="M3 21v-5h5"/>' +
    '</svg>';
  const ICON_EDIT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M12 20h9"/>' +
    '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>' +
    '</svg>';
  const ICON_TRASH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M4 7h16"/>' +
    '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' +
    '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>' +
    '<path d="M10 11v6"/>' +
    '<path d="M14 11v6"/>' +
    '</svg>';
  const ICON_SYNC_BADGE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>' +
    '<path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>' +
    '<path d="M3 21v-5h5"/>' +
    '</svg>';
  const ICON_SHARE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>' +
    '<polyline points="16 6 12 2 8 6"/>' +
    '<line x1="12" y1="2" x2="12" y2="15"/>' +
    '</svg>';

  // Render the Note cell. "synced from MapTap" — which would otherwise repeat
  // on most rows — collapses to a tiny sync icon with a tooltip. Manual
  // notes render as quiet muted text.
  function noteCell(g) {
    if (g.note === 'synced from MapTap') {
      return el('td', { class: 'row-note-cell' }, [
        el('span', {
          class: 'row-note-pill',
          title: 'Synced from MapTap',
          'aria-label': 'Synced from MapTap',
          html: ICON_SYNC_BADGE,
        }),
      ]);
    }
    if (g.note) return el('td', { class: 'row-note-cell row-note' }, g.note);
    return el('td', { class: 'row-note-cell' }, '');
  }

  function deleteCell(g) {
    return el('td', { class: 'row-action-cell' }, [
      el('button', {
        type: 'button',
        class: 'icon-btn icon-btn-danger',
        title: 'Delete game',
        'aria-label': 'Delete game',
        html: ICON_TRASH,
        onclick: () => deleteGame(g.id),
      }),
    ]);
  }

  // MapTap scoring: 5 locations × 0-100 raw, multipliers [1,1,2,3,3] → 0-1000 daily total.
  const N_LOCS = 5;
  const WEIGHTS = [1, 1, 2, 3, 3];
  const MAX_RAW = 100;
  const LOC_LABELS = ['R1', 'R2', 'R3', 'R4', 'R5'];
  const LOC_NAMES = ['Round 1', 'Round 2', 'Round 3', 'Round 4', 'Round 5'];

  function weightedTotal(scores) {
    if (!Array.isArray(scores) || scores.length !== N_LOCS) return 0;
    let t = 0;
    for (let i = 0; i < N_LOCS; i++) t += (scores[i] || 0) * WEIGHTS[i];
    return t;
  }
  function hasLocs(g) { return Array.isArray(g.myScores) && Array.isArray(g.theirScores); }

  function arrEq(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function getMyTotal(g) { return hasLocs(g) ? weightedTotal(g.myScores) : (g.myScore || 0); }
  function getTheirTotal(g) { return hasLocs(g) ? weightedTotal(g.theirScores) : (g.theirScore || 0); }

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
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

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

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function save(key, value) {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  }

  function loadString(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : raw;
    } catch (_) {
      return raw;
    }
  }

  function saveString(key, value) {
    if (!value) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  }

  // ---------- state ----------
  const state = {
    rivals: load(KEY.RIVALS, []),
    games: load(KEY.GAMES, []),
    me: loadString(KEY.ME, 'Me'),
    myMapTap: loadString(KEY.MY_MAPTAP, ''),
    myIcon: loadString(KEY.MY_ICON, '🧍'),
    myProfile: load(KEY.MY_PROFILE, null),
    profileEditMode: false,        // true → username input is shown
    profileVerifying: false,
    profileError: null,
    syncAllInFlight: false,
    settings: load(KEY.SETTINGS, {}),
    selectedRivalId: loadString(KEY.SELECTED, null),
    view: 'dashboard',
    matrixSelection: load(KEY.MATRIX_SEL, null), // string[] of rivalIds, or null = "all"
    matrixTab: 'record',           // overridden by URL hash on first paint
    historyFilters: { rival: 'all', result: 'all' },
    historyPage: 1,
    historyPageSize: 25,
    rivalGamesPage: 1,
    rivalGamesPageSize: 25,
    lastRenderedRivalId: null,
    editingRivalId: null,
    pickedColor: COLORS[0],
    pickedIcon: ICONS[0],
    charts: { trend: null, wins: null, diff: null, radar: null, locWinrate: null },
    syncing: new Set(),       // rivalIds currently fetching from MapTap
    syncStatus: new Map(),    // rivalId -> { kind: 'ok'|'flat'|'err', msg }
    // Rolling 7-day puzzle window starting at today. Each entry holds:
    //   { iso, cities: [{lat,lng}…] | null, status: 'idle'|'fetching'|'ok'|'error' }
    // Reseeded when the local date crosses midnight mid-session.
    predictWindow: [],
    predictWindowAnchorISO: null,
    // ISO date of the day currently shown in the dashboard predictions card.
    predictSelectedISO: null,
  };

  function persistRivals() { save(KEY.RIVALS, state.rivals); }
  function persistGames() { save(KEY.GAMES, state.games); }
  function persistSettings() { save(KEY.SETTINGS, state.settings); }
  function persistMe() { saveString(KEY.ME, state.me); }
  function persistMyIcon() { saveString(KEY.MY_ICON, state.myIcon); }
  function persistMyMapTap() { saveString(KEY.MY_MAPTAP, state.myMapTap); }
  function persistMyProfile() { save(KEY.MY_PROFILE, state.myProfile); }
  function persistSelected() { saveString(KEY.SELECTED, state.selectedRivalId); }
  function persistMatrixSelection() { save(KEY.MATRIX_SEL, state.matrixSelection); }

  // ---------- date utils ----------
  function todayISO() {
    const d = new Date();
    const tz = d.getTimezoneOffset();
    return new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
  }
  function daysBetween(aISO, bISO) {
    const a = new Date(aISO + 'T00:00:00');
    const b = new Date(bISO + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  function fmtDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // Shared `<MonthName><Day>` token used by both the maptap.gg history
  // deep link and the daily-puzzle data URL. English month names are
  // hardcoded since the URLs are owned by maptap.gg and must not vary
  // with the user's locale; the day is not zero-padded.
  const ENGLISH_MONTHS = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];
  function maptapMonthDay(iso) {
    if (!iso) return null;
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    return `${ENGLISH_MONTHS[d.getMonth()]}${d.getDate()}`;
  }
  function mapTapHistoryUrl(iso) {
    const tok = maptapMonthDay(iso);
    return tok ? `https://maptap.gg/history/${tok}` : null;
  }
  function mapTapDailyDataUrl(iso) {
    const tok = maptapMonthDay(iso);
    return tok ? `${MAPTAP_DAILY_URL_BASE}${tok}.js` : null;
  }

  // Today's ISO date in the user's local timezone, so the prediction
  // tracks whatever day MapTap is showing the user (MapTap's day rolls
  // over at local midnight too — verified from observed gameHistory keys).
  function todayISO() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }
  function addDaysISO(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const PREDICT_WINDOW_DAYS = 7;

  // Pull only the first N_LOCS lat/lng pairs from a daily puzzle file.
  // The MapTap client plays the first 5 cities in file order regardless
  // of how many the file lists (verified across May 10-14 plays). We
  // deliberately discard name/trivia/photos so the predictor and any
  // downstream code never accidentally surface the answer.
  // Regex: match `lat:` not preceded by a letter (excludes `labelLat:`),
  // then the nearest `lng:` (same letter-boundary exclusion).
  const DAILY_LATLNG_RE =
    /(?<![A-Za-z])lat\s*:\s*(-?\d+(?:\.\d+)?)\s*,[\s\S]{0,80}?(?<![A-Za-z])lng\s*:\s*(-?\d+(?:\.\d+)?)/g;
  function parseDailyCitiesText(src) {
    if (typeof src !== 'string' || !src.length) return null;
    DAILY_LATLNG_RE.lastIndex = 0;
    const out = [];
    let m;
    while ((m = DAILY_LATLNG_RE.exec(src)) !== null) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) &&
          lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        out.push({ lat, lng });
      }
      if (out.length >= N_LOCS) break;
    }
    return out.length === N_LOCS ? out : null;
  }

  // Fetch + cache the day's 5 puzzle coordinates. Cache is keyed by ISO
  // date; once a puzzle's day has passed, the file is immutable so the
  // cache is valid forever. For today / future dates we still cache but
  // re-fetch after 6h in case MapTap revises the file before play.
  async function fetchDailyCities(iso) {
    const url = mapTapDailyDataUrl(iso);
    if (!url) return null;
    const cacheKey = KEY.DAILY_CITIES_PREFIX + iso;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached && Array.isArray(cached.cities) && cached.cities.length === N_LOCS) {
        const isPast = iso < todayISO();
        const fresh = isPast || (Date.now() - (cached.cachedAt || 0)) < 6 * 3600 * 1000;
        if (fresh) return cached.cities;
      }
    } catch (_) { /* cache corrupted — fall through to fetch */ }
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return null;
      const text = await res.text();
      const cities = parseDailyCitiesText(text);
      if (!cities) return null;
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ cities, cachedAt: Date.now() }));
      } catch (_) { /* quota — ignore, prediction still works for this session */ }
      return cities;
    } catch (_) {
      return null;
    }
  }
  function fmtDateLong(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------- analytics ----------
  function gamesFor(rivalId) {
    return state.games
      .filter(g => g.rivalId === rivalId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  }

  function resultOf(g) {
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

  function lastNDaysGames(games, n) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (n - 1));
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    return games.filter(g => g.date >= cutoffISO);
  }

  // Per-location aggregates over a set of games (only those with location data).
  function locationStats(games, locIdx) {
    const withLocs = games.filter(hasLocs);
    if (!withLocs.length) return null;
    let myWins = 0, theirWins = 0, ties = 0;
    let myBest = -Infinity, myWorst = Infinity;
    let theirBest = -Infinity, theirWorst = Infinity;
    let myPerfects = 0, theirPerfects = 0;
    let myZeros = 0, theirZeros = 0;
    let biggestGap = 0;
    const myRaws = [];
    const theirRaws = [];
    for (const g of withLocs) {
      const m = g.myScores[locIdx] || 0;
      const t = g.theirScores[locIdx] || 0;
      myRaws.push(m);
      theirRaws.push(t);
      const r = resultLoc(m, t);
      if (r === 'W') myWins++; else if (r === 'L') theirWins++; else ties++;
      if (m > myBest) myBest = m;
      if (m < myWorst) myWorst = m;
      if (t > theirBest) theirBest = t;
      if (t < theirWorst) theirWorst = t;
      if (m === MAX_RAW) myPerfects++;
      if (t === MAX_RAW) theirPerfects++;
      if (m === 0) myZeros++;
      if (t === 0) theirZeros++;
      const gap = Math.abs(m - t);
      if (gap > biggestGap) biggestGap = gap;
    }
    const total = withLocs.length;
    return {
      total,
      locIdx,
      label: LOC_LABELS[locIdx],
      name: LOC_NAMES[locIdx],
      weight: WEIGHTS[locIdx],
      myAvg: average(myRaws),
      theirAvg: average(theirRaws),
      avgDiff: average(myRaws) - average(theirRaws),
      myWins, theirWins, ties,
      winPct: total ? myWins / total : 0,
      myBest, myWorst,
      theirBest, theirWorst,
      myConsistency: stdDev(myRaws),
      theirConsistency: stdDev(theirRaws),
      myPerfects, theirPerfects,
      myZeros, theirZeros,
      biggestGap,
      // Recent trend slope on my raw scores at this round (last 10 instances)
      trendSlope: linearTrend(myRaws.slice(-10)),
    };
  }

  // "Carry" / "Choke" analysis: for each game, find which location contributed
  // the largest weighted differential (mine − theirs). Aggregate counts of how
  // often each location was the carry (in wins) and the choke (in losses).
  function carryChoke(games) {
    const counts = {
      carryInWins: Array(N_LOCS).fill(0),
      chokeInLosses: Array(N_LOCS).fill(0),
      decisive: Array(N_LOCS).fill(0), // largest |weighted diff| per game, any result
    };
    for (const g of games.filter(hasLocs)) {
      let bestPos = -Infinity, bestPosIdx = -1;
      let bestNeg = Infinity, bestNegIdx = -1;
      let bestAbs = -Infinity, bestAbsIdx = -1;
      for (let i = 0; i < N_LOCS; i++) {
        const wd = ((g.myScores[i] || 0) - (g.theirScores[i] || 0)) * WEIGHTS[i];
        if (wd > bestPos) { bestPos = wd; bestPosIdx = i; }
        if (wd < bestNeg) { bestNeg = wd; bestNegIdx = i; }
        if (Math.abs(wd) > bestAbs) { bestAbs = Math.abs(wd); bestAbsIdx = i; }
      }
      const r = resultOf(g);
      if (r === 'W' && bestPosIdx >= 0) counts.carryInWins[bestPosIdx]++;
      if (r === 'L' && bestNegIdx >= 0) counts.chokeInLosses[bestNegIdx]++;
      if (bestAbsIdx >= 0) counts.decisive[bestAbsIdx]++;
    }
    return counts;
  }

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

  function rivalSummary(rival) {
    const games = gamesFor(rival.id);
    const total = games.length;
    let wins = 0, losses = 0, ties = 0;
    let myCum = 0, theirCum = 0;
    let bestMine = -Infinity, worstMine = Infinity;
    let bestTheirs = -Infinity, worstTheirs = Infinity;
    let bestMineGame = null, worstMineGame = null;
    let bestTheirsGame = null, worstTheirsGame = null;
    let biggestWinMargin = 0, biggestLossMargin = 0;
    let biggestWinGame = null, biggestLossGame = null;

    for (const g of games) {
      const r = resultOf(g);
      const myT = getMyTotal(g);
      const theirT = getTheirTotal(g);
      if (r === 'W') wins++;
      else if (r === 'L') losses++;
      else ties++;
      myCum += myT;
      theirCum += theirT;
      if (myT > bestMine)   { bestMine   = myT;   bestMineGame   = g; }
      if (myT < worstMine)  { worstMine  = myT;   worstMineGame  = g; }
      if (theirT > bestTheirs)  { bestTheirs  = theirT; bestTheirsGame  = g; }
      if (theirT < worstTheirs) { worstTheirs = theirT; worstTheirsGame = g; }
      const diff = myT - theirT;
      if (diff > biggestWinMargin) { biggestWinMargin = diff; biggestWinGame = g; }
      if (diff < biggestLossMargin) { biggestLossMargin = diff; biggestLossGame = g; }
    }

    const last7 = lastNDaysGames(games, 7);
    const last30 = lastNDaysGames(games, 30);
    const recent5 = games.slice(-5);

    const s = streaks(games);
    const myTotals = games.map(getMyTotal);
    const theirTotals = games.map(getTheirTotal);

    // Per-location aggregates
    const gamesWithLocs = games.filter(hasLocs);
    const locStats = gamesWithLocs.length
      ? Array.from({ length: N_LOCS }, (_, i) => locationStats(games, i))
      : null;
    const cc = gamesWithLocs.length ? carryChoke(games) : null;

    let strongest = null, weakest = null;
    let bestRoundWinPct = null, worstRoundWinPct = null;
    let mostVolatile = null;
    let mostPerfects = null;
    let myTotalPerfects = 0, theirTotalPerfects = 0;
    if (locStats) {
      strongest = locStats.slice().sort((a, b) => b.myAvg - a.myAvg)[0];
      weakest = locStats.slice().sort((a, b) => a.myAvg - b.myAvg)[0];
      bestRoundWinPct = locStats.slice().sort((a, b) => b.winPct - a.winPct)[0];
      worstRoundWinPct = locStats.slice().sort((a, b) => a.winPct - b.winPct)[0];
      mostVolatile = locStats.slice().sort((a, b) => b.myConsistency - a.myConsistency)[0];
      mostPerfects = locStats.slice().sort((a, b) => b.myPerfects - a.myPerfects)[0];
      myTotalPerfects = locStats.reduce((a, l) => a + l.myPerfects, 0);
      theirTotalPerfects = locStats.reduce((a, l) => a + l.theirPerfects, 0);
    }

    return {
      rival,
      games,
      total,
      wins, losses, ties,
      winPct: total ? wins / total : 0,
      myAvgAll: average(myTotals),
      theirAvgAll: average(theirTotals),
      myAvg7: average(last7.map(getMyTotal)),
      theirAvg7: average(last7.map(getTheirTotal)),
      myAvg30: average(last30.map(getMyTotal)),
      theirAvg30: average(last30.map(getTheirTotal)),
      cumDiff: myCum - theirCum,
      bestMine: total ? bestMine : 0,
      worstMine: total ? worstMine : 0,
      bestTheirs: total ? bestTheirs : 0,
      worstTheirs: total ? worstTheirs : 0,
      bestMineGame: total ? bestMineGame : null,
      worstMineGame: total ? worstMineGame : null,
      bestTheirsGame: total ? bestTheirsGame : null,
      worstTheirsGame: total ? worstTheirsGame : null,
      biggestWinMargin,
      biggestLossMargin: Math.abs(biggestLossMargin),
      biggestWinGame,
      biggestLossGame,
      consistencyMine: stdDev(myTotals),
      consistencyTheirs: stdDev(theirTotals),
      streak: s,
      hot: s.curMine >= 3,
      onColdStreak: s.curTheirs >= 3,
      recent5,
      recentForm: recent5.map(resultOf),
      trendSlope: linearTrend(myTotals.slice(-10)),
      projection: projectNext(myTotals.slice(-10)),
      // Location breakdown
      gamesWithLocsCount: gamesWithLocs.length,
      locStats,
      strongest, weakest,
      bestRoundWinPct, worstRoundWinPct,
      mostVolatile, mostPerfects,
      myTotalPerfects, theirTotalPerfects,
      carryChoke: cc,
    };
  }

  // ---------- DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ---------- view switching ----------
  function setView(view) {
    const changed = state.view !== view;
    state.view = view;
    $$('.view-tab').forEach(tab => {
      const active = tab.dataset.view === view;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $$('.view').forEach(panel => {
      const active = panel.dataset.viewPanel === view;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    });

    if (view === 'dashboard') renderDashboard();
    else if (view === 'rival') renderRival();
    else if (view === 'leaderboard') renderLeaderboard();
    else if (view === 'matrix') renderMatrix();
    else if (view === 'history') renderHistory();

    syncUrlHash();
    // Reset scroll when the view changes so a deep-scrolled dashboard
    // doesn't leave the rival detail mid-page after a card click.
    // Skip on no-op re-renders so a renderRival mid-scroll stays put.
    if (changed) window.scrollTo(0, 0);
  }

  // ---------- URL routing ----------
  // Shareable URLs use the hash fragment:
  //   #dashboard | #leaderboard | #history
  //   #rival/<id>            (rival detail)
  //   #matrix | #matrix/<subtab>
  // We use replaceState so the URL updates silently without polluting the
  // back/forward history; hashchange handles users pasting or editing the URL.
  const KNOWN_VIEWS = new Set(['dashboard', 'rival', 'leaderboard', 'matrix', 'history']);

  function viewHash() {
    if (state.view === 'matrix') {
      return state.matrixTab && state.matrixTab !== 'record'
        ? `#matrix/${state.matrixTab}`
        : '#matrix';
    }
    if (state.view === 'rival' && state.selectedRivalId) {
      return `#rival/${state.selectedRivalId}`;
    }
    return `#${state.view}`;
  }

  // Mirror current in-memory view → location.hash. Bail if already in sync
  // so re-renders don't churn the URL bar mid-typing.
  function syncUrlHash() {
    const want = viewHash();
    if (location.hash === want) return;
    try {
      history.replaceState(null, '', want);
    } catch (_) {
      // Older browsers / file:// — fall back to direct hash assignment.
      location.hash = want.slice(1);
    }
  }

  // Drive view state from location.hash. Used at init and on hashchange
  // (browser back/forward or user-edited URL).
  function applyUrlHash() {
    const raw = (location.hash || '').replace(/^#/, '').trim();
    if (!raw) { setView('dashboard'); return; }
    const slash = raw.indexOf('/');
    const view = slash === -1 ? raw : raw.slice(0, slash);
    const arg = slash === -1 ? '' : raw.slice(slash + 1);

    if (view === 'matrix') {
      state.matrixTab = isValidMatrixTab(arg) ? arg : 'record';
      setView('matrix');
      return;
    }
    if (view === 'rival') {
      if (arg && state.rivals.some(r => r.id === arg)) {
        state.selectedRivalId = arg;
        persistSelected();
        setView('rival');
        return;
      }
      // Unknown rival — fall through to dashboard so a stale link isn't fatal.
      setView('dashboard');
      return;
    }
    if (KNOWN_VIEWS.has(view)) { setView(view); return; }
    setView('dashboard');
  }

  // ---------- rival modal ----------
  function openRivalModal(rivalId) {
    state.editingRivalId = rivalId || null;
    const modal = $('#rival-modal');
    const title = $('#rival-modal-title');
    const nameInput = $('#rival-name');
    const deleteBtn = $('#rival-delete-btn');

    let rival = null;
    if (rivalId) rival = state.rivals.find(r => r.id === rivalId);

    title.textContent = rival ? 'Edit rival' : 'Add rival';
    nameInput.value = rival ? rival.name : '';
    $('#rival-maptap-username').value = rival ? (rival.maptapUsername || '') : '';
    state.pickedColor = rival ? rival.color : COLORS[state.rivals.length % COLORS.length];
    state.pickedIcon = rival ? rival.icon : ICONS[state.rivals.length % ICONS.length];
    deleteBtn.hidden = !rival;

    renderColorSwatches();
    renderIconSwatches();

    modal.hidden = false;
    setTimeout(() => nameInput.focus(), 30);
  }

  function closeRivalModal() {
    $('#rival-modal').hidden = true;
    state.editingRivalId = null;
  }

  function renderColorSwatches() {
    const wrap = $('#color-swatches');
    wrap.innerHTML = '';
    COLORS.forEach(c => {
      const sw = el('button', {
        type: 'button',
        class: 'color-swatch' + (c === state.pickedColor ? ' is-selected' : ''),
        style: `background:${c}`,
        'aria-label': `Color ${c}`,
        onclick: () => { state.pickedColor = c; renderColorSwatches(); },
      });
      wrap.appendChild(sw);
    });
  }

  function renderIconSwatches() {
    const wrap = $('#icon-swatches');
    wrap.innerHTML = '';
    ICONS.forEach(ic => {
      const sw = el('button', {
        type: 'button',
        class: 'icon-swatch' + (ic === state.pickedIcon ? ' is-selected' : ''),
        onclick: () => { state.pickedIcon = ic; renderIconSwatches(); },
      }, ic);
      wrap.appendChild(sw);
    });
  }

  function saveRivalFromModal() {
    const name = $('#rival-name').value.trim();
    if (!name) {
      $('#rival-name').focus();
      return;
    }
    const maptapUsername = normalizeMapTapUsername($('#rival-maptap-username').value);
    if (state.editingRivalId) {
      const r = state.rivals.find(x => x.id === state.editingRivalId);
      if (r) {
        r.name = name;
        r.color = state.pickedColor;
        r.icon = state.pickedIcon;
        r.maptapUsername = maptapUsername;
      }
    } else {
      state.rivals.push({
        id: uid(),
        name,
        color: state.pickedColor,
        icon: state.pickedIcon,
        maptapUsername,
        createdAt: Date.now(),
      });
    }
    persistRivals();
    closeRivalModal();
    refreshRivalSelects();
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'rival') renderRival();
    else if (state.view === 'leaderboard') renderLeaderboard();
    else if (state.view === 'matrix') renderMatrix();
  }

  function deleteRivalFromModal() {
    if (!state.editingRivalId) return;
    const r = state.rivals.find(x => x.id === state.editingRivalId);
    if (!r) return;
    const gameCount = state.games.filter(g => g.rivalId === r.id).length;
    const msg = gameCount
      ? `Delete ${r.name} and all ${gameCount} game${gameCount === 1 ? '' : 's'}? This cannot be undone.`
      : `Delete ${r.name}?`;
    if (!confirm(msg)) return;
    state.rivals = state.rivals.filter(x => x.id !== r.id);
    state.games = state.games.filter(g => g.rivalId !== r.id);
    if (state.selectedRivalId === r.id) {
      state.selectedRivalId = null;
      persistSelected();
    }
    if (Array.isArray(state.matrixSelection) && state.matrixSelection.includes(r.id)) {
      state.matrixSelection = state.matrixSelection.filter(id => id !== r.id);
      persistMatrixSelection();
    }
    persistRivals();
    persistGames();
    closeRivalModal();
    refreshRivalSelects();
    if (state.view === 'rival') setView('dashboard');
    else if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'leaderboard') renderLeaderboard();
    else if (state.view === 'matrix') renderMatrix();
    else if (state.view === 'history') renderHistory();
  }

  // Refresh dependent dropdowns/selectors when the rival list changes.
  function refreshRivalSelects() {
    const opts = state.rivals
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
      .join('');

    const hf = $('#history-rival-filter');
    if (hf) {
      const prevH = hf.value;
      hf.innerHTML = '<option value="all">All rivals</option>' + opts;
      hf.value = state.rivals.some(r => r.id === prevH) ? prevH : 'all';
    }
  }

  function deleteGame(id) {
    const g = state.games.find(x => x.id === id);
    if (!g) return;
    if (!confirm(`Delete this game (${fmtDateShort(g.date)}, ${getMyTotal(g)} vs ${getTheirTotal(g)})?`)) return;
    state.games = state.games.filter(x => x.id !== id);
    persistGames();
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'rival') renderRival();
    else if (state.view === 'leaderboard') renderLeaderboard();
    else if (state.view === 'matrix') renderMatrix();
    else if (state.view === 'history') renderHistory();
  }

  // ---------- share / result card ----------

  // Build the streak line for the share text. Uses games for the rival
  // *up to and including* the game being shared so the streak reflects
  // the state right after that result, not the current live streak.
  function streakUpTo(game) {
    const all = gamesFor(game.rivalId);
    const idx = all.findIndex(g => g.id === game.id);
    if (idx < 0) return null;
    const slice = all.slice(0, idx + 1);
    const s = streaks(slice);
    if (s.curMine >= 2) return { kind: 'W', len: s.curMine };
    if (s.curTheirs >= 2) return { kind: 'L', len: s.curTheirs };
    return null;
  }

  function buildShareText(g, rival) {
    const myT = getMyTotal(g);
    const theirT = getTheirTotal(g);
    const diff = myT - theirT;
    const meName = state.me || 'Me';
    const rivalName = rival ? rival.name : 'Rival';

    const winnerScore = diff >= 0 ? myT : theirT;
    const loserScore  = diff >= 0 ? theirT : myT;
    const margin = Math.abs(diff);
    const result = diff > 0 ? 'you won' : diff < 0 ? 'they won' : 'tie';

    const winnerSquare = '🟩'; // green
    const loserSquare  = '⬜';       // white
    const tieSquare    = '⬛';       // black (tie)

    let lines = [];
    lines.push(`MapTap Rivals — ${meName} vs ${rivalName}`);
    lines.push(g.date);
    lines.push('');

    if (diff > 0) {
      lines.push(`${winnerSquare} ${winnerScore} — ${loserScore} ${loserSquare}  (${result} by ${margin})`);
    } else if (diff < 0) {
      lines.push(`${loserSquare} ${loserScore} — ${winnerScore} ${winnerSquare}  (${result} by ${margin})`);
    } else {
      lines.push(`${tieSquare} ${myT} — ${theirT} ${tieSquare}  (tie)`);
    }

    if (hasLocs(g)) {
      lines.push('Round scores:');
      const myRound    = g.myScores.map((m, i) => resultLoc(m, g.theirScores[i]));
      const theirRound = g.theirScores.map((t, i) => resultLoc(t, g.myScores[i]));
      const toEmoji = r => r === 'W' ? winnerSquare : r === 'L' ? loserSquare : tieSquare;
      lines.push(myRound.map(toEmoji).join('') + '  ' + meName);
      lines.push(theirRound.map(toEmoji).join('') + '  ' + rivalName);
    }

    const sk = streakUpTo(g);
    if (sk) {
      const streakEmoji = sk.kind === 'W' ? '🔥' : '❄️';
      const who = sk.kind === 'W' ? 'win' : 'loss';
      lines.push('');
      lines.push(`${streakEmoji} ${sk.len}-game ${who} streak`);
    }

    lines.push('shevato.com/apps/maptap-rivals');
    return lines.join('\n');
  }

  // Show a transient toast anchored to `anchorEl`. Cleans itself up after
  // 2.5 s, or immediately if share succeeds via native sheet (no toast needed).
  function showShareToast(anchorEl, msg) {
    const existing = anchorEl.parentNode && anchorEl.parentNode.querySelector('.share-toast');
    if (existing) existing.remove();
    const toast = el('span', { class: 'share-toast', role: 'status', 'aria-live': 'polite' }, msg);
    anchorEl.insertAdjacentElement('afterend', toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 2500);
  }

  async function shareGame(g, rival, btn) {
    const text = buildShareText(g, rival);
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (_) {
        // User cancelled or share failed — fall through to clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      showShareToast(btn, 'Copied — paste anywhere');
    } catch (_) {
      showShareToast(btn, 'Copy failed');
    }
  }

  function shareCell(g, rival) {
    return el('td', { class: 'row-action-cell' }, [
      el('button', {
        type: 'button',
        class: 'icon-btn icon-btn-share',
        title: 'Share result',
        'aria-label': 'Share result',
        html: ICON_SHARE,
        onclick: function () { shareGame(g, rival, this); },
      }),
    ]);
  }

  // ---------- dashboard view ----------
  function renderDashboard() {
    renderProfileCard();
    renderPasteSection();
    renderDashSummary();
    renderTodaysPredictions();
    renderRivalGrid();
    $('#dash-empty').hidden = state.rivals.length > 0;
  }

  // ---------- predictions card (rolling 7-day window) ----------
  // Anchor the window at today and keep the existing entries' selected
  // state intact across re-renders. The fetcher is idempotent — each
  // entry only flips out of 'fetching' once.
  function ensureSevenDayWindowLoaded() {
    const today = todayISO();
    if (state.predictWindowAnchorISO !== today) {
      state.predictWindowAnchorISO = today;
      state.predictWindow = Array.from({ length: PREDICT_WINDOW_DAYS }, (_, i) => ({
        iso: addDaysISO(today, i),
        cities: null,
        status: 'idle',
      }));
      // Keep the user's selection when possible; otherwise jump to today.
      if (!state.predictSelectedISO ||
          !state.predictWindow.some(w => w.iso === state.predictSelectedISO)) {
        state.predictSelectedISO = today;
      }
    }
    for (const entry of state.predictWindow) {
      if (entry.status !== 'idle') continue;
      entry.status = 'fetching';
      fetchDailyCities(entry.iso).then(cities => {
        if (state.predictWindowAnchorISO !== today) return; // stale window
        if (cities) { entry.cities = cities; entry.status = 'ok'; }
        else        { entry.status = 'error'; }
        if (state.view === 'dashboard') renderTodaysPredictions();
      }).catch(() => {
        if (state.predictWindowAnchorISO !== today) return;
        entry.status = 'error';
        if (state.view === 'dashboard') renderTodaysPredictions();
      });
    }
  }

  // Look up actuals for a given day. For "you" the source is any of that
  // day's paired games (myScores is duplicated across rivals by design,
  // so the first match is fine). For a rival it's the matching game's
  // theirScores. Returns nulls when the game wasn't logged.
  function actualScoresForDay(iso) {
    const mineGame = state.games.find(g => g.date === iso && Array.isArray(g.myScores));
    return {
      mineScores:  mineGame ? mineGame.myScores  : null,
      mineTotal:   mineGame ? getMyTotal(mineGame) : null,
    };
  }
  function actualScoresForRivalDay(rivalId, iso) {
    const g = state.games.find(x => x.rivalId === rivalId && x.date === iso);
    if (!g) return { scores: null, total: null };
    return {
      scores: Array.isArray(g.theirScores) ? g.theirScores : null,
      total:  Array.isArray(g.theirScores) ? getTheirTotal(g) : null,
    };
  }

  // SVG icon helpers — tiny stroke glyphs used as score-cell adornments
  // and as the prediction → actual chevron. Each returns a fresh node so
  // they're safe to call once per row/chip.
  function svgIcon(pathD, opts) {
    const o = opts || {};
    const wrap = el('span', { class: 'pred-ic' + (o.cls ? ' ' + o.cls : ''), 'aria-hidden': 'true' });
    wrap.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="' + (o.sw || 1.6) + '" stroke-linecap="round" stroke-linejoin="round">' +
      pathD + '</svg>';
    return wrap;
  }
  const ICON_TARGET = '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="0.6" fill="currentColor"/>';
  const ICON_CHECK  = '<path d="M3.5 8.5l3 3 6-6"/>';
  const ICON_UP     = '<path d="M8 13V4"/><path d="M4 8l4-4 4 4"/>';
  const ICON_DOWN   = '<path d="M8 3v9"/><path d="M4 8l4 4 4-4"/>';
  const ICON_DASH   = '<path d="M4 8h8"/>';
  const ICON_CHEV   = '<path d="M4 4l4 4-4 4"/>';

  function makeDeltaBadge(delta) {
    if (delta == null) {
      return el('span', { class: 'pred-delta-badge is-na' }, '—');
    }
    const sign = delta > 0 ? 'is-pos' : delta < 0 ? 'is-neg' : 'is-zero';
    const ic = delta > 0 ? ICON_UP : delta < 0 ? ICON_DOWN : ICON_DASH;
    return el('span', { class: 'pred-delta-badge ' + sign }, [
      svgIcon(ic, { sw: 2 }),
      el('span', { class: 'pred-delta-num' }, (delta > 0 ? '+' : '') + delta),
    ]);
  }

  // One round chip: shows weighted slot, predicted (and actual when known),
  // and a top accent line keyed to Δ. Predicted is never null when we
  // render — caller skips the strip entirely if the predictor failed.
  function makeRoundChip(slot, predicted, actual) {
    const predRound = Math.round(predicted);
    const hasActual = actual != null && Number.isFinite(actual);
    const delta = hasActual ? Math.round(actual) - predRound : null;
    const cls = ['prc'];
    if (delta != null) cls.push(delta > 0 ? 'prc-pos' : delta < 0 ? 'prc-neg' : 'prc-zero');
    const w = WEIGHTS[slot];
    return el('div', { class: cls.join(' '), title:
        hasActual
          ? `Round ${slot + 1} (×${w}): predicted ${predRound}, actual ${Math.round(actual)}`
          : `Round ${slot + 1} (×${w}): predicted ${predRound}` }, [
      el('div', { class: 'prc-head' }, [
        el('span', { class: 'prc-slot' }, `R${slot + 1}`),
      ]),
      w > 1 ? el('span', { class: 'prc-weight' }, `×${w}`) : null,
      el('div', { class: 'prc-nums' }, [
        el('span', { class: 'prc-pred' }, String(predRound)),
        hasActual ? svgIcon(ICON_CHEV, { cls: 'prc-arrow', sw: 1.8 }) : null,
        hasActual ? el('span', { class: 'prc-actual' }, String(Math.round(actual))) : null,
      ]),
      delta != null
        ? el('div', { class: 'prc-delta' }, [
            svgIcon(delta > 0 ? ICON_UP : delta < 0 ? ICON_DOWN : ICON_DASH,
                    { cls: 'prc-delta-ic', sw: 2 }),
            el('span', {}, (delta > 0 ? '+' : '') + delta),
          ])
        : null,
    ]);
  }

  function makePredictionRow({ label, predictedScores, actualScores, predictedTotal, actualTotal, isYou, accentColor }) {
    const cls = ['pred-row'];
    if (isYou) cls.push('pred-row-you');
    const cells = [el('div', { class: 'pred-label' }, label)];
    cells.push(el('div', { class: 'pred-cell pred-predicted' },
      predictedTotal != null ? String(predictedTotal) : '—'));
    cells.push(el('div', { class: 'pred-cell pred-actual' },
      actualTotal != null ? String(actualTotal) : '—'));
    let delta = null;
    if (predictedTotal != null && actualTotal != null) delta = actualTotal - predictedTotal;
    cells.push(el('div', { class: 'pred-cell pred-delta-cell' }, [makeDeltaBadge(delta)]));
    const head = el('div', { class: cls.join(' ') }, cells);
    const accentStyle = accentColor ? `--row-accent:${accentColor};` : '';
    if (!Array.isArray(predictedScores)) {
      if (accentStyle) head.setAttribute('style', accentStyle);
      return head;
    }
    const strip = el('div', { class: 'pred-round-strip' },
      predictedScores.map((p, i) => makeRoundChip(i, p, actualScores ? actualScores[i] : null)));
    return el('div', {
      class: 'pred-row-wrap' + (isYou ? ' pred-row-wrap-you' : ''),
      style: accentStyle || null,
    }, [head, strip]);
  }

  // Day-tab pill. Shows weekday + day-of-month. Today is labelled "Today";
  // tomorrow gets a thinner accent so the upcoming run reads at a glance.
  function makeDayTab(entry, todayIso) {
    const dt = new Date(entry.iso + 'T00:00:00');
    const isToday = entry.iso === todayIso;
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const cls = ['pred-day-tab'];
    if (entry.iso === state.predictSelectedISO) cls.push('is-active');
    if (isToday) cls.push('is-today');
    if (entry.status === 'fetching') cls.push('is-loading');
    if (entry.status === 'error')    cls.push('is-error');
    return el('button', {
      type: 'button',
      class: cls.join(' '),
      'aria-pressed': entry.iso === state.predictSelectedISO ? 'true' : 'false',
      onclick: () => {
        if (state.predictSelectedISO === entry.iso) return;
        state.predictSelectedISO = entry.iso;
        renderTodaysPredictions();
      },
    }, [
      el('span', { class: 'pred-day-tab-name' }, isToday ? 'Today' : dayNames[dt.getDay()]),
      el('span', { class: 'pred-day-tab-num' }, String(dt.getDate())),
    ]);
  }

  function renderTodaysPredictions() {
    ensureSevenDayWindowLoaded();
    const card = $('#todays-card');
    if (!card) return;
    const body = $('#todays-card-body');
    const sub = $('#todays-card-sub');
    const status = $('#todays-card-status');
    body.innerHTML = '';

    if (!state.rivals.length) { card.hidden = true; return; }
    card.hidden = false;

    const today = todayISO();
    const selectedISO = state.predictSelectedISO || today;
    const selected = state.predictWindow.find(w => w.iso === selectedISO) ||
                     state.predictWindow[0];

    sub.textContent = fmtDateLong(selectedISO);

    // Day-tab strip (always visible — the headline UI for the 7-day view).
    const tabs = el('div', { class: 'pred-day-tabs', role: 'tablist',
                             'aria-label': 'Next 7 days' },
      state.predictWindow.map(entry => makeDayTab(entry, today)));
    body.appendChild(tabs);

    // Selected-day state branches
    if (!selected || selected.status === 'fetching') {
      status.textContent = 'Loading…';
      status.className = 'todays-card-status is-loading';
      body.appendChild(el('p', { class: 'pred-empty' },
        'Fetching this day’s puzzle from maptap.gg…'));
      return;
    }
    if (selected.status === 'error' || !selected.cities) {
      status.textContent = 'Puzzle unavailable';
      status.className = 'todays-card-status is-warn';
      body.appendChild(el('p', { class: 'pred-empty' },
        'Couldn’t load this day’s puzzle from maptap.gg. Predictions will appear once it’s available.'));
      return;
    }

    // Per-player rows. Column headers carry tiny status glyphs so the
    // PREDICTED / ACTUAL split is scannable even from the chart strip
    // below it.
    const header = el('div', { class: 'pred-row pred-row-head' }, [
      el('div', { class: 'pred-label' }, 'Player'),
      el('div', { class: 'pred-cell' }, [
        svgIcon(ICON_TARGET, { cls: 'pred-col-ic' }),
        el('span', {}, 'Predicted'),
      ]),
      el('div', { class: 'pred-cell' }, [
        svgIcon(ICON_CHECK, { cls: 'pred-col-ic' }),
        el('span', {}, 'Actual'),
      ]),
      el('div', { class: 'pred-cell' }, 'Δ'),
    ]);
    body.appendChild(header);

    const isPastOrToday = selectedISO <= today;
    const myRounds = myProfileRounds();
    const myPred = predictRoundsForPlayer(myRounds, selected.cities, selectedISO);
    const myActuals = isPastOrToday ? actualScoresForDay(selectedISO) : { mineScores: null, mineTotal: null };
    body.appendChild(makePredictionRow({
      label: `${state.myIcon || '🧍'} ${state.me || 'You'}`,
      predictedScores: myPred ? myPred.scores : null,
      actualScores:    myActuals.mineScores,
      predictedTotal:  myPred ? predTotalFromScores(myPred.scores) : null,
      actualTotal:     myActuals.mineTotal,
      isYou: true,
      accentColor: 'var(--accent-2)',
    }));

    let predictedCount = myPred ? 1 : 0;
    state.rivals
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(r => {
        const rounds = rivalRounds(r.id);
        const pred = predictRoundsForPlayer(rounds, selected.cities, selectedISO);
        if (pred) predictedCount++;
        const act = isPastOrToday ? actualScoresForRivalDay(r.id, selectedISO) : { scores: null, total: null };
        body.appendChild(makePredictionRow({
          label: `${r.icon || '🎯'} ${r.name}`,
          predictedScores: pred ? pred.scores : null,
          actualScores:    act.scores,
          predictedTotal:  pred ? predTotalFromScores(pred.scores) : null,
          actualTotal:     act.total,
          isYou: false,
          accentColor: r.color,
        }));
      });

    if (predictedCount === 0) {
      status.textContent = 'Need more games';
      status.className = 'todays-card-status is-muted';
    } else if (selectedISO > today) {
      status.textContent = 'Upcoming';
      status.className = 'todays-card-status is-accent';
    } else if (myActuals.mineTotal != null) {
      status.textContent = 'Game played ✓';
      status.className = 'todays-card-status is-good';
    } else {
      status.textContent = selectedISO === today ? 'Pre-game' : 'Not logged';
      status.className = 'todays-card-status is-accent';
    }
  }

  // Sum a round score array using the standard WEIGHTS.
  function predTotalFromScores(scores) {
    if (!Array.isArray(scores) || scores.length !== N_LOCS) return null;
    let t = 0;
    for (let i = 0; i < N_LOCS; i++) t += scores[i] * WEIGHTS[i];
    return Math.round(Math.max(0, Math.min(1000, t)));
  }

  // ---------- paste-mode entry on dashboard ----------
  // State holding raw text + parsed result for me and per rival. Survives
  // dashboard re-renders so an in-progress paste isn't lost when, e.g., a
  // game gets saved.
  const pasteState = {
    meText: '',
    me: null,                       // ParseResult | null
    byRivalIdText: new Map(),       // rivalId -> raw text
    byRivalId: new Map(),           // rivalId -> ParseResult | null
  };

  function renderPasteSection() {
    const wrap = $('#paste-rivals');
    wrap.innerHTML = '';
    $('#paste-empty').hidden = state.rivals.length > 0;

    // Drop entries for rivals that no longer exist (after a delete)
    const liveIds = new Set(state.rivals.map(r => r.id));
    for (const id of Array.from(pasteState.byRivalId.keys())) {
      if (!liveIds.has(id)) {
        pasteState.byRivalId.delete(id);
        pasteState.byRivalIdText.delete(id);
      }
    }

    if (!state.rivals.length) return;

    state.rivals
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(r => wrap.appendChild(makePasteRivalRow(r)));

    // Restore "mine" textarea from preserved state
    const mineInput = $('#paste-mine-input');
    if (mineInput && pasteState.meText && mineInput.value !== pasteState.meText) {
      mineInput.value = pasteState.meText;
    }
    refreshPasteMineUI();
    refreshAllPasteResults();
  }

  function makePasteRivalRow(rival) {
    const row = el('article', {
      class: 'paste-rival-row',
      style: `--rival-color:${rival.color}`,
      'data-rival-id': rival.id,
    });

    const info = el('div', { class: 'paste-rival-info' }, [
      el('span', { class: 'pri-icon tinted' }, rival.icon),
      el('div', {}, [
        el('div', { class: 'pri-name' }, rival.name),
        el('div', { class: 'pri-meta', 'data-pri-meta': '' }, ''),
      ]),
    ]);
    row.appendChild(info);

    const textarea = el('textarea', {
      class: 'paste-rival-textarea',
      rows: '2',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: `Paste ${rival.name}'s MapTap result…`,
      'aria-label': `Paste ${rival.name}'s score`,
    });
    // Restore preserved text after a re-render
    const preservedText = pasteState.byRivalIdText.get(rival.id);
    if (preservedText) textarea.value = preservedText;
    textarea.addEventListener('input', () => {
      pasteState.byRivalIdText.set(rival.id, textarea.value);
      pasteState.byRivalId.set(rival.id, parseMapTapScore(textarea.value));
      refreshPasteRivalRow(rival.id);
    });
    row.appendChild(textarea);

    const side = el('div', { class: 'paste-rival-side' });
    const result = el('div', { class: 'paste-rival-result', 'data-result': '' }, '—');
    side.appendChild(result);
    row.appendChild(side);

    // Round-by-round chips appear when both sides parse
    row.appendChild(el('div', { class: 'paste-rival-rounds', 'data-rounds-strip': '', hidden: 'hidden' }));

    return row;
  }

  function refreshAllPasteResults() {
    state.rivals.forEach(r => refreshPasteRivalRow(r.id));
    refreshPasteSaveBar();
  }

  // Update the single bottom Save-day button + summary line based on what's
  // currently parsed. Disabled if my score is missing or no rival is parsed.
  function refreshPasteSaveBar() {
    const bar = $('#paste-actions');
    const summary = $('#paste-summary');
    const btn = $('#paste-save-all');
    if (!bar || !summary || !btn) return;

    bar.hidden = state.rivals.length === 0;
    summary.classList.remove('is-ready', 'is-success', 'is-error');

    const mine = pasteState.me;
    const parsedRivals = state.rivals.filter(r => pasteState.byRivalId.get(r.id));
    const typedNotParsed = state.rivals.filter(r => {
      const text = pasteState.byRivalIdText.get(r.id);
      return text && text.trim() && !pasteState.byRivalId.get(r.id);
    });

    if (!mine) {
      btn.disabled = true;
      btn.innerHTML = "Save day's games";
      summary.textContent = parsedRivals.length
        ? `Paste your score above to log ${parsedRivals.length} game${parsedRivals.length === 1 ? '' : 's'}.`
        : "Paste your daily score, then your rivals'.";
      return;
    }

    if (!parsedRivals.length) {
      btn.disabled = true;
      btn.innerHTML = "Save day's games";
      summary.textContent = typedNotParsed.length
        ? `Couldn't parse ${typedNotParsed.length} rival paste${typedNotParsed.length === 1 ? '' : 's'}.`
        : 'Paste at least one rival’s score to save.';
      return;
    }

    btn.disabled = false;
    btn.innerHTML = `Save day's games <span class="pill-count">${parsedRivals.length}</span>`;
    summary.classList.add('is-ready');

    let w = 0, l = 0, t = 0;
    for (const r of parsedRivals) {
      const theirs = pasteState.byRivalId.get(r.id);
      const diff = mine.computedTotal - theirs.computedTotal;
      if (diff > 0) w++; else if (diff < 0) l++; else t++;
    }
    const parts = [];
    parts.push(`Will save ${parsedRivals.length} game${parsedRivals.length === 1 ? '' : 's'}`);
    const wlt = [];
    if (w) wlt.push(`${w}W`);
    if (l) wlt.push(`${l}L`);
    if (t) wlt.push(`${t}T`);
    if (wlt.length) parts.push(wlt.join(' · '));
    if (typedNotParsed.length) parts.push(`(${typedNotParsed.length} skipped — can't parse)`);
    summary.textContent = parts.join(' · ');
  }

  function refreshPasteRivalRow(rivalId) {
    const row = document.querySelector(`.paste-rival-row[data-rival-id="${rivalId}"]`);
    if (!row) return;
    const result = row.querySelector('.paste-rival-result');
    const meta = row.querySelector('[data-pri-meta]');
    const textarea = row.querySelector('.paste-rival-textarea');
    const roundsStrip = row.querySelector('[data-rounds-strip]');

    const theirs = pasteState.byRivalId.get(rivalId) || null;
    const mine = pasteState.me;

    // Style the textarea border
    textarea.classList.remove('is-parsed', 'is-error');
    if (textarea.value.trim() && !theirs) textarea.classList.add('is-error');
    else if (theirs) textarea.classList.add('is-parsed');

    // Meta line: their parsed total
    if (theirs) {
      const noteParts = [`R1 ${theirs.rounds[0]} · R2 ${theirs.rounds[1]} · R3 ${theirs.rounds[2]} · R4 ${theirs.rounds[3]} · R5 ${theirs.rounds[4]}`];
      noteParts.push(`= ${theirs.computedTotal}`);
      if (theirs.totalMismatch) noteParts.push(`(shared total ${theirs.finalScore})`);
      meta.textContent = noteParts.join(' ');
    } else if (textarea.value.trim()) {
      meta.textContent = "Couldn't find 5 round scores in that paste.";
    } else {
      meta.textContent = '';
    }

    // Result chip
    result.classList.remove('W', 'L', 'T', 'error');
    if (mine && theirs) {
      const diff = mine.computedTotal - theirs.computedTotal;
      const r = diff > 0 ? 'W' : diff < 0 ? 'L' : 'T';
      result.classList.add(r);
      const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
      result.textContent = `${r} ${sign}${Math.abs(diff)}`;
    } else if (mine && textarea.value.trim() && !theirs) {
      result.classList.add('error');
      result.textContent = "can't parse";
    } else if (!mine && theirs) {
      result.textContent = 'paste yours ↑';
    } else {
      result.textContent = '—';
    }

    // Per-round W/L chips when both sides are parsed
    if (mine && theirs) {
      roundsStrip.innerHTML = '';
      for (let i = 0; i < N_LOCS; i++) {
        const m = mine.rounds[i], t = theirs.rounds[i];
        const r = resultLoc(m, t);
        roundsStrip.appendChild(el('span', {
          class: 'prr-chip ' + r,
          title: `${LOC_LABELS[i]} (×${WEIGHTS[i]}): ${m} vs ${t}`,
        }, `${LOC_LABELS[i]} ${m}–${t}`));
      }
      roundsStrip.hidden = false;
    } else {
      roundsStrip.hidden = true;
      roundsStrip.innerHTML = '';
    }
  }

  function refreshPasteMineUI() {
    const textarea = $('#paste-mine-input');
    if (!textarea) return;
    const status = $('#paste-mine-status');
    const roundsBox = $('#paste-mine-rounds');
    const text = textarea.value;
    const parsed = parseMapTapScore(text);
    pasteState.meText = text;
    pasteState.me = parsed;

    textarea.classList.remove('is-parsed', 'is-error');
    if (text.trim() && !parsed) textarea.classList.add('is-error');
    else if (parsed) textarea.classList.add('is-parsed');

    // Status line
    status.classList.remove('is-success', 'is-error', 'is-warn');
    if (!text.trim()) {
      status.textContent = 'Paste your MapTap result anywhere on the page';
      roundsBox.hidden = true;
      roundsBox.innerHTML = '';
    } else if (!parsed) {
      status.classList.add('is-error');
      status.textContent = "Couldn't find 5 round scores in that paste.";
      roundsBox.hidden = true;
      roundsBox.innerHTML = '';
    } else {
      const parts = [`Parsed total ${parsed.computedTotal}`];
      if (parsed.totalMismatch) parts.push(`shared said ${parsed.finalScore}`);
      status.classList.add(parsed.totalMismatch ? 'is-warn' : 'is-success');
      status.textContent = parts.join(' · ');

      // Round chip preview
      roundsBox.innerHTML = '';
      for (let i = 0; i < N_LOCS; i++) {
        const v = parsed.rounds[i];
        const cls = ['paste-round-chip'];
        if (v === MAX_RAW) cls.push('is-perfect');
        if (v === 0) cls.push('is-zero');
        roundsBox.appendChild(el('div', { class: cls.join(' '), title: `${LOC_NAMES[i]} (×${WEIGHTS[i]})` }, [
          el('span', { class: 'pc-label' }, `${LOC_LABELS[i]}·×${WEIGHTS[i]}`),
          el('span', { class: 'pc-val' }, String(v)),
        ]));
      }
      roundsBox.appendChild(el('div', { class: 'paste-total-chip' }, [
        el('span', { class: 'pc-label' }, 'Total'),
        el('span', { class: 'pc-val' }, String(parsed.computedTotal)),
      ]));
      roundsBox.hidden = false;

      // Auto-fill date if the paste contained one
      if (parsed.date) $('#paste-date').value = parsed.date;
    }

    refreshAllPasteResults();
  }

  function saveDay() {
    const mine = pasteState.me;
    if (!mine) return;
    const date = $('#paste-date').value || todayISO();

    const targets = state.rivals
      .map(r => ({ rival: r, theirs: pasteState.byRivalId.get(r.id) }))
      .filter(x => x.theirs);
    if (!targets.length) return;

    let w = 0, l = 0, t = 0;
    const now = Date.now();
    const savedGames = [];
    for (const { rival, theirs } of targets) {
      const myT = mine.computedTotal;
      const theirT = theirs.computedTotal;
      const diff = myT - theirT;
      if (diff > 0) w++; else if (diff < 0) l++; else t++;

      const newGame = {
        id: uid(),
        rivalId: rival.id,
        date,
        myScores: mine.rounds.slice(),
        theirScores: theirs.rounds.slice(),
        myScore: myT,
        theirScore: theirT,
        note: '',
        createdAt: now,
      };
      state.games.push(newGame);
      savedGames.push({ game: newGame, rival });
    }
    persistGames();

    // Briefly highlight the rows that just saved before we clear them.
    const savedIds = new Set(targets.map(x => x.rival.id));
    document.querySelectorAll('.paste-rival-row').forEach(row => {
      if (savedIds.has(row.dataset.rivalId)) {
        row.classList.add('is-saved-flash');
        setTimeout(() => row.classList.remove('is-saved-flash'), 600);
      }
    });

    // Clear all paste state — fresh slate for tomorrow.
    pasteState.me = null;
    pasteState.meText = '';
    pasteState.byRivalId.clear();
    pasteState.byRivalIdText.clear();
    const mineInput = $('#paste-mine-input');
    if (mineInput) mineInput.value = '';
    document.querySelectorAll('.paste-rival-textarea').forEach(ta => {
      ta.value = '';
      ta.classList.remove('is-parsed', 'is-error');
    });
    refreshPasteMineUI();
    refreshAllPasteResults();

    // Confirmation summary on the bottom bar + share buttons (one per rival).
    const summary = $('#paste-summary');
    const pasteActions = $('#paste-actions');
    if (summary) {
      summary.classList.remove('is-ready', 'is-error');
      summary.classList.add('is-success');
      const wlt = [];
      if (w) wlt.push(`${w}W`);
      if (l) wlt.push(`${l}L`);
      if (t) wlt.push(`${t}T`);
      summary.textContent = `Saved ${targets.length} game${targets.length === 1 ? '' : 's'} · ${wlt.join(' · ') || 'no result'}`;
    }
    if (pasteActions) {
      pasteActions.querySelectorAll('.paste-share-btn').forEach(b => b.remove());
      savedGames.forEach(({ game, rival }) => {
        const shareBtn = el('button', {
          type: 'button',
          class: 'btn btn-ghost paste-share-btn',
          title: `Share result vs ${rival.name}`,
        }, [
          el('span', { html: ICON_SHARE, class: 'paste-share-icon' }),
          `Share vs ${rival.name}`,
        ]);
        shareBtn.addEventListener('click', function () { shareGame(game, rival, this); });
        pasteActions.appendChild(shareBtn);
      });
    }

    // Refresh the dashboard tiles + summary so saved games land immediately.
    renderDashSummary();
    renderRivalGrid();
  }

  function renderDashSummary() {
    const wrap = $('#dash-summary');
    if (!state.rivals.length) {
      wrap.innerHTML = '';
      return;
    }

    const totalGames = state.games.length;
    let wins = 0, losses = 0, ties = 0;
    state.games.forEach(g => {
      const r = resultOf(g);
      if (r === 'W') wins++;
      else if (r === 'L') losses++;
      else ties++;
    });
    const winPct = totalGames ? (wins / totalGames * 100) : 0;
    const myAvg = average(state.games.map(getMyTotal));

    // best rival = highest win % with at least 1 game
    let bestRival = null, worstRival = null;
    state.rivals.forEach(r => {
      const s = rivalSummary(r);
      if (!s.total) return;
      if (!bestRival || s.winPct > bestRival.winPct) bestRival = s;
      if (!worstRival || s.winPct < worstRival.winPct) worstRival = s;
    });

    const todayGames = state.games.filter(g => g.date === todayISO()).length;

    wrap.innerHTML = '';
    wrap.appendChild(makeSummaryCard('Total games', totalGames, `${wins}W · ${losses}L · ${ties}T`));
    wrap.appendChild(makeSummaryCard('Overall win %', `${winPct.toFixed(0)}%`, totalGames ? `over ${totalGames} games` : '—'));
    wrap.appendChild(makeSummaryCard('Avg score', myAvg ? myAvg.toFixed(0) : '—', 'all-time'));
    wrap.appendChild(makeSummaryCard('Today', todayGames, todayGames === 1 ? 'game logged' : 'games logged'));
    if (bestRival) wrap.appendChild(makeSummaryCard('Best matchup', bestRival.rival.name, `${(bestRival.winPct * 100).toFixed(0)}% win rate`));
    if (worstRival && worstRival !== bestRival) wrap.appendChild(makeSummaryCard('Toughest rival', worstRival.rival.name, `${(worstRival.winPct * 100).toFixed(0)}% win rate`));
  }

  function makeSummaryCard(label, value, sub) {
    return el('div', { class: 'dash-summary-card' }, [
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, String(value)),
      sub ? el('div', { class: 'sub' }, sub) : null,
    ]);
  }

  function renderRivalGrid() {
    const grid = $('#rival-grid');
    grid.innerHTML = '';
    const sorted = state.rivals.slice().sort((a, b) => {
      // Most-played rivalries first; ties broken alphabetically.
      const sa = rivalSummary(a);
      const sb = rivalSummary(b);
      if (sb.total !== sa.total) return sb.total - sa.total;
      return a.name.localeCompare(b.name);
    });

    sorted.forEach(r => grid.appendChild(makeRivalCard(rivalSummary(r))));

    // Re-apply any in-flight sync/spinner state after the grid is rebuilt
    sorted.forEach(r => refreshRivalCardSyncUI(r.id));
  }

  function makeRivalCard(s) {
    const r = s.rival;
    const card = el('article', {
      class: 'rival-card',
      style: `--rival-color:${r.color}`,
      'data-rival-id': r.id,
      onclick: (e) => {
        if (e.target.closest('.rival-card-edit')) return;
        if (e.target.closest('.rival-card-sync')) return;
        state.selectedRivalId = r.id;
        persistSelected();
        setView('rival');
      },
    });

    const actions = el('div', { class: 'rival-card-actions' }, [
      el('button', {
        type: 'button',
        class: 'rival-card-sync',
        title: r.maptapUsername
          ? `Sync games from maptap.gg/u/${r.maptapUsername}`
          : 'Add a MapTap username for this rival to sync',
        'aria-label': `Sync ${r.name} from MapTap`,
        html: ICON_SYNC,
        onclick: (e) => { e.stopPropagation(); syncMapTapForRival(r.id); },
      }),
      el('button', {
        type: 'button',
        class: 'rival-card-edit',
        title: 'Edit rival',
        'aria-label': `Edit ${r.name}`,
        html: ICON_EDIT,
        onclick: (e) => { e.stopPropagation(); openRivalModal(r.id); },
      }),
    ]);

    const head = el('div', { class: 'rival-card-head' }, [
      el('div', { class: 'rival-icon', style: `background:${r.color}33` }, r.icon),
      el('div', {}, [
        el('div', { class: 'rival-card-name' }, r.name),
        el('div', { class: 'rival-card-meta' },
          s.total ? `${s.total} game${s.total === 1 ? '' : 's'} played` : 'No games yet'
        ),
      ]),
      actions,
    ]);
    card.appendChild(head);

    if (s.total === 0) {
      card.appendChild(el('p', { class: 'rival-card-meta', style: 'margin-top:.4rem' },
        'Log your first game to see stats.'));
      return card;
    }

    card.appendChild(el('div', { class: 'rival-card-stats' }, [
      el('div', { class: 'rival-stat win' }, [
        el('div', { class: 'v' }, String(s.wins)),
        el('div', { class: 'k' }, 'Wins'),
      ]),
      el('div', { class: 'rival-stat loss' }, [
        el('div', { class: 'v' }, String(s.losses)),
        el('div', { class: 'k' }, 'Losses'),
      ]),
      el('div', { class: 'rival-stat tie' }, [
        el('div', { class: 'v' }, String(s.ties)),
        el('div', { class: 'k' }, 'Ties'),
      ]),
    ]));

    const pctBar = el('div', { class: 'win-pct-bar' }, [
      el('span', { style: `width:${(s.winPct * 100).toFixed(1)}%` }),
    ]);
    card.appendChild(pctBar);

    const foot = el('div', { class: 'rival-card-foot' });
    const formPills = el('div', { class: 'form-pills', title: 'Last 5 games (oldest → newest)' });
    s.recentForm.forEach(r => {
      formPills.appendChild(el('span', { class: 'form-pill ' + r }, r));
    });
    foot.appendChild(formPills);

    if (s.hot) {
      foot.appendChild(el('span', { class: 'streak-tag hot', title: 'Hot streak: 3+ wins in a row' },
        `🔥 ${s.streak.curMine} W streak`));
    } else if (s.streak.curMine > 0) {
      foot.appendChild(el('span', { class: 'streak-tag win' }, `+${s.streak.curMine} W`));
    } else if (s.streak.curTheirs >= 2) {
      foot.appendChild(el('span', { class: 'streak-tag loss' }, `${s.streak.curTheirs} L streak`));
    } else {
      foot.appendChild(el('span', { class: 'streak-tag', style: 'color:var(--muted)' },
        `${(s.winPct * 100).toFixed(0)}% win`));
    }
    card.appendChild(foot);

    return card;
  }

  // ---------- rival detail view ----------
  function renderRival() {
    const headerHost = $('#rival-header');
    const cardsHost = $('#rival-stat-cards');
    const calloutsHost = $('#rival-callouts');
    const tableBody = $('#rival-games-table tbody');

    let rival = state.rivals.find(r => r.id === state.selectedRivalId);
    if (!rival && state.rivals.length) {
      rival = state.rivals[0];
      state.selectedRivalId = rival.id;
      persistSelected();
    }
    if (!rival) {
      headerHost.innerHTML = '<p class="empty-state" style="margin:0">Add a rival to see detailed stats.</p>';
      cardsHost.innerHTML = '';
      calloutsHost.innerHTML = '';
      tableBody.innerHTML = '';
      $('#loc-section').hidden = true;
      $('#continent-section').hidden = true;
      destroyAllCharts();
      return;
    }

    // Switching rivals should rewind the games table to page 1 — otherwise
    // a rival with fewer games leaves you on an empty out-of-range page.
    if (state.lastRenderedRivalId !== rival.id) {
      state.rivalGamesPage = 1;
      state.lastRenderedRivalId = rival.id;
    }

    const s = rivalSummary(rival);

    // header
    headerHost.innerHTML = '';
    headerHost.style.setProperty('--rival-color', rival.color);
    headerHost.appendChild(el('div', { class: 'rival-icon', style: `background:${rival.color}33` }, rival.icon));
    headerHost.appendChild(el('div', {}, [
      el('h2', {}, rival.name),
      el('div', { class: 'meta' },
        s.total
          ? `${s.total} games · ${s.wins}W ${s.losses}L ${s.ties}T · ${(s.winPct * 100).toFixed(1)}% win rate`
          : 'No games yet — log your first one above.'
      ),
    ]));
    const actions = el('div', { class: 'rival-header-actions' });
    if (state.rivals.length > 1) {
      const switcher = el('select', {
        'aria-label': 'Switch rival',
        style: 'height:var(--ctrl-h);padding:0 .65rem;border:1px solid var(--border);border-radius:var(--ctrl-radius);background:var(--surface-2);color:var(--text);font-size:.9rem;',
        onchange: (e) => {
          state.selectedRivalId = e.target.value;
          persistSelected();
          renderRival();
        },
      });
      state.rivals.forEach(r => {
        switcher.appendChild(el('option', { value: r.id, selected: r.id === rival.id || undefined }, r.name));
      });
      actions.appendChild(switcher);
    }
    const syncBtn = el('button', {
      type: 'button',
      class: 'btn btn-ghost rival-detail-sync',
      'data-rival-id': rival.id,
      title: rival.maptapUsername
        ? `Sync games from maptap.gg/u/${rival.maptapUsername}`
        : 'Add a MapTap username for this rival to sync',
      onclick: () => syncMapTapForRival(rival.id),
    }, '🔄 Sync');
    actions.appendChild(syncBtn);
    actions.appendChild(el('button', {
      type: 'button', class: 'btn btn-ghost',
      onclick: () => openRivalModal(rival.id),
    }, '✎ Edit'));
    actions.appendChild(el('button', {
      type: 'button', class: 'btn btn-ghost',
      onclick: () => setView('dashboard'),
    }, '← Back'));
    headerHost.appendChild(actions);

    // Reflect any in-flight sync state on the freshly rendered button.
    refreshRivalCardSyncUI(rival.id);

    // stat cards
    cardsHost.innerHTML = '';
    if (!s.total) {
      destroyAllCharts();
      calloutsHost.innerHTML = '';
      tableBody.innerHTML = '';
      $('#rival-games-pagination').hidden = true;
      $('#loc-section').hidden = true;
      $('#continent-section').hidden = true;
      return;
    }

    cardsHost.appendChild(makeStatCard('Win rate', `${(s.winPct * 100).toFixed(1)}%`, `${s.wins}W · ${s.losses}L · ${s.ties}T`, s.winPct >= 0.5 ? 'is-good' : 'is-bad'));
    // Average per-game point gap rather than cumulative — comparable
    // across rivals you've played different counts of games against.
    const avgDiffAll = s.total ? (s.cumDiff / s.total) : 0;
    const avgDiffSign = avgDiffAll > 0 ? '+' : '';
    cardsHost.appendChild(makeStatCard('Avg Δ per game',
      `${avgDiffSign}${avgDiffAll.toFixed(1)}`,
      'your points − theirs',
      avgDiffAll >= 0 ? 'is-good' : 'is-bad'));
    cardsHost.appendChild(makeStatCard('Avg score (you)', s.myAvgAll.toFixed(0), `7d ${s.myAvg7 ? s.myAvg7.toFixed(0) : '—'} · 30d ${s.myAvg30 ? s.myAvg30.toFixed(0) : '—'}`));
    cardsHost.appendChild(makeStatCard(`Avg score (${rival.name})`, s.theirAvgAll.toFixed(0), `7d ${s.theirAvg7 ? s.theirAvg7.toFixed(0) : '—'} · 30d ${s.theirAvg30 ? s.theirAvg30.toFixed(0) : '—'}`));
    cardsHost.appendChild(makeStatCard('Current streak',
      s.streak.curMine > 0 ? `${s.streak.curMine} W` : s.streak.curTheirs > 0 ? `${s.streak.curTheirs} L` : '—',
      `Longest: ${s.streak.longestMine} W / ${s.streak.longestTheirs} L`,
      s.streak.curMine > 0 ? 'is-good' : s.streak.curTheirs > 0 ? 'is-bad' : ''));
    const bestMineDate  = s.bestMineGame  ? fmtDateShort(s.bestMineGame.date)  : null;
    const worstMineDate = s.worstMineGame ? fmtDateShort(s.worstMineGame.date) : null;
    const bestTheirsDate  = s.bestTheirsGame  ? fmtDateShort(s.bestTheirsGame.date)  : null;
    const worstTheirsDate = s.worstTheirsGame ? fmtDateShort(s.worstTheirsGame.date) : null;
    cardsHost.appendChild(makeStatCard('Best score (you)', s.bestMine,
      bestMineDate
        ? `${bestMineDate} · Worst ${s.worstMine}${worstMineDate ? ` (${worstMineDate})` : ''}`
        : `Worst: ${s.worstMine}`,
      'is-accent'));
    cardsHost.appendChild(makeStatCard(`Best score (${rival.name})`, s.bestTheirs,
      bestTheirsDate
        ? `${bestTheirsDate} · Worst ${s.worstTheirs}${worstTheirsDate ? ` (${worstTheirsDate})` : ''}`
        : `Worst: ${s.worstTheirs}`));
    cardsHost.appendChild(makeStatCard('Consistency (you)', s.consistencyMine.toFixed(1), 'σ — lower = steadier'));
    cardsHost.appendChild(makeStatCard('Biggest win', s.biggestWinGame ? `+${s.biggestWinMargin}` : '—',
      s.biggestWinGame ? `${s.biggestWinGame.myScore}–${s.biggestWinGame.theirScore} on ${fmtDateShort(s.biggestWinGame.date)}` : '—',
      s.biggestWinGame ? 'is-good' : ''));
    cardsHost.appendChild(makeStatCard('Biggest loss', s.biggestLossGame ? `−${s.biggestLossMargin}` : '—',
      s.biggestLossGame ? `${s.biggestLossGame.myScore}–${s.biggestLossGame.theirScore} on ${fmtDateShort(s.biggestLossGame.date)}` : '—',
      s.biggestLossGame ? 'is-bad' : ''));

    // callouts
    calloutsHost.innerHTML = '';
    const rivalNameSafe = escapeHtml(rival.name);
    if (s.hot) calloutsHost.appendChild(callout('good', '🔥', `Hot streak: <strong>${s.streak.curMine} wins in a row</strong> against ${rivalNameSafe}.`));
    if (s.onColdStreak) calloutsHost.appendChild(callout('bad', '❄️', `${rivalNameSafe} has won the last <strong>${s.streak.curTheirs} games</strong>. Time to bounce back.`));
    if (s.total >= 3) {
      const pb = s.games.find(g => getMyTotal(g) === s.bestMine);
      if (pb) calloutsHost.appendChild(callout('good', '⭐', `Personal best <strong>${s.bestMine}</strong> set vs ${rivalNameSafe} on ${fmtDateShort(pb.date)}.`));
    }
    // games table (most recent first), paginated
    tableBody.innerHTML = '';
    const allGames = s.games.slice().reverse();
    const total = allGames.length;
    const size = state.rivalGamesPageSize;
    const totalPages = size === 0 ? 1 : Math.max(1, Math.ceil(total / size));
    if (state.rivalGamesPage > totalPages) state.rivalGamesPage = totalPages;
    if (state.rivalGamesPage < 1) state.rivalGamesPage = 1;
    const startIdx = size === 0 ? 0 : (state.rivalGamesPage - 1) * size;
    const endIdx = size === 0 ? total : Math.min(total, startIdx + size);
    const pageGames = allGames.slice(startIdx, endIdx);

    renderRivalGamesPagination(total, totalPages, startIdx, endIdx);

    pageGames.forEach(g => {
      const r = resultOf(g);
      const myT = getMyTotal(g);
      const theirT = getTheirTotal(g);
      const diff = myT - theirT;
      tableBody.appendChild(el('tr', {}, [
        el('td', {}, fmtDateShort(g.date)),
        el('td', { style: 'font-weight:600', title: hasLocs(g) ? `Rounds: ${g.myScores.join(' / ')}` : '' }, String(myT)),
        el('td', { style: 'font-weight:600', title: hasLocs(g) ? `Rounds: ${g.theirScores.join(' / ')}` : '' }, String(theirT)),
        el('td', { class: diff > 0 ? 'delta-pos' : diff < 0 ? 'delta-neg' : 'delta-zero' },
          (diff > 0 ? '+' : '') + diff),
        el('td', { class: 'rounds-cell' }, [makeRoundDots(g)]),
        el('td', {}, [el('span', { class: 'result-badge ' + r }, r)]),
        noteCell(g),
        shareCell(g, rival),
        deleteCell(g),
      ]));
    });

    // charts (defer one tick to ensure canvases are visible)
    requestAnimationFrame(() => renderCharts(s));

    // Per-location section (handles its own visibility based on data presence)
    renderLocationSection(s);
    renderContinentSection(s);
  }

  function renderContinentSection(s) {
    const section = $('#continent-section');
    const grid = $('#continent-grid');
    const sub = $('#continent-section-sub');
    const { rows, totalRounds } = continentBreakdown(s.games);

    if (!rows.length) {
      section.hidden = true;
      grid.innerHTML = '';
      return;
    }
    section.hidden = false;
    const gamesWithGeo = s.games.filter(g => Array.isArray(g.cities) && g.cities.length === N_LOCS).length;
    const total = s.games.length;
    const missing = total - gamesWithGeo;
    sub.textContent =
      `${totalRounds} rounds across ${rows.length} continent${rows.length === 1 ? '' : 's'}` +
      (missing > 0 ? ` · ${missing} game${missing === 1 ? '' : 's'} have no geo data (re-sync to backfill)` : '');

    grid.innerHTML = '';
    for (const r of rows) {
      const meta = CONTINENT_META[r.continent] || CONTINENT_META['Other'];
      const winPctLabel = (r.winPct * 100).toFixed(0) + '%';
      const winPctClass = r.winPct > 0.5 ? 'good' : r.winPct < 0.5 ? 'bad' : '';
      grid.appendChild(el('article', {
        class: 'continent-card',
        style: `--cont-color:${meta.color}`,
        title: `${r.continent}: ${r.rounds} rounds`,
      }, [
        el('header', { class: 'continent-head' }, [
          el('span', { class: 'continent-icon' }, meta.icon),
          el('span', { class: 'continent-name' }, r.continent),
          el('span', { class: 'continent-rounds' }, `${r.rounds} ${r.rounds === 1 ? 'round' : 'rounds'}`),
        ]),
        el('div', { class: 'continent-scores' }, [
          el('div', { class: 'col me' }, [
            el('div', { class: 'k' }, 'You avg'),
            el('div', { class: 'v' }, r.myAvg.toFixed(1)),
          ]),
          el('div', { class: 'col them' }, [
            el('div', { class: 'k' }, `${s.rival.name} avg`),
            el('div', { class: 'v' }, r.theirAvg.toFixed(1)),
          ]),
        ]),
        el('div', { class: 'continent-record' }, [
          el('span', { class: 'gw' }, `${r.myWins}W`),
          ' · ',
          el('span', { class: 'gl' }, `${r.theirWins}L`),
          ' · ',
          el('span', { class: 'gt' }, `${r.ties}T`),
          `  ·  Δ ${r.avgDiff >= 0 ? '+' : ''}${r.avgDiff.toFixed(1)} per round  ·  best ${r.myBest}`,
        ]),
        el('div', { class: 'continent-winbar' }, [
          el('span', { style: `width:${(r.winPct * 100).toFixed(1)}%` }),
        ]),
        el('span', { class: 'continent-winpct ' + winPctClass }, `Round win rate ${winPctLabel}`),
      ]));
    }
  }

  function makeStatCard(label, value, sub, mod) {
    return el('div', { class: 'stat-card ' + (mod || '') }, [
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, String(value)),
      sub ? el('div', { class: 'sub' }, sub) : null,
    ]);
  }

  function callout(kind, icon, html) {
    return el('div', { class: 'callout ' + kind }, [
      el('span', { class: 'ic' }, icon),
      el('span', { class: 'txt', html }),
    ]);
  }

  function makeRoundDots(g) {
    const wrap = el('span', { class: 'round-dots' });
    if (!hasLocs(g)) {
      for (let i = 0; i < N_LOCS; i++) {
        wrap.appendChild(el('span', { class: 'round-dot empty', title: 'No round data' }));
      }
      return wrap;
    }
    for (let i = 0; i < N_LOCS; i++) {
      const m = g.myScores[i] || 0;
      const t = g.theirScores[i] || 0;
      const r = resultLoc(m, t);
      wrap.appendChild(el('span', {
        class: 'round-dot ' + r,
        title: `${LOC_LABELS[i]} (×${WEIGHTS[i]}) — you ${m}, them ${t}`,
      }));
    }
    return wrap;
  }

  // ---------- location breakdown ----------

  function renderLocationSection(s) {
    const section = $('#loc-section');
    if (!s.locStats || !s.gamesWithLocsCount) {
      section.hidden = true;
      destroyChart('radar');
      destroyChart('locWinrate');
      return;
    }
    section.hidden = false;
    $('#loc-section-sub').textContent =
      `${s.gamesWithLocsCount}/${s.total} games have round-by-round data` +
      (s.gamesWithLocsCount === s.total ? '' : ' (older games skipped)');

    // Callouts
    const cWrap = $('#loc-callouts');
    cWrap.innerHTML = '';
    if (s.strongest && s.weakest && s.strongest.locIdx !== s.weakest.locIdx) {
      cWrap.appendChild(callout('good', '💪',
        `Strongest at <strong>${s.strongest.label}</strong> — avg <strong>${s.strongest.myAvg.toFixed(1)}</strong> (rival: ${s.strongest.theirAvg.toFixed(1)}).`));
      cWrap.appendChild(callout('bad', '🪤',
        `Weakest at <strong>${s.weakest.label}</strong> — avg <strong>${s.weakest.myAvg.toFixed(1)}</strong> (rival: ${s.weakest.theirAvg.toFixed(1)}).`));
    }
    if (s.bestRoundWinPct && s.bestRoundWinPct.total >= 2) {
      cWrap.appendChild(callout('good', '🎯',
        `Best round win rate: <strong>${s.bestRoundWinPct.label}</strong> — won ${s.bestRoundWinPct.myWins}/${s.bestRoundWinPct.total} (${(s.bestRoundWinPct.winPct * 100).toFixed(0)}%).`));
    }
    if (s.worstRoundWinPct && s.worstRoundWinPct.total >= 2 && s.worstRoundWinPct !== s.bestRoundWinPct) {
      cWrap.appendChild(callout('bad', '⚠️',
        `Lowest round win rate: <strong>${s.worstRoundWinPct.label}</strong> — won ${s.worstRoundWinPct.myWins}/${s.worstRoundWinPct.total} (${(s.worstRoundWinPct.winPct * 100).toFixed(0)}%).`));
    }
    if (s.myTotalPerfects > 0 || s.theirTotalPerfects > 0) {
      cWrap.appendChild(callout('', '💯',
        `Perfect 100s — <strong>you ${s.myTotalPerfects}</strong>, ${escapeHtml(s.rival.name)} ${s.theirTotalPerfects}.`));
    }
    if (s.mostVolatile && s.mostVolatile.total >= 3) {
      cWrap.appendChild(callout('', '🎲',
        `Most volatile round: <strong>${s.mostVolatile.label}</strong> — σ ${s.mostVolatile.myConsistency.toFixed(1)}.`));
    }
    if (s.carryChoke) {
      const carryIdx = argmax(s.carryChoke.carryInWins);
      const chokeIdx = argmax(s.carryChoke.chokeInLosses);
      if (carryIdx >= 0 && s.carryChoke.carryInWins[carryIdx] >= 2) {
        cWrap.appendChild(callout('good', '🛡️',
          `Carry round: <strong>${LOC_LABELS[carryIdx]}</strong> bailed you out in ${s.carryChoke.carryInWins[carryIdx]} wins.`));
      }
      if (chokeIdx >= 0 && s.carryChoke.chokeInLosses[chokeIdx] >= 2) {
        cWrap.appendChild(callout('bad', '😬',
          `Choke round: <strong>${LOC_LABELS[chokeIdx]}</strong> sank you in ${s.carryChoke.chokeInLosses[chokeIdx]} losses.`));
      }
    }

    renderLocationCards(s);
    renderHeatmap(s);
    requestAnimationFrame(() => renderLocationCharts(s));
  }

  function argmax(arr) {
    let best = -Infinity, idx = -1;
    for (let i = 0; i < arr.length; i++) if (arr[i] > best) { best = arr[i]; idx = i; }
    return idx;
  }

  // Soft accent palette per round (visual anchor across radar / cards / dots)
  const LOC_COLORS = ['#60a5fa', '#22d3ee', '#a855f7', '#f97316', '#f43f5e'];

  function renderLocationCards(s) {
    const grid = $('#loc-card-grid');
    grid.innerHTML = '';
    s.locStats.forEach(loc => {
      const card = el('div', {
        class: 'loc-card',
        style: `--loc-color:${LOC_COLORS[loc.locIdx]}`,
        title: `${loc.name} · ×${loc.weight} weight`,
      }, [
        el('div', { class: 'lc-label' }, `${loc.label} · ×${loc.weight}`),
        el('div', { class: 'lc-avg', title: 'Your average raw score' }, loc.myAvg.toFixed(1)),
        el('div', { class: 'lc-avg-them', title: `${s.rival.name}'s average raw score` },
          `vs ${loc.theirAvg.toFixed(1)}`),
        el('div', { class: 'lc-rate' }, [
          'Win rate',
          el('strong', {}, `${(loc.winPct * 100).toFixed(0)}%`),
          el('div', { class: 'lc-pct-bar' }, [el('span', { style: `width:${(loc.winPct * 100).toFixed(1)}%` })]),
        ]),
        el('div', { class: 'lc-record' },
          `Best ${loc.myBest} · σ ${loc.myConsistency.toFixed(1)}`),
        el('div', { class: 'lc-record' },
          `${loc.myWins}W · ${loc.theirWins}L · ${loc.ties}T`),
      ]);
      grid.appendChild(card);
    });
  }

  function renderHeatmap(s) {
    const wrap = $('#loc-heatmap');
    wrap.innerHTML = '';
    const recent = s.games.slice(-10).filter(hasLocs);
    if (!recent.length) {
      wrap.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:.6rem 0;">No round-by-round games yet.</p>';
      return;
    }

    // header row
    const header = el('div', { class: 'heatmap-row is-header' }, [
      el('span', { class: 'heatmap-rowlabel' }, 'Game'),
      ...LOC_LABELS.map(l => el('span', {}, l)),
      el('span', { class: 'heatmap-totalcol', style: 'background:transparent;padding:0' }, 'Total'),
    ]);
    wrap.appendChild(header);

    // newest at top
    recent.slice().reverse().forEach(g => {
      const row = el('div', { class: 'heatmap-row' });
      row.appendChild(el('span', { class: 'heatmap-rowlabel' }, fmtDateShort(g.date)));
      for (let i = 0; i < N_LOCS; i++) {
        const m = g.myScores[i] || 0;
        const t = g.theirScores[i] || 0;
        const r = resultLoc(m, t);
        const cell = el('span', {
          class: 'heatmap-cell ' + (r === 'L' ? 'lost' : r === 'T' ? 'tied' : ''),
          style: `background:${heatColor(m)}`,
          title: `${LOC_LABELS[i]} — you ${m}, ${s.rival.name} ${t} (${r})`,
        }, String(m));
        row.appendChild(cell);
      }
      const tr = resultOf(g);
      const total = getMyTotal(g);
      row.appendChild(el('span', {
        class: 'heatmap-totalcol ' + (tr === 'W' ? 'win' : tr === 'L' ? 'loss' : 'tie'),
      }, String(total)));
      wrap.appendChild(row);
    });
  }

  function heatColor(v) {
    // 0 → red, 50 → yellow, 100 → green
    const t = Math.max(0, Math.min(100, v)) / 100;
    let r, g, b;
    if (t < 0.5) {
      const k = t / 0.5;
      r = Math.round(248 + (250 - 248) * k);
      g = Math.round(113 + (204 - 113) * k);
      b = Math.round(113 + (21 - 113) * k);
    } else {
      const k = (t - 0.5) / 0.5;
      r = Math.round(250 + (74 - 250) * k);
      g = Math.round(204 + (222 - 204) * k);
      b = Math.round(21 + (128 - 21) * k);
    }
    return `rgb(${r},${g},${b})`;
  }

  function renderLocationCharts(s) {
    if (!window.Chart || !s.locStats) return;
    const labels = s.locStats.map((l, i) => `${l.label} (×${WEIGHTS[i]})`);

    destroyChart('radar');
    state.charts.radar = new Chart($('#chart-radar'), {
      type: 'radar',
      data: {
        labels,
        datasets: [
          {
            label: 'You',
            data: s.locStats.map(l => l.myAvg),
            borderColor: '#4ade80',
            backgroundColor: 'rgba(74,222,128,0.18)',
            pointBackgroundColor: '#4ade80',
            pointRadius: 3,
          },
          (() => {
            const rc = chartRivalColor(s.rival.color);
            return {
              label: s.rival.name,
              data: s.locStats.map(l => l.theirAvg),
              borderColor: rc,
              backgroundColor: hexToRgba(rc, 0.18),
              pointBackgroundColor: rc,
              pointRadius: 3,
            };
          })(),
        ],
      },
      options: chartCommon({
        scales: {
          r: {
            beginAtZero: true,
            min: 0,
            max: 100,
            ticks: { color: '#9aa3b2', backdropColor: 'transparent', stepSize: 25 },
            grid: { color: '#252938' },
            angleLines: { color: '#252938' },
            pointLabels: { color: '#e7e9ee', font: { size: 11 } },
          },
        },
      }),
    });

    destroyChart('locWinrate');
    const winrates = s.locStats.map(l => +(l.winPct * 100).toFixed(1));
    state.charts.locWinrate = new Chart($('#chart-loc-winrate'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Win rate %',
          data: winrates,
          backgroundColor: winrates.map(w => w >= 50 ? 'rgba(74,222,128,0.7)' : 'rgba(248,113,113,0.7)'),
          borderColor: winrates.map(w => w >= 50 ? '#4ade80' : '#f87171'),
          borderWidth: 1,
        }],
      },
      options: chartCommon({
        indexAxis: 'y',
        scales: {
          x: { min: 0, max: 100, ticks: { color: '#9aa3b2', callback: v => v + '%' }, grid: { color: '#252938' } },
          y: { ticks: { color: '#9aa3b2' }, grid: { color: '#1f232f' } },
        },
        plugins: { legend: { display: false } },
      }),
    });
  }

  // ---------- charts ----------
  // The "You" series is pinned to a fixed green across charts. If the
  // rival's chosen color sits too close to that green in RGB space the
  // two lines become indistinguishable, so swap to a contrasting orange.
  const USER_CHART_COLOR = '#4ade80';
  const RIVAL_FALLBACK_COLOR = '#f97316';
  function chartRivalColor(rivalColor) {
    if (!rivalColor || typeof rivalColor !== 'string' || rivalColor[0] !== '#' || rivalColor.length !== 7) {
      return RIVAL_FALLBACK_COLOR;
    }
    const u = parseInt(USER_CHART_COLOR.slice(1), 16);
    const r = parseInt(rivalColor.slice(1), 16);
    const dr = ((u >> 16) & 0xff) - ((r >> 16) & 0xff);
    const dg = ((u >> 8)  & 0xff) - ((r >> 8)  & 0xff);
    const db =  (u        & 0xff) -  (r        & 0xff);
    return (dr * dr + dg * dg + db * db) < 6400 ? RIVAL_FALLBACK_COLOR : rivalColor;
  }

  function destroyChart(name) {
    if (state.charts[name]) {
      state.charts[name].destroy();
      state.charts[name] = null;
    }
  }
  function destroyAllCharts() {
    destroyChart('trend');
    destroyChart('wins');
    destroyChart('diff');
    destroyChart('radar');
    destroyChart('locWinrate');
  }

  function renderCharts(s) {
    if (!window.Chart) return;
    const last30 = s.games.slice(-30);

    // Trend line: my score vs theirs
    destroyChart('trend');
    state.charts.trend = new Chart($('#chart-trend'), {
      type: 'line',
      data: {
        labels: last30.map(g => fmtDateShort(g.date)),
        datasets: [
          {
            label: 'You',
            data: last30.map(getMyTotal),
            borderColor: '#4ade80',
            backgroundColor: 'rgba(74,222,128,0.12)',
            tension: 0.3,
            fill: true,
            pointRadius: 3,
          },
          (() => {
            const rc = chartRivalColor(s.rival.color);
            return {
              label: s.rival.name,
              data: last30.map(getTheirTotal),
              borderColor: rc,
              backgroundColor: hexToRgba(rc, 0.12),
              tension: 0.3,
              fill: true,
              pointRadius: 3,
            };
          })(),
        ],
      },
      options: chartCommon({
        scales: {
          y: { beginAtZero: false, suggestedMin: 0, suggestedMax: 1000, ticks: { color: '#9aa3b2' }, grid: { color: '#252938' } },
          x: { ticks: { color: '#9aa3b2', maxRotation: 0, autoSkip: true }, grid: { color: '#1f232f' } },
        },
      }),
    });

    // Win pie
    destroyChart('wins');
    state.charts.wins = new Chart($('#chart-wins'), {
      type: 'doughnut',
      data: {
        labels: ['Wins', 'Losses', 'Ties'],
        datasets: [{
          data: [s.wins, s.losses, s.ties],
          backgroundColor: ['#4ade80', '#f87171', '#9aa3b2'],
          borderColor: '#161922',
          borderWidth: 2,
        }],
      },
      options: chartCommon({ cutout: '60%' }),
    });

    // Differential bars
    destroyChart('diff');
    const diffs = last30.map(g => getMyTotal(g) - getTheirTotal(g));
    state.charts.diff = new Chart($('#chart-diff'), {
      type: 'bar',
      data: {
        labels: last30.map(g => fmtDateShort(g.date)),
        datasets: [{
          label: 'Score Δ',
          data: diffs,
          backgroundColor: diffs.map(d => d > 0 ? 'rgba(74,222,128,0.7)' : d < 0 ? 'rgba(248,113,113,0.7)' : 'rgba(154,163,178,0.7)'),
          borderColor: diffs.map(d => d > 0 ? '#4ade80' : d < 0 ? '#f87171' : '#9aa3b2'),
          borderWidth: 1,
        }],
      },
      options: chartCommon({
        scales: {
          y: { ticks: { color: '#9aa3b2' }, grid: { color: '#252938' } },
          x: { ticks: { color: '#9aa3b2', maxRotation: 0, autoSkip: true }, grid: { color: '#1f232f' } },
        },
        plugins: { legend: { display: false } },
      }),
    });
  }

  function chartCommon(extra) {
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#e7e9ee', font: { size: 11 } } },
        tooltip: { backgroundColor: '#1f232f', borderColor: '#353a4b', borderWidth: 1, titleColor: '#e7e9ee', bodyColor: '#e7e9ee' },
      },
    };
    return Object.assign(base, extra || {});
  }

  function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r},${g},${b},${a})`;
  }

  // ---------- leaderboard ----------
  function renderLeaderboard() {
    const tbody = $('#leaderboard-table tbody');
    tbody.innerHTML = '';
    const summaries = state.rivals.map(rivalSummary).filter(s => s.total > 0);
    if (!summaries.length) {
      $('#leaderboard-empty').hidden = false;
      return;
    }
    $('#leaderboard-empty').hidden = true;
    summaries.sort((a, b) => b.winPct - a.winPct || b.total - a.total);

    summaries.forEach((s, i) => {
      const avgDiff = s.total ? (s.cumDiff / s.total) : 0;
      const streakHtml =
        s.streak.curMine > 0 ? `<span class="streak-tag ${s.hot ? 'hot' : 'win'}">${s.hot ? '🔥 ' : '+'}${s.streak.curMine} W</span>`
        : s.streak.curTheirs > 0 ? `<span class="streak-tag loss">${s.streak.curTheirs} L</span>`
        : '<span style="color:var(--muted)">—</span>';

      const tr = el('tr', {
        style: 'cursor:pointer',
        onclick: () => {
          state.selectedRivalId = s.rival.id;
          persistSelected();
          setView('rival');
        },
      });
      tr.appendChild(el('td', { style: 'font-weight:700;color:var(--muted)' }, '#' + (i + 1)));
      tr.appendChild(el('td', {}, [
        el('span', { style: `display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:${s.rival.color};margin-right:.45rem;vertical-align:middle` }),
        s.rival.icon + ' ' + s.rival.name,
      ]));
      tr.appendChild(el('td', {}, String(s.total)));
      tr.appendChild(el('td', { style: 'color:var(--good);font-weight:600' }, String(s.wins)));
      tr.appendChild(el('td', { style: 'color:var(--bad);font-weight:600' }, String(s.losses)));
      tr.appendChild(el('td', { style: 'color:var(--tie)' }, String(s.ties)));
      tr.appendChild(el('td', { style: 'font-weight:600' }, `${(s.winPct * 100).toFixed(1)}%`));
      tr.appendChild(el('td', { class: avgDiff > 0 ? 'delta-pos' : avgDiff < 0 ? 'delta-neg' : 'delta-zero' },
        (avgDiff > 0 ? '+' : '') + avgDiff.toFixed(1)));
      const streakCell = el('td', {});
      streakCell.innerHTML = streakHtml;
      tr.appendChild(streakCell);
      tbody.appendChild(tr);
    });
  }

  // ---------- matrix view ----------
  // Confusion-style H2H grid for you + any selected rivals. The user always
  // anchors the matrix. Rival ↔ rival cells are *derived* from days where
  // both rivals appear in state.games: on each such day, the user has one
  // daily MapTap score, so the two rivals' scores can be compared head to
  // head against each other. We pick the latest game per rival per date in
  // case duplicates exist.
  const MATRIX_TABS = [
    { id: 'record', label: 'Record',    icon: '🏆' },
    { id: 'margin', label: 'Margin',    icon: '📐' },
    { id: 'score',  label: 'Avg score', icon: '📊' },
    { id: 'form',   label: 'Last 5',    icon: '⚡' },
  ];
  function isValidMatrixTab(id) { return MATRIX_TABS.some(t => t.id === id); }

  function selectedMatrixRivals() {
    // null selection = include all rivals; otherwise filter to remembered ids
    // (dropping any that no longer exist).
    if (!Array.isArray(state.matrixSelection)) return state.rivals.slice();
    const wanted = new Set(state.matrixSelection);
    return state.rivals.filter(r => wanted.has(r.id));
  }

  function isMatrixRivalSelected(rivalId) {
    if (!Array.isArray(state.matrixSelection)) return true;
    return state.matrixSelection.includes(rivalId);
  }

  function toggleMatrixRival(rivalId) {
    const current = Array.isArray(state.matrixSelection)
      ? state.matrixSelection.slice()
      : state.rivals.map(r => r.id);
    const i = current.indexOf(rivalId);
    if (i >= 0) current.splice(i, 1);
    else current.push(rivalId);
    state.matrixSelection = current;
    persistMatrixSelection();
    renderMatrix();
  }

  // Build a map: rivalId -> Map<date, { mine, theirs }> using the latest
  // game on each date (in createdAt order) so duplicate logs collapse.
  function buildRivalDateIndex(rivalIds) {
    const want = new Set(rivalIds);
    const byRival = new Map();
    rivalIds.forEach(id => byRival.set(id, new Map()));
    state.games.forEach(g => {
      if (!want.has(g.rivalId)) return;
      const mine = getMyTotal(g);
      const theirs = getTheirTotal(g);
      const slot = byRival.get(g.rivalId);
      const prev = slot.get(g.date);
      if (!prev || (g.createdAt || 0) >= (prev.createdAt || 0)) {
        slot.set(g.date, { mine, theirs, createdAt: g.createdAt || 0 });
      }
    });
    return byRival;
  }

  // H2H from the row's perspective vs the column. Returns aggregate counts
  // plus a chronological list of meetings, so the per-tab renderers can
  // pull margins, recency, and form without re-querying state.games.
  function computeMatrixCell(rowKind, colKind, byRival) {
    // rowKind/colKind: { type: 'you' } | { type: 'rival', id }
    if (rowKind.type === 'you' && colKind.type === 'you') return null;

    const meetings = []; // { date, rowScore, colScore }
    if (rowKind.type === 'you' || colKind.type === 'you') {
      const rivalId = rowKind.type === 'rival' ? rowKind.id : colKind.id;
      const youIsRow = rowKind.type === 'you';
      const dateMap = byRival.get(rivalId);
      if (dateMap) {
        dateMap.forEach(({ mine, theirs }, date) => {
          meetings.push({
            date,
            rowScore: youIsRow ? mine : theirs,
            colScore: youIsRow ? theirs : mine,
          });
        });
      }
    } else {
      const rowMap = byRival.get(rowKind.id);
      const colMap = byRival.get(colKind.id);
      if (rowMap && colMap) {
        rowMap.forEach(({ theirs: rowScore }, date) => {
          const colEntry = colMap.get(date);
          if (!colEntry) return;
          meetings.push({ date, rowScore, colScore: colEntry.theirs });
        });
      }
    }
    meetings.sort((a, b) => a.date.localeCompare(b.date));

    let wins = 0, losses = 0, ties = 0, rowTotal = 0, colTotal = 0;
    let bestMargin = null, worstMargin = null;
    meetings.forEach(({ rowScore, colScore }) => {
      rowTotal += rowScore;
      colTotal += colScore;
      const m = rowScore - colScore;
      if (bestMargin === null || m > bestMargin) bestMargin = m;
      if (worstMargin === null || m < worstMargin) worstMargin = m;
      if (rowScore > colScore) wins++;
      else if (rowScore < colScore) losses++;
      else ties++;
    });
    return {
      games: meetings.length,
      wins, losses, ties,
      rowTotal, colTotal,
      bestMargin, worstMargin,
      meetings,
    };
  }

  // Build the visible content for one matrix cell based on the active sub-tab.
  // Returns { tone, title, content } where tone drives the W/L/T tint and
  // content is the array of child nodes for the <td>.
  function matrixCellViewModel(cell, subtab, row, col) {
    const gamesLabel = `${cell.games} game${cell.games === 1 ? '' : 's'}`;
    const fmtSigned = m => (m > 0 ? '+' : '') + Math.round(m);

    if (subtab === 'margin') {
      const avg = (cell.rowTotal - cell.colTotal) / cell.games;
      const tone = avg > 5 ? 'win' : avg < -5 ? 'loss' : 'tie';
      const best = cell.bestMargin;
      return {
        tone,
        title: `${row.label} vs ${col.label} — avg ${fmtSigned(avg)} per game, best ${fmtSigned(best)}, worst ${fmtSigned(cell.worstMargin)}`,
        content: [
          el('div', { class: 'matrix-record' }, fmtSigned(avg)),
          el('div', { class: 'matrix-margin' }, `best ${fmtSigned(best)}`),
          el('div', { class: 'matrix-meta' }, gamesLabel),
        ],
      };
    }

    if (subtab === 'score') {
      const rowAvg = cell.rowTotal / cell.games;
      const colAvg = cell.colTotal / cell.games;
      const tone = rowAvg > colAvg + 3 ? 'win' : rowAvg < colAvg - 3 ? 'loss' : 'tie';
      return {
        tone,
        title: `${row.label} averages ${rowAvg.toFixed(0)} vs ${col.label}'s ${colAvg.toFixed(0)} across ${gamesLabel}`,
        content: [
          el('div', { class: 'matrix-record' }, String(Math.round(rowAvg))),
          el('div', { class: 'matrix-margin' }, `vs ${Math.round(colAvg)}`),
          el('div', { class: 'matrix-meta' }, gamesLabel),
        ],
      };
    }

    if (subtab === 'form') {
      const last5 = cell.meetings.slice(-5);
      const dots = el('div', { class: 'matrix-form-dots' });
      last5.forEach(m => {
        const cls = m.rowScore > m.colScore ? 'win'
          : m.rowScore < m.colScore ? 'loss'
          : 'tie';
        dots.appendChild(el('span', {
          class: `matrix-form-dot is-${cls}`,
          title: `${fmtDateShort(m.date)} · ${m.rowScore} vs ${m.colScore}`,
        }));
      });
      // Current streak: walk backward from the latest meeting.
      let streakKind = null, streakLen = 0;
      for (let i = cell.meetings.length - 1; i >= 0; i--) {
        const m = cell.meetings[i];
        const kind = m.rowScore > m.colScore ? 'W'
          : m.rowScore < m.colScore ? 'L'
          : 'T';
        if (streakKind === null) { streakKind = kind; streakLen = 1; }
        else if (kind === streakKind) streakLen++;
        else break;
      }
      const streakLabel = streakLen > 0 ? `${streakKind}${streakLen}` : '—';
      const tone = streakKind === 'W' ? 'win' : streakKind === 'L' ? 'loss' : 'tie';
      return {
        tone,
        title: `Last ${last5.length} (oldest → newest), current streak ${streakLabel}`,
        content: [
          dots,
          el('div', { class: 'matrix-margin' }, streakLabel),
          el('div', { class: 'matrix-meta' }, gamesLabel),
        ],
      };
    }

    // 'record' (default)
    const winPct = (cell.wins + 0.5 * cell.ties) / cell.games;
    const winPctStr = (winPct * 100).toFixed(1) + '%';
    const tone = winPct > 0.55 ? 'win' : winPct < 0.45 ? 'loss' : 'tie';
    return {
      tone,
      title: `${row.label} vs ${col.label} — ${gamesLabel}, ${winPctStr} win rate`,
      content: [
        el('div', { class: 'matrix-record' },
          `${cell.wins}-${cell.losses}` + (cell.ties ? `-${cell.ties}` : '')),
        el('div', { class: 'matrix-margin' }, winPctStr),
        el('div', { class: 'matrix-meta' }, gamesLabel),
      ],
    };
  }

  function renderMatrixSubtabs() {
    const wrap = $('#matrix-subtabs');
    wrap.innerHTML = '';
    MATRIX_TABS.forEach(t => {
      const active = state.matrixTab === t.id;
      const btn = el('button', {
        type: 'button',
        class: 'matrix-subtab' + (active ? ' is-active' : ''),
        role: 'tab',
        'aria-selected': active ? 'true' : 'false',
        onclick: () => {
          if (state.matrixTab === t.id) return;
          state.matrixTab = t.id;
          renderMatrix();
          syncUrlHash();
        },
      }, [
        el('span', { 'aria-hidden': 'true' }, t.icon),
        ' ',
        t.label,
      ]);
      wrap.appendChild(btn);
    });
  }

  function renderMatrixChips() {
    const wrap = $('#matrix-chip-row');
    wrap.innerHTML = '';
    if (!state.rivals.length) return;
    state.rivals
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(r => {
        const selected = isMatrixRivalSelected(r.id);
        const chip = el('button', {
          type: 'button',
          class: 'matrix-chip' + (selected ? ' is-on' : ''),
          style: selected
            ? `border-color:${r.color};background:${r.color}22`
            : '',
          'aria-pressed': selected ? 'true' : 'false',
          onclick: () => toggleMatrixRival(r.id),
        }, r.icon + ' ' + r.name);
        wrap.appendChild(chip);
      });
  }

  function matrixLegendText(subtab) {
    if (subtab === 'margin') return 'Avg point margin per game from the row\'s perspective; the small line shows the row\'s best single result vs that column.';
    if (subtab === 'score')  return 'Row participant\'s average score in head-to-head meetings (small line: column\'s average in those same games).';
    if (subtab === 'form')   return 'Dots = last 5 meetings (oldest left → newest right) from the row\'s perspective. Big label = current streak.';
    return 'Wins-losses(-ties) and the row\'s win % — ties count as half a win.';
  }

  function renderMatrix() {
    if (!isValidMatrixTab(state.matrixTab)) state.matrixTab = 'record';
    renderMatrixChips();
    renderMatrixSubtabs();

    const wrap = $('#matrix-wrap');
    wrap.innerHTML = '';
    const emptyMsg = $('#matrix-empty');

    if (!state.rivals.length || !state.games.length) {
      emptyMsg.hidden = false;
      return;
    }
    emptyMsg.hidden = true;

    const rivals = selectedMatrixRivals();
    if (!rivals.length) {
      wrap.appendChild(el('p', { class: 'matrix-hint' },
        'Pick at least one rival above to build the matrix.'));
      return;
    }

    // Participants in display order: You first, then rivals alphabetically.
    const sortedRivals = rivals.slice().sort((a, b) => a.name.localeCompare(b.name));
    const participants = [
      { type: 'you', label: state.me || 'You', icon: state.myIcon || '🧍', color: 'var(--accent-2)' },
      ...sortedRivals.map(r => ({ type: 'rival', id: r.id, label: r.name, icon: r.icon, color: r.color })),
    ];

    const byRival = buildRivalDateIndex(sortedRivals.map(r => r.id));

    const table = el('table', { class: 'matrix-table' });
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', { class: 'matrix-corner', scope: 'col' }, ''));
    participants.forEach(p => {
      const th = el('th', { class: 'matrix-col-head', scope: 'col' }, [
        el('span', { class: 'matrix-head-chip', style: `--p-color:${p.color}` }, [
          el('span', { class: 'matrix-head-icon' }, p.icon),
          el('span', { class: 'matrix-head-name' }, p.label),
        ]),
      ]);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    participants.forEach(row => {
      const tr = el('tr');
      tr.appendChild(el('th', { class: 'matrix-row-head', scope: 'row' }, [
        el('span', { class: 'matrix-head-chip', style: `--p-color:${row.color}` }, [
          el('span', { class: 'matrix-head-icon' }, row.icon),
          el('span', { class: 'matrix-head-name' }, row.label),
        ]),
      ]));
      participants.forEach(col => {
        if (row === col) {
          tr.appendChild(el('td', { class: 'matrix-cell matrix-diag', 'aria-label': 'self' }, '—'));
          return;
        }
        const cell = computeMatrixCell(row, col, byRival);
        if (!cell || cell.games === 0) {
          tr.appendChild(el('td', { class: 'matrix-cell matrix-empty' }, [
            el('span', { class: 'matrix-record' }, 'no games'),
          ]));
          return;
        }
        const vm = matrixCellViewModel(cell, state.matrixTab, row, col);
        tr.appendChild(el('td', {
          class: `matrix-cell matrix-${vm.tone}`,
          title: vm.title,
        }, vm.content));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    wrap.appendChild(table);

    wrap.appendChild(el('p', { class: 'matrix-legend' }, matrixLegendText(state.matrixTab)));
  }

  function renderRivalGamesPagination(total, totalPages, startIdx, endIdx) {
    const nav = $('#rival-games-pagination');
    nav.hidden = false;
    const size = state.rivalGamesPageSize;

    $('#rival-games-pagination-meta').textContent =
      size === 0
        ? `Showing all ${total} game${total === 1 ? '' : 's'}`
        : `Showing ${startIdx + 1}–${endIdx} of ${total}`;
    $('#rival-games-pagination-current').textContent =
      size === 0 ? '—' : `${state.rivalGamesPage} / ${totalPages}`;

    const prev = $('#rival-games-prev');
    const next = $('#rival-games-next');
    prev.disabled = size === 0 || state.rivalGamesPage <= 1;
    next.disabled = size === 0 || state.rivalGamesPage >= totalPages;
  }

  // ---------- history ----------
  function renderHistory() {
    const tbody = $('#history-table tbody');
    tbody.innerHTML = '';
    const rivalById = Object.fromEntries(state.rivals.map(r => [r.id, r]));

    let games = state.games.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    if (state.historyFilters.rival !== 'all') {
      games = games.filter(g => g.rivalId === state.historyFilters.rival);
    }
    if (state.historyFilters.result !== 'all') {
      const want = state.historyFilters.result === 'win' ? 'W' : state.historyFilters.result === 'loss' ? 'L' : 'T';
      games = games.filter(g => resultOf(g) === want);
    }

    if (!games.length) {
      $('#history-empty').hidden = false;
      $('#history-pagination').hidden = true;
      return;
    }
    $('#history-empty').hidden = true;

    // Pagination — pageSize 0 means "All"
    const total = games.length;
    const size = state.historyPageSize;
    const totalPages = size === 0 ? 1 : Math.max(1, Math.ceil(total / size));
    if (state.historyPage > totalPages) state.historyPage = totalPages;
    if (state.historyPage < 1) state.historyPage = 1;
    const startIdx = size === 0 ? 0 : (state.historyPage - 1) * size;
    const endIdx = size === 0 ? total : Math.min(total, startIdx + size);
    const pageGames = games.slice(startIdx, endIdx);

    renderHistoryPagination(total, totalPages, startIdx, endIdx);

    pageGames.forEach(g => {
      const rival = rivalById[g.rivalId];
      const r = resultOf(g);
      const myT = getMyTotal(g);
      const theirT = getTheirTotal(g);
      const diff = myT - theirT;
      const dayUrl = mapTapHistoryUrl(g.date);
      const dateCell = dayUrl
        ? el('td', {}, [el('a', {
            href: dayUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'maptap-day-link',
            title: 'Open this day on maptap.gg',
          }, fmtDateShort(g.date))])
        : el('td', {}, fmtDateShort(g.date));
      tbody.appendChild(el('tr', {}, [
        dateCell,
        el('td', {}, rival ? `${rival.icon} ${rival.name}` : '—'),
        el('td', { style: 'font-weight:600', title: hasLocs(g) ? `Rounds: ${g.myScores.join(' / ')}` : '' }, String(myT)),
        el('td', { style: 'font-weight:600', title: hasLocs(g) ? `Rounds: ${g.theirScores.join(' / ')}` : '' }, String(theirT)),
        el('td', { class: diff > 0 ? 'delta-pos' : diff < 0 ? 'delta-neg' : 'delta-zero' },
          (diff > 0 ? '+' : '') + diff),
        el('td', { class: 'rounds-cell' }, [makeRoundDots(g)]),
        el('td', {}, [el('span', { class: 'result-badge ' + r }, r)]),
        noteCell(g),
        shareCell(g, rival || null),
        deleteCell(g),
      ]));
    });
  }

  function renderHistoryPagination(total, totalPages, startIdx, endIdx) {
    const nav = $('#history-pagination');
    nav.hidden = false;
    const size = state.historyPageSize;

    $('#history-pagination-meta').textContent =
      size === 0
        ? `Showing all ${total} game${total === 1 ? '' : 's'}`
        : `Showing ${startIdx + 1}–${endIdx} of ${total}`;
    $('#history-pagination-current').textContent =
      size === 0 ? '—' : `${state.historyPage} / ${totalPages}`;

    const prev = $('#history-prev');
    const next = $('#history-next');
    prev.disabled = size === 0 || state.historyPage <= 1;
    next.disabled = size === 0 || state.historyPage >= totalPages;
  }

  // ---------- MapTap profile sync ----------
  // Accept the full URL ("https://maptap.gg/u/susmabit") or just the
  // username, and normalize to the username segment.
  function normalizeMapTapUsername(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    if (!s) return '';
    const m = s.match(/maptap\.gg\/u\/([^/?#\s]+)/i);
    return (m ? m[1] : s).replace(/^@/, '').trim();
  }

  async function fetchMapTapProfile(nickname) {
    const res = await fetch(MAPTAP_PROFILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { nickname } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json.result || json;
    if (!result || !result.success) {
      throw new Error((result && result.error) || 'profile not found');
    }
    return result.user;
  }

  // Summarize a fetched profile down to a small, JSON-stringifiable
  // snapshot the card displays. Keeps localStorage payload tiny vs
  // storing the whole gameHistory tree.
  //
  // Counts every entry with a finite finalScore — same view MapTap's own
  // profile page uses. (Note: the per-game sync still requires a clean
  // 5-round breakdown; those are different concerns.)
  function summarizeMapTapProfile(user) {
    const gh = user.gameHistory || {};
    const dates = Object.keys(gh);
    let total = 0, sum = 0, best = -Infinity, worst = Infinity;
    let mostRecent = null;
    for (const d of dates) {
      const entry = gh[d];
      if (!entry) continue;
      if (mostRecent === null || d > mostRecent) mostRecent = d;
      const finalScore = Number(entry.finalScore);
      if (!Number.isFinite(finalScore)) continue;
      total++;
      sum += finalScore;
      if (finalScore > best) best = finalScore;
      if (finalScore < worst) worst = finalScore;
    }
    return {
      userId: user.userId || null,
      nickname: user.nickname || null,
      joinDate: user.joinDate || null,
      totalGames: total,
      avgScore: total > 0 ? sum / total : 0,
      bestScore: total > 0 ? best : 0,
      worstScore: total > 0 ? worst : 0,
      mostRecentDate: mostRecent,
      verifiedAt: new Date().toISOString(),
    };
  }

  async function verifyMyProfile() {
    const username = normalizeMapTapUsername(state.myMapTap);
    if (!username) {
      state.profileError = 'Enter your MapTap username first.';
      renderProfileCard();
      return;
    }
    state.profileVerifying = true;
    state.profileError = null;
    renderProfileCard();
    try {
      const user = await fetchMapTapProfile(username);
      // Snap the username to whatever the server returned (case-correct)
      state.myMapTap = username;
      persistMyMapTap();
      state.myProfile = summarizeMapTapProfile(user);
      persistMyProfile();
      state.profileEditMode = false;
    } catch (err) {
      state.profileError = err.message || 'Could not verify profile';
    } finally {
      state.profileVerifying = false;
      renderProfileCard();
    }
  }

  async function syncAllRivals() {
    if (state.syncAllInFlight) return;
    const targets = state.rivals.filter(r => r.maptapUsername && r.maptapUsername.trim());
    if (!targets.length) {
      alert('No rivals have a MapTap username yet. Edit a rival to add one.');
      return;
    }
    if (!state.myMapTap) {
      alert('Set your MapTap username first.');
      return;
    }
    state.syncAllInFlight = true;
    renderProfileCard();
    try {
      // Sequential so we never see partial double-pulls of "me" data
      for (const r of targets) {
        // eslint-disable-next-line no-await-in-loop
        await syncMapTapForRival(r.id);
      }
    } finally {
      state.syncAllInFlight = false;
      renderProfileCard();
    }
  }

  function renderProfileCard() {
    const card = $('#profile-card');
    const actions = $('#profile-card-actions');
    const body = $('#profile-card-body');
    if (!card || !actions || !body) return;
    actions.innerHTML = '';
    body.innerHTML = '';

    const hasUsername = !!state.myMapTap;
    const hasProfile = !!state.myProfile;
    const editing = state.profileEditMode || !hasUsername;
    card.classList.toggle('is-unverified', !hasProfile);

    // ---- Actions area ----
    if (editing) {
      actions.appendChild(el('button', {
        type: 'button',
        class: 'btn btn-primary',
        disabled: state.profileVerifying ? 'disabled' : null,
        onclick: () => {
          // Pull the current value from the input before verifying
          const inp = $('#profile-username-input');
          if (inp) {
            state.myMapTap = normalizeMapTapUsername(inp.value);
            persistMyMapTap();
          }
          verifyMyProfile();
        },
      }, state.profileVerifying ? 'Verifying…' : 'Verify'));
      if (hasProfile) {
        actions.appendChild(el('button', {
          type: 'button', class: 'btn btn-ghost',
          onclick: () => { state.profileEditMode = false; renderProfileCard(); },
        }, 'Cancel'));
      }
    } else {
      const targets = state.rivals.filter(r => r.maptapUsername && r.maptapUsername.trim());
      const syncAllBtn = el('button', {
        type: 'button',
        class: 'btn btn-primary',
        disabled: state.syncAllInFlight || targets.length === 0 ? 'disabled' : null,
        title: targets.length === 0
          ? 'No rivals with a MapTap username yet'
          : `Sync ${targets.length} rival${targets.length === 1 ? '' : 's'}: ${targets.map(r=>r.name).join(', ')}`,
        onclick: syncAllRivals,
      }, state.syncAllInFlight
        ? 'Syncing all…'
        : `🔄 Sync all rivals${targets.length ? ` (${targets.length})` : ''}`);
      actions.appendChild(syncAllBtn);
      actions.appendChild(el('button', {
        type: 'button', class: 'btn btn-ghost',
        title: 'Re-verify or change username',
        onclick: () => { state.profileEditMode = true; renderProfileCard(); setTimeout(()=>{const i=$('#profile-username-input'); if(i)i.focus();},30); },
      }, '⋯ Change'));
    }

    // ---- Body ----
    if (editing) {
      const prompt = el('div', { class: 'profile-prompt' });
      prompt.appendChild(el('label', {
        class: 'profile-prompt-label',
        for: 'profile-username-input',
      }, 'Username or profile URL:'));
      const inp = el('input', {
        type: 'text',
        id: 'profile-username-input',
        maxlength: '128',
        placeholder: 'susmabit or https://maptap.gg/u/susmabit',
        autocomplete: 'off',
        spellcheck: 'false',
        value: state.myMapTap || '',
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          state.myMapTap = normalizeMapTapUsername(inp.value);
          persistMyMapTap();
          verifyMyProfile();
        }
      });
      prompt.appendChild(inp);
      body.appendChild(prompt);
    }

    // Status / verified info
    if (state.profileError) {
      body.appendChild(el('div', { class: 'profile-status-line' }, [
        el('span', { class: 'tag err' }, '✗ Verification failed'),
        el('span', { style: 'color:var(--muted)' }, state.profileError),
      ]));
    }
    if (state.profileVerifying) {
      body.appendChild(el('div', { class: 'profile-status-line' }, [
        el('span', { class: 'syncing-spinner' }, '⟳'),
        el('span', { style: 'color:var(--muted)' }, `Fetching profile for "${state.myMapTap}"…`),
      ]));
    }

    if (hasProfile && !editing) {
      const p = state.myProfile;
      const verifiedLine = el('div', { class: 'profile-status-line' }, [
        el('span', { class: 'tag ok' }, '✓ Verified'),
        el('span', {}, 'Profile: '),
        el('a', {
          class: 'username',
          href: `https://maptap.gg/u/${state.myMapTap}`,
          target: '_blank',
          rel: 'noopener',
        }, p.nickname || state.myMapTap),
      ]);
      body.appendChild(verifiedLine);

      const info = el('div', { class: 'profile-info' });
      info.appendChild(infoCell('Total games on MapTap', String(p.totalGames),
        p.joinDate ? `joined ${shortDate(p.joinDate)}` : ''));
      info.appendChild(infoCell('MapTap avg score', p.avgScore ? p.avgScore.toFixed(0) : '—',
        p.totalGames ? `best ${p.bestScore} · worst ${p.worstScore}` : ''));
      // App-side stats for direct comparison
      const tracked = state.games.length;
      const myAppAvg = tracked ? state.games.map(getMyTotal).reduce((a,b)=>a+b,0) / tracked : 0;
      info.appendChild(infoCell('Tracked H2H games', String(tracked),
        tracked ? 'games where both players played' : 'log a game to compare'));
      info.appendChild(infoCell('Your H2H avg', tracked ? myAppAvg.toFixed(0) : '—',
        tracked ? 'across tracked games only' : ''));
      body.appendChild(info);

      // Explain the gap up-front so it doesn't look like a bug
      const diff = Math.round(Math.abs((myAppAvg || 0) - (p.avgScore || 0)));
      if (tracked > 0 && diff >= 5) {
        body.appendChild(el('div', { class: 'profile-hint' }, [
          el('strong', {}, 'Different averages by design. '),
          `MapTap (${p.avgScore.toFixed(0)}) averages every daily game you've ever played. The app's H2H avg (${myAppAvg.toFixed(0)}) only includes the ${tracked} days a tracked rival also played — solo days aren't counted here. The gap (~${diff}) is usually because some of your best/worst days had no rival paired.`,
        ]));
      }

      // Sub-line: when last verified
      if (p.verifiedAt) {
        body.appendChild(el('div', { style: 'margin-top:.45rem;font-size:.72rem;color:var(--muted-2)' },
          `Last verified ${shortDate(p.verifiedAt)}${p.mostRecentDate ? ` · most recent MapTap game ${shortDate(p.mostRecentDate)}` : ''}`));
      }
    } else if (!editing && hasUsername) {
      body.appendChild(el('div', { class: 'profile-status-line' }, [
        el('span', { class: 'tag warn' }, '⚠ Not verified yet'),
        el('span', { style: 'color:var(--muted)' }, `Username "${state.myMapTap}" hasn't been checked against maptap.gg.`),
      ]));
    } else if (editing && !hasUsername) {
      body.appendChild(el('div', { class: 'profile-hint' }, [
        el('strong', {}, 'Why this matters: '),
        'your username is the key the app uses to pull your daily MapTap games so it can pair them against each rival. Once verified, click ',
        el('strong', {}, 'Sync all rivals'),
        ' to update every rivalry in one shot.',
      ]));
    }
  }

  function infoCell(k, v, s) {
    return el('div', { class: 'profile-info-cell' }, [
      el('div', { class: 'k' }, k),
      el('div', { class: 'v' }, v),
      s ? el('div', { class: 's' }, s) : null,
    ]);
  }
  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Convert profile.gameHistory into { "YYYY-MM-DD": { scores: number[5], cities: {lat,lng,name}[5] } }.
  // Rejects entries missing a clean 5-round breakdown so we never store
  // partial data — those days just won't pair.
  function mapTapHistoryToRounds(gameHistory) {
    const out = {};
    for (const [date, entry] of Object.entries(gameHistory || {})) {
      if (!entry || !Array.isArray(entry.roundData) || entry.roundData.length !== 5) continue;
      const scores = entry.roundData.map(r => Number(r.score));
      if (!scores.every(s => Number.isFinite(s) && s >= 0 && s <= 100)) continue;
      const cities = entry.roundData.map(r => ({
        lat: Number(r.cityLat),
        lng: Number(r.cityLng),
        name: typeof r.cityName === 'string' ? r.cityName : '',
      }));
      out[date] = { scores, cities };
    }
    return out;
  }

  // Geographic continent from (lat, lng). Order matters — overlapping
  // bounding boxes are resolved by the first matching rule (Africa
  // checked before Europe so Egypt isn't misclassified, etc.). Russia
  // splits at the Ural meridian (~60°E); Anatolia and Pacific islands
  // get explicit carve-outs. Verified against 250 real MapTap rounds.
  function classifyContinent(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'Unknown';
    if (lat < -60) return 'Antarctica';
    // Northern Pacific islands (Hawaii) — strict lng cutoff so Mexican
    // Baja (e.g. Cabo at -110) stays in North America below.
    if (lat >= 0 && lat < 30 && lng < -140) return 'Oceania';
    // Southern Pacific islands (Easter Island at -109, French Polynesia,
    // Pitcairn, Cook Islands) — no mainland this far south so safe.
    if (lat > -30 && lat < 0 && lng < -100) return 'Oceania';
    if (lat > 60 && lng > -75 && lng < -10) return 'North America'; // Greenland
    if (lat > 63 && lat < 67 && lng > -25 && lng < -13) return 'Europe'; // Iceland
    if (lat >= 7 && lat <= 84 && lng >= -170 && lng <= -52) return 'North America';
    // South America — widened west to include Galápagos (-91°)
    if (lat >= -56 && lat <= 13 && lng >= -92 && lng <= -34) return 'South America';
    if (lat >= -50 && lat <= -10 && lng >= 110 && lng <= 180) return 'Oceania';   // Aus
    if (lat >= -47 && lat <= -34 && lng >= 165 && lng <= 180) return 'Oceania';   // NZ
    if (lat >= -25 && lat <= 5 && lng >= 140 && lng <= 180) return 'Oceania';     // PNG/Fiji
    if (lat >= -35 && lat <= 38 && lng >= -20 && lng <= 52) return 'Africa';
    if (lat >= 36 && lat <= 42 && lng >= 26 && lng <= 45) return 'Asia';          // Anatolia
    // Svalbard / arctic European islands (above the 72° Europe ceiling)
    if (lat > 72 && lat <= 82 && lng >= -10 && lng <= 60) return 'Europe';
    // Europe — widened west to -32° to include the Azores at -25.2°
    if (lat >= 36 && lat <= 72 && lng >= -32 && lng <= 60) return 'Europe';
    if (lat >= -10 && lat <= 80 && lng >= 25 && lng <= 180) return 'Asia';
    return 'Other';
  }

  // Visual tokens per continent — used by the rival-detail breakdown.
  const CONTINENT_META = {
    'Africa':        { icon: '🌍', color: '#f59e0b' },
    'Europe':        { icon: '🇪🇺', color: '#3b82f6' },
    'Asia':          { icon: '🌏', color: '#ef4444' },
    'Oceania':       { icon: '🦘', color: '#10b981' },
    'North America': { icon: '🌎', color: '#8b5cf6' },
    'South America': { icon: '🏔️', color: '#06b6d4' },
    'Antarctica':    { icon: '🧊', color: '#94a3b8' },
    'Other':         { icon: '🌐', color: '#6b7280' },
    'Unknown':       { icon: '❓', color: '#6b7280' },
  };

  // Continent-level aggregates over a rival's games. Only games that have
  // a `cities` array (i.e. synced from MapTap) contribute; manually-paste
  // games are silently skipped, with the calling UI explaining the gap.
  function continentBreakdown(games) {
    const buckets = new Map();
    let totalRounds = 0;
    for (const g of games) {
      if (!Array.isArray(g.cities) || g.cities.length !== N_LOCS) continue;
      if (!Array.isArray(g.myScores) || !Array.isArray(g.theirScores)) continue;
      for (let i = 0; i < N_LOCS; i++) {
        const c = g.cities[i] || {};
        const continent = classifyContinent(Number(c.lat), Number(c.lng));
        if (!buckets.has(continent)) {
          buckets.set(continent, {
            continent, rounds: 0,
            mySum: 0, theirSum: 0,
            myWins: 0, theirWins: 0, ties: 0,
            myBest: -Infinity, myWorst: Infinity,
          });
        }
        const b = buckets.get(continent);
        const my = Number(g.myScores[i]) || 0;
        const them = Number(g.theirScores[i]) || 0;
        b.rounds++;
        totalRounds++;
        b.mySum += my;
        b.theirSum += them;
        if (my > them) b.myWins++;
        else if (my < them) b.theirWins++;
        else b.ties++;
        if (my > b.myBest) b.myBest = my;
        if (my < b.myWorst) b.myWorst = my;
      }
    }
    const out = Array.from(buckets.values()).map(b => ({
      continent: b.continent,
      rounds: b.rounds,
      myAvg: b.mySum / b.rounds,
      theirAvg: b.theirSum / b.rounds,
      avgDiff: (b.mySum - b.theirSum) / b.rounds,
      myWins: b.myWins,
      theirWins: b.theirWins,
      ties: b.ties,
      winPct: b.myWins / b.rounds,
      myBest: b.myBest,
      myWorst: b.myWorst,
    }));
    out.sort((a, b) => b.rounds - a.rounds);
    return { rows: out, totalRounds };
  }

  // ---------- prediction ----------
  // Per-round prediction blends three signals:
  //   (1) Geographic similarity (haversine distance) — closer past
  //       rounds get more weight via 1/(km + ε).
  //   (2) Recency — exponential decay with a 30-day half-life so a
  //       player's recent skill dominates over stale rounds.
  //   (3) Bayesian shrinkage toward the player's overall mean —
  //       sparse-evidence predictions get pulled back to the baseline
  //       so a single hot/cold local round can't whipsaw the estimate.
  // Continent buckets are *not* used here; classifyContinent is still
  // around for the rival detail's continent breakdown view.
  const PREDICTION_MIN_ROUNDS = 5;
  const PREDICTION_RECENCY_HALF_LIFE_DAYS = 30;
  const PREDICTION_SHRINKAGE_K = 5;       // pseudo-rounds at the player's mean
  const PREDICTION_DISTANCE_EPS_KM = 25;  // floor on inverse-distance to avoid divide-by-zero / over-weighting exact matches
  const EARTH_RADIUS_KM = 6371;

  function haversineKm(aLat, aLng, bLat, bLng) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
  }

  // Flatten `rounds` (one entry per day) into individual {lat, lng,
  // score, daysAgo} samples relative to `asOfISO`. Rounds on or after
  // asOfISO are excluded so we never "predict" using data from the
  // same day or later — back-testing stays honest, and same-day
  // actuals don't bleed into their own prediction.
  function flattenRoundsForPrediction(rounds, asOfISO) {
    const out = [];
    if (!asOfISO || !Array.isArray(rounds)) return out;
    const asOf = Date.parse(asOfISO + 'T00:00:00');
    if (!Number.isFinite(asOf)) return out;
    for (const r of rounds) {
      if (!r || !Array.isArray(r.cities) || !Array.isArray(r.scores) || !r.date) continue;
      const t = Date.parse(r.date + 'T00:00:00');
      if (!Number.isFinite(t) || t >= asOf) continue;
      const daysAgo = (asOf - t) / 86400000;
      const n = Math.min(r.cities.length, r.scores.length, N_LOCS);
      for (let i = 0; i < n; i++) {
        const c = r.cities[i] || {};
        const lat = Number(c.lat);
        const lng = Number(c.lng);
        const s = Number(r.scores[i]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(s)) continue;
        out.push({ lat, lng, score: s, daysAgo });
      }
    }
    return out;
  }

  function predictRoundScoreFromHistory(history, targetLat, targetLng, playerMean) {
    if (!history.length || !Number.isFinite(playerMean)) return playerMean;
    const recencyLambda = Math.LN2 / PREDICTION_RECENCY_HALF_LIFE_DAYS;
    let sumW = 0, sumWX = 0, sumW2 = 0;
    for (const r of history) {
      const km = haversineKm(targetLat, targetLng, r.lat, r.lng);
      const distW = 1 / (km + PREDICTION_DISTANCE_EPS_KM);
      const recW = Math.exp(-r.daysAgo * recencyLambda);
      const w = distW * recW;
      sumW += w;
      sumWX += w * r.score;
      sumW2 += w * w;
    }
    if (sumW <= 0 || sumW2 <= 0) return playerMean;
    const weightedAvg = sumWX / sumW;
    // Kish's effective sample size: (Σw)² / Σw² — counts evidence by
    // weight concentration. A handful of close-and-recent rounds give
    // nEff ≈ their count; lots of far/old rounds give nEff ≈ 1-2.
    const nEff = (sumW * sumW) / sumW2;
    // Shrinkage toward the player's long-term mean. With nEff = 0 we
    // get the prior outright; with nEff >> K we trust the local mean.
    return (nEff * weightedAvg + PREDICTION_SHRINKAGE_K * playerMean) /
           (nEff + PREDICTION_SHRINKAGE_K);
  }

  // Your own per-round history derived from `state.games`. `state.myProfile`
  // intentionally drops `gameHistory` to keep the localStorage payload
  // small (see summarizeMapTapProfile), so the paired Game records are
  // the authoritative source. The same day appears once per rival you
  // played with, so dedupe by date — your scores are identical across
  // those duplicates by construction. `date` is preserved so the
  // predictor's recency decay and same-day cutoff can use it.
  function myProfileRounds() {
    const byDate = new Map();
    for (const g of state.games) {
      if (byDate.has(g.date)) continue;
      if (!Array.isArray(g.cities) || g.cities.length !== N_LOCS) continue;
      if (!Array.isArray(g.myScores) || g.myScores.length !== N_LOCS) continue;
      const cities = g.cities.map(c => ({ lat: Number(c.lat), lng: Number(c.lng) }));
      const scores = g.myScores.map(Number);
      if (!scores.every(s => Number.isFinite(s))) continue;
      byDate.set(g.date, { date: g.date, cities, scores });
    }
    return Array.from(byDate.values());
  }

  // Per-rival rounds from `state.games`, restricted to entries that
  // carry city geometry (i.e. the user had their profile linked when the
  // game was synced). Returns rounds keyed to the rival's `theirScores`.
  function rivalRounds(rivalId) {
    return gamesFor(rivalId)
      .filter(g => Array.isArray(g.cities) && g.cities.length === N_LOCS &&
                   Array.isArray(g.theirScores))
      .map(g => ({ date: g.date, cities: g.cities, scores: g.theirScores }));
  }

  // Predict a player's weighted total + per-round breakdown for a given
  // 5-city array, computed as of `asOfISO` (excludes any rounds from
  // that day or later). Returns null when the player has too little
  // pre-cutoff history to give a meaningful number.
  // `confidence` = number of rounds informing the estimate (rough
  // sample-size cue for the UI, not a probability).
  function predictRoundsForPlayer(rounds, todaysCities, asOfISO) {
    if (!Array.isArray(todaysCities) || todaysCities.length !== N_LOCS) return null;
    const history = flattenRoundsForPrediction(rounds, asOfISO);
    if (history.length < PREDICTION_MIN_ROUNDS) return null;
    // Player's overall mean used as the shrinkage prior. Straight
    // unweighted average keeps the prior stable over time — recency
    // already lives in the per-round weights.
    let total = 0;
    for (const r of history) total += r.score;
    const playerMean = total / history.length;
    const scores = new Array(N_LOCS);
    for (let i = 0; i < N_LOCS; i++) {
      const c = todaysCities[i];
      const s = predictRoundScoreFromHistory(history, c.lat, c.lng, playerMean);
      scores[i] = Math.max(0, Math.min(100, s));
    }
    return { scores, confidence: history.length };
  }
  function predictTotalForPlayer(rounds, todaysCities, asOfISO) {
    const rp = predictRoundsForPlayer(rounds, todaysCities, asOfISO);
    if (!rp) return null;
    let weighted = 0;
    for (let i = 0; i < N_LOCS; i++) weighted += rp.scores[i] * WEIGHTS[i];
    return {
      score: Math.round(Math.max(0, Math.min(1000, weighted))),
      confidence: rp.confidence,
    };
  }

  async function syncMapTapForRival(rivalId) {
    const rival = state.rivals.find(r => r.id === rivalId);
    if (!rival) return;

    if (!state.myMapTap) {
      const me = $('#my-maptap-username');
      setRivalSyncStatus(rivalId, 'err', 'set your username in Settings');
      if (me) me.focus();
      return;
    }
    if (!rival.maptapUsername) {
      setRivalSyncStatus(rivalId, 'err', 'add their MapTap username');
      openRivalModal(rival.id);
      setTimeout(() => $('#rival-maptap-username').focus(), 60);
      return;
    }
    if (state.syncing.has(rivalId)) return;

    state.syncing.add(rivalId);
    setRivalSyncStatus(rivalId, 'loading');
    refreshRivalCardSyncUI(rivalId);

    try {
      const [mineProfile, theirsProfile] = await Promise.all([
        fetchMapTapProfile(state.myMapTap),
        fetchMapTapProfile(rival.maptapUsername),
      ]);
      // Keep the cached "Your profile" card snapshot fresh on every sync —
      // no need to wait for the user to click Verify again.
      state.myProfile = summarizeMapTapProfile(mineProfile);
      persistMyProfile();
      const mineByDate = mapTapHistoryToRounds(mineProfile.gameHistory);
      const theirsByDate = mapTapHistoryToRounds(theirsProfile.gameHistory);

      const existingGameByDate = new Map();
      for (const g of state.games) {
        if (g.rivalId === rival.id) existingGameByDate.set(g.date, g);
      }

      let added = 0;
      let backfilled = 0;
      let updated = 0;
      const now = Date.now();
      const sortedDates = Object.keys(theirsByDate).sort();
      for (const date of sortedDates) {
        const mine = mineByDate[date];
        const theirs = theirsByDate[date];
        if (!mine || !theirs) continue;
        // Cities are identical for both players each day — take ours.
        const cities = mine.cities;

        const existingGame = existingGameByDate.get(date);
        if (existingGame) {
          // Backfill: older imports (paste / WhatsApp / pre-cities sync)
          // don't have geo info. If we have it now, attach it so the
          // continent breakdown lights up retroactively.
          if (!Array.isArray(existingGame.cities) || existingGame.cities.length !== N_LOCS) {
            existingGame.cities = cities.slice();
            backfilled++;
          }
          // Refresh scores for games that originally came from MapTap sync.
          // This covers the case where the user pointed `myMapTap` at a
          // different MapTap profile — the stored rows still reflect the
          // previous user and need to be replaced. Manually entered games
          // (different `note`) are left alone so we don't clobber hand-
          // entered data.
          if (existingGame.note === 'synced from MapTap') {
            const newMy = mine.scores.slice();
            const newTheir = theirs.scores.slice();
            if (!arrEq(existingGame.myScores, newMy) || !arrEq(existingGame.theirScores, newTheir)) {
              existingGame.myScores = newMy;
              existingGame.theirScores = newTheir;
              existingGame.myScore = weightedTotal(newMy);
              existingGame.theirScore = weightedTotal(newTheir);
              updated++;
            }
          }
          continue;
        }
        state.games.push({
          id: uid(),
          rivalId: rival.id,
          date,
          myScores: mine.scores.slice(),
          theirScores: theirs.scores.slice(),
          cities: cities.slice(),
          myScore: weightedTotal(mine.scores),
          theirScore: weightedTotal(theirs.scores),
          note: 'synced from MapTap',
          createdAt: now + added,
        });
        added++;
      }
      if (added || backfilled || updated) persistGames();

      const parts = [];
      if (added)      parts.push(`${added} new`);
      if (updated)    parts.push(`${updated} updated`);
      if (backfilled) parts.push(`${backfilled} backfilled`);
      const statusMsg = parts.length ? parts.join(' · ') : 'Already up to date';
      const status = parts.length
        ? { kind: 'ok', msg: statusMsg }
        : { kind: 'flat', msg: statusMsg };
      setRivalSyncStatus(rivalId, status.kind, status.msg);

      // Refresh whichever view we're on so the new games show up
      if (state.view === 'dashboard') renderDashboard();
      else if (state.view === 'rival') renderRival();
      else if (state.view === 'leaderboard') renderLeaderboard();
      else if (state.view === 'matrix') renderMatrix();
      else if (state.view === 'history') renderHistory();
    } catch (err) {
      setRivalSyncStatus(rivalId, 'err', err.message || 'sync failed');
    } finally {
      state.syncing.delete(rivalId);
      refreshRivalCardSyncUI(rivalId);
    }
  }

  function setRivalSyncStatus(rivalId, kind, msg) {
    if (kind === 'loading') {
      state.syncStatus.set(rivalId, { kind: 'loading' });
    } else {
      state.syncStatus.set(rivalId, { kind, msg });
      // Clear non-error status after a few seconds so it doesn't linger
      if (kind !== 'err') {
        setTimeout(() => {
          const cur = state.syncStatus.get(rivalId);
          if (cur && cur.kind === kind) {
            state.syncStatus.delete(rivalId);
            refreshRivalCardSyncUI(rivalId);
          }
        }, 5000);
      }
    }
    refreshRivalCardSyncUI(rivalId);
  }

  // Targeted DOM refresh so we don't repaint the whole dashboard on every
  // sync tick. Updates the sync button + status pill on the matching card
  // (and the rival detail header button if we're on that view).
  function refreshRivalCardSyncUI(rivalId) {
    const cards = document.querySelectorAll(`.rival-card[data-rival-id="${rivalId}"]`);
    cards.forEach(card => updateSyncSpinner(card.querySelector('.rival-card-sync'), rivalId));
    cards.forEach(card => updateSyncStatusPill(card, rivalId));
    document.querySelectorAll(`.rival-detail-sync[data-rival-id="${rivalId}"]`).forEach(btn => {
      updateSyncSpinner(btn, rivalId);
    });
  }

  function updateSyncSpinner(btn, rivalId) {
    if (!btn) return;
    const loading = state.syncing.has(rivalId);
    btn.classList.toggle('is-loading', loading);
    // The .is-loading CSS class rotates the SVG via @keyframes spin, so we
    // don't swap textContent (which would clobber the inline SVG icon).
    btn.disabled = loading;
  }

  function updateSyncStatusPill(card, rivalId) {
    if (!card) return;
    const existing = card.querySelector('.rival-sync-status');
    const st = state.syncStatus.get(rivalId);
    if (!st || st.kind === 'loading') {
      if (existing) existing.remove();
      return;
    }
    const pill = existing || el('span', { class: 'rival-sync-status' });
    pill.className = 'rival-sync-status ' + st.kind;
    pill.textContent = st.msg;
    if (!existing) {
      const foot = card.querySelector('.rival-card-foot');
      if (foot) foot.appendChild(pill);
      else card.appendChild(pill);
    }
  }

  // ---------- WhatsApp chat import ----------
  // The exported chat is plain text. Each message starts with a timestamp
  // line "M/D/YY, HH:MM - Sender: body…" and may continue across lines
  // with no prefix. We pull out (date, sender, body), find ones whose body
  // looks like a MapTap share (must mention "maptap" or "final score" so
  // random 5-number messages don't false-positive), and pair shares from
  // the same body-date between mapped senders to create games.
  const WA_HEADER_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})\s+-\s+([^:]+?):\s?(.*)$/;

  function parseWhatsAppText(text) {
    const lines = text.split(/\r?\n/);
    const messages = [];
    let cur = null;
    for (const ln of lines) {
      const m = ln.match(WA_HEADER_RE);
      if (m) {
        if (cur) messages.push(cur);
        const [, mo, d, yRaw, hh, mm, sender, body] = m;
        const yy = yRaw.length === 2
          ? (Number(yRaw) >= 70 ? 1900 + Number(yRaw) : 2000 + Number(yRaw))
          : Number(yRaw);
        cur = {
          year: yy,
          monthIdx: Number(mo) - 1,
          day: Number(d),
          hour: Number(hh),
          minute: Number(mm),
          sender: sender.trim(),
          body: body,
        };
      } else if (cur) {
        cur.body += '\n' + ln;
      }
    }
    if (cur) messages.push(cur);
    return messages;
  }

  // Strict variant of parseMapTapScore that rejects bodies without a
  // MapTap-share marker. Avoids false-matching on chat messages that just
  // happen to contain five small numbers.
  function parseMapTapShareStrict(body) {
    if (!body) return null;
    if (!/maptap|final\s*score/i.test(body)) return null;
    return parseMapTapScore(body);
  }

  function dayBucketDate(msg, parsed) {
    // Prefer the date in the message body (e.g. "March 5") since that's
    // the share's actual game date, even if the user sent it at 1am the
    // next morning. Fall back to the message's own date.
    //
    // parseMapTapScore stamps `parsed.date` as a "YYYY-MM-DD" string built
    // off the *current* year. For our import we want the year that the
    // chat actually has — adjust if the body's month is far from the
    // message's month (i.e. the timezone parser fell off the end of the
    // year, or the chat is from an earlier year entirely).
    if (parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
      const bodyMonthIdx = Number(parsed.date.slice(5, 7)) - 1;
      const bodyDay = Number(parsed.date.slice(8, 10));
      let year = msg.year;
      // "December 30" delivered in early January → previous calendar year
      if (bodyMonthIdx > msg.monthIdx + 1) year = msg.year - 1;
      // "January 5" delivered in late December → next calendar year
      else if (bodyMonthIdx + 1 < msg.monthIdx - 9) year = msg.year + 1;
      return isoDateLocalFromYMD(year, bodyMonthIdx, bodyDay);
    }
    return isoDateLocalFromYMD(msg.year, msg.monthIdx, msg.day);
  }
  function isoDateLocalFromYMD(year, monthIdx, day) {
    // Build "YYYY-MM-DD" directly from numeric parts so we never go
    // through Date.toISOString — that throws if any component is NaN.
    const m = String(monthIdx + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${year}-${m}-${d}`;
  }

  // Module-level state for the open import modal session.
  const waImport = {
    messages: [],
    senders: [],            // [{ name, count, hasShares }]
    mapping: new Map(),     // sender -> 'me' | 'skip' | 'rival:<id>' | 'new:<sender>'
    fileName: '',
  };

  function openWhatsAppImport(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const messages = parseWhatsAppText(text);
        if (!messages.length) {
          alert('No WhatsApp messages found in that file. Make sure it\'s a chat export (.txt).');
          return;
        }
        // Tally senders + flag the ones with at least one MapTap-shaped body
        const counts = new Map();
        const hasShares = new Map();
        for (const m of messages) {
          counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
          if (parseMapTapShareStrict(m.body)) hasShares.set(m.sender, true);
        }
        waImport.messages = messages;
        waImport.fileName = file.name;
        waImport.senders = Array.from(counts.entries())
          .map(([name, count]) => ({ name, count, hasShares: !!hasShares.get(name) }))
          .sort((a, b) => Number(b.hasShares) - Number(a.hasShares) || b.count - a.count);
        waImport.mapping = new Map();

        // Pre-fill obvious mappings: if a sender's name matches an existing
        // rival exactly (case-insensitive), suggest that rival.
        for (const s of waImport.senders) {
          const r = state.rivals.find(r => r.name.toLowerCase() === s.name.toLowerCase());
          if (r) waImport.mapping.set(s.name, 'rival:' + r.id);
        }

        renderWhatsAppModal();
        $('#wa-modal').hidden = false;
      } catch (e) {
        alert('Could not read the file: ' + e.message);
      }
    };
    reader.readAsText(file);
  }

  function closeWhatsAppModal() {
    $('#wa-modal').hidden = true;
    waImport.messages = [];
    waImport.senders = [];
    waImport.mapping.clear();
    waImport.fileName = '';
  }

  function renderWhatsAppModal() {
    const overview = $('#wa-overview');
    const list = $('#wa-sender-list');

    let totalShares = 0;
    for (const m of waImport.messages) if (parseMapTapShareStrict(m.body)) totalShares++;

    overview.textContent = `${waImport.fileName || 'WhatsApp export'} · ${waImport.messages.length.toLocaleString()} messages · ${waImport.senders.length} senders · ${totalShares} MapTap share${totalShares === 1 ? '' : 's'} detected`;

    list.innerHTML = '';
    waImport.senders.forEach(s => {
      const row = el('div', { class: 'wa-sender-row', 'data-sender': s.name });
      const left = el('span', { class: 'wa-sender-name', title: s.name }, s.name);
      const msgs = el('span', { class: 'wa-sender-msgs' }, [
        `${s.count.toLocaleString()} msg`,
        s.hasShares ? el('span', { class: 'pill' }, 'shares') : null,
      ]);
      const sel = el('select', {
        class: 'wa-sender-map',
        'aria-label': `Map sender ${s.name}`,
        onchange: (e) => {
          if (e.target.value === 'skip') waImport.mapping.delete(s.name);
          else waImport.mapping.set(s.name, e.target.value);
          updateWASenderRowStyle(row, e.target.value);
          refreshWAPreview();
        },
      });
      sel.appendChild(el('option', { value: 'skip' }, 'Skip'));
      sel.appendChild(el('option', { value: 'me' }, 'Me'));
      // existing rivals
      state.rivals.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(r => {
        sel.appendChild(el('option', { value: 'rival:' + r.id }, `Rival: ${r.name}`));
      });
      // new rival from sender's name
      sel.appendChild(el('option', { value: 'new:' + s.name }, `+ Create new rival "${s.name}"`));

      const current = waImport.mapping.get(s.name) || 'skip';
      sel.value = current;
      updateWASenderRowStyle(row, current);

      row.appendChild(left);
      row.appendChild(msgs);
      row.appendChild(sel);
      list.appendChild(row);
    });

    refreshWAPreview();
  }

  function updateWASenderRowStyle(row, mappingValue) {
    row.classList.remove('is-me', 'is-rival');
    if (mappingValue === 'me') row.classList.add('is-me');
    else if (mappingValue && mappingValue !== 'skip') row.classList.add('is-rival');
  }

  // Resolve the current mapping into actual {meSenderSet, rivalIdBySender, newRivalNames}.
  function resolveWAMapping() {
    const meSenders = new Set();
    const senderToRivalKey = new Map(); // sender -> 'rival:id' | 'new:name'
    for (const s of waImport.senders) {
      const v = waImport.mapping.get(s.name);
      if (v === 'me') meSenders.add(s.name);
      else if (v && v !== 'skip') senderToRivalKey.set(s.name, v);
    }
    return { meSenders, senderToRivalKey };
  }

  // Compute the set of (rivalKey -> games) that would be imported with the
  // current mapping. rivalKey is either 'rival:<id>' or 'new:<name>'. Same-day
  // strict pairing only.
  function computeWAImport() {
    const { meSenders, senderToRivalKey } = resolveWAMapping();
    if (!meSenders.size || !senderToRivalKey.size) {
      return { perRival: new Map(), totalNew: 0, totalDup: 0 };
    }

    // Collect parsed shares per (rivalKey, dateISO) and per (me, dateISO)
    const myByDate = new Map();         // dateISO -> parsed
    const theirByKeyDate = new Map();   // rivalKey -> Map(dateISO -> parsed)

    for (const m of waImport.messages) {
      const parsed = parseMapTapShareStrict(m.body);
      if (!parsed) continue;
      const dateISO = dayBucketDate(m, parsed);
      if (meSenders.has(m.sender)) {
        if (!myByDate.has(dateISO)) myByDate.set(dateISO, parsed);
      } else if (senderToRivalKey.has(m.sender)) {
        const key = senderToRivalKey.get(m.sender);
        if (!theirByKeyDate.has(key)) theirByKeyDate.set(key, new Map());
        const inner = theirByKeyDate.get(key);
        if (!inner.has(dateISO)) inner.set(dateISO, parsed);
      }
    }

    // For each rival key, pair each (their, dateISO) with my same-date share.
    // Detect duplicates against existing state.games (same rival id + date).
    const existingByRivalDate = new Set();
    for (const g of state.games) existingByRivalDate.add(g.rivalId + '|' + g.date);

    const perRival = new Map(); // rivalKey -> { rivalLabel, add: [game], dup: [{date}] }
    let totalNew = 0, totalDup = 0;
    for (const [key, inner] of theirByKeyDate) {
      const label = waLabelForKey(key);
      const add = [];
      const dup = [];
      for (const [dateISO, theirParsed] of inner) {
        const mine = myByDate.get(dateISO);
        if (!mine) continue;
        // Dedupe only against EXISTING rivals; new-rival keys can't have dups yet.
        if (key.startsWith('rival:')) {
          const rivalId = key.slice('rival:'.length);
          if (existingByRivalDate.has(rivalId + '|' + dateISO)) { dup.push({ date: dateISO }); continue; }
        }
        const myT = weightedTotal(mine.rounds);
        const theirT = weightedTotal(theirParsed.rounds);
        add.push({
          date: dateISO,
          myScores: mine.rounds.slice(),
          theirScores: theirParsed.rounds.slice(),
          myScore: myT,
          theirScore: theirT,
        });
      }
      perRival.set(key, { rivalLabel: label, add, dup });
      totalNew += add.length;
      totalDup += dup.length;
    }
    return { perRival, totalNew, totalDup };
  }

  function waLabelForKey(key) {
    if (key.startsWith('rival:')) {
      const r = state.rivals.find(r => r.id === key.slice('rival:'.length));
      return r ? r.name : 'Rival';
    }
    if (key.startsWith('new:')) return key.slice('new:'.length) + ' (new rival)';
    return key;
  }

  function refreshWAPreview() {
    const wrap = $('#wa-preview');
    const btn = $('#wa-commit-btn');
    const { perRival, totalNew, totalDup } = computeWAImport();

    if (!totalNew && !totalDup) {
      wrap.innerHTML = '<p class="wa-preview-empty">Map at least one sender as <em>Me</em> and one as a rival to see games. Strict same-day pairing only.</p>';
      btn.disabled = true;
      btn.textContent = 'Import 0 games';
      return;
    }

    wrap.innerHTML = '';
    const sortedKeys = Array.from(perRival.keys()).sort((a, b) =>
      perRival.get(b).add.length - perRival.get(a).add.length
    );
    for (const key of sortedKeys) {
      const entry = perRival.get(key);
      if (!entry.add.length && !entry.dup.length) continue;
      const head = el('div', { class: 'wa-preview-rival' }, [
        entry.rivalLabel,
        entry.add.length ? el('span', { class: 'ct add' }, `+${entry.add.length} new`) : null,
        entry.dup.length ? el('span', { class: 'ct dup' }, `${entry.dup.length} skipped (already logged)`) : null,
      ]);
      wrap.appendChild(head);

      // Show up to 12 sample games per rival; collapse the rest into a "+N more"
      const addList = entry.add.slice().sort((a, b) => a.date.localeCompare(b.date));
      const samples = addList.slice(0, 12);
      const list = el('div', { class: 'wa-preview-list' });
      for (const g of samples) {
        const diff = g.myScore - g.theirScore;
        const r = diff > 0 ? 'gw' : diff < 0 ? 'gl' : 'gt';
        list.appendChild(el('div', {}, [
          `${fmtDateShort(g.date)} — `,
          el('span', { class: r }, `${g.myScore} vs ${g.theirScore}`),
          ` (Δ${diff > 0 ? '+' : ''}${diff})`,
        ]));
      }
      if (addList.length > samples.length) {
        list.appendChild(el('div', { style: 'color:var(--muted-2)' }, `…and ${addList.length - samples.length} more`));
      }
      wrap.appendChild(list);
    }

    btn.disabled = totalNew === 0;
    const label = totalNew === 1 ? '1 game' : `${totalNew} games`;
    btn.textContent = totalDup
      ? `Import ${label} (skip ${totalDup} duplicate${totalDup === 1 ? '' : 's'})`
      : `Import ${label}`;
  }

  function commitWAImport() {
    const { perRival, totalNew } = computeWAImport();
    if (!totalNew) return;

    // Materialize new rivals first (so we have IDs to reference)
    const colorPool = ['#6366f1', '#22d3ee', '#4ade80', '#f97316', '#f43f5e', '#a855f7', '#facc15', '#10b981', '#ec4899', '#0ea5e9'];
    const iconPool = ['🦊','🐺','🐻','🦁','🐯','🐲','🦅','🐙','🦈','🚀','⚡','🔥','🎯','🗺️','💀'];
    const keyToRivalId = new Map();
    for (const [key, entry] of perRival) {
      if (!entry.add.length) continue;
      if (key.startsWith('rival:')) {
        keyToRivalId.set(key, key.slice('rival:'.length));
      } else if (key.startsWith('new:')) {
        const name = key.slice('new:'.length);
        const idx = state.rivals.length;
        const newRival = {
          id: uid(),
          name,
          color: colorPool[idx % colorPool.length],
          icon: iconPool[idx % iconPool.length],
          createdAt: Date.now(),
        };
        state.rivals.push(newRival);
        keyToRivalId.set(key, newRival.id);
      }
    }

    // Then push games (merge — preserve existing).
    const now = Date.now();
    let pushed = 0;
    for (const [key, entry] of perRival) {
      const rivalId = keyToRivalId.get(key);
      if (!rivalId) continue;
      for (const g of entry.add) {
        state.games.push({
          id: uid(),
          rivalId,
          date: g.date,
          myScores: g.myScores,
          theirScores: g.theirScores,
          myScore: g.myScore,
          theirScore: g.theirScore,
          note: 'imported from WhatsApp',
          createdAt: now + pushed,
        });
        pushed++;
      }
    }

    persistRivals();
    persistGames();
    closeWhatsAppModal();

    alert(`Imported ${pushed} game${pushed === 1 ? '' : 's'}.`);

    // Refresh whichever view we're on
    refreshRivalSelects();
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'rival') renderRival();
    else if (state.view === 'leaderboard') renderLeaderboard();
    else if (state.view === 'matrix') renderMatrix();
    else if (state.view === 'history') renderHistory();
  }

  function clearAllGames() {
    const n = state.games.length;
    if (n === 0) {
      alert('No games to clear.');
      return;
    }
    const ok = confirm(
      `Delete all ${n} game${n === 1 ? '' : 's'}?\n\n` +
      `Your rivals and their MapTap usernames will be kept, so you can ` +
      `re-sync fresh. This can't be undone.`
    );
    if (!ok) return;
    state.games = [];
    persistGames();
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'rival') renderRival();
    else if (state.view === 'leaderboard') renderLeaderboard();
    else if (state.view === 'matrix') renderMatrix();
    else if (state.view === 'history') renderHistory();
  }

  // ---------- export / import ----------
  function exportData() {
    const blob = new Blob([JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      me: state.me,
      myIcon: state.myIcon,
      rivals: state.rivals,
      games: state.games,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maptap-rivals-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.rivals) || !Array.isArray(parsed.games)) {
          alert('Invalid backup file.');
          return;
        }
        if (!confirm(`Replace current data with ${parsed.rivals.length} rivals and ${parsed.games.length} games?`)) return;
        state.rivals = parsed.rivals;
        state.games = parsed.games;
        if (typeof parsed.me === 'string') state.me = parsed.me;
        if (typeof parsed.myIcon === 'string') state.myIcon = parsed.myIcon;
        persistRivals();
        persistGames();
        persistMe();
        persistMyIcon();
        $('#my-name').value = state.me;
        const cur = $('#my-icon-current'); if (cur) cur.textContent = state.myIcon || '🧍';
        refreshRivalSelects();
        if (state.view === 'dashboard') renderDashboard();
        else if (state.view === 'rival') renderRival();
        else if (state.view === 'leaderboard') renderLeaderboard();
        else if (state.view === 'matrix') renderMatrix();
        else if (state.view === 'history') renderHistory();
      } catch (e) {
        alert('Could not parse backup file.');
      }
    };
    reader.readAsText(file);
  }

  // ---------- misc ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // Refresh dashboard / current view when storage changes from sync (other device)
  function onExternalStorage(e) {
    if (!e.key) return;
    if (e.key === KEY.RIVALS) state.rivals = load(KEY.RIVALS, []);
    else if (e.key === KEY.GAMES) state.games = load(KEY.GAMES, []);
    else if (e.key === KEY.ME) {
      state.me = loadString(KEY.ME, 'Me');
      const me = $('#my-name'); if (me) me.value = state.me;
    }
    else if (e.key === KEY.MY_MAPTAP) {
      state.myMapTap = loadString(KEY.MY_MAPTAP, '');
    }
    else if (e.key === KEY.MY_ICON) {
      state.myIcon = loadString(KEY.MY_ICON, '🧍');
      const cur = $('#my-icon-current'); if (cur) cur.textContent = state.myIcon;
    }
    else if (e.key === KEY.MY_PROFILE) {
      state.myProfile = load(KEY.MY_PROFILE, null);
    }
    else if (e.key === KEY.SETTINGS) state.settings = load(KEY.SETTINGS, {});
    else return;

    refreshRivalSelects();
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'rival') renderRival();
    else if (state.view === 'leaderboard') renderLeaderboard();
    else if (state.view === 'matrix') renderMatrix();
    else if (state.view === 'history') renderHistory();
  }

  // ---------- init ----------
  function init() {
    // wire view tabs
    $$('.view-tab').forEach(tab => {
      tab.addEventListener('click', () => setView(tab.dataset.view));
    });

    refreshRivalSelects();

    // Paste-mode entry (the one entry method)
    $('#paste-date').value = todayISO();
    $('#paste-mine-input').addEventListener('input', refreshPasteMineUI);
    $('#paste-save-all').addEventListener('click', saveDay);

    // add rival
    $('#add-rival-btn').addEventListener('click', () => openRivalModal(null));

    // Rival modal close — scoped to #rival-modal so it doesn't also fire
    // for clicks on the WhatsApp import modal.
    $('#rival-modal').querySelectorAll('[data-close="modal"]').forEach(node => {
      node.addEventListener('click', closeRivalModal);
    });
    $('#rival-save-btn').addEventListener('click', saveRivalFromModal);
    $('#rival-delete-btn').addEventListener('click', deleteRivalFromModal);
    $('#rival-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveRivalFromModal(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#wa-modal').hidden) closeWhatsAppModal();
      else if (!$('#rival-modal').hidden) closeRivalModal();
    });

    // settings strip
    const meInput = $('#my-name');
    meInput.value = state.me;
    meInput.addEventListener('input', () => {
      state.me = meInput.value.trim() || 'Me';
      persistMe();
    });

    // User icon picker — flyout with the same ICONS palette as rivals,
    // plus 🧍 as a neutral "no animal" choice for users who don't want
    // an animal avatar. Closes on outside click or Escape.
    const myIconBtn     = $('#my-icon-btn');
    const myIconCurrent = $('#my-icon-current');
    const myIconFlyout  = $('#my-icon-flyout');
    const MY_ICONS = ['🧍', ...ICONS];
    function renderMyIconCurrent() {
      myIconCurrent.textContent = state.myIcon || '🧍';
    }
    function renderMyIconFlyout() {
      myIconFlyout.innerHTML = '';
      MY_ICONS.forEach(ic => {
        myIconFlyout.appendChild(el('button', {
          type: 'button',
          class: 'my-icon-swatch' + (ic === state.myIcon ? ' is-selected' : ''),
          role: 'menuitemradio',
          'aria-checked': ic === state.myIcon ? 'true' : 'false',
          'aria-label': `Choose icon ${ic}`,
          onclick: () => {
            state.myIcon = ic;
            persistMyIcon();
            renderMyIconCurrent();
            closeMyIconFlyout();
            // Refresh anywhere the icon is on screen
            if (state.view === 'dashboard') renderDashboard();
            else if (state.view === 'matrix') renderMatrix();
          },
        }, ic));
      });
    }
    function openMyIconFlyout() {
      renderMyIconFlyout();
      myIconFlyout.hidden = false;
      myIconBtn.setAttribute('aria-expanded', 'true');
    }
    function closeMyIconFlyout() {
      myIconFlyout.hidden = true;
      myIconBtn.setAttribute('aria-expanded', 'false');
    }
    renderMyIconCurrent();
    myIconBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (myIconFlyout.hidden) openMyIconFlyout();
      else closeMyIconFlyout();
    });
    document.addEventListener('click', (e) => {
      if (myIconFlyout.hidden) return;
      if (myIconFlyout.contains(e.target) || myIconBtn.contains(e.target)) return;
      closeMyIconFlyout();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !myIconFlyout.hidden) closeMyIconFlyout();
    });

    $('#clear-games-btn').addEventListener('click', clearAllGames);

    $('#export-btn').addEventListener('click', exportData);
    $('#import-btn').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });

    // WhatsApp chat import
    $('#wa-import-btn').addEventListener('click', () => $('#wa-import-file').click());
    $('#wa-import-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) openWhatsAppImport(f);
      e.target.value = '';
    });
    $('#wa-commit-btn').addEventListener('click', commitWAImport);
    $('#wa-modal').querySelectorAll('[data-close="modal"]').forEach(node => {
      node.addEventListener('click', closeWhatsAppModal);
    });

    // history filters — changing a filter rewinds to page 1 so users don't
    // land on an empty page when the result set shrinks.
    $('#history-rival-filter').addEventListener('change', (e) => {
      state.historyFilters.rival = e.target.value;
      state.historyPage = 1;
      renderHistory();
    });
    $('#history-result-filter').addEventListener('change', (e) => {
      state.historyFilters.result = e.target.value;
      state.historyPage = 1;
      renderHistory();
    });

    // history pagination
    $('#history-page-size').value = String(state.historyPageSize);
    $('#history-page-size').addEventListener('change', (e) => {
      state.historyPageSize = Number(e.target.value);
      state.historyPage = 1;
      renderHistory();
    });
    $('#history-prev').addEventListener('click', () => {
      if (state.historyPage > 1) { state.historyPage--; renderHistory(); }
    });
    $('#history-next').addEventListener('click', () => {
      state.historyPage++;
      renderHistory();
    });

    // rival-detail games pagination
    $('#rival-games-page-size').value = String(state.rivalGamesPageSize);
    $('#rival-games-page-size').addEventListener('change', (e) => {
      state.rivalGamesPageSize = Number(e.target.value);
      state.rivalGamesPage = 1;
      renderRival();
    });
    $('#rival-games-prev').addEventListener('click', () => {
      if (state.rivalGamesPage > 1) { state.rivalGamesPage--; renderRival(); }
    });
    $('#rival-games-next').addEventListener('click', () => {
      state.rivalGamesPage++;
      renderRival();
    });

    // cross-tab / sync changes
    window.addEventListener('storage', onExternalStorage);

    // Shareable-link routing — react to back/forward and pasted URLs.
    window.addEventListener('hashchange', applyUrlHash);

    // first paint — honor the hash so deep links work on cold load.
    applyUrlHash();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Live remote-update channel: bridge the storage-sync layer's
  // `localStorageSync` event into a synthetic `'storage'` event so
  // the existing `onExternalStorage` handler (wired above for the
  // cross-tab `'storage'` event) re-renders the active view when
  // another device pushes a change.
  window.addEventListener('localStorageSync', (e) => {
    const key = e.detail?.key;
    if (typeof key !== 'string' || !key.startsWith('maptapRivals')) return;
    if (e.detail?.source !== 'remote') return;
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
})();
